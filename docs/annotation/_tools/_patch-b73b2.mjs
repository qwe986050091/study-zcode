import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/B73b-fuzzer.mjs';
let s = fs.readFileSync(p, 'utf8');
const rep = {
  1368: '`token` 置空防止二次释放。',
  1394: '`fullname` 置空防止二次释放。',
  1465: '`commandRegistry[i]` 取当前条目地址，删除时用末元素覆盖它。',
  1769: '`aclCategories[cat_idx]` 前拼 +@ 表示允许该类别。',
  1778: '与 case 3 一样要求 `aclCategories` 非空。',
  1793: '`commands[cmd_idx]` 前拼 + 表示允许该命令。',
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
