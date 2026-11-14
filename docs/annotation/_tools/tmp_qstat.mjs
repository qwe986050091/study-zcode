// 队列分布统计
import fs from 'node:fs';
const raw = fs.readFileSync('d:/code/_annot_baseline/R55-claim-queue.csv', 'utf8').replace(/^\uFEFF/, '');
const parse = (t) => {
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
  return rows;
};
const rows = parse(raw);
const head = rows.shift();
const H = Object.fromEntries(head.map((h, i) => [h, i]));
console.log(head.join(' | '));
const stat = {};
for (const r of rows) {
  const concl = r[H.conclusion] || '';
  const tag = concl.startsWith('不成立') ? 'FAIL' : concl.startsWith('成立') ? 'OK' : 'EMPTY';
  const k = r[H.batch] + '|' + r[H.layer_status] + '|' + tag;
  stat[k] = (stat[k] || 0) + 1;
}
console.log(stat);
console.log('total rows', rows.length);
for (const r of rows.filter((x) => x[H.batch] === 'R57' && x[H.conclusion].startsWith('成立')).slice(0, 3)) console.log(r[H.key], r[H.conclusion]);
