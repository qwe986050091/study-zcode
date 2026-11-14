// 打印本轮 6 个核心文件的前后密度对比
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const REPO = 'd:\\code\\opensource\\crossbeam';
const BASE = 'd:\\code\\_annot_baseline\\CB-crossbeam-deep';
const TARGETS = [
  'crossbeam-epoch/src/collector.rs',
  'crossbeam-epoch/src/guard.rs',
  'crossbeam-epoch/src/internal.rs',
  'crossbeam-epoch/src/sync/queue.rs',
  'crossbeam-epoch/src/epoch.rs',
  'crossbeam-deque/src/deque.rs',
];
const json = 'd:\\code\\_annot_baseline\\_cb_deep_cmp.json';

const r = spawnSync(process.execPath, [
  'd:/code/_annot_baseline/deep-density.mjs', REPO,
  '--baseline', BASE,
  '--root', 'crossbeam-epoch/src,crossbeam-deque/src',
  '--ext', '.rs', '--threshold', '30', '--mode', 'code',
  '--only', TARGETS.join(','),
  '--json', json, '--quiet',
], { encoding: 'utf8' });
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);

const j = JSON.parse(fs.readFileSync(json, 'utf8'));
let sumLines = 0, sumNew = 0;
for (const f of TARGETS) {
  const x = j.rows.find((row) => row.path.replace(/\\/g, '/') === f);
  if (!x) { console.log(f + '\tMISS'); continue; }
  const before = ((x.comment - (x.newComments || 0)) / x.code) * 100;
  sumLines += x.code;
  sumNew += x.newComments || 0;
  console.log(`${f}\tcode=${x.code}\tcomment=${x.comment}\tbefore=${before.toFixed(2)}%\tafter=${x.measured.toFixed(2)}%\t+${x.newComments}`);
}
const tot = j.rows.reduce((a, x) => a + x.comment, 0);
const totCode = j.rows.reduce((a, x) => a + x.code, 0);
const totBefore = j.rows.reduce((a, x) => a + (x.comment - (x.newComments || 0)), 0);
console.log(`TOTAL\tcode=${totCode}\tbefore=${((totBefore / totCode) * 100).toFixed(2)}%\tafter=${((tot / totCode) * 100).toFixed(2)}%\t+${sumNew}`);
