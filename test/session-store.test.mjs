import assert from "node:assert/strict";
import test from "node:test";
import { MacKeychainSecretStore } from "../dist/session-store.js";

function fakeKeychain() {
  const records = new Map();
  let mainWritesToFail = 0;

  const runner = async (args, password) => {
    const operation = args[0];
    const service = args[args.indexOf("-s") + 1];
    if (operation === "find-generic-password") {
      const value = records.get(service);
      return value === undefined
        ? {
            code: 44,
            stdout: "",
            stderr: "specified item could not be found",
          }
        : { code: 0, stdout: `${value}\n`, stderr: "" };
    }
    if (operation === "add-generic-password") {
      if (service === "test-service" && mainWritesToFail > 0) {
        mainWritesToFail -= 1;
        return { code: 1, stdout: "", stderr: "write failed" };
      }
      records.set(service, password ?? "");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (operation === "delete-generic-password") {
      records.delete(service);
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unsupported fake Keychain operation: ${operation}`);
  };

  return {
    records,
    runner,
    failNextMainWrite() {
      mainWritesToFail = 1;
    },
  };
}

function testStore(keychain) {
  return new MacKeychainSecretStore(
    "test-service",
    "test-account",
    "test secret",
    keychain.runner,
  );
}

test("rolls back chunks when the initial index write fails", async () => {
  const keychain = fakeKeychain();
  const store = testStore(keychain);
  keychain.failNextMainWrite();

  await assert.rejects(
    store.set("new-secret-".repeat(100)),
    /Unable to store the Enable Banking test secret in Keychain/,
  );

  assert.deepEqual([...keychain.records], []);
});

test("restores the previous value when replacing data cannot commit its index", async () => {
  const keychain = fakeKeychain();
  const store = testStore(keychain);
  const previous = "old-secret-".repeat(100);
  await store.set(previous);
  keychain.failNextMainWrite();

  await assert.rejects(store.set("new-secret-".repeat(10)));

  assert.equal(await store.get(), previous);
});
