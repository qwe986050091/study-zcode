#!/usr/bin/env node
// 临时工具：按行区间统计注释/代码/密度
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const ranges = process.argv.slice(3).map((s) => s.split('-').map(Number));
const text = readFileSync(file, 'utf8');
const lines = text.split('\n');
if (lines.length && lines[lines.length - 1] === '') lines.pop();

for (const [a, b] of ranges) {
  let total = 0, blank = 0, comment = 0;
  for (let i = a - 1; i < Math.min(b, lines.length); i++) {
    const t = lines[i].replace(/\r$/, '').trim();
    total++;
    if (t === '') blank++;
    else if (t.startsWith('#')) comment++;
  }
  const code = total - blank - comment;
  console.log(`${a}-${b}: total=${total} blank=${blank} comment=${comment} code=${code} density=${((comment / code) * 100).toFixed(2)}%`);
}
let total = 0, blank = 0, comment = 0;
for (const line of lines) {
  const t = line.replace(/\r$/, '').trim();
  total++;
  if (t === '') blank++;
  else if (t.startsWith('#')) comment++;
}
console.log(`ALL: total=${total} blank=${blank} comment=${comment} code=${total - blank - comment} density=${((comment / (total - blank - comment)) * 100).toFixed(2)}%`);
