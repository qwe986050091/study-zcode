// vercel/ai 批次基线快照：把 _files.txt 里的文件复制到 <批次>/orig/<相对路径>。
// 用法：node ai-snapshot.mjs <批次名> <相对路径...>
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'D:/code/opensource/ai';
const batch = process.argv[2];
const rels = process.argv.slice(3).map((s) => s.replace(/\\/g, '/'));
if (!batch || !rels.length) {
  console.error('usage: node ai-snapshot.mjs <batchName> <relPath...>');
  process.exit(2);
}
const dir = path.join('D:/code/_annot_baseline', batch);
const orig = path.join(dir, 'orig');
fs.mkdirSync(orig, { recursive: true });
const list = [];
for (const rel of rels) {
  const src = path.join(REPO, rel);
  if (!fs.existsSync(src)) {
    console.error('FAIL: missing source ' + src);
    process.exit(1);
  }
  const dst = path.join(orig, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  list.push(rel);
  console.log('SNAP ' + rel);
}
fs.writeFileSync(path.join(dir, '_files.txt'), list.join('\n') + '\n', 'utf8');
console.log('SUMMARY files=' + list.length + ' dir=' + dir);
