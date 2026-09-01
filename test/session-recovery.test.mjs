import assert from "node:assert/strict";
import test from "node:test";
import {
  EnableBankingApiError,
  isTerminalSessionError,
} from "../dist/enable-banking.js";
import { recoverConfiguredSession } from "../dist/session-recovery.js";

test("retries a valid environment session after clearing terminal Keychain state", async () => {
  const reads = [];
  let storedClears = 0;
  let environmentClears = 0;

  const result = await recoverConfiguredSession({
    storedSession: "keychain-session",
    environmentSessionId: "environment-session",
    read: async () => {
      reads.push(reads.length + 1);
      if (reads.length === 1) {
        throw new EnableBankingApiError(401, "session expired", {
          error: "EXPIRED_SESSION",
        });
      }
      return { sessionId: "environment-session" };
    },
    clearStoredSession: async () => {
      storedClears += 1;
    },
    clearEnvironmentSession: () => {
      environmentClears += 1;
    },
  });

  assert.deepEqual(result, { sessionId: "environment-session" });
  assert.deepEqual(reads, [1, 2]);
  assert.equal(storedClears, 1);
  assert.equal(environmentClears, 0);
});

test("does not discard an environment session on credential errors", async () => {
  let storedClears = 0;
  let environmentClears = 0;
  const credentialError = new EnableBankingApiError(401, "unauthorized", {
    error: "UNAUTHORIZED_ACCESS",
  });

  await assert.rejects(
    recoverConfiguredSession({
      storedSession: "keychain-session",
      environmentSessionId: "environment-session",
      read: async () => {
        throw credentialError;
      },
      clearStoredSession: async () => {
        storedClears += 1;
      },
      clearEnvironmentSession: () => {
        environmentClears += 1;
      },
    }),
    (error) => error === credentialError,
  );

  assert.equal(storedClears, 0);
  assert.equal(environmentClears, 0);
  assert.equal(isTerminalSessionError(credentialError), false);
});
