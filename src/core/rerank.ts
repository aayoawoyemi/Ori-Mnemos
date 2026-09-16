/**
 * Phase B Q-value reranking.
 * Takes the top-k1 candidates from RRF fusion (Phase A) and reranks
 * them using a lambda blend of similarity score and learned Q-value,
 * plus UCB-Tuned exploration bonus, with cumulative bias cap.
 *
 * Research: MemRL two-phase, Drift invariants, CIKM 2024 exposure bias
 */

import type Database from "better-sqlite3";
import type { ScoredNote } from "./ranking.js";
import {
  getDecayedQ,
  getRewardStats,
  getTotalQUpdates,
  getTotalQueryCount,
  explorationBonus,
  incrementExposure,
  logRetrieval,
  applyColdStartFloor,
  type ColdStartOptions,
} from "./qvalue.js";

// Constants
const LAMBDA_MIN = 0.15;
const LAMBDA_MAX = 0.50;
const LAMBDA_MATURITY = 200;
const MAX_CUMULATIVE_BIAS = 3.0;
const EXCESS_COMPRESSION = 0.3;
const K2 = 8;

const QUERY_TYPE_SHIFTS: Record<string, number> = {
  semantic: -0.10,
  procedural: 0.15,
  decision: 0.05,
  episodic: 0.0,
};

// --- Z-score normalization ---

export function zNormalize(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const std =
    Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  return values.map((v) => (v - mean) / std);
}

// --- Lambda ---

export function computeLambda(
  totalQUpdates: number,
  queryType: string,
): number {
  const base =
    LAMBDA_MIN +
    (LAMBDA_MAX - LAMBDA_MIN) *
      Math.min(totalQUpdates / LAMBDA_MATURITY, 1.0);
  const shift = QUERY_TYPE_SHIFTS[queryType] ?? 0;
  return Math.max(0.1, Math.min(0.6, base + shift));
}

// --- Phase B ---

export function phaseB(
  db: Database.Database,
  candidates: ScoredNote[],
  queryText: string,
  queryType: string,
  sessionId: string,
  coldStart: ColdStartOptions = {},
): ScoredNote[] {
  if (candidates.length === 0) return [];

  const totalUpdates = getTotalQUpdates(db);
  const totalQueries = getTotalQueryCount(db);
  const lambda = computeLambda(totalUpdates, queryType);

  // Get raw scores
  const simRaw = candidates.map((c) => c.score);
  const qRaw = candidates.map((c) => getDecayedQ(db, c.title));

  // Z-score normalize both (CRITICAL — without this lambda is meaningless)
  const simNorm = zNormalize(simRaw);
  const qNorm = zNormalize(qRaw);

  const results = candidates.map((c, i) => {
    // Lambda blend
    const blended = (1 - lambda) * simNorm[i] + lambda * qNorm[i];

    // UCB-Tuned exploration bonus
    const stats = getRewardStats(db, c.title);
    const ucb = explorationBonus(stats, totalQueries);

    // Raw Phase B score
    let score = blended + ucb;

    // Cumulative bias cap (Drift invariant — prevents runaway boosts)
    const maxAllowed = c.score * MAX_CUMULATIVE_BIAS;
    if (score > maxAllowed) {
      score = maxAllowed + (score - maxAllowed) * EXCESS_COMPRESSION;
    }

    return {
      ...c,
      score,
      _phaseB: { simNorm: simNorm[i], qNorm: qNorm[i], ucb, lambda },
    };
  });

  // Sort, then let the cold-start floor claim one slot before the cut. It must
  // run on the FULL ranked list: applied after `slice`, every never-surfaced
  // note has already been discarded and the floor can only reorder notes that
  // were going to be returned anyway. This is the same ordering lesson as
  // docs/stage-bandit-starvation.md - the recovery mechanism goes above the
  // cutoff, not below it.
  results.sort((a, b) => b.score - a.score);
  const topK = applyColdStartFloor(db, results, K2, coldStart);

  // Exposure counts what an agent was actually shown, not what was considered.
  // Before 2026-09-15 this incremented for every candidate, which made
  // `exposure_count = 0` unreachable for anything that ever reached phaseB and
  // left the cold-start floor with nothing to find. It also overstated the
  // exposure divisor in reward.ts for notes that were never returned.
  for (let rank = 0; rank < topK.length; rank++) {
    const r = topK[rank];
    incrementExposure(db, r.title);
    logRetrieval(
      db,
      sessionId,
      queryText,
      queryType,
      r.title,
      rank,
      r._phaseB.simNorm,
      r._phaseB.qNorm,
      r._phaseB.ucb,
      r.score,
    );
  }

  // Strip internal debug data before returning
  return topK.map(({ _phaseB, ...rest }) => rest) as ScoredNote[];
}

// Re-export constants for tests
export {
  LAMBDA_MIN,
  LAMBDA_MAX,
  LAMBDA_MATURITY,
  MAX_CUMULATIVE_BIAS,
  EXCESS_COMPRESSION,
  K2,
};
