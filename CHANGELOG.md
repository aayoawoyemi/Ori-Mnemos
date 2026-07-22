# Changelog

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
