// Temporal forgetting: does Ori's decay actually do anything?
//
// Every forgetting benchmark that exists measures COMMANDED forgetting --
// ForgetEval's supersede/release/purge, MemoryAgentBench's selective
// forgetting, Memora's FAMA. All of them are control-plane operations: an
// agent decides to forget and issues a call.
//
// Ori's distinctive mechanism is the opposite and is measured by none of
// them: Ebbinghaus decay on wall-clock time, where a memory nobody touches
// weakens on its own and a memory touched often resists. ForgetEval even has
// a family named "decay", and it means `release(query)` -- an explicit call.
//
// This file is the missing measurement, and it is written to be able to come
// back NEGATIVE. If decay changes no ranking and evicts nothing, the
// "cognitive" framing is decoration and should be dropped from the README.
//
// Run: node bench/temporal-forgetting.mjs
import { ebbinghausDecayRate } from "../src/core/activation.js";

const DAY = 1;
const PER_QUERY_CAP = 0.05; // activation.ts
const FLOOR = 0.001;        // below this loadBoosts drops the row entirely

const decayed = (boost, rate, days) => boost * Math.exp(-rate * days);

function halfLife(rate) {
  return Math.log(2) / rate;
}
function expiry(boost, rate) {
  // days until the boost falls under the floor and the note stops being
  // boosted at all -- the closest thing Ori has to automatic eviction
  return Math.log(boost / FLOOR) / rate;
}

console.log("=== 1. Does reinforcement measurably slow decay? ===\n");
console.log("  accesses  sessions   rate     half-life   boost gone after");
const profiles = [
  [1, 1, "touched once"],
  [5, 3, "a few times, a few sessions"],
  [20, 10, "heavily used"],
  [100, 40, "core note"],
];
const rates = [];
for (const [a, s, label] of profiles) {
  const r = ebbinghausDecayRate(a, s);
  rates.push(r);
  console.log(
    `  ${String(a).padStart(8)}  ${String(s).padStart(8)}   ${r.toFixed(4)}   ${halfLife(r).toFixed(1).padStart(6)}d   ${expiry(PER_QUERY_CAP, r).toFixed(0).padStart(6)}d   ${label}`,
  );
}
const spread = rates[0] / rates[rates.length - 1];
console.log(`\n  slowest / fastest = ${spread.toFixed(2)}x`);
console.log(
  spread > 1.5
    ? "  Reinforcement matters. This is a real Ebbinghaus curve, not a constant."
    : "  Reinforcement barely matters -- the curve is decoration.",
);

console.log("\n=== 2. The decay curve for a note touched once ===\n");
const r1 = ebbinghausDecayRate(1, 1);
console.log("  day    boost     % of original   boosted?");
for (const d of [0, 7, 14, 30, 39, 60, 90]) {
  const b = decayed(PER_QUERY_CAP, r1, d * DAY);
  const alive = b >= FLOOR;
  console.log(
    `  ${String(d).padStart(3)}    ${b.toFixed(5)}   ${String((100 * b / PER_QUERY_CAP).toFixed(1)).padStart(6)}%        ${alive ? "yes" : "NO — dropped"}`,
  );
}

console.log("\n=== 3. What this is and is not ===\n");
const r100 = ebbinghausDecayRate(100, 40);
console.log(`  A note touched once loses its boost after ${expiry(PER_QUERY_CAP, r1).toFixed(0)} days.`);
console.log(`  A note touched 100 times over 40 sessions holds it for ${expiry(PER_QUERY_CAP, r100).toFixed(0)} days.`);
console.log(`  Ratio: ${(expiry(PER_QUERY_CAP, r100) / expiry(PER_QUERY_CAP, r1)).toFixed(1)}x longer.`);
console.log("");
console.log("  BUT: what decays is a ranking BOOST, not the note. A fully");
console.log("  decayed note is still returned by semantic similarity; it has");
console.log("  simply stopped being privileged. This is de-prioritisation over");
console.log("  time, not eviction over time, and the README should say so.");
console.log("");
console.log("  No benchmark measures either one. ForgetEval's 'decay' family");
console.log("  is release(query). MemoryAgentBench's selective forgetting is");
console.log("  instruction-following. Memora's FAMA scores obsolete-memory");
console.log("  reliance after an explicit update. All commanded, none timed.");
