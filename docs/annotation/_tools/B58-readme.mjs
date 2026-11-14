import fs from 'node:fs';
const RL = 'd:/code/opensource/valkey/docs/annotation/README-rework.md';
const tbl = fs.readFileSync('d:/code/_annot_baseline/B-table.md', 'utf8').trimEnd();
let s = fs.readFileSync(RL, 'utf8');

const bulletOld = '- B 档总数：102 个 .c / 57,100 单元；已做 65 个 / 37,294 单元；剩余 **37 个 / 19,806 单元**（未覆盖 17,286）。';
const bulletNew = '- B 档总数：102 个 .c / 57,100 单元；已做 66 个 / 37,363 单元；剩余 **36 个 / 19,737 单元**（未覆盖 17,226）。';
if (!s.includes(bulletOld)) { console.error('BULLET MISS'); process.exit(2); }
s = s.replace(bulletOld, bulletNew);

const rowOld = '| VK-B57 | src/lrulfu.c | 50 | 50 | 0 | 0 | 0 | 0 | 15.7% → 78.6% | 0.0% → 87.5% |';
const rowNew = rowOld + '\n| VK-B58 | src/mt19937-64.c | 54 | 54 | 0 | 0 | 0 | 0 | 13.0% → 84.1% | 7.1% → 100.0% |';
if (!s.includes(rowOld)) { console.error('ROW MISS'); process.exit(2); }
s = s.replace(rowOld, rowNew);

const paraAnchor = '（首轮 1 行 W 补反引号标识符后清零；剩余未覆盖单元为 `#include`/`#define` 与常量声明，按 8.9 口径不插）。';
const paraNew = paraAnchor + '\n\n' +
  'B58：`src/mt19937-64.c` 单文件单片完成，为上游参考实现的 64 位 Mersenne Twister，注释只写「为什么这样写」而不复述算法名。其一，状态与惰性播种：312 个字是全局单例，`mti == NN + 1` 是未播种哨兵，首次取数时用默认种子 5489 自动初始化，因此调用顺序不影响序列。其二，两种播种：`init_genrand64` 用 64 位递推填满状态，乘法溢出按模 2^64 回绕是算法定义；`init_by_array64` 先以固定 19650218 铺底，再跑两轮不同乘法常数（3935559000370003845 / 2862933555777941757），下标越界时把 `mt[NN-1]` 复制到 `mt[0]` 保持递推链，key 用完则从头复用；末尾强制 `mt[0]` 最高位为 1，排除全零退化。其三，块生成与扭转：每 312 次取数触发一次重生成，分三段处理（`i < NN-MM` 直接读 `mt[i+MM]`、尾部 155 字用负偏移回绕、最后一字与 `mt[0]` 拼接成环），拼接固定为高 33 位 + 低 31 位，最低位选 `mag01[0]`/`mag01[1]`，随后 `mti` 归零。其四，回火四步（右 29、左 17、左 37、右 43）与三个输出接口的区间边界：`>>1` 得 [0,2^63-1]，除以 2^53-1 得闭区间 [0,1]，除以 2^53 得 [0,1)，取 52 位加 0.5 得 (0,1)；`main` 仅在 `MT19937_64_MAIN` 下编译，用官方四字 key 与 1000 组输出自检。语句 13.0% → 84.1%、分支 7.1% → 100.0%，`added=54 / extra=0 / water=0 / weak=0 / filler=0 / deletedNonZero=0 / syntaxErr=0`（首轮 2 行 W、2 行 weak 均为缺锚点，补反引号标识符后清零；剩余未覆盖单元为宏、续行与函数括号，按 8.9 口径不插）。';
if (!s.includes(paraAnchor)) { console.error('PARA MISS'); process.exit(2); }
s = s.replace(paraAnchor, paraNew);

const cumOld = 'B57 再增 52 行（50 行源码 + 2 行 README）至 160 文件 / 74,915 行，water 仍 369（0.50%）。';
const cumNew = 'B57 再增 52 行（50 行源码 + 2 行 README）至 160 文件 / 74,915 行；B58 再增 56 行（54 行源码 + 2 行 README）至 161 文件 / 74,971 行，water 仍 369（0.50%）。';
if (!s.includes(cumOld)) { console.error('CUM MISS'); process.exit(2); }
s = s.replace(cumOld, cumNew);

s = s.replace('A15–A34、B2–B57 新增行 W = 0', 'A15–A34、B2–B58 新增行 W = 0');

const start = s.indexOf('| 文件 | 单元 | 已做 | 剩余 | 语句 | 分支 |');
if (start < 0) { console.error('TABLE MISS'); process.exit(2); }
const endMark = s.indexOf('\n\n## 4.', start);
if (endMark < 0) { console.error('END MISS'); process.exit(2); }
s = s.slice(0, start) + tbl + s.slice(endMark);

fs.writeFileSync(RL, s);
console.log('readme updated for B58');
