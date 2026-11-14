import fs from 'node:fs';

const ROOT = 'D:/code/ZCode';
const SPEC = 'D:/code/_annot_baseline/ZC-deep-b68-spec-01.json';
const EXPECT_TOTAL = 64;

const FORBIDDEN_START = [
  'const', 'let', 'var', 'function', 'class', 'import', 'export', 'return',
  'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'await', 'async',
  'throw', 'new', 'interface', 'type', 'enum',
];

const CALL_SHAPE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/;

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const errors = [];
let total = 0;

if (!Array.isArray(spec.files) || spec.files.length !== 1) {
  errors.push('spec 必须且只能包含一个文件');
}

const f = spec.files[0];
const abs = ROOT + '/' + f.file;
const raw = fs.readFileSync(abs, 'utf8');
const lines = raw.split(/\r?\n/);
const used = new Set();

const firstAnchor = String(f.items[0].anchor ?? '').trim();
if (firstAnchor !== lines[0].trim()) {
  errors.push(`第一项 anchor 不等于文件首行: ${firstAnchor}`);
}

for (const item of f.items) {
  const anchor = String(item.anchor ?? '').trim();
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === anchor) hits.push(i);
  }
  const nth = item.nth || 1;
  if (hits.length < nth) {
    errors.push(`anchor 未命中 (hits=${hits.length}, nth=${nth}): ${anchor}`);
    continue;
  }
  if (!item.nth && hits.length !== 1) {
    errors.push(`anchor 重复但未给 nth (hits=${hits.length}): ${anchor}`);
  }
  const idx = hits[nth - 1];
  if (used.has(idx)) errors.push(`重复插入位置 ${idx}: ${anchor}`);
  used.add(idx);

  if (!item.raw && (!Array.isArray(item.lines) || item.lines.length === 0)) {
    errors.push(`空 raw 与 lines: ${anchor}`);
    continue;
  }
  const out = item.raw
    ? item.raw
    : item.lines.map((t) => (t === '' ? '//' : '// ' + t));
  total += out.length;

  for (const l of out) {
    if (l.includes('*/')) errors.push(`含 */: ${l}`);
    if (!l.trim().startsWith('//')) errors.push(`不是整行注释: ${l}`);
    if (l.includes('=>')) errors.push(`含 =>: ${l}`);
    if (/;\s*$/.test(l)) errors.push(`以分号结尾: ${l}`);
    if (CALL_SHAPE.test(l)) errors.push(`调用形态: ${l}`);
    const body = l.replace(/^\s*\/\/\s?/, '').trim();
    if (!body) continue;
    const first = body.split(/\s+/)[0];
    if (FORBIDDEN_START.includes(first)) errors.push(`禁词开头(${first}): ${body}`);
  }
}

const header = f.items[0].raw;
const invCount = header.filter((l) => /^\/\/ INV-\d\d /.test(l)).length;

console.log(`file=${f.file}`);
console.log(`items=${f.items.length}`);
console.log(`total lines=${total} (expect ${EXPECT_TOTAL})`);
console.log(`header lines=${header.length}, INV=${invCount}`);

if (header.length !== 22) errors.push(`文件头行数不是 22: ${header.length}`);
if (invCount !== 18) errors.push(`INV 数量不是 18: ${invCount}`);
if (header[18] !== '//') errors.push('文件头第 19 行必须是 //');
if (total !== EXPECT_TOTAL) errors.push(`总行数不等于 ${EXPECT_TOTAL}: ${total}`);

if (errors.length) {
  console.log('FAIL');
  for (const e of errors) console.log(' - ' + e);
  process.exit(1);
}
console.log('OK');
