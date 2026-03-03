# Ori Mnemos — Cross-Client MCP Configuration

Ori works with any MCP-compatible client over stdio transport. Below are tested configurations.

## Claude Code (Claude Desktop)

Add to your project's `.mcp.json` or `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "ori": {
      "command": "npx",
      "args": ["-y", "ori-memory", "serve", "--mcp", "--vault", "/path/to/your/vault"],
      "autoapprove": [
        "ori_orient", "ori_status", "ori_query", "ori_health",
        "ori_query_ranked", "ori_query_similar", "ori_query_important",
        "ori_query_fading", "ori_validate", "ori_index_build"
      ]
    }
  }
}
```

## Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "ori": {
      "command": "npx",
      "args": ["-y", "ori-memory", "serve", "--mcp", "--vault", "/path/to/your/vault"]
    }
  }
}
```

## Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "ori": {
      "command": "npx",
      "args": ["-y", "ori-memory", "serve", "--mcp", "--vault", "/path/to/your/vault"]
    }
  }
}
```

## Cline (VS Code Extension)

Add to Cline MCP settings (accessible via Cline sidebar → MCP Servers):

```json
{
  "mcpServers": {
    "ori": {
      "command": "npx",
      "args": ["-y", "ori-memory", "serve", "--mcp", "--vault", "/path/to/your/vault"],
      "disabled": false
    }
  }
}
```

## Generic MCP Client (SDK)

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "ori-memory", "serve", "--mcp", "--vault", "/path/to/vault"],
});

const client = new Client({ name: "my-app", version: "1.0.0" });
await client.connect(transport);

// List tools
const { tools } = await client.listTools();

// Call a tool
const result = await client.callTool({
  name: "ori_query_ranked",
  arguments: { query: "agent memory patterns", limit: 5 },
});
```

## Verification

After configuring, verify Ori is connected by asking your AI agent:

> "What tools do you have from Ori?"

It should list 13 tools starting with `ori_orient`, `ori_status`, etc.

Then test with:

> "Run ori_status to check the vault"

## Notes

- Replace `/path/to/your/vault` with your actual vault directory
- Ori discovers the vault root by looking for `.ori/` marker directory
- The `--vault` flag is required when running via npx (no cwd inference)
- All 13 tools and 5 resources are available in every client
- No API keys or cloud services required — everything runs locally
