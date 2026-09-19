# What benchmark must Ori run to be taken seriously in late 2026 — and can it?

> Research date: 2026-09-19 · Scope: agent-memory evaluation landscape · Status: read-only investigation, no repo changes

---

## Verdict (5 lines)

1. **Every headline number in this field is vendor self-reported, and the most-cited benchmark is demonstrably broken** — LoCoMo has a 6.4% wrong-answer-key rate (93.57% ceiling), its judge accepts 62.81% of deliberately wrong answers, and one published system scores *above* the mathematical ceiling.
2. **Run LongMemEval-S retrieval-only first.** 500 questions, official MIT harness, `print_retrieval_metrics.py` is pure numpy — **$0.00, no API key**, and there are two published tables using the *exact same* `all-MiniLM-L6-v2` embedder Ori already ships, so the comparison is apples-to-apples on the first try.
3. **Ori's forgetting differentiator is already taken — and Ori would currently score ~0% on the benchmark that measures it.** ForgetEval (MIT, zero LLM judge) tests `supersede`/`release`/`purge`; `grep` of `src/` finds none of them. Ori's ACT-R/Ebbinghaus decay is a *ranking prior*, not a control-plane mutation, and ForgetEval's "decay" family means explicit `release(query)`, not time decay.
4. **Ori's repo currently publishes three mutually inconsistent LoCoMo numbers.** Fix that before running anything new; it is a bigger credibility risk than any missing benchmark.
5. **Ori cannot meaningfully run BEAM-10M, LongMemEval-V2, or MemoryArena** — not for cost reasons, but because they require an *acting agent*, and Ori is a retrieval substrate, not an agent.

---

## 1. The benchmark table

| Benchmark | What it measures | Size | Harness | Needs API key? | Current SOTA | Self-reported? |
|---|---|---|---|---|---|---|
| **LoCoMo** (ACL 2024) | QA over multi-session dialogue: single-hop, multi-hop, temporal, open-domain, adversarial | 10 convs; **1,540** scored QA + 446 adversarial (cat-5, *never evaluated by anyone*) | [snap-research/locomo](https://github.com/snap-research/locomo) (1,178★) | **Yes** for the J-score (gpt-4o-mini judge). **No** if you score retrieval only | ZeroMemory 96.1 · ByteRover 92.2 *or* 96.1 · Zep 94.7 · Mem0 92.5 · Dakera 88.2 | **All self-reported.** Zero independent reproductions; two failed ones |
| **LongMemEval-S / -M** (ICLR 2025) | 5 abilities: info extraction, multi-session reasoning, temporal reasoning, **knowledge updates**, **abstention** | **500** questions. S ≈ 115k tok / ~40 sessions; M ≈ 500 sessions | [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval) (1,095★, MIT) | **QA track: yes** (`evaluate_qa.py`, gpt-4o; `model_zoo` also accepts a local Llama-3.1-70B at `localhost:8001`). **Retrieval track: NO — `print_retrieval_metrics.py` imports only `sys`, `json`, `numpy`** | QA: Mastra OM **94.87** (gpt-5-mini) / **84.23** (official gpt-4o) · Hindsight 91.4 · Mem0 94.4 · Zep 71.2 · full-context 60.20. Retrieval R@5: MemPalace **96.6**, Lethe **97.4** | Mastra & Hindsight publish runner code; Mem0's 94.4 is self-reported on its own research page |
| **MemoryAgentBench** (ICLR 2026) | 4 competencies: Accurate Retrieval, Test-Time Learning, Long-Range Understanding, **Conflict Resolution** (their "selective forgetting") | Chunked 512/4096-tok corpora + new **EventQA** & **FactConsolidation** | [HUST-AI-HYZ/MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) (458★, MIT) | **Mostly no for scoring** (`substring_exact_match`, `exact_match`, `Recall@5`); only the `longmemeval` + `infbench` subsets need a gpt-4o judge. **But the agent under test is an LLM agent** → key needed in practice | FactConsolidation single-hop: HippoRAG-v2 54.0 · BM25 48.0 · Mem0 18.0 · **Zep/Graphiti 7.0**. Multi-hop: **≤7% for every system** | Paper-reported, peer-reviewed (ICLR 2026) |
| **BEAM** (ICLR 2026) | 10 memory capabilities at 1M and 10M tokens | 100 convs, **2,000** validated questions | Paper [arXiv:2510.27246](https://arxiv.org/abs/2510.27246); Mem0 maintains [mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks) *(I did not verify BEAM data ships there)* | **Yes** — reader + judge | Mem0 **64.1** (1M) / **48.6** (10M) | Self-reported by Mem0; LIGHT baseline is paper-reported |
| **LongMemEval-V2** (2026) | 5 agent-memory abilities over **web-agent trajectories**: static state recall, dynamic state tracking, workflow knowledge, environment gotchas, premise awareness | **451** questions, ≤500 trajectories, **up to 115M tokens** | [xiaowu0162/LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) (162★, Apache-2.0) — **has a real public leaderboard + submission packaging** | **Yes** — judge defaults to **gpt-5.2 medium reasoning**; reader Qwen3.5-9B via vLLM; AgentRunbook-C needs a Codex binary | Live leaderboard, two tiers | Third-party-adjudicated via leaderboard submission — **the most credible venue in the field** |
| **MemoryArena** (ICML 2026) | Memory used to *drive action* in multi-session Memory-Agent-Environment loops | 5 task families (bundled shopping, progressive search, group travel planner, formal reasoning math/phys) | [ZexueHe/MemoryArena](https://github.com/ZexueHe/MemoryArena) · [HF data](https://huggingface.co/datasets/ZexueHe/memoryarena) | **Yes** — requires an acting agent | Systems near-saturated on LoCoMo **drop to 40–60%** | Paper-reported (ICML 2026) |
| **ForgetEval / ForgetEval-Adv** (2026) | **FORGETTING**: supersession, decay, amnesia, purge, drift + 10 adversarial attack categories | **1,000** templated + **385** adversarial (132 hand-crafted + 253 LLM-drafted, oracle-validated) | [deeplethe/lethe](https://github.com/deeplethe/lethe) → `bench/forgeteval/run.py` (MIT) | **NO. Deterministic substring match on top-k. Generation is template+RNG, offline, seed=42.** Optional LLM mutation hook costs **$0.17/385-case run** | Template: LangMem 99.5 · Lethe 99.3 · Mem0 88.8 · MemPalace 0. **Adv: Mem0 68.3 · Lethe 63.4 · LangGraph 62.9 · +LLM hook 91.7–93.2** | Vendor-authored (Lethe's own author) — **but** 10-annotator Fleiss' κ = 0.958 and a 77-case blind external subset replicate the finding |
| **Memora / FAMA** (2026) | remembering / reasoning / recommending + **Forgetting-Aware Memory Accuracy** (penalizes reliance on invalidated memory) | weeks-to-months conversations | [arXiv:2604.20006](https://arxiv.org/abs/2604.20006); public harness not confirmed | **Yes** (agent + judge) | "Memory agents offer marginal improvements" | Paper-reported |
| **LoCoMo-Plus** (2026) | Adds *cognitive* / implicit-inference questions (cue–trigger pairs with no lexical overlap) | Inherits all 1,540 LoCoMo questions **including all 99 bad keys** + new cognitive category | [arXiv:2602.10715](https://arxiv.org/abs/2602.10715) | **Yes** (gpt-4o-mini default) | — | Paper-reported |

---

## 2. Leaderboards, and why they are not leaderboards

### LoCoMo is broken, and this is now documented, not alleged

[`dial481/locomo-audit`](https://github.com/dial481/locomo-audit) is an independent, SHA256-provenanced audit with reproducible scripts. Its findings:

| Finding | Detail |
|---|---|
| Ground-truth errors | **99 of 1,540 questions (6.4%)** have wrong golden answers → **theoretical ceiling 93.57%**. Northcutt et al. (NeurIPS 2021) found 3.3% average across 10 major ML benchmarks; LoCoMo is nearly double |
| Judge leniency | Deliberately wrong but topically adjacent answers: **62.81% accepted** by the same gpt-4o-mini judge config used in published evals. Specific factual errors caught ~89%; *vague-but-on-topic* passed two-thirds of the time — **exactly the failure mode of weak retrieval** |
| Impossible scores | EverMemOS single-hop **95.96%** vs its category ceiling **95.72%**; multi-hop **91.37%** vs ceiling **90.07%**. Mathematically impossible without credit from wrong keys |
| The prompt, not the memory | An independent full-context baseline (GPT-4.1-mini + CoT prompt, **no memory system at all**) scores **92.62%**, beating EverMemOS's 92.32% |
| Reproducibility | Third party: **38.38% vs claimed 92.32%** ([EverMemOS#73](https://github.com/EverMind-AI/EverMemOS/issues/73)). Open Mem0 repro issues ([mem0#3944](https://github.com/mem0ai/mem0/issues/3944)); Zep scoring dispute ([zep-papers#5](https://github.com/getzep/zep-papers/issues/5)) |
| Statistical power | Category n ranges **96 to 841 (8.8×)**. Wilson 95% CIs make **56% of adjacent-pair per-category comparisons statistically indistinguishable**; the smallest category needs a **15+ point gap** to separate any two systems. Only Mem0 documents a multi-run methodology; everyone else reports single-run point estimates |
| Category 5 | **446 adversarial questions (22.5% of the dataset) that no published LoCoMo result has ever evaluated.** The original multiple-choice formatter references a missing field on 444/446 questions |

Zep's [own critique](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/) adds: conversations are only **16k–26k tokens** (fits any modern context window); **no knowledge-update questions**; and — the killer — *Mem0's own paper shows a plain full-context baseline at ~73 J beating Mem0's best at ~68 J*.

**The scoreboard is incoherent in both directions.** Zep's own LoCoMo figure has been published as 65.99 (Mem0's measurement) → 75.14 (Zep's correction, with an on-page correction notice) → 80% (Dec 2025) → 94.7% (2026). ByteRover has published **both** 92.2 and 96.1 for itself in different places, and its 96.1 is *identical* to ZeroMemory's separately claimed 96.1. ByteRover's own comparison table puts Zep at 75.1 and Mem0 at 66.9 — both far below what those vendors report for themselves. Mem0's own benchmark guide concedes: *"None of these numbers were generated using the same model stack, judge model, or retrieval configuration."*

### LongMemEval is a cleaner instrument with one structural flaw

Penfield Labs' critique is correct and important: **LongMemEval-S is ~115k tokens per question, and current models have 200k–1M context windows.** The entire corpus fits in one context. Mastra's own numbers prove it — full-context gpt-4o scores **60.20%**, and their Observational Memory scores 84.23% "largely by compressing context to fit more comfortably." As context windows grow, the baseline climbs and the benchmark loses discriminative power.

This matters for Ori in a specific way: **it means the QA track measures the reader model at least as much as the memory system, and Ori has no reader.** The retrieval track does not have this problem.

The LongMemEval QA leaderboard (from [Mastra's research post](https://mastra.ai/research/observational-memory), Feb 2026 — the most transparently documented board available, with runner code linked):

| System | Model | Overall |
|---|---|---|
| Mastra OM | gpt-5-mini | **94.87%** |
| Mastra OM | gemini-3-pro-preview | 93.27% |
| Hindsight | gemini-3-pro-preview | 91.40% |
| EmergenceMem *Internal*\* | gpt-4o | 86.00% |
| Supermemory | gemini-3-pro-preview | 85.20% |
| **Mastra OM** | **gpt-4o (official benchmark model)** | **84.23%** |
| Oracle (only the answer-bearing sessions) | gpt-4o | 82.40% |
| Mastra RAG (topK 20) | gpt-4o | 80.05% |
| Zep | gpt-4o | 71.20% |
| **Full context (no memory system)** | gpt-4o | **60.20%** |

\* not publicly reproducible per Mastra.

> ⚠️ **Use the cleaned dataset.** In 2025/09 the authors re-cleaned the history sessions to remove answer interference: [`xiaowu0162/longmemeval-cleaned`](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned). Numbers from the original release are not comparable.

---

## 3. The minimum a skeptical Hacker News reader would accept

A 324-star library does **not** need to beat Mem0. It needs to satisfy four conditions, and there is exactly one run that satisfies all four for $0.00.

**The four conditions:**
1. A **named public dataset** with a **named public harness** (not a homemade gold set).
2. A metric that is **deterministic** — no LLM judge that a commenter can dismiss as "the judge accepts 63% of wrong answers."
3. A **published third-party number on the same axis with the same embedder**, so the comparison is not a lone self-reported figure.
4. **Full protocol disclosure**: dataset version, embedder, chunk granularity, top-k, number of runs, and the raw output committed to the repo.

### ✅ The run: LongMemEval-S, retrieval track, session-level

- **Dataset:** `longmemeval_s_cleaned.json` — [huggingface.co/datasets/xiaowu0162/longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)
- **Harness:** [`xiaowu0162/LongMemEval`](https://github.com/xiaowu0162/LongMemEval), `src/evaluation/print_retrieval_metrics.py`
- **Metrics:** `recall_all@5`, `ndcg_any@5`, `recall_all@10`, `ndcg_any@10` at session level (and turn level). Upstream convention: **skip the 30 abstention instances** (they have no ground-truth answer location).
- **API key: NO.** That script imports `sys`, `json`, `numpy`. Nothing else. The upstream baselines it compares against (`flat-bm25`, `flat-contriever`, `flat-stella`, `flat-gte`) are all local models.
- **Cost: $0.00.**

**Why this one and not LoCoMo:** Ori already runs LoCoMo, and its LoCoMo result is *unpublishable as a comparison* because Ori scores token-F1 and the leaderboard scores a binary LLM judge. Ori's README already says this, correctly. Running LongMemEval retrieval gives Ori a number on an axis where **directly comparable third-party figures exist using Ori's own embedder**:

| System | Embedder | R@1 | R@5 | R@10 | API calls |
|---|---|---|---|---|---|
| MemPalace (raw) | all-MiniLM-L6-v2 | 80.6% | **96.6%** | 98.2% | zero |
| Lethe v1 | all-MiniLM-L6-v2 | **85.4%** | **97.4%** | **99.0%** | zero |
| **Ori Mnemos** | Xenova/all-MiniLM-L6-v2 (384d) | **?** | **?** | **?** | **zero** |

Ori's `ori.config.yaml` in `bench/locomo-eval.ts` already pins `Xenova/all-MiniLM-L6-v2` at 384 dims. Same model, same axis, same zero-key story. This is the rarest thing in this field: **a fair fight that Ori can stage without spending a cent.**

**Calibrate the expectation honestly.** An independent academic analysis of MemPalace ([arXiv:2604.21284](https://arxiv.org/abs/2604.21284)) concluded that the 96.6% R@5 "is the performance of ChromaDB's default embedding model (all-MiniLM-L6-v2) applied to verbatim text chunks" and is "reproducible with a minimal ChromaDB setup — no palace structure required." **R@5 on LongMemEval-S is near-saturated and mostly measures the embedder.** So:

- Ori matching ~96–97% R@5 proves *nothing special* and should be framed as a sanity floor, not a win.
- **R@1 is where the signal is.** Lethe's own framing: its lead over MemPalace is "6× wider at R@1 than at R@5" (+4.8pp vs +0.8pp). Ori's whole thesis — BM25 + embeddings + PageRank + Q-value reranking fused by score-weighted RRF — is a *ranking* thesis. **R@1 and nDCG@5 are the metrics that can actually vindicate it.** If Ori's fusion is worth anything, it shows up there or nowhere.

### ❌ Fix this first: Ori publishes three different LoCoMo scores

This is the highest-priority item in the entire report, and it costs nothing but an hour.

| Source | Questions | Overall Recall | Overall AnsF1 |
|---|---|---|---|
| `bench/README.md` | 695 | 44.7% | 63.5% |
| `README.md` | 695 | 68.7% | 68.5% |
| `bench/results/locomo-eval-2026-07-22T01-46-25-769Z.json` | **1,536** | **82.7%** | **82.0%** |

The July 2026 run is the strongest *and* the most standard — 1,536 questions is the full non-adversarial LoCoMo (1,540 minus 4 with unmappable evidence), i.e. **the same question set Mem0 reports 92.5 on**. It is also the only one that includes the open-domain category (n=841, AnsF1 0.929), which is why its aggregate is so much higher. Neither README cites it.

A skeptical reader who finds three numbers stops reading. Pick one run, state which categories are included, delete the others, and keep the (genuinely good) paragraph explaining why AnsF1 ≠ J-score. Also rename the `--llm-judge` flag: it does **LLM answer generation scored by token F1**, not LLM-as-judge, and the name invites exactly the misreading the README works hard to avoid.

---

## 4. Forgetting: the differentiator is taken, and Ori would currently score ~0%

This is the section that matters most, and the news is bad in a useful way.

### What exists

**ForgetEval** ([arXiv:2606.15903](https://arxiv.org/abs/2606.15903), code MIT at [`deeplethe/lethe`](https://github.com/deeplethe/lethe)) is the only benchmark that directly scores forgetting, and it is *perfectly* suited to Ori's zero-key constraint:

- **No LLM judge.** Pass/fail is exact substring matching on the joined text of top-k. 
- **No API, no network.** Cases are template + entity-pool substitution, deterministic at `seed=42`.
- **Five families:** `supersession` (new fact wins, old absent), `decay` (released fact stays out of top-k), `amnesia` (forget one entity, siblings survive — *width control*), `purge` (hard-delete by identifier; `alice@acme.io` must not take `bob@acme.io` with it), `drift` (5-step supersession chain, all intermediates unreachable).
- **Six-method Adapter Protocol**, ~130 lines per adapter: `reset`, `inscribe`, `recall_texts` (mandatory) + `supersede`, `release`, `purge` (optional; `NotImplementedError` → scored **N/A, counted as a fail in the overall rate**).
- **Cost: $0.00.** The optional LLM mutation hook costs a *measured* **$0.17 per 385-case adversarial run** (DeepSeek-V3 via SiliconFlow).

There is also a companion system, **Lethe** — MIT, Python, local-first, single SQLite file, MCP server, zero API calls, Ed25519-signed purge receipts anchored to a Merkle root over an append-only event log, and `recall(query, at=T)` time travel. Its tagline is *"The first AI memory built to forget."*

**It has 14 stars.** Ori has 324. The *idea* is taken; the *audience* is not. But the idea being taken means Ori can no longer claim novelty on "memory that forgets" without being corrected in the first HN comment.

### Why Ori would score ~0% today

I grepped `src/`. Ori's forgetting machinery is real and genuinely well-built — and **structurally invisible to every forgetting benchmark that exists.**

**What Ori has** (`src/core/vitality.ts`, `src/core/activation.ts`):
- `computeVitalityACTR(accessCount, lifetimeDays, decay=0.5)` — real ACT-R base-level learning.
- `computeVitalityFull(...)` layering metabolic rate, structural stability boost (`inDegree`), access saturation, revival spike, spreading-activation boost, bridge protection floor, clamp to [0,1].
- `ebbinghausDecayRate(access, sessions) = BASE_DECAY_RATE / (1 + 0.2·ln(1+access) + 0.3·ln(1+sessions))`, applied as `boost · e^(−rate·days)`.
- `classifyZone` → active / stale / fading / archived; `rankByFading`; `cli/prune.ts`, `cli/archive.ts`, `health.ts` flagging vitality < 0.2.

**What Ori does not have:**

| ForgetEval method | Ori equivalent | Verdict |
|---|---|---|
| `reset()` | temp vault + rebuild index | ✅ trivial |
| `inscribe(text) -> id` | `ori add` / write note + index | ✅ trivial |
| `recall_texts(query, k) -> list[str]` | `runQueryRanked` / `searchComposite` | ✅ already exercised by `bench/eval-rrf.mjs` |
| `supersede(old_query, new_text)` | **none** — no supersession edge, no `superseded_by` write path in `src/` | ❌ |
| `release(query) -> count` | `cli/prune.ts` sweeps by *vitality threshold over the whole vault* — not query-addressed, returns no count | ❌ |
| `purge(query) -> count` | `removeNoteFromDB(db, title)` — removes by **exact title** from the SQLite index only | ❌ |

**The trap, stated plainly:** ForgetEval's **`decay` family does not mean time-based decay.** It means *"a fact that was explicitly `release`d must stay out of top-k"* — OTP consumed, TTL expired, intent cancelled. The case runs inside one session with no elapsed wall-clock time. **Ori's Ebbinghaus curve never fires.** Passive decay earns exactly zero points on the family whose name suggests it was designed for Ori.

Missing three of six methods, Ori lands where MemPalace landed: **0%, with the report line "no forgetting primitives."** Running ForgetEval today would actively damage Ori's positioning.

And even after implementing them, calibrate: the three deterministic systems (Mem0 68.3%, Lethe 63.4%, LangGraph 62.9%) **cluster in a 63–68% band with overlapping Wilson CIs — the paper's own conclusion is that "the bench reads the trade-off, not a winner."** The 1,000-case template suite is near-saturated (99.3–99.5%) and does not discriminate at all. Only `ForgetEval-Adv` separates systems, and the +28pt lift from the LLM hook "travels across backends... so it is the *placement* of the hook, not the storage engine, that earns it."

### Other forgetting-adjacent benchmarks, and why none of them rescue passive decay

- **MemoryAgentBench → FactConsolidation** is the "selective forgetting" competency, but it is really *conflict resolution*: facts are numbered, agents are told "newer facts have larger serial numbers," and they still fail. HippoRAG-v2 **54.0%**, BM25 **48.0%**, Mem0 **18.0%**, Zep/Graphiti **7.0%** on single-hop; **≤7% for every system** on multi-hop. The 2026 survey's verdict: *"No current system masters all four competencies; most fail conspicuously on selective forgetting."* **This is the widest open gap in the field** — and BM25 alone scores 48%, which means Ori's BM25 leg would land respectably with modest work. But it needs an LLM agent backbone.
- **Memora / FAMA** ([arXiv:2604.20006](https://arxiv.org/abs/2604.20006)) introduces *Forgetting-Aware Memory Accuracy*, which penalizes reliance on obsolete or invalidated memory. Conceptually the closest thing to what Ori's vitality model is *for*. Requires an agent and a judge; public harness not confirmed.
- **ForgetBench** ([arXiv:2607.26455](https://arxiv.org/html/2607.26455)) benchmarks *parametric* forgetting under continual knowledge editing — LLM weights, not external memory. **Not applicable to Ori.**
- **MemoryArena** (ICML 2026) — memory that drives action. Systems near-saturated on LoCoMo **collapse to 40–60%**. Requires an agent.

> **The strategic finding:** *No public benchmark rewards passive, time-based decay.* Every one of them tests explicit, query-addressable forgetting operations. Ori's ACT-R + Ebbinghaus machinery is therefore **currently unprovable** — which means that as a marketing claim it is also unfalsifiable, and a skeptical reader is right to discount it. The fix is not a better benchmark. The fix is to expose the decay model as three primitives the outside world can call and score.

---

## 5. Recommendation: run ONE benchmark first

### 🥇 **LongMemEval-S, retrieval track, session-level `recall_all@k` + `ndcg_any@k`**

**Estimated cost: $0.00. No API key. No LLM judge. No network.**

**Why this one:**

1. **It is the only credible run Ori can complete with its own zero-key stack intact.** The selling point and the measurement are the same artifact — Ori proves its thesis *by* the way it runs the benchmark, not just by the score.
2. **Two published comparison rows already exist on Ori's exact embedder** (MemPalace 96.6 R@5, Lethe 85.4/97.4/99.0 R@1/5/10). Ori does not have to be the only number on the page — the failure mode that sinks every vendor claim in §2.
3. **It is deterministic.** The single strongest attack on every number in this field — "the judge accepts 63% of wrong answers" — does not apply.
4. **The metric tests Ori's actual thesis.** R@1 and nDCG@5 measure ranking. BM25 + MiniLM + PageRank + Q-value reranking fused via score-weighted RRF is a ranking architecture. `bench/eval-rrf.mjs` already proves Ori's team knows how to read these metrics (the per-signal max-norm experiment that got reverted is exactly the right instinct).
5. **The harness already fits.** `bench/locomo-eval.ts` demonstrates the whole pattern: build a temp vault in `os.tmpdir()`, index, query, score. LongMemEval sessions map to notes the same way LoCoMo sessions already do. This is an afternoon, not a sprint.
6. **It covers knowledge-update and abstention**, the two abilities Zep correctly notes LoCoMo omits entirely.

**Protocol to publish (non-negotiable, this is what earns the credibility):**

```
Dataset:     longmemeval_s_cleaned.json (HF xiaowu0162/longmemeval-cleaned, 2025/09 cleanup)
Questions:   500, minus the 30 abstention instances for retrieval metrics (upstream convention)
Embedder:    Xenova/all-MiniLM-L6-v2, 384 dims
Granularity: session (report turn-level too — the harness supports both)
Metrics:     recall_all@5, ndcg_any@5, recall_all@10, ndcg_any@10
Scorer:      upstream src/evaluation/print_retrieval_metrics.py, unmodified
Runs:        ≥3 seeds, report mean ± sd
Raw output:  committed to bench/results/
API calls:   0
```

**Then, and only then, the optional $2 upgrade.** If a QA number is wanted for the headline, LongMemEval's QA track is *cheap*, because Ori retrieves top-k instead of stuffing 115k tokens:

| Path | Tokens | Est. cost |
|---|---|---|
| Reader: 500 q × ~4k retrieved ctx, gpt-4o-mini | ~2M in | ~$0.30 |
| Judge: 500 × ~500 tok, gpt-4o (official) | ~250k in / 5k out | ~$0.70 |
| **Total** | | **≈ $1–2 per full run** |
| *(Contrast: full-context baseline, 500 × 115k, gpt-4o)* | *57.5M in* | *~$144* |

The asymmetry is itself a publishable result: **Ori can be measured end-to-end for ~$1 because it retrieves instead of stuffing.** Mem0 makes a version of this argument (≈6,900 tokens/retrieval vs 25,000+ full-context); Ori can make it with a smaller number and a zero-cost ingestion path.

### 🥈 Second (only after the three inconsistent LoCoMo numbers are reconciled): **ForgetEval**

Not yet — it is a *build* task before it is a *bench* task. Sequence:

1. Implement `supersede(old_query, new_text)`, `release(query) -> count`, `purge(query) -> count` as first-class, query-addressed operations over the vault + index. Ori's frontmatter `status` field, `superseded_by`, and `removeNoteFromDB` are the raw material; `cli/prune.ts` already has the zone logic.
2. Write the ~130-line adapter against the `typing.Protocol` in `bench/forgeteval/adapter.py`.
3. Run `--suite template` (expect ~99%, near-saturated, low information) then `--suite adversarial` (expect the 63–68% band).
4. **Cost: $0.00 deterministic; $0.17 if the optional LLM mutation hook is wired.**

The genuine opportunity here is not the score. It is that **ForgetEval's `decay` family is currently the only one where a system could plausibly justify a *time-aware* implementation**, and the paper's own roadmap asks for exactly what Ori has: *"Adaptive consolidation policies — `consolidate()` uses one fixed decay law; we want per-domain policies."* Ori's `metabolic_rates` (`self: 0.1`, `notes: 1.0`, `ops: 3.0`) **is** a per-domain decay policy, already shipped. That is a real contribution to an open benchmark, submittable as a PR with cross-published results — far more valuable to a 324-star project than another self-reported percentage.

---

## 6. What Ori CANNOT meaningfully run, and why

| Benchmark | Blocker | Honest assessment |
|---|---|---|
| **LoCoMo J-score leaderboard** | Ori's harness computes token F1, not binary LLM-judge accuracy. Even matched, the target is corrupt: 6.4% bad keys, 93.57% ceiling, judge accepts 62.81% of wrong answers, an unreproducible field | **Do not chase.** Ori's README already refuses this comparison and is right. Publish LoCoMo as a *retrieval* result (R@k / MRR on evidence sessions) or not at all. Chasing 92.5 means competing on a metric that rewards vague answers |
| **BEAM-10M** | 100 convs × up to 10M tokens = ~1B tokens through local MiniLM. At CPU embedding throughput that is **hundreds of hours** on the target hardware (i7-11800H). Not a dollar problem — a wall-clock problem | **Cannot run.** BEAM-1M (~100M tokens, tens of hours local ingestion + ~$1–2 reader/judge on 2,000 questions) is *technically* reachable but is a weeks-long project for a number nobody will check |
| **LongMemEval-V2** | Judge defaults to **gpt-5.2 with medium reasoning**; reader is Qwen3.5-9B via vLLM (needs a GPU); `agentrunbook_c`/`codex` modules need a Codex v0.117.0 binary; haystacks up to **115M tokens** | **Cannot run on this hardware.** Genuinely painful, because its public leaderboard with submission packaging is *the most credible venue in the field*. Worth revisiting if GPU access appears — the `small` tier is the entry point |
| **MemoryArena** | Requires an **acting agent** in a Memory-Agent-Environment loop (web navigation, planning, sequential reasoning) | **Category mismatch.** Ori is a retrieval substrate + MCP server, not an agent. It could be the memory layer *inside* someone's MemoryArena entry, but cannot enter alone |
| **MemoryAgentBench (full)** | The agent under test is an LLM agent over chunked long corpora. Scoring is mostly key-free (`substring_exact_match`) but the *system* is not | **Partially runnable.** The `Accurate Retrieval` competency (`ruler_qa1`, `ruler_qa2`, `event_qa`) is substring-scored and could be run retrieval-only with disclosure. `Test-Time Learning` and `Long-Range Understanding` are unreachable without an agent. Note the calibration: **BM25 alone scores 48% on FactConsolidation single-hop vs Mem0's 18%** — an Ori retrieval-only run could look surprisingly strong here, but must be labelled a retrieval proxy, not a MemoryAgentBench score |
| **Memora / FAMA** | Needs an agent + judge; public harness not confirmed | **Watch, don't run.** FAMA is the metric most aligned with Ori's vitality thesis. Track it |
| **LoCoMo-Plus** | Inherits all 99 corrupt answer keys; improved judging was validated **only** on the new cognitive category; judge defaults to gpt-4o-mini | **Skip.** New category is a real contribution; the inherited infrastructure is the same broken instrument |

---

## 7. What this means for Ori, concretely

**The honest competitive read:** Ori's "local-first, zero-API-key" position is **not** unique — MemPalace (96.6% R@5, zero API calls) and Lethe (97.4% R@5, zero API calls, MIT, MCP server, SQLite, signed deletion receipts) both occupy it. Ori's "memory that forgets" position is **already claimed in print** by a system whose tagline is literally *"The first AI memory built to forget."* Neither of those is fatal — MemPalace's headline was independently deflated to "that's just ChromaDB's default embedder," and Lethe has 14 stars — but both mean Ori's *claims* now need numbers attached, because someone else's numbers are already on the page.

**Ori's genuinely unclaimed ground**, on the evidence gathered:

1. **Nobody in this landscape combines a wiki-link graph with PageRank/Louvain and learned reranking.** MemPalace is metadata-filtered vectors; Lethe is one `depth` scalar over RRF-blended vec+BM25; Mem0 is extraction + multi-signal fusion; Zep is a temporal KG. Ori's graph-structural prior (PPR, bridge protection, community) is architecturally distinct — and **R@1/nDCG@5 on LongMemEval-S is precisely the instrument that would show it**, because every competitor is saturated at R@5 and differentiated at R@1.
2. **`memory_sql` — a read-only SQL surface over six stable views — has no analogue anywhere in this research.** No benchmark scores it. That is a reason to *demo* it, not benchmark it.
3. **Per-domain decay policy already shipped** (`metabolic_rates`) is the exact thing ForgetEval's roadmap asks for and does not have.

**The one-paragraph plan:**

> Reconcile the three LoCoMo numbers down to the 1,536-question July 2026 run and rename `--llm-judge`. Then run **LongMemEval-S retrieval-only** with the cleaned dataset, publish `recall_all@{5,10}` and `ndcg_any@{5,10}` at session *and* turn level across ≥3 seeds, lead with **R@1** against MemPalace's and Lethe's published MiniLM rows, commit the raw JSON, and state the full protocol. **Zero dollars, zero API keys, one afternoon.** Next quarter, implement `supersede`/`release`/`purge`, write the 130-line ForgetEval adapter, run `--suite adversarial`, and submit it upstream as a PR — turning Ori's most-marketed and least-provable claim into a scored, third-party-published one for $0.17.

---

## Sources

**Benchmarks & harnesses**
- LoCoMo — [arXiv:2402.17753](https://arxiv.org/abs/2402.17753) · [ACL 2024 PDF](https://aclanthology.org/2024.acl-long.747.pdf) · [github.com/snap-research/locomo](https://github.com/snap-research/locomo)
- LongMemEval — [arXiv:2410.10813](https://arxiv.org/abs/2410.10813) (ICLR 2025) · [github.com/xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval) · [cleaned data](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)
- LongMemEval-V2 — [github.com/xiaowu0162/LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) · [leaderboard](https://xiaowu0162.github.io/longmemeval-v2/#leaderboard)
- MemoryAgentBench — [arXiv:2507.05257](https://arxiv.org/abs/2507.05257) (ICLR 2026) · [github.com/HUST-AI-HYZ/MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) · [HF data](https://huggingface.co/datasets/ai-hyz/MemoryAgentBench)
- BEAM — [arXiv:2510.27246](https://arxiv.org/abs/2510.27246) (ICLR 2026)
- MemoryArena — [arXiv:2602.16313](https://arxiv.org/abs/2602.16313) (ICML 2026) · [memoryarena.github.io](https://memoryarena.github.io/) · [github.com/ZexueHe/MemoryArena](https://github.com/ZexueHe/MemoryArena)
- ForgetEval — [arXiv:2606.15903](https://arxiv.org/abs/2606.15903) · [github.com/deeplethe/lethe](https://github.com/deeplethe/lethe) · [methodology](https://github.com/deeplethe/lethe/blob/main/docs/forgeteval.md)
- Memora / FAMA — [arXiv:2604.20006](https://arxiv.org/abs/2604.20006)
- LoCoMo-Plus — [arXiv:2602.10715](https://arxiv.org/abs/2602.10715)
- ForgetBench (parametric, N/A to Ori) — [arXiv:2607.26455](https://arxiv.org/html/2607.26455)

**Audits & critiques**
- LoCoMo audit (99 errors, judge leniency, ceiling analysis) — [github.com/dial481/locomo-audit](https://github.com/dial481/locomo-audit) · [write-up](https://dev.to/penfieldlabs/we-audited-locomo-64-of-the-answer-key-is-wrong-and-the-judge-accepts-up-to-63-of-intentionally-33lg)
- Zep on LoCoMo's flaws & Mem0's evaluation — [blog.getzep.com](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/)
- Zep scoring discrepancy — [getzep/zep-papers#5](https://github.com/getzep/zep-papers/issues/5) · EverMemOS repro failure — [EverMind-AI/EverMemOS#73](https://github.com/EverMind-AI/EverMemOS/issues/73) · [mem0ai/mem0#3944](https://github.com/mem0ai/mem0/issues/3944)
- MemPalace critical analysis (96.6% R@5 attributed to ChromaDB default embedder) — [arXiv:2604.21284](https://arxiv.org/abs/2604.21284)
- Label-error impact on benchmark rankings — [Northcutt et al., NeurIPS 2021, arXiv:2103.14749](https://arxiv.org/abs/2103.14749)

**Vendor claims (self-reported)**
- Mem0 research page (92.5 LoCoMo / 94.4 LongMemEval / 64.1 BEAM-1M / 48.6 BEAM-10M) — [mem0.ai/research](https://mem0.ai/research)
- Mem0 2026 benchmark guide (leaderboards + "why scores disagree") — [mem0.ai/blog/ai-memory-benchmarks-in-2026](https://mem0.ai/blog/ai-memory-benchmarks-in-2026)
- Mastra Observational Memory, 94.87% LongMemEval + full leaderboard + runner code — [mastra.ai/research/observational-memory](https://mastra.ai/research/observational-memory)
- Hindsight — [arXiv:2512.12818](https://arxiv.org/abs/2512.12818)
- Survey: Memory for Autonomous LLM Agents — [arXiv:2603.07670](https://arxiv.org/html/2603.07670v1)
- Deterministic conflict resolution / MAB FactConsolidation numbers — [arXiv:2606.01435](https://arxiv.org/html/2606.01435v1)
