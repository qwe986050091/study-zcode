// 全批复核：逐个批次运行 gm-verify，汇总 added / 违规计数。
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const BASE = 'd:/code/_annot_baseline';
const dirs = readdirSync(BASE).filter(d => /^GC-deep-b\d+$/.test(d) && existsSync(path.join(BASE, d, '_files.txt')))
  .sort((a, b) => Number(a.split('-b')[1]) - Number(b.split('-b')[1]));
let files = 0, added = 0, bad = [];
for (const d of dirs) {
  const r = spawnSync(process.execPath, [path.join(BASE, 'gm-verify.mjs'), d], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('SUMMARY '));
  if (!line) { bad.push(d + ' NO_SUMMARY'); continue; }
  const g = Object.fromEntries(line.slice(8).trim().split(' ').map(kv => kv.split('=')));
  files += Number(g.files); added += Number(g.added);
  if (g.deletedNonZero !== '0' || g.syntaxErr !== '0' || g.commentViolations !== '0' || g.diffFailures !== '0' || r.status !== 0)
    bad.push(d + ' ' + line);
}
console.log(`batches=${dirs.length} manifestEntries=${files} added=${added} bad=${bad.length}`);
for (const b of bad) console.log(b);
