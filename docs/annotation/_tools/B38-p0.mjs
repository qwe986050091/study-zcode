// B38 P0：allocator_defrag.c 全文件（宏 / 结构体字段 / jemalloc 查询 / defrag 决策 / 三个编译分支）。
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/allocator_defrag.c';
const DIR = 'd:/code/_annot_baseline/VK-B38';
const PX = 'p0';

const E = [
  [50, '/* 只有「支持 defrag + 用 jemalloc」才编真实现，其余走下面两个桩。 */'],
  [52, '/* STRINGIFY_ 把宏参数原样转字符串，供拼 mallctl 名。 */'],
  [53, '/* STRINGIFY 多一层展开，否则 ARENA_TO_QUERY 会拼成字面量名。 */'],
  [55, '/* 3：utilization.batch_query 每个 slab 返回 [nfree,nregs,len] 三个 size_t。 */'],
  [56, '/* SLAB_NFREE 取第 i 个 slab 的空闲 region 数。 */'],
  [57, '/* SLAB_LEN 取第 i 个 slab 的字节长度，除以 nregs 得 region_size。 */'],
  [58, '/* SLAB_NUM_REGS 取第 i 个 slab 的 region 总数。 */'],
  [77, '/* key[6] 是 jemalloc MIB 的最大深度，实际 keylen 由 mallctl 回填。 */'],
  [87, '/* curr_slabs 的 MIB，查询 bin 当前 slab 数。 */'],
  [99, '/* reg_size 是 bin 的 region 字节数，和 region_size 对比定位 bin。 */'],
  [110, '/* nbins 来自 arenas.nbins，决定 bin_info/je_usage_info 数组长度。 */'],
  [122, '/* curr_slabs 是本轮统计的 slab 数，makeDefragDecision 用它算满 slab。 */'],
  [128, '/* 1 表示 jemalloc 查询可用；桩实现下恒 0，未初始化调用会被断言拦住。 */'],
  [146, '/* MALLOCX_TCACHE_NONE 绕过 tcache：tcache 里的块不能被 jemalloc 移动。 */'],
  [147, '/* 返回 je_mallocx 的结果，失败返回 NULL 由调用方处理。 */'],
  [149, '/* 与 allocatorDefragAlloc 配对，size 必须与分配时一致。 */'],
  [150, '/* NULL 直接返回，sdallocx 对 NULL 未定义。 */'],
  [151, '/* sdallocx 带 size 才能定位 bin，省一次指针查表。 */'],
  [186, '/* 组内偏移：((1<<exp) - sz) 右移得到该尺寸在组内的序号。 */'],
  [198, '/* epoch 的 key 在 allocatorDefragInit 里预计算，这里只做触发。 */'],
  [200, '/* sz 必须等于 uint64_t 大小，传错会让 mallctl 返回 EINVAL。 */'],
  [207, '/* key 数组上限 6，先写满长度再让 mallctlnametomib 回填实际值。 */'],
  [208, '/* 名称转 MIB，失败时 res 非 0 且 keylen 不可用。 */'],
  [211, '/* 返回 res：0 表示该统计项存在。 */'],
  [217, '/* 单 size_t 出参，所有计数类查询都用这个长度。 */'],
  [218, '/* je_mallctlbymib 走预计算 key，比 mallctl 少一次字符串查找。 */'],
  [221, '/* 初始化单个 bin 的三个 MIB key，任一失败即返回 -1。 */'],
  [222, '/* 128 字节足够容纳 stats.arenas.4095.bins.<n>.nonfull_slabs。 */'],
  [226, '/* curregs 查不到说明 jemalloc 版本不支持该统计项。 */'],
  [229, '/* curslabs 缺了就算不出碎片总量。 */'],
  [232, '/* nonfull_slabs 缺了 makeDefragDecision 无法判断搬移目标。 */'],
  [234, '/* 三个 key 全部就绪。 */'],
  [256, '/* 100 字节够拼 arenas.bin.<n>.size，n 最多 4 位。 */'],
  [257, '/* bin_info 指向当前 bin 的元数据。 */'],
  [258, '/* sz 是 mallctl 的出入参长度，每次查询前要重设。 */'],
  [259, '/* je_res 承接 mallctl 返回值。 */'],
  [267, '/* epoch 的 MIB 用于跨线程同步统计。 */'],
  [268, '/* 取不到 epoch 说明 jemalloc 版本过旧，初始化不可继续。 */'],
  [269, '/* 立即刷新一次，保证随后读到的 nbins 与统计一致。 */'],
  [273, '/* sz 必须与 jemalloc_quantum 的实际宽度一致。 */'],
  [274, '/* 读 quantum 只用于下面的断言校验。 */'],
  [278, '/* sz 改成 nbins 的宽度，mallctl 按它校验出参大小。 */'],
  [279, '/* arenas.nbins 决定后续数组长度。 */'],
  [280, '/* nbins 为 0 说明 jemalloc 未就绪。 */'],
  [282, '/* 每个 bin 一份元数据，zcalloc_num 失败会 abort。 */'],
  [283, '/* 防御性断言，zcalloc_num 语义下不可达。 */'],
  [284, '/* 用量数组与 bin_info 同长度。 */'],
  [285, '/* 同上，失败即 abort。 */'],
  [287, '/* 逐个 bin 填 reg_size/nregs 与三个 query key。 */'],
  [288, '/* bin_info 指向第 j 个 bin。 */'],
  [291, '/* sz 改成 reg_size 的宽度。 */'],
  [292, '/* 读 region 大小，这是 size→bin 反查的基准。 */'],
  [293, '/* 读失败说明 bin 编号越界。 */'],
  [296, '/* sz 改成 nregs 的宽度。 */'],
  [297, '/* 每 slab 的 region 数，算碎片与满 slab 都要用。 */'],
  [298, '/* nregs 为 0 会让后续除法出错。 */'],
  [302, '/* 三个 MIB key 初始化失败则整个 defrag 不可用。 */'],
  [310, '/* 初始化完成。 */'],
  [319, '/* 未初始化就调用会读空指针，断言先拦住。 */'],
  [320, '/* frag 累加所有 small bin 的空闲字节。 */'],
  [321, '/* 先刷 epoch，否则读到的是各线程缓存里的旧值。 */'],
  [322, '/* 逐个 small bin 累计外部碎片。 */'],
  [323, '/* 第 j 个 bin 的元数据。 */'],
  [324, '/* 第 j 个 bin 的最新用量。 */'],
  [336, '/* 返回累加的空闲 region 字节数。 */'],
  [359, '/* 满 slab 数 = 总 slab - 非满 slab。 */'],
  [360, '/* 非满 slab 里已分配的 region 数。 */'],
  [383, '/* 未初始化时 bin_info 为空，断言拦住。 */'],
  [384, '/* out 固定 3 项，与 BATCH_QUERY_ARGS_OUT 对应。 */'],
  [385, '/* out_sz 由 mallctl 回填实际写入长度。 */'],
  [386, '/* in_sz 是入参 ptr 的字节数。 */'],
  [387, '/* 先把 out 填成 -1，便于下面断言发现「没写」。 */'],
  [388, '/* -1 是哨兵值，成功查询会被真实计数覆盖。 */'],
  [390, '/* 批量查询一次拿到 nfree/nregs/len，避免三次往返。 */'],
  [396, '/* len 为 0 说明查询失败或 slab 不存在。 */'],
  [397, '/* nfree 仍是 -1 说明该指针不属于任何 small bin。 */'],
  [398, '/* region_size = slab 字节数 / region 数，用于反查 bin。 */'],
  [401, '/* 超过最大 small bin 说明是大块分配，不参与 defrag。 */'],
  [408, '/* nalloced = 总 region - 空闲 region。 */'],
  [420, '/* 四个量分别来自 allocator info 与 small bin 碎片统计。 */'],
  [421, '/* 只取 allocated/active/resident，其余两个不需要。 */'],
  [422, '/* 复用 allocatorDefragGetFragSmallbins，内部会刷 epoch。 */'],
  [428, '/* rss_pct 是常驻高出已分配的百分比。 */'],
  [429, '/* rss_bytes 用于日志里给出绝对值。 */'],
  [430, '/* 调用方可传 NULL，只关心返回值。 */'],
  [431, '/* 一次打印 allocated/active/resident 与两种碎片率。 */'],
  [433, '/* 返回 small bin 碎片百分比，调用方据此决定是否启动 defrag。 */'],
  [436, '/* 无 jemalloc 但强制 defrag 的调试分支，全部退化为直接分配。 */'],
  [437, '/* 桩：初始化成功。 */'],
  [438, '/* 返回 0 让上层认为 defrag 可用。 */'],
  [440, '/* 桩：直接 zfree，size 未用。 */'],
  [441, '/* size 形参未用。 */'],
  [442, '/* 走 zmalloc 体系释放。 */'],
  [444, '/* 桩：直接 zmalloc。 */'],
  [445, '/* 恒返回非 NULL，失败会 abort。 */'],
  [446, '/* 不可达，仅为消除「缺 return」告警。 */'],
  [448, '/* 桩：碎片统计恒 0。 */'],
  [449, '/* 0 表示没有可回收碎片。 */'],
  [452, '/* 桩：所有指针都判为值得 defrag。 */'],
  [453, '/* ptr 形参未用。 */'],
  [454, '/* 恒 1，让测试覆盖搬移路径。 */'],
  [457, '/* 桩：返回阈值本身，触发上层逻辑。 */'],
  [458, '/* 把忽略字节数 +1，保证超过 ignore 阈值。 */'],
  [459, '/* 返回上限阈值，让分配器判定为高碎片。 */'],
  [462, '/* 既不支持 jemalloc 也没开强制 defrag 的默认分支。 */'],
  [463, '/* 返回 -1 表示不支持，defrag 不会启动。 */'],
  [464, '/* 返回 -1 让调用方关闭 active defrag。 */'],
  [466, '/* 默认桩：释放为空操作。 */'],
  [467, '/* ptr 形参未用。 */'],
  [468, '/* size 形参未用。 */'],
  [470, '/* 默认桩：分配直接返回 NULL。 */'],
  [471, '/* size 形参未用。 */'],
  [472, '/* 返回 NULL 表示本次分配失败。 */'],
  [474, '/* 默认桩：碎片统计恒 0。 */'],
  [475, '/* 0 让上层认为无需 defrag。 */'],
  [478, '/* 默认桩：永不 defrag。 */'],
  [479, '/* ptr 形参未用。 */'],
  [480, '/* 恒 0，active defrag 不可用。 */'],
  [483, '/* 默认桩：碎片率恒 0。 */'],
  [484, '/* out_frag_bytes 形参未用。 */'],
  [485, '/* 0 表示没有碎片。 */'],
  [487, '/* 三个编译分支在此收口。 */'],
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
fs.writeFileSync(`${DIR}/ins-${PX}.json`, JSON.stringify([{ file: 'src/allocator_defrag.c', ops }], null, 1));

const out = `${DIR}/out-allocator.json`;
const prev = JSON.parse(fs.readFileSync(out, 'utf8'));
const entries = ops.map((o) => ({ line: o.line, c: o.lines }));
fs.writeFileSync(out, JSON.stringify([...prev, ...entries], null, 1));
console.log(`${PX} ops=${ops.length} entries=${prev.length + entries.length}`);
