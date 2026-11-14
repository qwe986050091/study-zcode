// 临时排查：列出「`//` 注释块紧接着 `/**`」的重复注释位置（同一字段被解释两遍）。
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
for (const rel of process.argv.slice(2)) {
  const lines = fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const hits = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith('//')) continue;
    let j = i;
    while (j + 1 < lines.length && lines[j + 1].trim().startsWith('//')) j++;
    if (j + 1 < lines.length && lines[j + 1].trim().startsWith('/**')) {
      hits.push([i + 1, j + 1, lines[j + 1].trim().slice(0, 60)]);
    }
    i = j;
  }
  if (hits.length) {
    console.log('== ' + rel);
    for (const [a, b, t] of hits) console.log(`@${a}-${b} -> ${t}`);
  }
}
