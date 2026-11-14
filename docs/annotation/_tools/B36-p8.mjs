// B36 P8：showRPSReport / showReport / 线程启动 / benchmarkSequence / benchmark。
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/valkey-benchmark.c';
const DIR = 'd:/code/_annot_baseline/VK-B36';

const E = [
  // ---- showRPSReport ----
  [2085, 'static void showRPSReport(void) {', '/* 打印 RPS 分布；只有 -R 模式且已有样本时才输出。 */'],
  [2086, 'if (config.rps_histogram && config.rps_histogram->total_count > 0) {', '/* 没有 rps 样本就不打印，避免未开 -R 时输出空表。 */'],
  [2087, 'const float target_rps = (float)config.rps;', '/* 目标值转 float，方便与均值直接比较。 */'],
  [2089, 'const float avg_rps = hdr_mean(config.rps_histogram);', '/* 均值；分母是样本数，不是时间窗口。 */'],
  [2090, 'const float p0 = (float)hdr_min(config.rps_histogram);', '/* 最小值用 hdr_min；没有样本时它会返回 0。 */'],
  [2091, 'const float p50 = (float)hdr_value_at_percentile(config.rps_histogram, 50.0);', '/* p50：一半采样秒低于它。 */'],
  [2092, 'const float p95 = (float)hdr_value_at_percentile(config.rps_histogram, 95.0);', '/* p95：尾部抖动看这一列。 */'],
  [2093, 'const float p99 = (float)hdr_value_at_percentile(config.rps_histogram, 99.0);', '/* p99 对噪声最敏感，样本少时波动大。 */'],
  [2094, 'const float p100 = (float)hdr_max(config.rps_histogram);', '/* 最大值用 hdr_max。 */'],
  [2096, 'printf("\\n");', '/* 空行与延迟表隔开。 */'],
  [2097, 'printf("RPS Summary:\\n");', '/* 标题。 */'],
  [2098, 'printf("  target RPS: %.2f\\n", target_rps);', '/* 目标 RPS 打印两位小数。 */'],
  [2099, 'printf("  RPS distribution (reqs/sec):\\n");', '/* 分布表头。 */'],
  [2100, 'printf("    %9s %9s %9s %9s %9s %9s\\n", "avg", "min", "p50", "p95", "p99", "max");', '/* 列名固定顺序，脚本按列解析。 */'],
  [2101, 'printf("    %9.3f %9.3f %9.3f %9.3f %9.3f %9.3f\\n", avg_rps, p0, p50, p95, p99, p100);', '/* 数值与列名一一对应。 */'],

  // ---- showReport ----
  [2118, 'const float reqpersec = (float)config.requests_finished / ((float)config.totlatency / 1000.0f);', '/* reqpersec = 完成数 / 秒；totlatency 单位是毫秒，先转秒再除。 */'],
  [2119, 'const float p0 = ((float)hdr_min(config.latency_histogram)) / 1000.0f;', '/* 直方图单位是微秒，p0 除以 1000 转毫秒。 */'],
  [2120, 'const float p50 = hdr_value_at_percentile(config.latency_histogram, 50.0) / 1000.0f;', '/* p50 转毫秒。 */'],
  [2121, 'const float p95 = hdr_value_at_percentile(config.latency_histogram, 95.0) / 1000.0f;', '/* p95 转毫秒。 */'],
  [2122, 'const float p99 = hdr_value_at_percentile(config.latency_histogram, 99.0) / 1000.0f;', '/* p99 转毫秒。 */'],
  [2123, 'const float p100 = ((float)hdr_max(config.latency_histogram)) / 1000.0f;', '/* 最大值转毫秒。 */'],
  [2124, 'const float avg = hdr_mean(config.latency_histogram) / 1000.0f;', '/* 均值转毫秒。 */'],
  [2127, 'printf("%*s\\r", config.last_printed_bytes, " "); // ensure there is a clean line', '/* 先清掉上一行进度输出，保证报告从行首开始。 */'],
  [2128, 'printf("====== %s ======\\n", config.title);', '/* 标题行。 */'],
  [2129, 'printf("  %d requests completed in %.2f seconds\\n", config.requests_finished, (float)config.totlatency / 1000);', '/* 完成数与总耗时。 */'],
  [2130, 'printf("  %d parallel clients\\n", config.numclients);', '/* 并发客户端数。 */'],
  [2131, 'printf("  %d bytes payload\\n", config.datasize);', '/* value 字节数。 */'],
  [2132, 'printf("  keep alive: %d\\n", config.keepalive);', '/* keepalive 开关。 */'],
  [2133, 'if (config.cluster_mode) {', '/* 集群模式额外打印每个节点的配置。 */'],
  [2134, 'const char *node_roles = NULL;', '/* node_roles 先置 NULL，下面三分支必有一个赋值。 */'],
  [2135, 'if (config.read_from_replica == FROM_ALL) {', '/* 读全部节点时标 cluster。 */'],
  [2136, 'node_roles = "cluster";', '/* 字符串是字面量，不释放。 */'],
  [2137, '} else if (config.read_from_replica == FROM_REPLICA_ONLY) {', '/* 只读副本时标 replica。 */'],
  [2140, 'node_roles = "primary";', '/* 默认只看主库。 */'],
  [2142, 'printf("  cluster mode: yes (%d %s)\\n", config.cluster_node_count, node_roles);', '/* 打印节点数与角色。 */'],
  [2143, 'int m;', '/* 节点循环变量。 */'],
  [2144, 'for (m = 0; m < config.cluster_node_count; m++) {', '/* 逐节点打印。 */'],
  [2145, 'clusterNode *node = config.cluster_nodes[m];', '/* 取节点结构。 */'],
  [2146, 'serverConfig *cfg = node->server_config;', '/* CONFIG GET 缓存可能为 NULL（读取失败降级）。 */'],
  [2147, 'if (cfg == NULL) continue;', '/* 没有配置就跳过该节点，避免解引用 NULL。 */'],
  [2148, 'printf("  node [%d] configuration:\\n", m);', '/* 节点下标便于对照 CLUSTER SLOTS 顺序。 */'],
  [2149, 'printf("    save: %s\\n", sdslen(cfg->save) ? cfg->save : "NONE");', '/* save 为空时打印 NONE，避免空行。 */'],
  [2150, 'printf("    appendonly: %s\\n", cfg->appendonly);', '/* appendonly 原值。 */'],
  [2153, 'if (config.server_config) {', '/* 单机只打印一份配置。 */'],
  [2154, 'printf("  host configuration \\"save\\": %s\\n", config.server_config->save);', '/* save 原值。 */'],
  [2155, 'printf("  host configuration \\"appendonly\\": %s\\n", config.server_config->appendonly);', '/* appendonly 原值。 */'],
  [2158, 'printf("  multi-thread: %s\\n", (config.num_threads ? "yes" : "no"));', '/* 是否多线程。 */'],
  [2159, 'if (config.num_threads) printf("  threads: %d\\n", config.num_threads);', '/* 多线程才打印线程数。 */'],
  [2161, 'showRPSReport();', '/* RPS 分布表。 */'],
  [2162, 'printf("\\n");', '/* 空行分隔。 */'],
  [2163, 'printf("Latency by percentile distribution:\\n");', '/* 分位数表标题。 */'],
  [2164, 'struct hdr_iter iter;', '/* hdr 迭代器。 */'],
  [2165, 'long long previous_cumulative_count = -1;', '/* -1 保证第一个桶一定打印。 */'],
  [2166, 'const long long total_count = config.latency_histogram->total_count;', '/* 总样本数，用于判断是否到最后一个桶。 */'],
  [2167, 'hdr_iter_percentile_init(&iter, config.latency_histogram, 1);', '/* 百分位迭代，步长 1%。 */'],
  [2168, 'struct hdr_iter_percentiles *percentiles = &iter.specifics.percentiles;', '/* 取迭代器的 percentiles 子结构。 */'],
  [2169, 'while (hdr_iter_next(&iter)) {', '/* 逐个桶输出。 */'],
  [2170, 'const double value = iter.highest_equivalent_value / 1000.0f;', '/* 桶上界微秒转毫秒。 */'],
  [2171, 'const double percentile = percentiles->percentile;', '/* 累计百分位。 */'],
  [2172, 'const long long cumulative_count = iter.cumulative_count;', '/* 累计计数。 */'],
  [2173, 'if (previous_cumulative_count != cumulative_count || cumulative_count == total_count) {', '/* 只有计数变化或到最后一个桶才打印，去重。 */'],
  [2174, 'printf("%3.3f%% <= %.3f milliseconds (cumulative count %lld)\\n", percentile, value, cumulative_count);', '/* 输出百分位与延迟。 */'],
  [2176, 'previous_cumulative_count = cumulative_count;', '/* 记录本次计数，供下一次比较。 */'],
  [2178, 'printf("\\n");', '/* 空行分隔下一段。 */'],
  [2179, 'printf("Cumulative distribution of latencies:\\n");', '/* 线性分布标题。 */'],
  [2180, 'previous_cumulative_count = -1;', '/* 重新置 -1，线性迭代是另一套桶。 */'],
  [2181, 'hdr_iter_linear_init(&iter, config.latency_histogram, 100);', '/* 每 100us 一个桶。 */'],
  [2182, 'while (hdr_iter_next(&iter)) {', '/* 逐桶输出。 */'],
  [2183, 'const double value = iter.highest_equivalent_value / 1000.0f;', '/* 桶上界转毫秒。 */'],
  [2184, 'const long long cumulative_count = iter.cumulative_count;', '/* 累计计数。 */'],
  [2185, 'const double percentile = ((double)cumulative_count / (double)total_count) * 100.0;', '/* 线性迭代没有百分位，自己按总数算。 */'],
  [2186, 'if (previous_cumulative_count != cumulative_count || cumulative_count == total_count) {', '/* 去重条件同百分位表。 */'],
  [2187, 'printf("%3.3f%% <= %.3f milliseconds (cumulative count %lld)\\n", percentile, value, cumulative_count);', '/* 输出线性分布的一行。 */'],
  [2191, 'if (iter.highest_equivalent_value > 2000) {', '/* 超过 2ms 后桶宽改成 1ms，减少长尾噪声。 */'],
  [2192, 'hdr_iter_linear_set_value_units_per_bucket(&iter, 1000);', '/* 动态放大桶宽。 */'],
  [2194, 'previous_cumulative_count = cumulative_count;', '/* 记录计数供下一次比较。 */'],
  [2196, 'printf("\\n");', '/* 空行。 */'],
  [2197, 'printf("Summary:\\n");', '/* Summary 标题。 */'],
  [2198, 'printf("  throughput summary: %.2f requests per second\\n", reqpersec);', '/* 吞吐。 */'],
  [2199, 'printf("  latency summary (msec):\\n");', '/* 延迟摘要标题。 */'],
  [2200, 'printf("    %9s %9s %9s %9s %9s %9s\\n", "avg", "min", "p50", "p95", "p99", "max");', '/* 列名。 */'],
  [2201, 'printf("    %9.3f %9.3f %9.3f %9.3f %9.3f %9.3f\\n", avg, p0, p50, p95, p99, p100);', '/* 数值行。 */'],
  [2202, '} else if (config.csv) {', '/* CSV 模式只输出一行。 */'],
  [2203, 'printf("\\"%s\\",\\"%.2f\\",\\"%.3f\\",\\"%.3f\\",\\"%.3f\\",\\"%.3f\\",\\"%.3f\\",\\"%.3f\\"\\n", config.title, reqpersec, avg,', '/* 字段顺序与表头严格对应。 */'],
  [2206, 'printf("%*s\\r", config.last_printed_bytes, " "); // ensure there is a clean line', '/* 清掉进度行。 */'],
  [2207, 'printf("%s: %.2f requests per second, p50=%.3f msec\\n", config.title, reqpersec, p50);', '/* 安静模式单行摘要。 */'],

  // ---- initBenchmarkThreads ----
  [2211, 'static void initBenchmarkThreads(void) {', '/* 按 num_threads 分配线程数组；重复调用会先释放旧数组。 */'],
  [2212, 'int i;', '/* 循环变量提前声明。 */'],
  [2213, 'if (config.threads) freeBenchmarkThreads();', '/* 已有数组先释放，避免重复调用时泄漏。 */'],
  [2214, 'config.threads = zmalloc(config.num_threads * sizeof(benchmarkThread *));', '/* zmalloc 失败 abort。 */'],
  [2215, 'for (i = 0; i < config.num_threads; i++) {', '/* 逐个创建线程。 */'],
  [2216, 'benchmarkThread *thread = createBenchmarkThread(i);', '/* 建线程对象；内部再分配 loop 与直方图。 */'],
  [2217, 'config.threads[i] = thread;', '/* 存进数组，startBenchmarkThreads 按 index 取。 */'],

  // ---- startBenchmarkThreads ----
  [2229, 'int i;', '/* 循环变量。 */'],
  [2230, 'for (i = 0; i < config.num_threads; i++) {', '/* 逐个建线程。 */'],
  [2231, 'benchmarkThread *t = config.threads[i];', '/* 取线程对象。 */'],
  [2232, 'if (pthread_create(&(t->thread), NULL, execBenchmarkThread, t)) {', '/* pthread_create 返回非 0 即失败。 */'],
  [2233, 'fprintf(stderr, "FATAL: Failed to start thread %d.\\n", i);', '/* 打印失败线程号。 */'],
  [2234, 'exit(1);', '/* 少一个线程吞吐就不准，直接终止。 */'],
  [2237, 'for (i = 0; i < config.num_threads; i++) pthread_join(config.threads[i]->thread, NULL);', '/* join 全部线程；必须在读直方图之前。 */'],
  [2241, 'hdr_reset(config.latency_histogram);', '/* 清掉 showThroughput 期间的近似合并值。 */'],
  [2242, 'for (i = 0; i < config.num_threads; i++) {', '/* 逐线程累加。 */'],
  [2243, 'hdr_add(config.latency_histogram, config.threads[i]->latency_histogram);', '/* hdr_add 把本线程样本并进全局。 */'],

  // ---- benchmarkSequence ----
  [2268, 'client c;', '/* 首个客户端句柄，后面 createMissingClients 以它为模板。 */'],
  [2270, 'config.title = title;', '/* 当前 test 名称，showReport 打印用。 */'],
  [2271, 'config.requests_issued = 0;', '/* 计数器归零，否则第二个 test 一启动就已完成。 */'],
  [2272, 'config.requests_finished = 0;', '/* 完成数同样归零。 */'],
  [2273, 'config.previous_requests_finished = 0;', '/* 每秒差值基准归零。 */'],
  [2274, 'config.last_printed_bytes = 0;', '/* 进度行宽度基准归零。 */'],
  [2275, 'config.current_warmup_duration = config.warmup_duration;', '/* 可变副本；showThroughput 会把它清 0。 */'],
  [2276, 'hdr_init(CONFIG_LATENCY_HISTOGRAM_MIN_VALUE,         // Minimum value', '/* 总延迟直方图，上界 60s。 */'],
  [2280, 'hdr_init(CONFIG_LATENCY_HISTOGRAM_MIN_VALUE,         // Minimum value', '/* 每秒直方图是独立实例，不能与总表共用。 */'],
  [2285, 'if (config.rps > 0) {', '/* 只有 -R 才需要 rps 直方图。 */'],
  [2286, 'hdr_init(1,', '/* 上界取目标 2 倍，给抖动留余量。 */'],
  [2292, 'initPlaceholders(cmd, len);', '/* 必须在建客户端之前，客户端要按偏移表布局。 */'],
  [2293, 'if (config.num_threads) initBenchmarkThreads();', '/* 多线程才初始化线程数组。 */'],
  [2295, 'if (config.rps > 0) {', '/* 限速参数只在 RPS 模式有意义。 */'],
  [2296, 'config.time_per_token = 1000000000 / config.rps;', '/* 每个令牌间隔纳秒。 */'],
  [2297, 'config.time_per_burst = config.time_per_token * config.rps;', '/* 突发窗口等于 1 秒的令牌量。 */'],
  [2298, 'config.last_time_ns = 0;', '/* 重置基准时间，第一轮从 0 起算。 */'],
  [2301, 'int thread_id = config.num_threads > 0 ? 0 : -1;', '/* 多线程时首个客户端属于线程 0。 */'],
  [2302, 'c = createClient(cmd, len, seqlen, NULL, thread_id);', '/* 建首个客户端，cmd 作为模板。 */'],
  [2303, 'createMissingClients(c);', '/* 补齐到 numclients。 */'],
  [2305, 'config.start = mstime();', '/* 建连完成后再取开始时间，把建连排除在吞吐外。 */'],
  [2306, 'if (!config.num_threads) {', '/* 单线程直接跑主 loop。 */'],
  [2307, 'aeMain(config.el);', '/* aeMain 阻塞到所有客户端结束。 */'],
  [2309, 'startBenchmarkThreads();', '/* 多线程模式：创建、join、合并。 */'],
  [2310, 'config.totlatency = mstime() - config.start;', '/* 墙钟差就是总耗时。 */'],
  [2311, 'showReport();', '/* 打印报告。 */'],
  [2312, 'freeAllClients();', '/* 释放客户端，必须在报告之后。 */'],
  [2313, 'if (config.threads) freeBenchmarkThreads();', '/* 释放线程数组。 */'],
  [2314, 'if (config.current_sec_latency_histogram) hdr_close(config.current_sec_latency_histogram);', '/* 关闭每秒直方图。 */'],
  [2315, 'if (config.latency_histogram) hdr_close(config.latency_histogram);', '/* 关闭总直方图。 */'],
  [2316, 'if (config.rps_histogram) hdr_close(config.rps_histogram);', '/* rps_histogram 可能为 NULL，hdr_close 前先判。 */'],

  // ---- benchmark ----
  [2321, 'benchmarkSequence(title, cmd, len, 1);', '/* 单条命令就是 seqlen=1 的序列。 */'],
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
fs.writeFileSync(`${DIR}/ins-p8.json`, JSON.stringify([{ file: 'src/valkey-benchmark.c', ops }], null, 1));

const OUT = `${DIR}/out-valkey-benchmark.json`;
const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
fs.writeFileSync(OUT, JSON.stringify(prev.concat(added), null, 1));
console.log(`P8 entries=${added.length} cumulative=${prev.length + added.length}`);
