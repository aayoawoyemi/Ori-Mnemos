import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { exportLearned, importLearned, LEARNED_TABLES } from "../../src/core/learned.js";

// The README claimed for months that everything under .ori/ is derived and
// disposable. Measured on a real vault, `rm -rf .ori/ && ori index build`
// empties eight accumulated tables: six months of retrieval history, the
// learned Q-values, and the live LinUCB arms. These tests cover the contract
// that makes the disposability claim true rather than aspirational.

function seed(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE note_q (note_id TEXT PRIMARY KEY, q_value REAL, update_count INTEGER,
      exposure_count INTEGER, reward_sum REAL, reward_sq_sum REAL, last_updated TEXT,
      last_reward REAL, created TEXT);
    CREATE TABLE stage_q (stage_id TEXT PRIMARY KEY, a_matrix TEXT, b_vector TEXT,
      sample_count INTEGER, total_reward REAL, last_updated TEXT);
    CREATE TABLE co_occurrence (note_a TEXT, note_b TEXT, co_retrieval_count INTEGER,
      npmi_weight REAL, trust_weight REAL, first_observed TEXT, last_co_retrieved TEXT,
      source TEXT, PRIMARY KEY (note_a, note_b));
  `);
  db.prepare("INSERT INTO note_q VALUES (?,?,?,?,?,?,?,?,?)").run("alpha", 0.8125, 12, 30, 9.75, 8.1, "2026-09-19", 0.5, "2026-03-24");
  db.prepare("INSERT INTO note_q VALUES (?,?,?,?,?,?,?,?,?)").run("beta", -0.25, 3, 7, -0.75, 0.6, "2026-09-18", -0.25, "2026-04-01");
  db.prepare("INSERT INTO stage_q VALUES (?,?,?,?,?,?)").run("bm25", "[[1,0],[0,1]]", "[0.5,0.25]", 56, -19.84, "2026-09-19");
  const cooc = db.prepare("INSERT INTO co_occurrence VALUES (?,?,?,?,?,?,?,?)");
  cooc.run("alpha", "beta", 4, 0.62, 0.9, "2026-05-01", "2026-09-19", "retrieval");
  cooc.run("alpha", "gamma", 0, 0.15, 0.5, "2026-05-01", "", "bootstrap");
  return db;
}

describe("learned state export/import", () => {
  it("round-trips values exactly, not just row counts", () => {
    const src = seed();
    const { ndjson } = exportLearned(src);
    const before = src.prepare("SELECT * FROM note_q ORDER BY note_id").all();
    src.close();

    const dst = seed();
    dst.exec("DELETE FROM note_q; DELETE FROM stage_q; DELETE FROM co_occurrence;");
    importLearned(dst, ndjson);
    const after = dst.prepare("SELECT * FROM note_q ORDER BY note_id").all();
    dst.close();

    // Floats matter here: a Q-value that survives as 0.81 instead of 0.8125
    // still ranks, just wrongly, and a count-only assertion would pass.
    expect(after).toEqual(before);
  });

  it("excludes bootstrap co-occurrence, which the rebuild regenerates", () => {
    const db = seed();
    const { ndjson, stats } = exportLearned(db);
    db.close();
    expect(stats.exported.co_occurrence).toBe(1); // the 'retrieval' row only
    expect(ndjson).toContain('"source":"retrieval"');
    expect(ndjson).not.toContain('"note_b":"gamma"');
  });

  it("is idempotent — importing twice does not duplicate", () => {
    const src = seed();
    const { ndjson } = exportLearned(src);
    src.close();

    const dst = seed();
    importLearned(dst, ndjson);
    importLearned(dst, ndjson);
    const n = dst.prepare("SELECT count(*) c FROM note_q").get() as { c: number };
    dst.close();
    expect(n.c).toBe(2);
  });

  it("creates the orphan tables no production code creates", () => {
    // q_history_genuine exists only because scripts/reset-learning.mjs made
    // it once; memory_events is created by nothing at all. After a rebuild
    // neither exists, so without DDL here their 902 rows are unrestorable.
    const orphans = LEARNED_TABLES.filter((t) => t.ddl).map((t) => t.name);
    expect(orphans.sort()).toEqual(["memory_events", "q_history_genuine"]);

    const db = seed();
    const ndjson =
      JSON.stringify({ _format: "ori-learned", version: 1 }) + "\n" +
      JSON.stringify({ _t: "q_history_genuine", note_id: "alpha", old_q: 0, new_q: 0.5, reward: 1, reward_source: "genuine", session_id: "s1", timestamp: "2026-08-01" }) + "\n";
    const stats = importLearned(db, ndjson);
    const n = db.prepare("SELECT count(*) c FROM q_history_genuine").get() as { c: number };
    db.close();
    expect(stats.createdTables).toContain("q_history_genuine");
    expect(n.c).toBe(1);
  });

  it("refuses to invent tables that have an owning module", () => {
    // A missing note_q means the caller skipped `ori index build`. Creating
    // it here would fork the schema away from qvalue.ts.
    const db = new Database(":memory:");
    const ndjson =
      JSON.stringify({ _format: "ori-learned", version: 1 }) + "\n" +
      JSON.stringify({ _t: "note_q", note_id: "alpha", q_value: 0.5 }) + "\n";
    const stats = importLearned(db, ndjson);
    db.close();
    expect(stats.skippedUnknownTable).toBe(1);
    expect(stats.createdTables).not.toContain("note_q");
  });

  it("keys every table on a stable text identifier, never a rowid", () => {
    // A rowid-keyed export restores onto the wrong notes after a rebuild
    // reassigns ids, and looks entirely plausible doing it.
    for (const t of LEARNED_TABLES) {
      expect(t.columns, `${t.name} must not carry the autoincrement id`).not.toContain("id");
    }
  });
});
