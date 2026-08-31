import { z } from "zod";
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

export type ControlPanelHttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

export interface ControlPanelRequestOptions {
  method?: ControlPanelHttpMethod;
  body?: unknown;
  bodyEncoding?: "json" | "form";
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
}

export interface ControlPanelRoute {
  methods: readonly ControlPanelHttpMethod[];
  pattern: RegExp;
}

export const CONTROL_PANEL_ROUTES: readonly ControlPanelRoute[] = [
  {
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    pattern: /^\/api\/applications\/?$/,
  },
  {
    methods: ["GET"],
    pattern: /^\/api\/application\/[^/]+\/?$/,
  },
  { methods: ["GET"], pattern: /^\/api\/aspsps\/?$/ },
  { methods: ["POST"], pattern: /^\/api\/link_accounts\/?$/ },
  { methods: ["POST"], pattern: /^\/api\/unlink_accounts\/?$/ },
  { methods: ["GET"], pattern: /^\/api\/auth_redirect\/?$/ },
  { methods: ["POST"], pattern: /^\/api\/link_payment_accounts\/?$/ },
  { methods: ["POST"], pattern: /^\/api\/link_sandbox_payment_accounts\/?$/ },
  { methods: ["GET"], pattern: /^\/api\/payment_accounts\/?$/ },
  { methods: ["DELETE"], pattern: /^\/api\/payment_accounts\/?$/ },
  { methods: ["GET"], pattern: /^\/api\/payment_auth_redirect\/?$/ },
  { methods: ["POST"], pattern: /^\/api\/get_consents\/?$/ },
  { methods: ["GET"], pattern: /^\/api\/consent_revocation_redirect\/?$/ },
  { methods: ["POST"], pattern: /^\/api\/revoke_consent\/?$/ },
  { methods: ["GET"], pattern: /^\/api\/requests\/?$/ },
  { methods: ["GET"], pattern: /^\/api\/requestLogs\/?$/ },
  { methods: ["GET"], pattern: /^\/api\/app_statistics\/?$/ },
  { methods: ["GET"], pattern: /^\/api\/get_today_stats\/?$/ },
  { methods: ["GET"], pattern: /^\/api\/get_past_stats\/?$/ },
  { methods: ["GET"], pattern: /^\/api\/get_traffic_stats\/?$/ },
  {
    methods: ["GET"],
    pattern: /^\/api\/v2\/cp\/monitoring\/disruptions\/?$/,
  },
  { methods: ["GET"], pattern: /^\/api\/getBrokers\/?$/ },
  { methods: ["GET"], pattern: /^\/api\/get_sso_jwt\/?$/ },
  { methods: ["POST"], pattern: /^\/api\/shareApplication\/?$/ },
  { methods: ["GET", "POST", "DELETE"], pattern: /^\/api\/subscriptions\/?$/ },
  { methods: ["GET"], pattern: /^\/api\/billing\/accounts\/?$/ },
  {
    methods: ["GET"],
    pattern: /^\/api\/billing\/accounts\/[^/]+\/details\/?$/,
  },
  { methods: ["GET"], pattern: /^\/api\/billing\/invoices\/?$/ },
  { methods: ["POST"], pattern: /^\/api\/billing\/quote-requests\/?$/ },
  { methods: ["GET"], pattern: /^\/api\/onboarding\/plans\/?$/ },
  { methods: ["GET"], pattern: /^\/api\/onboarding\/tasks\/?$/ },
  { methods: ["GET"], pattern: /^\/api\/onboarding\/integrations\/?$/ },
  { methods: ["GET", "POST"], pattern: /^\/api\/packages\/?$/ },
  { methods: ["POST"], pattern: /^\/api\/connectors\/?$/ },
  { methods: ["POST"], pattern: /^\/api\/users\/?$/ },
  { methods: ["POST"], pattern: /^\/api\/data-insights\/?$/ },
];

export function isControlPanelRouteAllowed(
  method: ControlPanelHttpMethod,
  path: string,
): boolean {
  return CONTROL_PANEL_ROUTES.some(
    (route) => route.methods.includes(method) && route.pattern.test(path),
  );
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
    await this.request("/api/relyingparty/getOobConfirmationCode", {
      method: "POST",
      body: {
        requestType: "EMAIL_SIGNIN",
        email: normalizedEmail,
        continueUrl: `http://localhost:${callbackPort}${callbackPath}`,
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
        method: "POST",
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
        method: "POST",
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

  async requestAuthenticated<T = unknown>(
    auth: ControlPanelAuth,
    path: string,
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

  async request<T = unknown>(
    path: string,
    options: ControlPanelRequestOptions = {},
  ): Promise<T> {
    if (!path.startsWith("/")) {
      throw new Error("Control Panel paths must start with /");
    }
    const baseUrl = this.baseUrl.replace(/\/+$/, "");
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...options.headers,
    };
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (options.body !== undefined) {
      if (options.bodyEncoding === "form") {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        if (typeof options.body === "string") {
          init.body = options.body;
        } else {
          const form = new URLSearchParams();
          if (
            typeof options.body !== "object" ||
            options.body === null ||
            Array.isArray(options.body)
          ) {
            throw new Error("form request bodies must be objects or strings");
          }
          for (const [key, value] of Object.entries(
            options.body as Record<string, unknown>,
          )) {
            if (value === undefined) continue;
            form.set(
              key,
              typeof value === "object" && value !== null
                ? JSON.stringify(value)
                : String(value),
            );
          }
          init.body = form.toString();
        }
      } else {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(options.body);
      }
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
  const callbackPath = "/";
  const { promise: codePromise, resolve, reject } =
    Promise.withResolvers<string>();
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

    const error = requestUrl.searchParams.get("error");
    if (error) {
      response.writeHead(400, { "content-type": "text/plain" });
      response.end("Enable Banking sign-in was denied.");
      reject(new Error("Enable Banking Control Panel sign-in was denied"));
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
    resolve(confirmationCode);
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
    reject(new Error("Enable Banking Control Panel sign-in timed out"));
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

  return { port, path: callbackPath, wait: codePromise, close };
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
