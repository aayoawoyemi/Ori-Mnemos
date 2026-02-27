import { promises as fs } from "node:fs";
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

export async function findVaultRoot(startDir: string, override?: string): Promise<string> {
  if (override) {
    const resolved = path.resolve(override);
    if (await isVaultRoot(resolved)) return resolved;
    throw new Error(`Specified vault path is not a vault: ${resolved}`);
  }
  let current = path.resolve(startDir);
  // Walk up to filesystem root
  while (true) {
    if (await isVaultRoot(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("No .ori marker found in parent directories");
    }
    current = parent;
  }
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
