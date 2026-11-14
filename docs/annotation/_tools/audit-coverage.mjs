import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const REPO = 'd:/code/opensource/gemini-cli';
const BASE = 'd:/code/_annot_baseline';

const dirs = fs
  .readdirSync(BASE)
  .filter((d) => /^GC-deep-b\d+$/.test(d))
  .sort((a, b) => Number(a.split('b')[1]) - Number(b.split('b')[1]));

const covered = new Set();
for (const d of dirs) {
  const f = path.join(BASE, d, '_files.txt');
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const p = line.split('\t')[0].trim();
    if (p) covered.add(p);
  }
}

const out = execSync('git -C "' + REPO + '" status --porcelain', { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
const changed = out
  .split('\n')
  .filter((l) => l.length > 3)
  .map((l) => l.slice(3).trim().replace(/^"|"$/g, ''));

const extras = changed.filter((p) => !covered.has(p));
const missing = [...covered].filter((p) => !changed.includes(p));

console.log('batchDirs=' + dirs.length + ' covered=' + covered.size + ' changed=' + changed.length);
console.log('changedNotInBatch=' + extras.length);
extras.slice(0, 60).forEach((p) => console.log('EXTRA ' + p));
console.log('batchNotChanged=' + missing.length);
missing.slice(0, 60).forEach((p) => console.log('MISS  ' + p));
