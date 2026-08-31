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
} from "./authorization.js";
import {
  EnableBankingApiError,
  EnableBankingClient,
  getHealth,
} from "./enable-banking.js";
import {
  MacKeychainApplicationStore,
} from "./application-store.js";
import {
  ControlPanelApiError,
  ControlPanelAuthFlow,
  ControlPanelClient,
  isControlPanelRouteAllowed,
  type ControlPanelHttpMethod,
  type ControlPanelRequestOptions,
} from "./control-panel.js";
import {
  MacKeychainControlPanelAuthStore,
} from "./control-panel-store.js";
import {
  ApplicationSetupFlow,
  callbackTlsFromApplication,
  type SetupOptions,
} from "./setup.js";
import { MacKeychainSessionStore } from "./session-store.js";
const server = new McpServer({
  name: "enable-banking",
  version: "0.2.0",
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

const headerSchema = z.record(z.string(), z.string());
const controlPanelQuerySchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);
const controlPanelBodySchema = z.unknown();
const aspspSchema = z.object({
  name: z.string().min(1),
  country: z.string().length(2),
});
const paymentRequestSchema = z
  .object({
    payment_type: z.string().min(1),
    payment_request: z.record(z.string(), z.unknown()),
    aspsp: aspspSchema,
    state: z.string(),
    redirect_url: z.string().url(),
    psu_type: z.enum(["personal", "business"]),
    webhook_url: z.string().url().optional(),
    psu_id: z.string().optional(),
    defer_submission: z.boolean().optional(),
  })
  .passthrough()
  .describe("Complete CreatePaymentRequest envelope");

async function controlPanelRequest<T>(
  method: ControlPanelHttpMethod,
  path: string,
  options: Omit<ControlPanelRequestOptions, "method"> = {},
): Promise<T> {
  if (!isControlPanelRouteAllowed(method, path)) {
    throw new Error(`Control Panel route is not allowlisted: ${method} ${path}`);
  }
  const requestOptions = { ...options, method };
  const auth = await controlPanelAuthStore.get();
  if (!auth) {
    return controlPanelClient.request<T>(path, requestOptions);
  }
  try {
    return await controlPanelClient.requestAuthenticated<T>(
      auth,
      path,
      requestOptions,
    );
  } catch (error) {
    if (!(error instanceof ControlPanelApiError) || error.status !== 401) {
      throw error;
    }
    let refreshed;
    try {
      refreshed = await controlPanelClient.refreshAuth(auth);
    } catch {
      throw new Error(
        "Control Panel session expired; call control_panel_authenticate again",
      );
    }
    await controlPanelAuthStore.set(refreshed);
    return controlPanelClient.requestAuthenticated<T>(
      refreshed,
      path,
      requestOptions,
    );
  }
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
  "control_panel_request",
  {
    description:
      "Call any allowlisted Enable Banking Control Panel endpoint. Mutating endpoints can change applications, consents, links, billing, or subscriptions.",
    inputSchema: {
      method: z
        .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
        .describe("HTTP method"),
      path: z
        .string()
        .regex(/^\/api\//)
        .describe("Allowlisted Control Panel path beginning with /api/"),
      query: controlPanelQuerySchema
        .optional()
        .describe("Query parameters"),
      body: controlPanelBodySchema
        .optional()
        .describe("JSON or form fields for the request body"),
      body_encoding: z
        .enum(["json", "form"])
        .default("json")
        .describe("How to encode body fields"),
    },
  },
  async ({ method, path, query, body, body_encoding }) =>
    safely(async () =>
      controlPanelRequest(method, path, {
        query,
        body,
        bodyEncoding: body_encoding,
      }),
    ),
);

server.registerTool(
  "setup_enable_banking",
  {
    description:
      "Create a new Enable Banking application, guide account linking, and store the session in macOS Keychain",
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
        .describe("Registered loopback callback URL; PRODUCTION requires HTTPS"),
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
      "Start an explicit browser-based bank account consent flow; the MCP stores the resulting session in macOS Keychain",
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
        .describe("Registered loopback callback URL; PRODUCTION requires HTTPS"),
      valid_until: z
        .string()
        .min(1)
        .optional()
        .describe("Future RFC3339 consent expiry; defaults to 30 days"),
      psu_type: z
        .enum(["personal", "business"])
        .optional()
        .describe("Optional PSU type; omit to use the connector default"),
      auth_method: z
        .string()
        .min(1)
        .optional()
        .describe("Optional ASPSP authentication method"),
      credentials: z
        .record(z.string(), z.string())
        .optional()
        .describe("Optional ASPSP credentials; use only with auth_method"),
      credentials_autosubmit: z
        .boolean()
        .optional()
        .describe("Whether supplied ASPSP credentials may be auto-submitted"),
      language: z
        .string()
        .regex(/^[a-z]{2}$/)
        .optional()
        .describe("Optional two-letter lowercase ASPSP language"),
      psu_id: z.string().min(1).optional().describe("Optional PSU identifier"),
    },
  },
  async ({
    aspsp_name,
    country,
    redirect_url,
    valid_until,
    psu_type,
    auth_method,
    credentials,
    credentials_autosubmit,
    language,
    psu_id,
  }) =>
    safely(async () =>
      authorizationFlow.start(new EnableBankingClient(await resolveCredentials()), {
        aspspName: aspsp_name,
        country,
        redirectUrl: redirect_url,
        validUntil: valid_until,
        psuType: psu_type,
        authMethod: auth_method,
        credentials,
        credentialsAutosubmit: credentials_autosubmit,
        language,
        psuId: psu_id,
      }),
    ),
);

server.registerTool(
  "start_authorization",
  {
    description:
      "Call the documented Enable Banking POST /auth operation and return its authorization response without starting a local callback listener",
    inputSchema: {
      request: z
        .object({
          aspsp: aspspSchema,
          access: z.object({
            accounts: z
              .array(
                z.object({
                  iban: z.string().min(1).optional(),
                  other: z.record(z.string(), z.unknown()).optional(),
                }),
              )
              .nullable()
              .optional(),
            balances: z.boolean().default(true),
            transactions: z.boolean().default(true),
            valid_until: z.string().datetime({ offset: true }),
          }),
          state: z.string().min(1),
          redirect_url: z.string().url(),
          psu_type: z.enum(["personal", "business"]).optional(),
          auth_method: z.string().min(1).optional(),
          credentials: z.record(z.string(), z.string()).optional(),
          credentials_autosubmit: z.boolean().optional(),
          language: z.string().regex(/^[a-z]{2}$/).optional(),
          psu_id: z.string().min(1).optional(),
        })
        .describe("Complete StartAuthorizationRequest"),
    },
  },
  async ({ request }) =>
    safely(async () =>
      new EnableBankingClient(await resolveCredentials()).startAuthorization(
        request,
      ),
    ),
);

server.registerTool(
  "create_session",
  {
    description:
      "Exchange an Enable Banking authorization code for a session and store that session as the current MCP session",
    inputSchema: {
      authorization_code: z.string().min(1).describe("Authorization callback code"),
    },
  },
  async ({ authorization_code }) =>
    safely(async () => {
      const session = await new EnableBankingClient(
        await resolveCredentials(),
      ).createSession(authorization_code);
      await sessionStore.set(session.session_id);
      return session;
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
    description: "List Enable Banking institutions with optional capability filters",
    inputSchema: {
      country: z
        .string()
        .length(2)
        .optional()
        .describe("Optional two-letter ISO 3166-1 country code"),
      psu_type: z
        .enum(["personal", "business"])
        .optional()
        .describe("Optional PSU type filter"),
      service: z
        .enum(["AIS", "PIS"])
        .optional()
        .describe("Optional service filter"),
      payment_type: z
        .string()
        .min(1)
        .optional()
        .describe("Optional payment type filter"),
    },
  },
  async ({ country, psu_type, service, payment_type }) =>
    safely(async () =>
      new EnableBankingClient(await resolveCredentials()).listBanks(country, {
        psuType: psu_type,
        service,
        paymentType: payment_type,
      }),
    ),
);

server.registerTool(
  "get_session",
  {
    description: "Get an Enable Banking session by ID or the current stored session",
    inputSchema: {
      session_id: z
        .string()
        .min(1)
        .optional()
        .describe("Optional session ID; defaults to the stored current session"),
      psu_headers: headerSchema
        .optional()
        .describe("Optional PSD2 PSU headers forwarded to Enable Banking"),
    },
  },
  async ({ session_id, psu_headers }) =>
    safely(async () => {
      if (!session_id) {
        const { client, sessionId } = await sessionClient();
        return client.getSession(sessionId, psu_headers);
      }
      return new EnableBankingClient(await resolveCredentials()).getSession(
        session_id,
        psu_headers,
      );
    }),
);

server.registerTool(
  "delete_session",
  {
    description:
      "Delete an Enable Banking session. This is destructive and removes the session from the provider.",
    inputSchema: {
      session_id: z.string().min(1).describe("Enable Banking session ID"),
      psu_headers: headerSchema
        .optional()
        .describe("Optional PSD2 PSU headers forwarded to Enable Banking"),
    },
  },
  async ({ session_id, psu_headers }) =>
    safely(async () => {
      const result = await new EnableBankingClient(
        await resolveCredentials(),
      ).deleteSession(session_id, psu_headers);
      if ((await sessionStore.get()) === session_id) {
        await sessionStore.clear();
      }
      return result;
    }),
);
server.registerTool(
  "list_accounts",
  {
    description: "List accounts authorized in the current session",
    inputSchema: {
      psu_headers: headerSchema
        .optional()
        .describe("Optional PSD2 PSU headers forwarded to Enable Banking"),
    },
  },
  async ({ psu_headers }) =>
    safely(async () => {
      const { client, sessionId } = await sessionClient();
      const session = await client.getSession(sessionId, psu_headers);
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
      psu_headers: headerSchema
        .optional()
        .describe("Optional PSD2 PSU headers forwarded to Enable Banking"),
    },
  },
  async ({ account_id, psu_headers }) =>
    safely(async () =>
      new EnableBankingClient(await resolveCredentials()).getAccountDetails(
        account_id,
        psu_headers,
      ),
    ),
);

server.registerTool(
  "get_account_balances",
  {
    description: "Get balances for one authorized account",
    inputSchema: {
      account_id: z.string().min(1).describe("Enable Banking account UID"),
      psu_headers: headerSchema
        .optional()
        .describe("Optional PSD2 PSU headers forwarded to Enable Banking"),
    },
  },
  async ({ account_id, psu_headers }) =>
    safely(async () =>
      new EnableBankingClient(await resolveCredentials()).getAccountBalances(
        account_id,
        psu_headers,
      ),
    ),
);

server.registerTool(
  "get_account_transactions",
  {
    description: "Get transactions for one authorized account",
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
        .max(500)
        .default(100)
        .describe("Maximum transactions to return"),
      psu_headers: headerSchema
        .optional()
        .describe("Optional PSD2 PSU headers forwarded to Enable Banking"),
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
    psu_headers,
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
        headers: psu_headers,
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
      psu_headers: headerSchema
        .optional()
        .describe("Optional PSD2 PSU headers forwarded to Enable Banking"),
    },
  },
  async ({ account_id, transaction_id, psu_headers }) =>
    safely(async () =>
      new EnableBankingClient(
        await resolveCredentials(),
      ).getTransactionDetails(account_id, transaction_id, psu_headers),
    ),
);

server.registerTool(
  "create_payment",
  {
    description:
      "Create an Enable Banking payment from the documented CreatePaymentRequest. This may initiate a payment consent flow; it does not submit the payment unless defer_submission is false.",
    inputSchema: {
      request: paymentRequestSchema,
      psu_headers: headerSchema
        .optional()
        .describe("Optional PSD2 PSU headers forwarded to Enable Banking"),
    },
  },
  async ({ request, psu_headers }) =>
    safely(async () =>
      new EnableBankingClient(await resolveCredentials()).createPayment(
        request,
        psu_headers,
      ),
    ),
);

server.registerTool(
  "get_payment",
  {
    description: "Get the current status and details of an Enable Banking payment",
    inputSchema: {
      payment_id: z.string().min(1).describe("Enable Banking payment ID"),
      psu_headers: headerSchema
        .optional()
        .describe("Optional PSD2 PSU headers forwarded to Enable Banking"),
    },
  },
  async ({ payment_id, psu_headers }) =>
    safely(async () =>
      new EnableBankingClient(await resolveCredentials()).getPayment(
        payment_id,
        psu_headers,
      ),
    ),
);

server.registerTool(
  "delete_payment",
  {
    description:
      "Cancel/delete an Enable Banking payment. This is destructive and may not be reversible.",
    inputSchema: {
      payment_id: z.string().min(1).describe("Enable Banking payment ID"),
      psu_headers: headerSchema
        .optional()
        .describe("Optional PSD2 PSU headers forwarded to Enable Banking"),
    },
  },
  async ({ payment_id, psu_headers }) =>
    safely(async () =>
      new EnableBankingClient(await resolveCredentials()).deletePayment(
        payment_id,
        psu_headers,
      ),
    ),
);

server.registerTool(
  "submit_payment",
  {
    description:
      "Submit an Enable Banking payment after consent. This is a financial side effect.",
    inputSchema: {
      payment_id: z.string().min(1).describe("Enable Banking payment ID"),
      psu_headers: headerSchema
        .optional()
        .describe("Optional PSD2 PSU headers forwarded to Enable Banking"),
    },
  },
  async ({ payment_id, psu_headers }) =>
    safely(async () =>
      new EnableBankingClient(await resolveCredentials()).submitPayment(
        payment_id,
        psu_headers,
      ),
    ),
);

server.registerTool(
  "get_payment_transaction",
  {
    description: "Get one transaction created by an Enable Banking payment",
    inputSchema: {
      payment_id: z.string().min(1).describe("Enable Banking payment ID"),
      transaction_id: z
        .string()
        .min(1)
        .describe("Enable Banking payment transaction ID"),
      psu_headers: headerSchema
        .optional()
        .describe("Optional PSD2 PSU headers forwarded to Enable Banking"),
    },
  },
  async ({ payment_id, transaction_id, psu_headers }) =>
    safely(async () =>
      new EnableBankingClient(
        await resolveCredentials(),
      ).getPaymentTransaction(payment_id, transaction_id, psu_headers),
    ),
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
