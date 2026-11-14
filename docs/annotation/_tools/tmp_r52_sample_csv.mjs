// 把 R52 分层抽样的首轮 168 条样本导出为可复算的键清单（供台账与脚本对齐）。
// 结论列：命中 DZ-claim-stratified.md §8 的错误键 → 不成立；其余按报告整体口径记 成立。
import fs from 'node:fs';

const BASE = 'D:/code/_annot_baseline';
const REPO = 'D:/code/opensource/drizzle-orm';
const sample = JSON.parse(fs.readFileSync(`${BASE}/R52-claim-sample.json`, 'utf8'));
const doc = fs.readFileSync(`${REPO}/docs/annotation/DZ-claim-stratified.md`, 'utf8');

const failKeys = new Set();
for (const line of doc.split(/\r?\n/)) {
  const m = /^\|\s*\d+\s*\|\s*`([0-9a-f]{8})`\s*\|/.exec(line);
  if (m) failKeys.add(m[1]);
}

const rows = [['key', 'file', 'line', 'keyword', 'layer', 'dir', 'structural', 'conclusion']];
for (const c of sample.sample) {
  rows.push([c.key, c.file, c.line, c.kw, c.subdir, c.dir, c.structural ? 'Y' : 'N', failKeys.has(c.key) ? '不成立' : '成立']);
}
const csv = rows.map((r) => r.map((v) => (/[,"\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(',')).join('\n') + '\n';
fs.writeFileSync(`${BASE}/R52-sample-keys.csv`, csv, 'utf8');
console.log(`rows=${rows.length - 1} failKeys=${failKeys.size} hit=${rows.slice(1).filter((r) => r[7] === '不成立').length}`);
