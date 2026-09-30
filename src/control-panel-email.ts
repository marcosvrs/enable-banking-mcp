import { Effect } from "effect";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { elicitFormString } from "./elicitation.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ControlPanelEmailResolution =
  | { status: "ready"; email: string }
  | {
      status: "input_declined";
      required_input: "Control Panel email";
      message: string;
    }
  | {
      status: "invalid_input";
      required_input: "Control Panel email";
      message: string;
    }
  | {
      status: "needs_control_panel_email";
      required_input: string;
      message: string;
    };

export function resolveControlPanelEmailInput(
  mcpServer: McpServer["server"],
  environmentName: string,
  environmentEmail?: string,
  storedEmail?: string,
): Effect.Effect<ControlPanelEmailResolution, unknown> {
  return Effect.gen(function* () {
    const value = environmentEmail?.trim() || storedEmail?.trim();
    if (value) {
      if (!EMAIL_PATTERN.test(value)) {
        return yield* Effect.fail(
          new Error(
            `${environmentName} must be a valid local email or a Control Panel identity must already exist in Keychain`,
          ),
        );
      }
      return { status: "ready", email: value } as const;
    }

    const result = yield* elicitFormString(
      mcpServer,
      "email",
      "Enter the email for your Enable Banking Control Panel account. It is used for Control Panel sign-in and as the data-protection contact on a Production application; it does not identify your bank or retrieve account information. You can decline.",
      {
        type: "string",
        title: "Control Panel email",
        description:
          "Used to request a one-time sign-in link and, in Production, as the application's data-protection contact. Never enter a password or bank credentials.",
        format: "email",
      },
    );
    if (result.status === "accepted") {
      const email = result.value.trim();
      return EMAIL_PATTERN.test(email)
        ? { status: "ready", email } as const
        : {
            status: "invalid_input",
            required_input: "Control Panel email",
            message: "A valid Control Panel email is required; no setup started.",
          } as const;
    }
    if (result.status === "declined") {
      return {
        status: "input_declined",
        required_input: "Control Panel email",
        message:
          "No setup started. Resume when ready or configure the local email environment value.",
      } as const;
    }
    if (result.status === "invalid") {
      return {
        status: "invalid_input",
        required_input: "Control Panel email",
        message: "A valid Control Panel email is required; no setup started.",
      } as const;
    }
    return {
      status: "needs_control_panel_email",
      required_input: environmentName,
      message: `No Control Panel identity is stored and this MCP client cannot collect a form response. Set ${environmentName} in the local MCP server environment and retry.`,
    } as const;
  });
}
