import assert from "node:assert/strict";
import test from "node:test";
import { BankAuthorizationFlow, parseValidUntil } from "../dist/authorization.js";

class MemorySessionStore {
  sessionId;

  async get() {
    return this.sessionId;
  }

  async set(sessionId) {
    this.sessionId = sessionId;
  }

  async clear() {
    this.sessionId = undefined;
  }
}

async function waitForSession(store) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const sessionId = await store.get();
    if (sessionId) return sessionId;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return store.get();
}

test("opens browser authorization and stores the callback session", async () => {
  const store = new MemorySessionStore();
  const completion = Promise.withResolvers();
  let openedUrl;
  let authorizationRequest;
  let callbackState;
  const flow = new BankAuthorizationFlow(
    store,
    (url) => {
      openedUrl = url;
    },
    async (_redirect, state) => {
      callbackState = state;
      return {
        wait: completion.promise,
        close: async () => {},
      };
    },
  );
  const client = {
    async startAuthorization(request) {
      authorizationRequest = request;
      return {
        url: "https://bank.example/authorize",
        authorization_id: "authorization-id",
        psu_id_hash: "psu-hash",
      };
    },
    async createSession(code) {
      assert.equal(code, "callback-code");
      return { session_id: "stored-session-id" };
    },
  };

  const result = await flow.start(client, {
    aspspName: "Example Bank",
    country: "ie",
    redirectUrl: "https://localhost:8765/callback",
    validUntil: "2099-12-01T00:00:00.000Z",
    accessProfile: "balances_and_transactions",
  });

  assert.deepEqual(result, {
    status: "awaiting_user",
    authorization_url: "https://bank.example/authorize",
  });
  assert.equal(openedUrl, "https://bank.example/authorize");
  assert.equal(authorizationRequest.aspsp.country, "IE");
  assert.equal(authorizationRequest.redirect_url, "https://localhost:8765/callback");
  assert.equal(authorizationRequest.access.balances, true);
  assert.equal(authorizationRequest.access.transactions, true);
  assert.equal(authorizationRequest.psu_type, "personal");
  assert.match(callbackState, /^[A-Za-z0-9_-]{43}$/);

  completion.resolve("callback-code");
  assert.equal(await waitForSession(store), "stored-session-id");
  assert.equal(flow.status.pending, false);
});

test("requests balances without transactions by default", async () => {
  const store = new MemorySessionStore();
  const completion = Promise.withResolvers();
  let authorizationRequest;
  const flow = new BankAuthorizationFlow(
    store,
    () => {},
    async () => ({
      wait: completion.promise,
      close: async () => {},
    }),
  );
  const client = {
    async startAuthorization(request) {
      authorizationRequest = request;
      return {
        url: "https://bank.example/authorize",
        authorization_id: "authorization-id",
        psu_id_hash: "psu-hash",
      };
    },
    async createSession() {
      return { session_id: "stored-session-id" };
    },
  };

  await flow.start(client, {
    aspspName: "Example Bank",
    country: "IE",
    redirectUrl: "https://localhost:8765/callback",
    validUntil: "2099-12-01T00:00:00.000Z",
  });

  assert.equal(authorizationRequest.access.balances, true);
  assert.equal(authorizationRequest.access.transactions, false);
  completion.resolve("callback-code");
  assert.equal(await waitForSession(store), "stored-session-id");
});

test("rejects HTTP loopback callback URLs", async () => {
  const flow = new BankAuthorizationFlow(new MemorySessionStore(), () => {});
  await assert.rejects(
    flow.start(
      {},
      {
        aspspName: "Example Bank",
        country: "IE",
        redirectUrl: "http://localhost:8765/callback",
        validUntil: "2099-12-01T00:00:00.000Z",
      },
    ),
    /redirect_url must be an https:\/\/ localhost or 127\.0\.0\.1 URL/,
  );
});

test("rejects non-loopback callback URLs", async () => {
  const flow = new BankAuthorizationFlow(new MemorySessionStore(), () => {});
  await assert.rejects(
    flow.start(
      {},
      {
        aspspName: "Example Bank",
        country: "IE",
        redirectUrl: "https://constructor:8765/callback",
        validUntil: "2099-12-01T00:00:00.000Z",
      },
    ),
    /redirect_url must be an https:\/\/ localhost or 127\.0\.0\.1 URL/,
  );
});

test("requires RFC3339 date-times for consent expiry", () => {
  assert.throws(
    () => parseValidUntil("2099-12-01"),
    /valid_until must be a future RFC3339 date-time/,
  );
});
