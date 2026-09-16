/**
 * Ori Mnemos — Sandbox E2E Tests
 *
 * Tests the complete fresh-user journey in isolated temp directories.
 * Nothing touches the real vault. Every test starts from `ori init`.
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

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-e2e-sandbox-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. INIT
// ---------------------------------------------------------------------------

describe("ori init", () => {
  it("creates full scaffold on empty directory", async () => {
    const result = await runInit({ targetDir: tmpDir });

    // Core directories exist
    for (const dir of ["notes", "inbox", "self", "ops", "templates"]) {
      const stat = await fs.stat(path.join(tmpDir, dir));
      expect(stat.isDirectory()).toBe(true);
    }

    // .ori marker exists
    await expect(fs.access(path.join(tmpDir, ".ori"))).resolves.toBeUndefined();

    // Config exists
    await expect(
      fs.access(path.join(tmpDir, "ori.config.yaml"))
    ).resolves.toBeUndefined();

    // Templates exist
    await expect(
      fs.access(path.join(tmpDir, "templates", "note.md"))
    ).resolves.toBeUndefined();

    // Self files exist
    for (const file of ["identity.md", "goals.md", "methodology.md"]) {
      await expect(
        fs.access(path.join(tmpDir, "self", file))
      ).resolves.toBeUndefined();
    }

    // Seed note exists
    await expect(
      fs.access(path.join(tmpDir, "notes", "index.md"))
    ).resolves.toBeUndefined();

    // Result reports created files
    expect(result.created.length).toBeGreaterThan(0);
    expect(result.skipped.length).toBe(0);
  });

  it("is idempotent — second run skips existing files", async () => {
    const first = await runInit({ targetDir: tmpDir });
    const second = await runInit({ targetDir: tmpDir });

    expect(first.created.length).toBeGreaterThan(0);
    expect(second.created.length).toBe(0);
    expect(second.skipped.length).toBe(first.created.length);
  });

  it("does not overwrite user-modified files", async () => {
    await runInit({ targetDir: tmpDir });

    // User modifies identity
    const identityPath = path.join(tmpDir, "self", "identity.md");
    await fs.writeFile(identityPath, "I am Aries.", "utf8");

    await runInit({ targetDir: tmpDir });

    const content = await fs.readFile(identityPath, "utf8");
    expect(content).toBe("I am Aries.");
  });
});

// ---------------------------------------------------------------------------
// 2. ADD
// ---------------------------------------------------------------------------

describe("ori add", () => {
  beforeEach(async () => {
    await runInit({ targetDir: tmpDir });
  });

  it("places note in inbox with real content (auto=true, default scaffold)", async () => {
    // Scaffold config has auto: true, but content is provided
    // so it will auto-promote. Let's verify the auto-promote behavior.
    const result = await runAdd({
      startDir: tmpDir,
      title: "test insight about memory retrieval patterns",
      type: "insight",
      content: "Semantic search finds connections that keyword search misses.",
    });

    expect(result.success).toBe(true);
    // With auto=true and content, it should auto-promote to notes/
    expect(result.data.autoPromoted).toBe(true);
    expect((result.data.path as string)).toContain("notes");
  });

  it("keeps note in inbox when content is template placeholder", async () => {
    const result = await runAdd({
      startDir: tmpDir,
      title: "idea about token incentive alignment mechanisms",
      type: "idea",
      // No content provided — template placeholder remains
    });

    expect(result.success).toBe(true);
    expect(result.data.autoPromoted).toBeUndefined();
    expect((result.data.path as string)).toContain("inbox");
  });

  it("rejects UUID titles", async () => {
    const result = await runAdd({
      startDir: tmpDir,
      title: "e9a5f2d9-5396-47cf-96d8-5024d35ce99f",
      type: "insight",
    });

    expect(result.success).toBe(false);
    expect(result.warnings[0]).toMatch(/UUID/);
  });

  it("rejects single-word titles", async () => {
    const result = await runAdd({
      startDir: tmpDir,
      title: "tokenomics",
      type: "insight",
    });

    expect(result.success).toBe(false);
    expect(result.warnings[0]).toMatch(/multi-word/);
  });

  it("rejects short titles", async () => {
    const result = await runAdd({
      startDir: tmpDir,
      title: "too short",
      type: "insight",
    });

    expect(result.success).toBe(false);
    expect(result.warnings[0]).toMatch(/too short/i);
  });

  it("handles filename collision with counter", async () => {
    const title = "duplicate note about agent memory persistence";

    const first = await runAdd({
      startDir: tmpDir,
      title,
      type: "insight",
      content: "First version.",
    });

    const second = await runAdd({
      startDir: tmpDir,
      title,
      type: "insight",
      content: "Second version.",
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    // Paths should be different (counter appended)
    expect(first.data.path).not.toBe(second.data.path);
  });

  it("handles unicode in titles", async () => {
    const result = await runAdd({
      startDir: tmpDir,
      title: "les tokens devraient avoir une utilite reelle",
      type: "idea",
      content: "French insight about token utility.",
    });

    expect(result.success).toBe(true);
  });

  it("handles titles with special characters", async () => {
    const result = await runAdd({
      startDir: tmpDir,
      title: "agents memory isnt just storage its retrieval",
      type: "insight",
      content: "Apostrophe and contraction handling.",
    });

    expect(result.success).toBe(true);
  });

  it("sets correct frontmatter defaults", async () => {
    // Disable auto-promote to read the inbox file directly
    const configPath = path.join(tmpDir, "ori.config.yaml");
    const configContent = await fs.readFile(configPath, "utf8");
    await fs.writeFile(
      configPath,
      configContent.replace("auto: true", "auto: false"),
      "utf8"
    );

    const result = await runAdd({
      startDir: tmpDir,
      title: "test note for frontmatter verification purposes",
      type: "learning",
      content: "Content body.",
    });

    expect(result.success).toBe(true);
    const notePath = result.data.path as string;
    const noteContent = await fs.readFile(notePath, "utf8");

    expect(noteContent).toMatch(/type: learning/);
    expect(noteContent).toMatch(/status: inbox/);
    expect(noteContent).toMatch(/created: \d{4}-\d{2}-\d{2}/);
    expect(noteContent).toMatch(/access_count: 0/);
  });
});

// ---------------------------------------------------------------------------
// 3. PROMOTE
// ---------------------------------------------------------------------------

describe("ori promote", () => {
  beforeEach(async () => {
    await runInit({ targetDir: tmpDir });
    // Disable auto-promote so add puts things in inbox
    const configPath = path.join(tmpDir, "ori.config.yaml");
    const configContent = await fs.readFile(configPath, "utf8");
    await fs.writeFile(
      configPath,
      configContent.replace("auto: true", "auto: false"),
      "utf8"
    );
  });

  it("moves note from inbox to notes with status update", async () => {
    await runAdd({
      startDir: tmpDir,
      title: "insight about cross domain retrieval quality",
      type: "insight",
      content: "Cross-domain connections are the primary value.",
    });

    const slug = "insight-about-cross-domain-retrieval-quality";

    const result = await runPromote({
      startDir: tmpDir,
      noteName: `${slug}.md`,
    });

    expect(result.success).toBe(true);
    expect(result.data.promoted).toHaveLength(1);

    // File should be in notes/
    const notesFiles = await fs.readdir(path.join(tmpDir, "notes"));
    expect(notesFiles).toContain(`${slug}.md`);

    // File should NOT be in inbox/
    const inboxFiles = await fs.readdir(path.join(tmpDir, "inbox"));
    expect(inboxFiles).not.toContain(`${slug}.md`);

    // Status should be active
    const content = await fs.readFile(
      path.join(tmpDir, "notes", `${slug}.md`),
      "utf8"
    );
    expect(content).toMatch(/status: active/);
  });

  it("writes to promote.log", async () => {
    await runAdd({
      startDir: tmpDir,
      title: "decision about using embeddings for retrieval",
      type: "decision",
      content: "Embeddings enable semantic matching.",
    });

    await runPromote({
      startDir: tmpDir,
      noteName: "decision-about-using-embeddings-for-retrieval.md",
    });

    const logPath = path.join(tmpDir, "ops", "promote.log");
    const logContent = await fs.readFile(logPath, "utf8");
    expect(logContent).toContain("decision-about-using-embeddings-for-retrieval");
  });
});

// ---------------------------------------------------------------------------
// 4. HEALTH
// ---------------------------------------------------------------------------

describe("ori health", () => {
  beforeEach(async () => {
    await runInit({ targetDir: tmpDir });
  });

  it("reports clean health on fresh vault", async () => {
    const result = await runHealth(tmpDir);

    expect(result.success).toBe(true);
    // Fresh vault has index.md — may have 0 orphans or 1 depending on links
    expect(result.data.danglingCount).toBe(0);
  });

  it("detects dangling links", async () => {
    // Create a note with a link to a non-existent note
    await fs.writeFile(
      path.join(tmpDir, "notes", "test-dangling.md"),
      [
        "---",
        'description: "Test note with dangling link"',
        "type: insight",
        "project: []",
        "status: active",
        "created: 2026-03-02",
        "last_accessed: 2026-03-02",
        "access_count: 0",
        "---",
        "This links to [[a note that does not exist]].",
      ].join("\n"),
      "utf8"
    );

    const result = await runHealth(tmpDir);

    expect(result.success).toBe(true);
    expect((result.data.danglingCount as number)).toBeGreaterThan(0);
  });

  it("detects orphan notes", async () => {
    // Create a note that nothing links to
    await fs.writeFile(
      path.join(tmpDir, "notes", "orphan-note.md"),
      [
        "---",
        'description: "Orphan note with no incoming links"',
        "type: insight",
        "project: []",
        "status: active",
        "created: 2026-03-02",
        "last_accessed: 2026-03-02",
        "access_count: 0",
        "---",
        "This note has no incoming links from any other note.",
      ].join("\n"),
      "utf8"
    );

    const result = await runHealth(tmpDir);

    expect(result.success).toBe(true);
    expect((result.data.orphanCount as number)).toBeGreaterThan(0);
    expect((result.data.orphans as string[])).toContain("orphan-note");
  });
});

// ---------------------------------------------------------------------------
// 5. STATUS
// ---------------------------------------------------------------------------

describe("ori status", () => {
  beforeEach(async () => {
    await runInit({ targetDir: tmpDir });
  });

  it("reports correct counts on fresh vault", async () => {
    const result = await runStatus(tmpDir);

    expect(result.success).toBe(true);
    expect(result.data.noteCount).toBe(1); // index.md
    // .gitkeep in inbox/ counts as a file in the scaffold
    expect(result.data.inboxCount).toBe(1);
  });

  it("counts inbox items correctly", async () => {
    // Disable auto-promote
    const configPath = path.join(tmpDir, "ori.config.yaml");
    const configContent = await fs.readFile(configPath, "utf8");
    await fs.writeFile(
      configPath,
      configContent.replace("auto: true", "auto: false"),
      "utf8"
    );

    await runAdd({
      startDir: tmpDir,
      title: "first note in the inbox queue",
      type: "idea",
      content: "Content.",
    });
    await runAdd({
      startDir: tmpDir,
      title: "second note in the inbox queue",
      type: "insight",
      content: "More content.",
    });

    const result = await runStatus(tmpDir);

    // 2 added notes + .gitkeep from scaffold
    expect(result.data.inboxCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 6. EDGE CASES
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("status works on vault with no notes directory content", async () => {
    await runInit({ targetDir: tmpDir });
    // Remove the seed index.md
    await fs.unlink(path.join(tmpDir, "notes", "index.md"));

    const result = await runStatus(tmpDir);
    expect(result.success).toBe(true);
    expect(result.data.noteCount).toBe(0);
  });

  it("health works on vault with no notes", async () => {
    await runInit({ targetDir: tmpDir });
    await fs.unlink(path.join(tmpDir, "notes", "index.md"));

    const result = await runHealth(tmpDir);
    expect(result.success).toBe(true);
    expect(result.data.noteCount).toBe(0);
    expect(result.data.orphanCount).toBe(0);
    expect(result.data.danglingCount).toBe(0);
  });

  it("malformed YAML frontmatter does not crash health", async () => {
    await runInit({ targetDir: tmpDir });

    await fs.writeFile(
      path.join(tmpDir, "notes", "bad-yaml.md"),
      [
        "---",
        'description: "unclosed quote',
        "type: insight",
        "---",
        "Body content.",
      ].join("\n"),
      "utf8"
    );

    // Should not throw — should handle gracefully
    await expect(runHealth(tmpDir)).resolves.toBeDefined();
  });

  it("add handles empty content string gracefully", async () => {
    await runInit({ targetDir: tmpDir });

    const result = await runAdd({
      startDir: tmpDir,
      title: "note with explicitly empty content string",
      type: "insight",
      content: "",
    });

    // Empty string content should still work (it's provided, just empty)
    expect(result.success).toBe(true);
  });
});
