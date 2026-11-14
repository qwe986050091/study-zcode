import fs from 'node:fs';
const RL = 'd:/code/opensource/valkey/docs/annotation/README-rework.md';
const tbl = fs.readFileSync('d:/code/_annot_baseline/B-table.md', 'utf8').trimEnd();
let s = fs.readFileSync(RL, 'utf8');

const bulletOld = '- B 档总数：102 个 .c / 57,100 单元；已做 61 个 / 37,012 单元；剩余 **41 个 / 20,088 单元**（未覆盖 17,510）。';
const bulletNew = '- B 档总数：102 个 .c / 57,100 单元；已做 62 个 / 37,083 单元；剩余 **40 个 / 20,017 单元**（未覆盖 17,452）。';
if (!s.includes(bulletOld)) { console.error('BULLET MISS'); process.exit(2); }
s = s.replace(bulletOld, bulletNew);

const rowOld = '| VK-B53 | src/throttle_token_bucket.c | 36 | 36 | 0 | 0 | 0 | 0 | 17.4% → 82.6% | 20.0% → 100.0% |';
const rowNew = rowOld + '\n| VK-B54 | src/lolwut.c | 57 | 57 | 0 | 0 | 0 | 0 | 18.3% → 90.1% | 14.3% → 100.0% |';
if (!s.includes(rowOld)) { console.error('ROW MISS'); process.exit(2); }
s = s.replace(rowOld, rowNew);

const paraAnchor = '（首轮 1 行 W、4 行 weak 均为缺锚点，补反引号标识符后清零）。';
const paraNew = paraAnchor + '\n\n' +
  'B54：`src/lolwut.c` 单文件单片完成，覆盖版本分派与通用画布两部分。其一，`VERSION <n>` 解析要求 `argc >= 3` 且 `argv[1]` 大小写不敏感等于 `version`；成功时把数字拼进 64 字节栈缓冲 `verstr`，随后 `argv += 2` / `argc -= 2` 把选项从子命令视野中摘掉，分派结束后再用 `v == verstr` 这个指针相等标记判断是否需要 `-= 2` 还原——用指针身份而非字符串内容做状态位，避免误还原。分派规则写明：5.x（除 5.9）与 4.9 走 `lolwut5Command`，6.x（除 6.9）与 5.9 走 `lolwut6Command`，主版本 9 走 `lolwut9Command`，其余走不稳定版横幅。其二，画布 `lwCanvas` 与像素缓冲分两次分配、`lwFreeCanvas` 按相反顺序释放；`width*height` 先转 `size_t` 再相乘防 `int` 溢出；`lwDrawPixel`/`lwGetPixel` 的越界读写都是无害空操作或返回背景 0，这是画线/画方依赖的契约。其三，Bresenham 用 `err = dx - dy` 与倍增的 `e2` 取代浮点除法，终点「先画后判」保证两端都包含，两个 `if` 独立使斜线可能同轮双步。其四，`lwDrawSquare` 用参数方程取圆上四点：45 度起步、每次加 `M_PI/2`，除以 `SQRT(2)` 把「半径」换算成边长系数再 `round` 到像素，最后用 `(j + 1) % 4` 闭合四条边。语句 18.3% → 90.1%、分支 14.3% → 100.0%，`added=57 / extra=0 / water=0 / weak=0 / filler=0 / deletedNonZero=0 / syntaxErr=0`（首轮 2 行 W、1 行 weak 均为缺锚点，补反引号标识符后清零）。';
if (!s.includes(paraAnchor)) { console.error('PARA MISS'); process.exit(2); }
s = s.replace(paraAnchor, paraNew);

const cumOld = 'B53 再增 38 行（36 行源码 + 2 行 README）至 157 文件 / 74,434 行，water 仍 369（0.50%）。';
const cumNew = 'B53 再增 38 行（36 行源码 + 2 行 README）至 157 文件 / 74,434 行；B54 再增 59 行（57 行源码 + 2 行 README）至 158 文件 / 74,493 行，water 仍 369（0.50%）。';
if (!s.includes(cumOld)) { console.error('CUM MISS'); process.exit(2); }
s = s.replace(cumOld, cumNew);

s = s.replace('A15–A34、B2–B53 新增行 W = 0', 'A15–A34、B2–B54 新增行 W = 0');

const start = s.indexOf('| 文件 | 单元 | 已做 | 剩余 | 语句 | 分支 |');
if (start < 0) { console.error('TABLE MISS'); process.exit(2); }
const endMark = s.indexOf('\n\n## 4.', start);
if (endMark < 0) { console.error('END MISS'); process.exit(2); }
s = s.slice(0, start) + tbl + s.slice(endMark);

fs.writeFileSync(RL, s);
console.log('readme updated for B54');
