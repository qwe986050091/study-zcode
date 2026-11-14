// 把新增的顶层缩进 // 注释行对齐到其下方代码行的缩进（只改新增注释，不动代码）。
import fs from 'node:fs';

const p = 'D:/code/ZCode/packages/services/src/session/taskIndexRepo.ts';
const text = fs.readFileSync(p, 'utf8');
const crlf = text.includes('\r\n');
const lines = text.split(/\r?\n/);

let fixed = 0;
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith('//')) continue;
  let k = i;
  while (k < lines.length && lines[k].startsWith('//')) k++;
  if (k >= lines.length) break;
  const next = lines[k];
  const indent = /^[ \t]*/.exec(next)[0];
  for (let n = i; n < k; n++) {
    const body = lines[n].replace(/^\/\/\s?/, '');
    lines[n] = `${indent}// ${body}`.replace(/\s+$/, '');
    fixed++;
  }
  i = k - 1;
}

fs.writeFileSync(p, lines.join(crlf ? '\r\n' : '\n'));
console.log('reindented', fixed);
