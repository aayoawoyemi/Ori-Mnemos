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
  getQState,
  DEFAULT_Q,
} from "../../src/core/qvalue.js";
import { SessionRewardAccumulator } from "../../src/core/reward.js";
import {
  measureCurrentQuality,
  measureConcentration,
  measureExactRecall,
  rareQueryTerms,
  LEXICAL_WEIGHT,
  type LexicalProbe,
} from "../../src/core/stage-tracker.js";
import { computeStageReward } from "../../src/core/stage-learner.js";
import { phaseB } from "../../src/core/rerank.js";
import type { ScoredNote } from "../../src/core/ranking.js";

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

// A 1,524-note corpus. Document frequencies stand in for what the index
// supplies: `resume`, `j` and `zep` are identifier-rare, the rest are topic
// words. The rarity gate at this size is max(8, 15) = 15.
const CORPUS_SIZE = 1524;
const DF: Record<string, number> = {
  resume: 4,
  j: 3,
  zep: 2,
  agent: 340,
  memory: 512,
  notes: 900,
};
const probeFor = (query: string): LexicalProbe => ({
  query,
  documentFrequency: (t) => DF[t] ?? 0,
  corpusSize: CORPUS_SIZE,
});

// A noise-floor result set: near-flat scores, which is what "Resume J scoring
// 0.005" looks like. Both variants below share this shape exactly, so the only
// thing that differs is whether the literal identifier is present.
const FLAT_SCORES = [0.3, 0.299, 0.298, 0.297, 0.296];
const withTitles = (titles: string[]) =>
  FLAT_SCORES.map((score, i) => ({ score, title: titles[i]! }));

const HIT = withTitles([
  "Resume J",
  "Agent memory compounds",
  "Notes on agent memory",
  "Memory notes",
  "Agent notes",
]);
const MISS = withTitles([
  "Agent memory compounds",
  "Notes on agent memory",
  "Memory notes",
  "Agent notes",
  "More agent notes",
]);

describe("defect 6: exact-identifier recall is visible to the reward", () => {
  it("scores a set that misses a literal identifier strictly lower", () => {
    const probe = probeFor("Resume J");

    // The old metric — concentration alone — is blind by construction: it
    // measures ORDER, and both sets have the same order. This equality IS the
    // defect that let bm25 carry -21.38 total reward while being essential.
    expect(measureConcentration(MISS)).toBeCloseTo(
      measureConcentration(HIT),
      12,
    );

    expect(measureCurrentQuality(MISS, probe)).toBeLessThan(
      measureCurrentQuality(HIT, probe),
    );
  });

  it("registers a noise-floor miss as a failure rather than a small positive", () => {
    const probe = probeFor("Resume J");
    // 0.005-ish before: positive, indistinguishable from a weak success.
    expect(measureConcentration(MISS)).toBeGreaterThan(0);
    expect(measureCurrentQuality(MISS, probe)).toBeLessThan(0);
  });

  it("pays a lexical stage for pulling the identifier into the window", () => {
    const probe = probeFor("Resume J");
    const before = measureCurrentQuality(MISS, probe);
    const after = measureCurrentQuality(HIT, probe);
    // The stage does nothing to the ordering, so under the old metric its
    // reward was the cost penalty alone — negative, every single call.
    expect(computeStageReward(measureConcentration(MISS), measureConcentration(HIT), 5)).toBeLessThan(0);
    expect(computeStageReward(before, after, 5)).toBeGreaterThan(0);
  });

  it("moves the score by exactly the lexical weight, and no more", () => {
    const probe = probeFor("Resume J");
    // Full recall versus none spans 2*LEXICAL_WEIGHT. Pinned deliberately:
    // the stage reward must stay comparable across stages and against history,
    // so this component's authority over the number is a fixed, stated budget.
    expect(
      measureCurrentQuality(HIT, probe) - measureCurrentQuality(MISS, probe),
    ).toBeCloseTo(2 * LEXICAL_WEIGHT, 10);
  });

  it("scores partial recall between full and none", () => {
    const probe = probeFor("Resume J Zep");
    const partial = withTitles([
      "Resume of the agent",
      "Agent memory compounds",
      "Notes on agent memory",
      "Memory notes",
      "Agent notes",
    ]);
    const q = measureCurrentQuality(partial, probe);
    expect(q).toBeGreaterThan(measureCurrentQuality(MISS, probe));
    expect(q).toBeLessThan(measureCurrentQuality(HIT, probe));
  });

  it("is unchanged when the caller supplies no probe", () => {
    // Historical stage_q rows were written without a lexical component. If a
    // probe-less call returned anything else, every stored reward would have
    // been silently rescaled.
    expect(measureCurrentQuality(MISS)).toBe(measureConcentration(MISS));
    expect(measureCurrentQuality(HIT)).toBe(measureConcentration(HIT));
  });

  it("ignores query terms that are not in the corpus", () => {
    // A result set cannot be punished for failing to return something the
    // vault does not contain, or every unanswerable query becomes a penalty.
    const probe = probeFor("Nonexistent Xyzzy");
    expect(rareQueryTerms(probe)).toEqual([]);
    expect(measureCurrentQuality(MISS, probe)).toBe(measureConcentration(MISS));
  });

  it("ignores topic words above the rarity gate", () => {
    const probe = probeFor("agent memory notes");
    expect(rareQueryTerms(probe)).toEqual([]);
    expect(measureCurrentQuality(MISS, probe)).toBe(measureConcentration(MISS));
  });

  it("counts a rare term found anywhere in the window, not just at the top", () => {
    const probe = probeFor("Zep");
    const deep = withTitles([
      "Agent memory compounds",
      "Notes on agent memory",
      "Memory notes",
      "Agent notes",
      "Zep bi temporal edges",
    ]);
    expect(measureExactRecall(deep, ["zep"])).toBe(1);
    expect(measureCurrentQuality(deep, probe)).toBeGreaterThan(
      measureCurrentQuality(MISS, probe),
    );
  });

  it("stays inside [-1, 1] for an empty result set", () => {
    const q = measureCurrentQuality([], probeFor("Resume J"));
    // Empty misses everything, so it sits at the bottom of the lexical budget.
    expect(q).toBeCloseTo(-LEXICAL_WEIGHT, 10);
    expect(q).toBeGreaterThanOrEqual(-1);
  });
});

describe("defect 5: the absence of a learning signal is observable", () => {
  it("counts the notes learning never reached", () => {
    for (let i = 0; i < 5; i++) incrementExposure(db, `shown-${i}`);
    updateQ(db, "credited", 0.5, "s1", "session_batch");

    const health = getLearningHealth(db);
    // Production: 717 tracked, 707 never updated — and every summary in the
    // system reported only the 10 that were.
    expect(health.trackedNotes).toBe(6);
    expect(health.neverUpdated).toBe(5);
    expect(health.exposedButNeverUpdated).toBe(5);
    expect(health.neverExposed).toBe(1);
  });

  it("distinguishes a learned 0.5 from the initialisation constant", () => {
    updateQ(db, "learned", DEFAULT_Q, "s1", "session_batch");
    incrementExposure(db, "shown");
    // Identical values; only the provenance separates them.
    expect(getQ(db, "learned")).toBe(getQ(db, "shown"));
    expect(getQState(db, "learned").learned).toBe(true);
    expect(getQState(db, "shown").learned).toBe(false);
  });

  it("leaves no retrieved note unlearned once a session concludes", () => {
    const acc = new SessionRewardAccumulator("s1");
    acc.logRetrieval("note-a", 0, "q", "semantic");
    acc.logRetrieval("note-b", 3, "q", "semantic");
    acc.logAdd("Synthesis", "from [[note a]]");

    expect(acc.concludeSession(db)).toBe(2);
    const health = getLearningHealth(db);
    expect(health.neverUpdated).toBe(0);
    expect(health.exposedButNeverUpdated).toBe(0);
    expect(health.totalUpdates).toBe(2);
  });
});

describe("defect 8: exposure does not concentrate monotonically", () => {
  // Twelve candidates: the top nine have been surfaced repeatedly, the last
  // three never once, and their similarity is far enough below the cut that no
  // bonus this module can emit would lift them. This is the shape of the
  // measured vault: top 50 notes at 47.2% of all exposure, ~280 notes at zero.
  const candidates: ScoredNote[] = [
    ...Array.from({ length: 9 }, (_, i) => ({
      title: `hot-${i}`,
      score: 1 - i * 0.02,
      signals: { rrf: 1 - i * 0.02 },
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      title: `cold-${i}`,
      score: 0.2 - i * 0.02,
      signals: { rrf: 0.2 - i * 0.02 },
    })),
  ];

  const surfaceHotNotes = (): void => {
    for (let i = 0; i < 9; i++) {
      for (let n = 0; n < 40; n++) incrementExposure(db, `hot-${i}`);
    }
  };

  it("selects a never-surfaced note when the exploration floor fires", () => {
    surfaceHotNotes();
    const titles = phaseB(db, candidates, "q", "semantic", "s1", {
      random: () => 0,
    }).map((r) => r.title);
    expect(titles).toContain("cold-0");
  });

  it("never surfaces a cold note without the floor", () => {
    // Same call, epsilon pinned off: similarity alone decides and the cold
    // tail stays invisible forever. This is the baseline the floor breaks.
    surfaceHotNotes();
    const titles = phaseB(db, candidates, "q", "semantic", "s1", {
      random: () => 1,
    }).map((r) => r.title);
    expect(titles.some((t) => t.startsWith("cold-"))).toBe(false);
  });

  it("spreads exposure into the cold tail over repeated queries", () => {
    surfaceHotNotes();
    // Fires on every third query: deterministic, so the test is not a flake.
    let call = 0;
    for (let q = 0; q < 12; q++) {
      phaseB(db, candidates, `q${q}`, "semantic", `s${q}`, {
        random: () => (call++ % 3 === 0 ? 0 : 1),
      });
    }

    for (const title of ["cold-0", "cold-1", "cold-2"]) {
      expect(getQState(db, title).exposureCount).toBeGreaterThan(0);
    }
  });

  it("charges the floor to the weakest kept slot, never the top result", () => {
    surfaceHotNotes();
    const titles = phaseB(db, candidates, "q", "semantic", "s1", {
      random: () => 0,
    }).map((r) => r.title);
    expect(titles[0]).toBe("hot-0");
    expect(titles.filter((t) => t.startsWith("cold-"))).toHaveLength(1);
  });

  it("promotes a near-cut cold note on the exploration bonus alone", () => {
    // No epsilon (random pinned to 1). Ten candidates, evenly spaced, the top
    // eight already saturated: the exposure-damped bonus alone is enough to
    // move the ninth into the cut. Before the damping every candidate received
    // the identical c*2.5, which cancels out of the ranking and leaves
    // similarity - the thing that concentrated exposure - to decide alone.
    const tight: ScoredNote[] = Array.from({ length: 10 }, (_, i) => ({
      title: i < 8 ? `hot-${i}` : `cold-${i - 8}`,
      score: 1 - i * 0.02,
      signals: { rrf: 1 - i * 0.02 },
    }));
    for (let i = 0; i < 8; i++) {
      for (let n = 0; n < 60; n++) incrementExposure(db, `hot-${i}`);
    }

    const titles = phaseB(db, tight, "q", "semantic", "s1", {
      random: () => 1,
    }).map((r) => r.title);
    expect(titles).toContain("cold-0");
    expect(titles).not.toContain("hot-7");
  });
});
