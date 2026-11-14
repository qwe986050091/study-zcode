// 统计批次范围内逐文件新增：注释行 / 空行 拆分（相对最早批次 orig 基线）。
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const BASE = 'd:/code/_annot_baseline';
const REPO = 'd:/code/opensource/gemini-cli';
const dirs = execFileSync('powershell', ['-NoProfile', '-Command',
  `Get-ChildItem '${BASE}' -Directory -Filter 'GC-deep-b*' | Select-Object -ExpandProperty Name`],
  { encoding: 'utf8' }).split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  .sort((a, b) => Number(a.split('-b')[1]) - Number(b.split('-b')[1]));

const firstBatch = new Map();
for (const d of dirs) {
  const f = path.join(BASE, d, '_files.txt');
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const [rel] = t.split('\t');
    const r = rel.replace(/\\/g, '/');
    if (!firstBatch.has(r)) firstBatch.set(r, d);
  }
}

function patch(a, b) {
  try {
    return execFileSync('git', ['diff', '--no-index', '-U0', '--no-color', '--', a, b], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e.status === 1 && typeof e.stdout === 'string') return e.stdout;
    throw new Error(e.message);
  }
}

let comment = 0, blank = 0, del = 0, touched = 0;
for (const [rel, batch] of firstBatch.entries()) {
  const base = path.join(BASE, batch, 'orig', rel);
  const cur = path.join(REPO, rel);
  if (!existsSync(base) || !existsSync(cur)) continue;
  let c = 0, b = 0, d = 0;
  for (const line of patch(base, cur).split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')) continue;
    if (line.startsWith('+')) { const t = line.slice(1).trim(); if (t === '') b++; else c++; }
    else if (line.startsWith('-')) d++;
  }
  comment += c; blank += b; del += d;
  if (c > 0 || b > 0) touched++;
}
console.log(`files=${firstBatch.size} touched=${touched} addedComments=${comment} addedBlank=${blank} totalAdded=${comment + blank} deleted=${del}`);
