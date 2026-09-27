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
test("skips reads when neither persistent nor environment session exists", async () => {
  let reads = 0;
  const result = await recoverConfiguredSession({
    read: async () => { reads += 1; return "unused"; },
    clearStoredSession: async () => {},
    clearEnvironmentSession: () => {},
  });
  assert.equal(result, undefined);
  assert.equal(reads, 0);
});

test("clears a terminal stored-only session and returns no session", async () => {
  let clears = 0;
  const result = await recoverConfiguredSession({
    storedSession: "expired-stored-session",
    read: async () => {
      throw new EnableBankingApiError(401, "session expired", { error: "EXPIRED_SESSION" });
    },
    clearStoredSession: async () => { clears += 1; },
    clearEnvironmentSession: () => assert.fail("no environment session was configured"),
  });
  assert.equal(result, undefined);
  assert.equal(clears, 1);
});

test("clears a terminal environment-only session without clearing Keychain", async () => {
  let storedClears = 0;
  let environmentClears = 0;
  const result = await recoverConfiguredSession({
    environmentSessionId: "expired-environment-session",
    read: async () => {
      throw new EnableBankingApiError(401, "session expired", { error: "EXPIRED_SESSION" });
    },
    clearStoredSession: async () => { storedClears += 1; },
    clearEnvironmentSession: () => { environmentClears += 1; },
  });
  assert.equal(result, undefined);
  assert.equal(storedClears, 0);
  assert.equal(environmentClears, 1);
});

test("clears both sources after the environment-session retry is also terminal", async () => {
  let storedClears = 0;
  let environmentClears = 0;
  let reads = 0;
  const result = await recoverConfiguredSession({
    storedSession: "expired-stored-session",
    environmentSessionId: "expired-environment-session",
    read: async () => {
      reads += 1;
      throw new EnableBankingApiError(401, "session expired", { error: "EXPIRED_SESSION" });
    },
    clearStoredSession: async () => { storedClears += 1; },
    clearEnvironmentSession: () => { environmentClears += 1; },
  });
  assert.equal(result, undefined);
  assert.equal(reads, 2);
  assert.equal(storedClears, 1);
  assert.equal(environmentClears, 1);
});

test("propagates a nonterminal failure from the environment-session retry", async () => {
  const networkError = new Error("network unavailable");
  let reads = 0;
  let environmentClears = 0;
  await assert.rejects(
    recoverConfiguredSession({
      storedSession: "expired-stored-session",
      environmentSessionId: "environment-session",
      read: async () => {
        reads += 1;
        if (reads === 1) {
          throw new EnableBankingApiError(401, "session expired", { error: "EXPIRED_SESSION" });
        }
        throw networkError;
      },
      clearStoredSession: async () => {},
      clearEnvironmentSession: () => { environmentClears += 1; },
    }),
    (error) => error === networkError,
  );
  assert.equal(reads, 2);
  assert.equal(environmentClears, 0);
});

test("propagates a storage-clear failure rather than reading a fallback session", async () => {
  const clearError = new Error("Keychain unavailable");
  let reads = 0;
  await assert.rejects(
    recoverConfiguredSession({
      storedSession: "expired-stored-session",
      environmentSessionId: "environment-session",
      read: async () => {
        reads += 1;
        throw new EnableBankingApiError(401, "session expired", { error: "EXPIRED_SESSION" });
      },
      clearStoredSession: async () => { throw clearError; },
      clearEnvironmentSession: () => {},
    }),
    (error) => error === clearError,
  );
  assert.equal(reads, 1);
});
