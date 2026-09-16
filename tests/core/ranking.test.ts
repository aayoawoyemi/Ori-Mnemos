import { describe, it, expect } from "vitest";
import { rankByImportance, rankByFading, rankByVitality } from "../../src/core/ranking.js";

describe("rankByImportance", () => {
  it("ranks notes by PageRank score descending", () => {
    const pr = new Map([["a", 0.5], ["b", 0.8], ["c", 0.3]]);
    const ranked = rankByImportance(["a", "b", "c"], pr);
    expect(ranked[0].title).toBe("b");
    expect(ranked[2].title).toBe("c");
  });

  it("respects limit", () => {
    const pr = new Map([["a", 0.5], ["b", 0.8], ["c", 0.3]]);
    const ranked = rankByImportance(["a", "b", "c"], pr, 2);
    expect(ranked.length).toBe(2);
  });

  it("returns 0 score for notes not in PageRank map", () => {
    const pr = new Map([["a", 0.5]]);
    const ranked = rankByImportance(["a", "unknown"], pr);
    const unknown = ranked.find((r) => r.title === "unknown");
    expect(unknown?.score).toBe(0);
  });
});

describe("rankByFading", () => {
  it("returns only notes below threshold", () => {
    const vitality = new Map([["alive", 0.8], ["fading", 0.1], ["dead", 0.0]]);
    const fading = rankByFading(["alive", "fading", "dead"], vitality, 0.3);
    expect(fading.length).toBe(2);
    expect(fading.map((f) => f.title)).not.toContain("alive");
  });

  it("sorts ascending (most fading first)", () => {
    const vitality = new Map([["low", 0.1], ["lower", 0.05]]);
    const fading = rankByFading(["low", "lower"], vitality);
    expect(fading[0].title).toBe("lower");
  });
});

describe("rankByVitality", () => {
  it("ranks descending by vitality", () => {
    const vitality = new Map([["a", 0.3], ["b", 0.9], ["c", 0.6]]);
    const ranked = rankByVitality(["a", "b", "c"], vitality);
    expect(ranked[0].title).toBe("b");
    expect(ranked[2].title).toBe("a");
  });
});
