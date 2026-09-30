import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";

import { setNativeKeyringEntryFactory } from "../../dist/session-store.js";

const nativeRecords = new Map(
  Object.entries(JSON.parse(process.env.MCP_TEST_KEYCHAIN || "{}")).map(
    ([service, value]) => [
      `${service}\u0000${process.env.USER?.trim() || "default"}`,
      value,
    ],
  ),
);
setNativeKeyringEntryFactory((service, account) => ({
  getPassword: () => nativeRecords.get(`${service}\u0000${account}`) ?? null,
  setPassword: (value) => nativeRecords.set(`${service}\u0000${account}`, value),
  deletePassword: () => {
    const key = `${service}\u0000${account}`;
    if (
      service === "enable-banking-mcp.credentials.native" &&
      certificateDeleteAttempted &&
      oneShotFailures.delete("delete-credential-item")
    ) {
      throw new Error("Injected Keychain deletion failure");
    }
    return nativeRecords.delete(key);
  },
}));
const realSpawn = childProcess.spawn.bind(childProcess);
const oneShotFailures = new Set(
  (process.env.MCP_TEST_FAIL_ONCE || "").split(",").filter(Boolean),
);
let healthRequests = 0;
let applicationRequests = 0;
let sessionCreates = 0;
let failFirstSessionCreate =
  process.env.MCP_TEST_FAIL_FIRST_SESSION_CREATE === "true";
let certificateDeleteAttempted = false;
let delayApplicationRegistration =
  process.env.MCP_TEST_DELAY_REGISTRATION === "true";

function completedChild(stdout = "", stderr = "", code = 0, delay = 0) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.unref = () => child;
  const finish = () => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit("close", code, null);
  };
  if (delay > 0) setTimeout(finish, delay);
  else queueMicrotask(finish);
  return child;
}


function runSecurity(args) {
  const operation = args[0];
  if (operation === "add-trusted-cert") return completedChild();
  if (operation === "delete-certificate") {
    certificateDeleteAttempted = true;
    return oneShotFailures.delete("delete-certificate")
      ? completedChild("", "Injected certificate deletion failure", 1)
      : completedChild();
  }
  return completedChild("", `Unsupported isolated security operation: ${operation}`, 1);
}

childProcess.spawn = (command, args = [], options) => {
  if (command === "/usr/bin/security") {
    return runSecurity(args);
  }
  if (command === "/usr/bin/open") return completedChild();
  return realSpawn(command, args, options);
};
syncBuiltinESMExports();

function sendLocalCallback(value, secure = false) {
  const url = new URL(value);
  const get = secure ? httpsGet : httpGet;
  const request = get(url, { rejectUnauthorized: false }, (response) => {
    response.resume();
  });
  request.on("error", () => {});
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(
    input instanceof URL ? input.href : typeof input === "string" ? input : input.url,
  );
  const method = init.method || "GET";

  if (url.hostname === "api.enablebanking.com" && url.pathname === "/health") {
    healthRequests += 1;
    if (healthRequests === 1) {
      return Response.json({ status: "ok" });
    }
    if (healthRequests === 2) {
      return Response.json(
        { message: "Health unavailable for user@example.com", error: "UPSTREAM_FAILURE", detail: "fixture outage" },
        { status: 503, headers: { "retry-after": "7" } },
      );
    }
    throw "fixture health network failure";
  }

  if (url.hostname === "securetoken.googleapis.com") {
    return Response.json({ id_token: "fixture-id-token", expires_in: "3600" });
  }

  if (url.hostname === "enablebanking.com" && url.pathname === "/api/relyingparty/getOobConfirmationCode") {
    const request = JSON.parse(init.body);
    const callback = new URL(request.continueUrl);
    callback.searchParams.set("oobCode", "fixture-email-code");
    const callbackDelay =
      process.env.MCP_TEST_DELAY_EMAIL_CALLBACK === "true" ? 1_000 : 5;
    setTimeout(() => sendLocalCallback(callback), callbackDelay);
    return Response.json({});
  }

  if (url.hostname === "enablebanking.com" && url.pathname === "/api/relyingparty/emailLinkSignin") {
    return Response.json({
      idToken: "fixture-id-token",
      refreshToken: "fake-fixture-refresh-token",
      expiresIn: "3600",
    });
  }
  if (url.hostname === "enablebanking.com" && url.pathname === "/api/applications") {
    if (delayApplicationRegistration) {
      delayApplicationRegistration = false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return Response.json({ app_id: "fixture-app-id" });
  }

  if (url.hostname === "api.enablebanking.com") {
    if (url.pathname === "/application") {
      applicationRequests += 1;
      return Response.json({
        name: "Fixture application",
        kid: "fixture-app-id",
        environment: "PRODUCTION",
        redirect_urls: ["https://localhost:8765/callback"],
        active: applicationRequests > 2,
        countries: ["IE"],
        services: ["AIS"],
      });
    }
    if (url.pathname === "/aspsps") {
      return Response.json({ aspsps: [{ name: "Fixture Bank", country: "IE" }] });
    }
    if (url.pathname === "/auth") {
      const request = JSON.parse(init.body);
      const callback = new URL(request.redirect_url);
      callback.searchParams.set("code", "fixture-bank-code");
      callback.searchParams.set("state", request.state);
      setTimeout(() => sendLocalCallback(callback, true), 250);
      return Response.json({
        url: "https://bank.example/authorize",
        authorization_id: "fixture-authorization-id",
        psu_id_hash: "fixture-psu-hash",
      });
    }
    if (url.pathname === "/sessions" && method === "POST") {
      sessionCreates += 1;
      if (
        sessionCreates === 3 ||
        (failFirstSessionCreate && sessionCreates === 1)
      ) {
        failFirstSessionCreate = false;
        return Response.json(
          { message: "fixture session exchange failed" },
          { status: 503 },
        );
      }
      return Response.json({ session_id: "fixture-session-id" });
    }
    if (url.pathname.startsWith("/sessions/")) {
      const sessionId = decodeURIComponent(url.pathname.split("/").at(-1));
      if (sessionId === "terminal-session") {
        return Response.json(
          { error: "SESSION_DOES_NOT_EXIST" },
          { status: 404 },
        );
      }
      if (method === "DELETE") {
        return Response.json({ session_id: sessionId, deleted: true });
      }
      return Response.json({
        session_id: sessionId,
        status: "valid",
        aspsp: { name: "Fixture Bank", country: "IE" },
        accounts: [{ uid: "fixture-account" }],
        accounts_data: [{ uid: "fixture-account", name: "Fixture account" }],
        access: { balances: true, transactions: true },
      });
    }
    if (url.pathname === "/accounts/fixture-account/details") {
      return Response.json({ uid: "fixture-account", name: "Fixture account" });
    }
    if (url.pathname === "/accounts/fixture-account/balances") {
      return Response.json({ balances: [{ amount: "12.34", currency: "EUR" }] });
    }
    if (url.pathname === "/accounts/fixture-account/transactions") {
      return Response.json({ transactions: [{ transaction_id: "fixture-transaction" }] });
    }
    if (url.pathname === "/accounts/fixture-account/transactions/fixture-transaction") {
      return Response.json({ transaction_id: "fixture-transaction", amount: "12.34" });
    }
  }

  return Response.json({ message: `Unexpected fixture request: ${url.pathname}` }, { status: 501 });
};
