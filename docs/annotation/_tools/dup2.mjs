// 双写语义比对（快照口径）：ours = 本线快照→当前的新增注释；other = 相对 HEAD 新增但不在 ours 的注释。
// 用法：node dup2.mjs <repo> <rel> <snapshotAbsPath> <threshold> [ourExtraEntries.json ...]
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const [repo, rel, snap, thRaw, ...extraJson] = process.argv.slice(2);
const TH = Number(thRaw) || 0.5;
const cur = repo.replace(/\\+$/, '') + '\\' + rel.replace(/\//g, '\\');
const lines = fs.readFileSync(cur, 'utf8').split(/\r?\n/);
const norm = (s) => s.replace(/\s+/g, '');

function addedFromDiff(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  const d = r.stdout || '';
  const set = new Set();
  for (const l of d.split(/\r?\n/)) {
    const m = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    const st = Number(m[1]);
    const c = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < c; i++) set.add(st + i);
  }
  return set;
}

const vsHead = addedFromDiff(['-C', repo, 'diff', '-U0', '--', rel]);
const vsSnap = addedFromDiff(['diff', '--no-index', '--no-color', '-U0', snap, cur]);
const isComment = (i) => /^\s*\/\//.test(lines[i - 1] || '');
const ourIdx = [...vsSnap].filter(isComment).sort((a, b) => a - b);
const otherIdx = [...vsHead].filter((i) => isComment(i) && !vsSnap.has(i)).sort((a, b) => a - b);
const ourSet = new Set(ourIdx.map((i) => norm(lines[i - 1])));

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

const out = [];
for (const la of ourIdx) {
  for (const lb of otherIdx) {
    if (Math.abs(la - lb) > 12) continue;
    const s = sim(norm(lines[la - 1]), norm(lines[lb - 1]));
    if (s >= TH) out.push({ la, lb, s });
  }
}
out.sort((x, y) => y.s - x.s);
console.log(`FILE ${rel} vsHEAD=${[...vsHead].filter(isComment).length} ours=${ourIdx.length} other=${otherIdx.length} pairs>=${TH}=${out.length}`);
for (const o of out.slice(0, 30)) {
  console.log(`SIM ${o.s.toFixed(2)} L${o.la}(ours) / L${o.lb}(other)`);
  console.log(`   ours : ${lines[o.la - 1].trim().slice(0, 130)}`);
  console.log(`   other: ${lines[o.lb - 1].trim().slice(0, 130)}`);
}
