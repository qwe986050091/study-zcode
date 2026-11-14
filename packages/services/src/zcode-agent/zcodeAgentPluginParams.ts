import type {
  ModelSelection,
  ZCodeAgentMcpServer,
  ZCodeAutomationScheduleRule,
  ZCodeMcpListMode,
} from "@zcode/shared";
import type { McpAppsAppToolCallResult, McpAppsAppToolDescriptor } from "@zcode/shared/mcp-apps";

// workspaceIdentity 与 remoteSessionId 都只用于隔离与路由，
// 任何实现都不能用它们替代 workspacePath 去读写文件或启动进程。
// 三者必须一起透传，缺一个就可能把远端 workspace 的请求落到本地同名目录。
export interface ZCodeAgentWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 远程 workspace 的运行时会话身份；只用于隔离/路由，不能替代 workspacePath。 */
  remoteSessionId?: string;
}

// 所有插件写操作共享此目标：telemetry 只用于 Host 侧埋点，不会下发 CLI。
// operationId 是幂等键，重试必须复用同一个值，否则会重复执行安装/卸载。
// trigger 区分用户主动与依赖/同步引起的变更，便于归因。
export interface ZCodeAgentPluginMutationTarget extends ZCodeAgentWorkspaceTarget {
  /** 仅 Host 观测使用；不会传给 CLI。 */
  telemetry?: {
    entry?:
      | "store_list"
      | "store_detail"
      | "side_pane_market"
      | "recommended_prompt"
      | "recommended_ui"
      | "component_settings";
    client_kind?: "desktop" | "mobile";
    trigger?: "user" | "automatic" | "dependency" | "restore" | "sync";
  };
}

// configScope 决定读 user 还是 workspace 级配置；缺省由 CLI 侧规则决定。
export interface ZCodeAgentPluginViewParams extends ZCodeAgentWorkspaceTarget {
  configScope?: "user" | "workspace";
}

// mcpServers 允许调用方覆盖待查询清单（例如设置页里的未保存草稿），
// 缺省则由 CLI 读取磁盘配置；mode 控制只读缓存还是强制探测。
export interface ZCodeAgentListMcpServerStatusesParams extends ZCodeAgentWorkspaceTarget {
  mcpServers?: ZCodeAgentMcpServer[];
  mode?: ZCodeMcpListMode;
}

// dryRun 必须只做校验不落盘：市场地址可能来自用户输入，需要先预览解析结果。
export interface ZCodeAgentAddPluginMarketplaceParams extends ZCodeAgentPluginMutationTarget {
  dryRun?: boolean;
  operationId?: string;
  source: string;
}

// 移除市场只删除该市场的索引与来源，不卸载已安装插件；
// [契约] removePluginMarketplace 只删索引与来源：已安装记录可能指向悬空市场，读取侧必须容忍。
export interface ZCodeAgentRemovePluginMarketplaceParams extends ZCodeAgentPluginMutationTarget {
  marketplace: string;
}

export interface ZCodeAgentUpdatePluginMarketplaceParams extends ZCodeAgentPluginMutationTarget {
  marketplace?: string;
  operationId?: string;
}

export interface ZCodeAgentInstallPluginParams extends ZCodeAgentPluginMutationTarget {
  dryRun?: boolean;
  marketplace: string;
  operationId?: string;
  pluginName: string;
  scope?: "user" | "workspace";
}

// 取消不需要 workspace：operationId 全局唯一，取消的是进行中的操作本身，
// 而不是某个 workspace 的状态。
export interface ZCodeAgentCancelPluginOperationParams {
  operationId: string;
}

// 三个定位字段至少提供一个：marketplace 用于市场内插件，
// pluginId 用于已安装记录，pluginName 用于用户手输名称的兜底。
// removeCache 影响共享缓存目录，跨 workspace 生效，默认不删。
export interface ZCodeAgentUninstallPluginParams extends ZCodeAgentPluginMutationTarget {
  marketplace?: string;
  pluginId?: string;
  pluginName?: string;
  removeCache?: boolean;
}

export interface ZCodeAgentUpdatePluginParams extends ZCodeAgentPluginMutationTarget {
  pluginId?: string;
  marketplace?: string;
}

// 恢复内置插件按 pluginId 精确匹配：内置插件不可卸载，只能被覆盖后恢复。
// 该操作会重新写入用户目录，必须走幂等 operationId。
export interface ZCodeAgentRestoreBuiltinPluginParams extends ZCodeAgentPluginMutationTarget {
  pluginId: string;
}

// options 是完整配置而不是增量补丁：调用方必须先读再合并，
// 否则未出现的键会被清空。clearOptionKeys 用于显式删除敏感项。
export interface ZCodeAgentConfigurePluginParams extends ZCodeAgentPluginMutationTarget {
  clearOptionKeys?: string[];
  dryRun?: boolean;
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ZCodeAgentResetPluginConfigParams extends ZCodeAgentPluginMutationTarget {
  pluginId: string;
  scope?: "user" | "workspace";
}

// 校验既支持市场内插件，也支持本地路径来源；两者至少给一个。
// 这是只读操作，因此不继承遥测目标。
export interface ZCodeAgentValidatePluginParams extends ZCodeAgentWorkspaceTarget {
  marketplace?: string;
  pluginName?: string;
  source?: string;
}

export interface ZCodeAgentDescribePluginParams extends ZCodeAgentWorkspaceTarget {
  marketplace: string;
  pluginName: string;
}

export interface ZCodeAgentSetPluginEnabledParams extends ZCodeAgentPluginMutationTarget {
  enabled: boolean;
  operationId?: string;
  pluginId: string;
  scope?: "user" | "workspace";
}

// Plugin 对话引用 catalog：
// 带 sessionId → session-owned 冻结 catalog（必须路由到持有该 session 的 workspace client）；
// 不带 → workspace 当前 catalog（新建草稿 Picker）。
// [并发] 带 sessionId 时必须路由到持有该 session 的 client：
// catalog 是会话级冻结快照，从别的 workspace 读取会拿到不一致的引用集合。
export interface ZCodeAgentPluginReferenceCatalogParams extends ZCodeAgentWorkspaceTarget {
  sessionId?: string;
}

// Composer Skill catalog：与 Plugin 引用相同，以 sessionId 区分 workspace 当前目录和
// resident Session runtime 快照；不参与 Settings 管理目录。
// 与插件引用同构，但只覆盖 Composer 的 Skill 目录，不参与设置页管理。
export interface ZCodeAgentSkillReferenceCatalogParams extends ZCodeAgentWorkspaceTarget {
  sessionId?: string;
}

/** 插件 UI：UI 发起的 `ui://` 资源读取。 */
// [失败路径] uri 来自插件页面，属于不可信输入：
// 实现必须按实例归属校验，不能只按 serverName 直接转发 resources/read。
export interface ZCodeAgentReadMcpResourceParams extends ZCodeAgentWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  uri: string;
}

/** 插件 UI 页面发起的 `resources/read`；参数与 readMcpResource 同形，结果受 8 MiB 与 mimeType 白名单约束。 */
export type ZCodeAgentReadMcpResourceForUiParams = ZCodeAgentReadMcpResourceParams;

/** 插件 UI：UI 回调本插件工具；不进审批流，归属由 agent 侧 catalog fail closed。 */
// [事务] 插件 UI 的工具调用不进模型审批流：
// 归属由 Agent 侧 catalog 做 fail closed 校验，未注册的工具一律拒绝。
// callId 由宿主生成并配合取消接口，调用方不能自造。
export interface ZCodeAgentCallMcpToolForUiParams extends ZCodeAgentWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  /** 宿主生成的调用 id，配合 cancelMcpToolCallForUi。 */
  callId: string;
}
/** 插件 UI 页面发起的 resources/list、resources/templates/list、subscribe、unsubscribe。 */
// 四种列举/订阅操作共用一个参数体，行为由调用的方法名决定；
// cursor 只对分页列举有意义，订阅类调用会忽略它。
export interface ZCodeAgentListMcpResourcesForUiParams extends ZCodeAgentWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  cursor?: string;
}
/** App-Provided Tools：实例身份 = 会话 + 沙箱作用域 + 代际。 */
// [事务] App 工具实例身份是三元组：sessionId + scopeId + generation。
// generation 单调递增，旧代际的调用必须被拒绝而不是落到新实例上，
// 否则页面重建后的一次迟到回调会作用到错误的沙箱。
export interface ZCodeAgentAppToolInstanceForUiParams extends ZCodeAgentWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  scopeId: string;
  generation: number;
}
export interface ZCodeAgentRegisterAppToolsForUiParams extends ZCodeAgentAppToolInstanceForUiParams {
  tools: McpAppsAppToolDescriptor[];
}
export interface ZCodeAgentAppToolCallForUiParams extends ZCodeAgentAppToolInstanceForUiParams {
  callId: string;
}
export interface ZCodeAgentResolveAppToolCallForUiParams extends ZCodeAgentAppToolCallForUiParams {
  result?: McpAppsAppToolCallResult;
  error?: { message: string };
}
// 资源订阅同样绑定代际：订阅生命周期不得超过实例生命周期，
// 实例销毁时必须由宿主统一 unsubscribe，不能只依赖页面主动取消。
export interface ZCodeAgentMcpResourceSubscriptionForUiParams extends ZCodeAgentWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  scopeId: string;
  generation: number;
  uri: string;
}
export interface ZCodeAgentCancelMcpToolCallForUiParams extends ZCodeAgentWorkspaceTarget {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  sessionId: string;
  pluginId: string;
  serverName: string;
  callId: string;
}
// [权衡] 同时接受 clientMode 与 deliveryKind 是历史遗留：
// 新调用方应只传 deliveryKind，clientMode 只为兼容旧客户端保留。
// stableId + operationId 共同保证同一条推荐引用只解析一次。
export interface ZCodeAgentResolveSuggestedPluginReferenceParams extends ZCodeAgentWorkspaceTarget {
  stableId: string;
  operationId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryKind: "desktop-continuous" | "web-remote-replayable";
}

// ---- 定时任务(automation)管理参数 ----

// [事务] 调度参数有两条互斥路径：cronExpr 与 relativeDelayMinutes。
// projectId 显式 null 表示全局任务，undefined 表示沿用当前 workspace 默认项目；
// scheduleRule 是结构化调度的新形态，优先级高于裸 cronExpr。
export interface ZCodeAgentCreateAutomationParams extends ZCodeAgentWorkspaceTarget {
  projectId?: string | null;
  title: string;
  cronExpr: string;
  relativeDelayMinutes?: number;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: string;
  recurring?: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: ZCodeAutomationScheduleRule;
}

// 更新是可选字段补丁，但 null 有语义：清空 modelSelection/mode/maxRuns/endAt/scheduleRule。
// scheduleEditedByUser 用于区分系统迁移改写与用户手动改期。
export interface ZCodeAgentUpdateAutomationParams extends ZCodeAgentWorkspaceTarget {
  automationId: string;
  title?: string;
  cronExpr?: string;
  prompt?: string;
  modelSelection?: ModelSelection | null;
  mode?: string | null;
  recurring?: boolean;
  maxRuns?: number | null;
  endAt?: number | null;
  scheduleRule?: ZCodeAutomationScheduleRule | null;
  scheduleEditedByUser?: boolean;
}

export interface ZCodeAgentAutomationIdParams extends ZCodeAgentWorkspaceTarget {
  automationId: string;
}

export interface ZCodeAgentSetAutomationEnabledParams extends ZCodeAgentWorkspaceTarget {
  automationId: string;
  enabled: boolean;
}

// 删除的是运行记录而不是调度定义：runId 与 automationId 属于不同实体。
export interface ZCodeAgentDeleteAutomationRunParams extends ZCodeAgentWorkspaceTarget {
  runId: string;
}
