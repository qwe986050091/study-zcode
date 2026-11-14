// 校准辅助：对 vk-calib.tsv 的每条样本，打印它所属的整段连续注释块（含前后各最多 10 行），
// 用于判断该行是否只是多行块中的一行（假阳性）还是独立单行注释（可能真注水）。
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'd:/code/opensource/valkey';
const tsv = fs.readFileSync('d:/code/_annot_baseline/vk-calib.tsv', 'utf8').replace(/\r/g, '').split('\n').filter(Boolean);
const cache = new Map();
const linesOf = (rel) => {
  if (!cache.has(rel)) cache.set(rel, fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r/g, '').split('\n'));
  return cache.get(rel);
};
const isCmt = (s) => {
  const t = s.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
};
const out = [];
for (const row of tsv.slice(1)) {
  const [seq, file, lineStr] = row.split('\t');
  const line = +lineStr;
  const ls = linesOf(file);
  let a = line - 1;
  let b = line - 1;
  while (a - 1 >= 0 && isCmt(ls[a - 1])) a--;
  while (b + 1 < ls.length && isCmt(ls[b + 1])) b++;
  const block = [];
  for (let i = Math.max(0, a - 10); i <= Math.min(ls.length - 1, b + 10); i++) {
    block.push(`${i + 1 === line ? '>>' : '  '}${i + 1}\t${ls[i]}`);
  }
  out.push(`### ${seq}\t${file}:${line}\tblock=${a + 1}-${b + 1}(${b - a + 1}行)`);
  out.push(...block);
}
fs.writeFileSync('d:/code/_annot_baseline/vk-calib-ctx.txt', out.join('\n'), 'utf8');
console.log('written', out.length);
