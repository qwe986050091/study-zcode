import fs from 'node:fs';
const t = fs.readFileSync('d:/code/_annot_baseline/R55-claim-queue.csv', 'utf8').replace(/^\uFEFF/, '');
const rows = []; let row = []; let f = ''; let q = false;
for (let i = 0; i < t.length; i++) {
  const c = t[i];
  if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
  else if (c === '"') q = true;
  else if (c === ',') { row.push(f); f = ''; }
  else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
  else if (c === '\r') {}
  else f += c;
}
if (f.length || row.length) { row.push(f); rows.push(row); }
const head = rows.shift();
const get = (r, k) => r[head.indexOf(k)];
const res = new Map();
const rs = fs.readFileSync('d:/code/_annot_baseline/R52-claim-results.tsv', 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
for (const l of rs) { const c = l.split('\t'); res.set(c[0], c.slice(1).join('\t')); }
const lr = new Map();
const ls = fs.readFileSync('d:/code/_annot_baseline/R52-layer-results.tsv', 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
for (const l of ls) { const c = l.split('\t'); lr.set(c[0], c.slice(1).join('\t')); }
const out = rows.filter((r) => get(r, 'batch') === 'R57');
console.log('R57 rows', out.length);
for (const r of out) {
  const k = get(r, 'key');
  console.log([k, get(r, 'keyword'), get(r, 'file') + ':' + get(r, 'line'), (res.get(k) || '-'), (lr.get(k) || '-')].join('\t'));
  console.log('   ' + get(r, 'segment'));
}
