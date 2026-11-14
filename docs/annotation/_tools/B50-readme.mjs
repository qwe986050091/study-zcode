import fs from 'node:fs';
const RL = 'd:/code/opensource/valkey/docs/annotation/README-rework.md';
const tbl = fs.readFileSync('d:/code/_annot_baseline/B-table.md', 'utf8').trimEnd();
let s = fs.readFileSync(RL, 'utf8');

const bulletOld = '- B 档总数：102 个 .c / 57,100 单元；已做 57 个 / 36,831 单元；剩余 **45 个 / 20,269 单元**（未覆盖 17,664）。';
const bulletNew = '- B 档总数：102 个 .c / 57,100 单元；已做 58 个 / 36,875 单元；剩余 **44 个 / 20,225 单元**（未覆盖 17,626）。';
if (!s.includes(bulletOld)) { console.error('BULLET MISS'); process.exit(2); }
s = s.replace(bulletOld, bulletNew);

const rowOld = '| VK-B49 | src/modules/hellodict.c | 37 | 37 | 0 | 0 | 0 | 0 | 24.4% → 87.8% | 0.0% → 100.0% |';
const rowNew = rowOld + '\n| VK-B50 | src/lolwut9.c | 45 | 45 | 0 | 0 | 0 | 0 | 13.6% → 100.0% | 7.1% → 100.0% |';
if (!s.includes(rowOld)) { console.error('ROW MISS'); process.exit(2); }
s = s.replace(rowOld, rowNew);

const paraAnchor = '语句 24.4% → 87.8%、分支 0.0% → 100.0%，`added=37 / extra=0 / water=0 / weak=0 / filler=0 / deletedNonZero=0 / syntaxErr=0`。';
const paraNew = paraAnchor + '\n\n' +
  'B50：`src/lolwut9.c` 单文件单片完成，是 Julia 集字符画的完整示例，注释集中在四类「遮住也能读出后果」的点。其一，迭代核心 `juliaSetIteration` 的顺序不可压缩：`x_new` 必须用旧 y、`y_new` 必须用旧 x，先提交任一分量都会破坏迭代；逃逸判据是模长平方 > 4；跑满 `max_iter` 返回 `max_iter - 1`，与「最后一次才逃逸」同值，两种点在字符画上不可区分，注释写明这个哨兵值的歧义而不是粉饰。其二，参数面：合法 `argc` 只有 1/3/5，2 或 4 是缺一半、>5 是多余，全部显式回语法错误；`argc > 1`/`argc > 2` 的短路条件保证 `argv` 下标一定存在；解析失败时 helper 已回错误，随后只做裸 `return`；`cols/rows` 越界静默 clamp 到 1..160 / 1..80，把单次输出封在 160*80 格。其三，随机常数分支的 `rand()/(float)RAND_MAX*2-1` 落在 [-1,1)，上界取不到；与 `argc==5` 的 `long double` 解析路径在赋值处收窄到 float。其四，输出缓冲按 `(cols+1)*rows` 一次分配：每行多留 1 字节放换行，缓冲区不带 NUL、靠显式长度使用，行主序下标 `i*(cols+1)+j` 与行尾 `+cols` 正好填满；取模除数 `sizeof(ascii_array)` 含 NUL，但迭代值恒 < 11 选不到它。三处 `sdscatprintf/sdscat` 都可能 realloc，返回值必须回写；最后 `addReplyVerbatim(...,"txt")` 显式给长度，回复完成后再 `sdsfree`。语句 13.6% → 100.0%、分支 7.1% → 100.0%，`added=45 / extra=0 / water=0 / weak=0 / filler=0 / deletedNonZero=0 / syntaxErr=0`（首轮 2 行 W 为无锚点的单行注释，补反引号标识符后清零）。';
if (!s.includes(paraAnchor)) { console.error('PARA MISS'); process.exit(2); }
s = s.replace(paraAnchor, paraNew);

const cumOld = 'B49 再增 39 行（37 行源码 + 2 行 README）至 153 文件 / 74,274 行，water 仍 369（0.50%）。';
const cumNew = 'B49 再增 39 行（37 行源码 + 2 行 README）至 153 文件 / 74,274 行；B50 再增 47 行（45 行源码 + 2 行 README）至 154 文件 / 74,321 行，water 仍 369（0.50%）。';
if (!s.includes(cumOld)) { console.error('CUM MISS'); process.exit(2); }
s = s.replace(cumOld, cumNew);

s = s.replace('A15–A34、B2–B49 新增行 W = 0', 'A15–A34、B2–B50 新增行 W = 0');

const start = s.indexOf('| 文件 | 单元 | 已做 | 剩余 | 语句 | 分支 |');
if (start < 0) { console.error('TABLE MISS'); process.exit(2); }
const endMark = s.indexOf('\n\n## 4.', start);
if (endMark < 0) { console.error('END MISS'); process.exit(2); }
s = s.slice(0, start) + tbl + s.slice(endMark);

fs.writeFileSync(RL, s);
console.log('readme updated for B50');
