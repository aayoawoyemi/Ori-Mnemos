import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildGraph,
  GraphCache,
  findOrphans,
  findDanglingLinks,
  findBacklinks,
} from "../../src/core/graph.js";

let tmpDir: string;
let notesDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-test-graph-"));
  notesDir = path.join(tmpDir, "notes");
  await fs.mkdir(notesDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeNote(name: string, content: string) {
  await fs.writeFile(path.join(notesDir, `${name}.md`), content, "utf8");
}

describe("buildGraph", () => {
  it("extracts [[wiki-link]] targets into outgoing map", async () => {
    await writeNote("alpha", "Links to [[beta]] and [[gamma]].");
    const graph = await buildGraph(notesDir);
    const links = graph.outgoing.get("alpha");
    expect(links).toBeDefined();
    expect(links!.has("beta")).toBe(true);
    expect(links!.has("gamma")).toBe(true);
  });

  it("populates incoming (reverse) map", async () => {
    await writeNote("alpha", "Links to [[beta]].");
    await writeNote("gamma", "Also links to [[beta]].");
    const graph = await buildGraph(notesDir);
    const incoming = graph.incoming.get("beta");
    expect(incoming).toBeDefined();
    expect(incoming!.has("alpha")).toBe(true);
    expect(incoming!.has("gamma")).toBe(true);
  });

  it("handles notes with no links", async () => {
    await writeNote("lonely", "No links here.");
    const graph = await buildGraph(notesDir);
    expect(graph.outgoing.get("lonely")?.size ?? 0).toBe(0);
  });

  it("returns empty maps for missing directory", async () => {
    const graph = await buildGraph(path.join(tmpDir, "nonexistent"));
    expect(graph.outgoing.size).toBe(0);
    expect(graph.incoming.size).toBe(0);
  });

  it("trims whitespace in link targets", async () => {
    await writeNote("note", "Link to [[ spaced target ]].");
    const graph = await buildGraph(notesDir);
    expect(graph.outgoing.get("note")!.has("spaced-target")).toBe(true);
  });

  it("deduplicates links within the same note", async () => {
    await writeNote("note", "[[alpha]] and [[alpha]] again.");
    const graph = await buildGraph(notesDir);
    expect(graph.outgoing.get("note")!.size).toBe(1);
  });

  it("skips archived notes as graph nodes", async () => {
    await writeNote(
      "archived",
      "---\nstatus: archived\n---\nLinks to [[active]].",
    );
    await writeNote("active", "Plain note.");
    const graph = await buildGraph(notesDir);
    expect(graph.outgoing.has("archived")).toBe(false);
    expect(graph.incoming.get("active")?.has("archived") ?? false).toBe(false);
  });
});

describe("findOrphans", () => {
  it("returns notes with no incoming links", async () => {
    await writeNote("linked", "Content.");
    await writeNote("linker", "See [[linked]].");
    await writeNote("orphan", "Nobody links here.");
    const graph = await buildGraph(notesDir);
    const allNotes = ["linked", "linker", "orphan"];
    const orphans = findOrphans(graph, allNotes);
    expect(orphans).toContain("linker");
    expect(orphans).toContain("orphan");
    expect(orphans).not.toContain("linked");
  });

  it("returns all notes when none are linked", async () => {
    await writeNote("a", "Just text.");
    await writeNote("b", "More text.");
    const graph = await buildGraph(notesDir);
    const orphans = findOrphans(graph, ["a", "b"]);
    expect(orphans.sort()).toEqual(["a", "b"]);
  });
});

describe("findDanglingLinks", () => {
  it("returns targets that do not exist as notes", async () => {
    await writeNote("note", "See [[nonexistent]] and [[also-missing]].");
    const graph = await buildGraph(notesDir);
    const dangling = findDanglingLinks(graph, ["note"]);
    expect(dangling).toContain("nonexistent");
    expect(dangling).toContain("also-missing");
  });

  it("returns empty array when all links resolve", async () => {
    await writeNote("alpha", "See [[beta]].");
    await writeNote("beta", "See [[alpha]].");
    const graph = await buildGraph(notesDir);
    const dangling = findDanglingLinks(graph, ["alpha", "beta"]);
    expect(dangling).toEqual([]);
  });

  it("returns sorted results", async () => {
    await writeNote("note", "See [[zebra]] and [[aardvark]].");
    const graph = await buildGraph(notesDir);
    const dangling = findDanglingLinks(graph, ["note"]);
    expect(dangling).toEqual(["aardvark", "zebra"]);
  });
});

describe("findBacklinks", () => {
  it("returns sorted list of notes linking to target", async () => {
    await writeNote("c", "See [[target]].");
    await writeNote("a", "Also see [[target]].");
    await writeNote("b", "And [[target]] too.");
    await writeNote("target", "I am the target.");
    const graph = await buildGraph(notesDir);
    const backlinks = findBacklinks(graph, "target");
    expect(backlinks).toEqual(["a", "b", "c"]);
  });

  it("returns empty array for note with no backlinks", async () => {
    await writeNote("lonely", "No one links here.");
    const graph = await buildGraph(notesDir);
    expect(findBacklinks(graph, "lonely")).toEqual([]);
  });

  it("returns empty array for nonexistent note", async () => {
    const graph = await buildGraph(notesDir);
    expect(findBacklinks(graph, "nonexistent")).toEqual([]);
  });
});

describe("GraphCache", () => {
  it("builds on first get and returns the same graph instance on second get", async () => {
    await writeNote("alpha", "Links to [[beta]].");
    await writeNote("beta", "No links.");

    const cache = new GraphCache();
    const first = await cache.get(notesDir);
    const second = await cache.get(notesDir);

    expect(second).toBe(first);
    expect(second.outgoing.get("alpha")?.has("beta")).toBe(true);
  });

  it("invalidate forces a rebuild on next get", async () => {
    await writeNote("alpha", "No links.");

    const cache = new GraphCache();
    const first = await cache.get(notesDir);

    await writeNote("beta", "No links.");
    cache.invalidate();

    const rebuilt = await cache.get(notesDir);

    expect(rebuilt).not.toBe(first);
    expect(rebuilt.outgoing.has("beta")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wikilink normalization (#32) and code-fence stripping (#20)
// ---------------------------------------------------------------------------

describe("link target normalization (#32)", () => {
  it("resolves display-title links to filename slugs", async () => {
    await writeNote("note-one", "Links to [[Note Two]].");
    await writeNote("note-two", "Plain note.");
    const graph = await buildGraph(notesDir);
    expect(graph.outgoing.get("note-one")!.has("note-two")).toBe(true);
    expect(graph.incoming.get("note-two")!.has("note-one")).toBe(true);
  });

  it("linked notes are not reported as orphans (repro from #32)", async () => {
    await writeNote("note-one", "Links to [[Note Two]].");
    await writeNote("note-two", "Plain note.");
    const graph = await buildGraph(notesDir);
    const orphans = findOrphans(graph, ["note-one", "note-two"]);
    expect(orphans).not.toContain("note-two");
  });

  it("strips alias from [[Title|display text]] links", async () => {
    await writeNote("src", "See [[Vikunja GTD Workflow Conventions|the conventions]].");
    await writeNote("vikunja-gtd-workflow-conventions", "Conventions.");
    const graph = await buildGraph(notesDir);
    expect(
      graph.incoming.get("vikunja-gtd-workflow-conventions")!.has("src"),
    ).toBe(true);
  });

  it("strips heading refs from [[Title#heading]] links", async () => {
    await writeNote("src", "See [[Note Two#setup]].");
    await writeNote("note-two", "Has headings.");
    const graph = await buildGraph(notesDir);
    expect(graph.incoming.get("note-two")!.has("src")).toBe(true);
  });

  it("slug-form links still resolve", async () => {
    await writeNote("src", "See [[note-two]].");
    await writeNote("note-two", "Plain.");
    const graph = await buildGraph(notesDir);
    expect(graph.incoming.get("note-two")!.has("src")).toBe(true);
  });
});

describe("code fence stripping (#20)", () => {
  it("ignores bash [[ ]] test syntax inside backtick fences", async () => {
    await writeNote(
      "git-hook",
      [
        "A note about hooks.",
        "```sh",
        'if [[ "$AUTHOR_NAME" != "Lachlan Pitts" ]] || \\',
        '   [[ "$AUTHOR_EMAIL" != "lachlan.pitts@gmail.com" ]]; then',
        '  echo "ERROR"',
        "fi",
        "```",
        "Links to [[Real Note]].",
      ].join("\n"),
    );
    await writeNote("real-note", "Target.");
    const graph = await buildGraph(notesDir);
    const links = graph.outgoing.get("git-hook")!;
    expect(links.has("real-note")).toBe(true);
    expect(links.size).toBe(1);
    const dangling = findDanglingLinks(graph, ["git-hook", "real-note"]);
    expect(dangling).toEqual([]);
  });

  it("ignores array-of-arrays literals inside typescript fences", async () => {
    await writeNote(
      "duckdb-example",
      [
        "Perspective config:",
        "```ts",
        'sort: [["sys_from", "desc"]],',
        'filter: [["trust_level", ">=", trust_floor]],',
        "```",
      ].join("\n"),
    );
    const graph = await buildGraph(notesDir);
    expect(graph.outgoing.get("duckdb-example")!.size).toBe(0);
  });

  it("supports tilde fences", async () => {
    await writeNote(
      "tilde-note",
      ["~~~", "if [[ -f x ]]; then echo hi; fi", "~~~", "See [[target]]."].join("\n"),
    );
    await writeNote("target", "T.");
    const graph = await buildGraph(notesDir);
    const links = graph.outgoing.get("tilde-note")!;
    expect(links.has("target")).toBe(true);
    expect(links.size).toBe(1);
  });

  it("requires closing fence run length >= opening (CommonMark 4.5)", async () => {
    await writeNote(
      "nested-fence",
      [
        "````",
        "```",
        "inner [[not-a-link]]",
        "```",
        "````",
        "After fence [[real-target]].",
      ].join("\n"),
    );
    await writeNote("real-target", "T.");
    const graph = await buildGraph(notesDir);
    const links = graph.outgoing.get("nested-fence")!;
    expect(links.has("real-target")).toBe(true);
    expect(links.has("not-a-link")).toBe(false);
  });

  it("unterminated fence swallows the rest of the note", async () => {
    await writeNote(
      "unterminated",
      ["```", "code [[not-a-link]] forever"].join("\n"),
    );
    const graph = await buildGraph(notesDir);
    expect(graph.outgoing.get("unterminated")!.size).toBe(0);
  });

  it("still extracts links from inline-code-free prose around fences", async () => {
    await writeNote(
      "mixed",
      ["Before [[alpha]].", "```", "[[skip]]", "```", "After [[beta]]."].join("\n"),
    );
    const graph = await buildGraph(notesDir);
    const links = graph.outgoing.get("mixed")!;
    expect(links.has("alpha")).toBe(true);
    expect(links.has("beta")).toBe(true);
    expect(links.has("skip")).toBe(false);
  });
});
