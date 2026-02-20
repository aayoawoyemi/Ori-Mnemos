import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { findVaultRoot, getVaultPaths, listNoteTitles } from "../core/vault.js";
import { buildGraph, findOrphans } from "../core/graph.js";

export type StatusResult = {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
};

export async function runStatus(startDir: string): Promise<StatusResult> {
  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);

  const allNotes = await listNoteTitles(paths.notes);
  const graph = await buildGraph(paths.notes);
  const orphans = findOrphans(graph, allNotes);

  let inboxEntries: Dirent[];
  try {
    inboxEntries = await fs.readdir(paths.inbox, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      inboxEntries = [];
    } else {
      throw err;
    }
  }
  const inboxCount = inboxEntries.filter((e) => e.isFile()).length;

  return {
    success: true,
    data: {
      vaultRoot,
      noteCount: allNotes.length,
      inboxCount,
      orphanCount: orphans.length,
    },
    warnings: [],
  };
}
