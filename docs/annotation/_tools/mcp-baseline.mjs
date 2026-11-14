// 建立批次基线：d:\code\_annot_baseline\mcp-bN\orig\<相对路径> + _files.txt
// 用法：node mcp-baseline.mjs B01
import fs from 'node:fs';
import path from 'node:path';

const repo = 'D:/code/opensource/mcp-sdk';
const batches = JSON.parse(
  fs.readFileSync('D:/code/_annot_baseline/mcp-batches.json', 'utf8').replace(/^\uFEFF/, ''),
);
const key = process.argv[2];
if (!key || !batches[key]) {
  console.error('usage: node mcp-baseline.mjs <B01..B22>');
  process.exit(2);
}
const batchDir = path.join('D:/code/_annot_baseline', 'mcp-' + key.toLowerCase());
if (fs.existsSync(batchDir)) {
  console.error('FAIL: batch dir already exists: ' + batchDir);
  process.exit(1);
}
const origDir = path.join(batchDir, 'orig');
fs.mkdirSync(origDir, { recursive: true });
const list = [];
for (const rel of batches[key]) {
  const src = path.join(repo, rel);
  if (!fs.existsSync(src)) {
    console.error('FAIL: missing source: ' + rel);
    process.exit(1);
  }
  const dst = path.join(origDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  list.push(rel);
}
fs.writeFileSync(path.join(batchDir, '_files.txt'), list.join('\n') + '\n', 'utf8');
console.log('baseline ' + batchDir + ' files=' + list.length);
