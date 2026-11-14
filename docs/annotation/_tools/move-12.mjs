// 把新增的 // 注释块整体上移到其后的 JSDoc 之前，保持 JSDoc 与声明相邻。
// 只移动新增的注释行，不触碰任何原有代码行。
import fs from 'node:fs';

const p = 'D:/code/ZCode/packages/services/src/session/taskIndexRepo.ts';
let text = fs.readFileSync(p, 'utf8');
const crlf = text.includes('\r\n');
const lines = text.split(/\r?\n/);

let moved = 0;
for (let pass = 0; pass < 30; pass++) {
  let changed = false;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('//')) continue;
    if (!lines[i - 1].trim().endsWith('*/')) continue;
    let k = i;
    while (k < lines.length && lines[k].trim().startsWith('//')) k++;
    let j = i - 1;
    while (j >= 0 && !lines[j].trim().startsWith('/**')) j--;
    if (j < 0) continue;
    const block = lines.slice(i, k);
    lines.splice(i, k - i);
    lines.splice(j, 0, ...block);
    moved++;
    changed = true;
    break;
  }
  if (!changed) break;
}

fs.writeFileSync(p, lines.join(crlf ? '\r\n' : '\n'));
console.log('moved', moved);
