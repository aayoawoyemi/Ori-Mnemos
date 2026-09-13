# Stage bandit starvation — diagnosis and fix

**Found 2026-09-12, fixed 2026-09-13.** Six of eight retrieval stages had been
switched off for six days, including the highest-rewarding stage in the system.
Ranked queries were running close to keyword-only and nothing reported it.

The bug is one line in the wrong place. The lesson generalises well past this
codebase: **a learning system that can turn a component off must be able to turn
it back on, and the mechanism that guarantees that must be checked before any
short-circuit that could preempt it.**

---

## Symptom

A live `ori_query_ranked` returned:

```
stages_skipped: [pagerank, warmth, cooccurrence_ppr,
                 gravity_dampening, hub_dampening, q_reranking]
```

Six of eight — exactly the six with `essential: false`. `ori_health` reported
`exposure/Q correlation = -1.000`, which read as a reward defect and was not.

`stage_q`, measured directly:

| stage | samples | total reward | reward/sample | last updated |
|---|---:|---:|---:|---|
| `rrf_fusion` | 261 | +32.33 | +0.12 | 2026-09-13 (live) |
| `bm25` | 74 | **−21.38** | **−0.29** | 2026-09-13 (live) |
| `pagerank` | 137 | **+68.01** | **+0.50** | 2026-09-07 (frozen) |
| `warmth` | 136 | +12.51 | +0.09 | 2026-09-07 (frozen) |
| `cooccurrence_ppr` | 91 | +7.32 | +0.08 | 2026-09-07 (frozen) |
| `gravity_dampening` | 57 | −0.01 | −0.00 | 2026-09-07 (frozen) |
| `hub_dampening` | 57 | −0.10 | −0.00 | 2026-09-07 (frozen) |
| `q_reranking` | 57 | −0.47 | −0.01 | 2026-09-07 (frozen) |

**PageRank carries the highest total reward of any stage and was switched off.
BM25 is the worst arm in the table and was still running** — because it is
marked `essential`, which exempts it from selection entirely.

Every frozen stage stopped on the same day. That is not a bandit expressing a
preference; that is a mechanism failure.

## Cause

`getStageDecision` in `src/core/stage-learner.ts` evaluated its guards in this
order:

1. `essential` → run
2. `sampleCount < MIN_SAMPLES` → run
3. **`elapsedMs > timeBudgetMs * softCutoff` → skip**
4. **`random() < epsilon` → run**
5. UCB thresholds → abstain / skip / run

Guard 3 preempts guard 4. The six non-essential stages sit after
`semantic_search` and `bm25` in the pipeline, so by the time they were evaluated
the elapsed time was routinely past the cutoff (`TIME_BUDGET_MS` 500 ×
`SOFT_CUTOFF` 0.8 = 400ms). They returned `skip` and never reached the epsilon
check.

That closes the loop permanently:

> a stage that never runs gains no sample → `a_matrix` never updates → the UCB
> never moves → the stage is never selected → it never runs

The epsilon escape hatch exists specifically to make "learn to skip" reversible.
It could not fire for the only stages that needed it. Guard 2 (`MIN_SAMPLES`)
did not help either: all six had 57–137 samples, well past the threshold, so
they were long out of the protected exploration phase.

## Fix

Move the epsilon check above the budget check, so the exploration floor holds
regardless of elapsed time.

Raise `EPSILON` from `0.02` to `0.05`. Recovery rate for a starved arm *is*
epsilon: at 2% a frozen stage waited ~50 queries per sample and needed
`MIN_SAMPLES` more to re-enter normal selection. Expected added cost is epsilon
times the summed non-essential stage cost (30+30+15+10+25+50 = 160ms), so ~8ms
per query against ~3ms before. 5% is the conventional floor for epsilon-greedy;
2% was quietly below it.

## Verification

Against the built `dist`, using a stage with 57 samples and negative reward at
450ms elapsed — exactly the frozen condition — over 20,000 trials:

```
past budget, epsilon fires  -> run
past budget, epsilon misses -> skip
recovery rate past budget   -> 4.97%   (0.00% before the fix)
```

755 tests pass.

`tests/core/blind-34.test.ts` needed one repair. Its budget case did not pin
`random`, while its two siblings did, so raising epsilon made it flaky at
exactly the new rate rather than failing outright. Pinned, and a regression test
added asserting that epsilon still runs a stage past the time budget.

**A test that exercises a stochastic path without pinning the source of
randomness is a latent flake.** Raising an exploration rate is how you find it.

## What this does not fix

`bm25` scores −0.29/sample **and** is known to be necessary — `stage-learner.ts`
records that the bandit previously learned to drop it, and that dropping it
removed recall for names, codes, and identifiers, citing Anthropic's
contextual-retrieval figures (top-20 failure 5.7% → 2.9%). Both facts hold at
once, which means **`measureCurrentQuality` cannot see exact-identifier recall.**

The negative number is a reward-function blind spot, not a BM25 implementation
problem. Replacing the hand-rolled BM25 with SQLite FTS5 would buy a real
tokenizer, C-speed matching, and code we do not maintain — all genuine — but it
would not move that number, because the number measures the wrong thing. That
work belongs in `measureCurrentQuality`.

Also unresolved: `note_q` holds 717 rows of which **707 have `update_count = 0`**.
`updateQ` deliberately refuses writes outside `session_batch` and
`explore_conclude`, to avoid a documented degenerate feedback loop. The gate is
correct; the consequence is that Q-values are near-uniform and `q_reranking` has
very little to rank on. That is a design question, not a bug.

## Related

- Index freshness: the index was five days old holding 1,423 of 1,524 notes, so
  101 notes were invisible to every ranked query. Rebuild was manual and
  therefore never run. Now handled at launch by `scripts/ori_refresh.py` in the
  aries-cli repo, which reads the index read-only and rebuilds when a note is
  missing or the build is over 12h old.
- `note_q` held one raw-title key alongside its slug counterpart, splitting one
  note's learning (`q=0.452`, 1 update) from its exposure (`q=0.5`, 2 exposures).
  Merged; zero malformed keys remain.
