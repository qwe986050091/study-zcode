// 语义近重复扫描：把「本线新增注释」与「另一条线新增注释」按邻近窗口做字符二元组相似度比对。
// 用法：node sim-scan.mjs <repo> <rel> <threshold> <ourEntries.json> [...]
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const [repo, rel, thRaw, ...jsonFiles] = process.argv.slice(2);
const TH = Number(thRaw) || 0.5;
const diff = execFileSync('git', ['-C', repo, 'diff', '-U0', '--', rel], { encoding: 'utf8' });
const added = new Set();
for (const l of diff.split(/\r?\n/)) {
  const m = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
  if (!m) continue;
  const st = Number(m[1]);
  const c = m[2] === undefined ? 1 : Number(m[2]);
  for (let i = 0; i < c; i++) added.add(st + i);
}
const file = repo.replace(/\\+$/, '') + '\\' + rel.replace(/\//g, '\\');
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const norm = (s) => s.replace(/\s+/g, '');

const ours = [];
for (const f of jsonFiles) {
  if (!fs.existsSync(f)) continue;
  const arr = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
  if (!Array.isArray(arr)) continue;
  for (const e of arr) {
    const ls = e.lines || e.comment || e.text || [];
    const block = Array.isArray(ls) ? ls : String(ls).split(/\r?\n/);
    for (const b of block) {
      const t = norm(String(b));
      if (t) ours.push(t);
    }
  }
}
const ourSet = new Set(ours);

const addedIdx = [...added].filter((i) => /^\s*\/\//.test(lines[i - 1])).sort((a, b) => a - b);
const others = addedIdx.filter((i) => !ourSet.has(norm(lines[i - 1])));
const ourIdx = addedIdx.filter((i) => ourSet.has(norm(lines[i - 1])));

function bigrams(s) {
  const t = s.replace(/[^\u4e00-\u9fffA-Za-z0-9_]/g, '');
  const g = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const k = t.slice(i, i + 2);
    g.set(k, (g.get(k) || 0) + 1);
  }
  return g;
}
function sim(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  let union = 0;
  for (const [k, v] of A) {
    union += v;
    if (B.has(k)) inter += Math.min(v, B.get(k));
  }
  for (const [k, v] of B) if (!A.has(k)) union += v;
  return union ? inter / union : 0;
}

let hits = 0;
const out = [];
for (const la of ourIdx) {
  for (const lb of others) {
    if (Math.abs(la - lb) > 12) continue;
    const s = sim(norm(lines[la - 1]), norm(lines[lb - 1]));
    if (s >= TH) {
      hits++;
      out.push({ la, lb, s, a: lines[la - 1].trim(), b: lines[lb - 1].trim() });
    }
  }
}
out.sort((x, y) => y.s - x.s);
console.log(`FILE ${rel} added=${addedIdx.length} ours=${ourIdx.length} other=${others.length} pairs>=${TH}: ${hits}`);
for (const o of out.slice(0, 40)) {
  console.log(`SIM ${o.s.toFixed(2)} oursL${o.la} otherL${o.lb}`);
  console.log(`   ours : ${o.a.slice(0, 120)}`);
  console.log(`   other: ${o.b.slice(0, 120)}`);
}
