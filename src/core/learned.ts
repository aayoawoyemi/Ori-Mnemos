/**
 * Export and restore the part of the index that markdown does not contain.
 *
 * The README used to say everything under `.ori/` is derived and disposable.
 * That is false. Measured on a real 1,548-note vault, `rm -rf .ori/ && ori
 * index build` destroys:
 *
 *   retrieval_log       15,892 rows spanning six months and 564 sessions
 *   co_occurrence       16,076 usage-derived edges (the 'retrieval' source)
 *   note_q               1,427 learned Q-values
 *   stage_q                  8 live LinUCB arms — the policy choosing stages
 *   note_access          1,065 rows, every one with flushed_count = 0
 *   boosts               1,839 Ebbinghaus access rows
 *   q_history_genuine      896 rows preserved through the 2026-08-28 reset,
 *                            which no production code can recreate
 *
 * None of that is in the markdown and no rebuild path reconstructs it. This
 * module is what makes the disposability claim true instead of aspirational:
 * export first, then the binary index really is throwaway.
 *
 * Every accumulated table keys on a TEXT identifier — note_id, slug, title,
 * stage_id, note_a/note_b — never on an integer rowid. That is load-bearing.
 * Rowids are reassigned by a rebuild, so a rowid-keyed export would restore
 * onto the wrong notes and look perfectly plausible while doing it.
 *
 * Format is NDJSON, deterministically ordered, so git stores diffs rather
 * than whole copies and a human can read what changed.
 */
import type Database from "better-sqlite3";

export const LEARNED_FORMAT_VERSION = 1;

/** A table that accumulates, plus the ordering that makes its export stable. */
interface LearnedTable {
  name: string;
  /** Columns to carry. Autoincrement `id` is deliberately dropped: it is a
   *  local row number, not an identity, and preserving it would collide on
   *  import into a non-empty index. */
  columns: string[];
  orderBy: string;
  /** Rows that are regenerable are excluded rather than exported. */
  where?: string;
  /**
   * DDL, for the two tables that no production code creates.
   *
   * Import normally refuses to create tables — the owning module should
   * define its own schema, and inventing one here would let the two drift.
   * But `q_history_genuine` is created only by scripts/reset-learning.mjs
   * (a one-shot archive of pre-reset reward rows) and `memory_events` is
   * created by nothing at all. After a rebuild they simply do not exist, so
   * without DDL here their rows are unrestorable and the round-trip is lossy
   * by exactly 902 rows. For these two, this module IS the owning module.
   */
  ddl?: string;
}

export const LEARNED_TABLES: LearnedTable[] = [
  {
    name: "note_q",
    columns: ["note_id", "q_value", "update_count", "exposure_count", "reward_sum", "reward_sq_sum", "last_updated", "last_reward", "created"],
    orderBy: "note_id",
  },
  {
    name: "q_history",
    columns: ["note_id", "old_q", "new_q", "reward", "reward_source", "session_id", "timestamp"],
    orderBy: "timestamp, note_id",
  },
  {
    name: "q_history_genuine",
    columns: ["note_id", "old_q", "new_q", "reward", "reward_source", "session_id", "timestamp"],
    orderBy: "timestamp, note_id",
    ddl:
      "CREATE TABLE IF NOT EXISTS q_history_genuine (id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "note_id TEXT NOT NULL, old_q REAL, new_q REAL, reward REAL, reward_source TEXT, " +
      "session_id TEXT, timestamp TEXT)",
  },
  {
    name: "retrieval_log",
    columns: ["session_id", "query_text", "query_type", "note_id", "rank", "similarity_score", "q_score", "ucb_bonus", "final_score", "timestamp"],
    orderBy: "timestamp, session_id, rank",
  },
  {
    name: "stage_q",
    columns: ["stage_id", "a_matrix", "b_vector", "sample_count", "total_reward", "last_updated"],
    orderBy: "stage_id",
  },
  {
    name: "stage_log",
    columns: ["session_id", "stage_id", "query_features", "decision", "quality_before", "quality_after", "compute_time_ms", "reward", "timestamp"],
    orderBy: "timestamp, session_id, stage_id",
  },
  {
    name: "boosts",
    columns: ["title", "boost", "updated", "access_count", "sessions"],
    orderBy: "title",
  },
  {
    name: "note_access",
    columns: ["slug", "access_count", "last_accessed", "flushed_count"],
    orderBy: "slug",
  },
  {
    name: "memory_events",
    columns: ["event_type", "event_id", "session_id", "query_text", "timestamp", "payload"],
    orderBy: "timestamp, event_id",
    ddl:
      "CREATE TABLE IF NOT EXISTS memory_events (id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "event_type TEXT, event_id TEXT, session_id TEXT, query_text TEXT, timestamp TEXT, payload TEXT)",
  },
  {
    // 89% of this table is `bootstrap`, regenerated from wiki-links by
    // bootstrapFromWikiLinks on every index build. Exporting it would triple
    // the artifact to carry data the rebuild already produces. Only rows
    // carrying real usage signal are irreplaceable.
    name: "co_occurrence",
    columns: ["note_a", "note_b", "co_retrieval_count", "npmi_weight", "trust_weight", "first_observed", "last_co_retrieved", "source"],
    orderBy: "note_a, note_b",
    where: "source = 'retrieval' OR co_retrieval_count > 0",
  },
];

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

export interface LearnedExportStats {
  version: number;
  exported: Record<string, number>;
  total: number;
}

/**
 * Serialise accumulated state to NDJSON. Returns the text and per-table counts.
 * Missing tables are skipped rather than failing: an index built by an older
 * version legitimately lacks some of them.
 */
export function exportLearned(db: Database.Database): { ndjson: string; stats: LearnedExportStats } {
  const lines: string[] = [];
  const exported: Record<string, number> = {};
  let total = 0;

  lines.push(JSON.stringify({ _format: "ori-learned", version: LEARNED_FORMAT_VERSION, exported_at: new Date().toISOString() }));

  for (const t of LEARNED_TABLES) {
    if (!tableExists(db, t.name)) continue;
    const sql =
      `SELECT ${t.columns.map((c) => `"${c}"`).join(", ")} FROM "${t.name}"` +
      (t.where ? ` WHERE ${t.where}` : "") +
      ` ORDER BY ${t.orderBy}`;
    const rows = db.prepare(sql).all() as Record<string, unknown>[];
    for (const r of rows) lines.push(JSON.stringify({ _t: t.name, ...r }));
    exported[t.name] = rows.length;
    total += rows.length;
  }

  return { ndjson: lines.join("\n") + "\n", stats: { version: LEARNED_FORMAT_VERSION, exported, total } };
}

export interface LearnedImportStats {
  imported: Record<string, number>;
  skippedUnknownTable: number;
  /** Orphan tables this import had to create because nothing else does. */
  createdTables: string[];
  total: number;
}

/**
 * Restore accumulated state into an index. Idempotent: rows are written with
 * INSERT OR REPLACE against each table's natural key, so importing the same
 * file twice is a no-op rather than a duplication.
 *
 * The caller is expected to have run `ori index build` first, so the derived
 * tables exist. Tables absent from this index are counted and skipped, never
 * created — creating them here would fork the schema away from its owning
 * module.
 */
export function importLearned(db: Database.Database, ndjson: string): LearnedImportStats {
  const byName = new Map(LEARNED_TABLES.map((t) => [t.name, t]));
  const imported: Record<string, number> = {};
  let skippedUnknownTable = 0;
  const createdTables: string[] = [];
  let total = 0;

  const stmts = new Map<string, Database.Statement>();
  const run = db.transaction((lines: string[]) => {
    for (const line of lines) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as Record<string, unknown>;
      if (rec._format) continue; // header
      const name = rec._t as string;
      const t = byName.get(name);
      if (!t) {
        skippedUnknownTable++;
        continue;
      }
      if (!tableExists(db, name)) {
        // Only the orphan tables carry DDL. Everything else is owned by the
        // module that defines it, and a missing table there means the caller
        // skipped `ori index build`.
        if (!t.ddl) {
          skippedUnknownTable++;
          continue;
        }
        db.exec(t.ddl);
        createdTables.push(name);
      }
      let st = stmts.get(name);
      if (!st) {
        st = db.prepare(
          `INSERT OR REPLACE INTO "${name}" (${t.columns.map((c) => `"${c}"`).join(", ")}) ` +
            `VALUES (${t.columns.map((c) => `@${c}`).join(", ")})`,
        );
        stmts.set(name, st);
      }
      const params: Record<string, unknown> = {};
      for (const c of t.columns) params[c] = rec[c] ?? null;
      st.run(params);
      imported[name] = (imported[name] ?? 0) + 1;
      total++;
    }
  });

  run(ndjson.split(/\r?\n/));
  return { imported, skippedUnknownTable, createdTables, total };
}
