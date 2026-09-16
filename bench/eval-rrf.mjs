
// eval-rrf.mjs — score ONE rrf_k against grep-grounded gold. Set ORI_RRF_K in env. Never writes config.
import { runQueryRanked } from "../dist/cli/search.js";
import { readFileSync } from "node:fs";
const VAULT = process.argv[2];
const gold = JSON.parse(readFileSync(process.argv[3], "utf8"));
const k = process.env.ORI_RRF_K || "default";
let hit1 = 0, hit5 = 0, mrr = 0, n = 0; const rows = [];
for (const [q, goldNotes] of Object.entries(gold)) {
  if (!goldNotes.length) continue;
  n++;
  const r = await runQueryRanked(VAULT, q, 5, true);
  const titles = r.data.results.map(x => x.title);
  const gset = new Set(goldNotes);
  const rank = titles.findIndex(t => gset.has(t));
  if (rank === 0) hit1++;
  if (rank >= 0) { hit5++; mrr += 1 / (rank + 1); }
  rows.push([q, rank, (titles[0] || "").slice(0, 55), Number((r.data.results[0]?.score ?? 0).toFixed(4))]);
}
console.log(JSON.stringify({ k, n, hit1, hit5, mrr: Number((mrr / n).toFixed(3)), rows }));
