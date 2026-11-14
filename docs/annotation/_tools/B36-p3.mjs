// B36 P3：完成计数批量提交 + 占位符替换 + 暂停链表 + freeClient/freeAllClients/resetClient。
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/valkey-benchmark.c';
const DIR = 'd:/code/_annot_baseline/VK-B36';

const E = [
  // ---- flushRequestsFinished ----
  [811, 'static void flushRequestsFinished(void) {', '/* 把本线程累计的完成数一次性并入全局计数；只在批量模式下有非零残留。 */'],
  [812, 'if (pending_requests_finished > 0) {', '/* 没有残留就不做原子写，避免空转时白白争用 requests_finished 的缓存行。 */'],
  [813, 'atomic_fetch_add_explicit(&config.requests_finished, pending_requests_finished, memory_order_relaxed);', '/* relaxed 足够：计数只需最终一致，不需要与其它内存操作排序。 */'],
  [814, 'pending_requests_finished = 0;', '/* 清零放在写全局之后；中途崩溃只丢本批计数，不会重复计。 */'],

  // ---- addRequestFinished ----
  [818, 'static int addRequestFinished(void) {', '/* 记一次完成；单线程走精确路径，多线程攒够 256 才发布一次。 */'],
  [819, 'if (config.num_threads == 0) {', '/* 单线程没有争用，直接 fetch_add 并返回新值最准确。 */'],
  [820, 'return atomic_fetch_add_explicit(&config.requests_finished, 1, memory_order_relaxed);', '/* fetch_add 返回自增后的总数，正好作为结束判定的输入。 */'],
  [822, 'pending_requests_finished++;', '/* 线程局部累加不碰共享缓存行，这是批量记账的全部收益。 */'],
  [823, 'if (pending_requests_finished >= REQUESTS_FINISHED_FLUSH_BATCH) flushRequestsFinished();', '/* 达到 256 才发布；阈值越小越准，越大越省争用。 */'],
  [824, 'return atomic_load_explicit(&config.requests_finished, memory_order_relaxed) + pending_requests_finished;', '/* 全局值加未发布残留，结束判定才不会漏掉本线程刚完成的请求。 */'],

  // ---- replacePlaceholder 主体 ----
  [843, 'if (count == 0) return;', '/* count 为 0 说明该占位符没出现，直接返回避免读 indices[0]。 */'],
  [845, 'uint64_t key = 0;', '/* 默认 0：未传 -r 时所有请求共用 key 0，读的就是同一个键。 */'],
  [846, 'if (config.keyspacelen != 0) {', '/* 只有 -r 给了键空间才生成随机 key。 */'],
  [847, 'if (config.sequential_replacement) {', '/* --sequential 用原子自增，保证序号不重复。 */'],
  [848, 'key = atomic_fetch_add_explicit(key_counter, 1, memory_order_relaxed);', '/* relaxed 自增：只要不重号，先后顺序不影响命中分布。 */'],
  [850, 'key = rand62();', '/* 默认用 rand62() 取随机数，随后统一对 keyspacelen 取模。 */'],
  [852, 'key %= config.keyspacelen;', '/* 收窄到 [0, keyspacelen-1]；keyspacelen 为 0 时不会走到这里。 */'],
  [856, 'char *p = cmd + indices[0] + PLACEHOLDER_LEN - 1;', '/* 从 12 位槽的末位开始向前写，高位自然补 0。 */'],
  [857, 'for (size_t j = 0; j < PLACEHOLDER_LEN; j++) {', '/* 固定写满 12 位；少写一位会留下旧 key 的尾数。 */'],
  [858, "*p = '0' + key % 10;", '/* 取最低十进制位写成字符，key 随后除以 10。 */'],
  [859, 'key /= 10;', '/* 移到下一位；12 位用尽后剩余高位保持字符 0。 */'],
  [860, 'p--;', '/* 指针前移一位，与除法同步，从低位向高位写。 */'],
  [864, 'for (size_t i = 1; i < count; i++) {', '/* 其余出现位置直接复制第一处的 12 字节，保证同一命令内同值。 */'],
  [865, 'char *placeholder = cmd + indices[i];', '/* 目标地址来自同一份偏移表，不能跨命令复用。 */'],
  [866, 'memcpy(placeholder, cmd + indices[0], PLACEHOLDER_LEN);', '/* 定长复制 12 字节而不是 strlen，保持固定宽度语义。 */'],

  // ---- replacePlaceholders 主体 ----
  [881, 'static _Atomic uint64_t seq_key[PLACEHOLDER_COUNT] = {0};', '/* 函数内 static：跨命令、跨轮次保持单调，进程重启才归零。 */'],
  [883, 'for (int cmd_index = 0; cmd_index < cmd_count; cmd_index++) {', '/* 逐条命令处理；cmd_count 与缓冲区实际条数必须一致。 */'],
  [884, 'char *cmd = cmd_data + cmd_index * placeholders.cmd_len;', '/* 第 cmd_index 条命令的基址；命令不等长时这里会错位。 */'],
  [887, 'size_t *indices = placeholders.indices[0];', '/* __rand_int__ 的偏移数组。 */'],
  [888, '_Atomic uint64_t *key_counter = &seq_key[0];', '/* 每种占位符一个独立计数器，避免不同种类互相推进序号。 */'],
  [889, 'for (size_t i = 0; i < placeholders.count[0]; i++) {', '/* 每个 __rand_int__ 单独生成，所以同一命令内取值不同。 */'],
  [890, 'replacePlaceholder(indices + i, 1, cmd, key_counter);', '/* 传 count=1，强制走“只写第一处”的分支。 */'],
  [895, 'for (size_t placeholder = 1; placeholder < PLACEHOLDER_COUNT; placeholder++) {', '/* 1st~9th 共用一个值：整条命令只生成一次。 */'],
  [896, 'size_t *indices = placeholders.indices[placeholder];', '/* 该种类的偏移数组，与 count 同下标。 */'],
  [897, 'size_t count = placeholders.count[placeholder];', '/* 出现次数；传 0 时 replacePlaceholder 会立即返回。 */'],
  [898, '_Atomic uint64_t *key_counter = &seq_key[placeholder];', '/* 每种占位符各自的序列计数器。 */'],
  [899, 'replacePlaceholder(indices, count, cmd, key_counter);', '/* 一次调用填完该种类所有出现位置。 */'],

  // ---- releasePausedClient ----
  [904, 'static void releasePausedClient(client c) {', '/* 把客户端从暂停链表摘掉；线程内与主线程各有一张表，不能混用。 */'],
  [905, 'if (c->thread_id >= 0) {', '/* 线程内客户端的暂停表挂在所属 benchmarkThread 上。 */'],
  [906, 'benchmarkThread *thread = config.threads[c->thread_id];', '/* 取所属线程；thread_id 越界会读到别的线程。 */'],
  [907, 'listNode *ln = listSearchKey(thread->paused_clients, c);', '/* 线性查找；暂停表通常很短，不值得上哈希。 */'],
  [908, 'if (ln != NULL) {', '/* 可能已被别的路径摘掉，判空后再删。 */'],
  [909, 'listDelNode(thread->paused_clients, ln);', '/* 只摘节点，不释放 c。 */'],
  [912, 'listNode *ln = listSearchKey(config.paused_clients, c);', '/* 主线程暂停表的查找。 */'],
  [913, 'if (ln != NULL) {', '/* 同样可能已不在表内。 */'],
  [914, 'listDelNode(config.paused_clients, ln);', '/* 从主线程暂停表摘除。 */'],

  // ---- freeClient 主体 ----
  [931, 'aeEventLoop *el = CLIENT_GET_EVENTLOOP(c);', '/* 先确定所属 loop；后续两次删事件必须用同一个 el。 */'],
  [932, 'listNode *ln;', '/* 下面删除 config.clients 节点时复用。 */'],
  [933, 'aeDeleteFileEvent(el, c->context->fd, AE_WRITABLE);', '/* 先摘可写事件，避免释放后仍有 writeHandler 回调。 */'],
  [934, 'aeDeleteFileEvent(el, c->context->fd, AE_READABLE);', '/* 再摘可读事件；顺序反了会留下可写回调窗口。 */'],
  [935, 'if (c->thread_id >= 0) {', '/* 只有多线程客户端才在本地判定停机。 */'],
  [936, 'int requests_finished = atomic_load_explicit(&config.requests_finished, memory_order_relaxed);', '/* relaxed 读一次快照，避免两次读之间计数变化。 */'],
  [937, 'if (isBenchmarkFinished(requests_finished)) {', '/* 判定达标才停 loop；否则该线程还要继续压。 */'],
  [938, 'aeStop(el);', '/* aeStop 是幂等的，多个客户端同时触发也只生效一次。 */'],
  [941, 'valkeyFree(c->context);', '/* 释放连接上下文；必须在删事件之后，否则回调可能访问已释放对象。 */'],
  [942, 'if (c->paused) releasePausedClient(c);', '/* 暂停中的客户端若留在链表里，下一轮唤醒会 use-after-free。 */'],
  [943, 'sdsfree(c->obuf);', '/* 命令缓冲区随客户端一起释放。 */'],
  [944, 'zfree(c->stagptr);', '/* hashtag 指针数组是单独分配，必须单独释放。 */'],
  [945, 'zfree(c);', '/* 结构体最后释放；上面几行都在读它的字段。 */'],
  [946, 'if (config.num_threads) pthread_mutex_lock(&(config.liveclients_mutex));', '/* 修连接计数前必须取锁，showThroughput 在别的线程读 liveclients。 */'],
  [947, 'config.liveclients--;', '/* 递减遗漏会让 showThroughput 永远等不到 0。 */'],
  [948, 'ln = listSearchKey(config.clients, c);', '/* 从全局链表找节点；链表是唯一的客户端注册表。 */'],
  [949, 'assert(ln != NULL);', '/* 找不到说明注册与注销不平衡；release 版去掉 assert 后会静默跳过删除。 */'],
  [950, 'listDelNode(config.clients, ln);', '/* 摘链放在锁内，避免 createMissingClients 遍历到半删除节点。 */'],
  [951, 'if (config.num_threads) pthread_mutex_unlock(&(config.liveclients_mutex));', '/* 解锁必须在递减与摘链都完成之后。 */'],

  // ---- freeAllClients ----
  [959, 'listNode *ln = config.clients->head, *next;', '/* 从表头开始，next 在循环内缓存。 */'],
  [961, 'while (ln) {', '/* 逐个释放；freeClient 会把当前节点从同一链表摘掉。 */'],
  [962, 'next = ln->next;', '/* 先记下一个节点，否则释放后 ln 失效。 */'],
  [963, 'freeClient(ln->value);', '/* 释放客户端本体，同时递减 liveclients 并摘链。 */'],
  [964, 'ln = next;', '/* 前进到预先缓存的节点。 */'],

  // ---- resetClient ----
  [978, 'aeEventLoop *el = CLIENT_GET_EVENTLOOP(c);', '/* 取所属 loop，后续注册与删除事件都用它。 */'],
  [979, 'aeDeleteFileEvent(el, c->context->fd, AE_WRITABLE);', '/* 先摘旧的可写事件，避免与新注册重复回调。 */'],
  [980, 'aeDeleteFileEvent(el, c->context->fd, AE_READABLE);', '/* 可读事件同样清掉，新请求会按需重注册。 */'],
  [981, 'c->written = 0;', '/* 缓冲区从头重用；不清零会跳过开头一段。 */'],
  [982, 'c->request_started = 0;', '/* 让 writeHandler 重新选键并记录新的开始时间。 */'],
  [983, 'c->pending = config.pipeline * c->seqlen;', '/* 只算压测命令；prefix 命令不在复用轮次里重发。 */'],
  [985, 'createFileEvent(el, c->context->fd, AE_WRITABLE, writeHandler, c);', '/* 用包装函数：RDMA 下会立即回调一次 writeHandler。 */'],
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
fs.writeFileSync(`${DIR}/ins-p3.json`, JSON.stringify([{ file: 'src/valkey-benchmark.c', ops }], null, 1));

const OUT = `${DIR}/out-valkey-benchmark.json`;
const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
fs.writeFileSync(OUT, JSON.stringify(prev.concat(added), null, 1));
console.log(`P3 entries=${added.length} cumulative=${prev.length + added.length}`);
