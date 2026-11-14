import fs from 'node:fs';

const ROOT = 'D:/code/ZCode';
const SPEC = 'D:/code/_annot_baseline/ZC-deep-b59-spec-04.json';
const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));

const BANNED = ['const', 'let', 'var', 'function', 'class', 'import', 'export', 'return', 'if', 'else', 'for', 'while', 'switch', 'try', 'catch', 'await', 'async', 'throw', 'new', 'interface', 'type', 'enum'];
const CALL_RE = /[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(/;

let total = 0;
let items = 0;
const problems = [];
const usedIdx = new Set();

for (const f of spec.files) {
  const src = fs.readFileSync(`${ROOT}/${f.file}`, 'utf8');
  const lines = src.split(/\r?\n/);
  let fileTotal = 0;

  for (const item of f.items) {
    items += 1;
    const anchor = String(item.anchor ?? '').trim();
    if (!anchor) {
      problems.push('empty anchor');
      continue;
    }
    const hits = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].trim() === anchor) hits.push(i);
    const nth = item.nth || 1;
    if (hits.length === 0) problems.push(`anchor miss: ${anchor}`);
    if (!item.nth && hits.length !== 1) problems.push(`anchor not unique (${hits.length}): ${anchor}`);
    if (item.nth && hits.length < nth) problems.push(`anchor hit ${hits.length} < nth ${nth}: ${anchor}`);
    const idx = hits[nth - 1];
    if (idx !== undefined) {
      if (usedIdx.has(idx)) problems.push(`duplicate insert index ${idx}`);
      usedIdx.add(idx);
    }

    const out = item.raw ? item.raw : item.lines.map((t) => (t === '' ? '//' : `// ${t}`));
    fileTotal += out.length;
    total += out.length;

    for (const l of out) {
      if (!l.trim().startsWith('//')) problems.push(`not comment: ${l}`);
      if (l.includes('*/')) problems.push(`contains */: ${l}`);
      const body = l.replace(/^\s*\/\/ ?/, '').trim();
      if (body) {
        const first = body.split(/[\s,，、:：]/)[0];
        if (BANNED.includes(first)) problems.push(`banned start "${first}": ${l}`);
        if (first === 'type' || first === 'enum') problems.push(`banned start: ${l}`);
      }
      if (/;\s*$/.test(l)) problems.push(`ends with ;: ${l}`);
      if (l.includes('=>')) problems.push(`contains =>: ${l}`);
      if (CALL_RE.test(l)) problems.push(`call shape: ${l}`);
    }
  }

  console.log(`${f.file}: ${f.items.length} items, ${fileTotal} lines`);
}

console.log(`items=${items} total=${total} expect=68 ${total === 68 ? 'OK' : 'FAIL'}`);
if (problems.length) {
  console.log('PROBLEMS:');
  for (const p of problems) console.log(' - ' + p);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
