import fs from 'node:fs';

const ROOT = 'D:/code/ZCode';
const SPEC = 'D:/code/_annot_baseline/ZC-deep-b61-spec-01.json';

const FORBIDDEN_START = [
  'const', 'let', 'var', 'function', 'class', 'import', 'export', 'return',
  'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'await', 'async',
  'throw', 'new', 'interface', 'type', 'enum',
];

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
let errors = [];
let total = 0;

for (const f of spec.files) {
  const abs = ROOT + '/' + f.file;
  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split(/\r?\n/);
  const used = new Set();

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

    if (!item.raw && (!item.lines || item.lines.length === 0)) errors.push(`空 lines: ${anchor}`);
    const out = item.raw
      ? item.raw
      : item.lines.map((t) => (t === '' ? '//' : '// ' + t));
    total += out.length;

    for (const l of out) {
      if (l.includes('*/')) errors.push(`含 */: ${l}`);
      if (!l.trim().startsWith('//')) errors.push(`不是整行注释: ${l}`);
      if (l.includes('=>')) errors.push(`含 =>: ${l}`);
      if (/;\s*$/.test(l)) errors.push(`以分号结尾: ${l}`);
      if (l.includes(';')) errors.push(`含半角分号: ${l}`);
      if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/.test(l)) errors.push(`调用形态: ${l}`);
      const body = l.replace(/^\s*\/\/\s?/, '').trim();
      if (!body) continue;
      const first = body.split(/\s+/)[0];
      if (FORBIDDEN_START.includes(first)) errors.push(`禁词开头(${first}): ${body}`);
    }
  }
}

const header = spec.files[0].items[0].raw;
const invCount = header.filter((l) => /^\/\/ INV-\d\d /.test(l)).length;
console.log(`items=${spec.files[0].items.length}`);
console.log(`total lines=${total}`);
console.log(`header lines=${header.length}, INV=${invCount}`);
console.log(`header last="${header[header.length - 1]}"`);
if (total < 71 || total > 73) errors.push(`总行数越界: ${total}`);
if (invCount < 18 || invCount > 20) errors.push(`INV 数量越界: ${invCount}`);
if (header[header.length - 1].trim() !== '//') errors.push('文件头未以 // 收尾');

if (errors.length) {
  console.log('FAIL');
  for (const e of errors) console.log(' - ' + e);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
