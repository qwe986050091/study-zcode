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

const defs = [
  ['ProjectCommand::Init(args) => {', [
    '初始化项目或脚本。',
    '[不变量] 已存在的 pyproject.toml 不会被覆盖，除非显式允许。',
    '[边界] 支持应用、库与 PEP 723 脚本三种形态。',
    '[不变量] 初始化会写入 .python-version，固定解释器选择。',
    '[维护] 生成的模板与 uv init 的 CLI 参数需保持同步。',
    '[权衡] 该命令不解析依赖，只搭建骨架。',
  ]],
  ['ProjectCommand::Run(args) => {', [
    '在项目环境中运行命令或脚本。',
    '[不变量] 默认先同步环境，再执行目标命令。',
    '[边界] --no-sync 可跳过同步，直接使用现有环境。',
    '[不变量] 退出码透传自子进程，便于脚本判断。',
    '[维护] 该命令需要解析外部命令与脚本两条路径。',
  ]],
  ['ProjectCommand::Sync(args) => {', [
    '按锁文件同步项目环境。',
    '[不变量] 锁文件存在时以它为准，不重新求解。',
    '[边界] --locked 要求锁文件已是最新，--frozen 连校验都跳过。',
    '[不变量] 同步是幂等的，重复执行不会改变环境。',
    '[维护] 与 pip sync 共用安装实现，差异在输入来源。',
  ]],
  ['ProjectCommand::Lock(args) => {', [
    '更新锁文件而不安装依赖。',
    '[不变量] 求解结果写入 uv.lock，环境保持不变。',
    '[边界] --check 只校验是否需要更新，不写文件。',
    '[不变量] 锁文件包含完整解析结果与哈希。',
    '[维护] 与 sync 共享求解器，但后者会继续安装。',
  ]],
  ['ProjectCommand::Upgrade(args) => {', [
    '升级项目依赖并刷新锁文件。',
    '[不变量] 未指定包时升级全部可升级依赖。',
    '[边界] 受版本约束限制，不会越过声明的区间。',
    '[不变量] 升级后立即同步环境。',
    '[维护] 与 add 的区别是不修改 pyproject 声明。',
  ]],
  ['ProjectCommand::Add(args) => {', [
    '添加依赖并写入项目配置。',
    '[不变量] 先求解、再写 pyproject、最后写锁文件。',
    '[边界] 脚本模式下依赖写入 PEP 723 元数据块。',
    '[不变量] 添加失败时不会留下半写入的配置。',
    '[维护] 依赖分组与来源解析由 AddSettings 统一处理。',
  ]],
  ['ProjectCommand::Remove(args) => {', [
    '移除项目依赖。',
    '[不变量] 同时更新 pyproject 与锁文件。',
    '[边界] 仅移除声明，不自动删除环境中的包。',
    '[不变量] 未声明的包会给出提示而非静默忽略。',
    '[维护] 与 add 共用脚本模式判断。',
  ]],
  ['ProjectCommand::Version(args) => {', [
    '读取或修改项目版本。',
    '[不变量] 修改会同时更新 pyproject 与锁文件中的项目版本。',
    '[边界] 支持 major、minor、patch 与显式版本。',
    '[不变量] 只读模式下不写任何文件。',
    '[维护] 版本格式遵循 PEP 440。',
  ]],
  ['ProjectCommand::Tree(args) => {', [
    '以树形展示项目依赖。',
    '[不变量] 数据来自锁文件，不重新求解。',
    '[边界] 支持按深度与反转方向过滤。',
    '[不变量] 输出稳定，便于 diff。',
    '[维护] 与 pip tree 共用渲染逻辑。',
  ]],
  ['ProjectCommand::Export(args) => {', [
    '把锁文件导出为 requirements 格式。',
    '[不变量] 导出结果可直接被 pip 使用。',
    '[边界] 可选择平台、额外依赖组与哈希。',
    '[不变量] 不修改项目状态，是纯读操作。',
    '[维护] 输出格式需与 requirements-txt 解析器保持兼容。',
  ]],
  ['ProjectCommand::Format(args) => {', [
    '格式化项目中的 Python 代码。',
    '[不变量] 默认使用内置的 ruff 配置。',
    '[边界] --check 只检查不修改。',
    '[不变量] 格式化范围限定在项目目录内。',
    '[维护] 该命令依赖内置工具链，不走项目环境。',
  ]],
  ['ProjectCommand::Check(args) => {', [
    '检查项目配置与锁文件状态。',
    '[不变量] 只读检查，不修改任何文件。',
    '[边界] 发现不一致时以非零状态退出。',
    '[不变量] 检查项包含锁文件新鲜度与依赖一致性。',
    '[维护] 新增检查项时需同步更新诊断信息。',
  ]],
  ['ProjectCommand::Audit(audit_args) => {', [
    '审计项目依赖的安全漏洞。',
    '[不变量] 只读，不修改锁文件或环境。',
    '[边界] 可限定输出格式与严重级别。',
    '[不变量] 审计基于锁文件中的确定版本。',
    '[维护] 漏洞数据源与 tool audit 保持一致。',
  ]],
  ['async fn run_project(', [
    '项目命令的统一执行入口。',
    '[不变量] 进入前已完成工作区发现，此处只做命令级编排。',
    '[边界] 需要环境变更的命令会先初始化缓存与客户端。',
    '[验证] 主动读取并校验工作区元数据，避免下游重复解析。',
    '[维护] 新增项目命令时需在此补充分派与参数组装。',
  ]],
  ['fn map_settings_error(err: uv_settings::Error) -> anyhow::Error {', [
    '把设置层错误转换为顶层错误。',
    '[不变量] 保留原始错误链与提示。',
    '[边界] 转换不改变错误分类，只做类型适配。',
    '[维护] 设置层新增错误变体时无需改动此处。',
  ]],
  ['fn required_version_error(', [
    '构造版本不满足约束时的错误信息。',
    '[不变量] 错误中同时包含期望区间与实际版本。',
    '[边界] 提示用户升级 uv 或调整约束。',
    '[维护] 文案需与设置层的 required-version 解析保持一致。',
  ]],
  ['fn suggest_subcommand(err: &mut Error) {', [
    '为未知子命令错误追加拼写建议。',
    '[不变量] 仅在错误来自命令解析时追加。',
    '[边界] 找不到相近命令时不修改原错误。',
    '[不变量] 建议使用编辑距离筛选，避免噪音。',
    '[维护] 该函数直接修改错误对象，调用方需保证所有权。',
  ]],
  ['pub unsafe fn main<I, T>(args: I) -> ExitCode', [
    '进程入口：解析参数、初始化日志并调度 run。',
    '[不变量] 该函数标记为 unsafe，因为依赖调用方保证的全局约束。',
    '[边界] 解析失败直接返回非零退出码，不进入 run。',
    '[不变量] 所有错误在此统一渲染为用户可读信息。',
    '[维护] panic 钩子与错误链输出集中在此配置。',
    '[权衡] 同步入口内部自建运行时，避免调用方依赖 tokio。',
  ]],
];

const items = defs.map(([needle, lines]) => {
  const idx = L(needle);
  return { line: idx + 1, anchor: src[idx], lines };
});

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-uvr-d6a-4.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((a, b) => a + b.lines.length, 0));
