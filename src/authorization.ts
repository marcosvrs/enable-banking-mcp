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

export type BrowserOpener = (url: string) => void;

export type CallbackListener = {
  wait: Promise<string>;
  close: () => Promise<void>;
};

export type CallbackTlsOptions = {
  key: Buffer;
  cert: Buffer;
};

export type CallbackTlsOptionsProvider = () =>
  | CallbackTlsOptions
  | Promise<CallbackTlsOptions>;

export type CallbackListenerFactory = (
  redirect: LoopbackRedirect,
  expectedState: string,
  tlsOptionsProvider?: CallbackTlsOptionsProvider,
) => Promise<CallbackListener>;

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
      loadCallbackTlsOptions,
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

  async withCredentialCleanup<T>(operation: () => Promise<T>): Promise<T> {
    if (this.starting || this.pending || this.credentialCleanupPending) {
      throw new Error(
        "Cannot clear credentials while bank authorization or cleanup is pending",
      );
    }
    this.credentialCleanupPending = true;
    try {
      return await operation();
    } finally {
      this.credentialCleanupPending = false;
    }
  }

  async start(
    client: EnableBankingClient,
    options: BankAuthorizationOptions,
  ): Promise<AuthorizationStartResult> {
    this.reserve();
    return this.startReserved(client, options);
  }

  async startReserved(
    client: EnableBankingClient,
    options: BankAuthorizationOptions,
  ): Promise<AuthorizationStartResult> {
    if (!this.starting || this.pending) {
      throw new Error("Bank authorization reservation is not active");
    }

    let redirect: LoopbackRedirect;
    let validUntil: string;
    let state: string;
    let listener: CallbackListener;
    try {
      redirect = parseLoopbackRedirect(options.redirectUrl);
      validUntil = parseValidUntil(options.validUntil);
      state = randomBytes(32).toString("base64url");
      listener = await this.listenerFactory(
        redirect,
        state,
        this.tlsOptionsProvider,
      );
    } catch (error) {
      this.starting = false;
      throw error;
    }
    this.pending = { listener };
    this.starting = false;
    this.lastError = undefined;
    try {
      const authorization = await client.startAuthorization({
        aspsp: {
          name: options.aspspName.trim(),
          country: options.country.trim().toUpperCase(),
        },
        access: {
          balances: true,
          transactions: options.accessProfile === "balances_and_transactions",
          valid_until: validUntil,
        },
        state,
        redirect_url: options.redirectUrl,
        psu_type: "personal",
      });
      validateAuthorizationUrl(authorization.url);
      this.openBrowser(authorization.url);
      void this.finish(client, listener);
      return {
        status: "awaiting_user",
        authorization_url: authorization.url,
      };
    } catch (error) {
      if (this.pending?.listener === listener) {
        this.pending = undefined;
      }
      await listener.close();
      throw error;
    }
  }

  private async finish(
    client: EnableBankingClient,
    listener: CallbackListener,
  ): Promise<void> {
    try {
      const code = await listener.wait;
      const session = await client.createSession(code);
      await this.sessionStore.set(session.session_id);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      try {
        await listener.close();
      } catch (error) {
        if (!this.lastError) {
          this.lastError =
            error instanceof Error ? error.message : String(error);
        }
      } finally {
        if (this.pending?.listener === listener) {
          this.pending = undefined;
        }
      }
    }
  }
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

async function createCallbackListener(
  redirect: LoopbackRedirect,
  expectedState: string,
  tlsOptionsProvider: CallbackTlsOptionsProvider = loadCallbackTlsOptions,
): Promise<CallbackListener> {
  const { promise: codePromise, resolve, reject } =
    Promise.withResolvers<string>();
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
      reject(new Error("Bank authorization was denied"));
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
    resolve(code);
  };
  const server = createHttpsServer(
    await tlsOptionsProvider(),
    handleCallback,
  );

  const { promise: listening, resolve: markListening, reject: failListening } =
    Promise.withResolvers<void>();
  server.once("error", failListening);
  server.listen(redirect.port, redirect.hostname, () => markListening());
  try {
    await listening;
  } catch (error) {
    server.close();
    throw error;
  }

  const timeout = setTimeout(() => {
    reject(new Error("Bank authorization timed out"));
  }, CALLBACK_TIMEOUT_MS);
  timeout.unref();

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    if (!server.listening) return;
    const { promise: closedPromise, resolve: markClosed, reject: failClosed } =
      Promise.withResolvers<void>();
    server.close((error) => {
      if (error) failClosed(error);
      else markClosed();
    });
    await closedPromise;
  };

  return { wait: codePromise, close };
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

export function launchBrowser(url: string): void {
  const browser = spawn("/usr/bin/open", [url], {
    stdio: "ignore",
    detached: true,
  });
  browser.unref();
}
