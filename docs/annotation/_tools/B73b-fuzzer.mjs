// B73b：src/fuzzer_command_generator.c 第二片（未覆盖单元行 1224–1855，共 228）。
// 输入：VK-B73b/orig/src/fuzzer_command_generator.c（HEAD 快照，已含 B73a 的 281 行注释，UTF-8/LF）
// 输出：VK-B73b/spec.json
// 对账：E 必须等于 VK-B73b-target.txt 中本文件的全部行；切片起于 extractCommandFlags（1224），
//       止于 generateRandomAddress 结束（1855），1856 起是 generateStringArgValue，归 B73c。
import fs from 'node:fs';

const DIR = 'd:/code/_annot_baseline/VK-B73b';
const REL = 'src/fuzzer_command_generator.c';
const START = 1224;
const END = 1855;
const src = fs.readFileSync(`${DIR}/orig/${REL}`, 'utf8').replace(/\r\n/g, '\n').split('\n');

const SKIP = new Set();

const E = [
  // ---- extractCommandFlags ----
  [1225, 'COMMAND 回复必须是数组；空指针或错误回复直接返回，注册表保持 COMMAND DOCS 的初值。'],
  [1226, '提前返回不释放任何东西：`info` 由 `initFuzzer` 在 cleanup 段 freeReplyObject。'],
  [1231, '第 i 项是一条命令的元数据数组，后面按固定下标取 name/arity/flags。'],
  [1239, '`element[0]` 是命令名，与注册表的 `fullname` 对齐后才能匹配。'],
  [1243, 'arity 必须是整数类型；状态回复或错误回复一律跳过，arity 保持 0。'],
  [1244, '负 arity 表示可变参数个数，`removeInvalidCommands` 用 `arity == -2` 剔除父命令。'],
  [1250, '`element[2]` 是 flag 名数组，交给 `updateCommand` 逐个映射成 `CMD_*` 位。'],
  [1252, '遍历注册表找同名条目；循环体末尾的 break 使它实际只检查 j=0 一次。'],
  [1253, '取条目地址，供下面 `argc` 与 `argv[0]` 的判定使用。'],
  [1261, '无条件 break：外层每轮只跑一次迭代，真正的全表扫描在 `updateCommand` 内部。'],

  // ---- initializeCommandEntry ----
  [1275, '先占位再自增：`next` 指向下一个待填槽，返回值始终是本次条目。'],
  [1276, '填名字、argv 与 fullname；arity/flags 随后由 COMMAND 输出覆盖。'],
  [1278, '规格必须是 map 或 array，RESP3 与 RESP2 分别走这两种形态。'],
  [1282, '默认 UNKNOWN，只有 group 键出现且为字符串时才被 `mapGroupType` 覆盖。'],
  [1284, '规格是键值对数组，步长 2。'],
  [1285, '键必须是字符串，否则 `str` 字段不可用。'],
  [1286, '取字段名，下面按 arguments/group/subcommands 三分支。'],
  [1288, 'arguments 分支建立参数描述数组，并递归解析子参数。'],
  [1289, '`element[j + 1]` 是配对的参数数组。'],
  [1290, 'arguments 必须是数组，包装成 map 会破坏下面的下标访问。'],
  [1291, 'zcalloc 全零：解析中途失败时 `freeCommandArgument` 仍可安全逐项释放。'],
  [1292, '`argCount` 与数组同时落定，释放时按它遍历。'],
  [1293, 'parent 传 `&command->info`，使子参数沿链读到本命令的 group/flags。'],
  [1297, 'group 必须是字符串才解析，否则保持 UNKNOWN。'],
  [1300, '`element[j + 1]` 是子命令表，结构与顶层命令表同构。'],
  [1301, '子命令表同样允许 map 或 array 两种形态。'],
  [1306, '子命令也是键值对，步长 2，值为该子命令的规格。'],
  [1307, '子命令名必须是字符串。'],
  [1308, '子命令名可能含 `a|b`，`populateCommandEntry` 会只取竖线后半段。'],
  [1309, '子命令规格，递归时作为 specs 传入。'],
  [1310, '规格形态校验，与 1278 行同一约束。'],
  [1311, '递归推进同一个 `next`，父命令后紧跟其全部子命令。'],
  [1315, '返回 `next` 指向的下一个空槽；顶层调用者拿到的就是最终填充长度。'],

  // ---- initializeCommandRegistry ----
  [1326, '按预扫描总数一次性分配，后续递归只移动 `next` 游标，绝不 realloc。'],
  [1329, '订阅态允许的 9 条命令：6 条订阅切换加 PING/QUIT/RESET。'],
  [1330, '用 sizeof 求元素数，增删名单时无需手改计数。'],
  [1333, '订阅表长度固定为 9，后续删除会递减这个值而不是重排数组。'],
  [1335, '游标指向数组首元素，`initializeCommandEntry` 递归推进。'],
  [1337, 'COMMAND DOCS 是扁平键值对，步长 2。'],
  [1338, '命令名必须是字符串。'],
  [1339, '命令名作为父级 `fullname` 的起点。'],
  [1341, '规格只接受 map 或 array，其余形态无法按步长 2 解析。'],
  [1343, '顶层命令规格，传给 `initializeCommandEntry`。'],
  [1344, 'subcommandName 传 NULL 表示这是顶层命令。'],
  [1349, '在刚建好的 `commandRegistry` 里找 `allowedCommands` 中的命令。'],
  [1350, '按 `fullname` 匹配，子命令条目不会命中这些大写短名。'],
  [1351, '忽略大小写比较；名单与 `fullname` 都已大写，二者必然一致。'],
  [1352, '值拷贝整个 `CommandEntry`：两张表共享 argv/args 指针，只能释放一次。'],
  [1353, '同名命令唯一，命中即停止内层扫描。'],

  // ---- 释放链 ----
  [1362, 'name 可能为 NULL（只有 token 的参数），先判空再释放。'],
  [1363, '`name` 由 zstrdup 分配，与 zfree 成对。'],
  [1364, '置空使重复调用成为幂等操作。'],
  [1366, 'token 只对 PURE_TOKEN 类参数存在，同样需要判空。'],
  [1367, '`token` 也是 zstrdup 的独立副本。'],
  [1368, '`token` 置空防止二次释放。'],
  [1372, '按 `subargCount` 递归释放每个子参数。'],
  [1373, '子参数可能还有更深的 subargs，递归到底。'],
  [1375, '递归完成后释放子参数数组本身。'],
  [1376, '`subargs` 置空后本函数可安全重复调用。'],
  [1380, '命令级释放入口，遍历 `info.args` 并回收数组。'],
  [1381, '空命令的 `args` 为 NULL，直接跳过。'],
  [1384, '逐项递归释放 name/token/subargs。'],
  [1386, '数组本身也是 zcalloc 分配的。'],
  [1387, '置空使 `freeCommandEntry` 可重复调用。'],
  [1391, '整条命令释放：先参数、再 fullname、最后 argv。'],
  [1392, '参数链最深，先释放它可避免悬挂指针。'],
  [1393, '`fullname` 在 `populateCommandEntry` 里 zmalloc 分配。'],
  [1394, '`fullname` 置空防止二次释放。'],
  [1395, '`argv` 有 `argc` 个 zstrdup 副本，逐个释放。'],
  [1396, '`argv[0]` 是命令名副本，`argv[1]` 是子命令名副本。'],
  [1398, '`zfree` 释放 `argv` 指针数组本身。'],
  [1399, '置空后再次调用不会重复 free。'],

  // ---- shouldFilterCommand ----
  [1410, '禁止进入采样池的命令名单，`shouldFilterCommand` 逐项精确匹配。'],
  [1411, '首项 SHUTDOWN：会让服务端退出，fuzz 会话无法继续。'],
  [1436, '`cmdName` 为 NULL 时不过滤，交由调用方保证非空。'],
  [1440, '命中名单返回 1，`removeInvalidCommands` 随即删除该条目。'],
  [1445, '单机模式按前缀剔除 CLUSTER，长度 7 覆盖 CLUSTER 与 CLUSTERINFO 等。'],
  [1446, 'ASKING 只在集群重定向时有效，单机发送只会得到 -ERR。'],
  [1451, '未开启 `FUZZ_MODE_CONFIG_COMMANDS` 时 CONFIG SET 被剔除，避免改坏服务端配置。'],
  [1454, '未命中任何规则则保留，进入随机采样池。'],

  // ---- removeInvalidCommands ----
  [1465, '`commandRegistry[i]` 取当前条目地址，删除时用末元素覆盖它。'],
  [1467, '两条删除条件：命中黑名单，或是「只做命名空间」的父命令（有子命令且 arity==-2）。'],
  [1472, '先按 `fullname` 从订阅表摘除，否则订阅表会残留即将被 free 的指针。'],
  [1473, '用末元素覆盖删除，O(1) 且不移动其余元素。'],
  [1474, '长度递减后，被覆盖的末槽不再参与遍历。'],
  [1475, '订阅表里同名项唯一，摘除后即可跳出。'],
  [1478, '释放被删条目的 argv/fullname/args，随后它的槽会被末元素覆盖。'],
  [1482, '`commandRegistrySize--` 后，下一次循环仍停在同一下标检查覆盖进来的末元素。'],
  [1484, '保留的条目执行 `i++`；删除时下标不动，直接检查覆盖进来的末元素。'],

  // ---- initializeRandomSeed ----
  [1495, '`struct timeval tv` 取微秒级时间，作为种子的一部分。'],
  [1496, '`gettimeofday` 不做失败检查：fuzz 工具不因时钟异常中止。'],
  [1497, '时间、线程 id、微秒三者异或，保证同秒启动的线程序列不同。'],

  // ---- initFuzzer ----
  [1511, '默认失败；只有全部初始化走完才在 1570 行改成 0。'],
  [1512, '分配全局上下文，后续所有函数通过 `fuzz_ctx` 访问。'],
  [1515, '集群模式影响 key 的 slot tag 与 CLUSTER 命令过滤。'],
  [1516, 'ACL CAT 可能失败，先置空，`freeAclCategories` 才能判空跳过。'],
  [1517, '`aclCategoriesCount` 与指针同步初始化，空数组状态自洽。'],
  [1519, '四个回复都先置空，cleanup 段据此判断是否需要 freeReplyObject。'],
  [1520, 'COMMAND 回复保存 arity 与 flags，稍后交给 `extractCommandFlags`。'],
  [1521, 'CONFIG GET * 回复稍后交给 `parseConfigOutput`。'],
  [1522, 'ACL CAT 回复是唯一允许失败的输入。'],
  [1526, 'COMMAND DOCS 失败即无法建注册表，直接跳 cleanup 返回 -1。'],
  [1527, '错误信息带上服务端返回的错误串，便于定位版本不匹配。'],
  [1529, '统一从 cleanup 出口返回，避免每个失败点重复释放。'],
  [1534, 'COMMAND 失败则 arity/flags 无法回填，注册表不完整。'],
  [1535, '同样打印服务端错误串，与 1527 行格式一致。'],
  [1537, '跳 cleanup，已收到的 `commandDocs` 仍会被释放。'],
  [1542, 'CONFIG GET * 失败则 CONFIG SET 生成路径没有候选，必须中止。'],
  [1543, '错误串用于区分权限不足与命令不存在。'],
  [1545, '跳 cleanup 释放前两个 reply。'],
  [1550, 'ACL CAT 失败只告警不中止，老版本服务端没有这个命令。'],
  [1554, '成功才解析分类；失败时 `generateAclRule` 走 fallback 列表。'],
  [1570, '初始化全部成功，返回值改成 0；cleanup 仍会释放四个 reply。'],
  [1572, '统一释放出口，成功与失败路径在此汇合。'],
  [1573, '`commandDocs` 判空后释放，未收到的回复不会重复释放。'],
  [1574, 'COMMAND 回复在 `extractCommandFlags` 中只读不持有。'],
  [1575, 'CONFIG 快照已拷进 `configDict`，回复本身可释放。'],
  [1576, 'ACL 分类名已 sdsnew 复制，回复可释放。'],
  [1578, '成功返回 0，任一必需步骤失败返回 -1。'],

  // ---- shouldSkipOptionalArgument / slot tag ----
  [1583, '只有 OPTIONAL 位才可能跳过，概率 1/2 由 `OPTIONAL_ARG_PROBABILITY` 决定。'],
  [1591, '只在 0..20 取槽号，让不同命令更容易撞到同一槽并积累数据。'],
  [1592, '花括号是 hash tag 语法，只有 tag 内的内容参与槽位计算。'],
  [1601, '懒生成：同一条命令内多次调用复用同一个 tag，避免多 key 命令 CROSSSLOT。'],

  // ---- addKeysToCommand ----
  [1618, 'group 来自最外层命令，block 中间节点不参与分类。'],
  [1620, '按分组选 key 前缀，只为可读性与数据分布，不影响协议正确性。'],
  [1621, 'string 组用 `string` 前缀，与其他类型隔离 key 空间。'],
  [1622, '前缀落在 key 冒号之前，如 `string:42`。'],
  [1623, '每个 case 只赋前缀值，随后统一走 1666 行的生成循环。'],
  [1624, 'list 组的 key 前缀。'],
  [1625, '与 STRING 组分开，避免同索引的 key 撞类型。'],
  [1626, '赋值完即跳出 switch。'],
  [1627, 'set 组的 key 前缀。'],
  [1628, 'set 与 list 的 key 互不重叠。'],
  [1629, '跳出 switch。'],
  [1630, 'hash 组的 key 前缀。'],
  [1631, 'hash 命令的 key 统一带此前缀。'],
  [1632, '跳出 switch。'],
  [1633, '有序集合组，两种拼写已在 `mapGroupType` 合并到同一枚举。'],
  [1634, '前缀用 zset 而非 sorted-set，短且与服务端口径一致。'],
  [1635, '跳出 switch。'],
  [1636, 'stream 组的 key 前缀。'],
  [1637, '流命令的 key 独立成段。'],
  [1638, '跳出 switch。'],
  [1639, 'HyperLogLog 组的 key 前缀。'],
  [1640, '缩写 hll，与命令名口径一致。'],
  [1641, '跳出 switch。'],
  [1642, '地理组的 key 前缀。'],
  [1643, 'geo 命令的 key 独立。'],
  [1644, '跳出 switch。'],
  [1645, '位图组的 key 前缀。'],
  [1646, 'bitmap 命令的 key 独立。'],
  [1647, '跳出 switch。'],
  [1648, 'pathhash 组的 key 前缀。'],
  [1649, '与 hash 组区分，避免同名前缀混淆。'],
  [1650, '跳出 switch。'],
  [1651, 'pubsub 组用 channel 前缀，提示这是频道名而非普通 key。'],
  [1652, '订阅类命令的 key 实际是频道名。'],
  [1653, '跳出 switch。'],
  [1654, 'GENERIC 组没有确定类型，随机挑一种前缀扩大覆盖。'],
  [1657, '10 种前缀，`rand() % (sizeof/sizeof)` 保证下标不越界。'],
  [1658, '用 sizeof 求元素数，增删名单时无需手改取模基数。'],
  [1659, '随机前缀让 GENERIC 命令也尽量撞上已存在类型的 key。'],
  [1661, 'UNKNOWN 与越界枚举值走这里，`keyPrefix` 保持初始的 `key`。'],
  [1662, 'default 不赋值，直接跳出 switch。'],
  [1666, '按 numkeys 生成键，数量由调用方按参数类型决定。'],
  [1667, '用 rand62() 而非 rand()：max_keys 可能很大，rand() 低位分布不够均匀。'],
  [1668, '先声明，两个分支各自用 sdscatprintf 分配。'],
  [1672, 'tag 必须在 key 最前面，hash tag 只认第一对花括号内的内容。'],
  [1674, '非集群模式不带 tag，形如 `list:42`。'],
  [1677, 'key 所有权转交 `cmd->argv`，由 `freeCommand` 统一释放。'],

  // ---- 前置声明 / isLexicographicalCommand ----
  [1681, '前置声明：`generateCommandsWithLua` 内部会回调单命令生成。'],
  [1682, '前置声明：`generateSingleCmd` 可能转发到 Lua 分支，二者互相引用。'],
  [1689, '三层指针都要判空，任一缺失都无法取到命令名。'],
  [1690, '信息不全时 `return 0`，走普通字符串生成。'],
  [1693, '`parent->name` 指向 `fullname`，含子命令。'],
  [1697, '命令名里含 LEX 即认定为字典序区间命令，如 ZRANGEBYLEX。'],
  [1699, '未含 LEX 返回 0，交给 `generateStringArgValue` 的普通分支。'],

  // ---- generateLexRangeValue ----
  [1716, '1/10 概率生成负无穷 `-`，表示区间无下界。'],

  // ---- generateAclRule ----
  [1742, '按 0..9 分派 9 类 ACL 规则，default 处理组合规则。'],
  [1743, '开关规则：on/off 决定用户是否启用。'],
  [1745, '每条规则只 append 一个参数，随后跳出 switch。'],
  [1746, '密码规则：1/3 概率设为 nopass，否则新增 >passN。'],
  [1747, 'nopass 会让密码校验恒通过，是必须覆盖的边界。'],
  [1748, '清除密码，与 >passN 互斥。'],
  [1750, '用 > 前缀表示新增密码，`<passN` 是删除，不能混用。'],
  [1752, '密码规则处理完跳出 switch。'],
  [1753, 'key 模式规则：4 选 1，覆盖全开、全关与通配。'],
  [1755, '四个分支各占 1/4，取模基数与分支数一致。'],
  [1756, 'allkeys 等价于 `~*`，但语义更明确。'],
  [1757, '允许访问任意 key。'],
  [1759, '拒绝所有 key，用于测试权限拒绝路径。'],
  [1761, '通配模式，与 allkeys 语义等价但走模式匹配分支。'],
  [1763, '带编号的模式，命中 `key:0:*` 到 `key:9:*` 的前缀 key。'],
  [1766, '类别允许规则：优先用 ACL CAT 动态分类，失败才回落硬编码。'],
  [1767, '两个条件同真才用动态分类，避免空数组取模为 0。'],
  [1768, '`rand() % aclCategoriesCount` 的下标必然落在已解析区间。'],
  [1769, '`aclCategories[cat_idx]` 前拼 +@ 表示允许该类别。'],
  [1773, '回落列表 5 项，sizeof 求长度避免手改基数。'],
  [1774, '`fallback_cats` 同样拼 +@ 前缀，只是分类来源不同。'],
  [1776, '允许规则处理完跳出 switch。'],
  [1777, '类别拒绝规则，与 case 3 对称，前缀换成 -@。'],
  [1778, '与 case 3 一样要求 `aclCategories` 非空。'],
  [1779, '按分类数取模，与 case 3 同口径。'],
  [1780, '-@ 前缀表示拒绝该类别。'],
  [1784, '回落列表 4 项，取模与长度一致。'],
  [1785, '`fallback_cats` 走同一格式，仅分类来源不同。'],
  [1787, '拒绝规则处理完跳出 switch。'],
  [1788, '单命令允许规则，名单是常用只读/轻量命令。'],
  [1790, '10 条允许命令，取模由 sizeof 求得。'],
  [1792, '下标覆盖全部 10 项。'],
  [1793, '`commands[cmd_idx]` 前拼 + 表示允许该命令。'],
  [1795, '单命令拒绝规则，名单是破坏性命令。'],
  [1797, '8 条拒绝命令，覆盖清库、停机与调试入口。'],
  [1799, '取模基数由 sizeof 求得，与 8 项一致。'],
  [1800, '- 前缀表示拒绝该命令。'],
  [1802, '频道模式规则，用于 pubsub 权限。'],
  [1804, '三个分支各占 1/3。'],
  [1805, 'allchannels 允许访问所有频道。'],
  [1806, '语义等价于 `&*`，但更明确。'],
  [1808, '& 前缀表示频道模式，`*` 匹配全部。'],
  [1810, '带编号的频道模式，命中 `channel:0:*` 到 `channel:4:*`。'],
  [1813, 'reset 清空该用户的全部规则，是规则链的逆操作。'],
  [1815, 'reset 只 append 一个参数即跳出。'],
  [1816, 'rule_type 为 9 或越界时生成一条组合规则。'],
  [1817, '50% 允许 read，50% 拒绝 dangerous。'],
  [1818, '允许只读类别，常见的安全配置。'],
  [1820, '拒绝危险类别，与 +@read 构成一正一反。'],
  [1822, '组合规则处理完跳出 switch。'],
];

const { isWeakBlock } = await import('./vk-gate.mjs');
const weak = E.filter(([, t]) => isWeakBlock([t]));
if (weak.length) {
  console.error(`WEAK ${weak.length}: ${weak.map(([n]) => n).join(',')}`);
  process.exit(3);
}

const want = new Set(
  fs
    .readFileSync('d:/code/_annot_baseline/VK-B73b-target.txt', 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter((c) => c[0] === REL)
    .map((c) => Number(c[1]))
    .filter((n) => n >= START && n <= END),
);
const have = new Set(E.map(([n]) => n));
const missing = [...want].filter((n) => !have.has(n) && !SKIP.has(n));
const extra = [...have].filter((n) => !want.has(n));
const dup = E.map(([n]) => n).filter((n, i, a) => a.indexOf(n) !== i);
const skipOutside = [...SKIP].filter((n) => !want.has(n));
if (missing.length || extra.length || dup.length || skipOutside.length) {
  console.error(`MISMATCH missing=${missing.length} extra=${extra.length} dup=${dup.length} skipOutside=${skipOutside.length}`);
  if (missing.length) console.error('missing: ' + missing.join(','));
  if (extra.length) console.error('extra: ' + extra.join(','));
  if (dup.length) console.error('dup: ' + dup.join(','));
  process.exit(2);
}

const ops = E.map(([line, text]) => ({
  line,
  expect: src[line - 1].trim(),
  lines: ['// ' + text],
}));
fs.writeFileSync(`${DIR}/spec.json`, JSON.stringify([{ file: REL, ops }], null, 2) + '\n', 'utf8');
console.log(`entries=${ops.length} skipped=${SKIP.size} slice=${START}..${END} -> ${DIR}/spec.json`);
