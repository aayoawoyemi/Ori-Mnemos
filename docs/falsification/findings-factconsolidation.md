# MemoryAgentBench / FactConsolidation — what running it actually showed

Date: 2026-09-20
Harness: `bench/factconsolidation.mjs`, `bench/factconsolidation-why.mjs`,
`bench/factconsolidation-supersede.mjs`
Data: `ai-hyz/MemoryAgentBench`, split `Conflict_Resolution`, 8 rows × 100 questions

## 0. A correction I owe, first

I said MemoryAgentBench was zero-key. **That was wrong.** All 18 agent configs
under `configs/agent_conf/RAG_Agents/` set `model: gpt-4o-mini`. The *metric*
is keyless; the *pipeline* is not. Their published leaderboard is memory
system + gpt-4o-mini reader, end to end.

There is no `OPENAI_API_KEY` on this machine, so everything below is the
**memory half alone** and belongs in no column next to their table. Cost to
run the published protocol properly, measured rather than guessed: 800
questions, ~1K tokens each, **about $0.15 and 30–45 minutes.** The blocker is
the key, not the money.

## 1. The benchmark is adversarial to embeddings by construction

This is the finding that matters, and it is a property of the dataset, not of
Ori.

FactConsolidation builds conflicts by injecting **counterfactuals**. The
context is a numbered fact list; a later line overwrites an earlier one, and
the gold answer is always the later value (validated: 70 : 1 on sh_6k):

```
#271  The author of The Marriage of Figaro is Pierre Beaumarchais.   stale — and TRUE
#398  The author of The Marriage of Figaro is Thomas Kyd.            live  — and FALSE
```

Beaumarchais wrote Figaro. Kyd did not. Likewise "rugby union was created in
the country of India", "Bengaluru is located in the continent of Oceania",
"The director of British Broadcasting Corporation is Narendra Modi".

So the superseded fact is the semantically plausible one, and **every
embedding model scores it higher.** Measured on 97 queries where both versions
were retrieved (`factconsolidation-why.mjs`):

```
scores exactly tied :  0
stale scored higher : 67
live  scored higher : 30
mean(stale − live)  : +3.1e-4
```

No tie-break artifact — a genuine, consistent scoring preference for the dead
fact. **No amount of embedding quality wins this benchmark.** Recency has to
be represented explicitly, outside the similarity function. That is the whole
point of the task and it is worth saying out loud, because a system that
reports only hit@k will look perfect while getting the answer wrong.

## 2. Retrieval-only results

k = 10, 100 questions per row, no reader.

All 8 rows, 455 to 18,332 facts — a 40x range.

```
variant     facts  sup%  hit@10  head@1  stale@1 (chance)  excess   s/query
sh_6k         455   33%   100.0    47.0    50.0    33.2     +16.8     0.31
sh_32k       2310   34%   100.0    52.0    46.0    34.4     +11.6     1.28
sh_64k       4580   35%    99.0    48.0    51.0    35.3     +15.7     1.88
sh_262k     18332   39%    99.0    38.0    56.0    38.6     +17.4    10.42
mh_6k         455   33%    26.0     0.0    41.0    33.2      +7.8     0.37
mh_32k       2310   34%    15.0     0.0    40.0    34.4      +5.6     1.32
mh_64k       4580   35%    12.0     1.0    50.0    35.3     +14.7     1.83
mh_262k     18332   39%    11.0     0.0    51.0    38.6     +12.4     7.83
```

- **Recall is scale-invariant.** hit@10 holds at 99-100% on single-hop
  across 40x the corpus. Retrieval is not where this breaks.
- **head@1 decays with scale**, 47 -> 52 -> 48 -> 38. Ranking precision at
  the head is what erodes, not membership in the top 10.
- **The stale bias is structural, not a small-corpus artifact.** The excess
  over chance is 16.8, 11.6, 15.7, 17.4 — flat at roughly +15 points across
  the whole range, exactly as the counterfactual mechanism predicts.
- **multi-hop retrieval-only is useless** (26 -> 11%) and degrades with
  distractors. Expected: "the country of citizenship of the spouse of the
  author of Our Mutual Friend" is not one hop. mh needs the reader.

- **hit@10 = 100% on single-hop** at both sizes. The gold fact is always
  retrieved. Recall is not the problem.
- **head@1 ≈ 47–52%.** Only about half the time is it ranked first.
- **stale@1 = 50% against a 33.2% chance floor.** z = 3.57, p ≈ 0.0002.
  Ori's top result is a superseded fact *more often than random*.
- head@1 + stale@1 ≈ 97%: rank 1 is nearly always one of the two versions.
  It is a coin flip, biased toward the dead one.
- **multi-hop retrieval-only is near-useless** (15–26%) and that is expected,
  not a defect: "the country of citizenship of the spouse of the author of
  Our Mutual Friend" cannot be answered by one hop. mh needs the reader.

### stale@k at k=10 is vacuous — report the floor

A third of this corpus is superseded, so a random retriever trips stale@10
with probability 1 − (1 − 0.33)^10 ≈ 98%. The measured 98–100% is
**indistinguishable from chance** and means nothing. Only `stale@1` (floor
33%) discriminates. Same lesson as the ForgetEval vacuous floor: publish the
null baseline beside the metric or the metric is decoration.

## 2b. Latency: the 10.4 s/query headline was an averaging artifact

`bench/recall-latency.mjs`. The query column above is total wall time over
100 questions divided by 100, and the first `recall()` builds the index, so
that number is an upper bound. Measured per query instead:

```
facts   build+q1   steady-state median   ratio
  455     10.76s          0.13s          84.7x
 2310     45.65s          0.51s          89.5x
 4580     90.27s          0.98s          92.4x
```

Reproduced on a second independent run (43.98s/0.50s, 92.08s/1.07s).

Steady state fits `t(n) = 0.034s + 0.2274ms x n`, so **0.98 s/query at 4,580
notes** and a projected **4.2 s/query at 18,332**. The real vault, at 1,550
notes, sits near 0.38 s.

The build, not the query, is the scaling limit:

```
implied one-time build at 18,332 notes:  622s
linear extrapolation from small sizes:   375s
                                         1.7x SUPERLINEAR
```

This is the quantitative version of the earlier `.ori/` finding. The README
once described it as a disposable cache. At 18k notes, deleting it costs an
11-minute rebuild — on top of the 56,850 learned rows already shown to be
unrecoverable from the notes alone.

## 3. Can Ori detect the conflicts itself?

`matchForForget` sees only the incoming fact — no oracle. Oracle stems are
used solely to score what it found. One ingestion pass, thresholds applied
offline.

```
threshold  detected  missed  spurious  precision  recall     F1
     0.35       137      14       245      35.9%   90.7%   51.4%
     0.45       137      14       182      42.9%   90.7%   58.3%
     0.55       135      16       105      56.3%   89.4%   69.1%
     0.65       126      25        48      72.4%   83.4%   77.5%    <- best
     0.75        90      61        10      90.0%   59.6%   71.7%
     0.85        38     113         5      88.4%   25.2%   39.2%
     0.95         0     151         0       0.0%    0.0%    0.0%
```

151 real conflicts among 455 facts. **Recall 90.7% is genuinely good** — the
matcher finds nearly every real conflict. Precision is the problem.

### Diagnosed failure mode: no subject agreement

```
Ferdinand Marcos is married to Imelda Marcos.
  -> victoria-beckham-is-married-to-david-beckham
```

Same relation template, different subject. `matchForForget` scores
relation-template similarity and **never requires the subject to agree**, so
raising the threshold trades recall away without addressing the cause. At the
default it claimed a conflict for 382 of 455 facts.

That independently corroborates today's blast-radius work from an outside
corpus: the matcher over-matches by roughly 2.7×, which is the same shape as
`release("Ori positioning strategy")` addressing 159 notes in the real vault.
The dry-run default and `maxForget` guard are not paranoia.

## 4. The 17th instance — and I wrote this one

First run of `factconsolidation-supersede.mjs` reported **0/151, precision 0,
recall 0** and it looked like a real capability gap. It was not.

```js
if (m.length && (m[0].score ?? 0) >= THRESHOLD)   // ForgetMatch has no `score`
```

`ForgetMatch` is `{ slug, file, text, anchor, similarity }`. Reading `.score`
yielded `undefined`, `?? 0` made it 0, and 0 < 0.35 every single time. Silent,
plausible zero.

This is exactly the `measureExactRecall` bug from earlier in this project —
reading `c.text`, a field `ScoredNote` never sets — and I reproduced it myself
in a `.mjs` file where TypeScript cannot see the field name. A `catch {}` on
the same call was also swallowing errors; it now rethrows anything that is not
an expected empty-index condition.

**Benchmark harnesses written in untyped `.mjs` against typed library
surfaces are where this defect breeds.** Every zero a harness reports should
be probed against a two-note fixture before it is believed.

## 5. What is worth publishing

1. **FactConsolidation is adversarial to semantic similarity by
   construction.** Superseded facts are true, updates are counterfactual, so
   embeddings systematically prefer the dead one, 67:30. Any pure-RAG memory
   system fails this benchmark for reasons unrelated to retrieval quality.
2. **stale@k needs its chance floor published.** At k=10 with a third of the
   corpus superseded the metric is ~98% for everybody, including a random
   retriever.
3. **Ori's conflict detection: recall 90.7%, best F1 77.5% at 0.65**, with a
   named and fixable precision failure (no subject agreement).

## 6. Not done

- End-to-end with the gpt-4o-mini reader — needs a key, ~$0.15.
- 64k and 262k rows.
- The subject-agreement fix in `matchForForget`, then re-run this curve.
