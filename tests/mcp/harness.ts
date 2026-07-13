/**
 * Ori Mnemos — MCP Test Harness
 *
 * Spawns `ori serve --mcp` as a child process pointed at a temp vault,
 * connects via StdioClientTransport, and provides a clean API for tests.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/init.js";

export type McpTestContext = {
  client: Client;
  transport: StdioClientTransport;
  vaultDir: string;
  cleanup: () => Promise<void>;
};

/**
 * Create a fresh vault, spawn the MCP server, connect a client.
 * Returns a context object with client, vaultDir, and cleanup function.
 */
export async function createMcpTestContext(): Promise<McpTestContext> {
  // Create temp vault
  const vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-mcp-test-"));
  await runInit({ targetDir: vaultDir });

  // Find the built dist/index.js
  const distIndex = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "dist",
    "index.js"
  );

  // Spawn MCP server via StdioClientTransport
  const transport = new StdioClientTransport({
    command: "node",
    args: [distIndex, "serve", "--mcp"],
    cwd: vaultDir,
    stderr: "pipe",
  });

  const client = new Client(
    { name: "ori-test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);

  const cleanup = async () => {
    try {
      await client.close();
    } catch {
      // Server may already be closed
    }
    await fs.rm(vaultDir, { recursive: true, force: true });
  };

  return { client, transport, vaultDir, cleanup };
}

/**
 * Helper to call a tool and parse the JSON response.
 */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ parsed: unknown; raw: unknown }> {
  const result = await client.callTool({ name, arguments: args });
  const textContent = result.content as Array<{ type: string; text: string }>;
  const text = textContent[0]?.text ?? "{}";
  return { parsed: JSON.parse(text), raw: result };
}
