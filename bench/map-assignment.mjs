// Step 5: does assigning a note to a map need a trained classifier, or does
// the link graph already know?
//
// Four methods, same held-out split, one number each.
//   majority        always the biggest map                   (the floor)
//   neighbour vote  maps of directly linked notes            (graph, 1 hop)
//   propagation     iterative label spread over the graph    (graph, n hops)
//   embedding kNN   maps of the nearest notes by vector      (semantic, untrained)
//   trained head    logreg over embeddings                   (decide.ts)
//
// Whichever wins gets applied to the 975 mapless notes.
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";

const VAULT = "C:/Users/aayoa/brain/notes";
const DB = "C:/Users/aayoa/brain/.ori/embeddings.db";

const isMap = (slug) => /(^|[\s-])map$/.test(slug) || slug.endsWith("-map") || slug.endsWith(" map");

// ---- ground truth: which maps does each note link to --------------------
const files = readdirSync(VAULT).filter((f) => f.endsWith(".md"));
const slugs = files.map((f) => f.replace(/\.md$/, ""));
const slugSet = new Set(slugs);
const mapSlugs = slugs.filter(isMap);
const mapSet = new Set(mapSlugs);

const resolve = (raw) => {
  const t = raw.trim();
  if (slugSet.has(t)) return t;
  const h = t.replace(/ /g, "-");
  if (slugSet.has(h)) return h;
  const s = t.replace(/-/g, " ");
  return slugSet.has(s) ? s : null;
};

const outLinks = new Map();
const truth = new Map();
for (const f of files) {
  const slug = f.replace(/\.md$/, "");
  const text = readFileSync(`${VAULT}/${f}`, "utf8");
  const links = [...text.matchAll(/\[\[([^\]]+)\]\]/g)]
    .map((m) => resolve(m[1]))
    .filter((x) => x !== null);
  outLinks.set(slug, links);
  const maps = links.filter((l) => mapSet.has(l));
  if (maps.length) truth.set(slug, new Set(maps));
}

// Undirected neighbours, maps excluded as neighbours so a shared map does not
// leak the answer between two notes that both link it.
const neighbours = new Map(slugs.map((s) => [s, new Set()]));
for (const [src, links] of outLinks) {
  for (const dst of links) {
    if (mapSet.has(src) || mapSet.has(dst)) continue;
    neighbours.get(src)?.add(dst);
    neighbours.get(dst)?.add(src);
  }
}

const labelled = [...truth.keys()].filter((s) => !mapSet.has(s));
const mapless = slugs.filter((s) => !mapSet.has(s) && !truth.has(s));
console.log(`${slugs.length} notes | ${mapSlugs.length} maps | ${labelled.length} labelled | ${mapless.length} mapless`);
console.log(`maps: ${mapSlugs.join(", ")}\n`);

// 80/20 split, deterministic.
const test = labelled.filter((_, i) => i % 5 === 0);
const train = labelled.filter((_, i) => i % 5 !== 0);
const trainSet = new Set(train);
const hit = (slug, predicted) => (predicted && truth.get(slug)?.has(predicted) ? 1 : 0);

// ---- embeddings from the shipped index ----------------------------------
const db = new Database(DB, { readonly: true });
const vectors = new Map();
for (const row of db.prepare("SELECT title, body_vec, desc_vec FROM embeddings").all()) {
  const buf = row.body_vec ?? row.desc_vec;
  if (!buf) continue;
  const v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const copy = Float32Array.from(v);
  let n = 0;
  for (const x of copy) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < copy.length; i++) copy[i] /= n;
  vectors.set(row.title, copy);
}
db.close();
console.log(`embeddings loaded: ${vectors.size} (dims ${[...vectors.values()][0]?.length})`);
const vectorFor = (slug) => vectors.get(slug) ?? vectors.get(slug.replace(/-/g, " "));
console.log(`resolvable for labelled notes: ${labelled.filter((s) => vectorFor(s)).length}/${labelled.length}\n`);

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const argmax = (scores) => {
  let best = null, bs = -Infinity;
  for (const [k, v] of Object.entries(scores)) if (v > bs) { bs = v; best = k; }
  return bs > 0 ? best : null;
};

// ---- 1. majority --------------------------------------------------------
const counts = {};
for (const s of train) for (const m of truth.get(s)) counts[m] = (counts[m] ?? 0) + 1;
const majority = argmax(counts);

// ---- 2. neighbour vote (1 hop, training labels only) --------------------
const neighbourVote = (slug) => {
  const votes = {};
  for (const n of neighbours.get(slug) ?? []) {
    if (!trainSet.has(n)) continue;
    for (const m of truth.get(n) ?? []) votes[m] = (votes[m] ?? 0) + 1;
  }
  return argmax(votes);
};

// ---- 3. label propagation (n hops) --------------------------------------
const propagate = (rounds = 6, damping = 0.6) => {
  let state = new Map();
  for (const s of slugs) {
    if (mapSet.has(s)) continue;
    const dist = {};
    if (trainSet.has(s)) for (const m of truth.get(s)) dist[m] = 1;
    state.set(s, dist);
  }
  for (let r = 0; r < rounds; r++) {
    const next = new Map();
    for (const [s, own] of state) {
      if (trainSet.has(s)) { next.set(s, own); continue; }   // clamp known labels
      const acc = {};
      for (const n of neighbours.get(s) ?? []) {
        for (const [m, w] of Object.entries(state.get(n) ?? {})) acc[m] = (acc[m] ?? 0) + w;
      }
      const total = Object.values(acc).reduce((a, b) => a + b, 0);
      const dist = {};
      if (total > 0) for (const [m, w] of Object.entries(acc)) dist[m] = damping * (w / total);
      next.set(s, dist);
    }
    state = next;
  }
  return state;
};
const propagated = propagate();

// ---- 4. embedding kNN ---------------------------------------------------
const trainVectors = train.map((s) => [s, vectorFor(s)]).filter(([, v]) => v);
const knn = (slug, k = 12) => {
  const v = vectorFor(slug);
  if (!v) return null;
  const scored = [];
  for (const [other, ov] of trainVectors) {
    if (other === slug) continue;
    scored.push([other, dot(v, ov)]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  const votes = {};
  for (const [other, sim] of scored.slice(0, k)) {
    for (const m of truth.get(other) ?? []) votes[m] = (votes[m] ?? 0) + sim;
  }
  return argmax(votes);
};

// ---- 5. trained head ----------------------------------------------------
const trainHead = (epochs = 150) => {
  const labels = mapSlugs;
  const samples = [];
  for (const s of train) {
    const v = vectorFor(s);
    if (!v) continue;
    for (const m of truth.get(s)) samples.push({ v, y: labels.indexOf(m) });
  }
  const D = samples[0].v.length;
  const W = labels.map(() => new Float32Array(D));
  const b = new Float32Array(labels.length);
  let rate = 0.6, seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 0xffffff) / 0xffffff; };
  const order = samples.map((_, i) => i);
  for (let e = 0; e < epochs; e++) {
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (const idx of order) {
      const { v, y } = samples[idx];
      const z = labels.map((_, k) => dot(v, W[k]) + b[k]);
      const mx = Math.max(...z), ex = z.map((x) => Math.exp(x - mx)), sum = ex.reduce((a, c) => a + c, 0);
      for (let k = 0; k < labels.length; k++) {
        const g = ex[k] / sum - (k === y ? 1 : 0);
        for (let j = 0; j < D; j++) W[k][j] -= rate * (g * v[j] + 1e-4 * W[k][j]);
        b[k] -= rate * g;
      }
    }
    rate *= 0.99;
  }
  return (slug) => {
    const v = vectorFor(slug);
    if (!v) return null;
    let best = null, bs = -Infinity;
    for (let k = 0; k < labels.length; k++) { const s = dot(v, W[k]) + b[k]; if (s > bs) { bs = s; best = labels[k]; } }
    return best;
  };
};
const head = trainHead();

// ---- results ------------------------------------------------------------
const methods = {
  "majority (floor)": () => majority,
  "neighbour vote (1 hop)": neighbourVote,
  "label propagation": (s) => argmax(propagated.get(s) ?? {}),
  "embedding kNN (k=12)": knn,
  "trained head (decide.ts)": head,
};

console.log(`held-out: ${test.length} notes\n`);
for (const [name, predict] of Object.entries(methods)) {
  let right = 0, answered = 0;
  for (const s of test) {
    const p = predict(s);
    if (p === null) continue;
    answered++;
    right += hit(s, p);
  }
  const cov = (100 * answered) / test.length;
  console.log(
    `${name.padEnd(26)} ${(100 * right / test.length).toFixed(1)}% of all   ` +
    `${(100 * right / Math.max(answered, 1)).toFixed(1)}% when it answers   coverage ${cov.toFixed(0)}%`,
  );
}

// ---- hybrid: graph first, embedding as fallback -------------------------
let hRight = 0;
for (const s of test) {
  const p = neighbourVote(s) ?? knn(s);
  hRight += hit(s, p);
}
console.log(`${"graph, kNN fallback".padEnd(26)} ${(100 * hRight / test.length).toFixed(1)}% of all   coverage 100%`);

// ---- is it real, or is it guessing the big map? -------------------------
const bigMap = majority;
const hard = test.filter((s) => !truth.get(s).has(bigMap));
console.log(`\nexcluding the dominant map ("${bigMap}") — ${hard.length} of ${test.length} held-out notes:`);
for (const [name, predict] of Object.entries(methods)) {
  let right = 0;
  for (const s of hard) right += hit(s, predict(s));
  console.log(`  ${name.padEnd(26)} ${(100 * right / Math.max(hard.length,1)).toFixed(1)}%`);
}

// ---- per-map recall for the winner --------------------------------------
console.log(`\nper-map recall (trained head), held-out:`);
for (const m of mapSlugs) {
  const group = test.filter((s) => truth.get(s).has(m));
  if (!group.length) continue;
  const right = group.filter((s) => head(s) === m).length;
  console.log(`  ${m.slice(0,46).padEnd(48)} ${right}/${group.length}`);
}

// ---- what would it assign to the 946 mapless notes? ---------------------
const assigned = {};
for (const s of mapless) { const p = head(s); if (p) assigned[p] = (assigned[p] ?? 0) + 1; }
console.log(`\nwould assign the ${mapless.length} mapless notes as:`);
for (const [m, c] of Object.entries(assigned).sort((a,b)=>b[1]-a[1])) console.log(`  ${String(c).padStart(4)}  ${m}`);
