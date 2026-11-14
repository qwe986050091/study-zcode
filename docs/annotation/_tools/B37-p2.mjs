// B37 P2：rdmaSendCommand / connRdmaRegisterRx / connRdmaGetFeature / connRdmaSetFeature /
// rdmaHandleEstablished / rdmaDelKeepalive / rdmaHandleDisconnect / connRdmaHandleRecv /
// connRdmaHandleSend / connRdmaHandleRecvImm / connRdmaHandleWrite。
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/rdma.c';
const DIR = 'd:/code/_annot_baseline/VK-B37';
const PX = 'p2';

const E = [
  [763, '/* send_wr 是本次发送 WR，bad_wr 回填被拒项。 */'],
  [764, '/* sge 指向 SEND 区槽位，单段。 */'],
  [765, '/* _cmd 是选中的空闲槽位，也是 memcpy 目标。 */'],
  [766, '/* i 扫描槽位，ret 保存 ibv_post_send 返回值。 */'],
  [770, '/* _cmd 从 MAX_WQE 起，只扫 SEND 区。 */'],
  [771, '/* opcode 为 INVALID 说明该槽位空闲可复用。 */'],
  [772, '/* break 后由 assert 保证 i 未越界。 */'],
  [776, '/* 1024 槽全在途说明对端不回收，断言优于覆盖在用槽位。 */'],
  [778, '/* 把调用方报文复制进槽位，之后硬件按 sge 发送。 */'],
  [779, '/* sge.addr 指向槽位本身，长度固定 32。 */'],
  [780, '/* length 与 sizeof(ValkeyRdmaCmd) 一致。 */'],
  [781, '/* lkey 用 cmd_mr，收发共用同一个注册。 */'],
  [783, '/* 单段 sg_list。 */'],
  [784, '/* num_sge=1，硬件只发这 32 字节。 */'],
  [785, '/* wr_id 存槽位指针，SEND 完成时靠它清零复用。 */'],
  [786, '/* IBV_WR_SEND 是双端 SEND/RECV 配对，不是 RDMA 写。 */'],
  [787, '/* SIGNALED 必须置位，否则 connRdmaHandleSend 永远收不到完成。 */'],
  [788, '/* 单 WR 链，next 置 NULL。 */'],
  [789, '/* 投递到 QP，bad_wr 回填失败项。 */'],
  [790, '/* 非 0 即投递失败。 */'],
  [791, '/* 打印 ret，ibv_post_send 用返回值而非 errno。 */'],
  [792, '/* 返回 C_ERR，槽位内容保留但不保证发出。 */'],
  [795, '/* 投递成功，槽位交给硬件，完成后由 CQ 回收。 */'],
  [802, '/* 报文清零，避免 rsvd 带脏数据。 */'],
  [804, '/* opcode 转网络序，对端按 htons 还原。 */'],
  [805, '/* addr 是本端 RX 基址，对端直接写到这个地址。 */'],
  [806, '/* length 与 rx.length 一致，对端按它裁剪写入。 */'],
  [807, '/* key 用 rkey（远端键），发错会让对端 WR 报 REM_ACCESS_ERR。 */'],
  [809, '/* 通告即代表缓冲清空，rx.offset 必须归零。 */'],
  [810, '/* rx.pos 同步归零，否则上层会跳过新数据。 */'],
  [812, '/* 通过 SEND 区发出，失败由调用方断链。 */'],
  [818, '/* 应答报文清零。 */'],
  [820, '/* 回 GetServerFeature，客户端据此确认路径。 */'],
  [821, '/* select 原样回带，证明服务端读懂了请求。 */'],
  [822, '/* features 恒 0：当前无任何可选特性。 */'],
  [824, '/* 走 rdmaSendCommand，与其它控制面报文共用槽位池。 */'],
  [830, '/* ctx 形参未用，服务端不应答特性位。 */'],
  [831, '/* cm_id 只用于发送，本分支不发包。 */'],
  [836, '/* 客户端没带任何特性位，接受。 */'],
  [843, '/* ev->id 是新建链的 cm_id，context 即 RdmaContext。 */'],
  [844, '/* ctx 由 rdmaHandleConnect 挂上去。 */'],
  [846, '/* 建链后唯一必做动作：交换 RX 内存信息。 */'],
  [848, '/* 返回 C_OK，ESTABLISHED 无需额外状态迁移。 */'],
  [854, '/* AE_ERR 表示未安装，重复删除安全。 */'],
  [855, '/* 直接返回，不做多余的 aeDeleteTimeEvent。 */'],
  [858, '/* 删除后定时器不会再触发。 */'],
  [859, '/* 置 AE_ERR 恢复「未安装」状态。 */'],
  [869, '/* 断链事件的 cm_id。 */'],
  [870, '/* context 在 connect 时挂上，close 前一直有效。 */'],
  [871, '/* ctx->conn 是 RdmaContext 里的反向指针。 */'],
  [872, '/* 强转回 rdma_connection 以访问 pending_list_node。 */'],
  [874, '/* 先停保活，避免定时器回调拿到将释放的 ctx。 */'],
  [875, '/* 只标记 CLOSED，真正释放交给主循环安全点。 */'],
  [879, '/* 首次入队，pending_list_node 是唯一判据。 */'],
  [880, '/* 记录节点指针，摘链时直接用。 */'],
  [883, '/* 返回 C_OK，CM 事件已处理完。 */'],
  [893, '/* 长度必须是 32，否则说明对端版本或缓冲不一致。 */'],
  [894, '/* 打印 FATAL，继续解析会越界读 cmd。 */'],
  [895, '/* 返回 C_ERR 交给 CQ 处理断链。 */'],
  [898, '/* opcode 从网络序还原后分发。 */'],
  [899, '/* 客户端请求特性，回特征位图。 */'],
  [901, '/* 客户端上报特性，当前只接受 0。 */'],
  [903, '/* 保活只需「已读」，不回包避免放大流量。 */'],
  [905, '/* 对端注册 RX 内存，本端据此建 TX 缓冲。 */'],
  [906, '/* 记录对端 RX 地址，写时作为 remote_addr。 */'],
  [907, '/* 记录对端 RX 长度，决定本端 TX 缓冲大小。 */'],
  [908, '/* 记录对端 rkey，ibv_post_send 的 wr.rdma.rkey 用它。 */'],
  [909, '/* 对端缓冲从头接收，tx.offset 归零。 */'],
  [910, '/* 按对端长度重建 TX，失败由 tx.mr 判空兜底。 */'],
  [911, '/* 结束 RegisterXferMemory 分支。 */'],
  [913, '/* 未知 opcode 说明协议错乱，断链。 */'],
  [916, '/* 用完即还：重新投递同一槽位，漏掉就永久少一个 RECV。 */'],
  [924, '/* 清零后写 INVALID，恢复空闲哨兵。 */'],
  [926, '/* 槽位可被 rdmaSendCommand 重新选中。 */'],
  [936, '/* offset 越过 length 会写穿 MR，这里先断言。 */'],
  [938, '/* imm_data 是本次写入字节数，推进消费水位。 */'],
  [940, '/* 重新投递，保持 RX 队列深度。 */'],
  [946, '/* ctx 形参未用，当前不发 RDMA_WRITE。 */'],
  [947, '/* byte_len 同样未用。 */'],
  [949, '/* 本端作为发起方的写完成，当前路径无动作。 */'],
];

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const ops = [];
for (const [ln, c] of E) {
  const cur = lines[ln - 1];
  if (cur === undefined) {
    console.error(`MISSING ${ln}`);
    process.exit(2);
  }
  const t = cur.trim();
  if (!t || t.startsWith('/*') || t.startsWith('//') || t.startsWith('*')) {
    console.error(`BADANCHOR ${ln} ${t}`);
    process.exit(2);
  }
  ops.push({ line: ln, expect: t, lines: [c] });
}
ops.sort((a, b) => b.line - a.line);
fs.writeFileSync(`${DIR}/ins-${PX}.json`, JSON.stringify([{ file: 'src/rdma.c', ops }], null, 1));

const out = `${DIR}/out-rdma.json`;
const prev = JSON.parse(fs.readFileSync(out, 'utf8'));
const entries = ops.map((o) => ({ line: o.line, c: o.lines }));
fs.writeFileSync(out, JSON.stringify([...prev, ...entries], null, 1));
console.log(`${PX} ops=${ops.length} entries=${prev.length + entries.length}`);
