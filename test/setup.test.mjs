import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { connect } from "node:net";
import test from "node:test";
import { PassThrough } from "node:stream";
import {
  MacKeychainControlPanelAuthStore,
} from "../dist/control-panel-store.js";
import { MacKeychainApplicationStore } from "../dist/application-store.js";
import {
  ControlPanelAuthFlow,
  ControlPanelClient,
  createControlPanelCallbackListener,
} from "../dist/control-panel.js";
import { BankAuthorizationFlow } from "../dist/authorization.js";
import { EnableBankingClient } from "../dist/enable-banking.js";
import {
  ApplicationSetupFlow,
  generateKeyMaterial,
  removeTrustedCertificate,
} from "../dist/setup.js";

class MemorySecretStore {
  value;

  async get() {
    return this.value;
  }

  async set(value) {
    this.value = value;
  }

  async clear() {
    this.value = undefined;
  }
}

class MemorySessionStore {
  value;

  async get() {
    return this.value;
  }

  async set(value) {
    this.value = value;
  }

  async clear() {
    this.value = undefined;
  }
}

test("persists and clears Control Panel auth in the configured secret store", async () => {
  const store = new MacKeychainControlPanelAuthStore(new MemorySecretStore());
  const auth = {
    email: "user@example.com",
    idToken: "id-token",
    refreshToken: "refresh-token",
    localId: "user-id",
    expiresAt: 1_800_000_000_000,
  };

  await store.set(auth);
  assert.deepEqual(await store.get(), auth);
  await store.clear();
  assert.equal(await store.get(), undefined);
});

test("stores generated application credentials in the configured secret store", async () => {
  const secretStore = new MemorySecretStore();
  const store = new MacKeychainApplicationStore(secretStore);
  const application = {
    appId: "app-id",
    privateKey: "private-key",
    certificate: "certificate",
    environment: "SANDBOX",
    redirectUrls: ["https://localhost:8765/callback"],
  };

  await store.set(application);

  assert.deepEqual(await store.get(), application);
  await store.clear();
  assert.equal(await store.get(), undefined);
});
test("rejects invalid stored certificates before cleanup commands", async () => {
  await assert.rejects(
    removeTrustedCertificate("not-a-certificate"),
    /Stored localhost certificate is invalid/,
  );
});

test("removes a trusted certificate using its SHA-1 fingerprint", async (context) => {
  const { certificate } = await generateKeyMaterial();
  const expectedFingerprint = new X509Certificate(certificate).fingerprint.replaceAll(
    ":",
    "",
  );
  let capturedArgs;
  const realSpawn = childProcess.spawn.bind(childProcess);
  context.mock.method(childProcess, "spawn", (command, args = [], options) => {
    if (command !== "/usr/bin/security") {
      return realSpawn(command, args, options);
    }
    capturedArgs = args;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  });
  syncBuiltinESMExports();
  try {
    await removeTrustedCertificate(certificate);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  }

  assert.deepEqual(capturedArgs.slice(0, 3), [
    "delete-certificate",
    "-Z",
    expectedFingerprint,
  ]);
});

test("reports persisted completion after the MCP process restarts", async () => {
  const applicationStore = new MemoryApplicationStore();
  const sessionStore = new MemorySessionStore();
  await applicationStore.set({ appId: "persisted-app-id" });
  await sessionStore.set("persisted-session-id");
  const setup = new ApplicationSetupFlow({ applicationStore, sessionStore });

  assert.deepEqual(await setup.getStatus(), {
    phase: "complete",
    pending: false,
    appId: "persisted-app-id",
    sessionStored: true,
    message: "Enable Banking setup is complete",
  });
});

test("uses the documented Control Panel registration requests", async () => {
  const calls = [];
  const client = new ControlPanelClient(async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("getOobConfirmationCode")) {
      return new Response("{}", { status: 200 });
    }
    if (String(url).endsWith("emailLinkSignin")) {
      return new Response(
        JSON.stringify({
          idToken: "id-token",
          refreshToken: "refresh-token",
          localId: "user-id",
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ app_id: "app-id" }), { status: 200 });
  });

  await client.requestEmailLogin(
    "user@example.com",
    4321,
    `/callback?state=${"A".repeat(43)}`,
  );
  const auth = await client.completeEmailLogin("user@example.com", "oob-code");
  const registration = await client.registerApplication(auth, {
    name: "Enable Banking MCP",
    certificate: "certificate",
    environment: "SANDBOX",
    redirect_urls: ["https://localhost:8765/callback"],
  });

  assert.deepEqual(registration, { app_id: "app-id" });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    requestType: "EMAIL_SIGNIN",
    email: "user@example.com",
    continueUrl: `http://localhost:4321/callback?state=${"A".repeat(43)}`,
    canHandleCodeInApp: true,
  });
  assert.deepEqual(auth, {
    email: "user@example.com",
    idToken: "id-token",
    refreshToken: "refresh-token",
    localId: "user-id",
  });
  assert.equal(calls[2].options.headers.Authorization, "Bearer id-token");
});

test("reuses a matching unexpired Control Panel session without sending email", async () => {
  const existingAuth = {
    email: "user@example.com",
    idToken: "existing-id-token",
    refreshToken: "test-existing-refresh-token",
    expiresAt: Date.now() + 60_000,
  };
  let listenerCalls = 0;
  const client = new ControlPanelClient(
    async () => {
      throw new Error("The unexpired stored session should be reused");
    },
    "https://enablebanking.com",
    "",
  );
  const flow = new ControlPanelAuthFlow(client, async () => {
    listenerCalls += 1;
    throw new Error("Email callback listener should not be opened");
  });

  const auth = await flow.authenticate("USER@example.com", existingAuth);

  assert.deepEqual(auth, existingAuth);
  assert.equal(listenerCalls, 0);
});

test("silently refreshes an expired Control Panel session when configured", async () => {
  const calls = [];
  const client = new ControlPanelClient(
    async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(
        JSON.stringify({
          id_token: "renewed-id-token",
          refresh_token: "test-rotated-refresh-token",
          user_id: "user-id",
          expires_in: "3600",
        }),
        { status: 200 },
      );
    },
    "https://enablebanking.com",
    "",
  );
  const flow = new ControlPanelAuthFlow(client, async () => {
    throw new Error("A successful refresh should not open an email callback");
  });

  const auth = await flow.authenticate("user@example.com", {
    email: "user@example.com",
    idToken: "expired-id-token",
    refreshToken: "old-refresh-token",
    expiresAt: 1,
  });
  const refreshUrl = new URL(calls[0].url);
  const refreshBody = new URLSearchParams(calls[0].options.body);

  assert.equal(calls.length, 1);
  assert.ok(refreshUrl.searchParams.get("key"));
  assert.equal(refreshBody.get("grant_type"), "refresh_token");
  assert.equal(refreshBody.get("refresh_token"), "old-refresh-token");
  assert.equal(auth.idToken, "renewed-id-token");
  assert.equal(auth.refreshToken, "test-rotated-refresh-token");
  assert.ok(auth.expiresAt > Date.now());
});
test("refreshes matching stored Control Panel auth with missing expiry metadata", async () => {
  let refreshCalls = 0;
  const client = {
    async refreshAuth(auth) {
      refreshCalls += 1;
      return { ...auth, idToken: "renewed-id-token", expiresAt: Date.now() + 60_000 };
    },
  };
  const flow = new ControlPanelAuthFlow(client, async () => {
    throw new Error("A refreshable session should not open an email callback");
  });
  const auth = await flow.authenticate("user@example.com", {
    email: "user@example.com",
    idToken: "stored-id-token",
    refreshToken: "fake-stored-refresh-token",
  });

  assert.equal(refreshCalls, 1);
  assert.equal(auth.idToken, "renewed-id-token");
});

test("requests a sign-in link when the stored refresh token is rejected", async () => {
  const calls = [];
  const client = new ControlPanelClient(
    async (url, options) => {
      const requestUrl = String(url);
      calls.push({ url: requestUrl, options });
      if (requestUrl.includes("securetoken.googleapis.com")) {
        return new Response(
          JSON.stringify({ error: { message: "INVALID_REFRESH_TOKEN" } }),
          { status: 400, statusText: "Bad Request" },
        );
      }
      if (requestUrl.endsWith("getOobConfirmationCode")) {
        return new Response("{}", { status: 200 });
      }
      if (requestUrl.endsWith("emailLinkSignin")) {
        return new Response(
          JSON.stringify({
            idToken: "new-id-token",
            refreshToken: "new-refresh-token",
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected Control Panel request: ${requestUrl}`);
    },
    "https://enablebanking.com",
    "firebase-api-key",
  );
  let listenerCalls = 0;
  const flow = new ControlPanelAuthFlow(client, async () => {
    listenerCalls += 1;
    return {
      port: 4321,
      path: `/callback?state=${"A".repeat(43)}`,
      wait: Promise.resolve("one-time-code"),
      close: async () => {},
    };
  });

  const auth = await flow.authenticate("user@example.com", {
    email: "user@example.com",
    idToken: "expired-id-token",
    refreshToken: "test-rejected-refresh-token",
    expiresAt: 1,
  });

  assert.deepEqual(
    calls.map(({ url }) => new URL(url).pathname),
    [
      "/v1/token",
      "/api/relyingparty/getOobConfirmationCode",
      "/api/relyingparty/emailLinkSignin",
    ],
  );
  assert.equal(listenerCalls, 1);
  assert.equal(auth.idToken, "new-id-token");
});

test("propagates transient refresh failures without requesting another login", async () => {
  let listenerCalls = 0;
  const client = new ControlPanelClient(
    async () =>
      new Response("service unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      }),
    "https://enablebanking.com",
    "firebase-api-key",
  );
  const flow = new ControlPanelAuthFlow(client, async () => {
    listenerCalls += 1;
    throw new Error("Email sign-in should not be requested");
  });

  await assert.rejects(
    flow.authenticate("user@example.com", {
      email: "user@example.com",
      idToken: "expired-id-token",
      refreshToken: "refresh-token",
      expiresAt: 1,
    }),
    /Control Panel 503/,
  );
  assert.equal(listenerCalls, 0);
});

test("rejects Control Panel callback paths without a valid state", async () => {
  const client = new ControlPanelClient(async () => new Response("{}", { status: 200 }));
  await assert.rejects(
    client.requestEmailLogin("user@example.com", 4321, "/callback"),
    /callback path must contain a valid state/,
  );
});

test("receives the Control Panel email callback on a loopback listener", async () => {
  const listener = await createControlPanelCallbackListener();
  try {
    const callback = new URL(
      listener.path,
      `http://localhost:${listener.port}`,
    );
    const invalid = new URL(callback);
    invalid.searchParams.set("state", "wrong");
    const invalidResponse = await fetch(invalid);
    assert.equal(invalidResponse.status, 400);

    const malformedRequest = await new Promise((resolve, reject) => {
      const socket = connect(listener.port, "localhost", () => {
        socket.end(
          "GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        );
      });
      let response = "";
      socket.on("data", (chunk) => {
        response += chunk;
      });
      socket.once("error", reject);
      socket.once("close", () => resolve(response));
    });
    assert.match(malformedRequest, /^HTTP\/1\.1 400 /);

    const wrongMethod = await fetch(callback, { method: "POST" });
    assert.equal(wrongMethod.status, 404);
    const missingCode = await fetch(callback);
    assert.equal(missingCode.status, 400);
    callback.searchParams.set("oobCode", "confirmation-code");
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    assert.equal(await listener.wait, "confirmation-code");
  } finally {
    await listener.close();
  }
});

test("rejects a denied Control Panel callback and closes idempotently", async () => {
  const listener = await createControlPanelCallbackListener();
  try {
    const denied = new URL(
      listener.path,
      `http://localhost:${listener.port}`,
    );
    denied.searchParams.set("error", "access_denied");
    const completion = assert.rejects(
      listener.wait,
      /Control Panel sign-in was denied/,
    );
    const response = await fetch(denied);
    assert.equal(response.status, 400);
    await completion;
  } finally {
    await listener.close();
    await listener.close();
  }
});
test("Control Panel auth flow rejects malformed callback paths and closes its listener", async () => {
  const malformedPaths = [
    "/not-callback?state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "/callback?state=short",
    `https://evil.example/callback?state=${"A".repeat(43)}`,
    `/callback?state=${"A".repeat(43)}&extra=value`,
  ];

  for (const path of malformedPaths) {
    let requests = 0;
    let closed = 0;
    const client = new ControlPanelClient(async () => {
      requests += 1;
      return new Response("{}", { status: 200 });
    });
    const flow = new ControlPanelAuthFlow(client, async () => ({
      port: 4321,
      path,
      wait: new Promise(() => {}),
      close: async () => {
        closed += 1;
      },
    }));

    await assert.rejects(
      flow.authenticate("user@example.com"),
      /callback path/,
    );
    assert.equal(requests, 0, `malformed callback path reached provider: ${path}`);
    assert.equal(closed, 1, `listener was not closed for path: ${path}`);
  }
});

test("Control Panel auth flow handles invalid state, missing code, and a valid callback", async () => {
  const requests = [];
  let listener;
  let closeCalls = 0;
  const client = {
    async requestEmailLogin(email, port, path) {
      requests.push({ email, port, path });
    },
    async completeEmailLogin(email, code) {
      return { email, idToken: `id:${code}`, refreshToken: "refresh-token" };
    },
  };
  const flow = new ControlPanelAuthFlow(client, async () => {
    listener = await createControlPanelCallbackListener();
    const close = listener.close;
    listener.close = async () => {
      closeCalls += 1;
      await close();
    };
    return listener;
  });

  const pendingLogin = flow.authenticate("  user@example.com  ");
  while (!listener) await new Promise((resolve) => setImmediate(resolve));
  const callback = new URL(
    requests[0].path,
    `http://localhost:${requests[0].port}`,
  );

  const wrongState = new URL(callback);
  wrongState.searchParams.set("state", "incorrect");
  const badStateResponse = await fetch(wrongState);
  assert.equal(badStateResponse.status, 400);
  assert.match(await badStateResponse.text(), /Invalid Enable Banking sign-in state/);

  const missingCodeResponse = await fetch(callback);
  assert.equal(missingCodeResponse.status, 400);
  assert.match(await missingCodeResponse.text(), /sign-in code was not provided/);

  callback.searchParams.set("oobCode", "one-time-code");
  const validResponse = await fetch(callback);
  assert.equal(validResponse.status, 200);
  assert.equal(await validResponse.text(), "Enable Banking sign-in complete. You may close this window.");
  assert.deepEqual(await pendingLogin, {
    email: "user@example.com",
    idToken: "id:one-time-code",
    refreshToken: "refresh-token",
  });
  assert.equal(requests.length, 1);
  assert.equal(closeCalls, 1);
  await assert.rejects(
    fetch(`http://localhost:${requests[0].port}${requests[0].path}`),
    /fetch failed|ECONNREFUSED/,
  );
});

test("Control Panel auth flow rejects provider denial and closes its listener", async () => {
  let listener;
  let closeCalls = 0;
  const client = {
    async requestEmailLogin() {},
    async completeEmailLogin() {
      assert.fail("denied callback must not complete login");
    },
  };
  const flow = new ControlPanelAuthFlow(client, async () => {
    listener = await createControlPanelCallbackListener();
    const close = listener.close;
    listener.close = async () => {
      closeCalls += 1;
      await close();
    };
    return listener;
  });

  const pendingLogin = flow.authenticate("user@example.com");
  const rejectedLogin = assert.rejects(
    pendingLogin,
    /Control Panel sign-in was denied/,
  );
  while (!listener) await new Promise((resolve) => setImmediate(resolve));
  const denied = new URL(
    listener.path,
    `http://localhost:${listener.port}`,
  );
  denied.searchParams.set("error", "access_denied");
  const response = await fetch(denied);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /sign-in was denied/);
  await rejectedLogin;
  assert.equal(closeCalls, 1);
  await assert.rejects(
    fetch(`http://localhost:${listener.port}${listener.path}`),
    /fetch failed|ECONNREFUSED/,
  );
});

test("completes a sandbox setup without shelling to another application", async () => {
  const applicationStore = new MemoryApplicationStore();
  const sessionStore = new MemorySessionStore();
  const controlPanelCalls = [];
  const controlPanelClient = new ControlPanelClient(async (url, options) => {
    controlPanelCalls.push({ url: String(url), options });
    if (String(url).endsWith("getOobConfirmationCode")) {
      return new Response("{}", { status: 200 });
    }
    if (String(url).endsWith("emailLinkSignin")) {
      return new Response(
        JSON.stringify({ idToken: "id-token", refreshToken: "refresh-token" }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ app_id: "new-app-id" }), { status: 200 });
  });
  const controlPanelAuth = new ControlPanelAuthFlow(
    controlPanelClient,
    async () => ({
      port: 4321,
      path: `/callback?state=${"A".repeat(43)}`,
      wait: Promise.resolve("oob-code"),
      close: async () => {},
    }),
  );
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const bankCalls = [];
  const bankClientFactory = (credentials) =>
    new EnableBankingClient(credentials, async (url, options) => {
      bankCalls.push({ url: String(url), options });
      if (new URL(String(url)).pathname === "/aspsps") {
        const requestUrl = new URL(String(url));
        assert.equal(requestUrl.searchParams.get("psu_type"), "personal");
        assert.equal(requestUrl.searchParams.get("service"), "AIS");
        assert.equal(requestUrl.searchParams.get("country"), "FI");
        return new Response(
          JSON.stringify({
            aspsps: [{ name: "Example Bank", country: "FI" }],
          }),
          { status: 200 },
        );
      }
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
      return new Response(JSON.stringify({ session_id: "new-session-id" }), {
        status: 200,
      });
    });
  const openedUrls = [];
  let trustCalls = 0;
  const bankAuthorizationFlow = new BankAuthorizationFlow(
    sessionStore,
    (url) => openedUrls.push(url),
    async () => ({
      wait: Promise.resolve("bank-code"),
      close: async () => {},
    }),
  );
  const controlPanelAuthStore = new MacKeychainControlPanelAuthStore(
    new MemorySecretStore(),
  );
  const setup = new ApplicationSetupFlow({
    applicationStore,
    sessionStore,
    controlPanelClient,
    controlPanelAuth,
    controlPanelAuthStore,
    authorizationFlow: bankAuthorizationFlow,
    createBankClient: bankClientFactory,
    generateKeyMaterial: async () => ({
      privateKey,
      certificate: "certificate",
    }),
    trustCertificate: async () => {
      trustCalls += 1;
    },
    sleep: async () => {},
  });

  const started = await setup.start({
    controlPanelEmail: "user@example.com",
    appName: "Enable Banking MCP",
    environment: "SANDBOX",
    redirectUrl: "https://localhost:8765/callback",
    aspspName: "Example Bank",
    country: "FI",
    validUntil: "2099-01-01T00:00:00Z",
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (setup.status.phase === "complete") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(started.status, "started");
  assert.equal(setup.status.phase, "complete", setup.status.error);
  assert.equal(setup.status.appId, "new-app-id");
  assert.equal(setup.status.sessionStored, true);
  assert.deepEqual(await applicationStore.get(), {
    appId: "new-app-id",
    privateKey,
    certificate: "certificate",
    environment: "SANDBOX",
    redirectUrls: ["https://localhost:8765/callback"],
  });
  assert.equal(await sessionStore.get(), "new-session-id");
  assert.deepEqual(await controlPanelAuthStore.get(), {
    email: "user@example.com",
    idToken: "id-token",
    refreshToken: "refresh-token",
  });
  assert.equal(trustCalls, 1);
  assert.deepEqual(openedUrls, ["https://bank.example/authorize"]);
  assert.equal(controlPanelCalls.length, 3);
  assert.equal(bankCalls.length, 3);
  assert.ok(bankCalls[0].url.includes("/aspsps?"));
  await applicationStore.clear();
  await sessionStore.clear();
  assert.deepEqual(await setup.getStatus(), {
    phase: "idle",
    pending: false,
  });
});



test("registers an application before bank details are provided", async () => {
  const applicationStore = new MemoryApplicationStore();
  const sessionStore = new MemorySessionStore();
  const controlPanelCalls = [];
  const controlPanelClient = new ControlPanelClient(async (url, options) => {
    controlPanelCalls.push({ url: String(url), options });
    if (String(url).endsWith("/api/applications")) {
      return new Response(JSON.stringify({ app_id: "application-only-id" }), {
        status: 200,
      });
    }
    throw new Error(`Unexpected Control Panel request: ${url}`);
  });
  const controlPanelAuth = new ControlPanelAuthFlow(
    controlPanelClient,
    async () => ({
      port: 4321,
      path: `/callback?state=${"A".repeat(43)}`,
      wait: Promise.resolve("oob-code"),
      close: async () => {},
    }),
  );
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const openedUrls = [];
  let trustCalls = 0;
  const controlPanelAuthStore = new MacKeychainControlPanelAuthStore(
    new MemorySecretStore(),
  );
  await controlPanelAuthStore.set({
    email: "user@example.com",
    idToken: "stored-id-token",
    refreshToken: "test-stored-refresh-token",
    expiresAt: Date.now() + 300_000,
  });
  const setup = new ApplicationSetupFlow({
    applicationStore,
    sessionStore,
    controlPanelClient,
    controlPanelAuth,
    openBrowser: (url) => openedUrls.push(url),
    controlPanelAuthStore,
    authorizationFlow: new BankAuthorizationFlow(
      sessionStore,
      (url) => openedUrls.push(url),
    ),
    generateKeyMaterial: async () => ({
      privateKey,
      certificate: "certificate",
    }),
    trustCertificate: async () => {
      trustCalls += 1;
    },
  });

  const started = await setup.registerApplication({
    controlPanelEmail: "user@example.com",
    appName: "Enable Banking MCP",
    environment: "PRODUCTION",
    redirectUrl: "https://localhost:8765/callback",
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!setup.status.pending) break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(started.status, "started");
  assert.equal(setup.status.phase, "account_link", setup.status.error);
  assert.equal(setup.status.pending, false);
  assert.equal(setup.status.appId, "application-only-id");
  assert.equal(setup.status.dashboardUrl, "https://enablebanking.com/cp/applications");
  assert.deepEqual(await sessionStore.get(), undefined);
  assert.deepEqual(await applicationStore.get(), {
    appId: "application-only-id",
    privateKey,
    certificate: "certificate",
    environment: "PRODUCTION",
    redirectUrls: ["https://localhost:8765/callback"],
  });
  assert.deepEqual(openedUrls, ["https://enablebanking.com/cp/applications"]);
  assert.equal(trustCalls, 1);
  assert.equal(controlPanelCalls.length, 1);
  assert.ok(controlPanelCalls[0].url.endsWith("/api/applications"));
  assert.equal(
    controlPanelCalls[0].options.headers.Authorization,
    "Bearer stored-id-token",
  );

  const restarted = new ApplicationSetupFlow({
    applicationStore,
    sessionStore,
  });
  const restartedStatus = await restarted.getStatus();
  assert.equal(restartedStatus.phase, "account_link");
  assert.equal(restartedStatus.pending, false);
  assert.equal(restartedStatus.appId, "application-only-id");
  assert.equal(
    restartedStatus.dashboardUrl,
    "https://enablebanking.com/cp/applications",
  );
  await applicationStore.clear();
  setup.reset();
  assert.deepEqual(await setup.getStatus(), {
    phase: "idle",
    pending: false,
  });
});
test("checks provider activation before reporting a persisted Production app", async () => {
  const applicationStore = new MemoryApplicationStore();
  const sessionStore = new MemorySessionStore();
  await applicationStore.set({
    appId: "persisted-production-app",
    privateKey: "private-key",
    certificate: "certificate",
    environment: "PRODUCTION",
    redirectUrls: ["https://localhost:8765/callback"],
  });
  let activationChecks = 0;
  const setup = new ApplicationSetupFlow({
    applicationStore,
    sessionStore,
    createBankClient: () => ({
      async getApplication() {
        activationChecks += 1;
        return { active: true };
      },
    }),
  });

  const status = await setup.getStatus();

  assert.equal(activationChecks, 1);
  assert.equal(status.phase, "application_ready");
});

test("reports Production activation as unverified when provider lookup fails", async () => {
  const applicationStore = new MemoryApplicationStore();
  const sessionStore = new MemorySessionStore();
  await applicationStore.set({
    appId: "persisted-production-app",
    privateKey: "private-key",
    certificate: "certificate",
    environment: "PRODUCTION",
    redirectUrls: ["https://localhost:8765/callback"],
  });
  const setup = new ApplicationSetupFlow({
    applicationStore,
    sessionStore,
    createBankClient: () => ({
      async getApplication() {
        throw new Error("provider unavailable");
      },
    }),
  });

  const status = await setup.getStatus();

  assert.equal(status.phase, "account_link");
  assert.match(status.message, /could not be verified/);
});

class MemoryApplicationStore {
  value;

  async get() {
    return this.value;
  }

  async set(value) {
    this.value = value;
  }

  async clear() {
    this.value = undefined;
  }
}

test("reserves the setup slot before asynchronous store checks", async () => {
  let releaseStoreReads;
  const storeReads = new Promise((resolve) => {
    releaseStoreReads = resolve;
  });
  const gatedStore = {
    async get() {
      await storeReads;
      return undefined;
    },
    async set() {},
    async clear() {},
  };
  const setup = new ApplicationSetupFlow({
    applicationStore: gatedStore,
    sessionStore: gatedStore,
    generateKeyMaterial: async () => ({
      privateKey: "private-key",
      certificate: "certificate",
    }),
  });
  const options = {
    controlPanelEmail: "user@example.com",
    appName: "Enable Banking MCP",
    environment: "SANDBOX",
    redirectUrl: "https://localhost:8765/callback",
  };

  const first = setup.registerApplication(options);
  assert.equal(setup.status.pending, true);
  await assert.rejects(
    setup.registerApplication(options),
    /Enable Banking setup is already in progress/,
  );

  releaseStoreReads();
  const started = await first;
  assert.equal(started.status, "started");
});

test("rolls back the setup reservation after validation fails", async () => {
  const setup = new ApplicationSetupFlow({
    applicationStore: new MemoryApplicationStore(),
    sessionStore: new MemorySessionStore(),
  });

  await assert.rejects(
    setup.registerApplication({
      controlPanelEmail: "user@example.com",
      appName: "",
      environment: "SANDBOX",
      redirectUrl: "https://localhost:8765/callback",
    }),
    /app_name is required/,
  );
  assert.deepEqual(setup.status, {
    phase: "idle",
    pending: false,
  });
});
async function waitForSetup(setup) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!setup.status.pending) return setup.status;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Setup did not leave its pending state");
}

function registrationOptions(overrides = {}) {
  return {
    controlPanelEmail: "user@example.com",
    appName: "Enable Banking MCP",
    environment: "SANDBOX",
    redirectUrl: "https://localhost:8765/callback",
    ...overrides,
  };
}

function setupDependencies(overrides = {}) {
  const applicationStore = overrides.applicationStore ?? new MemoryApplicationStore();
  const sessionStore = overrides.sessionStore ?? new MemorySessionStore();
  const setup = new ApplicationSetupFlow({
    applicationStore,
    sessionStore,
    controlPanelAuth: {
      async authenticate(email) {
        return { email, idToken: "fake-id-token", refreshToken: "fake-refresh-token" };
      },
    },
    controlPanelClient: {
      async registerApplication() {
        return { app_id: "recorded-app-id" };
      },
    },
    authorizationFlow: {
      status: { pending: false },
      async start() {
        throw new Error("authorization collaborator not configured");
      },
    },
    generateKeyMaterial: async () => ({
      privateKey: "fake-private-key",
      certificate: "fake-certificate",
    }),
    trustCertificate: async () => {},
    createBankClient: () => ({
      async listBanks() {
        return { aspsps: [{ name: "Example Bank" }] };
      },
    }),
    sleep: async () => {},
    ...overrides,
  });
  return { setup, applicationStore, sessionStore };
}

test("rejects setup when either application or session state is already persisted", async () => {
  const storedApplication = {
    appId: "existing-app",
    privateKey: "fake-private-key",
    certificate: "fake-certificate",
    environment: "SANDBOX",
    redirectUrls: ["https://localhost:8765/callback"],
  };

  for (const existing of [
    { applicationStore: Object.assign(new MemoryApplicationStore(), { value: storedApplication }) },
    { sessionStore: Object.assign(new MemorySessionStore(), { value: "existing-session" }) },
  ]) {
    let registrationCalls = 0;
    const { setup } = setupDependencies({
      ...existing,
      controlPanelClient: {
        async registerApplication() {
          registrationCalls += 1;
          return { app_id: "unexpected-app" };
        },
      },
    });

    await assert.rejects(
      setup.registerApplication(registrationOptions()),
      /already stored/,
    );
    assert.equal(registrationCalls, 0);
    assert.deepEqual(setup.status, { phase: "idle", pending: false });
  }
});

test("records provider registration failures as failed setup without application persistence", async () => {
  const registrationCalls = [];
  const { setup, applicationStore } = setupDependencies({
    controlPanelClient: {
      async registerApplication(auth, request) {
        registrationCalls.push({ auth, request });
        throw new Error("provider registration rejected");
      },
    },
  });

  await setup.registerApplication(registrationOptions());
  const status = await waitForSetup(setup);

  assert.equal(status.phase, "failed");
  assert.equal(status.pending, false);
  assert.equal(status.error, "provider registration rejected");
  assert.equal(await applicationStore.get(), undefined);
  assert.equal(registrationCalls.length, 1);
  assert.equal(registrationCalls[0].request.name, "Enable Banking MCP");
  assert.equal(registrationCalls[0].request.certificate, "fake-certificate");
});

test("keeps registered application persisted when certificate trust fails", async () => {
  let trustCalls = 0;
  const { setup, applicationStore, sessionStore } = setupDependencies({
    trustCertificate: async (certificate) => {
      trustCalls += 1;
      assert.equal(certificate, "fake-certificate");
      throw new Error("certificate trust failed");
    },
  });

  await setup.registerApplication(registrationOptions());
  const status = await waitForSetup(setup);

  assert.equal(status.phase, "failed");
  assert.equal(status.appId, "recorded-app-id");
  assert.equal(status.error, "certificate trust failed");
  assert.equal(trustCalls, 1);
  assert.equal((await applicationStore.get()).appId, "recorded-app-id");
  const restarted = new ApplicationSetupFlow({ applicationStore, sessionStore });
  assert.equal((await restarted.getStatus()).phase, "application_ready");
});

test("fails setup when the requested bank is absent and retains the registered application", async () => {
  let authorizationCalls = 0;
  const { setup, applicationStore } = setupDependencies({
    authorizationFlow: {
      status: { pending: false },
      async start() {
        authorizationCalls += 1;
        return { authorization_url: "https://bank.example/authorize" };
      },
    },
    createBankClient: () => ({
      async listBanks() {
        return { aspsps: [{ name: "Other Bank" }] };
      },
    }),
  });
  await setup.start({
    ...registrationOptions(),
    aspspName: "Example Bank",
    country: "FI",
  });
  const status = await waitForSetup(setup);

  assert.equal(status.phase, "failed");
  assert.match(status.error, /ASPSP "Example Bank" is not available in SANDBOX for FI/);
  assert.equal(authorizationCalls, 0);
  assert.equal((await applicationStore.get()).appId, "recorded-app-id");
});

test("reports bank authorization startup errors without losing application state", async () => {
  const { setup, applicationStore, sessionStore } = setupDependencies({
    authorizationFlow: {
      status: { pending: false, lastError: "callback failed" },
      async start() {
        throw new Error("authorization provider unavailable");
      },
    },
  });

  await setup.start({
    ...registrationOptions(),
    aspspName: "Example Bank",
    country: "FI",
  });
  const status = await waitForSetup(setup);

  assert.equal(status.phase, "failed");
  assert.equal(status.error, "authorization provider unavailable");
  assert.equal((await applicationStore.get()).appId, "recorded-app-id");
  assert.equal(await sessionStore.get(), undefined);
});

test("surfaces callback cancellation after authorization starts and keeps application state", async () => {
  const authorizationFlow = {
    status: { pending: true },
    async start() {
      this.status = { pending: false, lastError: "bank callback was cancelled" };
      return { authorization_url: "https://bank.example/authorize" };
    },
  };
  const { setup, applicationStore, sessionStore } = setupDependencies({
    authorizationFlow,
  });

  await setup.start({
    ...registrationOptions(),
    aspspName: "Example Bank",
    country: "FI",
  });
  const status = await waitForSetup(setup);

  assert.equal(status.phase, "failed");
  assert.equal(status.error, "bank callback was cancelled");
  assert.equal(status.appId, "recorded-app-id");
  assert.equal((await applicationStore.get()).appId, "recorded-app-id");
  assert.equal(await sessionStore.get(), undefined);
});

test("rolls back setup reservation when a secret-store read fails", async () => {
  const applicationStore = new MemoryApplicationStore();
  applicationStore.get = async () => {
    throw new Error("application Keychain read failed");
  };
  let registrationCalls = 0;
  const { setup } = setupDependencies({
    applicationStore,
    controlPanelClient: {
      async registerApplication() {
        registrationCalls += 1;
        return { app_id: "unexpected-app" };
      },
    },
  });

  await assert.rejects(
    setup.registerApplication(registrationOptions()),
    /application Keychain read failed/,
  );
  assert.deepEqual(setup.status, { phase: "idle", pending: false });
  assert.equal(registrationCalls, 0);
});

test("fails Control Panel authentication before application registration", async () => {
  let registrationCalls = 0;
  const { setup, applicationStore } = setupDependencies({
    controlPanelAuth: {
      async authenticate() {
        throw new Error("Control Panel authentication failed");
      },
    },
    controlPanelClient: {
      async registerApplication() {
        registrationCalls += 1;
        return { app_id: "unexpected-app" };
      },
    },
  });

  await setup.registerApplication(registrationOptions());
  const status = await waitForSetup(setup);

  assert.equal(status.phase, "failed");
  assert.equal(status.error, "Control Panel authentication failed");
  assert.equal(await applicationStore.get(), undefined);
  assert.equal(registrationCalls, 0);
});

test("reports provider-created application when local persistence fails", async () => {
  const applicationStore = new MemoryApplicationStore();
  applicationStore.set = async () => {
    throw new Error("application Keychain write failed");
  };
  let registrationCalls = 0;
  const { setup } = setupDependencies({
    applicationStore,
    controlPanelClient: {
      async registerApplication() {
        registrationCalls += 1;
        return { app_id: "provider-app-id" };
      },
    },
  });

  await setup.registerApplication(registrationOptions());
  const status = await waitForSetup(setup);

  assert.equal(status.phase, "failed");
  assert.equal(status.error, "application Keychain write failed");
  assert.equal(status.appId, undefined);
  assert.equal(registrationCalls, 1);
});

test("reports an empty bank catalog without starting authorization", async () => {
  let authorizationCalls = 0;
  const { setup, applicationStore } = setupDependencies({
    authorizationFlow: {
      status: { pending: false },
      async start() {
        authorizationCalls += 1;
        return { authorization_url: "https://bank.example/authorize" };
      },
    },
    createBankClient: () => ({
      async listBanks() {
        return { aspsps: [] };
      },
    }),
  });

  await setup.start({
    ...registrationOptions(),
    aspspName: "Example Bank",
    country: "FI",
  });
  const status = await waitForSetup(setup);

  assert.equal(status.phase, "failed");
  assert.match(status.error, /No ASPSPs were returned for this country/);
  assert.equal(authorizationCalls, 0);
  assert.equal((await applicationStore.get()).appId, "recorded-app-id");
});

test("times out Production activation without starting bank authorization", async () => {
  let now = 0;
  let activationChecks = 0;
  let authorizationCalls = 0;
  const openedUrls = [];
  const { setup, applicationStore, sessionStore } = setupDependencies({
    openBrowser: (url) => openedUrls.push(url),
    createBankClient: () => ({
      async getApplication() {
        activationChecks += 1;
        return { active: false };
      },
      async listBanks() {
        return { aspsps: [{ name: "Example Bank" }] };
      },
    }),
    authorizationFlow: {
      status: { pending: false },
      async start() {
        authorizationCalls += 1;
        return { authorization_url: "https://bank.example/authorize" };
      },
    },
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    now: () => now,
  });

  await setup.start({
    ...registrationOptions({ environment: "PRODUCTION" }),
    aspspName: "Example Bank",
    country: "FI",
  });
  const status = await waitForSetup(setup);

  assert.equal(status.phase, "account_link");
  assert.match(status.message, /resume connect_bank/);
  assert.ok(activationChecks > 0);
  assert.equal(authorizationCalls, 0);
  assert.deepEqual(openedUrls, ["https://enablebanking.com/cp/applications"]);
  assert.equal((await applicationStore.get()).appId, "recorded-app-id");
  assert.equal(await sessionStore.get(), undefined);
});

test("times out pending bank consent without discarding the registered application", async () => {
  let now = 0;
  let authorizationCalls = 0;
  const authorizationFlow = {
    status: { pending: false },
    async start() {
      authorizationCalls += 1;
      this.status = { pending: true };
      return { authorization_url: "https://bank.example/authorize" };
    },
  };
  const { setup, applicationStore, sessionStore } = setupDependencies({
    authorizationFlow,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    now: () => now,
  });

  await setup.start({
    ...registrationOptions(),
    aspspName: "Example Bank",
    country: "FI",
  });
  const status = await waitForSetup(setup);

  assert.equal(status.phase, "failed");
  assert.equal(status.error, "Bank authorization did not complete before setup timed out");
  assert.equal(status.authorizationUrl, undefined);
  assert.equal(status.message, undefined);
  assert.equal(authorizationCalls, 1);
  assert.equal((await applicationStore.get()).appId, "recorded-app-id");
  assert.equal(await sessionStore.get(), undefined);
});

test("reuses matching unexpired Control Panel auth without contacting the provider", async () => {
  const existingAuth = {
    email: "user@example.com",
    idToken: "current-id-token",
    refreshToken: "test-current-refresh-token",
    expiresAt: Date.now() + 60_000,
  };
  const flow = new ControlPanelAuthFlow(
    new ControlPanelClient(async () => {
      throw new Error("Unexpired auth should not call the provider");
    }),
    async () => {
      throw new Error("Unexpired auth should not open a callback listener");
    },
  );

  assert.equal(
    await flow.authenticate("USER@example.com", existingAuth),
    existingAuth,
  );
});

test("serializes Control Panel authentication and credential cleanup", async () => {
  const flow = new ControlPanelAuthFlow({});
  let finishAuthentication;
  const authentication = flow.withAuthentication(
    () =>
      new Promise((resolve) => {
        finishAuthentication = resolve;
      }),
  );

  await assert.rejects(
    flow.withCredentialCleanup(async () => undefined),
    /Cannot clear credentials while Control Panel authentication or cleanup is pending/,
  );
  finishAuthentication("authenticated");
  assert.equal(await authentication, "authenticated");

  let finishCleanup;
  const cleanup = flow.withCredentialCleanup(
    () =>
      new Promise((resolve) => {
        finishCleanup = resolve;
      }),
  );
  await assert.rejects(
    flow.authenticate("user@example.com"),
    /Control Panel credentials are being cleared/,
  );
  await assert.rejects(
    flow.withCredentialCleanup(async () => undefined),
    /Cannot clear credentials while Control Panel authentication or cleanup is pending/,
  );
  finishCleanup("cleared");
  assert.equal(await cleanup, "cleared");

  await assert.rejects(
    flow.withCredentialCleanup(async () => {
      throw new Error("credential deletion failed");
    }),
    /credential deletion failed/,
  );
  assert.equal(
    await flow.withAuthentication(async () => "authentication resumed"),
    "authentication resumed",
  );
});

test("a stored identity for another email starts a fresh Control Panel login", async () => {
  const calls = [];
  const client = new ControlPanelClient(
    async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("getOobConfirmationCode")) {
        return new Response("{}", { status: 200 });
      }
      return new Response(
        JSON.stringify({ idToken: "new-id-token", refreshToken: "new-refresh-token" }),
        { status: 200 },
      );
    },
    "https://enablebanking.com",
    "",
  );
  let closed = 0;
  const flow = new ControlPanelAuthFlow(client, async () => ({
    port: 4321,
    path: `/callback?state=${"A".repeat(43)}`,
    wait: Promise.resolve("one-time-code"),
    close: async () => {
      closed += 1;
    },
  }));
  const existingAuth = {
    email: "other@example.com",
    idToken: "other-id-token",
    refreshToken: "other-refresh-token",
    expiresAt: Date.now() + 60_000,
  };

  const auth = await flow.authenticate("user@example.com", existingAuth);

  assert.equal(auth.email, "user@example.com");
  assert.equal(auth.idToken, "new-id-token");
  assert.equal(auth.localId, undefined);
  assert.deepEqual(
    calls.map((url) => new URL(url).pathname),
    [
      "/api/relyingparty/getOobConfirmationCode",
      "/api/relyingparty/emailLinkSignin",
    ],
  );
  assert.equal(closed, 1);
});

test("closes the Control Panel listener when requesting an email link fails", async () => {
  const client = new ControlPanelClient(
    async () =>
      new Response("provider unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      }),
    "https://enablebanking.com",
    "",
  );
  let closed = 0;
  const flow = new ControlPanelAuthFlow(client, async () => ({
    port: 4321,
    path: `/callback?state=${"A".repeat(43)}`,
    wait: new Promise(() => {}),
    close: async () => {
      closed += 1;
    },
  }));

  await assert.rejects(
    flow.authenticate("user@example.com"),
    /Control Panel 503/,
  );
  assert.equal(closed, 1);
});

test("rejects malformed Control Panel login responses and closes the listener", async () => {
  let requestCount = 0;
  let closed = 0;
  const client = new ControlPanelClient(
    async () => {
      requestCount += 1;
      return new Response("{}", { status: 200 });
    },
    "https://enablebanking.com",
    "",
  );
  const flow = new ControlPanelAuthFlow(client, async () => ({
    port: 4321,
    path: `/callback?state=${"A".repeat(43)}`,
    wait: Promise.resolve("one-time-code"),
    close: async () => {
      closed += 1;
    },
  }));

  await assert.rejects(
    flow.authenticate("user@example.com"),
    /invalid login response/,
  );
  assert.equal(requestCount, 2);
  assert.equal(closed, 1);
});

test("key generation failure does not authenticate or register an application", async () => {
  let authenticationCalls = 0;
  let registrationCalls = 0;
  const { setup, applicationStore } = setupDependencies({
    async generateKeyMaterial() {
      throw new Error("certificate generation failed");
    },
    controlPanelAuth: {
      async authenticate() {
        authenticationCalls += 1;
        return { email: "user@example.com", idToken: "token", refreshToken: "refresh" };
      },
    },
    controlPanelClient: {
      async registerApplication() {
        registrationCalls += 1;
        return { app_id: "unexpected-app" };
      },
    },
  });

  await setup.registerApplication(registrationOptions());
  const status = await waitForSetup(setup);

  assert.equal(status.phase, "failed");
  assert.equal(status.error, "certificate generation failed");
  assert.equal(authenticationCalls, 0);
  assert.equal(registrationCalls, 0);
  assert.equal(await applicationStore.get(), undefined);
});

test("Control Panel auth persistence failure prevents provider registration", async () => {
  let registrationCalls = 0;
  const { setup, applicationStore } = setupDependencies({
    controlPanelAuthStore: {
      async get() {
        return undefined;
      },
      async set() {
        throw new Error("Control Panel Keychain write failed");
      },
    },
    controlPanelClient: {
      async registerApplication() {
        registrationCalls += 1;
        return { app_id: "unexpected-app" };
      },
    },
  });

  await setup.registerApplication(registrationOptions());
  const status = await waitForSetup(setup);

  assert.equal(status.phase, "failed");
  assert.equal(status.error, "Control Panel Keychain write failed");
  assert.equal(registrationCalls, 0);
  assert.equal(await applicationStore.get(), undefined);
});

test("a rejected 401 Control Panel refresh falls back to email sign-in", async () => {
  const calls = [];
  const client = new ControlPanelClient(
    async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({ error: { message: "TOKEN_EXPIRED" } }),
          { status: 401, statusText: "Unauthorized" },
        );
      }
      if (String(url).endsWith("getOobConfirmationCode")) {
        return new Response("{}", { status: 200 });
      }
      return new Response(
        JSON.stringify({ idToken: "new-id-token", refreshToken: "new-refresh-token" }),
        { status: 200 },
      );
    },
    "https://enablebanking.com",
    "",
  );
  const flow = new ControlPanelAuthFlow(client, async () => ({
    port: 4321,
    path: `/callback?state=${"A".repeat(43)}`,
    wait: Promise.resolve("one-time-code"),
    close: async () => {},
  }));

  const auth = await flow.authenticate("user@example.com", {
    email: "user@example.com",
    idToken: "expired-id-token",
    refreshToken: "test-rejected-refresh-token",
    expiresAt: 1,
  });

  assert.equal(auth.idToken, "new-id-token");
  assert.equal(calls.length, 3);
  assert.match(calls[1], /getOobConfirmationCode$/);
  assert.match(calls[2], /emailLinkSignin$/);
});

test("Control Panel refresh preserves optional stored identity fields", async () => {
  const client = new ControlPanelClient(
    async () =>
      new Response(
        JSON.stringify({ id_token: "renewed-id-token", expires_in: "3600" }),
        { status: 200 },
      ),
    "https://enablebanking.com",
    "",
  );
  const flow = new ControlPanelAuthFlow(client);
  const existingAuth = {
    email: "user@example.com",
    idToken: "expired-id-token",
    refreshToken: "test-current-refresh-token",
    localId: "existing-user-id",
    expiresAt: 1,
  };

  const auth = await flow.authenticate("user@example.com", existingAuth);

  assert.equal(auth.idToken, "renewed-id-token");
  assert.equal(auth.refreshToken, "test-current-refresh-token");
  assert.equal(auth.localId, "existing-user-id");
});

test("invalid Control Panel refresh responses do not trigger another login", async () => {
  let listenerCalls = 0;
  const client = new ControlPanelClient(
    async () => new Response("{}", { status: 200 }),
    "https://enablebanking.com",
    "",
  );
  const flow = new ControlPanelAuthFlow(client, async () => {
    listenerCalls += 1;
    throw new Error("Invalid refresh responses must not request a new login");
  });

  await assert.rejects(
    flow.authenticate("user@example.com", {
      email: "user@example.com",
      idToken: "expired-id-token",
      refreshToken: "test-current-refresh-token",
      expiresAt: 1,
    }),
    /invalid refresh response/,
  );
  assert.equal(listenerCalls, 0);
});

test("rejects invalid callback destinations and ports before Control Panel requests", async () => {
  const client = new ControlPanelClient(async () => {
    throw new Error("Invalid callback input must not reach the network");
  });
  const state = "A".repeat(43);
  for (const callbackPath of [
    `/other?state=${state}`,
    `https://attacker.example/callback?state=${state}`,
    `http://localhost/callback?state=${state}&extra=value`,
    `http://localhost/callback?state=${state}#fragment`,
  ]) {
    await assert.rejects(
      client.requestEmailLogin("user@example.com", 4321, callbackPath),
      /callback path must contain a valid state/,
    );
  }
  await assert.rejects(
    client.requestEmailLogin("user@example.com", 4321, "http://["),
    /callback path is invalid/,
  );
  await assert.rejects(
    client.requestEmailLogin("user@example.com", 0, `/callback?state=${state}`),
    /callback port is invalid/,
  );
});

test("rejects malformed provider application registration responses", async () => {
  const client = new ControlPanelClient(
    async () => new Response(JSON.stringify({}), { status: 200 }),
  );

  await assert.rejects(
    client.registerApplication(
      {
        email: "user@example.com",
        idToken: "id-token",
        refreshToken: "refresh-token",
      },
      {
        name: "Enable Banking MCP",
        certificate: "certificate",
        environment: "SANDBOX",
        redirect_urls: ["https://localhost:8765/callback"],
      },
    ),
    /invalid application registration response/,
  );
});

test("Control Panel callback timeout closes the listener and rejects login", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const requested = Promise.withResolvers();
  let closeCalls = 0;
  let listener;
  const flow = new ControlPanelAuthFlow(
    {
      async requestEmailLogin(email, port, path) {
        requested.resolve({ email, port, path });
      },
      async completeEmailLogin() {
        throw new Error("A timed-out callback must not complete login");
      },
    },
    async () => {
      listener = await createControlPanelCallbackListener();
      const close = listener.close;
      listener.close = async () => {
        closeCalls += 1;
        await close();
      };
      return listener;
    },
  );
  const pendingLogin = flow.authenticate("user@example.com");
  const request = await requested.promise;
  assert.equal(request.email, "user@example.com");
  assert.ok(request.port > 0);
  assert.match(request.path, /^\/callback\?state=/);
  const rejectedLogin = assert.rejects(
    pendingLogin,
    /Control Panel sign-in timed out/,
  );

  context.mock.timers.tick(10 * 60 * 1000);
  await rejectedLogin;
  assert.equal(closeCalls, 1);
  await assert.rejects(
    fetch(`http://localhost:${request.port}${request.path}`),
    /fetch failed|ECONNREFUSED/,
  );
});

test("Sandbox registration completes without opening the Production dashboard", async () => {
  const openedUrls = [];
  const { setup, applicationStore } = setupDependencies({
    openBrowser: (url) => openedUrls.push(url),
  });

  await setup.registerApplication(
    registrationOptions({ environment: "SANDBOX" }),
  );
  const status = await waitForSetup(setup);

  assert.equal(status.phase, "application_ready");
  assert.equal(status.pending, false);
  assert.equal(status.appId, "recorded-app-id");
  assert.equal(status.dashboardUrl, undefined);
  assert.equal((await applicationStore.get()).appId, "recorded-app-id");
  assert.deepEqual(openedUrls, []);
});
test("rejects invalid Control Panel email and callback ports before network access", async () => {
  let requestCount = 0;
  const client = new ControlPanelClient(async () => {
    requestCount += 1;
    return new Response("{}", { status: 200 });
  });
  const validCallback = `/callback?state=${"A".repeat(43)}`;

  await assert.rejects(
    client.requestEmailLogin("   ", 4321, validCallback),
    /control_panel_email must be a valid email address/,
  );
  await assert.rejects(
    client.requestEmailLogin("person@example.com", 65536, validCallback),
    /Control Panel callback port is invalid/,
  );
  assert.equal(requestCount, 0);
});
