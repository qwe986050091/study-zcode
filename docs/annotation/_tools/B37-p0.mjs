// B37 P0：文件头宏/结构体字段/全局量 + serverRdmaError / connRdmaAllowCommand / connRdmaAllowRW。
import fs from 'node:fs';

const SRC = 'd:/code/opensource/valkey/src/rdma.c';
const DIR = 'd:/code/_annot_baseline/VK-B37';
const PX = 'p0';

const E = [
  [46, '/* USE_RDMA 只在 Linux 打开；非 Linux 走文件末尾的 RegisterConnectionTypeRdma 桩。 */'],
  [69, '/* rsvd[20] 把 opcode/select 之后的空隙占满，使 2+2+20+8 恰好 32 字节。 */'],
  [81, '/* rsvd[30] 是保活报文的填充：opcode 只占 2 字节，靠它凑满 32 字节定长。 */'],
  [92, '/* rsvd[14] 让 addr 从第 18 字节起排布，addr/length/key 之后仍是 32 字节。 */'],
  [105, '/* opcode 为 GetServerFeature/SetClientFeature 时按 feature 成员解析。 */'],
  [106, '/* Keepalive（opcode 2）只读 opcode，其余 30 字节是填充。 */'],
  [107, '/* RegisterXferMemory（opcode 3）时读 addr/length/key 三个字段。 */'],
  [114, '/* 0 是客户端请求特性；枚举从 0 起，因此 0 不能表示「无命令」。 */'],
  [120, '/* 编译期断言：cond 为真时 char[1-2] 长度为负，构建立刻失败。 */'],
  [121, '/* 1024：单方向 WR 槽位数；cmd_buf 前一半 RECV、后一半 SEND 各占这么多。 */'],
  [122, '/* 1MB：未配置 rdma-rx-size 时的默认 RX 缓冲，对端按此长度注册 TX。 */'],
  [123, '/* 64KB 下限：更小的 RX 缓冲一次写入就要重注册，退化成控制面往返。 */'],
  [124, '/* 16MB 上限：MR 越大 pin 的物理页越多，超过它 fork 与内存压力都不可控。 */'],
  [125, '/* 10ms：connRdmaWait 的单次等待切片，累计到 timeout 才判超时。 */'],
  [126, '/* 0xffff 复用为「槽位空闲」标记，合法 opcode 只到 3，不会撞上。 */'],
  [127, '/* 3000ms：保活定时器重排间隔，也是链路静默被发现的最坏延迟。 */'],
  [137, '/* c 必须在首位：上层用 (connection *) 强转，字段偏移不能变。 */'],
  [138, '/* cm_id 为 NULL 表示尚未 resolve 或已 close，close 路径靠它做幂等。 */'],
  [139, '/* 连接标志位，写屏障在 connRdmaSetWriteHandler 里置位。 */'],
  [140, '/* 最近一次错误码，connRdmaGetLastError 直接 strerror 它。 */'],
  [141, '/* CONN_POSTPONE_READ/WRITE 位，eventHandler 据此跳过读或续写。 */'],
  [142, '/* 非 NULL 表示已挂 pending_list；摘链后必须立即置 NULL，否则二次入队。 */'],
  [151, '/* mr 为 NULL 表示该方向缓冲尚未注册，发送路径据此跳过。 */'],
  [166, '/* 反向指回 connection，CQ 回调里由 cm_id->context 取到。 */'],
  [167, '/* zstrdup 的对端 IP，只在日志与错误信息里使用。 */'],
  [168, '/* 对端端口，与 ip 一起在 rdmaHandleConnect 里填。 */'],
  [169, '/* AE_ERR 表示未安装；删除后置 AE_ERR 让 rdmaDelKeepalive 幂等。 */'],
  [171, '/* CM 事件通道，客户端侧在 connRdmaClose 里销毁。 */'],
  [172, '/* 完成事件通道，其 fd 就是 conn->fd；阻塞会让 ae 循环卡死。 */'],
  [173, '/* CQ 深度按 2*MAX_WQE 申请，收发共用一个 cq。 */'],
  [177, '/* 对端 RX 缓冲地址，来自 RegisterXferMemory 报文，本端不解释只透传。 */'],
  [189, '/* 覆盖整块 cmd_buf 的 MR，收发共用同一个 lkey，省一次注册。 */'],
  [195, '/* listen cm_id，与 listener->fd[i] 同下标对应。 */'],
  [196, '/* 监听通道，fd 就是 listener->fd[i]，rdmaFdToListener 靠它反查。 */'],
  [207, '/* 按 bindaddr 顺序分配，rdmaFdToListener 依赖同下标映射。 */'],
  [208, '/* 指向 connListener->priv，读 rx_size 与 completion_vector。 */'],
  [210, '/* page_size 来自 sysconf(_SC_PAGESIZE)，mmap 对齐与守护页都按它算。 */'],
  [212, '/* 前置声明，真正初始化在文件末尾的 designated initializer。 */'],
  [214, '/* 按 printf 风格写 err 缓冲，ANET_ERR_LEN 是调用方缓冲上限。 */'],
  [215, '/* va_list 必须在 vsnprintf 前 va_start、之后 va_end。 */'],
  [217, '/* err 为 NULL 直接返回，避免 vsnprintf 写空指针。 */'],
  [218, '/* fmt 是最后一个具名参数，va_start 必须指向它。 */'],
  [219, '/* 截断到 ANET_ERR_LEN，超长错误串不会写越界。 */'],
  [220, '/* 与 va_start 配对，漏掉在部分 ABI 上会破坏寄存器保存区。 */'],
  [223, '/* fork 子进程里 MR 不可访问，所有收发入口先过这里。 */'],
  [227, '/* in_fork_child 非 CHILD_TYPE_NONE 时拒绝，避免子进程访问 MR 段错误。 */'],
  [230, '/* 主进程返回 C_OK，调用方继续投递 WR。 */'],
  [233, '/* 读写前的统一闸门：先看连接状态，再看 fork 身份。 */'],
  [234, '/* ERROR/CLOSED 的连接不再读写，否则 QP 已销毁会解引用空指针。 */'],
  [235, '/* 状态非法直接 C_ERR，调用方不再尝试 memcpy 或 post_send。 */'],
  [238, '/* 状态正常时再查 fork，两条拒绝理由分开返回便于定位。 */'],
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
