// B36 P4：scanClusterTags / setClusterKeyHashTag / acquireTokenOrWait / clientDone。
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/valkey-benchmark.c';
const DIR = 'd:/code/_annot_baseline/VK-B36';

const E = [
  // ---- scanClusterTags 主体 ----
  [1077, 'if (!config.cluster_mode) return;', '/* 单机模式没有 hashtag 语义，直接返回；否则会把普通 {} 当占位符改掉。 */'],
  [1081, 'size_t total_cap = c->staglen + c->stagfree;', '/* 先记总容量，重置 staglen 时不让已分配的数组缩水。 */'],
  [1082, 'c->staglen = 0;', '/* 从零开始重新登记本次请求的 {tag}。 */'],
  [1083, 'c->stagfree = total_cap;', '/* 全部容量暂时可用，随登记逐个递减。 */'],
  [1084, 'char *p = buffer_start;', '/* 从请求缓冲区起点扫描。 */'],
  [1085, 'while ((p = strstr(p, "{tag}")) != NULL) {', '/* 只认字面量 {tag}；用户命令写了别的占位符不会被替换。 */'],
  [1086, 'if (c->stagfree == 0) {', '/* 容量用尽才扩容；stagptr 为 NULL 时 zrealloc 等价于 malloc。 */'],
  [1087, 'size_t new_size = total_cap ? total_cap * 2 : RANDPTR_INITIAL_SIZE;', '/* 首次用 8，之后翻倍；total_cap 为 0 时不能直接乘 2。 */'],
  [1088, 'c->stagptr = zrealloc(c->stagptr, new_size * sizeof(char *));', '/* zrealloc 失败 abort，旧指针不会泄漏。 */'],
  [1089, 'total_cap = new_size;', '/* 同步总容量，下一次扩容继续翻倍。 */'],
  [1090, 'c->stagfree = new_size - c->staglen;', '/* 新容量减去已用数量，得到本次剩余额度。 */'],
  [1092, 'c->stagptr[c->staglen++] = p;', '/* 存的是缓冲区内的绝对地址；obuf 迁移后必须同步修正。 */'],
  [1093, 'c->stagfree--;', '/* 与上一行的 ++ 配对，保持 已用+剩余=总容量。 */'],
  [1094, 'p += 5;', '/* 跳过整个 {tag}，避免在同一位置重复匹配。 */'],

  // ---- setClusterKeyHashTag 主体 ----
  [1111, 'assert(c->thread_id >= 0);', '/* 只在压测线程里调用；主线程没有 cluster_node，断言先拦住。 */'],
  [1112, 'clusterNode *node = c->cluster_node;', '/* 当前客户端绑定的节点，决定可用槽位集合。 */'],
  [1113, 'assert(node);', '/* 集群模式下客户端必须已绑定节点，空指针会让下面取 slots 崩溃。 */'],
  [1114, 'int is_updating_slots = atomic_load_explicit(&config.is_updating_slots, memory_order_relaxed);', '/* relaxed 读一次标志，决定是否先等槽表更新完。 */'],
  [1121, 'if (is_updating_slots) updateClusterSlotsConfiguration();', '/* 更新中则阻塞在该函数的互斥锁上；本线程是更新者时它是空操作，不会自锁。 */'],
  [1122, 'int slot = node->slots[rand() % node->slots_count];', '/* 在本节点负责的槽里均匀抽一个，避免生成不属于该节点的 key。 */'],
  [1123, 'const char *tag = crc16_slot_table[slot];', '/* 槽位对应的 hashtag 字符串，长度限制 1~3 字符。 */'],
  [1124, 'int taglen = strlen(tag);', '/* 长度决定下面覆写几个字节；超过 3 会溢出到右花括号之后。 */'],
  [1125, 'size_t i;', '/* 声明提前，C89 风格，避免在 for 内声明。 */'],
  [1126, 'for (i = 0; i < c->staglen; i++) {', '/* 每个 {tag} 位置都写入同一个 slot 的 tag，保证同请求同分片。 */'],
  [1127, 'char *p = c->stagptr[i] + 1;', '/* 加 1 跳过左花括号，从 tag 的首字符开始覆写。 */'],
  [1128, 'p[0] = tag[0];', '/* 第一字节一定有值，tag 最短也是 1 字符。 */'],
  [1129, "p[1] = (taglen >= 2 ? tag[1] : '}');", '/* 2 字符 tag 后直接补右花括号；1 字符时这里就收尾。 */'],
  [1130, "p[2] = (taglen == 3 ? tag[2] : '}');", '/* 3 字符才写第三位，否则再补右花括号，把 {tag} 缩短为合法 hashtag。 */'],

  // ---- acquireTokenOrWait 主体 ----
  [1162, 'uint64_t time_per_token = config.time_per_token;', '/* 局部缓存，避免循环里反复读全局配置。 */'],
  [1163, 'uint64_t time_per_burst = config.time_per_burst;', '/* 突发窗口容量，用于判断桶是否已空置过久。 */'],
  [1164, 'uint64_t new_time = 0;', '/* 候选的新时间戳，CAS 成功时才写回全局。 */'],
  [1165, 'uint64_t now_epoch, next_epoch, min_time, delay_time;', '/* 一次算清需要的时间量，循环内只赋值。 */'],
  [1166, 'uint64_t last_time_ns, old_last_time_ns;', '/* old 供 CAS 比较，last 是本次计算出的目标值。 */'],
  [1168, 'while (1) {', '/* CAS 失败要重读重算，直到成功为止。 */'],
  [1169, 'old_last_time_ns = atomic_load_explicit(&config.last_time_ns, memory_order_relaxed);', '/* relaxed 读当前时间戳，作为 CAS 的期望值。 */'],
  [1170, 'last_time_ns = old_last_time_ns;', '/* 本地副本先与全局一致，后面可能被改写。 */'],
  [1171, 'now_epoch = nstime();', '/* 单调纳秒时间，系统时间跳变不会让限速错乱。 */'],
  [1174, 'if (last_time_ns == 0) {', '/* 首次调用时桶还没有基准，用当前时间初始化。 */'],
  [1175, 'last_time_ns = now_epoch;', '/* 以当前时间为起点，避免从 0 起算产生巨量令牌。 */'],
  [1178, 'next_epoch = now_epoch + 1000000;', '/* 加 1ms：时间事件最小粒度，保证需要等待时 delay 至少 1ms。 */'],
  [1179, 'min_time = next_epoch - time_per_burst;', '/* 桶的最旧可用时间，早于它的基准要重置。 */'],
  [1181, 'if (min_time > last_time_ns) { // if the last time is too old, reset it', '/* 基准落后超过一个突发窗口，说明桶已空置很久。 */'],
  [1182, 'new_time = min_time + (time_per_token * tokens);', '/* 重置到窗口起点再加本次令牌耗时，避免一次性补满。 */'],
  [1184, 'new_time = last_time_ns + (time_per_token * tokens);', '/* 正常情况：在上次基准后累加本次令牌的时间成本。 */'],
  [1187, 'delay_time = 0;', '/* 默认无需等待。 */'],
  [1188, 'if (new_time > next_epoch) { // if the new time is in the next epoch, we need to wait', '/* 目标时间超出下一个 1ms 边界，本次来不及。 */'],
  [1189, 'delay_time = new_time - now_epoch;', '/* 算出需要等待的真实纳秒数，最后转毫秒。 */'],
  [1191, 'last_time_ns = new_time;', '/* 来得及就推进基准，等价于消费掉令牌。 */'],
  [1194, 'if (atomic_compare_exchange_weak_explicit(', '/* CAS 发布新基准；失败说明别的线程抢先，重来。 */'],
  [1200, 'break;', '/* CAS 成功，退出重试循环。 */'],
  [1204, 'return delay_time / 1000000;', '/* 纳秒转毫秒；0 表示令牌已拿到。 */'],

  // ---- clientDone 主体 ----
  [1217, 'int requests_finished = atomic_load_explicit(&config.requests_finished, memory_order_relaxed);', '/* 读一次快照；后续判定都用同一个值，避免中途变化。 */'],
  [1218, 'if (isBenchmarkFinished(requests_finished)) {', '/* 达标就停机，不再补连接。 */'],
  [1219, 'freeClient(c);', '/* 释放客户端；多线程下它在内部 aeStop。 */'],
  [1220, 'if (!config.num_threads && config.el) aeStop(config.el);', '/* 单线程要显式停主 loop；config.el 判空防御未初始化。 */'],
  [1221, 'return;', '/* 停机路径到此结束，后面是复用或补连接。 */'],
  [1223, 'if (config.keepalive) {', '/* 复用连接：只重置收发状态，liveclients 不变。 */'],
  [1224, 'resetClient(c);', '/* 重新注册可写事件，开始下一轮。 */'],
  [1226, 'if (config.num_threads) pthread_mutex_lock(&(config.liveclients_mutex));', '/* 减计数到补连接之间必须持锁，避免别的线程看到 0。 */'],
  [1227, 'config.liveclients--;', '/* 临时按“少了一个”计算缺口。 */'],
  [1228, 'createMissingClients(c);', '/* 按缺口补新连接；它读的就是刚减过的 liveclients。 */'],
  [1229, 'config.liveclients++;', '/* 补完恢复计数，随后 freeClient 再正式减一。 */'],
  [1230, 'if (config.num_threads) pthread_mutex_unlock(&(config.liveclients_mutex));', '/* 必须先解锁再 freeClient：后者内部还会取同一把非递归互斥锁。 */'],
  [1231, 'freeClient(c);', '/* 正式释放；它会再次取锁并把 liveclients 减一。 */'],
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
fs.writeFileSync(`${DIR}/ins-p4.json`, JSON.stringify([{ file: 'src/valkey-benchmark.c', ops }], null, 1));

const OUT = `${DIR}/out-valkey-benchmark.json`;
const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
fs.writeFileSync(OUT, JSON.stringify(prev.concat(added), null, 1));
console.log(`P4 entries=${added.length} cumulative=${prev.length + added.length}`);
