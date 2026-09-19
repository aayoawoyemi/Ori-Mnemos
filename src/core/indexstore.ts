/**
 * Persistent derived index: note metadata, resolved link edges, graph metrics,
 * and access counters.
 *
 * WHY THIS EXISTS - measured 2026-09-15, see docs/fix-list-2026-09-15.md.
 * Every ranked query made ~4 complete passes over every byte of the vault:
 * buildGraph read every note to regex wiki-links, buildNoteIndex read them all
 * again and YAML-parsed every frontmatter, computeAllVitality read them a third
 * time for exactly two fields, and buildBM25IndexFromVault read them a fourth
 * time and rebuilt the whole inverted index before throwing it away.
 *
 *   notes   scans+build   graph metrics   actual BM25 search
 *     161       417 ms           60 ms                  1 ms
 *   2,000     4,457 ms        2,321 ms                  2 ms
 *   8,000    16,187 ms              -                   5 ms
 *
 * The work was ~99.9% preparation. A persistent index answers the same
 * questions in 3.6-9.0 ms including process start and file open, and a full
 * rebuild at 2,000 notes costs 620 ms - so the index stays derived and
 * disposable, which is the standing design principle (docs/wake-nap-design.md:
 * "rebuildable from scratch - a cache, OptMem-style: derived, never precious").
 *
 * This is also what issue #34 reported from the field on a ~1,900-note vault:
 * the 400 ms serve-mode budget was blown on every MCP query, so pagerank,
 * warmth and cooccurrence were silently skipped while the CLI kept them.
 *
 * WHAT THIS IS NOT. Markdown remains the source of truth. Nothing here is
 * authored; every row is derived from a file and can be rebuilt from it. There
 * is no new dependency: better-sqlite3 already ships and already holds
 * embeddings, boosts, note_q, co_occurrence and the stage learner's tables.
 */
import path from "node:path";
import { initQValueTables } from "./qvalue.js";
import { initStageTables } from "./stage-learner.js";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { NoteIndex, GraphMetrics, CommunityInfo } from "./importance.js";
import type { LinkGraph } from "./graph.js";
import { resolveLinkTarget, stripCodeFences } from "./graph.js";
import { parseFrontmatter, readFrontmatterFile, writeFrontmatterFile } from "./frontmatter.js";
import { slugify } from "./slug.js";
import { tokenize } from "./bm25.js";

type DB = InstanceType<typeof Database>;


export function initIndexStore(db: DB): void {
  // busy_timeout: the MCP server holds one long-lived handle while each CLI
  // invocation opens its own. SQLite serialises writers, but with no timeout a
  // collision is a hard SQLITE_BUSY instead of a short wait - and a stale index
  // must never stop a session.
  db.pragma("busy_timeout = 5000");
  // foreign_keys is per-connection and OFF by default in SQLite. Issue #1 was
  // exactly this: archiving a note left embeddings/boosts rows behind, so
  // archived notes kept propagating activation. ON DELETE CASCADE below makes
  // that unrepresentable rather than something a caller must remember.
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS note (
      id            INTEGER PRIMARY KEY,
      slug          TEXT UNIQUE NOT NULL,
      title         TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      type          TEXT NOT NULL DEFAULT '',
      status        TEXT NOT NULL DEFAULT '',
      created       TEXT NOT NULL DEFAULT '',
      content_hash  TEXT NOT NULL,
      mtime_ms      INTEGER NOT NULL,
      size_bytes    INTEGER NOT NULL DEFAULT 0,
      -- The DURABLE access baseline as authored in frontmatter, not the live
      -- counter (that is note_access). Kept as a column so the vitality model
      -- does not read 0 for a note with real history: the real vault has
      -- access_count up to 46, and losing it would silently rewrite what
      -- ACT-R decay is computed from.
      fm_access_count INTEGER NOT NULL DEFAULT 0,
      -- Did the file carry a frontmatter block at all?
      --
      -- buildNoteIndex emits a map entry only when data is present, so a note
      -- with no frontmatter is ABSENT from the scan-built index while still a
      -- row here. Without this column the two indexes disagree on their key
      -- set - found by measuring, not by the unit test, which compared only
      -- notes that had frontmatter. Divergence between two derivations of one
      -- structure is issue #32's exact shape, so it is recorded rather than
      -- approximated.
      has_frontmatter INTEGER NOT NULL DEFAULT 1,
      indexed_at    TEXT NOT NULL,
      -- Weighted-length inputs for BM25, per field. See bm25.ts
      -- buildBM25IndexFromStore.
      tok_title INTEGER NOT NULL DEFAULT 0,
      tok_desc  INTEGER NOT NULL DEFAULT 0,
      tok_body  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS note_project (
      note_id INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
      project TEXT NOT NULL,
      PRIMARY KEY (note_id, project)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS edge (
      src INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
      dst INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
      PRIMARY KEY (src, dst)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_edge_dst ON edge(dst);
    -- A dangling link is evidence, not an error to discard: 306 of 975 distinct
    -- wiki-link targets in the real vault do not exist. Keeping them makes
    -- vault hygiene measurable instead of invisible.
    CREATE TABLE IF NOT EXISTS dangling_link (
      src    INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
      target TEXT NOT NULL,
      PRIMARY KEY (src, target)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS graph_metric (
      note_id INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
      metric  TEXT NOT NULL,
      value   REAL NOT NULL,
      PRIMARY KEY (note_id, metric)
    ) WITHOUT ROWID;
    -- Access counters live here, NOT in frontmatter, on the fast path.
    -- recordNoteAccess used to read-modify-write ~11 note FILES per query with
    -- no lock and no atomic rename: overlapping CLI and MCP queries dropped
    -- increments, a crash mid-write truncated a note, and yaml.stringify
    -- silently normalised hand-authored frontmatter on every read.
    -- Issue #17's durability argument still holds - frontmatter survives a
    -- deleted database - so flushAccessToFrontmatter() writes these back on a
    -- maintenance pass, keeping the durable copy and the git-visible audit
    -- trail while taking the unlocked writes off the read path.
    CREATE TABLE IF NOT EXISTS note_access (
      slug          TEXT PRIMARY KEY,
      access_count  INTEGER NOT NULL DEFAULT 0,
      last_accessed TEXT NOT NULL DEFAULT '',
      flushed_count INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
    -- Document frequency per term: how many notes contain it.
    --
    -- Corpus statistics, NOT ranking. It exists so the stage-quality metric can
    -- see exact-identifier recall (fix-list item 6): a query term with df >= 1
    -- is present in the vault, so a result set that misses it has failed in a
    -- way the old concentration-only metric could not express. That blindness
    -- is why bm25 scored -21.38 reward while being marked essential.
    --
    -- Tokenized with bm25.ts's own tokenize(), deliberately: a metric judging
    -- BM25 with a different vocabulary would measure tokenizer mismatch.
    -- Deliberately not FTS5 - FTS5 is gated on item 6, so sourcing item 6 from
    -- FTS5 would be circular.
    CREATE TABLE IF NOT EXISTS note_term (
      note_id  INTEGER NOT NULL REFERENCES note(id) ON DELETE CASCADE,
      term     TEXT NOT NULL,
      -- Per-FIELD counts, not one pre-weighted number. BM25 weights title and
      -- description by the title_boost/description_boost config values, so a
      -- stored weighted count would silently become wrong the moment a user
      -- edited config - an index that answers a question nobody asked. These
      -- three are facts about the note; the weighting is applied at query time.
      tf_title INTEGER NOT NULL DEFAULT 0,
      tf_desc  INTEGER NOT NULL DEFAULT 0,
      tf_body  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (note_id, term)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_note_term_term ON note_term(term);
    CREATE TABLE IF NOT EXISTS index_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // v_note joins note_q, and v_retrieval/v_session/v_stage read retrieval_log
  // and stage_log. Those are created lazily by the learning layer on first
  // query, so on a fresh vault the views parse but every SELECT fails with
  // "no such table". Verified, not assumed: SQLite accepts CREATE VIEW over a
  // missing table and only resolves names at query time, which turns a setup
  // ordering bug into a runtime error on someone else's machine.
  //
  // Calling the real initialisers rather than restating their DDL here -- a
  // second copy of a schema that must agree with the first is the failure
  // mode the graph_metrics JSON cache was designed to avoid. One DB file,
  // one lifecycle, one definition per table.
  initQValueTables(db);
  initStageTables(db);

  // Views are the public contract for `ori sql` / memory_sql. Agents write
  // queries against these names, which makes them API: once someone's prompt
  // says "SELECT ... FROM v_note", renaming a physical column breaks them.
  // Keeping the physical tables behind views is what lets the schema keep
  // moving. They are derived and disposable like everything else in .ori/,
  // so DROP-then-CREATE keeps a stale definition from surviving an upgrade -
  // CREATE VIEW IF NOT EXISTS would silently keep the old body forever.
  db.exec(`
    DROP VIEW IF EXISTS v_note;
    CREATE VIEW v_note AS
      SELECT n.id, n.slug, n.title, n.type, n.status, n.description, n.created,
             datetime(n.mtime_ms/1000,'unixepoch') AS modified,
             COALESCE(a.access_count, n.fm_access_count) AS access_count,
             a.last_accessed,
             (SELECT COUNT(*) FROM edge e WHERE e.dst = n.id) AS inbound,
             (SELECT COUNT(*) FROM edge e WHERE e.src = n.id) AS outbound,
             (SELECT value FROM graph_metric g
                WHERE g.note_id = n.id AND g.metric = 'pagerank') AS pagerank,
             (SELECT value FROM graph_metric g
                WHERE g.note_id = n.id AND g.metric = 'betweenness') AS betweenness,
             q.q_value, q.update_count AS q_updates, q.exposure_count
      FROM note n
      LEFT JOIN note_access a ON a.slug = n.slug
      LEFT JOIN note_q q ON q.note_id = n.slug;

    DROP VIEW IF EXISTS v_link;
    CREATE VIEW v_link AS
      SELECT s.slug AS src, s.title AS src_title, d.slug AS dst, d.title AS dst_title
      FROM edge e JOIN note s ON s.id = e.src JOIN note d ON d.id = e.dst;

    DROP VIEW IF EXISTS v_dangling;
    CREATE VIEW v_dangling AS
      SELECT dl.target, COUNT(*) AS citing_notes,
             group_concat(n.title, ' | ') AS cited_by
      FROM dangling_link dl JOIN note n ON n.id = dl.src
      GROUP BY dl.target;

    DROP VIEW IF EXISTS v_retrieval;
    CREATE VIEW v_retrieval AS
      SELECT r.session_id, r.timestamp, r.query_text, r.query_type,
             r.note_id AS slug, n.title, r.rank, r.final_score, r.q_score, r.ucb_bonus,
             CASE WHEN r.session_id LIKE 'cli-%' THEN 'cli' ELSE 'mcp' END AS transport
      FROM retrieval_log r LEFT JOIN note n ON n.slug = r.note_id;

    DROP VIEW IF EXISTS v_session;
    CREATE VIEW v_session AS
      SELECT session_id, MIN(timestamp) AS started, MAX(timestamp) AS ended,
             -- A query EVENT, not a distinct string. Two identical searches
             -- three seconds apart are two queries; counting DISTINCT
             -- query_text reported one. retrieval_log holds one row per
             -- (session, query, note), so an event is identified by the text
             -- and the instant it ran.
             COUNT(DISTINCT query_text || char(31) || timestamp) AS queries,
             COUNT(DISTINCT query_text) AS distinct_queries,
             COUNT(*) AS retrievals
      FROM retrieval_log GROUP BY session_id;

    DROP VIEW IF EXISTS v_stage;
    CREATE VIEW v_stage AS
      SELECT session_id, timestamp, stage_id, decision,
             quality_before, quality_after, compute_time_ms, reward
      FROM stage_log;
  `);

  // Forward migrations for indexes created before these columns existed.
  // `CREATE TABLE IF NOT EXISTS` above is a no-op on an existing table, so a
  // column added later never appears without this - the same ALTER-in-try
  // shape engine.ts already uses for the boosts table. The index is derived
  // and could simply be rebuilt, but a silent "no such column" on someone's
  // existing vault is a worse first experience than a cheap ALTER.
  for (const column of [
    "fm_access_count INTEGER NOT NULL DEFAULT 0",
    "has_frontmatter INTEGER NOT NULL DEFAULT 1",
  ]) {
    try {
      db.exec(`ALTER TABLE note ADD COLUMN ${column}`);
    } catch { /* column already exists */ }
  }

  // `note_term` gained per-field counts when BM25 started reading its postings
  // instead of re-reading the vault. An ALTER alone is NOT enough here: the
  // existing rows would sit at the DEFAULT 0, and `syncIndex` is stat-filtered,
  // so an unchanged note is never reparsed and its counts would stay zero
  // forever - a BM25 index that returns nothing and blames the query. When the
  // shape changes, drop the derived rows so the next sync repopulates them.
  // This is the disposability the design promises being cashed in.
  let termShapeChanged = false;
  for (const column of [
    "tf_title INTEGER NOT NULL DEFAULT 0",
    "tf_desc INTEGER NOT NULL DEFAULT 0",
    "tf_body INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      db.exec(`ALTER TABLE note_term ADD COLUMN ${column}`);
      termShapeChanged = true;
    } catch { /* column already exists */ }
  }
  // Per-note token totals per field, so BM25's corpus statistics are a
  // 1,538-row scan of `note` instead of a 317,824-row scan of `note_term`.
  // Same reason these are three columns and not one: the weighting is config,
  // the counts are facts.
  for (const column of [
    "tok_title INTEGER NOT NULL DEFAULT 0",
    "tok_desc INTEGER NOT NULL DEFAULT 0",
    "tok_body INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      db.exec(`ALTER TABLE note ADD COLUMN ${column}`);
      termShapeChanged = true;
    } catch { /* column already exists */ }
  }
  if (termShapeChanged) {
    // Clearing `note` cascades to note_term/edge/dangling_link/graph_metric
    // and resets the stat filter, so the next sync is a full, correct rebuild.
    db.exec("DELETE FROM note");
  }
}

/**
 * The one place a SQLite result shape is asserted.
 *
 * `better-sqlite3` types `.all()` as `unknown[]`, so every read needs an
 * assertion somewhere. Funnelling them through a single named seam means the
 * SELECT column list and the asserted shape sit on adjacent lines at every
 * call site, instead of an inline cast per query that a reader cannot check
 * against its own SQL. Twelve call sites, all in lockstep.
 */
type IdRow = { id: number; slug: string };

function rows<T>(db: DB, sql: string): T[] {
  const result = db.prepare(sql).all();
  return result as T[];
}

/** Frontmatter is user-authored YAML, so every field is `unknown` until
 *  checked. These two name the coercion rather than repeating it at 10 call
 *  sites, where a silent `undefined` would become an empty column. */
function str(data: Record<string, unknown> | null, key: string): string {
  const value = data?.[key];
  return typeof value === "string" ? value : "";
}

function projectsOf(data: Record<string, unknown> | null): string[] {
  const value = data?.project;
  if (Array.isArray(value)) {
    return value.filter((p): p is string => typeof p === "string" && p.length > 0);
  }
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

export interface SyncResult {
  scanned: number;
  reparsed: number;
  removed: number;
  edges: number;
  dangling: number;
}

/**
 * Bring the index in line with the vault. Incremental by (mtime, size) with a
 * content hash as the authority.
 *
 * mtime+size is a PRE-FILTER, not the decision: it avoids reading a file whose
 * stat is unchanged, and any file that passes the filter is read and hashed, so
 * a same-size same-mtime edit still reindexes if the bytes differ. The existing
 * embeddings path already hashes content for exactly this reason
 * (engine.ts: content_hash), but it reads every note every time; this skips the
 * read when stat says nothing moved.
 */
export async function syncIndex(db: DB, notesDir: string): Promise<SyncResult> {
  initIndexStore(db);

  let entries: string[];
  try {
    entries = (await fs.readdir(notesDir)).filter((f) => f.endsWith(".md"));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { scanned: 0, reparsed: 0, removed: 0, edges: 0, dangling: 0 };
    }
    throw err;
  }

  const known = new Map<string, { id: number; hash: string; mtime: number; size: number }>();
  type KnownRow = { id: number; slug: string; content_hash: string; mtime_ms: number; size_bytes: number };
  for (const row of rows<KnownRow>(db, "SELECT id, slug, content_hash, mtime_ms, size_bytes FROM note")) {
    known.set(row.slug, { id: row.id, hash: row.content_hash, mtime: row.mtime_ms, size: row.size_bytes });
  }

  // Titles are file basenames, which is what graph.ts uses as its node id.
  const titles = new Set(entries.map((f) => f.replace(/\.md$/, "")));
  const titleBySlug = new Map<string, string>();
  for (const t of titles) {
    const s = slugify(t);
    if (!titleBySlug.has(s)) titleBySlug.set(s, t);
  }

  type Parsed = {
    title: string;
    hash: string;
    mtime: number;
    size: number;
    data: Record<string, unknown> | null;
    links: string[];
    terms: string[];
    tf: Map<string, [number, number, number]>;
    tok: [number, number, number];
  };
  const parsed: Parsed[] = [];
  const unchanged: string[] = [];

  for (const file of entries) {
    const title = file.replace(/\.md$/, "");
    const full = path.join(notesDir, file);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    const prev = known.get(title);
    if (prev && prev.mtime === stat.mtimeMs && prev.size === stat.size) {
      unchanged.push(title);
      continue;
    }
    let content: string;
    try {
      content = await fs.readFile(full, "utf8");
    } catch {
      continue;
    }
    const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    if (prev && prev.hash === hash) {
      // Bytes identical, stat moved (touch, checkout). Refresh stat only.
      db.prepare("UPDATE note SET mtime_ms = ?, size_bytes = ? WHERE id = ?")
        .run(stat.mtimeMs, stat.size, prev.id);
      unchanged.push(title);
      continue;
    }
    const { data, body } = parseFrontmatter(content);
    const links: string[] = [];
    for (const match of stripCodeFences(content).matchAll(/\[\[([^\]]+)\]\]/g)) {
      const target = resolveLinkTarget(match[1] ?? "", titles, titleBySlug);
      if (target.length > 0) links.push(target);
    }
    const distinct = new Set(tokenize(`${title} ${str(data, "description")} ${content}`));
    // Field-separated counts for BM25. `buildBM25Index` tokenizes title,
    // description and BODY (frontmatter stripped) separately, so this must too
    // - tokenizing the raw file would fold YAML keys into the body bag and the
    // store-backed index would disagree with the vault-backed one.
    const tf = new Map<string, [number, number, number]>();
    const bump = (term: string, field: 0 | 1 | 2): void => {
      let slot = tf.get(term);
      if (!slot) { slot = [0, 0, 0]; tf.set(term, slot); }
      slot[field] += 1;
    };
    const tok: [number, number, number] = [0, 0, 0];
    for (const t of tokenize(title)) { bump(t, 0); tok[0] += 1; }
    for (const t of tokenize(str(data, "description"))) { bump(t, 1); tok[1] += 1; }
    for (const t of tokenize(body)) { bump(t, 2); tok[2] += 1; }
    parsed.push({
      title, hash, mtime: stat.mtimeMs, size: stat.size, data, links,
      terms: [...distinct], tf, tok,
    });
  }

  const gone = [...known.keys()].filter((slug) => !titles.has(slug));
  const now = new Date().toISOString();

  const apply = db.transaction(() => {
    for (const slug of gone) {
      // CASCADE removes note_project, edge, dangling_link and graph_metric.
      db.prepare("DELETE FROM note WHERE slug = ?").run(slug);
    }

    const upsert = db.prepare(`
      INSERT INTO note (slug, title, description, type, status, created,
                        content_hash, mtime_ms, size_bytes, fm_access_count,
                        has_frontmatter, indexed_at,
                        tok_title, tok_desc, tok_body)
      VALUES (@slug, @title, @description, @type, @status, @created,
              @hash, @mtime, @size, @fmAccess, @hasFm, @now,
              @tokTitle, @tokDesc, @tokBody)
      ON CONFLICT(slug) DO UPDATE SET
        title = @title, description = @description, type = @type,
        status = @status, created = @created, content_hash = @hash,
        mtime_ms = @mtime, size_bytes = @size, fm_access_count = @fmAccess,
        has_frontmatter = @hasFm, indexed_at = @now,
        tok_title = @tokTitle, tok_desc = @tokDesc, tok_body = @tokBody
    `);
    for (const p of parsed) {
      upsert.run({
        slug: p.title, title: p.title, description: str(p.data, "description"),
        type: str(p.data, "type"), status: str(p.data, "status"),
        created: str(p.data, "created"), hash: p.hash, mtime: p.mtime,
        size: p.size, now,
        fmAccess: typeof p.data?.access_count === "number" ? p.data.access_count : 0,
        hasFm: p.data ? 1 : 0,
        tokTitle: p.tok[0], tokDesc: p.tok[1], tokBody: p.tok[2],
      });
    }

    const idOf = new Map<string, number>();
    for (const row of rows<IdRow>(db, "SELECT id, slug FROM note")) {
      idOf.set(row.slug, row.id);
    }

    const delProj = db.prepare("DELETE FROM note_project WHERE note_id = ?");
    const insProj = db.prepare("INSERT OR IGNORE INTO note_project (note_id, project) VALUES (?, ?)");
    const delEdge = db.prepare("DELETE FROM edge WHERE src = ?");
    const insEdge = db.prepare("INSERT OR IGNORE INTO edge (src, dst) VALUES (?, ?)");
    const delDang = db.prepare("DELETE FROM dangling_link WHERE src = ?");
    const insDang = db.prepare("INSERT OR IGNORE INTO dangling_link (src, target) VALUES (?, ?)");

    for (const p of parsed) {
      const id = idOf.get(p.title);
      if (id === undefined) continue;
      delProj.run(id);
      for (const project of projectsOf(p.data)) insProj.run(id, project);
      delEdge.run(id);
      delDang.run(id);
      // graph.ts skips archived notes as link SOURCES; mirror that exactly so
      // the SQL graph and the in-memory graph cannot disagree.
      if (str(p.data, "status") === "archived") continue;
      for (const target of p.links) {
        const dst = idOf.get(target);
        if (dst === undefined) insDang.run(id, target);
        else insEdge.run(id, dst);
      }
    }

    // Per-note term sets, so df is a GROUP BY rather than a full recount.
    //
    // First attempt stored df directly and rebuilt it whenever anything
    // changed - which cannot work: a corpus-wide count needs the terms of the
    // notes that did NOT change, and those were never read. Storing the
    // postings makes the incremental case correct by construction and is the
    // same delete-then-insert shape as edges.
    const delTerms = db.prepare("DELETE FROM note_term WHERE note_id = ?");
    const insTerm = db.prepare(
      "INSERT OR IGNORE INTO note_term (note_id, term, tf_title, tf_desc, tf_body) " +
      "VALUES (?, ?, ?, ?, ?)",
    );
    for (const p of parsed) {
      const id = idOf.get(p.title);
      if (id === undefined) continue;
      delTerms.run(id);
      for (const term of p.terms) {
        const [ti, de, bo] = p.tf.get(term) ?? [0, 0, 0];
        insTerm.run(id, term, ti, de, bo);
      }
    }

    db.prepare("INSERT INTO index_meta (key, value) VALUES ('synced_at', ?) " +
               "ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(now);
  });
  apply();

  const [counts] = rows<{ edges: number; dangling: number }>(db, `
    SELECT (SELECT COUNT(*) FROM edge) AS edges,
           (SELECT COUNT(*) FROM dangling_link) AS dangling
  `);
  return {
    scanned: entries.length,
    reparsed: parsed.length,
    removed: gone.length,
    edges: counts?.edges ?? 0,
    dangling: counts?.dangling ?? 0,
  };
}

/** Frontmatter map for ranking, read from SQL instead of N file reads. */
export function loadNoteIndex(db: DB): NoteIndex {
  const frontmatter = new Map<string, Record<string, unknown>>();
  const projects = new Map<string, string[]>();
  for (const row of rows<{ slug: string; project: string }>(
    db, "SELECT n.slug, p.project FROM note n JOIN note_project p ON p.note_id = n.id",
  )) {
    const list = projects.get(row.slug) ?? [];
    list.push(row.project);
    projects.set(row.slug, list);
  }
  type MetaRow = {
    slug: string; description: string; type: string; status: string;
    created: string; fm_access_count: number;
  };
  // has_frontmatter = 0 is excluded to match buildNoteIndex's `if (data)`.
  for (const row of rows<MetaRow>(
    db,
    "SELECT slug, description, type, status, created, fm_access_count FROM note " +
    "WHERE has_frontmatter = 1",
  )) {
    const data: Record<string, unknown> = {};
    if (row.description) data.description = row.description;
    if (row.type) data.type = row.type;
    if (row.status) data.status = row.status;
    if (row.created) data.created = row.created;
    if (row.fm_access_count > 0) data.access_count = row.fm_access_count;
    const p = projects.get(row.slug);
    if (p) data.project = p;
    frontmatter.set(row.slug, data);
  }
  return { frontmatter };
}

/**
 * Link graph from SQL. Shape-identical to buildGraph's return so callers are
 * indifferent to the source. `tests/core/indexstore.test.ts` asserts the two
 * are equal structure-for-structure, because divergence between two ways of
 * deriving the same graph is precisely what issue #32 was.
 *
 * Two behaviours are preserved on purpose, neither of them obviously right:
 *
 * 1. A non-archived note with no outgoing links gets an empty Set entry,
 *    matching buildGraph's unconditional `outgoing.set(title, links)`.
 *    `findOrphans` reads `incoming` absence rather than `outgoing`, so this
 *    must not be "optimised" into omitting empty sets.
 *
 * 2. DANGLING TARGETS ARE STILL GRAPH NODES. `resolveLinkTarget` returns a
 *    slug even when no such file exists, so buildGraph gives `[[nowhere]]` an
 *    `incoming` entry and a place in the graphology graph - which means it
 *    receives PageRank mass. In the real vault 306 of 975 distinct link
 *    targets do not exist, so that is ~306 phantom nodes diluting every
 *    centrality score.
 *
 *    That is very likely a defect, and it is NOT fixed here. This change is a
 *    latency change; silently altering what PageRank ranks while claiming a
 *    speedup would make the two indistinguishable in any later measurement.
 *    The targets are recorded in `dangling_link` so the question is now
 *    measurable - see `hygiene()` - and fixing it belongs with the tier-3
 *    link-graph repair, behind its own before/after comparison.
 */
export function loadLinkGraph(db: DB): LinkGraph {
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  for (const row of rows<{ slug: string; status: string }>(db, "SELECT slug, status FROM note")) {
    if (row.status !== "archived") outgoing.set(row.slug, new Set());
  }
  const link = (src: string, dst: string) => {
    if (!outgoing.has(src)) outgoing.set(src, new Set());
    outgoing.get(src)!.add(dst);
    if (!incoming.has(dst)) incoming.set(dst, new Set());
    incoming.get(dst)!.add(src);
  };
  for (const row of rows<{ src: string; dst: string }>(db, `
    SELECT s.slug AS src, d.slug AS dst
    FROM edge e JOIN note s ON s.id = e.src JOIN note d ON d.id = e.dst
  `)) {
    link(row.src, row.dst);
  }
  for (const row of rows<{ src: string; target: string }>(db, `
    SELECT s.slug AS src, d.target AS target
    FROM dangling_link d JOIN note s ON s.id = d.src
  `)) {
    link(row.src, row.target);
  }
  return { outgoing, incoming };
}

export interface AccessRow { access_count: number; last_accessed: string }

/** Access counters for the vitality model, SQL first with frontmatter as the
 *  durable fallback for notes indexed before counters moved here. */
export function loadAccess(db: DB): Map<string, AccessRow> {
  const out = new Map<string, AccessRow>();
  for (const row of rows<AccessRow & { slug: string }>(
    db, "SELECT slug, access_count, last_accessed FROM note_access",
  )) {
    out.set(row.slug, { access_count: row.access_count, last_accessed: row.last_accessed });
  }
  return out;
}

/**
 * Record a retrieval access. One transaction, no file writes.
 *
 * This replaces ~11 unlocked read-modify-write cycles over the user's note
 * files per query. Two concurrent queries now both count, because SQLite
 * serialises the writers; previously one increment was simply lost.
 */
export function recordAccess(db: DB, slugs: string[], today?: string): void {
  if (slugs.length === 0) return;
  const day = today ?? new Date().toISOString().split("T")[0];
  const stmt = db.prepare(`
    INSERT INTO note_access (slug, access_count, last_accessed)
    VALUES (?, 1, ?)
    ON CONFLICT(slug) DO UPDATE SET
      access_count = access_count + 1,
      last_accessed = excluded.last_accessed
  `);
  db.transaction(() => {
    for (const slug of slugs) stmt.run(slug, day);
  })();
}

/**
 * Write accumulated counters back into frontmatter.
 *
 * Runs on a maintenance pass (ori nap), never on the read path. This is what
 * keeps issue #17's durability property - "frontmatter lives in the markdown
 * files and survives" a deleted database - and keeps the audit trail
 * git-visible, while the fast path stays transactional.
 *
 * `flushed_count` records what has already been persisted, so a flush is
 * idempotent: re-running it does not double-count, and an interrupted flush
 * resumes rather than restarting.
 */
export async function flushAccessToFrontmatter(
  db: DB,
  notesDir: string,
): Promise<{ flushed: number }> {
  type PendingRow = AccessRow & { slug: string; flushed_count: number };
  const pending = rows<PendingRow>(
    db,
    "SELECT slug, access_count, last_accessed, flushed_count FROM note_access " +
    "WHERE access_count > flushed_count",
  );

  const mark = db.prepare("UPDATE note_access SET flushed_count = ? WHERE slug = ?");
  let flushed = 0;
  for (const row of pending) {
    const notePath = path.join(notesDir, `${row.slug}.md`);
    try {
      const { data, body } = await readFrontmatterFile(notePath);
      if (!data) continue;
      const base = typeof data.access_count === "number" ? data.access_count : 0;
      data.access_count = base + (row.access_count - row.flushed_count);
      if (row.last_accessed) data.last_accessed = row.last_accessed;
      await writeFrontmatterFile(notePath, data, body);
      mark.run(row.access_count, row.slug);
      flushed++;
    } catch {
      // Unreadable or deleted note: leave flushed_count alone so the next pass
      // retries. A failed flush must never lose a count.
    }
  }
  return { flushed };
}

/** Cache per-note graph metrics, which cost 2,321 ms to recompute at 2,000
 *  notes (PageRank + Louvain + articulation points + betweenness). */
export function saveGraphMetrics(db: DB, metrics: Map<string, Record<string, number>>): void {
  const idOf = new Map<string, number>();
  for (const row of rows<IdRow>(db, "SELECT id, slug FROM note")) {
    idOf.set(row.slug, row.id);
  }
  const ins = db.prepare(
    "INSERT INTO graph_metric (note_id, metric, value) VALUES (?, ?, ?) " +
    "ON CONFLICT(note_id, metric) DO UPDATE SET value = excluded.value",
  );
  db.transaction(() => {
    db.prepare("DELETE FROM graph_metric").run();
    for (const [slug, byName] of metrics) {
      const id = idOf.get(slug);
      if (id === undefined) continue;
      for (const [metric, value] of Object.entries(byName)) ins.run(id, metric, value);
    }
  })();
}

export function loadGraphMetrics(db: DB): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const row of rows<{ slug: string; metric: string; value: number }>(db, `
    SELECT n.slug, g.metric, g.value FROM graph_metric g JOIN note n ON n.id = g.note_id
  `)) {
    const rec = out.get(row.slug) ?? {};
    rec[row.metric] = row.value;
    out.set(row.slug, rec);
  }
  return out;
}

/**
 * Document frequency per term, hydrated in one query.
 *
 * Supplies the lexical probe in `stage-tracker.measureCurrentQuality`, which
 * could not previously see exact-identifier recall - the blindness that let
 * `bm25` score -21.38 reward while being marked `essential: true`, because the
 * metric had no way to express "the result set missed a literal identifier that
 * exists in the corpus". A real query, "Resume J", scored 0.005.
 *
 * Returned as a closure over an in-memory Map rather than a prepared statement
 * per term: the metric runs on the query path, and this keeps it allocation-
 * free per term after one aggregation.
 */
/**
 * Fingerprint of everything `computeGraphMetrics` reads.
 *
 * PageRank, Louvain, betweenness and bridges are a pure function of the link
 * graph and the frontmatter, so the result can be reused until one of them
 * moves. `indexed_at` is rewritten only when a note is actually reparsed, so
 * MAX(indexed_at) plus the note and edge counts moves on every add, delete and
 * content edit. An edit that leaves the graph identical still invalidates -
 * conservative in the safe direction, and it costs one recompute.
 */
/**
 * Open the derived index for a query, or explain why it is not usable.
 *
 * Every entry point that answers a query needs the same three steps: create the
 * tables, sync, and confirm the result covers the vault. `runQueryRanked` had
 * them inline and `runQueryWarmth`, `runExplore` and the steering path did not
 * have them at all - so warmth and explore still paid the full per-query vault
 * scans after the ranked path had been fixed. That is the same "callsite nobody
 * called" shape as the learning tables: the capability existed and one caller
 * used it.
 *
 * Returns the database to read from, or `undefined` plus a human-readable
 * reason. Never throws: the index is derived, and a missing one must degrade to
 * the vault rather than end a session. It must also never degrade silently,
 * which is what the returned reason is for.
 */
export async function openSyncedIndex(
  db: DB,
  notesDir: string,
  expectedNotes: number,
): Promise<{ index?: DB; reason?: string }> {
  try {
    initIndexStore(db);
    // Unconditional, because a count comparison only sees notes appearing and
    // disappearing. An in-place edit leaves the count identical, and gating on
    // it left postings, edges and cached graph metrics answering from pre-edit
    // content. `syncIndex` is stat-filtered, so no change means one stat per
    // file and no parse.
    await syncIndex(db, notesDir);
    const covered = indexedNoteCount(db);
    if (covered === expectedNotes) return { index: db };
    // The sync could not account for some notes - unreadable files, a path
    // past Windows MAX_PATH, a file removed mid-scan. Say how many, and name
    // the repair that actually reparses everything. Until 2026-09-15 this
    // message pointed at `ori index build`, which rebuilt embeddings only and
    // would not have touched the store that was complaining.
    return {
      reason: `Derived index covers ${covered} of ${expectedNotes} notes; using ` +
              "per-query scans for this request (run `ori index build --force`)",
    };
  } catch (err: unknown) {
    return {
      reason: `Derived index unavailable, using per-query scans: ${
        err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Graph metrics for a query: cached when the graph has not moved, recomputed
 * and stored when it has.
 *
 * Measured on the real 1,538-note vault after the file scans moved into SQL:
 * `computeGraphMetrics` is 387.8 ms, 54% of the remaining query. It is the only
 * one of the four full-vault passes that is computation rather than I/O.
 *
 * `compute` is passed in rather than imported to keep this module free of a
 * dependency on the graph algorithms, which import graphology.
 */
export function cachedGraphMetrics(
  db: DB | undefined,
  compute: () => GraphMetrics,
): { metrics: GraphMetrics; reason?: string } {
  if (!db) return { metrics: compute() };
  try {
    const fingerprint = graphFingerprint(db);
    const hit = loadCachedGraphMetrics(db, fingerprint);
    if (hit) return { metrics: hit };
    const fresh = compute();
    saveCachedGraphMetrics(db, fingerprint, fresh);
    return { metrics: fresh };
  } catch (err: unknown) {
    return {
      metrics: compute(),
      reason: `Graph metrics cache unavailable, recomputing: ${
        err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function graphFingerprint(db: DB): string {
  const [row] = rows<{ notes: number; edges: number; stamp: string | null }>(db, `
    SELECT (SELECT COUNT(*) FROM note)  AS notes,
           (SELECT COUNT(*) FROM edge)  AS edges,
           (SELECT MAX(indexed_at) FROM note) AS stamp
  `);
  return `${row?.notes ?? 0}:${row?.edges ?? 0}:${row?.stamp ?? ""}`;
}

/**
 * Cache for the single most expensive thing on the query path.
 *
 * Measured on the real 1,538-note vault 2026-09-15: `computeGraphMetrics` is
 * 387.8 ms, which is 54% of a query that had already been cut from 3,344 ms to
 * ~718 ms. It is the last of the four full-vault passes and, unlike the other
 * three, the cost is graph algorithms rather than file reads - so moving the
 * reads into SQL did nothing for it.
 *
 * Stored as JSON in `index_meta` rather than as rows in `graph_metric`, because
 * `communityStats` holds a member list per community: shredding it into
 * (note, metric, value) triples and reassembling it would be a second
 * derivation of the same structure that could disagree with the first. That is
 * exactly the shape of issue #32, where a node/edge key mismatch meant no edge
 * ever resolved. One encoder, one decoder, one representation.
 *
 * `saveGraphMetrics`/`loadGraphMetrics` write the numeric projection into
 * `graph_metric` so SQL surfaces can reach pagerank and betweenness, which a
 * JSON blob in `index_meta` cannot expose. This comment previously claimed
 * they existed for a case `ori health` reported; health.ts has never
 * referenced either function, and the table held 0 rows until 2026-09-19.
 */
export function loadCachedGraphMetrics(db: DB, fingerprint: string): GraphMetrics | undefined {
  const [row] = rows<{ value: string }>(
    db, "SELECT value FROM index_meta WHERE key = 'graph_metrics'",
  );
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.value) as {
      fingerprint: string;
      pagerank: Array<[string, number]>;
      communities: Array<[string, number]>;
      bridges: string[];
      betweenness: Array<[string, number]>;
      communityStats: Array<[number, CommunityInfo]>;
    };
    if (parsed.fingerprint !== fingerprint) return undefined;
    return {
      pagerank: new Map(parsed.pagerank),
      communities: new Map(parsed.communities),
      bridges: new Set(parsed.bridges),
      betweenness: new Map(parsed.betweenness),
      communityStats: new Map(parsed.communityStats),
    };
  } catch {
    // Corrupt or older-shaped cache. Derived data: recompute, never fail.
    return undefined;
  }
}

export function saveCachedGraphMetrics(
  db: DB,
  fingerprint: string,
  metrics: GraphMetrics,
): void {
  const payload = JSON.stringify({
    fingerprint,
    pagerank: [...metrics.pagerank],
    communities: [...metrics.communities],
    bridges: [...metrics.bridges],
    betweenness: [...metrics.betweenness],
    communityStats: [...metrics.communityStats],
  });
  db.prepare(
    "INSERT INTO index_meta (key, value) VALUES ('graph_metrics', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(payload);

  // Project the numeric metrics into graph_metric in the same call, from the
  // same object. The table existed with a CREATE, a writer, a reader, two
  // tests and a comment claiming `ori health` consumed it -- and 0 rows in a
  // 1,545-note vault, because nothing ever called the writer. SQL surfaces
  // cannot read the JSON blob, so anything querying pagerank got NULL.
  //
  // This is one derivation with two projections, not the two-derivations
  // hazard the JSON cache was chosen to avoid: communityStats keeps a member
  // list per community and stays JSON-only, while pagerank and betweenness
  // are plain numbers keyed by slug and cannot disagree with themselves.
  saveGraphMetrics(
    db,
    new Map(
      [...metrics.pagerank].map(([slug, pagerank]) => [
        slug,
        { pagerank, betweenness: metrics.betweenness.get(slug) ?? 0 },
      ]),
    ),
  );
}

export function termDocumentFrequency(db: DB): {
  documentFrequency: (term: string) => number;
  notesContainingTerm: (term: string) => ReadonlySet<string>;
  corpusSize: number;
} {
  const df = new Map<string, number>();
  for (const row of rows<{ term: string; df: number }>(
    db, "SELECT term, COUNT(*) AS df FROM note_term GROUP BY term",
  )) {
    df.set(row.term, row.df);
  }
  const [size] = rows<{ c: number }>(db, "SELECT COUNT(*) AS c FROM note");

  // Which notes hold a term, resolved lazily and memoised.
  //
  // The aggregate above is one pass and is needed for every query. This is
  // not: a query has a handful of rare terms, and each is a single indexed
  // lookup on note_term(term). Hydrating all 317,824 postings to answer three
  // questions would cost more than the metric it feeds.
  const holders = new Map<string, ReadonlySet<string>>();
  const stmt = db.prepare(
    "SELECT n.title FROM note_term t JOIN note n ON n.id = t.note_id WHERE t.term = ?",
  );

  return {
    documentFrequency: (term: string) => df.get(term.toLowerCase()) ?? 0,
    corpusSize: size?.c ?? 0,
    notesContainingTerm: (term: string) => {
      const key = term.toLowerCase();
      const hit = holders.get(key);
      if (hit) return hit;
      const titles = new Set(
        (stmt.all(key) as Array<{ title: string }>).map((r) => r.title),
      );
      holders.set(key, titles);
      return titles;
    },
  };
}

/** How many notes the derived index currently covers. Compared against the
 *  vault before any query trusts the index, so a stale or empty index degrades
 *  to the scans loudly instead of returning an empty graph. */
export function indexedNoteCount(db: DB): number {
  const [row] = rows<{ c: number }>(db, "SELECT COUNT(*) AS c FROM note");
  return row?.c ?? 0;
}

/** Vault hygiene, free once edges are stored. Answers the tier-3 questions the
 *  2026-09-12 scan had to walk the filesystem for. */
export function hygiene(db: DB): {
  notes: number; orphans: number; dangling: number; archived: number;
} {
  const counts = rows<{ label: string; c: number }>(db, `
    SELECT 'notes' AS label, COUNT(*) AS c FROM note
    UNION ALL SELECT 'orphans', COUNT(*) FROM note n
      WHERE NOT EXISTS (SELECT 1 FROM edge e WHERE e.dst = n.id)
    UNION ALL SELECT 'dangling', COUNT(*) FROM dangling_link
    UNION ALL SELECT 'archived', COUNT(*) FROM note WHERE status = 'archived'
  `);
  const by: Record<string, number> = {};
  for (const row of counts) by[row.label] = row.c;
  return {
    notes: by.notes ?? 0, orphans: by.orphans ?? 0,
    dangling: by.dangling ?? 0, archived: by.archived ?? 0,
  };
}
