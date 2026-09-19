/**
 * Quality snapshot tracker for stage meta-learning.
 *
 * Records ranking quality before/after each stage and the compute time spent,
 * so the LinUCB stage learner can decide whether a stage earns its cost.
 *
 * ## Why quality is rank-based, not score-based (2026-08-28)
 *
 * The original `measureCurrentQuality` returned the mean of the top-5 raw
 * scores. That is only meaningful when before and after live on the same
 * scale — and in `search.ts` most stages cross scales:
 *
 *   rrf_fusion:       cosine composite (~2.0)  ->  RRF scores (~1/60)
 *   pagerank:         cosine composite (~2.0)  ->  PageRank mass (~1e-3)
 *   cooccurrence_ppr: cosine composite (~2.0)  ->  PPR mass (~1e-3)
 *
 * `computeStageReward` then took `delta * 10` clamped to [-1, 1], so those
 * stages scored exactly -1.0 on every single call. Measured in production:
 * rrf_fusion had total_reward = -1850.0 across 1850 samples (a constant, not a
 * measurement); pagerank and cooccurrence_ppr flatlined at -1.0/sample and were
 * suppressed from 2026-04-02 onward. Only gravity/hub dampening looked sane,
 * and only because those two stages compare the same variable to itself.
 *
 * The fix measures what a ranking stage is actually for: did it change the
 * order in a way that concentrated mass at the top? Both sides are normalized
 * to a distribution first, so a stage is never punished for the units it
 * emits. See `measureCurrentQuality` for the formula and for a note on the
 * min-max version that was tried and rejected the same day.
 */

// Same tokenizer BM25 uses, deliberately. If the quality metric counted
// different terms than the stage it is judging, its recall number would be
// measuring a vocabulary mismatch instead of a retrieval failure. `tokenize`
// is also the reason "Resume J" has a "j" term at all - single-character
// tokens survive only when they look like an identifier (bm25.ts, 2026-09-06).
import { tokenize } from "./bm25.js";

export interface StageSnapshot {
  stageId: string;
  qualityBefore: number;
  startTime: number;
}

export interface StageResult {
  stageId: string;
  qualityBefore: number;
  qualityAfter: number;
  computeMs: number;
}

export class StageTracker {
  private snapshots: Map<string, StageSnapshot> = new Map();
  private results: StageResult[] = [];

  before(stageId: string, currentQuality: number): void {
    this.snapshots.set(stageId, {
      stageId,
      qualityBefore: currentQuality,
      startTime: performance.now(),
    });
  }

  after(stageId: string, currentQuality: number): void {
    const snap = this.snapshots.get(stageId);
    if (!snap) return;
    this.results.push({
      stageId,
      qualityBefore: snap.qualityBefore,
      qualityAfter: currentQuality,
      computeMs: performance.now() - snap.startTime,
    });
    this.snapshots.delete(stageId);
  }

  getResults(): StageResult[] {
    return this.results;
  }

  hasResults(): boolean {
    return this.results.length > 0;
  }

  /** Drain results for per-query processing and reset for the next query. */
  drain(): StageResult[] {
    const drained = this.results;
    this.results = [];
    return drained;
  }
}

/** Candidates considered when measuring quality. Deeper tails add noise. */
const QUALITY_WINDOW = 10;

/**
 * Scale-invariant ranking quality of a candidate set, in [-1, 1].
 *
 * Measures **mass concentration at the top**: scores are turned into a
 * probability distribution (shift-to-non-negative, then divide by the sum),
 * weighted by an nDCG-style log-rank discount, and expressed relative to a
 * uniform baseline. Sum-normalization is what makes this scale-free — scaling
 * every score by any positive constant leaves the distribution unchanged, so a
 * stage emitting RRF scores near 1/60 is judged identically to one emitting
 * cosine scores near 2.0.
 *
 *   0  = uniform, no ordering information
 *   1  = all mass on the top result
 *   <0 = mass concentrated at the BOTTOM (an actively bad ordering)
 *
 * Anchoring to the uniform baseline rather than to the raw weighted sum also
 * makes the measure independent of window size, which matters because
 * before/after snapshots in search.ts often have different lengths.
 *
 * An earlier attempt (2026-08-28, same day) used min-max normalization and was
 * wrong in a way worth recording: min-max pins the first element to 1 and the
 * last to 0 regardless of spread, so it only sees the shape *between* the pins.
 * A nearly-flat set [1.0, 0.99, 0.98, 0.97] became a clean linear ramp and
 * scored 0.62, while a genuinely peaked [1.0, 0.2, 0.1, 0.05] scored 0.44 —
 * the metric ranked flat above peaked, exactly backwards. Caught by
 * tests/core/learning-signal-integrity.test.ts before it shipped.
 */
export function measureConcentration(
  candidates: { score: number }[],
): number {
  const window = candidates.slice(0, QUALITY_WINDOW);
  const n = window.length;
  if (n === 0) return 0;

  // A single candidate carries no ordering information. Returning 0 rather
  // than 1 also removes the incentive for a stage to score well by discarding
  // everything but its top hit.
  if (n === 1) return 0;

  // Shift to non-negative before normalizing: phaseB emits z-scored values, so
  // negative scores are normal and would otherwise corrupt the distribution.
  const scores = window.map((c) => c.score);
  const min = Math.min(...scores);
  const shifted = min < 0 ? scores.map((s) => s - min) : scores;
  const total = shifted.reduce((a, b) => a + b, 0);

  // Degenerate: every score identical (or all zero after shifting). No ordering
  // signal exists, so the stage is neither rewarded nor punished.
  if (total < 1e-12) return 0;

  const discounts: number[] = [];
  for (let i = 0; i < n; i++) discounts.push(1 / Math.log2(i + 2));
  const discountSum = discounts.reduce((a, b) => a + b, 0);

  // Weighted mass under the discount, versus what a uniform distribution would
  // score. Ideal is 1.0 (all mass at rank 0, discount 1).
  let weighted = 0;
  for (let i = 0; i < n; i++) weighted += (shifted[i]! / total) * discounts[i]!;
  const uniform = discountSum / n;

  const quality = (weighted - uniform) / (1 - uniform);
  return Math.max(-1, Math.min(1, quality));
}

// --- Exact-identifier recall (fix list item 6, 2026-09-15) ---

/**
 * Rarity gate for a query term, as a fraction of the corpus.
 *
 * A term appearing in more than 1% of notes is a topic word: semantic search
 * finds those, and missing one is not a recall failure worth punishing. Below
 * the gate the term behaves like an identifier - a name, a code, a title
 * fragment - and is exactly what BM25 exists to retrieve.
 */
export const RARE_DF_FRACTION = 0.01;

/**
 * Absolute floor on the rarity gate, so small vaults still have a rare band.
 * At 1% a 161-note vault would gate at df <= 1, making almost nothing count.
 */
export const RARE_DF_FLOOR = 8;

/**
 * Share of the quality signal owned by exact-identifier recall.
 *
 * Deliberately a convex blend, not an extra additive term: the result stays in
 * [-1, 1], stays scale-invariant, and a probe-less call returns EXACTLY the
 * concentration number this metric has always returned, so `stage_q` history
 * written before 2026-09-15 remains comparable and needs no rescaling.
 *
 * At 0.25 a set that finds every rare term is 0.5 above one that finds none
 * (the lexical term spans [-1, 1]), which is large enough to flip the sign of a
 * noise-floor result - `"Resume J"` at concentration 0.005 now measures -0.246
 * instead of +0.005 - and small enough that concentration still dominates when
 * both sets recall the same identifiers.
 */
export const LEXICAL_WEIGHT = 0.25;

/**
 * Corpus knowledge needed to judge exact-identifier recall.
 *
 * `documentFrequency` is a lookup, not a scan: the caller owns the index and
 * answers in microseconds. Nothing in this module reads the vault - the metric
 * runs on the query path and must not re-add the per-query full-corpus read
 * that tier 2 exists to remove.
 */
export interface LexicalProbe {
  /** The user's query, verbatim. */
  query: string;
  /** Notes containing this lowercased term. 0 means absent from the corpus. */
  documentFrequency: (term: string) => number;
  /** Notes in the corpus, for the rarity gate. */
  corpusSize: number;
  /**
   * Titles of the notes whose indexed text contains this term.
   *
   * Recall is a question about note CONTENT, and the ranking pipeline passes
   * `ScoredNote`, which carries a title and no body. So for the entire life of
   * this metric the answer came from matching rare terms against titles alone:
   * a note that contained an identifier in its body was scored as having
   * missed it. The postings table already knows the answer, so the metric asks
   * the corpus instead of asking the candidates to carry text they do not have.
   *
   * Optional. Omitted, recall falls back to whatever text the candidates
   * supply, which is the pre-2026-09-19 behaviour.
   */
  notesContainingTerm?: (term: string) => ReadonlySet<string>;
}

/** A candidate as seen by the quality metric. Text is optional and lexical-only. */
export interface QualityCandidate {
  score: number;
  title?: string;
  text?: string;
}

/**
 * Query terms that are rare AND present in the corpus.
 *
 * Both halves matter. `df <= gate` is what makes a term an identifier rather
 * than a topic word. `df >= 1` is what keeps the signal fair: a result set
 * cannot be punished for failing to return something the vault does not
 * contain, which would turn every unanswerable query into a stage penalty.
 */
export function rareQueryTerms(probe: LexicalProbe): string[] {
  const gate = Math.max(
    RARE_DF_FLOOR,
    Math.floor(probe.corpusSize * RARE_DF_FRACTION),
  );
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const term of tokenize(probe.query)) {
    if (seen.has(term)) continue;
    seen.add(term);
    const df = probe.documentFrequency(term);
    if (df >= 1 && df <= gate) terms.push(term);
  }
  return terms;
}

/**
 * Fraction of the rare terms the candidate window actually recalled.
 *
 * A term counts as recalled when some candidate in the window is a note whose
 * indexed text contains it. `postings` answers that from the corpus; without
 * it the only evidence available is whatever text the candidates carry, which
 * on the ranking path is the title and nothing else.
 *
 * Returns 1 for an empty term list so callers that blend it unconditionally
 * cannot be penalized by a query with no identifiers in it.
 */
export function measureExactRecall(
  candidates: QualityCandidate[],
  terms: string[],
  postings?: (term: string) => ReadonlySet<string>,
): number {
  if (terms.length === 0) return 1;

  const window = candidates.slice(0, QUALITY_WINDOW);
  const found = new Set<string>();

  if (postings) {
    const titles = new Set(
      window.map((c) => c.title ?? "").filter((t) => t.length > 0),
    );
    for (const term of terms) {
      for (const holder of postings(term)) {
        if (titles.has(holder)) {
          found.add(term);
          break;
        }
      }
    }
    if (found.size === terms.length) return 1;
  }

  // Any term the postings could not settle - and every term, when there are no
  // postings - falls back to the text the candidates carry.
  for (const c of window) {
    if (found.size === terms.length) break;
    const text = `${c.title ?? ""} ${c.text ?? ""}`;
    if (text.trim().length === 0) continue;
    const tokens = new Set(tokenize(text));
    for (const t of terms) if (tokens.has(t)) found.add(t);
  }

  return found.size / terms.length;
}

/**
 * Ranking quality of a candidate set, in [-1, 1].
 *
 * Without a `probe` this is `measureConcentration` verbatim - the scale-free
 * top-heaviness measure described above, unchanged since 2026-08-28.
 *
 * With a probe it additionally sees **exact-identifier recall**, which the
 * metric was structurally blind to before 2026-09-15. That blindness was
 * provable rather than suspected: `bm25` carried the worst total reward in the
 * table (-21.38 over 74 samples) while being marked `essential` precisely
 * because dropping it had already been observed to destroy recall for names,
 * codes, and titles. Both facts can only hold at once if the reward function
 * cannot see the thing BM25 contributes. Concentration is a measure of ORDER;
 * it is identical whether or not the right note is in the set at all, so a
 * lexical stage that pulls a literal identifier into the window from nowhere
 * scored zero for it - and paid the cost penalty.
 *
 * The two components are blended convexly (see LEXICAL_WEIGHT), so the output
 * range, the scale-invariance, and the meaning of a historical `stage_q` row
 * are all preserved. Queries with no rare terms fall through to pure
 * concentration, so the blend only fires where it has something to say.
 */
export function measureCurrentQuality(
  candidates: QualityCandidate[],
  probe?: LexicalProbe,
): number {
  const concentration = measureConcentration(candidates);
  if (!probe) return concentration;

  const terms = rareQueryTerms(probe);
  if (terms.length === 0) return concentration;

  const recall = measureExactRecall(candidates, terms, probe.notesContainingTerm);
  const lexical = 2 * recall - 1;
  const blended =
    (1 - LEXICAL_WEIGHT) * concentration + LEXICAL_WEIGHT * lexical;
  return Math.max(-1, Math.min(1, blended));
}
