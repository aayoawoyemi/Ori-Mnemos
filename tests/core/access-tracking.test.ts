/**
 * Ori Mnemos — Access Tracking Tests (#17)
 *
 * Verifies retrieval updates access_count and last_accessed in
 * frontmatter so the ACT-R vitality model has a real usage signal.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../../src/cli/init.js";
import { runQueryRanked } from "../../src/cli/search.js";
import { runIndexBuild } from "../../src/cli/indexcmd.js";
import { recordNoteAccess } from "../../src/core/noteindex.js";
import { parseFrontmatter, stringifyFrontmatter } from "../../src/core/frontmatter.js";

let tmpDir: string;

async function writeNote(
  title: string,
  data: Record<string, unknown>,
  body: string,
): Promise<string> {
  const filePath = path.join(tmpDir, "notes", `${title}.md`);
  await fs.writeFile(filePath, stringifyFrontmatter(data, body), "utf8");
  return filePath;
}

async function readFm(title: string): Promise<Record<string, unknown> | null> {
  const filePath = path.join(tmpDir, "notes", `${title}.md`);
  const content = await fs.readFile(filePath, "utf8");
  return parseFrontmatter(content).data;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-access-"));
  await runInit({ targetDir: tmpDir });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("recordNoteAccess", () => {
  it("increments access_count and refreshes last_accessed", async () => {
    await writeNote(
      "alpha-note",
      {
        description: "test note",
        type: "insight",
        status: "active",
        access_count: 2,
        last_accessed: "2020-01-01",
        created: "2020-01-01",
      },
      "# alpha\n\nBody.",
    );

    await recordNoteAccess(path.join(tmpDir, "notes"), ["alpha-note"]);

    const data = await readFm("alpha-note");
    expect(data?.access_count).toBe(3);
    const today = new Date().toISOString().split("T")[0];
    expect(data?.last_accessed).toBe(today);
  });

  it("treats missing access_count as 0", async () => {
    await writeNote(
      "beta-note",
      { description: "no counter", type: "insight", status: "active" },
      "# beta\n\nBody.",
    );

    await recordNoteAccess(path.join(tmpDir, "notes"), ["beta-note"]);

    const data = await readFm("beta-note");
    expect(data?.access_count).toBe(1);
  });

  it("preserves note body exactly", async () => {
    const body = "# gamma\n\nLine one.\n\n- bullet\n\n```js\ncode();\n```\n";
    await writeNote(
      "gamma-note",
      { description: "body check", type: "insight", status: "active", access_count: 0 },
      body,
    );

    await recordNoteAccess(path.join(tmpDir, "notes"), ["gamma-note"]);

    const filePath = path.join(tmpDir, "notes", "gamma-note.md");
    const content = await fs.readFile(filePath, "utf8");
    expect(parseFrontmatter(content).body.trimEnd()).toBe(body.trimEnd());
  });

  it("skips notes without frontmatter and missing files without crashing", async () => {
    const filePath = path.join(tmpDir, "notes", "raw-note.md");
    await fs.writeFile(filePath, "no frontmatter at all\n", "utf8");

    await expect(
      recordNoteAccess(path.join(tmpDir, "notes"), ["raw-note", "does-not-exist"]),
    ).resolves.toBeUndefined();

    const content = await fs.readFile(filePath, "utf8");
    expect(content).toBe("no frontmatter at all\n");
  });
});

describe("runQueryRanked access tracking (#17)", () => {
  it("updates access_count for returned notes only", async () => {
    await writeNote(
      "agent-memory-systems",
      {
        description: "how agents remember things across sessions",
        type: "insight",
        status: "active",
        access_count: 0,
        created: "2024-01-01",
      },
      "# agent memory\n\nAgents use persistent memory to recall context across sessions.",
    );
    await writeNote(
      "unrelated-cooking-note",
      {
        description: "pasta carbonara recipe",
        type: "insight",
        status: "active",
        access_count: 0,
        created: "2024-01-01",
      },
      "# carbonara\n\nEggs, guanciale, pecorino.",
    );

    await runIndexBuild(tmpDir, true);
    const result = await runQueryRanked(tmpDir, "agent memory sessions", 1);
    expect(result.success).toBe(true);
    expect(result.data.results.length).toBeGreaterThan(0);

    const returnedTitles = result.data.results.map((r) => r.title);
    for (const title of returnedTitles) {
      const data = await readFm(title);
      expect(data?.access_count).toBe(1);
    }

    // Any note NOT returned keeps access_count 0
    const all = ["agent-memory-systems", "unrelated-cooking-note"];
    for (const title of all.filter((t) => !returnedTitles.includes(t))) {
      const data = await readFm(title);
      expect(data?.access_count).toBe(0);
    }
  }, 60_000);
});
