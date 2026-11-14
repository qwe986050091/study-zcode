import fs from 'node:fs';
const RL = 'd:/code/opensource/valkey/docs/annotation/README-rework.md';
const tbl = fs.readFileSync('d:/code/_annot_baseline/B-table.md', 'utf8').trimEnd();
let s = fs.readFileSync(RL, 'utf8');

const bulletOld = '- B 档总数：102 个 .c / 57,100 单元；已做 62 个 / 37,083 单元；剩余 **40 个 / 20,017 单元**（未覆盖 17,452）。';
const bulletNew = '- B 档总数：102 个 .c / 57,100 单元；已做 63 个 / 37,159 单元；剩余 **39 个 / 19,941 单元**（未覆盖 17,400）。';
if (!s.includes(bulletOld)) { console.error('BULLET MISS'); process.exit(2); }
s = s.replace(bulletOld, bulletNew);

const rowOld = '| VK-B54 | src/lolwut.c | 57 | 57 | 0 | 0 | 0 | 0 | 18.3% → 90.1% | 14.3% → 100.0% |';
const rowNew = rowOld + '\n| VK-B55 | src/zipmap.c | 60 | 60 | 0 | 0 | 0 | 0 | 31.6% → 86.8% | 60.0% → 100.0% |';
if (!s.includes(rowOld)) { console.error('ROW MISS'); process.exit(2); }
s = s.replace(rowOld, rowNew);

const paraAnchor = '（首轮 2 行 W、1 行 weak 均为缺锚点，补反引号标识符后清零）。';
const paraNew = paraAnchor + '\n\n' +
  'B55：`src/zipmap.c` 单文件单片完成，注释围绕「长度编码两态」与「不可信输入的两个溢出点」。其一，长度编码只有两种形态：首字节 < 254 即长度本身，等于 254 则后跟 4 字节主机序整数；`zipmapDecodeLength`/`zipmapEncodeLength` 严格对称，`p == NULL` 时只返回所需字节数（1 或 5），`zipmapRawKeyLength`/`zipmapRawValueLength` 靠它反推头宽；value 记录额外有 1 字节 free 计数，`zipmapNext` 因此先 `+1` 再解长度。其二，深校验把输入当攻击者可控数据：`l`、`l + e` 都先转 `uint64_t` 再与剩余空间比较，避免 32 位回绕后 `p += l` 绕过 `OUT_OF_RANGE`（CWE-190）；每次前进后都重新做边界检查，`count` 只统计完整解析的记录。其三，规范性检查拒绝「小长度用 5 字节编码」的非唯一表示，让同一个逻辑结构只有一种合法字节序列；浅校验只验头尾，`deep` 为 0 时直接返回 1。其四，头部计数为 254 表示已溢出、需靠遍历计数，此时跳过与 `count` 的比对；空结构（`count == 0`）一律判非法。语句 31.6% → 86.8%、分支 60.0% → 100.0%，`added=60 / extra=0 / water=0 / weak=0 / filler=0 / deletedNonZero=0 / syntaxErr=0`（首轮 3 行 W 补反引号标识符后清零；文件内 1.6% weak 来自原有英文示例块注释，属历史内容，本批未改动）。';
if (!s.includes(paraAnchor)) { console.error('PARA MISS'); process.exit(2); }
s = s.replace(paraAnchor, paraNew);

const cumOld = 'B54 再增 59 行（57 行源码 + 2 行 README）至 158 文件 / 74,493 行，water 仍 369（0.50%）。';
const cumNew = 'B54 再增 59 行（57 行源码 + 2 行 README）至 158 文件 / 74,493 行；B55 再增 62 行（60 行源码 + 2 行 README）至 159 文件 / 74,555 行，water 仍 369（0.50%）。';
if (!s.includes(cumOld)) { console.error('CUM MISS'); process.exit(2); }
s = s.replace(cumOld, cumNew);

s = s.replace('A15–A34、B2–B54 新增行 W = 0', 'A15–A34、B2–B55 新增行 W = 0');

const start = s.indexOf('| 文件 | 单元 | 已做 | 剩余 | 语句 | 分支 |');
if (start < 0) { console.error('TABLE MISS'); process.exit(2); }
const endMark = s.indexOf('\n\n## 4.', start);
if (endMark < 0) { console.error('END MISS'); process.exit(2); }
s = s.slice(0, start) + tbl + s.slice(endMark);

fs.writeFileSync(RL, s);
console.log('readme updated for B55');
