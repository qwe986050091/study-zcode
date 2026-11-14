// 临时排查：列出指定文件里连续 >=4 行、每行正文 <=16 字的 `//` 注释块（疑似注水）。
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/ZCode';
for (const rel of process.argv.slice(2)) {
  const lines = fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n').split('\n');
  console.log('== ' + rel);
  let run = [];
  const flush = () => {
    if (run.length >= 4) {
      console.log(`--- @${run[0][0]}-${run[run.length - 1][0]} (${run.length} lines)`);
      for (const [n, t] of run) console.log(`${n}\t${t}`);
    }
    run = [];
  };
  lines.forEach((l, i) => {
    const t = l.trim();
    const body = t.startsWith('//') ? t.replace(/^\/\/\s*/, '') : null;
    if (body !== null && body.length <= 16) run.push([i + 1, body]);
    else flush();
  });
  flush();
}
