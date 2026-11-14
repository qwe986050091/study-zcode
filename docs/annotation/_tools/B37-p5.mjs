// B37 P5：connRdmaSend / connRdmaWrite / connRdmaWritev / rdmaRead / connRdmaRead /
// connRdmaSyncWrite / connRdmaSyncRead / connRdmaSyncReadLine / connRdmaGetType。
// 用锚点顺序查找（前一片插入后行号已漂移），避免手抄行号。
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/rdma.c';
const DIR = 'd:/code/_annot_baseline/VK-B37';
const PX = 'p5';

const E = [
  ['rdma_connection *rdma_conn = (rdma_connection *)conn;', '/* 强转回 rdma_connection 以取 cm_id。 */'],
  ['struct rdma_cm_id *cm_id = rdma_conn->cm_id;', '/* cm_id 是 TX 的目标 QP。 */'],
  ['struct ibv_send_wr send_wr, *bad_wr;', '/* send_wr 与 bad_wr 用于 post。 */'],
  ['struct ibv_sge sge;', '/* 单 sge 描述本次要写的用户数据。 */'],
  ['uint32_t off = ctx->tx.offset;', '/* off 是当前写偏移，决定 memcpy 目标与远端地址。 */'],
  ['char *addr = ctx->tx.addr + off;', '/* addr 是本端 TX 内的目标位置。 */'],
  ['char *remote_addr = ctx->tx_addr + ctx->tx.offset;', '/* remote_addr 必须与 off 同步推进，否则覆盖对端同一段。 */'],
  ['int ret;', '/* ret 承接 ibv_post_send 返回值。 */'],
  ['if (connRdmaAllowCommand()) {', '/* fork 子进程或断链时禁止写。 */'],
  ['return C_ERR;', '/* 返回 C_ERR，上层不会推进 tx.offset。 */'],
  ['memcpy(addr, data, data_len);', '/* 先拷进注册内存，HCA 只能从这里读。 */'],
  ['sge.addr = (uint64_t)(uintptr_t)addr;', '/* sge.addr 指向 TX 内偏移。 */'],
  ['sge.lkey = ctx->tx.mr->lkey;', '/* lkey 用 tx.mr 的本端键。 */'],
  ['sge.length = data_len;', '/* 长度是本次 data_len，不是整块 TX。 */'],
  ['send_wr.sg_list = &sge;', '/* 单段 sg_list。 */'],
  ['send_wr.num_sge = 1;', '/* num_sge=1，语义上一次写连续区。 */'],
  ['send_wr.opcode = IBV_WR_RDMA_WRITE_WITH_IMM;', '/* RDMA_WRITE_WITH_IMM 让对端收到 RX 并触发完成事件。 */'],
  ['send_wr.send_flags = (++ctx->tx_ops', '/* 每 MAX_WQE/2 次置一次 SIGNALED，减少 CQ 事件数。 */'],
  ['send_wr.imm_data = htonl(data_len);', '/* imm_data 是本次长度，服务端据此推进 rx.offset。 */'],
  ['send_wr.wr.rdma.remote_addr', '/* remote_addr 带偏移，写到对端 RX 对应位置。 */'],
  ['send_wr.wr.rdma.rkey = ctx->tx_key;', '/* rkey 来自 RegisterXferMemory 报文。 */'],
  ['send_wr.wr_id = 0;', '/* wr_id 置 0：写完成不需要回查槽位。 */'],
  ['send_wr.next = NULL;', '/* 单 WR 链。 */'],
  ['ret = ibv_post_send(cm_id->qp, &send_wr, &bad_wr);', '/* 投递到 QP。 */'],
  ['if (ret) {', '/* 非 0 说明 QP 已坏。 */'],
  ['serverLog(LL_WARNING, "RDMA: post send failed: %d", ret);', '/* 打 ret，ibv_post_send 用返回值报错。 */'],
  ['conn->state = CONN_STATE_ERROR;', '/* 直接置 ERROR，半写的缓冲无法回滚。 */'],
  ['ctx->tx.offset += data_len;', '/* 只有投递成功才推进偏移。 */'],
  ['return data_len;', '/* 返回写入字节数，符合 write 语义。 */'],
  ['static int connRdmaWrite(connection *conn, const void *data, size_t data_len) {', '/* write 入口：受 tx 剩余空间限制。 */'],
  ['uint32_t towrite;', '/* towrite 是本次实际能写的字节数。 */'],
  ['if (connRdmaAllowRW(conn)) {', '/* 断链或 fork 子进程时拒绝。 */'],
  ['assert(ctx->tx.offset <= ctx->tx.length);', '/* offset 不能超过 length，否则算出巨大 towrite。 */'],
  ['towrite = MIN(ctx->tx.length - ctx->tx.offset, data_len);', '/* 取剩余空间与请求的较小者。 */'],
  ['if (!towrite) {', '/* 空间用尽时返回 0，调用方等事件后再试。 */'],
  ['return 0;', '/* 0 表示缓冲满，不是错误。 */'],
  ['return connRdmaSend(conn, data, towrite);', '/* 真正投递，返回字节数。 */'],
  ['static int connRdmaWritev(connection *conn, const struct iovec *iov, int iovcnt) {', '/* writev 按 iov 顺序逐段写。 */'],
  ['int ret, nwritten = 0;', '/* nwritten 累计已写字节数。 */'],
  ['for (int i = 0; i < iovcnt; i++) {', '/* 逐个 iov 写，顺序与调用方一致。 */'],
  ['ret = connRdmaWrite(conn, iov[i].iov_base, iov[i].iov_len);', '/* 单段写失败即整体失败。 */'],
  ['if (ret == C_ERR) return C_ERR;', '/* C_ERR 直接返回，已写部分不回滚。 */'],
  ['nwritten += ret;', '/* 累计写入量。 */'],
  ['return nwritten;', '/* 返回总写入量。 */'],
  ['static inline uint32_t rdmaRead(RdmaContext *ctx, void *buf, size_t buf_len) {', '/* rdmaRead 只从 RX 消费，不触碰 QP。 */'],
  ['uint32_t toread;', '/* toread 本次可读字节数。 */'],
  ['toread = MIN(ctx->rx.offset - ctx->rx.pos, buf_len);', '/* offset-pos 是未读量，不能超过 buf_len。 */'],
  ['assert(ctx->rx.pos + toread <= ctx->rx.length);', '/* pos+toread 越过 length 会读穿 MR。 */'],
  ['memcpy(buf, ctx->rx.addr + ctx->rx.pos, toread);', '/* 从 RX 的 pos 处拷出。 */'],
  ['ctx->rx.pos += toread;', '/* 推进消费水位。 */'],
  ['return toread;', '/* 返回本次读出字节数。 */'],
  ['static int connRdmaRead(connection *conn, void *buf, size_t buf_len) {', '/* 读入口：本端无数据时返回 -1 让上层注册读事件。 */'],
  ['return -1;', '/* 无数据可读返回 -1，调用方据此注册读事件。 */'],
  ['assert(ctx->rx.pos < ctx->rx.offset);', '/* pos<offset 是 rdmaRead 的前提。 */'],
  ['return rdmaRead(ctx, buf, buf_len);', '/* 返回实际读出字节数。 */'],
  ['static ssize_t connRdmaSyncWrite(connection *conn, char *ptr, ssize_t size, long long timeout) {', '/* 同步写：阻塞直到全部写完或超时。 */'],
  ['ssize_t nwritten = 0;', '/* nwritten 累计已写。 */'],
  ['long long start = mstime();', '/* start 用于超时计算。 */'],
  ['if (ctx->tx.offset < ctx->tx.length) {', '/* 缓冲还有空间，先直接写。 */'],
  ['wait:', '/* wait 标号：缓冲已满，等对端消费。 */'],
  ['if (connRdmaWait(conn, start, timeout) == C_ERR) {', '/* 等待超时返回 C_ERR。 */'],
  ['if (unlikely(!ctx->tx.mr)) {', '/* 等待期间 TX 可能被重建。 */'],
  ['goto wait;', '/* 回到 wait 重新等。 */'],
  ['copy:', '/* copy 标号：有新空间可写。 */'],
  ['towrite = MIN(ctx->tx.length - ctx->tx.offset, size - nwritten);', '/* 取剩余空间与剩余请求的较小者。 */'],
  ['if (connRdmaSend(conn, ptr, towrite) == (size_t)C_ERR) {', '/* 投递失败按 C_ERR 处理。 */'],
  ['ptr += towrite;', '/* 推进源指针。 */'],
  ['nwritten += towrite;', '/* 累计写入量。 */'],
  ['if (nwritten < size) {', '/* 还没写完就再等一轮。 */'],
  ['return size;', '/* 全部写完返回 size。 */'],
  ['static ssize_t connRdmaSyncRead(connection *conn, char *ptr, ssize_t size, long long timeout) {', '/* 同步读：阻塞直到读满或超时。 */'],
  ['ssize_t nread = 0;', '/* nread 累计已读。 */'],
  ['if (ctx->rx.pos < ctx->rx.offset) {', '/* 已有数据直接拷。 */'],
  ['goto copy;', '/* 跳到 copy 避免先阻塞。 */'],
  ['toread = rdmaRead(ctx, ptr, size - nread);', '/* 从 RX 消费最多剩余需求。 */'],
  ['ptr += toread;', '/* 推进目标指针。 */'],
  ['nread += toread;', '/* 累计读出量。 */'],
  ['if (nread < size) {', '/* 没读满就再等。 */'],
  ['static ssize_t connRdmaSyncReadLine(connection *conn, char *ptr, ssize_t size, long long timeout) {', '/* 按行读：遇到换行就地截断。 */'],
  ['char *c;', '/* c 是扫描指针。 */'],
  ['char nl = 0;', '/* nl 标记是否遇到换行。 */'],
  ['for (toread = 0; toread <= ctx->rx.offset - ctx->rx.pos; toread++) {', '/* 最多扫到 offset-pos，不能越界。 */'],
  ["c = ctx->rx.addr + ctx->rx.pos + toread;", '/* c 指向当前字节。 */'],
  ["if (*c == '\\n') {", '/* 遇到换行就地截断成 C 字符串。 */'],
  ["*c = '\\0';", '/* 写 \\0 覆盖换行符。 */'],
  ['if (toread && *(c - 1)', '/* 行尾 \\r\\n 时把 \\r 也去掉。 */'],
  ['*(c - 1)', '/* 覆盖前一个字节。 */'],
  ['nl = 1;', '/* 标记已找到行尾。 */'],
  ['break;', '/* 停止扫描。 */'],
  ['toread = rdmaRead(ctx, ptr, MIN(toread + nl, size - nread));', '/* 只拷到行尾（含 \\0），且不超过剩余空间。 */'],
  ['if (nl) {', '/* 找到行尾就返回，即使没读满 size。 */'],
  ['return nread;', '/* 返回本行长度。 */'],
  ['static int connRdmaGetType(void) {', '/* 返回 RDMA 连接类型枚举。 */'],
];

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const ops = [];
let cursor = lines.findIndex((l) => l.trim().startsWith('static size_t connRdmaSend('));
if (cursor < 0) {
  console.error('connRdmaSend not found');
  process.exit(2);
}
for (const [anchor, c, skip] of E) {
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
  cursor = found + (skip || 0) + 1;
}
ops.sort((a, b) => b.line - a.line);
fs.writeFileSync(`${DIR}/ins-${PX}.json`, JSON.stringify([{ file: 'src/rdma.c', ops }], null, 1));

const out = `${DIR}/out-rdma.json`;
const prev = JSON.parse(fs.readFileSync(out, 'utf8'));
const entries = ops.map((o) => ({ line: o.line, c: o.lines }));
fs.writeFileSync(out, JSON.stringify([...prev, ...entries], null, 1));
console.log(`${PX} ops=${ops.length} entries=${prev.length + entries.length}`);
