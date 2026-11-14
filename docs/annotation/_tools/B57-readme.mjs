import fs from 'node:fs';
const RL = 'd:/code/opensource/valkey/docs/annotation/README-rework.md';
const tbl = fs.readFileSync('d:/code/_annot_baseline/B-table.md', 'utf8').trimEnd();
let s = fs.readFileSync(RL, 'utf8');

const bulletOld = '- B 档总数：102 个 .c / 57,100 单元；已做 64 个 / 37,224 单元；剩余 **38 个 / 19,876 单元**（未覆盖 17,345）。';
const bulletNew = '- B 档总数：102 个 .c / 57,100 单元；已做 65 个 / 37,294 单元；剩余 **37 个 / 19,806 单元**（未覆盖 17,286）。';
if (!s.includes(bulletOld)) { console.error('BULLET MISS'); process.exit(2); }
s = s.replace(bulletOld, bulletNew);

const rowOld = '| VK-B56 | src/lolwut5.c | 60 | 60 | 0 | 0 | 0 | 0 | 15.4% → 98.5% | 7.7% → 100.0% |';
const rowNew = rowOld + '\n| VK-B57 | src/lrulfu.c | 50 | 50 | 0 | 0 | 0 | 0 | 15.7% → 78.6% | 0.0% → 87.5% |';
if (!s.includes(rowOld)) { console.error('ROW MISS'); process.exit(2); }
s = s.replace(rowOld, rowNew);

const paraAnchor = '（首轮 3 行 W、1 行 weak 均为缺锚点，补反引号标识符后清零）。';
const paraNew = paraAnchor + '\n\n' +
  'B57：`src/lrulfu.c` 单文件单片完成，注释主线是「同一个 24 位字段的两种读法」与两处刻意的回绕。其一，LRU 侧：`lru_import` 把空闲秒数缩放后从当前时钟减去再掩 24 位，减法下溢是预期行为而非 bug；`lru_getIdleSecs` 做完全对称的反向减法；`LRU_CLOCK_RESOLUTION` 只有测试构建会改成非 1000，两个方向都必须用 `long` 中转再乘除，避免 32 位溢出。其二，LFU 侧：高 16 位（实际只用 8 位）存分钟、低 8 位存对数频次，`LFUDecay` 用 16 位减法算出跨过的分钟并在 65536 分钟（约 45 天）处回绕；`num_periods` 由 `lfu_config_decay_time` 做整数除法，配置为 0 时恒 0（永不衰减）；频次用饱和减法归 0，避免 `uint8_t` 下溢成 255。其三，`LFULogIncr` 以 `LFU_INIT_VAL` = 5 为基准，低于基准的键概率恒为 1（保证新键至少被记一次），高于基准后概率随频次对数下降，`lfu_config_log_factor` 为 0 时退化为恒增；255 直接返回以饱和。其四，读与写分流：`lfu_touch` 先衰减再自增，`lfu_getFrequency` 只衰减不自增；`lru_touch` 等价于 `lru_import(0)`；`lrulfu_init` 按策略返回 5 或当前时刻；`lrulfu_getIdleness` 把 LFU 频次取反为 `255 - freq`，让两种策略的「空闲度」同向可比。语句 15.7% → 78.6%、分支 0.0% → 87.5%，`added=50 / extra=0 / water=0 / weak=0 / filler=0 / deletedNonZero=0 / syntaxErr=0`（首轮 1 行 W 补反引号标识符后清零；剩余未覆盖单元为 `#include`/`#define` 与常量声明，按 8.9 口径不插）。';
if (!s.includes(paraAnchor)) { console.error('PARA MISS'); process.exit(2); }
s = s.replace(paraAnchor, paraNew);

const cumOld = 'B56 再增 62 行（60 行源码 + 2 行 README）至 159 文件 / 74,863 行（新增 `weak-exemptions.md` 与 §8.14 后以 `git diff --shortstat c96bdec` 实测为准），water 仍 369（0.50%）。';
const cumNew = 'B56 再增 62 行（60 行源码 + 2 行 README）至 159 文件 / 74,863 行；B57 再增 52 行（50 行源码 + 2 行 README）至 160 文件 / 74,915 行，water 仍 369（0.50%）。';
if (!s.includes(cumOld)) { console.error('CUM MISS'); process.exit(2); }
s = s.replace(cumOld, cumNew);

s = s.replace('A15–A34、B2–B56 新增行 W = 0', 'A15–A34、B2–B57 新增行 W = 0');

const start = s.indexOf('| 文件 | 单元 | 已做 | 剩余 | 语句 | 分支 |');
if (start < 0) { console.error('TABLE MISS'); process.exit(2); }
const endMark = s.indexOf('\n\n## 4.', start);
if (endMark < 0) { console.error('END MISS'); process.exit(2); }
s = s.slice(0, start) + tbl + s.slice(endMark);

fs.writeFileSync(RL, s);
console.log('readme updated for B57');
