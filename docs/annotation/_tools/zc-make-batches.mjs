// 由 zc-measure 结果生成批次划分（按缺口降序的贪心装箱，同目录亲和）。
// 输出 Markdown 表格片段与每批文件清单，供 DEEP-PLAN.md 使用。
import fs from 'node:fs';

const d = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/zc-measure-all.json', 'utf8'));
let rows = d.rows.filter((x) => !x.path.startsWith('packages/services/') && !/\/locales\//.test(x.path) && x.need > 0);
rows.sort((a, b) => b.need - a.need);

const CAP_LINES = 2000;
const CAP_FILES = 20;
const batches = [];
let cur = null;
for (const r of rows) {
  const dir = r.path.slice(0, r.path.lastIndexOf('/'));
  if (cur && (cur.lines + r.need > CAP_LINES || cur.files.length >= CAP_FILES)) cur = null;
  if (!cur) {
    cur = { lines: 0, files: [], dirs: new Set() };
    batches.push(cur);
  }
  cur.lines += r.need;
  cur.files.push(r);
  cur.dirs.add(dir);
}

const out = [];
out.push('| 批次 | 文件数 | 缺口行 | 主要目录 |');
out.push('| --- | ---: | ---: | --- |');
batches.forEach((b, i) => {
  const dirs = [...b.dirs].slice(0, 2).join('、') + (b.dirs.size > 2 ? ` 等 ${b.dirs.size} 个目录` : '');
  out.push(`| B${i + 1} | ${b.files.length} | ${b.lines} | ${dirs} |`);
});
out.push('');
out.push('### 各批文件清单');
batches.forEach((b, i) => {
  out.push('');
  out.push(`**B${i + 1}**（${b.files.length} 文件，缺口 ${b.lines} 行）`);
  for (const f of b.files) out.push(`- \`${f.path}\` — code ${f.code} / comment ${f.comment} / ${f.measured.toFixed(1)}% / 缺 ${f.need}`);
});
fs.writeFileSync('d:/code/_annot_baseline/zc-batches.md', out.join('\n'));
console.log('batches=' + batches.length + ' files=' + rows.length + ' lines=' + rows.reduce((n, x) => n + x.need, 0));
