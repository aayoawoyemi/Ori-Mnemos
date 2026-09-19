# `ori sql` — safety & validation falsification report

**Agent:** SqlSafety · **Date:** 2026-09-19 · **Method:** black box.
The implementation (`src/core/sqlquery.ts`, `sqlquery-worker.ts`, `src/cli/sqlcmd.ts`,
the `memory_sql` / view sections of `serve.ts` / `indexstore.ts`, and their `dist/`
output) was **never opened**. Every expectation below comes from
`docs/specs/memory-sql-spec.md` §§3, 4, 5, 9 only.

**Binary under test**
```
dist/index.js        sha256 1e6507b76027e1948f3e6056a00b614229d9039f45ff2adb1b9ff563cf4c80ba
dist/cli/sqlcmd.js   sha256 ba200645bff9f6cc00af169585275752…
```
> `dist/` was rebuilt by someone else at **16:03:40** while I was probing. Every
> finding and every negative result below was **re-taken end-to-end after that
> rebuild** (`reverify-safety.mjs`, plus the full 191-probe regression). One
> earlier finding no longer reproduces and is recorded as retracted at the end.

**Scratch vault:** `C:/Users/aayoa/AppData/Local/Temp/ori-falsify-safety/vault`
(3 notes, 4 link edges, 1 dangling target; built with `ori index build`).
No command was ever run against `C:/Users/aayoa/brain`.

**≈330 probes.** Scripts beside this file:

| script | what it drives |
|---|---|
| `probe-safety.mjs` | groups `reject` `evade` `allow` `count` `length` `files` — 191 probes, raw JSONL in `rv-*.jsonl` |
| `reverify-safety.mjs` | every finding below, re-taken against the post-rebuild binary |
| `probe-parser-divergence.mjs` | 28 attempts to make the validator's lexer disagree with SQLite's |
| `probe-quoted-bypass.mjs` | banned function names behind quoted identifiers + SQL-error control group |
| `probe-options-and-readonly.mjs` | `--limit`/`--timeout` abuse, read-only-file vault, per-query byte identity |
| `probe-index-state.mjs` | spec §9 missing / zero-byte / garbage / truncated index |

---

## HEADLINE: the scratch database is byte-identical

```
baseline (immediately after `ori index build`)
  c1680743fcd4a32f2c6aa28e7a1042de99b4ebba62b2de89fe564737927adad7
final (after every probe in this report, both builds)
  c1680743fcd4a32f2c6aa28e7a1042de99b4ebba62b2de89fe564737927adad7
```

`notes/` is unchanged (3 files, original sizes). No file matching `pwned*` exists
anywhere. **No write was achieved by any attack.** Two independent per-statement
hash loops — one over 10 representative queries, one over all 28
parser-divergence payloads — report `SAME` after every single statement, and
`SELECT count(*) FROM note` still returns 3 at the end.

The only filesystem effect is F-08 below: the DB file is untouched, but two new
sidecar files appear beside it.

---

# Findings

## S-01 · MAJOR — every option placed *after* the statement is silently ignored, and the spec's own synopsis puts them there

**Spec §1:** "`ori sql "<statement>" [--limit n] [--timeout ms] [--schema] [--stdin]`"
**Spec §6:** "**Rows**: CLI default 1000 … Exceeding the cap sets `truncated: true` and adds a warning."
**Spec §7:** "`--schema` / `schema: true` returns every table and view with its DDL … **instead of running a query**."
**Spec §2:** "`warnings` — every degradation is reported here. **Silence means nothing went wrong.**"

Identical query, identical flag, only position differs:

```
$ cd <scratch vault>
$ Q='WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<20) SELECT x FROM c'

$ node dist/index.js sql --limit 1 "$Q"      # flag BEFORE
{"success":true,"data":{"columns":["x"],"rows":[[1]],"truncated":true,…},
 "warnings":["result truncated at 1 rows; add LIMIT or narrow the query"]}

$ node dist/index.js sql "$Q" --limit 1      # flag AFTER — the documented order
{"success":true,"data":{"columns":["x"],"rows":[[1],[2],…,[20]],"truncated":false,…},
 "warnings":[]}
```

**Actual** — 20 rows, `truncated: false`, `warnings: []`, exit 0, empty stderr.
**Expected** — 1 row, `truncated: true`, plus the cap warning (exactly what the
flag-first form produces).

The cap machinery is fine; the flag never reaches it. Confirmed for all four
options, every one failing silently:

| invocation | actual | expected |
|---|---|---|
| `sql "<q>" --limit 1` | 20 rows, `truncated:false`, `warnings:[]` | 1 row, truncated |
| `sql "<q>" --limit=1` | 20 rows | 1 row |
| `sql "SELECT 1" --schema` | `data.columns/rows` — the query ran | `data.tables` (§7: "instead of running a query") |
| `sql "SELECT 1" --stdin` (stdin = `SELECT 99`) | ran the positional, `rows:[[1]]`; stdin never read | run `SELECT 99` |
| `sql "<runaway>" --timeout 1` | still "timed out after **2000** ms" — the default | timeout after 1 ms |

`sql --schema "SELECT 1"` (flag first) correctly returns 23 tables, so §7
precedence itself is fine — only the ordering is broken.

The sting: **§1's synopsis shows flags after the statement**, so the documented
invocation is precisely the one that drops them. A caller asking for
`--limit 10` silently gets up to 1000 rows with `warnings: []` asserting that
nothing was degraded.

*Independently confirmed with SqlContract, who isolated the same root cause; filed
there as F-013. Recorded here because "invalid/ignored option accepted in
silence" is a validation defect and because it subsumes what I first mis-diagnosed
as two separate bugs (`--limit` dead, `--schema` ignored).*

---

## S-02 · MAJOR — a zero-byte index is reported as a healthy, empty index: `success: true`, `warnings: []`

**Spec §9:** "A malformed or truncated database yields a warning, not a crash."
**Spec §2:** "`warnings` — every degradation is reported here. Silence means nothing went wrong."

A zero-length `embeddings.db` is the normal result of an interrupted or
out-of-disk `ori index build`. SQLite opens it happily as an empty database and
nothing notices.

```
$ mkdir -p /tmp/zv/notes /tmp/zv/.ori && : > /tmp/zv/.ori/embeddings.db
$ cd /tmp/zv
$ node dist/index.js sql "SELECT 1"
{"success":true,"data":{"columns":["1"],"rows":[[1]],"truncated":false,"elapsedMs":62},"warnings":[]}
$ node dist/index.js sql --schema
{"success":true,"data":{"tables":[]},"warnings":[]}
$ node dist/index.js sql "SELECT count(*) FROM v_note"
{"success":false,…,"warnings":["no such table: v_note"]}
```

**Actual** — exit 0, `success: true`, `warnings: []` on the first two.
**Expected** — a warning that the index is truncated/unusable, per §9.

`{"success":true,"data":{"tables":[]},"warnings":[]}` is indistinguishable from a
real but empty vault. An MCP client calling `memory_sql {schema:true}` will
correctly conclude "this vault has no data" when the truth is "your index is
destroyed, rebuild it". The only signal that leaks through — `no such table:
v_note` — carries no path and no hint to run `ori index build`.

The surface *does* distinguish absent from present-but-empty, and gets the second
one wrong: the missing-file case is handled correctly (see negative results).

---

## S-03 · MAJOR — `ori sql` never exits after a runaway query; only the JSON is delivered

**Spec §6:** "On timeout, `success: false`, and a warning naming the timeout."
**Spec §10 (declared non-defect):** "Timeout cancellation is checked between rows… one very long single step may still be running **after the caller is answered**."

The JSON half is right. The process half is not: stdout is written at ~2018 ms,
then the process never terminates.

```
$ cd <scratch vault>
$ timeout --foreground -s KILL 30 node dist/index.js sql \
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c"
{"success":false,"data":{…,"elapsedMs":2018},
 "warnings":["SQL timed out after 2000 ms",
             "the worker is terminated at the next row boundary, so a single long step may still be running"]}
(no exit; killed at 30 s, rc=124)
```

**Actual** — process hangs indefinitely after printing correct JSON. **4/4 on the
current build** (three 15 s kills + one 30 s kill), plus once with
`--timeout 1`.
**Expected** — exits non-zero shortly after emitting the JSON.

I considered and rejected treating this as a §10 false positive. §10 licenses the
*worker* outliving the answer; it does not license the *process* outliving it —
"after the caller is answered" presumes control returns. As shipped, this hangs
any shell, script or CI step that invokes it, and spins a core forever.

A bounded recursive CTE (`… WHERE x < 5`) returns and exits normally, so the hang
is specific to the cancellation path. One informative data point: `--timeout abc`
(NaN) **does** exit, in 1808 ms — so the process can terminate on this path; the
normal-timeout case is what fails to.

---

## S-04 · MAJOR — banned function names pass validation when written as quoted identifiers

**Spec §4, list of rejected things:** "`load_extension`, `writefile`, `readfile`."

The validator exempts anything inside `"…"`, `[…]` or `` `…` ``. That exemption is
required for the §4 must-allow cases — but it also applies in *function-call
position*, where SQLite resolves a quoted identifier as the function name. The
documented rejection therefore never happens; the call reaches the engine.

```
$ cd <scratch vault>
$ node dist/index.js sql "SELECT load_extension('x')"        # unquoted — correct
{"success":false,…,"warnings":["\"load_extension\" is not allowed in a read-only query"]}

$ node dist/index.js sql "SELECT \"load_extension\"('x')"    # BYPASS
{"success":false,…,"warnings":["not authorized"]}
$ node dist/index.js sql "SELECT [load_extension]('x')"      # BYPASS
{"success":false,…,"warnings":["not authorized"]}
$ node dist/index.js sql 'SELECT `load_extension`(:x)'       # BYPASS
{"success":false,…,"warnings":["not authorized"]}

$ node dist/index.js sql "SELECT \"readfile\"('…/package.json')"
{"success":false,…,"warnings":["no such function: readfile"]}
$ node dist/index.js sql "SELECT \"writefile\"('pwned.txt','x')"
{"success":false,…,"warnings":["no such function: writefile"]}
```

**Actual** — validator passes it; SQLite rejects it, with a different message.
**Expected** — `"load_extension" is not allowed in a read-only query`, as the
unquoted forms produce.

Proof this is quoting-specific, not a general hole — all of these *are* caught:
`load_extension('…')`, `LOAD_EXTENSION('foo')`, `load_extension/**/('x')`,
`readfile ('…')` (space before paren), and
`WITH x AS (SELECT readfile('…') AS b) SELECT b FROM x`.

**Weighing §10.** §10 says "The validator is a parser and parsers can be wrong;
it exists for good error messages. The read-only connection is the actual
guarantee." That mitigation is real and is why this is major rather than
critical — nothing escaped. But the evidence shows an asymmetry worth naming:
`readfile`/`writefile` are simply not compiled in, whereas **`load_extension` is a
live function in this build** and was stopped by a SQLite authorizer returning
`not authorized`. For that one name the validator is not redundant
belt-and-braces; it is the outer of exactly two layers, and it is open.

No file named `pwned*` was created anywhere, by any of these.

---

## S-05 · MAJOR — outside any vault, `ori sql` silently queries a different database

**Spec §1:** "A read-only SQL surface over the memory index at `<vault>/.ori/embeddings.db`."
(Testing notes: "A vault is a directory containing `notes/` and a `.ori/` directory".)
**Spec §2:** "Silence means nothing went wrong."

In a directory that is not a vault and has no vault ancestor, the call does not
fail — it opens someone else's index and answers `success: true`.

```
$ mkdir -p /tmp/notavault/notes        # notes/ but NO .ori/ ; no vault ancestor
$ cd /tmp/notavault
$ node dist/index.js sql "SELECT 1"
{"success":true,"data":{"columns":["1"],"rows":[[1]],"truncated":false,"elapsedMs":73},"warnings":[]}
exit 0

$ node dist/index.js sql "SELECT count(*) FROM v_note"
{"success":false,…,"warnings":["no such table: v_note"]}
```

A database really was opened — a nonexistent one gives `unable to open database
file`, and a genuinely missing index gives the `run \`ori index build\`` message
(both verified below). An earlier run of this scenario echoed the resolved path
back in the `--schema` warning: ``no index at C:\Users\aayoa\.ori\embeddings.db;
run `ori index build` `` — i.e. the resolver falls back to a home-directory
index. I stopped probing at that point rather than issue further reads against a
non-scratch path.

**Actual** — silent success against an unrelated vault's index, `warnings: []`.
**Expected** — `success: false` with a warning that the cwd is not inside a vault.

This is the finding with real blast radius: an agent or script launched from the
wrong cwd gets plausible-looking answers computed from a *different* vault, with
`warnings: []` asserting nothing went wrong.

Ordinary upward resolution is correct and I verified it separately in scratch —
from `outer/sub/deeper` (a plain directory beneath a real vault) the surface
resolves to `outer/.ori/embeddings.db`, confirmed via
`SELECT file FROM pragma_database_list`. The defect is only the final fallback
when *no* ancestor is a vault.

---

## S-06 · MINOR — `--limit 0` and `--limit -1` return one row; `--limit abc` silently means "no limit"

**Spec §6:** "**Rows**: CLI default 1000 … Exceeding the cap sets `truncated: true` and adds a warning."
**Spec §2:** "Silence means nothing went wrong."

With the flag in the position that actually works (before the statement), on a
20-row query:

| flag | rows | truncated | warnings | expected |
|---|---|---|---|---|
| `--limit 1` | 1 | `true` | cap warning | correct |
| `--limit 0` | **1** | `true` | cap warning | 0 rows, or rejected |
| `--limit -1` | **1** | `true` | cap warning | rejected |
| `--limit abc` | **20** | `false` | **`[]`** | rejected, or defaulted *with a warning* |

```
$ node dist/index.js sql --limit 0 "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<20) SELECT x FROM c"
{"success":true,"data":{"columns":["x"],"rows":[[1]],"truncated":true,…},"warnings":["result truncated at 1 rows; …"]}
```

Nonsense limits are clamped to 1 instead of being refused, and a non-numeric
limit disables the cap entirely without a word. The `abc` row is the one that
matters: a typo'd limit silently returns far more data than asked for, and the
warning array that is supposed to report every degradation is empty.

---

## S-07 · MINOR — `--timeout abc` produces the warning "SQL timed out after NaN ms"

**Spec §6:** "On timeout, `success: false`, and a warning **naming the timeout**."

```
$ node dist/index.js sql --timeout abc "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c"
{"success":false,…,"warnings":["SQL timed out after NaN ms",
  "the worker is terminated at the next row boundary, so a single long step may still be running"]}
```

**Actual** — `NaN` leaks into the user-facing warning.
**Expected** — the bad value refused, or the default substituted and named.

`--timeout -5` and `--timeout 0` are likewise accepted in silence. (Curiously
this is the one runaway case that *does* exit, in 1808 ms — see S-03.)

---

## S-08 · MINOR — a read-only query creates `-wal` and `-shm` files next to the index

**Spec §5:** "No statement may modify the database, **create or drop anything**, or reach a file outside the index."

```
$ ls .ori
embeddings.db                                   # pristine copy, nothing else
$ node dist/index.js sql "SELECT 1"
{"success":true,…,"warnings":[]}
$ ls .ori
embeddings.db  embeddings.db-shm (32768 B)  embeddings.db-wal (0 B)
```

**Actual** — two new files in `.ori/`, still there after the process exits.
**Expected** — no filesystem mutation from a read-only surface.

The index file's sha256 is unchanged, so this is minor rather than data loss. It
is reported because §5's wording is "create … anything", because a single trivial
`SELECT 1` triggers it, and because it also fires while *failing* on a corrupt
index (the truncated-db scenario creates both sidecars on the way to an error).
It also implies `ori sql` needs a writable `.ori/` directory. Confirmed the
surface still works when the db *file* is read-only (`attrib +R`):
`SELECT count(*) FROM v_note` returned 3, hash unchanged — consistent with a
genuine read-only open — but the sidecars were created anyway.

§9's related requirement is met: in the missing-index case nothing is created
(`NEW FILES: []`).

---

## S-09 · MINOR — "the reason names the offending token" fails when the token is not ASCII-delimited

**Spec §4:** "Any statement whose first token is not in the allowed set … **The reason names the offending token.**"

All correctly **rejected**; the message quotes back the whole statement as if it
were one token:

| input | warning |
|---|---|
| `\u200bDROP TABLE note` (ZWSP prefix) | `… got "​DROP TABLE note"` |
| `ＳＥＬＥＣＴ 1` (fullwidth) | `… got "ＳＥＬＥＣＴ 1"` |
| `\u0085DROP TABLE note` (NEL) | `… got "DROP TABLE note"` |
| `\u0000DROP TABLE note` (NUL, via `--stdin`) | `… got "\u0000DROP TABLE note"` |
| `;SELECT 1` | `… got ";SELECT 1"` |

Message quality only. Worth fixing because the NUL case emits a raw control
character into JSON.

---

## S-10 · MINOR — the 2000 ms budget includes process/worker start-up

Observed while probes ran concurrently: `SELECT "writefile"('x','y')` — ~90 ms
idle — returned `["SQL timed out after 2000 ms"]`. Re-run three times in
isolation it correctly gives `["no such function: writefile"]` in 94–1072 ms
(1072 ms cold, then ~95 ms warm).

**Spec §6** frames 2000 ms as a budget for the *SQL*. Charging worker spin-up to
it means a loaded machine reports a fabricated timeout for a statement that never
ran — and cold start alone eats over half the default budget (`elapsedMs: 1072`
for a query that fails at prepare time).

---

## Retracted — leading `--` line comment rejected by the CLI option parser

On the **pre-16:03 build** this reproduced consistently:

```
$ node dist/index.js sql "$(printf -- '-- note\nSELECT 1')"
stderr: error: unknown option '-- note\nSELECT 1'
exit 1, no stdout
```

That is spec §4's own must-allow example ("Comments before the statement: `-- note`
newline `SELECT 1`") being refused, *and* refused as a bare stderr string instead
of the documented `success:false` + `warnings[0]` JSON. It was also visible in the
first `evade` run as `error: unknown option '-- harmless\nDROP TABLE note'`.

**It does not reproduce on the current build** — 5/5 runs return
`{"success":true,…,"rows":[[1]]}`, including `sql --limit 5 "-- note\nSELECT 1"`,
and `sql "-- x\nDROP TABLE note"` is correctly refused with `got "DROP"`. Either
the rebuild fixed it or it was build-specific. Recorded, not counted.

---

# Attacks that correctly failed — the safety evidence

The larger half of the result. **191-probe regression re-run on the final build:
0 non-JSON responses, 0 stack traces, 0 false rejections.**

```
reject : 26 probes — 26 rejected,  0 accepted
evade  : 58 probes — 49 rejected,  9 accepted (all benign controls, listed below)
allow  : 64 probes —  0 rejected, 64 accepted
count  : 14 probes —  4 rejected, 10 accepted
length :  8 probes —  5 rejected,  3 accepted
files  : 21 probes — 17 rejected,  4 accepted (all benign reads)
problems: 0
```

### Every rejected statement type (26/26)

`ATTACH`, `DETACH`, `PRAGMA table_info(note)`, `PRAGMA query_only = 0`,
`PRAGMA journal_mode = DELETE`, `INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`,
`ALTER`, `VACUUM`, `BEGIN`, `BEGIN IMMEDIATE TRANSACTION`, `COMMIT`, `ROLLBACK`,
`REINDEX`, `REPLACE`, `SAVEPOINT`, `RELEASE`, `ANALYZE`, `CREATE TEMP TABLE`,
`CREATE VIEW`, `CREATE TRIGGER`, lower-case `insert`, mixed-case `UpDaTe`.

Each returns exit 1 and exactly the documented shape:
```json
{"success":false,"data":{"columns":[],"rows":[],"truncated":false,"elapsedMs":0},
 "warnings":["only SELECT, WITH, EXPLAIN and VALUES are allowed; got \"<TOKEN>\""]}
```
Both read and write forms of `PRAGMA` are refused. The offending token is named
and its case preserved. **stderr empty in all 26; no stack trace anywhere.**

### Evasion (58 probes — the 49 hostile ones all refused)

- **Comments hiding the verb** — `/* harmless */ DROP TABLE note`,
  `-- harmless\nDROP TABLE note`, `/* /* */ DROP TABLE note` → all name `DROP`.
  The validator correctly does **not** treat block comments as nestable, which is
  the direction that would have been exploitable.
- **CTE prefix** — `WITH x AS (SELECT 1) INSERT …` / `DELETE` / `UPDATE` →
  `"insert"/"delete"/"update" is not allowed in a read-only query`. §4's example
  handled exactly as written.
- **After a `SELECT`** — `SELECT 1; DROP TABLE note`, `SELECT 1; DELETE FROM note`,
  `SELECT (SELECT 1); DROP …`, `SELECT 1 UNION SELECT 2; DELETE …`,
  `VALUES (1); DROP …`, `SELECT 'safe'; DROP …`, `SELECT 1 /* x */ ; DROP …`,
  `SELECT '/*' ; DROP …` → `single statement only`.
- **Without a semicolon** — `SELECT 1\nINSERT INTO note …` → caught by the
  anywhere-keyword rule rather than statement counting.
- **`EXPLAIN` as a laundering prefix** — `EXPLAIN DELETE FROM note`,
  `EXPLAIN INSERT …`, `EXPLAIN DROP TABLE note`, `EXPLAIN QUERY PLAN DELETE …`
  → all refused. The subtle one, and it is right: `EXPLAIN` is an allowed first
  token, so a first-token-only validator would have passed these.
- **Keyword split by a comment** — `DROP/**/TABLE note` → names `DROP`;
  `DR/**/OP TABLE note` → names `DR`. Neither reassembles into an executed verb.
- **Whitespace exotica before a verb** — tab, vertical tab, form feed, CR/LF,
  NBSP `\u00a0`, line separator `\u2028`, ideographic space `\u3000`, ZWSP
  `\u200b`, BOM `\ufeff`, NEL `\u0085`, figure space `\u2007`, NUL `\u0000`, and
  tab/newline/CRLF *inside* `DROP TABLE note` → **every one rejected.**
- **Homoglyph / case-folding first tokens** — fullwidth `ＳＥＬＥＣＴ 1`,
  Kelvin-sign `SELE\u212aT 1`, dotless-ı `W\u0131TH …`, dotted-İ
  `W\u0130TH … \u0130NSERT …` → all rejected. No Unicode case-folding hole.
- **Unterminated literals** — `SELECT 'abc`, `SELECT 1 /* abc`,
  `SELECT 1 /* x */ /* DROP TABLE note`, `SELECT x'41; DROP …`, `SELECT [a; DROP …`,
  ``SELECT `a; DROP …`` → `unterminated string or comment`.
- **Empty-ish input** — `""` / whitespace-only → `no SQL given; pass a query or
  --schema`; `-- nothing here` and `/* nothing */` → `empty statement`; `;` and
  `;SELECT 1` → rejected.
- **Double-quoted keyword as an expression** — `SELECT "DROP TABLE note"` reaches
  SQLite and errors cleanly with `no such column: … - should this be a string
  literal in single-quotes?`. No execution.

The 9 accepted `evade` probes are all benign controls that **must** pass, and each
returns `[[1]]`: `sElEcT 1`, `SELECT/**/1`, and the leading-whitespace forms
`\tSELECT 1`, `\u000bSELECT 1`, `\fSELECT 1`, `\r\nSELECT 1`, `\u00a0SELECT 1`,
`\ufeffSELECT 1`, plus `/* a /* b */ SELECT 1`. So the whitespace handling is
discriminating rather than blanket-paranoid — the same character class that is
stripped before `SELECT` does not smuggle a `DROP` through.

### Parser-divergence hunt (28 payloads — zero divergence, DB hash `SAME` after every one)

Premise: find a lexer disagreement where the validator thinks a keyword sits
inside a literal while SQLite sees a second, executable statement.

- **Backslash escapes** (the MySQL-vs-SQLite classic) —
  `SELECT 'a\'; DROP TABLE note --'`, its `\\` variant, the double-quoted
  variant, and an `INSERT` version → all `single statement only`. The validator
  does **not** honour `\` as an escape, matching SQLite.
- **Dialect quoting SQLite lacks** — `$$a$$`, `E'a\'…'`, `N'a'` → `single
  statement only`.
- **Escaped closing delimiters** — `SELECT [a]]; DROP …`,
  ``SELECT `a``; DROP …``, `SELECT "a""; DROP …`, `SELECT 1 AS "it''s"; DROP …`
  → rejected, or a clean `no such column`.
- **Comment-terminator tricks** — `--x\rDROP TABLE note`, `--x\u2028DROP …`,
  `--x\u0085DROP …` correctly treated as one comment by both lexers (result
  `[[1]]`); `/* a /* b */ DROP TABLE note` names `DROP`;
  `SELECT 1 /** ; DROP TABLE note **/` and `SELECT 1/*;DROP TABLE note*/` → `[[1]]`.
- **Semicolon accounting** — `SELECT 1;\u0000DROP …`, `SELECT 1; /* x */ DROP …`,
  `SELECT 1; -- x\nDROP …` → `single statement only`.

Afterwards `SELECT count(*) FROM note` still returns 3 and the hash is baseline.

### Must-allow cases — 64/64 accepted, **zero false rejections**

The likeliest place to find a usability defect, and there is none.

- Forbidden words inside string literals: `SELECT 'DROP TABLE note'`,
  `'INSERT INTO note VALUES(1)'`, `'ATTACH DATABASE x AS y'`,
  `'PRAGMA query_only=0'`, `'readfile'`, `'load_extension'`.
- Escaped quotes: `SELECT 'it''s fine'` → `it's fine`; `'it''s a DROP TABLE'`;
  `SELECT ''''` → `'`.
- Literals containing separators: `'a;b'`, `'a--b'`, `'a/*b'`,
  `'a; DROP TABLE note'`, `'/*'`, unicode `'é你好🚀 DROP'`, `'DROP' || ' TABLE'`.
- The two names §4 calls out: `SELECT created FROM v_note` → `2026-09-19`;
  `SELECT update_count FROM (SELECT 1 AS update_count)` → `1`; plus
  `SELECT 1 AS created`, `SELECT q_updates FROM v_note`,
  `SELECT access_count, created FROM v_note`.
- 18 further keyword-substring identifiers, none tripping a rule: `deleted_at`,
  `insertion_order`, `dropoff_rate`, `vacuumed`, `begin_date`, `truncated`,
  `alter_ego`, `attachment_id`, `replaces`, `beginning`, `commits`, `analyzed`,
  `reindexed`, `savepoints`, `detached`, `pragmatic`, `readfiles`,
  `load_extensions_count`.
- Quoted identifiers *containing* keywords, all three styles:
  `SELECT "drop" FROM (SELECT 1 AS "drop")`,
  `SELECT [delete] FROM (SELECT 1 AS [delete])`,
  ``SELECT `insert` FROM (SELECT 1 AS `insert`)``, `SELECT 1 AS "create table"`,
  `SELECT * FROM (SELECT 1) AS "insert into"`, `SELECT 1 AS "a;b"`.
- Comments: `/* note */ SELECT 1`, `SELECT 1 -- trailing`, `SELECT 1 /* trailing */`,
  `SELECT 1 -- we never insert here`, `/* do not delete this query */ SELECT 1`,
  `SELECT /* update the cache */ 1`, and `-- note\nSELECT 1`.
- Statement forms: `WITH … SELECT`, bounded `WITH RECURSIVE`, `VALUES (1),(2)`,
  `EXPLAIN SELECT 1`, `EXPLAIN QUERY PLAN SELECT * FROM v_note`,
  `SELECT name FROM sqlite_master UNION SELECT 1`, `SELECT x'00ff'`
  (→ `{"blob_bytes":2}`, per §6), `SELECT name FROM pragma_table_info('v_note')`,
  `WHERE title LIKE '%drop%'`, `WHERE 'a;b' GLOB '*;*'`.

### Statement counting (14 probes, all correct)

| input | result |
|---|---|
| `SELECT 1;` | accepted |
| `SELECT 1; ` (trailing space) | accepted |
| `SELECT 1;\n\t  \r\n` (trailing whitespace) | accepted |
| `SELECT 1;;` · `SELECT 1; ;` · `SELECT 1;;;;` · `SELECT 1;   ;` | `single statement only` |
| `SELECT 1; SELECT 2` (and with trailing `;`) | `single statement only` |
| `SELECT 'a;b' AS v` | accepted, value `a;b` — **semicolon in a literal is not a separator** |
| `SELECT 'a;b';` | accepted |
| `SELECT 1 AS "a;b"` | accepted |
| `SELECT 1 /* ; */` · `SELECT 1 -- ;` | accepted |
| `SELECT 1; -- done` · `SELECT 1; /* done */` | accepted |

The last row is a liberal reading of §3's "Anything after it is not", but a
comment is not a statement and rejecting it would be hostile.
**False-positive-considered**, not a defect.

### 16 KiB cap — boundary exact

| SQL byte length | result |
|---|---|
| 16 000 · 16 383 | accepted |
| **16 384** | **accepted** (cap inclusive) |
| **16 385** | `sql exceeds 16384 bytes` |
| 16 400 · 20 000 | `sql exceeds 16384 bytes` |
| 200 000 (via `--stdin`) | `sql exceeds 16384 bytes` |
| 40 KiB block comment + `SELECT 1` (via `--stdin`) | `sql exceeds 16384 bytes` |

Exactly 16384 bytes, correct in both directions, and applied to raw input before
comment stripping — a comment bomb cannot get past it.

### Reaching a file outside the index — no path found

- `readfile` / `writefile` / `load_extension` unquoted, upper-case,
  space-before-paren, comment-before-paren, inside a CTE → all
  `"<name>" is not allowed in a read-only query`.
- `edit('x')` → `"edit" is not allowed in a read-only query`.
- `fsdir(…)`, `zipfile(…)`, `sqlite_dbpage` → `no such table: …`; extensions not loaded.
- `ATTACH` by every route tried: as a statement, `SELECT 1 FROM (ATTACH …)`,
  `WITH x AS (SELECT 1) ATTACH …` → `"attach" is not allowed in a read-only
  query`; `SELECT 1; ATTACH …` → `single statement only`.
- `PRAGMA query_only = 0` and `PRAGMA journal_mode = DELETE` → refused as `PRAGMA`.
- `SELECT * FROM pragma_database_list` is **allowed** and shows exactly one
  attachment, `main`, pointing at this vault's `embeddings.db`. Nothing is ever
  attached. Allowing it is consistent with §4's substring-of-identifier rule; it
  discloses the absolute index path, acceptable for a local CLI —
  **false-positive-considered**.
- `--limit`/`--timeout` SQL injection: `--limit "1; DROP TABLE note"`,
  `--limit "1) ; DROP TABLE note --"`, `--limit "1 UNION SELECT 1"`,
  `--timeout "1; DROP TABLE note"` → no injection, query runs normally, hash
  unchanged.
- No `pwned-dq.txt` / `pwned-by-sql.txt` / `pwned-abs.txt` / `pwned-reverify.txt`
  anywhere; the vault contains only `.ori/` and `notes/`.

### Missing index (§9) — correct

```
$ mkdir -p /tmp/v/notes /tmp/v/.ori          # vault, no embeddings.db
$ cd /tmp/v && node dist/index.js sql "SELECT 1"
{"success":false,"data":{"columns":[],"rows":[],"truncated":false,"elapsedMs":0},
 "warnings":["no index at …\\.ori\\embeddings.db; run `ori index build`"]}
```
Same correct, path-bearing, actionable warning from `SELECT count(*) FROM v_note`
and from `--schema`. Exit 1, valid JSON, no exception, and **`NEW FILES: []` —
the index file is not created**, exactly as §9 requires.

### Malformed index (§9) — warning, not a crash

| scenario | `SELECT 1` | `--schema` |
|---|---|---|
| 4 KiB random bytes | `file is not a database` | `no index at …; run \`ori index build\` (file is not a database)` |
| plain text file | `file is not a database` | `… (file is not a database)` |
| first 3000 B of a real index | `database disk image is malformed` | `… (database disk image is malformed)` |
| valid SQLite header, no content | `database disk image is malformed` | `… (database disk image is malformed)` |

All valid JSON, exit 1, empty stderr, no stack trace. §9 satisfied. Two nits not
worth separate findings: `--schema` says "no index at <path>" for a file that
plainly exists (the truth is in the parenthetical), and the query path returns the
bare driver string with no path and no rebuild hint while `--schema` gives an
actionable one — the two paths should agree.

### Read-only at the driver level (§5)

With the index file marked read-only (`attrib +R`), `SELECT count(*) FROM v_note`
still returns 3 and `--schema` still works, hash unchanged — the behaviour of a
genuine read-only open, not a read-write one. Combined with `not authorized` from
`"load_extension"(…)`, there is observable evidence of both a read-only
connection and a SQLite authorizer sitting behind the validator.

### Anomalies investigated and dismissed (false-positive-considered)

- **`SELECT "writefile"(…)` reported a 2000 ms timeout** during the parallel probe
  run. Re-run 3× isolated: `no such function: writefile` in 94–1072 ms. Load
  artifact; the underlying budget issue is recorded as S-10 instead.
- **`` SELECT `readfile`(…) `` hung 20 s with no output** in the same loaded run.
  Re-run 3× isolated: `no such function: readfile` in 60–77 ms. Load artifact,
  not a hang. (The real hang, S-03, reproduces 4/4 idle on a different path.)
- **One early run gave `unable to open database file` instead of the
  `run \`ori index build\`` message** for a vault with an empty `.ori/`. Not
  reproducible; the same directory now returns the correct message every time.
  Excluded.
- **My first harness run reported `'better-sqlite3' is not yet supported in Bun`
  for every scenario.** My bug: the eval kernel's `process.execPath` is Bun, not
  Node. Everything was re-run against `C:\Program Files\nodejs\node.exe`. Noted so
  the raw artifacts are not misread — and worth one product observation: when the
  driver fails to load, the failure still surfaces as a clean `success:false` plus
  warning rather than a crash.

---

# Summary

| id | severity | one line |
|---|---|---|
| S-01 | major | options placed after the statement are silently dropped — and §1's synopsis puts them there |
| S-02 | major | zero-byte index → `success:true`, `warnings:[]`, `--schema` reports a healthy empty vault |
| S-03 | major | runaway query prints correct JSON then never exits; hangs the caller forever |
| S-04 | major | `"readfile"` / `[load_extension]` / `` `load_extension` `` bypass the validator (engine still blocks) |
| S-05 | major | outside any vault, silently queries a home-directory index with `warnings:[]` |
| S-06 | minor | `--limit 0` / `-1` return 1 row; `--limit abc` silently disables the cap |
| S-07 | minor | `--timeout abc` → warning reads "SQL timed out after NaN ms" |
| S-08 | minor | `SELECT 1` creates `embeddings.db-wal` / `-shm` in `.ori/` |
| S-09 | minor | "offending token" is the whole statement for non-ASCII-delimited input |
| S-10 | minor | 2000 ms budget includes cold start (~1 s), causing fabricated timeouts under load |
| — | retracted | leading `--` comment rejected by the option parser; real pre-16:03, gone on the current build |

**Nothing achieved a write.** 26/26 statement types refused, 49/49 hostile evasion
probes refused, 28/28 parser-divergence payloads refused, 64/64 must-allow cases
accepted with **zero false rejections**, 16 KiB boundary exact, no file reached
outside the index, no crash and no stack trace in 191 regression probes, and the
scratch database is byte-for-byte identical to its baseline
(`c1680743fcd4a32f2c6aa28e7a1042de99b4ebba62b2de89fe564737927adad7`).

The core safety claim of §5 held under everything I could throw at it. The defects
are in the layers around it: CLI argument handling (S-01, S-06, S-07),
index-state reporting (S-02, S-05), process lifetime (S-03), and one genuine
validator hole that the engine happened to cover (S-04).
