# Design: `ori wake` (bounded orient) + `ori nap` (agent-loop consolidation)

Status: DESIGN — approved-for-build pending Aayo review. 2026-07-31.
Grounded in: src/cli/serve.ts ori_orient (unbounded file dumps), src/cli/prune.ts (zone machinery),
promote/health/cooccurrence (existing maintenance ops), OptMem `_cover` mechanism (arxiv-adjacent prior art:
VictorTaelin/OptMem), FS-memory paper 2607.26637 ("organization erodes under weak management agents" —
hence: nap serves MECHANICAL candidates, the agent only judges, never reorganizes freely).

---

## 1. `ori wake` — bounded session boot

### Problem
ori_orient concatenates raw files (daily.md, reminders.md, goals.md, identity/methodology when brief=false)
plus warmth landscape. Payload grows with vault/file size. At 5k notes or a long daily.md, session boot
becomes context debt. No budget exists anywhere in the path.

### Contract
`ori wake [--budget N]` (CLI) and `ori_wake` (MCP): return a session-boot payload GUARANTEED <= N lines
(default 96, config `wake.budget_lines`), regardless of vault size. Deterministic given same state.

### Mechanism — budget ladder (not OptMem's temporal cover; a priority cover over SECTIONS)
Fixed priority order, each section gets a max share; unused share flows down (waterfall):
  1. identity_line (1 line: name + one-sentence identity) — always
  2. active_goals (<=8 lines: parsed goal bullets, not raw file)
  3. reminders_due (<=6 lines: only items matching today/overdue patterns)
  4. daily_recent (<=20 lines: TAIL of daily.md — most recent entries, not whole file)
  5. warm_notes (<=10 lines: top decayed-boost titles + 1-line why)
  6. resurfaced (<=3 lines: arrival-surface slots — save-for-later rules: bounded, no debt) [v2 of wake]
  7. vault_vitals (<=4 lines: note count, inbox count, zones summary, index health warning if any)
  8. update/notice lines (<=2) — existing ask-shaped notice
Sections that would overflow are SUMMARIZED BY TRUNCATION RULES (head/tail/pattern-match), never by LLM —
wake must be fast, deterministic, and never spend tokens to save tokens.
Over-budget resolution: drop from lowest priority (7 shrinks before 2 does; 1 never drops).

### Temporal fovea (the OptMem steal, applied where it fits)
daily_recent uses a cover over daily.md ENTRIES (dated blocks): today raw, this week 1-line/day,
older 1-line/week. Same alpha-style rule: keep a block whole iff its size <= alpha * age. Pure arithmetic.

### Non-goals
- Does NOT replace ori_orient (kept for compat; orient gains a deprecation note pointing to wake).
- No LLM calls, no embeddings reads beyond existing boost query. p95 < 150ms target.

### Files touched (build est. S)
- src/core/wake.ts (new: budget ladder + covers; pure functions, unit-testable)
- src/cli/boot.ts or new src/cli/wake.ts (CLI verb), serve.ts (ori_wake tool)
- config.ts: wake { budget_lines: 96, daily_alpha: 2 }
- tests/core/wake.test.ts (blind-contract: output NEVER exceeds budget for adversarial vault fixtures)

---

## 2. `ori nap` — consolidation as agent-loop work

### Problem
Maintenance today = separate manual commands (prune --apply, promote, index build, health) that nobody runs,
plus session-end batch flush. The v0.7 'consolidation daemon' idea adds infra. Meanwhile the FS-memory paper
shows LLM-discretion housekeeping ERODES stores. Need: continuous small maintenance, no daemon, no free-form
LLM reorganization.

### Contract
`ori nap` (CLI + MCP `ori_nap`): return AT MOST ONE due maintenance item, fully prepared, for the agent to
answer or apply. Idempotent when queue empty ("nothing due"). Each item is atomic + reversible.

### The due-queue (mechanically generated, priority order)
  1. inbox_promote: oldest inbox note past promote-age -> prepared classification (existing promote logic)
     Agent action: approve/edit/reject placement.
  2. merge_candidates: pair of notes with cosine-sim > threshold AND same community AND both low-traffic ->
     prepared merged draft (deterministic template concat + provenance). Agent: approve merge / keep separate
     (records a 'kept-separate' edge so pair is never re-offered — no debt semantics).
  3. fade_review: batch of <=5 notes entering 'fading' zone (existing vitality machinery), NOT articulation
     points -> agent: archive / keep-warm (keep-warm = small boost write, like resurfacing verbs).
  4. dangling_repair: one dangling wikilink with fuzzy-match suggestions -> agent picks target or removes link.
  5. summary_refresh: community whose membership changed >30% since its map note was written -> prepared
     new map skeleton. Agent fills/approves. [only item allowed LLM drafting, and only on request]
Queue state in .ori/nap-queue.json (rebuildable from scratch — a cache, OptMem-style: derived, never precious).
Generation runs lazily at nap-call time if queue stale (>24h) — measured, capped at 2s; else serve from cache.

### Why agent-in-the-loop (design principle)
The paper's erosion finding indicts autonomous LLM housekeeping. Nap inverts it: MATH proposes (similarity,
zones, communities), AGENT disposes (judgment call only), HUMAN implicitly audits (all mutations are
ordinary git-visible file edits). One item per call keeps it inside any session's token budget — same insight
as OptMem's one-merge-per-note.

### Prompt-block integration (the plug-and-play piece)
Installer prints: "At session start run `ori wake`. When idle or ending a session, run `ori nap` once and
do what it says." — that's the whole harness contract. Works in Claude Code/Cursor/anything with shell.

### Files touched (build est. M)
- src/core/nap.ts (queue generation: reuse prune zone scan, promote scan, health dangling scan, engine cosine)
- src/cli/nap.ts + serve.ts ori_nap; config: nap { merge_sim: 0.86, fade_batch: 5, queue_ttl_hours: 24 }
- tests: queue determinism, no-articulation-point-fading, kept-separate never re-offered, one-item contract.

---

## Sequencing
wake first (S, immediately useful, zero risk) -> nap (M) -> both feed v0.7 (zoom joins later; wake's
resurfaced section is the Companion's arrival-surface engine in embryo).
