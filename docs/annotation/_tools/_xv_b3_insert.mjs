// 第 3 批注释插入器：spec = {files: {路径: [{at: 行号, lines: ["// ...", ...]}, ...]}}
// 语义：把整个 lines 块按给定顺序插到原文第 at 行之前（at = 原文件行号，1 起）。
// 从后往前处理块，保证前面的行号不受已插入内容影响；只允许 // 注释行。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\xv6-riscv';
const specPath = process.argv[2];
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

let total = 0;
for (const [rel, blocks] of Object.entries(spec.files)) {
  const p = path.join(ROOT, rel.split('/').join(path.sep));
  const raw = fs.readFileSync(p, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(eol);
  const sorted = [...blocks].sort((a, b) => b.at - a.at);
  for (const b of sorted) {
    if (!Number.isInteger(b.at) || b.at < 1 || b.at > lines.length + 1) {
      throw new Error(`${rel}: bad line ${b.at}`);
    }
    for (const t of b.lines) {
      if (!t.trimStart().startsWith('//')) throw new Error(`${rel}:${b.at} not a // comment: ${t}`);
      if (t.includes('*/')) throw new Error(`${rel}:${b.at} contains */`);
    }
    lines.splice(b.at - 1, 0, ...b.lines);
    total += b.lines.length;
  }
  fs.writeFileSync(p, lines.join(eol), 'utf8');
  console.log(`${rel}\t+${blocks.reduce((n, b) => n + b.lines.length, 0)}`);
}
console.log('inserted=' + total);
