// B36 P13：showThroughput / generateFunctionScript / test_is_selected。
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/valkey-benchmark.c';
const DIR = 'd:/code/_annot_baseline/VK-B36';

const E = [
  // ---- showThroughput ----
  [3817, 'UNUSED(eventLoop);', '/* eventLoop 形参未用，宏消掉 -Wunused-parameter。 */'],
  [3818, 'UNUSED(id);', '/* id 是定时器 id，本函数同样未用。 */'],
  [3819, 'benchmarkThread *thread = (benchmarkThread *)clientData;', '/* clientData 是本线程的 benchmarkThread；主线程传 NULL。 */'],
  [3822, 'flushRequestsFinished();', '/* 先刷本线程批量计数，否则下面的结束判断用旧值。 */'],
  [3823, 'int requests_finished = atomic_load_explicit(&config.requests_finished, memory_order_relaxed);', '/* relaxed 读全局完成数，只用于统计展示。 */'],
  [3824, 'int previous_requests_finished = atomic_load_explicit(&config.previous_requests_finished, memory_order_relaxed);', '/* 上一 tick 的完成数，用来算瞬时 rps。 */'],
  [3825, 'long long current_tick = mstime();', '/* 当前毫秒时间戳，本函数只取一次保证各差值同源。 */'],
  [3827, 'int liveclients = atomic_load_explicit(&config.liveclients, memory_order_relaxed);', '/* 活跃客户端数，0 且未完成说明全部掉线。 */'],
  [3828, 'if (liveclients == 0 && !isBenchmarkFinished(requests_finished)) {', '/* 全掉线且未达标，继续等只会挂死。 */'],
  [3829, 'fprintf(stderr, "All clients disconnected... aborting.\\n");', '/* 打印掉线原因。 */'],
  [3830, 'exit(1);', '/* exit 而非 aeStop，避免把失败包装成正常结束。 */'],
  [3832, 'int warmup_duration = atomic_load_explicit(&config.current_warmup_duration, memory_order_relaxed);', '/* 读热身剩余时间，0 表示已进入正式统计。 */'],
  [3833, 'if (warmup_duration > 0) {', '/* 仍处于热身期，先判断是否到时。 */'],
  [3834, 'if ((current_tick - config.start) >= (warmup_duration * 1000LL)) {', '/* 热身秒数换算成毫秒后与已过时间比较。 */'],
  [3836, 'atomic_store_explicit(&config.current_warmup_duration, 0, memory_order_relaxed);', '/* 清 current_warmup_duration，后续 tick 走结束判断分支。 */'],
  [3838, 'config.start = current_tick;', '/* 把起点挪到此刻，时长统计不含热身。 */'],
  [3839, 'atomic_store_explicit(&config.requests_finished, 0, memory_order_relaxed);', '/* 清零完成数，热身流量不计入结果。 */'],
  [3840, 'atomic_store_explicit(&config.requests_issued, 0, memory_order_relaxed);', '/* 清零已发数，限速判断从 0 重新累计。 */'],
  [3841, 'atomic_store_explicit(&config.previous_requests_finished, 0, memory_order_relaxed);', '/* 清零上一 tick 基准，瞬时 rps 从头算。 */'],
  [3842, 'hdr_reset(config.latency_histogram);', '/* 清空单线程总直方图。 */'],
  [3846, 'for (int t = 0; t < config.num_threads; t++) {', '/* 多线程下逐个清每线程直方图。 */'],
  [3847, 'hdr_reset(config.threads[t]->latency_histogram);', '/* 清线程总延迟直方图。 */'],
  [3848, 'hdr_reset(config.threads[t]->current_sec_latency_histogram);', '/* 清线程每秒直方图。 */'],
  [3851, '} else if (isBenchmarkFinished(requests_finished)) {', '/* 非热身且已完成，准备停机。 */'],
  [3852, 'aeStop(eventLoop);', '/* 停本线程事件循环，aeMain 返回。 */'],
  [3856, 'if (config.num_threads) {', '/* 多线程时本线程 loop 随后销毁，定时器必须删。 */'],
  [3857, 'return AE_NOMORE;', '/* AE_NOMORE 让 ae 删除该定时器。 */'],
  [3860, 'if (config.csv) return SHOW_THROUGHPUT_INTERVAL;', '/* CSV 模式不输出进度行，避免污染 stdout。 */'],
  [3862, 'if (thread != NULL && thread->index != 0) {', '/* 只有 thread 0 负责打印，其余线程直接返回。 */'],
  [3863, 'return SHOW_THROUGHPUT_INTERVAL;', '/* 返回周期，等下一次触发。 */'],
  [3865, 'if (config.idlemode == 1) {', '/* idle 模式只显示连接数。 */'],
  [3866, 'printf("clients: %d\\r", config.liveclients);', '/* 回车符回到行首原地刷新。 */'],
  [3867, 'fflush(stdout);', '/* 立即刷出，否则重定向到文件时看不到进度。 */'],
  [3868, 'return SHOW_THROUGHPUT_INTERVAL;', '/* 继续等下一次 tick。 */'],
  [3870, 'if (config.num_threads) {', '/* 多线程下用 thread 0 的直方图近似全局。 */'],
  [3875, 'benchmarkThread *t0 = config.threads[0];', '/* 取 thread 0，showThroughput 就跑在它的 loop 里。 */'],
  [3876, 'hdr_reset(config.latency_histogram);', '/* 清全局总表，准备重算。 */'],
  [3877, 'hdr_add(config.latency_histogram, t0->latency_histogram);', '/* 把 t0 的总表并进来。 */'],
  [3878, 'hdr_reset(config.current_sec_latency_histogram);', '/* 清全局每秒表。 */'],
  [3879, 'hdr_add(config.current_sec_latency_histogram, t0->current_sec_latency_histogram);', '/* 并入 t0 的每秒表。 */'],
  [3880, 'hdr_reset(t0->current_sec_latency_histogram);', '/* 清掉 t0 每秒表，下个窗口重新累计。 */'],
  [3882, 'const float dt = (float)(current_tick - config.start) / 1000.0;', '/* 从 start 到现在的秒数。 */'],
  [3883, 'const float rps = (float)requests_finished / dt;', '/* 累计 rps，分母是整段时长。 */'],
  [3884, 'const float instantaneous_dt = (float)(current_tick - config.previous_tick) / 1000.0;', '/* 与上一 tick 的间隔秒数。 */'],
  [3885, 'const float instantaneous_rps = (float)(requests_finished - previous_requests_finished) / instantaneous_dt;', '/* 本窗口 rps，限速抖动只有它能看出来。 */'],
  [3887, 'if (config.rps_histogram) {', '/* 有 RPS 直方图才记录。 */'],
  [3888, 'hdr_record_value(config.rps_histogram, (int64_t)instantaneous_rps);', '/* 记录瞬时 rps，供最终分布统计。 */'],
  [3891, 'config.previous_tick = current_tick;', '/* 更新 tick 基准。 */'],
  [3892, 'atomic_store_explicit(&config.previous_requests_finished, requests_finished, memory_order_relaxed);', '/* 更新上一 tick 完成数基准。 */'],
  [3894, 'printf("%*s\\r", config.last_printed_bytes, " "); /* ensure there is a clean line */', '/* 先打印等量空格覆盖上一行残影。 */'],
  [3895, 'config.last_printed_bytes = 0;', '/* 归零后重新累计本行长度。 */'],
  [3896, 'if (warmup_duration > 0) {', '/* 热身期加前缀。 */'],
  [3897, 'config.last_printed_bytes += printf("Warming up ");', '/* printf 返回值即写入字节数。 */'],
  [3899, 'config.last_printed_bytes +=', '/* 累加主状态行长度。 */'],
  [3902, 'if (warmup_duration > 0 || config.duration > 0) {', '/* 按时间跑的显示秒数。 */'],
  [3903, 'config.last_printed_bytes += printf(" %.1f seconds\\r", dt);', '/* 秒数带一位小数。 */'],
  [3905, 'config.last_printed_bytes += printf(" %d requests\\r", requests_finished);', '/* 按请求数跑的显示完成数。 */'],
  [3908, 'hdr_reset(config.current_sec_latency_histogram);', '/* 本窗口已展示，清零等下个 250ms。 */'],
  [3909, 'fflush(stdout);', '/* 刷出进度行。 */'],
  [3910, 'return SHOW_THROUGHPUT_INTERVAL;', '/* 返回 250ms，ae 下个周期再调。 */'],

  // ---- generateFunctionScript ----
  [3922, 'const size_t buffer_len = 64 * 1024;', '/* 固定 64KB，脚本超长就截断。 */'],
  [3923, 'char *buffer = zmalloc(buffer_len);', '/* zmalloc 失败即 abort，不会返回 NULL。 */'],
  [3924, 'memset(buffer, 0, buffer_len);', '/* 清零保证末尾有 NUL。 */'],
  [3926, 'int written = snprintf(buffer, buffer_len, "#!lua name=benchlib\\n");', '/* 先写 shebang，written 记录已用字节。 */'],
  [3927, 'while (num_functions > 0 && (buffer_len - written) > 0) {', '/* 剩余空间不足或函数写完就停。 */'],
  [3928, 'assert(buffer_len - written > 0);', '/* 进入循环时剩余空间必为正。 */'],
  [3929, 'int n = 0;', '/* 本次 snprintf 写入长度，负数表示出错。 */'],
  [3930, 'if (with_keys) {', '/* 带键版本返回 keys[0]。 */'],
  [3931, 'n = snprintf(buffer + written, buffer_len - written,', '/* 追加 local function fooN 定义。 */'],
  [3934, '} else {', '/* 无键版本返回 0。 */'],
  [3935, 'n = snprintf(buffer + written, buffer_len - written,', '/* 同上，签名不带参数。 */'],
  [3940, 'if (n < 0 || (size_t)n >= buffer_len - written) {', '/* 截断或出错就停，不写半条语句。 */'],
  [3941, 'break;', '/* 直接跳出，返回已写部分。 */'],
  [3943, 'written += n;', '/* 推进写入游标。 */'],
  [3945, 'n = snprintf(buffer + written, buffer_len - written,', '/* 追加 register_function 调用。 */'],
  [3949, 'if (n < 0 || (size_t)n >= buffer_len - written) {', '/* 注册行同样要判截断。 */'],
  [3950, 'break;', '/* 截断即停。 */'],
  [3952, 'written += n;', '/* 再次推进游标。 */'],
  [3954, 'num_functions--;', '/* 递减编号，脚本最后一个是 foo1。 */'],
  [3957, 'return buffer;', '/* 返回 zmalloc 缓冲，调用方负责 zfree。 */'],

  // ---- test_is_selected ----
  [3963, 'char buf[256];', '/* 栈上拼 ,name, 用于精确子串匹配。 */'],
  [3964, 'int l = strlen(name);', '/* 名字长度，决定拼接位置。 */'],
  [3966, 'if (config.tests == NULL) return 1;', '/* 未给 -t 时全部选中。 */'],
  [3967, "buf[0] = ',';", '/* 前置逗号。 */'],
  [3968, 'memcpy(buf + 1, name, l);', '/* 拷入名字本体。 */'],
  [3969, "buf[l + 1] = ',';", '/* 后置逗号，避免 get 命中 lrange。 */'],
  [3970, "buf[l + 2] = '\\0';", '/* 手动补 NUL。 */'],
  [3971, 'return strstr(config.tests, buf) != NULL;', '/* 找到 ,name, 才算选中。 */'],
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
fs.writeFileSync(`${DIR}/ins-p13.json`, JSON.stringify([{ file: 'src/valkey-benchmark.c', ops }], null, 1));

const OUT = `${DIR}/out-valkey-benchmark.json`;
const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
fs.writeFileSync(OUT, JSON.stringify(prev.concat(added), null, 1));
console.log(`P13 entries=${added.length} cumulative=${prev.length + added.length}`);
