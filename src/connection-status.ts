import { Effect, Either } from "effect";

import type { ApplicationEnvironment } from "./application-store.js";
import {
  isTerminalSessionError,
  type EnableBankingClient,
} from "./enable-banking.js";
import type { OnboardingSnapshot } from "./onboarding-state.js";
import type { ControlPanelAuth } from "./control-panel.js";

export type ConnectionState =
  | "connected"
  | "setup_required"
  | "application_activation_required"
  | "bank_authorization_required"
  | "onboarding_active"
  | "awaiting_user"
  | "status_unavailable";

export interface ConnectionStatus {
  connection: ConnectionState;
  application: "configured" | "active" | "inactive" | "not_configured" | "unknown";
  bank_session: "valid" | "missing" | "invalid" | "unknown";
  control_panel_session: "not_stored" | "stored" | "expired";
  application_environment?: ApplicationEnvironment;
  phase?: string;
  flow_id?: string;
  onboarding_status?: OnboardingSnapshot["status"];
  next_action: string;
}

export interface ConnectionStatusInput {
  configuration: "configured" | "missing" | "invalid";
  client?: Pick<EnableBankingClient, "getApplication" | "getSession">;
  sessionIds: string[];
  controlPanelAuth?: Pick<ControlPanelAuth, "expiresAt">;
  configuredEnvironment?: ApplicationEnvironment;
  pendingPhase?: string;
  pendingAction?: string;
  onboarding?: OnboardingSnapshot;
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

    if (input.onboarding?.status === "running") {
      return {
        connection: "onboarding_active",
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
        flow_id: input.onboarding.flow_id,
        onboarding_status: input.onboarding.status,
        phase: input.onboarding.phase,
        next_action:
          input.pendingAction ??
          "Guided onboarding is active; check connection_status for progress.",
      };
    }

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
          next_action:
            "No action required; use connect_bank or account-specific tools to retrieve balances.",
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
      ...(input.onboarding
        ? {
            flow_id: input.onboarding.flow_id,
            onboarding_status: input.onboarding.status,
          }
        : {}),
      phase: input.pendingPhase,
      next_action:
        input.pendingAction ??
        "An onboarding request is active. Complete the required browser step and check connection_status before resuming.",
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
        "Link an account to the stored Production application in the Enable Banking dashboard, then call connect_bank to continue. No new application is needed.",
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
        environment === "PRODUCTION"
          ? "Run connect_bank; it detects the linked bank from the application's Control Panel account links."
          : "Run connect_bank; Sandbox connections require the bank country and name.",
    };
  }

  return {
    connection: "bank_authorization_required",
    application: "active",
    bank_session: bankSession,
    control_panel_session: controlPanelSession,
    ...environmentField,
    ...(input.onboarding?.status === "failed"
      ? {
          flow_id: input.onboarding.flow_id,
          onboarding_status: input.onboarding.status,
          phase: input.onboarding.phase,
          next_action:
            input.pendingAction ??
            "The previous onboarding flow failed; call connect_bank to retry from stored state.",
        }
      : {
          next_action:
            environment === "PRODUCTION"
              ? "Run connect_bank; it detects the linked bank from the application's Control Panel account links."
              : "Run connect_bank; Sandbox connections require the bank country and name.",
        }),
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
