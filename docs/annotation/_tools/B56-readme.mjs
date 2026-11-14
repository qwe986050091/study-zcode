import fs from 'node:fs';
const RL = 'd:/code/opensource/valkey/docs/annotation/README-rework.md';
const tbl = fs.readFileSync('d:/code/_annot_baseline/B-table.md', 'utf8').trimEnd();
let s = fs.readFileSync(RL, 'utf8');

const bulletOld = '- B 档总数：102 个 .c / 57,100 单元；已做 63 个 / 37,159 单元；剩余 **39 个 / 19,941 单元**（未覆盖 17,400）。';
const bulletNew = '- B 档总数：102 个 .c / 57,100 单元；已做 64 个 / 37,224 单元；剩余 **38 个 / 19,876 单元**（未覆盖 17,345）。';
if (!s.includes(bulletOld)) { console.error('BULLET MISS'); process.exit(2); }
s = s.replace(bulletOld, bulletNew);

const rowOld = '| VK-B55 | src/zipmap.c | 60 | 60 | 0 | 0 | 0 | 0 | 31.6% → 86.8% | 60.0% → 100.0% |';
const rowNew = rowOld + '\n| VK-B56 | src/lolwut5.c | 60 | 60 | 0 | 0 | 0 | 0 | 15.4% → 98.5% | 7.7% → 100.0% |';
if (!s.includes(rowOld)) { console.error('ROW MISS'); process.exit(2); }
s = s.replace(rowOld, rowNew);

const paraAnchor = '（首轮 3 行 W 补反引号标识符后清零；文件内 1.6% weak 来自原有英文示例块注释，属历史内容，本批未改动）。';
const paraNew = paraAnchor + '\n\n' +
  'B56：`src/lolwut5.c` 单文件单片完成，Schotter 生成器与盲文渲染两部分各自成组。其一，画布几何：宽 = 终端列数 × 2（一个盲文字符横向覆盖 2 像素），`padding` 在宽 ≤4 时降为 0 以免内部宽度归零，`square_side` 是浮点除法、`canvas_height` 由浮点乘法截断而来；每格的 `sx/sy` 用 `x * square_side` 重算而不是累加，取整误差不跨格传播。其二，扰动规则：前两行 `angle` 恒为 0，从 `y > 1` 起取 `r1/r2/r3` 三个独立随机量，均按 `y / squares_per_col` 线性增强，再用 `rand() % 2` 各自随机取负；只有 `r1` 进入旋转，`r2/r3` 做平移且幅度上限为 `square_side / 3`，保证方块重叠但不出画布。其三，盲文编码：码点 = `0x2800 + byte`，8 个 `if` 按点阵图逐位点亮（位 0/1/2 为左列三行、3/4/5 为右列三行、6/7 为底部两行），再手工拆成 `1110xxxx 10xxxxxx 10xxxxxx` 三字节；`renderCanvas` 以 4 行 × 2 列为一组，`sdscatlen` 按 3 字节追加并回写指针。末尾换行条件 `y != canvas->height - 1` 仅在高度对齐 4 时命中，否则最后一行会多一个换行，注释如实写明而不美化。其四，参数面默认 66 列 / 8 行 / 12 列块，clamp 到 1..1000 / 1..200 / 1..200；每参数都先判 `argc` 再读 `argv`，失败时 helper 已回错误、只做裸返回；结尾按 sds → canvas 的顺序释放，与分配顺序相反。语句 15.4% → 98.5%、分支 7.7% → 100.0%，`added=60 / extra=0 / water=0 / weak=0 / filler=0 / deletedNonZero=0 / syntaxErr=0`（首轮 3 行 W、1 行 weak 均为缺锚点，补反引号标识符后清零）。';
if (!s.includes(paraAnchor)) { console.error('PARA MISS'); process.exit(2); }
s = s.replace(paraAnchor, paraNew);

const cumOld = 'B55 再增 62 行（60 行源码 + 2 行 README）至 159 文件 / 74,555 行，water 仍 369（0.50%）。';
const cumNew = 'B55 再增 62 行（60 行源码 + 2 行 README）至 159 文件 / 74,555 行；B56 再增 62 行（60 行源码 + 2 行 README）至 159 文件 / 74,863 行（新增 `weak-exemptions.md` 与 §8.14 后以 `git diff --shortstat c96bdec` 实测为准），water 仍 369（0.50%）。';
if (!s.includes(cumOld)) { console.error('CUM MISS'); process.exit(2); }
s = s.replace(cumOld, cumNew);

s = s.replace('A15–A34、B2–B55 新增行 W = 0', 'A15–A34、B2–B56 新增行 W = 0');

const start = s.indexOf('| 文件 | 单元 | 已做 | 剩余 | 语句 | 分支 |');
if (start < 0) { console.error('TABLE MISS'); process.exit(2); }
const endMark = s.indexOf('\n\n## 4.', start);
if (endMark < 0) { console.error('END MISS'); process.exit(2); }
s = s.slice(0, start) + tbl + s.slice(endMark);

fs.writeFileSync(RL, s);
console.log('readme updated for B56');
