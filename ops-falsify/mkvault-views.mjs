// Build a scratch vault with a precisely-known wiki-link graph.
// Usage: node mkvault-views.mjs <dir>
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('need dir');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
fs.mkdirSync(path.join(dir, '.ori'), { recursive: true });
fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true });

// slug -> { title, links[] }
const graph = {
  alpha:   { links: ['beta', 'gamma'] },
  beta:    { links: ['gamma'] },
  gamma:   { links: [] },
  delta:   { links: ['alpha', 'nonexistent-target'] },
  epsilon: { links: ['nonexistent-target'] },
  zeta:    { links: ['alpha'] },
  eta:     { links: ['theta'] },
  theta:   { links: ['eta'] },
  iota:    { links: [] },
  kappa:   { links: ['alpha', 'beta', 'gamma', 'delta'] },
};

const types = ['idea', 'decision', 'learning', 'insight', 'blocker', 'opportunity'];
let i = 0;
for (const [slug, spec] of Object.entries(graph)) {
  const type = types[i % types.length];
  i += 1;
  const body = [
    '---',
    `description: probe note ${slug} carrying ${spec.links.length} outgoing wiki links for graph verification`,
    `type: ${type}`,
    'project: [meta]',
    'status: active',
    'created: 2026-09-19',
    '---',
    '',
    `# ${slug}`,
    '',
    `This note argues that ${slug} exists purely to pin down link counts.`,
    '',
    ...(spec.links.length
      ? ['Relevant Notes:', ...spec.links.map((l) => `- [[${l}]] -- probe edge`)]
      : ['No outgoing links.']),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'notes', `${slug}.md`), body, 'utf8');
}
console.log('vault built at', dir);
