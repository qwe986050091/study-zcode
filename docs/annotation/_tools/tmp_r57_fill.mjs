// R57 断言核验回填：41 条（一律@kit 25 + 必然@kit 16）
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
const fail = new Set(['8c30760a', '3ac806d7', 'a691a516', '49894536', 'd407b679', '3492d44b', 'ca47596f', 'ee344be6', '56fd8b20']);
const hadR52 = new Set(['8c30760a','a37e20d5','a691a516','ae2f1554','49894536','769e8b43','f9bbd98d','84fbccc6','d407b679','4cf5c484','3e8136a5','3492d44b','ca47596f','e8c55b92','872b4911','0805d392','56fd8b20','016c6d4d']);
let n = 0;
for (const r of rows) {
  if (r[H.batch] !== 'R57') continue;
  const key = r[H.key];
  const isFail = fail.has(key);
  r[H.conclusion] = isFail
    ? `不成立（R52c 已有修正行，键 ${key}）`
    : (hadR52.has(key) ? '成立（R57 逐条核，与 R52 一致）' : '成立（R57 首判）');
  r[H.layer_status] = '已全核';
  n++;
}
const out = [head, ...rows].map((r) => r.map((v) => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)).join(',')).join('\r\n') + '\r\n';
fs.writeFileSync(P, out, 'utf8');
const stat = {};
for (const r of rows) {
  const k = r[H.layer_status] + '/' + r[H.source];
  stat[k] = (stat[k] || 0) + 1;
}
console.log('updated', n, stat);
console.log('remaining 未核', rows.filter((r) => r[H.layer_status] === '未核').length);
console.log('不成立', rows.filter((r) => r[H.batch] === 'R57' && r[H.conclusion].startsWith('不成立')).length);
