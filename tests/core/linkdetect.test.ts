import { describe, it, expect } from "vitest";
import {
  detectLinks,
  applyLinks,
  suggestLinks,
  type VaultIndex,
} from "../../src/core/linkdetect.js";

describe("detectLinks", () => {
  it("detects exact title match in body", () => {
    const links = detectLinks("We should look at caching strategy.", [
      "caching strategy",
    ]);
    expect(links).toHaveLength(1);
    expect(links[0].title).toBe("caching strategy");
    expect(links[0].alreadyLinked).toBe(false);
  });

  it("detects case-insensitive match", () => {
    const links = detectLinks("CACHING STRATEGY is important.", [
      "caching strategy",
    ]);
    expect(links).toHaveLength(1);
    expect(links[0].title).toBe("caching strategy");
  });

  it("skips already-linked mentions inside [[]]", () => {
    const links = detectLinks("See [[caching strategy]] for details.", [
      "caching strategy",
    ]);
    expect(links).toHaveLength(1);
    expect(links[0].alreadyLinked).toBe(true);
  });

  it("handles slug-to-title matching (dashes as spaces)", () => {
    const links = detectLinks("Our caching-strategy works well.", [
      "caching-strategy",
    ]);
    expect(links).toHaveLength(1);
    expect(links[0].title).toBe("caching-strategy");
  });

  it("matches slug title against spaced text", () => {
    const links = detectLinks("The caching strategy is solid.", [
      "caching-strategy",
    ]);
    expect(links).toHaveLength(1);
  });

  it("longest match wins (no partial overlap)", () => {
    const links = detectLinks("Our caching strategy review was good.", [
      "caching strategy review",
      "caching strategy",
    ]);
    // Should match the longer title
    expect(links).toHaveLength(1);
    expect(links[0].title).toBe("caching strategy review");
  });

  it("returns correct offsets", () => {
    const body = "Start caching strategy end.";
    const links = detectLinks(body, ["caching strategy"]);
    expect(links[0].offset).toBe(6);
    expect(links[0].length).toBe(16);
  });

  it("detects multiple non-overlapping matches", () => {
    const links = detectLinks("alpha is related to beta and also gamma.", [
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.title).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("returns empty for no matches", () => {
    const links = detectLinks("Nothing to see here.", ["missing-title"]);
    expect(links).toEqual([]);
  });
});

describe("applyLinks", () => {
  it("wraps detected mentions in [[]]", () => {
    const links = detectLinks("See caching strategy for details.", [
      "caching strategy",
    ]);
    const result = applyLinks("See caching strategy for details.", links);
    expect(result).toBe("See [[caching strategy]] for details.");
  });

  it("handles multiple non-overlapping matches", () => {
    const body = "alpha connects to beta.";
    const links = detectLinks(body, ["alpha", "beta"]);
    const result = applyLinks(body, links);
    expect(result).toBe("[[alpha]] connects to [[beta]].");
  });

  it("does not double-wrap already-linked mentions", () => {
    const body = "See [[alpha]] and beta.";
    const links = detectLinks(body, ["alpha", "beta"]);
    const result = applyLinks(body, links);
    expect(result).toBe("See [[alpha]] and [[beta]].");
    // alpha should NOT become [[[[alpha]]]]
    expect(result).not.toContain("[[[[");
  });

  it("returns body unchanged when no unlinked matches", () => {
    const body = "See [[alpha]] here.";
    const links = detectLinks(body, ["alpha"]);
    const result = applyLinks(body, links);
    expect(result).toBe(body);
  });
});

describe("suggestLinks", () => {
  function makeIndex(overrides?: Partial<VaultIndex>): VaultIndex {
    return {
      titles: overrides?.titles ?? [],
      frontmatter: overrides?.frontmatter ?? new Map(),
      graph: overrides?.graph ?? {
        outgoing: new Map(),
        incoming: new Map(),
      },
    };
  }

  it("suggests title matches with high confidence", () => {
    const index = makeIndex({ titles: ["caching strategy"] });
    const suggestions = suggestLinks(
      {},
      "Our caching strategy needs work.",
      index
    );
    const match = suggestions.find((s) => s.title === "caching strategy");
    expect(match).toBeDefined();
    expect(match!.reason).toBe("title-match");
    expect(match!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("suggests project-overlap connections", () => {
    const fm = new Map<string, Record<string, unknown>>();
    fm.set("other-note", { project: ["ori"] });
    const index = makeIndex({ titles: ["other-note"], frontmatter: fm });
    const suggestions = suggestLinks(
      { project: ["ori"] },
      "Some body text.",
      index
    );
    const match = suggestions.find(
      (s) => s.title === "other-note" && s.reason === "project-overlap"
    );
    expect(match).toBeDefined();
  });

  it("suggests shared-neighborhood connections (triangle closing)", () => {
    const incoming = new Map<string, Set<string>>();
    incoming.set("common", new Set(["note-a", "note-b"]));
    const index = makeIndex({
      titles: ["common", "note-a", "note-b"],
      frontmatter: new Map(),
      graph: {
        outgoing: new Map(),
        incoming,
      },
    });
    // Body mentions "common" → detectLinks finds it → look for co-linkers
    const suggestions = suggestLinks({}, "We reference common here.", index);
    const coLinker = suggestions.find(
      (s) => s.reason === "shared-neighborhood"
    );
    expect(coLinker).toBeDefined();
    expect(["note-a", "note-b"]).toContain(coLinker!.title);
  });

  it("returns empty for no connections", () => {
    const index = makeIndex();
    const suggestions = suggestLinks({}, "Isolated note.", index);
    expect(suggestions).toEqual([]);
  });

  it("sorts by confidence descending", () => {
    const fm = new Map<string, Record<string, unknown>>();
    fm.set("proj-note", { project: ["ori"] });
    const index = makeIndex({
      titles: ["exact-match", "proj-note"],
      frontmatter: fm,
    });
    const suggestions = suggestLinks(
      { project: ["ori"] },
      "See exact-match for details.",
      index
    );
    // Title match should come before project overlap
    if (suggestions.length >= 2) {
      expect(suggestions[0].confidence).toBeGreaterThanOrEqual(
        suggestions[1].confidence
      );
    }
  });
});
