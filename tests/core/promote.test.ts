import { describe, it, expect } from "vitest";
import {
  computePromotion,
  injectFooters,
  isTemplatePlaceholder,
  type PromoteInput,
} from "../../src/core/promote.js";
import type { VaultIndex } from "../../src/core/linkdetect.js";
import type { ProjectKeywordConfig } from "../../src/core/classify.js";

function makeInput(overrides?: Partial<PromoteInput>): PromoteInput {
  const defaultIndex: VaultIndex = {
    titles: [],
    frontmatter: new Map(),
    graph: { outgoing: new Map(), incoming: new Map() },
  };

  return {
    inboxPath: "inbox/my-note.md",
    frontmatter: {
      description: "A test note",
      type: "insight",
      project: [],
      status: "inbox",
      created: "2026-02-20",
      last_accessed: "2026-02-20",
      access_count: 0,
    },
    body: "Some content about the topic.",
    existingTitles: [],
    vaultIndex: defaultIndex,
    overrides: {},
    projectConfig: { known_projects: [], keywords: {} },
    mapRouting: {},
    defaultArea: "index",
    ...overrides,
  };
}

describe("computePromotion", () => {
  it("sets status to active", () => {
    const result = computePromotion(makeInput());
    expect(result.updatedFrontmatter.status).toBe("active");
  });

  it("classifies type from content when not set", () => {
    const result = computePromotion(
      makeInput({
        inboxPath: "inbox/decided-to-use-react.md",
        frontmatter: {
          description: "",
          project: [],
          status: "inbox",
          created: "2026-02-20",
          last_accessed: "2026-02-20",
          access_count: 0,
        },
        body: "We decided to go with React. The rationale is ecosystem size and team experience.",
      })
    );
    expect(result.classification.type).toBe("decision");
    expect(result.updatedFrontmatter.type).toBe("decision");
  });

  it("respects type override", () => {
    const result = computePromotion(
      makeInput({ overrides: { type: "blocker" } })
    );
    expect(result.classification.type).toBe("blocker");
    expect(result.updatedFrontmatter.type).toBe("blocker");
  });

  it("auto-detects wiki-links in body", () => {
    const result = computePromotion(
      makeInput({
        body: "This relates to caching strategy we discussed.",
        existingTitles: ["caching-strategy"],
        vaultIndex: {
          titles: ["caching-strategy"],
          frontmatter: new Map(),
          graph: { outgoing: new Map(), incoming: new Map() },
        },
      })
    );
    expect(result.detectedLinks.length).toBeGreaterThan(0);
  });

  it("appends override links", () => {
    const result = computePromotion(
      makeInput({
        overrides: { links: ["related-note", "another-note"] },
      })
    );
    expect(result.changes.some((c) => c.includes("explicit link"))).toBe(true);
  });

  it("updates last_accessed to today", () => {
    const result = computePromotion(makeInput());
    const today = new Date().toISOString().split("T")[0];
    expect(result.updatedFrontmatter.last_accessed).toBe(today);
  });

  it("increments access_count", () => {
    const result = computePromotion(
      makeInput({
        frontmatter: {
          description: "test",
          type: "insight",
          project: [],
          status: "inbox",
          created: "2026-02-20",
          last_accessed: "2026-02-20",
          access_count: 5,
        },
      })
    );
    expect(result.updatedFrontmatter.access_count).toBe(6);
  });

  it("preserves existing frontmatter fields", () => {
    const result = computePromotion(
      makeInput({
        frontmatter: {
          description: "keep this",
          type: "insight",
          project: ["ori"],
          status: "inbox",
          created: "2026-02-20",
          last_accessed: "2026-02-20",
          access_count: 0,
          custom_field: "preserved",
        },
      })
    );
    expect(result.updatedFrontmatter.custom_field).toBe("preserved");
    expect(result.updatedFrontmatter.description).toBe("keep this");
  });

  it("assigns at least one area (zero orphans)", () => {
    const result = computePromotion(makeInput());
    expect(result.suggestedAreas.length).toBeGreaterThan(0);
  });

  it("routes project to map via mapRouting config", () => {
    const result = computePromotion(
      makeInput({
        frontmatter: {
          description: "test",
          type: "insight",
          project: ["ori"],
          status: "inbox",
          created: "2026-02-20",
          last_accessed: "2026-02-20",
          access_count: 0,
        },
        mapRouting: { ori: "ai agents map" },
      })
    );
    expect(result.suggestedAreas).toContain("ai agents map");
  });

  it("falls back to defaultArea when no project match", () => {
    const result = computePromotion(
      makeInput({ defaultArea: "builder map" })
    );
    expect(result.suggestedAreas).toContain("builder map");
  });

  it("warns on low-confidence classification", () => {
    const result = computePromotion(
      makeInput({
        inboxPath: "inbox/vague-note.md",
        frontmatter: {
          description: "something",
          project: [],
          status: "inbox",
          created: "2026-02-20",
          last_accessed: "2026-02-20",
          access_count: 0,
        },
        body: "Just some random text here.",
      })
    );
    expect(result.warnings.some((w) => w.includes("Low-confidence"))).toBe(
      true
    );
  });

  it("warns on missing description", () => {
    const result = computePromotion(
      makeInput({
        frontmatter: {
          description: "",
          type: "insight",
          project: [],
          status: "inbox",
          created: "2026-02-20",
          last_accessed: "2026-02-20",
          access_count: 0,
        },
      })
    );
    expect(result.warnings.some((w) => w.includes("No description"))).toBe(
      true
    );
  });

  it("uses description override when provided", () => {
    const result = computePromotion(
      makeInput({
        overrides: { description: "Better description" },
      })
    );
    expect(result.updatedFrontmatter.description).toBe("Better description");
  });

  it("changes array describes all mutations", () => {
    const result = computePromotion(makeInput());
    expect(result.changes.some((c) => c.includes("status"))).toBe(true);
    expect(result.changes.some((c) => c.includes("area"))).toBe(true);
  });

  it("derives destination filename from inbox path", () => {
    const result = computePromotion(
      makeInput({ inboxPath: "inbox/my-great-note.md" })
    );
    expect(result.destinationFilename).toBe("my-great-note.md");
  });
});

describe("injectFooters", () => {
  it("appends areas and links to clean body", () => {
    const result = injectFooters("Body text.", ["index"], ["related"]);
    expect(result).toContain("Areas:");
    expect(result).toContain("[[index]]");
    expect(result).toContain("Relevant Notes:");
    expect(result).toContain("[[related]]");
  });

  it("merges with existing footers without duplicates", () => {
    const body =
      "Body text.\n\nRelevant Notes:\n- [[existing]]\n\nAreas:\n- [[old-map]]";
    const result = injectFooters(body, ["old-map", "new-map"], ["existing", "new-link"]);
    // Should have both old and new, no duplicates
    expect(result.match(/\[\[old-map\]\]/g)?.length).toBe(1);
    expect(result).toContain("[[new-map]]");
    expect(result.match(/\[\[existing\]\]/g)?.length).toBe(1);
    expect(result).toContain("[[new-link]]");
  });

  it("handles body with no existing footers", () => {
    const result = injectFooters("Clean body.", ["my-map"], []);
    expect(result).toContain("Areas:");
    expect(result).toContain("[[my-map]]");
  });

  it("returns clean body when no areas or links", () => {
    const result = injectFooters("Just body.", [], []);
    expect(result.trim()).toBe("Just body.");
  });
});

describe("isTemplatePlaceholder", () => {
  it("returns true for template placeholder with em dash", () => {
    expect(
      isTemplatePlaceholder(
        "{Content — your reasoning, evidence, context. Transform the material, don't just summarize.}"
      )
    ).toBe(true);
  });

  it("returns true for template placeholder with hyphen", () => {
    expect(
      isTemplatePlaceholder(
        "{Content - your reasoning, evidence, context.}"
      )
    ).toBe(true);
  });

  it("returns false for real content", () => {
    expect(
      isTemplatePlaceholder(
        "Agent memory systems need persistent state across sessions."
      )
    ).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isTemplatePlaceholder("")).toBe(false);
  });
});
