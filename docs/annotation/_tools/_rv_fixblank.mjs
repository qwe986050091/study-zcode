// 修正文件头与 package 子句之间缺失的空行：否则 // 注释块会被当成 package doc。
// 规则：定位每个文件的 package 行；若上一行是注释行，则
//   - 上一行正好是 "//"（空注释行）→ 替换为真正的空行；
//   - 否则在 package 之前插入一个空行。
// 只动 package 之前的行，不碰任何代码。
import fs from 'node:fs';

const ROOT = 'd:\\code\\opensource\\raft';
const files = fs
  .readFileSync('d:\\code\\_annot_baseline\\RV-raft-b1\\_files.txt', 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s.split(/\s+/)[0]);

for (const f of files) {
  const p = ROOT + '\\' + f;
  const raw = fs.readFileSync(p, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^package\s+\w+/.test(l));
  if (idx < 1) {
    console.log('skip ' + f);
    continue;
  }
  const prev = lines[idx - 1];
  if (/^\s*\/\//.test(prev)) {
    if (prev.trim() === '//' && !prev.startsWith(' ')) lines[idx - 1] = '';
    else {
      lines.splice(idx, 0, '');
      console.log(`blank inserted: ${f}`);
    }
  }
  fs.writeFileSync(p, lines.join(eol));
}
console.log('done');
