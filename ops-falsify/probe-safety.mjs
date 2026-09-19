#!/usr/bin/env node
// Black-box safety/validation probe for `ori sql`.
// Spawns the built CLI with argv directly (no shell) so byte-exact SQL,
// including unicode whitespace and NUL, reaches the binary unmangled.
//
// Usage: node probe-safety.mjs <group> [--vault DIR]
// Groups: reject, evade, allow, count, length, files, all
//
// Output: JSONL on stdout, one record per probe.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CLI = 'C:/Users/aayoa/Desktop/ori/dist/index.js';
const args = process.argv.slice(2);
const group = args[0] ?? 'all';
const vaultIdx = args.indexOf('--vault');
const VAULT = vaultIdx >= 0 ? args[vaultIdx + 1]
  : 'C:/Users/aayoa/AppData/Local/Temp/ori-falsify-safety/vault';

function run(argv, { cwd = VAULT, stdin = null } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...argv], { cwd, shell: false });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    if (stdin !== null) { p.stdin.write(stdin); p.stdin.end(); } else { p.stdin.end(); }
    p.on('close', (code) => resolve({ code, out, err }));
    p.on('error', (e) => resolve({ code: -1, out, err: String(e) }));
  });
}

function classify(r) {
  let json = null, parseError = null;
  const t = r.out.trim();
  try { json = JSON.parse(t); } catch (e) { parseError = String(e.message); }
  const stackish = /\b(at\s+\w+.*\(|Error:|Throw|UnhandledPromiseRejection|node:internal)/.test(r.err);
  return {
    exit: r.code,
    stdout: t.length > 900 ? t.slice(0, 900) + '\u2026[TRUNC]' : t,
    stderr: r.err.trim().length > 600 ? r.err.trim().slice(0, 600) + '\u2026[TRUNC]' : r.err.trim(),
    jsonOk: json !== null,
    parseError,
    success: json ? json.success : null,
    warnings: json ? json.warnings : null,
    hasDataShape: json ? (json.data !== undefined) : null,
    stackTrace: stackish,
  };
}

const results = [];
async function probe(id, expect, sql, opts = {}) {
  // argv cannot carry NUL (node refuses) and a leading `-` is eaten by the
  // option parser, so those two shapes are fed through --stdin instead.
  const argvHostile = sql.includes('\u0000') || sql.startsWith('-');
  let o = opts;
  if (!opts.argv && argvHostile) o = { ...opts, argv: ['sql', '--stdin'], stdin: sql };
  const argv = o.argv ?? ['sql', sql];
  const r = await run(argv, o);
  const c = classify(r);
  const rec = { id, expect, sql: o.sqlLabel ?? sql, via: o.stdin !== undefined && o.stdin !== null ? 'stdin' : 'argv', ...c };
  results.push(rec);
  process.stdout.write(JSON.stringify(rec) + '\n');
  return rec;
}

// ---------------------------------------------------------------- groups

const REJECTED_STATEMENTS = [
  ['ATTACH', "ATTACH DATABASE 'C:/Users/aayoa/AppData/Local/Temp/ori-falsify-safety/side.db' AS side"],
  ['DETACH', 'DETACH DATABASE side'],
  ['PRAGMA-read', 'PRAGMA table_info(note)'],
  ['PRAGMA-write', 'PRAGMA query_only = 0'],
  ['PRAGMA-jm', 'PRAGMA journal_mode = DELETE'],
  ['INSERT', "INSERT INTO note (slug) VALUES ('pwned')"],
  ['UPDATE', "UPDATE note SET title = 'pwned'"],
  ['DELETE', 'DELETE FROM note'],
  ['DROP', 'DROP TABLE note'],
  ['CREATE', 'CREATE TABLE pwned (a INT)'],
  ['ALTER', 'ALTER TABLE note RENAME TO pwned'],
  ['VACUUM', 'VACUUM'],
  ['BEGIN', 'BEGIN'],
  ['BEGIN-IMMEDIATE', 'BEGIN IMMEDIATE TRANSACTION'],
  ['COMMIT', 'COMMIT'],
  ['ROLLBACK', 'ROLLBACK'],
  ['REINDEX', 'REINDEX'],
  ['REPLACE', "REPLACE INTO note (slug) VALUES ('pwned')"],
  ['SAVEPOINT', 'SAVEPOINT sp1'],
  ['RELEASE', 'RELEASE sp1'],
  ['ANALYZE', 'ANALYZE'],
  ['CREATE-TEMP', 'CREATE TEMP TABLE pwned AS SELECT 1'],
  ['CREATE-VIEW', 'CREATE VIEW pwned AS SELECT 1'],
  ['CREATE-TRIGGER', 'CREATE TRIGGER t AFTER INSERT ON note BEGIN SELECT 1; END'],
  ['INSERT-lower', "insert into note (slug) values ('pwned')"],
  ['UPDATE-mixed', "UpDaTe note SeT title = 'pwned'"],
];

const EVASIONS = [
  ['cmt-before-drop', '/* harmless */ DROP TABLE note'],
  ['cmt-line-before-drop', '-- harmless\nDROP TABLE note'],
  ['cmt-nested-before-drop', '/* /* */ DROP TABLE note'],
  ['cte-then-insert', "WITH x AS (SELECT 1) INSERT INTO note (slug) VALUES ('pwned')"],
  ['cte-then-delete', 'WITH x AS (SELECT 1) DELETE FROM note'],
  ['cte-then-update', "WITH x AS (SELECT 1) UPDATE note SET title='pwned'"],
  ['select-then-drop', 'SELECT 1; DROP TABLE note'],
  ['select-then-delete', 'SELECT 1; DELETE FROM note'],
  ['select-then-insert-nosemi-nl', "SELECT 1\nINSERT INTO note (slug) VALUES ('x')"],
  ['union-delete', 'SELECT 1 UNION SELECT 2; DELETE FROM note'],
  ['subquery-drop', 'SELECT (SELECT 1); DROP TABLE note'],
  ['explain-delete', 'EXPLAIN DELETE FROM note'],
  ['explain-insert', "EXPLAIN INSERT INTO note (slug) VALUES ('pwned')"],
  ['explain-drop', 'EXPLAIN DROP TABLE note'],
  ['explain-qp-delete', 'EXPLAIN QUERY PLAN DELETE FROM note'],
  ['values-then-drop', 'VALUES (1); DROP TABLE note'],
  ['case-drop', 'DrOp TaBlE note'],
  ['case-select-ok', 'sElEcT 1'],
  ['kw-split-comment', 'DROP/**/TABLE note'],
  ['kw-split-comment-inner', 'DR/**/OP TABLE note'],
  ['select-split-comment', 'SELECT/**/1'],
  ['ws-tab', '\tSELECT 1'],
  ['ws-vtab', '\u000bSELECT 1'],
  ['ws-formfeed', '\fSELECT 1'],
  ['ws-cr', '\r\nSELECT 1'],
  ['ws-nbsp-select', '\u00a0SELECT 1'],
  ['ws-nbsp-drop', '\u00a0DROP TABLE note'],
  ['ws-u2028-drop', '\u2028DROP TABLE note'],
  ['ws-ideographic-drop', '\u3000DROP TABLE note'],
  ['ws-zwsp-drop', '\u200bDROP TABLE note'],
  ['ws-bom-drop', '\ufeffDROP TABLE note'],
  ['ws-bom-select', '\ufeffSELECT 1'],
  ['fullwidth-select', '\uff33\uff25\uff2c\uff25\uff23\uff34 1'],
  ['nul-prefix-drop', '\u0000DROP TABLE note'],
  ['nul-mid', 'SELECT 1\u0000; DROP TABLE note'],
  ['unterminated-string', "SELECT 'abc"],
  ['unterminated-block-comment', 'SELECT 1 /* abc'],
  ['unterminated-block-hides-drop', "SELECT 1 /* x */ /* DROP TABLE note"],
  ['string-then-real-drop', "SELECT 'safe'; DROP TABLE note"],
  ['dq-drop-ident', 'SELECT "DROP TABLE note"'],
  ['empty', ''],
  ['whitespace-only', '   \t\n  '],
  ['comment-only', '-- nothing here'],
  ['block-comment-only', '/* nothing */'],
  ['semi-only', ';'],
  ['leading-semi', ';SELECT 1'],
  ['recursive-cte-bomb', 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c'],
  ['cmt-block-mid-then-drop', 'SELECT 1 /* x */ ; DROP TABLE note'],
  ['tab-separated-drop', 'DROP\tTABLE\tnote'],
  ['newline-split-drop', 'DROP\nTABLE\nnote'],
  ['crlf-split-drop', 'DROP\r\nTABLE note'],
  ['many-semis', 'SELECT 1;;;;'],
  ['trailing-semi-then-ws-then-semi', 'SELECT 1;   ;'],
  ['dq-string-double-quote-off', 'SELECT 1 WHERE "a" = "a"'],
  ['u0085-nel-drop', '\u0085DROP TABLE note'],
  ['u2007-figurespace-drop', '\u2007DROP TABLE note'],
  ['nested-comment-hides-select', '/* a /* b */ SELECT 1'],
  ['comment-in-string-then-semi', "SELECT '/*' ; DROP TABLE note"],
];

const MUST_ALLOW = [
  ['lit-drop', "SELECT 'DROP TABLE note'"],
  ['lit-insert', "SELECT 'INSERT INTO note VALUES(1)'"],
  ['lit-attach', "SELECT 'ATTACH DATABASE x AS y'"],
  ['lit-pragma', "SELECT 'PRAGMA query_only=0'"],
  ['lit-readfile', "SELECT 'readfile'"],
  ['lit-load-extension', "SELECT 'load_extension'"],
  ['escaped-quote', "SELECT 'it''s fine'"],
  ['escaped-quote-drop', "SELECT 'it''s a DROP TABLE'"],
  ['lit-semicolon', "SELECT 'a;b'"],
  ['lit-semicolon-drop', "SELECT 'a; DROP TABLE note'"],
  ['lit-dashdash', "SELECT 'a--b'"],
  ['lit-blockcomment-open', "SELECT 'a/*b'"],
  ['lit-quote-only', "SELECT ''''"],
  ['concat-drop', "SELECT 'DROP' || ' TABLE'"],
  ['ident-created', 'SELECT created FROM v_note LIMIT 1'],
  ['ident-update-count', 'SELECT 1 AS update_count'],
  ['ident-update-count-col', 'SELECT update_count FROM (SELECT 1 AS update_count)'],
  ['ident-created-alias', 'SELECT 1 AS created'],
  ['ident-q-updates', 'SELECT q_updates FROM v_note LIMIT 1'],
  ['ident-access-count', 'SELECT access_count, created FROM v_note LIMIT 1'],
  ['ident-deleted-at', 'SELECT 1 AS deleted_at'],
  ['ident-insertion', 'SELECT 1 AS insertion_order'],
  ['ident-dropoff', 'SELECT 1 AS dropoff_rate'],
  ['ident-vacuumed', 'SELECT 1 AS vacuumed'],
  ['ident-begin-date', 'SELECT 1 AS begin_date'],
  ['dq-ident-drop', 'SELECT "drop" FROM (SELECT 1 AS "drop")'],
  ['bracket-ident-delete', 'SELECT [delete] FROM (SELECT 1 AS [delete])'],
  ['backtick-ident-insert', 'SELECT `insert` FROM (SELECT 1 AS `insert`)'],
  ['dq-ident-create-table', 'SELECT 1 AS "create table"'],
  ['cmt-line-before-select', '-- note\nSELECT 1'],
  ['cmt-block-before-select', '/* note */ SELECT 1'],
  ['cmt-trailing', 'SELECT 1 -- trailing'],
  ['cmt-trailing-block', 'SELECT 1 /* trailing */'],
  ['with-select', 'WITH x AS (SELECT 1 AS a) SELECT a FROM x'],
  ['with-recursive-bounded', 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 5) SELECT count(*) FROM c'],
  ['values-stmt', 'VALUES (1),(2)'],
  ['explain-select', 'SELECT 1'],
  ['explain-qp-select', 'EXPLAIN QUERY PLAN SELECT * FROM v_note'],
  ['explain-plain-select', 'EXPLAIN SELECT 1'],
  ['union-internal', 'SELECT name FROM sqlite_master UNION SELECT 1'],
  ['view-note', 'SELECT slug, title, created, access_count FROM v_note ORDER BY slug'],
  ['pragma-func', "SELECT name FROM pragma_table_info('v_note')"],
  ['cmt-explanatory-inline', 'SELECT 1 -- we never insert here'],
  ['cmt-explanatory-block', '/* do not delete this query */ SELECT 1'],
  ['cmt-block-mid-keyword-word', 'SELECT /* update the cache */ 1'],
  ['dq-ident-insert-into', 'SELECT * FROM (SELECT 1) AS "insert into"'],
  ['where-lit-drop', "SELECT 1 WHERE 'drop' = 'drop'"],
  ['lit-unicode', "SELECT '\u00e9\u4f60\u597d\ud83d\ude80 DROP'"],
  ['like-pattern-drop', "SELECT slug FROM v_note WHERE title LIKE '%drop%'"],
  ['glob-semicolon', "SELECT 1 WHERE 'a;b' GLOB '*;*'"],
  ['blob-literal', "SELECT x'00ff'"],
  ['ident-truncate-col', 'SELECT 1 AS truncated'],
  ['ident-alter-ego', 'SELECT 1 AS alter_ego'],
  ['ident-attachment', 'SELECT 1 AS attachment_id'],
  ['ident-replaces', 'SELECT 1 AS replaces'],
  ['ident-beginning', 'SELECT 1 AS beginning'],
  ['ident-commits', 'SELECT 1 AS commits'],
  ['ident-analyzed', 'SELECT 1 AS analyzed'],
  ['ident-reindexed', 'SELECT 1 AS reindexed'],
  ['ident-savepoints', 'SELECT 1 AS savepoints'],
  ['ident-detached', 'SELECT 1 AS detached'],
  ['ident-pragmatic', 'SELECT 1 AS pragmatic'],
  ['ident-readfiles', 'SELECT 1 AS readfiles'],
  ['ident-loaded', 'SELECT 1 AS load_extensions_count'],
];

const COUNTS = [
  ['trailing-semi', 'SELECT 1;'],
  ['trailing-semi-space', 'SELECT 1; '],
  ['trailing-semi-ws', 'SELECT 1;\n\t  \r\n'],
  ['double-semi', 'SELECT 1;;'],
  ['double-semi-spaced', 'SELECT 1; ;'],
  ['two-statements', 'SELECT 1; SELECT 2'],
  ['two-statements-semi', 'SELECT 1; SELECT 2;'],
  ['semi-in-string', "SELECT 'a;b' AS v"],
  ['semi-in-string-then-semi', "SELECT 'a;b';"],
  ['semi-in-dq-ident', 'SELECT 1 AS "a;b"'],
  ['semi-in-comment', 'SELECT 1 /* ; */'],
  ['semi-in-line-comment', 'SELECT 1 -- ;'],
  ['semi-then-comment', 'SELECT 1; -- done'],
  ['semi-then-block-comment', 'SELECT 1; /* done */'],
];

async function groupReject() {
  for (const [id, sql] of REJECTED_STATEMENTS) await probe('reject/' + id, 'reject', sql);
}
async function groupEvade() {
  for (const [id, sql] of EVASIONS) {
    await probe('evade/' + id, 'reject', sql, { sqlLabel: JSON.stringify(sql) });
  }
}
async function groupAllow() {
  for (const [id, sql] of MUST_ALLOW) await probe('allow/' + id, 'allow', sql);
}
async function groupCount() {
  for (const [id, sql] of COUNTS) await probe('count/' + id, '?', sql);
}

async function groupLength() {
  // `SELECT 'aaa…'` — total byte length controlled exactly.
  const mk = (n) => {
    const head = "SELECT '", tail = "'";
    return head + 'a'.repeat(n - head.length - tail.length) + tail;
  };
  for (const n of [16000, 16383, 16384, 16385, 16400, 20000]) {
    const sql = mk(n);
    await probe(`length/bytes-${n}`, n <= 16384 ? 'allow' : 'reject', sql,
      { sqlLabel: `SELECT '<${n - 9} a>'  (total ${n} bytes)` });
  }
  // far over, via stdin (argv length limits on win32)
  const big = mk(200000);
  await probe('length/bytes-200000-stdin', 'reject', big, {
    argv: ['sql', '--stdin'], stdin: big,
    sqlLabel: 'SELECT \'<199991 a>\' (200000 bytes, via --stdin)',
  });
  // far over comments only
  const cmt = '/*' + 'x'.repeat(40000) + '*/ SELECT 1';
  await probe('length/comment-pad-40k-stdin', 'reject', cmt, {
    argv: ['sql', '--stdin'], stdin: cmt, sqlLabel: '/* 40000 x */ SELECT 1 (stdin)',
  });
}

const FILE_ATTACKS = [
  ['readfile', "SELECT readfile('C:/Users/aayoa/Desktop/ori/package.json')"],
  ['readfile-upper', "SELECT READFILE('C:/Users/aayoa/Desktop/ori/package.json')"],
  ['readfile-quoted', `SELECT "readfile"('C:/Users/aayoa/Desktop/ori/package.json')`],
  ['readfile-spaced', "SELECT readfile ('C:/Users/aayoa/Desktop/ori/package.json')"],
  ['readfile-in-cte', "WITH x AS (SELECT readfile('C:/Users/aayoa/Desktop/ori/package.json') AS b) SELECT b FROM x"],
  ['writefile', "SELECT writefile('pwned-by-sql.txt', 'owned')"],
  ['writefile-abs', "SELECT writefile('C:/Users/aayoa/AppData/Local/Temp/ori-falsify-safety/pwned-abs.txt','owned')"],
  ['load_extension', "SELECT load_extension('C:/Windows/System32/kernel32.dll')"],
  ['load_extension-upper', "SELECT LOAD_EXTENSION('foo')"],
  ['load_extension-comment', "SELECT load_extension/**/('foo')"],
  ['edit-fn', "SELECT edit('x')"],
  ['fsdir', "SELECT * FROM fsdir('C:/Users/aayoa/Desktop/ori')"],
  ['zipfile', "SELECT * FROM zipfile('C:/Users/aayoa/Desktop/ori/package.json')"],
  ['pragma-database-list', 'SELECT * FROM pragma_database_list'],
  ['attach-in-select', "SELECT 1 FROM (ATTACH DATABASE 'x.db' AS y)"],
  ['attach-after-select', "SELECT 1; ATTACH DATABASE 'x.db' AS y"],
  ['attach-in-cte', "WITH x AS (SELECT 1) ATTACH DATABASE 'x.db' AS y"],
  ['dbstat', 'SELECT * FROM dbstat LIMIT 1'],
  ['sqlite-dbpage', 'SELECT * FROM sqlite_dbpage LIMIT 1'],
  ['sqlite-master-write', "SELECT 1 FROM sqlite_master WHERE name='note'"],
  ['temp-db-write', "SELECT 1 WHERE (SELECT count(*) FROM sqlite_temp_master) = 0"],
];

async function groupFiles() {
  for (const [id, sql] of FILE_ATTACKS) await probe('files/' + id, 'reject-or-error', sql);
}

const GROUPS = {
  reject: groupReject, evade: groupEvade, allow: groupAllow,
  count: groupCount, length: groupLength, files: groupFiles,
};

const toRun = group === 'all' ? Object.keys(GROUPS) : [group];
for (const g of toRun) {
  if (!GROUPS[g]) { console.error('unknown group ' + g); process.exit(2); }
  await GROUPS[g]();
}
writeFileSync(
  `C:/Users/aayoa/Desktop/ori/ops-falsify/raw-${group}.json`,
  JSON.stringify(results, null, 2),
);
console.error(`\n[probe] ${results.length} probes in group '${group}' -> raw-${group}.json`);
