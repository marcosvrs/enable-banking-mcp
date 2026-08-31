import { z } from "zod";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { ApplicationEnvironment } from "./application-store.js";

const CONTROL_PANEL_BASE_URL = "https://enablebanking.com";
const FIREBASE_SECURE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token";
const REQUEST_TIMEOUT_MS = 30_000;
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;
const ControlPanelLoginResponse = z.object({
  idToken: z.string().min(1),
  refreshToken: z.string().min(1),
  localId: z.string().min(1).optional(),
  expiresIn: z.union([z.string(), z.number()]).optional(),
});
const ControlPanelRefreshResponse = z.object({
  id_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  user_id: z.string().min(1).optional(),
  expires_in: z.union([z.string(), z.number()]).optional(),
});
const ApplicationRegistrationResponse = z.object({
  app_id: z.string().min(1),
});

type ControlPanelPath =
  | "/api/relyingparty/getOobConfirmationCode"
  | "/api/relyingparty/emailLinkSignin"
  | "/api/applications";

interface ControlPanelRequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ControlPanelAuth {
  email: string;
  idToken: string;
  refreshToken: string;
  localId?: string;
  expiresAt?: number;
}

export interface ApplicationRegistrationRequest {
  name: string;
  certificate: string;
  environment: ApplicationEnvironment;
  redirect_urls: string[];
  description?: string;
  gdpr_email?: string;
  privacy_url?: string;
  terms_url?: string;
}

export class ControlPanelApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`Enable Banking Control Panel ${status}: ${message}`);
    this.name = "ControlPanelApiError";
  }
}

export class ControlPanelClient {
  constructor(
    private readonly fetchFn: typeof fetch = globalThis.fetch,
    private readonly baseUrl = CONTROL_PANEL_BASE_URL,
    private readonly firebaseApiKey =
      process.env.ENABLE_BANKING_FIREBASE_API_KEY?.trim(),
  ) {}

  async requestEmailLogin(
    email: string,
    callbackPort: number,
    callbackPath: string,
  ): Promise<void> {
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      throw new Error("control_panel_email must be a valid email address");
    }
    if (
      !Number.isInteger(callbackPort) ||
      callbackPort < 1 ||
      callbackPort > 65535
    ) {
      throw new Error("Control Panel callback port is invalid");
    }
    const callbackUrl = validateCallbackPath(callbackPath);
    await this.request("/api/relyingparty/getOobConfirmationCode", {
      body: {
        requestType: "EMAIL_SIGNIN",
        email: normalizedEmail,
        continueUrl: `http://localhost:${callbackPort}${callbackUrl}`,
        canHandleCodeInApp: true,
      },
    });
  }

  async completeEmailLogin(
    email: string,
    confirmationCode: string,
  ): Promise<ControlPanelAuth> {
    const result = await this.request<unknown>(
      "/api/relyingparty/emailLinkSignin",
      {
        body: {
          oobCode: confirmationCode,
          email: email.trim(),
        },
      },
    );
    const parsed = ControlPanelLoginResponse.safeParse(result);
    if (!parsed.success) {
      throw new Error(
        "Enable Banking Control Panel returned an invalid login response",
      );
    }
    const expiresIn = Number(parsed.data.expiresIn);
    const expiresAt =
      Number.isFinite(expiresIn) && expiresIn > 0
        ? Date.now() + Math.max(0, expiresIn - 60) * 1000
        : undefined;
    return {
      email: email.trim(),
      idToken: parsed.data.idToken,
      refreshToken: parsed.data.refreshToken,
      ...(parsed.data.localId ? { localId: parsed.data.localId } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  async refreshAuth(auth: ControlPanelAuth): Promise<ControlPanelAuth> {
    if (!this.firebaseApiKey) {
      throw new Error(
        "Control Panel token refresh requires ENABLE_BANKING_FIREBASE_API_KEY",
      );
    }
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    };
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
    });
    const response = await this.fetchFn(
      `${FIREBASE_SECURE_TOKEN_URL}?key=${encodeURIComponent(this.firebaseApiKey)}`,
      {
        method: "POST",
        headers,
        body: body.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    const raw = await response.text();
    const result = parseJson(raw);
    if (!response.ok) {
      throw new ControlPanelApiError(
        response.status,
        extractErrorMessage(result) || response.statusText || "token refresh failed",
      );
    }
    const parsed = ControlPanelRefreshResponse.safeParse(result);
    if (!parsed.success) {
      throw new Error(
        "Enable Banking Control Panel returned an invalid refresh response",
      );
    }
    const expiresIn = Number(parsed.data.expires_in);
    const expiresAt =
      Number.isFinite(expiresIn) && expiresIn > 0
        ? Date.now() + Math.max(0, expiresIn - 60) * 1000
        : undefined;
    return {
      email: auth.email,
      idToken: parsed.data.id_token,
      refreshToken: parsed.data.refresh_token ?? auth.refreshToken,
      ...(parsed.data.user_id
        ? { localId: parsed.data.user_id }
        : auth.localId
          ? { localId: auth.localId }
          : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  async registerApplication(
    auth: ControlPanelAuth,
    request: ApplicationRegistrationRequest,
  ): Promise<{ app_id: string }> {
    const result = await this.requestAuthenticated<unknown>(
      auth,
      "/api/applications",
      {
        body: request,
      },
    );
    const parsed = ApplicationRegistrationResponse.safeParse(result);
    if (!parsed.success) {
      throw new Error(
        "Enable Banking Control Panel returned an invalid application registration response",
      );
    }
    return parsed.data;
  }

  private async requestAuthenticated<T = unknown>(
    auth: ControlPanelAuth,
    path: ControlPanelPath,
    options: ControlPanelRequestOptions = {},
  ): Promise<T> {
    return this.request<T>(path, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${auth.idToken}`,
      },
    });
  }

  private async request<T = unknown>(
    path: ControlPanelPath,
    options: ControlPanelRequestOptions = {},
  ): Promise<T> {
    const baseUrl = this.baseUrl.replace(/\/+$/, "");
    const url = new URL(`${baseUrl}${path}`);
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...options.headers,
    };
    const init: RequestInit = {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }

    const response = await this.fetchFn(url, init);
    const raw = await response.text();
    const body = parseJson(raw);
    if (!response.ok) {
      throw new ControlPanelApiError(
        response.status,
        extractErrorMessage(body) || response.statusText || "request failed",
      );
    }
    return body as T;
  }
}

export type ControlPanelCallbackListener = {
  port: number;
  path: string;
  wait: Promise<string>;
  close: () => Promise<void>;
};

export type ControlPanelCallbackListenerFactory = () => Promise<ControlPanelCallbackListener>;

export class ControlPanelAuthFlow {
  constructor(
    private readonly client: ControlPanelClient,
    private readonly listenerFactory: ControlPanelCallbackListenerFactory =
      createControlPanelCallbackListener,
  ) {}

  async authenticate(email: string): Promise<ControlPanelAuth> {
    const listener = await this.listenerFactory();
    try {
      await this.client.requestEmailLogin(email, listener.port, listener.path);
      const confirmationCode = await listener.wait;
      return await this.client.completeEmailLogin(email, confirmationCode);
    } finally {
      await listener.close();
    }
  }
}

export async function createControlPanelCallbackListener(): Promise<ControlPanelCallbackListener> {
  const callbackPath = "/callback";
  const expectedState = randomBytes(32).toString("base64url");
  const callbackUrl = `${callbackPath}?state=${encodeURIComponent(expectedState)}`;
  const { promise: codePromise, resolve, reject } =
    Promise.withResolvers<string>();
  let settled = false;
  const server = createServer((request, response) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url ?? "/", "http://localhost");
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    if (request.method !== "GET" || requestUrl.pathname !== callbackPath) {
      response.writeHead(404);
      response.end();
      return;
    }

    const receivedState = requestUrl.searchParams.get("state");
    if (!receivedState || !sameSecret(expectedState, receivedState)) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("Invalid Enable Banking sign-in state.");
      return;
    }

    if (requestUrl.searchParams.has("error")) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("Enable Banking sign-in was denied.");
      if (!settled) {
        settled = true;
        reject(new Error("Enable Banking Control Panel sign-in was denied"));
      }
      return;
    }

    const confirmationCode = requestUrl.searchParams.get("oobCode");
    if (!confirmationCode) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("The Enable Banking sign-in code was not provided.");
      return;
    }

    response.writeHead(200, { "content-type": "text/plain" });
    response.end("Enable Banking sign-in complete. You may close this window.");
    if (!settled) {
      settled = true;
      resolve(confirmationCode);
    }
  });

  const { promise: listening, resolve: markListening, reject: failListening } =
    Promise.withResolvers<number>();
  server.once("error", failListening);
  server.listen(0, "localhost", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      failListening(new Error("Control Panel callback listener did not expose a port"));
      return;
    }
    markListening(address.port);
  });

  let port: number;
  try {
    port = await listening;
  } catch (error) {
    server.close();
    throw error;
  }

  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      reject(new Error("Enable Banking Control Panel sign-in timed out"));
    }
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

  return { port, path: callbackUrl, wait: codePromise, close };
}

function validateCallbackPath(value: string): string {
  let url: URL;
  try {
    url = new URL(value, "http://localhost");
  } catch {
    throw new Error("Control Panel callback path is invalid");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "localhost" ||
    url.pathname !== "/callback" ||
    url.hash ||
    url.searchParams.size !== 1 ||
    !url.searchParams.has("state") ||
    !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("state") ?? "")
  ) {
    throw new Error("Control Panel callback path must contain a valid state");
  }
  return `${url.pathname}?${url.searchParams.toString()}`;
}

function sameSecret(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}
function parseJson(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { message: raw };
  }
}

function extractErrorMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["message", "error", "detail"]) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  return undefined;
}
