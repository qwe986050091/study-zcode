import fs from 'node:fs';

const file = 'crates/uv-resolver/src/pubgrub/report.rs';
const items = [];
const add = (line, lines) => items.push({ line, lines });

add(1, [
  '冲突报告渲染器：把 PubGrub 的推导树翻译成人能读懂的英文解释，并收集修复建议。',
  '上游 DefaultStringReporter 的递归入口是私有的，这里实现一个等价的迭代版本。',
  '迭代的意义在于深度：解析冲突树可能有十万层，递归版本会在默认线程栈上直接爆栈。',
  '渲染依赖 PubGrubReportFormatter 注入的上下文：工作区成员、兼容标签、Python 目标版本。',
  '本模块只负责「怎么说得清楚」，不负责判断谁对谁错，推导逻辑全部在 resolver 中。',
]);

add(9, [
  'IndexSet 用于提示去重且保持插入顺序，同一个提示只会展示一次。',
  'Itertools 提供 join 等拼接能力，避免手写累加分隔符时的边界错误。',
  'jiff 的 Timestamp 负责把 exclude-newer 截止时间格式化成可读时间。',
  'owo-colors 的 cyan/green/red 决定文案配色；是否真正输出 ANSI 由上层决定。',
  'reqwest 的 StatusCode 直接嵌入网络类提示，保留原始状态码便于用户核对。',
  'FxHashMap 用在以包名为键的小表上，避免 SipHash 在错误路径上的额外开销。',
]);

add(13, [
  'DerivationTree 是推导树：External 为不兼容事实，Derived 为两条原因推出的一条结论。',
  'Derived 除两个原因外还携带 terms 与 shared_id：前者是结论本身，后者用于共享节点复用。',
  'Map 是确定性的包到 Term 映射；Term 表示「包含」或「排除」某段版本区间。',
  'ReportFormatter 是上游定义的渲染接口，实现它就能复用上游的句式组合逻辑。',
]);

add(17, [
  'IndexStrategy 决定多索引时的取版本顺序，直接影响 UncheckedIndex 提示是否成立。',
  'NoBinary 与 NoBuild 是 --no-binary 与 --no-build 的解析结果，会被原样嵌进提示文案。',
]);

add(18, [
  'Index 与 IndexUrl 描述索引来源，IndexMetadata 提供「按包取索引 URL」的能力。',
  'IndexCapabilities 记录 401/403 一类鉴权结果，用于 Unauthorized 与 Forbidden 提示。',
  'IndexLocations 汇总 --index-url、--extra-index-url 与 --find-links 的最终视图。',
  'RequiresPython 是解析后的 requires-python 约束，展示时直接使用原文而非重新格式化。',
]);

add(21, [
  'PackageName 是规范化后的包名，作为本模块所有映射表的键。',
]);

add(22, [
  'Version 是 PEP 440 版本；Range 是 pubgrub 的区间类型，支持并集、交集与补集。',
  'VersionSpecifier 与 VersionSpecifiers 出现在提示里，用于展示用户原始约束写法。',
]);

add(23, [
  'MarkerEnvironment 是当前解释器的标记环境，用来判断 fork 是否覆盖当前环境。',
  'MarkerTree 表示布尔标记表达式，MarkerValueVersion 用于构造 python_version 比较。',
]);

add(26, [
  'CandidateSelector 负责在版本列表中挑选候选，提示里需要它复核「本来能选到谁」。',
  'ErrorTree 就是推导树的别名；PrefixMatch 把区间还原成 ==1.2.* 这类前缀写法。',
  'ForkIndexes 记录每个包最终命中的索引，ForkUrls 记录由 URL 直接指定的包。',
  'PrereleaseSelection 决定是否允许预发布，是预发布类提示能否成立的前提。',
  'IncompatibleDist 系列枚举描述「为何没有可用分发」，提示按具体变体分派。',
]);

add(38, [
  '单独成组是因为它与上面的 use 列表排序不同；合并进上一个花括号会破坏 rustfmt 结果。',
  'EffectiveExcludeNewerSource 区分截止时间来自全局、单包还是索引配置，文案措辞随之不同。',
]);

add(40, [
  '别名固定了三个泛型参数：包类型、版本区间、不可用原因。',
  '下面的签名都写成 ReportDerived，既短一截，也避免漏写参数导致实现与 trait 不匹配。',
]);

add(42, [
  '渲染器只持有借用：错误报告是只读的，生命周期不会超过 NoSolutionError。',
]);

add(44, [
  '已被索引收录的版本集合，用于区分「版本根本不存在」与「存在但被规则过滤」。',
]);

add(47, [
  '索引里存在、但可能被 exclude-newer 过滤掉的版本，用于给出「最新可用版本」提示。',
]);

add(50, [
  '解析目标的 Python 要求；文案里要区分 target 与 installed 两种口径。',
]);

add(53, [
  '工作区成员集合，决定称呼用「你的项目」还是直接使用包名。',
]);

add(56, [
  '当前解析的兼容标签；为 None 表示无法判断平台与 ABI，相关提示直接跳过。',
]);

add(60, [
  '入口函数：外部原因单独渲染，推导树交给迭代报告器展开。',
  '返回 String 而不是实现 Display，因为调用方需要先拿到完整文本，再决定缩进与着色。',
]);

add(68, [
  '只有两种根形态：单个外部事实，或需要继续展开的推导节点。',
]);

add(71, [
  '报告器自带行缓冲，build 结束后统一 join，避免中间字符串反复分配。',
]);

add(78, [
  'ref_count 是当前已分配的最大引用号，shared_with_ref 记录共享节点首次出现时的编号。',
  'lines 是输出缓冲；引用号允许回填到上一行末尾，因此必须保存整行字符串而非只存片段。',
]);

add(87, [
  '用显式栈模拟后序遍历：先压 Finish 再压子任务，保证子节点先于收尾动作执行。',
  'Task 定义在函数内部，既避免污染模块命名空间，也便于让它借用局部生命周期。',
]);

add(88, [
  'Build 展开一个推导节点；Finish 为共享节点分配引用号；Emit 直接追加已渲染的整行。',
  'AfterFirstDerived 用于「两个子节点都要展开」的场景：先展开第一个，再回来决定第二个的引用方式。',
]);

add(99, [
  '初始任务只有根节点，后续子任务全部由 Build 分支继续压栈。',
]);

add(102, [
  '先压 Finish，确保当前节点的所有子节点都展开完毕后，才有机会给它编号。',
]);

add(104, [
  '按两个原因的类型分成四种组合；组合顺序决定了最终句式是 Because 还是 And because。',
]);

add(108, [
  '双外部：两个事实直接拼成一句，这是最短路径，无需任何引用号。',
]);

add(115, [
  '一推一外：推导侧若已经解释过，就用引用号；否则继续展开它。',
]);

add(117, [
  'line_ref_of 只查表不分配新编号，保证同一共享节点在各处引用一致。',
]);

add(125, [
  '推导侧的两个原因若恰好是一推一外，可合并成 prior-and-external 句式，省掉一层缩进。',
]);

add(143, [
  '其余情况退化为普通 external 句式，保证输出与上游一致。',
]);

add(153, [
  '双推导：两侧都可能已经分配过引用号，因此要分别处理四种组合。',
]);

add(158, [
  '两侧都有引用：直接拼一句「我们知道自 (n) 与 (m)」，不再展开。',
]);

add(167, [
  '只有一侧有引用：先 Emit 结论行，再把另一侧压栈展开。',
  '注意压栈顺序与输出顺序相反，因此 Emit 必须先于 Build 压入。',
]);

add(183, [
  '两侧都未展开：交给 AfterFirstDerived 协调，先展开 first，再决定 second 如何被引用。',
]);

add(195, [
  'Finish 只在共享节点首次收尾时分配编号；非共享节点直接跳过，不做任何事。',
]);

add(203, [
  'first 自身就是共享节点时，它的编号已由 Finish 分配，这里只需换行后重新展开当前节点。',
]);

add(207, [
  '否则为 first 新分配编号，再把 second 作为后续展开对象，形成「先解释 first 再解释 second」的顺序。',
]);

add(227, [
  '在上一行末尾追加「 (n)」并把计数加一；没有上一行时只递增，编号仍然被占用。',
  '返回新编号，供调用方直接写入引用位置。',
]);

add(235, [
  '共享编号到展示编号的映射查询；None 表示该节点从未被共享，需要继续展开。',
]);

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6d-1.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((n, i) => n + i.lines.length, 0));
