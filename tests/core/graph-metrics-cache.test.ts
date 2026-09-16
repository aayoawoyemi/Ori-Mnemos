/**
 * The graph metrics cache, and the staleness check that makes it safe.
 *
 * `computeGraphMetrics` runs PageRank, Louvain, betweenness and articulation
 * points. Measured on the real 1,538-note vault 2026-09-15, AFTER the three
 * full-vault file scans had already been moved into SQL: 387.8 ms, which was
 * 54% of the remaining ~718 ms query. It is the only one of the four passes
 * that is computation rather than I/O, so storing the notes did nothing for it.
 *
 * It is a pure function of the link graph plus frontmatter, so it is cacheable.
 * The danger is the cache outliving its inputs, and this file exists mostly to
 * pin the invalidation rather than the speedup.
 *
 * The bug these tests were written against: the query path decided the index
 * was fresh by comparing `indexedNoteCount(db)` to the number of `.md` files.
 * That notices notes being added or removed and is blind to a note being
 * EDITED - the count is identical. So an edit left the postings, the edges and
 * these cached metrics all answering from pre-edit content indefinitely. Caught
 * by appending a line to a note and watching the query stay at the cached
 * timing instead of paying for a recompute: 277 ms where a recompute is 388 ms
 * on its own.
 *
 * "A stale index must never stop a session" was already honoured. "A stale
 * index must never quietly answer a different question" was not.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import {
  initIndexStore,
  syncIndex,
  loadLinkGraph,
  loadNoteIndex,
  graphFingerprint,
  loadCachedGraphMetrics,
  saveCachedGraphMetrics,
} from "../../src/core/indexstore.js";
import { computeGraphMetrics } from "../../src/core/importance.js";
import type { GraphMetrics } from "../../src/core/importance.js";

let vault: string;
let notesDir: string;
let db: InstanceType<typeof Database>;

async function writeNote(name: string, body: string): Promise<void> {
  await fs.writeFile(
    path.join(notesDir, `${name}.md`),
    `---\ndescription: ${name}\ntype: insight\nstatus: active\ncreated: 2024-01-01\n---\n\n${body}\n`,
    "utf8",
  );
}

beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), "ori-gmcache-"));
  notesDir = path.join(vault, "notes");
  await fs.mkdir(notesDir, { recursive: true });
  await fs.mkdir(path.join(vault, ".ori"), { recursive: true });
  await writeNote("hub", "links to [[spoke-a]] and [[spoke-b]] and [[spoke-c]]");
  await writeNote("spoke-a", "back to [[hub]]");
  await writeNote("spoke-b", "back to [[hub]] and across to [[spoke-a]]");
  await writeNote("spoke-c", "isolated except for [[hub]]");
  db = new Database(path.join(vault, ".ori", "embeddings.db"));
  initIndexStore(db);
  await syncIndex(db, notesDir);
});

afterEach(async () => {
  db.close();
  await fs.rm(vault, { recursive: true, force: true });
});

function compute(): GraphMetrics {
  return computeGraphMetrics(loadLinkGraph(db), loadNoteIndex(db));
}

describe("graph metrics cache (fix-list item 15)", () => {
  it("round-trips every field, including the community member lists", () => {
    const fresh = compute();
    const fingerprint = graphFingerprint(db);
    saveCachedGraphMetrics(db, fingerprint, fresh);
    const cached = loadCachedGraphMetrics(db, fingerprint);
    expect(cached).toBeDefined();
    expect([...cached!.pagerank.entries()].sort()).toEqual([...fresh.pagerank.entries()].sort());
    expect([...cached!.communities.entries()].sort()).toEqual([...fresh.communities.entries()].sort());
    expect([...cached!.bridges].sort()).toEqual([...fresh.bridges].sort());
    expect([...cached!.betweenness.entries()].sort()).toEqual([...fresh.betweenness.entries()].sort());
    // communityStats holds a member array per community. This is the field
    // that made JSON the right representation: shredding it into
    // (note, metric, value) rows and reassembling it would be a second
    // derivation of the same structure, free to disagree with the first -
    // which is the shape of issue #32, where a node/edge key mismatch meant
    // no edge resolved at all.
    expect([...cached!.communityStats.keys()].sort()).toEqual([...fresh.communityStats.keys()].sort());
    for (const [id, info] of fresh.communityStats) {
      expect(cached!.communityStats.get(id)?.size).toBe(info.size);
      expect([...(cached!.communityStats.get(id)?.members ?? [])].sort())
        .toEqual([...info.members].sort());
    }
  });

  it("misses when a note is edited in place", async () => {
    const before = graphFingerprint(db);
    saveCachedGraphMetrics(db, before, compute());
    expect(loadCachedGraphMetrics(db, before)).toBeDefined();

    // Same note count, same file count, and deliberately the SAME LINKS -
    // only the prose changes. The first version of this test rewrote the
    // note's wiki-links too, so it passed against a fingerprint built from
    // note and edge counts alone: the edge count moved and the timestamp was
    // never needed. A mutation that dropped MAX(indexed_at) from the
    // fingerprint stayed green. Text-only edits are the common case and the
    // one that has no structural shadow, so that is what this must assert.
    await writeNote("spoke-c", "isolated except for [[hub]] - and now some new prose");
    await syncIndex(db, notesDir);

    const after = graphFingerprint(db);
    expect(after, "an in-place edit must move the fingerprint").not.toBe(before);
    expect(
      loadCachedGraphMetrics(db, after),
      "the pre-edit metrics must not be served for the post-edit graph",
    ).toBeUndefined();
  });

  it("misses when a note is added or removed", async () => {
    const before = graphFingerprint(db);
    saveCachedGraphMetrics(db, before, compute());

    await writeNote("spoke-d", "new arrival pointing at [[hub]]");
    await syncIndex(db, notesDir);
    const added = graphFingerprint(db);
    expect(added).not.toBe(before);
    expect(loadCachedGraphMetrics(db, added)).toBeUndefined();

    saveCachedGraphMetrics(db, added, compute());
    await fs.rm(path.join(notesDir, "spoke-d.md"));
    await syncIndex(db, notesDir);
    const removed = graphFingerprint(db);
    expect(removed).not.toBe(added);
    expect(loadCachedGraphMetrics(db, removed)).toBeUndefined();
  });

  it("hits when nothing has changed, including across a no-op sync", async () => {
    const fingerprint = graphFingerprint(db);
    saveCachedGraphMetrics(db, fingerprint, compute());
    const result = await syncIndex(db, notesDir);
    expect(result.reparsed, "a no-change sync must not reparse").toBe(0);
    expect(graphFingerprint(db)).toBe(fingerprint);
    expect(loadCachedGraphMetrics(db, fingerprint)).toBeDefined();
  });

  it("serves cached metrics that match a fresh computation", () => {
    const fingerprint = graphFingerprint(db);
    const fresh = compute();
    saveCachedGraphMetrics(db, fingerprint, fresh);
    const cached = loadCachedGraphMetrics(db, fingerprint)!;
    // The cache must not change what the pipeline ranks on. PageRank values
    // are floats through JSON, so compare numerically rather than by string.
    for (const [slug, value] of fresh.pagerank) {
      expect(cached.pagerank.get(slug)).toBeCloseTo(value, 12);
    }
    const freshOrder = [...fresh.pagerank.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
    const cachedOrder = [...cached.pagerank.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
    expect(cachedOrder).toEqual(freshOrder);
  });

  it("recomputes instead of failing on a corrupt cache", () => {
    const fingerprint = graphFingerprint(db);
    db.prepare(
      "INSERT INTO index_meta (key, value) VALUES ('graph_metrics', 'not json') " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run();
    // Derived data. Garbage in the cache is a reason to recompute, never a
    // reason to fail a query.
    expect(() => loadCachedGraphMetrics(db, fingerprint)).not.toThrow();
    expect(loadCachedGraphMetrics(db, fingerprint)).toBeUndefined();
  });
});
