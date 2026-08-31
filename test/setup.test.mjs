import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
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
  normalizeSetupOptions,
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
    callback.searchParams.set("oobCode", "confirmation-code");
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    assert.equal(await listener.wait, "confirmation-code");
  } finally {
    await listener.close();
  }
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


test("requires production compliance fields before registration", () => {
  assert.throws(
    () =>
      normalizeSetupOptions({
        controlPanelEmail: "user@example.com",
        appName: "Enable Banking MCP",
        environment: "PRODUCTION",
        redirectUrl: "https://localhost:8765/callback",
        aspspName: "Example Bank",
        country: "FI",
        allowRestrictedProduction: true,
      }),
    /description is required for PRODUCTION/,
  );
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
