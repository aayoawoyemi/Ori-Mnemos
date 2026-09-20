# Ori Mnemos

**Open-source persistent memory infrastructure for AI agents.**

Ori implements human cognition as mathematical models on a knowledge graph. Activation decay from ACT-R. Spreading activation along wiki-link edges. Hebbian co-occurrence from retrieval patterns. Reinforcement learning on retrieval itself. Recursive graph traversal with sub-question decomposition. The system learns what matters, forgets what doesn't, and optimizes its own retrieval pipeline.

Persistent memory across sessions, clients, and machines. Zero-infrastructure retrieval that [matches and in several cases strongly outperforms incumbents on benchmarks](#benchmarks) — and you own every byte of your data. Markdown on disk. Wiki-links as graph edges. Git as version control. No database lock-in, no cloud dependency, no vendor capture.

**v0.7.0** · [npm](https://www.npmjs.com/package/ori-memory) · [Paper](https://orimnemos.com/rmh) · Apache-2.0

---

## Use

Ori is three surfaces over one index. The markdown is the truth; the index is
derived. The learned half — Q-values, LinUCB arms, retrieval history — is not,
so export it before deleting anything (see [When to rebuild](#when-to-rebuild)).

**CLI**

```bash
npx ori init          # scaffold a vault
npx ori index build   # derive the index
npx ori explore "…"   # navigated retrieval
npx ori sql "…"       # read-only SQL over the index
```

**MCP server** — `ori serve`, registered in a client config. This is how an
agent uses it.

**Library** — `recall` is the same wired entry the CLI and the MCP
`ori_recall` tool both go through, so the programmatic path and the agent
path cannot drift.

```ts
import { recall } from "ori-memory";

const res = await recall("./vault", "what did we decide about caching?", { limit: 5 });
for (const hit of res.data.results) console.log(hit.title, hit.score);
```

`searchComposite` is also exported for callers that have already assembled
vectors, graph metrics and a config; `recall` does that assembly for you.

The export surface is deliberately small and is a semver contract; the rest of
`src/core` is internal. Versions before 0.7.1 shipped no `main` and no
`exports`, so a bare import threw and the library path did not exist — but the
CLI and MCP paths always worked, and existing users were unaffected.

`ori-memory/cli` resolves to the CLI entry, for callers that need to locate
the binary and spawn it rather than link against it. `require.resolve` on it
is the intended use; importing it runs the CLI.

## Benchmarks

### ForgetEval — Can It Forget On Command?

[deeplethe/lethe](https://github.com/deeplethe/lethe), `bench/forgeteval/`,
MIT. **No API key, no network, no LLM judge.** The scorer is a ~20-line
deterministic substring check in `GeneratedCase.run()`: it calls
`recall_texts(query, k=10)` itself, joins the top 10, and tests
`must_contain` / `must_not_contain`. Generation is `random.Random(42)` over
templates. The optional LLM hook is `llm=None` by default and was not used.

| family | Ori | what it requires |
|---|:---:|---|
| supersession | **200 / 200** | replace a fact, old value must not surface |
| decay | **200 / 200** | `release(query)` — soft-evict on demand |
| amnesia | **198 / 200** | evict one subject, keep the bystanders |
| purge | **182 / 200** | hard-delete, verbatim secret must be gone |
| drift | **198 / 200** | two supersessions in sequence, only the last survives |
| **overall** | **978 / 1000 (97.8%)** | 1,000 generated cases, seed 42 |

Not fitted to the suite: unseen seeds give **97.2%** (seed 7) and **98.0%**
(seed 123). The fixes were structural bugs in the matcher, not case-specific
patches.

| System | template | adversarial |
|---|:---:|:---:|
| LangMem | 99.5 | — |
| Lethe v1 | 99.3 | 63.4 |
| **Ori Mnemos** | **97.8** | **65.7** |
| Mem0 | 88.8 | 68.3 |
| MemPalace | 0 | — |

**Ori scored 0/1000 on this benchmark earlier the same day.** Not a low
score — a structural zero. ForgetEval's adapter protocol has three optional
operations, `supersede`, `release` and `purge`, and Ori had none of them:
zero source hits across `src/`. Every case was N/A. The ACT-R decay and
Ebbinghaus curves Ori already had are ranking-time priors, and no benchmark
measures those; ForgetEval's "decay" family means an explicit `release(query)`
call. `src/core/forget.ts` is 305 lines and closed the whole gap in a day,
which is the most informative number on this page.

**That table is not a ranking, and "third" would be a bad way to read it.**

ForgetEval's code lives inside `deeplethe/lethe` — the benchmark and its
top-scoring system are the same org, in a repo with 14 stars. The template
column has four entries, one of which (MemPalace) scores 0 by construction
because it exposes no deletion primitive at all. Two of the rest saturate.
On the adversarial layer Ori is 5th of 14 configurations and lands inside
the 63–68% band the paper's own McNemar test calls noise (χ²=0.125,
p=0.724); the paper's words are "the bench reads the trade-off, not a
winner." The one comparison that is statistically real is Ori vs Lethe on
template, z=2.81, p=0.005 — Lethe is genuinely ahead.

**Who is missing matters more than who placed.** Supermemory (30.6k stars,
$2.6M seed) ships `POST /v4/memories/forget-matching` — natural-language
forgetting with `dryRun`, `threshold`, `maxForget` and an audit handle —
plus versioned `PATCH` supersession. That is a better-specified control
plane than anything scored here, and it maps onto the adapter protocol
almost verbatim. It has never been benchmarked. Neither have Hindsight
(24.0k), Cognee (30.8k, excluded for API incompatibility), MemOS (11.5k) or
Honcho (7.3k).

So the honest claim is not that Ori forgets better than the field. It is
that **Ori forgets offline, with no API key**, and that the field has no
idea how well it forgets:

> Fifteen agent-memory systems were checked. **Zero publish a forgetting
> benchmark for their own system.** Five such benchmarks exist — ForgetEval,
> Memora/FAMA, MemoryAgentBench-SF, StateMemBench, MemLeak — and vendors
> cite none of them. Every forgetting number in existence was produced by a
> rival or an outsider.

**Read the adversarial column with one more caveat.** 253 of its 385 cases
were admitted only if the vendor's own system passed them, annotated in
`adversarial.py` as "Oracle-validated (Lethe / Lethe+LLM passes the case)".
The authors' own blind 77-case external subset drops the whole field from
the 63–68% band to 28–33%, which says the in-house suite is materially
easier. A benchmark whose admission filter is "the measurer's system solves
it" cannot rank the measurer.

Reproduce:

```bash
git clone https://github.com/deeplethe/lethe && cd lethe
cp <ori>/bench/forgeteval_ori_adapter.py bench/forgeteval/ori_adapter.py
export ORI_BRIDGE=<ori>/bench/forgeteval-bridge.mjs
python -m bench.forgeteval.run --adapter ori --suite template --scale 200 --seed 42
```

Four minutes, 1,000 cases, $0.00. The adapter talks NDJSON to a resident Node
process because the harness makes ~10 calls per case and a CLI subprocess per
call would spend hours on interpreter startup.


### HotpotQA — Multi-Hop Retrieval

Head-to-head against [Mem0](https://github.com/mem0ai/mem0). Both systems indexed the
same documents and answered the same questions in the same run.

| Metric | Ori Mnemos | Mem0 1.0.6 | Δ |
|--------|:----------:|:----------:|:-:|
| Recall@5 | **0.87** | 0.29 | **3.0×** |
| MRR | **0.91** | 0.42 | **2.2×** |
| Retrieval F1 | **0.51** | 0.26 | **2.0×** |
| Answer proxy | **0.73** | 0.34 | **2.1×** |
| Infrastructure | Markdown + SQLite | Redis + Qdrant + cloud | — |

`n = 50`, single run, no seed averaging, `topK = 5`. Mem0 at **1.0.6** (March 2026);
**2.x is not yet re-run**, so read this as a point-in-time comparison, not a current
one. Raw output: [`bench/results/`](./bench/results/), reproduce with
[`bench/hotpotqa-eval.ts`](./bench/hotpotqa-eval.ts) and
[`bench/mem0-hotpotqa.py`](./bench/mem0-hotpotqa.py).

**These are not HotpotQA's official metrics and must not be compared to the
HotpotQA leaderboard.** The official scorer, `hotpot_evaluate_v1.py`, reports
answer EM/F1 under its own `normalize_answer`, plus supporting-fact F1 over
`(title, sentence_id)` pairs, plus joint EM/F1. The table above is a
title-level retrieval metric defined in `bench/hotpotqa-eval.ts`, and
"answer proxy" is not a HotpotQA metric at all — it is token recall of the
gold answer against retrieved text. The comparison is valid in one direction
only: Ori and Mem0 went through the *same* harness on the *same* questions,
so the ratio between the two columns means something. The absolute numbers
do not transfer anywhere.

At `n = 50` the Wilson 95% intervals are Ori `[0.75, 0.94]` and Mem0
`[0.18, 0.43]` on Recall@5. They do not overlap, so the gap is real, but the
two-decimal precision in the table is not: read 0.87 as "high 0.80s".

Latency is not reported here. The evaluation harness does not record it, so any
number would be recalled rather than measured. What is measured is that Ori answers
from markdown plus a local SQLite index with **no API key and no network**.

### LoCoMo — Long-Term Conversational Memory

**1,536 questions over 10 conversations.** Retrieval is BM25 + embedding +
PageRank fusion at top-5. No API key and no network: the answer column is an
extractive proxy, token recall of the ground-truth answer against retrieved
text, not a generated answer.

| Category | Recall | Answer F1 | MRR | n |
|---|:---:|:---:|:---:|:---:|
| open-domain | 0.943 | 0.929 | — | 841 |
| single-hop | 0.863 | 0.758 | — | 321 |
| multi-hop | 0.528 | 0.670 | — | 282 |
| temporal | 0.565 | 0.478 | — | 92 |
| **overall** | **0.827** | **0.819** | **0.729** | **1,536** |

Raw output: `bench/results/locomo-eval-2026-09-19T22-37-31-698Z.json`.
Reproduce with `npx tsx bench/locomo-eval.ts --json`; the run takes 48 s.

Multi-hop and temporal are the weak categories and are reported as such.

Two corrections to earlier versions of this file, both found on 2026-09-19:

- It previously reported **695** questions and an overall recall of 0.687. That
  subset silently excluded the open-domain category, which is 841 of the 1,536
  questions — more than half the benchmark. The per-category figures were close
  to correct; the "overall" was an average over a hand-picked three categories.
  `bench/README.md` carried a third set of numbers again (44.7% recall) that
  reproduces nothing in the current harness. One number now, with the run file
  beside it.
- The 2026-09-19 run reproduces the 2026-07-22 run to three decimals, so these
  figures are stable across the retrieval-metric repair in `09ac45d` and the
  lambda change in `72fdd13`.

**No comparison table against published LoCoMo leaderboards is given, on purpose.**
Those are LLM-judge scores; the above is token F1. They are different quantities
and putting them in one column would invent a ranking rather than report one. A
previous version of this README did exactly that.

LoCoMo itself has known defects. An independent audit found 6.4% of questions
carry wrong answer keys, putting the theoretical ceiling at 93.57%, and the
standard gpt-4o-mini judge accepts 62.81% of deliberately wrong answers. At
least one published score exceeds the mathematical ceiling. A close result on
this benchmark is weak evidence in either direction, which is why it is reported
here and not led with.

### LongMemEval-S — Retrieval, 500 Questions

Session granularity, 470 scored (the official scorer excludes the 30
abstention questions). **No API key, no network, no LLM judge** — the
benchmark's own scorer imports `sys`, `json` and `numpy` and nothing else.

| | recall_any@k | recall_all@k | ndcg_any@k |
|---|:---:|:---:|:---:|
| @1 | 0.866 | 0.300 | 0.866 |
| @5 | **0.966** | **0.830** | **0.884** |
| @10 | 0.981 | 0.904 | 0.898 |

`recall_all@k` requires *every* gold session in the top k; `recall_any@k`
requires one. The official summary reports `recall_all@5` and `ndcg_any@5`.

Against published figures on the same benchmark using the same embedder, all
three zero-API-call:

| System | Embedder | R@1 | R@5 | R@10 |
|---|---|:---:|:---:|:---:|
| MemPalace (raw) | all-MiniLM-L6-v2 | 80.6% | 96.6% | 98.2% |
| Lethe v1 | all-MiniLM-L6-v2 | 85.4% | **97.4%** | **99.0%** |
| **Ori Mnemos** | Xenova/all-MiniLM-L6-v2 | **86.6%** | 96.6% | 98.1% |

Ori leads at @1 and is at parity by @10. **That is a smaller claim than it
looks.** An independent analysis of MemPalace
([arXiv:2604.21284](https://arxiv.org/abs/2604.21284)) concluded its 96.6% R@5
"is the performance of ChromaDB's default embedding model (all-MiniLM-L6-v2)
applied to verbatim text chunks" and is reproducible with a minimal ChromaDB
setup. At k=5 this metric is saturated and mostly measures the embedder, which
is the same one in all three rows. The honest reading is that Ori's retrieval
is not the bottleneck and this axis no longer separates systems.

Ori's `recall_any@5` of 0.9660 and MemPalace's published 96.6% agree to three
significant figures. That is a coincidence, not a copied number; the full
per-question output is committed.

Weak categories, consistent with LoCoMo: multi-session 0.653 and
temporal-reasoning 0.772 `recall_all@5`, against 1.000 for both single-session
types. Multi-hop and temporal are where Ori loses on both benchmarks, which is
two independent measurements agreeing rather than noise.

Reproduce:

```bash
npx tsx bench/longmemeval-eval.ts --data <longmemeval_s_cleaned.json>
python bench/longmemeval-score.py <rankings.json> <path/to/LongMemEval>
python <LongMemEval>/src/evaluation/print_retrieval_metrics.py <rankings.jsonl>
```

11 minutes, 500 questions, $0.00. `bench/longmemeval-score.py` imports the
benchmark's own `evaluate_retrieval` rather than reimplementing `recall_all@k`,
so these are the authors' metric definitions.

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

Claude Code, Hermes Agent, and OpenCode get full lifecycle integration — the agent orients at session start, captures insights at session end, and validates notes on write. Cursor, Codex, and other MCP clients get access to all 14 tools but manage their own session lifecycle.

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
Layer 6: MCP Server                    14 tools, 5 resources — any agent talks to this
Layer 5: Recursive Exploration         PPR graph traversal, sub-question decomposition, convergence detection
Layer 4: Retrieval Intelligence        Q-value reranking, co-occurrence learning, stage meta-optimization
Layer 3: Dampening Pipeline            gravity, hub, resolution — ablation-validated
Layer 2: Four-Signal Fusion            semantic + BM25 + PageRank + warmth → score-weighted RRF
Layer 1: Knowledge Graph + Vitality    wiki-links, ACT-R decay, spreading activation, zone classification
Layer 0: Markdown files on disk        git-friendly, human-readable, portable
```

14 MCP tools · 5 resources · 19 CLI commands · 874 tests

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
| `ori_wake` | Session boot: bounded briefing, plus onboarding on a fresh vault |
| `ori_update` | Write to identity, goals, methodology, daily, or reminders |
| `ori_update_decision` | Record the user's answer to an update notice |
| `memory_sql` | Read-only SQL over the index — anything the ranking tools cannot express |
| `ori_health` | Full diagnostics |
| `ori_add` | Capture to inbox |
| `ori_promote` | Promote with classification, linking, and area assignment |
| `ori_validate` | Schema validation |
| `ori_query_ranked` | Full retrieval with Q-value reranking, co-occurrence PPR, and stage meta-learning |
| `ori_query_similar` | Semantic search (vector only, faster) |
| `ori_warmth` | Inspect the associative warmth field |
| `ori_explore` | Recursive graph traversal — PPR, sub-question decomposition, convergence detection |
| `ori_prune` | Activation topology analysis and archive candidates |
| `ori_index_build` | Build/update embedding index and bootstrap co-occurrence edges |

Five tools were removed in favour of `memory_sql`, which answers their
questions in one statement and is 20–46× faster because it reads the index
instead of re-walking the vault from disk:

| was | now |
|---|---|
| `ori_status` | `SELECT COUNT(*) FROM v_note` |
| `ori_query orphans` | `SELECT title FROM v_note WHERE inbound = 0` |
| `ori_query dangling` | `SELECT * FROM v_dangling` |
| `ori_query backlinks` | `SELECT src_title FROM v_link WHERE dst = '…'` |
| `ori_query cross-project` | `SELECT n.title FROM v_note n JOIN note_project p ON p.note_id = n.id GROUP BY n.id HAVING COUNT(DISTINCT p.project) > 1` |
| `ori_query_important` | `SELECT title, pagerank FROM v_note ORDER BY pagerank DESC` |
| `ori_query_fading` | `ori_prune`, which its own description already deferred to |

The three navigated-exploration tools (`explore_start` / `_expand` /
`_conclude`) were removed from MCP after six months with zero recorded
sessions. They remain available as `ori explore-start`, `ori explore-expand`
and `ori explore-conclude`.

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
ori index build [--force]         # Rebuild everything derived from the vault
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

### When to rebuild

`.ori/` holds two different things, and only one of them is disposable.

**Derived** — rebuilt from the markdown on demand:

| store | maintained by | needs `ori index build` when |
|---|---|---|
| derived index (`note`, `edge`, `note_term`, graph-metrics cache) | every query, automatically — one `stat` per file, reparse only what changed | never for an edit; `--force` if a query warns it "covers N of M notes" |
| embeddings (semantic vectors) | `ori add` on write; queries only if the table is missing or empty | a note was written by something other than `ori add` (an editor, a sync client, a script) — it is findable by keyword and links immediately, but not by meaning until it is embedded |
| co-occurrence bootstrap | `ori index build` only | link structure changed a lot and you want day-0 edges to reflect it |

**Accumulated** — nowhere else, and a rebuild destroys it:

`retrieval_log`, `note_q`, `q_history`, `q_history_genuine`, `stage_q`,
`stage_log`, `boosts`, `note_access`, `memory_events`, and the `retrieval`
rows of `co_occurrence`.

Measured on a 1,548-note vault: `rm -rf .ori/ && ori index build` empties
**eight** of those tables — six months of retrieval history across 564
sessions, 1,427 learned Q-values, and the eight live LinUCB arms that decide
which ranking stages run. Two of them, `q_history_genuine` and
`memory_events`, are created by no production code at all and cannot be
reconstructed by anything.

So export before you delete:

```bash
ori index export-learned          # -> ops/ori-learned.ndjson
rm -rf .ori/
ori index build
ori index import-learned
```

That round-trip is verified lossless on a real vault by
`bench/learned-roundtrip.mjs`, which compares row counts *and* a digest over
the Q-values themselves, because counts matching while values drift is a pass
that means nothing. The export is NDJSON, deterministically ordered, ~23 MB
for 56,850 rows against a 243 MB binary — small enough and diffable enough to
commit, which the binary is not.

The practical rule: **edit and query freely; run `ori index build` after
bulk-adding notes from outside Ori, and `ori index build --force` if a query
reports it cannot cover the vault.** `--force` is a full reparse that keeps
accumulated state; only deleting the file loses it.

Earlier versions of this README said everything under `.ori/` was derived and
disposable. That was wrong, and following it cost six months of learning.

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
- `activation`: `auto` runs `ori_wake` at session start where the adapter supports it, `manual` leaves tools available but does not auto-orient
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
