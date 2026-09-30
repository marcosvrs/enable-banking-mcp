import { Effect } from "effect";

import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import test from "node:test";
import { resolveBankSelection as resolveBankSelectionEffect } from "../dist/bank-selection.js";

function resolveBankSelection(options) {
  return Effect.runPromise(
    resolveBankSelectionEffect({
      ...options,
      client: {
        ...options.client,
        listBanks: (country) =>
          Effect.tryPromise({
            try: () => options.client.listBanks(country),
            catch: (error) => error,
          }),
      },
    }),
  );
}

async function runSelection({
  capabilities = {},
  applicationCountries,
  country,
  aspspName,
  banks,
  responses,
}) {
  const server = new McpServer({ name: "bank-selection-test", version: "1.0.0" });
  const bankCalls = [];
  const elicitationRequests = [];
  let selection;
  server.registerTool("resolve", { inputSchema: {} }, async () => {
    selection = await resolveBankSelection({
      client: {
        listBanks: async (requestedCountry) => {
          bankCalls.push(requestedCountry);
          return typeof banks === "function"
            ? banks(requestedCountry)
            : banks[requestedCountry ?? "*"] ?? { aspsps: [] };
        },
      },
      mcpServer: server.server,
      applicationCountries,
      country,
      aspspName,
    });
    return { content: [{ type: "text", text: JSON.stringify(selection) }] };
  });

  const client = new Client(
    { name: "bank-selection-test-client", version: "1.0.0" },
    { capabilities },
  );
  if (responses) {
    let responseIndex = 0;
    client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
      elicitationRequests.push(params);
      return responses[responseIndex++];
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    await client.callTool({ name: "resolve", arguments: {} });
    return { selection, bankCalls, elicitationRequests };
  } finally {
    await client.close();
    await server.close();
  }
}

test("unique global bank-name match supplies the country without asking", async () => {
  const { selection, bankCalls, elicitationRequests } = await runSelection({
    applicationCountries: ["FI", "IE"],
    aspspName: "Nordea",
    banks: {
      "*": { aspsps: [{ name: "Nordea", country: "FI" }] },
    },
  });

  assert.deepEqual(selection, {
    status: "selected",
    country: "FI",
    bank: { name: "Nordea", country: "FI" },
  });
  assert.deepEqual(bankCalls, [undefined]);
  assert.deepEqual(elicitationRequests, []);
});

test("country and bank forms resolve sequentially from provider choices", async () => {
  const { selection, bankCalls, elicitationRequests } = await runSelection({
    capabilities: { elicitation: { form: {} } },
    applicationCountries: ["FI", "IE"],
    banks: {
      "*": {
        aspsps: [
          { name: "Nordea", country: "FI" },
          { name: "OP", country: "FI" },
          { name: "AIB", country: "IE" },
        ],
      },
    },
    responses: [
      { action: "accept", content: { country: "FI" } },
      { action: "accept", content: { bank: "1" } },
    ],
  });

  assert.deepEqual(selection, {
    status: "selected",
    country: "FI",
    bank: { name: "OP", country: "FI" },
  });
  assert.deepEqual(bankCalls, [undefined]);
  assert.deepEqual(
    elicitationRequests[0].requestedSchema.properties.country.oneOf.map(
      ({ const: value }) => value,
    ),
    ["FI", "IE"],
  );
  assert.deepEqual(
    elicitationRequests[1].requestedSchema.properties.bank.oneOf,
    [
      { const: "0", title: "Nordea (FI)" },
      { const: "1", title: "OP (FI)" },
    ],
  );
});

test("provider data skips country choice when all available banks share one country", async () => {
  const { selection, bankCalls, elicitationRequests } = await runSelection({
    capabilities: { elicitation: { form: {} } },
    applicationCountries: ["FI", "IE"],
    banks: {
      "*": {
        aspsps: [
          { name: "Nordea", country: "FI" },
          { name: "OP", country: "FI" },
        ],
      },
    },
    responses: [{ action: "accept", content: { bank: "1" } }],
  });

  assert.deepEqual(selection, {
    status: "selected",
    country: "FI",
    bank: { name: "OP", country: "FI" },
  });
  assert.deepEqual(bankCalls, [undefined]);
  assert.equal(elicitationRequests.length, 1);
  assert.equal(
    elicitationRequests[0].requestedSchema.properties.country,
    undefined,
  );
  assert.deepEqual(
    elicitationRequests[0].requestedSchema.properties.bank.oneOf,
    [
      { const: "0", title: "Nordea (FI)" },
      { const: "1", title: "OP (FI)" },
    ],
  );
});

test("a sole provider bank supplies bank and country without elicitation", async () => {
  const { selection, bankCalls, elicitationRequests } = await runSelection({
    applicationCountries: ["FI", "IE"],
    banks: {
      "*": { aspsps: [{ name: "Nordea", country: "FI" }] },
    },
  });

  assert.deepEqual(selection, {
    status: "selected",
    country: "FI",
    bank: { name: "Nordea", country: "FI" },
  });
  assert.deepEqual(bankCalls, [undefined]);
  assert.deepEqual(elicitationRequests, []);
});

test("ambiguous bank names prompt for the exact country match", async () => {
  const { selection, bankCalls, elicitationRequests } = await runSelection({
    capabilities: { elicitation: { form: {} } },
    applicationCountries: ["EE", "FI"],
    aspspName: "Nordea",
    banks: {
      "*": {
        aspsps: [
          { name: "Nordea", country: "FI" },
          { name: "Nordea", country: "EE" },
        ],
      },
    },
    responses: [{ action: "accept", content: { bank: "1" } }],
  });

  assert.deepEqual(selection, {
    status: "selected",
    country: "EE",
    bank: { name: "Nordea", country: "EE" },
  });
  assert.deepEqual(bankCalls, [undefined]);
  assert.deepEqual(
    elicitationRequests[0].requestedSchema.properties.bank.oneOf,
    [
      { const: "0", title: "Nordea (FI)" },
      { const: "1", title: "Nordea (EE)" },
    ],
  );
});

test("provider bank data supplies country choices when application metadata is empty", async () => {
  const { selection, bankCalls, elicitationRequests } = await runSelection({
    capabilities: { elicitation: { form: {} } },
    applicationCountries: [],
    banks: {
      "*": {
        aspsps: [
          { name: "Nordea", country: "FI" },
          { name: "AIB", country: "IE" },
        ],
      },
    },
    responses: [{ action: "accept", content: { country: "IE" } }],
  });

  assert.deepEqual(selection, {
    status: "selected",
    country: "IE",
    bank: { name: "AIB", country: "IE" },
  });
  assert.deepEqual(bankCalls, [undefined]);
  assert.equal(elicitationRequests.length, 1);
});

test("free country entry is normalized when no provider country catalog exists", async () => {
  const { selection, bankCalls, elicitationRequests } = await runSelection({
    capabilities: { elicitation: { form: {} } },
    applicationCountries: [],
    banks: {
      "*": { aspsps: [] },
      FI: { aspsps: [{ name: "Nordea" }] },
    },
    responses: [{ action: "accept", content: { country: "fi" } }],
  });

  assert.deepEqual(selection, {
    status: "selected",
    country: "FI",
    bank: { name: "Nordea", country: "FI" },
  });
  assert.deepEqual(bankCalls, [undefined, "FI"]);
  assert.equal(
    elicitationRequests[0].requestedSchema.properties.country.minLength,
    2,
  );
  assert.equal(
    elicitationRequests[0].requestedSchema.properties.country.maxLength,
    2,
  );
});

test("clients without elicitation receive choices instead of a failed setup", async () => {
  const { selection, bankCalls, elicitationRequests } = await runSelection({
    applicationCountries: ["FI", "IE"],
    banks: {},
  });

  assert.equal(selection.status, "needs_country");
  assert.deepEqual(selection.supported_countries, ["FI", "IE"]);
  assert.deepEqual(bankCalls, [undefined]);
  assert.deepEqual(elicitationRequests, []);
});

test("declining country selection skips country-specific lookup and authorization", async () => {
  const { selection, bankCalls } = await runSelection({
    capabilities: { elicitation: { form: {} } },
    applicationCountries: ["FI", "IE"],
    banks: {},
    responses: [{ action: "decline" }],
  });

  assert.equal(selection.status, "input_declined");
  assert.equal(selection.required_input, "country");
  assert.deepEqual(bankCalls, [undefined]);
});

test("a single supported country and bank need no user choice", async () => {
  const { selection, bankCalls, elicitationRequests } = await runSelection({
    applicationCountries: ["FI"],
    banks: {
      FI: { aspsps: [{ name: "Nordea" }] },
    },
  });

  assert.deepEqual(selection, {
    status: "selected",
    country: "FI",
    bank: { name: "Nordea", country: "FI" },
  });
  assert.deepEqual(bankCalls, ["FI"]);
  assert.deepEqual(elicitationRequests, []);
});

test("unsupported explicit country does not trigger provider bank lookup", async () => {
  const { selection, bankCalls } = await runSelection({
    applicationCountries: ["FI"],
    country: "SE",
    banks: {},
  });

  assert.equal(selection.status, "needs_country");
  assert.deepEqual(selection.supported_countries, ["FI"]);
  assert.deepEqual(bankCalls, []);
});

test("unmatched bank name returns provider options instead of authorizing", async () => {
  const { selection, bankCalls } = await runSelection({
    applicationCountries: ["FI"],
    country: "FI",
    aspspName: "Unknown Bank",
    banks: {
      FI: { aspsps: [{ name: "Nordea" }, { name: "OP" }] },
    },
  });

  assert.equal(selection.status, "needs_bank_selection");
  assert.equal(selection.country, "FI");
  assert.deepEqual(selection.banks, [
    { name: "Nordea", country: "FI" },
    { name: "OP", country: "FI" },
  ]);
  assert.deepEqual(bankCalls, ["FI"]);
});

test("malformed accepted bank input requests a provider-listed choice", async () => {
  const requests = [];
  const selection = await resolveBankSelection({
    client: {
      async listBanks(country) {
        return {
          aspsps: [
            { name: "Nordea", country },
            { name: "OP", country },
          ],
        };
      },
    },
    mcpServer: {
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      async elicitInput(params) {
        requests.push(params);
        return { action: "accept", content: {} };
      },
    },
    applicationCountries: ["FI"],
    country: "FI",
  });

  assert.equal(selection.status, "needs_bank_selection");
  assert.deepEqual(selection.banks, [
    { name: "Nordea", country: "FI" },
    { name: "OP", country: "FI" },
  ]);
  assert.equal(requests.length, 1);
});

test("free-form country rejects values that are not two-letter codes", async () => {
  const bankCalls = [];
  const selection = await resolveBankSelection({
    client: {
      async listBanks(country) {
        bankCalls.push(country);
        return { aspsps: [] };
      },
    },
    mcpServer: {
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      async elicitInput() {
        return { action: "accept", content: { country: "FIN" } };
      },
    },
    applicationCountries: [],
  });

  assert.equal(selection.status, "needs_country");
  assert.deepEqual(selection.supported_countries, []);
  assert.deepEqual(bankCalls, [undefined]);
});
test("ambiguous global bank match can be declined without choosing a country", async () => {
  const { selection, bankCalls } = await runSelection({
    capabilities: { elicitation: { form: {} } },
    applicationCountries: ["FI", "IE"],
    aspspName: "Shared Bank",
    banks: {
      "*": {
        aspsps: [
          { name: "Shared Bank", country: "FI" },
          { name: "Shared Bank", country: "IE" },
        ],
      },
    },
    responses: [{ action: "decline" }],
  });

  assert.equal(selection.status, "input_declined");
  assert.equal(selection.required_input, "bank");
  assert.deepEqual(selection.banks, [
    { name: "Shared Bank", country: "FI" },
    { name: "Shared Bank", country: "IE" },
  ]);
  assert.deepEqual(bankCalls, [undefined]);
});

test("invalid explicit country is rejected before provider bank lookup", async () => {
  const bankCalls = [];
  await assert.rejects(
    resolveBankSelection({
      client: {
        async listBanks(country) {
          bankCalls.push(country);
          return { aspsps: [] };
        },
      },
      mcpServer: {
        getClientCapabilities: () => undefined,
      },
      applicationCountries: [],
      country: "FIN",
    }),
    /two-letter ISO 3166-1 code/,
  );
  assert.deepEqual(bankCalls, []);
});

test("provider bank catalog ignores malformed rows and deduplicates names per country", async () => {
  const { selection, bankCalls } = await runSelection({
    applicationCountries: [],
    aspspName: "Nordea",
    country: "FI",
    banks: {
      FI: {
        aspsps: [
          null,
          {},
          { name: " " },
          { name: "Nordea" },
          { name: " nordea ", country: "fi" },
          { name: "OP", country: "IE" },
        ],
      },
    },
  });

  assert.deepEqual(selection, {
    status: "selected",
    country: "FI",
    bank: { name: "Nordea", country: "FI" },
  });
  assert.deepEqual(bankCalls, ["FI"]);
});
test("unmatched requested bank can be replaced by a provider-listed selection", async () => {
  const { selection, bankCalls, elicitationRequests } = await runSelection({
    capabilities: { elicitation: { form: {} } },
    applicationCountries: ["FI"],
    country: "FI",
    aspspName: "Old Bank Name",
    banks: {
      FI: { aspsps: [{ name: "Nordea" }, { name: "OP" }] },
    },
    responses: [{ action: "accept", content: { bank: "1" } }],
  });

  assert.deepEqual(selection, {
    status: "selected",
    country: "FI",
    bank: { name: "OP", country: "FI" },
  });
  assert.deepEqual(bankCalls, ["FI"]);
  assert.equal(elicitationRequests[0].requestedSchema.properties.bank.oneOf[1].const, "1");
});

test("declining free-form country entry returns the input requirement", async () => {
  const { selection, bankCalls } = await runSelection({
    capabilities: { elicitation: { form: {} } },
    applicationCountries: [],
    banks: { "*": { aspsps: [] } },
    responses: [{ action: "cancel" }],
  });

  assert.equal(selection.status, "input_declined");
  assert.equal(selection.required_input, "country");
  assert.deepEqual(selection.supported_countries, []);
  assert.deepEqual(bankCalls, [undefined]);
});
