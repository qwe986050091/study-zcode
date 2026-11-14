import fs from 'node:fs';

const file = 'd:\\code\\opensource\\uv\\crates\\uv-platform-tags\\src\\tags.rs';
const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);

function pick(needle) {
  const hits = src.filter((l) => l.trim() === needle.trim());
  if (hits.length !== 1) throw new Error(`anchor not unique (${hits.length}): ${needle}`);
  return hits[0];
}

const blocks = [
  ['pub enum TagsError {', [
    '标签计算过程中的全部失败原因。',
    '[不变量] 平台相关错误直接透传 PlatformError，不在此处再包一层语义。',
    '[边界] 「已知但不支持」与「完全未知」的实现分为两个变体，便于给出不同提示。',
    '[不变量] freethreading 与 debug 只能由 CPython 开启，其它实现一律报错。',
    '[权衡] 错误枚举保持 Copy 之外的轻量结构，避免上游频繁分配。',
  ]],
  ['pub struct TagsOptions {', [
    '构造标签集时的环境开关集合，由调用方从解释器信息推导后传入。',
    '[不变量] manylinux_compatible 为假时会剔除所有 manylinux 标签。',
    '[边界] gil_disabled 与 debug_enabled 仅在 CPython 下合法。',
    '[维护] 新增开关必须同时检查 from_env 中的早退分支与标签生成顺序。',
  ]],
  ['pub enum IncompatibleTag {', [
    '不兼容原因，按从「最无效」到「最接近可用」排序。',
    '[不变量] 该顺序即 Ord 顺序，compatibility 依赖它取最大值来报告最贴近的失败点。',
    '[维护] 调整变体顺序会改变错误提示的优先级，需同步检查测试期望。',
  ]],
  ['pub enum TagCompatibility {', [
    '一个轮子相对当前环境的兼容结论。',
    '[不变量] 兼容时携带 TagPriority，数值越大优先级越高。',
    '[不变量] 不兼容时携带原因，用于「为何装不上」的诊断信息。',
    '[权衡] 用枚举而非 Option 组合，避免出现「不兼容却没有原因」的非法状态。',
  ]],
  ['impl Ord for TagCompatibility {', [
    '为兼容结论定义全序，使多个候选轮子可以稳定比较取优。',
    '[不变量] 任何 Compatible 都大于任何 Incompatible。',
    '[不变量] 同为兼容时按 TagPriority 比较；同为不兼容时按原因枚举顺序比较。',
    '[边界] 该序仅用于选优与诊断，不参与哈希或相等性之外的语义。',
  ]],
  ['fn is_freethreaded_compatible_abi(abi: AbiTag) -> bool {', [
    '判断某个 ABI 标签能否在 free-threaded 解释器上运行。',
    '[不变量] 纯 Python（none）与 abi3t 始终可接受。',
    '[不变量] 常规 CPython ABI 只有在带 Freethreading 变体时才可接受。',
    '[边界] 其它实现的 ABI 一律视为不兼容，因为自由线程目前是 CPython 专属。',
  ]],
  ['pub struct CompressedTags<\'a> {', [
    '一个压缩标签组的三段切片视图，生命周期借自调用方解析结果。',
    '[不变量] 三段之间的关系是笛卡尔积，任意组合命中即视为该组命中。',
    '[边界] WHEEL 元数据中的多行 Tag 必须逐行独立判断，不能在此跨行合并。',
  ]],
  ['pub struct Tags {', [
    '当前环境的兼容标签集合，构造后只读并可在多线程间共享。',
    '[不变量] map 用 Arc 包裹，克隆 Tags 只增加引用计数而不复制三级索引。',
    '[不变量] best 记录最高优先级三元组，用于 pyproject 生成与错误提示。',
    '[边界] python_platform 与 python_version 仅用于展示与诊断，不参与匹配。',
    '[维护] is_cross 与 is_freethreaded 是构造期快照，运行期不会变化。',
  ]],
  ['    pub fn from_env(', [
    '按解释器实现、Python 版本与目标平台生成完整标签集合。',
    '[不变量] 返回顺序即优先级顺序，先精确实例、再 ABI3、再纯 Python。',
    '[边界] 非 CPython 实现不会生成 abi3 与 debug 相关标签。',
    '[权衡] 一次性预生成全部组合，换取运行期匹配只做哈希查表。',
  ]],
  ['        let mut variant = CPythonAbiVariants::default();', [
    '根据开关逐步累积 CPython 的 ABI 变体标志。',
    '[不变量] 变体只增不减，后续生成 ABI 标签时统一读取。',
    '[边界] 非 CPython 实现若携带自由线程或调试开关，直接拒绝而不是静默忽略。',
  ]],
  ['        // Determine the compatible tags for the current platform.', [
    '先求平台标签，再按 manylinux 兼容性开关过滤。',
    '[不变量] 过滤只影响 manylinux 系列，不触碰 any 与其它平台标签。',
    '[边界] manylinux_compatible 为假意味着只接受在本机 ABI 上直接可用的轮子。',
    '[维护] 该过滤发生在版本扩展之前，因此后续所有组合都自动继承过滤结果。',
  ]],
  ['        // 1. This exact c api version', [
    '第一组：精确匹配当前 C API 版本的标签，优先级最高。',
    '[不变量] 这组标签排在向量最前，因而获得最小的 TagPriority 基数。',
  ]],
  ['        // 1a. For CPython 3.8+, debug builds are ABI-compatible with release builds, so a debug', [
    '补充组：3.8 起调试版 CPython 也接受发布版 ABI 的轮子。',
    '[不变量] 仅移除 Debug 变体，保留自由线程等其它变体。',
    '[边界] 该补充组排在精确组之后，因此发布版轮子优先级低于调试版轮子。',
  ]],
  ['        // 2. abi3/abi3t and no abi (e.g. executable binary)', [
    '第二组：稳定 ABI（abi3）与 abi3t，向更低 minor 版本逐级展开。',
    '[不变量] 自由线程解释器用 abi3t，普通解释器用 abi3，二者互斥。',
    '[边界] none 只对当前 minor 生成，因为纯 Python 轮子不承诺跨版本 ABI。',
    '[权衡] 逐 minor 展开使 vector 变大，但保证优先级顺序完全由位置决定。',
  ]],
  ['        // 3. no abi (e.g. executable binary)', [
    '第三组：无 ABI 的 pyX.Y 标签，覆盖当前及更低的全部 minor。',
    '[不变量] 匹配当前 minor 之后额外生成一个不带 minor 的 pyX 标签。',
    '[边界] 更低 minor 只生成带 minor 形式，避免提前匹配到过宽的纯 Python 轮子。',
  ]],
  ['        // 4. no binary', [
    '第四组：平台为 any 的兜底标签，优先级最低。',
    '[不变量] CPython 会额外生成实现相关的语言标签，再补通用 Python 标签。',
    '[边界] 该组必须排在最后，否则纯 Python 轮子会抢占平台专用轮子的优先级。',
  ]],
  ['    pub fn compatibility(&self, wheel_tags: CompressedTags<\'_>) -> TagCompatibility {', [
    '求一个压缩标签组的最佳兼容结论，用于诊断与选优。',
    '[不变量] 遍历过程中只保留最大值，最终返回最有利的结论。',
    '[不变量] 自由线程检查前置，ABI 不合法时不再看 Python 与平台段。',
    '[边界] 所有组合都失败时返回最接近成功的原因，而不是笼统的 Invalid。',
    '[权衡] 与 is_compatible 分开实现，牺牲少量重复换取诊断信息的完整性。',
  ]],
  ['    pub fn compatibility_tag(', [
    '判断单个三元组标签的兼容性，供逐个轮子标签调用。',
    '[不变量] 查表顺序为 Python、ABI、平台，任一缺失即返回对应原因。',
    '[边界] 自由线程下的 ABI 前置检查与批量版本保持一致。',
  ]],
  ['    pub fn is_compatible_abi(&self, python_tag: LanguageTag, abi_tag: AbiTag) -> bool {', [
    '仅检查语言与 ABI 两段是否同时存在，忽略平台。',
    '[不变量] 用于判断能否复用已下载的 wheel，而不关心具体平台变体。',
  ]],
  ['pub struct TagPriority(NonZeroU32);', [
    '标签优先级的紧凑表示，内部保证非零。',
    '[不变量] 数值越大优先级越高；零值不可表示，避免与「无优先级」混淆。',
    '[边界] 由 usize 转换时加一，使下标 0 对应优先级 1。',
  ]],
  ['impl std::fmt::Display for Tags {', [
    '按优先级从高到低逐行输出标签，便于调试与诊断。',
    '[不变量] 使用 BTreeSet 去重并按优先级排序，输出稳定可复现。',
    '[边界] 仅用于展示，输出格式不承诺机器可解析。',
  ]],
  ['enum Implementation {', [
    'uv 支持的 Python 实现枚举，决定语言标签与 ABI 标签的形态。',
    '[不变量] CPython 额外携带 ABI 变体，其它实现无变体概念。',
  ]],
  ['    fn language_tag(self, python_version: (u8, u8)) -> LanguageTag {', [
    '把实现与版本映射为语言标签，例如 cp39、pp39、graalpy310。',
    '[不变量] 各实现的命名格式必须与 wheel 文件名规范一致。',
    '[维护] 新增实现需同时补齐语言标签、ABI 标签与 parse 分支。',
  ]],
  ['    fn abi_tag(self, python_version: (u8, u8), implementation_version: (u8, u8)) -> AbiTag {', [
    '把实现与版本映射为 ABI 标签。',
    '[不变量] CPython 只依赖 Python 版本与变体；PyPy、GraalPy、Pyston 还需实现版本。',
    '[维护] 这里的格式错误会直接导致合法 wheel 被判为不兼容。',
  ]],
  ['    fn parse(name: &str, variant: CPythonAbiVariants) -> Result<Self, TagsError> {', [
    '把解释器名称字符串解析为实现枚举。',
    '[不变量] 已知但不支持的实现返回 UnsupportedImplementation，未知名称返回 UnknownImplementation。',
    '[边界] 当前不支持 python、ironpython、jython 三个历史实现。',
    '[维护] 字符串比较区分大小写，调用方需先做规范化。',
  ]],
  ['fn compatible_tags(platform: &Platform) -> Result<Vec<PlatformTag>, PlatformError> {', [
    '按平台与架构展开全部可用的平台标签，顺序即优先级。',
    '[不变量] 越具体、越贴近本机的标签越靠前。',
    '[边界] 结果不包含 any，any 由 from_env 在最后一组显式追加。',
  ]],
];

const items = blocks.map(([needle, lines]) => ({ anchor: pick(needle), lines }));
fs.writeFileSync('d:\\code\\_annot_baseline\\spec-uvr-d5b-1.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((a, b) => a + b.lines.length, 0));
