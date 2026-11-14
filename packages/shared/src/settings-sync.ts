// INV-01 代理名单是封闭联合：新增代理必须同时更新枚举与文档，守住位置 代理类型；改错故障：漏加会让界面筛选不到该代理，配置无法同步。
// INV-02 分类集合固定为五类：守住位置 分类类型；改错故障：临时新增分类会让列表与导入器两处不同步。
// INV-03 作用域只有全局与项目两级：守住位置 作用域类型；改错故障：增开第三级会让所有按作用域分支的消费方漏处理。
// INV-04 导入模式只有复制与软链：守住位置 导入模式类型；改错故障：软链在部分平台不可用时没有回退说明，导入失败。
// INV-05 每个摘要都带可导入标记与跳过原因：守住位置 各摘要接口；改错故障：只给计数不给原因，用户无法知道为何跳过。
// INV-06 跳过原因是封闭集合：目标已存在与同名已存在，守住位置 各跳过类型；改错故障：自由文本原因会让前端无法分类展示。
// INV-07 发现结果层级为代理、分类、来源根：守住位置 三层结构；改错故障：压平会让同一分类跨作用域的根合并，丢失来源区分。
// INV-08 计数在每一层都存在且语义一致：发现数、可导入数、跳过数，守住位置 各计数字段；改错故障：某层缺跳过数会让汇总出现负数。
// INV-09 默认选中只由分类声明：守住位置 分类摘要字段；改错故障：界面自行推断默认值会让两侧勾选状态不一致。
// INV-10 导入结果按代理与分类分组：守住位置 任务结果接口；改错故障：只给全局计数会让失败的代理无法定位。
// INV-11 三类状态固定为已导入、已跳过、失败：守住位置 状态类型；改错故障：新增状态会让汇总分支漏算。
// INV-12 任务结果与分类细节同层携带：守住位置 任务结果的可选数组；改错故障：只留计数会丢失单个条目的失败原因。
// INV-13 进度事件同时给出总数与完成数：守住位置 进度接口；改错故障：只给完成数无法画出总进度。
// INV-14 进度中的成功、跳过与失败三者之和不超过完成数：守住位置 三个计数字段；改错故障：口径不一致会让进度超过百分之百。
// INV-15 选择对象按分类携带路径列表：守住位置 选择接口；改错故障：四类共用一条路径数组会让导入器无法分类。
// INV-16 选择的作用域可分别指定来源与目标：守住位置 两个作用域字段；改错故障：共用一个字段会让跨作用域迁移无法表达。
// INV-17 首次引导状态只记录是否处理过：守住位置 引导状态接口；改错故障：附带时间戳等细节会让状态比较不稳定。
// INV-18 本文件只声明类型：不含运行期值，守住位置 全部导出；改错故障：混入常量会让类型包被运行期代码拖入打包结果。
//
// 模块职责：声明设置同步的代理、分类、作用域、发现摘要、选择、任务结果与进度事件类型。
// 状态所有权：无状态；本文件不产生运行期值，全部内容在编译期擦除。
// 阅读顺序：先看代理与分类枚举，再看发现摘要，最后看选择、结果与进度结构。
export type SettingsSyncAgent =
  | "zcode"
  | "claudeCode"
  | "codexCli"
  | "openCode"
  | "openClaw"
  | "augment"
  | "continue"
  | "goose"
  | "qwenCode"
  | "qode"
  | "qodeCn"
  | "windsurf"
  | "trae"
  | "traeCn"
  | "kiroCli"
  | "roo"
  | "codeBuddy"
  | "agents";

// SettingsSyncCategory 固定为 "providers" | "skills" | "commands" | "plugins" | "mcpServers" 五类，列表与导入器共用：临时新增分类会让两处消费方不同步、界面出现空分类；分类名用于持久化选择，改名等于数据迁移；类型不携带展示文案，文案由界面层负责。
export type SettingsSyncCategory = "providers" | "skills" | "commands" | "plugins" | "mcpServers";

export type SettingsSyncSourceScope = "global" | "project";

export type SettingsSyncImportMode = "copy" | "symlink";

// SettingsSyncClaudeAgentsFileMigrationStatus 描述一次 sourcePath → targetPath 的预检：sourceExists/targetExists 必须与 supported 分开，否则界面分不清源缺失与目标已存在；unavailableReason 目前只有 "missingSource"；结构只读，不含任何执行结果。
export interface SettingsSyncClaudeAgentsFileMigrationStatus {
  sourcePath: string;
  targetPath: string;
  sourceExists: boolean;
  targetExists: boolean;
  supported: boolean;
  unavailableReason?: "missingSource";
}

export interface SettingsSyncClaudeAgentsFileCopyResult {
  sourcePath: string;
  targetPath: string;
  status: "copied" | "skipped";
  overwritten: boolean;
  skippedReason?: "missingSource" | "targetExists";
}

// SettingsSyncSkillSkipReason 只有 "targetExists" 与 "sameNameExists"：自由文本原因会让前端无法分类展示；targetExists 只在本作用域内判，sameNameExists 跨来源根判；被发现摘要与导入结果复用，新增原因必须同步界面文案，否则显示为未知。
export type SettingsSyncSkillSkipReason = "targetExists" | "sameNameExists";

export interface SettingsSyncSourceSkillSummary {
  name: string;
  path: string;
  importable: boolean;
  skipReason?: SettingsSyncSkillSkipReason;
  version?: string;
}

export type SettingsSyncCommandSkipReason = "targetExists" | "sameNameExists";

export interface SettingsSyncSourceCommandSummary {
  name: string;
  path: string;
  importable: boolean;
  skipReason?: SettingsSyncCommandSkipReason;
  description?: string;
  argumentHint?: string;
}

export type SettingsSyncPluginSkipReason = "targetExists" | "sameNameExists";

export interface SettingsSyncSourcePluginSummary {
  name: string;
  path: string;
  importable: boolean;
  skipReason?: SettingsSyncPluginSkipReason;
  version?: string;
}

export type SettingsSyncMcpServerSkipReason = "sameNameExists";

export interface SettingsSyncSourceMcpServerSummary {
  name: string;
  path: string;
  importable: boolean;
  skipReason?: SettingsSyncMcpServerSkipReason;
}

// SettingsSyncSourceRootSummary 按 scope + path 聚合同一来源根：discoveredCount - importableCount 必须等于 skippedCount，缺这个字段会让上层汇总出现负数；skills/commands/plugins/mcpServers 用可选数组携带，未发现则键不出现，path 为该根绝对路径用于展示与去重。
export interface SettingsSyncSourceRootSummary {
  scope: SettingsSyncSourceScope;
  path: string;
  discoveredCount: number;
  importableCount: number;
  skippedCount?: number;
  skills?: SettingsSyncSourceSkillSummary[];
  commands?: SettingsSyncSourceCommandSummary[];
  plugins?: SettingsSyncSourcePluginSummary[];
  mcpServers?: SettingsSyncSourceMcpServerSummary[];
}

export interface SettingsSyncCategorySummary {
  category: SettingsSyncCategory;
  discoveredCount: number;
  importableCount: number;
  skippedCount?: number;
  sourcePaths?: string[];
  sourceRoots?: SettingsSyncSourceRootSummary[];
  selectedByDefault: boolean;
}

export type SettingsSyncSkillImportStatus = "imported" | "skipped" | "failed";

export interface SettingsSyncSkillImportResult {
  name: string;
  path: string;
  sourceScope: SettingsSyncSourceScope;
  status: SettingsSyncSkillImportStatus;
  skipReason?: SettingsSyncSkillSkipReason;
  version?: string;
}

export type SettingsSyncCommandImportStatus = "imported" | "skipped" | "failed";

export interface SettingsSyncCommandImportResult {
  name: string;
  path: string;
  sourceScope: SettingsSyncSourceScope;
  status: SettingsSyncCommandImportStatus;
  skipReason?: SettingsSyncCommandSkipReason;
}

export type SettingsSyncPluginImportStatus = "imported" | "skipped" | "failed";

export interface SettingsSyncPluginImportResult {
  name: string;
  path: string;
  sourceScope: SettingsSyncSourceScope;
  status: SettingsSyncPluginImportStatus;
  skipReason?: SettingsSyncPluginSkipReason;
  version?: string;
}

export type SettingsSyncMcpServerImportStatus = "imported" | "skipped" | "failed";

export interface SettingsSyncMcpServerImportResult {
  name: string;
  path: string;
  sourceScope: SettingsSyncSourceScope;
  status: SettingsSyncMcpServerImportStatus;
  skipReason?: SettingsSyncMcpServerSkipReason;
}

export interface SettingsSyncAgentSummary {
  agent: SettingsSyncAgent;
  discovered: boolean;
  categories: SettingsSyncCategorySummary[];
}

export interface SettingsSyncDiscoveryResult {
  agents: SettingsSyncAgentSummary[];
}

// SettingsSyncSelection 以 agent + category 为最小单元，skillPaths/commandPaths/pluginPaths/mcpServerPaths 四类必须各自携带，共用一条数组会让导入器无法判断归属；sourceScope 与 targetScope 分开表达以支持跨作用域迁移；路径列表为空表示按分类全选，选择在界面层构造，本文件只约束形状。
export interface SettingsSyncSelection {
  agent: SettingsSyncAgent;
  category: SettingsSyncCategory;
  sourceScope?: SettingsSyncSourceScope;
  targetScope?: SettingsSyncSourceScope;
  importMode?: SettingsSyncImportMode;
  skillPaths?: string[];
  commandPaths?: string[];
  pluginPaths?: string[];
  mcpServerPaths?: string[];
}

// SettingsSyncProgressEvent 同时给 total 与 completed：successCount + skippedCount + failedCount 必须等于 completed 且三者互斥，否则进度会越界到 100% 以上；currentAgent/currentCategory 只在处理中提供用于文案；事件只读，由执行方按完成条目逐步发送，分类口径与 SettingsSyncTaskImportResult 一致。
export interface SettingsSyncProgressEvent {
  total: number;
  completed: number;
  currentAgent?: SettingsSyncAgent;
  currentCategory?: SettingsSyncCategory;
  successCount: number;
  skippedCount: number;
  failedCount: number;
}

export interface SettingsSyncTaskImportResult {
  agent: SettingsSyncAgent;
  category: SettingsSyncCategory;
  status: "success" | "skipped" | "failed";
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  skillResults?: SettingsSyncSkillImportResult[];
  commandResults?: SettingsSyncCommandImportResult[];
  pluginResults?: SettingsSyncPluginImportResult[];
  mcpServerResults?: SettingsSyncMcpServerImportResult[];
}

export interface SettingsSyncImportResult {
  successCount: number;
  skippedCount: number;
  failedCount: number;
  taskResults: SettingsSyncTaskImportResult[];
}

export interface SettingsSyncFirstRunPromptState {
  handled: boolean;
}
