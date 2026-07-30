import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateNapQueue, takeNapItem, recordKeptSeparate } from "../../src/core/nap.js";

// Blind contract tests from docs/wake-nap-design.md — author never sees these.
// Contract: generateNapQueue(scan) -> ordered queue; takeNapItem(queue) -> at most ONE item or null;
// recordKeptSeparate(dir, a, b) -> that pair never re-offered by subsequent generateNapQueue calls.

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ori-nap-")); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const scan = (over: Record<string, unknown> = {}) => ({
  inboxNotes: [{ title: "old-inbox", ageDays: 9 }],
  mergeCandidates: [{ a: "note-a", b: "note-b", similarity: 0.91, community: 3 }],
  fadingNotes: [{ title: "fading-1", vitality: 0.12, isArticulationPoint: false }],
  danglingLinks: [{ from: "note-c", target: "missing-note", suggestions: ["missing-note-2"] }],
  staleMaps: [],
  stateDir: tmp,
  ...over,
});

describe("nap one-item contract", () => {
  it("returns at most one item per take", async () => {
    const q = await generateNapQueue(scan() as never);
    const item = takeNapItem(q);
    expect(item).not.toBeNull();
    expect(Array.isArray(item)).toBe(false);
  });

  it("empty scan -> null (nothing due), not an error", async () => {
    const q = await generateNapQueue(scan({ inboxNotes: [], mergeCandidates: [], fadingNotes: [], danglingLinks: [] }) as never);
    expect(takeNapItem(q)).toBeNull();
  });

  it("priority: inbox promotion outranks merge outranks fade", async () => {
    const q = await generateNapQueue(scan() as never);
    expect(takeNapItem(q)!.kind).toBe("inbox_promote");
    const q2 = await generateNapQueue(scan({ inboxNotes: [] }) as never);
    expect(takeNapItem(q2)!.kind).toBe("merge_candidates");
    const q3 = await generateNapQueue(scan({ inboxNotes: [], mergeCandidates: [] }) as never);
    expect(takeNapItem(q3)!.kind).toBe("fade_review");
  });
});

describe("no-debt semantics", () => {
  it("kept-separate pair is NEVER re-offered", async () => {
    await recordKeptSeparate(tmp, "note-a", "note-b");
    const q = await generateNapQueue(scan() as never);
    const kinds = q.items.map((i: { kind: string }) => i.kind);
    expect(kinds).not.toContain("merge_candidates");
  });

  it("kept-separate is order-insensitive (b,a blocks a,b)", async () => {
    await recordKeptSeparate(tmp, "note-b", "note-a");
    const q = await generateNapQueue(scan() as never);
    expect(q.items.map((i: { kind: string }) => i.kind)).not.toContain("merge_candidates");
  });
});

describe("safety rails", () => {
  it("articulation points never appear in fade_review", async () => {
    const q = await generateNapQueue(scan({
      inboxNotes: [], mergeCandidates: [], danglingLinks: [],
      fadingNotes: [{ title: "bridge-note", vitality: 0.05, isArticulationPoint: true }],
    }) as never);
    expect(takeNapItem(q)).toBeNull();
  });

  it("fade_review batch capped at 5", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `f-${i}`, vitality: 0.1, isArticulationPoint: false }));
    const q = await generateNapQueue(scan({ inboxNotes: [], mergeCandidates: [], danglingLinks: [], fadingNotes: many }) as never);
    const item = takeNapItem(q)!;
    expect(item.kind).toBe("fade_review");
    expect((item.notes as unknown[]).length).toBeLessThanOrEqual(5);
  });
});
