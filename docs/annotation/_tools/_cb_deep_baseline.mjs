// 建深注基线：镜像 6 个 crate 的 src 与顶层 src
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\crossbeam';
const OUT = 'd:\\code\\_annot_baseline\\CB-crossbeam-deep';

const roots = [
  'src',
  'crossbeam-epoch/src',
  'crossbeam-deque/src',
  'crossbeam-queue/src',
  'crossbeam-channel/src',
  'crossbeam-utils/src',
  'crossbeam-skiplist/src',
];

let n = 0;
const manifest = [];
function copy(rel) {
  const abs = path.join(ROOT, rel);
  const dst = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(abs, dst);
  manifest.push(rel);
  n++;
}
function walk(rel) {
  for (const ent of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = rel + '/' + ent.name;
    if (ent.isDirectory()) walk(child);
    else if (ent.name.endsWith('.rs')) copy(child);
  }
}
for (const r of roots) walk(r);
fs.writeFileSync(path.join(OUT, '_files.txt'), '\ufeff' + manifest.join('\r\n') + '\r\n');
console.log(`files=${n}`);
