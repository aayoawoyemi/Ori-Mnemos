// Can committing a SQLite DB plus its -wal/-shm sidecars to git actually
// lose or corrupt data, or is it only wasteful?
//
// Adversarial intent: try to make each scenario come out BENIGN. A scenario
// only counts as harmful if it survives that.
//
// Run: node bench/wal-git-repro.mjs
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, statSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "walgit-"));
const git = (args, cwd = root) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

git(["init", "-q", "."]);
git(["config", "user.email", "t@t"]);
git(["config", "user.name", "t"]);

const db = join(root, "m.db");
const wal = `${db}-wal`;
const shm = `${db}-shm`;
const sz = (p) => (existsSync(p) ? statSync(p).size : -1);
const results = [];
const rec = (scenario, harmful, detail) => {
  results.push({ scenario, harmful, detail });
  console.log(`\n[${harmful ? "HARMFUL" : "benign "}] ${scenario}\n    ${detail}`);
};

// ---------------------------------------------------------------------------
console.log("=== setup: WAL-mode db, 500 rows, connection left OPEN ===");
let conn = new Database(db);
conn.pragma("journal_mode = WAL");
conn.exec("CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT)");
const ins = conn.prepare("INSERT INTO note(body) VALUES (?)");
const many = conn.transaction((n) => { for (let i = 0; i < n; i++) ins.run(`row ${i}`); });
many(500);
console.log(`    db=${sz(db)}  wal=${sz(wal)}  shm=${sz(shm)}`);
const liveCount = conn.prepare("SELECT count(*) c FROM note").get().c;
console.log(`    rows visible to the live connection: ${liveCount}`);

// ---------------------------------------------------------------------------
// S1: commit all three while the connection is open (what `git add -A` in a
// vault with a running MCP server actually does), then clone and read.
git(["add", "-A"]);
git(["commit", "-qm", "commit with live connection"]);
const clone1 = join(root, "..", `clone1-${Date.now()}`);
git(["clone", "-q", root, clone1], tmpdir());

{
  const c = new Database(join(clone1, "m.db"), { readonly: false });
  const got = c.prepare("SELECT count(*) c FROM note").get().c;
  c.close();
  rec(
    "S1 commit .db+-wal+-shm with a live writer, then clone",
    got !== liveCount,
    `clone sees ${got} rows, source had ${liveCount}` +
      (got === liveCount ? " — WAL replayed correctly, no loss" : " — DATA MISMATCH"),
  );
}

// ---------------------------------------------------------------------------
// S2: the realistic .gitignore mistake. Many templates ignore *.db-wal and
// *.db-shm but not *.db. Commit ONLY the main file while the WAL holds
// committed-but-uncheckpointed transactions.
{
  const only = join(root, "..", `onlydb-${Date.now()}`);
  execFileSync("git", ["init", "-q", only], { cwd: tmpdir() });
  copyFileSync(db, join(only, "m.db")); // .db only — sidecars "gitignored"
  const c = new Database(join(only, "m.db"));
  let got, err = null;
  try { got = c.prepare("SELECT count(*) c FROM note").get().c; } catch (e) { err = e.message; }
  c.close();
  rec(
    "S2 .db committed, -wal gitignored (common template default)",
    err !== null || got !== liveCount,
    err
      ? `open/read threw: ${err}`
      : `restored db has ${got} rows, source had ${liveCount}` +
        (got === liveCount ? " — nothing was in the WAL" : ` — ${liveCount - got} rows SILENTLY LOST, no error`),
  );
}

// ---------------------------------------------------------------------------
// S3: mismatched pair. Stage the .db, let the database advance and checkpoint,
// then stage the -wal. git add is per-file and not atomic against a live
// writer, so the committed pair can come from two different instants.
{
  const stale = join(root, "..", `mismatch-${Date.now()}`);
  execFileSync("git", ["init", "-q", stale], { cwd: tmpdir() });
  copyFileSync(db, join(stale, "m.db")); // .db snapshot at T1

  many(500);                              // advance to T2
  conn.pragma("wal_checkpoint(TRUNCATE)"); // rewrite the WAL entirely
  many(200);                              // new WAL content at T3
  if (existsSync(wal)) copyFileSync(wal, join(stale, "m.db-wal")); // -wal from T3

  const c = new Database(join(stale, "m.db"));
  let got, err = null;
  try { got = c.prepare("SELECT count(*) c FROM note").get().c; } catch (e) { err = e.message; }
  c.close();
  // T1 db is 500 rows. A T3 wal against a T1 db is an inconsistent pair.
  const detected = err !== null;
  rec(
    "S3 .db from T1 paired with -wal from T3 (non-atomic git add)",
    !detected && got !== 500 && got !== 1200,
    detected
      ? `SQLite DETECTED it and raised: ${err}`
      : `opened without error, reports ${got} rows (T1 db had 500, source now has 1200)` +
        (got === 500 ? " — stale WAL correctly ignored via salt mismatch" : " — served a state that never existed"),
  );
}

// ---------------------------------------------------------------------------
// S4: is -shm actually needed, or pure scratch?
{
  const noshm = join(root, "..", `noshm-${Date.now()}`);
  execFileSync("git", ["init", "-q", noshm], { cwd: tmpdir() });
  copyFileSync(db, join(noshm, "m.db"));
  if (existsSync(wal)) copyFileSync(wal, join(noshm, "m.db-wal"));
  // deliberately omit -shm
  const c = new Database(join(noshm, "m.db"));
  const got = c.prepare("SELECT count(*) c FROM note").get().c;
  c.close();
  const cur = conn.prepare("SELECT count(*) c FROM note").get().c;
  rec(
    "S4 restore .db + -wal but NOT -shm",
    got !== cur,
    `${got} rows vs live ${cur} — ${got === cur ? "-shm regenerated automatically, committing it is pure noise" : "MISMATCH"}`,
  );
}

// ---------------------------------------------------------------------------
// S5: git checkout overwriting the .db under a live connection.
{
  many(50);
  git(["add", "-A"]);
  git(["commit", "-qm", "second"]);
  let err = null, got = null;
  try {
    git(["checkout", "-q", "HEAD~1", "--", "."]); // yank files under the open conn
    got = conn.prepare("SELECT count(*) c FROM note").get().c;
  } catch (e) { err = e.message; }
  rec(
    "S5 git checkout replaces .db while a connection is open",
    err !== null || got === null,
    err ? `live connection threw: ${String(err).slice(0, 110)}` : `live connection still reports ${got} rows`,
  );
}

conn.close();

console.log("\n" + "=".repeat(72));
const harmful = results.filter((r) => r.harmful);
console.log(`${harmful.length} of ${results.length} scenarios produced real harm:`);
for (const r of harmful) console.log(`  - ${r.scenario}`);
if (!harmful.length) console.log("  none — the concern is repo size only");
try { rmSync(root, { recursive: true, force: true }); } catch {}
