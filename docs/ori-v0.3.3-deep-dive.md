# Ori Mnemos v0.3.3 — Complete Technical Deep Dive

**Date:** 2026-03-03
**Version:** 0.3.3 (The Emergence Bootstrap)
**Status:** Built, tested, ready for release

---

## What Ori Mnemos Actually Is

**One sentence:** Ori is a local-first, markdown-native memory layer that gives AI agents persistent identity, knowledge, and retrieval — shipped as an npm package that speaks MCP.

### The Stack

```
Layer 4: MCP Server (14 tools, 5 resources)     <- any agent talks to this
Layer 3: Three-Signal Retrieval Engine           <- semantic + keyword + graph
Layer 2: Knowledge Graph + Vitality Model        <- wiki-links, ACT-R decay, spreading activation
Layer 1: Markdown files on disk                  <- git-friendly, human-readable, portable
```

### Installation to Running Agent — The Full Path

1. `npm install -g ori-memory` — installs the `ori` CLI globally
2. `ori init my-agent` — scaffolds a vault: notes/, self/, ops/, templates/, .ori marker, config
3. Add to any MCP client config:
   ```json
   { "mcpServers": { "ori": { "command": "ori", "args": ["serve", "--mcp"] } } }
   ```
4. Agent connects -> Ori reads `self/identity.md` -> if empty, triggers onboarding flow -> agent names itself, gets context, writes its own identity
5. Every session after: `ori_orient` -> agent wakes up knowing who it is, what it's working on, what changed

### The Three Spaces

| Space | Path | Decay Rate | Purpose |
|-------|------|-----------|---------|
| Identity | `self/` | 0.1x (barely decays) | Who the agent IS. Name, personality, goals, methodology |
| Knowledge | `notes/` | 1.0x (normal) | What the agent KNOWS. Ideas, decisions, learnings, connections |
| Operations | `ops/` | 3.0x (fast decay) | What the agent is DOING. Daily tasks, reminders, session state |

### Retrieval — How the Agent Finds What It Needs

When an agent asks `ori_query_ranked "token incentive mechanisms"`:

1. **Intent classification** — 30+ regex patterns detect if this is episodic/procedural/semantic/decision. Adjusts signal weights
2. **Signal 1 (Semantic)** — Embeds the query with all-MiniLM-L6-v2 (local, no API), compares against stored vectors across 6 spaces (text, temporal, vitality, importance, type, community)
3. **Signal 2 (Keyword)** — BM25 with field boosting (title 3x, description 2x). Catches exact terms that embeddings smooth over
4. **Signal 3 (Graph)** — Personalized PageRank seeded from entities in the query. Structurally important notes rank higher
5. **Fusion** — Score-weighted RRF combines all three signals
6. **Activation** (NEW in v0.3.3) — Top 3 results spread vitality boosts to their wiki-link neighbors. Neighbors stay "warm" for future queries
7. **Filter** — Archived notes excluded before trimming to limit

**Cost**: ~850 tokens per query regardless of vault size. At 1,000 notes, that's a 99.6% reduction vs dumping everything into context.

### Vitality — How Notes Live and Die

Every note has a vitality score (0-1) computed from ACT-R cognitive science:

- **Access frequency** — more accesses = higher vitality (diminishing returns)
- **Age** — older notes decay unless accessed
- **Structural links** — incoming wiki-links stabilize against decay
- **Bridge protection** — articulation points (notes that hold the graph together) get a vitality floor of 0.5
- **Revival spike** — dormant note gets a new connection -> 14-day renewal boost
- **Spreading activation** (v0.3.3) — neighbors of accessed notes get a vitality boost that decays over ~7 days

**Zone classification** (v0.3.3): active (>=0.6), stale (>=0.3), fading (>=0.1), archived (<0.1)

`ori prune` shows the topology and identifies archive candidates — notes below the fading floor that aren't structurally critical and have fewer than 2 incoming links.

### What Makes Ori Different From the Landscape

9 competitors analyzed during research:

| System | Storage | Retrieval | Graph | Forgetting | Identity | Local |
|--------|---------|-----------|-------|-----------|----------|-------|
| **Ori** | Markdown | 3-signal fusion | Wiki-link graph | ACT-R + spreading activation | Built-in | Yes |
| SimpleMem | Key-value | Exact match | None | None | None | Yes |
| Memori | JSON | Vector | None | None | None | Partial |
| Mem0 | Cloud DB | Vector | None | None | None | No |
| Zep | Postgres | Vector + temporal | Entity graph | Time-based | None | No |
| Letta | Cloud | Vector | None | Archival tier | Persona | No |
| Cognee | Neo4j | Vector + KG | Entity extraction | None | None | No |
| LangChain Memory | Various | Vector | None | None | None | Depends |
| SideQuest | Markdown | None | None | None | None | Yes |

**No shipped system has graph-aware forgetting.** Ori is first. The spreading activation + zone classification + Tarjan's articulation point protection — that's the technical moat.

**No shipped system has agent identity as a first-class feature.** Letta has "persona" but it's cloud-locked. Ori's identity travels with the vault — move it, git push it, deploy it anywhere.

### What Can Be Built On Top

**VPS Agents**: Install Ori on a VPS, point `--vault` to a persistent directory. Agent runs headless with full memory continuity. Back up with `git push`. Deploy multiple agents with separate vaults.

**Multi-Agent Teams**: Each agent gets its own vault. Cross-agent knowledge sharing via git — push notes from one vault, pull into another. The wiki-link graph handles cross-references.

**Agent-as-a-Service**: Ori's MCP server is the API. Any MCP client connects. Build a web app that spawns agent sessions against a shared vault — the agent remembers every conversation, every decision.

**Research Pipelines**: `ori add` from any script. Webhook dumps data to inbox, agent processes on schedule. `ori query ranked` from cron jobs. The CLI is fully scriptable, returns structured JSON.

**Knowledge-Augmented Applications**: Use Ori as the retrieval backend for any LLM application. The three-signal fusion is more robust than pure vector search. The vitality model prevents stale knowledge from polluting results.

**Discord/Slack Bots**: Agent connects to chat, uses Ori for persistent memory across conversations. Every insight captured, every decision tracked, every connection maintained.

**Personal Knowledge Systems**: Ori isn't just for code agents. It's a second brain that an AI agent maintains for you. Capture ideas conversationally, let the agent classify, connect, and maintain them.

### The Dependency Stack

Everything runs locally:

- **Embeddings**: `@huggingface/transformers` — all-MiniLM-L6-v2 runs in-process, no API
- **Storage**: `better-sqlite3` — WAL-mode SQLite for embeddings + boosts
- **Graph**: `graphology` — PageRank, Louvain clustering, betweenness centrality
- **Protocol**: `@modelcontextprotocol/sdk` — MCP stdio transport
- **Config**: `yaml` parser, `commander` CLI framework

Zero cloud dependencies. Zero API keys required for core functionality. LLM enhancement is opt-in.

### The Numbers

- **14 MCP tools**, 5 MCP resources
- **24 core modules**, 16 CLI commands
- **396 tests** (328 unit + 68 e2e)
- **~850 tokens per query** regardless of vault size
- **~$0.10/session** vs ~$6+ without retrieval
- **Vault-size-independent** query cost

---

## v0.3.3 Changelog — The Emergence Bootstrap

### What's New

**Spreading Activation** — When notes are retrieved, vitality boosts propagate to their wiki-link neighbors via BFS. Boost formula: `utility * damping^hop` (damping=0.6, max 2 hops). Boosts stored in SQLite, not frontmatter. Decay-before-accumulate on write (prevents stale boost laundering), clamped to 1.0. Read-time decay with ~7 day half-life. One DB connection per query, aggregated writes in one transaction.

**Zone Classification** — Notes classified into `active | stale | fading | archived` based on vitality score. Thresholds: active >= 0.6, stale >= 0.3, fading >= 0.1. Frontmatter `status: "archived"` always overrides vitality score.

**ori prune** — New CLI command + MCP tool. Dry-run by default, `--apply` required to mutate. Shows zone distribution, articulation points, archive candidates, community hotspots. Candidate rule: below fading floor + not already archived + not articulation point + inDegree < 2.

**Archived Exclusion** — `ori_query_ranked` and `ori_query_similar` filter out `status: "archived"` notes by default. Filtering happens before result trimming. MCP tools expose `include_archived` parameter to override.

### Files Created/Changed

| File | Action |
|------|--------|
| `src/core/vitality.ts` | Zone types + classifyZone + activationBoost param |
| `src/core/config.ts` | ZoneConfig + ActivationConfig |
| `src/core/activation.ts` | **NEW** — spreading activation engine |
| `src/core/noteindex.ts` | **NEW** — shared helpers extracted from search.ts |
| `src/core/engine.ts` | Added boosts table to initDB |
| `src/cli/search.ts` | Archive filter, activation wiring, uses noteindex.ts |
| `src/cli/prune.ts` | **NEW** — prune command |
| `src/cli/serve.ts` | ori_prune tool, include_archived params, version bump |
| `src/index.ts` | prune CLI command, version bump |
| `package.json` | Version 0.3.3 |
| `tests/core/vitality.test.ts` | +12 zone classification tests |
| `tests/core/activation.test.ts` | **NEW** — 17 tests |
| `tests/cli/prune.test.ts` | **NEW** — 7 tests |
| `tests/mcp/server.test.ts` | Version + tool count update |

---

## Full Module Map

### Core Modules (24 files in src/core/)

**Vault Management**
- `vault.ts` — Vault discovery (walk up tree, project vs global), paths structure, title listing
- `config.ts` — YAML config loading with 10 subsections. Full defaults applied on load
- `frontmatter.ts` — YAML frontmatter parsing/serialization

**Knowledge Graph & Structure**
- `graph.ts` — Wiki-link extraction (`[[title]]` regex), bidirectional edge maps, orphan/dangling detection
- `importance.ts` — PageRank, Louvain communities, betweenness centrality, bridge detection (Tarjan's articulation points + hub multiplier)
- `linkdetect.ts` — Mention detection, semantic link suggestions (title-match, tag-overlap, project-overlap, shared-neighborhood)

**Semantic Search & Embedding**
- `engine.ts` — SQLite with WAL, Xenova/all-MiniLM-L6-v2 (384 dims), knowledge-enriched text, composite vector search across 6 semantic spaces
- `bm25.ts` — Full BM25 with field-level weighting (title 3x, desc 2x, body 1x), stopword filtering

**Retrieval & Ranking**
- `intent.ts` — Query intent classification (episodic, procedural, semantic, decision) via 30+ patterns
- `fusion.ts` — Score-weighted Reciprocal Rank Fusion combining 3 signals
- `ranking.ts` — Rank by importance, vitality, or fading
- `activation.ts` — Spreading activation BFS, SQLite boost storage, exponential decay

**Vitality Model**
- `vitality.ts` — ACT-R base activation, metabolic rate, structural boost, access saturation, revival spike, activation boost, bridge floor, zone classification
- `noteindex.ts` — Shared frontmatter map + vitality computation (used by search + prune)

**Note Lifecycle**
- `classify.ts` — Type detection via 50+ heuristic patterns
- `promote.ts` — Promotion pipeline: classify, detect links, suggest areas, format, validate
- `schema.ts` — Template schema validation

**Configuration & Tracking**
- `llm.ts` — Provider abstraction: Null, Anthropic, OpenAI-compatible
- `tracking.ts` — IPS access logging, propensity scoring, exploration injection

### CLI Commands (16 files in src/cli/)

| Command | File | Purpose |
|---------|------|---------|
| `ori init` | init.ts | Scaffold vault from template |
| `ori status` | status.ts | Vault overview |
| `ori health` | health.ts | Full diagnostics |
| `ori add` | add.ts | Capture to inbox |
| `ori promote` | promote.ts | Inbox -> notes with classification |
| `ori archive` | archive.ts | Archive stale notes |
| `ori validate` | validate.ts | Schema check |
| `ori prune` | prune.ts | Zone topology + archive candidates |
| `ori query` | query.ts | Graph queries (orphans, dangling, backlinks, cross-project, important, fading) |
| `ori query ranked` | search.ts | Three-signal retrieval |
| `ori query similar` | search.ts | Semantic search only |
| `ori index` | indexcmd.ts | Build/status embedding index |
| `ori graph` | graphcmd.ts | Metrics/communities |
| `ori serve --mcp` | serve.ts | MCP server (14 tools, 5 resources) |
| `ori bridge` | bridge.ts | Claude Code integration hooks |

### MCP Tools (14)

| Tool | Purpose |
|------|---------|
| `ori_orient` | Session briefing — daily, goals, reminders, health |
| `ori_update` | Write identity/goals/methodology/daily/reminders |
| `ori_status` | Vault overview |
| `ori_health` | Full diagnostics |
| `ori_add` | Capture to inbox |
| `ori_promote` | Promote with classification + linking |
| `ori_validate` | Schema check |
| `ori_query` | Graph queries |
| `ori_query_ranked` | Three-signal retrieval + spreading activation |
| `ori_query_similar` | Semantic search only |
| `ori_query_important` | PageRank ranking |
| `ori_query_fading` | Vitality-based detection |
| `ori_prune` | Zone topology + archive candidates |
| `ori_index_build` | Build/update embedding index |

---

## The Pitch

"We built the first AI memory system with graph-aware forgetting — notes that are used stay alive, their neighbors stay warm via spreading activation, structurally critical nodes are protected by Tarjan's algorithm, and everything else gracefully fades. All local, all markdown, all portable."

---

## Resume Lines

- Built Ori Mnemos: open-source persistent memory infrastructure for AI agents (npm: ori-memory, Apache-2.0)
- Designed three-signal retrieval engine fusing semantic embeddings, BM25 keyword search, and personalized PageRank — 99.6% token reduction at 1K notes
- Implemented first graph-aware forgetting system in the AI memory space: ACT-R vitality model + spreading activation + Tarjan's articulation point protection
- Shipped agent identity layer over Model Context Protocol (MCP) — agents persist personality, goals, and methodology across sessions and clients
- 24 core modules, 14 MCP tools, 396 tests, zero cloud dependencies
