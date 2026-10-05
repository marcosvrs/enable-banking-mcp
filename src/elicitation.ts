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
  | { status: "accepted"; value: Record<string, string> };
type FormStringResult =
  | { status: "unsupported" }
  | { status: "declined"; action: "decline" | "cancel" }
  | { status: "invalid" }
  | { status: "accepted"; value: string };


const FORM_ELICITATION_TIMEOUT_MS = 10 * 60 * 1000;

export function elicitForm(
  server: McpServer["server"],
  message: string,
  properties: Record<string, FormFieldSchema>,
  required: string[],
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
        properties,
        required,
      },
    } satisfies ElicitRequestFormParams;
    const requestOptions = { timeout: FORM_ELICITATION_TIMEOUT_MS };
    const result = yield* Effect.tryPromise({
      try: () =>
        capabilities.form
          ? server.elicitInput(params, requestOptions)
          : server.request(
              { method: "elicitation/create", params },
              ElicitResultSchema,
              requestOptions,
            ),
      catch: (error) => error,
    });

    if (result.action !== "accept") {
      return { status: "declined", action: result.action } as const;
    }
    const content = result.content;
    if (
      !content ||
      required.some((field) => typeof content[field] !== "string")
    ) {
      return { status: "invalid" } as const;
    }
    return {
      status: "accepted",
      value: Object.fromEntries(
        Object.entries(content).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    } as const;
  });
}

export function elicitFormString(
  server: McpServer["server"],
  field: string,
  message: string,
  schema: FormFieldSchema,
): Effect.Effect<FormStringResult, unknown> {
  return Effect.gen(function* () {
    const result = yield* elicitForm(server, message, { [field]: schema }, [field]);
    if (result.status !== "accepted") return result;
    return typeof result.value[field] === "string"
      ? { status: "accepted", value: result.value[field] } as const
      : { status: "invalid" } as const;
  });
}
