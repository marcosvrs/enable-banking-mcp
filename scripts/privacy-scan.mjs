#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const zeroSha = /^0+$/;
const safeEmailDomains = new Set([
  "example.com",
  "example.org",
  "example.net",
  "invalid",
  "localhost",
]);
const ignoredDirectoriesWithoutGit = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".nyc_output",
]);

const privateKeyPattern = new RegExp(
  `${"-".repeat(5)}BEGIN\\s+(?:RSA\\s+|EC\\s+|OPENSSH\\s+)?PRIVATE\\s+KEY\\s+${"-".repeat(5)}`,
  "g",
);
const contentRules = [
  {
    name: "private-key-material",
    pattern: privateKeyPattern,
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    name: "known-secret-token",
    pattern:
      /\b(?:ghp_|github_pat_|glpat-|xox[baprs]-|sk_(?:live|test)_|AKIA|AIza)[A-Za-z0-9_./+=-]{10,}\b/gi,
  },
  {
    name: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi,
  },
  {
    name: "credential-assignment",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|private[_-]?key)\b\s*[:=]\s*["'`]([A-Za-z0-9+/=_-]{20,})["'`]/gi,
    accept: (value) => {
      const literal = value.match(/["'`]([^"'`]*)["'`]\s*$/)?.[1] ?? "";
      return !/^(?:refreshed|test|fake|dummy|example|placeholder)(?:[-_]|$)/i.test(
        literal,
      );
    },
  },
  {
    name: "email-address",
    pattern:
      /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9.-])/gi,
    accept: (value) => {
      const domain = value.slice(value.lastIndexOf("@") + 1).toLowerCase();
      return ![...safeEmailDomains].some(
        (safeDomain) =>
          domain === safeDomain || domain.endsWith(`.${safeDomain}`),
      );
    },
  },
  {
    name: "us-social-security-number",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    name: "formatted-phone-number",
    pattern: /(?<!\w)\(\d{3}\)[\s.-]\d{3}[\s.-]\d{4}(?!\w)/g,
  },
  {
    name: "international-phone-number",
    pattern: /(?<!\w)\+\d{1,3}(?:[\s.-]?\d){8,14}(?!\w)/g,
  },
  {
    name: "iban",
    pattern: /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/g,
    accept: isValidIban,
  },
  {
    name: "credit-card-number",
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    accept: (value) => isLuhnValid(value.replace(/[ -]/g, "")),
  },
  {
    name: "public-ip-address",
    pattern: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g,
    accept: isPublicIpv4,
  },
  {
    name: "absolute-user-path",
    pattern: /(?:\/Users\/|\/home\/)[^\s"'`]+/g,
  },
];

function runGit(args, options = {}) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: options.encoding ?? "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(`git ${args[0]} failed`);
  }
}

function isGitRepository() {
  try {
    runGit(["rev-parse", "--show-toplevel"]);
    return true;
  } catch {
    return false;
  }
}

function splitNullDelimited(value) {
  return value.toString().split("\0").filter(Boolean);
}

function normalizePath(file) {
  return file.replaceAll("\\", "/");
}

function walkWithoutGit(directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectoriesWithoutGit.has(entry.name)) {
      continue;
    }

    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      walkWithoutGit(absolutePath, files);
      continue;
    }
    if (entry.isFile() || entry.isSymbolicLink()) {
      const file = normalizePath(relative(root, absolutePath));
      if (!pathRule(file)) {
        files.push(file);
      }
    }
  }
}

function workingTreeFiles() {
  if (!isGitRepository()) {
    const files = [];
    walkWithoutGit(root, files);
    return files;
  }

  return splitNullDelimited(
    runGit(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
  );
}

function stagedFiles() {
  return splitNullDelimited(
    runGit(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]),
  );
}

function commitFiles(commit) {
  return splitNullDelimited(
    runGit([
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--name-only",
      "--diff-filter=ACMR",
      "-r",
      "-m",
      "-z",
      commit,
    ]),
  );
}

function historyCommits(revisionExpression = "--all") {
  const output = runGit(["rev-list", "--reverse", revisionExpression]);
  return output.trim() ? output.trim().split("\n") : [];
}

function readWorkingTreeFile(file) {
  return readFileSync(resolve(root, file));
}

function readStagedFile(file) {
  return runGit(["show", `:${file}`], { encoding: "buffer" });
}

function readCommitFile(commit, file) {
  return runGit(["show", `${commit}:${file}`], { encoding: "buffer" });
}

function readLocalForbiddenValues() {
  const values = [];
  const candidates = [];

  if (process.env.PRIVACY_FORBIDDEN_VALUES) {
    candidates.push(process.env.PRIVACY_FORBIDDEN_VALUES);
  }

  const localPolicyPath = resolve(root, ".privacy.local");
  if (existsSync(localPolicyPath)) {
    candidates.push(readFileSync(localPolicyPath, "utf8"));
  }

  for (const candidate of candidates) {
    for (const line of candidate.split(/\r?\n/)) {
      const value = line.trim();
      if (value && !value.startsWith("#") && value.length >= 4) {
        values.push(value);
      }
    }
  }

  return [...new Set(values)];
}

function isLikelyText(buffer) {
  if (buffer.includes(0)) {
    return false;
  }

  const text = buffer.toString("utf8");
  const replacementCount = [...text].filter((character) => character === "�").length;
  return replacementCount <= Math.max(1, Math.floor(text.length / 100));
}

function lineNumber(text, index) {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (text[position] === "\n") {
      line += 1;
    }
  }
  return line;
}

function isSafePath(file) {
  const normalized = normalizePath(file);
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  return basename === ".env.example";
}

function pathRule(file) {
  const normalized = normalizePath(file);
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);

  if (basename === ".privacy.local") {
    return "local-privacy-denylist";
  }
  if (/^\.env(?:\..*)?$/i.test(basename) && !isSafePath(file)) {
    return "environment-file";
  }
  if (
    /\.(?:pem|key|crt|csr|p12|pfx|der|sqlite|sqlite3|db|log)$/i.test(
      basename,
    )
  ) {
    return "credential-or-local-data-file";
  }
  if (/^(?:secrets?|credentials?|account|tokens?)\.(?:json|ya?ml|toml)$/i.test(basename)) {
    return "credential-named-file";
  }
  return null;
}

function isLuhnValid(value) {
  if (!/^\d{13,19}$/.test(value)) {
    return false;
  }

  let sum = 0;
  let doubleDigit = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function isValidIban(value) {
  const normalized = value.replace(/[ -]/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(normalized)) {
    return false;
  }

  const rearranged = `${normalized.slice(4)}${normalized.slice(0, 4)}`;
  let remainder = 0;
  for (const character of rearranged) {
    const digits = /[A-Z]/.test(character)
      ? String(character.charCodeAt(0) - 55)
      : character;
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

function isPublicIpv4(value) {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255)) {
    return false;
  }

  const [first, second, third] = octets;
  if (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  ) {
    return false;
  }
  return true;
}

function createFindingCollector() {
  const findings = [];
  const seen = new Set();

  return {
    add(file, rule, line) {
      const key = `${file}\0${rule}\0${line}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      findings.push({ file, rule, line });
    },
    values: findings,
  };
}

function scanText(file, text, forbiddenValues, collector) {
  for (const value of forbiddenValues) {
    let offset = text.indexOf(value);
    while (offset !== -1) {
      collector.add(file, "local-forbidden-value", lineNumber(text, offset));
      offset = text.indexOf(value, offset + value.length);
    }
  }

  for (const rule of contentRules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (!rule.accept || rule.accept(value)) {
        collector.add(file, rule.name, lineNumber(text, match.index));
      }
    }
  }
}

function scanFile(file, buffer, forbiddenValues, collector) {
  const rule = pathRule(file);
  if (rule) {
    collector.add(file, rule, 1);
  }

  if (!isLikelyText(buffer)) {
    return;
  }
  scanText(file, buffer.toString("utf8"), forbiddenValues, collector);
}

function scanWorkingTree(forbiddenValues, collector) {
  const files = workingTreeFiles();
  for (const file of files) {
    scanFile(file, readWorkingTreeFile(file), forbiddenValues, collector);
  }
  return files.length;
}

function scanStaged(forbiddenValues, collector) {
  const files = stagedFiles();
  for (const file of files) {
    scanFile(file, readStagedFile(file), forbiddenValues, collector);
  }
  return files.length;
}

function scanCommits(commits, forbiddenValues, collector) {
  const scannedFiles = new Set();
  for (const commit of commits) {
    for (const file of new Set(commitFiles(commit))) {
      scanFile(file, readCommitFile(commit, file), forbiddenValues, collector);
      scannedFiles.add(`${commit}\0${file}`);
    }
  }
  return scannedFiles.size;
}

function scanPush(forbiddenValues, collector) {
  const input = readFileSync(0, "utf8");
  const commits = new Set();

  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    const [localRef, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localRef || !localSha || zeroSha.test(localSha)) {
      continue;
    }

    try {
      const expression = remoteSha && !zeroSha.test(remoteSha)
        ? `${remoteSha}..${localSha}`
        : localSha;
      for (const commit of historyCommits(expression)) {
        commits.add(commit);
      }
    } catch {
      for (const commit of historyCommits(localSha)) {
        commits.add(commit);
      }
    }
  }

  return scanCommits([...commits], forbiddenValues, collector);
}

function parseMode(args) {
  if (args.length === 0 || args[0] === "--staged") {
    return { name: "staged" };
  }
  if (args[0] === "--all") {
    return { name: "all" };
  }
  if (args[0] === "--history") {
    return { name: "history" };
  }
  if (args[0] === "--push") {
    return { name: "push" };
  }
  if (args[0] === "--range" && args[1]) {
    return { name: "range", expression: args[1] };
  }
  throw new Error("usage: privacy-scan.mjs [--staged|--all|--history|--push|--range <git-range>]");
}

function printFindings(findings) {
  console.error(`Privacy scan blocked ${findings.length} finding(s):`);
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} [${finding.rule}]`);
  }
  console.error(
    "Matched values are intentionally not printed. Remove or redact the data before committing.",
  );
}

function main() {
  const mode = parseMode(process.argv.slice(2));
  const forbiddenValues = readLocalForbiddenValues();
  const collector = createFindingCollector();
  let scannedCount;

  if (mode.name === "all") {
    scannedCount = scanWorkingTree(forbiddenValues, collector);
  } else if (mode.name === "staged") {
    scannedCount = scanStaged(forbiddenValues, collector);
  } else if (mode.name === "history") {
    scannedCount = scanCommits(
      historyCommits(),
      forbiddenValues,
      collector,
    );
  } else if (mode.name === "range") {
    scannedCount = scanCommits(
      historyCommits(mode.expression),
      forbiddenValues,
      collector,
    );
  } else {
    scannedCount = scanPush(forbiddenValues, collector);
  }

  if (collector.values.length > 0) {
    printFindings(collector.values);
    process.exitCode = 1;
    return;
  }

  console.log(`Privacy scan passed (${scannedCount} file revision(s) inspected).`);
}

try {
  main();
} catch (error) {
  console.error(`Privacy scan could not run: ${error.message}`);
  process.exitCode = 2;
}
