#!/usr/bin/env node

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const fixturePath = join(repositoryRoot, "test", "fixtures", "e2e-mcp-server.mjs");
const serverPath = join(repositoryRoot, "dist", "server.js");
const inspectorVersion = process.env.MCP_INSPECTOR_VERSION || "2.4.0";
const commandTimeoutMs = Number.parseInt(
  process.env.E2E_COMMAND_TIMEOUT_MS || "90000",
  10,
);
const marker = "MCP_E2E_OK";
const expectedValue = "enable-banking-mcp";
const expectedRequestId = "consumer-e2e";
const expectedTools = [
  "authorize_bank",
  "clear_local_credentials",
  "connect_bank",
  "connection_status",
  "control_panel_authenticate",
  "control_panel_logout",
  "control_panel_status",
  "delete_session",
  "get_account_balances",
  "get_account_details",
  "get_account_transactions",
  "get_application",
  "get_health",
  "get_session",
  "get_transaction_details",
  "list_accounts",
  "list_banks",
  "register_application",
  "setup_enable_banking",
  "setup_status",
];

function requestedClients() {
  const clientFlagIndex = process.argv.indexOf("--client");
  const requested =
    clientFlagIndex === -1 ? "all" : process.argv[clientFlagIndex + 1];
  if (requested === "all") return ["claude", "codex"];
  if (requested === "claude" || requested === "codex") return [requested];
  throw new Error(`Unknown --client value: ${requested}`);
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function safeEnvironment(overrides = {}) {
  const environment = {
    ...process.env,
    ...overrides,
    CI: "1",
    NO_COLOR: "1",
  };
  for (const key of Object.keys(environment)) {
    if (
      key.startsWith("ENABLE_BANKING_") ||
      /API[_-]?KEY/i.test(key)
    ) {
      delete environment[key];
    }
  }
  return environment;
}

function preview(value) {
  const text = String(value || "").trim();
  return text.length > 4000 ? `${text.slice(0, 4000)}\n...` : text;
}

function runCommand(command, args, options = {}) {
  const {
    cwd = repositoryRoot,
    env = safeEnvironment(),
    timeoutMs = commandTimeoutMs,
  } = options;

  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        command,
        args,
        code,
        signal,
        stderr,
        stdout,
        spawnError,
        timedOut,
      });
    });
  });
}

function requireSuccess(result, label) {
  if (result.spawnError) {
    throw new Error(`${label} could not start: ${result.spawnError.message}`);
  }
  if (result.timedOut) {
    throw new Error(`${label} timed out after ${commandTimeoutMs}ms`);
  }
  if (result.code !== 0) {
    throw new Error(
      `${label} exited with ${result.code ?? result.signal}\nstdout:\n${preview(result.stdout)}\nstderr:\n${preview(result.stderr)}`,
    );
  }
}


async function readCalls(callLogPath) {
  const content = await readFile(callLogPath, "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function assertFixtureCall(calls, client) {
  if (calls.length !== 1) {
    throw new Error(`${client} fixture received ${calls.length} calls; expected exactly one`);
  }
  const [call] = calls;
  if (call.tool !== "e2e_echo") {
    throw new Error(`${client} fixture received unexpected tool ${call.tool}`);
  }
  if (call.arguments?.value !== expectedValue) {
    throw new Error(
      `${client} sent value ${JSON.stringify(call.arguments?.value)} instead of ${JSON.stringify(expectedValue)}`,
    );
  }
  if (call.arguments?.request_id !== expectedRequestId) {
    throw new Error(
      `${client} sent request_id ${JSON.stringify(call.arguments?.request_id)} instead of ${JSON.stringify(expectedRequestId)}`,
    );
  }
}

async function writeFailureArtifacts(artifactRoot, label, result, callLogPath) {
  await writeFile(join(artifactRoot, `${label}.stdout`), result?.stdout || "", "utf8");
  await writeFile(join(artifactRoot, `${label}.stderr`), result?.stderr || "", "utf8");
  if (callLogPath) {
    try {
      await cp(callLogPath, join(artifactRoot, `${label}.calls.jsonl`));
    } catch {
      // The process may have failed before the fixture created its call log.
    }
  }
}

function inspectorArgs(method, ...methodArgs) {
  return [
    "--yes",
    `@modelcontextprotocol/inspector@${inspectorVersion}`,
    "--cli",
    process.execPath,
    serverPath,
    "--method",
    method,
    "--format",
    "json",
    ...methodArgs,
  ];
}

async function readPackageJson() {
  return JSON.parse(
    await readFile(join(repositoryRoot, "package.json"), "utf8"),
  );
}

async function verifyPluginWiring() {
  const packageJson = await readPackageJson();
  const expectedArgs = ["-y", `enable-banking-mcp@${packageJson.version}`];
  for (const pluginDirectory of ["claude-code-plugin", "codex-plugin"]) {
    const manifestDirectory =
      pluginDirectory === "claude-code-plugin"
        ? ".claude-plugin"
        : ".codex-plugin";
    const manifest = JSON.parse(
      await readFile(
        join(repositoryRoot, pluginDirectory, manifestDirectory, "plugin.json"),
        "utf8",
      ),
    );
    if (
      manifest.name !== "enable-banking-mcp" ||
      manifest.version !== packageJson.version
    ) {
      throw new Error(
        `${pluginDirectory}/plugin.json must identify version ${packageJson.version}`,
      );
    }
    const config = JSON.parse(
      await readFile(
        join(repositoryRoot, pluginDirectory, ".mcp.json"),
        "utf8",
      ),
    );
    const server = config.mcpServers?.["enable-banking"];
    if (
      server?.command !== "npx" ||
      JSON.stringify(server.args) !== JSON.stringify(expectedArgs)
    ) {
      throw new Error(
        `${pluginDirectory}/.mcp.json must launch ${expectedArgs.join(" ")}`,
      );
    }
  }
}

function publishedInspectorArgs(configPath, method) {
  return [
    "--yes",
    `@modelcontextprotocol/inspector@${inspectorVersion}`,
    "--cli",
    "--config",
    configPath,
    "--server",
    "published",
    "--method",
    method,
    "--format",
    "json",
    ...(method === "tools/list" ? ["--strict"] : []),
  ];
}

async function runPackageSmoke(artifactRoot, packageTarball = null) {
  const packageJson = await readPackageJson();
  const packageArchive = packageTarball;
  const packageLabel = packageArchive ? "Local packed package" : "Published package";
  const root = await mkdtemp(join(tmpdir(), "enable-banking-mcp-package-"));
  const configPath = join(root, "mcp.json");
  try {
    for (const pluginDirectory of ["claude-code-plugin", "codex-plugin"]) {
      const config = JSON.parse(
        await readFile(
          join(repositoryRoot, pluginDirectory, ".mcp.json"),
          "utf8",
        ),
      );
      const server = config.mcpServers["enable-banking"];
      const packageServer = packageArchive
        ? {
            command: "npx",
            args: ["--yes", "--package", packageArchive, packageJson.name],
          }
        : server;
      await writeFile(
        configPath,
        `${JSON.stringify(
          {
            mcpServers: {
              published: {
                command: packageServer.command,
                args: packageServer.args,
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      for (const method of ["initialize", "tools/list"]) {
        const result = await runCommand(
          "npx",
          publishedInspectorArgs(configPath, method),
          { cwd: root },
        );
        try {
          requireSuccess(
            result,
            `${packageLabel} ${pluginDirectory} ${method}`,
          );
          const response = JSON.parse(result.stdout);
          if (method === "initialize") {
            if (response.result?.serverInfo?.name !== "enable-banking") {
              throw new Error(
                `${packageLabel} ${pluginDirectory} returned an unexpected server name`,
              );
            }
            if (response.result?.serverInfo?.version !== packageJson.version) {
              throw new Error(
                `${packageLabel} ${pluginDirectory} returned version ${response.result?.serverInfo?.version}; expected ${packageJson.version}`,
              );
            }
          } else {
            const names = response.result?.tools?.map((tool) => tool.name).sort();
            if (
              JSON.stringify(names) !==
              JSON.stringify([...expectedTools].sort())
            ) {
              throw new Error(
                `${packageLabel} ${pluginDirectory} exposed an unexpected tool contract`,
              );
            }
          }
        } catch (error) {
          await writeFailureArtifacts(
            artifactRoot,
            `package-${pluginDirectory}-${method.replace("/", "-")}`,
            result,
          );
          throw error;
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log(
    `${packageLabel} E2E passed: both plugin MCP commands initialized and exposed the expected contract`,
  );
}

async function packLocalPackage(artifactRoot) {
  const root = await mkdtemp(join(tmpdir(), "enable-banking-mcp-pack-"));
  const result = await runCommand(
    "npm",
    ["pack", "--silent", "--pack-destination", root],
  );
  try {
    requireSuccess(result, "Local npm package creation");
    const archiveName = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!archiveName || !archiveName.endsWith(".tgz")) {
      throw new Error(`npm pack returned no archive name: ${result.stdout}`);
    }
    return { root, archivePath: join(root, archiveName) };
  } catch (error) {
    await writeFailureArtifacts(artifactRoot, "package-pack", result);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function runMcpContract(artifactRoot) {
  const packageJson = await readPackageJson();
  const initialize = await runCommand("npx", inspectorArgs("initialize"));
  try {
    requireSuccess(initialize, "MCP Inspector initialize");
    const response = JSON.parse(initialize.stdout);
    if (response.result?.serverInfo?.name !== "enable-banking") {
      throw new Error("MCP initialize returned an unexpected server name");
    }
    if (response.result?.serverInfo?.version !== packageJson.version) {
      throw new Error(
        `MCP initialize returned version ${response.result?.serverInfo?.version}; expected ${packageJson.version}`,
      );
    }
    if (!response.result?.protocolVersion) {
      throw new Error("MCP initialize returned no protocol version");
    }
  } catch (error) {
    await writeFailureArtifacts(artifactRoot, "mcp-initialize", initialize);
    throw error;
  }

  const list = await runCommand("npx", [
    ...inspectorArgs("tools/list"),
    "--strict",
  ]);
  try {
    requireSuccess(list, "MCP Inspector tools/list");
    const response = JSON.parse(list.stdout);
    const names = response.result?.tools?.map((tool) => tool.name).sort();
    if (JSON.stringify(names) !== JSON.stringify([...expectedTools].sort())) {
      throw new Error(
        `MCP tool contract changed\nexpected: ${expectedTools.join(", ")}\nactual: ${names?.join(", ")}`,
      );
    }
    const connectionTool = response.result.tools.find(
      (tool) => tool.name === "connection_status",
    );
    if (
      connectionTool?.description !==
        "Read-only status of the personal AIS bank connection. A running guided flow is reported as onboarding_active with its phase and flow_id without querying provider session state. Otherwise verifies a stored provider session, reports pending or required onboarding steps, and gives the next action; never opens a browser, starts consent, changes stored state, or returns account data." ||
      connectionTool.annotations?.readOnlyHint !== true ||
      connectionTool.annotations?.destructiveHint !== false ||
      connectionTool.annotations?.idempotentHint !== true ||
      connectionTool.annotations?.openWorldHint !== true
    ) {
      throw new Error("connection_status metadata changed unexpectedly");
    }
  } catch (error) {
    await writeFailureArtifacts(artifactRoot, "mcp-tools-list", list);
    throw error;
  }

  const fixtureList = await runCommand("npx", [
    "--yes",
    `@modelcontextprotocol/inspector@${inspectorVersion}`,
    "--cli",
    process.execPath,
    fixturePath,
    "--method",
    "tools/list",
    "--format",
    "json",
    "--strict",
  ]);
  try {
    requireSuccess(fixtureList, "MCP Inspector fixture tools/list");
    const response = JSON.parse(fixtureList.stdout);
    const echoTool = response.result?.tools?.find(
      (tool) => tool.name === "e2e_echo",
    );
    if (
      !echoTool?.inputSchema?.required?.includes("value") ||
      !echoTool.outputSchema?.required?.includes("marker") ||
      echoTool.annotations?.readOnlyHint !== true ||
      echoTool.annotations?.destructiveHint !== false
    ) {
      throw new Error("MCP fixture schema or safety annotations changed");
    }
  } catch (error) {
    await writeFailureArtifacts(
      artifactRoot,
      "mcp-fixture-tools-list",
      fixtureList,
    );
    throw error;
  }

  const fixtureRoot = await mkdtemp(join(tmpdir(), "enable-banking-mcp-inspector-"));
  const callLogPath = join(fixtureRoot, "calls.jsonl");
  await writeFile(callLogPath, "", "utf8");
  const fixtureEnvironment = safeEnvironment();
  const fixtureCall = await runCommand(
    "npx",
    [
      "--yes",
      `@modelcontextprotocol/inspector@${inspectorVersion}`,
      "--cli",
      process.execPath,
      fixturePath,
      "--method",
      "tools/call",
      "--tool-name",
      "e2e_echo",
      "--tool-args-json",
      JSON.stringify({ value: expectedValue, request_id: expectedRequestId }),
      "--format",
      "json",
      "-e",
      `MCP_E2E_CALL_LOG=${callLogPath}`,
      "-e",
      `MCP_E2E_MARKER=${marker}`,
    ],
    { env: fixtureEnvironment },
  );
  try {
    requireSuccess(fixtureCall, "MCP Inspector fixture tools/call");
    const response = JSON.parse(fixtureCall.stdout);
    if (response.result?.isError) {
      throw new Error("MCP fixture echo unexpectedly returned an error");
    }
    if (!fixtureCall.stdout.includes(marker)) {
      throw new Error("MCP fixture echo returned no result marker");
    }
    assertFixtureCall(await readCalls(callLogPath), "Inspector");
  } catch (error) {
    await writeFailureArtifacts(artifactRoot, "mcp-fixture-call", fixtureCall, callLogPath);
    throw error;
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }

  const fixtureError = await runCommand(
    "npx",
    [
      "--yes",
      `@modelcontextprotocol/inspector@${inspectorVersion}`,
      "--cli",
      process.execPath,
      fixturePath,
      "--method",
      "tools/call",
      "--tool-name",
      "e2e_fail",
      "--tool-args-json",
      JSON.stringify({ message: "MCP_E2E_EXPECTED_ERROR" }),
      "--format",
      "json",
    ],
    { env: safeEnvironment() },
  );
  try {
    if (fixtureError.code !== 5) {
      throw new Error(
        `MCP Inspector did not classify the fixture tool error as exit 5; got ${fixtureError.code}\nstdout:\n${preview(fixtureError.stdout)}\nstderr:\n${preview(fixtureError.stderr)}`,
      );
    }
    const response = JSON.parse(fixtureError.stdout);
    if (response.result?.isError !== true) {
      throw new Error("MCP Inspector fixture error lost isError=true");
    }
  } catch (error) {
    await writeFailureArtifacts(artifactRoot, "mcp-fixture-error", fixtureError);
    throw error;
  }

  const packed = await packLocalPackage(artifactRoot);
  try {
    await runPackageSmoke(artifactRoot, packed.archivePath);
  } finally {
    await rm(packed.root, { recursive: true, force: true });
  }
  console.log("MCP contract E2E passed: initialize, exact tools, success, and error classification");
}

function fixtureMcpConfig(callLogPath, client) {
  const server = {
    command: process.execPath,
    args: [fixturePath],
    env: {
      MCP_E2E_CALL_LOG: callLogPath,
      MCP_E2E_MARKER: marker,
    },
  };
  if (client === "codex") {
    Object.assign(server, {
      default_tools_approval_mode: "auto",
      enabled_tools: ["e2e_echo"],
      env_vars: ["MCP_E2E_CALL_LOG", "MCP_E2E_MARKER"],
    });
  }
  return { mcpServers: { "e2e-fixture": server } };
}

async function createTestPlugin(
  sourceDirectory,
  targetDirectory,
  callLogPath,
  client,
) {
  await cp(sourceDirectory, targetDirectory, { recursive: true });
  await writeFile(
    join(targetDirectory, ".mcp.json"),
    `${JSON.stringify(fixtureMcpConfig(callLogPath, client), null, 2)}\n`,
    "utf8",
  );
}

async function readPluginMcpConfig(pluginDirectory) {
  return JSON.parse(
    await readFile(join(pluginDirectory, ".mcp.json"), "utf8"),
  );
}

function assertFixturePluginConfig(config, client, label) {
  const server = config.mcpServers?.["e2e-fixture"];
  if (
    server?.command !== process.execPath ||
    JSON.stringify(server.args) !== JSON.stringify([fixturePath]) ||
    server.env?.MCP_E2E_MARKER !== marker ||
    typeof server.env?.MCP_E2E_CALL_LOG !== "string"
  ) {
    throw new Error(`${label} does not point at the deterministic MCP fixture`);
  }
  if (client === "codex") {
    if (
      server.default_tools_approval_mode !== "auto" ||
      JSON.stringify(server.enabled_tools) !== JSON.stringify(["e2e_echo"]) ||
      JSON.stringify(server.env_vars) !==
        JSON.stringify(["MCP_E2E_CALL_LOG", "MCP_E2E_MARKER"])
    ) {
      throw new Error(`${label} lost Codex fixture approval or environment settings`);
    }
  } else if (
    "default_tools_approval_mode" in server ||
    "enabled_tools" in server ||
    "env_vars" in server
  ) {
    throw new Error(`${label} contains unsupported Claude MCP settings`);
  }
}

async function assertFixturePlugin(pluginDirectory, client, label) {
  assertFixturePluginConfig(
    await readPluginMcpConfig(pluginDirectory),
    client,
    label,
  );
}

async function runClaude(artifactRoot) {
  const root = await mkdtemp(join(tmpdir(), "enable-banking-mcp-claude-"));
  const home = join(root, "home");
  const pluginDirectory = join(root, "plugin");
  const callLogPath = join(root, "calls.jsonl");
  await mkdir(home, { recursive: true });
  await writeFile(callLogPath, "", "utf8");
  await createTestPlugin(
    join(repositoryRoot, "claude-code-plugin"),
    pluginDirectory,
    callLogPath,
    "claude",
  );

  let validation;
  try {
    await assertFixturePlugin(
      pluginDirectory,
      "claude",
      "Claude fixture plugin",
    );
    validation = await runCommand(
      "claude",
      ["plugin", "validate", pluginDirectory, "--strict"],
      { env: safeEnvironment({ HOME: home }) },
    );
    requireSuccess(validation, "Claude plugin validation");
  } catch (error) {
    await writeFailureArtifacts(
      artifactRoot,
      "claude-plugin-validation",
      validation,
      callLogPath,
    );
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log(
    "Claude offline E2E passed: plugin validation and fixture wiring",
  );
}

async function runCodex(artifactRoot) {
  const root = await mkdtemp(join(tmpdir(), "enable-banking-mcp-codex-"));
  const home = join(root, "home");
  const codexHome = join(root, "codex-home");
  const workspace = join(root, "workspace");
  const pluginDirectory = join(root, "codex-plugin");
  const marketplaceDirectory = join(root, "marketplace");
  const callLogPath = join(root, "calls.jsonl");
  await mkdir(home, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(join(marketplaceDirectory, ".agents", "plugins"), {
    recursive: true,
  });
  await writeFile(callLogPath, "", "utf8");
  await createTestPlugin(
    join(repositoryRoot, "codex-plugin"),
    pluginDirectory,
    callLogPath,
    "codex",
  );
  await cp(pluginDirectory, join(marketplaceDirectory, "codex-plugin"), {
    recursive: true,
  });
  await writeFile(
    join(marketplaceDirectory, ".agents", "plugins", "marketplace.json"),
    `${JSON.stringify(
      {
        name: "enable-banking-mcp-e2e",
        interface: { displayName: "Enable Banking MCP E2E" },
        plugins: [
          {
            name: "enable-banking-mcp",
            source: { source: "local", path: "./codex-plugin" },
            policy: {
              installation: "AVAILABLE",
              authentication: "ON_INSTALL",
            },
            category: "Productivity",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(join(workspace, ".keep"), "", "utf8");

  const environment = safeEnvironment({
    HOME: home,
    CODEX_HOME: codexHome,
    MCP_E2E_CALL_LOG: callLogPath,
    MCP_E2E_MARKER: marker,
  });
  const marketplaceName = "enable-banking-mcp-e2e";
  const pluginId = `enable-banking-mcp@${marketplaceName}`;
  let result;
  try {
    await assertFixturePlugin(
      pluginDirectory,
      "codex",
      "Codex fixture plugin",
    );

    result = await runCommand(
      "codex",
      ["plugin", "marketplace", "add", marketplaceDirectory, "--json"],
      { env: environment },
    );
    requireSuccess(result, "Codex marketplace registration");
    const marketplaceOutput = JSON.parse(result.stdout);
    if (marketplaceOutput.marketplaceName !== marketplaceName) {
      throw new Error(
        `Codex registered unexpected marketplace ${marketplaceOutput.marketplaceName}`,
      );
    }

    result = await runCommand(
      "codex",
      ["plugin", "list", "--available", "--json"],
      { env: environment },
    );
    requireSuccess(result, "Codex plugin discovery");
    const availableOutput = JSON.parse(result.stdout);
    if (
      !availableOutput.available?.some(
        (plugin) => plugin.pluginId === pluginId,
      )
    ) {
      throw new Error(`Codex did not discover ${pluginId}`);
    }

    result = await runCommand(
      "codex",
      ["plugin", "add", pluginId, "--json"],
      { env: environment },
    );
    requireSuccess(result, "Codex plugin installation");
    const installationOutput = JSON.parse(result.stdout);
    if (
      installationOutput.pluginId !== pluginId ||
      typeof installationOutput.installedPath !== "string"
    ) {
      throw new Error(`Codex did not install ${pluginId}: ${result.stdout}`);
    }
    assertFixturePluginConfig(
      await readPluginMcpConfig(resolve(installationOutput.installedPath)),
      "codex",
      "Installed Codex fixture plugin",
    );
  } catch (error) {
    await writeFailureArtifacts(
      artifactRoot,
      "codex-offline",
      result,
      callLogPath,
    );
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  console.log(
    "Codex offline E2E passed: marketplace registration, plugin installation, and fixture wiring",
  );
}

async function main() {
  if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs < 1000) {
    throw new Error("E2E_COMMAND_TIMEOUT_MS must be at least 1000 milliseconds");
  }
  const artifactBase = process.env.E2E_ARTIFACT_DIR
    ? resolve(process.env.E2E_ARTIFACT_DIR)
    : tmpdir();
  await mkdir(artifactBase, { recursive: true });
  const artifactRoot = await mkdtemp(
    join(artifactBase, "enable-banking-mcp-e2e-artifacts-"),
  );
  const clients = requestedClients();
  const mcpOnly = hasFlag("--mcp-only");
  try {
    if (!hasFlag("--skip-mcp")) {
      await runMcpContract(artifactRoot);
    }
    if (hasFlag("--published")) {
      await runPackageSmoke(artifactRoot);
    }
    if (!mcpOnly && clients.includes("claude")) await runClaude(artifactRoot);
    if (!mcpOnly && clients.includes("codex")) await runCodex(artifactRoot);
    await rm(artifactRoot, { recursive: true, force: true });
  } catch (error) {
    console.error(`E2E failed. Diagnostic artifacts: ${artifactRoot}`);
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}

await main();
