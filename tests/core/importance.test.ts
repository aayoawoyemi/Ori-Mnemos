import { describe, it, expect } from "vitest";
import {
  buildGraphologyGraph,
  computePageRank,
  detectCommunities,
  findBridgeNotes,
  computeBetweenness,
  computeGraphMetrics,
  personalizedPageRank,
} from "../../src/core/importance.js";
import type { LinkGraph } from "../../src/core/graph.js";

function makeLinkGraph(edges: [string, string][]): LinkGraph {
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const [src, tgt] of edges) {
    if (!outgoing.has(src)) outgoing.set(src, new Set());
    outgoing.get(src)!.add(tgt);
    if (!incoming.has(tgt)) incoming.set(tgt, new Set());
    incoming.get(tgt)!.add(src);
  }
  return { outgoing, incoming };
}

describe("buildGraphologyGraph", () => {
  it("creates a graph with correct node and edge count", () => {
    const lg = makeLinkGraph([["a", "b"], ["b", "c"], ["c", "a"]]);
    const g = buildGraphologyGraph(lg);
    expect(g.order).toBe(3); // nodes
    expect(g.size).toBe(3);  // edges
  });

  it("handles empty graph", () => {
    const lg = makeLinkGraph([]);
    const g = buildGraphologyGraph(lg);
    expect(g.order).toBe(0);
  });
});

describe("computePageRank", () => {
  it("returns scores for all nodes", () => {
    const lg = makeLinkGraph([["a", "b"], ["b", "c"], ["c", "a"]]);
    const g = buildGraphologyGraph(lg);
    const pr = computePageRank(g);
    expect(pr.size).toBe(3);
    for (const score of pr.values()) {
      expect(score).toBeGreaterThan(0);
    }
  });

  it("node with most incoming links has highest rank", () => {
    const lg = makeLinkGraph([["a", "hub"], ["b", "hub"], ["c", "hub"], ["hub", "a"]]);
    const g = buildGraphologyGraph(lg);
    const pr = computePageRank(g);
    const hubScore = pr.get("hub")!;
    expect(hubScore).toBeGreaterThan(pr.get("a")!);
    expect(hubScore).toBeGreaterThan(pr.get("b")!);
    expect(hubScore).toBeGreaterThan(pr.get("c")!);
  });
});

describe("detectCommunities", () => {
  it("detects distinct communities in disconnected clusters", () => {
    const lg = makeLinkGraph([
      ["a", "b"], ["b", "a"],  // cluster 1
      ["c", "d"], ["d", "c"],  // cluster 2
    ]);
    const g = buildGraphologyGraph(lg);
    const communities = detectCommunities(g);
    expect(communities.get("a")).toBe(communities.get("b"));
    expect(communities.get("c")).toBe(communities.get("d"));
    expect(communities.get("a")).not.toBe(communities.get("c"));
  });
});

describe("findBridgeNotes", () => {
  it("detects map notes as bridges", () => {
    const lg = makeLinkGraph([["a", "crypto map"], ["crypto map", "b"]]);
    const g = buildGraphologyGraph(lg);
    const bridges = findBridgeNotes(g);
    expect(bridges.has("crypto map")).toBe(true);
  });

  it("detects index as bridge", () => {
    const lg = makeLinkGraph([["a", "index"]]);
    const g = buildGraphologyGraph(lg);
    const bridges = findBridgeNotes(g);
    expect(bridges.has("index")).toBe(true);
  });

  it("detects articulation points", () => {
    // Linear chain: a -> bridge -> b (bridge is the only connection)
    const lg = makeLinkGraph([["a", "bridge"], ["bridge", "b"]]);
    const g = buildGraphologyGraph(lg);
    const bridges = findBridgeNotes(g);
    expect(bridges.has("bridge")).toBe(true);
  });
});

describe("computeBetweenness", () => {
  it("returns scores for all nodes", () => {
    const lg = makeLinkGraph([["a", "b"], ["b", "c"]]);
    const g = buildGraphologyGraph(lg);
    const bc = computeBetweenness(g);
    expect(bc.size).toBe(3);
    // b should have highest betweenness (on the path a->b->c)
    expect(bc.get("b")!).toBeGreaterThanOrEqual(bc.get("a")!);
  });
});

describe("computeGraphMetrics", () => {
  it("returns all metric fields", () => {
    const lg = makeLinkGraph([["a", "b"], ["b", "c"], ["c", "a"]]);
    const metrics = computeGraphMetrics(lg);
    expect(metrics.pagerank.size).toBe(3);
    expect(metrics.communities.size).toBe(3);
    expect(metrics.bridges).toBeDefined();
    expect(metrics.betweenness.size).toBe(3);
    expect(metrics.communityStats.size).toBeGreaterThan(0);
  });
});

describe("personalizedPageRank", () => {
  it("returns higher scores near seed nodes", () => {
    const lg = makeLinkGraph([["a", "b"], ["b", "c"], ["c", "d"], ["d", "e"]]);
    const g = buildGraphologyGraph(lg);
    const ppr = personalizedPageRank(g, ["a"]);
    // a and b should score higher than d and e
    expect(ppr.get("a")! + ppr.get("b")!).toBeGreaterThan(ppr.get("d")! + ppr.get("e")!);
  });

  it("handles empty seeds gracefully", () => {
    const lg = makeLinkGraph([["a", "b"]]);
    const g = buildGraphologyGraph(lg);
    const ppr = personalizedPageRank(g, []);
    expect(ppr.size).toBe(2);
  });

  it("handles nonexistent seed nodes", () => {
    const lg = makeLinkGraph([["a", "b"]]);
    const g = buildGraphologyGraph(lg);
    const ppr = personalizedPageRank(g, ["nonexistent"]);
    expect(ppr.size).toBe(2);
  });
});
