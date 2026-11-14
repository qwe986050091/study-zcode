// B36 P0：valkey-benchmark.c 的 struct config 字段（只写“改错会怎样”）。
// 用法：node B36-p0.mjs  → VK-B36/ins-p0.json + out-valkey-benchmark.json
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/valkey-benchmark.c';
const DIR = 'd:/code/_annot_baseline/VK-B36';

const E = [
  [104, 'aeEventLoop *el;', '/* 置空或指向错误 loop：CLIENT_GET_EVENTLOOP 单线程分支解引用 NULL，直接崩溃。 */'],
  [105, 'enum valkeyConnectionType ct;', '/* 传错连接类型：建连走错协议分支，rdma/tls 客户端连不上或读写错位。 */'],
  [106, 'cliConnInfo conn_info;', '/* 认证字段填错：AUTH 用错用户名或密码，客户端全部报 NOAUTH 并退出。 */'],
  [107, 'int tls;', '/* 误置 1 而没配证书：cliSecureConnection 失败，所有客户端建连即退出。 */'],
  [108, 'int mptcp;', '/* 对端未开 MPTCP 而误置 1：建连回退失败，benchmark 起不来。 */'],
  [109, 'struct cliSSLconfig sslconfig;', '/* 证书或 SNI 配错：握手失败，报错指向 TLS 而不是业务命令。 */'],
  [110, 'int numclients;', '/* 调小或置 0：createMissingClients 不再补客户端，吞吐恒为 0。 */'],
  [111, '_Atomic int liveclients;', '/* 计数与实际客户端数不一致：结束条件永不满足，benchmark 挂住不返回。 */'],
  [112, 'int requests;', '/* 请求数改小：先于 duration 触发结束，压测时长不足。 */'],
  [113, 'int duration;', '/* 置 0：退化为按请求数结束；与 requests 同时为 0 会立刻结束。 */'],
  [114, 'int warmup_duration;', '/* 大于 duration：正式统计窗口为负，吞吐与延迟样本为空。 */'],
  [115, '_Atomic int current_warmup_duration;', '/* 未同步成 warmup_duration：各线程预热判断不一致，部分请求被误计。 */'],
  [116, '_Atomic int requests_issued;', '/* 递增遗漏：限流分支认为没有在途请求，RPS 模式会超发。 */'],
  [117, '_Atomic int requests_finished;', '/* 递增遗漏：结束条件永假，main 一直停在 aeMain 不退出。 */'],
  [118, '_Atomic int previous_requests_finished;', '/* 不按秒刷新：showThroughput 的每秒差值失真，RPS 曲线漂移。 */'],
  [119, 'int last_printed_bytes;', '/* 不更新：进度行清空宽度错误，终端残留上一次的长行。 */'],
  [120, 'long long previous_tick;', '/* 不更新：instantaneous_dt 越算越大，瞬时 RPS 单调衰减到 0。 */'],
  [121, 'int keysize;', '/* 与实际 key 长度不符：SET/GET 生成越界或截断，服务端报协议错。 */'],
  [122, 'int datasize;', '/* 与 value 实际长度不符：写入长度错位，后续命令解析全部错乱。 */'],
  [123, 'int replace_placeholders;', '/* 该开未开：key 里保留 __rand_int__ 字面量，所有请求打到同一个 key。 */'],
  [124, 'long long keyspacelen;', '/* 置 0 却启用随机 key：取模分支被跳过，随机性失效。 */'],
  [125, 'int sequential_replacement;', '/* 该开未开：随机替换退化为顺序写，缓存命中率与真实负载不符。 */'],
  [126, 'int keepalive;', '/* 关闭后长连接被中间设备回收，压测中途出现大量重连。 */'],
  [127, 'int pipeline;', '/* 大于服务端承受能力：客户端写缓冲膨胀，最终 OOM 或超时。 */'],
  [128, 'long long start;', '/* 未在 aeMain 前赋值：duration 判定用旧时间，可能立刻结束或永不结束。 */'],
  [129, 'long long totlatency;', '/* 累加错误：showReport 的 reqpersec 分母错误，吞吐报告整体偏移。 */'],
  [130, 'const char *title;', '/* 指向栈上临时串：showReport 时已失效，打印出乱码。 */'],
  [131, 'list *clients;', '/* 与实际链表不一致：freeClient 找不到节点，客户端泄漏。 */'],
  [132, 'list *paused_clients;', '/* 与暂停链不一致：awakenPausedClient 唤醒错对象或漏唤醒，benchmark 卡住。 */'],
  [133, 'int quiet;', '/* 该静默未静默：进度行污染 CSV 输出。 */'],
  [134, 'int csv;', '/* 与 quiet 组合错误：表头与数据行列数不一致，解析失败。 */'],
  [135, 'int loop;', '/* 置 1 却未重置计数：同一进程内重复跑测试时请求数立即达标。 */'],
  [136, 'int idlemode;', '/* 置 1 但没暂停客户端：客户端空转，CPU 打满而请求数为 0。 */'],
  [137, 'sds input_dbnumstr;', '/* 未释放或重复赋值：SELECT 拼接用到已释放 sds，命令里出现脏字节。 */'],
  [138, 'char *tests;', '/* 逗号分隔解析错：test_is_selected 漏选测试，报告缺项。 */'],
  [139, 'int stdinarg; /* get last arg from stdin. (-x option) */', '/* 置 1 但 stdin 无数据：读阻塞，benchmark 启动即挂起。 */'],
  [140, 'int precision;', '/* 超过 MAX_LATENCY_PRECISION：hdr 直方图精度非法，初始化断言失败。 */'],
  [141, 'int num_threads;', '/* 超过 MAX_THREADS：threads 数组越界，写坏相邻全局。 */'],
  [142, 'struct benchmarkThread **threads;', '/* 分配长度与 num_threads 不一致：启动线程时越界读指针。 */'],
  [143, 'int cluster_mode;', '/* 误置 1 而目标是单机：先走 CLUSTER SLOTS，连接被拒后退出。 */'],
  [144, 'int fuzz_mode; /* Boolean flag to enable fuzzing */', '/* 误置 1：进入 fuzz 路径，正常压测参数被当成畸形命令输入。 */'],
  [145, 'const char *fuzz_log_level;', '/* 指向无效字符串：日志级别解析失败，fuzz 过程无输出。 */'],
  [146, 'int fuzz_flags; /* Bit flags for fuzzing modes */', '/* 位组合错误：只发合法命令或只发配置命令，覆盖不到目标分支。 */'],
  [147, 'readFromReplica read_from_replica;', '/* 配成 FROM_REPLICA_ONLY 而拓扑无副本：GET 全部报错。 */'],
  [148, 'int cluster_node_count;', '/* 与实际节点数不符：遍历 cluster_nodes 越界或漏节点。 */'],
  [149, 'struct clusterNode **cluster_nodes;', '/* 未按 count 分配：createClusterNode 写入越界，堆损坏。 */'],
  [150, 'struct serverConfig *server_config;', '/* 复用未初始化结构：CONFIG 命令基于脏值，改错服务端配置。 */'],
  [151, 'struct hdr_histogram *latency_histogram;', '/* 未初始化就 hdr_record：空指针解引用或统计溢出。 */'],
  [152, 'struct hdr_histogram *current_sec_latency_histogram;', '/* 与 latency_histogram 混用：每秒样本写进总表，报告翻倍。 */'],
  [153, 'struct hdr_histogram *rps_histogram;', '/* 未按秒重置：RPS 均值被历史秒摊薄，目标速率判断失真。 */'],
  [154, '_Atomic int is_fetching_slots;', '/* 未置位就并发拉取：多个线程同时改 slots，重复连接与泄漏。 */'],
  [155, '_Atomic int is_updating_slots;', '/* 锁外更新：slots 表在读写之间被替换，客户端拿到悬空指针。 */'],
  [156, '_Atomic int slots_last_update;', '/* 不刷新时间戳：定期刷新判断永真，持续重建连接拖慢压测。 */'],
  [157, 'int enable_tracking;', '/* 该开未开：CLIENT TRACKING 不下发，缓存失效路径未被压到。 */'],
  [158, 'int num_functions;', '/* 与实际注册数不符：FCALL 指向不存在的函数，全部报错。 */'],
  [159, 'int num_keys_in_fcall;', '/* 大于实际 key 数：FCALL 参数个数错位，服务端解析失败。 */'],
  [160, 'pthread_mutex_t liveclients_mutex;', '/* 未初始化就加锁：未定义行为，多线程下随机崩溃。 */'],
  [161, 'pthread_mutex_t is_updating_slots_mutex;', '/* 与 liveclients_mutex 混用：两把锁保护同一状态，仍会竞争。 */'],
  [162, 'int resp3; /* use RESP3 */', '/* 误置 1 而服务端不支持：HELLO 3 失败，后续命令全部协议错。 */'],
  [163, 'int rps;', '/* 置 0：acquireTokenOrWait 不限速，RPS 模式退化成全速压测。 */'],
  [164, 'atomic_uint_fast64_t last_time_ns;', '/* 未按线程初始化：令牌桶起点错误，首秒突发或长期等待。 */'],
  [165, 'uint64_t time_per_token;', '/* 算错（非 1e9/rps）：实际速率与目标 RPS 偏离。 */'],
  [166, 'uint64_t time_per_burst;', '/* 小于 time_per_token：桶容量不足 1 个令牌，客户端永久等待。 */'],
  [168, 'sds dataset_file;', '/* 路径错：dataset 加载失败，模板命令无数据可发。 */'],
  [169, 'int max_documents;        /* Maximum documents to load from dataset */', '/* 大于文件记录数：加载循环越界或空转，启动变慢。 */'],
  [170, 'dataset *current_dataset; /* Current loaded dataset */', '/* 释放后未置空：下一次测试复用悬空指针，堆损坏。 */'],
  [172, 'int template_argc;', '/* 与实际 argv 数不符：遍历越界，命令行出现随机参数。 */'],
  [173, 'sds *template_argv;', '/* 未按 argc 分配：解析模板时越界读。 */'],
  [174, 'int has_field_placeholders;', '/* 该开未开：dataset 字段占位符原样发出，服务端收到字面量。 */'],
];

const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
const ops = [];
const entries = [];
for (const [ln, expect, c] of E) {
  const cur = lines[ln - 1];
  if (cur === undefined || cur.trim() !== expect) {
    console.error(`MISMATCH ${ln}\n expect: ${expect}\n actual: ${cur}`);
    process.exit(2);
  }
  ops.push({ line: ln, expect, lines: [c] });
  entries.push({ line: ln, c: [c] });
}
ops.sort((a, b) => b.line - a.line);
fs.writeFileSync(`${DIR}/ins-p0.json`, JSON.stringify([{ file: 'src/valkey-benchmark.c', ops }], null, 1));
fs.writeFileSync(`${DIR}/out-valkey-benchmark.json`, JSON.stringify(entries, null, 1));
console.log(`P0 fields=${ops.length} lines=${entries.length}`);
