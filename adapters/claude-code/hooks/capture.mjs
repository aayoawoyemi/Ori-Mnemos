#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

function parseHookInput() {
  let raw = "";
  if (!process.stdin.isTTY) {
    try {
      raw = readFileSync(0, "utf8");
    } catch {
      // stdin may be empty
    }
  }
  if (!raw) {
    raw = process.env.HOOK_INPUT ?? "";
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

const input = parseHookInput();
const summary =
  typeof input?.tool_input?.summary === "string" && input.tool_input.summary.length > 0
    ? input.tool_input.summary
    : typeof input?.session_summary === "string" && input.session_summary.length > 0
      ? input.session_summary
      : typeof input?.session_id === "string" && input.session_id.length > 0
        ? input.session_id
        : "";
const normalizedSummary = summary.replace(/\s+/g, " ").trim();
const title =
  normalizedSummary.length > 0
    ? normalizedSummary.slice(0, 120)
    : `session-capture-${new Date().toISOString().replace(/[:.]/g, "-")}`;

if (!hasVaultRoot(process.cwd())) {
  process.exit(0);
}

const result = spawnSync("ori", ["add", title, "--type", "insight"], { stdio: "inherit" });
if (result.error) process.exit(0);
process.exit(result.status ?? 0);
