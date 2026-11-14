import fs from 'node:fs';

const REL = 'src/modules/hellodict.c';
const SRC = `d:/code/opensource/valkey/${REL}`;
const DIR = 'd:/code/_annot_baseline/VK-B49';

const E = [
  [42, '/* 全模块唯一的键空间：进程级全局，客户端之间共享，没有过期、淘汰与持久化。 */'],
  [47, '/* SET 命令：参数校验 → 写字典 → 保留值引用三步；失败路径只有 arity 一种，其余静默。 */'],
  [48, '/* 参数不是恰好两个就回 arity 错误并返回，后面不再触碰 Keyspace。 */'],
  [49, '/* 底层是 raxTryInsert：键已存在时返回 ERR 且不覆盖旧值；这里忽略返回值，所以重复 SET 静默无效。 */'],
  [52, '/* 引用计数加一让值活过回调：rax 只存指针不复制，不 retain 会留下悬垂指针。 */'],
  [53, '/* 回 +OK；上面写入即使因键已存在而失败，客户端仍会看到 OK。 */'],
  [60, '/* GET 只读字典、不做拷贝：返回的就是 SET 时 retain 住的同一个对象。 */'],
  [61, '/* 只接受 <key> 两个参数；多一个或少一个都按协议错误处理。 */'],
  [62, '/* nokey 传 NULL：本模块只需区分「有没有值」，不区分「键不存在」与「存了 NULL」。 */'],
  [63, '/* 两种 NULL 在这一支合流：键不存在，或值本来就是 NULL 指针。 */'],
  [64, '/* 回 RESP null，客户端看到 (nil) 而不是错误。 */'],
  [66, '/* 直接把字典对象写进回复，编码与长度由 ReplyWithString 自己处理。 */'],
  [74, '/* KEYRANGE 用字典迭代器做字典序区间扫描，输出条数由 count 封顶。 */'],
  [75, '/* 需要 startkey、endkey、count 三个参数，缺一个就回 arity 错误。 */'],
  [78, '/* count 用有符号 64 位：负数在这里合法，但下面会被当作「一条都不要」。 */'],
  [79, '/* 解析失败（非数字或溢出）回 ERR invalid count，不进入迭代。 */'],
  [80, '/* 错误前缀 "ERR " 必须模块自己写全，服务器不会代补。 */'],
  [84, '/* ">=" 把迭代器定位到首个不小于 startkey 的键；rax 天然按字典序排列。 */'],
  [87, '/* key 指向 rax 节点内部，只在下一次 DictNextC 之前有效，不能缓存到循环外。 */'],
  [88, '/* 键允许含二进制 0，长度必须靠 keylen 而不是 strlen 界定。 */'],
  [89, '/* 先累计条数后统一回填：POSTPONED_LEN 模式下数组头要等循环结束才写。 */'],
  [90, '/* 推迟数组长度：此时还不知道要发几个元素。 */'],
  [91, '/* 每轮先步进再判界，break 时迭代器已越过最后一个已输出的键。 */'],
  [92, '/* count 封顶在发元素之前判：count <= 0 时数组为空，也不会多读一个键。 */'],
  [93, '/* 当前键超过 endkey 就停；返回 ERR 表示比较不成立，与迭代结束是两种终止。 */'],
  [94, '/* 立即把键字节拷进回复缓冲，规避下一次步进造成的指针失效。 */'],
  [97, '/* 补写数组头，必须与 POSTPONED_LEN 成对；漏写会让客户端一直等后续元素。 */'],
  [100, '/* 必须停：迭代器持有 rax 遍历状态，不释放就是每次调用一条泄漏。 */'],
  [101, '/* 命令回调的返回值不参与协议，回复已经在上面写完。 */'],
  [106, '/* 模块入口：先注册命令再建字典；任一步 ERR 都返回 ERR 让服务器整体回滚。 */'],
  [107, '/* 宏展开为 (void)argv，声明入口参数不用，消掉 -Wunused-parameter。 */'],
  [110, '/* 必须是第一个 API 调用：失败说明重复加载或 API 版本不兼容，直接放弃加载。 */'],
  [112, '/* "write deny-oom" 表示写命令且内存不足时拒绝执行；键位置 1、步长 1。 */'],
  [113, '/* 注册失败立即返回 ERR；服务器会连同先前注册的命令一起卸载，不留半加载状态。 */'],
  [115, '/* readonly 允许在只读副本上执行；同样声明第 1 个参数是键。 */'],
  [118, '/* 只声明 argv[1] 为键：集群模式按 startkey 路由，endkey 不参与槽位计算。 */'],
  [122, '/* ctx 传 NULL：字典不挂模块自动内存管理，卸载时不会自动回收（示例模块不处理卸载）。 */'],
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
fs.writeFileSync(`${DIR}/out-hellodict.json`, JSON.stringify(ops.map((o) => ({ line: o.line, c: o.lines })), null, 1));
console.log('ops', ops.length, 'lines', ops.reduce((s, o) => s + o.lines.length, 0));
