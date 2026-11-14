import fs from 'node:fs';
const P = 'd:/code/opensource/valkey/docs/annotation/README-rework.md';
const T = 'd:/code/_annot_baseline/B-table.md';
let lines = fs.readFileSync(P, 'utf8').split(/\r?\n/);

// 1) §3 统计行（按内容定位，不写死行号）
const bullet = lines.findIndex((l) => l.startsWith('- B 档总数：'));
if (bullet < 0) throw new Error('bullet not found');
lines[bullet] = '- B 档总数：102 个 `.c` / 57,100 单元；已做 44 个 / 32,688 单元；剩余 **58 个 / 24,412 单元**（未覆盖 21,348）。';

// 2) §3 表体替换为 B-table.md（含表头与合计行）
const head = lines.findIndex((l) => l.startsWith('| 文件 | 单元 | 已做 | 剩余 | 语句 | 分支 |'));
const tail = lines.findIndex((l) => l.startsWith('| **合计（'));
if (head < 0 || tail < 0 || tail <= head) throw new Error('table bounds not found');
const table = fs.readFileSync(T, 'utf8').replace(/\n$/, '').split(/\r?\n/);
lines.splice(head, tail - head + 1, ...table);

// 3) §5 追加 B33/B34 记录
const sec8 = lines.findIndex((l) => l.startsWith('## 8. W 判据校准与门禁'));
if (sec8 < 0) throw new Error('section 8 not found');
const block = [
  '| 批次 | 文件 | 语句 前→后 | 分支 前→后 | 校验 |',
  '| --- | --- | --- | --- | --- |',
  '| B33 | compression_zstd.c | 7.9% → 100.0% | 3.8% → 100.0% | vk-verify PASS（+128 / 0 删除 / syntaxErr 0）；extra 0 / water 0 |',
  '| B34 | valkey-check-aof.c | 6.3% → 98.7% | 7.0% → 100.0% | vk-verify PASS（+294 / 0 删除 / syntaxErr 0）；extra 0 / water 0 |',
  '',
  'B33/B34 合计 +422 条：实质率 100%（B33）/ 84.3%（B34），解释率 100%，注水 0。`compression_zstd.c` 的 `HAVE_ZSTD` 真实现与 `#else` 桩两支全部覆盖；`valkey-check-aof.c` 剩 4 个未覆盖单元是 `ERROR` 宏的续行（63–66），续行符 `\\` 后不能插入独立整行注释，按结构性不可写处理，语句上限 98.7%。',
  '',
];
lines.splice(sec8, 0, ...block);
fs.writeFileSync(P, lines.join('\n'));
console.log(`README updated: bullet@${bullet + 1}, table ${head + 1}..${tail + 1}, block@${sec8 + 1}`);
