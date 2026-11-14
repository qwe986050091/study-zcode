import fs from 'node:fs';

const REPO = 'd:/code/opensource/valkey';
const REL = 'src/valkey-benchmark.c';
const DIR = 'd:/code/_annot_baseline/VK-B42';
const SRC = `${REPO}/${REL}`;

const E = [
  [481, '/* warmup_duration > 0 表示仍在预热，直接判未结束，预热请求不计入结果。 */'],
  [483, '/* duration>0 走时间模式，否则走请求数模式；两者互斥，由 -d/-n 决定。 */'],
  [2148, '/* quiet 与 csv 命中任一就跳过人读报告，csv 由另一个分支单独输出。 */'],
  [4755, '/* replace_placeholders 开启时 score 用 __rand_int__ 占位，发送前再替换。 */'],
];

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const ops = [];
for (const [ln, c] of E) {
  const t = lines[ln - 1].trim();
  if (!t || t.startsWith('/*') || t.startsWith('//') || t.startsWith('#')) {
    console.error('BADANCHOR', ln, t);
    process.exit(2);
  }
  ops.push({ line: ln, expect: t, lines: Array.isArray(c) ? c : [c] });
}
ops.sort((a, b) => b.line - a.line);
fs.writeFileSync(`${DIR}/ins-b1.json`, JSON.stringify([{ file: REL, ops }], null, 1));
fs.writeFileSync(`${DIR}/out-benchmark.json`, JSON.stringify(ops.map((o) => ({ line: o.line, c: o.lines })), null, 1));
console.log('ops', ops.length);
