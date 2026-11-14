// 汇总各批次 _files.txt 的去重文件，按最早批次的 orig 快照为基线，
// 统计当前仓库相对基线的 added 行数（= 累计新增注释行），并与批次表求和对比。
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const BASE = 'd:/code/_annot_baseline';
const REPO = 'd:/code/opensource/gemini-cli';
const dirs = execFileSync('powershell', ['-NoProfile', '-Command',
  `Get-ChildItem '${BASE}' -Directory -Filter 'GC-deep-b*' | Sort-Object Name | Select-Object -ExpandProperty Name`],
  { encoding: 'utf8' }).split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  .sort((a, b) => Number(a.split('-b')[1]) - Number(b.split('-b')[1]));

const firstBatch = new Map(); // rel -> {batch, lines}
for (const d of dirs) {
  const f = path.join(BASE, d, '_files.txt');
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const [rel, lines] = t.split('\t');
    const r = rel.replace(/\\/g, '/');
    if (!firstBatch.has(r)) firstBatch.set(r, { batch: d, lines: Number(lines) });
  }
}

function numstat(a, b) {
  try {
    return execFileSync('git', ['diff', '--no-index', '--numstat', '--', a, b], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    if (e.status === 1 && typeof e.stdout === 'string') return e.stdout.trim();
    throw new Error(e.message);
  }
}

let added = 0, touched = 0, missing = 0;
const rows = [];
for (const [rel, { batch, lines }] of [...firstBatch.entries()].sort()) {
  const base = path.join(BASE, batch, 'orig', rel);
  const cur = path.join(REPO, rel);
  if (!existsSync(base) || !existsSync(cur)) { missing++; rows.push([rel, batch, 'MISSING']); continue; }
  const out = numstat(base, cur);
  let a = 0, d = 0;
  if (out) { const [x, y] = out.split('\n')[0].split('\t'); a = x === '-' ? 0 : Number(x); d = y === '-' ? 0 : Number(y); }
  added += a;
  if (a > 0) touched++;
  if (d > 0) rows.push([rel, batch, `deleted=${d}`]);
  if (a > 0 && !existsSync(base)) rows.push([rel, batch, 'NO_BASE_ADDED']);
}
console.log(`unique=${firstBatch.size} touched=${touched} added=${added} deletedBatches=${rows.length} missing=${missing}`);
for (const r of rows) console.log(r.join(' | '));
