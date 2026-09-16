import { describe, it, expect } from "vitest";
import { tokenize, buildBM25Index, searchBM25 } from "../../src/core/bm25.js";
import type { BM25Index } from "../../src/core/bm25.js";
import type { BM25Config } from "../../src/core/config.js";

const DEFAULT_CONFIG: BM25Config = {
  k1: 1.2,
  b: 0.75,
  title_boost: 3.0,
  description_boost: 2.0,
};

// ── tokenize ─────────────────────────────────────────────────────────
describe("tokenize", () => {
  it("lowercases and splits words", () => {
    expect(tokenize("Hello World")).toEqual(["hello", "world"]);
  });

  it("strips stopwords", () => {
    const tokens = tokenize("the quick and the slow");
    expect(tokens).toEqual(["quick", "slow"]);
  });

  it("filters tokens shorter than 2 chars", () => {
    const tokens = tokenize("I am a big x fan");
    // "i" (len 1), "am" (len 2 ok), "a" (stopword), "big", "x" (len 1), "fan"
    expect(tokens).toEqual(["am", "big", "fan"]);
  });

  it("keeps single upper-case identifiers that are not sentence-initial (2026-09-06)", () => {
    expect(tokenize("Resume J")).toEqual(["resume", "j"]);
    expect(tokenize("Plan B vs plan a")).toEqual(["plan", "b", "vs", "plan"]);
    expect(tokenize("v2 build 7")).toEqual(["v2", "build", "7"]);
    expect(tokenize("I think J is fine")).toEqual(["think", "j", "fine"]);
  });

  it("splits on non-alphanumeric characters", () => {
    const tokens = tokenize("hello-world foo_bar baz.qux");
    expect(tokens).toEqual(["hello", "world", "foo", "bar", "baz", "qux"]);
  });

  it("returns empty for empty string", () => {
    expect(tokenize("")).toEqual([]);
  });
});

// ── buildBM25Index ───────────────────────────────────────────────────
describe("buildBM25Index", () => {
  const docs = [
    { title: "pagerank algorithm", description: "graph ranking method", body: "pagerank ranks nodes in a graph" },
    { title: "basketball scoring", description: "sports analytics", body: "points assists rebounds in basketball" },
    { title: "token economics", description: "crypto incentive design", body: "token supply demand and staking" },
  ];

  it("counts documents correctly", () => {
    const index = buildBM25Index(docs);
    expect(index.docCount).toBe(3);
  });

  it("computes doc lengths for all documents", () => {
    const index = buildBM25Index(docs);
    expect(index.docLengths.size).toBe(3);
    for (const [, len] of index.docLengths) {
      expect(len).toBeGreaterThan(0);
    }
  });

  it("computes average doc length", () => {
    const index = buildBM25Index(docs);
    const totalLen = Array.from(index.docLengths.values()).reduce((a, b) => a + b, 0);
    expect(index.avgDocLength).toBeCloseTo(totalLen / 3);
  });

  it("builds term frequency entries", () => {
    const index = buildBM25Index(docs);
    // "pagerank" appears in doc 1 title (boosted) and body
    const prDocs = index.termFreqs.get("pagerank");
    expect(prDocs).toBeDefined();
    expect(prDocs!.has("pagerank algorithm")).toBe(true);
    // boosted: title_boost (3) + 1 body occurrence = 4
    expect(prDocs!.get("pagerank algorithm")).toBe(4);
  });

  it("title boost increases term frequency", () => {
    const index = buildBM25Index(docs);
    // "graph" appears in title-desc of doc1 ("graph ranking method") and body
    const graphDocs = index.termFreqs.get("graph");
    expect(graphDocs).toBeDefined();
    // description_boost (2) for desc + 1 for body = 3
    expect(graphDocs!.get("pagerank algorithm")).toBe(3);
  });
});

// ── searchBM25 ───────────────────────────────────────────────────────
describe("searchBM25", () => {
  const docs = [
    { title: "pagerank graph algorithm", description: "ranking nodes in graphs", body: "pagerank computes importance of nodes using link structure" },
    { title: "basketball court design", description: "sports facility planning", body: "court dimensions markings and surfaces for basketball" },
    { title: "token staking rewards", description: "crypto incentive mechanics", body: "staking tokens earns rewards based on lock duration" },
  ];

  let index: BM25Index;

  // Build once for all search tests
  index = buildBM25Index(docs, DEFAULT_CONFIG);

  it("ranks graph-related doc highest for 'pagerank graph'", () => {
    const results = searchBM25("pagerank graph", index, DEFAULT_CONFIG);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe("pagerank graph algorithm");
    expect(results[0].signals.keyword).toBeGreaterThan(0);
  });

  it("returns empty for no-match query", () => {
    const results = searchBM25("quantum entanglement", index, DEFAULT_CONFIG);
    expect(results).toEqual([]);
  });

  it("respects the limit parameter", () => {
    const results = searchBM25("pagerank graph basketball token", index, DEFAULT_CONFIG, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns empty for stopword-only query", () => {
    const results = searchBM25("the and is", index, DEFAULT_CONFIG);
    expect(results).toEqual([]);
  });

  it("score equals signals.keyword", () => {
    const results = searchBM25("staking rewards", index, DEFAULT_CONFIG);
    for (const r of results) {
      expect(r.score).toBe(r.signals.keyword);
    }
  });

  it("title boost makes title-match score higher than body-only match", () => {
    // Build two docs: one with "algorithm" in title, one with "algorithm" only in body
    const boostDocs = [
      { title: "algorithm design", description: "methods", body: "various approaches" },
      { title: "data structures", description: "methods", body: "algorithm complexity analysis" },
    ];
    const boostIndex = buildBM25Index(boostDocs, DEFAULT_CONFIG);
    const results = searchBM25("algorithm", boostIndex, DEFAULT_CONFIG);
    expect(results.length).toBe(2);
    // The doc with "algorithm" in the title should score higher
    expect(results[0].title).toBe("algorithm design");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });
});
