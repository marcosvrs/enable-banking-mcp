import { Cause, Effect } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  createPrivateKey,
  createPublicKey,
  X509Certificate,
} from "node:crypto";
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
import type {
  ConsentSettings,
  ConsentSettingsResult,
} from "./consent-settings.js";
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

export interface GuidedSetupOptions extends ApplicationRegistrationOptions {
  aspspName?: string;
  country?: string;
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
  validUntil?: string;
  accessProfile: AccessProfile;
}

export interface NormalizedGuidedSetupOptions
  extends NormalizedApplicationRegistrationOptions {
  aspspName?: string;
  country?: string;
  validUntil?: string;
  accessProfile: AccessProfile;
}

export type SetupPhase =
  | "idle"
  | "control_panel_auth"
  | "registering_application"
  | "account_link"
  | "application_ready"
  | "consent_settings"
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

  loadExistingPrivateKey?: (
    appId: string,
  ) => Effect.Effect<string, unknown>;
  generateKeyMaterial?: () => Effect.Effect<ApplicationKeyMaterial, unknown>;
  trustCertificate?: (
    certificate: string,
  ) => Effect.Effect<void, unknown>;
  createBankClient?: (
    credentials: EnableBankingCredentials,
  ) => EnableBankingClient;
  resolveConsentSettings?: (
    defaults: ConsentSettings,
  ) => Effect.Effect<ConsentSettingsResult, unknown>;
  sleep?: (milliseconds: number) => Effect.Effect<void, unknown>;
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

  withCredentialCleanup<T>(
    operation: () => Effect.Effect<T, unknown>,
  ): Effect.Effect<T, unknown> {
    return Effect.gen(this, function* () {
      if (this.current.pending || this.credentialCleanupPending) {
        return yield* Effect.fail(
          new Error("Cannot clear credentials while setup or cleanup is pending"),
        );
      }
      this.credentialCleanupPending = true;
      return yield* Effect.ensuring(
        operation(),
        Effect.sync(() => {
          this.credentialCleanupPending = false;
        }),
      );
    });
  }

  getStatus(): Effect.Effect<SetupStatus, unknown> {
    return Effect.gen(this, function* () {
      if (this.current.pending) return this.status;
      const [application, session] = yield* Effect.all([
        this.dependencies.applicationStore.get(),
        this.dependencies.sessionStore.get(),
      ]);
      if (application && session) {
        return {
          phase: "complete" as const,
          pending: false,
          appId: application.appId,
          sessionStored: true,
          message: "Enable Banking setup is complete",
        };
      }
      if (this.current.phase === "complete") {
        return application || session
          ? {
              phase: "idle" as const,
              pending: false,
              ...(application?.appId ? { appId: application.appId } : {}),
              ...(session ? { sessionStored: true } : {}),
              message: "Enable Banking setup is incomplete",
            }
          : { phase: "idle" as const, pending: false };
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
          const createBankClient = this.dependencies.createBankClient;
          const providerApplication = yield* Effect.try({
            try: () =>
              createBankClient({
                appId: application.appId,
                privateKey: application.privateKey,
              }),
            catch: (error) => error,
          })
            .pipe(Effect.flatMap((client) => client.getApplication()))
            .pipe(Effect.catchAllCause(() => Effect.succeed(undefined)));
          if (!providerApplication) {
            return {
              ...applicationStatus(application),
              message:
                "Production application status could not be verified; connect_bank will keep monitoring before starting authorization.",
            };
          }
          const status = applicationStatus(application, providerApplication.active);
          if (this.current.phase === "account_link" && providerApplication.active) {
            this.current = status;
          }
          return status;
        }
        return applicationStatus(application);
      }
      return this.status;
    });
  }

  registerApplication(
    options: ApplicationRegistrationOptions,
  ): Effect.Effect<SetupStartResult, unknown> {
    return Effect.gen(this, function* () {
      const previous = yield* Effect.sync(() => this.reserve());
      const normalized = yield* Effect.try({
        try: () => normalizeApplicationRegistrationOptions(options),
        catch: (error) => error,
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            this.current = previous;
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            this.current = previous;
          }),
        ),
      );
      yield* this.ensureStoresAvailable().pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            this.current = previous;
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            this.current = previous;
          }),
        ),
      );
      yield* Effect.forkDaemon(this.runApplicationRegistration(normalized));
      return {
        status: "started",
        phase: "control_panel_auth",
        message: this.current.message ?? "Enable Banking application setup started",
      };
    });
  }

  start(options: SetupOptions): Effect.Effect<SetupStartResult, unknown> {
    return Effect.gen(this, function* () {
      const previous = yield* Effect.sync(() => this.reserve());
      const normalized = yield* Effect.try({
        try: () => normalizeSetupOptions(options),
        catch: (error) => error,
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            this.current = previous;
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            this.current = previous;
          }),
        ),
      );
      yield* this.ensureStoresAvailable().pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            this.current = previous;
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            this.current = previous;
          }),
        ),
      );
      yield* Effect.forkDaemon(this.run(normalized));
      return {
        status: "started",
        phase: "control_panel_auth",
        message: this.current.message ?? "Enable Banking setup started",
      };
    });
  }

  startGuided(
    options: GuidedSetupOptions,
  ): Effect.Effect<SetupStartResult, unknown> {
    return Effect.gen(this, function* () {
      const previous = yield* Effect.sync(() => this.reserve());
      const normalized = yield* Effect.try({
        try: () => normalizeGuidedSetupOptions(options),
        catch: (error) => error,
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            this.current = previous;
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            this.current = previous;
          }),
        ),
      );
      yield* this.ensureStoresAvailable().pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            this.current = previous;
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            this.current = previous;
          }),
        ),
      );
      yield* Effect.forkDaemon(this.run(normalized));
      return {
        status: "started",
        phase: "control_panel_auth",
        message: this.current.message ?? "Enable Banking onboarding started",
      };
    });
  }

  runToCompletion(
    options: GuidedSetupOptions,
  ): Effect.Effect<SetupStatus, unknown> {
    return Effect.gen(this, function* () {
      const previous = yield* Effect.sync(() => this.reserve());
      const normalized = yield* Effect.try({
        try: () => normalizeGuidedSetupOptions(options),
        catch: (error) => error,
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            this.current = previous;
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            this.current = previous;
          }),
        ),
      );
      yield* this.ensureStoresAvailable().pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            this.current = previous;
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            this.current = previous;
          }),
        ),
      );
      yield* this.run(normalized);
      return this.status;
    });
  }

  waitForCompletion(): Effect.Effect<SetupStatus, never> {
    return Effect.gen(this, function* () {
      while (this.current.pending) yield* Effect.sleep(500);
      return this.status;
    });
  }
  findLinkedBank(
    applicationId: string,
    controlPanelEmail?: string,
  ): Effect.Effect<{ name: string; country: string }, unknown> {
    return Effect.gen(
      function* (this: ApplicationSetupFlow) {
        const storedAuth = yield* (this.dependencies.controlPanelAuthStore?.get() ??
          Effect.succeed(undefined));
        const email = controlPanelEmail?.trim() || storedAuth?.email;
        if (!email) {
          return yield* Effect.fail(
            new Error(
              "Control Panel authentication is required to find this application's linked bank",
            ),
          );
        }
        const auth = yield* this.dependencies.controlPanelAuth.authenticate(
          email,
          storedAuth,
        );
        if (auth !== storedAuth) {
          yield* (this.dependencies.controlPanelAuthStore?.set(auth) ??
            Effect.void);
        }
        const banks = yield* this.dependencies.controlPanelClient.getLinkedBanks(
          auth,
          applicationId,
        );
        if (banks.length === 0) {
          return yield* Effect.fail(
            new Error(
              "No linked bank was found for this application; link an account in the Enable Banking dashboard first",
            ),
          );
        }
        if (banks.length > 1) {
          return yield* Effect.fail(
            new Error(
              `Multiple linked banks were found: ${banks.map(({ name, country }) => `${name} (${country})`).join(", ")}. This connection flow supports one bank per session`,
            ),
          );
        }
        return banks[0];
      }.bind(this),
    );
  }


  private ensureStoresAvailable(): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      if (yield* this.dependencies.applicationStore.get()) {
        return yield* Effect.fail(
          new Error(
            "An Enable Banking application is already stored; call connect_bank or authorize_bank instead",
          ),
        );
      }
      if (yield* this.dependencies.sessionStore.get()) {
        return yield* Effect.fail(
          new Error(
            "An Enable Banking session is already stored; call connect_bank or clear it before starting setup",
          ),
        );
      }
    });
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
        "Waiting for Control Panel authentication; the MCP setup flow will receive the email callback and continue automatically.",
    };
    return previous;
  }

  private runApplicationRegistration(
    options: NormalizedApplicationRegistrationOptions,
  ): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      let application: StoredApplication | undefined;
      yield* this.createApplication(options)
        .pipe(
          Effect.tap((created) =>
            Effect.sync(() => {
              application = created;
            }),
          ),
          Effect.flatMap((created) =>
            (this.dependencies.trustCertificate ?? trustCertificate)(
              created.certificate,
            ).pipe(Effect.as(created)),
          ),
          Effect.tap((created) =>
            Effect.sync(() => {
              if (options.environment === "PRODUCTION") {
                this.update({
                  phase: "account_link",
                  pending: false,
                  appId: created.appId,
                  dashboardUrl: APPLICATIONS_URL,
                  message:
                    "Application ready; activate it in the dashboard, then use connect_bank to continue the separate bank-session flow.",
                });
              } else {
                this.update({
                  phase: "application_ready",
                  pending: false,
                  appId: created.appId,
                  message:
                    "Application ready; use connect_bank when ready to continue with bank authorization.",
                });
              }
            }),
          ),
          Effect.flatMap(() =>
            options.environment === "PRODUCTION"
              ? (this.dependencies.openBrowser ?? launchBrowser)(APPLICATIONS_URL)
              : Effect.void,
          ),
          Effect.catchAllCause((cause) =>
            Effect.sync(() => {
              const error = Cause.squash(cause);
              this.update({
                phase: "failed",
                pending: false,
                ...(application?.appId ? { appId: application.appId } : {}),
                error: error instanceof Error ? error.message : String(error),
              });
            }),
          ),
        );
    });
  }

  private run(
    options: NormalizedSetupOptions | NormalizedGuidedSetupOptions,
  ): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      let application: StoredApplication | undefined;
      const workflow = Effect.gen(this, function* () {
        const storedApplication = yield* this.createApplication(options);
        application = storedApplication;
        yield* (this.dependencies.trustCertificate ?? trustCertificate)(
          storedApplication.certificate,
        );
        const createBankClient =
          this.dependencies.createBankClient ??
          ((credentials: EnableBankingCredentials) =>
            new EnableBankingClient(credentials));
        const client = yield* Effect.try({
          try: () =>
            createBankClient({
              appId: storedApplication.appId,
              privateKey: storedApplication.privateKey,
            }),
          catch: (error) => error,
        });
        if (options.environment === "PRODUCTION") {
          this.update({
            phase: "account_link",
            appId: storedApplication.appId,
            dashboardUrl: APPLICATIONS_URL,
            message:
              "Activate the Production application by linking an account in the Enable Banking dashboard; this flow continues automatically when activation is detected.",
          });
          yield* (this.dependencies.openBrowser ?? launchBrowser)(APPLICATIONS_URL);
          yield* waitForActivation(client, this.dependencies.sleep);
        }
        let bank: { name: string; country: string };
        if (options.aspspName && options.country) {
          bank = {
            name: yield* resolveAspspName(client, {
              aspspName: options.aspspName,
              country: options.country,
              environment: options.environment,
            }),
            country: options.country,
          };
        } else {
          bank = yield* this.findLinkedBank(
            storedApplication.appId,
            options.controlPanelEmail,
          );
        }
        this.update({
          phase: "consent_settings",
          appId: storedApplication.appId,
          message: `Detected ${bank.name} (${bank.country}); review consent settings`,
        });
        const consentSettings = this.dependencies.resolveConsentSettings
          ? yield* this.dependencies.resolveConsentSettings({
              accessProfile: options.accessProfile,
              ...(options.validUntil
                ? { validUntil: options.validUntil }
                : {}),
            })
          : {
              status: "accepted" as const,
              settings: {
                accessProfile: options.accessProfile,
                ...(options.validUntil
                  ? { validUntil: options.validUntil }
                  : {}),
              },
            };
        if (consentSettings.status !== "accepted") {
          this.update({
            phase: "failed",
            pending: false,
            appId: storedApplication.appId,
            error: consentSettings.message,
          });
          return;
        }
        this.update({
          phase: "bank_authorization",
          appId: storedApplication.appId,
          message: "Opening the bank authorization page",
        });
        const authorization = yield* this.dependencies.authorizationFlow.start(
          client,
          {
            aspspName: bank.name,
            country: bank.country,
            redirectUrl: options.redirectUrl,
            ...consentSettings.settings,
          },
        );
        this.update({
          phase: "bank_authorization",
          appId: storedApplication.appId,
          authorizationUrl: authorization.authorization_url,
          message:
            "Bank consent is open; the callback stores the session automatically after the user completes bank sign-in and consent.",
        });
        yield* waitForSession(
          this.dependencies.sessionStore,
          this.dependencies.authorizationFlow,
          this.dependencies.sleep,
          this.dependencies.now,
        );
        this.update({
          phase: "complete",
          pending: false,
          appId: storedApplication.appId,
          sessionStored: true,
          message: "Enable Banking setup is complete",
        });
      });
      yield* workflow.pipe(
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            const error = Cause.squash(cause);
            const message = error instanceof Error ? error.message : String(error);
            this.current = {
              phase: "failed",
              pending: false,
              ...(application?.appId ? { appId: application.appId } : {}),
              error: message
                .split(options.controlPanelEmail)
                .join("[email redacted]"),
            };
          }),
        ),
      );
    });
  }

  private createApplication(
    options: NormalizedApplicationRegistrationOptions,
  ): Effect.Effect<StoredApplication, unknown> {
    return Effect.gen(this, function* () {
      const existingAuth = yield* (this.dependencies.controlPanelAuthStore?.get() ??
        Effect.succeed(undefined));
      const controlPanelAuth = yield* this.dependencies.controlPanelAuth.authenticate(
        options.controlPanelEmail,
        existingAuth,
      );
      if (controlPanelAuth !== existingAuth) {
        yield* (this.dependencies.controlPanelAuthStore?.set(controlPanelAuth) ??
          Effect.void);
      }
      const applications = yield* this.dependencies.controlPanelClient.listApplications(
        controlPanelAuth,
      );
      const normalizedAppName = options.appName.toLocaleLowerCase("en-US");
      const matches = applications.filter(
        ({ name }) => name.toLocaleLowerCase("en-US") === normalizedAppName,
      );
      const restorable: StoredApplication[] = [];
      for (const match of matches) {
        if (!match.certificate) continue;
        const privateKey = yield* (
          this.dependencies.loadExistingPrivateKey ??
          loadExistingApplicationPrivateKey
        )(match.appId).pipe(
          Effect.map((value) =>
            privateKeyMatchesCertificate(value, match.certificate!)
              ? value
              : undefined,
          ),
          Effect.catchAll(() => Effect.succeed(undefined)),
        );
        if (privateKey === undefined) continue;
        restorable.push({
          appId: match.appId,
          privateKey,
          certificate: match.certificate,
          environment: match.environment ?? options.environment,
          redirectUrls: match.redirectUrls ?? [options.redirectUrl],
        });
      }
      if (restorable.length === 1) {
        const application = restorable[0];
        yield* this.dependencies.applicationStore.set(application);
        return application;
      }
      const keyMaterial = yield* (this.dependencies.generateKeyMaterial ??
        generateKeyMaterial)();
      this.update({
        phase: "registering_application",
        message: "Registering the Enable Banking application",
      });
      const registration = yield* this.dependencies.controlPanelClient.registerApplication(
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
      yield* this.dependencies.applicationStore.set(application);
      return application;
    });
  }

  private update(update: Partial<SetupStatus>): void {
    this.current = { ...this.current, ...update };
  }
}

function loadExistingApplicationPrivateKey(
  appId: string,
): Effect.Effect<string, unknown> {
  const configuredPath =
    process.env.ENABLE_BANKING_APPLICATION_PRIVATE_KEY_FILE?.trim();
  const keyPath =
    configuredPath || join(homedir(), "Downloads", `${appId}.pem`);
  return Effect.tryPromise({
    try: () => readFile(keyPath, "utf8"),
    catch: () =>
      new Error("The matching application private key file could not be read"),
  });
}

function privateKeyMatchesCertificate(
  privateKey: string,
  certificate: string,
): boolean {
  try {
    const keyPublic = createPublicKey(createPrivateKey(privateKey)).export({
      format: "der",
      type: "spki",
    });
    const certificatePublic = new X509Certificate(certificate).publicKey.export({
      format: "der",
      type: "spki",
    });
    return Buffer.from(keyPublic).equals(Buffer.from(certificatePublic));
  } catch {
    return false;
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
      ? "Production application activation is required before bank authorization."
      : "Application ready; use connect_bank to start bank authorization.",
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
  parseLoopbackRedirect(redirectUrl);

  let normalizedDescription = description;
  let normalizedGdprEmail: string | undefined;
  let normalizedPrivacyUrl = privacyUrl;
  let normalizedTermsUrl = termsUrl;

  if (options.environment === "PRODUCTION") {
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
  const accessProfile =
    options.accessProfile ?? "balances_and_transactions";

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
    ...(options.validUntil !== undefined
      ? { validUntil: parseValidUntil(options.validUntil) }
      : {}),
  };
}
export function normalizeGuidedSetupOptions(
  options: GuidedSetupOptions,
): NormalizedGuidedSetupOptions {
  const normalized = normalizeApplicationRegistrationOptions(options);
  const aspspName = options.aspspName?.trim();
  const country = options.country?.trim().toUpperCase();
  const accessProfile =
    options.accessProfile ?? "balances_and_transactions";

  if (Boolean(aspspName) !== Boolean(country)) {
    throw new Error("aspsp_name and country must be provided together");
  }
  if (country && !/^[A-Z]{2}$/.test(country)) {
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
    ...(aspspName ? { aspspName } : {}),
    ...(country ? { country } : {}),
    accessProfile,
    ...(options.validUntil !== undefined
      ? { validUntil: parseValidUntil(options.validUntil) }
      : {}),
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

function resolveAspspName(
  client: EnableBankingClient,
  options: Pick<
    NormalizedSetupOptions,
    "aspspName" | "country" | "environment"
  >,
): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const names = extractAspspNames(yield* client.listBanks(options.country));
    const requestedName = options.aspspName.toLowerCase();
    const match =
      names.find((name) => name === options.aspspName) ??
      names.find((name) => name.toLowerCase() === requestedName);
    if (match) return match;

    const available =
      names.length > 0
        ? ` Available ASPSPs: ${names.join(", ")}.`
        : " No ASPSPs were returned for this country.";
    return yield* Effect.fail(
      new Error(
        `ASPSP "${options.aspspName}" is not available in ${options.environment} for ${options.country}.${available}`,
      ),
    );
  });
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

function waitForActivation(
  client: EnableBankingClient,
  configuredSleep?: (milliseconds: number) => Effect.Effect<void, unknown>,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    while (true) {
      if ((yield* client.getApplication()).active) return;
      yield* (configuredSleep ?? Effect.sleep)(ACTIVATION_POLL_MS);
    }
  });
}

function waitForSession(
  sessionStore: SessionStore,
  authorizationFlow: BankAuthorizationFlow,
  configuredSleep?: (milliseconds: number) => Effect.Effect<void, unknown>,
  configuredNow: () => number = Date.now,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const deadline = configuredNow() + SESSION_TIMEOUT_MS;
    while (configuredNow() < deadline) {
      if (yield* sessionStore.get()) return;
      const status = authorizationFlow.status;
      if (!status.pending) {
        return yield* Effect.fail(
          new Error(
            status.lastError ?? "Bank authorization ended without a session",
          ),
        );
      }
      yield* (configuredSleep ?? Effect.sleep)(SESSION_POLL_MS);
    }
    return yield* Effect.fail(
      new Error("Bank authorization did not complete before setup timed out"),
    );
  });
}

export function generateKeyMaterial(): Effect.Effect<
  ApplicationKeyMaterial,
  unknown
> {
  return Effect.gen(function* () {
    const directory = yield* Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "enable-banking-mcp-")),
      catch: (error) => error,
    });
    const keyPath = join(directory, "localhost.key");
    const certificatePath = join(directory, "localhost.crt");
    const material = Effect.gen(function* () {
      yield* runCommand(OPENSSL_COMMAND, [
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
      const privateKey = yield* Effect.tryPromise({
        try: () => readFile(keyPath, "utf8"),
        catch: (error) => error,
      });
      const certificate = yield* Effect.tryPromise({
        try: () => readFile(certificatePath, "utf8"),
        catch: (error) => error,
      });
      return { privateKey, certificate };
    });
    return yield* Effect.ensuring(
      material,
      Effect.orDie(Effect.tryPromise({
        try: () => rm(directory, { recursive: true, force: true }),
        catch: (error) => error,
      })),
    );
  });
}

export function trustCertificate(
  certificate: string,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const directory = yield* Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "enable-banking-mcp-cert-")),
      catch: (error) => error,
    });
    const certificatePath = join(directory, "localhost.crt");
    const trust = Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => writeFile(certificatePath, certificate, { mode: 0o600 }),
        catch: (error) => error,
      });
      const keychainPath = join(
        homedir(),
        "Library",
        "Keychains",
        "login.keychain-db",
      );
      yield* runCommand(SECURITY_COMMAND, [
        "add-trusted-cert",
        "-r",
        "trustRoot",
        "-p",
        "ssl",
        "-k",
        keychainPath,
        certificatePath,
      ]);
    });
    yield* Effect.ensuring(
      trust,
      Effect.orDie(Effect.tryPromise({
        try: () => rm(directory, { recursive: true, force: true }),
        catch: (error) => error,
      })),
    );
  });
}

export function removeTrustedCertificate(
  certificate: string,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const fingerprint = yield* Effect.try({
      try: () =>
        new X509Certificate(certificate).fingerprint.replaceAll(":", ""),
      catch: () => new Error("Stored localhost certificate is invalid"),
    });
    const keychainPath = join(
      homedir(),
      "Library",
      "Keychains",
      "login.keychain-db",
    );
    const result = yield* runCommand(SECURITY_COMMAND, [
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
      return yield* Effect.fail(
        new Error("Unable to remove the localhost certificate trust"),
      );
    }
  });
}

export function callbackTlsFromApplication(
  application: StoredApplication,
): CallbackTlsOptions {
  return {
    key: Buffer.from(application.privateKey, "utf8"),
    cert: Buffer.from(application.certificate, "utf8"),
  };
}

type CommandResult = {
  code: number;
  stderr: string;
};


function runCommand(
  command: string,
  args: string[],
): Effect.Effect<CommandResult, unknown> {
  return Effect.try({
    try: () => spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] }),
    catch: (error) => error,
  }).pipe(
    Effect.flatMap((child) =>
      Effect.async<CommandResult, unknown>((resume) => {
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", () =>
          resume(
            Effect.fail(
              new Error("Required local setup command is unavailable"),
            ),
          ),
        );
        child.once("close", (code) =>
          resume(Effect.succeed({ code: code ?? 1, stderr })),
        );
        return Effect.sync(() => {
          child.kill();
        });
      }),
    ),
  );
}
