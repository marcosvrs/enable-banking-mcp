import assert from "node:assert/strict";
import test from "node:test";
import { MacKeychainApplicationStore } from "../dist/application-store.js";

function memorySecretStore(initial) {
  return {
    value: initial,
    async get() { return this.value; },
    async set(value) { this.value = value; },
    async clear() { this.value = undefined; },
  };
}

// These are placeholder credential strings, not copied key or certificate data.
const validApplication = {
  appId: "application-123",
  privateKey: "fake-private-key",
  certificate: "fake-certificate",
  environment: "PRODUCTION",
  redirectUrls: ["https://localhost:8765/callback"],
};
test("returns no application when persistent storage is empty", async () => {
  assert.equal(await new MacKeychainApplicationStore(memorySecretStore()).get(), undefined);
});

test("rejects malformed and structurally invalid stored applications", async () => {
  for (const storedValue of ["{", "null", "{}", JSON.stringify({ ...validApplication, redirectUrls: [] })]) {
    const store = new MacKeychainApplicationStore(memorySecretStore(storedValue));
    await assert.rejects(store.get(), /Stored Enable Banking application credentials are invalid/);
  }
});

test("rejects invalid application input without replacing stored credentials", async () => {
  const secretStore = memorySecretStore("preserved");
  const store = new MacKeychainApplicationStore(secretStore);
  for (const application of [
    { ...validApplication, appId: "  " },
    { ...validApplication, privateKey: "" },
    { ...validApplication, certificate: "" },
    { ...validApplication, environment: "TEST" },
    { ...validApplication, redirectUrls: ["https://localhost:8765/callback", " "] },
  ]) {
    await assert.rejects(store.set(application), /Enable Banking application credentials are invalid/);
    assert.equal(secretStore.value, "preserved");
  }
});

test("round-trips both supported environments and clears the stored application", async () => {
  const secretStore = memorySecretStore();
  const store = new MacKeychainApplicationStore(secretStore);
  for (const environment of ["PRODUCTION", "SANDBOX"]) {
    const application = { ...validApplication, environment };
    await store.set(application);
    assert.deepEqual(await store.get(), application);
  }
  await store.clear();
  assert.equal(await store.get(), undefined);
});
