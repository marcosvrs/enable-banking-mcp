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
    gdprEmail: "privacy@example.com",
    privacyUrl: "https://example.com/privacy",
    termsUrl: "https://example.com/terms",
    validUntil: "2099-01-01T00:00:00Z",
    allowRestrictedProduction: true,
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
        gdprEmail: "privacy@example.com",
        privacyUrl: "https://example.com/privacy",
        termsUrl: "https://example.com/terms",
      }),
    /redirect_url must be an https:\/\/ localhost or 127\.0\.0\.1 URL/,
  );
});

test("requires explicit opt-in before restricted Production setup", () => {
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
        gdprEmail: "privacy@example.com",
        privacyUrl: "https://example.com/privacy",
        termsUrl: "https://example.com/terms",
      }),
    /PRODUCTION is restricted.*ENABLE_BANKING_ALLOW_RESTRICTED_PRODUCTION=true/,
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
        gdprEmail: "privacy@example.com",
        privacyUrl: "http://example.com/privacy",
        termsUrl: "https://example.com/terms",
        allowRestrictedProduction: true,
      }),
    /privacy_url must be a valid HTTPS URL/,
  );
});
