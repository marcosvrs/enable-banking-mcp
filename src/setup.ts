import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  BankAuthorizationFlow,
  launchBrowser,
  parseValidUntil,
  type AccessProfile,
  type BrowserOpener,
  type CallbackTlsOptions,
} from "./authorization.js";
import { parseLoopbackRedirect } from "./redirect.js";
import {
  ControlPanelAuthFlow,
  ControlPanelClient,
  type ApplicationRegistrationRequest,
} from "./control-panel.js";
import type { ControlPanelAuthStore } from "./control-panel-store.js";
import type {
  ApplicationEnvironment,
  ApplicationStore,
  StoredApplication,
} from "./application-store.js";
import type { SessionStore } from "./session-store.js";
import type { EnableBankingCredentials } from "./config.js";
import { EnableBankingClient } from "./enable-banking.js";

const APPLICATIONS_URL = "https://enablebanking.com/cp/applications";
export const DEFAULT_PRODUCTION_DESCRIPTION =
  "Read-only personal account-information access";
export const DEFAULT_PRODUCTION_PRIVACY_URL =
  "https://marcosvrs.github.io/enable-banking-mcp/privacy-policy/";
export const DEFAULT_PRODUCTION_TERMS_URL =
  "https://marcosvrs.github.io/enable-banking-mcp/terms-of-use/";
const OPENSSL_COMMAND = "openssl";
const SECURITY_COMMAND = "/usr/bin/security";
const CERTIFICATE_DAYS = "825";
const ACTIVATION_TIMEOUT_MS = 15 * 60 * 1000;
const ACTIVATION_POLL_MS = 5_000;
const SESSION_TIMEOUT_MS = 6 * 60 * 1000;
const SESSION_POLL_MS = 1_000;

export interface ApplicationRegistrationOptions {
  controlPanelEmail: string;
  appName: string;
  environment: ApplicationEnvironment;
  redirectUrl: string;
  description?: string;
  privacyUrl?: string;
  termsUrl?: string;
}

export interface SetupOptions extends ApplicationRegistrationOptions {
  aspspName: string;
  country: string;
  validUntil?: string;
  accessProfile?: AccessProfile;
}

export interface NormalizedApplicationRegistrationOptions
  extends ApplicationRegistrationOptions {
  gdprEmail?: string;
}

export interface NormalizedSetupOptions extends SetupOptions {
  gdprEmail?: string;
  redirectUrl: string;
  country: string;
  validUntil: string;
  accessProfile: AccessProfile;
}

export type SetupPhase =
  | "idle"
  | "control_panel_auth"
  | "registering_application"
  | "account_link"
  | "application_ready"
  | "bank_authorization"
  | "complete"
  | "failed";

export interface SetupStatus {
  phase: SetupPhase;
  pending: boolean;
  appId?: string;
  dashboardUrl?: string;
  authorizationUrl?: string;
  message?: string;
  error?: string;
  sessionStored?: boolean;
}

export interface SetupStartResult {
  status: "started";
  phase: "control_panel_auth";
  message: string;
}

export interface ApplicationKeyMaterial {
  privateKey: string;
  certificate: string;
}

export interface ApplicationSetupDependencies {
  applicationStore: ApplicationStore;
  sessionStore: SessionStore;
  controlPanelClient: ControlPanelClient;
  controlPanelAuth: ControlPanelAuthFlow;
  controlPanelAuthStore?: ControlPanelAuthStore;
  authorizationFlow: BankAuthorizationFlow;
  openBrowser?: BrowserOpener;
  generateKeyMaterial?: () => Promise<ApplicationKeyMaterial>;
  trustCertificate?: (certificate: string) => Promise<void>;
  createBankClient?: (
    credentials: EnableBankingCredentials,
  ) => EnableBankingClient;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export class ApplicationSetupFlow {
  private current: SetupStatus = {
    phase: "idle",
    pending: false,
  };

  private credentialCleanupPending = false;

  constructor(private readonly dependencies: ApplicationSetupDependencies) {}

  get status(): SetupStatus {
    return { ...this.current };
  }

  reset(): void {
    this.current = {
      phase: "idle",
      pending: false,
    };
  }

  async withCredentialCleanup<T>(operation: () => Promise<T>): Promise<T> {
    if (this.current.pending || this.credentialCleanupPending) {
      throw new Error(
        "Cannot clear credentials while setup or cleanup is pending",
      );
    }
    this.credentialCleanupPending = true;
    try {
      return await operation();
    } finally {
      this.credentialCleanupPending = false;
    }
  }

  async getStatus(): Promise<SetupStatus> {
    if (this.current.pending) return this.status;
    const [application, session] = await Promise.all([
      this.dependencies.applicationStore.get(),
      this.dependencies.sessionStore.get(),
    ]);
    if (application && session) {
      return {
        phase: "complete",
        pending: false,
        appId: application.appId,
        sessionStored: true,
        message: "Enable Banking setup is complete",
      };
    }
    if (this.current.phase === "complete") {
      return application || session
        ? {
            phase: "idle",
            pending: false,
            ...(application?.appId ? { appId: application.appId } : {}),
            ...(session ? { sessionStored: true } : {}),
            message: "Enable Banking setup is incomplete",
          }
        : { phase: "idle", pending: false };
    }
    if (
      application &&
      !session &&
      (this.current.phase === "idle" || this.current.phase === "account_link")
    ) {
      if (
        application.environment === "PRODUCTION" &&
        this.dependencies.createBankClient &&
        application.appId &&
        application.privateKey
      ) {
        try {
          const providerApplication = await this.dependencies
            .createBankClient({
              appId: application.appId,
              privateKey: application.privateKey,
            })
            .getApplication();
          const status = applicationStatus(application, providerApplication.active);
          if (
            this.current.phase === "account_link" &&
            providerApplication.active
          ) {
            this.current = status;
          }
          return status;
        } catch {
          return {
            ...applicationStatus(application),
            message:
              "Production application status could not be verified; the MCP agent should resume connect_bank to check activation.",
          };
        }
      }
      return applicationStatus(application);
    }
    return this.status;
  }

  async registerApplication(
    options: ApplicationRegistrationOptions,
  ): Promise<SetupStartResult> {
    const previous = this.reserve();
    try {
      const normalized = normalizeApplicationRegistrationOptions(options);
      await this.ensureStoresAvailable();
      void this.runApplicationRegistration(normalized);
      return {
        status: "started",
        phase: "control_panel_auth",
        message: this.current.message ?? "Enable Banking application setup started",
      };
    } catch (error) {
      this.current = previous;
      throw error;
    }
  }

  async start(options: SetupOptions): Promise<SetupStartResult> {
    const previous = this.reserve();
    try {
      const normalized = normalizeSetupOptions(options);
      await this.ensureStoresAvailable();
      void this.run(normalized);
      return {
        status: "started",
        phase: "control_panel_auth",
        message: this.current.message ?? "Enable Banking setup started",
      };
    } catch (error) {
      this.current = previous;
      throw error;
    }
  }

  private async ensureStoresAvailable(): Promise<void> {
    if (await this.dependencies.applicationStore.get()) {
      throw new Error(
        "An Enable Banking application is already stored; call connect_bank or authorize_bank instead",
      );
    }
    if (await this.dependencies.sessionStore.get()) {
      throw new Error(
        "An Enable Banking session is already stored; call connect_bank or clear it before starting setup",
      );
    }
  }

  private reserve(): SetupStatus {
    if (this.credentialCleanupPending) {
      throw new Error("Cannot start setup while credential cleanup is pending");
    }
    if (this.current.pending) {
      throw new Error("Enable Banking setup is already in progress");
    }
    const previous = this.status;
    this.current = {
      phase: "control_panel_auth",
      pending: true,
      message:
        "Preparing Control Panel authentication; the MCP agent will monitor progress and resume setup. Complete an email link only if one is requested.",
    };
    return previous;
  }

  private async runApplicationRegistration(
    options: NormalizedApplicationRegistrationOptions,
  ): Promise<void> {
    let application: StoredApplication | undefined;
    try {
      application = await this.createApplication(options);
      await (this.dependencies.trustCertificate ?? trustCertificate)(
        application.certificate,
      );
      if (options.environment === "PRODUCTION") {
        this.update({
          phase: "account_link",
          pending: false,
          appId: application.appId,
          dashboardUrl: APPLICATIONS_URL,
          message:
            "Application registered; the user must activate it in the dashboard. The MCP agent continues once any missing country or bank choice is known.",
        });
        (this.dependencies.openBrowser ?? launchBrowser)(APPLICATIONS_URL);
      } else {
        this.update({
          phase: "application_ready",
          pending: false,
          appId: application.appId,
          message:
            "Application registered; the MCP agent can continue with bank consent once country and bank are known.",
        });
      }
    } catch (error) {
      this.update({
        phase: "failed",
        pending: false,
        ...(application?.appId ? { appId: application.appId } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async run(options: NormalizedSetupOptions): Promise<void> {
    let application: StoredApplication | undefined;
    try {
      application = await this.createApplication(options);
      await (this.dependencies.trustCertificate ?? trustCertificate)(
        application.certificate,
      );

      const client = (
        this.dependencies.createBankClient ??
        ((credentials) => new EnableBankingClient(credentials))
      )({
        appId: application.appId,
        privateKey: application.privateKey,
      });
      if (options.environment === "PRODUCTION") {
        this.update({
          phase: "account_link",
          appId: application.appId,
          dashboardUrl: APPLICATIONS_URL,
          message:
            "The user must link the application to their own bank in the dashboard; setup continues automatically when activation is detected.",
        });
        (this.dependencies.openBrowser ?? launchBrowser)(APPLICATIONS_URL);
        const activated = await waitForActivation(
          client,
          this.dependencies.sleep,
          this.dependencies.now,
        );
        if (!activated) {
          this.update({
            phase: "account_link",
            pending: false,
            appId: application.appId,
            dashboardUrl: APPLICATIONS_URL,
            message:
              "The application is still inactive. After dashboard account linking, the MCP agent should resume connect_bank to continue setup.",
          });
          return;
        }

      }
      const aspspName = await resolveAspspName(client, options);
      this.update({
        phase: "bank_authorization",
        appId: application.appId,
        message: "Opening the bank authorization page",
      });
      const authorization = await this.dependencies.authorizationFlow.start(client, {
        aspspName,
        country: options.country,
        redirectUrl: options.redirectUrl,
        validUntil: options.validUntil,
        accessProfile: options.accessProfile,
      });
      this.update({
        phase: "bank_authorization",
        appId: application.appId,
        authorizationUrl: authorization.authorization_url,
        message:
          "Bank consent is open; the callback stores the session automatically after the user completes bank sign-in and consent.",
      });
      await waitForSession(
        this.dependencies.sessionStore,
        this.dependencies.authorizationFlow,
        this.dependencies.sleep,
        this.dependencies.now,
      );
      this.update({
        phase: "complete",
        pending: false,
        appId: application.appId,
        sessionStored: true,
        message: "Enable Banking setup is complete",
      });
    } catch (error) {
      this.current = {
        phase: "failed",
        pending: false,
        ...(application?.appId ? { appId: application.appId } : {}),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async createApplication(
    options: NormalizedApplicationRegistrationOptions,
  ): Promise<StoredApplication> {
    const keyMaterial = await (this.dependencies.generateKeyMaterial ??
      generateKeyMaterial)();
    const existingAuth = await this.dependencies.controlPanelAuthStore?.get();
    const controlPanelAuth = await this.dependencies.controlPanelAuth.authenticate(
      options.controlPanelEmail,
      existingAuth,
    );
    if (controlPanelAuth !== existingAuth) {
      await this.dependencies.controlPanelAuthStore?.set(controlPanelAuth);
    }
    this.update({
      phase: "registering_application",
      message: "Registering the Enable Banking application",
    });
    const registration = await this.dependencies.controlPanelClient.registerApplication(
      controlPanelAuth,
      createRegistrationRequest(options, keyMaterial.certificate),
    );
    const application = {
      appId: registration.app_id,
      privateKey: keyMaterial.privateKey,
      certificate: keyMaterial.certificate,
      environment: options.environment,
      redirectUrls: [options.redirectUrl],
    };
    await this.dependencies.applicationStore.set(application);
    return application;
  }

  private update(update: Partial<SetupStatus>): void {
    this.current = { ...this.current, ...update };
  }
}

function applicationStatus(
  application: StoredApplication,
  active?: boolean,
): SetupStatus {
  const production = application.environment === "PRODUCTION";
  const activationRequired = production && active !== true;
  return {
    phase: activationRequired ? "account_link" : "application_ready",
    pending: false,
    appId: application.appId,
    ...(activationRequired ? { dashboardUrl: APPLICATIONS_URL } : {}),
    message: activationRequired
      ? "Application registered; the user must activate it in the dashboard, then the MCP agent resumes setup."
      : "Application registered; the MCP agent continues with bank consent once the country and bank are known.",
  };
}

export function normalizeApplicationRegistrationOptions(
  options: ApplicationRegistrationOptions,
): NormalizedApplicationRegistrationOptions {
  const controlPanelEmail = options.controlPanelEmail.trim();
  const appName = options.appName.trim();
  const redirectUrl = options.redirectUrl.trim();
  const description = options.description?.trim();
  const privacyUrl = options.privacyUrl?.trim();
  const termsUrl = options.termsUrl?.trim();
  const runtimeEnvironment: unknown = options.environment;

  if (
    runtimeEnvironment !== "PRODUCTION" &&
    runtimeEnvironment !== "SANDBOX"
  ) {
    throw new Error("environment must be PRODUCTION or SANDBOX");
  }
  if (!controlPanelEmail.includes("@")) {
    throw new Error("control_panel_email must be a valid email address");
  }
  if (!appName) throw new Error("app_name is required");
  parseLoopbackRedirect(redirectUrl);

  let normalizedDescription = description;
  let normalizedGdprEmail: string | undefined;
  let normalizedPrivacyUrl = privacyUrl;
  let normalizedTermsUrl = termsUrl;

  if (runtimeEnvironment === "PRODUCTION") {
    normalizedDescription = description || DEFAULT_PRODUCTION_DESCRIPTION;
    normalizedGdprEmail = controlPanelEmail;
    normalizedPrivacyUrl =
      privacyUrl ?? DEFAULT_PRODUCTION_PRIVACY_URL;
    normalizedTermsUrl = termsUrl ?? DEFAULT_PRODUCTION_TERMS_URL;
    validateProviderDocumentUrl("privacy_url", normalizedPrivacyUrl);
    validateProviderDocumentUrl("terms_url", normalizedTermsUrl);
  }

  return {
    ...options,
    controlPanelEmail,
    appName,
    redirectUrl,
    ...(normalizedDescription ? { description: normalizedDescription } : {}),
    ...(normalizedGdprEmail ? { gdprEmail: normalizedGdprEmail } : {}),
    ...(normalizedPrivacyUrl ? { privacyUrl: normalizedPrivacyUrl } : {}),
    ...(normalizedTermsUrl ? { termsUrl: normalizedTermsUrl } : {}),
  };
}

export function normalizeSetupOptions(
  options: SetupOptions,
): NormalizedSetupOptions {
  const normalized = normalizeApplicationRegistrationOptions(options);
  const aspspName = options.aspspName.trim();
  const country = options.country.trim().toUpperCase();
  const accessProfile: unknown = options.accessProfile ?? "balances";

  if (!aspspName) throw new Error("aspsp_name is required");
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new Error("country must be a two-letter ISO 3166-1 code");
  }
  if (
    accessProfile !== "balances" &&
    accessProfile !== "balances_and_transactions"
  ) {
    throw new Error("access_profile is invalid");
  }

  return {
    ...normalized,
    aspspName,
    country,
    accessProfile,
    validUntil: parseValidUntil(options.validUntil),
  };
}

function validateProviderDocumentUrl(field: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(`${field} must be a valid HTTPS URL`);
  }
}

function createRegistrationRequest(
  options: NormalizedApplicationRegistrationOptions,
  certificate: string,
): ApplicationRegistrationRequest {
  return {
    name: options.appName,
    certificate,
    environment: options.environment,
    redirect_urls: [options.redirectUrl],
    ...(options.description ? { description: options.description } : {}),
    ...(options.gdprEmail ? { gdpr_email: options.gdprEmail } : {}),
    ...(options.privacyUrl ? { privacy_url: options.privacyUrl } : {}),
    ...(options.termsUrl ? { terms_url: options.termsUrl } : {}),
  };
}

async function resolveAspspName(
  client: EnableBankingClient,
  options: NormalizedSetupOptions,
): Promise<string> {
  const names = extractAspspNames(await client.listBanks(options.country));
  const requestedName = options.aspspName.toLowerCase();
  const match = names.find((name) => name === options.aspspName) ??
    names.find((name) => name.toLowerCase() === requestedName);
  if (match) return match;

  const available =
    names.length > 0
      ? ` Available ASPSPs: ${names.join(", ")}.`
      : " No ASPSPs were returned for this country.";
  throw new Error(
    `ASPSP "${options.aspspName}" is not available in ${options.environment} for ${options.country}.${available}`,
  );
}

function extractAspspNames(response: unknown): string[] {
  if (typeof response !== "object" || response === null) return [];
  const values = (response as Record<string, unknown>).aspsps;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const name = (value as Record<string, unknown>).name;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  });
}

async function waitForActivation(
  client: EnableBankingClient,
  configuredSleep?: (milliseconds: number) => Promise<void>,
  configuredNow: () => number = Date.now,
): Promise<boolean> {
  const deadline = configuredNow() + ACTIVATION_TIMEOUT_MS;
  while (configuredNow() < deadline) {
    const application = await client.getApplication();
    if (application.active) return true;
    await (configuredSleep ?? sleep)(ACTIVATION_POLL_MS);
  }
  return false;
}

async function waitForSession(
  sessionStore: SessionStore,
  authorizationFlow: BankAuthorizationFlow,
  configuredSleep?: (milliseconds: number) => Promise<void>,
  configuredNow: () => number = Date.now,
): Promise<void> {
  const deadline = configuredNow() + SESSION_TIMEOUT_MS;
  while (configuredNow() < deadline) {
    if (await sessionStore.get()) return;
    const status = authorizationFlow.status;
    if (!status.pending) {
      throw new Error(status.lastError ?? "Bank authorization ended without a session");
    }
    await (configuredSleep ?? sleep)(SESSION_POLL_MS);
  }
  throw new Error("Bank authorization did not complete before setup timed out");
}

export async function generateKeyMaterial(): Promise<ApplicationKeyMaterial> {
  const directory = await mkdtemp(join(tmpdir(), "enable-banking-mcp-"));
  const keyPath = join(directory, "localhost.key");
  const certificatePath = join(directory, "localhost.crt");
  try {
    await runCommand(OPENSSL_COMMAND, [
      "req",
      "-x509",
      "-newkey",
      "rsa:4096",
      "-nodes",
      "-sha256",
      "-days",
      CERTIFICATE_DAYS,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,digitalSignature,keyEncipherment",
      "-addext",
      "extendedKeyUsage=serverAuth",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
    ]);
    return {
      privateKey: await readFile(keyPath, "utf8"),
      certificate: await readFile(certificatePath, "utf8"),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function trustCertificate(certificate: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "enable-banking-mcp-cert-"));
  const certificatePath = join(directory, "localhost.crt");
  try {
    await writeFile(certificatePath, certificate, { mode: 0o600 });
    const keychainPath = join(
      homedir(),
      "Library",
      "Keychains",
      "login.keychain-db",
    );
    await runCommand(SECURITY_COMMAND, [
      "add-trusted-cert",
      "-r",
      "trustRoot",
      "-p",
      "ssl",
      "-k",
      keychainPath,
      certificatePath,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function removeTrustedCertificate(
  certificate: string,
): Promise<void> {
  let fingerprint: string;
  try {
    fingerprint = new X509Certificate(certificate).fingerprint.replaceAll(
      ":",
      "",
    );
  } catch {
    throw new Error("Stored localhost certificate is invalid");
  }
  const keychainPath = join(
    homedir(),
    "Library",
    "Keychains",
    "login.keychain-db",
  );
  const result = await runCommand(SECURITY_COMMAND, [
    "delete-certificate",
    "-Z",
    fingerprint,
    "-t",
    keychainPath,
  ]);
  if (
    result.code !== 0 &&
    !/unable to delete certificate matching/i.test(result.stderr)
  ) {
    throw new Error("Unable to remove the localhost certificate trust");
  }
}

export function callbackTlsFromApplication(
  application: StoredApplication,
): CallbackTlsOptions {
  return {
    key: Buffer.from(application.privateKey, "utf8"),
    cert: Buffer.from(application.certificate, "utf8"),
  };
}

function sleep(milliseconds: number): Promise<void> {
  // `withResolvers` uses a type-argument call, which the rule does not recognize as a generic type reference.
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Sleep is a completion-only promise.
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

interface CommandResult {
  code: number;
  stderr: string;
}

function runCommand(
  command: string,
  args: string[],
): Promise<CommandResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("error", () => { reject(new Error("Required local setup command is unavailable")); });
  child.once("close", (code) => {
    resolve({ code: code ?? 1, stderr });
  });
  return promise;
}
