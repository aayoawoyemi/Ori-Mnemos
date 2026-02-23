# Ori Mnemos

Memory infrastructure for AI agents.

Ori is an open source, markdown-native system that gives agents persistent, shared, human-readable memory without a database.

v0.2.0 - TypeScript CLI + MCP server + Claude Code bridge.

## The Problem

Most agent workflows restart from near-zero context each session.  
That causes repeated decisions, inconsistent behavior, and lost learning.

Tooling has focused on reasoning and tool-calling, but memory is still treated as an addon.  
Ori treats memory as first-class infrastructure.

## What Ori Does

- Scaffolds a vault with standard memory spaces.
- Captures new memory through a controlled inbox write path.
- Validates note quality against template-defined schema.
- Builds and queries a wiki-link graph.
- Runs full vault diagnostics (schema + links + vitality fade signals).
- Exposes memory operations as MCP tools for agent runtimes.

## Core Principles

- Markdown-native: plain files, not opaque storage.
- Agent-native: designed for autonomous loops, not manual note apps.
- Human-legible: inspectable, editable, versionable.
- No lock-in: works with git + filesystem; no required cloud/database.
- Deterministic core: all operations work without an LLM. Enhancement is opt-in.

## Installation

```bash
npx ori-memory init my-vault
```

## Local Development

For contributors and source builds:

```bash
npm install
npm run build
npm link
ori --version
```

## Quick Start

Initialize a vault:

```bash
ori init my-vault
cd my-vault
```

Inspect and diagnose:

```bash
ori status
ori health
```

Capture and validate:

```bash
ori add "Memory is the missing layer in agents"
ori validate inbox/memory-is-the-missing-layer-in-agents.md
```

Query structure:

```bash
ori query orphans
ori query dangling
ori query backlinks index
ori query cross-project
```

## Commands

- `ori init [dir]`
- `ori status`
- `ori health`
- `ori query <orphans|dangling|backlinks|cross-project> [note]`
- `ori add <title> [--type <type>]`
- `ori promote [note] [--dry-run] [--type] [--description] [--links] [--project]`
- `ori archive [--dry-run]`
- `ori validate <notePath>`
- `ori bridge claude-code [--global]`
- `ori serve --mcp`

## Claude Code Bridge

Ori's MCP server works with any MCP-compatible client. The Claude Code bridge adds deeper integration: session hooks, validate-on-write, and capture-on-stop.

Project scope:

```bash
ori bridge claude-code
```

Global scope:

```bash
ori bridge claude-code --global
```

Global mode:

- installs hooks under `~/.claude/hooks/ori/`
- merges into `~/.claude/settings.json`
- is idempotent on repeat runs
- exits cleanly in non-vault directories

## MCP Server

Run stdio MCP server:

```bash
ori serve --mcp
```

Client config example:

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

Compatible with Claude Code, Cursor, Windsurf, and any MCP-compliant runtime.

Tools:

- `ori_status`
- `ori_query`
- `ori_add`
- `ori_validate`
- `ori_health`
- `ori_promote`

Response envelope:

```json
{
  "success": true,
  "data": {},
  "warnings": []
}
```

## Vault Structure

```text
vault/
|-- .ori
|-- ori.config.yaml
|-- inbox/
|-- notes/
|-- templates/
|-- ops/
|   |-- sessions/
|   +-- observations/
```

## v0.2 Scope

Included:

- Vault scaffold + config defaults
- Template-based schema validation
- Graph queries (orphans, dangling, backlinks, cross-project)
- Health diagnostics with vitality fade detection
- Inbox capture path (`ori add`) with optional auto-promotion
- Promotion pipeline: heuristic classification, link detection, graph-based suggestions, footer injection (`ori promote`)
- Archive workflow for old/isolated notes (`ori archive`)
- LLM-enhanced promotion via Anthropic API (opt-in; Anthropic is the only supported provider in v0.2)
- Claude Code bridge (project + global)
- MCP transport and tool surface

Not yet included:

- Additional LLM providers beyond Anthropic
- Multi-runtime bridge generators beyond Claude Code
- Hosted sync/distribution layer

## Development

```bash
npm run lint
npm test
npm run build
npm run check:v01
```

## Positioning

Ori is best understood as memory infrastructure for agent systems, not a note-taking app.

If models are compute and tools are actions, Ori is continuity.

## Roadmap

See `ROADMAP.md` for planned evolution from v0.1 foundations to broader protocol and SDK surface.

## License

Apache-2.0
