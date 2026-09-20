// MemoryAgentBench / Conflict_Resolution -- FactConsolidation, RETRIEVAL ONLY.
//
// READ THIS BEFORE QUOTING ANY NUMBER THIS FILE PRINTS.
//
// The published MemoryAgentBench protocol is memory-system + gpt-4o-mini
// reader. All 18 agent configs in configs/agent_conf/RAG_Agents/ set
// `model: gpt-4o-mini`. Their leaderboard numbers are end-to-end accuracy of
// that pair. This harness runs ONLY the memory half, because there is no
// OpenAI key on this machine, so its output is NOT comparable to their table
// and must never be placed in the same column.
//
// What it does measure, honestly:
//
//   The context is a numbered list of atomic facts. Some subject-relation
//   pairs appear twice with different objects, and the LATER line is the
//   update:
//       447. Roy Rogers is married to Dale Evans.
//       452. Roy Rogers is married to John McVie.     <- gold
//   The gold answer is always the latest value, so retrieval alone is
//   scoreable with zero LLM involvement:
//
//     hit@k     gold answer string present in the top-k
//     head@1    gold present in the single top-ranked fact
//     stale@k   a SUPERSEDED value for the same subject-relation is in
//               top-k -- retrieved contamination the reader must survive
//     clean@k   hit and not stale: the update retrieved without its ghost
//
//   stale@k is the interesting column and nobody reports it. A system can
//   score a perfect hit@k while handing the reader both answers and letting
//   the LLM guess, which is exactly the failure FactConsolidation was built
//   to expose.
//
// Usage: node bench/factconsolidation.mjs [--sizes 6k,32k] [--limit 100]
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recall as oriRecall } from "ori-memory";

const DATA = process.env.MAB_JSONL ?? "C:/tmp/mabdata/conflict.jsonl";
const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const SIZES = argOf("--sizes", "6k").split(",");
const LIMIT = Number(argOf("--limit", "100"));
const K = Number(argOf("--k", "10"));

const slugify = (t, n = 72) =>
  t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n) || "f";

/**
 * A conflict is two lines sharing a subject+relation stem with different
 * objects:
 *     223. goaltender is associated with the sport of ice hockey.
 *     310. goaltender is associated with the sport of pesäpallo.   <- live
 *
 * Getting this right matters more than it looks. A loose rule that buckets on
 * the first three tokens alone treats "The chairperson of Fatah is X" and
 * "The chairperson of Congolese Party of Labour is Y" as versions of each
 * other, and then reports stale@k = 100% for every system ever measured.
 * That is exactly what the first draft of this file did.
 *
 * The rule below was validated on sh_6k before being trusted: 151 stems,
 * every sampled one a genuine two-version pair, and the dataset's gold answer
 * is the LATEST version 70 times against 1 exception.
 *
 *   - shared prefix ends on a word boundary
 *   - covers >= 60% of the shorter line  (kills Fatah/Congolese at 43%,
 *     keeps Roy Rogers/Roy Rogers at 69%)
 *   - ends on a template connector, since every object in this corpus
 *     follows one of "of is to in at from by"
 *
 * Buckets on the first three words first: a true pair always shares them
 * because objects sit at the end, and 19k facts at 262k would otherwise be
 * 180M pair comparisons.
 */
const CONNECTORS = new Set(["of", "is", "to", "in", "at", "from", "by", "the"]);

function conflictMap(lines) {
  const bucket = new Map();
  for (const rec of lines) {
    const key = rec.text.split(/\s+/).slice(0, 3).join(" ").toLowerCase();
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(rec);
  }
  const stems = new Map(); // stem -> Map<lineIdx, text>
  for (const group of bucket.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i].text, b = group[j].text;
        let p = 0;
        while (p < a.length && p < b.length && a[p] === b[p]) p++;
        const cut = a.lastIndexOf(" ", p);
        if (cut < 8 || cut < 0.6 * Math.min(a.length, b.length)) continue;
        const stem = a.slice(0, cut);
        const lastWord = stem.slice(stem.lastIndexOf(" ") + 1).toLowerCase();
        if (!CONNECTORS.has(lastWord)) continue;
        const key = stem.toLowerCase();
        if (!stems.has(key)) stems.set(key, new Map());
        stems.get(key).set(group[i].idx, a);
        stems.get(key).set(group[j].idx, b);
      }
    }
  }
  // every line index that has a LATER version of the same stem
  const superseded = new Set();
  for (const versions of stems.values()) {
    const idxs = [...versions.keys()].sort((x, y) => x - y);
    for (const k of idxs.slice(0, -1)) superseded.add(k);
  }
  return { stems, superseded };
}

function freshVault() {
  const v = mkdtempSync(join(tmpdir(), "mab-ori-"));
  mkdirSync(join(v, "notes"), { recursive: true });
  mkdirSync(join(v, ".ori"), { recursive: true });
  writeFileSync(join(v, "ori.config.yaml"), "engine:\n  db_path: .ori/embeddings.db\n");
  return v;
}

const rows = readFileSync(DATA, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

console.log(`MemoryAgentBench / FactConsolidation -- RETRIEVAL ONLY (no reader, no API key)`);
console.log(`k=${K}  questions/row=${LIMIT}\n`);
console.log("  variant          facts  sup%   hit@k  head@1  stale@k  (chance)  stale@1  (chance)   ingest    query");
console.log("  " + "-".repeat(104));

const results = [];
for (const row of rows) {
  const m = /factconsolidation_(sh|mh)_(\d+k)/.exec(row.source);
  if (!m || !SIZES.includes(m[2])) continue;

  const lines = row.context
    .split(/\r?\n/)
    .map((l) => {
      const mm = /^(\d+)\.\s+(.*)$/.exec(l.trim());
      return mm ? { idx: Number(mm[1]), text: mm[2] } : null;
    })
    .filter(Boolean);

  const vault = freshVault();
  const byIdx = new Map();
  const t0 = Date.now();
  for (const { idx, text } of lines) {
    const slug = `f${String(idx).padStart(6, "0")}-${slugify(text, 56)}`;
    byIdx.set(slug, { idx, text });
    writeFileSync(
      join(vault, "notes", `${slug}.md`),
      `---\ndescription: ${JSON.stringify(text).slice(1, -1)}\ntype: insight\ncreated: 2026-09-19\n---\n\n${text}\n`,
      "utf8",
    );
  }
  const { superseded } = conflictMap(lines);
  const ingestMs = Date.now() - t0;

  let hit = 0, head = 0, stale = 0, stale1 = 0, clean = 0, n = 0;
  const t1 = Date.now();
  for (let q = 0; q < Math.min(LIMIT, row.questions.length); q++) {
    const question = row.questions[q];
    const golds = row.answers[q].map((a) => String(a).toLowerCase());
    let got;
    try {
      const res = await oriRecall(vault, question, { limit: K });
      got = (res?.data?.results ?? res?.results ?? []).slice(0, K);
    } catch {
      continue;
    }
    n++;
    const texts = got.map((h) => byIdx.get(h.title ?? h.slug ?? h.id)?.text ?? "");
    const joined = texts.join(" | ").toLowerCase();
    const isHit = golds.some((g) => joined.includes(g));
    const isHead = golds.some((g) => (texts[0] ?? "").toLowerCase().includes(g));

    // stale: any retrieved line that a LATER version supersedes
    const isStale = got.some((h) => {
      const rec = byIdx.get(h.title ?? h.slug ?? h.id);
      return rec ? superseded.has(rec.idx) : false;
    });

    const head0 = byIdx.get(got[0]?.title ?? got[0]?.slug ?? got[0]?.id);
    const isStale1 = head0 ? superseded.has(head0.idx) : false;

    if (isHit) hit++;
    if (isHead) head++;
    if (isStale) stale++;
    if (isStale1) stale1++;
    if (isHit && !isStale) clean++;
  }
  const queryMs = Date.now() - t1;
  rmSync(vault, { recursive: true, force: true });

  // The floor a random retriever would post. stale@k is near-vacuous at k=10
  // once a third of the corpus is superseded, which is exactly the case here,
  // so it is reported next to what chance alone produces.
  const pStale = superseded.size / lines.length;
  const randK = 100 * (1 - Math.pow(1 - pStale, K));
  const rand1 = 100 * pStale;

  const pct = (x) => (n ? ((100 * x) / n).toFixed(1).padStart(6) : "   n/a");
  console.log(
    `  ${row.source.replace("factconsolidation_", "").padEnd(14)} ${String(lines.length).padStart(6)} ${(100 * pStale).toFixed(0).padStart(4)}%  ${pct(hit)}  ${pct(head)}  ${pct(stale)}  ${randK.toFixed(1).padStart(7)}  ${pct(stale1)}  ${rand1.toFixed(1).padStart(7)}  ${String((ingestMs / 1000).toFixed(1) + "s").padStart(7)}  ${String((queryMs / 1000).toFixed(1) + "s").padStart(7)}`,
  );
  results.push({ source: row.source, facts: lines.length, superseded: superseded.size, n, hit, head, stale, stale1, clean, randK, rand1, ingestMs, queryMs });
}

console.log("\n  NOT comparable to the MemoryAgentBench leaderboard: that is");
console.log("  memory + gpt-4o-mini end to end, this is the memory half alone.");
writeFileSync("bench/results/factconsolidation-retrieval.json", JSON.stringify(results, null, 2));
console.log("\n  -> bench/results/factconsolidation-retrieval.json");
