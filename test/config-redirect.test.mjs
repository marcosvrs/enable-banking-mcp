import assert from "node:assert/strict";
import test from "node:test";
import { loadCredentials } from "../dist/config.js";
import { parseLoopbackRedirect } from "../dist/redirect.js";
// Clearly fake credential-shaped input; no live key material is required.
const fakePrivateKey = " fake-private-key ";
test("trims configured credentials and prefers the current application ID setting", () => {
  assert.deepEqual(loadCredentials({
    ENABLE_BANKING_APP_ID: " preferred-id ",
    ENABLE_BANKING_ID: "legacy-id",
    ENABLE_BANKING_PRIVATE_KEY: fakePrivateKey,
  }), { appId: "preferred-id", privateKey: "fake-private-key" });
  assert.deepEqual(loadCredentials({
    ENABLE_BANKING_APP_ID: "  ",
    ENABLE_BANKING_ID: " legacy-id ",
    ENABLE_BANKING_PRIVATE_KEY: fakePrivateKey,
  }), { appId: "legacy-id", privateKey: "fake-private-key" });
});

test("requires a nonblank application ID and private key", () => {
  assert.throws(
    () => loadCredentials({ ENABLE_BANKING_PRIVATE_KEY: "private-key" }),
    /ENABLE_BANKING_ID or ENABLE_BANKING_APP_ID/,
  );
  assert.throws(
    () => loadCredentials({ ENABLE_BANKING_APP_ID: "app-id", ENABLE_BANKING_PRIVATE_KEY: "  " }),
    /ENABLE_BANKING_PRIVATE_KEY/,
  );
});

test("parses secure localhost and IPv4 loopback redirects with explicit ports", () => {
  assert.deepEqual(parseLoopbackRedirect("https://localhost:8765/callback"), {
    protocol: "https:", hostname: "localhost", port: 8765, path: "/callback",
  });
  assert.deepEqual(parseLoopbackRedirect("https://127.0.0.1:8443"), {
    protocol: "https:", hostname: "127.0.0.1", port: 8443, path: "/",
  });
});

test("accepts both valid TCP port boundaries and rejects port zero", () => {
  for (const port of [1, 65535]) {
    assert.equal(
      parseLoopbackRedirect(`https://localhost:${port}/callback`).port,
      port,
    );
  }
  assert.throws(
    () => parseLoopbackRedirect("https://localhost:65536/callback"),
  );
  assert.throws(
    () => parseLoopbackRedirect("https://localhost:0/callback"),
    /valid TCP port/,
  );
});

test("rejects invalid URLs and redirect URLs outside the supported loopback contract", () => {
  assert.throws(() => parseLoopbackRedirect("not a URL"), /must be a valid URL/);
  for (const redirect of [
    "http://localhost:8765/callback",
    "https://example.test:8765/callback",
    "https://user:secret@localhost:8765/callback",
    "https://localhost/callback",
    "https://localhost:8765/callback?state=x",
    "https://localhost:8765/callback#result",
  ]) {
    assert.throws(() => parseLoopbackRedirect(redirect), /must be an https:\/\/ localhost or 127\.0\.0\.1 URL/);
  }
});
