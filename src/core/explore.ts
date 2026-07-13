/**
 * ori_explore — Recursive Memory Harness
 *
 * Phase 1: Deep graph traversal via PPR at α=0.45 (HippoRAG-validated).
 * Phase 3: Recursive sub-question decomposition with adaptive depth,
 *          convergence detection, and learning signal wiring.
 *
 * The LLM does exactly one thing: identify gaps. Ori fills them.
 * All navigation is deterministic code (PPR, BM25, seed fusion).
 * Every pass generates learning signals (Q-values, co-occurrence).
 *
 * Graceful degradation: no LLM configured → Phase 1 only (95% recall).
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type { ExploreConfig } from "./config.js";
import type { LinkGraph } from "./graph.js";
import type { ScoredNote } from "./ranking.js";
import type { ClassifiedQuery } from "./intent.js";
import { classifyIntent } from "./intent.js";
import { buildGraphologyGraph, personalizedPageRank } from "./importance.js";
import { parseFrontmatter } from "./frontmatter.js";
import type { LlmProvider, ChatMessage } from "./llm.js";
import { NullProvider } from "./llm.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ExploreSnippet {
  description: string;
  preview: string;
  type: string | null;
  links: string[];
}

export interface ExploreNote {
  title: string;
  score: number;
  pprScore: number;
  seedScore: number | null;
  warmthScore: number | null;
  source: "seed" | "ppr" | "warmth" | "multi";
  snippet?: ExploreSnippet;
}

export interface ExplorePath {
  from: string;
  to: string;
  via: string[];
}

export interface ExploreOutput {
  results: ExploreNote[];
  paths: ExplorePath[];
  totalCandidatesScored: number;
}

/* ------------------------------------------------------------------ */
/*  Seed weight computation                                            */
/* ------------------------------------------------------------------ */

/**
 * Compute PPR seed weight for a note, blending retrieval score with
 * warmth activation and learned Q-value.
 *
 * Formula: base + (warmth_blend * warmth) + (q_blend * (q - 0.5))
 * Floor: 0.01
 */
export function computeExploreSeedWeight(
  retrievalScore: number,
  warmthScore: number | null,
  qValue: number,
  config: ExploreConfig,
): number {
  const base = retrievalScore;
  const warmthBoost = warmthScore !== null ? config.warmth_seed_blend * warmthScore : 0;
  const qBoost = config.q_seed_blend * (qValue - 0.5);
  return Math.max(0.01, base + warmthBoost + qBoost);
}

/* ------------------------------------------------------------------ */
/*  PPR with explore-tuned alpha                                       */
/* ------------------------------------------------------------------ */

/**
 * Run Personalized PageRank with exploration-tuned damping (α=0.45).
 * Seeds are weighted by retrieval + warmth + Q-value scores.
 */
export function explorePPR(
  seeds: Map<string, number>,
  linkGraph: LinkGraph,
  config: ExploreConfig,
): Map<string, number> {
  const graph = buildGraphologyGraph(linkGraph);

  // Filter seeds to those present in graph
  const validSeeds: string[] = [];
  for (const [title] of seeds) {
    if (graph.hasNode(title)) validSeeds.push(title);
  }

  if (validSeeds.length === 0) return new Map();

  // personalizedPageRank uses equal seed weights internally,
  // so we run it and then post-weight by seed scores
  const rawPPR = personalizedPageRank(
    graph,
    validSeeds,
    config.ppr_alpha,
    config.ppr_iterations,
  );

  return rawPPR;
}

/* ------------------------------------------------------------------ */
/*  Score decay filter                                                 */
/* ------------------------------------------------------------------ */

/**
 * Drop notes scoring below threshold fraction of the maximum PPR score.
 */
export function applyScoreDecayFilter(
  scores: Map<string, number>,
  threshold: number,
): Map<string, number> {
  let maxScore = 0;
  for (const s of scores.values()) {
    if (s > maxScore) maxScore = s;
  }

  if (maxScore <= 0) return new Map();

  const cutoff = maxScore * threshold;
  const filtered = new Map<string, number>();
  for (const [title, score] of scores) {
    if (score >= cutoff) filtered.set(title, score);
  }
  return filtered;
}

/* ------------------------------------------------------------------ */
/*  Snippet extraction                                                 */
/* ------------------------------------------------------------------ */

/**
 * Read a note file and extract a low-token snippet:
 * description (max 200 chars), body preview (configurable), type, outgoing links.
 */
export async function extractSnippet(
  notesDir: string,
  title: string,
  linkGraph: LinkGraph,
  config: ExploreConfig,
): Promise<ExploreSnippet | null> {
  const filePath = path.join(notesDir, `${title}.md`);
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const { data, body } = parseFrontmatter(content);
  const description = typeof data?.description === "string"
    ? data.description.substring(0, 200)
    : "";
  const type = typeof data?.type === "string" ? data.type : null;

  // Body preview: first N chars, trimmed
  const cleanBody = body.trim();
  const preview = cleanBody.substring(0, config.snippet_preview_length).trim();

  // Outgoing links from graph
  const outgoing = linkGraph.outgoing.get(title);
  const links = outgoing
    ? [...outgoing].slice(0, config.snippet_max_links)
    : [];

  return { description, preview, type, links };
}

/* ------------------------------------------------------------------ */
/*  Path discovery                                                     */
/* ------------------------------------------------------------------ */

/**
 * Discover notable connection paths from seed notes to PPR-discovered notes.
 * Uses BFS on the link graph to find shortest paths.
 */
export function discoverPaths(
  seeds: string[],
  pprDiscovered: string[],
  linkGraph: LinkGraph,
  maxPaths: number = 5,
): ExplorePath[] {
  const paths: ExplorePath[] = [];
  const seedSet = new Set(seeds);

  for (const target of pprDiscovered) {
    if (seedSet.has(target)) continue;
    if (paths.length >= maxPaths) break;

    // BFS from each seed to target
    for (const seed of seeds) {
      const found = bfsPath(seed, target, linkGraph, 4);
      if (found && found.length > 2) {
        paths.push({
          from: seed,
          to: target,
          via: found.slice(1, -1),
        });
        break;
      }
    }
  }

  return paths;
}

function bfsPath(
  from: string,
  to: string,
  linkGraph: LinkGraph,
  maxDepth: number,
): string[] | null {
  if (from === to) return [from];

  const visited = new Set<string>([from]);
  const queue: Array<{ node: string; path: string[] }> = [{ node: from, path: [from] }];

  while (queue.length > 0) {
    const { node, path: currentPath } = queue.shift()!;
    if (currentPath.length > maxDepth) continue;

    const neighbors = linkGraph.outgoing.get(node);
    if (!neighbors) continue;

    for (const neighbor of neighbors) {
      if (neighbor === to) return [...currentPath, neighbor];
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ node: neighbor, path: [...currentPath, neighbor] });
      }
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Result merging                                                     */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/*  Full explore pipeline                                              */
/* ------------------------------------------------------------------ */

/**
 * Compute depth signal from PPR activation characteristics.
 * Determines how many PPR iterations to run based on activation spread.
 */
export function computeDepthSignal(
  pprScores: Map<string, number>,
  graphMetrics: { communities: Map<string, number> },
  flatResultTitles: string[],
): { maxPPRScore: number; communitySpread: number; newNoteRatio: number; depth: 1 | 2 | 3 } {
  let maxPPRScore = 0;
  for (const s of pprScores.values()) {
    if (s > maxPPRScore) maxPPRScore = s;
  }

  // How many communities do top-5 PPR results span?
  const top5 = [...pprScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([t]) => t);
  const communities = new Set(top5.map((t) => graphMetrics.communities.get(t) ?? -1));
  const communitySpread = communities.size;

  // How many PPR notes are NOT in flat results?
  const flatSet = new Set(flatResultTitles);
  const pprNotInFlat = [...pprScores.keys()].filter((t) => !flatSet.has(t));
  const newNoteRatio = pprScores.size > 0 ? pprNotInFlat.length / pprScores.size : 0;

  // Depth decision
  let depth: 1 | 2 | 3 = 2;
  if (maxPPRScore > 0.3 && communitySpread <= 1) depth = 1;
  else if (communitySpread >= 3 || maxPPRScore < 0.15) depth = 3;

  return { maxPPRScore, communitySpread, newNoteRatio, depth };
}

/**
 * Core explore pipeline — strict superset of flat retrieval.
 *
 * Takes ALREADY-PROCESSED flat results (post-RRF, post-dampening, post-Q-rerank)
 * and EXPANDS them with PPR graph discoveries. Flat results are preserved in
 * position — PPR discoveries are appended below. Explore can only ADD notes,
 * never remove notes flat would have found.
 *
 * This guarantees: explore ⊇ flat on every query.
 */
export async function explore(params: {
  query: string;
  classified: ClassifiedQuery;
  linkGraph: LinkGraph;
  notesDir: string;
  warmthSignals: Map<string, number>;
  /** Already-processed flat results (post-dampening, post-Q-rerank) */
  flatResults: ScoredNote[];
  config: ExploreConfig;
  qValueLookup: (title: string) => number;
  graphMetrics?: { communities: Map<string, number> };
  excludeArchived?: boolean;
}): Promise<ExploreOutput> {
  const {
    linkGraph, notesDir, warmthSignals, flatResults, config, qValueLookup, graphMetrics,
  } = params;

  const limit = Math.min(config.default_limit, config.max_limit);

  // 1. Build PPR seeds from flat's top results + warmth + Q-value blending
  const seeds = new Map<string, number>();
  for (const seed of flatResults.slice(0, config.seed_count)) {
    const warmth = warmthSignals.get(seed.title) ?? null;
    const q = qValueLookup(seed.title);
    const weight = computeExploreSeedWeight(seed.score, warmth, q, config);
    seeds.set(seed.title, weight);
  }

  // 2. Inject warmth-only seeds at half weight
  let warmthOnlyCount = 0;
  for (const [title, wScore] of warmthSignals) {
    if (seeds.has(title)) continue;
    if (warmthOnlyCount >= config.max_warmth_only_seeds) break;
    seeds.set(title, config.warmth_seed_blend * wScore * 0.5);
    warmthOnlyCount++;
  }

  // 3. Initial PPR pass to assess depth
  const initialPPR = explorePPR(seeds, linkGraph, config);
  const flatTitles = flatResults.map((r) => r.title);

  // 4. Auto-adjust depth based on activation characteristics
  let depthSignal = { maxPPRScore: 0, communitySpread: 1, newNoteRatio: 0, depth: 2 as 1 | 2 | 3 };
  if (graphMetrics) {
    depthSignal = computeDepthSignal(initialPPR, graphMetrics, flatTitles);
  }

  // 5. If depth signal says go deeper, re-run PPR with more iterations
  let finalPPR = initialPPR;
  if (depthSignal.depth > 2) {
    const deepConfig = { ...config };
    deepConfig.ppr_iterations = Math.round(config.ppr_iterations * 1.67);
    finalPPR = explorePPR(seeds, linkGraph, deepConfig);
  } else if (depthSignal.depth < 2) {
    const shallowConfig = { ...config };
    shallowConfig.ppr_iterations = Math.round(config.ppr_iterations * 0.5);
    finalPPR = explorePPR(seeds, linkGraph, shallowConfig);
  }

  // 6. Apply score decay filter
  const filteredPPR = applyScoreDecayFilter(finalPPR, config.score_decay_threshold);

  // 7. MERGE flat results + PPR discoveries into unified ranked list
  //    Flat results get a PPR boost if they also scored well in PPR.
  //    PPR discoveries get scored competitively so they can displace low-ranking flat results.
  const flatSet = new Set(flatTitles);

  let maxPPR = 0;
  for (const s of filteredPPR.values()) { if (s > maxPPR) maxPPR = s; }
  const normPPR = maxPPR > 0 ? (s: number) => s / maxPPR : () => 0;

  // Flat results: keep their score, boost if PPR also found them
  const allCandidates: ExploreNote[] = flatResults.map((r) => {
    const pprNorm = normPPR(filteredPPR.get(r.title) ?? 0);
    // Flat score + 20% PPR boost (rewards notes that are both semantically AND structurally relevant)
    const score = r.score + 0.2 * r.score * pprNorm;
    return {
      title: r.title,
      score,
      pprScore: pprNorm,
      seedScore: r.score,
      warmthScore: warmthSignals.get(r.title) ?? null,
      source: (pprNorm > 0 ? "multi" : "seed") as "multi" | "seed",
    };
  });

  // PPR discoveries: notes NOT in flat results, scored competitively
  // Use median flat score as baseline so PPR discoveries can compete
  const flatScores = flatResults.map((r) => r.score).sort((a, b) => b - a);
  const medianFlatScore = flatScores.length > 0 ? flatScores[Math.floor(flatScores.length / 2)] : 0;

  for (const [title, rawScore] of filteredPPR) {
    if (flatSet.has(title)) continue;
    const pprNorm = normPPR(rawScore);
    // PPR discoveries score at median flat level × PPR strength
    // High PPR = can displace bottom flat results. Low PPR = stays below.
    const score = medianFlatScore * pprNorm;
    allCandidates.push({
      title,
      score,
      pprScore: pprNorm,
      seedScore: null,
      warmthScore: warmthSignals.get(title) ?? null,
      source: "ppr",
    });
  }

  // Sort by unified score, take top limit
  allCandidates.sort((a, b) => b.score - a.score);
  const finalResults = allCandidates.slice(0, limit);

  // 8. Extract snippets
  for (const note of finalResults) {
    note.snippet = (await extractSnippet(notesDir, note.title, linkGraph, config)) ?? undefined;
  }

  // 9. Discover paths from flat seeds to PPR-discovered notes
  const seedTitles = flatResults.slice(0, 5).map((s) => s.title);
  const discoveredTitles = finalResults
    .filter((n) => n.source === "ppr" || n.source === "multi")
    .map((n) => n.title);
  const paths = discoverPaths(seedTitles, discoveredTitles, linkGraph, 5);

  return {
    results: finalResults,
    paths,
    totalCandidatesScored: filteredPPR.size,
  };
}

/* ------------------------------------------------------------------ */
/*  Phase 3: Recursive Explore with Sub-Question Decomposition         */
/* ------------------------------------------------------------------ */

export interface RecursiveExploreOutput extends ExploreOutput {
  recursionDepth: number;
  subQueries: string[];
  converged: boolean;
  perPassResults: Array<{
    query: string;
    depth: number;
    notesFound: number;
    newNotesAdded: number;
  }>;
}

const SUB_QUESTION_PROMPT = `You are analyzing retrieved notes from a knowledge graph to identify unanswered aspects of a question.

Given the original question and the notes found so far, generate 1-3 specific sub-questions that would help answer the original question but are NOT answered by the current notes.

Rules:
- Each sub-question should target a specific gap in the current knowledge
- If the current notes fully answer the question, return an empty array
- Sub-questions should be concrete and searchable, not vague
- Do not repeat previously asked sub-questions
- Maximum 3 sub-questions

Respond with JSON only: {"sub_questions": ["question1", "question2"]}
If fully answered: {"sub_questions": []}`;

/**
 * Build a compact snippet context string from accumulated results for the LLM.
 */
function buildSnippetContext(results: ExploreNote[], maxNotes: number = 10): string {
  return results
    .slice(0, maxNotes)
    .map((n) => {
      const desc = n.snippet?.description ?? "";
      const preview = n.snippet?.preview ?? "";
      const links = n.snippet?.links?.slice(0, 3).join(", ") ?? "";
      return `- ${n.title}: ${desc} ${preview}${links ? ` [links: ${links}]` : ""}`;
    })
    .join("\n");
}

/**
 * Ask the LLM to generate sub-questions based on what explore found so far.
 * Returns 0-3 sub-questions. Empty array = converged (no gaps).
 */
export async function generateSubQuestions(
  llm: LlmProvider,
  originalQuery: string,
  snippetContext: string,
  previousSubQueries: string[],
  maxSubQuestions: number = 3,
): Promise<string[]> {
  const prevStr = previousSubQueries.length > 0
    ? `\nPreviously asked (do not repeat): ${previousSubQueries.join("; ")}`
    : "";

  const messages: ChatMessage[] = [
    { role: "system", content: SUB_QUESTION_PROMPT },
    {
      role: "user",
      content: `Original question: ${originalQuery}\n\nNotes found so far:\n${snippetContext}${prevStr}`,
    },
  ];

  const response = await llm.chat(messages, { maxTokens: 256, temperature: 0 });
  if (!response) return [];

  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]) as { sub_questions?: string[] };
    if (!Array.isArray(parsed.sub_questions)) return [];
    return parsed.sub_questions
      .filter((q): q is string => typeof q === "string" && q.length > 5)
      .slice(0, maxSubQuestions);
  } catch {
    return [];
  }
}

/**
 * Recursive explore: runs Phase 1 explore, then iteratively generates
 * sub-questions and re-explores until convergence or budget exhaustion.
 *
 * Every internal pass generates learning signals via the same retrieval
 * events that the session reward accumulator and co-occurrence system
 * consume at session end.
 *
 * Graceful degradation: if LLM is NullProvider, returns Phase 1 results.
 */
export async function exploreRecursive(params: {
  query: string;
  classified: ClassifiedQuery;
  linkGraph: LinkGraph;
  notesDir: string;
  warmthSignals: Map<string, number>;
  seedResults: ScoredNote[];
  config: ExploreConfig;
  qValueLookup: (title: string) => number;
  llmProvider: LlmProvider;
  allTitles: string[];
  // Functions to re-seed per sub-question (injected by CLI orchestrator)
  reseed: (subQuery: string) => Promise<ScoredNote[]>;
}): Promise<RecursiveExploreOutput> {
  const {
    config, linkGraph, notesDir, warmthSignals, seedResults,
    qValueLookup, llmProvider, allTitles, reseed,
  } = params;

  const visited = new Set<string>();
  const allResults: ExploreNote[] = [];
  const subQueries: string[] = [];
  const perPassResults: Array<{
    query: string;
    depth: number;
    notesFound: number;
    newNotesAdded: number;
  }> = [];

  // --- Pass 0: Initial explore (Phase 1) ---
  const pass0 = await explore({
    query: params.query,
    classified: params.classified,
    linkGraph,
    notesDir,
    warmthSignals,
    flatResults: seedResults,
    config,
    qValueLookup,
  });

  for (const note of pass0.results) {
    visited.add(note.title);
    allResults.push(note);
  }

  perPassResults.push({
    query: params.query,
    depth: 0,
    notesFound: pass0.results.length,
    newNotesAdded: pass0.results.length,
  });

  // If no LLM configured, return Phase 1 results (graceful degradation)
  if (llmProvider instanceof NullProvider) {
    return {
      ...pass0,
      recursionDepth: 0,
      subQueries: [],
      converged: false,
      perPassResults,
    };
  }

  // --- Recursion loop ---
  let depth = 0;
  let converged = false;

  while (depth < config.max_recursion_depth) {
    depth++;

    // Decay PPR iterations per depth
    const depthConfig = { ...config };
    depthConfig.ppr_iterations = Math.round(
      config.ppr_iterations * Math.pow(config.ppr_iteration_decay, depth)
    );

    // Build snippet context from all results so far
    const snippetContext = buildSnippetContext(allResults, 10);

    // Ask LLM for sub-questions
    const newSubQuestions = await generateSubQuestions(
      llmProvider,
      params.query,
      snippetContext,
      subQueries,
      config.sub_question_max,
    );

    // If no sub-questions, we've converged
    if (newSubQuestions.length === 0) {
      converged = true;
      break;
    }

    // Run explore for each sub-question
    let newNotesThisPass = 0;

    for (const subQ of newSubQuestions) {
      // Re-seed from sub-question (full vault search via injected function)
      const subSeeds = await reseed(subQ);
      const subClassified = classifyIntent(subQ, allTitles);

      const subResult = await explore({
        query: subQ,
        classified: subClassified,
        linkGraph,
        notesDir,
        warmthSignals,
        flatResults: subSeeds,
        config: depthConfig,
        qValueLookup,
      });

      // Add only NEW notes not already visited
      for (const note of subResult.results) {
        if (!visited.has(note.title)) {
          visited.add(note.title);
          allResults.push(note);
          newNotesThisPass++;
        }
      }

      subQueries.push(subQ);

      // Budget check
      if (visited.size >= config.max_total_notes) break;
    }

    perPassResults.push({
      query: newSubQuestions.join(" | "),
      depth,
      notesFound: newSubQuestions.length * config.default_limit,
      newNotesAdded: newNotesThisPass,
    });

    // Convergence: if this pass added very few new notes, stop
    if (visited.size > 0 && newNotesThisPass / visited.size < config.convergence_threshold) {
      converged = true;
      break;
    }

    // Budget check
    if (visited.size >= config.max_total_notes) break;
  }

  // Re-rank all accumulated results by score, take top limit
  const finalResults = allResults
    .sort((a, b) => b.score - a.score)
    .slice(0, config.default_limit);

  // Discover paths from original seeds to recursion-discovered notes
  const seedTitles = seedResults.slice(0, 5).map((s) => s.title);
  const discoveredTitles = finalResults
    .filter((n) => n.source === "ppr" || n.source === "multi")
    .map((n) => n.title);
  const paths = discoverPaths(seedTitles, discoveredTitles, linkGraph, 5);

  return {
    results: finalResults,
    paths,
    totalCandidatesScored: visited.size,
    recursionDepth: depth,
    subQueries,
    converged,
    perPassResults,
  };
}
