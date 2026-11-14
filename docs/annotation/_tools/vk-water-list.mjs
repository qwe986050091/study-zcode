// 生成当前全部 W 的逐行清单：file \t line \t content（供人工判定）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commentMap, diffAdded, judgeBlocks } from './vk-gate.mjs';

const REPO = 'd:/code/opensource/valkey';
const rels = spawnSync('git', ['diff', '--name-only', 'HEAD', '--', 'src'], { cwd: REPO, encoding: 'utf8' })
  .stdout.split('\n')
  .map((s) => s.trim())
  .filter((s) => /\.(c|h)$/.test(s));

const rows = [];
for (const rel of rels) {
  const cm = commentMap(path.join(REPO, rel));
  const { added } = diffAdded(rel, REPO);
  const entries = added.filter((n) => cm.has(n)).map((n) => ({ line: n, content: cm.get(n) }));
  const { findings } = judgeBlocks(entries);
  for (const f of findings) rows.push({ file: rel, line: f.line, content: f.lines.join(' ⏎ ') });
}
rows.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
const out = ['file\tline\tcontent', ...rows.map((r) => `${r.file}\t${r.line}\t${r.content}`)].join('\n') + '\n';
fs.writeFileSync('d:/code/_annot_baseline/vk-water-list.tsv', out, 'utf8');
console.log(`rows=${rows.length} files=${new Set(rows.map((r) => r.file)).size}`);

