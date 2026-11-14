import fs from 'node:fs';
const RL = 'd:/code/opensource/valkey/docs/annotation/README-rework.md';
const tbl = fs.readFileSync('d:/code/_annot_baseline/B-table.md', 'utf8').trimEnd();
let s = fs.readFileSync(RL, 'utf8');

const bulletOld = '- B 档总数：102 个 .c / 57,100 单元；已做 56 个 / 36,790 单元；剩余 **46 个 / 20,310 单元**（未覆盖 17,695）。';
const bulletNew = '- B 档总数：102 个 .c / 57,100 单元；已做 57 个 / 36,831 单元；剩余 **45 个 / 20,269 单元**（未覆盖 17,664）。';
if (!s.includes(bulletOld)) { console.error('BULLET MISS'); process.exit(2); }
s = s.replace(bulletOld, bulletNew);

const rowOld = '| VK-B48 | src/valkey_strtod.c | 39 | 39 | 0 | 0 | 0 | 0 | 9.8% → 95.1% | 0.0% → 100.0% |';
const rowNew = rowOld + '\n| VK-B49 | src/modules/hellodict.c | 37 | 37 | 0 | 0 | 0 | 0 | 24.4% → 87.8% | 0.0% → 100.0% |';
if (!s.includes(rowOld)) { console.error('ROW MISS'); process.exit(2); }
s = s.replace(rowOld, rowNew);

const paraAnchor = '；剩余 2 个未覆盖单元是 `#include` 与 `FFC_IMPL` 附近的预处理行，按 8.9 口径不插注释。';
const paraNew = paraAnchor + '\n\n' +
  'B49：`src/modules/hellodict.c` 单文件单片完成，示范模块字典 API 的三条隐藏约定。其一，`ValkeyModule_DictSet` 底层是 `raxTryInsert`：键已存在时返回 `VALKEYMODULE_ERR` 且**不覆盖**旧值，`cmd_SET` 忽略返回值，因此对已存在的键重复 SET 是「回 +OK 但静默无效」——这是示例代码的取舍，注释按事实写明。其二，字典只存值指针、不复制对象，`cmd_SET` 必须 `ValkeyModule_RetainString` 让值活过回调；`cmd_GET` 拿回的就是同一个对象，`DictGet` 的 `nokey` 传 NULL 使「键不存在」与「存了 NULL」不可区分。其三，`KEYRANGE` 用 `">="` 定位 `startkey`、`DictCompare("<=", endkey)` 收尾，`POSTPONED_LEN` 必须与 `ReplySetArrayLength` 成对，`DictNextC` 返回的键指针只到下一次步进为止（所以先 `ReplyWithStringBuffer` 落盘），迭代器必须 `DictIteratorStop`。另注明 `Keyspace` 用 `CreateDict(NULL)` 建立，不挂模块自动内存管理，卸载时不回收；三处 `CreateCommand` 的 `1,1,1` 只声明 argv[1] 为键，集群模式下 `endkey` 不参与槽位计算。语句 24.4% → 87.8%、分支 0.0% → 100.0%，`added=37 / extra=0 / water=0 / weak=0 / filler=0 / deletedNonZero=0 / syntaxErr=0`。';
if (!s.includes(paraAnchor)) { console.error('PARA MISS'); process.exit(2); }
s = s.replace(paraAnchor, paraNew);

const cumOld = 'B48 再增 41 行（39 行源码 + 2 行 README）至 152 文件 / 74,235 行，water 仍 369（0.50%）。';
const cumNew = 'B48 再增 41 行（39 行源码 + 2 行 README）至 152 文件 / 74,235 行；B49 再增 39 行（37 行源码 + 2 行 README）至 153 文件 / 74,274 行，water 仍 369（0.50%）。';
if (!s.includes(cumOld)) { console.error('CUM MISS'); process.exit(2); }
s = s.replace(cumOld, cumNew);

s = s.replace('A15–A34、B2–B48 新增行 W = 0', 'A15–A34、B2–B49 新增行 W = 0');

const start = s.indexOf('| 文件 | 单元 | 已做 | 剩余 | 语句 | 分支 |');
if (start < 0) { console.error('TABLE MISS'); process.exit(2); }
const endMark = s.indexOf('\n\n## 4.', start);
if (endMark < 0) { console.error('END MISS'); process.exit(2); }
s = s.slice(0, start) + tbl + s.slice(endMark);

fs.writeFileSync(RL, s);
console.log('readme updated for B49');
