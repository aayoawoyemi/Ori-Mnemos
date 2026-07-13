# v0.5.1 — Navigated Recursion: Inversion of Control

**Design locked: 2026-07-13 (session with Aayo). Principle, verbatim:**
> "You, as the LLM, should be able to ask and then determine if the results actually answer the question. If you're not in the graph traversing, there's a failure. I don't want the memory to have an agent itself — just make the capabilities available. Transparent enough that a coding agent can steer it, and I can steer it manually."

## The inversion

TODAY (v0.5.5): caller LLM → ori_explore → [internal mini-LLM judges gaps → recurses privately] → flat synthesis back.
The judging intelligence is a 3B side-model; the frontier model in the loop is a passive recipient.

v0.5.1: the CALLER is the navigator. Ori exposes traversal as capabilities; whoever sits on top
(frontier LLM via MCP, a human at the CLI, any "extension piece of technology that can ask
similarly to an LLM") steers. Ori itself stays agent-less: deterministic PPR/BM25/fusion
navigation + state. No embedded judgment loop in the primary path.

## Tool surface (MCP + CLI mirror)

1. `ori_explore(query, budget?)` → PASS 0 ONLY. Returns:
   - `exploration_id` (session state handle held by MCP server)
   - `tree`: root node with pass-0 results (title, score, snippet, warmth, q, depth-in-graph)
   - `frontier`: candidate directions Ori computed cheaply (nearest unexplored hubs,
     high-PPR-but-unretrieved neighbors, dead-end markers) — OPTIONS, not decisions
   - `budget`: passes remaining
2. `ori_explore_expand(exploration_id, direction)` where direction =
   `{subQuestion: "..."}` (caller's own question) | `{branch: nodeId}` (deepen) |
   `{neighbors: noteTitle}` (graph-step from a note). Returns updated tree, new-notes-only diff, frontier, budget.
3. `ori_explore_conclude(exploration_id, {answered: bool, usedNotes: [...]})` →
   flushes learning signals (Q-values, co-occurrence) from the ACTUAL navigation path.
   Caller's traversal becomes the reward signal — richer than the current batch heuristic.

## Compatibility + degradation
- `ori_explore(query, {autopilot: true})` keeps today's behavior: internal mini-LLM drives
  (for headless/cron/no-frontier-model contexts). The SUB_QUESTION_PROMPT loop becomes the
  fallback autopilot, not the primary. Graceful degradation chain: navigator → autopilot → single-pass.
- CLI manual steering: `ori explore "q"` prints the tree + numbered frontier;
  `ori explore --expand 2` continues. A human IS a valid navigator. Same protocol.
- `ori view` (later) renders the same tree/session state live — no rework; the protocol is the API for the visual.

## Why this order of magnitude matters
- Fixes the 0/7 synthesis-question failure mode (real-vault bench 2026-03-02): multi-note "why"
  answers assembled BY the caller across steered passes.
- RMH Constraint 2 goes partial→real: recursion navigated by the agent, not around it.
- This protocol IS the traversal primitive of the memory-as-filesystem architecture
  ("I don't know this — let me check here, here, here" as an API).
- Dead ends stay first-class: `{branch, newNotes: 0}` = calibrated "the vault doesn't know this."

## Implementation map (code read 2026-07-13)
- `src/core/explore.ts`: explore() (pass logic) stays; exploreRecursive() becomes autopilot path;
  NEW exploreSession state (tree, seen-notes set, budget) + expand/conclude fns.
- `src/cli/serve.ts`: 2 new MCP tools + session map keyed by exploration_id (in-memory, TTL).
- `src/cli/explore.ts` + index.ts: interactive CLI steering flags.
- Frontier computation: cheap — reuse PPR scores already computed per pass; surface top-k
  unretrieved neighbors + their hub status. No new algorithms needed for v0.5.1.
- Tests: session lifecycle, expand-by-each-direction-type, budget exhaustion, conclude signals,
  autopilot parity with old behavior.
