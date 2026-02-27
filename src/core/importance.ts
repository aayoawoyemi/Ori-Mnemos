import Graph from "graphology";
import pagerank from "graphology-metrics/centrality/pagerank.js";
import betweennessCentrality from "graphology-metrics/centrality/betweenness.js";
import louvain from "graphology-communities-louvain";
import type { LinkGraph } from "./graph.js";

export interface CommunityInfo {
  size: number;
  members: string[];
  meanVitality?: number;
  freshness?: number;
}

export interface GraphMetrics {
  pagerank: Map<string, number>;
  communities: Map<string, number>;
  bridges: Set<string>;
  betweenness: Map<string, number>;
  communityStats: Map<number, CommunityInfo>;
}

export interface NoteIndex {
  frontmatter: Map<string, Record<string, unknown>>;
}

/**
 * Convert the simple LinkGraph from graph.ts into a graphology DirectedGraph.
 */
export function buildGraphologyGraph(linkGraph: LinkGraph): Graph {
  const graph = new Graph({ type: "directed", multi: false });

  // Add all nodes (from both outgoing keys and incoming keys)
  const allNodes = new Set<string>();
  for (const key of linkGraph.outgoing.keys()) allNodes.add(key);
  for (const key of linkGraph.incoming.keys()) allNodes.add(key);
  // Also add targets that might only appear as targets
  for (const targets of linkGraph.outgoing.values()) {
    for (const t of targets) allNodes.add(t);
  }

  for (const node of allNodes) {
    if (!graph.hasNode(node)) graph.addNode(node);
  }

  // Add edges
  for (const [source, targets] of linkGraph.outgoing) {
    for (const target of targets) {
      if (!graph.hasEdge(source, target)) {
        graph.addEdge(source, target);
      }
    }
  }

  return graph;
}

/**
 * Compute PageRank scores for all nodes.
 */
export function computePageRank(
  graph: Graph,
  alpha: number = 0.85
): Map<string, number> {
  const scores = pagerank(graph, { alpha, getEdgeWeight: null });
  const result = new Map<string, number>();
  graph.forEachNode((node) => {
    result.set(node, scores[node] ?? 0);
  });
  return result;
}

/**
 * Detect communities using Louvain algorithm.
 */
export function detectCommunities(graph: Graph): Map<string, number> {
  // Louvain needs undirected — create undirected copy
  const undirected = new Graph({ type: "undirected", multi: false });
  graph.forEachNode((node) => {
    if (!undirected.hasNode(node)) undirected.addNode(node);
  });
  graph.forEachEdge((_edge, _attrs, source, target) => {
    if (!undirected.hasNode(source)) undirected.addNode(source);
    if (!undirected.hasNode(target)) undirected.addNode(target);
    if (source !== target && !undirected.hasEdge(source, target)) {
      undirected.addEdge(source, target);
    }
  });

  const communities = louvain(undirected);
  const result = new Map<string, number>();
  for (const [node, community] of Object.entries(communities)) {
    result.set(node, community as number);
  }
  return result;
}

/**
 * Find bridge notes: articulation points + high-degree hubs + map notes + cross-project connectors.
 * Uses a simplified Tarjan's algorithm for articulation points.
 */
export function findBridgeNotes(
  graph: Graph,
  noteIndex?: NoteIndex
): Set<string> {
  const bridges = new Set<string>();

  // 1. Tarjan's algorithm for articulation points on undirected view
  const visited = new Set<string>();
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | null>();
  let timer = 0;

  function dfs(u: string) {
    visited.add(u);
    disc.set(u, timer);
    low.set(u, timer);
    timer++;
    let children = 0;

    // Get neighbors (both directions for undirected view)
    const neighbors = new Set<string>();
    graph.forEachOutNeighbor(u, (n) => neighbors.add(n));
    graph.forEachInNeighbor(u, (n) => neighbors.add(n));

    for (const v of neighbors) {
      if (!visited.has(v)) {
        children++;
        parent.set(v, u);
        dfs(v);

        low.set(u, Math.min(low.get(u)!, low.get(v)!));

        // u is an articulation point if:
        // 1. u is root of DFS tree and has 2+ children
        if (parent.get(u) === null && children > 1) {
          bridges.add(u);
        }
        // 2. u is not root and low[v] >= disc[u]
        if (parent.get(u) !== null && low.get(v)! >= disc.get(u)!) {
          bridges.add(u);
        }
      } else if (v !== parent.get(u)) {
        low.set(u, Math.min(low.get(u)!, disc.get(v)!));
      }
    }
  }

  graph.forEachNode((node) => {
    if (!visited.has(node)) {
      parent.set(node, null);
      dfs(node);
    }
  });

  // 2. High-degree hubs: in_degree > 2x median
  const inDegrees: number[] = [];
  graph.forEachNode((node) => {
    inDegrees.push(graph.inDegree(node));
  });
  inDegrees.sort((a, b) => a - b);
  const median = inDegrees.length > 0
    ? inDegrees[Math.floor(inDegrees.length / 2)]
    : 0;
  const hubThreshold = median * 2;

  graph.forEachNode((node) => {
    if (graph.inDegree(node) > hubThreshold && hubThreshold > 0) {
      bridges.add(node);
    }
  });

  // 3. Map notes (title ends with " map")
  graph.forEachNode((node) => {
    if (node.endsWith(" map") || node === "index") {
      bridges.add(node);
    }
  });

  // 4. Cross-project connectors (2+ project tags AND in_degree >= 3)
  if (noteIndex) {
    for (const [title, fm] of noteIndex.frontmatter) {
      const project = Array.isArray(fm.project) ? fm.project : [];
      if (project.length >= 2 && graph.hasNode(title) && graph.inDegree(title) >= 3) {
        bridges.add(title);
      }
    }
  }

  return bridges;
}

/**
 * Compute betweenness centrality for all nodes.
 */
export function computeBetweenness(graph: Graph): Map<string, number> {
  const scores = betweennessCentrality(graph);
  const result = new Map<string, number>();
  graph.forEachNode((node) => {
    result.set(node, scores[node] ?? 0);
  });
  return result;
}

/**
 * Compute all graph metrics in one pass.
 */
export function computeGraphMetrics(
  linkGraph: LinkGraph,
  noteIndex?: NoteIndex
): GraphMetrics {
  const graph = buildGraphologyGraph(linkGraph);
  const pr = computePageRank(graph);
  const communities = detectCommunities(graph);
  const bridges = findBridgeNotes(graph, noteIndex);
  const betweenness = computeBetweenness(graph);

  // Build community stats
  const communityStats = new Map<number, CommunityInfo>();
  for (const [node, communityId] of communities) {
    if (!communityStats.has(communityId)) {
      communityStats.set(communityId, { size: 0, members: [] });
    }
    const stat = communityStats.get(communityId)!;
    stat.size++;
    stat.members.push(node);
  }

  return { pagerank: pr, communities, bridges, betweenness, communityStats };
}

/**
 * Personalized PageRank from seed nodes.
 * Used for query-time graph traversal (Signal 3 in the retrieval pipeline).
 */
export function personalizedPageRank(
  graph: Graph,
  seeds: string[],
  alpha: number = 0.85,
  iterations: number = 20
): Map<string, number> {
  const N = graph.order;
  if (N === 0) return new Map();

  // Initialize: seed nodes get equal personalization weight
  const personalization = new Map<string, number>();
  const validSeeds = seeds.filter((s) => graph.hasNode(s));
  if (validSeeds.length === 0) {
    // Fallback to uniform
    graph.forEachNode((node) => personalization.set(node, 1 / N));
  } else {
    graph.forEachNode((node) => personalization.set(node, 0));
    for (const seed of validSeeds) {
      personalization.set(seed, 1 / validSeeds.length);
    }
  }

  // Power iteration
  let scores = new Map<string, number>(personalization);

  for (let iter = 0; iter < iterations; iter++) {
    const newScores = new Map<string, number>();
    graph.forEachNode((node) => newScores.set(node, 0));

    graph.forEachNode((node) => {
      const outDeg = graph.outDegree(node);
      if (outDeg === 0) return;
      const share = (scores.get(node) ?? 0) / outDeg;
      graph.forEachOutNeighbor(node, (neighbor) => {
        newScores.set(neighbor, (newScores.get(neighbor) ?? 0) + share);
      });
    });

    // Apply damping + personalization restart
    graph.forEachNode((node) => {
      const dampedScore = alpha * (newScores.get(node) ?? 0);
      const restart = (1 - alpha) * (personalization.get(node) ?? 0);
      newScores.set(node, dampedScore + restart);
    });

    scores = newScores;
  }

  return scores;
}
