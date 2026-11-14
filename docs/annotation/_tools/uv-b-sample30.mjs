// B 类（机械重复）预登记抽 30 条：文件路径升序、行号升序，第 i 条取 floor(N*(i+0.5)/30)，不放回。
// 输出每条的原行 + 上下各 2 行上下文，供逐条读原文判定「写一行注释是否能带来新信息」。
import fs from 'node:fs';
import path from 'node:path';

const repo = 'd:/code/opensource/uv';
const all = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/uv-rework/audit-c.json', 'utf8'));
const B = all.filter((u) => u.cat === 'B').sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
const N = B.length;
const picks = [];
for (let i = 0; i < 30; i++) picks.push(B[Math.floor(N * (i + 0.5) / 30)]);

const out = [];
out.push(`B_total=${N} sampled=${picks.length}`);
const cache = new Map();
for (const [i, p] of picks.entries()) {
  if (!cache.has(p.file)) cache.set(p.file, fs.readFileSync(path.join(repo, p.file), 'utf8').replace(/\r\n/g, '\n').split('\n'));
  const lines = cache.get(p.file);
  out.push('');
  out.push(`#${i + 1} ${p.file}:${p.line}  |  ${p.text.trim()}`);
  for (let k = Math.max(0, p.line - 3); k <= Math.min(lines.length - 1, p.line + 1); k++) {
    const mark = k === p.line - 1 ? '>' : ' ';
    out.push(`   ${mark} ${String(k + 1).padStart(5)} ${lines[k]}`);
  }
}
fs.writeFileSync('d:/code/_annot_baseline/uv-rework/b-sample30.txt', out.join('\n') + '\n', 'utf8');
console.log(out.join('\n'));
