import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import nodePath from 'node:path';
import { LinUCBStage, getStageDecision } from '../../src/core/stage-learner.js';
import { applyConfigDefaults } from '../../src/core/config.js';
import { getUpdateCachePath, compareVersions } from '../../src/core/update-check.js';

const VECTOR = Array(8).fill(1);
const BUDGET = 500;
const SOFT_CUTOFF = 0.8;
const EPSILON = 0.02;
const MIN_SAMPLES = 15;

describe('essential stages', () => {
  it('always run', () => {
    const stage = new LinUCBStage({ id: 'e', computeCostMs: 10, skipThreshold: 5, essential: true });
    const decision = getStageDecision(stage, VECTOR, 200, 0);
    expect(decision).toBe('run');
  });
});

describe('exploration phase (bug A)', () => {
  it('runs even if elapsed time exceeds time budget', () => {
    const stage = new LinUCBStage({ id: 'a', computeCostMs: 10, skipThreshold: 5, essential: false });
    // sampleCount < MIN_SAMPLES
    const decision = getStageDecision(stage, VECTOR, 1000, MIN_SAMPLES - 1);
    expect(decision).toBe('run');
  });
});

describe('freeze escape hatch (bug B)', () => {
  const frozenStage = () => {
    const s = new LinUCBStage({ id: 'f', computeCostMs: 10, skipThreshold: 5, essential: false });
    for (let i = 0; i < 50; i++) s.update(VECTOR, -0.8);
    return s;
  };

  it('runs when random < epsilon', () => {
    const stage = frozenStage();
    const decision = getStageDecision(stage, VECTOR, 200, 50, { epsilon: EPSILON, random: () => 0 });
    expect(decision).toBe('run');
  });

  it('does not run when random >= epsilon', () => {
    const stage = frozenStage();
    const decision = getStageDecision(stage, VECTOR, 200, 50, { epsilon: EPSILON, random: () => 1 });
    expect(decision).not.toBe('run');
  });

  it('epsilon 0 disables escape hatch', () => {
    const stage = frozenStage();
    const decision = getStageDecision(stage, VECTOR, 200, 50, { epsilon: 0, random: () => 0 });
    expect(decision).not.toBe('run');
  });
});

describe('time budget and soft cutoff override (bug C)', () => {
  const stage = new LinUCBStage({ id: 'c', computeCostMs: 10, skipThreshold: 0.2, essential: false });
  // Populate sampleCount > MIN_SAMPLES
  for (let i = 0; i < 50; i++) stage.update(VECTOR, 1);

  it('default skips when elapsed > budget*softCutoff', () => {
    const decision = getStageDecision(stage, VECTOR, 450, 50);
    expect(decision).toBe('skip');
  });

  it('large budget prevents skip', () => {
    const decision = getStageDecision(stage, VECTOR, 450, 50, { timeBudgetMs: 5000, softCutoff: SOFT_CUTOFF });
    expect(decision).toBe('run');
  });

  it('higher softCutoff retains run', () => {
    const decision = getStageDecision(stage, VECTOR, 450, 50, { softCutoff: 0.95, random: () => 1 });
    expect(decision).not.toBe('skip');
  });

  it('lower softCutoff enforces skip', () => {
    const decision = getStageDecision(stage, VECTOR, 450, 50, { softCutoff: 0.5, random: () => 1 });
    expect(decision).toBe('skip');
  });
});

describe('config defaults (bug D)', () => {
  it('applies defaults to empty config', () => {
    const cfg = applyConfigDefaults({});
    expect(cfg).toMatchObject({
      retrieval: {
        stage_time_budget_ms: 500,
        stage_soft_cutoff: 0.8,
      },
    });
  });

  it('preserves user supplied values', () => {
    const cfg = applyConfigDefaults({
      retrieval: { stage_time_budget_ms: 5000, stage_soft_cutoff: 0.5 },
    });
    expect(cfg.retrieval.stage_time_budget_ms).toBe(5000);
    expect(cfg.retrieval.stage_soft_cutoff).toBe(0.5);
  });
});

describe('update cache path collision (bug E)', () => {
  beforeEach(() => { delete process.env.ORI_UPDATE_CACHE_DIR; });
  afterEach(() => { delete process.env.ORI_UPDATE_CACHE_DIR; });

  it('does not contain .ori segment in default path', () => {
    const path = getUpdateCachePath();
    expect(path).not.toContain('.ori');
  });

  it('honors env and does not contain .ori', () => {
    process.env.ORI_UPDATE_CACHE_DIR = '/tmp/x';
    const p = getUpdateCachePath();
    expect(p).toBe(nodePath.join('/tmp/x', 'ori', 'update-cache.json'));
    expect(p).not.toContain('.ori');
  });
});

describe('semantic version comparison (bug F)', () => {
  it('detects newer versions', () => {
    expect(compareVersions('0.4.0', '0.5.5')).toBeTruthy();
  });

  it('rejects identical versions', () => {
    expect(compareVersions('0.6.1', '0.6.1')).toBeFalsy();
  });

  it('recognizes older major/minor patch', () => {
    expect(compareVersions('0.6.1', '0.6.0')).toBeFalsy();
  });
});
