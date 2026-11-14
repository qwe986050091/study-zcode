// 以 git HEAD 为基线生成批次快照：_files.txt + orig/<相对路径>。
// 用法：node zc-snap-head.mjs <repoRoot> <batchName> <rel1> [rel2 ...]
// 用 Node 写盘而不是 shell 重定向：避免 PowerShell/cmd 的编码与换行转换损坏字节。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [repo, batch, ...files] = process.argv.slice(2);
if (!repo || !batch || files.length === 0) {
  console.error('usage: node zc-snap-head.mjs <repoRoot> <batchName> <rel...>');
  process.exit(2);
}
const dir = path.join('D:/code/_annot_baseline', batch);
const origDir = path.join(dir, 'orig');
fs.mkdirSync(origDir, { recursive: true });
for (const rel of files) {
  const buf = execFileSync('git', ['-C', repo, 'show', `HEAD:${rel}`], { maxBuffer: 128 * 1024 * 1024 });
  const dest = path.join(origDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  console.log(`SNAP ${rel} bytes=${buf.length}`);
}
fs.writeFileSync(path.join(dir, '_files.txt'), files.join('\n') + '\n');
console.log(`WROTE ${path.join(dir, '_files.txt')} files=${files.length}`);
