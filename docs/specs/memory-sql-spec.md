# `ori sql` / `memory_sql` — behaviour specification

This describes what the feature is supposed to do. It is written to be
testable without reading the implementation. If behaviour and this document
disagree, one of them is a defect — say which and why.

---

## 1. What it is

A read-only SQL surface over the memory index at `<vault>/.ori/embeddings.db`.

Two entry points, same core:

- **CLI**: `ori sql "<statement>" [--limit n] [--timeout ms] [--schema] [--stdin]`
- **MCP**: tool `memory_sql` with `{ sql?: string, limit?: number, schema?: boolean }`

Both print/return a single JSON object.

---

## 2. Output contract

```json
{
  "success": true,
  "data": { "columns": ["..."], "rows": [[...]], "truncated": false, "elapsedMs": 12 },
  "warnings": []
}
```

- `columns` — column names in result order.
- `rows` — **positional arrays**, not objects. Row order matches `columns`.
- `truncated` — `true` when the row cap was reached and results were cut.
- `warnings` — every degradation is reported here. Silence means nothing went wrong.
- `success` — `false` only when nothing was produced. A query that legitimately
  returns zero rows is `success: true` with `rows: []`.

CLI exits non-zero when `success` is `false`.

---

## 3. What is allowed

The statement must begin with one of `SELECT`, `WITH`, `EXPLAIN`, `VALUES`
(case-insensitive). Leading whitespace, `--` line comments and `/* */` block
comments are skipped when determining the first token.

Exactly one statement. A single trailing `;` is permitted. Anything after it is
not.

Maximum 16 KiB of SQL.

## 4. What is rejected, and how

Rejection is **not** an exception or a crash. It returns the normal JSON shape
with `success: false` and the reason in `warnings[0]`.

Rejected:

- Any statement whose first token is not in the allowed set. This includes
  `ATTACH`, `DETACH`, `PRAGMA`, `INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`,
  `ALTER`, `VACUUM`, `BEGIN`, `REINDEX`. The reason names the offending token.
- A statement that is empty, whitespace only, or only comments.
- An unterminated string literal or block comment.
- More than one statement.
- Any of the forbidden keywords appearing **outside a string literal** anywhere
  in the statement, not just at the start. `WITH x AS (SELECT 1) INSERT ...`
  must be rejected.
- `load_extension`, `writefile`, `readfile`.

Explicitly **allowed**, and these are the interesting cases:

- A forbidden word inside a string literal: `SELECT 'DROP TABLE note'` is a
  valid query returning one text value.
- A forbidden word as a substring of an identifier. `update_count` and
  `created` are real column names and must not trip the `update` / `create`
  rules.
- Escaped quotes inside literals: `SELECT 'it''s fine'`.
- Comments before the statement: `-- note` newline `SELECT 1`.

## 5. Safety requirements

These are guarantees, not best effort. A test that gets a write to happen is a
critical finding.

- No statement may modify the database, create or drop anything, or reach a
  file outside the index.
- The connection used is read-only at the driver level *and* has
  `query_only` set, independently of any parsing.
- A prepared statement that the driver reports as not read-only is refused even
  if it passed validation.
- Attaching another database must be impossible.

## 6. Limits

- **Rows**: CLI default 1000, MCP default 200 with a hard cap of 500 — a
  larger `limit` is clamped, not honoured. Exceeding the cap sets
  `truncated: true` and adds a warning.
- **Time**: 2000 ms default. On timeout, `success: false`, and a warning naming
  the timeout. The query runs in a child process which is SIGKILLed, so
  cancellation is real even for a single monolithic step. The caller must
  return promptly and must not be left with a running query.
- **Cell size**: text longer than 4096 bytes is truncated with a marker giving
  the true byte length. A BLOB is never returned raw — it becomes
  `{"blob_bytes": n}`. (The index stores 1.5 KB float32 vectors; returning them
  raw would flood a model's context.)
- `BIGINT` values are returned as strings, since JSON cannot represent them.
- `NULL` is returned as `null`.

## 7. Schema discovery

`--schema` / `schema: true` returns every table and view with its DDL, a
one-line human description, and a row count — instead of running a query.

- Undocumented objects must still be listed, marked `(undocumented)`. Nothing
  is hidden.
- An object whose row count cannot be determined reports `-1` rather than
  failing the whole call.
- `sqlite_*` internal objects are excluded.

## 8. Views — the public contract

Queries are expected to target these. They exist so the physical tables can
change without breaking callers.

| view | one row per | key columns |
|---|---|---|
| `v_note` | note | `slug`, `title`, `type`, `status`, `description`, `created`, `modified`, `access_count`, `inbound`, `outbound`, `pagerank`, `betweenness`, `q_value`, `q_updates`, `exposure_count` |
| `v_link` | resolving wiki-link | `src`, `src_title`, `dst`, `dst_title` |
| `v_dangling` | missing link target | `target`, `citing_notes`, `cited_by` |
| `v_retrieval` | note returned by a query | `session_id`, `timestamp`, `query_text`, `query_type`, `slug`, `title`, `rank`, `final_score`, `q_score`, `ucb_bonus`, `transport` |
| `v_session` | session | `session_id`, `started`, `ended`, `queries`, `retrievals` |
| `v_stage` | stage decision | `session_id`, `timestamp`, `stage_id`, `decision`, `quality_before`, `quality_after`, `compute_time_ms`, `reward` |

Requirements:

- All six must exist and be **queryable immediately after `ori index build` on
  a brand-new vault**, before any search has ever run. A view that parses but
  errors with "no such table" on a fresh vault is a defect.
- `v_note.pagerank` must be populated, not `NULL`, for a vault with links.
- Views must be refreshed on re-index, so an upgraded install does not keep an
  older view definition.
- `transport` in `v_retrieval` is `cli` for session ids beginning `cli-`, else `mcp`.

## 9. Missing or broken index

- If the index file does not exist, the call returns `success: false` with a
  warning telling the caller to run `ori index build`. It must not throw an
  uncaught exception and must not create the file.
- A malformed or truncated database yields a warning, not a crash.

## 10. Known design limits, stated deliberately

These are not defects. Reporting them as such is a false positive.

- Cancellation kills a child process; an in-flight statement is lost, not rolled back (nothing is written, so there is nothing to roll back).
- The validator is a parser and parsers can be wrong; it exists for good error
  messages. The read-only connection is the actual guarantee.
- Views are recreated on every index build.

---

## Testing notes

Use a scratch vault; do not touch any real one. A vault is a directory
containing `notes/` and a `.ori/` directory; run `ori index build` inside it to
create the index.

Adversarial input is welcome and encouraged: unicode, very long statements,
nested comments, quoted identifiers, `UNION` against internal tables, CTEs that
hide keywords, recursive CTEs that never terminate, queries returning
5,000 rows, queries selecting embedding blobs.
