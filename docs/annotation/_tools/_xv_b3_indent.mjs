// 后处理：把新增的顶格 // 注释行缩进到紧跟其后的代码行的缩进，保持与上下文一致。
// 只处理“基线里不存在”的新行，原有注释一律不动。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = 'd:\\code\\opensource\\xv6-riscv';
const BASE = 'd:\\code\\_annot_baseline\\XV-xv6-riscv-b3';
const rels = fs
  .readFileSync(path.join(BASE, '_files.txt'), 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s.split(/\s+/)[0]);

for (const rel of rels) {
  const cur = path.join(ROOT, rel.split('/').join(path.sep));
  const base = path.join(BASE, rel.split('/').join(path.sep));
  const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '-U0', '--', base, cur], { encoding: 'utf8' });
  const raw = fs.readFileSync(cur, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(eol);
  const added = [];
  let n = 0;
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { n = Number(h[1]); continue; }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) { added.push(n); n++; }
    else if (line.startsWith(' ')) n++;
  }
  let changed = 0;
  for (const ln of added) {
    const idx = ln - 1;
    const t = lines[idx];
    if (!t || !t.startsWith('//')) continue;
    let j = idx + 1;
    while (j < lines.length && (lines[j].trim() === '' || lines[j].trimStart().startsWith('//'))) j++;
    if (j >= lines.length) continue;
    const m = /^[ \t]*/.exec(lines[j]);
    const ind = m ? m[0] : '';
    if (ind && !t.startsWith(ind)) {
      lines[idx] = ind + t;
      changed++;
    }
  }
  if (changed) {
    fs.writeFileSync(cur, lines.join(eol), 'utf8');
    console.log(`${rel}\tindented=${changed}`);
  }
}
