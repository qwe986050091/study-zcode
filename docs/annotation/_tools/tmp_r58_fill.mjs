// R58 断言核验回填：36 行（35 键，c45361cf 两处）
import fs from 'node:fs';
const P = 'd:/code/_annot_baseline/R55-claim-queue.csv';
const raw = fs.readFileSync(P, 'utf8').replace(/^\uFEFF/, '');
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
// 已有 R52c 修正行的 5 条
const hadR52 = new Set(['aa6a11e4', '2d9abbdf', '428f5c09', 'bf9f7a7e', 'df7ac8f3']);
// 本轮新判不成立、已插修正行的 5 条
const fail = new Set(['af888a56', '08b4eb89', '4e8a2eec', 'a6e835eb', 'e35b6ccf']);
let n = 0;
for (const r of rows) {
  if (r[H.batch] !== 'R58') continue;
  const key = r[H.key];
  if (fail.has(key)) r[H.conclusion] = `不成立（R58 核错，已插修正行，键 ${key}）`;
  else if (hadR52.has(key)) r[H.conclusion] = `不成立（R52c 已有修正行，键 ${key}）`;
  else r[H.conclusion] = '成立（R58 逐条对码核）';
  r[H.layer_status] = '已全核';
  n++;
}
const out = [head, ...rows].map((r) => r.map((v) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)).join(',')).join('\r\n') + '\r\n';
fs.writeFileSync(P, out, 'utf8');
const r58 = rows.filter((r) => r[H.batch] === 'R58');
console.log('updated', n, '| R58 成立', r58.filter((r) => r[H.conclusion].startsWith('成立')).length, '| 不成立', r58.filter((r) => r[H.conclusion].startsWith('不成立')).length);
console.log('remaining 未核', rows.filter((r) => r[H.layer_status] === '未核').length);
