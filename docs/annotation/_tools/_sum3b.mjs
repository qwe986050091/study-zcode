import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = 'D:/code/ZCode';
const dir = 'D:/code/_annot_baseline/ZC-deep-svc-b3b';
const files = fs.readFileSync(path.join(dir, '_files.txt'), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
let total = 0;
for (const rel of files) {
  const base = path.join(dir, 'orig', rel);
  const cur = path.join(repo, rel);
  const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '--numstat', '--', base, cur], { encoding: 'utf8' });
  const l = (r.stdout || '').trim().split(/\r?\n/).pop() || '';
  const [add, del] = l.split('\t');
  total += Number(add || 0);
  console.log(`${add}\t${del}\t${rel}`);
}
console.log('TOTAL_ADD=' + total);
