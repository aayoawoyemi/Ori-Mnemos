import { findVaultRoot, getVaultPaths, listNoteTitles } from "../core/vault.js";
import { buildGraph } from "../core/graph.js";
import { computeGraphMetrics } from "../core/importance.js";
import { buildNoteIndex } from "../core/noteindex.js";

export type GraphMetricsResult = {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
};

export type GraphCommunitiesResult = {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
};

/**
 * Compute and return graph-level metrics: node/edge counts, community count,
 * bridge count, top PageRank nodes, and top betweenness centrality nodes.
 */
export async function runGraphMetrics(
  startDir: string,
): Promise<GraphMetricsResult> {
  const warnings: string[] = [];

  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);
  const allTitles = await listNoteTitles(paths.notes);

  const linkGraph = await buildGraph(paths.notes);
  const noteIndex = await buildNoteIndex(paths.notes, allTitles);
  const metrics = computeGraphMetrics(linkGraph, noteIndex);

  // Count edges
  let edgeCount = 0;
  for (const targets of linkGraph.outgoing.values()) {
    edgeCount += targets.size;
  }

  // All nodes (union of outgoing keys and all targets)
  const allNodes = new Set<string>();
  for (const key of linkGraph.outgoing.keys()) allNodes.add(key);
  for (const targets of linkGraph.outgoing.values()) {
    for (const t of targets) allNodes.add(t);
  }

  // Top 10 PageRank
  const topPageRank = Array.from(metrics.pagerank.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([title, score]) => ({ title, score }));

  // Top 10 betweenness
  const topBetweenness = Array.from(metrics.betweenness.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([title, score]) => ({ title, score }));

  return {
    success: true,
    data: {
      nodeCount: allNodes.size,
      edgeCount,
      communityCount: metrics.communityStats.size,
      bridgeCount: metrics.bridges.size,
      topPageRank,
      topBetweenness,
    },
    warnings,
  };
}

/**
 * Detect and return community assignments sorted by community size descending.
 */
export async function runGraphCommunities(
  startDir: string,
): Promise<GraphCommunitiesResult> {
  const warnings: string[] = [];

  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);
  const allTitles = await listNoteTitles(paths.notes);

  const linkGraph = await buildGraph(paths.notes);
  const noteIndex = await buildNoteIndex(paths.notes, allTitles);
  const metrics = computeGraphMetrics(linkGraph, noteIndex);

  // Build communities array sorted by size descending
  const communities = Array.from(metrics.communityStats.entries())
    .map(([id, info]) => ({
      id,
      size: info.size,
      members: info.members.sort(),
    }))
    .sort((a, b) => b.size - a.size);

  return {
    success: true,
    data: { communities },
    warnings,
  };
}
