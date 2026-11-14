// 只读盘点：按顶层目录统计 TS/TSX 文件数与代码行，供 ZCode 深注范围划分使用。
import fs from 'node:fs';
import path from 'node:path';

const repo = 'd:/code/ZCode';
const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.turbo', '.tmp', 'out', 'coverage']);
const exts = ['.ts', '.tsx'];

const rows = new Map(); // topLevel -> {files, lines}
function walk(dir, topRel) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (skipDirs.has(ent.name)) continue;
      walk(p, topRel);
    } else if (ent.isFile() && exts.some((e) => ent.name.endsWith(e))) {
      const rel = path.relative(repo, p).replace(/\\/g, '/');
      const top = topRel || rel.split('/')[0];
      const text = fs.readFileSync(p, 'utf8');
      const lines = text.split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      const cur = rows.get(top) || { files: 0, lines: 0 };
      cur.files++;
      cur.lines += lines.length;
      rows.set(top, cur);
    }
  }
}
walk(repo, '');
const out = [...rows.entries()].sort((a, b) => b[1].files - a[1].files);
for (const [k, v] of out) console.log(`${v.files}\t${v.lines}\t${k}`);
console.log('TOTAL\t' + out.reduce((n, x) => n + x[1].files, 0) + '\t' + out.reduce((n, x) => n + x[1].lines, 0));
