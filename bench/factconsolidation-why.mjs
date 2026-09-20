// Why does Ori rank the superseded fact first half the time?
//
// factconsolidation.mjs measured stale@1 = 50% against a 33.2% chance floor
// (z = 3.57, p ~= 0.0002) on sh_6k. head@1 was 47%. Those sum to 97%, so rank
// 1 is nearly always one of the two versions of the queried fact and Ori is
// picking the dead one slightly more often than the live one.
//
// Two very different explanations:
//
//   A. SCORING. The stale line genuinely scores higher -- something in the
//      ranking prefers it. Would need a real fix.
//   B. TIE-BREAK. The two lines are near-identical text, score identically,
//      and the tie falls to whichever was inserted first, which is always the
//      stale one because the update appears later in the file. Then Ori has
//      no recency preference at all and the fix is one comparator.
//
// This distinguishes them by reading the actual scores of both versions.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recall as oriRecall } from "ori-memory";

const DATA = process.env.MAB_JSONL ?? "C:/tmp/mabdata/conflict.jsonl";
const slugify = (t, n = 56) =>
  t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n) || "f";
const CONNECTORS = new Set(["of", "is", "to", "in", "at", "from", "by", "the"]);

const rows = readFileSync(DATA, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const row = rows.find((r) => r.source === "factconsolidation_sh_6k");

const lines = row.context.split(/\r?\n/).map((l) => {
  const m = /^(\d+)\.\s+(.*)$/.exec(l.trim());
  return m ? { idx: Number(m[1]), text: m[2] } : null;
}).filter(Boolean);

// same validated detector
const bucket = new Map();
for (const rec of lines) {
  const k = rec.text.split(/\s+/).slice(0, 3).join(" ").toLowerCase();
  if (!bucket.has(k)) bucket.set(k, []);
  bucket.get(k).push(rec);
}
const stems = new Map();
for (const g of bucket.values()) {
  for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
    const a = g[i].text, b = g[j].text;
    let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
    const cut = a.lastIndexOf(" ", p);
    if (cut < 8 || cut < 0.6 * Math.min(a.length, b.length)) continue;
    const stem = a.slice(0, cut);
    if (!CONNECTORS.has(stem.slice(stem.lastIndexOf(" ") + 1).toLowerCase())) continue;
    const key = stem.toLowerCase();
    if (!stems.has(key)) stems.set(key, new Map());
    stems.get(key).set(g[i].idx, a); stems.get(key).set(g[j].idx, b);
  }
}
const pairOf = new Map(); // idx -> { live, dead }
for (const versions of stems.values()) {
  const idxs = [...versions.keys()].sort((a, b) => a - b);
  const live = idxs[idxs.length - 1];
  for (const k of idxs) pairOf.set(k, { live, dead: idxs.slice(0, -1) });
}

const vault = mkdtempSync(join(tmpdir(), "mab-why-"));
mkdirSync(join(vault, "notes"), { recursive: true });
mkdirSync(join(vault, ".ori"), { recursive: true });
writeFileSync(join(vault, "ori.config.yaml"), "engine:\n  db_path: .ori/embeddings.db\n");
const byIdx = new Map();
for (const { idx, text } of lines) {
  const slug = `f${String(idx).padStart(6, "0")}-${slugify(text)}`;
  byIdx.set(slug, { idx, text });
  writeFileSync(join(vault, "notes", `${slug}.md`),
    `---\ndescription: ${JSON.stringify(text).slice(1, -1)}\ntype: insight\ncreated: 2026-09-19\n---\n\n${text}\n`, "utf8");
}

let exactTie = 0, deadHigher = 0, liveHigher = 0, bothSeen = 0, n = 0;
let deltaSum = 0;
const examples = [];
for (let q = 0; q < 100; q++) {
  const res = await oriRecall(vault, row.questions[q], { limit: 10 });
  const got = res?.data?.results ?? res?.results ?? [];
  const scored = got.map((h) => {
    const rec = byIdx.get(h.title ?? h.slug ?? h.id);
    return rec ? { idx: rec.idx, text: rec.text, score: h.score ?? h.similarity ?? h.relevance ?? null } : null;
  }).filter(Boolean);
  if (!scored.length) continue;
  n++;
  // find a retrieved pair where both versions of the same stem came back
  for (const s of scored) {
    const pr = pairOf.get(s.idx);
    if (!pr) continue;
    const liveHit = scored.find((x) => x.idx === pr.live);
    const deadHit = scored.find((x) => pr.dead.includes(x.idx));
    if (!liveHit || !deadHit) continue;
    bothSeen++;
    const d = (deadHit.score ?? 0) - (liveHit.score ?? 0);
    deltaSum += d;
    if (Math.abs(d) < 1e-9) exactTie++;
    else if (d > 0) deadHigher++;
    else liveHigher++;
    if (examples.length < 5) examples.push({ q: row.questions[q], live: liveHit, dead: deadHit, d });
    break;
  }
}
rmSync(vault, { recursive: true, force: true });

console.log(`queries scored: ${n}`);
console.log(`both versions retrieved together: ${bothSeen}\n`);
console.log(`  scores EXACTLY tied : ${exactTie}`);
console.log(`  stale scored higher : ${deadHigher}`);
console.log(`  live  scored higher : ${liveHigher}`);
console.log(`  mean(stale - live)  : ${bothSeen ? (deltaSum / bothSeen).toExponential(3) : "n/a"}\n`);
console.log("examples:");
for (const e of examples) {
  console.log(`  Q: ${e.q.slice(0, 74)}`);
  console.log(`     live  #${e.live.idx} score=${e.live.score}  ${e.live.text.slice(0, 58)}`);
  console.log(`     stale #${e.dead.idx} score=${e.dead.score}  ${e.dead.text.slice(0, 58)}`);
}
console.log("");
if (exactTie > bothSeen * 0.5) {
  console.log("VERDICT: TIE-BREAK. The two versions score identically and the");
  console.log("tie falls to insertion order, which always favours the older");
  console.log("line. Ori expresses no recency preference whatsoever. Fix is a");
  console.log("comparator, not a model.");
} else if (deadHigher > liveHigher) {
  console.log("VERDICT: SCORING. The stale line genuinely outscores the update.");
} else {
  console.log("VERDICT: neither -- rank 1 is decided by something else.");
}
