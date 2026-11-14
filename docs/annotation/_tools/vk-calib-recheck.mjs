// 用修订后的块级判据重判 100 条校准样本：只统计仍会被判 W 的条数。
import fs from 'node:fs';
import path from 'node:path';
import { isWeakBlock } from './vk-gate.mjs';

const REPO = 'd:/code/opensource/valkey';
const tsv = fs.readFileSync('d:/code/_annot_baseline/vk-calib.tsv', 'utf8').replace(/\r/g, '').split('\n').filter(Boolean).slice(1);
const cache = new Map();
const linesOf = (rel) => {
  if (!cache.has(rel)) cache.set(rel, fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r/g, '').split('\n'));
  return cache.get(rel);
};
const isOwn = (s) => {
  const t = s.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
};
const contentOf = (s) => {
  let t = s.trim();
  if (t.startsWith('//')) t = t.slice(2);
  else if (t.startsWith('/*')) t = t.slice(2);
  else if (t.startsWith('*')) t = t.slice(1);
  return t.replace(/\*\/\s*$/, '').trim();
};
const remain = [];
for (const row of tsv) {
  const [seq, file, lineStr] = row.split('\t');
  const line = +lineStr;
  const ls = linesOf(file);
  let a = line - 1;
  let b = line - 1;
  while (a - 1 >= 0 && isOwn(ls[a - 1])) a--;
  while (b + 1 < ls.length && isOwn(ls[b + 1])) b++;
  const block = [];
  for (let i = a; i <= b; i++) block.push(contentOf(ls[i]));
  if (isWeakBlock(block)) remain.push(`${seq} ${file}:${line} ${block[0]}`);
}
console.log(`remainWeak=${remain.length}/${tsv.length}`);
for (const r of remain) console.log(r);
