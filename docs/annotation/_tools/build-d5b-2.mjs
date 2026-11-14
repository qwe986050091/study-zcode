import fs from 'node:fs';

const file = 'd:\\code\\opensource\\uv\\crates\\uv-platform-tags\\src\\tags.rs';
const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);

function pick(needle) {
  const hits = src.filter((l) => l.trim() === needle.trim());
  if (hits.length !== 1) throw new Error(`anchor not unique (${hits.length}): ${needle}`);
  return hits[0];
}

const blocks = [
  ['(Os::Manylinux { major, minor }, _) => {', [
    'manylinux 分支：从当前 glibc minor 向下枚举到架构允许的最小值。',
    '[不变量] wider minor 的标签始终排在前面，兼容性更强。',
    '[边界] 架构没有最小 manylinux 版本时，只返回 legacy 的 linux 标签。',
    '[权衡] 枚举而非按需计算，换取匹配期零分配。',
  ]],
  ['// Support legacy manylinux tags with lower priority', [
    '在特定 minor 处插入 PEP 600 之前的 legacy 别名。',
    '[不变量] legacy 标签紧跟同一 minor 的现代标签之后，优先级更低。',
    '[边界] 只映射 1、2010、2014 三个历史节点，其余 minor 不生成别名。',
  ]],
  ['(Os::Musllinux { major, minor }, _) => {', [
    'musllinux 分支：逐 minor 向下展开，再附加通用 linux 标签兜底。',
    '[不变量] musl 与 glibc 的标签互不兼容，因此不在此处生成 manylinux。',
    '[边界] 通用 linux 标签优先级最低，仅用于识别未标注 libc 的轮子。',
  ]],
  ['(Os::Macos { major, minor }, Arch::X86_64) => {', [
    'macOS x86_64 分支：区分 10.x 与 11+ 两套版本语义。',
    '[不变量] 每个版本点都要展开该架构支持的全部二进制格式。',
    '[边界] 低于 10.4 的版本直接报错，因为不存在可用轮子。',
    '[维护] 版本上限仅由当前系统决定，不设置硬编码天花板。',
  ]],
  ['value if *value >= 11 => {', [
    'macOS 11 起改为每年递增 major，minor 固定为 0。',
    '[不变量] 11+ 版本之后仍补 10.4 到 10.16 的 universal2 候选。',
    '[边界] 这些补充候选只在 x86_64 上生成，且使用 universal2 格式。',
  ]],
  ['(Os::Macos { major, .. }, Arch::Aarch64) => {', [
    'macOS arm64 分支：Apple Silicon 只支持 11 以上版本。',
    '[不变量] 二进制格式由架构推导，仅 arm64 与 universal2。',
    '[边界] 10.x 补充候选固定使用 universal2，以兼容 x86_64 部分。',
  ]],
  ['(Os::FreeBsd { release }, arch) => {', [
    'BSD 家族分支：把发行版版本与架构拼成 release_arch 标签。',
    '[不变量] 点与连字符统一替换为下划线并转小写，以匹配 wheel 规范。',
    '[边界] 解析失败转成 InvalidReleaseArch，保留原始字符串便于诊断。',
  ]],
  ['(Os::Illumos { release, arch }, _) => {', [
    'illumos 分支：先判断是否为 Solaris 兼容模式。',
    '[不变量] major 大于等于 5 时按 SunOS 与 Solaris 的版本偏移换算。',
    '[边界] 版本号不是数字时直接报 OsVersionDetectionError。',
    '[权衡] 该换算是历史包袱，但能让旧 Solaris 轮子正确命中。',
  ]],
  ['(Os::Android { api_level }, arch) => {', [
    'Android 分支：从目标 API 级别向下枚举到 16。',
    '[不变量] 16 是 CPython 无需大幅修改即可支持的最低级别。',
    '[边界] ABI 由架构推导，不支持的架构返回 InvalidAndroidArch。',
    '[维护] 枚举顺序保证高 API 轮子优先于低 API 轮子。',
  ]],
  ['(Os::Pyodide { major, minor }, Arch::Wasm32) => {', [
    'Pyodide 分支：同时产出 pyodide 与 pyemscripten 两种平台标签。',
    '[不变量] 两者版本一致，只是命名不同，以兼容不同构建产物。',
    '[边界] 该分支只在 wasm32 架构下可达。',
  ]],
  ['(Os::PyEmscripten { major, minor }, Arch::Wasm32) => {', [
    'PyEmscripten 分支：与 Pyodide 保持对称的两个标签。',
    '[不变量] 顺序固定为先 pyemscripten 后 pyodide，与上游 packaging 一致。',
  ]],
  ['// Source: https://github.com/pypa/packaging/blob/e9b9d09ebc5992ecad1799da22ee5faefb9cc7cb/src/packaging/tags.py#L484', [
    'iOS 分支：从目标版本向下枚举到 12.0。',
    '[不变量] multiarch 由架构与是否模拟器共同决定。',
    '[边界] 12.0 是 CPython 可运行的最低 iOS 版本。',
    '[维护] minor 枚举到 9 而不是已知最大值，避免维护显式版本表。',
  ]],
  ['// If the requested major version is less than 12, there won\'t be any matches.', [
    '低于 12 的 major 直接返回空列表，而不是报错。',
    '[不变量] 空列表会让上层自然判定为不兼容，保持错误语义统一。',
  ]],
  ['pub enum BinaryFormat {', [
    'macOS 二进制格式枚举，对应 wheel 平台标签中的格式片段。',
    '[不变量] 枚举同时派生 rkyv 序列化，用于缓存跨进程传递。',
    '[边界] 变体集合来自上游 packaging 的固定列表，不应随意增删。',
  ]],
  ['impl BinaryFormat {', [
    '二进制格式与架构之间的转换工具集。',
    '[不变量] from_arch 给出该架构可运行的格式，按优先级降序。',
    '[边界] 非 macOS 架构调用 from_arch 属于编程错误，直接 unreachable。',
  ]],
  ['fn from_arch(arch: Arch) -> &\'static [Self] {', [
    '按架构返回可运行的二进制格式列表，顺序即优先级。',
    '[不变量] 列表首位永远是架构自身的原生格式。',
    '[边界] 通用格式排在专用格式之后，作为兼容兜底。',
  ]],
  ['pub enum AndroidAbi {', [
    'Android ABI 枚举，对应平台标签末尾的 ABI 片段。',
    '[不变量] 命名与 wheel 规范中的下划线形式一致。',
  ]],
  ['impl AndroidAbi {', [
    'Android ABI 与内部架构枚举的双向映射。',
    '[不变量] from_arch 与 arch 互为逆运算，往返转换应稳定。',
    '[边界] 不支持的架构返回 InvalidAndroidArch，而不是猜测默认值。',
  ]],
  ['pub enum IosMultiarch {', [
    'iOS 多架构标识，区分真机与模拟器。',
    '[不变量] 真机只支持 arm64，模拟器支持 arm64 与 x86_64。',
    '[边界] 该概念与 Linux multiarch 无关，命名容易混淆需注意。',
  ]],
  ['impl IosMultiarch {', [
    'iOS 多架构的推导与规范化命名。',
    '[不变量] 模拟器标志优先于架构判断，决定可选分支。',
    '[边界] 真机上的 x86_64 属于非法组合，直接报错。',
  ]],
];

const items = blocks.map(([needle, lines]) => ({ anchor: pick(needle), lines }));
fs.writeFileSync('d:\\code\\_annot_baseline\\spec-uvr-d5b-2.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((a, b) => a + b.lines.length, 0));
