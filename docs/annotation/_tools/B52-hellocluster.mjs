import fs from 'node:fs';

const REL = 'src/modules/hellocluster.c';
const SRC = `d:/code/opensource/valkey/${REL}`;
const DIR = 'd:/code/_annot_baseline/VK-B52';

const E = [
  [43, '/* 命令入口：注册时的回调签名固定，真正分发由模块运行时按命令名完成。 */'],
  [44, '/* 本命令不收参数，显式标记未使用以消除编译告警。 */'],
  [45, '/* `argc` 同理不参与逻辑，参数个数校验交给模块框架。 */'],
  [47, '/* 目标节点传 NULL 表示广播到集群内所有节点；payload 长度 3 显式给出，不依赖 strlen。 */'],
  [48, '/* 回复 OK 并返回回复状态，让运行时知道命令已完整应答。 */'],

  [52, '/* 命令入口：把当前节点看到的集群节点列表回给客户端。 */'],
  [56, '/* `numnodes` 是出参，成功时写入节点个数；失败时内容未定义，不能提前读。 */'],
  [57, '/* 未开集群时返回 NULL，这是判断「集群不可用」的唯一信号。 */'],
  [58, '/* 先判 NULL 再回复错误：此时 `ids` 不是有效数组，不能走后面的释放逻辑。 */'],
  [59, '/* `ReplyWithError` 返回 ERR，直接作为命令返回值向上抛。 */'],
  [62, '/* RESP 要求先声明数组长度再逐个写元素，这里长度就是 `numnodes`。 */'],
  [63, '/* 逐个节点输出；`ids` 是 API 分配的字符串数组，索引到 `numnodes` 为止。 */'],
  [64, '/* `port` 只声明不初始化，`GetClusterNodeInfo` 成功时写入，其余出参传 NULL 表示不关心。 */'],
  [65, '/* 取节点信息只读端口；节点 id 与主从角色等字段这里全部忽略。 */'],
  [66, '/* 每个节点是一个二元数组：[id, port]，长度同样要先声明。 */'],
  [67, '/* 节点 id 是定长 40 字节且不带 NUL 结尾，必须用 `VALKEYMODULE_NODE_ID_LEN` 显式给长度。 */'],
  [68, '/* 端口按整数回复，客户端可直接当数字使用而不必再解析字符串。 */'],
  [70, '/* 列表由 API 分配，回复完必须 `FreeClusterNodesList`，否则每次调用泄漏一份节点表。 */'],
  [71, '/* 所有元素都已写入回复缓冲，返回 OK 结束命令。 */'],

  [75, '/* 接收回调签名固定，类型分派已由注册表完成，`type` 在这里只用于日志。 */'],
  [80, '/* id 与 payload 都不保证 NUL 结尾，`%.*s` 带精度输出，长度分别取常量与 `len`。 */'],
  [81, '/* `%.*s` 的精度参数是 int，`len` 是 uint32_t，必须显式强转，否则可变参数会按错误宽度读取。 */'],
  [82, '/* 收到 PING 即回 PONG 到所有节点；payload 长度 4 同样显式给出。 */'],
  [83, '/* `"c"` 标志表示后续是命令参数而非原始协议；INCR 在本地键空间执行，不经过集群重定向。 */'],
  [84, '/* 调用回复无论成败都要释放；失败时返回 NULL，这里不做判空，`FreeCallReply` 接受 NULL。 */'],

  [88, '/* PONG 回调只记录日志，不再回消息，否则两个节点会无限乒乓。 */'],
  [93, '/* 日志格式与 PING 侧对称，但这里没有后续动作，收到即结束。 */'],

  [99, '/* 模块入口：名字、版本、API 版本在此注册，缺这个函数模块无法加载。 */'],
  [103, '/* `Init` 失败必须原样把 ERR 返回给加载器，不能继续注册命令。 */'],
  [105, '/* 注册命令名与回调；`0,0,0` 表示不声明任何键位，集群模式下该命令不参与槽位计算。 */'],
  [106, '/* 任一命令注册失败都直接中止加载，避免半注册状态。 */'],
  [109, '/* 第二条命令同样以只读标志注册，两个命令共享一套键位声明。 */'],
  [119, '/* 关闭重定向：让任意节点都能直接处理任意键，PING 回调里的 INCR 才不会收到 MOVED。 */'],
  [122, '/* 按消息类型注册接收器；这里的类型值必须与发送端 `SendClusterMessage` 用的常量一致。 */'],
  [123, '/* PONG 类型单独注册；若漏注册，收到的消息会被静默丢弃而不是报错。 */'],
  [124, '/* 全部注册完成后返回 OK，加载器据此认为模块可用。 */'],
];

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const ops = [];
for (const [ln, c] of E) {
  const t = lines[ln - 1].trim();
  if (!t) { console.error('MISSING', ln); process.exit(2); }
  if (t.startsWith('/*') || t.startsWith('* ') || t === '*' || t.startsWith('//') || t.startsWith('#')) { console.error('BADANCHOR', ln, t); process.exit(2); }
  ops.push({ line: ln, expect: t, lines: [c] });
}
ops.sort((a, b) => b.line - a.line);
fs.writeFileSync(`${DIR}/ins-v1.json`, JSON.stringify([{ file: REL, ops }], null, 1));
fs.writeFileSync(`${DIR}/out-hellocluster.json`, JSON.stringify(ops.map((o) => ({ line: o.line, c: o.lines })), null, 1));
console.log('ops', ops.length, 'lines', ops.reduce((s, o) => s + o.lines.length, 0));
