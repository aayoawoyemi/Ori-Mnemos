// Simulate an "older install" view definition, then let `ori index build` try to refresh it.
// Usage: node --experimental-sqlite stale-view.mjs <vaultDir> <op>
//   op = stale   -> replace v_note with a 1-column legacy definition
//   op = show    -> print current DDL of v_note
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const vault = process.argv[2];
const op = process.argv[3] || 'show';
const db = new DatabaseSync(path.join(vault, '.ori', 'embeddings.db'));

if (op === 'stale') {
  db.exec('DROP VIEW IF EXISTS v_note');
  db.exec("CREATE VIEW v_note AS SELECT 'LEGACY' AS legacy_marker");
  db.exec('DROP VIEW IF EXISTS v_dangling');
}
const rows = db.prepare(
  "SELECT name, sql FROM sqlite_master WHERE type='view' ORDER BY name",
).all();
for (const r of rows) console.log(r.name + ' :: ' + String(r.sql).replace(/\s+/g, ' ').slice(0, 90));
console.log('view_count=' + rows.length);
db.close();
