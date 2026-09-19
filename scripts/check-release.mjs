#!/usr/bin/env node
// Fails when the version in package.json has outrun the npm dist-tag for longer
// than the grace window.
//
// This has happened twice. 0.6.0 sat unpublished in August; 0.7.0 sat tagged and
// unpublished for 51 days while 269 installs a week served 0.6.1 — a build with
// the zero-byte frontmatter write and the promote-without-rollback bug. Nothing
// in the repository noticed, because nothing was looking.
//
// A bump is not a failure. A bump that never ships is. So the gate only fires
// once the bump commit is older than GRACE_DAYS, which leaves the normal
// bump -> verify -> publish window alone.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GRACE_DAYS = Number(process.env.ORI_RELEASE_GRACE_DAYS ?? 3);

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const local = pkg.version;

function run(file, args, opts = {}) {
  return execFileSync(file, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

// Registry lookup.
//
// Being genuinely offline must not turn into a red build. Everything else must.
// A gate that reports success when it could not run is worse than no gate — it
// is the same silence that let 0.7.0 sit unpublished for 51 days. So the skip
// path is an allowlist of network conditions, and anything unrecognised fails.
const NETWORK = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|network|registry.*timeout|socket hang up/i;

let published;
try {
  published = run("npm", ["view", `${pkg.name}@latest`, "version"], {
    // Node refuses to execFile a .cmd shim without a shell on Windows; it
    // fails with EINVAL before npm is ever reached.
    shell: process.platform === "win32",
  });
  if (!published) throw new Error("npm view returned an empty version");
} catch (err) {
  const detail = [err.message, err.stderr].filter(Boolean).join("\n");
  const first = String(err.message).split("\n")[0];

  if (NETWORK.test(detail)) {
    console.log(`release gate: skipped, registry unreachable (${first})`);
    process.exit(0);
  }

  // E404 is not an error condition to wave through: it means this version line
  // has never been published at all.
  if (/E404/.test(detail)) {
    console.error(`release gate: ${pkg.name} is not on the registry. Nothing has ever been published.`);
    process.exit(1);
  }

  console.error(
    `release gate: could not query npm, and this is not a network failure — treating it as broken.\n${detail.trim()}`,
  );
  process.exit(1);
}

const cmp = (a, b) => {
  const pa = a.split(/[.-]/).map((n) => (Number.isNaN(Number(n)) ? n : Number(n)));
  const pb = b.split(/[.-]/).map((n) => (Number.isNaN(Number(n)) ? n : Number(n)));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    // A prerelease segment sorts below the release it qualifies.
    if (typeof x === "string" && typeof y === "number") return -1;
    if (typeof x === "number" && typeof y === "string") return 1;
    return x > y ? 1 : -1;
  }
  return 0;
};

const order = cmp(local, published);

if (order === 0) {
  console.log(`release gate: ${pkg.name}@${local} matches the registry`);
  process.exit(0);
}

if (order < 0) {
  // The registry is ahead. Someone published from a branch, or a bump was
  // reverted. Worth saying out loud, not worth failing the build over.
  console.log(
    `release gate: registry is ahead — package.json is ${local}, npm latest is ${published}`,
  );
  process.exit(0);
}

// Age of the bump, measured from the commit that introduced the current version
// string rather than HEAD, so unrelated commits do not reset the clock.
let bumpedAt = null;
try {
  const iso = run("git", [
    "log",
    "-1",
    "--format=%cI",
    "-S",
    `"version": "${local}"`,
    "--",
    "package.json",
  ]);
  if (iso) bumpedAt = new Date(iso);
} catch {
  // Shallow clone or no match. Fall through to the unaged report below.
}

const ageDays = bumpedAt ? (Date.now() - bumpedAt.getTime()) / 86_400_000 : null;
const age = ageDays === null ? "unknown age" : `${ageDays.toFixed(1)} days old`;

if (ageDays === null) {
  // The version string is not in committed history — an uncommitted local edit,
  // or a clone too shallow to search. The gate exists to catch a bump that went
  // *stale*, and staleness cannot be asserted without a date.
  console.log(
    `release gate: ${local} is not on the registry (npm latest ${published}), but the bump commit could not be dated — not failing on it`,
  );
  process.exit(0);
}

if (ageDays < GRACE_DAYS) {
  console.log(
    `release gate: ${local} is unpublished but only ${age} — within the ${GRACE_DAYS}-day window (npm latest ${published})`,
  );
  process.exit(0);
}

console.error(
  [
    "",
    `release gate: ${pkg.name}@${local} has never been published.`,
    "",
    `  package.json   ${local}   (${age})`,
    `  npm latest     ${published}`,
    "",
    "  Every install between those two versions serves the older build.",
    "",
    "  Publish it:        npx npm@12 stage publish   (then approve at",
    "                     npmjs.com/settings/<user>/staged-packages — 2FA required)",
    "  Or hold it:        ORI_RELEASE_GRACE_DAYS=<n> to extend the window",
    "",
  ].join("\n"),
);
process.exit(1);
