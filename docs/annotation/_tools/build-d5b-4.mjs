import fs from 'node:fs';

const file = 'd:\\code\\opensource\\uv\\crates\\uv-platform-tags\\src\\tags.rs';
const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);

const blocks = [
  [1373, 'let tags = tags.iter().map(ToString::to_string)', [
    '把标签对象转成字符串，快照只比较规范化的可读形式。',
    '[不变量] 转换是纯映射，不改变顺序，因此快照仍然表达优先级。',
    '[边界] ToString 走 Display 实现，输出与 wheel 文件名中的片段一致。',
    '[权衡] 字符串快照比结构快照更易读，但会丢失内部表示差异。',
    '[维护] 修改 Display 实现会同时影响本快照与用户可见的调试输出。',
  ]],
  [1377, 'assert_debug_snapshot!(', [
    '调试快照保留字符串边界，便于看清每一项。',
    '[不变量] 任何顺序调整都会导致快照整体失败。',
    '[边界] 调试格式会额外打印引号与逗号，不影响实际标签内容。',
    '[维护] 更新快照时应逐项核对，而不是盲目接受新输出。',
  ]],
  [1417, 'let tags = tags.iter().map(ToString::to_string)', [
    '把 musllinux 标签转成字符串后交给快照。',
    '[不变量] 转换不参与排序或去重，顺序完全来自 compatible_tags。',
    '[边界] 版本号中的点被保留为下划线形式，符合 wheel 规范。',
    '[维护] 若未来支持 musl 1.3，此处的快照需要新增一行。',
  ]],
  [1420, 'assert_debug_snapshot!(', [
    '快照验证 musllinux 版本序列与 linux 兜底位置。',
    '[不变量] 通用 linux 标签必须位于最末，作为最低优先级。',
    '[边界] 不出现 manylinux2014 等 glibc 别名，证明两族互斥。',
    '[权衡] 该用例只覆盖单架构，其它架构由 manylinux 用例间接保障。',
  ]],
  [1448, 'let tags = tags.iter().map(ToString::to_string)', [
    '把 macOS 21.6 的标签转成字符串。',
    '[不变量] 每个版本点内部的六种格式顺序保持不变。',
    '[边界] 该段用于验证未来版本不会被硬编码截断。',
    '[维护] 新增二进制格式时，每个版本点的标签数都会增加。',
  ]],
  [1452, 'assert_debug_snapshot!(', [
    '快照覆盖 21.0 到 11.0 以及 10.16 到 10.4 的完整序列。',
    '[不变量] 拼接处既不重复也不遗漏版本点。',
    '[边界] 11 以上忽略 minor 输入，统一记为 0。',
    '[权衡] 未来版本也纳入快照，避免实现偷偷设置上限。',
    '[维护] 该快照与 14.0、10.6 两段共同构成版本语义的完整证据。',
  ]],
  [1615, 'let tags = tags.iter().map(ToString::to_string)', [
    '把 macOS 14.0 的标签转成字符串。',
    '[不变量] 14.0 到 11.0 每个版本点包含六种格式。',
    '[边界] 10.x 补充段只包含 universal2，因此每点只有一项。',
    '[维护] 该段是日常发布最常见的形态，回归价值最高。',
  ]],
  [1618, 'assert_debug_snapshot!(', [
    '快照验证常见版本下的完整展开。',
    '[不变量] 11.0 之后直接衔接 10.16，没有空档。',
    '[边界] 补充段的版本下界固定为 10.4。',
    '[权衡] 补充段长度固定，不随请求版本变化。',
  ]],
  [1739, 'let tags = tags.iter().map(ToString::to_string)', [
    '把 macOS 10.6 的标签转成字符串。',
    '[不变量] 只包含 10.6、10.5、10.4 三个版本点。',
    '[边界] 该路径不进入 11 以上的 major 循环。',
    '[维护] 10.x 是历史路径，但旧轮子仍可能依赖它。',
  ]],
  [1742, 'assert_debug_snapshot!(', [
    '快照验证 10.x 路径的最低版本边界。',
    '[不变量] 不生成 10.3 及更早版本。',
    '[边界] 10.4 是上游约定的最低支持版本。',
    '[权衡] 固定下界而非动态推导，保证与 packaging 行为一致。',
  ]],
  [1776, 'let tags = [', [
    '把四种 BSD 系统放进同一数组统一处理。',
    '[不变量] 每个元素只描述操作系统，架构统一为 x86_64。',
    '[边界] 用 flat_map 展平后仍保持输入顺序。',
    '[维护] 新增 BSD 变体时只需在此追加一个元素。',
    '[权衡] 批量处理减少重复代码，但快照失败时定位粒度较粗。',
  ]],
  [1812, 'let error = compatible_tags(&Platform::new(', [
    '构造带非法版本串的 FreeBSD 平台并取其错误。',
    '[不变量] 错误在平台标签生成阶段就暴露，不进入后续标签组合。',
    '[边界] 版本串包含斜杠，无法解析为 ReleaseArch。',
    '[维护] 错误结构中的原始字符串是用户排查问题的关键线索。',
  ]],
  [1834, 'let tags =', [
    '第一段：API 14 低于支持下限。',
    '[不变量] 返回空列表，调用方据此判定不兼容。',
    '[边界] 该路径不触发任何错误分支。',
    '[权衡] 空列表比报错更宽容，允许调用方继续尝试其它来源。',
  ]],
  [1836, 'let tags = tags.iter().map(ToString::to_string)', [
    '空列表转换后仍是空列表。',
    '[不变量] 转换不会凭空产生元素。',
    '[边界] 快照写作空数组，直观表达「无可用标签」。',
  ]],
  [1847, 'let tags =', [
    '第二段：API 20 高于下限。',
    '[不变量] 展开 20 到 16 共五个版本。',
    '[边界] 每个版本的 ABI 都来自同一架构映射。',
    '[维护] 若下限从 16 提高，本段长度会缩短。',
  ]],
  [1872, 'let tags = compatible_tags(&Platform::new(', [
    '第一段：iOS 11.0 真机 arm64。',
    '[不变量] 版本低于 12 时返回空列表。',
    '[边界] 真机分支不接受 x86_64。',
    '[权衡] 与 Android 一样选择空列表而非错误。',
  ]],
  [1891, 'let tags = compatible_tags(&Platform::new(', [
    '第二段：iOS 12.3 真机 arm64。',
    '[不变量] 同一 major 内 minor 递减到 0。',
    '[边界] 不进入更低 major，因为 major 等于下限。',
    '[维护] 该段验证同 major 内的枚举上界与下界。',
  ]],
  [1916, 'let tags = compatible_tags(&Platform::new(', [
    '第三段：iOS 15.1 真机 arm64。',
    '[不变量] 跨 major 时每个 major 的 minor 枚举到 9。',
    '[边界] 终点是 12.0，覆盖完整的支持区间。',
    '[维护] minor 上限 9 是宽松策略，避免维护显式版本表。',
    '[权衡] 多余候选不会命中真实轮子，但省去了版本表维护成本。',
  ]],
  [1972, 'let tags = compatible_tags(&Platform::new(', [
    '构造 Pyodide 2025.0 wasm32 平台。',
    '[不变量] 年份版本只参与拼接，不参与优先级计算。',
    '[边界] 架构必须是 wasm32，否则走不到该分支。',
    '[维护] 年份来自运行时版本，测试使用固定值保证可复现。',
  ]],
  [1997, 'let tags = compatible_tags(&Platform::new(', [
    '构造 PyEmscripten 2026.0 wasm32 平台。',
    '[不变量] 输出与 Pyodide 分支完全对称。',
    '[边界] 年份递增不影响标签顺序。',
    '[维护] 两个分支应同步修改，否则会出现命名不一致。',
  ]],
  [2026, 'let tags = Tags::from_env(', [
    '在关闭 manylinux 兼容的前提下构造完整标签集。',
    '[不变量] 平台过滤只移除 manylinux 系列。',
    '[边界] 通用 linux 与 any 仍然保留。',
    '[权衡] 该开关用于模拟不兼容 manylinux 的解释器环境。',
    '[维护] 过滤在版本扩展之前执行，各版本组自动继承结果。',
  ]],
  [2043, 'assert_snapshot!(', [
    '快照验证过滤后的标签集结构与顺序。',
    '[不变量] abi3 组只保留 linux 平台。',
    '[边界] any 组位于最后，符合兜底约定。',
    '[维护] 若过滤位置前移或后移，本快照的结构会明显变化。',
  ]],
  [2097, 'let tags = Tags::from_env(', [
    '构造 manylinux 2.28 x86_64 上的 CPython 3.9 标签集。',
    '[不变量] 版本 3.9 决定各组展开的下界。',
    '[边界] 架构 x86_64 决定二进制格式与平台阶梯。',
    '[维护] 该处的参数变化会整体改变下方六百行快照。',
    '[权衡] 用单条长快照换取对全量顺序的零容忍。',
  ]],
  [2757, 'let tags = Tags::from_env(', [
    '构造 macOS 14.0 arm64 上的 CPython 3.9 标签集。',
    '[不变量] 架构 arm64 只允许 arm64 与 universal2 两种格式。',
    '[边界] 11 以下的补充段只保留 universal2。',
    '[维护] 该参数与下方四百余行快照一一对应。',
    '[权衡] 与 manylinux 用例结构对称，便于横向比对。',
  ]],
  [3267, 'let tags = Tags::from_env(', [
    '构造自由线程 CPython 3.15 的标签集。',
    '[不变量] manylinux 兼容关闭，平台只剩通用 linux。',
    '[边界] gil_disabled 为真时才启用 abi3t。',
    '[维护] 该用例是自由线程 ABI 规则的唯一端到端覆盖。',
  ]],
  [3365, 'fn debug_compatibilities(debug_enabled: bool) -> (TagCompatibility, TagCompatibility) {', [
    '辅助函数：按调试开关构造标签集并判定两种 ABI。',
    '[不变量] 两次判定共享同一份标签集。',
    '[边界] 平台与版本固定，排除其它变量。',
    '[权衡] 返回元组而非分别构造，减少重复与快照噪音。',
    '[维护] 若新增 ABI 变体，应在此扩展返回的判定数量。',
  ]],
  [3388, 'let debug_compatibility = tags.compatibility(CompressedTags {', [
    '判定调试 ABI 轮子的兼容性。',
    '[不变量] ABI 段使用 cp314d。',
    '[边界] Python 与平台段与发布版完全一致。',
    '[维护] 该构造是验证调试后缀语义的最小输入。',
  ]],
  [3396, 'let non_debug_compatibility = tags.compatibility(CompressedTags {', [
    '判定发布 ABI 轮子的兼容性。',
    '[不变量] ABI 段使用 cp314，与调试组只差一个后缀。',
    '[边界] 两组唯一的差异就是 ABI 段。',
    '[维护] 保持其它段相同，才能把结论差异归因于调试开关。',
  ]],
  [3408, 'let (debug_compatibility, non_debug_compatibility) = debug_compatibilities(false);', [
    '普通构建下的两项结论。',
    '[不变量] 调试轮子不兼容，发布轮子兼容。',
    '[边界] 该结果证明调试 ABI 不会被静默接受。',
    '[权衡] 严格拒绝可避免运行期因 ABI 不匹配而崩溃。',
  ]],
  [3418, 'let (debug_compatibility, non_debug_compatibility) = debug_compatibilities(true);', [
    '调试构建下的两项结论。',
    '[不变量] 两种轮子都兼容。',
    '[边界] 调试轮子的优先级更高，源于补充段的位置。',
    '[维护] 优先级比较而非数值断言，避免耦合具体下标。',
  ]],
  [3430, 'let python_tag = LanguageTag::from_str("cp314").unwrap();', [
    '准备单标签判定所需的三段输入。',
    '[不变量] 三段分别覆盖 Python、ABI、平台。',
    '[边界] 解析失败即 panic，测试环境允许这种直接断言。',
    '[维护] 该输入与下方兼容组判定共用，保证两者输入一致。',
  ]],
  [3460, 'assert_eq!(', [
    '核心等价性断言：单标签入口与压缩组入口结论一致。',
    '[不变量] 同时比较兼容状态与优先级数值。',
    '[边界] 任一入口新增特判都会在此暴露。',
    '[维护] 新增兼容性入口时应一并纳入该等价性检查。',
    '[权衡] 用循环覆盖两种解释器配置，避免复制断言。',
  ]],
];

const items = blocks.map(([line, expect, lines]) => {
  const actual = src[line - 1];
  if (!actual || !actual.trim().startsWith(expect)) {
    throw new Error(`line ${line} mismatch: ${JSON.stringify(actual)} !~ ${expect}`);
  }
  return { line, anchor: actual, lines };
});

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-uvr-d5b-4.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((a, b) => a + b.lines.length, 0));
