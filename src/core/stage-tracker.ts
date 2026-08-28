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
export function measureCurrentQuality(
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
