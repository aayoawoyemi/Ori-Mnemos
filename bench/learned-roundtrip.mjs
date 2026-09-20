// Prove `rm -rf .ori/ && ori index build && ori index import-learned` is
// lossless — on a COPY of the vault, never the live one.
//
// The claim being tested is the one the README made for months without it
// being true: that the index is disposable. It is only disposable if every
// accumulated row survives a destroy/rebuild cycle.
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VAULT = process.argv[2] ?? "C:/Users/aayoa/brain";
const ORI = "C:/Users/aayoa/Desktop/ori/dist/index.js";

const work = mkdtempSync(join(tmpdir(), "rt-"));
const vault = join(work, "v");
console.log("staging a copy of the vault (markdown + config + index)…");
mkdirSync(vault, { recursive: true });
for (const d of ["notes", "ops", "self", "inbox", ".ori"]) {
  if (existsSync(join(VAULT, d))) cpSync(join(VAULT, d), join(vault, d), { recursive: true });
}
for (const f of ["ori.config.yaml"]) {
  if (existsSync(join(VAULT, f))) cpSync(join(VAULT, f), join(vault, f));
}

const ori = (...args) =>
  JSON.parse(execFileSync("node", [ORI, ...args], { cwd: vault, encoding: "utf8", maxBuffer: 1 << 28 }));

const db = () => new Database(join(vault, ".ori", "embeddings.db"), { readonly: true });
const TABLES = ["note_q", "q_history", "q_history_genuine", "retrieval_log", "stage_q", "stage_log", "boosts", "note_access", "memory_events"];

function census(label) {
  const d = db();
  const out = {};
  for (const t of TABLES) {
    try { out[t] = d.prepare(`SELECT count(*) c FROM "${t}"`).get().c; } catch { out[t] = -1; }
  }
  try {
    out["co_occurrence(usage)"] = d.prepare("SELECT count(*) c FROM co_occurrence WHERE source='retrieval' OR co_retrieval_count>0").get().c;
    out["co_occurrence(all)"] = d.prepare("SELECT count(*) c FROM co_occurrence").get().c;
  } catch {}
  // A checksum over the actual learned values, not just row counts. Counts
  // matching while values are wrong is exactly the kind of pass this session
  // has already produced twice.
  try {
    const rows = d.prepare("SELECT note_id, q_value, update_count FROM note_q ORDER BY note_id").all();
    out["_note_q_digest"] = rows.reduce((h, r) => (h * 31 + r.note_id.length + Math.round(r.q_value * 1e6) + r.update_count) % 2147483647, 7);
  } catch {}
  d.close();
  console.log(`\n--- ${label} ---`);
  for (const [k, v] of Object.entries(out)) console.log(`  ${k.padEnd(24)} ${v}`);
  return out;
}

const before = census("BEFORE: the copied index");

console.log("\nexporting learned state…");
const exp = ori("index", "export-learned", "--file", "ops/rt.ndjson");
console.log(`  ${exp.data.total} rows, ${(exp.data.bytes / 1048576).toFixed(2)} MB`);

console.log("\nDESTROYING .ori/ …");
rmSync(join(vault, ".ori"), { recursive: true, force: true });
console.log("  gone:", !existsSync(join(vault, ".ori")));

console.log("\nrebuilding from markdown alone…");
const t0 = Date.now();
const built = ori("index", "build");
console.log(`  indexed ${built.data.indexed}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const afterRebuild = census("AFTER REBUILD (no import yet) — what a bare rebuild loses");

console.log("\nimporting learned state…");
const imp = ori("index", "import-learned", "--file", "ops/rt.ndjson");
console.log(`  ${imp.data.total} rows restored`);
if (imp.warnings?.length) console.log("  warnings:", imp.warnings);

const after = census("AFTER IMPORT");

console.log("\n" + "=".repeat(66));
let lost = 0, ok = 0;
for (const k of Object.keys(before)) {
  if (k === "co_occurrence(all)") continue; // bootstrap rows legitimately differ
  const b = before[k], a = after[k];
  if (b !== a) { console.log(`  MISMATCH ${k}: ${b} -> ${a}`); lost++; }
  else ok++;
}
console.log(lost === 0
  ? `  LOSSLESS — all ${ok} checks match, including the note_q value digest`
  : `  LOSSY — ${lost} mismatches`);

// What a naive `rm -rf` costs, for the record.
const naiveLost = Object.keys(before)
  .filter((k) => k !== "co_occurrence(all)" && before[k] > 0 && afterRebuild[k] === 0).length;
console.log(`  a bare rebuild without export/import empties ${naiveLost} of the accumulated tables`);

try { rmSync(work, { recursive: true, force: true }); } catch {}
