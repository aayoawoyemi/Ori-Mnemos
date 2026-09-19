"""Score Ori's LongMemEval rankings with the benchmark's own metric code.

The metrics are NOT reimplemented here. This imports evaluate_retrieval from
the official LongMemEval checkout and calls it, then writes the JSONL that
src/evaluation/print_retrieval_metrics.py expects. Reimplementing recall_all@k
would produce a number that looks comparable to the published tables and is
not, which is the single easiest way to publish a wrong benchmark result.

Usage:
  python bench/longmemeval-score.py <rankings.json> <path/to/LongMemEval> [out.jsonl]
"""
import json
import sys
import os

if len(sys.argv) < 3:
    print(__doc__)
    sys.exit(1)

rankings_path, lme_root = sys.argv[1], sys.argv[2]
out_path = sys.argv[3] if len(sys.argv) > 3 else rankings_path.replace(".json", ".jsonl")

sys.path.insert(0, os.path.join(lme_root, "src", "retrieval"))
from eval_utils import evaluate_retrieval  # noqa: E402  official metric

with open(rankings_path, encoding="utf-8") as fh:
    entries = json.load(fh)

KS = [1, 3, 5, 10, 30, 50]
written = 0
with open(out_path, "w", encoding="utf-8") as out:
    for e in entries:
        corpus_ids = e["corpus_ids"]
        rankings = e["rankings"]
        correct = e["correct_docs"]

        metrics = {}
        for k in KS:
            recall_any, recall_all, ndcg_any = evaluate_retrieval(
                rankings, correct, corpus_ids, k=k
            )
            metrics[f"recall_any@{k}"] = recall_any
            metrics[f"recall_all@{k}"] = recall_all
            metrics[f"ndcg_any@{k}"] = ndcg_any

        out.write(json.dumps({
            "question_id": e["question_id"],
            "question_type": e["question_type"],
            # Session granularity: one note per session, so the ids Ori ranks
            # are already session ids and no turn->session collapse is needed.
            "retrieval_results": {"metrics": {"session": metrics}},
        }) + "\n")
        written += 1

print(f"wrote {written} rows -> {out_path}")
