// 通用基线生成：node mkbase.mjs <批次名> <相对路径> [<相对路径> ...]
// 用 git show HEAD:<rel> 写出批次基线快照，并生成 _files.txt 清单。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = 'd:\\code\\opensource\\uv';
const batch = process.argv[2];
const rels = process.argv.slice(3);
if (!batch || rels.length === 0) {
  console.error('usage: node mkbase.mjs <batch> <rel> [<rel> ...]');
  process.exit(2);
}
const out = path.join('d:\\code\\_annot_baseline', batch);
for (const rel of rels) {
  const buf = execFileSync('git', ['-C', repo, 'show', `HEAD:${rel}`], { maxBuffer: 64 * 1024 * 1024 });
  const dest = path.join(out, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log('baseline written', dest, buf.length);
}
fs.writeFileSync(path.join(out, '_files.txt'), rels.join('\n') + '\n');
