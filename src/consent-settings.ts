import { Effect } from "effect";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { parseValidUntil, type AccessProfile } from "./authorization.js";
import { elicitForm } from "./elicitation.js";

export interface ConsentSettings {
  accessProfile: AccessProfile;
  validUntil?: string;
}

export type ConsentSettingsResult =
  | { status: "accepted"; settings: ConsentSettings }
  | { status: "cancelled" | "failed"; message: string };

export function resolveConsentSettings(
  server: McpServer["server"],
  defaults: ConsentSettings,
): Effect.Effect<ConsentSettingsResult, unknown> {
  const properties = {
    access_profile: {
      type: "string" as const,
      title: "Bank account data",
      description:
        "Choose balances and transaction history (default), or balances only. The bank may grant a narrower scope.",
      enum: ["balances_and_transactions", "balances"],
      default: defaults.accessProfile,
    },
    valid_until: {
      type: "string" as const,
      title: "Consent expiration",
      description:
        "Optional future RFC3339 date-time. Leave blank for the 30-day default from bank authorization.",
      format: "date-time" as const,
      ...(defaults.validUntil ? { default: defaults.validUntil } : {}),
    },
  };

  return Effect.gen(function* () {
    const elicited = yield* elicitForm(
      server,
      "Review the bank data access and consent expiration before authorization.",
      properties,
      ["access_profile"],
    );
    if (elicited.status === "unsupported") {
      return { status: "accepted", settings: defaults } as const;
    }
    if (elicited.status === "declined") {
      return {
        status: "cancelled",
        message: "Consent settings were cancelled; bank authorization was not started.",
      } as const;
    }
    if (elicited.status === "invalid") {
      return {
        status: "failed",
        message: "The consent settings form returned incomplete data; authorization was not started.",
      } as const;
    }

    const accessProfile =
      elicited.value.access_profile ?? defaults.accessProfile;
    if (
      accessProfile !== "balances" &&
      accessProfile !== "balances_and_transactions"
    ) {
      return {
        status: "failed",
        message: "Choose a supported bank account data access profile.",
      } as const;
    }

    const enteredExpiry = elicited.value.valid_until?.trim();
    const validUntil = enteredExpiry || defaults.validUntil;
    if (validUntil !== undefined) {
      try {
        parseValidUntil(validUntil);
      } catch {
        return {
          status: "failed",
          message: "Consent expiration must be a future RFC3339 date-time.",
        } as const;
      }
    }

    return {
      status: "accepted",
      settings: {
        accessProfile,
        ...(validUntil ? { validUntil } : {}),
      },
    } as const;
  });
}
