import fs from 'node:fs';

const SPEC = 'D:/code/_annot_baseline/ZC-deep-b59-spec-08.json';
const ROOT = 'D:/code/ZCode';
const BANNED_START = [
  'const', 'let', 'var', 'function', 'class', 'import', 'export', 'return',
  'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'await', 'async',
  'throw', 'new', 'interface', 'type', 'error', 'enum',
];

const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
let fail = 0;
const bad = (msg) => { fail++; console.log('[FAIL] ' + msg); };

let total = 0;
for (const f of spec.files) {
  const src = fs.readFileSync(ROOT + '/' + f.file, 'utf8').split(/\r?\n/);
  const counts = new Map();
  const idxMap = new Map();
  let fileTotal = 0;

  for (const item of f.items) {
    const anchor = String(item.anchor ?? '').trim();
    if (!anchor) { bad('empty anchor'); continue; }
    const hits = [];
    for (let i = 0; i < src.length; i++) if (src[i].trim() === anchor) hits.push(i);
    const nth = item.nth || 1;
    counts.set(anchor, (counts.get(anchor) || 0) + 1);
    if (hits.length < nth) bad(`anchor ${hits.length} hits < nth ${nth}: ${anchor}`);
    if (!item.nth && hits.length !== 1) bad(`anchor not unique (${hits.length}): ${anchor}`);
    if (item.nth && hits.length < item.nth) bad(`nth ${nth} beyond hits ${hits.length}: ${anchor}`);
    const idx = hits[nth - 1];
    if (idx === undefined) continue;
    if (idxMap.has(idx)) bad(`duplicate insert index ${idx}: ${anchor}`);
    idxMap.set(idx, true);

    const out = item.raw ? item.raw : item.lines.map((t) => (t === '' ? '//' : '// ' + t));
    fileTotal += out.length;
    out.forEach((line) => {
      const t = line.trim();
      if (!t.startsWith('//')) bad(`not comment: ${line}`);
      if (t.includes('*/')) bad(`contains */: ${line}`);
      const body = t.replace(/^\/\/\s?/, '').trim();
      if (!body) return;
      if (body.endsWith(';')) bad(`ends with ;: ${line}`);
      if (body.includes('=>')) bad(`contains =>: ${line}`);
      if (/\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(/.test(body)) bad(`call form id.id(: ${line}`);
      const first = body.split(/[\s，、：,]/)[0];
      if (BANNED_START.includes(first)) bad(`banned start "${first}": ${line}`);
    });
  }

  // header must be first item and raw
  const first = f.items[0];
  if (!first || !first.raw) bad('first item is not raw header');
  if (first && first.raw && !first.raw.some((l) => l.includes('INV-01'))) bad('header missing INV-01');
  const invCount = (first?.raw || []).filter((l) => /^\/\/\s*INV-\d\d\s/.test(l.trim())).length;
  if (invCount < 18 || invCount > 20) bad(`INV count ${invCount} not in 18..20`);
  // header anchor must be the first import line
  if (first && first.anchor.trim() !== src[0].trim()) bad('header anchor is not first import line');

  total += fileTotal;
  console.log(`[info] ${f.file}: items=${f.items.length} lines=${fileTotal} INV=${invCount}`);
}

if (total < 70 || total > 72) bad(`total ${total} not in 70..72`);
else console.log(`[info] total lines = ${total}`);

if (fail) { console.log(`\nCHECK FAILED (${fail})`); process.exit(1); }
console.log('\nCHECK PASSED');
