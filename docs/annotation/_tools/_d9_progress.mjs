import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = 'd:\\code\\claude-code-main';
const BASE = 'd:\\code\\_annot_baseline\\CC-L2-D9-Ink渲染器-1';
const rels = fs.readFileSync(path.join(BASE, '_files.txt'), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
let done = 0, undone = 0;
for (const rel of rels) {
  const b = path.join(BASE, rel), c = path.join(ROOT, rel);
  const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '--numstat', '--', b, c], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  let a = 0, d = 0;
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const m = /^([\d-]+)\t([\d-]+)\t/.exec(line);
    if (!m) continue;
    a += m[1] === '-' ? 0 : Number(m[1]);
    d += m[2] === '-' ? 0 : Number(m[2]);
  }
  if (a === 0) undone++; else done++;
  console.log(`${a}\t${d}\t${rel}`);
}
console.log(`DONE=${done} UNDONE=${undone} TOTAL=${rels.length}`);
