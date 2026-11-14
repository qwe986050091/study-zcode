// 提交后复核：以 5854600~1 为基线，重算 B71 的 added/extra/water（与 vk-gate batch 同一组判据）。
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { judgeBlocks, commentMap } from './vk-gate.mjs';

const repo = 'd:/code/opensource/valkey';
const base = '5854600~1';
const head = '5854600';
const rel = 'src/functions.c';
const diff = execSync(`git diff -U0 ${base} ${head} -- ${rel}`, { cwd: repo, maxBuffer: 1e8 }).toString();
// 从 hunk 头累加新增行数，并收集新增行内容（与 commentMap 的行号对齐需要新文件侧行号）。
const added = [];
let newLine = 0;
for (const l of diff.split('\n')) {
  const m = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (m) { newLine = Number(m[1]); continue; }
  if (l.startsWith('+') && !l.startsWith('+++')) { added.push(newLine); newLine++; }
  else if (l.startsWith(' ')) newLine++;
}
const cm = commentMap(repo + '/' + rel);
const entries = added.filter((n) => cm.has(n)).map((n) => ({ line: n, content: cm.get(n) }));
const { findings } = judgeBlocks(entries);
const declared = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/VK-B71/out-functions.json', 'utf8'));
const nDecl = Array.isArray(declared) ? declared.length : (declared.entries || []).length;
console.log(JSON.stringify({ added: added.length, comments: entries.length, declared: nDecl, extra: entries.length - nDecl, w: findings.length, waterRate: ((findings.length / entries.length) * 100).toFixed(2) + '%' }));
