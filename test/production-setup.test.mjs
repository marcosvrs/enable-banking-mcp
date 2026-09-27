import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { BankAuthorizationFlow } from "../dist/authorization.js";
import { ControlPanelAuthFlow, ControlPanelClient } from "../dist/control-panel.js";
import { EnableBankingClient } from "../dist/enable-banking.js";
import { ApplicationSetupFlow, normalizeSetupOptions } from "../dist/setup.js";

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
