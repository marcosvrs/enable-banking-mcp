import { Effect } from "effect";

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

export function elicitFormString(
  server: McpServer["server"],
  field: string,
  message: string,
  schema: FormFieldSchema,
): Effect.Effect<FormValueResult, unknown> {
  return Effect.gen(function* () {
    const capabilities = server.getClientCapabilities()?.elicitation;
    const legacyFormSupport =
      capabilities !== undefined && Object.keys(capabilities).length === 0;
    if (!capabilities || (!capabilities.form && !legacyFormSupport)) {
      return { status: "unsupported" } as const;
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
    const result = yield* Effect.tryPromise({
      try: () =>
        capabilities.form
          ? server.elicitInput(params)
          : server.request(
              { method: "elicitation/create", params },
              ElicitResultSchema,
            ),
      catch: (error) => error,
    });

    if (result.action !== "accept") {
      return { status: "declined", action: result.action } as const;
    }
    const value = result.content?.[field];
    return typeof value === "string"
      ? { status: "accepted", value } as const
      : { status: "invalid" } as const;
  });
}
