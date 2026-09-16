import path from "node:path";
import { promises as fs } from "node:fs";
import { findVaultRoot, getVaultPaths, listNoteTitles } from "../core/vault.js";
import {
  initIndexStore, syncIndex, graphFingerprint, saveCachedGraphMetrics,
} from "../core/indexstore.js";
import { buildGraph } from "../core/graph.js";
import { buildNoteIndex } from "../core/noteindex.js";
import { computeGraphMetrics } from "../core/importance.js";
import { initCoOccurrenceTables, bootstrapFromWikiLinks } from "../core/cooccurrence.js";
import { loadConfig } from "../core/config.js";
import { buildIndex, initDB } from "../core/engine.js";
import type { IndexStats } from "../core/engine.js";

export type DerivedIndexStats = {
  scanned: number;
  reparsed: number;
  removed: number;
  edges: number;
  dangling: number;
};

export type IndexBuildResult = {
  success: boolean;
  data: IndexStats & { derived?: DerivedIndexStats };
  warnings: string[];
};

export type IndexStatusResult = {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
};

/**
 * Rebuild everything derived from the vault, in one place.
 *
 * Three derived stores exist, and until 2026-09-15 this command touched one:
 *
 *   1. Embeddings (`embeddings`)  - ONNX vectors, incremental by content hash.
 *      The only store a query does NOT maintain: a new note has no vector
 *      until this runs, so it is invisible to the semantic signal and visible
 *      to keyword and graph. Fix-list item 26.
 *   2. Derived index (`note`, `edge`, `note_term`, graph-metrics cache) -
 *      synced by every query, stat-filtered. Never needs this command for an
 *      edit. `--force` drops it so every note is reparsed, which is the repair
 *      for an index that reports it cannot cover the vault.
 *   3. Co-occurrence bootstrap (`co_occurrence`) - bibliographic coupling from
 *      wiki-links. The MCP `ori_index_build` ran it and the CLI never did, so
 *      the same command built different graphs depending on the door. Now
 *      both call this.
 *
 * The derived index is rebuilt from SQL-backed reads of itself after the sync,
 * so a full rebuild is one vault pass, not three.
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

  const dbPath = path.resolve(vaultRoot, config.engine.db_path);
  const db = initDB(dbPath);
  let derived: DerivedIndexStats | undefined;
  try {
    initIndexStore(db);
    if (force) {
      // CASCADE clears note_term, edge, dangling_link and graph_metric, and
      // resets the stat filter so the sync below reparses every note.
      db.exec("DELETE FROM note");
    }
    const sync = await syncIndex(db, paths.notes);
    derived = {
      scanned: sync.scanned, reparsed: sync.reparsed, removed: sync.removed,
      edges: sync.edges, dangling: sync.dangling,
    };

    const titles = await listNoteTitles(paths.notes);
    const graph = await buildGraph(paths.notes, db);
    const noteIndex = await buildNoteIndex(paths.notes, titles, db);
    saveCachedGraphMetrics(db, graphFingerprint(db), computeGraphMetrics(graph, noteIndex));

    initCoOccurrenceTables(db);
    bootstrapFromWikiLinks(db, graph.outgoing);
  } catch (err: unknown) {
    warnings.push(
      `Derived index rebuild failed; queries will fall back to per-query scans: ${
        err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    db.close();
  }

  return {
    success: true,
    data: { ...stats, ...(derived ? { derived } : {}) },
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
