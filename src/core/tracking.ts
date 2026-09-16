/**
 * Access tracking (the IPS audit trail) and exploration injection.
 *
 * Logs which notes got surfaced for which queries, and injects exploration
 * candidates to counter popularity bias.
 *
 * The propensity estimators this module used to carry were deleted on
 * 2026-09-15: nothing in the repo ever called them, and the per-title one
 * was O(events x results per event), so wiring it in per note would have put
 * a quadratic on the query path. The logged `propensity` field is still
 * written (as 0 by `runQueryRanked`) so the on-disk log format is unchanged
 * and propensity stays computable post-hoc from the log.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type { QueryIntent } from "./intent.js";
import type { ScoredNote } from "./ranking.js";
import type { IPSConfig } from "./config.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface AccessEvent {
  timestamp: string;
  query: string;
  intent: QueryIntent;
  results: Array<{
    title: string;
    rank: number;
    score: number;
    propensity: number;
    wasExploration: boolean;
  }>;
}

/* ------------------------------------------------------------------ */
/*  Log I/O                                                            */
/* ------------------------------------------------------------------ */

/**
 * Append an access event as a single JSON line to the log file.
 * Creates parent directories if they don't exist.
 */
export async function logAccess(
  vaultRoot: string,
  event: AccessEvent,
  config: IPSConfig,
): Promise<void> {
  const logFile = path.resolve(vaultRoot, config.log_path);
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.appendFile(logFile, JSON.stringify(event) + "\n", "utf-8");
}

/* ------------------------------------------------------------------ */
/*  Exploration Injection                                              */
/* ------------------------------------------------------------------ */

/**
 * Replace the bottom `budget` fraction of results with random notes
 * not already in results. Injected notes are marked with
 * `metadata.wasExploration = true`.
 *
 * Returns a new array; the original is not modified.
 *
 * Selection is O(k) expected, where k = replaceCount (typically 1). The
 * previous implementation copied every candidate title into a fresh array
 * and Fisher-Yates shuffled all of it — ~1,500 swaps and two N-sized
 * allocations on a 1,524-note vault — then threw away all but the first
 * entry. Here the common case draws random indices straight out of
 * `allNotes` and rejects the ones already on the page, so nothing
 * proportional to N is allocated or swapped.
 *
 * `allNotes` is a list of distinct note titles (`listNoteTitles` reads one
 * flat directory, so the filesystem guarantees uniqueness). Should a
 * duplicate ever arrive, `taken` still keeps it out of the output: no title
 * is injected twice under any input.
 */
export function injectExploration(
  results: ScoredNote[],
  allNotes: string[],
  budget: number,
): ScoredNote[] {
  if (budget <= 0 || results.length === 0) {
    return [...results];
  }

  const replaceCount = Math.max(1, Math.floor(results.length * budget));
  const existingTitles = new Set(results.map((r) => r.title));
  const picks = selectCandidates(allNotes, existingTitles, replaceCount);

  // Build output: keep the top portion, replace the tail
  const keepCount = results.length - replaceCount;
  const output: ScoredNote[] = results.slice(0, keepCount);

  for (const title of picks) {
    output.push({
      title,
      score: 0,
      signals: {},
      metadata: { wasExploration: true },
    });
  }

  // If we didn't have enough candidates, pad with remaining originals
  if (picks.length < replaceCount) {
    const deficit = replaceCount - picks.length;
    output.push(...results.slice(keepCount, keepCount + deficit));
  }

  return output;
}

/**
 * Draw up to `want` distinct titles from `allNotes`, skipping `exclude`,
 * uniformly at random and in uniformly random order.
 *
 * Fast path: rejection sampling on indices. Every draw is a uniform index,
 * blocked and already-drawn titles are rejected, so the result is a uniform
 * sample without replacement — and it never inspects, copies, or swaps the
 * N - k titles it does not need.
 *
 * A draw fails only when it lands on an excluded or already-taken title, so
 * on any real page (a few dozen results against hundreds or thousands of
 * notes) success probability per draw is > 0.99 and `4 * want + 16` attempts
 * overshoot by orders of magnitude. The attempt cap exists because a vault
 * where nearly every note is already on the page has too few candidates to
 * hit by chance — that case, and only that case, falls through to a scan.
 */
function selectCandidates(
  allNotes: string[],
  exclude: Set<string>,
  want: number,
): string[] {
  const n = allNotes.length;
  if (n === 0 || want <= 0) return [];

  const picks: string[] = [];
  const taken = new Set<string>();
  const attemptCap = 4 * want + 16;

  for (let attempt = 0; attempt < attemptCap && picks.length < want; attempt++) {
    const title = allNotes[Math.floor(Math.random() * n)]!;
    if (exclude.has(title) || taken.has(title)) continue;
    taken.add(title);
    picks.push(title);
  }
  if (picks.length === want) return picks;

  // Candidates are too scarce to find by chance. Enumerate them once and
  // take a partial Fisher-Yates prefix, which touches `want` positions
  // rather than all of them. The partial draws above are discarded so this
  // stays an unconditionally uniform sample rather than a biased top-up.
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const title of allNotes) {
    if (exclude.has(title) || seen.has(title)) continue;
    seen.add(title);
    candidates.push(title);
  }

  const limit = Math.min(want, candidates.length);
  const chosen: string[] = [];
  for (let i = 0; i < limit; i++) {
    const j = i + Math.floor(Math.random() * (candidates.length - i));
    const swap = candidates[i]!;
    candidates[i] = candidates[j]!;
    candidates[j] = swap;
    chosen.push(candidates[i]!);
  }
  return chosen;
}
