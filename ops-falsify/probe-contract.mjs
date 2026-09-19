#!/usr/bin/env node
// Black-box probe harness for `ori sql` output contract / limits / schema.
// Usage: node probe-contract.mjs <vaultDir> [caseFilter]
// Prints one JSON line per case: {name, argv, stdinBytes, code, stdoutBytes, stdout(parsed or raw), stderr, wallMs}
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const CLI = 'C:/Users/aayoa/Desktop/ori/dist/index.js';
const vault = process.argv[2];
const filter = process.argv[3];

export function run(args, { stdin = undefined, cwd = vault } = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    input: stdin,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  });
  const wallMs = Date.now() - t0;
  const out = r.stdout ?? '';
  let parsed = null, parseErr = null;
  try { parsed = JSON.parse(out); } catch (e) { parseErr = String(e.message); }
  return {
    code: r.status, signal: r.signal, wallMs,
    stdoutBytes: Buffer.byteLength(out, 'utf8'),
    stderrBytes: Buffer.byteLength(r.stderr ?? '', 'utf8'),
    stdout: out, stderr: r.stderr ?? '', parsed, parseErr,
  };
}

const cases = [
  // 1. output shape
  ['shape-basic', ['sql', 'SELECT 1 AS a, \'x\' AS b']],
  ['dup-columns', ['sql', 'SELECT 1 AS x, 2 AS x']],
  ['no-columns-explain', ['sql', 'EXPLAIN SELECT 1']],
  ['values', ['sql', 'VALUES (1,2),(3,4)']],
  // 2. zero rows
  ['zero-rows', ['sql', 'SELECT slug FROM v_note WHERE slug = \'__nope__\'']],
  ['zero-rows-limit0', ['sql', 'SELECT 1 WHERE 0']],
  // 3. row cap
  ['cap-default-2000', ['sql', 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<2000) SELECT i FROM c']],
  ['cap-exactly-1000', ['sql', 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<1000) SELECT i FROM c']],
  ['cap-1001', ['sql', 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<1001) SELECT i FROM c']],
  ['limit-5', ['sql', '--limit', '5', 'SELECT slug FROM v_note ORDER BY slug']],
  ['limit-5-exact', ['sql', '--limit', '5', 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<5) SELECT i FROM c']],
  ['limit-5-six', ['sql', '--limit', '5', 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<6) SELECT i FROM c']],
  ['limit-5000', ['sql', '--limit', '5000', 'SELECT slug FROM v_note ORDER BY slug']],
  ['limit-0', ['sql', '--limit', '0', 'SELECT slug FROM v_note']],
  ['limit-neg', ['sql', '--limit', '-3', 'SELECT slug FROM v_note']],
  ['limit-junk', ['sql', '--limit', 'abc', 'SELECT slug FROM v_note']],
  // 4. cell limits
  ['long-text', ['sql', 'SELECT length(description), description FROM v_note WHERE length(description) > 5000 LIMIT 1']],
  ['synth-long-text', ['sql', 'SELECT length(x), x FROM (SELECT replace(hex(zeroblob(5000)),\'0\',\'A\') AS x)']],
  ['blob-embeddings', ['sql', 'SELECT * FROM embeddings LIMIT 2']],
  ['blob-literal', ['sql', 'SELECT zeroblob(1536) AS b']],
  ['big-result-size', ['sql', '--limit', '1000', 'SELECT slug, title, description FROM v_note']],
  // 5. null + bigint
  ['null-roundtrip', ['sql', 'SELECT NULL AS n, 1 AS one']],
  ['int-small', ['sql', 'SELECT 42 AS a, -7 AS b, 2147483647 AS c']],
  ['int-big', ['sql', 'SELECT 9007199254740993 AS a, 9223372036854775807 AS b, -9223372036854775808 AS c']],
  ['int-boundary', ['sql', 'SELECT 9007199254740991 AS safe_max, 9007199254740992 AS plus1']],
  ['float', ['sql', 'SELECT 1.5 AS f, 1e308*10 AS inf, 0.0/0.0 AS nan']],
  // 6. timeout
  ['timeout-default', ['sql', 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<50000000) SELECT count(*) FROM c']],
  ['timeout-manyrows', ['sql', '--limit', '1000000', 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<50000000) SELECT i FROM c']],
  ['timeout-crossjoin', ['sql', 'SELECT count(*) FROM v_note a, v_note b, v_note c']],
  ['timeout-flag-100', ['sql', '--timeout', '100', 'SELECT count(*) FROM v_note a, v_note b, v_note c']],
  ['timeout-flag-9000', ['sql', '--timeout', '9000', 'SELECT count(*) FROM v_note a, v_note b, v_note c']],
  // 7. schema
  ['schema', ['sql', '--schema']],
  ['schema-with-query', ['sql', '--schema', 'SELECT 1']],
  // 8. stdin
  ['stdin', ['sql', '--stdin'], 'SELECT 1 AS a, \'x\' AS b'],
  ['stdin-dup', ['sql', '--stdin'], 'SELECT 1 AS x, 2 AS x'],
  ['stdin-zero', ['sql', '--stdin'], 'SELECT 1 WHERE 0'],
  ['stdin-empty', ['sql', '--stdin'], ''],
  ['stdin-bad', ['sql', '--stdin'], 'DROP TABLE note'],
  ['stdin-and-arg', ['sql', '--stdin', 'SELECT 2 AS fromarg'], 'SELECT 1 AS fromstdin'],
  ['stdin-limit', ['sql', '--stdin', '--limit', '3'], 'SELECT slug FROM v_note ORDER BY slug'],
  // 9. exit codes
  ['exit-reject', ['sql', 'DROP TABLE note']],
  ['exit-syntaxerr', ['sql', 'SELECT * FROM no_such_table_xyz']],
  ['exit-empty-arg', ['sql', '']],
  ['exit-no-arg', ['sql']],
  ['unicode', ['sql', 'SELECT title FROM v_note WHERE title LIKE \'%日本語%\'']],
];

for (const [name, args, stdin] of cases) {
  if (filter && !name.includes(filter)) continue;
  const r = run(args, { stdin });
  const rec = { name, argv: args, stdin: stdin ?? null, code: r.code, wallMs: r.wallMs, stdoutBytes: r.stdoutBytes, stderr: r.stderr.slice(0, 600), parseErr: r.parseErr };
  if (r.parsed) {
    const p = r.parsed;
    rec.success = p.success;
    rec.warnings = p.warnings;
    rec.keys = Object.keys(p);
    if (p.data && typeof p.data === 'object') {
      rec.dataKeys = Object.keys(p.data);
      rec.columns = p.data.columns;
      rec.truncated = p.data.truncated;
      rec.elapsedMs = p.data.elapsedMs;
      rec.rowCount = Array.isArray(p.data.rows) ? p.data.rows.length : null;
      rec.row0Type = Array.isArray(p.data.rows) && p.data.rows.length ? (Array.isArray(p.data.rows[0]) ? 'array' : typeof p.data.rows[0]) : null;
      rec.row0 = Array.isArray(p.data.rows) && p.data.rows.length ? JSON.stringify(p.data.rows[0]).slice(0, 400) : null;
    } else {
      rec.data = JSON.stringify(p.data).slice(0, 400);
    }
  } else {
    rec.rawHead = r.stdout.slice(0, 500);
  }
  console.log(JSON.stringify(rec));
}
