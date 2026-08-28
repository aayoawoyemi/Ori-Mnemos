/**
 * Q-value storage, update, decay, and exploration bonus.
 * Layer 1 of retrieval intelligence — learns which notes are useful
 * via exponential moving average Q-updates with UCB-Tuned exploration.
 *
 * Research: MemRL, Drift, Tempera, bandit theory (63-source synthesis)
 *
 * ## Two invariants, both added 2026-08-28 after a production postmortem
 *
 * **Canonical keys.** Every `noteId` crossing this module is normalized with
 * `slugify()`. Before this, `retrieval_log` on a live vault held 1,072 distinct
 * ids — 772 slugs and 300 raw titles — for what were often the same notes, so
 * Q-values were split across two spellings and citation matching in reward.ts
 * could never resolve. Normalizing at the storage boundary means callers may
 * pass either form.
 *
 * **Sourced writes.** `updateQ` requires an explicit `RewardSource`. It used to
 * hardcode `'session_batch'`, which made every row look like deliberate
 * session-end credit — including the 12,682 rows written by a per-query rank
 * proxy in serve.ts that drowned the real signal at 93.4% of all history.
 * `assertSessionFlush` additionally refuses non-session-end writes unless the
 * caller opts in explicitly, so the same mistake cannot be made silently again.
 */

import type Database from "better-sqlite3";
import { slugify } from "./slug.js";

// Constants
const ALPHA = 0.1;
const DEFAULT_Q = 0.5;
const DECAY_RATE = 0.007; // half-life ~99 days
const EXPOSURE_BETA = 0.5;

// --- Schema ---

export function initQValueTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS note_q (
      note_id TEXT PRIMARY KEY,
      q_value REAL NOT NULL DEFAULT 0.5,
      update_count INTEGER NOT NULL DEFAULT 0,
      exposure_count INTEGER NOT NULL DEFAULT 0,
      reward_sum REAL NOT NULL DEFAULT 0,
      reward_sq_sum REAL NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now')),
      last_reward REAL,
      created TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS q_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT NOT NULL,
      old_q REAL NOT NULL,
      new_q REAL NOT NULL,
      reward REAL NOT NULL,
      reward_source TEXT NOT NULL,
      session_id TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS retrieval_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      query_text TEXT NOT NULL,
      query_type TEXT,
      note_id TEXT NOT NULL,
      rank INTEGER NOT NULL,
      similarity_score REAL,
      q_score REAL,
      ucb_bonus REAL,
      final_score REAL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_q_history_note ON q_history(note_id);
    CREATE INDEX IF NOT EXISTS idx_retrieval_session ON retrieval_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_retrieval_note ON retrieval_log(note_id);
  `);
}

// --- Read ---

export function getQ(db: Database.Database, noteId: string): number {
  noteId = slugify(noteId);
  const row = db
    .prepare("SELECT q_value FROM note_q WHERE note_id = ?")
    .get(noteId) as { q_value: number } | undefined;
  return row?.q_value ?? DEFAULT_Q;
}

export function getDecayedQ(db: Database.Database, noteId: string): number {
  noteId = slugify(noteId);
  const row = db
    .prepare("SELECT q_value, last_updated FROM note_q WHERE note_id = ?")
    .get(noteId) as { q_value: number; last_updated: string } | undefined;

  if (!row) return DEFAULT_Q;

  const daysSince =
    (Date.now() - new Date(row.last_updated).getTime()) / 86_400_000;

  // Q-informed decay: high-Q notes decay slower
  let mult = 1.0;
  if (row.q_value >= 0.7) mult = 0.7;
  else if (row.q_value <= 0.3) mult = 1.3;

  return row.q_value * Math.exp(-DECAY_RATE * mult * daysSince);
}

export function getRewardStats(
  db: Database.Database,
  noteId: string,
): { mean: number; variance: number; count: number } {
  noteId = slugify(noteId);
  const row = db
    .prepare(
      "SELECT update_count, reward_sum, reward_sq_sum FROM note_q WHERE note_id = ?",
    )
    .get(noteId) as
    | { update_count: number; reward_sum: number; reward_sq_sum: number }
    | undefined;

  if (!row || row.update_count === 0)
    return { mean: 0, variance: 0.25, count: 0 };

  const mean = row.reward_sum / row.update_count;
  const variance = row.reward_sq_sum / row.update_count - mean * mean;
  return { mean, variance: Math.max(0, variance), count: row.update_count };
}

export function getExposureCount(
  db: Database.Database,
  noteId: string,
): number {
  noteId = slugify(noteId);
  const row = db
    .prepare("SELECT exposure_count FROM note_q WHERE note_id = ?")
    .get(noteId) as { exposure_count: number } | undefined;
  return row?.exposure_count ?? 0;
}

export function getTotalQUpdates(db: Database.Database): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(update_count), 0) as total FROM note_q")
    .get() as { total: number };
  return row.total;
}

export function getTotalQueryCount(db: Database.Database): number {
  const row = db
    .prepare(
      "SELECT COUNT(DISTINCT session_id || '|' || query_text) as total FROM retrieval_log",
    )
    .get() as { total: number };
  return row.total;
}

// --- Write ---

/**
 * Where a Q-update came from. Recorded on every `q_history` row so a future
 * audit can separate deliberate session-end credit from anything else without
 * reverse-engineering the reward values (which is how the 2026-08 proxy
 * contamination had to be diagnosed: by matching rewards against the formula
 * `0.05/log2(rank+2)` after the fact).
 */
export type RewardSource =
  | "session_batch"
  | "explore_conclude"
  | "manual"
  | "migration";

/**
 * Sources permitted to write Q-values in normal operation.
 *
 * Deliberately narrow. Per-query writes are what produced the degenerate
 * feedback loop — a note rewarded for appearing in results the ranker itself
 * produced. Adding a source here is a decision about the learning signal, not
 * a plumbing detail: it belongs in review, which is the point of the guard.
 */
const ALLOWED_SOURCES: ReadonlySet<RewardSource> = new Set<RewardSource>([
  "session_batch",
  "explore_conclude",
]);

/**
 * Update a note's Q-value by EMA and record the transition.
 *
 * @param source  Provenance of this update. Anything outside ALLOWED_SOURCES
 *                throws unless `allowUnsafe` is set, so a future per-query
 *                write fails loudly at the first call in development instead
 *                of quietly accumulating for five months.
 * @param allowUnsafe  Escape hatch for migrations and one-off repair scripts.
 */
export function updateQ(
  db: Database.Database,
  noteId: string,
  reward: number,
  sessionId: string,
  source: RewardSource = "session_batch",
  allowUnsafe = false,
): void {
  if (!allowUnsafe && !ALLOWED_SOURCES.has(source)) {
    throw new Error(
      `updateQ: refusing write from source '${source}'. Q-values may only be ` +
        `written at session end (session_batch) or on explore conclusion ` +
        `(explore_conclude). Per-query writes create a degenerate feedback ` +
        `loop — see notes/the-ori-q-value-proxy-reward-was-a-degenerate-` +
        `feedback-loop. Pass allowUnsafe=true only from a migration script.`,
    );
  }

  noteId = slugify(noteId);
  const oldQ = getQ(db, noteId);
  const newQ = oldQ + ALPHA * (reward - oldQ);

  db.prepare(
    `
    INSERT INTO note_q (note_id, q_value, update_count, reward_sum, reward_sq_sum, last_updated, last_reward)
    VALUES (?, ?, 1, ?, ?, datetime('now'), ?)
    ON CONFLICT(note_id) DO UPDATE SET
      q_value = ?,
      update_count = update_count + 1,
      reward_sum = reward_sum + ?,
      reward_sq_sum = reward_sq_sum + ?,
      last_updated = datetime('now'),
      last_reward = ?
  `,
  ).run(
    noteId,
    newQ,
    reward,
    reward * reward,
    reward,
    newQ,
    reward,
    reward * reward,
    reward,
  );

  db.prepare(
    `
    INSERT INTO q_history (note_id, old_q, new_q, reward, reward_source, session_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(noteId, oldQ, newQ, reward, source, sessionId);
}

export function incrementExposure(
  db: Database.Database,
  noteId: string,
): void {
  noteId = slugify(noteId);
  db.prepare(
    `
    INSERT INTO note_q (note_id, exposure_count)
    VALUES (?, 1)
    ON CONFLICT(note_id) DO UPDATE SET exposure_count = exposure_count + 1
  `,
  ).run(noteId);
}

export function logRetrieval(
  db: Database.Database,
  sessionId: string,
  queryText: string,
  queryType: string,
  noteId: string,
  rank: number,
  simScore: number,
  qScore: number,
  ucbBonus: number,
  finalScore: number,
): void {
  noteId = slugify(noteId);
  db.prepare(
    `
    INSERT INTO retrieval_log
      (session_id, query_text, query_type, note_id, rank,
       similarity_score, q_score, ucb_bonus, final_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    sessionId,
    queryText,
    queryType,
    noteId,
    rank,
    simScore,
    qScore,
    ucbBonus,
    finalScore,
  );
}

// --- Exploration: UCB-Tuned ---

export function explorationBonus(
  stats: { mean: number; variance: number; count: number },
  totalQueries: number,
  c: number = 0.2,
): number {
  if (stats.count === 0) return c * 2.5;
  const logT = Math.log(totalQueries + 1);
  const V = stats.variance + Math.sqrt((2 * logT) / stats.count);
  return c * Math.sqrt((logT / stats.count) * Math.min(0.25, V));
}

// --- Batch update ---

/**
 * Apply a session's worth of credit in one transaction.
 *
 * This is the sanctioned write path. `source` defaults to session_batch and is
 * forwarded to `updateQ`, which enforces ALLOWED_SOURCES — so a caller cannot
 * launder a per-query write through the batch helper.
 */
export function batchUpdateQ(
  db: Database.Database,
  rewards: Map<string, number>,
  sessionId: string,
  source: RewardSource = "session_batch",
): void {
  const tx = db.transaction(() => {
    for (const [noteId, reward] of rewards) {
      updateQ(db, noteId, reward, sessionId, source);
    }
  });
  tx();
}

/**
 * Health snapshot of the learning signal, for `ori_health` and for tests.
 *
 * The 2026-08 failure was invisible for five months because nothing summarized
 * *what kind* of reward was accumulating. These four numbers would have made it
 * obvious within a week:
 *
 *   - `bySource` — a per-query source dominating session_batch is the alarm.
 *   - `forwardCitations` — 0 over many sessions means key matching is broken.
 *   - `exposureQCorrelation` — should be >= 0. Negative means the system is
 *     punishing use, which is the degenerate-loop signature.
 *   - `distinctKeyShapes` — >1 means slug/title drift has returned.
 */
export function getLearningHealth(db: Database.Database): {
  bySource: Record<string, number>;
  forwardCitations: number;
  exposureQCorrelation: number;
  distinctKeyShapes: number;
  totalUpdates: number;
} {
  const bySource: Record<string, number> = {};
  const sourceRows = db
    .prepare("SELECT reward_source, COUNT(*) as n FROM q_history GROUP BY reward_source")
    .all() as { reward_source: string; n: number }[];
  for (const r of sourceRows) bySource[r.reward_source] = r.n;

  // A +1.0 reward is only ever a forward citation (reward.ts). Rounding guards
  // against float drift through the EMA.
  const fc = db
    .prepare("SELECT COUNT(*) as n FROM q_history WHERE ROUND(reward, 6) = 1.0")
    .get() as { n: number };

  // Pearson correlation between exposure and learned value. Computed in SQL to
  // avoid pulling the whole table into memory on large vaults.
  const stats = db
    .prepare(
      `SELECT COUNT(*) n, SUM(exposure_count) sx, SUM(q_value) sy,
              SUM(exposure_count * q_value) sxy,
              SUM(exposure_count * exposure_count) sxx,
              SUM(q_value * q_value) syy
       FROM note_q WHERE update_count > 0 AND exposure_count > 0`,
    )
    .get() as Record<string, number>;
  let corr = 0;
  if (stats.n > 1) {
    const num = stats.n * stats.sxy - stats.sx * stats.sy;
    const den = Math.sqrt(
      (stats.n * stats.sxx - stats.sx * stats.sx) *
        (stats.n * stats.syy - stats.sy * stats.sy),
    );
    corr = den === 0 ? 0 : num / den;
  }

  // Key shapes: slugs contain no spaces and no uppercase. Anything else means
  // a raw title leaked past slugify().
  const shapes = db
    .prepare(
      `SELECT COUNT(DISTINCT CASE WHEN note_id LIKE '% %' THEN 'title' ELSE 'slug' END) as n
       FROM note_q`,
    )
    .get() as { n: number };

  return {
    bySource,
    forwardCitations: fc.n,
    exposureQCorrelation: corr,
    distinctKeyShapes: shapes.n,
    totalUpdates: getTotalQUpdates(db),
  };
}

// Re-export constants for tests
export { ALPHA, DEFAULT_Q, DECAY_RATE, EXPOSURE_BETA, ALLOWED_SOURCES };
