import assert from "node:assert/strict";
import { request as requestHttps } from "node:https";
import { createServer as createNetServer } from "node:net";
import test from "node:test";
import { Effect } from "effect";
import {
  BankAuthorizationFlow,
  loadCallbackTlsOptions,
  parseValidUntil,
} from "../dist/authorization.js";
import { generateKeyMaterial } from "../dist/setup.js";

class MemorySessionStore {
  sessionId;

  get() {
    return Effect.succeed(this.sessionId);
  }

  set(sessionId) {
    return Effect.sync(() => {
      this.sessionId = sessionId;
    });
  }

  clear() {
    return Effect.sync(() => {
      this.sessionId = undefined;
    });
  }
}

async function waitForSession(store) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const sessionId = await Effect.runPromise(store.get());
    if (sessionId) return sessionId;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return Effect.runPromise(store.get());
}

let tlsOptions;

function getTlsOptions() {
  return Effect.gen(function* () {
    if (!tlsOptions) {
      const { privateKey, certificate } = yield* generateKeyMaterial();
      tlsOptions = { key: privateKey, cert: certificate };
    }
    return tlsOptions;
  });
}

async function getAvailablePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("TCP probe did not allocate a port");
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function requestHttpsStatus(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const request = requestHttps(
      url,
      { method, rejectUnauthorized: false },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function waitForAuthorizationToFinish(flow) {
  for (let attempt = 0; attempt < 100 && flow.status.pending; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return flow.status;
}

test("opens browser authorization and stores the callback session", async () => {
  const store = new MemorySessionStore();
  const completion = Promise.withResolvers();
  let openedUrl;
  let authorizationRequest;
  let callbackState;
  const flow = new BankAuthorizationFlow(
    store,
    (url) => Effect.sync(() => {
      openedUrl = url;
    }),
    (_redirect, state) => Effect.sync(() => {
      callbackState = state;
      return {
        wait: Effect.tryPromise({
          try: () => completion.promise,
          catch: (error) => error,
        }),
        close: Effect.void,
      };
    }),
  );
  const client = {
    startAuthorization(request) {
      return Effect.sync(() => {
        authorizationRequest = request;
        return {
          url: "https://bank.example/authorize",
          authorization_id: "authorization-id",
          psu_id_hash: "psu-hash",
        };
      });
    },
    createSession(code) {
      return Effect.sync(() => {
        assert.equal(code, "callback-code");
        return { session_id: "stored-session-id" };
      });
    },
  };

  const result = await Effect.runPromise(flow.start(client, {
    aspspName: "Example Bank",
    country: "ie",
    redirectUrl: "https://localhost:8765/callback",
    validUntil: "2099-12-01T00:00:00.000Z",
    accessProfile: "balances_and_transactions",
  }));

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
    () => Effect.void,
    () => Effect.succeed({
      wait: Effect.tryPromise({
        try: () => completion.promise,
        catch: (error) => error,
      }),
      close: Effect.void,
    }),
  );
  const client = {
    startAuthorization(request) {
      return Effect.sync(() => {
        authorizationRequest = request;
        return {
          url: "https://bank.example/authorize",
          authorization_id: "authorization-id",
          psu_id_hash: "psu-hash",
        };
      });
    },
    createSession() {
      return Effect.succeed({ session_id: "stored-session-id" });
    },
  };

  await Effect.runPromise(flow.start(client, {
    aspspName: "Example Bank",
    country: "IE",
    redirectUrl: "https://localhost:8765/callback",
    validUntil: "2099-12-01T00:00:00.000Z",
  }));

  assert.equal(authorizationRequest.access.balances, true);
  assert.equal(authorizationRequest.access.transactions, false);
  completion.resolve("callback-code");
  assert.equal(await waitForSession(store), "stored-session-id");
});

test("rejects HTTP loopback callback URLs", async () => {
  const flow = new BankAuthorizationFlow(new MemorySessionStore(), () => Effect.void);
  await assert.rejects(
    Effect.runPromise(flow.start(
      {},
      {
        aspspName: "Example Bank",
        country: "IE",
        redirectUrl: "http://localhost:8765/callback",
        validUntil: "2099-12-01T00:00:00.000Z",
      },
    )),
    /redirect_url must be an https:\/\/ localhost or 127\.0\.0.1 URL/,
  );
});

test("rejects non-loopback callback URLs", async () => {
  const flow = new BankAuthorizationFlow(new MemorySessionStore(), () => Effect.void);
  await assert.rejects(
    Effect.runPromise(flow.start(
      {},
      {
        aspspName: "Example Bank",
        country: "IE",
        redirectUrl: "https://constructor:8765/callback",
        validUntil: "2099-12-01T00:00:00.000Z",
      },
    )),
    /redirect_url must be an https:\/\/ localhost or 127\.0\.0.1 URL/,
  );
});

test("rejects callback URL credentials, query, fragment, and invalid ports", async () => {
  for (const redirectUrl of [
    "https://user:password@localhost:8765/callback",
    "https://localhost:8765/callback?state=value",
    "https://localhost:8765/callback#fragment",
    "https://localhost/callback",
    "https://localhost:0/callback",
  ]) {
    const flow = new BankAuthorizationFlow(new MemorySessionStore(), () => Effect.void);
    await assert.rejects(
      Effect.runPromise(flow.start(
        {},
        {
          aspspName: "Example Bank",
          country: "FI",
          redirectUrl,
          validUntil: "2099-12-01T00:00:00.000Z",
        },
      )),
      /redirect_url must/,
      redirectUrl,
    );
  }
});

test("requires a future real RFC3339 calendar date for consent expiry", () => {
  for (const value of [
    "2099-12-01",
    "2099-02-30T00:00:00Z",
    "2020-01-01T00:00:00Z",
  ]) {
    assert.throws(
      () => parseValidUntil(value),
      /valid_until must be a future RFC3339 date-time/,
    );
  }
  assert.equal(
    parseValidUntil("2096-02-29T00:00:00Z"),
    "2096-02-29T00:00:00.000Z",
  );
});

test("defaults consent expiry to thirty days", () => {
  const before = Date.now();
  const expiry = Date.parse(parseValidUntil());
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;

  assert.ok(expiry >= before + thirtyDays);
  assert.ok(expiry <= before + thirtyDays + 1000);
});

test("clears pending authorization after provider, URL, and browser startup errors", async () => {
  for (const scenario of [
    {
      startAuthorization: () => Effect.fail(new Error("provider authorization failed")),
      error: /provider authorization failed/,
    },
    {
      startAuthorization: () => Effect.succeed({ url: "javascript:alert(1)" }),
      error: /invalid authorization URL/,
    },
    {
      startAuthorization: () => Effect.succeed({ url: 42 }),
      error: /invalid authorization URL/,
    },
    {
      startAuthorization: () => Effect.succeed({ url: "not a URL" }),
      error: /invalid authorization URL/,
    },
    {
      startAuthorization: () => Effect.succeed({
        url: `https://user:secret${String.fromCharCode(64)}bank.example/authorize`,
      }),
      error: /invalid authorization URL/,
    },
    {
      startAuthorization: () => Effect.succeed({
        url: "https://bank.example/authorize",
      }),
      browserError: new Error("browser launch failed"),
      error: /browser launch failed/,
    },
  ]) {
    const completion = Promise.withResolvers();
    let closeCalls = 0;
    let browserCalls = 0;
    const flow = new BankAuthorizationFlow(
      new MemorySessionStore(),
      () => Effect.sync(() => {
        browserCalls += 1;
        if (scenario.browserError) throw scenario.browserError;
      }),
      () => Effect.succeed({
        wait: Effect.tryPromise({ try: () => completion.promise, catch: (error) => error }),
        close: Effect.sync(() => {
          closeCalls += 1;
        }),
      }),
    );

    await assert.rejects(
      Effect.runPromise(flow.start(
        { startAuthorization: scenario.startAuthorization },
        {
          aspspName: "Example Bank",
          country: "FI",
          redirectUrl: "https://localhost:8765/callback",
          validUntil: "2099-12-01T00:00:00.000Z",
        },
      )),
      scenario.error,
    );

    assert.deepEqual(flow.status, { pending: false });
    assert.equal(closeCalls, 1);
    assert.equal(browserCalls, scenario.browserError ? 1 : 0);
  }
});

test("rejects concurrent bank consent and permits retry after a denied callback", async () => {
  const store = new MemorySessionStore();
  const completions = [Promise.withResolvers(), Promise.withResolvers()];
  let listenerCalls = 0;
  let authorizationCalls = 0;
  const flow = new BankAuthorizationFlow(
    store,
    () => Effect.void,
    () => Effect.sync(() => ({
      wait: Effect.tryPromise({
        try: () => completions[listenerCalls++].promise,
        catch: (error) => error,
      }),
      close: Effect.void,
    })),
  );
  const client = {
    startAuthorization() {
      return Effect.sync(() => {
        authorizationCalls += 1;
        return { url: "https://bank.example/authorize" };
      });
    },
    createSession() {
      return Effect.succeed({ session_id: "retry-session" });
    },
  };
  const options = {
    aspspName: "Example Bank",
    country: "FI",
    redirectUrl: "https://localhost:8765/callback",
    validUntil: "2099-12-01T00:00:00.000Z",
  };

  await Effect.runPromise(flow.start(client, options));
  await assert.rejects(
    Effect.runPromise(flow.start(client, options)),
    /already in progress/,
  );
  assert.equal(listenerCalls, 1);
  assert.equal(authorizationCalls, 1);

  completions[0].reject(new Error("bank consent was denied"));
  for (let attempt = 0; attempt < 20 && flow.status.pending; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.deepEqual(flow.status, {
    pending: false,
    lastError: "bank consent was denied",
  });

  await Effect.runPromise(flow.start(client, options));
  assert.deepEqual(flow.status, { pending: true });
  completions[1].resolve("approved-code");
  assert.equal(await waitForSession(store), "retry-session");
  assert.deepEqual(flow.status, { pending: false });
  assert.equal(listenerCalls, 2);
  assert.equal(authorizationCalls, 2);
});
test("reserves bank authorization while callback listener creation is pending", async () => {
  const listenerReady = Promise.withResolvers();
  const listenerGate = Promise.withResolvers();
  let listenerCalls = 0;
  const completion = Promise.withResolvers();
  const flow = new BankAuthorizationFlow(
    new MemorySessionStore(),
    () => Effect.void,
    () => Effect.tryPromise({
      try: () => {
        listenerCalls += 1;
        listenerReady.resolve();
        return listenerGate.promise.then(() => ({
          wait: Effect.tryPromise({
            try: () => completion.promise,
            catch: (error) => error,
          }),
          close: Effect.void,
        }));
      },
      catch: (error) => error,
    }),
  );
  const client = {
    startAuthorization() {
      return Effect.succeed({ url: "https://bank.example/authorize" });
    },
    createSession() {
      return Effect.succeed({ session_id: "session-id" });
    },
  };
  const options = {
    aspspName: "Example Bank",
    country: "FI",
    redirectUrl: "https://localhost:8765/callback",
  };

  const first = Effect.runPromise(flow.start(client, options));
  await listenerReady.promise;
  assert.equal(flow.status.pending, true);
  await assert.rejects(
    Effect.runPromise(flow.start(client, options)),
    /already in progress/,
  );
  assert.equal(listenerCalls, 1);

  listenerGate.resolve();
  await first;
  completion.resolve("consent-code");
});

test("reports callback exchange and session-store failures after closing the listener", async () => {
  for (const scenario of [
    {
      name: "callback exchange",
      error: "bank code exchange failed",
      createSession: () => Effect.fail(new Error("bank code exchange failed")),
    },
    {
      name: "session persistence",
      error: "session Keychain write failed",
      createSession: () => Effect.succeed({ session_id: "not-persisted" }),
      makeStore() {
        const store = new MemorySessionStore();
        store.set = () => Effect.fail(new Error("session Keychain write failed"));
        return store;
      },
    },
  ]) {
    const completion = Promise.withResolvers();
    const store = scenario.makeStore?.() ?? new MemorySessionStore();
    let closeCalls = 0;
    const flow = new BankAuthorizationFlow(
      store,
      () => Effect.void,
      () => Effect.succeed({
        wait: Effect.tryPromise({ try: () => completion.promise, catch: (error) => error }),
        close: Effect.sync(() => {
          closeCalls += 1;
        }),
      }),
    );

    await Effect.runPromise(flow.start(
      {
        startAuthorization: () => Effect.succeed({ url: "https://bank.example/authorize" }),
        createSession: scenario.createSession,
      },
      {
        aspspName: "Example Bank",
        country: "FI",
        redirectUrl: "https://localhost:8765/callback",
        validUntil: "2099-12-01T00:00:00.000Z",
      },
    ));
    completion.resolve("approved-code");
    for (let attempt = 0; attempt < 20 && flow.status.pending; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    assert.deepEqual(flow.status, { pending: false, lastError: scenario.error }, scenario.name);
    assert.equal(await Effect.runPromise(store.get()), undefined);
    assert.equal(closeCalls, 1);
  }
});

test("listener cleanup failure does not leave bank authorization pending", async () => {
  const completion = Promise.withResolvers();
  const store = new MemorySessionStore();
  const flow = new BankAuthorizationFlow(
    store,
    () => Effect.void,
    () => Effect.succeed({
      wait: Effect.tryPromise({ try: () => completion.promise, catch: (error) => error }),
      close: Effect.fail(new Error("callback listener cleanup failed")),
    }),
  );

  await Effect.runPromise(flow.start(
    {
      startAuthorization: () => Effect.succeed({ url: "https://bank.example/authorize" }),
      createSession: () => Effect.succeed({ session_id: "stored-before-cleanup-error" }),
    },
    {
      aspspName: "Example Bank",
      country: "FI",
      redirectUrl: "https://localhost:8765/callback",
      validUntil: "2099-12-01T00:00:00.000Z",
    },
  ));
  completion.resolve("approved-code");
  for (let attempt = 0; attempt < 20 && flow.status.pending; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.deepEqual(flow.status, {
    pending: false,
    lastError: "callback listener cleanup failed",
  });
  assert.equal(await Effect.runPromise(store.get()), "stored-before-cleanup-error");
});

test("authorization reservations exclude credential cleanup and release after cleanup", async () => {
  const flow = new BankAuthorizationFlow(new MemorySessionStore());
  await assert.rejects(
    Effect.runPromise(flow.startReserved({}, {})),
    /reservation is not active/,
  );
  flow.reserve();
  assert.equal(flow.status.pending, true);
  assert.throws(() => flow.reserve(), /already in progress/);
  await assert.rejects(
    Effect.runPromise(flow.withCredentialCleanup(() => Effect.void)),
    /bank authorization or cleanup is pending/,
  );
  flow.release();
  assert.equal(flow.status.pending, false);

  let finishCleanup;
  const cleanup = Effect.runPromise(flow.withCredentialCleanup(
    () => Effect.promise(() => new Promise((resolve) => {
      finishCleanup = resolve;
    })),
  ));
  assert.throws(() => flow.reserve(), /credential cleanup is pending/);
  await assert.rejects(
    Effect.runPromise(flow.withCredentialCleanup(() => Effect.void)),
    /bank authorization or cleanup is pending/,
  );
  finishCleanup();
  await cleanup;

  await assert.rejects(
    Effect.runPromise(flow.withCredentialCleanup(() => Effect.fail(new Error("cleanup failed")))),
    /cleanup failed/,
  );
  flow.reserve();
  flow.release();
});

test("real HTTPS callback rejects invalid requests and stores an accepted session", async () => {
  const port = await getAvailablePort();
  const redirectUrl = `https://127.0.0.1:${port}/authorization/callback`;
  const store = new MemorySessionStore();
  let authorizationRequest;
  let sessionCode;
  const flow = new BankAuthorizationFlow(
    store,
    () => Effect.void,
    undefined,
    getTlsOptions,
  );
  const client = {
    startAuthorization(request) {
      return Effect.sync(() => {
        authorizationRequest = request;
        return { url: "https://bank.example/authorize" };
      });
    },
    createSession(code) {
      return Effect.sync(() => {
        sessionCode = code;
        return { session_id: "https-callback-session" };
      });
    },
  };

  await Effect.runPromise(flow.start(client, {
    aspspName: "Example Bank",
    country: "FI",
    redirectUrl,
    validUntil: "2099-12-01T00:00:00.000Z",
  }));
  const callback = new URL(redirectUrl);
  callback.searchParams.set("state", authorizationRequest.state);

  const wrongPath = new URL(callback);
  wrongPath.pathname = "/wrong";
  wrongPath.searchParams.set("code", "ignored-code");
  assert.equal(await requestHttpsStatus(wrongPath), 404);

  const wrongMethod = new URL(callback);
  wrongMethod.searchParams.set("code", "ignored-code");
  assert.equal(await requestHttpsStatus(wrongMethod, "POST"), 404);

  const wrongState = new URL(callback);
  wrongState.searchParams.set("state", "not-the-request-state");
  assert.equal(await requestHttpsStatus(wrongState), 400);

  assert.equal(await requestHttpsStatus(callback), 400);
  assert.equal(await Effect.runPromise(store.get()), undefined);
  assert.equal(sessionCode, undefined);
  assert.equal(flow.status.pending, true);
  await assert.rejects(
    Effect.runPromise(flow.withCredentialCleanup(() => Effect.void)),
    /bank authorization or cleanup is pending/,
  );

  callback.searchParams.set("code", "approved-code");
  assert.equal(await requestHttpsStatus(callback), 200);
  assert.equal(await waitForSession(store), "https-callback-session");
  assert.equal(sessionCode, "approved-code");
  assert.deepEqual(await waitForAuthorizationToFinish(flow), { pending: false });
});

test("real HTTPS callback handles denied bank consent without storing a session", async () => {
  const port = await getAvailablePort();
  const redirectUrl = `https://127.0.0.1:${port}/callback`;
  const store = new MemorySessionStore();
  let authorizationRequest;
  const flow = new BankAuthorizationFlow(
    store,
    () => Effect.void,
    undefined,
    getTlsOptions,
  );

  await Effect.runPromise(flow.start(
    {
      startAuthorization(request) {
        return Effect.sync(() => {
          authorizationRequest = request;
          return { url: "https://bank.example/authorize" };
        });
      },
      createSession() {
        return Effect.fail(new Error("A denied callback must not exchange a code"));
      },
    },
    {
      aspspName: "Example Bank",
      country: "FI",
      redirectUrl,
      validUntil: "2099-12-01T00:00:00.000Z",
    },
  ));
  const denied = new URL(redirectUrl);
  denied.searchParams.set("state", authorizationRequest.state);
  denied.searchParams.set("error", "access_denied");

  assert.equal(await requestHttpsStatus(denied), 400);
  assert.deepEqual(await waitForAuthorizationToFinish(flow), {
    pending: false,
    lastError: "Bank authorization was denied",
  });
  assert.equal(await Effect.runPromise(store.get()), undefined);
  flow.resetError();
  assert.deepEqual(flow.status, { pending: false });
});

test("TLS setup failure prevents provider authorization startup", async () => {
  let authorizationCalls = 0;
  const flow = new BankAuthorizationFlow(
    new MemorySessionStore(),
    () => Effect.void,
    undefined,
    () => Effect.fail(new Error("localhost TLS material is unavailable")),
  );

  await assert.rejects(
    Effect.runPromise(flow.start(
      {
        startAuthorization() {
          return Effect.sync(() => {
            authorizationCalls += 1;
            return { url: "https://bank.example/authorize" };
          });
        },
      },
      {
        aspspName: "Example Bank",
        country: "FI",
        redirectUrl: "https://127.0.0.1:8765/callback",
        validUntil: "2099-12-01T00:00:00.000Z",
      },
    )),
    /localhost TLS material is unavailable/,
  );
  assert.equal(authorizationCalls, 0);
  assert.deepEqual(flow.status, { pending: false });
});

test("reports unavailable local TLS files without exposing their paths", () => {
  const certificateVariable = "ENABLE_BANKING_TLS_CERT";
  const keyVariable = "ENABLE_BANKING_TLS_KEY";
  const previousCertificate = process.env[certificateVariable];
  const previousKey = process.env[keyVariable];
  const missingPath = `/tmp/enable-banking-missing-${process.pid}-${Date.now()}.pem`;
  process.env[certificateVariable] = missingPath;
  process.env[keyVariable] = missingPath;
  try {
    assert.throws(
      loadCallbackTlsOptions,
      /Local HTTPS certificate is unavailable/,
    );
  } finally {
    if (previousCertificate === undefined) delete process.env[certificateVariable];
    else process.env[certificateVariable] = previousCertificate;
    if (previousKey === undefined) delete process.env[keyVariable];
    else process.env[keyVariable] = previousKey;
  }
});

test("a busy callback port fails before bank authorization starts", async () => {
  const port = await getAvailablePort();
  const blocker = createNetServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(port, "127.0.0.1", resolve);
  });
  let authorizationCalls = 0;
  const flow = new BankAuthorizationFlow(
    new MemorySessionStore(),
    () => Effect.void,
    undefined,
    getTlsOptions,
  );

  try {
    await assert.rejects(
      Effect.runPromise(flow.start(
        {
          startAuthorization() {
            return Effect.sync(() => {
              authorizationCalls += 1;
              return { url: "https://bank.example/authorize" };
            });
          },
        },
        {
          aspspName: "Example Bank",
          country: "FI",
          redirectUrl: `https://127.0.0.1:${port}/callback`,
          validUntil: "2099-12-01T00:00:00.000Z",
        },
      )),
      /EADDRINUSE/,
    );
    assert.equal(authorizationCalls, 0);
    assert.deepEqual(flow.status, { pending: false });
  } finally {
    await new Promise((resolve, reject) => {
      blocker.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("bank authorization timeout records failure and releases its HTTPS listener", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const port = await getAvailablePort();
  const store = new MemorySessionStore();
  const flow = new BankAuthorizationFlow(
    store,
    () => Effect.void,
    undefined,
    getTlsOptions,
  );

  await Effect.runPromise(flow.start(
    {
      startAuthorization() {
        return Effect.succeed({ url: "https://bank.example/authorize" });
      },
      createSession() {
        return Effect.fail(new Error("A timed-out callback must not exchange a code"));
      },
    },
    {
      aspspName: "Example Bank",
      country: "FI",
      redirectUrl: `https://127.0.0.1:${port}/callback`,
      validUntil: "2099-12-01T00:00:00.000Z",
    },
  ));

  context.mock.timers.tick(5 * 60 * 1000);
  for (let attempt = 0; attempt < 100 && flow.status.pending; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(flow.status, {
    pending: false,
    lastError: "Bank authorization timed out",
  });
  assert.equal(await Effect.runPromise(store.get()), undefined);
});
