/**
 * Ori Mnemos — Cross-Encoder Rerank Tests (Layer 1.5)
 *
 * Pure-function tests with an injected scorer — no model download.
 */
import { describe, it, expect } from "vitest";
import { rerankCrossEncoder, type PairScorer } from "../../src/core/crossencoder.js";
import type { ScoredNote } from "../../src/core/ranking.js";
import type { RerankConfig } from "../../src/core/config.js";

const CFG: RerankConfig = {
  enabled: true,
  model: "test-model",
  top_k: 3,
  blend: 0.6,
};

function notes(...pairs: Array<[string, number]>): ScoredNote[] {
  return pairs.map(([title, score]) => ({ title, score }));
}

/** Scorer that rewards docs containing the query term. */
const containsScorer: PairScorer = async (q, d) =>
  d.toLowerCase().includes(q.toLowerCase()) ? 0.9 : 0.1;

describe("rerankCrossEncoder", () => {
  it("promotes a relevant low-ranked candidate into the head", async () => {
    const cands = notes(["noise alpha", 1.0], ["noise beta", 0.8], ["target note", 0.5], ["tail", 0.2]);
    const out = await rerankCrossEncoder("target", cands, (n) => n.title, containsScorer, CFG);
    expect(out[0].title).toBe("target note");
  });

  it("only reranks top_k; tail keeps relative order below the head", async () => {
    const cands = notes(["a", 1.0], ["b", 0.9], ["c", 0.8], ["tail1", 0.7], ["tail2", 0.6]);
    const out = await rerankCrossEncoder("zzz", cands, (n) => n.title, containsScorer, CFG);
    const tailIdx1 = out.findIndex((n) => n.title === "tail1");
    const tailIdx2 = out.findIndex((n) => n.title === "tail2");
    expect(tailIdx1).toBeGreaterThanOrEqual(3);
    expect(tailIdx2).toBeGreaterThan(tailIdx1);
    // global monotonicity: scores are non-increasing
    for (let i = 1; i < out.length; i++) {
      expect(out[i].score).toBeLessThanOrEqual(out[i - 1].score);
    }
  });

  it("blend=0 preserves pipeline order; blend=1 is pure cross-encoder", async () => {
    const cands = notes(["low relevance", 1.0], ["target hit", 0.4]);
    const keepOrder = await rerankCrossEncoder("target", cands, (n) => n.title, containsScorer, { ...CFG, blend: 0 });
    expect(keepOrder[0].title).toBe("low relevance");
    const pureCe = await rerankCrossEncoder("target", cands, (n) => n.title, containsScorer, { ...CFG, blend: 1 });
    expect(pureCe[0].title).toBe("target hit");
  });

  it("records the cross-encoder score in signals", async () => {
    const cands = notes(["target note", 1.0]);
    const out = await rerankCrossEncoder("target", cands, (n) => n.title, containsScorer, CFG);
    expect(out[0].signals?.cross_encoder).toBeCloseTo(0.9);
  });

  it("handles empty candidates", async () => {
    const out = await rerankCrossEncoder("q", [], (n) => n.title, containsScorer, CFG);
    expect(out).toEqual([]);
  });

  it("handles top_k larger than candidate count", async () => {
    const cands = notes(["target a", 0.5], ["b", 0.4]);
    const out = await rerankCrossEncoder("target", cands, (n) => n.title, containsScorer, { ...CFG, top_k: 10 });
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe("target a");
  });
});
