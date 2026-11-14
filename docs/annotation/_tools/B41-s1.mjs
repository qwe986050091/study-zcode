import { emit } from './b41-lib.mjs';

// s1: base 46-212 — 分配的编译期开关、线程计数格、默认 OOM、对齐标记helper
const E = [
  [68, '/* 不能换成 zfree：backtrace_symbols 的块由 libc malloc 分配，不带 zmalloc 前缀。 */'],

  [142, [
    '/* 普通 size_t 分支：读方不加原子指令，靠 aligned(CACHE_LINE_SIZE) 避免撕裂。 */',
    '/* 只覆盖 x86/ARM/PPC 等可证明对齐读一致的架构。 */',
  ]],
  [143, '/* value 独占一条 cache line；sizeof 断言（150 行）在编译期兜底。 */'],
  [146, '/* 其余架构退到 _Atomic：每次读写都有原子指令开销，换跨线程可见性。 */'],
  [147, '/* 原子成员仍按 CACHE_LINE_SIZE 对齐，否则原子写会弄脏相邻线程的行。 */'],

  [150, '/* 编译期断言结构体恰好一条 cache line；CACHE_LINE_SIZE 配错会直接编译失败。 */'],
  [151, '/* 每个领取过索引的线程占一格；数组静态分配，线程退出也不回收。 */'],
  [152, '/* 只增不减，zmalloc_used_memory 用它当求和上界，因此不会漏掉已退出线程。 */'],

  [161, '/* fetch_add 返回旧值作为本线程索引；relaxed 只保证唯一性，不建立 happens-before。 */'],

  [169, '/* 首次分配时 thread_index 还是 -1，必须先领索引，否则下面下标越界。 */'],
  [170, '/* 超出 MAX_THREADS_NUM 的线程退化为共享计数：牺牲精度换取不越界。 */'],
  [171, '/* 额外线程全加同一个原子变量，是全文件唯一的高竞争记账点。 */'],
  [173, '/* 正常路径只写本线程 cache line，无锁也无原子指令。 */'],

  [177, [
    '/* 释放侧镜像 update_zmalloc_stat_alloc：唯一区别是 -=，同样不做下溢检查。 */',
    '/* 传错 size（用请求大小代替 usable 大小）会永久污染该线程计数。 */',
    '/* 函数无返回值，配对失误只能靠 zmalloc_used_memory 的异常值暴露。 */',
  ]],
  [178, '/* 与 alloc 相同：释放可能先于分配发生，仍要先补领 thread_index。 */'],
  [179, '/* 额外线程走原子减；size_t 无符号，减多会回绕成接近 SIZE_MAX 的巨大值。 */'],
  [180, '/* fetch_sub 不报错，排查 used_memory 突增时先怀疑这里配对错误。 */'],
  [182, '/* 普通线程直接减自己那一行；跨线程释放会把减法记在释放者名下。 */'],

  [189, '/* 先打印请求字节数；%zu 与 size 同型，32 位上不会被截断。 */'],
  [190, '/* stderr 可能被重定向到大缓冲，不 fflush 就 abort 会丢掉最后一行证据。 */'],
  [191, '/* abort 保留 core 且不跑 atexit；自定义 handler 里不能再依赖堆分配。 */'],
  [194, '/* 默认指向 abort 版；只有 z* 族调用它，ztry* 族全路径不触碰。 */'],

  [197, '/* 只看前缀最高位：1 表示该块由 zmalloc_cache_aligned 分配。 */'],
  [198, '/* 与 ZMALLOC_CACHE_ALIGNED_FLAG 按位与，非 0 即对齐块。 */'],
  [201, '/* 抹掉最高位的对齐标记，剩下的才是数据区字节数。 */'],
  [202, '/* MASK 是 FLAG 的按位取反；结果不含 PREFIX_SIZE。 */'],

  [208, '/* HAVE_MALLOC_SIZE 下 jemalloc 的 usable 已含尾部，指针无需前移。 */'],
  [209, '/* size 只为保持统一签名；UNUSED 消掉 -Wunused-parameter。 */'],
  [210, '/* 原样返回 ptr；调用方不能假设返回值与入参不同。 */'],
];

emit('s1', 0, E);
