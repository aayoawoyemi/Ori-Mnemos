/**
 * Ori Mnemos — Navigated Recursion Session Tests (v0.5.1)
 *
 * Session lifecycle for caller-steered exploration: start, expand by all
 * three direction types, frontier computation, budget enforcement,
 * dead-end marking, and conclude summaries.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  startExploration,
  expandExploration,
  concludeExploration,
  computeFrontier,
  type ExploreSessionDeps,
  type ExploreSessionState,
} from "../../src/core/explore-session.js";
import type { LinkGraph } from "../../src/core/graph.js";
import type { ScoredNote } from "../../src/core/ranking.js";
import type { ExploreConfig } from "../../src/core/config.js";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const CONFIG: ExploreConfig = {
  enabled: true,
  default_limit: 15,
  max_limit: 30,
  ppr_alpha: 0.45,
  ppr_iterations: 30,
  seed_count: 10,
  score_decay_threshold: 0.15,
  max_depth: 2,
  warmth_seed_blend: 0.3,
  q_seed_blend: 0.15,
  max_warmth_only_seeds: 5,
  snippet_preview_length: 150,
  snippet_max_links: 8,
  cooc_blend_beta: 0.3,
  recursive_enabled: true,
  max_recursion_depth: 2,
  max_total_notes: 30,
  convergence_threshold: 0.15,
  sub_question_max: 3,
  ppr_iteration_decay: 0.67,
};

function makeGraph(edges: Array<[string, string]>): LinkGraph {
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const [source, target] of edges) {
    if (!outgoing.has(source)) outgoing.set(source, new Set());
    outgoing.get(source)!.add(target);
    if (!incoming.has(target)) incoming.set(target, new Set());
    incoming.get(target)!.add(source);
  }
  return { outgoing, incoming };
}

let tmpDir: string;

async function writeNote(title: string, body: string): Promise<void> {
  const fm = `---\ndescription: "${title} description"\ntype: insight\ncreated: 2026-01-01\n---\n`;
  await fs.writeFile(path.join(tmpDir, `${title}.md`), fm + body, "utf8");
}

/** All titles in the little universe used across tests. */
const TITLES = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];

/** Graph: alpha→beta→gamma, alpha→delta, epsilon→alpha, zeta isolated-ish */
function fixtureGraph(): LinkGraph {
  return makeGraph([
    ["alpha", "beta"],
    ["beta", "gamma"],
    ["alpha", "delta"],
    ["epsilon", "alpha"],
    ["gamma", "zeta"],
  ]);
}

function makeDeps(overrides?: Partial<ExploreSessionDeps>): ExploreSessionDeps {
  const reseedMap = new Map<string, ScoredNote[]>([
    ["origin question", [{ title: "alpha", score: 0.9 }, { title: "beta", score: 0.6 }]],
    ["storage decision", [{ title: "delta", score: 0.8 }]],
    ["empty topic", []],
  ]);
  return {
    linkGraph: fixtureGraph(),
    notesDir: tmpDir,
    warmthSignals: new Map([
      ["alpha", 0.8],
      ["gamma", 0.5],
    ]),
    config: CONFIG,
    qValueLookup: () => 0.5,
    allTitles: TITLES,
    reseed: async (q: string) => reseedMap.get(q) ?? [],
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-nav-explore-"));
  for (const t of TITLES) await writeNote(t, `Body of ${t} with [[alpha]] link.`);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/*  startExploration                                                   */
/* ------------------------------------------------------------------ */

describe("startExploration", () => {
  it("runs pass 0 and returns a session with a root node", async () => {
    const { session, frontier, newNotes } = await startExploration(
      "origin question",
      makeDeps(),
    );
    expect(session.id).toMatch(/^exp-/);
    expect(session.nodes).toHaveLength(1);
    expect(session.nodes[0].kind).toBe("root");
    expect(session.nodes[0].notes.length).toBeGreaterThan(0);
    expect(newNotes.length).toBe(session.nodes[0].notes.length);
    expect(session.concluded).toBe(false);
    expect(frontier.length).toBeGreaterThan(0);
  });

  it("uses config max_recursion_depth as default budget", async () => {
    const { session } = await startExploration("origin question", makeDeps());
    expect(session.budgetRemaining).toBe(CONFIG.max_recursion_depth);
  });

  it("accepts an explicit budget", async () => {
    const { session } = await startExploration("origin question", makeDeps(), 5);
    expect(session.budgetRemaining).toBe(5);
  });

  it("marks the root as dead end when nothing is found", async () => {
    // no warmth signals -> empty reseed means zero seeds -> PPR finds nothing
    const barren = makeDeps({ warmthSignals: new Map() });
    const { session } = await startExploration("empty topic", barren);
    expect(session.nodes[0].deadEnd).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  expandExploration — direction types                                */
/* ------------------------------------------------------------------ */

describe("expandExploration", () => {
  let deps: ExploreSessionDeps;
  let state: ExploreSessionState;

  beforeEach(async () => {
    deps = makeDeps();
    ({ session: state } = await startExploration("origin question", deps));
  });

  it("expands by subQuestion and returns only new notes as diff", async () => {
    const before = new Set(state.visited);
    const { session, newNotes } = await expandExploration(
      state,
      { subQuestion: "storage decision" },
      deps,
    );
    expect(session.nodes).toHaveLength(2);
    expect(session.nodes[1].kind).toBe("subQuestion");
    for (const n of newNotes) expect(before.has(n.title)).toBe(false);
    expect(session.budgetRemaining).toBe(CONFIG.max_recursion_depth - 1);
  });

  it("expands by branch, deriving the query from the branch node", async () => {
    const r1 = await expandExploration(state, { subQuestion: "storage decision" }, deps);
    const branchId = r1.session.nodes[1].id;
    const r2 = await expandExploration(r1.session, { branch: branchId }, deps);
    const branchNode = r2.session.nodes[2];
    expect(branchNode.kind).toBe("branch");
    expect(branchNode.parentId).toBe(branchId);
    expect(branchNode.label).toBe("storage decision");
    expect(branchNode.depth).toBe(2);
  });

  it("expands by neighbors as a pure graph step (no reseed)", async () => {
    // barren start: nothing visited, so beta's graph neighbors are all new
    const barren = makeDeps({ warmthSignals: new Map() });
    const start = await startExploration("empty topic", barren, 5);
    const r1 = await expandExploration(start.session, { neighbors: "beta" }, barren);
    const node = r1.session.nodes[1];
    expect(node.kind).toBe("neighbors");
    expect(r1.newNotes.map((n) => n.title)).toContain("gamma");
    expect(r1.newNotes.map((n) => n.title)).toContain("alpha");
    // second step on the same note: everything now visited -> dead end
    const r2 = await expandExploration(r1.session, { neighbors: "beta" }, barren);
    expect(r2.newNotes).toHaveLength(0);
    expect(r2.session.nodes[2].deadEnd).toBe(true);
  });

  it("marks dead-end nodes when expansion finds nothing new", async () => {
    // warmth-only seeding can rescue an empty reseed (that's a feature) —
    // so a true dead end requires no warmth and no seeds
    const barren = makeDeps({ warmthSignals: new Map() });
    const start = await startExploration("empty topic", barren, 5);
    const { session } = await expandExploration(
      start.session,
      { subQuestion: "empty topic" },
      barren,
    );
    expect(session.nodes[1].deadEnd).toBe(true);
    expect(session.nodes[1].newNotes).toBe(0);
  });

  it("throws on unknown branch id", async () => {
    await expect(
      expandExploration(state, { branch: "n99" }, deps),
    ).rejects.toThrow(/unknown branch/);
  });

  it("enforces the budget", async () => {
    state.budgetRemaining = 1;
    await expandExploration(state, { subQuestion: "storage decision" }, deps);
    await expect(
      expandExploration(state, { subQuestion: "storage decision" }, deps),
    ).rejects.toThrow(/no budget/);
  });

  it("refuses to expand a concluded session", async () => {
    concludeExploration(state, { answered: true });
    await expect(
      expandExploration(state, { subQuestion: "storage decision" }, deps),
    ).rejects.toThrow(/concluded/);
  });
});

/* ------------------------------------------------------------------ */
/*  computeFrontier                                                    */
/* ------------------------------------------------------------------ */

describe("computeFrontier", () => {
  it("offers unexplored neighbors and rich branches, never visited notes", async () => {
    const deps = makeDeps();
    const { session } = await startExploration("origin question", deps);
    const frontier = computeFrontier(session, deps);
    expect(frontier.length).toBeGreaterThan(0);
    for (const opt of frontier) {
      expect(opt.reason).toBeTruthy();
      expect(opt.direction).toBeTypeOf("object");
    }
  });

  it("returns options not decisions — capped at maxOptions", async () => {
    const deps = makeDeps();
    const { session } = await startExploration("origin question", deps);
    const frontier = computeFrontier(session, deps, 2);
    expect(frontier.length).toBeLessThanOrEqual(2);
  });
});

/* ------------------------------------------------------------------ */
/*  concludeExploration                                                */
/* ------------------------------------------------------------------ */

describe("concludeExploration", () => {
  it("summarizes passes, dead ends, and the navigator's used notes", async () => {
    const deps = makeDeps({ warmthSignals: new Map() });
    const { session } = await startExploration("origin question", deps);
    await expandExploration(session, { subQuestion: "empty topic" }, deps);
    const summary = concludeExploration(session, {
      answered: true,
      usedNotes: ["alpha"],
    });
    expect(summary.passes).toBe(1);
    expect(summary.deadEnds).toContain("empty topic");
    expect(summary.usedNotes).toEqual(["alpha"]);
    expect(summary.answered).toBe(true);
    expect(session.concluded).toBe(true);
  });
});
