# Ori Mnemos

**Open-source persistent memory infrastructure for AI agents.**

Ori implements human cognition as mathematical models on a knowledge graph. Activation decay from ACT-R. Spreading activation along wiki-link edges. Hebbian co-occurrence from retrieval patterns. Reinforcement learning on retrieval itself. Recursive graph traversal with sub-question decomposition. The system learns what matters, forgets what doesn't, and optimizes its own retrieval pipeline.

Persistent memory across sessions, clients, and machines. Zero-infrastructure retrieval that [matches and in several cases strongly outperforms incumbents on benchmarks](#benchmarks) — and you own every byte of your data. Markdown on disk. Wiki-links as graph edges. Git as version control. No database lock-in, no cloud dependency, no vendor capture.

**v0.6.0** · [npm](https://www.npmjs.com/package/ori-memory) · [Paper](https://orimnemos.com/rmh) · Apache-2.0

---

## Benchmarks

### HotpotQA — Multi-Hop Retrieval

Head-to-head against [Mem0](https://github.com/mem0ai/mem0), the most widely adopted agent memory system. HotpotQA tests multi-hop reasoning — questions that require connecting information across multiple documents to answer.

| Metric | Ori Mnemos | Mem0 | Δ |
|--------|:----------:|:----:|:-:|
| Recall@5 | **90%** | 29% | **3.1×** |
| F1 Score | **0.68** | 0.33 | **2.1×** |
| Latency (avg) | **120ms** | 1,140ms | **9.5× faster** |
| Infrastructure | Markdown + SQLite | Redis + Qdrant + cloud | — |

Ori retrieves the right information 3× more often, scores 2× higher on answer quality, and does it 9.5× faster — on markdown files with a SQLite index. No cloud services. No API keys. Full evaluation code in [`bench/`](./bench/).

### LoCoMo — Long-Term Conversational Memory

Evaluated on [LoCoMo](https://github.com/snap-research/locomo) (Maharana et al., 2024) — the standard benchmark for long-term conversational memory. 10 conversations, 695 questions across single-hop, multi-hop, and temporal reasoning.

| System | Single-hop | Multi-hop | Infrastructure |
|--------|:----------:|:---------:|----------------|
| MemoryBank | 5.00 | — | Custom server |
| ReadAgent | 9.15 | — | LLM-based |
| A-Mem | 20.76 | — | Cloud APIs |
| MemGPT / Letta | 26.65 | — | PostgreSQL + cloud |
| LangMem | 35.51 | 26.04 | Cloud APIs |
| OpenAI Memory | 34.30 | — | OpenAI proprietary |
| Zep | 35.74 | 19.37 | PostgreSQL + cloud |
| **Mem0** | **38.72** | **28.64** | Redis + Qdrant + cloud |
| **Ori Mnemos** | **37.69** | **29.31** | **Markdown on disk** |

Baseline numbers from [Mem0 paper](https://arxiv.org/abs/2504.19413) (Table 1). Ori evaluated with GPT-4.1-mini for answer generation, BM25 + embedding + PageRank fusion for retrieval.

More benchmarks coming — including [LoCoMo-Plus](https://github.com/snap-research/locomo) (Level-2 cognitive memory) and adversarial refusal evaluation.

---

## Quick Start

```bash
npm install -g ori-memory
ori init my-agent
cd my-agent
```

Connect to your agent:

```bash
# Full adapters — auto-orient at session start, capture at session end
ori bridge claude-code --vault ~/brain                 # hooks + MCP + CLAUDE.md
ori bridge hermes --vault ~/brain                      # native plugin + MCP + HERMES.md
ori bridge opencode --vault ~/brain                    # plugin + MCP + AGENTS.md

# MCP-only adapters — tools available, no lifecycle automation
ori bridge cursor --vault ~/brain                      # .cursor/mcp.json
ori bridge codex --vault ~/brain                       # ~/.codex/config.toml

# Any MCP client
ori bridge generic --vault ~/brain                     # prints config for manual setup
```

Claude Code, Hermes Agent, and OpenCode get full lifecycle integration — the agent orients at session start, captures insights at session end, and validates notes on write. Cursor, Codex, and other MCP clients get access to all 16 tools but manage their own session lifecycle.

Manual MCP config (works with any client that speaks MCP):

```json
{
  "mcpServers": {
    "ori": {
      "command": "ori",
      "args": ["serve", "--mcp", "--vault", "/path/to/brain"],
      "env": { "ORI_VAULT": "/path/to/brain" }
    }
  }
}
```

Start a session. The agent receives its identity automatically and begins onboarding on first run.

---

## What's New

**v0.6.0 — Navigated Recursion.** `ori explore` no longer returns a flat synthesis. The agent sees the decomposition tree — which branches produced results, which hit dead ends — and steers the traversal itself. New session commands: `explore-start`, `explore-expand`, `explore-conclude`. Budget is a nudge, not a wall: soft exhaustion with explicit extension. A cross-encoder reranking stage now sits on top of four-signal fusion. RMH Constraint 2 goes from partial to real.

```
$ ori explore-start "why did we choose SQLite over postgres"

exploration e7f2 — 3 branches
├─ [1] storage engine tradeoffs        4 notes, strong signal
├─ [2] deployment constraints          2 notes
└─ [3] prior migration decisions       dead end — no notes

next: ori explore-expand e7f2 1   |   ori explore-conclude e7f2 --answered
```

**v0.5.6 — OpenCode bridge.** Full lifecycle integration: first-run onboarding, auto session capture, note validation, multi-vault support. `ori bridge opencode` — one command.

**v0.5.5 — Ebbinghaus warmth.** Notes accessed once fade fast (half-life ~7 days). Notes accessed across many sessions embed deeply (up to ~28 days). Short-term and long-term memory, structurally distinct.

Full history in the [CHANGELOG](./CHANGELOG.md).

---

## Recursive Memory Harness

Ori is the first implementation of the **Recursive Memory Harness** (RMH) framework — a set of constraints on how persistent memory should behave for AI agents.

The core insight comes from Recursive Language Models ([Zhang, Krassa & Khattab, 2026](https://arxiv.org/abs/2512.24601)). RLM treats context not as input to be stuffed into a window, but as an environment to be navigated. The model doesn't get a bigger desk — it gets legs and walks into the library. RMH applies the same principle to persistent memory.

Three constraints define the framework:

1. **Retrieval must follow the graph.** Memory is not a flat vector store. Notes are nodes, wiki-links are edges. Retrieval walks the structure — Personalized PageRank at α=0.45, spreading activation along edges, community-aware traversal. The topology of the graph shapes what gets found.

2. **Unresolved queries must recurse.** When a single retrieval pass is insufficient, the system decomposes the question into sub-questions, retrieves against each, and synthesizes. Convergence detection stops recursion when new passes stop surfacing new information. This is what `ori explore` does.

3. **Every retrieval must reshape the graph.** Retrieval is not read-only. Co-occurrence edges grow between notes retrieved together (Hebbian learning). Q-values update based on whether retrieved notes were actually useful. The graph learns from how it is used — every query makes the next query better.

Most memory systems treat retrieval as search. RMH treats retrieval as navigation, recursion, and learning — on a graph that evolves with every session.

Read the full paper: [Introducing Recursive Memory Harness](https://orimnemos.com/rmh)

---

## What It Does

- **Persistent identity.** Agent state — name, personality, goals, methodology — is stored in plain markdown and auto-injected at session start via MCP instructions. Identity survives client switches, machine migrations, and model changes without reconfiguration.

- **Knowledge graph.** Every `[[wiki-link]]` is a directed edge. PageRank authority, Louvain community detection, betweenness centrality, bridge detection, orphan and dangling link analysis. Structure is queryable through MCP tools and CLI.

- **Three memory spaces.** Identity (`self/`) decays at 0.1x — barely fades. Knowledge (`notes/`) decays at 1.0x — lives and dies by relevance. Operations (`ops/`) decays at 3.0x — burns hot and clears itself. The separation is architectural, not cosmetic.

- **Cognitive forgetting.** Notes decay using ACT-R base-level learning equations, not arbitrary TTLs. Used notes stay alive. Their neighbors stay warm through spreading activation along wiki-link edges. Structurally critical nodes are protected by Tarjan's algorithm. `ori prune` analyzes the full activation topology before archiving anything.

- **Four-signal fusion.** Semantic embeddings, BM25 keyword matching, personalized PageRank, and associative warmth fused through score-weighted Reciprocal Rank Fusion. Intent classification (episodic, procedural, semantic, decision) shifts signal weights automatically.

- **Dampening pipeline.** Three post-fusion stages validated by ablation testing: gravity dampening halves cosine-similarity ghosts with zero query-term overlap, hub dampening applies a P90 degree penalty to prevent map notes from dominating results, and resolution boost surfaces actionable knowledge (decisions, learnings) over passive observation.

- **Learning retrieval (v0.4.0).** Three intelligence layers improve retrieval quality from session to session, synthesized from 63 research sources. See [Retrieval Intelligence](#retrieval-intelligence-v040) below.

- **Capture-promote pipeline.** `ori add` captures to inbox. `ori promote` classifies (idea, decision, learning, insight, blocker, opportunity), detects links, suggests areas. 50+ heuristic patterns. Optional LLM enhancement.

- **Zero cloud dependencies.** Local embeddings via all-MiniLM-L6-v2 running in-process. SQLite for vectors and intelligence state. Everything on your filesystem. Zero API keys required for core functionality.

---

## Retrieval Intelligence (v0.4.0)

Three learning layers that improve retrieval quality over time without manual tuning. Synthesized from 63 research sources across reinforcement learning, information retrieval, cognitive science, and bandit theory.

### Layer 1 — Q-Value Reranking

Notes earn Q-values from session outcomes via exponential moving average updates. Over time, genuinely useful notes rise and noise sinks.

| Signal | Reward | What triggers it |
|--------|--------|-----------------|
| Forward citation | +1.0 | You `[[link]]` a retrieved note in new content |
| Update after retrieval | +0.5 | You edit a note you just retrieved |
| Downstream creation | +0.6 | You create a new note after retrieving |
| Within-session re-recall | +0.4 | Same note surfaces across different queries |
| Dead end (top-3, no follow-up) | −0.15 | Retrieved in top 3 but nothing follows |

After RRF fusion, Phase B reranks the candidate set with a lambda blend of similarity score and learned Q-value, plus a UCB-Tuned exploration bonus that ensures under-retrieved notes still get discovered. Exposure-aware correction prevents the same notes from dominating every session. A cumulative bias cap (MAX=3.0, compression=0.3) prevents runaway score inflation.

### Layer 2 — Co-Occurrence Edges

Notes that are retrieved together grow edges between them — Hebbian learning on the knowledge graph. Edge weights are computed using NPMI normalization (genuine association beyond base rate), GloVe power-law frequency scaling, and Ebbinghaus decay with strength accumulation (frequently co-retrieved pairs decay slower).

Per-node Turrigiano homeostasis prevents hub notes from absorbing all edge weight. Bibliographic coupling bootstraps day-0 edges from existing wiki-link structure before any queries have been run.

The combined wiki-link + co-occurrence graph feeds a Personalized PageRank walk (HippoRAG, α=0.5) that surfaces notes semantic search alone would never find.

### Layer 3 — Stage Meta-Learning

Each pipeline stage (BM25, PageRank, warmth, hub dampening, Q-reranking, co-occurrence PPR) is wrapped in a LinUCB contextual bandit with an 8-dimensional query feature vector. The system learns which stages help for which query types and auto-skips stages that consistently hurt.

Three-way decisions per stage: **run** / **skip** / **abstain** (stop the pipeline early). Cost-sensitive thresholds ensure expensive stages face a higher bar. Essential stages (semantic search, RRF fusion) never skip. An ACQO two-phase curriculum runs all stages during exploration (first 50 samples), then optimizes.

### Session Learning Loop

```
Query → Retrieve → Use (cite, update, create) → Reward signals
  ↓                                                    ↓
  Co-occurrence edges grow                Q-values update (session-end batch)
  ↓                                                    ↓
  Stage meta-learner updates              Better retrieval next session
```

All updates happen in a single SQLite transaction at session end, in order: co-occurrence → Q-values → stage learning.

---

## The Stack

```
Layer 6: MCP Server                    16 tools, 5 resources — any agent talks to this
Layer 5: Recursive Exploration         PPR graph traversal, sub-question decomposition, convergence detection
Layer 4: Retrieval Intelligence        Q-value reranking, co-occurrence learning, stage meta-optimization
Layer 3: Dampening Pipeline            gravity, hub, resolution — ablation-validated
Layer 2: Four-Signal Fusion            semantic + BM25 + PageRank + warmth → score-weighted RRF
Layer 1: Knowledge Graph + Vitality    wiki-links, ACT-R decay, spreading activation, zone classification
Layer 0: Markdown files on disk        git-friendly, human-readable, portable
```

16 MCP tools · 5 resources · 17 CLI commands · 579 tests

---

## Token Economics

Without retrieval, every question requires dumping the entire vault into context. With Ori, the cost stays flat.

| Vault Size | Without Ori | With Ori | Savings |
|:----------:|:-----------:|:--------:|:-------:|
| 50 notes | 10,100 tokens | 850 tokens | **91%** |
| 200 notes | 40,400 tokens | 850 tokens | **98%** |
| 1,000 notes | 202,000 tokens | 850 tokens | **99.6%** |
| 5,000 notes | 1,010,000 tokens | 850 tokens | **99.9%** |

A typical session costs **~$0.10** with Ori. Without it: **~$6.00+**.

---

## Architecture

```
                          Any MCP Client
                    (Claude, Cursor, Windsurf,
                     Cline, Hermes, custom agents, VPS)
                              │
                        MCP Protocol
                        (stdio / JSON-RPC)
                              │
                    ┌───────────────────┐
                    │    Ori MCP Server  │
                    │                   │
                    │  instructions     │   identity auto-injected
                    │  resources  (5)   │   ori:// endpoints
                    │  tools    (16)    │   full memory operations
                    └─────────┬─────────┘
                              │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
      ┌───────────┐    ┌───────────┐    ┌───────────┐
      │ Knowledge │    │ Identity  │    │Operations │
      │   Graph   │    │  Layer    │    │  Layer    │
      │           │    │           │    │           │
      │  notes/   │    │  self/    │    │  ops/     │
      │  inbox/   │    │  identity │    │  daily    │
      │  templates│    │  goals    │    │  reminders│
      └─────┬─────┘    │  method.  │    │  sessions │
            │          └───────────┘    └───────────┘
      ┌─────┴──────┐
      │            │
   Wiki-link   Embedding        ┌──────────────────────┐
    Graph       Index            │ Retrieval Intelligence│
   (in-mem)    (SQLite)          │                      │
      │            │             │  Q-values  (note_q)  │
   PageRank    Semantic          │  Co-occur  (edges)   │
   Spreading   BM25              │  Stage Q   (LinUCB)  │
   Activation  4-Signal          │  Dampening (3 stages)│
   Communities Fusion            │  Explore   (PPR+RMH) │
                                 └──────────────────────┘
```

---

## MCP Tools

| Tool | What it does |
|------|-------------|
| `ori_orient` | Session briefing: daily status, goals, reminders, vault health, index freshness |
| `ori_update` | Write to identity, goals, methodology, daily, or reminders |
| `ori_status` | Vault overview |
| `ori_health` | Full diagnostics |
| `ori_add` | Capture to inbox |
| `ori_promote` | Promote with classification, linking, and area assignment |
| `ori_validate` | Schema validation |
| `ori_query` | Graph queries: orphans, dangling, backlinks, cross-project |
| `ori_query_ranked` | Full retrieval with Q-value reranking, co-occurrence PPR, and stage meta-learning |
| `ori_warmth` | Inspect the associative warmth field |
| `ori_query_similar` | Semantic search (vector only, faster) |
| `ori_query_important` | PageRank authority ranking |
| `ori_query_fading` | Vitality-based decay detection |
| `ori_explore` | Recursive graph traversal — PPR, sub-question decomposition, convergence detection |
| `ori_prune` | Activation topology analysis and archive candidates |
| `ori_index_build` | Build/update embedding index and bootstrap co-occurrence edges |

---

## CLI

```bash
# Vault management
ori init [dir]                    # Scaffold a new vault
ori status                        # Vault overview
ori health                        # Full diagnostics

# Note lifecycle
ori add <title> [--type <type>]   # Capture to inbox
ori promote [note] [--all]        # Promote to knowledge graph
ori validate <path>               # Schema validation
ori archive [--dry-run]           # Archive stale notes
ori prune [--apply] [--verbose]   # Topology analysis + archive candidates

# Retrieval
ori explore <query>               # Recursive graph traversal (RMH)
ori query ranked <query>          # Full intelligent retrieval
ori query similar <query>         # Semantic search
ori query important               # PageRank ranking
ori query fading                  # Vitality detection
ori query orphans                 # Notes with no incoming links
ori query dangling                # Broken wiki-links
ori query backlinks <note>        # What links to this note
ori query cross-project           # Multi-project notes

# Infrastructure
ori index build [--force]         # Build embedding index
ori index status                  # Index statistics
ori graph metrics                 # PageRank, centrality
ori graph communities             # Louvain clustering
ori serve --mcp [--vault <path>]                                # Run MCP server
ori bridge claude-code [--scope <s>] [--activation <a>] [--vault <p>]  # Claude Code (hooks + MCP + instructions)
ori bridge hermes [--scope <s>] [--activation <a>] [--vault <p>]       # Hermes Agent (plugin + MCP + instructions)
ori bridge opencode [--scope <s>] [--activation <a>] [--vault <p>]     # OpenCode (plugin + MCP + AGENTS.md)
ori bridge cursor [--scope <s>] [--vault <p>]                          # Cursor (MCP config)
ori bridge codex [--scope <s>] [--vault <p>]                           # Codex (TOML config)
ori bridge generic [--scope <s>] [--vault <p>] [--json]                # Any MCP client (prints config)
ori bridge status [--json]                                             # Inspect all bridge installs
ori bridge <target> --uninstall                                        # Remove Ori config for a target
```

Path-taking commands treat relative file paths as vault-relative. Absolute
paths continue to work unchanged.

---

## Vault Structure

```
vault/
├── .ori                       # Vault marker
├── ori.config.yaml            # Configuration
├── notes/                     # Knowledge graph (flat, no subfolders)
│   └── index.md               # Hub entry point
├── inbox/                     # Capture buffer
├── templates/                 # Note and map schemas
├── self/                      # Agent identity
│   ├── identity.md            # Name, personality, values
│   ├── goals.md               # Active threads, priorities
│   ├── methodology.md         # Processing principles
│   └── memory/                # Agent's accumulated insights
└── ops/                       # Operational state
    ├── daily.md               # Today's completed and pending
    ├── reminders.md           # Time-bound commitments
    └── sessions/              # Session logs
```

Every file is plain markdown. Open it in any text editor, Obsidian, or your file browser. `git log` is your audit trail.

---

## Deployment

**Local.** Install globally, `ori init`, connect your MCP client. Done.

**VPS / headless.** Install on the server. `ori serve --mcp --vault /path/to/vault`. Memory persists on the filesystem. Back up with `git push`.

**Remote terminals.** Hermes Agent supports Docker, SSH, Modal, and Daytona backends. If your agent runs in a remote terminal, `ori` must be installed and on PATH inside that environment, and the vault must be on persistent storage (not ephemeral). For serverless backends like Modal where environments hibernate, mount the vault on a persistent volume.

**Multi-vault.** Separate Ori instances for separate agents. Each vault is self-contained: its own identity, knowledge graph, and operational state.

**Scriptable.** CLI returns structured JSON. Use in cron jobs, webhook handlers, or orchestration loops.

## Install Model

Ori separates three install concepts:

- `scope`: `global` follows one vault across the machine, `project` stays inside one repo/workspace
- `activation`: `auto` runs `ori_orient` at session start where the adapter supports it, `manual` leaves tools available but does not auto-orient
- `vault`: explicit `--vault` wins; otherwise Ori resolves by install scope

Precedence rules:

- project install overrides global install
- explicit `--vault` overrides inferred vault
- project activation overrides global activation

Bridge lifecycle:

- rerun the same `ori bridge ...` command to update vault path or activation in place
- use `--uninstall` to remove Ori-owned config from supported adapters
- generic installs emit manual uninstall instructions because Ori does not own that client config surface

Claude Code, Hermes Agent, and OpenCode are fully automated adapters with lifecycle hooks. Claude Code uses hook scripts; Hermes uses a native Python plugin installed at `~/.hermes/plugins/ori/`; OpenCode uses a JavaScript plugin at `.opencode/plugins/lifecycle.js`. All three auto-orient at session start (via first-run detection) and capture insights at session idle. Cursor and Codex have native MCP config install support. Codex writes to `~/.codex/config.toml` and uses a single global config surface; "project" scope there means project-like runtime vault discovery, not a separate project config file. Other MCP-capable clients can use `ori bridge generic` now and wire the emitted config into their own client surface.

---

## Configuration

`ori.config.yaml` controls all tunable parameters. Generated with sensible defaults on `ori init`.

| Section | Controls |
|---------|----------|
| `vitality` | Decay parameters, metabolic rates, zone thresholds, bridge bonus |
| `activation` | Spreading activation: damping, max hops, min boost |
| `retrieval` | Signal weights, exploration budget, RRF k |
| `engine` | Embedding model, database path |
| `warmth` | Surprise threshold, PPR parameters, graph weight |
| `promote` | Auto-promotion, project routing |
| `llm` | Optional: Anthropic, OpenAI-compatible, or local models |

LLM integration is optional. Every operation works deterministically with heuristics alone. When configured, LLM improves classification and link suggestions.

---

## Why Sovereignty Matters

Most memory systems store your agent's knowledge in infrastructure you do not control. A proprietary database. A cloud service. A vendor's format.

Ori stores memory as files you own. The vault is portable. Move it to a new machine, push it to a git remote, open it in a text editor. Switch MCP clients by changing one config line. The memory survives any platform change because it was never locked to a platform.

This is not ideological. It is architectural. Portable memory is composable memory.

---

## Development

```bash
git clone https://github.com/aayoawoyemi/Ori-Mnemos.git
cd Ori-Mnemos
npm install
npm run build
npm link
ori --version
```

```bash
npm test              # 579+ tests
npm run lint          # Type check
npm run dev           # Watch mode
```

Thanks to [@maichler](https://github.com/maichler) and the rest of the Ori community for their PRs and additions.

---

## License

Apache-2.0

---

Memory is sovereignty. Ori gives your agent a mind.
