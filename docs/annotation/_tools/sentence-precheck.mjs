// 起草后、judge 前的机械自检（0.5s，不改尺）：
//   node sentence-precheck.mjs --plan b365-plan-new.tsv [--repo d:/code/ZCode]
// 只查两类机械可判的问题：① 行内无可定位锚点；② 逗号 >=2 且无谓词表词汇。
// 全 0 才进 judge-generic。
//
// [规则说明·b373 实测] ② 的分隔符统计**穿透反引号**：`、` `,` `，` 一律计入，不区分是否在代码片段里。
// 所以注释里写带参调用（如 `replace(/^\/+/, "")`）或数组字面量，代码里的逗号会被算成两处分隔，
// 直接命中 L「无信息列举」。这不是闸的漏洞，是**可主动规避**的写法约束：
// 引用正则/调用时拆成 `replace` 配 `/^\/+/` 两段写，或改用不带逗号的片段。
// b373 `slashCommandHelpers.ts:111` 就是这一条的唯一反例。
import fs from 'node:fs';
import { PREDICATE } from './zc-vocab.mjs';

const argv = process.argv.slice(2);
const opt = (n, d = '') => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const plan = opt('plan');
const repo = opt('repo', 'd:/code/ZCode');
if (!plan) {
  console.error('usage: node sentence-precheck.mjs --plan <plan.tsv> [--repo <root>]');
  process.exit(2);
}

const ANCHOR = /[`\d]|[A-Za-z_][A-Za-z0-9_.]{2,}/;

const rows = fs.readFileSync(plan, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).slice(1).filter(Boolean);
const missingAnchor = [];
const missingPredicate = [];
for (const l of rows) {
  const c = l.split('\t');
  if (c.length < 4) continue;
  const [file, line, , content] = c;
  const body = content.replace(/^\s*\/\/+\s?/, '');
  if (!ANCHOR.test(body)) missingAnchor.push(`${file}:${line}  ${body.slice(0, 60)}`);
  const seps = (body.match(/[、,，]/g) ?? []).length;
  if (seps >= 2 && !PREDICATE.test(body)) missingPredicate.push(`${file}:${line}  ${body.slice(0, 60)}`);
}
console.log(`plan rows=${rows.length}`);
console.log(`missing_anchor=${missingAnchor.length} missing_predicate=${missingPredicate.length}`);
for (const x of missingAnchor) console.log('  A ' + x);
for (const x of missingPredicate) console.log('  P ' + x);
process.exit(missingAnchor.length + missingPredicate.length ? 1 : 0);
