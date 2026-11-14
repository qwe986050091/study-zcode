// INV-01 插件覆盖键必须带 plugin 前缀：守住位置 parse 的过滤；改错故障 内置 subagent 被插件覆盖。
// INV-02 单条覆盖解析失败只丢该条：守住位置 safeParse 的 flatMap；改错故障 一条脏配置清空全部覆盖。
// INV-03 非对象与数组一律当空：守住位置 入口判断；改错故障 数组下标被当成 agent id。
// INV-04 插件 id 是 plugin 加 pluginId 加裸名小写：守住位置 createPluginAgentStateId；改错故障 插件升级后覆盖丢失。
// INV-05 pluginId 不含版本：守住位置 注释约定的入参；改错故障 同插件不同版本各存一份覆盖。
// INV-06 裸名先 trim 再小写：守住位置 拼接前处理；改错故障 大小写差异产生两个键。
// INV-07 三类 id 靠 source 前缀区分：守住位置 createAgentStateId；改错故障 agents-state.json 键冲突。
// INV-08 scope 与 source 取值集合固定：守住位置 两个联合类型；改错故障 新增取值后旧状态读不出来。
// INV-09 三个列表各自独立：守住位置 AgentsListResult；改错故障 UI 分不清 agent 来源。
// INV-10 不可用能力用 capability 表达：守住位置 userScopeReason；改错故障 前端靠空数组猜原因。
// INV-11 诊断必须带 code 与 path：守住位置 AgentDiagnostic；改错故障 问题无法定位到具体文件。
// INV-12 配置载荷与展示摘要分离：守住位置 SubAgentConfig 与 AgentSummary；改错故障 内部字段被 UI 回写。
//
// 模块职责：subagent 的标识、权限、模型覆盖与列表响应的共享类型契约。
// 阅读顺序：先看覆盖解析与 id 生成，再看列表与诊断形状。
import type { ZCodeProvider } from "./zcode-task-types-core.js";
import { modelSelectionSchema, type ModelSelection } from "./model-selection.js";

export type AgentScope = "built-in" | "workspace" | "user";

export type AgentSource = "built-in" | "user" | "plugin";

export type BuiltInSubagentName = "general-purpose" | "Explore";

export type BuiltInSubagentModelSelectionOverrides = Partial<
  Record<BuiltInSubagentName, ModelSelection>
>;

export type PluginSubagentModelSelectionOverrides = Readonly<Record<string, ModelSelection>>;

/** 正式 reader 只接受结构化覆盖，不在读取时解释旧双 map 或重新匹配 Provider。 */
// 只接受结构化覆盖，不在读取时解释旧的双 map。
// 返回值只保留能通过模型选择 schema 的条目。
// 重复 id 后写覆盖前写，与对象展开语义一致。
export function parsePluginSubagentModelSelectionOverrides(
  value: unknown,
): PluginSubagentModelSelectionOverrides {
  // 空值与数组都不是合法覆盖表，直接当空处理。
  // 这里不抛错：读取旧状态时脏数据不应该让列表失败。
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  // 逐条 safeParse，失败条目静默丢弃而不是整表失败。
  // 前缀过滤把非插件键挡在外面，避免越权覆盖。
  // 最终键集合即写入 agents-state.json 的键集合。
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, candidate]) => {
      const selection = modelSelectionSchema.safeParse(candidate);
      return id.startsWith("plugin:") && selection.success ? [[id, selection.data]] : [];
    }),
  );
}

export type AgentPermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "default"
  | "dontAsk"
  | "plan";

export type AgentColor =
  | "red"
  | "blue"
  | "green"
  | "yellow"
  | "purple"
  | "orange"
  | "pink"
  | "cyan";

export type SubagentsListMode = "allRuntimeScopes" | "settingsUserOnly";

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  defaultModelSelection?: ModelSelection;
  modelSelectionOverride?: ModelSelection;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
  path: string;
  scope: AgentScope;
  source: AgentSource;
  enabled: boolean;
  readOnly?: boolean;
  projectPath?: string;
  pluginId?: string;
  pluginName?: string;
  diagnostics?: AgentDiagnostic[];
}

export interface AgentDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface AgentsCapability {
  userScopeAvailable: boolean;
  userScopeReason?: "desktop_only";
}

// 全量、用户与插件三份列表并存，UI 据此分组展示。
// capability 表达平台能力，不用空列表暗示不可用。
// 诊断挂在结果上，单个 agent 的问题不阻断列表。
export interface AgentsListResult {
  agents: AgentSummary[];
  userAgents: AgentSummary[];
  pluginAgents: AgentSummary[];
  capability: AgentsCapability;
  diagnostics?: AgentDiagnostic[];
}

/** Agent 配置，用于创建/更新 agent */
export interface SubAgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
}

/** Agent 创建参数 */
export interface AgentCreateParams {
  config: SubAgentConfig;
  provider: ZCodeProvider;
  scope?: "user" | "workspace";
  workspacePath?: string;
  workspaceIdentity?: string;
}

/** Agent 更新参数 */
export interface AgentUpdateParams {
  agentId: string;
  config: SubAgentConfig;
  oldFilePath?: string;
  provider: ZCodeProvider;
  scope?: "user" | "workspace";
  workspacePath?: string;
  workspaceIdentity?: string;
}

/** Agent 删除参数 */
export interface AgentDeleteParams {
  agentId: string;
  filePath: string;
}

export interface BuiltInSubagentModelOverrideParams {
  agentName: BuiltInSubagentName;
  modelSelection?: ModelSelection;
}

export interface PluginSubagentModelOverrideParams {
  agentId: string;
  modelSelection?: ModelSelection;
}

/**
 * 插件 subagent 的稳定 id：`plugin:<pluginId>:<裸名小写>`。
 * pluginId 为 `<name>@<marketplace>`，不含版本，插件升级后 id 不变，覆盖随之保留。
 * services 与 CLI bootstrap 都用它做 agents-state.json 的键，必须共用一处实现。
 */
// pluginId 形如名字加市场，不含版本，升级后 id 不变。
// 裸名统一 trim 加小写，避免大小写差异产生两个键。
// services 与 CLI bootstrap 必须共用这一处实现。
export function createPluginAgentStateId(pluginId: string, agentName: string): string {
  return `plugin:${pluginId}:${agentName.trim().toLowerCase()}`;
}

// source 与 scope 都进键，内置与用户同名也不会撞。
// 名字同样 trim 加小写，保持与插件 id 一致的归一。
// 修改拼接格式等于迁移所有存量状态，需同步写迁移。
export function createAgentStateId(input: {
  name: string;
  scope: AgentScope;
  source: AgentSource;
}): string {
  return `${input.source}:${input.scope}:${input.name.trim().toLowerCase()}`;
}
