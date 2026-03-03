import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type VaultPaths = {
  root: string;
  marker: string;
  config: string;
  notes: string;
  inbox: string;
  templates: string;
  self: string;
  selfMemory: string;
  ops: string;
  opsSessions: string;
  opsObservations: string;
};

export async function isVaultRoot(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, ".ori"));
    return true;
  } catch {
    return false;
  }
}

export type VaultRootResult = {
  path: string;
  source: "project" | "global";
};

export function getGlobalVaultPath(): string {
  return path.join(os.homedir(), ".ori-memory");
}

export async function findVaultRootWithSource(
  startDir?: string,
  override?: string,
): Promise<VaultRootResult> {
  // 1. Explicit override — validate or throw
  if (override) {
    const resolved = path.resolve(override);
    if (await isVaultRoot(resolved)) return { path: resolved, source: "project" };
    throw new Error(
      `Vault not found at specified path: ${resolved}. Run 'ori init ${resolved}' to create one.`,
    );
  }

  // 2. Walk up from startDir looking for .ori
  let current = path.resolve(startDir ?? process.cwd());
  while (true) {
    if (await isVaultRoot(current)) return { path: current, source: "project" };
    const parent = path.dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }

  // 3. Check global vault
  const globalPath = getGlobalVaultPath();
  if (await isVaultRoot(globalPath)) return { path: globalPath, source: "global" };

  // 4. No vault anywhere — throw
  throw new Error(
    "No .ori marker found. Run 'ori init' to create a vault, or connect via MCP to auto-create one.",
  );
}

// Wrapper — all existing callers unchanged (returns string)
export async function findVaultRoot(startDir: string, override?: string): Promise<string> {
  const result = await findVaultRootWithSource(startDir, override);
  return result.path;
}

export function getVaultPaths(root: string): VaultPaths {
  return {
    root,
    marker: path.join(root, ".ori"),
    config: path.join(root, "ori.config.yaml"),
    notes: path.join(root, "notes"),
    inbox: path.join(root, "inbox"),
    templates: path.join(root, "templates"),
    self: path.join(root, "self"),
    selfMemory: path.join(root, "self", "memory"),
    ops: path.join(root, "ops"),
    opsSessions: path.join(root, "ops", "sessions"),
    opsObservations: path.join(root, "ops", "observations"),
  };
}

export async function listNoteTitles(notesDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(notesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.replace(/\.md$/, ""));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
