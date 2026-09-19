# `ori sql` — output contract / limits / schema discovery: black-box findings

Agent: `SqlContract`. Scope: spec sections **2 (output contract)**, **6 (limits)**,
**7 (schema discovery)**, **10 (known design limits)**.
Implementation source was never opened. Only `docs/specs/memory-sql-spec.md` was read.

## Test rig

| item | value |
|---|---|
| binary | `node C:/Users/aayoa/Desktop/ori/dist/index.js` |
| scratch vault | `%TEMP%\ori-falsify-contract` (651 notes, 1944 resolving edges, 652 dangling, unicode filenames/bodies, 4 notes with >6 KB descriptions and ~21 KB bodies) |
| second vault | `%TEMP%\ori-falsify-contract-noidx` (no index built) |
| index build | `{"indexed":650,"skipped":1,"total":651,"derived":{"edges":1944,"dangling":652}}` |
| probe scripts | `ops-falsify/probe-contract.mjs` (45 cases), `ops-falsify/probe-detail.mjs` (cells / schema / sizes / first-byte timing), `ops-falsify/mutate-db.mjs` + `ops-falsify/mutate-uni.mjs` (out-of-band fixtures) |

Fixtures `zz_values`, `zz_uni`, `zz_auto`, `v_broken_count` were created by writing to the
scratch `embeddings.db` **directly with better-sqlite3**, never through `ori sql`
(`node ops-falsify/mutate-db.mjs <vault>` and `node ops-falsify/mutate-uni.mjs <vault>`).
They exist to reach cases unreachable from a read-only surface: stored 64-bit integers,
multibyte text over the cell cap, a view whose row count cannot be computed, and
`sqlite_sequence` / `sqlite_stat1` / `sqlite_stat4`.

**Largest single response produced: 98,558,024 bytes (93.99 MiB)** — see F-002.

---

## F-001 — MAJOR — `BIGINT` is returned as a lossy JSON number, not a string

**Spec §6:** "`BIGINT` values are returned as strings, since JSON cannot represent them."
**Spec §2:** "`warnings` — every degradation is reported here. Silence means nothing went wrong."

Repro (no fixture needed):

```
node C:/Users/aayoa/Desktop/ori/dist/index.js sql "SELECT 9223372036854775807 AS lit"
```

Actual:

```json
{"success":true,"data":{"columns":["lit"],"rows":[[9223372036854776000]],"truncated":false,"elapsedMs":112},"warnings":[]}
```

Expected: `[["9223372036854775807"]]` (string), or at minimum a warning.
Actual value is wrong by 193. Same for a stored column:

```
node .../dist/index.js sql "SELECT label, big, typeof(big) FROM zz_values ORDER BY label"
-> [["maxint",9223372036854776000,"integer"],["negmax",-9223372036854776000,"integer"],
    ["small",42,"integer"],["unsafe+2",9007199254740992,"integer"]]
```

`9007199254740993` comes back as `...992`, `-9223372036854775808` as `-9223372036854776000`.
`typeof()` still reports `integer`, so a caller has no signal. `warnings` is `[]`.
The only way to get a correct 64-bit value out today is to `CAST(... AS TEXT)` yourself:
`SELECT CAST(big AS TEXT) FROM zz_values WHERE label='maxint'` → `"9223372036854775807"` (correct).

Ordinary integers are unaffected: `42`, `-7`, `2147483647`, `9007199254740991` all exact.
So the defect is exactly the `> 2^53-1` band the spec singled out.

---

## F-002 — MAJOR — the 4096-byte cell cap is applied in UTF-16 code units, so non-ASCII cells are returned up to 3× over the cap

**Spec §6:** "**Cell size**: text longer than 4096 bytes is truncated with a marker giving the
true byte length. … (The index stores 1.5 KB float32 vectors; returning them raw would
flood a model's context.)"

Fixture `zz_uni` holds `'日' × 4096` (4096 UTF-16 units, **12288 bytes**).

```
node .../dist/index.js sql "SELECT label, length(txt) AS chars, txt FROM zz_uni ORDER BY label"
```

Actual, measured on the returned cells:

| label | source | returned chars | **returned bytes** | marker |
|---|---|---|---|---|
| `cjk-4096` | 4096 chars / 12288 B | 4122 | **12316** | `… [truncated, 12288 bytes]` |
| `cjk-4097` | 4097 chars / 12291 B | 4122 | **12316** | `… [truncated, 12291 bytes]` |
| `emoji-even` | 5000 emoji / 20000 B | 4122 | **8220** | `… [truncated, 20000 bytes]` |
| `emoji-odd` | 5001 units / 20001 B | 4122 | **8220** | `… [truncated, 20001 bytes]` |

Expected: every returned cell ≤ 4096 bytes + marker. Actual: 12,316 bytes — 3× the cap.
The cut is made at 4096 *code units*; only the marker is computed in bytes.

Two consequences:

1. **The byte cap does not hold**, which is the entire stated purpose of the rule
   ("would flood a model's context"). Worst case measured, at the documented row cap:

   ```
   node .../dist/index.js sql "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<1000)
     SELECT i, u.txt AS a, u.txt AS b, u.txt AS d, u.txt AS e, u.txt AS f, u.txt AS g, u.txt AS h, u.txt AS k
     FROM c, zz_uni u WHERE u.label='cjk-4096'"
   ```

   → exit 0, **98,558,024 bytes (93.99 MiB)**, `"truncated":false`, `"warnings":[]`, in 1.9 s.
   Nothing in the response says the caller just received 94 MiB.

2. **The marker lies.** For `cjk-4096` the source is exactly 4096 code units, so *nothing was
   removed* — yet the cell ends in `… [truncated, 12288 bytes]` and the caller is told the
   value was cut. Truncation-marker presence is therefore not a reliable signal either way:
   absent when over the byte cap (ASCII ≤ 4096 units is fine, but see row 1 above) and
   present when complete.

Negative result for the same clause: for pure ASCII the boundary is exact — 4096 bytes is
returned untouched, 4097 bytes is cut to 4096 + `… [truncated, 4097 bytes]`, and a 6049-byte
real note description is cut to 4096 + `… [truncated, 6049 bytes]`. The rule works; the unit
is wrong.

---

## F-003 — MAJOR — mid-code-point truncation emits an unpaired surrogate into the JSON

**Spec §2** (the response is a single JSON object consumers can parse) and **§6** (truncation
is supposed to be a safe degradation).

Fixture row `emoji-odd` is `'A' + '😀'×5000`, so the 4096-code-unit cut lands between the high
and low surrogate of one emoji.

```
node .../dist/index.js sql "SELECT txt FROM zz_uni WHERE label='emoji-odd'"
```

Actual stdout ends:

```
…😀😀\ud83d… [truncated, 20001 bytes]"]],"truncated":false,"elapsedMs":89},"warnings":[]}
```

A bare `\ud83d` with no low surrogate. Expected: truncation at a code-point boundary, so the
emitted string is well-formed Unicode. JavaScript `JSON.parse` tolerates it (lone surrogate in
a JS string), but the value is not encodable UTF-8 — a strict consumer
(`python -c "json.loads(out)['data']['rows'][0][0].encode('utf-8')"`, Go, any UTF-8 validator)
fails on it. The `emoji-even` row, where the cut lands on a pair boundary, is clean, so this is
data-dependent and intermittent.

---

## F-004 — MAJOR — the CLI prints no JSON at all when the statement begins with a `--` comment

**Spec §2:** "Both print/return a single JSON object."
**Spec §3:** "Leading whitespace, `--` line comments and `/* */` block comments are skipped when
determining the first token."
**Spec §4:** "Explicitly **allowed**, and these are the interesting cases: … Comments before the
statement: `-- note` newline `SELECT 1`."

Repro (the argument is literally `-- note\nSELECT 1` with a real newline):

```
node C:/Users/aayoa/Desktop/ori/dist/index.js sql "-- note
SELECT 1"
```

Actual: stdout **empty**, stderr `error: unknown option '-- note\nSELECT 1'`, exit 1.
Expected: `{"success":true,"data":{"columns":["1"],"rows":[[1]],…},"warnings":[]}`.

The core is fine — the same SQL through stdin works (run as
`node ops-falsify/probe-detail.mjs`-style spawn with `input: "-- note\nSELECT 1"`, i.e.
`node .../dist/index.js sql --stdin` fed that text):

```
stdin = "-- note\nSELECT 1"
-> {"success":true,"data":{"columns":["1"],"rows":[[1]],"truncated":false,"elapsedMs":164},"warnings":[]}
```

So the CLI argv layer consumes any `--`-prefixed statement as an unknown flag. This also breaks
the "CLI exits non-zero when `success` is `false`" contract in the degenerate way: there is no
`success` field to correlate with, and a caller parsing stdout gets a JSON parse error.
`/* c */ SELECT 1` and `   SELECT 1` both work from argv, so only the `--` comment form is hit.

---

## F-005 — MAJOR — the empty-statement rejection path returns `data: {}`, not the documented `data` shape

**Spec §2:** `data` is `{ "columns": [...], "rows": [[...]], "truncated": false, "elapsedMs": 12 }`.
**Spec §4:** "Rejection is **not** an exception or a crash. It returns the normal JSON shape with
`success: false` and the reason in `warnings[0]`." — and the enumerated rejection list includes
"A statement that is empty, whitespace only, or only comments."

Repro:

```
node C:/Users/aayoa/Desktop/ori/dist/index.js sql ""
```

Actual:

```json
{"success":false,"data":{},"warnings":["no SQL given; pass a query or --schema"]}
```

Expected: `"data":{"columns":[],"rows":[],"truncated":false,"elapsedMs":0}` as on every other
rejection path. A consumer doing `res.data.rows.length` throws instead of seeing zero rows.

Same for `sql "   "` (whitespace only) and `sql --stdin` with empty input, and for the
missing-index `--schema` path. It is demonstrably inconsistent with sibling paths:

```
sql "/* nothing */"  -> {"success":false,"data":{"columns":[],"rows":[],"truncated":false,"elapsedMs":...},"warnings":["empty statement"]}
sql "DROP TABLE note"-> {"success":false,"data":{"columns":[],"rows":[],"truncated":false,"elapsedMs":0},"warnings":["only SELECT, WITH, EXPLAIN and VALUES are allowed; got \"DROP\""]}
```

so the block-comment-only case gets the right shape while the empty/whitespace case does not.

---

## F-006 — MINOR — `--limit` is unvalidated: 0, negative and fractional values silently drop rows and produce nonsense warnings

**Spec §6:** "**Rows**: CLI default 1000 … Exceeding the cap sets `truncated: true` and adds a
warning." No semantics are given for a non-positive or non-integer limit; silently returning
nothing for `--limit -3` is the worst available interpretation.

```
node .../dist/index.js sql --limit -3 "SELECT slug FROM v_note"
-> {"success":true,"data":{"columns":["slug"],"rows":[],"truncated":true,"elapsedMs":88},
    "warnings":["result truncated at -3 rows; add LIMIT or narrow the query"]}

node .../dist/index.js sql --limit 0 "SELECT slug FROM v_note"
-> rows:[], truncated:true, warnings:["result truncated at 0 rows; …"]

node .../dist/index.js sql --limit 1.9 "<CTE producing 3000 rows>"
-> rows: 2 rows, truncated:true, warnings:["result truncated at 1.9 rows; …"]
```

`success` is `true` and the exit code is 0 in all three, so a script that computed a bad limit
gets an empty-but-successful answer. Expected: reject the value (`success:false`) or clamp to
the default and warn, and never emit "truncated at -3 rows".

---

## F-007 — MINOR — an unparseable `--limit` is discarded with no warning

**Spec §2:** "`warnings` — every degradation is reported here. Silence means nothing went wrong."

```
node .../dist/index.js sql --limit abc "SELECT slug FROM v_note"
-> {"success":true,"data":{…651 rows…,"truncated":false,"elapsedMs":83},"warnings":[]}
```

The requested limit was ignored (default 1000 applied) and `warnings` is empty. A caller that
asked for 5 rows and typo'd the value gets 1000 with no indication.

---

## F-008 — MINOR — cell truncation is never reported in `warnings`

**Spec §2:** "`warnings` — every degradation is reported here. Silence means nothing went wrong."

```
node .../dist/index.js sql "SELECT length(description), description FROM v_note WHERE length(description) > 5000 LIMIT 1"
-> rows[0][1] ends "… [truncated, 6049 bytes]", "warnings":[]
```

A value was modified and `warnings` is silent. The in-band marker satisfies §6, so this is only
a §2 violation, but it means `warnings.length === 0` cannot be used as "data is verbatim" — and
per F-002 the marker itself is not trustworthy.
(Row truncation, by contrast, is always warned about — that part is correct.)

---

## F-009 — MINOR — non-finite doubles become `null` with no warning

**Spec §6** enumerates the value conversions (BLOB, BIGINT, NULL) and §2 requires degradations
be warned about; an overflowing double is silently indistinguishable from SQL `NULL`.

```
node .../dist/index.js sql "SELECT 1.5 AS f, 1e308*10 AS inf, 0.0/0.0 AS nan"
-> {"success":true,"data":{"columns":["f","inf","nan"],"rows":[[1.5,null,null]],…},"warnings":[]}
```

`0.0/0.0` is genuinely SQL NULL in SQLite, so that column is correct; `1e308*10` is `+Inf` and
is reported as `null`. Expected: a string (as with BIGINT) or a warning.

---

## F-010 — MINOR — `--stdin` silently wins over a positional statement

**Spec §1** documents `ori sql "<statement>" … [--stdin]` without saying which source wins.
**Spec §2** requires degradations to be warned about; here one of the two statements the caller
supplied is discarded in silence.

```
node .../dist/index.js sql --stdin "SELECT 2 AS fromarg"   # stdin: SELECT 1 AS fromstdin
-> {"success":true,"data":{"columns":["fromstdin"],"rows":[[1]],…},"warnings":[]}
```

Expected: reject the ambiguous invocation, or warn that the positional statement was ignored.

---

## F-011 — MINOR (design gap, §10 partially covers it) — the CLI process lingers up to ~35 s after answering a timed-out query

**Spec §6:** "**Time**: 2000 ms default. On timeout, `success: false`, and a warning naming the
timeout. The implementation is expected to state honestly that cancellation lands at a row
boundary, so one very long single step may still be running after the caller is answered."
**Spec §10:** "Timeout cancellation is checked between rows."

The answer itself is correct and on time. Measuring time-to-first-stdout-byte vs process exit
(`ops-falsify/probe-detail.mjs … time`):

| query | first byte | **process exit** | reported `elapsedMs` |
|---|---|---|---|
| `SELECT count(*) FROM v_note a, v_note b, v_note c` (default 2000 ms) | 2677 ms | **35368 ms** | 2007 |
| same with `--timeout 100` | 741 ms | **34109 ms** | 106 |
| `WITH RECURSIVE c(i) AS (… i<50000000) SELECT count(*) FROM c` | 2635 ms | **11957 ms** | 2019 |
| `SELECT 1` baseline | 705 ms | 726 ms | 67 |

Warning text is exactly as promised, including the honest statement:
`["SQL timed out after 2000 ms","the worker is terminated at the next row boundary, so a single
long step may still be running"]`, `success:false`, exit 1.

§10 blesses the *mechanism*, so I am **not** filing the un-cancelled step as a defect. What is
not covered is that the **CLI process does not exit** for another 33 seconds after printing its
answer: `ori sql --timeout 100 …` occupies a shell for 34 s. Any caller that waits for process
exit (every shell pipeline, `subprocess.run`, CI step) sees the timeout as ineffective. Filed as
a design gap against §6's "after the caller is answered" — for the CLI, the caller is answered
only when the process exits.

---

## F-012 — MINOR (§9, outside my sections — recorded because I hit it) — a query against a vault with no index reports the raw SQLite error instead of "run `ori index build`"

**Spec §9:** "If the index file does not exist, the call returns `success: false` with a warning
telling the caller to run `ori index build`."

In `%TEMP%\ori-falsify-contract-noidx` (vault with `notes/` and `.ori/`, no index):

```
node .../dist/index.js sql "SELECT 1"
-> {"success":false,"data":{"columns":[],"rows":[],"truncated":false,"elapsedMs":...},
    "warnings":["unable to open database file"]}

node .../dist/index.js sql --schema
-> {"success":false,"data":{},"warnings":["no index at …\\.ori\\embeddings.db; run `ori index build` (unable to open database file)"]}
```

The `--schema` path gets it right; the query path does not mention `ori index build`.
Positive: the call did **not** throw and did **not** create the file (`embeddings.db` absent
afterwards), as §9 requires. Also note the "no index at …" phrasing is emitted for *any* open
failure, not only a missing file — running the same command under Bun (where `better-sqlite3`
cannot load) produces `no index at …\embeddings.db; run 'ori index build' ('better-sqlite3' is
not yet supported in Bun…)` even though the file exists.

---

## F-013 — MAJOR — every option placed *after* the statement is silently discarded, so `--limit` and `--timeout` become no-ops

**Spec §1:** "**CLI**: `ori sql "<statement>" [--limit n] [--timeout ms] [--schema] [--stdin]`" —
the documented synopsis puts the flags **after** the statement.
**Spec §6:** "**Rows**: CLI default 1000 … Exceeding the cap sets `truncated: true` and adds a
warning." / "**Time**: 2000 ms default."
**Spec §2:** "`warnings` — every degradation is reported here. Silence means nothing went wrong."

Credit: flagged to me by `SqlSafety`, who saw `--limit` do nothing; reproduced and isolated the
mechanism here. It is not that `--limit` is broken — it is that **argument order decides whether
any flag is seen at all**, and the order the spec documents is the one that fails.

Repro, same query (20 rows), same flag, only the position differs:

```
node .../dist/index.js sql --limit 1 "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<20) SELECT x FROM c"
-> rows: 1, truncated: true, warnings: ["result truncated at 1 rows; add LIMIT or narrow the query"]

node .../dist/index.js sql "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<20) SELECT x FROM c" --limit 1
-> rows: 20, truncated: false, warnings: []          <-- flag ignored
```

Exit 0, empty stderr, no "unknown option", no warning. Verified for every option:

| invocation (statement first) | effect |
|---|---|
| `sql "<Q>" --limit 1` | ignored — 20 rows, `truncated:false`, `warnings:[]` |
| `sql "<Q>" --limit=1` | ignored — 20 rows, `truncated:false`, `warnings:[]` |
| `sql "<Q>" --timeout 1` | ignored — succeeds with 20 rows; a real 1 ms timeout would have fired |
| `sql "SELECT 1" --schema` | ignored — runs the query, returns `data.columns/rows`, not `data.tables` |
| `sql "SELECT 9 AS arg" --stdin` | ignored — runs the positional statement (`columns:["arg"]`) and never reads stdin |

Expected: the synopsis form in §1 works, or the invocation is rejected. Actual: a caller who
writes `ori sql "…" --limit 10` silently receives up to the 1000-row cap, and one who writes
`--timeout 500` silently gets 2000 ms. Both are the exact degradations §6 exists to bound, with
`warnings:[]` asserting nothing went wrong.

Note this also inverts F-010 and the "`--schema` ignores a positional statement" false positive:
with the flag first, `--schema` and `--stdin` win; with the flag last, the positional statement
wins. Precedence is decided by argv order, not by any rule.

**All `--limit` / `--timeout` / `--schema` evidence elsewhere in this file was collected with the
flag placed before the statement**, which is why the caps measured correctly there.

---

## Considered and rejected as defects (false positives)

- **Total response size is unbounded.** With pure-ASCII cells at the documented caps,
  `1000 rows × 9 columns × 4096 B` yields **32,798,024 bytes (31.28 MiB)**, exit 0,
  `truncated:false`, no warning. §6 caps only rows and per-cell bytes, so this conforms.
  Not filed — but it means the row+cell caps alone do not bound the response, and it is the
  mechanism F-002 amplifies to 94 MiB.
- **CLI honours `--limit 5000` / `--limit 100000`.** §6's clamp ("MCP default 200 with a hard cap
  of 500 — a larger `limit` is clamped") is scoped to MCP. `--limit 5000` on a 6000-row CTE
  returned exactly 5000 rows, `truncated:true`, correct warning. Conformant.
- **`SELECT count(*) FROM v_note a, v_note b, v_note c` keeps running after the timeout.**
  Explicitly §10 ("Timeout cancellation is checked between rows") and §6's honesty clause.
- **`--schema` returns `data.tables` instead of `data.columns`/`rows`.** §7 says it returns the
  object list "instead of running a query"; the payload shape is unspecified. Not a defect.
- **`--schema` ignores a positional statement** (`sql --schema "SELECT 1"` returns the schema).
  §7's "instead of running a query" reads as intended precedence — but only in that argument
  order; `sql "SELECT 1" --schema` runs the query instead (F-013).
- **"A query with no columns."** Unreachable through the allowed statement set: SQLite has no
  zero-column result set (`SELECT * FROM (SELECT 1) WHERE 0` still reports `columns:["1"]`,
  `EXPLAIN QUERY PLAN` reports 4). The only observable `columns: []` is the rejection path, and
  it is well-formed there. No defect; recorded so the gap in coverage is explicit.
- **`v_note.title` equals the slug for every note in my vault** (H1 heading not picked up;
  my unicode titles never reached the index, so `WHERE title LIKE '%日本語%'` returns 0 rows).
  That is §8 view-contract territory — handed to `SqlViews`, not filed here.

---

## Contract points that HELD (negative results = evidence)

Every item below was actively attacked and did not break. Every `--limit` / `--timeout` /
`--schema` / `--stdin` result below was obtained with the flag placed **before** the statement;
see F-013 for what happens in the argument order §1 documents.

**§2 output shape**
- Top-level keys are exactly `success`, `data`, `warnings` on every path that emitted JSON
  (45 probe cases in `probe-contract.mjs`).
- `data` keys are exactly `columns`, `rows`, `truncated`, `elapsedMs` on every query path
  (success, zero-row, truncated, SQLite error, validator rejection, timeout) — the one
  exception is F-005.
- **Rows are positional arrays, always.** Verified for single-column (`[[1]]`), NULL-bearing
  (`[null,1]`), zero-row (`[]`), 8-column self-join, 1000-row and 5000-row results.
- **Duplicate column names do not collapse.** `SELECT 1 AS x, 2 AS x` →
  `columns:["x","x"]`, `rows:[[1,2]]`. `SELECT 1 AS x, 2 AS x, 3 AS x` → `["x","x","x"]`,
  `[[1,2,3]]`. `SELECT * FROM v_link a JOIN v_link b ON 1=1` →
  `["src","src_title","dst","dst_title","src","src_title","dst","dst_title"]` with 8-element
  rows. No key-collision data loss.
- `VALUES (1,2),(3,4)` → `columns:["column1","column2"]`, 2 array rows.
- `EXPLAIN SELECT 1` → 8 columns, 5 rows, `success:true`.
- **Zero rows is `success: true`.** `SELECT slug FROM v_note WHERE slug='__nope__'` and
  `SELECT 1 WHERE 0` both `{"success":true,…,"rows":[],"truncated":false}`, exit 0.
- `elapsedMs` present and plausible on every query path (67–9016 ms observed, `0` on
  pre-execution rejection).
- Unicode literals round-trip as raw UTF-8, unescaped: `SELECT '日本語 ünïcödé 🎯'` →
  `[["日本語 ünïcödé 🎯"]]`.

**§6 rows**
- Default cap is 1000 and exact at the boundary: 1000-row CTE → 1000 rows, `truncated:false`,
  `warnings:[]`; 1001-row CTE → 1000 rows, `truncated:true`,
  `["result truncated at 1000 rows; add LIMIT or narrow the query"]`; 2000-row CTE → same.
- Real data: `SELECT src,dst FROM v_link` (1944 rows) → 1000 rows, `truncated:true`, warned.
- `--limit` boundary exact on a 651-row view: `--limit 650` → 650/`truncated:true`/warned,
  `--limit 651` → 651/`false`/no warning, `--limit 652` → 651/`false`/no warning.
- `--limit 5` on a 5-row CTE → `truncated:false`; on a 6-row CTE → `truncated:true` + warning.
  `truncated` is true **exactly** when rows were cut, in 11/11 cases.

**§6 cells / values**
- **BLOBs are never raw.** `SELECT * FROM embeddings LIMIT 2` → every vector column is
  `{"blob_bytes":1536}` / `{"blob_bytes":24}` / `{"blob_bytes":64}`; `SELECT zeroblob(1536)` →
  `{"blob_bytes":1536}`; an 8-byte stored blob → `{"blob_bytes":8}`. Whole-table dump
  `sql --limit 1000 "SELECT * FROM embeddings"` → 651 rows × 5 blob columns in **132,992 bytes**
  total, `truncated:false`, exit 0 — the ~5 MB of raw vectors never reach the caller.
- ASCII cell boundary exact: 4096 bytes verbatim, 4097 bytes → 4096 + `… [truncated, 4097 bytes]`,
  6049-byte real description → `… [truncated, 6049 bytes]`. Marker states the **true** byte length
  in every case, including the multibyte ones.
- **NULL round-trips as `null`** — literal `SELECT NULL`, a stored `TEXT` NULL, and a stored
  `BLOB` NULL all produce `null` (not `{"blob_bytes":0}`, not `""`).
- Ordinary integers untouched: `42`, `-7`, `2147483647`, `9007199254740991`, `9007199254740992`.

**§6 time**
- Default timeout fires at 2000 ms (`elapsedMs` 2007/2017/2019 across three query shapes),
  `success:false`, exit 1, `data` shape intact, and both warnings present — the first names the
  timeout, the second is the honest row-boundary statement §6 asks for.
- `--timeout` is honoured: `100` → `elapsedMs` 106/114 and "timed out after 100 ms";
  `9000` → `elapsedMs` 9016 and "timed out after 9000 ms".
- A fast query is unaffected (`SELECT 1`, 67 ms, exit 0).

**§7 schema discovery**
- `sql --schema` → `success:true`, 26 objects (6 views + 20 tables), every entry has
  `name`, `kind`, `ddl`, `doc`, `rows`; DDL is non-empty for all 26; row counts are real
  (`v_note` 651, `v_link` 1944, `note_term` 24026, `edge` 1944, `embeddings` 651).
- All six §8 views are listed as `kind:"view"` with human descriptions.
- **Undocumented objects are listed, not hidden**, marked exactly `(undocumented)`:
  `boosts`, `dangling_link`, `meta`, `note_access`, `q_history`, `stage_log`, `stage_q`, and my
  injected `zz_auto`, `zz_values`, `v_broken_count`.
- **A failing row count reports `-1` and does not fail the call.** Injected
  `CREATE VIEW v_broken_count AS SELECT * FROM no_such_table_zz` →
  `{"name":"v_broken_count","kind":"view","ddl":"CREATE VIEW …","doc":"(undocumented)","rows":-1}`
  with `success:true` and all 25 other objects still reported.
- **`sqlite_*` is excluded.** `sqlite_sequence`, `sqlite_stat1` and `sqlite_stat4` all exist as
  real tables in the fixture DB (verified out-of-band via `sqlite_master`); `--schema` lists
  none of them. Nine `sqlite_autoindex_*` indexes are also absent, correctly.
- `warnings:[]`, exit 0, 11,368 bytes.

**§2 / CLI wiring**
- **`--stdin` behaves identically to the positional form**: basic query, duplicate columns,
  zero rows, validator rejection (`DROP TABLE note` → same warning, exit 1), `--limit 3`
  (truncated + warning), and leading `--`/`/* */` comments (which argv cannot do, F-004).
  Empty stdin is rejected with `success:false`, exit 1.
- **Exit code is non-zero exactly when `success` is `false`** — 10/10 audited paths (ok, zero
  rows, truncated, validator rejection, unknown column, syntax error, timeout, `--schema`,
  empty SQL) agree. The sole break is F-004, where no JSON is printed at all.
- Exit 0 and well-formed JSON even for the 93.99 MiB response.
- A call against a vault with no index did not create `embeddings.db`.
