import fs from 'node:fs';

const file = 'crates/uv-requirements-txt/src/lib.rs';
const items = [];
const add = (line, lines) => items.push({ line, lines });

add(37, [
  'std 依赖分工：Cow 表示「借用或拥有」的字符串，io 用于包装读写错误，Path 负责路径解析。',
  'FromStr 让包名说明符可以直接由字符串构造，错误类型由下游统一处理。',
]);
add(43, [
  'FxHashMap/FxHashSet 避免 SipHash 的额外开销，这里的键都是短路径或枚举。',
  'instrument 为每个入口打 tracing span，便于在日志里追踪 include 层级。',
  'Scanner 来自 unscanny，是按字节前进的游标，错误位置用字节偏移保存。',
]);
add(47, [
  'http feature 门控远程 include：没有网络能力时仍然可以解析本地文件。',
  'BaseClientBuilder 决定超时、重试与离线策略，ClientBuildError 在构造客户端时产生。',
]);
add(50, [
  'NoBinary 与 NoBuild 分别是 --no-binary 与 --only-binary 的语义载体。',
  'PackageNameSpecifier 负责解析 :all:、:none: 与包名列表。',
  'RequirementsInput 统一 stdin、本地文件与远程 URL 三种输入。',
]);
add(53, [
  'Requirement 是已经解析好的 PEP 508 需求，UnresolvedRequirement 保留未解析形态。',
  'UnresolvedRequirementSpecification 额外携带 hashes，是本解析器的最终输出。',
]);
add(57, [
  'normalize_path 用于去重时构造稳定身份，不改变实际读取的路径。',
  'VerbatimUrl 保留用户原始写法，expand_env_vars 负责展开 ${VAR} 与 %VAR%。',
]);
add(62, [
  '这两个类型只在本 crate 内部使用，重新导出是为了让 requirement 子模块的调用方少写一层路径。',
]);
add(65, [
  'requirement 子模块负责 PEP 508 与 editable 的转换，shquote 负责去除 shell 引号。',
]);

add(69, [
  '缓存键是 RequirementsInput，同一文件被多次 include 时只读取一次。',
  '值为 String 而不是 Arc：解析过程生命周期短，克隆的收益高于共享。',
]);
add(72, [
  '每条语句对应一个枚举值，文件名与 start/end 只用于报错定位。',
  'RequirementEntry 同时承载普通需求与 editable，差别只在解析时的标志位。',
]);
add(74, [
  '-r 与 -c 的语法相同，区别只在递归时的语义：前者仍算需求，后者整体转为约束。',
]);
add(80, [
  'start/end 是字节偏移，报错时才换算成行列，避免解析过程中反复扫描。',
]);
add(86, [
  'RequirementEntry 保留 hashes 的原始字符串，格式校验留给下游。',
]);
add(88, [
  'editable 的 entry 与普通需求共用结构，make_editable 成功后类型本身就是证明。',
]);
add(90, [
  '--index-url 只允许出现一次，冲突检查在 parse_inner 中进行。',
]);
add(92, [
  '--extra-index-url 可以重复，顺序即优先级。',
]);
add(94, [
  '--find-links 可以重复，允许目录与 URL 混用。',
]);
add(96, [
  '--no-index 是全局布尔开关。',
]);
add(98, [
  '--require-hashes 影响整个文件，嵌套文件之间取或。',
]);
add(100, [
  '--no-binary 是可累积的集合，允许与 --only-binary 混合。',
]);
add(102, [
  '--only-binary 用 NoBuild 表示，语义是「禁止从源码构建」。',
]);
add(104, [
  '未知选项不报错，只告警；保留枚举是为了区分命令行是否也支持该选项。',
]);

add(107, [
  '字段都直接来自文本，不做归一化；hashes 保留原始字符串。',
  '真正的语法校验发生在 RequirementsTxtRequirement::parse 内。',
]);
add(117, [
  '转换实现放在这里而不是 distribution-types，是因为依赖方向不允许反向引用。',
]);
add(120, [
  '具名与未命名需求分别映射到对应的未解析类型，hashes 原样透传。',
]);
add(136, [
  '没有哈希的版本，供不关心 --hash 的调用方使用。',
]);

add(145, [
  '解析结果按类别拆分：requirements、constraints、editables 三个向量。',
  '全局选项被扁平化，递归 include 已经完全展开，调用方看不到文件边界。',
  '顺序保留文件中出现的顺序，解析器后续会自行排序。',
]);
add(170, [
  '所有公开入口最终都会走到 parse_impl 或 parse_inner。',
]);
add(171, [
  'parse 是离线默认入口：不读取网络，适合本地文件与 stdin。',
]);
add(173, [
  'Offline 连接策略让远程 include 明确报错，而不是静默超时。',
  '调用方需要网络时必须显式使用 parse_with_cache 并传入 client_builder。',
]);
add(186, [
  '可注入 client_builder 与 cache，便于测试与 workspace 级复用。',
  'cache 的存在避免同一文件被多个 requirements 文件重复读取。',
]);
add(209, [
  '从字符串解析，但仍需要 input 来描述来源：解析相对路径与报错都依赖它。',
  '不会写入 cache：调用方已经持有内容，缓存没有收益。',
]);
add(241, [
  '先读文件再解析；stdin 只能读一次，因此必须走缓存。',
  '远程文件只在 http feature 下可用，否则直接报 InvalidInput。',
]);
add(252, [
  '缓存命中直接克隆，成本远低于重复读盘或下载。',
]);
add(256, [
  '三种输入来源分别处理：stdin、本地路径、远程 URL。',
]);
add(271, [
  '没有 http feature 时，远程输入是配置错误而不是运行错误。',
]);
add(285, [
  '离线短路：不构造 client，直接给出可操作的错误信息。',
  '这一步必须在 build 之前，否则 client 构造本身可能触发网络探测。',
]);
add(297, [
  '客户端构造失败单独归类，便于区分「配置问题」与「请求失败」。',
]);
add(316, [
  '读取成功才写缓存；失败不缓存，允许调用方重试。',
]);
add(320, [
  '进入纯解析阶段，此后所有错误都会带上文件上下文。',
]);

add(337, [
  '解析核心：逐条读取语句并累积到 RequirementsTxt。',
  '相对路径规则与 pip 一致：-r 相对于当前文件所在目录，-e 相对于工作目录。',
  '这个差异容易踩坑，因此单独写在文档注释里。',
]);
add(351, [
  'Scanner 按字节前进，start/end 都是字节偏移。',
]);
add(353, [
  'data 累积所有语句，直到 parse_entry 返回 None。',
]);
add(354, [
  'parse_entry 返回 None 表示到达文件末尾。',
]);
add(361, [
  '文件名先展开环境变量，再做路径解析。',
]);
add(362, [
  'resolve 决定相对路径的基准目录：requirements 文件所在目录。',
  '解析失败时保留 start/end，错误信息才能指回源文件位置。',
]);
add(369, [
  'visited 防止循环 include；requirements 与 constraints 分别记录。',
  '同一个文件可以被 -r 与 -c 各引用一次，因此需要两个集合。',
]);
add(375, [
  '约束文件里的 -r 也按约束处理，这是与 pip 的有意差异。',
]);
add(384, [
  'Box::pin 打断异步递归的类型无限展开。',
]);
add(398, [
  '嵌套文件与当前文件的 --index-url 冲突时直接报错。',
  '这里不采用「后者覆盖」，因为静默改变索引会让锁文件难以复现。',
]);
add(413, [
  '合并到当前结果，集合类字段取并集。',
]);
add(421, [
  '约束文件名同样支持环境变量展开。',
]);
add(430, [
  '进入约束模式：后续所有 include 都按约束处理，不再区分 -r 与 -c。',
  'visited 的所有权在这里被转移，避免同时借用两个集合。',
]);
add(446, [
  '递归解析子文件，沿用已经切换好的约束模式。',
]);
add(460, [
  '约束文件里不允许 editable：约束只能收窄版本，不能引入本地项目。',
]);
add(469, [
  '只接受具名约束；未命名的路径或 URL 无法表达「约束」语义。',
  '这里逐条转换，保持子文件中的顺序。',
]);
add(482, [
  '子文件里的约束原样追加，不再做二次分类。',
]);
add(485, [
  'require-hashes 是「或」语义：任一文件要求即整体要求。',
]);
add(487, [
  '普通需求直接追加，hashes 已随 entry 一起携带。',
]);
add(493, [
  '重复 --index-url 报错；pip 的行为是后者覆盖，这里更严格。',
  '错误位置用当前游标计算，指向第二个声明。',
]);
add(504, [
  'extra index urls 可重复，保持声明顺序。',
]);
add(507, [
  'find-links 可重复，保持声明顺序。',
]);
add(510, [
  '--no-index 一旦出现即生效，不受顺序影响。',
]);
add(513, [
  '--require-hashes 同样与顺序无关。',
]);
add(516, [
  'extend 而非覆盖，与 pip 的累积语义一致。',
]);
add(522, [
  '不支持的选项只告警，不中断解析。',
  'stdin 与文件分别给出提示：前者建议改用命令行，后者带上文件路径。',
]);
add(536, [
  '路径用 user_display 展示，避免在日志里输出完整绝对路径。',
]);

add(557, [
  '合并规则：集合类取并集，单值类取先出现者，布尔值取或。',
  '这些规则共同保证「子文件不能覆盖父文件的全局配置」。',
]);
add(559, [
  '先解构再合并，避免部分移动导致的借用冲突。',
]);
add(574, [
  '第一个 index url 生效，嵌套文件不能覆盖。',
]);
add(579, [
  '布尔字段取或，任一文件开启即开启。',
]);
add(581, [
  '集合类字段直接追加，重复项由下游去重。',
]);

add(586, [
  'covers 常见但 uv 不支持的 pip 选项。',
]);
add(590, [
  '只列 requirements 文件里常见、而 uv 尚未支持的选项。',
]);
add(597, [
  '辅助方法保持无状态，便于在解析器中按值使用。',
]);
add(599, [
  '展示名与命令行选项名一致，告警里可以直接复用。',
]);
add(609, [
  'cli 表示命令行是否有对应选项，用于决定提示措辞。',
]);
add(619, [
  '顺序固定，保证错误信息与测试快照稳定。',
]);
add(631, [
  'Display 只委托给 name，不引入额外格式。',
]);

add(637, [
  '行终止符与注释起始都视为语句结束。',
]);
add(642, [
  '只在 token 边界匹配选项，避免 --no-index 吃掉 --no-index-url 这类前缀。',
  '边界包括空白、等号与注释符，与 pip 的分词行为一致。',
]);
add(658, [
  '主分派函数：先消费空白与注释，再按前缀识别语句。',
  '返回值是 Option，None 表示已经到达文件末尾。',
]);
add(668, [
  '空白消费包含反斜杠续行。',
]);
add(670, [
  '注释行整行跳过，可以连续出现多行。',
]);
add(676, [
  'start 记录语句起点，供后续错误定位。',
]);
add(677, [
  '短选项优先匹配，-r 与 --requirement 等价。',
]);
add(678, [
  '值一直吃到行终止符或注释符。',
]);
add(679, [
  '去掉 shell 引号；去引号失败时保留原文，不报错。',
]);
add(689, [
  '-c 与 -r 语法相同，语义在 parse_inner 中区分。',
]);
add(701, [
  '-e 允许等号或空白分隔，与 pip 宽容度一致。',
]);
add(702, [
  '两种分隔符都缺失时是明确的语法错误。',
]);
add(716, [
  '只有本地文件能作为 origin；stdin 与远程输入没有稳定的文件路径。',
]);
add(721, [
  'editable 标志影响需求中 URL 的解析方式。',
]);
add(723, [
  'make_editable 失败说明该需求无法以 editable 方式安装。',
]);
add(736, [
  '-i 是 --index-url 的短选项。',
]);
add(743, [
  '环境变量展开后再判断是否指向本地路径。',
]);
add(744, [
  '存在同名本地目录时优先当作路径，避免把目录名误判成 URL scheme。',
  '这是与 pip 保持兼容的关键分支。',
]);
add(766, [
  'with_given 保留用户原始写法，展示与解析分离。',
]);
add(767, [
  '--extra-index-url 与 --index-url 逻辑相同，只是存储位置不同。',
]);
add(798, [
  '--no-index 必须按 token 边界匹配，不能简单用 eat_if。',
]);
add(800, [
  '--require-hashes 没有值，直接置位。',
]);
add(802, [
  '-f 是 --find-links 的短选项。',
]);
add(810, [
  '先尝试解析成本地路径，再退回 URL。',
  '本地路径必须存在，否则会被当作 URL 交给 reqwest。',
]);
add(819, [
  '三种解析结果分别构造 VerbatimUrl，错误位置都指向当前游标。',
]);
add(861, [
  '--no-binary 接受包名列表与 :all: 这类说明符。',
]);
add(877, [
  '--only-binary 与 --no-binary 完全对称，只是目标类型不同。',
]);
add(893, [
  '以字母数字或 ./$ 开头才当作需求，避免把未知选项误判成包名。',
  '这个判定与模块文档里的语法说明一致。',
]);
add(899, [
  '非 editable 模式，产出普通 RequirementEntry。',
]);
add(905, [
  '未识别的选项给出明确错误，并列出受支持的前缀。',
]);
add(921, [
  'EOF：没有更多语句。',
]);

add(927, [
  '吃掉空白与反斜杠续行，返回被消费的原始片段。',
]);
add(930, [
  '只吃空格与制表符，换行必须通过反斜杠转义。',
]);
add(939, [
  '吃掉行尾：换行、注释或文件末尾。',
]);
add(947, [
  '注释一直吃到行尾，同时兼容 CRLF 与单独的 CR。',
]);
add(965, [
  '解析需求本体与可选的尾部哈希。',
  '返回需求文本的字节区间，供错误定位与哈希解析共用。',
]);
add(976, [
  '循环寻找需求结束位置：换行、哈希、注释或 EOF。',
]);
add(988, [
  '空白后接 --hash、注释或续行时，需求本体在此结束。',
  '续行不结束需求，因此需要 continue 继续扫描。',
]);
add(1006, [
  '需求文本直接切片，不做额外分配。',
]);
add(1008, [
  '缺失 -r 的常见错误在这里给出更友好的提示。',
  '只有文件真实存在时才提示，避免把名为 requirements.txt 的包误判。',
]);
add(1028, [
  '交给 PEP 508 解析器，editable 标志一并传入。',
]);
add(1030, [
  '记录 origin，便于后续把需求归属到具体文件。',
]);
add(1042, [
  '有哈希才解析，否则返回空表。',
]);

add(1050, [
  '哈希列表可以连续出现多个 --hash。',
]);
add(1053, [
  '第一个 --hash 必须存在，否则说明前面的判定有误。',
]);
add(1064, [
  '每个哈希都是完整字符串，格式校验留给下游。',
]);
add(1066, [
  '循环吃掉后续哈希，空白与续行都允许。',
]);

add(1077, [
  '解析 -k=v 或 -k v 中键之后的部分。',
  '空值视为错误，避免把下一行的内容误当作值。',
]);
add(1084, [
  '两种分隔符：等号或任意空白。',
]);
add(1100, [
  '空值直接报错，并带上选项名。',
]);

add(1112, [
  '远程 include 的读取入口。',
]);
add(1118, [
  '错误统一包装成 Reqwest 变体，保留 URL 便于展示。',
]);

add(1133, [
  '文件级错误：在解析错误外面再包一层来源。',
]);
add(1140, [
  '解析错误按来源分类，每类都携带位置信息。',
]);
add(1215, [
  'Subfile 递归包装，错误链可以一直展开到最内层文件。',
]);
add(1226, [
  'Display 只负责展示，不改变错误语义。',
]);
add(1312, [
  'source 链让 anyhow 可以展开底层原因。',
]);
add(1341, [
  '文件级展示在所有消息里加上文件名。',
]);
add(1446, [
  '文件级错误直接委托给内部错误。',
]);
add(1452, [
  'io 错误自动转换为 Io 变体。',
]);
add(1458, [
  'http 相关错误只在启用 feature 时存在。',
]);
add(1460, [
  'reqwest::Error 需要先包成 middleware 错误。',
]);
add(1464, [
  'middleware 错误已经是目标形态，直接构造。',
]);
add(1469, [
  '循环 include 防护所需的访问记录。',
]);
add(1475, [
  'requirements 模式：递归 include 仍算需求。',
]);
add(1481, [
  'constraints 模式：递归 include 全部转为约束。',
]);
add(1486, [
  '去重身份使用规范化路径，避免 ./a.txt 与 a.txt 被当成两个文件。',
]);
add(1497, [
  '把字节偏移换算成行列，供用户可读的错误信息使用。',
  '按 Unicode 码点计数，与编辑器的列号习惯一致。',
]);
add(1503, [
  '逐字符扫描到目标位置，遇到换行就重置列号。',
]);
add(1509, [
  'CRLF 视为一个换行，避免 Windows 文件行列偏移一位。',
]);

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6c-1.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((n, i) => n + i.lines.length, 0));
