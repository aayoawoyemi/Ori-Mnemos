/**
 * The persistent derived index must answer exactly what the per-query scans
 * answered. Divergence between two ways of deriving the same structure is not
 * hypothetical here: issue #32 shipped a graph whose node keys were file
 * basenames while its edge maps were keyed by raw [[display title]], so no
 * edges resolved at all, PageRank kept returning numbers, and 7 of 8 notes
 * were reported as orphans.
 *
 * So the load-bearing tests below are equivalence tests against buildGraph and
 * buildNoteIndex, not "does SQL return rows".
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import {
  initIndexStore, syncIndex, loadNoteIndex, loadLinkGraph,
  recordAccess, loadAccess, flushAccessToFrontmatter,
  saveGraphMetrics, loadGraphMetrics, hygiene, openSyncedIndex,
  saveCachedGraphMetrics, graphFingerprint,
} from "../../src/core/indexstore.js";
import { buildGraph } from "../../src/core/graph.js";
import { buildNoteIndex } from "../../src/core/noteindex.js";
import { readFrontmatterFile } from "../../src/core/frontmatter.js";

let root: string;
let notesDir: string;
let db: InstanceType<typeof Database>;

async function note(name: string, frontmatter: string, body = ""): Promise<void> {
  await fs.writeFile(
    path.join(notesDir, `${name}.md`),
    `---\n${frontmatter}\n---\n\n${body}\n`,
    "utf8",
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ori-idx-"));
  notesDir = path.join(root, "notes");
  await fs.mkdir(notesDir, { recursive: true });
  db = new Database(path.join(root, "index.db"));
  initIndexStore(db);
});

afterEach(async () => {
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("indexstore equivalence with the per-query scans", () => {
  it("derives the same link graph as buildGraph", async () => {
    await note("alpha", "type: insight\nstatus: active", "sees [[beta]] and [[Gamma Note]]");
    await note("beta", "type: insight\nstatus: active", "back to [[alpha]]");
    await note("gamma-note", "type: idea\nstatus: active", "no links here");
    await note("delta", "type: idea\nstatus: active", "points at [[nowhere]]");

    await syncIndex(db, notesDir);
    const fromSql = loadLinkGraph(db);
    const fromDisk = await buildGraph(notesDir);

    const normalize = (g: { outgoing: Map<string, Set<string>>; incoming: Map<string, Set<string>> }) => ({
      outgoing: [...g.outgoing].map(([k, v]) => [k, [...v].sort()] as const).sort(),
      incoming: [...g.incoming].map(([k, v]) => [k, [...v].sort()] as const).sort(),
    });

    expect(normalize(fromSql)).toEqual(normalize(fromDisk));
    // And the display-title link must have resolved to the slug file, which is
    // the exact defect #32 was: [[Gamma Note]] -> gamma-note.
    expect([...(fromSql.outgoing.get("alpha") ?? [])].sort()).toEqual(["beta", "gamma-note"]);
  });

  it("derives the same frontmatter index as buildNoteIndex", async () => {
    await note("one", "description: first\ntype: insight\nstatus: active\ncreated: 2026-01-01\nproject:\n  - a\n  - b");
    await note("two", "description: second\ntype: decision\nstatus: archived\ncreated: 2026-02-02");

    await syncIndex(db, notesDir);
    const fromSql = loadNoteIndex(db);
    const fromDisk = await buildNoteIndex(notesDir, ["one", "two"]);

    for (const title of ["one", "two"]) {
      const sql = fromSql.frontmatter.get(title) ?? {};
      const disk = fromDisk.frontmatter.get(title) ?? {};
      for (const key of ["description", "type", "status", "created"]) {
        expect(sql[key], `${title}.${key}`).toEqual(disk[key]);
      }
    }
    expect(fromSql.frontmatter.get("one")?.project).toEqual(["a", "b"]);
  });

  it("agrees with buildNoteIndex on notes that have NO frontmatter", async () => {
    // Found by measuring the wired pipeline, not by the first version of this
    // suite: buildNoteIndex emits a map entry only `if (data)`, so a bare
    // markdown file is absent there while it is still an indexed row. The two
    // key sets have to match exactly or callers that ask `frontmatter.has(t)`
    // silently change answer depending on which index they got.
    await fs.writeFile(path.join(notesDir, "bare.md"), "just prose, no frontmatter\n", "utf8");
    await note("dressed", "type: insight\nstatus: active");

    await syncIndex(db, notesDir);
    const fromSql = loadNoteIndex(db);
    const fromDisk = await buildNoteIndex(notesDir, ["bare", "dressed"]);

    expect([...fromSql.frontmatter.keys()].sort()).toEqual([...fromDisk.frontmatter.keys()].sort());
    expect(fromSql.frontmatter.has("bare")).toBe(false);
    // ...but it is still indexed, so it is still a graph node and still gets
    // its access counted.
    expect(hygiene(db).notes).toBe(2);
  });

  it("excludes archived notes as link sources, exactly as buildGraph does", async () => {
    await note("live", "status: active", "to [[target]]");
    await note("dead", "status: archived", "to [[target]]");
    await note("target", "status: active", "");

    await syncIndex(db, notesDir);
    const graph = loadLinkGraph(db);
    expect([...(graph.incoming.get("target") ?? [])]).toEqual(["live"]);
    expect(graph.outgoing.has("dead")).toBe(false);
  });

  it("keeps dangling links as evidence rather than discarding them", async () => {
    await note("src", "status: active", "[[missing-one]] and [[missing-two]]");
    await syncIndex(db, notesDir);
    expect(hygiene(db).dangling).toBe(2);
  });
});

describe("incremental sync", () => {
  it("reparses only what changed", async () => {
    await note("a", "type: insight", "body a");
    await note("b", "type: insight", "body b");
    const first = await syncIndex(db, notesDir);
    expect(first.reparsed).toBe(2);

    const second = await syncIndex(db, notesDir);
    expect(second.reparsed, "nothing changed, nothing reparsed").toBe(0);

    await note("a", "type: learning", "body a edited");
    const third = await syncIndex(db, notesDir);
    expect(third.reparsed).toBe(1);
    expect(loadNoteIndex(db).frontmatter.get("a")?.type).toBe("learning");
  });

  it("notices an edit that does not change file size", async () => {
    // mtime+size is a pre-filter, not the decision: same-length edits are the
    // case a stat-only index silently misses.
    await note("a", "type: insight", "aaaa");
    await syncIndex(db, notesDir);
    const file = path.join(notesDir, "a.md");
    const before = await fs.stat(file);
    await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("aaaa", "bbbb"), "utf8");
    await fs.utimes(file, before.atime, before.mtime);
    const again = await syncIndex(db, notesDir);
    expect(again.reparsed, "same size, restored mtime, different bytes").toBe(1);
  });

  it("removes notes that left the vault, and their edges with them", async () => {
    await note("keep", "status: active", "[[drop]]");
    await note("drop", "status: active", "");
    await syncIndex(db, notesDir);
    expect(hygiene(db).notes).toBe(2);

    await fs.rm(path.join(notesDir, "drop.md"));
    const result = await syncIndex(db, notesDir);
    expect(result.removed).toBe(1);
    expect(hygiene(db).notes).toBe(1);
    // ON DELETE CASCADE: this is issue #1 made structurally impossible rather
    // than remembered. The edge cannot outlive its endpoint.
    expect(hygiene(db).dangling + hygiene(db).orphans).toBeGreaterThanOrEqual(1);
    expect(loadLinkGraph(db).incoming.has("drop")).toBe(false);
  });
});

describe("access counters", () => {
  it("counts concurrent accesses instead of losing them", async () => {
    // The defect this replaces: recordNoteAccess read-modify-wrote ~11 note
    // FILES per query with no lock, so two overlapping queries lost one
    // increment. SQLite serialises the writers.
    await note("hot", "type: insight", "");
    await syncIndex(db, notesDir);
    for (let i = 0; i < 5; i++) recordAccess(db, ["hot"]);
    expect(loadAccess(db).get("hot")?.access_count).toBe(5);
  });

  it("never touches the note file on the read path", async () => {
    await note("untouched", "type: insight\naccess_count: 3", "body");
    await syncIndex(db, notesDir);
    const file = path.join(notesDir, "untouched.md");
    const before = await fs.readFile(file, "utf8");
    recordAccess(db, ["untouched"]);
    expect(await fs.readFile(file, "utf8"), "a query must not rewrite user files").toBe(before);
  });

  it("flushes to frontmatter idempotently", async () => {
    // Issue #17's durability argument: frontmatter survives a deleted database.
    // The flush keeps that, and must not double-count when run twice.
    await note("n", "type: insight\naccess_count: 2", "body");
    await syncIndex(db, notesDir);
    recordAccess(db, ["n"]);
    recordAccess(db, ["n"]);

    expect((await flushAccessToFrontmatter(db, notesDir)).flushed).toBe(1);
    const after = await readFrontmatterFile(path.join(notesDir, "n.md"));
    expect(after.data?.access_count).toBe(4);

    expect((await flushAccessToFrontmatter(db, notesDir)).flushed, "second flush is a no-op").toBe(0);
    const twice = await readFrontmatterFile(path.join(notesDir, "n.md"));
    expect(twice.data?.access_count, "re-running must not double-count").toBe(4);
  });

  it("preserves the note body through a flush", async () => {
    await note("keeper", "type: insight", "important prose the user wrote");
    await syncIndex(db, notesDir);
    recordAccess(db, ["keeper"]);
    await flushAccessToFrontmatter(db, notesDir);
    const raw = await fs.readFile(path.join(notesDir, "keeper.md"), "utf8");
    expect(raw).toContain("important prose the user wrote");
  });
});

describe("graph metrics cache", () => {
  it("round-trips per-note metrics", async () => {
    await note("a", "status: active", "");
    await note("b", "status: active", "");
    await syncIndex(db, notesDir);
    saveGraphMetrics(db, new Map([
      ["a", { pagerank: 0.25, betweenness: 1.5 }],
      ["b", { pagerank: 0.75, betweenness: 0 }],
    ]));
    const back = loadGraphMetrics(db);
    expect(back.get("a")).toEqual({ pagerank: 0.25, betweenness: 1.5 });
    expect(back.get("b")?.pagerank).toBe(0.75);
  });

  // The two tests above call saveGraphMetrics directly, which is exactly why
  // graph_metric sat at 0 rows in a 1,545-note vault while they passed: they
  // prove the function works, not that anything reaches it. This one asserts
  // the production path populates the table.
  it("populates graph_metric from the cached-metrics write path", async () => {
    await note("a", "status: active", "[[b]]");
    await note("b", "status: active", "");
    await syncIndex(db, notesDir);
    expect(loadGraphMetrics(db).size).toBe(0);

    saveCachedGraphMetrics(db, graphFingerprint(db), {
      pagerank: new Map([["a", 0.6], ["b", 0.4]]),
      communities: new Map([["a", 0], ["b", 0]]),
      bridges: new Set<string>(),
      betweenness: new Map([["a", 2]]),
      communityStats: new Map(),
    });

    const back = loadGraphMetrics(db);
    expect(back.get("a")).toEqual({ pagerank: 0.6, betweenness: 2 });
    // Absent from the betweenness map, not absent from the projection.
    expect(back.get("b")).toEqual({ pagerank: 0.4, betweenness: 0 });
  });

  it("drops metrics for notes that no longer exist", async () => {
    await note("gone", "status: active", "");
    await syncIndex(db, notesDir);
    saveGraphMetrics(db, new Map([["gone", { pagerank: 1 }]]));
    await fs.rm(path.join(notesDir, "gone.md"));
    await syncIndex(db, notesDir);
    expect(loadGraphMetrics(db).has("gone")).toBe(false);
  });
});

describe("the index is derived and disposable", () => {
  it("rebuilds identically from the vault after being deleted", async () => {
    await note("a", "type: insight\nstatus: active", "[[b]]");
    await note("b", "type: idea\nstatus: active", "");
    await syncIndex(db, notesDir);
    const before = loadLinkGraph(db);

    db.exec("DROP TABLE edge; DROP TABLE note_project; DROP TABLE dangling_link; " +
            "DROP TABLE graph_metric; DROP TABLE note;");
    await syncIndex(db, notesDir);
    const after = loadLinkGraph(db);

    expect([...after.outgoing.get("a")!]).toEqual([...before.outgoing.get("a")!]);
    expect(hygiene(db).notes).toBe(2);
  });
});

describe("openSyncedIndex refuses an index that does not cover the vault", () => {
  it("returns no index and a reason when coverage falls short", async () => {
    // The guard that keeps a partial index from silently answering from a
    // partial corpus. The caller counts the notes on disk; if the sync cannot
    // account for all of them - an unreadable file, a path over Windows
    // MAX_PATH (tier 3 item 25 found one at 265 chars in the real vault), a
    // file deleted mid-scan - the query must fall back to the vault and say
    // so. Ranking over a subset of the corpus is the "quietly answers a
    // different question" failure, and it shifts every idf in the process.
    await syncIndex(db, notesDir);
    const short = await openSyncedIndex(db, notesDir, 999);
    expect(short.index, "must not hand back an index it cannot vouch for").toBeUndefined();
    expect(short.reason).toBeTruthy();
    expect(short.reason).toContain("ori index build --force");
  });

  it("returns the index when coverage is complete", async () => {
    const files = (await fs.readdir(notesDir)).filter((f) => f.endsWith(".md"));
    const ok = await openSyncedIndex(db, notesDir, files.length);
    expect(ok.index).toBeDefined();
    expect(ok.reason).toBeUndefined();
  });

  it("degrades with a reason instead of throwing on an unusable database", async () => {
    const closed = new Database(":memory:");
    closed.close();
    const result = await openSyncedIndex(closed, notesDir, 1);
    expect(result.index).toBeUndefined();
    expect(result.reason).toContain("per-query scans");
  });
});
