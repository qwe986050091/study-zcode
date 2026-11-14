#!/usr/bin/env node
// 禁用代词分布与分批计划。
// 口径：相对快照 S 新增的整行中文 // 注释中，命中 /它|其|该|此|这里|上述|相关/ 的行。
// 输出：
//   1) 按文件计数（降序）
//   2) 按代词种类（字符出现次数 / 涉及行数）
//   3) 分批计划：按文件聚拢、每批约 200 行，段内保持连续行号区间
// 用法：node _pronoun-plan.mjs <baseDir> <fileList> <outTsv>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = 'd:\\code\\claude-code-main';
const [baseArg, listArg, outArg] = process.argv.slice(2);
const baseDir = path.resolve(baseArg);
const rels = fs.readFileSync(path.resolve(listArg), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const KINDS = ['它', '其', '该', '此', '这里', '上述', '相关'];
const HIT = /它|其|该|此|这里|上述|相关/;

function addedLineSet(base, cur) {
  const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '-U0', '--', base, cur], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const set = new Set();
  let curLine = 0;
  let inHunk = false;
  for (const raw of (r.stdout || '').split(/\r?\n/)) {
    if (raw.startsWith('@@')) {
      const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      curLine = m ? Number(m[1]) : 0;
      inHunk = true;
    } else if (!inHunk) continue;
    else if (raw.startsWith('+') && !raw.startsWith('+++')) {
      set.add(curLine);
      curLine++;
    } else if (raw.startsWith(' ') ) {
      curLine++;
    }
  }
  return set;
}

const files = [];
const kindLines = Object.fromEntries(KINDS.map((k) => [k, 0]));
const kindOccur = Object.fromEntries(KINDS.map((k) => [k, 0]));

for (const rel of rels) {
  const a = path.join(baseDir, rel);
  const b = path.join(REPO, rel);
  if (!fs.existsSync(a) || !fs.existsSync(b)) continue;
  const added = addedLineSet(a, b);
  if (!added.size) continue;
  const lines = fs.readFileSync(b, 'utf8').split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('//') || !/[\u4e00-\u9fa5]/.test(t)) continue;
    if (!added.has(i + 1)) continue;
    if (!HIT.test(t)) continue;
    hits.push(i + 1);
    for (const k of KINDS) {
      const n = (t.match(new RegExp(k, 'g')) ?? []).length;
      if (n) {
        kindLines[k]++;
        kindOccur[k] += n;
      }
    }
  }
  if (hits.length) files.push({ rel, hits });
}

files.sort((x, y) => y.hits.length - x.hits.length);

// 连续区间
const toRuns = (nums) => {
  const runs = [];
  let s = nums[0];
  let p = nums[0];
  for (const n of nums.slice(1)) {
    if (n === p + 1) {
      p = n;
    } else {
      runs.push([s, p]);
      s = n;
      p = n;
    }
  }
  runs.push([s, p]);
  return runs;
};

const BATCH = 200;
const batches = [];
let cur = { rows: [], total: 0 };
const flush = () => {
  if (cur.rows.length) {
    batches.push({ id: batches.length + 1, ...cur });
    cur = { rows: [], total: 0 };
  }
};
for (const f of files) {
  for (const [s, e] of toRuns(f.hits)) {
    const n = e - s + 1;
    if (cur.total > 0 && cur.total + n > BATCH) flush();
    cur.rows.push({ rel: f.rel, s, e, n });
    cur.total += n;
  }
}
flush();

const out = ['batch\tfile\tlines\tcount'];
for (const b of batches) {
  for (const r of b.rows) out.push(`${b.id}\t${r.rel}\t${r.s}-${r.e}\t${r.n}`);
}
fs.writeFileSync(path.resolve(outArg), out.join('\n') + '\n', 'utf8');

const total = files.reduce((s, f) => s + f.hits.length, 0);
console.log(`TOTAL lines=${total} files=${files.length} batches=${batches.length}`);
console.log('TOP10');
for (const f of files.slice(0, 10)) console.log(`${f.rel}\t${f.hits.length}`);
console.log('KINDS lines=' + JSON.stringify(kindLines));
console.log('KINDS occurrences=' + JSON.stringify(kindOccur));
console.log('BATCH SIZES ' + batches.map((b) => b.total).join(','));
