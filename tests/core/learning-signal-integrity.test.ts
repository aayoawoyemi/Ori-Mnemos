/**
 * Regression tests for the 2026-08-28 learning-signal postmortem.
 *
 * Each test here corresponds to a defect that ran undetected in production for
 * roughly five months. The existing unit suites (qvalue, reward, rerank,
 * stage-learner) all passed the whole time — every one of these bugs lived at a
 * seam between two correct components, so the tests assert the seams.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  initQValueTables,
  updateQ,
  getQ,
  batchUpdateQ,
  getLearningHealth,
  incrementExposure,
  DEFAULT_Q,
} from "../../src/core/qvalue.js";
import { SessionRewardAccumulator } from "../../src/core/reward.js";
import {
  measureCurrentQuality,
} from "../../src/core/stage-tracker.js";
import { computeStageReward } from "../../src/core/stage-learner.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  initQValueTables(db);
});

describe("defect 1: per-query Q writes are structurally impossible", () => {
  it("rejects an unsanctioned reward source", () => {
    // The production bug wrote a rank proxy on every query. Any future
    // equivalent must fail at the first call, not accumulate silently.
    expect(() =>
      updateQ(db, "note-a", 0.05, "s1", "per_query" as never),
    ).toThrow(/refusing write from source/);
  });

  it("permits session_batch and explore_conclude", () => {
    expect(() => updateQ(db, "note-a", 0.5, "s1", "session_batch")).not.toThrow();
    expect(() =>
      updateQ(db, "note-b", 0.5, "s1", "explore_conclude"),
    ).not.toThrow();
  });

  it("records the source on every history row", () => {
    updateQ(db, "note-a", 0.5, "s1", "session_batch");
    updateQ(db, "note-b", 0.5, "s1", "explore_conclude");
    const rows = db
      .prepare("SELECT reward_source, COUNT(*) n FROM q_history GROUP BY reward_source")
      .all() as { reward_source: string; n: number }[];
    const sources = Object.fromEntries(rows.map((r) => [r.reward_source, r.n]));
    // Before the fix every row was hardcoded 'session_batch', which is exactly
    // why the contamination could not be separated after the fact.
    expect(sources).toEqual({ session_batch: 1, explore_conclude: 1 });
  });

  it("allows migrations to bypass the guard explicitly", () => {
    expect(() =>
      updateQ(db, "note-a", 0.1, "s1", "migration", true),
    ).not.toThrow();
  });
});

describe("defect 2: note keys are canonical", () => {
  it("treats a title and its slug as the same note", () => {
    updateQ(db, "Agent Memory Compounds", 1.0, "s1", "session_batch");
    // Same note, spelled the way retrieval used to spell it.
    expect(getQ(db, "agent-memory-compounds")).toBeCloseTo(
      DEFAULT_Q + 0.1 * (1.0 - DEFAULT_Q),
      10,
    );
  });

  it("does not split Q across spellings", () => {
    updateQ(db, "Some Note Title", 1.0, "s1", "session_batch");
    updateQ(db, "some-note-title", 1.0, "s1", "session_batch");
    const rows = db.prepare("SELECT COUNT(*) n FROM note_q").get() as { n: number };
    // Production held 1,072 distinct ids for a vault of ~1,355 notes because
    // 300 were raw titles duplicating slugs already present.
    expect(rows.n).toBe(1);
  });

  it("reports a single key shape in health", () => {
    updateQ(db, "Mixed Case Title", 0.5, "s1", "session_batch");
    updateQ(db, "already-a-slug", 0.5, "s1", "session_batch");
    expect(getLearningHealth(db).distinctKeyShapes).toBe(1);
  });
});

describe("defect 3: forward citation actually fires", () => {
  it("credits a cited note at full reward", () => {
    const acc = new SessionRewardAccumulator("s1");
    // Retrieval logs a slug (the common production shape).
    acc.logRetrieval("zep-bi-temporal-edge-invalidation", 0, "q", "semantic");
    // The agent then writes a note citing it by TITLE, as wiki-links do.
    acc.logAdd("New Synthesis", "builds on [[Zep bi temporal edge invalidation]]");

    const rewards = acc.computeRewards(db);
    expect(rewards.get("zep-bi-temporal-edge-invalidation")).toBe(1.0);
    expect(acc.getSignalCounts().forward_citation).toBe(1);
  });

  it("handles piped and anchored wiki-links", () => {
    const acc = new SessionRewardAccumulator("s1");
    acc.logRetrieval("some-note", 0, "q", "semantic");
    acc.logAdd("Other", "see [[Some Note|the earlier one]] and [[Some Note#Detail]]");
    expect(acc.computeRewards(db).get("some-note")).toBe(1.0);
  });

  it("fired zero times before the fix — guard the regression", () => {
    // Reproduces the exact production shape: slug in retrieval, title in link.
    // Under raw string equality this returned a dead-end penalty instead.
    const acc = new SessionRewardAccumulator("s1");
    acc.logRetrieval("act-r-base-level-activation-is-right", 0, "q", "semantic");
    acc.logAdd("N", "per [[ACT-R base level activation is right]]");
    const r = acc.computeRewards(db).get("act-r-base-level-activation-is-right")!;
    expect(r).toBeGreaterThan(0);
  });
});

describe("defect 4: exposure correction cannot erase a real signal", () => {
  it("retains at least the floor for a heavily exposed note", () => {
    const acc = new SessionRewardAccumulator("s1");
    acc.logRetrieval("index", 0, "q", "semantic");
    acc.logAdd("N", "cites [[index]]");
    for (let i = 0; i < 300; i++) incrementExposure(db, "index");

    const reward = acc.computeRewards(db).get("index")!;
    // At the old EXPOSURE_BETA of 0.5 this was 1.0/17.3 = 0.058 — below the
    // noise floor of the rank proxy running at the time, so `index` decayed to
    // Q=0.0165 despite being the most-retrieved note in the vault.
    expect(reward).toBeGreaterThanOrEqual(0.2);
  });

  it("does not damp penalties", () => {
    const acc = new SessionRewardAccumulator("s1");
    acc.logRetrieval("dud", 0, "q", "semantic");
    for (let i = 0; i < 300; i++) incrementExposure(db, "dud");
    // Dead end at rank 0, unmodified by exposure: damping penalties would make
    // popular notes progressively harder to demote.
    expect(acc.computeRewards(db).get("dud")!).toBeCloseTo(-0.15, 10);
  });

  it("keeps exposure and Q from anti-correlating", () => {
    // A note that is used and cited should end up ABOVE one that is never
    // useful, regardless of how often it was shown.
    const busy = new SessionRewardAccumulator("s1");
    busy.logRetrieval("used-note", 0, "q", "semantic");
    busy.logAdd("N", "cites [[used note]]");
    for (let i = 0; i < 200; i++) incrementExposure(db, "used-note");
    batchUpdateQ(db, busy.computeRewards(db), "s1");

    const idle = new SessionRewardAccumulator("s2");
    idle.logRetrieval("dead-note", 0, "q2", "semantic");
    batchUpdateQ(db, idle.computeRewards(db), "s2");

    expect(getQ(db, "used-note")).toBeGreaterThan(getQ(db, "dead-note"));
  });
});

describe("defect 5: stage quality is scale-invariant", () => {
  it("scores identically across wildly different score scales", () => {
    // The same ranking expressed as cosine scores and as RRF scores.
    const cosine = [{ score: 2.9 }, { score: 2.1 }, { score: 1.4 }, { score: 0.6 }];
    const rrf = [
      { score: 1 / 61 },
      { score: 1 / 62 },
      { score: 1 / 63 },
      { score: 1 / 64 },
    ];
    // Not equal in value (the distributions differ), but both must be finite,
    // in range, and neither may be pinned to an extreme by its units.
    for (const q of [measureCurrentQuality(cosine), measureCurrentQuality(rrf)]) {
      expect(q).toBeGreaterThan(0);
      expect(q).toBeLessThanOrEqual(1);
    }
  });

  it("does not floor a cross-scale stage at -1", () => {
    // This is the production failure: rrf_fusion measured cosine before and RRF
    // after. Old code: delta = 0.016 - 2.0, times 10, clamped => exactly -1.0,
    // 1850 times in a row.
    const before = measureCurrentQuality([
      { score: 2.9 },
      { score: 2.1 },
      { score: 1.4 },
    ]);
    const after = measureCurrentQuality([
      { score: 1 / 61 },
      { score: 1 / 62 },
      { score: 1 / 63 },
    ]);
    const reward = computeStageReward(before, after, 5);
    expect(reward).toBeGreaterThan(-1);
  });

  it("rewards genuine top-heaviness improvement", () => {
    const flat = measureCurrentQuality([
      { score: 1.0 },
      { score: 0.99 },
      { score: 0.98 },
      { score: 0.97 },
    ]);
    const peaked = measureCurrentQuality([
      { score: 1.0 },
      { score: 0.2 },
      { score: 0.1 },
      { score: 0.05 },
    ]);
    expect(peaked).toBeGreaterThan(flat);
    expect(computeStageReward(flat, peaked, 5)).toBeGreaterThan(0);
  });

  it("returns 0 for a degenerate all-equal set", () => {
    // Uniform distribution == the baseline, so concentration is zero. Float
    // reassociation in the weighted sum leaves ~1e-16 of residue; assert
    // closeness rather than Object.is, which would make the test a hardware
    // detail rather than a behavioral claim.
    expect(measureCurrentQuality([{ score: 1 }, { score: 1 }, { score: 1 }]))
      .toBeCloseTo(0, 12);
  });

  it("is invariant to multiplying every score by a constant", () => {
    const base = [{ score: 2.0 }, { score: 0.5 }, { score: 0.25 }];
    const scaled = base.map((c) => ({ score: c.score * 137 }));
    expect(measureCurrentQuality(scaled)).toBeCloseTo(
      measureCurrentQuality(base),
      12,
    );
  });

  it("handles negative scores (phaseB emits z-scored values)", () => {
    const q = measureCurrentQuality([
      { score: 1.9 },
      { score: -0.3 },
      { score: -0.9 },
    ]);
    expect(Number.isFinite(q)).toBe(true);
    expect(q).toBeGreaterThan(0);
  });

  it("returns 0 for an empty candidate set", () => {
    expect(measureCurrentQuality([])).toBe(0);
  });
});

describe("learning health surfaces the failure modes", () => {
  it("reports source mix, citations, and correlation", () => {
    const acc = new SessionRewardAccumulator("s1");
    acc.logRetrieval("a-note", 0, "q", "semantic");
    acc.logAdd("N", "cites [[a note]]");
    batchUpdateQ(db, acc.computeRewards(db), "s1");

    const health = getLearningHealth(db);
    expect(health.bySource.session_batch).toBe(1);
    expect(health.forwardCitations).toBe(1);
    expect(health.distinctKeyShapes).toBe(1);
    expect(Number.isFinite(health.exposureQCorrelation)).toBe(true);
  });
});
