#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  execFileSync("git", ["rev-parse", "--git-dir"], {
    cwd: root,
    stdio: "ignore",
  });
} catch {
  console.log("Git hooks not installed: this directory is not a Git worktree.");
  process.exit(0);
}

execFileSync("git", ["config", "core.hooksPath", ".githooks"], {
  cwd: root,
  stdio: "inherit",
});
console.log("Installed .githooks as the repository hooks path.");
