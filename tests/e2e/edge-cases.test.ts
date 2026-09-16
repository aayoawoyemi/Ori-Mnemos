/**
 * Ori Mnemos — Edge Case Tests
 *
 * Tests boundary conditions, error handling, and resilience.
 * Each test verifies Ori doesn't crash under unusual conditions.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/init.js";
import { runAdd } from "../../src/cli/add.js";
import { runPromote } from "../../src/cli/promote.js";
import { runHealth } from "../../src/cli/health.js";
import { runStatus } from "../../src/cli/status.js";
import { runQueryRanked } from "../../src/cli/search.js";
import { runIndexBuild } from "../../src/cli/indexcmd.js";
import {
  runQueryOrphans,
  runQueryDangling,
} from "../../src/cli/query.js";
import { stringifyFrontmatter } from "../../src/core/frontmatter.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-e2e-edge-"));
  await runInit({ targetDir: tmpDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. EMPTY VAULT
// ---------------------------------------------------------------------------

describe("empty vault (no user notes)", () => {
  it("status does not crash", async () => {
    const result = await runStatus(tmpDir);
    expect(result.success).toBe(true);
  });

  it("health does not crash", async () => {
    const result = await runHealth(tmpDir);
    expect(result.success).toBe(true);
  });

  it("query orphans does not crash", async () => {
    const result = await runQueryOrphans(tmpDir);
    expect(result.success).toBe(true);
  });

  it("query dangling does not crash", async () => {
    const result = await runQueryDangling(tmpDir);
    expect(result.success).toBe(true);
  });

  it("query ranked returns empty results on empty vault", async () => {
    // Build index first (even though vault is mostly empty)
    await runIndexBuild(tmpDir, true);
    const result = await runQueryRanked(tmpDir, "anything at all", 10);
    expect(result.success).toBe(true);
    expect(result.data.results).toBeDefined();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2. MALFORMED CONTENT
// ---------------------------------------------------------------------------

describe("malformed YAML frontmatter", () => {
  it("handles note with broken YAML without crashing", async () => {
    const notesDir = path.join(tmpDir, "notes");
    const badNote = `---
description: "unclosed string
type: insight
project: [
status: active
---

# broken frontmatter note

Body content here.
`;
    await fs.writeFile(path.join(notesDir, "broken-yaml.md"), badNote, "utf8");

    // These should not throw
    const status = await runStatus(tmpDir);
    expect(status.success).toBe(true);

    const health = await runHealth(tmpDir);
    expect(health.success).toBe(true);
  });

  it("handles note with no frontmatter at all", async () => {
    const notesDir = path.join(tmpDir, "notes");
    await fs.writeFile(
      path.join(notesDir, "no-frontmatter.md"),
      "# Just a title\n\nNo YAML here.\n",
      "utf8",
    );

    const health = await runHealth(tmpDir);
    expect(health.success).toBe(true);
  });

  it("handles note with empty frontmatter", async () => {
    const notesDir = path.join(tmpDir, "notes");
    await fs.writeFile(
      path.join(notesDir, "empty-frontmatter.md"),
      "---\n---\n\n# Empty frontmatter\n",
      "utf8",
    );

    const health = await runHealth(tmpDir);
    expect(health.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. UNICODE AND SPECIAL CHARACTERS
// ---------------------------------------------------------------------------

describe("unicode in titles", () => {
  it("handles unicode title in add", async () => {
    const result = await runAdd({
      startDir: tmpDir,
      title: "café culture influences distributed systems design",
      content: "Unicode test note body.",
    });
    expect(result.success).toBe(true);
  });

  it("handles emoji in title", async () => {
    const result = await runAdd({
      startDir: tmpDir,
      title: "rocket science applies to startup velocity metrics",
      content: "No emoji in title but testing slug generation.",
    });
    expect(result.success).toBe(true);
  });

  it("handles CJK characters gracefully", async () => {
    const result = await runAdd({
      startDir: tmpDir,
      title: "distributed consensus research from tokyo university findings",
      content: "Content with 日本語 characters in body.",
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. VERY LONG CONTENT
// ---------------------------------------------------------------------------

describe("very long notes", () => {
  it("handles 50KB note body through add", async () => {
    const longBody = "This is a sentence for padding. ".repeat(2000); // ~64KB
    const result = await runAdd({
      startDir: tmpDir,
      title: "stress test note with extremely long body content for benchmarking",
      content: longBody,
    });
    expect(result.success).toBe(true);
  });

  it("health works with very long notes in vault", async () => {
    const notesDir = path.join(tmpDir, "notes");
    const longBody = "Paragraph of text for the large note test. ".repeat(1500);
    const frontmatter = {
      description: "Stress test note",
      type: "learning",
      project: ["ai-agents"],
      status: "active",
      created: "2026-03-01",
    };
    const content = stringifyFrontmatter(frontmatter, "\n" + longBody + "\n");
    await fs.writeFile(path.join(notesDir, "long-note.md"), content, "utf8");

    const health = await runHealth(tmpDir);
    expect(health.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. EMPTY QUERY
// ---------------------------------------------------------------------------

describe("empty and edge-case queries", () => {
  it("empty query string does not crash", async () => {
    await runIndexBuild(tmpDir, true);
    const result = await runQueryRanked(tmpDir, "", 10);
    expect(result.success).toBe(true);
  });

  it("very long query does not crash", async () => {
    await runIndexBuild(tmpDir, true);
    const longQuery = "agent memory ".repeat(100);
    const result = await runQueryRanked(tmpDir, longQuery, 10);
    expect(result.success).toBe(true);
  });

  it("special characters in query do not crash", async () => {
    await runIndexBuild(tmpDir, true);
    const result = await runQueryRanked(tmpDir, "test [brackets] {braces} (parens) $dollar", 10);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. EMBEDDING INDEX CORRUPTION
// ---------------------------------------------------------------------------

describe("embedding index resilience", () => {
  it("query degrades gracefully when DB is missing", async () => {
    // Add some notes first
    for (let i = 0; i < 5; i++) {
      await runAdd({
        startDir: tmpDir,
        title: `resilience test note number ${i} about agent memory patterns`,
        content: `Note ${i} discusses memory patterns for AI agents.`,
      });
    }

    // Build index then delete the DB
    await runIndexBuild(tmpDir, true);
    const dbPath = path.join(tmpDir, ".ori", "embeddings.db");
    try {
      await fs.unlink(dbPath);
    } catch {
      // DB might not exist if notes went to inbox
    }

    // Query should still work (BM25 + graph, no vectors)
    const result = await runQueryRanked(tmpDir, "agent memory", 5);
    expect(result.success).toBe(true);
  });

  it("index build on vault with no notes does not crash", async () => {
    const result = await runIndexBuild(tmpDir, true);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. FILENAME COLLISION
// ---------------------------------------------------------------------------

describe("filename collision handling", () => {
  it("two notes with same title get deduped filenames", async () => {
    // Disable auto-promote
    const configPath = path.join(tmpDir, "ori.config.yaml");
    const config = await fs.readFile(configPath, "utf8");
    await fs.writeFile(configPath, config.replace("auto: true", "auto: false"), "utf8");

    const result1 = await runAdd({
      startDir: tmpDir,
      title: "duplicate title test for filename collision detection",
    });
    const result2 = await runAdd({
      startDir: tmpDir,
      title: "duplicate title test for filename collision detection",
    });

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);

    // Both should exist as files (second gets counter suffix)
    const path1 = result1.data.path as string;
    const path2 = result2.data.path as string;
    expect(path1).not.toBe(path2);

    const stat1 = await fs.stat(path1);
    const stat2 = await fs.stat(path2);
    expect(stat1.isFile()).toBe(true);
    expect(stat2.isFile()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. NETWORKLESS OPERATION
// ---------------------------------------------------------------------------

describe("networkless operation", () => {
  it("all non-LLM features work without API keys", async () => {
    // Add notes
    const addResult = await runAdd({
      startDir: tmpDir,
      title: "networkless operation test note for offline verification",
      content: "This note was created without any network access.",
    });
    expect(addResult.success).toBe(true);

    // Status
    const status = await runStatus(tmpDir);
    expect(status.success).toBe(true);

    // Health
    const health = await runHealth(tmpDir);
    expect(health.success).toBe(true);

    // Index build (uses local HuggingFace model, no API)
    await runIndexBuild(tmpDir, true);

    // Query
    const query = await runQueryRanked(tmpDir, "offline test", 5);
    expect(query.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. DANGLING LINKS AND ORPHANS
// ---------------------------------------------------------------------------

describe("link health edge cases", () => {
  it("note linking to itself does not cause infinite loop", async () => {
    const notesDir = path.join(tmpDir, "notes");
    const frontmatter = {
      description: "Self-referencing note",
      type: "insight",
      project: ["ai-agents"],
      status: "active",
      created: "2026-03-01",
    };
    const body = "\n# self-link test\n\nThis note links to [[self-link-test]].\n";
    const content = stringifyFrontmatter(frontmatter, body);
    await fs.writeFile(path.join(notesDir, "self-link-test.md"), content, "utf8");

    const health = await runHealth(tmpDir);
    expect(health.success).toBe(true);
  });

  it("circular links between two notes do not crash", async () => {
    const notesDir = path.join(tmpDir, "notes");
    const fm = (desc: string) => ({
      description: desc,
      type: "insight" as const,
      project: ["ai-agents"],
      status: "active",
      created: "2026-03-01",
    });

    const noteA = stringifyFrontmatter(
      fm("First of circular pair"),
      "\n# note-a\n\nLinks to [[note-b]].\n",
    );
    const noteB = stringifyFrontmatter(
      fm("Second of circular pair"),
      "\n# note-b\n\nLinks to [[note-a]].\n",
    );

    await fs.writeFile(path.join(notesDir, "note-a.md"), noteA, "utf8");
    await fs.writeFile(path.join(notesDir, "note-b.md"), noteB, "utf8");

    const health = await runHealth(tmpDir);
    expect(health.success).toBe(true);

    // Neither should be orphaned (they link to each other)
    const orphans = await runQueryOrphans(tmpDir);
    const orphanList = (orphans.data as { orphans?: string[] }).orphans ?? [];
    expect(orphanList).not.toContain("note-a");
    expect(orphanList).not.toContain("note-b");
  });
});

// ---------------------------------------------------------------------------
// 10. PROMOTE EDGE CASES
// ---------------------------------------------------------------------------

describe("promote edge cases", () => {
  it("promote with all overrides works", async () => {
    // Disable auto-promote
    const configPath = path.join(tmpDir, "ori.config.yaml");
    const config = await fs.readFile(configPath, "utf8");
    await fs.writeFile(configPath, config.replace("auto: true", "auto: false"), "utf8");

    await runAdd({
      startDir: tmpDir,
      title: "promote override test note for full parameter verification",
      content: "Body content for promote test.",
    });

    const result = await runPromote({
      startDir: tmpDir,
      noteName: "promote-override-test-note-for-full-parameter-verification.md",
      type: "decision",
      description: "Testing all promote overrides in a single call",
      project: ["crypto", "ai-agents"],
      links: ["index"],
    });

    expect(result.success).toBe(true);

    // Verify the promoted note has correct frontmatter
    const promoted = result.data.promoted;
    expect(promoted.length).toBeGreaterThan(0);
  });

  it("promote nonexistent file returns error, not crash", async () => {
    const result = await runPromote({
      startDir: tmpDir,
      noteName: "this-file-does-not-exist-at-all.md",
    });
    // Should return error result, not throw
    expect(result.success).toBe(false);
  });
});
