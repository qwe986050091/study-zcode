// B36 P1：valkey-benchmark.c 文件头宏、结构体字段、原型与小型工具函数。
// 只输出本片 ops；entries 追加到累积 out-valkey-benchmark.json。
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/valkey-benchmark.c';
const DIR = 'd:/code/_annot_baseline/VK-B36';

const E = [
  // ---- 文件头宏与枚举 ----
  [66, '#define UNUSED(V) ((void)V)', '/* UNUSED(V)：消掉 -Wunused-parameter；宏里必须用 (void) 包住实参，否则裸表达式会触发 -Wunused-value。 */'],
  [67, '#define RANDPTR_INITIAL_SIZE 8', '/* 8：随机 key 指针表的初始容量；小于单轮 pipeline 长度只会多一次 realloc，不影响正确性。 */'],
  [68, '#define DEFAULT_LATENCY_PRECISION 3', '/* 3：默认直方图有效位；-x 不传时用这个值初始化 hdr。 */'],
  [69, '#define MAX_LATENCY_PRECISION 4', '/* 4：hdr 精度上限；超过它 hdr_init 断言失败，所以 parseOptions 先拒掉非法 -x。 */'],
  [70, '#define MAX_THREADS 500', '/* 500：线程数硬上限；超过后 config.threads[MAX_THREADS] 越界写。 */'],
  [71, '#define CLUSTER_SLOTS 16384', '/* 16384：槽位总数，slots 数组与 crc16 取模都用它，改小会让 key 映射大面积碰撞。 */'],
  [72, '#define CONFIG_LATENCY_HISTOGRAM_MIN_VALUE 10L               /* >= 10 usecs */', '/* 10us：总直方图下界；更小的样本会被 hdr 钳进最低桶，读不出亚 10us 的差异。 */'],
  [73, '#define CONFIG_LATENCY_HISTOGRAM_MAX_VALUE 60000000L         /* <= 60 secs(us precision) */', '/* 60s：总直方图上界；超过的样本被 hdr 截断，report 里的 max 会失真。 */'],
  [74, '#define CONFIG_LATENCY_HISTOGRAM_INSTANT_MAX_VALUE 60000000L /* <= 60 secs(us precision) */', '/* 60s：每秒直方图上界；单独一份是因为它每秒清零，不能与总表共用。 */'],
  [75, '#define SHOW_THROUGHPUT_INTERVAL 250                         /* 250ms */', '/* 250ms：showThroughput 定时器周期；调大让 RPS 曲线变粗，调小增加定时器开销。 */'],
  [77, '#define CLIENT_GET_EVENTLOOP(c) (c->thread_id >= 0 ? config.threads[c->thread_id]->el : config.el)', '/* 线程内客户端取所属线程的 el；thread_id<0 的主线程回退 config.el，取错 loop 会跨线程注册 fd。 */'],
  [79, '#define PLACEHOLDER_COUNT 10', '/* 10：__rand_int__ 加 1st~9th 共 10 个；count[]/indices[] 与 PLACEHOLDERS 必须同长度。 */'],
  [80, 'static const size_t PLACEHOLDER_LEN = 12; // length of BENCHMARK_PLACEHOLDERS strings', '/* 12：占位符固定宽度；替换时按 12 位十进制右对齐写入，改小会截断 key。 */'],
  [83, '#define MAX_KEYSPACELEN 999999999999LL', '/* 999999999999：恰好 12 位全 9，等于 PLACEHOLDER_LEN 能表示的最大值；再大就会溢出槽宽。 */'],
  [84, 'static const char *PLACEHOLDERS[PLACEHOLDER_COUNT] = {', '/* 下标与 count[]/indices[] 一一对应；顺序改动会让已缓存的 indices 落到别的占位符。 */'],
  [88, 'struct benchmarkThread;', '/* 前置声明：client 与 benchmarkThread 相互引用指针，定义在文件下方。 */'],
  [89, 'struct clusterNode;', '/* clusterNode 前置声明：client->cluster_node 只需要不完全类型。 */'],
  [90, 'struct serverConfig;', '/* serverConfig 前置声明：clusterNode 持有指针，实际定义在 clusterNode 之后。 */'],
  [93, 'typedef enum readFromReplica {', '/* 副本读取策略；值 0 是默认，只有显式 --replica 才离开 FROM_PRIMARY_ONLY。 */'],
  [95, 'FROM_REPLICA_ONLY,', '/* FROM_REPLICA_ONLY：GET 只打副本，写命令仍走主库，否则副本回 READONLY。 */'],
  [96, 'FROM_ALL', '/* FROM_ALL：读按连接挑主或副本，用于观察主从混合负载。 */'],
  [100, '#define FUZZ_MODE_MALFORMED_COMMANDS (1 << 0)', '/* bit0：发送畸形 RESP，专门打服务端解析错误分支。 */'],
  [101, '#define FUZZ_MODE_CONFIG_COMMANDS (1 << 1)', '/* bit1：发送 CONFIG 类命令，覆盖管理命令路径。 */'],

  // ---- struct placeholders / dataset_seq_key ----
  [248, 'static struct placeholders {', '/* 缓存一条 RESP 命令里各占位符的位置；命令不变只初始化一次，避免每条请求重扫。 */'],
  [249, 'size_t cmd_len;                     /* length of the command */', '/* cmd_len 是整条命令字节数；替换后长度必须不变，变了说明槽宽算错。 */'],
  [250, 'size_t count[PLACEHOLDER_COUNT];    /* number of each placeholder in the command */', '/* 每种占位符出现次数；initPlaceholders 按它分配 indices[i]，漏算会越界写。 */'],
  [251, 'size_t *indices[PLACEHOLDER_COUNT]; /* pointer to indices for each placeholder */', '/* 每种占位符的偏移数组；指向 index_data 的切片，不能单独 free。 */'],
  [252, 'size_t *index_data;                 /* allocation holding all index data */', '/* 唯一的堆块，容纳全部偏移；释放时只 zfree 这一块。 */'],
  [256, 'static _Atomic uint64_t dataset_seq_key[PLACEHOLDER_COUNT] = {0};', '/* dataset 模式下每种占位符的全局序列键；atomic fetch_add 保证多线程拿到不同 key。 */'],

  // ---- struct _client ----
  [258, 'typedef struct _client {', '/* 单个压测客户端；obuf 存待发命令，written 记录已写字节，二者不等说明还有残留要续写。 */'],
  [259, 'valkeyContext *context;', '/* libvalkey 连接上下文；freeClient 负责 valkeyFree，置空或重复释放都会崩溃。 */'],
  [260, 'sds obuf;', '/* 待发命令缓冲；writeHandler 只从 written 处继续写，写完整块重置复用。 */'],
  [261, 'char **stagptr;     /* Pointers to slot hashtags (cluster mode only) */', '/* 集群模式下指向 obuf 里 {} 内片段的指针数组；单机模式为 NULL。 */'],
  [262, 'size_t staglen;     /* Number of pointers in client->stagptr */', '/* stagptr 中有效指针数；scanClusterTags 每次重建时更新。 */'],
  [263, 'size_t stagfree;    /* Number of unused pointers in client->stagptr */', '/* stagptr 剩余容量；降到 0 时按 RANDPTR_INITIAL_SIZE 扩容。 */'],
  [264, 'size_t written;     /* Bytes of \'obuf\' already written */', '/* obuf 已写出的字节数；小于 sdslen(obuf) 时 writeHandler 必须继续写，否则命令被截断。 */'],
  [265, 'long long start;    /* Start time of a request */', '/* 本轮请求开始时间（微秒）；latency = 收回复时的 ustime() - start，为负说明时钟被回拨。 */'],
  [266, 'long long latency;  /* Request latency */', '/* 本轮累计延迟（微秒）；showReport 累加进 config.totlatency，漏加会让均值偏低。 */'],
  [267, 'int seqlen;         /* Number of commands in the command sequence */', '/* 本轮要发的命令条数；writeHandler 用它判断序列是否发完，pipeline 下就是 1。 */'],
  [268, 'int pending;        /* Number of pending requests (replies to consume) */', '/* 还欠服务端多少个回复；减到 0 才能发下一轮，否则请求无限堆积。 */'],
  [269, 'int prefix_pending; /* If non-zero, number of pending prefix commands. Commands', '/* 前缀命令（AUTH/SELECT）待发条数；首轮发完清零，之后重发会被服务端当重复命令。 */'],
  [272, 'int prefixlen;      /* Size in bytes of the pending prefix commands */', '/* 前缀命令占用的字节数；统计本轮数据量时要减掉它，否则吞吐虚高。 */'],
  [273, 'int thread_id;', '/* 所属压测线程下标；-1 表示主线程，CLIENT_GET_EVENTLOOP 靠它选 el。 */'],
  [274, 'struct clusterNode *cluster_node;', '/* 集群模式下当前绑定的节点；NULL 表示单机，freeClient 据此决定是否回收槽位引用。 */'],
  [275, 'int slots_last_update;', '/* 本客户端见到的槽位版本；与全局版本不一致时触发重连换节点。 */'],
  [276, 'uint64_t paused : 1;', '/* 暂停标记；重复入 paused_clients 会让 awakenPausedClient 重复唤醒同一客户端。 */'],
  [277, 'uint64_t reuse : 1;', '/* 复用标记；freeClient 见到它就只重置不释放连接，避免压测中反复建连。 */'],
  [278, 'uint64_t request_started : 1; /* Request initialized, even if no bytes were written. */', '/* 即使一字未写也置位；writeHandler 靠它区分“还没开始”和“写了一半”。 */'],

  // ---- struct benchmarkThread ----
  [283, 'typedef struct benchmarkThread {', '/* 每个压测线程一套事件循环与直方图；线程间不共享直方图，避开 hdr_record 的原子改写争用。 */'],
  [284, 'int index;', '/* 线程下标；config.threads[index] 与 CLIENT_GET_EVENTLOOP 都用它定位。 */'],
  [285, 'pthread_t thread;', '/* pthread 句柄；main 在 aeMain 返回后必须 pthread_join，漏 join 会丢统计。 */'],
  [286, 'aeEventLoop *el;', '/* 本线程事件循环；线程内客户端只能注册到它，注册到别的 loop 会跨线程竞争。 */'],
  [287, 'list *paused_clients;', '/* 本线程暂停客户端链表；与全局 config.paused_clients 分开，避免跨线程加锁。 */'],
  [293, 'struct hdr_histogram *latency_histogram;', '/* 本线程总延迟直方图；写入不加锁，线程 join 后再合并到全局。 */'],
  [294, 'struct hdr_histogram *current_sec_latency_histogram;', '/* 本线程当前秒直方图；showThroughput 每秒清零一次，用于算瞬时延迟。 */'],

  // ---- struct clusterNode ----
  [298, 'typedef struct clusterNode {', '/* CLUSTER SLOTS 解析出的节点；slots/updated_slots 是同一节点的两代槽位视图。 */'],
  [299, 'char *ip;', '/* 节点 IP；来自 CLUSTER SLOTS 字符串复制，释放路径必须与分配方式匹配。 */'],
  [300, 'int port;', '/* 节点端口；与 ip 一起决定 connect 目标。 */'],
  [301, 'sds name;', '/* 节点 ID；CLUSTER SLOTS 的第三段，用于同一节点去重。 */'],
  [302, 'int flags;', '/* 节点角色位；判断主从用于 read_from_replica 选路。 */'],
  [303, 'sds replicate; /* Primary ID if node is a replica */', '/* 副本记录的主节点 ID；主节点为 NULL，反向查找主库时用。 */'],
  [304, 'int *slots;', '/* 本节点负责的槽位列表；建连后按它分流 key。 */'],
  [305, 'int slots_count;', '/* slots 长度；遍历时用错会让 slots[i] 越界读到脏值。 */'],
  [306, 'int *updated_slots;      /* Used by updateClusterSlotsConfiguration */', '/* 新拓扑的临时槽位数组；全部节点就绪后才替换 slots，替换前读不到半成品。 */'],
  [307, 'int updated_slots_count; /* Used by updateClusterSlotsConfiguration */', '/* updated_slots 长度；必须与 updated_slots 成对更新。 */'],
  [308, 'int replicas_count;', '/* 副本数；副本读取时用于在多个副本间轮询。 */'],
  [309, 'struct serverConfig *server_config;', '/* 节点级 CONFIG GET 缓存；恢复配置时按节点回写。 */'],

  // ---- struct serverConfig ----
  [312, 'typedef struct serverConfig {', '/* 需要跨重连保留的服务端配置；只存压测期间会被改动的两项。 */'],
  [313, 'sds save;', '/* CONFIG GET save 的原值；结束时原样回写，置空会让服务端恢复默认保存策略。 */'],
  [314, 'sds appendonly;', '/* CONFIG GET appendonly 的原值；回写错误会永久改变服务端持久化模式。 */'],

  // ---- createFileEvent ----
  [323, 'static inline void createFileEvent(aeEventLoop *eventLoop, int fd, int mask, aeFileProc *proc, void *clientData) {', '/* 注册 fd 事件；RDMA 下 AE_WRITABLE 不像 TCP 由 poll 驱动，必须手动踢一次回调。 */'],
  [325, 'if (config.ct == VALKEY_CONN_RDMA && (mask & AE_WRITABLE)) {', '/* 仅 RDMA 且关心可写时手动触发 proc；否则回调可能永远等不到，连接卡在建立阶段。 */'],

  // ---- 原型 ----
  [331, 'static void writeHandler(aeEventLoop *el, int fd, void *privdata, int mask);', '/* 写回调：从 written 处继续刷 obuf，未写完就重注册 AE_WRITABLE。 */'],
  [332, 'static void createMissingClients(client c);', '/* 按 config.numclients 补齐客户端；客户端退出后靠它补位，否则连接数单调下降。 */'],
  [333, 'static benchmarkThread *createBenchmarkThread(int index);', '/* 建第 index 个压测线程；直方图随线程创建，避免多线程共享。 */'],
  [334, 'static void freeBenchmarkThread(benchmarkThread *thread);', '/* 释放单线程资源；必须在 pthread_join 之后调用。 */'],
  [335, 'static void freeBenchmarkThreads(void);', '/* 释放全部线程数组；main 结束路径调用。 */'],
  [336, 'static void *execBenchmarkThread(void *ptr);', '/* 线程入口；绑定 loop 后跑 aeMain，直到 isBenchmarkFinished 返回真。 */'],
  [337, 'static clusterNode *createClusterNode(char *ip, int port);', '/* 分配并初始化一个 clusterNode；ip 内存所有权随节点转移。 */'],
  [338, 'static serverConfig *getServerConfig(enum valkeyConnectionType ct, const char *ip_or_path, int port);', '/* 读取节点的 CONFIG GET save/appendonly，失败按场景 exit 或降级。 */'],
  [339, 'static valkeyContext *getValkeyContext(enum valkeyConnectionType ct, const char *ip_or_path, int port);', '/* 建立控制面连接；返回非 NULL 时 ctx 归调用方所有。 */'],
  [340, 'static void freeServerConfig(serverConfig *cfg);', '/* 释放 serverConfig 的两个 sds；重复释放会双重 free。 */'],
  [341, 'static int fetchClusterSlotsConfiguration(client c);', '/* 拉取 CLUSTER SLOTS 并重建 cluster_nodes。 */'],
  [342, 'static void updateClusterSlotsConfiguration(void);', '/* 周期性刷新槽位；用 is_updating_slots 保证同一时刻只有一个线程改表。 */'],
  [343, 'static long long showThroughput(struct aeEventLoop *eventLoop, long long id, void *clientData);', '/* 250ms 定时器：打印吞吐并滚动每秒直方图。 */'],
  [344, 'int runFuzzerClients(const char *host, int port, int max_commands, int parallel_clients, int cluster_mode, long long num_keys, cliSSLconfig *ssl_config, const char *log_level, int fuzz_flags);', '/* fuzz 模式入口；非 static，供 valkey-cli 复用。 */'],
  [345, 'static int parseCommandTemplate(int argc, char **argv);', '/* 解析 dataset 模板命令；把 argv 复制成 template_argv。 */'],

  // ---- 时钟与 dict 回调 ----
  [352, 'static long long ustime(void) {', '/* 微秒级墙钟；gettimeofday 受系统时间调整影响，只用于 latency 展示，不用于 RPS 限速。 */'],
  [356, 'gettimeofday(&tv, NULL);', '/* 时区参数传 NULL：只取 UTC 秒与微秒，时区字段在这里用不到。 */'],
  [362, 'static long long mstime(void) {', '/* 毫秒 = ustime()/1000；duration 判定用它，精度足够且不受纳秒计数器溢出影响。 */'],
  [366, 'static long long nstime(void) {', '/* 单调纳秒时钟；RPS 令牌桶用它，系统时间跳变不会让等待时间为负。 */'],
  [368, 'clock_gettime(CLOCK_MONOTONIC, &ts);', '/* 必须用 CLOCK_MONOTONIC；换成 CLOCK_REALTIME 后 NTP 回拨会让令牌桶停摆。 */'],
  [401, 'static uint64_t dictSdsHash(const void *key) {', '/* dict 哈希回调；对 sds 内容做 dictGenHashFunction，长度取自 sds 头而非 strlen。 */'],
  [405, 'static int dictSdsKeyCompare(const void *key1, const void *key2) {', '/* key 比较回调；先比 sdslen 再 memcmp，长度不等直接返回 0 以避免读越界。 */'],
  [409, 'if (l1 != l2) return 0;', '/* 长度不等立即判不相等；少了这步 memcmp 会按较长者长度读到短串之外。 */'],
  [413, 'static dictType dtype = {', '/* 槽位映射使用的 dictType；key 是 sds，销毁回调直接用 zfree。 */'],
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
fs.writeFileSync(`${DIR}/ins-p1.json`, JSON.stringify([{ file: 'src/valkey-benchmark.c', ops }], null, 1));

const OUT = `${DIR}/out-valkey-benchmark.json`;
const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
fs.writeFileSync(OUT, JSON.stringify(prev.concat(added), null, 1));
console.log(`P1 entries=${added.length} cumulative=${prev.length + added.length}`);
