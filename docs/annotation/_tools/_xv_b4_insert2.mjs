// 第 4 批注释插入器（内容锚点版）
// spec = {files: {路径: [{anchor: "函数签名行（trim 后全等）", lines: ["// ..."]}, ...]}}
// 语义：找到 anchor 行，向上跨过返回类型行（void/int/static void/...）与紧邻的注释块，
// 把 lines 插到这一整段（含已有注释）之前；anchor 必须唯一。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\xv6-riscv';
const specPath = process.argv[2];
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

const DECLS = new Set(['void', 'int', 'static', 'static void', 'char', 'uint64', 'uint']);
let total = 0;
for (const [rel, blocks] of Object.entries(spec.files)) {
  const p = path.join(ROOT, rel.split('/').join(path.sep));
  let raw = fs.readFileSync(p, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let lines = raw.split(eol);

  for (const b of blocks) {
    const hits = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].trim() === b.anchor) hits.push(i);
    if (hits.length !== 1) {
      throw new Error(`${rel}: anchor "${b.anchor}" matched ${hits.length} times`);
    }
    let j = hits[0];
    while (j > 0) {
      const prev = lines[j - 1].trim();
      if (DECLS.has(prev) || prev.startsWith('//') || prev.startsWith('/*') || prev.startsWith('*')) {
        j--;
        continue;
      }
      break;
    }
    for (const t of b.lines) {
      if (!t.trimStart().startsWith('//')) throw new Error(`${rel}: not a // comment: ${t}`);
      if (t.includes('*/')) throw new Error(`${rel}: contains */`);
    }
    lines.splice(j, 0, ...b.lines);
    total += b.lines.length;
  }
  fs.writeFileSync(p, lines.join(eol), 'utf8');
  console.log(`${rel}\t+${blocks.reduce((n, b) => n + b.lines.length, 0)}`);
}
console.log('inserted=' + total);
