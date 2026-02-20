#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function hasVaultRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(current, ".ori"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

if (!hasVaultRoot(process.cwd())) {
  process.exit(0);
}

const result = spawnSync("ori", ["status"], { stdio: "inherit" });
if (result.error) process.exit(0);
process.exit(result.status ?? 0);
