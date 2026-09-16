/**
 * Co-occurrence edge storage, NPMI computation, Ebbinghaus decay,
 * Turrigiano homeostasis, and bibliographic coupling bootstrap.
 * Layer 2 of retrieval intelligence — organic graph growth from usage.
 *
 * "Neurons that fire together wire together."
 *
 * Research: NPMI normalization, GloVe frequency scaling (Pennington),
 * Ebbinghaus retention curve, Turrigiano synaptic scaling,
 * bibliographic coupling (Kessler), Dempster-Shafer trust.
 */

import type Database from "better-sqlite3";

// Constants
const GLOVE_XMAX = 100;
const GLOVE_ALPHA = 0.75;
const EBBINGHAUS_BASE_DAYS = 30;
const STRENGTH_RATE = 0.2;
const DECAY_FLOOR = 0.05;
const HOMEOSTASIS_TARGET = 0.5;
const BOOTSTRAP_BCS_THRESHOLD = 0.1;
const BOOTSTRAP_INIT_WEIGHT = 0.15;

/**
 * Maximum number of notes that may link to one target before that target stops
 * contributing coupling evidence in `bootstrapFromWikiLinks`.
 *
 * MEASURED, not guessed. Real vault (<vault>, 1537 notes with
 * outgoing entries, 6850 links, 900 distinct targets) poster-list sizes:
 *
 *   1016  "index"           (a real note every note links to)
 *    882  "relevant-map"    (DANGLING - an unfilled note-template placeholder)
 *    853  "related-note"    (DANGLING - an unfilled note-template placeholder)
 *    462  "ai agents map"
 *     65  <- next largest, then a long tail; p50 = 2
 *
 * Those four targets hold 98.8% of all within-target pair work. Uncapped
 * inversion costs 1,392,115 pair-visits, which is WORSE than the 1,180,416
 * ordered pairs the old all-pairs loop examined. At this cap: 18,105
 * pair-visits, 12,403 distinct pairs - 77x less work, and 896 of 900 targets
 * (99.6%) are untouched.
 *
 * The cap is also what makes the function scale. Work is bounded by
 * sum over targets of C(k,2) with k <= CAP, which is at most
 * links * CAP / 2 - linear in link count, not quadratic in note count.
 *
 * Semantically this is stopword pruning: a target reachable from 8% of the
 * vault (128/1537) is uniform noise, and two of the four real offenders are
 * literal template placeholders that were never filled in. The cap only ever
 * removes shared-target evidence; note degrees (the BCS denominator) are
 * unchanged, so capped output is a subset of uncapped output with weights that
 * are less than or equal. It never invents an edge.
 */
const BOOTSTRAP_HUB_POSTER_CAP = 128;

// --- Schema ---

export function initCoOccurrenceTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS co_occurrence (
      note_a TEXT NOT NULL,
      note_b TEXT NOT NULL,
      co_retrieval_count INTEGER NOT NULL DEFAULT 1,
      npmi_weight REAL,
      trust_weight REAL NOT NULL DEFAULT 1.0,
      first_observed TEXT NOT NULL DEFAULT (datetime('now')),
      last_co_retrieved TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL DEFAULT 'retrieval',
      PRIMARY KEY (note_a, note_b)
    );
    CREATE INDEX IF NOT EXISTS idx_cooc_a ON co_occurrence(note_a);
    CREATE INDEX IF NOT EXISTS idx_cooc_b ON co_occurrence(note_b);
  `);
}

// --- NPMI ---

export function computeNPMI(
  countAB: number,
  countA: number,
  countB: number,
  totalEvents: number,
): number {
  if (countAB === 0 || totalEvents === 0) return -1;
  const pAB = countAB / totalEvents;
  const pA = countA / totalEvents;
  const pB = countB / totalEvents;
  if (pA === 0 || pB === 0) return -1;
  const pmi = Math.log(pAB / (pA * pB));
  const denom = -Math.log(pAB);
  return denom === 0 ? 0 : pmi / denom;
}

// --- GloVe frequency weight ---

export function gloveWeight(count: number): number {
  return count < GLOVE_XMAX
    ? Math.pow(count / GLOVE_XMAX, GLOVE_ALPHA)
    : 1.0;
}

// --- Ebbinghaus decay with strength accumulation ---

export function edgeDecay(
  daysSince: number,
  coRetrievalCount: number,
): number {
  const strength = 1 + STRENGTH_RATE * Math.log1p(coRetrievalCount);
  const retention = Math.exp(-daysSince / (EBBINGHAUS_BASE_DAYS * strength));
  return Math.max(DECAY_FLOOR, retention);
}

// --- Composite edge weight ---

export function computeEdgeWeight(
  coRetrievalCount: number,
  totalRetrievalsA: number,
  totalRetrievalsB: number,
  totalEvents: number,
  daysSince: number,
  trustWeight: number = 1.0,
): number {
  const npmi = computeNPMI(
    coRetrievalCount,
    totalRetrievalsA,
    totalRetrievalsB,
    totalEvents,
  );
  const freq = gloveWeight(coRetrievalCount);
  const decay = edgeDecay(daysSince, coRetrievalCount);
  return Math.max(0, npmi * freq * trustWeight * decay);
}

// --- Record co-retrieval ---

export function recordCoRetrieval(
  db: Database.Database,
  noteA: string,
  noteB: string,
  trustWeight: number = 1.0,
): void {
  // Consistent ordering so (A,B) == (B,A)
  const [a, b] = noteA < noteB ? [noteA, noteB] : [noteB, noteA];

  db.prepare(
    `
    INSERT INTO co_occurrence (note_a, note_b, co_retrieval_count, trust_weight, source)
    VALUES (?, ?, 1, ?, 'retrieval')
    ON CONFLICT(note_a, note_b) DO UPDATE SET
      co_retrieval_count = co_retrieval_count + 1,
      last_co_retrieved = datetime('now')
  `,
  ).run(a, b, trustWeight);
}

// --- Extract pairs from session retrievals ---

export function extractCoOccurrencePairs(
  db: Database.Database,
  sessionId: string,
): void {
  const rows = db
    .prepare(
      `
    SELECT query_text, GROUP_CONCAT(note_id) as notes
    FROM retrieval_log
    WHERE session_id = ?
    GROUP BY query_text
  `,
    )
    .all(sessionId) as { query_text: string; notes: string }[];

  for (const row of rows) {
    const notes = row.notes.split(",");
    for (let i = 0; i < notes.length; i++) {
      for (let j = i + 1; j < notes.length; j++) {
        recordCoRetrieval(db, notes[i], notes[j]);
      }
    }
  }
}

// --- Per-node homeostasis (Turrigiano) ---
// Updates both note_a and note_b edges per node (original spec only covered note_a)

export function runHomeostasis(db: Database.Database): void {
  // Collect per-node mean weights across ALL their edges (both directions)
  const nodeStats = db
    .prepare(
      `
    SELECT node, AVG(w) as mean_w FROM (
      SELECT note_a as node, npmi_weight as w FROM co_occurrence WHERE npmi_weight IS NOT NULL
      UNION ALL
      SELECT note_b as node, npmi_weight as w FROM co_occurrence WHERE npmi_weight IS NOT NULL
    )
    GROUP BY node
  `,
    )
    .all() as { node: string; mean_w: number }[];

  const tx = db.transaction(() => {
    for (const { node, mean_w } of nodeStats) {
      if (mean_w === 0 || mean_w === HOMEOSTASIS_TARGET) continue;
      const scale = HOMEOSTASIS_TARGET / mean_w;

      // Scale edges where this node is note_a
      db.prepare(
        `
        UPDATE co_occurrence SET npmi_weight = npmi_weight * ?
        WHERE note_a = ? AND npmi_weight IS NOT NULL
      `,
      ).run(scale, node);

      // Scale edges where this node is note_b
      db.prepare(
        `
        UPDATE co_occurrence SET npmi_weight = npmi_weight * ?
        WHERE note_b = ? AND npmi_weight IS NOT NULL
      `,
      ).run(scale, node);
    }
  });
  tx();
}

// --- Recompute all NPMI weights ---
// Uses actual daysSince from last_co_retrieved instead of hardcoded 0

export function recomputeAllNPMI(db: Database.Database): void {
  const totalEvents = (
    db
      .prepare(
        "SELECT COUNT(DISTINCT session_id || '|' || query_text) as n FROM retrieval_log",
      )
      .get() as { n: number }
  ).n;

  if (totalEvents === 0) return;

  const edges = db
    .prepare(
      "SELECT note_a, note_b, co_retrieval_count, last_co_retrieved FROM co_occurrence",
    )
    .all() as {
    note_a: string;
    note_b: string;
    co_retrieval_count: number;
    last_co_retrieved: string;
  }[];

  // Count per-note retrievals
  const noteCounts = new Map<string, number>();
  const rows = db
    .prepare(
      "SELECT note_id, COUNT(*) as cnt FROM retrieval_log GROUP BY note_id",
    )
    .all() as { note_id: string; cnt: number }[];
  for (const r of rows) noteCounts.set(r.note_id, r.cnt);

  const now = Date.now();
  const tx = db.transaction(() => {
    for (const edge of edges) {
      const countA = noteCounts.get(edge.note_a) ?? 0;
      const countB = noteCounts.get(edge.note_b) ?? 0;
      const daysSince =
        (now - new Date(edge.last_co_retrieved).getTime()) / 86_400_000;
      const weight = computeEdgeWeight(
        edge.co_retrieval_count,
        countA,
        countB,
        totalEvents,
        daysSince,
      );
      db.prepare(
        "UPDATE co_occurrence SET npmi_weight = ? WHERE note_a = ? AND note_b = ?",
      ).run(weight, edge.note_a, edge.note_b);
    }
  });
  tx();
}

// --- Bootstrap from wiki-links (bibliographic coupling) ---

/**
 * Seed day-0 co-occurrence edges from wiki-link structure using bibliographic
 * coupling: two notes are coupled by how many link targets they share,
 * normalised by the geometric mean of their out-degrees.
 *
 *   bcs(A,B) = |links(A) INTERSECT links(B)| / sqrt(|links(A)| * |links(B)|)
 *
 * Target-inverted accumulation, NOT all-pairs. The previous implementation
 * compared every ordered pair of notes and intersected their link sets:
 * 1,160,526 pairs examined to write 29,898 rows at 1524 notes, so 97.4% of the
 * work was discarded, and it recompiled the INSERT once per surviving pair.
 * Two notes can only share a target if some target lists both of them, so only
 * pairs that genuinely co-occur are ever materialised here.
 *
 * Pair keys are packed integers (i * n + j) over the sorted note array rather
 * than concatenated slugs: no per-pair string allocation, and the ordering
 * i < j is inherited from the sorted iteration, so note_a < note_b holds
 * exactly as `recordCoRetrieval` expects.
 *
 * See BOOTSTRAP_HUB_POSTER_CAP for the one deliberate divergence from the old
 * all-pairs result, and why the measured vault forces it.
 */
export function bootstrapFromWikiLinks(
  db: Database.Database,
  noteLinks: Map<string, Set<string>>,
): void {
  const notes = [...noteLinks.keys()].sort(); // sorted for consistent ordering
  const n = notes.length;
  if (n < 2) return;

  // Out-degrees by index, so the BCS denominator costs no Map lookups.
  const degree = new Array<number>(n);
  for (let i = 0; i < n; i++) degree[i] = noteLinks.get(notes[i])!.size;

  // 1. Invert noteLinks into target -> ascending indices of notes linking to it.
  //    Ascending because `notes` is iterated in sorted order.
  const posters = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    for (const target of noteLinks.get(notes[i])!) {
      const list = posters.get(target);
      if (list === undefined) posters.set(target, [i]);
      else list.push(i);
    }
  }

  // 2. Accumulate a shared-target count per co-occurring pair.
  const shared = new Map<number, number>();
  for (const list of posters.values()) {
    const size = list.length;
    // A target with one poster couples nothing; a hub target couples everything
    // and therefore distinguishes nothing.
    if (size < 2 || size > BOOTSTRAP_HUB_POSTER_CAP) continue;
    for (let x = 0; x < size; x++) {
      const base = list[x] * n;
      for (let y = x + 1; y < size; y++) {
        const key = base + list[y];
        const prev = shared.get(key);
        shared.set(key, prev === undefined ? 1 : prev + 1);
      }
    }
  }
  if (shared.size === 0) return;

  // 3. Threshold and insert. Prepared once, not once per qualifying pair.
  const insert = db.prepare(`
    INSERT OR IGNORE INTO co_occurrence
      (note_a, note_b, co_retrieval_count, npmi_weight, source)
    VALUES (?, ?, 0, ?, 'bootstrap')
  `);
  const tx = db.transaction(() => {
    for (const [key, count] of shared) {
      const i = (key - (key % n)) / n;
      const j = key % n;
      const bcs = count / Math.sqrt(degree[i] * degree[j]);
      if (bcs < BOOTSTRAP_BCS_THRESHOLD) continue;
      // notes[i] < notes[j] by sort order — consistent with recordCoRetrieval
      insert.run(notes[i], notes[j], bcs * BOOTSTRAP_INIT_WEIGHT);
    }
  });
  tx();
}

// Re-export constants for tests
export {
  GLOVE_XMAX,
  GLOVE_ALPHA,
  EBBINGHAUS_BASE_DAYS,
  STRENGTH_RATE,
  DECAY_FLOOR,
  HOMEOSTASIS_TARGET,
  BOOTSTRAP_BCS_THRESHOLD,
  BOOTSTRAP_INIT_WEIGHT,
  BOOTSTRAP_HUB_POSTER_CAP,
};
