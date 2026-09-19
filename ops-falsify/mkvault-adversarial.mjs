// Adversarial-title / duplicate-edge vault.
// Usage: node mkvault-adversarial.mjs <dir>
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('need dir');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
fs.mkdirSync(path.join(dir, '.ori'), { recursive: true });

const LONG = 'L'.repeat(5200);
const notes = [
  // slug, H1 title, links[]
  ['hub', 'hub', ['dup-target', 'dup-target', 'ghost-x', 'ghost-x']],
  ['dup-target', 'dup-target', []],
  ['selfie', 'selfie', ['selfie']],
  ['pipey', 'a | b | c', ['ghost-x']],
  ['quotey', 'it\'s a "quoted" title with \'single\' quotes', ['dup-target']],
  ['unicodey', '\u65e5\u672c\u8a9e \u03c4\u03af\u03c4\u03bb\u03bf\u03c2 \u2014 \u00e9moji \u{1f9e0} \u2705 \u{1f468}\u200d\u{1f469}\u200d\u{1f467}', ['dup-target']],
  ['longy', LONG, ['dup-target']],
  ['sqlinj', "'; DROP TABLE note; --", ['dup-target']],
  ['newliney', 'tab\there and backslash \\ and percent %', []],
];

for (const [slug, title, links] of notes) {
  const body = [
    '---',
    `description: adversarial probe note ${slug} used to stress the v_note and v_dangling views`,
    'type: learning',
    'project: [meta]',
    'status: active',
    'created: 2026-09-19',
    '---',
    '',
    `# ${title}`,
    '',
    `This note argues that ${slug} stresses the view layer.`,
    '',
    ...(links.length ? ['Relevant Notes:', ...links.map((l) => `- [[${l}]] -- edge`)] : ['none']),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'notes', `${slug}.md`), body, 'utf8');
}
console.log('adversarial vault built at', dir, 'notes=', notes.length);
