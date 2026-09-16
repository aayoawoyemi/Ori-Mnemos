# Ori re-audit 2026-09-15 — slice `surface`

(Author: SurfaceAudit. Read-only. Numbers from the repo working tree and from a temp copy of `C:/Users/aayoa/brain/.ori/embeddings.db` + `-wal` + `-shm`, opened with `{readonly:true}`; the copy was deleted afterwards. NOTE: this agent has no `write` tool, so `local://ori-reaudit-surface.md` could not be created — this `report` field is the deliverable.)

---

## 1. Inventory

### 1a. MCP tools — `src/cli/serve.ts` (21 registered; README:74/208/251 and adapters/hermes/SKILL.md:~50 say **16**)

| # | tool | line | inputs (zod) | output | core call |
|---|---|---|---|---|---|
| 1 | `ori_orient` | 443 | `brief?` | `{daily, reminders, vaultStatus, goals, [identity, methodology, firstRun], timestamp, update_notice?}` | `runStatus` + file reads |
| 2 | `ori_wake` | 671 | `budget?` | `{success, lines[], sections}` | `runWake` |
| 3 | `ori_update_decision` | 679 | `version, decision` | `{success, version, decision, note}` | `writeUpdateDecision` |
| 4 | `ori_update` | 695 | `file∈{identity,goals,methodology,daily,reminders}, content` | `{success, file, backed_up, updated}` | fs write + `.history/` backup |
| 5 | `ori_status` | 735 | — | `StatusResult` | `runStatus` |
| 6 | `ori_query` | 741 | `kind, note?` | `{orphans}|{dangling}|{backlinks}|{notes}` | `runQuery{Orphans,Dangling,Backlinks,CrossProject}` |
| 7 | `ori_add` | 767 | `title, type?, content?` | `AddResult` | `runAdd` (+ `rewardAccumulator.logAdd`) |
| 8 | `ori_validate` | 798 | `path` | `{success, errors, warnings}` | `runValidate` |
| 9 | `ori_health` | 811 | — | `HealthResult` | `runHealth` |
| 10 | `ori_promote` | 817 | `path, type?, description?, links?, project?, dry_run?` | `PromoteResult` | `runPromote` |
| 11 | `ori_query_ranked` | 849 | `query, limit?, include_archived?` | `SearchResult{query,intent,results:ScoredNote[],count,warmth?,stages_skipped?}` | `runQueryRanked` w/ `intelligenceDb, sessionId, sessionStageTracker` |
| 12 | `ori_explore` | 934 | `query, limit?, depth?, include_content?, include_archived?, recursive?` | explore result | `runExplore` |
| 13 | `ori_explore_start` | 1014 | `query, budget?` | `NavigatedResult` | `runExploreStart` (module `sessions` Map) |
| 14 | `ori_explore_expand` | 1032 | `exploration_id, sub_question?|branch?|neighbors?, extend_budget?` | `NavigatedResult` | `runExploreExpand`/`runExploreExtend` |
| 15 | `ori_explore_conclude` | 1066 | `exploration_id, answered, used_notes?` | `ConcludeSummary` | `runExploreConclude` **+ `updateQ`/`recordCoRetrieval` (1077-1097)** |
| 16 | `ori_warmth` | 1102 | `context, limit?` | `{context, results:WarmthSignal[], count}` | `runQueryWarmth` |
| 17 | `ori_query_similar` | 1121 | `query, limit?, include_archived?` | `SearchResult` | `runQuerySimilar` |
| 18 | `ori_query_important` | 1142 | `limit?` | `{results}` | `runQueryImportant` |
| 19 | `ori_query_fading` | 1159 | `threshold?, limit?` | `{results}` | `runQueryFading` |
| 20 | `ori_prune` | 1178 | `apply?` | `PruneResult` | `runPrune` |
| 21 | `ori_index_build` | 1198 | `force?` | `IndexBuildResult` | `runIndexBuild` |

Resources (serve.ts:400-438): `ori://identity|goals|methodology|daily|reminders` — markdown file reads only. No prompts registered (`grep server\.prompt\(` → 0).

### 1b. CLI commands — `src/index.ts` (18)

| command | line | flags | core call | MCP twin |
|---|---|---|---|---|
| `init [dir]` | 57 | `--json` | `runInitInteractive` | none (server auto-inits global vault, serve.ts:161-168) |
| `wake` | 67 | `--budget` | `runWake` | `ori_wake` |
| `status` | 75 | — | `runStatus` | `ori_status` |
| `health` | 82 | — | `runHealth` | `ori_health` |
| `query <kind> [note]` | 89 | `--limit --threshold`; kinds orphans/dangling/backlinks/cross-project/ranked/similar/important/fading/**warmth-audit** | `runQuery*`, `runQueryRanked`, `runQuerySimilar`, `runQueryWarmthAudit` | split across `ori_query`, `ori_query_ranked`, `ori_query_similar`, `ori_query_important`, `ori_query_fading`; **warmth-audit has no MCP twin** |
| `validate <note>` | 140 | — | `runValidate` | `ori_validate` |
| `add <title>` | 148 | `-t -c -f --content-stdin` | `runAdd` | `ori_add` |
| `promote [note]` | 170 | `--all --dry-run --no-auto -t -d -l -p` | `runPromote` | `ori_promote` (**no `--all`, no `--no-auto`**) |
| `archive` | 208 | `--dry-run` | `runArchive` | **none** (`ori_prune apply=true` archives via a different path) |
| `bridge <target>` | 221 | `--global --scope --activation --vault --uninstall --json` | `runBridge*` | none (install-time) |
| `serve --mcp` | 385 | `--vault` | `runServeMcp` | — |
| `index <build|status>` | 396 | `--force` | `runIndexBuild`/`runIndexStatus` | `ori_index_build`; **`index status` has no MCP twin** |
| `graph <metrics|communities>` | 414 | — | `runGraphMetrics`/`runGraphCommunities` | **none** |
| `prune` | 432 | `--apply --verbose` | `runPrune` | `ori_prune` (no `verbose`) |
| `explore <query>` | 445 | `--limit --depth --no-recursive --include-archived` | `runExplore` | `ori_explore` (MCP additionally has `include_content`) |
| `explore-start` | 464 | `--budget --json` | `runExploreStartCli` (file-backed) | `ori_explore_start` (memory-backed) |
| `explore-expand` | 480 | `--ask --branch --neighbors --extend --json` | `runExploreExpandCli` | `ori_explore_expand` |
| `explore-conclude` | 508 | `--answered --used --json` | `runExploreConcludeCli` | `ori_explore_conclude` |

MCP-only: `ori_orient`, `ori_update`, `ori_update_decision`, `ori_warmth` (CLI has only `warmth-audit`, which reads a JSONL log, search.ts:900-925).

---

## 2. Findings

**F1 (High) — q_reranking still never runs from the CLI.** `search.ts:610-615` gates Phase-B on `useIntelligence && sessionId && …`. `sessionId` is the *parameter*, which only serve.ts passes; the CLI mints `activeSession` (search.ts:314-315) but the gate reads the wrong variable. So the CLI logs `stage_log` rows for `q_reranking` (decision recorded at 344-352) whose reward is null, and the same query still ranks differently by transport — fix-list item 10 is half-closed. Real DB: `stage_log` has 208 `q_reranking:skip` rows, 0 `run`.

**F2 (High) — CLI `explore-conclude` produces no learning signal.** `explore.ts:638-651` calls `concludeExploration` + `deleteSessionState` and returns. The MCP twin (serve.ts:1077-1097) is the *only* sanctioned `explore_conclude` source for `updateQ`. Same shape as item 9: the capability exists and one transport uses it.

**F3 (Med) — Explore sessions are not portable across transports.** MCP: module-level `sessions` Map (explore.ts:662); CLI: `.ori/explore-sessions/<id>.json` (explore.ts:565). An `exploration_id` from `ori_explore_start` returns `unknown exploration_id` from `ori explore-expand` and vice versa. Also the MCP Map dies with the process while the CLI files never expire (no cleanup on failure paths).

**F4 (Med) — Seven read commands still bypass the derived index.** `runQuerySimilar` (search.ts:942-951) calls `buildGraph(paths.notes)`, `buildNoteIndex(paths.notes, allTitles)`, `computeGraphMetrics`, `computeAllVitality` with no `indexDb`; `query.ts` (`runQueryOrphans` 32, `Dangling` 47, `Backlinks` 63, `Important` 118, `Fading` 137), `health.ts:32`, `status.ts` likewise. On MCP the `graphCache` masks the graph cost; on the CLI every one of these is the pre-tier-2 full scan. `ori health` is what `adapters/claude-code/hooks/orient.mjs:27` spawns on **every SessionStart** with an 8 s timeout — at 1,538 notes that is the slowest path left on the surface.

**F5 (Med) — Nothing exposes retrieval history or the index; three side-logs hold more.** `grep` for `--sql|dump|setAuthorizer|interrupt|readonly` over `src/` matched only `--json` flags in `index.ts:59,230,467,486,513` and the `rows()` seam in `indexstore.ts:230`. Meanwhile retrieval evidence is written to: `retrieval_log` (12,817 rows / 256 sessions / 1,149 distinct notes on the real DB), `stage_log` (1,862), `note_access` (once the index exists), `boosts`, plus `ops/access.jsonl` (tracking.ts:47-55), `.ori/explore-audit.jsonl` (explore-audit.ts:4), `.ori/warmth-audit.jsonl` (warmth-audit.ts:4). Only `warmth-audit` has a reader (`ori query warmth-audit`), CLI only.

**F6 (Low) — Docs undercount the surface.** README:74, :208, :251, :283-299 and SKILL.md list 16 tools; `tests/mcp/server.test.ts:59-81` pins 21. `ori_wake`, `ori_update_decision`, `ori_explore_start/expand/conclude` are undocumented in the README table.

**F7 (Low, observation for other slices) — real DB state.** Probe on the copy: tables = `boosts, co_occurrence, embeddings, memory_events, meta, note_q, q_history, q_history_genuine, retrieval_log, session_checkpoint, sqlite_sequence, stage_log, stage_q`. **No `note/edge/note_term/note_access/note_project/dangling_link/graph_metric/index_meta`** — the production vault has not yet run the new code (fix-list measurements were on a copy; `meta.built_at = 2026-09-13`). `memory_events` (6 rows) is referenced nowhere in `src/`, `scripts/`, `adapters/` (grep empty). `-wal` is 103 MB, unmodified since 09-13 06:46, main file 222 MB; `dbstat`: `co_occurrence` 73.0 MB + autoindex 65.7 MB + `idx_cooc_a` 33.2 MB + `idx_cooc_b` 32.6 MB = **204 MB of 222 MB** for 239,993 rows (223,917 `bootstrap`, 16,076 `retrieval`). `note_q`: 750 rows, 735 `update_count=0`. Sent to SchemaAudit.

---

## 3. The 'cannot ask' matrix

| question | MCP tool | CLI | data exists? | verdict |
|---|---|---|---|---|
| what did I retrieve in the last 3 sessions | none | none | `retrieval_log(session_id, query_text, note_id, rank, timestamp)` — probe: last 3 sessions = 96 rows / 54 notes | **nothing** |
| which notes cite X | `ori_query kind=backlinks note=<exact title>` | `ori query backlinks <title>` | `edge`+`note` (once indexed); today rebuilt from markdown per call | partial: exact-title only, no fuzzy/slug, no counts, no 'cite X or Y' |
| notes about project P touched this week | none (`cross-project` = 'has ≥2 projects', query.ts:78) | none | `note_project` + `note.mtime_ms` + `note_access.last_accessed` | **nothing** |
| notes I've never surfaced | none (`fading` is vitality, not exposure) | none | `note LEFT JOIN retrieval_log` — probe approx: 392 of 1,532 embedded notes absent from `retrieval_log` | **nothing** (ori health prints a count only, no list) |
| why was note N ranked first | at call time only: `results[i].signals{composite,keyword,graph,warmth,rrf_base,rrf}` (ranking.ts:1-11), `stages_skipped` | same JSON | retrospectively: `retrieval_log(similarity_score,q_score,ucb_bonus,final_score)` + `stage_log` per session — but no per-signal breakdown persisted, and `session_id` is not returned to the caller so it cannot join | partial live, **nothing** retrospective |
| which stages ran for my last query / what did the bandit decide | `stages_skipped` array | same | `stage_log` full | partial |
| what is the Q-value / exposure of note N | none | none (`ori health` aggregates) | `note_q` | **nothing** |
| dangling links, ranked by number of citing notes | `ori_query kind=dangling` (flat list) | same | `dangling_link` | partial (no counts) |

---

## 4. Driver capabilities (better-sqlite3 12.6.2, SQLite 3.51.2, Node 22.14) — all verified on the copy

| capability | result | evidence |
|---|---|---|
| open read-only | **yes** — `new Database(p, {readonly:true, fileMustExist:true, timeout})` → `SQLITE_OPEN_READONLY`; `db.readonly===true` | `lib/database.js:32-35,60`; probe `db.readonly= true` |
| `PRAGMA query_only` | **yes**, settable via `db.pragma('query_only = 1')` (0→1) | probe |
| writes blocked | `INSERT` → `SQLITE_READONLY`; `CREATE TEMP TABLE` → `SQLITE_READONLY`; `PRAGMA journal_mode=DELETE` → `SQLITE_IOERR_LOCK` | probe |
| authorizer (`sqlite3_set_authorizer`) | **no** — prototype = `prepare,transaction,pragma,backup,serialize,function,aggregate,table,loadExtension,exec,close,defaultSafeIntegers,unsafeMode` | `lib/database.js:71-84`; probe `typeof setAuthorizer= undefined` |
| `interrupt()` | **no** (`typeof db.interrupt = undefined`) | probe; same prototype list |
| progress handler | **no** — `SQLITE_OMIT_PROGRESS_CALLBACK` | `deps/defines.gypi:32`; probe `sqlite_compileoption_used('OMIT_PROGRESS_CALLBACK')=1` |
| statement timeout | **none in-process.** Only a `worker_threads` Worker + `worker.terminate()` gives a bound, and termination lands only when native `sqlite3_step` returns to JS (per row for `.iterate()`, per statement for `.all()`). | consequence of the two rows above |
| single-statement enforcement | **yes at prepare**: `'SELECT 1; SELECT 2'` → `RangeError: The supplied SQL string contains more than one statement` | probe |
| read-only statement flag | **yes**: `stmt.readonly` (= `sqlite3_stmt_readonly`) — SELECT→true, INSERT→false, `PRAGMA journal_mode=DELETE`→false | probe |
| `ATTACH` | **NOT blocked** by readonly or query_only — `ATTACH DATABASE '<file>'` and `':memory:'` both succeed | probe `[attach file] OK` |
| `load_extension()` SQL | blocked: `not authorized` | probe |
| `readfile()/writefile()` | absent (`no such function`) | probe |
| row/byte caps | **JS only** — no `SQLITE_LIMIT_*` exposure; use `.iterate()` + counter | `lib/database.js` has no `limit` method |
| double-quoted strings | **error** (`SQLITE_DQS=0`): `SELECT "hello"` → `no such column: "hello" - should this be a string literal in single-quotes?` | `defines.gypi:16`; probe |
| URI filenames (`file:x?mode=ro`) | not honoured (`SQLITE_USE_URI=0`) → readonly must come from the option | `defines.gypi:38` |
| JSON1 / FTS5 / MATH / dbstat | all compiled in (`json_extract` works; `sqlite_compileoption_used('ENABLE_FTS5')=1`; `dbstat` vtab queryable) | `defines.gypi:18-27`; probe |
| WAL visibility from a second read-only connection | **yes**: WAL readers take a snapshot at each statement's read-txn start; the probe read the writer's uncheckpointed 103 MB WAL. Requires `-shm` to exist or be creatable (it does; same user). Caveat: a long-lived reader (e.g. a stuck worker) pins the WAL read-mark and blocks checkpoint reset → WAL growth; the real WAL is already 103 MB. | SQLite WAL docs; probe |
| `foreign_keys` default | already **1** (`SQLITE_DEFAULT_FOREIGN_KEYS=1`) — `indexstore.ts:56` pragma is belt-and-braces | `defines.gypi:12`; probe |
| runaway cost, real data | `SELECT source, COUNT(*) FROM co_occurrence GROUP BY source` = **2,044 ms**; 200k-row self-join = 620 ms; 11 COUNT subselects = 1,146 ms. In-process on the MCP server these block the event loop → worker thread is mandatory, not optional. | probe |

`initDB` (engine.ts:49-84) is unusable for this: it `mkdirSync`s, opens read-write, sets `journal_mode=WAL` and runs `CREATE TABLE IF NOT EXISTS` — all writes.

---

## 5. Design: `ori sql` / `memory_sql`

### 5a. Core function — `src/core/sqlquery.ts` (new; no new deps)

```ts
export interface SqlOptions { rowCap: number; timeoutMs: number; maxCellBytes?: number }
export interface SqlResult {
  columns: string[];
  rows: unknown[][];          // positional, JSON-safe (BigInt→string, Buffer→{blob_bytes:n})
  truncated: boolean;         // rowCap hit
  elapsedMs: number;
  warnings: string[];         // loud degradation, never bare catch
}
export function runReadOnlySql(dbPath: string, sql: string, opts: SqlOptions): Promise<SqlResult>;
export function validateReadOnlySql(sql: string): { ok: true; sql: string } | { ok: false; reason: string };
export function describeSchema(dbPath: string): Promise<{ tables: {name: string; ddl: string; doc: string}[]; views: {...}[] }>;
```

**Validation rules (`validateReadOnlySql`, pure, unit-testable):**
1. Strip leading `--…\n` and `/* … */` comments and whitespace (loop until none). Reject if what remains is empty.
2. First token (case-insensitive, word-boundary) MUST be one of `SELECT`, `WITH`, `EXPLAIN`, `VALUES`. Everything else — `ATTACH`, `DETACH`, `PRAGMA`, `INSERT`, `VACUUM`, `CREATE`, `BEGIN` — rejected with `reason` naming the token. This is what blocks ATTACH (driver does not).
3. Reject if the tokenized body (outside string literals) contains `ATTACH`, `DETACH`, `PRAGMA`, `load_extension`, `writefile`, `readfile`, `fts5_config`? — defensive; the prefix rule is the real guard and the driver rejects a second statement at prepare.
4. Strip one trailing `;`; if any `;` remains outside a string literal, reject (`single statement only`) — friendlier than the driver's RangeError but the driver is the backstop.
5. Length cap 16 KiB.

**Runtime contract (`runReadOnlySql`):**
- Spawn `new Worker(new URL('./sqlquery-worker.js', import.meta.url), { workerData: { dbPath, sql, rowCap, maxCellBytes } })`. Worker: `new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 1000 })`, `db.pragma('query_only = 1')`, `const stmt = db.prepare(sql)`; if `!stmt.readonly` → error `statement is not read-only` (catches `PRAGMA x=…` and anything the prefix rule missed); iterate `stmt.raw().iterate()` (raw → arrays, no per-row object allocation), stop at `rowCap` → `truncated=true`; `columns = stmt.columns().map(c => c.name)`; `db.close()`; `parentPort.postMessage(result)`.
- Main: `setTimeout(timeoutMs)` → `worker.terminate()`, reject with `SQL timed out after ${timeoutMs} ms` and push a warning. Document honestly: terminate lands at the next row boundary; a single monolithic step (e.g. `COUNT(*)` over a cross join) runs until SQLite finishes it — the *server* stays responsive, the *thread* leaks until then. That is the best the driver allows (§4).
- Defaults: `rowCap 200` (MCP) / `1000` (CLI), `timeoutMs 2000`, `maxCellBytes 4096` (truncate TEXT, replace BLOB with `{blob_bytes}` — the `embeddings` vectors are 1.5 KB each ×5 per row).
- Never call `initDB`. If the DB file is missing → `success:false`, warning `no index at <path>; run ori index build` (not an exception).
- `unsafeMode`/`function`/`loadExtension` never touched.

### 5b. Views — created by `initIndexStore` (they are derived, disposable, and make the agent's SQL short). Add to `indexstore.ts:58` block:

```sql
CREATE VIEW IF NOT EXISTS v_note AS
  SELECT n.id, n.slug, n.title, n.type, n.status, n.description, n.created,
         datetime(n.mtime_ms/1000,'unixepoch') AS modified,
         COALESCE(a.access_count, n.fm_access_count) AS access_count,
         a.last_accessed,
         (SELECT COUNT(*) FROM edge e WHERE e.dst = n.id) AS inbound,
         (SELECT COUNT(*) FROM edge e WHERE e.src = n.id) AS outbound,
         (SELECT value FROM graph_metric g WHERE g.note_id=n.id AND g.metric='pagerank') AS pagerank,
         q.q_value, q.update_count AS q_updates, q.exposure_count
  FROM note n LEFT JOIN note_access a ON a.slug=n.slug LEFT JOIN note_q q ON q.note_id=n.slug;

CREATE VIEW IF NOT EXISTS v_link AS
  SELECT s.slug AS src, s.title AS src_title, d.slug AS dst, d.title AS dst_title FROM edge e
  JOIN note s ON s.id=e.src JOIN note d ON d.id=e.dst;

CREATE VIEW IF NOT EXISTS v_dangling AS
  SELECT dl.target, COUNT(*) AS citing_notes, group_concat(n.title, ' | ') AS cited_by
  FROM dangling_link dl JOIN note n ON n.id=dl.src GROUP BY dl.target;

CREATE VIEW IF NOT EXISTS v_retrieval AS
  SELECT r.session_id, r.timestamp, r.query_text, r.query_type, r.note_id AS slug, n.title,
         r.rank, r.final_score, r.q_score, r.ucb_bonus,
         CASE WHEN r.session_id LIKE 'cli-%' THEN 'cli' ELSE 'mcp' END AS transport
  FROM retrieval_log r LEFT JOIN note n ON n.slug=r.note_id;

CREATE VIEW IF NOT EXISTS v_session AS
  SELECT session_id, MIN(timestamp) AS started, MAX(timestamp) AS ended,
         COUNT(DISTINCT query_text) AS queries, COUNT(*) AS retrievals
  FROM retrieval_log GROUP BY session_id;

CREATE VIEW IF NOT EXISTS v_stage AS
  SELECT session_id, timestamp, stage_id, decision, quality_before, quality_after, compute_time_ms, reward
  FROM stage_log;
```

Each matrix row then becomes one obvious query, e.g. `SELECT * FROM v_retrieval WHERE session_id IN (SELECT session_id FROM v_session ORDER BY ended DESC LIMIT 3)`; `SELECT src_title FROM v_link WHERE dst_title LIKE '%X%'`; `SELECT title, modified FROM v_note WHERE id IN (SELECT note_id FROM note_project WHERE project='P') AND modified > date('now','-7 days')`; `SELECT title FROM v_note WHERE slug NOT IN (SELECT slug FROM v_retrieval)`; `SELECT * FROM v_stage WHERE session_id=? ORDER BY timestamp`.

**To make 'why ranked first' answerable retrospectively** two small additions outside the views: (i) return `session_id` in `SearchResult.data` (search.ts:791-800) so the agent can join; (ii) persist `signals` — add `signals_json TEXT` to `retrieval_log` (qvalue.ts:76-88, `ALTER … ADD COLUMN` in the existing try pattern) and write `JSON.stringify(result.signals)` at search.ts:766-770; JSON1 is compiled in so `json_extract(signals_json,'$.keyword')` works in SQL.

### 5c. Schema discovery — `ori sql --schema` / `memory_sql {schema:true}`
`describeSchema` reads `SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'` on the same read-only connection and zips each name with a one-line doc from a `const SCHEMA_DOCS: Record<string,string>` in `sqlquery.ts` (e.g. `note: 'one row per notes/*.md, derived; slug is the join key everywhere'`, `retrieval_log: 'every note returned by ranked/explore, one row per (session, query, note)'`, `co_occurrence: 'pair counts; source=bootstrap is wiki-link derived, retrieval is observed'`). Undocumented tables (e.g. legacy `memory_events`) are returned with `doc: '(undocumented)'` so nothing is hidden. Output: `{ tables: [{name, ddl, doc, rows}], views: [...] }` — `rows` from `SELECT COUNT(*)` per table, capped by the same timeout.

### 5d. Surfaces
- **CLI** `ori sql "<SELECT…>" [--limit n] [--timeout ms] [--schema]` in `index.ts`, JSON to stdout like every other command (`{success, data:{columns,rows,truncated,elapsedMs}, warnings}`), so hooks can `spawnSync('ori',['sql', q])` exactly as `orient.mjs:27` does today. Read `--stdin` too: hook scripts already pipe.
- **MCP** `memory_sql` in serve.ts: `{ sql: z.string(), limit: z.number().optional(), schema: z.boolean().optional() }` → `textResult(await runReadOnlySql(intelligenceDbPath, sql, {rowCap: min(limit??200, 500), timeoutMs: 2000}))`. Uses its own read-only worker connection, never `intelligenceDb`. Add to `tests/mcp/server.test.ts:59-81` list and README table.
- **Tool description** (this is what teaches the agent): `"Read-only SQL over your memory index (SQLite). Tables: v_note (one row per note: slug,title,type,status,modified,access_count,inbound,outbound,pagerank,q_value), v_link (src,dst wiki-link edges), v_dangling (missing targets + who cites them), v_retrieval (every note returned to you: session_id,timestamp,query_text,slug,rank,final_score), v_session, v_stage, note_project(note_id,project), co_occurrence. Single SELECT/WITH only; strings use single quotes; results capped at 200 rows (truncated=true) and 2 s. Call with schema=true for full DDL. Use for questions ranking tools can't answer: 'what did I retrieve last session', 'never-surfaced notes about P', 'who cites X'."` Keep it under ~120 words; put the long form in `--schema`.

### 5e. Existing exposure check
None. `grep -E '--sql|\bdump|setAuthorizer|interrupt\(|readonly' src/` → only `index.ts` `--json` options (59,230,467,486,513) and `indexstore.ts:230`. `scripts/reset-learning.mjs:74` opens the DB raw but read-write and operator-only.

---

## 6. What's left from the fix-list in this slice
- **Item 10** (CLI↔MCP divergence): partially open — F1 (q_reranking gate), F2 (explore-conclude learning), F3 (session storage), F4 (seven commands off the index seam).
- **Item 9**: closed for `ranked`; `explore-conclude` on CLI is the same defect in a different function (F2).
- **Item 7** (confidence signal): still nothing on the surface; `signals` are returned but no threshold/'noise-floor' flag; `session_id` not returned.
- **Item 8** (exposure bias): the data to *see* it exists (`retrieval_log`) but no surface lists never-surfaced notes (matrix row 4).
- **Item 26** doc line: README still says 16 tools (F6).

## 7. Recommendations (ordered)
1. `search.ts:612`: replace `sessionId &&` with `activeSession &&` (or drop it — `activeSession` is always set). One-line, closes half of item 10.
2. `explore.ts:638-651`: open the DB and mirror serve.ts:1077-1097 (`updateQ(..., 'explore_conclude')` + `recordCoRetrieval`) — or move that block into `runExploreConclude*` so both transports share it.
3. Land `src/core/sqlquery.ts` + worker + views (§5), `ori sql`, `memory_sql`, `--schema`; add `signals_json` + returned `session_id`.
4. Route `runQuerySimilar`, `runQuery{Orphans,Dangling,Backlinks,Important,Fading}`, `runHealth`, `runStatus` through `openSyncedIndex` — `orient.mjs` runs `ori health` at every SessionStart.
5. Make CLI explore sessions the shared store (file-backed) for MCP too, or namespace ids by transport and say so in the error.
6. README/SKILL.md: 21 tools; add `ori_wake`, `ori_update_decision`, `ori_explore_*`, `memory_sql`.

## 8. Open questions
- Should `memory_sql` see `embeddings` at all? Vectors are 5×1.5 KB BLOBs per row; `maxCellBytes` replaces them with `{blob_bytes}`, but a `SELECT *` still reads 7.9 MB. Consider a view-only allowlist (`v_*` + small tables) as the default with `raw:true` to opt in.
- WAL: with readers now possible from a second process, who checkpoints? The real `-wal` is already 103 MB and has not shrunk since 09-13; `wal_autocheckpoint` only runs on the *writer's* commit. Schema/safety slice question.
- The stuck-worker case (monolithic step past timeout) leaks a thread and pins the WAL read-mark until SQLite finishes. Acceptable for a 2 s budget on a 222 MB file? Measured worst case seen: 2,044 ms for one GROUP BY.
- `node:sqlite` (Node ≥22.5) is not in `engines` (>=18) and has no `interrupt` either as of 22.14 — no reason to switch.