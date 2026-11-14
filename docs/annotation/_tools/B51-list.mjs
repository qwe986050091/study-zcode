import fs from 'node:fs';

const REL = 'src/modules/lua/list.c';
const SRC = `d:/code/opensource/valkey/${REL}`;
const DIR = 'd:/code/_annot_baseline/VK-B51';

const E = [
  [29, '/* 只分配 `List` 表头，节点由 `list_add` 单独申请：表头与节点分属两次分配，销毁时也要分别释放。 */'],
  [30, '/* `head` 与 `length` 必须同时初始化：只写一个会让「计数」与「实际节点数」在第一次遍历时对不上。 */'],
  [31, '/* 长度从 0 起算，之后每次插入成功才 +1，中间不出现临时值。 */'],
  [32, '/* 返回的表头归调用方所有，生命周期到 `list_destroy` 为止。 */'],

  [38, '/* 从 `head` 开始，局部变量负责游走；`list` 本身在循环期间保持有效，最后才释放。 */'],
  [39, '/* 终止条件是指针为 NULL，而不是读 `length`：即使计数写错，遍历也不会越过链尾。 */'],
  [40, '/* 先存下 `next` 再释放当前节点；释放后还去读 `current->next` 就是 use-after-free。 */'],
  [41, '/* 节点由 `ValkeyModule_Calloc`/`Alloc` 分配，必须用模块分配器释放，不能交给 `zfree`。 */'],
  [42, '/* 沿保存的 `next` 前进，循环处理到链尾为止。 */'],
  [44, '/* 节点清空后才释放表头；此时 `head` 已指向已释放内存，但表头本身不再被读取。 */'],

  [48, '/* 直接读计数器，O(1)；它不重新数节点，正确性完全依赖插入/销毁两条路径同步维护 `length`。 */'],

  [54, '/* `Calloc` 保证 `next` 初值为 NULL，末尾的显式置空是冗余但明确的写法；失败时模块分配器直接终止，无返回值可查。 */'],
  [55, '/* 只存调用方给的指针，不复制、不加引用：`val` 的存活期由调用方保证。 */'],
  [56, '/* 新节点是链尾，`next` 必须为 NULL，否则下面的找尾循环会越界。 */'],
  [57, '/* 空表分支：新节点直接成为 `head`，省掉一次找尾。 */'],
  [58, '/* 先挂 `head` 再统一 `length++`，两条分支都不会出现「计数已增但节点没挂上」的中间态。 */'],
  [60, '/* 非空表从 `head` 出发找尾；`current` 最终停在最后一个节点（它的 `next` 为 NULL）。 */'],
  [61, '/* 以 `next` 非空为前进条件，因此循环结束时 `current` 不是 NULL，可安全解引用。 */'],
  [62, '/* 逐节点推进，单次插入最坏走完整个链表，O(n)。 */'],
  [64, '/* 把新节点接到旧尾之后；`new_node->next` 已在上面置空，链尾性质得以保持。 */'],
  [66, '/* 链接完成后再自增，保证 `length` 永远等于实际节点数。 */'],

  [72, '/* 迭代器单独分配，`Calloc` 让未显式赋值的字段为 0；迭代状态不放进 `List`，多条遍历互不干扰。 */'],
  [73, '/* 快照当前 `head`：迭代开始后新追加的节点不会被本次遍历看到。 */'],
  [74, '/* 返回的迭代器独立于链表存活，必须由调用方 `list_release_iter` 释放。 */'],

  [78, '/* 已到链尾（或空表首次调用）时返回 NULL，这是唯一的结束信号。 */'],
  [79, '/* 返回 NULL 无法区分「遍历结束」与「存了一个 NULL 值」，调用方需自行避免存 NULL。 */'],
  [81, '/* 先取出 `val` 再移动游标：节点本身不被触碰，调用方拿到值后可自行释放该节点。 */'],
  [82, '/* 游标推进到下一个节点，下一次调用从头继续；本次返回值已与节点解耦。 */'],
  [83, '/* 返回的是存入时的原指针，不是副本，类型由调用方按 `void *` 自行还原。 */'],

  [88, '/* 只释放迭代器自身，不触碰链表与节点：迭代器从不拥有 `val`。 */'],
];

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const ops = [];
for (const [ln, c] of E) {
  const t = lines[ln - 1].trim();
  if (!t) { console.error('MISSING', ln); process.exit(2); }
  if (t.startsWith('/*') || t.startsWith('* ') || t === '*' || t.startsWith('//') || t.startsWith('#')) { console.error('BADANCHOR', ln, t); process.exit(2); }
  ops.push({ line: ln, expect: t, lines: [c] });
}
ops.sort((a, b) => b.line - a.line);
fs.writeFileSync(`${DIR}/ins-v1.json`, JSON.stringify([{ file: REL, ops }], null, 1));
fs.writeFileSync(`${DIR}/out-list.json`, JSON.stringify(ops.map((o) => ({ line: o.line, c: o.lines })), null, 1));
console.log('ops', ops.length, 'lines', ops.reduce((s, o) => s + o.lines.length, 0));
