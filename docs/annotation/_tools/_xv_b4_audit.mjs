// 覆盖审计：每个测试/驱动器函数上方 6 行内必须有 // 注释
import fs from 'node:fs';
const p = 'd:\\code\\opensource\\xv6-riscv\\user\\usertests.c';
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
const sig = /^(?:[A-Za-z_][\w \*]*\n)?([a-zA-Z_]\w*)\(/;
const missing = [];
let fn = 0;
for (let i = 0; i < lines.length; i++) {
  const m = /^([a-zA-Z_]\w*)\((?:char \*s|void f\(char \*\), char \*s|struct test \*tests|int argc|int quick|void)?/.exec(lines[i]);
  if (!m) continue;
  // 只统计函数定义：下一行是 {
  if (!/^(void|int|static void)$/.test((lines[i - 1] || '').trim())) continue;
  if ((lines[i + 1] || '').trim() !== '{') continue;
  fn++;
  let ok = false;
  for (let k = 2; k <= 7; k++) if ((lines[i - k] || '').trim().startsWith('//')) ok = true;
  if (!ok) missing.push(`${i + 1}: ${lines[i]}`);
}
console.log('functions=' + fn);
console.log(missing.length ? 'MISSING:\n' + missing.join('\n') : 'all have comment above');
