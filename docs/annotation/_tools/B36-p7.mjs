// B36 P7：createClient 主体 + createMissingClients 主体。
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/valkey-benchmark.c';
const DIR = 'd:/code/_annot_baseline/VK-B36';

const E = [
  [1802, 'int is_cluster_client = (config.cluster_mode && thread_id >= 0);', '/* 集群模式且在线程内才做节点绑定；主线程控制连接走单机路径。 */'],
  [1803, 'client c = zmalloc(sizeof(struct _client));', '/* zmalloc 失败 abort；c 一定非空。 */'],
  [1805, 'const char *ip = NULL;', '/* ip 先置空，下面按是否集群分别填。 */'],
  [1806, 'int port = 0;', '/* port 0 只是初始化占位。 */'],
  [1807, 'struct timeval tv = {0};', '/* 全 0 的 tv 传给 connect，表示不使用额外超时。 */'],
  [1808, 'c->cluster_node = NULL;', '/* 单机客户端没有节点；集群路径里再填。 */'],
  [1810, 'if (!is_cluster_client) {', '/* 非集群客户端连 config.conn_info 指定的地址。 */'],
  [1811, 'ip = config.conn_info.hostip;', '/* 主机直接来自命令行。 */'],
  [1812, 'port = config.conn_info.hostport;', '/* 端口同理。 */'],
  [1814, 'int node_idx = 0;', '/* 集群模式：按轮转选一个节点，分散连接压力。 */'],
  [1815, 'if (config.num_threads < config.cluster_node_count)', '/* 线程数少于节点数时按 liveclients 轮转，避免某些节点没有连接。 */'],
  [1816, 'node_idx = config.liveclients % config.cluster_node_count;', '/* 取模得到节点下标。 */'],
  [1818, 'node_idx = thread_id % config.cluster_node_count;', '/* 线程数足够时按线程号固定分配，线程与节点近似一一对应。 */'],
  [1819, 'clusterNode *node = config.cluster_nodes[node_idx];', '/* 取节点指针；下面断言非空。 */'],
  [1820, 'assert(node != NULL);', '/* 节点表由 CLUSTER SLOTS 重建，理论上无空洞，断言防御。 */'],
  [1821, 'ip = (const char *)node->ip;', '/* connect 用节点自己的地址。 */'],
  [1822, 'port = node->port;', '/* 端口同样来自节点。 */'],
  [1823, 'c->cluster_node = node;', '/* 记到 client 上，错误重试与 slot 更新都要用。 */'],
  [1826, 'c->context = valkeyConnectWrapper(config.ct, ip, port, tv, 1, config.mptcp);', '/* 建连；失败信息在 context->err 里，不在这里判返回 NULL。 */'],
  [1827, 'if (c->context->err) {', '/* libvalkey 用 err 字段报告 connect 失败。 */'],
  [1828, 'fprintf(stderr, "Could not connect to server at ");', '/* 先打印不带地址的前缀，下面按连接类型补全。 */'],
  [1829, 'if (config.ct != VALKEY_CONN_UNIX || is_cluster_client)', '/* unix 且非集群时没有 host:port 语义。 */'],
  [1830, 'fprintf(stderr, "%s:%d: %s\\n", ip, port, c->context->errstr);', '/* tcp 或集群打印 ip:port 与错误串。 */'],
  [1832, 'fprintf(stderr, "%s: %s\\n", ip, c->context->errstr);', '/* unix 只打印路径与错误串。 */'],
  [1833, 'exit(1);', '/* 建连失败直接退出：压测不允许半连接状态。 */'],
  [1835, 'if (config.tls == 1) {', '/* 只有显式开启 TLS 才握手。 */'],
  [1836, 'const char *err = NULL;', '/* err 由 cliSecureConnection 填，失败时打印原因。 */'],
  [1837, 'if (cliSecureConnection(c->context, config.sslconfig, &err) == VALKEY_ERR && err) {', '/* 返回 VALKEY_ERR 且 err 非空才是真正的握手失败。 */'],
  [1838, 'fprintf(stderr, "Could not negotiate a TLS connection: %s\\n", err);', '/* 打印 TLS 错误。 */'],
  [1839, 'exit(1);', '/* 握手失败退出，避免后续命令以明文发送。 */'],
  [1842, 'c->paused = 0;', '/* 新客户端不暂停。 */'],
  [1843, 'c->reuse = 0;', '/* 新客户端不是续传。 */'],
  [1844, 'c->request_started = 0;', '/* 请求尚未开始，writeHandler 首轮会定稿内容。 */'],
  [1845, 'c->thread_id = thread_id;', '/* 记录线程归属，事件循环与统计都靠它。 */'],
  [1847, 'c->context->reader->maxbuf = 0;', '/* maxbuf=0 关掉读缓冲收缩，压测只追求速度，避免反复 realloc。 */'],
  [1852, 'c->obuf = sdsempty();', '/* 请求缓冲从空 sds 开始，后面按前缀与正文追加。 */'],
  [1856, 'c->prefix_pending = 0;', '/* 前缀命令计数清零，AUTH/SELECT/HELLO 每加一条就加一。 */'],
  [1857, 'if (config.conn_info.auth) {', '/* 有密码才加 AUTH。 */'],
  [1858, 'char *buf = NULL;', '/* buf 由 valkeyFormatCommand 分配，需要 free。 */'],
  [1859, 'int len;', '/* len 是格式化后的字节数。 */'],
  [1860, 'if (config.conn_info.user == NULL)', '/* 没有用户名时用单参数 AUTH。 */'],
  [1861, 'len = valkeyFormatCommand(&buf, "AUTH %s", config.conn_info.auth);', '/* 老式 AUTH password。 */'],
  [1863, 'len = valkeyFormatCommand(&buf, "AUTH %s %s", config.conn_info.user, config.conn_info.auth);', '/* 有用户名时用 ACL 双参数 AUTH。 */'],
  [1864, 'c->obuf = sdscatlen(c->obuf, buf, len);', '/* 追加到缓冲；sdscatlen 可能重分配。 */'],
  [1865, 'free(buf);', '/* 释放格式化缓冲。 */'],
  [1866, 'c->prefix_pending++;', '/* 前缀计数加一，readHandler 靠它跳过前缀回复。 */'],
  [1869, 'if (config.enable_tracking) {', '/* 启用客户端缓存追踪时下发 CLIENT TRACKING。 */'],
  [1871, 'int len = valkeyFormatCommand(&buf, "CLIENT TRACKING on");', '/* 命令固定，不需要参数检查。 */'],
  [1872, 'c->obuf = sdscatlen(c->obuf, buf, len);', '/* 追加到前缀。 */'],
  [1873, 'free(buf);', '/* 释放临时缓冲。 */'],
  [1874, 'c->prefix_pending++;', '/* 前缀计数加一。 */'],
  [1881, 'if (config.conn_info.input_dbnum) {', '/* 选了非 0 号库才需要 SELECT。 */'],
  [1882, 'c->obuf = sdscatprintf(c->obuf, "*2\\r\\n$6\\r\\nSELECT\\r\\n$%d\\r\\n%s\\r\\n", (int)sdslen(config.input_dbnumstr),', '/* 手工拼 RESP，避免再走 valkeyFormatCommand 的临时分配。 */'],
  [1884, 'c->prefix_pending++;', '/* 前缀计数加一。 */'],
  [1887, 'if (config.resp3) {', '/* RESP3 用 HELLO 3 切换协议。 */'],
  [1889, 'int len = valkeyFormatCommand(&buf, "HELLO 3");', '/* HELLO 3 必须在 AUTH 之后、业务命令之前。 */'],
  [1890, 'c->obuf = sdscatlen(c->obuf, buf, len);', '/* 追加到前缀。 */'],
  [1891, 'free(buf);', '/* 释放临时缓冲。 */'],
  [1892, 'c->prefix_pending++;', '/* 前缀计数加一。 */'],
  [1895, 'if (config.cluster_mode && (config.read_from_replica == FROM_REPLICA_ONLY || config.read_from_replica == FROM_ALL)) {', '/* 副本读取需要 READONLY 才有权限。 */'],
  [1898, 'len = valkeyFormatCommand(&buf, "READONLY");', '/* 固定命令。 */'],
  [1899, 'c->obuf = sdscatlen(c->obuf, buf, len);', '/* 追加到前缀。 */'],
  [1900, 'free(buf);', '/* 释放临时缓冲。 */'],
  [1901, 'c->prefix_pending++;', '/* 前缀计数加一。 */'],
  [1904, 'c->prefixlen = sdslen(c->obuf);', '/* 前缀长度定稿；后续 readHandler 用它裁剪缓冲区。 */'],
  [1906, 'if (from) {', '/* 有 from 模板就整段复制正文，保证占位符偏移一致。 */'],
  [1907, 'c->obuf = sdscatlen(c->obuf, from->obuf + from->prefixlen, sdslen(from->obuf) - from->prefixlen);', '/* 只复制 from 的正文部分，跳过它的前缀。 */'],
  [1908, 'seqlen = from->seqlen;', '/* 沿用模板的序列长度。 */'],
  [1910, 'for (int j = 0; j < config.pipeline; j++) c->obuf = sdscatlen(c->obuf, cmd, len);', '/* 没有模板就按 pipeline 重复 cmd。 */'],
  [1913, 'c->written = 0;', '/* 新客户端还没写任何字节。 */'],
  [1914, 'c->seqlen = seqlen;', '/* 序列长度记录到 client。 */'],
  [1915, 'c->pending = config.pipeline * seqlen + c->prefix_pending;', '/* pending 包含前缀回复，readHandler 才能等齐。 */'],
  [1916, 'c->stagptr = NULL;', '/* hashtag 指针数组延迟到需要时分配。 */'],
  [1917, 'c->staglen = 0;', '/* 已登记数量清零。 */'],
  [1920, 'if (config.cluster_mode) {', '/* 集群模式才需要维护 hashtag 指针。 */'],
  [1921, 'if (from) {', '/* 从模板克隆时复制指针表。 */'],
  [1922, 'c->staglen = from->staglen;', '/* 数量直接继承。 */'],
  [1923, 'c->stagfree = 0;', '/* 容量恰好等于已用，下一次登记会触发扩容。 */'],
  [1924, 'c->stagptr = zmalloc(sizeof(char *) * c->staglen);', '/* 分配与模板等长的指针数组。 */'],
  [1926, 'for (size_t j = 0; j < c->staglen; j++) {', '/* 逐个换算到新缓冲区的绝对地址。 */'],
  [1927, 'c->stagptr[j] = c->obuf + (from->stagptr[j] - from->obuf);', '/* 相对偏移不变，基址换成新 obuf。 */'],
  [1929, 'c->stagptr[j] += c->prefixlen - from->prefixlen;', '/* 前缀长度不同时修正偏移。 */'],
  [1932, 'c->stagfree = RANDPTR_INITIAL_SIZE;', '/* 初始容量用 8，与 RANDPTR_INITIAL_SIZE 一致。 */'],
  [1933, 'c->stagptr = zmalloc(sizeof(char *) * c->stagfree);', '/* 分配指针数组。 */'],
  [1934, 'scanClusterTags(c, c->obuf);', '/* 扫描 {tag} 并登记。 */'],
  [1937, 'aeEventLoop *el = NULL;', '/* 按线程归属选事件循环。 */'],
  [1938, 'if (thread_id < 0)', '/* 主线程用全局 loop。 */'],
  [1939, 'el = config.el;', '/* 直接取 config.el。 */'],
  [1941, 'benchmarkThread *thread = config.threads[thread_id];', '/* 线程内客户端取所属线程的 loop。 */'],
  [1942, 'el = thread->el;', '/* 记录 loop 指针。 */'],
  [1944, 'if (config.idlemode == 0) {', '/* 正常模式注册可写，触发首轮发送。 */'],
  [1945, 'createFileEvent(el, c->context->fd, AE_WRITABLE, writeHandler, c);', '/* 用包装函数：RDMA 下立即回调一次。 */'],
  [1947, '/* In idle mode, clients still need to register readHandler for catching errors */', '/* idle 模式也要注册可读，用来捕获服务端断连。 */'],
  [1948, 'aeCreateFileEvent(el, c->context->fd, AE_READABLE, readHandler, c);', '/* 只注册可读。 */'],
  [1950, 'listAddNodeTail(config.clients, c);', '/* 登记到全局链表，freeClient 靠它摘链。 */'],
  [1951, 'atomic_fetch_add_explicit(&config.liveclients, 1, memory_order_relaxed);', '/* liveclients 原子加一；createMissingClients 的循环条件依赖它。 */'],
  [1953, 'c->slots_last_update = atomic_load_explicit(&config.slots_last_update, memory_order_relaxed);', '/* 记录当前槽表版本，供后续比对。 */'],
  [1954, 'return c;', '/* 返回给调用方；所有权已转给全局链表。 */'],

  // ---- createMissingClients 主体 ----
  [1965, 'int n = 0;', '/* n 统计本批已建连接数，用于节流。 */'],
  [1966, 'while (config.liveclients < config.numclients) {', '/* 连接数没到目标就继续补。 */'],
  [1967, 'int thread_id = -1;', '/* thread_id -1 表示主线程。 */'],
  [1968, 'if (config.num_threads) thread_id = config.liveclients % config.num_threads;', '/* 多线程按 liveclients 轮转，连接在线程间近似均匀。 */'],
  [1969, 'createClient(NULL, 0, 0, c, thread_id);', '/* 以 c 为模板创建；NULL cmd 表示复制模板正文。 */'],
  [1972, 'if (++n > 64) {', '/* 每 64 个连接休眠一次，避免 backlog 溢出。 */'],
  [1973, 'usleep(50000);', '/* 50ms 足够内核 accept 一批 SYN。 */'],
  [1974, 'n = 0;', '/* 计数归零，进入下一批。 */'],
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
fs.writeFileSync(`${DIR}/ins-p7.json`, JSON.stringify([{ file: 'src/valkey-benchmark.c', ops }], null, 1));

const OUT = `${DIR}/out-valkey-benchmark.json`;
const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
fs.writeFileSync(OUT, JSON.stringify(prev.concat(added), null, 1));
console.log(`P7 entries=${added.length} cumulative=${prev.length + added.length}`);
