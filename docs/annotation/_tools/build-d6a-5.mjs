import fs from 'node:fs';

const file = 'd:\\code\\opensource\\uv\\crates\\uv\\src\\lib.rs';
const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);

const blocks = [
  [2650, 'let args = settings::InitSettings::resolve(args, filesystem, environment)?;', [
    '折叠初始化命令的三层设置。',
    '[不变量] 命令行显式参数覆盖配置文件与环境变量。',
    '[边界] 初始化目标路径来自已解析的项目目录。',
    '[维护] 生成的模板字段需与 InitSettings 保持一一对应。',
    '[不变量] 解析失败直接返回，不会创建任何文件。',
  ]],
  [2701, 'let args = settings::RunSettings::resolve(args, filesystem, environment)?;', [
    '折叠运行命令的三层设置。',
    '[不变量] 同步开关、脚本参数与环境选择在此统一确定。',
    '[边界] 外部命令本身不参与设置折叠。',
    '[维护] 运行环境变量（如 PATH 注入）在命令执行前组装。',
    '[不变量] 解析完成后不再读取原始 CLI 参数。',
  ]],
  [2781, 'let args = settings::SyncSettings::resolve(args, filesystem, environment)?;', [
    '折叠同步命令的三层设置。',
    '[不变量] locked 与 frozen 的优先级在设置层已确定。',
    '[边界] 目标环境由项目配置推导，可被命令行覆盖。',
    '[维护] 同步选项与安装选项在此汇总。',
    '[不变量] 解析只读取配置，不触碰环境。',
  ]],
  [2844, 'let args = settings::LockSettings::resolve(args, filesystem, environment)?;', [
    '折叠加锁命令的三层设置。',
    '[不变量] 升级策略与排除规则在此合并。',
    '[边界] check 模式只影响后续分支，不改变解析结果。',
    '[维护] 锁文件路径来自工作区发现，不在此解析。',
    '[不变量] 解析阶段不写入锁文件。',
  ]],
  [2902, 'let args = settings::UpgradeSettings::resolve(args, filesystem, environment)?;', [
    '折叠升级命令的三层设置。',
    '[不变量] 目标包列表经合并与去重后保持稳定顺序。',
    '[边界] 未指定包时表示升级全部。',
    '[维护] 升级策略与 lock 共用同一套枚举。',
    '[不变量] 解析阶段不修改项目声明。',
  ]],
  [2937, 'let mut args = settings::AddSettings::resolve(args, filesystem, environment)?;', [
    '折叠添加命令的三层设置，并允许后续就地修改。',
    '[不变量] 可变绑定用于补充脚本模式下的依赖来源。',
    '[边界] 依赖分组与可编辑标记在此确定。',
    '[维护] 后续写入 pyproject 前会再次规范化依赖。',
    '[不变量] 解析失败不会留下部分写入。',
  ]],
  [3078, 'let args = settings::RemoveSettings::resolve(args, filesystem, environment)?;', [
    '折叠移除命令的三层设置。',
    '[不变量] 目标包名保持用户输入顺序。',
    '[边界] 分组信息来自配置文件而非命令行。',
    '[维护] 与 add 共用依赖分组解析。',
    '[不变量] 解析阶段不修改项目声明。',
  ]],
  [3134, 'let args = settings::VersionSettings::resolve(args, filesystem, environment)?;', [
    '折叠版本命令的三层设置。',
    '[不变量] 版本递增类型在此归一化为枚举。',
    '[边界] 只读模式与写入模式共用同一解析结果。',
    '[维护] 版本号格式校验在设置层完成。',
    '[不变量] 解析阶段不读取现有版本。',
  ]],
  [3192, 'let args = settings::TreeSettings::resolve(args, filesystem, environment)?;', [
    '折叠依赖树命令的三层设置。',
    '[不变量] 深度、反转与格式选项在此合并。',
    '[边界] 树的数据来源是锁文件。',
    '[维护] 渲染参数与导出命令保持独立。',
    '[不变量] 解析阶段不读取锁文件。',
  ]],
  [3245, 'let args = settings::ExportSettings::resolve(args, filesystem, environment)?;', [
    '折叠导出命令的三层设置。',
    '[不变量] 目标平台、额外组与哈希选项在此确定。',
    '[边界] 输出目标可以是文件或标准输出。',
    '[维护] 导出内容需与 requirements-txt 解析器兼容。',
    '[不变量] 解析阶段不写任何文件。',
  ]],
  [3303, 'let args = settings::FormatSettings::resolve(args, filesystem, environment);', [
    '折叠格式化命令的三层设置。',
    '[不变量] 该解析不返回错误，缺省值即合法配置。',
    '[边界] check 模式只影响后续执行。',
    '[维护] 格式化器版本与默认规则来自内置工具链。',
    '[不变量] 解析阶段不遍历源文件。',
  ]],
  [3334, 'let args = settings::CheckSettings::resolve(args, filesystem, environment)?;', [
    '折叠检查命令的三层设置。',
    '[不变量] 检查项集合在设置层已确定。',
    '[边界] 输出格式与退出码策略来自参数。',
    '[维护] 新增检查项需同步扩展诊断输出。',
    '[不变量] 解析阶段不读取锁文件内容。',
  ]],
  [3397, 'let args = settings::AuditSettings::resolve(audit_args, filesystem, environment)?;', [
    '折叠审计命令的三层设置。',
    '[不变量] 严重级别与输出格式在此归一化。',
    '[边界] 审计输入固定为锁文件。',
    '[维护] 与 tool audit 共用漏洞数据源配置。',
    '[不变量] 解析阶段不发起网络请求。',
  ]],
  [0, 'pub unsafe fn main<I, T>(args: I) -> ExitCode', [
    '进程入口的内部实现。',
    '[不变量] 参数解析与日志初始化在任何业务逻辑之前。',
    '[边界] 解析失败直接返回非零退出码。',
    '[维护] 运行时在此创建并在退出前关闭。',
    '[不变量] 所有错误都经过统一渲染后输出。',
    '[权衡] 同步入口便于嵌入与测试，运行时由内部管理。',
    '[边界] panic 钩子只影响展示，不改变退出语义。',
    '[维护] 退出码约定需与 CLI 文档保持一致。',
    '[不变量] 该函数不返回 Result，失败一律转成 ExitCode。',
    '[边界] 全局状态只在此初始化一次。',
  ]],
  [0, 'fn suggest_subcommand(err: &mut Error) {', [
    '为未知子命令错误补充拼写建议。',
    '[不变量] 只处理命令解析类错误。',
    '[边界] 无相近候选时不修改错误。',
    '[维护] 候选集合来自 Clap 的子命令定义。',
    '[不变量] 建议只追加提示，不改变原始错误文本。',
    '[权衡] 编辑距离阈值需在噪音与召回之间取舍。',
    '[边界] 该函数要求可变借用，调用方需持有唯一所有权。',
    '[维护] 新增命令后无需改动，候选自动扩展。',
    '[不变量] 建议内容不包含内部路径或版本细节。',
    '[边界] 仅在错误链顶层可写时调用。',
  ]],
];

const items = blocks.map(([line, expect, lines]) => {
  if (line === 0) {
    const hits = [];
    src.forEach((l, i) => {
      if (l.trim() === expect.trim()) hits.push(i);
    });
    if (hits.length !== 1) throw new Error(`search not unique (${hits.length}): ${expect}`);
    return { line: hits[0] + 1, anchor: src[hits[0]], lines };
  }
  const actual = src[line - 1];
  const prefix = expect.trim().split(' {')[0];
  if (!actual || !actual.trim().startsWith(prefix)) {
    throw new Error(`line ${line} mismatch: ${JSON.stringify(actual)} !~ ${prefix}`);
  }
  return { line, anchor: actual, lines };
});

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-uvr-d6a-5.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((a, b) => a + b.lines.length, 0));
