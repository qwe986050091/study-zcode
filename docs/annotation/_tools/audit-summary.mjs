// 汇总 ledger-audit.tsv：按判定分类、按批次聚合缺失路径。
import fs from 'node:fs';

const tsv = fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
const head = tsv.shift().split('\t');
const rows = tsv.map((l) => {
  const c = l.split('\t');
  const o = {};
  head.forEach((h, i) => (o[h] = c[i] ?? ''));
  return o;
});

const byVerdict = {};
const missingByBatch = {};
const overRows = [];
for (const r of rows) {
  byVerdict[r['判定']] = (byVerdict[r['判定']] || 0) + 1;
  if (r['判定'] === '台账与实测不符') {
    if (!r.HEAD) missingByBatch[r['批次']] = (missingByBatch[r['批次']] || 0) + 1;
    else overRows.push(r);
  }
}
console.log('BY-VERDICT');
for (const [k, v] of Object.entries(byVerdict)) console.log(`  ${k}\t${v}`);
console.log('MISSING-BY-BATCH');
for (const [k, v] of Object.entries(missingByBatch).sort((a, b) => b[1] - a[1])) console.log(`  ${k}\t${v}`);
console.log('OVER-ROWS');
for (const r of overRows) console.log(`  ${r['批次']} ${r['文件']} declared=${r['台账登记']} wt=+${r['工作区+']} head=${r.HEAD}`);
console.log('PARSE-FAIL');
for (const r of rows.filter((x) => x['判定'] === '台账解析失败')) console.log(`  ${r['批次']} declared=${r['台账登记']}`);
