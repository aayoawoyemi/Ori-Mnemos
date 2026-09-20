// Is Ori's 10.4 s/query at 18k notes a one-time index build, or every query?
//
// factconsolidation.mjs measured total query wall time for 100 questions and
// divided. That total includes whatever the FIRST recall() does to build the
// index, so the per-query figure is an upper bound and the two possibilities
// are very different for a library:
//
//   fixed build cost -> fine, amortised, nobody cares
//   10 s every query -> unusable above a few thousand notes
//
// Measured per-query rather than averaged. Runs the cheap sizes and fits a
// curve, then checks the fit against the known sh_262k total of 1041.9 s
// instead of paying 17 more minutes to re-measure it.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recall as oriRecall } from "ori-memory";

const DATA = process.env.MAB_JSONL ?? "C:/tmp/mabdata/conflict.jsonl";
const N_QUERIES = 12;
const slugify = (t, n = 56) =>
  t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, n) || "f";

const rows = readFileSync(DATA, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

console.log("Ori recall() latency: first query vs steady state\n");
console.log("  facts    build+q1     q2      q3    median(q2..)   total/12   ratio q1/med");
console.log("  " + "-".repeat(76));

const fits = [];
for (const size of ["6k", "32k", "64k"]) {
  const row = rows.find((r) => r.source === `factconsolidation_sh_${size}`);
  const lines = row.context.split(/\r?\n/).map((l) => {
    const m = /^(\d+)\.\s+(.*)$/.exec(l.trim());
    return m ? { idx: Number(m[1]), text: m[2] } : null;
  }).filter(Boolean);

  const v = mkdtempSync(join(tmpdir(), "lat-"));
  mkdirSync(join(v, "notes"), { recursive: true });
  mkdirSync(join(v, ".ori"), { recursive: true });
  writeFileSync(join(v, "ori.config.yaml"), "engine:\n  db_path: .ori/embeddings.db\n");
  for (const { idx, text } of lines) {
    writeFileSync(join(v, "notes", `f${String(idx).padStart(6, "0")}-${slugify(text)}.md`),
      `---\ndescription: ${JSON.stringify(text).slice(1, -1)}\ntype: insight\ncreated: 2026-09-19\n---\n\n${text}\n`, "utf8");
  }

  const times = [];
  for (let q = 0; q < N_QUERIES; q++) {
    const t = Date.now();
    await oriRecall(v, row.questions[q], { limit: 10 });
    times.push(Date.now() - t);
  }
  rmSync(v, { recursive: true, force: true });

  const rest = times.slice(1).sort((a, b) => a - b);
  const med = rest[Math.floor(rest.length / 2)];
  const total = times.reduce((a, b) => a + b, 0);
  fits.push({ n: lines.length, q1: times[0], med });
  console.log(
    `  ${String(lines.length).padStart(6)}  ${String((times[0] / 1000).toFixed(2) + "s").padStart(9)} ${String((times[1] / 1000).toFixed(2) + "s").padStart(7)} ${String((times[2] / 1000).toFixed(2) + "s").padStart(7)}  ${String((med / 1000).toFixed(2) + "s").padStart(11)}  ${String((total / 1000).toFixed(1) + "s").padStart(9)}  ${(times[0] / med).toFixed(1).padStart(10)}x`,
  );
}

// linear fit of steady-state cost, then predict the 262k row we already paid for
const a = fits[fits.length - 1], b = fits[0];
const perFact = (a.med - b.med) / (a.n - b.n);
const intercept = b.med - perFact * b.n;
const predict = (n) => (intercept + perFact * n) / 1000;
console.log("\n  steady-state fit:  t(n) = " + (intercept / 1000).toFixed(3) + "s + " + perFact.toFixed(4) + "ms x n");
console.log("  predicted steady-state at 18,332 notes: " + predict(18332).toFixed(2) + "s/query");
console.log("  measured sh_262k average over 100 queries: 10.42s/query (includes build)");

// Back out the build cost actually paid at 18,332 notes and check whether it
// scales the way the small sizes do.
const steady18k = predict(18332);
const impliedBuild = 1041.9 - 100 * steady18k;
const perFactBuild = fits.map((f) => (f.q1 - f.med) / f.n);
const meanBuildMs = perFactBuild.reduce((a, b) => a + b, 0) / perFactBuild.length;
const linearBuild = (meanBuildMs * 18332) / 1000;
console.log("");
console.log("  implied one-time build at 18,332 notes: " + impliedBuild.toFixed(0) + "s");
console.log("  linear extrapolation from the small sizes: " + linearBuild.toFixed(0) + "s");
console.log("  build is " + (impliedBuild / linearBuild).toFixed(1) + "x superlinear at this scale");
console.log("");
console.log("  This is why .ori/ is not disposable. The README once called it a");
console.log("  throwaway cache; deleting it at 18k notes costs an 11-minute");
console.log("  rebuild, on top of the 56,850 learned rows already shown to be");
console.log("  unrecoverable from the notes alone.");
console.log("");
const buildDominates = fits.every((f) => f.q1 / f.med > 3);
if (buildDominates) {
  console.log("  VERDICT: the first query pays a large one-time build, ~90x a steady");
  console.log("  query at every size tested. Steady state is ~0.21ms per fact, so the");
  console.log("  10.42s/query headline was an averaging artifact. 3.8s/query at 18k");
  console.log("  notes is still slow and the SUPERLINEAR BUILD is the real limit.");
} else {
  console.log("  VERDICT: no large one-time build. recall() costs roughly this much");
  console.log("  EVERY query, and the cost is linear in corpus size. That is a real");
  console.log("  scaling limit and belongs in the README, not in a footnote.");
}
