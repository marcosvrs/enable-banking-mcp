#!/usr/bin/env node

import { Cause, Effect } from "effect";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadCredentials } from "./config.js";
import {
  BankAuthorizationFlow,
  DEFAULT_REDIRECT_URL,
  launchBrowser,
  loadCallbackTlsOptions,
  type AccessProfile,
} from "./authorization.js";
import {
  EnableBankingApiError,
  EnableBankingClient,
  getHealth,
} from "./enable-banking.js";
import {
  MacKeychainApplicationStore,
  type StoredApplication,
} from "./application-store.js";
import {
  ControlPanelAuthFlow,
  ControlPanelClient,
} from "./control-panel.js";
import {
  MacKeychainControlPanelAuthStore,
} from "./control-panel-store.js";
import {
  ApplicationSetupFlow,
  DEFAULT_PRODUCTION_DESCRIPTION,
  DEFAULT_PRODUCTION_PRIVACY_URL,
  DEFAULT_PRODUCTION_TERMS_URL,
  callbackTlsFromApplication,
  removeTrustedCertificate,
  type ApplicationRegistrationOptions,
  type SetupOptions,
} from "./setup.js";
import { MacKeychainSessionStore } from "./session-store.js";
import { inspectConnectionStatus } from "./connection-status.js";
import { connectBank as runGuidedConnection, type ConnectBankOptions } from "./guided-connection.js";
import { resolveControlPanelEmailInput } from "./control-panel-email.js";

const server = new McpServer(
  {
    name: "enable-banking",
    version: "0.4.0-beta.1",
  },
  {
    instructions:
      `connect_bank is the one-call onboarding workflow. For a new application,
the MCP asks up front for the Control Panel email, bank country, and bank in
one form elicitation. Do not infer these from chat, environment variables, or
stored Control Panel identity. For an existing application it asks for bank
country and bank together. It then owns registration, local email callback
handling, Production activation monitoring, bank authorization callback, and
retrieval of balances for authorized accounts. No other MCP server is used.

The user must still perform provider-required actions: click the Control Panel
email link; in Production, activate the application by linking an account in
the Enable Banking dashboard; and complete the separate API bank sign-in,
MFA, and explicit consent. Production activation does not create the API
session. Do not promise that an email click alone can authorize bank data.
The MCP opens the system browser and waits for callbacks and provider state;
never ask the user to rerun a tool, copy a code, or tell the agent when a page
is done. The user must also approve any local certificate-trust prompt.

Never request bank passwords, OTPs, API keys, access tokens, or consent through
the model. If MCP form elicitation is unavailable or declined, connect_bank
stops without starting setup; do not fall back to agent-owned forms or local
email configuration. Never pass emails, tokens, private keys, or session IDs
as tool arguments or expose them in results.

Use connection_status only for status checks; it does not start consent,
modify stored sessions, or return account data. Use setup_enable_banking,
register_application, and authorize_bank only for advanced explicit control;
the primary onboarding path is connect_bank. This server is read-only for
personal account information and never initiates payments.`
  },
);

const applicationStore = new MacKeychainApplicationStore();
const sessionStore = new MacKeychainSessionStore();
const controlPanelAuthStore = new MacKeychainControlPanelAuthStore();
const controlPanelClient = new ControlPanelClient();
const controlPanelAuth = new ControlPanelAuthFlow(controlPanelClient);
const authorizationFlow = new BankAuthorizationFlow(
  sessionStore,
  launchBrowser,
  undefined,
  () =>
    Effect.gen(function* () {
      const application = yield* applicationStore.get();
      return application
        ? callbackTlsFromApplication(application)
        : loadCallbackTlsOptions();
    }),
);
const setupFlow = new ApplicationSetupFlow({
  applicationStore,
  sessionStore,
  controlPanelClient,
  controlPanelAuth,
  controlPanelAuthStore,
  authorizationFlow,
  /* c8 ignore next -- test/server.test.mjs exercises this factory in a child process, outside c8 counters. */
  createBankClient: (credentials) => new EnableBankingClient(credentials),
  openBrowser: launchBrowser,
});

type ToolResult = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

function safely<T>(operation: Effect.Effect<T, unknown>): Promise<ToolResult> {
  return Effect.runPromise(
    Effect.matchCause(operation, {
      onFailure: (cause) => failure(Cause.squash(cause)),
      onSuccess: success,
    }),
  );
}

function success(value: unknown): ToolResult {
  const text = JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text: redactLocalEmails(text ?? "null") }],
  };
}

function failure(error: unknown): ToolResult {
  if (error instanceof EnableBankingApiError) {
    const text = JSON.stringify(
      {
        status: error.status,
        message: error.message,
        ...error.details,
        ...(error.retryAfter ? { retry_after: error.retryAfter } : {}),
      },
      null,
      2,
    );
    return {
      content: [{ type: "text", text: redactLocalEmails(text ?? "null") }],
      isError: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: redactLocalEmails(message) }],
    isError: true,
  };
}

function redactLocalEmails(value: string): string {
  let redacted = value;
  const configuredEmail = process.env[CONTROL_PANEL_EMAIL_ENV]?.trim();
  if (configuredEmail) {
    redacted = redacted.split(configuredEmail).join("[local email redacted]");
  }
  if (storedControlPanelEmail) {
    redacted = redacted
      .split(storedControlPanelEmail)
      .join("[local email redacted]");
  }
  return redacted;
}

function resolveCredentials(): Effect.Effect<
  { appId: string; privateKey: string },
  unknown
> {
  return Effect.gen(function* () {
    const application = yield* applicationStore.get();
    if (application) {
      return {
        appId: application.appId,
        privateKey: application.privateKey,
      };
    }
    const hasApplicationId = Boolean(
      process.env.ENABLE_BANKING_APP_ID?.trim() ||
        process.env.ENABLE_BANKING_ID?.trim(),
    );
    const hasPrivateKey = Boolean(process.env.ENABLE_BANKING_PRIVATE_KEY?.trim());
    if (!hasApplicationId && !hasPrivateKey) {
      return yield* Effect.fail(
        new Error(
          "No Enable Banking application is configured; call connect_bank first",
        ),
      );
    }
    return yield* Effect.try({
      try: () => loadCredentials(),
      catch: (error) => error,
    });
  });
}
function sessionClient(): Effect.Effect<
  { client: EnableBankingClient; sessionId: string },
  unknown
> {
  return Effect.gen(function* () {
    const credentials = yield* resolveCredentials();
    const sessionId =
      (yield* sessionStore.get()) ??
      process.env.ENABLE_BANKING_SESSION_ID?.trim();
    if (!sessionId) {
      const status = authorizationFlow.status;
      if (status.pending) {
        return yield* Effect.fail(
          new Error(
            "Bank authorization is pending; finish it in the browser and retry",
          ),
        );
      }
      if (status.lastError) {
        return yield* Effect.fail(
          new Error(`Bank authorization failed: ${status.lastError}`),
        );
      }
      return yield* Effect.fail(
        new Error(
          "No Enable Banking session is stored; call connect_bank first",
        ),
      );
    }
    return yield* Effect.try({
      try: () => ({ client: new EnableBankingClient(credentials), sessionId }),
      catch: (error) => error,
    });
  });
}
function authorizedAccountClient(
  accountId: string,
): Effect.Effect<EnableBankingClient, unknown> {
  return Effect.gen(function* () {
    const { client, sessionId } = yield* sessionClient();
    const session = yield* client.getSession(sessionId);
    const accounts = session.accounts;
    if (
      !Array.isArray(accounts) ||
      !accounts.some(
        (account) =>
          typeof account === "object" &&
          account !== null &&
          (account as Record<string, unknown>).uid === accountId,
      )
    ) {
      return yield* Effect.fail(
        new Error("Account is not authorized by the current bank session"),
      );
    }
    return client;
  });
}
function authorizedAccounts(): Effect.Effect<Record<string, unknown>, unknown> {
  return Effect.gen(function* () {
    const { client, sessionId } = yield* sessionClient();
    const session = yield* client.getSession(sessionId);
    return {
      aspsp: session.aspsp,
      accounts: session.accounts,
      accounts_data: session.accounts_data,
      access: session.access,
    };
  });
}
function authorizedBalances(): Effect.Effect<Record<string, unknown>, unknown> {
  return Effect.gen(function* () {
    const { client, sessionId } = yield* sessionClient();
    const session = yield* client.getSession(sessionId);
    if (!Array.isArray(session.accounts)) {
      return yield* Effect.fail(
        new Error("Enable Banking session returned no authorized accounts"),
      );
    }
    const balances = yield* Effect.all(
      session.accounts.map((account) => {
        if (
          typeof account !== "object" ||
          account === null ||
          typeof (account as Record<string, unknown>).uid !== "string"
        ) {
          return Effect.fail(
            new Error("Enable Banking session returned an invalid account UID"),
          );
        }
        const accountId = (account as Record<string, string>).uid;
        return Effect.map(client.getAccountBalances(accountId), (result) => ({
          account_id: accountId,
          balances: result,
        }));
      }),
      { concurrency: "unbounded" },
    );
    return {
      aspsp: session.aspsp,
      accounts: session.accounts,
      balances,
      access: session.access,
    };
  });
}

function readConnectionStatus(): Effect.Effect<unknown, unknown> {
  return Effect.gen(function* () {
    const [application, storedSession, controlPanelAuth] = yield* Effect.all(
      [
        applicationStore.get(),
        sessionStore.get(),
        controlPanelAuthStore.get(),
      ],
      { concurrency: "unbounded" },
    );
    const environmentSessionId = process.env.ENABLE_BANKING_SESSION_ID?.trim();
    const sessionIds: string[] = [];
    if (storedSession) sessionIds.push(storedSession);
    if (environmentSessionId && environmentSessionId !== storedSession) {
      sessionIds.push(environmentSessionId);
    }
    const environmentApplicationId = Boolean(
      process.env.ENABLE_BANKING_APP_ID?.trim() ||
        process.env.ENABLE_BANKING_ID?.trim(),
    );
    const environmentPrivateKey = Boolean(
      process.env.ENABLE_BANKING_PRIVATE_KEY?.trim(),
    );
    const configuration = application
      ? "configured"
      : environmentApplicationId && environmentPrivateKey
        ? "configured"
        : environmentApplicationId || environmentPrivateKey
          ? "invalid"
          : "missing";

    let client: EnableBankingClient | undefined;
    if (configuration === "configured") {
      client = yield* Effect.catchAll(
        Effect.gen(function* () {
          const credentials = yield* resolveCredentials();
          return yield* Effect.try({
            try: () => new EnableBankingClient(credentials),
            catch: (error) => error,
          });
        }),
        () => Effect.succeed(undefined),
      );
    }

    const setupStatus = setupFlow.status;
    const pendingPhase = setupStatus.pending
      ? setupStatus.phase
      : authorizationFlow.status.pending
        ? "bank_authorization"
        : undefined;
    return yield* inspectConnectionStatus({
      configuration,
      client,
      sessionIds,
      controlPanelAuth,
      configuredEnvironment: application?.environment,
      pendingPhase,
    });
  });
}
function connectBank(
  options: ConnectBankOptions,
): Effect.Effect<unknown, unknown> {
  return runGuidedConnection(options, {
    applicationStore,
    sessionStore,
    setupFlow,
    authorizationFlow,
    assertNoEnvironmentCredentials,
    getEnvironmentSessionId: () =>
      process.env.ENABLE_BANKING_SESSION_ID?.trim(),
    clearEnvironmentSession: (sessionId) => {
      if (
        sessionId &&
        process.env.ENABLE_BANKING_SESSION_ID?.trim() === sessionId
      ) {
        delete process.env.ENABLE_BANKING_SESSION_ID;
      }
    },
    readAuthorizedBalances: authorizedBalances,
    resolveCredentials,
    createBankClient: (credentials) => new EnableBankingClient(credentials),
    openBrowser: launchBrowser,
    mcpServer: server.server,
  });
}
const CONTROL_PANEL_EMAIL_ENV = "ENABLE_BANKING_CONTROL_PANEL_EMAIL";
let storedControlPanelEmail: string | undefined;
function resolveControlPanelEmail(
  environmentName: string,
  storedEmail?: string,
): Effect.Effect<string | Record<string, string>, unknown> {
  return Effect.gen(function* () {
    const persistedEmail = storedEmail?.trim();
    if (persistedEmail) storedControlPanelEmail = persistedEmail;
    const result = yield* resolveControlPanelEmailInput(
      server.server,
      environmentName,
      process.env[environmentName],
      persistedEmail,
    );
    if (result.status === "ready") {
      storedControlPanelEmail = result.email;
      return result.email;
    }
    return result;
  });
}


function assertNoEnvironmentCredentials(): void {
  const hasEnvironmentCredentials =
    Boolean(
      (
        process.env.ENABLE_BANKING_APP_ID?.trim() ||
        process.env.ENABLE_BANKING_ID?.trim()
      ) &&
        process.env.ENABLE_BANKING_PRIVATE_KEY?.trim(),
    );
  if (hasEnvironmentCredentials) {
    throw new Error(
      "Existing Enable Banking environment credentials are configured; remove them before starting first-run setup",
    );
  }
}



server.registerTool(
  "control_panel_authenticate",
  {
    description:
      "Reuse or refresh a stored Control Panel session, or request a sign-in link. If no local email or stored identity exists, use MCP form elicitation when supported; the email and tokens are never tool arguments or results.",
  },
  () =>
    safely(
      controlPanelAuth.withAuthentication((authenticate) =>
        Effect.gen(function* () {
          const existingAuth = yield* controlPanelAuthStore.get();
          const email = yield* resolveControlPanelEmail(
            CONTROL_PANEL_EMAIL_ENV,
            existingAuth?.email,
          );
          if (typeof email !== "string") return email;
          const auth = yield* authenticate(email, existingAuth);
          if (auth !== existingAuth) {
            yield* controlPanelAuthStore.set(auth);
          }
          return {
            authenticated: true,
            ...(auth.expiresAt ? { expires_at: auth.expiresAt } : {}),
          };
        }),
      ),
    ),
);
server.registerTool(
  "control_panel_status",
  {
    description:
      "Show Control Panel authentication state without exposing the email or access and refresh tokens",
  },
  () =>
    safely(
      Effect.gen(function* () {
        const auth = yield* controlPanelAuthStore.get();
        if (!auth) return { authenticated: false };
        return {
          authenticated: true,
          ...(auth.expiresAt
            ? {
                expires_at: auth.expiresAt,
                expired: auth.expiresAt <= Date.now(),
              }
            : {}),
        };
      }),
    ),
);


server.registerTool(
  "control_panel_logout",
  {
    description: "Clear the persisted Control Panel session from macOS Keychain",
  },
  () =>
    safely(
      Effect.gen(function* () {
        if (setupFlow.status.pending) {
          return yield* Effect.fail(
            new Error("Cannot log out while application setup is pending"),
          );
        }
        return yield* controlPanelAuth.withCredentialCleanup(() =>
          Effect.gen(function* () {
            yield* controlPanelAuthStore.clear();
            return { authenticated: false };
          }),
        );
      }),
    ),
);

server.registerTool(
  "connect_bank",
  {
    description:
      "One-call personal AIS onboarding. The MCP requests the Control Panel email, bank country, and bank together using form elicitation, then owns registration, email callback handling, Production activation monitoring, bank authorization callback, and balance retrieval. The user must still complete provider-required email, dashboard account-linking, bank sign-in/MFA, and consent steps.",
    inputSchema: {
      app_name: z
        .string()
        .min(1)
        .default("Enable Banking MCP")
        .describe("Application name used when first-run registration is needed"),
      environment: z
        .enum(["PRODUCTION", "SANDBOX"])
        .default("PRODUCTION")
        .describe("Application environment used when first-run registration is needed"),
      access_profile: z
        .enum(["balances", "balances_and_transactions"])
        .default("balances")
        .describe("Whether the consent may include transaction history"),
    },
  },
  ({ app_name, environment, access_profile }) =>
    safely(
      connectBank({
        appName: app_name,
        environment,
        accessProfile: access_profile as AccessProfile,
      }),
    ),
);

server.registerTool(
  "setup_enable_banking",
  {
    description:
      "Advanced background setup for a known bank and country. The MCP continues registration, Production activation monitoring, callbacks, and session storage after returning its initial status. Use connect_bank for the one-call form, orchestration, and balance retrieval.",
    inputSchema: {
      app_name: z
        .string()
        .min(1)
        .default("Enable Banking MCP")
        .describe("Name shown during bank consent"),
      environment: z
        .enum(["PRODUCTION", "SANDBOX"])
        .default("PRODUCTION")
        .describe("Enable Banking application environment; personal PRODUCTION is the default"),
      redirect_url: z
        .string()
        .url()
        .default(DEFAULT_REDIRECT_URL)
        .describe("Registered HTTPS loopback callback URL"),
      aspsp_name: z
        .string()
        .min(1)
        .describe("Bank name from list_banks"),
      country: z
        .string()
        .length(2)
        .describe("Two-letter ISO 3166-1 country code"),
      description: z
        .string()
        .min(1)
        .default(DEFAULT_PRODUCTION_DESCRIPTION)
        .describe("Application description; defaults to read-only personal access"),
      privacy_url: z
        .string()
        .url()
        .default(DEFAULT_PRODUCTION_PRIVACY_URL)
        .describe("Privacy policy URL; defaults to the project policy"),
      terms_url: z
        .string()
        .url()
        .default(DEFAULT_PRODUCTION_TERMS_URL)
        .describe("Terms of service URL; defaults to the project terms"),
      valid_until: z
        .string()
        .min(1)
        .optional()
        .describe("Future RFC3339 consent expiry; defaults to 30 days"),
      access_profile: z
        .enum(["balances", "balances_and_transactions"])
        .default("balances")
        .describe("Whether the consent may include transaction history"),
    },
  },
  ({
    app_name,
    environment,
    redirect_url,
    aspsp_name,
    country,
    description,
    privacy_url,
    terms_url,
    valid_until,
    access_profile,
  }) =>
    safely(
      Effect.gen(function* () {
        assertNoEnvironmentCredentials();
        const storedAuth = yield* controlPanelAuthStore.get();
        const controlPanelEmail = yield* resolveControlPanelEmail(
          CONTROL_PANEL_EMAIL_ENV,
          storedAuth?.email,
        );
        if (typeof controlPanelEmail !== "string") return controlPanelEmail;
        const options: SetupOptions = {
          controlPanelEmail,
          appName: app_name,
          environment,
          redirectUrl: redirect_url,
          aspspName: aspsp_name,
          country,
          description,
          privacyUrl: privacy_url,
          termsUrl: terms_url,
          validUntil: valid_until,
          accessProfile: access_profile as AccessProfile,
        };
        return yield* setupFlow.start(options);
      }),
    ),
);

server.registerTool(
  "register_application",
  {
    description:
      "Advanced registration-only path. Registers the application and returns its initial status; Production account linking and API bank authorization remain separate. Use connect_bank for the primary one-call setup and balances.",
    inputSchema: {
      app_name: z
        .string()
        .min(1)
        .default("Enable Banking MCP")
        .describe("Application name shown in the Control Panel"),
      environment: z
        .enum(["PRODUCTION", "SANDBOX"])
        .default("PRODUCTION")
        .describe("Enable Banking application environment; personal PRODUCTION is the default"),
      redirect_url: z
        .string()
        .url()
        .default(DEFAULT_REDIRECT_URL)
        .describe("Registered HTTPS loopback callback URL"),
      description: z
        .string()
        .min(1)
        .default(DEFAULT_PRODUCTION_DESCRIPTION)
        .describe("Application description; defaults to read-only personal access"),
      privacy_url: z
        .string()
        .url()
        .default(DEFAULT_PRODUCTION_PRIVACY_URL)
        .describe("Privacy policy URL; defaults to the project policy"),
      terms_url: z
        .string()
        .url()
        .default(DEFAULT_PRODUCTION_TERMS_URL)
        .describe("Terms of service URL; defaults to the project terms"),
    },
  },
  ({
    app_name,
    environment,
    redirect_url,
    description,
    privacy_url,
    terms_url,
  }) =>
    safely(
      Effect.gen(function* () {
        assertNoEnvironmentCredentials();
        const storedAuth = yield* controlPanelAuthStore.get();
        const controlPanelEmail = yield* resolveControlPanelEmail(
          CONTROL_PANEL_EMAIL_ENV,
          storedAuth?.email,
        );
        if (typeof controlPanelEmail !== "string") return controlPanelEmail;
        const options: ApplicationRegistrationOptions = {
          controlPanelEmail,
          appName: app_name,
          environment,
          redirectUrl: redirect_url,
          description,
          privacyUrl: privacy_url,
          termsUrl: terms_url,
        };
        return yield* setupFlow.registerApplication(options);
      }),
    ),
);

server.registerTool(
  "setup_status",
  {
    description:
      "Report setup progress without credentials. Informational only; the active connect_bank or setup_enable_banking flow monitors provider callbacks and status itself.",
  },
  () => safely(setupFlow.getStatus()),
);

server.registerTool(
  "connection_status",
  {
    description:
      "Read-only status of the personal AIS bank connection. Verifies a stored provider session and reports application activation or consent steps without opening a browser, starting consent, changing stored state, or returning account data",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  () => safely(readConnectionStatus()),
);


server.registerTool(
  "authorize_bank",
  {
    description:
      "Start a personal, noncommercial AIS consent flow for the user's own account; the MCP stores the resulting session in macOS Keychain",
    inputSchema: {
      aspsp_name: z.string().min(1).describe("Exact ASPSP name from list_banks"),
      country: z
        .string()
        .length(2)
        .default("IE")
        .describe("Two-letter ISO 3166-1 country code"),
      redirect_url: z
        .string()
        .url()
        .optional()
        .describe(
          "Registered HTTPS loopback callback URL; defaults to the stored application's first redirect",
        ),
      valid_until: z
        .string()
        .min(1)
        .optional()
        .describe("Future RFC3339 consent expiry; defaults to 30 days"),
      access_profile: z
        .enum(["balances", "balances_and_transactions"])
        .default("balances")
        .describe("Whether the consent may include transaction history"),
    },
  },
  ({
    aspsp_name,
    country,
    redirect_url,
    valid_until,
    access_profile,
  }) =>
    safely(
      Effect.gen(function* () {
        if (setupFlow.status.pending) {
          return yield* Effect.fail(
            new Error(
              "Enable Banking setup is already in progress; call setup_status or connect_bank instead",
            ),
          );
        }
        return yield* Effect.acquireUseRelease(
          Effect.try({
            try: () => {
              authorizationFlow.reserve();
            },
            catch: (error) => error,
          }),
          () =>
            Effect.gen(function* () {
              const application = yield* applicationStore.get();
              const credentials = application
                ? { appId: application.appId, privateKey: application.privateKey }
                : yield* resolveCredentials();
              const client = yield* Effect.try({
                try: () => new EnableBankingClient(credentials),
                catch: (error) => error,
              });
              /* c8 ignore next 6 -- V8 omits this returned MCP argument literal from source-mapped coverage; stdio integration exercises authorize_bank end to end. */
              return yield* authorizationFlow.startReserved(client, {
                aspspName: aspsp_name,
                country,
                redirectUrl:
                  redirect_url ??
                  application?.redirectUrls[0] ??
                  DEFAULT_REDIRECT_URL,
                validUntil: valid_until,
                accessProfile: access_profile as AccessProfile,
              });
            }),
          () => Effect.sync(() => authorizationFlow.release()),
        );
      }),
    ),
);
server.registerTool(
  "get_application",
  {
    description: "Get the Enable Banking application bound to the current credentials",
  },
  () =>
    safely(
      Effect.gen(function* () {
        const credentials = yield* resolveCredentials();
        const client = yield* Effect.try({
          try: () => new EnableBankingClient(credentials),
          catch: (error) => error,
        });
        return yield* client.getApplication();
      }),
    ),
);
server.registerTool(
  "get_health",
  {
    description: "Check Enable Banking API health",
  },
  () => safely(getHealth()),
);
server.registerTool(
  "list_banks",
  {
    description:
      "List Enable Banking institutions available for personal AIS account-information access",
    inputSchema: {
      country: z
        .string()
        .length(2)
        .optional()
        .describe("Optional two-letter ISO 3166-1 country code"),
    },
  },
  ({ country }) =>
    safely(
      Effect.gen(function* () {
        const credentials = yield* resolveCredentials();
        const client = yield* Effect.try({
          try: () => new EnableBankingClient(credentials),
          catch: (error) => error,
        });
        return yield* client.listBanks(country);
      }),
    ),
);
server.registerTool(
  "get_session",
  {
    description: "Get the current stored Enable Banking session",
  },
  () =>
    safely(
      Effect.gen(function* () {
        const { client, sessionId } = yield* sessionClient();
        return yield* client.getSession(sessionId);
      }),
    ),
);
server.registerTool(
  "delete_session",
  {
    description:
      "Delete the current Enable Banking session from the provider and local Keychain",
  },
  () =>
    safely(
      Effect.gen(function* () {
        const { client, sessionId } = yield* sessionClient();
        const result = yield* client.deleteSession(sessionId);
        if ((yield* sessionStore.get()) === sessionId) {
          yield* sessionStore.clear();
        }
        return result;
      }),
    ),
);
server.registerTool(
  "list_accounts",
  {
    description: "List accounts authorized in the current personal AIS session",
  },
  () => safely(authorizedAccounts()),
);
server.registerTool(
  "get_account_details",
  {
    description: "Get details for one authorized account",
    inputSchema: {
      account_id: z.string().min(1).describe("Enable Banking account UID"),
    },
  },
  ({ account_id }) =>
    safely(
      Effect.gen(function* () {
        const client = yield* authorizedAccountClient(account_id);
        return yield* client.getAccountDetails(account_id);
      }),
    ),
);
server.registerTool(
  "get_account_balances",
  {
    description: "Get balances for one authorized account",
    inputSchema: {
      account_id: z.string().min(1).describe("Enable Banking account UID"),
    },
  },
  ({ account_id }) =>
    safely(
      Effect.gen(function* () {
        const client = yield* authorizedAccountClient(account_id);
        return yield* client.getAccountBalances(account_id);
      }),
    ),
);
server.registerTool(
  "get_account_transactions",
  {
    description: "Get transaction history for one authorized personal account",
    inputSchema: {
      account_id: z.string().min(1).describe("Enable Banking account UID"),
      date_from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Inclusive start date, YYYY-MM-DD"),
      date_to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Inclusive end date, YYYY-MM-DD"),
      continuation_key: z
        .string()
        .min(1)
        .optional()
        .describe("Optional provider continuation key"),
      transaction_status: z
        .enum(["BOOK", "CNCL", "HOLD", "OTHR", "PDNG", "RJCT", "SCHD"])
        .optional()
        .describe("Optional transaction status filter"),
      strategy: z
        .enum(["default", "longest"])
        .optional()
        .describe("Provider transaction-fetch strategy"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .describe("Target transaction count; the final provider page may exceed it"),
    },
  },
  ({
    account_id,
    date_from,
    date_to,
    continuation_key,
    transaction_status,
    strategy,
    limit,
  }) =>
    safely(
      Effect.gen(function* () {
        const client = yield* authorizedAccountClient(account_id);
        return yield* client.getAccountTransactions(account_id, {
          dateFrom: date_from,
          dateTo: date_to,
          continuationKey: continuation_key,
          transactionStatus: transaction_status,
          strategy,
          limit,
        });
      }),
    ),
);
server.registerTool(
  "get_transaction_details",
  {
    description: "Get details for one transaction in an authorized account",
    inputSchema: {
      account_id: z.string().min(1).describe("Enable Banking account UID"),
      transaction_id: z.string().min(1).describe("Enable Banking transaction ID"),
    },
  },
  ({ account_id, transaction_id }) =>
    safely(
      Effect.gen(function* () {
        const client = yield* authorizedAccountClient(account_id);
        return yield* client.getTransactionDetails(account_id, transaction_id);
      }),
    ),
);

server.registerTool(
  "clear_local_credentials",
  {
    description:
      "Clear locally stored Enable Banking credentials, session state, Control Panel authentication, and localhost certificate trust",
  },
  () =>
    safely(
      Effect.gen(function* () {
        if (setupFlow.status.pending || authorizationFlow.status.pending) {
          return yield* Effect.fail(
            new Error(
              "Cannot clear credentials while setup or authorization is pending",
            ),
          );
        }

        const clearLocalCredentialStores = () =>
          controlPanelAuth.withCredentialCleanup(
            () =>
              Effect.gen(function* () {
              const failures: string[] = [];
              let trustedCertificateRemoved = false;
              let applicationCanBeCleared = true;
              const applicationResult = yield* Effect.either(
                applicationStore.get(),
              );
              let application: StoredApplication | undefined;
              if (applicationResult._tag === "Right") {
                application = applicationResult.right;
              } else {
                failures.push("trusted_certificate");
                applicationCanBeCleared = false;
              }

              if (application?.certificate) {
                const certificateResult = yield* Effect.either(
                  removeTrustedCertificate(application.certificate),
                );
                if (certificateResult._tag === "Right") {
                  trustedCertificateRemoved = true;
                } else {
                  failures.push("trusted_certificate");
                  applicationCanBeCleared = false;
                }
              }

              const clearStore = (
                name: string,
                operation: Effect.Effect<void, unknown>,
              ) =>
                Effect.catchAllCause(operation, () =>
                  Effect.sync(() => failures.push(name)),
                );
              yield* clearStore("session", sessionStore.clear());
              if (applicationCanBeCleared) {
                yield* clearStore("application", applicationStore.clear());
              } else {
                failures.push("application");
              }
              yield* clearStore(
                "control_panel_auth",
                controlPanelAuthStore.clear(),
              );

              const cleared = failures.length === 0;
              if (cleared) {
                setupFlow.reset();
                authorizationFlow.resetError();
              }
              const environmentCredentialsPresent = Boolean(
                process.env.ENABLE_BANKING_APP_ID?.trim() ||
                  process.env.ENABLE_BANKING_ID?.trim() ||
                  process.env.ENABLE_BANKING_PRIVATE_KEY?.trim(),
              );
              return {
                cleared,
                trusted_certificate_removed: trustedCertificateRemoved,
                environment_credentials_present: environmentCredentialsPresent,
                ...(failures.length > 0 ? { failed_items: failures } : {}),
              };
            }),
          );
        return yield* setupFlow.withCredentialCleanup(() =>
          authorizationFlow.withCredentialCleanup(clearLocalCredentialStores),
        );
      }),
    ),
);

function main(): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: () => server.connect(new StdioServerTransport()),
    catch: (error) => error,
  });
}

void Effect.runPromise(main()).catch((error: unknown) => {
  /* c8 ignore next 3 -- This top-level handler runs only when MCP transport startup rejects, which the public tool contract cannot induce. */
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
