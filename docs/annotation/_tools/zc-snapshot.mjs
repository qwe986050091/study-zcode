// 批次基线快照：node zc-snapshot.mjs ZC-deep-b1 <files.txt>
// 把清单里的文件按相对路径复制到 d:\code\_annot_baseline\<批次>\orig\，并写 _files.txt。
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
const batch = process.argv[2];
const listPath = process.argv[3];
if (!batch || !listPath) {
  console.error('usage: node zc-snapshot.mjs <batchName> <files.txt>');
  process.exit(2);
}
const files = fs.readFileSync(listPath, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const dir = path.join('D:/code/_annot_baseline', batch);
let copied = 0;
const missing = [];
for (const rel of files) {
  const src = path.join(repo, rel);
  if (!fs.existsSync(src)) { missing.push(rel); continue; }
  const dst = path.join(dir, 'orig', rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  copied++;
}
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, '_files.txt'), files.join('\n') + '\n', 'utf8');
console.log(`snapshot ${batch}: copied=${copied} missing=${missing.length}`);
for (const m of missing) console.error('MISSING: ' + m);
if (missing.length) process.exit(1);
