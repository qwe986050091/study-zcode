// B37 弱注释整改：把无标识符的短句替换为带标识符/数字/后果的表述。
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/rdma.c';
const M = [
  ['/* 投递成功，槽位交给硬件，完成后由 CQ 回收。 */', '/* post_send 成功，槽位交给硬件，完成后由 CQ 回收。 */'],
  ['/* 应答报文清零。 */', '/* 应答报文清零，features/select 先置 0 再填。 */'],
  ['/* 对端注册 RX 内存，本端据此建 TX 缓冲。 */', '/* RegisterXferMemory 告知对端 RX，本端据此建 TX 缓冲。 */'],
  ['/* 继续排空 CQ。 */', '/* continue 继续排空 CQ。 */'],
  ['/* 继续排空。 */', '/* continue 继续排空 CQ。 */'],
  ['/* 重新登记 RX 并通告对端新地址。 */', '/* connRdmaRegisterRx 重新通告对端新 RX 地址。 */'],
  ['/* 不匹配就跳过。 */', '/* listener->fd[i] 不匹配就 continue。 */'],
  ['/* 清除屏障，允许补发剩余数据。 */', '/* 清除 CONN_FLAG_WRITE_BARRIER，允许补发剩余数据。 */'],
  ['/* 结束分支。 */', '/* break 结束该事件分支。 */'],
  ['/* 客户端 CM 通道。 */', '/* conn->cm_channel 是客户端 CM 通道。 */'],
  ['/* 打日志后统一释放。 */', '/* 打日志后 goto out 统一释放。 */'],
  ['/* 遍历解析结果，逐个尝试。 */', '/* for 遍历 servinfo 解析结果，逐个尝试。 */'],
  ['/* 复制地址，端口单独覆盖。 */', '/* memcpy 复制 sockaddr，端口单独覆盖。 */'],
  ['/* 端口转网络序。 */', '/* htons(port) 把端口转网络序。 */'],
  ['/* 没有一个可用地址。 */', '/* addr 一个可用地址都没有，置 ANET_ERR。 */'],
  ['/* 全部成功。 */', '/* ret 保持 C_OK，全部成功。 */'],
  ['/* 每轮重算剩余时间。 */', '/* remaining 每轮重算剩余时间。 */'],
  ['/* 累计已等待时间。 */', '/* elapsed 累计已等待时间。 */'],
  ['/* 建链成功。 */', '/* RDMA_CM_EVENT_ESTABLISHED 建链成功。 */'],
  ['/* 断开 QP，等待在途 WR 完成。 */', '/* rdma_disconnect 断开 QP，等待在途 WR 完成。 */'],
  ['/* CM 通道可能已销毁。 */', '/* cm_channel 可能已销毁，判空跳过。 */'],
  ['/* 从 ae 摘掉通道 fd。 */', '/* aeDeleteFileEvent 从 ae 摘掉通道 fd。 */'],
  ['/* 销毁 CM 通道。 */', '/* rdma_destroy_event_channel 销毁 CM 通道。 */'],
  ['/* 单 WR 链。 */', '/* send_wr.next=NULL 表示单 WR 链。 */'],
  ['/* 投递到 QP。 */', '/* ibv_post_send 投递到 QP。 */'],
  ['/* 取剩余空间与请求的较小者。 */', '/* towrite = MIN(tx 剩余空间, 请求)。 */'],
  ['/* 累计写入量。 */', '/* nwritten 累计写入量。 */'],
  ['/* 推进消费水位。 */', '/* rx.pos 推进消费水位。 */'],
  ['/* 缓冲还有空间，先直接写。 */', '/* tx.offset < tx.length 说明还有空间，先直接写。 */'],
  ['/* 等待期间 TX 可能被重建。 */', '/* tx.mr 为空说明等待期间 TX 被重建。 */'],
  ['/* 取剩余空间与剩余请求的较小者。 */', '/* towrite = MIN(tx 剩余空间, size - nwritten)。 */'],
  ['/* 还没写完就再等一轮。 */', '/* nwritten < size 说明还没写完，再等一轮。 */'],
  ['/* 已有数据直接拷。 */', '/* rx.pos < rx.offset 说明已有数据，直接拷。 */'],
  ['/* 从 RX 消费最多剩余需求。 */', '/* rdmaRead 从 RX 消费最多 size - nread。 */'],
  ['/* 累计读出量。 */', '/* nread 累计读出量。 */'],
  ['/* 没读满就再等。 */', '/* nread < size 说明没读满，再等。 */'],
  ['/* 行尾 \\r\\n 时把 \\r 也去掉。 */', '/* 行尾是 \\r\\n 时把 \\r 也去掉。 */'],
  ['/* 监听专用的 CM 通道。 */', '/* rdma_create_event_channel 建监听专用 CM 通道。 */'],
  ['/* 遍历解析结果，逐个尝试绑定。 */', '/* for 遍历 servinfo，逐个尝试 rdma_bind_addr。 */'],
  ['/* 判空销毁通道。 */', '/* listen_channel 判空后 rdma_destroy_event_channel。 */'],
  ['/* 本端地址由 CM 维护。 */', '/* rdma_get_local_addr 返回的本端地址由 CM 维护。 */'],
  ['/* 对端地址同上。 */', '/* rdma_get_peer_addr 返回的对端地址同样只读。 */'],
  ['/* 对端同样强转。 */', '/* raddr 同样强转成 sockaddr_in。 */'],
  ['/* 逐个地址起监听。 */', '/* for 按 bindaddr_count 逐个地址起监听。 */'],
  ['/* 跳过前缀再解析。 */', '/* addr++ 跳过 "-" 前缀再解析。 */'],
  ['/* 监听 fd 就是 CM 通道 fd。 */', '/* fd 取 cm_channel->fd。 */'],
  ['/* 同下标的监听器。 */', '/* rdma_listeners[i] 是同下标的监听器。 */'],
  ['/* 通道最后销毁。 */', '/* rdma_destroy_event_channel 最后销毁通道。 */'],
  ['/* 置空防重入。 */', '/* rdma_listeners=NULL 置空防重入。 */'],
  ['/* ss 指向 CM 内部地址，不拥有内存。 */', '/* ss 指向 cm_id 内部地址，不拥有内存。 */'],
  ['/* 对端地址。 */', '/* remote 为真取 rdma_get_peer_addr。 */'],
  ['/* 本端地址。 */', '/* 否则取 rdma_get_local_addr。 */'],
  ['/* 端口转主机序。 */', '/* ntohs(sa4->sin_port) 转主机序。 */'],
  ['/* 占位符表示地址不可得。 */', "/* ip[0]='?' 表示 inet_ntop 失败。 */"],
  ['/* 显式结尾。 */', "/* ip[1]='\\0' 显式结尾。 */"],
  ['/* 页大小决定 RX 守护页对齐。 */', '/* page_size 决定 RX 缓冲的对齐与守护页。 */'],
  ['/* 主循环据此决定是否调用处理函数。 */', '/* listLength(pending_list) 决定主循环是否处理。 */'],
  ['/* 补发剩余数据。 */', '/* callHandler 调用 write_handler 补发剩余数据。 */'],
  ['/* 再手动驱动一次收发。 */', '/* connRdmaEventHandler 再手动驱动一次收发。 */'],
  ['/* 首次查表。 */', '/* connectionByType 首次查表。 */'],
  ['/* 模块模式下的加载入口。 */', '/* BUILD_RDMA_MODULE 的 ValkeyModule_OnLoad 入口。 */'],
  ['/* 同上。 */', '/* argc 同上，不解析。 */'],
  ['/* 加载成功。 */', '/* 返回 VALKEYMODULE_OK 表示加载成功。 */'],
];

let s = fs.readFileSync(SRC, 'utf8');
let missed = 0;
for (const [a, b] of M) {
  if (!s.includes(a)) {
    console.error(`MISS ${a}`);
    missed++;
    continue;
  }
  s = s.split(a).join(b);
}
fs.writeFileSync(SRC, s);
console.log(`replace pairs=${M.length} missed=${missed}`);
