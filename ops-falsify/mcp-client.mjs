// Minimal MCP stdio client: list tools, optionally call one.
// Usage: node mcp-client.mjs <vaultDir> [toolName] [jsonArgs]
import { spawn } from 'node:child_process';

const vault = process.argv[2];
const toolName = process.argv[3];
const toolArgs = process.argv[4] ? JSON.parse(process.argv[4]) : {};

const child = spawn(process.execPath, ['C:/Users/aayoa/Desktop/ori/dist/index.js', 'serve', '--mcp'], {
  cwd: vault, stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.log('NONJSON: ' + line.slice(0, 200)); continue; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[stderr] ' + d));

let idc = 0;
function rpc(method, params) {
  const id = ++idc;
  return new Promise((res, rej) => {
    pending.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => rej(new Error('timeout ' + method)), 60000);
  });
}

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'falsify', version: '0' },
});
console.log('INIT ok:', JSON.stringify(init.result?.serverInfo ?? init.error));
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const tools = await rpc('tools/list', {});
const names = (tools.result?.tools ?? []).map((t) => t.name);
console.log('TOOLS: ' + names.join(', '));

if (toolName) {
  const r = await rpc('tools/call', { name: toolName, arguments: toolArgs });
  const txt = JSON.stringify(r.result ?? r.error);
  console.log('CALL ' + toolName + ' -> ' + txt.slice(0, 3000));
}
child.kill();
process.exit(0);
