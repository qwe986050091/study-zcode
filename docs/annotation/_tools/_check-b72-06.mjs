// 自检 ZC-deep-b72-spec-06.json：锚点唯一性、插入下标、注释合法性、行数合同
import fs from 'node:fs';

const SPEC = 'd:/code/_annot_baseline/ZC-deep-b72-spec-06.json';
const TARGET = 'd:/code/ZCode/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts';
const EXPECT_TOTAL = 63;

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const rawText = fs.readFileSync(TARGET, 'utf8');
const rawLines = rawText.split(/\r?\n/);
const trimmed = rawLines.map((l) => l.trim());

const BAD_START = ['const', 'let', 'var', 'function', 'class', 'import', 'export', 'return', 'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'await', 'async', 'throw', 'new', 'interface', 'type', 'enum'];
const problems = [];
let total = 0;
let blocks = 0;
let items = 0;

const f = spec.files[0];
const insertIdx = new Set();

for (const [i, item] of f.items.entries()) {
  items += 1;
  blocks += 1;
  const anchor = String(item.anchor ?? '').trim();
  if (!anchor) problems.push(`item#${i} 空锚点`);

  const hits = [];
  trimmed.forEach((t, idx) => { if (t === anchor) hits.push(idx); });
  const nth = item.nth || 1;
  if (hits.length === 0) problems.push(`item#${i} 锚点未命中: ${anchor}`);
  if (!item.nth && hits.length !== 1) problems.push(`item#${i} 锚点命中 ${hits.length} 次: ${anchor}`);
  if (hits.length >= nth && hits.length > 0) {
    const idx = hits[nth - 1];
    if (insertIdx.has(idx)) problems.push(`item#${i} 重复插入下标 ${idx}`);
    insertIdx.add(idx);
    if (!rawLines[idx].trim()) problems.push(`item#${i} 锚点是空行: ${anchor}`);
  }

  const body = item.raw ? item.raw : item.lines;
  if (!Array.isArray(body)) { problems.push(`item#${i} 缺 lines/raw`); continue; }
  total += body.length;
  if (item.raw && i !== 0) problems.push(`item#${i} 非首条使用 raw`);
  if (!item.raw) {
    const size = body.length;
    if (size < 3 || size > 6) problems.push(`item#${i} 块行数 ${size} 不在 3~6`);
  }

  body.forEach((line, j) => {
    const effective = item.raw ? line : line === '' ? '//' : '// ' + line;
    if (!effective.trim().startsWith('//')) problems.push(`item#${i}[${j}] 不以 // 开头: ${effective}`);
    if (effective.includes('*/')) problems.push(`item#${i}[${j}] 含 */`);
    const text = effective.replace(/^\s*\/\/ ?/, '');
    if (!text.trim()) return;
    if (text.includes('=>')) problems.push(`item#${i}[${j}] 含 =>: ${text}`);
    if (/;\s*$/.test(text)) problems.push(`item#${i}[${j}] 以分号结尾: ${text}`);
    if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/.test(text)) problems.push(`item#${i}[${j}] 含点号调用: ${text}`);
    const first = text.trim().split(/[\s,.:;，。；：]/)[0];
    if (BAD_START.includes(first)) problems.push(`item#${i}[${j}] 禁词开头 ${first}: ${text}`);
  });
}

const header = spec.files[0].items[0].raw;
if (!Array.isArray(header) || header.length !== 22) problems.push(`文件头 raw 长度 ${header ? header.length : 'n/a'} !== 22`);
if (!header[0].startsWith('// INV-01')) problems.push(`文件头首行不是 // INV-01: ${header[0]}`);
if (header[18] !== '//') problems.push(`文件头第 19 行不是 //: ${header[18]}`);
const invCount = header.filter((l) => l.startsWith('// INV-')).length;
if (invCount !== 18) problems.push(`INV 条数 ${invCount} !== 18`);
if (total !== EXPECT_TOTAL) problems.push(`总行数 ${total} !== ${EXPECT_TOTAL}`);

const allow = total === EXPECT_TOTAL && blocks === 13;
console.log('blocks =', blocks);
console.log('lines  =', total);
console.log('INV    =', invCount);
console.log('anchors unique =', insertIdx.size, '/', items);
console.log('blocks 13 (header + 12) =', allow);

if (problems.length) {
  console.log('FAIL');
  for (const p of problems) console.log(' -', p);
  process.exit(1);
}
console.log('OK');
