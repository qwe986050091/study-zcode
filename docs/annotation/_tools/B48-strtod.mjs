import fs from 'node:fs';

const REL = 'src/valkey_strtod.c';
const SRC = `d:/code/opensource/valkey/${REL}`;
const DIR = 'd:/code/_annot_baseline/VK-B48';

const E = [
  [14, '/* 选项对象全仓共用一份 const：PRESET_GENERAL 接受 inf/nan，ALLOW_LEADING_PLUS 允许 " +1.5"。 */'],
  [15, '/* 显式允许前导 "+" 是 Valkey 既有行为；ffc 默认拒绝，靠这个 flag 补齐，不能省。 */'],
  [16, '/* 小数点固定为 "."：RESP 与配置里的浮点都不接受区域设置下的逗号小数点。 */'],
  [21, '/* 判定是否必须回退 libc：ffc 会拒绝的两类输入在这里返回 1，其余走快路径。 */'],
  [22, '/* 分支 1：首字符是空白（空格与 \\t\\n\\v\\f\\r）。9.0 的 strtod 跳过空白，ffc 直接判失败。 */'],
  [23, '/* 符号位只记下偏移，不在本函数里消费；它的作用仅是让下一行能越过 "+"/"-" 看 0x。 */'],
  [24, '/* 只跳过符号、不跳过空白：空白已在上一行返回，所以 i 只可能是 0 或 1。 */'],
  [25, '/* len-i >= 2 保证能安全读 s[i+1]；"0x" 后接空也算 hex 前缀，交给 libc 去报错。 */'],
  [28, '/* libc 回退实现：拷进栈缓冲再调 strtod，返回值与 endptr 语义必须与 ffc 路径对齐。 */'],
  [29, '/* 5KB 栈缓冲是本函数唯一的大对象，大小与 VALKEY_STRTOD_LIBC_BUFLEN 绑定，不按 len 变长。 */'],
  [30, '/* eptr 接收 strtod 的结束位置，随后要换算回调用方原串的偏移。 */'],
  [31, '/* val 先声明后赋值，让超长输入的提前返回与正常返回共用同一个出口变量。 */'],
  [33, '/* 超长输入不截断、不分块解析：直接 EINVAL，因为部分解析比明确拒绝更容易掩盖调用方错误。 */'],
  [34, '/* EINVAL 而非 ERANGE：长度超限属于接口约束，不是数值范围问题。 */'],
  [35, '/* endptr 原样指回 str：一个字符都没消费，调用方可据此与「解析到 0」区分。 */'],
  [36, '/* 返回 0.0 与真正的 "0" 无法区分，成败只能看 errno；这是两条路径共同的约定。 */'],
  [38, '/* 拷贝 len 字节且不含 NUL，长度由调用方保证；内嵌 NUL 会在这里被截断成前缀。 */'],
  [39, '/* 终止符写在 buf[len]：len 个字节全部属于输入，不能占用最后一格。 */'],
  [40, '/* 清零 errno：strtod 只在溢出/下溢时置 ERANGE，不清零会读到上一个调用的残留。 */'],
  [41, '/* 真正的解析在这里；hex-float、前导空白、inf/nan 全部按 libc 的 9.0 语义处理。 */'],
  [42, '/* (eptr - buf) 是 buf 内偏移，加回 str 得到调用方缓冲中的位置；两端必须同一基准。 */'],
  [43, '/* 返回 strtod 的结果；ERANGE 时是 ±HUGE_VAL 或 0，调用方仍须读 errno 才能判定。 */'],
  [51, '/* 便捷入口：要求 NUL 结尾，先 strlen 再转 _n 版本，本身不做任何额外校验。 */'],
  [52, '/* strlen 只到第一个内嵌 NUL：二进制安全的调用方必须自己走 valkey_strtod_n。 */'],
  [62, '/* 核心解析：两条路径的成败判据统一为 errno + endptr，返回值不参与判定。 */'],
  [63, '/* 先清零 errno：成功路径不写 errno，调用方靠 0 值区分「本次没出错」。 */'],
  [64, '/* temp 只接收 ffc 的输出；部分失败时它可能是半成品，不能当结果用。 */'],
  [65, '/* answer 同时带回 ptr（消费到哪）与 outcome（是否越界），是 ffc 的全部返回信息。 */'],
  [67, '/* hex-float 与前导空白走 libc；一旦命中就不再调 ffc，两套 errno 语义不能混用。 */'],
  [68, '/* 直接返回：libc 版本自己设 errno 与 endptr，这里不再覆写，否则会盖掉 ERANGE。 */'],
  [71, '/* 常规十进制交给 ffc：不分配、不加锁，解析区间由 str 与 str+len 给出。 */'],
  [72, '/* outcome 非 OK 即解析失败；ffc 用 OUT_OF_RANGE 单独区分溢出与下溢。 */'],
  [73, '/* 越界映射 ERANGE、其余语法错误映射 EINVAL，与 strtod 的 errno 约定保持一致。 */'],
  [75, '/* endptr 无论成败都回填：成功指向最后一个已解析字符之后，失败指向出错位置。 */'],
  [76, '/* answer.ptr 是输入区间内的指针，可直接转回调用方缓冲；失败时通常等于 str。 */'],
  [78, '/* 返回 ffc 写出的值；失败时内容不可依赖，只应看 errno 与 endptr 是否前进。 */'],
  [88, '/* sds 入口：长度由 sdslen 现取，串内允许内嵌 NUL，解析范围就是整个 sds。 */'],
  [89, '/* 这行清零是冗余的（_n 开头会再做），保留是为了单独看本函数也能读出错误语义。 */'],
  [90, '/* endptr 若被使用，指向 sds 缓冲区内部，调用方不得越过 sdslen 解读。 */'],
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
fs.writeFileSync(`${DIR}/out-valkey_strtod.json`, JSON.stringify(ops.map((o) => ({ line: o.line, c: o.lines })), null, 1));
console.log('ops', ops.length, 'lines', ops.reduce((s, o) => s + o.lines.length, 0));
