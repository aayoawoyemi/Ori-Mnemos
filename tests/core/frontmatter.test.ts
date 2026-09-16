import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseFrontmatter,
  stringifyFrontmatter,
  readFrontmatterFile,
  writeFrontmatterFile,
  writeTempFrontmatter,
} from "../../src/core/frontmatter.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-test-fm-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("parseFrontmatter", () => {
  it("parses valid frontmatter with data and body", () => {
    const content = "---\ntitle: hello\ncount: 3\n---\nBody text here.";
    const result = parseFrontmatter(content);
    expect(result.data).toEqual({ title: "hello", count: 3 });
    expect(result.body).toBe("Body text here.");
    expect(result.errors).toEqual([]);
  });

  it("returns null data when no frontmatter boundary", () => {
    const content = "Just plain text without frontmatter.";
    const result = parseFrontmatter(content);
    expect(result.data).toBeNull();
    expect(result.body).toBe(content);
    expect(result.errors).toEqual([]);
  });

  it("returns error for unterminated frontmatter", () => {
    const content = "---\ntitle: hello\nno closing boundary";
    const result = parseFrontmatter(content);
    expect(result.data).toBeNull();
    expect(result.body).toBe(content);
    expect(result.errors).toContain("Unterminated frontmatter");
  });

  it("returns empty object for empty YAML block", () => {
    const content = "---\n---\nBody after empty frontmatter.";
    const result = parseFrontmatter(content);
    expect(result.data).toEqual({});
    expect(result.body).toBe("Body after empty frontmatter.");
    expect(result.errors).toEqual([]);
  });

  it("returns error for invalid YAML", () => {
    const content = "---\n: : : bad yaml\n---\nBody.";
    const result = parseFrontmatter(content);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/Invalid YAML frontmatter/);
  });

  it("converts non-object YAML to empty object", () => {
    const content = "---\njust a string\n---\nBody.";
    const result = parseFrontmatter(content);
    expect(result.data).toEqual({});
    expect(result.body).toBe("Body.");
  });

  it("handles Windows-style line endings", () => {
    const content = "---\r\ntitle: hello\r\n---\r\nBody.";
    const result = parseFrontmatter(content);
    expect(result.data).toEqual({ title: "hello" });
    expect(result.body).toBe("Body.");
  });

  it("preserves multiline body content", () => {
    const content = "---\ntype: note\n---\nLine 1\nLine 2\nLine 3";
    const result = parseFrontmatter(content);
    expect(result.body).toBe("Line 1\nLine 2\nLine 3");
  });
});

describe("stringifyFrontmatter", () => {
  it("produces valid frontmatter string", () => {
    const result = stringifyFrontmatter({ title: "hello" }, "Body.");
    expect(result).toMatch(/^---\n/);
    expect(result).toContain("title: hello");
    expect(result).toMatch(/---\nBody\.$/);
  });

  it("wraps empty object in frontmatter boundaries", () => {
    const result = stringifyFrontmatter({}, "Body only.");
    // yaml.stringify({}) produces "{}" which is non-empty, so boundaries are added
    expect(result).toMatch(/^---\n/);
    expect(result).toContain("Body only.");
  });

  it("normalizes leading newline in body", () => {
    const result = stringifyFrontmatter({ a: 1 }, "\nBody with leading newline.");
    // Should not have double newline between boundary and body
    expect(result).not.toContain("---\n\nBody");
  });

  it("round-trips with parseFrontmatter", () => {
    const data = { type: "insight", project: ["ori"], count: 42 };
    const body = "Some body content.\n\nWith paragraphs.";
    const stringified = stringifyFrontmatter(data, body);
    const parsed = parseFrontmatter(stringified);
    expect(parsed.data).toEqual(data);
    expect(parsed.body).toBe(body);
    expect(parsed.errors).toEqual([]);
  });
});

describe("readFrontmatterFile", () => {
  it("reads and parses a file with frontmatter", async () => {
    const filePath = path.join(tmpDir, "note.md");
    await fs.writeFile(filePath, "---\ntitle: test\n---\nContent.", "utf8");
    const result = await readFrontmatterFile(filePath);
    expect(result.data).toEqual({ title: "test" });
    expect(result.body).toBe("Content.");
  });
});

describe("writeFrontmatterFile", () => {
  it("writes a file that round-trips correctly", async () => {
    const filePath = path.join(tmpDir, "written.md");
    const data = { type: "decision", status: "active" };
    const body = "We decided X.";
    await writeFrontmatterFile(filePath, data, body);
    const result = await readFrontmatterFile(filePath);
    expect(result.data).toEqual(data);
    expect(result.body).toBe(body);
  });
});

describe("writeFrontmatterFile atomicity", () => {
  it("swaps the file in by rename, so the target is never a partial write", async () => {
    const filePath = path.join(tmpDir, "note.md");
    await writeFrontmatterFile(filePath, { status: "old" }, "Old body.");
    const original = await fs.readFile(filePath, "utf8");

    const realRename = fs.rename;
    const observed: Array<{ target: string; staged: string; sameDir: boolean }> = [];
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      // What a concurrent reader would see at the instant of the swap.
      observed.push({
        target: await fs.readFile(to as string, "utf8"),
        staged: await fs.readFile(from as string, "utf8"),
        sameDir: path.dirname(from as string) === path.dirname(to as string),
      });
      await realRename(from, to);
    });
    const writeSpy = vi.spyOn(fs, "writeFile");

    await writeFrontmatterFile(filePath, { status: "new" }, "New body.");

    expect(observed).toHaveLength(1);
    // The target still holds the complete previous note; the full new note is
    // already staged elsewhere. No moment exists where either is truncated.
    expect(observed[0].target).toBe(original);
    expect(observed[0].staged).toContain("status: new");
    expect(observed[0].staged).toContain("New body.");
    // rename is only atomic within a filesystem: the stage must be a sibling.
    expect(observed[0].sameDir).toBe(true);
    // Nothing is ever written straight at the user's note.
    for (const call of writeSpy.mock.calls) {
      expect(call[0]).not.toBe(filePath);
    }

    const after = await readFrontmatterFile(filePath);
    expect(after.data).toEqual({ status: "new" });
    expect(await fs.readdir(tmpDir)).toEqual(["note.md"]);
  });

  it("leaves the original note intact when the write is interrupted", async () => {
    const filePath = path.join(tmpDir, "note.md");
    await writeFrontmatterFile(filePath, { status: "old" }, "Old body.");
    const original = await fs.readFile(filePath, "utf8");

    vi.spyOn(fs, "rename").mockRejectedValue(new Error("simulated crash"));

    await expect(
      writeFrontmatterFile(filePath, { status: "new" }, "New body.")
    ).rejects.toThrow("simulated crash");

    expect(await fs.readFile(filePath, "utf8")).toBe(original);
    // No half-written staging file is left lying in the vault.
    expect(await fs.readdir(tmpDir)).toEqual(["note.md"]);
  });

  // Windows refuses a rename onto an open destination with EPERM. Every write
  // path must survive that, which is only true if it goes through
  // renameWithRetry; a direct fs.rename turns these red.
  function lockError(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`${code}: operation not permitted, rename`), {
      code,
    });
  }

  it("retries a transient lock refusal instead of surfacing it", async () => {
    const filePath = path.join(tmpDir, "note.md");
    await writeFrontmatterFile(filePath, { status: "old" }, "Old body.");

    const realRename = fs.rename;
    let attempts = 0;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      attempts += 1;
      if (attempts <= 3) {
        throw lockError("EPERM");
      }
      await realRename(from, to);
    });

    await writeFrontmatterFile(filePath, { status: "new" }, "New body.");

    expect(attempts).toBe(4);
    expect((await readFrontmatterFile(filePath)).data).toEqual({ status: "new" });
    expect(await fs.readdir(tmpDir)).toEqual(["note.md"]);
  });

  it("does not retry an error that is not a transient lock", async () => {
    const filePath = path.join(tmpDir, "note.md");
    await writeFrontmatterFile(filePath, { status: "old" }, "Old body.");
    const original = await fs.readFile(filePath, "utf8");

    let attempts = 0;
    vi.spyOn(fs, "rename").mockImplementation(async () => {
      attempts += 1;
      throw lockError("ENOSPC");
    });

    await expect(
      writeFrontmatterFile(filePath, { status: "new" }, "New body.")
    ).rejects.toThrow("ENOSPC");
    // A real error is reported at once, not after half a second of waiting.
    expect(attempts).toBe(1);
    expect(await fs.readFile(filePath, "utf8")).toBe(original);
    expect(await fs.readdir(tmpDir)).toEqual(["note.md"]);
  });

  it("gives up on a permanent lock after bounded retries, note still intact", async () => {
    const filePath = path.join(tmpDir, "note.md");
    await writeFrontmatterFile(filePath, { status: "old" }, "Old body.");
    const original = await fs.readFile(filePath, "utf8");

    let attempts = 0;
    vi.spyOn(fs, "rename").mockImplementation(async () => {
      attempts += 1;
      throw lockError("EBUSY");
    });

    await expect(
      writeFrontmatterFile(filePath, { status: "new" }, "New body.")
    ).rejects.toThrow("EBUSY");
    // Bounded: it retries, but it does not spin forever.
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(12);
    expect(await fs.readFile(filePath, "utf8")).toBe(original);
    expect(await fs.readdir(tmpDir)).toEqual(["note.md"]);
  });

  it("ignores a stale temp file and never collides between concurrent writers", async () => {
    const filePath = path.join(tmpDir, "note.md");
    await writeFrontmatterFile(filePath, { status: "seed" }, "Seed body.");
    const stalePath = path.join(tmpDir, ".note.md.stale.tmp");
    await fs.writeFile(stalePath, "half-written garbage", "utf8");

    // Eight writers, because two only lose the race intermittently. Every one
    // must resolve: a fixed temp name would make them collide, and on Windows
    // replacing an open destination is refused with EPERM, so a rename with no
    // retry drops most of these on the floor. Rounds are sequential; the
    // writers inside a round are not.
    const writers = ["a", "b", "c", "d", "e", "f", "g", "h"];
    for (let round = 0; round < 3; round += 1) {
      await Promise.all(
        writers.map((w) =>
          writeFrontmatterFile(filePath, { status: w, round }, `Body ${w}.`)
        )
      );

      // Exactly one writer's complete note is visible - frontmatter and body
      // from the same writer, never a splice of two.
      const after = await readFrontmatterFile(filePath);
      expect(writers).toContain(after.data?.status);
      expect(after.data?.round).toBe(round);
      expect(after.body.trim()).toBe(`Body ${after.data?.status}.`);
      // The crashed-out temp file is never adopted as the note's content, and
      // no staging file is left behind.
      expect(await fs.readFile(stalePath, "utf8")).toBe("half-written garbage");
      expect((await fs.readdir(tmpDir)).sort()).toEqual([
        ".note.md.stale.tmp",
        "note.md",
      ]);
    }
  });
});

describe("writeTempFrontmatter", () => {
  it("creates a temp file and returns its path", async () => {
    const data = { type: "idea" };
    const body = "Temp note.";
    const filePath = await writeTempFrontmatter(data, body);
    expect(filePath).toContain("ori-frontmatter-");
    expect(filePath).toMatch(/note\.md$/);
    const result = await readFrontmatterFile(filePath);
    expect(result.data).toEqual(data);
    // Clean up
    await fs.rm(path.dirname(filePath), { recursive: true, force: true });
  });
});
