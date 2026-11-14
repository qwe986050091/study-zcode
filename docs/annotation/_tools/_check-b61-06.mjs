// 自检 ZC-deep-b61-spec-06.json：行数、锚点、禁词、危险 token
import fs from 'node:fs';

const SPEC = 'd:/code/_annot_baseline/ZC-deep-b61-spec-06.json';
const TARGET = 'd:/code/ZCode/packages/shared/src/gen-ui/contract.ts';
const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const raw = fs.readFileSync(TARGET, 'utf8').split(/\r?\n/);
const trimmed = raw.map((l) => l.trim());

const BAD_START = ['const', 'let', 'var', 'function', 'class', 'import', 'export', 'return', 'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'await', 'async', 'throw', 'new', 'interface', 'type', 'enum'];
const problems = [];
let total = 0;
let items = 0;

for (const f of spec.files) {
  for (const [i, item] of f.items.entries()) {
    items += 1;
    const anchor = String(item.anchor ?? '').trim();
    if (!anchor) problems.push(`item#${i} 空锚点`);
    const hits = [];
    trimmed.forEach((t, idx) => { if (t === anchor) hits.push(idx + 1); });
    const nth = item.nth || 1;
    if (!item.nth && hits.length !== 1) problems.push(`item#${i} 锚点命中 ${hits.length} 次: ${anchor}`);
    if (hits.length < nth) problems.push(`item#${i} 锚点不足 nth: ${anchor}`);

    const body = item.raw ? item.raw : item.lines;
    if (!Array.isArray(body)) { problems.push(`item#${i} 缺 lines/raw`); continue; }
    total += body.length;
    if (item.raw && i !== 0) problems.push(`item#${i} 非首条使用 raw`);

    body.forEach((line, j) => {
      if (item.raw && !line.trim().startsWith('//')) problems.push(`item#${i}[${j}] raw 不以 // 开头: ${line}`);
      if (line.includes('*/')) problems.push(`item#${i}[${j}] 含 */`);
      const text = line.replace(/^\s*\/\/ ?/, '');
      if (!text.trim()) return;
      if (text.includes('=>')) problems.push(`item#${i}[${j}] 含 =>: ${text}`);
      if (/;\s*$/.test(text)) problems.push(`item#${i}[${j}] 以分号结尾: ${text}`);
      if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/.test(text)) problems.push(`item#${i}[${j}] 含点号调用: ${text}`);
      const first = text.trim().split(/[\s,.:;，。；：]/)[0];
      if (BAD_START.includes(first)) problems.push(`item#${i}[${j}] 禁词开头 ${first}: ${text}`);
    });
  }
}

const header = spec.files[0].items[0].raw;
const invCount = header.filter((l) => l.startsWith('// INV-')).length;

console.log('items =', items);
console.log('lines =', total);
console.log('INV   =', invCount);
console.log('header first/last =', JSON.stringify(header[0]), JSON.stringify(header.at(-1)));
if (total < 70 || total > 72) problems.push(`总行数 ${total} 不在 70~72`);
if (invCount < 18 || invCount > 20) problems.push(`INV 条数 ${invCount} 不在 18~20`);

if (problems.length) {
  console.log('FAIL');
  for (const p of problems) console.log(' -', p);
  process.exit(1);
}
console.log('ALL PASS');
