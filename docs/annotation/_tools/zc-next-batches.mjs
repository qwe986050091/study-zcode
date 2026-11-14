// 按 DEEP-PLAN 4.1 装箱规则，从当前测量结果算出接下来的 N 批清单。
// 用法：node zc-next-batches.mjs <count> [startBatchNo]
import fs from 'node:fs';

const count = Number(process.argv[2] || 4);
const start = Number(process.argv[3] || 11);
const data = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/zc-measure-all.json', 'utf8'));
const L0 = new Set([
  'packages/ui/src/i18n/locales/en-US.ts',
  'packages/ui/src/i18n/locales/zh-CN.ts',
  'apps/zcode-cli/packages/i18n/src/locales/en-US.ts',
  'apps/zcode-cli/packages/i18n/src/locales/zh-CN.ts',
]);
const rows = data.rows
  .filter((r) => r.need > 0)
  .filter((r) => !r.path.startsWith('packages/services/'))
  .filter((r) => !L0.has(r.path))
  .sort((a, b) => b.need - a.need || a.path.localeCompare(b.path));

let i = 0;
for (let b = start; b < start + count && i < rows.length; b++) {
  const batch = [];
  let sum = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (batch.length >= 20) break;
    if (batch.length > 0 && sum + r.need > 2000) break;
    batch.push(r);
    sum += r.need;
    i++;
  }
  console.log(`\n**B${b}**（${batch.length} 文件，缺口 ${sum} 行）`);
  for (const r of batch) {
    console.log(`- \`${r.path}\` — ${r.need}`);
  }
}
