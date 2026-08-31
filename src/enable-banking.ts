import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import type { EnableBankingConfig, EnableBankingCredentials } from "./config.js";

export const API_BASE_URL = "https://api.enablebanking.com";
const JWT_TTL_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 30_000;
const RFC3339_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type ApiHeaders = Record<string, string>;

export interface ListBanksOptions {
  psuType?: "personal" | "business";
  service?: "AIS" | "PIS";
  paymentType?: string;
}

export interface TransactionQuery {
  dateFrom?: string;
  dateTo?: string;
  continuationKey?: string;
  transactionStatus?: "BOOK" | "CNCL" | "HOLD" | "OTHR" | "PDNG" | "RJCT" | "SCHD";
  strategy?: "default" | "longest";
  headers?: ApiHeaders;
  limit: number;
}

export interface TransactionPage {
  transactions?: unknown[];
  continuation_key?: string | null;
  [key: string]: unknown;
}

export interface AccountIdentification {
  iban?: string;
  other?: Record<string, unknown>;
}

export interface AuthorizationRequest {
  aspsp: {
    name: string;
    country: string;
  };
  access: {
    accounts?: AccountIdentification[] | null;
    balances?: boolean;
    transactions?: boolean;
    valid_until: string;
  };
  state: string;
  redirect_url: string;
  psu_type?: "personal" | "business";
  auth_method?: string;
  credentials?: Record<string, string>;
  credentials_autosubmit?: boolean;
  language?: string;
  psu_id?: string;
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

export type PaymentRequest = Record<string, unknown>;

export interface PaymentResponse {
  payment_id: string;
  status: string;
  url?: string;
  psu_id_hash?: string;
  [key: string]: unknown;
}

export interface PaymentSubmissionResponse {
  payment_id: string;
  status: string;
  final_status: boolean;
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
    );
  }
  return body;
}

export class EnableBankingClient {
  private readonly key: KeyObject;

  constructor(
    private readonly credentials: EnableBankingCredentials,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {
    this.key = privateKeyFromValue(credentials.privateKey);
  }

  async listBanks(
    country?: string,
    options: ListBanksOptions = {},
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (country !== undefined) {
      const code = country.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(code)) {
        throw new Error("country must be a two-letter ISO 3166-1 code");
      }
      params.set("country", code);
    }
    if (options.psuType) params.set("psu_type", options.psuType);
    if (options.service) params.set("service", options.service);
    if (options.paymentType) params.set("payment_type", options.paymentType);
    const query = params.toString();
    return this.request(`/aspsps${query ? `?${query}` : ""}`);
  }

  async startAuthorization(
    request: AuthorizationRequest,
  ): Promise<AuthorizationResponse> {
    const country = request.aspsp.country.trim().toUpperCase();
    const name = request.aspsp.name.trim();
    const authMethod = request.auth_method?.trim();
    const language = request.language?.trim();
    if (!/^[A-Z]{2}$/.test(country)) {
      throw new Error("country must be a two-letter ISO 3166-1 code");
    }
    if (!name) {
      throw new Error("aspsp.name is required");
    }
    if (!request.state.trim()) {
      throw new Error("state is required");
    }
    if (!request.redirect_url.trim()) {
      throw new Error("redirect_url is required");
    }
    if (request.credentials && !authMethod) {
      throw new Error("credentials require auth_method");
    }
    if (language && !/^[a-z]{2}$/.test(language)) {
      throw new Error("language must be a two-letter lowercase code");
    }
    const validUntilTimestamp = Date.parse(request.access.valid_until);
    if (
      !RFC3339_DATE_TIME.test(request.access.valid_until) ||
      !Number.isFinite(validUntilTimestamp) ||
      validUntilTimestamp <= Date.now()
    ) {
      throw new Error("access.valid_until must be a future RFC3339 date-time");
    }
    return this.request("/auth", {
      method: "POST",
      body: {
        ...request,
        aspsp: { name, country },
        ...(authMethod ? { auth_method: authMethod } : {}),
        ...(language ? { language } : {}),
      },
    });
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

  async getSession(
    sessionId: string,
    headers?: ApiHeaders,
  ): Promise<Record<string, unknown>> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}`, {
      headers,
    });
  }

  async deleteSession(
    sessionId: string,
    headers?: ApiHeaders,
  ): Promise<Record<string, unknown>> {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers,
    });
  }

  async getAccountDetails(
    accountId: string,
    headers?: ApiHeaders,
  ): Promise<unknown> {
    return this.request(`/accounts/${encodeURIComponent(accountId)}/details`, {
      headers,
    });
  }

  async getAccountBalances(
    accountId: string,
    headers?: ApiHeaders,
  ): Promise<unknown> {
    return this.request(`/accounts/${encodeURIComponent(accountId)}/balances`, {
      headers,
    });
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
    if (!Number.isInteger(query.limit) || query.limit < 1) {
      throw new Error("limit must be a positive integer");
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
        { headers: query.headers },
      );
      pages += 1;

      const pageTransactions = page.transactions ?? [];
      const available = Math.max(0, query.limit - transactions.length);
      for (const transaction of pageTransactions.slice(0, available)) {
        transactions.push(transaction);
      }

      const providerContinuation = page.continuation_key ?? undefined;
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
      transactions: transactions.slice(0, query.limit),
      pages,
      hasMore,
      ...(nextContinuationKey ? { continuationKey: nextContinuationKey } : {}),
    };
  }

  async getTransactionDetails(
    accountId: string,
    transactionId: string,
    headers?: ApiHeaders,
  ): Promise<unknown> {
    return this.request(
      `/accounts/${encodeURIComponent(accountId)}/transactions/${encodeURIComponent(transactionId)}`,
      { headers },
    );
  }

  async createPayment(
    request: PaymentRequest,
    headers?: ApiHeaders,
  ): Promise<PaymentResponse> {
    return this.request("/payments", {
      method: "POST",
      body: request,
      headers,
    });
  }

  async getPayment(
    paymentId: string,
    headers?: ApiHeaders,
  ): Promise<PaymentResponse> {
    return this.request(`/payments/${encodeURIComponent(paymentId)}`, {
      headers,
    });
  }

  async deletePayment(
    paymentId: string,
    headers?: ApiHeaders,
  ): Promise<Record<string, unknown>> {
    return this.request(`/payments/${encodeURIComponent(paymentId)}`, {
      method: "DELETE",
      headers,
    });
  }

  async submitPayment(
    paymentId: string,
    headers?: ApiHeaders,
  ): Promise<PaymentSubmissionResponse> {
    return this.request(`/payments/${encodeURIComponent(paymentId)}/submit`, {
      method: "POST",
      body: {},
      headers,
    });
  }

  async getPaymentTransaction(
    paymentId: string,
    transactionId: string,
    headers?: ApiHeaders,
  ): Promise<unknown> {
    return this.request(
      `/payments/${encodeURIComponent(paymentId)}/transactions/${encodeURIComponent(transactionId)}`,
      { headers },
    );
  }

  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "DELETE";
      body?: unknown;
      headers?: ApiHeaders;
    } = {},
  ): Promise<T> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = signJwtWithKey(this.credentials.appId, this.key, nowSeconds);
    const headers: Record<string, string> = {
      ...options.headers,
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
      );
    }

    return body as T;
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

export function createClient(
  config: EnableBankingConfig,
  fetchFn?: typeof fetch,
): EnableBankingClient {
  return new EnableBankingClient(config, fetchFn);
}
