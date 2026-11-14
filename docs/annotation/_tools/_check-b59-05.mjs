import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/code/ZCode';
const specPath = 'D:/code/_annot_baseline/ZC-deep-b59-spec-05.json';
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

const BANNED = [
  'const', 'let', 'var', 'function', 'class', 'import', 'export', 'return',
  'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'await', 'async',
  'throw', 'new', 'interface', 'type', 'enum',
];

let errors = [];
let totalLines = 0;
let itemCount = 0;

for (const f of spec.files) {
  if (f.file.startsWith('ZCode/') || path.isAbsolute(f.file)) {
    errors.push(`file path not repo-relative: ${f.file}`);
  }
  const abs = path.join(ROOT, f.file);
  if (!fs.existsSync(abs)) {
    errors.push(`missing file: ${f.file}`);
    continue;
  }
  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split(/\r?\n/);

  let fileTotal = 0;
  let first = true;
  let headerRawCount = 0;

  f.items.forEach((item, i) => {
    itemCount += 1;
    const anchor = String(item.anchor ?? '').trim();
    const hits = [];
    for (let k = 0; k < lines.length; k++) {
      if (lines[k].trim() === anchor) hits.push(k);
    }
    const nth = item.nth || 1;
    if (item.nth) {
      if (hits.length < nth) errors.push(`[${i}] anchor hits ${hits.length} < nth ${nth}: ${anchor}`);
      if (hits.length > 1) console.log(`[info] item ${i} anchor multi-hit (${hits.length}) using nth=${nth}: ${anchor}`);
    } else if (hits.length !== 1) {
      errors.push(`[${i}] anchor not unique (${hits.length}): ${anchor}`);
    }

    const out = item.raw ? item.raw : item.lines.map((t) => '// ' + t);
    fileTotal += out.length;

    if (item.raw) {
      if (!first) errors.push(`[${i}] raw item must be first`);
      headerRawCount = out.length;
      if (out[0] !== '// INV-01 每个 turnId 恰好对应一个渲染单元，首个匹配行创建、后续行复用；守住位置：getOrCreateUnit 与 unitByTurnId；改错故障：同一轮出现重复卡片、滚动定位跳动') {
        errors.push(`header first line unexpected`);
      }
      if (out[out.length - 1] !== '// 改动时先定位出错的阶段：分桶看主循环，顺序看 units，折叠看 workSegments，不要跨阶段补兜底') {
        errors.push(`header last line unexpected`);
      }
      const invCount = out.filter((l) => l.startsWith('// INV-')).length;
      if (invCount < 18 || invCount > 20) errors.push(`INV count ${invCount} not in 18..20`);
      let n = 0;
      for (const l of out) {
        if (!l.startsWith('// INV-')) continue;
        n += 1;
        const expect = `// INV-${String(n).padStart(2, '0')} `;
        if (!l.startsWith(expect)) errors.push(`INV numbering broken at ${n}: ${l}`);
        if (!l.includes('；守住位置：') || !l.includes('；改错故障：')) {
          errors.push(`INV format missing fields: ${l}`);
        }
      }
      const blankIdx = out.indexOf('//');
      if (blankIdx < 0) errors.push('header missing trailing // blank line');
      else {
        const tailCount = out.length - blankIdx - 1;
        if (tailCount < 2 || tailCount > 4) errors.push(`header summary lines ${tailCount} not in 2..4`);
      }
    }

    for (const l of out) {
      if (!l.trim().startsWith('//')) errors.push(`[${i}] not a comment line: ${l}`);
      if (l.includes('*/')) errors.push(`[${i}] contains */: ${l}`);
      const body = l.replace(/^\s*\/\/\s?/, '').trim();
      if (body.endsWith(';')) errors.push(`[${i}] ends with ;: ${l}`);
      if (body.includes('=>')) errors.push(`[${i}] contains =>: ${l}`);
      const w = body.split(/\s+/)[0];
      if (BANNED.includes(w)) errors.push(`[${i}] starts with banned word "${w}": ${l}`);
      if (/\.[A-Za-z_$][\w$]*\(/.test(body)) errors.push(`[${i}] dotted call form: ${l}`);
    }
    first = false;
  });

  console.log(`file=${f.file} items=${f.items.length} headerRaw=${headerRawCount} total=${fileTotal}`);
  totalLines += fileTotal;
}

console.log(`TOTAL items=${itemCount} lines=${totalLines}`);
if (totalLines < 68 || totalLines > 70) errors.push(`total lines ${totalLines} not in 68..70`);
if (errors.length) {
  console.log('FAIL');
  for (const e of errors) console.log(' - ' + e);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
