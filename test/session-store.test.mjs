import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import {
  MacKeychainCredentialVault,
  MacKeychainSecretStore,
  MacKeychainSessionStore,
} from "../dist/session-store.js";

const account = "test-account";
const bundlePrefix = "enable-banking-mcp:credential-bundle:v1:";

function createVault(initial = new Map()) {
  const records = new Map(initial);
  const calls = [];
  const factory = (service, username) => {
    assert.equal(username, account);
    return {
      getPassword() {
        calls.push(["get", service]);
        return records.get(service) ?? null;
      },
      setPassword(value) {
        calls.push(["set", service]);
        records.set(service, value);
      },
      deletePassword() {
        calls.push(["delete", service]);
        return records.delete(service);
      },
    };
  };
  return {
    calls,
    records,
    vault: new MacKeychainCredentialVault(factory, account),
  };
}


test("creates one Keychain item for all credential slots after confirming absence", async () => {
  const state = createVault();
  const session = new MacKeychainSessionStore(state.vault);
  const application = new MacKeychainSecretStore("application", state.vault);
  const controlPanel = new MacKeychainSecretStore("controlPanel", state.vault);

  await Promise.all([
    Effect.runPromise(session.set("session-placeholder")),
    Effect.runPromise(application.set("application-placeholder")),
    Effect.runPromise(controlPanel.set("control-panel-placeholder")),
  ]);

  assert.equal(state.records.size, 1);
  const [[service, stored]] = state.records;
  assert.equal(service, "enable-banking-mcp.credentials.native");
  assert.ok(stored.startsWith(bundlePrefix));
  assert.deepEqual(JSON.parse(stored.slice(bundlePrefix.length)), {
    version: 1,
    session: "session-placeholder",
    application: "application-placeholder",
    controlPanel: "control-panel-placeholder",
  });

  const firstWrite = state.calls.findIndex(([operation]) => operation === "set");
  assert.ok(firstWrite >= 4);
  assert.ok(
    state.calls.slice(0, firstWrite).every(([operation]) => operation === "get"),
  );
});

test("reuses an existing entry and consolidates prior per-service records", async () => {
  const state = createVault(
    new Map([
      ["enable-banking-mcp.control-panel.native", "control-panel-placeholder"],
      ["enable-banking-mcp.application.native", "application-placeholder"],
      ["enable-banking-mcp.native", "session-placeholder"],
    ]),
  );
  const session = new MacKeychainSessionStore(state.vault);
  const application = new MacKeychainSecretStore("application", state.vault);
  const controlPanel = new MacKeychainSecretStore("controlPanel", state.vault);

  assert.equal(await Effect.runPromise(session.get()), "session-placeholder");
  assert.equal(await Effect.runPromise(application.get()), "application-placeholder");
  assert.equal(await Effect.runPromise(controlPanel.get()), "control-panel-placeholder");
  assert.equal(state.records.size, 1);
  const [[service, stored]] = state.records;
  assert.equal(service, "enable-banking-mcp.control-panel.native");
  assert.deepEqual(JSON.parse(stored.slice(bundlePrefix.length)), {
    version: 1,
    controlPanel: "control-panel-placeholder",
    application: "application-placeholder",
    session: "session-placeholder",
  });
});
test("migrates a recognized legacy item in place before writing", async () => {
  const state = createVault(
    new Map([["enable-banking-mcp.application", "legacy-app-placeholder"]]),
  );
  const application = new MacKeychainSecretStore("application", state.vault);

  assert.equal(await Effect.runPromise(application.get()), "legacy-app-placeholder");
  assert.equal(state.records.size, 1);
  const [[service, stored]] = state.records;
  assert.equal(service, "enable-banking-mcp.application");
  assert.deepEqual(JSON.parse(stored.slice(bundlePrefix.length)), {
    version: 1,
    application: "legacy-app-placeholder",
  });
});

test("fails closed on a legacy chunk manifest without creating another item", async () => {
  const manifest = "enable-banking-mcp:chunks:v1:2";
  const state = createVault(new Map([["enable-banking-mcp", manifest]]));

  await assert.rejects(
    Effect.runPromise(new MacKeychainSessionStore(state.vault).set("new-session-placeholder")),
    /Legacy chunked Enable Banking Keychain records must be cleared/,
  );
  assert.equal(state.records.size, 1);
  assert.equal(state.records.get("enable-banking-mcp"), manifest);
  assert.equal(state.calls.some(([operation]) => operation === "set"), false);
});

test("clears one slot without deleting the shared item until it is empty", async () => {
  const state = createVault();
  const session = new MacKeychainSessionStore(state.vault);
  const application = new MacKeychainSecretStore("application", state.vault);
  await Promise.all([
    Effect.runPromise(session.set("session-placeholder")),
    Effect.runPromise(application.set("app-placeholder")),
  ]);
  await Effect.runPromise(session.clear());
  assert.equal(state.records.size, 1);
  assert.equal(await Effect.runPromise(session.get()), undefined);
  assert.equal(await Effect.runPromise(application.get()), "app-placeholder");

  await Effect.runPromise(application.clear());
  assert.equal(state.records.size, 0);
});

test("does not create an item for reads or clears of an empty vault", async () => {
  const state = createVault();
  const session = new MacKeychainSessionStore(state.vault);
  assert.equal(await Effect.runPromise(session.get()), undefined);
  await Effect.runPromise(session.clear());
  assert.equal(state.records.size, 0);
  assert.equal(state.calls.some(([operation]) => operation === "set"), false);
});

test("rejects a malformed existing vault without replacing it", async () => {
  const invalid = `${bundlePrefix}{"version":1,"session":42}`;
  const state = createVault(
    new Map([["enable-banking-mcp.credentials.native", invalid]]),
  );
  await assert.rejects(
    Effect.runPromise(new MacKeychainSessionStore(state.vault).get()),
    /Stored Enable Banking credential vault is invalid/,
  );
  assert.equal(state.records.size, 1);
  assert.equal(
    state.records.get("enable-banking-mcp.credentials.native"),
    invalid,
  );
  assert.equal(state.calls.some(([operation]) => operation === "set"), false);
});

test("rejects empty secret values without creating the vault item", async () => {
  const state = createVault();
  await assert.rejects(
    Effect.runPromise(new MacKeychainSessionStore(state.vault).set("  \n ")),
    /Cannot store an empty Enable Banking session/,
  );
  assert.equal(state.records.size, 0);
});
