// 仅打印「块内无其它锚点」的样本及其完整注释块，便于逐条人工分类。
import fs from 'node:fs';
import path from 'node:path';
const REPO = 'd:/code/opensource/valkey';
const stats = fs.readFileSync('d:/code/_annot_baseline/vk-calib-stats.tsv', 'utf8').replace(/\r/g, '').split('\n').slice(1).filter(Boolean);
const pick = new Set(stats.filter((l) => l.endsWith('\tfalse')).map((l) => +l.split('\t')[0]));
const tsv = fs.readFileSync('d:/code/_annot_baseline/vk-calib.tsv', 'utf8').replace(/\r/g, '').split('\n').filter(Boolean).slice(1);
const cache = new Map();
const linesOf = (rel) => {
  if (!cache.has(rel)) cache.set(rel, fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r/g, '').split('\n'));
  return cache.get(rel);
};
const isOwn = (s) => s.trim().startsWith('//');
const out = [];
for (const row of tsv) {
  const [seq, file, lineStr] = row.split('\t');
  if (!pick.has(+seq)) continue;
  const line = +lineStr;
  const ls = linesOf(file);
  let a = line - 1;
  let b = line - 1;
  while (a - 1 >= 0 && isOwn(ls[a - 1])) a--;
  while (b + 1 < ls.length && isOwn(ls[b + 1])) b++;
  out.push(`### ${seq} ${file}:${line}`);
  for (let i = a; i <= b; i++) out.push(`${i + 1 === line ? '>>' : '  '}${ls[i].trim()}`);
  out.push('--code--');
  out.push('  ' + (ls[b + 1] ?? '').trim());
  out.push('  ' + (ls[b + 2] ?? '').trim());
}
fs.writeFileSync('d:/code/_annot_baseline/vk-calib-weak.txt', out.join('\n'), 'utf8');
console.log(`blocks=${pick.size}`);
