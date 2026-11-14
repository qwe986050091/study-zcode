import fs from 'node:fs';
const RL = 'd:/code/opensource/valkey/docs/annotation/README-rework.md';
const tbl = fs.readFileSync('d:/code/_annot_baseline/B-table.md', 'utf8').trimEnd();
let s = fs.readFileSync(RL, 'utf8');

const bulletOld = '- B 档总数：102 个 .c / 57,100 单元；已做 58 个 / 36,875 单元；剩余 **44 个 / 20,225 单元**（未覆盖 17,626）。';
const bulletNew = '- B 档总数：102 个 .c / 57,100 单元；已做 59 个 / 36,920 单元；剩余 **43 个 / 20,180 单元**（未覆盖 17,587）。';
if (!s.includes(bulletOld)) { console.error('BULLET MISS'); process.exit(2); }
s = s.replace(bulletOld, bulletNew);

const rowOld = '| VK-B50 | src/lolwut9.c | 45 | 45 | 0 | 0 | 0 | 0 | 13.6% → 100.0% | 7.1% → 100.0% |';
const rowNew = rowOld + '\n| VK-B51 | src/modules/lua/list.c | 35 | 35 | 0 | 0 | 0 | 0 | 13.3% → 91.1% | 0.0% → 100.0% |';
if (!s.includes(rowOld)) { console.error('ROW MISS'); process.exit(2); }
s = s.replace(rowOld, rowNew);

const paraAnchor = '（首轮 2 行 W 为无锚点的单行注释，补反引号标识符后清零）。';
const paraNew = paraAnchor + '\n\n' +
  'B51：`src/modules/lua/list.c` 单文件单片完成，为 Lua 函数库加载期服务的单向链表，注释围绕所有权与遍历契约展开。其一，链表只拥有 `ListNode`、绝不释放 `val`：`val` 是 `server.register_function` 产出的编译函数指针，失败路径由调用方 `freeCompiledFunc`、成功路径移交函数库，`list_destroy` 若顺手释放 `val` 会造成成功路径二次释放。其二，节点用 `ValkeyModule_Calloc` 分配、必须用 `ValkeyModule_Free` 释放，不能与 `zfree` 混用；`list_destroy` 先把 `next` 存到局部再释放当前节点，否则读已释放内存。其三，`list_add` 尾插每次从 `head` 线性找尾，单次 O(n)，`length` 是独立计数器、在链接完成后才自增，保证任何时刻等于实际节点数；空表分支直接挂 `head`，跳过找尾。其四，迭代器在堆上单独分配并快照 `head`，迭代期间新追加的节点不会被本次遍历看到，删除当前节点则不影响遍历；`list_iter_next` 先取值再推进游标，节点与返回值解耦，但返回 NULL 同时表示「遍历结束」与「存了 NULL 值」，注释明确指出这个不可区分性。语句 13.3% → 91.1%、分支 0.0% → 100.0%，`added=35 / extra=0 / water=0 / weak=0 / filler=0 / deletedNonZero=0 / syntaxErr=0`（首轮 30 行后补 5 行结构体字段注释，1 行 W 补反引号标识符后清零）。';
if (!s.includes(paraAnchor)) { console.error('PARA MISS'); process.exit(2); }
s = s.replace(paraAnchor, paraNew);

const cumOld = 'B50 再增 47 行（45 行源码 + 2 行 README）至 154 文件 / 74,321 行，water 仍 369（0.50%）。';
const cumNew = 'B50 再增 47 行（45 行源码 + 2 行 README）至 154 文件 / 74,321 行；B51 再增 37 行（35 行源码 + 2 行 README）至 155 文件 / 74,358 行，water 仍 369（0.50%）。';
if (!s.includes(cumOld)) { console.error('CUM MISS'); process.exit(2); }
s = s.replace(cumOld, cumNew);

s = s.replace('A15–A34、B2–B50 新增行 W = 0', 'A15–A34、B2–B51 新增行 W = 0');

const start = s.indexOf('| 文件 | 单元 | 已做 | 剩余 | 语句 | 分支 |');
if (start < 0) { console.error('TABLE MISS'); process.exit(2); }
const endMark = s.indexOf('\n\n## 4.', start);
if (endMark < 0) { console.error('END MISS'); process.exit(2); }
s = s.slice(0, start) + tbl + s.slice(endMark);

fs.writeFileSync(RL, s);
console.log('readme updated for B51');
