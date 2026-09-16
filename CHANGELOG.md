# Changelog

## [0.7.0] - 2026-09-16

Correctness release. Every fix below is behaviour reachable on 0.6.1, which is
what `npm` has been serving; the repository had been ahead of the published
build without a release to carry the fixes across.

### Performance — measured on a real 1,538-note vault, not a fixture

| entry point | before | after |
|---|---|---|
| `ori query ranked` | 3,344 ms | 350 ms |
| `ori query warmth` | 2,487 ms | 231 ms |
| `ori explore` | 3,785 ms | 474 ms |

- **Derived index** (`src/core/indexstore.ts`). Notes, links, projects, term
  postings, access counts and graph metrics are persisted in SQLite and synced
  per query, stat-filtered. Every query previously re-read and re-parsed the
  whole vault three to four times: `buildGraph` 2,088 ms + `buildNoteIndex`
  2,031 ms + `buildBM25IndexFromVault` 2,590 ms + `computeGraphMetrics` 388 ms.
  The index is derived and disposable; a missing or stale one degrades to the
  old scans with a warning, never a failure.
- **BM25 from stored postings**, scoped to the query's terms: 2,590 ms → 0.4–11
  ms, bit-identical scores (317,824 postings compared, 0 mismatches). Per-field
  counts are stored, so a `title_boost` change is live on the next query with no
  reindex.
- **Graph metrics cached** on a fingerprint of the graph (note count, edge
  count, latest reparse). An edited note invalidates; nothing else does.
- **`bootstrapFromWikiLinks`** target-inverted: 11,426 ms → 75 ms on the real
  vault. Two unfilled template placeholders (`relevant-map`, `related-note`)
  linked from ~880 notes each had produced 98.2% of all bootstrap rows; poster
  lists over 128 are now skipped, and the cap can only withdraw evidence, never
  invent an edge.
- **`injectExploration`** samples O(k) instead of shuffling all N titles.
- **`loadVectors`** prunes columns whose space weight is zero; warmth loads
  two vector columns instead of five.
- **`ori add`** reads the graph from the index instead of scanning the vault.

### Fixed

- **The CLI never learned.** `useIntelligence` required an external database
  and a caller-supplied session id, which only the MCP server passed. So
  `ori query ranked` never tracked a stage, wrote `stage_log`, persisted a
  bandit policy, logged exposure, or credited a Q-value. Production:
  717 `note_q` rows, 707 never updated; `stage_log` empty. The same query
  answered differently by transport (#34 §3). Fix-list items 5, 9, 10 were
  one defect.
- **The derived index never invalidated on an edit.** Freshness compared the
  indexed note count to the file count, which sees notes added or removed and
  is blind to a note changed in place. Sync is now unconditional.
- **Warmth and explore bypassed the index entirely** — only the ranked path
  had been wired. One seam, `openSyncedIndex`, now serves all four entry
  points plus `ori add`.
- **One of six composite scoring spaces was a constant.** `communityScore`
  returned 0.5 for every note while `community_vec` held 96 distinct patterns.
  It now derives a query community affinity from the top text matches;
  weighting chosen by a sweep of 5 candidates × 10 real queries × 4 metrics.
- **`measureCurrentQuality` could not see exact-identifier recall.** "Resume J"
  scored 0.005 as a success; with the lexical probe it scores −0.246, a
  failure. This is what let `bm25` be learned out of the pipeline while marked
  essential.
- **`getDecayedQ` decayed the initialisation constant** for exposure-created
  rows, and parsed SQLite's `datetime('now')` as local time — west of UTC every
  fresh row had negative age, so decay became growth.
- **Windows rename under a transient lock.** 374 of 480 renames failed with
  `EPERM` in an 8-writer reproduction. Frontmatter writes are now atomic
  (temp sibling + fsync + rename) with a bounded retry; exactly one raw
  `fs.rename` exists in the repository, inside the helper. Promote moves first
  and rolls back, so a note exists exactly once at every instant.
- **A read no longer writes user files.** Access counts accumulate in the index
  and flush to frontmatter explicitly; a query leaves note files byte-identical.
- **`ori index build` rebuilt embeddings only.** It now rebuilds all three
  derived stores, and the MCP `ori_index_build` calls the same function instead
  of bootstrapping co-occurrence privately inside a bare `catch`. `--force`
  drops and reparses the derived index. The "run `ori index build`" hint on a
  coverage warning pointed at a command that would not have touched the store
  complaining.
- **`ori health` now warns when learning is absent**: production shows 713 of
  807 tracked notes never credited, all 713 shown to an agent.
- `busy_timeout` and `foreign_keys` with `ON DELETE CASCADE` on the index
  connection; #1 is unrepresentable rather than remembered.
- Two byte-identical private copies of the BM25 defaults (`config.ts`,
  `bm25.ts`) are now one export. Found because a test imported a name that did
  not exist, received `undefined`, and passed anyway through the duplicate.

### Removed

- `computePropensity`, `buildPropensityMap`, `loadAccessLog` and
  `IPSConfig.epsilon`: no callers, and the first was O(events × results) per
  title — an invitation to a quadratic on the query path. The config parser
  ignores unknown keys, so an existing `ori.config.yaml` that still sets
  `ips.epsilon` keeps loading. `AccessEvent.results[].propensity` is kept: it is
  the on-disk log format.

### Fixed (earlier)

- **Stage bandit could starve a warm stage permanently** — `getStageDecision`
  evaluated the time-budget cutoff *before* the epsilon re-exploration check,
  so any stage reached after the budget was spent returned `skip` without ever
  passing the escape hatch. A stage that never runs gains no sample, so its UCB
  never moves, so it is never selected again. Measured on the live vault
  2026-09-12: all six non-essential stages frozen since 09-07, with `pagerank`
  holding the highest total reward of any stage (+68.0 over 137 samples,
  ~0.50/sample) while switched off, and `bm25` still running at −0.29/sample
  because it is `essential`. Ranked queries were effectively keyword-only.

  This completes the 0.6.1 fix rather than replacing it. That release moved the
  budget check below the *exploration-phase* gate, which protects cold-start
  stages (`sampleCount < MIN_SAMPLES`). It did not move it below the *epsilon*
  gate, so a stage that went cold after passing `MIN_SAMPLES` had no way back.
  All six frozen stages had 57–137 samples.

  Epsilon is now checked above the budget. Verified against `dist`: a stage with
  57 samples and negative reward at 450ms elapsed returns `run` 4.97% of the
  time over 20,000 trials, against 0.00% before.

- **`EPSILON` raised 0.02 → 0.05.** Recovery rate for a starved arm *is*
  epsilon; at 2% a frozen stage waited ~50 queries per sample. Expected added
  cost is epsilon × summed non-essential stage cost (160ms), so ~8ms per query
  against ~3ms. 5% is the conventional epsilon-greedy floor.

- **Flaky budget test pinned.** `tests/core/blind-34.test.ts` asserted the
  budget skip without pinning `random`, unlike its two siblings, so it failed at
  exactly the new epsilon rate. Pinned, plus a regression test asserting epsilon
  still runs a stage past the time budget.

See [stage-bandit-starvation.md](docs/stage-bandit-starvation.md) for the full
diagnosis, the measurements, and what it deliberately does not fix.

### Repository

- **21 of 57 test files were not in git.** `.gitignore` carried `tests/*` plus a
  hand-maintained allowlist of 36 individual files, so a newly written test was
  invisible by default. The ignored set included `atomic-writes`, `frontmatter`,
  `promote`, `tracking`, `indexstore`, `bm25-store`, `graph-metrics-cache`,
  `cli-learning-wiring` and `health-learning` — the tests that prove the fixes
  in this release. `tests/fixtures/` was ignored too, so the 36 tracked tests
  could not run from a clean clone. `tests/` is now tracked; the suite a
  contributor gets is the suite that runs here: 57 files, 862 tests.


## [0.6.1] - 2026-07-29

### Field-Report Fixes (#34)

Every code-level finding from the 0.5.5 field report, fixed:

- **Update cache moved out of `~/.ori`** — the update checker's cache directory doubled as a vault marker, making the walk-up treat `$HOME` as a vault for any process launched outside a real vault (MCP servers, cron). Cache now lives at `~/.cache/ori/` (XDG-aware; `%LOCALAPPDATA%\ori\Cache` on Windows), with one-time migration and legacy-file cleanup
- **`ORI_VAULT` environment override** — honored by every command via the shared vault resolver; authoritative like `--vault` (fails loudly if the path is not a vault, never silently ignored)
- **Stage learner epsilon re-exploration** — stages disabled by transient failures now get 1-in-50 re-exploration chances instead of permanent abstention; skipped/abstained stages are surfaced in the response envelope as `stages_skipped`
- **Stage time budget configurable** — `retrieval.stage_time_budget_ms` (default 500) and `retrieval.stage_soft_cutoff` (default 0.8); the budget check now runs *below* the exploration-phase gate so cold-start stages are never starved
- **`--limit` honored on `query ranked` / `query similar`** — the CLI flag was parsed but never passed through
- **CLI update notifications** — `checkForUpdate` now runs after CLI commands (stderr only, TTY-gated, suppressed by `ORI_NO_UPDATE_CHECK`/`CI`/`serve`)

Thanks to @wilsonalmeida for the exceptional field report.

## [0.6.0] - 2026-07-21

### Navigated Recursion: The Agent Steers the Graph

`ori explore` no longer returns a flat synthesis. The agent sees the decomposition tree — which branches produced results, which hit dead ends — and steers the traversal itself.

- **Navigated exploration sessions** — `explore-start` / `explore-expand` / `explore-conclude` (CLI + MCP tools)
- **Budget as nudge, not wall** — soft exhaustion with explicit extension instead of hard cutoff
- **Cross-encoder reranking stage** — joint query–note scoring on top of four-signal fusion, fully local
- **Dead-end semantics** — narrow pass 0, usedNotes validation, honest branch reporting from journey testing
- **Codebase normalization** — dead code deleted, no-unused enforced, CI test matrix added
- **Community fixes merged** — access_count write-back on retrieval (#33, @maichler), wikilink slug normalization + code-fence skipping (#32, #20), version single-sourced from package.json (#24)

RMH Constraint 2 — "unresolved queries must recurse" — goes from partial to real, with the agent navigating the recursion.

## [0.5.6] - 2026-05-18

### OpenCode Bridge: Full Lifecycle Integration

Complete bridge adapter for [OpenCode](https://opencode.ai) with first-run onboarding, session capture, and note validation.

- **First-run onboarding** — plugin detects blank `identity.md` and injects onboarding prompt via `client.session.prompt()`
- **Session capture** — `session.idle` hook fetches conversation messages via SDK `client.session.messages()` and saves via `ori add --content`
- **Note validation** — `ori validate` runs silently when writing to vault notes
- **Multi-vault support** — resolves vault path from `opencode.json` MCP config, works with any named MCP entry
- **One-command install** — `ori bridge opencode --scope project --activation auto --vault /path/to/vault`
- **Added `--content` flag to `ori add`** — allows programmatic note creation with real content (replaces template placeholder)

The OpenCode plugin uses `spawnSync` for silent command execution (matching Claude Code's hook behavior) and `client.session.prompt()` for reliable onboarding injection.

## [0.5.5] - 2026-03-23

### Ebbinghaus Warmth: Memory That Strengthens Through Use

Activation boosts now follow the Ebbinghaus forgetting curve. Notes accessed once fade fast (half-life ~7 days). Notes accessed repeatedly across many sessions become deeply embedded and fade slowly (half-life up to ~28 days).

- **Access count tracking** — each boost increments a per-note access counter
- **Session spread tracking** — tracks which distinct sessions accessed each note (last 20)
- **Adaptive decay rate** — `base_rate / (1 + 0.2 * ln(1 + access_count) + 0.3 * ln(1 + session_spread))`
- **Automatic migration** — existing databases gain the new columns on next open

This is the difference between short-term and long-term memory. Frequently accessed notes across many sessions become part of the agent's resting cognitive state.

## [0.5.4] - 2026-03-23

### Active Memory: Warmth Landscape in Orient

`ori_orient` now surfaces the memory activation landscape at session start. The agent sees what's warm before doing any work.

- **Top warm notes** — ranked by combined boost + Q-value score, with project tags
- **Project-level warmth** — aggregated warmth by project (e.g., "ai-agents: 4.2, courtshare: 2.1")
- **Heating/cooling detection** — notes gaining warmth (active <1 day) vs losing warmth (inactive >3 days)

No new infrastructure. Composes existing boosts table, Q-values, and frontmatter into a lightweight landscape (~25ms added to orient). This is the first step toward active memory — the agent starts every session knowing the shape of what's been on its mind.

## [0.5.3] - 2026-03-23

### RMH Constraint 3: Live Learning

The graph now reshapes during work, not at session end. Every retrieval immediately:

- **Co-occurrence edges** recorded per-query (notes retrieved together get wired together live)
- **Q-value proxy rewards** applied per-query based on retrieval rank
- **LinUCB stage learning** updated per-query with correct per-query features (fixes a bug where all stage updates previously used the last query's feature vector)

NPMI recomputation and homeostasis normalization remain at session end (global operations). Everything else is live.

**Why this matters:** For always-on agents with no session end, batch learning means no learning. Live learning is the only option. Cost: ~10-15ms per query (<0.5% overhead).

## [0.5.1] - 2026-03-23

### RMH Constraint 2: Recursive Explore

Unresolved queries now recurse. When `ori_explore` doesn't fully answer a query on the first pass, it identifies gaps and searches again — automatically.

**How it works:** An LLM reads the retrieved notes, generates sub-questions about what's missing, and Ori re-explores for each sub-question. New notes are accumulated across passes. The system converges when the LLM finds no more gaps, new notes drop below threshold, or the depth budget is reached.

**Multi-provider support:** Works with any OpenAI-compatible API:
- **Groq** (free tier, recommended) — Llama 3.3 70B, 30 req/min
- **Ollama** (fully local) — Qwen 2.5, Phi-3, Llama 3.2
- **OpenAI**, **Anthropic**, **Together AI**, **OpenRouter**, or any `/v1/chat/completions` endpoint

**Graceful degradation:** No LLM configured? `ori_explore` falls back to single-pass explore with PPR graph traversal, warmth, and Q-value reranking. No functionality lost — recursion is additive.

**Explore audit logging:** Set `ORI_EXPLORE_AUDIT=true` to capture detailed recursion data locally — what recursion found vs flat retrieval, sub-questions generated, convergence status, per-pass breakdown.

See [docs/recursive-explore.md](docs/recursive-explore.md) for setup and configuration.

### Config

- `llm.base_url` now supported — point to any OpenAI-compatible endpoint (Groq, Ollama, vLLM, etc.)
- New explore config options: `recursive_enabled`, `max_recursion_depth`, `max_total_notes`, `convergence_threshold`, `sub_question_max`

## [0.5.0] - 2026-03-20

### Four-Signal Fusion Retrieval

- `ori_explore` — deep graph traversal via Personalized PageRank (α=0.45, HippoRAG-validated)
- Score-weighted Reciprocal Rank Fusion: semantic + BM25 + PageRank + warmth
- Q-value reranking from session learning signals
- Hebbian co-occurrence edge learning
- LinUCB stage meta-learning for retrieval strategy selection
- ACT-R cognitive decay (vitality system)
- 16 MCP tools
- Bridges for Claude Code, Hermes, Cursor, Codex
- HotpotQA multi-hop benchmark suite

## [0.4.0] - 2026-03-18

### Retrieval Intelligence

- 3-layer learning system: Q-value reranking, co-occurrence edges, stage meta-learning
- Gravity dampening (penalizes generic hub notes)
- Hub dampening (prevents map/index notes from dominating)
- Resolution boost (prioritizes decisions and learnings for action queries)
- Exploration injection (epsilon-greedy discovery of unseen notes)
- Update check in `ori_orient` — notifies when a newer version is published

## [0.3.5] - 2026-03-08

### Bridge Install Lifecycle

- `ori bridge` command for one-command client installation
- Claude Code bridge with hooks (orient, capture, validate)
- Archive SQLite cleanup and MCP graph caching fixes

## [0.3.4] - 2026-03-04

### First-Run Experience

- Interactive first-run boot sequence for `ori init`
- MCP directory metadata optimization
- npm registry discoverability improvements

## [0.3.3] - 2026-03-03

### The Emergence Bootstrap

- Graph-aware forgetting — vitality decay respects structural importance
- Bridge notes (graph connectors) decay slower
- Hub degree multiplier for high-connectivity notes
- Auto-init global vault on first MCP connection

## [0.3.2] - 2026-03-03

- Auto-init global vault on first MCP connection
- Token economics benchmarks in README

## [0.3.1] - 2026-02-27

- Fix: prevent empty stub notes from polluting vault
- npm keyword and repository URL cleanup

## [0.3.0] - 2026-02-26

### Identity Layer

- Identity system — agent self-knowledge in `self/` directory
- 3-signal retrieval engine: semantic embeddings + BM25 + graph expansion
- Agent onboarding flow
- MCP registry packaging

## [0.2.0] - 2026-02-26

### Promotion Pipeline

- Inbox → notes promotion pipeline
- LLM-assisted enhancement (description, type, links, project tags)
- Archive workflow with frontmatter preservation
