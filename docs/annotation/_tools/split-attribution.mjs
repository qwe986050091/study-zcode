// 把 deep-quality 的 weak/filler 行按「本线新增 / 上游原有」拆分。
// 口径：以快照提交的父提交 8f7daaf0 为基线，git diff -U0 得到的 + 行号集合 = 本线新增行；
// 文件里其余注释行 = 上游原有行。weak/filler 的判据一律沿用 deep-quality 的产出，不重算。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = 'D:/code/ZCode';
const BASE = '8f7daaf0';
const SNAP = 'd:/code/_annot_baseline/snapshot';

const addedCache = new Map();
function addedLines(rel) {
  if (addedCache.has(rel)) return addedCache.get(rel);
  const out = execFileSync('git', ['-C', REPO, '--no-pager', 'diff', '-U0', BASE, '--', rel], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const set = new Set();
  let cur = 0;
  for (const l of out.split(/\r?\n/)) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m) {
      cur = +m[1];
      continue;
    }
    if (l.startsWith('+') && !l.startsWith('+++')) {
      set.add(cur);
      cur++;
    } else if (l.startsWith(' ')) cur++;
  }
  addedCache.set(rel, set);
  return set;
}

function split(jsonFile, label) {
  const j = JSON.parse(fs.readFileSync(path.join(SNAP, jsonFile), 'utf8').replace(/^\uFEFF/, ''));
  const agg = {
    label,
    files: j.rows.length,
    comments: j.summary.comments,
    weakOwn: 0,
    weakUp: 0,
    fillerOwn: 0,
    fillerUp: 0,
    addedCommentLines: 0,
    upstreamCommentLines: 0,
  };
  const detail = [];
  for (const r of j.rows) {
    const add = addedLines(r.path);
    let weakOwn = 0;
    let weakUp = 0;
    for (const w of r.weakLines) (add.has(w.line) ? weakOwn++ : weakUp++);
    let fillerOwn = 0;
    let fillerUp = 0;
    for (const f of r.fillerLines) (add.has(f.line) ? fillerOwn++ : fillerUp++);
    agg.weakOwn += weakOwn;
    agg.weakUp += weakUp;
    agg.fillerOwn += fillerOwn;
    agg.fillerUp += fillerUp;
    // 新增注释行数：diff 里落在注释行上的行数
    let ac = 0;
    for (const ln of add) {
      // 用 weak 明细无法反推全部注释行，这里用文件行号集合大小代替仅作参考
      ac++;
    }
    agg.addedCommentLines += add.size;
    detail.push({ path: r.path, weakOwn, weakUp, fillerOwn, fillerUp, added: add.size });
  }
  return { agg, detail };
}

const a = split('q436-whole.json', '436 文件（services/core 线）');
const b = split('q-main-whole.json', '1,726 文件（主线）');

for (const x of [a, b]) {
  const g = x.agg;
  const ownWeakRate = g.weakOwn + g.weakUp ? ((g.weakOwn / (g.weakOwn + g.weakUp)) * 100).toFixed(1) : '0.0';
  console.log(
    `${g.label}: files=${g.files} comments=${g.comments} diffLines=${g.addedCommentLines} ` +
      `weakOwn=${g.weakOwn} weakUp=${g.weakUp} (own share ${ownWeakRate}%) ` +
      `fillerOwn=${g.fillerOwn} fillerUp=${g.fillerUp}`,
  );
}

fs.writeFileSync(path.join(SNAP, 'attribution.json'), JSON.stringify({ a, b }, null, 1), 'utf8');

// 输出：436 里 ours 侧 weak 最多的文件
console.log('\n436 新增行 weak 最多的 10 个文件:');
for (const r of [...a.detail].sort((x, y) => y.weakOwn - x.weakOwn).slice(0, 10)) {
  console.log(`  own=${r.weakOwn} up=${r.weakUp} ${r.path}`);
}
console.log('\n主线新增行 weak 最多的 10 个文件:');
for (const r of [...b.detail].sort((x, y) => y.weakOwn - x.weakOwn).slice(0, 10)) {
  console.log(`  own=${r.weakOwn} up=${r.weakUp} ${r.path}`);
}
