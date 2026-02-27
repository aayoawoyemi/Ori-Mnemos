/**
 * Score-weighted RRF fusion and top-level retrieval orchestrator.
 * Combines composite, keyword, and graph signal results into a
 * single ranked list using Reciprocal Rank Fusion variants.
 */

import type { ScoredNote } from "./ranking.js";
import type { RetrievalConfig } from "./config.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SignalResults {
  composite: ScoredNote[];
  keyword: ScoredNote[];
  graph: ScoredNote[];
}

type SignalName = keyof SignalResults;

const SIGNAL_NAMES: readonly SignalName[] = ["composite", "keyword", "graph"] as const;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

interface RankEntry {
  rank: number;
  score: number;
  note: ScoredNote;
}

/** Build a title -> { rank, score, note } lookup for a single signal. */
function buildIndex(notes: ScoredNote[]): Map<string, RankEntry> {
  const map = new Map<string, RankEntry>();
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    map.set(n.title, { rank: i, score: n.score, note: n });
  }
  return map;
}

/* ------------------------------------------------------------------ */
/*  Score-weighted RRF                                                 */
/* ------------------------------------------------------------------ */

/**
 * Fuse multiple signal result lists using score-weighted RRF.
 *
 * For each unique note across all signals:
 *   score = Sum_s( signal_weight_s * raw_score_s / (k + rank_s + 1) )
 *
 * Returns all notes sorted by fused score descending.
 */
export function fuseScoreWeightedRRF(
  signals: SignalResults,
  config: RetrievalConfig,
): ScoredNote[] {
  const k = config.rrf_k;
  const weights = config.signal_weights;

  // Build per-signal indexes
  const indexes: Record<SignalName, Map<string, RankEntry>> = {
    composite: buildIndex(signals.composite),
    keyword: buildIndex(signals.keyword),
    graph: buildIndex(signals.graph),
  };

  // Collect unique titles
  const titles = new Set<string>();
  for (const name of SIGNAL_NAMES) {
    for (const entry of signals[name]) {
      titles.add(entry.title);
    }
  }

  // Fuse
  const results: ScoredNote[] = [];

  const titleArray = Array.from(titles);
  for (let ti = 0; ti < titleArray.length; ti++) {
    const title = titleArray[ti];
    let fusedScore = 0;
    const signalScores: {
      composite?: number;
      keyword?: number;
      graph?: number;
      rrf?: number;
    } = {};

    // Merge metadata and spaces from whichever signal provides them
    let metadata: Record<string, unknown> | undefined;
    let spaces: ScoredNote["spaces"] | undefined;

    for (const name of SIGNAL_NAMES) {
      const entry = indexes[name].get(title);
      if (entry) {
        const w = weights[name];
        fusedScore += (w * entry.score) / (k + entry.rank + 1);
        signalScores[name] = entry.score;

        if (entry.note.metadata && !metadata) metadata = entry.note.metadata;
        if (entry.note.spaces && !spaces) spaces = entry.note.spaces;
      }
    }

    signalScores.rrf = fusedScore;

    const fused: ScoredNote = {
      title,
      score: fusedScore,
      signals: signalScores,
    };
    if (spaces) fused.spaces = spaces;
    if (metadata) fused.metadata = metadata;

    results.push(fused);
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/* ------------------------------------------------------------------ */
/*  Standard (non-score-weighted) RRF                                  */
/* ------------------------------------------------------------------ */

/**
 * Standard RRF fusion — rank-only, no score or signal weighting.
 *
 *   score = Sum_s( 1 / (k + rank_s + 1) )
 *
 * Useful as a baseline for benchmarking against score-weighted RRF.
 */
export function fuseSimpleRRF(
  signals: SignalResults,
  k: number,
): ScoredNote[] {
  // Build per-signal indexes
  const indexes: Record<SignalName, Map<string, RankEntry>> = {
    composite: buildIndex(signals.composite),
    keyword: buildIndex(signals.keyword),
    graph: buildIndex(signals.graph),
  };

  // Collect unique titles
  const titles = new Set<string>();
  for (const name of SIGNAL_NAMES) {
    for (const entry of signals[name]) {
      titles.add(entry.title);
    }
  }

  // Fuse
  const results: ScoredNote[] = [];

  const titleArray = Array.from(titles);
  for (let ti = 0; ti < titleArray.length; ti++) {
    const title = titleArray[ti];
    let fusedScore = 0;
    const signalScores: {
      composite?: number;
      keyword?: number;
      graph?: number;
      rrf?: number;
    } = {};

    let metadata: Record<string, unknown> | undefined;
    let spaces: ScoredNote["spaces"] | undefined;

    for (const name of SIGNAL_NAMES) {
      const entry = indexes[name].get(title);
      if (entry) {
        fusedScore += 1 / (k + entry.rank + 1);
        signalScores[name] = entry.score;

        if (entry.note.metadata && !metadata) metadata = entry.note.metadata;
        if (entry.note.spaces && !spaces) spaces = entry.note.spaces;
      }
    }

    signalScores.rrf = fusedScore;

    const fused: ScoredNote = {
      title,
      score: fusedScore,
      signals: signalScores,
    };
    if (spaces) fused.spaces = spaces;
    if (metadata) fused.metadata = metadata;

    results.push(fused);
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
