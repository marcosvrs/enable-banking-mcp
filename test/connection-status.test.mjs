import { Effect } from "effect";

import assert from "node:assert/strict";
import test from "node:test";
import { EnableBankingApiError } from "../dist/enable-banking.js";
import { inspectConnectionStatus as inspectConnectionStatusEffect } from "../dist/connection-status.js";

function inspectConnectionStatus(input) {
  const client = input.client
    ? {
        ...input.client,
        getApplication: () =>
          Effect.tryPromise({
            try: () => input.client.getApplication(),
            catch: (error) => error,
          }),
        getSession: (sessionId) =>
          Effect.tryPromise({
            try: () => input.client.getSession(sessionId),
            catch: (error) => error,
          }),
      }
    : undefined;
  return Effect.runPromise(
    inspectConnectionStatusEffect({ ...input, client }),
  );
}

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
  assert.match(status.next_action, /link an account.*then call connect_bank/i);
  assert.match(status.next_action, /No new application is needed/);
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
test("does not require dashboard activation for an inactive Sandbox application", async () => {
  const status = await inspectConnectionStatus({
    configuration: "configured",
    sessionIds: [],
    client: {
      getSession: async () => {
        throw new Error("No session should be checked");
      },
      getApplication: async () => ({
        active: false,
        environment: "SANDBOX",
      }),
    },
  });

  assert.equal(status.connection, "bank_authorization_required");
  assert.equal(status.application, "inactive");
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
    pendingAction: "Complete the email link, then resume with connect_bank.",
    onboarding: {
      flow_id: "flow-123",
      status: "awaiting_user",
      phase: "control_panel_auth",
    },
  });
  assert.equal(awaitingUser.connection, "awaiting_user");
  assert.equal(awaitingUser.phase, "control_panel_auth");
  assert.equal(awaitingUser.flow_id, "flow-123");
  assert.equal(awaitingUser.onboarding_status, "awaiting_user");
  assert.match(awaitingUser.next_action, /complete the email link/i);
});
test("prioritizes a running onboarding flow over provider session checks", async () => {
  const status = await inspectConnectionStatus({
    configuration: "configured",
    sessionIds: ["stored-session"],
    client: {
      getSession: async () => {
        throw new Error("provider should not be queried during active onboarding");
      },
      getApplication: async () => {
        throw new Error("application lookup should not run during active onboarding");
      },
    },
    pendingAction: "Setup is active; check status again.",
    onboarding: {
      flow_id: "flow-running",
      status: "running",
      phase: "bank_authorization",
    },
  });

  assert.equal(status.connection, "onboarding_active");
  assert.equal(status.phase, "bank_authorization");
  assert.equal(status.flow_id, "flow-running");
  assert.equal(status.onboarding_status, "running");
  assert.equal(status.next_action, "Setup is active; check status again.");
});


test("reports unavailable status for malformed provider application responses", async () => {
  for (const getApplication of [
    async () => null,
    async () => [],
    async () => ({ active: "yes", environment: "PRODUCTION" }),
  ]) {
    const status = await inspectConnectionStatus({
      configuration: "configured",
      sessionIds: [],
      client: {
        getSession: async () => ({}),
        getApplication,
      },
    });

    assert.equal(status.connection, "status_unavailable");
    assert.equal(status.application, "configured");
    assert.equal(status.bank_session, "missing");
  }
});

test("reports unavailable status when application lookup fails or credentials are invalid", async () => {
  const cases = [
    {
      configuration: "configured",
      sessionIds: [],
      client: {
        getSession: async () => ({}),
        getApplication: async () => {
          throw new Error("provider unavailable");
        },
      },
    },
    {
      configuration: "invalid",
      sessionIds: [],
      client: {
        getSession: async () => ({}),
        getApplication: async () => ({ active: true }),
      },
    },
    {
      configuration: "configured",
      sessionIds: ["stored-session"],
    },
  ];
  for (const input of cases) {
    const status = await inspectConnectionStatus(input);
    assert.equal(status.connection, "status_unavailable");
    assert.equal(status.bank_session, input.sessionIds.length ? "unknown" : "missing");
  }
});

test("tries later stored sessions after a terminal session error", async () => {
  const checked = [];
  const status = await inspectConnectionStatus({
    configuration: "missing",
    sessionIds: ["expired-session", "current-session"],
    client: {
      getSession: async (sessionId) => {
        checked.push(sessionId);
        if (sessionId === "expired-session") {
          throw new EnableBankingApiError(401, "session expired", {
            error: "EXPIRED_SESSION",
          });
        }
        return { valid: true };
      },
      getApplication: async () => ({ active: false }),
    },
  });

  assert.deepEqual(checked, ["expired-session", "current-session"]);
  assert.equal(status.connection, "connected");
  assert.equal(status.bank_session, "valid");
  assert.equal(status.application, "configured");
});
test("treats malformed stored-session responses as unverifiable", async () => {
  const status = await inspectConnectionStatus({
    configuration: "configured",
    sessionIds: ["stored-session"],
    client: {
      getSession: async () => [],
      getApplication: async () => ({ active: true }),
    },
  });

  assert.equal(status.connection, "status_unavailable");
  assert.equal(status.application, "configured");
  assert.equal(status.bank_session, "unknown");
});

test("pending status preserves invalid-configuration and environment context", async () => {
  const status = await inspectConnectionStatus({
    configuration: "invalid",
    sessionIds: [],
    pendingPhase: "application_activation",
    configuredEnvironment: "PRODUCTION",
    controlPanelAuth: { expiresAt: 2_000 },
    now: 1_000,
  });

  assert.equal(status.connection, "awaiting_user");
  assert.equal(status.application, "unknown");
  assert.equal(status.bank_session, "missing");
  assert.equal(status.control_panel_session, "stored");
  assert.equal(status.application_environment, "PRODUCTION");
  assert.equal(status.phase, "application_activation");
});
