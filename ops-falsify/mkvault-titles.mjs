// Vault stressing titles (unicode / quotes / long), case-folding, aliases, and mass dangling citation.
// Usage: node mkvault-titles.mjs <dir>
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('need dir');
fs.rmSync(dir, { recursive: true, force: true });
const notes = path.join(dir, 'notes');
fs.mkdirSync(notes, { recursive: true });
fs.mkdirSync(path.join(dir, '.ori'), { recursive: true });

const LONGDESC = 'D'.repeat(5200);
const LONGNAME = 'long-' + 'n'.repeat(200);

function mk(slug, links, description) {
  const body = [
    '---',
    `description: ${description ?? `title-stress probe ${slug}`}`,
    'type: learning',
    'project: [meta]',
    'status: active',
    'created: 2026-09-19',
    '---',
    '',
    `This note argues that ${slug} stresses title handling.`,
    '',
    ...(links.length ? ['Relevant Notes:', ...links.map((l) => `- [[${l}]] -- edge`)] : ['none']),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(notes, `${slug}.md`), body, 'utf8');
}

// plain anchor note
mk('anchor', []);
// unicode filename
mk('na\u00efve-\u65e5\u672c\u8a9e-caf\u00e9-\u{1f9e0}', ['anchor']);
// apostrophe in filename
mk("it's-a-quote", ['anchor']);
// punctuation soup (legal on NTFS)
mk('semi;colon,comma (paren) [bracket] & amp', ['anchor']);
// spaces
mk('spaced out name', ['anchor']);
// very long filename
mk(LONGNAME, ['anchor']);
// very long description
mk('longdesc', ['anchor'], LONGDESC);
// case-differing link target: file is `anchor.md`, link says `Anchor`
mk('casesrc', ['Anchor', 'ANCHOR']);
// obsidian alias syntax
mk('aliassrc', ['anchor|the anchor note', 'ghost-alias|a ghost']);
// heading link + block ref
mk('fragsrc', ['anchor#some-heading', 'ghost-frag#h']);
// mass dangling citation: 25 notes all pointing at one missing target
for (let i = 1; i <= 25; i += 1) mk(`citer-${String(i).padStart(2, '0')}`, ['mass-ghost']);

console.log('titles vault built at', dir, 'files=', fs.readdirSync(notes).length);
