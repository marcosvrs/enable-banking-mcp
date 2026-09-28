import { Effect } from "effect";

import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import test from "node:test";
import { EnableBankingApiError } from "../dist/enable-banking.js";
import { connectBank as connectBankEffect } from "../dist/guided-connection.js";
import { resolveControlPanelEmailInput as resolveControlPanelEmailInputEffect } from "../dist/control-panel-email.js";


function connectBank(...args) {
  return Effect.runPromise(
    Effect.either(connectBankEffect(...args)),
  ).then((result) => {
    if (result._tag === "Left") throw result.left;
    return result.right;
  });
}

function memoryStore(value) {
  return {
    value,
    get() {
      return Effect.sync(() => this.value);
    },
    set(next) {
      return Effect.sync(() => {
        this.value = next;
      });
    },
    clear() {
      return Effect.sync(() => {
        this.value = undefined;
      });
    },
  };
}

function storedApplication(environment = "SANDBOX", redirectUrls = ["https://localhost:8765/callback"]) {
  return {
    appId: "app-id",
    privateKey: "private-key",
    certificate: "certificate",
    environment,
    redirectUrls,
  };
}

async function runConnection({
  options = {},
  capabilities = {},
  responses,
  application,
  sessionId,
  environmentSessionId,
  storedEmail,
  environmentEmail = "local@example.com",
  setupPending = false,
  authorizationPending = false,
  authorizationLastError,
  applicationInfo = { active: true, countries: ["FI"] },
  globalBanks = [],
  banksByCountry = {},
  readAuthorizedAccounts,
  credentialError,
  applicationError,
  bankListError,
  environmentCredentialsError,
} = {}) {
  const mcpServer = new McpServer({ name: "guided-connection-test", version: "1.0.0" });
  const state = {
    applicationStore: memoryStore(application),
    sessionStore: memoryStore(sessionId),
    environmentSessionId,
    setupStatus: {
      phase: setupPending ? "account_link" : "idle",
      pending: setupPending,
      ...(setupPending ? { message: "Setup is waiting for dashboard activation" } : {}),
    },
    setupRegistrationCalls: [],
    setupStartCalls: [],
    authorizationCalls: [],
    controlPanelReads: 0,
    emailResolveCalls: 0,
    environmentCredentialChecks: 0,
    authorizedAccountReads: 0,
    applicationReads: 0,
    bankCalls: [],
    openedUrls: [],
  };
  const dependencies = {
    applicationStore: state.applicationStore,
    sessionStore: state.sessionStore,
    setupFlow: {
      get status() {
        return state.setupStatus;
      },
      registerApplication(registration) {
        state.setupRegistrationCalls.push(registration);
        return Effect.succeed({
          status: "started",
          phase: "control_panel_auth",
          message: "Registration started",
        });
      },
      start(setup) {
        state.setupStartCalls.push(setup);
        return Effect.succeed({
          status: "started",
          phase: "control_panel_auth",
          message: "Combined setup started",
        });
      },
    },
    authorizationFlow: {
      status: {
        pending: authorizationPending,
        ...(authorizationLastError ? { lastError: authorizationLastError } : {}),
      },
      start(client, authorization) {
        state.authorizationCalls.push({ client, authorization });
        return Effect.succeed({
          status: "awaiting_user",
          authorization_url: "https://bank.example/authorize",
        });
      },
    },
    controlPanelAuthStore: {
      get() {
        state.controlPanelReads += 1;
        return Effect.succeed(storedEmail ? { email: storedEmail } : undefined);
      },
    },
    resolveControlPanelEmail(environmentName, keychainEmail) {
      state.emailResolveCalls += 1;
      return Effect.map(
        resolveControlPanelEmailInputEffect(
          mcpServer.server,
          environmentName,
          environmentEmail,
          keychainEmail,
        ),
        (resolved) => resolved.status === "ready" ? resolved.email : resolved,
      );
    },
    assertNoEnvironmentCredentials() {
      state.environmentCredentialChecks += 1;
      if (environmentCredentialsError) throw environmentCredentialsError;
    },
    getEnvironmentSessionId() {
      return state.environmentSessionId;
    },
    clearEnvironmentSession(expected) {
      if (expected && state.environmentSessionId === expected) {
        state.environmentSessionId = undefined;
      }
    },
    readAuthorizedAccounts() {
      state.authorizedAccountReads += 1;
      return Effect.tryPromise({
        try: async () => {
          if (readAuthorizedAccounts) return readAuthorizedAccounts(state.authorizedAccountReads);
          return { aspsp: { name: "Nordea", country: "FI" }, accounts: [{ uid: "account-1" }] };
        },
        catch: (error) => error,
      });
    },
    resolveCredentials() {
      return credentialError
        ? Effect.fail(credentialError)
        : Effect.succeed({ appId: "app-id", privateKey: "private-key" });
    },
    createBankClient() {
      return {
        getApplication() {
          return Effect.tryPromise({
            try: async () => {
              state.applicationReads += 1;
              if (applicationError) throw applicationError;
              return applicationInfo;
            },
            catch: (error) => error,
          });
        },
        listBanks(country) {
          return Effect.tryPromise({
            try: async () => {
              state.bankCalls.push(country);
              if (bankListError) throw bankListError;
              return {
                aspsps:
                  country === undefined
                    ? globalBanks
                    : banksByCountry[country] ?? [],
              };
            },
            catch: (error) => error,
          });
        },
      };
    },
    openBrowser(url) {
      state.openedUrls.push(url);
    },
    mcpServer: mcpServer.server,
  };
  const connectOptions = {
    appName: "Enable Banking MCP",
    environment: "PRODUCTION",
    accessProfile: "balances",
    ...options,
  };
  let result;
  let flowError;
  mcpServer.registerTool("connect", { inputSchema: {} }, async () => {
    try {
      result = await connectBank(connectOptions, dependencies);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      flowError = error;
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  });

  const client = new Client(
    { name: "guided-connection-test-client", version: "1.0.0" },
    { capabilities },
  );
  const elicitationRequests = [];
  if (responses) {
    let responseIndex = 0;
    client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
      elicitationRequests.push(params);
      const response = responses[responseIndex++];
      if (!response) throw new Error("Unexpected elicitation request");
      return response;
    });
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const toolResponse = await client.callTool({ name: "connect", arguments: {} });
    return { result, state, elicitationRequests, flowError, toolResponse };
  } finally {
    await client.close();
    await mcpServer.close();
  }
}

test("a valid session returns authorized accounts before asking for identity or bank", async () => {
  const { result, state, elicitationRequests } = await runConnection({
    sessionId: "stored-session",
    application: undefined,
    environmentEmail: "",
  });

  assert.equal(result.status, "connected");
  assert.deepEqual(result.accounts, [{ uid: "account-1" }]);
  assert.equal(state.authorizedAccountReads, 1);
  assert.equal(state.emailResolveCalls, 0);
  assert.equal(state.setupRegistrationCalls.length, 0);
  assert.deepEqual(elicitationRequests, []);
});

test("requests fresh transaction consent when a stored session lacks it", async () => {
  const { result, state } = await runConnection({
    sessionId: "balance-only-session",
    application: storedApplication(),
    options: {
      country: "FI",
      aspspName: "Nordea",
      accessProfile: "balances_and_transactions",
    },
    readAuthorizedAccounts: async () => ({
      aspsp: { name: "Nordea", country: "FI" },
      accounts: [{ uid: "account-1" }],
      access: { balances: true, transactions: false },
    }),
    banksByCountry: {
      FI: [{ name: "Nordea", country: "FI" }],
    },
    environmentEmail: "",
  });

  assert.equal(result.status, "awaiting_user");
  assert.equal(state.authorizedAccountReads, 1);
  assert.equal(state.authorizationCalls.length, 1);
  assert.equal(
    state.authorizationCalls[0].authorization.accessProfile,
    "balances_and_transactions",
  );
});

test("a terminal stored session falls back to the environment session before setup", async () => {
  const { result, state, elicitationRequests } = await runConnection({
    sessionId: "expired-keychain-session",
    environmentSessionId: "valid-environment-session",
    application: undefined,
    environmentEmail: "",
    readAuthorizedAccounts: async (attempt) => {
      if (attempt === 1) {
        throw new EnableBankingApiError(401, "session expired", {
          error: "EXPIRED_SESSION",
        });
      }
      return { accounts: [{ uid: "environment-account" }] };
    },
  });

  assert.equal(result.status, "connected");
  assert.deepEqual(result.accounts, [{ uid: "environment-account" }]);
  assert.equal(state.sessionStore.value, undefined);
  assert.equal(state.environmentSessionId, "valid-environment-session");
  assert.equal(state.authorizedAccountReads, 2);
  assert.equal(state.emailResolveCalls, 0);
  assert.deepEqual(elicitationRequests, []);
});

test("pending setup resumes without requesting email or starting another setup", async () => {
  const { result, state, elicitationRequests } = await runConnection({
    setupPending: true,
    application: undefined,
    environmentEmail: "",
  });

  assert.equal(result.status, "awaiting_user");
  assert.equal(result.phase, "account_link");
  assert.equal(state.emailResolveCalls, 0);
  assert.equal(state.setupRegistrationCalls.length, 0);
  assert.equal(state.setupStartCalls.length, 0);
  assert.deepEqual(elicitationRequests, []);
});

test("missing Control Panel identity is elicited before first-run registration", async () => {
  const { result, state, elicitationRequests, toolResponse } = await runConnection({
    application: undefined,
    environmentEmail: "",
    capabilities: { elicitation: { form: {} } },
    responses: [{ action: "accept", content: { email: "user@example.com" } }],
  });

  assert.equal(result.status, "setup_started");
  assert.equal(state.setupRegistrationCalls.length, 1);
  assert.equal(state.setupStartCalls.length, 0);
  assert.equal(state.setupRegistrationCalls[0].controlPanelEmail, "user@example.com");
  assert.equal(state.setupRegistrationCalls[0].environment, "PRODUCTION");
  assert.equal(state.setupRegistrationCalls[0].aspspName, undefined);
  assert.equal(state.setupRegistrationCalls[0].country, undefined);
  assert.equal(elicitationRequests.length, 1);
  assert.equal(elicitationRequests[0].requestedSchema.properties.email.format, "email");
  assert.doesNotMatch(JSON.stringify(result), /user@example\.com/);
  assert.doesNotMatch(JSON.stringify(toolResponse), /user@example\.com/);
});

test("declined or unsupported email input never begins first-run registration", async () => {
  const declined = await runConnection({
    application: undefined,
    environmentEmail: "",
    capabilities: { elicitation: { form: {} } },
    responses: [{ action: "decline" }],
  });
  const unsupported = await runConnection({
    application: undefined,
    environmentEmail: "",
  });

  assert.equal(declined.result.status, "input_declined");
  assert.equal(declined.state.setupRegistrationCalls.length, 0);
  assert.equal(unsupported.result.status, "needs_control_panel_email");
  assert.equal(unsupported.state.setupRegistrationCalls.length, 0);
  assert.deepEqual(unsupported.elicitationRequests, []);
});

test("first-run known bank and country use the combined setup path", async () => {
  const { result, state, elicitationRequests } = await runConnection({
    application: undefined,
    options: { country: "FI", aspspName: "Nordea", accessProfile: "balances_and_transactions" },
  });

  assert.equal(result.status, "setup_started");
  assert.equal(state.setupRegistrationCalls.length, 0);
  assert.equal(state.setupStartCalls.length, 1);
  assert.equal(state.setupStartCalls[0].aspspName, "Nordea");
  assert.equal(state.setupStartCalls[0].country, "FI");
  assert.equal(state.setupStartCalls[0].accessProfile, "balances_and_transactions");
  assert.deepEqual(elicitationRequests, []);
});

test("either missing first-run bank field defers to application registration", async () => {
  for (const options of [
    { country: "FI" },
    { aspspName: "Nordea" },
  ]) {
    const { result, state } = await runConnection({
      application: undefined,
      options,
    });

    assert.equal(result.status, "setup_started");
    assert.equal(state.setupRegistrationCalls.length, 1);
    assert.equal(state.setupStartCalls.length, 0);
  }
});

test("conflicting environment credentials stop first-run before elicitation", async () => {
  const { result, state, elicitationRequests, toolResponse } = await runConnection({
    application: undefined,
    environmentEmail: "",
    environmentCredentialsError: new Error("conflicting credentials"),
    capabilities: { elicitation: { form: {} } },
    responses: [{ action: "accept", content: { email: "user@example.com" } }],
  });

  assert.equal(result, undefined);
  assert.equal(state.emailResolveCalls, 0);
  assert.equal(state.environmentCredentialChecks, 1);
  assert.equal(elicitationRequests.length, 0);
  assert.equal(state.setupRegistrationCalls.length, 0);
  assert.equal(toolResponse.isError, true);
});

test("pending bank authorization resumes without requesting application data", async () => {
  const { result, state, elicitationRequests } = await runConnection({
    application: storedApplication(),
    authorizationPending: true,
    environmentEmail: "",
  });

  assert.equal(result.status, "awaiting_user");
  assert.equal(result.phase, "bank_authorization");
  assert.equal(state.applicationReads, 0);
  assert.equal(state.bankCalls.length, 0);
  assert.equal(state.authorizationCalls.length, 0);
  assert.deepEqual(elicitationRequests, []);
});

test("surfaces bank authorization failure without retrying automatically", async () => {
  const { result, state } = await runConnection({
    application: storedApplication(),
    authorizationLastError: "Bank authorization was denied",
    environmentEmail: "",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.phase, "bank_authorization");
  assert.equal(result.error, "Bank authorization was denied");
  assert.match(result.message, /Do not retry automatically/);
  assert.equal(state.applicationReads, 0);
  assert.equal(state.bankCalls.length, 0);
  assert.equal(state.authorizationCalls.length, 0);
});

test("inactive Production application pauses for dashboard linking before bank discovery", async () => {
  const { result, state, elicitationRequests } = await runConnection({
    application: storedApplication("PRODUCTION"),
    applicationInfo: { active: false, countries: ["FI"] },
    environmentEmail: "",
  });

  assert.equal(result.status, "dashboard_action_required");
  assert.equal(result.phase, "account_link");
  assert.deepEqual(state.openedUrls, ["https://enablebanking.com/cp/applications"]);
  assert.equal(state.bankCalls.length, 0);
  assert.equal(state.authorizationCalls.length, 0);
  assert.deepEqual(elicitationRequests, []);
});

test("guided active application asks country and bank before starting consent", async () => {
  const { result, state, elicitationRequests } = await runConnection({
    application: storedApplication("SANDBOX"),
    applicationInfo: { active: true, countries: ["FI", "IE"] },
    globalBanks: [
      { name: "Nordea", country: "FI" },
      { name: "OP", country: "FI" },
      { name: "AIB", country: "IE" },
    ],
    capabilities: { elicitation: { form: {} } },
    responses: [
      { action: "accept", content: { country: "FI" } },
      { action: "accept", content: { bank: "1" } },
    ],
  });

  assert.equal(result.status, "awaiting_user");
  assert.equal(result.aspsp.name, "OP");
  assert.equal(result.aspsp.country, "FI");
  assert.equal(state.authorizationCalls.length, 1);
  assert.deepEqual(state.authorizationCalls[0].authorization, {
    aspspName: "OP",
    country: "FI",
    redirectUrl: "https://localhost:8765/callback",
    accessProfile: "balances",
  });
  assert.equal(elicitationRequests.length, 2);
  assert.deepEqual(state.openedUrls, []);
});

test("declining bank selection does not start authorization", async () => {
  const { result, state } = await runConnection({
    application: storedApplication(),
    applicationInfo: { active: true, countries: ["FI"] },
    banksByCountry: {
      FI: [{ name: "Nordea" }, { name: "OP" }],
    },
    capabilities: { elicitation: { form: {} } },
    responses: [{ action: "decline" }],
  });

  assert.equal(result.status, "input_declined");
  assert.equal(result.required_input, "bank");
  assert.equal(state.authorizationCalls.length, 0);
});

test("clients without elicitation receive provider choices without consent", async () => {
  const { result, state, elicitationRequests } = await runConnection({
    application: storedApplication(),
    applicationInfo: { active: true, countries: ["FI", "IE"] },
    globalBanks: [
      { name: "Nordea", country: "FI" },
      { name: "AIB", country: "IE" },
    ],
  });

  assert.equal(result.status, "needs_country");
  assert.deepEqual(result.supported_countries, ["FI", "IE"]);
  assert.equal(state.authorizationCalls.length, 0);
  assert.deepEqual(elicitationRequests, []);
});

test("empty bank catalogs return no_banks instead of opening consent", async () => {
  const { result, state } = await runConnection({
    application: storedApplication(),
    applicationInfo: { active: true, countries: ["FI"] },
    banksByCountry: { FI: [] },
  });

  assert.equal(result.status, "no_banks");
  assert.equal(state.authorizationCalls.length, 0);
});

test("provider lookup failures do not start bank authorization", async () => {
  for (const options of [
    { applicationError: new Error("application lookup failed") },
    { bankListError: new Error("bank catalog failed") },
  ]) {
    const { flowError, state, toolResponse } = await runConnection({
      application: storedApplication(),
      applicationInfo: { active: true, countries: ["FI"] },
      banksByCountry: { FI: [{ name: "Nordea" }] },
      ...options,
    });

    assert.ok(flowError);
    assert.equal(state.authorizationCalls.length, 0);
    assert.equal(toolResponse.isError, true);
  }
});

test("explicit bank selection skips elicitation and uses the default callback URL when unset", async () => {
  const { result, state, elicitationRequests } = await runConnection({
    application: storedApplication("SANDBOX", []),
    options: { country: "FI", aspspName: "Nordea" },
    applicationInfo: { active: false, countries: ["FI"] },
    banksByCountry: { FI: [{ name: "Nordea" }] },
  });

  assert.equal(result.status, "awaiting_user");
  assert.equal(result.aspsp.name, "Nordea");
  assert.equal(state.authorizationCalls.length, 1);
  assert.equal(
    state.authorizationCalls[0].authorization.redirectUrl,
    "https://localhost:8765/callback",
  );
  assert.deepEqual(elicitationRequests, []);
});

test("clients without form support receive bank choices without authorization", async () => {
  const { result, state, elicitationRequests } = await runConnection({
    application: storedApplication(),
    applicationInfo: { active: true, countries: ["FI"] },
    banksByCountry: {
      FI: [{ name: "Nordea" }, { name: "OP" }],
    },
  });

  assert.equal(result.status, "needs_bank_selection");
  assert.deepEqual(result.banks, [
    { name: "Nordea", country: "FI" },
    { name: "OP", country: "FI" },
  ]);
  assert.equal(state.authorizationCalls.length, 0);
  assert.deepEqual(elicitationRequests, []);
});
test("clears a terminal environment session before continuing setup", async () => {
  const { result, state } = await runConnection({
    environmentSessionId: "expired-environment-session",
    application: undefined,
    environmentEmail: "local@example.com",
    readAuthorizedAccounts: async () => {
      throw new EnableBankingApiError(401, "session expired", {
        error: "EXPIRED_SESSION",
      });
    },
  });

  assert.equal(state.environmentSessionId, undefined);
  assert.equal(state.authorizedAccountReads, 1);
  assert.equal(result.status, "setup_started");
  assert.equal(state.setupRegistrationCalls.length, 1);
});

test("does not clear an environment session when authorized-account lookup has a transient failure", async () => {
  const failure = new Error("temporary provider outage");
  const { result, state, flowError, toolResponse } = await runConnection({
    environmentSessionId: "environment-session",
    application: undefined,
    readAuthorizedAccounts: async () => {
      throw failure;
    },
  });

  assert.equal(flowError, failure);
  assert.equal(result, undefined);
  assert.equal(toolResponse.isError, true);
  assert.equal(state.environmentSessionId, "environment-session");
  assert.equal(state.emailResolveCalls, 0);
});
