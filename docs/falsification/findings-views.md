# Findings — `ori sql` views (§8) and the fresh-vault guarantee

Black-box run. Only `docs/specs/memory-sql-spec.md` was read; `src/core/sqlquery*.ts`,
`src/cli/sqlcmd.ts`, and the view-creation code were never opened. Views were discovered
through `ori sql --schema` and by querying them.

Binary under test: `C:/Users/aayoa/Desktop/ori/dist/index.js` (`ori-memory` 0.7.0).
All vaults are scratch vaults under `%TEMP%/ori-fv/`. `C:/Users/aayoa/brain` was never touched.

Probe scripts live alongside this file:

| script | purpose |
|---|---|
| `mkvault-views.mjs` | builds the 10-note vault with the exact authored link graph (v1) |
| `mkvault-adversarial.mjs` | duplicate edges, self-link, H1/frontmatter title stress (v2) |
| `mkvault-titles.mjs` | unicode / quote / long / punctuated filenames, case-folded and aliased links, 25-way dangling citation (v3) |
| `fresh-vault-check.mjs` | fresh-vault guarantee: one `index build`, then `SELECT *` from all six views (v4, v5) |
| `probe.mjs` + `probes-*.json` | generic SQL probe runner and probe sets |
| `stale-view.mjs` | rewrites `v_note` to a legacy definition to test view refresh on re-index |
| `mcp-client.mjs`, `mcp-multi.mjs`, `mcp-multi-slow.mjs` | MCP stdio driver — `transport` classification and per-session aggregates |
| `schema-v1.json` | captured `ori sql --schema` output |

---

## Summary

| # | severity | finding |
|---|---|---|
| 1 | **major** | `index build` crashes with an uncaught `pagerank: failed to converge` on a vault with zero notes; no views are created and `v_note` then fails with `no such table` — the exact failure §8 names as a defect |
| 2 | **major** | after a note is deleted or renamed, a plain `index build` leaves `v_dangling` silently incomplete; the affected wiki-links disappear from *both* `v_link` and `v_dangling`, while `ori query dangling` on the same index still reports them |
| 3 | **major** | `v_retrieval` is not "one row per note returned by a query" on the MCP path: 11 rows logged for a 3-result query, the same note appearing twice, and `rank` is 0-based there but 1-based on the CLI path |
| 4 | **major** | `v_session.queries` counts *distinct query text*, not queries; two identical queries 3 s apart in one session report `queries = 1` |
| 5 | minor | `v_note.modified` is rendered in UTC while `v_note.created` is a local date; a note touched at 23:30 local reports `modified = 2026-09-20 04:30:00`, a day ahead |
| 6 | minor | `v_note.outbound` / `v_link` count *distinct resolving targets*, not wiki-links: a note with two `[[x]]` links and two `[[ghost]]` links reports `outbound = 1` |
| 7 | minor | `v_note` exposes an undocumented `id` (the physical note key the views exist to hide); `NATURAL JOIN v_note … v_link` silently cross-joins, `v_stage NATURAL JOIN v_retrieval` fans out on `timestamp` |
| 8 | minor | `v_dangling.cited_by` is an unordered `' | '`-joined string with no escaping, truncated at 4096 bytes with no warning |
| 9 | minor | `v_stage.decision` is always `'run'`; two `q_reranking` rows carry `decision='run'` with NULL `quality_before`/`quality_after`/`compute_time_ms`/`reward` |
| 10 | minor | `v_note.title` is byte-identical to `slug` in every row (698 notes across four vaults, plus an independent 651-note run); `v_link.src_title`/`dst_title` inherit it, so four documented columns carry no information and a note's authored prose title is unreachable |
| 11 | minor | `v_dangling.target` reports the slugified link text (`related-note`), not what the author wrote (`[[related note]]`) — the named "missing target" is a string that appears nowhere in the vault |
| 12 | false-positive-considered | pagerank mass leaks (sums to 0.921, not 1) and a disconnected mutual pair outranks the most-cited note — surprising, but §8 only requires non-NULL |
| 13 | false-positive-considered | `exp-…` exploration session ids would classify as `mcp`, but exploration writes no `retrieval_log` rows, so no such row exists |
| 14 | false-positive-considered | "title-form `[[wiki links]]` do not resolve" — refuted; all three title-form links resolved in vault v10. See Addendum. |

---

## The authored link graph (vault v1)

Built by `mkvault-views.mjs`. 10 notes, flat `notes/`, one missing target cited twice.
`[[…]]` edges as authored:

```
alpha   -> beta, gamma
beta    -> gamma
gamma   -> (none)
delta   -> alpha, nonexistent-target      <- dangling
epsilon -> nonexistent-target             <- dangling
zeta    -> alpha
eta     -> theta
theta   -> eta
iota    -> (none)
kappa   -> alpha, beta, gamma, delta
```

Contains the requested `A->B, A->C, B->C` triangle as `alpha->beta, alpha->gamma, beta->gamma`.

Build: `node dist/index.js index build` → `"edges":11,"dangling":2`.

### Expected vs observed `v_note.inbound` / `outbound`

```
node dist/index.js sql "SELECT n.slug, n.inbound, (SELECT COUNT(*) FROM v_link l WHERE l.dst=n.slug) AS link_in, n.outbound, (SELECT COUNT(*) FROM v_link l WHERE l.src=n.slug) AS link_out FROM v_note n ORDER BY n.slug"
```

| slug | expected in | observed in | expected out (resolving) | observed out |
|---|---|---|---|---|
| alpha | 3 (delta, zeta, kappa) | **3** | 2 | **2** |
| beta | 2 (alpha, kappa) | **2** | 1 | **1** |
| delta | 1 (kappa) | **1** | 1 (+1 dangling) | **1** |
| epsilon | 0 | **0** | 0 (+1 dangling) | **0** |
| eta | 1 (theta) | **1** | 1 | **1** |
| gamma | 3 (alpha, beta, kappa) | **3** | 0 | **0** |
| iota | 0 | **0** | 0 | **0** |
| kappa | 0 | **0** | 4 | **4** |
| theta | 1 (eta) | **1** | 1 | **1** |
| zeta | 0 | **0** | 1 | **1** |

Every value matches, and `inbound`/`outbound` agree exactly with a self-join over `v_link`.
`v_link` contained exactly the 11 resolving edges and zero dangling rows:

```
node dist/index.js sql "SELECT COUNT(*) FROM v_link WHERE dst LIKE '%nonexist%' OR dst_title LIKE '%nonexist%' OR dst IS NULL OR dst_title IS NULL"
-> [[0]]
```

`v_dangling`, exactly right:

```
node dist/index.js sql "SELECT target,citing_notes,cited_by FROM v_dangling"
-> ["nonexistent-target",2,"delta | epsilon"]
```

Independently reproduced on a second fresh vault (v4, `fresh-vault-check.mjs`, identical
topology with slugs `a`–`j`): `a` in3/out2, `b` in2/out1, `c` in3/out0, `d` in1/out1,
`e` in0/out0, `f` in0/out1, `g` in1/out1, `h` in1/out1, `i` in0/out0, `j` in0/out3…
(`j`→`d` resolving, so out4 before `c` was deleted). `v_dangling` → `missing-note | 2 | "d | e"`.

---

## Finding 1 — `index build` crashes on a zero-note vault; views are never created (major)

> §8: "All six must exist and be **queryable immediately after `ori index build` on a
> brand-new vault**, before any search has ever run. A view that parses but errors with
> "no such table" on a fresh vault is a defect."

The spec's own Testing Notes define a vault as "a directory containing `notes/` and a
`.ori/` directory; run `ori index build` inside it to create the index." Do exactly that,
with `notes/` still empty:

```
$ mkdir -p v5/notes v5/.ori && cd v5
$ node C:/Users/aayoa/Desktop/ori/dist/index.js index build
Error: graphology-metrics/centrality/pagerank: failed to converge.
EXIT=1

$ node -e "console.log(require('fs').statSync('.ori/embeddings.db').size)"
4096

$ node C:/Users/aayoa/Desktop/ori/dist/index.js sql "SELECT COUNT(*) FROM v_note"
{"success":false,"data":{"columns":[],"rows":[],"truncated":false,"elapsedMs":73},"warnings":["no such table: v_note"]}
EXIT=1
```

Actual: uncaught exception, exit 1, an empty 4096-byte database with no tables and no views,
and `v_note` failing with literally `no such table: v_note`.
Expected: a successful build and six queryable views returning zero rows.

Blast radius — the same crash makes a re-index abort and leaves the views serving stale data.
Vault v7 had one note, indexed cleanly; deleting it and re-indexing:

```
$ rm notes/solo.md
$ node .../dist/index.js index build
Error: graphology-metrics/centrality/pagerank: failed to converge.
EXIT=1
$ node .../dist/index.js sql "SELECT slug, title, modified FROM v_note"
{"success":true,...,"rows":[["solo","solo","2026-09-19 20:39:01"]],...}
$ node -e "console.log(require('fs').existsSync('notes/solo.md'))"
false
```

`v_note` reports a note that no longer exists on disk, and nothing warns about it
(§2: "every degradation is reported here. Silence means nothing went wrong.").

Scoped, not critical: `ori init` seeds `notes/index.md`, so an init-created vault has one
note and builds fine. Verified — `ori init .` then `index build` → `indexed:1`,
`v_note` → `["index","index",0,0,1]`. Hand-made vaults (the spec's own instructions) and
emptied vaults are the reachable paths.

Negative control — the failure is specific to zero notes, not to linkless graphs:

```
v7 (1 note, 0 links):  build OK, v_note -> ["solo",0,0,pagerank=1,betweenness=0]
v9 (3 notes, 0 links): build OK, pagerank = 0.3333333333333333 each, all six views queryable, 0 rows in v_link/v_dangling/v_retrieval/v_session/v_stage
```

---

## Finding 2 — deleting or renaming a note silently drops broken links out of both `v_link` and `v_dangling` (major)

> §8: "| `v_dangling` | missing link target | `target`, `citing_notes`, `cited_by` |"
> §8: "Views must be refreshed on re-index, so an upgraded install does not keep an older
> view definition."
> §2: "`warnings` — every degradation is reported here. Silence means nothing went wrong."

Minimal repro, in vault v4 (10 notes, `a`–`j`; `a`, `b`, `j` each link `[[c]]`):

```
$ rm notes/c.md
$ node .../dist/index.js index build
{"success":true,"data":{"indexed":0,"skipped":10,"total":10,...,"derived":{"scanned":10,"reparsed":0,"removed":1,"edges":8,"dangling":2}},"warnings":[]}

$ node .../dist/index.js sql "SELECT target, citing_notes, cited_by FROM v_dangling ORDER BY target"
{"success":true,...,"rows":[["missing-note",2,"d | e"]],...}

$ node .../dist/index.js query dangling
{"success":true,"data":{"dangling":["c","missing-note"]},"warnings":[]}
```

Actual: `v_dangling` lists only `missing-note`. The three live `[[c]]` links in `a`, `b`, `j`
appear in neither `v_link` (edges dropped 11 → 8) nor `v_dangling`. They are invisible in the
entire SQL surface. `ori query dangling`, reading the same index at the same moment, *does*
report `c`.
Expected: `v_dangling` contains `("c", 3, "a | b | j")`, matching the tool's own dangling report.

Renaming — the common real-world trigger — is the same bug and the disagreement is even
starker:

```
$ mv notes/b.md notes/b-renamed.md
$ node .../dist/index.js index build
{...,"derived":{"scanned":10,"reparsed":1,"removed":1,"edges":6,"dangling":5}},"warnings":[]}

$ node .../dist/index.js sql "SELECT target, citing_notes, cited_by FROM v_dangling ORDER BY target"
rows: [["c",3,"a | j | b-renamed"], ["missing-note",2,"d | e"]]

$ node .../dist/index.js query dangling
{"success":true,"data":{"dangling":["b","c","missing-note"]},"warnings":[]}
```

`b` is missing from `v_dangling`; `a` and `j` still contain `[[b]]` on disk.

`index build --force` repairs it, which confirms the stale-derivation nature:

```
$ node .../dist/index.js index build --force
{...,"derived":{"scanned":10,"reparsed":10,"removed":0,"edges":8,"dangling":5}},"warnings":["Force rebuild requested — all notes will be re-indexed"]}
$ node .../dist/index.js sql "SELECT target, citing_notes, cited_by FROM v_dangling ORDER BY target"
rows: [["c",3,"a | b | j"], ["missing-note",2,"d | e"]]
```

So `v_dangling` is correct only until a note disappears, then quietly wrong until someone
runs `--force`. Health checks and orphan/dangling audits built on this view under-report.

---

## Finding 3 — `v_retrieval` is not one row per returned note on the MCP path, and `rank` changes base (major)

> §8: "| `v_retrieval` | note returned by a query | `session_id`, `timestamp`, `query_text`,
> `query_type`, `slug`, `title`, `rank`, `final_score`, `q_score`, `ucb_bonus`, `transport` |"

CLI path is clean. `node .../dist/index.js query ranked "cli limit three probe" --limit 3`:

```
$ node .../dist/index.js sql "SELECT session_id, transport, rank, slug FROM v_retrieval WHERE query_text='cli limit three probe' ORDER BY rank"
rows: [["cli-mu8un1nj-uy57w3","cli",1,"gamma"],["cli-mu8un1nj-uy57w3","cli",2,"theta"],["cli-mu8un1nj-uy57w3","cli",3,"eta"]]
```

3 results in, 3 rows, `rank` 1..3. Correct.

The MCP tool `ori_query_ranked` with `{"query":"mcp transport probe","limit":3}` (driven by
`mcp-client.mjs`) returns 3 results but writes 11 rows for that one query event:

```
$ node .../dist/index.js sql "SELECT rank, slug, final_score, q_score, ucb_bonus FROM v_retrieval WHERE session_id='7fa378bb-d3fe-4e03-a7be-d42615c40988' ORDER BY rank, slug"
[0,"gamma",0.4514810379511349,-0.487215491981175,0.06532091085449424]
[1,"gamma",0.4514810379511349,0,0]
[1,"theta",0.23468336482478822,-0.8326177163951758,0.06532091085449424]
[2,"beta",0.18465572863093968,-0.7174836415905088,0.06532091085449424]
[2,"theta",0.23468336482478822,0,0]
[3,"delta",0,0,0]
[3,"lambda",0.1797413848160052,1.8159417646117066,0.5]
[4,"kappa",0.14623639853842046,-0.487215491981175,0.06532091085449424]
[5,"iota",0.1221525593906962,-0.487215491981175,0.06532091085449424]
[6,"delta",0.09633355990681867,-0.487215491981175,0.06532091085449424]
[7,"eta",0.06684146035144316,-0.487215491981175,0.06532091085449424]
```

Two populations share one `(session_id, timestamp, query_text)` key: an 8-row set ranked
**0..7** (`ucb_bonus` non-zero) and the 3 actually-returned notes ranked **1..3**
(`q_score = 0, ucb_bonus = 0`). `gamma`, `theta` and `delta` each appear twice under
different ranks and different `final_score`s.

```
$ node .../dist/index.js sql "SELECT session_id, transport, timestamp, query_text, COUNT(*) AS n, MIN(rank) AS minr, MAX(rank) AS maxr, COUNT(DISTINCT rank) AS distinct_ranks FROM v_retrieval GROUP BY session_id, timestamp, query_text ORDER BY timestamp"
["cli-mu8uc2w8-n2mwss","cli","2026-09-19 20:29:22","probe edge graph verification",10,1,10,10]
["7fa378bb-…","mcp","2026-09-19 20:33:37","mcp transport probe",11,0,7,8]
["4083c92a-…","mcp","2026-09-19 20:34:12","first distinct probe query",11,0,7,8]
["4083c92a-…","mcp","2026-09-19 20:34:12","second distinct probe query",8,0,7,8]
```

Actual: 11 rows for a 3-note result, duplicate `rank` values inside one query event, and
`rank` 0-based on one path and 1-based on the other.
Expected: one row per returned note, `rank` unique and consistently based within a query
event. `SELECT slug FROM v_retrieval WHERE rank = 1` is not answerable today.

---

## Finding 4 — `v_session.queries` counts distinct query text, not queries (major)

> §8: "| `v_session` | session | `session_id`, `started`, `ended`, `queries`, `retrievals` |"

Decisive repro — two *identical* queries, 3 seconds apart, one MCP session
(`mcp-multi-slow.mjs`, vault v2 with an empty retrieval log):

```
$ node ops-falsify/mcp-multi-slow.mjs . "same text different seconds" "same text different seconds"
query="same text different seconds" results=3
query="same text different seconds" results=3

$ node .../dist/index.js sql "SELECT session_id, queries, retrievals FROM v_session"
rows: [["bb0ec608-4b84-45b1-832b-260a891716a1",1,22]]

$ node .../dist/index.js sql "SELECT COUNT(*) AS rows_, COUNT(DISTINCT query_text) AS d_text, COUNT(DISTINCT timestamp) AS d_ts, group_concat(DISTINCT timestamp) AS ts FROM v_retrieval"
rows: [[22,1,2,"2026-09-19 20:35:17,2026-09-19 20:35:20"]]
```

Actual: `queries = 1` for two query invocations at two distinct timestamps.
Expected: `queries = 2`.

`d_text = 1` while `d_ts = 2` isolates the basis: it is `COUNT(DISTINCT query_text)`, not a
count of query events and not `COUNT(DISTINCT timestamp)`. Confirmed again with three
identical queries in one session (vault v3): `queries = 1, retrievals = 33`.

Re-asking the same question is the normal agent behaviour this column is meant to measure,
so the undercount is not an edge case. `retrievals` and `started`/`ended` were correct in
every run.

---

## Finding 5 — `v_note.modified` is UTC while `created` is local (minor)

> §8: "| `v_note` | note | `slug`, `title`, … `created`, `modified`, …"

```
$ node -e "const s=require('fs').statSync('notes/a.md'); console.log(new Date(s.mtimeMs).toString())"
Sat Sep 19 2026 15:38:21 GMT-0500 (Central Daylight Time)
$ node .../dist/index.js sql "SELECT slug, created, modified FROM v_note WHERE slug='a'"
rows: [["a","2026-09-19","2026-09-19 20:38:21"]]
```

Day-rollover repro — a note whose mtime is pinned to 23:30 local:

```
$ node -e "const t=new Date('2026-09-19T23:30:00-05:00'); require('fs').utimesSync('notes/tzprobe.md',t,t)"
$ node .../dist/index.js index build && node .../dist/index.js sql "SELECT slug, created, modified, date(modified) AS mod_date FROM v_note WHERE slug='tzprobe'"
rows: [["tzprobe","2026-09-19","2026-09-20 04:30:00","2026-09-20"]]
```

Actual: `modified` is a bare UTC datetime string with no marker, next to a `created` that is
a local calendar date from frontmatter. `date(modified)` is a day ahead of `created` for the
same note. The obvious query `WHERE date(modified) = date('now','localtime')` misses notes
edited in the evening.
Expected: either both local, or `modified` documented/labelled as UTC.

---

## Finding 6 — `outbound` / `v_link` count distinct targets, not wiki-links (minor)

> §8: "| `v_link` | resolving wiki-link | `src`, `src_title`, `dst`, `dst_title` |"

Vault v2, note `hub.md` authored with four wiki-links: `[[dup-target]]`, `[[dup-target]]`,
`[[ghost-x]]`, `[[ghost-x]]`.

```
$ node .../dist/index.js sql "SELECT COUNT(*) FROM v_link WHERE src='hub' AND dst='dup-target'"
-> [[1]]
$ node .../dist/index.js sql "SELECT slug, inbound, outbound FROM v_note WHERE slug='hub'"
-> [["hub",0,1]]
$ node .../dist/index.js sql "SELECT target, citing_notes, cited_by FROM v_dangling"
-> [["ghost-x",2,"hub | pipey"]]
```

Actual: one row per distinct `(src,dst)` pair; `hub.outbound = 1` for four authored links.
`v_dangling.citing_notes = 2` counts notes (hub, pipey), not link occurrences — correct for
its column name, but note the two views use different dedup semantics for the same input.
Expected per the literal wording ("one row per … wiki-link"): two `hub → dup-target` rows.

Related ambiguity, same family: `outbound` excludes dangling links entirely, so `epsilon`
(one authored `[[nonexistent-target]]` link) reports `outbound = 0` and is indistinguishable
from `iota`, which has no links at all. "Notes with no outgoing links" is therefore not
answerable from `v_note` alone.

---

## Finding 7 — undocumented `id` column and join surprises (minor)

`ori sql --schema` and `SELECT * FROM v_note WHERE 0` both report:

```
["id","slug","title","type","status","description","created","modified","access_count","last_accessed","inbound","outbound","pagerank","betweenness","q_value","q_updates","exposure_count"]
```

Two columns are not in the §8 table: `id` and `last_accessed`. Extra columns are not
forbidden, but §8 opens with "They exist so the physical tables can change without breaking
callers" — and `id` is precisely the physical `note.id` key (verified: `SELECT * FROM v_note a JOIN v_note b ON a.id=b.id`
joins 1:1, and `v_note.id` values 1..n match `note` row order). Exposing it invites callers
to depend on the thing the view is meant to hide.

Join surprises, all vault v1:

```
$ node .../dist/index.js sql "SELECT COUNT(*) FROM v_note NATURAL JOIN v_link"
-> [[132]]        # 11 notes x 12 links: NATURAL JOIN degenerates to a cross join,
                  # because the graph key is `slug` in one view and `src`/`dst` in the other

$ node .../dist/index.js sql "SELECT COUNT(*) AS joined, (SELECT COUNT(*) FROM v_stage) AS stages, (SELECT COUNT(*) FROM v_retrieval) AS retr FROM v_stage NATURAL JOIN v_retrieval"
-> [[511,35,54]]  # joins on (session_id, timestamp), not session_id alone

$ node .../dist/index.js sql "SELECT COUNT(*) FROM v_link JOIN v_dangling ON v_link.dst=v_dangling.target"
-> [[0]]          # v_link.dst is a slug, v_dangling.target is raw link text — never joinable
```

`v_retrieval NATURAL JOIN v_note` happens to behave (shares `slug` *and* `title`, 1:1 today),
but only because title equals slug in this build — see negative results.

---

## Finding 8 — `v_dangling.cited_by` is a lossy unordered string (minor)

> §8: "| `v_dangling` | missing link target | `target`, `citing_notes`, `cited_by` |"

Vault v3, 25 notes all citing `[[mass-ghost]]`:

```
$ node .../dist/index.js sql "SELECT target, citing_notes, length(cited_by) AS cb_chars, cited_by FROM v_dangling ORDER BY target"
["ghost-alias",1,8,"aliassrc"]
["ghost-frag",1,7,"fragsrc"]
["mass-ghost",25,272,"citer-01 | citer-02 | … | citer-25"]
```

`citing_notes` is right (25). `cited_by` is a `' | '`-joined concatenation with no escaping
and no `ORDER BY`, so (a) ordering is unspecified across runs, (b) any note title containing
` | ` would be indistinguishable from a separator, and (c) past ~4096 bytes of citing titles
the cell is truncated by the §6 cell rule and the list is silently incomplete — with no
warning. Demonstrated on the same view family with a 5200-byte `description`:

```
$ node .../dist/index.js sql "SELECT description FROM v_note WHERE slug='longdesc'"
cell length 4121, tail: "DDDD… [truncated, 5200 bytes]"
warnings: []
```

The marker matches §6, but §2's "every degradation is reported here" is not honoured — no
warning accompanies a truncated cell. (Flagging for the §2/§6 owner; found via the views.)

---

## Finding 9 — `v_stage.decision` carries no information (minor)

> §8: "| `v_stage` | stage decision | `session_id`, `timestamp`, `stage_id`, `decision`, … |"

```
$ node .../dist/index.js sql "SELECT decision, COUNT(*) AS n, SUM(reward IS NULL) AS null_reward, SUM(quality_before IS NULL) AS null_qb FROM v_stage GROUP BY decision"
-> [["run",42,2,2]]
$ node .../dist/index.js sql "SELECT stage_id, decision, quality_before IS NULL AS qb_null, reward IS NULL AS r_null, COUNT(*) FROM v_stage GROUP BY stage_id, decision, qb_null, r_null ORDER BY stage_id"
["bm25","run",0,0,6] ["cooccurrence_ppr","run",0,0,6] ["gravity_dampening","run",0,0,6]
["hub_dampening","run",0,0,6] ["pagerank","run",0,0,6]
["q_reranking","run",0,0,4] ["q_reranking","run",1,1,2]
["warmth","run",0,0,6]
```

Across 42 rows from 6 query events, `decision` is always `'run'` — a view named "stage
decision" that never records a decision not to run. Two `q_reranking` rows report
`decision='run'` with NULL `quality_before`, `quality_after`, `compute_time_ms` and `reward`,
i.e. a stage that "ran" and reported nothing. Values are plausible-but-uninformative rather
than wrong; recorded because the brief asks whether every documented column "holds plausible
values".

---

## Finding 10 — `v_note.title` is a copy of `slug`; authored titles are unreachable (minor)

> §8: "| `v_note` | note | `slug`, `title`, `type`, `status`, …"
> §8: "| `v_link` | resolving wiki-link | `src`, `src_title`, `dst`, `dst_title` |"

`title` was byte-identical to `slug` in every row of every vault tested — 10 (v1), 9+5 (v2),
35 (v3), 11 (v4), and the small vaults, and `SqlContract` independently reports the same on a
651-note scratch vault where each file carries a distinct `# 日本語 …` H1
(`WHERE title LIKE '%日本語%'` → 0 rows).

Verified that neither of the two places a title can be authored reaches the view.
Frontmatter `title:` — 5 notes written with `title: "a | b | c"`, `title: "it's a \"quoted\"
title"`, a 2600-char title, `title: "'; DROP TABLE note; --"`, and a unicode title:

```
$ node .../dist/index.js sql "SELECT slug, length(title) AS chars, substr(title,1,50) AS head FROM v_note WHERE slug LIKE 'fm%' ORDER BY slug"
[["fminj",5,"fminj"],["fmlong",6,"fmlong"],["fmpipe",6,"fmpipe"],["fmquote",7,"fmquote"],["fmuni",5,"fmuni"]]
```

`# H1` — 9 notes in v2 written with H1s such as `a | b | c` and
`'; DROP TABLE note; --`: every `v_note.title` came back as the filename stem.

This is not merely a stress-test artefact — it is what the vault's own capture path produces:

```
$ node .../dist/index.js add "semantic search finds connections that keyword search misses" --type learning --content "Body text for the title mapping probe."
{"success":true,"data":{"path":"…\\notes\\semantic-search-finds-connections-that-keyword-search-misses.md",…}}
# file contains: # semantic search finds connections that keyword search misses

$ node .../dist/index.js index build && node .../dist/index.js sql "SELECT slug, title, (slug = title) AS same FROM v_note ORDER BY slug"
[["index","index",1],
 ["semantic-search-finds-connections-that-keyword-search-misses","semantic-search-finds-connections-that-keyword-search-misses",1]]
$ node .../dist/index.js sql "SELECT COUNT(*) AS n, SUM(slug = title) AS title_equals_slug FROM v_note"
-> [[2,2]]
```

Actual: `ori add` writes the prose title as the H1 and the slugified form as the filename;
`v_note.title` reports the slugified form. `title`, `src_title` and `dst_title` are therefore
redundant aliases of `slug`, `src` and `dst` — four of the fourteen documented `v_note`/`v_link`
columns carry zero information — and `SELECT title FROM v_note` never returns any note's
authored title. `WHERE title LIKE '% %'` matches nothing in a vault built entirely through
`ori add`.
Expected: either `title` surfaces the authored title (H1 / frontmatter), or §8 drops the
three `*title*` columns rather than documenting them as distinct key columns.

Considered and rejected as a false positive: ori's prose-as-title convention makes the
filename the canonical claim, so `title == slug` may be intentional. It still leaves three
documented columns informationless and the H1 — which `ori add` itself writes — unqueryable,
so it is filed as minor rather than dropped.

*(Finding 11 is written up in the Addendum at the end of this file — it came out of the same
follow-up run and only makes sense next to the refuted hypothesis there.)*

---

## Finding 12 — pagerank distribution (false-positive-considered)

> §8: "`v_note.pagerank` must be populated, not `NULL`, for a vault with links."

The clause holds everywhere tested — `SUM(pagerank IS NULL) = 0` on v1 (10 and 11 notes),
v2, v3 (35 notes), v4, v7, v8, v9. So this is **not** a violation. Recording the surprise
because the brief asks for plausible values:

```
$ node .../dist/index.js sql "SELECT COUNT(*) AS n, SUM(pagerank IS NULL) AS null_pr, SUM(betweenness IS NULL) AS null_bt, ROUND(SUM(pagerank),6) AS pr_sum FROM v_note"
-> [[10,0,0,0.92133]]        # v1, 10 notes
-> [[11,0,0,0.886622]]       # v1 after adding lambda
```

Rank mass is not conserved (0.921, not 1.0) — the three out-degree-0 notes leak it — and the
disconnected mutual pair `eta`/`theta` (one inbound each, unreachable from the main
component) scored **0.221719** apiece, the highest in the vault, above `gamma` at **0.142019**
with three inbound links from the main component. That is textbook rank-sink behaviour for
un-normalised damped PageRank, so it is defensible; it does mean `ORDER BY pagerank DESC`
surfaces isolated cliques ahead of genuinely central notes. Linkless vaults normalise
correctly (v9: 0.3333… × 3 = 1.0).

---

## Finding 13 — `transport` for `exp-` sessions (false-positive-considered)

> §8: "`transport` in `v_retrieval` is `cli` for session ids beginning `cli-`, else `mcp`."

`ori explore-start` mints session ids of the form `exp-mu8ukfc1-c5wv28`, which by the letter
of the rule would be labelled `mcp` despite being CLI-originated. Tested:

```
$ node .../dist/index.js explore-start "which notes are hubs" --json     # -> exp-mu8ukfc1-c5wv28
$ node .../dist/index.js explore-conclude "exp-mu8ukfc1-c5wv28" --answered --used "alpha,kappa" --json
$ node .../dist/index.js sql "SELECT session_id, transport, COUNT(*) FROM v_retrieval GROUP BY session_id, transport"
["4083c92a-…","mcp",33] ["7fa378bb-…","mcp",11] ["cli-mu8uc2w8-n2mwss","cli",10]
```

Exploration writes no `retrieval_log` rows, so no `exp-` row ever reaches `v_retrieval`.
Not a defect. Worth knowing that exploration activity is entirely absent from `v_retrieval`
and `v_session` even though `explore-conclude` does update Q state (see negative results).

---

## Negative results — what did NOT break

These were attacked and held. They are the evidence that findings 1–4 are specific.

**The headline fresh-vault claim holds for any vault with ≥1 note.** `fresh-vault-check.mjs`
builds a brand-new 10-note vault, runs `index build` exactly once, and immediately issues
`SELECT *` and `SELECT COUNT(*)` against all six views before any search has ever run:

```
BUILD: {"success":true,...,"indexed":10,...,"derived":{...,"edges":11,"dangling":2}}
OK exit=0 SELECT * FROM v_note       rows=10 warnings=[]
OK exit=0 SELECT * FROM v_link       rows=11 warnings=[]
OK exit=0 SELECT * FROM v_dangling   rows=1  warnings=[]
OK exit=0 SELECT * FROM v_retrieval  rows=0  warnings=[]
OK exit=0 SELECT * FROM v_session    rows=0  warnings=[]
OK exit=0 SELECT * FROM v_stage      rows=0  warnings=[]
```

No "no such table", no error, and the three log views return zero rows with `success: true`
and their full column lists intact — exactly as §2 requires for a legitimately empty result.

- **Every §8 column exists in every view.** `SELECT * FROM <view> WHERE 0` returned exact
  supersets of the spec table for all six. `v_link`, `v_dangling`, `v_retrieval`, `v_session`
  and `v_stage` match the spec column-for-column and name-for-name; only `v_note` adds
  extras (finding 7).
- **`--schema` lists all six views plus 17 tables, with row counts and one-line docs, no
  `sqlite_*` objects, `warnings: []`.** Row counts matched reality (`v_note` 10, `v_link` 11,
  `v_dangling` 1, log views 0).
- **View definitions really are recreated on re-index — even a no-op one.** `stale-view.mjs`
  replaced `v_note` with `CREATE VIEW v_note AS SELECT 'LEGACY' AS legacy_marker` and dropped
  `v_dangling` entirely. `index build` with `indexed:0, skipped:11, reparsed:0` restored both:
  `view_count` 5 → 6, `v_note` back to the real 17-column definition. §8's upgrade clause holds.
- **Incremental re-index updates the views correctly.** Added `lambda.md` (`[[alpha]]` +
  dangling `[[another-ghost]]`) to v1 and rebuilt: `v_note` 10→11, `v_link` 11→12,
  `alpha.inbound` 3→4, `lambda` in1/out1→(0,1), `v_dangling` 1→2 rows with
  `("another-ghost",1,"lambda")`, and `v_retrieval`/`v_session`/`v_stage` kept their 10/1/7
  rows — no history lost.
- **`transport` is correct for both real transports.** CLI session `cli-mu8uc2w8-n2mwss` →
  `cli`; MCP sessions `7fa378bb-…`, `4083c92a-…` (UUIDs, no `cli-` prefix) → `mcp`. Verified
  by driving `serve --mcp` over stdio.
- **Search populates the log views on a previously empty vault.** After one CLI
  `query ranked`, `v_retrieval` 10 rows, `v_session` `("cli-…","2026-09-19 20:29:22","2026-09-19 20:29:22",1,10)`,
  `v_stage` 7 rows (`bm25`, `pagerank`, `warmth`, `cooccurrence_ppr`, `gravity_dampening`,
  `hub_dampening`, `q_reranking`). No NULLs in any of `slug`, `title`, `query_text`,
  `query_type`, `rank`, `final_score`, `q_score`, `ucb_bonus`.
- **`v_note`'s Q columns do populate.** They are NULL on a fresh vault, but after queries and
  an `explore-conclude --used "alpha,kappa"`: `access_count` 1–3, `q_value` 0.346–0.45,
  `q_updates` 1–3, `exposure_count` 1–7. Plausible.
- **`v_note` holds the one-row-per-note invariant.** `COUNT(*) = COUNT(DISTINCT slug) = COUNT(*) FROM note`
  = 11 in v1 and 35 in v3, including after `note_q` gained rows. `note_q` carries two extra
  rows keyed to dangling targets (`another-ghost`, `nonexistent-target`); the view correctly
  drops them rather than fanning out.
- **Unicode, quotes and long values round-trip byte-exactly.** Note titles come from the
  filename stem, never from `title:` frontmatter or the `# H1` (finding 10), so the stress
  cases had to be filenames. `naïve-日本語-café-🧠` →
  `hex(title) = 6E61C3AF76652DE697A5E69CACE8AA9E2D636166C3A92DF09FA7A0` (exact),
  `length(title)=16` chars / `27` bytes. `it's-a-quote` (apostrophe),
  `semi;colon,comma (paren) [bracket] & amp`, `spaced out name`, and a 205-character filename
  all appear unmangled in `v_note` and `v_link` (`src`/`dst` and `src_title`/`dst_title`).
  `SELECT * FROM v_note` over the whole 35-note vault returned cleanly.
- **Link resolution is robust.** `[[Anchor]]` and `[[ANCHOR]]` both resolve to `anchor.md`
  and dedupe to one edge; `[[anchor|the anchor note]]` (alias) and `[[anchor#some-heading]]`
  (heading) resolve; `[[ghost-alias|a ghost]]` and `[[ghost-frag#h]]` land in `v_dangling` as
  `ghost-alias` / `ghost-frag`. A self-link (`selfie → selfie`) yields `inbound=1, outbound=1`
  and one `v_link` row — no infinite loop, no exclusion.
- **`anchor` inbound counted exactly right at scale:** 9 citing notes across unicode,
  apostrophe, punctuation, 205-char, alias, fragment and case-folded sources → `inbound = 9`,
  matching 9 `v_link` rows.
- **Retrieval history survives note deletion without corruption.** Deleted the top-ranked
  note `c` and rebuilt: `v_retrieval` kept all 5 rows, `("c", title=NULL)` for the deleted
  one, `retrieval_log` count == view count == 5, `v_session` still `(…,1,5)`. A LEFT JOIN,
  not a silent row drop — the right call.
- **Duplicate output column names are not collapsed.** `SELECT 1 AS x, 2 AS x, 3 AS x` →
  `cols=["x","x","x"], rows=[[1,2,3]]`, and the `v_note` self-join returned all 34 columns
  with both copies of every value. The positional-array contract in §2 is honoured; no
  object-keyed collapse, no data loss.
- **`rank` does not collide with SQLite's `rank()` window function.**
  `SELECT slug, rank, rank() OVER (ORDER BY final_score DESC) AS wrank FROM v_retrieval`
  parses and runs, returning both the column and the window value.
- **Subdirectories under `notes/` are ignored by the scanner**, so a duplicate slug at
  `notes/sub/anchor.md` cannot fan out `v_note` (`indexed:0, skipped:35`; `v_note` stayed at
  35 rows, one `anchor`). Not a view defect — noted so the next run does not chase it.
- **Pre-index behaviour is clean.** With `.ori/` present but no database,
  `ori sql --schema` returned
  `{"success":false,"data":{},"warnings":["no index at …\\.ori\\embeddings.db; run \`ori index build\` (unable to open database file)"]}`
  — no crash, and the warning names the fix, per §9. (After the finding-1 crash the database
  exists but is empty, and the warning degrades to a bare `no such table: v_note` that does
  not tell the caller to rebuild — minor, flagged for the §9 owner.)

---

## Addendum — follow-up on peer datapoints (vault v10)

`SqlContract` reported, from a 651-note contract vault, that wiki-links written in *title*
form produced `edges:0 / dangling:2596` while slug-form links produced `edges:1944`, and
inferred that link resolution is slug-only. Tested directly, because if true it would mean
`v_link` is empty for any vault following the documented `[[prose title]]` convention.

Vault v10: `ori init`, then three notes created the real way —
`ori add "fake money is not sticky because users have nothing to lose"` etc., which produces
slugified filenames — then a `citer.md` linking them in the title form CLAUDE.md documents,
plus one slug-form control:

```
Since [[fake money is not sticky because users have nothing to lose]], we need a real token economy.

Relevant Notes:
- [[kashi needs real utility beyond trading to drive adoption]] -- title-form link
- [[courtshare engagement could use token incentives]] -- title-form link
- [[courtshare-engagement-could-use-token-incentives]] -- slug-form control
```

```
$ node .../dist/index.js index build
{"success":true,...,"derived":{"scanned":5,"reparsed":2,"removed":0,"edges":6,"dangling":6}},"warnings":[]}
$ node .../dist/index.js sql "SELECT src, dst FROM v_link ORDER BY src, dst"
["citer","courtshare-engagement-could-use-token-incentives"]
["citer","fake-money-is-not-sticky-because-users-have-nothing-to-lose"]
["citer","kashi-needs-real-utility-beyond-trading-to-drive-adoption"]
["courtshare-engagement-could-use-token-incentives","index"]
["fake-money-is-not-sticky-because-users-have-nothing-to-lose","index"]
["kashi-needs-real-utility-beyond-trading-to-drive-adoption","index"]
```

**Hypothesis refuted — do not file this.** All three title-form links resolved. Link text is
slugified and matched against filenames, so `[[prose title]]` resolves exactly when the title
slugifies to the filename — which is what `ori add` guarantees. The peer's zero-edge result
came from a vault whose filenames (`note-0004.md`) did not slugify from its H1s
(`# test claim number 4 asserts …`), so the link text matched no file. Correct behaviour, not
a defect. Combined with the case-folding, alias and fragment results in the negative-results
section, link resolution is the most robust part of this surface.

Two things the run did add:

**Reinforces finding 6.** `citer.md` authored **four** wiki-links but yields **three** `v_link`
rows: the title-form `[[courtshare engagement could use token incentives]]` and the slug-form
`[[courtshare-engagement-could-use-token-incentives]]` collapse to one edge. So two links with
*different source text* dedupe, not just literal repeats — `outbound` is a distinct-target
count, confirmed a second way.

**Reinforces finding 10 at scale.** The peer's 651-note vault gives
`SELECT COUNT(*) FROM v_note WHERE title GLOB '*[^ -~]*'` → 0, with every file carrying a
distinct `# 日本語 …` H1. No non-ASCII authored title is reachable through the SQL surface at
all, so title search cannot match anything a user would actually type.

### Finding 11 — `v_dangling.target` is the slugified link text, not what the author wrote (minor)

> §8: "| `v_dangling` | missing link target | `target`, `citing_notes`, `cited_by` |"

The `ori add` template itself writes placeholder footers `- [[related note]]` and
`- [[relevant map]]` — with spaces. After indexing the three `ori add` notes:

```
$ node .../dist/index.js sql "SELECT target, citing_notes, cited_by FROM v_dangling ORDER BY target"
["related-note",3,"fake-money-is-not-sticky-… | kashi-needs-real-utility-… | courtshare-engagement-…"]
["relevant-map",3,"fake-money-is-not-sticky-… | kashi-needs-real-utility-… | courtshare-engagement-…"]
```

Actual: `target` reports `related-note` / `relevant-map`; the text in the notes is
`[[related note]]` / `[[relevant map]]`. A caller who takes `target` and greps the vault for
it finds nothing, and the "missing link target" it names is not a string that appears anywhere
in the source. Expected: either the authored link text, or a documented note that `target` is
normalised.

Secondary observation, worth a fix note rather than a finding: `ori add` manufactures two
dangling links per note through its own template placeholders, so every vault built with
`ori add` carries `related-note` and `relevant-map` in `v_dangling` cited by every note.

