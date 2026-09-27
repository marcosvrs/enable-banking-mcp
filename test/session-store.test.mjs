import assert from "node:assert/strict";
import test from "node:test";
import { MacKeychainSecretStore } from "../dist/session-store.js";

function isolatedStore(initialRecords = new Map(), behavior = {}) {
  const legacy = new Map(initialRecords);
  const native = new Map();
  const calls = [];
  let deleteNativeFailures = 0;
  const runner = async (args) => {
    calls.push([...args]);
    const operation = args[0];
    const service = args[args.indexOf("-s") + 1];
    const override = behavior[`${operation}:${service}`] ?? behavior[`${operation}:*`];
    if (override) return override({ args, legacy, calls });
    if (operation === "find-generic-password") {
      const value = legacy.get(service);
      return value === undefined
        ? { code: 44, stdout: "", stderr: "The specified item could not be found." }
        : { code: 0, stdout: `${value}\n`, stderr: "" };
    }
    if (operation === "delete-generic-password") {
      legacy.delete(service);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected legacy Keychain operation: ${operation}`);
  };
  const factory = (service, account) => {
    assert.equal(service, "test-service.native");
    assert.equal(account, "test-account");
    return {
      getPassword: () => native.get(service) ?? null,
      setPassword: (value) => native.set(service, value),
      deletePassword: () => {
        if (deleteNativeFailures > 0) {
          deleteNativeFailures -= 1;
          throw new Error("native delete failed");
        }
        return native.delete(service);
      },
    };
  };
  return {
    legacy,
    native,
    calls,
    store: new MacKeychainSecretStore(
      "test-service",
      "test-account",
      "test secret",
      runner,
      factory,
    ),
    failNativeDelete() {
      deleteNativeFailures += 1;
    },
  };
}

test("reads raw legacy records, upgrades on write, and rejects empty writes", async () => {
  const state = isolatedStore(new Map([["test-service", " legacy-value "]]));
  assert.equal(await state.store.get(), "legacy-value");
  await assert.rejects(state.store.set(" \n "), /Cannot store an empty Enable Banking test secret/);
  await state.store.set("  normalized value  ");
  assert.equal(await state.store.get(), "normalized value");
  assert.equal(state.legacy.has("test-service"), false);
  assert.deepEqual([...state.native.values()], ["normalized value"]);
  assert.equal(state.calls.some((args) => args.includes("normalized value")), false);
});

test("reads v1 chunk-index records and replaces them with a native entry", async () => {
  const encoded = `enable-banking-mcp:v1:${Buffer.from("legacy chunk value").toString("base64")}`;
  const pieces = [encoded.slice(0, 12), encoded.slice(12)];
  const state = isolatedStore(new Map([
    ["test-service", "enable-banking-mcp:chunks:v1:2"],
    ["test-service.part.0", pieces[0]],
    ["test-service.part.1", pieces[1]],
  ]));
  assert.equal(await state.store.get(), "legacy chunk value");
  await state.store.set("replacement");
  assert.equal(await state.store.get(), "replacement");
  assert.equal(state.legacy.size, 0);
});

test("native values take precedence over legacy data", async () => {
  const state = isolatedStore(new Map([["test-service", "old-legacy"]]));
  await state.store.set("native value");
  state.legacy.set("test-service", "stale legacy");
  assert.equal(await state.store.get(), "native value");
});

test("cleanup failure after native commit leaves the new value readable and retries", async () => {
  let failDelete = true;
  const state = isolatedStore(new Map([["test-service", "old-value"]]), {
    "delete-generic-password:test-service": ({ legacy }) => {
      if (failDelete) {
        failDelete = false;
        return { code: 1, stdout: "", stderr: "injected delete failure" };
      }
      legacy.delete("test-service");
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(state.store.set("new-value"), /Unable to clear legacy Enable Banking test secret/);
  assert.equal(await state.store.get(), "new-value");
  await state.store.set("new-value");
  assert.equal(state.legacy.has("test-service"), false);
  assert.equal(await state.store.get(), "new-value");
});

test("clear removes native and legacy data and can be retried after one store fails", async () => {
  const state = isolatedStore(new Map([["test-service", "legacy"]]));
  await state.store.set("native");
  state.legacy.set("test-service", "legacy again");
  state.failNativeDelete();
  await assert.rejects(state.store.clear(), /Unable to clear the Enable Banking test secret/);
  assert.equal(state.legacy.has("test-service"), false);
  assert.equal(await state.store.get(), "native");
  await state.store.clear();
  assert.equal(await state.store.get(), undefined);
});

test("clear removes malformed legacy manifests and bounded chunk slots", async () => {
  const state = isolatedStore(new Map([
    ["test-service", "enable-banking-mcp:chunks:v1:not-a-count"],
    ["test-service.part.0", "unreadable chunk"],
    ["test-service.part.255", "last bounded chunk"],
  ]));
  await assert.rejects(state.store.get(), /Stored Enable Banking test secret is invalid/);
  await state.store.clear();
  assert.equal(state.legacy.size, 0);
});

test("clear removes a malformed raw record without trying to decode it", async () => {
  const state = isolatedStore(new Map([["test-service", "enable-banking-mcp:v1:not-base64!"]]));
  await assert.rejects(state.store.get(), /Stored Enable Banking test secret is invalid/);
  await state.store.clear();
  assert.equal(state.legacy.size, 0);
});
test("reconciles staged generations before replacing legacy credentials", async () => {
  const encoded = `enable-banking-mcp:v1:${Buffer.from("legacy value").toString("base64")}`;
  const state = isolatedStore(new Map([
    ["test-service", "enable-banking-mcp:chunks:v2:active-id,1;retired-id,1"],
    ["test-service.part.active-id.0", encoded],
    ["test-service.part.retired-id.0", encoded],
    ["test-service.pending", "orphan-id,1"],
    ["test-service.part.orphan-id.0", encoded],
    ["test-service.retired", "journal-id,1"],
    ["test-service.part.journal-id.0", encoded],
  ]));

  assert.equal(await state.store.get(), "legacy value");
  await state.store.set("replacement value");

  assert.equal(await state.store.get(), "replacement value");
  assert.deepEqual([...state.legacy], []);
});

test("clears recoverable chunk generations from a malformed v2 manifest", async () => {
  const state = isolatedStore(new Map([
    ["test-service", "enable-banking-mcp:chunks:v2:broken-count,nope;recoverable-id,1"],
    ["test-service.part.broken-count.0", "unreadable data"],
    ["test-service.part.recoverable-id.255", "stale data"],
  ]));

  await state.store.set("replacement value");

  assert.equal(await state.store.get(), "replacement value");
  assert.deepEqual([...state.legacy], []);
});

test("keeps native writes readable when legacy journals are malformed", async () => {
  const malformedRecords = [
    new Map([["test-service.pending", "broken journal"]]),
    new Map([["test-service.retired", "broken journal"]]),
    new Map([
      ["test-service", "enable-banking-mcp:chunks:v2:broken"],
      ["test-service.retired", "retired-id,1"],
    ]),
  ];

  for (const records of malformedRecords) {
    const state = isolatedStore(records);
    await assert.rejects(
      state.store.set("committed native value"),
      /Stored Enable Banking test secret is invalid/,
    );
    assert.equal(await state.store.get(), "committed native value");
  }
});

test("rejects incomplete and noncanonical legacy chunk data", async () => {
  const malformedRecords = [
    new Map([["test-service", "enable-banking-mcp:v1:AB=="]]),
    new Map([["test-service", "enable-banking-mcp:chunks:v1:1"]]),
    new Map([
      ["test-service", "enable-banking-mcp:chunks:v1:1"],
      ["test-service.part.0", "not-an-encoded-secret"],
    ]),
  ];

  for (const records of malformedRecords) {
    const state = isolatedStore(records);
    await assert.rejects(
      state.store.get(),
      /Stored Enable Banking test secret is invalid/,
    );
  }
});

test("reports legacy read failures and does not claim cleanup succeeded", async () => {
  const state = isolatedStore(new Map(), {
    "find-generic-password:test-service": async () => ({
      code: 1,
      stdout: "",
      stderr: "keychain is unavailable",
    }),
  });

  await assert.rejects(
    state.store.get(),
    /Unable to read the Enable Banking test secret from Keychain/,
  );
  await assert.rejects(
    state.store.clear(),
    /Unable to clear the Enable Banking test secret from Keychain/,
  );
});

test("does not report success when a legacy chunk generation cannot be identified", async () => {
  const legacyManifest = "enable-banking-mcp:chunks:v2:unparseable";
  const state = isolatedStore(new Map([
    ["test-service", legacyManifest],
    ["test-service.part.unknown-id.0", "orphaned legacy value"],
  ]));

  await assert.rejects(
    state.store.set("replacement value"),
    /Unable to clear legacy Enable Banking test secret from Keychain/,
  );

  assert.equal(state.legacy.get("test-service"), legacyManifest);
  assert.equal(state.legacy.get("test-service.part.unknown-id.0"), "orphaned legacy value");
  assert.equal(await state.store.get(), "replacement value");
});
