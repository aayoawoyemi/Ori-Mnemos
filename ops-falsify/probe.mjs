// Run a list of SQL probes against a vault and print compact results.
// Usage: node probe.mjs <vaultDir> <probesJsonFile|-> 
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const CLI = 'C:/Users/aayoa/Desktop/ori/dist/index.js';
const vault = process.argv[2];
const src = process.argv[3];
const probes = JSON.parse(src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8'));

export function run(vaultDir, sql, extra = []) {
  try {
    const out = execFileSync(process.execPath, [CLI, 'sql', sql, ...extra], {
      cwd: vaultDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    });
    return { exit: 0, json: safeParse(out), raw: out };
  } catch (e) {
    return { exit: e.status, json: safeParse(e.stdout || ''), raw: (e.stdout || '') + (e.stderr || '') };
  }
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

for (const p of probes) {
  const label = typeof p === 'string' ? p : p.label;
  const sql = typeof p === 'string' ? p : p.sql;
  const extra = (typeof p === 'object' && p.extra) || [];
  const r = run(vault, sql, extra);
  console.log('### ' + label);
  console.log('SQL: ' + sql);
  console.log('EXIT ' + r.exit);
  if (!r.json) { console.log('RAW: ' + r.raw.slice(0, 2000)); }
  else {
    const d = r.json.data || {};
    console.log('ok=' + r.json.success + ' warnings=' + JSON.stringify(r.json.warnings));
    if (d.columns) console.log('cols=' + JSON.stringify(d.columns));
    if (d.rows) for (const row of d.rows) console.log('  ' + JSON.stringify(row));
  }
  console.log('');
}
