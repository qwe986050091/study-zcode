import fs from 'node:fs';

const REL = 'src/vector.c';
const SRC = `d:/code/opensource/valkey/${REL}`;
const DIR = 'd:/code/_annot_baseline/VK-B45';

const E = [
  [20, '/* 初始化：alloc==0 是合法的空向量，data 置 NULL，等 vectorPush 首次按 8 个扩容。 */'],
  [21, '/* item_size 为 0 直接 assert 失败：后面所有指针运算都乘它，为 0 会让所有元素重叠在同一地址。 */'],
  [22, '/* 只有 alloc 非 0 才真正分配；容量为 0 时不调用 zmalloc。 */'],
  [23, '/* zmalloc 失败走 zmalloc_oom_handler 直接 abort，不返回 NULL，因此这里无需判空。 */'],
  [24, '/* alloc==0 分支：不分配，data=NULL，容量记账仍按调用方给的 0。 */'],
  [27, '/* a->alloc 记录容量、a->len 从 0 开始，二者后续只在 vectorPush 里同步增长。 */'],
  [28, '/* item_size 必须与分配时一致；改掉它会让 vectorGet/vectorPush 的字节偏移全部错位。 */'],
  [33, '/* 返回已用长度 len 而不是容量 alloc：调用方只关心当前元素数。 */'],
  [39, '/* idx>=len 直接 assert 失败：vectorGet 不做边界裁剪，越界读由 assert 拦住。 */'],
  [40, '/* 先转 uint8_t* 再做 idx*item_size 字节偏移，避免 void* 上非法指针算术与类型相关的缩放。 */'],
  [45, '/* 满（len==alloc）才扩容；否则下一次写入正好落在未分配区域。 */'],
  [46, '/* 空向量首次给 8，非空翻倍：翻倍策略保证 n 次 push 的均摊代价为 O(1)。 */'],
  [47, '/* zrealloc 失败直接 abort（不是返回 NULL）；成功时旧元素的指针会失效，外部缓存的元素地址必须重新取。 */'],
  [48, '/* zrealloc 返回后才更新 alloc：中途 abort 时 alloc 仍是旧值，不会出现容量与实际分配不符。 */'],
  [51, '/* 新元素地址 = data + len*item_size；此刻 len 还是旧长度，即第一个未占用槽。 */'],
  [52, '/* len++ 之后该槽才计入长度；返回的指针在下一次 vectorPush 触发扩容前有效。 */'],
  [61, '/* 只释放 data；vector 结构体本身可能位于栈上，不由本函数释放。 */'],
  [62, '/* 仅 data 非 NULL 才 zfree；alloc==0 初始化的向量 data 为 NULL，跳过。 */'],
];

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const ops = [];
for (const [ln, c] of E) {
  const t = lines[ln - 1].trim();
  if (!t) { console.error('MISSING', ln); process.exit(2); }
  if (t.startsWith('/*') || t.startsWith('*') || t.startsWith('#')) { console.error('BADANCHOR', ln, t); process.exit(2); }
  ops.push({ line: ln, expect: t, lines: Array.isArray(c) ? c : [c] });
}
ops.sort((a, b) => b.line - a.line);
fs.writeFileSync(`${DIR}/ins-v1.json`, JSON.stringify([{ file: REL, ops }], null, 1));
fs.writeFileSync(`${DIR}/out-vector.json`, JSON.stringify(ops.map((o) => ({ line: o.line, c: o.lines })), null, 1));
console.log('ops', ops.length, 'lines', ops.reduce((s, o) => s + o.lines.length, 0));
