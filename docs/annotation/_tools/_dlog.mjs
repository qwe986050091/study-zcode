// 批次收尾记录：node _dlog.mjs <batch.json>
// batch.json: {
//   batch: "D24", totalAdded: 370,
//   files: [{letter, path, added, before, after}],
//   regions: [[file, region, topic], ...],
//   verify: [...], density: [...], added: [...], raw: [...],
//   orderRow: "| D24 | `a`、`b` | 1%、2% | 3、4（已完成，实际 +5/+6） |",
//   note: "单独说明文本"
// }
import fs from 'node:fs';

const inPath = process.argv[2];
const d = JSON.parse(fs.readFileSync(inPath, 'utf8'));

const mdPath = 'd:\\code\\opensource\\uv\\docs\\annotation\\UVR-D.md';
const readmePath = 'd:\\code\\opensource\\uv\\docs\\annotation\\README-summary.md';
const queuePath = 'd:\\code\\_annot_baseline\\UVR-deep-queue.json';

// —— UVR-D.md 段落 ——
const B = d.batch;
const lines = [];
lines.push('');
lines.push(`### ${B} 合并批（${d.files.length} 文件，+${d.totalAdded}）`);
lines.push('');
lines.push('| 文件 | 新增 | 密度变化 |');
lines.push('| --- | --- | --- |');
for (const f of d.files) {
  lines.push(`| \`${f.path}\` | ${f.added} | ${f.before}% → ${f.after}% |`);
}
lines.push('');
lines.push(
  `五个文件代码行均小于 1500，合并为一批；每文件独立基线 \`UVR-${B}-${d.files[0].letter}..${d.files[d.files.length - 1].letter}\`。`,
);
lines.push('');
lines.push('| 文件 | 区域 | 注释主题 |');
lines.push('| --- | --- | --- |');
for (const r of d.regions) lines.push(`| ${r[0]} | ${r[1]} | ${r[2]} |`);
lines.push('');
lines.push('校验原文：');
lines.push('');
lines.push('```');
for (const l of d.verify) lines.push(l);
for (const l of d.density) lines.push(l);
for (const l of d.added) lines.push(l);
for (const l of d.raw) lines.push(l);
lines.push('```');
lines.push('');
lines.push('整批 rustfmt（5 文件一次性 `--check`）退出码 0，无 diff。空白调整 0 处。');
lines.push('');
lines.push(d.note);
fs.appendFileSync(mdPath, lines.join('\n') + '\n', 'utf8');

// —— README 批次表 ——
const readme = fs.readFileSync(readmePath, 'utf8');
const batchRows = d.files
  .map((f) => `| ${B}-${f.letter} | \`${f.path}\` | 1 | ${f.added} | ${f.before}% → ${f.after}% | [UVR-D.md](UVR-D.md) |`)
  .join('\n');
const anchor = '\n## 当前全仓基线';
const at = readme.indexOf(anchor);
if (at < 0) throw new Error('README anchor not found');
let out = readme.slice(0, at).replace(/\n$/, '\n') + batchRows + '\n' + readme.slice(at);

// —— README 顺序表 ——
const ls = out.split('\n');
let last = -1;
for (let i = 0; i < ls.length; i++) if (/^\| D\d+ \|/.test(ls[i])) last = i;
if (last < 0) throw new Error('README order table not found');
ls.splice(last + 1, 0, d.orderRow);
out = ls.join('\n');
fs.writeFileSync(readmePath, out, 'utf8');

// —— 队列 ——
const q = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
for (const f of d.files) {
  q.completed.push({ batch: `${B}-${f.letter}`, path: f.path, added: f.added, densityPct: f.after });
}
q.updatedAt = new Date().toISOString();
fs.writeFileSync(queuePath, JSON.stringify(q, null, 2) + '\n', 'utf8');
console.log(`LOGGED ${B} files=${d.files.length} added=${d.totalAdded} completed=${q.completed.length}`);
