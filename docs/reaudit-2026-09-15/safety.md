# Ori re-audit — slice `safety` (2026-09-15)

Scope: residual correctness/degradation in `src/**` after tier 0/1/2 of `docs/fix-list-2026-09-15.md`. Read-only. No shell was available, so `git diff` was replaced by comparing the working tree against the published `ori-memory@0.6.1` dist (jsDelivr) and GitHub `main`; the production DB `C:/Users/aayoa/brain/.ori/embeddings.db` was queried read-only through the harness SQLite reader (no copy was possible without a shell; no write was issued).

---

## Findings (severity-ranked)

### F1 — HIGH — Tier-0 item 1 is half implemented: counters go into SQL, nothing flushes them, and the file-writing path is still reachable
- `flushAccessToFrontmatter` is defined at `src/core/indexstore.ts:608-636`. Production callers: **none**. `grep flushAccessToFrontmatter src tests` → only `src/core/indexstore.ts:608` (definition), doc comments at `indexstore.ts:124,599`, `noteindex.ts:69,154`, and the test `tests/core/access-tracking.test.ts:30,177`.
- No `nap` command exists: `grep '\.command("' src/index.ts` lists init, wake, status, health, query, validate, add, promote, archive, bridge, serve, index, graph, prune, explore, explore-start, explore-expand, explore-conclude — no `nap`. `grep 'ori_nap|"nap"' src/cli/serve.ts` → 0 hits. `src/core/nap.ts` is the consolidation queue (kept-separate ledger) and never imports indexstore.
- `CHANGELOG.md:68` says access counts "flush to frontmatter explicitly". They do not. Net effect: `note_access` is now the **only** copy of the ACT-R usage signal accumulated since today, and it is not derived (cannot be rebuilt from files) while living in the file the design calls disposable. Deleting `.ori/embeddings.db` — the documented repair for everything — now loses usage counters, which is exactly what #17 was about.
- The old hazard is still live as a fallback: `src/core/noteindex.ts:157-179` — when `db` is undefined, `Promise.allSettled` rewrites ~11 note files per query (now via `writeFrontmatterFile`, so no truncation, but still no lock → lost increments, and `yaml.stringify` renormalisation of hand-authored frontmatter). `db` is undefined whenever `openSyncedIndex` returns `{reason}` (`indexstore.ts:727-737`), which happens when `covered !== expectedNotes`. `syncIndex` silently `continue`s on any note whose `stat` or `readFile` fails (`indexstore.ts:316-320`, `327-331`), so **one** unreadable note (tier-3 item 25's 265-char path is the obvious candidate) flips the entire vault back to full scans **and** file-mutating reads on every query. The fallback is loud (a `reason` string) but does not name the file, and the cliff is total, not proportional.

### F2 — HIGH — `buildIndex` deletes every embedding and every boost if `notes/` cannot be listed
- `src/core/engine.ts:509-517`: `try { dirents = readdir(notesDir) } catch { files = []; }` — bare, all error codes.
- `engine.ts:550-557`: every title in `existingHashes` not in `activeTitles` → `removeNoteFromDB(db, title)`, which deletes from `embeddings` **and** `boosts` (`engine.ts:92-98`).
- So a transient EACCES/EBUSY/ENOENT on `notes/` (antivirus, a sync client mid-rename, wrong cwd resolving to a vault-less dir) during `ori index build` empties both tables, returns `{indexed:0, skipped:0, total:0}` with no warning. Embeddings are rebuildable (minutes of model time at 1,532 rows); `boosts` (1,816 rows in production, with `sessions` spread) are learning state and are not.
- Contrast `indexstore.ts:274-283`, which returns early only on ENOENT and rethrows otherwise — that is the correct shape.

### F3 — HIGH — `busy_timeout` / `foreign_keys` are per-connection and only set on the index seam; several writers never get them
- Set in `initIndexStore` (`src/core/indexstore.ts:51` `busy_timeout = 5000`, `:56` `foreign_keys = ON`). `initDB` (`src/core/engine.ts:47-86`) sets only `journal_mode = WAL` (`:52`). `grep '\.pragma\(' src` → exactly those three lines.
- Connections that write **without** ever reaching `initIndexStore`:
  - `buildIndex` — `engine.ts:493` opens its own handle, then `indexNote` does one autocommit `INSERT OR REPLACE` per note (`engine.ts:469-478`), plus `meta` writes (`:585-590`). `runIndexBuild` calls it at `src/cli/indexcmd.ts:71` **before** its own `initDB`+`initIndexStore` at `:73-76`, and outside the try at `:75`. A collision with the MCP server's per-query writes → immediate `SQLITE_BUSY` → `ori index build` exits 1 mid-build.
  - `src/cli/archive.ts:75` → `removeNoteFromDB` at `:97`.
  - `src/cli/prune.ts:169` (apply path).
  - MCP `intelligenceDb` (`src/cli/serve.ts:182`) until the first `ori_query_ranked`/`ori_explore` passes it into `openSyncedIndex`. Startup work on that handle — `initQValueTables/initCoOccurrenceTables/initStageTables` (`:183-185`), `CREATE TABLE session_checkpoint` (`:212-218`, **outside** any try), and `applyAbandonedCheckpoints` (`:222-247`) — runs with no timeout.
- Consequence in `applyAbandonedCheckpoints`: inner `catch {}` at `serve.ts:235` treats a transient BUSY from `batchUpdateQ` (`:232`) identically to a corrupt row, then unconditionally `DELETE`s the checkpoint (`:238`). A killed session's rewards are dropped silently if the server restarts while a CLI query holds the write lock.
- `foreign_keys` similarly only exists on seam connections; archive/prune/buildIndex handles delete with FK enforcement OFF — harmless today only because they never touch `note`.

### F4 — MED — Unguarded writes on the query path can discard a computed answer
Inside `runQueryRanked` after results are final, outside any try:
- `src/cli/search.ts:631` `logStageDecision` (INSERT into `stage_log`).
- `search.ts:663` `logAccess` → `src/core/tracking.ts:53-54` `mkdir` + `appendFile` on `ops/access.jsonl`.
- `search.ts:706` `recordNoteAccess` → `recordAccess` transaction (`indexstore.ts:581-593`).
- `search.ts:738` `applyActivationBoosts` transaction (`src/core/activation.ts:169`).
Any `SQLITE_BUSY` surviving the 5 s wait, or an EACCES on the JSONL, throws out of `runQueryRanked` with the answer already in `withExploration`. The CLI prints the error and exits 1 (`src/index.ts:584-587`); MCP returns `isError`. The learning writes at `:751-793` are correctly wrapped and push warnings — the four above are not.
- Lock-holder sizing: the serve-mode flush (`serve.ts:283-326`) runs `recomputeAllNPMI` + `runHomeostasis` inside one transaction. `recomputeAllNPMI` issues one `UPDATE` per `co_occurrence` row (`src/core/cooccurrence.ts:262-278`). Production `co_occurrence` = **239,993 rows** (223,917 bootstrap, 16,076 retrieval). `runHomeostasis` adds two range `UPDATE`s per node (`:202-224`). That is a multi-second exclusive window at every MCP session end, during which every CLI query's four writes above wait up to 5 s each and then throw.
- Also: `syncIndex` runs a write transaction on **every** query (`indexstore.ts:370-457`, called unconditionally from `openSyncedIndex:725`) — even a no-op sync executes `INSERT ... index_meta synced_at` (`:454`). This is the one "index write on the query path" the design says must never block a query; it is wrapped (`openSyncedIndex` catch → reason), so it degrades loudly rather than blocking — but it does take the write lock per query.

### F5 — MED — A corrupt or locked DB file stops every session, with no repair hint, and the diagnostics hide it
- `initDB` is called outside any try at `src/cli/search.ts:234` (ranked), `:840` (warmth), `:971` (similar), `src/cli/explore.ts:142/149/472`, `src/cli/add.ts:117`. `db.pragma("journal_mode = WAL")` at `engine.ts:52` is the first statement to touch the file; on a non-database/corrupt file better-sqlite3 throws `SQLITE_NOTADB`/`SQLITE_CORRUPT` there. Nothing catches it: CLI → `index.ts:584` prints and exits 1; MCP → SDK-level `isError`. Every subsequent query fails identically until the user guesses to delete the file.
- The `fs.access` guards (`search.ts:224`, `explore.ts:137`, `health.ts:94`, `prune.ts:88`, `query.ts:145`) only distinguish *missing*; they cannot see corrupt/locked.
- `ori health` — the diagnostic — swallows it: `src/cli/health.ts:152` `catch { // No index yet }` wraps `initDB` and everything after; a corrupt DB yields `learning: undefined` with zero warnings. Same at `serve.ts:635` (orient), `prune.ts:92`, `query.ts:149` (boosts silently absent → different ranking).
- Fallback that does exist: `openSyncedIndex` (`indexstore.ts:712-745`) and `cachedGraphMetrics` (`:755-775`) catch and return reasons — but only after `initDB` has already succeeded. The "stale index never stops a session" invariant holds for *stale*; it does not hold for *corrupt* or *locked-at-open*.

### F6 — MED — No schema version; migration story is ALTER-in-try, non-transactional, and blind to removed tables
- `grep -i 'user_version|schema_version' src tests docs README CHANGELOG` → 0 hits in code; only fix-list prose.
- What changed vs. released 0.6.1 (compared against `https://cdn.jsdelivr.net/npm/ori-memory@0.6.1/dist/core/*.js`; `src/core/indexstore.ts` does not exist on GitHub `main` — HTTP 404 — nor in the published dist listing):
  - **Identical DDL**: `embeddings`, `meta`, `boosts` (+ the two ALTERs at `engine.ts:79-84`), `note_q`, `q_history`, `retrieval_log`, `stage_q`, `stage_log`, `co_occurrence`, `session_checkpoint`.
  - **New tables** (all in `indexstore.ts:58-163`): `note`, `note_project`, `edge`, `dangling_link`, `graph_metric`, `note_access`, `note_term`, `index_meta`. Because they are new, a released-0.6.1 DB gets them created fresh with `REFERENCES ... ON DELETE CASCADE` intact. The ALTER blocks at `indexstore.ts:170-216` only matter for DBs created by intermediate working-tree states today.
  - **Removed**: `memory_events` (released `dist/core/memory-telemetry.js` exists; no `memory-telemetry` in the working tree — `grep memory_events src` → 0). Production still carries it (6 rows). Also `q_history_genuine` (896 rows) created by `scripts/reset-learning.mjs:123`. Nothing will ever drop either.
- **v0.5 user on v0.6.1 code**: `boosts` gains `access_count`/`sessions` via the try-ALTER (`engine.ts:79-84`); the learning tables are created on first use; the derived tables likewise. Works. The risk is not v0.5→v0.6.1, it is the *next* change to any existing table: `CREATE TABLE IF NOT EXISTS` is a no-op, and the only mechanism is hand-written ALTER-in-try that swallows every error, not just "duplicate column" (`indexstore.ts:177,196,210`, `engine.ts:81,84`).
- Non-transactional migration: `indexstore.ts:186-216` — six ALTERs then `DELETE FROM note` as separate autocommits. Crash after the last ALTER, before `:215`: on next open all ALTERs fail (swallowed), `termShapeChanged` stays false, `note_term.tf_*` stay 0 for every unchanged note, and BM25 from the store returns nothing — the exact failure the comment at `:180-185` says it exists to prevent.
- Production state, read from `C:/Users/aayoa/brain/.ori/embeddings.db` `sqlite_master`: 13 tables — boosts, co_occurrence, embeddings, memory_events, meta, note_q, q_history, q_history_genuine, retrieval_log, session_checkpoint, sqlite_sequence, stage_log, stage_q. **No** `note`/`note_term`/`note_access`/`edge`/`index_meta`. The real vault has not yet been opened by the working-tree code (the fix-list's timings were on a copy). `meta` holds `learning_reset_2026_08_28`, `bm25_arm_reset_2026_09_06`, `built_at`, `note_count` — it is already the de-facto marker/version store.

### F7 — MED — CASCADE makes orphans unrepresentable only for the derived tables; learning tables still orphan
- FK + CASCADE exist only on `note_project/edge/dangling_link/graph_metric/note_term → note(id)` (`indexstore.ts:94,99-100,108,113,146`). `boosts`, `note_q`, `q_history`, `retrieval_log`, `co_occurrence`, `note_access` are keyed by TEXT title/slug with no FK (`engine.ts:69-75`, `qvalue.ts:53-88`, `cooccurrence.ts:61-71`, `indexstore.ts:127-134`).
- `removeNoteFromDB` deletes only `embeddings` + `boosts` (`engine.ts:92-98`); `grep 'DELETE FROM' src` shows no delete on note_q/co_occurrence/retrieval_log/note_access anywhere.
- Production (case-insensitive join against `embeddings.title`): **326** orphan `boosts` rows, **144** orphan `note_q` rows (of 750), **87,999** `co_occurrence` rows (36.7% of 239,993) naming a note that no longer exists. Those orphans still carry PPR mass (`cooccurrence_ppr` stage) and activation — issue #1's symptom, one table over.
- Fix-list tier-0 item 4 says "unrepresentable"; that is true for the derived index and false for the three tables that actually caused #1.

### F8 — MED — Non-atomic overwrites of user-authored files remain outside notes/
All fs writes enumerated (`grep writeFile|rename|unlink|mkdir|appendFile|rm|copyFile src`). Atomic/rollback-safe: `frontmatter.ts:159-179` (`writeFileAtomic`, used by `writeFrontmatterFile`, `state.ts:34`, `nap.ts:131`), `promote.ts:303-317` (move-first + rollback). **Exactly one raw `fs.rename`**: `src/core/frontmatter.ts:121`, inside `renameWithRetry`. Not atomic:
- `src/cli/serve.ts:720` `ori_update` — plain `fs.writeFile` over `self/identity.md`, `goals.md`, `methodology.md`, `ops/daily.md`, `reminders.md`. A backup is written first (`:712-715`, also plain), but the live file can be left truncated; no rollback. These are the agent's identity files.
- `src/cli/bridge.ts:289` (`~/.claude/settings.json`), `:303` (`.mcp.json`), `:457` (Codex `config.toml`), `:839` (Hermes yaml), `:1129` (OpenCode json), `:348/:916/:1204` (instruction files). All plain `writeFile` over user-owned config. Worse, `:283-286` and `:297-300` treat a JSON parse failure as "file missing — start fresh", so an *unparseable but recoverable* `settings.json` is silently replaced by Ori's minimal one.
- `src/cli/add.ts:106` — new inbox file, plain write; a crash leaves a partial note that `promote` will happily read. Low.
- `src/cli/explore.ts:571`, `update-check.ts:82/236`, `windows-terminal.ts:90` — derived/cache; acceptable.
- Append-only JSONL logs (`tracking.ts:54`, `explore-audit.ts:69`, `warmth-audit.ts:45`, `promote.ts:152`, `bridge.ts:333/901`): append is fine; readers skip malformed lines (`explore-audit.ts:89`, `warmth-audit.ts:65`).
- `promote.ts:274-280` → `:303`: TOCTOU. The existence check passes, then `renameWithRetry(inboxPath, destPath)` — `rename` replaces an existing destination on both POSIX and Win32 (`MoveFileEx REPLACE_EXISTING`). A note created at `destPath` between the two calls is clobbered. Narrow; fix is `fs.link`+`unlink` or `open(dest,'wx')` probe immediately before, or accept.

### F9 — MED — Silent `catch` inventory (`grep 'catch\s*(\(|\{)' src`, 130 sites). Ones that hide real degradation:
| file:line | swallows | why it matters |
|---|---|---|
| `search.ts:520` | any error in `cooccurrence_ppr` | comment says "table may not exist" but `initCoOccurrenceTables` ran at `:321`; now hides BUSY/data errors and drops a stage with no warning (every other stage warns) |
| `serve.ts:186` | `initDB` failure on existing file | corrupt/locked DB → `intelligenceDb = null` → whole MCP session runs with no learning, no stderr line |
| `serve.ts:235` + `:238` | transient BUSY in recovery | checkpoint row deleted without being applied (F3) |
| `serve.ts:245`, `:264`, `:289`, `:327` | recovery / 60 s checkpoint / NPMI / final flush | the only write path for session credit fails with zero trace; `:327` at least leaves the checkpoint row intact because the DELETE at `:307` rolls back with the tx |
| `health.ts:152` | corrupt DB | the diagnostic reports nothing (F5) |
| `serve.ts:635`, `prune.ts:92`, `query.ts:149` | corrupt/locked DB | boosts silently absent; orient shows no index problem |
| `indexstore.ts:318`, `:329` | unreadable note | triggers whole-vault fallback without naming the file (F1) |
| `indexstore.ts:177/196/210`, `engine.ts:81/84` | every ALTER error | should test `err.message.includes('duplicate column')` and rethrow otherwise |
| `engine.ts:515` | `readdir` failure | wipes tables (F2) |
| `explore.ts:537` | sub-question warmth | `:219` warns for the same failure on the main path; inconsistent |
| `explore.ts:599`, `:662` | `reseed().catch(() => undefined)` | warmth seed lost silently |
| `bridge.ts:284`, `:298` | JSON parse error | user config overwritten (F8) |
| `anthropic.ts:105/143`, `openai-compat.ts:110/141` | LLM failure → `{}`/`""` | promote enhancement silently absent; caller gets no warning |
| `state.ts:24`, `nap.ts:123` | corrupt state/ledger JSON | reset to defaults then overwritten on next write |
| `serve.ts:70` (`safeReadFile`) | EACCES on identity file | `ori_update` skips the backup (`existing === ""`) and proceeds |
Loud and fine: `add.ts:145/179`, `explore.ts:219/268/385/603+`, `indexcmd.ts:95`, `prune.ts:179`, `search.ts:600/757/789`, `frontmatter.ts:50`, `indexstore.ts:736/767`, `llm.ts:87`, `windows-terminal.ts:93/108`, all ENOENT-only guards (`config.ts:461`, `graph.ts:117`, `vault.ts:113`, `query.ts:82`, `status.ts:25`, `indexstore.ts:277`).

### F10 — LOW — Transaction coverage of multi-statement mutations
Wrapped: `syncIndex` (`indexstore.ts:370-457`), `saveGraphMetrics` (`:651`), `recordAccess` (`:591`), `removeNoteFromDB` (`engine.ts:93`), `applyActivationBoosts` (`activation.ts:169`), `batchUpdateQ` (`qvalue.ts:592`), `runHomeostasis`/`recomputeAllNPMI`/`bootstrapFromWikiLinks` (`cooccurrence.ts:202/262/354`), serve flush (`serve.ts:283`). Not wrapped:
- `updateQ` (`qvalue.ts:364-392`): two statements (`note_q` upsert + `q_history` insert); safe under `batchUpdateQ`, but `serve.ts:1089` calls it per note in a loop, then `recordCoRetrieval` per pair (`:1091-1095`) — N + N² autocommits, partial on failure.
- `search.ts:781-787`: `logRetrieval` + `incrementExposure` per result, 2N autocommits; `serve.ts:900-904`: up to 36 `recordCoRetrieval` autocommits per query; `search.ts:631` per-stage `logStageDecision`. Each autocommit is a WAL append + fsync and a lock acquisition. Correctness impact is partial logging; latency impact is real on the query path.
- `buildIndex` (`engine.ts:562-577`): one autocommit per note. Resumable by content hash, so acceptable.
- `flushAccessToFrontmatter` (`indexstore.ts:619-635`): writes the file **then** `mark.run`; a crash between double-counts on the next pass (`base` already includes the delta). Moot until it has a caller; fix by marking first inside a tx and rolling back on write failure, or by storing the flushed value the file now holds.

### F11 — LOW (cross-slice, confirmed with RetrievalAudit) — serve-mode double credit / double exposure
`search.ts:764-788` builds a per-query `SessionRewardAccumulator` and `concludeSession`s it regardless of `sessionId`; `serve.ts:888` logs the same results into the session accumulator flushed at `:300`. `rerank.ts:128-129` and `search.ts:781-786` both `incrementExposure`+`logRetrieval` when `q_reranking` runs. RetrievalAudit owns the reward-math consequence.

---

## What's left from the fix-list in this slice
- **Item 1** (read rewrites user files): fallback path still exists (`noteindex.ts:166-178`) and is reached on any coverage gap; the `ori nap` flush does not exist; `CHANGELOG.md:68` overstates. Partially done.
- **Item 2** (promote): done (`promote.ts:303-317`), with a TOCTOU nit.
- **Item 3** (busy_timeout): done on the seam only; `initDB` callers in `buildIndex`, archive, prune, and the MCP startup path still have none.
- **Item 4** (orphans on archive): done for derived tables; `boosts`/`note_q`/`co_occurrence` still orphan (326 / 144 / 87,999 rows in production).
- Not on the list but in scope: no schema version (F6), corrupt-DB path (F5), `buildIndex` wipe (F2).

---

## Recommendations

### R1 — Move `busy_timeout` and `foreign_keys` into `initDB`
`src/core/engine.ts:51-52`: after `new Database(dbPath)` set `journal_mode = WAL`, `busy_timeout = 5000`, `foreign_keys = ON`, `synchronous = NORMAL` (WAL-safe, removes a fsync per autocommit — matters for F10). Delete the two pragmas from `initIndexStore` (`indexstore.ts:51,56`). Every writer in F3 is fixed by this one move; no callsite changes.

### R2 — Make `initDB` the corruption boundary
Wrap `new Database` + first pragma in `initDB`; on `SQLITE_NOTADB`/`SQLITE_CORRUPT`, rename the file (and `-wal`/`-shm`) to `embeddings.db.corrupt-<iso>` and rebuild — but only after R5 separates the non-derived tables, otherwise this discards learning state. Until then: throw an `OriDbError` whose message names the file and the repair, and make `health.ts:152`, `serve.ts:186/635`, `prune.ts:92`, `query.ts:149` push that message instead of swallowing.

### R3 — `buildIndex` must not wipe on a listing failure
`engine.ts:509-517`: mirror `indexstore.ts:277-282` — return early on ENOENT, rethrow otherwise. Additionally guard the removal loop: if `files.length === 0 && existingHashes.size > 0`, refuse and warn rather than delete.

### R4 — Wrap the four post-result writes in `runQueryRanked`
`search.ts:631, 663, 706, 738` → one try/catch each pushing to `warnings`, same shape as `:757` and `:789`. Batch `:781-787` and `serve.ts:900-904`/`:1088-1095` into one `db.transaction` each.

### R5 — Schema version + table classification (the migration story)
The design promise "derived index is disposable" is only honest if the disposable and the irreplaceable are separable. Classify every table now:

| table | class | on version mismatch |
|---|---|---|
| `note`, `note_project`, `edge`, `dangling_link`, `graph_metric`, `note_term`, `index_meta` | **derived** (from files) | `DROP`, recreate, resync — 620 ms @2k |
| `embeddings`, `meta.built_at/note_count` | **derived, expensive** (minutes of model time) | drop only on embedding-model/dim change; otherwise migrate |
| `boosts` | **learning** (spreading activation, session spread) | migrate; never drop |
| `note_q`, `q_history`, `retrieval_log`, `stage_q`, `stage_log`, `co_occurrence`, `session_checkpoint` | **learning** | migrate; never drop |
| `note_access` | **learning until flushed** | migrate; never drop — or implement the flush and then it is derived-from-frontmatter |
| `memory_events`, `q_history_genuine` | orphan | drop with a one-time notice |

DDL:
```sql
-- in initDB, before any other DDL
CREATE TABLE IF NOT EXISTS schema_version (
  component TEXT PRIMARY KEY,   -- 'core' | 'index' | 'learning'
  version   INTEGER NOT NULL,
  applied   TEXT NOT NULL DEFAULT (datetime('now'))
);
```
Use a per-component integer (not `PRAGMA user_version`, which is a single int and cannot express "index is disposable, learning is not"). `initDB` reads all three rows in one query. Rules:
- `index` version ≠ code constant → inside **one** transaction: `DROP TABLE` the seven derived tables, recreate, `UPDATE schema_version`, commit; `syncIndex` refills on the next query. This replaces the try-ALTER blocks at `indexstore.ts:170-216` and fixes their crash window.
- `learning` version < code constant → run an ordered list of `(from, to, fn)` migrations, each one `db.transaction`, each ending with `UPDATE schema_version`. ALTERs stay, but written as `if (!columns.has(name)) ALTER` using `PRAGMA table_info`, never `try/catch`.
- `learning` version > code constant → refuse to open with a message naming the newer version (downgrade protection; today a downgrade silently runs against columns it does not know).
- `core` version covers `embeddings`/`boosts`/`meta`; bump only on vector-shape changes, and on bump `DELETE FROM embeddings` while keeping `boosts`.
- Drop orphans: migration `learning 0→1` = `DROP TABLE IF EXISTS memory_events, q_history_genuine` after copying `q_history_genuine` into `q_history` if the team wants it kept.

The unversioned production DB is the baseline: absence of `schema_version` = `{core:0,index:0,learning:0}`.

### R6 — Extend CASCADE reach, or add a reaper
The learning tables cannot FK to `note(id)` without becoming derived. Two honest options: (a) key them by `slug` and add a `reapOrphans(db)` run in `runIndexBuild` and the serve flush that deletes `boosts/note_q/co_occurrence/note_access/retrieval_log` rows whose slug is in neither `embeddings` nor `note` — with a count in `warnings`; (b) keep orphans but exclude them at read time (`loadBoosts`, PPR neighbour loads) via `JOIN note`. (a) is simpler and matches the 326/144/87,999 numbers.

### R7 — Finish item 1
Either add `ori nap` (CLI + `ori_nap`) whose first step is `flushAccessToFrontmatter`, or drop the flush and update `CHANGELOG.md:68`/the `noteindex.ts:69` and `indexstore.ts:124,599` comments to say counters are SQL-only. Also remove the file-writing fallback in `recordNoteAccess` (`noteindex.ts:166-178`) — when the index is unavailable, skip the increment and push a warning; a read must never write files, including on the fallback path. And make `syncIndex` return the skipped filenames so `openSyncedIndex`'s reason names them.

### R8 — Atomic writes for the remaining user files
`serve.ts:720` and every `bridge.ts` `writeFile` → `writeFileAtomic` (already exported from `frontmatter.ts`). In `bridge.ts:283-300`, distinguish ENOENT from parse failure; on parse failure return an error instead of overwriting.

---

## Open questions
1. Is `note_access` meant to be durable (then it must be flushed or backed up) or a cache (then frontmatter `access_count` is still authoritative and the flush should exist)? R5's classification depends on the answer.
2. Should `ori index build` be allowed to run while an MCP server holds the file? If yes, R1 is sufficient; if the intent is exclusivity, a lock row in `meta` with pid+timestamp would make the collision explicit.
3. Is the serve-mode flush's per-row NPMI recompute (239,993 UPDATEs) intended to stay at session end, or move to `ori index build`/nap where a multi-second lock is acceptable?
4. The production DB has never been opened by the working-tree code. First open will create 8 tables and run a full `syncIndex` (~2 s at 1,538 notes) inside the first query — is that acceptable as a first-run experience, or should `ori index build` be the documented step after upgrading?
5. `local://ori-reaudit-safety.md` could not be written (no `write` tool in this session). Main should persist this `report` field if the file is required by the contract.