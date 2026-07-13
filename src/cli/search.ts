import path from "node:path";
import { promises as fs } from "node:fs";
import type Database from "better-sqlite3";
import { findVaultRoot, getVaultPaths, listNoteTitles } from "../core/vault.js";
import { buildGraph, type LinkGraph } from "../core/graph.js";
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
import { fuseScoreWeightedRRF, normalizeSignalWeights } from "../core/fusion.js";
import { injectExploration, logAccess } from "../core/tracking.js";
import type { ScoredNote } from "../core/ranking.js";
import { buildNoteIndex, computeAllVitality } from "../core/noteindex.js";
import { loadBoosts, applyActivationBoosts, computeActivationSpread } from "../core/activation.js";
import { WarmthService, type WarmthSignal } from "../core/warmth.js";
import {
  isWarmthAuditEnabled,
  logWarmthAudit,
  queryWarmthAudit,
  type WarmthAuditEntry,
  type WarmthAuditEvent,
} from "../core/warmth-audit.js";
// Retrieval intelligence layers
import { phaseB } from "../core/rerank.js";
import { personalizedPageRankCombined } from "../core/ppr.js";
import {
  loadStage,
  saveStage,
  getStageDecision,
  computeStageReward,
  extractQueryFeatures,
  logStageDecision,
  STAGE_CONFIGS,
  type StageConfig,
} from "../core/stage-learner.js";
import { StageTracker, measureCurrentQuality } from "../core/stage-tracker.js";
import {
  applyGravityDampening,
  applyHubDampening,
  applyResolutionBoost,
} from "../core/dampening.js";

type WarmthRankShift = {
  title: string;
  beforeRank: number;
  afterRank: number;
  movement: number;
  warmth: number;
};

type WarmthDebug = {
  enabled: boolean;
  weight: number;
  candidates: number;
  promoted: WarmthRankShift[];
  demoted: WarmthRankShift[];
};

type WarmthQueryResult = {
  success: boolean;
  data: {
    context: string;
    results: WarmthSignal[];
    count: number;
  };
  warnings: string[];
};

export type SearchResult = {
  success: boolean;
  data: {
    query: string;
    intent?: string;
    results: ScoredNote[];
    count: number;
    warmth?: WarmthDebug;
  };
  warnings: string[];
};

const warmthService = new WarmthService();

function buildWarmthAuditEntries(
  results: ScoredNote[],
  limit: number,
): { withWarmth: WarmthAuditEntry[]; withoutWarmth: WarmthAuditEntry[] } {
  const finalResults = results.slice(0, limit);
  const baseResults = [...results]
    .sort((a, b) => (b.signals.rrf_base ?? 0) - (a.signals.rrf_base ?? 0))
    .slice(0, limit);
  const finalRanks = new Map(finalResults.map((note, index) => [note.title, index + 1]));
  const baseRanks = new Map(baseResults.map((note, index) => [note.title, index + 1]));
  const noteMap = new Map(results.map((note) => [note.title, note]));

  const toEntry = (title: string): WarmthAuditEntry => {
    const note = noteMap.get(title)!;
    const finalRank = finalRanks.get(title) ?? null;
    const baseRank = baseRanks.get(title) ?? null;
    return {
      title,
      finalRank,
      baseRank,
      finalScore: note.signals.rrf ?? note.score,
      baseScore: note.signals.rrf_base ?? note.score,
      warmthScore: note.signals.warmth ?? 0,
      movement:
        finalRank !== null && baseRank !== null
          ? baseRank - finalRank
          : finalRank !== null
            ? limit + 1 - finalRank
            : baseRank !== null
              ? -(limit + 1 - baseRank)
              : 0,
    };
  };

  return {
    withWarmth: finalResults.map((note) => toEntry(note.title)),
    withoutWarmth: baseResults.map((note) => toEntry(note.title)),
  };
}

function summarizeWarmthInfluence(
  results: ScoredNote[],
  enabled: boolean,
  weight: number,
  candidates: number,
): WarmthDebug {
  const finalResults = [...results];
  const baseResults = [...results].sort(
    (a, b) => (b.signals.rrf_base ?? 0) - (a.signals.rrf_base ?? 0),
  );
  const baseRanks = new Map(baseResults.map((note, index) => [note.title, index + 1]));
  const finalRanks = new Map(finalResults.map((note, index) => [note.title, index + 1]));

  const shifts = finalResults
    .map<WarmthRankShift>((note) => {
      const beforeRank = baseRanks.get(note.title) ?? finalResults.length + 1;
      const afterRank = finalRanks.get(note.title) ?? finalResults.length + 1;
      return {
        title: note.title,
        beforeRank,
        afterRank,
        movement: beforeRank - afterRank,
        warmth: note.signals.warmth ?? 0,
      };
    })
    .filter((note) => note.movement !== 0);

  const promoted = shifts
    .filter((note) => note.movement > 0)
    .sort((a, b) => b.movement - a.movement || b.warmth - a.warmth)
    .slice(0, 5);
  const demoted = shifts
    .filter((note) => note.movement < 0)
    .sort((a, b) => a.movement - b.movement || b.warmth - a.warmth)
    .slice(0, 5);

  return { enabled, weight, candidates, promoted, demoted };
}

/**
 * Full ranked retrieval pipeline:
 * composite vector search + BM25 keyword + personalized PageRank,
 * fused via score-weighted RRF, with Phase B Q-value reranking,
 * co-occurrence PPR injection, and stage meta-learning.
 */
export async function runQueryRanked(
  startDir: string,
  query: string,
  limit?: number,
  excludeArchived?: boolean,
  linkGraph?: LinkGraph,
  externalDb?: Database.Database,
  sessionId?: string,
  stageTracker?: StageTracker,
): Promise<SearchResult> {
  const warnings: string[] = [];

  // 1. Vault setup
  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);
  const resultLimit = limit ?? config.retrieval.default_limit;
  const candidateLimit = resultLimit * config.retrieval.candidate_multiplier;

  // 2. Build link graph
  const graph = linkGraph ?? await buildGraph(paths.notes);

  // 3. Graph metrics (PageRank, communities, bridges)
  const allTitles = await listNoteTitles(paths.notes);
  const noteIndex = await buildNoteIndex(paths.notes, allTitles);
  const graphMetrics = computeGraphMetrics(graph, noteIndex);

  // 4. Ensure embedding index exists and open DB
  const dbPath = path.resolve(vaultRoot, config.engine.db_path);
  const ownDb = !externalDb; // track if we manage the DB lifecycle
  let mainDb: Database.Database;

  if (externalDb) {
    mainDb = externalDb;
  } else {
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
      mainDb = initDB(dbPath);
    } else {
      mainDb = db;
    }
  }

  const storedVectors = loadVectors(mainDb);

  // 5. Load activation boosts and compute vitality
  const boostScores = config.activation?.enabled !== false ? loadBoosts(mainDb) : undefined;
  const vitalityScores = await computeAllVitality(
    paths.notes,
    allTitles,
    graph,
    graphMetrics.bridges,
    config,
    boostScores,
  );

  // 6. Classify query intent
  const classified = classifyIntent(query, allTitles);

  // Stage meta-learning: load stages and prepare features if DB available
  const useIntelligence = !!externalDb && !!sessionId;
  const tracker = stageTracker ?? (useIntelligence ? new StageTracker() : undefined);
  const stages = useIntelligence
    ? STAGE_CONFIGS.map((c) => loadStage(mainDb, c))
    : undefined;
  const queryFeatures = useIntelligence
    ? extractQueryFeatures(query, 0, allTitles.length, 0)
    : undefined;
  let pipelineElapsed = 0;

  // Helper: check if a stage should run
  const shouldRun = (stageId: string): "run" | "skip" | "abstain" => {
    if (!stages || !queryFeatures) return "run";
    const stage = stages.find((s) => s.config.id === stageId);
    if (!stage) return "run";
    return getStageDecision(stage, queryFeatures, pipelineElapsed, stage.sampleCount);
  };

  // Helper: wrap a stage with quality tracking
  const trackStage = (stageId: string, candidates: ScoredNote[]): void => {
    if (tracker) tracker.before(stageId, measureCurrentQuality(candidates));
  };
  const trackStageAfter = (stageId: string, candidates: ScoredNote[]): void => {
    if (tracker) tracker.after(stageId, measureCurrentQuality(candidates));
  };

  // 8. Signal 1: composite vector search (essential — always runs)
  const t0 = performance.now();
  const compositeResults = await searchComposite({
    queryText: query,
    intent: classified,
    storedVectors,
    graphMetrics,
    vitalityScores,
    limit: candidateLimit,
    config: config.engine,
  });
  pipelineElapsed += performance.now() - t0;

  // 9. Signal 2: BM25 keyword search
  let keywordResults: ScoredNote[] = [];
  const bm25Decision = shouldRun("bm25");
  if (bm25Decision !== "abstain" && bm25Decision !== "skip") {
    trackStage("bm25", compositeResults);
    const t1 = performance.now();
    const bm25Index = await buildBM25IndexFromVault(vaultRoot, config.bm25);
    keywordResults = searchBM25(query, bm25Index, config.bm25, candidateLimit);
    pipelineElapsed += performance.now() - t1;
    trackStageAfter("bm25", [...compositeResults, ...keywordResults]);
  }

  // 10. Signal 3: personalized PageRank from entity seeds
  let graphResults: ScoredNote[] = [];
  const pagerankDecision = shouldRun("pagerank");
  if (pagerankDecision !== "abstain" && pagerankDecision !== "skip") {
    trackStage("pagerank", compositeResults);
    const t2 = performance.now();
    const gGraph = buildGraphologyGraph(graph);
    const pprScores = personalizedPageRank(
      gGraph,
      classified.entities,
      config.graph.pagerank_alpha,
    );
    graphResults = Array.from(pprScores.entries())
      .map(([title, score]) => ({
        title,
        score,
        signals: { graph: score },
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, candidateLimit);
    pipelineElapsed += performance.now() - t2;
    trackStageAfter("pagerank", graphResults);
  }

  // Signal 4: warmth
  let warmthResults: ScoredNote[] = [];
  const warmthDecision = shouldRun("warmth");
  if (warmthDecision !== "abstain" && warmthDecision !== "skip") {
    trackStage("warmth", compositeResults);
    const t3 = performance.now();
    const warmthSignals = await warmthService.scan(
      query,
      storedVectors,
      graph,
      config.engine,
      config.warmth,
      { limit: Math.max(config.warmth.max_results, candidateLimit) },
    );
    warmthResults = warmthSignals
      .map((signal) => ({
        title: signal.title,
        score: signal.score,
        signals: { warmth: signal.score },
        metadata: { warmthSource: signal.source },
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, candidateLimit);
    pipelineElapsed += performance.now() - t3;
    trackStageAfter("warmth", warmthResults);
  }

  // Layer 2: Co-occurrence PPR candidate injection (if DB available and table exists)
  let coocPprResults: ScoredNote[] = [];
  const coocDecision = shouldRun("cooccurrence_ppr");
  if (
    useIntelligence &&
    coocDecision !== "abstain" &&
    coocDecision !== "skip"
  ) {
    try {
      trackStage("cooccurrence_ppr", compositeResults);
      const t4 = performance.now();
      // Build seed map from top-5 composite results
      const pprSeeds = new Map(
        compositeResults.slice(0, 5).map((r) => [r.title, r.score]),
      );
      // Build wiki-link map for PPR
      const wikiLinkMap = new Map<string, string[]>();
      for (const [src, targets] of graph.outgoing) {
        wikiLinkMap.set(src, [...targets]);
      }
      const pprResults = personalizedPageRankCombined(
        mainDb,
        pprSeeds,
        wikiLinkMap,
        candidateLimit,
      );
      coocPprResults = pprResults.map((r) => ({
        title: r.noteId,
        score: r.score,
        signals: { graph: r.score },
        metadata: { source: "cooccurrence_ppr" },
      }));
      pipelineElapsed += performance.now() - t4;
      trackStageAfter("cooccurrence_ppr", coocPprResults);
    } catch {
      // co_occurrence table may not exist yet — skip silently
    }
  }

  // Merge co-occurrence PPR results into graph signal
  if (coocPprResults.length > 0) {
    const existingGraphTitles = new Set(graphResults.map((r) => r.title));
    for (const r of coocPprResults) {
      if (!existingGraphTitles.has(r.title)) {
        graphResults.push(r);
      }
    }
    graphResults.sort((a, b) => b.score - a.score);
  }

  // 11. Fuse with score-weighted RRF (essential — always runs)
  trackStage("rrf_fusion", compositeResults);
  const fused = fuseScoreWeightedRRF(
    {
      composite: compositeResults,
      keyword: keywordResults,
      graph: graphResults,
      warmth: warmthResults,
    },
    config.retrieval,
  );
  trackStageAfter("rrf_fusion", fused);

  // Drift dampening stages (post-fusion, pre-rerank)
  let dampened = fused;

  // Gravity dampening: halve score for zero-overlap semantic ghosts
  const gravityDecision = shouldRun("gravity_dampening");
  if (gravityDecision !== "abstain" && gravityDecision !== "skip") {
    trackStage("gravity_dampening", dampened);
    const tg = performance.now();
    const titleMap = new Map(allTitles.map((t) => [t, t]));
    dampened = applyGravityDampening(dampened, query, titleMap);
    pipelineElapsed += performance.now() - tg;
    trackStageAfter("gravity_dampening", dampened);
  }

  // Hub dampening: penalize top 10% by edge count
  const hubDecision = shouldRun("hub_dampening");
  if (hubDecision !== "abstain" && hubDecision !== "skip") {
    trackStage("hub_dampening", dampened);
    const th = performance.now();
    dampened = applyHubDampening(dampened, graph, classified.entities);
    pipelineElapsed += performance.now() - th;
    trackStageAfter("hub_dampening", dampened);
  }

  // Resolution boost: 1.25x for decision/learning notes
  const noteTypes = new Map<string, string>();
  for (const [title, fm] of noteIndex.frontmatter) {
    if (typeof fm.type === "string") noteTypes.set(title, fm.type);
  }
  dampened = applyResolutionBoost(dampened, noteTypes);

  // Re-sort after dampening
  dampened.sort((a, b) => b.score - a.score);

  // Layer 1: Phase B Q-value reranking
  let ranked = dampened;
  const qRerankDecision = shouldRun("q_reranking");
  if (
    useIntelligence &&
    sessionId &&
    qRerankDecision !== "abstain" &&
    qRerankDecision !== "skip"
  ) {
    trackStage("q_reranking", dampened);
    const t5 = performance.now();
    ranked = phaseB(mainDb, dampened, query, classified.intent, sessionId);
    pipelineElapsed += performance.now() - t5;
    trackStageAfter("q_reranking", ranked);
  }

  // 12. Filter archived before trimming — ensures full result count
  const filtered = excludeArchived !== false
    ? ranked.filter(note => {
        const fm = noteIndex.frontmatter.get(note.title);
        return fm?.status !== 'archived';
      })
    : ranked;
  const warmthDebug = summarizeWarmthInfluence(
    filtered,
    config.warmth.enabled !== false,
    normalizeSignalWeights(config.retrieval.signal_weights).warmth,
    warmthResults.length,
  );
  const auditEntries = buildWarmthAuditEntries(filtered, resultLimit);

  // 13. Trim to limit, then inject exploration
  const trimmed = filtered.slice(0, resultLimit);
  const withExploration = injectExploration(
    trimmed,
    allTitles,
    config.retrieval.exploration_budget,
  );

  // 14. Log access event
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

  if (isWarmthAuditEnabled()) {
    const auditEvent: WarmthAuditEvent = {
      timestamp: new Date().toISOString(),
      query,
      intent: classified.intent,
      limit: resultLimit,
      effectiveWarmthWeight: normalizeSignalWeights(config.retrieval.signal_weights).warmth,
      withWarmth: auditEntries.withWarmth,
      withoutWarmth: auditEntries.withoutWarmth,
      promoted: auditEntries.withWarmth.filter((entry) => entry.movement > 0).slice(0, 10),
      demoted: auditEntries.withWarmth.filter((entry) => entry.movement < 0).slice(0, 10),
    };
    await logWarmthAudit(vaultRoot, auditEvent);
  }

  // 15. Spreading activation: propagate boosts to neighbors of top results
  if (config.activation?.enabled !== false) {
    const allBoosts = new Map<string, number>();
    for (const result of withExploration.slice(0, 3)) {
      const spread = computeActivationSpread(
        result.title,
        result.score,
        graph,
        config.activation,
      );
      for (const [title, boost] of spread.propagated) {
        allBoosts.set(title, (allBoosts.get(title) ?? 0) + boost);
      }
    }
    if (allBoosts.size > 0) {
      applyActivationBoosts(mainDb, allBoosts, sessionId);
    }
  }

  // 16. Close DB only if we opened it ourselves
  if (ownDb) {
    mainDb.close();
  }

  return {
    success: true,
    data: {
      query,
      intent: classified.intent,
      results: withExploration,
      count: withExploration.length,
      warmth: config.warmth.shadow_compare_enabled ? warmthDebug : undefined,
    },
    warnings,
  };
}

export async function runQueryWarmth(
  startDir: string,
  context: string,
  limit?: number,
  linkGraph?: LinkGraph,
): Promise<WarmthQueryResult> {
  const warnings: string[] = [];

  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);
  const resultLimit = limit ?? config.warmth.max_results;
  const graph = linkGraph ?? await buildGraph(paths.notes);

  const dbPath = path.resolve(vaultRoot, config.engine.db_path);
  let dbExists = true;
  try {
    await fs.access(dbPath);
  } catch {
    dbExists = false;
  }

  if (!dbExists) {
    warnings.push("Embedding index not found â€” building now (this may take a moment)");
    await buildIndex(vaultRoot, config.engine);
  }

  const db = initDB(dbPath);
  const rowCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM embeddings").get() as { cnt: number }
  ).cnt;

  if (rowCount === 0) {
    db.close();
    warnings.push("Embedding index is empty â€” building now");
    await buildIndex(vaultRoot, config.engine);
  }

  const mainDb = rowCount === 0 ? initDB(dbPath) : db;
  const storedVectors = loadVectors(mainDb);
  const results = await warmthService.scan(
    context,
    storedVectors,
    graph,
    config.engine,
    config.warmth,
    { limit: resultLimit },
  );
  mainDb.close();

  return {
    success: true,
    data: {
      context,
      results,
      count: results.length,
    },
    warnings,
  };
}

export async function runQueryWarmthAudit(
  startDir: string,
  query?: string,
  limit?: number,
): Promise<{
  success: boolean;
  data: { events: WarmthAuditEvent[]; count: number; query?: string };
  warnings: string[];
}> {
  const vaultRoot = await findVaultRoot(startDir);
  const events = await queryWarmthAudit(vaultRoot, {
    query,
    limit,
  });

  return {
    success: true,
    data: {
      events,
      count: events.length,
      query,
    },
    warnings: isWarmthAuditEnabled()
      ? []
      : ["Warmth audit logging is currently off. Set ORI_WARMTH_AUDIT=1 before running ranked queries to collect diffs."],
  };
}

/**
 * Composite vector search only — no BM25, no graph signal, no RRF fusion.
 */
export async function runQuerySimilar(
  startDir: string,
  query: string,
  limit?: number,
  excludeArchived?: boolean,
  linkGraph?: LinkGraph,
): Promise<SearchResult> {
  const warnings: string[] = [];

  // 1. Vault setup
  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);
  const resultLimit = limit ?? config.retrieval.default_limit;

  // 2. Build graph + metrics + vitality
  const graph = linkGraph ?? await buildGraph(paths.notes);
  const allTitles = await listNoteTitles(paths.notes);
  const noteIndex = await buildNoteIndex(paths.notes, allTitles);
  const graphMetrics = computeGraphMetrics(graph, noteIndex);
  const vitalityScores = await computeAllVitality(
    paths.notes,
    allTitles,
    graph,
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

  // 5. Composite search only (fetch extra candidates if filtering archived)
  const compositeLimit = excludeArchived !== false
    ? resultLimit * config.retrieval.candidate_multiplier
    : resultLimit;
  const compositeResults = await searchComposite({
    queryText: query,
    intent: classified,
    storedVectors: vectors,
    graphMetrics,
    vitalityScores,
    limit: compositeLimit,
    config: config.engine,
  });

  // 6. Filter archived before trimming
  const filtered = excludeArchived !== false
    ? compositeResults.filter(note => {
        const fm = noteIndex.frontmatter.get(note.title);
        return fm?.status !== 'archived';
      })
    : compositeResults;
  const results = filtered.slice(0, resultLimit);

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
