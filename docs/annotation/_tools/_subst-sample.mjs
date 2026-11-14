// 抽样：找出被旧 substance 判据（数字 / 反引号 / ASCII 标识符）判为非实质的中文注释行。
// 用法：node _subst-sample.mjs <file> [n]
import fs from 'node:fs';

const file = process.argv[2];
const n = Number(process.argv[3] ?? 20);
const TAG_STOP = new Set(['STEP', 'INV', 'TODO', 'FIXME', 'NOTE', 'SAFETY', 'XXX', 'HACK']);
const identTokens = (s) => (s.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).filter((t) => !TAG_STOP.has(t));
const oldSub = (c) => /\d/.test(c) || /`[^`]+`/.test(c) || identTokens(c).length > 0;
const CN = /[\u4e00-\u9fa5]/;

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const cand = [];
let total = 0;
lines.forEach((l, i) => {
  const m = l.match(/^\s*\/\/\s?(.*)$/);
  if (!m) return;
  const c = m[1].trim();
  if (!CN.test(c)) return;
  total++;
  if (oldSub(c)) return;
  if (c.length < 4) return;
  cand.push(`${i + 1}\t${c}`);
});
console.log(`TOTAL_CN_COMMENTS=${total} OLD_NONSUB=${cand.length} (${((cand.length / total) * 100).toFixed(1)}%)`);
const step = Math.max(1, Math.floor(cand.length / n));
for (let k = 0, picked = 0; k < cand.length && picked < n; k += step, picked++) console.log(cand[k]);
