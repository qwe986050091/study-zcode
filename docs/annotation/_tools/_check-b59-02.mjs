import fs from 'node:fs';

const ROOT = 'D:/code/ZCode';
const specPath = 'D:/code/_annot_baseline/ZC-deep-b59-spec-02.json';
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const f = spec.files[0];
const raw = fs.readFileSync(`${ROOT}/${f.file}`, 'utf8');
const lines = raw.split(/\r?\n/);

const BAD_START = ['const', 'let', 'var', 'function', 'class', 'import', 'export', 'return', 'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'await', 'async', 'throw', 'new', 'interface', 'type', 'enum'];

let total = 0;
let errors = 0;
const seenIdx = new Set();
let headerChecked = false;

f.items.forEach((item, i) => {
  const anchor = String(item.anchor ?? '').trim();
  const hits = [];
  lines.forEach((l, idx) => { if (l.trim() === anchor) hits.push(idx); });
  const nth = item.nth || 1;
  if (hits.length < nth || (!item.nth && hits.length !== 1)) {
    console.log(`[FAIL] item#${i + 1} anchor hit=${hits.length} nth=${nth}: ${anchor}`);
    errors++;
  } else if (seenIdx.has(hits[nth - 1])) {
    console.log(`[FAIL] item#${i + 1} duplicate insert index ${hits[nth - 1]}`);
    errors++;
  } else {
    seenIdx.add(hits[nth - 1]);
  }
  const out = item.raw ? item.raw : item.lines.map((t) => (t === '' ? '//' : '// ' + t));
  total += out.length;
  if (i === 0 && !item.raw) {
    console.log('[FAIL] first item is not raw header');
    errors++;
  }
  if (i === 0 && item.raw) {
    const inv = out.filter((l) => /^\/\/ INV-\d\d /.test(l)).length;
    if (inv < 18 || inv > 20) {
      console.log(`[FAIL] header INV count = ${inv}`);
      errors++;
    }
    if (!out[out.length - 1].trim().startsWith('//')) {
      console.log('[FAIL] header does not end with comment line');
      errors++;
    }
    headerChecked = true;
  }
  out.forEach((l) => {
    const body = l.replace(/^\s*\/\/\s?/, '');
    if (l.includes('*/')) { console.log(`[FAIL] item#${i + 1} contains */: ${l}`); errors++; }
    if (l.trim().endsWith(';')) { console.log(`[FAIL] item#${i + 1} ends with ;: ${l}`); errors++; }
    if (l.includes('=>')) { console.log(`[FAIL] item#${i + 1} contains =>: ${l}`); errors++; }
    if (/\b[\w$]+\.[\w$]+\(/.test(body)) { console.log(`[FAIL] item#${i + 1} call form: ${l}`); errors++; }
    const first = body.split(/[\s，。：；、]/)[0];
    if (BAD_START.includes(first)) { console.log(`[FAIL] item#${i + 1} bad start "${first}": ${l}`); errors++; }
    if (!/^\s*\/\//.test(l)) { console.log(`[FAIL] item#${i + 1} not comment line: ${l}`); errors++; }
  });
});

if (!headerChecked) { console.log('[FAIL] no raw header found'); errors++; }
console.log(`items=${f.items.length} totalLines=${total} errors=${errors}`);
if (total < 70 || total > 72) console.log(`[FAIL] total line count out of range: ${total}`);
if (errors === 0 && total >= 70 && total <= 72) console.log('CHECK PASS');
else process.exitCode = 1;
