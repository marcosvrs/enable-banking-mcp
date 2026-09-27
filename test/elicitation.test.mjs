import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import test from "node:test";
import { elicitFormString } from "../dist/elicitation.js";

async function runPrompt(
  capabilities,
  submit,
  schema = {
    type: "string",
    title: "Value",
    oneOf: [
      { const: "first", title: "First option" },
      { const: "second", title: "Second option" },
    ],
  },
) {
  const server = new McpServer({ name: "elicitation-test", version: "1.0.0" });
  let result;
  server.registerTool("prompt", { inputSchema: {} }, async () => {
    result = await elicitFormString(server.server, "value", "Choose or enter a value", schema);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  const client = new Client(
    { name: "elicitation-test-client", version: "1.0.0" },
    { capabilities },
  );
  let requested;
  if (submit) {
    client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
      requested = params;
      return submit(params);
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    await client.callTool({ name: "prompt", arguments: {} });
    return { result, requested };
  } finally {
    await client.close();
    await server.close();
  }
}

test("form elicitation sends a titled choice and returns the user's selection", async () => {
  const { result, requested } = await runPrompt(
    { elicitation: { form: {} } },
    () => ({ action: "accept", content: { value: "second" } }),
  );

  assert.deepEqual(result, { status: "accepted", value: "second" });
  assert.equal(requested.mode, "form");
  assert.deepEqual(requested.requestedSchema.required, ["value"]);
  assert.deepEqual(requested.requestedSchema.properties.value.oneOf, [
    { const: "first", title: "First option" },
    { const: "second", title: "Second option" },
  ]);
});

test("empty legacy elicitation capability supports form requests", async () => {
  const { result } = await runPrompt(
    { elicitation: {} },
    () => ({ action: "accept", content: { value: "first" } }),
  );

  assert.deepEqual(result, { status: "accepted", value: "first" });
});

test("declined elicitation stops without selecting a value", async () => {
  const { result } = await runPrompt(
    { elicitation: { form: {} } },
    () => ({ action: "cancel" }),
  );

  assert.deepEqual(result, { status: "declined", action: "cancel" });
});

test("clients without elicitation receive a safe unsupported result", async () => {
  const { result, requested } = await runPrompt({}, undefined);

  assert.deepEqual(result, { status: "unsupported" });
  assert.equal(requested, undefined);
});

test("form elicitation accepts a free-form email field", async () => {
  const { result, requested } = await runPrompt(
    { elicitation: { form: {} } },
    () => ({ action: "accept", content: { value: "user@example.com" } }),
    { type: "string", title: "Control Panel email", format: "email" },
  );

  assert.deepEqual(result, { status: "accepted", value: "user@example.com" });
  assert.equal(
    requested.requestedSchema.properties.value.format,
    "email",
  );
});

test("URL elicitation support alone does not claim form input support", async () => {
  const { result, requested } = await runPrompt(
    { elicitation: { url: {} } },
    undefined,
  );

  assert.deepEqual(result, { status: "unsupported" });
  assert.equal(requested, undefined);
});
test("legacy elicitation capability uses the protocol request and rejects non-string content", async () => {
  let sentRequest;
  const result = await elicitFormString(
    {
      getClientCapabilities: () => ({ elicitation: {} }),
      async request(request, schema) {
        sentRequest = { request, schema };
        return { action: "accept", content: { value: 42 } };
      },
    },
    "value",
    "Choose a value",
    { type: "string", title: "Value" },
  );

  assert.deepEqual(result, { status: "invalid" });
  assert.equal(sentRequest.request.method, "elicitation/create");
  assert.equal(sentRequest.request.params.mode, "form");
  assert.deepEqual(sentRequest.request.params.requestedSchema.required, ["value"]);
});
