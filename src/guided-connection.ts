import { Effect } from "effect";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_REDIRECT_URL } from "./authorization.js";
import type { AccessProfile, BankAuthorizationFlow } from "./authorization.js";
import type { ApplicationStore } from "./application-store.js";
import { EnableBankingClient } from "./enable-banking.js";
import { resolveBankSelection } from "./bank-selection.js";
import { elicitForm } from "./elicitation.js";
import { resolveConsentSettings } from "./consent-settings.js";
import { recoverConfiguredSession } from "./session-recovery.js";
import type { SessionStore } from "./session-store.js";
import {
  DEFAULT_PRODUCTION_DESCRIPTION,
  DEFAULT_PRODUCTION_PRIVACY_URL,
  DEFAULT_PRODUCTION_TERMS_URL,
} from "./setup.js";
import type { ApplicationSetupFlow } from "./setup.js";

import type { OnboardingPhase } from "./onboarding-state.js";
type EnableBankingCredentials = { appId: string; privateKey: string };

const APPLICATIONS_URL = "https://enablebanking.com/cp/applications";

export type ConnectBankOptions = {
  appName: string;
  environment: "PRODUCTION" | "SANDBOX";
  accessProfile: AccessProfile;
  validUntil?: string;
};

export interface GuidedConnectionDependencies {
  applicationStore: Pick<ApplicationStore, "get">;
  sessionStore: Pick<SessionStore, "get" | "clear">;
  setupFlow: Pick<
    ApplicationSetupFlow,
    "status" | "startGuided" | "findLinkedBank"
  >;
  authorizationFlow: Pick<BankAuthorizationFlow, "status" | "start">;
  assertNoEnvironmentCredentials(): void;
  getEnvironmentSessionId(): string | undefined;
  clearEnvironmentSession(sessionId: string | undefined): void;
  readAuthorizedBalances(): Effect.Effect<Record<string, unknown>, unknown>;
  resolveCredentials(): Effect.Effect<EnableBankingCredentials, unknown>;
  createBankClient(credentials: EnableBankingCredentials): EnableBankingClient;
  openBrowser(url: string): void;
  setProgress?(phase: OnboardingPhase): void;
  mcpServer: McpServer["server"];
}
export function connectBank(
  options: ConnectBankOptions,
  dependencies: GuidedConnectionDependencies,
): Effect.Effect<unknown, unknown> {
  return Effect.gen(function* () {
    yield* Effect.sync(() => dependencies.setProgress?.("checking_session"));
    const [storedSession, application] = yield* Effect.all([
      dependencies.sessionStore.get(),
      dependencies.applicationStore.get(),
    ]);
    const environmentSessionId = dependencies.getEnvironmentSessionId();
    const connected = yield* recoverConfiguredSession<Record<string, unknown>>({
      storedSession,
      environmentSessionId,
      read: () =>
        Effect.gen(function* () {
          yield* Effect.sync(() => dependencies.setProgress?.("balance_retrieval"));
          return {
            status: "connected",
            ...(yield* dependencies.readAuthorizedBalances()),
          };
        }),
      clearStoredSession: () => dependencies.sessionStore.clear(),
      clearEnvironmentSession: () =>
        dependencies.clearEnvironmentSession(environmentSessionId),
    });
    if (connected) return connected;

    if (dependencies.setupFlow.status.pending) {
      const status = dependencies.setupFlow.status;
      yield* Effect.sync(() =>
        dependencies.setProgress?.(
          status.phase === "idle" ? "setup" : status.phase,
        ),
      );
      return {
        status: "awaiting_user",
        phase: status.phase,
        ...(status.message ? { message: status.message } : {}),
      };
    }
    if (dependencies.authorizationFlow.status.pending) {
      yield* Effect.sync(() =>
        dependencies.setProgress?.("bank_authorization"),
      );
      return {
        status: "awaiting_user",
        phase: "bank_authorization",
        message: "Complete the bank authorization in the opened browser.",
      };
    }
    if (!application) dependencies.assertNoEnvironmentCredentials();

    const includeBankInput =
      (application?.environment ?? options.environment) === "SANDBOX";
    yield* Effect.sync(() => dependencies.setProgress?.("collecting_input"));
    const input = yield* collectConnectionInput(
      dependencies.mcpServer,
      !application,
      includeBankInput,
    );
    if (input.status !== "accepted") return input.result;

    if (!application) {
      yield* Effect.sync(() => dependencies.setProgress?.("application_setup"));
      const setupOptions = {
        controlPanelEmail: input.email,
        appName: options.appName,
        environment: options.environment,
        redirectUrl: DEFAULT_REDIRECT_URL,
        ...(input.aspspName ? { aspspName: input.aspspName } : {}),
        ...(input.country ? { country: input.country } : {}),
        description: DEFAULT_PRODUCTION_DESCRIPTION,
        privacyUrl: DEFAULT_PRODUCTION_PRIVACY_URL,
        termsUrl: DEFAULT_PRODUCTION_TERMS_URL,
        accessProfile: options.accessProfile,
        ...(options.validUntil ? { validUntil: options.validUntil } : {}),
      };
      const started = yield* dependencies.setupFlow
        .startGuided(setupOptions)
        .pipe(
          Effect.catchAll((error) =>
            Effect.fail(
              new Error(
                (error instanceof Error ? error.message : String(error))
                  .split(input.email)
                  .join("[email redacted]"),
              ),
            ),
          ),
        );
      return {
        status: "awaiting_user",
        phase: started.phase,
        message: started.message,
      };
    }

    yield* Effect.sync(() => dependencies.setProgress?.("application_check"));
    const credentials = yield* dependencies.resolveCredentials();
    const client = dependencies.createBankClient(credentials);
    let applicationInfo = yield* client.getApplication();
    if (application.environment === "PRODUCTION" && !applicationInfo.active) {
      yield* Effect.sync(() => dependencies.setProgress?.("account_activation"));
      dependencies.openBrowser(APPLICATIONS_URL);
      return {
        status: "awaiting_user",
        phase: "account_activation",
        message:
          "Link an account to activate the Production application, then call connect_bank again to resume.",
      };
    }

    let bank: { name: string; country: string };
    if (application.environment === "PRODUCTION") {
      yield* Effect.sync(() => dependencies.setProgress?.("bank_discovery"));
      const linked = yield* dependencies.setupFlow
        .findLinkedBank(application.appId)
        .pipe(
          Effect.map((value) => ({ bank: value })),
          Effect.catchAll((error) =>
            Effect.succeed({
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      if ("error" in linked) {
        return {
          status: "failed",
          phase: "bank_selection",
          error: linked.error,
        };
      }
      bank = linked.bank;
    } else {
      yield* Effect.sync(() => dependencies.setProgress?.("bank_selection"));
      const selection = yield* resolveBankSelection({
        client,
        mcpServer: dependencies.mcpServer,
        applicationCountries: applicationInfo.countries,
        country: input.country,
        aspspName: input.aspspName,
      });
      if (selection.status !== "selected") {
        return {
          status: "failed",
          phase: "bank_selection",
          message: selection.message,
        };
      }
      bank = selection.bank;
    }

    const consentSettings = yield* resolveConsentSettings(
      dependencies.mcpServer,
      {
        accessProfile: options.accessProfile,
        ...(options.validUntil ? { validUntil: options.validUntil } : {}),
      },
    );
    if (consentSettings.status !== "accepted") {
      return {
        status: consentSettings.status,
        phase: "consent_settings",
        message: consentSettings.message,
      };
    }
    yield* Effect.sync(() => dependencies.setProgress?.("bank_authorization"));
    yield* dependencies.authorizationFlow.start(client, {
      aspspName: bank.name,
      country: bank.country,
      redirectUrl: application.redirectUrls[0] ?? DEFAULT_REDIRECT_URL,
      ...consentSettings.settings,
    });
    return {
      status: "awaiting_user",
      phase: "bank_authorization",
      message:
        "Complete the bank authorization in the opened browser. After connection_status reports connected, call connect_bank to fetch balances.",
    };
  });
}



function collectConnectionInput(
  mcpServer: McpServer["server"],
  includeEmail: boolean,
  includeBank: boolean,
): Effect.Effect<
  | {
      status: "accepted";
      email: string;
      country?: string;
      aspspName?: string;
    }
  | {
      status: "declined" | "unsupported" | "invalid";
      result: Record<string, unknown>;
    },
  unknown
> {
  if (!includeEmail && !includeBank) {
    return Effect.succeed({ status: "accepted", email: "" });
  }
  const properties = {
    ...(includeEmail
      ? {
          control_panel_email: {
            type: "string" as const,
            title: "Control Panel email",
            format: "email" as const,
          },
        }
      : {}),
    ...(includeBank
      ? {
          country: {
            type: "string" as const,
            title: "Bank country",
            description: "Two-letter ISO 3166-1 country code",
            minLength: 2,
            maxLength: 2,
          },
          bank: {
            type: "string" as const,
            title: "Bank",
            description: "Exact bank name",
            minLength: 1,
          },
        }
      : {}),
  };
  const required = [
    ...(includeEmail ? ["control_panel_email"] : []),
    ...(includeBank ? ["country", "bank"] : []),
  ];
  return Effect.gen(function* () {
    const elicited = yield* elicitForm(
      mcpServer,
      includeEmail
        ? includeBank
          ? "Enter the Control Panel email and bank for Sandbox onboarding."
          : "Enter the Control Panel email. Production bank detection uses the account linked in the Enable Banking dashboard."
        : "Enter the bank country and bank for this Sandbox application.",
      properties,
      required,
    );
    if (elicited.status !== "accepted") {
      return {
        status: elicited.status,
        result: {
          status: elicited.status === "declined" ? "cancelled" : "failed",
          phase: "input",
          message:
            elicited.status === "unsupported"
              ? "This MCP client does not support form elicitation. connect_bank requires an MCP-owned form; no setup was started."
              : elicited.status === "declined"
                ? "Connection setup was cancelled; no provider authorization was started."
                : "The MCP client returned incomplete form data; no setup was started.",
        },
      } as const;
    }
    const country = includeBank
      ? elicited.value.country?.trim().toUpperCase() ?? ""
      : undefined;
    const bank = includeBank ? elicited.value.bank?.trim() ?? "" : undefined;
    const email = includeEmail
      ? elicited.value.control_panel_email?.trim() ?? ""
      : "";
    if (
      (includeBank && (!country || !/^[A-Z]{2}$/.test(country) || !bank)) ||
      (includeEmail && !/^[^\s@]+@[^\s@]+$/.test(email))
    ) {
      return {
        status: "invalid",
        result: {
          status: "failed",
          phase: "input",
          message: includeBank
            ? "The form must contain a valid email when requested, a two-letter country code, and a bank name."
            : "The form must contain a valid Control Panel email.",
        },
      } as const;
    }
    return {
      status: "accepted",
      email,
      ...(country ? { country } : {}),
      ...(bank ? { aspspName: bank } : {}),
    } as const;
  });
}
