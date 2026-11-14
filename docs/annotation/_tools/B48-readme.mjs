import fs from 'node:fs';
const RL = 'd:/code/opensource/valkey/docs/annotation/README-rework.md';
const tbl = fs.readFileSync('d:/code/_annot_baseline/B-table.md', 'utf8').trimEnd();
let s = fs.readFileSync(RL, 'utf8');

const bulletOld = '- B 档总数：102 个 .c / 57,100 单元；已做 55 个 / 36,749 单元；剩余 **47 个 / 20,351 单元**（未覆盖 17,732）。';
const bulletNew = '- B 档总数：102 个 .c / 57,100 单元；已做 56 个 / 36,790 单元；剩余 **46 个 / 20,310 单元**（未覆盖 17,695）。';
if (!s.includes(bulletOld)) { console.error('BULLET MISS'); process.exit(2); }
s = s.replace(bulletOld, bulletNew);

const rowOld = '| VK-B47 | src/localtime.c | 47 | 47 | 0 | 0 | 0 | 0 | 12.2% → 95.1% | 0.0% → 100.0% |';
const rowNew = rowOld + '\n| VK-B48 | src/valkey_strtod.c | 39 | 39 | 0 | 0 | 0 | 0 | 9.8% → 95.1% | 0.0% → 100.0% |';
if (!s.includes(rowOld)) { console.error('ROW MISS'); process.exit(2); }
s = s.replace(rowOld, rowNew);

const paraAnchor = '分支 0.0% → 100.0%，`added=47 / extra=0 / water=0 / weak=0 / filler=0 / deletedNonZero=0 / syntaxErr=0`。';
const paraNew = paraAnchor + '\n\n' +
  'B48：`src/valkey_strtod.c` 单文件单片完成（4 个公开入口 + 2 个内部辅助）。要点是「同一 API、两套后端」：`valkey_strtod_n` 先用 `valkey_strtod_use_libc` 判输入形态，十六进制浮点（可选符号后 `0x`/`0X`）与带前导空白的串回退到 libc `strtod`，其余走头文件内联的 ffc 快路径——9.0 的 `strtod` 接受这两类输入而 ffc 不接受，回退是为了不改既有解析结果。失败语义两条路径对齐：`errno` 在入口清零，`EINVAL` 表示语法不成立、`ERANGE` 表示越界（由 ffc 的 `OUT_OF_RANGE` 映射而来）；返回值不参与成败判定，`endptr` 是否前进才是「消费了几个字符」的依据。libc 回退用 5KB 栈缓冲，`len >= sizeof(buf)` 直接 `EINVAL` 且 `endptr` 指回原串（一个字符都没消费），不做截断式部分解析。`valkey_strtod` / `valkey_strtod_sds` 只是取长度方式不同（`strlen` / `sdslen`），后者允许串内内嵌 NUL。语句 9.8% → 95.1%、分支 0.0% → 100.0%，`added=39 / extra=0 / water=0 / weak=0 / filler=0 / deletedNonZero=0 / syntaxErr=0`；剩余 2 个未覆盖单元是 `#include` 与 `FFC_IMPL` 附近的预处理行，按 8.9 口径不插注释。';
if (!s.includes(paraAnchor)) { console.error('PARA MISS'); process.exit(2); }
s = s.replace(paraAnchor, paraNew);

const cumOld = 'B47 再增 49 行（47 行源码 + 2 行 README）至 151 文件 / 74,194 行，water 仍 369（0.50%）。';
const cumNew = 'B47 再增 49 行（47 行源码 + 2 行 README）至 151 文件 / 74,194 行；B48 再增 41 行（39 行源码 + 2 行 README）至 152 文件 / 74,235 行，water 仍 369（0.50%）。';
if (!s.includes(cumOld)) { console.error('CUM MISS'); process.exit(2); }
s = s.replace(cumOld, cumNew);

s = s.replace('A15–A34、B2–B47 新增行 W = 0', 'A15–A34、B2–B48 新增行 W = 0');

const start = s.indexOf('| 文件 | 单元 | 已做 | 剩余 | 语句 | 分支 |');
if (start < 0) { console.error('TABLE MISS'); process.exit(2); }
const endMark = s.indexOf('\n\n## 4.', start);
if (endMark < 0) { console.error('END MISS'); process.exit(2); }
s = s.slice(0, start) + tbl + s.slice(endMark);

fs.writeFileSync(RL, s);
console.log('readme updated: bullet + row + para + cum + section3 table');
