// 全仓密度报告：按「需补行数」从大到小列出缺口文件，用于排批次。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = 'd:\\code\\opensource\\uv';
const BASE = 'd:\\code\\_annot_baseline\\UVR-D0BASE';
const OUT = 'd:\\code\\_annot_baseline\\uv-density-all.json';
const roots = fs
  .readFileSync('d:\\code\\_annot_baseline\\UVR-D0BASE\\_roots.txt', 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

const r = spawnSync(
  process.execPath,
  [
    'd:\\code\\_annot_baseline\\deep-density.mjs',
    ROOT,
    '--baseline',
    BASE,
    '--root',
    roots.join(','),
    '--mode',
    'code',
    '--threshold',
    '30',
    '--json',
    OUT,
    '--quiet',
  ],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const summaryLine = (r.stdout || '').trim().split(/\r?\n/).filter((l) => l.startsWith('SUMMARY'));
console.log(summaryLine.join('\n') || r.stdout || r.stderr);

const data = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const rows = data.rows.slice().sort((a, b) => b.need - a.need || a.measured - b.measured);
const top = Number(process.argv[2] ?? 25);
for (const row of rows.slice(0, top)) {
  if (row.need <= 0) break;
  console.log(`${row.need}\t${row.measured.toFixed(2)}%\t${row.code}\t${row.path}`);
}
