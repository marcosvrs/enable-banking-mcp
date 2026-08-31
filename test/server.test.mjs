import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import test from "node:test";

const expectedTools = [
  "authorize_bank",
  "clear_local_credentials",
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
  "setup_enable_banking",
  "setup_status",
];

test("exposes documented banking and Control Panel tools over stdio", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/server.js"],
    cwd: process.cwd(),
    env: process.env,
  });
  const client = new Client({ name: "enable-banking-mcp-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, expectedTools);
    const setupTool = response.tools.find((tool) => tool.name === "setup_enable_banking");
    assert.equal(setupTool?.inputSchema?.properties?.environment?.default, "SANDBOX");
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
    const authorizeBankTool = response.tools.find((tool) => tool.name === "authorize_bank");
    assert.equal(
      authorizeBankTool?.inputSchema?.properties?.access_profile?.default,
      "balances",
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
