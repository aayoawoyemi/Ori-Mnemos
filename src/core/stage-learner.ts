/**
 * Stage meta-learning via LinUCB contextual bandits.
 * Layer 3 of retrieval intelligence — each retrieval stage learns
 * whether it helps or hurts for different query types, and auto-skips
 * stages that don't help. The pipeline configures itself.
 *
 * Research: LinUCB (Li et al. 2010), ACQO curriculum, SmartRAG cost-aware,
 * MoE load balancing (Shazeer), cascade classifiers, Vespa time budgets.
 */

import type Database from "better-sqlite3";

// Constants
const LINUCB_ALPHA = 0.25;
const D = 8; // feature vector dimensions
const MIN_SAMPLES = 15;
const PRECISION_SWITCH = 50;
const VARIANCE_THRESHOLD = 0.05;
const ABSTAIN_THRESHOLD = 0.10;
const COST_PENALTY_ALPHA = 0.2;
const LOAD_BALANCE_LAMBDA = 0.01;
const TIME_BUDGET_MS = 500;
const SOFT_CUTOFF = 0.8;

// --- Schema ---

export function initStageTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stage_q (
      stage_id TEXT PRIMARY KEY,
      a_matrix TEXT NOT NULL,
      b_vector TEXT NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      total_reward REAL NOT NULL DEFAULT 0,
      last_updated TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      query_features TEXT NOT NULL,
      decision TEXT NOT NULL,
      quality_before REAL,
      quality_after REAL,
      compute_time_ms REAL,
      reward REAL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_stage_log_stage ON stage_log(stage_id);
    CREATE INDEX IF NOT EXISTS idx_stage_log_session ON stage_log(session_id);
  `);
}

// --- Stage configs ---

export interface StageConfig {
  id: string;
  computeCostMs: number;
  skipThreshold: number;
  essential: boolean;
}

export const STAGE_CONFIGS: StageConfig[] = [
  {
    id: "semantic_search",
    computeCostMs: 20,
    skipThreshold: 0.15,
    essential: true,
  },
  { id: "bm25", computeCostMs: 10, skipThreshold: 0.15, essential: false },
  {
    id: "pagerank",
    computeCostMs: 30,
    skipThreshold: 0.2,
    essential: false,
  },
  { id: "warmth", computeCostMs: 30, skipThreshold: 0.2, essential: false },
  {
    id: "hub_dampening",
    computeCostMs: 15,
    skipThreshold: 0.2,
    essential: false,
  },
  {
    id: "gravity_dampening",
    computeCostMs: 10,
    skipThreshold: 0.2,
    essential: false,
  },
  {
    id: "q_reranking",
    computeCostMs: 25,
    skipThreshold: 0.2,
    essential: false,
  },
  {
    id: "cooccurrence_ppr",
    computeCostMs: 50,
    skipThreshold: 0.3,
    essential: false,
  },
  {
    id: "rrf_fusion",
    computeCostMs: 5,
    skipThreshold: 0.1,
    essential: true,
  },
];

// --- Query features ---

export function extractQueryFeatures(
  query: string,
  embeddingEntropy: number,
  vaultSize: number,
  queryDepth: number,
): number[] {
  const tokens = query.split(/\s+/);
  const unique = new Set(tokens.map((t) => t.toLowerCase()));
  return [
    tokens.length / 50,
    Math.log1p(unique.size) / 10,
    /\?/.test(query) ? 1 : 0,
    /\b(recent|latest|today|yesterday|when)\b/i.test(query) ? 1 : 0,
    /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\b/.test(query) ? 1 : 0,
    embeddingEntropy / 10,
    vaultSize / 1000,
    queryDepth / 10,
  ];
}

// --- LinUCB ---

export class LinUCBStage {
  private A: number[][];
  private b: number[];
  private _sampleCount: number;
  private _totalReward: number;
  readonly config: StageConfig;

  constructor(
    config: StageConfig,
    saved?: { a: number[][]; b: number[]; sampleCount: number; totalReward: number },
  ) {
    this.config = config;
    if (saved) {
      this.A = saved.a;
      this.b = saved.b;
      this._sampleCount = saved.sampleCount;
      this._totalReward = saved.totalReward;
    } else {
      // Identity matrix
      this.A = Array.from({ length: D }, (_, i) =>
        Array.from({ length: D }, (_, j) => (i === j ? 1 : 0)),
      );
      this.b = new Array(D).fill(0);
      this._sampleCount = 0;
      this._totalReward = 0;
    }
  }

  get sampleCount(): number {
    return this._sampleCount;
  }

  get totalReward(): number {
    return this._totalReward;
  }

  getUCB(x: number[]): number {
    const Ainv = invertMatrix(this.A);
    const theta = matVecMul(Ainv, this.b);
    const exploit = dot(theta, x);
    const explore =
      LINUCB_ALPHA * Math.sqrt(Math.max(0, dot(x, matVecMul(Ainv, x))));
    return exploit + explore;
  }

  update(x: number[], reward: number): void {
    // A += x x^T
    for (let i = 0; i < D; i++) {
      for (let j = 0; j < D; j++) {
        this.A[i][j] += x[i] * x[j];
      }
    }
    // b += reward * x
    for (let i = 0; i < D; i++) {
      this.b[i] += reward * x[i];
    }
    this._sampleCount++;
    this._totalReward += reward;
  }

  serialize(): { a: number[][]; b: number[] } {
    return { a: this.A.map((row) => [...row]), b: [...this.b] };
  }
}

// --- Decision ---

export type StageBudgetOptions = { timeBudgetMs?: number; softCutoff?: number; epsilon?: number; random?: () => number };
export const EPSILON = 0.02;

export function getStageDecision(
  stage: LinUCBStage,
  x: number[],
  elapsedMs: number,
  sampleCount: number,
  opts: StageBudgetOptions = {}
): "run" | "skip" | "abstain" {
  const {
    timeBudgetMs = TIME_BUDGET_MS,
    softCutoff = SOFT_CUTOFF,
    epsilon = EPSILON,
    random = Math.random
  } = opts;

  if (stage.config.essential) {
    return "run"; // essential -> run
  }

  if (sampleCount < MIN_SAMPLES) {
    return "run"; // exploration phase must not be starved
  }

  if (elapsedMs > timeBudgetMs * softCutoff) {
    return "skip"; // budget exceeded
  }

  if (random() < epsilon) {
    return "run"; // epsilon-greedy re-exploration
  }

  const ucb = stage.getUCB(x);

  if (ucb < ABSTAIN_THRESHOLD) {
    return "abstain";
  }

  if (ucb < stage.config.skipThreshold) {
    return "skip";
  }

  return "run";
}

// --- Stage reward ---

export function computeStageReward(
  qualityBefore: number,
  qualityAfter: number,
  computeTimeMs: number,
): number {
  const delta = qualityAfter - qualityBefore;
  const reward =
    delta * 10 - COST_PENALTY_ALPHA * (computeTimeMs / 100);
  return Math.max(-1, Math.min(1, reward));
}

// --- Load balancing ---

export function loadBalancePenalty(
  stageRunCounts: Map<string, number>,
  lambda: number = LOAD_BALANCE_LAMBDA,
): number {
  const counts = [...stageRunCounts.values()];
  if (counts.length === 0) return 0;
  const mean =
    counts.reduce((a, b) => a + b, 0) / counts.length;
  if (mean === 0) return 0;
  const cv =
    Math.sqrt(
      counts.reduce((a, c) => a + (c - mean) ** 2, 0) / counts.length,
    ) / mean;
  return lambda * cv * cv;
}

// --- Persistence ---

export function saveStage(
  db: Database.Database,
  stage: LinUCBStage,
): void {
  const { a, b } = stage.serialize();
  db.prepare(
    `
    INSERT INTO stage_q (stage_id, a_matrix, b_vector, sample_count, total_reward, last_updated)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(stage_id) DO UPDATE SET
      a_matrix = ?, b_vector = ?, sample_count = ?, total_reward = ?, last_updated = datetime('now')
  `,
  ).run(
    stage.config.id,
    JSON.stringify(a),
    JSON.stringify(b),
    stage.sampleCount,
    stage.totalReward,
    JSON.stringify(a),
    JSON.stringify(b),
    stage.sampleCount,
    stage.totalReward,
  );
}

export function loadStage(
  db: Database.Database,
  config: StageConfig,
): LinUCBStage {
  const row = db
    .prepare(
      "SELECT a_matrix, b_vector, sample_count, total_reward FROM stage_q WHERE stage_id = ?",
    )
    .get(config.id) as
    | { a_matrix: string; b_vector: string; sample_count: number; total_reward: number }
    | undefined;

  if (row) {
    return new LinUCBStage(config, {
      a: JSON.parse(row.a_matrix),
      b: JSON.parse(row.b_vector),
      sampleCount: row.sample_count,
      totalReward: row.total_reward,
    });
  }
  return new LinUCBStage(config);
}

// --- Log stage decision ---

export function logStageDecision(
  db: Database.Database,
  sessionId: string,
  stageId: string,
  queryFeatures: number[],
  decision: string,
  qualityBefore: number | null,
  qualityAfter: number | null,
  computeTimeMs: number | null,
  reward: number | null,
): void {
  db.prepare(
    `
    INSERT INTO stage_log
      (session_id, stage_id, query_features, decision,
       quality_before, quality_after, compute_time_ms, reward)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    sessionId,
    stageId,
    JSON.stringify(queryFeatures),
    decision,
    qualityBefore,
    qualityAfter,
    computeTimeMs,
    reward,
  );
}

// --- Linear algebra helpers ---

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function matVecMul(M: number[][], v: number[]): number[] {
  return M.map((row) => dot(row, v));
}

function invertMatrix(M: number[][]): number[][] {
  const n = M.length;
  // Build augmented matrix [M | I]
  const aug = M.map((row, i) =>
    [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))],
  );

  for (let col = 0; col < n; col++) {
    // Partial pivoting
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col]))
        maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-12) continue;
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      for (let j = 0; j < 2 * n; j++) aug[row][j] -= factor * aug[col][j];
    }
  }

  return aug.map((row) => row.slice(n));
}

// Re-export for tests
export {
  LINUCB_ALPHA,
  D,
  MIN_SAMPLES,
  PRECISION_SWITCH,
  VARIANCE_THRESHOLD,
  ABSTAIN_THRESHOLD,
  COST_PENALTY_ALPHA,
  LOAD_BALANCE_LAMBDA,
  TIME_BUDGET_MS,
  SOFT_CUTOFF,
  dot,
  matVecMul,
  invertMatrix,
};
