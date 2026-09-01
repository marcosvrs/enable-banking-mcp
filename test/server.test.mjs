import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import test from "node:test";

const expectedTools = [
  "authorize_bank",
  "clear_local_credentials",
  "connect_bank",
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
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /setup_enable_banking/);
    assert.match(instructions, /register_application/);
    assert.match(instructions, /defaults to personal PRODUCTION/);
    assert.match(instructions, /never initiates payments/);
    assert.match(instructions, /connect_bank/);
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, expectedTools);
    assert.doesNotMatch(JSON.stringify(response), /user@example\.com/);
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
