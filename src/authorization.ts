import { Cause, Effect } from "effect";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { EnableBankingClient } from "./enable-banking.js";
import type { SessionStore } from "./session-store.js";
import {
  parseLoopbackRedirect,
  type LoopbackRedirect,
} from "./redirect.js";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CONSENT_DAYS = 30;
export const DEFAULT_REDIRECT_URL = "https://localhost:8765/callback";
const RFC3339_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DEFAULT_TLS_CERT_PATH = join(
  homedir(),
  ".config/enable-banking-mcp/tls/localhost.crt",
);
const DEFAULT_TLS_KEY_PATH = join(
  homedir(),
  ".config/enable-banking-mcp/tls/localhost.key",
);

export type AccessProfile = "balances" | "balances_and_transactions";

export interface BankAuthorizationOptions {
  aspspName: string;
  country: string;
  redirectUrl: string;
  validUntil?: string;
  accessProfile?: AccessProfile;
}

export interface AuthorizationStartResult {
  status: "awaiting_user";
  authorization_url: string;
}

export type BrowserOpener = (
  url: string,
) => Effect.Effect<void, unknown>;

export type CallbackListener = {
  wait: Effect.Effect<string, unknown>;
  close: Effect.Effect<void, unknown>;
};

export type CallbackTlsOptions = {
  key: Buffer;
  cert: Buffer;
};

export type CallbackTlsOptionsProvider = () => Effect.Effect<
  CallbackTlsOptions,
  unknown
>;

export type CallbackListenerFactory = (
  redirect: LoopbackRedirect,
  expectedState: string,
  tlsOptionsProvider?: CallbackTlsOptionsProvider,
) => Effect.Effect<CallbackListener, unknown>;

type PendingAuthorization = {
  listener: CallbackListener;
};

export class BankAuthorizationFlow {
  private starting = false;
  private pending?: PendingAuthorization;
  private lastError?: string;
  private credentialCleanupPending = false;

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly openBrowser: BrowserOpener = launchBrowser,
    private readonly listenerFactory: CallbackListenerFactory =
      createCallbackListener,
    private readonly tlsOptionsProvider: CallbackTlsOptionsProvider =
      loadCallbackTlsOptionsEffect,
  ) {}

  get status(): { pending: boolean; lastError?: string } {
    return {
      pending: this.starting || Boolean(this.pending),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  reserve(): void {
    if (this.credentialCleanupPending) {
      throw new Error("Cannot start bank authorization while credential cleanup is pending");
    }
    if (this.starting || this.pending) {
      throw new Error("Bank authorization is already in progress");
    }
    this.starting = true;
    this.lastError = undefined;
  }

  release(): void {
    this.starting = false;
  }

  resetError(): void {
    this.lastError = undefined;
  }

  withCredentialCleanup<T>(
    operation: () => Effect.Effect<T, unknown>,
  ): Effect.Effect<T, unknown> {
    return Effect.gen(this, function* () {
      if (this.starting || this.pending || this.credentialCleanupPending) {
        return yield* Effect.fail(
          new Error(
            "Cannot clear credentials while bank authorization or cleanup is pending",
          ),
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

  start(
    client: EnableBankingClient,
    options: BankAuthorizationOptions,
  ): Effect.Effect<AuthorizationStartResult, unknown> {
    return Effect.gen(this, function* () {
      yield* Effect.sync(() => this.reserve());
      return yield* this.startReserved(client, options);
    });
  }

  startReserved(
    client: EnableBankingClient,
    options: BankAuthorizationOptions,
  ): Effect.Effect<AuthorizationStartResult, unknown> {
    let acquiredListener: CallbackListener | undefined;
    return Effect.gen(this, function* () {
      if (!this.starting || this.pending) {
        return yield* Effect.fail(
          new Error("Bank authorization reservation is not active"),
        );
      }

      let redirect: LoopbackRedirect;
      let state: string;
      let validUntil: string;
      try {
        redirect = parseLoopbackRedirect(options.redirectUrl);
        validUntil = parseValidUntil(options.validUntil);
        state = randomBytes(32).toString("base64url");
      } catch (error) {
        this.starting = false;
        return yield* Effect.fail(error);
      }
      const listenerResult = yield* Effect.exit(
        this.listenerFactory(redirect, state, this.tlsOptionsProvider),
      );
      if (listenerResult._tag === "Failure") {
        this.starting = false;
        return yield* Effect.fail(Cause.squash(listenerResult.cause));
      }
      const listener = acquiredListener = listenerResult.value;

      this.pending = { listener };
      this.starting = false;
      this.lastError = undefined;
      const authorizationResult = yield* Effect.exit(
        Effect.gen(this, function* () {
          const authorization = yield* client.startAuthorization({
            aspsp: {
              name: options.aspspName.trim(),
              country: options.country.trim().toUpperCase(),
            },
            access: {
              balances: true,
              transactions:
                (options.accessProfile ?? "balances_and_transactions") ===
                "balances_and_transactions",
              valid_until: validUntil,
            },
            state,
            redirect_url: options.redirectUrl,
            psu_type: "personal",
          });
          validateAuthorizationUrl(authorization.url);
          yield* this.openBrowser(authorization.url);
          return authorization.url;
        }),
      );
      if (authorizationResult._tag === "Failure") {
        if (this.pending?.listener === listener) {
          this.pending = undefined;
        }
        yield* listener.close.pipe(Effect.catchAllCause(() => Effect.void));
        return yield* Effect.fail(Cause.squash(authorizationResult.cause));
      }
      yield* Effect.forkDaemon(this.finish(client, listener));
      return {
        status: "awaiting_user" as const,
        authorization_url: authorizationResult.value,
      };
    }).pipe(
      Effect.onInterrupt(() => {
        this.starting = false;
        if (!acquiredListener) return Effect.void;
        if (this.pending?.listener === acquiredListener) this.pending = undefined;
        return acquiredListener.close.pipe(Effect.catchAll(() => Effect.void));
      }),
    );
  }

  private finish(
    client: EnableBankingClient,
    listener: CallbackListener,
  ): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const completion = Effect.gen(this, function* () {
        const code = yield* listener.wait;
        const session = yield* client.createSession(code);
        yield* this.sessionStore.set(session.session_id);
      });
      yield* completion.pipe(
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            this.lastError = messageForCause(cause);
          }),
        ),
      );
      yield* listener.close.pipe(
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            if (!this.lastError) this.lastError = messageForCause(cause);
          }),
        ),
      );
      if (this.pending?.listener === listener) {
        this.pending = undefined;
      }
    });
  }
}
function messageForCause(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
}


export function parseValidUntil(value?: string): string {
  if (value !== undefined) {
    if (!RFC3339_DATE_TIME.test(value)) {
      throw new Error("valid_until must be a future RFC3339 date-time");
    }
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [
      31,
      leapYear ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ][month - 1];
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth) {
      throw new Error("valid_until must be a future RFC3339 date-time");
    }
  }
  const timestamp =
    value === undefined
      ? Date.now() + DEFAULT_CONSENT_DAYS * 24 * 60 * 60 * 1000
      : Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new Error("valid_until must be a future RFC3339 date-time");
  }
  return new Date(timestamp).toISOString();
}

export function loadCallbackTlsOptions(): CallbackTlsOptions {
  const certPath =
    process.env.ENABLE_BANKING_TLS_CERT?.trim() || DEFAULT_TLS_CERT_PATH;
  const keyPath =
    process.env.ENABLE_BANKING_TLS_KEY?.trim() || DEFAULT_TLS_KEY_PATH;
  try {
    return {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
    };
  } catch {
    throw new Error(
      "Local HTTPS certificate is unavailable; configure ENABLE_BANKING_TLS_CERT and ENABLE_BANKING_TLS_KEY",
    );
  }
}

function loadCallbackTlsOptionsEffect(): Effect.Effect<
  CallbackTlsOptions,
  unknown
> {
  return Effect.try({
    try: loadCallbackTlsOptions,
    catch: (error) => error,
  });
}

function createCallbackListener(
  redirect: LoopbackRedirect,
  expectedState: string,
  tlsOptionsProvider: CallbackTlsOptionsProvider = loadCallbackTlsOptionsEffect,
): Effect.Effect<CallbackListener, unknown> {
  return Effect.gen(function* () {
    let timeout: NodeJS.Timeout | undefined;
    const tlsOptions = yield* tlsOptionsProvider();
    let resumeCallback: ((effect: Effect.Effect<string, unknown>) => void) | undefined;
    const wait = Effect.async<string, unknown>((resume) => {
      resumeCallback = resume;
      timeout = setTimeout(
        () => resume(Effect.fail(new Error("Bank authorization timed out"))),
        CALLBACK_TIMEOUT_MS,
      );
      timeout.unref();
      return Effect.sync(() => clearTimeout(timeout));
    });
    const handleCallback = (
      request: IncomingMessage,
      response: ServerResponse,
    ): void => {
      const requestUrl = new URL(
        request.url ?? "/",
        `${redirect.protocol}//${redirect.hostname}:${redirect.port}`,
      );
      if (request.method !== "GET" || requestUrl.pathname !== redirect.path) {
        response.writeHead(404);
        response.end();
        return;
      }
      const receivedState = requestUrl.searchParams.get("state");
      if (!receivedState || !sameSecret(expectedState, receivedState)) {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("Invalid authorization state.");
        return;
      }
      if (requestUrl.searchParams.has("error")) {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("Bank authorization was denied.");
        resumeCallback?.(Effect.fail(new Error("Bank authorization was denied")));
        return;
      }
      const code = requestUrl.searchParams.get("code");
      if (!code) {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("Authorization code was not provided.");
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("Bank authorization complete. You may close this window.");
      resumeCallback?.(Effect.succeed(code));
    };
    const server = yield* Effect.try({
      try: () => createHttpsServer(tlsOptions, handleCallback),
      catch: (error) => error,
    });
    yield* Effect.async<void, unknown>((resume) => {
      server.once("error", (error) => resume(Effect.fail(error)));
      server.listen(redirect.port, redirect.hostname, () =>
        resume(Effect.succeed(undefined)),
      );
      return Effect.sync(() => {
        if (!server.listening) server.close();
      });
    });

    let closed = false;
    const close = Effect.suspend(() => {
      if (closed) return Effect.void;
      closed = true;
      clearTimeout(timeout);
      return Effect.async<void, unknown>((resume) => {
        if (!server.listening) {
          resume(Effect.succeed(undefined));
          return;
        }
        server.close((error) => {
          if (error) resume(Effect.fail(error));
          else resume(Effect.succeed(undefined));
        });
      });
    });
    return { wait, close };
  });
}

function validateAuthorizationUrl(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new Error("Enable Banking returned an invalid authorization URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enable Banking returned an invalid authorization URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Enable Banking returned an invalid authorization URL");
  }
}
function sameSecret(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

export function launchBrowser(url: string): Effect.Effect<void, unknown> {
  return Effect.try({
    try: () => {
      const browser = spawn("/usr/bin/open", [url], {
        stdio: "ignore",
        detached: true,
      });
      browser.unref();
    },
    catch: (error) => error,
  });
}
