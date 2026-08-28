/**
 * Session reward accumulator and credit assignment.
 *
 * Tracks retrievals, adds, and updates within a session, then computes
 * per-note rewards at session end. This is the ONLY path that may write
 * Q-values (see qvalue.ts `updateQ`, and the guard in serve.ts).
 *
 * Reward signals (in priority order):
 *   forward citation +1.0 | update +0.5 | downstream creation +0.6
 *   within-session re-recall +0.4 | partial follow-up +0.1 | dead end -0.15
 *
 * ## Two production defects fixed 2026-08-28
 *
 * **1. Note keys were not canonical.** `buildOutcome` matched `[[link]]` text
 * against retrieved note ids using raw string equality. Wiki-links carry the
 * TITLE; retrieval logged a mix — measured on a live vault, `retrieval_log`
 * held 1,072 distinct ids of which 772 were slugs and 300 raw titles. So a
 * citation of a slug-keyed note never matched. Result: **forward citation, the
 * strongest signal in this file, fired 0 times in 5 months across 401
 * sessions.** Every id is now normalized through `slugify()` (src/core/slug.ts,
 * the same helper add.ts and graph.ts use — see issue #32 for why that helper
 * exists at all).
 *
 * **2. Exposure correction ran unconditionally.** `reward / exposure^0.5` is
 * the CIKM 2024 correction for exposure bias, and it assumes strong signals
 * arriving disproportionately to over-exposed items. While serve.ts was also
 * writing a uniform ~0.02 rank proxy on every query, there was no such signal
 * to correct — the divisor just crushed anything popular. Measured outcome:
 * pearson(exposure, Q) = -0.537, i.e. the more a note was used the lower its
 * learned value, with `index` (104 exposures) at Q=0.0165 while never-retrieved
 * test fixtures sat at the 0.5 initialization ceiling.
 *
 * The proxy is gone, so the correction is meaningful again — but it is now
 * damped (EXPOSURE_BETA 0.5 -> 0.25) and floored, so it can no longer drive a
 * genuinely useful note toward zero. A note cited 200 times should rank high;
 * it should not be punished for being the answer.
 */

import type Database from "better-sqlite3";
import { getExposureCount } from "./qvalue.js";
import { slugify } from "./slug.js";

/**
 * Exposure-correction exponent. Lowered from 0.5 on 2026-08-28.
 *
 * At 0.5 a note with 300 exposures divides its reward by 17.3, which turned a
 * full +1.0 forward citation into +0.058 — below the noise floor of the rank
 * proxy that was running at the time. At 0.25 the same note divides by 4.16:
 * still a real correction for popularity bias, no longer an erasure.
 */
const EXPOSURE_BETA = 0.25;

/**
 * Floor on the exposure divisor's effect. Even an extremely over-exposed note
 * retains 20% of its earned reward, so a strong repeated signal can still
 * accumulate. Without a floor the correction is unbounded in exposure and any
 * sufficiently central note is guaranteed to decay to zero.
 */
const MIN_EXPOSURE_RETENTION = 0.2;

export interface RetrievalEvent {
  noteId: string;
  rank: number;
  queryText: string;
  queryType: string;
}

export interface SessionOutcome {
  forwardCitations: string[];
  updatedNotes: string[];
  createdNotes: string[];
  reRecalledNotes: string[];
}

/** Diagnostic breakdown of one session's credit assignment. */
export interface RewardBreakdown {
  noteId: string;
  reward: number;
  signal:
    | "forward_citation"
    | "update"
    | "downstream_creation"
    | "re_recall"
    | "partial_follow_up"
    | "dead_end"
    | "neutral";
  bestRank: number;
  exposure: number;
  rawReward: number;
}

export class SessionRewardAccumulator {
  private retrievals: RetrievalEvent[] = [];
  private addedContent: string[] = [];
  private updatedNoteIds: string[] = [];
  private createdNoteIds: string[] = [];
  private lastBreakdown: RewardBreakdown[] = [];
  readonly sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  logRetrieval(
    noteId: string,
    rank: number,
    queryText: string,
    queryType: string,
  ): void {
    this.retrievals.push({ noteId: slugify(noteId), rank, queryText, queryType });
  }

  logAdd(noteId: string, content: string): void {
    this.createdNoteIds.push(slugify(noteId));
    this.addedContent.push(content);
  }

  logUpdate(noteId: string): void {
    this.updatedNoteIds.push(slugify(noteId));
  }

  /**
   * Credit every retrieved note for this session.
   *
   * Signals are checked in strength order and the first match wins — a cited
   * note is not additionally penalized for anything else. `bestRank` is the
   * shallowest rank the note ever reached, so a note that appeared at rank 0
   * once and rank 7 twice is credited on the rank the agent most likely read.
   */
  computeRewards(db: Database.Database): Map<string, number> {
    const outcome = this.buildOutcome();
    const credits = new Map<string, number>();
    const breakdown: RewardBreakdown[] = [];
    const seen = new Map<string, number[]>();

    for (const r of this.retrievals) {
      const ranks = seen.get(r.noteId) ?? [];
      ranks.push(r.rank);
      seen.set(r.noteId, ranks);
    }

    for (const [noteId, ranks] of seen) {
      const bestRank = Math.min(...ranks);
      let reward: number;
      let signal: RewardBreakdown["signal"];

      if (outcome.forwardCitations.includes(noteId)) {
        reward = 1.0;
        signal = "forward_citation";
      } else if (outcome.updatedNotes.includes(noteId)) {
        reward = 0.5;
        signal = "update";
      } else if (outcome.createdNotes.length > 0) {
        reward = 0.6 * (1 / Math.log2(bestRank + 2));
        signal = "downstream_creation";
      } else if (ranks.length > 1) {
        reward = 0.4 * (1 / ranks.length);
        signal = "re_recall";
      } else if (
        outcome.forwardCitations.length > 0 ||
        outcome.updatedNotes.length > 0
      ) {
        reward = 0.1 / Math.log2(bestRank + 2);
        signal = "partial_follow_up";
      } else if (bestRank <= 2) {
        // IPS-debiased dead end: only the top 3 are assumed to have been read,
        // so only they can be blamed for not being useful.
        reward = -0.15 / Math.pow(bestRank + 1, 1.0);
        signal = "dead_end";
      } else {
        reward = 0;
        signal = "neutral";
      }

      const rawReward = reward;
      const exposure = getExposureCount(db, noteId);

      // Exposure correction, damped and floored. Penalties are exempt: dividing
      // a dead-end penalty by exposure would make popular notes progressively
      // harder to demote, which is the same rich-get-richer trap in reverse.
      if (exposure > 1 && reward > 0) {
        const divisor = Math.pow(exposure, EXPOSURE_BETA);
        const retained = Math.max(1 / divisor, MIN_EXPOSURE_RETENTION);
        reward = reward * retained;
      }

      const finalReward = Math.max(-1, Math.min(1, reward));
      credits.set(noteId, finalReward);
      breakdown.push({
        noteId,
        reward: finalReward,
        signal,
        bestRank,
        exposure,
        rawReward,
      });
    }

    this.lastBreakdown = breakdown;
    return credits;
  }

  /**
   * Per-signal counts from the last `computeRewards` call.
   *
   * Exists so the zero-forward-citation failure is observable instead of
   * silent: if `forward_citation` is 0 across many sessions with non-empty
   * `ori_add` traffic, key normalization has regressed again.
   */
  getSignalCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const b of this.lastBreakdown) {
      counts[b.signal] = (counts[b.signal] ?? 0) + 1;
    }
    return counts;
  }

  getBreakdown(): RewardBreakdown[] {
    return this.lastBreakdown;
  }

  /**
   * Resolve session outcomes into canonical note ids.
   *
   * Both sides of the citation match are slugified: the link text as written
   * in the note body, and the retrieved ids (already slugified on ingest by
   * `logRetrieval`). This is the fix for the 0-citations-in-5-months defect.
   */
  private buildOutcome(): SessionOutcome {
    const retrievedIds = new Set(this.retrievals.map((r) => r.noteId));
    const forwardCitations: string[] = [];

    for (const content of this.addedContent) {
      const links = content.match(/\[\[([^\]]+)\]\]/g) ?? [];
      for (const link of links) {
        // Strip [[ ]], then any |alias and #heading suffix before slugifying —
        // Obsidian-style links are common in this vault and would otherwise
        // never match.
        const inner = link.slice(2, -2);
        const target = inner.split("|")[0]!.split("#")[0]!.trim();
        const slug = slugify(target);
        if (retrievedIds.has(slug)) {
          forwardCitations.push(slug);
        }
      }
    }

    return {
      forwardCitations: [...new Set(forwardCitations)],
      updatedNotes: [...new Set(this.updatedNoteIds)],
      createdNotes: [...new Set(this.createdNoteIds)],
      reRecalledNotes: [],
    };
  }

  hasData(): boolean {
    return this.retrievals.length > 0;
  }
}

export { EXPOSURE_BETA, MIN_EXPOSURE_RETENTION };
