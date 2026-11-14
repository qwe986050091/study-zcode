// B36 P9：createBenchmarkThread / freeBenchmarkThread / freeBenchmarkThreads /
// execBenchmarkThread / createClusterNode / freeClusterNode / freeClusterNodes / addClusterNode。
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/valkey-benchmark.c';
const DIR = 'd:/code/_annot_baseline/VK-B36';

const E = [
  // ---- createBenchmarkThread ----
  [2461, 'static benchmarkThread *createBenchmarkThread(int index) {', '/* 建第 index 个压测线程的 loop、暂停链表与两份直方图；zmalloc 失败即 abort。 */'],
  [2462, 'benchmarkThread *thread = zmalloc(sizeof(*thread));', '/* zmalloc 在 OOM 时直接 abort，不会把 NULL 交回调用方。 */'],
  [2463, 'if (thread == NULL) return NULL;', '/* 防御性判断：zmalloc 已保证非 NULL，正常路径不会走到这里。 */'],
  [2464, 'thread->index = index;', '/* index 存进结构，CLIENT_GET_EVENTLOOP 靠它回查 config.threads。 */'],
  [2465, 'thread->el = aeCreateEventLoop(1024 * 10);', '/* 每线程独立 aeEventLoop 10K 槽；返回 NULL 时后续 aeMain 会崩。 */'],
  [2466, 'thread->paused_clients = listCreate();', '/* paused_clients 只在本线程 loop 内使用，不跨线程共享。 */'],
  [2467, 'hdr_init(CONFIG_LATENCY_HISTOGRAM_MIN_VALUE,         // Minimum value', '/* 本线程总延迟直方图，上界 60s，精度取 config.precision。 */'],
  [2471, 'hdr_init(CONFIG_LATENCY_HISTOGRAM_MIN_VALUE,         // Minimum value', '/* 每秒直方图独立实例；showThroughput 读完即 reset，不能与总表共用。 */'],
  [2475, 'aeCreateTimeEvent(thread->el, 1, showThroughput, (void *)thread, NULL);', '/* 1ms 后触发 showThroughput，实参 thread；回调返回 AE_NOMORE 时自动删除定时器。 */'],
  [2476, 'return thread;', '/* 返回已初始化对象；initBenchmarkThreads 负责存入 config.threads。 */'],

  // ---- freeBenchmarkThread ----
  [2479, 'static void freeBenchmarkThread(benchmarkThread *thread) {', '/* 释放线程的 loop、两份直方图、暂停链表与自身，每项都先判 NULL。 */'],
  [2480, 'if (thread->el) aeDeleteEventLoop(thread->el);', '/* el 可能为 NULL（aeCreateEventLoop 失败），aeDeleteEventLoop 前先判。 */'],
  [2481, 'if (thread->latency_histogram) hdr_close(thread->latency_histogram);', '/* hdr_close 释放本线程总延迟直方图。 */'],
  [2482, 'if (thread->current_sec_latency_histogram) hdr_close(thread->current_sec_latency_histogram);', '/* hdr_close 释放每秒直方图。 */'],
  [2483, 'listRelease(thread->paused_clients);', '/* listRelease 释放暂停客户端链表的节点。 */'],
  [2484, 'zfree(thread);', '/* 最后释放 benchmarkThread 结构。 */'],

  // ---- freeBenchmarkThreads ----
  [2487, 'static void freeBenchmarkThreads(void) {', '/* 遍历 config.threads 逐个释放，再把数组本身置 NULL。 */'],
  [2488, 'int i = 0;', '/* i 从 0 起，num_threads 是本轮已创建的线程数。 */'],
  [2489, 'for (; i < config.num_threads; i++) {', '/* 只释放已创建的 num_threads 个槽。 */'],
  [2490, 'benchmarkThread *thread = config.threads[i];', '/* 取第 i 个 benchmarkThread 指针。 */'],
  [2491, 'if (thread) freeBenchmarkThread(thread);', '/* 跳过 NULL，initBenchmarkThreads 中途失败时避免二次释放。 */'],
  [2493, 'zfree(config.threads);', '/* zfree 释放线程指针数组本身。 */'],
  [2494, 'config.threads = NULL;', '/* 置 NULL，防止重复调用 freeBenchmarkThreads 时二次释放。 */'],

  // ---- execBenchmarkThread ----
  [2502, 'benchmarkThread *thread = (benchmarkThread *)ptr;', '/* 强转回 benchmarkThread 指针，startBenchmarkThreads 传的就是它。 */'],
  [2503, 'aeMain(thread->el);', '/* aeMain 阻塞到本线程所有客户端结束或 aeStop 被调用。 */'],
  [2506, 'flushRequestsFinished();', '/* 把 _Thread_local 里未提交的完成计数刷进 config.requests_finished，否则报告少算。 */'],
  [2507, 'return NULL;', '/* 返回值未被 pthread_join 接收，固定 NULL。 */'],

  // ---- createClusterNode ----
  [2512, 'static clusterNode *createClusterNode(char *ip, int port) {', '/* 建 clusterNode，slots 按 CLUSTER_SLOTS 预分配；zmalloc 失败即 abort。 */'],
  [2513, 'clusterNode *node = zmalloc(sizeof(*node));', '/* zmalloc 不返回 NULL，OOM 时已 abort。 */'],
  [2514, 'if (!node) return NULL;', '/* 防御性判断，正常路径不可达。 */'],
  [2515, 'node->ip = ip;', '/* ip 由调用方 sdsnew 后移交所有权，这里只存指针。 */'],
  [2516, 'node->port = port;', '/* port 来自 CLUSTER SLOTS 的第二个元素。 */'],
  [2517, 'node->name = NULL;', '/* name 是 40 字节 node id，去重后由 fetchClusterConfiguration 赋值。 */'],
  [2518, 'node->flags = 0;', '/* flags 本工具未使用，置 0。 */'],
  [2519, 'node->replicate = NULL;', '/* replicate 指向主节点 name，只有副本节点才赋值。 */'],
  [2520, 'node->replicas_count = 0;', '/* replicas_count 未维护，保持 0。 */'],
  [2521, 'node->slots = zmalloc(CLUSTER_SLOTS * sizeof(int));', '/* 固定 CLUSTER_SLOTS 个 int 槽位，避免迁移时再扩容。 */'],
  [2522, 'node->slots_count = 0;', '/* slots_count 是已写入槽数，setClusterKeyHashTag 取模依赖它非零。 */'],
  [2523, 'node->updated_slots = NULL;', '/* updated_slots 只在刷新拓扑时使用，初始为 NULL。 */'],
  [2524, 'node->updated_slots_count = 0;', '/* updated_slots_count 与 updated_slots 配对。 */'],
  [2525, 'node->server_config = NULL;', '/* serverConfig 缓存留到 getServerConfig 填。 */'],
  [2526, 'return node;', '/* 返回全部字段已初始化的 clusterNode。 */'],

  // ---- freeClusterNode ----
  [2529, 'static void freeClusterNode(clusterNode *node) {', '/* 释放节点的 sds、配置缓存与 slots 数组，每项都先判 NULL。 */'],
  [2530, 'if (node->name) sdsfree(node->name);', '/* name 可能为 NULL（未去重赋值），sdsfree 前先判。 */'],
  [2531, 'if (node->replicate) sdsfree(node->replicate);', '/* replicate 只有副本节点有，判空后释放。 */'],
  [2532, 'if (node->ip) sdsfree(node->ip);', '/* ip 由 createClusterNode 接管，这里负责释放。 */'],
  [2533, 'if (node->server_config != NULL) freeServerConfig(node->server_config);', '/* server_config 是 getServerConfig 的结果，必须走 freeServerConfig。 */'],
  [2534, 'zfree(node->slots);', '/* slots 是 zmalloc 的裸 int 数组，用 zfree 释放。 */'],
  [2535, 'zfree(node);', '/* 最后释放 clusterNode 结构本身。 */'],

  // ---- freeClusterNodes ----
  [2538, 'static void freeClusterNodes(void) {', '/* 遍历 config.cluster_nodes 逐个释放，再把数组置 NULL。 */'],
  [2539, 'int i = 0;', '/* i 从 0 起，cluster_node_count 是已入表的节点数。 */'],
  [2540, 'for (; i < config.cluster_node_count; i++) {', '/* 只释放已入表的 cluster_node_count 个槽。 */'],
  [2541, 'clusterNode *n = config.cluster_nodes[i];', '/* 取第 i 个 clusterNode 指针。 */'],
  [2542, 'if (n) freeClusterNode(n);', '/* 跳过 NULL，失败清理时不二次释放。 */'],
  [2544, 'zfree(config.cluster_nodes);', '/* zfree 释放节点指针数组。 */'],
  [2545, 'config.cluster_nodes = NULL;', '/* 置 NULL，fetchClusterConfiguration 失败后重复调用也安全。 */'],

  // ---- addClusterNode ----
  [2548, 'static clusterNode **addClusterNode(clusterNode *node) {', '/* 追加节点到 config.cluster_nodes；返回新数组指针。 */'],
  [2549, 'int count = config.cluster_node_count + 1;', '/* 新容量是现有节点数加 1。 */'],
  [2550, 'config.cluster_nodes = zrealloc(config.cluster_nodes, count * sizeof(*node));', '/* zrealloc 在 OOM 时 abort，不会返回 NULL。 */'],
  [2551, 'if (!config.cluster_nodes) return NULL;', '/* 防御性判断，正常路径不可达。 */'],
  [2552, 'config.cluster_nodes[config.cluster_node_count++] = node;', '/* 先按下标写入再自增 cluster_node_count，下标用旧值。 */'],
  [2553, 'return config.cluster_nodes;', '/* 返回 realloc 后的数组，调用方通常忽略。 */'],
];

const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
const ops = [];
const added = [];
for (const [ln, expect, c] of E) {
  const cur = lines[ln - 1];
  if (cur === undefined || cur.trim() !== expect) {
    console.error(`MISMATCH ${ln}\n expect: ${expect}\n actual: ${cur}`);
    process.exit(2);
  }
  ops.push({ line: ln, expect, lines: [c] });
  added.push({ line: ln, c: [c] });
}
ops.sort((a, b) => b.line - a.line);
fs.writeFileSync(`${DIR}/ins-p9.json`, JSON.stringify([{ file: 'src/valkey-benchmark.c', ops }], null, 1));

const OUT = `${DIR}/out-valkey-benchmark.json`;
const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
fs.writeFileSync(OUT, JSON.stringify(prev.concat(added), null, 1));
console.log(`P9 entries=${added.length} cumulative=${prev.length + added.length}`);
