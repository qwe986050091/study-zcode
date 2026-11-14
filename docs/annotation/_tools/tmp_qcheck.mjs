import fs from 'node:fs';
const t = fs.readFileSync('d:/code/_annot_baseline/R55-claim-queue.csv', 'utf8').replace(/^\uFEFF/, '');
const rows = []; let row = []; let f = ''; let q = false;
for (let i = 0; i < t.length; i++) {
  const c = t[i];
  if (q) {
    if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
  } else if (c === '"') q = true;
  else if (c === ',') { row.push(f); f = ''; }
  else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
  else if (c === '\r') { /* skip */ }
  else f += c;
}
if (f.length || row.length) { row.push(f); rows.push(row); }
const head = rows.shift();
console.log('cols', head.length, head.join('|'));
const bad = rows.filter((r) => r.length !== head.length);
console.log('rows', rows.length, 'bad', bad.length);
if (bad.length) console.log(bad.slice(0, 2));
const suspect = rows.filter((r) => r[6] && !/^(R5\d|R52)$/.test(r[6]));
console.log('suspect batch', suspect.length);
if (suspect.length) console.log(suspect.slice(0, 2));
