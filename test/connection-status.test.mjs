import assert from "node:assert/strict";
import test from "node:test";
import { EnableBankingApiError } from "../dist/enable-banking.js";
import { inspectConnectionStatus } from "../dist/connection-status.js";

test("reports inactive Production app separately from expired Control Panel login", async () => {
  const status = await inspectConnectionStatus({
    configuration: "configured",
    sessionIds: [],
    controlPanelAuth: { expiresAt: 100 },
    configuredEnvironment: "PRODUCTION",
    now: 100,
    client: {
      getSession: async () => {
        throw new Error("No session should be checked");
      },
      getApplication: async () => ({
        active: false,
        environment: "PRODUCTION",
      }),
    },
  });

  assert.equal(status.connection, "application_activation_required");
  assert.equal(status.application, "inactive");
  assert.equal(status.bank_session, "missing");
  assert.equal(status.control_panel_session, "expired");
  assert.equal(status.application_environment, "PRODUCTION");
});

test("reports active applications with no bank consent as authorization required", async () => {
  const status = await inspectConnectionStatus({
    configuration: "configured",
    sessionIds: [],
    client: {
      getSession: async () => {
        throw new Error("No session should be checked");
      },
      getApplication: async () => ({
        active: true,
        environment: "SANDBOX",
      }),
    },
  });

  assert.equal(status.connection, "bank_authorization_required");
  assert.equal(status.application, "active");
  assert.equal(status.bank_session, "missing");
  assert.equal(status.application_environment, "SANDBOX");
});

test("returns connected only after provider accepts the session and omits account data", async () => {
  const status = await inspectConnectionStatus({
    configuration: "configured",
    sessionIds: ["private-session-id"],
    controlPanelAuth: {},
    client: {
      getSession: async () => ({
        session_id: "private-session-id",
        accounts: [{ account_id: "private-account-id" }],
        token: "private-token",
      }),
      getApplication: async () => {
        throw new Error("Application lookup should not be needed");
      },
    },
  });

  assert.equal(status.connection, "connected");
  assert.equal(status.bank_session, "valid");
  assert.equal(status.control_panel_session, "stored");
  assert.doesNotMatch(
    JSON.stringify(status),
    /private-session-id|private-account-id|private-token/,
  );
});

test("reports terminal provider sessions as invalid without clearing them", async () => {
  const status = await inspectConnectionStatus({
    configuration: "configured",
    sessionIds: ["expired-session"],
    client: {
      getSession: async () => {
        throw new EnableBankingApiError(401, "session expired", {
          error: "EXPIRED_SESSION",
        });
      },
      getApplication: async () => ({
        active: true,
        environment: "PRODUCTION",
      }),
    },
  });

  assert.equal(status.connection, "bank_authorization_required");
  assert.equal(status.application, "active");
  assert.equal(status.bank_session, "invalid");
});

test("does not claim a bank session is invalid when provider status is unavailable", async () => {
  const status = await inspectConnectionStatus({
    configuration: "configured",
    sessionIds: ["session-id"],
    client: {
      getSession: async () => {
        throw new EnableBankingApiError(401, "application credentials rejected", {
          error: "UNAUTHORIZED_ACCESS",
        });
      },
      getApplication: async () => ({
        active: true,
        environment: "PRODUCTION",
      }),
    },
  });

  assert.equal(status.connection, "status_unavailable");
  assert.equal(status.bank_session, "unknown");
});

test("reports missing setup and in-progress browser steps without starting them", async () => {
  const setupRequired = await inspectConnectionStatus({
    configuration: "missing",
    sessionIds: [],
  });
  assert.equal(setupRequired.connection, "setup_required");
  assert.equal(setupRequired.application, "not_configured");

  const awaitingUser = await inspectConnectionStatus({
    configuration: "missing",
    sessionIds: [],
    pendingPhase: "control_panel_auth",
  });
  assert.equal(awaitingUser.connection, "awaiting_user");
  assert.equal(awaitingUser.phase, "control_panel_auth");
});
