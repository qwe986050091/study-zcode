import fs from 'node:fs';

const file = 'd:\\code\\opensource\\uv\\crates\\uv\\src\\lib.rs';
const src = fs.readFileSync(file, 'utf8').split(/\r?\n/);

const blocks = [
  [741, 'Commands::Auth(AuthNamespace {', [
    '认证登录：把凭据写入指定服务的存储。',
    '[不变量] 设置由 AuthLoginSettings 折叠，认证相关参数不再读原始 CLI。',
    '[边界] 凭据落盘位置由服务与用户名共同决定。',
    '[维护] 预览特性开关会改变可用的认证方式。',
    '[权衡] 解析与写入分离，便于测试时替换存储后端。',
  ]],
  [758, 'Commands::Auth(AuthNamespace {', [
    '认证登出：删除指定服务的已存凭据。',
    '[不变量] 未登录时登出是幂等操作。',
    '[边界] 只影响本机存储，不访问远端。',
    '[维护] 与登录共用服务与用户名的解析规则。',
  ]],
  [767, 'Commands::Auth(AuthNamespace {', [
    '打印指定服务的访问令牌。',
    '[不变量] 输出走 printer，遵循统一的脱敏与格式约定。',
    '[边界] 令牌不存在时返回错误而不是空输出。',
    '[维护] 该命令不修改存储，是纯读操作。',
  ]],
  [776, 'Commands::Auth(AuthNamespace {', [
    '打印凭据目录位置。',
    '[不变量] 目录不存在时也返回路径，便于脚本后续创建。',
    '[边界] 不创建目录、不读取凭据。',
    '[维护] 路径规则与登录写入保持一致。',
  ]],
  [782, 'Commands::Auth(AuthNamespace {', [
    '认证辅助协议入口，供外部构建工具调用。',
    '[不变量] 协议在分发前先校验，目前只支持 Bazel。',
    '[边界] 辅助命令只实现 Get，不提供写入能力。',
    '[维护] 新增协议时需同时扩展校验与分发两处。',
  ]],
  [796, 'Commands::Help(args) => commands::help(', [
    '帮助命令：按子命令路径渲染帮助文本。',
    '[不变量] 未指定路径时展示顶层帮助。',
    '[边界] no_pager 控制是否绕过分页器。',
    '[维护] 帮助内容来自 Clap 定义，此处不做文本拼装。',
  ]],
  [801, 'Commands::Pip(PipNamespace {', [
    'pip compile：把依赖声明编译为锁文件。',
    '[不变量] 输出格式与目标文件由 PipCompileSettings 决定。',
    '[边界] 输入来源可以是文件、标准输入或内联参数。',
    '[维护] 该命令与项目模式的 lock 共用求解器，但入口不同。',
  ]],
  [924, 'Commands::Pip(PipNamespace {', [
    'pip sync：按锁文件同步环境。',
    '[不变量] 同步以锁文件为唯一事实来源，不重新求解。',
    '[边界] 与 pip install 的差异在于输入是已锁定的集合。',
    '[维护] 环境定位逻辑与项目 sync 保持一致。',
  ]],
  [1017, 'Commands::Pip(PipNamespace {', [
    'pip install：从需求声明解析并安装。',
    '[不变量] 安装前会先求解完整依赖图。',
    '[边界] 可指定目标环境，默认使用当前虚拟环境。',
    '[维护] 该命令是兼容层，内部复用 uv 的解析与安装实现。',
  ]],
  [1183, 'Commands::Pip(PipNamespace {', [
    'pip uninstall：从环境中移除指定包。',
    '[不变量] 只移除显式列出的包，不级联删除孤立依赖。',
    '[边界] 包不存在时按参数决定是否报错。',
    '[维护] 与 pip install 共用环境解析逻辑。',
  ]],
  [1222, 'Commands::Pip(PipNamespace {', [
    'pip freeze：以需求格式输出已安装包。',
    '[不变量] 输出可直接作为需求文件复用。',
    '[边界] 是否包含编辑安装由参数控制。',
    '[维护] 输出顺序需稳定，便于 diff。',
  ]],
  [1248, 'Commands::Pip(PipNamespace {', [
    'pip list：列出环境中的包。',
    '[不变量] 支持多种输出格式，由 output_format 决定。',
    '[边界] 可按是否过期过滤。',
    '[维护] 与 freeze 的区别是面向人读而非复用。',
  ]],
  [1285, 'Commands::Pip(PipNamespace {', [
    'pip show：展示单个包的元数据。',
    '[不变量] 包名解析规则与安装一致。',
    '[边界] 未安装时返回错误。',
    '[维护] 元数据直接来自已安装分发信息。',
  ]],
  [1310, 'Commands::Pip(PipNamespace {', [
    'pip tree：以树形展示依赖关系。',
    '[不变量] 树的根为显式安装的包。',
    '[边界] 支持按深度与反转方向过滤。',
    '[维护] 依赖边来自已安装元数据，不重新求解。',
  ]],
  [1346, 'Commands::Pip(PipNamespace {', [
    'pip check：检查环境依赖一致性。',
    '[不变量] 只读检查，不修改环境。',
    '[边界] 发现冲突时以非零状态退出。',
    '[维护] 检查规则与安装期校验保持同步。',
  ]],
  [1368, 'Commands::Pip(PipNamespace {', [
    'pip debug：占位分支，当前直接报错。',
    '[不变量] 明确提示该子命令尚未实现。',
    '[边界] 不执行任何环境操作。',
    '[维护] 实现后应替换为真实的调试信息输出。',
  ]],
  [1374, 'Commands::Cache(CacheNamespace {', [
    '清理缓存：删除缓存目录内容。',
    '[不变量] 顶层 clean 与 cache clean 行为一致。',
    '[边界] 可只清理指定类型的缓存。',
    '[维护] 删除范围由缓存设置决定。',
  ]],
  [1381, 'Commands::Cache(CacheNamespace {', [
    '裁剪缓存：按保留策略删除旧条目。',
    '[不变量] 只删除超出策略的部分，保留近期条目。',
    '[边界] 策略参数来自 CachePruneSettings。',
    '[维护] 与 clean 的区别是保留策略而非全删。',
  ]],
  [1387, 'Commands::Cache(CacheNamespace {', [
    '打印缓存目录路径。',
    '[不变量] 不创建目录、不清理内容。',
    '[边界] 路径来自缓存设置，可能尚不存在。',
    '[维护] 与 auth dir、tool dir 的输出约定一致。',
  ]],
  [1393, 'Commands::Cache(CacheNamespace {', [
    '统计缓存占用大小。',
    '[不变量] 只读遍历，不修改缓存。',
    '[边界] 支持按输出格式渲染结果。',
    '[维护] 统计口径需与 prune 的保留策略一致。',
  ]],
  [1404, 'Commands::Build(args) => {', [
    '构建命令：调用构建前端产出 wheel 或 sdist。',
    '[不变量] 构建前会检查离线与刷新参数冲突。',
    '[边界] 可只构建指定包或全部工作区成员。',
    '[维护] 构建约束在此转换成需求来源后传入。',
    '[权衡] 该命令不安装依赖，只做构建。',
  ]],
  [1461, 'Commands::Venv(args) => {', [
    '创建虚拟环境。',
    '[不变量] 查找解释器时总是忽略现有虚拟环境。',
    '[边界] --system 与 --no-system 均已无实际效果，仅告警。',
    '[维护] 兼容参数校验在设置解析之前执行。',
    '[权衡] 保留废弃参数以避免破坏现有脚本。',
  ]],
  [1549, 'Commands::Project(project) => {', [
    '项目命令总入口，按 ProjectCommand 二次分派。',
    '[不变量] 所有项目命令共享同一份工作区发现结果。',
    '[边界] 该分支不直接执行业务，只负责路由。',
    '[维护] 新增项目子命令需同时更新此处与 run_project。',
  ]],
  [1567, 'Commands::Self_(SelfNamespace {', [
    '自更新：下载并替换当前可执行文件。',
    '[不变量] 支持指定目标版本与认证令牌。',
    '[边界] dry_run 只报告计划，不落盘。',
    '[维护] 更新源与校验逻辑由 self_update 模块负责。',
  ]],
  [1584, 'Commands::Self_(SelfNamespace {', [
    '打印 uv 自身版本。',
    '[不变量] short 只输出版本号，便于脚本解析。',
    '[边界] 支持结构化输出格式。',
    '[维护] 版本号来自编译期常量。',
  ]],
  [1595, 'Commands::Self_(_) => {', [
    '其余 self 子命令的兜底分支。',
    '[不变量] 显式报错而非静默成功。',
    '[边界] 用于提示子命令尚未实现。',
    '[维护] 实现新子命令后应从前置分支中移除。',
  ]],
  [1601, 'Commands::GenerateShellCompletion(args) => {', [
    '生成 Shell 补全脚本。',
    '[不变量] 输出到标准输出，由用户重定向到目标文件。',
    '[边界] 补全内容完全由 Clap 定义推导。',
    '[维护] 新增参数后无需手动维护补全脚本。',
  ]],
  [1605, 'Commands::Tool(ToolNamespace {', [
    'uvx 与 tool run 的共享入口。',
    '[不变量] 两者只在调用模式上不同，执行路径相同。',
    '[边界] 该分支把两种参数统一成 ToolRunCommand。',
    '[维护] 新增运行模式时只需扩展这里的映射。',
  ]],
  [1733, 'Commands::Tool(ToolNamespace { command: ToolCommand::Install(args), }) => {', [
    '安装工具到独立环境。',
    '[不变量] 每个工具拥有隔离环境，避免依赖冲突。',
    '[边界] 可指定 Python 版本与额外依赖。',
    '[维护] 安装结果记录在工具目录的元数据中。',
  ]],
  [1835, 'Commands::Tool(ToolNamespace { command: ToolCommand::List(args), }) => {', [
    '列出已安装工具。',
    '[不变量] 只读元数据，不扫描环境内容。',
    '[边界] 支持显示路径与版本等附加信息。',
    '[维护] 输出与 tool dir 的目录结构对应。',
  ]],
  [1861, 'Commands::Tool(ToolNamespace { command: ToolCommand::Audit(args), }) => {', [
    '审计工具环境的依赖安全性。',
    '[不变量] 只读检查，不修改已安装工具。',
    '[边界] 审计范围可限定到单个工具。',
    '[维护] 与项目 audit 共用漏洞数据源。',
  ]],
  [1885, 'Commands::Tool(ToolNamespace { command: ToolCommand::Upgrade(args), }) => {', [
    '升级已安装工具。',
    '[不变量] 未指定工具时升级全部。',
    '[边界] 升级会重建工具环境而不是原地替换包。',
    '[维护] 与 install 共用解析与安装流程。',
  ]],
  [1919, 'Commands::Tool(ToolNamespace { command: ToolCommand::Uninstall(args), }) => {', [
    '卸载工具及其环境。',
    '[不变量] 删除环境与元数据保持一致。',
    '[边界] 未安装时幂等返回。',
    '[维护] 该操作不可撤销，需在提示中明确。',
  ]],
  [1928, 'Commands::Tool(ToolNamespace { command: ToolCommand::UpdateShell, }) => {', [
    '刷新 Shell 中的工具可执行入口。',
    '[不变量] 只更新符号链接或包装脚本。',
    '[边界] 不重新安装工具本体。',
    '[维护] 用于手动修复 PATH 入口失效。',
  ]],
  [1934, 'Commands::Tool(ToolNamespace { command: ToolCommand::Dir(args), }) => {', [
    '打印工具目录路径。',
    '[不变量] 不创建目录。',
    '[边界] 可只显示指定工具的子目录。',
    '[维护] 路径规则与 install 写入位置一致。',
  ]],
  [1944, 'Commands::Python(PythonNamespace { command: PythonCommand::List(args), }) => {', [
    '列出可用的 Python 解释器。',
    '[不变量] 包含已安装与系统发现的解释器。',
    '[边界] 支持多种输出格式。',
    '[维护] 发现逻辑复用 python-discovery 模块。',
  ]],
  [1972, 'Commands::Python(PythonNamespace { command: PythonCommand::Install(args), }) => {', [
    '安装受管的 Python 解释器。',
    '[不变量] 安装目录由 python 安装设置决定。',
    '[边界] 可选择实现与版本，未指定时取默认。',
    '[维护] 下载与校验由 python-install 模块负责。',
  ]],
  [2005, 'Commands::Python(PythonNamespace { command: PythonCommand::Upgrade(args), }) => {', [
    '升级受管 Python 解释器。',
    '[不变量] 只升级受管安装，不触碰系统解释器。',
    '[边界] 未指定版本时升级到最新可用补丁。',
    '[维护] 与 install 共用下载与解压逻辑。',
  ]],
  [2039, 'Commands::Python(PythonNamespace { command: PythonCommand::Uninstall(args), }) => {', [
    '卸载受管 Python 解释器。',
    '[不变量] 拒绝卸载系统解释器。',
    '[边界] 未安装时幂等返回。',
    '[维护] 卸载前会检查是否仍被虚拟环境引用。',
  ]],
  [2048, 'Commands::Python(PythonNamespace { command: PythonCommand::Find(args), }) => {', [
    '查找满足条件的解释器。',
    '[不变量] 支持按脚本、版本与实现过滤。',
    '[边界] 找到多个时按优先级返回首个。',
    '[维护] 与运行期解释器选择共用同一套发现规则。',
  ]],
  [2093, 'Commands::Python(PythonNamespace { command: PythonCommand::Pin(args), }) => {', [
    '把解释器固定到项目配置。',
    '[不变量] 写入 .python-version 或项目设置。',
    '[边界] 固定后项目内解析优先使用该版本。',
    '[维护] 写入格式需与版本文件读取逻辑一致。',
  ]],
  [2121, 'Commands::Python(PythonNamespace { command: PythonCommand::Dir(args), }) => {', [
    '打印受管 Python 安装目录。',
    '[不变量] 不创建目录。',
    '[边界] 可只显示指定实现与版本的目录。',
    '[维护] 路径规则与 install、uninstall 一致。',
  ]],
  [2131, 'Commands::Python(PythonNamespace { command: PythonCommand::UpdateShell, }) => {', [
    '刷新 Python 可执行入口。',
    '[不变量] 只更新入口，不重新安装解释器。',
    '[边界] 用于修复被外部修改的入口。',
    '[维护] 与 tool update-shell 行为对称。',
  ]],
  [2137, 'Commands::Publish(args) => {', [
    '构建并上传分发包到索引。',
    '[不变量] 上传前先完成构建与校验。',
    '[边界] 支持指定索引、认证与跳过已有版本。',
    '[维护] 认证信息来自 auth 存储或环境变量。',
  ]],
  [2185, 'Commands::Workspace(WorkspaceNamespace { command }) => match command {', [
    '工作区命令总入口，按 WorkspaceCommand 二次分派。',
    '[不变量] 所有子命令共享同一份工作区元数据。',
    '[边界] 该分支只负责路由，不组装业务参数。',
    '[维护] 新增子命令需同步扩展此 match。',
  ]],
  [2186, 'WorkspaceCommand::Metadata(args) => {', [
    '输出工作区元数据。',
    '[不变量] 输出结构与项目模式保持一致。',
    '[边界] 只读，不触发安装或锁文件写入。',
    '[维护] 脚本模式会先过滤掉远程与标准输入来源。',
  ]],
  [2234, 'WorkspaceCommand::Dir(args) => {', [
    '打印工作区成员目录。',
    '[不变量] 只展示已发现成员。',
    '[边界] 可按包名过滤。',
    '[维护] 不触发依赖解析。',
  ]],
  [2245, 'WorkspaceCommand::List(args) => {', [
    '列出工作区成员。',
    '[不变量] 输出顺序稳定，便于 diff。',
    '[边界] 可只显示路径或脚本入口。',
    '[维护] 与 dir 共享工作区发现结果。',
  ]],
  [2259, 'Commands::BuildBackend { command } => spawn_blocking(move || match command {', [
    '构建后端入口，供 PEP 517 前端调用。',
    '[不变量] 整个后端运行在阻塞线程池，避免占用异步运行时。',
    '[边界] 该分支只处理构建后端协议，不涉及用户命令。',
    '[维护] 协议版本变化时需同步更新 uv-build-backend。',
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

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-uvr-d6a-2.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((a, b) => a + b.lines.length, 0));
