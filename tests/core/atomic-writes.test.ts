import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { readState, writeState } from "../../src/core/state.js";
import { recordKeptSeparate, generateNapQueue } from "../../src/core/nap.js";

// The JSON state writers have the same read-modify-write-whole-file shape as
// frontmatter writes: an interrupted write used to truncate the file and lose
// the previous contents. These pin the temp-and-rename discipline.

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-test-atomic-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("writeState", () => {
  it("keeps the previous state when the write is interrupted", async () => {
    await writeState(tmpDir, { onboarded: true, version: "1.0.0" });
    const statePath = path.join(tmpDir, ".ori", "state.json");
    const original = await fs.readFile(statePath, "utf8");

    vi.spyOn(fs, "rename").mockRejectedValue(new Error("simulated crash"));

    await expect(writeState(tmpDir, { version: "2.0.0" })).rejects.toThrow(
      "simulated crash"
    );

    expect(await fs.readFile(statePath, "utf8")).toBe(original);
    const state = await readState(tmpDir);
    expect(state).toEqual({ onboarded: true, version: "1.0.0" });
    expect(await fs.readdir(path.join(tmpDir, ".ori"))).toEqual(["state.json"]);
  });

  it("stages a sibling temp file, never the target itself", async () => {
    const statePath = path.join(tmpDir, ".ori", "state.json");
    const writeSpy = vi.spyOn(fs, "writeFile");

    await writeState(tmpDir, { onboarded: true, version: "1.0.0" });

    for (const call of writeSpy.mock.calls) {
      expect(call[0]).not.toBe(statePath);
    }
    expect(await readState(tmpDir)).toEqual({
      onboarded: true,
      version: "1.0.0",
    });
  });
});

describe("recordKeptSeparate", () => {
  it("keeps the existing ledger when the write is interrupted", async () => {
    await recordKeptSeparate(tmpDir, "note-a", "note-b");
    const ledgerPath = path.join(tmpDir, "kept-separate.json");
    const original = await fs.readFile(ledgerPath, "utf8");

    vi.spyOn(fs, "rename").mockRejectedValue(new Error("simulated crash"));

    await expect(
      recordKeptSeparate(tmpDir, "note-c", "note-d")
    ).rejects.toThrow("simulated crash");

    // The earlier decision survives: a truncated ledger would re-offer it.
    expect(await fs.readFile(ledgerPath, "utf8")).toBe(original);
    expect(JSON.parse(await fs.readFile(ledgerPath, "utf8"))).toEqual([
      "note-a|note-b",
    ]);
    expect(await fs.readdir(tmpDir)).toEqual(["kept-separate.json"]);
  });

  it("still suppresses a recorded pair after a neighbouring write fails", async () => {
    await recordKeptSeparate(tmpDir, "note-a", "note-b");
    vi.spyOn(fs, "rename").mockRejectedValue(new Error("simulated crash"));
    await expect(
      recordKeptSeparate(tmpDir, "note-c", "note-d")
    ).rejects.toThrow("simulated crash");
    vi.restoreAllMocks();

    const scan = (pair: { a: string; b: string }) => ({
      inboxNotes: [],
      mergeCandidates: [{ ...pair, similarity: 0.95, community: 3 }],
      fadingNotes: [],
      danglingLinks: [],
      staleMaps: [],
      stateDir: tmpDir,
    });

    // Positive control: an unrecorded pair is offered.
    const control = await generateNapQueue(
      scan({ a: "note-x", b: "note-y" }) as never
    );
    expect(control.items.map((i) => i.kind)).toContain("merge_candidates");

    const queue = await generateNapQueue(
      scan({ a: "note-a", b: "note-b" }) as never
    );
    expect(queue.items.map((i) => i.kind)).not.toContain("merge_candidates");
  });
});
