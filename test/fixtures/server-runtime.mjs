import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";

import { setNativeKeyringEntryFactory } from "../../dist/session-store.js";

const nativeRecords = new Map();
setNativeKeyringEntryFactory((service, account) => ({
  getPassword: () => nativeRecords.get(`${service}\u0000${account}`) ?? null,
  setPassword: (value) => nativeRecords.set(`${service}\u0000${account}`, value),
  deletePassword: () => {
    const key = `${service}\u0000${account}`;
    if (
      service === "enable-banking-mcp.native" &&
      certificateDeleteAttempted &&
      oneShotFailures.delete("delete-session")
    ) {
      throw new Error("Injected Keychain deletion failure");
    }
    return nativeRecords.delete(key);
  },
}));
const records = new Map(
  Object.entries(JSON.parse(process.env.MCP_TEST_KEYCHAIN || "{}")),
);
const realSpawn = childProcess.spawn.bind(childProcess);
const oneShotFailures = new Set(
  (process.env.MCP_TEST_FAIL_ONCE || "").split(",").filter(Boolean),
);
let healthRequests = 0;
let applicationRequests = 0;
let sessionCreates = 0;
let certificateDeleteAttempted = false;
let delayApplicationRegistration =
  process.env.MCP_TEST_DELAY_REGISTRATION === "true";

function completedChild(stdout = "", stderr = "", code = 0) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.unref = () => child;
  queueMicrotask(() => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    child.emit("close", code, null);
  });
  return child;
}

function runSecurity(args) {
  const operation = args[0];
  const serviceIndex = args.indexOf("-s");
  const service = serviceIndex === -1 ? undefined : args[serviceIndex + 1];
  if (operation === "find-generic-password" && service) {
    const value = records.get(service);
    return value === undefined
      ? completedChild("", "The specified item could not be found in the keychain.", 44)
      : completedChild(`${value}\n`);
  }
  if (operation === "delete-generic-password" && service) {
    if (
      service === "enable-banking-mcp" &&
      certificateDeleteAttempted &&
      oneShotFailures.delete("delete-session")
    ) {
      return completedChild("", "Injected Keychain deletion failure", 1);
    }
    records.delete(service);
    return completedChild();
  }
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
    if (oneShotFailures.delete("security-no-stdio")) {
      const child = new EventEmitter();
      child.kill = () => true;
      return child;
    }
    if (oneShotFailures.delete("security-spawn-error")) {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        child.emit("error", new Error("Injected security spawn error"));
      });
      return child;
    }
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
    setTimeout(() => sendLocalCallback(callback), 5);
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
      if (sessionCreates === 3) {
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
