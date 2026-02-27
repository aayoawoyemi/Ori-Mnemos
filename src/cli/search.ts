import path from "node:path";
import { promises as fs } from "node:fs";
import { findVaultRoot, getVaultPaths, listNoteTitles } from "../core/vault.js";
import { buildGraph } from "../core/graph.js";
import { loadConfig } from "../core/config.js";
import { classifyIntent } from "../core/intent.js";
import {
  buildIndex,
  searchComposite,
  loadVectors,
  initDB,
} from "../core/engine.js";
import { buildBM25IndexFromVault, searchBM25 } from "../core/bm25.js";
import {
  computeGraphMetrics,
  personalizedPageRank,
  buildGraphologyGraph,
} from "../core/importance.js";
import type { NoteIndex } from "../core/importance.js";
import { computeVitalityFull } from "../core/vitality.js";
import { fuseScoreWeightedRRF } from "../core/fusion.js";
import { injectExploration, logAccess } from "../core/tracking.js";
import type { ScoredNote } from "../core/ranking.js";
import { parseFrontmatter } from "../core/frontmatter.js";

export type SearchResult = {
  success: boolean;
  data: {
    query: string;
    intent?: string;
    results: ScoredNote[];
    count: number;
  };
  warnings: string[];
};

/**
 * Full ranked retrieval pipeline:
 * composite vector search + BM25 keyword + personalized PageRank,
 * fused via score-weighted RRF, with exploration injection.
 */
export async function runQueryRanked(
  startDir: string,
  query: string,
  limit?: number,
): Promise<SearchResult> {
  const warnings: string[] = [];

  // 1. Vault setup
  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);
  const resultLimit = limit ?? config.retrieval.default_limit;
  const candidateLimit = resultLimit * config.retrieval.candidate_multiplier;

  // 2. Build link graph
  const linkGraph = await buildGraph(paths.notes);

  // 3. Graph metrics (PageRank, communities, bridges)
  const allTitles = await listNoteTitles(paths.notes);
  const noteIndex = await buildNoteIndex(paths.notes, allTitles);
  const graphMetrics = computeGraphMetrics(linkGraph, noteIndex);

  // 4. Compute vitality for all notes
  const vitalityScores = await computeAllVitality(
    paths.notes,
    allTitles,
    linkGraph,
    graphMetrics.bridges,
    config,
  );

  // 5. Classify query intent
  const classified = classifyIntent(query, allTitles);

  // 6. Ensure embedding index exists
  const dbPath = path.resolve(vaultRoot, config.engine.db_path);
  let dbExists = true;
  try {
    await fs.access(dbPath);
  } catch {
    dbExists = false;
  }

  if (!dbExists) {
    warnings.push("Embedding index not found — building now (this may take a moment)");
    await buildIndex(vaultRoot, config.engine);
  }

  const db = initDB(dbPath);
  const rowCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM embeddings").get() as { cnt: number }
  ).cnt;

  if (rowCount === 0) {
    db.close();
    warnings.push("Embedding index is empty — building now");
    await buildIndex(vaultRoot, config.engine);
    // Re-open after build
    const db2 = initDB(dbPath);
    var storedVectors = loadVectors(db2);
    db2.close();
  } else {
    var storedVectors = loadVectors(db);
    db.close();
  }

  // 8. Signal 1: composite vector search
  const compositeResults = await searchComposite({
    queryText: query,
    intent: classified,
    storedVectors,
    graphMetrics,
    vitalityScores,
    limit: candidateLimit,
    config: config.engine,
  });

  // 9. Signal 2: BM25 keyword search
  const bm25Index = await buildBM25IndexFromVault(vaultRoot, config.bm25);
  const keywordResults = searchBM25(query, bm25Index, config.bm25, candidateLimit);

  // 10. Signal 3: personalized PageRank from entity seeds
  const gGraph = buildGraphologyGraph(linkGraph);
  const pprScores = personalizedPageRank(
    gGraph,
    classified.entities,
    config.graph.pagerank_alpha,
  );
  const graphResults: ScoredNote[] = Array.from(pprScores.entries())
    .map(([title, score]) => ({
      title,
      score,
      signals: { graph: score },
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, candidateLimit);

  // 11. Fuse with score-weighted RRF
  const fused = fuseScoreWeightedRRF(
    { composite: compositeResults, keyword: keywordResults, graph: graphResults },
    config.retrieval,
  );

  // 12. Trim to limit, then inject exploration
  const trimmed = fused.slice(0, resultLimit);
  const withExploration = injectExploration(
    trimmed,
    allTitles,
    config.retrieval.exploration_budget,
  );

  // 13. Log access event
  await logAccess(
    vaultRoot,
    {
      timestamp: new Date().toISOString(),
      query,
      intent: classified.intent,
      results: withExploration.map((r, i) => ({
        title: r.title,
        rank: i,
        score: r.score,
        propensity: 0, // propensity computed post-hoc
        wasExploration: r.metadata?.wasExploration === true,
      })),
    },
    config.ips,
  );

  return {
    success: true,
    data: {
      query,
      intent: classified.intent,
      results: withExploration,
      count: withExploration.length,
    },
    warnings,
  };
}

/**
 * Composite vector search only — no BM25, no graph signal, no RRF fusion.
 */
export async function runQuerySimilar(
  startDir: string,
  query: string,
  limit?: number,
): Promise<SearchResult> {
  const warnings: string[] = [];

  // 1. Vault setup
  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);
  const resultLimit = limit ?? config.retrieval.default_limit;

  // 2. Build graph + metrics + vitality
  const linkGraph = await buildGraph(paths.notes);
  const allTitles = await listNoteTitles(paths.notes);
  const noteIndex = await buildNoteIndex(paths.notes, allTitles);
  const graphMetrics = computeGraphMetrics(linkGraph, noteIndex);
  const vitalityScores = await computeAllVitality(
    paths.notes,
    allTitles,
    linkGraph,
    graphMetrics.bridges,
    config,
  );

  // 3. Classify intent
  const classified = classifyIntent(query, allTitles);

  // 4. Ensure index exists
  const dbPath = path.resolve(vaultRoot, config.engine.db_path);
  let dbExists = true;
  try {
    await fs.access(dbPath);
  } catch {
    dbExists = false;
  }

  if (!dbExists) {
    warnings.push("Embedding index not found — building now (this may take a moment)");
    await buildIndex(vaultRoot, config.engine);
  }

  const db = initDB(dbPath);
  const rowCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM embeddings").get() as { cnt: number }
  ).cnt;

  let vectors: Map<string, import("../core/engine.js").StoredVectors>;
  if (rowCount === 0) {
    db.close();
    warnings.push("Embedding index is empty — building now");
    await buildIndex(vaultRoot, config.engine);
    const db2 = initDB(dbPath);
    vectors = loadVectors(db2);
    db2.close();
  } else {
    vectors = loadVectors(db);
    db.close();
  }

  // 5. Composite search only
  const results = await searchComposite({
    queryText: query,
    intent: classified,
    storedVectors: vectors,
    graphMetrics,
    vitalityScores,
    limit: resultLimit,
    config: config.engine,
  });

  return {
    success: true,
    data: {
      query,
      intent: classified.intent,
      results,
      count: results.length,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/**
 * Build a NoteIndex (frontmatter map) for all notes in a directory.
 */
async function buildNoteIndex(
  notesDir: string,
  titles: string[],
): Promise<NoteIndex> {
  const frontmatter = new Map<string, Record<string, unknown>>();

  for (const title of titles) {
    const filePath = path.join(notesDir, `${title}.md`);
    try {
      const content = await fs.readFile(filePath, "utf8");
      const { data } = parseFrontmatter(content);
      if (data) {
        frontmatter.set(title, data);
      }
    } catch {
      // skip unreadable files
    }
  }

  return { frontmatter };
}

/**
 * Compute vitality scores for all notes using the full ACT-R model.
 */
async function computeAllVitality(
  notesDir: string,
  titles: string[],
  linkGraph: import("../core/graph.js").LinkGraph,
  bridges: Set<string>,
  config: import("../core/config.js").OriConfig,
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const now = new Date();

  for (const title of titles) {
    const filePath = path.join(notesDir, `${title}.md`);
    let accessCount = 0;
    let created = now.toISOString();

    try {
      const content = await fs.readFile(filePath, "utf8");
      const { data } = parseFrontmatter(content);
      if (data) {
        if (typeof data.access_count === "number") {
          accessCount = data.access_count;
        }
        if (typeof data.created === "string") {
          created = data.created;
        }
      }
    } catch {
      // use defaults
    }

    const inDegree = linkGraph.incoming.get(title)?.size ?? 0;

    const vitality = computeVitalityFull({
      accessCount,
      created,
      noteTitle: title,
      inDegree,
      bridges,
      metabolicRate: config.vitality.metabolic_rates?.notes ?? 1.0,
      actrDecay: config.vitality.actr_decay ?? 0.5,
      accessSaturationK: config.vitality.access_saturation_k ?? 10,
      bridgeFloor: config.graph.bridge_vitality_floor,
    });

    scores.set(title, vitality);
  }

  return scores;
}
