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
  callbackTlsFromApplication,
  removeTrustedCertificate,
  type SetupOptions,
} from "./setup.js";
import { MacKeychainSessionStore } from "./session-store.js";

const server = new McpServer({
  name: "enable-banking",
  version: "0.3.0",
});

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
    content: [{ type: "text", text: text ?? "null" }],
  };
}

function failure(error: unknown): ToolResult {
  if (error instanceof EnableBankingApiError) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: error.status,
              message: error.message,
              ...error.details,
              ...(error.retryAfter ? { retry_after: error.retryAfter } : {}),
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
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
      "No Enable Banking application is configured; call setup_enable_banking first",
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
      "No Enable Banking session is stored; call authorize_bank first",
    );
  }
  return {
    client: new EnableBankingClient(credentials),
    sessionId,
  };
}

server.registerTool(
  "control_panel_authenticate",
  {
    description:
      "Authenticate to the Enable Banking Control Panel by email link and store the session in macOS Keychain",
    inputSchema: {
      email: z
        .string()
        .email()
        .describe("Email used for Enable Banking Control Panel sign-in"),
    },
  },
  async ({ email }) =>
    safely(async () => {
      const auth = await controlPanelAuth.authenticate(email);
      await controlPanelAuthStore.set(auth);
      return {
        authenticated: true,
        email: auth.email,
        ...(auth.expiresAt ? { expires_at: auth.expiresAt } : {}),
      };
    }),
);

server.registerTool(
  "control_panel_status",
  {
    description:
      "Show Control Panel authentication state without exposing access or refresh tokens",
  },
  async () =>
    safely(async () => {
      const auth = await controlPanelAuthStore.get();
      if (!auth) return { authenticated: false };
      return {
        authenticated: true,
        email: auth.email,
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
  "setup_enable_banking",
  {
    description:
      "Create a personal, noncommercial Enable Banking AIS application, guide linked-account setup, and store credentials in macOS Keychain",
    inputSchema: {
      control_panel_email: z
        .string()
        .email()
        .describe("Email used for Enable Banking Control Panel sign-in"),
      app_name: z
        .string()
        .min(1)
        .default("Enable Banking MCP")
        .describe("Name shown during bank consent"),
      environment: z
        .enum(["PRODUCTION", "SANDBOX"])
        .default("SANDBOX")
        .describe("Enable Banking application environment"),
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
        .optional()
        .describe("Required for PRODUCTION applications"),
      gdpr_email: z
        .string()
        .email()
        .optional()
        .describe("Data protection contact required for PRODUCTION"),
      privacy_url: z
        .string()
        .url()
        .optional()
        .describe("Privacy policy URL required for PRODUCTION"),
      terms_url: z
        .string()
        .url()
        .optional()
        .describe("Terms of service URL required for PRODUCTION"),
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
    control_panel_email,
    app_name,
    environment,
    redirect_url,
    aspsp_name,
    country,
    description,
    gdpr_email,
    privacy_url,
    terms_url,
    valid_until,
    access_profile,
  }) =>
    safely(async () => {
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
      const options: SetupOptions = {
        controlPanelEmail: control_panel_email,
        appName: app_name,
        environment,
        redirectUrl: redirect_url,
        aspspName: aspsp_name,
        country,
        description,
        gdprEmail: gdpr_email,
        privacyUrl: privacy_url,
        termsUrl: terms_url,
        validUntil: valid_until,
        accessProfile: access_profile as AccessProfile,
        allowRestrictedProduction:
          process.env.ENABLE_BANKING_ALLOW_RESTRICTED_PRODUCTION === "true",
      };
      return setupFlow.start(options);
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
  async () =>
    safely(async () => {
      const { client, sessionId } = await sessionClient();
      const session = await client.getSession(sessionId);
      return {
        aspsp: session.aspsp,
        accounts: session.accounts,
        accounts_data: session.accounts_data,
        access: session.access,
      };
    }),
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
