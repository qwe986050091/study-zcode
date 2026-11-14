// 基于 B33-plan.mjs 的结果，输出文件序切片方案
import fs from 'node:fs';
const raw = fs.readFileSync('d:/code/_annot_baseline/B33-plan.out.txt', 'utf8');
const funcs = [];
let outside = null;
for (const line of raw.split(/\r?\n/)) {
  if (!line || line.startsWith('FUNCS') || line.startsWith('name\t') || line.startsWith('TOTAL') || line.startsWith('---')) continue;
  const p = line.split('\t');
  if (p.length === 5 && /^\d+$/.test(p[1])) funcs.push({ name: p[0], n: +p[1], w: +p[2], plan: +p[3], span: p[4] });
}
funcs.sort((a, b) => parseInt(a.span) - parseInt(b.span));
let slice = 1, acc = 0;
const CAP = 330;
console.log('slice\tunits\tplan\tfunctions');
let cur = [];
for (const f of funcs) {
  if (acc + f.w > CAP && cur.length) {
    console.log(`P${slice}\t${cur.reduce((x, y) => x + y.n, 0)}\t${cur.reduce((x, y) => x + y.plan, 0)}\t${cur.map((x) => x.name).join(', ')}`);
    slice++; cur = []; acc = 0;
  }
  cur.push(f); acc += f.w;
}
if (cur.length) console.log(`P${slice}\t${cur.reduce((x, y) => x + y.n, 0)}\t${cur.reduce((x, y) => x + y.plan, 0)}\t${cur.map((x) => x.name).join(', ')}`);
