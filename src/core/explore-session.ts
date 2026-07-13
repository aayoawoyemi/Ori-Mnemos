/**
 * Navigated Recursion (v0.5.1) — session state machine for caller-steered
 * exploration. RMH Constraint 2 made real: the NAVIGATOR (frontier LLM via
 * MCP, a human at the CLI, or any technology that can ask) steers the
 * traversal. Ori exposes capabilities and computes options; it does not
 * decide. The legacy internal-LLM loop (exploreRecursive) remains as the
 * autopilot fallback.
 *
 * Session state is plain JSON — serializable across MCP calls (in-memory
 * map) and CLI invocations (file-backed), and renderable by ori view later.
 */

import type { ExploreConfig } from "./config.js";
import type { LinkGraph } from "./graph.js";
import type { ScoredNote } from "./ranking.js";
import { classifyIntent } from "./intent.js";
import { explore, extractSnippet, type ExploreNote, type ExplorePath } from "./explore.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ExpandDirection =
  | { subQuestion: string }
  | { branch: string }
  | { neighbors: string };

export interface ExploreTreeNode {
  id: string;
  parentId: string | null;
  kind: "root" | "subQuestion" | "branch" | "neighbors";
  label: string;
  depth: number;
  notes: ExploreNote[];
  newNotes: number;
  deadEnd: boolean;
}

export interface FrontierOption {
  direction: ExpandDirection;
  reason: string;
}

export interface ExploreSessionState {
  id: string;
  query: string;
  createdAt: string;
  budgetRemaining: number;
  visited: string[];
  nodes: ExploreTreeNode[];
  paths: ExplorePath[];
  concluded: boolean;
}

export interface NavigatedExploreResult {
  session: ExploreSessionState;
  frontier: FrontierOption[];
  /** Notes added by the most recent operation only (the diff). */
  newNotes: ExploreNote[];
}

export interface ExploreSessionDeps {
  linkGraph: LinkGraph;
  notesDir: string;
  warmthSignals: Map<string, number>;
  config: ExploreConfig;
  qValueLookup: (title: string) => number;
  allTitles: string[];
  reseed: (subQuery: string) => Promise<ScoredNote[]>;
}

/* ------------------------------------------------------------------ */
/*  Frontier computation — options, not decisions                      */
/* ------------------------------------------------------------------ */

/**
 * Compute candidate directions from the current state. Cheap and
 * deterministic: unvisited graph neighbors of found notes ranked by
 * degree (hub status) + warmth, plus expandable branches.
 */
export function computeFrontier(
  state: ExploreSessionState,
  deps: Pick<ExploreSessionDeps, "linkGraph" | "warmthSignals">,
  maxOptions = 5,
): FrontierOption[] {
  const options: FrontierOption[] = [];
  const visited = new Set(state.visited);

  // 1. Unvisited neighbors of found notes, ranked by degree + warmth
  const neighborScores = new Map<string, { via: string; score: number }>();
  for (const node of state.nodes) {
    for (const note of node.notes) {
      const out = deps.linkGraph.outgoing.get(note.title) ?? new Set();
      const inc = deps.linkGraph.incoming.get(note.title) ?? new Set();
      for (const nb of [...out, ...inc]) {
        if (visited.has(nb)) continue;
        const degree =
          (deps.linkGraph.outgoing.get(nb)?.size ?? 0) +
          (deps.linkGraph.incoming.get(nb)?.size ?? 0);
        const warmth = deps.warmthSignals.get(nb) ?? 0;
        const score = degree + 10 * warmth;
        const prev = neighborScores.get(nb);
        if (!prev || score > prev.score) {
          neighborScores.set(nb, { via: note.title, score });
        }
      }
    }
  }
  const rankedNeighbors = [...neighborScores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, Math.max(1, Math.floor(maxOptions / 2)));
  for (const [title, { via }] of rankedNeighbors) {
    options.push({
      direction: { neighbors: via },
      reason: `unexplored neighbor "${title}" reachable via "${via}"`,
    });
  }

  // 2. Rich branches worth deepening (non-dead-end, non-root nodes)
  const branches = state.nodes
    .filter((n) => n.kind !== "root" && !n.deadEnd && n.newNotes > 0)
    .sort((a, b) => b.newNotes - a.newNotes)
    .slice(0, 2);
  for (const b of branches) {
    options.push({
      direction: { branch: b.id },
      reason: `branch "${b.label}" produced ${b.newNotes} new notes — may go deeper`,
    });
  }

  return options.slice(0, maxOptions);
}

/* ------------------------------------------------------------------ */
/*  Session lifecycle                                                  */
/* ------------------------------------------------------------------ */

function makeId(): string {
  return `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Pass 0: run a single explore pass and open a navigable session.
 */
export async function startExploration(
  query: string,
  deps: ExploreSessionDeps,
  budget?: number,
): Promise<NavigatedExploreResult> {
  const classified = classifyIntent(query, deps.allTitles);
  const seeds = await deps.reseed(query);
  const pass0 = await explore({
    query,
    classified,
    linkGraph: deps.linkGraph,
    notesDir: deps.notesDir,
    warmthSignals: deps.warmthSignals,
    flatResults: seeds,
    config: deps.config,
    qValueLookup: deps.qValueLookup,
  });

  const root: ExploreTreeNode = {
    id: "n0",
    parentId: null,
    kind: "root",
    label: query,
    depth: 0,
    notes: pass0.results,
    newNotes: pass0.results.length,
    deadEnd: pass0.results.length === 0,
  };

  const state: ExploreSessionState = {
    id: makeId(),
    query,
    createdAt: new Date().toISOString(),
    budgetRemaining: budget ?? deps.config.max_recursion_depth,
    visited: pass0.results.map((r) => r.title),
    nodes: [root],
    paths: pass0.paths,
    concluded: false,
  };

  return {
    session: state,
    frontier: computeFrontier(state, deps),
    newNotes: pass0.results,
  };
}

/**
 * One navigator-steered expansion. Consumes one budget unit.
 */
export async function expandExploration(
  state: ExploreSessionState,
  direction: ExpandDirection,
  deps: ExploreSessionDeps,
): Promise<NavigatedExploreResult> {
  if (state.concluded) {
    throw new Error(`exploration ${state.id} is concluded`);
  }
  if (state.budgetRemaining <= 0) {
    throw new Error(`exploration ${state.id} has no budget remaining`);
  }

  const visited = new Set(state.visited);
  const nextId = `n${state.nodes.length}`;
  let node: ExploreTreeNode;
  let added: ExploreNote[] = [];

  if ("subQuestion" in direction || "branch" in direction) {
    // Both run a full explore pass; branch derives its query from the node.
    let subQuery: string;
    let parentId: string | null;
    let kind: "subQuestion" | "branch";
    if ("subQuestion" in direction) {
      subQuery = direction.subQuestion;
      parentId = "n0";
      kind = "subQuestion";
    } else {
      const parent = state.nodes.find((n) => n.id === direction.branch);
      if (!parent) throw new Error(`unknown branch node: ${direction.branch}`);
      subQuery = parent.label;
      parentId = parent.id;
      kind = "branch";
    }

    const classified = classifyIntent(subQuery, deps.allTitles);
    const seeds = await deps.reseed(subQuery);
    const result = await explore({
      query: subQuery,
      classified,
      linkGraph: deps.linkGraph,
      notesDir: deps.notesDir,
      warmthSignals: deps.warmthSignals,
      flatResults: seeds,
      config: deps.config,
      qValueLookup: deps.qValueLookup,
    });

    added = result.results.filter((n) => !visited.has(n.title));
    node = {
      id: nextId,
      parentId,
      kind,
      label: subQuery,
      depth: (state.nodes.find((n) => n.id === parentId)?.depth ?? 0) + 1,
      notes: result.results,
      newNotes: added.length,
      deadEnd: added.length === 0,
    };
    state.paths = [...state.paths, ...result.paths];
  } else {
    // Graph step: unvisited neighbors of a specific note.
    const from = direction.neighbors;
    const out = deps.linkGraph.outgoing.get(from) ?? new Set();
    const inc = deps.linkGraph.incoming.get(from) ?? new Set();
    const neighborTitles = [...new Set([...out, ...inc])].filter(
      (t) => !visited.has(t),
    );

    const notes: ExploreNote[] = [];
    for (const title of neighborTitles.slice(0, deps.config.default_limit)) {
      const snippet =
        (await extractSnippet(deps.notesDir, title, deps.linkGraph, deps.config)) ??
        undefined;
      notes.push({
        title,
        score: deps.warmthSignals.get(title) ?? 0,
        pprScore: 0,
        seedScore: null,
        warmthScore: deps.warmthSignals.get(title) ?? null,
        source: "ppr",
        snippet,
      });
    }
    added = notes;
    node = {
      id: nextId,
      parentId: state.nodes.find((n) => n.notes.some((x) => x.title === from))?.id ?? "n0",
      kind: "neighbors",
      label: `neighbors of ${from}`,
      depth: 1,
      notes,
      newNotes: notes.length,
      deadEnd: notes.length === 0,
    };
  }

  for (const n of added) visited.add(n.title);
  state.visited = [...visited];
  state.nodes = [...state.nodes, node];
  state.budgetRemaining -= 1;

  return {
    session: state,
    frontier: computeFrontier(state, deps),
    newNotes: added,
  };
}

export interface ConcludeSummary {
  id: string;
  query: string;
  passes: number;
  totalNotes: number;
  deadEnds: string[];
  /** Titles the navigator says answered the question — the learning signal. */
  usedNotes: string[];
  answered: boolean;
}

/**
 * Close the session. Returns a summary whose usedNotes the caller flushes
 * into Q-values / co-occurrence via the existing reward wiring. The
 * navigator's actual path IS the reward signal.
 */
export function concludeExploration(
  state: ExploreSessionState,
  outcome: { answered: boolean; usedNotes?: string[] },
): ConcludeSummary {
  state.concluded = true;
  return {
    id: state.id,
    query: state.query,
    passes: state.nodes.length - 1,
    totalNotes: state.visited.length,
    deadEnds: state.nodes.filter((n) => n.deadEnd).map((n) => n.label),
    usedNotes: outcome.usedNotes ?? [],
    answered: outcome.answered,
  };
}
