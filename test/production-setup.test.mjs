import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { BankAuthorizationFlow } from "../dist/authorization.js";
import { ControlPanelAuthFlow, ControlPanelClient } from "../dist/control-panel.js";
import { EnableBankingClient } from "../dist/enable-banking.js";
import {
  ApplicationSetupFlow,
  callbackTlsFromApplication,
  normalizeApplicationRegistrationOptions,
  normalizeSetupOptions,
} from "../dist/setup.js";

class MemoryStore {
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

test("waits for production account linking before bank consent", async () => {
  const applicationStore = new MemoryStore();
  const sessionStore = new MemoryStore();
  const controlPanelClient = new ControlPanelClient(async (url) => {
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
  let activationChecks = 0;
  const bankClientFactory = (credentials) =>
    new EnableBankingClient(credentials, async (url) => {
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
      if (String(url).endsWith("/application")) {
        activationChecks += 1;
        return new Response(JSON.stringify({ active: activationChecks > 1 }), {
          status: 200,
        });
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
      return new Response(JSON.stringify({ session_id: "session-id" }), {
        status: 200,
      });
    });
  const openedUrls = [];
  const authorizationFlow = new BankAuthorizationFlow(
    sessionStore,
    (url) => openedUrls.push(url),
    async () => ({
      wait: Promise.resolve("bank-code"),
      close: async () => {},
    }),
  );
  const setup = new ApplicationSetupFlow({
    applicationStore,
    sessionStore,
    controlPanelClient,
    controlPanelAuth,
    authorizationFlow,
    openBrowser: (url) => openedUrls.push(url),
    createBankClient: bankClientFactory,
    generateKeyMaterial: async () => ({
      privateKey,
      certificate: "certificate",
    }),
    trustCertificate: async () => {},
    sleep: async () => {},
  });

  await setup.start({
    controlPanelEmail: "user@example.com",
    appName: "Enable Banking MCP",
    environment: "PRODUCTION",
    redirectUrl: "https://localhost:8765/callback",
    aspspName: "Example Bank",
    country: "FI",
    description: "A read-only local banking client",
    privacyUrl: "https://example.com/privacy",
    termsUrl: "https://example.com/terms",
    validUntil: "2099-01-01T00:00:00Z",
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (setup.status.phase === "complete") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(setup.status.phase, "complete");
  assert.equal(activationChecks, 2);
  assert.deepEqual(openedUrls, [
    "https://enablebanking.com/cp/applications",
    "https://bank.example/authorize",
  ]);
  assert.equal(await sessionStore.get(), "session-id");
});

test("requires HTTPS loopback callbacks for every environment", () => {
  assert.throws(
    () =>
      normalizeSetupOptions({
        controlPanelEmail: "user@example.com",
        appName: "Enable Banking MCP",
        environment: "PRODUCTION",
        redirectUrl: "http://localhost:8765/callback",
        aspspName: "Example Bank",
        country: "FI",
        description: "A read-only local banking client",
        privacyUrl: "https://example.com/privacy",
        termsUrl: "https://example.com/terms",
      }),
    /redirect_url must be an https:\/\/ localhost or 127\.0\.0\.1 URL/,
  );
});

test("defaults Production contact and policy fields", () => {
  const normalized = normalizeSetupOptions({
    controlPanelEmail: "user@example.com",
    appName: "Enable Banking MCP",
    environment: "PRODUCTION",
    redirectUrl: "https://localhost:8765/callback",
    aspspName: "Example Bank",
    country: "FI",
  });

  assert.equal(normalized.description, "Read-only personal account-information access");
  assert.equal(normalized.gdprEmail, "user@example.com");
  assert.equal(
    normalized.privacyUrl,
    "https://marcosvrs.github.io/enable-banking-mcp/privacy-policy/",
  );
  assert.equal(
    normalized.termsUrl,
    "https://marcosvrs.github.io/enable-banking-mcp/terms-of-use/",
  );
});

test("requires HTTPS policy URLs for Production setup", () => {
  assert.throws(
    () =>
      normalizeSetupOptions({
        controlPanelEmail: "user@example.com",
        appName: "Enable Banking MCP",
        environment: "PRODUCTION",
        redirectUrl: "https://localhost:8765/callback",
        aspspName: "Example Bank",
        country: "FI",
        description: "A read-only local banking client",
        privacyUrl: "http://example.com/privacy",
        termsUrl: "https://example.com/terms",
      }),
    /privacy_url must be a valid HTTPS URL/,
  );
});

test("keeps production application linking state when activation lookup fails", async () => {
  const applicationStore = new MemoryStore();
  const sessionStore = new MemoryStore();
  const controlPanelAuth = {
    async authenticate(email) {
      return { email, idToken: "fake-id-token", refreshToken: "fake-refresh-token" };
    },
  };
  const controlPanelClient = {
    async registerApplication() {
      return { app_id: "production-app-id" };
    },
  };
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  let activationCalls = 0;
  const openedUrls = [];
  const setup = new ApplicationSetupFlow({
    applicationStore,
    sessionStore,
    controlPanelClient,
    controlPanelAuth,
    authorizationFlow: {
      status: { pending: false },
      async start() {
        throw new Error("authorization must wait for activation");
      },
    },
    openBrowser: (url) => openedUrls.push(url),
    generateKeyMaterial: async () => ({
      privateKey,
      certificate: "fake-certificate",
    }),
    trustCertificate: async () => {},
    createBankClient: (credentials) =>
      new EnableBankingClient(credentials, async () => {
        activationCalls += 1;
        return new Response(JSON.stringify({ error: "temporarily unavailable" }), {
          status: 503,
        });
      }),
    sleep: async () => {},
  });

  await setup.start({
    controlPanelEmail: "user@example.com",
    appName: "Enable Banking MCP",
    environment: "PRODUCTION",
    redirectUrl: "https://localhost:8765/callback",
    aspspName: "Example Bank",
    country: "FI",
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!setup.status.pending) break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(setup.status.phase, "failed");
  assert.equal(setup.status.error, "Enable Banking API 503: temporarily unavailable");
  assert.equal(setup.status.appId, "production-app-id");
  assert.equal(activationCalls, 1);
  assert.deepEqual(openedUrls, ["https://enablebanking.com/cp/applications"]);
  assert.equal((await applicationStore.get()).appId, "production-app-id");
  assert.equal(await sessionStore.get(), undefined);
});

test("rejects invalid setup environment and consent metadata before setup starts", () => {
  const base = {
    controlPanelEmail: "user@example.com",
    appName: "Enable Banking MCP",
    environment: "SANDBOX",
    redirectUrl: "https://localhost:8765/callback",
    aspspName: "Example Bank",
    country: "FI",
  };
  const invalid = [
    [{ environment: "TEST" }, /environment must be PRODUCTION or SANDBOX/],
    [{ controlPanelEmail: "" }, /control_panel_email must be a valid email/],
    [{ appName: "  " }, /app_name is required/],
    [{ redirectUrl: "https://bank.example/callback" }, /redirect_url must be/],
    [{ aspspName: " " }, /aspsp_name is required/],
    [{ country: "F" }, /country must be a two-letter ISO/],
    [{ accessProfile: "transactions" }, /access_profile is invalid/],
    [{ validUntil: "2099-02-30T00:00:00Z" }, /future RFC3339 date-time/],
    [
      {
        environment: "PRODUCTION",
        privacyUrl: "https://user:secret@example.com/privacy",
      },
      /privacy_url must be a valid HTTPS URL/,
    ],
    [
      { environment: "PRODUCTION", privacyUrl: "not a URL" },
      /privacy_url must be a valid HTTPS URL/,
    ],
    [
      {
        environment: "PRODUCTION",
        termsUrl: "https://example.com/terms#fragment",
      },
      /terms_url must be a valid HTTPS URL/,
    ],
  ];

  for (const [overrides, error] of invalid) {
    assert.throws(
      () => normalizeSetupOptions({ ...base, ...overrides }),
      error,
      JSON.stringify(overrides),
    );
  }
});

async function waitForSetup(setup) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!setup.status.pending) return setup.status;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Setup did not settle");
}

function setupDependencies({ applicationStore = new MemoryStore(), sessionStore = new MemoryStore(), ...overrides } = {}) {
  return {
    applicationStore,
    sessionStore,
    controlPanelClient: {
      async registerApplication(_auth, request) {
        this.request = request;
        return { app_id: "sandbox-app-id" };
      },
    },
    controlPanelAuth: {
      async authenticate(email, existing) {
        this.arguments = [email, existing];
        return { email, idToken: "fake-id-token", refreshToken: "fake-refresh-token" };
      },
    },
    authorizationFlow: { status: { pending: false } },
    generateKeyMaterial: async () => ({
      privateKey: "fake-private-key",
      certificate: "fake-certificate",
    }),
    trustCertificate: async () => {},
    ...overrides,
  };
}

test("registration without optional auth store persists a Sandbox application", async () => {
  const dependencies = setupDependencies();
  const setup = new ApplicationSetupFlow(dependencies);

  await setup.registerApplication({
    controlPanelEmail: " user@example.com ",
    appName: " Test application ",
    environment: "SANDBOX",
    redirectUrl: " https://localhost:8765/callback ",
  });

  assert.deepEqual(await waitForSetup(setup), {
    phase: "application_ready",
    pending: false,
    appId: "sandbox-app-id",
    message:
      "Application registered; the MCP agent can continue with bank consent once country and bank are known.",
  });
  assert.deepEqual(dependencies.controlPanelClient.request, {
    name: "Test application",
    certificate: "fake-certificate",
    environment: "SANDBOX",
    redirect_urls: ["https://localhost:8765/callback"],
  });
  assert.deepEqual(await dependencies.applicationStore.get(), {
    appId: "sandbox-app-id",
    privateKey: "fake-private-key",
    certificate: "fake-certificate",
    environment: "SANDBOX",
    redirectUrls: ["https://localhost:8765/callback"],
  });
  assert.deepEqual(dependencies.controlPanelAuth.arguments, [
    "user@example.com",
    undefined,
  ]);
});

test("registration stores changed Control Panel auth when its optional store exists", async () => {
  const controlPanelAuthStore = new MemoryStore();
  controlPanelAuthStore.value = { idToken: "old-token" };
  const dependencies = setupDependencies({ controlPanelAuthStore });
  const setup = new ApplicationSetupFlow(dependencies);

  await setup.registerApplication({
    controlPanelEmail: "user@example.com",
    appName: "Test application",
    environment: "SANDBOX",
    redirectUrl: "https://127.0.0.1:8765/callback",
  });
  await waitForSetup(setup);

  assert.deepEqual(dependencies.controlPanelAuth.arguments, [
    "user@example.com",
    { idToken: "old-token" },
  ]);
  assert.deepEqual(await controlPanelAuthStore.get(), {
    email: "user@example.com",
    idToken: "fake-id-token",
    refreshToken: "fake-refresh-token",
  });
});

test("failed application registration reports an error and can be retried", async () => {
  let authenticationAttempts = 0;
  const dependencies = setupDependencies({
    controlPanelAuth: {
      async authenticate() {
        authenticationAttempts += 1;
        if (authenticationAttempts === 1) throw new Error("authentication unavailable");
        return { idToken: "fake-id-token", refreshToken: "fake-refresh-token" };
      },
    },
  });
  const setup = new ApplicationSetupFlow(dependencies);
  const options = {
    controlPanelEmail: "user@example.com",
    appName: "Test application",
    environment: "SANDBOX",
    redirectUrl: "https://localhost:8765/callback",
  };

  await setup.registerApplication(options);
  const failure = await waitForSetup(setup);
  assert.equal(failure.phase, "failed");
  assert.equal(failure.error, "authentication unavailable");
  assert.equal(authenticationAttempts, 1);

  await setup.registerApplication(options);
  assert.equal((await waitForSetup(setup)).phase, "application_ready");
  assert.equal(authenticationAttempts, 2);
});

test("getStatus reports completion when a session exists for a persisted Production app", async () => {
  const applicationStore = new MemoryStore();
  const sessionStore = new MemoryStore();
  const setup = new ApplicationSetupFlow(setupDependencies({ applicationStore, sessionStore }));
  applicationStore.value = {
    appId: "production-app-id",
    environment: "PRODUCTION",
    privateKey: "fake-private-key",
    certificate: "fake-certificate",
    redirectUrls: [],
  };

  sessionStore.value = "fake-session-id";
  assert.deepEqual(await setup.getStatus(), {
    phase: "complete",
    pending: false,
    appId: "production-app-id",
    sessionStored: true,
    message: "Enable Banking setup is complete",
  });
});

test("getStatus reports incomplete state after a formerly complete setup loses its application", async () => {
  const applicationStore = new MemoryStore();
  const sessionStore = new MemoryStore();
  const authorizationFlow = {
    status: { pending: false },
    async start() {
      await sessionStore.set("fake-session-id");
      return { authorization_url: "https://bank.example/authorize" };
    },
  };
  const setup = new ApplicationSetupFlow(setupDependencies({
    applicationStore,
    sessionStore,
    authorizationFlow,
    createBankClient: () => ({
      async listBanks() {
        return { aspsps: [{ name: "Example Bank" }] };
      },
    }),
  }));

  await setup.start({
    controlPanelEmail: "user@example.com",
    appName: "Sandbox",
    environment: "SANDBOX",
    redirectUrl: "https://localhost:8765/callback",
    aspspName: "Example Bank",
    country: "FI",
  });
  assert.equal((await waitForSetup(setup)).phase, "complete");
  applicationStore.value = undefined;

  assert.deepEqual(await setup.getStatus(), {
    phase: "idle",
    pending: false,
    sessionStored: true,
    message: "Enable Banking setup is incomplete",
  });
});

test("registration validation accepts Sandbox without Production policy metadata", () => {
  assert.deepEqual(normalizeApplicationRegistrationOptions({
    controlPanelEmail: " user@example.com ",
    appName: " Sandbox ",
    environment: "SANDBOX",
    redirectUrl: " https://127.0.0.1:8765/callback ",
  }), {
    controlPanelEmail: "user@example.com",
    appName: "Sandbox",
    environment: "SANDBOX",
    redirectUrl: "https://127.0.0.1:8765/callback",
  });
});

test("Production provider URLs reject credentials and fragments", () => {
  for (const field of ["privacyUrl", "termsUrl"]) {
    for (const value of [
      "https://user:fake-password@example.com/document",
      "https://example.com/document#section",
    ]) {
      assert.throws(
        () => normalizeSetupOptions({
          controlPanelEmail: "user@example.com",
          appName: "Production application",
          environment: "PRODUCTION",
          redirectUrl: "https://localhost:8765/callback",
          aspspName: "Example Bank",
          country: "FI",
          [field]: value,
        }),
        new RegExp(`${field === "privacyUrl" ? "privacy" : "terms"}_url must be a valid HTTPS URL`),
      );
    }
  }
});

test("callback TLS options contain UTF-8 key and certificate bytes", () => {
  const options = callbackTlsFromApplication({
    appId: "app-id",
    environment: "SANDBOX",
    redirectUrls: ["https://localhost:8765/callback"],
    privateKey: "fake-key-秘密",
    certificate: "fake-certificate-証明書",
  });

  assert.ok(Buffer.isBuffer(options.key));
  assert.ok(Buffer.isBuffer(options.cert));
  assert.equal(options.key.toString("utf8"), "fake-key-秘密");
  assert.equal(options.cert.toString("utf8"), "fake-certificate-証明書");
});

test("uses the default timers for Production activation and consent polling", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const applicationStore = new MemoryStore();
  const sessionStore = new MemoryStore();
  const firstActivationCheck = Promise.withResolvers();
  const authorizationStarted = Promise.withResolvers();
  let activationChecks = 0;
  const authorizationFlow = {
    get status() {
      return { pending: sessionStore.value === undefined };
    },
    async start() {
      authorizationStarted.resolve();
      setTimeout(() => {
        void sessionStore.set("fixture-session-id");
      }, 1000);
      return { authorization_url: "https://bank.example/authorize" };
    },
  };
  const setup = new ApplicationSetupFlow(
    setupDependencies({
      applicationStore,
      sessionStore,
      authorizationFlow,
      openBrowser: () => {},
      createBankClient: () => ({
        async getApplication() {
          activationChecks += 1;
          if (activationChecks === 1) firstActivationCheck.resolve();
          return { active: activationChecks > 1 };
        },
        async listBanks() {
          return { aspsps: [{ name: "Fixture Bank", country: "FI" }] };
        },
      }),
    }),
  );

  await setup.start({
    controlPanelEmail: "user@example.com",
    appName: "Production application",
    environment: "PRODUCTION",
    redirectUrl: "https://localhost:8765/callback",
    aspspName: "Fixture Bank",
    country: "FI",
  });
  await firstActivationCheck.promise;
  await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.tick(5000);
  await authorizationStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.tick(1000);

  const status = await waitForSetup(setup);
  assert.equal(status.phase, "complete");
  assert.equal(activationChecks, 2);
  assert.equal(await sessionStore.get(), "fixture-session-id");
});

test("uses the default Enable Banking client for provider bank discovery", async (context) => {
  const applicationStore = new MemoryStore();
  const sessionStore = new MemoryStore();
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const requests = [];
  context.mock.method(globalThis, "fetch", async (input, init) => {
    requests.push({ url: new URL(String(input)), headers: init.headers });
    return Response.json({
      aspsps: [{ name: "Fixture Bank", country: "FI" }],
    });
  });
  const authorizationFlow = {
    status: { pending: false },
    async start(client, options) {
      assert.ok(client instanceof EnableBankingClient);
      assert.equal(options.aspspName, "Fixture Bank");
      await sessionStore.set("fixture-session-id");
      return { authorization_url: "https://bank.example/authorize" };
    },
  };
  const setup = new ApplicationSetupFlow(
    setupDependencies({
      applicationStore,
      sessionStore,
      authorizationFlow,
      openBrowser: () => {},
      generateKeyMaterial: async () => ({
        privateKey,
        certificate: "fake-certificate",
      }),
    }),
  );

  await setup.start({
    controlPanelEmail: "user@example.com",
    appName: "Sandbox application",
    environment: "SANDBOX",
    redirectUrl: "https://localhost:8765/callback",
    aspspName: "Fixture Bank",
    country: "FI",
  });

  const status = await waitForSetup(setup);
  assert.equal(status.phase, "complete");
  assert.equal(await sessionStore.get(), "fixture-session-id");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.pathname, "/aspsps");
  assert.equal(requests[0].url.searchParams.get("country"), "FI");
  assert.match(requests[0].headers.Authorization, /^Bearer /);
});
