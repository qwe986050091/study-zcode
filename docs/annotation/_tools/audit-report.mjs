// 由 ledger-audit.tsv + ledger-audit.json 生成审计文档。
import fs from 'node:fs';

const [, , tsvPath, jsonPath, outPath] = process.argv;
const tsv = fs.readFileSync(tsvPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
const head = tsv.shift().split('\t');
const rows = tsv.map((l) => {
  const c = l.split('\t');
  const o = {};
  head.forEach((h, i) => (o[h] = c[i] ?? ''));
  return o;
});
const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
const out = [];
out.push('# ZC 批次台账审计（2026-11-10）');
out.push('');
out.push('> 目的：核对全部 `ZC-DEEP-b*.md` 登记的「文件 + 行数」是否真的在仓库里有提交号，找出「有台账、无提交」的批次。');
out.push('> 方法：`_annot_baseline/audit-ledgers2.mjs`，逐文件取 `git log -1 --format=%h`、`git diff --numstat`、`git status --porcelain`。');
out.push('> 原始数据：`_annot_baseline/ledger-audit.tsv`（1,411 行）。');
out.push('');
out.push('## 1. 总数');
out.push('');
out.push('| 判定 | 文件数 | 含义 |');
out.push('| --- | ---: | --- |');
out.push(`| 未提交 | ${meta.vc['未提交'] || 0} | 工作区增量恰好等于台账登记行数，仓库里没有对应提交 |`);
out.push(`| 部分未提交 | ${meta.vc['部分未提交'] || 0} | 工作区增量小于登记行数 |`);
out.push(`| 台账与实测不符 | ${meta.vc['台账与实测不符'] || 0} | 路径不存在 / 增量大于登记 / 干净但无注释提交 |`);
out.push(`| 已提交且干净 | ${meta.vc['已提交且干净'] || 0} | 工作区无改动，末次提交为注释提交 |`);
out.push(`| 台账解析失败 | ${meta.vc['台账解析失败'] || 0} | 台账正文无法解析出文件表 |`);
out.push(`| **合计** | **${rows.length}** | **${meta.dirtyFiles} 个文件未落提交，合计 ${meta.dirtyLines.toLocaleString('en-US')} 行** |`);
out.push('');
out.push('## 2. 分批汇总');
out.push('');
out.push('| 批次 | 登记文件 | 登记行数 | 已提交且干净 | 未落提交文件 | 未落提交行数 |');
out.push('| --- | ---: | ---: | ---: | ---: | ---: |');
for (const [b, v] of Object.entries(meta.perBatch)) {
  out.push(`| ${b} | ${v.files} | ${v.declared} | ${v.files - v.dirty} | ${v.dirty} | ${v.dirtyLines} |`);
}
out.push('');
out.push('## 3. 逐文件明细');
out.push('');
out.push('| 批次 | 台账登记 | 文件 | `git log -1 --format=%H` | 工作区 numstat | 判定 | 备注 |');
out.push('| --- | ---: | --- | --- | ---: | --- | --- |');
for (const r of rows) {
  out.push(
    `| ${r['批次']} | ${r['台账登记']} | \`${esc(r['文件'])}\` | \`${r.HEAD || '—'}\` | +${r['工作区+']}/-${r['工作区-']} | ${r['判定']} | ${esc(r['备注']) || '—'} |`,
  );
}
fs.writeFileSync(outPath, out.join('\n') + '\n', 'utf8');
console.log(`wrote ${outPath} rows=${rows.length}`);
