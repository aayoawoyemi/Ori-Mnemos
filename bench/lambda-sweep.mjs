// Does lambda matter?
//
// phaseB blends two z-normalized signals:
//     blended = (1 - lambda) * zNorm(similarity) + lambda * zNorm(qValue)
//
// Both inputs are logged per candidate in retrieval_log, so every historical
// query can be re-ranked at an arbitrary lambda with no re-embedding. This is
// an exact replay of the blend, not a simulation of it.
//
// Ground truth is the term-coverage metric repaired in 09ac45d: a query term
// counts as covered when at least one retrieved note's note_term postings
// contain it. Terms absent from the whole corpus are unreachable and excluded,
// otherwise the ceiling is not 1.0 and the numbers are not comparable.
//
// Usage: node bench/lambda-sweep.mjs [db] [k]

import Database from "better-sqlite3";

const DB = process.argv[2] ?? "C:/Users/aayoa/brain/.ori/embeddings.db";
const K = Number(process.argv[3] ?? 5);
const db = new Database(DB, { readonly: true });

const STOP = new Set(
  ("the a an and or but of to in for on at by with from is are was were be been do does did " +
    "this that these those it its as if then than so what when how why which who whom whose " +
    "i you he she we they me him her us them my your our their not no yes can could should " +
    "would will shall may might must have has had about into over under again more most some " +
    "such only own same too very s t just don now").split(" "),
);

const terms = (q) =>
  [...new Set(q.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [])].filter(
    (t) => t.length > 2 && !STOP.has(t),
  );

// note_term is the posting list the repaired metric reads.
// note_term is the posting list the repaired metric reads. Its note_id is an
// integer FK into note(id), while retrieval_log.note_id is a slug string --
// rerank.ts:133 logs r.title, reward.ts:111 logs slugify(noteId). Joining the
// two requires the note table; comparing them directly yields a silent 0.0,
// which is exactly the class of defect 09ac45d fixed.
const slugToRow = new Map();
for (const r of db.prepare("SELECT id, slug FROM note").all()) slugToRow.set(r.slug, r.id);

const postingStmt = db.prepare("SELECT DISTINCT note_id n FROM note_term WHERE term = ?");
const postingCache = new Map();
function posting(term) {
  let s = postingCache.get(term);
  if (!s) {
    s = new Set(postingStmt.all(term).map((r) => r.n));
    postingCache.set(term, s);
  }
  return s;
}

function zNorm(v) {
  const n = v.length;
  if (n === 0) return [];
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  return v.map((x) => (x - mean) / std);
}

// Group the log into query instances.
const rows = db
  .prepare(
    `SELECT session_id, query_text, note_id,
            COALESCE(similarity_score,0) sim, COALESCE(q_score,0) q
     FROM retrieval_log ORDER BY session_id, query_text, rank`,
  )
  .all();

const groups = new Map();
for (const r of rows) {
  const key = `${r.session_id}\u0000${r.query_text}`;
  let g = groups.get(key);
  if (!g) groups.set(key, (g = { query: r.query_text, c: [] }));
  g.c.push(r);
}

// Only instances where reordering can change the top-K answer are informative.
// With <= K candidates the top-K set is lambda-invariant and every lambda
// scores identically, which would dilute the signal toward zero.
const evaluable = [...groups.values()].filter((g) => g.c.length > K);

const LAMBDAS = [];
for (let l = 0; l <= 0.6001; l += 0.05) LAMBDAS.push(Number(l.toFixed(2)));

// Precompute per-instance: reachable terms, and the note set of each candidate.
const prepared = [];
let skippedNoTerms = 0;
for (const g of evaluable) {
  const ts = terms(g.query).filter((t) => posting(t).size > 0);
  if (ts.length === 0) {
    skippedNoTerms++;
    continue;
  }
  prepared.push({
    terms: ts,
    ids: g.c.map((r) => slugToRow.get(r.note_id) ?? null), // null keeps index alignment with sim/q
    sim: zNorm(g.c.map((r) => r.sim)),
    q: zNorm(g.c.map((r) => r.q)),
  });
}

console.log(`db            ${DB}`);
console.log(`query instances    ${groups.size}`);
console.log(`  > ${K} candidates  ${evaluable.length}  (reordering can change top-${K})`);
console.log(`  scorable         ${prepared.length}  (${skippedNoTerms} had no corpus-reachable term)`);
console.log(`\nlambda   recall@${K}    delta vs lambda=0`);

const results = [];
for (const lam of LAMBDAS) {
  let sum = 0;
  for (const p of prepared) {
    const order = p.ids
      .map((id, i) => [i, (1 - lam) * p.sim[i] + lam * p.q[i]])
      .sort((a, b) => b[1] - a[1])
      .slice(0, K)
      .map(([i]) => p.ids[i]);
    const top = new Set(order);
    let hit = 0;
    for (const t of p.terms) {
      const post = posting(t);
      for (const id of top) {
        if (id !== null && post.has(id)) {
          hit++;
          break;
        }
      }
    }
    sum += hit / p.terms.length;
  }
  results.push([lam, sum / prepared.length]);
}

const base = results[0][1];
let best = results[0];
for (const r of results) if (r[1] > best[1]) best = r;

for (const [lam, rec] of results) {
  const d = rec - base;
  const mark =
    lam === best[0] ? "  <- best" : Math.abs(lam - 0.4) < 1e-9 ? "  <- shipped (semantic)" : "";
  console.log(
    `  ${lam.toFixed(2)}   ${rec.toFixed(4)}    ${(d >= 0 ? "+" : "") + d.toFixed(4)}${mark}`,
  );
}

const shipped = results.find((r) => Math.abs(r[0] - 0.4) < 1e-9)[1];
const spread = best[1] - Math.min(...results.map((r) => r[1]));
console.log(`\n  best lambda        ${best[0].toFixed(2)}  (recall ${best[1].toFixed(4)})`);
console.log(`  shipped lambda     0.40  (recall ${shipped.toFixed(4)})`);
console.log(`  headroom           ${(best[1] - shipped).toFixed(4)}`);
console.log(`  total spread       ${spread.toFixed(4)} across lambda 0 -> 0.60`);

db.close();

// --- Paired significance -----------------------------------------------
// The same 1,653 instances are scored at every lambda, so comparisons are
// paired and a bootstrap over instances is the honest test. An unpaired
// comparison of two means this close would be uninformative.
function scoreAt(lam) {
  return prepared.map((p) => {
    const top = new Set(
      p.ids
        .map((id, i) => [i, (1 - lam) * p.sim[i] + lam * p.q[i]])
        .sort((a, b) => b[1] - a[1])
        .slice(0, K)
        .map(([i]) => p.ids[i]),
    );
    let hit = 0;
    for (const t of p.terms) {
      const post = posting(t);
      for (const id of top) if (id !== null && post.has(id)) { hit++; break; }
    }
    return hit / p.terms.length;
  });
}

function bootstrap(a, b, iters = 5000) {
  const n = a.length;
  const d = a.map((x, i) => x - b[i]);
  const obs = d.reduce((s, x) => s + x, 0) / n;
  let rng = 1234567;
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const means = [];
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[(rand() * n) | 0];
    means.push(s / n);
  }
  means.sort((x, y) => x - y);
  const nonzero = d.filter((x) => x !== 0).length;
  return { obs, lo: means[(iters * 0.025) | 0], hi: means[(iters * 0.975) | 0], nonzero };
}

console.log(`\n--- paired bootstrap, 5000 resamples over ${prepared.length} instances ---`);
const s035 = scoreAt(0.35);
for (const [label, lam] of [["semantic  0.40", 0.4], ["decision  0.55", 0.55], ["procedural 0.60", 0.6], ["pure-sim  0.00", 0.0]]) {
  const r = bootstrap(scoreAt(lam), s035);
  const sig = r.lo > 0 || r.hi < 0 ? "SIGNIFICANT" : "not significant";
  console.log(
    `  ${label} vs 0.35:  ${(r.obs >= 0 ? "+" : "") + r.obs.toFixed(4)}` +
      `  95% CI [${r.lo.toFixed(4)}, ${r.hi.toFixed(4)}]  ${sig}   (${r.nonzero} instances differ)`,
  );
}
