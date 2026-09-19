# Benchmarks

## Datasets

- **HotpotQA** — Multi-hop question answering. Each question requires finding and combining information from exactly 2 documents out of 10 (2 gold, 8 distractors). Tests graph-relative retrieval.
- **LoCoMo** — Long-context conversational memory. 10 conversations, 695 questions across single-hop, multi-hop, and temporal categories.

## Evaluation Scripts

### HotpotQA (Ori flat vs Ori explore vs Mem0)

```bash
# Ori (flat + explore, head-to-head)
npx tsx bench/hotpotqa-eval.ts --n 50 --json

# Mem0 comparison (requires pip install mem0ai)
python bench/mem0-hotpotqa.py
```

### LoCoMo

```bash
# Full benchmark (695 questions, all categories)
npx tsx bench/locomo-eval.ts --json

# Single conversation
npx tsx bench/locomo-eval.ts --sample 0

# Filter by question type (1=multi-hop, 2=single-hop, 3=temporal)
npx tsx bench/locomo-eval.ts --categories 1,2,3
```

## Latest Results

### HotpotQA (50 questions, same dataset, same scoring)

| System | R@5 | F1 | LLM-F1 | Speed | API for ingestion |
|---|---|---|---|---|---|
| Ori flat | 87.0% | 50.6% | 40.3% | 142s | None (local) |
| Ori explore | 90.0% | 52.3% | 41.0% | 142s | None (local) |
| Mem0 | 29.0% | 25.7% | 18.8% | 1347s | ~500 LLM calls |

### LoCoMo (1,536 questions)

| Category | Count | Recall | Answer F1 |
|---|---|---|---|
| open-domain | 841 | 94.3% | 92.9% |
| single-hop | 321 | 86.3% | 75.8% |
| multi-hop | 282 | 52.8% | 67.0% |
| temporal | 92 | 56.5% | 47.8% |
| **Overall** | **1,536** | **82.7%** | **81.9%** |

Run `bench/results/locomo-eval-2026-09-19T22-37-31-698Z.json`; MRR 0.729,
precision 0.201 at top-5, 48 s.

This table previously reported 695 questions at 44.7% overall recall. Those
figures reproduce nothing in the current harness, and the 695-question subset
excluded the open-domain category — 841 of the 1,536 questions. The 2026-09-19
run reproduces the 2026-07-22 run to three decimals.

## Data

- `data/hotpotqa-dev.json` — HotpotQA dev set (200 questions)
- `data/locomo10.json` — LoCoMo 10-conversation dataset

## Results

JSON output from each benchmark run stored in `results/` with timestamps.


## eval-rrf.mjs — grep-grounded retrieval eval (2026-09-06)

    node bench/eval-rrf.mjs <vaultRoot> <gold.json>          # default rrf_k
    ORI_RRF_K=10 node bench/eval-rrf.mjs <vaultRoot> <gold.json>

`gold.json` maps query -> [note titles that literally contain the needle] (build it
with grep, not by hand). Reports hit@1 / hit@5 / MRR over `runQueryRanked`.
Two gold sets ship in bench/data: `gold-identifiers.json` (24 proper nouns / codes)
and `gold-semantic.json` (8 conceptual queries, loose needles).

Results 2026-09-06 on the brain vault (1423 notes), after the BM25 restoration:

| fusion             | rrf_k | identifiers hit@1 | semantic hit@1 |
|--------------------|-------|-------------------|----------------|
| score-weighted RRF | 60    | 23/24             | 7/8            |
| score-weighted RRF | 10    | 23/24             | —              |
| score-weighted RRF | 3     | 22/24             | —              |
| + per-signal max-norm | 10 | **16/24**         | —              |

Per-signal normalization was tried and reverted: BM25's raw scale (2-12 vs cosine
0.3-0.6) is what makes exact matches win, and `signal_weights` were tuned while
BM25 was disabled. Don't normalize without retuning weights against both gold sets.
