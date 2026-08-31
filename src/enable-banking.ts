import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import type { EnableBankingCredentials } from "./config.js";
import { parseLoopbackRedirect } from "./redirect.js";

export const API_BASE_URL = "https://api.enablebanking.com";
const JWT_TTL_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 30_000;
const RFC3339_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const TOKEN_REFRESH_LEEWAY_SECONDS = 30;

export interface TransactionQuery {
  dateFrom?: string;
  dateTo?: string;
  continuationKey?: string;
  transactionStatus?: "BOOK" | "CNCL" | "HOLD" | "OTHR" | "PDNG" | "RJCT" | "SCHD";
  strategy?: "default" | "longest";
  limit: number;
}

export interface TransactionPage {
  transactions?: unknown[];
  continuation_key?: string | null;
  [key: string]: unknown;
}

export interface AuthorizationRequest {
  aspsp: {
    name: string;
    country: string;
  };
  access: {
    balances: boolean;
    transactions: boolean;
    valid_until: string;
  };
  state: string;
  redirect_url: string;
  psu_type: "personal";
}

export interface AuthorizationResponse {
  url: string;
  authorization_id: string;
  psu_id_hash: string;
  [key: string]: unknown;
}

export interface SessionResponse {
  session_id: string;
  [key: string]: unknown;
}

export interface ApplicationResponse {
  name: string;
  description?: string;
  kid: string;
  environment: "PRODUCTION" | "SANDBOX";
  redirect_urls: string[];
  active: boolean;
  countries: string[];
  services: string[];
  [key: string]: unknown;
}

export interface EnableBankingErrorDetails {
  code?: number;
  error?: string;
  detail?: string;
}

export class EnableBankingApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: EnableBankingErrorDetails = {},
    readonly retryAfter?: string,
  ) {
    super(`Enable Banking API ${status}: ${message}`);
    this.name = "EnableBankingApiError";
  }
}

export function privateKeyFromValue(value: string): KeyObject {
  const normalized = value.trim().replace(/\\n/g, "\n");

  if (normalized.includes("BEGIN")) {
    return createPrivateKey(normalized);
  }

  let der: Buffer;
  try {
    der = Buffer.from(normalized, "base64");
  } catch {
    throw new Error(
      "ENABLE_BANKING_PRIVATE_KEY must be PEM or base64-encoded DER",
    );
  }

  if (der.length === 0) {
    throw new Error(
      "ENABLE_BANKING_PRIVATE_KEY must be PEM or base64-encoded DER",
    );
  }

  let lastError: unknown;
  for (const type of ["pkcs8", "pkcs1"] as const) {
    try {
      return createPrivateKey({ key: der, format: "der", type });
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `ENABLE_BANKING_PRIVATE_KEY is not a readable RSA private key: ${lastError instanceof Error ? lastError.message : "invalid key"}`,
  );
}

export function createJwt(
  credentials: EnableBankingCredentials,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  return signJwtWithKey(
    credentials.appId,
    privateKeyFromValue(credentials.privateKey),
    nowSeconds,
  );
}

export async function getHealth(
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<unknown> {
  const response = await fetchFn(`${API_BASE_URL}/health`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await response.text();
  const body = parseJson(raw);
  if (!response.ok) {
    throw new EnableBankingApiError(
      response.status,
      extractErrorMessage(body) || response.statusText || "request failed",
      extractErrorDetails(body),
      response.headers.get("retry-after") ?? undefined,
    );
  }
  return body;
}

export class EnableBankingClient {
  private readonly key: KeyObject;
  private cachedToken?: {
    value: string;
    expiresAt: number;
  };

  constructor(
    private readonly credentials: EnableBankingCredentials,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {
    this.key = privateKeyFromValue(credentials.privateKey);
  }

  async listBanks(country?: string): Promise<unknown> {
    const params = new URLSearchParams({
      psu_type: "personal",
      service: "AIS",
    });
    if (country !== undefined) {
      const code = country.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(code)) {
        throw new Error("country must be a two-letter ISO 3166-1 code");
      }
      params.set("country", code);
    }
    return this.request(`/aspsps?${params.toString()}`);
  }

  async startAuthorization(
    request: AuthorizationRequest,
  ): Promise<AuthorizationResponse> {
    const country = request.aspsp.country.trim().toUpperCase();
    const name = request.aspsp.name.trim();
    if (!/^[A-Z]{2}$/.test(country)) {
      throw new Error("country must be a two-letter ISO 3166-1 code");
    }
    if (!name) {
      throw new Error("aspsp.name is required");
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(request.state)) {
      throw new Error("state must be a 256-bit base64url value");
    }
    if (request.psu_type !== "personal") {
      throw new Error("psu_type must be personal");
    }
    if (
      typeof request.access.balances !== "boolean" ||
      typeof request.access.transactions !== "boolean"
    ) {
      throw new Error("access.balances and access.transactions must be boolean");
    }
    parseLoopbackRedirect(request.redirect_url);
    const validUntilTimestamp = Date.parse(request.access.valid_until);
    if (
      !RFC3339_DATE_TIME.test(request.access.valid_until) ||
      !Number.isFinite(validUntilTimestamp) ||
      validUntilTimestamp <= Date.now()
    ) {
      throw new Error("access.valid_until must be a future RFC3339 date-time");
    }
    const response = await this.request<AuthorizationResponse>("/auth", {
      method: "POST",
      body: {
        ...request,
        aspsp: { name, country },
      },
    });
    validateAuthorizationUrl(response.url);
    return response;
  }

  async createSession(code: string): Promise<SessionResponse> {
    const authorizationCode = code.trim();
    if (!authorizationCode) {
      throw new Error("authorization code is required");
    }
    return this.request("/sessions", {
      method: "POST",
      body: { code: authorizationCode },
    });
  }

  async getApplication(): Promise<ApplicationResponse> {
    return this.request("/application");
  }

  async getHealth(): Promise<unknown> {
    return getHealth(this.fetchFn);
  }

  async getSession(sessionId: string): Promise<Record<string, unknown>> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}`);
  }

  async deleteSession(sessionId: string): Promise<Record<string, unknown>> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  }

  async getAccountDetails(accountId: string): Promise<unknown> {
    return this.request(`/accounts/${encodeURIComponent(accountId)}/details`);
  }

  async getAccountBalances(accountId: string): Promise<unknown> {
    return this.request(`/accounts/${encodeURIComponent(accountId)}/balances`);
  }

  async getAccountTransactions(
    accountId: string,
    query: TransactionQuery,
  ): Promise<{
    transactions: unknown[];
    pages: number;
    hasMore: boolean;
    continuationKey?: string;
  }> {
    if (query.dateTo && !query.dateFrom) {
      throw new Error("date_to requires date_from");
    }
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) {
      throw new Error("limit must be an integer between 1 and 100");
    }

    const transactions: unknown[] = [];
    let continuationKey: string | undefined = query.continuationKey;
    let nextContinuationKey: string | undefined;
    let hasMore = false;
    let pages = 0;

    do {
      const params = new URLSearchParams();
      if (query.dateFrom) params.set("date_from", query.dateFrom);
      if (query.dateTo) params.set("date_to", query.dateTo);
      if (query.transactionStatus) {
        params.set("transaction_status", query.transactionStatus);
      }
      if (query.strategy) params.set("strategy", query.strategy);
      if (continuationKey) params.set("continuation_key", continuationKey);
      const suffix = params.toString() ? `?${params.toString()}` : "";

      const page = await this.request<TransactionPage>(
        `/accounts/${encodeURIComponent(accountId)}/transactions${suffix}`,
      );
      pages += 1;

      const pageTransactions = page.transactions ?? [];
      const available = query.limit - transactions.length;
      const count = Math.min(pageTransactions.length, available);
      for (let index = 0; index < count; index += 1) {
        transactions.push(pageTransactions[index]);
      }

      const providerContinuation = page.continuation_key ?? undefined;
      if (providerContinuation && providerContinuation === continuationKey) {
        throw new Error("provider returned a repeated continuation key");
      }
      const pageHasUnreturnedTransactions =
        pageTransactions.length > available;
      hasMore = Boolean(providerContinuation) || pageHasUnreturnedTransactions;
      if (providerContinuation) nextContinuationKey = providerContinuation;
      continuationKey =
        transactions.length >= query.limit
          ? undefined
          : providerContinuation;
    } while (continuationKey);

    return {
      transactions,
      pages,
      hasMore,
      ...(nextContinuationKey ? { continuationKey: nextContinuationKey } : {}),
    };
  }

  async getTransactionDetails(
    accountId: string,
    transactionId: string,
  ): Promise<unknown> {
    return this.request(
      `/accounts/${encodeURIComponent(accountId)}/transactions/${encodeURIComponent(transactionId)}`,
    );
  }

  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "DELETE";
      body?: unknown;
    } = {},
  ): Promise<T> {
    const token = this.authorizationToken();
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    };
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    const response = await this.fetchFn(`${API_BASE_URL}${path}`, init);

    const raw = await response.text();
    const body = parseJson(raw);
    if (!response.ok) {
      throw new EnableBankingApiError(
        response.status,
        extractErrorMessage(body) || response.statusText || "request failed",
        extractErrorDetails(body),
        response.headers.get("retry-after") ?? undefined,
      );
    }

    return body as T;
  }

  private authorizationToken(): string {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (
      this.cachedToken &&
      nowSeconds < this.cachedToken.expiresAt - TOKEN_REFRESH_LEEWAY_SECONDS
    ) {
      return this.cachedToken.value;
    }
    const value = signJwtWithKey(this.credentials.appId, this.key, nowSeconds);
    this.cachedToken = {
      value,
      expiresAt: nowSeconds + JWT_TTL_SECONDS,
    };
    return value;
  }
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

function signJwtWithKey(
  appId: string,
  key: KeyObject,
  nowSeconds: number,
): string {
  const header = Buffer.from(
    JSON.stringify({ typ: "JWT", alg: "RS256", kid: appId }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "enablebanking.com",
      aud: "api.enablebanking.com",
      iat: nowSeconds,
      exp: nowSeconds + JWT_TTL_SECONDS,
    }),
  ).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(key).toString("base64url")}`;
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
    if (typeof record[key] === "string" && record[key]) {
      return record[key];
    }
  }
  return undefined;
}

function extractErrorDetails(body: unknown): EnableBankingErrorDetails {
  if (typeof body !== "object" || body === null) return {};
  const record = body as Record<string, unknown>;
  return {
    ...(typeof record.code === "number" ? { code: record.code } : {}),
    ...(typeof record.error === "string" && record.error
      ? { error: record.error }
      : {}),
    ...(typeof record.detail === "string" && record.detail
      ? { detail: record.detail }
      : {}),
  };
}
