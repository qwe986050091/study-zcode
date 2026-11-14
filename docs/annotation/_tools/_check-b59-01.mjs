import fs from 'node:fs';

const SPEC = 'D:/code/_annot_baseline/ZC-deep-b59-spec-01.json';
const ROOT = 'D:/code/ZCode';
const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));

const forbiddenStart = [
  'const', 'let', 'var', 'function', 'class', 'import', 'export', 'return',
  'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'await', 'async',
  'throw', 'new', 'interface', 'type', 'enum',
];

let ok = true;
const fail = (msg) => { ok = false; console.log('[FAIL] ' + msg); };

let totalLines = 0;
let totalItems = 0;
const invLines = [];

for (const f of spec.files) {
  const abs = ROOT + '/' + f.file;
  const src = fs.readFileSync(abs, 'utf8');
  const lines = src.split(/\r?\n/);
  console.log('file: ' + f.file + ' (' + lines.length + ' lines)');

  const anchors = new Set();
  for (const item of f.items) {
    totalItems++;
    const anchor = String(item.anchor ?? '').trim();
    const out = item.raw ? item.raw : item.lines;
    totalLines += out.length;

    const hits = [];
    lines.forEach((l, i) => { if (l.trim() === anchor) hits.push(i); });
    const nth = item.nth || 1;
    if (item.nth) {
      if (hits.length < nth) fail('anchor hits ' + hits.length + ' < nth ' + nth + ': ' + anchor);
    } else if (hits.length !== 1) {
      fail('anchor hits ' + hits.length + ' (need unique): ' + anchor);
    }
    if (hits.length >= 1 && !item.raw && item.lines.length === 0) fail('empty lines: ' + anchor);

    // inserted index uniqueness
    if (hits.length >= nth) {
      const key = hits[nth - 1];
      if (anchors.has(key)) fail('duplicate insert index ' + key + ': ' + anchor);
      anchors.add(key);
    }

    for (const rawLine of out) {
      if (item.raw && !rawLine.trim().startsWith('//')) fail('not a // line: ' + rawLine);
      if (rawLine.includes('*/')) fail('contains */ : ' + rawLine);
      const body = rawLine.replace(/^\s*\/\/\s?/, '').trim();
      if (!item.raw && rawLine.includes('//')) fail('non-raw line carries //: ' + rawLine);
      if (body) {
        const first = body.split(/\s|[：:，,。]/)[0];
        if (forbiddenStart.includes(first)) fail('forbidden start "' + first + '": ' + body);
      }
      if (/;\s*$/.test(rawLine)) fail('ends with ASCII semicolon: ' + rawLine);
      if (rawLine.includes('=>')) fail('contains => : ' + rawLine);
      if (/[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/.test(rawLine)) fail('call-like dotted form: ' + rawLine);
      if (item.raw && /^\/\/ INV-\d\d /.test(rawLine)) invLines.push(rawLine);
    }
  }

  const rawItem = f.items.find((it) => it.raw);
  if (f.items[0] !== rawItem) fail('first item is not raw header');
  if (rawItem && rawItem.raw[rawItem.raw.length - 1].trim() !== '//') fail('header does not end with bare //');
}

if (totalLines !== 71) fail('total inserted lines = ' + totalLines + ' (expect 71)');
if (invLines.length < 18 || invLines.length > 20) fail('INV count = ' + invLines.length + ' (expect 18~20)');

console.log('items: ' + totalItems);
console.log('total lines: ' + totalLines);
console.log('INV lines: ' + invLines.length);
console.log(ok ? 'ALL CHECKS PASS' : 'CHECKS FAILED');
process.exit(ok ? 0 : 1);
