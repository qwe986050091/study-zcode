// 回填批次 10% 抽样：从 git diff 新增的注释行里每 10 条取 1 条，打印文件:行 与注释原文 + 其下 2 行代码。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repo = 'd:/code/opensource/uv';
const listPath = 'd:/code/_annot_baseline/uv-rework/b2-files.txt';
const outPath = 'd:/code/_annot_baseline/uv-rework/b2-sample10.txt';
const files = fs.readFileSync(listPath, 'utf8').split(/\r?\n/).filter((x) => x.startsWith('crates/'));

const added = [];
for (const rel of files) {
  const diff = spawnSync('git', ['-C', repo, 'diff', '-U0', '--', rel], { encoding: 'utf8' }).stdout;
  let newLine = 0;
  for (const l of diff.split(/\r?\n/)) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m) { newLine = Number(m[1]); continue; }
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) {
      if (/^\+\s*\/\//.test(l)) added.push({ rel, line: newLine, text: l.slice(1) });
      newLine++;
    }
  }
}

const N = 10;
const picks = [];
for (let i = 0; i < added.length; i += N) picks.push(added[i]);

const lines = [];
for (const p of picks) {
  const abs = path.join(repo, p.rel);
  const src = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const code = [src[p.line], src[p.line + 1]].filter((x) => x !== undefined && x.trim() !== '');
  lines.push(`${p.rel}:${p.line}  ${p.text.trim()}`);
  for (const c of code) lines.push(`      ↳ ${c.trim()}`);
}
fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
console.log(`addedCommentLines=${added.length} sampled=${picks.length} (every ${N}th)`);
console.log(lines.join('\n'));
