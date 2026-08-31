import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import {
  EnableBankingApiError,
  EnableBankingClient,
  createJwt,
  getHealth,
  privateKeyFromValue,
} from "../dist/enable-banking.js";
import { loadCredentials } from "../dist/config.js";
test("loads the configured application ID aliases", () => {
  const privateKey = "private-key";
  assert.equal(
    loadCredentials({
      ENABLE_BANKING_ID: "current-id",
      ENABLE_BANKING_PRIVATE_KEY: privateKey,
    }).appId,
    "current-id",
  );
  assert.equal(
    loadCredentials({
      ENABLE_BANKING_APP_ID: "existing-id",
      ENABLE_BANKING_PRIVATE_KEY: privateKey,
    }).appId,
    "existing-id",
  );
});

test("starts bank authorization and exchanges its callback code", async () => {
  const { privateKey } = testKey();
  const requests = [];
  const client = new EnableBankingClient(
    { appId: "app-id", privateKey },
    async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/auth")) {
        return new Response(
          JSON.stringify({
            url: "https://bank.example/authorize",
            authorization_id: "authorization-id",
            psu_id_hash: "psu-hash",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ session_id: "session-id" }), {
        status: 200,
      });
    },
  );

  const authorization = await client.startAuthorization({
    aspsp: { name: "Example Bank", country: "ie" },
    access: {
      balances: true,
      transactions: true,
      valid_until: "2026-12-01T00:00:00.000Z",
    },
    state: "state",
    redirect_url: "https://localhost:8765/callback",
  });
  const session = await client.createSession("callback-code");

  assert.equal(authorization.authorization_id, "authorization-id");
  assert.deepEqual(session, { session_id: "session-id" });
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    aspsp: { name: "Example Bank", country: "IE" },
    access: {
      balances: true,
      transactions: true,
      valid_until: "2026-12-01T00:00:00.000Z",
    },
    state: "state",
    redirect_url: "https://localhost:8765/callback",
  });
  assert.equal(requests[1].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    code: "callback-code",
  });
});

test("omits provider-defaulted authorization fields when not supplied", async () => {
  const { privateKey } = testKey();
  let requestBody;
  const client = new EnableBankingClient(
    { appId: "app-id", privateKey },
    async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          url: "https://bank.example/authorize",
          authorization_id: "authorization-id",
          psu_id_hash: "psu-hash",
        }),
        { status: 200 },
      );
    },
  );

  await client.startAuthorization({
    aspsp: { name: "Example Bank", country: "ie" },
    access: { valid_until: "2026-12-01T00:00:00.000Z" },
    state: "state",
    redirect_url: "https://localhost:8765/callback",
  });

  assert.deepEqual(requestBody.access, {
    valid_until: "2026-12-01T00:00:00.000Z",
  });
  assert.equal("psu_type" in requestBody, false);
});

test("lists all ASPSPs when country is omitted", async () => {
  const { privateKey } = testKey();
  let requestedUrl;
  const client = new EnableBankingClient(
    { appId: "app-id", privateKey },
    async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ aspsps: [] }), { status: 200 });
    },
  );

  await client.listBanks();

  assert.equal(new URL(requestedUrl).search, "");
});

function testKey() {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

test("creates an Enable Banking JWT with official claims", () => {
  const { privateKey, publicKey } = testKey();
  const token = createJwt(
    { appId: "app-id", privateKey },
    1_700_000_000,
  );
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  const header = JSON.parse(Buffer.from(encodedHeader, "base64url"));
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url"));

  assert.deepEqual(header, { typ: "JWT", alg: "RS256", kid: "app-id" });
  assert.deepEqual(payload, {
    iss: "enablebanking.com",
    aud: "api.enablebanking.com",
    iat: 1_700_000_000,
    exp: 1_700_000_300,
  });
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      publicKey,
      Buffer.from(encodedSignature, "base64url"),
    ),
    true,
  );
});

test("accepts base64-encoded DER private keys", () => {
  const { privateKey } = testKey();
  const der = privateKey
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const key = privateKeyFromValue(der);
  assert.equal(key.asymmetricKeyType, "rsa");
});

test("paginates transactions and stops at the requested limit", async () => {
  const { privateKey } = testKey();
  const calls = [];
  const client = new EnableBankingClient(
    { appId: "app-id", privateKey },
    async (url, options) => {
      calls.push({ url: String(url), options });
      const parsed = new URL(String(url));
      const page = parsed.searchParams.get("continuation_key");
      const body = page
        ? { transactions: [{ id: "second" }] }
        : { transactions: [{ id: "first" }], continuation_key: "next" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  const result = await client.getAccountTransactions("account-uid", {
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    limit: 2,
  });

  assert.deepEqual(result.transactions, [{ id: "first" }, { id: "second" }]);
  assert.equal(result.pages, 2);
  assert.equal(result.hasMore, false);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /date_from=2026-08-01/);
  assert.match(calls[0].url, /date_to=2026-08-31/);
  assert.match(calls[1].url, /continuation_key=next/);
  assert.match(calls[0].options.headers.Authorization, /^Bearer /);
  const limited = await client.getAccountTransactions("account-uid", {
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    limit: 1,
  });
  assert.deepEqual(limited.transactions, [{ id: "first" }]);
  assert.equal(limited.pages, 1);
  assert.equal(limited.hasMore, true);
  assert.equal(limited.continuationKey, "next");
});

test("rejects date_to without date_from before making a request", async () => {
  const { privateKey } = testKey();
  const client = new EnableBankingClient(
    { appId: "app-id", privateKey },
    async () => {
      throw new Error("fetch should not run");
    },
  );

  await assert.rejects(
    client.getAccountTransactions("account-uid", {
      dateTo: "2026-08-31",
      limit: 10,
    }),
    /date_to requires date_from/,
  );
});

test("covers the documented session, account, and payment operations", async () => {
  const { privateKey } = testKey();
  const calls = [];
  const client = new EnableBankingClient(
    { appId: "app-id", privateKey },
    async (url, options) => {
      calls.push({ url: String(url), options });
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname === "/aspsps") {
        return new Response(JSON.stringify({ aspsps: [] }), { status: 200 });
      }
      if (requestUrl.pathname === "/application") {
        return new Response(JSON.stringify({ active: true }), { status: 200 });
      }
      if (
        requestUrl.pathname === "/sessions/session-id" &&
        options.method === "DELETE"
      ) {
        return new Response(JSON.stringify({ message: "deleted" }), {
          status: 200,
        });
      }
      if (requestUrl.pathname === "/sessions/session-id") {
        return new Response(JSON.stringify({ session_id: "session-id" }), {
          status: 200,
        });
      }
      if (requestUrl.pathname.includes("/transactions")) {
        return new Response(JSON.stringify({ transactions: [] }), {
          status: 200,
        });
      }
      if (requestUrl.pathname === "/payments") {
        return new Response(
          JSON.stringify({
            payment_id: "payment-id",
            status: "RCVD",
          }),
          { status: 200 },
        );
      }
      if (requestUrl.pathname === "/payments/payment-id/submit") {
        return new Response(
          JSON.stringify({
            payment_id: "payment-id",
            status: "ACSC",
            final_status: true,
          }),
          { status: 200 },
        );
      }
      if (requestUrl.pathname.startsWith("/payments/payment-id")) {
        return new Response(JSON.stringify({ payment_id: "payment-id" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    },
  );
  const psuHeaders = { "Psu-Ip-Address": "127.0.0.1" };

  await client.listBanks("ie", {
    psuType: "personal",
    service: "AIS",
    paymentType: "SEPA",
  });
  await client.getApplication();
  await client.getHealth();
  await client.getSession("session-id", psuHeaders);
  await client.deleteSession("session-id", psuHeaders);
  await client.getAccountDetails("account-id", psuHeaders);
  await client.getAccountBalances("account-id", psuHeaders);
  await client.getAccountTransactions("account-id", {
    transactionStatus: "BOOK",
    strategy: "longest",
    limit: 2,
    headers: psuHeaders,
  });
  await client.getTransactionDetails(
    "account-id",
    "transaction-id",
    psuHeaders,
  );
  await client.createPayment({ payment_type: "SEPA" }, psuHeaders);
  await client.getPayment("payment-id", psuHeaders);
  await client.deletePayment("payment-id", psuHeaders);
  await client.submitPayment("payment-id", psuHeaders);
  await client.getPaymentTransaction(
    "payment-id",
    "transaction-id",
    psuHeaders,
  );

  const listBanksCall = calls.find(({ url }) => url.includes("/aspsps"));
  assert.match(listBanksCall.url, /psu_type=personal/);
  assert.match(listBanksCall.url, /service=AIS/);
  assert.match(listBanksCall.url, /payment_type=SEPA/);
  const transactionCall = calls.find(({ url }) =>
    url.includes("/accounts/account-id/transactions?"),
  );
  assert.match(transactionCall.url, /transaction_status=BOOK/);
  assert.match(transactionCall.url, /strategy=longest/);
  assert.equal(transactionCall.options.headers["Psu-Ip-Address"], "127.0.0.1");
  const deleteSessionCall = calls.find(
    ({ url, options }) =>
      url.endsWith("/sessions/session-id") && options.method === "DELETE",
  );
  assert.equal(deleteSessionCall.options.method, "DELETE");
  const submitCall = calls.find(({ url }) => url.endsWith("/submit"));
  assert.equal(submitCall.options.method, "POST");
  assert.deepEqual(JSON.parse(submitCall.options.body), {});
});

test("surfaces API status and message without exposing credentials", async () => {
  const { privateKey } = testKey();
  const client = new EnableBankingClient(
    { appId: "app-id", privateKey },
    async () =>
      new Response(JSON.stringify({ message: "expired session" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
  );

  await assert.rejects(
    client.getSession("session-id"),
    (error) =>
      error instanceof EnableBankingApiError &&
      error.status === 401 &&
      error.message === "Enable Banking API 401: expired session",
  );
});

test("retains structured API error details", async () => {
  const { privateKey } = testKey();
  const client = new EnableBankingClient(
    { appId: "app-id", privateKey },
    async () =>
      new Response(
        JSON.stringify({
          message: "expired session",
          code: 401,
          error: "EXPIRED_SESSION",
          detail: "The session is no longer valid",
        }),
        { status: 401 },
      ),
  );

  await assert.rejects(
    client.getSession("session-id"),
    (error) =>
      error instanceof EnableBankingApiError &&
      error.details.code === 401 &&
      error.details.error === "EXPIRED_SESSION" &&
      error.details.detail === "The session is no longer valid",
  );
});

test("checks public API health without credentials", async () => {
  let request;
  const result = await getHealth(async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify("OK"), { status: 200 });
  });

  assert.equal(result, "OK");
  assert.equal(request.url, "https://api.enablebanking.com/health");
  assert.equal(request.options.headers.Authorization, undefined);
});

test("rejects invalid authorization expiry before requesting authorization", async () => {
  const { privateKey } = testKey();
  const client = new EnableBankingClient(
    { appId: "app-id", privateKey },
    async () => {
      throw new Error("fetch should not run");
    },
  );

  await assert.rejects(
    client.startAuthorization({
      aspsp: { name: "Example Bank", country: "IE" },
      access: { valid_until: "not-a-date" },
      state: "state",
      redirect_url: "https://localhost:8765/callback",
    }),
    /access\.valid_until must be a future RFC3339 date-time/,
  );
});
