// 22aa802 自有 weak 的句式聚类：归一化 -> 模板 -> top30 各抽 3 条
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const REPO = 'd:/code/opensource/valkey';
const q = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/quality-now.json', 'utf8'));
const ex = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/weak-exemptions.json', 'utf8'));
const up = new Map();
for (const f of ex.files) up.set(f.file, new Set(f.items.map((i) => i.line)));

const own = [];
for (const r of q.rows) {
  if (!r.weakLines || !r.weakLines.length) continue;
  const upstream = up.get(r.path) || new Set();
  for (const w of r.weakLines) if (!upstream.has(w.line)) own.push({ path: r.path, line: w.line });
}

const target = execFileSync('git', ['rev-parse', '22aa802'], { cwd: REPO, encoding: 'utf8' }).trim();
const blameByFile = new Map();
for (const path of new Set(own.map((o) => o.path))) {
  const out = execFileSync('git', ['blame', '--line-porcelain', '--', path], { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const map = new Map();
  const arr = out.split('\n');
  for (let i = 0; i < arr.length; i++) {
    const m = /^([0-9a-f]{40}) \d+ (\d+) (\d+)$/.exec(arr[i]);
    if (!m) continue;
    const start = Number(m[2]), count = Number(m[3]);
    for (let k = 0; k < count; k++) map.set(start + k, m[1]);
  }
  blameByFile.set(path, map);
}

const cache = new Map();
const readFile = (p) => {
  if (!cache.has(p)) cache.set(p, fs.readFileSync(`${REPO}/${p}`, 'utf8').split(/\r?\n/));
  return cache.get(p);
};

const norm = (s) => {
  let t = s.trim().replace(/^\/\/+/, '').replace(/^\/\*+/, '').replace(/\*\/$/, '').replace(/^\*+/, '').trim();
  t = t.replace(/`[^`]*`/g, '<ID>');
  t = t.replace(/[A-Za-z_][A-Za-z0-9_.:>-]*/g, '<ID>');
  t = t.replace(/\d+(\.\d+)?/g, '<N>');
  t = t.replace(/[（(][^）)]*[）)]/g, '(<X>)');
  t = t.replace(/[，。；：、,.;:!?！？"“”'‘’\s/\\|=+*<>-]/g, '');
  return t;
};

const rows = [];
for (const o of own) {
  const sha = blameByFile.get(o.path)?.get(o.line);
  if (sha !== target) continue;
  const L = readFile(o.path)[o.line - 1] || '';
  rows.push({ ...o, text: L.trim(), tpl: norm(L) });
}
console.log('22aa802 own weak =', rows.length);

const groups = new Map();
for (const r of rows) {
  if (!r.tpl) continue;
  if (!groups.has(r.tpl)) groups.set(r.tpl, []);
  groups.get(r.tpl).push(r);
}
const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
const top = sorted.slice(0, 30);
console.log('templates =', groups.size, 'top30 covers =', top.reduce((n, [, v]) => n + v.length, 0));

let seed = 20261110;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

const md = ['# 22aa802 weak 句式聚类：top 30 × 3 条（预登记）', '',
  `总体 ${rows.length} 行，模板 ${groups.size} 个；top30 覆盖 ${top.reduce((n, [, v]) => n + v.length, 0)} 行。抽样 seed=20261110，每模板 3 条。`, '',
  '| # | 模板（归一化） | 行数 | 样本 |', '|---|---|---:|---|'];
top.forEach(([tpl, list], i) => {
  const picks = [];
  const pool = list.slice();
  for (let k = 0; k < Math.min(3, pool.length); k++) picks.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  for (const p of picks) {
    const L = readFile(p.path);
    const code = [];
    for (let j = p.line; j < Math.min(L.length, p.line + 4) && code.length < 2; j++) {
      const s = L[j].trim();
      if (s && !s.startsWith('//') && !s.startsWith('/*') && !s.startsWith('*')) code.push(s);
    }
    md.push(`| T${i + 1} | ${tpl} | ${list.length} | \`${p.path}:${p.line}\`<br>注：${p.text.replace(/\|/g, '\\|')}<br>码：\`${code.join(' ⏎ ').replace(/\|/g, '\\|')}\` |`);
  }
});
fs.writeFileSync('d:/code/_annot_baseline/weak-templates-22aa802.md', md.join('\n'));
fs.writeFileSync('d:/code/_annot_baseline/weak-templates-22aa802.json', JSON.stringify(top.map(([tpl, list]) => ({ tpl, n: list.length, items: list })), null, 2));
console.log('written');
