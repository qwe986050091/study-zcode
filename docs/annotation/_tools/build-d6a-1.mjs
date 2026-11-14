import fs from 'node:fs';

const file = 'd:\\code\\opensource\\uv\\crates\\uv\\src\\lib.rs';
const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);

function L(needle) {
  const hits = [];
  src.forEach((l, i) => {
    if (l.trim() === needle.trim()) hits.push(i);
  });
  if (hits.length !== 1) throw new Error(`not unique (${hits.length}): ${needle}`);
  return hits[0];
}

const head = [
  'uv 命令行的顶层入口：负责把 Clap 解析结果折叠成设置、发现工作区、初始化全局状态，',
  '再把控制流分派给 commands 模块中的具体实现。',
  '',
  '[不变量] 本文件不做业务逻辑，只负责顺序编排与跨模块参数组装。',
  '[不变量] 所有命令最终返回 ExitStatus，错误统一向上抛给 main 处理。',
  '[不变量] 设置解析一律走 settings 模块，保证 CLI、环境变量、配置文件三层折叠一致。',
  '[边界] 初始化分为完整与轻量两种模式，供测试与嵌入场景复用。',
  '[维护] 新增命令时需同时更新 Cli 枚举、此处分派与 commands 模块。',
];

const defs = [
  ['fn base_client_builder<\'a>(globals: &GlobalSettings) -> BaseClientBuilder<\'a> {', [
    '由全局设置构造共享的 HTTP 客户端构建器。',
    '[不变量] 连接超时、重试、证书等网络参数全部来自 GlobalSettings。',
    '[边界] 返回值生命周期绑定 globals，调用方不得让其逃逸。',
    '[维护] 新增网络参数时应在此统一注入，避免各命令各自拼装。',
  ]],
  ['pub enum GlobalInitialization {', [
    '全局初始化模式，决定是否执行日志、预览特性等一次性初始化。',
    '[不变量] 这些初始化只能执行一次，重复调用会报错。',
    '[边界] 轻量模式用于测试或已由调用方完成初始化的场景。',
    '[维护] 标记为 must-use，避免调用方无意忽略返回值。',
  ]],
  ['const fn needs_initialization(self) -> bool {', [
    '判断当前模式是否需要执行一次性初始化。',
    '[不变量] 常量函数保证可在编译期折叠，避免运行期分支开销。',
    '[边界] 只有 Full 模式返回真。',
  ]],
  ['struct ExternallyInstalledError {', [
    '外部安装冲突的提示载体。',
    '[不变量] 该类型只承载提示，不改变原始错误类型。',
    '[边界] 由 uv_errors 的 Hinted 机制统一渲染。',
  ]],
  ['fn hints(&self) -> uv_errors::Hints<\'_> {', [
    '为外部安装冲突生成用户可执行的建议。',
    '[不变量] 建议按「卸载 / 使用系统 Python / 忽略」的顺序给出。',
    '[边界] 提示内容不包含内部路径细节，避免噪音。',
    '[维护] 新增处置方式时应在同一处集中追加。',
  ]],
  ['pub async fn run(cli: Cli, global_initialization: GlobalInitialization) -> Result<ExitStatus> {', [
    '命令执行的唯一编排入口。',
    '[不变量] 执行顺序固定：发现配置 → 切换目录 → 解析运行目标 → 加载环境 → 解析设置 → 分派。',
    '[边界] 任何阶段失败都立即返回，不会进入后续分派。',
    '[权衡] 顺序刻意前置副作用（切目录、设颜色），让错误信息也带上正确上下文。',
    '[维护] 新增全局设置时要明确插入点，避免被后续阶段读取到旧值。',
  ]],
  ['// Configure color before resolving settings so argument errors retain their styling.', [
    '颜色选择必须在设置解析之前完成。',
    '[不变量] 否则设置解析阶段的报错会丢失样式。',
    '[边界] 仅影响终端输出，不改变任何语义。',
  ]],
  ['// Respect `UV_WORKING_DIRECTORY` for backwards compatibility.', [
    '目录优先级：命令行显式参数高于兼容环境变量。',
    '[不变量] 目录切换尽可能早，后续相对路径解析都基于新目录。',
    '[边界] 环境变量仅为向后兼容保留。',
    '[维护] 未来移除该变量时只需删除回落分支。',
  ]],
  ['// Parse the external command, if necessary.', [
    '提前解析 uv run 的外部命令。',
    '[不变量] 只有 Project Run 且带 command 时才解析，其它命令保持为空。',
    '[边界] 解析发生在配置发现之前，因为脚本目录会影响工作区根。',
    '[维护] 该结果同时用于目录推导与后续执行，不能延后解析。',
  ]],
  ['// Load environment variables not handled by Clap.', [
    '加载 Clap 未覆盖的环境变量。',
    '[不变量] 该步骤发生在预览标志解析之前，保证环境变量可影响预览。',
    '[边界] 只读取白名单变量，不遍历全部环境。',
  ]],
  ['// Resolve preview flags before config discovery for decisions that affect the discovery root.', [
    '预览标志必须早于配置文件发现。',
    '[不变量] 某些预览特性会改变发现根，因此不能等到设置解析后。',
    '[边界] 此处只解析早期需要的子集，完整解析仍在后面。',
    '[维护] 新增影响发现行为的预览特性时需在此提前解析。',
  ]],
  ['// Determine the project directory.', [
    '推导项目目录，并处理三种来源。',
    '[不变量] --project 指向 pyproject.toml 时上溯到父目录。',
    '[不变量] 运行目标带脚本目录时以脚本目录为起点。',
    '[边界] 否则退回当前工作目录。',
    '[维护] 下游一律按目录处理，因此这里必须完成文件到目录的归一化。',
  ]],
  ['// Validate that the project directory exists if explicitly provided via --project, except for', [
    '显式指定的项目目录必须存在且是目录。',
    '[不变量] uv init 例外，因为它负责创建目录。',
    '[边界] pyproject.toml 已在上面归一化为父目录，此处只拦截其它文件类型。',
  ]],
  ['// The `--isolated` argument is deprecated on preview APIs, and warns on non-preview APIs.', [
    '处理 --isolated 的废弃语义。',
    '[不变量] 支持该参数作为独立选项的命令不产生警告。',
    '[不变量] 预览命令忽略该参数并警告。',
    '[边界] 非预览命令继续生效，但同样警告。',
    '[维护] 返回值决定后续是否跳过配置文件发现。',
  ]],
  ['// Load configuration from the filesystem, prioritizing (in order):', [
    '配置文件加载的三级优先顺序说明。',
    '[不变量] 命令行指定的文件优先级最高。',
    '[不变量] 其次是工作区根之上的最近配置文件，并与用户级配置合并。',
    '[边界] 最后才是从当前目录向上查找。',
    '[维护] 合并方向固定为「项目 → 用户 → 系统」。',
  ]],
  ['// Pass the (possibly non-existent) cache dir path to the initial workspace discovery.', [
    '工作区发现阶段就需要缓存目录。',
    '[不变量] 即使目录尚不存在也允许传入，后续按需创建。',
    '[边界] 缓存目录只影响发现阶段的读写，不改变发现结果。',
  ]],
  ['// If the target is a remote script, download it.', [
    '解析运行目标：远程脚本先下载，PEP 723 脚本先读取。',
    '[不变量] 只有 uv run 路径会进入该分支。',
    '[边界] 解析所需的设置在此处局部构造，避免污染全局设置。',
    '[维护] 该步骤必须在配置合并之前完成，因为脚本元数据也会参与合并。',
  ]],
  ['// If the target is a PEP 723 script, merge the metadata into the filesystem metadata.', [
    '把脚本内嵌的 uv 配置合并进文件系统配置。',
    '[不变量] 脚本配置优先级高于同目录配置文件。',
    '[边界] 脚本路径先相对化到脚本目录，保证相对路径语义正确。',
    '[维护] 合并结果会参与后续全局设置解析，顺序不可颠倒。',
  ]],
  ['let custom_certificate_file = match &*cli.command {', [
    '仅 pip 系列命令支持自定义证书。',
    '[不变量] 其它命令返回 None，沿用全局默认证书。',
    '[边界] 该值在全局设置解析前提取，因为解析需要它。',
  ]],
  ['// Resolve the global settings.', [
    '解析全局设置，形成后续所有命令共享的配置快照。',
    '[不变量] 输入为 CLI、文件系统配置、环境变量与证书四部分。',
    '[边界] 解析失败立即返回，不执行任何命令逻辑。',
    '[维护] 该快照不可变，命令内不得再读取原始配置。',
  ]],
  ['// Adjust open file limits on Unix.', [
    'Unix 下尝试提高文件描述符上限。',
    '[不变量] 失败只记录调试日志，不阻断命令。',
    '[边界] 仅在完整初始化模式下执行，避免测试环境副作用。',
  ]],
  ['// Resolve the cache settings.', [
    '解析缓存设置。',
    '[不变量] 结果与全局设置独立，供各命令按需使用。',
    '[边界] 此处只解析不创建目录。',
  ]],
];

const items = defs.map(([needle, lines]) => {
  const idx = L(needle);
  return { line: idx + 1, anchor: src[idx], lines };
});

fs.writeFileSync(
  'd:\\code\\_annot_baseline\\spec-uvr-d6a-1.json',
  JSON.stringify([{ file, head, items }], null, 2),
);
console.log('head', head.length, 'items', items.length, 'lines', items.reduce((a, b) => a + b.lines.length, 0));
