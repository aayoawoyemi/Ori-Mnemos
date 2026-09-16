import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runPromote } from "../../src/cli/promote.js";

let tmpDir: string;

async function scaffoldVault(root: string) {
  await fs.writeFile(path.join(root, ".ori"), "", "utf8");
  await fs.mkdir(path.join(root, "inbox"), { recursive: true });
  await fs.mkdir(path.join(root, "notes"), { recursive: true });
  await fs.mkdir(path.join(root, "ops"), { recursive: true });
  await fs.mkdir(path.join(root, "templates"), { recursive: true });

  // Minimal note template
  await fs.writeFile(
    path.join(root, "templates", "note.md"),
    [
      "---",
      "_schema:",
      '  entity_type: "note"',
      "  required:",
      "    - description",
      "    - type",
      "    - project",
      "    - status",
      "    - created",
      "  enums:",
      "    type:",
      "      - idea",
      "      - decision",
      "      - learning",
      "      - insight",
      "      - blocker",
      "      - opportunity",
      "    status:",
      "      - inbox",
      "      - active",
      "      - completed",
      "      - superseded",
      "      - archived",
      "  constraints:",
      "    description:",
      "      max_length: 200",
      "---",
      "Template body.",
    ].join("\n"),
    "utf8"
  );

  // Config
  await fs.writeFile(
    path.join(root, "ori.config.yaml"),
    [
      "vault:",
      '  version: "0.2"',
      "templates:",
      '  default: "templates/note.md"',
      "vitality:",
      "  base: 1.0",
      "  decay: {}",
    ].join("\n"),
    "utf8"
  );
}

function inboxNote(data: Record<string, unknown>, body = "Note content.") {
  const yamlLines = Object.entries(data).map(([k, v]) => {
    if (Array.isArray(v)) {
      if (v.length === 0) return `${k}: []`;
      return `${k}:\n${v.map((i: unknown) => `  - ${i}`).join("\n")}`;
    }
    return `${k}: ${JSON.stringify(v)}`;
  });
  return `---\n${yamlLines.join("\n")}\n---\n${body}`;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-test-promote-"));
  await scaffoldVault(tmpDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function markdownIn(dir: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(tmpDir, dir));
  return entries.filter((e) => e.endsWith(".md")).sort();
}

describe("runPromote", () => {
  it("moves note from inbox to notes", async () => {
    await fs.writeFile(
      path.join(tmpDir, "inbox", "my-note.md"),
      inboxNote({
        description: "A test note",
        type: "insight",
        project: [],
        status: "inbox",
        created: "2026-02-20",
        last_accessed: "2026-02-20",
        access_count: 0,
      }),
      "utf8"
    );

    const result = await runPromote({ startDir: tmpDir, noteName: "my-note" });

    expect(result.success).toBe(true);
    expect(result.data.promoted).toHaveLength(1);
    expect(result.data.promoted[0].to).toContain("notes");

    // File should exist in notes/
    const notesFiles = await fs.readdir(path.join(tmpDir, "notes"));
    expect(notesFiles).toContain("my-note.md");

    // File should not exist in inbox/
    const inboxFiles = await fs.readdir(path.join(tmpDir, "inbox"));
    expect(inboxFiles).not.toContain("my-note.md");
  });

  it("dry-run does not move files", async () => {
    await fs.writeFile(
      path.join(tmpDir, "inbox", "dry-note.md"),
      inboxNote({
        description: "Dry run note",
        type: "idea",
        project: [],
        status: "inbox",
        created: "2026-02-20",
        last_accessed: "2026-02-20",
        access_count: 0,
      }),
      "utf8"
    );

    const result = await runPromote({
      startDir: tmpDir,
      noteName: "dry-note",
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.data.promoted).toHaveLength(1);

    // File should still be in inbox/
    const inboxFiles = await fs.readdir(path.join(tmpDir, "inbox"));
    expect(inboxFiles).toContain("dry-note.md");

    // File should NOT be in notes/
    const notesFiles = await fs.readdir(path.join(tmpDir, "notes"));
    expect(notesFiles).not.toContain("dry-note.md");
  });

  it("promotes all inbox notes with --all", async () => {
    for (const name of ["note-a", "note-b", "note-c"]) {
      await fs.writeFile(
        path.join(tmpDir, "inbox", `${name}.md`),
        inboxNote({
          description: `Note ${name}`,
          type: "insight",
          project: [],
          status: "inbox",
          created: "2026-02-20",
          last_accessed: "2026-02-20",
          access_count: 0,
        }),
        "utf8"
      );
    }

    const result = await runPromote({ startDir: tmpDir, all: true });

    expect(result.success).toBe(true);
    expect(result.data.promoted).toHaveLength(3);

    const notesFiles = await fs.readdir(path.join(tmpDir, "notes"));
    expect(notesFiles).toContain("note-a.md");
    expect(notesFiles).toContain("note-b.md");
    expect(notesFiles).toContain("note-c.md");
  });

  it("skips notes with non-inbox status", async () => {
    await fs.writeFile(
      path.join(tmpDir, "inbox", "active-note.md"),
      inboxNote({
        description: "Already active",
        type: "insight",
        project: [],
        status: "active",
        created: "2026-02-20",
        last_accessed: "2026-02-20",
        access_count: 0,
      }),
      "utf8"
    );

    const result = await runPromote({
      startDir: tmpDir,
      noteName: "active-note",
    });

    expect(result.data.skipped).toHaveLength(1);
    expect(result.data.skipped[0].reason).toMatch(/Status is "active"/);
  });

  it("fails on collision when note already exists in notes/", async () => {
    // Pre-existing note in notes/
    await fs.writeFile(
      path.join(tmpDir, "notes", "collision.md"),
      inboxNote({
        description: "Existing",
        type: "insight",
        project: [],
        status: "active",
        created: "2026-02-20",
        last_accessed: "2026-02-20",
        access_count: 0,
      }),
      "utf8"
    );

    // Same name in inbox
    await fs.writeFile(
      path.join(tmpDir, "inbox", "collision.md"),
      inboxNote({
        description: "New version",
        type: "insight",
        project: [],
        status: "inbox",
        created: "2026-02-22",
        last_accessed: "2026-02-22",
        access_count: 0,
      }),
      "utf8"
    );

    const result = await runPromote({
      startDir: tmpDir,
      noteName: "collision",
    });

    expect(result.data.skipped).toHaveLength(1);
    expect(result.data.skipped[0].reason).toMatch(/already exists/);

    // Inbox file should still exist
    const inboxFiles = await fs.readdir(path.join(tmpDir, "inbox"));
    expect(inboxFiles).toContain("collision.md");
  });

  it("writes promote.log on successful promotion", async () => {
    await fs.writeFile(
      path.join(tmpDir, "inbox", "logged.md"),
      inboxNote({
        description: "Logged note",
        type: "decision",
        project: [],
        status: "inbox",
        created: "2026-02-20",
        last_accessed: "2026-02-20",
        access_count: 0,
      }),
      "utf8"
    );

    await runPromote({ startDir: tmpDir, noteName: "logged" });

    const logPath = path.join(tmpDir, "ops", "promote.log");
    const logContent = await fs.readFile(logPath, "utf8");
    expect(logContent).toContain("logged.md");
    expect(logContent).toContain("type=decision");
  });

  it("returns error for nonexistent inbox note", async () => {
    const result = await runPromote({
      startDir: tmpDir,
      noteName: "nonexistent",
    });

    expect(result.success).toBe(false);
    expect(result.warnings[0]).toMatch(/not found/);
  });

  it("skips notes with template placeholder body", async () => {
    await fs.writeFile(
      path.join(tmpDir, "inbox", "stub-note.md"),
      inboxNote(
        {
          description: "",
          type: "insight",
          project: [],
          status: "inbox",
          created: "2026-02-20",
          last_accessed: "2026-02-20",
          access_count: 0,
        },
        "{Content — your reasoning, evidence, context. Transform the material, don't just summarize.}"
      ),
      "utf8"
    );

    const result = await runPromote({
      startDir: tmpDir,
      noteName: "stub-note",
    });

    expect(result.data.skipped).toHaveLength(1);
    expect(result.data.skipped[0].reason).toMatch(/template placeholder/);

    // File should still be in inbox
    const inboxFiles = await fs.readdir(path.join(tmpDir, "inbox"));
    expect(inboxFiles).toContain("stub-note.md");

    // File should NOT be in notes
    const notesFiles = await fs.readdir(path.join(tmpDir, "notes"));
    expect(notesFiles).not.toContain("stub-note.md");
  });

  it("updates frontmatter status to active", async () => {
    await fs.writeFile(
      path.join(tmpDir, "inbox", "status-check.md"),
      inboxNote({
        description: "Check status change",
        type: "insight",
        project: [],
        status: "inbox",
        created: "2026-02-20",
        last_accessed: "2026-02-20",
        access_count: 0,
      }),
      "utf8"
    );

    await runPromote({ startDir: tmpDir, noteName: "status-check" });

    const content = await fs.readFile(
      path.join(tmpDir, "notes", "status-check.md"),
      "utf8"
    );
    expect(content).toMatch(/status: active/);
  });
});

describe("runPromote atomicity", () => {
  const seed = () =>
    inboxNote({
      description: "Atomicity probe",
      type: "insight",
      project: [],
      status: "inbox",
      created: "2026-02-20",
      last_accessed: "2026-02-20",
      access_count: 0,
    });

  it("leaves the note in exactly one place on success", async () => {
    await fs.writeFile(path.join(tmpDir, "inbox", "atomic.md"), seed(), "utf8");

    const result = await runPromote({ startDir: tmpDir, noteName: "atomic" });

    expect(result.data.promoted).toHaveLength(1);
    expect(await markdownIn("inbox")).toEqual([]);
    expect(await markdownIn("notes")).toEqual(["atomic.md"]);
    const content = await fs.readFile(path.join(tmpDir, "notes", "atomic.md"), "utf8");
    expect(content).toContain("Note content.");
    expect(content).toMatch(/status: active/);
  });

  it("never leaves the note in both inbox/ and notes/ when the cleanup step fails", async () => {
    await fs.writeFile(path.join(tmpDir, "inbox", "atomic.md"), seed(), "utf8");
    // The old implementation wrote notes/<dest>.md and then unlinked the inbox
    // copy; a failure in between duplicated the note.
    vi.spyOn(fs, "unlink").mockRejectedValue(new Error("simulated crash"));

    await runPromote({ startDir: tmpDir, noteName: "atomic" }).catch(() => null);

    expect(await markdownIn("inbox")).toEqual([]);
    expect(await markdownIn("notes")).toEqual(["atomic.md"]);
    const content = await fs.readFile(path.join(tmpDir, "notes", "atomic.md"), "utf8");
    expect(content).toContain("Note content.");
  });

  it("survives a transient lock refusal on the move", async () => {
    await fs.writeFile(path.join(tmpDir, "inbox", "atomic.md"), seed(), "utf8");

    // Windows refuses a rename while either end is transiently open. Promote's
    // move must go through renameWithRetry; a direct fs.rename fails here.
    const realRename = fs.rename;
    let attempts = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      attempts += 1;
      if (attempts <= 3) {
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), {
          code: "EPERM",
        });
      }
      await realRename(from, to);
    });

    const result = await runPromote({ startDir: tmpDir, noteName: "atomic" });

    expect(result.data.promoted).toHaveLength(1);
    expect(attempts).toBeGreaterThan(3);
    expect(await markdownIn("inbox")).toEqual([]);
    expect(await markdownIn("notes")).toEqual(["atomic.md"]);
    const content = await fs.readFile(path.join(tmpDir, "notes", "atomic.md"), "utf8");
    expect(content).toContain("Note content.");
    expect(content).toMatch(/status: active/);
  });

  it("keeps the inbox note byte-identical when the promoted write fails", async () => {
    const inboxPath = path.join(tmpDir, "inbox", "atomic.md");
    await fs.writeFile(inboxPath, seed(), "utf8");
    const original = await fs.readFile(inboxPath, "utf8");

    // Fails the staged write of the promoted content, i.e. after the note has
    // already been moved out of inbox/.
    vi.spyOn(fs, "open").mockRejectedValue(new Error("simulated crash"));

    await expect(
      runPromote({ startDir: tmpDir, noteName: "atomic" })
    ).rejects.toThrow("simulated crash");

    vi.restoreAllMocks();
    // Rolled back: still exactly one copy, still the user's original bytes.
    expect(await fs.readFile(inboxPath, "utf8")).toBe(original);
    expect(await markdownIn("notes")).toEqual([]);
  });
});
