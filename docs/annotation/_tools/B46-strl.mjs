import fs from 'node:fs';

const REL = 'src/strl.c';
const SRC = `d:/code/opensource/valkey/${REL}`;
const DIR = 'd:/code/_annot_baseline/VK-B46';

const E = [
  [26, '/* 保存源串起点，返回长度时用 src-osrc-1 还原已扫过的字节数（末尾多走了 NUL）。 */'],
  [27, '/* nleft 以 dsize 为初值，递减到 0 前始终保持「还能写 nleft 个字节」；预留 1 个位置给 NUL。 */'],
  [30, '/* dsize==0 时 nleft 仍为 0，整段拷贝跳过，只做长度统计并返回 strlen(src)。 */'],
  [31, '/* 先自减再判零：把最后一个可写槽留给 NUL，避免 dst 满时越界写终止符。 */'],
  [32, '/* 拷贝一个字节后判断是否为 NUL：命中即源串结束，跳出循环，nleft 停在剩余空间上。 */'],
  [33, '/* break 走的是「源串已拷完」，与把 dst 写满被 --nleft 打断是两条不同出口。 */'],
  [38, '/* nleft==0 表示要么 dsize 为 0，要么 dst 已被填满：此时源串尚未遇到 NUL，仍需量出完整长度。 */'],
  [39, '/* dsize!=0 才写终止符；dsize==0 时 dst 不可解引用，这一层判断防的是空缓冲区。 */'],
  [40, '/* 只补一个 NUL，不再拷贝内容——截断发生在这里，返回值会大于等于 dsize 提示调用方。 */'],
  [41, '/* 继续沿 src 走到 NUL，仅为算出完整 strlen(src)；这段不计入 dst 的可写空间。 */'],
  [42, '/* 空循环体：src 自增到 NUL 为止，循环结束后 src 指向终止符之后一个字节。 */'],
  [45, '/* src 已越过 NUL 一格，故减 1 得实际源串长度；返回值可能 ≥ dsize，调用方据此判断截断。 */'],
  [58, '/* 记下 dst 起点：返回值的 dst 部分按 odst 偏移计算，而非从当前位置重数。 */'],
  [59, '/* 记下 src 起点：返回值中源串长度部分等于 src-osrc，包含被截断未拷完的字节。 */'],
  [60, '/* n 先当 dsize 用，扫 dst 时递减，用于保证扫描不越过缓冲区末尾。 */'],
  [64, '/* 最多走 dsize 步找 dst 的 NUL：缓冲区未终止时停在末尾，避免越界读。 */'],
  [66, '/* dlen 是 dst 现有长度；若 dst 未终止则 dlen==dsize，下面 n 会算成 0。 */'],
  [67, '/* n 是含终止符在内的剩余可写空间 = dsize-dlen；dlen>=dsize 时为 0。 */'],
  [69, '/* 后置自减判 n 是否为 0：空间耗尽直接返回 dlen+strlen(src)，不写终止符也不拷内容。 */'],
  [70, '/* 此路径 dst 原本就写满了：返回长度已 ≥dsize，调用方据此认定截断。 */'],
  [71, '/* 逐字节追加 src，直到源串 NUL；循环内按 n 是否有余量决定是否真正落盘。 */'],
  [72, '/* n!=0 才写：空间用尽后仍要继续走 src，只为把 strlen(src) 数完。 */'],
  [73, '/* 先写 dst 再自增指针，写入的是当前 n 覆盖的最后一个可写位置。 */'],
  [74, '/* 每写一字节 n 减一；n 归零后只读 src 不再写，保证不越界。 */'],
  [76, '/* src 无条件前进；即使本字节因空间不足未拷贝，也要计入返回长度。 */'],
  [78, '/* 循环退出时补终止符；只有在 n 非零进入循环、源串非空时才走到这里，位置必然可写。 */'],
  [80, '/* 返回 dst 原长度 + 源串完整长度；若 ≥dsize 说明发生了截断。 */'],
];

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const ops = [];
for (const [ln, c] of E) {
  const t = lines[ln - 1].trim();
  if (!t) { console.error('MISSING', ln); process.exit(2); }
  if (t.startsWith('/*') || t.startsWith('* ') || t === '*' || t.startsWith('//') || t.startsWith('#')) { console.error('BADANCHOR', ln, t); process.exit(2); }
  ops.push({ line: ln, expect: t, lines: Array.isArray(c) ? c : [c] });
}
ops.sort((a, b) => b.line - a.line);
fs.writeFileSync(`${DIR}/ins-v1.json`, JSON.stringify([{ file: REL, ops }], null, 1));
fs.writeFileSync(`${DIR}/out-strl.json`, JSON.stringify(ops.map((o) => ({ line: o.line, c: o.lines })), null, 1));
console.log('ops', ops.length, 'lines', ops.reduce((s, o) => s + o.lines.length, 0));
