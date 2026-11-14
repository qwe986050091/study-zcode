// B37 P6：rdmaServer / connRdmaIsLocal / connRdmaListen / connRdmaCloseListener / connRdmaAddr /
// rdmaInit / rdmaHasPendingData / rdmaProcessPendingData / postPoneUpdateRdmaState / updateRdmaState /
// CT_RDMA 表 / connectionTypeRdma / RegisterConnectionTypeRdma / 模块入口。
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/rdma.c';
const DIR = 'd:/code/_annot_baseline/VK-B37';
const PX = 'p6';

const E = [
  ['static int rdmaServer(char *err, int port, char *bindaddr, int af, rdma_listener *rdma_listener) {', '/* 起一个监听：建 CM 通道、绑定地址并 rdma_listen。 */'],
  ['int ret = ANET_OK, rv, afonly = 1;', '/* ret 控制返回，rv 承接 getaddrinfo，afonly 供 setsockopt。 */'],
  ['char _port[6];', '/* _port 6 字节够放 65535 加结尾符。 */'],
  ['struct sockaddr_storage sock_addr;', '/* sock_addr 统一承载 v4/v6 绑定地址。 */'],
  ['struct rdma_cm_id *listen_cmid = NULL;', '/* listen_cmid 失败时可能已建，error 分支判空销毁。 */'],
  ['struct rdma_event_channel *listen_channel = NULL;', '/* listen_channel 同上，失败时判空销毁。 */'],
  ['snprintf(_port, 6, "%d", port);', '/* 端口转字符串交给 getaddrinfo。 */'],
  ['memset(&hints, 0, sizeof(hints));', '/* hints 清零，未设字段必须为 0。 */'],
  ['hints.ai_family = af;', '/* af 由配置决定，AF_UNSPEC 表示两者都试。 */'],
  ['hints.ai_socktype = SOCK_STREAM;', '/* SOCK_STREAM 对应 RDMA_PS_TCP。 */'],
  ['hints.ai_flags = AI_PASSIVE;', '/* AI_PASSIVE 让 NULL 主机名绑定通配地址。 */'],
  ['if (bindaddr && !strcmp("*", bindaddr)) bindaddr = NULL;', '/* "*" 转成 NULL，交给 AI_PASSIVE 处理。 */'],
  ['if (af == AF_INET6 && bindaddr && !strcmp("::*", bindaddr)) bindaddr = NULL;', '/* "::*" 只对 v6 有意义，同样转 NULL。 */'],
  ['if ((rv = getaddrinfo(bindaddr, _port, &hints, &servinfo)) != 0) {', '/* 解析失败时 rv 是 gai 错误码而非 errno。 */'],
  ['serverRdmaError(err, "RDMA: %s", gai_strerror(rv));', '/* gai_strerror 才能翻译 rv。 */'],
  ['serverRdmaError(err, "RDMA: get addr info failed");', '/* 走到这里说明返回了空链表但无错误码。 */'],
  ['ret = ANET_ERR;', '/* 标记失败，统一在 end 释放 servinfo。 */'],
  ['listen_channel = rdma_create_event_channel();', '/* 监听专用的 CM 通道。 */'],
  ['if (!listen_channel) {', '/* 创建失败通常是 fd 耗尽。 */'],
  ['serverLog(LL_WARNING, "RDMA: create event channel failed");', '/* 打日志后走 error 释放。 */'],
  ['for (p = servinfo; p != NULL; p = p->ai_next) {', '/* 遍历解析结果，逐个尝试绑定。 */'],
  ['memset(&sock_addr, 0, sizeof(sock_addr));', '/* 每轮清零，避免上一轮残留地址。 */'],
  ['if (p->ai_family == AF_INET6) {', '/* v6 用 6 字节地址结构。 */'],
  ['memcpy(&sock_addr, p->ai_addr, sizeof(struct sockaddr_in6));', '/* 复制 v6 地址。 */'],
  ['((struct sockaddr_in6 *)&sock_addr)->sin6_family = AF_INET6;', '/* 显式写 family，rdma_bind_addr 依赖它。 */'],
  ['((struct sockaddr_in6 *)&sock_addr)->sin6_port = htons(port);', '/* 端口转网络序。 */'],
  ['memcpy(&sock_addr, p->ai_addr, sizeof(struct sockaddr_in));', '/* 其余按 v4 复制。 */'],
  ['((struct sockaddr_in *)&sock_addr)->sin_family = AF_INET;', '/* v4 family 必须显式写。 */'],
  ['((struct sockaddr_in *)&sock_addr)->sin_port = htons(port);', '/* v4 端口转网络序。 */'],
  ['if (rdma_create_id(listen_channel, &listen_cmid, NULL, RDMA_PS_TCP)) {', '/* 监听 cm_id 的 context 为 NULL，accept 时再填。 */'],
  ['serverRdmaError(err, "RDMA: create listen cm id error: %s", strerror(errno));', '/* 打印 errno，从失败轮次继续已无意义。 */'],
  ['rdma_set_option(listen_cmid, RDMA_OPTION_ID, RDMA_OPTION_ID_AFONLY, &afonly, sizeof(afonly));', '/* AFONLY 避免 v6 监听同时接受 v4 映射地址。 */'],
  ['if (rdma_bind_addr(listen_cmid, (struct sockaddr *)&sock_addr)) {', '/* 绑定失败说明端口被占或地址不可用。 */'],
  ['serverRdmaError(err, "RDMA: bind addr error: %s", strerror(errno));', '/* errno 区分 EADDRINUSE 与 EADDRNOTAVAIL。 */'],
  ['if (rdma_listen(listen_cmid, 0)) {', '/* backlog 传 0 用驱动默认值。 */'],
  ['serverRdmaError(err, "RDMA: listen addr error: %s", strerror(errno));', '/* 监听失败后 cm_id 由 error 销毁。 */'],
  ['rdma_listener->cm_id = listen_cmid;', '/* 成功则把 cm_id 交给 rdma_listeners[]。 */'],
  ['rdma_listener->cm_channel = listen_channel;', '/* 通道与 cm_id 同下标，close 时成对销毁。 */'],
  ['if (listen_cmid) rdma_destroy_id(listen_cmid);', '/* 判空销毁，可能在建 id 前就失败。 */'],
  ['if (listen_channel) rdma_destroy_event_channel(listen_channel);', '/* 判空销毁通道。 */'],
  ['freeaddrinfo(servinfo);', '/* servinfo 由 getaddrinfo 分配，必须配对释放。 */'],
  ['static int connRdmaIsLocal(connection *conn) {', '/* 判断对端与本地是否同一地址，供 unixsocket 语义复用。 */'],
  ['struct sockaddr *laddr = rdma_get_local_addr(rdma_conn->cm_id);', '/* 本端地址由 CM 维护。 */'],
  ['struct sockaddr *raddr = rdma_get_peer_addr(rdma_conn->cm_id);', '/* 对端地址同上。 */'],
  ['struct sockaddr_in *lsa4, *rsa4;', '/* v4 视图。 */'],
  ['struct sockaddr_in6 *lsa6, *rsa6;', '/* v6 视图。 */'],
  ['if (laddr->sa_family == AF_INET) {', '/* 按 family 选比较方式。 */'],
  ['lsa4 = (struct sockaddr_in *)laddr;', '/* 强转 v4 视图。 */'],
  ['rsa4 = (struct sockaddr_in *)raddr;', '/* 对端同样强转。 */'],
  ['return !memcmp(&lsa4->sin_addr, &rsa4->sin_addr, sizeof(lsa4->sin_addr));', '/* 只比 sin_addr，端口不参与。 */'],
  ['lsa6 = (struct sockaddr_in6 *)laddr;', '/* 其余按 v6 处理。 */'],
  ['rsa6 = (struct sockaddr_in6 *)raddr;', '/* 对端 v6 视图。 */'],
  ['return !memcmp(&lsa6->sin6_addr, &rsa6->sin6_addr, sizeof(lsa6->sin6_addr));', '/* 比较 16 字节地址。 */'],
  ['return -1;', '/* 非 v4/v6 返回 -1，调用方按「非本地」处理。 */'],
  ['int connRdmaListen(connListener *listener) {', '/* 按 bindaddr 列表逐个起监听，fd 存进 listener->fd[]。 */'],
  ['int j, ret;', '/* j 遍历 bindaddr，ret 承接 rdmaServer 结果。 */'],
  ['char **bindaddr = listener->bindaddr;', '/* bindaddr 可能来自配置文件。 */'],
  ['int bindaddr_count = listener->bindaddr_count;', '/* 计数为 0 时用默认地址。 */'],
  ['int port = listener->port;', '/* 端口由 listener 统一给出。 */'],
  ['char *default_bindaddr[2] = {"*", "-::*"};', '/* 默认同时监听 v4 与 v6，"-" 前缀表示可选。 */'],
  ['rdma_listener *rdma_listener;', '/* rdma_listener 指向当前下标的元素。 */'],
  ['assert(server.proto_max_bulk_len <= 512ll * 1024 * 1024);', '/* RDMA 单次写上限 512MB，超过则深度不够。 */'],
  ['bindaddr_count = 2;', '/* 未配置时用两个默认地址。 */'],
  ['bindaddr = default_bindaddr;', '/* 与 count 一起切换。 */'],
  ['rdma_listeners = rdma_listener = zcalloc_num(bindaddr_count, sizeof(*rdma_listener));', '/* 一次分配全部监听器，下标与 fd[] 对应。 */'],
  ['for (j = 0; j < bindaddr_count; j++) {', '/* 逐个地址起监听。 */'],
  ['char *addr = bindaddr[j];', '/* addr 指向当前地址字符串。 */'],
  ['int optional = *addr == \'-\';', '/* "-" 前缀表示该地址失败不算致命。 */'],
  ['if (optional) addr++;', '/* 跳过前缀再解析。 */'],
  ['if (strchr(addr, \':\')) {', '/* 含冒号说明是 v6 字面量。 */'],
  ['if (ret == ANET_ERR) {', '/* 只有非可选地址失败才整体失败。 */'],
  ['serverLog(LL_WARNING, "RDMA: Could not create server for %s:%d: %s", addr, port, server.neterr);', '/* 打印 addr 与 port 便于定位。 */'],
  ['int fd = rdma_listener->cm_channel->fd;', '/* 监听 fd 就是 CM 通道 fd。 */'],
  ['anetNonBlock(NULL, fd);', '/* 非阻塞是 ae 驱动的前提。 */'],
  ['anetCloexec(fd);', '/* CLOEXEC 防 fork 继承。 */'],
  ['listener->fd[listener->count++] = fd;', '/* 按顺序存入，rdmaFdToListener 依赖同下标。 */'],
  ['rdma_listener++;', '/* 指针后移，与 count 同步。 */'],
  ['rdma_config = listener->priv;', '/* 保存配置指针，读 rx_size/completion_vector。 */'],
  ['static void connRdmaCloseListener(connListener *listener) {', '/* 逆序关闭所有监听并释放数组。 */'],
  ['if (listener->fd[i] == -1) continue;', '/* -1 表示已关闭，跳过。 */'],
  ['aeDeleteFileEvent(server.el, listener->fd[i], AE_READABLE);', '/* 先摘 ae 事件，避免 close 后仍被 poll。 */'],
  ['listener->fd[i] = -1;', '/* 标记已关闭，函数可重入。 */'],
  ['struct rdma_listener *rdma_listener = &rdma_listeners[i];', '/* 同下标的监听器。 */'],
  ['rdma_destroy_id(rdma_listener->cm_id);', '/* 销毁 cm_id，内核会停止接受新连接。 */'],
  ['rdma_destroy_event_channel(rdma_listener->cm_channel);', '/* 通道最后销毁。 */'],
  ['listener->count = 0;', '/* 计数归零，避免后续遍历悬空 fd。 */'],
  ['zfree(rdma_listeners);', '/* 数组本身是 zcalloc_num 分配的。 */'],
  ['rdma_listeners = NULL;', '/* 置空防重入。 */'],
  ['rdma_config = NULL;', '/* 配置指针随监听器一起失效。 */'],
  ['static int connRdmaAddr(connection *conn, char *ip, size_t ip_len, int *port, int remote) {', '/* 取本地或对端地址，失败时写占位串。 */'],
  ['struct sockaddr_storage *ss = NULL;', '/* ss 指向 CM 内部地址，不拥有内存。 */'],
  ['struct sockaddr_in *sa4;', '/* v4 视图。 */'],
  ['struct sockaddr_in6 *sa6;', '/* v6 视图。 */'],
  ['if (remote)', '/* remote 为真取对端，否则取本端。 */'],
  ['ss = (struct sockaddr_storage *)rdma_get_peer_addr(cm_id);', '/* 对端地址。 */'],
  ['ss = (struct sockaddr_storage *)rdma_get_local_addr(cm_id);', '/* 本端地址。 */'],
  ['if (!ss) {', '/* 未建链时 CM 可能没有地址。 */'],
  ['goto error;', '/* 走占位串，调用方不感知失败细节。 */'],
  ['if (ss->ss_family == AF_INET) {', '/* v4 用 4 字节地址。 */'],
  ['sa4 = (struct sockaddr_in *)ss;', '/* 强转 v4 视图。 */'],
  ['if (ip) {', '/* ip 可为 NULL，表示只取端口。 */'],
  ['if (inet_ntop(AF_INET, (void *)&(sa4->sin_addr), ip, ip_len) == NULL) {', '/* 转换失败说明 ip_len 不足。 */'],
  ['if (port) {', '/* port 同样可省略。 */'],
  ['*port = ntohs(sa4->sin_port);', '/* 端口转主机序。 */'],
  ['sa6 = (struct sockaddr_in6 *)ss;', '/* 其余按 v6 处理。 */'],
  ['if (inet_ntop(AF_INET6, (void *)&(sa6->sin6_addr), ip, ip_len) == NULL) {', '/* v6 文本转换失败。 */'],
  ['*port = ntohs(sa6->sin6_port);', '/* v6 端口转主机序。 */'],
  ['return 0;', '/* 成功返回 0。 */'],
  ['error:', '/* error 统一写占位值，保证输出参数总有内容。 */'],
  ['if (ip) {', '/* 只有调用方要 ip 时才写。 */'],
  ['if (ip_len >= 2) {', '/* 至少 2 字节才能放 "?" 与结尾符。 */'],
  ['ip[0] = \'?\';', '/* 占位符表示地址不可得。 */'],
  ['ip[1] = \'\\0\';', '/* 显式结尾。 */'],
  ['ip[0] = \'\\0\';', '/* 缓冲区太小时只写空串。 */'],
  ['if (port) *port = 0;', '/* 端口用 0 表示未知。 */'],
  ['return -1;', '/* 返回 -1 让调用方区分「未知」与「真地址」。 */'],
  ['pending_list = listCreate();', '/* 待处理连接链，close 在此排队。 */'],
  ['page_size = sysconf(_SC_PAGESIZE);', '/* 页大小决定 RX 守护页对齐。 */'],
  ['VALKEY_BUILD_BUG_ON(sizeof(ValkeyRdmaFeature) != 32);', '/* 控制面协议依赖 32 字节定长，编译期拦住。 */'],
  ['VALKEY_BUILD_BUG_ON(sizeof(ValkeyRdmaKeepalive) != 32);', '/* 保活报文同样必须 32 字节。 */'],
  ['VALKEY_BUILD_BUG_ON(sizeof(ValkeyRdmaMemory) != 32);', '/* 内存注册报文必须 32 字节。 */'],
  ['VALKEY_BUILD_BUG_ON(sizeof(ValkeyRdmaCmd) != 32);', '/* 联合体大小必须 32 字节，收发按它裁剪。 */'],
  ['if (ibv_fork_init()) {', '/* 开启 fork 支持，否则子进程访问 MR 会 SIGSEGV。 */'],
  ['serverLog(LL_WARNING, "RDMA: FATAL error, ibv_fork_init failed");', '/* 失败只能告警：fork 场景不可用但不阻止启动。 */'],
  ['static int rdmaHasPendingData(void) {', '/* 主循环据此决定是否调用处理函数。 */'],
  ['if (!pending_list) return 0;', '/* 未初始化时视为无数据。 */'],
  ['return listLength(pending_list) > 0;', '/* 链非空即有连接等待关闭。 */'],
  ['listNode *ln;', '/* ln 指向当前待处理节点。 */'],
  ['int processed = 0;', '/* processed 统计本轮处理数，用于限流。 */'],
  ['while (remaining-- > 0 && (ln = listFirst(pending_list)) != NULL) {', '/* 每轮最多 remaining 个，避免拖住主循环。 */'],
  ['rdma_conn = listNodeValue(ln);', '/* 节点值就是连接。 */'],
  ['conn = &rdma_conn->c;', '/* 取基类指针。 */'],
  ['rdma_conn->pending_list_node = NULL;', '/* 先摘标记，后续重入队不会误删。 */'],
  ['callHandler(conn, conn->write_handler);', '/* 补发剩余数据。 */'],
  ['++processed;', '/* 计数加一。 */'],
  ['continue;', '/* 处理完继续下一个节点。 */'],
  ['listLinkNodeTail(pending_list, ln);', '/* 未关闭的连接挪到链尾，避免饿死。 */'],
  ['connRdmaEventHandler(NULL, -1, rdma_conn, 0);', '/* 手动驱动一次事件处理。 */'],
  ['return processed;', '/* 返回本轮处理数。 */'],
  ['static void postPoneUpdateRdmaState(struct connection *conn, int postpone_mask) {', '/* 推迟读写事件更新，直到 mask 清位。 */'],
  ['rdma_conn->postpone_mask = postpone_mask;', '/* 保存位掩码，eventHandler 按位判断。 */'],
  ['static void updateRdmaState(struct connection *conn) {', '/* 重新同步 ae 事件与读写状态。 */'],
  ['connRdmaSetRwHandler(conn);', '/* 先按 handler 重算事件注册。 */'],
  ['connRdmaEventHandler(NULL, -1, rdma_conn, 0);', '/* 再手动驱动一次收发。 */'],
  ['static ConnectionType CT_RDMA = {', '/* RDMA 的连接类型表，按函数指针挂载。 */'],
  ['static ConnectionType *ct_rdma = NULL;', '/* 缓存查表结果，避免每次都遍历。 */'],
  ['if (ct_rdma != NULL) return ct_rdma;', '/* 已缓存直接返回。 */'],
  ['ct_rdma = connectionByType(CONN_TYPE_RDMA);', '/* 首次查表。 */'],
  ['serverAssert(ct_rdma != NULL);', '/* 未注册说明启动顺序有 bug。 */'],
  ['return ct_rdma;', '/* 返回缓存指针。 */'],
  ['int RegisterConnectionTypeRdma(void) {', '/* Linux 下注册连接类型。 */'],
  ['return connTypeRegister(&CT_RDMA);', '/* 注册失败会在启动阶段报错。 */'],
  ['serverLog(LL_VERBOSE, "Connection type %s not builtin", getConnectionTypeName(CONN_TYPE_RDMA));', '/* 非 Linux 只打一条 VERBOSE，不阻断启动。 */'],
  ['int ValkeyModule_OnLoad(void *ctx, ValkeyModuleString **argv, int argc) {', '/* 模块模式下的加载入口。 */'],
  ['UNUSED(argv);', '/* 不解析参数。 */'],
  ['UNUSED(argc);', '/* 同上。 */'],
  ['serverLog(LL_NOTICE, "Connection type %s was not built together with the valkey-server used.", getConnectionTypeName(CONN_TYPE_RDMA));', '/* 未把 RDMA 编进 server 时拒绝加载。 */'],
  ['return VALKEYMODULE_ERR;', '/* 返回 ERR 让模块加载失败。 */'],
  ['ValkeyModule_SetModuleOptions(ctx, VALKEYMODULE_OPTIONS_HANDLE_REPL_ASYNC_LOAD', '/* 允许异步加载、槽迁移与无 fork 模式。 */'],
  ['if (connTypeRegister(&CT_RDMA) != C_OK) return VALKEYMODULE_ERR;', '/* 注册失败则加载失败。 */'],
  ['return VALKEYMODULE_OK;', '/* 加载成功。 */'],
  ['int ValkeyModule_OnUnload(void *arg) {', '/* 连接类型不支持卸载。 */'],
  ['UNUSED(arg);', '/* 形参未用。 */'],
  ['serverLog(LL_NOTICE, "Connection type %s cannot be unloaded", getConnectionTypeName(CONN_TYPE_RDMA));', '/* 明确拒绝，避免已建连接悬空。 */'],
  ['serverLog(LL_VERBOSE, "Connection type %s is supported on Linux only", getConnectionTypeName(CONN_TYPE_RDMA));', '/* 非 Linux 说明不支持的原因。 */'],
];

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const ops = [];
let cursor = lines.findIndex((l) => l.trim().startsWith('static int rdmaServer('));
if (cursor < 0) {
  console.error('rdmaServer not found');
  process.exit(2);
}
for (const [anchor, c] of E) {
  let found = -1;
  for (let i = cursor; i < lines.length; i++) {
    if (lines[i].trim().startsWith(anchor)) { found = i; break; }
  }
  if (found < 0) {
    console.error(`ANCHOR NOT FOUND ${anchor}`);
    process.exit(2);
  }
  const t = lines[found].trim();
  if (t.startsWith('/*') || t.startsWith('//') || /^\*\s/.test(t) || !t) {
    console.error(`BADANCHOR ${found + 1} ${t}`);
    process.exit(2);
  }
  ops.push({ line: found + 1, expect: t, lines: [c] });
  cursor = found + 1;
}
ops.sort((a, b) => b.line - a.line);
fs.writeFileSync(`${DIR}/ins-${PX}.json`, JSON.stringify([{ file: 'src/rdma.c', ops }], null, 1));

const out = `${DIR}/out-rdma.json`;
const prev = JSON.parse(fs.readFileSync(out, 'utf8'));
const entries = ops.map((o) => ({ line: o.line, c: o.lines }));
fs.writeFileSync(out, JSON.stringify([...prev, ...entries], null, 1));
console.log(`${PX} ops=${ops.length} entries=${prev.length + entries.length}`);
