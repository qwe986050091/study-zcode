// 逐批 gm-verify 结果与 README 批次表对比。
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const BASE = 'd:/code/_annot_baseline';
const README = 'd:/code/opensource/gemini-cli/docs/annotation/README-summary.md';
const dirs = readdirSync(BASE).filter(d => /^GC-deep-b\d+$/.test(d) && existsSync(path.join(BASE, d, '_files.txt')))
  .sort((a, b) => Number(a.split('-b')[1]) - Number(b.split('-b')[1]));

const table = new Map();
for (const line of readFileSync(README, 'utf8').split(/\r?\n/)) {
  const m = /^\| (GC-deep-b\d+) \|.*\| ([\d,]+) \| \+([\d,]+) \|/.exec(line);
  if (m) table.set(m[1], { files: Number(m[2].replace(/,/g, '')), added: Number(m[3].replace(/,/g, '')) });
}

let files = 0, added = 0;
const diff = [];
for (const d of dirs) {
  const r = spawnSync(process.execPath, [path.join(BASE, 'gm-verify.mjs'), d], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('SUMMARY '));
  const g = Object.fromEntries(line.slice(8).trim().split(' ').map(kv => kv.split('=')));
  files += Number(g.files); added += Number(g.added);
  const t = table.get(d);
  if (!t) { diff.push(`${d} 缺失表格行 (verify files=${g.files} added=${g.added})`); continue; }
  if (t.files !== Number(g.files) || t.added !== Number(g.added))
    diff.push(`${d} 表格 files=${t.files} added=${t.added} | 实测 files=${g.files} added=${g.added}`);
  if (g.deletedNonZero !== '0' || g.syntaxErr !== '0' || g.commentViolations !== '0' || g.diffFailures !== '0' || r.status !== 0)
    diff.push(`${d} 校验异常: ${line}`);
}
console.log(`batches=${dirs.length} manifestEntries=${files} added=${added} tableRows=${table.size} mismatches=${diff.length}`);
for (const x of diff) console.log(x);
