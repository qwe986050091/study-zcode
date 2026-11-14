// B73c：src/fuzzer_command_generator.c 第三片（未覆盖单元行 2085–2797，共 246）。
// 输入：VK-B73c/orig/src/fuzzer_command_generator.c（HEAD 快照，已含 B73a/B73b，UTF-8/LF）
// 输出：VK-B73c/spec.json
// 对账：E 必须等于 VK-B73c-target.txt 中本文件的全部行；切片起于 generateStringArgValue 的
//       候选表（2085），止于 generateCmd 结尾（2797），即文件尾。
import fs from 'node:fs';

const DIR = 'd:/code/_annot_baseline/VK-B73c';
const REL = 'src/fuzzer_command_generator.c';
const START = 2085;
const END = 2797;
const src = fs.readFileSync(`${DIR}/orig/${REL}`, 'utf8').replace(/\r\n/g, '\n').split('\n');

const SKIP = new Set();

const E = [
  // ---- generateStringArgValue：候选表 ----
  [2085, '用户名候选 5 个，用于 `username` 参数；长度都远小于 64，不会触发 ACL 名字长度校验。'],
  [2086, '命令名候选 7 个，覆盖读写与 pubsub；`command-name` 与 `command` 共用这张表。'],
  [2087, '类型名候选 6 个，用于 TYPE/OBJECT ENCODING 等 `type` 参数。'],
  [2088, '客户端能力候选，`CLIENT NO-EVICT` 之外的能力开关靠它覆盖。'],
  [2089, 'keyspace 通知事件名，`event` 参数从这 6 个里取。'],
  [2090, 'INFO 的 section 候选表，共 16 项，覆盖 server 到 latencystats。'],
  [2091, '首项 all 返回全部 section，是 INFO 最常见的用法。'],

  // ---- generateStringArgValue：按名分派 ----
  [2111, '从 `commands` 里随机取一条，取模基数由 sizeof 求得。'],
  [2116, '从 `usernames` 里随机取一个，用于 ACL 相关命令的用户名参数。'],
  [2118, '密码形如 `pass<N>`，0..999 的编号保证重复率低。'],
  [2120, '频道号只取 0/1，让订阅端与发布端更容易撞到同一频道。'],
  [2122, '先声明，两个分支各自用 sdscatprintf 分配。'],
  [2125, '集群模式把 slot tag 拼在 key 最前面，保证同命令的 key 同槽。'],
  [2127, '非集群模式直接 `key:<n>`，不引入 tag。'],
  [2129, 'key 所有权转交 `cmd->argv`。'],
  [2131, 'field 编号 0..19，配合 20 个字段以内的哈希命令。'],
  [2135, '95% 的小值分支：1B..1KB，覆盖常规编码路径。'],
  [2143, '`sdsnewlen` 分配未初始化缓冲区，下面用 memset 填充。'],
  [2144, '整块填 `x` 而不是 \\0：要让 RESP 发送真实的 value_size 字节。'],
  [2145, 'value 所有权转交 `cmd->argv`。'],
  [2153, '外层加引号，使 RESTORE 把它当 RDB 载荷字符串而不是二进制。'],
  [2157, 'member 编号 0..49，三组 member 名共用此分支。'],
  [2159, '主机名形如 `host-N.example.com`，覆盖 DNS 解析失败路径。'],
  [2161, '私网地址 192.168.0.0/16，避免真的连到外网。'],
  [2163, '消息体 `message-N`，0..999 保证 PUBLISH 内容各不相同。'],
  [2165, '名字 `name-N`，0..19，用于 ACL 用户名或流名称。'],
  [2167, '消费者组名 `group-N`，0..9 与 XGROUP 的参数对齐。'],
  [2169, '消费者名 `consumer-N`，0..14。'],
  [2171, '流 ID `毫秒-序号`，两段都 0..999，格式合法但不连续。'],
  [2173, 'start/end 在数值区间里取 0..999，与 2178 行的 min 同量级。'],
  [2175, '字典序命令改走 `generateLexRangeValue`，否则 `[a1` 与数值语义冲突。'],
  [2176, '生成 `[v` / `(v` / `-` / `+` 四种形态之一。'],
  [2178, '数值区间下界 0..49，保证小于 max。'],
  [2181, 'max 同样先判断字典序命令。'],
  [2182, '与 min 共用同一生成器，方向由 argName 决定。'],
  [2184, '数值区间上界 50..99，恒大于 2178 行的 min。'],
  [2187, '从 `types` 随机取类型名。'],
  [2189, '从 `capabilities` 随机取能力名。'],
  [2194, '从 16 项 `sections` 随机取一个 INFO 段名。'],
  [2196, '从 `events` 随机取一个通知事件名。'],
  [2198, '路径 `/path/to/file<N>`，0..9；不指向真实文件，只测路径解析。'],
  [2200, '前缀模式 `prefix:N:`，0..4，用于 SCAN MATCH。'],
  [2202, '为嵌套生成单独开一条命令壳，避免污染外层 argv。'],
  [2203, '复用 `generateCommandsWithLua`，借它产出完整的 EVAL 脚本。'],
  [2206, '取走 `argv[1]` 的副本后立即释放整条子命令。'],
  [2208, '函数名 `myfunc<N>`，0..4，与 2210 行的库名对应。'],
  [2210, 'FUNCTION LOAD 的脚本体：#!lua 头加一个注册函数，换行用 \\n 保持单行。'],
  [2213, '库名 `lib<N>`，0..4，与函数名的编号空间一致。'],
  [2215, '版本号 x.y.z，每段 0..9，格式合法。'],
  [2219, '40 位十六进制 node-id：5 个 `%08x` 拼成 40 字符。'],
  [2224, '位宽候选 1/2/4/8/16/32/64，`encoding` 只能是这些值。'],
  [2225, '`i`/`u` 加位宽，构成 BITFIELD 要求的有符号/无符号编码。'],
  [2227, '旧格式地址带端口 6379..7378，覆盖 MIGRATE 的目标端口解析。'],
  [2229, 'runid/replicationid 同样是 40 位十六进制。'],
  [2232, 'sha1 用同一套 40 位十六进制格式，长度对得上。'],
  [2236, '流 ID `毫秒-序号`，与 2171 行同格式。'],
  [2238, '空闲时间阈值 0..9999 毫秒。'],
  [2240, '连接名 `conn-N`，0..19。'],
  [2242, '主节点名 `primary-N`，0..4。'],
  [2244, '命令类别名 10 项，覆盖 connection 到 scripting。'],
  [2246, '从 `categories` 随机取类别，取模由 sizeof 求得。'],
  [2248, '客户端 flag 字符 20 个，大小写各自代表不同语义。'],
  [2250, '随机取一个 flag 字符，用于 CLIENT LIST 的过滤参数。'],
  [2252, '元素名 `elem-N`，0..29。'],
  [2254, 'pivot 名 `pivot-N`，0..9，用于 LMPOP/ZMPOP。'],
  [2256, '配置参数名 5 个，覆盖内存、超时、持久化。'],
  [2257, '从 `params` 随机取一个配置名。'],
  [2262, '子命令名 6 个，覆盖 get/set/reset 等公共子命令。'],
  [2263, '从 `subcmds` 随机取一个子命令名。'],
  [2265, 'stop 参数 50% 是数值，50% 是 `-`/`+` 边界。'],
  [2266, '数值形态 0..999。'],
  [2268, '边界形态只取 `-` 或 `+`，对应无穷。'],
  [2270, '模块名 `module-N`，0..99。'],
  [2272, '参数名 `arg<N>`，0..9。'],
  [2274, '阈值 0..29，用于 LATENCY/MEMORY 类命令。'],
  [2276, '4 个指标名固定，`rand() % 4` 与长度一致。'],
  [2277, '从 `metrics` 随机取指标名。'],
  [2279, '地址交给 `generateRandomAddress`，端口与 IPv4/主机名形态在那边决定。'],

  // ---- isBlockingCommand / isBlockingTimeout ----
  [2288, '只看 `CMD_BLOCKING` 位：置位即阻塞命令，后续 timeout 会被钳制成 1。'],
  [2296, '参数名或父命令名缺失时无法判断，返回 0 不钳制。'],
  [2297, '`return 0`，信息不全时按非阻塞超时处理。'],
  [2302, '参数名不是 timeout 直接返回 0，CLIENT KILL TIMEOUT 不走钳制。'],

  // ---- addArgumentToCommand ----
  [2328, '只有 MULTIPLE 位才可能重复，默认 repeat_count=1。'],
  [2332, 'WEIGHTS 的个数必须等于 numkeys，否则 ZUNION 直接 -ERR。'],
  [2334, '其余 MULTIPLE 参数 1/30 概率重复 1..3 次，避免参数爆炸。'],
  [2338, '按 repeat_count 循环，KEY 分支会在循环内 break 提前退出。'],
  [2341, 'token 先于值追加，保证 WEIGHTS 这类前缀出现在数值之前。'],
  [2342, 'PURE_TOKEN 追加完即 continue，不能再生值。'],
  [2347, 'numkeys 取 1..MAX_DEFAULT_NUMKEYS，并写回 client_ctx 供 KEY 分支使用。'],
  [2348, 'numkeys 本身作为一个整数参数发送。'],
  [2349, 'numkeys 只应出现一次，把 repeat_count 压回 1。'],
  [2351, 'ONEOF 随机选中一个子参数。'],
  [2357, '临时清掉 OPTIONAL 位，保证 ONEOF 至少产出一个选项。'],
  [2358, '`addArgumentToCommand` 递归生成选中的子参数。'],
  [2359, '递归后必须恢复 flags，否则同一节点下次被选会永久丢掉可选性。'],
  [2361, '有参数名才走按名生成，无名的字符串只能给通用值。'],
  [2367, '按名生成，`generateStringArgValue` 负责具体形态。'],
  [2370, '无名参数兜底 `string-value`，保证 RESP 合法。'],
  [2381, '普通整数取 1..DEFAULT_INTEGER_MAX，避免 0 触发边界分支。'],
  [2388, '阻塞命令的 double timeout 落在 0..1 秒，几乎立刻返回。'],
  [2390, '普通 double 在 [DEFAULT_DOUBLE_MIN, DEFAULT_DOUBLE_MAX) 内均匀取值。'],
  [2391, '`%f` 输出 6 位小数，是 RESP 合法浮点文本。'],
  [2394, '以当前时间为基准，保证时间戳尚未过期。'],
  [2397, '`%jd` 对应 intmax_t，避免 32 位平台截断。'],
  [2399, 'PATTERN 一律给 `*`，匹配全部 key，测遍历路径。'],
  [2403, 'KEY 分支用 `client_ctx->numkeys` 且 break，不再按 repeat_count 循环。'],
  [2405, 'BLOCK 递归展开每个子参数，顺序保持文档顺序。'],
  [2406, '子参数可能还有自己的 ONEOF/MULTIPLE，递归生成。'],

  // ---- generateCommandArguments ----
  [2419, '按文档顺序遍历参数，numkeys 必然先于 key 出现。'],
  [2420, '每个顶层参数交给 `addArgumentToCommand`。'],

  // ---- 订阅模式 ----
  [2430, '订阅表的条目地址，稍后按状态迁移决定是否清订阅态。'],
  [2431, '在 9 项白名单里随机选，取模基数是动态的 `subscribeCommandRegistrySize`。'],
  [2432, '取到条目后只在 2435 行读 fullname，不修改其内容。'],
  [2439, '`in_subscribe_mode` 置 0，下一轮回到普通命令采样。'],
  [2440, '订阅类型归零，与 `in_subscribe_mode` 同步复位。'],
  [2443, '返回选中的条目，`generateSingleCmd` 据此取 `fullname`。'],
  [2452, 'SUBSCRIBE 对应类型 0。'],
  [2453, '0 与 `handlePubSubCommandSelection` 里的 UNSUBSCRIBE 判定配对。'],
  [2455, 'SSUBSCRIBE 对应类型 2，退出要用 SUNSUBSCRIBE。'],
  [2457, 'PSUBSCRIBE 对应类型 1，退出要用 PUNSUBSCRIBE。'],
  [2459, '不是三种 SUBSCRIBE 就直接返回，不改变订阅态。'],
  [2461, '只有 2452/2454/2456 三个分支能走到这里，置位订阅态。'],

  // ---- generateSingleCmd ----
  [2476, '`selectedCommand` 在普通路径与订阅路径都会赋值。'],
  [2479, '`rand() % commandRegistrySize` 在完整注册表里随机取一条。'],
  [2480, '取条目地址，供 2481 行检查 `CMD_NOSCRIPT`。'],
  [2483, '`in_subscribe_mode` 为真时改走白名单选择，覆盖上面的随机结果。'],
  [2484, '订阅态只允许 9 条命令，避免 EVAL/MULTI 被服务端拒绝。'],
  [2489, 'CONFIG SET 走独立生成路径，返回值必须从配置快照取。'],
  [2490, '生成后立即 `return`，不再追加参数或更新订阅态。'],
  [2498, '`strchr` 跳到第一个空格之后，长度用 strlen-strcspn 计算。'],
  [2499, '命令名与子命令分两个 argv，服务端按两段解析。'],
  [2500, '`strchr` 已跳过空格，`subCommand` 不含前导空格。'],
  [2502, '`strstr` 返回 NULL 时整串就是命令名。'],
  [2507, '`info.args` 非空才生成，模块命令可能没有参数。'],

  // ---- generateCommandsWithLua ----
  [2533, '脚本以 `local result = {}` 开头，逐条收集 redis.call 的返回值。'],
  [2540, '每条子命令单独开壳，避免复用外层 cmd 的 argv。'],
  [2541, '递归生成单条命令，其中 `CMD_NOSCRIPT` 会被跳过。'],
  [2542, '把子命令包成 `redis.call(...)` 并记到 result 数组。'],
  [2545, '`subCommand->argv[j]` 以带引号的字符串形式拼进脚本。'],
  [2549, '每条调用之间补一个空格，分隔相邻的 redis.call。'],

  // ---- 损坏命令 ----
  [2569, '少于 3 个参数（命令名加 2 个）无需交换，直接返回。'],
  [2571, '只交换 2 对，足以打乱顺序又不至于完全失去结构。'],
  [2572, '下标从 1 开始，刻意保留 `argv[0]` 命令名。'],
  [2573, '第二个下标独立随机，可能与 idx1 相同。'],
  [2574, '`idx1 == idx2` 时跳过，交换强度本身是概率性的。'],
  [2575, '暂存 sds 指针，交换只动指针不动内容。'],
  [2576, '交换后两个参数的所有权随指针转移。'],
  [2577, '写回 `argv[idx2]`，完成一次交换。'],
  [2590, '五类损坏输入等概率分派，default 与 case 4 合并。'],
  [2591, '随机二进制：含 \\0 与高位字节，最易触发字符串处理的边界。'],
  [2593, '长度 10..25 字节。'],
  [2594, '`sdsnewlen` 分配未初始化缓冲区。'],
  [2595, '只写 len-1 个字节，末字节保留 sds 的 \\0。'],
  [2596, '每个字节 0..255，包含 \\0 与 \\r\\n 等 RESP 分隔符。'],
  [2597, '返回缓冲区，所有权转交调用方。'],
  [2599, '超长字符串：1KB..1151B，触发 SDS 大对象与网络分片路径。'],
  [2601, '长度 1024..1151，必然超过 sds 的 inline 上限。'],
  [2602, '`sdsnewlen` 按长度分配，下面整块填充。'],
  [2603, '统一填同一个字母，长度是唯一变量，便于定位解析问题。'],
  [2604, '返回长串，末字节仍是 \\0。'],
  [2606, '空串：0 长度 bulk，测 RESP 的空 bulk 分支。'],
  [2607, '`sdsnew("")` 返回长度 0 的 sds，而不是 NULL。'],
  [2608, '特殊字符：CR/LF、引号、反斜杠与 RESP 元字符。'],
  [2609, '`sdsnew` 把 \\r\\n 放进参数内容，检验服务端的长度前缀解析。'],
  [2610, '非法数字：让 strtoll/strtod 的部分解析行为暴露。'],
  [2611, 'default 与 case 4 合并，rand()%5 的 4 落到这里。'],
  [2612, '5 个非法数字样本，覆盖尾随字符、双符号与浮点特例。'],
  [2613, '随机取一个非法数字，取模 5 与数组长度一致。'],
  [2620, '`rand() % cmd->argc` 随机挑一个参数位，可能选中命令名。'],
  [2624, '先释放原 sds，再换成损坏值，避免泄漏。'],
  [2625, '损坏值由 `createCorruptedArg` 分配，所有权转交 argv。'],
  [2630, '`cmd->argc <= 1` 时无可删除，直接返回。'],
  [2632, '下标从 1 开始，命令名不参与删除。'],
  [2637, '`argv[k] = argv[k + 1]` 整体左移一格，覆盖被删槽位。'],
  [2639, '长度递减后，末尾的重复指针不再参与遍历。'],
  [2645, '容量已满则放弃插入，`appendArg` 的扩容逻辑不在这里复用。'],
  [2647, '先置 NULL，switch 的三个分支都会赋值。'],
  [2648, '`rand() % 3` 三类多余参数等概率分派。'],
  [2649, '随机字符串：长度固定，只测「多一个参数」。'],
  [2651, '赋值后跳出 switch。'],
  [2652, 'case 1 随机数字：覆盖数值解析器对多余数字的处理。'],
  [2654, '`sdsfromlonglong` 生成十进制文本。'],
  [2655, '特殊字符：与 2609 行同类，但作为多余参数出现。'],
  [2656, '含 CR/LF 的参数最容易破坏 RESP 帧边界。'],
  [2657, '赋值后跳出 switch。'],
  [2662, '从尾部整体右移，给 pos 腾出空位。'],
  [2663, '逐格后移，循环结束时 pos 槽可写。'],
  [2665, '写入新参数，所有权转交 argv。'],
  [2666, '长度递增，新参数进入有效区间。'],
  [2676, '生成后参数仍不足 2 个则无法损坏，直接返回。'],
  [2681, '损坏 1..3 次，次数越多越偏离原命令。'],
  [2682, '`rand() % 4` 四类损坏等概率分派。'],
  [2683, '交换参数顺序，保留命令名。'],
  [2684, 'case 1 调用 `corruptArgument` 替换单个参数内容。'],
  [2685, '删除一个参数。'],
  [2686, 'case 3 调用 `addRandomArgument` 插入一个多余参数。'],

  // ---- cleanupFuzzer ----
  [2695, '未初始化时直接返回，重复调用安全。'],
  [2696, '`commandRegistry` 非空才遍历释放。'],
  [2697, '逐条 freeCommandEntry，递归释放参数树。'],
  [2698, '`freeCommandEntry` 只放内部指针，条目本身随数组一次性分配。'],
  [2700, '全部条目释放完再释放数组本身。'],
  [2703, '订阅表只释放数组：内部指针与注册表共享，不能二次 free。'],
  [2704, '值拷贝的条目由 2698 行统一释放。'],
  [2707, '`configDict` 非空才释放。'],
  [2708, '`dictRelease` 会按 dictType 回调释放 sds key 与 ConfigEntry。'],
  [2711, 'ACL 分类名逐个 sdsfree 后再释放数组。'],
  [2713, '最后 `zfree(fuzz_ctx)` 释放全局上下文。'],
  [2714, '置空使 `cleanupFuzzer` 可重复调用。'],

  // ---- 线程上下文 ----
  [2723, '每线程一个上下文，`generateSingleCmd` 无条件解引用它。'],
  [2724, '新连接默认不在 MULTI 中。'],
  [2725, '`in_subscribe_mode` 置 0，新连接默认不在订阅态。'],
  [2726, '订阅类型归零，与 `in_subscribe_mode` 同步。'],
  [2727, '默认不在 Lua 脚本内，`CMD_NOSCRIPT` 过滤不生效。'],
  [2728, 'slot tag 懒生成，初始为 NULL。'],
  [2729, 'numkeys 默认 1，没有 numkeys 参数的命令按 1 个 key 生成。'],
  [2730, '`fuzz_flags` 决定 CONFIG SET 与 malformed 模式是否开启。'],
  [2732, '线程级重新播种，避免线程 0 与线程 N 生成同一条序列。'],
  [2738, '上下文未初始化（如连接失败）时直接返回。'],
  [2739, '重连后事务必然中断，复位 MULTI 状态。'],
  [2740, '新连接不在订阅态，无需发 UNSUBSCRIBE 收尾。'],
  [2741, '`subscribe_type` 同步归零。'],
  [2742, 'Lua 标志复位，避免影响后续命令的 `CMD_NOSCRIPT` 过滤。'],
  [2743, 'tag 非空才释放，懒生成可能从未触发。'],
  [2744, '`current_slot_tag` 由 `generateSlotTag` 的 sdscatprintf 分配。'],
  [2745, '`current_slot_tag` 置空，让下一轮重新选槽。'],
  [2751, '上下文为空直接返回，避免解引用未初始化的指针。'],
  [2752, 'tag 非空才释放，懒生成可能从未触发。'],
  [2753, '`sdsfree` 与 `generateSlotTag` 的 sdscatprintf 成对。'],
  [2755, '`zfree(client_ctx)` 释放上下文本身。'],
  [2756, '置空防止重复释放。'],

  // ---- generateCmd ----
  [2769, '`allocCommand` 先分配命令壳，三条分支都复用它。'],
  [2773, 'malformed 模式立即返回损坏命令，不再叠加事务或 Lua 状态。'],
  [2774, '损坏命令已经生成完毕，直接 `return cmd`。'],
  [2777, '已在 MULTI 中，优先考虑是否发 EXEC 闭合事务。'],
  [2778, '1/MULTIEXEC_END_PROBABILITY 概率结束事务。'],
  [2779, '先清状态再 append EXEC，避免下一轮仍认为在事务中。'],
  [2780, 'EXEC 是唯一能把 MULTI 闭合的命令。'],
  [2781, '返回 EXEC，不再生成其它命令。'],
  [2785, 'LUA_SCRIPT_PROBABILITY 概率走 Lua，订阅态下禁用。'],
  [2786, '生成完整的 EVAL 脚本命令。'],
  [2788, '开新事务：先置位再 append MULTI，保证下一轮进入 2777 行分支。'],
  [2789, 'MULTI 作为本轮唯一命令发送。'],
  [2791, 'else 分支调用 `generateSingleCmd` 生成普通单命令。'],
  [2794, '每轮结束释放 tag，下一条命令重新选槽。'],
  [2795, '置空后 `ensureSlotTag` 会在下一轮重新生成。'],
  [2797, '返回本轮的完整命令，调用方负责发送与 `freeCommand`。'],
];

const { isWeakBlock } = await import('./vk-gate.mjs');
const weak = E.filter(([, t]) => isWeakBlock([t]));
if (weak.length) {
  console.error(`WEAK ${weak.length}: ${weak.map(([n]) => n).join(',')}`);
  process.exit(3);
}

const want = new Set(
  fs
    .readFileSync('d:/code/_annot_baseline/VK-B73c-target.txt', 'utf8')
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
