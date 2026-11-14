// 对比 density 的 newComments 与 git diff 的新增行数，找出不一致的文件
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = 'd:\\code\\opensource\\crossbeam';
const BASE = 'd:\\code\\_annot_baseline\\CB-crossbeam-deep';
const roots = ['src', 'crossbeam-epoch/src', 'crossbeam-deque/src', 'crossbeam-queue/src',
  'crossbeam-channel/src', 'crossbeam-utils/src', 'crossbeam-skiplist/src'];
const files = [];
function walk(rel) {
  for (const ent of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
    const child = rel + '/' + ent.name;
    if (ent.isDirectory()) walk(child);
    else if (ent.name.endsWith('.rs')) files.push(child);
  }
}
for (const r of roots) walk(r);

let mismatch = 0;
for (const f of files) {
  const a = path.join(BASE, f);
  if (!fs.existsSync(a)) continue;
  let out;
  try {
    out = execFileSync('git', ['diff', '--no-index', '--numstat', '--', a, path.join(REPO, f)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (e) {
    out = String(e.stdout || '').trim();
  }
  if (!out) continue;
  const [add, del] = out.split('\t');
  const cur = fs.readFileSync(path.join(REPO, f), 'utf8').split(/\r?\n/);
  const old = fs.readFileSync(a, 'utf8').split(/\r?\n/);
  // 统计当前文件里比基线多出的整行注释数
  const countComments = (ls) => ls.filter((l) => l.trim().startsWith('//')).length;
  const dc = countComments(cur) - countComments(old);
  if (Number(add) !== dc || Number(del) !== 0) {
    mismatch++;
    console.log(`${f}\tadd=${add}\tdel=${del}\tcommentDelta=${dc}`);
  }
}
console.log('mismatch files=' + mismatch);
