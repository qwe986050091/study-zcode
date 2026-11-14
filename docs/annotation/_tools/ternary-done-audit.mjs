import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const REPO = 'd:/code/opensource/valkey';
const TMP = 'd:/code/_annot_baseline/_ta.txt';
const list = [
  'src/fbtree.c', 'src/cluster_migrateslots.c', 'src/compression_stream.c', 'src/valkey-benchmark.c',
  'src/module.c', 'src/compression_lz4.c', 'src/cluster_legacy.c', 'src/call_reply.c',
  'src/config.c', 'src/debug.c', 'src/lzf_d.c', 'src/rdb.c', 'src/t_list.c',
  'src/valkey-check-rdb.c', 'src/cluster_slot_stats.c', 'src/expire.c', 'src/quicklist.c',
  'src/replication.c', 'src/sentinel.c', 'src/t_string.c', 'src/util.c', 'src/vset.c', 'src/crcspeed.c',
];
let total = 0;
for (const f of list) {
  try {
    execFileSync('node', ['d:/code/_annot_baseline/deep-quality.mjs', REPO, '--files', f, '--uncovered', TMP,
      '--json', 'd:/code/_annot_baseline/_ta.json'], { stdio: 'ignore' });
  } catch (e) { console.log('FAIL', f); continue; }
  const q = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/_ta.json', 'utf8')).rows[0];
  if (!q) continue;
  const raw = fs.readFileSync(TMP, 'utf8').trim();
  const lines = raw ? raw.split(/\r?\n/).map((l) => +l.split('\t')[1]) : [];
  const L = fs.readFileSync(`${REPO}/${f}`, 'utf8').split(/\r?\n/);
  const arms = lines.filter((n) => /^[?:]/.test(L[n - 1].trim()));
  if (arms.length) {
    total += arms.length;
    console.log(`${f}\tunits=${q.units} cov=${q.coverage}%\tternary-uncovered=${arms.join(',')}`);
  }
}
console.log('TOTAL ternary uncovered in done/remaining files:', total);
