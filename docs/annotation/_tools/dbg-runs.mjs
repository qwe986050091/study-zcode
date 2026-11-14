// 临时排查：列出连续 >=8 行的 `//` 注释块（首行号 + 前 3 行内容）。
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
for (const rel of process.argv.slice(2)) {
  const lines = fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n').split('\n');
  console.log('== ' + rel);
  let start = -1;
  let buf = [];
  const flush = () => {
    if (buf.length >= 8) {
      console.log(`--- @${start + 1} (${buf.length} lines)`);
      for (const b of buf.slice(0, 3)) console.log('   ' + b.slice(0, 90));
    }
    start = -1;
    buf = [];
  };
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t.startsWith('//')) {
      if (start === -1) start = i;
      buf.push(t);
    } else flush();
  });
  flush();
}
