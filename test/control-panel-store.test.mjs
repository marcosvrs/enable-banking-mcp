import assert from "node:assert/strict";
import test from "node:test";
import { MacKeychainControlPanelAuthStore } from "../dist/control-panel-store.js";

function memorySecretStore(initial) {
  return {
    value: initial,
    async get() { return this.value; },
    async set(value) { this.value = value; },
    async clear() { this.value = undefined; },
  };
}
// Placeholder token values only; no live authentication material is embedded.
const validAuth = { email: "person@example.test", idToken: "fake-id-token", refreshToken: "fake-refresh-token" };

test("returns no Control Panel authentication when persistent storage is empty", async () => {
  assert.equal(await new MacKeychainControlPanelAuthStore(memorySecretStore()).get(), undefined);
});

test("rejects malformed or incomplete stored Control Panel sessions", async () => {
  for (const storedValue of ["{", "null", "[]", JSON.stringify({ ...validAuth, refreshToken: "" })]) {
    const store = new MacKeychainControlPanelAuthStore(memorySecretStore(storedValue));
    await assert.rejects(store.get(), /Stored Control Panel session is invalid/);
  }
});

test("keeps only valid optional metadata from a stored Control Panel session", async () => {
  const store = new MacKeychainControlPanelAuthStore(memorySecretStore(JSON.stringify({
    ...validAuth,
    localId: "user-123",
    expiresAt: 1_900_000_000_000,
    ignored: "extra persisted field",
  })));
  assert.deepEqual(await store.get(), {
    ...validAuth,
    localId: "user-123",
    expiresAt: 1_900_000_000_000,
  });

  for (const optionalFields of [
    { localId: "", expiresAt: Number.POSITIVE_INFINITY },
    { localId: 42, expiresAt: "later" },
  ]) {
    const withoutOptionalMetadata = new MacKeychainControlPanelAuthStore(
      memorySecretStore(JSON.stringify({ ...validAuth, ...optionalFields })),
    );
    assert.deepEqual(await withoutOptionalMetadata.get(), validAuth);
  }
});

test("does not persist incomplete auth and round-trips complete auth", async () => {
  const secretStore = memorySecretStore("preserved");
  const store = new MacKeychainControlPanelAuthStore(secretStore);
  for (const auth of [
    { ...validAuth, email: "" },
    { ...validAuth, idToken: "" },
    { ...validAuth, refreshToken: "" },
  ]) {
    await assert.rejects(store.set(auth), /Cannot store an incomplete Control Panel session/);
    assert.equal(secretStore.value, "preserved");
  }

  await store.set(validAuth);
  assert.deepEqual(await store.get(), validAuth);
  await store.clear();
  assert.equal(await store.get(), undefined);
});
