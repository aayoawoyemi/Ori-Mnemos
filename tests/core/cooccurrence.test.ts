import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  initCoOccurrenceTables,
  computeNPMI,
  gloveWeight,
  edgeDecay,
  computeEdgeWeight,
  recordCoRetrieval,
  extractCoOccurrencePairs,
  runHomeostasis,
  recomputeAllNPMI,
  bootstrapFromWikiLinks,
  GLOVE_XMAX,
  EBBINGHAUS_BASE_DAYS,
  DECAY_FLOOR,
  HOMEOSTASIS_TARGET,
  BOOTSTRAP_BCS_THRESHOLD,
  BOOTSTRAP_INIT_WEIGHT,
  BOOTSTRAP_HUB_POSTER_CAP,
} from "../../src/core/cooccurrence.js";
import { initQValueTables, logRetrieval } from "../../src/core/qvalue.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  initCoOccurrenceTables(db);
  initQValueTables(db);
});

describe("computeNPMI", () => {
  it("returns -1 when countAB is 0", () => {
    expect(computeNPMI(0, 10, 10, 100)).toBe(-1);
  });

  it("returns 1.0 for perfect co-occurrence (always together)", () => {
    // If A and B always co-occur: p(AB) = p(A) = p(B)
    // PMI = log(1) = 0, but NPMI = 0 / -log(pAB)... actually:
    // p(AB) = 5/10, p(A) = 5/10, p(B) = 5/10
    // PMI = log(0.5 / (0.5 * 0.5)) = log(2)
    // NPMI = log(2) / -log(0.5) = log(2) / log(2) = 1.0
    expect(computeNPMI(5, 5, 5, 10)).toBeCloseTo(1.0, 10);
  });

  it("returns negative for anti-correlated notes", () => {
    // A appears 50 times, B appears 50 times, but they co-occur only 1 time out of 100
    const npmi = computeNPMI(1, 50, 50, 100);
    expect(npmi).toBeLessThan(0);
  });

  it("is bounded [-1, 1]", () => {
    const values = [
      computeNPMI(5, 10, 10, 100),
      computeNPMI(10, 10, 10, 100),
      computeNPMI(1, 50, 50, 100),
    ];
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("gloveWeight", () => {
  it("returns 1.0 at x_max", () => {
    expect(gloveWeight(GLOVE_XMAX)).toBe(1.0);
  });

  it("returns 1.0 above x_max", () => {
    expect(gloveWeight(GLOVE_XMAX + 50)).toBe(1.0);
  });

  it("returns sub-linear weight below x_max", () => {
    const w = gloveWeight(50);
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThan(1);
    // (50/100)^0.75 ≈ 0.5946
    expect(w).toBeCloseTo(Math.pow(0.5, 0.75), 4);
  });

  it("is monotonically increasing", () => {
    const weights = [1, 5, 10, 25, 50, 75, 100].map(gloveWeight);
    for (let i = 1; i < weights.length; i++) {
      expect(weights[i]).toBeGreaterThanOrEqual(weights[i - 1]);
    }
  });
});

describe("edgeDecay", () => {
  it("returns ~1.0 for daysSince=0", () => {
    expect(edgeDecay(0, 5)).toBeCloseTo(1.0, 10);
  });

  it("respects decay floor", () => {
    expect(edgeDecay(10000, 1)).toBe(DECAY_FLOOR);
  });

  it("decays slower for frequently co-retrieved pairs (strength accumulation)", () => {
    const decayLow = edgeDecay(30, 1);
    const decayHigh = edgeDecay(30, 50);
    expect(decayHigh).toBeGreaterThan(decayLow);
  });

  it("reaches ~0.37 at base half-life for count=0", () => {
    // exp(-30 / (30 * 1)) = exp(-1) ≈ 0.368
    const decay = edgeDecay(EBBINGHAUS_BASE_DAYS, 0);
    expect(decay).toBeCloseTo(Math.exp(-1), 2);
  });
});

describe("recordCoRetrieval", () => {
  it("creates a new edge", () => {
    recordCoRetrieval(db, "note-b", "note-a");
    const row = db
      .prepare("SELECT * FROM co_occurrence WHERE note_a = ? AND note_b = ?")
      .get("note-a", "note-b") as any;
    expect(row).toBeDefined();
    expect(row.co_retrieval_count).toBe(1);
  });

  it("ensures consistent ordering (alphabetical)", () => {
    recordCoRetrieval(db, "zzz-note", "aaa-note");
    const row = db.prepare("SELECT * FROM co_occurrence").get() as any;
    expect(row.note_a).toBe("aaa-note");
    expect(row.note_b).toBe("zzz-note");
  });

  it("increments count on repeated co-retrieval", () => {
    recordCoRetrieval(db, "note-a", "note-b");
    recordCoRetrieval(db, "note-a", "note-b");
    recordCoRetrieval(db, "note-b", "note-a"); // reversed order, same pair
    const row = db.prepare("SELECT * FROM co_occurrence").get() as any;
    expect(row.co_retrieval_count).toBe(3);
  });
});

describe("extractCoOccurrencePairs", () => {
  it("creates edges from co-retrieved notes within same query", () => {
    logRetrieval(db, "s1", "query1", "semantic", "note-a", 0, 0.9, 0.5, 0.1, 0.8);
    logRetrieval(db, "s1", "query1", "semantic", "note-b", 1, 0.8, 0.5, 0.1, 0.7);
    logRetrieval(db, "s1", "query1", "semantic", "note-c", 2, 0.7, 0.5, 0.1, 0.6);

    extractCoOccurrencePairs(db, "s1");

    const edges = db.prepare("SELECT * FROM co_occurrence").all() as any[];
    // 3 notes → 3 pairs: (a,b), (a,c), (b,c)
    expect(edges).toHaveLength(3);
  });

  it("does not create edges across different queries", () => {
    logRetrieval(db, "s1", "query1", "semantic", "note-a", 0, 0.9, 0.5, 0.1, 0.8);
    logRetrieval(db, "s1", "query2", "semantic", "note-b", 0, 0.8, 0.5, 0.1, 0.7);

    extractCoOccurrencePairs(db, "s1");

    const edges = db.prepare("SELECT * FROM co_occurrence").all() as any[];
    // Different queries → no co-occurrence
    expect(edges).toHaveLength(0);
  });
});

describe("runHomeostasis", () => {
  it("scales edge weights toward target mean", () => {
    // Create edges with high weights
    db.prepare(
      "INSERT INTO co_occurrence (note_a, note_b, npmi_weight) VALUES (?, ?, ?)",
    ).run("a", "b", 2.0);
    db.prepare(
      "INSERT INTO co_occurrence (note_a, note_b, npmi_weight) VALUES (?, ?, ?)",
    ).run("a", "c", 2.0);

    runHomeostasis(db);

    // After homeostasis, mean weight for node 'a' should be closer to HOMEOSTASIS_TARGET
    const edges = db
      .prepare("SELECT npmi_weight FROM co_occurrence WHERE note_a = ?")
      .all("a") as { npmi_weight: number }[];
    const mean =
      edges.reduce((s, e) => s + e.npmi_weight, 0) / edges.length;
    // Won't be exactly target due to node 'b' and 'c' also being processed
    expect(mean).toBeLessThan(2.0); // should have decreased
  });
});

describe("bootstrapFromWikiLinks", () => {
  it("creates edges for notes sharing wiki-link targets", () => {
    const noteLinks = new Map([
      ["note-a", new Set(["target-1", "target-2", "target-3"])],
      ["note-b", new Set(["target-1", "target-2"])],
      ["note-c", new Set(["target-99"])],
    ]);

    bootstrapFromWikiLinks(db, noteLinks);

    const edges = db.prepare("SELECT * FROM co_occurrence").all() as any[];
    // note-a and note-b share 2 targets → BCS = 2/sqrt(3*2) ≈ 0.816 > threshold
    // note-a and note-c share 0 → no edge
    // note-b and note-c share 0 → no edge
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe("bootstrap");
  });

  it("uses BCS * BOOTSTRAP_INIT_WEIGHT for initial weight", () => {
    const noteLinks = new Map([
      ["note-a", new Set(["t1", "t2"])],
      ["note-b", new Set(["t1", "t2"])],
    ]);

    bootstrapFromWikiLinks(db, noteLinks);

    const edge = db.prepare("SELECT * FROM co_occurrence").get() as any;
    // BCS = 2/sqrt(2*2) = 1.0 → weight = 1.0 * 0.15 = 0.15
    expect(edge.npmi_weight).toBeCloseTo(BOOTSTRAP_INIT_WEIGHT, 10);
  });

  it("creates an edge when BCS clears the threshold", () => {
    const noteLinks = new Map([
      ["note-a", new Set(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"])],
      ["note-b", new Set(["t1"])],
    ]);

    bootstrapFromWikiLinks(db, noteLinks);

    // 1 shared / sqrt(10 * 1) = 0.3162 > 0.1
    const edges = db
      .prepare("SELECT npmi_weight FROM co_occurrence")
      .all() as { npmi_weight: number }[];
    expect(edges).toHaveLength(1);
    expect(edges[0].npmi_weight).toBeCloseTo(
      (1 / Math.sqrt(10)) * BOOTSTRAP_INIT_WEIGHT,
      12,
    );
  });

  it("skips pairs below BCS threshold", () => {
    // 1 shared target, both notes degree 11 → BCS = 1/sqrt(121) = 0.0909 < 0.1
    const wide = (extra: string) =>
      new Set(["shared", ...Array.from({ length: 10 }, (_, i) => `${extra}-${i}`)]);
    const noteLinks = new Map([
      ["note-a", wide("a")],
      ["note-b", wide("b")],
    ]);

    bootstrapFromWikiLinks(db, noteLinks);

    expect(db.prepare("SELECT COUNT(*) AS c FROM co_occurrence").get()).toEqual({
      c: 0,
    });
  });
});

/**
 * `bootstrapFromWikiLinks` is target-inverted, not all-pairs.
 *
 * The all-pairs predecessor compared every ordered pair of notes and
 * intersected their link sets. Measured against it on identical inputs
 * (throwaway harness, both implementations writing to fresh in-memory DBs,
 * rows compared on note_a/note_b/co_retrieval_count/npmi_weight/source with
 * 1e-12 tolerance):
 *
 *   notes   old         new        rows compared   verdict
 *     250      80.8 ms    18.3 ms      4,425       identical
 *     500     204.4 ms    48.6 ms     11,240       identical
 *   1,000     545.5 ms   124.9 ms     25,543       identical
 *   1,524     832.3 ms   149.5 ms     37,954       identical
 *   5,000   4,760.5 ms   759.8 ms    126,113       identical
 *   1,537 real vault, hub targets removed: 438.7 ms -> 85.8 ms, 11,715 identical
 *
 * On the unmodified real vault (1,537 notes) the hub cap engages and the old
 * result is NOT reproduced, deliberately: 11,425.8 ms / 620,363 rows becomes
 * 75.0 ms / 11,326 rows. Every capped row is present in the uncapped result
 * with a weight no lower (verified: 0 extra rows, 0 raised weights), so the
 * cap only ever withdraws evidence. See BOOTSTRAP_HUB_POSTER_CAP.
 */
describe("bootstrapFromWikiLinks target inversion", () => {
  const rows = () =>
    db
      .prepare(
        "SELECT note_a, note_b, npmi_weight FROM co_occurrence ORDER BY note_a, note_b",
      )
      .all() as { note_a: string; note_b: string; npmi_weight: number }[];

  it("writes nothing for an empty link map", () => {
    bootstrapFromWikiLinks(db, new Map());
    expect(rows()).toEqual([]);
  });

  it("writes nothing for a single note", () => {
    bootstrapFromWikiLinks(db, new Map([["only", new Set(["t1", "t2"])]]));
    expect(rows()).toEqual([]);
  });

  it("writes nothing when no two notes share a target", () => {
    const noteLinks = new Map(
      Array.from({ length: 40 }, (_, i) => [
        `note-${i}`,
        new Set([`t-${i}-x`, `t-${i}-y`]),
      ]),
    );

    bootstrapFromWikiLinks(db, noteLinks);

    expect(rows()).toEqual([]);
  });

  it("never pairs a note with itself and emits each pair exactly once", () => {
    // 6 notes all linking to "hub-lite" plus one private target each, so every
    // one of the 15 unordered pairs co-occurs. Degrees are all 2, shared is
    // always 1 → BCS = 1/sqrt(4) = 0.5, comfortably above threshold.
    const noteLinks = new Map(
      Array.from({ length: 6 }, (_, i) => [
        `n-${i}`,
        new Set(["hub-lite", `private-${i}`]),
      ]),
    );

    bootstrapFromWikiLinks(db, noteLinks);

    const edges = rows();
    expect(edges).toHaveLength(15); // C(6,2)
    for (const e of edges) {
      expect(e.note_a).not.toBe(e.note_b);
      // Sorted ordering, so (A,B) and (B,A) can never both exist —
      // consistent with recordCoRetrieval.
      expect(e.note_a < e.note_b).toBe(true);
    }
    const keys = edges.map((e) => `${e.note_a}\u0000${e.note_b}`);
    expect(new Set(keys).size).toBe(keys.length);
    // A pair double-counted during accumulation would read 2/sqrt(4) = 1.0.
    for (const e of edges) {
      expect(e.npmi_weight).toBeCloseTo(0.5 * BOOTSTRAP_INIT_WEIGHT, 12);
    }
  });

  it("normalises by the geometric mean of out-degrees, not their product", () => {
    // Asymmetric degrees so sqrt(2 * 8) = 4 is distinguishable from 2 * 8 = 16.
    const noteLinks = new Map([
      ["note-a", new Set(["t1", "t2"])],
      [
        "note-b",
        new Set(["t1", "t2", "x3", "x4", "x5", "x6", "x7", "x8"]),
      ],
    ]);

    bootstrapFromWikiLinks(db, noteLinks);

    const edges = rows();
    expect(edges).toHaveLength(1);
    // 2 / sqrt(2 * 8) = 0.5 → 0.075. A plain division gives 2/16 = 0.125 → 0.01875.
    expect(edges[0].npmi_weight).toBeCloseTo(0.5 * BOOTSTRAP_INIT_WEIGHT, 12);
  });

  it("accumulates every shared target, not just the first", () => {
    const noteLinks = new Map([
      ["note-a", new Set(["t1", "t2", "t3", "a4"])],
      ["note-b", new Set(["t1", "t2", "t3", "b4"])],
    ]);

    bootstrapFromWikiLinks(db, noteLinks);

    const edges = rows();
    expect(edges).toHaveLength(1);
    // 3 / sqrt(4 * 4) = 0.75
    expect(edges[0].npmi_weight).toBeCloseTo(0.75 * BOOTSTRAP_INIT_WEIGHT, 12);
  });

  it("counts a target posted by exactly the cap, and ignores one above it", () => {
    // Real vault measurement: 4 of 900 targets exceed the cap ("index" 1016,
    // "relevant-map" 882, "related-note" 853, "ai agents map" 462) and hold
    // 98.8% of all within-target pair work. The next largest posts 65.
    const atCap = new Map(
      Array.from({ length: BOOTSTRAP_HUB_POSTER_CAP }, (_, i) => [
        `n-${String(i).padStart(4, "0")}`,
        new Set(["busy"]),
      ]),
    );
    bootstrapFromWikiLinks(db, atCap);
    const n = BOOTSTRAP_HUB_POSTER_CAP;
    expect(rows()).toHaveLength((n * (n - 1)) / 2);

    db.exec("DELETE FROM co_occurrence");

    // One more poster and the target stops carrying coupling evidence.
    const overCap = new Map(atCap);
    overCap.set("n-zzzz", new Set(["busy"]));
    bootstrapFromWikiLinks(db, overCap);
    expect(rows()).toEqual([]);
  });

  it("keeps coupling from ordinary targets when a hub target is ignored", () => {
    // Every note links to the over-cap hub; two of them also share one
    // ordinary target. Degrees (the BCS denominator) are unchanged by the cap,
    // so the surviving edge is scored on the ordinary target alone.
    const noteLinks = new Map(
      Array.from({ length: BOOTSTRAP_HUB_POSTER_CAP + 1 }, (_, i) => [
        `n-${String(i).padStart(4, "0")}`,
        new Set(["hub"]),
      ]),
    );
    noteLinks.get("n-0000")!.add("ordinary");
    noteLinks.get("n-0001")!.add("ordinary");

    bootstrapFromWikiLinks(db, noteLinks);

    const edges = rows();
    expect(edges).toHaveLength(1);
    expect(edges[0].note_a).toBe("n-0000");
    expect(edges[0].note_b).toBe("n-0001");
    // shared = 1 ("ordinary" only; "hub" contributes nothing), degrees 2 and 2.
    expect(edges[0].npmi_weight).toBeCloseTo(0.5 * BOOTSTRAP_INIT_WEIGHT, 12);
  });
});
