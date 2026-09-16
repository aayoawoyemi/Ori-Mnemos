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

/**
 * Exposure damping exponent for the exploration bonus (fix list item 8).
 * At 0.35 a note shown 10 times keeps 46% of its bonus and one shown 100 times
 * keeps 20% - a real gradient toward cold notes without erasing the bonus for
 * anything popular.
 */
const EXPLORE_EXPOSURE_BETA = 0.35;

/**
 * Floor on that damping. An over-exposed note still carries some exploration
 * bonus, so the term can never become a hard exclusion: the same reason the
 * stage bandit keeps an epsilon floor (see docs/stage-bandit-starvation.md).
 */
const MIN_EXPLORE_RETENTION = 0.15;

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
    .prepare(
      "SELECT q_value, update_count, last_updated FROM note_q WHERE note_id = ?",
    )
    .get(noteId) as
    | { q_value: number; update_count: number; last_updated: string }
    | undefined;

  // No row, or a row created by `incrementExposure` and never rewarded: there
  // is no learned value to decay. Decaying the initialisation constant made
  // `q_reranking` order notes by when exposure happened to create their row,
  // which is noise wearing a learned score's clothes.
  if (!row || row.update_count === 0) return DEFAULT_Q;

  return applyDecay(row.q_value, row.last_updated);
}

/** Q-informed time decay: high-Q notes decay slower, low-Q notes faster. */
function applyDecay(qValue: number, lastUpdated: string): number {
  const daysSince =
    (Date.now() - parseSqlTimestamp(lastUpdated)) / 86_400_000;

  let mult = 1.0;
  if (qValue >= 0.7) mult = 0.7;
  else if (qValue <= 0.3) mult = 1.3;

  return qValue * Math.exp(-DECAY_RATE * mult * daysSince);
}

/**
 * Milliseconds for a SQLite `datetime('now')` string, which is UTC and carries
 * no zone marker.
 *
 * `new Date("2026-09-15 16:22:39")` is parsed as LOCAL time, so west of UTC
 * every freshly written row looked like it was stamped in the future:
 * `daysSince` went negative and the decay became a small GROWTH, inflating
 * un-decayed values by the size of the UTC offset. Harmless at a 99-day
 * half-life, not harmless when the comparison being made is between two notes
 * that have learned nothing.
 */
function parseSqlTimestamp(value: string): number {
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return new Date(iso).getTime();
}

/**
 * A Q-value together with the provenance that says whether it means anything.
 *
 * `learned === false` means the value is the initialisation constant, not a
 * score: either the note has no row at all, or it has one written by
 * `incrementExposure` and never touched by a reward. Fix-list item 5 measured
 * 707 of 717 production rows in that state while every consumer read them
 * through `getQ` and could not tell them apart from a converged 0.5.
 */
export interface QState {
  noteId: string;
  q: number;
  decayedQ: number;
  updateCount: number;
  exposureCount: number;
  learned: boolean;
  lastUpdated: string | null;
}

/**
 * Full Q state for a note, in one query.
 *
 * Use this instead of `getQ`/`getDecayedQ` wherever the difference between
 * "no signal yet" and "learned, and it landed near the default" changes what
 * the caller should do - reranking weight, confidence reporting, health.
 */
export function getQState(db: Database.Database, noteId: string): QState {
  const id = slugify(noteId);
  const row = db
    .prepare(
      `SELECT q_value, update_count, exposure_count, last_updated
       FROM note_q WHERE note_id = ?`,
    )
    .get(id) as
    | {
        q_value: number;
        update_count: number;
        exposure_count: number;
        last_updated: string;
      }
    | undefined;

  if (!row) {
    return {
      noteId: id,
      q: DEFAULT_Q,
      decayedQ: DEFAULT_Q,
      updateCount: 0,
      exposureCount: 0,
      learned: false,
      lastUpdated: null,
    };
  }

  const learned = row.update_count > 0;
  return {
    noteId: id,
    q: row.q_value,
    // An un-updated row has no meaningful `last_updated` to decay from: it was
    // stamped when exposure created the row. Decaying it would manufacture a
    // difference between two notes that have both learned nothing.
    decayedQ: learned ? applyDecay(row.q_value, row.last_updated) : DEFAULT_Q,
    updateCount: row.update_count,
    exposureCount: row.exposure_count,
    learned,
    lastUpdated: row.last_updated,
  };
}

/**
 * Reward statistics for UCB, plus the two facts that say what they are worth.
 *
 * `learned` distinguishes "never rewarded" from "rewarded, converged near the
 * default" - see `getQState`. `exposure` rides along because the caller that
 * needs UCB also needs it (`explorationBonus` damps by it) and it is the same
 * row: one query, not two.
 */
export function getRewardStats(
  db: Database.Database,
  noteId: string,
): {
  mean: number;
  variance: number;
  count: number;
  exposure: number;
  learned: boolean;
} {
  noteId = slugify(noteId);
  const row = db
    .prepare(
      `SELECT update_count, reward_sum, reward_sq_sum, exposure_count
       FROM note_q WHERE note_id = ?`,
    )
    .get(noteId) as
    | {
        update_count: number;
        reward_sum: number;
        reward_sq_sum: number;
        exposure_count: number;
      }
    | undefined;

  if (!row || row.update_count === 0)
    return {
      mean: 0,
      variance: 0.25,
      count: 0,
      exposure: row?.exposure_count ?? 0,
      learned: false,
    };

  const mean = row.reward_sum / row.update_count;
  const variance = row.reward_sq_sum / row.update_count - mean * mean;
  return {
    mean,
    variance: Math.max(0, variance),
    count: row.update_count,
    exposure: row.exposure_count,
    learned: true,
  };
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

/**
 * Exposure damping factor for the exploration bonus, in [MIN_EXPLORE_RETENTION, 1].
 *
 * Monotonically decreasing in exposure and floored, never zero. A note nobody
 * has seen keeps its whole bonus; one shown 100 times keeps a fifth of it.
 */
export function exposureDamping(exposure: number): number {
  if (exposure <= 0) return 1;
  return Math.max(
    Math.pow(1 + exposure, -EXPLORE_EXPOSURE_BETA),
    MIN_EXPLORE_RETENTION,
  );
}

/**
 * UCB-Tuned exploration bonus, damped by how often the note was already shown.
 *
 * ## Why exposure enters here (fix list item 8, 2026-09-15)
 *
 * Measured on the live vault: the top 50 notes held 47.2% of all exposure and
 * ~280 of 1,423 notes had never been surfaced once. The cause is visible in
 * the old one-line form of this function. With 707 of 717 rows at
 * `update_count = 0`, `count === 0` held for nearly every candidate, so nearly
 * every candidate received exactly the same `c * 2.5`. A constant added to
 * every score is not exploration - it cancels in the ranking, leaving
 * similarity alone to decide, and similarity is what concentrated exposure in
 * the first place.
 *
 * Damping restores the differential that constant destroyed. It is
 * deterministic and monotone in exposure, and there is no early return above
 * it that could preempt it: the 2026-09-12 stage starvation bug was precisely
 * a short-circuit evaluated before the mechanism that guarantees recovery.
 *
 * `stats.exposure` is optional. Omitted means "no exposure information", damps
 * nothing, and reproduces the previous value exactly.
 */
export function explorationBonus(
  stats: {
    mean: number;
    variance: number;
    count: number;
    exposure?: number;
  },
  totalQueries: number,
  c: number = 0.2,
): number {
  const damp = exposureDamping(stats.exposure ?? 0);
  if (stats.count === 0) return c * 2.5 * damp;
  const logT = Math.log(totalQueries + 1);
  const V = stats.variance + Math.sqrt((2 * logT) / stats.count);
  return c * Math.sqrt((logT / stats.count) * Math.min(0.25, V)) * damp;
}

/**
 * Probability that one returned slot is handed to a never-surfaced note.
 *
 * The exploration bonus alone cannot fix exposure bias, and the arithmetic
 * says why: `phaseB` blends z-scored similarity at weight (1 - lambda) >= 0.5,
 * and a z-normalized candidate list spans roughly three standard deviations,
 * so the largest bonus this module can emit (c * 2.5 = 0.5) moves a note about
 * two ranks. A note that never enters the window cannot be promoted out of it.
 * Measured consequence: ~280 of 1,423 notes had never been surfaced once while
 * the top 50 held 47.2% of all exposure.
 *
 * 0.1 gives a cold note a slot in one query out of ten - the same escape-hatch
 * argument as the stage bandit's EPSILON, at the same order of magnitude
 * (docs/stage-bandit-starvation.md), and it costs one of eight returned slots
 * when it fires.
 */
export const COLD_START_EPSILON = 0.1;

export interface ColdStartOptions {
  epsilon?: number;
  /** Injectable for tests; a stochastic path with an unpinned RNG is a flake. */
  random?: () => number;
}

/**
 * Hand one of the top-`k` slots to the best never-surfaced candidate, epsilon
 * of the time.
 *
 * "Never surfaced" means no `note_q` row or `exposure_count = 0` - the note has
 * never been shown to an agent, so nothing about it has ever been learned and
 * ranking it on its Q-value ranks the initialisation constant.
 *
 * The epsilon draw happens FIRST, before any early exit. That ordering is the
 * whole lesson of the 2026-09-12 stage starvation bug, where a budget
 * short-circuit sat above the epsilon check and six stages stayed dark for six
 * days: the mechanism that guarantees recovery must not be reachable only when
 * some other condition happens to allow it. Here it also keeps RNG consumption
 * independent of the candidate list, so a caller's random stream does not
 * change shape with vault size.
 *
 * Returns the top-`k` slice, with at most one substitution. Never grows the
 * list and never reorders anything else.
 */
export function applyColdStartFloor<T extends { title: string }>(
  db: Database.Database,
  ranked: T[],
  k: number,
  opts: ColdStartOptions = {},
): T[] {
  const { epsilon = COLD_START_EPSILON, random = Math.random } = opts;
  const fires = random() < epsilon;

  if (k <= 0) return [];
  const top = ranked.slice(0, k);
  if (!fires || ranked.length <= k) return top;

  // Candidates that did not make the cut, in rank order: the first cold one is
  // the strongest note nobody has seen.
  const below = ranked.slice(k);
  const ids = below.map((c) => slugify(c.title));
  const placeholders = ids.map(() => "?").join(",");
  const surfaced = new Set(
    (
      db
        .prepare(
          `SELECT note_id FROM note_q
           WHERE exposure_count > 0 AND note_id IN (${placeholders})`,
        )
        .all(...ids) as { note_id: string }[]
    ).map((r) => r.note_id),
  );

  const coldIndex = ids.findIndex((id) => !surfaced.has(id));
  if (coldIndex < 0) return top;

  // Costs the weakest kept slot, never the head of the list.
  top[k - 1] = below[coldIndex]!;
  return top;
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
 * *what kind* of reward was accumulating. These numbers would have made it
 * obvious within a week:
 *
 *   - `bySource` — a per-query source dominating session_batch is the alarm.
 *   - `forwardCitations` — 0 over many sessions means key matching is broken.
 *   - `exposureQCorrelation` — should be >= 0. Negative means the system is
 *     punishing use, which is the degenerate-loop signature.
 *   - `distinctKeyShapes` — >1 means slug/title drift has returned.
 *
 * The last three were added 2026-09-15 for fix-list item 5, which was invisible
 * for the opposite reason: nothing counted the rows where learning had *not*
 * happened. Production held 717 tracked notes, 707 of them never updated, and
 * every summary in the system reported only the 10 that were.
 *
 *   - `neverUpdated` — rows sitting at the initialisation constant.
 *   - `exposedButNeverUpdated` — shown to an agent, never credited. A large
 *     value means retrieval is running and the session flush is not.
 *   - `neverExposed` — tracked but never surfaced; the exposure-bias tail.
 */
export function getLearningHealth(db: Database.Database): {
  bySource: Record<string, number>;
  forwardCitations: number;
  exposureQCorrelation: number;
  distinctKeyShapes: number;
  totalUpdates: number;
  trackedNotes: number;
  neverUpdated: number;
  exposedButNeverUpdated: number;
  neverExposed: number;
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

  // Signal-absence counters. One pass, so this stays cheap on large vaults.
  const coverage = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN update_count = 0 THEN 1 ELSE 0 END) never_updated,
              SUM(CASE WHEN update_count = 0 AND exposure_count > 0 THEN 1 ELSE 0 END) exposed_unlearned,
              SUM(CASE WHEN exposure_count = 0 THEN 1 ELSE 0 END) never_exposed
       FROM note_q`,
    )
    .get() as Record<string, number>;

  return {
    bySource,
    forwardCitations: fc.n,
    exposureQCorrelation: corr,
    distinctKeyShapes: shapes.n,
    totalUpdates: getTotalQUpdates(db),
    trackedNotes: coverage.total ?? 0,
    neverUpdated: coverage.never_updated ?? 0,
    exposedButNeverUpdated: coverage.exposed_unlearned ?? 0,
    neverExposed: coverage.never_exposed ?? 0,
  };
}

// Re-export constants for tests
export {
  ALPHA,
  DEFAULT_Q,
  DECAY_RATE,
  EXPOSURE_BETA,
  ALLOWED_SOURCES,
  EXPLORE_EXPOSURE_BETA,
  MIN_EXPLORE_RETENTION,
};
