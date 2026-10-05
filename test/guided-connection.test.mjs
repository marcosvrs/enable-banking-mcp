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
  setupPending = false,
  setupStartError,
  authorizationPending = false,
  accessProfile = "balances_and_transactions",
  validUntil,
} = {}) {
  const mcpServer = new McpServer({ name: "guided-connection-test", version: "1.0.0" });
  const state = {
    applicationStore: memoryStore(storedApplication),
    sessionStore: memoryStore(sessionId),
    setupOptions: [],
    authorizationCalls: [],
    balanceReads: 0,
    browserUrls: [],
    elicitationRequests: [],
    linkedBankLookups: 0,
    authorizationPending,
    progress: [],
  };
  const dependencies = {
    applicationStore: state.applicationStore,
    sessionStore: state.sessionStore,
    setupFlow: {
      get status() {
        return {
          phase: setupPending ? "bank_authorization" : "idle",
          pending: setupPending,
        };
      },
      startGuided(options) {
        state.setupOptions.push(options);
        return setupStartError
          ? Effect.fail(setupStartError)
          : Effect.succeed({
              status: "started",
              phase: "control_panel_auth",
              message: "Enable Banking onboarding started",
            });
      },
      findLinkedBank() {
        state.linkedBankLookups += 1;
        return Effect.succeed({ name: "Example Bank", country: "FI" });
      },
    },
    authorizationFlow: {
      get status() {
        return { pending: state.authorizationPending };
      },
      start(_client, options) {
        state.authorizationCalls.push(options);
        state.authorizationPending = true;
        return Effect.succeed({
          status: "awaiting_user",
          authorization_url: "https://bank.example/authorize",
        });
      },
    },
    assertNoEnvironmentCredentials() {},
    getEnvironmentSessionId() {
      return undefined;
    },
    clearEnvironmentSession() {},
    readAuthorizedBalances() {
      state.balanceReads += 1;
      return Effect.succeed({
        aspsp: { name: "Example Bank", country: "FI" },
        accounts: [{ uid: "account-1" }],
        balances: [{ account_id: "account-1", balances: [{ amount: "42.00" }] }],
        access: { balances: true, transactions: false },
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
          return Effect.succeed({ aspsps: banksByCountry[country] ?? [] });
        },
      };
    },
    openBrowser(url) {
      state.browserUrls.push(url);
    },
    setProgress(phase) {
      state.progress.push(phase);
    },
    mcpServer: mcpServer.server,
  };

  let result;
  mcpServer.registerTool("connect", { inputSchema: {} }, async () => {
    result = await Effect.runPromise(connectBankEffect({
      appName: "Enable Banking MCP",
      environment: "PRODUCTION",
      accessProfile,
      ...(validUntil ? { validUntil } : {}),
    }, dependencies));
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
  const client = new Client(
    { name: "guided-connection-test-client", version: "1.0.0" },
    { capabilities },
  );
  let elicitationResponseIndex = 0;
  if (response) {
    client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
      state.elicitationRequests.push(params);
      const selectedResponse = Array.isArray(response)
        ? response[elicitationResponseIndex++]
        : response;
      return typeof selectedResponse === "function"
        ? selectedResponse(params)
        : selectedResponse;
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

test("first-run Production connect starts background onboarding after eliciting email", async () => {
  const { result, state, toolResponse } = await runConnection({
    response: {
      action: "accept",
      content: { control_panel_email: "person@example.com" },
    },
    capabilities: { elicitation: { form: {} } },
  });

  assert.equal(state.elicitationRequests.length, 1);
  assert.deepEqual(
    state.elicitationRequests[0].requestedSchema.required,
    ["control_panel_email"],
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
    description: "Read-only personal account-information access",
    privacyUrl: "https://marcosvrs.github.io/enable-banking-mcp/privacy-policy/",
    termsUrl: "https://marcosvrs.github.io/enable-banking-mcp/terms-of-use/",
    accessProfile: "balances_and_transactions",
  });
  assert.equal(result.status, "awaiting_user");
  assert.equal(result.phase, "control_panel_auth");
  assert.equal(state.balanceReads, 0);
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

test("existing Sandbox application asks country, bank, and consent settings", async () => {
  const { result, state } = await runConnection({
    storedApplication: application(),
    capabilities: { elicitation: { form: {} } },
    response: [
      {
        action: "accept",
        content: { country: "FI", bank: "Example Bank" },
      },
      {
        action: "accept",
        content: { access_profile: "balances_and_transactions" },
      },
    ],
  });

  assert.deepEqual(
    state.elicitationRequests[0].requestedSchema.required,
    ["country", "bank"],
  );
  assert.deepEqual(
    state.elicitationRequests[1].requestedSchema.properties.access_profile.enum,
    ["balances_and_transactions", "balances"],
  );
  assert.deepEqual(state.authorizationCalls[0], {
    aspspName: "Example Bank",
    country: "FI",
    redirectUrl: "https://localhost:8765/callback",
    accessProfile: "balances_and_transactions",
  });
  assert.equal(result.status, "awaiting_user");
  assert.equal(result.phase, "bank_authorization");
  assert.equal(state.balanceReads, 0);
});

test("existing Production onboarding falls back to default consent without form support", async () => {
  const { result, state } = await runConnection({
    storedApplication: application("PRODUCTION"),
  });

  assert.equal(state.elicitationRequests.length, 0);
  assert.equal(state.linkedBankLookups, 1);
  assert.deepEqual(state.authorizationCalls[0], {
    aspspName: "Example Bank",
    country: "FI",
    redirectUrl: "https://localhost:8765/callback",
    accessProfile: "balances_and_transactions",
  });
  assert.equal(result.status, "awaiting_user");
  assert.equal(result.phase, "bank_authorization");
  assert.equal(state.balanceReads, 0);
});
test("lets the user change transaction scope and consent expiry before bank auth", async () => {
  const { result, state } = await runConnection({
    storedApplication: application("PRODUCTION"),
    capabilities: { elicitation: { form: {} } },
    response: {
      action: "accept",
      content: {
        access_profile: "balances",
        valid_until: "2099-12-01T00:00:00Z",
      },
    },
  });

  const form = state.elicitationRequests[0];
  assert.equal(
    form.requestedSchema.properties.access_profile.default,
    "balances_and_transactions",
  );
  assert.deepEqual(
    form.requestedSchema.properties.access_profile.enum,
    ["balances_and_transactions", "balances"],
  );
  assert.equal(form.requestedSchema.properties.valid_until.format, "date-time");
  assert.deepEqual(form.requestedSchema.required, ["access_profile"]);
  assert.deepEqual(state.authorizationCalls[0], {
    aspspName: "Example Bank",
    country: "FI",
    redirectUrl: "https://localhost:8765/callback",
    accessProfile: "balances",
    validUntil: "2099-12-01T00:00:00Z",
  });
  assert.equal(result.status, "awaiting_user");
});
test("declining consent settings stops before bank authorization", async () => {
  const { result, state } = await runConnection({
    storedApplication: application("PRODUCTION"),
    capabilities: { elicitation: { form: {} } },
    response: { action: "decline" },
  });

  assert.equal(result.status, "cancelled");
  assert.equal(result.phase, "consent_settings");
  assert.equal(state.authorizationCalls.length, 0);
});

test("stored inactive Production app opens dashboard and returns an activation wait", async () => {
  const applicationInfo = { active: false, countries: ["FI"] };
  const { result, state } = await runConnection({
    storedApplication: application("PRODUCTION"),
    applicationInfo,
    capabilities: { elicitation: { form: {} } },
  });

  assert.equal(state.elicitationRequests.length, 0);
  assert.deepEqual(state.browserUrls, ["https://enablebanking.com/cp/applications"]);
  assert.equal(state.linkedBankLookups, 0);
  assert.equal(result.status, "awaiting_user");
  assert.equal(result.phase, "account_activation");
  assert.ok(state.progress.includes("account_activation"));
  assert.equal(state.progress.at(-1), "account_activation");
});

test("connect returns the active setup phase without waiting for completion", async () => {
  const { result, state } = await runConnection({ setupPending: true });
  assert.equal(state.setupOptions.length, 0);
  assert.equal(state.elicitationRequests.length, 0);
  assert.equal(result.status, "awaiting_user");
  assert.equal(result.phase, "bank_authorization");
  assert.equal(state.balanceReads, 0);
});
test("redacts elicited email from setup start failures", async () => {
  const { toolResponse } = await runConnection({
    capabilities: { elicitation: { form: {} } },
    response: {
      action: "accept",
      content: { control_panel_email: "person@example.com" },
    },
    setupStartError: new Error("Provider rejected person@example.com"),
  });

  assert.equal(toolResponse.isError, true);
  assert.match(JSON.stringify(toolResponse), /\[email redacted\]/);
  assert.doesNotMatch(JSON.stringify(toolResponse), /person@example\.com/);
});
