// 抽样新增注释：快照 vs 当前（只增行场景），每 N 条打印一条，附带其下 2 行代码。
// 用法：node uv-sample-added.mjs <snapFile> <curFile> [N]
import fs from 'node:fs';

const [snapPath, curPath, nArg] = process.argv.slice(2);
const N = Number(nArg || 10);
const a = fs.readFileSync(snapPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
const b = fs.readFileSync(curPath, 'utf8').replace(/\r\n/g, '\n').split('\n');

let i = 0;
let j = 0;
const added = [];
while (j < b.length) {
  if (i < a.length && a[i] === b[j]) { i++; j++; continue; }
  // 当前行为新增；若连续新增则逐行收集
  if (/^\s*\/\//.test(b[j])) added.push(j);
  j++;
}
console.log(`addedCommentLines=${added.length} sampleStep=${N}`);
for (let k = 0; k < added.length; k += N) {
  const ln = added[k];
  console.log(`--- L${ln + 1}`);
  console.log('  + ' + b[ln].trim());
  for (let d = 1; d <= 2 && ln + d < b.length; d++) console.log('    ' + b[ln + d].trim());
}
