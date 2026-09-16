# Ori 0.7.0 — the correctness release

`0.6.1` was published on 2026-07-29 and is what `npm i ori-memory` has served
since. The repository moved on; the release did not. Every fix below is
behaviour reachable on the build people are running today.

## If you are on 0.6.1, these are the ones that matter

**A crash mid-write could truncate a note to zero bytes.** Frontmatter was
written in place. Markdown is the source of truth in Ori, so a partial write is
data loss, not a cosmetic glitch. Writes are now atomic — temp sibling, fsync,
rename — with a bounded retry for the Windows case. In an 8-writer
reproduction, 374 of 480 renames failed with `EPERM`; exactly one raw
`fs.rename` now exists in the repository, inside the helper.

**`promote` could leave a note in both places or neither.** It wrote the new
location, then updated state, then deleted the old file. A failure between
steps left the vault inconsistent. It now moves first and rolls back, so a note
exists exactly once at every instant.

**Concurrent CLI and MCP access raised `SQLITE_BUSY`.** No `busy_timeout` was
set, so a second connection failed instead of waiting. `foreign_keys` is now ON
with `ON DELETE CASCADE`, which makes orphaned learning rows unrepresentable
rather than something to remember to clean up.

**A read could write to your note files.** Access counts were flushed to
frontmatter on the query path. A query now leaves note files byte-identical;
counts accumulate in the derived index and flush explicitly.

**The CLI never learned.** `useIntelligence` required an external database and a
caller-supplied session id, which only the MCP server passed. So `ori query
ranked` never tracked a stage, wrote `stage_log`, persisted a bandit policy,
logged exposure, or credited a Q-value — the same query answered differently
depending on which transport asked it. Production vault: 717 `note_q` rows, 707
never updated, `stage_log` empty.

## Performance

Measured on a real 1,538-note vault, not a fixture:

| entry point | 0.6.1 | 0.7.0 |
|---|---|---|
| `ori query ranked` | 3,344 ms | **350 ms** |
| `ori query warmth` | 2,487 ms | **231 ms** |
| `ori explore` | 3,785 ms | **474 ms** |

Every query previously re-read and re-parsed the whole vault three to four
times. A derived index (`src/core/indexstore.ts`) now persists notes, links,
projects, term postings, access counts and graph metrics, synced per query and
stat-filtered.

The index is **derived and disposable by construction**. Delete it and it
rebuilds; a missing or stale one degrades to the old scans with a warning,
never a failure. Markdown remains the only source of truth — the index is not
allowed to become a second one.

BM25 now scores from stored postings scoped to the query's terms: 2,590 ms →
0.4–11 ms, bit-identical scores (317,824 postings compared, 0 mismatches).
`bootstrapFromWikiLinks` went 11,426 ms → 75 ms after two unfilled template
placeholders were found linking from ~880 notes each and producing 98.2% of all
bootstrap rows.

## Repository

**21 of 57 test files were not in git.** `.gitignore` carried `tests/*` plus a
hand-maintained allowlist of 36 individual files, so a newly written test was
invisible by default and nothing failed to tell you. The ignored set included
`atomic-writes`, `frontmatter`, `promote`, `tracking`, `indexstore`,
`bm25-store`, `graph-metrics-cache`, `cli-learning-wiring` and
`health-learning` — precisely the tests that prove the fixes in this release.
`tests/fixtures/` was ignored too, so the 36 tracked tests could not run from a
clean clone.

`tests/` is now tracked. The suite a contributor gets is the suite that runs
here: **57 files, 862 tests**, `tsc` clean.

## Also in this release

- The derived index never invalidated on an edit — freshness compared indexed
  note count to file count, which is blind to a note changed in place.
- Warmth and explore bypassed the index entirely; one seam (`openSyncedIndex`)
  now serves all four entry points plus `ori add`.
- One of six composite scoring spaces was a constant: `communityScore` returned
  0.5 for every note while `community_vec` held 96 distinct patterns.
- `getDecayedQ` decayed the initialisation constant for exposure-created rows
  and parsed SQLite's `datetime('now')` as local time — west of UTC every fresh
  row had negative age, so decay became growth.
- `ori index build` rebuilt embeddings only; it now rebuilds all three derived
  stores, and MCP `ori_index_build` calls the same function.
- `ori health` warns when learning is absent.

Full detail in [CHANGELOG.md](../CHANGELOG.md). The audit this release came
from is in [docs/reaudit-2026-09-15/](reaudit-2026-09-15/), split by area:
safety, schema, retrieval, surface, external.

## Not fixed in 0.7.0

Stated plainly so nobody has to discover it:

- **Vault hygiene (tier 3) is untouched.** It is blocked on a retrieval-quality
  metric that can actually adjudicate a change; `measureCurrentQuality` is
  title-only today.
- **An existing production database is not migrated.** A vault that has been
  running 0.6.1 carries co-occurrence bootstrap rows from the pre-cap code
  (223,917 of 239,993 rows in the reference vault). They are not wrong, just
  low-value bulk. `ori index build --force` drops and reparses the derived
  index if you want it clean.
- **`flushAccessToFrontmatter` has no caller.** Access counts live in the index
  and are correct there; the explicit flush path is not wired to a command yet.
