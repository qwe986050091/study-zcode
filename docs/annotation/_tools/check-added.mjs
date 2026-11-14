// 检查新增行是否全部为整行注释，且注释文本不含违规字符。
// 用法：node check-added.mjs <baselineFile> <currentFile>
import fs from 'node:fs';

const [, , basePath, curPath] = process.argv;
const base = fs.readFileSync(basePath, 'utf8').split(/\r?\n/);
const cur = fs.readFileSync(curPath, 'utf8').split(/\r?\n/);

const counts = new Map();
for (const line of base) counts.set(line, (counts.get(line) ?? 0) + 1);

const added = [];
for (const line of cur) {
  const n = counts.get(line) ?? 0;
  if (n > 0) counts.set(line, n - 1);
  else added.push(line);
}

const bad = added.filter((line) => {
  const slashes = (line.match(/\/\//g) ?? []).length;
  return !/^\s*\/\//.test(line) || line.includes('"') || slashes > 1;
});

console.log(`addedLines=${added.length} bad=${bad.length}`);
for (const line of bad.slice(0, 10)) console.log(JSON.stringify(line));
