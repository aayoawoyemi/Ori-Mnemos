// Does query-addressed forgetting stay selective on a real vault?
//
// ForgetEval's cases hold 3-8 facts plus 4 distractors. A matcher tuned there
// has never been asked to discriminate against 1,500 competing notes, and the
// failure mode that matters -- deleting things nobody named -- gets harder
// with every note added, not easier.
//
// READ-ONLY. Calls matchForForget and reports what WOULD be forgotten.
// Nothing is written, nothing is deleted.
import { matchForForget } from "ori-memory";
import { loadConfig } from "ori-memory";
import { join } from "node:path";
import { readdirSync } from "node:fs";

const vault = process.argv[2] ?? "C:/Users/aayoa/brain";
const notes = join(vault, "notes");
const n = readdirSync(notes).filter((f) => f.endsWith(".md")).length;
const config = (await loadConfig(join(vault, "ori.config.yaml"))).engine;

console.log(`vault: ${n} notes\n`);

// Queries in ForgetEval's own idiom: a subject plus descriptive terms.
const queries = [
  "Kashi token incentives",
  "CourtShare engagement mechanics",
  "LoCoMo benchmark defects",
  "supersession forward declaration",
  "Ori positioning strategy",
  "lambda parameter sweep",
  "Brian Pauga outreach",
  "retrieval saturation embedder",
];

let worst = 0;
const rows = [];
for (const q of queries) {
  const t0 = Date.now();
  const m = await matchForForget(notes, q, config);
  const ms = Date.now() - t0;
  worst = Math.max(worst, m.length);
  rows.push({ q, count: m.length, ms, top: m.slice(0, 3).map((x) => x.slug) });
}

console.log("  matched  ms     query");
for (const r of rows) {
  const flag = r.count > 10 ? "  <-- over-matching" : "";
  console.log(`  ${String(r.count).padStart(7)}  ${String(r.ms).padStart(5)}  ${r.q}${flag}`);
  for (const t of r.top) console.log(`                  ${t.slice(0, 72)}`);
}

console.log(`\nworst case: ${worst} notes would be forgotten by one call`);
console.log(
  worst > 10
    ? "A benchmark whose cases hold 8 facts cannot surface this."
    : "Selectivity holds at scale.",
);
