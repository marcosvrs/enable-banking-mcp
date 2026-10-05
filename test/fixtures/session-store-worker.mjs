import { readFileSync, renameSync, writeFileSync } from "node:fs";

import { Effect } from "effect";
import {
  MacKeychainSecretStore,
  MacKeychainSessionStore,
  setNativeKeyringEntryFactory,
} from "../../dist/session-store.js";

const [, , keychainPath, slot, value, delayWrite] = process.argv;

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
    if (delayWrite === "true") {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
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
await Effect.runPromise(store.get());
process.stdout.write("READY\n");
await new Promise((resolve) => process.stdin.once("data", resolve));
await Effect.runPromise(store.set(value));
process.stdout.write("DONE\n");
