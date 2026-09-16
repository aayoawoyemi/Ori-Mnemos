/**
 * Ori Mnemos — exploration injection (fix-list item 18)
 *
 * `injectExploration` picks ~1 random note to splice into the tail of a
 * result page. It used to copy every candidate title into a new array and
 * Fisher-Yates shuffle all of it — on the real 1,524-note vault that is
 * ~1,500 swaps and two N-sized allocations to choose one title, then
 * `slice(0, 1)` threw the rest away. The work was O(N) for an O(k) need.
 *
 * Measured end to end on this machine (11th-gen i7, node, 2,000 calls per
 * point, 10 results, exploration_budget 0.15 -> replaceCount 1):
 *
 *     candidates    full shuffle    index rejection
 *     1,524            0.0404 ms         0.0016 ms      ~26x
 *     10,000           0.3667 ms         0.0005 ms     ~690x
 *     200,000         11.6784 ms         0.0006 ms   ~19965x
 *
 * The shuffle column is linear in N; the rejection column is flat at
 * ~0.001 ms because it never looks at the candidates it does not pick.
 * (At replaceCount 5 the same points read 0.0550/0.0032, 0.4027/0.0012 and
 * 11.7870/0.0014 ms.)
 *
 * The replacement draws random indices out of `allNotes` and rejects the
 * ones already on the page, so cost tracks k, not N. The two things that
 * are easy to get wrong when you stop shuffling everything are covered
 * below and are the reason these tests exist:
 *
 *   1. a loop that can draw the same index twice injects a duplicate note;
 *   2. a loop that reads the head of the array biases selection, which
 *      silently destroys the anti-popularity-bias purpose of exploration.
 *
 * `Math.random` is replaced with a seeded PRNG so the sampling assertions
 * are reproducible rather than occasionally red.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { injectExploration } from "../../src/core/tracking.js";
import type { ScoredNote } from "../../src/core/ranking.js";

/** Deterministic uniform source (mulberry32) standing in for Math.random. */
function seedRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function useSeed(seed: number): void {
  vi.spyOn(Math, "random").mockImplementation(seedRandom(seed));
}

function page(titles: string[]): ScoredNote[] {
  return titles.map((title, i) => ({
    title,
    score: 1 - i / titles.length,
    signals: {},
    metadata: {},
  }));
}

function notes(count: number, prefix = "note"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
}

function injected(out: ScoredNote[]): string[] {
  return out.filter((r) => r.metadata?.wasExploration === true).map((r) => r.title);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("injectExploration selection", () => {
  it("never injects a duplicate or a note already on the page (500 draws)", () => {
    useSeed(0xc0ffee);
    const results = page(notes(10, "result"));
    const onPage = new Set(results.map((r) => r.title));
    const allNotes = [...onPage, ...notes(30, "other")];

    for (let iteration = 0; iteration < 500; iteration++) {
      const out = injectExploration(results, allNotes, 0.5); // replaceCount 5
      const picks = injected(out);

      expect(picks).toHaveLength(5);
      expect(new Set(picks).size).toBe(5);
      for (const title of picks) {
        expect(onPage.has(title)).toBe(false);
      }
      expect(out).toHaveLength(results.length);
    }
  });

  it("holds the same guarantee when candidates are scarcer than the budget", () => {
    // 3 candidates for a budget of 5: the scan path, plus the deficit pad.
    useSeed(0x5eed);
    const results = page(notes(10, "result"));
    const onPage = new Set(results.map((r) => r.title));
    const allNotes = [...onPage, "spare-a", "spare-b", "spare-c"];

    for (let iteration = 0; iteration < 500; iteration++) {
      const out = injectExploration(results, allNotes, 0.5);
      const picks = injected(out);

      expect(picks).toHaveLength(3);
      expect(new Set(picks).size).toBe(3);
      for (const title of picks) {
        expect(onPage.has(title)).toBe(false);
      }
      // Deficit is padded from the originals, so the page keeps its length.
      expect(out).toHaveLength(results.length);
    }
  });

  it("gives every candidate an equal chance of being picked", () => {
    /**
     * 20 candidates, one pick per call, 20,000 trials: each candidate is
     * expected 1,000 times with sd = sqrt(20000 * 0.05 * 0.95) = 30.8.
     * The +-20% band ([800, 1200]) is 6.5 sd wide, so a uniform sampler
     * fails this with probability ~3e-9 even across all 20 bins - the
     * bound is loose enough never to flake and tight enough to catch the
     * failures that matter: head bias puts 20,000 in one bin, and any
     * off-by-one that excludes the last index leaves a bin at 0.
     */
    useSeed(0x1234abcd);
    const results = page(notes(6, "result"));
    const candidates = notes(20, "cand");
    const allNotes = [...results.map((r) => r.title), ...candidates];

    const trials = 20_000;
    const counts = new Map<string, number>();
    for (let t = 0; t < trials; t++) {
      const picks = injected(injectExploration(results, allNotes, 0.15)); // replaceCount 1
      expect(picks).toHaveLength(1);
      counts.set(picks[0]!, (counts.get(picks[0]!) ?? 0) + 1);
    }

    for (const candidate of candidates) {
      const seen = counts.get(candidate) ?? 0;
      expect(seen).toBeGreaterThan(0);
      expect(seen).toBeGreaterThanOrEqual(800);
      expect(seen).toBeLessThanOrEqual(1200);
    }
  });

  it("stays uniform when candidates are too scarce to hit by chance", () => {
    /**
     * 38 of 40 notes are already on the page, so most draws are rejected
     * and selection falls through to the enumerate-and-partial-shuffle
     * path. 4,000 trials over 2 candidates: expected 2,000 each,
     * sd = sqrt(4000 * 0.25) = 31.6, and the +-10% band is 6.3 sd.
     */
    useSeed(0x99);
    const results = page(notes(38, "result"));
    const allNotes = [...results.map((r) => r.title), "rare-a", "rare-b"];

    const counts = new Map<string, number>();
    for (let t = 0; t < 4_000; t++) {
      const picks = injected(injectExploration(results, allNotes, 0.02)); // replaceCount 1
      expect(picks).toHaveLength(1);
      counts.set(picks[0]!, (counts.get(picks[0]!) ?? 0) + 1);
    }

    for (const candidate of ["rare-a", "rare-b"]) {
      const seen = counts.get(candidate) ?? 0;
      expect(seen).toBeGreaterThanOrEqual(1_800);
      expect(seen).toBeLessThanOrEqual(2_200);
    }
  });

  it("costs the same whether there are 2,000 candidates or 200,000", () => {
    /**
     * Guards the O(k) property without a wall clock: every random draw
     * comes from `Math.random`, so counting draws counts the work. A full
     * shuffle needs one draw per candidate (199,999 at the larger size);
     * index rejection needs a handful regardless. 40 is ~2x the 4k+16
     * attempt cap for k=1, which leaves room for rejected draws while
     * still being 5,000x below the shuffle it replaced.
     */
    const results = page(notes(10, "result"));
    for (const size of [2_000, 200_000]) {
      const source = seedRandom(0xbeef);
      let draws = 0;
      const spy = vi.spyOn(Math, "random").mockImplementation(() => {
        draws++;
        return source();
      });

      const allNotes = [...results.map((r) => r.title), ...notes(size, "cand")];
      const out = injectExploration(results, allNotes, 0.15);

      expect(injected(out)).toHaveLength(1);
      expect(draws).toBeLessThan(40);
      spy.mockRestore();
    }
  });
});

describe("injectExploration pass-through", () => {
  it("returns a copy, not the input array, when budget is not positive", () => {
    const results = page(notes(5, "result"));
    const allNotes = [...results.map((r) => r.title), ...notes(10, "other")];

    for (const budget of [0, -0.5]) {
      const out = injectExploration(results, allNotes, budget);
      expect(out).not.toBe(results);
      expect(out).toEqual(results);
      expect(injected(out)).toEqual([]);
    }
  });

  it("returns a copy, not the input array, when results are empty", () => {
    const results: ScoredNote[] = [];
    const out = injectExploration(results, notes(10, "other"), 0.5);
    expect(out).not.toBe(results);
    expect(out).toEqual([]);
  });

  it("leaves the caller's results array untouched", () => {
    useSeed(7);
    const results = page(notes(10, "result"));
    const before = results.map((r) => r.title);
    const allNotes = [...before, ...notes(30, "other")];

    const out = injectExploration(results, allNotes, 0.5);

    expect(out).not.toBe(results);
    expect(results.map((r) => r.title)).toEqual(before);
    expect(results.some((r) => r.metadata?.wasExploration === true)).toBe(false);
  });
});
