// B39：fifo.c 单文件单片（结构体字段 / create / push / peek / pop / release / join / popAll）。
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const REPO = 'd:/code/opensource/valkey';
const REL = 'src/fifo.c';
const SRC = `${REPO}/${REL}`;
const DIR = 'd:/code/_annot_baseline/VK-B39';
const PX = 'p0';

fs.mkdirSync(`${DIR}/orig/src`, { recursive: true });
fs.writeFileSync(`${DIR}/orig/${REL}`, execSync(`git show HEAD:${REL}`, { cwd: REPO, encoding: 'buffer' }));
fs.writeFileSync(`${DIR}/_files.txt`, `${REL}\n`);
if (!fs.existsSync(`${DIR}/annot-shim.h`)) fs.copyFileSync('d:/code/_annot_baseline/VK-B38/annot-shim.h', `${DIR}/annot-shim.h`);
if (!fs.existsSync(`${DIR}/out-fifo.json`)) fs.writeFileSync(`${DIR}/out-fifo.json`, '[]');

const E = [
  [35, '/* IDX_MASK 0x0007 只取低 3 位下标，与 ITEMS_PER_BLOCK=7 配套。 */'],
  [87, '/* items[7] 存元素指针；多块时中间块的有效槽由 firstIdx 起算。 */'],
  [88, '/* union 让 next 指针与 3 位下标共用同一 8 字节，省一个字段。 */'],
  [130, '/* u.next 只在非尾块有效，解引用前必须先清低 3 位。 */'],
  [134, '/* fifo 句柄只有三个字段，length 是判断空/满的唯一真相。 */'],
  [135, '/* length 为 0 时 first/last 必为 NULL，两者不能各自维护。 */'],
  [137, '/* last 指向尾块，push 从它的 lastIdx 续写。 */'],
  [144, '/* zmalloc 失败直接 abort，故下面无需判空。 */'],
  [145, '/* 初始 length=0，第一次 push 才决定是否建块。 */'],
  [146, '/* 空队列用 first==last==NULL 表示，不预分配块。 */'],
  [147, '/* 返回堆上的句柄，调用方负责 fifoRelease。 */'],
  [156, '/* first==NULL 即空队列，此时 last 与 length 也必须为 0。 */'],
  [159, '/* 首块同时挂到 first 和 last，进入单块形态。 */'],
  [160, '/* lastIdx=0：槽 0 即当前最后一项，后续从槽 1 追加。 */'],
  [163, '/* 尾块只存 lastIdx，指针部分为 0，可直接当整数读。 */'],
  [166, '/* lastIdx<6 说明尾块还有空槽，原地追加不新建块。 */'],
  [169, '/* 自增 lastIdx，把新元素纳入已用槽范围。 */'],
  [173, '/* 新块 lastIdx=0，表示仅槽 0 有效。 */'],
  [174, '/* ptr 放入新块的槽 0。 */'],
  [175, '/* 覆写旧 lastIdx：新块地址低 3 位为 0，等价于清位。 */'],
  [180, '/* 只有成功入队才自增 length，异常路径已提前返回。 */'],
  [188, '/* 空队列返回 false，不碰 first，避免读 NULL。 */'],
  [189, '/* 单块恒 firstIdx=0；多块才从首块低 3 位取 firstIdx。 */'],
  [190, '/* 取首块 firstIdx 槽的元素，peek 不改变队列内容。 */'],
  [191, '/* 返回 true 表示 item 已写入出参。 */'],
  [202, '/* 空队列 pop 返回 false，length 是唯一判据。 */'],
  [204, '/* 单块与多块是两套出队逻辑，这里按 first==last 分叉。 */'],
  [228, '/* 单块只存 lastIdx，指针位为 0。 */'],
  [231, '/* lastIdx>0 说明还有元素，需左移保持左对齐。 */'],
  [235, '/* 左移后 lastIdx 减一，空出的尾槽下次 push 复用。 */'],
  [239, '/* 最后一项出队：释放块并把 first/last 归 NULL。 */'],
  [244, '/* 多块从 firstIdx 取元素，join 后 firstIdx 可能非 0。 */'],
  [246, '/* 未到槽 6 只需自增 firstIdx，本块继续复用。 */'],
  [253, '/* 本块耗尽，先取 next 再释放，避免 use-after-free。 */'],
  [254, '/* first 前移到下一块，其低位语义由新块自身决定。 */'],
  [258, '/* 所有成功路径末尾统一扣减 length。 */'],
  [259, '/* 返回 true 表示 item 已写入出参。 */'],
  [263, '/* fifoLength 是 O(1)，直接读缓存值。 */'],
  [264, '/* 与 push/pop 维护的 length 同源，不重数链上元素。 */'],
  [273, '/* length==0 时跳过整条链，first 此时可能为 NULL。 */'],
  [274, '/* 从首块开始逐个释放。 */'],
  [275, '/* 遍历到 NULL 为止，尾块 next 恒 NULL。 */'],
  [276, '/* 先清低 3 位还原真实 next 指针，再解引用。 */'],
  [278, '/* 释放当前块，块内元素归调用方所有。 */'],
  [279, '/* cur 前移，避免读已释放内存。 */'],
  [282, '/* 最后释放队列句柄本身。 */'],
  [291, '/* target 的 length 被 source 的值覆盖。 */'],
  [292, '/* first 直接接管，不做块复制。 */'],
  [293, '/* last 一并接管，尾块 lastIdx 语义保持不变。 */'],
  [294, '/* source 清空 length，防止二次释放。 */'],
  [295, '/* source 的 first/last 归 NULL，句柄仍可复用。 */'],
  [362, '/* q 为空时直接接管整条链，O(1)。 */'],
  [365, '/* 提前 return，下面的右对齐逻辑不执行。 */'],
  [368, '/* other 少于 7 项时逐项搬运，避免产生半空中间块。 */'],
  [372, '/* fifoPop 取空 other 再 fifoPush，最多循环 6 次。 */'],
  [373, '/* 搬完即返回，q 的尾块保持左对齐。 */'],
  [376, '/* 记录 q 的尾块，join 后它变成中间块。 */'],
  [377, '/* 取尾块 lastIdx，决定右移量。 */'],
  [380, '/* shift>0 说明尾块未满，需右对齐腾出接续位置。 */'],
  [381, '/* memmove 右移：源与目标重叠，不能用 memcpy。 */'],
  [386, '/* 加上 shift 后 lastIdx 恰变成中间块的 firstIdx。 */'],
  [390, '/* q 的尾块换成 other 的尾块，lastIdx 语义保留。 */'],
  [391, '/* other 清空 length，所有权已转移给 q。 */'],
  [392, '/* other 的 first/last 归 NULL，防止悬空引用。 */'],
  [400, '/* 新建空壳承接内容，zmalloc 失败会 abort。 */'],
  [401, '/* 复用 overwrite，q 随即变空。 */'],
  [402, '/* 返回新队列，调用方负责 fifoRelease。 */'],
];

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const ops = [];
for (const [ln, c] of E) {
  const cur = lines[ln - 1];
  if (cur === undefined) {
    console.error(`MISSING ${ln}`);
    process.exit(2);
  }
  const t = cur.trim();
  if (!t || t.startsWith('/*') || t.startsWith('//') || /^\*\s/.test(t)) {
    console.error(`BADANCHOR ${ln} ${t}`);
    process.exit(2);
  }
  ops.push({ line: ln, expect: t, lines: [c] });
}
ops.sort((a, b) => b.line - a.line);
fs.writeFileSync(`${DIR}/ins-${PX}.json`, JSON.stringify([{ file: REL, ops }], null, 1));

const out = `${DIR}/out-fifo.json`;
const prev = JSON.parse(fs.readFileSync(out, 'utf8'));
const entries = ops.map((o) => ({ line: o.line, c: o.lines }));
fs.writeFileSync(out, JSON.stringify([...prev, ...entries], null, 1));
console.log(`${PX} ops=${ops.length} entries=${prev.length + entries.length}`);
