// 把 _uvr_insert 规格里每个插入点整体平移 delta 行，并按新行号重新取 anchor。
// 用法：node shift-spec.mjs <specIn> <specOut> <delta>
// 典型用途：pick 命中 fn 行，但注释要插在其上方的 #[test] 属性之前，此时 delta=-1。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\uv';
const inPath = process.argv[2];
const outPath = process.argv[3];
const delta = Number(process.argv[4]);

const spec = JSON.parse(fs.readFileSync(inPath, 'utf8'));
for (const entry of spec) {
  const target = path.isAbsolute(entry.file) ? entry.file : path.join(ROOT, entry.file);
  const lines = fs.readFileSync(target, 'utf8').split('\n');
  for (const item of entry.items) {
    const newLine = item.line + delta;
    if (newLine < 1 || newLine > lines.length) {
      console.error(`FAIL out of range: ${entry.file} ${item.line} -> ${newLine}`);
      process.exit(1);
    }
    item.line = newLine;
    item.anchor = lines[newLine - 1].replace(/\r$/, '');
  }
}
fs.writeFileSync(outPath, JSON.stringify(spec, null, 2));
console.log(`SPEC ${outPath} items=${spec.reduce((n, e) => n + e.items.length, 0)} delta=${delta}`);
