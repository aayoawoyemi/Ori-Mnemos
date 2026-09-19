// What does query_type actually buy on a real query log?
//
// query_type is 97.3% "semantic" in a 15,892-row retrieval_log. Before
// "fixing" the classifier, check whether it is wrong or whether the workload
// is genuinely uniform -- and what the field's only consumer does with it.
//
// Usage: node bench/lambda-probe.mjs [path/to/embeddings.db]

import Database from "better-sqlite3";

const DB = process.argv[2] ?? "C:/Users/aayoa/brain/.ori/embeddings.db";
const db = new Database(DB, { readonly: true });

// Mirrors src/core/rerank.ts.
const LAMBDA_MIN = 0.15;
const LAMBDA_MAX = 0.35;
const LAMBDA_MATURITY = 200;
const SHIFTS = {}; // removed in this commit; kept as {} so the probe still runs

const tables = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
);

function totalQUpdates() {
  if (!tables.has("note_q")) return 0;
  const cols = db.prepare("PRAGMA table_info(note_q)").all().map((c) => c.name);
  const col = ["update_count", "updates", "n", "count", "visits"].find((c) => cols.includes(c));
  return col
    ? db.prepare(`SELECT COALESCE(SUM(${col}),0) s FROM note_q`).get().s
    : db.prepare("SELECT COUNT(*) s FROM note_q").get().s;
}

const updates = totalQUpdates();
const maturity = Math.min(updates / LAMBDA_MATURITY, 1);
const base = LAMBDA_MIN + (LAMBDA_MAX - LAMBDA_MIN) * maturity;
const lambdaOf = (t) => Math.max(0.1, Math.min(0.6, base + (SHIFTS[t] ?? 0)));

console.log(`db              ${DB}`);
console.log(`total q-updates ${updates}  (maturity ${(maturity * 100).toFixed(0)}%)`);
console.log(`base lambda     ${base.toFixed(4)}${maturity >= 1 ? "  <- saturated at LAMBDA_MAX" : ""}`);

const rows = db
  .prepare("SELECT query_type t, COUNT(*) n FROM retrieval_log GROUP BY query_type ORDER BY n DESC")
  .all();
const total = rows.reduce((a, r) => a + r.n, 0);

console.log(`\nretrieval_log   ${total} rows\n`);
let weighted = 0;
for (const r of rows) {
  const lam = lambdaOf(r.t);
  weighted += lam * r.n;
  const share = (100 * r.n) / total;
  const clamped = lam === 0.6 || lam === 0.1 ? "  <- CLAMPED" : "";
  console.log(
    `  ${String(r.t).padEnd(11)} ${String(r.n).padStart(6)} ${share.toFixed(1).padStart(5)}%   lambda=${lam.toFixed(3)}${clamped}`,
  );
}
const mean = weighted / total;
const dom = rows[0];
const domLam = lambdaOf(dom.t);
const spread = Math.max(...rows.map((r) => lambdaOf(r.t))) - Math.min(...rows.map((r) => lambdaOf(r.t)));

console.log(`\n  traffic-weighted mean lambda  ${mean.toFixed(4)}`);
console.log(`  dominant-class lambda         ${domLam.toFixed(4)} (${dom.t})`);
console.log(`  deviation from a constant     ${Math.abs(mean - domLam).toFixed(4)}`);
console.log(`  observed lambda spread        ${spread.toFixed(3)}`);

// How much does the whole feature move the answer, vs. folding the dominant
// shift into LAMBDA_MIN and deleting the table?
const collapsed = domLam;
let movedRows = 0;
for (const r of rows) if (Math.abs(lambdaOf(r.t) - collapsed) > 1e-9) movedRows += r.n;
console.log(
  `\n  rows whose lambda would change if QUERY_TYPE_SHIFTS were deleted and`,
  `\n  LAMBDA_MIN lowered by ${(-SHIFTS[dom.t]).toFixed(2)}:  ${movedRows} / ${total} (${((100 * movedRows) / total).toFixed(2)}%)`,
);

db.close();
