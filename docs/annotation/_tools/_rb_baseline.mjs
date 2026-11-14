// 建立 RB-redb-b1 基线：镜像复制 + 生成 _files.txt（相对路径 + 行数，wc -l 口径）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\redb';
const OUT = 'd:\\code\\_annot_baseline\\RB-redb-b1';

const files = [
  'src/lib.rs',
  'src/db.rs',
  'src/error.rs',
  'src/transactions.rs',
  'src/transaction_tracker.rs',
  'src/table.rs',
  'src/multimap_table.rs',
  'src/sync.rs',
  'src/io.rs',
  'src/backends.rs',
  'src/sealed.rs',
];

function loc(p) {
  const t = fs.readFileSync(p, 'utf8');
  if (!t) return 0;
  return t.split('\n').length - (t.endsWith('\n') ? 1 : 0);
}

fs.mkdirSync(OUT, { recursive: true });
const rows = [];
for (const rel of files) {
  const src = path.join(ROOT, rel);
  const dst = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const buf = fs.readFileSync(src);
  fs.writeFileSync(dst, buf);
  rows.push(`${rel} ${loc(src)}`);
}
fs.writeFileSync(path.join(OUT, '_files.txt'), rows.join('\n') + '\n');
console.log(rows.join('\n'));
console.log('TOTAL files=' + rows.length + ' lines=' + rows.reduce((n, r) => n + Number(r.split(' ')[1]), 0));
