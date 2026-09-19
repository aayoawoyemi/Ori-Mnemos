#!/usr/bin/env node
// Out-of-band fixture setup for schema-discovery and cell-limit probes.
// Adds, directly via better-sqlite3 (NOT via `ori sql`):
//   - v_broken_count : a view whose row count cannot be determined
//   - zz_auto        : AUTOINCREMENT table -> forces sqlite_sequence to exist
//   - ANALYZE        -> forces sqlite_stat1 to exist
//   - zz_values      : real stored BIGINT / long-multibyte-text / NULL rows
// Usage: node mutate-db.mjs <vaultDir>
import Database from 'file:///C:/Users/aayoa/Desktop/ori/node_modules/better-sqlite3/lib/index.js';
import path from 'node:path';

const vault = process.argv[2];
const db = new Database(path.join(vault, '.ori', 'embeddings.db'));
db.exec('DROP VIEW IF EXISTS v_broken_count');
db.exec('CREATE VIEW v_broken_count AS SELECT * FROM no_such_table_zz');
db.exec('DROP TABLE IF EXISTS zz_auto');
db.exec('CREATE TABLE zz_auto(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
db.exec("INSERT INTO zz_auto(v) VALUES ('a'),('b')");
db.exec('DROP TABLE IF EXISTS zz_values');
db.exec('CREATE TABLE zz_values(label TEXT, big INTEGER, txt TEXT, nul TEXT, blb BLOB)');
const ins = db.prepare('INSERT INTO zz_values VALUES (?,?,?,?,?)');
ins.run('maxint', 9223372036854775807n, 'short', null, Buffer.alloc(8));
ins.run('unsafe+2', 9007199254740993n, '日'.repeat(4000), null, Buffer.alloc(1536));
ins.run('small', 42n, 'x'.repeat(4096), null, null);
ins.run('negmax', -9223372036854775808n, 'y'.repeat(4097), null, null);
db.exec('ANALYZE');
console.log(JSON.stringify(db.prepare("SELECT name, type FROM sqlite_master WHERE name LIKE 'sqlite_%' OR name LIKE 'zz_%' OR name = 'v_broken_count'").all()));
db.close();
