// 建第 4 批基线：镜像复制 crossbeam-utils / crossbeam-skiplist / 顶层 src/lib.rs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\crossbeam';
const OUT = 'd:\\code\\_annot_baseline\\CB-crossbeam-b4';

const files = [];
function walk(rel) {
  const abs = path.join(ROOT, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(abs).sort()) walk(rel + '/' + e);
  } else if (rel.endsWith('.rs')) {
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.split(/\r?\n/).length;
    // 1 行占位（符号链接在 Windows 检出为一行路径文本）不纳入清单
    if (lines <= 1 && rel.endsWith('alloc_helper.rs')) return;
    files.push({ rel, lines });
  }
}
walk('crossbeam-utils/src');
walk('crossbeam-utils/build.rs');
walk('crossbeam-skiplist/src');
walk('src/lib.rs');
files.push({ rel: 'crossbeam-utils/build.rs', lines: fs.readFileSync(path.join(ROOT, 'crossbeam-utils/build.rs'), 'utf8').split(/\r?\n/).length });

const uniq = new Map();
for (const f of files) uniq.set(f.rel, f.lines);
const list = [...uniq.entries()].sort((a, b) => a[0].localeCompare(b[0]));

fs.mkdirSync(OUT, { recursive: true });
let total = 0;
for (const [rel, lines] of list) {
  const dst = path.join(OUT, rel.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel.split('/').join(path.sep)), dst);
  total += lines;
}
fs.writeFileSync(path.join(OUT, '_files.txt'), '\ufeff' + list.map(([r, n]) => `${r}\t${n}`).join('\r\n') + '\r\n');
console.log(`files=${list.length} lines=${total}`);
