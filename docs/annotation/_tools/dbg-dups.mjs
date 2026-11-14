// 临时排查：列出指定文件里重复出现的 `//` 注释行（同一正文出现 >1 次），
// 以及疑似注水的短句（去标点后 <=10 字且连续成组）。只读，不写仓库。
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
for (const rel of process.argv.slice(2)) {
  const text = fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const map = new Map();
  lines.forEach((l, i) => {
    const t = l.trim();
    if (!t.startsWith('//')) return;
    const body = t.replace(/^\/\/\s*/, '').trim();
    if (!body) return;
    if (!map.has(body)) map.set(body, []);
    map.get(body).push(i + 1);
  });
  console.log('== ' + rel);
  for (const [body, at] of map) {
    if (at.length > 1) console.log(`x${at.length}\t${body.slice(0, 90)} @${at.slice(0, 8).join(',')}`);
  }
}
