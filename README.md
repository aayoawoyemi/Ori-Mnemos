# Ori Mnemos

**Persistent memory infrastructure for AI agents.**

If models are compute and tools are actions, Ori is continuity.

Every agent session starts from near-zero context. Decisions get repeated. Learnings disappear. Identity resets. Ori fixes this with a markdown-native memory layer that any agent runtime can read, write, and reason over — no database, no cloud dependency, no lock-in.

Install it. Point your agent at it. It wakes up knowing who it is.

```
npm install -g ori-memory
```

---

## Why This Exists

The industry has invested heavily in reasoning, tool use, and context windows. Memory is still an afterthought — most agents store nothing between sessions, or dump everything into a vector database that loses structure, relationships, and meaning.

Ori takes a different position: memory should be **files on disk**. Plain markdown, YAML frontmatter, wiki-links as graph edges, git as version control. The same format humans read and write. The same format that diffs, merges, and deploys.

This is not a note-taking app. It is infrastructure — the layer between an agent's context window and its long-term knowledge.

---

## Architecture

```
                          Any MCP Client
                    (Claude, Cursor, Windsurf,
                     Cline, custom agents, VPS)
                              |
                        MCP Protocol
                        (stdio / JSON-RPC)
                              |
                    +-------------------+
                    |    Ori MCP Server  |
                    |                   |
                    |  instructions     |  <-- Agent identity auto-injected at connect
                    |  resources        |  <-- 5 identity resources (ori://)
                    |  13 tools         |  <-- Full memory operations
                    +-------------------+
                              |
          +-------------------+-------------------+
          |                   |                   |
    +-----------+      +------------+      +------------+
    | Knowledge |      |  Identity  |      | Operations |
    |   Graph   |      |   Layer    |      |   Layer    |
    |           |      |            |      |            |
    |  notes/   |      |  self/     |      |  ops/      |
    |  inbox/   |      |  identity  |      |  daily     |
    |  templates|      |  goals     |      |  reminders |
    |           |      |  method.   |      |  sessions  |
    +-----------+      +------------+      +------------+
          |
    +-----+------+
    |            |
 Wiki-link   Embedding
  Graph       Index
 (in-memory)  (SQLite)
    |            |
 PageRank    Semantic
 Backlinks   Search
 Orphans     BM25
 Communities 3-Signal Fusion
```

Three memory spaces, one protocol surface, zero external dependencies.

---

## What v0.3 Ships

### Agent Identity Layer

The defining feature of v0.3. Agents that connect to an Ori vault wake up as themselves.

**How it works:** When an MCP client connects, Ori reads the vault's `self/` directory and injects the agent's identity, goals, and methodology into the MCP `instructions` field. The agent receives this context automatically — no configuration on the client side, no CLAUDE.md, no system prompts to maintain.

Identity travels with the vault. Move the vault to a new machine, connect a different client, deploy to a VPS — the agent is the same agent.

On first connection to a fresh vault, Ori detects the empty identity and guides the agent through onboarding: naming, purpose, initial context. The agent writes its own identity using `ori_update`. Every session after that, it wakes up knowing who it is.

**MCP Resources** expose identity as readable endpoints:

| Resource | URI | Contents |
|----------|-----|----------|
| Identity | `ori://identity` | Agent name, personality, values |
| Goals | `ori://goals` | Active threads, milestones, priorities |
| Methodology | `ori://methodology` | Processing principles, session rhythm |
| Daily | `ori://daily` | Today's completed and pending work |
| Reminders | `ori://reminders` | Time-bound commitments |

**`ori_orient`** is the session briefing tool. Call it at session start — it returns daily status, active goals, reminders, vault health, and (optionally) full identity context. The agent starts every session with situational awareness.

**`ori_update`** lets the agent write back to its identity files. Goals shift, methodology evolves, daily state changes — the agent maintains its own continuity.

---

### Three-Signal Retrieval Engine

Most memory systems rely on a single retrieval signal — usually vector similarity. Ori fuses three independent signals to surface the right notes:

**Semantic signal.** Local embeddings via `all-MiniLM-L6-v2` running in-process. No API calls, no external service. Notes are embedded with composite metadata (title, description, body, type, community). Stored in SQLite. Incrementally indexed — only changed notes get re-embedded.

**Keyword signal.** BM25 with field-level boosting. Title matches weight 3x, description 2x, body 1x. Handles exact terminology that embedding models smooth over.

**Graph signal.** PageRank importance from the wiki-link graph. Notes with high structural authority rank higher. Community membership from Louvain clustering adds topical coherence.

These signals combine through score-weighted Reciprocal Rank Fusion (RRF) with per-signal breakdown in the response. The engine classifies query intent (episodic, procedural, semantic, decision) to adjust signal weights dynamically.

```bash
ori query ranked "token incentive mechanisms"
ori query similar "how does session capture work"
ori query important --limit 20
ori query fading --threshold 0.3
```

---

### Vitality Model

Notes decay. Ori models this explicitly using activation functions from ACT-R cognitive science literature.

Each note has a vitality score computed from:
- **Access frequency and recency** — how often and how recently the note was touched
- **Structural connectivity** — incoming links stabilize notes against decay
- **Metabolic rate** — identity files (`self/`) decay 10x slower than operational files (`ops/`)
- **Bridge bonus** — notes connecting otherwise disconnected clusters get a vitality floor
- **Revival spike** — new connections to dormant notes trigger a 14-day renewal

`ori query fading` surfaces notes losing vitality. These are candidates for reconnection, updating, or archival — not deletion.

---

### Knowledge Graph

Every wiki-link (`[[note title]]`) is a directed edge. Ori builds the graph in memory and exposes structural queries:

| Query | What it finds |
|-------|---------------|
| `orphans` | Notes with zero incoming links |
| `dangling` | Broken wiki-links pointing to non-existent notes |
| `backlinks` | All notes linking to a given note |
| `cross-project` | Notes tagged with multiple projects |
| `important` | Notes ranked by PageRank authority |
| `fading` | Notes below a vitality threshold |

Graph metrics include PageRank, betweenness centrality, and community detection via Louvain algorithm. Communities inform the retrieval engine — notes in the same cluster get a relevance boost.

---

### Note Lifecycle

Notes follow a controlled path:

```
Capture (inbox/) --> Promote (notes/) --> Connect --> Decay/Archive
```

**Capture.** `ori add "Title as a complete claim"` writes to `inbox/` with YAML frontmatter. Titles are prose — they work as statements when wiki-linked.

**Promote.** `ori promote` moves notes from inbox to the knowledge graph. Automatic type classification (idea, decision, learning, insight, blocker, opportunity) via 50+ heuristic patterns. Automatic link detection and area suggestion. Optional LLM enhancement.

**Validate.** Schema enforcement against YAML templates. Required fields, enum constraints, description quality checks. Run on individual notes or vault-wide.

**Archive.** `ori archive` moves isolated or stale notes out of the active graph.

---

## Quick Start

### 1. Install

```bash
npm install -g ori-memory
```

Requires Node.js 18+.

### 2. Initialize a vault

```bash
ori init my-agent
cd my-agent
```

This creates the full vault structure: knowledge graph, identity layer, operational state, templates, and configuration.

### 3. Connect your agent

Add Ori to your MCP client configuration:

```json
{
  "mcpServers": {
    "ori": {
      "command": "ori",
      "args": ["serve", "--mcp"]
    }
  }
}
```

Start a session. The agent receives its identity automatically and begins onboarding on first run.

---

## MCP Integration

Ori exposes a full memory surface over the Model Context Protocol. Any MCP-compatible runtime can connect — Claude Code, Cursor, Windsurf, Cline, custom agent loops, headless agents on a VPS.

The server runs over stdio (JSON-RPC 2.0). No ports to configure, no authentication layer, no network exposure. If the runtime can spawn a subprocess, it can use Ori.

### Tools

| Tool | Description |
|------|-------------|
| `ori_orient` | Session briefing — daily status, goals, reminders, vault health. Supports brief and full modes. |
| `ori_update` | Write to identity, goals, methodology, daily, or reminders. Auto-backs up previous version. |
| `ori_status` | Vault overview — note count, inbox size, health summary. |
| `ori_query` | Graph queries — orphans, dangling links, backlinks, cross-project notes. |
| `ori_add` | Capture a note to inbox with prose-as-title. |
| `ori_promote` | Promote inbox note to knowledge graph with classification, linking, and area assignment. |
| `ori_validate` | Schema validation against templates. |
| `ori_health` | Full vault diagnostics. |
| `ori_query_ranked` | Three-signal retrieval with intent classification. |
| `ori_query_similar` | Semantic search (vector similarity only, faster). |
| `ori_query_important` | Notes ranked by PageRank structural authority. |
| `ori_query_fading` | Notes below a vitality threshold — candidates for reconnection or archival. |
| `ori_index_build` | Build or update the embedding index. Incremental by default. |

### Explicit vault path

For agents running outside the vault directory (VPS deployments, global configurations, multi-vault setups):

```json
{
  "mcpServers": {
    "ori": {
      "command": "ori",
      "args": ["serve", "--mcp", "--vault", "/path/to/vault"]
    }
  }
}
```

### Response format

All tools return a consistent envelope:

```json
{
  "success": true,
  "data": {},
  "warnings": []
}
```

---

## Vault Structure

```
vault/
├── .ori                       Vault marker
├── ori.config.yaml            Configuration
├── notes/                     Knowledge graph
│   └── index.md               Hub — entry point to all maps
├── inbox/                     Capture buffer
├── templates/
│   ├── note.md                Note schema (6 types, required/optional fields)
│   └── map.md                 Map of Content schema
├── self/                      Agent identity
│   ├── identity.md            Name, personality, values
│   ├── goals.md               Active threads, priorities
│   ├── methodology.md         Processing principles, session rhythm
│   └── memory/                Atomic agent insights
└── ops/                       Operational state
    ├── daily.md               Today's work — completed, pending
    ├── reminders.md           Time-bound commitments
    ├── sessions/              Session logs
    └── observations/          Friction signals, process gaps
```

Three spaces with distinct purposes:

- **`self/`** — Who the agent is. Decays slowly. Persists across sessions, clients, and machines.
- **`notes/`** — What the agent knows. The knowledge graph. Wiki-links, frontmatter, flat structure.
- **`ops/`** — What the agent is doing. Daily state, session captures, coordination. Decays fast.

Every file is plain markdown. Every file is diffable, mergeable, inspectable. `git log` is your audit trail.

---

## CLI Reference

```
ori init [dir]                                  Scaffold a new vault
ori status                                      Vault overview
ori health                                      Full diagnostics

ori add <title> [--type <type>]                 Capture to inbox
ori promote [note] [--all] [--dry-run]          Promote to knowledge graph
    [--type] [--description] [--links] [--project]
ori validate <path>                             Schema validation
ori archive [--dry-run]                         Archive stale notes

ori query orphans                               Notes with no incoming links
ori query dangling                              Broken wiki-links
ori query backlinks <note>                      What links to this note
ori query cross-project                         Multi-project notes
ori query ranked <query> [--limit N]            Three-signal retrieval
ori query similar <query> [--limit N]           Semantic search
ori query important [--limit N]                 PageRank ranking
ori query fading [--threshold N] [--limit N]    Vitality-based detection

ori index build [--force]                       Build embedding index
ori index status                                Index statistics
ori graph metrics                               PageRank, centrality
ori graph communities                           Louvain clustering

ori serve --mcp [--vault <path>]                Run MCP server
ori bridge claude-code [--global]               Install Claude Code integration
```

---

## Claude Code Bridge

For Claude Code users, the bridge adds lifecycle automation on top of the MCP server:

```bash
ori bridge claude-code           # Project scope
ori bridge claude-code --global  # All projects
```

This installs three hooks:

- **SessionStart** — Runs vault health check and displays status on every session open.
- **PostToolUse** — Validates notes after creation against schema.
- **Stop** — Captures session summary to inbox before exit.

Global mode installs hooks to `~/.claude/hooks/ori/` and merges settings into `~/.claude/settings.json`. Idempotent on repeat runs. Exits cleanly in non-vault directories.

---

## Configuration

`ori.config.yaml` controls all tunable parameters. Generated on `ori init` with sensible defaults.

Key sections:

| Section | Controls |
|---------|----------|
| `vault` | Version tracking |
| `templates` | Default template, type-specific overrides |
| `vitality` | Decay parameters, metabolic rates, bridge bonus |
| `promote` | Auto-promotion, project routing, confidence thresholds |
| `llm` | Provider (Anthropic, OpenAI-compatible), model, API key |
| `graph` | PageRank alpha, hub multiplier, bridge vitality floor |
| `engine` | Embedding model, database path, dimensions |
| `retrieval` | RRF k, signal weights, exploration budget |
| `bm25` | k1, b, field boosts |

### LLM integration

LLM enhancement is optional. Every operation works deterministically with heuristics alone. When configured, LLM improves classification accuracy, link suggestions, and metadata quality.

Supported providers:

- **Anthropic** — Claude models via API
- **OpenAI-compatible** — Any provider exposing the OpenAI chat completions endpoint (OpenAI, Ollama, LM Studio, Together, Groq, local models)

```yaml
llm:
  provider: openai-compat
  model: gpt-4o
  apiKeyEnv: OPENAI_API_KEY
  baseUrl: https://api.openai.com/v1
```

For local models:

```yaml
llm:
  provider: openai-compat
  model: llama3
  baseUrl: http://localhost:11434/v1
```

---

## Deployment

Ori runs anywhere Node.js runs.

**Local development.** Install globally, `ori init`, connect your editor's MCP client.

**VPS / headless agents.** Install Ori on the server. Point the MCP config to the vault path with `--vault`. The agent connects over stdio — no ports, no HTTP, no auth layer needed. Memory persists on the filesystem. Back up with git push.

**Multi-vault.** Run separate Ori instances for separate agents. Each vault is self-contained. Each agent has its own identity, knowledge graph, and operational state.

**CI / automation.** Ori's CLI is scriptable. `ori health` returns structured JSON. `ori query ranked` searches the knowledge graph. `ori add` captures from any pipeline. Use it in cron jobs, webhook handlers, or agent orchestration loops.

---

## Design Principles

**Markdown-native.** Plain files. No proprietary format, no binary blobs, no opaque database. If Ori disappears tomorrow, your knowledge is still readable markdown files in a git repository.

**Agent-native.** Designed for autonomous loops, not manual note-taking. The capture-promote-validate pipeline enforces quality without requiring human intervention. The agent maintains its own memory.

**Human-legible.** Every file is inspectable. Open the vault in any text editor, file browser, or Obsidian. Frontmatter is YAML. Links are wiki-links. Structure is directories.

**No lock-in.** Git is the sync layer. The filesystem is the database. Switching agents, clients, or providers requires changing one MCP config line. The vault is portable.

**Deterministic core.** Every operation works without an LLM. Heuristic classification, pattern-based link detection, graph algorithms, BM25 search — all run locally with zero API calls. LLM enhancement is opt-in and gracefully degrades.

---

## Development

```bash
git clone https://github.com/aayoawoyemi/OriMnemos.git
cd OriMnemos
npm install
npm run build
npm link
ori --version
```

```bash
npm test              # Run test suite
npm run lint          # Type check
npm run dev           # Watch mode
npm run smoke:bin     # Verify CLI binary
npm run pack:check    # Validate package structure
```

---

## License

Apache-2.0
