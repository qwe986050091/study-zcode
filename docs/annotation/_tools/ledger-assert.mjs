// b254 台账算术断言：把「手算多列」换成脚本输出，三条恒等式任一不成立即 exit 1。
//   1) Σ 各批登记表数据行 = 累计已处理
//   2) 累计已处理 + 剩余 = 802（剩余来自批次表里尚未完成的文件合计）
//   3) Σ 全仓实测 `^\s*// //` = 清单内 + 清单外
// b256 起额外输出滚动三列（144 / 658 / 802 的 计划 / 累计 / 剩余），并断言
// 144 列 + 658 列 = 802 列、两列计划数分别等于 144 / 658。
// 单一事实来源：docs/annotation/ZC-deep-b247.md 的批次表（15 个文件）+ 各批 *-rewrite.tsv。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 用法：node ledger-assert.mjs [--repo <仓库> | <仓库>]，缺省 d:/code/ZCode（与 zc-commit 的 --repo 习惯一致）。
const argv = process.argv.slice(2);
const repoAt = argv.indexOf('--repo');
const repoArg = repoAt >= 0 ? argv[repoAt + 1] : argv[0];
const repo = repoArg ? path.resolve(repoArg) : 'd:/code/ZCode';
const ledger = path.join(repo, 'docs/annotation');

// 批次表：| B7 | `path` | 144 | 658 | 合计 |
const plan = new Map();
const planOrder = [];
let planTotal = 0;
let planWater = 0;
let planValid = 0;
const planSplitMismatch = [];
for (const line of fs.readFileSync(path.join(ledger, 'ZC-deep-b247.md'), 'utf8').split(/\r?\n/)) {
  const m = /^\|\s*(B\d+)\s*\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*\**(\d+)\**\s*\|/.exec(line);
  if (!m) continue;
  const file = m[2];
  const water = Number(m[3]);
  const valid = Number(m[4]);
  const total = Number(m[5]);
  plan.set(file, { batch: m[1], water, valid, total });
  if (!planOrder.includes(file)) planOrder.push(file);
  planTotal += total;
  planWater += water;
  planValid += valid;
  if (water + valid !== total) planSplitMismatch.push(`${file}: ${water}+${valid}≠${total}`);
}

// 各批登记表：数据行数（去掉表头）。只统计「登记文件全部落在 b247 批次表内」的批次——
// 802 项目已收口，之后恢复的常规批（如 b261）登记的是池内其他文件，不得计入 802 的累计。
const batches = [];
const ignored = [];
let cum = 0;
for (const name of fs.readdirSync(ledger).sort()) {
  const m = /^ZC-deep-b(\d+)-rewrite\.tsv$/.exec(name);
  if (!m || Number(m[1]) < 248) continue;
  const rows = fs
    .readFileSync(path.join(ledger, name), 'utf8')
    .split(/\r?\n/)
    .filter((line, i) => line.trim() && i !== 0);
  const files = rows.map((line) => (line.split('\t')[0] ?? '').trim()).filter(Boolean);
  if (files.some((file) => !plan.has(file))) {
    ignored.push(`${name}（非 802 批次，${rows.length} 行不计入）`);
    continue;
  }
  batches.push({ name, rows: rows.length });
  cum += rows.length;
}

// 逐文件登记数：Σ 各批的行为口径是「每个文件登记行数 == 批次表计划行数」，
// 这样合批（同文件只进出一次）或漏登都会被下面这条断言抓住，而不是只抓总数。
const registered = new Map();
for (const b of batches) {
  for (const line of fs.readFileSync(path.join(ledger, b.name), 'utf8').split(/\r?\n/).slice(1)) {
    const file = (line.split('\t')[0] ?? '').trim();
    if (!file) continue;
    registered.set(file, (registered.get(file) ?? 0) + 1);
  }
}
const done = new Set([...registered.keys()].filter((file) => plan.has(file)));
const perFileMismatch = [...registered]
  .filter(([file, rows]) => !plan.has(file) || plan.get(file).total !== rows)
  .map(([file, rows]) => `${file}: 登记 ${rows} / 计划 ${plan.get(file)?.total ?? '(不在批次表)'}`);
const remaining = [...plan].filter(([file]) => !done.has(file)).reduce((a, [, v]) => a + v.total, 0);
// 收尾等式（b259）：剩余按批次聚合，必须与「累计 + 各未完成批 = 802」同一式子。
const undoneByBatch = new Map();
for (const [file, v] of plan) {
  if (done.has(file)) continue;
  undoneByBatch.set(v.batch, (undoneByBatch.get(v.batch) ?? 0) + v.total);
}
const undoneParts = [...undoneByBatch].sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)));
const undoneSum = undoneParts.reduce((a, [, n]) => a + n, 0);
// 144 / 658 两列：done 的文件整文件都做完了（先 144 后 658，同批进出），
// 因此已完成文件的 144 / 658 计划数就是累计数；用它与 802 累计互相校验。
const doneWater = [...done].reduce((a, f) => a + (plan.get(f)?.water ?? 0), 0);
const doneValid = [...done].reduce((a, f) => a + (plan.get(f)?.valid ?? 0), 0);
const remainWater = planWater - doneWater;
const remainValid = planValid - doneValid;

// 全仓实测：git grep -c 的逐文件计数
const grep = execFileSync('git', ['grep', '-c', '-E', '^\\s*// //'], { cwd: repo, encoding: 'utf8' });
const perFile = new Map();
for (const line of grep.split(/\r?\n/)) {
  const idx = line.lastIndexOf(':');
  if (idx < 0) continue;
  perFile.set(line.slice(0, idx), Number(line.slice(idx + 1)));
}
let inside = 0;
const outside = [];
for (const [file, count] of perFile) {
  if (plan.has(file)) inside += count;
  else outside.push({ file, count });
}
const total = [...perFile.values()].reduce((a, b) => a + b, 0);

// 清单外豁免清单：每条必须带「为什么不是漏账」的判据，且登记条数要与实测一致。
// 只豁免这里列出的文件；清单外出现未登记文件、或登记条数对不上，一律 exit 1。
const EXEMPT = new Map([
  [
    'docs/annotation/_tools/d7e-shift.mjs',
    {
      count: 1,
      why: '一次性迁移工具：第 2 行自述「// /// 文档注释…」被 `^\\s*// //` 命中，是工具在描述 // 与 /// 注释，不是待清的双前缀行',
    },
  ],
  [
    'docs/webdriverio/docs/ocr-testing/ocr-faq.md',
    {
      count: 1,
      why: '上游 WebdriverIO 文档：第 30 行是 OCR 示例代码里的原文样板 `// // With the default contrast…`，属于引用内容，不是本仓注释',
    },
  ],
]);

const fail = [];
console.log(`批次表：${planOrder.length} 文件 / 计划合计 ${planTotal} 行`);
for (const b of batches) console.log(`BATCH ${b.name}\t${b.rows} 行`);
if (ignored.length) console.log(`IGNORED ${ignored.join(' , ')}`);
console.log(`SUM 各批 = ${batches.map((b) => b.rows).join(' + ')} = ${cum}  ${perFileMismatch.length === 0 ? 'OK' : 'FAIL'}（逐文件登记数 == 批次表计划数）`);
console.log(`ROLL 144  计划 ${planWater}  累计 ${doneWater}  剩余 ${remainWater}  ${doneWater + remainWater === planWater ? 'OK' : 'FAIL'}`);
console.log(`ROLL 658  计划 ${planValid}  累计 ${doneValid}  剩余 ${remainValid}  ${doneValid + remainValid === planValid ? 'OK' : 'FAIL'}`);
console.log(`ROLL 802  计划 ${planTotal}  累计 ${cum}  剩余 ${remaining}  ${cum + remaining === planTotal ? 'OK' : 'FAIL'}`);
console.log(`CUM 累计 ${cum} + 剩余 ${remaining} = ${cum + remaining}  ${cum + remaining === planTotal ? 'OK' : 'FAIL'}`);
console.log(`PLAN 批次表合计 ${planTotal}  = 802  ${planTotal === 802 ? 'OK' : 'FAIL'}`);
console.log(`GREP 全仓 ${total} = 清单内 ${inside} + 清单外 ${total - inside}  ${inside + (total - inside) === total ? 'OK' : 'FAIL'}`);
const exemptRows = outside.filter((o) => EXEMPT.has(o.file));
const stray = outside.filter((o) => !EXEMPT.has(o.file));
const exemptSum = exemptRows.reduce((a, o) => a + o.count, 0);
console.log(`EXEMPT ${exemptSum}  ${exemptRows.map((o) => `${o.file}:${o.count}（${EXEMPT.get(o.file).why}）`).join(' , ') || '(无)'}`);
console.log(`REMAIN 剩余 = ${remaining}`);
console.log(
  `CLOSE ${cum}${undoneParts.map(([b, n]) => ` + ${b} ${n}`).join('')} = ${cum + undoneSum}  ${
    cum + undoneSum === planTotal && undoneSum === remaining ? 'OK' : 'FAIL'
  }`,
);
// 收尾用的 --file-list 必须就是批次表这 15 个文件本身，不能是另生成的一份。
const flArg = argv.indexOf('--file-list');
const flPath = flArg >= 0 ? path.resolve(argv[flArg + 1]) : 'd:/code/_annot_baseline/b254-802-files.txt';
if (fs.existsSync(flPath)) {
  const flFiles = fs.readFileSync(flPath, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const same =
    flFiles.length === planOrder.length &&
    new Set(flFiles).size === flFiles.length &&
    planOrder.every((f) => flFiles.includes(f));
  console.log(`FILELIST ${flFiles.length} 文件 == 批次表清单  ${same ? 'OK' : 'FAIL'}  (${flPath})`);
  if (!same) fail.push(`收尾 --file-list 与批次表清单不一致：${flPath}`);
} else {
  console.log(`FILELIST (未找到 ${flPath}，跳过)`);
}

for (const m of perFileMismatch) fail.push(`逐文件登记数 ≠ 计划数：${m}`);
for (const m of planSplitMismatch) fail.push(`批次表 144+658 ≠ 合计：${m}`);
if (planWater !== 144) fail.push(`批次表 144 列合计 ${planWater} ≠ 144`);
if (planValid !== 658) fail.push(`批次表 658 列合计 ${planValid} ≠ 658`);
if (doneWater + doneValid !== cum) fail.push(`144 累计 ${doneWater} + 658 累计 ${doneValid} ≠ 802 累计 ${cum}`);
if (cum + remaining !== planTotal) fail.push('累计 + 剩余 ≠ 计划合计');
if (cum + undoneSum !== planTotal) fail.push(`收尾等式不成立：${cum} + ${undoneSum} ≠ ${planTotal}`);
if (undoneSum !== remaining) fail.push(`各未完成批合计 ${undoneSum} ≠ 剩余 ${remaining}`);
if (planTotal !== 802) fail.push('批次表合计 ≠ 802');
if (inside + (total - inside) !== total) fail.push('清单内 + 清单外 ≠ 全仓');
if (inside !== remaining) fail.push(`清单内实测 ${inside} ≠ 剩余 ${remaining}`);
if (inside + exemptSum !== total) fail.push(`清单内 ${inside} + 豁免 ${exemptSum} ≠ 全仓 ${total}`);
for (const o of stray) fail.push(`清单外未豁免：${o.file}:${o.count}（要豁免请写进 EXEMPT 并给出判据）`);
for (const [file, spec] of EXEMPT) {
  const hit = perFile.get(file) ?? 0;
  if (hit !== spec.count) fail.push(`豁免登记 ${file} 期望 ${spec.count} 条，实测 ${hit} 条（豁免已过期或条数写错）`);
}
if (fail.length) {
  for (const f of fail) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log('ASSERT PASS');
