import fs from 'node:fs';

const file = 'd:\\code\\opensource\\uv\\crates\\uv\\src\\lib.rs';
const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);

const blocks = [
  [637, 'if global_initialization.needs_initialization() {', [
    '设置并固化全局预览特性配置。',
    '[不变量] set 之后必须 finalize，否则后续读取会 panic。',
    '[边界] 仅在完整初始化模式下执行，重复初始化会报错。',
    '[维护] 预览特性一旦固化不可变更，因此必须放在所有早期解析之后。',
  ]],
  [643, '// Enforce the required version.', [
    '校验 required-version 约束。',
    '[不变量] 当前版本必须落在约束区间内，否则立即失败。',
    '[边界] 版本比较使用 PEP 440 语义，而不是字符串比较。',
    '[维护] 该检查早于任何命令执行，避免在不兼容版本上产生副作用。',
  ]],
  [651, '// Configure the `Printer`, which controls user-facing output in the CLI.', [
    '构造统一的输出器。',
    '[不变量] quiet、verbose、no_progress 三个开关只在此处读取一次。',
    '[边界] 之后所有输出都经由 printer，禁止直接 println。',
    '[维护] 新增输出通道时应扩展 Printer 而不是绕开它。',
  ]],
  [654, '// Configure the `warn!` macros, which control user-facing warnings in the CLI.', [
    '根据 quiet 级别启用或禁用全局警告。',
    '[不变量] 警告开关是进程级全局状态，只在此处设置。',
    '[边界] debug 日志不受该开关影响。',
  ]],
  [661, 'anstream::ColorChoice::write_global(globals.color.into());', [
    '把最终颜色选择写入全局状态。',
    '[不变量] 此处写入会覆盖早期的临时选择。',
    '[边界] 仅影响终端渲染，不改变输出内容。',
  ]],
  [663, '// Don\'t initialize the rayon threadpool yet, this is too costly when we\'re doing a noop sync.', [
    '只记录并发度，延迟初始化 rayon 线程池。',
    '[不变量] 线程池在真正需要并行时才创建。',
    '[边界] 空操作同步不应付出线程池启动成本。',
    '[权衡] 用原子变量传参，避免提前触发初始化。',
    '[维护] 读取该值的模块需容忍线程池尚未创建。',
  ]],
  [667, 'macro_rules! show_settings {', [
    '统一的设置展示宏，支持三种调用形态。',
    '[不变量] 带逗号形态在展示后直接成功返回，用于「只看设置」场景。',
    '[不变量] 带 false 的形态只打印不返回，用于继续执行。',
    '[边界] 输出使用 Debug 美化格式，便于人工阅读。',
    '[维护] 新增设置类型时应直接复用该宏，保持输出风格一致。',
    '[权衡] 宏而非函数，才能在调用点提前 return。',
    '[不变量] 所有分支都受同一 show_settings 开关控制。',
    '[边界] 无参数形态不打印任何内容，只做提前返回判断。',
  ]],
  [688, '// Configure the cache.', [
    '构造缓存对象并处理禁用场景。',
    '[不变量] --no-cache 时仍构造 Cache，只是不落盘。',
    '[边界] 缓存目录解析失败会直接终止。',
    '[维护] 缓存对象是后续所有命令共享的唯一实例。',
  ]],
  [693, '// This check happens after the first (fallible) workspace discovery, which we need to resolve', [
    '缓存目录的绝对化与安全检查。',
    '[不变量] 必须在设置解析之后、业务发现之前完成。',
    '[边界] 绝对化失败会向上抛错。',
    '[维护] 注释说明了两次工作区发现的先后关系，改动顺序需谨慎。',
  ]],
  [697, '// PEP 517 hooks run from uv-managed source trees, including source distributions extracted', [
    '识别项目是否位于构建目录内部。',
    '[不变量] 构建目录本身允许位于缓存内，因为那是 uv 自己创建的。',
    '[边界] 同时比较路径字面量与规范化后的真实路径。',
    '[维护] 该标记用于豁免下面的缓存包含检查。',
    '[权衡] 双重比较是为了兼容符号链接与不同大小写文件系统。',
  ]],
  [709, 'if !project_is_in_build_dir {', [
    '禁止项目目录位于缓存目录内部。',
    '[不变量] 字面路径与规范化路径都要检查，防止绕过。',
    '[边界] 构建目录场景已在上方豁免。',
    '[维护] 该保护避免缓存清理误删用户项目。',
  ]],
  [729, '// Workspace discovery excludes the cache root, so only reuse the earlier discovery when the', [
    '按缓存根是否一致决定是否复用早期工作区发现结果。',
    '[不变量] 根不一致时必须重新发现，否则会遗漏或误含缓存目录。',
    '[边界] 复用可省去一次完整遍历。',
    '[维护] 缓存根在设置解析后可能变化，因此需要此判断。',
  ]],
  [737, '// Configure the global network settings.', [
    '构造全局 HTTP 客户端构建器。',
    '[不变量] 所有子命令共享同一套网络配置。',
    '[边界] 具体命令可追加子命令标识，但不能改变连接参数。',
    '[维护] 认证、超时、重试均在此统一注入。',
  ]],
];

const items = blocks.map(([line, expect, lines]) => {
  const actual = src[line - 1];
  const prefix = expect.trim().split(' {')[0];
  if (!actual || !actual.trim().startsWith(prefix)) {
    throw new Error(`line ${line} mismatch: ${JSON.stringify(actual)} !~ ${prefix}`);
  }
  return { line, anchor: actual, lines };
});

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-uvr-d6a-3.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((a, b) => a + b.lines.length, 0));
