import path from "node:path";
import { promises as fs } from "node:fs";
import { findVaultRoot, getVaultPaths } from "../core/vault.js";
import { loadConfig } from "../core/config.js";
import { buildIndex, initDB } from "../core/engine.js";
import type { IndexStats } from "../core/engine.js";

export type IndexBuildResult = {
  success: boolean;
  data: IndexStats;
  warnings: string[];
};

export type IndexStatusResult = {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
};

/**
 * Build (or rebuild) the embedding index for the vault.
 */
export async function runIndexBuild(
  startDir: string,
  force?: boolean,
): Promise<IndexBuildResult> {
  const warnings: string[] = [];

  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);

  if (force) {
    warnings.push("Force rebuild requested — all notes will be re-indexed");
  }

  const stats = await buildIndex(vaultRoot, config.engine, { force });

  return {
    success: true,
    data: stats,
    warnings,
  };
}

/**
 * Report the current state of the embedding index.
 */
export async function runIndexStatus(
  startDir: string,
): Promise<IndexStatusResult> {
  const warnings: string[] = [];

  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);

  const dbPath = path.resolve(vaultRoot, config.engine.db_path);

  let exists = true;
  try {
    await fs.access(dbPath);
  } catch {
    exists = false;
  }

  if (!exists) {
    return {
      success: true,
      data: {
        exists: false,
        noteCount: 0,
        model: config.engine.embedding_model,
        dbPath,
        dbSizeBytes: 0,
      },
      warnings,
    };
  }

  // Open DB and read stats
  const db = initDB(dbPath);

  const noteCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM embeddings").get() as { cnt: number }
  ).cnt;

  // Read meta values
  const metaRows = db
    .prepare("SELECT key, value FROM meta")
    .all() as Array<{ key: string; value: string }>;
  const meta: Record<string, string> = {};
  for (const row of metaRows) {
    meta[row.key] = row.value;
  }

  db.close();

  // Get file size
  const stat = await fs.stat(dbPath);

  return {
    success: true,
    data: {
      exists: true,
      noteCount,
      model: config.engine.embedding_model,
      dbPath,
      dbSizeBytes: stat.size,
      meta,
    },
    warnings,
  };
}
