import fs from 'node:fs';

const file = 'd:\\code\\opensource\\uv\\crates\\uv-platform-tags\\src\\tags.rs';
const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);

function L(needle, occ) {
  const hits = [];
  src.forEach((l, i) => {
    if (l.trim() === needle.trim()) hits.push(i);
  });
  if (occ === undefined) {
    if (hits.length !== 1) throw new Error(`not unique (${hits.length}): ${needle}`);
    occ = 0;
  }
  if (!hits[occ]) throw new Error(`missing occ ${occ}: ${needle}`);
  return hits[occ];
}

const defs = [
  ['pub fn is_compatible(&self, wheel_tags: CompressedTags<\'_>) -> bool {', [
    '快速判定：任意一个标签组合命中即返回真。',
    '[不变量] 命中后立即短路，不继续遍历剩余组合。',
    '[不变量] 查表顺序为 Python、ABI、平台，任一层缺失就换下一个候选。',
    '[边界] 该函数只回答「是否兼容」，不提供优先级或失败原因。',
    '[权衡] 与 compatibility 分开实现，避免为了诊断付出额外开销。',
    '[维护] 两者的判定规则必须保持同步，否则会出现结论不一致。',
    '[不变量] 平台标签通常远多于轮子标签，因此外层遍历轮子标签更省。',
    '[边界] 空切片会直接返回假，不会 panic。',
  ]],
  ['pub fn python_tag(&self) -> Option<LanguageTag> {', [
    '返回最高优先级三元组中的 Python 标签。',
    '[不变量] 标签集非空时必有值，空集时返回 None。',
    '[边界] 该值通常用于生成当前解释器对应的最小标签。',
    '[维护] 仅供展示与诊断，不参与兼容性匹配。',
  ]],
  ['pub fn abi_tag(&self) -> Option<AbiTag> {', [
    '返回最高优先级三元组中的 ABI 标签。',
    '[不变量] 与 python_tag、platform_tag 来自同一组三元组。',
    '[边界] 自由线程下该值带 t 后缀。',
    '[维护] 三者必须整体读取，不能跨组拼接。',
  ]],
  ['pub fn platform_tag(&self) -> Option<&PlatformTag> {', [
    '返回最高优先级三元组中的平台标签。',
    '[不变量] 借用而非拷贝，避免对大枚举做额外克隆。',
    '[边界] 返回引用要求调用方不能同时可变借用标签集。',
    '[维护] 该值是平台阶梯的第一项，通常是最专用的格式。',
  ]],
  ['pub fn python_platform(&self) -> &Platform {', [
    '返回构造标签集时使用的目标平台。',
    '[不变量] 该字段是构造期快照，之后不再变化。',
    '[边界] 交叉编译时会与当前运行平台不同。',
  ]],
  ['pub fn python_version(&self) -> (u8, u8) {', [
    '返回构造标签集时使用的 Python 版本。',
    '[不变量] 以 major、minor 二元组表示，忽略 patch。',
    '[边界] 该版本仅用于错误提示与展示。',
  ]],
  ['pub fn is_freethreaded(&self) -> bool {', [
    '返回标签集是否面向自由线程解释器。',
    '[不变量] 与构造时的 gil_disabled 开关一致。',
    '[边界] 该标志影响 ABI 组的选择，多处逻辑依赖它。',
  ]],
  ['pub fn is_cross(&self) -> bool {', [
    '返回标签集是否面向非当前解释器。',
    '[不变量] 交叉场景下部分错误提示会附加额外说明。',
    '[边界] 该标志不参与兼容性计算，只影响诊断文案。',
  ]],
  ['pub fn is_compatible(&self) -> bool {', [
    '判断该兼容结论是否为「兼容」。',
    '[不变量] 与模式匹配 Compatible 完全等价。',
    '[边界] 不关心优先级高低，只关心是否可用。',
  ]],
  ['impl TryFrom<usize> for TagPriority {', [
    '把标签下标转换为非零优先级。',
    '[不变量] 下标 0 对应优先级 1，保证内部值永不为零。',
    '[边界] 下标超出 u32 上限时返回 InvalidPriority。',
    '[权衡] 用 NonZeroU32 让 Option 式判空变成零成本。',
    '[维护] from_env 依赖「位置越靠前优先级越高」这一约定。',
    '[边界] 转换失败不会静默截断，而是显式报错。',
    '[不变量] 该转换是单射，不同下标不会得到相同优先级。',
  ]],
  ['impl std::fmt::Display for BinaryFormat {', [
    '以规范名输出二进制格式。',
    '[不变量] 输出与 name 方法完全一致。',
    '[边界] 用于拼接 macOS 平台标签。',
    '[维护] 修改 name 会同时改变 Display 与快照。',
  ]],
  ['impl FromStr for BinaryFormat {', [
    '把字符串解析为二进制格式。',
    '[不变量] 接受的名字与 name 输出一一对应。',
    '[边界] 未知名字返回字符串错误，而不是 panic。',
    '[维护] 新增变体必须同时补齐解析分支与 name 分支。',
    '[权衡] 使用 String 错误而非专用枚举，降低调用方负担。',
  ]],
  ['impl std::fmt::Display for AndroidAbi {', [
    '以规范名输出 Android ABI。',
    '[不变量] 输出使用下划线形式，符合 wheel 规范。',
    '[边界] 用于拼接 android 平台标签。',
    '[维护] 与 FromStr 的输入集合必须严格对称。',
  ]],
  ['impl FromStr for AndroidAbi {', [
    '把字符串解析为 Android ABI。',
    '[不变量] 只接受四种已定义的 ABI 名称。',
    '[边界] 未知名称返回字符串错误。',
    '[维护] 新增架构支持时需同步更新此处与 from_arch。',
    '[权衡] 解析与架构映射分离，便于独立测试。',
  ]],
  ['impl std::fmt::Display for IosMultiarch {', [
    '以规范名输出 iOS 多架构标识。',
    '[不变量] 真机与模拟器使用不同的后缀。',
    '[边界] 用于拼接 ios 平台标签。',
    '[维护] 命名必须与上游 packaging 保持一致。',
  ]],
  ['impl FromStr for IosMultiarch {', [
    '把字符串解析为 iOS 多架构标识。',
    '[不变量] 只接受三种合法组合。',
    '[边界] 未知组合返回字符串错误。',
    '[维护] 新增模拟器架构时需同步更新 from_arch 与 name。',
    '[权衡] 用完整字符串而非拆分字段，简化调用方代码。',
  ]],
  ['pub fn platform_machine(&self) -> &\'static [Self] {', [
    '返回该二进制格式可运行的机器类型集合。',
    '[不变量] 这是 from_arch 的逆映射：格式到架构。',
    '[边界] 胖二进制会返回多个架构，专用格式只返回自身。',
    '[维护] 两侧映射需要人工保持一致，测试覆盖有限。',
    '[权衡] 返回静态切片，避免运行期分配。',
    '[不变量] universal2 只包含 x86_64 与 arm64 两种现代架构。',
    '[边界] 该结果用于判断已下载轮子能否在当前机器运行。',
    '[维护] 新增格式时必须同时补齐 from_arch 与 platform_machine。',
  ]],
  ['fn from_arch(arch: Arch) -> &\'static [Self] {', [
    '按架构返回可运行的二进制格式列表。',
    '[不变量] 列表首位永远是架构自身的原生格式。',
    '[边界] 通用格式排在专用格式之后，作为兼容兜底。',
    '[维护] 该列表的顺序直接影响 macOS 平台标签的优先级。',
    '[不变量] universal 家族同时覆盖 x86 与 ppc 历史架构。',
    '[边界] 非 macOS 架构属于编程错误，直接 unreachable。',
    '[权衡] 用静态切片而非动态构造，换取零分配与稳定顺序。',
  ]],
  ['fn from_arch(arch: Arch) -> Result<Self, PlatformError> {', [
    '把内部架构枚举映射为 Android ABI。',
    '[不变量] 四种受支持架构各对应一个 ABI。',
    '[边界] 其它架构返回 InvalidAndroidArch。',
    '[维护] 该函数与 arch 方法互为逆运算。',
    '[不变量] 映射结果用于拼接也就是轮子文件名中的最后一段。',
    '[边界] 错误携带原始架构，便于用户判断目标平台是否受支持。',
    '[权衡] 返回 Result 而非 Option，保留具体错误类型。',
  ]],
  ['fn from_arch(arch: Arch, simulator: bool) -> Result<Self, PlatformError> {', [
    '结合架构与模拟器标志推导 iOS 多架构标识。',
    '[不变量] 模拟器优先判断，再按架构细分。',
    '[边界] 真机只接受 arm64，模拟器接受 arm64 与 x86_64。',
    '[维护] 模拟器与真机使用不同的错误变体。',
    '[不变量] 该标识会进入 ios 平台标签的后缀。',
    '[边界] 非法组合显式报错，不做静默降级。',
    '[权衡] 用布尔参数区分场景，避免为模拟器再定义一套枚举。',
  ]],
  ['if let Some(min_minor) = arch.get_minimum_manylinux_minor() {', [
    '只有当架构声明了最小 manylinux 版本时才展开现代标签。',
    '[不变量] 旧架构可能只支持 legacy 别名。',
    '[边界] 缺少最小版本时直接跳过整个循环。',
    '[维护] 该判断决定了是否出现 manylinux_2_x 系列。',
    '[不变量] 下界来自架构定义，而不是平台标签生成逻辑。',
    '[边界] 即使请求的 minor 更低，也不会生成低于下界的标签。',
    '[权衡] 把架构差异收敛到 Arch 层，保持此函数简单。',
  ]],
  ['if minor == 12 {', [
    '在 glibc 2.12 处插入 manylinux2010 别名。',
    '[不变量] 别名紧跟现代标签之后，优先级更低。',
    '[边界] 该别名只在此处生成一次。',
    '[维护] 2.17 与 2.5 处有对称逻辑，修改时需三处同步。',
    '[不变量] 别名的存在让旧轮子无需重新打包即可命中。',
    '[权衡] 用固定节点映射历史 PEP，而非动态推导。',
  ]],
];

const items = defs.map(([needle, lines], i) => ({ line: L(needle) + 1, anchor: null, lines }));
for (const it of items) it.anchor = src[it.line - 1];

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-uvr-d5b-5.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((a, b) => a + b.lines.length, 0));
