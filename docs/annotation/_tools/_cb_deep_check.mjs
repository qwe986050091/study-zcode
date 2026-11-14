// 仅对真实源码（排除 5 个 alloc_helper.rs 符号链接占位）跑一次密度校验
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = 'd:\\code\\opensource\\crossbeam';
const roots = ['src', 'crossbeam-epoch/src', 'crossbeam-deque/src', 'crossbeam-queue/src',
  'crossbeam-channel/src', 'crossbeam-utils/src', 'crossbeam-skiplist/src'];

const out = [];
function walk(rel) {
  for (const ent of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
    const child = rel + '/' + ent.name;
    if (ent.isDirectory()) walk(child);
    else if (ent.name.endsWith('.rs')) out.push(child);
  }
}
for (const r of roots) walk(r);
const real = out.filter((p) => {
  if (!p.endsWith('/src/alloc_helper.rs')) return true;
  return fs.statSync(path.join(REPO, p)).size > 200; // 占位文件只有几十字节
});
const r = spawnSync(process.execPath, [
  'd:/code/_annot_baseline/deep-density.mjs', REPO,
  '--baseline', 'd:\\code\\_annot_baseline\\CB-crossbeam-deep',
  '--root', roots.join(','),
  '--ext', '.rs', '--threshold', '30', '--mode', 'code',
  '--only', real.join(','),
], { encoding: 'utf8' });
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
console.log('exit=' + r.status);
