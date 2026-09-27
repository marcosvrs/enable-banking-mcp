import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_REDIRECT_URL } from "./authorization.js";
import type { AccessProfile, BankAuthorizationFlow } from "./authorization.js";
import type { ApplicationStore } from "./application-store.js";
import { EnableBankingClient } from "./enable-banking.js";
import { resolveBankSelection } from "./bank-selection.js";
import type { ControlPanelAuthStore } from "./control-panel-store.js";
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
const CONTROL_PANEL_EMAIL_ENV = "ENABLE_BANKING_CONTROL_PANEL_EMAIL";

export type ConnectBankOptions = {
  appName: string;
  environment: "PRODUCTION" | "SANDBOX";
  country?: string;
  aspspName?: string;
  accessProfile: AccessProfile;
};

export interface GuidedConnectionDependencies {
  applicationStore: Pick<ApplicationStore, "get">;
  sessionStore: Pick<SessionStore, "get" | "clear">;
  setupFlow: Pick<ApplicationSetupFlow, "status" | "registerApplication" | "start">;
  authorizationFlow: Pick<BankAuthorizationFlow, "status" | "start">;
  controlPanelAuthStore: Pick<ControlPanelAuthStore, "get">;
  resolveControlPanelEmail(
    environmentName: string,
    storedEmail?: string,
  ): Promise<string | Record<string, string>>;
  assertNoEnvironmentCredentials(): void;
  getEnvironmentSessionId(): string | undefined;
  clearEnvironmentSession(sessionId: string | undefined): void;
  readAuthorizedAccounts(): Promise<Record<string, unknown>>;
  resolveCredentials(): Promise<EnableBankingCredentials>;
  createBankClient(credentials: EnableBankingCredentials): EnableBankingClient;
  openBrowser(url: string): void;
  mcpServer: McpServer["server"];
}

export async function connectBank(
  options: ConnectBankOptions,
  dependencies: GuidedConnectionDependencies,
): Promise<unknown> {
  const [storedSession, application] = await Promise.all([
    dependencies.sessionStore.get(),
    dependencies.applicationStore.get(),
  ]);
  const environmentSessionId = dependencies.getEnvironmentSessionId();
  const connected = await recoverConfiguredSession<Record<string, unknown>>({
    storedSession,
    environmentSessionId,
    read: async () => ({
      status: "connected",
      ...(await dependencies.readAuthorizedAccounts()),
    }),
    clearStoredSession: () => dependencies.sessionStore.clear(),
    clearEnvironmentSession: () =>
      dependencies.clearEnvironmentSession(environmentSessionId),
  });
  const transactionAccess =
    typeof connected?.access === "object" &&
    connected.access !== null &&
    (connected.access as Record<string, unknown>).transactions === true;
  if (
    connected &&
    (options.accessProfile !== "balances_and_transactions" || transactionAccess)
  ) {
    return connected;
  }

  const setupStatus = dependencies.setupFlow.status;
  if (setupStatus.pending) {
    return {
      status: "awaiting_user",
      phase: setupStatus.phase,
      ...(setupStatus.message ? { message: setupStatus.message } : {}),
      next_action:
        "Setup is running in the background. The MCP agent should monitor setup_status and resume connect_bank after any required browser action; do not ask the user to repeat a tool call.",
    };
  }

  if (!application) {
    dependencies.assertNoEnvironmentCredentials();
    const storedAuth = await dependencies.controlPanelAuthStore.get();
    const email = await dependencies.resolveControlPanelEmail(
      CONTROL_PANEL_EMAIL_ENV,
      storedAuth?.email,
    );
    if (typeof email !== "string") return email;
    const controlPanelEmail = email;
    if (!options.country || !options.aspspName) {
      const started = await dependencies.setupFlow.registerApplication({
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
          "The MCP agent handles follow-up calls; wait only for any required email/dashboard action, then resume setup itself. Ask only for a country or bank choice that remains unknown.",
      };
    }

    const started = await dependencies.setupFlow.start({
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
      next_action:
        "The MCP agent should monitor setup_status and resume connect_bank after any required browser action; the user need not repeat an MCP call.",
    };
  }

  if (dependencies.authorizationFlow.status.pending) {
    return {
      status: "awaiting_user",
      phase: "bank_authorization",
      message:
        "Bank authentication is open. After the user completes sign-in/MFA and explicit consent, the MCP agent should call connect_bank itself to verify and return authorized accounts.",
    };
  }

  if (dependencies.authorizationFlow.status.lastError) {
    const error = dependencies.authorizationFlow.status.lastError;
    return {
      status: "failed",
      phase: "bank_authorization",
      error,
      message:
        "Bank authorization failed or was denied. Do not retry automatically; ask the user whether to start a new authorize_bank flow.",
    };
  }

  const client = dependencies.createBankClient(
    await dependencies.resolveCredentials(),
  );
  const applicationInfo = await client.getApplication();
  if (application.environment === "PRODUCTION" && !applicationInfo.active) {
    dependencies.openBrowser(APPLICATIONS_URL);
    return {
      status: "dashboard_action_required",
      phase: "account_link",
      dashboard_url: APPLICATIONS_URL,
      message:
        "The dashboard is open for required account linking. Once the user completes it, the MCP agent should resume setup itself.",
    };
  }

  const selection = await resolveBankSelection({
    client,
    mcpServer: dependencies.mcpServer,
    applicationCountries: applicationInfo.countries,
    country: options.country,
    aspspName: options.aspspName,
  });
  if (selection.status !== "selected") return selection;

  const redirectUrl = application.redirectUrls[0] ?? DEFAULT_REDIRECT_URL;
  const authorization = await dependencies.authorizationFlow.start(client, {
    aspspName: selection.bank.name,
    country: selection.country,
    redirectUrl,
    accessProfile: options.accessProfile,
  });
  return {
    ...authorization,
    status: "awaiting_user",
    phase: "bank_authorization",
    aspsp: selection.bank,
    message:
      "Bank consent is open; after the user completes sign-in and explicit consent, the MCP agent should call connect_bank itself to verify the session and return authorized accounts.",
  };
}
