import fs from 'node:fs';

const target = 'D:/code/ZCode/apps/zcode-cli/packages/telemetry/src/otlp-exporter.ts';
const specPath = 'D:/code/_annot_baseline/ZC-deep-b58-spec-06.json';

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const raw = fs.readFileSync(target, 'utf8');
const lines = raw.split(/\r?\n/);
const entries = spec.files[0].items;

const BANNED = [
  'const', 'let', 'var', 'function', 'class', 'import', 'export', 'return',
  'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'await', 'async',
  'throw', 'new', 'interface', 'type', 'enum',
];

let total = 0;
const errors = [];

entries.forEach((item, i) => {
  const out = item.raw ? item.raw : item.lines;
  total += out.length;

  const anchor = String(item.anchor ?? '').trim();
  const hits = [];
  lines.forEach((l, idx) => {
    if (l.trim() === anchor) hits.push(idx + 1);
  });
  if (hits.length === 0) errors.push(`[anchor] item#${i} not found: ${anchor}`);
  else if (!item.nth && hits.length !== 1) errors.push(`[anchor] item#${i} hit ${hits.length}: ${anchor}`);
  if (item.nth && hits.length < item.nth) errors.push(`[anchor] item#${i} nth out of range: ${anchor}`);

  out.forEach((src) => {
    const l = item.raw ? src : '// ' + src;
    if (l.includes('*/')) errors.push(`[*/] ${l}`);
    if (!l.trim().startsWith('//')) errors.push(`[prefix] ${l}`);
    const body = l.trim().replace(/^\/\//, '').trim();
    if (body === '') return;
    if (body.endsWith(';')) errors.push(`[semicolon] ${body}`);
    if (body.includes('=>')) errors.push(`[arrow] ${body}`);
    if (/[A-Za-z0-9_$]\.[A-Za-z0-9_$]+\(/.test(body)) errors.push(`[call] ${body}`);
    const first = body.split(/\s+/)[0];
    if (BANNED.includes(first)) errors.push(`[banned:${first}] ${body}`);
  });
});

const header = entries[0].raw ?? [];
const invCount = header.filter((l) => /^\/\/ INV-\d{2} /.test(l)).length;

console.log(`items=${entries.length}`);
console.log(`totalLines=${total}`);
console.log(`headerLines=${header.length} invCount=${invCount}`);
console.log(`errors=${errors.length}`);
errors.slice(0, 40).forEach((e) => console.log('  ' + e));
console.log(total === 74 && errors.length === 0 ? 'CHECK PASS' : 'CHECK FAIL');
