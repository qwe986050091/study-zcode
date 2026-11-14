// B73a：src/fuzzer_command_generator.c 第一片（未覆盖单元行 1–942，共 281）。
// 输入：VK-B73a/orig/src/fuzzer_command_generator.c（HEAD 快照，UTF-8/LF）
// 输出：VK-B73a/spec.json
// 对账：E 必须等于 VK-B73a-target.txt 中本文件的全部行；切片止于 updateCommand 结束（942），
//       943 起是 extractCommandFlags，归 B73b。
import fs from 'node:fs';

const DIR = 'd:/code/_annot_baseline/VK-B73a';
const REL = 'src/fuzzer_command_generator.c';
const START = 1;
const END = 942;
const src = fs.readFileSync(`${DIR}/orig/${REL}`, 'utf8').replace(/\r\n/g, '\n').split('\n');

// 本片没有刻意跳过的行；若插入后仍有未覆盖单元，收尾时统一列为结构性豁免。
const SKIP = new Set();

const E = [
  // ---- 概率/规模常量 ----
  [57, '单条 Lua 脚本最多拼 5 条命令，`generateCommandsWithLua` 用它做循环上界，防止 EVAL 报文过长。'],
  [59, '`ARG_TYPE_DOUBLE` 的取值下界 1.0，与 `DEFAULT_DOUBLE_MAX` 配对使用，避免生成 0 或负值。'],
  [60, '`ARG_TYPE_DOUBLE` 的取值上界 50.0；上下界都为正，因此随机值不会落到浮点特殊区间。'],
  [61, '`ARG_TYPE_UNIX_TIME` 取「当前秒 + rand()%60」，60 秒窗口保证时间戳在发送时尚未过期。'],
  [62, '可选参数按 1/2 概率生成：`rand() % OPTIONAL_ARG_PROBABILITY == 0` 时跳过，缺参与全参都能测到。'],

  // ---- 枚举与结构体 ----
  [90, '配置值类型枚举：决定 `generateRandomConfigValue` 走哪个分支，由 `addConfigEntry` 判定一次后固化。'],
  [91, '字符串是默认档：`determineConfigValueType` 对非 bool、非整数一律回落到这里。'],
  [109, '参数名，用作日志与调试标识；子参数与父参数同名时靠 `token` 区分。'],
  [110, '值类型来自 COMMAND DOCS 的 type 字段，`mapArgumentType` 未识别时回落 `ARG_TYPE_STRING`。'],
  [111, '固定字面量（如 LIMIT/WEIGHTS），非空时 `addArgumentToCommand` 原样 append，不再生成随机值。'],
  [112, '`CMD_ARG_OPTIONAL` / `CMD_ARG_MULTIPLE` / `CMD_ARG_MULTIPLE_TOKEN` 位图，控制可跳过与可重复次数。'],
  [113, '`subargs` 数组长度；仅 type 为 ONEOF/BLOCK 时非零，zcalloc 保证空值即合法初值。'],
  [114, '递归子参数数组，`processSubarguments` 用 zcalloc 分配后交给 `parseCommandArguments` 填充。'],
  [115, '指向最外层 `CommandInfo`，子参数读 group/flags 时沿此链上溯，刻意不指向 block 中间节点。'],
  [123, '命令名（顶层为全大写），`updateCommand` 用 strcasecmp 与 COMMAND 输出对账。'],
  [124, '除命令名之外的参数个数，`parseCommandArguments` 按它遍历并填充 `args`。'],
  [125, '参数描述数组，长度 `argCount`；空命令为 NULL，`freeCommandArguments` 会跳过。'],
  [127, '`CMD_*` 位图，只被两处消费：Lua 脚本排除 `CMD_NOSCRIPT`、识别 `CMD_BLOCKING` 以钳制 timeout。'],
  [131, '命令条目：`argv`/`arity` 用于发送，`info` 保存解析出的参数与 flag 元数据。'],
  [132, '`argv` 有效长度（含命令名），发送前与 `arity` 比对以过滤参数个数不符的条目。'],
  [133, '命令名与各参数；`argv[0]` 恒为字符层，`freeCommand` 逐项 sdsfree。'],
  [134, '`fullname` 含子命令、以空格分隔，作为日志与注册表的展示名。'],
  [135, '正数表示参数个数恰为该值，负数表示至少 |arity| 个；0 表示尚未从 COMMAND 输出回填。'],
  [148, 'CONFIG GET 时刻的值快照：既作随机量级基准，也作枚举未列出时的兜底输出。'],
  [149, '`addConfigEntry` 判定一次后固化，后续即使服务端值变化也不再重算。'],
  [154, '一次性分配的顶层命令数组，长度由 `countTotalCommands` 预扫描确定。'],
  [155, '注册表长度，`updateCommand` 与过滤逻辑都按它遍历。'],
  [156, '订阅类命令单独存一份，避免普通采样抽到 SUBSCRIBE 把连接拖进订阅态。'],
  [157, '订阅注册表长度，`handlePubSubCommandSelection` 用它随机选一条。'],
  [158, 'CONFIG GET * 的解析结果，键为 sds、值为 `ConfigEntry`，`configDictType` 定义析构。'],
  [159, 'ACL CAT 返回的分类名数组，供 `generateAclRule` 拼 +@category 规则。'],
  [160, '`aclCategories` 的元素数；`freeAclCategories` 按它逐项释放。'],
  [161, 'key 空间上界，`addKeysToCommand` 取 rand()%max_keys 作为 key 编号。'],
  [162, '集群模式开关：为真时 `ensureSlotTag` 生成 {hashtag}，保证同命令的 key 落同一槽。'],
  [170, 'MULTI 已开未 EXEC 时置 1，`generateSingleCmd` 据此决定是否补发 EXEC。'],
  [171, '进入订阅态后普通命令一律跳过，只允许 SUBSCRIBE/UNSUBSCRIBE 类切换。'],
  [172, '记录订阅类型 0/1/2，退出时用对应的 UNSUBSCRIBE/PSUBSCRIBE/SSUBSCRIBE 收尾。'],

  // ---- mapFlagType ----
  [190, '匿名结构体表：`CMD_*` 位与 COMMAND 输出里的字符串名一一对应。'],
  [191, '`CMD_*` 位值，大小写与 server.h 的枚举保持一致。'],
  [192, '字符串名，来自 COMMAND 输出的 flags 数组，匹配时用 strcasecmp 忽略大小写。'],
  [194, '表首项 write：让服务端把命令计入写命令统计，也是判断是否写命令的依据。'],
  [229, '`flagStr` 为 NULL 直接返回 0：调用方可能把缺失的 flags 字段传进来。'],
  [231, '哨兵项 {0,NULL} 终止循环，因此数组末尾那一行不能删。'],
  [232, '用 strcasecmp：COMMAND 输出的 flag 大小写随版本变化，精确比较会整表失配。'],
  [233, '命中即返回对应 `CMD_*` 位，多个 flag 由 `updateCommand` 按位或累加。'],
  [237, '未识别 flag 返回 0 而非报错：上游新增 flag 时旧生成器仍能继续工作。'],

  // ---- mapArgumentType ----
  [246, '类型映射表：COMMAND DOCS 的 type 字符串到 `ARG_TYPE_*` 枚举。'],
  [247, '规范小写类型名，`mapArgumentType` 用 strcmp 精确匹配，区分大小写。'],
  [248, '对应的 `ARG_TYPE_*` 枚举值，传给 `addArgumentToCommand` 决定生成方式。'],
  [250, '首项 string 同时是未命中返回值 0 的语义目标，所以 267 行的降级是安全的。'],
  [261, '以 {NULL,0} 哨兵结束遍历。'],
  [262, '精确比较，避免 "String" 被当成合法类型。'],
  [263, '命中返回枚举值，调用方将其存入 `CommandArgument.type`。'],
  [267, '未知类型回落到 0，而 0 正是 `ARG_TYPE_STRING`，至少还能触发 arity 校验。'],

  // ---- mapGroupType ----
  [272, '分组映射表：服务端 group 字符串到 `CMD_GROUP_*` 枚举。'],
  [273, '分组名，来自 COMMAND DOCS；匹配用 strcasecmp 忽略大小写。'],
  [274, '目标枚举，值写进 `CommandInfo.group`，供 `addKeysToCommand` 选择 key 前缀。'],
  [276, '首项 string；缺分组时统一回落 `CMD_GROUP_UNKNOWN`，不能默认成 GENERIC。'],
  [291, 'group 字段缺失时按 UNKNOWN 处理，选 key 时退回通用前缀。'],
  [293, '哨兵项 {NULL, CMD_GROUP_UNKNOWN} 同时是循环终止条件。'],
  [294, '忽略大小写匹配，兼容 sorted-set 与 sorted_set 两种写法。'],
  [295, '命中返回分组；280 行与 281 行的两种拼写映射到同一枚举。'],
  [299, '整表扫描未命中，返回 UNKNOWN，让调用方走 GENERIC 前缀而不是猜类型。'],

  // ---- allocCommand / appendArg / freeCommand ----
  [306, '分配命令壳；zmalloc 失败直接 abort，fuzz 工具不做部分降级。'],
  [307, '`argc` 是有效长度，与 `size` 分离：`appendArg` 只在 argc 追平 size 时扩容。'],
  [308, '初始 16 个槽，多数命令参数少于此值，避免逐次 realloc。'],
  [309, '按槽位分配 sds 指针数组，尾部未清零，调用方只能用 [0,argc)。'],
  [310, '返回未置任何参数的空白命令，首参由调用方 append。'],
  [316, '只有写满才扩容，等于边界时也必须扩，否则下一行会越界。'],
  [317, '容量翻倍，摊还 O(1)，避免每次 append 都 realloc。'],
  [318, '`zrealloc` 失败即 abort，旧数组不会泄漏。'],
  [320, '先写后自增：`argc` 始终等于已写入元素数，sds 所有权转交 `argv`。'],
  [326, '只释放 [0,argc) 区间，尾部空槽本就没有 sds。'],
  [327, '每个参数由 `appendArg` 独占持有，无需引用计数或去重。'],
  [329, '先释放参数数组，再释放结构体。'],
  [330, '最后释放命令壳，与 `allocCommand` 的 zmalloc 成对。'],

  // ---- printCommand ----
  [339, '每线程一份静态缓冲区：返回值在下一次 `printCommand` 前有效，不能跨线程缓存。'],
  [340, '`offset` 记录已写长度，同时是 snprintf 的目标偏移。'],
  [342, '先置空串，argc 为 0 时返回空字符串而不是上一轮残留。'],
  [343, '逐参数拼接，顺序与发送顺序一致，便于对照抓包。'],
  [344, '用 sdslen 取长度，容忍参数内含 \\0。'],
  [345, '超过 50 字节截断，避免一条超长 bulk 把终端刷屏。'],
  [346, '截断并以 ... 标记省略；snprintf 返回「应写长度」而非实际写入量。'],
  [348, '短参数用 `%s ` 原样输出，尾随空格用于与下一个参数分隔。'],
  [353, '`offset` 已推到接近末尾，继续写会越界，提前结束。'],
  [357, '返回线程局部缓冲区，有效期到下一次调用。'],

  // ---- configDict 相关 ----
  [364, 'configDict 的 key 实际是 sds，这里按 C 字符串算 hash，与 `sdsHash` 的语义不同。'],
  [367, '值析构：先释放 `ConfigEntry.value`，再释放条目本身。'],
  [368, 'dict 存的是 void*，取出时转回 `ConfigEntry`。'],
  [369, '`value` 由 sdsnew 分配，必须用 sdsfree 而非 zfree。'],
  [370, '条目由 `addConfigEntry` 的 zmalloc 分配，与 zfree 成对。'],
  [373, 'sds key 比较：先比长度再 memcmp，允许 key 内含 \\0。'],
  [374, '先声明两个长度，避免在多次 sdslen 调用中重复展开。'],
  [375, '长度不同必然不相等，提前返回可省一次 memcmp。'],
  [376, '与 l1 对称，两个 key 都来自 dict 持有的 sds。'],
  [377, '返回 0 表示不相等，dict 约定非零为相等。'],
  [378, '长度已校验，memcmp 的 l1 字节覆盖完整 key。'],
  [381, '`configDictType` 的 hashFunction，真正按 sdslen 计算。'],
  [382, '与 `sdsKeyCompare` 的长度口径一致，避免含 \\0 的 key 落错桶。'],
  [385, '整条 entry 析构：key 用 sdsfree，值交给 `configDictValDestructor`。'],
  [386, 'void* 转 `dictEntry*`，下面两个 dictGet 都基于它。'],
  [387, 'key 是 `addConfigEntry` 里 sdsnew 出来的，必须 sdsfree。'],
  [388, '复用值析构，保证 `ConfigEntry` 的释放逻辑只有一处。'],
  [389, '最后释放 dictEntry 外壳，由 dict 分配器申请。'],
  [400, '创建 configDict；dictType 是全局静态表，销毁时按它回调。'],
  [401, '传入 `configDictType`，使 key/val 析构自动生效。'],

  // ---- 配置类型判定 ----
  [407, '枚举型配置白名单，必须与 server.c 的枚举表保持同步。'],
  [408, '首项 repl-diskless-load：合法值 disabled/on-empty-db/swapdb/flush-before-load。'],
  [423, '`enumConfigs` 以 NULL 结尾，循环即遍历全部白名单。'],
  [424, 'CONFIG 名大小写不敏感，与服务端一致。'],
  [425, '命中白名单即枚举型，`addConfigEntry` 据此置 `CONFIG_TYPE_ENUM`。'],
  [428, '不在白名单则交给 `isSpecialConfig` 与按值判定。'],
  [434, '特殊型配置白名单：值由多个字段构成，必须整体构造。'],
  [435, '首项 dir 直接沿用当前值，改它会让后续 RDB 落到不可写路径。'],
  [445, '同样以 NULL 哨兵结束遍历。'],
  [446, '忽略大小写匹配，CONFIG GET 返回的是小写名。'],
  [447, '命中即特殊型，`generateRandomSpecialValue` 负责拼多字段值。'],
  [450, '非特殊型回落到 `determineConfigValueType` 按值猜类型。'],
  [459, 'yes/no 是唯一的布尔字面量，比较时大小写不敏感。'],
  [464, '十进制解析，返回值被丢弃，只看 endptr 是否停在结尾。'],
  [465, '同时排除空串与 12abc：前者 endptr==value，后者 endptr 不指结尾。'],
  [466, '纯整数才归 INT 分支，`generateRandomConfigValue` 按原值量级取随机。'],
  [478, '会让服务不可测的配置名单，`parseConfigOutput` 在入字典前调用过滤。'],
  [479, '首项 port 被过滤：改端口后重连会打到别处，后续命令全部失败。'],
  [492, 'key 为 NULL 时不过滤，交由调用方保证非空。'],
  [496, 'tls-* 用前缀匹配：TLS 配置随版本增减，逐项枚举必然漏。'],
  [499, 'NULL 哨兵结束白名单遍历。'],
  [500, '用 `strcasecmp` 忽略大小写匹配 `key` 与白名单项。'],
  [501, '命中即过滤，该配置连快照都不会进 `configDict`。'],
  [505, '未命中则保留，作为 CONFIG SET 的候选。'],
  [512, '先分配条目，再按类型填充 `value` 与 `type`。'],
  [513, '`sdsnew` 复制一份当前值，作为后续随机值的量级基准。'],
  [517, '枚举判定必须最先做：枚举值 no 也像 bool，后判会误分到 BOOL。'],
  [519, '特殊型次之，最后才用 `determineConfigValueType` 按值猜。'],
  [521, '普通配置按当前值猜 bool/int/string，只影响生成策略。'],
  [524, 'dict 的 key 必须独立分配，生命周期由 `dictEntryDestructorSdsKeyConfigVal` 管理。'],
  [525, 'key 为 sds、值为 `ConfigEntry`，dictType 的 hash/compare 均已配好。'],

  // ---- generateRandomEnumValue ----
  [532, '逐配置硬编码合法枚举，避免随机字符串被 CONFIG SET 拒绝而浪费采样预算。'],
  [533, '淘汰策略共 8 项，下标取 rand()%8，多一项少一项都会越界或漏值。'],
  [536, '随机取一条淘汰策略，取模基数必须与 `policies` 数组长度 8 一致。'],
  [538, 'loglevel 的 5 个合法档位，从 debug 到 nothing。'],
  [539, '取模 5 与 `levels` 数组长度对齐。'],
  [541, 'appendfsync 只有 3 种策略；no 与 bool 的 no 同名，但语义是落盘模式。'],
  [542, '取模 3 对应 3 项。'],
  [544, 'oom-score-adj 的 4 种模式，relative/absolute 需要额外数值配合。'],
  [545, '取模 4 对应 4 项。'],
  [547, 'acl-pubsub-default 决定新客户端的频道权限默认值。'],
  [548, '取模 2 对应 2 项。'],
  [550, '传播错误处理策略，panic 会让服务端主动退出。'],
  [551, '取模 3 对应 3 项。'],
  [553, '日志格式只剩 legacy/logfmt 两种。'],
  [554, '取模 2 对应 2 项。'],
  [556, '时间戳格式的 3 种取值。'],
  [557, '取模 3 对应 3 项。'],
  [559, 'RDB 版本校验严格度，strict 会拒绝高版本文件。'],
  [560, '取模 2 对应 2 项。'],
  [562, '无盘加载的 4 种模式，flush-before-load 会清空现有数据。'],
  [563, '取模 4 对应 4 项。'],

  // ---- generateRandomSpecialValue ----
  [576, 'save 必须成对给出「秒数 变更数」，单值会被参数校验拒绝。'],
  [584, '客户端类别三选一，取模 3 与 `classes` 长度一致。'],
  [585, '硬上限取 1..10MB，够大以免正常流量触发断连。'],
  [589, '四字段一次拼进同一条 CONFIG SET，缺一即被拒。'],
  [593, '空串表示关闭 keyspace 通知，是合法取值而非缺省。'],
  [607, '取模 14 必须与 `options` 的 14 项严格一致。'],
  [611, '`val2` 独立取 rand()%1000，三个分值之间无约束。'],
  [612, '第三个分值，与 val1/val2 一起拼成三字段值。'],
  [613, 'oom-score-adj-values 要求恰好三个整数，空格分隔。'],
  [617, '从空 sds 起累加，最终整体作为一个参数 append。'],
  [619, '生成 1..3 个百分位，个数参与是否补分隔空格的判断。'],
  [620, '把 rand() 归一到 0..100，得到合法百分位。'],
  [621, '`%.1f` 保留一位小数，与服务端解析格式一致。'],
  [622, '只有后面还有值时补空格，避免尾随空格。'],
  [623, '`sdscat` 追加单个空格，作为百分位字段的分隔符。'],
  [626, '整个 `percentiles` 列表作为一个参数 append 到 cmd。'],

  // ---- generateRandomConfigValue ----
  [644, '约定 `argv[2]` 是配置名，依赖调用方先 append CONFIG/SET/key。'],
  [646, '按 `addConfigEntry` 固化的类型分派，不再重判。'],
  [647, '布尔分支只输出 yes/no 两种字面量。'],
  [650, '每个 case 末尾 return，省掉 break 也不会贯穿到下一分支。'],
  [651, '整型分支用大括号限定 original/min/max 的作用域。'],
  [654, '下界取当前值一半：既测调小，也避免把内存类参数压到不可用。'],
  [655, '上界取当前值 5 倍，覆盖调大的方向。'],
  [659, 'maxmemory 下限 10MB，低于此值后续写命令会全部 OOM。'],
  [660, '只抬下界，上界仍按 original*5，保持区间有效。'],
  [665, 'maxmemory-clients 下限 2KB，防止客户端缓冲被瞬间打满。'],
  [666, '同样只抬下界，避免 max < min 的空区间。'],
  [669, '保证区间至少含 1 个整数，否则 670 行的取模分母为 0。'],
  [670, '在闭区间 [min,max] 均匀取值，分母 max-min+1 正是整数个数。'],
  [671, '整型处理完直接返回，不落入后续 case。'],
  [673, '枚举型转交 `generateRandomEnumValue` 按配置名选白名单。'],
  [674, '`config_name` 决定走哪张硬编码取值表，未列出的回落到当前值。'],
  [675, '转交后立即 return，避免落入 default 的字符串分支。'],
  [676, '特殊型转交 `generateRandomSpecialValue` 拼多字段值。'],
  [677, 'save/bind 等各自有独立格式，不能按普通字符串处理。'],
  [678, '同样在转交 `generateRandomSpecialValue` 后立即返回。'],
  [679, '字符串型与 default 合并，生成固定前缀加随机后缀。'],
  [680, '未知类型也走字符串分支，保证 CONFIG SET 始终有值可发。'],
  [683, 'switch 结束返回，函数无返回值。'],

  // ---- generateConfigSetCommand ----
  [692, '从全局上下文取 CONFIG GET * 的快照字典。'],
  [696, 'dict 的 key 是 sds，可直接当 C 字符串用。'],
  [697, '值携带固化类型与当前值，传给 `generateRandomConfigValue`。'],
  [701, '`argv[1]` 固定为 SET，`argv[2]` 才是配置名，顺序不可换。'],
  [702, '`argv[2]` 落位后，`generateRandomConfigValue` 才能从 argv[2] 读到配置名。'],

  // ---- ACL 分类 ----
  [712, '计数直接取回复元素数，而非实际填充数。'],
  [713, '按元素数分配；非 STRING 元素的槽不会被写，仍是未初始化指针。'],
  [715, '逐项过滤，只有 STRING 才分配 sds。'],
  [716, '非 STRING 直接跳过，对应槽保持未初始化。'],
  [717, '复制分类名，回复对象随后即可释放。'],
  [724, '未解析过 ACL CAT 时数组为空，直接返回避免 zfree(NULL)。'],
  [725, '按 `aclCategoriesCount` 逐项释放，与分配时的元素数一致。'],
  [726, '每个分类名都是 sdsnew 的结果，必须 sdsfree。'],
  [728, '`zfree` 释放 `aclCategories` 指针数组本身。'],
  [729, '`aclCategories` 置空，防止二次释放。'],
  [730, '`aclCategoriesCount` 同步归零，使空数组的状态自洽。'],

  // ---- parseConfigOutput ----
  [738, '`initConfigDict` 先建空字典，解析过程中逐条填入。'],
  [742, '回复元素为奇数时 i+1 越界，必须提前终止。'],
  [744, 'key 必须是 STRING，否则 `str` 字段不可用。'],
  [747, '偶数位 `element[i]` 是配置名。'],
  [748, '奇数位是值，与 key 成对出现。'],
  [753, '过滤后的配置才进字典，类型判定在 `addConfigEntry` 内完成。'],
  [756, '返回可被 `dictGetRandomKey` 采样的完整字典。'],

  // ---- processArgumentFlags / 参数解析 ----
  [763, '参数 flag 映射表：只有 optional/multiple/multiple_token 三项。'],
  [764, 'COMMAND DOCS 里的 flag 字符串。'],
  [765, '对应 `CMD_ARG_*` 位，最终按位或进 `CommandArgument.flags`。'],
  [767, '首项 optional：`shouldSkipOptionalArgument` 据此按 1/2 概率跳过该参数。'],
  [772, '遍历回复中的每个 flag 字符串。'],
  [773, 'flags 数组元素都是 STATUS 字符串。'],
  [775, '内层查表，NULL 哨兵结束。'],
  [776, 'strcmp 返回非零即不匹配，continue 到下一项。'],
  [778, '多个 flag 累加而非覆盖，因此用按位或。'],
  [779, '命中即跳出内层，避免同一 flag 被重复匹配。'],
  [790, 'zcalloc 保证全零：解析中途失败时 `freeCommandArgument` 仍可逐项安全释放。'],
  [791, '长度先于解析落定，释放时按它遍历。'],
  [792, '递归解析，parent 透传最外层命令而非当前 block。'],
  [801, '只接受 map/array 两种键值对形式，其余类型直接忽略。'],
  [803, '步长 2：偶数位是键，奇数位是值。'],
  [804, '键必须是字符串，这是解析前提而非可恢复错误。'],
  [805, '取出键名，下面按 name/token/type/arguments/flags 分支。'],
  [806, '`element[i + 1]` 是配对的值对象，类型按各键自行校验。'],
  [808, 'name 字段：参数名，直接 zstrdup 保存。'],
  [809, '复制字符串，回复对象释放后仍可用。'],
  [811, 'token 是固定字面量，`addArgumentToCommand` 会原样 append。'],
  [813, 'type 必须是字符串，否则 `mapArgumentType` 会读到野指针。'],
  [814, '未知类型回落 `ARG_TYPE_STRING`。'],
  [816, 'arguments 字段递归成子参数数组。'],
  [818, 'flags 字段按位或进 `cmdArg->flags`。'],
  [827, '逐项解析，每项对应一个 `CommandArgument`。'],
  [828, '先写 parent，递归解析子参数时才能沿链上溯。'],
  [829, '单项解析，子参数由 `processSubarguments` 递归处理。'],

  // ---- countTotalCommands ----
  [838, '顶层命令是扁平键值对，元素数除以 2 即顶层条数。'],
  [842, '奇数位是该命令的规格 map。'],
  [844, 'map 内同样是键值对，步长 2。'],
  [845, '取字段名，只关心 subcommands。'],
  [847, '只有带 subcommands 的条目会追加计数。'],
  [848, '`subcommands` 与顶层同构，也是键值对数组。'],
  [849, '`elements / 2` 得到子命令条数，追加到 `commandCount` 供一次性分配。'],
  [853, '总数同时是注册表的分配长度与遍历上界。'],

  // ---- populateCommandEntry ----
  [863, '有子命令时 argv 两个槽，否则只装命令名。'],
  [864, '按槽数分配 char* 数组。'],
  [865, '复制命令名，后续全大写在副本上做，不改 sds 原件。'],
  [869, '原地转大写；COMMAND 输出的大小写随版本变化，统一后 strcasecmp 才稳定。'],
  [872, '无子命令时跳过整段，argv 保持单槽。'],
  [875, '形如 a|b 的子命令只取竖线之后的部分作为发送名。'],
  [876, '从 `pipe + 1` 复制后半段，跳过竖线。'],
  [878, '`pipe == NULL` 时整串 `subcommandName` 就是子命令名。'],
  [883, '子命令同样转大写，与 argv[0] 口径一致。'],
  [889, 'fullname 需要额外容纳空格与子命令名。'],
  [890, '+= 子命令长度加 1，这个 1 用于结尾 \\0；空格由 897 行的 strlcat 提供。'],
  [893, '一次分配到位，后续 strlcpy/strlcat 不会截断。'],
  [894, '先拷命令名并写入 \\0，作为后续拼接的起点。'],
  [896, '只在 `subcommandName` 非空时拼接后半段。'],
  [897, '`strlcat` 先补一个空格，898 行再拼子命令。'],
  [898, '命令名与子命令名以空格分隔，最终形如 CONFIG GET。'],
  [904, '参数描述由 `parseCommandArguments` 稍后填充，此处先清空。'],
  [905, '计数与 `args` 同步清零，避免读到未初始化长度。'],

  // ---- updateCommand ----
  [914, '线性扫描 `commandRegistry` 找同名顶层命令。'],
  [915, '取条目地址，命中后就地改 `arity` 与 `flags`。'],
  [925, '遍历 COMMAND 输出的 flags 数组。'],
  [926, '只接受 STATUS 元素，其它类型跳过而非报错。'],
  [928, 'flag 字符串交给 `mapFlagType` 转成 `CMD_*` 位。'],
  [931, '按位或累加，未识别的 flag 返回 0 不影响其它位。'],
  [934, '同名顶层命令唯一，命中后立即返回，不再扫描后续条目。'],
];

// 插入前预检：先用 vk-gate 的块级判定做分钟级预检，最终以插入后的 deep-quality 为准（§8.10）。
const { isWeakBlock } = await import('./vk-gate.mjs');
const weak = E.filter(([, t]) => isWeakBlock([t]));
if (weak.length) {
  console.error(`WEAK ${weak.length}: ${weak.map(([n]) => n).join(',')}`);
  process.exit(3);
}

// 对账：目标集合 = VK-B73a-target.txt 中落在 START..END 的全部行，E 与 SKIP 不相交。
const want = new Set(
  fs
    .readFileSync('d:/code/_annot_baseline/VK-B73a-target.txt', 'utf8')
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
