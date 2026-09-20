// Can Ori detect a conflicting fact on its own, from the new fact alone?
//
// factconsolidation.mjs found stale@1 = 50% vs a 33.2% floor, and
// factconsolidation-why.mjs found the cause: the stale line genuinely
// outscores the update, 67 to 30. The reason is structural. MemoryAgentBench
// builds conflicts by injecting COUNTERFACTUALS:
//
//     #271  The author of The Marriage of Figaro is Pierre Beaumarchais.   (stale, TRUE)
//     #398  The author of The Marriage of Figaro is Thomas Kyd.            (live,  FALSE)
//
// Beaumarchais wrote Figaro. Kyd did not. Same for "rugby union created in
// India", "Bengaluru in Oceania", "Narendra Modi directs the BBC". The
// superseded fact is always the true one, so every embedding model on earth
// scores it higher. FactConsolidation is adversarial to semantic similarity
// by construction and no amount of embedding quality wins it. Recency has to
// be represented explicitly.
//
// Ori has an explicit mechanism for this -- supersede() -- and the passive
// run never invoked it. This file asks the honest question: given only the
// INCOMING fact, can Ori's own matcher find the note it supersedes?
//
// No oracle is used for detection. matchForForget sees the new fact text and
// nothing else. The oracle stems are used ONLY to score what it found, as
// precision and recall against the 151 validated pairs.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchForForget, loadConfig } from "ori-memory";

const DATA = process.env.MAB_JSONL ?? "C:/tmp/mabdata/conflict.jsonl";
const THRESHOLD = Number(process.argv[process.argv.indexOf("--threshold") + 1]) || 0.35;
const slugify = (t, n = 56) =>
  t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n) || "f";
const CONNECTORS = new Set(["of", "is", "to", "in", "at", "from", "by", "the"]);

const rows = readFileSync(DATA, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const row = rows.find((r) => r.source === "factconsolidation_sh_6k");
const lines = row.context.split(/\r?\n/).map((l) => {
  const m = /^(\d+)\.\s+(.*)$/.exec(l.trim());
  return m ? { idx: Number(m[1]), text: m[2] } : null;
}).filter(Boolean);

// ---- oracle, for SCORING ONLY ----
const bucket = new Map();
for (const rec of lines) {
  const k = rec.text.split(/\s+/).slice(0, 3).join(" ").toLowerCase();
  if (!bucket.has(k)) bucket.set(k, []);
  bucket.get(k).push(rec);
}
const truePartner = new Map(); // later idx -> earlier idx it supersedes
for (const g of bucket.values()) {
  for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
    const a = g[i].text, b = g[j].text;
    let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
    const cut = a.lastIndexOf(" ", p);
    if (cut < 8 || cut < 0.6 * Math.min(a.length, b.length)) continue;
    const stem = a.slice(0, cut);
    if (!CONNECTORS.has(stem.slice(stem.lastIndexOf(" ") + 1).toLowerCase())) continue;
    const [lo, hi] = g[i].idx < g[j].idx ? [g[i], g[j]] : [g[j], g[i]];
    truePartner.set(hi.idx, lo.idx);
  }
}

const vault = mkdtempSync(join(tmpdir(), "mab-sup-"));
mkdirSync(join(vault, "notes"), { recursive: true });
mkdirSync(join(vault, ".ori"), { recursive: true });
writeFileSync(join(vault, "ori.config.yaml"), "engine:\n  db_path: .ori/embeddings.db\n");
const notesDir = join(vault, "notes");
const cfg = (await loadConfig(join(vault, "ori.config.yaml"))).engine;

const slugOf = new Map(); // idx -> slug
const trace = [];
let tp = 0, fp = 0, fn = 0, tn = 0, considered = 0;
const misses = [], falseHits = [];

console.log(`Ori's own conflict detection on FactConsolidation sh_6k`);
console.log(`matchForForget sees only the incoming fact. threshold=${THRESHOLD}\n`);

for (const { idx, text } of lines) {
  const expected = truePartner.get(idx) ?? null;

  // ask Ori, BEFORE writing, what this new fact supersedes
  let found = null;
  if (slugOf.size > 0) {
    try {
      const m = await matchForForget(notesDir, text, cfg, { limit: 1 });
      if (m.length) found = { slug: m[0].slug, sim: m[0].similarity ?? 0 };
    } catch (e) {
      // NEVER swallow. The first version of this file read m[0].score --
      // a field ForgetMatch does not have, the same shape as the
      // measureExactRecall bug -- and silently scored 0/151. In a .mjs
      // file TypeScript cannot catch it, so the error path must be loud.
      if (!/no such|empty|ENOENT/i.test(String(e && e.message))) throw e;
    }
  }
  considered++;
  trace.push({ idx, expected, foundSlug: found?.slug ?? null, sim: found?.sim ?? 0 });

  const slug = `f${String(idx).padStart(6, "0")}-${slugify(text)}`;
  slugOf.set(idx, slug);
  writeFileSync(join(notesDir, `${slug}.md`),
    `---\ndescription: ${JSON.stringify(text).slice(1, -1)}\ntype: insight\ncreated: 2026-09-19\n---\n\n${text}\n`, "utf8");
}
rmSync(vault, { recursive: true, force: true });

// One ingestion pass, thresholds applied offline. Re-ingesting 455 facts per
// threshold would be five 230-second runs to answer a question that is pure
// arithmetic over the trace.
console.log("  threshold   detected   missed  spurious   precision   recall      F1");
console.log("  " + "-".repeat(72));
let best = null;
for (const th of [0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95]) {
  let tp = 0, fp = 0, fn = 0;
  for (const t of trace) {
    const found = t.sim >= th ? t.foundSlug : null;
    const want = t.expected != null ? slugOf.get(t.expected) : null;
    if (want && found === want) tp++;
    else if (want) { fn++; if (found) fp++; }
    else if (found) fp++;
  }
  const prec = tp + fp ? tp / (tp + fp) : 0;
  const rec = tp + fn ? tp / (tp + fn) : 0;
  const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
  if (!best || f1 > best.f1) best = { th, prec, rec, f1, tp, fp, fn };
  console.log(`  ${th.toFixed(2).padStart(9)}   ${String(tp).padStart(8)}  ${String(fn).padStart(7)}  ${String(fp).padStart(8)}   ${(100*prec).toFixed(1).padStart(8)}%  ${(100*rec).toFixed(1).padStart(6)}%  ${(100*f1).toFixed(1).padStart(6)}%`);
}
console.log(`\n  real conflicts in corpus: ${truePartner.size} of ${considered} facts`);
console.log(`  best F1 = ${(100*best.f1).toFixed(1)}% at threshold ${best.th}`);
console.log("");
console.log("  Diagnosis: the spurious matches are same-template, different-subject --");
console.log("  \"Ferdinand Marcos is married to Imelda Marcos\" matching");
console.log("  \"Victoria Beckham is married to David Beckham\". matchForForget scores");
console.log("  relation-template similarity and never requires the SUBJECT to agree,");
console.log("  so raising the threshold trades recall away without fixing the cause.");
writeFileSync("bench/results/factconsolidation-detection.json", JSON.stringify({ trace, truePartner: truePartner.size }, null, 2));
