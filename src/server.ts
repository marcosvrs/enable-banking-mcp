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
import { MacKeychainApplicationStore } from "./application-store.js";
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

const server = new McpServer(
  {
    name: "enable-banking",
    version: "0.3.0-beta.4",
  },
  {
    instructions:
      "Start with connect_bank for guided personal AIS setup and reconnection. It resumes stored state, opens required browser steps, lists available banks after a country is provided, starts read-only consent after a bank is selected, and returns authorized accounts. connect_bank defaults to personal PRODUCTION. Use register_application, setup_enable_banking, authorize_bank, and the other tools for advanced or explicit control. This server is read-only for personal account information; it never initiates payments. Never pass emails, tokens, private keys, or session IDs as tool arguments. Pass only documented account and transaction identifiers to corresponding read-only tools. Control Panel email comes only from the local MCP process environment.",
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
  const email = process.env[CONTROL_PANEL_EMAIL_ENV]?.trim();
  if (email) redacted = redacted.split(email).join("[local email redacted]");
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

type ConnectBankOptions = {
  appName: string;
  environment: "PRODUCTION" | "SANDBOX";
  country?: string;
  aspspName?: string;
  accessProfile: AccessProfile;
};

async function connectBank(options: ConnectBankOptions): Promise<unknown> {
  const [storedSession, application] = await Promise.all([
    sessionStore.get(),
    applicationStore.get(),
  ]);
  if (storedSession || process.env.ENABLE_BANKING_SESSION_ID?.trim()) {
    try {
      return {
        status: "connected",
        ...(await authorizedAccounts()),
      };
    } catch (error) {
      if (!isTerminalSessionError(error)) throw error;
      if (storedSession) {
        await sessionStore.clear();
      }
      if (process.env.ENABLE_BANKING_SESSION_ID?.trim()) {
        delete process.env.ENABLE_BANKING_SESSION_ID;
      }
    }
  }

  const setupStatus = setupFlow.status;
  if (setupStatus.pending) {
    return {
      status: "awaiting_user",
      phase: setupStatus.phase,
      ...(setupStatus.message ? { message: setupStatus.message } : {}),
      next_action: "Complete the browser step, then call connect_bank again",
    };
  }

  if (!application) {
    assertNoEnvironmentCredentials();
    const controlPanelEmail = requiredLocalEmail(CONTROL_PANEL_EMAIL_ENV);
    if (!options.country || !options.aspspName) {
      const started = await setupFlow.registerApplication({
        controlPanelEmail,
        appName: options.appName,
        environment: options.environment,
        redirectUrl: DEFAULT_REDIRECT_URL,
        description: DEFAULT_PRODUCTION_DESCRIPTION,
        privacyUrl: DEFAULT_PRODUCTION_PRIVACY_URL,
        termsUrl: DEFAULT_PRODUCTION_TERMS_URL,
      });
      return {
        status: "setup_started",
        phase: started.phase,
        message: started.message,
        next_action:
          "Complete the Control Panel email and dashboard steps, then call connect_bank again",
      };
    }

    const started = await setupFlow.start({
      controlPanelEmail,
      appName: options.appName,
      environment: options.environment,
      redirectUrl: DEFAULT_REDIRECT_URL,
      aspspName: options.aspspName,
      country: options.country,
      description: DEFAULT_PRODUCTION_DESCRIPTION,
      privacyUrl: DEFAULT_PRODUCTION_PRIVACY_URL,
      termsUrl: DEFAULT_PRODUCTION_TERMS_URL,
      accessProfile: options.accessProfile,
    });
    return {
      status: "setup_started",
      phase: started.phase,
      message: started.message,
      next_action: "Complete the browser steps, then call connect_bank again",
    };
  }

  if (authorizationFlow.status.pending) {
    return {
      status: "awaiting_user",
      phase: "bank_authorization",
      message: "Complete bank consent in the browser, then call connect_bank again",
    };
  }

  const client = new EnableBankingClient(await resolveCredentials());
  const applicationInfo = await client.getApplication();
  if (!applicationInfo.active) {
    launchBrowser(APPLICATIONS_URL);
    return {
      status: "dashboard_action_required",
      phase: "account_link",
      dashboard_url: APPLICATIONS_URL,
      message:
        "Link your own bank account in the dashboard, then call connect_bank again",
    };
  }

  const country = options.country?.trim().toUpperCase();
  if (!country) {
    return {
      status: "needs_country",
      supported_countries: applicationInfo.countries,
      message:
        "Provide the two-letter country code; connect_bank will list the available banks",
    };
  }
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new Error("country must be a two-letter ISO 3166-1 code");
  }

  const banks = extractBankChoices(await client.listBanks(country), country);
  if (!options.aspspName) {
    return banks.length > 0
      ? {
          status: "needs_bank_selection",
          country,
          banks,
          message: "Choose one bank name and call connect_bank again",
        }
      : {
          status: "no_banks",
          country,
          message: "No personal AIS banks were returned for this country",
        };
  }

  const requestedName = options.aspspName.trim().toLowerCase();
  const selectedBank = banks.find(
    (bank) => bank.name.toLowerCase() === requestedName,
  );
  if (!selectedBank) {
    const available =
      banks.length > 0 ? ` Available banks: ${banks.map((bank) => bank.name).join(", ")}.` : "";
    throw new Error(
      `Bank "${options.aspspName}" is not available in ${country}.${available}`,
    );
  }
  const redirectUrl = application.redirectUrls[0] ?? DEFAULT_REDIRECT_URL;

  const authorization = await authorizationFlow.start(client, {
    aspspName: selectedBank.name,
    country,
    redirectUrl,
    accessProfile: options.accessProfile,
  });
  return {
    ...authorization,
    status: "awaiting_user",
    phase: "bank_authorization",
    aspsp: selectedBank,
    message: "Complete bank consent in the browser, then call connect_bank again",
  };
}

const APPLICATIONS_URL = "https://enablebanking.com/cp/applications";
function extractBankChoices(
  response: unknown,
  fallbackCountry: string,
): Array<{ name: string; country: string }> {
  if (typeof response !== "object" || response === null) return [];
  const values = (response as Record<string, unknown>).aspsps;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) return [];
    const country =
      typeof record.country === "string" && record.country.trim()
        ? record.country.trim().toUpperCase()
        : fallbackCountry;
    return [{ name, country }];
  });
}
function isTerminalSessionError(error: unknown): boolean {
  return (
    error instanceof EnableBankingApiError &&
    (error.status === 400 ||
      error.status === 401 ||
      error.status === 403 ||
      error.status === 404)
  );
}

const CONTROL_PANEL_EMAIL_ENV = "ENABLE_BANKING_CONTROL_PANEL_EMAIL";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requiredLocalEmail(environmentName: string): string {
  const value = process.env[environmentName]?.trim();
  if (!value || !EMAIL_PATTERN.test(value)) {
    throw new Error(
      `${environmentName} must be set to a valid email in the local MCP server environment`,
    );
  }
  return value;
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
      "Authenticate with the local email configured in ENABLE_BANKING_CONTROL_PANEL_EMAIL and store the session in macOS Keychain; the email is never an MCP argument or result",
  },
  async () =>
    safely(async () => {
      const auth = await controlPanelAuth.authenticate(
        requiredLocalEmail(CONTROL_PANEL_EMAIL_ENV),
      );
      await controlPanelAuthStore.set(auth);
      return {
        authenticated: true,
        ...(auth.expiresAt ? { expires_at: auth.expiresAt } : {}),
      };
    }),
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
      await controlPanelAuthStore.clear();
      return { authenticated: false };
    }),
);

server.registerTool(
  "connect_bank",
  {
    description:
      "Primary guided personal AIS connection flow; call with no arguments first to resume setup, open required browser steps, discover banks after a country is supplied, start read-only consent after a bank is selected, or return connected accounts",
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
      "Create a personal, noncommercial Enable Banking AIS application using email configured in the local MCP server environment, guide linked-account setup, and store credentials in macOS Keychain; never send email through MCP",
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
      const options: SetupOptions = {
        controlPanelEmail: requiredLocalEmail(CONTROL_PANEL_EMAIL_ENV),
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
      "Register a personal, noncommercial Enable Banking AIS application using the local Control Panel email, store credentials in macOS Keychain, and wait for dashboard activation before bank authorization; never send email through MCP",
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
      const options: ApplicationRegistrationOptions = {
        controlPanelEmail: requiredLocalEmail(CONTROL_PANEL_EMAIL_ENV),
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
      "Show the first-run Enable Banking setup state without exposing credentials",
  },
  async () => safely(async () => setupFlow.getStatus()),
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
        .default(DEFAULT_REDIRECT_URL)
        .describe("Registered HTTPS loopback callback URL"),
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
    safely(async () =>
      authorizationFlow.start(new EnableBankingClient(await resolveCredentials()), {
        aspspName: aspsp_name,
        country,
        redirectUrl: redirect_url,
        validUntil: valid_until,
        accessProfile: access_profile as AccessProfile,
      }),
    ),
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
      new EnableBankingClient(await resolveCredentials()).getAccountDetails(
        account_id,
      ),
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
      new EnableBankingClient(await resolveCredentials()).getAccountBalances(
        account_id,
      ),
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
        .describe("Maximum transactions to return"),
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
      new EnableBankingClient(
        await resolveCredentials(),
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
      new EnableBankingClient(
        await resolveCredentials(),
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
      const setupStatus = await setupFlow.getStatus();
      if (setupStatus.pending || authorizationFlow.status.pending) {
        throw new Error("Cannot clear credentials while setup or authorization is pending");
      }

      const failures: string[] = [];
      let trustedCertificateRemoved = false;
      let applicationCanBeCleared = true;
      const application = await applicationStore.get();
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

      const environmentCredentialsPresent = Boolean(
        (
          process.env.ENABLE_BANKING_APP_ID?.trim() ||
          process.env.ENABLE_BANKING_ID?.trim()
        ) &&
          process.env.ENABLE_BANKING_PRIVATE_KEY?.trim(),
      );
      return {
        cleared: failures.length === 0,
        trusted_certificate_removed: trustedCertificateRemoved,
        environment_credentials_present: environmentCredentialsPresent,
        ...(failures.length > 0 ? { failed_items: failures } : {}),
      };
    }),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
