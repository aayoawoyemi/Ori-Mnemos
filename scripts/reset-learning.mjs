#!/usr/bin/env node
/**
 * Reset learning state contaminated by the 2026-08-28 postmortem defects.
 *
 * Three independent contaminations, each requiring a different remedy:
 *
 *   1. note_q / q_history — 93.4% of rows were a per-query rank proxy
 *      (0.05/log2(rank+2)). Q converged to the proxy mean and anti-correlated
 *      with usage. Genuine rows are preserved to q_history_genuine; the live
 *      tables are cleared so learning restarts from DEFAULT_Q with real
 *      signals only. Not separable in place: replaying with genuine rewards
 *      alone gives 0/50 top-50 overlap with what shipped.
 *
 *   2. stage_q — LinUCB matrices trained on a reward that was pinned at
 *      exactly -1.0 for any stage measured across scales. Those matrices
 *      encode "every stage is terrible" and would keep suppressing stages
 *      after the measurement fix. Deleted; stages relearn from identity.
 *
 *   3. Mixed note keys — retrieval_log and note_q held both slugs and raw
 *      titles for the same notes. Rows are folded onto the canonical slug so
 *      historical retrieval data stays usable for propensity analysis.
 *
 * Idempotent: safe to re-run. Refuses to run twice destructively by checking
 * for the marker row in `meta`.
 *
 * Usage:  node scripts/reset-learning.mjs [--vault <path>] [--dry-run]
 */

import Database from "better-sqlite3";
import { existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const MARKER_KEY = "learning_reset_2026_08_28";

/** Mirrors src/core/slug.ts. Duplicated deliberately: a migration must not
 *  drift when the source helper changes, or it would rewrite old rows under
 *  new rules on a re-run. */
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Proxy rewards are exactly 0.05/log2(rank+2) for ranks 0..8. */
const PROXY_VALUES = new Set(
  Array.from({ length: 9 }, (_, r) => (0.05 / Math.log2(r + 2)).toFixed(3)),
);

function parseArgs(argv) {
  const args = { dryRun: false, vault: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--vault") args.vault = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const vault = args.vault ?? path.join(os.homedir(), "brain");
  const dbPath = path.join(vault, ".ori", "embeddings.db");

  if (!existsSync(dbPath)) {
    console.error(`No index at ${dbPath}. Nothing to reset.`);
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  const already = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(MARKER_KEY);
  if (already && !args.dryRun) {
    console.log(`Already reset on ${already.value}. Nothing to do.`);
    db.close();
    return;
  }

  const count = (t) => {
    try {
      return db.prepare(`SELECT COUNT(*) n FROM [${t}]`).get().n;
    } catch {
      return 0;
    }
  };

  const before = {
    note_q: count("note_q"),
    q_history: count("q_history"),
    stage_q: count("stage_q"),
    retrieval_log: count("retrieval_log"),
    co_occurrence: count("co_occurrence"),
  };
  console.log("before:", JSON.stringify(before));

  if (args.dryRun) {
    const rows = db.prepare("SELECT reward FROM q_history").all();
    const proxy = rows.filter((r) =>
      PROXY_VALUES.has(r.reward.toFixed(3)),
    ).length;
    console.log(
      `dry-run: ${proxy}/${rows.length} history rows match the proxy formula ` +
        `(${((100 * proxy) / (rows.length || 1)).toFixed(1)}%)`,
    );
    db.close();
    return;
  }

  // Back up before any destructive step. A .bak alongside the db is enough:
  // the file is self-contained and the operator can diff the two.
  const backup = `${dbPath}.bak-learning-reset-${Date.now()}`;
  copyFileSync(dbPath, backup);
  console.log(`backup: ${backup}`);

  const tx = db.transaction(() => {
    // --- 1. Preserve genuine rewards, clear contaminated Q state ----------
    db.exec(`
      CREATE TABLE IF NOT EXISTS q_history_genuine (
        id INTEGER, note_id TEXT, old_q REAL, new_q REAL,
        reward REAL, reward_source TEXT, session_id TEXT, timestamp TEXT
      )
    `);
    const hist = db
      .prepare(
        "SELECT id, note_id, old_q, new_q, reward, reward_source, session_id, timestamp FROM q_history",
      )
      .all();
    const insertGenuine = db.prepare(
      "INSERT INTO q_history_genuine VALUES (?,?,?,?,?,?,?,?)",
    );
    let kept = 0;
    for (const r of hist) {
      if (!PROXY_VALUES.has(r.reward.toFixed(3))) {
        insertGenuine.run(
          r.id,
          slugify(r.note_id),
          r.old_q,
          r.new_q,
          r.reward,
          r.reward_source,
          r.session_id,
          r.timestamp,
        );
        kept++;
      }
    }
    console.log(`preserved ${kept} genuine reward rows of ${hist.length}`);

    // exposure_count goes with it: it fed the exposure^beta divisor, so
    // carrying it forward would keep penalizing the same notes under the
    // corrected signal.
    db.exec("DELETE FROM note_q");
    db.exec("DELETE FROM q_history");

    // --- 2. Drop poisoned LinUCB state ------------------------------------
    db.exec("DELETE FROM stage_q");
    console.log("cleared stage_q — stages relearn from an identity prior");

    // --- 3. Fold mixed keys onto canonical slugs --------------------------
    // retrieval_log is kept (it is observational, not learned) but normalized
    // so future propensity work sees one id per note.
    const ids = db
      .prepare("SELECT DISTINCT note_id FROM retrieval_log")
      .all()
      .map((r) => r.note_id);
    const update = db.prepare(
      "UPDATE retrieval_log SET note_id = ? WHERE note_id = ?",
    );
    let folded = 0;
    for (const id of ids) {
      const slug = slugify(id);
      if (slug !== id) {
        update.run(slug, id);
        folded++;
      }
    }
    console.log(`normalized ${folded} non-canonical ids in retrieval_log`);

    // co_occurrence is deliberately NOT reset: it counts real co-retrieval
    // events, never passed through the reward path, and its learned edges
    // carry far stronger association than the bootstrap ones. Its keys are
    // normalized in place for consistency.
    for (const col of ["note_a", "note_b"]) {
      const rows = db
        .prepare(`SELECT DISTINCT ${col} v FROM co_occurrence`)
        .all()
        .map((r) => r.v);
      const upd = db.prepare(
        `UPDATE OR IGNORE co_occurrence SET ${col} = ? WHERE ${col} = ?`,
      );
      for (const v of rows) {
        const s = slugify(v);
        if (s !== v) upd.run(s, v);
      }
    }

    db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
    ).run(MARKER_KEY, new Date().toISOString());
  });

  tx();

  const after = {
    note_q: count("note_q"),
    q_history: count("q_history"),
    stage_q: count("stage_q"),
    retrieval_log: count("retrieval_log"),
    co_occurrence: count("co_occurrence"),
    q_history_genuine: count("q_history_genuine"),
  };
  console.log("after:", JSON.stringify(after));

  if (after.co_occurrence !== before.co_occurrence) {
    console.error(
      `WARNING: co_occurrence changed ${before.co_occurrence} -> ${after.co_occurrence}. ` +
        `Key folding may have merged duplicate pairs; verify before continuing.`,
    );
  }

  db.close();
  console.log("done — learning restarts from real signals only");
}

main();
