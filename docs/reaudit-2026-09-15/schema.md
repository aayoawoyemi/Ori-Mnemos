# Ori re-audit — slice `schema` (2026-09-15)

Method: copied `<vault>/.ori/embeddings.db` + `-wal` + `-shm` to `%TEMP%/ori-schema-audit.db` (222,146,560 B main; the WAL is 103 MB uncheckpointed since 09-13 and IS included in every number below). Inspected with the project's own driver (`better-sqlite3` ^12.6.2 per package.json, SQLite 3.51.2). To measure the derived index I ran the compiled `dist/core/indexstore.js` `syncIndex` against the copy with `notesDir=<vault>/notes`. The real DB was never opened for writing.

> `local://ori-reaudit-schema.md` could not be written: this agent has no `write` tool. This `report` field is the full deliverable.

---

## 1. Schema table — declared in code vs. present in the production DB

Columns abbreviated; PK/UNIQUE in **bold**. "Rows (prod)" is the real DB; "Rows (after sync)" is after `syncIndex` on the copy. D = DERIVED (rebuildable from markdown), S = STATE (irreplaceable learning/session data).

| table | kind | owner DDL | rows (prod) | rows after sync | key column(s) & identity | indexes | notes |
|---|---|---|---|---|---|---|---|
| `embeddings` | D | engine.ts:55-64 | 1,532 | — | **title** TEXT = raw file basename | autoindex | 5 BLOB cols; content_hash, indexed_at; 7.88 MB |
| `meta` | D/S mixed | engine.ts:65-68 | 4 | — | **key** | autoindex | built_at, note_count (D) + `learning_reset_2026_08_28`, `bm25_arm_reset_2026_09_06` (ad-hoc state, one is JSON) |
| `boosts` | S | engine.ts:69-74 (+ALTER :76-82) | 1,816 | — | **title** = raw basename | autoindex | `sessions` TEXT = comma-joined UUID list (max 739 chars) |
| `note_q` | S | qvalue.ts:53-63 | 750 | — | **note_id** = `slugify(basename)` | autoindex | 735/750 `update_count=0`; q in [0.4127, 0.5] |
| `q_history` | S | qvalue.ts:65-74 | 17 | — | id AUTOINCREMENT; note_id slugified | idx(note_id) | sqlite_sequence says 13,656 ever inserted → reset on 08-28 |
| `retrieval_log` | S | qvalue.ts:76-88 | 12,817 | — | id; note_id slugified | idx(session_id), idx(note_id) | 256 sessions, 1,149 distinct note_ids; no `timestamp` index |
| `co_occurrence` | S+D mixed | cooccurrence.ts:61-73 | 239,993 | — | **(note_a, note_b)** TEXT, mixed shapes | PK autoindex + idx_cooc_a + idx_cooc_b | 223,917 `source='bootstrap'` (derived) / 16,076 `'retrieval'` (state); 204.4 MB total; 1,838 NULL npmi; 19,515 rows with note_a > note_b (bootstrap path) but 0 reversed duplicates |
| `stage_q` | S | stage-learner.ts:40-47 | 8 | — | **stage_id** | autoindex | `a_matrix`, `b_vector` = JSON TEXT (~380/85 chars) |
| `stage_log` | S | stage-learner.ts:49-63 | 1,862 | — | id | idx(stage_id), idx(session_id) | `query_features` = JSON array of 8 unnamed floats; decision ∈ {run 674, skip 1090, abstain 98} |
| `session_checkpoint` | S | serve.ts:213-217 | 0 | — | **session_id** | autoindex | `rewards_json` TEXT |
| `memory_events` | S (legacy) | **not in src/** (dist.bak-2026-09-06/core/memory-telemetry.js:13-24) | 6 | — | id | 3 indexes | payload JSON; last write 2026-06-21 |
| `q_history_genuine` | S (legacy) | **not in src/** (scripts/reset-learning.mjs:123-126) | 896 | — | none (no PK) | none | frozen copy from 08-28 reset |
| `note` | D | indexstore.ts:59-92 | **absent** | 1,538 | **id** INTEGER, **slug** UNIQUE = raw basename | autoindex(slug) | 308 non-slug-shaped slugs; 22 has_frontmatter=0; 943 empty description; 1 archived |
| `note_project` | D | indexstore.ts:93-97 | absent | 745 | (note_id→note.id CASCADE, project) | PK only; no idx(project) | |
| `edge` | D | indexstore.ts:98-103 | absent | 4,884 | (src,dst)→note.id CASCADE | idx_edge_dst | |
| `dangling_link` | D | indexstore.ts:107-111 | absent | 1,966 | (src→note.id, target TEXT) | PK | relevant-map 882, related-note 853, ori-map 20, meta-map 12 |
| `graph_metric` | D | indexstore.ts:112-117 | absent | 0 | (note_id, metric) | PK | Never populated by the query path — metrics are cached as one JSON blob in `index_meta.graph_metrics` (indexstore.ts:823-849) |
| `note_access` | S | indexstore.ts:127-132 | absent | 0 | **slug** = raw basename | PK | flushed_count for idempotent nap flush |
| `note_term` | D | indexstore.ts:145-158 | absent | 337,300 (22,654 terms) | (note_id→note.id, term) | idx_note_term_term | tf_title/tf_desc/tf_body; 6.6 MB + 5.25 MB index |
| `index_meta` | D | indexstore.ts:159-162 | absent | 1 | **key** | autoindex | synced_at; graph_metrics JSON when cached |

Size by object (dbstat, prod): co_occurrence 72.97 MB, its PK autoindex 65.70 MB, idx_cooc_a 33.23 MB, idx_cooc_b 32.55 MB, embeddings 7.88 MB, retrieval_log 3.80 MB + 2.42 MB indexes, boosts 1.88 MB, everything else < 0.3 MB. The derived index adds ~12.9 MB at 1,538 notes.

---

## 2. Findings

**F1 — HIGH. The production DB has never seen the derived index; first real query pays 6.5 s inline.**
`sqlite_master` of the real DB lists 13 tables; none of note/edge/note_term/note_access/note_project/dangling_link/graph_metric/index_meta exist (dump above). `meta.built_at = 2026-09-13T04:06:44Z`; `embeddings.indexed_at` max 2026-09-13. The fix-list's 350 ms figure was measured on a copy. `openSyncedIndex` (indexstore.ts:708-717) calls `syncIndex` unconditionally and synchronously before any query answers; on the empty store that is **6,502 ms** (1,538 reparsed, 4,884 edges, 1,966 dangling), then **260 ms** for a no-change resync (fix-list claims 152 ms; different run, same order). "A stale index never stops a session" holds, but the first session after upgrading blocks 6.5 s with no message saying why. There is also no `ori index build` gate: nothing tells the user their DB predates the schema.

**F2 — HIGH. Note identity is split three ways and index↔state joins are not expressible in SQL.**
- `note.slug` is the raw basename (`slug: p.title`, indexstore.ts:391), as are `embeddings.title` (engine.ts:474), `boosts.title`, `note_access.slug` (recordAccess receives titles, noteindex.ts:163).
- `note_q.note_id`, `retrieval_log.note_id`, `q_history.note_id` are `slugify(...)` at the storage boundary (qvalue.ts:99,107,182,242,281,359,399,421); `co_occurrence` retrieval rows come from `serve.ts:902,981,1093` titles (raw) while `extractCoOccurrencePairs` reads slugified ids from retrieval_log → mixed.
- Measured on the copy: 308/1,532 `embeddings.title` values contain spaces or uppercase; **635/1,538 `note.slug` values satisfy `slugify(slug) != slug`** — 418 basenames exceed 120 chars (max 235) and the `MAX_SLUG_LENGTH=120` cap (slug.ts:10-22, added 2026-09-06) truncates them.
- Join outcomes: `note ⋈ note_q` by equality **605/750**; via a `slugify` UDF 534; union 710; 40 unreachable (deleted notes). `retrieval_log` distinct ids reachable 1,060/1,149. `co_occurrence` distinct note_a: 1,079 by equality, 216 only via slugify, 94 neither. `note ⋈ boosts` 1,489/1,816.
- **207 `note_q` rows (27.6%) have ids longer than 120 chars.** Post-cap `slugify` can never emit those, so `getQ(slugify(title))` (qvalue.ts:99) and `incrementExposure`/`logRetrieval` (rerank.ts:128-140) read/write the truncated key. Those 207 rows are dead state since 2026-09-06 and their notes restarted at DEFAULT_Q — a second, silent learning reset on top of the 08-28 one. Zero slugify collisions among current basenames, so a mapping is 1:1 and migratable.
- Consequence for the "agent queries its memory" goal: an agent cannot write `JOIN note_q ON note_q.note_id = note.slug` and get the right answer; no VIEW can hide this without a UDF.

**F3 — MEDIUM. No schema version; DDL in 6 files + 1 script + 1 retired module.**
`grep schema_version|user_version|application_id` over src/: 0 hits. DDL lives in engine.ts:54-82, indexstore.ts:58-217, qvalue.ts:52-93, stage-learner.ts:39-64, cooccurrence.ts:60-74, serve.ts:212-218, and is invoked from at least search.ts:320-322 and serve.ts. Migration = ALTER-in-try (indexstore.ts:171-217, engine.ts:76-82) and "if any ALTER succeeded, `DELETE FROM note`" (indexstore.ts:210-216). That detects exactly one kind of change (column added) and has one response (drop all derived rows). It cannot express: a state-table migration (e.g. rekeying note_q), a targeted rebuild of one derived table, or "this DB is newer than this binary". Two tables in production are declared nowhere in `src/` (`memory_events`, `q_history_genuine`), which is what happens without a registry.

**F4 — MEDIUM. `co_occurrence` is 92% of the file and half of that is waste.**
204.4 MB of 222 MB. (a) `idx_cooc_a ON co_occurrence(note_a)` (cooccurrence.ts:72) duplicates the PK's leading column: EXPLAIN `WHERE note_a=?` uses `idx_cooc_a` when present and `sqlite_autoindex_co_occurrence_1` when dropped — same plan class, 33.2 MB for nothing. (b) TEXT keys average 216.8 bytes/row across four b-trees. (c) 223,917 of 239,993 rows are `source='bootstrap'`, i.e. derived from wiki-links and regenerable (`ori index build` regenerates them), yet they sit in a state table with the 16,076 real retrieval rows. (d) Canonical pair order is enforced in JS only (cooccurrence.ts:144); 19,515 rows have `note_a > note_b` (bootstrap path). 0 reversed duplicates today, but nothing prevents them — no `CHECK (note_a < note_b)`.

**F5 — MEDIUM. JSON-in-TEXT and opaque columns that block SELECTs.**
- `stage_q.a_matrix` / `b_vector` (stage-learner.ts:42-43): 8×8 LinUCB matrix as JSON. Fine as an opaque learner blob, but `total_reward`/`sample_count` are the only queryable facts.
- `stage_log.query_features` (stage-learner.ts:53): `'[0.12,0.19459,0,0,0,0,1.389,0]'` — 8 unnamed positions; an agent cannot ask "how does bm25 do on long queries" without knowing position semantics from source.
- `index_meta.graph_metrics` (indexstore.ts:823-849): the entire `GraphMetrics` (pagerank, communities, bridges, betweenness, communityStats) as one JSON value; `graph_metric` (the row-per-metric table) has **0 rows** on the query path because only `saveGraphMetrics` (health) fills it. So pagerank is not SELECT-able after a query.
- `boosts.sessions` (engine.ts:73): comma-joined UUID list up to 739 chars.
- `session_checkpoint.rewards_json`, `memory_events.payload`, `meta.bm25_arm_reset_2026_09_06`: JSON.
- `embeddings.*_vec`: BLOB with no dims/model/space metadata anywhere in the DB (`meta` has 4 keys, none is model); dims are inferred from `byteLength/4`. A config change to `embedding_model` mixes incomparable vectors silently.
- Free-text enums: `note.type`, `note.status`, `retrieval_log.query_type`, `stage_log.decision`, `co_occurrence.source` — acceptable, but no CHECK.

**F6 — LOW. Missing indexes for obvious agent queries.**
`retrieval_log(timestamp)`: `ORDER BY timestamp DESC LIMIT 20` is a full scan + temp b-tree, **21.4 ms → 0.062 ms** with `CREATE INDEX idx_retrieval_ts ON retrieval_log(timestamp)`. Same shape missing on `q_history(timestamp)`, `stage_log(timestamp)`. `note_project(project)`: `SCAN p` (745 rows, 0.07 ms today; grows linearly). Everything else measured hits an index (§5).

**F7 — LOW. Foreign keys stop at the index boundary — correctly, but that makes the TEXT key the contract.**
Inside the index group every child references `note(id) ON DELETE CASCADE` (indexstore.ts:94-146) and `foreign_keys=ON` is set (indexstore.ts:51-55). State tables cannot reference `note.id` because `DELETE FROM note` (indexstore.ts:216) regenerates ids — so the only durable identity is the TEXT key, which F2 shows is inconsistent. `embeddings`/`boosts` (engine.ts) have no FK either and are cleaned by `removeNoteFromDB` by title.

**F8 — LOW. Index/embeddings drift is real but small and now measurable.**
After sync: 1 `embeddings` row not in `note` (`loop-3---bash-code-mode-and-the-body---codex-aries-2`), 7 `note` rows without embeddings (6 notes created 2026-09-14 after the last `ori index build`, 1 archived). Expected under the rebuild policy; a `v_note` view should expose `has_embedding`.

**F9 — INFO. `meta` mixes derived facts with ad-hoc state markers** (`learning_reset_2026_08_28`, `bm25_arm_reset_2026_09_06` = `{"before": [56, -19.84]}`). Harmless; belongs in a `schema_version`/`maintenance_log` once one exists.

---

## 3. Embeddings: storage, search, and the pure-SQL question

- **Storage**: `float32ToBuffer` (engine.ts:397-399) writes the raw little-endian Float32Array bytes; every row has `title_vec`/`desc_vec`/`body_vec` = 1,536 B (384-d, model `Xenova/all-MiniLM-L6-v2`, config.ts:172-173), `type_vec` = 24 B (6-d one-hot, engine.ts:336-345), `community_vec` = 64 B (16-d sin/cos hash, engine.ts:353-366). 1,532 rows, no NULLs, all body_vec exactly 1,536 B. Model and dims are NOT stored in the DB.
- **Search**: `loadVectors` (engine.ts:186-208) pulls every row via `.raw().all()` and copies each blob (`bufferToFloat32`, engine.ts:418-423); `searchComposite` (engine.ts:811-859) does JS cosine per note per space. Measured on the copy: loading `body_vec` only 8.1 ms; brute-force cosine over 1,532×384 already-loaded 6.1 ms.
- **Zero-dep SQL path (works today)**: `db.function('cosine_f32', {deterministic:true}, (a,b)=>…)` then `SELECT title, cosine_f32(body_vec, :q) s FROM embeddings ORDER BY s DESC LIMIT 10` → **13.7 ms**, plan `SCAN embeddings | USE TEMP B-TREE FOR ORDER BY`. 2× slower than JS because of per-row C→JS marshalling, but it makes vectors queryable from any SQL an agent writes, with no new dependency. `sqrt()` and the math functions are available in this build.
- **Pure-SQL over a normalized table (measured, not viable)**: `embedding_dim(note_id, space, dim, value) WITHOUT ROWID` = 588,288 rows for one space, 13.9 MB (6× the blob), build 2,774 ms; `SUM(e.value*q.value) … GROUP BY note_id` = **1,538 ms** (PK order) / **1,673 ms** with a covering `(space,note_id,dim,value)` index. 250× slower than JS. Do not do this.
- **sqlite-vec**: `better-sqlite3` exposes `db.loadExtension` (typeof = function on this build), so it is technically loadable, but it is a new npm dependency and a native binary per platform — violates "no new npm deps". At 1.5k–10k notes brute force is 6–40 ms; an ANN index buys nothing until ~100k notes.
- **Recommendation**: keep blobs + JS for the ranked path; register `cosine_f32` (and `slugify`) on every connection open in one place (`initDB`) so agent-issued SQL can rank by similarity; record `embedding_model`, `embedding_dims`, `community_dims` in `index_meta` and refuse/rebuild on mismatch.

---

## 4. Target schema for an agent-queryable memory DB

### 4.1 Split: one file, two groups, one `schema_version` row per group
ATTACH (two files) was considered and rejected: it doubles WAL/busy handling and file handles for the MCP long-lived connection, cross-database FKs are unsupported, and `DELETE FROM note` already gives "rebuild the index" for free via CASCADE. What ATTACH would buy ("rm index.db" as the repair) is achieved by `ori index build --force`. One file; the group is a fact recorded in `schema_version`, and a `ori db schema` command prints it.

```sql
-- Replaces the scattered CREATE TABLE IF NOT EXISTS + ALTER-in-try.
CREATE TABLE IF NOT EXISTS schema_version (
  grp        TEXT PRIMARY KEY CHECK (grp IN ('index','state')),
  version    INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  ori_version TEXT NOT NULL
);
-- Rules: index migrations may always be "DELETE and resync" (disposable).
-- state migrations are numbered, forward-only, run in one transaction,
-- and a DB whose state.version > binary's known version is opened read-only
-- with a loud warning (never silently downgraded).
```

### 4.2 Canonical note identity
- **INDEX group**: `note.id` INTEGER for all FKs (already correct). `note.slug` renamed in meaning to *file key*: it IS the basename, never passed through `slugify`. Add `note.path TEXT` (relative to vault root) so multi-root (fix-list #30) is one column away, and `note.slug_norm TEXT` = `slugify(slug)` GENERATED/maintained by sync for link resolution.
- **STATE group**: key by `note_key TEXT` = basename. Reason: 4 of the 8 keyed tables already use it, it is what the filesystem uses, it is what an agent sees in `path`, and `slugify` is lossy (F2). `slugify()` is for **creating** filenames (add.ts) and **resolving** wiki-links (graph.ts) only — remove the normalisation at qvalue.ts:99 etc. and the `// Canonical keys` rationale at qvalue.ts:10-15 (that rationale was solving raw-title-vs-slug drift in retrieval_log; the fix is one key everywhere, not a lossy normaliser).
- **Migration (state v1→v2)**: for each state table, `UPDATE t SET note_key = n.slug FROM note n WHERE n.slug = t.note_id OR slugify(n.slug) = t.note_id` (UDF registered), merging duplicates by summing counts; rows matching nothing move to `note_q_orphan` and are reported by `ori health`. Measured coverage: 710/750 note_q, 1,060/1,149 retrieval_log ids.

### 4.3 Table changes (DDL deltas)
```sql
-- co_occurrence: split derived from state, integer-free but smaller
DROP INDEX IF EXISTS idx_cooc_a;                       -- redundant with PK, 33 MB
CREATE TABLE cooc_bootstrap (                          -- INDEX group, regenerated by ori index build
  a INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
  b INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
  npmi REAL NOT NULL,
  PRIMARY KEY (a, b), CHECK (a < b)
) WITHOUT ROWID;
CREATE INDEX idx_cooc_bootstrap_b ON cooc_bootstrap(b);
-- co_occurrence keeps only source='retrieval' rows (16,076), keyed by note_key, with CHECK (note_a < note_b).

-- retrieval/state timestamps
CREATE INDEX IF NOT EXISTS idx_retrieval_ts ON retrieval_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_q_history_ts ON q_history(timestamp);
CREATE INDEX IF NOT EXISTS idx_stage_log_ts ON stage_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_note_project_project ON note_project(project);

-- stage_log: name the features
CREATE TABLE stage_feature_name (pos INTEGER PRIMARY KEY, name TEXT NOT NULL);  -- 8 rows, from extractQueryFeatures
-- (query_features stays JSON; the name table + json_each makes it queryable: see v_stage_run)

-- graph metrics: populate graph_metric on the query path (saveGraphMetrics) instead of only from health,
-- and keep index_meta.graph_metrics only for communityStats. Then pagerank is a column an agent can ORDER BY.

-- embeddings: identity + provenance
-- index_meta rows: ('embedding_model','Xenova/all-MiniLM-L6-v2'), ('embedding_dims','384'), ('community_dims','16')
-- initDB compares to config and treats mismatch as "rebuild required", loudly.

-- legacy tables: DROP TABLE memory_events; DROP TABLE q_history_genuine after archiving to ops/ (they are outside the registry).
```

### 4.4 Views an agent would actually use
All views are defined against the post-migration keys (`note_key` = `note.slug`). Until the migration lands, replace `= n.slug` with `IN (n.slug, slugify(n.slug))` and register the UDF.

```sql
CREATE VIEW v_note AS
SELECT n.id, n.slug AS key, n.title, n.description, n.type, n.status, n.created,
       n.path,
       (SELECT group_concat(project, ',') FROM note_project p WHERE p.note_id = n.id) AS projects,
       (SELECT COUNT(*) FROM edge e WHERE e.dst = n.id)  AS inbound,
       (SELECT COUNT(*) FROM edge e WHERE e.src = n.id)  AS outbound,
       (SELECT COUNT(*) FROM dangling_link d WHERE d.src = n.id) AS dangling_out,
       COALESCE(a.access_count, 0) + n.fm_access_count    AS access_count,
       NULLIF(a.last_accessed, '')                       AS last_accessed,
       q.q_value, q.update_count, q.exposure_count,
       gm.value                                          AS pagerank,
       EXISTS (SELECT 1 FROM embeddings em WHERE em.title = n.slug) AS has_embedding,
       n.size_bytes, n.mtime_ms, n.indexed_at
FROM note n
LEFT JOIN note_access a  ON a.slug = n.slug
LEFT JOIN note_q q       ON q.note_id = n.slug
LEFT JOIN graph_metric gm ON gm.note_id = n.id AND gm.metric = 'pagerank';

CREATE VIEW v_link AS
SELECT s.slug AS src, d.slug AS dst FROM edge e
JOIN note s ON s.id = e.src JOIN note d ON d.id = e.dst;

CREATE VIEW v_dangling AS
SELECT dl.target, COUNT(*) AS referrers, group_concat(s.slug, '|') AS sources
FROM dangling_link dl JOIN note s ON s.id = dl.src
GROUP BY dl.target ORDER BY referrers DESC;

CREATE VIEW v_orphan AS      -- no inbound links, not archived
SELECT n.slug AS key, n.title, n.type, n.created FROM note n
WHERE n.status <> 'archived' AND NOT EXISTS (SELECT 1 FROM edge e WHERE e.dst = n.id);

CREATE VIEW v_recent_retrieval AS
SELECT r.timestamp, r.session_id, r.query_text, r.query_type, r.note_id AS key, r.rank, r.final_score
FROM retrieval_log r ORDER BY r.timestamp DESC;   -- needs idx_retrieval_ts (F6)

CREATE VIEW v_stale_note AS   -- never or long-unaccessed, never retrieved, no inbound
SELECT n.slug AS key, n.title, n.created,
       NULLIF(a.last_accessed,'') AS last_accessed,
       (SELECT MAX(timestamp) FROM retrieval_log r WHERE r.note_id = n.slug) AS last_retrieved,
       (SELECT COUNT(*) FROM edge e WHERE e.dst = n.id) AS inbound
FROM note n LEFT JOIN note_access a ON a.slug = n.slug
WHERE n.status <> 'archived'
  AND (a.last_accessed IS NULL OR a.last_accessed < date('now','-90 days'))
  AND NOT EXISTS (SELECT 1 FROM edge e WHERE e.dst = n.id);

CREATE VIEW v_term AS         -- lexical lookup: which notes contain a token, with per-field counts
SELECT t.term, n.slug AS key, t.tf_title, t.tf_desc, t.tf_body,
       (SELECT COUNT(*) FROM note_term x WHERE x.term = t.term) AS df
FROM note_term t JOIN note n ON n.id = t.note_id;

CREATE VIEW v_cooc AS          -- symmetric neighbour list over retrieval-learned pairs
SELECT note_a AS key, note_b AS other, co_retrieval_count, npmi_weight, last_co_retrieved FROM co_occurrence
UNION ALL
SELECT note_b, note_a, co_retrieval_count, npmi_weight, last_co_retrieved FROM co_occurrence;

CREATE VIEW v_stage_run AS     -- stage decisions with named features
SELECT s.id, s.timestamp, s.session_id, s.stage_id, s.decision, s.reward, s.compute_time_ms,
       f.name AS feature, je.value AS feature_value
FROM stage_log s, json_each(s.query_features) je
JOIN stage_feature_name f ON f.pos = je.key;

CREATE VIEW v_q_history AS
SELECT h.timestamp, h.note_id AS key, h.old_q, h.new_q, h.reward, h.reward_source, h.session_id FROM q_history h;
```

Similarity is not a view (needs a bound query vector) — expose it as the UDF: `SELECT key, cosine_f32(body_vec, :qvec) AS sim FROM embeddings JOIN note ON note.slug = embeddings.title ORDER BY sim DESC LIMIT 10;` (13.7 ms measured). The read-only agent connection should be opened with `{ readonly: true }` and `PRAGMA query_only = 1` (surface slice's concern).

---

## 5. Timing + EXPLAIN QUERY PLAN (copy, after `syncIndex` + `ANALYZE`, warm, mean of 20)

| # | query | ms/run | plan | verdict |
|---|---|---|---|---|
| Q1 | `note ⟕ note_q ⟕ note_access ORDER BY q_value DESC LIMIT 20` | **1.402** | SCAN n; SEARCH q autoindex(note_id=?); SEARCH a PK(slug=?); TEMP B-TREE ORDER BY | fine; scan of 1,538 is the intended shape. Returns wrong Q for ~20% of notes (F2) |
| Q1b | same via `slugify(n.slug)` UDF | 6.056 | SCAN n covering; SEARCH q; TEMP B-TREE | UDF cost 4.7 ms; only 534 match |
| Q2 | inbound count per note (LEFT JOIN edge GROUP BY) | 2.444 | SCAN n; SEARCH e covering idx_edge_dst; TEMP B-TREE | fine |
| Q2b | inbound via correlated subquery | 1.564 | SCAN n covering; CORRELATED SCALAR; SEARCH idx_edge_dst | faster; used in v_note |
| Q3 | notes matching term `'memory'` with field tf, top 20 | **1.688** | SEARCH t idx_note_term_term(term=?); SEARCH n rowid; TEMP B-TREE | fine |
| Q3b | two-term AND (`memory` ∧ `agent`) via IN subqueries | 0.465 | SEARCH n rowid; two covering idx searches + bloom filters | fine |
| Q4 | recent retrievals for one note | 0.050 | SEARCH idx_retrieval_note | fine |
| Q4b | `retrieval_log ORDER BY timestamp DESC LIMIT 20` | **21.368 → 0.062** | SCAN retrieval_log + TEMP B-TREE → SCAN USING INDEX idx_retrieval_ts | **needs index (F6)** |
| Q5 | co-occurrence neighbours (`note_a=? OR note_b=?`) | 0.069 | MULTI-INDEX OR (idx_cooc_a, idx_cooc_b) | fine; after dropping idx_cooc_a the PK autoindex serves note_a |
| Q6 | dangling targets by count | 0.581 | SCAN dangling_link; TEMP B-TREE GROUP/ORDER | fine at 1,966 rows |
| Q7 | stale notes (no access 90 d ∧ no inbound) | 0.079 | SCAN n covering; correlated idx_edge_dst; SEARCH a PK | fine |
| Q8 | df for term | 0.056 | SEARCH covering idx_note_term_term | fine |
| Q9 | notes in project `'ori'` | 0.074 | SCAN p; SEARCH n rowid | scan of 745 rows; add idx(project) before it matters |

Vector path (§3): JS brute force 6.08 ms; SQL UDF 13.74 ms (`SCAN embeddings | TEMP B-TREE`); normalized-table SQL 1,538–1,673 ms.

---

## 6. What's left from the fix-list in this slice

- **Tier 0 #3/#4 (busy_timeout, FK + CASCADE)**: present in code (indexstore.ts:51-55, :94-146). Not yet applied to the production DB (F1). Note `embeddings`/`boosts` are outside the FK graph (F7).
- **Tier 0 #1 (counters in SQL)**: `note_access` exists; production has 0 rows because the table does not exist there yet (F1).
- **Tier 1 #5/#8 (Q learning decorative)**: schema-side contributor found — 207/750 note_q rows orphaned by the 09-06 slug cap (F2); `ori health`'s "never updated" warning cannot see it.
- **Tier 1 #9 (CLI never logs stage_log)**: prod `stage_log` = 1,862 rows, all from serve; will change once CLI path with `initStageTables` (search.ts:322) runs.
- **Tier 2 #16 (bootstrap O(N²))**: production still holds 223,917 bootstrap rows = 92% of file (F4). The cap (`BOOTSTRAP_HUB_POSTER_CAP`) only applies on next `ori index build`; no VACUUM follows, so the file will not shrink without one.
- **Tier 3 (dangling placeholders)**: confirmed in the derived index: `relevant-map` 882, `related-note` 853 of 1,966 dangling rows (88%).
- **Tier 4 #30 (multi-root)**: needs `note.path`/`root` column (§4.2) — not present.
- **New, not on the list**: no schema version (F3); legacy tables in prod (F3); missing timestamp indexes (F6); embedding model/dims not recorded (F5).

---

## 7. Recommendations (ordered)

1. **`src/core/schema.ts`** — single owner of all DDL + `schema_version(grp)` + ordered migration list; `initDB` (engine.ts:49) calls it once; delete the six `init*Tables` DDL blocks and the ALTER-in-try loops. Add `ori db schema` (prints group, version, table, rows) and make `ori health` fail loudly when `schema_version` is missing or behind.
2. **First-run gate** — in `openSyncedIndex` (indexstore.ts:708), if `note` is empty and the vault has >N notes, return `{reason: 'Derived index not built (1,538 notes, ~6.5 s); run ori index build'}` and use scans for that request instead of blocking 6.5 s silently — or print the reason and proceed; either way the session sees why.
3. **One key** — state tables keyed by basename (`note_key`); remove `slugify` at qvalue.ts storage boundary; state migration v2 remaps 710/750 note_q rows and moves the rest to `note_q_orphan`; `ori health` reports orphan count. Register `slugify` and `cosine_f32` UDFs in `initDB` regardless, so hand-written SQL works before and after.
4. **co_occurrence** — `DROP INDEX idx_cooc_a`; move bootstrap rows to `cooc_bootstrap` (INDEX group, integer FKs, `CHECK (a<b)`); `VACUUM` in `ori index build --force`. Expected: ~200 MB → ~15 MB.
5. **Indexes** — `retrieval_log(timestamp)`, `q_history(timestamp)`, `stage_log(timestamp)`, `note_project(project)`.
6. **Populate `graph_metric` on the query path** (call `saveGraphMetrics` from `cachedGraphMetrics` on miss) so pagerank/betweenness are columns; keep `index_meta.graph_metrics` for `communityStats` only.
7. **Record provenance** — `index_meta` rows for embedding_model/embedding_dims/community_dims; mismatch ⇒ loud rebuild warning.
8. **Views** — ship §4.4 as part of the index migration (views are derived; drop/recreate every index version).
9. **Legacy** — `DROP TABLE memory_events, q_history_genuine` in state migration v2 after exporting to `ops/`.

## 8. Open questions

- Should `note_key` be the basename or `path` (relative, with `notes/` prefix)? `path` is the only choice that survives multi-root (#30) and is what an agent sees in results; basename is what four tables already use. Recommend `path` if #30 is in scope this quarter, else basename now with `path` as an extra column.
- Does anything outside `src/` (scripts/ori_refresh.py, aries-cli) read `note_q.note_id` by the slugified form? If so the rekey needs those callers too — not searched here.
- Is the 103 MB uncheckpointed WAL on the production DB a symptom of the MCP server never closing cleanly (serve.ts:180-193 says TerminateProcess is the norm)? `PRAGMA wal_checkpoint(TRUNCATE)` on `ori nap` would bound it; safety slice's call.
- `graph_metric` vs `index_meta.graph_metrics` — the comment at indexstore.ts:812-820 argues one encoder to avoid #32-style drift. Populating both from the same `GraphMetrics` value in one transaction satisfies that and makes pagerank queryable; confirm the maintainer accepts two representations written atomically.