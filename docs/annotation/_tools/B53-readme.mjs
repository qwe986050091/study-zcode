import fs from 'node:fs';
const RL = 'd:/code/opensource/valkey/docs/annotation/README-rework.md';
const tbl = fs.readFileSync('d:/code/_annot_baseline/B-table.md', 'utf8').trimEnd();
let s = fs.readFileSync(RL, 'utf8');

const bulletOld = '- B 档总数：102 个 .c / 57,100 单元；已做 60 个 / 36,966 单元；剩余 **42 个 / 20,134 单元**（未覆盖 17,548）。';
const bulletNew = '- B 档总数：102 个 .c / 57,100 单元；已做 61 个 / 37,012 单元；剩余 **41 个 / 20,088 单元**（未覆盖 17,510）。';
if (!s.includes(bulletOld)) { console.error('BULLET MISS'); process.exit(2); }
s = s.replace(bulletOld, bulletNew);

const rowOld = '| VK-B52 | src/modules/hellocluster.c | 36 | 36 | 0 | 0 | 0 | 0 | 15.2% → 73.9% | 0.0% → 100.0% |';
const rowNew = rowOld + '\n| VK-B53 | src/throttle_token_bucket.c | 36 | 36 | 0 | 0 | 0 | 0 | 17.4% → 82.6% | 20.0% → 100.0% |';
if (!s.includes(rowOld)) { console.error('ROW MISS'); process.exit(2); }
s = s.replace(rowOld, rowNew);

const paraAnchor = '（首轮 3 行 W 补反引号标识符后清零）。';
const paraNew = paraAnchor + '\n\n' +
  'B53：`src/throttle_token_bucket.c` 单文件单片完成，令牌桶的四个不变量逐条写明。其一，容量公式 `2 + rate * burst` 的下限 2 是防饿死项：低速率下 `rate*burst < 1` 时仍能攒够 1 个令牌；速率低于 `BUCKET_EPSILON`（0.0001）则容量直接取 0，把「关闭」与「极低速率」分开。其二，补充必须走 `getMonotonicUs`：墙体时间回拨会让无符号 `delta_us` 回绕成天文数字，令牌瞬间失控；`last_time_check` 只在累加并 `trimTokenBucket` 之后前移，同一段时间不会被重复计价。其三，`token_count` 允许为负，仅 `force_consume` 能透支，`trimTokenBucket` 把债务钳在 `-bucket_size`，使 `msUntilAvailable` 的等待时间有界；`setRate` 先用旧速率结清历史、写入新速率后再按新容量重钳，升速放大突发、降速收紧债务。其四，创建时初始令牌数为容量，首次 `tryConsume` 不必等待；`msUntilAvailable` 用 `-1` 表示零速率下的「永久不可用」，与「余额充足返回 `0.0`」严格区分。语句 17.4% → 82.6%、分支 20.0% → 100.0%，`added=36 / extra=0 / water=0 / weak=0 / filler=0 / deletedNonZero=0 / syntaxErr=0`（首轮 1 行 W、4 行 weak 均为缺锚点，补反引号标识符后清零）。';
if (!s.includes(paraAnchor)) { console.error('PARA MISS'); process.exit(2); }
s = s.replace(paraAnchor, paraNew);

const cumOld = 'B52 再增 38 行（36 行源码 + 2 行 README）至 156 文件 / 74,396 行，water 仍 369（0.50%）。';
const cumNew = 'B52 再增 38 行（36 行源码 + 2 行 README）至 156 文件 / 74,396 行；B53 再增 38 行（36 行源码 + 2 行 README）至 157 文件 / 74,434 行，water 仍 369（0.50%）。';
if (!s.includes(cumOld)) { console.error('CUM MISS'); process.exit(2); }
s = s.replace(cumOld, cumNew);

s = s.replace('A15–A34、B2–B52 新增行 W = 0', 'A15–A34、B2–B53 新增行 W = 0');

const start = s.indexOf('| 文件 | 单元 | 已做 | 剩余 | 语句 | 分支 |');
if (start < 0) { console.error('TABLE MISS'); process.exit(2); }
const endMark = s.indexOf('\n\n## 4.', start);
if (endMark < 0) { console.error('END MISS'); process.exit(2); }
s = s.slice(0, start) + tbl + s.slice(endMark);

fs.writeFileSync(RL, s);
console.log('readme updated for B53');
