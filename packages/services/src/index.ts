// 包根入口（package.json exports["."]）：浏览器与 Node 共用的公共面。
// Renderer 会以 value import 拉入本文件，因此这里只允许纯类型、descriptor、
// 纯函数与浏览器安全工厂；任何 node:* 依赖都必须留在 "@zcode/services/node"。
// INV-01：根入口的 value 导出不得把 node:* 带进依赖图（守住位置：本文件全部
//   from 目标；破坏：renderer 打包/加载失败，整个应用黑屏）。
// INV-02：导出名与导出种类（type / value）是跨包契约，改名或把 descriptor 降级成
//   export type 会让消费方拿到 undefined 且编译期不报错（守住位置：每条 export）。
// INV-03：Node 实现只能经 "./node" 子路径取（守住位置：node.ts 与 exports 映射）。
// INV-04：同一实现的接口与 descriptor 必须成组导出，只导出其一会迫使消费方
//   在 DI 与类型标注间二选一（守住位置：IFileService、ICredentialService 等）。
// INV-05：导出顺序不参与运行时语义，但重排会把改名/删除伪装成移动，
//   使 review 与 dep:refs 对比失效（守住位置：本文件整体顺序）。
// Descriptors & collection (browser-safe)
// descriptor 把频道（ServiceChannels）与接口类型合成同一个符号：消费方 import 的是
// 通道而不是字符串常量，新增服务必须沿用此形式，否则 RPC 查表会落空。
export { type ServiceDescriptor, createServiceDescriptor } from "./descriptors.js";
// 曝露策略是跨进程权限声明；内部服务不得为了方便加进 browser 可见集合。
export { ServiceCollection, type ServiceExposurePolicy } from "./collection.js";
export {
  IModelSelectionService,
  IProviderSettingsService,
  type ModelSelectionView,
  type ModelSelectionViewInput,
  type ProviderSettingsProviderView,
  type ProviderSettingsView,
} from "./model-provider/providerFacadeServices.js";
export {
  createAccountRequestAuthService,
  type IAccountRequestAuthService,
  type AccountRequestAuthInput,
  type AccountRequestAuthMaterial,
  type AccountRequestAuthResolver,
} from "./model-provider/accountRequestAuthService.js";
export { IProviderProvisioningTargetService } from "./model-provider/providerProvisioning.js";
export {
  collectServiceMemoryDiagnostics,
  memoryDiagnosticsRegistry,
  registerMemoryDiagnosticsProvider,
} from "./memoryDiagnostics.js";

// Accessor 是各进程统一的解析入口，只按 descriptor 查找；
// 不暴露 ServiceCollection 本身，避免消费方绕过曝露策略拿到未授权服务。
// Accessor
export type { IServiceAccessor } from "./accessor.js";
export {
  ConversationShareServiceError,
  createUnsupportedConversationShareService,
  IConversationShareService,
} from "./conversation-share/conversationShare.js";
export type {
  ConversationShareSelection,
  ConversationSharePublishProgress,
  ConversationShareImportProgress,
  ImportConversationShareInput,
  ImportConversationShareResult,
  ImportedConversationShare,
  ConversationShareServiceErrorKind,
  ConversationShareFailureIssue,
  ConversationShareFailureIssueCode,
  ConversationSharePreflightInput,
  ConversationSharePreflightResult,
  ConversationShareAllowedArtifact,
  ConversationShareTurnPreflightResult,
  PublishTextConversationInput,
} from "./conversation-share/conversationShare.js";
// 分享链路有两套出口：契约（本文件，browser-safe）与依赖 fs/zip 的实现（./node）；
// 二者混用会让 renderer 直接解析 node 模块。
// Conversation share 的具体实现依赖 Node 文件系统，只能从 @zcode/services/node 引入；
// 根入口必须保持 browser-safe，避免 renderer 解析到 node:* 模块。
export {
  createConversationTelemetryService,
  type ConversationTelemetryWorkspaceTarget,
  type IConversationTelemetryService,
} from "./conversation-telemetry/conversationTelemetry.js";

// 一组「接口 + descriptor」同名导出的端能力：同名让 DI 查找与类型标注共用符号，
// 不需要额外的 token 表，也就没有两处命名漂移的机会。
// File service — IFileService is both a type (interface) and value (descriptor)
export { IFileService } from "./file/file.js";
export { IMediaPreviewService } from "./media-preview/mediaPreview.js";
export { ICloudContentService } from "#src/cloud-content/cloudContent.js";
export { IMarketingTouchService } from "#src/marketing-touch/marketingTouch.js";
export type { MediaPreviewPreparation } from "./media-preview/mediaPreview.js";

// Checkpoint 依赖 git 但生命周期更短；拆成两个 descriptor，避免只做检查点的端拖入完整 git 服务。
// Git service — IGitService is both a type (interface) and value (descriptor)
export { IGitService } from "./git/git.js";
export { IGitCheckpointService } from "./git/gitCheckpoint.js";

// 宿主能力（平台、版本、路径）在本地与远端 Host 上契约一致，实现按进程类型注册。
// System service — ISystemService is both a type (interface) and value (descriptor)
export { ISystemService } from "./system/system.js";

// 终端是稀缺资源；接口把创建/复用/释放约定固定下来，两端才能共享同一套配额。
// Terminal service — ITerminalService is both a type (interface) and value (descriptor)
export { ITerminalService } from "./terminal/terminal.js";

// 读写实现走 node 侧；根入口只留 descriptor，防止 renderer 直接触碰磁盘。
// Setting service — ISettingService is both a type (interface) and value (descriptor)
export { ISettingService } from "./setting/setting.js";

// 凭据属于权限边界：这里只给句柄形状，任何取明文的方法都留在 node 实现。
// Credential service — ICredentialService is both a type (interface) and value (descriptor)
export { ICredentialService } from "./credential/credential.js";
export { ISourceServerWorkspaceService } from "./source-server-workspace/sourceServerWorkspace.js";
export {
  ISourceServerManagementService,
  type UpdateConnectionProfileInput,
} from "./source-server-management/sourceServerManagement.js";

// Broadcast 频道是跨窗口同步的唯一事实源；消息类型随 descriptor 一起导出，
// 订阅方才能在编译期对齐 payload，而不是靠频道名字符串猜结构。
// Broadcast service — IBroadcastService is both a type (interface) and value (descriptor)
export { IBroadcastService } from "./broadcast/broadcast.js";

// 完成记录目前只落本地；接口在此供 UI 读状态，原子写实现由 node 侧注入。
// Onboarding 完成记录服务（本地持久化，后续上传服务器）
export { IOnboardingRecordService } from "./onboarding/onboardingRecord.js";
export type {
  CreateOnboardingRecordServiceOptions,
  OnboardingRecordServiceFactory,
} from "./onboarding/onboardingRecord.js";
// 这里是曾经踩过的真实故障点：新增工厂导出前先确认依赖链不含 node:* 与
// @zcode/shared/node，否则会把整条 Node 链拖进 renderer（下方原有注释记录了根因）。
// 这里只能导出 descriptor 和类型。根 index 会被 renderer 经 value import 拉进浏览器包，
// 若 value 导出 createOnboardingRecordService，会连带 fs/atomicFileUtils → @zcode/shared/node →
// node:timers/promises 整条 Node 链进浏览器，模块加载直接抛错导致整个应用黑屏。
// 工厂函数由 host 侧（node.ts）与测试从实现文件路径直接导入，与 createSettingService 同惯例。
export type {
  BroadcastClaimAcquireResult,
  BroadcastClaimLease,
  BroadcastMessage,
} from "./broadcast/broadcast.js";

// task 包装服务是 app 侧视图状态的唯一入口：列表排序、分页与归档口径归它所有，
// UI 不得按数组下标自行推断顺序或状态。
// ZCode task wrapper service — task 列表/置顶/归档等 app 侧包装状态入口。
export { IZCodeTaskService } from "./session/zcodeTaskService.js";
export type {
  ZCodeArchivedTaskDeletionResult,
  ZCodeModelTrajectory,
  ZCodeModelTrajectoryCallSource,
  ZCodeModelTrajectoryCallSourceKind,
  ZCodeModelTrajectoryContentPart,
  ZCodeModelTrajectoryMessage,
  ZCodeModelTrajectoryRecord,
  ZCodeModelTrajectoryUsage,
  ZCodeTaskListKind,
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeTaskListSortBy,
  ZCodeTaskListWorkspaceScope,
  ZCodeTaskReadyOutcome,
} from "./session/zcodeTaskService.js";
export type { ZCodeTaskListItem } from "./session/zcodeTaskListTypes.js";

export { IWindowControllerService } from "./window-controller/windowController.js";
export {
  IWindowProjectService,
  IWindowRemoteProjectService,
  IWindowProjectChangesService,
  type WindowProjectDirectoryServices,
} from "#src/window-project-directory/contract.js";
export { createWindowProjectChangesService } from "#src/window-project-directory/index.js";
export type {
  WindowHostControllerFrame,
  WindowHostControllerMutation,
  WindowHostControllerTaskListItem,
  WindowHostControllerTaskListResult,
  WindowHostTaskUnreadSignal,
} from "./window-controller/windowController.js";

// Agent 域契约最多，按「主服务 / 错误 / 连接作用域 / 参数类型」四组导出；
// 分组与实现文件一一对应，新增类型放进对应组，不要塞进主服务条目。
// ZCode agent service — IZCodeAgentService is both a type (interface) and value (descriptor)
export {
  IZCodeAgentService,
  type ZCodeAgentLocalRuntimeChildProcesses,
  ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE,
} from "./zcode-agent/zcodeAgent.js";
export {
  isZCodeAgentMcpStatusModeUnsupportedError,
  ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE,
  ZCodeAgentMcpStatusModeUnsupportedError,
} from "./zcode-agent/zcodeAgentErrors.js";
export {
  createZCodeAgentConnectionScope,
  readTrustedZCodeAgentV4Connection,
} from "./zcode-agent/zcodeAgentConnectionScope.js";
export type {
  ZCodeAgentConnectionScope,
  ZCodeAgentV4ClientMode,
  ZCodeAgentV4ConnectionContext,
} from "./zcode-agent/zcodeAgentConnectionScope.js";
export type {
  ZCodeAgentAttachmentBeginParams,
  ZCodeAgentAttachmentChunkParams,
  ZCodeAgentAttachmentTerminalParams,
  ZCodeAgentCreateSessionParams,
  ZCodeAgentCuaPermissionObservation,
  ZCodeAgentInitializeResult,
  ZCodeAgentStorageStartupSnapshot,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentRuntimePolicy,
  ZCodeAgentReadSessionParams,
  ZCodeAgentRespondProviderRuntimeHeadersParams,
  ZCodeAgentResumeSessionParams,
  ZCodeAgentRunAutomationNowResult,
  ZCodeAgentSavedWorkflowTarget,
  ZCodeAgentSendPromptParams,
  ZCodeAgentServiceEvent,
  ZCodeAgentSessionSubscribeParams,
  ZCodeAgentSessionTarget,
  ZCodeAgentSetModeParams,
  ZCodeAgentSetModelParams,
  ZCodeAgentSetThoughtLevelParams,
  ZCodeAgentWorkspaceTarget,
} from "./zcode-agent/zcodeAgent.js";

// Session 是面向 app 的稳定命名层，刻意不含 agent 字样：
// 它把 runtime 的会话语义收敛成 UI 可直接消费的事件与参数类型。
// ZCode session service — app-facing session facade without ZCode Agent naming.
export { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
export type {
  ZCodeSessionCreateParams,
  ZCodeSessionEventsParams,
  ZCodeSessionInitializeResult,
  ZCodeSessionListParams,
  ZCodeSessionMessagesParams,
  ZCodeSessionReadParams,
  ZCodeSessionResumeParams,
  ZCodeSessionServiceEvent,
  ZCodeSessionSetModeParams,
  ZCodeSessionSetModelParams,
  ZCodeSessionSetThoughtLevelParams,
  ZCodeSessionSubscribeParams,
  ZCodeTaskTarget,
  ZCodeSessionWorkspaceTarget,
} from "./zcode-session/zcodeSession.js";

// 远端 workspace 解析结果是缓存事实而非 UI 本地状态，resolver 与结果类型一并导出。
// Bots service — IBotsService is both a type (interface) and value (descriptor).
export { IBotsService } from "./bots/bots.js";
export type {
  BotRemoteWorkspaceResolver,
  BotRemoteWorkspaceResolution,
  BotBindCodeResult,
  BotCreateBindCodeParams,
  BotListWorkspaceRefsParams,
  BotSaveBotParams,
  BotTestResult,
} from "./bots/bots.js";

// 只导出 descriptor：hook 的发现顺序、信任判定与落盘都在 node 侧 hooksService，
// UI 拿到的 Hook[] 已经是权威结果，不得再本地排序或过滤。
// Hooks service — IHooksService is both a type (interface) and value (descriptor).
export { IHooksService } from "./hooks/hooks.js";

// 两个错误码是跨层契约：UI 靠它们区分「文件被外部改动」与「预览超限」，
// 必须与 descriptor 同时可达，否则消费方只能匹配错误文案。
// Memory service — IMemoryService is both a type (interface) and value (descriptor).
export {
  IMemoryService,
  PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE,
} from "./memory/memory.js";
export type { ProjectMemoryFileSummary, ProjectMemoryWorkspaceSummary } from "./memory/memory.js";

// 输出风格与 session 实时端口互相独立：后者是推送通道，不承载风格配置。
// OutputStyle service — IOutputStyleService is both a type (interface) and value (descriptor).
export { IOutputStyleService } from "./output-style/outputStyle.js";
export type { SessionRealtimePort } from "./session/sessionRealtimePort.js";

// FileWatcher / OAuth / UsageStats 都是「一个 descriptor + 薄类型」的端能力，
// 保持一行一项，便于按需 tree-shake 且避免形成隐式聚合服务。
// FileWatcher service — IFileWatcherService is both a type (interface) and value (descriptor)
export { IFileWatcherService } from "./fileWatcher/fileWatcher.js";

// 令牌交换在 node 侧完成；根入口只暴露句柄与状态查询约定。
// OAuth service — IOAuthService is both a type (interface) and value (descriptor)
export { IOAuthService } from "./oauth/oauth.js";

// [契约] IUsageStatsService 的聚合口径由服务端定义：桌面端与 Web 端只消费同一份统计结果，不在本地重算。
// UsageStats service — IUsageStatsService is both a type (interface) and value (descriptor)
export { IUsageStatsService } from "./usage-stats/usageStats.js";

// 卷分组的纯函数可安全进入 renderer；磁盘枚举实现不在此处。
// Storage（资源管理器「存储」tab）：数据类型在 @zcode/shared；这里只导出服务接口与卷分组纯函数
// StorageRootSpec 随契约再导出：desktop 的 Worker 协议按 contract.ts 的口径只从 services 入口取类型。
export type { IStorageService, StorageRootSpec } from "./storage/contract.js";

// 套餐配置与客户端场景都由服务端下发：类型与 descriptor 同处导出，
// 保证 UI 渲染的是协议字段而不是本地猜测的结构。
// CodingPlanSubscription service — ICodingPlanSubscriptionService is both a type (interface) and value (descriptor)
export {
  ICodingPlanSubscriptionService,
  type OffPeakClientConfig,
} from "./coding-plan-subscription/codingPlanSubscription.js";
export {
  IClientScenesService,
  type ClientSceneConfig,
  type ClientSceneItem,
  type ClientSceneOption,
  type ClientSceneResponseBody,
  type ClientScenesResponse,
} from "./client-scenes/clientScenes.js";
export { isValidCronExpr } from "./session/automationCronValidation.js";
// 闲时任务复用 cron 语法，但与 automation 服务面独立：
// 合并会让「定时触发」与「省峰批处理」的权限、重试策略互相污染。
// 闲时任务管理服务（与 automation 服务面独立）；接口/描述符 browser-safe。
export { IOffPeakTaskService } from "./session/offPeakTask.js";
export type { OffPeakUpdateTaskParams } from "./session/offPeakTask.js";

// 四条同步通道各有独立游标与重试；保持一项一行，避免被误当成一个聚合服务。
// Skills service — ISkillsService is both a type (interface) and value (descriptor)
export { ISkillsService } from "./skills/skills.js";
export { ISkillSyncService } from "./skill-sync/skillSync.js";
export { IMcpSyncService } from "./mcp-sync/mcpSync.js";
export { IPluginSyncService } from "./plugin-sync/pluginSync.js";
export {
  ICuaPermissionService,
  type CuaPermissionState,
  type CuaPermissionRestartOptions,
  type CuaPermissionStatus,
  type CuaPermissionStatusQueryOptions,
  type CuaPermissionStatusResult,
  type CuaPermissionStatusUnavailable,
  isCuaPermissionStatusAvailable,
} from "./cua-permission-broker/cuaPermissionService.js";
export {
  ICuaPipSessionService,
  type CuaPipSessionService,
} from "./cua-permission-broker/cuaPipSession.js";

// 插件域分两层：运行期 descriptor 与设置页管理薄服务；withPluginTelemetry 是
// 装饰器而非新单例，导出它是为了 host 侧统一包埋点。
// Plugins service — IPluginsService is both a type (interface) and value (descriptor)
export { IPluginsService } from "./plugins/plugins.js";
// 该服务不持有插件状态，只转发到 agent 服务：UI 平台能力面不应直接触达
// zcodeAgentService，因此需要这层窄接口来隔离会话域。
// 设置页插件管理薄服务（UI 平台能力面不再直触 zcodeAgentService）
export { IPluginManagementService, withPluginTelemetry } from "./plugins/pluginManagement.js";

// Subagents 与 Commands 是会话内可枚举能力，清单由各自实现按 workspace 解析；
// 根入口只保证 descriptor 稳定，不在此处固化枚举结果。
// Subagents service — ISubagentsService is both a type (interface) and value (descriptor)
export { ISubagentsService } from "./subagents/subagents.js";

// 命令注册顺序决定斜杠面板顺序；服务侧只提供读取契约，UI 不得重排。
// Commands service — ICommandsService is both a type (interface) and value (descriptor)
export { ICommandsService } from "./commands/commands.js";

export { ISettingsSyncService } from "./settings-sync/settingsSync.js";

export { IFeedbackService } from "./feedback/feedback.js";
export type { FeedbackUploadProgress } from "./feedback/feedback.js";
export { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
export type {
  PromptAttachmentStageParams,
  PromptAttachmentStageResult,
  PromptAttachmentTransferPhase,
  PromptAttachmentTransferProgress,
} from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
export type {
  CreateFeedbackTicketInput,
  FeedbackAttachment,
  FeedbackAttachmentKind,
  FeedbackComment,
  FeedbackDeviceInfo,
  FeedbackListQuery,
  FeedbackListResult,
  FeedbackReporter,
  FeedbackTicketDetail,
  FeedbackTicketFramework,
  FeedbackTicketModule,
  FeedbackTicketSeverity,
  FeedbackTicketStatus,
  FeedbackTicketSummary,
  FeedbackTicketType,
} from "@zcode/shared";

export { IProjectService, LEGACY_SINGLE_ROOT_PROJECT_PREFIX } from "#src/project/contract.js";
export type {
  ProjectTree,
  ProjectTask,
  ProjectTaskRef,
  VirtualProject,
  ProjectRoot,
  SaveProjectInput,
  ProjectDirectories,
} from "#src/project/contract.js";

export { IRemoteProjectService } from "#src/remote-projects/contract.js";
export type {
  RemoteProjectHost,
  RemoteProjectEntry,
  RemoteProjectCache,
  RemoteProjectDirectory,
} from "#src/remote-projects/contract.js";

export { readProjectCatalog, projectSelectionId } from "#src/project-catalog/index.js";
export type { ProjectCatalogPort, ProjectCatalogSnapshot } from "#src/project-catalog/contract.js";

// 插件 UI 桥把 MCP 风格的资源/工具调用收敛成受控 RPC：工厂与 descriptor 必须
// 同时导出，host 侧才能既建实例又完成注入。
// 插件 UI 桥：描述符、参数类型与工厂；App-Provided Tools 另有独立描述符。
export {
  createPluginUiBridgeService,
  createPluginUiAppToolsService,
  createPluginUiSamplingService,
  IPluginUiSamplingService,
  type PluginUiSamplingParams,
  type PluginUiCancelSamplingParams,
  PluginUiBridgeError,
  IPluginUiAppToolsService,
  type PluginUiAppToolInstanceParams,
  type PluginUiAppToolCallParams,
  type PluginUiAppToolAcceptedResult,
  type PluginUiRegisterAppToolsParams,
  type PluginUiRegisterAppToolsResult,
  type PluginUiResolveAppToolCallParams,
} from "./plugin-ui-bridge/index.js";
export {
  IPluginUiBridgeService,
  type PluginUiCallToolParams,
  type PluginUiCallToolResult,
  type PluginUiPrepareSandboxParams,
  type PluginUiReadResourceParams,
  type PluginUiReadResourceResult,
  type PluginUiPluginScope,
  type PluginUiListResourcesParams,
  type PluginUiListResourcesResult,
  type PluginUiListResourceTemplatesResult,
  type PluginUiResourceSubscriptionParams,
  type PluginUiSurfaceEntry,
  type PluginUiWorkspaceTarget,
} from "./plugin-ui-bridge/contract.js";
// 客户端配置是「服务端下发 + 本地覆盖」的合成视图，读取入口唯一，写入在 node 侧。
export { IClientConfigService } from "./client-config/clientConfig.js";

// 传输实现（HTTP / mock）与纯函数分开导出：测试只替换 transport，不替换契约。
export { IHighspeedCardService } from "./highspeed/highspeedCard.js";
export {
  HighspeedCardService,
  createHighspeedHttpTransport,
  buildHighspeedTurnExecution,
} from "./highspeed/highspeedCardService.js";
export { createHighspeedMockTransport } from "./highspeed/highspeedMockTransport.js";

// GenUI 根入口只留契约；生成实现依赖运行时能力，走 node 子路径。
export { IGenUiService } from "./gen-ui/contract.js";
export type { GenUiPrepareParams } from "./gen-ui/contract.js";

// 分组是层级结构：结构类型与移动指令一起导出，保证两端对「移动节点」解释一致。
export { ITaskGroupService } from "#src/task-groups/contract.js";
export type {
  TaskGroup,
  TaskGroupColor,
  TaskGroupStructure,
  GroupTaskRef,
  GroupNode,
  MoveGroupNode,
} from "#src/task-groups/contract.js";
