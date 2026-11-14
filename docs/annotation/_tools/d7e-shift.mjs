// 把 d7e-1.json 的锚点解析成基线文件中的行号，并上移跳过紧邻的 #[...] 属性块（含跨行）、
// /// 文档注释与 // 行注释，生成 _uvr_insert 可直接消费的行号规格。
// 用法：node d7e-shift.mjs <in.json> <out.json> <baselineFile>
import fs from 'node:fs';

const [, , inPath, outPath, basePath] = process.argv;
const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const file = raw[0].file;
const lines = fs.readFileSync(basePath, 'utf8').split('\n').map((l) => l.replace(/\r$/, ''));
if (lines[lines.length - 1] === '') lines.pop();

// 逐行标记：该行是属性起始、属性延续，还是普通行。
const attrLine = new Array(lines.length).fill(false);
let depth = 0;
for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim();
  if (depth > 0) {
    attrLine[i] = true;
    depth += (t.match(/\[/g) || []).length - (t.match(/\]/g) || []).length;
    continue;
  }
  if (t.startsWith('#[')) {
    attrLine[i] = true;
    depth = (t.match(/\[/g) || []).length - (t.match(/\]/g) || []).length;
  }
}

const skippable = (i) => attrLine[i] || lines[i].trim().startsWith('///') || lines[i].trim().startsWith('//');

const items = [];
for (const item of raw) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(item.pick)) hits.push(i);
  let idx;
  if (item.nth !== undefined) idx = hits[item.nth - 1];
  else if (hits.length === 1) idx = hits[0];
  else {
    console.error(`FAIL pick x${hits.length}: ${item.pick}`);
    process.exit(1);
  }
  if (idx === undefined) {
    console.error(`FAIL pick missing: ${item.pick}`);
    process.exit(1);
  }
  while (idx > 0 && skippable(idx - 1)) idx--;
  items.push({ line: idx + 1, anchor: lines[idx], lines: item.lines });
}
fs.writeFileSync(outPath, JSON.stringify([{ file, items }], null, 2));
console.log(`SHIFTED items=${items.length} lines=${items.reduce((n, i) => n + i.lines.length, 0)}`);
