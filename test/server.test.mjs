import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import test from "node:test";

const runtimeFixture = fileURLToPath(
  new URL("./fixtures/server-runtime.mjs", import.meta.url),
);

const expectedTools = [
  "authorize_bank",
  "clear_local_credentials",
  "connect_bank",
  "connection_status",
  "control_panel_authenticate",
  "control_panel_logout",
  "control_panel_status",
  "delete_session",
  "get_account_balances",
  "get_account_details",
  "get_account_transactions",
  "get_application",
  "get_health",
  "get_session",
  "get_transaction_details",
  "list_accounts",
  "list_banks",
  "register_application",
  "setup_enable_banking",
  "setup_status",
];

test("exposes documented tools with the local Control Panel email", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ENABLE_BANKING_CONTROL_PANEL_EMAIL: "user@example.com",
    },
  });
  const client = new Client({ name: "enable-banking-mcp-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, expectedTools);
    assert.doesNotMatch(JSON.stringify(response), /user@example\.com/);
    const connectionStatusTool = response.tools.find(
      (tool) => tool.name === "connection_status",
    );
    assert.equal(connectionStatusTool?.annotations?.readOnlyHint, true);
    assert.equal(connectionStatusTool?.annotations?.destructiveHint, false);
    assert.equal(connectionStatusTool?.annotations?.idempotentHint, true);
    assert.equal(connectionStatusTool?.annotations?.openWorldHint, true);
    assert.deepEqual(connectionStatusTool?.inputSchema?.properties, {});
    const setupTool = response.tools.find((tool) => tool.name === "setup_enable_banking");
    assert.equal(setupTool?.inputSchema?.properties?.environment?.default, "PRODUCTION");
    assert.equal(
      setupTool?.inputSchema?.properties?.description?.default,
      "Read-only personal account-information access",
    );
    assert.equal(
      setupTool?.inputSchema?.properties?.privacy_url?.default,
      "https://marcosvrs.github.io/enable-banking-mcp/privacy-policy/",
    );
    assert.equal(
      setupTool?.inputSchema?.properties?.terms_url?.default,
      "https://marcosvrs.github.io/enable-banking-mcp/terms-of-use/",
    );
    assert.equal(
      setupTool?.inputSchema?.properties?.access_profile?.default,
      "balances",
    );
    const authTool = response.tools.find(
      (tool) => tool.name === "control_panel_authenticate",
    );
    assert.equal(authTool?.inputSchema?.properties?.email, undefined);
    assert.equal(
      setupTool?.inputSchema?.properties?.control_panel_email,
      undefined,
    );
    assert.equal(setupTool?.inputSchema?.properties?.gdpr_email, undefined);
    const registerTool = response.tools.find(
      (tool) => tool.name === "register_application",
    );
    assert.equal(
      registerTool?.inputSchema?.properties?.environment?.default,
      "PRODUCTION",
    );
    assert.equal(
      registerTool?.inputSchema?.properties?.description?.default,
      "Read-only personal account-information access",
    );
    assert.equal(registerTool?.inputSchema?.properties?.aspsp_name, undefined);
    assert.equal(registerTool?.inputSchema?.properties?.country, undefined);
    assert.equal(registerTool?.inputSchema?.properties?.access_profile, undefined);
    const connectTool = response.tools.find((tool) => tool.name === "connect_bank");
    assert.equal(
      connectTool?.inputSchema?.properties?.access_profile?.default,
      "balances",
    );
    assert.equal(connectTool?.inputSchema?.properties?.country?.default, undefined);
    assert.equal(connectTool?.inputSchema?.properties?.aspsp_name?.default, undefined);
    const authorizeBankTool = response.tools.find((tool) => tool.name === "authorize_bank");
    assert.equal(
      authorizeBankTool?.inputSchema?.properties?.access_profile?.default,
      "balances",
    );
    assert.equal(
      authorizeBankTool?.inputSchema?.properties?.redirect_url?.default,
      undefined,
    );
    assert.equal(
      authorizeBankTool?.inputSchema?.properties?.psu_type,
      undefined,
    );
    const listBanksTool = response.tools.find((tool) => tool.name === "list_banks");
    assert.equal(listBanksTool?.inputSchema?.properties?.service, undefined);
    assert.equal(listBanksTool?.inputSchema?.properties?.psu_type, undefined);
    assert.equal(listBanksTool?.inputSchema?.properties?.payment_type, undefined);
    const sessionTool = response.tools.find((tool) => tool.name === "get_session");
    assert.equal(sessionTool?.inputSchema?.properties?.session_id, undefined);
    const paymentTool = response.tools.find((tool) => tool.name === "create_payment");
    assert.equal(paymentTool, undefined);
  } finally {
    await client.close();
  }
});

function isolatedEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (
      name.startsWith("ENABLE_BANKING_") ||
      /API[_-]?KEY/i.test(name) ||
      name === "NODE_OPTIONS"
    ) {
      delete env[name];
    }
  }
  return {
    ...env,
    ENABLE_BANKING_CONTROL_PANEL_EMAIL: "user@example.com",
    MCP_TEST_KEYCHAIN: "{}",
    ...overrides,
  };
}

async function startIsolatedServer(overrides = {}, elicitationResponse) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", runtimeFixture, "dist/server.js"],
    cwd: process.cwd(),
    env: isolatedEnvironment(overrides),
  });
  const client = new Client(
    {
      name: "enable-banking-mcp-runtime-test",
      version: "0.1.0",
    },
    elicitationResponse
      ? { capabilities: { elicitation: { form: {} } } }
      : {},
  );
  if (elicitationResponse) {
    client.setRequestHandler(ElicitRequestSchema, async () => elicitationResponse);
  }
  await client.connect(transport);
  return { client, close: () => client.close() };
}

async function callTool(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

function toolValue(result) {
  return JSON.parse(result.content[0].text);
}

async function availablePort() {
  const listener = createNetServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "localhost", resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForToolValue(client, name, predicate) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await callTool(client, name);
    if (!result.isError) {
      const value = toolValue(result);
      if (predicate(value)) return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`MCP tool ${name} did not reach the expected state`);
}

test("runs MCP handlers against isolated provider and Keychain boundaries", async () => {
  const server = await startIsolatedServer({
    MCP_TEST_FAIL_ONCE: "delete-certificate,delete-credential-item",
  });
  try {
    const { client } = server;

    const login = toolValue(await callTool(client, "control_panel_authenticate"));
    assert.equal(login.authenticated, true);
    assert.doesNotMatch(JSON.stringify(login), /user@example\.com/);

    const controlPanelStatus = toolValue(
      await callTool(client, "control_panel_status"),
    );
    assert.equal(controlPanelStatus.authenticated, true);
    assert.equal(controlPanelStatus.expired, false);

    const healthy = await callTool(client, "get_health");
    assert.deepEqual(toolValue(healthy), { status: "ok" });

    const healthError = await callTool(client, "get_health");
    assert.equal(healthError.isError, true);
    assert.match(healthError.content[0].text, /UPSTREAM_FAILURE/);
    assert.match(healthError.content[0].text, /retry_after/);
    assert.match(healthError.content[0].text, /\[local email redacted\]/);
    assert.doesNotMatch(healthError.content[0].text, /user@example\.com/);

    const networkError = await callTool(client, "get_health");
    assert.equal(networkError.isError, true);
    assert.match(networkError.content[0].text, /fixture health network failure/);

    const setupStart = await callTool(client, "register_application", {
      environment: "PRODUCTION",
      redirect_url: `https://localhost:${await availablePort()}/callback`,
    });
    assert.equal(setupStart.isError, undefined);
    const registered = await waitForToolValue(
      client,
      "setup_status",
      (status) => status.phase === "account_link" && !status.pending,
    );
    assert.equal(registered.appId, "fixture-app-id");

    const noForm = toolValue(await callTool(client, "connect_bank"));
    assert.equal(noForm.status, "failed");
    assert.match(noForm.message, /does not support form elicitation/);

    assert.equal(
      toolValue(await callTool(client, "control_panel_logout")).authenticated,
      false,
    );
    assert.equal(
      toolValue(await callTool(client, "control_panel_status")).authenticated,
      false,
    );

    const combinedSetup = await callTool(client, "setup_enable_banking", {
      aspsp_name: "Fixture Bank",
      country: "IE",
    });
    assert.equal(combinedSetup.isError, true);
    assert.match(combinedSetup.content[0].text, /already stored/);

    const inactiveStatus = toolValue(
      await callTool(client, "connection_status"),
    );
    assert.equal(inactiveStatus.connection, "application_activation_required");
    const activeStatus = toolValue(
      await callTool(client, "connection_status"),
    );
    assert.equal(activeStatus.connection, "bank_authorization_required");
    const directAuthorization = toolValue(
      await callTool(client, "authorize_bank", {
        aspsp_name: "Fixture Bank",
        country: "IE",
      }),
    );
    assert.equal(directAuthorization.status, "awaiting_user");
    const directSession = await waitForToolValue(
      client,
      "get_session",
      (value) => value.session_id === "fixture-session-id",
    );
    assert.equal(directSession.session_id, "fixture-session-id");
    assert.equal(
      toolValue(await callTool(client, "delete_session")).deleted,
      true,
    );
    const authorization = toolValue(
      await callTool(client, "authorize_bank", {
        country: "IE",
        aspsp_name: "Fixture Bank",
      }),
    );
    assert.equal(authorization.status, "awaiting_user");
    const pendingStatus = toolValue(
      await callTool(client, "connection_status"),
    );
    assert.equal(pendingStatus.connection, "awaiting_user");
    const pendingSession = await callTool(client, "get_session");
    assert.equal(pendingSession.isError, true);
    assert.match(pendingSession.content[0].text, /authorization is pending/);

    const session = await waitForToolValue(
      client,
      "get_session",
      (value) => value.session_id === "fixture-session-id",
    );
    assert.equal(session.aspsp.name, "Fixture Bank");
    const connected = toolValue(await callTool(client, "connect_bank"));
    assert.equal(connected.status, "connected");
    assert.deepEqual(connected.accounts, [{ uid: "fixture-account" }]);
    assert.equal(connected.balances[0].balances.balances[0].currency, "EUR");
    assert.equal(
      toolValue(await callTool(client, "connection_status")).connection,
      "connected",
    );

    assert.equal(
      toolValue(await callTool(client, "get_application")).name,
      "Fixture application",
    );
    assert.equal(
      toolValue(await callTool(client, "list_banks", { country: "IE" }))
        .aspsps[0].name,
      "Fixture Bank",
    );
    assert.equal(
      toolValue(await callTool(client, "list_accounts")).accounts[0].uid,
      "fixture-account",
    );
    assert.equal(
      toolValue(
        await callTool(client, "get_account_details", {
          account_id: "fixture-account",
        }),
      ).name,
      "Fixture account",
    );
    assert.equal(
      toolValue(
        await callTool(client, "get_account_balances", {
          account_id: "fixture-account",
        }),
      ).balances[0].currency,
      "EUR",
    );
    assert.equal(
      toolValue(
        await callTool(client, "get_account_transactions", {
          account_id: "fixture-account",
        }),
      ).transactions[0].transaction_id,
      "fixture-transaction",
    );
    assert.equal(
      toolValue(
        await callTool(client, "get_transaction_details", {
          account_id: "fixture-account",
          transaction_id: "fixture-transaction",
        }),
      ).amount,
      "12.34",
    );
    for (const [name, arguments_] of [
      ["get_account_details", { account_id: "foreign-account" }],
      ["get_account_balances", { account_id: "foreign-account" }],
      ["get_account_transactions", { account_id: "foreign-account" }],
      [
        "get_transaction_details",
        {
          account_id: "foreign-account",
          transaction_id: "fixture-transaction",
        },
      ],
    ]) {
      const unauthorized = await callTool(client, name, arguments_);
      assert.equal(unauthorized.isError, true);
      assert.match(
        unauthorized.content[0].text,
        /not authorized by the current bank session/,
      );
    }

    const deleted = toolValue(await callTool(client, "delete_session"));
    assert.equal(deleted.deleted, true);
    const noSession = await callTool(client, "get_session");
    assert.equal(noSession.isError, true);
    assert.match(noSession.content[0].text, /No Enable Banking session is stored/);

    const failedAuthorization = toolValue(
      await callTool(client, "authorize_bank", {
        aspsp_name: "Fixture Bank",
        country: "IE",
        redirect_url: `https://localhost:${await availablePort()}/callback`,
      }),
    );
    assert.equal(failedAuthorization.status, "awaiting_user");
    const pendingRetry = await callTool(client, "get_session");
    assert.equal(pendingRetry.isError, true);
    assert.match(pendingRetry.content[0].text, /authorization is pending/);
    let failedSession;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      failedSession = await callTool(client, "get_session");
      if (failedSession.content[0].text.includes("Bank authorization failed")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(failedSession.isError, true);
    assert.match(failedSession.content[0].text, /Bank authorization failed/);

    const failure = toolValue(await callTool(client, "clear_local_credentials"));
    assert.equal(failure.cleared, false);
    assert.deepEqual(failure.failed_items, [
      "trusted_certificate",
      "application",
    ]);
    const retry = toolValue(await callTool(client, "clear_local_credentials"));
    assert.equal(retry.cleared, false);
    assert.deepEqual(retry.failed_items, ["application"]);
    const cleared = toolValue(await callTool(client, "clear_local_credentials"));

    const idle = toolValue(await callTool(client, "setup_status"));
    assert.equal(idle.phase, "idle");
    assert.equal(
      toolValue(await callTool(client, "connection_status")).connection,
      "setup_required",
    );

    const unsupported = toolValue(
      await callTool(client, "connect_bank", { environment: "SANDBOX" }),
    );
    assert.equal(unsupported.status, "failed");
    assert.match(unsupported.message, /does not support form elicitation/);
    assert.equal(
      toolValue(await callTool(client, "clear_local_credentials")).cleared,
      true,
    );
    assert.equal(
      toolValue(await callTool(client, "control_panel_status")).authenticated,
      false,
    );
  } finally {
    await server.close();
  }
});

test("connect_bank owns fresh MCP onboarding through balance retrieval", async () => {
  const server = await startIsolatedServer({}, {
    action: "accept",
    content: {
      control_panel_email: "user@example.com",
      country: "IE",
      bank: "Fixture Bank",
    },
  });
  try {
    const result = await callTool(server.client, "connect_bank", {
      environment: "SANDBOX",
    });
    assert.equal(result.isError, undefined);
    const connected = toolValue(result);
    assert.equal(connected.status, "connected");
    assert.equal(connected.accounts[0].uid, "fixture-account");
    assert.equal(connected.balances[0].balances.balances[0].currency, "EUR");
  } finally {
    await server.close();
  }
});

test("blocks Control Panel logout and credential cleanup during authentication", async () => {
  const server = await startIsolatedServer({
    MCP_TEST_DELAY_EMAIL_CALLBACK: "true",
  });
  let authentication;
  try {
    authentication = callTool(server.client, "control_panel_authenticate");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const logout = await callTool(server.client, "control_panel_logout");
    assert.equal(logout.isError, true);
    assert.match(
      logout.content[0].text,
      /Control Panel authentication or cleanup is pending/,
    );
    const cleanup = await callTool(server.client, "clear_local_credentials");
    assert.equal(cleanup.isError, true);
    assert.match(
      cleanup.content[0].text,
      /Control Panel authentication or cleanup is pending/,
    );

    const login = await authentication;
    assert.equal(toolValue(login).authenticated, true);
    assert.equal(
      toolValue(await callTool(server.client, "control_panel_logout"))
        .authenticated,
      false,
    );
    assert.equal(
      toolValue(await callTool(server.client, "clear_local_credentials"))
        .cleared,
      true,
    );
  } finally {
    if (authentication) await authentication.catch(() => undefined);
    await server.close();
  }
});

test("blocks setup with environment credentials and reports partial configuration", async () => {
  const configured = await startIsolatedServer({
    ENABLE_BANKING_APP_ID: "fixture-app-id",
    ENABLE_BANKING_PRIVATE_KEY: "not-a-real-key",
  });
  try {
    const blocked = await callTool(configured.client, "register_application", {
      environment: "SANDBOX",
    });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /Existing Enable Banking environment credentials/);

    const status = toolValue(
      await callTool(configured.client, "connection_status"),
    );
    assert.equal(status.connection, "status_unavailable");
    assert.equal(status.application, "configured");
  } finally {
    await configured.close();
  }

  const partial = await startIsolatedServer({
    ENABLE_BANKING_APP_ID: "fixture-app-id",
  });
  try {
    const status = toolValue(
      await callTool(partial.client, "connection_status"),
    );
    assert.equal(status.connection, "status_unavailable");
    assert.equal(status.application, "unknown");
    const missingKey = await callTool(partial.client, "get_application");
    assert.equal(missingKey.isError, true);
    assert.match(missingKey.content[0].text, /ENABLE_BANKING_PRIVATE_KEY/);

    const cleared = toolValue(
      await callTool(partial.client, "clear_local_credentials"),
    );
    assert.equal(cleared.environment_credentials_present, true);
  } finally {
    await partial.close();
  }
});

test("reports private-key-only environment credentials during cleanup", async () => {
  const server = await startIsolatedServer({
    ENABLE_BANKING_PRIVATE_KEY: "not-a-real-key",
  });
  try {
    const cleared = toolValue(
      await callTool(server.client, "clear_local_credentials"),
    );
    assert.equal(cleared.cleared, true);
    assert.equal(cleared.environment_credentials_present, true);
  } finally {
    await server.close();
  }
});

test("reports the legacy application ID alias during cleanup", async () => {
  const server = await startIsolatedServer({
    ENABLE_BANKING_ID: "fixture-app-id",
  });
  try {
    const cleared = toolValue(
      await callTool(server.client, "clear_local_credentials"),
    );
    assert.equal(cleared.environment_credentials_present, true);
  } finally {
    await server.close();
  }
});

test("clears a terminal environment session before refusing environment-based setup", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const server = await startIsolatedServer({
    ENABLE_BANKING_APP_ID: "fixture-app-id",
    ENABLE_BANKING_PRIVATE_KEY: privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
    ENABLE_BANKING_SESSION_ID: "terminal-session",
  });
  try {
    const result = await callTool(server.client, "connect_bank", {
      environment: "SANDBOX",
    });
    assert.equal(result.isError, true);
    assert.match(
      result.content[0].text,
      /Existing Enable Banking environment credentials/,
    );

    const session = await callTool(server.client, "get_session");
    assert.equal(session.isError, true);
    assert.match(session.content[0].text, /No Enable Banking session is stored/);
  } finally {
    await server.close();
  }
});

test("requires MCP-owned form elicitation for primary onboarding", async () => {
  const server = await startIsolatedServer({
    ENABLE_BANKING_CONTROL_PANEL_EMAIL: "",
  });
  try {
    const connect = toolValue(
      await callTool(server.client, "connect_bank", { environment: "SANDBOX" }),
    );
    assert.equal(connect.status, "failed");
    assert.match(connect.message, /does not support form elicitation/);

    for (const name of ["register_application", "control_panel_authenticate"]) {
      const value = toolValue(await callTool(server.client, name, {
        environment: "SANDBOX",
      }));
      assert.equal(value.status, "needs_control_panel_email");
      assert.match(value.required_input, /ENABLE_BANKING_CONTROL_PANEL_EMAIL/);
    }
  } finally {
    await server.close();
  }
});


test("reports configuration-free sessions as unverifiable and requires an application", async () => {
  const server = await startIsolatedServer({
    ENABLE_BANKING_SESSION_ID: "fixture-session-id",
  });
  try {
    const authorization = await callTool(server.client, "authorize_bank", {
      aspsp_name: "Fixture Bank",
    });
    assert.equal(authorization.isError, true);
    assert.match(
      authorization.content[0].text,
      /No Enable Banking application is configured/,
    );

    const status = toolValue(
      await callTool(server.client, "connection_status"),
    );
    assert.equal(status.connection, "status_unavailable");
    assert.equal(status.bank_session, "unknown");
  } finally {
    await server.close();
  }
});

test("blocks logout, authorization, and credential cleanup while registration is pending", async () => {
  const server = await startIsolatedServer({
    MCP_TEST_DELAY_REGISTRATION: "true",
  });
  try {
    const registration = await callTool(server.client, "register_application", {
      environment: "SANDBOX",
    });
    assert.equal(registration.isError, undefined);

    const authorization = await callTool(server.client, "authorize_bank", {
      aspsp_name: "Fixture Bank",
    });
    assert.equal(authorization.isError, true);
    assert.match(
      authorization.content[0].text,
      /Enable Banking setup is already in progress/,
    );

    const cleanup = await callTool(server.client, "clear_local_credentials");
    assert.equal(cleanup.isError, true);
    assert.match(
      cleanup.content[0].text,
      /Cannot clear credentials while setup or authorization is pending/,
    );

    const logout = await callTool(server.client, "control_panel_logout");
    assert.equal(logout.isError, true);
    assert.match(
      logout.content[0].text,
      /Cannot log out while application setup is pending/,
    );

    const status = await waitForToolValue(
      server.client,
      "setup_status",
      (value) => value.phase === "application_ready" && !value.pending,
    );
    assert.equal(status.phase, "application_ready");
  } finally {
    await server.close();
  }
});



test("successful credential cleanup clears failed authorization state", async () => {
  const server = await startIsolatedServer({
    MCP_TEST_FAIL_FIRST_SESSION_CREATE: "true",
  });
  try {
    await callTool(server.client, "register_application", {
      environment: "SANDBOX",
    });
    await waitForToolValue(
      server.client,
      "setup_status",
      (status) => status.phase === "application_ready" && !status.pending,
    );

    const authorization = toolValue(
      await callTool(server.client, "authorize_bank", {
        aspsp_name: "Fixture Bank",
        country: "IE",
      }),
    );
    assert.equal(authorization.status, "awaiting_user");

    let failedAuthorization;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = toolValue(
        await callTool(server.client, "connect_bank", {
          environment: "SANDBOX",
          country: "IE",
          aspsp_name: "Fixture Bank",
        }),
      );
      if (result.status === "failed") {
        failedAuthorization = result;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(
      failedAuthorization?.error ?? "",
      /fixture session exchange failed/,
    );

    const cleanup = toolValue(
      await callTool(server.client, "clear_local_credentials"),
    );
    assert.equal(cleanup.cleared, true);

    const registration = toolValue(
      await callTool(server.client, "register_application", {
        environment: "SANDBOX",
      }),
    );
    assert.equal(registration.status, "started");
    await waitForToolValue(
      server.client,
      "setup_status",
      (status) => status.phase === "application_ready" && !status.pending,
    );

    const freshAuthorization = toolValue(
      await callTool(server.client, "authorize_bank", {
        environment: "SANDBOX",
        country: "IE",
        aspsp_name: "Fixture Bank",
      }),
    );
    assert.equal(freshAuthorization.status, "awaiting_user");
  } finally {
    await server.close();
  }
});


test("clears recoverable state when the persisted application record is malformed", async () => {
  const server = await startIsolatedServer({
    MCP_TEST_KEYCHAIN: JSON.stringify({
      "enable-banking-mcp.application": "not-json",
    }),
  });
  try {
    const cleanup = toolValue(
      await callTool(server.client, "clear_local_credentials"),
    );
    assert.equal(cleanup.cleared, false);
    assert.deepEqual(cleanup.failed_items, ["trusted_certificate", "application"]);

    const retry = toolValue(
      await callTool(server.client, "clear_local_credentials"),
    );
    assert.equal(retry.cleared, false);
    assert.deepEqual(retry.failed_items, ["trusted_certificate", "application"]);
  } finally {
    await server.close();
  }
});
