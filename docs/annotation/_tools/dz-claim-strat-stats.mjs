// 分层抽样的点估计与区间：按 R52-claim-sample.json + R52-claim-results.tsv 汇总。
// 区间用 Clopper-Pearson 单侧 95% 上界（k=0 时退化为 1-0.05^(1/n)）。
import fs from 'node:fs';

const plan = JSON.parse(fs.readFileSync('R52-claim-sample.json', 'utf8'));
const verdict = new Map();
for (const line of fs.readFileSync('R52-claim-results.tsv', 'utf8').split(/\r?\n/)) {
  const [k, v] = line.split(/\t/);
  if (k && v) verdict.set(k, v);
}

const binomCdf = (k, n, p) => {
  let s = 0, c = 1;
  for (let i = 0; i <= k; i++) {
    if (i > 0) c = c * (n - i + 1) / i;
    s += c * Math.pow(p, i) * Math.pow(1 - p, n - i);
  }
  return s;
};
const cpUpper = (k, n, alpha = 0.05) => {
  if (k >= n) return 1;
  let lo = k / n, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (binomCdf(k, n, mid) > alpha) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
};

const layerErr = new Set();
for (const line of fs.readFileSync('R52-layer-results.tsv', 'utf8').split(/\r?\n/)) {
  const [k, v] = line.split(/\t/);
  if (k && v === '不成立') layerErr.add(k);
}
const fullLayer = new Map();
const addFull = (id, claims) => {
  const k = claims.filter((c) => layerErr.has(c.key)).length;
  fullLayer.set(id, { pop: claims.length, s: claims.length, k });
};
const biran = JSON.parse(fs.readFileSync('R52-layer-biran.json', 'utf8'));
addFull('必然 @ orm', biran.filter((c) => c.file.startsWith('drizzle-orm/')));
addFull('必然 @ kit', biran.filter((c) => !c.file.startsWith('drizzle-orm/')));
addFull('一律 @ orm', JSON.parse(fs.readFileSync('R52-layer-yilv-orm.json', 'utf8')));
addFull('一律 @ kit', JSON.parse(fs.readFileSync('R52-layer-yilv-kit.json', 'utf8')));

const layers = new Map();
for (const c of plan.sample) {
  const kw = c.kw;
  const id = `${kw} @ ${c.dir}`;
  if (!layers.has(id)) layers.set(id, { id, kw, dir: c.dir, pop: 0, s: 0, k: 0, unsure: 0, structS: 0, structK: 0 });
  const L = layers.get(id);
  L.s++;
  const v = verdict.get(c.key);
  if (v === '不成立') L.k++;
  else if (v === '存疑') L.unsure++;
  if (c.structural) { L.structS++; if (v === '不成立') L.structK++; }
}
for (const l of plan.layers) {
  const L = layers.get(l.id);
  if (!L) continue;
  const f = fullLayer.get(l.id);
  if (f) { L.pop = f.pop; L.s = f.s; L.k = f.k; L.unsure = 0; L.full = true; } else L.pop = l.size;
}

console.log('层\t规模\t抽样\t不成立\t存疑\t错误率\t95%上界');
let est = 0, varSum = 0, N = 0, S = 0, K = 0, unsureAll = 0;
for (const L of [...layers.values()].sort((a, b) => b.pop - a.pop)) {
  const p = L.k / L.s;
  const ub = cpUpper(L.k, L.s);
  console.log(`${L.id}${L.full ? '*' : ''}\t${L.pop}\t${L.s}\t${L.k}\t${L.unsure}\t${(p * 100).toFixed(1)}%\t${(ub * 100).toFixed(1)}%`);
  est += L.pop * p;
  varSum += L.pop * L.pop * p * (1 - p) / L.s;
  N += L.pop; S += L.s; K += L.k; unsureAll += L.unsure;
}
const se = Math.sqrt(varSum);
console.log(`\n总体：N=${N} 抽样=${S} 不成立=${K} 存疑=${unsureAll} 合并错误率=${(K / S * 100).toFixed(1)}%`);
console.log(`全仓估计假话=${Math.round(est)} 条，95%CI≈[${Math.round(est - 1.96 * se)}, ${Math.round(est + 1.96 * se)}]（SE=${se.toFixed(1)}）`);

let ss = 0, sk = 0, bs = 0, bk = 0;
for (const c of plan.sample) {
  const v = verdict.get(c.key);
  if (c.structural) { ss++; if (v === '不成立') sk++; } else { bs++; if (v === '不成立') bk++; }
}
console.log(`结构型：${sk}/${ss} = ${(sk / ss * 100).toFixed(1)}%（95%上界 ${(cpUpper(sk, ss) * 100).toFixed(1)}%）`);
console.log(`行为型：${bk}/${bs} = ${(bk / bs * 100).toFixed(1)}%（95%上界 ${(cpUpper(bk, bs) * 100).toFixed(1)}%）`);

const flag = [...layers.values()].filter((L) => L.k / L.s > 0.05).sort((a, b) => b.pop - a.pop);
console.log(`\n错误率 >5% 的层：${flag.length} 个`);
for (const L of flag) console.log(`${L.id}\t规模=${L.pop}\t${L.k}/${L.s}`);
