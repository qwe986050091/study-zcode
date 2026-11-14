// 批次基线快照：node dz-snapshot.mjs <batchName> <relPath...>
// 把待改文件按相对路径复制到 d:\code\_annot_baseline\<batchName>\orig\，并写 _files.txt
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/opensource/drizzle-orm';
const [batch, ...rels] = process.argv.slice(2);
if (!batch || !rels.length) {
  console.error('usage: node dz-snapshot.mjs <batchName> <relPath...>');
  process.exit(2);
}
const dir = path.join('D:/code/_annot_baseline', batch);
fs.mkdirSync(path.join(dir, 'orig'), { recursive: true });
for (const rel of rels) {
  const src = path.join(repo, rel);
  if (!fs.existsSync(src)) {
    console.error('FAIL: missing ' + src);
    process.exit(1);
  }
  const dst = path.join(dir, 'orig', rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
fs.writeFileSync(path.join(dir, '_files.txt'), rels.join('\n') + '\n');
console.log(`snapshot ${batch}: ${rels.length} files -> ${dir}`);
