import fs from 'node:fs';
const RL = 'd:/code/opensource/valkey/docs/annotation/README-rework.md';
const tbl = fs.readFileSync('d:/code/_annot_baseline/B-table.md', 'utf8').trimEnd();
let s = fs.readFileSync(RL, 'utf8');

const bulletOld = '- B 档总数：102 个 .c / 57,100 单元；已做 59 个 / 36,920 单元；剩余 **43 个 / 20,180 单元**（未覆盖 17,587）。';
const bulletNew = '- B 档总数：102 个 .c / 57,100 单元；已做 60 个 / 36,966 单元；剩余 **42 个 / 20,134 单元**（未覆盖 17,548）。';
if (!s.includes(bulletOld)) { console.error('BULLET MISS'); process.exit(2); }
s = s.replace(bulletOld, bulletNew);

const rowOld = '| VK-B51 | src/modules/lua/list.c | 35 | 35 | 0 | 0 | 0 | 0 | 13.3% → 91.1% | 0.0% → 100.0% |';
const rowNew = rowOld + '\n| VK-B52 | src/modules/hellocluster.c | 36 | 36 | 0 | 0 | 0 | 0 | 15.2% → 73.9% | 0.0% → 100.0% |';
if (!s.includes(rowOld)) { console.error('ROW MISS'); process.exit(2); }
s = s.replace(rowOld, rowNew);

const paraAnchor = '（首轮 30 行后补 5 行结构体字段注释，1 行 W 补反引号标识符后清零）。';
const paraNew = paraAnchor + '\n\n' +
  'B52：`src/modules/hellocluster.c` 单文件单片完成，示例集群消息 API 的收发对称性与两个所有权边界。其一，发送侧 `SendClusterMessage(ctx, NULL, ...)` 的目标传 NULL 表示广播全集群，payload 长度显式给出（3/4）而不依赖 `strlen`；接收侧 `RegisterClusterMessageReceiver` 按 `MSGTYPE_PING`/`MSGTYPE_PONG` 分派，类型常量必须与发送端一致，漏注册的消息会被静默丢弃。其二，`PingReceiver` 回 PONG 后再执行 `INCR pings_received`，`PongReceiver` 只写日志不再回消息——两个方向不对称，否则节点间会无限乒乓；`Call` 的 `"c"` 标志表示后续是命令参数，回复无论成败都交给 `FreeCallReply`（接受 NULL）。其三，`GetClusterNodesList` 返回 API 分配的数组，回复完必须 `FreeClusterNodesList`，未开集群时返回 NULL 且只能回 `Cluster not enabled` 错误、不能进入释放逻辑；节点 id 是定长 40 字节、不带 NUL，必须用 `VALKEYMODULE_NODE_ID_LEN` 给 `ReplyWithStringBuffer` 与 `%.*s` 的长度。其四，`OnLoad` 里 `Init` 与两次 `CreateCommand` 任一失败都原样返回 ERR，命令的 `0,0,0` 表示不声明键位；`SetClusterFlags(NO_REDIRECTION)` 关闭重定向，才使 PING 回调里的 INCR 在任意节点都直接成功。语句 15.2% → 73.9%、分支 0.0% → 100.0%，`added=36 / extra=0 / water=0 / weak=0 / filler=0 / deletedNonZero=0 / syntaxErr=0`（首轮 3 行 W 补反引号标识符后清零）。';
if (!s.includes(paraAnchor)) { console.error('PARA MISS'); process.exit(2); }
s = s.replace(paraAnchor, paraNew);

const cumOld = 'B51 再增 37 行（35 行源码 + 2 行 README）至 155 文件 / 74,358 行，water 仍 369（0.50%）。';
const cumNew = 'B51 再增 37 行（35 行源码 + 2 行 README）至 155 文件 / 74,358 行；B52 再增 38 行（36 行源码 + 2 行 README）至 156 文件 / 74,396 行，water 仍 369（0.50%）。';
if (!s.includes(cumOld)) { console.error('CUM MISS'); process.exit(2); }
s = s.replace(cumOld, cumNew);

s = s.replace('A15–A34、B2–B51 新增行 W = 0', 'A15–A34、B2–B52 新增行 W = 0');

const start = s.indexOf('| 文件 | 单元 | 已做 | 剩余 | 语句 | 分支 |');
if (start < 0) { console.error('TABLE MISS'); process.exit(2); }
const endMark = s.indexOf('\n\n## 4.', start);
if (endMark < 0) { console.error('END MISS'); process.exit(2); }
s = s.slice(0, start) + tbl + s.slice(endMark);

fs.writeFileSync(RL, s);
console.log('readme updated for B52');
