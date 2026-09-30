import { Effect } from "effect";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_REDIRECT_URL } from "./authorization.js";
import type { AccessProfile, BankAuthorizationFlow } from "./authorization.js";
import type { ApplicationStore } from "./application-store.js";
import { EnableBankingClient } from "./enable-banking.js";
import { resolveBankSelection } from "./bank-selection.js";
import { elicitForm } from "./elicitation.js";
import { recoverConfiguredSession } from "./session-recovery.js";
import type { SessionStore } from "./session-store.js";
import {
  DEFAULT_PRODUCTION_DESCRIPTION,
  DEFAULT_PRODUCTION_PRIVACY_URL,
  DEFAULT_PRODUCTION_TERMS_URL,
} from "./setup.js";
import type { ApplicationSetupFlow } from "./setup.js";

type EnableBankingCredentials = { appId: string; privateKey: string };

const APPLICATIONS_URL = "https://enablebanking.com/cp/applications";

export type ConnectBankOptions = {
  appName: string;
  environment: "PRODUCTION" | "SANDBOX";
  accessProfile: AccessProfile;
};

export interface GuidedConnectionDependencies {
  applicationStore: Pick<ApplicationStore, "get">;
  sessionStore: Pick<SessionStore, "get" | "clear">;
  setupFlow: Pick<ApplicationSetupFlow, "status" | "runToCompletion" | "waitForCompletion">;
  authorizationFlow: Pick<BankAuthorizationFlow, "status" | "start">;
  assertNoEnvironmentCredentials(): void;
  getEnvironmentSessionId(): string | undefined;
  clearEnvironmentSession(sessionId: string | undefined): void;
  readAuthorizedBalances(): Effect.Effect<Record<string, unknown>, unknown>;
  resolveCredentials(): Effect.Effect<EnableBankingCredentials, unknown>;
  createBankClient(credentials: EnableBankingCredentials): EnableBankingClient;
  openBrowser(url: string): void;
  mcpServer: McpServer["server"];
}

export function connectBank(
  options: ConnectBankOptions,
  dependencies: GuidedConnectionDependencies,
): Effect.Effect<unknown, unknown> {
  return Effect.gen(function* () {
    const [storedSession, application] = yield* Effect.all([
      dependencies.sessionStore.get(),
      dependencies.applicationStore.get(),
    ]);
    const environmentSessionId = dependencies.getEnvironmentSessionId();
    const connected = yield* recoverConfiguredSession<Record<string, unknown>>({
      storedSession,
      environmentSessionId,
      read: () =>
        Effect.map(dependencies.readAuthorizedBalances(), (accounts) => ({
          status: "connected",
          ...accounts,
        })),
      clearStoredSession: () => dependencies.sessionStore.clear(),
      clearEnvironmentSession: () =>
        dependencies.clearEnvironmentSession(environmentSessionId),
    });
    if (connected) return connected;

    if (dependencies.setupFlow.status.pending) {
      const status = yield* dependencies.setupFlow.waitForCompletion();
      if (status.phase === "complete") {
        return {
          status: "connected",
          ...(yield* dependencies.readAuthorizedBalances()),
        };
      }
      return {
        status: status.phase === "failed" ? "failed" : "awaiting_user",
        phase: status.phase,
        ...(status.message ? { message: status.message } : {}),
        ...(status.error ? { error: status.error } : {}),
      };
    }
    if (dependencies.authorizationFlow.status.pending) {
      while (dependencies.authorizationFlow.status.pending) {
        yield* Effect.sleep(250);
      }
      const error = dependencies.authorizationFlow.status.lastError;
      if (error) {
        return { status: "failed", phase: "bank_authorization", error };
      }
      return {
        status: "connected",
        ...(yield* dependencies.readAuthorizedBalances()),
      };
    }
    if (!application) dependencies.assertNoEnvironmentCredentials();


    const input = yield* collectConnectionInput(
      dependencies.mcpServer,
      !application,
    );
    if (input.status !== "accepted") return input.result;

    if (!application) {
      const setupOptions = {
        controlPanelEmail: input.email,
        appName: options.appName,
        environment: options.environment,
        redirectUrl: DEFAULT_REDIRECT_URL,
        aspspName: input.aspspName,
        country: input.country,
        description: DEFAULT_PRODUCTION_DESCRIPTION,
        privacyUrl: DEFAULT_PRODUCTION_PRIVACY_URL,
        termsUrl: DEFAULT_PRODUCTION_TERMS_URL,
        accessProfile: options.accessProfile,
      };
      const status = yield* dependencies.setupFlow
        .runToCompletion(setupOptions)
        .pipe(
          Effect.map((value) => ({
            ...value,
            ...(value.message
              ? {
                  message: value.message
                    .split(input.email)
                    .join("[email redacted]"),
                }
              : {}),
            ...(value.error
              ? { error: value.error.split(input.email).join("[email redacted]") }
              : {}),
          })),
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
      if (status.phase === "complete") {
        return {
          status: "connected",
          ...(yield* dependencies.readAuthorizedBalances().pipe(
            Effect.catchAll((error) =>
              Effect.fail(
                new Error(
                  (error instanceof Error ? error.message : String(error))
                    .split(input.email)
                    .join("[email redacted]"),
                ),
              ),
            ),
          )),
        };
      }
      return {
        status: status.phase === "failed" ? "failed" : "awaiting_user",
        phase: status.phase,
        ...(status.message ? { message: status.message } : {}),
        ...(status.error ? { error: status.error } : {}),
        ...(status.dashboardUrl ? { dashboard_url: status.dashboardUrl } : {}),
      };
    }

    const credentials = yield* dependencies.resolveCredentials();
    const client = dependencies.createBankClient(credentials);
    let applicationInfo = yield* client.getApplication();
    if (application.environment === "PRODUCTION" && !applicationInfo.active) {
      dependencies.openBrowser(APPLICATIONS_URL);
      while (!applicationInfo.active) {
        yield* Effect.sleep(5_000);
        applicationInfo = yield* client.getApplication();
      }
    }

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

    const authorization = yield* dependencies.authorizationFlow.start(client, {
      aspspName: selection.bank.name,
      country: selection.country,
      redirectUrl: application.redirectUrls[0] ?? DEFAULT_REDIRECT_URL,
      accessProfile: options.accessProfile,
    });
    while (dependencies.authorizationFlow.status.pending) {
      yield* Effect.sleep(250);
    }
    const authorizationError = dependencies.authorizationFlow.status.lastError;
    if (authorizationError) {
      return {
        status: "failed",
        phase: "bank_authorization",
        error: authorizationError,
      };
    }
    return {
      status: "connected",
      authorization_url: authorization.authorization_url,
      ...(yield* dependencies.readAuthorizedBalances()),
    };
  });
}

function collectConnectionInput(
  mcpServer: McpServer["server"],
  includeEmail: boolean,
): Effect.Effect<
  | {
      status: "accepted";
      email: string;
      country: string;
      aspspName: string;
    }
  | {
      status: "declined" | "unsupported" | "invalid";
      result: Record<string, unknown>;
    },
  unknown
> {
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
  };
  const required = [
    ...(includeEmail ? ["control_panel_email"] : []),
    "country",
    "bank",
  ];
  return Effect.gen(function* () {
    const elicited = yield* elicitForm(
      mcpServer,
      includeEmail
        ? "To connect your personal bank account, enter your Enable Banking Control Panel email, the bank country, and the bank."
        : "Enter the bank country and bank for this Enable Banking application.",
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
              ? "This MCP client does not support form elicitation. connect_bank requires the client to provide an MCP-owned form; no setup was started."
              : elicited.status === "declined"
                ? "Connection setup was cancelled; no provider authorization was started."
                : "The MCP client returned incomplete form data; no setup was started.",
        },
      } as const;
    }
    const country = elicited.value.country.trim().toUpperCase();
    const bank = elicited.value.bank.trim();
    const email = includeEmail
      ? elicited.value.control_panel_email?.trim() ?? ""
      : "";
    if (
      !/^[A-Z]{2}$/.test(country) ||
      !bank ||
      (includeEmail && !/^[^\s@]+@[^\s@]+$/.test(email))
    ) {
      return {
        status: "invalid",
        result: {
          status: "failed",
          phase: "input",
          message:
            "The form must contain a valid email (for first-time setup), a two-letter country code, and a bank name.",
        },
      } as const;
    }
    return {
      status: "accepted",
      email,
      country,
      aspspName: bank,
    } as const;
  });
}
