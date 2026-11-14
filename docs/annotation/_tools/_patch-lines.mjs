// 逐行替换 54 个水句（1→1，不改行数、不碰代码行）。
import fs from 'node:fs';

const target = process.argv[2];
const patches = JSON.parse(fs.readFileSync(process.argv[3], 'utf8').replace(/^\uFEFF/, ''));
const lines = fs.readFileSync(target, 'utf8').split('\n');

for (const p of patches) {
  const i = p.line - 1;
  const cur = lines[i];
  const indent = (cur.match(/^[ \t]*/) || [''])[0];
  if (!cur.trimStart().startsWith('//')) throw new Error(`line ${p.line} 不是注释行: ${cur}`);
  if (p.expect && !cur.includes(p.expect)) throw new Error(`line ${p.line} 未命中 expect=${p.expect}: ${cur}`);
  lines[i] = indent + p.text;
}
fs.writeFileSync(target, lines.join('\n'), 'utf8');
console.log(`patched ${patches.length} lines`);
