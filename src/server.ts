#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
    version: "0.3.0-beta.10",
  },
  {
    instructions:
      `MCP transport connectivity does not mean Enable Banking is authenticated.
Use connect_bank as the primary guided setup. It reuses stored authentication
and application state, opens required browser pages, and handles callbacks.
Check conversation and stored/provider data before asking. If a bank is named
without a country, search the global personal-AIS bank list and use an exact,
unique match; if multiple matches remain, ask the user to select the bank and
country. If a country is known and only one bank is listed, proceed with it.
Never guess from device locale or location.

When the client advertises MCP form elicitation, use it only for an unresolved
Control Panel email, country, or bank choice. The user may decline. Never
request passwords, OTPs, API keys, access tokens, bank credentials, or consent.
If forms are unavailable, return provider choices so the agent can ask through
its own UI. For Control Panel email fallback, request local
ENABLE_BANKING_CONTROL_PANEL_EMAIL configuration; never pass an email through
a tool argument or expose it in results. The email authenticates the Control Panel
and is the data-protection contact for a Production application; it does not
identify the user's bank or retrieve account data.

The agent owns MCP orchestration: perform all safe follow-up calls, status
checks, and resumption yourself. Never ask the user to rerun an MCP tool, copy
a URL or code, or repeat information already available. After required human
browser actions, monitor setup_status or connection_status and resume
connect_bank until the session is verified. The user alone completes a
Control Panel email link when requested, Production dashboard account linking,
bank sign-in/MFA and explicit consent, and any local certificate-trust prompt.

Use connection_status only for status checks; it does not open a browser, start
consent, modify stored sessions, or return account data. For first-run setup
with a known country and bank, pass both to connect_bank or use
setup_enable_banking; the combined flow handles registration, Production
activation polling, consent callback, and session storage. If a bank is
unknown, use provider bank lists and request only unresolved choices. The
default access profile is balances; request transactions only when needed.
This server is read-only for personal account information and never initiates
payments. Use register_application and authorize_bank only for advanced
control. Never pass emails, tokens, private keys, or session IDs as tool
arguments. Control Panel email is read from local configuration or Keychain
when available.`
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
  async () => {
    const application = await applicationStore.get();
    return application
      ? callbackTlsFromApplication(application)
      : loadCallbackTlsOptions();
  },
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

async function safely<T>(operation: () => Promise<T>): Promise<ToolResult> {
  try {
    return success(await operation());
  } catch (error) {
    return failure(error);
  }
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

async function resolveCredentials(): Promise<{ appId: string; privateKey: string }> {
  const application = await applicationStore.get();
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
    throw new Error(
      "No Enable Banking application is configured; call connect_bank first",
    );
  }
  return loadCredentials();
}

async function sessionClient(): Promise<{
  client: EnableBankingClient;
  sessionId: string;
}> {
  const credentials = await resolveCredentials();
  const sessionId =
    (await sessionStore.get()) ?? process.env.ENABLE_BANKING_SESSION_ID?.trim();
  if (!sessionId) {
    const status = authorizationFlow.status;
    if (status.pending) {
      throw new Error(
        "Bank authorization is pending; finish it in the browser and retry",
      );
    }
    if (status.lastError) {
      throw new Error(`Bank authorization failed: ${status.lastError}`);
    }
    throw new Error(
      "No Enable Banking session is stored; call connect_bank first",
    );
  }
  return {
    client: new EnableBankingClient(credentials),
    sessionId,
  };
}
async function authorizedAccountClient(
  accountId: string,
): Promise<EnableBankingClient> {
  const { client, sessionId } = await sessionClient();
  const session = await client.getSession(sessionId);
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
    throw new Error("Account is not authorized by the current bank session");
  }
  return client;
}

async function authorizedAccounts(): Promise<Record<string, unknown>> {
  const { client, sessionId } = await sessionClient();
  const session = await client.getSession(sessionId);
  return {
    aspsp: session.aspsp,
    accounts: session.accounts,
    accounts_data: session.accounts_data,
    access: session.access,
  };
}

async function readConnectionStatus() {
  const [application, storedSession, controlPanelAuth] = await Promise.all([
    applicationStore.get(),
    sessionStore.get(),
    controlPanelAuthStore.get(),
  ]);
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
    try {
      client = new EnableBankingClient(await resolveCredentials());
    } catch {
      // Keep credential and key parsing errors out of status-only responses.
    }
  }

  const setupStatus = setupFlow.status;
  const pendingPhase = setupStatus.pending
    ? setupStatus.phase
    : authorizationFlow.status.pending
      ? "bank_authorization"
      : undefined;
  return inspectConnectionStatus({
    configuration,
    client,
    sessionIds,
    controlPanelAuth,
    configuredEnvironment: application?.environment,
    pendingPhase,
  });
}


async function connectBank(options: ConnectBankOptions): Promise<unknown> {
  return runGuidedConnection(options, {
    applicationStore,
    sessionStore,
    setupFlow,
    authorizationFlow,
    controlPanelAuthStore,
    resolveControlPanelEmail,
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
    readAuthorizedAccounts: authorizedAccounts,
    resolveCredentials,
    createBankClient: (credentials) => new EnableBankingClient(credentials),
    openBrowser: launchBrowser,
    mcpServer: server.server,
  });
}

const CONTROL_PANEL_EMAIL_ENV = "ENABLE_BANKING_CONTROL_PANEL_EMAIL";
let storedControlPanelEmail: string | undefined;

async function resolveControlPanelEmail(
  environmentName: string,
  storedEmail?: string,
): Promise<string | Record<string, string>> {
  const persistedEmail = storedEmail?.trim();
  if (persistedEmail) storedControlPanelEmail = persistedEmail;
  const result = await resolveControlPanelEmailInput(
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
  async () =>
    safely(() =>
      controlPanelAuth.withAuthentication(async () => {
        const existingAuth = await controlPanelAuthStore.get();
        const email = await resolveControlPanelEmail(
          CONTROL_PANEL_EMAIL_ENV,
          existingAuth?.email,
        );
        if (typeof email !== "string") return email;
        const auth = await controlPanelAuth.authenticate(email, existingAuth);
        if (auth !== existingAuth) await controlPanelAuthStore.set(auth);
        return {
          authenticated: true,
          ...(auth.expiresAt ? { expires_at: auth.expiresAt } : {}),
        };
      }),
    ),
);
server.registerTool(
  "control_panel_status",
  {
    description:
      "Show Control Panel authentication state without exposing the email or access and refresh tokens",
  },
  async () =>
    safely(async () => {
      const auth = await controlPanelAuthStore.get();
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
);


server.registerTool(
  "control_panel_logout",
  {
    description: "Clear the persisted Control Panel session from macOS Keychain",
  },
  async () =>
    safely(async () => {
      if (setupFlow.status.pending) {
        throw new Error("Cannot log out while application setup is pending");
      }
      return controlPanelAuth.withCredentialCleanup(async () => {
        await controlPanelAuthStore.clear();
        return { authenticated: false };
      });
    }),
);

server.registerTool(
  "connect_bank",
  {
    description:
      "Primary personal AIS setup. Reuses stored sessions and credentials, opens provider pages, and handles callbacks. It elicits only a missing Control Panel email, country, or bank choice through MCP forms when supported; otherwise it returns choices for the agent to ask. The MCP agent owns follow-up calls and status checks. The user completes required sign-in/MFA and consent.",
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
      country: z
        .string()
        .length(2)
        .optional()
        .describe("Two-letter country code used to list available banks"),
      aspsp_name: z
        .string()
        .min(1)
        .optional()
        .describe("Exact bank name selected from connect_bank choices"),
      access_profile: z
        .enum(["balances", "balances_and_transactions"])
        .default("balances")
        .describe("Whether the consent may include transaction history"),
    },
  },
  async ({ app_name, environment, country, aspsp_name, access_profile }) =>
    safely(async () =>
      connectBank({
        appName: app_name,
        environment,
        country,
        aspspName: aspsp_name,
        accessProfile: access_profile as AccessProfile,
      }),
    ),
);

server.registerTool(
  "setup_enable_banking",
  {
    description:
      "Advanced combined registration and personal AIS setup when the bank and country are already known. Reads local Control Panel identity or uses MCP form elicitation when supported. Use connect_bank for provider-discovered missing bank/country choices; the MCP agent owns follow-up calls and status checks.",
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
  async ({
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
    safely(async () => {
      assertNoEnvironmentCredentials();
      const storedAuth = await controlPanelAuthStore.get();
      const controlPanelEmail = await resolveControlPanelEmail(
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
      return setupFlow.start(options);
    }),
);

server.registerTool(
  "register_application",
  {
    description:
      "Register a personal, noncommercial Enable Banking AIS application using local Control Panel identity, store credentials in macOS Keychain, and wait for dashboard activation. If no identity is stored, use MCP form elicitation when supported; the email is never a tool argument or result.",
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
  async ({
    app_name,
    environment,
    redirect_url,
    description,
    privacy_url,
    terms_url,
  }) =>
    safely(async () => {
      assertNoEnvironmentCredentials();
      const storedAuth = await controlPanelAuthStore.get();
      const controlPanelEmail = await resolveControlPanelEmail(
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
      return setupFlow.registerApplication(options);
    }),
);

server.registerTool(
  "setup_status",
  {
    description:
      "Report setup progress without credentials. The MCP agent may poll this and must resume connect_bank itself after required human browser actions.",
  },
  async () => safely(async () => setupFlow.getStatus()),
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
  async () => safely(async () => readConnectionStatus()),
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
  async ({
    aspsp_name,
    country,
    redirect_url,
    valid_until,
    access_profile,
  }) =>
    safely(async () => {
      if (setupFlow.status.pending) {
        throw new Error(
          "Enable Banking setup is already in progress; call setup_status or connect_bank instead",
        );
      }
      authorizationFlow.reserve();
      try {
        const application = await applicationStore.get();
        const credentials = application
          ? { appId: application.appId, privateKey: application.privateKey }
          : await resolveCredentials();
        /* c8 ignore next 4 -- V8 omits this returned MCP argument literal from source-mapped coverage; stdio integration exercises authorize_bank end to end. */
        return await authorizationFlow.start(
          new EnableBankingClient(credentials),
          {
            aspspName: aspsp_name,
            country,
            redirectUrl:
              redirect_url ?? application?.redirectUrls[0] ?? DEFAULT_REDIRECT_URL,
            validUntil: valid_until,
            accessProfile: access_profile as AccessProfile,
          },
          true,
        );
      } catch (error) {
        authorizationFlow.release();
        throw error;
      }
    }),
);

server.registerTool(
  "get_application",
  {
    description: "Get the Enable Banking application bound to the current credentials",
  },
  async () =>
    safely(async () =>
      new EnableBankingClient(await resolveCredentials()).getApplication(),
    ),
);

server.registerTool(
  "get_health",
  {
    description: "Check Enable Banking API health",
  },
  async () => safely(async () => getHealth()),
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
  async ({ country }) =>
    safely(async () =>
      new EnableBankingClient(await resolveCredentials()).listBanks(country),
    ),
);

server.registerTool(
  "get_session",
  {
    description: "Get the current stored Enable Banking session",
  },
  async () =>
    safely(async () => {
      const { client, sessionId } = await sessionClient();
      return client.getSession(sessionId);
    }),
);

server.registerTool(
  "delete_session",
  {
    description:
      "Delete the current Enable Banking session from the provider and local Keychain",
  },
  async () =>
    safely(async () => {
      const { client, sessionId } = await sessionClient();
      const result = await client.deleteSession(sessionId);
      if ((await sessionStore.get()) === sessionId) {
        await sessionStore.clear();
      }
      return result;
    }),
);

server.registerTool(
  "list_accounts",
  {
    description: "List accounts authorized in the current personal AIS session",
  },
  async () => safely(async () => authorizedAccounts()),
);

server.registerTool(
  "get_account_details",
  {
    description: "Get details for one authorized account",
    inputSchema: {
      account_id: z.string().min(1).describe("Enable Banking account UID"),
    },
  },
  async ({ account_id }) =>
    safely(async () =>
      (await authorizedAccountClient(account_id)).getAccountDetails(account_id),
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
  async ({ account_id }) =>
    safely(async () =>
      (await authorizedAccountClient(account_id)).getAccountBalances(account_id),
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
  async ({
    account_id,
    date_from,
    date_to,
    continuation_key,
    transaction_status,
    strategy,
    limit,
  }) =>
    safely(async () =>
      (
        await authorizedAccountClient(account_id)
      ).getAccountTransactions(account_id, {
        dateFrom: date_from,
        dateTo: date_to,
        continuationKey: continuation_key,
        transactionStatus: transaction_status,
        strategy,
        limit,
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
  async ({ account_id, transaction_id }) =>
    safely(async () =>
      (
        await authorizedAccountClient(account_id)
      ).getTransactionDetails(account_id, transaction_id),
    ),
);

server.registerTool(
  "clear_local_credentials",
  {
    description:
      "Clear locally stored Enable Banking credentials, session state, Control Panel authentication, and localhost certificate trust",
  },
  async () =>
    safely(async () => {
      if (setupFlow.status.pending || authorizationFlow.status.pending) {
        throw new Error("Cannot clear credentials while setup or authorization is pending");
      }

      return controlPanelAuth.withCredentialCleanup(async () => {
        const failures: string[] = [];
        let trustedCertificateRemoved = false;
        let applicationCanBeCleared = true;
        let application: StoredApplication | undefined;
        try {
          application = await applicationStore.get();
        } catch {
          application = undefined;
          failures.push("trusted_certificate");
        }
        if (application?.certificate) {
          try {
            await removeTrustedCertificate(application.certificate);
            trustedCertificateRemoved = true;
          } catch {
            failures.push("trusted_certificate");
            applicationCanBeCleared = false;
          }
        }

        const clearStore = async (
          name: string,
          clear: () => Promise<void>,
        ): Promise<void> => {
          try {
            await clear();
          } catch {
            failures.push(name);
          }
        };
        await clearStore("session", () => sessionStore.clear());
        if (applicationCanBeCleared) {
          await clearStore("application", () => applicationStore.clear());
        } else {
          failures.push("application");
        }
        await clearStore("control_panel_auth", () => controlPanelAuthStore.clear());

        const cleared = failures.length === 0;
        if (cleared) setupFlow.reset();

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
      });
    }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  /* c8 ignore next 3 -- This top-level handler runs only when MCP transport startup rejects, which the public tool contract cannot induce. */
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
