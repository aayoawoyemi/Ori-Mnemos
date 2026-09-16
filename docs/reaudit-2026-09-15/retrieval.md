# Ori re-audit — slice `retrieval` (2026-09-15)

**Delivery note.** My toolset (read/grep/glob/web_search/hub/yield) has no `write` tool, so this report could not be written to `local://ori-reaudit-retrieval.md`; Main should persist this `report` field there.

**Method.** Read-only. Real DB opened with `{readonly:true}` and `.backup()`'d to `%TEMP%`; the derived index was built on that copy (and on a fresh DB) with `dist/core/indexstore.js` `syncIndex` (reads vault files only). `dist/` is current (has `dangling_link`, `BOOTSTRAP_HUB_POSTER_CAP`). Vault: 1,538 notes.

---

## 1. Findings

### F1 (S0) — The production DB has never executed the fix pass
`sqlite_master` of `C:/Users/aayoa/brain/.ori/embeddings.db` lists: boosts, co_occurrence, embeddings, memory_events, meta, note_q, q_history, q_history_genuine, retrieval_log, session_checkpoint, stage_log, stage_q. **No `note`, `edge`, `note_term`, `note_access`, `note_project`, `dangling_link`, `graph_metric`, `index_meta`.** File 222,146,560 B, mtime 2026-09-13T05:10Z, `-wal` 103,288,432 B (un-checkpointed). `meta.built_at` = 2026-09-13T04:06Z, `note_count` 1524. Every "real vault" number in tier 2 was produced against a copy (fix-list §Tier 2: "Every number … is from a copy"). Consequences: (a) all learning-table numbers below are pre-fix; (b) the first query on prod pays a full `syncIndex`: **5,677 ms on a fresh DB, 60,047 ms when run inside the 222 MB prod copy** (measured), inside `openSyncedIndex` (indexstore.ts:712-740), which sits on the query path before any signal runs. "A stale index never stops a session" holds only in the sense that the query eventually answers. No-op resync afterwards: 228 ms.

### F2 (S0) — CLI learning is a systematic *negative* signal; MCP credits twice
- search.ts:765-788: per invocation, `new SessionRewardAccumulator(activeSession)` → `logRetrieval` for each returned note → `concludeSession(mainDb)` immediately. No `logAdd`/`logUpdate` can have happened.
- reward.ts:155-186 ladder with 1-based ranks (search.ts:769): `bestRank <= 2` → `dead_end` −0.15/(rank+1) = −0.075 (rank 1), −0.05 (rank 2); every other returned note → `neutral` 0.
- qvalue.ts:361-364: `newQ = oldQ + 0.1*(reward − oldQ)`; reward 0 ⇒ Q ×0.9 per exposure. Q therefore decays monotonically with *how often the CLI returns a note* — the exact "punishing use" signature health.ts:104-110 warns about (prod already at −0.620 per fix-list). Rows also flip to `update_count>0`, so `getDecayedQ` (qvalue.ts:129) stops returning DEFAULT_Q and `phaseB` starts ranking on it.
- MCP: serve.ts:860-868 calls `runQueryRanked` (which runs the block above) **and** serve.ts:888 logs the same notes into the session accumulator flushed at serve.ts:300 → double credit. Exposure/retrieval_log: rerank.ts:128-140 (0-based rank, top-8) **and** search.ts:779-786 (1-based, all returned) → double count with mixed rank bases in one table. serve.ts:888 uses 0-based rank so `dead_end` covers top-3 there vs top-2 inline.
(SafetyAudit independently reported the double-credit/double-exposure; the reward-math consequence is this slice's.)

### F3 (S1) — Item 6 probe is title-only at the call site
`measureExactRecall` (stage-tracker.ts:239-256) tokenizes `title + text`. search.ts:380-385 passes `ScoredNote[]`; `ScoredNote` (ranking.ts:1-20) has no `text`. Tests (learning-signal-integrity.test.ts:301-315 `withTitles`) only ever exercise titles. Measured on the real vault: rare gate = max(8, ⌊1538·0.01⌋)=15; df(resume)=80, df(j)=10, df(plan)=178, df(b)=105 → rare terms for "Resume J" = ["j"]. BM25-from-store top-10 for "Resume J" (2.79 ms) all carry "j" **in the body only** (e.g. `ibk-college-resume-intake-round-1`, `resume-section-ordering-depends-on-audience`). `measureCurrentQuality` = **−0.182 with probe, +0.090 without, and −0.182 when description text is also supplied**. So: the metric now registers the miss (< 0) but cannot register a hit unless a *title* contains the identifier; since the −0.25 offset is the same before and after every stage, `computeStageReward` deltas are unchanged for this query. `termDocumentFrequency` (indexstore.ts:851-864) is a `GROUP BY` over 337,300 rows per query: 62 ms measured.

### F4 (S1) — Item 7 open: no confidence, and the explanatory data is discarded
grep `confidence|score_gap|noise` over search.ts/serve.ts/ranking.ts/index.ts → 0 hits. Output is `ScoredNote{title, score, signals{composite,keyword,graph,warmth,rrf_base,rrf}, spaces?, metadata?}` + `stages_skipped`. Thrown away: StageTracker before/after quality (only aggregated into stage_log), gravity/hub/resolution multipliers (dampening.ts returns new scores, no record), `_phaseB{simNorm,qNorm,ucb,lambda}` stripped at rerank.ts:143, exploration-injected notes carry `score: 0` (tracking.ts:98-103) indistinguishable from a real zero. A June-2026 telemetry experiment (`memory_events.memory_retrieval_trace`, 6 rows) carried `foundBy[]` + `explanation` per result — that code no longer exists in src.

### F5 (S1) — Gravity dampening is a no-op since RRF
dampening.ts:62 `if (note.score <= threshold) return note;` threshold 0.3. Post-fusion scores are `w·score/(k+rank+1)` with k=60 (fusion.ts:134) ≈ 0.02–0.03 (memory_events trace shows rrf 0.0249 at rank 0). prod stage_log: gravity_dampening run n=58 avg_reward −0.0001, avg 0.7 ms. It costs a stage decision and a LinUCB update for nothing.

### F6 (S1) — Co-occurrence weights are unbounded and the graph is 37% phantom
`runHomeostasis` (cooccurrence.ts:186-224) scales every edge of a node by `0.5/mean_w`, once for `note_a` and once for `note_b`, sequentially over nodes, with no clamp; `recomputeAllNPMI` bounds |npmi|≤1 but homeostasis runs after it at every MCP session end (serve.ts:279-283). prod: bootstrap rows avg `npmi_weight` **864.8**, retrieval rows **6,925.8** (1,838 NULL). ppr.ts:40-59 adds `0.3·w` per co-occurrence edge against 1.0 per wiki-link → co-occurrence dominates the combined PPR by 2–3 orders of magnitude. 88,056 / 239,993 rows (36.7%) reference a node matching no current note slug or title; 374 rows use title-shaped keys. New bootstrap with current code on the fresh index: 11,326 rows, 3,931 ms, 0 placeholder rows (vs 223,917 bootstrap rows in prod).

### F7 (S2) — Temporal space measures re-embed time
engine.ts:725-731: recency = exp(−days since `vectors.indexedAt`/30). `indexed_at` is `embeddings.indexed_at` (set on (re)embed). `ori index build --force` makes the whole vault "recent"; a note edited today but with an unchanged hash stays old.

### F8 (S2) — Item 10 residual divergence
Budget: fixed — `stage_time_budget_ms` (config.ts:190, default 500 ms) is applied via search.ts:351-354 on both transports because `useIntelligence = true` unconditionally (search.ts:326). Remaining transport differences: (a) `q_reranking` requires the raw `sessionId` param (search.ts ~:610 `useIntelligence && sessionId && …`), so CLI never reranks and MCP truncates to K2=8 (rerank.ts:30, 119); (b) `recordCoRetrieval` is called only from serve.ts:902/981/1093 — CLI queries never grow co_occurrence; (c) MCP passes `graphCache.get()` (graph.ts:16-21 → `buildGraph(notesDir)` with no index, invalidated only on add/archive/index-build) while CLI uses `buildGraph(paths.notes, indexDb)`.

### F9 (S2) — Bare catch on the cooc stage
search.ts:520-522 `catch { /* skip silently */ }` around cooccurrence_ppr violates the loud-degradation invariant and also swallows `trackStage` having been called without `trackStageAfter` (leaves an orphan snapshot in StageTracker).

### F10 (S2) — Exploration budget rounding
tracking.ts:88 `replaceCount = max(1, floor(len·budget))`: with `--limit 5` one of five results (20%) is random; with limit 10 it is 10%.

### F11 (S3) — Stale LinUCB context for bm25
stage_q.bm25: 80 samples, total −21.66. stage_log shows bm25 `run` avg 1,819 ms, `skip` 2,568 ms (pre-index vault rebuild); cost penalty 0.2·1.8 = −0.36/query explains most of the negative. With the store path at 2.79 ms the reward flips sign regardless of item 6; the A/b matrices still encode the slow era (`meta.bm25_arm_reset_2026_09_06` shows a prior reset).

---

## 2. Per-item status

| Item | Status | Evidence |
|---|---|---|
| 6 exact-identifier recall | **Partial** | Mechanism: stage-tracker.ts:188-290, wired search.ts:371-385. Title-only in practice (F3): "Resume J" −0.182 with or without descriptions; body hits invisible. |
| 7 confidence signal | **Open** | 0 grep hits; F4. |
| 8 exposure concentration | **Partial / unmeasured** | Code: `exposureDamping` (qvalue.ts:459-500), `applyColdStartFloor` (qvalue.ts:540-580, MCP-only via phaseB, ε=0.1, 1 of 8 slots), `injectExploration` rejection sampling (tracking.ts:82-170 — a perf change; same uniform distribution). prod: top-50 exposure share **46.5%** (was 47.2%), 939/1,538 notes never exposed, 695 never in retrieval_log. Nothing on the CLI path beyond the pre-existing 10% random injection. |
| 10 CLI↔MCP | **Partial** | Budget unified (config.ts:190; search.ts:326,351). Three divergences remain (F8). |
| 20 zero inbound | **Open** | 748/1,538 = 48.6% (fix-list 56%); 669 of those link *out* to something dangling; 40 fully isolated. `hygiene()` exists (indexstore.ts:878) but `ori health` still uses `findOrphans` over a fresh `buildGraph` (health.ts:32-34). |
| 21 dangling targets | **Open (measured)** | 1,966 rows, 110 distinct targets, 984 source notes. relevant-map 882 + related-note 853 = **88.3%** of rows. `dangling_link` populated, no consumer besides `hygiene()`. |
| 22 status separates nothing | **Open** | status: active 1,493; blank 35; proposed 3; superseded 2; open 2; planned 1; 22 notes with no frontmatter. |
| 23 access_count median 1 | **Open** | `note_access` empty in prod (table absent). vitality still reads fm_access_count/live counter (noteindex.ts:92-105). |
| 24 untagged project | **Open** | 949/1,538 = **61.7%** with no `note_project` row; ai-agents 447, meta 61, jojo-dynasty 38, courtshare 37, crypto 32, basketball-sim 30, career 25, ori 14. |
| 25 MAX_PATH | **Not in slice; unobserved** | `syncIndex` scanned 1,538 = reparsed 1,538 (no unreadable file on Node). |
| 27 promote.min_confidence | **Open / phantom** | grep `min_confidence` over src/scaffold/config → 0 hits (only docs + `.aries/tmp/issue34-comment.md`). The key does not exist in config; the item is mis-stated — either add+enforce or delete from the list. |
| 28 `--limit 5` → 10 | **Fixed [code-read]** | index.ts:93,117 → `runQueryRanked(…, parseInt(limit))`; search.ts:194 `resultLimit = limit ?? default`; trimmed at search.ts ~:655. Not executed against prod (would write learning tables). Caveat F10. |
| 29 vitality zones | **Open / unmeasured** | classifyZone thresholds (vitality.ts:160-164) unchanged; `prune.ts:106-125` counts zones. No zone distribution recomputed this pass. |
| 30 multi-root | **Open** | `note` has no `root` column (indexstore.ts:59-86); `getVaultPaths` single `notes` dir (vault.ts:85-98). |
| 31 #34 confirmation | **Open** | Not verifiable from repo. |

---

## 3. Pipeline trace (`runQueryRanked`, search.ts)

| # | Stage | Reads SQL | Computes JS | Kept in output | Discarded |
|---|---|---|---|---|---|
| 0 | openSyncedIndex (:262) | stat every file; note/edge/note_term upserts | parse changed notes | warning string | sync counts |
| 1 | graph/noteIndex/vitality (:266-286) | note, note_project, edge, dangling_link, note_access | vitality per note (ACT-R) | — | vitality map |
| 2 | cachedGraphMetrics (:270) | index_meta JSON keyed on `notes:edges:max(indexed_at)` | PageRank/Louvain/AP/betweenness on miss | — | all |
| 3 | loadVectors (:276) | full embeddings table (5 blobs/note) | copy to Float32Array | — | — |
| 4 | stage decisions (:340-357) | stage_q (A,b) | LinUCB UCB per stage; 8 features (stage-learner.ts:127-140) | `stages_skipped` | UCB values |
| 5 | composite (:388-397) | — | 6 cosine spaces × N notes, intent weights (intent.ts:75-80) | `spaces` (only if this note's first-seen signal is composite, fusion.ts:150) | per-space scores for non-composite hits |
| 6 | bm25 (:400-437) | note aggregate + note_term WHERE term IN (…) | BM25 k1/b, boosts at query time | `signals.keyword` | — |
| 7 | pagerank PPR (:440-460) | — | graphology PPR from `classified.entities` (often none) | `signals.graph` | — |
| 8 | warmth (:463-484) | — | spread over vectors+graph | `signals.warmth`, `metadata.warmthSource` | — |
| 9 | cooccurrence_ppr (:487-522) | **entire co_occurrence table** (239,993 rows in prod) | 20-iter PPR over wiki+cooc | merged into `graph` | source attribution overwritten |
| 10 | RRF (:534-546) | — | w·score/(60+rank+1), warmth excluded from `rrf_base` | `rrf`, `rrf_base` | — |
| 11 | gravity/hub/resolution (:548-583) | — | no-op / P90 degree penalty / ×1.25 | new `score` only | multipliers |
| 12 | cross-encoder (opt-in) | — | — | — | — |
| 13 | phaseB (MCP only) | note_q ×2 per candidate, retrieval_log COUNT DISTINCT | z-norm blend, UCB bonus, cold-start floor, K2=8 | — | `_phaseB` |
| 14 | archive filter, slice, injectExploration (:640-656) | — | uniform random pick | `metadata.wasExploration`, `score:0` | — |
| 15 | side effects (:659-789) | note_access, boosts, stage_q, stage_log, note_q, q_history, retrieval_log, ops/access.jsonl | reward ladder | `warnings` | quality before/after, stage timings |

---

## 4. FTS5

**Availability (measured, better-sqlite3 12.x bundled SQLite):** version **3.51.2**; compile options `ENABLE_FTS3, ENABLE_FTS3_PARENTHESIS, ENABLE_FTS4, ENABLE_FTS5, ENABLE_MATH_FUNCTIONS, ENABLE_RTREE, THREADSAFE=2`. `CREATE VIRTUAL TABLE t USING fts5(x)` + MATCH: works; `tokenize='porter unicode61'`: works; `tokenize='trigram'`: works. No new dependency needed.

**Gate (fix-list "Tier 1 item 6 gates any BM25/FTS5 decision"):** not met. The probe can only see title tokens (F3), so a `note_fts` vs `note_term` comparison on identifier recall would be blind to the very case that motivates it.

**What `note_fts` would look like** (augment, not replace — keep `note_term` for the probe and for config-time boosts):
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
  slug UNINDEXED, title, description, body,
  tokenize = 'unicode61 remove_diacritics 2 tokenchars ''-_''',
  contentless_delete = 1, content = ''
);
-- sync (indexstore.ts syncIndex, inside the same transaction as the note upsert):
DELETE FROM note_fts WHERE rowid = :note_id;
INSERT INTO note_fts(rowid, slug, title, description, body) VALUES (:note_id, :slug, :title, :description, :body);
-- query (bm25.ts, replacing searchBM25 when enabled):
SELECT slug, bm25(note_fts, 0, :title_boost, :description_boost, 1.0) AS score
FROM note_fts WHERE note_fts MATCH :q ORDER BY score LIMIT :k;
```
Caveats to resolve before it lands: (1) tokenizer parity — bm25.ts `tokenize` drops stopwords and single chars except identifier-like ones; unicode61 keeps everything, so df/idf and the probe vocabulary would differ; either register the same rules via `tokenchars`/stopword filtering at query time or accept the drift and re-measure; (2) body is not stored in the index today (only counts) — `note_fts` adds ~19 MB at 2k notes (fix-list §B); contentless tables cannot `highlight()`; (3) query escaping — FTS5 MATCH syntax must be quoted per token (`"resume" "j"`).

**Vector readiness:** 384-d Float32 blobs, brute-force cosine in JS over every row (loadVectors 14–25 ms at 1.5k). No `sqlite-vec`/vss (would be a new dep, barred). Linear scaling is acceptable to ~50k notes; the real gap is key space: `embeddings.title` vs `note.slug` (7 notes without vectors, 1 stale vector, `boosts` 327 rows for absent notes, `note_q` 145 orphan rows).

---

## 5. Vault hygiene (fresh derived index over 1,538 notes; 4,884 edges)

**Top dangling targets:** relevant-map 882; related-note 853; ori-map 20; meta-map 12; codemode-paradigm 12; 2026-02-17-obsidian-internals-deep-dive 11; codemode-primitive-set 9; codemode-sandbox-architecture 7; ori-cloud-product-strategy 6; identity 6; codemode-vs-competitive-landscape 6; codemode-build-path 6. 110 distinct targets; 74 are singletons.
**Inbound:** zero-inbound 748 (48.6%); zero-outbound 43; isolated 40. Top in-degree: index 1,016; ai agents map 462; jojo-dynasty-map 65; builder map 53; courtshare map 37.
**Project:** 949 (61.7%) with no project.
**Status:** active 1,493 / blank 35 / other 10. 22 notes without frontmatter.

**Proposed `ori doctor` / `ori health --fix`:**

| Action | Safe to automate? | Why |
|---|---|---|
| Report top-N dangling targets with inbound counts (from `dangling_link`) | Report | free now; `hygiene()` already exists |
| Strip `[[relevant-map]]` / `[[related-note]]` placeholder lines from notes whose *template* still carries them (match the exact template line) | `--fix`, opt-in, dry-run default | 1,735 of 1,966 dangling rows; exact-line match is reversible in git |
| Create stub notes for dangling targets with inbound ≥ 5 (`ori-map`, `meta-map`, codemode-*) | Report + suggested `ori add` | authoring decision |
| Exclude dangling targets from PageRank/PPR/co-occurrence bootstrap | Automate (code) | phantom mass; `loadLinkGraph` must not `link()` dangling rows into the ranking graph |
| Flag notes with zero inbound AND zero outbound (40) | Report | |
| Project backfill from folder/title patterns | Report only | 61.7% is a taxonomy problem, not a data fix |
| Purge `note_q`/`boosts`/`co_occurrence` rows for non-existent notes (145 / 327 / 88,056) | Automate on `ori index build` | derived data |
| WAL checkpoint on `ori index build` / `ori nap` | Automate | 103 MB WAL on prod |

---

## 6. Learning state

| Table | Written by | Read by ranking? | prod snapshot |
|---|---|---|---|
| note_q | updateQ (session_batch / explore_conclude), incrementExposure | phaseB (MCP only), applyColdStartFloor, exploration damping | 750 rows; 735 never updated; learned 15 rows all Q ∈ [0.4127, 0.455] (**below** init 0.5); 4,063 exposures |
| q_history | updateQ | **No** — health only (qvalue.ts:635-644) | 17 rows since 08-28 reset; +0.109 total; `q_history_genuine` archive 896 |
| retrieval_log | phaseB + search.ts inline | Yes: `getTotalQueryCount` → UCB logT; `recomputeAllNPMI` per-note counts | 12,817 rows, 256 sessions, 1,325 queries, 0 CLI rows, rank 0–7, 755 dup (session,query,note) |
| stage_q | saveStage (both paths now) | Yes: `getStageDecision` | 8 rows; pagerank +68.0/137, bm25 −21.66/80, q_reranking −0.47/58 |
| stage_log | logStageDecision | **No** (grep `FROM stage_log` → 0 hits in src) | 1,862 rows, 44 sessions; bm25 run avg 1,819 ms |
| co_occurrence | bootstrap; recordCoRetrieval (MCP only); NPMI/homeostasis (MCP session end) | Yes: ppr.ts | 239,993 rows; weights avg 865/6,926 (F6); 36.7% phantom |
| session_checkpoint | serve.ts timer | consumed at next serve start | 0 rows |
| boosts | applyActivationBoosts | Yes: vitality (loadBoosts) | 1,816 rows, 327 orphan |
| ops/access.jsonl | logAccess | **No** (no reader in src; propensity written as 0) | — |
| memory_events | none in src | No | 6 rows (June telemetry experiment; orphan table) |

**Write-only / dead:** stage_log, q_history (diagnostic only), ops/access.jsonl, `extractCoOccurrencePairs` (defined cooccurrence.ts:159, no caller), `memory_events`.

---

## 7. Left from the fix list in this slice
Open: 7, 20, 21, 22, 23, 24, 27 (phantom), 29, 30, 31. Partial: 6, 8, 10. Fixed: 28 (code-read). New in this pass: F1, F2, F5, F6, F7, F9.

---

## 8. Recommendations (concrete)
1. **F2 first** — search.ts:765-788: remove the inline `SessionRewardAccumulator`; the CLI has no session outcome to credit. Keep `logRetrieval`+`incrementExposure` only when `!sessionId` (phaseB already does both on MCP), and log 0-based rank everywhere (or 1-based everywhere and fix reward.ts:172 `bestRank <= 2` accordingly). Add a regression test: a query with no adds must not change any `note_q.q_value`.
2. **F3** — replace `measureExactRecall`'s text tokenization with an index lookup: `LexicalProbe.contains(slug, term)` backed by `SELECT 1 FROM note_term WHERE note_id = ? AND term = ?` (or one prepared `IN` query over the top-10). Cache `termDocumentFrequency` per index fingerprint instead of a 62 ms GROUP BY per query. Then re-run the 09-06 bm25 arm reset (`meta.bm25_arm_reset_*`).
3. **F4** — add to `SearchResult.data`: `confidence: { top_score, gap_to_second, rare_terms_found: n/m, sources: number of signals agreeing on top-1 }` and a per-result `explain[]` of `{stage, rank, score}` (the data already exists transiently); drop `score: 0` for exploration picks in favour of `score: null`.
4. **F5** — dampening.ts:62: make the threshold a percentile of the current list (or remove gravity; measured reward ≈ 0).
5. **F6** — cooccurrence.ts `runHomeostasis`: clamp `scale` to [0.5, 2] and `npmi_weight` to [0, 1], or run it once per edge; purge phantom nodes on bootstrap; ppr.ts: read only edges incident to the seed frontier (`WHERE note_a IN (…) OR note_b IN (…)`) rather than the whole table.
6. **F8** — gate q_reranking on `activeSession`, call `recordCoRetrieval` from search.ts, and have serve.ts pass no `linkGraph` so `buildGraph(notes, indexDb)` is used.
7. **F1** — `ori index build` should checkpoint the WAL and run the derived-index build eagerly so the first query does not carry 5–60 s; document that the 09-15 fixes are not live until it runs.
8. **F7** — store `mtime_ms`/`created` from `note` and use that for the temporal space; `indexed_at` is a cache timestamp.
9. Item 27 — delete from the fix list or add the key; the config key does not exist.
10. Hygiene — wire `hygiene()` into `ori health` (replace `findOrphans`/`findDanglingLinks` scans) and add the `--fix` actions above.

## 9. Open questions
- Was the 60 s vs 5.7 s `syncIndex` gap due to the 222 MB prod copy's page cache / WAL, or to Windows AV? Either way prod will see the slow one first.
- Which note is the intended "Resume J" target? None of the 10 notes containing term `j` has it in the title; if the target is body-only, the current probe can never score a hit for this canonical example.
- Is `memory_events` (June telemetry) meant to return? Its `foundBy`/`explanation` payload is the shape item 7 needs.
- Should the CLI ever credit Q at all without an outcome signal (a follow-up `ori add` in the same shell session is unobservable)? If not, CLI should be exposure-only by design and the docs should say so.