#!/usr/bin/env node
// Detail probes: full-output inspection (cell markers, schema dump), and
// streaming timing (time-to-first-stdout-byte) for timeout behaviour.
import { spawnSync, spawn } from 'node:child_process';

const CLI = 'C:/Users/aayoa/Desktop/ori/dist/index.js';
const vault = process.argv[2];
const which = process.argv[3] ?? 'all';

function runSync(args, stdin) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: vault, input: stdin, encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024, windowsHide: true,
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function timed(args) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let firstByteMs = null, bytes = 0, out = '';
    const p = spawn(process.execPath, [CLI, ...args], { cwd: vault, windowsHide: true });
    p.stdout.on('data', (d) => {
      if (firstByteMs === null) firstByteMs = Date.now() - t0;
      bytes += d.length;
      if (out.length < 4000) out += d.toString('utf8');
    });
    p.on('close', (code) => resolve({ code, firstByteMs, exitMs: Date.now() - t0, bytes, out }));
  });
}

if (which === 'all' || which === 'cell') {
  console.log('=== CELL: long text tail ===');
  const r = runSync(['sql', "SELECT length(description) AS truelen, description FROM v_note WHERE length(description) > 5000 LIMIT 1"]);
  const j = JSON.parse(r.out);
  const cell = j.data.rows[0][1];
  console.log('truelen col   :', j.data.rows[0][0]);
  console.log('cell type     :', typeof cell);
  console.log('cell js length:', typeof cell === 'string' ? cell.length : JSON.stringify(cell).length);
  console.log('cell bytes    :', Buffer.byteLength(typeof cell === 'string' ? cell : JSON.stringify(cell), 'utf8'));
  console.log('cell tail 220 :', JSON.stringify(typeof cell === 'string' ? cell.slice(-220) : cell));
  console.log('warnings      :', JSON.stringify(j.warnings));

  console.log('=== CELL: multibyte boundary (unicode long text) ===');
  const r2 = runSync(['sql', "SELECT length(body), body FROM notes WHERE length(body) > 6000 LIMIT 1"]);
  console.log(r2.out.slice(0, 300));
  console.log('... code', r2.code);
}

if (which === 'all' || which === 'schema') {
  console.log('=== SCHEMA full ===');
  const r = runSync(['sql', '--schema']);
  console.log(r.out);
}

if (which === 'all' || which === 'uni') {
  console.log('=== UNICODE titles present? ===');
  for (const q of [
    "SELECT slug, title FROM v_note WHERE slug IN ('note-0002','note-0005','note-0009')",
    "SELECT count(*) FROM v_note WHERE title LIKE '%unicode%'",
    "SELECT slug, title FROM v_note WHERE title GLOB '*[^ -~]*' LIMIT 5",
  ]) {
    const r = runSync(['sql', q]);
    console.log(q, '->', r.out.trim());
  }
}

if (which === 'all' || which === 'big') {
  console.log('=== BIG RESULT sizes ===');
  for (const [label, args] of [
    ['1000 rows x 3 long text cols', ['sql', '--limit', '1000', 'SELECT description, description, description FROM v_note ORDER BY length(description) DESC']],
    ['all notes body', ['sql', '--limit', '1000', 'SELECT slug, body FROM notes']],
    ['recursive 1000 x wide', ['sql', '--limit', '1000', "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<1000) SELECT i, (SELECT description FROM v_note ORDER BY length(description) DESC LIMIT 1) FROM c"]],
    ['embeddings 1000 rows all blobs', ['sql', '--limit', '1000', 'SELECT * FROM embeddings']],
  ]) {
    const r = runSync(args);
    let n = null, w = null;
    try { const j = JSON.parse(r.out); n = j.data?.rows?.length; w = JSON.stringify(j.warnings); } catch { }
    console.log(`${label}: code=${r.code} bytes=${Buffer.byteLength(r.out, 'utf8')} rows=${n} warnings=${w}`);
  }
}

if (which === 'all' || which === 'bigint') {
  console.log('=== BIGINT from stored column ===');
  for (const q of [
    'SELECT 9223372036854775807 AS maxint',
    "SELECT CAST('9007199254740993' AS INTEGER) AS c",
    'SELECT 1234567890123456789 AS a, typeof(1234567890123456789) AS t',
    'SELECT 9007199254740993 - 9007199254740992 AS should_be_1',
  ]) {
    const r = runSync(['sql', q]);
    console.log(q, '->', r.out.trim());
  }
}

if (which === 'all' || which === 'time') {
  console.log('=== TIMEOUT: time to first stdout byte vs exit ===');
  for (const [label, args] of [
    ['crossjoin default 2000ms', ['sql', 'SELECT count(*) FROM v_note a, v_note b, v_note c']],
    ['crossjoin --timeout 100', ['sql', '--timeout', '100', 'SELECT count(*) FROM v_note a, v_note b, v_note c']],
    ['recursive count 50M', ['sql', 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<50000000) SELECT count(*) FROM c']],
    ['recursive rows 50M', ['sql', 'WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<50000000) SELECT i FROM c']],
    ['fast baseline', ['sql', 'SELECT 1']],
  ]) {
    const r = await timed(args);
    console.log(`${label}: firstByteMs=${r.firstByteMs} exitMs=${r.exitMs} code=${r.code} bytes=${r.bytes}`);
    console.log('   out:', r.out.trim().slice(0, 300));
  }
}
