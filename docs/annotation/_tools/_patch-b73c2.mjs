import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/B73c-fuzzer.mjs';
let s = fs.readFileSync(p, 'utf8');
const rep = {
  2500: '`strchr` 已跳过空格，`subCommand` 不含前导空格。',
  2574: '`idx1 == idx2` 时跳过，交换强度本身是概率性的。',
  2745: '`current_slot_tag` 置空，让下一轮重新选槽。',
  2769: '`allocCommand` 先分配命令壳，三条分支都复用它。',
  2791: 'else 分支调用 `generateSingleCmd` 生成普通单命令。',
};
const lines = s.split('\n');
let hit = 0;
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^  \[(\d+), '.*'\],$/);
  if (!m) continue;
  const n = Number(m[1]);
  if (!(n in rep)) continue;
  lines[i] = `  [${n}, '${rep[n]}'],`;
  hit++;
  delete rep[n];
}
fs.writeFileSync(p, lines.join('\n'));
console.log('patched', hit, 'remaining', Object.keys(rep).join(','));
