/**
 * Ori Mnemos — MCP Server Integration Tests
 *
 * Tests the MCP server end-to-end over stdio JSON-RPC 2.0.
 * Each test suite creates a fresh vault, spawns the server, runs operations,
 * and tears everything down.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { VERSION } from "../../src/core/version.js";
import { promises as fs } from "node:fs";

import path from "node:path";
import { createMcpTestContext, callTool, type McpTestContext } from "./harness.js";

let ctx: McpTestContext;

beforeAll(async () => {
  ctx = await createMcpTestContext();
}, 30000); // Server startup + embedding model download can be slow

afterAll(async () => {
  await ctx?.cleanup();
});

// ---------------------------------------------------------------------------
// 1. SERVER INITIALIZATION
// ---------------------------------------------------------------------------

describe("server initialization", () => {
  it("reports correct server name and version", () => {
    const info = ctx.client.getServerVersion();
    expect(info?.name).toBe("ori-memory");
    expect(info?.version).toBe(VERSION);
  });

  it("provides instructions string", () => {
    const instructions = ctx.client.getInstructions();
    expect(instructions).toBeDefined();
    expect(typeof instructions).toBe("string");
    expect(instructions!.length).toBeGreaterThan(0);
  });

  it("detects first-run on fresh vault and includes onboarding in instructions", () => {
    const instructions = ctx.client.getInstructions();
    // Fresh vault = first run, so instructions should mention onboarding
    expect(instructions).toMatch(/NEW vault|onboarding|AGENT NAME/i);
  });
});

// ---------------------------------------------------------------------------
// 2. TOOLS LISTING
// ---------------------------------------------------------------------------

describe("tools listing", () => {
  it("lists all exposed tools", async () => {
    const result = await ctx.client.listTools();
    const toolNames = result.tools.map((t) => t.name).sort();

    expect(toolNames).toEqual([
      "ori_add",
      "ori_explore",
      "ori_explore_conclude",
      "ori_explore_expand",
      "ori_explore_start",
      "ori_health",
      "ori_index_build",
      "ori_orient",
      "ori_promote",
      "ori_prune",
      "ori_query",
      "ori_query_fading",
      "ori_query_important",
      "ori_query_ranked",
      "ori_query_similar",
      "ori_status",
      "ori_update",
      "ori_update_decision",
      "ori_validate",
      "ori_warmth",
    ]);
  });

  it("every tool has a description", async () => {
    const result = await ctx.client.listTools();
    for (const tool of result.tools) {
      expect(tool.description, `${tool.name} missing description`).toBeTruthy();
    }
  });

  it("every tool has an input schema", async () => {
    const result = await ctx.client.listTools();
    for (const tool of result.tools) {
      expect(tool.inputSchema, `${tool.name} missing inputSchema`).toBeDefined();
    }
  });
});

describe("ori_warmth", () => {
  it("returns an empty warmth field on a fresh vault", async () => {
    const { parsed } = await callTool(ctx.client, "ori_warmth", {
      context: "token incentives and memory resonance",
      limit: 5,
    });
    const data = parsed as {
      success: boolean;
      data: { results: unknown[]; count: number };
    };

    expect(data.success).toBe(true);
    expect(Array.isArray(data.data.results)).toBe(true);
    expect(data.data.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. RESOURCES
// ---------------------------------------------------------------------------

describe("resources", () => {
  it("lists all 5 resources", async () => {
    const result = await ctx.client.listResources();
    const uris = result.resources.map((r) => r.uri).sort();

    expect(uris).toEqual([
      "ori://daily",
      "ori://goals",
      "ori://identity",
      "ori://methodology",
      "ori://reminders",
    ]);
  });

  it("reads identity resource", async () => {
    const result = await ctx.client.readResource({ uri: "ori://identity" });
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].mimeType).toBe("text/markdown");
  });

  it("reads goals resource", async () => {
    const result = await ctx.client.readResource({ uri: "ori://goals" });
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].mimeType).toBe("text/markdown");
  });

  it("resource content updates after ori_update", async () => {
    // Write new identity
    await callTool(ctx.client, "ori_update", {
      file: "identity",
      content: "# My Agent\n\nI am a test agent named TestBot.",
    });

    // Read it back via resource
    const result = await ctx.client.readResource({ uri: "ori://identity" });
    const text = result.contents[0].text as string;
    expect(text).toContain("TestBot");
  });
});

// ---------------------------------------------------------------------------
// 4. ori_status
// ---------------------------------------------------------------------------

describe("ori_status", () => {
  it("returns vault status with note count", async () => {
    const { parsed } = await callTool(ctx.client, "ori_status");
    const data = parsed as { success: boolean; data: Record<string, unknown> };

    expect(data.success).toBe(true);
    expect(typeof data.data.noteCount).toBe("number");
    expect(typeof data.data.inboxCount).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// 5. ori_orient
// ---------------------------------------------------------------------------

describe("ori_orient", () => {
  it("returns briefing in brief mode (default)", async () => {
    const { parsed } = await callTool(ctx.client, "ori_orient");
    const data = parsed as Record<string, unknown>;

    expect(data).toHaveProperty("daily");
    expect(data).toHaveProperty("reminders");
    expect(data).toHaveProperty("vaultStatus");
    expect(data).toHaveProperty("timestamp");
    expect(data).toHaveProperty("goals");
  });

  it("returns full context in non-brief mode", async () => {
    const { parsed } = await callTool(ctx.client, "ori_orient", {
      brief: false,
    });
    const data = parsed as Record<string, unknown>;

    expect(data).toHaveProperty("identity");
    expect(data).toHaveProperty("goals");
    expect(data).toHaveProperty("methodology");
  });

  it("includes firstRun flag in response", async () => {
    // Note: firstRun depends on whether identity has been written by earlier tests.
    // We just verify the field exists and is a boolean.
    const { parsed } = await callTool(ctx.client, "ori_orient");
    const data = parsed as Record<string, unknown>;

    expect(typeof data.firstRun).toBe("boolean");
    // If firstRun is true, onboarding should be present
    if (data.firstRun) {
      expect(data).toHaveProperty("onboarding");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. ori_add
// ---------------------------------------------------------------------------

describe("ori_add", () => {
  it("creates a note successfully", async () => {
    const { parsed } = await callTool(ctx.client, "ori_add", {
      title: "test note created via mcp server integration test",
      type: "insight",
      content: "This note was created through the MCP protocol.",
    });
    const data = parsed as { success: boolean; data: Record<string, unknown> };

    expect(data.success).toBe(true);
    expect(data.data.path).toBeDefined();
  });

  it("rejects invalid titles", async () => {
    const { parsed } = await callTool(ctx.client, "ori_add", {
      title: "x",
      type: "insight",
    });
    const data = parsed as { success: boolean };

    expect(data.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. ori_update
// ---------------------------------------------------------------------------

describe("ori_update", () => {
  it("updates identity file", async () => {
    const newContent = "# Agent Identity\n\nName: IntegrationTestBot\nStyle: Direct and concise.";
    const { parsed } = await callTool(ctx.client, "ori_update", {
      file: "identity",
      content: newContent,
    });
    const data = parsed as { success: boolean; backed_up: boolean };

    expect(data.success).toBe(true);

    // Verify file was written
    const filePath = path.join(ctx.vaultDir, "self", "identity.md");
    const written = await fs.readFile(filePath, "utf8");
    expect(written).toBe(newContent);
  });

  it("creates backup before overwrite", async () => {
    // First write
    await callTool(ctx.client, "ori_update", {
      file: "goals",
      content: "# Goals v1\n\nFirst version.",
    });

    // Second write — should create backup of v1
    const { parsed } = await callTool(ctx.client, "ori_update", {
      file: "goals",
      content: "# Goals v2\n\nSecond version.",
    });
    const data = parsed as { success: boolean; backed_up: boolean };

    expect(data.backed_up).toBe(true);

    // Verify backup exists
    const historyDir = path.join(ctx.vaultDir, "self", ".history");
    const backups = await fs.readdir(historyDir);
    const goalsBackups = backups.filter((f) => f.startsWith("goals-"));
    expect(goalsBackups.length).toBeGreaterThan(0);
  });

  it("rejects unknown file names via zod validation", async () => {
    // Zod enum validation rejects invalid values at the protocol level,
    // throwing an MCP error before the handler runs. This is correct behavior.
    await expect(
      callTool(ctx.client, "ori_update", {
        file: "nonexistent",
        content: "should fail",
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 8. ori_query
// ---------------------------------------------------------------------------

describe("ori_query", () => {
  it("returns orphans list", async () => {
    const { parsed } = await callTool(ctx.client, "ori_query", {
      kind: "orphans",
    });
    expect(parsed).toBeDefined();
  });

  it("returns dangling links", async () => {
    const { parsed } = await callTool(ctx.client, "ori_query", {
      kind: "dangling",
    });
    expect(parsed).toBeDefined();
  });

  it("returns error for backlinks without note parameter", async () => {
    const { parsed } = await callTool(ctx.client, "ori_query", {
      kind: "backlinks",
    });
    const data = parsed as { success: boolean; error?: string };
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/note required/);
  });

  it("returns error for unknown query kind", async () => {
    const { parsed } = await callTool(ctx.client, "ori_query", {
      kind: "nonexistent",
    });
    const data = parsed as { success: boolean; error?: string };
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/unknown query kind/);
  });
});

// ---------------------------------------------------------------------------
// 9. ori_health
// ---------------------------------------------------------------------------

describe("ori_health", () => {
  it("returns health diagnostic", async () => {
    const { parsed } = await callTool(ctx.client, "ori_health");
    const data = parsed as { success: boolean; data: Record<string, unknown> };

    expect(data.success).toBe(true);
    expect(typeof data.data.noteCount).toBe("number");
    expect(typeof data.data.orphanCount).toBe("number");
    expect(typeof data.data.danglingCount).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// 10. ori_promote
// ---------------------------------------------------------------------------

describe("ori_promote", () => {
  it("promotes an inbox note to notes/", async () => {
    // First, disable auto-promote so add goes to inbox
    const configPath = path.join(ctx.vaultDir, "ori.config.yaml");
    const config = await fs.readFile(configPath, "utf8");
    await fs.writeFile(
      configPath,
      config.replace("auto: true", "auto: false"),
      "utf8"
    );

    // Add a note (goes to inbox because auto=false)
    const addResult = await callTool(ctx.client, "ori_add", {
      title: "promotable note about retrieval via mcp test",
      type: "insight",
      content: "This note will be promoted through the MCP protocol.",
    });
    const addData = addResult.parsed as {
      success: boolean;
      data: { path: string };
    };
    expect(addData.success).toBe(true);

    // Extract filename from path
    const filename = path.basename(addData.data.path);

    // Promote it
    const promoteResult = await callTool(ctx.client, "ori_promote", {
      path: filename,
    });
    const promoteData = promoteResult.parsed as {
      success: boolean;
      data: { promoted: Array<{ to: string }> };
    };

    expect(promoteData.success).toBe(true);
    expect(promoteData.data.promoted).toHaveLength(1);

    // Verify file is in notes/
    const notesFiles = await fs.readdir(path.join(ctx.vaultDir, "notes"));
    expect(
      notesFiles.some((f) =>
        f.includes("promotable-note-about-retrieval-via-mcp-test")
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. ori_validate
// ---------------------------------------------------------------------------

describe("ori_validate", () => {
  it("validates a note against schema", async () => {
    // Add a note first (auto-promotes with default config)
    await callTool(ctx.client, "ori_add", {
      title: "note for validation test via mcp server harness",
      type: "insight",
      content: "Content for validation testing.",
    });

    // Find the note
    const notesDir = path.join(ctx.vaultDir, "notes");
    const files = await fs.readdir(notesDir);
    const noteFile = files.find((f) => f.includes("validation-test"));

    if (noteFile) {
      const { parsed } = await callTool(ctx.client, "ori_validate", {
        path: path.join(notesDir, noteFile),
      });
      expect(parsed).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 12. ori_query_important (PageRank)
// ---------------------------------------------------------------------------

describe("ori_query_important", () => {
  it("returns PageRank-ranked notes", async () => {
    const { parsed } = await callTool(ctx.client, "ori_query_important", {
      limit: 5,
    });
    expect(parsed).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 13. ori_query_fading
// ---------------------------------------------------------------------------

describe("ori_query_fading", () => {
  it("returns fading notes", async () => {
    const { parsed } = await callTool(ctx.client, "ori_query_fading", {
      threshold: 0.5,
      limit: 10,
    });
    expect(parsed).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 14. IDENTITY FLOW — First run → populated → no longer first run
// ---------------------------------------------------------------------------

describe("identity lifecycle", () => {
  it("after writing identity, orient no longer reports firstRun", async () => {
    // Write real identity content
    await callTool(ctx.client, "ori_update", {
      file: "identity",
      content:
        "# Aries\n\nI am Aries, a memory-sovereign agent. Direct, opinionated, proactive.",
    });

    // Note: the server caches instructions at startup, so firstRun detection
    // in orient happens dynamically (it re-reads the file each call)
    const { parsed } = await callTool(ctx.client, "ori_orient");
    const data = parsed as Record<string, unknown>;

    // After writing real content, firstRun should be false
    expect(data.firstRun).toBe(false);
    expect(data).not.toHaveProperty("onboarding");
  });
});
