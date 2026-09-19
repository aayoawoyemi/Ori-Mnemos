// Run several ori_query_ranked calls inside ONE mcp session, to test v_session aggregates.
// Usage: node mcp-multi.mjs <vaultDir> <q1> <q2> ...
import { spawn } from 'node:child_process';

const vault = process.argv[2];
const queries = process.argv.slice(3);
const child = spawn(process.execPath, ['C:/Users/aayoa/Desktop/ori/dist/index.js', 'serve', '--mcp'], {
  cwd: vault, stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));
let idc = 0;
const rpc = (method, params) => new Promise((res, rej) => {
  const id = ++idc; pending.set(id, res);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => rej(new Error('timeout ' + method)), 60000);
});
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'f', version: '0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
for (const q of queries) {
  const r = await rpc('tools/call', { name: 'ori_query_ranked', arguments: { query: q, limit: 3 } });
  const t = r.result?.content?.[0]?.text ?? JSON.stringify(r.error);
  let n = '?';
  try { n = JSON.parse(t).data.results.length; } catch {}
  console.log(`query=${JSON.stringify(q)} results=${n}`);
}
child.kill();
process.exit(0);
