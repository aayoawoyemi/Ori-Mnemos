/**
 * IPS (Inverse Propensity Scoring) access tracking and exploration injection.
 *
 * Tracks which notes get surfaced for which queries, computes propensity
 * scores, and injects exploration candidates to counter popularity bias.
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

/**
 * Read the JSONL log file and parse all events.
 * Returns empty array if the file doesn't exist.
 * Skips malformed lines with a console warning.
 */
export async function loadAccessLog(
  vaultRoot: string,
  config: IPSConfig,
): Promise<AccessEvent[]> {
  const logFile = path.resolve(vaultRoot, config.log_path);

  let raw: string;
  try {
    raw = await fs.readFile(logFile, "utf-8");
  } catch {
    return [];
  }

  const events: AccessEvent[] = [];
  const lines = raw.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed) as AccessEvent);
    } catch {
      console.warn(`[tracking] skipping malformed line: ${trimmed.slice(0, 80)}`);
    }
  }

  return events;
}

/* ------------------------------------------------------------------ */
/*  Propensity                                                         */
/* ------------------------------------------------------------------ */

/**
 * Compute propensity for a single note title.
 *
 * propensity = times_surfaced / total_queries, floored at epsilon.
 * If the note never appeared in any event, returns epsilon.
 */
export function computePropensity(
  title: string,
  events: AccessEvent[],
  epsilon: number,
): number {
  if (events.length === 0) return epsilon;

  let surfaced = 0;
  for (const event of events) {
    if (event.results.some((r) => r.title === title)) {
      surfaced++;
    }
  }

  if (surfaced === 0) return epsilon;
  return Math.max(surfaced / events.length, epsilon);
}

/**
 * Build propensity scores for all notes.
 *
 * For each note: propensity = times it appeared in any event's results / total events.
 * Floored at epsilon.
 */
export function buildPropensityMap(
  events: AccessEvent[],
  allNotes: string[],
  epsilon: number,
): Map<string, number> {
  const map = new Map<string, number>();
  const total = events.length;

  if (total === 0) {
    for (const note of allNotes) {
      map.set(note, epsilon);
    }
    return map;
  }

  // Count appearances per title across all events
  const counts = new Map<string, number>();
  for (const event of events) {
    for (const result of event.results) {
      counts.set(result.title, (counts.get(result.title) || 0) + 1);
    }
  }

  for (const note of allNotes) {
    const surfaced = counts.get(note) ?? 0;
    map.set(note, Math.max(surfaced / total, epsilon));
  }

  return map;
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

  // Candidates: notes not already in results
  const candidates = allNotes.filter((n) => !existingTitles.has(n));

  // Shuffle candidates (Fisher-Yates) and pick up to replaceCount
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const picks = shuffled.slice(0, replaceCount);

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
