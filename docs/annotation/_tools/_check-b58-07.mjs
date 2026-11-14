import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/code/ZCode';
const SPEC = 'D:/code/_annot_baseline/ZC-deep-b58-spec-07.json';
const BANNED = [
  'const', 'let', 'var', 'function', 'class', 'import', 'export', 'return',
  'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'await', 'async',
  'throw', 'new', 'interface', 'type', 'enum',
];

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const errors = [];
let totalLines = 0;
let itemCount = 0;

for (const f of spec.files) {
  const abs = path.join(ROOT, f.file);
  const src = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  let fileLines = 0;

  f.items.forEach((item, i) => {
    itemCount++;
    const anchor = String(item.anchor ?? '').trim();
    const out = item.raw ? item.raw : item.lines;
    if (!out || !Array.isArray(out)) {
      errors.push(`item#${i} 缺少 raw/lines`);
      return;
    }
    fileLines += out.length;

    const hits = [];
    src.forEach((line, idx) => {
      if (line.trim() === anchor) hits.push(idx + 1);
    });
    const nth = item.nth || 1;
    if (hits.length < nth) errors.push(`item#${i} anchor 未命中: ${anchor}`);
    else if (!item.nth && hits.length !== 1) errors.push(`item#${i} anchor 非唯一(${hits.length}): ${anchor}`);
    else if (item.nth && hits.length < nth) errors.push(`item#${i} nth=${nth} 超出命中数 ${hits.length}`);

    out.forEach((t, j) => {
      const rawLine = item.raw ? t : t === '' ? '//' : '// ' + t;
      if (!rawLine.trim().startsWith('//')) errors.push(`item#${i} 行#${j} 非注释: ${rawLine}`);
      if (rawLine.includes('*/')) errors.push(`item#${i} 行#${j} 含 */: ${rawLine}`);

      let body = rawLine.replace(/^\s*\/\/\s?/, '');
      if (/;$/.test(body)) errors.push(`item#${i} 行#${j} 以分号结尾: ${body}`);
      if (body.includes('=>')) errors.push(`item#${i} 行#${j} 含 =>: ${body}`);
      if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/.test(body))
        errors.push(`item#${i} 行#${j} 形如调用: ${body}`);
      const m = /^([A-Za-z_$][\w$]*)/.exec(body.trim());
      if (m && BANNED.includes(m[1])) errors.push(`item#${i} 行#${j} 禁用起始词 ${m[1]}: ${body}`);
    });
  });

  console.log(`[file] ${f.file}: ${f.items.length} items, ${fileLines} lines`);
  totalLines += fileLines;
}

console.log(`TOTAL items=${itemCount} lines=${totalLines}`);
const invCount = spec.files[0].items[0].raw.filter((l) => /^\/\/ INV-\d\d /.test(l)).length;
console.log(`HEADER INV count=${invCount} (expect 18~20)`);
if (invCount < 18 || invCount > 20) errors.push(`INV 数量越界: ${invCount}`);
if (totalLines < 74 || totalLines > 76) errors.push(`总行数越界: ${totalLines}`);
if (totalLines !== 74) console.log(`NOTE 总行数非精确 74`);

if (errors.length) {
  console.log(`FAIL ${errors.length} 项`);
  for (const e of errors) console.log(' - ' + e);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
