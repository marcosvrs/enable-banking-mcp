import { Effect } from "effect";

import { z } from "zod";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { ApplicationEnvironment } from "./application-store.js";

const CONTROL_PANEL_BASE_URL = "https://enablebanking.com";
const FIREBASE_SECURE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token";
// Public Firebase web key from Enable Banking's Control Panel client bundle.
const CONTROL_PANEL_FIREBASE_WEB_KEY =
  "AIzaSyBn8fvjRYQKslskRaO3cblUjmcyl5b9o-c"; // gitleaks:allow -- public Control Panel Firebase client key
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

  requestEmailLogin(
    email: string,
    callbackPort: number,
    callbackPath: string,
  ): Effect.Effect<void, unknown> {
    return Effect.gen(
      function* (this: ControlPanelClient) {
        const normalizedEmail = email.trim();
        if (!normalizedEmail || !normalizedEmail.includes("@")) {
          return yield* Effect.fail(
            new Error("control_panel_email must be a valid email address"),
          );
        }
        if (
          !Number.isInteger(callbackPort) ||
          callbackPort < 1 ||
          callbackPort > 65535
        ) {
          return yield* Effect.fail(new Error("Control Panel callback port is invalid"));
        }
        const callbackUrl = validateCallbackPath(callbackPath);
        yield* this.request("/api/relyingparty/getOobConfirmationCode", {
          body: {
            requestType: "EMAIL_SIGNIN",
            email: normalizedEmail,
            continueUrl: `http://localhost:${callbackPort}${callbackUrl}`,
            canHandleCodeInApp: true,
          },
        });
      }.bind(this),
    );
  }

  completeEmailLogin(
    email: string,
    confirmationCode: string,
  ): Effect.Effect<ControlPanelAuth, unknown> {
    return Effect.gen(
      function* (this: ControlPanelClient) {
        const result = yield* this.request<unknown>(
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
          return yield* Effect.fail(
            new Error(
              "Enable Banking Control Panel returned an invalid login response",
            ),
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
      }.bind(this),
    );
  }

  refreshAuth(
    auth: ControlPanelAuth,
  ): Effect.Effect<ControlPanelAuth, unknown> {
    return Effect.gen(
      function* (this: ControlPanelClient) {
        const firebaseApiKey =
          this.firebaseApiKey || CONTROL_PANEL_FIREBASE_WEB_KEY;
        const headers = {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        };
        const body = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: auth.refreshToken,
        });
        const response = yield* Effect.tryPromise({
          try: () =>
            this.fetchFn(
              `${FIREBASE_SECURE_TOKEN_URL}?key=${encodeURIComponent(firebaseApiKey)}`,
              {
                method: "POST",
                headers,
                body: body.toString(),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
              },
            ),
          catch: (error) => error,
        });
        const raw = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (error) => error,
        });
        const result = parseJson(raw);
        if (!response.ok) {
          return yield* Effect.fail(
            new ControlPanelApiError(
              response.status,
              extractErrorMessage(result) ||
                response.statusText ||
                "token refresh failed",
            ),
          );
        }
        const parsed = ControlPanelRefreshResponse.safeParse(result);
        if (!parsed.success) {
          return yield* Effect.fail(
            new Error(
              "Enable Banking Control Panel returned an invalid refresh response",
            ),
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
      }.bind(this),
    );
  }

  registerApplication(
    auth: ControlPanelAuth,
    request: ApplicationRegistrationRequest,
  ): Effect.Effect<{ app_id: string }, unknown> {
    return Effect.gen(
      function* (this: ControlPanelClient) {
        const result = yield* this.requestAuthenticated<unknown>(
          auth,
          "/api/applications",
          { body: request },
        );
        const parsed = ApplicationRegistrationResponse.safeParse(result);
        if (!parsed.success) {
          return yield* Effect.fail(
            new Error(
              "Enable Banking Control Panel returned an invalid application registration response",
            ),
          );
        }
        return parsed.data;
      }.bind(this),
    );
  }

  private requestAuthenticated<T = unknown>(
    auth: ControlPanelAuth,
    path: ControlPanelPath,
    options: ControlPanelRequestOptions = {},
  ): Effect.Effect<T, unknown> {
    return this.request<T>(path, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${auth.idToken}`,
      },
    });
  }

  private request<T = unknown>(
    path: ControlPanelPath,
    options: ControlPanelRequestOptions = {},
  ): Effect.Effect<T, unknown> {
    return Effect.gen(
      function* (this: ControlPanelClient) {
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

        const response = yield* Effect.tryPromise({
          try: () => this.fetchFn(url, init),
          catch: (error) => error,
        });
        const raw = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (error) => error,
        });
        const body = parseJson(raw);
        if (!response.ok) {
          return yield* Effect.fail(
            new ControlPanelApiError(
              response.status,
              extractErrorMessage(body) || response.statusText || "request failed",
            ),
          );
        }
        return body as T;
      }.bind(this),
    );
  }
}

export type ControlPanelCallbackListener = {
  port: number;
  path: string;
  wait: Effect.Effect<string, unknown>;
  close: Effect.Effect<void, unknown>;
};

export type ControlPanelCallbackListenerFactory =
  () => Effect.Effect<ControlPanelCallbackListener, unknown>;

export class ControlPanelAuthFlow {
  private activeAuthenticationCount = 0;
  private credentialCleanupPending = false;

  constructor(
    private readonly client: ControlPanelClient,
    private readonly listenerFactory: ControlPanelCallbackListenerFactory =
      createControlPanelCallbackListener,
  ) {}

  withAuthentication<T>(
    operation: (
      authenticate: (
        email: string,
        existingAuth?: ControlPanelAuth,
      ) => Effect.Effect<ControlPanelAuth, unknown>,
    ) => Effect.Effect<T, unknown>,
  ): Effect.Effect<T, unknown> {
    return Effect.acquireUseRelease(
      Effect.gen(
        function* (this: ControlPanelAuthFlow) {
          if (this.credentialCleanupPending) {
            return yield* Effect.fail(
              new Error("Control Panel credentials are being cleared"),
            );
          }
          if (this.activeAuthenticationCount > 0) {
            return yield* Effect.fail(
              new Error("Control Panel authentication is already in progress"),
            );
          }
          this.activeAuthenticationCount += 1;
          return { active: true };
        }.bind(this),
      ),
      (reservation) =>
        operation((email, existingAuth) =>
          reservation.active
            ? this.authenticateWhileReserved(email, existingAuth)
            : Effect.fail(
                new Error(
                  "Control Panel authentication reservation has ended",
                ),
              ),
        ),
      (reservation) =>
        Effect.sync(() => {
          reservation.active = false;
          this.activeAuthenticationCount -= 1;
        }),
    );
  }

  withCredentialCleanup<T>(
    operation: () => Effect.Effect<T, unknown>,
  ): Effect.Effect<T, unknown> {
    return Effect.acquireUseRelease(
      Effect.gen(
        function* (this: ControlPanelAuthFlow) {
          if (
            this.activeAuthenticationCount > 0 ||
            this.credentialCleanupPending
          ) {
            return yield* Effect.fail(
              new Error(
                "Cannot clear credentials while Control Panel authentication or cleanup is pending",
              ),
            );
          }
          this.credentialCleanupPending = true;
        }.bind(this),
      ),
      operation,
      () =>
        Effect.sync(() => {
          this.credentialCleanupPending = false;
        }),
    );
  }

  authenticate(
    email: string,
    existingAuth?: ControlPanelAuth,
  ): Effect.Effect<ControlPanelAuth, unknown> {
    return this.withAuthentication((authenticate) =>
      authenticate(email, existingAuth),
    );
  }

  private authenticateWhileReserved(
    email: string,
    existingAuth?: ControlPanelAuth,
  ): Effect.Effect<ControlPanelAuth, unknown> {
    return Effect.gen(
      function* (this: ControlPanelAuthFlow) {
        const normalizedEmail = email.trim();
        if (
          existingAuth &&
          existingAuth.email.trim().toLowerCase() ===
            normalizedEmail.toLowerCase()
        ) {
          if (
            existingAuth.expiresAt !== undefined &&
            existingAuth.expiresAt > Date.now()
          ) {
            return existingAuth;
          }

          const refreshed = yield* Effect.catchAll(
            this.client.refreshAuth(existingAuth),
            (error) => {
              const refreshRejected =
                error instanceof ControlPanelApiError &&
                (error.status === 400 || error.status === 401);
              return refreshRejected
                ? Effect.succeed(undefined)
                : Effect.fail(error);
            },
          );
          if (refreshed) return refreshed;
        }

        const listener = yield* this.listenerFactory();
        return yield* Effect.ensuring(
          Effect.gen(
            function* (this: ControlPanelAuthFlow) {
              yield* this.client.requestEmailLogin(
                normalizedEmail,
                listener.port,
                listener.path,
              );
              const confirmationCode = yield* listener.wait;
              return yield* this.client.completeEmailLogin(
                normalizedEmail,
                confirmationCode,
              );
            }.bind(this),
          ),
          listener.close.pipe(Effect.orDie),
        );
      }.bind(this),
    );
  }
}

export function createControlPanelCallbackListener():
  Effect.Effect<ControlPanelCallbackListener, unknown> {
  return Effect.gen(function* () {
    const callbackPath = "/callback";
    const expectedState = randomBytes(32).toString("base64url");
    const callbackUrl = `${callbackPath}?state=${encodeURIComponent(expectedState)}`;
    const { promise: codePromise, resolve, reject } =
      Promise.withResolvers<string>();
    void codePromise.catch(() => {});
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

    const listening = yield* Effect.tryPromise({
      try: () =>
        new Promise<number>((resolveListening, rejectListening) => {
          server.once("error", rejectListening);
          server.listen(0, "localhost", () => {
            const address = server.address();
            /* c8 ignore next 4 -- listen(0, "localhost") guarantees a TCP address before this callback. */
            if (!address || typeof address === "string") {
              rejectListening(
                new Error("Control Panel callback listener did not expose a port"),
              );
              return;
            }
            resolveListening(address.port);
          });
        }),
      catch: (error) => error,
    }).pipe(
      Effect.catchAll((error) =>
        Effect.tryPromise({
          try: () =>
            new Promise<void>((resolveClose) => {
              server.close(() => resolveClose());
            }),
          catch: () => error,
        }).pipe(Effect.flatMap(() => Effect.fail(error))),
      ),
    );

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Enable Banking Control Panel sign-in timed out"));
      }
    }, CALLBACK_TIMEOUT_MS);
    timeout.unref();

    let closed = false;
    const close = Effect.gen(function* () {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      if (!server.listening) return;
      yield* Effect.tryPromise({
        try: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error) rejectClose(error);
              else resolveClose();
            });
          }),
        catch: (error) => error,
      });
    });

    return {
      port: listening,
      path: callbackUrl,
      wait: Effect.tryPromise({
        try: () => codePromise,
        catch: (error) => error,
      }),
      close,
    };
  });
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
