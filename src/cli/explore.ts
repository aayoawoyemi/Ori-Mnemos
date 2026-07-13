/**
 * CLI orchestrator for ori_explore — deep graph traversal via PPR.
 * Follows the same vault setup pattern as runQueryRanked in search.ts.
 */

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
import { computeGraphMetrics, personalizedPageRank, buildGraphologyGraph } from "../core/importance.js";
import { fuseScoreWeightedRRF } from "../core/fusion.js";
import type { SignalResults } from "../core/fusion.js";
import { rankByImportance, type ScoredNote } from "../core/ranking.js";
import { buildNoteIndex, computeAllVitality } from "../core/noteindex.js";
import { loadBoosts, applyActivationBoosts, computeActivationSpread } from "../core/activation.js";
import { WarmthService } from "../core/warmth.js";
import type { StageTracker } from "../core/stage-tracker.js";
import { applyGravityDampening, applyHubDampening, applyResolutionBoost } from "../core/dampening.js";
import { injectExploration } from "../core/tracking.js";
import {
  explore,
  exploreRecursive,
  type ExploreNote,
  type ExplorePath,
  type RecursiveExploreOutput,
} from "../core/explore.js";
import { createProvider, NullProvider } from "../core/llm.js";
import { getDecayedQ, initQValueTables } from "../core/qvalue.js";
import type { LlmProvider } from "../core/llm.js";
import { isExploreAuditEnabled, logExploreAudit, type ExploreAuditEvent, type ExploreAuditNote } from "../core/explore-audit.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ExploreOptions {
  limit?: number;
  depth?: number;
  includeContent?: boolean;
  excludeArchived?: boolean;
  recursive?: boolean;
}

export type ExploreSearchResult = {
  success: boolean;
  data: {
    query: string;
    intent: string;
    results: ExploreNote[];
    paths: ExplorePath[];
    count: number;
    seed_count: number;
    ppr_alpha: number;
    depth: number;
    ppr_iterations: number;
    total_candidates_scored: number;
    elapsed_ms: number;
    // Phase 3 recursive fields
    recursion_depth?: number;
    sub_queries?: string[];
    converged?: boolean;
    per_pass_results?: Array<{
      query: string;
      depth: number;
      notesFound: number;
      newNotesAdded: number;
    }>;
  };
  warnings: string[];
};

/* ------------------------------------------------------------------ */
/*  Depth → PPR iterations mapping                                     */
/* ------------------------------------------------------------------ */

function depthToIterations(depth: number, base: number): number {
  if (depth <= 1) return Math.round(base * 0.5);  // shallow: 15
  if (depth >= 3) return Math.round(base * 1.67);  // deep: 50
  return base;                                      // standard: 30
}

/* ------------------------------------------------------------------ */
/*  Main orchestrator                                                  */
/* ------------------------------------------------------------------ */

export async function runExplore(
  startDir: string,
  query: string,
  options: ExploreOptions = {},
  linkGraph?: LinkGraph,
  externalDb?: Database.Database,
  _sessionId?: string,
  _stageTracker?: StageTracker,
): Promise<ExploreSearchResult> {
  const startTime = Date.now();
  const warnings: string[] = [];

  // 1. Vault setup
  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);

  const exploreConfig = { ...config.explore };
  if (options.limit) {
    exploreConfig.default_limit = Math.min(options.limit, exploreConfig.max_limit);
  }
  const depth = options.depth ?? exploreConfig.max_depth;
  exploreConfig.ppr_iterations = depthToIterations(depth, config.explore.ppr_iterations);

  // 2. Build link graph
  const graph = linkGraph ?? await buildGraph(paths.notes);

  // 3. Graph metrics
  const allTitles = await listNoteTitles(paths.notes);
  const noteIndex = await buildNoteIndex(paths.notes, allTitles);
  const graphMetrics = computeGraphMetrics(graph, noteIndex);

  // 4. Ensure embedding index exists and open DB
  const dbPath = path.resolve(vaultRoot, config.engine.db_path);
  const ownDb = !externalDb;
  let mainDb: Database.Database;

  if (externalDb) {
    mainDb = externalDb;
  } else {
    let dbExists = true;
    try { await fs.access(dbPath); } catch { dbExists = false; }
    if (!dbExists) {
      warnings.push("Embedding index not found — building now");
      await buildIndex(vaultRoot, config.engine);
    }
    const db = initDB(dbPath);
    const rowCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM embeddings").get() as { cnt: number }
    ).cnt;
    if (rowCount === 0) {
      db.close();
      await buildIndex(vaultRoot, config.engine);
      mainDb = initDB(dbPath);
    } else {
      mainDb = db;
    }
  }

  const storedVectors = loadVectors(mainDb);

  // 5. Load vitality + boosts
  const boostScores = config.activation?.enabled !== false ? loadBoosts(mainDb) : undefined;
  const vitalityScores = await computeAllVitality(
    paths.notes, allTitles, graph, graphMetrics.bridges, config, boostScores,
  );

  // 6. Classify intent
  const classified = classifyIntent(query, allTitles);

  // 7. Full flat pipeline (same as ori_query_ranked) — explore is a SUPERSET
  const resultLimit = exploreConfig.default_limit;
  const candidateLimit = resultLimit * config.retrieval.candidate_multiplier;

  const compositeResults = await searchComposite({
    queryText: query, intent: classified, storedVectors, graphMetrics,
    vitalityScores, limit: candidateLimit, config: config.engine,
  });

  const bm25Index = await buildBM25IndexFromVault(vaultRoot, config.bm25);
  const keywordResults = searchBM25(query, bm25Index, config.bm25, candidateLimit);

  // Entity-seeded PPR (flat's graph signal, α=0.85)
  const entities = classified.entities ?? [];
  const pprSeeds = entities.length > 0 ? entities : keywordResults.slice(0, 3).map((r) => r.title);
  const graphologyGraph = buildGraphologyGraph(graph);
  const pprScores = personalizedPageRank(graphologyGraph, pprSeeds, 0.85, 20);
  const graphResults = rankByImportance(allTitles, pprScores, candidateLimit);

  // Warmth signals
  const warmthSignals = new Map<string, number>();
  let warmthResults: ScoredNote[] = [];
  if (config.warmth.enabled) {
    try {
      const warmthService = new WarmthService();
      const signals = await warmthService.scan(
        query, storedVectors, graph, config.engine, config.warmth,
        { limit: config.warmth.max_results },
      );
      for (const s of signals) warmthSignals.set(s.title, s.score);
      warmthResults = signals.map((s) => ({ title: s.title, score: s.score, signals: { warmth: s.score } }));
    } catch { warnings.push("Warmth signals unavailable"); }
  }

  // 8. Fuse ALL 4 signals via score-weighted RRF (same as flat)
  const signals: SignalResults = {
    composite: compositeResults,
    keyword: keywordResults,
    graph: graphResults,
    warmth: warmthResults,
  };
  let flatResults = fuseScoreWeightedRRF(signals, config.retrieval);

  // 9. Apply dampening pipeline (same as flat)
  const titleMap = new Map<string, string>();
  for (const t of allTitles) titleMap.set(t, t);
  flatResults = applyGravityDampening(flatResults, query, titleMap);
  flatResults = applyHubDampening(flatResults, graph, entities);

  // Resolution boost (need note types from frontmatter)
  const noteTypes = new Map<string, string>();
  for (const [title, fm] of noteIndex.frontmatter) {
    if (typeof fm.type === "string") noteTypes.set(title, fm.type);
  }
  flatResults = applyResolutionBoost(flatResults, noteTypes);

  // 10. Filter archived
  if (options.excludeArchived !== false) {
    const archivedSet = new Set<string>();
    for (const [title, fm] of noteIndex.frontmatter) {
      if (fm.status === "archived") archivedSet.add(title);
    }
    flatResults = flatResults.filter((r) => !archivedSet.has(r.title));
  }

  // 11. Exploration injection
  flatResults = injectExploration(flatResults, allTitles, config.retrieval.exploration_budget);

  // Take top results as the flat baseline
  flatResults = flatResults.slice(0, resultLimit);

  // 12. Q-value lookup (real values if DB available)
  const qValueLookup = (title: string) => getDecayedQ(mainDb, title);

  // 13. Determine recursive mode
  const useRecursive = (options.recursive !== false) && exploreConfig.recursive_enabled;
  let llmProvider: LlmProvider = new NullProvider();
  if (useRecursive) {
    try { llmProvider = await createProvider(config.llm); }
    catch { warnings.push("LLM provider unavailable — falling back to single-pass explore"); }
  }
  const isRecursive = useRecursive && !(llmProvider instanceof NullProvider);

  // 14. Run explore (expands flat results with PPR discoveries)
  let output: Awaited<ReturnType<typeof explore>> & {
    recursionDepth?: number;
    subQueries?: string[];
    converged?: boolean;
    perPassResults?: Array<{ query: string; depth: number; notesFound: number; newNotesAdded: number }>;
  };

  if (isRecursive) {
    const reseed = async (subQuery: string) => {
      const subClassified = classifyIntent(subQuery, allTitles);
      const subCL = exploreConfig.seed_count * config.retrieval.candidate_multiplier;
      const subComp = await searchComposite({ queryText: subQuery, intent: subClassified, storedVectors, graphMetrics, vitalityScores, limit: subCL, config: config.engine });
      const subKw = searchBM25(subQuery, bm25Index, config.bm25, subCL);
      const subSig: SignalResults = { composite: subComp, keyword: subKw, graph: [], warmth: [] };
      return fuseScoreWeightedRRF(subSig, config.retrieval).slice(0, exploreConfig.seed_count);
    };

    output = await exploreRecursive({
      query, classified, linkGraph: graph, notesDir: paths.notes,
      warmthSignals, seedResults: flatResults, config: exploreConfig,
      qValueLookup, llmProvider, allTitles, reseed,
    });
  } else {
    output = await explore({
      query, classified, linkGraph: graph, notesDir: paths.notes,
      warmthSignals, flatResults, config: exploreConfig, qValueLookup,
      graphMetrics: { communities: graphMetrics.communities },
    });
  }

  // 11. Spreading activation for top-3 results
  if (config.activation?.enabled !== false && output.results.length > 0) {
    const boosts = new Map<string, number>();
    for (const note of output.results.slice(0, 3)) {
      const result = computeActivationSpread(note.title, note.score, graph, config.activation);
      for (const [target, boost] of result.propagated) {
        boosts.set(target, (boosts.get(target) ?? 0) + boost);
      }
    }
    if (boosts.size > 0) {
      applyActivationBoosts(mainDb, boosts, _sessionId);
    }
  }

  // Explore audit logging
  if (isExploreAuditEnabled()) {
    const flatTitleSet = new Set(flatResults.map((r) => r.title));
    const finalTitleSet = new Set(output.results.map((r) => r.title));

    const toAuditNote = (n: { title: string; score: number; pprScore: number; seedScore: number | null; warmthScore: number | null; source: string }): ExploreAuditNote => ({
      title: n.title,
      score: n.score,
      pprScore: n.pprScore,
      seedScore: n.seedScore,
      warmthScore: n.warmthScore,
      source: n.source,
    });

    const recursionGains = output.results
      .filter((r) => !flatTitleSet.has(r.title))
      .map(toAuditNote);

    const recursionLosses = flatResults
      .filter((r) => !finalTitleSet.has(r.title))
      .map((r) => ({
        title: r.title,
        score: r.score,
        pprScore: 0,
        seedScore: r.score,
        warmthScore: null,
        source: "flat" as string,
      }));

    // Build per-pass with timing and new note titles
    const perPassAudit = (output.perPassResults ?? []).map((p) => ({
      query: p.query,
      depth: p.depth,
      notesFound: p.notesFound,
      newNotesAdded: p.newNotesAdded,
      newNotes: [] as string[],  // individual note names aren't tracked per-pass in current impl
      elapsedMs: 0,  // per-pass timing not tracked yet
    }));

    const auditEvent: ExploreAuditEvent = {
      timestamp: new Date().toISOString(),
      query,
      intent: classified.intent,
      llmProvider: isRecursive ? (config.llm.provider ?? "none") : "none",
      llmModel: isRecursive ? (config.llm.model ?? "none") : "none",
      recursive: isRecursive,
      recursionDepth: output.recursionDepth ?? 0,
      converged: output.converged ?? false,
      totalElapsedMs: Date.now() - startTime,
      flatResults: flatResults.map((r) => ({
        title: r.title,
        score: r.score,
        pprScore: 0,
        seedScore: r.score,
        warmthScore: null,
        source: "flat" as string,
      })),
      finalResults: output.results.map(toAuditNote),
      recursionGains,
      recursionLosses,
      subQueries: output.subQueries ?? [],
      perPassResults: perPassAudit,
      pathCount: output.paths.length,
      totalCandidatesScored: output.totalCandidatesScored,
    };

    try {
      await logExploreAudit(vaultRoot, auditEvent);
    } catch {
      warnings.push("Explore audit logging failed");
    }
  }

  // Cleanup
  if (ownDb) mainDb.close();

  const elapsed = Date.now() - startTime;

  return {
    success: true,
    data: {
      query,
      intent: classified.intent,
      results: output.results,
      paths: output.paths,
      count: output.results.length,
      seed_count: flatResults.length,
      ppr_alpha: exploreConfig.ppr_alpha,
      depth,
      ppr_iterations: exploreConfig.ppr_iterations,
      total_candidates_scored: output.totalCandidatesScored,
      elapsed_ms: elapsed,
      ...(output.recursionDepth !== undefined && {
        recursion_depth: output.recursionDepth,
        sub_queries: output.subQueries,
        converged: output.converged,
        per_pass_results: output.perPassResults,
      }),
    },
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/*  Navigated Recursion (v0.5.1) — session-based, caller-steered       */
/* ------------------------------------------------------------------ */

import {
  startExploration,
  expandExploration,
  concludeExploration,
  type ExploreSessionDeps,
  type ExploreSessionState,
  type ExpandDirection,
  type NavigatedExploreResult,
  type ConcludeSummary,
} from "../core/explore-session.js";

export type NavigatedResult = {
  success: boolean;
  data: Record<string, unknown>;
  warnings: string[];
};

/**
 * Build ExploreSessionDeps from a vault. Mirrors runExplore's setup
 * (steps 1-12) but returns the pieces instead of running a pass, so the
 * navigator drives all passes.
 */
export async function buildSessionDeps(
  startDir: string,
  externalDb?: Database.Database,
): Promise<{ deps: ExploreSessionDeps; warnings: string[]; closeDb: () => void }> {
  const warnings: string[] = [];

  const vaultRoot = await findVaultRoot(startDir);
  const paths = getVaultPaths(vaultRoot);
  const config = await loadConfig(paths.config);
  const exploreConfig = { ...config.explore };

  const graph = await buildGraph(paths.notes);
  const allTitles = await listNoteTitles(paths.notes);
  const noteIndex = await buildNoteIndex(paths.notes, allTitles);
  const graphMetrics = computeGraphMetrics(graph, noteIndex);

  const dbPath = path.resolve(vaultRoot, config.engine.db_path);
  const ownDb = !externalDb;
  let mainDb: Database.Database;
  if (externalDb) {
    mainDb = externalDb;
  } else {
    let dbExists = true;
    try { await fs.access(dbPath); } catch { dbExists = false; }
    if (!dbExists) {
      warnings.push("Embedding index not found — building now");
      await buildIndex(vaultRoot, config.engine);
    }
    mainDb = initDB(dbPath);
  }

  initQValueTables(mainDb);
  const storedVectors = loadVectors(mainDb);
  const boostScores = config.activation?.enabled !== false ? loadBoosts(mainDb) : undefined;
  const vitalityScores = await computeAllVitality(
    paths.notes, allTitles, graph, graphMetrics.bridges, config, boostScores,
  );

  // Warmth signals are query-agnostic seeds here; per-query warmth comes via reseed
  const warmthSignals = new Map<string, number>();

  const bm25Index = await buildBM25IndexFromVault(vaultRoot, config.bm25);

  const reseed = async (subQuery: string): Promise<ScoredNote[]> => {
    const subClassified = classifyIntent(subQuery, allTitles);
    const subCL = exploreConfig.seed_count * config.retrieval.candidate_multiplier;
    const subComp = await searchComposite({
      queryText: subQuery, intent: subClassified, storedVectors, graphMetrics,
      vitalityScores, limit: subCL, config: config.engine,
    });
    const subKw = searchBM25(subQuery, bm25Index, config.bm25, subCL);

    // Per-query warmth: refresh the shared map so PPR seeding + frontier see it
    if (config.warmth.enabled) {
      try {
        const warmthService = new WarmthService();
        const signals = await warmthService.scan(
          subQuery, storedVectors, graph, config.engine, config.warmth,
          { limit: config.warmth.max_results },
        );
        for (const s of signals) {
          const prev = warmthSignals.get(s.title) ?? 0;
          if (s.score > prev) warmthSignals.set(s.title, s.score);
        }
      } catch { /* warmth unavailable — non-fatal */ }
    }

    const subSig: SignalResults = { composite: subComp, keyword: subKw, graph: [], warmth: [] };
    return fuseScoreWeightedRRF(subSig, config.retrieval).slice(0, exploreConfig.seed_count);
  };

  const deps: ExploreSessionDeps = {
    linkGraph: graph,
    notesDir: paths.notes,
    warmthSignals,
    config: exploreConfig,
    qValueLookup: (title: string) => getDecayedQ(mainDb, title),
    allTitles,
    reseed,
  };

  return { deps, warnings, closeDb: () => { if (ownDb) mainDb.close(); } };
}

/** In-memory session store (used by MCP server; CLI uses file persistence). */
const sessions = new Map<string, { state: ExploreSessionState; deps: ExploreSessionDeps; closeDb: () => void }>();

export async function runExploreStart(
  startDir: string,
  query: string,
  budget?: number,
  externalDb?: Database.Database,
): Promise<NavigatedResult> {
  try {
    const { deps, warnings, closeDb } = await buildSessionDeps(startDir, externalDb);
    // Seed warmth for the root query before pass 0
    await deps.reseed(query).then(() => undefined).catch(() => undefined);
    const result = await startExploration(query, deps, budget);
    sessions.set(result.session.id, { state: result.session, deps, closeDb });
    return { success: true, data: serializeNavigated(result), warnings };
  } catch (err) {
    return { success: false, data: {}, warnings: [String(err)] };
  }
}

export async function runExploreExpand(
  explorationId: string,
  direction: ExpandDirection,
): Promise<NavigatedResult> {
  const entry = sessions.get(explorationId);
  if (!entry) {
    return {
      success: false, data: {},
      warnings: [`unknown exploration_id: ${explorationId} — sessions are in-memory and per-server`],
    };
  }
  try {
    const result = await expandExploration(entry.state, direction, entry.deps);
    return { success: true, data: serializeNavigated(result), warnings: [] };
  } catch (err) {
    return { success: false, data: {}, warnings: [String(err)] };
  }
}

export function runExploreConclude(
  explorationId: string,
  outcome: { answered: boolean; usedNotes?: string[] },
): { success: boolean; data: ConcludeSummary | Record<string, never>; warnings: string[] } {
  const entry = sessions.get(explorationId);
  if (!entry) {
    return { success: false, data: {}, warnings: [`unknown exploration_id: ${explorationId}`] };
  }
  const summary = concludeExploration(entry.state, outcome);
  entry.closeDb();
  sessions.delete(explorationId);
  return { success: true, data: summary, warnings: [] };
}

function serializeNavigated(r: NavigatedExploreResult): Record<string, unknown> {
  return {
    exploration_id: r.session.id,
    query: r.session.query,
    budget_remaining: r.session.budgetRemaining,
    concluded: r.session.concluded,
    tree: r.session.nodes.map((n) => ({
      id: n.id,
      parent: n.parentId,
      kind: n.kind,
      label: n.label,
      depth: n.depth,
      new_notes: n.newNotes,
      dead_end: n.deadEnd,
      exhausted: n.exhausted,
      notes: n.notes.map((x) => ({
        title: x.title,
        score: Number(x.score.toFixed(4)),
        warmth: x.warmthScore,
        source: x.source,
        description: x.snippet?.description ?? null,
      })),
    })),
    new_notes: r.newNotes.map((x) => x.title),
    frontier: r.frontier.map((f, i) => ({ option: i + 1, direction: f.direction, reason: f.reason })),
  };
}
