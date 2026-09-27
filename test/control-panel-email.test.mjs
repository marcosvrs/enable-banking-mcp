import assert from "node:assert/strict";
import test from "node:test";
import { resolveControlPanelEmailInput } from "../dist/control-panel-email.js";

function peer(capabilities, response) {
  const requests = [];
  return {
    requests,
    server: {
      getClientCapabilities: () => capabilities,
      elicitInput: async (params) => {
        requests.push(params);
        return response;
      },
    },
  };
}

test("local or stored email avoids elicitation", async () => {
  const mcp = peer(undefined);
  const fromEnvironment = await resolveControlPanelEmailInput(
    mcp.server,
    "ENABLE_BANKING_CONTROL_PANEL_EMAIL",
    "local@example.com",
    "stored@example.com",
  );
  const fromKeychain = await resolveControlPanelEmailInput(
    mcp.server,
    "ENABLE_BANKING_CONTROL_PANEL_EMAIL",
    undefined,
    "stored@example.com",
  );

  assert.deepEqual(fromEnvironment, {
    status: "ready",
    email: "local@example.com",
  });
  assert.deepEqual(fromKeychain, {
    status: "ready",
    email: "stored@example.com",
  });
  assert.equal(mcp.requests.length, 0);
});

test("missing local identity asks only for a Control Panel email", async () => {
  const mcp = peer(
    { elicitation: { form: {} } },
    { action: "accept", content: { email: "user@example.com" } },
  );
  const result = await resolveControlPanelEmailInput(
    mcp.server,
    "ENABLE_BANKING_CONTROL_PANEL_EMAIL",
  );

  assert.deepEqual(result, { status: "ready", email: "user@example.com" });
  assert.equal(mcp.requests.length, 1);
  assert.equal(mcp.requests[0].requestedSchema.properties.email.format, "email");
  assert.match(mcp.requests[0].message, /does not identify your bank/);
});

test("declined email is not returned or used to start setup", async () => {
  const mcp = peer(
    { elicitation: { form: {} } },
    { action: "decline" },
  );
  const result = await resolveControlPanelEmailInput(
    mcp.server,
    "ENABLE_BANKING_CONTROL_PANEL_EMAIL",
  );

  assert.equal(result.status, "input_declined");
  assert.equal(JSON.stringify(result).includes("user@example.com"), false);
});

test("unsupported clients receive local configuration instructions", async () => {
  const mcp = peer(undefined);
  const result = await resolveControlPanelEmailInput(
    mcp.server,
    "ENABLE_BANKING_CONTROL_PANEL_EMAIL",
  );

  assert.equal(result.status, "needs_control_panel_email");
  assert.equal(result.required_input, "ENABLE_BANKING_CONTROL_PANEL_EMAIL");
  assert.equal(mcp.requests.length, 0);
});

test("invalid elicited email is rejected without returning the value", async () => {
  const mcp = peer(
    { elicitation: { form: {} } },
    { action: "accept", content: { email: "not-an-email" } },
  );
  const result = await resolveControlPanelEmailInput(
    mcp.server,
    "ENABLE_BANKING_CONTROL_PANEL_EMAIL",
  );

  assert.equal(result.status, "invalid_input");
  assert.equal(JSON.stringify(result).includes("not-an-email"), false);
});

test("invalid local email takes precedence over a stored identity and is rejected", async () => {
  const mcp = peer(undefined);

  await assert.rejects(
    resolveControlPanelEmailInput(
      mcp.server,
      "ENABLE_BANKING_CONTROL_PANEL_EMAIL",
      "not-an-email",
      "stored@example.com",
    ),
    /must be a valid local email/,
  );
  assert.equal(mcp.requests.length, 0);
});

test("accepted email is trimmed before setup", async () => {
  const mcp = peer(
    { elicitation: { form: {} } },
    { action: "accept", content: { email: "  user@example.com  " } },
  );
  const result = await resolveControlPanelEmailInput(
    mcp.server,
    "ENABLE_BANKING_CONTROL_PANEL_EMAIL",
  );

  assert.deepEqual(result, { status: "ready", email: "user@example.com" });
});

test("accepted email response without a string field is rejected", async () => {
  const mcp = peer(
    { elicitation: { form: {} } },
    { action: "accept", content: {} },
  );
  const result = await resolveControlPanelEmailInput(
    mcp.server,
    "ENABLE_BANKING_CONTROL_PANEL_EMAIL",
  );

  assert.deepEqual(result, {
    status: "invalid_input",
    required_input: "Control Panel email",
    message: "A valid Control Panel email is required; no setup started.",
  });
});
