// weak-guard：每批必跑的非回归断言（15 文件内 weak 绝对数每批不增）。
// 与「新增行 ∩ weak = ∅」方向不同：那条只看本批写进去的行，这条看整体有没有被别处带坏。
//
// 输入是两次 deep-quality --list-weak 的输出（同一份 15 文件清单，改写前后各一次）：
//   node weak-guard.mjs --pre b258-pre15.txt --post b258-post15.txt [--max 6]
// 判定：
//   1) 两份输出必须各有 WEAK lines=N 且 N == 实际 WEAK 行数（尺子自检）；
//   2) files=15（清单必须覆盖全部文件）；
//   3) 比较键是「文件 + weak 行正文」的多重集合，不是行号：本批一旦插入/删除行，
//      已有 weak 行整体位移，按行号比会把「旧 weak 位移」误判成「新增 weak」（b258 已论证）；
//   4) post 任一键的出现次数 > pre 即视为新增 weak，逐条打印 `文件:行 原因 正文`；
//   5) pre 条数 > --max（缺省 8，B1 前冻结基线）也失败。
//
// 已知盲区（这是「近似守卫」，`新增=0` 只代表按本键没测到新增，不等于「绝对没新增」）：
//   ① 同一文件内两行同正文时按出现次数比：若其中一行位移、另一行被改写成与它相同的正文，
//      多集合计数不变，本守卫漏判（只看次数，不看是「哪一行」）；
//   ② 只比正文、不校验位置：同一文件内两行 weak 的正文互换，键的多重集合不变，本守卫不报；
//   ③ 多重集合的作用域是单个文件：跨文件把两行 weak 正文互换（A 文件的正文挪到 B 文件、
//      B 文件的正文挪到 A 文件），每个文件的计数都不变，本守卫不报。
//   以上三条都不改判据，只说明边界；需要逐行定位时以 deep-quality 的明细与人工复核为准。
import fs from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
};

const parse = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('WEAK\t')) continue;
    const [, where, reason, content] = line.split('\t');
    const m = /^(.*):(\d+)$/.exec(where ?? '');
    if (!m) continue;
    rows.push({
      file: m[1],
      line: Number(m[2]),
      reason: reason ?? '',
      content: (content ?? '').replace(/\s+/g, ' ').trim(),
      where,
    });
  }
  const m = /^WEAK lines=(\d+) files=(\d+)$/m.exec(text);
  const s = /^SUMMARY .*files=(\d+) /m.exec(text);
  return { rows, declared: m ? Number(m[1]) : null, files: s ? Number(s[1]) : null };
};

const preFile = opt('pre');
const postFile = opt('post');
if (!preFile || !postFile) {
  console.error('用法: node weak-guard.mjs --pre <pre.log> --post <post.log> [--max 8]');
  process.exit(2);
}
const max = Number(opt('max', '8'));
const pre = parse(preFile);
const post = parse(postFile);
const fail = [];

for (const [name, r] of [['pre', pre], ['post', post]]) {
  if (r.declared === null) fail.push(`${name} 缺 WEAK lines=N 行（--list-weak 未开？）`);
  else if (r.declared !== r.rows.length) fail.push(`${name} 尺子自检失败：WEAK lines=${r.declared} ≠ 明细 ${r.rows.length}`);
  if (r.files !== 15) fail.push(`${name} 文件数 ${r.files} ≠ 15（清单必须覆盖全部 15 个文件）`);
}

// 多重集合：同一文件里可能出现两行一模一样的 weak，按出现次数比较，不用行号。
const keyOf = (r) => `${r.file}\u0000${r.content || r.reason}`;
const counts = (rows) => {
  const m = new Map();
  for (const r of rows) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + 1);
  return m;
};
const preCount = counts(pre.rows);
const postCount = counts(post.rows);
const added = [];
const seen = new Map();
for (const r of post.rows) {
  const k = keyOf(r);
  const extra = (postCount.get(k) ?? 0) - (preCount.get(k) ?? 0);
  const n = seen.get(k) ?? 0;
  if (n < extra) added.push(r);
  seen.set(k, n + 1);
}
console.log(`WEAK 15文件  pre=${pre.rows.length}  post=${post.rows.length}  新增=${added.length}  max=${max}  key=file+正文`);
if (added.length) for (const a of added) console.log(`  NEW ${a.where}\t${a.reason}\t${a.content}`);
if (post.rows.length > pre.rows.length) fail.push(`weak 上升：${pre.rows.length} → ${post.rows.length}`);
if (pre.rows.length > max) fail.push(`pre weak ${pre.rows.length} > 冻结基线 ${max}`);
if (added.length) fail.push(`新增 weak ${added.length} 行（见 NEW）`);

if (fail.length) {
  for (const f of fail) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log('GUARD PASS');
