import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { EnableBankingClient } from "./enable-banking.js";
import type { SessionStore } from "./session-store.js";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_CONSENT_DAYS = 30;
export const DEFAULT_REDIRECT_URL = "https://localhost:8765/callback";
const DEFAULT_TLS_CERT_PATH = join(
  homedir(),
  ".config/enable-banking-mcp/tls/localhost.crt",
);
const DEFAULT_TLS_KEY_PATH = join(
  homedir(),
  ".config/enable-banking-mcp/tls/localhost.key",
);
const LOOPBACK_HOSTS: Record<string, true> = {
  "127.0.0.1": true,
  localhost: true,
};

export interface BankAuthorizationOptions {
  aspspName: string;
  country: string;
  redirectUrl: string;
  validUntil?: string;
  psuType?: "personal" | "business";
  authMethod?: string;
  credentials?: Record<string, string>;
  credentialsAutosubmit?: boolean;
  language?: string;
  psuId?: string;
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

export type LoopbackRedirect = {
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
  path: string;
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
  private pending?: PendingAuthorization;
  private lastError?: string;

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
      pending: Boolean(this.pending),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async start(
    client: EnableBankingClient,
    options: BankAuthorizationOptions,
  ): Promise<AuthorizationStartResult> {
    if (this.pending) {
      throw new Error("Bank authorization is already in progress");
    }

    const redirect = parseLoopbackRedirect(options.redirectUrl);
    const validUntil = parseValidUntil(options.validUntil);
    const state = randomBytes(32).toString("base64url");
    const listener = await this.listenerFactory(
      redirect,
      state,
      this.tlsOptionsProvider,
    );
    const pending = { listener };
    this.pending = pending;
    this.lastError = undefined;
    try {
      const authorization = await client.startAuthorization({
        aspsp: {
          name: options.aspspName.trim(),
          country: options.country.trim().toUpperCase(),
        },
        access: {
          balances: true,
          transactions: true,
          valid_until: validUntil,
        },
        state,
        redirect_url: options.redirectUrl,
        ...(options.psuType ? { psu_type: options.psuType } : {}),
        ...(options.authMethod ? { auth_method: options.authMethod } : {}),
        ...(options.credentials ? { credentials: options.credentials } : {}),
        ...(options.credentialsAutosubmit !== undefined
          ? { credentials_autosubmit: options.credentialsAutosubmit }
          : {}),
        ...(options.language ? { language: options.language } : {}),
        ...(options.psuId ? { psu_id: options.psuId } : {}),
      });
      void this.finish(client, listener);
      this.openBrowser(authorization.url);
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
      await listener.close();
      if (this.pending?.listener === listener) {
        this.pending = undefined;
      }
    }
  }
}

export function parseLoopbackRedirect(value: string): LoopbackRedirect {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("redirect_url must be a valid URL");
  }
  const isLoopback = Boolean(LOOPBACK_HOSTS[url.hostname]);
  const isHttpLoopback = url.protocol === "http:" && isLoopback;
  const isHttpsLoopback = url.protocol === "https:" && isLoopback;
  if (
    (!isHttpLoopback && !isHttpsLoopback) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "redirect_url must be an http:// or https:// localhost or 127.0.0.1 URL without query parameters",
    );
  }
  const port = url.port ? Number(url.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("redirect_url must include a valid TCP port");
  }
  return {
    protocol: url.protocol === "http:" ? "http:" : "https:",
    hostname: url.hostname,
    port,
    path: url.pathname || "/",
  };
}

export function parseValidUntil(value?: string): string {
  const timestamp = value
    ? Date.parse(value)
    : Date.now() + DEFAULT_CONSENT_DAYS * 24 * 60 * 60 * 1000;
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

    const error = requestUrl.searchParams.get("error");
    if (error) {
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
  const server =
    redirect.protocol === "https:"
      ? createHttpsServer(await tlsOptionsProvider(), handleCallback)
      : createHttpServer(handleCallback);

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
