import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import test from "node:test";

const expectedTools = [
  "authorize_bank",
  "control_panel_authenticate",
  "control_panel_logout",
  "control_panel_request",
  "control_panel_status",
  "create_payment",
  "create_session",
  "delete_payment",
  "delete_session",
  "get_account_balances",
  "get_account_details",
  "get_account_transactions",
  "get_application",
  "get_health",
  "get_payment",
  "get_payment_transaction",
  "get_session",
  "get_transaction_details",
  "list_accounts",
  "list_banks",
  "setup_enable_banking",
  "setup_status",
  "start_authorization",
  "submit_payment",
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
    const authorizeBankTool = response.tools.find((tool) => tool.name === "authorize_bank");
    const authorizeBankPsuType =
      authorizeBankTool?.inputSchema?.properties?.psu_type;
    assert.equal(authorizeBankPsuType?.default, undefined);
    assert.ok(!authorizeBankTool?.inputSchema?.required?.includes("psu_type"));
    const startTool = response.tools.find((tool) => tool.name === "start_authorization");
    const accessSchema =
      startTool?.inputSchema?.properties?.request?.properties?.access;
    assert.equal(accessSchema?.properties?.balances?.default, true);
    assert.equal(accessSchema?.properties?.transactions?.default, true);
    assert.equal(accessSchema?.properties?.valid_until?.format, "date-time");
    assert.ok(!accessSchema?.required?.includes("balances"));
    assert.ok(!accessSchema?.required?.includes("transactions"));
    const listBanksTool = response.tools.find((tool) => tool.name === "list_banks");
    assert.equal(listBanksTool?.inputSchema?.properties?.country?.default, undefined);
    assert.ok(!listBanksTool?.inputSchema?.required?.includes("country"));
    const paymentTool = response.tools.find((tool) => tool.name === "create_payment");
    assert.deepEqual(
      paymentTool?.inputSchema?.properties?.request?.required?.sort(),
      ["aspsp", "payment_request", "payment_type", "psu_type", "redirect_url", "state"],
    );
  } finally {
    await client.close();
  }
});
