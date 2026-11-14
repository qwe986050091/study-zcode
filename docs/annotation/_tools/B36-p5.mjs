// B36 P5：readHandler + awakenPausedClient。
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/valkey-benchmark.c';
const DIR = 'd:/code/_annot_baseline/VK-B36';

const E = [
  // ---- readHandler 主体 ----
  [1319, 'client c = privdata;', '/* 回调私有数据就是客户端指针；事件层不解释类型。 */'],
  [1320, 'void *reply = NULL;', '/* 每轮 valkeyGetReply 的出参；先置 NULL 以区分空回复。 */'],
  [1321, 'UNUSED(el);', '/* 事件循环参数在回调里用不到，显式丢弃避免 -Wunused。 */'],
  [1322, 'UNUSED(fd);', '/* fd 同样不用；连接状态都在 valkeyContext 里。 */'],
  [1323, 'UNUSED(mask);', '/* mask 也不看：可读事件只有一种处理路径。 */'],
  [1328, 'if (c->latency < 0) c->latency = ustime() - (c->start);', '/* latency<0 是“本轮未计”的哨兵；只在第一次可读时写入，避免重复计。 */'],
  [1330, 'if (valkeyBufferRead(c->context) != VALKEY_OK) {', '/* 先把内核缓冲读进 libvalkey；失败说明连接已坏，无法继续。 */'],
  [1331, 'fprintf(stderr, "Error: %s\\n", c->context->errstr);', '/* 打印 errstr 而不是 errno，libvalkey 已经把原因格式化。 */'],
  [1332, 'exit(1);', '/* 读错误直接终止：压测工具不尝试重连，否则统计混入断连。 */'],
  [1334, 'while (c->pending) {', '/* 一次事件里尽量把本轮回复收完，减少事件循环往返。 */'],
  [1335, 'if (valkeyGetReply(c->context, &reply) != VALKEY_OK) {', '/* 解析失败同样视为致命，errstr 带协议层原因。 */'],
  [1336, 'fprintf(stderr, "Error: %s\\n", c->context->errstr);', '/* 协议层错误打印到 stderr，便于复现。 */'],
  [1337, 'exit(1);', '/* 协议错不能靠重试修复，直接退出。 */'],
  [1339, 'if (reply != NULL) {', '/* NULL 表示回复还没收全，跳出等下一次可读。 */'],
  [1340, 'if (reply == (void *)VALKEY_REPLY_ERROR) {', '/* 这是 libvalkey 的 OOM 哨兵，不是业务错误。 */'],
  [1341, 'fprintf(stderr, "Unexpected error reply, exiting...\\n");', '/* 内存耗尽导致无法构造回复对象，只能提示后退出。 */'],
  [1342, 'exit(1);', '/* 哨兵回复无法继续解析。 */'],
  [1344, 'valkeyReply *r = reply;', '/* 转成具体类型；reply 是 void* 以便与哨兵比较。 */'],
  [1345, 'if (r->type == VALKEY_REPLY_ERROR) {', '/* 业务错误回复：只有集群拓扑类允许重试。 */'],
  [1351, 'if (c->cluster_node && c->staglen) {', '/* 有绑定节点且命令带 hashtag 才能定向重试。 */'],
  [1352, 'int fetch_slots = 0, do_wait = 0;', '/* 两个标记分别表示“要重拉槽表”和“先等集群自愈”。 */'],
  [1353, 'if (!strncmp(r->str, "MOVED", 5) || !strncmp(r->str, "ASK", 3))', '/* MOVED/ASK 是槽位迁移，重拉一次即可。 */'],
  [1354, 'fetch_slots = 1;', '/* 置位后走 fetchClusterSlotsConfiguration 重拉。 */'],
  [1355, 'else if (!strncmp(r->str, "CLUSTERDOWN", 11)) {', '/* CLUSTERDOWN 通常是暂时状态，需要等一秒再拉。 */'],
  [1359, 'fetch_slots = 1;', '/* 仍然要重拉槽表。 */'],
  [1360, 'do_wait = 1;', '/* 额外标记先 sleep，给集群自愈时间。 */'],
  [1361, 'fprintf(stderr, "Error from server %s:%d: %s.\\n", c->cluster_node->ip,', '/* 打印出错节点与原始错误，便于定位。 */'],
  [1364, 'if (do_wait) sleep(1);', '/* 只对 CLUSTERDOWN 生效；MOVED/ASK 立即重试。 */'],
  [1365, 'if (fetch_slots && !fetchClusterSlotsConfiguration(c)) exit(1);', '/* 重拉失败就无法继续定向，退出。 */'],
  [1367, 'if (c->cluster_node) {', '/* 没有 hashtag 时仍尽量打印节点信息。 */'],
  [1368, 'fprintf(stderr, "Error from server %s:%d: %s\\n", c->cluster_node->ip, c->cluster_node->port,', '/* 带 ip:port 的错误信息，便于定位坏节点。 */'],
  [1371, 'fprintf(stderr, "Error from server: %s\\n", r->str);', '/* 连节点都没有时只打印错误串。 */'],
  [1372, 'exit(1);', '/* 非拓扑错误直接退出，避免错误率污染报告。 */'],
  [1376, 'freeReplyObject(reply);', '/* 回复已处理完，立即释放；下面只用 c。 */'],
  [1378, 'if (c->prefix_pending > 0) {', '/* 前缀命令的回复单独计数，不计入压测请求。 */'],
  [1379, 'c->prefix_pending--;', '/* 前缀回复收一条少一条。 */'],
  [1380, 'c->pending--;', '/* pending 里也包含前缀命令，必须同步减。 */'],
  [1382, 'if (c->prefixlen > 0) {', '/* 只在首条前缀回复时裁剪 obuf，之后 prefixlen 已清零。 */'],
  [1383, 'size_t j;', '/* 循环变量提前声明，C89 风格。 */'],
  [1384, 'sdsrange(c->obuf, c->prefixlen, -1);', '/* 把前缀从缓冲区头部裁掉，后续命令从 0 开始。 */'],
  [1386, 'for (j = 0; j < c->staglen; j++) c->stagptr[j] -= c->prefixlen;', '/* 缓冲区左移后 hashtag 指针必须同步左移，否则覆写位置偏移。 */'],
  [1387, 'c->prefixlen = 0;', '/* 清零防止重复裁剪。 */'],
  [1389, 'continue;', '/* 前缀回复处理完，继续收下一条，不做延迟统计。 */'],
  [1391, 'int requests_finished = addRequestFinished();', '/* 每个非前缀回复计一次完成。 */'],
  [1392, 'if (!isBenchmarkFinished(requests_finished)) {', '/* 已结束就不记录延迟，避免停机瞬间的样本污染分布。 */'],
  [1393, 'if (config.num_threads == 0) {', '/* 单线程直接用全局直方图，没有争用。 */'],
  [1394, 'hdr_record_value(config.latency_histogram, // Histogram to record to', '/* 记录总延迟，超过上限的样本钳到 CONFIG_LATENCY_HISTOGRAM_MAX_VALUE。 */'],
  [1398, 'hdr_record_value(config.current_sec_latency_histogram,      // Histogram to record to', '/* 同时记录每秒直方图，上界用 INSTANT_MAX_VALUE。 */'],
  [1403, 'benchmarkThread *thread = config.threads[c->thread_id];', '/* 多线程取本线程的直方图，避免跨线程写。 */'],
  [1404, 'hdr_record_value(thread->latency_histogram, // Histogram to record to', '/* 本线程总延迟；与单线程路径的钳位逻辑一致。 */'],
  [1408, 'hdr_record_value(thread->current_sec_latency_histogram,     // Histogram to record to', '/* 本线程每秒直方图，showThroughput 每秒汇总。 */'],
  [1414, 'c->pending--;', '/* 一条回复消费掉一个在途请求。 */'],
  [1415, 'if (c->pending == 0) {', '/* 本轮收完，进入复用或补连接。 */'],
  [1416, 'clientDone(c);', '/* 可能 resetClient 也可能 freeClient。 */'],
  [1417, 'break;', '/* 客户端可能已被释放，必须立即跳出循环。 */'],
  [1420, 'break;', '/* reply 为 NULL，等下一次可读事件。 */'],

  // ---- awakenPausedClient 主体 ----
  [1447, 'UNUSED(id);', '/* 定时器 id 不用；同一 loop 上可能有多个时间事件。 */'],
  [1448, 'benchmarkThread *thread = (benchmarkThread *)clientData;', '/* clientData 由创建者决定：NULL 表示主线程全局表。 */'],
  [1450, 'list *paused_clients = NULL;', '/* 统一成一个指针，后面遍历不用再分支。 */'],
  [1451, 'if (thread == NULL) {', '/* 主线程模式：暂停表挂在 config 上。 */'],
  [1452, 'paused_clients = config.paused_clients;', '/* 取全局暂停表。 */'],
  [1454, 'paused_clients = thread->paused_clients;', '/* 多线程模式：只处理本线程的客户端，避免跨线程锁。 */'],
  [1457, 'listIter li;', '/* 迭代器；listNext 会在遍历中安全地继续。 */'],
  [1458, 'listNode *ln;', '/* 当前节点，循环条件里赋值。 */'],
  [1459, 'long long delay = 0;', '/* 0 表示全部唤醒完；非 0 是下一次的建议延迟。 */'],
  [1460, 'listRewind(paused_clients, &li);', '/* 从表头开始，保证 FIFO 顺序。 */'],
  [1461, 'while ((ln = listNext(&li)) != NULL) {', '/* 逐个尝试；失败就 break，剩下的留到下次。 */'],
  [1462, 'client c = ln->value;', '/* 节点里存的就是 client 指针。 */'],
  [1463, 'delay = acquireTokenOrWait(config.pipeline);', '/* 一次取 pipeline 个令牌，与发送量对应。 */'],
  [1464, 'if (delay) {', '/* 拿不到令牌：本客户端继续暂停。 */'],
  [1465, 'break;', '/* 立刻停止，不跳过它去试后面，否则 FIFO 被打乱。 */'],
  [1468, 'c->paused = 0;', '/* 已恢复运行，后续 freeClient 不会再尝试摘链。 */'],
  [1469, 'c->reuse = 1;', '/* 告诉 writeHandler 这是续传，不要重新扣令牌或换键。 */'],
  [1474, 'createFileEvent(eventLoop, c->context->fd, AE_WRITABLE, writeHandler, c);', '/* 用包装函数注册可写；RDMA 下还需要立即 kick 一次。 */'],
  [1475, 'listDelNode(paused_clients, ln);', '/* 从暂停表摘除；不摘会下次重复唤醒。 */'],
  [1479, 'if (delay == 0) {', '/* 没有剩余等待者。 */'],
  [1480, 'return AE_NOMORE;', '/* 返回 AE_NOMORE 让 ae 删除该时间事件。 */'],
  [1482, 'return delay;', '/* 还有等待者，按建议毫秒数重新调度。 */'],
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
fs.writeFileSync(`${DIR}/ins-p5.json`, JSON.stringify([{ file: 'src/valkey-benchmark.c', ops }], null, 1));

const OUT = `${DIR}/out-valkey-benchmark.json`;
const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
fs.writeFileSync(OUT, JSON.stringify(prev.concat(added), null, 1));
console.log(`P5 entries=${added.length} cumulative=${prev.length + added.length}`);
