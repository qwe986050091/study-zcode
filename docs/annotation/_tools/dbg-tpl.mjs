// 临时排查：按注释正文前 10 个字符分桶，列出出现 >=4 次的「模板开头」。
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
for (const rel of process.argv.slice(2)) {
  const lines = fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n').split('\n');
  const map = new Map();
  lines.forEach((l, i) => {
    const t = l.trim();
    if (!t.startsWith('//')) return;
    const body = t.replace(/^\/\/\s*/, '').trim();
    if (body.length < 8) return;
    const key = body.slice(0, 10);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push([i + 1, body]);
  });
  console.log('== ' + rel);
  for (const [key, arr] of map) {
    if (arr.length >= 4) {
      console.log(`x${arr.length}\t${key}...`);
      for (const [n, b] of arr.slice(0, 6)) console.log(`   @${n} ${b.slice(0, 80)}`);
    }
  }
}
