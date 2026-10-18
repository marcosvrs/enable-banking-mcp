import { Effect, Either } from "effect";

import type { ApplicationEnvironment } from "./application-store.js";
import {
  isTerminalSessionError,
  type EnableBankingClient,
} from "./enable-banking.js";
import type { ControlPanelAuth } from "./control-panel.js";

export type ConnectionState =
  | "connected"
  | "setup_required"
  | "application_activation_required"
  | "bank_authorization_required"
  | "awaiting_user"
  | "status_unavailable";

export interface ConnectionStatus {
  connection: ConnectionState;
  application: "configured" | "active" | "inactive" | "not_configured" | "unknown";
  bank_session: "valid" | "missing" | "invalid" | "unknown";
  control_panel_session: "not_stored" | "stored" | "expired";
  application_environment?: ApplicationEnvironment;
  phase?: string;
  next_action: string;
}

export interface ConnectionStatusInput {
  configuration: "configured" | "missing" | "invalid";
  client?: Pick<EnableBankingClient, "getApplication" | "getSession">;
  sessionIds: string[];
  controlPanelAuth?: Pick<ControlPanelAuth, "expiresAt">;
  configuredEnvironment?: ApplicationEnvironment;
  pendingPhase?: string;
  now?: number;
}

export function inspectConnectionStatus(
  input: ConnectionStatusInput,
): Effect.Effect<ConnectionStatus, unknown> {
  return Effect.gen(function* () {
  const controlPanelSession = !input.controlPanelAuth
    ? "not_stored"
    : input.controlPanelAuth.expiresAt !== undefined &&
        input.controlPanelAuth.expiresAt <= (input.now ?? Date.now())
      ? "expired"
      : "stored";
  let bankSession: ConnectionStatus["bank_session"] =
    input.sessionIds.length > 0 ? "unknown" : "missing";

  if (input.sessionIds.length > 0) {
    if (!input.client) {
      return unavailable(input, controlPanelSession, "unknown");
    }

    let invalidSessionFound = false;
    for (const sessionId of input.sessionIds) {
      const sessionResult = yield* Effect.either(input.client.getSession(sessionId));
      if (Either.isRight(sessionResult)) {
        const session: unknown = sessionResult.right;
        if (
          typeof session !== "object" ||
          session === null ||
          Array.isArray(session)
        ) {
          return unavailable(input, controlPanelSession, "unknown");
        }
        bankSession = "valid";
        break;
      } else if (!isTerminalSessionError(sessionResult.left)) {
        return unavailable(input, controlPanelSession, "unknown");
      } else {
        invalidSessionFound = true;
      }
    }
    if (invalidSessionFound && bankSession !== "valid") bankSession = "invalid";
  }

  if (input.pendingPhase) {
    return {
      connection: "awaiting_user",
      application:
        input.configuration === "configured"
          ? "configured"
          : input.configuration === "missing"
            ? "not_configured"
            : "unknown",
      bank_session: bankSession,
      control_panel_session: controlPanelSession,
      ...(input.configuredEnvironment
        ? { application_environment: input.configuredEnvironment }
        : {}),
      phase: input.pendingPhase,
      next_action: "The active connect_bank request monitors this provider step and continues automatically. Complete any required interaction in the opened browser; do not rerun a tool.",
    };
  }

  if (bankSession === "valid") {
    return {
      connection: "connected",
      application: "configured",
      bank_session: "valid",
      control_panel_session: controlPanelSession,
      ...(input.configuredEnvironment
        ? { application_environment: input.configuredEnvironment }
        : {}),
      next_action: "No action required; the provider accepts the stored bank session.",
    };
  }

  if (input.configuration === "missing") {
    return {
      connection: "setup_required",
      application: "not_configured",
      bank_session: bankSession,
      control_panel_session: controlPanelSession,
      next_action: "Run connect_bank to open the MCP-owned onboarding form and start the guided workflow.",
    };
  }

  if (input.configuration !== "configured" || !input.client) {
    return unavailable(input, controlPanelSession, bankSession);
  }

  const applicationResult = yield* Effect.either(input.client.getApplication());
  if (Either.isLeft(applicationResult)) {
    return unavailable(input, controlPanelSession, bankSession);
  }
  const application: unknown = applicationResult.right;
  const applicationRecord =
    typeof application === "object" &&
    application !== null &&
    !Array.isArray(application)
      ? (application as Record<string, unknown>)
      : undefined;
  if (
    !applicationRecord ||
    typeof applicationRecord.active !== "boolean"
  ) {
    return unavailable(input, controlPanelSession, bankSession);
  }

  const isActive = applicationRecord.active;
  const providerEnvironment = applicationRecord.environment;
  const environment =
    providerEnvironment === "PRODUCTION" || providerEnvironment === "SANDBOX"
      ? providerEnvironment
      : input.configuredEnvironment;
  const environmentField =
    environment === undefined ? {} : { application_environment: environment };
  if (!isActive && environment === "PRODUCTION") {
    return {
      connection: "application_activation_required",
      application: "inactive",
      bank_session: bankSession,
      control_panel_session: controlPanelSession,
      ...environmentField,
      next_action:
        "Complete Production activation by linking an account in the Enable Banking dashboard, then call connect_bank to continue.",
    };
  }

  if (!isActive) {
    return {
      connection: "bank_authorization_required",
      application: "inactive",
      bank_session: bankSession,
      control_panel_session: controlPanelSession,
      ...environmentField,
      next_action:
        "Run connect_bank; it collects the bank country and bank together through MCP form elicitation.",
    };
  }

  return {
    connection: "bank_authorization_required",
    application: "active",
    bank_session: bankSession,
    control_panel_session: controlPanelSession,
    ...environmentField,
    next_action:
      "Run connect_bank; it collects the bank country and bank together through MCP form elicitation.",
  };
  });
}


function unavailable(
  input: ConnectionStatusInput,
  controlPanelSession: ConnectionStatus["control_panel_session"],
  bankSession: ConnectionStatus["bank_session"],
): ConnectionStatus {
  return {
    connection: "status_unavailable",
    application:
      input.configuration === "configured"
        ? "configured"
        : input.configuration === "missing"
          ? "not_configured"
          : "unknown",
    bank_session: bankSession,
    control_panel_session: controlPanelSession,
    ...(input.configuredEnvironment
      ? { application_environment: input.configuredEnvironment }
      : {}),
    next_action:
      "Enable Banking status could not be verified. Retry later; do not treat this result as proof of a disconnected bank session.",
  };
}
