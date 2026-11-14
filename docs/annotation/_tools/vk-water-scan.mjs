// 回扫：对 valkey 所有新增注释行（相对 HEAD）跑 zc-gate judgeEntries。
// 口径：新增行中属于 //、/*、*、*/ 的行计入；内容去掉注释符号后送判据；
//       纯分隔线（----、==== 等）不计入条目。输出按 waterLines 降序。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { judgeEntries, isSep } from './zc-gate.mjs';

const ROOT = process.env.VK_ROOT || 'd:\\code\\opensource\\valkey';
const git = (args) =>
  spawnSync('git', ['--no-pager', ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const listed = git(['diff', '--name-only', 'HEAD', '--', 'src']);
if (listed.status !== 0) {
  console.error('git diff --name-only failed');
  process.exit(2);
}
const files = listed.stdout.split(/\r?\n/).map((s) => s.trim()).filter((f) => /\.(c|h)$/.test(f));

const rows = [];
for (const rel of files) {
  const r = git(['diff', '-U0', 'HEAD', '--', rel]);
  if (r.status !== 0) {
    console.error('FAIL ' + rel);
    process.exit(2);
  }
  const entries = [];
  let n = 0;
  let inBlock = false; // 仅跟踪“本次新增行”打开的块注释，避免把代码行 *p 当成注释
  for (const line of r.stdout.split(/\r?\n/)) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      n = Number(h[1]);
      inBlock = false;
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      const t = line.slice(1).trim();
      const startsLine = t.startsWith('//');
      const startsBlock = t.startsWith('/*');
      const starLine = t.startsWith('*');
      let isComment = false;
      if (inBlock) {
        isComment = true;
        if (t.includes('*/')) inBlock = false;
      } else if (startsLine) {
        isComment = true;
      } else if (startsBlock) {
        isComment = true;
        if (!t.includes('*/')) inBlock = true;
      } else if (starLine && t.endsWith('*/')) {
        isComment = true;
      }
      if (isComment) {
        const content = t
          .replace(/^\/\/\s?/, '')
          .replace(/^\/\*+\s?/, '')
          .replace(/^\*\s?/, '')
          .replace(/\*\/$/, '')
          .trim();
        if (content && !isSep(content)) entries.push({ line: n, content });
      }
      n++;
    } else if (line.startsWith(' ')) {
      n++;
    }
  }
  if (!entries.length) continue;
  const findings = judgeEntries(entries);
  const hit = new Set();
  for (const f of findings) for (let l = f.line; l <= f.endLine; l++) hit.add(l);
  const kinds = {};
  for (const f of findings) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
  rows.push({ rel, added: entries.length, water: hit.size, findings, kinds });
}

rows.sort((a, b) => b.water - a.water || b.added - a.added);
const bad = rows.filter((r) => r.findings.length > 0);
const out = [];
out.push('FILE\tadded\twater\twaterRate%\tfindings\tkinds');
for (const r of bad) {
  const rate = ((r.water / r.added) * 100).toFixed(2);
  const kinds = Object.entries(r.kinds).map(([k, v]) => k + ':' + v).join(',');
  out.push(`${r.rel}\t${r.added}\t${r.water}\t${rate}\t${r.findings.length}\t${kinds}`);
}
const ta = rows.reduce((s, r) => s + r.added, 0);
const tw = rows.reduce((s, r) => s + r.water, 0);
out.push(
  `TOTAL files=${rows.length} badFiles=${bad.length} added=${ta} water=${tw} rate=${ta ? ((tw / ta) * 100).toFixed(2) : '0.00'}% clean=${rows.length - bad.length}`,
);
fs.writeFileSync('d:\\code\\_annot_baseline\\vk-water-scan.tsv', out.join('\n') + '\n', 'utf8');
console.log(out.join('\n'));
