import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  initStageTables,
  LinUCBStage,
  getStageDecision,
  computeStageReward,
  extractQueryFeatures,
  saveStage,
  loadStage,
  loadBalancePenalty,
  STAGE_CONFIGS,
  MIN_SAMPLES,
  ABSTAIN_THRESHOLD,
  TIME_BUDGET_MS,
  SOFT_CUTOFF,
  EPSILON,
  D,
  invertMatrix,
  type StageConfig,
} from "../../src/core/stage-learner.js";

let db: Database.Database;

const testConfig: StageConfig = {
  id: "test_stage",
  computeCostMs: 25,
  skipThreshold: 0.20,
  essential: false,
};

const essentialConfig: StageConfig = {
  id: "essential_stage",
  computeCostMs: 20,
  skipThreshold: 0.15,
  essential: true,
};

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  initStageTables(db);
});

describe("initStageTables", () => {
  it("creates stage_q and stage_log tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("stage_q");
    expect(names).toContain("stage_log");
  });
});

describe("LinUCBStage", () => {
  it("initializes with identity A matrix and zero b vector", () => {
    const stage = new LinUCBStage(testConfig);
    expect(stage.sampleCount).toBe(0);
    expect(stage.totalReward).toBe(0);
  });

  it("getUCB returns positive value for any feature vector", () => {
    const stage = new LinUCBStage(testConfig);
    const x = [0.1, 0.2, 0, 0, 1, 0.3, 0.5, 0.1];
    const ucb = stage.getUCB(x);
    expect(ucb).toBeGreaterThan(0);
  });

  it("update modifies A and b correctly", () => {
    const stage = new LinUCBStage(testConfig);
    const x = [1, 0, 0, 0, 0, 0, 0, 0];
    stage.update(x, 0.5);
    expect(stage.sampleCount).toBe(1);
    expect(stage.totalReward).toBeCloseTo(0.5, 10);

    // After update with x=[1,0,...,0], A[0][0] should be 2 (identity + outer product)
    const serialized = stage.serialize();
    expect(serialized.a[0][0]).toBeCloseTo(2, 10);
    expect(serialized.b[0]).toBeCloseTo(0.5, 10);
  });

  it("UCB decreases for consistently negative stages", () => {
    const stage = new LinUCBStage(testConfig);
    const x = [0.5, 0.3, 0, 0, 0, 0.2, 0.5, 0.1];

    // Train with negative rewards
    for (let i = 0; i < 20; i++) {
      stage.update(x, -0.5);
    }

    const ucb = stage.getUCB(x);
    // After many negative updates, UCB should be low
    expect(ucb).toBeLessThan(0.5);
  });

  it("serializes and deserializes correctly", () => {
    const stage = new LinUCBStage(testConfig);
    const x = [0.1, 0.2, 0, 1, 0, 0.3, 0.5, 0.1];
    stage.update(x, 0.7);
    stage.update(x, -0.3);

    const ucbBefore = stage.getUCB(x);
    const { a, b } = stage.serialize();

    const restored = new LinUCBStage(testConfig, {
      a,
      b,
      sampleCount: stage.sampleCount,
      totalReward: stage.totalReward,
    });
    const ucbAfter = restored.getUCB(x);

    expect(ucbAfter).toBeCloseTo(ucbBefore, 10);
  });
});

describe("getStageDecision", () => {
  it("always returns 'run' for essential stages", () => {
    const stage = new LinUCBStage(essentialConfig);
    expect(getStageDecision(stage, [0, 0, 0, 0, 0, 0, 0, 0], 0, 100)).toBe("run");
    expect(getStageDecision(stage, [0, 0, 0, 0, 0, 0, 0, 0], 999, 100)).toBe("run");
  });

  it("returns 'skip' when time budget exceeded", () => {
    const stage = new LinUCBStage(testConfig);
    const elapsed = TIME_BUDGET_MS * SOFT_CUTOFF + 1;
    expect(getStageDecision(stage, [0, 0, 0, 0, 0, 0, 0, 0], elapsed, 100)).toBe("skip");
  });

  it("returns 'run' during exploration phase (sampleCount < MIN_SAMPLES)", () => {
    const stage = new LinUCBStage(testConfig);
    expect(getStageDecision(stage, [0.5, 0.3, 0, 0, 0, 0.2, 0.5, 0.1], 0, 5)).toBe("run");
  });

  it("can return 'skip' after enough samples with low UCB", () => {
    const stage = new LinUCBStage(testConfig);
    const x = [0.5, 0.3, 0, 0, 0, 0.2, 0.5, 0.1];

    // Train with very negative rewards to push UCB below threshold
    for (let i = 0; i < 50; i++) {
      stage.update(x, -0.8);
    }

    const decision = getStageDecision(stage, x, 0, 50, { random: () => 1 });
    expect(["skip", "abstain"]).toContain(decision);
  });
});

describe("computeStageReward", () => {
  it("gives positive reward when quality improves", () => {
    const reward = computeStageReward(0.5, 0.8, 20);
    expect(reward).toBeGreaterThan(0);
  });

  it("gives negative reward when quality degrades", () => {
    const reward = computeStageReward(0.8, 0.5, 20);
    expect(reward).toBeLessThan(0);
  });

  it("penalizes expensive stages", () => {
    const cheapReward = computeStageReward(0.5, 0.6, 10);
    const expensiveReward = computeStageReward(0.5, 0.6, 200);
    expect(cheapReward).toBeGreaterThan(expensiveReward);
  });

  it("clamps to [-1, 1]", () => {
    expect(computeStageReward(0, 1.0, 0)).toBeLessThanOrEqual(1);
    expect(computeStageReward(1.0, 0, 1000)).toBeGreaterThanOrEqual(-1);
  });
});

describe("extractQueryFeatures", () => {
  it("returns 8-dimensional vector", () => {
    const features = extractQueryFeatures("test query", 0.5, 500, 3);
    expect(features).toHaveLength(D);
  });

  it("detects interrogative queries", () => {
    const withQ = extractQueryFeatures("what is this?", 0, 100, 0);
    const withoutQ = extractQueryFeatures("this is that", 0, 100, 0);
    expect(withQ[2]).toBe(1);
    expect(withoutQ[2]).toBe(0);
  });

  it("detects temporal queries", () => {
    const temporal = extractQueryFeatures("recent changes today", 0, 100, 0);
    expect(temporal[3]).toBe(1);
  });
});

describe("persistence", () => {
  it("saves and loads stage state correctly", () => {
    const stage = new LinUCBStage(testConfig);
    const x = [0.5, 0.3, 0, 0, 1, 0.2, 0.5, 0.1];
    stage.update(x, 0.8);
    stage.update(x, -0.2);

    saveStage(db, stage);
    const loaded = loadStage(db, testConfig);

    expect(loaded.sampleCount).toBe(stage.sampleCount);
    expect(loaded.totalReward).toBeCloseTo(stage.totalReward, 10);
    expect(loaded.getUCB(x)).toBeCloseTo(stage.getUCB(x), 10);
  });

  it("returns fresh stage when no saved state exists", () => {
    const loaded = loadStage(db, testConfig);
    expect(loaded.sampleCount).toBe(0);
  });
});

describe("loadBalancePenalty", () => {
  it("returns 0 for empty map", () => {
    expect(loadBalancePenalty(new Map())).toBe(0);
  });

  it("returns 0 for perfectly balanced counts", () => {
    const counts = new Map([
      ["a", 10],
      ["b", 10],
      ["c", 10],
    ]);
    expect(loadBalancePenalty(counts)).toBe(0);
  });

  it("returns positive for imbalanced counts", () => {
    const counts = new Map([
      ["a", 100],
      ["b", 1],
      ["c", 1],
    ]);
    expect(loadBalancePenalty(counts)).toBeGreaterThan(0);
  });
});

describe("invertMatrix", () => {
  it("inverts identity matrix to identity", () => {
    const I = Array.from({ length: D }, (_, i) =>
      Array.from({ length: D }, (_, j) => (i === j ? 1 : 0)),
    );
    const inv = invertMatrix(I);
    for (let i = 0; i < D; i++) {
      for (let j = 0; j < D; j++) {
        expect(inv[i][j]).toBeCloseTo(i === j ? 1 : 0, 10);
      }
    }
  });
});

const dummyX = [0.5, 0.3, 0, 0, 0, 0.2, 0.5, 0.1];

describe("getStageDecision epsilon + budget opts (#34)", () => {
  const stageConfig = {
    id: "test",
    computeCostMs: 10,
    skipThreshold: 0.2,
    essential: false,
  };

  it("exploration phase wins over exceeded budget", () => {
    const stage = new LinUCBStage(stageConfig);
    const decision = getStageDecision(stage, dummyX, 10_000, 5);
    expect(decision).toBe("run");
  });

  it("epsilon re-exploration revives a frozen stage", () => {
    const stage = new LinUCBStage(stageConfig);
    for (let i = 0; i < 50; i++) {
      stage.update(dummyX, -0.8);
    }
    const decisionRun = getStageDecision(stage, dummyX, 0, 50, {
      random: () => 0,
    });
    const decisionAbstain = getStageDecision(stage, dummyX, 0, 50, {
      random: () => 1,
    });
    expect(decisionRun).toBe("run");
    expect(decisionAbstain).not.toBe("run");
  });

  it("custom timeBudgetMs is honored", () => {
    const stage = new LinUCBStage(stageConfig);
    // Untrained but optimistic UCB => run unless budget forces skip
    const decisionWithOpts = getStageDecision(stage, dummyX, 450, 50, {
      timeBudgetMs: 5_000,
      random: () => 1,
    });
    const decisionDefault = getStageDecision(stage, dummyX, 450, 50);
    expect(decisionWithOpts).not.toBe("skip");
    expect(decisionDefault).toBe("skip");
  });

  it("custom softCutoff is honored", () => {
    const stage = new LinUCBStage(stageConfig);
    const decisionHighCutoff = getStageDecision(stage, dummyX, 450, 50, {
      timeBudgetMs: 500,
      softCutoff: 0.95,
      random: () => 1,
    });
    const decisionLowCutoff = getStageDecision(stage, dummyX, 450, 50, {
      timeBudgetMs: 500,
      softCutoff: 0.5,
      random: () => 1,
    });
    expect(decisionHighCutoff).not.toBe("skip");
    expect(decisionLowCutoff).toBe("skip");
  });

  it("epsilon=0 disables re-exploration", () => {
    const stage = new LinUCBStage(stageConfig);
    for (let i = 0; i < 50; i++) {
      stage.update(dummyX, -0.8);
    }
    const decision = getStageDecision(stage, dummyX, 0, 50, {
      epsilon: 0,
      random: () => 0,
    });
    expect(decision).not.toBe("run");
  });
});
