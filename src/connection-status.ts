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
        const session = sessionResult.right;
        if (
          typeof session !== "object" ||
          session === null ||
          Array.isArray(session)
        ) {
          return unavailable(input, controlPanelSession, "unknown");
        }
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
      } else if (!isTerminalSessionError(sessionResult.left)) {
        return unavailable(input, controlPanelSession, "unknown");
      } else {
        invalidSessionFound = true;
      }
    }
    if (invalidSessionFound) bankSession = "invalid";
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
      next_action: "The browser step is in progress. The MCP agent should monitor setup_status and resume connect_bank after any required user action; do not ask the user to repeat a tool call.",
    };
  }

  if (input.configuration === "missing") {
    return {
      connection: "setup_required",
      application: "not_configured",
      bank_session: bankSession,
      control_panel_session: controlPanelSession,
      next_action: "Start setup with connect_bank; the MCP agent should run follow-up calls and status checks itself.",
    };
  }

  if (input.configuration !== "configured" || !input.client) {
    return unavailable(input, controlPanelSession, bankSession);
  }

  const applicationResult = yield* Effect.either(input.client.getApplication());
  if (Either.isLeft(applicationResult)) {
    return unavailable(input, controlPanelSession, bankSession);
  }
  const application = applicationResult.right;
  if (
    typeof application !== "object" ||
    application === null ||
    Array.isArray(application) ||
    typeof application.active !== "boolean"
  ) {
    return unavailable(input, controlPanelSession, bankSession);
  }

  const environment = application.environment ?? input.configuredEnvironment;
  const environmentField =
    environment === "PRODUCTION" || environment === "SANDBOX"
      ? { application_environment: environment }
      : {};
  if (!application.active && environment === "PRODUCTION") {
    return {
      connection: "application_activation_required",
      application: "inactive",
      bank_session: bankSession,
      control_panel_session: controlPanelSession,
      ...environmentField,
      next_action:
        "The user must link the application to their own bank in the dashboard; after that, the MCP agent should resume connect_bank itself.",
    };
  }

  if (!application.active) {
    return {
      connection: "bank_authorization_required",
      application: "inactive",
      bank_session: bankSession,
      control_panel_session: controlPanelSession,
      ...environmentField,
      next_action:
        "Use known country/bank context and provider bank lists first; ask only for a genuinely missing choice, then let the MCP agent continue.",
    };
  }

  return {
    connection: "bank_authorization_required",
    application: "active",
    bank_session: bankSession,
    control_panel_session: controlPanelSession,
    ...environmentField,
    next_action:
      "Use known country/bank context and provider bank lists first; ask only for a genuinely missing choice, then let the MCP agent continue.",
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
