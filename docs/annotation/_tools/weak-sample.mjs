// 预登记抽样：从 22aa802 的自有 weak 中按文件分层抽 60 行（seed 固定，抽完不改规则）
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const REPO = 'd:/code/opensource/valkey';
const TARGET = '22aa802';
const N = 60;
const SEED = 20261110;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);

const q = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/quality-now.json', 'utf8'));
const ex = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/weak-exemptions.json', 'utf8'));
const up = new Map(ex.files.map((f) => [f.file, new Set(f.items.map((i) => i.line))]));

const full = execFileSync('git', ['rev-parse', TARGET], { cwd: REPO, encoding: 'utf8' }).trim();

const perFile = new Map();
for (const r of q.rows) {
  const s = up.get(r.path) || new Set();
  const own = (r.weakLines || []).filter((w) => !s.has(w.line));
  if (!own.length) continue;
  // blame 只跑有自有 weak 的文件
  const out = execFileSync('git', ['blame', '--line-porcelain', '--', r.path], { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const map = new Map();
  const arr = out.split('\n');
  for (let i = 0; i < arr.length; i++) {
    const m = /^([0-9a-f]{40}) \d+ (\d+) (\d+)$/.exec(arr[i]);
    if (!m) continue;
    for (let k = 0; k < Number(m[3]); k++) map.set(Number(m[2]) + k, m[1]);
  }
  const hits = own.filter((w) => map.get(w.line) === full).map((w) => w.line);
  if (hits.length) perFile.set(r.path, hits);
}

const total = [...perFile.values()].reduce((s, a) => s + a.length, 0);
const files = [...perFile.entries()].sort((a, b) => b[1].length - a[1].length);
// 按比例取整 + 最大余数分配 60 行；份额为 0 的文件不进样本（58 个文件每个至少 1 行会把样本摊成
// 「每个文件一行」，失去分层意义）。规则在评审前固定，不因结果调整。
const raw = files.map(([file, lines]) => {
  const exact = N * lines.length / total;
  return { file, lines, n: Math.floor(exact), frac: exact - Math.floor(exact) };
});
let sum = raw.reduce((s, x) => s + x.n, 0);
const order = [...raw].sort((a, b) => b.frac - a.frac || b.lines.length - a.lines.length);
for (let i = 0; sum < N; i++) { order[i % order.length].n++; sum++; }
const alloc = raw.filter((x) => x.n > 0);

const sample = [];
for (const { file, lines, n } of alloc) {
  const pool = [...lines];
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rnd() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
    sample.push({ file, line: pool[i] });
  }
}
sample.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

fs.writeFileSync('d:/code/_annot_baseline/weak-sample-22aa802.json', JSON.stringify({ target: full, seed: SEED, total, sample }, null, 2));

// 生成评审表（只含注释与上下文代码，不含任何结论）
const md = ['# weak 抽样复核（22aa802，预登记 60 行）', '', `提交：\`${TARGET}\`（${full.slice(0, 7)}）　seed=${SEED}　总体=${total} 行　样本=${sample.length} 行`, '',
  '| # | 文件:行 | 注释（遮码） | 紧随代码 |', '|---|---|---|---|'];
const cache = new Map();
sample.forEach((s, i) => {
  if (!cache.has(s.file)) cache.set(s.file, fs.readFileSync(`${REPO}/${s.file}`, 'utf8').split(/\r?\n/));
  const src = cache.get(s.file);
  const comment = src[s.line - 1].trim();
  let code = '';
  for (let k = s.line; k < Math.min(src.length, s.line + 3); k++) {
    if (src[k].trim()) { code = src[k].trim(); break; }
  }
  md.push(`| ${i + 1} | ${s.file}:${s.line} | ${comment.replace(/\|/g, '\\|')} | \`${code.replace(/\|/g, '\\|')}\` |`);
});
fs.writeFileSync('d:/code/_annot_baseline/weak-sample-22aa802.md', md.join('\n') + '\n');
console.log('files', files.length, 'total', total, 'sample', sample.length);
for (const a of alloc) console.log(a.file, a.lines.length, '->', a.n);
