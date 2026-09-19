// Re-measures the stage bandit now that the reward function can see exact
// recall.
//
// bm25 carried -21.38 total reward over 74 samples while marked essential:true.
// That was read as "the bandit froze the winner and kept pulling the loser".
// The alternative reading is that the bandit was correct and the INSTRUMENT was
// broken: measureExactRecall read `text` off ScoredNote, which has no such
// field, so recall was measured against titles alone and the one thing bm25
// contributes was invisible. Fixed 2026-09-19 (09ac45d).
//
// Replays real queries from retrieval_log and reports the per-stage reward
// delta. Only the NEW samples matter — historical totals were accumulated under
// the old metric and cannot be compared to anything.

import Database from "better-sqlite3";
import { runQueryRanked } from "../dist/cli/search.js";

const VAULT = process.env.ORI_VAULT ?? "C:/Users/aayoa/brain";
const DB = `${VAULT}/.ori/embeddings.db`;
const N = Number(process.argv[2] ?? 300);

const snapshot = () => {
  const db = new Database(DB, { readonly: true });
  const out = {};
  for (const r of db.prepare("SELECT stage_id, sample_count, total_reward FROM stage_q").all()) {
    out[r.stage_id] = { n: r.sample_count, reward: r.total_reward };
  }
  db.close();
  return out;
};

const readQueries = () => {
  const db = new Database(DB, { readonly: true });
  // Weighted by how often they were really asked, so the replay matches the
  // distribution the bandit will actually face.
  const rows = db.prepare(
    "SELECT query_text, COUNT(*) n FROM retrieval_log WHERE query_text IS NOT NULL AND LENGTH(query_text) > 2 GROUP BY query_text ORDER BY n DESC",
  ).all();
  db.close();
  const pool = [];
  for (const r of rows) for (let i = 0; i < Math.min(r.n, 8); i++) pool.push(r.query_text);
  // Deterministic shuffle.
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 0xffffff) / 0xffffff; };
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool;
};

const before = snapshot();
const queries = readQueries();
console.log(`replaying ${N} of ${queries.length} logged queries against ${VAULT}\n`);

let ok = 0, failed = 0;
const started = Date.now();
for (let i = 0; i < N; i++) {
  const q = queries[i % queries.length];
  try {
    await runQueryRanked(VAULT, q, 10);
    ok++;
  } catch (err) {
    failed++;
    if (failed <= 3) console.log(`  fail: ${String(err.message).slice(0, 100)}`);
  }
  if ((i + 1) % 50 === 0) {
    process.stdout.write(`  ${i + 1}/${N}  ${((Date.now() - started) / (i + 1)).toFixed(0)}ms/query\n`);
  }
}

const after = snapshot();
console.log(`\nran ${ok}, failed ${failed}, ${((Date.now() - started) / 1000).toFixed(0)}s total\n`);

console.log("stage                 old n   old/sample     NEW n   NEW/sample    verdict");
const stages = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
for (const s of stages) {
  const b = before[s] ?? { n: 0, reward: 0 };
  const a = after[s] ?? { n: 0, reward: 0 };
  const dn = a.n - b.n;
  const dr = a.reward - b.reward;
  const oldPer = b.n ? b.reward / b.n : 0;
  const newPer = dn ? dr / dn : null;
  const verdict = newPer === null ? "not sampled"
    : newPer > 0 && oldPer < 0 ? "FLIPPED POSITIVE"
    : newPer > oldPer ? "improved"
    : newPer < oldPer ? "worse"
    : "flat";
  console.log(
    `${s.padEnd(20)} ${String(b.n).padStart(5)}   ${oldPer.toFixed(4).padStart(9)}    ` +
    `${String(dn).padStart(5)}   ${(newPer === null ? "—" : newPer.toFixed(4)).padStart(9)}    ${verdict}`,
  );
}
