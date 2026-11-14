// 修正本批新增注释行中重复的 `// ` 前缀（仅处理相对基线新增的行）。
// 用法：node fix-double-slash.mjs <baselineFile> <currentFile>
import fs from 'node:fs';

const [, , basePath, curPath] = process.argv;
const base = fs.readFileSync(basePath, 'utf8').split(/\r?\n/);
const original = fs.readFileSync(curPath, 'utf8');
const cur = original.split(/\r?\n/);

const counts = new Map();
for (const line of base) counts.set(line, (counts.get(line) ?? 0) + 1);

let fixed = 0;
const out = cur.map((line) => {
  const n = counts.get(line) ?? 0;
  if (n > 0) {
    counts.set(line, n - 1);
    return line;
  }
  if (line.includes('// // ')) {
    fixed++;
    return line.replace(/\/\/ \/\/ /g, '// ');
  }
  return line;
});

fs.writeFileSync(curPath, out.join('\n'));
console.log(`fixed=${fixed}`);
