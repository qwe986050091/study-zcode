// 通用快照：node _svc-snapshot.mjs <批次名> <相对路径清单.txt>
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
const base = 'D:/code/_annot_baseline';
const batch = process.argv[2];
const listFile = process.argv[3];
const rels = fs.readFileSync(listFile, 'utf8').split(/\r?\n/).filter(Boolean);
const origDir = path.join(base, batch, 'orig');
for (const rel of rels) {
  const dst = path.join(origDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(repo, rel), dst);
}
fs.writeFileSync(path.join(base, batch, '_files.txt'), rels.join('\n') + '\n', 'utf8');
console.log('snapshot files=' + rels.length);
