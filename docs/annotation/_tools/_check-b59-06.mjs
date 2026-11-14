import fs from 'node:fs';

const SPEC = 'D:/code/_annot_baseline/ZC-deep-b59-spec-06.json';
const TARGET = 'D:/code/ZCode/packages/ui/src/store/index.ts';

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
const targetLines = fs.readFileSync(TARGET, 'utf8').split(/\r?\n/);

const items = spec.files[0].items;
let total = 0;
const problems = [];

const FORBIDDEN_START = [
  'const', 'let', 'var', 'function', 'class', 'import', 'export', 'return',
  'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'await', 'async',
  'throw', 'new', 'interface', 'type', 'enum',
];

const anchors = [];

items.forEach((item, i) => {
  const lines = item.raw ? item.raw : item.lines;
  total += lines.length;

  const anchor = String(item.anchor ?? '').trim();
  const hits = [];
  targetLines.forEach((l, idx) => {
    if (l.trim() === anchor) hits.push(idx + 1);
  });
  const nth = item.nth || 1;
  anchors.push({ i, anchor, hits: hits.length, nth });

  if (hits.length === 0) problems.push(`[anchor] item#${i} 0 hits: ${anchor}`);
  else if (item.nth && hits.length < nth) problems.push(`[anchor] item#${i} hits ${hits.length} < nth ${nth}: ${anchor}`);
  else if (!item.nth && hits.length !== 1) problems.push(`[anchor] item#${i} not unique (${hits.length}): ${anchor}`);

  lines.forEach((raw, k) => {
    if (item.raw && !raw.trim().startsWith('//')) problems.push(`[shape] item#${i} line#${k} 不以 // 开头: ${raw}`);
    if (!item.raw && raw.trim() === '') return;
    if (raw.includes('*/')) problems.push(`[forbidden] item#${i} line#${k} 含 */: ${raw}`);

    const body = item.raw
      ? raw.replace(/^\s*\/\/\s?/, '').trim()
      : raw.trim();
    const firstWord = body.split(/[\s，。；：、,.:()（）]/)[0];
    if (FORBIDDEN_START.includes(firstWord)) problems.push(`[start] item#${i} line#${k} 禁词开头 ${firstWord}: ${raw}`);
    if (body.endsWith(';')) problems.push(`[semicolon] item#${i} line#${k} 以 ; 结尾: ${raw}`);
    if (raw.includes('=>')) problems.push(`[arrow] item#${i} line#${k} 含 =>: ${raw}`);
    if (/[A-Za-z0-9_$)\]]\.[A-Za-z_$][A-Za-z0-9_$]*\s*[\uFF08(]/.test(body)) {
      problems.push(`[call] item#${i} line#${k} 出现 标识符.标识符( 形态: ${raw}`);
    }
  });
});

const rawItems = items.filter((x) => x.raw).length;
const headerIdx = items.findIndex((x) => x.raw);
const headerLines = items[headerIdx].raw;
const invCount = headerLines.filter((l) => /^\/\/\s*INV-\d{2}\s/.test(l)).length;
const headerBeforeFirstImport = targetLines.findIndex((l) => l.trim() === items[headerIdx].anchor.trim()) >= 0;

console.log(`items=${items.length} raw_items=${rawItems} totalLines=${total}`);
console.log(`header INV=${invCount} headerLen=${headerLines.length} firstImportResolved=${headerBeforeFirstImport}`);
console.log(`anchors: ${anchors.map((a) => `${a.hits}${a.nth !== 1 ? `/nth${a.nth}` : ''}`).join(' ')}`);

const dups = anchors.filter((a) => a.hits !== 1);
console.log(`multi-hit anchors: ${dups.length ? dups.map((d) => `${d.hits}->${d.anchor.slice(0, 40)}`).join(' | ') : 'none'}`);

if (total !== 69) problems.push(`[total] 期望 69 实际 ${total}`);
if (invCount < 18 || invCount > 20) problems.push(`[inv] INV 条数 ${invCount} 不在 18~20`);
if (headerLines[headerLines.length - 1] === '' || headerLines[headerLines.length - 1].trim() === '//') {
  // 允许最后的 // 出现在中间，不强制
}

if (problems.length) {
  console.log('--- PROBLEMS ---');
  problems.forEach((p) => console.log(p));
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
