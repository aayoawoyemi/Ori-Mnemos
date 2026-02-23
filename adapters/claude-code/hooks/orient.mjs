#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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

// Try enhanced health-based orient first
const healthResult = spawnSync("ori", ["health"], {
  encoding: "utf8",
  timeout: 8000,
  shell: true,
});

if (healthResult.error || healthResult.status !== 0) {
  // Fallback to basic status
  const result = spawnSync("ori", ["status"], { stdio: "inherit", shell: true });
  process.exit(result.status ?? 0);
}

try {
  const health = JSON.parse(healthResult.stdout);
  const data = health.data ?? health;
  const lines = [];

  lines.push(`Vault: ${data.noteCount ?? 0} notes`);

  // Inbox count
  let inboxDir = null;
  let current = path.resolve(process.cwd());
  while (true) {
    if (existsSync(path.join(current, ".ori"))) {
      inboxDir = path.join(current, "inbox");
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (inboxDir && existsSync(inboxDir)) {
    try {
      const inboxFiles = readdirSync(inboxDir).filter((f) =>
        f.endsWith(".md")
      );
      if (inboxFiles.length > 0) {
        lines.push(`Inbox: ${inboxFiles.length} note(s) ready for promotion`);
        for (const f of inboxFiles.slice(0, 5)) {
          lines.push(`  - ${f.replace(/\.md$/, "")}`);
        }
        if (inboxFiles.length > 5) {
          lines.push(`  ... and ${inboxFiles.length - 5} more`);
        }
      }
    } catch {
      // ignore
    }
  }

  // Fading notes
  if (Array.isArray(data.fading) && data.fading.length > 0) {
    lines.push(`Fading: ${data.fading.length} note(s) losing vitality`);
    for (const f of data.fading.slice(0, 3)) {
      lines.push(
        `  - ${f.note} (vitality: ${typeof f.vitality === "number" ? f.vitality.toFixed(2) : "?"})`
      );
    }
  }

  // Orphans / dangling
  if (data.orphanCount > 0) {
    lines.push(`Orphans: ${data.orphanCount}`);
  }
  if (data.danglingCount > 0) {
    lines.push(`Dangling links: ${data.danglingCount}`);
  }

  // Project context from git
  try {
    const gitResult = spawnSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 3000,
      shell: true,
    });
    if (!gitResult.error && gitResult.stdout) {
      const repoName = path
        .basename(gitResult.stdout.trim(), ".git")
        .toLowerCase();
      lines.push(`Project context: ${repoName}`);
    }
  } catch {
    // ignore
  }

  console.log(lines.join("\n"));
} catch {
  // JSON parse failed, fall back to status
  const result = spawnSync("ori", ["status"], { stdio: "inherit", shell: true });
  process.exit(result.status ?? 0);
}

process.exit(0);
