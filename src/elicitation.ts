import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ElicitResultSchema,
  type ElicitRequestFormParams,
} from "@modelcontextprotocol/sdk/types.js";

type FormFieldSchema =
  ElicitRequestFormParams["requestedSchema"]["properties"][string];

type FormValueResult =
  | { status: "unsupported" }
  | { status: "declined"; action: "decline" | "cancel" }
  | { status: "invalid" }
  | { status: "accepted"; value: string };

export async function elicitFormString(
  server: McpServer["server"],
  field: string,
  message: string,
  schema: FormFieldSchema,
): Promise<FormValueResult> {
  const capabilities = server.getClientCapabilities()?.elicitation;
  const legacyFormSupport =
    capabilities !== undefined && Object.keys(capabilities).length === 0;
  if (!capabilities || (!capabilities.form && !legacyFormSupport)) {
    return { status: "unsupported" };
  }

  const params = {
    mode: "form",
    message,
    requestedSchema: {
      type: "object",
      properties: { [field]: schema },
      required: [field],
    },
  } satisfies ElicitRequestFormParams;
  const result = capabilities.form
    ? await server.elicitInput(params)
    : await server.request(
        { method: "elicitation/create", params },
        ElicitResultSchema,
      );

  if (result.action !== "accept") {
    return { status: "declined", action: result.action };
  }
  const value = result.content?.[field];
  return typeof value === "string"
    ? { status: "accepted", value }
    : { status: "invalid" };
}
