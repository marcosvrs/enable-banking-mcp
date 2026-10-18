import { Effect } from "effect";

import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import test from "node:test";
import { connectBank as connectBankEffect } from "../dist/guided-connection.js";

function memoryStore(value) {
  return {
    value,
    get() {
      return Effect.sync(() => this.value);
    },
    clear() {
      return Effect.sync(() => {
        this.value = undefined;
      });
    },
  };
}

function application(environment = "SANDBOX") {
  return {
    appId: "app-id",
    privateKey: "private-key",
    environment,
    redirectUrls: ["https://localhost:8765/callback"],
  };
}

async function runConnection({
  storedApplication,
  sessionId,
  capabilities = {},
  response,
  applicationInfo = { active: true, countries: ["FI"] },
  banksByCountry = { FI: [{ name: "Example Bank", country: "FI" }] },
  setupResult = { phase: "complete", pending: false },
  setupPending = false,
  setupPendingPhase = "bank_authorization",
  setupApplicationAfterWait,
  setupApplicationAfterRun,
  authorizationPending = false,
  completeAuthorizationWhenObserved = false,
  failBalancesWithoutSession = false,
  storeSessionOnAuthorization = false,
  grantTransactionsAfterAuthorization = true,
  accessProfile = "balances",
  activateApplicationOnBrowserOpen = false,
} = {}) {
  const mcpServer = new McpServer({ name: "guided-connection-test", version: "1.0.0" });
  const state = {
    applicationStore: memoryStore(storedApplication),
    sessionStore: memoryStore(sessionId),
    setupOptions: [],
    setupWaits: 0,
    authorizationCalls: [],
    balanceReads: 0,
    browserUrls: [],
    elicitationRequests: [],
    authorizationPending,
    authorizationPendingDuringBankSelection: false,
    productionActivationPending: false,
  };
  const dependencies = {
    applicationStore: state.applicationStore,
    sessionStore: state.sessionStore,
    setupFlow: {
      get status() {
        return {
          phase: setupPending ? setupPendingPhase : "idle",
          pending: setupPending,
        };
      },
      runToCompletion(options) {
        return Effect.sync(() => {
          state.setupOptions.push(options);
          if (setupApplicationAfterRun) {
            state.applicationStore.value = setupApplicationAfterRun;
          }
          return setupResult;
        });
      },
      waitForCompletion() {
        state.setupWaits += 1;
        if (setupApplicationAfterWait) {
          state.applicationStore.value = setupApplicationAfterWait;
        }
        return Effect.succeed(setupResult);
      },
    },
    authorizationFlow: {
      get status() {
        const pending = state.authorizationPending;
        if (pending && completeAuthorizationWhenObserved) {
          state.authorizationPending = false;
        }
        return { pending };
      },
      reserve() {
        if (state.authorizationPending) {
          throw new Error("Bank authorization is already in progress");
        }
        state.authorizationPending = true;
      },
      start(_client, options) {
        state.authorizationCalls.push(options);
        return Effect.sync(() => {
          state.authorizationPending = false;
          if (storeSessionOnAuthorization) {
            state.sessionStore.value = "authorized-session";
          }
          return {
            status: "awaiting_user",
            authorization_url: "https://bank.example/authorize",
          };
        });
      },
      startReserved(_client, options) {
        return this.start(_client, options);
      },
      release() {
        state.authorizationPending = false;
      },
    },
    assertNoEnvironmentCredentials() {},
    getEnvironmentSessionId() {
      return undefined;
    },
    clearEnvironmentSession() {},
    readAuthorizedBalances() {
      state.balanceReads += 1;
      if (failBalancesWithoutSession && state.sessionStore.value === undefined) {
        return Effect.fail(new Error("No Enable Banking session is stored"));
      }
      return Effect.succeed({
        aspsp: { name: "Example Bank", country: "FI" },
        accounts: [{ uid: "account-1" }],
        balances: [{ account_id: "account-1", balances: [{ amount: "42.00" }] }],
        access: {
          balances: true,
          transactions:
            grantTransactionsAfterAuthorization &&
            state.authorizationCalls.length > 0,
        },
      });
    },
    resolveCredentials() {
      return Effect.succeed({ appId: "app-id", privateKey: "private-key" });
    },
    createBankClient() {
      return {
        getApplication() {
          return Effect.succeed(applicationInfo);
        },
        listBanks(country) {
          state.authorizationPendingDuringBankSelection =
            state.authorizationPending;
          return Effect.succeed({ aspsps: banksByCountry[country] ?? [] });
        },
      };
    },
    openBrowser(url) {
      return Effect.sync(() => {
        state.browserUrls.push(url);
        if (activateApplicationOnBrowserOpen) applicationInfo.active = true;
      });
    },
    beginProductionActivationWait() {
      if (state.productionActivationPending) {
        throw new Error("Production activation is already pending");
      }
      state.productionActivationPending = true;
      state.authorizationPending = true;
    },
    endProductionActivationWait() {
      state.productionActivationPending = false;
    },
    isProductionActivationPending() {
      return state.productionActivationPending;
    },
    mcpServer: mcpServer.server,
  };

  let result;
  mcpServer.registerTool("connect", { inputSchema: {} }, async () => {
    result = await Effect.runPromise(connectBankEffect({
      appName: "Enable Banking MCP",
      environment: "PRODUCTION",
      accessProfile,
    }, dependencies));
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  const client = new Client(
    { name: "guided-connection-test-client", version: "1.0.0" },
    { capabilities },
  );
  if (response) {
    client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
      state.elicitationRequests.push(params);
      return response;
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const toolResponse = await client.callTool({ name: "connect", arguments: {} });
    return { result, state, toolResponse };
  } finally {
    await client.close();
    await mcpServer.close();
  }
}

test("first-run connect asks for email, country, and bank once, then returns balances", async () => {
  const { result, state, toolResponse } = await runConnection({
    response: {
      action: "accept",
      content: {
        control_panel_email: "person@example.com",
        country: "ie",
        bank: "Example Bank",
      },
    },
    capabilities: { elicitation: { form: {} } },
  });

  assert.equal(state.elicitationRequests.length, 1);
  assert.deepEqual(
    state.elicitationRequests[0].requestedSchema.required,
    ["control_panel_email", "country", "bank"],
  );
  assert.equal(
    state.elicitationRequests[0].requestedSchema.properties.control_panel_email.format,
    "email",
  );
  assert.deepEqual(state.setupOptions[0], {
    controlPanelEmail: "person@example.com",
    appName: "Enable Banking MCP",
    environment: "PRODUCTION",
    redirectUrl: "https://localhost:8765/callback",
    aspspName: "Example Bank",
    country: "IE",
    description: "Read-only personal account-information access",
    privacyUrl: "https://marcosvrs.github.io/enable-banking-mcp/privacy-policy/",
    termsUrl: "https://marcosvrs.github.io/enable-banking-mcp/terms-of-use/",
    accessProfile: "balances",
  });
  assert.equal(result.status, "connected");
  assert.deepEqual(result.balances, [
    { account_id: "account-1", balances: [{ amount: "42.00" }] },
  ]);
  assert.doesNotMatch(JSON.stringify(toolResponse), /person@example\.com/);
});

test("declined and unsupported forms do not start setup", async () => {
  const declined = await runConnection({
    capabilities: { elicitation: { form: {} } },
    response: { action: "decline" },
  });
  const unsupported = await runConnection();

  assert.equal(declined.result.status, "cancelled");
  assert.equal(declined.state.setupOptions.length, 0);
  assert.equal(unsupported.result.status, "failed");
  assert.match(unsupported.result.message, /does not support form elicitation/);
  assert.equal(unsupported.state.setupOptions.length, 0);
});

test("an existing session returns balances without eliciting setup details", async () => {
  const { result, state } = await runConnection({
    storedApplication: application(),
    sessionId: "stored-session",
  });

  assert.equal(result.status, "connected");
  assert.deepEqual(result.balances, [
    { account_id: "account-1", balances: [{ amount: "42.00" }] },
  ]);
  assert.equal(state.balanceReads, 1);
  assert.equal(state.elicitationRequests.length, 0);
});

test("a stored balances-only session reauthorizes for transaction access", async () => {
  const { result, state } = await runConnection({
    storedApplication: application(),
    sessionId: "stored-session",
    capabilities: { elicitation: { form: {} } },
    response: {
      action: "accept",
      content: { country: "FI", bank: "Example Bank" },
    },
    accessProfile: "balances_and_transactions",
  });

  assert.deepEqual(state.authorizationCalls, [{
    aspspName: "Example Bank",
    country: "FI",
    redirectUrl: "https://localhost:8765/callback",
    accessProfile: "balances_and_transactions",
  }]);
  assert.equal(result.status, "connected");
  assert.equal(state.balanceReads, 2);
});

test("inactive Production applications open the dashboard before polling", async () => {
  const { result, state } = await runConnection({
    storedApplication: application("PRODUCTION"),
    applicationInfo: { active: false, countries: ["FI"] },
    activateApplicationOnBrowserOpen: true,
    capabilities: { elicitation: { form: {} } },
    response: {
      action: "accept",
      content: { country: "FI", bank: "Example Bank" },
    },
  });

  assert.deepEqual(state.browserUrls, [
    "https://enablebanking.com/cp/applications",
  ]);
  assert.equal(result.status, "connected");
  assert.equal(state.productionActivationPending, false);
});

test("an existing application asks country and bank together and completes authorization", async () => {
  const { result, state } = await runConnection({
    storedApplication: application(),
    capabilities: { elicitation: { form: {} } },
    response: {
      action: "accept",
      content: { country: "FI", bank: "Example Bank" },
    },
  });

  assert.deepEqual(
    state.elicitationRequests[0].requestedSchema.required,
    ["country", "bank"],
  );
  assert.equal(state.authorizationPendingDuringBankSelection, true);
  assert.deepEqual(state.authorizationCalls[0], {
    aspspName: "Example Bank",
    country: "FI",
    redirectUrl: "https://localhost:8765/callback",
    accessProfile: "balances",
  });
  assert.equal(result.status, "connected");
  assert.equal(state.balanceReads, 1);
});

test("connect waits for a running setup and returns its balances without another form", async () => {
  const { result, state } = await runConnection({ setupPending: true });
  assert.equal(state.setupWaits, 1);
  assert.equal(state.setupOptions.length, 0);
  assert.equal(state.elicitationRequests.length, 0);
  assert.equal(result.status, "connected");
  assert.equal(state.balanceReads, 1);
});
test("a pending setup without transaction access continues into reauthorization", async () => {
  const { result, state } = await runConnection({
    setupPending: true,
    setupApplicationAfterWait: application(),
    capabilities: { elicitation: { form: {} } },
    response: {
      action: "accept",
      content: { country: "FI", bank: "Example Bank" },
    },
    accessProfile: "balances_and_transactions",
  });

  assert.equal(state.setupWaits, 1);
  assert.equal(state.setupOptions.length, 0);
  assert.deepEqual(state.authorizationCalls, [{
    aspspName: "Example Bank",
    country: "FI",
    redirectUrl: "https://localhost:8765/callback",
    accessProfile: "balances_and_transactions",
  }]);
  assert.equal(result.status, "connected");
  assert.equal(state.balanceReads, 2);
});

test("a pending authorization without transaction access continues into reauthorization", async () => {
  const { result, state } = await runConnection({
    storedApplication: application(),
    authorizationPending: true,
    completeAuthorizationWhenObserved: true,
    capabilities: { elicitation: { form: {} } },
    response: {
      action: "accept",
      content: { country: "FI", bank: "Example Bank" },
    },
    accessProfile: "balances_and_transactions",
  });

  assert.deepEqual(state.authorizationCalls, [{
    aspspName: "Example Bank",
    country: "FI",
    redirectUrl: "https://localhost:8765/callback",
    accessProfile: "balances_and_transactions",
  }]);
  assert.equal(result.status, "connected");
  assert.equal(state.balanceReads, 1);
});
test("redacts elicited email from setup failures", async () => {
  const { result, toolResponse } = await runConnection({
    capabilities: { elicitation: { form: {} } },
    response: {
      action: "accept",
      content: {
        control_panel_email: "person@example.com",
        country: "IE",
        bank: "Example Bank",
      },
    },
    setupResult: {
      phase: "failed",
      pending: false,
      error: "Provider rejected person@example.com",
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error, "Provider rejected [email redacted]");
  assert.doesNotMatch(JSON.stringify(toolResponse), /person@example\.com/);
});

test("a cancelled authorization waiter without a stored session starts a new authorization", async () => {
  const { result, state } = await runConnection({
    storedApplication: application(),
    authorizationPending: true,
    completeAuthorizationWhenObserved: true,
    failBalancesWithoutSession: true,
    storeSessionOnAuthorization: true,
    capabilities: { elicitation: { form: {} } },
    response: {
      action: "accept",
      content: { country: "FI", bank: "Example Bank" },
    },
  });

  assert.equal(result.status, "connected");
  assert.equal(state.elicitationRequests.length, 1);
  assert.equal(state.authorizationCalls.length, 1);
  assert.equal(state.balanceReads, 1);
});
test("a direct setup without requested access continues through reauthorization", async () => {
  const { result, state } = await runConnection({
    accessProfile: "balances_and_transactions",
    setupApplicationAfterRun: application(),
    storeSessionOnAuthorization: true,
    capabilities: { elicitation: { form: {} } },
    response: {
      action: "accept",
      content: {
        control_panel_email: "person@example.com",
        country: "FI",
        bank: "Example Bank",
      },
    },
  });

  assert.equal(result.status, "connected");
  assert.equal(state.setupOptions.length, 1);
  assert.equal(state.elicitationRequests.length, 1);
  assert.equal(state.authorizationCalls.length, 1);
  assert.equal(state.authorizationCalls[0].accessProfile, "balances_and_transactions");
  assert.equal(state.balanceReads, 2);
});

test("does not report connected when reauthorization still lacks requested access", async () => {
  const { result, state } = await runConnection({
    accessProfile: "balances_and_transactions",
    setupApplicationAfterRun: application(),
    storeSessionOnAuthorization: true,
    grantTransactionsAfterAuthorization: false,
    capabilities: { elicitation: { form: {} } },
    response: {
      action: "accept",
      content: {
        control_panel_email: "person@example.com",
        country: "FI",
        bank: "Example Bank",
      },
    },
  });

  assert.equal(result.status, "failed");
  assert.match(result.error, /did not grant the transaction access/i);
  assert.equal(state.authorizationCalls.length, 1);
});

for (const phase of ["application_ready", "idle"]) {
  test(`continues guided setup after shared ${phase} completion`, async () => {
    const { result, state } = await runConnection({
      setupPending: true,
      setupPendingPhase: "registering_application",
      setupResult: { phase, pending: false },
      setupApplicationAfterWait: application(),
      capabilities: { elicitation: { form: {} } },
      response: {
        action: "accept",
        content: { country: "FI", bank: "Example Bank" },
      },
    });

    assert.equal(result.status, "connected");
    assert.equal(state.setupWaits, 1);
    assert.equal(state.setupOptions.length, 0);
    assert.equal(state.authorizationCalls.length, 1);
    assert.equal(
      state.elicitationRequests[0].requestedSchema.properties.control_panel_email,
      undefined,
    );
  });
}
