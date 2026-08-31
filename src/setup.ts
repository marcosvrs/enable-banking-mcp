import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  BankAuthorizationFlow,
  launchBrowser,
  parseLoopbackRedirect,
  parseValidUntil,
  type BrowserOpener,
  type CallbackTlsOptions,
} from "./authorization.js";
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
const OPENSSL_COMMAND = "openssl";
const SECURITY_COMMAND = "/usr/bin/security";
const CERTIFICATE_DAYS = "825";
const ACTIVATION_TIMEOUT_MS = 15 * 60 * 1000;
const ACTIVATION_POLL_MS = 5_000;
const SESSION_TIMEOUT_MS = 6 * 60 * 1000;
const SESSION_POLL_MS = 1_000;

export interface SetupOptions {
  controlPanelEmail: string;
  appName: string;
  environment: ApplicationEnvironment;
  redirectUrl: string;
  aspspName: string;
  country: string;
  description?: string;
  gdprEmail?: string;
  privacyUrl?: string;
  termsUrl?: string;
  validUntil?: string;
}

export interface NormalizedSetupOptions extends SetupOptions {
  redirectUrl: string;
  country: string;
  validUntil: string;
}

export type SetupPhase =
  | "idle"
  | "control_panel_auth"
  | "registering_application"
  | "account_link"
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
}

export class ApplicationSetupFlow {
  private current: SetupStatus = {
    phase: "idle",
    pending: false,
  };

  constructor(private readonly dependencies: ApplicationSetupDependencies) {}

  get status(): SetupStatus {
    return { ...this.current };
  }

  async getStatus(): Promise<SetupStatus> {
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
    return this.status;
  }

  async start(options: SetupOptions): Promise<SetupStartResult> {
    if (this.current.pending) {
      throw new Error("Enable Banking setup is already in progress");
    }
    if (await this.dependencies.applicationStore.get()) {
      throw new Error(
        "An Enable Banking application is already stored; call authorize_bank instead",
      );
    }
    if (await this.dependencies.sessionStore.get()) {
      throw new Error(
        "An Enable Banking session is already stored; clear it before starting setup",
      );
    }

    const normalized = normalizeSetupOptions(options);
    this.current = {
      phase: "control_panel_auth",
      pending: true,
      message:
        "A Control Panel sign-in email was requested; complete it to continue setup",
    };
    void this.run(normalized);
    return {
      status: "started",
      phase: "control_panel_auth",
      message: this.current.message ?? "Enable Banking setup started",
    };
  }

  private async run(options: NormalizedSetupOptions): Promise<void> {
    let application: StoredApplication | undefined;
    try {
      const redirect = parseLoopbackRedirect(options.redirectUrl);
      const keyMaterial = await (this.dependencies.generateKeyMaterial ??
        generateKeyMaterial)();
      const controlPanelAuth = await this.dependencies.controlPanelAuth.authenticate(
        options.controlPanelEmail,
      );
      await this.dependencies.controlPanelAuthStore?.set(controlPanelAuth);
      this.update({
        phase: "registering_application",
        message: "Registering the Enable Banking application",
      });
      const registration = await this.dependencies.controlPanelClient.registerApplication(
        controlPanelAuth,
        createRegistrationRequest(options, keyMaterial.certificate),
      );
      application = {
        appId: registration.app_id,
        privateKey: keyMaterial.privateKey,
        certificate: keyMaterial.certificate,
        environment: options.environment,
        redirectUrls: [options.redirectUrl],
      };
      await this.dependencies.applicationStore.set(application);
      if (redirect.protocol === "https:") {
        await (this.dependencies.trustCertificate ?? trustCertificate)(
          keyMaterial.certificate,
        );
      }

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
            "Link the application to your own bank account in the dashboard; setup is waiting for activation",
        });
        (this.dependencies.openBrowser ?? launchBrowser)(APPLICATIONS_URL);
        await waitForActivation(client, this.dependencies.sleep);
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
      });
      this.update({
        phase: "bank_authorization",
        appId: application.appId,
        authorizationUrl: authorization.authorization_url,
        message:
          "Complete bank consent in the browser; setup will store the returned session automatically",
      });
      await waitForSession(
        this.dependencies.sessionStore,
        this.dependencies.authorizationFlow,
        this.dependencies.sleep,
      );
      this.update({
        phase: "complete",
        pending: false,
        appId: application.appId,
        sessionStored: true,
        message: "Enable Banking setup is complete",
      });
    } catch (error) {
      this.update({
        phase: "failed",
        pending: false,
        ...(application?.appId ? { appId: application.appId } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private update(update: Partial<SetupStatus>): void {
    this.current = { ...this.current, ...update };
  }
}

export function normalizeSetupOptions(
  options: SetupOptions,
): NormalizedSetupOptions {
  const controlPanelEmail = options.controlPanelEmail.trim();
  const appName = options.appName.trim();
  const aspspName = options.aspspName.trim();
  const country = options.country.trim().toUpperCase();
  const description = options.description?.trim();
  const gdprEmail = options.gdprEmail?.trim();
  const privacyUrl = options.privacyUrl?.trim();
  const termsUrl = options.termsUrl?.trim();

  if (
    options.environment !== "PRODUCTION" &&
    options.environment !== "SANDBOX"
  ) {
    throw new Error("environment must be PRODUCTION or SANDBOX");
  }
  if (!controlPanelEmail || !controlPanelEmail.includes("@")) {
    throw new Error("control_panel_email must be a valid email address");
  }
  if (!appName) throw new Error("app_name is required");
  if (!aspspName) throw new Error("aspsp_name is required");
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new Error("country must be a two-letter ISO 3166-1 code");
  }
  const redirect = parseLoopbackRedirect(options.redirectUrl);
  const validUntil = parseValidUntil(options.validUntil);

  if (options.environment === "PRODUCTION") {
    if (redirect.protocol === "http:") {
      throw new Error(
        "redirect_url must use HTTPS for PRODUCTION; HTTP loopback callbacks are supported only in SANDBOX",
      );
    }
    if (!description) throw new Error("description is required for PRODUCTION");
    if (!gdprEmail || !gdprEmail.includes("@")) {
      throw new Error("gdpr_email is required for PRODUCTION");
    }
    if (!privacyUrl) throw new Error("privacy_url is required for PRODUCTION");
    if (!termsUrl) throw new Error("terms_url is required for PRODUCTION");
    try {
      new URL(privacyUrl);
      new URL(termsUrl);
    } catch {
      throw new Error("privacy_url and terms_url must be valid URLs");
    }
  }

  return {
    ...options,
    controlPanelEmail,
    appName,
    aspspName,
    country,
    redirectUrl: options.redirectUrl.trim(),
    ...(description ? { description } : {}),
    ...(gdprEmail ? { gdprEmail } : {}),
    ...(privacyUrl ? { privacyUrl } : {}),
    ...(termsUrl ? { termsUrl } : {}),
    validUntil,
  };
}

function createRegistrationRequest(
  options: NormalizedSetupOptions,
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
): Promise<void> {
  const deadline = Date.now() + ACTIVATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const application = await client.getApplication();
    if (application.active) return;
    await (configuredSleep ?? sleep)(ACTIVATION_POLL_MS);
  }
  throw new Error(
    "The application is still inactive; complete dashboard account linking and retry setup_status",
  );
}

async function waitForSession(
  sessionStore: SessionStore,
  authorizationFlow: BankAuthorizationFlow,
  configuredSleep?: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + SESSION_TIMEOUT_MS;
  while (Date.now() < deadline) {
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

export function callbackTlsFromApplication(
  application: StoredApplication,
): CallbackTlsOptions {
  return {
    key: Buffer.from(application.privateKey, "utf8"),
    cert: Buffer.from(application.certificate, "utf8"),
  };
}

function sleep(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}

function runCommand(command: string, args: string[]): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "ignore"] });
  child.once("error", () => reject(new Error("Required local setup command is unavailable")));
  child.once("close", (code) => {
    if (code === 0) resolve();
    else reject(new Error("Required local setup command failed"));
  });
  return promise;
}
