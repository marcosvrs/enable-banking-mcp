import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { Effect } from "effect";
import {
  MacKeychainSecretStore,
  MacKeychainSessionStore,
  setNativeKeyringEntryFactory,
} from "../../dist/session-store.js";

const [, , keychainPath, slot, value, delayWrite, operation = "set"] = process.argv;

function readRecords() {
  return JSON.parse(readFileSync(keychainPath, "utf8"));
}

function writeRecords(records) {
  const temporaryPath = `${keychainPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(records), { mode: 0o600 });
  renameSync(temporaryPath, keychainPath);
}

setNativeKeyringEntryFactory((service) => ({
  getPassword() {
    return readRecords()[service] ?? null;
  },
  setPassword(password) {
    const delayMilliseconds =
      delayWrite === "true" ? 250 : Number(delayWrite);
    if (delayMilliseconds > 0) {
      process.stdout.write("BLOCKED\n");
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        delayMilliseconds,
      );
    }
    const records = readRecords();
    records[service] = password;
    writeRecords(records);
  },
  deletePassword() {
    const records = readRecords();
    const existed = Object.hasOwn(records, service);
    delete records[service];
    writeRecords(records);
    return existed;
  },
}));

const store = slot === "session"
  ? new MacKeychainSessionStore()
  : new MacKeychainSecretStore("application");
if (operation === "cancel-set" || operation === "cancel-clear") {
  const controller = new AbortController();
  const effect = operation === "cancel-clear" ? store.clear() : store.set(value);
  const pending = Effect.runPromise(effect, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.stdout.write("READY\n");
  await new Promise((resolve) => process.stdin.once("data", resolve));
  controller.abort();
  try {
    await pending;
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  }
  process.stdout.write("CANCELLED\n");
} else {
  await Effect.runPromise(store.get());
  process.stdout.write("READY\n");
  await new Promise((resolve) => process.stdin.once("data", resolve));
  await Effect.runPromise(store.set(value));
  process.stdout.write("DONE\n");
}
