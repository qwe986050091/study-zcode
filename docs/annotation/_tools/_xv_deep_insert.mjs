// 深度注释插入器（内容锚点，支持 decl / exact 两种落点）
// spec = { files: { 相对路径: [ {anchor, mode?, after?, lines:[...]}, ... ] } }
//   mode="decl"  （默认）向上跨过返回类型行与紧邻注释块，插到整段之前
//   mode="exact" 紧贴在 anchor 行之前插入（用于函数体内部的锚点）
//   after=true   插在 anchor 行之后
// 换行处理：只在 '\n' 上切分，元素保留行尾 '\r'，写回时用 '\n' 连接，
// 因此原有每一行的字节完全不变；新增行沿用锚点行的行尾风格。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\xv6-riscv';
const specPath = process.argv[2];
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const DECLS = new Set(['void', 'int', 'static', 'static void', 'char', 'uint64', 'uint']);

let total = 0;
for (const [rel, blocks] of Object.entries(spec.files)) {
  const p = path.join(ROOT, rel.split('/').join(path.sep));
  const raw = fs.readFileSync(p, 'utf8');
  const lines = raw.split('\n');
  let added = 0;
  for (const b of blocks) {
    const hits = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].trim().startsWith(b.anchor)) hits.push(i);
    if (hits.length !== 1) throw new Error(`${rel}: anchor "${b.anchor}" matched ${hits.length}`);
    let j = hits[0];
    const cr = lines[hits[0]].endsWith('\r') ? '\r' : '';
    for (const t of b.lines) {
      if (!t.trimStart().startsWith('//')) throw new Error(`${rel}: not //: ${t}`);
      if (t.includes('*/')) throw new Error(`${rel}: contains */`);
    }
    const payload = b.lines.map((t) => t + cr);
    if (b.mode === 'exact') {
      if (b.after) j += 1;
    } else {
      while (j > 0) {
        const prev = lines[j - 1].trim();
        if (DECLS.has(prev) || prev.startsWith('//') || prev.startsWith('/*') || prev.startsWith('*')) {
          j--;
          continue;
        }
        break;
      }
    }
    lines.splice(j, 0, ...payload);
    added += payload.length;
  }
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  total += added;
  console.log(`${rel}\t+${added}`);
}
console.log('inserted=' + total);
