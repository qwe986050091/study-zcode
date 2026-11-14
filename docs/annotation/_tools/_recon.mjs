// 账目核对：把各批次 md 里逐文件记录的 +N 汇总，与 git numstat 逐文件对比
import fs from 'node:fs';
import cp from 'node:child_process';

const DIR = 'd:/code/opensource/drizzle-orm/docs/annotation/';
const REPO = 'd:/code/opensource/drizzle-orm';
const recorded = new Map();
const batches = fs.readdirSync(DIR).filter((x) => /^DZ-deep-b\d+\.md$/.test(x));
for (const f of batches) {
  const s = fs.readFileSync(DIR + f, 'utf8');
  for (const line of s.split(/\r?\n/)) {
    const m = line.match(/^\|\s*`([^`]+\.(?:ts|tsx|js|mjs))`\s*\|.*\|\s*\+([\d,]+)\s*\|\s*$/);
    if (m) recorded.set(m[1], (recorded.get(m[1]) || 0) + Number(m[2].replace(/,/g, '')));
  }
}
const out = cp.execSync('git diff --numstat HEAD', { cwd: REPO, encoding: 'utf8' });
const actual = new Map();
for (const l of out.split(/\r?\n/)) {
  if (!l.trim()) continue;
  const [a, , f] = l.split('\t');
  actual.set(f, Number(a));
}
let mdSum = 0, actualSum = 0, mismatch = [], unrecorded = [];
for (const [k, v] of recorded) {
  mdSum += v;
  if (actual.has(k)) {
    actualSum += actual.get(k);
    if (actual.get(k) !== v) mismatch.push(`${k}\tmd=${v}\tdiff=${actual.get(k)}\tΔ=${actual.get(k) - v}`);
  } else {
    mismatch.push(`${k}\tmd=${v}\tdiff=0（文件无改动）`);
  }
}
for (const [k, v] of actual) if (!recorded.has(k)) { unrecorded.push(`${k}\t+${v}`); }
console.log(`batches=${batches.length} recordedFiles=${recorded.size} mdSum=${mdSum}`);
console.log(`actualFiles=${actual.size} actualSum=${actualSum}`);
console.log(`\n[逐文件不一致]`);
console.log(mismatch.length ? mismatch.join('\n') : 'none');
console.log(`\n[未记录文件] count=${unrecorded.length} lines=${unrecorded.reduce((a, s) => a + Number(s.split('\t+')[1]), 0)}`);
console.log(unrecorded.slice(0, 60).join('\n'));
