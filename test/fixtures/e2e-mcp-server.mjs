#!/usr/bin/env node

import { appendFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const marker = process.env.MCP_E2E_MARKER?.trim() || "MCP_E2E_OK";
const callLogPath = process.env.MCP_E2E_CALL_LOG?.trim();
const delayMs = Number.parseInt(process.env.MCP_E2E_DELAY_MS || "0", 10);

if (process.env.MCP_E2E_FAIL_STARTUP === "1") {
  throw new Error("MCP_E2E_STARTUP_FAILURE");
}

const server = new McpServer(
  {
    name: "enable-banking-e2e-fixture",
    version: "1.0.0",
  },
  {
    instructions:
      "This deterministic test server exposes only fixture tools. Use e2e_echo when explicitly requested. Never infer or invent account data.",
  },
);

async function recordCall(call) {
  if (!callLogPath) return;
  await appendFile(callLogPath, `${JSON.stringify(call)}\n`, "utf8");
}

async function waitIfConfigured() {
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

server.registerTool(
  "e2e_echo",
  {
    title: "E2E echo",
    description:
      "Deterministic test tool. Echo the supplied value and return the fixed MCP_E2E_OK marker. Call only when the user explicitly requests the fixture echo.",
    inputSchema: {
      value: z.string().min(1).describe("Value to echo exactly"),
      request_id: z
        .string()
        .min(1)
        .optional()
        .describe("Optional correlation identifier for the test"),
    },
    outputSchema: {
      marker: z.string(),
      value: z.string(),
      request_id: z.string().optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ value, request_id }) => {
    await recordCall({
      tool: "e2e_echo",
      arguments: { value, ...(request_id ? { request_id } : {}) },
    });
    await waitIfConfigured();
    const result = {
      marker,
      value,
      ...(request_id ? { request_id } : {}),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "e2e_fail",
  {
    title: "E2E failure",
    description:
      "Deterministic test tool that returns an MCP tool error for client error-propagation tests.",
    inputSchema: {
      message: z.string().min(1).default("MCP_E2E_ERROR"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ message }) => {
    await recordCall({ tool: "e2e_fail", arguments: { message } });
    return {
      content: [{ type: "text", text: JSON.stringify({ message }) }],
      isError: true,
    };
  },
);

await server.connect(new StdioServerTransport());
