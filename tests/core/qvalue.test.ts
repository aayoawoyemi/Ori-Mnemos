import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  initQValueTables,
  getQ,
  getDecayedQ,
  getRewardStats,
  getExposureCount,
  getTotalQUpdates,
  getTotalQueryCount,
  updateQ,
  incrementExposure,
  logRetrieval,
  explorationBonus,
  batchUpdateQ,
  getQState,
  exposureDamping,
  applyColdStartFloor,
  COLD_START_EPSILON,
  MIN_EXPLORE_RETENTION,
  ALPHA,
  DEFAULT_Q,
} from "../../src/core/qvalue.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  initQValueTables(db);
});

describe("initQValueTables", () => {
  it("creates all three tables", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("note_q");
    expect(names).toContain("q_history");
    expect(names).toContain("retrieval_log");
  });

  it("is idempotent", () => {
    expect(() => initQValueTables(db)).not.toThrow();
  });
});

describe("getQ / updateQ", () => {
  it("returns DEFAULT_Q for unknown notes", () => {
    expect(getQ(db, "unknown-note")).toBe(DEFAULT_Q);
  });

  it("updates Q with EMA formula", () => {
    updateQ(db, "note-a", 1.0, "session-1");
    const q = getQ(db, "note-a");
    // Q = 0.5 + 0.1 * (1.0 - 0.5) = 0.55
    expect(q).toBeCloseTo(0.55, 10);
  });

  it("accumulates updates correctly", () => {
    updateQ(db, "note-a", 1.0, "s1");
    updateQ(db, "note-a", 1.0, "s1");
    const q = getQ(db, "note-a");
    // Round 1: 0.5 + 0.1*(1.0-0.5) = 0.55
    // Round 2: 0.55 + 0.1*(1.0-0.55) = 0.595
    expect(q).toBeCloseTo(0.595, 10);
  });

  it("decreases Q for negative rewards", () => {
    updateQ(db, "note-a", -0.15, "s1");
    const q = getQ(db, "note-a");
    // Q = 0.5 + 0.1*(-0.15-0.5) = 0.5 - 0.065 = 0.435
    expect(q).toBeCloseTo(0.435, 10);
  });

  it("writes to q_history", () => {
    updateQ(db, "note-a", 1.0, "session-1");
    const history = db
      .prepare("SELECT * FROM q_history WHERE note_id = ?")
      .all("note-a") as any[];
    expect(history).toHaveLength(1);
    expect(history[0].old_q).toBeCloseTo(0.5, 10);
    expect(history[0].new_q).toBeCloseTo(0.55, 10);
    expect(history[0].session_id).toBe("session-1");
  });
});

describe("getDecayedQ", () => {
  it("returns DEFAULT_Q for unknown notes", () => {
    expect(getDecayedQ(db, "unknown")).toBe(DEFAULT_Q);
  });

  it("returns current Q for recently updated notes", () => {
    updateQ(db, "note-a", 1.0, "s1");
    // Just updated — daysSince ≈ 0, decay ≈ 1.0
    const decayed = getDecayedQ(db, "note-a");
    expect(decayed).toBeCloseTo(0.55, 1);
  });
});

describe("getRewardStats", () => {
  it("returns defaults for unknown notes", () => {
    const stats = getRewardStats(db, "unknown");
    expect(stats.mean).toBe(0);
    expect(stats.variance).toBe(0.25);
    expect(stats.count).toBe(0);
  });

  it("computes mean and variance after updates", () => {
    updateQ(db, "note-a", 1.0, "s1");
    updateQ(db, "note-a", 0.5, "s1");
    const stats = getRewardStats(db, "note-a");
    expect(stats.count).toBe(2);
    expect(stats.mean).toBeCloseTo(0.75, 10);
    // variance = (1^2+0.5^2)/2 - 0.75^2 = 0.625 - 0.5625 = 0.0625
    expect(stats.variance).toBeCloseTo(0.0625, 10);
  });
});

describe("exposure", () => {
  it("starts at 0", () => {
    expect(getExposureCount(db, "note-a")).toBe(0);
  });

  it("increments correctly", () => {
    incrementExposure(db, "note-a");
    expect(getExposureCount(db, "note-a")).toBe(1);
    incrementExposure(db, "note-a");
    expect(getExposureCount(db, "note-a")).toBe(2);
  });
});

describe("getTotalQUpdates", () => {
  it("sums update counts across all notes", () => {
    expect(getTotalQUpdates(db)).toBe(0);
    updateQ(db, "note-a", 1.0, "s1");
    updateQ(db, "note-b", 0.5, "s1");
    expect(getTotalQUpdates(db)).toBe(2);
  });
});

describe("getTotalQueryCount", () => {
  it("counts distinct session+query pairs", () => {
    expect(getTotalQueryCount(db)).toBe(0);
    logRetrieval(db, "s1", "query1", "semantic", "note-a", 0, 0.9, 0.5, 0.1, 0.8);
    logRetrieval(db, "s1", "query1", "semantic", "note-b", 1, 0.8, 0.5, 0.1, 0.7);
    logRetrieval(db, "s1", "query2", "semantic", "note-a", 0, 0.9, 0.5, 0.1, 0.8);
    expect(getTotalQueryCount(db)).toBe(2); // 2 distinct queries
  });
});

describe("explorationBonus", () => {
  it("returns c * 2.5 for new notes (count=0)", () => {
    const bonus = explorationBonus({ mean: 0, variance: 0.25, count: 0 }, 100);
    expect(bonus).toBeCloseTo(0.2 * 2.5, 10);
  });

  it("is higher for rarely-retrieved notes", () => {
    const rare = explorationBonus(
      { mean: 0.5, variance: 0.1, count: 2 },
      100,
    );
    const frequent = explorationBonus(
      { mean: 0.5, variance: 0.1, count: 50 },
      100,
    );
    expect(rare).toBeGreaterThan(frequent);
  });

  it("decreases as note is retrieved more", () => {
    const bonuses = [5, 10, 50, 100].map((count) =>
      explorationBonus({ mean: 0.5, variance: 0.1, count }, 200),
    );
    for (let i = 1; i < bonuses.length; i++) {
      expect(bonuses[i]).toBeLessThanOrEqual(bonuses[i - 1]);
    }
  });
});

describe("batchUpdateQ", () => {
  it("updates multiple notes in a transaction", () => {
    const rewards = new Map([
      ["note-a", 1.0],
      ["note-b", -0.15],
      ["note-c", 0.5],
    ]);
    batchUpdateQ(db, rewards, "session-1");

    expect(getQ(db, "note-a")).toBeCloseTo(0.55, 10);
    expect(getQ(db, "note-b")).toBeCloseTo(0.435, 10);
    expect(getQ(db, "note-c")).toBeCloseTo(0.5 + 0.1 * (0.5 - 0.5), 10); // stays 0.5
  });
});

describe("logRetrieval", () => {
  it("writes to retrieval_log", () => {
    logRetrieval(db, "s1", "test query", "semantic", "note-a", 0, 0.9, 0.5, 0.1, 0.8);
    const rows = db.prepare("SELECT * FROM retrieval_log").all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("s1");
    expect(rows[0].query_text).toBe("test query");
    expect(rows[0].note_id).toBe("note-a");
    expect(rows[0].rank).toBe(0);
  });
});

describe("getQState (fix list item 5)", () => {
  it("distinguishes a never-updated Q from a learned one at the same value", () => {
    // A reward of exactly DEFAULT_Q leaves the EMA where it started:
    // 0.5 + 0.1*(0.5 - 0.5) = 0.5. So this note has genuinely learned, and its
    // Q-value is indistinguishable from the initialisation constant.
    updateQ(db, "learned-note", DEFAULT_Q, "s1");
    // This one was only ever shown. `incrementExposure` creates the row with
    // the default q_value — the shape 707 of 717 production rows were in.
    incrementExposure(db, "shown-note");

    // The value alone cannot tell them apart. This is the defect.
    expect(getQ(db, "learned-note")).toBe(DEFAULT_Q);
    expect(getQ(db, "shown-note")).toBe(DEFAULT_Q);

    expect(getQState(db, "learned-note").learned).toBe(true);
    expect(getQState(db, "learned-note").updateCount).toBe(1);
    expect(getQState(db, "shown-note").learned).toBe(false);
    expect(getQState(db, "shown-note").updateCount).toBe(0);
  });

  it("reports an absent note as unlearned rather than as a 0.5 score", () => {
    const state = getQState(db, "no-such-note");
    expect(state.learned).toBe(false);
    expect(state.q).toBe(DEFAULT_Q);
    expect(state.decayedQ).toBe(DEFAULT_Q);
    expect(state.exposureCount).toBe(0);
    expect(state.lastUpdated).toBeNull();
  });

  it("does not decay a value that was never learned", () => {
    incrementExposure(db, "shown-note");
    db.prepare("UPDATE note_q SET last_updated = '2020-01-01 00:00:00'").run();
    // Decaying an un-updated row would manufacture a difference between two
    // notes that have both learned nothing, purely from when exposure created
    // the row.
    expect(getQState(db, "shown-note").decayedQ).toBe(DEFAULT_Q);
    expect(getQState(db, "shown-note").learned).toBe(false);
  });

  it("canonicalizes the key like every other read", () => {
    updateQ(db, "Some Note Title", 1.0, "s1");
    expect(getQState(db, "some-note-title").learned).toBe(true);
    expect(getQState(db, "Some Note Title").noteId).toBe("some-note-title");
  });

  it("carries learned and exposure through getRewardStats", () => {
    incrementExposure(db, "shown-note");
    incrementExposure(db, "shown-note");
    const unlearned = getRewardStats(db, "shown-note");
    expect(unlearned.learned).toBe(false);
    expect(unlearned.exposure).toBe(2);

    updateQ(db, "shown-note", 1.0, "s1");
    const learned = getRewardStats(db, "shown-note");
    expect(learned.learned).toBe(true);
    expect(learned.exposure).toBe(2);
    expect(learned.count).toBe(1);
  });
});

describe("exposure-aware exploration (fix list item 8)", () => {
  it("damps nothing when exposure is unknown", () => {
    // Backward compatibility: callers that pass no exposure get the old value.
    expect(exposureDamping(0)).toBe(1);
    expect(explorationBonus({ mean: 0, variance: 0.25, count: 0 }, 100)).toBe(
      explorationBonus(
        { mean: 0, variance: 0.25, count: 0, exposure: 0 },
        100,
      ),
    );
  });

  it("gives a never-surfaced note a strictly larger bonus than a saturated one", () => {
    // The production degeneracy: 707 of 717 rows had count=0, so every
    // candidate received the identical c*2.5 and the term cancelled out of the
    // ranking entirely.
    const cold = explorationBonus(
      { mean: 0, variance: 0.25, count: 0, exposure: 0 },
      500,
    );
    const hot = explorationBonus(
      { mean: 0, variance: 0.25, count: 0, exposure: 200 },
      500,
    );
    expect(cold).toBeGreaterThan(hot);
    expect(hot).toBeGreaterThan(0);
  });

  it("decreases with exposure down to a floor, and never to zero", () => {
    const bonuses = [0, 1, 10, 100].map((exposure) =>
      explorationBonus({ mean: 0, variance: 0.25, count: 0, exposure }, 500),
    );
    for (let i = 1; i < bonuses.length; i++) {
      expect(bonuses[i]!).toBeLessThan(bonuses[i - 1]!);
    }
    // Beyond ~225 exposures the damping is floored, so even the most saturated
    // note in a vault keeps a bonus. The term is a gradient, never an
    // exclusion — the same reason the stage bandit floors its epsilon.
    const saturated = explorationBonus(
      { mean: 0, variance: 0.25, count: 0, exposure: 100_000 },
      500,
    );
    expect(saturated).toBeCloseTo(0.2 * 2.5 * MIN_EXPLORE_RETENTION, 10);
    expect(saturated).toBeLessThan(bonuses.at(-1)!);
  });
});

describe("applyColdStartFloor (fix list item 8)", () => {
  const ranked = Array.from({ length: 12 }, (_, i) => ({
    title: `note-${i}`,
    score: 1 - i * 0.05,
  }));

  beforeEach(() => {
    // note-0..note-8 have been surfaced; note-9..note-11 never have.
    for (let i = 0; i <= 8; i++) incrementExposure(db, `note-${i}`);
  });

  it("promotes the best never-surfaced candidate when epsilon fires", () => {
    const top = applyColdStartFloor(db, ranked, 8, { random: () => 0 });
    expect(top).toHaveLength(8);
    // note-9 is the strongest note nobody has seen; it takes the weakest slot.
    expect(top.map((r) => r.title)).toContain("note-9");
    expect(top[7]!.title).toBe("note-9");
    // The head of the list is never disturbed.
    expect(top.slice(0, 7).map((r) => r.title)).toEqual(
      ranked.slice(0, 7).map((r) => r.title),
    );
  });

  it("returns the plain cut when epsilon does not fire", () => {
    const top = applyColdStartFloor(db, ranked, 8, { random: () => 1 });
    expect(top.map((r) => r.title)).toEqual(
      ranked.slice(0, 8).map((r) => r.title),
    );
  });

  it("is disabled by epsilon 0", () => {
    const top = applyColdStartFloor(db, ranked, 8, {
      epsilon: 0,
      random: () => 0,
    });
    expect(top.map((r) => r.title)).toEqual(
      ranked.slice(0, 8).map((r) => r.title),
    );
  });

  it("skips an already-surfaced candidate below the cut", () => {
    // note-8 is below the cut but has been shown, so it is not a cold note and
    // must not be promoted by the exploration floor.
    const top = applyColdStartFloor(db, ranked.slice(0, 10), 8, {
      random: () => 0,
    });
    expect(top[7]!.title).toBe("note-9");
  });

  it("leaves the cut alone when nothing below it is cold", () => {
    for (let i = 9; i <= 11; i++) incrementExposure(db, `note-${i}`);
    const top = applyColdStartFloor(db, ranked, 8, { random: () => 0 });
    expect(top.map((r) => r.title)).toEqual(
      ranked.slice(0, 8).map((r) => r.title),
    );
  });

  it("consumes its random draw before any early exit", () => {
    // The 2026-09-12 starvation bug was a short-circuit above the exploration
    // check. Drawing first also keeps a caller's random stream independent of
    // the candidate list, so behaviour does not change with vault size.
    let draws = 0;
    const random = () => {
      draws++;
      return 0;
    };
    applyColdStartFloor(db, ranked.slice(0, 3), 8, { random });
    applyColdStartFloor(db, [], 8, { random });
    expect(draws).toBe(2);
  });

  it("defaults to a 10% floor", () => {
    expect(COLD_START_EPSILON).toBe(0.1);
    const fires = applyColdStartFloor(db, ranked, 8, {
      random: () => COLD_START_EPSILON - 1e-9,
    });
    const misses = applyColdStartFloor(db, ranked, 8, {
      random: () => COLD_START_EPSILON,
    });
    expect(fires.map((r) => r.title)).toContain("note-9");
    expect(misses.map((r) => r.title)).not.toContain("note-9");
  });
});
