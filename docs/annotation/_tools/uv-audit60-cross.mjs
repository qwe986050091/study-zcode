// 把 audit60.csv 的 60 条回贴到「预登记判据 + 精确分类（A 字符串内 / B 重复 / C 可注释产品代码）」上，
// 用 pre-s109 快照（回填前，行号与抽样时一致）判定每条的归属。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { linesInsideStrings } = await import(pathToFileURL('d:/code/_annot_baseline/uv-string-spans.mjs').href);
const { testLineSet } = await import(pathToFileURL('d:/code/_annot_baseline/uv-test-blocks.mjs').href);

const snap = 'd:/code/_annot_baseline/uv-rework/pre-s109';
const csv = fs.readFileSync('d:/code/_annot_baseline/uv-rework/audit60.csv', 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
// CSV: i,idx,file,line,branch,text,d1,d2,ctrl,kind  (text 可能含逗号，用引号包裹)
function parse(line) {
  const p = line.split(',');
  return { i: p[0], idx: p[1], file: p[2], line: Number(p[3]), kind: p[p.length - 1] };
}
const rows = csv.map(parse);
const cache = new Map();
function ctx(file) {
  if (cache.has(file)) return cache.get(file);
  const abs = path.join(snap, file.split('/').join(path.sep));
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const inStr = new Set(linesInsideStrings(lines.join('\n')).map((v, i) => (v ? i + 1 : 0)).filter(Boolean));
  const inTest = testLineSet(lines);
  const v = { inStr, inTest };
  cache.set(file, v);
  return v;
}
const tally = { 属实: { A: 0, B: 0, C: 0 }, 不属实: { A: 0, B: 0, C: 0 } };
const detail = [];
for (const r of rows) {
  const { inStr, inTest } = ctx(r.file);
  const cat = inTest.has(r.line) ? 'T' : inStr.has(r.line) ? 'A' : r.kind === '属实' ? 'B' : 'C';
  if (cat === 'T') { tally[r.kind].T = (tally[r.kind].T || 0) + 1; continue; }
  tally[r.kind][cat]++;
  detail.push({ ...r, cat });
}
console.log('kind  A(inStr)  B(dup)  C(real product)  T(test)');
for (const k of ['属实', '不属实']) {
  console.log(`${k}  ${tally[k].A}  ${tally[k].B}  ${tally[k].C}  ${tally[k].T || 0}`);
}
console.log('不属实明细:');
for (const d of detail.filter((x) => x.kind === '不属实')) console.log(`  ${d.cat} ${d.file}:${d.line}`);
