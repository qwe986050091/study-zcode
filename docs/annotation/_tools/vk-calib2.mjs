// 第二轮校准抽样：从当前全部 W 中按文件分层抽 100 条，覆盖所有 badFile。
// 输出 vk-calib2.tsv：file \t line \t content
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commentMap, diffAdded, judgeBlocks } from './vk-gate.mjs';

const REPO = 'd:/code/opensource/valkey';
const BASE = 'd:/code/_annot_baseline';
const rels = spawnSync('git', ['diff', '--name-only', 'HEAD', '--', 'src'], { cwd: REPO, encoding: 'utf8' })
  .stdout.split('\n')
  .map((s) => s.trim())
  .filter((s) => /\.(c|h)$/.test(s));

const perFile = [];
for (const rel of rels) {
  const cm = commentMap(path.join(REPO, rel));
  const { added } = diffAdded(rel, REPO);
  const entries = added.filter((n) => cm.has(n)).map((n) => ({ line: n, content: cm.get(n) }));
  const { findings } = judgeBlocks(entries);
  if (findings.length) perFile.push({ rel, findings });
}

// 分层：先每个文件取 1 条，剩余名额按各文件剩余 W 数量轮转，保证覆盖 30 个 badFile。
const quota = new Map(perFile.map((f) => [f.rel, 0]));
let budget = 100;
for (const f of perFile) {
  if (!budget) break;
  quota.set(f.rel, 1);
  budget--;
}
let progressed = true;
while (budget > 0 && progressed) {
  progressed = false;
  for (const f of perFile) {
    if (!budget) break;
    if (quota.get(f.rel) < f.findings.length) {
      quota.set(f.rel, quota.get(f.rel) + 1);
      budget--;
      progressed = true;
    }
  }
}

const rows = [];
for (const f of perFile) {
  const n = quota.get(f.rel);
  // 等距抽取，避免只取文件开头
  const step = f.findings.length / n;
  for (let i = 0; i < n; i++) {
    const idx = Math.min(f.findings.length - 1, Math.floor(i * step));
    const w = f.findings[idx];
    rows.push(`${f.rel}\t${w.line}\t${w.lines.join(' ⏎ ')}`);
  }
}
fs.writeFileSync(path.join(BASE, 'vk-calib2.tsv'), rows.join('\n') + '\n', 'utf8');
console.log(`badFiles=${perFile.length} W=${perFile.reduce((s, f) => s + f.findings.length, 0)} sample=${rows.length}`);
for (const f of perFile) console.log(`${f.rel}\tW=${f.findings.length}\tsampled=${quota.get(f.rel)}`);
