# Ori re-audit — slice `external`: what "give your agent a database to query its memory" means in practice

Scope: 11 systems, primary sources only (docs, papers, source). Ori claims cite `file:line` in the working tree. Ori's pitch is `README.md:5-7,141-155` ("Markdown + SQLite", four-signal fusion, learned Q-values).

## Findings

**F1 (high) — The phrase means two different things, and Ori has neither form.**
(a) *Raw SQL as the agent surface*: Willison's tool exposes exactly two functions, `query(sqlite_sql)` — docstring "read-only, only use SELECT" — and `schema()` = `SELECT group_concat(sql,';') FROM sqlite_master` ([llm_tools_datasette.py](https://raw.githubusercontent.com/simonw/llm-tools-datasette/main/llm_tools_datasette.py)); Datasette Agent answers "when did Simon last see a pelican?" by writing `SELECT … WHERE beat_type='sighting' AND … ORDER BY created DESC LIMIT 5` ([simonw.substack.com](https://simonw.substack.com/p/datasette-agent-an-ai-assistant-for)). Cognee ships `CYPHER` (raw) and `NATURAL_LANGUAGE` (text-to-Cypher from schema) search types behind an `ALLOW_CYPHER_QUERY` gate ([docs.cognee.ai](https://docs.cognee.ai/core-concepts/main-operations/legacy-operations/search)). Anthropic's own guidance: Claude Code "can write targeted queries, store results … without ever loading the full data objects into context" ([anthropic.com](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
(b) *SQL as the composition layer*: sqlite-memory's entire API is a virtual table — `SELECT path, snippet, ranking FROM memory_search WHERE query='…'` ([github.com/sqliteai/sqlite-memory](https://github.com/sqliteai/sqlite-memory)); sqlite-vec's `vec0` is queried with `WHERE embedding MATCH ? AND k=20` in the same statement as any join ([alexgarcia.xyz](https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html)).
Ori exposes 16 fixed tools and 5 markdown resources (`src/cli/serve.ts:400-435`); `grep -i "sql|schema"` over `serve.ts` matches only `import type Database` (:48) and "Validate a note against schema" (:800). No query tool, no schema tool, no view layer.

**F2 (high) — Every markdown-as-truth peer has FTS5 + vector in one SQLite file; Ori has hand-rolled BM25 and no FTS table.** OpenClaw builtin: "Keyword search via FTS5 (BM25) … sqlite-vec acceleration" ([docs.openclaw.ai/concepts/memory-builtin](https://docs.openclaw.ai/concepts/memory-builtin)). memweave: `chunks_fts` (FTS5) + `chunks_vec` (sqlite-vec), merged 0.7/0.3 ([towardsdatascience.com](https://towardsdatascience.com/memweave-zero-infra-ai-agent-memory-with-markdown-and-sqlite-no-vector-database-required/)). sqlite-memory: "hybrid semantic search (vector similarity + FTS5)". Ori's fix-list already records the mismatch (`docs/fix-list-2026-09-15.md:51-53`) and measured FTS5 (:83-87). Consequence for F1: without FTS5 there is no `MATCH` for an agent-issued query to use.

**F3 (high) — Temporal validity is a first-class field in 5 of 11 systems; Ori has only `status: superseded`.** Zep stores four timestamps per fact — `t_valid`, `t_invalid` (world time) and `t'_created`, `t'_expired` (transaction time) — and invalidates contradicted edges by setting `t_invalid` rather than deleting ([arxiv 2501.13956 §2.2.3](https://arxiv.org/html/2501.13956v1)); the context string returned to the LLM prints `FACT (Date range: from - to)` (§3). mem0: `expiration_date` hides memories from search, `created_at` range filters ([docs.mem0.ai add](https://docs.mem0.ai/core-concepts/memory-operations/add), [search](https://docs.mem0.ai/core-concepts/memory-operations/search)). OpenClaw: chunks carry "observation time, and an optional supersession key"; `USER.md` directives carry "observed-date and active/superseded metadata … supersede it in place" ([memory](https://docs.openclaw.ai/concepts/memory), [memory-builtin](https://docs.openclaw.ai/concepts/memory-builtin)). memweave: exponential decay `exp(−ln2·age/half_life)` with evergreen bypass. Cognee: `TEMPORAL` retriever. Ori: `grep valid_from|valid_until|supersedes` over `src/` finds nothing; `superseded` appears only as an archive heuristic (`src/cli/archive.ts:35,56,92`).

**F4 (medium) — Provenance is stored *outside* the prose in the systems that worry about prompt injection.** OpenClaw: "SQLite-owned provenance: origin class (`owner`, `agent`, `untrusted`, `system`) … stored separately from Markdown so recalled prose cannot rewrite its own trust classification"; dreaming is "taint gated". Graphiti: "every derived fact traces back" to an episode ([github.com/getzep/graphiti](https://github.com/getzep/graphiti)). memweave: `path:start_line` on every hit. Ori's `note` row is keyed by path (`src/core/indexstore.ts`) — provenance to file, none to origin/trust.

**F5 (medium) — "Why was this retrieved" is a documented feature in 3 systems; Ori computes it but the contract is thin.** mem0 OSS `search(..., explain=True)` returns `score_details` (semantic, normalized BM25, entity boost, combined, max, final, threshold). Zep prints validity ranges and names its rerankers (RRF, MMR, episode-mentions, node-distance, cross-encoder). Cognee `verbose=True` returns `objects_result`. Ori's `ScoredNote.signals` has `composite|keyword|graph|warmth` (`src/core/ranking.ts:4-7`) but no stage-decision or Q/UCB breakdown per result, and nothing says which stage the LinUCB bandit skipped for this query.

**F6 (low) — MMR diversity is default in OpenClaw ("MMR enabled on hybrid results by default"), Zep, memweave; absent in Ori** (README lists gravity/hub/resolution dampening, `README.md:149`; no MMR anywhere in `src/`).

**F7 (informational) — Ori's design invariant "no LLM in the fast path" is shared only by the markdown-native tier.** mem0, Zep, Honcho, Cognee all run an LLM at ingest (mem0 "sends the messages through an LLM"; Honcho's "Deriver"; Zep entity/fact extraction + reflexion). Zep explicitly rejects LLM-*generated* DB queries for writes "to ensure consistent schema formats and reduce the potential for hallucinations" (§2.2.1) — read-side SQL is what the field trusts, not write-side.

## Comparison table

| System | Storage | Agent-facing surface | Retrieval mix | Time / provenance |
|---|---|---|---|---|
| Anthropic memory tool | files under `/memories`, client-side ([platform.claude.com](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)) | `view/create/str_replace/insert/delete/rename` | none — agent lists dir, reads files | file paths + timestamps only |
| Letta | server DB; blocks + passages ([docs.letta.com](https://docs.letta.com/v1-sdk/memory/archival-memory)) | fixed tools: block edit, `archival_memory_search(query,tags,page)`, conversation search | vector + tag filter | archival is "agent-immutable"; no validity |
| mem0 | vector store (+ optional graph) | `add/search` with JSON filters (AND/OR, `gte`) | vector → filters → rerank; OSS adds BM25 + entity | `expiration_date`, `created_at` filters, `explain=True` |
| Zep / Graphiti | Neo4j/FalkorDB temporal KG | search API (φ→ρ→χ), no user SQL; predefined Cypher for writes | cosine + BM25 + BFS, RRF/MMR/cross-encoder | bi-temporal on edges; episodes = non-lossy provenance |
| Honcho | Postgres + pgvector ([github.com/plastic-labs/honcho](https://github.com/plastic-labs/honcho)) | `peer.chat()` natural-language dialectic, `search()` hybrid, `representation()` | BM25 + vector; LLM-derived representations | messages timestamped; local vs global reps |
| Datasette Agent / llm-tools-datasette | any SQLite | **read-only SQL + `schema()`** | whatever the agent writes (`LIKE`, `ORDER BY created`) | whatever columns exist; query text is the audit trail |
| sqlite-vec | SQLite virtual table | **SQL**: `MATCH … AND k=` | brute-force KNN; composes with FTS5/joins | none (extension) |
| Cognee | graph DB + vector DB | 17 search types incl. `CYPHER`, `NATURAL_LANGUAGE`, `CHUNKS_LEXICAL` | BM25 + vector + 1-hop graph triplets; `feedback_weight` | `TEMPORAL` mode; chunk ids for citation |
| OpenClaw builtin | markdown truth; per-agent SQLite | `memory_search`, `memory_get(path,lines)` | FTS5 BM25 + sqlite-vec → recency decay → importance → MMR | origin class, observation time, supersession key in SQLite |
| sqlite-memory | markdown truth; SQLite extension | **SQL**: `SELECT … FROM memory_search WHERE query=` | vector + FTS5 hybrid | content-hash sync; SAVEPOINT ingest |
| memweave | markdown truth; SQLite | Python `search()`; MCP | FTS5 + sqlite-vec 0.7/0.3 → threshold → half-life decay → MMR (Jaccard) | dated-vs-evergreen by filename; `path:line` |
| **Ori 0.6.1** | markdown truth; one SQLite (`.ori/embeddings.db`) | 16 MCP tools, 17 CLI cmds; no SQL | embeddings + hand BM25 + PPR + warmth → RRF → Q-rerank → LinUCB stage gating | `status` frontmatter; `note_access` counters; no validity, no origin |

## Recurring features (≥3 systems)

1. **FTS5 + vector hybrid in one SQLite file** — sqlite-vec, OpenClaw, sqlite-memory, memweave (Cognee/Zep/Honcho/mem0 hybrid elsewhere). Ori: partial (embeddings in SQLite, BM25 in TS).
2. **Files as truth, DB as disposable derived index** — Anthropic, OpenClaw, sqlite-memory, memweave, Ori. ✔ Ori.
3. **Explicit time semantics** (validity, expiry, decay, supersession) — Zep, mem0, OpenClaw, memweave, Cognee. ✘ Ori (ACT-R decay is *access* recency, not fact validity).
4. **Provenance to source** — Graphiti, Cognee, memweave, OpenClaw, Honcho. Ori: file only.
5. **Score explanation** — mem0, Zep, Cognee. Ori: partial (`signals`).
6. **Agent-composed structured query** — Datasette, Cognee, sqlite-memory, sqlite-vec, Anthropic guidance. ✘ Ori.
7. **Two-tier memory: always-in-context vs on-demand** — Letta blocks/archival, OpenClaw `MEMORY.md`/`memory/*.md`, Anthropic view-dir-first, Honcho representation/search, memweave evergreen/dated. ✔ Ori (`self/` injected via `ori_orient`, `notes/` retrieved).
8. **MMR diversity** — Zep, OpenClaw, memweave. ✘ Ori.
9. **No-LLM deterministic retrieval path** — OpenClaw builtin, sqlite-memory, memweave, Ori. ✔ Ori.
10. **Usage feedback into ranking** — Cognee `feedback_weight`, Zep episode-mentions reranker, OpenClaw dreaming recall gates, Ori Q-values. ✔ Ori, and Ori is the only one with per-note learned values plus a per-stage bandit.

## Ori gap analysis

**Has, matched:** 2, 7, 9, 10. **Has that they don't:** learned Q-values + LinUCB stage gating (`README.md:163-189`), co-occurrence Hebbian edges, PPR over wiki-link graph, git-visible memory with no daemon (OpenClaw needs a Gateway; Letta/Honcho/Zep are servers; sqlite-memory and memweave are the only zero-daemon peers, and neither learns).
**Lacks:** 1 (FTS5), 3 (validity/supersession), 4 (origin/trust), 6 (SQL surface), 8 (MMR); 5 partial.

## What's left from the fix-list in this slice

Tier 3 in `docs/fix-list-2026-09-15.md` (FTS5 decision gated by item 6, :291; README overstatement :51-53). Nothing in tiers 0–2 touched the agent surface; F1, F3, F4, F6 above are new.

## Recommendations

R1. **`ori_sql` / `ori query sql <select>` — read-only, schema-described, zero new deps.** Open a second connection `new Database(path, { readonly: true })` (better-sqlite3 `options.readonly`, [api.md:33](https://raw.githubusercontent.com/WiseLibs/better-sqlite3/master/docs/api.md)), reject when `stmt.readonly === false` (api.md:637), enforce `LIMIT ≤ 200` by wrapping as a subquery, and push "truncated" into `warnings`. Companion `ori_schema` returns `SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL` plus a static per-column comment map — the Datasette shape verbatim. Live in `src/cli/query.ts` beside the existing `ori query *` subcommands; register in `serve.ts` next to `ori_query`.

R2. **Expose ranked retrieval *as a table*, so SQL composes with it.** `db.table('ranked', { columns:['title','path','score','composite','keyword','graph','warmth','q'], parameters:['query','limit'], rows: function*(query, limit){…} })` — better-sqlite3 supports read-only table-valued virtual tables in JS (api.md:270-379). Then the agent can write `SELECT r.title, n.type, n.updated_at FROM ranked('sqlite vs postgres', 30) r JOIN note n USING(path) WHERE n.type='decision' ORDER BY r.score DESC` — sqlite-memory's `memory_search` pattern without native code. [INFERENCE] the generator can call the existing ranked pipeline directly; the store seam (`openSyncedIndex`) already separates index from vault.

R3. **FTS5 now** — `CREATE VIRTUAL TABLE note_fts USING fts5(title, body, content='note', content_rowid=rowid, tokenize='porter unicode61')` in `indexstore.ts`, maintained by the same content-hash path that fills `note_term`. This is the fix-list's own measured option and is what makes R1 useful (`MATCH`) and BM25 query-scoped in C instead of TS.

R4. **Validity + supersession in frontmatter, mirrored to the index.** Frontmatter `valid_from`, `valid_until`, `supersedes: [[title]]` (markdown stays truth); columns `note.valid_from TEXT, note.valid_until TEXT, note.supersedes TEXT REFERENCES note(title) ON DELETE SET NULL`. Ranked default: `WHERE valid_until IS NULL OR valid_until > :now`; `--as-of <date>` flips it. This is Zep's `t_valid/t_invalid` in the cheapest form; `t'_created/t'_expired` is git.

R5. **Origin class, DB-owned.** `note.origin TEXT NOT NULL DEFAULT 'agent' CHECK(origin IN ('owner','agent','untrusted','system'))`, set by the writer (`ori add` → agent, CLI edit by human → owner, `promote --from-web` → untrusted), never parsed from frontmatter — OpenClaw's rule that prose cannot rewrite its trust class.

R6. **`why` per result.** Extend `ScoredNote.signals` (`ranking.ts:4`) with `q`, `ucb`, `stages_skipped: string[]` from `stage_log`, and emit it in `ori_query_ranked` output — mem0's `score_details` contract.

R7. **MMR after Q-rerank**, Jaccard over `note_term` rows (memweave's choice; no embeddings needed), λ=0.7 default.

R8. **Do not adopt** LLM extraction at ingest (mem0/Zep/Honcho/Cognee) or a natural-language "dialectic" surface (Honcho) — both violate the no-LLM-fast-path invariant. Read-side SQL is the field's accepted place for model-written queries; write-side stays code.

## Open questions

- Should `ori_sql` see learned-state tables (`note_q`, `stage_q`, `retrieval_log`) or only vault-derived ones? Datasette exposes everything; a `v_*` view layer could hide internals while keeping `schema()` honest.
- Is a `ranked()` table-valued function acceptable latency-wise inside a join (the generator runs the full 350 ms pipeline once per call — fine — but SQLite may re-evaluate it per outer row without a materialized CTE)?
- Does `valid_until` on a note interact with ACT-R decay (`README.md:145`) or replace it for "decision" notes? Zep keeps both timelines; Ori would be conflating access decay with fact validity if it reuses one field.

## Sources

- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://docs.letta.com/v1-sdk/memory/memory-blocks · https://docs.letta.com/v1-sdk/memory/archival-memory · https://docs.letta.com/v1-sdk/concepts/stateful-agents
- https://docs.mem0.ai/core-concepts/memory-operations/add · https://docs.mem0.ai/core-concepts/memory-operations/search
- https://github.com/getzep/graphiti · https://arxiv.org/html/2501.13956v1
- https://github.com/plastic-labs/honcho · https://honcho.dev/docs/v2/documentation/core-concepts/architecture
- https://simonw.substack.com/p/datasette-agent-an-ai-assistant-for · https://raw.githubusercontent.com/simonw/llm-tools-datasette/main/llm_tools_datasette.py
- https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html
- https://docs.cognee.ai/core-concepts/main-operations/legacy-operations/search
- https://docs.openclaw.ai/concepts/memory · https://docs.openclaw.ai/concepts/memory-builtin
- https://github.com/sqliteai/sqlite-memory
- https://towardsdatascience.com/memweave-zero-infra-ai-agent-memory-with-markdown-and-sqlite-no-vector-database-required/
- https://raw.githubusercontent.com/WiseLibs/better-sqlite3/master/docs/api.md
