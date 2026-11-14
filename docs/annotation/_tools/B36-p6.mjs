// B36 P6：writeHandler 主体（限速准入 / 请求定稿 / 部分写）。
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/valkey-benchmark.c';
const DIR = 'd:/code/_annot_baseline/VK-B36';

const E = [
  [1587, 'client c = privdata;', '/* privdata 就是 client；下面所有状态都在 c 上。 */'],
  [1588, 'UNUSED(el);', '/* 这里标 UNUSED 但下面仍用 el 注册与删除事件，宏只吞警告，不影响使用。 */'],
  [1589, 'UNUSED(fd);', '/* fd 确实不用；连接 fd 从 c->context 取。 */'],
  [1590, 'UNUSED(mask);', '/* mask 不看：可写回调语义固定。 */'],
  [1593, 'if (config.rps > 0 && c->reuse == 0 && !c->request_started) {', '/* 只有开启限速、非续传、且是新请求时才需要令牌。 */'],
  [1595, 'long long delay = acquireTokenOrWait(config.pipeline);', '/* 尝试取令牌；返回非 0 表示需要等待。 */'],
  [1597, 'if (delay) {', '/* delay 非 0：把客户端挂起，等定时器唤醒。 */'],
  [1598, 'int thread_id = c->thread_id;', '/* 先记住线程下标，后面选暂停表要用。 */'],
  [1599, 'int paused_clients_count = 0;', '/* 入队前的表长，决定是否需要新建定时器。 */'],
  [1601, 'c->paused = 1;', '/* 标记暂停；freeClient 会据此摘链。 */'],
  [1602, 'aeDeleteFileEvent(el, c->context->fd, AE_WRITABLE);', '/* 先摘可写事件，避免同一个 fd 反复触发回调。 */'],
  [1604, 'benchmarkThread *thread = NULL;', '/* 传给时间事件的 clientData；NULL 表示主线程。 */'],
  [1605, 'if (thread_id < 0) {', '/* thread_id < 0 是主线程客户端，用全局暂停表。 */'],
  [1606, 'paused_clients_count = listLength(config.paused_clients);', '/* 先取表长，0 说明这是第一个等待者。 */'],
  [1607, 'listAddNodeTail(config.paused_clients, c);', '/* 尾插保持 FIFO。 */'],
  [1609, 'thread = config.threads[thread_id];', '/* 多线程取所属线程。 */'],
  [1610, 'paused_clients_count = listLength(thread->paused_clients);', '/* 同上，判断线程表是否为空。 */'],
  [1611, 'listAddNodeTail(thread->paused_clients, c);', '/* 挂到线程自己的表。 */'],
  [1613, 'if (paused_clients_count == 0) {', '/* 只有第一个等待者负责建定时器。 */'],
  [1615, 'aeCreateTimeEvent(el, delay, awakenPausedClient, (void *)thread, NULL);', '/* 一个定时器批量唤醒，避免 N 个客户端各注册一个 1ms 事件。 */'],
  [1617, 'return;', '/* 挂起后本轮结束，等定时器唤醒。 */'],
  [1620, 'c->reuse = 0;', '/* 续传标记只对一次回调有效，进来就清掉。 */'],
  [1625, 'if (!c->request_started) {', '/* 缓冲区内容只在首轮定稿；EAGAIN 重入不能改内容。 */'],
  [1627, 'int requests_issued = atomic_fetch_add_explicit(&config.requests_issued,', '/* 先预扣 pipeline*seqlen，多线程下总量才不会超发。 */'],
  [1630, 'if (isBenchmarkFinished(requests_issued)) {', '/* 预扣后已超上限就不发，直接返回。 */'],
  [1631, 'return;', '/* 不写任何字节；稍后由结束条件停 loop。 */'],
  [1635, 'if (config.has_field_placeholders && config.current_dataset && config.current_dataset->record_count > 0) {', '/* dataset 模式且确实有记录才走重建路径。 */'],
  [1636, 'static _Atomic uint64_t record_counter = 0;', '/* 全局行号游标；取模后多线程分到不同记录。 */'],
  [1639, 'sdssetlen(c->obuf, c->prefixlen);', '/* 清空正文但保留前缀（AUTH/SELECT）。 */'],
  [1640, 'for (int p = 0; p < config.pipeline; p++) {', '/* 每条命令单独生成，槽位才能各不相同。 */'],
  [1641, 'uint64_t record_index = atomic_fetch_add_explicit(&record_counter, 1, memory_order_relaxed) % config.current_dataset->record_count;', '/* 原子取行号再取模，保证不重复且顺序随机。 */'],
  [1642, 'sds complete_cmd = datasetGenerateCommand(config.current_dataset, record_index,', '/* 生成一条完整命令；返回的 sds 由调用方释放。 */'],
  [1646, 'c->obuf = sdscatlen(c->obuf, complete_cmd, sdslen(complete_cmd));', '/* 追加到正文；sdscatlen 可能重分配，必须接返回值。 */'],
  [1647, 'sdsfree(complete_cmd);', '/* 内容已复制，立即释放临时命令。 */'],
  [1651, 'if (config.cluster_mode && c->stagptr) {', '/* 只有曾经扫到过 {tag} 才需要重新定位。 */'],
  [1652, 'scanClusterTags(c, c->obuf + c->prefixlen);', '/* 从正文起点重扫，前缀里的花括号不算。 */'],
  [1656, 'if (config.replace_placeholders) {', '/* 普通模式只做占位符覆写，不重建缓冲。 */'],
  [1657, 'replacePlaceholders(c->obuf + c->prefixlen, config.pipeline);', '/* 从正文起点替换，跳过前缀。 */'],
  [1661, 'if (config.cluster_mode && c->staglen > 0) setClusterKeyHashTag(c);', '/* 有 hashtag 才需要写 tag。 */'],
  [1662, 'c->slots_last_update = atomic_load_explicit(&config.slots_last_update, memory_order_relaxed);', '/* 记录本轮看到的槽表版本，供后续比对。 */'],
  [1663, 'c->start = ustime();', '/* 真正开始计时；放在编码完成之后。 */'],
  [1664, 'c->latency = -1;', '/* -1 是“尚未收到回复”的哨兵，readHandler 据此只计一次。 */'],
  [1665, 'c->request_started = 1;', '/* 内容已定稿，后续重入不再改缓冲。 */'],
  [1667, 'const ssize_t buflen = sdslen(c->obuf);', '/* 总长度只取一次，循环里不再读 sds 头。 */'],
  [1668, 'const ssize_t writeLen = buflen - c->written;', '/* 只写未写部分；written 是上次成功的字节数。 */'],
  [1669, 'if (writeLen > 0) {', '/* 已经全写完就直接落到函数尾，什么都不做。 */'],
  [1670, 'void *ptr = c->obuf + c->written;', '/* 写入起点随 written 前进。 */'],
  [1671, 'while (1) {', '/* 先尝试写，拿到 EAGAIN 再退出，不在这里自旋。 */'],
  [1674, 'const ssize_t nwritten = cliWriteConn(c->context, ptr, writeLen);', '/* 一次写调用；返回 0 表示 would-block。 */'],
  [1675, 'if (nwritten == writeLen) {', '/* 全写完，切换到读回复。 */'],
  [1676, 'aeDeleteFileEvent(el, c->context->fd, AE_WRITABLE);', '/* 摘掉可写，避免空转。 */'],
  [1677, 'createFileEvent(el, c->context->fd, AE_READABLE, readHandler, c);', '/* 注册可读等回复。 */'],
  [1678, 'return;', '/* 本轮写完。 */'],
  [1681, 'if (nwritten > 0) {', '/* 部分写：记下进度，等下次可写继续。 */'],
  [1682, 'c->written += nwritten;', '/* 累加已写字节；漏加会重发同一段。 */'],
  [1683, 'return;', '/* 保留 AE_WRITABLE，让事件循环再次回调。 */'],
  [1686, 'if (nwritten == -1 && errno != EAGAIN) {', '/* 真错误（非 would-block）才需要处理。 */'],
  [1687, 'if (errno != EPIPE) fprintf(stderr, "Error writing to the server: %s\\n", strerror(errno));', '/* EPIPE 是服务端先关连接，静默处理避免刷屏。 */'],
  [1688, 'freeClient(c);', '/* 连接已坏，直接释放客户端。 */'],
  [1689, 'return;', '/* 客户端已释放，不能再访问。 */'],
  [1695, 'return;', '/* would-block：保留事件立即返回，自旋会占死工作线程。 */'],
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
fs.writeFileSync(`${DIR}/ins-p6.json`, JSON.stringify([{ file: 'src/valkey-benchmark.c', ops }], null, 1));

const OUT = `${DIR}/out-valkey-benchmark.json`;
const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
fs.writeFileSync(OUT, JSON.stringify(prev.concat(added), null, 1));
console.log(`P6 entries=${added.length} cumulative=${prev.length + added.length}`);
