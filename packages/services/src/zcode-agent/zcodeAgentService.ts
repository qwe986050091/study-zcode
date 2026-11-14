/**
 * ============================================================================
 * services/zcode-agent/zcodeAgentService.ts —— Host 侧 ZCode Agent 服务门面
 * ============================================================================
 *
 * 【定位】Host 与 workspace CLI 之间的主服务：负责
 *   - 按 workspaceKey 选择/启动/复用 zcode-cli；
 *   - 维护 ZCode Protocol/V4 的传输、command、快照与事件订阅；
 *   - 把 CLI 的 conversation/topic 帧路由给对应 attachment；
 *   - 插件/MCP/技能/自动化/off-peak/浏览器等 app-facing 方法的协议适配。
 *
 * 【状态归属】
 *   - conversation 权威状态在 CLI（command inbox + projection）；
 *   - Host 只持有 connection scope、subscription ownership、attachment 与
 *     传输层状态；不缓存第二份 conversation、queue 或 projection。
 *   - 本文件里的 Map 只应保存"路由/生命周期"信息，不能变成业务事实源。
 *
 * 【错误与通知纪律】
 *   - 协议错误用稳定 code/reasonCode 分流，不用 message 文本判断；
 *   - 生命周期通知（plugin-ui / off-peak / provider headers 等）必须经统一
 *     emitter/schema 校验后再交给 client；
 *   - 远端/移动端 attachment 的能力面由 channel allowlist 控制，
 *     不能因为方法在这里存在就默认对所有 client 暴露。
 *
 * 【迁移背景】文件里仍保留部分 legacy task 协议方法，用于旧端兼容；
 * 新能力应优先走 V4 command/topic，不再往本文件增加第二套聊天状态。
 * ============================================================================
 */
// ===== 本段（原 1–1688 行）维护/依赖的不变量 ============================================
// INV-01 关联：本段所有 Map 只保存路由与生命周期（pending / emitter / active client），
//   不保存 conversation 行、queue 或 projection；多存一份就会与 CLI 的 CommandInbox 分叉。
// INV-02 关联：workspace 身份 key 只由 resolveWorkspaceKey / buildWorkspaceRef 生成，
//   远程链路必须同时带 workspaceIdentity 与 remoteSessionId，只按路径匹配会串 workspace。
// INV-03 关联：activeClientsByWorkspaceKey 的淘汰必须做 identity guard，旧 client 的
//   迟到清理只能释放自身资源，不能删除已登记的新 client（见 invalidateWorkspaceClient）。
// INV-04 关联：事件 key 统一为 workspaceKey + NUL + sessionId；eventId 去重集合有界
//   （MAX_TRACKED_SESSION_EVENT_IDS），重复订阅必须幂等并释放旧 disposable。
// INV-05 关联：协议错误只按 code / reasonCode 分流；pending map 在超时、失败、取消
//   三条路径上都必须删除并清定时器，否则 Promise 悬挂、定时器泄漏。
// INV-07 关联：pending 请求与订阅的生命周期绑 client，client 断开即释放。
// INV-12 关联：dispose 之后不得再登记新 pending、发请求或起定时器；重复 dispose 幂等。
// [权衡] import 全量静态、不做 lazy require：本文件是所有 app-facing 方法的门面，
// 延迟加载只会把「模块缺失」推迟到某个会话首次调用时才炸，同时让打包期检查失效；
// 代价是启动期多加载几个 schema 模块，换来的是失败发生在装配而不是用户交互中。
// 下面的 schema 与常量都对应真实的一次协议往返或一次校验，删 import 前先找调用点。
import { isAuxiliarySessionKind } from "@zcode/shared";
// schema 与 type 成对导入：schema 负责运行时边界校验，type 让笔误在编译期暴露。
// 只导 type 会让非法字段静默穿过协议边界，只导 schema 又拿不到结构化类型提示。
import {
  pluginUiToolResultNotificationSchema,
  type PluginUiToolResultNotification,
} from "@zcode/shared/mcp-apps";
// 能力探测放在 Host 侧：independent plan 是否走 history-first 是 CLI 版本差异，
// 若在调用点各自判断，两个调用点很容易对新旧 CLI 得出不同结论。
import { supportsHistoryFirst } from "./independentPlanSupport.js";
// Off-Peak 的参数、结果、生命周期通知各用独立 schema：合成一个宽 schema 会放过
// 本不该出现在该方向的字段，等于把协议面校验退化成「字段存在即可」。
import {
  offPeakControlParamsSchema,
  offPeakControlResultSchema,
  offPeakLifecycleNotificationSchema,
  type OffPeakLifecycleNotification,
  type OffPeakControlParams,
} from "@zcode/shared";
// 请求校验的三个判断缺一不可：requiresRequestVerification 决定要不要发起交互，
// allowRequestVerificationHeaders 决定能否下发头，interaction 可用性决定走交互还是直接失败；
// 只看 allow 头会把「有能力」误当成「已授权」。
import {
  requiresRequestVerification,
  allowRequestVerificationHeaders,
  requestVerificationInteractionAvailable,
} from "@zcode/shared";
// sampling 结果 schema 与传输超时成对引入：超时值和 schema 必须同源，
// 否则放宽超时后仍按旧 schema 校验，MCP Apps 的长轮询会被判成非法响应。
import { zcodeMcpUiSamplingResultSchema } from "@zcode/shared";
import { MCP_APPS_SAMPLING_TRANSPORT_TIMEOUT_MS } from "@zcode/shared/mcp-apps";
import {
  channelReplyRequestSchema,
  type ChannelReplyHostRequest,
  type ChannelReplyResult,
} from "@zcode/shared";
// 走 #src 深路径而不是 @zcode/shared：plugin reference catalog 是 Host 内部实现，
// 暴露到共享协议面会让 CLI 侧误以为这是可依赖的公共接口。
import { requestPluginReferenceCatalog } from "#src/zcode-agent/pluginReferenceCatalogRequest.js";
import {
  localTtftFactsSchema,
  sessionDebugSnapshotSchema,
  type LocalTtftFacts,
} from "@zcode/shared";
// [权衡] 单文件禁用 max-lines 而不是拆文件：transport、通知 wiring 与 app-facing 方法
// 共享同一个 client/emitter 上下文，拆开只能靠回传闭包或再抽一层 context 对象，
// 反而引入循环依赖。这里的豁免是给「一个门面」的，不是给「随便变长」的。
/* oxlint-disable eslint(max-lines) -- ZCode Protocol transport、通知 wiring 和 app-facing session 方法必须共享同一个 client/emitter 上下文。 */
import { ensureIndependentPlanSupport } from "./independentPlanSupport.js";
// createHash 用于生成稳定的去重键，randomUUID 用于 v4ConnectionId；
// 不要用 Math.random 或时间戳替代：两者都可能碰撞，后者还会让同毫秒建连互相覆盖。
import { createHash, randomUUID } from "node:crypto";
import { createTopicResourceBridge } from "./topicResourceBridge.js";
import { uploadTopicResourceToClient } from "./topicResourceUpload.js";
import {
  zcodeTopicResourceCancelParamsSchema,
  type ZCodeTopicResourceReadParams,
  type ZCodeProtocolTrace,
  type ZCodePromptAttachment,
} from "@zcode/shared";
// fs/path 只服务于插件管理固定 cwd（见 ensurePluginManagementWorkspacePath）。
// workspace 内的文件操作属于 CLI，Host 侧出现 mkdir/join 时先确认不是越界。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
// Emitter/IDisposable 来自 @zcode/rpc：这是唯一事件通道，自造 EventEmitter
// 会绕过 dispose 契约，订阅方无法在 client 断开时被统一释放（INV-07）。
import { Emitter } from "@zcode/rpc";
import type { IDisposable } from "@zcode/rpc";
// provider 侧只取类型与快照：Host 读的是进程级 Registry 的只读投影，
// 不持有 Registry 本身，避免 Host 变成模型事实的第二权威。
import type {
  AccountProviderConfigSnapshot,
  ModelSelectionView,
  ProviderSource,
} from "@zcode/provider";
import { completeNewModelSelection } from "@zcode/provider";
// OffPeakClientConfig 走深路径：它携带 Selection View，属于 Host 装配事实，
// 不是 CLI 协议的一部分，放进 shared 会诱导 CLI 直接读宿主配置。
import type { OffPeakClientConfig } from "#src/coding-plan-subscription/codingPlanSubscription.js";
// 这一大块 @zcode/shared 同时引入 schema、稳定码、常量与 type：协议层是唯一事实源。
// ZCODE_AGENT_PROVIDER_NOT_READY_CODE / ZCODE_PROTOCOL_VERSION 这类常量绝不能在
// 调用点写字面量，否则 Host 与 CLI 版本协商会悄悄失效（INV-05）。
import {
  subagentRuntimeConfigSchema,
  zcodeSubagentsReadRuntimeConfigParamsSchema,
  type SubagentRuntimeConfig,
  ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
  formatLogPrefix,
  resolveWorkspaceKey,
  type TraceId,
  ZCODE_AGENT_PROVIDER,
  ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
  ZCODE_AGENT_PROVIDER_NOT_READY_REASON,
  ZCODE_MODEL_REASONING_SEPARATOR,
  isRemoteWorkspaceIdentity,
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeMcpListResultSchema,
  zcodePermissionRequestParamsSchema,
  zcodeBrowserListParamsSchema,
  zcodeBrowserExecuteParamsSchema,
  zcodePluginsConfigureResultSchema,
  zcodePluginsInstallResultSchema,
  zcodePluginsListResultSchema,
  zcodePluginsMarketplaceMutationResultSchema,
  zcodePluginsOverviewResultSchema,
  zcodeProcessChildProcessesResultSchema,
  type ZCodeProcessChildProcess,
  zcodeSkillsReferenceCatalogResultSchema,
  zcodeMcpReadResourceResultSchema,
  zcodeMcpUiCallToolResultSchema,
  zcodeMcpUiCancelCallResultSchema,
  zcodeMcpUiReadResourceResultSchema,
  zcodeMcpUiListResourcesResultSchema,
  zcodeMcpUiAppToolAcceptedResultSchema,
  zcodeMcpUiRegisterAppToolsResultSchema,
  zcodeMcpUiUnregisterAppToolsResultSchema,
  zcodeMcpUiListResourceTemplatesResultSchema,
  zcodeMcpUiResourceSubscriptionResultSchema,
  zcodePluginsListUiSurfacesResultSchema,
  zcodeWorkflowsDeleteResultSchema,
  zcodeWorkflowsForRunResultSchema,
  zcodeWorkflowsGetResultSchema,
  zcodeWorkflowsListResultSchema,
  zcodeWorkflowsMoveResultSchema,
  zcodeWorkflowsRunsResultSchema,
  zcodeWorkflowsSaveResultSchema,
  zcodeWorkflowsUpdateMetaResultSchema,
  zcodePluginsResolveSuggestedReferenceResultSchema,
  zcodePluginOperationProgressNotificationSchema,
  zcodePluginsRestoreBuiltinResultSchema,
  zcodePluginsSetEnabledResultSchema,
  zcodePluginsCancelOperationResultSchema,
  zcodePluginsUninstallResultSchema,
  zcodePluginsValidateResultSchema,
  zcodePluginsDescribeResultSchema,
  zcodeAutomationCheckTaskBindingParamsSchema,
  zcodeAutomationCreateParamsSchema,
  zcodeAutomationDeleteParamsSchema,
  zcodeAutomationListParamsSchema,
  zcodeAutomationUpdateParamsSchema,
  zcodeOffPeakCreateParamsSchema,
  zcodeOffPeakListParamsSchema,
  OFF_PEAK_PROVIDER_IDS,
  zcodeComputerUseOperationEventSchema,
  zcodeProviderRuntimeHeadersCancelledSchema,
  zcodeProviderRuntimeHeadersRequestParamsSchema,
  zcodeProviderRefreshRegistryResultSchema,
  zcodeProviderTestModelConnectivityResultSchema,
  zcodeOfficialMcpAuthHeadersRequestParamsSchema,
  summarizeOfficialMcpIdentityHeaders,
  zcodeProtocolEmptyResultSchema,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  zcodeMcpTelemetryEventSchema,
  zcodeMcpResourceSamplesSchema,
  zcodeToolExecResourceSchema,
  zcodeProcessResourceSampleSchema,
  zcodeSessionCloseResultSchema,
  zcodeSessionCompactResultSchema,
  zcodeSessionEventsResultSchema,
  zcodeSessionGoalResultSchema,
  zcodeSessionListResultSchema,
  zcodeSessionSubagentsResultSchema,
  zcodeSessionMessagesResultSchema,
  zcodeSessionEventSchema,
  zcodeSessionSendResultSchema,
  zcodeSessionRequestRuntimePreferencesParamsSchema,
  zcodeSessionRuntimePreferencesResultSchema,
  zcodeSessionStateSnapshotSchema,
  zcodeSessionSubscribeResultSchema,
  zcodeStateUpdatedNotificationSchema,
  zcodeUserInputRequestParamsSchema,
  zcodeWorkspacePresentationSchema,
  zcodeWorkspaceCancelGenerateTextResultSchema,
  zcodeWorkspaceGenerateTextResultSchema,
  zcodeWorkspaceHookTrustGrantResultSchema,
  zcodeWorkspaceUpdateInteractionPreferencesResultSchema,
  zcodeWorkspaceUpdateModelIoPreferencesResultSchema,
  zcodeProviderUpdateAccountConfigResultSchema,
  type ZCodeSessionStateSnapshot,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  zcodeWorkspaceUpdateOffPeakToolPolicyResultSchema,
  zcodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema,
  type DynamicWorkflowClientConfig,
  type DynamicWorkflowMode,
  applyDynamicWorkflowUserMode,
  createDynamicWorkflowClientConfig,
  DEFAULT_DYNAMIC_WORKFLOW_MODE,
  isDynamicWorkflowModeEnabled,
  normalizeDynamicWorkflowMode,
  type AgentLaneResourceSample,
  type ProcessResourceCliLane,
  type ZCodeMcpTelemetryEvent,
  type ZCodeMcpResourceSample,
  type ZCodeToolExecResource,
  type ZCodePluginOperationProgressNotification,
  type ZCodeTaskMode,
} from "@zcode/shared";
// 用 createServiceLogger 而不是 console：等级口径按 services/AGENTS.md，
// 高频协议细节走 debug，生产构建里 debug 是 no-op，不会随流量膨胀日志。
import { createServiceLogger } from "#src/logger/serviceLogger.js";
// 官方 MCP 身份头发放审计的去重器（见 officialMcpIssuanceAudit 的声明处）：
// 只在本进程内对每个 (pluginId, mcpKey, workspaceKey) 记一次 info，避免消息量级日志。
import { createOfficialMcpIssuanceAudit } from "#src/official-mcp/officialMcpIssuanceAudit.js";
import type {
  AccountRequestAuthMaterial,
  IAccountRequestAuthService,
} from "#src/model-provider/accountRequestAuthService.js";
import {
  // denylist 合并规则集中在 automationToolPolicy：automation 与 off-peak 两条写入路径
  // 必须合并出同一份禁止集合，各写一份迟早会漂移成「某条路径能调、另一条不能」。
  mergeAutomationMutationToolDenylist,
  mergeOffPeakMutationToolDenylist,
} from "#src/zcode-agent/automationToolPolicy.js";
// 这是值导入而不是 type-only：ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE 是稳定错误码，
// 上层按它分支决定是否重试启动，改成字符串会让分支在重构时静默失效。
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "./zcodeAgent.js";
// 纯类型导入，编译后擦除：引入它们不会造成 zcodeAgent.ts 与本文件的运行时循环依赖。
// 若把其中任一改成值导入，需重新检查门面与协议定义的初始化顺序。
import type {
  ZCodeProtocolRequestId,
  ModelSelection,
  ZCodeProviderRuntimeHeadersRequestParams,
  ZCodeProviderRuntimeHeadersCancelled,
  ZCodeSessionEvent,
  ZCodeSessionRuntimePreferencesScope,
  ZCodeSavedWorkflowScope,
  ZCodeStateUpdatedNotification,
  ZCodeWorkspacePresentation,
  ZCodeWorkspaceRef,
  ZCodeSessionRuntimePreferencesResult,
} from "@zcode/shared";
// IZCodeAgentService 是返回类型的公开契约：新增/删除方法必须同步 zcodeAgent.ts，
// 否则远端 channel allowlist 与本类实现会不一致（方法存在但不对某些 client 暴露，INV-06）。
import type {
  IZCodeAgentService,
  ZCodeAgentBackgroundBashOutputParams,
  ZCodeAgentAppRuntimePreferences,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentAddPluginMarketplaceParams,
  ZCodeAgentAppUsageParams,
  ZCodeAgentCancelPluginOperationParams,
  ZCodeAgentCompactParams,
  ZCodeAgentConfigurePluginParams,
  ZCodeAgentResetPluginConfigParams,
  ZCodeAgentCreateSessionParams,
  ZCodeAgentInstallPluginParams,
  ZCodeAgentGenerateWorkspaceTextParams,
  ZCodeAgentTestModelConnectivityParams,
  ZCodeAgentGoalParams,
  ZCodeAgentGrantWorkspaceHookTrustParams,
  ZCodeAgentInitializeResult,
  ZCodeAgentListSessionsParams,
  ZCodeAgentListSessionSubagentsParams,
  ZCodeAgentReadWorkspacePresentationParams,
  ZCodeAgentReadSessionEventsParams,
  ZCodeAgentReadSessionMessagesParams,
  ZCodeAgentReadSessionParams,
  ZCodeAgentRemovePluginMarketplaceParams,
  ZCodeAgentRespondProviderRuntimeHeadersParams,
  ZCodeAgentRespondSessionRuntimePreferencesParams,
  ZCodeAgentResumeSessionParams,
  ZCodeAgentSendPromptParams,
  ZCodeAgentServiceEvent,
  ZCodeAgentSessionSubscribeParams,
  ZCodeAgentSessionTarget,
  ZCodeAgentSessionRuntimePreferencesRequest,
  ZCodeAgentTaskTokenUsageParams,
  ZCodeAgentSetModeParams,
  ZCodeAgentSetModelParams,
  ZCodeAgentSetPluginEnabledParams,
  ZCodeAgentSetThoughtLevelParams,
  ZCodeAgentPluginReferenceCatalogParams,
  ZCodeAgentSkillReferenceCatalogParams,
  ZCodeAgentReadMcpResourceParams,
  ZCodeAgentCallMcpToolForUiParams,
  ZCodeAgentCancelMcpToolCallForUiParams,
  ZCodeAgentReadMcpResourceForUiParams,
  ZCodeAgentListMcpResourcesForUiParams,
  ZCodeAgentAppToolCallForUiParams,
  ZCodeAgentAppToolInstanceForUiParams,
  ZCodeAgentRegisterAppToolsForUiParams,
  ZCodeAgentResolveAppToolCallForUiParams,
  ZCodeAgentMcpResourceSubscriptionForUiParams,
  ZCodeAgentDeleteSavedWorkflowParams,
  ZCodeAgentFindSavedWorkflowForRunParams,
  ZCodeAgentGetSavedWorkflowParams,
  ZCodeAgentListSavedWorkflowRunsParams,
  ZCodeAgentListSavedWorkflowsParams,
  ZCodeAgentMoveSavedWorkflowParams,
  ZCodeAgentSaveSavedWorkflowFromRunParams,
  ZCodeAgentSavedWorkflowTarget,
  ZCodeAgentUpdateSavedWorkflowMetaParams,
  ZCodeAgentResolveSuggestedPluginReferenceParams,
  ZCodeAgentPluginViewParams,
  ZCodeAgentUninstallPluginParams,
  ZCodeAgentUpdatePluginParams,
  ZCodeAgentRestoreBuiltinPluginParams,
  ZCodeAgentUpdatePluginMarketplaceParams,
  ZCodeAgentValidatePluginParams,
  ZCodeAgentDescribePluginParams,
  ZCodeAgentListMcpServerStatusesParams,
  ZCodeAgentWorkspaceTarget,
  ZCodeAgentCuaPermissionObservation,
  ZCodeAgentCreateAutomationParams,
  ZCodeAgentUpdateAutomationParams,
  ZCodeAgentAutomationIdParams,
  ZCodeAgentSetAutomationEnabledParams,
  ZCodeAgentDeleteAutomationRunParams,
  ZCodeAgentAttachmentBeginParams,
  ZCodeAgentAttachmentChunkParams,
  ZCodeAgentAttachmentReadParams,
  ZCodeAgentConversationAttachmentReadParams,
  ZCodeAgentConversationAttachmentStatParams,
  ZCodeAgentAttachmentPreviewSourceParams,
  ZCodeAgentAttachmentTerminalParams,
  ZCodeAgentConversationCommandParams,
  ZCodeAgentCommandsQueryParams,
  ZCodeAgentConversationFileChangesParams,
  ZCodeAgentConversationFileRewindPreviewParams,
  ZCodeAgentConversationRowsRangeParams,
  ZCodeAgentConversationPlansParams,
  ZCodeAgentConversationWorkflowRunEventsParams,
  ZCodeAgentConversationWorkflowRunArtifactDataParams,
  ZCodeAgentConversationWorkflowRunArtifactReadParams,
  ZCodeAgentConversationWorkflowRunArtifactsParams,
  ZCodeAgentConversationWorkflowRunNodeResultParams,
  ZCodeAgentConversationWorkflowRunWorkspaceParams,
  ZCodeAgentConversationWorkflowRunsParams,
  ZCodeAgentConversationResyncParams,
  ZCodeAgentConversationSubscribeParams,
  ZCodeAgentConversationUnsubscribeParams,
  ZCodeAgentConnectionFlowParams,
  ZCodeAgentSessionsIndexSubscribeParams,
  ZCodeAgentWorkspaceConfigSubscribeParams,
} from "./zcodeAgent.js";
// V4 协议导入块：schema、稳定常量与错误类。两条界线值必须与 CLI 同源——
// PROTOCOL_V4_LIMITS 决定单帧预算，MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE 决定 legacy 订阅规模；
// 任一处本地写死，Host 与 CLI 对「合法帧」的判断就会分叉。
import {
  backgroundBashOutputResultSchema,
  v4BackgroundBashOutputParamsSchema,
  V4_WIRE_PROTOCOL_VERSION,
  PROTOCOL_V4_LIMITS,
  clientHelloSchema,
  commandAckSchema,
  commandPayloadSchemas,
  commandsQueryParamsSchema,
  commandsQueryResultSchema,
  conversationTopic,
  conversationTopicWireCandidateSchema,
  conversationTelemetryFactSchema,
  cuaPermissionObservationSchema,
  sessionsIndexTopic,
  sessionsIndexReconcileResultSchema,
  sessionsIndexTopicWireCandidateSchema,
  MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE,
  V4_METHODS,
  V4_NOTIFICATIONS,
  v4AttachmentAbortResultSchema,
  v4AttachmentBeginResultSchema,
  v4AttachmentChunkResultSchema,
  v4AttachmentCommitResultSchema,
  v4AttachmentPreviewSourceParamsSchema,
  v4AttachmentPreviewSourceResultSchema,
  v4AttachmentReadParamsSchema,
  v4AttachmentReadResultSchema,
  v4ConversationAttachmentReadParamsSchema,
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatParamsSchema,
  v4ConversationAttachmentStatResultSchema,
  v4ConnectionFlowResultSchema,
  v4ConversationFileChangesResultSchema,
  v4ConversationFileRewindPreviewResultSchema,
  v4ConversationRowsRangeResultSchema,
  v4ConversationPlansResultSchema,
  v4ConversationWorkflowRunEventsResultSchema,
  v4ConversationWorkflowRunArtifactDataResultSchema,
  v4ConversationWorkflowRunArtifactReadResultSchema,
  v4ConversationWorkflowRunArtifactsResultSchema,
  v4ConversationWorkflowRunNodeResultResultSchema,
  v4ConversationWorkflowRunWorkspaceResultSchema,
  v4ConversationWorkflowRunsResultSchema,
  v4ConversationResyncResultSchema,
  v4ConversationSubscribeResultSchema,
  v4ConversationUsageResultSchema,
  v4SessionsIndexSubscribeResultSchema,
  v4UsageStatsResultSchema,
  v4WorkspaceConfigSubscribeResultSchema,
  workspaceConfigTopic,
  workspaceConfigTopicWireCandidateSchema,
  utf8JsonByteLength,
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
  type CommandAck,
  type ConversationTopicWireCandidate,
  type ConversationTelemetryFact,
  type SessionsIndexTopicWireCandidate,
  type WorkspaceConfigTopicWireCandidate,
  type CommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
// readTrustedZCodeAgentV4Connection 只接受已登记连接：连接身份由登记处授予，
// 不能凭请求里自带的 connectionId 反查，否则任意 renderer 都能伪造一条订阅路由。
import {
  readTrustedZCodeAgentV4Connection,
  readTrustedZCodeAgentV4UnsubscribeRoute,
  type ZCodeAgentV4ConnectionContext,
} from "./zcodeAgentConnectionScope.js";
// 后台会话事件的合流器：高频 part.delta 类帧先合并再推给 renderer，
// 否则一次后台任务就能把 renderer 的消息队列打满。
import { createBackgroundSessionEventCoalescer } from "#src/zcode-agent/zcodeSessionEventCoalescer.js";
// AutomationRepo 同时持有 tasks-index.sqlite 连接，disposeAll 必须一并收口；
// 它不参与会话状态，只负责定时任务的定义与运行记录。
import { AutomationService } from "#src/session/automationService.js";
import { AutomationRepo } from "#src/session/automationRepo.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
// 专用错误类型而不是字符串：MCP 状态模式不支持属于能力面差异，
// 上层需要按类型转成稳定 reasonCode，字符串匹配在压缩后不可靠（INV-05）。
import { ZCodeAgentMcpStatusModeUnsupportedError } from "#src/zcode-agent/zcodeAgentErrors.js";
import { ZCodeAgentProcessManager } from "./zcodeAgentProcessManager.js";
import type { ZCodeAgentProcessManagerOptions } from "./zcodeAgentProcessManager.js";
import type { IOffPeakTaskService } from "#src/session/offPeakTask.js";
import {
  ZCodeProtocolRequestTimeoutError,
  type ZCodeProtocolClient,
} from "./zcodeProtocolClient.js";
// getDataBaseDir 是插件管理固定 cwd 的根；它不用于 workspace 路径解析。
import { getDataBaseDir } from "../paths.js";
// browser ambient context 的采集与执行桥：Desktop 注入真实实现，
// 纯 CLI 装配不注入，此时 browser 命令返回 backend_unavailable 而不是抛未实现异常。
import {
  collectBrowserAmbientContext,
  type BrowserAmbientContextExecutor,
} from "./zcodeAgentBrowserAmbientContext.js";
// CUA turn tracker 只做「一次操作回合」的状态聚合，不持有会话内容；
// 缺省不创建（见工厂里的条件构造），避免没有消费方时仍维护 Map。
import {
  createCuaOperationTurnTracker,
  type CuaOperationWorkspaceTarget,
  type CuaOperationStateReporter,
} from "./cuaOperationTurnTracker.js";
// PipSessionEvent 仅取类型：PIP 生命周期由装配层回调驱动，Host 侧不反过来查询窗口状态。
import type { PipSessionEvent } from "@zcode/zcode-cua/pip-session";
// 内存诊断只登记「per-session 镜表的 size」读数，回调里禁止做 IO 或遍历内容，
// 否则诊断本身会变成卡顿源；返回的句柄属于资源，dispose 时必须释放。
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

// 把同名 schema 别名为 mcpUiEmptyResultSchema：它在调用点就被当作「空结果占位」，
// 重命名是为了让 reader 一眼看出这里不消费返回值，而不是又一份资源列表。
import {
  zcodeMcpUiResourceSubscriptionResultSchema as mcpUiEmptyResultSchema,
  zcodeMcpUiCloseInstanceResultSchema,
  zcodeMcpUiOpenInstanceResultSchema,
} from "@zcode/shared";
// 两个 logger scope 分开：zcode-agent-service 覆盖门面与 transport，
// cua-operation-turn 覆盖 CUA 回合；按 scope 过滤才能把「协议问题」与「操作问题」分开排查。
const logger = createServiceLogger("zcode-agent-service");
const cuaOperationLogger = createServiceLogger("cua-operation-turn");
// 固定目录名是磁盘契约：改名会让旧目录变成无人清理的孤儿，且新旧版本会各写一份。
// 追加子目录可以，改这一段名字必须同时提供迁移。
const PLUGIN_MANAGEMENT_WORKSPACE_DIR_NAME = "plugin-workspace";
// 注释已说明只作用于控制面；补一层边界：这条 lane 的空闲回收绝不能复用到会话进程，
// 会话进程被回收会表现为「用户还在看，session 突然 unavailable」。
// 状态探测完成后释放闲置的 MCP 子进程；只作用于控制面，不回收会话进程。
const MCP_STATUS_LANE_IDLE_TIMEOUT_MS = 5 * 60_000;
// 官方 Claude marketplace 首次接入需要 clone/copy GitHub 仓库，30s 默认协议超时会杀掉健康 agent。
// 插件市场管理属于低频网络 I/O 操作，单独放宽超时，不影响普通会话消息的实时失败边界。
const PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS = 5 * 60_000;
/** 资源管理器每秒刷新；子进程映射是纯内存请求，超时就当本轮无映射，不能拖慢采样节拍。 */
const CHILD_PROCESSES_REQUEST_TIMEOUT_MS = 800;
// 三个超时的取值不是随手写的：cancel 5s 是用户点取消后的可感知上限；
// compact 5min 覆盖大上下文压缩的合法长耗时；child-processes 800ms 低于
// 「每秒采样一次」的节拍，超时即当作本轮无映射，不能拖慢采样。
// [权衡] 800ms 对极慢机器可能偏紧，选择「少一次映射」而不是「采样周期被拉长」。
const PLUGIN_OPERATION_CANCEL_REQUEST_TIMEOUT_MS = 5_000;
const SESSION_COMPACT_REQUEST_TIMEOUT_MS = 5 * 60_000;

// pending 授权只记 client + protocolRequestId 两项：应答必须回到发起请求的那个连接。
// [权衡] 若只记 requestId 再去查当前 active client，换代后会把授权结果发给新进程，
// 新进程根本没有这个请求，等于用户点击被静默丢弃。
interface PendingPermissionRequest {
  client: ZCodeProtocolClient;
  protocolRequestId: ZCodeProtocolRequestId;
}

// responding 是重入闸门：自动应答与用户交互应答可能同时到达，
// 同一 protocolRequestId 只能 respond 一次，否则 CLI 侧会收到重复响应并报协议错。
interface PendingProviderRuntimeHeadersRequest extends PendingPermissionRequest {
  request: ZCodeProviderRuntimeHeadersRequestParams;
  responding?: boolean;
}

// 运行时偏好请求额外持有 timeout 与 workspaceKey：定时器必须有明确的主人，
// 只靠 requestId 回收会让超时后仍触发一次 respondError，向已关闭连接写入（INV-05）。
// workspaceKey 冗余保存是为了超时日志不必再解析 workspace 对象。
interface PendingSessionRuntimePreferencesRequest extends PendingPermissionRequest {
  workspace: ZCodeAgentWorkspaceTarget;
  request: ZCodeAgentSessionRuntimePreferencesRequest;
  timeout: ReturnType<typeof setTimeout>;
  workspaceKey: string;
}

// compat 字段集合定义的是「允许被省略重试」的白名单；它等价于声明：
// 这些字段缺失只会减少能力，不会改变请求语义。
// 反向约定：不在表里的字段（sessionId/workspace/content/expectedRevision 等）
// 一律不可降级，省略它们等于换了一个请求，而不是兼容旧版本。
type SessionCreateCompatField =
  | "persistence"
  | "thoughtLevel"
  | "mcpServers"
  | "toolAllowlist"
  | "toolDenylist"
  | "offPeakToolEnabled"
  | "dynamicWorkflowEnabled"
  | "dynamicWorkflowMode";
type SessionResumeCompatField =
  | "thoughtLevel"
  | "mcpServers"
  | "toolAllowlist"
  | "toolDenylist"
  | "offPeakToolEnabled"
  | "dynamicWorkflowEnabled"
  | "dynamicWorkflowMode";
type SessionSendCompatField =
  | "browserAmbientContext"
  | "automationId"
  | "offPeakTaskId"
  | "offPeakRunType"
  | "botDeliveryTarget"
  | "toolDenylist";

// create 的可降级面：persistence/thoughtLevel 属于新增配置，旧 CLI 的 .strict() 不认。
// importedHistory 故意不在表里（见 buildSessionCreateParams 的下发条件）：省略它会创建一个「能切模型但没有历史」
// 的空 session，属于语义损坏而不是能力缩减。
const SESSION_CREATE_OPTIONAL_COMPAT_FIELDS = new Set<SessionCreateCompatField>([
  "persistence",
  "thoughtLevel",
  "mcpServers",
  // CUA 工具隔离新增：buildSessionCreateParams 会带 toolAllowlist/toolDenylist。若旧 app-server
  // 的 .strict() schema 不认，需可降级重试而不是整个 createSession 硬失败。
  "toolAllowlist",
  "toolDenylist",
  // Off-Peak 工具面 flag 同为可降级字段；旧 app-server 不认时省略重试（工具随之不注册，fail-closed）。
  "offPeakToolEnabled",
  // 动态工作流灰度 flag 同理：旧 CLI 不认时
  // 省略重试，工作流工具簇随之不注册，绝不让整个 create 硬失败。
  "dynamicWorkflowEnabled",
  // 灰度 mode（launch.md「On demand: activation」）：只认布尔的 CLI 省略它后按 alwaysOn 行事。
  "dynamicWorkflowMode",
]);
// resume 比 create 少 persistence：恢复已存在 session 时持久化属性已被记录，
// 再下发一份只会制造「请求值 vs 已存值」的第二个权威。
const SESSION_RESUME_OPTIONAL_COMPAT_FIELDS = new Set<SessionResumeCompatField>([
  "thoughtLevel",
  "mcpServers",
  // 冷恢复也带工具面约束；旧 app-server 不认时降级重试而不是硬失败（与 create 一致）。
  "toolAllowlist",
  "toolDenylist",
  "offPeakToolEnabled",
  "dynamicWorkflowEnabled",
  "dynamicWorkflowMode",
]);
// send 的降级面与 create 不同：每次 send 都可能携带工具面与投递目标，
// 这些字段缺失只会让本次发送少一层约束，不会改变消息本身，因此可降级。
const SESSION_SEND_OPTIONAL_COMPAT_FIELDS = new Set<SessionSendCompatField>([
  "browserAmbientContext",
  "automationId",
  "offPeakTaskId",
  "offPeakRunType",
  "botDeliveryTarget",
  "toolDenylist",
]);
// onDynamicSessionEvent 建立上游订阅时若 getClient / sessionSubscribe 瞬时失败
// （agent 进程刚启动、runtime 抛 "Session is not active" 竞态、transport 抖动），
// 直接 .catch(() => {}) 静默吞掉且不重试的话，调用方（含 syncer shadow 订阅）会把
// emitter.event 当作"订阅成功"缓存，永不重建——这条 session 的终态事件再也到不了，
// sqlite 停在旧状态、侧边栏 spinner 转不停。这里改为有限次指数退避重试，覆盖瞬时失败窗口。
// 重试参数的边界：base 500ms 覆盖进程刚 spawn 的握手期，max 5000ms 防止一次抖动后
// 长时间不再尝试；8 次是上限而非目标。无限重试会积压订阅任务，单次重试盖不住冷启动窗口。
const SESSION_SUBSCRIBE_RETRY_BASE_DELAY_MS = 500;
const SESSION_SUBSCRIBE_RETRY_MAX_DELAY_MS = 5_000;
const SESSION_SUBSCRIBE_MAX_ATTEMPTS = 8;
// 事件 id 去重集合的上界（INV-04/INV-11）：它按 session 长期存活，
// 无界 Set 会随长会话线性增长；超出后按插入顺序淘汰最老 id，代价是极老事件可能重复投递。
const MAX_TRACKED_SESSION_EVENT_IDS = 10_000;
// SSH/WSL 前缀是身份字符串的协议约定，必须用 startsWith 判断而不是 includes：
// 本地路径里也可能出现 remote:ssh: 片段，用 includes 会把本地 workspace 误判成远程（INV-02）。
const SSH_REMOTE_WORKSPACE_IDENTITY_PREFIX = "remote:ssh:";
const WSL_REMOTE_WORKSPACE_IDENTITY_PREFIX = "remote:wsl:";

// 只有 ssh/wsl 远程的 legacy 端才接受 task allowlist 形态；本地会话走的是 V4 工具面。
// [权衡] 这里放宽会让旧远程端可用但本地白名单语义被复用，因此必须限定前缀。
// 返回 boolean 而不是抛错：它只用于选择参数形状，不改变请求是否合法。
export function supportsLegacyRemoteTaskAllowlist(workspaceIdentity: string | undefined): boolean {
// 只看 identity 前缀：本地会话即便是旧版本也不会带 remote:ssh:/remote:wsl:。
  return Boolean(
    workspaceIdentity?.startsWith(SSH_REMOTE_WORKSPACE_IDENTITY_PREFIX) ||
    workspaceIdentity?.startsWith(WSL_REMOTE_WORKSPACE_IDENTITY_PREFIX),
  );
}

// 这是全文件唯一允许按 message 文本判断错误的地方：stdio transport 关闭由底层驱动
// 直接构造 Error，没有 code 可依；其余路径一律按稳定 code 分流（INV-05）。
// 若底层将来补上 code，应改成先判 code、再退回 message，保持兼容。
function isClosedStdioTransportError(error: unknown): boolean {
  return error instanceof Error && error.message === "ZCode agent stdio transport is closed";
}

// seq 状态四个字段的生命周期不同：assignedSeqByEventId/assignedSeqEventIds 只增不减
// （seq 必须单调且可回放），liveEventIds/liveEventIdOrder 是「当前在线」视图，随离线收缩。
// [权衡] 不回收 assignedSeq 会让长会话内存缓慢增长，但回收会破坏重放时的序号连续性。
interface SessionEventSequenceState {
  assignedSeqByEventId: Map<string, number>;
  assignedSeqEventIds: string[];
  liveEventIds: Set<string>;
  liveEventIdOrder: string[];
  lastAssignedSeq: number;
}

// -32601 是 JSON-RPC 的 method not found，属于能力探测的稳定信号：
// isProtocolMethodNotFoundError 只认数值 -32601，让上层降级到旧方法而不是当协议错误上报给用户。
function isProtocolMethodNotFoundError(error: unknown): boolean {
// 先确认是对象再读 code，避免对 null/字符串做属性访问；
// 只认数值 -32601，错误对象的 message 文本不参与判断。
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === -32601
  );
}

// 所有协议入口的 workspace 引用只在这里构造：workspaceKey 由 resolveWorkspaceKey 统一计算，
// 各处手写拼接会在远程 identity 上退化成「只比路径」，直接破坏 INV-02。
// 字段顺序与 ZCodeWorkspaceRef 声明一致，便于日志 diff。
function buildWorkspaceRef(params: ZCodeAgentWorkspaceTarget): ZCodeWorkspaceRef {
// 四个字段都原样取自入参，唯一加工点是 workspaceKey；不在这里补默认值。
// 缺省字段保留 undefined 而不是空串，远端据此区分「未指定」与「显式为空」。
  return {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    remoteSessionId: params.remoteSessionId,
    workspaceKey: resolveWorkspaceKey(params),
  };
}

// 用 workspacePath 是否为 string 做类型谓词，而不是看 scope：
// GUI 项目组里 scope 为 global 的动作同样带 workspacePath，按 scope 判断会漏掉它们。
// 已保存工作流的 target 是否带 workspace：项目档、以及
// GUI 项目组里明说 `scope:"global"` 的动作都带 workspacePath；只给 `{ scope: "global" }` 的
// 全局组动作不带，交给 services 自选载体。
function savedWorkflowTargetHasWorkspace(
  params: ZCodeAgentSavedWorkflowTarget,
): params is ZCodeAgentWorkspaceTarget & { scope?: ZCodeSavedWorkflowScope } {
  return typeof (params as Partial<ZCodeAgentWorkspaceTarget>).workspacePath === "string";
}

// 只在 scope 有定义时下推：项目档缺省 scope 时必须保持与旧线上形状逐字一致，
// 补一个 scope: undefined 会让序列化结果不同，旧 CLI 的严格 schema 可能因此拒收。
// 只在 `scope` 有定义时下推到 RPC params：不给 scope 的项目档保持与今天逐字一致的线上形状。
function savedWorkflowScopeParam(params: ZCodeAgentSavedWorkflowTarget): {
  scope?: ZCodeSavedWorkflowScope;
} {
  return params.scope === undefined ? {} : { scope: params.scope };
}

// 每次调用都 mkdirSync：目录可能被用户或清理工具删除，缓存一个「已创建」布尔值
// 会让后续插件操作在 EPIPE 上失败；recursive 保证并发调用幂等。
// [权衡] 多一次 syscall 换取「目录存在」这一前提始终成立。
function ensurePluginManagementWorkspacePath(): string {
  const workspacePath = join(getDataBaseDir(), ".zcode", PLUGIN_MANAGEMENT_WORKSPACE_DIR_NAME);
  // 插件管理是控制面能力，不能复用可能因真实 workspace 被删而 EPIPE 的会话进程。
  // 这里给它固定一个内部 cwd；真实 workspace 仍通过协议参数传给 CLI 做 workspace-scope 判定。
  mkdirSync(workspacePath, { recursive: true });
  return workspacePath;
}

// 这个计数只统计协议 session/create 参数里的 per-session MCP，不是 CLI config.json 里的
// mcp.servers。两条通道由不同层连接，日志里 mcpServerCount:0 并不代表模型拿不到 MCP 工具。
// 维护提示：若把两处计数合并，会用错误的自变量去解释「工具没注册」这类线上问题。
// NOTE: this counts ONLY the per-session MCP servers passed through the ZCode Protocol
// session/create params (the app→protocol channel). It is deliberately independent of the
// CLI/bootstrap MCP servers configured in ~/.zcode/cli/config.json (mcp.servers), which the agent
// runtime connects separately and reports via the `mcp.server.connected`/toolCount events. So a
// createSession log line with mcpServerCount:0 is EXPECTED when zcode-cua is a CLI-config MCP server
// (e.g. the product Helper broker path injected through the gated bootstrap env): the model still receives those
// tools — the two numbers describe different channels, not a missing tool set. Verified on-machine:
// real kimi-k2.6 turns call mcp__zcode-cua__* tools (get_app_state/type/open_application, status
// completed) in sessions whose createSession logged mcpServerCount:0.
function getMcpServerCount(params: { mcpServers?: readonly unknown[] }): number {
  return params.mcpServers?.length ?? 0;
}

function getMcpServerNames(params: { mcpServers?: readonly { name: string }[] }): string[] {
  return params.mcpServers?.map((server) => server.name) ?? [];
}

// 只接受 -32602 且 message 为 Invalid params 系列：这是兼容降级唯一的合法入口。
// data.message 里是序列化后的 Zod issues，必须 JSON.parse 后结构化成数组；
// [失败路径] 解析失败返回空数组即「不降级」，宁可让请求失败也不能凭文本猜字段名。
function parseInvalidParamsIssues(error: unknown): unknown[] {
  const errorLike = error as {
    code?: unknown;
    data?: unknown;
    message?: unknown;
  };
// 只接受标准 invalid-params 错误码；其它 4xx/5xx 不参与兼容降级。
  const message = errorLike.message;
  if (
    errorLike.code !== -32602 ||
    typeof message !== "string" ||
    (message !== "Invalid params" && !message.startsWith("Invalid params — "))
  ) {
    return [];
  }
// data 必须是对象才继续；字符串形式的 data 无法承载结构化 issues。
  const data = errorLike.data;
  if (!data || typeof data !== "object") {
    return [];
  }
  // 新版 Agent 会把 Zod 摘要附加到顶层 message，旧兼容解析却只接受严格等于
  // "Invalid params"，导致 App/Agent 版本错位时无法省略新增字段重试。字段判断仍只信任
  // data 中的结构化 issues，不能从可变的人类可读摘要里猜字段名。
  const serializedIssues = (data as { message?: unknown }).message;
  if (typeof serializedIssues !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(serializedIssues) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// 只收 path 为空的 unrecognized_keys：顶层未知字段才可以安全省略。
// 嵌套路径的未知字段意味着对象内部形状不符，省略外层会把整块配置一起丢掉。
function getUnrecognizedTopLevelKeys(error: unknown): string[] {
// 用 Set 收集：同一次校验里同一个未知键可能被多个 issue 重复报告。
  const keys = new Set<string>();
// issue 列表来自 4xx 响应体，先防御非对象项，避免后续属性访问抛错。
  for (const issue of parseInvalidParamsIssues(error)) {
    if (!issue || typeof issue !== "object") {
      continue;
    }
    const issueLike = issue as {
      code?: unknown;
      keys?: unknown;
      path?: unknown;
    };
// 三重过滤：必须是 unrecognized_keys、path 为空（顶层）、keys 是数组。
    if (
      issueLike.code !== "unrecognized_keys" ||
      (Array.isArray(issueLike.path) && issueLike.path.length > 0) ||
      !Array.isArray(issueLike.keys)
    ) {
      continue;
    }
// 非字符串键不可能是协议字段名，直接忽略，不做隐式转换。
    for (const key of issueLike.keys) {
      if (typeof key === "string") {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

// 三个 get*CompatFields 的共同判据：所有未知键必须都在白名单内，且至少有一个。
// 只要出现一个白名单外的键就整体返回空——否则真正的协议演进错误会被当成版本兼容吞掉，
// 表现为「请求莫名成功但能力缺失」，比直接报错更难排查（INV-05）。
function getSessionCreateCompatFields(error: unknown): SessionCreateCompatField[] {
  const keys = getUnrecognizedTopLevelKeys(error);
// 没有任何未知顶层键时无需降级，返回空表示按原参数重试也不会成功。
  if (keys.length === 0) {
    return [];
  }
// every 而不是 some：只要混入一个白名单外的键，就说明这不是单纯的新旧字段差异。
  if (
    !keys.every((key): key is SessionCreateCompatField =>
      SESSION_CREATE_OPTIONAL_COMPAT_FIELDS.has(key as SessionCreateCompatField),
    )
  ) {
    return [];
  }
// 返回全部未知键：调用方会把它们一次性从参数里摘除后重试，避免多轮往返。
  return keys;
}

// resume 版本与 create 版本分开命名而不是共用一个函数：两者的白名单不同，
// 合并后必然出现「create 能降级、resume 不能」的隐式分支。
function getSessionResumeCompatFields(error: unknown): SessionResumeCompatField[] {
  const keys = getUnrecognizedTopLevelKeys(error);
// 空集意味着错误不是「未知字段」，resume 不应尝试降级重试。
  if (keys.length === 0) {
    return [];
  }
// resume 白名单独立于 create：能降级的字段集合不同，不能互相套用。
  if (
    !keys.every((key): key is SessionResumeCompatField =>
      SESSION_RESUME_OPTIONAL_COMPAT_FIELDS.has(key as SessionResumeCompatField),
    )
  ) {
    return [];
  }
// 只有全部键都可降级才返回；部分可降级时整体放弃，避免掩盖真实协议错误。
  return keys;
}

// send 版本独立：send 的未知键若被误省略，可能导致本次发送少一层工具约束，
// 因此白名单更窄，且只对明确声明可降级的字段生效。
function getSessionSendCompatFields(error: unknown): SessionSendCompatField[] {
  const keys = getUnrecognizedTopLevelKeys(error);
// send 的未知键也可能是执行语义字段，空集时不降级，直接让上层报错。
  if (keys.length === 0) {
    return [];
  }
// send 白名单最窄：只放行声明过可省略的字段，混入一个未知键就整体放弃。
  if (
    !keys.every((key): key is SessionSendCompatField =>
      SESSION_SEND_OPTIONAL_COMPAT_FIELDS.has(key as SessionSendCompatField),
    )
  ) {
    return [];
  }
// 返回全部可省略键，供第二次请求一次性剥除。
  return keys;
}

// 先 instanceof 再退回 message 比较：跨包/双实例场景下 instanceof 会失败，
// 而 method 相等仍能唯一标识是哪个请求超时，避免把 A 方法超时当成 B 方法超时。
function isProtocolRequestTimeout(error: unknown, method: string): boolean {
// 优先用类实例判断，method 必须精确相等：A 方法超时不能被当成 B 方法超时。
  if (error instanceof ZCodeProtocolRequestTimeoutError) {
    return error.method === method;
  }
  return error instanceof Error && error.message === `ZCode Protocol request timed out: ${method}`;
}

// [失败路径] 帧预算按 32 字符 id + 参数体 + NDJSON 换行估算：真实 request id 是递增整数，
// 这里用更宽的 id 是保守上界。超限必须在 Host 侧早拒，否则 CLI 侧读到半帧会让整条连接失步。
// 抛 proto.frameTooLarge 是稳定码，调用方按 code 转成协议错误而不是解析 message。
function assertV4AttachmentNdjsonEnvelope(method: string, params: unknown): void {
  // 实际 CLI request id 是递增整数；这里用更宽的 32-char id 做保守 exact-JSON meter。
  const bytes = utf8JsonByteLength({ id: "9".repeat(32), method, params }) + 1; // NDJSON newline
  if (bytes > PROTOCOL_V4_LIMITS.maxFrameBytes) {
    throw new Error("proto.frameTooLarge");
  }
}

// create 参数用「逐字段显式列举 + 条件展开」构造，而不是 ...params 透传：
// 协议面必须收敛，透传会让上游新增的内部字段自动过线，且无法对单字段做兼容门控。
// 代价是新增字段必须改三处（type、builder、白名单），这正是期望的摩擦。
function buildSessionCreateParams(
  params: ZCodeAgentCreateSessionParams & {
    offPeakToolEnabled?: boolean;
    dynamicWorkflowEnabled?: boolean;
    dynamicWorkflowMode?: DynamicWorkflowMode;
  },
  omittedFields: ReadonlySet<SessionCreateCompatField> = new Set(),
) {
  return {
    // sessionId 由调用方提供而非在此生成：重试同一请求必须命中同一 sessionId，
    // 若在这里 randomUUID，网络重试会变成创建两个 session。
    sessionId: params.sessionId,
    additionalDirectories: params.additionalDirectories,
    // workspace 只用 buildWorkspaceRef 的产物，不在 builder 里重算 key（INV-02）。
    workspace: buildWorkspaceRef(params),
    parentSessionId: params.parentSessionId,
    mode: params.mode,
    model: params.model,
    // persistence/thoughtLevel 同时受「值存在」与 omittedFields 两个条件约束：
    // undefined 不下发是为了让 CLI 用自身缺省，省略重试则用于旧 CLI 的严格 schema。
    // 反过来写（undefined 也发）会让新旧 CLI 对「未指定」的理解分叉。
    ...(params.persistence !== undefined && !omittedFields.has("persistence")
      ? { persistence: params.persistence }
      : {}),
    ...(params.thoughtLevel !== undefined && !omittedFields.has("thoughtLevel")
      ? { thoughtLevel: params.thoughtLevel }
      : {}),
    // titleGenerationEnabled 不受 omittedFields 门控：它是旧 CLI 已认识的老字段，
    // 放进可降级白名单会掩盖真正的参数拼写错误，属于错误地扩大兼容面。
    ...(params.titleGenerationEnabled !== undefined
      ? { titleGenerationEnabled: params.titleGenerationEnabled }
      : {}),
    // MCP 列表必须随 create 下发：MCP 是 runtime 启动期配置，进程起来后再 sendPrompt 补不上。
    // 之前漏传导致 runtimeConfig 只看到空 MCP，模型因此没有对应工具。
    // desktop-continuous 首发/恢复走 session service，不经过 legacy task adapter。
    // 之前这里没有把 UI 已解析的 MCP 带进 strict protocol params，runtimeConfig 只能看到空 MCP。
    // MCP 是 runtime 启动期配置，必须在 create/resume 请求边界显式传递，后续 sendPrompt 无法补上。
    ...(params.mcpServers !== undefined && !omittedFields.has("mcpServers")
      ? { mcpServers: params.mcpServers }
      : {}),
    // 工具面（CUA 隔离）字段受 omittedFields 门控：旧 app-server 的 .strict() 不认时，
    // 兼容重试会把它们放进 omittedFields 再发一次，而不是让 createSession 整体失败。
    // CUA 工具隔离字段是可降级的：旧 app-server 的 .strict() schema 若不认，兼容重试会把它们放进
    // omittedFields 省略后重试（而不是硬失败）。故这里必须同样受 omittedFields 门控。
    ...(params.toolAllowlist !== undefined && !omittedFields.has("toolAllowlist")
      ? { toolAllowlist: params.toolAllowlist }
      : {}),
    ...(params.toolDenylist !== undefined && !omittedFields.has("toolDenylist")
      ? { toolDenylist: params.toolDenylist }
      : {}),
    // importedHistory 故意不参与降级：省略它会创建一个可切模型但没有历史内容的空 session。
    // 这类「成功但语义错误」的结果比直接失败更难被用户发现，因此不允许静默降级。
    // importedHistory 是导入历史的完整性边界，不能像 thoughtLevel/persistence
    // 那样在旧协议兼容重试里省略，否则会创建一个可切模型但没有历史内容的空 session。
    ...(params.importedHistory !== undefined ? { importedHistory: params.importedHistory } : {}),
    // 只在 true 时下发：关闭态直接省略字段，让 CLI 的缺省（不注册工具）生效，
    // 这样旧 CLI 不需要认识 false 这个取值，也避免协议里出现多余布尔。
    // 只在灰度命中时下发 true（缺省不发字段）；旧 CLI strict schema 不认时经 compat 省略。
    ...(params.offPeakToolEnabled === true && !omittedFields.has("offPeakToolEnabled")
      ? { offPeakToolEnabled: true }
      : {}),
    // 动态工作流灰度同形：关闭不写字段，CLI 缺省即不注册那组工具，形成 fail-closed 的默认。
    // 动态工作流灰度：同 Off-Peak 的下发形状，
    // 关闭时不写字段——CLI 的缺省就是不注册那九个工具。
    ...(params.dynamicWorkflowEnabled === true && !omittedFields.has("dynamicWorkflowEnabled")
      ? { dynamicWorkflowEnabled: true }
      : {}),
    // mode 必须与布尔同源下发，理由见 buildDynamicWorkflowModeField；单独出现对 CLI 无意义。
    ...buildDynamicWorkflowModeField(params, omittedFields),
  };
}

// [权衡] 把 mode 判断抽成独立函数，是为了 create 与 resume 共用同一份条件；
// 复制两段等价判断后，任何一侧改动都会造成「建会话带 mode、恢复不带」的灰度不一致。
// 两个 omittedFields 键都要检查：只检查 mode 会让布尔已被省略时仍下发孤立的 mode。
/**
 * 灰度 mode 与布尔同行（launch.md「On demand: activation」）：只在开启时写，且只在布尔也在写时
 * 写——mode 单独出现对 CLI 没有意义。旧 CLI strict schema 不认时经 compat 省略，按 alwaysOn 行事。
 */
function buildDynamicWorkflowModeField(
  params: { dynamicWorkflowEnabled?: boolean; dynamicWorkflowMode?: DynamicWorkflowMode },
  omittedFields: ReadonlySet<SessionCreateCompatField | SessionResumeCompatField>,
): { dynamicWorkflowMode?: DynamicWorkflowMode } {
// 只有 enabled 与 mode 同时存在且都未被兼容层省略时才下发，避免出现「有 mode 无开关」的半截状态。
// 归一结果为空对象时，调用方展开后不会向请求体注入任何 dynamicWorkflow 字段。
  return params.dynamicWorkflowEnabled === true &&
    params.dynamicWorkflowMode !== undefined &&
    !omittedFields.has("dynamicWorkflowEnabled") &&
    !omittedFields.has("dynamicWorkflowMode")
    ? { dynamicWorkflowMode: params.dynamicWorkflowMode }
    : {};
}

// resume 与 create 的字段差集是有意的：mode/model/persistence/importedHistory/titleGeneration
// 都已持久化在 session 上，恢复时再发会把「已存值」与「请求值」变成两个权威。
// 共同点：workspace/additionalDirectories 必须重发，因为它们是进程级上下文而非 session 属性。
function buildSessionResumeParams(
  params: ZCodeAgentResumeSessionParams & {
    offPeakToolEnabled?: boolean;
    dynamicWorkflowEnabled?: boolean;
    dynamicWorkflowMode?: DynamicWorkflowMode;
  },
  omittedFields: ReadonlySet<SessionResumeCompatField> = new Set(),
) {
  return {
    sessionId: params.sessionId,
    additionalDirectories: params.additionalDirectories,
    workspace: buildWorkspaceRef(params),
    ...(params.thoughtLevel !== undefined && !omittedFields.has("thoughtLevel")
      ? { thoughtLevel: params.thoughtLevel }
      : {}),
    // 冷恢复可能重建 runtime，MCP 必须随 resume 再下发一次，否则新 runtime 是空 MCP 配置。
    // 冷恢复 session 时 app-server 可能重新创建 runtime；MCP 同样需要随 resume 请求下发。
    ...(params.mcpServers !== undefined && !omittedFields.has("mcpServers")
      ? { mcpServers: params.mcpServers }
      : {}),
    // 工具面约束必须与 create 对齐：resume 丢失 allow/deny 会让 CUA 会话重新看到被禁工具，
    // 这是安全隔离问题，不是体验问题。
    // 工具面约束必须和 create 路径一致随 resume 下发，否则冷恢复重建 runtime 后会丢失 allow/deny
    // 隔离（CUA 会话会重新可见 Bash 等被禁工具）。旧 app-server 不认时经 omittedFields 降级。
    ...(params.toolAllowlist !== undefined && !omittedFields.has("toolAllowlist")
      ? { toolAllowlist: params.toolAllowlist }
      : {}),
    ...(params.toolDenylist !== undefined && !omittedFields.has("toolDenylist")
      ? { toolDenylist: params.toolDenylist }
      : {}),
    // resume 不带 offPeak/dynamicWorkflow flag 会让冷恢复丢掉对应工具簇：
    // 与 toolAllowlist 同因（runtime 重建），因此同样受 omittedFields 门控以便旧 CLI 降级。
    // resume 不带该 flag 会让冷恢复丢 Off-Peak 工具面（与 toolAllowlist 同因）。
    ...(params.offPeakToolEnabled === true && !omittedFields.has("offPeakToolEnabled")
      ? { offPeakToolEnabled: true }
      : {}),
    // 同因：resume 不带该 flag 会让冷恢复丢掉工作流工具簇。
    ...(params.dynamicWorkflowEnabled === true && !omittedFields.has("dynamicWorkflowEnabled")
      ? { dynamicWorkflowEnabled: true }
      : {}),
    ...buildDynamicWorkflowModeField(params, omittedFields),
  };
}

// send 参数里 modelSelection/modelExecution 不受 omittedFields 门控：
// 执行身份与约束不是「可忽略的兼容字段」，旧 Worker 不支持时必须失败。
// 静默剥掉这两个字段会让消息在错误的模型/执行策略下运行，产出不可追溯：
// INV-05 只允许「能力降级」，不允许「语义降级」。
function buildSessionSendParams(
  params: ZCodeAgentSendPromptParams,
  omittedFields: ReadonlySet<SessionSendCompatField> = new Set(),
) {
  return {
    sessionId: params.sessionId,
    // 执行身份/约束不是可忽略的兼容字段；旧 Worker 不支持时必须失败，不能静默剥掉。
    ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
    ...(params.modelExecution ? { modelExecution: params.modelExecution } : {}),
// inputId 是重试身份，和 queryId 一样无条件传，不能进入兼容省略集合。
    inputId: params.inputId,
    queryId: params.queryId,
    content: params.content,
// attachments 保持原数组引用，不在这里做序列化或截断。
    attachments: params.attachments,
    ...(params.browserAmbientContext !== undefined && !omittedFields.has("browserAmbientContext")
      ? { browserAmbientContext: params.browserAmbientContext }
      : {}),
    // expectedRevision / expectedProviderRevision 无条件传：这是乐观并发控制的前提。
    // 省略它们会让 CLI 接受基于旧 revision 的写入，表现为用户输入被追加到错误的分支上。
    expectedRevision: params.expectedRevision,
    expectedProviderRevision: params.expectedProviderRevision,
    ...(params.automationId !== undefined && !omittedFields.has("automationId")
      ? { automationId: params.automationId }
      : {}),
    ...(params.offPeakTaskId !== undefined && !omittedFields.has("offPeakTaskId")
      ? { offPeakTaskId: params.offPeakTaskId }
      : {}),
    ...(params.offPeakRunType !== undefined && !omittedFields.has("offPeakRunType")
      ? { offPeakRunType: params.offPeakRunType }
      : {}),
    ...(params.botDeliveryTarget !== undefined && !omittedFields.has("botDeliveryTarget")
      ? { botDeliveryTarget: params.botDeliveryTarget }
      : {}),
// omittedFields 是兼容重试的差集；undefined 与「显式省略」在这里结果相同。
    ...(params.toolDenylist !== undefined && !omittedFields.has("toolDenylist")
      ? { toolDenylist: params.toolDenylist }
      : {}),
  };
}

// compact 只允许这四个参数过线：它是破坏性的上下文重写操作，
// 任何额外字段都会扩大影响面，因此不做透传、也不提供兼容扩展位。
function buildSessionCompactParams(params: ZCodeAgentCompactParams) {
// 逐字段白名单构造，而不是展开 params：compact 是破坏性操作，多余字段一律不过线。
  return {
    sessionId: params.sessionId,
    inputId: params.inputId,
    instructions: params.instructions,
// revision 是 compact 的并发前提，缺省时也必须显式传递 undefined 而不是丢弃键。
    expectedRevision: params.expectedRevision,
  };
}

// 日志用字符串拼接而不是 JSON.stringify：modelSelection.options 里可能塞着用户偏好，
// 整体序列化会把无关字段带进日志。这里只保留 provider/model/reasoning 三元组。
function formatModelSelectionForLog(ref: ModelSelection | undefined): string | null {
// 缺省选择直接记 null，避免把 undefined 或空串混进日志的模型字段。
  if (!ref) {
    return null;
  }

// 只拼 provider/model，不触碰 options 里的其它偏好项，减少日志暴露面。
  const base = `${ref.providerId}/${ref.modelId}`;
  const reasoningLevel = ref.options?.reasoningLevel;
  return reasoningLevel ? `${base}${ZCODE_MODEL_REASONING_SEPARATOR}${reasoningLevel}` : base;
}

// 用 NUL (\u0000) 做分隔符：workspaceKey 可能是路径或 identity，sessionId 可能是 UUID，
// 两者都可能含冒号/斜杠；NUL 不可能出现在路径或 ID 中，是唯一不会产生歧义的分隔符。
function sessionEventKey(params: ZCodeAgentSessionTarget): string {
  return `${resolveWorkspaceKey(params)}\u0000${params.sessionId}`;
}

// Set + 数组双结构的职责：Set 负责 O(1) 去重，数组负责淘汰顺序（JS Set 保留插入序但
// 无法在下标层面裁剪）。返回 false 表示重复事件，调用方必须直接丢弃而不只是跳过记录。
// [资源] 淘汰时同时从 Set 与数组删除，任何一侧漏删都会让集合「看起来有界、实际泄漏」。
function rememberBoundedEventId(ids: Set<string>, order: string[], eventId: string): boolean {
// Set 命中说明事件已处理过，返回 false 让调用方彻底丢弃，而不是重复投递。
  if (ids.has(eventId)) {
    return false;
  }
// 两侧同步登记：Set 提供 O(1) 查询，数组维护插入顺序供后续淘汰。
  ids.add(eventId);
  order.push(eventId);
// 超出上限时从最旧的一端淘汰，同时删除 Set 中的对应键，保持两结构一致。
  while (order.length > MAX_TRACKED_SESSION_EVENT_IDS) {
    const removed = order.shift();
    if (removed) {
      ids.delete(removed);
    }
  }
  return true;
}

// 三个 request key 都复用 sessionEventKey 再拼 requestId：requestId 只在单个 session 内唯一，
// 跨 session 直接用 requestId 做 key 会让两个会话的同类请求互相覆盖。
function permissionRequestKey(params: ZCodeAgentSessionTarget & { requestId: string }): string {
  return `${sessionEventKey(params)}\u0000${params.requestId}`;
}

function userInputRequestKey(params: ZCodeAgentSessionTarget & { requestId: string }): string {
  return `${sessionEventKey(params)}\u0000${params.requestId}`;
}

function providerRuntimeHeadersRequestKey(
  params: ZCodeAgentSessionTarget & { requestId: string },
): string {
  return `${sessionEventKey(params)}\u0000${params.requestId}`;
}

// 只读选择投影：本地 Worker 持有完整 Registry，Host 用这份投影判断「能否启动」，
// 绝不把它扩张成 runtimeModel 去覆盖 Worker 的执行事实源（INV-01 的模型侧推论）。
/**
 * 进程级 Provider Registry 的只读选择投影。
 *
 * 本地 Worker 自己持有完整 Registry；Host 只用这份投影判断模型执行是否可以启动，
 * 不能再把它扩张成 runtimeModel 并覆盖 Worker 的执行事实源。
 */
interface ModelSelectionReadinessSource {
  getView(): Promise<ModelSelectionView>;
  onDidChange?: (listener: (view: ModelSelectionView) => void) => IDisposable;
}

// providerCount 与 revision 一起返回：调用方既要判断就绪，也要能把「这份判断」
// 与后续事件里的 revision 对齐；只给 ready 布尔会让热更新无法去重。
interface ZCodeAgentProviderReadinessSnapshot {
  readonly providerCount: number;
  readonly revision: string;
  readonly readiness: {
    readonly ready: boolean;
    readonly providerId?: string;
    readonly modelId?: string;
  };
}

// 取「第一个有模型的 provider」即视为 ready：这里回答的是「能不能启动执行」，
// 不是「该选哪个模型」。若遍历全部 provider 求交集，一个配置损坏的 provider
// 就会把整个 workspace 判成未就绪。
// [权衡] 顺序敏感：providers 顺序即优先级，视为与 Selection View 的语义一致。
function createProviderReadinessSnapshotFromSelectionView(
  view: ModelSelectionView,
): ZCodeAgentProviderReadinessSnapshot {
// 顺序遍历而非全量扫描：满足第一个可用 provider 就立即返回，减少无关读取。
  for (const provider of view.providers) {
    const model = provider.models[0];
// 该 provider 没有模型就继续看下一个，不把它记成「未就绪」。
    if (!model) continue;
    return {
      providerCount: view.providers.length,
      revision: `model-selection:${view.revision}`,
      readiness: {
        ready: true,
        providerId: provider.providerId,
        modelId: model.modelId,
      },
    };
  }
// 全部 provider 都无模型才落到这里；providerCount 仍然如实上报，便于上层区分「没配」与「配了但不可用」。
  return {
    providerCount: view.providers.length,
    revision: `model-selection:${view.revision}`,
    readiness: { ready: false },
  };
}

// starting 让同一 workspace 的并发启动合并成一次：多个 attach 同时到达时，
// 每个都 spawn 一个进程会互相抢占 stdio。cancelled 则让 dispose 后的等待者立刻退出（INV-12）。
interface WaitingWorkspaceStartup {
  cancelled: boolean;
  lastLoggedRevision?: string;
  starting?: Promise<ZCodeProtocolClient>;
  workspace: ZCodeAgentWorkspaceTarget;
}

// 四个字段的归属：client 是本代进程句柄；interactionPreferencesReady 是 CLI 进程内存态
// 的就绪 Promise；modelExecutionEnabled 记录「本进程是否曾通过 provider/model 门禁」，
// 一旦置真不会回退；dynamicWorkflowPolicyMode 是本进程当前生效的策略快照。
// 除 client 外都只是缓存，不作为对外事实源广播。
interface ActiveWorkspaceClient {
  client: ZCodeProtocolClient;
  interactionPreferencesReady?: Promise<void>;
  /**
   * 只记录该进程生命周期内是否曾通过 provider/model 启动门禁。
   * 只读 topic 可以先启动 CLI，但不能因此让后续 create/command 绕过门禁。
   */
  modelExecutionEnabled: boolean;
  workspace: ZCodeAgentWorkspaceTarget;
  /**
   * 该 CLI 进程当前持有的动态工作流策略（launch.md「The user's choice」）。CLI 启动时缺省关闭，
   * 只在 workspace/updateDynamicWorkflowPolicy 成功后更新；重同步据此跳过没有变化的请求。
   */
  dynamicWorkflowPolicyMode: DynamicWorkflowMode;
}

// 这些命令都会消费模型或 Provider，必须先完成 Registry 刷新再下发：
// 漏掉任一命令，用户切模型后就会用旧 Registry 校验新配置，表现为「切换成功但模型未变」。
// [权衡] 刷新是串行屏障，会给这些命令增加一次往返；换来的是切换语义确定。
function requiresProviderRegistryRefresh(commandType: string): boolean {
  // Bug 原因：模型切换遗漏刷新屏障，会用存量 Worker 的旧 Registry 校验新下发的 Provider。
  // 复用同一刷新队列，成功后才下发切换命令，失败则直接拒绝本次切换。
// 白名单之外一律不刷新：读命令与幂等状态查询不需要这个串行屏障。
  switch (commandType) {
    case "createSession":
    case "createSelectionSideSession":
    case "sendText":
    case "sendGoalCommand":
    case "compact":
    case "forkAssistant":
    case "editUserQuery":
    case "retryTurn":
    case "sendQueuedNow":
    case "switchModelConfig":
      return true;
    default:
      return false;
  }
}

// 稳定 code + workspaceKey 两个附加字段：调用方按 code 分支决定「重试启动 or 报错」，
// workspaceKey 让上层能定位到具体 workspace，而无需解析 message（INV-05）。
function createRuntimeUnavailableError(params: ZCodeAgentWorkspaceTarget): Error & {
  code: typeof ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
  workspaceKey: string;
} {
  const error = new Error("ZCode Agent runtime is not running.") as Error & {
    code: typeof ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
    workspaceKey: string;
  };
// code 固定为常量，上层用相等比较分支，不解析 message 文本。
  error.code = ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE;
// workspaceKey 与入参走同一套 resolve 逻辑，保证与其它接口的键一致。
  error.workspaceKey = resolveWorkspaceKey(params);
  return error;
}

// 选项里的每个端口都遵循「缺省即降级」：不注入不等于报错，而是对应能力关闭或走安全默认。
// 装配层（desktop host / web / 纯 CLI）通过注入哪些端口来表达自身形态。
interface CreateZCodeAgentServiceOptions extends Omit<
  ZCodeAgentProcessManagerOptions,
  "idleTimeoutMs"
> {
  // mcpStatusIdleTimeoutMs 从通用选项中挑出来单独命名：空闲回收只对 MCP 状态探测 lane 生效，
  // 若把它传给会话进程，长时间思考的会话会被当作空闲回收，用户侧表现为进程无故消失。
  /** 仅供 MCP 状态探测进程使用，不能把空闲回收传给 chat。 */
  // 缺省值在工厂里落到 MCP_STATUS_LANE_IDLE_TIMEOUT_MS，这里保持可选，
  // 让测试可以注入毫秒级值而不必等待五分钟。
  mcpStatusIdleTimeoutMs?: number;
  accountProviderConfigSource?: ProviderSource<AccountProviderConfigSnapshot>;
  accountRequestAuthService?: IAccountRequestAuthService;
  // 授权本地媒体预览：Desktop Host 向 Main 登记精确路径，返回值是已登记/规范化后的路径。
  // 不在这里做路径拼接或校验——身份与授权属于 Main，Host 只做转发。
  /** Desktop Host 请求 Main 登记 Agent 已授权的精确本地视频路径。 */
  authorizeLocalMediaPreviewPath?: (path: string) => Promise<string>;
  // readiness source 是只读投影（见 ModelSelectionReadinessSource 声明）：只用于启动门禁与热同步，
  // 注入方负责提供 revision；Host 不反向写回选择。
  modelSelectionReadinessSource?: ModelSelectionReadinessSource;
  // 子代理运行时配置按 workspace 读取：不同 workspace 可能有不同的模型/工具策略，
  // 缓存成全局值会让多窗口互相污染。
  readSubagentRuntimeConfig?: (workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<SubagentRuntimeConfig>;
  // authority 只有 local/external 两态：external 表示运行时偏好的答案来自远端 Host，
  // 本地不得自行读取设置，否则两个权威会给出不同结果。
  sessionRuntimePreferencesAuthority?: "local" | "external";
  // prepareProjectExecution 把项目执行快照解析留给装配层：Host 不知道项目仓储，
  // 只消费「某个 projectId 当前该用什么执行上下文」。
  prepareProjectExecution?: (
    projectId: string,
  ) => Promise<import("@zcode/shared").ProjectExecutionSnapshot>;
  prepareSessionCreation?: (
    target: ZCodeAgentSessionTarget & {
      projectId: string | null;
      additionalDirectories?: string[];
    },
  ) => Promise<string[]>;
  resolveSessionDirectories?: (target: ZCodeAgentSessionTarget) => Promise<string[]>;
  resolveSessionRuntimePreferences?: (
    scope: ZCodeSessionRuntimePreferencesScope,
  ) => Promise<ZCodeSessionRuntimePreferencesResult>;
  // 契约是「返回时 prompt 必须已被 session 接受」，不是「已入队」：
  // 调用方据此向 UI 回报成功；若实现只把消息塞进队列就返回，UI 会显示已发送而实际可能被拒。
  /** manual run 落库后由当前 host 直接派发；返回时 prompt 必须已被 session 接受。 */
  onAutomationManualRunRequested?: (params: {
    automation: ZCodeAutomation;
    run: ZCodeAutomationRun;
  }) => Promise<void>;
  // offPeak config 一身两职：enabled + 非空 Selection View 构成曝光门，
  // 同时决定缺省 model（白名单末位）与 thoughtLevel（最高档）。
  // 任一缺失即整体关闭——纯 CLI 与 desktop-attached-remote 装配都不传。
  /**
   * Off-Peak 会话内创建。config 同时承担曝光门（enabled && Selection View 非空 →
   * session create/resume 下发 offPeakToolEnabled）与缺省解析（model=白名单末位 /
   * thoughtLevel=最高档）；service 供 offPeak/create、offPeak/list 协议 handler 调用。
   * 两者任一缺省即整体关闭（纯 CLI / desktop-attached-remote 装配不传）。
   */
  resolveOffPeakClientConfig?: () => Promise<OffPeakClientConfig | undefined>;
  // 动态工作流快照：Host 是唯一裁决者，结果既作为 workspace 级事实下发，
  // 也决定 create/resume/v4 是否携带 dynamicWorkflowEnabled，避免 CLI 自行推断灰度。
  /**
   * 动态工作流灰度快照。Host 是唯一裁决者：
   * 结果既作为 workspace 级事实下发给 CLI，也决定 session create/resume/v4 是否带
   * dynamicWorkflowEnabled。缺省不传（纯 CLI 装配）= 永远关闭，与 CLI 缺省一致。
   */
  resolveDynamicWorkflowClientConfig?: () => Promise<DynamicWorkflowClientConfig | undefined>;
  /**
   * 用户选择的读取点（launch.md「The user's choice」）：拥有设置权威的 Host 注入，每次使用时读取
   * 设置文件。desktop-attached remote Host 不注入，改用 desktop 推来的值（syncDynamicWorkflowUserMode）。
   */
  resolveDynamicWorkflowUserMode?: () => Promise<DynamicWorkflowMode | undefined>;
  /** 用户选择同步后交给装配层转发（Desktop Host 推给本窗口的远程 Host）；值取自本机设置。 */
  forwardDynamicWorkflowUserMode?: (mode: DynamicWorkflowMode | undefined) => void;
  // 只 Pick 三个方法：把 off-peak 任务服务的最小依赖面固定下来，
  // 避免整个 service 被协议 handler 顺手拿去用，形成隐式耦合。
  resolveOffPeakTaskService?: () =>
    | Pick<IOffPeakTaskService, "createTask" | "list" | "getCodingPlanSupport">
    | undefined;
  // browser 执行桥缺省时 browser 命令返回 backend_unavailable：能力缺失要显式返回，
  // 不能抛未实现异常，否则上层会把它当成协议故障（INV-06：方法存在不等于对所有 client 暴露）。
  /**
   * browser-use 执行桥：把 agent 的 interaction/browserExecute 反向请求转发到 main
   * （WebContentsView+CDP）。desktop host 装配时注入；缺省（纯 CLI/远控无 main）则
   * browser 命令返回 backend_unavailable，不影响其它功能。
   */
  browserControlExecutor?: BrowserAmbientContextExecutor;
  // channelReply 是反向请求：Agent 需要把回复投递到渠道，由 Host 转给具体连接。
  // 缺省时对应 interaction 一律失败，不会退回「本地直接发」。
  channelReplyExecutor?: (request: ChannelReplyHostRequest) => Promise<ChannelReplyResult>;
  // topicResource 拆成 validator + executor 两步：validator 先于 executor，失败即拒绝，
  // 保证未经校验的资源不会先被上传再被判定非法。
  // 两者都拿到 AbortSignal：上传可能很慢，client 断开时必须能中断。
  topicResourceExecutor?: (
    request: ZCodeTopicResourceReadParams &
      ZCodeAgentWorkspaceTarget & { trace?: ZCodeProtocolTrace },
    signal: AbortSignal,
  ) => Promise<ZCodePromptAttachment>;
  topicResourceValidator?: (
    request: ZCodeTopicResourceReadParams &
      ZCodeAgentWorkspaceTarget & { trace?: ZCodeProtocolTrace },
    signal: AbortSignal,
  ) => Promise<void>;
  // 官方 MCP 身份头解析器是可选端口：Agent 不持有用户身份权威，只能向 Host 索取。
  // 缺省时请求一律 official_auth_unavailable，绝不降级为匿名请求——匿名请求会污染
  // 服务端的配额与审计归属。
  /**
   * 官方 Server MCP 身份头解析器。Agent 进程不持有用户身份权威，
   * 经 interaction/requestOfficialMcpAuthHeaders 向 host 索取本次请求的身份头。
   *
   * 缺省时该请求一律返回 official_auth_unavailable，绝不降级为匿名请求——
   * 例如 standalone CLI 没有 host auth port 的场景。
   */
  officialMcpAuthHeadersResolver?: {
    resolveHeaders(request: {
      mcpKey: string;
      pluginId: string;
      targetOrigin: string;
      workspace: { workspaceIdentity?: string; workspaceKey: string; workspacePath: string };
    }): Promise<
      | { ok: true; headers: Record<string, string> }
      | { ok: false; reason: "official_auth_unavailable" | "official_auth_plan_required" }
    >;
  };
  // Host 是身份权威边界，因此 targetOrigin 的可信校验必须在这里执行：
  // 放在 agent adapter 的 fetch wrapper 等于让被审查方自己当审查者，
  // 而 desktop-attached remote 场景下 agent 恰恰跑在远端。
  // 缺省一律拒绝（fail closed），不退化成「只做 schema 校验就发凭据」。
  /**
   * 官方 MCP 可信 Origin 校验器。**host 是身份权威边界**，因此
   * targetOrigin 的校验必须在这里执行，不能只依赖 agent adapter 的 fetch wrapper——那等于让
   * 被审查方自己当审查者。desktop-attached remote 场景下 agent 跑在远端而 host 持有本地用户身份。
   *
   * 此校验约束凭据请求的目标 origin，不提供逐插件权限控制。
   * HTTP 鉴权由宿主 fetch wrapper 注入，stdio 鉴权会将凭据交给插件进程；后者
   * 必须按受信任的可执行代码管理。服务端仍须校验每次调用的身份、权限和配额。
   *
   * 缺省时一律拒绝（fail closed），不退化为"只做 schema 校验就发凭据"。
   */
  officialMcpTrustedOrigins?: {
    isTrusted(input: { pluginId: string; mcpKey: string; origin: string }): Promise<{
      detail?: string;
      trusted: boolean;
    }>;
  };
  // CUA 状态上报与 PIP 生命周期回调都只消费「已校验、已去重」的 live session event；
  // 门面不再复核事件真伪，避免同一事件被两条路径各自处理一次。
  /** desktop-local Host 注入；只消费已校验、已去重的 live session event。 */
  cuaOperationStateReporter?: CuaOperationStateReporter;
  onCuaPipSessionLifecycle?: (
    workspace: CuaOperationWorkspaceTarget,
    event: Exclude<PipSessionEvent, { kind: "focus-changed" }>,
  ) => void;
}

// 逐字段显式映射而不是 spread：Automation 的内部字段（归属、调度实现细节）不能过线，
// 协议面只暴露 UI 需要展示与操作的部分。新增协议字段时必须在这里显式补一行。
function toProtocolAutomation(automation: ZCodeAutomation) {
  return {
    automationId: automation.automationId,
    title: automation.title,
    cronExpr: automation.cronExpr,
    prompt: automation.prompt,
    modelSelection: automation.modelSelection,
    mode: automation.mode,
    targetTaskId: automation.targetTaskId,
    enabled: automation.enabled,
    lifecycleStatus: automation.lifecycleStatus,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
    runCount: automation.runCount,
    recurring: automation.recurring,
    maxRuns: automation.maxRuns,
    // scheduleRule 必须透传而不是由 cronExpr 反推：cron 无法表达「每 50 小时」这类间隔，
    // 反推会显示成「每小时第 00 分」，是可见的功能错误。
    // 透传权威 scheduleRule；会话卡片必须读到本字段才能展示 cron 无法表达的真实间隔
    // （如每50小时、每40天），否则只能从兼容 cronExpr 推断出「每小时的第00分」等错误展示。
    scheduleRule: automation.scheduleRule,
  };
}

// 协议最小面：不暴露 serverTicketId / providerName / workspace 细节。
// 这些字段属于服务端执行上下文，透出既无 UI 用途，又会把内部标识带进客户端日志。
// queuePosition 只在 >0 时下发，避免「排队中但位置 0」这种歧义状态。
export function toProtocolOffPeakTaskSnapshot(task: {
  offPeakTaskId: string;
  title: string;
  status: "queued" | "paused" | "running" | "completed" | "failed" | "cancelled";
  queuePosition?: number;
  sessionId?: string;
  createdAt: number;
}) {
  // 协议最小面：不暴露 serverTicketId / providerName / workspace 细节。
// 可选字段用条件展开：queuePosition<=0 与空 sessionId 都按「不存在」处理。
  return {
    offPeakTaskId: task.offPeakTaskId,
    title: task.title,
    status: task.status,
    ...(typeof task.queuePosition === "number" && task.queuePosition > 0
      ? { queuePosition: task.queuePosition }
      : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    createdAt: task.createdAt,
  };
}

// 这两个常量是稳定错误码与固定文案：文案可以翻译，code 不能改；
// 客户端按 code 做分支与埋点，改动会让历史统计断层。
export const OFF_PEAK_INTERNAL_ERROR_CODE = "offpeak_internal_error";
export const OFF_PEAK_INTERNAL_ERROR_MESSAGE = "Internal off-peak service error";

// [失败路径] 兜底 catch 只回固定 code + 通用文案：跨层异常文本（SQLite 语句、文件路径、
// 上游响应片段）会进入 CLI 日志甚至模型上下文。原始错误只写服务端日志。
// 业务失败（如 model_not_allowed）仍走 respond({ok:false})，不经过这里。
/**
 * offPeak/create、offPeak/list 的兜底 catch 不得把跨层异常文本（SQLite/文件路径/
 * 上游响应片段）原样回传协议——它会进入 CLI 日志与模型可见错误。原始错误只进服务端日志，
 * 对外固定稳定错误码 + 通用文案；业务失败分类仍走 respond({ok:false}) 不经此处。
 */
async function respondOffPeakInternalError(
  client: Pick<ZCodeProtocolClient, "respondError">,
  request: { id: ZCodeProtocolRequestId; method: string },
  workspace: ZCodeAgentWorkspaceTarget,
  error: unknown,
): Promise<void> {
// 先记日志再回错误：即使 respondError 因连接已断而失败，也能留下原始错误现场。
  logger.warn(undefined, "Off-peak 协议请求处理失败", {
    method: request.method,
    workspaceKey: resolveWorkspaceKey(workspace),
    errorName: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
  });
// 统一回 -32603 内部错误 + 稳定 errorCode，不把原始异常文本透给 CLI 端。
  await client.respondError(request.id, {
    code: -32603,
    message: OFF_PEAK_INTERNAL_ERROR_MESSAGE,
    data: { errorCode: OFF_PEAK_INTERNAL_ERROR_CODE },
  });
}

// enabled !== true 一律返回空数组：这里必须用严格比较而不是 truthy，
// 因为 undefined（未装配）与 enabled:false（显式关闭）都表示不可创建，
// 若用真值判断，未来加入 enabled:"partial" 之类取值会被当成开启。
/** D49-8/SG-02：只有灰度有效开启且白名单非空才算"可创建"；其余一律视为关闭（空数组）。 */
export function resolveOffPeakAllowedModels(
  grayConfig: OffPeakClientConfig | undefined,
  providerId?: string,
): readonly string[] {
// 严格比较 true：undefined（未装配）与 false（显式关闭）都返回空白名单。
  if (grayConfig?.enabled !== true) return [];
  return grayConfig.modelSelectionView.providers
    .filter((provider) => providerId === undefined || provider.providerId === providerId)
    .flatMap((provider) => provider.models.map((model) => model.modelId));
}

// 省略 model 时取白名单末位：产品口径是「服务端顺序末位≈最新最强」。
// 显式值做 trim + 大小写不敏感匹配，但返回白名单里的原写法，
// 避免下游拿到大小写变体后又与 Registry 做一次大小写敏感比较。
// [失败路径] 未命中返回 null，由调用方转 model_not_allowed，不在这里抛错。
/**
 * model 解析：省略 → 白名单末位（服务端顺序末位≈最新最强）；显式 → trim + 大小写不敏感匹配，
 * 命中返回白名单原写法，未命中返回 null（调用方回 model_not_allowed）。
 */
export function resolveOffPeakCreateModel(
  allowedModels: readonly string[],
  requested: string | undefined,
): string | null {
// trim 后再判空：只有空白字符的显式值按「未指定」处理，回落到白名单末位。
  const wanted = requested?.trim();
  if (!wanted) return allowedModels[allowedModels.length - 1] ?? null;
  const lower = wanted.toLowerCase();
  return allowedModels.find((model) => model.trim().toLowerCase() === lower) ?? null;
}

// 复用 completeNewModelSelection 做公共最高档补全：旧的 metadata/型号特判会偏离
// values 的语义顺序。显式 thoughtLevel 覆盖 options，但不改 provider/model。
/**
 * 新工具任务复用公共最高档补全；旧 metadata/型号特判会偏离 values 的语义顺序。
 * 显式档位留给 createTask 的现有校验，不在入口擅自换档。
 */
export function resolveOffPeakToolSelection(
  view: ModelSelectionView,
  providerId: string,
  modelId: string,
  thoughtLevel?: string,
): ModelSelection | undefined {
// 复用公共补全逻辑：不在 Off-peak 侧重新推导 options，避免与正常创建路径分叉。
  const selection = completeNewModelSelection(view, { providerId, modelId });
// 补全失败（provider/model 不在 view 中）返回 undefined，由调用方转成协议错误。
  if (!selection) return undefined;
  return thoughtLevel === undefined
    ? selection
    : { ...selection, options: { reasoningLevel: thoughtLevel } };
}
// 工厂返回的服务对象额外暴露 disposeAllAndWait：dispose 是「发出关闭」，
// 测试与退出路径需要的是「等到进程真正退出」，否则会残留子进程句柄。
// 它不参与 IZCodeAgentService 的协议面，只给装配层使用。
/**
 * 创建 Host 侧 ZCode Agent 服务。
 *
 * 构造时注入 transport、session/connection scope、plugin/MCP/skill 等端口；
 * 返回的服务对象是 app-facing 门面，不直接在内部保存 conversation 状态。
 *
 * 维护约束：
 *   - 任何"订阅/ attachment"都必须绑定 connectionId + clientMode，
 *     并在 dispose 时释放对应订阅；
 *   - 新增方法先确认它的状态归属（CLI / Host / UI），再决定放哪一层；
 *   - 远端/移动端可见能力必须同步 channel allowlist。
 */
// 工厂不注册全局单例：每次 create 得到独立的 processManager 与全部 Map，
// 便于测试隔离；「一个窗口一个 Host」的唯一性由装配层保证。
export function createZCodeAgentService(
  options?: CreateZCodeAgentServiceOptions,
): IZCodeAgentService & { disposeAllAndWait(): Promise<void> } {
  // processManager 是所有会话进程的唯一所有者；门面只持有它的句柄与订阅，
  // 不缓存子进程本身，避免出现「谁该 kill」的第二个答案（INV-01 的资源侧）。
  const processManager = new ZCodeAgentProcessManager(options);
  // tracker 只在注入了 reporter 或 PIP 回调时创建：两个消费方都没有时，
  // 创建它只会白养一个 workspace→turn 的 Map（INV-11：元数据必须有界且有人消费）。
  // Windows indicator 与 macOS producer lifecycle client 共用已校验、去重的 sideband facts。
  const cuaOperationTurnTracker =
    options?.cuaOperationStateReporter || options?.onCuaPipSessionLifecycle
      ? createCuaOperationTurnTracker({
          ...(options?.cuaOperationStateReporter
            ? { reporter: options.cuaOperationStateReporter }
            : {}),
          ...(options?.onCuaPipSessionLifecycle
            ? { onPipSessionLifecycle: options.onCuaPipSessionLifecycle }
            : {}),
          logger: {
            debug: (message) => cuaOperationLogger.debug(undefined, message),
            info: (message) => cuaOperationLogger.info(undefined, message),
            warn: (message) => cuaOperationLogger.warn(undefined, message),
          },
        })
      : undefined;
  // AutomationRepo 与 automationTaskIndexRepo 各自持有 tasks-index.sqlite 连接，
  // disposeAll 必须同时收口；漏一个会让测试进程因句柄未释放而无法退出。
  // 注意：task 行集合仍由 tasks-index 持有，这里只是连接方，不复制事实（INV-10）。
  // AutomationRepo 也持有 tasks-index.sqlite 连接，disposeAll 需一并收口（见下方 disposeAll 注释）
  // AutomationService 只依赖 repo 与可选的 prepareProjectExecution，
  // 不注入模型/会话对象，保证定时任务派发仍走统一入口而不是绕过门面。
  const automationRepo = new AutomationRepo();
  const automationService = new AutomationService(automationRepo, options?.prepareProjectExecution);
  const automationTaskIndexRepo = new TaskIndexRepo();
  // 插件控制面独立进程管理器：插件安装/卸载的网络与磁盘操作不能与会话 stdio 共用队列。
  // 这里只传必须与会话进程保持一致的装配参数（命令解析、presentation、spawn 准入）。
  const pluginProcessManager = new ZCodeAgentProcessManager({
    commandResolver: options?.commandResolver,
    presentationSurface: options?.presentationSurface,
    // [权衡] 插件控制面沿用默认 lane 与默认超时，而不是复用 mcp-status 的短空闲回收：
    // 插件操作可能长达数分钟，过早空闲回收会导致操作中途进程消失。
    requestTimeoutMs: options?.requestTimeoutMs,
    resolveSpawnEnv: options?.resolveSpawnEnv,
    waitForSpawnAdmission: options?.waitForSpawnAdmission,
  });
  // [权衡] mcp-status 单独一条 lane：多一个进程，换来控制面不被 mcp/list 的慢握手阻塞。
  // 代价是控制面探测多一次 spawn，收益是会话队列永远不会被探针占住。
  // 合并时误删了独立进程：mcp/list 的慢握手会堵住串行 stdio 队列，连带卡住插件卸载。
  // 恢复专用控制面进程及空闲回收；共享 workspace 路径，不共享请求队列或 watchdog。
  const mcpStatusProcessManager = new ZCodeAgentProcessManager({
    commandResolver: options?.commandResolver,
    presentationSurface: options?.presentationSurface,
    processLifecycleReporter: options?.processLifecycleReporter,
    requestTimeoutMs: options?.requestTimeoutMs,
    resolveSpawnEnv: options?.resolveSpawnEnv,
    waitForSpawnAdmission: options?.waitForSpawnAdmission,
    lane: "mcp-status",
    idleTimeoutMs: options?.mcpStatusIdleTimeoutMs ?? MCP_STATUS_LANE_IDLE_TIMEOUT_MS,
  });
  // sessionEmitters 的 key 由 sessionEventKey 生成（workspaceKey + NUL + sessionId），
  // 只用于 fan-out 已投影的事件，不存任何会话内容（INV-01 / INV-04）。
  const sessionEmitters = new Map<string, Emitter<ZCodeAgentServiceEvent>>();
  // 审计去重器的内存上界是「每个 (pluginId, mcpKey, workspaceKey) 一条」，
  // 三元组数量由已安装插件 × workspace 数决定，不会随消息量增长。
  /**
   * 已经记过"首次发放官方身份头"审计日志的 (pluginId, mcpKey, workspaceKey)。
   *
   * 存在理由：成功路径不能只记 debug——生产构建的最低级别是 Info，事后无法回答
   * "凭据被哪个插件取走过"。但每次 initialize / tools\_list / tools\_call 都会触发一次发放，
   * 全量记 info 就是消息量级的日志膨胀。折中：每个三元组只在本进程内首次发放时记一条 info，
   * 之后仍走 debug。审计线索到"哪个插件、哪个 workspace、什么时候第一次拿"这个粒度。
   */
  const officialMcpIssuanceAudit = createOfficialMcpIssuanceAudit();
  // 两个 runtime headers emitter 按 workspaceKey 分表：取消帧必须只发给关心该 workspace 的订阅者，
  // 用全局 emitter 会把 requestId 广播给其他 workspace（requestId 只在会话内唯一）。
  const providerRuntimeHeadersWorkspaceEmitters = new Map<
    string,
    Emitter<ZCodeProviderRuntimeHeadersRequestParams>
  >();
  const providerRuntimeHeadersCancelledEmitters = new Map<
    string,
    Emitter<ZCodeProviderRuntimeHeadersCancelled>
  >();
  // [并发] 先 delete 再 fire：晚订阅者不会看到已取消的请求而重新启动校验；
  // 重复取消时第二次 delete 是空操作，fire 仍会执行一次——订阅方必须容忍幂等取消。
  function cancelProviderRuntimeHeaders(
    key: string,
    pending: PendingProviderRuntimeHeadersRequest,
  ): void {
    pendingProviderRuntimeHeaders.delete(key);
// 解构出身份字段用于事件载荷，不在这里修改 pending 里的原始请求对象。
    const { requestId, sessionId, workspace } = pending.request;
    // 先删除再投递，确保晚订阅不会重新启动已取消的请求校验。
    providerRuntimeHeadersCancelledEmitters
      .get(resolveWorkspaceKey(workspace))
      ?.fire({ requestId, sessionId, workspace });
    logger.info(undefined, "请求校验已取消", {
      requestId,
      sessionId,
      workspaceKey: resolveWorkspaceKey(workspace),
    });
  }
  // 运行时偏好请求用全局 emitter：请求自带 scope（session/workspace），
  // 按 workspace 分表反而要在 scope 解析前后各查一次。
  const sessionRuntimePreferencesRequestEmitter =
    new Emitter<ZCodeAgentSessionRuntimePreferencesRequest>();
  // 三个资源采样 emitter 都是只读观测面：消费方是诊断面板，
  // 事件高频但不参与调度，任何写操作都不应挂在这里。
  const processResourceSampleEmitter = new Emitter<AgentLaneResourceSample>();
  const toolExecResourceEmitter = new Emitter<ZCodeToolExecResource>();
  const mcpResourceSamplesEmitter = new Emitter<ZCodeMcpResourceSample[]>();
  const mcpTelemetryEmitter = new Emitter<ZCodeMcpTelemetryEvent>();
  // 插件操作进度按 workspace 分：进度通知量大，且只对发起操作的窗口有意义。
  const pluginOperationProgressEmitters = new Map<
    string,
    Emitter<ZCodePluginOperationProgressNotification>
  >();
  // 一个 workspace 的所有 topic 共用同一条 emitter：按 topic 再分表会让同一帧
  // 在多处登记，关闭时需要逐表清理，反而容易漏（串行 fan-out 的开销可忽略）。
  // v4 conversation 帧 fan-out：workspace 级 emitter，renderer 侧按 topic 自行路由。
  const conversationFrameEmitters = new Map<string, Emitter<ConversationTopicWireCandidate>>();
  // 本机首 token 事实与 conversation 遥测都带 workspaceKey：二者是观测数据，
  // 不参与会话状态机，失败丢弃即可。
  const localTtftFactsEmitter = new Emitter<{ workspaceKey: string; facts: LocalTtftFacts }>();
  const conversationTelemetryFactEmitters = new Map<string, Emitter<ConversationTelemetryFact>>();
  // off-peak 生命周期按 workspace 分：任务状态变化只影响该 workspace 的 UI。
  const offPeakLifecycleEmitters = new Map<string, Emitter<OffPeakLifecycleNotification>>();
  // plugin UI 工具结果用全局 emitter 但事件自带 workspace target：
  // 谁能收到由 channel allowlist 决定，不由「有没有订阅这个 Map」决定（INV-06）。
  const pluginUiToolResultEmitter = new Emitter<
    PluginUiToolResultNotification & ZCodeAgentWorkspaceTarget
  >();
  // CUA 权限观察是 app 级事实（一次系统授权影响所有会话），因此不按 workspace 分表。
  const cuaPermissionObservationEmitter = new Emitter<ZCodeAgentCuaPermissionObservation>();
  // sessions-index 与 workspace-config 复用同一条 conversationFrame 通知，按 topic 前缀分流；
  // 三个 emitter 必须用同一套 topic 常量，否则前缀匹配会漏投。
  // sessions-index 帧 fan-out：与 conversation 同一 conversationFrame 通知，按 topic 前缀分流到此 emitter。
  const sessionsIndexFrameEmitters = new Map<string, Emitter<SessionsIndexTopicWireCandidate>>();
  // workspace-config 帧 fan-out：配置目录活性（task-index syncer 消费），同一通知按前缀分流。
  const workspaceConfigFrameEmitters = new Map<
    string,
    Emitter<WorkspaceConfigTopicWireCandidate>
  >();
  // v4ConnectionId 每个 host process 一个稳定值：同进程重订阅会命中同一 connectionId，
  // 从而由「同 (connectionId, topic) 替换」规则天然实现幂等替换（INV-04）。
  // 不能用 renderer 传入的 id，否则两个窗口可以互相顶掉订阅。
  // v4 订阅替换按 (connectionId, topic) 判定；每个 host process 服务一个
  // renderer 窗口，一个稳定 connectionId 即可让重订阅天然替换旧订阅。
  const v4ConnectionId = `host-${randomUUID()}`;
  // 四个字段即路由键：workspaceKey 定位归属，topic 定位频道，subscriptionId 用于回 ack，
  // connectionId 用于判定「是否同一连接的重订阅」。缺任一字段都无法安全替换旧订阅。
  interface V4SubscriptionRoute {
    workspaceKey: string;
    topic: string;
    subscriptionId: string;
    connectionId: string;
  }
  const v4SubscriptionRoutes = new Map<string, V4SubscriptionRoute>();
  const v4RouteKeyByOwnership = new Map<string, string>();
  // [失败路径] runtime 重启时清空该 workspace 的 v4 路由：新进程没有旧订阅，
  // 留着会让事件按 stale subscriptionId 投递，订阅方永远等不到终态（INV-03）。
  // 同时清 CUA tracker，避免重启后 Windows 提示残留。
  const v4RouteRuntimeRestartDisposable = processManager.onRuntimeRestarted(({ workspaceKey }) => {
    clearV4SubscriptionRoutes(workspaceKey);
    cuaOperationTurnTracker?.clearWorkspaceKey(workspaceKey);
  });
  // 三类容器生命周期不同：sessionEventSequenceStates 按 session key 长期存在；
  // wiredClients 用 WeakSet 只防重复 wiring；clientDisposables 用 WeakMap 让 client
  // 被 GC 时 disposables 自动不可达，但逻辑释放仍靠显式 dispose（见 invalidate）。
  const sessionEventSequenceStates = new Map<string, SessionEventSequenceState>();
  const wiredClients = new WeakSet<ZCodeProtocolClient>();
  const clientDisposables = new WeakMap<ZCodeProtocolClient, IDisposable[]>();
  // 两个 pending 表的值都是 client + protocolRequestId：key 由 sessionEventKey 派生，
  // 因此同 session 内 requestId 唯一即可，跨 session 不会互相覆盖。
  const pendingPermissions = new Map<string, PendingPermissionRequest>();
  const pendingUserInputs = new Map<string, PendingPermissionRequest>();
  // 诊断回调只读 size，不遍历内容：遍历长会话的 pending 表会让诊断本身成为卡顿源。
  // 返回的句柄必须在 dispose 时释放，否则测试之间会残留全局 provider。
  // 内存诊断计数器：只读各 per-session 镜像表的 size。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("agent", () => ({
    sessionEmitters: sessionEmitters.size,
    seqStates: sessionEventSequenceStates.size,
    pendingPermissions: pendingPermissions.size,
    pendingUserInputs: pendingUserInputs.size,
  }));
  // 两个 pending 表都在 client 失效时被清理（invalidateWorkspaceClient）：
  // 只清其中一个会让另一类请求在进程换代后永久悬挂（INV-05 / INV-07）。
  const pendingProviderRuntimeHeaders = new Map<string, PendingProviderRuntimeHeadersRequest>();
  const pendingSessionRuntimePreferences = new Map<
    string,
    PendingSessionRuntimePreferencesRequest
  >();
  // 每个 workspace 只允许一个「当前代」client：多存一个就无法确定谁是权威，
  // 事件也就无法保证只投给活着的进程（INV-03）。
  const activeClientsByWorkspaceKey = new Map<string, ActiveWorkspaceClient>();
  // 交互偏好同步 Promise 是 CLI 进程内存态：换代时必须删除，
  // 否则下一个 client 会误以为「已同步」而跳过（见 invalidateWorkspaceClient 删除该 Promise 的位置）。
  const interactionPreferenceSyncByWorkspaceKey = new Map<string, Promise<void>>();
  // 最近一次 app 运行时偏好：只作为新 client 建立后的同步输入，不是事实源；
  // 真实偏好仍由 app 侧持有并重复推送。
  let latestAppRuntimePreferences: ZCodeAgentAppRuntimePreferences | undefined;
  // 存 Promise 而不是值：单次读取失败后需要允许下次重试；若缓存 undefined 结果，
  // 一次瞬时 IO 失败会让动态工作流在整个进程生命周期内保持关闭。
  /** 服务端「提供」的进程内单次读取；见 resolveDynamicWorkflowGate 的注释。 */
  let dynamicWorkflowOffer: Promise<DynamicWorkflowClientConfig | undefined> | undefined;
  /** desktop 推来的用户选择；只在没有本机设置权威（未注入 resolveDynamicWorkflowUserMode）时使用。 */
  let pushedDynamicWorkflowUserMode: DynamicWorkflowMode | undefined;
  // 串行链：后一步必须在前一步落地后才读取生效模式并发送，否则两次策略更新会乱序到达 CLI，
  // 表现为「用户选了 A，实际生效 B」。
  // 链按 workspaceKey 分，不同 workspace 的策略互不阻塞。
  /** 每个 workspace 的策略同步链：后入队的步骤在前一步落地后才读取生效模式并发送。 */
  const dynamicWorkflowPolicySyncByWorkspaceKey = new Map<string, Promise<void>>();
  // 等待启动表：starting Promise 让并发 attach 合并为一次 spawn；cancelled 让 dispose 之后的
  // 等待者立即退出而不是继续等一个不会来的进程（INV-12）。
  const waitingWorkspaceStartups = new Map<string, WaitingWorkspaceStartup>();
  // 只置标志并删除条目，不在这里 await：调用方（等待者）自己检查 cancelled 后退出，
  // 若在这里等待 Promise，取消动作会被启动耗时阻塞。
  function cancelWaitingWorkspaceStartup(workspaceKey: string): void {
// 取出条目后只置 cancelled：真正的退出由等待者自己检查标志完成。
    const waiting = waitingWorkspaceStartups.get(workspaceKey);
// 条目已不存在说明启动已结束或已被别的取消处理，重复取消是安全的空操作。
    if (waiting) {
      waiting.cancelled = true;
      waitingWorkspaceStartups.delete(workspaceKey);
    }
  }
  // 全量取消只标标志：正在进行的 spawn 无法安全中断，交给等待者放弃结果即可。
  // 清空 Map 是必要的，否则 disposed 之后仍会有人拿到旧条目。
  function cancelAllWaitingWorkspaceStartups(): void {
// 先遍历全部标 cancelled，再统一 clear；顺序反了会让部分等待者拿不到标志。
    for (const waiting of waitingWorkspaceStartups.values()) {
      waiting.cancelled = true;
    }
    waitingWorkspaceStartups.clear();
  }
  // 账号配置的两级状态：sync Promise 负责串行，receivedRevision 负责去重。
  // 二者都用 WeakMap 按 client 绑定，client 不可达时自动释放；
  // 但去重缓存只表示「Host 已交付」，不代表 Worker 的 Registry 已应用（见 accountConfigReceivedRevisionByClient 声明）。
  const accountConfigSyncByClient = new WeakMap<ZCodeProtocolClient, Promise<void>>();
  // 此缓存只去重已交付的账号快照，不表示 Worker 的 Registry 已应用该版本。
  const accountConfigReceivedRevisionByClient = new WeakMap<ZCodeProtocolClient, string>();
  // 会话 trace id 只用于日志关联，不参与调度或恢复；按 sessionEventKey 存，
  const sessionTraceIdBySessionKey = new Map<string, TraceId>();
  const accountRequestAuthService = options?.accountRequestAuthService;
  const accountProviderConfigSource = options?.accountProviderConfigSource;
  const modelSelectionReadinessSource = options?.modelSelectionReadinessSource;
  // 缺省 local：只有装配层显式声明 external 才把运行时偏好的权威交出去，
  // 这样默认行为（本地 Host 自己回答）不需要每个装配点重复声明。
  const sessionRuntimePreferencesAuthority = options?.sessionRuntimePreferencesAuthority ?? "local";
  const resolveSessionRuntimePreferences = options?.resolveSessionRuntimePreferences;

  // [资源] 失效顺序有依赖：先删 pending（含定时器）→ 再释放 clientDisposables →
  // 再判断是否当前代并删索引 → 最后删交互偏好 Promise。
  // 反序会在 pending 清理期间仍有回调写入已删除的 client 订阅。
  function invalidateWorkspaceClient(workspaceKey: string, client: ZCodeProtocolClient): void {
    // 按 client 身份删而不是按 key 前缀删：key 里含 workspaceKey/sessionId，
    // 前缀匹配在 workspaceKey 互为前缀时（如 /a 与 /a/b）会误删别的 workspace 的 pending。
    for (const [key, pending] of pendingPermissions) {
      if (pending.client === client) {
        pendingPermissions.delete(key);
      }
    }
    for (const [key, pending] of pendingUserInputs) {
      if (pending.client === client) {
        pendingUserInputs.delete(key);
      }
    }
    // runtime headers 的 pending 必须走 cancelProviderRuntimeHeaders：
    // 它在删除之外还要向订阅方 fire 取消帧，直接 delete 会让 UI 上的「等待校验」永久转圈。
    for (const [key, pending] of pendingProviderRuntimeHeaders) {
      if (pending.client === client) {
        cancelProviderRuntimeHeaders(key, pending);
      }
    }
    // 必须 clearTimeout：定时器不随 Map 条目消失而停止，
    // 否则 client 已死后定时器仍会触发并尝试向关闭的连接写响应（INV-05）。
    for (const [key, pending] of pendingSessionRuntimePreferences) {
      if (pending.client === client) {
        clearTimeout(pending.timeout);
        pendingSessionRuntimePreferences.delete(key);
      }
    }
    // WeakMap 只保证 GC 能回收，不保证逻辑释放：这里必须显式遍历 dispose，
    // 否则事件监听会挂在一个已失效的 client 上继续被调用（INV-07）。
    for (const disposable of clientDisposables.get(client) ?? []) {
      disposable.dispose();
    }
    clientDisposables.delete(client);

    // [并发] identity guard 是 INV-03 的核心：runtime 生命周期事件可能与下一代启动交错，
    // active.client !== client 说明这是旧代的迟到清理，直接 return。
    // 去掉这个判断会把新 client 的索引删掉，下一次请求于是重建进程，形成启动风暴。
    const active = activeClientsByWorkspaceKey.get(workspaceKey);
    if (active?.client !== client) {
      // Runtime lifecycle 事件可能与下一代启动交错；旧 client 的迟到清理只能释放
      // 自身绑定，绝不能删除同 workspace 已登记的新 client 与新 runtime 状态。
      return;
    }
    // 只有确认自己是当前代才删索引与交互偏好 Promise；两者必须一起删，
    // 只删索引会让下一个 client 复用旧 Promise，跳过真正的偏好同步。
    activeClientsByWorkspaceKey.delete(workspaceKey);
    // Interaction preference 是 CLI 进程内存态；runtime 换代后即使 app revision
    // 未变化也必须重新同步，不能沿用旧 client 的完成 Promise。
    interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
  }

  // 只处理 unavailable：available 的建立由 client 装配路径负责，
  // 这里若也处理 available，会出现两条建立索引的写入路径。
  const runtimeLifecycleDisposable = processManager.onRuntimeLifecycle((event) => {
    if (event.state !== "unavailable") return;
    // unavailable 是权威边界：协议关闭/崩溃后 CLI 可能不再发 turn-failed 或 session-closed，
    // CUA tracker 不在这里清会让 Windows 顶部提示与 Helper 恢复门控永久残留。
    // 协议关闭、进程崩溃或请求超时时，runtime 可能不会再发送 turn-failed/
    // session-closed，也不一定能成功启动下一代 runtime。必须在 unavailable 这个权威
    // 生命周期边界清掉 CUA tracker，否则 Windows 顶部提示和 Helper 恢复门控会永久残留。
    cuaOperationTurnTracker?.clearWorkspaceKey(event.workspaceKey);
    // 没有 active client 时无事可做：这说明该 workspace 从未成功建立连接，
    // 或已被更早的 unavailable 清理过（重复清理必须是幂等的）。
    const active = activeClientsByWorkspaceKey.get(event.workspaceKey);
    if (!active) return;
    // Process manager 只会为当前 available runtime 发布 unavailable；这里再绑定当前
    // active client 做第二层 identity guard，避免旧 runtime 的迟到回收误伤换代结果。
    invalidateWorkspaceClient(event.workspaceKey, active.client);
  });

  // 没有 accountAccess 或未注入 service 时返回 undefined：两者都表示「本次请求无账号材料」，
  // 调用方据此把 response 标成 headersApplied:false，而不是伪造一份匿名材料。
  async function resolveAccountRequestAuth(
    request: ZCodeProviderRuntimeHeadersRequestParams,
  ): Promise<AccountRequestAuthMaterial | undefined> {
    if (!request.accountAccess || !accountRequestAuthService) {
      return undefined;
    }
    // resolveCurrent 的参数是完整请求上下文（provider/model/accountAccess/expectedScope）：
    // 鉴权解析可能需要判断账号归属与 token 指纹，只传 providerId 会让它无法做拒绝校验。
    return accountRequestAuthService.resolveCurrent({
      providerId: request.providerId,
      modelId: request.modelSelection.modelId,
      accountAccess: request.accountAccess,
      expectedAccountScope: request.expectedAccountScope,
      rejectedProjectTokenFingerprint: request.rejectedProjectTokenFingerprint,
      reason: request.reason,
    });
  }

  // 无交互应答路径：先置 responding 再 await，防止并发的用户交互应答重复 respond。
  // [并发] 异步 IO 返回后必须三次复核 pending 身份（成功、失败、finally 各一次）：
  // 期间请求可能已被取消或被下一代 client 替换，迟到材料不能发给已撤销的请求。
  async function respondAccountRequestAuthWithoutInteraction(params: {
    key: string;
    pending: PendingProviderRuntimeHeadersRequest;
  }): Promise<void> {
    params.pending.responding = true;
    try {
      const requestAuth = await resolveAccountRequestAuth(params.pending.request);
      // 账号解析是异步 IO；取消/进程退出后不能把迟到材料发给已撤销的请求。
      // 这是「取消后不再写」的关键检查：map 里已不是同一个 pending 对象就静默返回，
      // 既不 respond 也不 log 成功，避免向已关闭连接写入或误报已应用。
      if (pendingProviderRuntimeHeaders.get(params.key) !== params.pending) return;
      // 解析器返回空材料属于内部契约破坏，必须走 catch 转成 headersApplied:false，
      // 而不是让 Promise 悬挂：调用方（CLI）在等一个唯一响应（INV-05）。
      if (!requestAuth) {
        throw new Error("Account request auth resolver returned no material");
      }
      // headersApplied:true 是「Host 已应用头」的唯一成功信号，附带 requestAuth 供 CLI 使用；
      // 不要额外加自定义字段，协议 schema 是严格校验的。
      await params.pending.client.respond(params.pending.protocolRequestId, {
        headersApplied: true,
        requestAuth,
      });
      logger.info(undefined, "ZCode provider runtime headers 已应用", {
        modelId: params.pending.request.modelSelection.modelId,
        providerId: params.pending.request.providerId,
        requestId: params.pending.request.requestId,
        sessionId: params.pending.request.sessionId,
        workspaceKey: resolveWorkspaceKey(params.pending.request.workspace),
      });
    // [失败路径] 失败也必须 respond(headersApplied:false)：只记日志会让 CLI 侧 pending
    // 永远等不到应答，最终由更上层超时兜底，表现为模型请求莫名延迟。
    } catch (error) {
      // 与成功路径相同的身份复核：请求已被取消时不再 respond，避免「取消后成功」的矛盾日志。
      if (pendingProviderRuntimeHeaders.get(params.key) !== params.pending) return;
      logger.warn(undefined, "ZCode provider runtime headers 应用失败", {
        modelId: params.pending.request.modelSelection.modelId,
        providerId: params.pending.request.providerId,
        requestId: params.pending.request.requestId,
        sessionId: params.pending.request.sessionId,
        error: error instanceof Error ? error.message : String(error),
        workspaceKey: resolveWorkspaceKey(params.pending.request.workspace),
      });
      await params.pending.client.respond(params.pending.protocolRequestId, {
        headersApplied: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    // [资源] finally 只在仍指向同一个 pending 对象时删除：若期间已被 cancel 删除或替换，
    // 这里再删会误删新请求（key 含 requestId，正常情况下不会重号，但换代后仍有竞态窗口）。
    } finally {
      if (pendingProviderRuntimeHeaders.get(params.key) === params.pending) {
        pendingProviderRuntimeHeaders.delete(params.key);
      }
    }
  }

  // 取出即删除并清定时器：应答只允许生效一次，任何「先应答、后删除」的写法都会给
  // 超时与用户应答同时触发的窗口。
  function takePendingSessionRuntimePreferences(
    requestId: string,
  ): PendingSessionRuntimePreferencesRequest | undefined {
    const pending = pendingSessionRuntimePreferences.get(requestId);
// 已超时或已被取消消费过的请求返回 undefined，调用方据此静默退出。
    if (!pending) {
      return undefined;
    }
// 先摘除再清定时器：重复调用时第二次拿不到条目，不会二次清理同一个 timer。
    pendingSessionRuntimePreferences.delete(requestId);
    clearTimeout(pending.timeout);
    return pending;
  }

  // 超时只结束本次请求，不重试也不降级：运行时偏好缺失时 session 应保持原状，
  // 用默认值强行继续会让用户在不知情的情况下用了错误的偏好。
  function expireSessionRuntimePreferencesRequest(requestId: string): void {
    const pending = takePendingSessionRuntimePreferences(requestId);
    if (!pending) {
      return;
    }
    // 远端 Host transport 仍存活但设置 responder 不返回时，旧 pending
    // respondError 失败只记 debug：连接可能已断，这是预期内的二次失败，
    // 用 warn/error 会在每次断连时制造噪声。错误码 -32022 是稳定协议码。
    // 没有终止条件，会阻塞 Session 生命周期。超时只结束本次请求，不重试或降级。
    logger.warn(undefined, "运行时偏好请求等待 Host 响应超时", {
      event: "zcode_agent.runtime_preferences.host_response_timeout",
      module: "services.zcode_agent",
      requestId,
      scope: pending.request.scope,
      sessionId: pending.request.sessionId,
      timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
      workspaceKey: pending.workspaceKey,
    });
    void pending.client
      .respondError(pending.protocolRequestId, {
        code: -32022,
        message: "Session runtime preferences request timed out",
        data: {
          timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
        },
      })
      .catch((error: unknown) => {
// 超时响应本身失败只记 debug：transport 已断时这是预期结果，不值得升级日志级别。
        logger.debug(undefined, "运行时偏好超时响应发送失败", {
          error: error instanceof Error ? error.message : String(error),
          requestId,
          scope: pending.request.scope,
          sessionId: pending.request.sessionId,
        });
// setTimeout 回调里的超时清理不向外抛异常，后台定时器没有调用方可以承接。
      });
  }

  // 用 let 持有订阅：dispose 时需要 .dispose() 并置空；若用 const，
  // 释放点只能分散在 disposeAll 里再查一次，容易漏（INV-12）。
  let modelSelectionSubscription = modelSelectionReadinessSource?.onDidChange?.((view) => {
// 选择视图变化只触发热同步，不在回调里直接 spawn；真正的启动由等待者自己完成。
    void handleProviderReadinessChanged({
      reason: "model_selection_changed",
      snapshot: createProviderReadinessSnapshotFromSelectionView(view),
    }).catch((error) => {
// 订阅回调不能让 rejection 逃逸到事件总线，这里统一降级为 warn。
      logger.warn(undefined, "model selection readiness 热同步失败", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });
  // 账号 provider 配置的订阅同理：热同步失败只记 warn，不阻断服务创建；
  // 失败后仍保留订阅，等待下一次变更事件自然重试。
  let accountProviderConfigUnsubscribe = accountProviderConfigSource?.onDidChange((reason) => {
// 原因串原样透传，供下游日志区分盘上变更与账号切换；这里不做任何解释。
    void handleAccountProviderConfigChanged(reason).catch((error) => {
// 单个订阅失败只记 warn，订阅本身保留，下一次变更会自然重试。
      logger.warn(undefined, "account provider config 热同步失败", {
        message: error instanceof Error ? error.message : String(error),
        reason,
      });
    });
  });

  // 同步策略三件套：按 client 串行（sync Promise 链）、按 revision 去重、可选刷新 Registry。
  // [并发] 串行不是为了性能，而是为了让「读取快照」与「交付」在职序上与调用顺序一致。
  async function syncAccountProviderConfigToClient(params: {
    client: ZCodeProtocolClient;
    reason: string;
    refreshRegistry?: boolean;
  }): Promise<void> {
    if (!accountProviderConfigSource) return;
    // 上一次失败不能阻断后续同步：这里 catch 掉前序错误后继续，
    // 否则一次瞬时读取失败会让该 client 在整个生命周期内再也收不到配置更新。
    const previous = accountConfigSyncByClient.get(params.client) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // 前一次失败不能阻断后续较新的 Account Config；当前调用会重新尝试。
      })
      .then(async () => {
        // 异步读取放在 then 内部而不是入队前：入队前读取会先花时间再排队，
        // 后来的调用可能以更旧的快照先交付，造成 revision 回退。
        // 排队前异步读取可能晚返回，把旧结果排在新结果之后。读取与交付
        // 共用现有 Client 串行队列；不新增发送屏障，也不按内容 revision 猜测时间先后。
        const snapshot = await accountProviderConfigSource.read();
        // revision 相同则跳过交付，但 refreshRegistry 仍在链上执行：
        // 「配置没变」不代表「Registry 不需要刷新」，两者是独立意图。
        if (accountConfigReceivedRevisionByClient.get(params.client) !== snapshot.revision) {
          const result = await params.client.request(
            zcodeProtocolMethods.providerUpdateAccountConfig,
            {
              revision: snapshot.revision,
              // 用 config.toJSON() 而不是直接传实例：协议面只接受纯数据，
              // 实例上的方法与内部字段过线后会在序列化时变成 undefined 或抛错。
              basedOnZCodeBuiltinRevision: snapshot.basedOnZCodeBuiltinRevision,
              // Account 是运行时事实信封，不是磁盘 Provider 规则集合，因此沿用原协议字典，
              // 不要为了「统一命名」改字段名——CLI 侧按字典严格校验。
              // Account 是运行时事实信封，不是磁盘 Provider 规则集合；保持原有协议字典。
              providers: Object.fromEntries(
                [...snapshot.providers.entries()].map(([providerId, config]) => [
                  providerId,
                  config.toJSON(),
                ]),
              ),
              states: snapshot.states ?? {},
            },
            zcodeProviderUpdateAccountConfigResultSchema,
          );
          // 回执 revision 与交付 revision 不一致直接 throw：说明 CLI 实际应用的是另一版，
          // 若继续记为已同步，后续所有更新都会被去重跳过，配置永久停在旧版本。
          if (result.receivedRevision !== snapshot.revision) {
            throw new Error("Account Config 接收回执版本与交付版本不一致");
          }
          accountConfigReceivedRevisionByClient.set(params.client, result.receivedRevision);
          logger.info(undefined, "account provider config 已交付到 ZCode agent", {
            providerCount: result.providerCount,
            reason: params.reason,
            receivedRevision: result.receivedRevision,
            status: result.status,
          });
        }
        // 刷新必须在交付之后：CLI 先有配置再刷新，否则 Registry 读到的是旧配置，
        // 刷新本身变成一次无效往返。
        if (params.refreshRegistry) {
          await params.client.request(
            zcodeProtocolMethods.providerRefreshRegistry,
            { reason: params.reason },
            zcodeProviderRefreshRegistryResultSchema,
          );
        }
      });
    accountConfigSyncByClient.set(params.client, current);
    // [资源] finally 只删除「自己这一环」：链上可能已排入更新的 Promise，
    // 删错会让后续调用失去串行保证（并发读取 → revision 乱序）。
    try {
      await current;
    } finally {
      if (accountConfigSyncByClient.get(params.client) === current) {
        accountConfigSyncByClient.delete(params.client);
      }
    }
  }

  // 薄包装保留独立函数名：调用点读作「确保已同步」，与「同步一次」的意图不同——
  // 前者允许未来加入短路（例如已知版本一致就跳过），后者不允许。
  async function ensureAccountProviderConfigSynced(params: {
    client: ZCodeProtocolClient;
    reason: string;
    workspace: ZCodeAgentWorkspaceTarget;
    refreshRegistry?: boolean;
  }): Promise<void> {
// 门面层只把 workspace 之外的三个字段照搬给同步函数；
// workspace 不参与同步，保留在签名里是为了调用点上下文一致。
    await syncAccountProviderConfigToClient({
      client: params.client,
      reason: params.reason,
      refreshRegistry: params.refreshRegistry,
    });
  }

  // 所有 active client 并行同步：每个 client 内部串行，client 之间互不阻塞。
  // 单个 client 失败会让 Promise.all reject，调用方（变更订阅）已 catch 并记 warn；
  // 不做逐个重试，避免配置变更抖动时形成重试风暴。
  async function handleAccountProviderConfigChanged(reason: string): Promise<void> {
    await Promise.all(
      // 取快照而非边遍历边 await：Map 可能在 await 期间被 invalidate 修改，
      // Array.from 冻结当前代的 client 列表，保证本轮只处理「此刻活着」的连接。
      Array.from(activeClientsByWorkspaceKey.values()).map(async (active) => {
// 每个 client 走自己的串行队列；map 只负责并发扇出，不合并结果。
        await syncAccountProviderConfigToClient({
          client: active.client,
          reason,
        });
      }),
    );
  }

  // 交互偏好同步的收口入口：把 app 侧偏好按 workspace 串行推给该 workspace 的 CLI。
  // 输入是调用瞬间的偏好快照（调用方已复制），输出是「本节」完成的 Promise。
  // 副作用：最多两次 workspace RPC；不发事件、不落盘。
  // 失败语义：前一次失败不阻断后续节；interaction 失败上抛，model-io 仅降级 -32601。
  // 维护 INV-05：失败必须终止本节但不制造悬挂 Promise，也不能让后续提交静默丢失。
  function enqueueInteractionPreferenceSync(params: {
    client: ZCodeProtocolClient;
    preferences: ZCodeAgentAppRuntimePreferences;
    workspace: ZCodeAgentWorkspaceTarget;
  }): Promise<void> {
    // key 口径必须 workspaceIdentity 优先（INV-02）：同一路径的远程 workspace 若按 path 归并，
    // 两个不同 identity 的 CLI 会共用一条同步链，后写覆盖前写。
    const workspaceKey = resolveWorkspaceKey(params.workspace);
    // 每个 workspace 只保存「链尾 Promise」而不是队列：新节直接挂到当前链尾即按调用顺序执行。
    // 若不串行，用户快速切两次开关时两次 RPC 可能乱序落地，CLI 停在旧值且没有回调可纠正。
    const previous = interactionPreferenceSyncByWorkspaceKey.get(workspaceKey) ?? Promise.resolve();
    // [失败路径] 必须先 catch 再 then：直接 previous.then 会让前一次的 rejection 同步传染，
    // 之后该 workspace 的偏好同步永久 reject，开关再也送不出去。
    const current = previous
      .catch(() => {
        // 前一次失败不能打乱之后开关提交的顺序；当前快照仍需继续尝试。
      })
      // 到这一步才真正发请求：preferences 是调用时的浅拷贝，链节执行期间不再读 app 全局状态。
      .then(async () => {
        // question 自动解析开关是 UI 交互语义的基础，失败必须上抛让调用方记录；
        // 静默吞掉会让 CLI 的自动应答行为与服务端设置长期分离。
        // 本节的 rejection 由 1730 注册的 rejection 分支吸收，不会成为未处理拒绝。
        await params.client.request(
          zcodeProtocolMethods.workspaceUpdateInteractionPreferences,
          {
            workspace: buildWorkspaceRef(params.workspace),
            // 只投影协议白名单字段，不整包透传 app 偏好：CLI 的 strict schema 会拒绝未知字段，
            // 且 host 新增偏好不应隐式改变旧 CLI 行为。
            preferences: {
              askUserQuestionAutoResolutionEnabled:
                params.preferences.askUserQuestionAutoResolutionEnabled,
            },
          },
          zcodeWorkspaceUpdateInteractionPreferencesResultSchema,
        );
        // model-io 保留开关是较新的 method，单独 try 才能只对这一个能力降级；
        // 若与上一条写在同一个 try 里，旧 CLI 的 -32601 会让整节失败，连已成功的 interaction 也被判失败。
        try {
          await params.client.request(
            zcodeProtocolMethods.workspaceUpdateModelIoPreferences,
            {
              workspace: buildWorkspaceRef(params.workspace),
              preferences: {
                fullRetentionEnabled: params.preferences.modelIoFullRetentionEnabled === true,
              },
            },
            zcodeWorkspaceUpdateModelIoPreferencesResultSchema,
          );
        } catch (error) {
          // 新 Host 兼容尚未升级的 CLI：只有 method-not-found 可降级，其他同步失败仍需上抛。
          // [失败路径] 只用 isProtocolMethodNotFoundError 判定降级，不匹配 message 文本（INV-05）；
          // 其它错误（超时、transport 关闭）继续上抛，交给链尾的 rejection 分支记录。
          if (!isProtocolMethodNotFoundError(error)) throw error;
        }
      });
    // [并发] set 必须同步完成：中间若有 await，两个并发调用会读到同一个 previous 各建一条链，
    // 串行保证失效，偏好仍可能乱序落地。
    interactionPreferenceSyncByWorkspaceKey.set(workspaceKey, current);
    // [资源] 链结束后自清理，但必须先比对 map 当前值：并发调用可能已把更新的链写到同一 key，
    // 直接删除会把链尾一起丢掉，后续同步重新从 resolved 起步，尚未落地的顺序被抹平。
    void current.then(
      () => {
// 成功分支同样先比对当前链尾，避免误删后来者挂上的新链。
        if (interactionPreferenceSyncByWorkspaceKey.get(workspaceKey) === current) {
          interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
        }
      },
      () => {
// 失败分支也必须清理链尾，否则该 workspace 的后续同步会永远挂在 rejected Promise 后。
        if (interactionPreferenceSyncByWorkspaceKey.get(workspaceKey) === current) {
          interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
        }
      },
    );
    // 返回本节而不是链尾：调用方只关心自己这份快照是否送达；
    // 后续节由后续调用自己等待，一个慢请求不会串住所有调用方。
    return current;
  }

  // provider readiness 转 ready 时唤醒所有等待中的 workspace 启动。
  // 输入快照的 revision/providerCount 只用于日志与错误数据；副作用是可能拉起进程并
  // 触发账号 provider 配置同步；单个 workspace 失败不能影响其他 workspace（allSettled）。
  // 维护 INV-03（旧 generation 的回调必须失效）与 INV-05（失败必须收敛，不留悬挂启动）。
  async function handleProviderReadinessChanged(event: {
    reason: string;
    snapshot: ZCodeAgentProviderReadinessSnapshot;
  }): Promise<void> {
    // 只在 ready 时唤醒：not-ready 事件不删除 waiting，等待下一次 ready；
    // 否则 provider 短暂重载会把仍在排队的启动直接判死。
    if (event.snapshot.readiness.ready) {
      // [失败路径] allSettled 而非 all：任一 workspace 启动失败都不能让事件回调 reject，
      // 事件总线上的未处理 rejection 会污染进程级错误处理，也不会补偿其他 workspace。
      await Promise.allSettled(
        // 先 Array.from 固化快照再异步处理：回调内部会删改 waitingWorkspaceStartups（删除/换代），
        // 直接遍历 Map 会让本次唤醒集合随 await 变化。
        Array.from(waitingWorkspaceStartups.entries()).map(async ([workspaceKey, waiting]) => {
          // ready 事件可能赶在旧 readiness 读取返回前到达。先收口旧尝试，再读取新状态，
          // 避免事件复用一个即将以 provider-not-ready 失败的 Promise 而丢失唯一的 ready 通知。
          // [并发] 先等旧启动 Promise 收口，让旧尝试以自身结果结束，再读取新状态；
          // 只吞 provider-not-ready，其他错误交回 allSettled 记录。
          try {
            await waiting.starting;
          // 旧尝试在 ready 之前读到的快照不含新 provider，这个错误是预期中间态。
          } catch (error) {
            if (!isProviderNotReadyError(error)) throw error;
          }
          // Bug 根因：provider-ready 事件会先快照 waiting 列表再异步启动；workspace 在
          // await 期间被移除后，旧快照仍会把已释放的 Agent 重新拉起。只允许当前
          // waiting identity 对应的 generation 继续，删除或换代后的回调必须失效。
          // [并发] 双重失效判定缺一不可：cancelled 覆盖 release 主动取消，identity 覆盖
          // 「快照后 workspace 被移除并重新打开」——只比对 key 会把旧对象当新对象，重新拉起已释放 Agent。
          if (waiting.cancelled || waitingWorkspaceStartups.get(workspaceKey) !== waiting) {
            return;
          }
          // 用 waiting 上最新的 workspace：getClient 等待期间调用方可能补写 remoteSessionId/identity，
          // 闭包参数此时已经过期。
          const { workspace } = waiting;
          // getClient 会重跑 readiness 门禁并可能启动模型执行 client；失败仍由 allSettled 收敛，
          // 不会回滚其他已经成功的 workspace。
          const client = await getClient(workspace);
          // refreshRegistry 只在 ready 的瞬间拉一次最新 registry（providerRefreshRegistry）：
          // CLI 可能早于 provider 变更启动，不刷新会继续用旧模型列表；
          // reason 带 startup_ready 前缀便于审计是谁触发的。
          await ensureAccountProviderConfigSynced({
            client,
            reason: `startup_ready:${event.reason}`,
            workspace,
            refreshRegistry: true,
          });
          // 低频生命周期事件用 info（服务日志等级约定），不要下沉到 debug 导致线上不可见。
          logger.info(undefined, "provider/model 就绪后已启动等待中的 ZCode agent", {
            providerCount: event.snapshot.providerCount,
            reason: event.reason,
            revision: event.snapshot.revision,
            workspaceKey: resolveWorkspaceKey(workspace),
            workspacePath: workspace.workspacePath,
          });
        }),
      );
    }
  }

  // 会话级 emitter 的惰性缓存：key 由 (workspaceKey, sessionId) 组成（INV-04）。
  // 没有消费者时不创建，避免会话数量直接放大进程内存；dispose 时统一销毁。
  function getSessionEmitter(params: ZCodeAgentSessionTarget) {
    // key 必须与 emitSessionEvent 完全同源，否则事件会静默投空。
    const key = sessionEventKey(params);
    const existing = sessionEmitters.get(key);
    if (existing) {
      return existing;
    }
    // 同步入 map 再返回，保证同 key 的并发调用拿到同一实例、共享同一订阅域。
    const created = new Emitter<ZCodeAgentServiceEvent>();
    sessionEmitters.set(key, created);
    return created;
  }

  // 插件操作进度按 operationId 建 emitter：operationId 全局唯一且生命周期短。
  // 最后一个监听者移除时自毁，防止进程级 Map 随操作次数无界增长（与 INV-11 同类的有界约束）。
  function getPluginOperationProgressEmitter(operationId: string) {
    const existing = pluginOperationProgressEmitters.get(operationId);
    if (existing) return existing;
    let created: Emitter<ZCodePluginOperationProgressNotification>;
// created 先声明后赋值，自毁回调里才能拿到与 map 中一致的闭包引用。
    // [资源] 自毁回调先比对 map 当前值：同一 operationId 可能已被新订阅替换，
    // 旧 emitter 的清理不能删除新条目，否则新订阅的进度事件全部丢失。
    created = new Emitter({
      // 用 onDidRemoveLastListener 而不是要求调用方显式 dispose：订阅方只订阅，不负责释放。
      onDidRemoveLastListener: () => {
// 若 map 中已换成新 emitter，旧实例自毁时不能误删新实例的登记。
        if (pluginOperationProgressEmitters.get(operationId) !== created) return;
        pluginOperationProgressEmitters.delete(operationId);
        created.dispose();
      },
    });
    pluginOperationProgressEmitters.set(operationId, created);
    return created;
  }

  // conversation frame 按 workspace 建 emitter，renderer 再按 topic 自行路由；
  // host 不做二次分组，避免把 V4 topic 语义复制成第二事实源。
  function getConversationFrameEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    // 帧通道没有会话维度：同一 workspace 的所有会话共用一条 fan-out。
    const existing = conversationFrameEmitters.get(key);
    if (existing) {
      return existing;
    }
// 先查后建：同 workspace 并发首帧会共用同一个 emitter，不会重复 fan-out。
    const created = new Emitter<ConversationTopicWireCandidate>();
    conversationFrameEmitters.set(key, created);
    return created;
  }

  // provider headers 的 workspace 级镜像：桌面常驻应答方只按 workspace 订阅、不感知 sessionId，
  // 只投 session emitter 会让没有打开该会话的窗口收不到请求。
  function getProviderRuntimeHeadersWorkspaceEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    // 与 session 级 emitter 共用同一个 key 口径，保证两路投递指向同一 workspace。
    const existing = providerRuntimeHeadersWorkspaceEmitters.get(key);
    if (existing) {
      return existing;
    }
// workspace 级镜像常驻，不随会话关闭而销毁；只有进程 dispose 时统一释放。
    const created = new Emitter<ZCodeProviderRuntimeHeadersRequestParams>();
    providerRuntimeHeadersWorkspaceEmitters.set(key, created);
    return created;
  }

  // telemetry fact 低频且按 workspace 聚合，不按 session 建 emitter，
  // 否则会话数量会线性放大常驻 Map 与监听器。
  function getConversationTelemetryFactEmitter(workspace: ZCodeAgentWorkspaceTarget) {
// key 走 INV-02 口径：远程 identity 与本地同路径不能被当成同一个 workspace。
    const key = resolveWorkspaceKey(workspace);
    const existing = conversationTelemetryFactEmitters.get(key);
// 已存在就复用，保证同一 workspace 只有一个 telemetry 订阅点。
    if (existing) return existing;
    const created = new Emitter<ConversationTelemetryFact>();
    conversationTelemetryFactEmitters.set(key, created);
    return created;
  }

  // off-peak 生命周期同样只到 workspace 粒度；惰性创建让未使用该能力的 workspace 不占资源。
  function getOffPeakLifecycleEmitter(workspace: ZCodeAgentWorkspaceTarget) {
    const key = resolveWorkspaceKey(workspace);
    // 用 let 而不是 const：需要区分「已存在」与「新建」两条路径，新建后才写回 map。
// 未使用 Off-Peak 的 workspace 不会在这里留下空 emitter。
    let emitter = offPeakLifecycleEmitters.get(key);
    if (!emitter) {
      emitter = new Emitter<OffPeakLifecycleNotification>();
      offPeakLifecycleEmitters.set(key, emitter);
    }
    return emitter;
  }

  // sessions-index 与 conversation 共用同一个通知通道，只是 topic 前缀不同；
  // 分 emitter 是为了让两类帧的 schema 校验失败互不干扰。
  function getSessionsIndexFrameEmitter(workspace: ZCodeAgentWorkspaceTarget) {
// 索引帧只按 workspace 分通道，会话增删都复用这一条 fan-out。
    const key = resolveWorkspaceKey(workspace);
    const existing = sessionsIndexFrameEmitters.get(key);
    if (existing) {
      return existing;
    }
// 惰性创建：没有监听者时 Map 里不会留下空 emitter。
    const created = new Emitter<SessionsIndexTopicWireCandidate>();
    sessionsIndexFrameEmitters.set(key, created);
    return created;
  }

  // workspace-config 帧供配置目录活性监听使用；key 口径同样走 INV-02，
  // 远程 identity 与本地同路径不能共用一条通道。
  function getWorkspaceConfigFrameEmitter(workspace: ZCodeAgentWorkspaceTarget) {
// 配置目录帧与 conversation 帧分开建 emitter，schema 校验失败互不影响。
    const key = resolveWorkspaceKey(workspace);
    const existing = workspaceConfigFrameEmitters.get(key);
    if (existing) {
      return existing;
    }
// 只有真正有订阅者时才创建，避免为每个 workspace 常驻一个空通道。
    const created = new Emitter<WorkspaceConfigTopicWireCandidate>();
    workspaceConfigFrameEmitters.set(key, created);
    return created;
  }

  /** v4 订阅 connectionId：同 host 进程内多个独立消费者（renderer/syncer）用 scope 后缀区分。 */
  // 后缀让同一 host 内的 renderer 与 syncer 各持一条 CLI 侧连接账本：
  // 取消/重订阅只影响自己的 connectionId，不会互相删订阅。
  function v4ConnectionIdFor(subscriberScope?: string): string {
    return subscriberScope ? `${v4ConnectionId}#${subscriberScope}` : v4ConnectionId;
  }

  // 没有可信 carrier 就是宿主内部直调：固定 fallback connectionId 与 desktop-continuous，
  // 不根据参数猜 client 能力（INV-06：能力面由 channel allowlist 决定）。
  function resolveV4Connection(
    params: unknown,
    fallbackConnectionId: string = v4ConnectionId,
  ): ZCodeAgentV4ConnectionContext {
    // [权衡] 不抛错而给默认值：内部调用方没有 facade 参数，抛错会让所有旧路径一起断；
    // 默认值只声明「整键 patch」的订阅形态，不放宽任何能力。
    return (
      readTrustedZCodeAgentV4Connection(params) ?? {
        // 没有可信 carrier 就是宿主内部直调：按旧消费者订阅（整键 patch），不猜能力。
        connectionId: fallbackConnectionId,
        clientMode: "desktop-continuous" as const,
      }
    );
  }

  // 路由 key 用 NUL（\u0000）连接四元组：四个字段都不含该字符，
  // 用普通分隔符会出现 "a/b" 与 "a"+"b" 的拼接碰撞，导致跨路由误删。
  function v4SubscriptionRouteKey(route: V4SubscriptionRoute): string {
    return `${route.workspaceKey}\0${route.topic}\0${route.subscriptionId}\0${route.connectionId}`;
  }

  // ownership 只到 (workspace, topic, connection)：同一连接对同一 topic 只允许一条有效订阅，
  // 重订阅在语义上就是换代，旧 subId 必须立刻失去所有权。
  function v4SubscriptionOwnershipKey(route: V4SubscriptionRoute): string {
    return `${route.workspaceKey}\0${route.topic}\0${route.connectionId}`;
  }

  // 登记新路由前先删同 ownership 的旧 key：不删的话旧 subId 仍能被 isCurrent 命中，
  // 一条迟到的 unsubscribe 会删掉本不属于它的记录（INV-04 的幂等重订阅）。
  // 只改索引、不向 CLI 发命令：旧订阅的收尾由 unsubscribe/restart 流程负责。
  function rememberV4SubscriptionRoute(
    workspace: ZCodeAgentWorkspaceTarget,
    topic: string,
    subscriptionId: string,
    connectionId: string,
  ): void {
    const route: V4SubscriptionRoute = {
      // workspaceKey 在此刻固化：后续调用方补 identity/remoteSessionId 不会改写已登记路由，
      // 否则同一 route 对象的 key 会漂移，isCurrent 永远查不到。
      workspaceKey: resolveWorkspaceKey(workspace),
      topic,
      subscriptionId,
      connectionId,
    };
    // previous 是 ownership 维度的旧 routeKey 而不是 route 对象；删 key 即可，无需遍历。
    const ownershipKey = v4SubscriptionOwnershipKey(route);
    const previous = v4RouteKeyByOwnership.get(ownershipKey);
    if (previous) v4SubscriptionRoutes.delete(previous);
    const routeKey = v4SubscriptionRouteKey(route);
    v4RouteKeyByOwnership.set(ownershipKey, routeKey);
    v4SubscriptionRoutes.set(routeKey, route);
  }

  // 幂等删除：ownership 索引只在仍指向本 routeKey 时才清理。
  // 无条件 delete 会让迟到的旧 route 清理把后来登记的新路由索引一并抹掉，
  // 新订阅从此无法按 ownership 查找，替换语义失效。
  function forgetV4SubscriptionRoute(route: V4SubscriptionRoute): void {
// 先算 routeKey 再删除：key 只由字段决定，不受删除动作影响。
    const routeKey = v4SubscriptionRouteKey(route);
    v4SubscriptionRoutes.delete(routeKey);
// ownership 索引只在仍指向本 routeKey 时才删，避免误删后来者的登记。
    const ownershipKey = v4SubscriptionOwnershipKey(route);
    if (v4RouteKeyByOwnership.get(ownershipKey) === routeKey) {
      v4RouteKeyByOwnership.delete(ownershipKey);
    }
  }

  // 用对象身份（===）判断「当前」：runtime restart 后可能复用相同 key/subId/connectionId，
  // 字段全等但对象不同，必须视为 stale，否则旧响应会清理新订阅。
  function isCurrentV4SubscriptionRoute(route: V4SubscriptionRoute): boolean {
    return v4SubscriptionRoutes.get(v4SubscriptionRouteKey(route)) === route;
  }

  // 两种粒度：传 workspaceKey 只清一个 workspace（release/restart），不传则全清（dispose）。
  // 遍历时 forget 会修改 Map，但 for..of values() 对未访问项的删除是安全的。
  function clearV4SubscriptionRoutes(workspaceKey?: string): void {
// 遍历中 forget 会删当前项，for..of values() 对已访问/当前项的删除是安全的。
// 不传 workspaceKey 表示清空全部路由，例如 dispose 或 workspace 重建场景。
    for (const route of v4SubscriptionRoutes.values()) {
      if (workspaceKey !== undefined && route.workspaceKey !== workspaceKey) {
        continue;
      }
      forgetV4SubscriptionRoute(route);
    }
  }

  // 解析退订/重同步目标：优先使用可信 carrier（由 facade 注入，对端无法伪造）。
  // 无 carrier 的 base service 内部直连只在 method topic 域内唯一命中时兼容；
  // 多义即拒绝，更不能向多个 publisher 广播删除（INV-04）。
  function resolveV4UnsubscribeRoute(
    params: ZCodeAgentConversationUnsubscribeParams | ZCodeAgentConversationResyncParams,
    topicPrefix: string,
  ): V4SubscriptionRoute | null {
    const expectedWorkspaceKey = resolveWorkspaceKey(params);
    const trusted = readTrustedZCodeAgentV4UnsubscribeRoute(params);
    if (trusted) {
      // 前缀校验把 conversation 域与 sessions-index/workspace-config 域隔开，
      // 否则一个 conversation 的退订号可以打掉同 connection 上其他 topic 的订阅。
      if (!trusted.topic.startsWith(topicPrefix)) return null;
      const route: V4SubscriptionRoute = {
        workspaceKey: expectedWorkspaceKey,
        topic: trusted.topic,
        subscriptionId: params.subscriptionId,
        connectionId: trusted.connectionId,
      };
      // 必须回查登记表：只有本 host 真正登记过的路由才允许下发，
      // 防止对端构造任意 topic/subId 让 host 代发命令。
      return v4SubscriptionRoutes.get(v4SubscriptionRouteKey(route)) ?? null;
    }
    // base service 的内部直连消费者没有 facade carrier；只在 method topic 域内唯一
    // 命中时兼容，碰撞则拒绝猜测，更不能多 publisher 广播删除。
    // 三个条件缺一不可：workspaceKey 防跨 workspace，subscriptionId 防同 workspace 的不同订阅，
    // topic 前缀防同 subId 跨域。
    const matches = [...v4SubscriptionRoutes.values()].filter(
      (route) =>
        route.workspaceKey === expectedWorkspaceKey &&
        route.subscriptionId === params.subscriptionId &&
        route.topic.startsWith(topicPrefix),
    );
    // 0 条 = 不属于本 host；>1 条 = 无法判定归属。两种都返回 null，
    // 让上层按 no-op（unsubscribe）或 notOwned（resync）处理。
    return matches.length === 1 ? matches[0]! : null;
  }

  // 退订契约：解析路由 → 取只读 client（可能拉起进程）→ 发 unsubscribe → 复核后删本地记录。
  // 副作用：一次 RPC。失败直接上抛，本地记录保留，让重试仍能找到目标而不是留下孤儿订阅。
  async function unsubscribeV4Route(
    params: ZCodeAgentConversationUnsubscribeParams,
    topicPrefix: string,
  ): Promise<void> {
    // 未登记直接 no-op：重复退订必须幂等（INV-12 的同类要求），
    // 不能因为找不到目标抛错而打断 dispose/release 流程。
    const route = resolveV4UnsubscribeRoute(params, topicPrefix);
    if (!route) return;
    // [并发] 该复核同时覆盖 INV-03：restart 可能已登记同 key、但对象不同的新 route。
    const client = await getReadOnlyClient(params, params.runtimePolicy);
    // getReadOnlyClient 可能在 await 中拉起新 runtime；restart listener 已清旧 route，且新
    // runtime 可能复用相同 key/subId。必须以对象身份复核，不能拿局部旧 route 发给新 CLI。
    // [失败路径] 静默返回：旧订阅的残留在 CLI 侧会随连接关闭回收，
    // 比向新 runtime 发一条错误 topic 的 unsubscribe 安全。
    if (!isCurrentV4SubscriptionRoute(route)) return;
    // 只带 route 三元组：connectionId 已绑定 workspace，重复携带会制造第二份身份来源。
    await client.request(
      V4_METHODS.conversationUnsubscribe,
      {
        topic: route.topic,
        subscriptionId: route.subscriptionId,
        connectionId: route.connectionId,
      },
      zcodeProtocolEmptyResultSchema,
    );
    // request 在途时 runtime restart/重订阅可用相同 route key 建立新对象；
    // 迟到旧 response 只能清理它自己的 generation，不能按复合 key 删除新 route。
    // [并发] 迟到 response 只能清理自己这一代：若期间已重订阅，新 route 必须保留，
    // 否则 UI 会以为订阅已断而重建，产生重复订阅。
    if (isCurrentV4SubscriptionRoute(route)) forgetV4SubscriptionRoute(route);
  }

  // resync 契约：只有本 host 拥有的订阅才能重同步；返回 ACK 前再次校验对象身份。
  // 失败统一抛稳定错误码 fault.subscription.notOwned，调用方按码分流而不是解析文本（INV-05）。
  async function resyncV4Route(params: ZCodeAgentConversationResyncParams, topicPrefix: string) {
    const route = resolveV4UnsubscribeRoute(params, topicPrefix);
    // 未拥有就抛错而不是静默：resync 是恢复链路，静默会伪装成「已追上」，
    // consumer 带着错误游标继续请求，最终表现为事件缺失。
    if (!route) throw new Error("fault.subscription.notOwned");
    const client = await getReadOnlyClient(params, params.runtimePolicy);
    if (!isCurrentV4SubscriptionRoute(route)) {
      throw new Error("fault.subscription.notOwned");
    }
    // 请求体只带恢复所需字段；forceSnapshot 用条件展开而不是显式 undefined，
    // 避免 strict schema 把「未指定」当成「传了 undefined」。
    const result = await client.request(
      V4_METHODS.conversationResync,
      {
        topic: route.topic,
        connectionId: route.connectionId,
        subscriptionId: route.subscriptionId,
        base: params.base,
        ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
      },
      v4ConversationResyncResultSchema,
    );
    // resync ACK 只对发起时的 route generation 有效。若 await 期间已 restart/重订阅，
    // 返回 stale success 会让 consumer 把旧 recovery 当作新 subscription 的恢复结果。
    // [并发] stale ACK 的后果是 seq 断层或重复投递，且后续事件无法纠正。
    if (!isCurrentV4SubscriptionRoute(route)) {
      throw new Error("fault.subscription.notOwned");
    }
    return result;
  }

  // 只投给精确 (workspaceKey, sessionId) 的 emitter；无订阅者时静默丢弃，
  // host 不缓存事件（INV-01：事件真值在 CLI，host 不做第二份快照）。
  function emitSessionEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    sessionId: string,
    event: ZCodeAgentServiceEvent,
  ): void {
    sessionEmitters.get(sessionEventKey({ ...workspace, sessionId }))?.fire(event);
  }

  // workspace 级广播按 key 前缀扫描：sessionEventKey 形如 workspaceKey + NUL。
  // 用 startsWith 精确到分隔符；改成 includes 会让 "a" 命中 "a2" 的会话，
  // 把权限请求广播到别的 workspace。
  function emitWorkspaceEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeAgentServiceEvent,
  ): void {
    // [权衡] O(n) 扫描而不维护 workspace→emitters 二级索引：会话数受打开窗口约束，
    // 索引本身还要处理创建/销毁同步，出错时更难定位。
    const workspaceKey = resolveWorkspaceKey(workspace);
    for (const [key, emitter] of sessionEmitters) {
      if (key.startsWith(`${workspaceKey}\u0000`)) {
        emitter.fire(event);
      }
    }
  }

  // seq 兼容状态按会话维护：旧 agent 的 live sink 直接发 createSessionEvent 默认 seq=0，
  // 只有 replay/read 走 event store 后才补号。这是有明确边界的兼容层，
  // 不是第二份顺序事实源（INV-01）。
  function getSessionEventSequenceState(
    workspace: ZCodeAgentWorkspaceTarget,
    sessionId: string,
  ): SessionEventSequenceState {
    // key 与 emitter 同源，状态随会话存续，disposeLocalState 统一 clear。
    const key = sessionEventKey({ ...workspace, sessionId });
    const existing = sessionEventSequenceStates.get(key);
    if (existing) {
      return existing;
    }
    // 五个字段寿命不同：assignedSeqByEventId/Order 是有界补号缓存，
    // liveEventIds/Order 是有界去重窗口，lastAssignedSeq 只增不减。
    // 两个数组都是插入顺序队列，与对应 Set 同步淘汰，防止内存随长会话增长。
    const created: SessionEventSequenceState = {
      assignedSeqByEventId: new Map<string, number>(),
      assignedSeqEventIds: [],
      liveEventIds: new Set<string>(),
      liveEventIdOrder: [],
      lastAssignedSeq: 0,
    };
    sessionEventSequenceStates.set(key, created);
    return created;
  }

  // normalize 契约：seq>0 视为 CLI 给出的权威序号，只推进水位、不改事件；
  // seq=0 才走兼容补号。反过来（对已带号事件重新编号）会与 event store 的
  // replay 序号冲突，renderer 侧去重会误删真实事件。
  function normalizeSessionEventSeq(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeSessionEvent,
  ): ZCodeSessionEvent {
    const state = getSessionEventSequenceState(workspace, event.sessionId);
    // [并发] 用 Math.max 而非直接赋值：事件可能乱序到达，水位回退会让后续补号
    // 撞上已发出的序号，消费方按 seq 排序时出现并列。
    if (event.seq > 0) {
      state.lastAssignedSeq = Math.max(state.lastAssignedSeq, event.seq);
      return event;
    }

    // 同一 eventId 重发（transport 重试或重放）必须拿到同一个 seq，
    // 否则 renderer 会把它当成两条不同事件；先查补号缓存再分配新号。
    const assignedSeq = state.assignedSeqByEventId.get(event.eventId);
    if (assignedSeq !== undefined) {
      return { ...event, seq: assignedSeq };
    }

    // 补号从水位 +1 开始且单调递增，消费方可以安全地按 seq 排序/去重。
    const nextSeq = state.lastAssignedSeq + 1;
    state.lastAssignedSeq = nextSeq;
    state.assignedSeqByEventId.set(event.eventId, nextSeq);
    state.assignedSeqEventIds.push(event.eventId);
    // [资源] 补号表必须有界：只保留最近 MAX_TRACKED_SESSION_EVENT_IDS 条，超出按插入顺序淘汰。
    // 无界会让长会话把整个 eventId→seq 常驻内存；超出窗口的重复事件概率极低，淘汰是安全的。
    while (state.assignedSeqEventIds.length > MAX_TRACKED_SESSION_EVENT_IDS) {
      const removed = state.assignedSeqEventIds.shift();
      if (removed) {
        state.assignedSeqByEventId.delete(removed);
      }
    }
    // 旧 agent live sink 会把 createSessionEvent 默认 seq=0 直接发给 app，
    // 而 replay/read 走 event store 后才补号。这里只做旧版本兼容；新 runtime 的顺序事实源仍是 event store。
    return { ...event, seq: nextSeq };
  }

  // live 投递去重：同一 eventId 只投一次，防止 CLI 重连后的重放把 UI 打回旧状态。
  // 窗口同样有界；回放/读取走 event store，不依赖这个集合。
  function shouldDeliverLiveSessionEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeSessionEvent,
  ): boolean {
    const state = getSessionEventSequenceState(workspace, event.sessionId);
    return rememberBoundedEventId(state.liveEventIds, state.liveEventIdOrder, event.eventId);
  }

  // session 事件唯一入口：补号 → live 去重 → 按 session 投递。
  // 顺序不能交换：去重键是 eventId（不受补号影响），但投递必须携带最终 seq，
  // 否则 renderer 会看到 0 号并重新排序。
  function handleSessionEvent(
    workspace: ZCodeAgentWorkspaceTarget,
    event: ZCodeSessionEvent,
  ): void {
    const normalizedEvent = normalizeSessionEventSeq(workspace, event);
    // 去重在补号之后、但用的是 eventId：重复事件即使补成同一 seq，也不会二次投递。
    if (!shouldDeliverLiveSessionEvent(workspace, normalizedEvent)) {
      return;
    }
    // 事件对象携带最终 seq：normalize 的返回值是唯一投递口径。
    emitSessionEvent(workspace, normalizedEvent.sessionId, {
      type: "session.event",
      event: normalizedEvent,
    });
  }

  // state.updated 带 sessionId 时按会话路由，否则按 workspace 广播。
  // 两条路径不能合并：workspace 级状态若被裁剪进某个会话，其他会话的 UI 永远收不到。
  function handleStateUpdated(
    workspace: ZCodeAgentWorkspaceTarget,
    notification: ZCodeStateUpdatedNotification,
  ): void {
    // 用 truthy 判断而不是 !== undefined：空串表示 workspace 级更新，
    // 给空 sessionId 建 emitter 会留下永远无人订阅的条目。
    if (notification.sessionId) {
      emitSessionEvent(workspace, notification.sessionId, {
        type: "state.updated",
        notification,
      });
      return;
    }
    emitWorkspaceEvent(workspace, { type: "state.updated", notification });
  }

  // 给一个已建立的 client 绑定 host 侧全部能力：
  //   - 通知：资源样本、会话事件、V4 frame、CUA 观察等只读 fan-out；
  //   - 请求：权限/用户输入/provider headers/浏览器/自动化等需要 host 应答的 RPC；
  //   - topic 资源桥：校验、读取、上传，生命周期随 client。
  // 幂等：wiredClients 保证同一 client 只绑一次；disposables 存入 clientDisposables，
  // 由 invalidateWorkspaceClient 在 close/失活时统一释放（INV-07）。
  // lane 是进程泳道标识：CLI 不知道自己被哪个进程管理器拉起，只能由调用方补齐。
  function wireClient(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    /**
     * 该 client 所属的进程泳道。CLI 进程不知道自己被哪个进程管理器拉起，
     * 因此资源样本的 lane 只能在这里按调用方补齐。
     */
    lane: ProcessResourceCliLane,
  ): void {
    // [资源] 幂等守卫：同一 client 可能先被只读路径 wire，又被 processManager 提升路径 wire；
    // 重复绑定会产生两份订阅，close 时重复 dispose 且事件重复投递。
    if (wiredClients.has(client)) {
      return;
    }
    // WeakSet 不阻止 client 回收；真正的释放依赖 clientDisposables + onClose。
    wiredClients.add(client);
    // topic 资源桥的 workspace 是惰性的：预热/只读启动时可能还没有 remoteSessionId，
    // 不能永久捕获 wireClient 首次参数。每次资源操作从 active 表取当前可信入口，
    // 并在一次操作内保持同一份快照，避免 validate/read/upload 之间身份漂移。
    const topicResources = createTopicResourceBridge(() => {
// 每次资源操作都重新取当前 active 入口，避免 wire 时的 workspace 快照过期。
      // 预热可能没有 remoteSessionId；不能永久捕获 wireClient 首次参数。
      // 从同一个实际 CLI 的当前可信入口取路由，并在一次资源操作内保持不变。
      // 只有 active 表里仍是同一个 client 时才用 active.workspace，否则回落到 wire 时的参数。
// 这一层身份校验防止旧 bridge 在 client 被替换后仍用新 workspace 读资源。
      const active = activeClientsByWorkspaceKey.get(resolveWorkspaceKey(workspace));
      const resourceWorkspace =
        active?.client === client ? { ...active.workspace } : { ...workspace };
      return {
        // 校验与读取都是 host 注入的能力：缺省时显式抛错而不是放行。
        // 静默允许会让 remote/mobile attachment 绕过 channel allowlist（INV-06）。
        validate: (request, signal, trace) => {
// 校验器未装配即 fail-closed：这里绝不能退化成放行。
// resourceWorkspace 来自当前 wire 上下文，补齐 CLI 未携带的 workspace 身份字段。
          if (!options?.topicResourceValidator)
            throw new Error("Topic resource authorization is unavailable");
          return options.topicResourceValidator(
            { ...request, ...resourceWorkspace, trace },
            signal,
          );
        },
        // 读取同样 fail-closed：executor 未装配说明该 host 不支持附件回传，
        // 返回空内容会让 CLI 以为资源是空文件。
        read: (request, signal, trace) => {
// 读取器缺失同样抛错而非返回空，避免 CLI 把「不支持」误判成空资源。
          if (!options?.topicResourceExecutor)
            throw new Error("Topic attachment retrieval is unavailable on this host");
          return options.topicResourceExecutor({ ...request, ...resourceWorkspace, trace }, signal);
        },
        // 上传固定使用本 client 与宿主内部 connectionId：上传通道必须绑定 attachment 的生命周期，
        // 不能借用 renderer 的 connection（INV-07）。
        upload: (request, attachment, signal, trace) =>
          uploadTopicResourceToClient(
            client,
            v4ConnectionId,
            { ...resourceWorkspace, sessionId: request.taskId },
            attachment,
            signal,
            trace,
          ),
      };
    });
    // 所有绑定集中到一个数组再登记：释放顺序即声明顺序（topic 桥 → 通知 → 请求 → close），
    // 先断开对外通道再处理 onClose，避免释放过程中仍有回调写状态（INV-12）。
    const disposables = [
      topicResources,
      // [失败路径] 通知处理是同步分发：任何分支都不能抛出，否则会打断后续通知投递；
      // 因此全部使用 safeParse + 提前 return，解析失败只记日志。
      client.onNotification((message) => {
        // provider headers 取消只处理属于本 client 且 workspaceKey 相同的请求：
        // 旧 client 或同路径不同 identity 的取消不能删掉新 runtime 的 pending（INV-03/INV-05）。
        if (message.method === zcodeProtocolNotifications.providerRuntimeHeadersCancelled) {
          const parsed = zcodeProviderRuntimeHeadersCancelledSchema.safeParse(message.params);
          if (
            !parsed.success ||
            resolveWorkspaceKey(parsed.data.workspace) !== resolveWorkspaceKey(workspace)
          )
            return;
          // pending key 由 sessionEventKey + requestId 组成，与请求侧写入时完全同源。
          const key = providerRuntimeHeadersRequestKey({
            ...workspace,
            sessionId: parsed.data.sessionId,
            requestId: parsed.data.requestId,
          });
          // 只认 client 身份相同的 pending：restart 后同 key 的记录属于新 client。
          const pending = pendingProviderRuntimeHeaders.get(key);
          // 旧 client 或同路径不同 identity 的取消不能删除新 runtime/其他工作区的请求。
          if (pending?.client === client) cancelProviderRuntimeHeaders(key, pending);
          return;
        }
        // 资源样本是高频诊断数据：解析失败只记 debug（生产不落盘），
        // 不能让格式演进把整条通知链打断。
        if (message.method === zcodeProtocolNotifications.processResourceSample) {
          // 资源样本字段随采集面演进，schema 失败只降级为 debug 日志。
          const parsed = zcodeProcessResourceSampleSchema.safeParse(message.params);
          if (parsed.success) {
            // lane 由 wireClient 注入，CLI 无法得知被哪个进程管理器拉起。
            processResourceSampleEmitter.fire({ ...parsed.data, lane });
          } else {
            // 只记 issue 的 code/path，不记原始样本值，避免把内容写进生产日志。
            logger.debug(undefined, "丢弃无效 ZCode CLI 资源样本", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.join("."),
              })),
            });
          }
          return;
        }

        // 工具执行资源是进程级统计，不按 workspace 分流，直接投全局 emitter。
        if (message.method === zcodeProtocolNotifications.toolExecResource) {
          const parsed = zcodeToolExecResourceSchema.safeParse(message.params);
          if (parsed.success) toolExecResourceEmitter.fire(parsed.data);
          return;
        }
        // MCP 资源/遥测同属采集面数据，解析失败只记 debug；
        // 与业务事件不同，丢一条样本不影响状态正确性。
        if (message.method === zcodeProtocolNotifications.mcpResourceSamples) {
          const parsed = zcodeMcpResourceSamplesSchema.safeParse(message.params);
          if (parsed.success) mcpResourceSamplesEmitter.fire(parsed.data);
          else logger.debug(undefined, "丢弃无效 MCP 资源样本");
          return;
        }

        // 遥测 schema 随 CLI 版本演进，strict 解析失败时丢弃而不是宽松透传。
        if (message.method === zcodeProtocolNotifications.mcpTelemetry) {
          const parsed = zcodeMcpTelemetryEventSchema.safeParse(message.params);
          if (parsed.success) {
            mcpTelemetryEmitter.fire(parsed.data);
          // 遥测只做转发，不在 host 侧聚合，避免形成第二份指标状态。
          } else {
            logger.debug(undefined, "丢弃无效 ZCode CLI MCP 遥测事件", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.join("."),
              })),
            });
          }
          return;
        }

        // 插件操作进度按 operationId 找 emitter：找不到说明订阅者已全部移除（emitter 自毁），
        // 此时丢弃通知是正确语义，host 不补建。
        if (message.method === zcodeProtocolNotifications.pluginOperationProgress) {
          const parsed = zcodePluginOperationProgressNotificationSchema.safeParse(message.params);
          if (parsed.success) {
            pluginOperationProgressEmitters.get(parsed.data.operationId)?.fire(parsed.data);
          } else {
            logger.warn(undefined, "丢弃无效 ZCode Protocol 插件操作进度", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
            });
          }
          return;
        }

        // CUA 操作事件走 runtime sideband，不经过 legacy session/event：
        // 两条流各有 sequenceNumber/seq 顺序域，混用会让 turn 归属错乱。
        if (message.method === zcodeProtocolMethods.computerUseOperationEvent) {
          const parsed = zcodeComputerUseOperationEventSchema.safeParse(message.params);
          if (parsed.success) {
            // v4 会话不会投影 legacy session/event，CUA 提示必须直接消费 runtime sideband，
            // 避免把两条独立事件流的 sequenceNumber/seq 混为同一顺序域。
            cuaOperationTurnTracker?.accept(workspace, parsed.data);
          } else {
            logger.warn(undefined, "丢弃无效 ZCode Protocol Computer Use operation event", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }

        // session/event 是旧版 live 通道：仍要补号与去重（见 handleSessionEvent），
        // 但新 runtime 的顺序事实源是 event store，不是这里。
        if (message.method === "session/event") {
          const parsed = zcodeSessionEventSchema.safeParse(message.params);
          if (parsed.success) {
            handleSessionEvent(workspace, parsed.data);
          } else {
            // 解析失败只告警并尽量带出 traceId/eventId/sessionId：丢一条事件的排查成本更高；
            // 但不能把原始 params 整体写进日志（可能含用户内容）。
            const rawParams =
              typeof message.params === "object" && message.params !== null
                ? (message.params as Record<string, unknown>)
                : {};
            logger.warn(
              typeof rawParams.traceId === "string" ? rawParams.traceId : undefined,
              "丢弃无效 ZCode Protocol session event",
              {
                eventId: rawParams.eventId,
                issues: parsed.error.issues.map((issue) => ({
                  code: issue.code,
                  message: issue.message,
                  path: issue.path.join("."),
                })),
                sessionId: rawParams.sessionId,
                type: rawParams.type,
              },
            );
          }
          return;
        }

        // state.updated 不带 seq 语义，走独立分支；成功与否都不影响后续通知。
        if (message.method === "state.updated") {
          const parsed = zcodeStateUpdatedNotificationSchema.safeParse(message.params);
          if (parsed.success) {
            handleStateUpdated(workspace, parsed.data);
          }
          return;
        }

        // local TTFT 只对纯本地 workspace 生效：远程会话的 TTFT 由远端上报，
        // 本地再算一份会与远端指标冲突（INV-02 的身份判定）。
        if (message.method === V4_NOTIFICATIONS.localTtftFacts) {
          const parsed = localTtftFactsSchema.safeParse(message.params);
          if (parsed.success && !workspace.remoteSessionId && !workspace.workspaceIdentity?.trim())
            localTtftFactsEmitter.fire({
              workspaceKey: resolveWorkspaceKey(workspace),
              facts: parsed.data,
            });
          return;
        }
        // telemetry fact 采用 strict 解析：CLI 新增字段必须先经过协议审计，
        // 否则会未经检查穿透到 renderer reporter。
        if (message.method === V4_NOTIFICATIONS.conversationTelemetryFact) {
          const parsed = conversationTelemetryFactSchema.safeParse(message.params);
          if (parsed.success) {
            getConversationTelemetryFactEmitter(workspace).fire(parsed.data);
          } else {
            // 严格丢弃未知字段，避免 CLI runtime 新字段未经审计穿透到 renderer reporter。
            logger.warn(undefined, "丢弃无效 v4 conversation telemetry fact", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }
        // 闲时生命周期只做通知转发，host 不持有 off-peak 任务状态。
        if (message.method === V4_NOTIFICATIONS.offPeakLifecycle) {
          const parsed = offPeakLifecycleNotificationSchema.safeParse(message.params);
          if (parsed.success) getOffPeakLifecycleEmitter(workspace).fire(parsed.data);
          else
            logger.warn(undefined, "丢弃无效闲时生命周期通知", {
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          return;
        }

        if (message.method === V4_NOTIFICATIONS.pluginUiToolResult) {
          const parsed = pluginUiToolResultNotificationSchema.safeParse(message.params);
          // 只接受当前本地 runtime；旧进程迟到结果和远程客户端不能在本窗口创建 UI。
          // 三个条件缺一不可：旧进程的迟到结果与远程身份都会在本窗口伪造 UI 副作用。
          if (
            parsed.success &&
            !workspace.remoteSessionId &&
            !isRemoteWorkspaceIdentity(workspace.workspaceIdentity ?? "") &&
            activeClientsByWorkspaceKey.get(resolveWorkspaceKey(workspace))?.client === client
          ) {
            pluginUiToolResultEmitter.fire({
              ...parsed.data,
              workspacePath: workspace.workspacePath,
              ...(workspace.workspaceIdentity
                ? { workspaceIdentity: workspace.workspaceIdentity }
                : {}),
            });
          }
          return;
        }
        // CUA 权限观察会触发 renderer 副作用，未知字段必须 fail closed；
        // 与普通遥测不同，解析失败要显式告警而不是静默丢弃。
        if (message.method === V4_NOTIFICATIONS.cuaPermissionObservation) {
          const parsed = cuaPermissionObservationSchema.safeParse(message.params);
          if (
            parsed.success &&
            !workspace.remoteSessionId &&
            !(workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity))
          ) {
            cuaPermissionObservationEmitter.fire({
              ...parsed.data,
              workspacePath: workspace.workspacePath,
              ...(workspace.workspaceIdentity
                ? { workspaceIdentity: workspace.workspaceIdentity }
                : {}),
            });
          // 失败分支单独告警：成功分支不记日志，避免权限观察刷屏。
          } else if (!parsed.success) {
            // 原因：权限观察会触发 renderer 副作用，未知字段必须 fail closed，不能宽松透传。
            logger.warn(undefined, "丢弃无效 v4 CUA 权限观察", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }

        if (message.method === V4_NOTIFICATIONS.conversationFrame) {
          // 同一通知也载 sessions-index 帧，按 topic 前缀分流到列表 emitter
          // （否则会被 conversation schema 校验丢弃）。
          // 先读原始 topic 再做 schema 校验：topic 是分流的唯一依据，不能在解析失败后猜。
          const topic = (message.params as { topic?: unknown } | null)?.topic;
          if (typeof topic === "string" && topic.startsWith("sessions-index/")) {
            // 列表帧用独立 schema：它的 wire 结构与 conversation 帧不同，混用会互相污染。
            const indexParsed = sessionsIndexTopicWireCandidateSchema.safeParse(message.params);
            if (indexParsed.success) {
              getSessionsIndexFrameEmitter(workspace).fire(indexParsed.data);
            } else {
              logger.warn(undefined, "丢弃无效 v4 sessions-index frame", {
                issues: indexParsed.error.issues.map((issue) => ({
                  code: issue.code,
                  message: issue.message,
                  path: issue.path.join("."),
                })),
                workspaceKey: resolveWorkspaceKey(workspace),
              });
            }
            return;
          }
          // workspace-config 供配置目录活性监听，schema 同样独立。
          if (typeof topic === "string" && topic.startsWith("workspace-config/")) {
            const configParsed = workspaceConfigTopicWireCandidateSchema.safeParse(message.params);
            if (configParsed.success) {
              getWorkspaceConfigFrameEmitter(workspace).fire(configParsed.data);
            } else {
              logger.warn(undefined, "丢弃无效 v4 workspace-config frame", {
                issues: configParsed.error.issues.map((issue) => ({
                  code: issue.code,
                  message: issue.message,
                  path: issue.path.join("."),
                })),
                workspaceKey: resolveWorkspaceKey(workspace),
              });
            }
            return;
          }
          // 兜底按 conversation 帧解析；失败只告警，不影响同一 client 的其他 topic。
          const parsed = conversationTopicWireCandidateSchema.safeParse(message.params);
          if (parsed.success) {
            getConversationFrameEmitter(workspace).fire(parsed.data);
          } else {
            logger.warn(undefined, "丢弃无效 v4 conversation frame", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }
      }),
      // request 处理：CLI 发起的 host 侧 RPC。全部「同步返回、异步应答」，
      // 不能让 handler 抛错穿透到协议层（协议层只会看到未处理异常并断开连接）。
      // 每个分支先校验 params 再取能力；未识别的方法统一回 -32601。
      client.onRequest((request) => {
        // 子 agent 运行时配置：CLI 启动子 agent 前拉一次；
        // host 侧必须重新 parse，防止注入未审计字段。
        if (request.method === zcodeProtocolMethods.subagentsReadRuntimeConfig) {
          void (async () => {
            const parsed = zcodeSubagentsReadRuntimeConfigParamsSchema.safeParse(request.params);
            if (!parsed.success) {
              // 参数错误回 -32602（JSON-RPC 标准），错误信息不带原始 params。
              await client.respondError(request.id, {
                code: -32602,
                message: "Invalid subagent runtime config request",
              });
              return;
            }
            let configuration: SubagentRuntimeConfig;
            try {
              // 能力缺省 = 不可用：抛错后统一回 -32603，让 CLI 走「无子 agent 配置」降级，
              // 而不是拿到一份空配置继续执行。
              if (!options?.readSubagentRuntimeConfig)
                throw new Error("Subagent runtime config is unavailable on this Host");
              // 返回值再过一遍 schema：注入的实现可能返回超出协议的结构。
              configuration = subagentRuntimeConfigSchema.parse(
                await options.readSubagentRuntimeConfig(workspace),
              );
            // 读取失败统一回 -32603，并保留原始 message 供 CLI 侧日志；不返回部分配置。
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
              return;
            }
            await client.respond(request.id, configuration);
          // 应答失败只记 debug：transport 已关闭时这是预期结果，不能升级成 error。
          })().catch((error) =>
            logger.debug(undefined, "Subagent 配置响应发送失败", { error: String(error) }),
          );
          return;
        }
        // channel reply：CLI 需要把消息回发到外部渠道（如 IM）。
        // 必须先确认 client 仍是该 workspace 的 active client，
        // 否则旧进程可以借已释放的 workspace 身份发消息（INV-03）。
        if (request.method === zcodeProtocolMethods.channelReply) {
          void (async () => {
            // 入参用 parse（不是 safeParse）：格式错误属于协议违约，直接走 catch 回 -32603。
            const params = channelReplyRequestSchema.parse(request.params);
            if (!options?.channelReplyExecutor) throw new Error("Channel reply unavailable");
            // 活跃性复核放在 await executor 之前：executor 可能长时间持锁，期间换代后不能再以旧身份发消息。
            const active = activeClientsByWorkspaceKey.get(resolveWorkspaceKey(workspace));
            if (active?.client !== client)
              throw new Error("Channel reply client is no longer active");
            const currentWorkspace = active.workspace;
            const result = await options.channelReplyExecutor({
              ...params,
              // 只投影工作区身份三字段，不展开 active.workspace：它包含 V4 envelope 等内部字段，
              // 展开会把 host 内部结构泄露给跨回复契约。
              // 活跃连接还携带 V4 envelope 等内部字段；跨回复契约只能投影工作区身份，不能展开整个对象。
              workspacePath: currentWorkspace.workspacePath,
              workspaceIdentity: currentWorkspace.workspaceIdentity,
              remoteSessionId: currentWorkspace.remoteSessionId,
              trace: request.trace,
            });
            await client.respond(request.id, result);
          // 失败时仍要回一个 -32603，否则 CLI 侧会一直等到传输超时。
          })().catch((error: unknown) =>
            client.respondError(request.id, {
              code: -32603,
              message: error instanceof Error ? error.message : "Channel reply failed",
            }),
          );
          return;
        }
        // topic 资源读取转交资源桥：校验/权限在桥内完成，这里只把结果或错误转成 RPC 响应。
        if (request.method === zcodeProtocolMethods.topicResourceRead) {
          void topicResources
            .read(request.params, request.trace)
            .then((result) => client.respond(request.id, result))
            // 成功路径直接回原始结果，桥内已完成 schema 与授权校验。
            .catch((error: unknown) =>
              client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : "Topic resource read failed",
              }),
            );
          return;
        }
        // 取消是同步应答：cancel 只标记本地 AbortController，立刻回复让 CLI 不必等待实际中断。
        if (request.method === zcodeProtocolMethods.topicResourceCancel) {
          const parsed = zcodeTopicResourceCancelParamsSchema.safeParse(request.params);
          void client.respond(request.id, {
            // 取消结果带 cancelled 布尔：调用方需要区分「已中断」与「请求不存在」。
            cancelled: parsed.success && topicResources.cancel(parsed.data),
          });
          return;
        }
        // 运行时偏好请求：CLI 在「创建 runtime」与「首次执行」两个时机各要一次。
        // authority=local 时由本 host 读设置直接应答；否则转发给 Host 并挂 pending，等回包或超时。
        // 两条路径都不能让 pending 或定时器悬挂（INV-05）。
        if (request.method === zcodeProtocolMethods.sessionRequestRuntimePreferences) {
          // 统一的应答失败处理：transport 关闭导致的写失败只记 debug，
          // 不能再尝试发第二个 error response（会二次抛错并成为未处理 rejection）。
          const reportResponseFailure = (error: unknown): void => {
// 只记 message 与 workspaceKey，不记录请求体，避免偏好内容进入日志。
            logger.debug(undefined, "运行时偏好响应发送失败", {
              error: error instanceof Error ? error.message : String(error),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          };
          // 参数校验失败回 -32602 并带 flatten 的字段路径；这条路径不建 pending，不涉及定时器。
          const parsed = zcodeSessionRequestRuntimePreferencesParamsSchema.safeParse(
            request.params,
          );
          if (!parsed.success) {
            // 回包不 await：handler 同步返回，失败由 reportResponseFailure 记录。
            void client
              .respondError(request.id, {
                code: -32602,
                message: "Invalid session runtime preferences request params",
                data: parsed.error.flatten(),
              })
              .catch(reportResponseFailure);
            return;
          }
          // 本机权威模式：设置就在当前进程可读，不需要远端往返。
          // 用异步 IIFE 承接 await，避免 handler 返回 Promise 让协议层等待。
          if (sessionRuntimePreferencesAuthority === "local") {
            void (async () => {
              let preferences: ZCodeSessionRuntimePreferencesResult;
              try {
                // 结果再过 schema：resolveSessionRuntimePreferences 来自注入实现，
                // 必须保证 additionalDirectories 等字段形状符合协议。
                preferences = zcodeSessionRuntimePreferencesResultSchema.parse(
                  // 同一 RPC 承载 runtime 创建与首次执行两个时机；必须继续传递
                  // 已校验的 scope，避免首次执行为了 Shell 再次等待远端 client config。
                  // 兜底默认值必须与 app 侧默认一致，否则「无设置」与「有设置」两条路径行为不同。
                  (await resolveSessionRuntimePreferences?.(parsed.data.scope)) ?? {
                    askUserQuestionAutoResolutionEnabled: true,
                    nativeSearchEnhancementsEnabled: true,
                    memoryEnabled: false,
                  },
                );
                // 只在 runtime-materialization 阶段补 additionalDirectories：该字段需要扫盘/解析项目配置，
                // 每个执行时机都算一遍会拖慢首 token。
                if (
                  parsed.data.scope === "runtime-materialization" &&
                  options?.resolveSessionDirectories
                ) {
                  preferences.additionalDirectories = await options.resolveSessionDirectories({
                    ...workspace,
                    sessionId: parsed.data.sessionId,
                  });
                }
                // 子 agent 配置能力要求 host 装配 reader 且不是远程 workspace：
                // 远程 runtime 的目录结构在本机不可见，声称可用会让子 agent 读到错误路径。
                preferences.subagentRuntimeConfigEnabled =
                  Boolean(options?.readSubagentRuntimeConfig) &&
                  !(
                    workspace.workspaceIdentity &&
                    isRemoteWorkspaceIdentity(workspace.workspaceIdentity)
                  );
              } catch (error) {
                // 读设置失败回 -32603，不降级成默认值：静默降级会让用户设置看似生效实则没有。
                await client.respondError(request.id, {
                  code: -32603,
                  message: error instanceof Error ? error.message : String(error),
                });
                return;
              }
              // 响应发送失败表示 transport 已关闭，不能再把它当成设置读取失败
              // 并尝试发送第二个 error response。
              await client.respond(request.id, preferences);
            })().catch(reportResponseFailure);
            return;
          }

          // 非本机权威：生成自己的 requestId 再转发，不能拿协议 request.id 当业务键——
          // 协议 id 只在单条连接内唯一，Host 侧可能来自另一条连接。
          const requestId = randomUUID();
          const dynamicRequest: ZCodeAgentSessionRuntimePreferencesRequest = {
            ...parsed.data,
            requestId,
          };
          // pending 记录四要素：回包用的 client/protocolRequestId、原始 request（超时日志要 scope）、
          // workspace（身份复核）、timeout。缺任何一条都会让超时清理不完整。
          // [资源] 定时器必须在 takePending 时 clearTimeout，否则响应后仍留下计时器引用。
          pendingSessionRuntimePreferences.set(requestId, {
            client,
            protocolRequestId: request.id,
            request: dynamicRequest,
            workspace,
            // 超时只结束本次请求并回 -32022，不重试也不降级（见 expireSessionRuntimePreferencesRequest）。
            timeout: setTimeout(
              () => expireSessionRuntimePreferencesRequest(requestId),
              ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
            ),
            workspaceKey: resolveWorkspaceKey(workspace),
          });
          // 派发日志带 requestId，用于与 Host 侧 responder 的响应日志对齐；低频事件用 info。
          logger.info(undefined, "运行时偏好请求已转发给 Host", {
            event: "zcode_agent.runtime_preferences.host_request_dispatched",
            module: "services.zcode_agent",
            requestId,
            scope: dynamicRequest.scope,
            sessionId: dynamicRequest.sessionId,
            workspaceKey: resolveWorkspaceKey(workspace),
          });
          // 通过 emitter 广播给 Host 侧 responder；没有订阅者时请求会挂到超时，
          // 这是有意的 fail-closed：不能猜默认值代替用户设置。
          sessionRuntimePreferencesRequestEmitter.fire(dynamicRequest);
          return;
        }

        // 权限请求：CLI 阻塞等待 host 决定。pending map 是「可应答表」，
        // 值里保存 client 与协议 id，权限结果回来时按业务 key 找回。
        if (request.method === zcodeProtocolMethods.interactionRequestPermission) {
          const parsed = zcodePermissionRequestParamsSchema.safeParse(request.params);
          // 参数非法必须 error 应答：CLI 会一直等这个 id，不回包会让整轮对话卡死到传输超时。
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid permission request params",
              data: parsed.error.flatten(),
            });
            return;
          }
          // key = (workspaceKey, sessionId, requestId)，与结果回填时完全同源。
          const key = permissionRequestKey({
            ...workspace,
            sessionId: parsed.data.sessionId,
            requestId: parsed.data.requestId,
          });
          // [并发] 同一业务 request 可能被重发（agent 恢复丢失的 protocol id）：
          // 覆盖 pending 以刷新可应答的 protocolRequestId，但只在首次出现时广播，
          // 否则 UI 上的权限弹窗会被重复请求重置。
          const wasPending = pendingPermissions.has(key);
          pendingPermissions.set(key, {
            client,
            protocolRequestId: request.id,
          // 覆盖写入而非新增：同一业务 request 在表里最多一条，结果回填不会命中旧 client。
          });
          // 只有首次才 emit：重复 emit 会让已展示的弹窗回到初始状态。
          if (!wasPending) {
            emitSessionEvent(workspace, parsed.data.sessionId, {
              type: "permission.request",
              request: parsed.data,
            });
          }
          return;
        }

        // 用户输入请求：语义与权限请求相同，多一条「多问题 AskUserQuestion 分页」约束。
        // 重发时刷新 pending（新 protocol id 才能应答），但不重复广播，
        // 否则用户翻到第 N 个问题时会被重置回第一页。
        if (request.method === zcodeProtocolMethods.interactionRequestUserInput) {
          const parsed = zcodeUserInputRequestParamsSchema.safeParse(request.params);
          // 与权限请求一致：参数非法也必须回 -32602，避免 CLI 永久等待。
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid user input request params",
              data: parsed.error.flatten(),
            });
            return;
          }
          const key = userInputRequestKey({
            ...workspace,
            sessionId: parsed.data.sessionId,
            requestId: parsed.data.requestId,
          });
          // wasPending 必须在覆盖前取值：这是「是否首次」的唯一判据，覆盖后再判断永远为 true。
          const wasPending = pendingUserInputs.has(key);
          // 覆盖而不是跳过：旧 protocol id 已失效，必须保存新的才能正确应答。
          pendingUserInputs.set(key, { client, protocolRequestId: request.id });
          if (!wasPending) {
            // agent 为恢复丢失的 protocol id 会重发同一业务 requestId。
            // host 需要刷新可响应的 protocolRequestId，但不能重复广播给 UI，
            // 否则多问题 AskUserQuestion 会在用户翻到后续问题时被重置回第一页。
            emitSessionEvent(workspace, parsed.data.sessionId, {
              type: "userInput.request",
              request: parsed.data,
            });
          }
          return;
        }

        // provider runtime headers：CLI 执行前向 host 要一组鉴权头。三条出路：
        //   1. 账号型 access（无交互验证）→ host 直接解析并应答；
        //   2. host 没有交互能力 → 立即回 headersApplied:false；
        //   3. 其余 → 进 pending 并广播给 session + workspace 两级订阅者。
        if (request.method === zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders) {
          // 参数非法回 -32602：CLI 据此放弃本次请求，不会阻塞执行。
          const parsed = zcodeProviderRuntimeHeadersRequestParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid provider runtime headers request params",
              data: parsed.error.flatten(),
            });
            return;
          }
          // pending key 与取消通知使用同一个构造器，保证取消能精确定位到这一条；
          // 值里保存 request 是为了取消时能带上 sessionId/requestId 给 UI。
          const pendingKey = providerRuntimeHeadersRequestKey({
            ...workspace,
            sessionId: parsed.data.sessionId,
            requestId: parsed.data.requestId,
          });
          const pending = {
            client,
            protocolRequestId: request.id,
            request: parsed.data,
          };
          // 先登记再分支：无论走自动应答还是 UI，取消/失效都按同一张表清理。
          pendingProviderRuntimeHeaders.set(pendingKey, pending);
          logger.info(request.trace?.traceId, "收到 ZCode provider runtime headers 请求", {
            modelId: parsed.data.modelSelection.modelId,
            providerId: parsed.data.providerId,
            requestId: parsed.data.requestId,
            sessionId: parsed.data.sessionId,
            turnId: parsed.data.turnId ?? null,
            // 日志只记模型/provider/会话标识，不记 header 或凭据内容。
            workspaceKey: resolveWorkspaceKey(workspace),
            workspacePath: workspace.workspacePath,
          });
          // Account API Key / Team Runtime Key 不需要 renderer 交互：host 按 Model 固定的 accountAccess
          // 自动应答，后台任务与无 pane 会话因此不依赖 UI 订阅者。
          const accountAccess = parsed.data.accountAccess;
          if (
            accountRequestAuthService &&
            accountAccess &&
            !requiresRequestVerification(accountAccess)
          ) {
            // Account API Key / Team Runtime Key 不需要 Renderer 交互。Host 按 Model
            // 固定的 Account Access 自动应答，避免后台任务和无 pane 会话依赖 UI 订阅者。
            // 自动应答是异步 IO（解析凭据）；内部以 pending 对象身份复核，
            // 取消后不会把迟到的 header 发给已撤销的请求（INV-05/INV-07）。
            void respondAccountRequestAuthWithoutInteraction({
              key: pendingKey,
              pending,
            });
            return;
          }
          // 没有交互能力就 fail closed：先删 pending 再回包，
          // 避免「已声明不可用但表里还留着可应答记录」的中间态被取消逻辑误处理。
          if (!requestVerificationInteractionAvailable) {
            pendingProviderRuntimeHeaders.delete(pendingKey);
            // 用 pending 里保存的 client 回包，而不是闭包里的 client，避免换代后发错连接。
            void pending.client.respond(pending.protocolRequestId, {
              headersApplied: false,
              errorMessage: "Provider request auth is unavailable",
            });
            return;
          }
          // session 级投递供当前会话 UI 使用；workspace 级镜像供常驻应答方使用，
          // 两路内容相同但订阅口径不同，缺一路就有一类客户端收不到。
          emitSessionEvent(workspace, parsed.data.sessionId, {
            type: "providerRuntimeHeaders.request",
            request: parsed.data,
          });
          // workspace 级镜像投递：桌面窗口常驻应答方（每个打开的 workspace tab 一个）
          // 不感知 sessionId，必须在这里按 workspaceKey 收到同一请求。
          // workspace 级只按 workspaceKey 广播、不带 sessionId：
          // 桌面窗口常驻应答方按 workspace tab 订阅，不知道 session 维度。
          providerRuntimeHeadersWorkspaceEmitters
            .get(resolveWorkspaceKey(workspace))
            ?.fire(parsed.data);
          return;
        }

        // 官方 Server MCP 身份头：纯 RPC 中继，host 自动解析并响应。
        // 不 emitSessionEvent、不进 pending map——该请求没有 UI 语义，renderer 不参与。
        // 安全边界：必须在读取任何凭据之前完成 host 侧可信校验（targetOrigin + mcpKey + pluginId），
        // 未通过即返回，resolver 根本不会被调用，拒绝路径不会触碰凭据。
        if (request.method === zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders) {
          const parsed = zcodeOfficialMcpAuthHeadersRequestParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid interaction/requestOfficialMcpAuthHeaders params",
              data: parsed.error.flatten(),
            });
            return;
          }
          // host 侧二次校验必须发生在**读取凭据之前**：未命中即返回，resolveHeaders 不被调用，
          // 因此不会有任何凭据被读入内存。
          // 用异步 IIFE 包住 await 校验：handler 同步返回，协议层不会阻塞其他请求；
          // 内部所有错误都在分支里转成可枚举 reason。
          void (async () => {
            const trustedOrigins = options?.officialMcpTrustedOrigins;
            // validator 缺省 = 不可信：没有配置可信来源时不能默认放行，否则任何插件都能拿到官方身份头。
            const trust = trustedOrigins
              ? await trustedOrigins
                  .isTrusted({
                    mcpKey: parsed.data.mcpKey,
                    origin: parsed.data.targetOrigin,
                    pluginId: parsed.data.pluginId,
                  })
                  // 校验器自身异常同样按不可信处理：宁可拒绝，不能因异常放行。
                  // 判定自身异常也按不可信处理，绝不因为校验失败就放行。
                  .catch(() => ({ detail: "validator_error", trusted: false }))
              : { detail: "validator_missing", trusted: false };
            // 拒绝日志只记非敏感上下文；此时凭据未被读取，不存在泄露路径。
            if (!trust.trusted) {
              // 只记录非敏感的请求上下文；凭据未被读取，自然也无从泄露。
              logger.warn(request.trace?.traceId, "官方 MCP 身份头请求未通过 host 侧可信校验", {
                detail: trust.detail ?? "unknown",
                mcpKey: parsed.data.mcpKey,
                pluginId: parsed.data.pluginId,
                requestId: parsed.data.requestId,
                targetOrigin: parsed.data.targetOrigin,
                workspaceKey: parsed.data.workspace.workspaceKey,
              });
              // 拒绝原因用稳定字符串：CLI 侧按 reason 分流，不解析 detail 文本。
              void client.respond(request.id, {
                ok: false,
                reason: "official_mcp_origin_untrusted",
              });
              return;
            }
            // resolver 缺省回 official_auth_unavailable：与「不可信」分开，
            // 便于 CLI 区分是配置问题还是来源问题。
            const resolver = options?.officialMcpAuthHeadersResolver;
            if (!resolver) {
              void client.respond(request.id, {
                ok: false,
                reason: "official_auth_unavailable",
              });
              return;
            }
            // 解析可能耗时（读 keychain/网络）：成功与否都按可枚举 reason 回包，
            // 绝不抛裸异常让 adapter 无法分流。
            try {
              const resolveStartedAt = Date.now();
              const result = await resolver.resolveHeaders({
                mcpKey: parsed.data.mcpKey,
                pluginId: parsed.data.pluginId,
                targetOrigin: parsed.data.targetOrigin,
                workspace: parsed.data.workspace,
              });
              // host 侧不能只在失败时留日志，成功路径完全静默会无法回答"到底发了哪几个头"。
              // 只记 header 名与套餐维度：凭证值绝不入日志（日志留存周期不受控）。
              // 成功路径必须留日志：只记失败会让「到底发了哪几个头」无法回答；
              // 只记 header 名与套餐维度，凭证值绝不入日志（日志留存周期不受控）。
              if (result.ok) {
                // 首次签发用 info、后续用 debug：生产可回答「是否曾经发过」，高频请求又不打爆日志。
                const firstIssuance = officialMcpIssuanceAudit.markFirst(
                  parsed.data.pluginId,
                  parsed.data.mcpKey,
                  parsed.data.workspace.workspaceKey,
                );
                const logIssuance = firstIssuance ? logger.info : logger.debug;
                logIssuance(request.trace?.traceId, "官方 MCP 身份头已解析", {
                  firstIssuance,
                  ...summarizeOfficialMcpIdentityHeaders(result.headers),
                  mcpKey: parsed.data.mcpKey,
                  pluginId: parsed.data.pluginId,
                  requestId: parsed.data.requestId,
                  resolveDurationMs: Date.now() - resolveStartedAt,
                  targetOrigin: parsed.data.targetOrigin,
                });
              } else {
                logger.info(request.trace?.traceId, "官方 MCP 身份头不可用", {
                  mcpKey: parsed.data.mcpKey,
                  pluginId: parsed.data.pluginId,
                  reason: result.reason,
                  requestId: parsed.data.requestId,
                  resolveDurationMs: Date.now() - resolveStartedAt,
                  targetOrigin: parsed.data.targetOrigin,
                });
              }
              void client.respond(request.id, result);
            // 解析异常不 respondError 而是回 ok:false：adapter 只按可枚举 reason 分流，
            // 且绝不能让 MCP 退化成匿名请求继续执行。
            } catch (error: unknown) {
              // 解析异常按不可用返回而非 respondError：adapter 只按可枚举 reason 分流，
              // 且此处绝不能让 MCP 退化成匿名请求。凭证原文不进日志。
              logger.warn(request.trace?.traceId, "官方 MCP 身份头解析失败", {
                error: error instanceof Error ? error.message : String(error),
                mcpKey: parsed.data.mcpKey,
                pluginId: parsed.data.pluginId,
                requestId: parsed.data.requestId,
                targetOrigin: parsed.data.targetOrigin,
              });
              // 异常统一映射到 official_auth_unavailable，不把内部错误文本传给 CLI。
              void client.respond(request.id, {
                ok: false,
                reason: "official_auth_unavailable",
              });
            }
          })();
          return;
        }

        // browser-use discovery：backend 在线状态与 plugin/skill 是否暴露是两层状态。
        // executor 缺省时返回空列表，禁止 facade 伪造 IAB available。
        // browser list 是 discovery：backend 在线状态与 plugin/skill 是否暴露是两层状态，
        // 不能用「方法存在」推断 IAB 可用（INV-06）。
        if (request.method === zcodeProtocolMethods.interactionBrowserList) {
          const parsed = zcodeBrowserListParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid interaction/browserList params",
              data: parsed.error.flatten(),
            });
            return;
          }
          // executor 缺省返回空列表而不是报错：discovery 允许「没有可用浏览器」，但绝不能伪造可用条目。
          const executor = options?.browserControlExecutor;
          if (!executor) {
            void client.respond(request.id, { browsers: [] });
            return;
          }
          void executor
            .list(parsed.data)
            // 成功回包只含 browsers 数组，不附加 host 侧诊断字段。
            .then((browsers) => client.respond(request.id, { browsers }))
            .catch((error: unknown) => {
// discovery 失败回 -32603，由 CLI 决定是否提示；facade 不回退成空列表。
              void client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            });
          return;
        }

        // browser-use：agent 的 agent.browsers.* 经 interaction/browserExecute 到达这里。
        // 纯 RPC 中继——转发给 main（WebContentsView+CDP）执行后 respondResult，不 emitSessionEvent、
        // 不进 pending map（区别于 permission 的 UI 阻塞语义）。executor 缺省则 backend_unavailable。
        // browser execute 是纯 RPC 中继：转发给 main 执行后回包，不 emitSessionEvent、不进 pending——
        // 它没有 UI 阻塞语义。
        if (request.method === zcodeProtocolMethods.interactionBrowserExecute) {
          const parsed = zcodeBrowserExecuteParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid interaction/browserExecute params",
              data: parsed.error.flatten(),
            });
            return;
          }
          // 缺省时回 backend_unavailable（稳定 code）而不是 -32603：
          // CLI 侧按 code 决定是否提示用户安装 backend。
          const executor = options?.browserControlExecutor;
          if (!executor) {
            void client.respond(request.id, {
              ok: false,
              error: {
                code: "backend_unavailable",
                message: "browser control not available",
              },
              elapsedMs: 0,
            });
            return;
          }
          // 参数投影时 workspace 优先取 CLI 传来的值（可能是远程 workspace），再用当前 wire 的兜底；
          // 身份三字段必须成套传递（INV-02）。
          void executor
            .execute({
              requestId: parsed.data.requestId,
              ...(parsed.data.browserId ? { browserId: parsed.data.browserId } : {}),
              ...(parsed.data.browserGeneration !== undefined
                ? { browserGeneration: parsed.data.browserGeneration }
                : {}),
              sessionId: parsed.data.sessionId,
              ...(parsed.data.turnId ? { turnId: parsed.data.turnId } : {}),
              workspaceKey: parsed.data.workspaceKey ?? resolveWorkspaceKey(workspace),
              workspacePath: parsed.data.workspacePath ?? workspace.workspacePath,
              ...((parsed.data.workspaceIdentity ?? workspace.workspaceIdentity)
                ? {
                    workspaceIdentity: parsed.data.workspaceIdentity ?? workspace.workspaceIdentity,
                  }
                : {}),
              ...(parsed.data.remoteSessionId
                ? { remoteSessionId: parsed.data.remoteSessionId }
                : {}),
              // clientMode/sessionContext 缺省按桌面连续流处理，与 resolveV4Connection 的默认一致。
              clientMode: parsed.data.clientMode ?? "desktop-continuous",
              sessionContext: parsed.data.sessionContext ?? "live",
              command: parsed.data.command,
            })
            .then((result) => client.respond(request.id, result))
            .catch((error: unknown) => {
// 执行失败用 execution_error + elapsedMs:0 回包，保持与成功响应同一信封形状。
              void client.respond(request.id, {
                ok: false,
                error: {
                  code: "execution_error",
// 只回 message 文本，不回 stack 与 cause，避免把 Host 内部路径带到 CLI。
                  message: error instanceof Error ? error.message : String(error),
                },
                elapsedMs: 0,
              });
            });
// 不重新抛：错误已通过 respond 回到 CLI，rethrow 只会变成未处理 rejection。
          return;
        }

        // automation/create：会话内创建定时任务。workspace 由 host 从当前 session 注入，
        // 不信任协议参数，避免把任务写到别的 workspace。
        if (request.method === zcodeProtocolMethods.automationCreate) {
          const parsed = zcodeAutomationCreateParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation create params",
              data: parsed.error.flatten(),
            });
            return;
          }
          // 用 IIFE 承接 await：不让协议层等待整个创建链（含任务索引回写）。
          void (async () => {
            try {
              const automation = await automationService.create({
                title: parsed.data.title ?? "",
                cronExpr: parsed.data.cronExpr,
                relativeDelayMinutes: parsed.data.relativeDelayMinutes,
                // 会话侧长间隔 carrier（intervalUnit+interval）透传给 service 归一化为权威 scheduleRule。
                intervalUnit: parsed.data.intervalUnit,
                interval: parsed.data.interval,
                prompt: parsed.data.prompt,
                modelSelection: parsed.data.modelSelection,
                mode: parsed.data.mode,
                targetTaskId: parsed.data.targetTaskId,
                botDeliveryTarget: parsed.data.botDeliveryTarget,
                // workspace 三件套由 host 注入，automation service 是该状态的唯一写入方。
                workspacePath: workspace.workspacePath,
                workspaceIdentity: workspace.workspaceIdentity,
                recurring: parsed.data.recurring ?? true,
                maxRuns: parsed.data.maxRuns,
              });
              // targetTaskId 存在时回写任务展示元数据：会话内创建的 automation 复用当前 session，
              // 侧栏需要这个标记才能把 automation 归到目标任务下。
              if (automation.targetTaskId) {
                // getTaskMeta 失败按 null 处理：任务可能刚被删除（INV-09 的「旧数据没有该字段」分支），
                // 这不影响 automation 本身创建成功，不能因此回滚。
                const taskMeta = await automationTaskIndexRepo
                  .getTaskMeta({
                    workspacePath: automation.workspacePath,
                    workspaceIdentity: automation.workspaceIdentity,
                    taskId: automation.targetTaskId,
                  })
                  .catch(() => null);
                if (taskMeta) {
                  await automationTaskIndexRepo.updateTaskPresentation({
                    ...taskMeta,
                    // 展示元数据写入失败会向上抛给外层 catch：automation 已创建，但侧栏标记缺失需要暴露。
                    presentation: {
                      // 会话内创建的 automation 复用当前 session；显式写入标记供 V4 侧栏展示。
                      cronAutomationId: automation.automationId,
                    },
                  });
                }
              }
              await client.respond(request.id, {
                automation: toProtocolAutomation(automation),
              });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        // off-peak/create：闲时任务。workspace 同样由 host 注入，所有校验在取号前完成，
        // 避免把非法模型写进任务库。
        if (request.method === zcodeProtocolMethods.offPeakCreate) {
          const parsed = zcodeOffPeakCreateParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid off-peak create params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              // service 未装配回 -32601（method not found 语义）而不是 -32603：
              // CLI 据此判定该 host 不支持能力，直接隐藏入口。
              const offPeakTaskService = options?.resolveOffPeakTaskService?.();
              if (!offPeakTaskService) {
                await client.respondError(request.id, {
                  code: -32601,
                  message: "Off-peak task service is unavailable on this host",
                });
                return;
              }
              // 灰度配置读取失败按 undefined 处理：白名单为空后统一走 offpeak_disabled，
              // 而不是把异常抛给 CLI。
              const grayConfig = await options
                ?.resolveOffPeakClientConfig?.()
                // 配置读取失败不阻断入口：后面按白名单为空处理，返回稳定失败分类。
                .catch(() => undefined);
              // 工具注册后灰度被关闭/配置解析失败时，不能继续走"白名单为空"的推导
              // （显式 model 会误报 model_not_allowed，省略 model 会以空模型落库）；直接返回稳定分类。
              // 模型视图可同时包含两个域；必须用已有支持快照确认归属，不能从首个 Provider 猜。
              // 只有白名单非空才去问 coding plan 支持：省一次远端调用，
              // 也避免功能关闭时把「套餐不支持」误报给用户。
              const support =
                resolveOffPeakAllowedModels(grayConfig).length > 0
                  ? await offPeakTaskService.getCodingPlanSupport()
                  : undefined;
              // providerId 来自支持快照，不从模型视图的第一个 Provider 猜（多域视图会猜错）。
              const providerId = support?.supported
                ? OFF_PEAK_PROVIDER_IDS[support.providerFamily]
                : undefined;
              // 白名单按 providerFamily 再过滤一次：模型视图可能同时包含两个域，
              // 不过滤会把另一个域的模型放进来。
              const allowedModels = providerId
                ? resolveOffPeakAllowedModels(grayConfig, providerId)
                : [];
              // 失败分类原样过协议（不 respondError）：CLI handler 需要把 offpeak_disabled
              // 翻译成稳定的用户提示，而不是一条 JSON-RPC 内部错误。
              if (allowedModels.length === 0) {
                await client.respond(request.id, {
                  ok: false,
                  failureStage: "client_validation",
                  errorCategory: "client_validation",
                  errorCode: "offpeak_disabled",
                });
                return;
              }
              // model 白名单预校：显式入参不在白名单返回稳定分类，
              // 复用 client_validation 分类 + 专用 errorCode，不扩分类枚举。
              // 匹配与 thoughtLevel/UI 同语义（trim + 大小写不敏感），命中后回写白名单原写法。
              // 返回 null 表示显式 model 不在白名单；命中时回写白名单里的原写法，保证大小写一致。
              const model = resolveOffPeakCreateModel(allowedModels, parsed.data.model);
              if (model === null) {
                await client.respond(request.id, {
                  ok: false,
                  failureStage: "client_validation",
                  errorCategory: "client_validation",
                  errorCode: "model_not_allowed",
                });
                return;
              }
              // 用灰度视图把 (provider, model, thoughtLevel) 解析成完整 modelSelection；解析不到按不允许处理。
              const modelSelection =
                grayConfig && providerId
                  ? resolveOffPeakToolSelection(
                      grayConfig.modelSelectionView,
                      providerId,
                      model,
                      parsed.data.thoughtLevel,
                    )
                  : undefined;
              if (!modelSelection) {
                await client.respond(request.id, {
                  ok: false,
                  failureStage: "client_validation",
                  errorCategory: "client_validation",
                  errorCode: "model_not_allowed",
                });
                return;
              }
              // 真正的创建调用：permissionMode 缺省 yolo，与闲时无人值守语义一致；
              // boundSessionId 只在会话内创建时携带，派发时 resume 该会话执行。
              const result = await offPeakTaskService.createTask({
                title: parsed.data.title,
                prompt: parsed.data.prompt,
                permissionMode: parsed.data.permissionMode ?? "yolo",
                modelSelection,
                // 会话内创建绑定当前会话，派发时 resume 该会话执行。
                // 绑定会话是可选字段：不带时是独立的闲时任务，不能伪造一个 sessionId。
                ...(parsed.data.boundSessionId
                  ? { boundSessionId: parsed.data.boundSessionId }
                  : {}),
                // workspace 由 host 注入（对称 automation/create），协议参数里没有这一项。
                // workspace 由 host 从当前 session 注入（对称 automation/create），不进协议参数。
                workspacePath: workspace.workspacePath,
                ...(workspace.workspaceIdentity
                  ? { workspaceIdentity: workspace.workspaceIdentity }
                  : {}),
              });
              if (!result.ok) {
                // 失败分类原样过协议（不 respondError），供 CLI handler 翻译为稳定错误。
                await client.respond(request.id, {
                  ok: false,
                  failureStage: result.failureStage,
                  errorCategory: result.errorCategory,
                  errorCode: result.errorCode,
                });
                return;
              }
              await client.respond(request.id, {
                ok: true,
                task: toProtocolOffPeakTaskSnapshot(result.task),
              });
            } catch (error) {
              // 内部错误走统一封装，避免把栈/绝对路径透给 CLI。
              await respondOffPeakInternalError(client, request, workspace, error);
            }
          })();
          return;
        }

        // off-peak/list 只返回当前 workspace 的任务，并按创建时间倒序截断 20 条：
        // 列表是 UI 视图，不能把 host 上所有 workspace 的任务混在一起。
        if (request.method === zcodeProtocolMethods.offPeakList) {
          const parsed = zcodeOffPeakListParamsSchema.safeParse(request.params ?? {});
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid off-peak list params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
// 用 IIFE 而非 await：handler 需同步返回，响应在后台完成后发出。
            try {
              // 每次 list 都重新取 service：host 可能在运行期装配或卸载该能力。
              const offPeakTaskService = options?.resolveOffPeakTaskService?.();
              if (!offPeakTaskService) {
                await client.respondError(request.id, {
                  code: -32601,
                  message: "Off-peak task service is unavailable on this host",
                });
                return;
              }
              // 过滤口径与 activeClientsByWorkspaceKey 一致（INV-02），远程 identity 不会误配同路径本地任务。
              const workspaceKey = resolveWorkspaceKey(workspace);
              // list() 是进程级全量，必须先按 workspace 过滤再排序截断。
              const tasks = (await offPeakTaskService.list())
                .filter((task) => task.workspaceKey === workspaceKey)
                .sort((a, b) => b.createdAt - a.createdAt)
                .slice(0, 20);
              await client.respond(request.id, {
                tasks: tasks.map(toProtocolOffPeakTaskSnapshot),
              });
            } catch (error) {
              await respondOffPeakInternalError(client, request, workspace, error);
            }
          })();
          return;
        }

        // automation/list 的 workspace 由 host 注入：CLI 无法指定要列哪个 workspace，
        // 避免越权读取其他人的定时任务。
        if (request.method === zcodeProtocolMethods.automationList) {
          const parsed = zcodeAutomationListParamsSchema.safeParse(request.params ?? {});
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation list params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            // 列表按 workspace 读取，service 负责过滤与排序口径。
// 后台执行，失败通过 respondError 回包，不影响 handler 的同步返回。
            try {
              const automations = await automationService.list(workspace);
              await client.respond(request.id, {
                automations: automations.map(toProtocolAutomation),
              });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        // task binding 检查只读：用于 UI 判断某任务是否已有 automation，不修改任何状态。
        if (request.method === zcodeProtocolMethods.automationCheckTaskBinding) {
          const parsed = zcodeAutomationCheckTaskBindingParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation task binding params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            // 只读查询，不创建也不补写绑定关系。
// workspace 由 host 注入，CLI 只能问「当前 workspace 的这个任务」。
            try {
              const bound = await automationService.hasTaskBinding({
                workspacePath: workspace.workspacePath,
                workspaceIdentity: workspace.workspaceIdentity,
                targetTaskId: parsed.data.targetTaskId,
              });
// 只回 bound 布尔，不附带任务详情：绑定检查不承担读取任务内容的职责。
              await client.respond(request.id, { bound });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        // automation/update：只允许改本 workspace 的任务；service 内部按 workspace 过滤，
        // 找不到时返回 undefined，这里转成明确错误而不是静默成功。
        if (request.method === zcodeProtocolMethods.automationUpdate) {
          const parsed = zcodeAutomationUpdateParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation update params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            // 更新入参只透传协议允许修改的字段，不整包展开 parsed.data。
            try {
              const automation = await automationService.update(
                parsed.data.automationId,
                {
                  title: parsed.data.title,
                  cronExpr: parsed.data.cronExpr,
                  prompt: parsed.data.prompt,
                  // recurring/maxRuns 允许显式 undefined：undefined 表示「不修改」，与 false/0 语义不同，
                  // 不能在这里补默认值。
                  recurring: parsed.data.recurring,
                  maxRuns: parsed.data.maxRuns,
                  // 会话侧长间隔 carrier（intervalUnit+interval）透传给 service 归一化为权威 scheduleRule。
                  intervalUnit: parsed.data.intervalUnit,
                  interval: parsed.data.interval,
                },
                workspace,
              );
              // 找不到任务必须抛错：UI 需要区分「已删除」与「更新成功」，
              // 静默返回成功会让列表与后端长期不一致。
              if (!automation) {
                throw new Error("Scheduled task not found in the current workspace.");
              }
              await client.respond(request.id, {
                automation: toProtocolAutomation(automation),
              });
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        // automation/delete：删除同样受 workspace 约束；deleted=false 表示本来就不存在，
        // 按幂等删除处理，不当作错误。
        if (request.method === zcodeProtocolMethods.automationDelete) {
          const parsed = zcodeAutomationDeleteParamsSchema.safeParse(request.params);
          if (!parsed.success) {
            void client.respondError(request.id, {
              code: -32602,
              message: "Invalid automation delete params",
              data: parsed.error.flatten(),
            });
            return;
          }
          void (async () => {
            try {
              // 删除结果原样回给 CLI，由 UI 决定是否刷新列表。
              const deleted = await automationService.delete(parsed.data.automationId, workspace);
              await client.respond(request.id, { deleted });
            // 删除失败统一 -32603；「本来就不存在」由 deleted=false 表达，不走异常。
            } catch (error) {
              await client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          })();
          return;
        }

        // 未知方法统一 -32601：这是协议层唯一允许的「能力不存在」信号，
        // 不能静默丢弃，否则 CLI 会一直等待响应直到超时。
        void client.respondError(request.id, {
          code: -32601,
          message: `Unsupported ZCode Protocol request: ${request.method}`,
        });
      }),
      // [资源] client 关闭是最终失效边界：释放该 client 的 pending、订阅与 disposables，
      // 并只在 active 表仍指向它时删除 entry（INV-03/INV-07）；
      // 迟到的旧 client 关闭不能误删同 workspace 的新 client。
      client.onClose(() => {
        invalidateWorkspaceClient(resolveWorkspaceKey(workspace), client);
      }),
    ];
    // 登记到 WeakMap：client 被回收后条目自动消失，不构成进程级泄漏。
    clientDisposables.set(client, disposables);
  }

  // 记录会话 traceId：snapshot.session.traceId 是 CLI 侧生成的权威值，
  // host 只按 sessionEventKey 缓存用于后续日志关联，不参与任何判定。
  function rememberSessionTrace(
    target: ZCodeAgentSessionTarget,
    snapshot: ZCodeSessionStateSnapshot,
  ): TraceId | undefined {
    // 只缓存非空值：空 traceId 覆盖已有值会让后续日志丢失关联 id。
// traceId 是只读缓存，函数本身不改变 snapshot，也不向 CLI 回写。
    const traceId = snapshot.session.traceId as TraceId | undefined;
    if (traceId) {
      sessionTraceIdBySessionKey.set(sessionEventKey(target), traceId);
    }
    return traceId;
  }

  // 读取侧不做 fallback：traceId 缺失就是缺失，不能拿别的会话的值顶替。
  function getSessionTraceId(target: ZCodeAgentSessionTarget): TraceId | undefined {
    return sessionTraceIdBySessionKey.get(sessionEventKey(target));
  }

  // provider 未就绪错误：稳定 code + 结构化 data，让上层按 code 分流（不解析 message）。
  // data 带 providerCount/revision/workspaceKey：调用方据此判断是「完全没配」还是「配置还没生效」。
  function createProviderNotReadyError(params: {
    snapshot?: ZCodeAgentProviderReadinessSnapshot;
    workspace: ZCodeAgentWorkspaceTarget;
  }): Error & {
    code: typeof ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
    data: {
      providerCount: number;
      reason: typeof ZCODE_AGENT_PROVIDER_NOT_READY_REASON;
      revision: string | null;
      workspaceKey: string;
      workspacePath: string;
    };
  } {
    // workspaceKey 走统一口径（INV-02），错误数据与缓存 key 使用同一身份。
    const workspaceKey = resolveWorkspaceKey(params.workspace);
    const error = new Error("当前没有可用的模型供应商和模型，请先登录或配置 API Key。") as Error & {
      code: typeof ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
      data: {
        providerCount: number;
        reason: typeof ZCODE_AGENT_PROVIDER_NOT_READY_REASON;
        revision: string | null;
        workspaceKey: string;
        workspacePath: string;
      };
    };
    // 先构造普通 Error 再挂 code/data：保持 instanceof Error 成立，
    // 同时满足 isProviderNotReadyError 的窄化判断。
    error.code = ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
// 快照缺失时 providerCount 记 0、revision 记 null，表达「无法判定」而不是伪造一个可用快照。
    error.data = {
      providerCount: params.snapshot?.providerCount ?? 0,
      reason: ZCODE_AGENT_PROVIDER_NOT_READY_REASON,
      revision: params.snapshot?.revision ?? null,
      workspaceKey,
      workspacePath: params.workspace.workspacePath,
    };
    return error;
  }

  // 类型守卫只认 code：message 文案会随产品文案调整，按文本判断会在改文案时静默失效（INV-05）。
  function isProviderNotReadyError(
    error: unknown,
  ): error is Error & { code: typeof ZCODE_AGENT_PROVIDER_NOT_READY_CODE } {
// 先确认是 Error 实例，再比较 code 常量；不读取 message 或 data 做二次判断。
    return (
      error instanceof Error &&
      (error as { code?: unknown }).code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE
    );
  }

  // 启动就绪快照：只有注入了 modelSelectionReadinessSource 才可判断；
  // 未注入时返回 undefined，由调用方按「不可判定」处理，不能默认 ready。
  async function resolveStartupReadiness(): Promise<
    ZCodeAgentProviderReadinessSnapshot | undefined
  > {
    // 每次启动都现读视图：provider 可能在进程启动后新增，缓存会让第一次启动永远被判未就绪。
// 未注入 source 时直接落到 undefined，调用方必须按「不可判定」处理。
    if (modelSelectionReadinessSource) {
      return createProviderReadinessSnapshotFromSelectionView(
        await modelSelectionReadinessSource.getView(),
      );
    }
    return undefined;
  }

  /**
   * stop/取消 RPC 超时或 watchdog 会回收 client/进程，但进程异步退出，
   * client.onClose 尚未触发时 activeClientsByWorkspaceKey 仍指向已 disposed 的 client。
   * 所有复用 active entry 的路径必须先经过本检查；disposed 时清理 stale entry 并返回 false，
   * 让调用方重新拉起进程（start-if-needed）或按“无运行时”处理（existing-only）。
   */
  // 返回 false 的两种含义：没有 entry，或 entry 已失效并被本条清理。
  // 调用方必须重新拉起进程（start-if-needed）或按无运行时处理（existing-only），
  // 不能把 false 当成「暂时不可用」继续使用 active.client（INV-12）。
  function isReusableActiveClientEntry(
    params: ZCodeAgentWorkspaceTarget,
    active: ActiveWorkspaceClient | undefined,
  ): boolean {
    // 无 entry 时只返回 false，不在这里创建：创建责任属于 getOrStartReadOnlyClient。
    if (!active) {
      return false;
    }
    // isDisposed 是 transport 关闭后的第一手信号，比 onClose 事件更早可用；
    // 用它挡住复用可以避免向已关闭的 socket 发请求。
    if (!active.client.isDisposed) {
      return true;
    }
    // 清理 stale entry 时一并删偏好链：旧 client 的串行链继续执行会向已 dispose 的 transport 写。
    const workspaceKey = resolveWorkspaceKey(params);
    activeClientsByWorkspaceKey.delete(workspaceKey);
    interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
    // warn 而不是 debug：stale entry 说明有路径没走 onClose，属于需要观测的异常；
    // 但它可恢复，不升级为 error。
    logger.warn(undefined, "复用的 ZCode Protocol client 已 disposed，清理 stale entry", {
      workspaceKey,
      workspacePath: params.workspacePath,
    });
    return false;
  }

  // 只读 client 获取：先复用（并等待交互偏好就绪），否则拉起进程并登记 entry。
  // 失败语义：偏好同步失败会移除 entry 并上抛，避免留下「已登记但未配置」的半成品 client。
  async function getOrStartReadOnlyClient(
    params: ZCodeAgentWorkspaceTarget,
  ): Promise<ActiveWorkspaceClient> {
    // key 口径 INV-02；同一路径不同 identity 的 workspace 必须各自持有 client。
    const workspaceKey = resolveWorkspaceKey(params);
    const active = activeClientsByWorkspaceKey.get(workspaceKey);
    // 复用前必须过 isReusableActiveClientEntry：它会清掉已 dispose 的 stale entry，
    // 直接复用会把请求发给已关闭的 client。
    if (active && isReusableActiveClientEntry(params, active)) {
      // 覆盖 workspace 引用：调用方可能补了 remoteSessionId/identity，
      // 后续所有按 active.workspace 的路由都必须看到最新值。
      active.workspace = params;
      // 等偏好就绪再让调用方使用：新 CLI 的交互行为在同步完成前是旧值，
      // 提前放行会让第一轮对话按错误偏好执行。
      await active.interactionPreferencesReady;
      return active;
    }

    // processManager 内部按 workspaceKey 做 single-flight：并发调用只会拉起一个进程；
    // 返回的 client 仍要由本层 wire 一次（幂等）。
    const client = await processManager.getClient(params);
    // lane=chat：该进程由聊天/会话控制面拉起，资源样本归到 chat 泳道。
    wireClient(client, params, "chat");

    // processManager 会按 workspaceKey 对并发启动 single-flight。await 期间若另一条
    // read/write 路径已登记同一 client，必须复用现有 entry，不能把已提升的写能力降回 false。
    // 再次读取：上面的 await 期间可能有另一条 read/write 路径先登记了 entry。
    const concurrent = activeClientsByWorkspaceKey.get(workspaceKey);
    // 复用 concurrent 而不是覆盖：覆盖会丢掉它已提升的 modelExecutionEnabled=true，
    // 让后续 create/command 重新被门禁拦住。
    if (concurrent && isReusableActiveClientEntry(params, concurrent)) {
      // 同样刷新 workspace 引用，语义与上头的复用分支一致。
      concurrent.workspace = params;
      // 若偏好 Promise 已被 finally 删除，await undefined 等价于立即完成。
      await concurrent.interactionPreferencesReady;
      return concurrent;
    }

    // [资源] 只读启动路径先登记 entry 才允许 session 工作：此时 modelExecutionEnabled=false，
    // 语义是「已有控制面进程，但 provider/model 门禁尚未放行」。若这里直接置 true，只读
    // topic/list 路径就能绕过 startModelExecutionClient 的 readiness 检查发起模型执行。
    // entry 是本次对 activeClientsByWorkspaceKey 的登记，先登记再同步偏好，后续并发开关
    // 会因 entry 已存在而排进同一 workspace 串行链（INV-03）。
    const entry: ActiveWorkspaceClient = {
      client,
      modelExecutionEnabled: false,
      workspace: params,
      dynamicWorkflowPolicyMode: "disabled",
    };
    activeClientsByWorkspaceKey.set(workspaceKey, entry);
    // [并发] 偏好同步用 while 循环「追平快照」而不是只发一次：await 期间 desktop 可能又推来
    // 新偏好，只发初始快照会让旧值最后落地。appliedSnapshot 只在 request 成功后前进；
    // 失败原样抛出并由外层删除 entry，避免「进程已起、偏好没同步」被当成就绪。
    const interactionPreferencesReady = (async () => {
      let appliedSnapshot: ZCodeAgentAppRuntimePreferences | undefined;
      // 比较引用而非内容：latestAppRuntimePreferences 每次同步整体替换对象，引用变化即代表
      // 有新提交。改成深比较会让构造期间的两次相等快照多打一轮无意义 RPC。
      while (latestAppRuntimePreferences && latestAppRuntimePreferences !== appliedSnapshot) {
        const snapshot = latestAppRuntimePreferences;
        await enqueueInteractionPreferenceSync({
          client,
          preferences: { ...snapshot },
          workspace: params,
        });
        appliedSnapshot = snapshot;
      }
    })();
    // 下面三项 workspace 级策略同步必须在就绪前落地：CLI 是冷恢复的唯一事实源，
    // 等到 create 时才发，恢复出的会话在首个请求前看不到对应工具（INV-01：Host 不补投影）。
    // Off-Peak 本地支持能力是 workspace 级事实，在允许任何 session 工作前同步到 CLI，
    // 让 v4 冷恢复（没有 per-request flag 通道）也能拿到工具面。旧 CLI method-not-found 降级忽略。
    // CLI 缺省即 false，且每个 agent 进程只服务一个 workspace，门禁关闭时不发请求（对未实现该
    // 方法的旧 CLI/测试假客户端零打扰）。
    // [失败路径] 同步失败不 reject：offPeakToolPolicyReady 的契约是「尽力而为」，
    // 只有 interactionPreferencesReady 的硬失败才回滚 entry。若这里 throw，一次 IPC 抖动
    // 就会让整个 workspace 建不起只读控制面，连非 Off-Peak 的列表页都打不开。
    const offPeakToolPolicyReady = (async () => {
      if (!isOffPeakToolSupported(params)) return;
      try {
        // 只发 enabled:true：能力可用性由 Host 判定（isOffPeakToolSupported），CLI 只记录
        // 该 workspace 是否注册 Off-Peak 工具；重复调用幂等，不携带套餐/灰度结论。
        await client.request(
          zcodeProtocolMethods.workspaceUpdateOffPeakToolPolicy,
          { workspace: buildWorkspaceRef(params), enabled: true },
          zcodeWorkspaceUpdateOffPeakToolPolicyResultSchema,
        );
      // [失败路径] -32601 静默：旧 CLI 根本不认识该方法，属正常降级；其余错误仅 warn，
      // 因为失败方向是 fail-closed（CLI 缺省不注册工具），不会产生越权能力。
      } catch (error) {
        // 策略同步是尽力而为的能力分发，失败方向是 fail-closed（CLI 缺省不注册工具），
        // 超时/暂时性 IPC 错误不得阻断客户端就绪；-32601 是旧 CLI 的正常降级。
        if (!isProtocolMethodNotFoundError(error)) {
          logger.warn(undefined, "Off-Peak 工具策略同步失败，CLI 维持缺省关闭", {
            workspaceKey,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    // 动态工作流与 Off-Peak 的差异：灰度对远程 workspace 同样生效，且模式（alwaysOn/onDemand）
    // 要随策略一起下发，所以走独立串行链而不是复用上面的 offPeak 请求。
    // 动态工作流灰度门禁：与 Off-Peak 同一
    // 模式的 workspace 级事实，在允许任何 session 工作前同步给 CLI，v4 冷恢复也才拿得到工具面。
    // 生效模式为关闭时不发请求（CLI 缺省即关闭，对旧 CLI/测试假客户端零打扰）；之后用户改选择时
    // 经同一条 workspace 串行链重发（launch.md「The user's choice」）。
    // enqueueDynamicWorkflowPolicySync 在入队时登记、执行时才读取生效模式，因此这里拿到的
    // Promise 已代表「本 workspace 的首个策略落地」，可直接并入统一就绪屏障。
    const dynamicWorkflowPolicyReady = enqueueDynamicWorkflowPolicySync(entry);
    // [并发] 用 Promise.all 合成单一屏障：三条同步彼此独立，任一失败即整体失败；
    // 用 allSettled 会把 off-peak 失败也变成硬失败，违背上文的降级语义。
    entry.interactionPreferencesReady = Promise.all([
      interactionPreferencesReady,
      offPeakToolPolicyReady,
      dynamicWorkflowPolicyReady,
    ]).then(() => undefined);
    // [失败路径] 就绪屏障失败必须回滚刚登记的 entry：否则 activeClientsByWorkspaceKey
    // 会留下「进程在、偏好未同步」的 entry，后续 getClient 会把它当可复用 client，
    // 让下一次会话带着缺省偏好运行（INV-03 的 generation 语义）。
    try {
      // 新建或重启 runtime 在允许任何 session 工作前追平缓存；同步期间的新开关
      // 会因 entry 已登记而进入同一 workspace 串行队列，不会丢失提交顺序。
      await entry.interactionPreferencesReady;
    } catch (error) {
      // identity guard：await 期间该 workspace 可能已被 release/换代并登记新 entry，
      // 只能删自己这一份；无条件 delete 会误删新 client 的登记并触发重复拉起。
      if (activeClientsByWorkspaceKey.get(workspaceKey) === entry) {
        activeClientsByWorkspaceKey.delete(workspaceKey);
      }
      throw error;
    // [资源] 无论成败都清掉临时就绪字段：它是「启动窗口」标记，不是长期状态；
    // 留着会让后续复用路径 await 一个已 settled 的旧 Promise，误判同步仍在进行。
    } finally {
      delete entry.interactionPreferencesReady;
    }
    // info 而非 debug：workspace 控制面启动是低频生命周期事件，也是排查
    // 「为何本进程存在」的关键证据（packages/services AGENTS.md 的日志口径）。
    logger.info(undefined, "为只读会话控制面启动 ZCode agent", {
      workspaceKey,
      workspacePath: params.workspacePath,
    });
    return entry;
  }

  // getClient 是模型执行路径的唯一入口（create/resume/send/compact 都经此），因此同时承担
  // 三道门禁：active client 复用校验、并发启动 single-flight、provider/model readiness。
  // 与 getReadOnlyClient 的关键差别：只有本函数推进 modelExecutionEnabled，观察类调用不得复用该副作用。
  async function getClient(params: ZCodeAgentWorkspaceTarget) {
    const workspaceKey = resolveWorkspaceKey(params);
    const active = activeClientsByWorkspaceKey.get(workspaceKey);
    // [并发] 复用前必须同时满足两个条件：entry 曾通过模型门禁（modelExecutionEnabled），
    // 且 client 未被 dispose（isReusableActiveClientEntry 会顺手清理 stale entry）。
    // 只检查 client 存活会让只读启动的进程被 create 直接复用，绕过 readiness 检查。
    if (active?.modelExecutionEnabled && isReusableActiveClientEntry(params, active)) {
      // 回写 workspace：同一 workspaceKey（identity 优先）可能由不同 workspacePath 表示
      // （符号链接/远程映射）。协议参数统一取最新路径，避免把旧路径带进 workspace 级命令（INV-02）。
      active.workspace = params;
      return active.client;
    }

    // [并发] waiting 记录是「本次启动意图」的 identity：release 会把 cancelled 置 true 并移出 map，
    // 迟到的 continuation 据此判断自己是否还拥有启动权。若只缓存 Promise 而没有 identity，
    // release 后旧 continuation 仍会创建新进程（INV-03/INV-12）。
    const waiting: WaitingWorkspaceStartup = waitingWorkspaceStartups.get(workspaceKey) ?? {
      cancelled: false,
      workspace: params,
    };
    // 覆盖 workspace：等待期间调用方可能带来更完整的 identity/remoteSessionId，启动完成时
    // 应以最后一份参数登记 entry，否则后续按 identity 路由会查不到该 client。
    waiting.workspace = params;
    waitingWorkspaceStartups.set(workspaceKey, waiting);

    // 复用 waiting.starting 而不是函数级缓存 Promise：single-flight 的粒度是「一次启动尝试」，
    // 启动完成后必须允许下一次调用重新进入 readiness 判定。
    // Bug 根因：并发调用各自 await readiness，先成功的一条会删除等待记录，迟到调用
    // 因而把成功误判成 workspace 已释放。共享整个启动 Promise，取消仍由 waiting identity 控制。
    const starting = (waiting.starting ??= startModelExecutionClient(params, waiting));
    // [失败路径] starting 失败原样上抛；不在 finally 里重试或吞错，调用方（initialize 等）
    // 需要区分 provider-not-ready 与真正的启动失败来决定 UI 降级方式。
    try {
      return await starting;
    // 只清自己这一份 Promise：若并发调用已建立新一轮 starting，清掉它会让第三位调用者
    // 重复拉起进程。
    } finally {
      if (waiting.starting === starting) delete waiting.starting;
    }
  }

  // 把只读 client「提升」为可执行模型：顺序固定为 readiness 判定 → 取得/启动只读 client →
  // 二次取消检查 → 置 modelExecutionEnabled → processManager.markReady。
  // 任一步前后颠倒都会产生「对外宣称可执行、实际未就绪」的中间态。
  async function startModelExecutionClient(
    params: ZCodeAgentWorkspaceTarget,
    waiting: WaitingWorkspaceStartup,
  ): Promise<ZCodeProtocolClient> {
    const workspaceKey = resolveWorkspaceKey(params);
    const active = activeClientsByWorkspaceKey.get(workspaceKey);

    // readiness 来自 Host 的模型选择视图（provider + model 是否存在），不是 ping CLI；
    // 没有注入来源时返回 undefined，按未就绪处理，宁可保持只读也不把错误推给用户。
    const readinessSnapshot = await resolveStartupReadiness();
    // readiness 读取可能与 workspace release 交错；release 删除 waiting identity 后，
    // 旧 continuation 不能创建新进程。未来重新打开同一路径会获得新的 identity，互不误伤。
    // [并发] 两重 cancel 检查缺一不可：cancelled 覆盖 release 主动取消，map identity 覆盖
    // 「同一 workspace 重新打开」产生的第二代 waiting。只比 workspaceKey 会让旧代继续跑。
    if (waiting.cancelled || waitingWorkspaceStartups.get(workspaceKey) !== waiting) {
      throw createRuntimeUnavailableError(params);
    }
    // ready 是快照级布尔：Host 读取后可能立刻切换模型，这里不做二次校验，
    // 真实模型准入仍由 CLI 在建会话时校验；这层门禁只负责避免无 provider 时空转。
    const readiness = readinessSnapshot?.readiness;
    if (!readinessSnapshot || !readiness?.ready) {
      const revision = readinessSnapshot?.revision ?? "missing";
      // [权衡] 用 revision 去重日志而非节流：readiness 每次轮询都会触发本函数，
      // 按 revision 只在结论变化时打一条；按时间节流仍会在稳态下持续刷屏。
      if (waiting.lastLoggedRevision !== revision) {
        waiting.lastLoggedRevision = revision;
        logger.info(
          // active 存在表示进程已在只读态，与「未启动」是两种用户可见状态，
          // 日志分开才能区分是等待 model 还是根本拉不起进程。
          undefined,
          active
            ? "provider/model 尚未就绪，ZCode agent 保持只读"
            : "provider/model 尚未就绪，ZCode agent 保持未启动",
          {
            providerCount: readinessSnapshot?.providerCount ?? 0,
            revision: readinessSnapshot?.revision ?? null,
            workspaceKey,
            workspacePath: params.workspacePath,
          },
        );
      }
      // 稳定错误码而不是 message：UI 据此展示「去登录/配置模型」，且可在 host RPC 边界保留（INV-05）。
      throw createProviderNotReadyError({ snapshot: readinessSnapshot, workspace: params });
    }

    // 这里才启动进程：readiness 未就绪时连 CLI 都不拉起，避免每次打开界面都产生一个
    // 只会报错的子进程及其 idle timer。
    const entry = await getOrStartReadOnlyClient(params);
    // [并发] await 期间可能被 release；此时 entry 可能已被清理，继续 markReady 会把
    // 一个已脱离 map 的 client 标成可执行，下一个调用者仍会重新启动（浪费但不算错）。
    if (waiting.cancelled) {
      throw createRuntimeUnavailableError(params);
    }
    // 只有走到这里才置 true：该字段一经置位终身有效（见 ActiveWorkspaceClient 注释），
    // 后续即便模型被删也不回退，因为「曾通过门禁」与「当前仍有模型」是两件事（INV-09）。
    entry.modelExecutionEnabled = true;
    // [资源] markReady 把 processManager 的 idle 回收从「仅控制面」切换为「可执行」，
    // 由 process manager 统一计时；service 不自行维护第二套空闲计时器。
    processManager.markReady(params, entry.client);
    entry.workspace = params;
    waitingWorkspaceStartups.delete(workspaceKey);
    logger.info(undefined, "provider/model 就绪，允许 ZCode agent 模型执行", {
      modelId: readiness.modelId,
      providerId: readiness.providerId,
      revision: readinessSnapshot.revision,
      workspaceKey,
      workspacePath: params.workspacePath,
    });
    return entry.client;
  }

  // 只读 client 的两种语义：start-if-needed 可拉起进程（列表/设置类调用），existing-only
  // 只观察现有进程（订阅附属查询、卡片补正文），绝不因一次查看改变生命周期。
  async function getReadOnlyClient(
    params: ZCodeAgentWorkspaceTarget,
    runtimePolicy: "start-if-needed" | "existing-only" = "start-if-needed",
  ) {
    // existing-only 分支不经过 readiness，也不置 modelExecutionEnabled：
    // existing-only 观察者拿到的是「当前事实」，不是「允许执行」的许可。
    if (runtimePolicy === "existing-only") {
      const workspaceKey = resolveWorkspaceKey(params);
      const active = activeClientsByWorkspaceKey.get(workspaceKey);
      // 观察者路径同样要拒绝 disposed 的 stale entry；清理后按“无运行时”处理，
      // 绝不为观察者拉起新进程（保持 existing-only 语义）。
      // 与 getClient 相同的 stale 校验，但清理后返回 runtime-unavailable：
      // 观察者不能触发拉起，否则 existing-only 退化成 start-if-needed（INV-12）。
      if (active && isReusableActiveClientEntry(params, active)) {
        active.workspace = params;
        return active.client;
      }
      // runtime available 可能先于原启动调用的 await continuation 到达。这里允许把
      // process manager 已登记的 client 提升为 service active entry，但绝不创建新进程。
      // runtime 事件可能先于原启动调的 await continuation 到达：process manager 已登记
      // 新 client 时允许把它提升为 active entry，避免观察者与真实启动各持一个 client。
      const existingClient = processManager.getExistingClient(params);
      if (!existingClient) {
        throw createRuntimeUnavailableError(params);
      }
      // [资源] wireClient 会为该 client 注册事件路由与 disposable；同一 client 重复 wire 必须
      // 由 wireClient 内部幂等（clientDisposables 按 client 记账），否则会出现双份订阅。
      wireClient(existingClient, params, "chat");
      // 登记 entry 时 modelExecutionEnabled=false：提升不等于通过模型门禁，
      // 后续 create 仍会走 startModelExecutionClient 的 readiness 检查。
      activeClientsByWorkspaceKey.set(workspaceKey, {
        client: existingClient,
        modelExecutionEnabled: false,
        workspace: params,
        // 不重放就绪阶段的策略同步：这里没有原始 launch 参数，重放可能把远端策略
        // 误打到本机控制面；按 CLI 缺省记 disabled，用户改选择时经串行链补发。
        // 只提升已有 client，不重放就绪阶段的策略同步；按 CLI 缺省记为关闭，用户改选择时再补发。
        dynamicWorkflowPolicyMode: "disabled",
      });
      return existingClient;
    }
    // 默认策略走完整的只读启动（含偏好同步），但仍不置 modelExecutionEnabled。
    return (await getOrStartReadOnlyClient(params)).client;
  }

  // 插件管理走专用 processManager：cwd 是内部管理目录，不绑定任何真实 workspace，
  // 因此真实项目被删/重启不会让设置页的插件操作 EPIPE（ensurePluginManagementWorkspacePath）。
  async function getPluginManagementClient(): Promise<ZCodeProtocolClient> {
    const workspace = { workspacePath: ensurePluginManagementWorkspacePath() };
    // 该 manager 的 idle 回收与 chat 分离（mcpStatusIdleTimeoutMs 只给 MCP 探测），
    // 避免设置页长时间停留时把正在安装插件的进程回收掉。
    const client = await pluginProcessManager.getClient(workspace);
    wireClient(client, workspace, "plugin");
    return client;
  }

  // isLocalActiveWorkspaceClient 是纯判定函数，不清理、不启动：它只回答「该 entry 的 home
  // 是否就是本机」，供载体选择时排除远程 runtime。
  // 全局工作流的载体运行时选择：
  // 调用方只给 `{ scope: "global" }` 不带 workspace 时，先复用任一已活跃的**本地** runtime
  // （existing-only 语义：只看 activeClientsByWorkspaceKey，绝不为此拉起新进程），否则回落到
  // 管理面 workspace——照 getPluginManagementClient 先例用专用 pluginProcessManager 拉一个控制面
  // runtime。选它而非 getOrStartReadOnlyClient 的理由：workflows/* 是无会话、不依赖 provider/model
  // 就绪的 workspace 级方法，管理面进程正是为这种「不寄居真实项目」的控制面能力准备的，且不会因
  // 真实 workspace 生命周期被 watchdog 回收；getOrStartReadOnlyClient 反而会把这个合成 workspace
  // 塞进 activeClientsByWorkspaceKey 并跑一遍交互偏好同步，污染会话 client map。两条路径都在本机，
  // homedir() 即用户家目录，全局根 `~/.zcode/workflows/` 因此解析到真实目录。
  // 远程 runtime（SSH/WSL identity 或带 remoteSessionId）的 home 不是本机，绝不选它当载体。
  function isLocalActiveWorkspaceClient(workspace: ZCodeAgentWorkspaceTarget): boolean {
    return (
      // 双重判据：remoteSessionId 是链路事实，workspaceIdentity 的 remote 前缀是身份事实。
      // 只看其一都可能在「本地路径 + 远程 identity」或「远程 session + 本地路径」上误判（INV-02）。
      !workspace.remoteSessionId &&
      !(workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity))
    );
  }

  // 全局档首选「任一已活跃的本地会话 client」：文件扫描在对方进程里执行，省一次进程启动，
  // 也让同一 workspace 的 workflows 列表与 session 使用同一份文件视图。
  async function resolveGlobalSavedWorkflowCarrier(): Promise<{
    client: ZCodeProtocolClient;
    workspace: ZCodeWorkspaceRef;
  }> {
    // 遍历 activeClientsByWorkspaceKey.values() 而非维护单独索引：该 map 已是唯一登记处，
    // 复制一份「本地 client 列表」会引入第二事实源与失效窗口（INV-03）。
    for (const active of activeClientsByWorkspaceKey.values()) {
      if (!isLocalActiveWorkspaceClient(active.workspace)) {
        continue;
      }
      // isReusableActiveClientEntry 有副作用（清理 disposed entry），这里接受它：
      // 载体选择是低频路径，顺手收尸比保留 stale entry 更安全。
      // disposed / stale entry 的清理语义与 getReadOnlyClient(existing-only) 一致：
      // isReusableActiveClientEntry 会顺手清掉已回收的 entry，然后我们跳过它继续找。
      if (!isReusableActiveClientEntry(active.workspace, active)) {
        continue;
      }
      // 返回 buildWorkspaceRef(active.workspace) 而不是调用方参数：全局档没有目标 workspace，
      // 协议参数必须指向真实载体，否则 CLI 会把管理目录当成项目根。
      return { client: active.client, workspace: buildWorkspaceRef(active.workspace) };
    }
    // 没有任何活跃本地会话时回落到管理面进程：无会话、无 provider 依赖，
    // 且不会被真实 workspace 的 watchdog 连带回收。
    const managementWorkspace = { workspacePath: ensurePluginManagementWorkspacePath() };
    const client = await getPluginManagementClient();
    return { client, workspace: buildWorkspaceRef(managementWorkspace) };
  }

  // 五个 workflows/* 方法的载体：带 workspace 就直通（项目档，或 GUI 项目组里明说 scope 的动作），
  // 只给 `scope:"global"` 时交给 services 自选本机载体。
  // 五个 workflows/* 方法共用本函数，保证「有 workspace 就直通、无 workspace 才自选载体」
  // 只有一处实现；分散到各方法会让某个方法忘记 scope 语义。
  async function resolveSavedWorkflowCarrier(
    params: ZCodeAgentSavedWorkflowTarget,
  ): Promise<{ client: ZCodeProtocolClient; workspace: ZCodeWorkspaceRef }> {
    // 直通路径用 getReadOnlyClient(params)：可能是远程 workspace，远程文件必须在远端进程扫，
    // 不能因为「只是列表」就把请求拉到本机（INV-02）。
    if (savedWorkflowTargetHasWorkspace(params)) {
      return { client: await getReadOnlyClient(params), workspace: buildWorkspaceRef(params) };
    }
    return resolveGlobalSavedWorkflowCarrier();
  }

  // mcp/list 单独进程的原因：连接 MCP server 可能阻塞数十秒甚至 hang，与插件安装/会话执行
  // 隔离后，一次坏 server 不会拖垮设置页其它操作，也不会让 chat 的 idle 计时被误重置。
  // mcp/list 专用：与插件管理命令隔离进程，见 mcpStatusProcessManager 处的说明。
  async function getMcpStatusClient(): Promise<ZCodeProtocolClient> {
// 复用插件管理目录作为 MCP 状态探测的 workspace：探测不需要真实项目上下文。
    const workspace = { workspacePath: ensurePluginManagementWorkspacePath() };
// 走专用 processManager，确保 mcp/list 不与 chat/插件安装共用进程。
    const client = await mcpStatusProcessManager.getClient(workspace);
    wireClient(client, workspace, "mcp-status");
    return client;
  }

  // [资源] disposeLocalState 是 service 级一次性拆解：顺序为「上游订阅 → 事件 emitter →
  // pending 表与定时器 → client map/waiting → V4 路由 → runtime 生命周期」。
  // 反过来先清 client map 会让 emitter 的 onClose 回调找不到 owner，留下悬挂 Promise。
  function disposeLocalState(): void {
    // 先断开外部配置源：它可能在任何时刻回调并写 latestAppRuntimePreferences，
    // 不先退订，后续 clear 掉的 emitter 仍可能被重新填充。
    accountProviderConfigUnsubscribe?.();
    accountProviderConfigUnsubscribe = undefined;
    // modelSelectionSubscription 是模型选择视图的推送订阅；dispose 后 Host 不再收到
    // readiness 变化，这也是「dispose 后不得再写状态」的执行点（INV-12）。
    modelSelectionSubscription?.dispose();
    modelSelectionSubscription = undefined;
    // memoryDiagnostics 只是计数器注册，dispose 幂等；放在清 map 之前，
    // 避免拆除过程中诊断快照读到半清空的 map 而产生误导数字。
    memoryDiagnostics.dispose();
    // [资源] 每个 per-session emitter 都要显式 dispose：它们各自持有订阅者和定时器，
    // 仅 clear map 不会释放内部资源，进程退出前会留下未清理的回调引用。
    for (const emitter of sessionEmitters.values()) {
      emitter.dispose();
    }
    sessionEmitters.clear();
    // provider headers 有两张表（workspace 级 + cancelled 级），必须都拆：
    // cancelled 表存的是已取消但等待 CLI 回执的请求，漏拆会泄漏其定时器。
    for (const emitter of providerRuntimeHeadersWorkspaceEmitters.values()) {
      emitter.dispose();
    }
    providerRuntimeHeadersWorkspaceEmitters.clear();
    for (const emitter of providerRuntimeHeadersCancelledEmitters.values()) emitter.dispose();
    providerRuntimeHeadersCancelledEmitters.clear();
    // 以下五个是 service 级单例 emitter（偏好请求、资源采样、MCP 遥测、工具执行资源、
    // MCP 资源采样）；它们不随 session 走，只能在 service dispose 时释放一次。
    sessionRuntimePreferencesRequestEmitter.dispose();
    processResourceSampleEmitter.dispose();
    mcpTelemetryEmitter.dispose();
    toolExecResourceEmitter.dispose();
    mcpResourceSamplesEmitter.dispose();
    // pluginOperationProgressEmitters 按 operationId 建表：安装/卸载是长任务，
    // 统一 dispose 防止进程退出时仍有 UI 侧 pending 监听。
    for (const emitter of pluginOperationProgressEmitters.values()) {
      emitter.dispose();
    }
    pluginOperationProgressEmitters.clear();
    // conversation 帧与遥测事实是两条独立通道：前者驱动 UI 流式渲染，后者只做统计；
    // 分开 dispose 才能保证任一通道失败不影响另一条清理。
    for (const emitter of conversationFrameEmitters.values()) {
      emitter.dispose();
    }
    conversationFrameEmitters.clear();
    for (const emitter of conversationTelemetryFactEmitters.values()) {
      emitter.dispose();
    }
    conversationTelemetryFactEmitters.clear();
    // offPeakLifecycleEmitters 按 workspace 建表；取消中的 off-peak 任务不会再收到
    // 终态事件，必须在 dispose 时主动断开，避免 UI 永久等待。
    for (const emitter of offPeakLifecycleEmitters.values()) emitter.dispose();
    offPeakLifecycleEmitters.clear();
    // TTFT、CUA 权限观察、插件 UI 工具结果都是全局单例，与 session 生命周期无关。
    localTtftFactsEmitter.dispose();
    cuaPermissionObservationEmitter.dispose();
    pluginUiToolResultEmitter.dispose();
    // workspace/config 与 sessions/index 是 V4 帧通道的 Host 侧 emitter；
    // 它们由订阅路由驱动，必须早于 clearV4SubscriptionRoutes 拆，否则路由回调会打空。
    for (const emitter of workspaceConfigFrameEmitters.values()) {
      emitter.dispose();
    }
    workspaceConfigFrameEmitters.clear();
    for (const emitter of sessionsIndexFrameEmitters.values()) {
      emitter.dispose();
    }
    sessionsIndexFrameEmitters.clear();
    // sessionEventSequenceStates 是 eventId 去重的序号状态（INV-04）；清空必须在
    // emitter 之后，且不能只清 map 不 dispose，否则重连后会从错误的序号续接。
    sessionEventSequenceStates.clear();
    // [资源] 三张 pending 表分别对应权限、user-input、provider headers：它们的 Promise
    // 由 CLI 回执 settle，这里直接丢弃会让调用方悬挂，因此只应在 service 真正下线时执行
    // （正常关闭由 invalidateWorkspaceClient 逐条处理）。
    pendingPermissions.clear();
    pendingUserInputs.clear();
    // [资源] 偏好请求带 setTimeout：必须逐条 clearTimeout 再 clear，
    // 仅 clear map 会把定时器留到触发时访问已释放的 client（INV-05/INV-07）。
    pendingProviderRuntimeHeaders.clear();
    for (const pending of pendingSessionRuntimePreferences.values()) {
      clearTimeout(pending.timeout);
    }
    pendingSessionRuntimePreferences.clear();
    // [并发] 先清 active client 再取消 waiting：cancelAllWaitingWorkspaceStartups 会把
    // cancelled 置 true，正在 await readiness 的调用随后会看到 map identity 不匹配而退出。
    activeClientsByWorkspaceKey.clear();
    cancelAllWaitingWorkspaceStartups();
    // 偏好同步链是按 workspace 的 Promise，清表即可；链本身会在下一次启动时重建。
    interactionPreferenceSyncByWorkspaceKey.clear();
    // CUA tracker 是进程级单例状态：clearAll 而不是仅清当前 workspace，
    // 因为 dispose 后没有 workspace 还能继续持有 active turn。
    cuaOperationTurnTracker?.clearAll();
    // [资源] V4 路由表持有订阅 disposable 与 eventId 去重集合；clearV4SubscriptionRoutes
    // 必须逐条释放（INV-04/INV-07），不能只 clear map。
    clearV4SubscriptionRoutes();
    // runtime 生命周期订阅最后拆：前面所有清理都可能触发 runtime 事件，
    // 提前拆会让最后的 unavailable 事件无人接收，遗留 CUA/权限状态（INV-12）。
    v4RouteRuntimeRestartDisposable.dispose();
    runtimeLifecycleDisposable.dispose();
  }

  // 纯能力判定，不发请求、不读远端：它回答「本 Host 是否应该向 CLI 暴露 Off-Peak 工具面」，
  // 真正的灰度/套餐准入在 offPeak/create handler 取号前校验（职责分离，避免双重判定漂移）。
  // 3.12.2：远端灰度读取不能放进客户端就绪与创建命令：失败时串行重试会阻塞普通聊天。
  // 注册只判断本地支持能力；灰度、套餐与模型准入仍由 offPeak/create handler 在取号前校验。
  function isOffPeakToolSupported(params: {
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): boolean {
    // 两个 resolver 必须同时注入才启用：config 决定下发形状，taskService 决定 handler 能否执行；
    // 只装配其一会产生「工具注册了但点了报错」的半成品状态。
    if (!options?.resolveOffPeakClientConfig || !options.resolveOffPeakTaskService) return false;
    // 远程链路一律关闭：Off-Peak 需要本机调度与本地任务服务，远端 home 上不存在这些前提（INV-02/INV-06）。
    if (params.remoteSessionId) return false;
    return !params.workspaceIdentity || !isRemoteWorkspaceIdentity(params.workspaceIdentity);
  }

  // 读取一次后闩住：dynamicWorkflowOffer 是进程级 Promise，成功后不再重读，
  // 失败也缓存 undefined（fail-closed 且不重试），避免离线时每条 create 都赔一次超时。
  /**
   * 服务端「提供」（docs/dynamic-workflow/launch.md「Gray release」）：Host 读取一次并在本进程内固定。
   * 三点理由：
   *   1. 判定落在 client 就绪路径上，不能每次建会话都等远端——3.12.2 已因此回归过一次；
   *   2. 读取失败 fail-closed 且不再重试，避免离线时每条 create 都赔上一次请求超时；
   *   3. 服务端翻转灰度按设计在下一个 Host 进程生效（provider 侧另有 1h 快照与 forceRefresh）。
   * 与 Off-Peak 不同：远程 workspace 同样可用，所以这里不看 workspaceIdentity / remoteSessionId。
   */
  function resolveDynamicWorkflowOffer(): Promise<DynamicWorkflowClientConfig | undefined> {
    const resolve = options?.resolveDynamicWorkflowClientConfig;
    if (!resolve) return Promise.resolve(undefined);
// 未注入 resolver 时直接给 resolved undefined，不缓存、不打印 warn。
    // [并发] ??= 保证并发首次调用共享同一次远端读取；若每次 new Promise，
    // 同一进程内会发出多条灰度请求且结果可能不一致。
    dynamicWorkflowOffer ??= (async () => {
// 成功值会缓存到进程结束，后续并发调用直接命中，不再询问 resolver。
      try {
        return await resolve();
      } catch (error) {
// 读取失败按「未开启」缓存 undefined，避免每次请求都重试同一个坏配置。
        logger.warn(undefined, "动态工作流灰度读取失败，按关闭处理", {
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    })();
    return dynamicWorkflowOffer;
  }

  // 用户选择不闩：本机设置是权威时每次现读，改设置后下一次建会话立刻生效；
  // desktop-attached remote Host 没有本机设置，退回 desktop 推来的 pushedDynamicWorkflowUserMode。
  /** 用户选择（launch.md「The user's choice」）：本机设置权威每次现读；否则用 desktop 推来的值。 */
  async function resolveDynamicWorkflowUserMode(): Promise<DynamicWorkflowMode | undefined> {
    const read = options?.resolveDynamicWorkflowUserMode;
    if (!read) return pushedDynamicWorkflowUserMode;
    // 归一化在读取侧完成：非法/未知模式统一成 undefined（跟随服务端），
    // 避免下游 applyDynamicWorkflowUserMode 各自处理脏值。
    try {
      return normalizeDynamicWorkflowMode(await read());
    } catch (error) {
      // [失败路径] 设置读失败按「跟随服务端」而不是 disabled：把 undefined 当成用户明确关闭
      // 会连带关掉灰度已开启的功能，这是过去离线启动 Host 的实际回归点。
      // 设置读失败不能把功能关掉，也不能阻断建会话：按「跟随服务端」处理。
      logger.warn(undefined, "动态工作流用户选择读取失败，按跟随服务端处理", {
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  // 生效模式 = 闩住的「提供」 + 此刻的用户选择；提供缺失时用 DEFAULT_DYNAMIC_WORKFLOW_MODE
  // 兜底再套用户选择，保证「服务端读不到」不会覆盖「用户明确打开」（launch.md The user's choice）。
  /**
   * 生效模式 = 闩住的「提供」+ 此刻的用户选择。策略同步与三条创建路径同源调用，所以不会出现
   * "策略说开、create 说关"的裂口；选择不闩，改设置后下一次建会话立刻拿到新值。
   * `onDemand` 原样送到 CLI：它决定十个工具是首请求就注册还是等首次 `/workflow`。
   *
   * 用户选择永远生效（launch.md「The user's choice」）：提供读取失败或拿不到值时按默认 disabled
   * 处理，再套用户选择——过去这里直接返回 disabled，离线启动的 Host 会连用户明确打开的功能一起关掉。
   * 没装配 resolver 的 Host 不接这个功能，选择不生效。
   */
  async function resolveDynamicWorkflowGate(): Promise<DynamicWorkflowMode> {
    // 未装配 resolver 的 Host 完全不接该功能：返回 disabled 而不是走默认 offer，
    // 否则纯 CLI 装配会意外获得动态工作流工具面。
    if (!options?.resolveDynamicWorkflowClientConfig) return "disabled";
    const offer =
      (await resolveDynamicWorkflowOffer()) ??
      createDynamicWorkflowClientConfig(DEFAULT_DYNAMIC_WORKFLOW_MODE, "default");
    // applyDynamicWorkflowUserMode 集中实现优先级（用户选择 > 服务端提供 > 默认）；
    // 这里只取 mode，enabled 由 isDynamicWorkflowModeEnabled 派生，避免两份布尔不一致。
    return applyDynamicWorkflowUserMode(offer, await resolveDynamicWorkflowUserMode()).mode;
  }

  // [并发] 每个 workspace 一条 Promise 链：previous.then 保证发送顺序与读取顺序一致，
  // 慢请求不会在新结论之后落地（否则用户在设置里关掉后又会被旧请求重新打开）。
  /**
   * 把生效模式同步给一个 workspace 的 CLI（launch.md「The user's choice」）。同一 workspace 串行：
   * 每一步在执行时才读生效模式，后入队的步骤必然读到更新的选择，慢请求不会在新结论之后落地。
   * 与 CLI 已持有的策略相同就不发；关闭时发 enabled:false，让在线 CLI 的斜杠目录去掉 workflow。
   */
  function enqueueDynamicWorkflowPolicySync(entry: ActiveWorkspaceClient): Promise<void> {
    const workspaceKey = resolveWorkspaceKey(entry.workspace);
    // 链头是 Promise.resolve()，不保存 client 引用；entry.client 在步骤执行时才读取，
    // 这样 runtime 换代后入队的步骤会打到新 client，而不是已 dispose 的旧 client（INV-03）。
    const previous = dynamicWorkflowPolicySyncByWorkspaceKey.get(workspaceKey) ?? Promise.resolve();
    const current = previous.then(async () => {
      // 执行时才 resolve 生效模式：入队瞬间的选择可能已被后续设置覆盖，
      // 提前读值会让最后一步发送过期策略。
      const mode = await resolveDynamicWorkflowGate();
      // 与 CLI 已持有的模式相同就跳过：策略同步幂等，但避免每轮 create 重复发送，
      // 也避免把「CLI 已是该模式」误当成一次新的灰度变更。
      if (mode === entry.dynamicWorkflowPolicyMode) return;
      const enabled = isDynamicWorkflowModeEnabled(mode);
      try {
        // 关闭时也要发 enabled:false（不带 mode）：在线 CLI 需要据此从斜杠目录移除 workflow，
        // 只跳过请求会让已打开的 CLI 继续展示已关闭的能力面（INV-06）。
        await entry.client.request(
          zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy,
          // mode 与布尔同行（launch.md「On demand: activation」）；只认布尔的旧 CLI 的 strict
          // schema 会拒绝 mode，走下面的 warn 分支保持缺省关闭——与其它非 -32601 错误同判。
          // mode 只在开启时展开：关闭时不下发 mode，避免旧 strict schema 因未知字段拒绝，
          // 也避免 CLI 误以为「关闭但保留 onDemand 语义」。
          { workspace: buildWorkspaceRef(entry.workspace), enabled, ...(enabled ? { mode } : {}) },
          zcodeWorkspaceUpdateDynamicWorkflowPolicyResultSchema,
        );
        entry.dynamicWorkflowPolicyMode = mode;
      // [失败路径] 只 warn 不 reject：策略同步是就绪屏障的一部分，reject 会让整个
      // workspace 启动失败；失败时 entry.dynamicWorkflowPolicyMode 不前进，下次会重发。
      } catch (error) {
        // 与 Off-Peak 同判据：-32601 是旧 CLI 的正常降级（其 z.object 也会丢掉 session flag，
        // 整体退回 disabled）；其它错误只记 warn，不阻断客户端就绪。
        // -32601 是旧 CLI 的正常降级；其 z.object 会丢弃 session flag，整体退回 disabled，
        // 与这里保持缺省关闭的结论一致，不需要额外补偿。
        if (!isProtocolMethodNotFoundError(error)) {
          logger.warn(undefined, "动态工作流策略同步失败，CLI 维持原策略", {
            workspaceKey,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });
    // [资源] 链长期驻留 map（一个 workspace 一条），不做删除：删除会让并发入队
    // 拿到旧链头而乱序；其生命周期与 service 相同，dispose 时统一释放。
    dynamicWorkflowPolicySyncByWorkspaceKey.set(workspaceKey, current);
    return current;
  }

  // 三条创建路径（create/resume/v4 命令）共用同一下发形状：开启时同时给布尔与 mode，
  // 关闭时两者都缺席。拆成各自拼装会让某条路径漏掉 mode 或误发 false。
  /** 三条创建路径共用：布尔 + mode 的下发对（关闭时两者都缺席）。 */
  async function resolveDynamicWorkflowSessionFlags(): Promise<{
    dynamicWorkflowEnabled: boolean;
    dynamicWorkflowMode?: DynamicWorkflowMode;
  }> {
    // 每次调用都重新 resolve：用户可能在两次建会话之间改了选择，
    // 缓存 flags 会让改设置后的第一次创建仍用旧模式。
    const mode = await resolveDynamicWorkflowGate();
    return isDynamicWorkflowModeEnabled(mode)
      ? { dynamicWorkflowEnabled: true, dynamicWorkflowMode: mode }
      : { dynamicWorkflowEnabled: false };
  }

  // [事务] 协议信封的唯一整形点：createSession/sendText 在这里补齐 Host 侧字段后才交给
  // CLI。所有补充都是「加字段」而非改写调用方 payload，保证旧客户端构造的 envelope 不被破坏。
  async function buildConversationCommandEnvelope(
    params: ZCodeAgentConversationCommandParams,
  ): Promise<CommandEnvelope> {
    // 只处理两种命令；其余命令原样返回，避免在信封层做与业务无关的字段注入。
    const envelope = params.envelope;
    // createSession 分支要解决三件事：稳定 sessionId、附加目录授权、灰度/工具面字段，
    // 三者的失败语义不同，因此不能合并成一个 try。
    if (envelope.type === "createSession") {
      const { dynamicWorkflowEnabled, dynamicWorkflowMode } =
        await resolveDynamicWorkflowSessionFlags();
      // 先 parse 再 spread：payload 来自 IPC，必须经过 strict schema 才能信任其字段；
      // 直接展开会让未知字段透传到 CLI，可能触发旧 schema 拒绝。
      const payload = commandPayloadSchemas.createSession.parse(envelope.payload);
      // [权衡] 带 projectId 或装了 prepareSessionCreation 的 Host 才重算 sessionId：
      // 历史行为是按 (workspaceKey, clientId, commandId) 派生稳定 id，使客户端重试同一命令
      // 复用同一 session（幂等）。无条件 randomUUID 会让重试产生重复会话。
      const sessionId =
        // 三要素参与哈希：workspaceKey 隔离不同项目，clientId 隔离同项目多窗口，
        // commandId 保证同一窗口的重试幂等；缺一项都会让不同来源的命令撞到同一 session。
        params.projectId !== undefined || options?.prepareSessionCreation
          ? `session_${createHash("sha256")
              .update(
                JSON.stringify([
                  resolveWorkspaceKey(params),
                  envelope.clientId,
                  envelope.commandId,
                ]),
              )
              .digest("hex")
              .slice(0, 32)}`
          : payload.sessionId;
      // 附加目录必须由 Host 授权后回传：CLI 不掌握用户授权范围，直接信任 payload
      // 会让任意路径被加入可读写目录。
      const additionalDirectories =
        // 与 sessionId 同条件：只有走 Host 编排的创建才需要目录预授权；
        // 纯 CLI/测试路径保留调用方自带的 additionalDirectories。
        params.projectId !== undefined || options?.prepareSessionCreation
          ? await options?.prepareSessionCreation?.({
              ...params,
              sessionId: sessionId!,
              projectId: params.projectId ?? null,
              additionalDirectories: payload.additionalDirectories,
            })
          : payload.additionalDirectories;
      // [失败路径] 有 projectId 但没装 prepareSessionCreation：项目创建依赖 Host 的
      // 项目执行快照，无法在本层降级，直接抛稳定错误码让 UI 走「项目不可用」路径。
      if (params.projectId !== undefined && !options?.prepareSessionCreation)
        throw new Error("project.creation-unavailable");
      // 能力面按 Host 支持判定：不支持 Off-Peak 的链路不下发 offPeakToolEnabled，
      // 避免 CLI 注册了工具却在取号时才发现没有 task service（INV-06）。
      const offPeakToolEnabled = isOffPeakToolSupported(params);
      // spread 顺序即优先级：payload 原有字段在前，Host 判定字段在后；
      // 条件展开保证「关闭」时字段完全缺席而不是 false，旧 strict schema 才能接受。
      return {
        ...envelope,
        payload: {
          ...payload,
          ...(dynamicWorkflowEnabled ? { dynamicWorkflowEnabled: true, dynamicWorkflowMode } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
          ...(offPeakToolEnabled ? { offPeakToolEnabled: true } : {}),
        },
      };
    }
    // sendText 只做工具 denylist 的纵深防御：automation/offPeak 派发轮不允许再触发
    // 创建/修改类工具，否则会形成自激回路（一次派发产生新的派发）。
    if (envelope.type !== "sendText") return envelope;

    // parse 后再读 automationId/offPeakTaskId：这两个字段决定 denylist 是否注入，
    // 不能靠 message 文本或未校验的原始对象判断（INV-05）。
    const payload = commandPayloadSchemas.sendText.parse(envelope.payload);
    // 读取持久化 cronAutomationId 后不能把整个绑定会话永久视为 automation
    // 执行上下文。用户后续主动输入也因此丢失 CronUpdate/CronDelete。这里只认本轮 payload；
    // automation runId 漏传 payload 的兼容识别由 CLI 的 resolveTurnAutomationId 兜底。
    // automationId 只认本轮 payload：它表示「本轮由 automation 触发」，
    // 若读取会话持久化绑定，会把用户后续主动对话永久当成 automation 上下文，
    // 连带丢掉 CronUpdate/CronDelete 等用户本应可用的工具。
    if (payload.automationId) {
      // desktop continuous 的 automation 派发不一定经过 task adapter；在协议信封处合并本轮
      // denylist，且不覆盖调用方已有策略。
      // merge 而不是覆盖：调用方可能已有更严格的白/黑名单，直接赋值会放宽限制；
      // 返回新数组，保持 envelope 不可变语义。
      return {
        ...envelope,
        payload: {
          ...payload,
          toolDisallowlist: mergeAutomationMutationToolDenylist(payload.toolDisallowlist ?? []),
        },
      };
    }
    // Off-Peak 轮同型但更窄：只 deny OffPeakCreate，保留 OffPeakList（只读查看），
    // 否则派发轮无法向用户展示已有任务。
    if (payload.offPeakTaskId) {
      // 闲时派发轮同型纵深——只 deny OffPeakCreate（OffPeakList 只读保留）。
      return {
        ...envelope,
        payload: {
          ...payload,
          toolDisallowlist: mergeOffPeakMutationToolDenylist(payload.toolDisallowlist ?? []),
        },
      };
    }
    // 其它 sendText 原样返回：不做任何工具面改写，普通对话的工具可见性由 CLI 决定。
    return envelope;
  }

  // 以下是对外暴露的 service 门面：方法体只做参数整形、client 获取与协议转发。
  // 约定：观察类方法一律用 getReadOnlyClient；会推进模型状态的必须用 getClient。
  return {
    // prepareStorage 显式等待 storageStartup：CLI 的 session 库/索引初始化是异步的，
    // 早于它发出的读请求会被 CLI 拒绝或返回空，Host 侧提前 await 可把这类竞态挡在门面。
    async prepareStorage(params) {
// 这里用会推进执行态的 getClient：prepareStorage 的语义就是「把存储准备好」。
      const client = await processManager.getClient(params);
// 先 wire 再等待，保证 storageStartup 期间的事件已有订阅者接收。
      wireClient(client, params, "chat");
// 返回 undefined：调用方只关心等待完成，不需要 client 句柄。
      await client.storageStartup.wait();
    },
    // storage 启动状态是 processManager 的事实，不在 service 复制一份：复制会产生
    // 「进程已换代但状态还是旧值」的窗口（INV-01：Host 只持 transport 状态）。
    async getStorageStartupState(params) {
      return processManager.getStorageStartupState(params);
    },
    // 订阅按 workspaceKey 过滤后再交给调用方：processManager 的事件是跨 workspace 广播，
    // 不过滤会让 A 项目的 UI 收到 B 项目的存储状态。
    onDynamicStorageStartupState(params) {
// 先把入参归一成 workspaceKey，后续每次事件都拿它做过滤比较。
      const workspaceKey = resolveWorkspaceKey(params);
// 返回退订函数而不是订阅句柄：调用方只需在卸载时调用一次。
      return (listener) =>
        processManager.onStorageStartupChanged((event) => {
// 只转交本 workspace 的快照，跨 workspace 事件在门面层就被丢弃。
          if (event.workspaceKey === workspaceKey) listener(event.snapshot);
        });
    },
    // CUA turn tracker 只在桌面装配时存在；纯 CLI/远端返回 false 而不是抛错，
    // 让调用方无需区分装配形态。
    hasActiveCuaOperationTurn(): boolean {
      return cuaOperationTurnTracker?.hasActiveTurn() ?? false;
    },
    // initialize 承担「首屏预热」职责：它必须把 provider 未就绪表达成可恢复结果，
    // 而不是异常，否则 UI 首屏会因 agent 缺失直接崩溃。
    async initialize(params: ZCodeAgentWorkspaceTarget): Promise<ZCodeAgentInitializeResult> {
      const workspaceKey = resolveWorkspaceKey(params);
      const startedAt = Date.now();
      logger.info(undefined, "开始初始化 ZCode agent", {
        workspaceKey,
        workspacePath: params.workspacePath,
      });
      try {
        // 走 getClient 而非只读：initialize 是模型执行路径的预热，需要推进 modelExecutionEnabled。
        const client = await getClient(params);
        logger.info(undefined, "ZCode agent 初始化完成", {
          durationMs: Date.now() - startedAt,
          transportKind: client.transportKind === "websocket" ? "websocket" : "stdio",
          workspaceKey,
          workspacePath: params.workspacePath,
        });
        return {
          available: true,
          workspaceKey,
          protocolName: ZCODE_PROTOCOL_NAME,
          protocolVersion: ZCODE_PROTOCOL_VERSION,
          transportKind: client.transportKind === "websocket" ? "websocket" : "stdio",
        };
      // [失败路径] 所有初始化错误都在此处收敛为 available=false + reason：
      // 调用方（desktop host）把它当作可重试状态展示，不进入崩溃路径。
      } catch (error) {
        // provider 未就绪是「等待」不是「故障」：日志降为 info，
        // 避免正常冷启动在用户日志里刷成 warn。
        const providerNotReady = isProviderNotReadyError(error);
        logger[providerNotReady ? "info" : "warn"](
          undefined,
          providerNotReady ? "ZCode agent 等待 provider/model 就绪" : "ZCode agent 初始化失败",
          {
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
            workspaceKey,
            workspacePath: params.workspacePath,
          },
        );
        // initialize 现在承担 host 启动预热职责，但首屏不能因为 agent 缺失直接崩溃。
        // 保留 available=false 结果，让 UI/调用方沿用既有的可恢复错误路径。
        // 保留 workspaceKey：UI 需要按 workspace 归因失败，尤其是在多窗口/远程场景。
        return {
          available: false,
          workspaceKey,
          protocolName: ZCODE_PROTOCOL_NAME,
          protocolVersion: ZCODE_PROTOCOL_VERSION,
          reason: error instanceof Error ? error.message : String(error),
          // 只有 provider-not-ready 带稳定 reasonCode：其它失败保留原始 message，
          // 便于用户反馈问题时定位到具体 IPC/进程错误（INV-05）。
          ...(providerNotReady ? { reasonCode: ZCODE_AGENT_PROVIDER_NOT_READY_REASON } : {}),
        };
      }
    },

    // 用户选择变更入口：先更新 pushed 值（desktop-attached remote Host 的权威），
    // 再转发给装配层，最后对每个活跃 workspace 入队策略同步。
    async syncDynamicWorkflowUserMode(params: { mode?: DynamicWorkflowMode }): Promise<void> {
      // [并发] 转发的是「归一化后实际生效」的值，而不是入参：本机有设置权威时，
      // 入参只是变更信号，转发原始值会把过期选择推给远程 Host。
      // launch.md「The user's choice」：本机有设置权威时传入值只是变更信号，以设置文件为准；
      // desktop-attached remote Host 没有本机设置，推来的值就是选择。
      pushedDynamicWorkflowUserMode = normalizeDynamicWorkflowMode(params.mode);
      options?.forwardDynamicWorkflowUserMode?.(await resolveDynamicWorkflowUserMode());
      // 对全部 active client 并发入队：每个 workspace 各自的串行链保证顺序，
      // 跨 workspace 之间没有顺序依赖，因此可以并行。
      await Promise.all(
        [...activeClientsByWorkspaceKey.values()].map((entry) =>
          enqueueDynamicWorkflowPolicySync(entry),
        ),
      );
    },

    // app 偏好同步：normalize 后写入 latestAppRuntimePreferences，作为后续新 client 的追平基线；
    // modelIoFullRetentionEnabled 用 === true 归一，避免 undefined 被当成 true 下发。
    async syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void> {
      const normalizedPreferences: ZCodeAgentAppRuntimePreferences = {
        ...preferences,
        modelIoFullRetentionEnabled: preferences.modelIoFullRetentionEnabled === true,
      };
      // [并发] 先写 latest 再遍历：遍历期间新建的 client 会在 getOrStartReadOnlyClient 的
      // while 循环里读到同一快照，不会漏同步。
      latestAppRuntimePreferences = normalizedPreferences;
      // 快照 values 后再 await：Map 在 await 期间可能新增/删除 entry，
      // 直接迭代会拿到不一致的视图。
      const activeClients = [...activeClientsByWorkspaceKey.values()];
      await Promise.all(
        activeClients.map((entry) =>
          enqueueInteractionPreferenceSync({
            client: entry.client,
            preferences: { ...normalizedPreferences },
            workspace: entry.workspace,
          }),
        ),
      );
    },

    // runtime identity 查询是纯观察：existing-only 保证不会把 dormant workspace 变成活动进程，
    // 否则「查看运行信息」这个动作本身会创建进程。
    async getWorkspaceRuntimeIdentity(params: ZCodeAgentWorkspaceTarget) {
      // 查询 runtime identity 只能观察现有进程，不能把 dormant workspace 变成活动进程。
      // 即使只是为了 identity 也先 getReadOnlyClient：它负责 wireClient 与 stale 清理，
      // 直接调 processManager 会拿到未接事件路由的 client，后续 identity 事件无人消费。
      await getReadOnlyClient(params, "existing-only");
      return await processManager.getRuntimeIdentity(params);
    },

    // createSession 是三条创建路径中最重的一条：Host 前置编排（sessionId/目录）→ 账号配置同步
    // → 首次请求 → 旧协议兼容重试 → thoughtLevel 补写。每一步的失败都不能静默降级成空会话。
    async createSession(params: ZCodeAgentCreateSessionParams) {
      // 装了 prepareSessionCreation 就由 Host 分配 sessionId 并预授权目录；
      // 这段必须在 getClient 之前完成，否则 CLI 已按缺省目录启动，事后无法追加授权。
      if (options?.prepareSessionCreation) {
        // 调用方显式给 sessionId 时沿用（重连/重试幂等），否则生成新 id；
        // 不用派生哈希是因为这里没有 commandId，无法保证重试一致。
        const sessionId = params.sessionId ?? `session_${randomUUID()}`;
        // [失败路径] 目录准备失败直接上抛：没有目录授权就建会话会得到一个
        // 只能读 workspace 根目录、无法访问项目依赖的半残 session。
        const directories = await options.prepareSessionCreation({
          ...params,
          sessionId,
          projectId: params.projectId ?? null,
        });
        // 用局部变量重建 params 而不是就地改写：调用方对象可能被其它路径共享，
        // 就地赋值会让日志/后续请求看到不一致的 sessionId。
        params = {
          ...params,
          sessionId,
          additionalDirectories: params.additionalDirectories ?? directories,
        };
      // [失败路径] 有 projectId 但未装配项目执行能力：抛稳定错误码，
      // 让 UI 明确提示「项目功能不可用」，而不是创建一个没有项目上下文的会话。
      } else if (params.projectId !== undefined) {
        throw new Error("project.creation-unavailable");
      }
      const startedAt = Date.now();
      const client = await getClient(params);
      // 账号级 provider 配置必须在 create 前落地：CLI 用这份配置解析模型；
      // refreshRegistry=true 要求成功后才继续，避免用旧 Registry 校验新模型。
      await ensureAccountProviderConfigSynced({
        client,
        reason: "session_create",
        workspace: params,
        refreshRegistry: true,
      });
      // traceId 由调用方带入（UI 发起的一次用户操作）；它只用于日志关联，
      // 真正的 session trace 以 CLI 返回的 snapshot.session.traceId 为准。
      const sessionTraceId = params.sessionTraceId;
      logger.info(sessionTraceId, "开始请求 ZCode Protocol session/create", {
        hasInitialModel: params.model !== undefined,
        hasInitialThoughtLevel: params.thoughtLevel !== undefined,
        initialModel: formatModelSelectionForLog(params.model),
        mcpServerCount: getMcpServerCount(params),
        mcpServerNames: getMcpServerNames(params),
        persistence: params.persistence,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      // 灰度字段每次现算：client 已就绪说明 offer 已被闩住，这里只是读取进程内 Promise，
      // 不会再打远端（见 resolveDynamicWorkflowOffer）。
      const offPeakToolEnabled = isOffPeakToolSupported(params);
      // 灰度在 client 就绪时已判定，这里是进程内已解析 promise 的再次 await（不打远端）。
      const dynamicWorkflowFlags = await resolveDynamicWorkflowSessionFlags();
      try {
        // strict schema 解析响应：CLI 返回的 snapshot 是后续所有投影的唯一来源，
        // 不能只挑字段使用，否则协议演进时会静默丢数据（INV-01）。
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionCreate,
          // 显式传 offPeakToolEnabled/flags 而不是依赖 builder 的缺省：
          // 该 builder 只在下发 true 时写字段，关闭时必须保持字段缺席以兼容旧 strict schema。
          buildSessionCreateParams({ ...params, offPeakToolEnabled, ...dynamicWorkflowFlags }),
          zcodeSessionStateSnapshotSchema,
          // trace 只在调用方给出 traceId 时附加：协议层 trace 是可选项，
          // 无条件附加会让旧 CLI 的 strict params 拒绝（与 compat 重试同源问题）。
          sessionTraceId ? { trace: { traceId: sessionTraceId } } : undefined,
        );
        // [资源] 记住 traceId 按 (workspaceKey, sessionId) 建索引：后续 send/compact
        // 复用同一条 trace，避免为每个请求重新查询。该表只增不清（disposeLocalState 未 clear），
        // 长生命周期 Host 会随会话数持续增长。
        rememberSessionTrace({ ...params, sessionId: snapshot.session.sessionId }, snapshot);
        logger.info(sessionTraceId, "ZCode Protocol session/create 完成", {
          durationMs: Date.now() - startedAt,
          messageCount: snapshot.messages.length,
          modelCurrent: formatModelSelectionForLog(snapshot.settings.model.current),
          mcpServerCount: getMcpServerCount(params),
          persistence: params.persistence,
          sessionId: snapshot.session.sessionId,
          snapshotTraceId: snapshot.session.traceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      // [失败路径] 只对「已知可选字段不被识别」做兼容重试；
      // 其它错误（鉴权、磁盘、模型不存在）必须原样上抛，否则会用缺省会话掩盖真实故障。
      } catch (error) {
        // getSessionCreateCompatFields 会校验所有未知键都落在白名单内：
        // 混入未知必填字段时返回空数组，直接失败而不是「删字段重试」。
        const compatFields = getSessionCreateCompatFields(error);
        if (compatFields.length === 0) {
          logger.warn(sessionTraceId, "ZCode Protocol session/create 失败", {
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
            persistence: params.persistence,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          throw error;
        }
        logger.warn(sessionTraceId, "ZCode Protocol session/create 命中新旧协议兼容重试", {
          compatFields,
          durationMs: Date.now() - startedAt,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        // [权衡] 降级重试的边界只覆盖可选字段：thoughtLevel/persistence/mcpServers/
        // toolAllowlist/toolDenylist/offPeakToolEnabled/dynamicWorkflow*。
        // importedHistory 故意不在白名单——省略它等于创建空会话，必须硬失败。
        // host/UI 可能已经发送新版 session/create 可选字段，但本地打包、
        // 远端部署或仍存活的旧 app-server 还在使用旧 strict schema。只对已知
        // 可选字段降级重试，避免 thoughtLevel/persistence 版本差阻塞首发创建。
        // 重试复用同一 sessionId/目录：兼容重试是同一逻辑请求的第二次编码，
        // 不能生成新 session，否则用户会看到两个空会话。
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionCreate,
          buildSessionCreateParams(
            { ...params, offPeakToolEnabled, ...dynamicWorkflowFlags },
            new Set(compatFields),
          ),
          zcodeSessionStateSnapshotSchema,
          sessionTraceId ? { trace: { traceId: sessionTraceId } } : undefined,
        );
        rememberSessionTrace({ ...params, sessionId: snapshot.session.sessionId }, snapshot);
        // thoughtLevel 被省略且用户确实选了推理强度：CLI 已按缺省创建，
        // 只能用旧协议已有的 session/setThoughtLevel 补写，保证首轮 prompt 的推理强度正确。
        if (!compatFields.includes("thoughtLevel") || !params.thoughtLevel) {
          logger.info(sessionTraceId, "ZCode Protocol session/create 兼容重试完成", {
            durationMs: Date.now() - startedAt,
            sessionId: snapshot.session.sessionId,
            snapshotTraceId: snapshot.session.traceId ?? null,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          return snapshot;
        }
        // 旧 create schema 不认识 thoughtLevel 时，创建后再走旧协议已有的
        // session/setThoughtLevel，保证首轮 prompt 仍使用用户在工具栏选择的推理强度。
        // [事务] 补写 thoughtLevel 是 create 之后的第二次写：若它失败，会话已存在但
        // 推理强度是缺省值。这里选择上抛，让调用方知道「创建成功但设置未生效」，
        // 而不是返回一个看似正常的 snapshot。
        const snapshotWithThoughtLevel = await client.request(
          zcodeProtocolMethods.sessionSetThoughtLevel,
          {
            sessionId: snapshot.session.sessionId,
            thoughtLevel: params.thoughtLevel,
            // persistAsWorkspaceLastUsed=true：与工具栏选择语义一致，下次在同 workspace
            // 新建会话沿用该强度；不持久化会让用户每次都要重选。
            persistAsWorkspaceLastUsed: true,
          },
          zcodeSessionStateSnapshotSchema,
          sessionTraceId ? { trace: { traceId: sessionTraceId } } : undefined,
        );
        // 用补写后的 snapshot 覆盖返回值：settings/model.current 等字段可能已在
        // setThoughtLevel 后变化，返回旧 snapshot 会让 UI 显示过期设置。
        rememberSessionTrace(
          { ...params, sessionId: snapshotWithThoughtLevel.session.sessionId },
          snapshotWithThoughtLevel,
        );
        logger.info(
          sessionTraceId,
          "ZCode Protocol session/create 兼容重试后设置 thoughtLevel 完成",
          {
            durationMs: Date.now() - startedAt,
            sessionId: snapshot.session.sessionId,
            snapshotTraceId: snapshotWithThoughtLevel.session.traceId ?? null,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          },
        );
        return snapshotWithThoughtLevel;
      }
    },

    // resumeSession 与 create 的分工：create 决定「新建什么」，resume 决定「恢复成什么」。
    // 两者都必须下发灰度/工具面字段，否则冷恢复出来的会话会缺少工具簇。
    async resumeSession(params: ZCodeAgentResumeSessionParams) {
      // 目录解析优先用调用方给定值；未给时由 Host 的 resolveSessionDirectories 重算，
      // 因为 CLI 的持久化目录列表可能因项目移动/权限变更而过期。
      params = {
        ...params,
        additionalDirectories:
          params.additionalDirectories ?? (await options?.resolveSessionDirectories?.(params)),
      };
      // startedAt 在 getClient 之前取：日志里的 duration 覆盖「等待 runtime 就绪 + 请求」，
      // 只统计请求会把启动耗时藏起来，误导性能判断。
      const startedAt = Date.now();
      const client = await getClient(params);
      // resume 同样要同步账号 provider 配置：恢复的会话可能引用了新登录账号下的模型，
      // Registry 未刷新会让 CLI 拒绝 resume。
      await ensureAccountProviderConfigSynced({
        client,
        reason: "session_resume",
        workspace: params,
        refreshRegistry: true,
      });
      // cachedTraceId 来自 listSessions/readSession 的缓存；resume 请求本身没有 traceId 参数，
      // 只能先用缓存值关联日志，成功后用 snapshot 里的新 trace 覆盖。
      const cachedTraceId = getSessionTraceId(params);
      const offPeakToolEnabled = isOffPeakToolSupported(params);
      // 冷恢复同样按 Host 的灰度判定下发，否则恢复出来的会话会丢掉工作流工具簇。
      // 冷恢复必须带灰度 flags：CLI 从磁盘恢复会话时不会重新读取 Host 的灰度状态，
      // 缺字段就按关闭处理，恢复出的会话会永久丢失工作流工具（INV-01 的冷恢复同终态要求）。
      const dynamicWorkflowFlags = await resolveDynamicWorkflowSessionFlags();
      logger.info(cachedTraceId, "开始请求 ZCode Protocol session/resume", {
        mcpServerCount: getMcpServerCount(params),
        mcpServerNames: getMcpServerNames(params),
        modelHint: params.model ?? null,
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        // 响应同样是完整 snapshot：resume 的语义是「返回恢复后的权威状态」，
        // 不是增量，调用方可以直接替换本地投影。
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionResume,
          buildSessionResumeParams({ ...params, offPeakToolEnabled, ...dynamicWorkflowFlags }),
          zcodeSessionStateSnapshotSchema,
        );
        // rememberSessionTrace 返回新 trace；没有则沿用缓存，保证后续日志仍能串起来。
        const sessionTraceId = rememberSessionTrace(params, snapshot) ?? cachedTraceId;
        logger.info(sessionTraceId, "ZCode Protocol session/resume 完成", {
          durationMs: Date.now() - startedAt,
          messageCount: snapshot.messages.length,
          modelCurrent: formatModelSelectionForLog(snapshot.settings.model.current),
          mcpServerCount: getMcpServerCount(params),
          sessionId: params.sessionId,
          snapshotTraceId: snapshot.session.traceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      // [失败路径] 兼容重试的判据与 create 同源（不认识的键必须全在白名单内），
      // 但 resume 的可选字段集合不同（见 SESSION_RESUME_OPTIONAL_COMPAT_FIELDS）。
      } catch (error) {
        const compatFields = getSessionResumeCompatFields(error);
        if (compatFields.length === 0) {
          logger.warn(cachedTraceId, "ZCode Protocol session/resume 失败", {
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : String(error),
            sessionId: params.sessionId,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          throw error;
        }
        logger.warn(cachedTraceId, "ZCode Protocol session/resume 命中新旧协议兼容重试", {
          compatFields,
          durationMs: Date.now() - startedAt,
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        // 重试用同一 sessionId 与同一组 flags：省略未知字段后再次请求，
        // 不能顺手降级灰度能力，否则「旧 CLI 兼容」会变成「功能静默关闭」。
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionResume,
          buildSessionResumeParams(
            { ...params, offPeakToolEnabled, ...dynamicWorkflowFlags },
            new Set(compatFields),
          ),
          zcodeSessionStateSnapshotSchema,
        );
        // 恢复成功后再更新 trace 缓存：失败路径不写缓存，避免把一次失败请求的
        // trace 当成会话的长期关联 id。
        const sessionTraceId = rememberSessionTrace(params, snapshot) ?? cachedTraceId;
        logger.info(sessionTraceId, "ZCode Protocol session/resume 兼容重试完成", {
          durationMs: Date.now() - startedAt,
          sessionId: params.sessionId,
          snapshotTraceId: snapshot.session.traceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return snapshot;
      }
    },

    // 列表类方法统一走 getReadOnlyClient：打开会话列表不应创建可执行 runtime，
    // runtimePolicy 由调用方决定是否允许拉起（existing-only 用于后台补索引）。
    async listSessions(params: ZCodeAgentListSessionsParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
// limit 与 sessionIds 都只做条件展开，缺省时让 CLI 用默认分页口径。
      const result = await client.request(
        zcodeProtocolMethods.sessionList,
        {
          workspace: buildWorkspaceRef(params),
          limit: params.limit,
          ...(params.sessionIds ? { sessionIds: params.sessionIds } : {}),
        },
        zcodeSessionListResultSchema,
      );
      // 列表返回的 traceId 回填缓存：会话尚未 resume 时，后续 send/compact 只能靠
      // 这份缓存关联日志；key 用 sessionEventKey（含 workspace/identity），不能只用 sessionId。
// 只回填带 traceId 的会话，缺失时保留已有缓存，避免用空值覆盖有效值。
      for (const session of result.sessions) {
        if (session.traceId) {
          sessionTraceIdBySessionKey.set(
            sessionEventKey({ ...params, sessionId: session.sessionId }),
            session.traceId as TraceId,
          );
        }
      }
      return result.sessions;
    },

    // subagent 列表只读且属于会话附属信息：不走 getClient，避免查看子代理
    // 把只读 workspace 提升为模型执行态。
    async listSessionSubagents(params: ZCodeAgentListSessionSubagentsParams) {
// 只读路径：查看子代理不应把 workspace 提升为可执行模型的状态。
      const client = await getReadOnlyClient(params);
// 分页参数只透传 cursor/limit，其余字段由协议 schema 决定，门面不补充语义。
      return client.request(
        zcodeProtocolMethods.sessionSubagents,
        {
          sessionId: params.sessionId,
          endedCursor: params.endedCursor,
          endedLimit: params.endedLimit ?? 20,
        },
        zcodeSessionSubagentsResultSchema,
      );
    },

    // [权衡] usage 表在全局 session 库，任意已连接 workspace 都能读全应用数据；
    // 这里刻意取「第一个 active client」而不是拉起专用进程：没有 active 时直接报错，
    // 让调用方重试，而不是为一次统计查询启动 CLI。
    async getAppUsageStats(params: ZCodeAgentAppUsageParams) {
      // usage 表位于全局 session 库；复用任意已连接的 workspace client 即可拿到全应用范围数据。
      // values().next().value 可能为 undefined：Map 为空即没有可用 runtime，
      // 抛稳定错误而不是隐式创建进程。
      const active = activeClientsByWorkspaceKey.values().next().value;
      if (!active) {
        throw new Error("no_active_workspace");
      }
      // usage/stats → v4/usage/stats（additive query，事实源在 CLI usage store，
      // 载荷同形；旧词消费清零，CLI 旧 case 留到旧词删除之时）。
      // usage/stats 已迁到 V4 名字空间：事实源在 CLI usage store，Host 只转发，
      // 不做二次聚合（INV-01）。
      return active.client.request(
        V4_METHODS.usageStats,
        { range: params.range, timeZone: params.timeZone },
        v4UsageStatsResultSchema,
      );
    },

    // task 是 UI 投影概念，V4 里落位 conversation：这里按 sessionId 查 token 用量，
    // 不经过 task adapter，避免把迁移期结构引入新链路（INV-08）。
    async getTaskTokenUsage(params: ZCodeAgentTaskTokenUsageParams) {
      const client = await getReadOnlyClient(params);
      // session/usage → v4/conversation/usage（同上；task 是 UI 投影概念，
      // v4 名字空间落位 conversation）。
      return client.request(
        V4_METHODS.conversationUsage,
        { sessionId: params.sessionId },
        v4ConversationUsageResultSchema,
      );
    },

    // readSession 的 runtimePolicy 决定它是「观察」还是「普通读取」：
    // task-index 补正文时必须 existing-only，否则一次索引扫描会把已回收的 runtime 重新拉起。
    async readSession(params: ZCodeAgentReadSessionParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      // 只有显式普通读取才同步 provider registry：existing-only 必须保持纯观察，
      // 连配置同步这种写操作都不能做，否则观察者会改变进程状态。
      // task-index 为补正文索引调用 readSession 时，默认策略会在 runtime
      // 已被回收后重新拉起 Agent；这条观察路径不应改变 session 生命周期。只有显式
      // 的普通读取才同步 provider registry，existing-only 读取必须保持纯观察语义。
      if (params.runtimePolicy !== "existing-only") {
        await ensureAccountProviderConfigSynced({
          client,
          reason: "session_read",
          workspace: params,
        });
      }
      // afterSeq 与 messageLimit 组合成增量读：调用方用 deliveryKind 选择投影形态，
      // Host 不做裁剪，保证 snapshot 与 CLI 的 seq 语义一致。
      const snapshot = await client.request(
        zcodeProtocolMethods.sessionRead,
        {
          sessionId: params.sessionId,
          deliveryKind: params.deliveryKind,
          messageLimit: params.messageLimit,
          afterSeq: params.afterSeq,
          contentProfile: params.contentProfile,
        },
        zcodeSessionStateSnapshotSchema,
      );
      // read 也回填 trace：有些会话从未 create/resume（如导入），只能从 read 的 snapshot 拿到。
      rememberSessionTrace(params, snapshot);
      return snapshot;
    },

    // messages 是分页接口，与 readSession 的 snapshot 不同：它不返回设置/状态，
    // 只用于「加载更早消息」，因此不需要 trace 回填。
    async readSessionMessages(params: ZCodeAgentReadSessionMessagesParams) {
// 分页读取走只读 client：历史消息不会改变运行时状态。
      const client = await getReadOnlyClient(params);
      const result = await client.request(
        zcodeProtocolMethods.sessionMessages,
        {
          sessionId: params.sessionId,
          afterMessageId: params.afterMessageId,
          limit: params.limit,
        },
        zcodeSessionMessagesResultSchema,
      );
// 只拆出 messages 数组，分页游标等信封字段不对外暴露。
      return result.messages;
    },

    // debug 快照可能很大且只用于诊断：existing-only 防止打开诊断面板就启动进程。
    async readSessionDebug(params) {
// existing-only：诊断读取不拉起新进程，没有现成 runtime 就直接失败。
      const client = await getReadOnlyClient(params, "existing-only");
// debug 快照原样返回，门面不做裁剪，避免诊断信息在 Host 侧丢失。
      return client.request(
        zcodeProtocolMethods.sessionDebug,
        { sessionId: params.sessionId },
        sessionDebugSnapshotSchema,
      );
    },

    // events 是 CLI 的原始事件流（replay 用）：afterSeq 由调用方维护，
    // Host 不缓存事件，避免成为第二事实源（INV-01）。
    async readSessionEvents(params: ZCodeAgentReadSessionEventsParams) {
// replay 只读，不写 pending、不广播事件，因此同样走只读 client。
      const client = await getReadOnlyClient(params);
      const result = await client.request(
        zcodeProtocolMethods.sessionEvents,
        {
          sessionId: params.sessionId,
          afterSeq: params.afterSeq,
          limit: params.limit,
        },
        zcodeSessionEventsResultSchema,
      );
// 只返回事件数组：afterSeq 的推进由调用方自己维护，Host 不持有游标。
      return result.events;
    },

    // workspace/readPresentation 是设置页首屏的关键读：它可能正好撞上配置更新触发的
    // runtime 重启，因此需要「关闭 transport 后重取 client 重试一次」的专门处理。
    async readWorkspacePresentation(params: ZCodeAgentReadWorkspacePresentationParams) {
      const startedAt = Date.now();
      logger.info(undefined, "开始请求 ZCode Protocol workspace/readPresentation", {
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
        let presentation: ZCodeWorkspacePresentation | undefined;
        // [权衡] 只重试一次：transport 关闭通常意味着本代 client 已失效，第二次仍失败
        // 就是真实错误；无限重试会在 runtime 崩溃循环里打爆日志与 CPU。
        for (let attempt = 0; attempt < 2; attempt += 1) {
          // 每轮都重新 getReadOnlyClient：第一轮的 client 可能已被 invalidate，
          // 复用旧引用会再次拿到已关闭的 transport。
          const client = await getReadOnlyClient(params);
          try {
            // 普通读取需要 provider 配置就绪：presentation 里的模型/命令目录依赖账号上下文。
            await ensureAccountProviderConfigSynced({
              client,
              reason: "workspace_read_presentation",
              workspace: params,
            });
            presentation = await client.request(
              zcodeProtocolMethods.workspaceReadPresentation,
              { workspace: buildWorkspaceRef(params) },
              zcodeWorkspacePresentationSchema,
            );
            break;
          // [失败路径] 只识别「已关闭 stdio transport」这一种可重试错误：
          // 超时、鉴权、协议错误都必须原样上抛，否则会把真实故障藏进重试。
          } catch (error) {
            if (attempt > 0 || !isClosedStdioTransportError(error)) {
              throw error;
            }
            // 读取 workspace 状态时，配置更新可能正好重启该 workspace Agent。
            // 旧 client 已取得但尚未发送请求，stdio transport 就被关闭；只读请求重新获取
            // 当前 client 并重试一次，避免把生命周期竞态直接暴露给用户。
            logger.warn(
              undefined,
              "workspace/readPresentation 命中已关闭 transport，重新获取 Agent",
              {
                workspaceKey: resolveWorkspaceKey(params),
                workspacePath: params.workspacePath,
              },
            );
            // [并发] identity-guarded invalidation：onClose 可能还没执行，这里主动清理
            // 能及时释放该 client 的 pending 与偏好同步状态；若只删 active entry，
            // 会留下 promise/定时器悬挂（INV-03/INV-07）。
            const workspaceKey = resolveWorkspaceKey(params);
            if (activeClientsByWorkspaceKey.get(workspaceKey)?.client === client) {
              // transport.send 可能先观察到关闭，而 onClose 清理尚未执行；统一走 identity-
              // guarded invalidation，避免只删 active entry 却遗留 preference/model sync 状态。
              // 传入当前 client 而不是 workspaceKey 单独删除：await 期间可能已换代，
              // 无 identity 的删除会误伤新 client。
              invalidateWorkspaceClient(workspaceKey, client);
            }
          }
        }
        // 两轮都未返回结果（理论上只有 break 才能到达这里）：显式抛错而不是返回 undefined，
        // 避免调用方把空 presentation 当成「没有命令」。
        if (!presentation) {
          throw new Error("ZCode Protocol workspace/readPresentation did not return a result");
        }
        logger.info(undefined, "ZCode Protocol workspace/readPresentation 完成", {
          durationMs: Date.now() - startedAt,
          slashCommandCount: presentation.slashCommands.length,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return presentation;
      // [失败路径] 统一记录耗时与 workspace 后上抛：设置页需要区分「重试后仍失败」
      // 与「首次即失败」，attempt 痕迹由上面的 warn 提供。
      } catch (error) {
        logger.warn(undefined, "ZCode Protocol workspace/readPresentation 失败", {
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    // hook 预信任不依赖 session：Settings 允许用户在从未创建会话时先信任工作区 hook，
    // 因此用只读 client，且不要求 provider/model 就绪。
    async grantWorkspaceHookTrust(params: ZCodeAgentGrantWorkspaceHookTrustParams) {
      // 没有 task 时仍允许显式预信任，但只启动 read-only Agent 控制面；不能为了
      // Settings 操作伪造 session，也不能要求 provider/model 已就绪。
      const client = await getReadOnlyClient(params);
      // 上送 workspace/bundle/hook 三个 digest：CLI 用它们判定信任对象是否已变化，
      // 只传路径会让同一路径下的新 hook 自动继承旧信任。
      return client.request(
        zcodeProtocolMethods.workspaceHookTrustGrant,
        {
          workspace: buildWorkspaceRef(params),
          bundleDigest: params.bundleDigest,
          hookDeclarationDigest: params.hookDeclarationDigest,
        },
        zcodeWorkspaceHookTrustGrantResultSchema,
      );
    },

    // mcp/list 有三种兼容维度：mode 不被识别、mcpServers 不被识别、请求超时。
    // 三者的正确处理不同（报错/降级/重启重试），不能合并成一个 catch。
    async listMcpServerStatuses(params: ZCodeAgentListMcpServerStatusesParams) {
      // 闭包复用同一 client 获取路径：每次重试都重新 getMcpStatusClient，
      // 超时后 process manager 已回收 stale client，重试自然拿到新进程。
      const requestMcpList = async (options?: { omitMcpServers?: boolean; omitMode?: boolean }) => {
// 每次调用都重新取 client，兼容层重试时才能拿到超时回收后的新进程。
        const client = await getMcpStatusClient();
// omit 标记只影响两个可选字段，workspace 永远随请求下发。
        return client.request(
          zcodeProtocolMethods.mcpList,
          {
            workspace: buildWorkspaceRef(params),
            // 只有调用方显式给了字段才下发：旧 CLI 的 strict schema 对「多余的可选字段」
            // 也会拒绝，因此不能用 undefined 占位。
            ...(params.mcpServers !== undefined && !options?.omitMcpServers
              ? { mcpServers: params.mcpServers }
              : {}),
            ...(params.mode !== undefined && !options?.omitMode ? { mode: params.mode } : {}),
          },
          zcodeMcpListResultSchema,
        );
      };
      try {
        return await requestMcpList();
      } catch (error) {
        const unrecognizedKeys = getUnrecognizedTopLevelKeys(error);
        // [失败路径] status-only 不能退化成默认 connect：省略 mode 会重新执行 replace 收敛，
        // 可能断开 UI 显式下发但旧 Agent 配置中不存在的 MCP。这里用稳定错误码让 UI
        // 停止不可能成功的轮询（INV-05/INV-06）。
        if (params.mode === "status" && unrecognizedKeys.includes("mode")) {
          // 旧 Agent 不认识 status-only 时，省略 mode 重试会退回默认 connect，
          // 重新执行 replace 收敛并可能断开 UI 显式下发但旧 Agent 配置中不存在的 MCP；
          // 稳定错误码会跨 host RPC 保留，供 UI 停止不可能成功的轮询。
          logger.warn(undefined, "旧 Agent 不支持 MCP status-only，跳过会改变连接集合的兼容重试", {
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          throw new ZCodeAgentMcpStatusModeUnsupportedError();
        }
        // mode/mcpServers 可同时不被识别：分别记录后再一次性重试，
        // 避免「先去掉 mode 再发现 mcpServers 也不行」的两轮往返。
        if (
          (params.mode !== undefined && unrecognizedKeys.includes("mode")) ||
          (params.mcpServers !== undefined && unrecognizedKeys.includes("mcpServers"))
        ) {
          const omitMode = unrecognizedKeys.includes("mode");
          const omitMcpServers = unrecognizedKeys.includes("mcpServers");
          logger.warn(undefined, "MCP 状态列表命中新旧协议兼容重试", {
            omittedKeys: [...(omitMode ? ["mode"] : []), ...(omitMcpServers ? ["mcpServers"] : [])],
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          return await requestMcpList({
            omitMcpServers,
            omitMode,
          });
        }
        // 只有本方法的超时才算可重试：其它方法的超时不应被这里的 catch 吞掉；
        // method 匹配防止把 create/send 的超时误判成 mcp/list（INV-05）。
        if (!isProtocolRequestTimeout(error, zcodeProtocolMethods.mcpList)) {
          throw error;
        }
        // [资源] 超时后 process manager 已回收无响应的 client；重试会拉起新进程，
        // 因此这里必须是「重新获取 client」而不是复用闭包外的旧引用。
        logger.warn(undefined, "MCP 状态列表请求超时，重启无响应 agent 后重试一次", {
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
          message: error instanceof Error ? error.message : String(error),
        });
        return await requestMcpList();
      }
    },

    // 插件列表只读本地 metadata，因此走默认协议超时而不是 5 分钟市场 I/O 超时：
    // 这样 stale client 能及时触发回收，设置页可从重新拉起的进程自动恢复。
    async listPlugins(params: ZCodeAgentPluginViewParams) {
      // 每次请求都重新 getPluginManagementClient：超时后进程被回收，重试需要新 client。
      const requestPluginsList = async () => {
        const client = await getPluginManagementClient();
        // plugins/list 只读取本地 plugin metadata，与 mcp/list 一样走默认协议超时，
        // 这样 stale client 能在合理时间内触发回收并重试，而不是被 5 分钟市场 I/O 超时拖住。
        return client.request(
          zcodeProtocolMethods.pluginsList,
          {
            workspace: buildWorkspaceRef(params),
            ...(params.configScope ? { configScope: params.configScope } : {}),
          },
          zcodePluginsListResultSchema,
        );
      };
      try {
        return await requestPluginsList();
      } catch (error) {
        // 只对 plugins/list 自身的超时重试一次：其它错误（解析失败、权限）重试无意义。
        if (!isProtocolRequestTimeout(error, zcodeProtocolMethods.pluginsList)) {
          throw error;
        }
        logger.warn(undefined, "插件列表请求超时，重启无响应 agent 后重试一次", {
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
          message: error instanceof Error ? error.message : String(error),
        });
        // [失败路径] 幂等读请求才允许自动重试：安装/卸载等写操作不能在超时后盲目重放，
        // 否则可能产生重复安装或半完成状态。
        // 插件列表只读取 CLI plugin metadata。若旧 agent 进程还活着但协议不回包，
        // 第一次 plugins/list 超时后不能继续复用 stale client。process manager 会在超时时回收该 client，
        // 这里对幂等的列表请求重试一次，让设置页可从重新拉起的 app-server 自动恢复。
        return await requestPluginsList();
      }
    },

    // Plugin/Skill 引用 catalog 必须打到「持有 session 记录」的 workspace agent：
    // 独立 plugin management 进程没有 resident session，session-owned catalog 永远查不到。
    async getPluginReferenceCatalog(params: ZCodeAgentPluginReferenceCatalogParams) {
      // Plugin 引用 catalog 必须打到持有 session 记录的 workspace agent client
      // （getReadOnlyClient 优先复用 active client），不能走独立 plugin management 进程——
      // 那个进程没有任何 session，session-owned catalog 会永远查不到。
      // getReadOnlyClient 会优先复用 active client；这里不能用 getPluginManagementClient，
      // 否则会查到一个空进程的 catalog（INV-06：方法存在不等于能力可用）。
      const client = await getReadOnlyClient(params);
      return requestPluginReferenceCatalog(client, {
        workspace: buildWorkspaceRef(params),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      });
    },

    // Skill 引用与 Plugin 同理：session 快照只存在于 workspace agent 进程；
    // 两者共用 getReadOnlyClient 的复用规则，保证读到同一代 session。
    async getSkillReferenceCatalog(params: ZCodeAgentSkillReferenceCatalogParams) {
      // 与 Plugin 引用一样，Session 快照只存在于 workspace agent 进程；独立管理进程
      // 没有 resident Session，不能作为对话 authority。
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.skillsReferenceCatalog,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        },
        zcodeSkillsReferenceCatalogResultSchema,
      );
    },

    // MCP UI 实例面：open/validate/recycle/close 都绑定到 workspace client，
    // 因为实例的 ownerWebContentsId、资源订阅与工具注册都寄存于该进程（INV-07）。
    async openMcpUiInstance(params) {
// 实例必须落在 workspace agent 进程，不能复用 MCP 状态探测的独立进程。
      const client = await getReadOnlyClient(params);
// 打开动作不缓存任何实例句柄，后续操作都靠 params.instance 重新定位。
      return client.request(
        zcodeProtocolMethods.mcpUiOpenInstance,
        // 上送 ownerWebContentsId：CLI 用它把实例生命周期绑定到具体窗口，
        // 窗口销毁时能主动回收；Host 不自行维护这层映射。
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          accountContext: params.accountContext,
          resourceUri: params.resourceUri,
          ownerWebContentsId: params.ownerWebContentsId,
        },
        zcodeMcpUiOpenInstanceResultSchema,
      );
    },
    // validate 只做协议校验并返回空结果：真正的实例校验在 CLI 侧，
    // Host 不缓存 instance 状态，避免与 CLI 事实源分叉。
    async validateMcpUiInstance(params) {
// 校验是纯观察操作，用只读 client，不因一次校验失败而拉起新进程。
      const client = await getReadOnlyClient(params);
// 只把协议要求的身份字段透传，门面不缓存或比对 instance 状态。
      await client.request(
        zcodeProtocolMethods.mcpUiValidateInstance,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          serverName: params.serverName,
          instance: params.instance,
        },
// 空结果 schema：CLI 不回内容，Host 也不需要把校验结论再包装一层。
        mcpUiEmptyResultSchema,
      );
    },
    // recycle 带 onlyIfIdle=true：只在实例空闲时关闭，正在执行的工具调用不会被腰斩；
    // 返回值 closed 让调用方区分「已回收」与「忙，稍后再试」。
    async recycleMcpUiInstance(params) {
// 回收同样只读：关闭实例由 CLI 执行，Host 不持有实例句柄。
      const client = await getReadOnlyClient(params);
// 带 onlyIfIdle=true，调用方必须接受「忙时不关」这一结果。
      const result = await client.request(
        zcodeProtocolMethods.mcpUiCloseInstance,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          serverName: params.serverName,
          instance: params.instance,
          onlyIfIdle: true,
        },
        zcodeMcpUiCloseInstanceResultSchema,
      );
// 只把 closed 布尔值交给上层，其余关闭详情留在 CLI 侧，不复制成第二状态源。
      return result.closed;
    },
    // close 用于确定要关闭的场景（窗口销毁/插件卸载）：不等待空闲，直接释放。
    async closeMcpUiInstance(params) {
// 强制关闭语义：不加 onlyIfIdle，窗口销毁/插件卸载时必须在这一次调用里释放。
      const client = await getReadOnlyClient(params);
// 关闭结果被刻意丢弃：调用方只关心关闭动作已发出，不关心 CLI 的返回体。
      await client.request(
        zcodeProtocolMethods.mcpUiCloseInstance,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          serverName: params.serverName,
          instance: params.instance,
        },
// 仍用 close 的结果 schema 做校验，但门面不把它回传给调用方。
        zcodeMcpUiCloseInstanceResultSchema,
      );
    },
    async readMcpResource(params: ZCodeAgentReadMcpResourceParams) {
      // 与 Skill / Plugin 引用一样，session 冻结 catalog 只存在于 workspace agent 进程。
// 读取不改变实例状态，用只读 client 即可，不触发 runtime 启动。
      const client = await getReadOnlyClient(params);
// uri 必须是 CLI catalog 里的原始值，门面不做规范化，否则会读错资源。
      return client.request(
        zcodeProtocolMethods.mcpReadResource,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          uri: params.uri,
        },
        zcodeMcpReadResourceResultSchema,
      );
    },

    // sampling 是 MCP App 反向调用模型的通道：existing-only 保证一次采样失败
    // 不会把 runtime 重新拉起再重试，避免用户看到重复的模型费用。
    async sampleMcpApp(params) {
      const client = await getReadOnlyClient(params, "existing-only");
      // 先把 workspacePath/identity 从 params 里摘掉再展开：wire 参数由 workspace ref
      // 统一表达，重复字段会触发严格 schema 拒绝。
      const { workspacePath: _path, workspaceIdentity: _identity, ...bound } = params;
      const wire = { ...bound, workspace: buildWorkspaceRef(params) };
      // 采样用专用超时（MCP_APPS_SAMPLING_TRANSPORT_TIMEOUT_MS）：模型生成本就慢，
      // 用默认协议超时会在正常长回答时误杀。
      try {
        return await client.request(
          zcodeProtocolMethods.mcpUiSampling,
          wire,
          zcodeMcpUiSamplingResultSchema,
          { timeoutMs: MCP_APPS_SAMPLING_TRANSPORT_TIMEOUT_MS },
        );
      // [失败路径] 超时/通道失败只发 cancel，不重新发起采样：重试会重复计费，
      // 且原调用在 CLI 侧可能仍在执行，必须先取消再上抛。
      } catch (error) {
        // 超时/通道失败只取消原调用，不能恢复 Agent 并重新发起采样。
        // 从 wire 中剔除 request 再发 cancel：cancel 只需要身份三元组与 callId，
        // 带 request 会让 CLI 误以为这是新的采样请求。
        const { request: _request, ...cancelParams } = wire;
        void client
          .request(
            zcodeProtocolMethods.mcpUiCancelSampling,
            cancelParams,
            zcodeMcpUiCancelCallResultSchema,
          )
          // cancel 失败不再覆盖原始错误：调用方需要看到真正的超时/通道原因；
          // 这里只做 best-effort 释放。
          .catch(() => undefined);
        throw error;
      }
    },
    // 单独暴露 cancel：UI 侧用户主动停止时不必等采样超时，直接按 callId 取消。
    async cancelMcpAppSampling(params) {
// existing-only：取消是收尾动作，绝不能为了取消而重新拉起一个 runtime。
      const client = await getReadOnlyClient(params, "existing-only");
// 摘掉 workspacePath/identity 后整体转发：cancel 只需要身份三元组与 callId。
      const { workspacePath: _path, workspaceIdentity: _identity, ...bound } = params;
      return client.request(
        zcodeProtocolMethods.mcpUiCancelSampling,
        { ...bound, workspace: buildWorkspaceRef(params) },
        zcodeMcpUiCancelCallResultSchema,
      );
    },
    // callMcpToolForUi 与 readMcpResourceForUi 同进程：工具归属（pluginId ↔ serverName）、
    // mimeType 白名单与大小上限都在 agent 侧 fail closed，Host 只转发身份。
    async callMcpToolForUi(params: ZCodeAgentCallMcpToolForUiParams) {
// 工具调用只转发，不预检归属；pluginId/serverName 的一致性由 CLI 判定。
      const client = await getReadOnlyClient(params);
      // arguments 只在存在时展开：空对象与「省略」在 MCP 语义上不同，
      // 空对象可能被当成显式无参数调用。
      return client.request(
        zcodeProtocolMethods.mcpUiCallTool,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          toolName: params.toolName,
          ...(params.arguments ? { arguments: params.arguments } : {}),
          callId: params.callId,
        },
        zcodeMcpUiCallToolResultSchema,
      );
    },

    // cancelMcpToolCallForUi 与 callMcpToolForUi 成对：callId 由 UI 生成，
    // CLI 据此定位并终止进行中的工具调用，Host 不维护 call 表。
    async cancelMcpToolCallForUi(params: ZCodeAgentCancelMcpToolCallForUiParams) {
// 取消属于收尾动作，用只读 client，不触发 workspace 提升。
      const client = await getReadOnlyClient(params);
// callId 原样下传：Host 不维护 call 表，无法校验或补全这个 id。
      return client.request(
        zcodeProtocolMethods.mcpUiCancelCall,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          callId: params.callId,
        },
// 取消结果只做 schema 校验，正常情况下 CLI 会回一个已取消标记。
        zcodeMcpUiCancelCallResultSchema,
      );
    },

    // 资源读取的 8 MiB 上限与 mimeType 白名单在 CLI 侧执行：Host 不做二次判断，
    // 否则两处阈值漂移会让「Host 放行、CLI 拒绝」变成难查的错误。
    async readMcpResourceForUi(params: ZCodeAgentReadMcpResourceForUiParams) {
      // 与 callMcpToolForUi 同一进程：归属（pluginId ↔ serverName）、mimeType 白名单与 8 MiB 上限都在 agent 侧 fail closed。
// 读取资源同样不改实例状态，但必须命中同一 agent 进程才能看到该实例的 catalog。
      const client = await getReadOnlyClient(params);
// 原样返回资源体；大小与 mimeType 的拒绝已在 CLI 侧完成，Host 不再裁剪。
      return client.request(
        zcodeProtocolMethods.mcpUiReadResource,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          uri: params.uri,
        },
        zcodeMcpUiReadResourceResultSchema,
      );
    },

    // listResources 与 listResourceTemplates 共用参数形状：cursor 只在有值时下发，
    // 空字符串分页游标会被 CLI 当成非法值。
    async listMcpResourcesForUi(params: ZCodeAgentListMcpResourcesForUiParams) {
// 列表是观察操作：实例与 catalog 都已在 CLI 侧，Host 只负责转发。
      const client = await getReadOnlyClient(params);
// 返回完整分页结果而不是只取 resources，nextCursor 必须交给调用方继续翻页。
      return client.request(
        zcodeProtocolMethods.mcpUiListResources,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
// cursor 为空串时整体省略：空串会被 CLI 当作非法分页游标。
          ...(params.cursor ? { cursor: params.cursor } : {}),
        },
        zcodeMcpUiListResourcesResultSchema,
      );
    },

    async listMcpResourceTemplatesForUi(params: ZCodeAgentListMcpResourcesForUiParams) {
// 与 listResources 共用参数类型，差异只在 method 与结果 schema。
// 模板列表是静态 catalog 的一部分，不会因为读取资源而变化。
      const client = await getReadOnlyClient(params);
// 模板结果保留 nextCursor，同样不在门面层拆分。
      return client.request(
        zcodeProtocolMethods.mcpUiListResourceTemplates,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          ...(params.cursor ? { cursor: params.cursor } : {}),
        },
        zcodeMcpUiListResourceTemplatesResultSchema,
      );
    },

    // [资源] 资源订阅登记在 agent 侧：按 (server, uri) 引用计数并随重连重放；
    // Host 只转发身份三元组，不保存订阅表，避免断线后 Host/CLI 两份计数不一致（INV-04 的订阅所有权）。
    async subscribeMcpResourceForUi(params: ZCodeAgentMcpResourceSubscriptionForUiParams) {
      // 订阅/退订都带 scopeId + generation：同一 server 可能被多个插件实例复用，
      // 只按 serverName 退订会误删其它实例的订阅。
      // 订阅登记在 agent 侧（按 server / uri 引用计数并随重连重放）；host 只转发身份三元组。
      const client = await getReadOnlyClient(params);
      await client.request(
        zcodeProtocolMethods.mcpUiSubscribeResource,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
          uri: params.uri,
        },
        zcodeMcpUiResourceSubscriptionResultSchema,
      );
    },

    // 退订同样要带 generation：旧实例的迟到退订不能影响新实例的订阅计数。
    async unsubscribeMcpResourceForUi(params: ZCodeAgentMcpResourceSubscriptionForUiParams) {
// 退订同样只读：引用计数在 CLI 侧，Host 不提前改本地状态。
      const client = await getReadOnlyClient(params);
// scopeId 与 generation 必须一起传，缺一不可，否则会误退订其它实例的订阅。
      await client.request(
        zcodeProtocolMethods.mcpUiUnsubscribeResource,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
          uri: params.uri,
        },
// 退订不回结果体，门面直接返回 void，调用方无需处理计数细节。
        zcodeMcpUiResourceSubscriptionResultSchema,
      );
    },

    // app tools 注册/认领/结算是一组有状态 RPC：scopeId/generation 决定工具归属，
    // 注册与注销必须成对，否则进程级工具表会泄漏（INV-11）。
    async registerAppToolsForUi(params: ZCodeAgentRegisterAppToolsForUiParams) {
// 注册是有状态写 RPC，但 client 仍是只读路径：状态落在 CLI 的工具表里。
      const client = await getReadOnlyClient(params);
// 返回 CLI 的注册结果（含已接受/冲突），门面不改写结论。
      return client.request(
        zcodeProtocolMethods.mcpUiRegisterAppTools,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
// tools 原样上送：工具定义属于 UI 侧，Host 不做 schema 之外的加工。
          tools: params.tools,
        },
        zcodeMcpUiRegisterAppToolsResultSchema,
      );
    },

    // unregister 只需要身份 + scope/generation：工具清单由 CLI 按 scope 维护，
    // 调用方不必回传 tools，避免 Host 成为工具表的第二事实源。
    async unregisterAppToolsForUi(params: ZCodeAgentAppToolInstanceForUiParams) {
// 与 register 成对：只凭实例身份注销，不需要回传工具清单。
      const client = await getReadOnlyClient(params);
// 注销结果直接透传，调用方据此确认 scope 是否已清空。
      return client.request(
        zcodeProtocolMethods.mcpUiUnregisterAppTools,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
// generation 必须带：旧实例的迟到注销不能清掉新实例注册的工具。
          generation: params.generation,
        },
        zcodeMcpUiUnregisterAppToolsResultSchema,
      );
    },

    // claim 是「UI 接管某次 app tool 调用」的原子操作：callId 必须由 UI 提供，
    // 重复 claim 由 CLI 判定，Host 不做幂等缓存。
    async claimAppToolCallForUi(params: ZCodeAgentAppToolCallForUiParams) {
// 认领的原子性由 CLI 保证，Host 不预先查询或加锁。
      const client = await getReadOnlyClient(params);
// accepted 结果透传：重复认领会在这里得到否定答复，而非在 Host 侧被吞掉。
      return client.request(
        zcodeProtocolMethods.mcpUiClaimAppToolCall,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
// callId 是认领的唯一凭据，必须由 UI 提供，Host 不生成也不缓存。
          callId: params.callId,
        },
        zcodeMcpUiAppToolAcceptedResultSchema,
      );
    },

    // resolve 同时支持 result 与 error：二者互斥但都可能缺省（表示只确认收到）；
    // 用条件展开而不是写 undefined，保证严格 schema 不把空字段当成显式值。
    async resolveAppToolCallForUi(params: ZCodeAgentResolveAppToolCallForUiParams) {
// 结算同样只转发身份与 callId，Host 不判断调用最终成功还是失败。
      const client = await getReadOnlyClient(params);
// result/error 都用条件展开，避免 undefined 被序列化成显式空值。
      return client.request(
        zcodeProtocolMethods.mcpUiResolveAppToolCall,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
// callId 必须原样回传，结算才能对上之前的 claim，否则 CLI 会拒绝这次 resolve。
          callId: params.callId,
          ...(params.result ? { result: params.result } : {}),
          ...(params.error ? { error: params.error } : {}),
        },
        zcodeMcpUiAppToolAcceptedResultSchema,
      );
    },

    // 插件 UI 面板只在已有会话时可打开，此时 workspace agent 必然存在；
    // 因此走 workspace client 读它解析好的清单，而不是独立管理进程
    // （后者没有本 workspace 的启停状态上下文）。
    async listPluginUiSurfaces(params: ZCodeAgentWorkspaceTarget) {
      // 面板只在已有会话时可打开，此时 workspace agent 必然存在；走 read-only client 读它解析好的清单，
      // 不用独立插件管理进程（那边没有本 workspace 的启停状态上下文，与 mcp/readResource 同理）。
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.pluginsListUiSurfaces,
        { workspace: buildWorkspaceRef(params) },
        zcodePluginsListUiSurfacesResultSchema,
      );
    },

    // 已保存工作流的 GUI 中枢：与 Skill catalog 同一条
    // workspace agent client 路径；文件在 workspace 里，远程 workspace 就在远端进程里扫。
    // 全局档：载体由 resolveSavedWorkflowCarrier 选，
    // `scope` 只在有定义时下推。
    // 已保存工作流是 workspace 文件能力：列表/读取/改元数据/删除/运行记录都经
    // resolveSavedWorkflowCarrier，保证「项目档直通、全局档自选本机载体」只有一处判定。
    async listSavedWorkflows(params: ZCodeAgentListSavedWorkflowsParams) {
// 载体选择（项目档直通 / 全局档自选）全部交给 resolveSavedWorkflowCarrier。
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
// scope 只在有定义时下推，避免 undefined 进入严格 schema。
      return client.request(
        zcodeProtocolMethods.workflowsList,
        { workspace, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsListResultSchema,
      );
    },

    // get 只按 name 定位：workflow 文件的作用域由 workspace 载体决定，
    // 不额外传路径，避免 Host 拼接出越界路径。
    async getSavedWorkflow(params: ZCodeAgentGetSavedWorkflowParams) {
// 与列表共用同一载体解析，保证读与列看到的是同一份文件。
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
// 只传 name 与 scope，路径拼接完全在 CLI 侧完成，避免越界访问。
      return client.request(
        zcodeProtocolMethods.workflowsGet,
        { workspace, name: params.name, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsGetResultSchema,
      );
    },

    // updateMeta 只改元数据不动脚本：脚本编辑走独立链路，混在一起会让
    // 一次元数据保存触发脚本重校验。
    async updateSavedWorkflowMeta(params: ZCodeAgentUpdateSavedWorkflowMetaParams) {
// resolveSavedWorkflowCarrier 决定 meta 改动落在哪个 workspace，与列表/读取同一作用域判定。
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
// 只上送 meta，脚本正文不在本方法的能力范围内。
      return client.request(
        zcodeProtocolMethods.workflowsUpdateMeta,
        { workspace, name: params.name, meta: params.meta, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsUpdateMetaResultSchema,
      );
    },

    // delete 是不可逆操作：Host 不做软删除缓存，直接交给 CLI 落盘；
    // 失败原样上抛，让 UI 明确提示用户。
    async deleteSavedWorkflow(params: ZCodeAgentDeleteSavedWorkflowParams) {
// 删除直接落到工作流文件所在载体，Host 不保留回收站或延迟删除副本。
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
// 删除结果透传；失败不在这里转成 false，避免 UI 把错误当成「没找到」。
      return client.request(
        zcodeProtocolMethods.workflowsDelete,
        { workspace, name: params.name, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsDeleteResultSchema,
      );
    },

    // runs 列表：name 可省略表示「该 workspace 全部工作流的运行」，
    // 因此用条件展开而不是传 undefined（严格 schema 会拒绝 undefined 字段）。
    async listSavedWorkflowRuns(params: ZCodeAgentListSavedWorkflowRunsParams) {
// 运行记录同样按载体读取：run journal 与 workflow 文件必须来自同一侧。
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
// limit 始终下发，name 与 scope 才按是否缺省做条件展开。
      return client.request(
        zcodeProtocolMethods.workflowsRuns,
        {
          workspace,
          ...(params.name === undefined ? {} : { name: params.name }),
          limit: params.limit,
          ...savedWorkflowScopeParam(params),
        },
        zcodeWorkflowsRunsResultSchema,
      );
    },

    // move 是单向（全局 → 项目）：workspace 必带，既是载体又是目标项目，
    // 协议处理器据它算项目根；因此直通 getReadOnlyClient，不经全局载体选择。
    // 把全局档搬回项目档（只此一向）：
    // `workspace` 必带，既是载体又是目标项目（协议处理器据它算项目根），因此走
    // getReadOnlyClient(params) 直通，不经全局载体选择。
    // 不走 resolveSavedWorkflowCarrier：全局档的「载体」与「落点」在这里必须一致，
    // 自选载体可能把文件搬到错误项目。
    async moveSavedWorkflow(params: ZCodeAgentMoveSavedWorkflowParams) {
// 搬运方向固定为全局到项目，因此必须直连目标 workspace，不能自选全局载体。
      const client = await getReadOnlyClient(params);
// workspace 同时充当载体与落点，协议处理器据此推导项目根。
      return client.request(
        zcodeProtocolMethods.workflowsMove,
        { workspace: buildWorkspaceRef(params), name: params.name },
        zcodeWorkflowsMoveResultSchema,
      );
    },

    // 完成卡「直接保存」必须打到本次 run 所属 workspace 的 agent：脚本从该进程的
    // journal 读取，全局档也一样（落点由 agent 按 scope 计算，与载体无关）。
    // 完成卡的「直接保存」（docs/dynamic-workflow/transcript-and-notifications.md）：必须打到
    // **这次 run 所属 workspace** 的 agent client——脚本从那个进程的 journal 里读，全局档也一样
    // （落点由 agent 按 scope 算，与载体无关）。因此走 getReadOnlyClient 直通，不经全局载体选择。
    async saveSavedWorkflowFromRun(params: ZCodeAgentSaveSavedWorkflowFromRunParams) {
      // scope/overwrite 只在显式给出时下发：缺省语义由 CLI 按 run 元数据推断，
      // Host 传默认值会覆盖用户/服务端的判断。
// 直通 run 所属 workspace：脚本正文由该 agent 从 journal 读取，Host 不参与拼装。
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.workflowsSave,
        {
          workspace: buildWorkspaceRef(params),
          runId: params.runId,
          name: params.name,
          meta: params.meta,
          ...(params.scope === undefined ? {} : { scope: params.scope }),
          ...(params.overwrite === undefined ? {} : { overwrite: params.overwrite }),
        },
        zcodeWorkflowsSaveResultSchema,
      );
    },

    // findForRun 用 candidates 做「哪个已保存工作流对应这次 run」的匹配：
    // 候选集合由调用方提供，Host 不做本地匹配，避免与 CLI 的文件视图不一致。
    async findSavedWorkflowForRun(params: ZCodeAgentFindSavedWorkflowForRunParams) {
// 只读匹配：run 与 workflow 的对应关系由 CLI 按 candidates 判定，Host 不缓存结论。
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.workflowsForRun,
        {
          workspace: buildWorkspaceRef(params),
          runId: params.runId,
          // candidates 展开成新数组：调用方可能传 Set 或只读数组，协议层需要普通数组。
          ...(params.candidates === undefined ? {} : { candidates: [...params.candidates] }),
        },
        zcodeWorkflowsForRunResultSchema,
      );
    },

    // 推荐插件引用解析走 plugin management 进程：它需要市场 catalog，
    // 与 workspace 会话无关；因此用 5 分钟市场 I/O 超时。
    async resolveSuggestedPluginReference(params: ZCodeAgentResolveSuggestedPluginReferenceParams) {
// 解析依赖市场 catalog，必须走持有该缓存的插件管理进程。
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsResolveSuggestedReference,
        {
          workspace: buildWorkspaceRef(params),
          stableId: params.stableId,
          operationId: params.operationId,
          clientMode: params.clientMode,
          deliveryKind: params.deliveryKind,
        },
        zcodePluginsResolveSuggestedReferenceResultSchema,
        // operationId 让同一次安装/解析可被取消与去重；clientMode/deliveryKind
        // 决定返回引用的形态，Host 不参与裁剪。
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    // 进度事件按 operationId 建 emitter：安装是长任务，UI 用 operationId 订阅并
    // 在结束时 dispose；service dispose 时统一释放（见 disposeLocalState）。
    onDynamicPluginOperationProgress(operationId: string) {
      return getPluginOperationProgressEmitter(operationId).event;
    },

    // [资源] 子进程收集只观察已托管 runtime，且跳过 disposed 与仍在 storageStartup 的 client：
    // 前者会抛错，后者尚未完成进程树登记，过早查询会得到不完整结果。
    async collectLocalRuntimeChildProcesses(signal?: AbortSignal) {
      const managed = [processManager, pluginProcessManager, mcpStatusProcessManager]
        .flatMap((manager) => manager.listManagedProcesses())
        // 三个 manager 合并：chat、plugin、mcp-status 各自持有独立进程树，
        // 漏掉任一个都会让「退出应用时清理子进程」漏杀。
        .filter(
          (runtime) => !runtime.client.isDisposed && !runtime.client.storageStartup.isWaiting,
        );
      return Promise.all(
        managed.map(async (runtime) => {
          let children: ZCodeProcessChildProcess[] = [];
          try {
            // 专用超时（800ms）与 lifecycle:"observation"：子进程枚举是诊断路径，
            // 不能让一个卡住的 CLI 拖慢整个退出流程；observation 表示不触发 idle 续期。
            const result = await runtime.client.request(
              zcodeProtocolMethods.processChildProcesses,
              {},
              zcodeProcessChildProcessesResultSchema,
              // signal 透传 AbortSignal：调用方（退出流程）可整体取消，
              // 避免超时后仍在等待 IPC。
              { timeoutMs: CHILD_PROCESSES_REQUEST_TIMEOUT_MS, lifecycle: "observation", signal },
            );
            children = result.processes;
          // [失败路径] 单个 runtime 查询失败按空 children 处理：旧 CLI 不认识该方法，
          // 或 runtime 正忙。这样「该 Agent 的后代」全部归 cli，不影响其它 runtime 的结果。
          } catch {
            // 旧 CLI 不认识该方法或 runtime 正忙：本轮该 Agent 的后代全部归 cli，不影响其它 runtime。
          }
          return {
            pid: runtime.pid,
            provider: ZCODE_AGENT_PROVIDER,
            workspacePath: runtime.workspacePath,
            // lane 只在存在时带上：桌面多 lane 场景需要它区分同 workspace 的不同进程，
            // 普通路径不带该字段。
            ...(runtime.lane ? { lane: runtime.lane } : {}),
            children,
          };
        }),
      );
    },

    // 以下插件管理方法全部走 getPluginManagementClient 且统一 5 分钟超时：
    // 市场/安装 I/O 可能很慢，默认协议超时会在正常安装中途误杀。
    async getPluginsOverview(params: ZCodeAgentPluginViewParams) {
      const client = await getPluginManagementClient();
      return client.request(
        // overview 返回聚合视图（marketplace + 已安装 + 更新）：Host 只转发，
        // 不缓存，避免设置页与 CLI 的安装状态分叉。
        zcodeProtocolMethods.pluginsOverview,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.configScope ? { configScope: params.configScope } : {}),
        },
        zcodePluginsOverviewResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    // addMarketplace 支持 dryRun：UI 用它预览源是否可用，真正添加必须显式 dryRun=false；
    // operationId 让同一次操作可被 cancelPluginOperation 取消。
    async addPluginMarketplace(params: ZCodeAgentAddPluginMarketplaceParams) {
// 添加源会写市场配置并可能 clone，必须走管理进程的 5 分钟超时。
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsMarketplaceAdd,
        {
          workspace: buildWorkspaceRef(params),
          source: params.source,
          // dryRun 用 !== undefined 判断：false 是有意义的显式值（真正执行），
          // 不能与缺省混为一谈。
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
          ...(params.operationId ? { operationId: params.operationId } : {}),
        },
        zcodePluginsMarketplaceMutationResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    // removeMarketplace 只按 marketplace 标识删除：不传 source，避免 Host 猜测
    // 用户指的是哪一个同名源。
    async removePluginMarketplace(params: ZCodeAgentRemovePluginMarketplaceParams) {
// 删除源会改插件目录，走独立管理进程而不是 workspace agent。
      const client = await getPluginManagementClient();
// 只上送 marketplace 标识，不附带 source，避免同名源被误删。
      return client.request(
        zcodeProtocolMethods.pluginsMarketplaceRemove,
        {
          workspace: buildWorkspaceRef(params),
          marketplace: params.marketplace,
        },
        zcodePluginsMarketplaceMutationResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    // updateMarketplace 的 marketplace 可省略：CLI 据此刷新全部已配置源；
    // marketplace 显式给出时只刷新该源，缺省则刷新全部已配置源。
    async updatePluginMarketplace(params: ZCodeAgentUpdatePluginMarketplaceParams) {
// 刷新源是网络 I/O，复用插件管理进程的 5 分钟超时。
      const client = await getPluginManagementClient();
// marketplace 缺省表示刷新全部源；显式值才限定单个源。
      return client.request(
        zcodeProtocolMethods.pluginsMarketplaceUpdate,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
          ...(params.operationId ? { operationId: params.operationId } : {}),
        },
        zcodePluginsMarketplaceMutationResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    // install 的 scope 决定装到项目还是用户级：省略时由 CLI 按当前 workspace 推断，
    // Host 不替用户做默认选择（远程 workspace 的默认作用域不同）。
    async installPlugin(params: ZCodeAgentInstallPluginParams) {
// 安装可能拉取远端市场，必须走专用管理进程，不能占用会话进程。
      const client = await getPluginManagementClient();
// 结果 schema 与 update 共用：两者在 CLI 侧是同一条安装流水线。
      return client.request(
        zcodeProtocolMethods.pluginsInstall,
        {
          workspace: buildWorkspaceRef(params),
          pluginName: params.pluginName,
          marketplace: params.marketplace,
// scope 缺省由 CLI 按当前 workspace 推断，远程与本地默认作用域不同。
          ...(params.scope ? { scope: params.scope } : {}),
// dryRun=false 是显式执行意图，不能和缺省混为一谈，因此用 !== undefined 判断。
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
          ...(params.operationId ? { operationId: params.operationId } : {}),
        },
        zcodePluginsInstallResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    // cancel 是唯一使用 5 秒短超时的方法：取消请求本身必须快速返回，
    // 若也等 5 分钟，UI 会卡在「正在取消」而无法重试。
    async cancelPluginOperation(params: ZCodeAgentCancelPluginOperationParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsCancelOperation,
        // 只要 operationId：取消对象由 CLI 的 operation 表定位，
        // 不需要 workspace/marketplace 等上下文。
        { operationId: params.operationId },
        zcodePluginsCancelOperationResultSchema,
        { timeoutMs: PLUGIN_OPERATION_CANCEL_REQUEST_TIMEOUT_MS },
      );
    },

    // uninstall 允许按 pluginId 或 pluginName+marketplace 定位：调用方可能只有显示名；
    // removeCache 控制是否连同缓存删除，缺省不删以便回滚。
    async uninstallPlugin(params: ZCodeAgentUninstallPluginParams) {
// 卸载同样在管理进程执行，避免影响正在使用插件的会话。
      const client = await getPluginManagementClient();
// 三种定位字段都按存在性展开，调用方可以只给显示名。
      return client.request(
        zcodeProtocolMethods.pluginsUninstall,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.pluginId ? { pluginId: params.pluginId } : {}),
          ...(params.pluginName ? { pluginName: params.pluginName } : {}),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
// removeCache 缺省保持缓存，便于用户回滚到已卸载版本。
          ...(params.removeCache !== undefined ? { removeCache: params.removeCache } : {}),
        },
        zcodePluginsUninstallResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    // update 只按 pluginId/marketplace 定位并复用 install 的结果 schema：
    // 更新在 CLI 侧就是「重新安装到同一位置」，Host 不做额外区分。
    async updatePlugin(params: ZCodeAgentUpdatePluginParams) {
// 更新在 CLI 侧等价于「重新安装到同一位置」，因此复用管理进程。
      const client = await getPluginManagementClient();
// 只按 id 或 marketplace 定位，不额外传目标版本，版本选择交给 CLI。
      return client.request(
        zcodeProtocolMethods.pluginsUpdate,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.pluginId ? { pluginId: params.pluginId } : {}),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
        },
        zcodePluginsInstallResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    // restoreBuiltin 只对内置插件有意义：CLI 校验 pluginId 是否属于内置集合，
    // Host 不预判，避免内置清单版本差导致误拒。
    async restoreBuiltinPlugin(params: ZCodeAgentRestoreBuiltinPluginParams) {
// 恢复内置插件要重写插件目录，走管理进程与安装路径一致。
      const client = await getPluginManagementClient();
// 只传 pluginId：是否为内置由 CLI 校验，Host 不预判内置清单版本。
      return client.request(
        zcodeProtocolMethods.pluginsRestoreBuiltin,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
        },
        zcodePluginsRestoreBuiltinResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    // configure 的 clearOptionKeys 只在非空时下发：空数组与「不清理」在语义上
    // 相同，但严格 schema 可能把空数组当成显式清空全部。
    // scope/dryRun 同样按显式值展开：缺省表示沿用现有配置作用域，
    // Host 不替换成默认 scope，避免把项目级配置写回用户级。
    async configurePlugin(params: ZCodeAgentConfigurePluginParams) {
// 配置写操作走管理进程，避免与项目会话的 provider 生命周期耦合。
      const client = await getPluginManagementClient();
// options 原样透传；是否合法由插件自身的配置 schema 在 CLI 侧判定。
      return client.request(
        zcodeProtocolMethods.pluginsConfigure,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
          options: params.options,
// 空数组不下发：省略表示不清理，传空数组可能被严格 schema 当成显式清空。
          ...(params.clearOptionKeys?.length ? { clearOptionKeys: params.clearOptionKeys } : {}),
          ...(params.scope ? { scope: params.scope } : {}),
          ...(params.dryRun !== undefined ? { dryRun: params.dryRun } : {}),
        },
        zcodePluginsConfigureResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    // 插件管理走独立控制面 runtime：getPluginManagementClient 用 pluginProcessManager 启动一个
    // 合成 workspace 的 CLI，不复用也不污染项目 chat client；插件事实源仍在 CLI，host 不缓存。
    // [权衡] 若复用当前 workspace 的 client，插件安装/市场 I/O 会与项目进程生命周期绑定：
    // 项目 runtime 被 watchdog 回收或 restartWorkspaceProcess 失效化时，写操作会在中途丢失。
    // 超时放宽到 5 分钟只覆盖「市场/git 网络 I/O」，协议层超时仍会清 pending 并抛错（INV-05）。
    // INV-06：本方法存在不代表所有 channel 可用，远端/移动 attachment 是否暴露由 allowlist 决定。
    async resetPluginConfig(params: ZCodeAgentResetPluginConfigParams) {
      const client = await getPluginManagementClient();
      // workspace 仍取自调用方真实项目：插件作用域/配置落盘要按目标项目解析，
      // 但执行载体是控制面进程——两者分离是本方法的核心约定。
      return client.request(
        zcodeProtocolMethods.pluginsResetConfig,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
          ...(params.scope ? { scope: params.scope } : {}),
        },
        zcodePluginsConfigureResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    // validate 只做「给定 pluginName/marketplace/source 是否可解析」的只读探测，不落配置；
    // 因此三个可选字段允许任意组合，未提供的键直接省略而不是传 undefined，
    // 避免旧 CLI 把显式 undefined 当作「覆盖为空」。
    async validatePlugin(params: ZCodeAgentValidatePluginParams) {
// 只读探测也要走管理进程：解析可能需要拉市场清单，工作区进程没有这份缓存。
      const client = await getPluginManagementClient();
// 结果只含可否解析与原因，Host 不据此写任何安装状态。
      // 与 reset 同一 5 分钟边界：validate 可能触发市场清单拉取，属于网络 I/O。
      return client.request(
        zcodeProtocolMethods.pluginsValidate,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.pluginName ? { pluginName: params.pluginName } : {}),
          ...(params.marketplace ? { marketplace: params.marketplace } : {}),
          ...(params.source ? { source: params.source } : {}),
        },
        zcodePluginsValidateResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    // describe 用「已知 marketplace + pluginName」拉元数据：只读且幂等，可安全重试；
    // 两个字段都必填，避免拿 pluginId 去猜市场，造成跨市场同名插件误配。
    async describePlugin(params: ZCodeAgentDescribePluginParams) {
// 元数据来自市场 catalog，必须用持有市场缓存的插件管理进程。
      const client = await getPluginManagementClient();
// marketplace 与 pluginName 都必填，避免用 pluginId 跨市场猜同名插件。
      return client.request(
        zcodeProtocolMethods.pluginsDescribe,
        {
          workspace: buildWorkspaceRef(params),
          marketplace: params.marketplace,
          pluginName: params.pluginName,
        },
        zcodePluginsDescribeResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    // setEnabled 是写操作：operationId 由上层生成并透传，CLI 用它做幂等去重，
    // 重试同一 operationId 不会重复改写插件目录；缺省时 CLI 退化为单次执行。
    // scope 决定写 user 还是 project 级配置，省略时由 CLI 用自身默认；
    // host 不在此处补默认值，否则会把远端显式传入的空 scope 覆盖掉。
    // [失败路径] 5 分钟超时后协议层 reject，但 CLI 侧可能已落盘一部分；
    // 上层应以同一 operationId 重试并重新拉列表，而不是假设状态未变（INV-05）。
    async setPluginEnabled(params: ZCodeAgentSetPluginEnabledParams) {
// 启停会改写插件目录与配置，属于控制面写操作，走管理进程。
      const client = await getPluginManagementClient();
// operationId 原样下传，由 CLI 做幂等去重；Host 不维护已执行 operation 表。
      return client.request(
        zcodeProtocolMethods.pluginsSetEnabled,
        {
          workspace: buildWorkspaceRef(params),
          pluginId: params.pluginId,
          enabled: params.enabled,
          ...(params.operationId ? { operationId: params.operationId } : {}),
// scope 缺省不补默认值：远端显式传入的空 scope 必须保持为空。
          ...(params.scope ? { scope: params.scope } : {}),
        },
        zcodePluginsSetEnabledResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    // automation 是 Host 本地域：cron 计算、next_run_at 与 run 记录都落在 tasks-index.sqlite，
    // 不经过 CLI。这样定时任务在 CLI 未启动时也能被列出与编辑。
    // [权衡] 若把 automation 交给 CLI 持有，进程换代会让调度窗口丢失，手机远控也看不到桌面计划。
    // 传入 workspace 时按 workspace 过滤，过滤口径是 task-index 的 identity key（INV-02/INV-10）。
    async listAutomations(params: ZCodeAgentWorkspaceTarget) {
      return automationService.list(params);
    },

    // 无参重载用于「跨 workspace 汇总」视图；不传 scope 意味着不做归属过滤，
    // 只允许本机管理面调用，远端 attachment 不应通过 allowlist 暴露该方法（INV-06）。
    async listAllAutomations() {
      return automationService.list();
    },

    // create 只做字段搬运：cron 合法性、relativeDelayMinutes 与 recurring/maxRuns 的互斥都在领域层校验，
    // host 不重复校验，避免两处规则漂移；recurring 缺省 true（UI 默认形态是周期任务）。
    // [权衡] mode 从 string 直接收窄为 ZCodeTaskMode，不做枚举校验：这是传输边界，
    // 非法值会原样落库，由旧 task 面按未知 mode 处理；补校验会与 CLI 的 mode 集合产生第二份真相。
    // projectId 存在时领域层要求 prepareProjectExecution，拿不到项目快照就拒绝创建，
    // 防止写入没有 workspace/identity 的孤儿计划。
    async createAutomation(params: ZCodeAgentCreateAutomationParams) {
// 委托 Host 本地的 automationService：cron 解析、next_run_at 与 run 记录都在本机库。
// 本方法只做字段搬运与类型收窄，不做合法性校验，避免与领域层形成两份规则。
// recurring 在这里补 true 是唯一的默认值，其余字段全部原样下传。
      return automationService.create({
        projectId: params.projectId,
        title: params.title,
        cronExpr: params.cronExpr,
        relativeDelayMinutes: params.relativeDelayMinutes,
        prompt: params.prompt,
        modelSelection: params.modelSelection,
        mode: params.mode as ZCodeTaskMode | undefined,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        recurring: params.recurring ?? true,
        maxRuns: params.maxRuns,
        endAt: params.endAt,
        scheduleRule: params.scheduleRule,
      });
    },

    // update 用「undefined 表示不改」；mode/scheduleRule/maxRuns/endAt/modelSelection 另有
    // 显式 null 表示清空，因此必须保留 null 与 undefined 的区别。
    // [失败路径] 把 null 折成 undefined 会让「取消结束时间」变成静默无操作（INV-09 的同型错误）。
    // 第三个参数是归属校验 scope：写操作限定在调用方当前 workspace，禁止跨 workspace 改别人的计划。
    // scheduleEditedByUser 透传给领域层，用于区分「用户改期」与「系统重算」，影响后续重算策略。
    async updateAutomation(params: ZCodeAgentUpdateAutomationParams) {
// 直接委托本地 service 的 update；门面只负责把 null 与 undefined 的差异原样保留。
// recurring/maxRuns/endAt 等字段不在这里补默认值，缺省语义完全由领域层解释。
      return automationService.update(
        params.automationId,
        {
          title: params.title,
          cronExpr: params.cronExpr,
          prompt: params.prompt,
          modelSelection: params.modelSelection,
          mode: params.mode === null ? null : (params.mode as ZCodeTaskMode | undefined),
          recurring: params.recurring,
          maxRuns: params.maxRuns,
          endAt: params.endAt,
          scheduleRule: params.scheduleRule,
          scheduleEditedByUser: params.scheduleEditedByUser,
        },
        // 归属校验：写操作必须限定在调用方当前 workspace，禁止跨 workspace 越权。
// 第二个参数是归属 scope，不是查询条件：跨 workspace 的写会被领域层拒绝。
        {
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        },
      );
    },

    // 删除同样带 scope：automationId 只是库内主键，不能单独作为授权凭据；
    // 归属不符时领域层返回「未找到」，不泄露该 id 是否存在于其他 workspace。
    // 不返回被删对象，避免调用方把「返回值存在」当成删除成功的第二判据。
    async deleteAutomation(params: ZCodeAgentAutomationIdParams) {
// 返回值直接丢弃：delete 的「未找到」由领域层抛错，Host 不需要再翻译。
      await automationService.delete(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    // 启停是生命周期写操作：领域层会重算 next_run_at，避免停用期间积压的窗口
    // 在重新启用的瞬间被批量补跑。host 只转发 enabled，不自己推算时间。
    async setAutomationEnabled(params: ZCodeAgentSetAutomationEnabledParams) {
// enabled 原样下传；门面不读取旧状态，也不自己决定是否需要重算时间。
      return automationService.setEnabled(params.automationId, params.enabled, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    // restart 语义是「从当前时刻重新起算」，用于用户改系统时间或修好 provider 后手动纠偏；
    // 它与 setEnabled(true) 的差别在 next_run_at 的锚点，二者不能互相替代。
    async restartAutomation(params: ZCodeAgentAutomationIdParams) {
// 返回重算后的 automation 快照，next_run_at 由领域层写库并回填。
      return automationService.restart(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    // 手动立即运行分两段：先在 repo 侧抢占 single-flight claim，再把 claim 交给注入的
    // dispatcher 真正派发；抢占与派发分离，保证并发点击只产生一个 run。
    // [失败路径] 抢占在派发之前完成，因此派发阶段失败只会让这次 run 停在已认领状态，
    // 由 stale 回收接手；反过来先派发后认领则会派发两次。
    // 返回 duplicate 而不是空对象：UI 靠它区分「这次点击没触发」与「已入队」。
    async runAutomationNow(params: ZCodeAgentAutomationIdParams) {
      const dispatch = options?.onAutomationManualRunRequested;
      if (!dispatch) {
        // runNow 会先写 manual run 并占用 single-flight claim；dispatcher
        // 缺失是同步可判定的配置错误，必须在认领前失败，不能依赖 stale 崩溃回收。
        throw new Error("Automation immediate dispatcher is unavailable.");
      }
      const claimed = await automationService.runNow(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      if (!claimed) {
        // single-flight 已拒绝重复运行时，旧的空成功返回会被 UI 误判为
        // 新 run 已入队，导致每次重复点击都展示一次“已触发”。
        return { status: "duplicate" as const };
      }
      await dispatch(claimed);
      return { status: "queued" as const };
    },

    // run 历史按 automationId 读，但仍要带 scope 做归属校验；
    // run 与 automation 同库，跨 workspace 读取会被领域层拒绝。
    async listAutomationRuns(params: ZCodeAgentAutomationIdParams) {
// 返回 run 数组本身，不做分页或状态过滤；筛选交由调用方处理。
      return automationService.listRuns(params.automationId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    // 删除单次 run 不改 automation 的 next_run_at / lifecycle，只影响历史列表；
    // 若实现里顺手重算生命周期，「清理历史」就会意外推迟下一次触发。
    async deleteAutomationRun(params: ZCodeAgentDeleteAutomationRunParams) {
// runId 与 scope 一起下传：仅凭 runId 无法判断这行历史属于哪个 workspace。
      return automationService.deleteRun(params.runId, {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
    },

    // 一次性文本生成（改写/摘要类 UI 动作）：不创建 session，因此不走 conversation 通道，
    // 但仍要经过 provider 就绪与账号 overlay 屏障，否则新进程会按旧套餐状态建 Model。
    // 可取消：params.signal 存在时为本次调用生成 operationId，abort 时向 CLI 发 cancel，
    // 避免用户切走后服务端继续消耗 token。
    // [资源] operationId 只在闭包里存活，取消监听在 finally 中移除；
    // 漏掉 removeEventListener 会在长生命周期 signal 上累积监听器（INV-11 同型泄漏）。
    async generateWorkspaceText(params: ZCodeAgentGenerateWorkspaceTextParams) {
      const client = await getClient(params);
      // Worker 自己读取 ZCode Built-in / Personal Config；Host 只在执行前确保账号状态形成的
      // Account Config Overlay 已同步，避免新进程先按旧套餐状态创建 Model。
      // 只建立「账号配置已同步」的顺序屏障，不触碰用户自己的 provider 配置；
      // refreshRegistry=true 让 CLI 重新加载 Registry 后再解析模型。
      await ensureAccountProviderConfigSynced({
        client,
        reason: "workspace_generate_text",
        workspace: params,
        refreshRegistry: true,
      });
      // 没有 signal 就不生成 operationId：无取消句柄时传 id 只会让 CLI 维护一份
      // 无人认领的取消表，属于纯噪声。
      const operationId = params.signal ? randomUUID() : undefined;
      // 取消是 best-effort：本地 abort 已让调用方返回，远端 cancel 只用于尽快止损。
      const cancel = () => {
// 没有 operationId 说明调用方没提供 signal，此时也没有远端操作可取消。
        if (!operationId) return;
        void client
          .request(
            zcodeProtocolMethods.workspaceCancelGenerateText,
            { operationId },
            zcodeWorkspaceCancelGenerateTextResultSchema,
            { timeoutMs: 5_000 },
          )
          .catch((error: unknown) => {
            // 取消是 best-effort 控制面操作，失败不能覆盖调用方原本的 AbortError；
            // 保留 debug 轨迹用于区分“本地停止等待”和“CLI 已收到取消”。
            logger.debug(undefined, "workspace 模型请求取消通知失败", {
              operationId,
              workspaceKey: resolveWorkspaceKey(params),
              error: error instanceof Error ? error.message : String(error),
            });
          });
      };
      // once:true 保证重复 abort 只发一次 cancel；signal 可能长期存活（组件级 controller），
      // 因此仍在 finally 里显式 remove，不依赖 once 的隐式清理。
      params.signal?.addEventListener("abort", cancel, { once: true });
      try {
      // 透传 signal 让协议层在 abort 时立刻 reject 并清 pending；
      // 只发 cancel 不传 signal，本地 Promise 会挂到超时才结束。
        return await client.request(
          zcodeProtocolMethods.workspaceGenerateText,
          {
            workspace: buildWorkspaceRef(params),
            selection: params.selection,
            ...(params.prompt ? { prompt: params.prompt } : {}),
            ...(params.messages ? { messages: params.messages } : {}),
            ...(params.tools ? { tools: params.tools } : {}),
            querySource: params.querySource,
            ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
            ...(operationId ? { operationId } : {}),
          },
          zcodeWorkspaceGenerateTextResultSchema,
          // 不传 timeoutMs 时协议 client 默认 3 分钟超时会对 thinking 模型的长请求
          // 先于调用方自身 deadline 触发，并被 onRequestTimeout 误判 stale 杀进程。
          // 调用方显式传入 requestTimeoutMs（自身 deadline + 取消缓冲）时以其为准。
          {
            signal: params.signal,
            ...(params.requestTimeoutMs ? { timeoutMs: params.requestTimeoutMs } : {}),
          },
        );
      // [资源] 无论成功、失败还是 abort，都必须摘掉监听器；
      // 泄漏的监听器持有 client 与 operationId，会让已结束的调用长期驻留。
      } finally {
        params.signal?.removeEventListener("abort", cancel);
      }
    },

    // 连通性测试是纯探测：不写会话、不落模型选择，但必须先同步账号 overlay，
    // 否则会拿旧凭据测出一个「成功」结果，误导用户。
    // 不传 timeoutMs，走协议默认上限；探测本身在 CLI 侧发起，host 不再叠加 deadline。
    async testModelConnectivity(params: ZCodeAgentTestModelConnectivityParams) {
// 测试要真实发请求，必须用可推进执行态的 getClient，而不是只读句柄。
      const client = await getClient(params);
// 先同步账号 overlay 再测：否则可能用旧套餐凭据测出假成功。
      await ensureAccountProviderConfigSynced({
        client,
        reason: "provider_test_model_connectivity",
        workspace: params,
        refreshRegistry: true,
      });
// 探测请求只带 selection，不写回模型选择；结果关闭后由 UI 展示，不落库。
      return client.request(
        zcodeProtocolMethods.providerTestModelConnectivity,
        {
          workspace: buildWorkspaceRef(params),
          selection: params.selection,
        },
        zcodeProviderTestModelConnectivityResultSchema,
        { signal: params.signal },
      );
    },

    // 会话 prompt 入口（不带 V4 envelope 的直连路径）：最终翻译成 session/send。
    // 没有 commandId，重试身份完全依赖调用方传入的 inputId。
    // [事务] 一次 send 的可见终态来自快照/事件流，返回值只是 ACK，不能据此判断 turn 已结束。
    async sendPrompt(params: ZCodeAgentSendPromptParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      await ensureAccountProviderConfigSynced({
        client,
        reason: "session_send",
        workspace: params,
        refreshRegistry: true,
      });
      // trace 优先用调用方传的，其次按 (workspace, session) 生成的稳定值，
      // 再退到 inputId，保证同一输入的 开始/ACK/失败 三条日志能串起来。
      const sessionTraceId = params.sessionTraceId?.trim() || getSessionTraceId(params);
      const logTraceId = sessionTraceId ?? params.inputId;
      // 浏览器上下文是「读当前可见页面」的旁路信息，收集失败返回 undefined，
      // 绝不阻断 prompt；远端/手机链路不下发桌面浏览器事实（clientMode 参与判定）。
      const browserAmbientContext =
        params.browserAmbientContext ??
        (await collectBrowserAmbientContext(options?.browserControlExecutor, {
          sessionId: params.sessionId,
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          ...(params.clientMode ? { clientMode: params.clientMode } : {}),
        }));
      // 只有真正拿到上下文才写这个键：显式 undefined 会被旧 CLI 当成清空既有上下文。
      const protocolParams: ZCodeAgentSendPromptParams = {
        ...params,
        ...(browserAmbientContext ? { browserAmbientContext } : {}),
      };
      // 开始日志只记长度与计数，不记 prompt 正文，避免把用户内容写进生产日志。
      logger.info(logTraceId, "ZCode Agent session/send 开始", {
        attachmentCount: params.attachments?.length ?? 0,
        hasBrowserAmbientContext: browserAmbientContext !== undefined,
        inputId: params.inputId,
        queryId: params.queryId ?? null,
        sessionId: params.sessionId,
        sessionTraceId: sessionTraceId ?? null,
        textLength: params.content.length,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
// send 的返回只是 ACK：真正的模型输出走 timeline 事件，不要在这里等待终态。
        const result = await client.request(
          zcodeProtocolMethods.sessionSend,
          buildSessionSendParams(protocolParams),
          zcodeSessionSendResultSchema,
        );
        logger.info(logTraceId, "ZCode Agent session/send ACK", {
          durationMs: Date.now() - startedAt,
          inputId: params.inputId,
          queryId: params.queryId ?? null,
          sessionId: params.sessionId,
          sessionTraceId: sessionTraceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return result;
      // 兼容重试只针对「旧 CLI 不认识新字段」这一类错误：由 getSessionSendCompatFields
      // 按稳定字段名解析，不看 message 文本（INV-05）。
      } catch (error) {
        const compatFields = getSessionSendCompatFields(error);
        if (compatFields.length > 0) {
          logger.warn(logTraceId, "ZCode Agent session/send 命中新旧协议兼容重试", {
            compatFields,
            durationMs: Date.now() - startedAt,
            sessionId: params.sessionId,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
        // 第二次请求必须带上要省略的字段集合，否则会原样再失败一次；
        // 这里不再兜底第三次——重试次数与字段集合都由兼容层决定。
          const result = await client.request(
            zcodeProtocolMethods.sessionSend,
            buildSessionSendParams(protocolParams, new Set(compatFields)),
            zcodeSessionSendResultSchema,
          );
          return result;
        }
        // 非兼容类错误统一 warn 后原样抛出：由上层决定是否展示重试入口，
        // 不在此处吞掉，避免 UI 以为消息已发送。
        logger.warn(logTraceId, "ZCode Agent session/send 失败", {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          inputId: params.inputId,
          queryId: params.queryId ?? null,
          sessionId: params.sessionId,
          sessionTraceId: sessionTraceId ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    // compact 是会话级维护动作：ACK 只表示 CLI 已受理，压缩产出的新 timeline
    // 仍通过事件/快照推送，调用方不能把返回值当作压缩后的权威状态（INV-01）。
    // 单独放宽超时到 5 分钟，因为模型摘要可能跨分钟；超时只终止等待，不取消 CLI 侧工作。
    async compactSession(params: ZCodeAgentCompactParams) {
      const startedAt = Date.now();
      const client = await getClient(params);
      const sessionTraceId = getSessionTraceId(params);
      logger.info(sessionTraceId ?? params.inputId, "ZCode Protocol session/compact 开始", {
        inputId: params.inputId,
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
// compact 是带 revision 期望的写命令；为它单独放宽 ACK 超时，不影响其它方法。
        const result = await client.request(
          zcodeProtocolMethods.sessionCompact,
          buildSessionCompactParams(params),
          zcodeSessionCompactResultSchema,
          {
            // compact 的模型维护态可能进入分钟级窗口；这里放宽的是 ACK 边界，
            // 终态仍由 session timeline / snapshot 推送，不能把它当作同步 compact 结果。
            // [权衡] 这个放宽只属于 compact；若也用于 session/send，会把协议队列死锁
            // 伪装成「还在压缩」，问题被超时掩盖。
            timeoutMs: SESSION_COMPACT_REQUEST_TIMEOUT_MS,
          },
        );
// ACK 只说明压缩已受理，压缩产物仍由 timeline 推送，调用方不能据此认为上下文已更新。
        logger.info(sessionTraceId ?? params.inputId, "ZCode Protocol session/compact ACK", {
          durationMs: Date.now() - startedAt,
          inputId: params.inputId,
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return result;
      } catch (error) {
        logger.warn(sessionTraceId ?? params.inputId, "ZCode Protocol session/compact 失败", {
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          inputId: params.inputId,
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    // goal 是带 revision 期望的写命令：expectedRevision 不匹配时 CLI 返回冲突，
    // host 不做本地重试，避免把用户的并发操作静默合并。
    // response/startedTurn 是可选的：纯状态查询不会产生新的 turn。
    async goalSession(params: ZCodeAgentGoalParams) {
// 计时只服务日志，不参与协议语义；startedAt 与 inputId 一起构成一次 goal 调用的链路标识。
      const startedAt = Date.now();
// goal 会改会话目标并可能开新一轮，因此用可执行 client。
      const client = await getClient(params);
// 开始日志只记 action 与 objective 是否非空，不记录目标正文。
      logger.info(params.inputId, "开始请求 ZCode Protocol session/goal", {
        action: params.action,
        hasObjective: Boolean(params.objective?.trim()),
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
// 五字段白名单上送：workspace 等 Host 侧上下文不进入 goal 请求体。
        const result = await client.request(
          zcodeProtocolMethods.sessionGoal,
          {
            sessionId: params.sessionId,
            inputId: params.inputId,
            action: params.action,
            objective: params.objective,
            expectedRevision: params.expectedRevision,
          },
          zcodeSessionGoalResultSchema,
        );
// 完成日志用快照统计消息数与回复长度，正文同样不落日志。
        logger.info(params.inputId, "ZCode Protocol session/goal 完成", {
          action: params.action,
          durationMs: Date.now() - startedAt,
          messageCount: result.snapshot.messages.length,
          responseLength: result.response?.length ?? 0,
          sessionId: params.sessionId,
          startedTurn: result.startedTurn,
          status: result.snapshot.session.status,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
// 返回完整 result（含 snapshot 与 startedTurn），由调用方决定如何合并状态。
        return result;
      } catch (error) {
// 失败只记 message 与耗时，不在此处降级或重试，重试策略属于上层。
        logger.warn(params.inputId, "ZCode Protocol session/goal 失败", {
          action: params.action,
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
// 原样抛出：goal 失败必须让 UI 看到，不能退化成「操作成功但无变化」。
        throw error;
      }
    },

    // close 的 expectedPersistence 表示调用方期望的落盘时机；不传则由 CLI 用自身默认。
    // 返回值 closed ?? true 是对旧 CLI 的兼容：没有该字段说明它只实现了普通 close，
    // 此时按成功处理，不能因缺字段把已关闭的会话判成失败并触发重复关闭。
    async closeSession(
      params: ZCodeAgentSessionTarget & {
        expectedPersistence?: "deferred" | "immediate";
      },
    ): Promise<boolean> {
// close 会结束 runtime，必须用可执行 client；只读 client 可能根本拿不到进程。
      const client = await getClient(params);
// expectedPersistence 按存在性展开，缺省时由 CLI 自行决定延迟还是立即落盘。
      const result = await client.request(
        zcodeProtocolMethods.sessionClose,
        {
          sessionId: params.sessionId,
          ...(params.expectedPersistence
            ? { expectedPersistence: params.expectedPersistence }
            : {}),
        },
        zcodeSessionCloseResultSchema,
      );
      // 兼容尚未返回 closed 字段、但已成功执行普通 close 的 Agent。
      return result.closed ?? true;
    },

    // setModel 返回整份 session 快照而不是增量：模型切换会同时影响 settings 与可用工具，
    // 调用方必须用快照整体替换，不能只 patch model 字段。
    // expectedRevision 用于乐观并发；persistAsWorkspaceLastUsed 决定是否写 workspace 级偏好；
    // 二者都原样透传，host 不缓存「上次使用的模型」这份第二事实源（INV-01）。
    async setModel(params: ZCodeAgentSetModelParams) {
// setModel 会改变后续 turn 的模型，计时只用于日志排障。
      const startedAt = Date.now();
// 模型切换需要可执行 client：部分实现会在切换时重建模型运行时。
      const client = await getClient(params);
// 日志里的模型串统一走 formatModelSelectionForLog，避免各处拼接格式不一。
      logger.info(undefined, "开始请求 ZCode Protocol session/setModel", {
        expectedRevision: params.expectedRevision ?? null,
        persistAsWorkspaceLastUsed: params.persistAsWorkspaceLastUsed ?? null,
        requestedModel: formatModelSelectionForLog(params.model),
        sessionId: params.sessionId,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      try {
// 四个字段全部原样上送：persistAsWorkspaceLastUsed 留空表示不改工作区偏好。
        const snapshot = await client.request(
          zcodeProtocolMethods.sessionSetModel,
          {
            sessionId: params.sessionId,
            model: params.model,
            expectedRevision: params.expectedRevision,
            persistAsWorkspaceLastUsed: params.persistAsWorkspaceLastUsed,
          },
          zcodeSessionStateSnapshotSchema,
        );
// 完成日志对比请求模型与快照模型，便于发现 CLI 侧归一化或回落。
        logger.info(undefined, "ZCode Protocol session/setModel 完成", {
          durationMs: Date.now() - startedAt,
          requestedModel: formatModelSelectionForLog(params.model),
          sessionId: params.sessionId,
          snapshotModel: formatModelSelectionForLog(snapshot.settings.model.current),
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
// 返回整份快照而非增量：模型变化会连带 settings 与工具边界，必须整体替换。
        return snapshot;
      } catch (error) {
// revision 冲突也走这里：门面不吞错、不本地重试，交给 UI 重新加载。
        logger.warn(undefined, "ZCode Protocol session/setModel 失败", {
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
          requestedModel: formatModelSelectionForLog(params.model),
          sessionId: params.sessionId,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        throw error;
      }
    },

    // thoughtLevel 与 model 同属 session settings，同样以快照回传；
    // 不做「无变化就跳过」，因为 CLI 侧 revision 仍可能因其他端修改而推进。
    async setThoughtLevel(params: ZCodeAgentSetThoughtLevelParams) {
// 思考等级属于会话设置，需要可执行 client，但不触发账号同步。
      const client = await getClient(params);
// 与 setModel 同构：只做字段透传 + 快照校验，不做本地的「值未变」短路。
      const snapshot = await client.request(
        zcodeProtocolMethods.sessionSetThoughtLevel,
        {
          sessionId: params.sessionId,
          thoughtLevel: params.thoughtLevel,
          expectedRevision: params.expectedRevision,
          persistAsWorkspaceLastUsed: params.persistAsWorkspaceLastUsed,
        },
        zcodeSessionStateSnapshotSchema,
      );
// 原样返回快照：门面不提取 thoughtLevel 字段，避免产生第二份状态。
      return snapshot;
    },

    // mode 切换影响工具准入（plan/accept-edits 等），只改会话状态，不触碰 workspace 配置；
    // expectedRevision 冲突直接抛给调用方，由 UI 提示重新加载，而不是本地强行覆盖。
    async setMode(params: ZCodeAgentSetModeParams) {
// mode 改动会影响可用工具集合，必须走可执行 client。
      const client = await getClient(params);
// 无日志、无本地校验，纯透传；expectedRevision 的冲突语义由协议层保证。
      return client.request(
        zcodeProtocolMethods.sessionSetMode,
        {
          sessionId: params.sessionId,
          mode: params.mode,
          expectedRevision: params.expectedRevision,
        },
        zcodeSessionStateSnapshotSchema,
      );
    },

    // Host 侧应答 CLI 的 runtime preferences 询问（目录、规则等运行时物化输入）。
    // pending 表按 requestId 索引，应答时先摘除再回包：CLI 只接受一次响应，
    // 二次响应会污染协议流。
    // [失败路径] 找不到 pending 视为协议错误（可能是超时已清理），必须抛出而不是静默 ACK。
    async respondSessionRuntimePreferences(
      params: ZCodeAgentRespondSessionRuntimePreferencesParams,
    ): Promise<void> {
      // take 即删除：命中后该 requestId 不再可应答，重复调用会走上面的 not found 分支。
      const pending = takePendingSessionRuntimePreferences(params.requestId);
      if (!pending) {
        logger.warn(undefined, "运行时偏好响应找不到 pending 请求", {
          event: "zcode_agent.runtime_preferences.response_without_pending",
          module: "services.zcode_agent",
          requestId: params.requestId,
        });
        throw new Error(`ZCode session runtime preferences request not found: ${params.requestId}`);
      }
      // 统一日志上下文：event 名 + requestId + scope + workspaceKey，
      // 便于把 CLI 请求、Host 回包与 session 日志按同一条链路对齐。
      const responseContext = {
        event: "zcode_agent.runtime_preferences.host_response_received",
        module: "services.zcode_agent",
        requestId: params.requestId,
        scope: pending.request.scope,
        sessionId: pending.request.sessionId,
        workspaceKey: pending.workspaceKey,
      };
      // failed 分支也必须应答：只打日志不回包会让 CLI 的询问 Promise 永久悬挂，
      // 直到其自身超时才继续，用户看到的是「工具一直卡住」。
      if (params.resolution.status === "failed") {
        logger.warn(undefined, "Host 返回运行时偏好失败", {
          ...responseContext,
          error: params.resolution.message,
        });
        await pending.client.respondError(pending.protocolRequestId, {
          code: -32603,
          message: params.resolution.message,
        });
        return;
      }
      // 回包内容必须过 schema：远端/渲染层传入的 preferences 是不可信 JSON，
      // 解析失败要转成 JSON-RPC 错误回给 CLI，而不是把脏数据塞进运行时。
      let preferences: ZCodeSessionRuntimePreferencesResult;
      try {
        preferences = zcodeSessionRuntimePreferencesResultSchema.parse(
          params.resolution.preferences,
        );
        // 远端组织态由远端 Host 读取；客户端设置回包不能覆盖本机目录事实。
        // runtime-materialization 场景下目录归属由 Host 决定：客户端回包只能表达「它希望怎样」，
        // 不能覆盖本机目录事实，否则远端可以借回包把 agent 的可读范围扩到本 workspace 之外。
        if (
          pending.request.scope === "runtime-materialization" &&
          options?.resolveSessionDirectories
        ) {
          preferences.additionalDirectories = await options.resolveSessionDirectories({
            ...pending.workspace,
            sessionId: pending.request.sessionId,
          });
        }
        // 解析失败与目录解析失败共用同一出口：都回 -32603 并保留原始 message，
        // 由 CLI 侧决定降级；host 不猜测可用默认值（INV-09）。
      } catch (error) {
        logger.warn(undefined, "Host 返回运行时偏好格式非法", {
          ...responseContext,
          error: error instanceof Error ? error.message : String(error),
        });
        await pending.client.respondError(pending.protocolRequestId, {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      // 发送失败表示 transport 已关闭，不能误判为偏好校验失败并发送第二个响应。
      // 这里不 catch 发送失败：transport 已关闭时说明 CLI/进程已消失，
      // 再补一个 error 响应没有接收方，还会掩盖真实断开原因。
      await pending.client.respond(pending.protocolRequestId, preferences);
      logger.info(undefined, "运行时偏好响应已回传 Agent", responseContext);
    },

    // 取消事件按 workspaceKey 惰性建 emitter：只有真正有人订阅的 workspace 才占内存。
    // emitter 不在这里释放，生命周期由 disposeLocalState 统一收口；
    // [资源] 若在最后一个订阅者 dispose 时删除，随后才 dispose 的调用方会拿到已销毁的 emitter。
    onDynamicWorkspaceProviderRuntimeHeadersCancelled(params: ZCodeAgentWorkspaceTarget) {
// 取消事件只与 workspace 相关，不看 session，key 因此只到 workspace 粒度。
      const key = resolveWorkspaceKey(params);
// emitter 一旦创建就常驻到 disposeLocalState，这里只补建、不回收。
      let emitter = providerRuntimeHeadersCancelledEmitters.get(key);
      if (!emitter) {
        emitter = new Emitter<ZCodeProviderRuntimeHeadersCancelled>();
        providerRuntimeHeadersCancelledEmitters.set(key, emitter);
      }
      return emitter.event;
    },

    // 订阅时先注册 listener，再补投当前所有 pending 请求：
    // 只补投一次会与「请求刚好在注册前入表」竞争，先注册后补投能封住这个窗口。
    // 补投不复制请求，listener 拿到的就是 pending 里的同一对象。
    onDynamicSessionRuntimePreferencesRequest() {
      return (listener) => {
// 先建立 live 订阅，再补投 pending，封住「注册与入表交错」导致漏投的窗口。
        const disposable = sessionRuntimePreferencesRequestEmitter.event(listener);
// 补投使用 pending 里的同一请求对象，不复制、不改写，保证 requestId 对应关系不变。
        for (const pending of pendingSessionRuntimePreferences.values()) {
          listener(pending.request);
        }
// 返回 disposable 而不是 emitter：共享 emitter 的生命周期归 disposeLocalState。
        return disposable;
      };
    },

    // CLI 在发真实模型请求前询问 Host 要注入哪些 header/凭据。
    // 响应必须「恰好一次」：CLI 侧按 requestId 等待，重复响应会打断协议流。
    // responding 是本地闸门，保证同一 pending 不会被 workspace 级与 session 级两个
    // 消费者同时应答（两个入口共享同一个 map，见下面两个 onDynamic*）。
    // [资源] pending 的删除点有三处：headersApplied=false、解析失败、解析成功；
    // 任何分支漏删都会让条目连同 client 引用常驻，直到 client invalidate。
    async respondProviderRuntimeHeaders(
      params: ZCodeAgentRespondProviderRuntimeHeadersParams,
    ): Promise<void> {
      const key = providerRuntimeHeadersRequestKey(params);
      const pending = pendingProviderRuntimeHeaders.get(key);
      if (!pending) {
        throw new Error(`ZCode provider runtime headers request not found: ${params.requestId}`);
      }
      // 第二个消费者到来的典型场景是 workspace 级订阅补投：它不知道另一个入口已在应答。
      // 这里直接抛错而不是等待，让调用方日志能暴露重复消费，而不是静默丢弃。
      if (pending.responding) {
        throw new Error(
          `ZCode provider runtime headers response already pending: ${params.requestId}`,
        );
      }
      // 不能在等待账号 IO 前删除 pending，否则新合入的取消通知找不到请求；
      // 保留身份直到解析完成，同时避免 workspace/session 两个消费者重复应答。
      // [并发] responding 只是单线程内的重入保护（Node 事件循环），不试图跨进程；
      // 置位后到删除之间的 await 是唯一让出点，期间 map 里仍是同一条记录。
      pending.responding = true;
      // 明确失败（用户拒绝/凭据缺失）：不进入账号解析，直接回 headersApplied=false。
      // 先删 pending 再 respond，保证即使 respond 抛错也不会留下可被二次应答的条目。
      if (!params.response.headersApplied) {
        pendingProviderRuntimeHeaders.delete(key);
        await pending.client.respond(pending.protocolRequestId, {
          headersApplied: false,
          ...(params.response.errorMessage ? { errorMessage: params.response.errorMessage } : {}),
        });
        return;
      }
      // 账号凭据解析可能触发网络/Keychain IO：失败时对外只暴露 headersApplied=false，
      // 不让 CLI 用半套 header 发请求——缺 apiKey 的请求会被 provider 拒绝且难以归因。
      let accountRequestAuth: AccountRequestAuthMaterial | undefined;
      try {
        accountRequestAuth = await resolveAccountRequestAuth(pending.request);
      } catch (error) {
        // 等待期间条目可能已被 invalidateWorkspaceClient 清掉并换了新 client：
        // 只有「还是我这一条」才允许删除，避免误删同 key 的新 pending。
        if (pendingProviderRuntimeHeaders.get(key) !== pending) return;
        pendingProviderRuntimeHeaders.delete(key);
        logger.warn(undefined, "ZCode provider runtime headers 应用失败", {
          modelId: pending.request.modelSelection.modelId,
          providerId: pending.request.providerId,
          requestId: pending.request.requestId,
          sessionId: pending.request.sessionId,
          error: error instanceof Error ? error.message : String(error),
          workspaceKey: resolveWorkspaceKey(pending.request.workspace),
        });
        await pending.client.respond(pending.protocolRequestId, {
          headersApplied: false,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      // 同一身份校验再做一次：账号解析的 await 是本方法最长窗口，
      // 期间 client 失效/重新订阅都会让这条 pending 过期，此时必须放弃应答。
      if (pendingProviderRuntimeHeaders.get(key) !== pending) return;
      pendingProviderRuntimeHeaders.delete(key);
      // allowRequestVerificationHeaders 只放行请求校验类 header：
      // 远端传入的任意 header 不能原样透传，否则可以覆盖鉴权或注入代理。
      // 账号 header 先铺底、校验 header 后覆盖，覆盖范围仅限白名单键。
      const requestHeaders = {
        ...accountRequestAuth?.headers,
      };
      Object.assign(
        requestHeaders,
        allowRequestVerificationHeaders(params.response.runtimeProviderHeaders ?? {}),
      );
      // requestAuth 只在「有 apiKey 或至少一个 header」时构造：
      // 空对象会让 CLI 认为鉴权已提供，从而跳过自己的 provider 配置解析。
      const requestAuth =
        accountRequestAuth?.apiKey || Object.keys(requestHeaders).length > 0
          ? {
              ...(accountRequestAuth?.apiKey ? { apiKey: accountRequestAuth.apiKey } : {}),
              ...(accountRequestAuth?.apiKeyId ? { apiKeyId: accountRequestAuth.apiKeyId } : {}),
              ...(accountRequestAuth?.accountScope
                ? { accountScope: accountRequestAuth.accountScope }
                : {}),
              ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
            }
          : undefined;
      // 两种结果的语义要分清：headersApplied=false + errorMessage 表示「不要发请求」，
      // 不是「发了但没带 header」；CLI 据此中止本次模型调用。
      await pending.client.respond(
        pending.protocolRequestId,
        requestAuth
          ? { headersApplied: true, requestAuth }
          : { headersApplied: false, errorMessage: "Provider request auth is missing" },
      );
      // 日志只记 model/provider/requestId，不记 header 值或 apiKey（凭据不出进程）。
      const logContext = {
        modelId: pending.request.modelSelection.modelId,
        providerId: pending.request.providerId,
        requestId: pending.request.requestId,
        sessionId: pending.request.sessionId,
        ...(params.response.errorMessage ? { error: params.response.errorMessage } : {}),
        workspaceKey: resolveWorkspaceKey(pending.request.workspace),
      };
      if (requestAuth) {
        logger.info(undefined, "ZCode provider runtime headers 已应用", logContext);
      } else {
        logger.warn(undefined, "ZCode provider runtime headers 应用失败", logContext);
      }
    },

    // session 级订阅：只把本 session 的 providerRuntimeHeaders.request 转给 listener，
    // 其他事件类型在 emitter 层过滤，避免让订阅方自己判类型。
    // [并发] 先注册 live listener 再补投 pending：两步之间没有 await，但 pending 入表发生在
    // 另一条异步链路，仍可能出现「补投后又重复 live 投递」，由 CLI 侧 requestId 去重兜住；
    // host 不再维护已投递集合，否则又多一张需要有界的表（INV-11）。
    onDynamicProviderRuntimeHeadersRequest(params: ZCodeAgentSessionTarget) {
      const emitter = getSessionEmitter(params);
      return (listener) => {
        const disposable = emitter.event((event) => {
// 共享 emitter 承载多种会话事件，这里只放行 headers 请求，其余静默丢弃。
          if (event.type !== "providerRuntimeHeaders.request") {
            return;
          }
          listener(event.request);
        });
        // Bug 原因：draft 首发会先启动 turn，再把新 sessionId 绑定到 React pane；
        // provider runtime headers 请求可能早于 pane 的 live 订阅，旧实现只 fire event，
        // 导致请求虽留在 pending map，请求校验消费者却永远收不到，真实模型请求无法发出。
        // 必须先注册 live listener，再补投递当前 session 的 pending 请求，封住前后两个窗口。
        const pendingSessionPrefix = `${sessionEventKey(params)}\u0000`;
        for (const [key, pending] of pendingProviderRuntimeHeaders) {
          if (key.startsWith(pendingSessionPrefix)) {
            listener(pending.request);
          }
        }
        return disposable;
      };
    },

    // 只按 workspacePath 匹配会把同路径的 SSH/WSL 会话请求互相投递，属于跨 workspace 泄露。
    // 与 session 级共用同一条 pending 记录，因此两个入口都能应答，靠 responding 闸门去重。
    onDynamicWorkspaceProviderRuntimeHeadersRequest(params: ZCodeAgentWorkspaceTarget) {
      const emitter = getProviderRuntimeHeadersWorkspaceEmitter(params);
      return (listener) => {
        const disposable = emitter.event((request) => {
          listener(request);
        });
        // Bug 原因（2026-08-16 web 远控卡死）：session 级入口要求订阅方知道 sessionId，
        // 而 web 远控新建的会话在桌面没有任何 pane，桌面侧无人订阅，headers 请求
        // 永远滞留 pending。workspace 级订阅与 session 级同语义：先注册 live listener，
        // 再按 workspaceKey 前缀补投 pending，封住请求先于订阅到达的窗口；
        // 隔离按 workspaceKey（identity 优先），禁止把远程同路径 workspace 的请求互投。
        const pendingWorkspacePrefix = `${resolveWorkspaceKey(params)}\u0000`;
        for (const [key, pending] of pendingProviderRuntimeHeaders) {
          if (key.startsWith(pendingWorkspacePrefix)) {
            listener(pending.request);
          }
        }
        return disposable;
      };
    },

    // legacy session 事件订阅（迁移期保留）：把共享 emitter 上的事件流裁剪成
    // 「当前 workspace + session」的连续流，并在建立订阅时补齐 replay 缺口。
    // 三条约束同时成立：
    //   1) 每个订阅者独立去重/独立重试，dispose 只影响自己（INV-04 的订阅者侧）；
    //   2) live 事件在 replay 完成前只缓冲不投递，否则时间线会出现「新事件先到、历史后插」；
    //   3) 缓冲、去重集合、重试定时器、coalescer 都必须随 dispose 释放（INV-11/INV-12）。
    onDynamicSessionEvent(params: ZCodeAgentSessionSubscribeParams) {
      const emitter = getSessionEmitter(params);
      return (listener) => {
        // cancelled / retryTimer 的作用域是单个订阅者：调用方 dispose 时取消自己的重试，
        // 不影响共享 emitter 上的其他订阅者。
        // cancelled 是订阅者级终止标志：dispose 后所有在途 async 分支都要在下一个
        // 检查点退出，不能继续向 listener 投递。
        let cancelled = false;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        let subscriptionReady = false;
        // 缓冲没有显式上限：这些事件只在「replay 请求在途」的短窗口内累积，
        // 窗口由订阅请求超时兜底；长期积压应被视为协议异常，而不是靠截断掩盖。
        const pendingLiveEvents: ZCodeAgentServiceEvent[] = [];
        // 去重集合 + FIFO 顺序表：rememberBoundedEventId 超过 MAX_TRACKED_SESSION_EVENT_IDS
        // 时从表头淘汰，保证长会话订阅不会无限增长（INV-04 的「有界」要求）。
        const deliveredEventIds = new Set<string>();
        const deliveredEventIdOrder: string[] = [];
        // background-summary 模式把高频 token/progress 事件压成低频摘要，
        // 只为不可见的后台 task 服务；主动会话不传 eventCoalescing，保持 continuous 实时性。
        const eventCoalescer =
          params.eventCoalescing?.mode === "background-summary"
            ? createBackgroundSessionEventCoalescer({
                emit: listener,
                flushDelayMs: params.eventCoalescing.intervalMs,
              })
            : null;

        // 所有投递都收敛到这一个出口，保证「取消检查 → 去重 → 合并」的顺序唯一，
        // 避免 replay 与 live 两条路径各自实现一套导致行为分叉。
        const deliverToListener = (event: ZCodeAgentServiceEvent): void => {
          if (cancelled) {
            return;
          }
          // 只对 session.event 去重：snapshot 可能被 replay 与 live 各推一次，
          // 而 snapshot 是全量覆盖，重复投递不会产生重复行。
          if (event.type === "session.event") {
            const firstDelivery = rememberBoundedEventId(
              deliveredEventIds,
              deliveredEventIdOrder,
              event.event.eventId,
            );
            // 非首次投递直接丢弃：同一 eventId 可能同时出现在 replay 结果与 live 流里，
            // 不丢弃会让 UI 时间线出现重复消息/重复工具块。
            if (!firstDelivery) {
              return;
            }
          }
          // 性能优化：后台 task 只需要低频摘要，不能让不可见任务的 token/progress
          // 同频唤醒 renderer；active 订阅没有 eventCoalescing，仍保持实时 continuous。
          // coalescer 只改投递节奏，不改变事件顺序；它内部持有待发摘要，
          // dispose 时必须一起释放，否则定时器会在订阅结束后继续唤醒 renderer。
          if (eventCoalescer) {
            eventCoalescer.accept(event);
            return;
          }
          listener(event);
        };

        // 释放缓冲是一次性动作：subscriptionReady 置位后不再缓冲，
        // 之后的 live 事件直接走 deliverToListener，不再经过这个数组。
        const releaseBufferedLiveEvents = (): void => {
// 已释放过则直接返回；该函数会被订阅成功与快照两处先后调用，必须幂等。
          if (subscriptionReady) {
            return;
          }
          subscriptionReady = true;
// splice(0) 一次性取走并清空缓冲，之后的 live 事件不会再进入这个数组。
          const bufferedEvents = pendingLiveEvents.splice(0);
          for (const event of bufferedEvents) {
            deliverToListener(event);
          }
        };

        // emitter 是 host 级 session emitter（同 workspace+session 共享），这里只做过滤与转发；
        // 共享 emitter 的释放归 disposeLocalState，订阅者侧不能 dispose 它。
        const subscription = emitter.event((event) => {
// dispose 后的迟到事件一律丢弃，避免把已卸载 pane 的回调再叫起来。
          if (cancelled) {
            return;
          }
          if (!subscriptionReady) {
            pendingLiveEvents.push(event);
            return;
          }
// 订阅就绪后直接投递；事件顺序由 emitter 串行保证，不再二次排队。
          deliverToListener(event);
        });

        // 订阅建立是 async + 指数退避重试：CLI 可能尚未 listen 或 runtime 正在换代，
        // 立即失败会让 UI 永久空白，因此最多重试 SESSION_SUBSCRIBE_MAX_ATTEMPTS 次。
        // 每次重试前都检查 cancelled，避免 dispose 后定时器仍把订阅重新装上（INV-12）。
        const establishSubscription = async (attempt: number): Promise<void> => {
          if (cancelled) {
            return;
          }
          try {
          // 只读 client：订阅不提升模型执行权限，也不会因为「有人看历史」触发模型执行门禁。
            const client = await getReadOnlyClient(params);
            if (cancelled) {
              return;
            }
            // afterSeq 由调用方给出「已知的最后序号」，CLI 只回放其后的缺口；
            // includeSnapshot 缺省 false，避免每次重订阅都推一份全量快照。
            const result = await client.request(
              zcodeProtocolMethods.sessionSubscribe,
              {
                sessionId: params.sessionId,
                deliveryKind: params.deliveryKind,
                afterSeq: params.afterSeq,
                includeSnapshot: params.includeSnapshot ?? false,
              },
              zcodeSessionSubscribeResultSchema,
            );
            if (cancelled) {
              return;
            }
            // 按 (seq, timestamp) 排序：CLI 多路写入可能让到达顺序与 seq 不一致，
            // 不排序会让 replay 后的时间线乱序；seq 相同时比 timestamp 只用于稳定排序。
            const replayEvents = result.events
              .map((event) => normalizeSessionEventSeq(params, event))
              .sort((left, right) => left.seq - right.seq || left.timestamp - right.timestamp);
            // session/subscribe 返回的是当前订阅者自己的 replay 缺口。
            // replay 不能 fire 到共享 emitter：会把历史事件重新广播给其他 live 订阅者，
            // 造成 UI 时间线里已完成工具被插回到当前模型输出之后。
            // replay 直接投给本订阅者，不 publish 到共享 emitter：
            // 否则历史事件会被重新广播给其他 live 订阅者，已完成工具被插回当前输出之后。
            for (const event of replayEvents) {
              deliverToListener({ type: "session.event", event });
            }
            // snapshot 在 replay 之后投递：它是「此刻的权威全量」，必须在历史增量之后到达，
            // 否则后续 replay 事件会被 UI 当成旧状态覆盖。
            if (result.snapshot) {
              deliverToListener({
                type: "snapshot",
                snapshot: result.snapshot,
              });
            }
            // 只有 replay + snapshot 都成功投递后才放行 live；失败分支同样释放，
            // 保证任何路径都不会让订阅者永久处于「只缓冲不投递」状态。
            releaseBufferedLiveEvents();
            // 失败重试的错误不向上抛：订阅是长生命周期资源，调用方拿不到可恢复的 Promise；
            // 必须把失败转成日志 + 退避重试，或用 continuous 降级兜底。
          } catch (error) {
            if (cancelled) {
              return;
            }
              // 用 console.warn 而不是 service logger：这里是订阅者闭包，
              // 需要带 pid 前缀才能在渲染进程/多实例日志里定位来源。
            if (attempt >= SESSION_SUBSCRIBE_MAX_ATTEMPTS - 1) {
              // 彻底失败时打 warn 让问题可观测，而不是无声失效。
              console.warn(
                formatLogPrefix("zcode-agent", process.pid),
                "session 订阅建立失败，已达最大重试次数，放弃",
                {
                  sessionId: params.sessionId,
                  workspaceKey: resolveWorkspaceKey(params),
                  attempts: attempt + 1,
                  message: error instanceof Error ? error.message : String(error),
                },
              );
              // 订阅失败后不再无限压住 live 事件；此时没有 replay 权威补洞，只能恢复 continuous 流。
              // [权衡] 降级后时间线可能缺 replay 缺口，但比「永远不刷新」更可诊断。
              releaseBufferedLiveEvents();
              return;
            }
            // 指数退避并封顶 5s：CLI 刚换代时 listen 端口尚未就绪，密集重试只会放大失败；
            // 封顶保证恢复延迟可控（8 次、总计约 20s 量级）。
            const delay = Math.min(
              SESSION_SUBSCRIBE_RETRY_BASE_DELAY_MS * 2 ** attempt,
              SESSION_SUBSCRIBE_RETRY_MAX_DELAY_MS,
            );
            // [资源] retryTimer 是订阅者级资源：dispose 必须 clearTimeout，
            // 否则定时器闭包会持有 listener 与 params，形成进程级泄漏。
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              void establishSubscription(attempt + 1);
            }, delay);
          }
        };

        // 首次尝试不 await：订阅接口同步返回 disposable，调用方拿不到「已就绪」信号，
        // 就绪状态由 snapshot/replay 事件本身表达。
        void establishSubscription(0);

        // [资源] 释放顺序：先置 cancelled 阻止在途分支继续投递，再清定时器，
        // 再清缓冲数组（打断对大对象的引用），最后释放 coalescer 与 emitter 订阅。
        // 重复 dispose 幂等：cancelled 已为 true 时各步都是空操作（INV-12）。
        return {
          dispose() {
// 第一件事置 cancelled：让重连与在途回调在下一步立刻短路。
            cancelled = true;
// 清掉待执行的重试定时器，否则卸载后仍会再发一次 subscribe 请求。
            if (retryTimer) {
              clearTimeout(retryTimer);
              retryTimer = undefined;
            }
            pendingLiveEvents.length = 0;
            eventCoalescer?.dispose();
            subscription.dispose();
          },
        };
      };
    },

    // ── v4 conversation 通道（竖切）：host 只做透传，不落任何业务状态 ──

    // V4 连接的 hello 应答：声明本端能力集与交付档位。
    // clientMode/deliveryProfile 固定为 desktop-continuous，因为这条通道只服务桌面本地直连；
    // 手机远控走 web-remote-replayable，由 relay attachment 侧自己的 hello 声明。
    // 能力位必须与 connection scope 的 hello 同源，否则同一宿主内两类消费者会看到不同能力集，
    // 导致 workflowRun 增量在一端出现、另一端缺失。
    async helloConversationV4() {
// hello 是纯声明，不读 workspace、不查会话表，因此无需任何依赖。
      return {
        kind: "hello" as const,
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId: v4ConnectionId,
        clientMode: "desktop-continuous" as const,
        deliveryProfile: "continuous" as const,
        serverTime: Date.now(),
// capabilities 是静态声明，不随运行时能力探测变化，避免 hello 结果不稳定。
        capabilities: {
          nativeDialogs: true,
          localTerminal: true,
          binaryFrames: false,
          compression: "none" as const,
          workspaceHookReview: true,
          independentPlanState: true,
          // 与 connection scope 的 hello 同一份能力集：直连 base service 的宿主内部消费者
          // 也能收到 `workflowRun.*` 增量（是否真收由它自己的 clientHello 决定）。
          workflowRunDeltas: true,
          historyFirst: true,
        },
        auth: {},
      };
    },

    // initialize 只做协议校验，不持有 clientHello：能力位已在上层解析为 trusted carrier，
    // 这里再存一份就形成第二事实源，且无法随连接换代同步失效。
    async initializeConversationV4(rawClientHello) {
      clientHelloSchema.parse(rawClientHello);
    },

    // 流控状态（pause/resume）必须来自可信连接：伪造 connectionId 可以暂停别人的订阅，
    // 因此未通过 trusted carrier 校验时直接以稳定 fault code 拒绝（INV-05/INV-06）。
    // 只读 client 足以发控制命令——流控不改会话内容，不需要模型执行权限。
    async setConnectionFlowStateV4(params: ZCodeAgentConnectionFlowParams) {
// 流控必须绑定可信 carrier：渲染层伪造的 connectionId 不能用于改别人的窗口。
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.connection.flowControlUntrusted");
// 只读 client 足够：流控只改投递节奏，不写会话内容。
      const client = await getReadOnlyClient(params);
// 明确丢弃返回值：流控是单向控制命令，CLI 没有需要回传的业务数据。
      await client.request(
        V4_METHODS.connectionFlow,
        { connectionId: trusted.connectionId, state: params.state },
        v4ConnectionFlowResultSchema,
      );
    },

    // conversation 冷订阅：桌面连续链路的主入口，负责建立「历史 + 增量」的单一事实源。
    // 前置顺序固定：client 复用判定（只用于耗时归因）→ Account Config 屏障 → lineage 归属校验 → subscribe；
    // 任何一步失败都不能产生 ownership 记录，否则 unsubscribe 会拿到自己没建立的 route。
    // [并发] 同一 (workspace, session) 的重复订阅由调用方先 unsubscribe；这里不做本地去重，
    // 因为 CLI 侧 subscriptionId 才是唯一权威，host 重复订阅会得到两个 id。
    async subscribeConversationV4(params: ZCodeAgentConversationSubscribeParams) {
      // 打点只用于 openTiming 上报，不改变控制流；分段口径要能区分
      // 「host 准备慢」与「CLI 首帧慢」，否则冷启动优化无从定位。
      const subscribeStartedAt = performance.now();
      // 快照「订阅前是否已有 client」必须在 getReadOnlyClient 之前取，
      // 否则该调用自己启动了进程，统计会把 spawned 误记为 reused。
      const existingClient = processManager.getExistingClient(params);
      const cliProcessState: "reused" | "spawned" =
        existingClient && !existingClient.isDisposed ? "reused" : "spawned";
      const cliBootstrapStartedAt = performance.now();
      // 历史 topic 是任务列表点击后的只读事实源。provider/model 未配置时若复用
      // 模型执行门禁，列表虽然能出现但点击后仍无法打开；订阅只启动 CLI，不提升写能力。
      // start-if-needed：历史订阅允许拉起 CLI（只读），但不打开 modelExecutionEnabled。
      const client = await getReadOnlyClient(params);
      const cliBootstrapMs =
        cliProcessState === "spawned"
          ? Math.max(0, Math.round(performance.now() - cliBootstrapStartedAt))
          : undefined;
      // conversation 冷订阅会在 CLI 内部直接恢复历史 Session 并立即发布首帧。
      // 若 Account Config 尚未到达，首帧会先按缺少 Account Overlay 的 Registry 解析；这里只建立
      // Account Config 顺序屏障，不提升模型执行权限。ZCode Built-in / Personal 仍由 Worker 维护。
      const providerRegistryStartedAt = performance.now();
      // 顺序屏障只保证「账号快照已交付」，不代表 Worker Registry 已应用该版本；
      // 因此这里等待同步完成，而不是复用 accountConfigReceivedRevisionByClient 的缓存判断。
      await ensureAccountProviderConfigSynced({
        client,
        reason: "conversation_subscribe",
        workspace: params,
        refreshRegistry: true,
      });
      const providerRegistrySyncMs = Math.max(
        0,
        Math.round(performance.now() - providerRegistryStartedAt),
      );
      // connection 决定 clientMode 与能力位（workflowRunDeltas/historyFirst）：
      // 远端 attachment 的 clientHello 会带自己的档位，不能被默认值覆盖。
      const connection = resolveV4Connection(params);
      // historyFirst 需要两端都支持：连接声明 + CLI 能力探测，缺一即退回旧语义（先 snapshot 后增量）。
      const historyFirst = connection.historyFirst === true && (await supportsHistoryFirst(client));
      // topic 是 CLI 侧路由键，按 sessionId 生成；route 记录必须与它一一对应，
      // 否则 unsubscribe 会匹配到别的订阅（INV-04）。
      const topic = conversationTopic(params.sessionId);
      const taskMetaStartedAt = performance.now();
      // 冷恢复时 CLI 没有 durable selection，思考档位只存在于旧 task meta；
      // 读不到就传 undefined，让 CLI 用自身默认，绝不在此处编一个默认档位（INV-09）。
      const resumeThoughtLevel = await automationTaskIndexRepo
        .getTaskMeta({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          taskId: params.sessionId,
        })
        .then((meta) => meta?.thoughtLevel?.trim() || undefined)
        .catch((error) => {
          // desktop-continuous 的 V4 冷订阅绕过 task adapter，旧 session 没有
          // Agent durable selection 时也就丢了 task-local thought。索引读取失败仍允许只读恢复。
          logger.warn(undefined, "读取 V4 cold resume thought hint 失败，继续无 hint 订阅", {
            error: error instanceof Error ? error.message : String(error),
            event: "v4.conversation.subscribe.resume_thought_hint_failed",
            sessionId: params.sessionId,
            workspaceIdentity: params.workspaceIdentity ?? null,
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          return undefined;
        });
      // 目录解析以「根会话」为准：子会话（auxiliary）的 additionalDirectories 由父会话继承，
      // 直接拿 child 去查项目会被远端必选项目校验拒绝。
      let directorySessionId = params.sessionId;
      if (options?.resolveSessionDirectories) {
        // 子会话按设计不进主任务索引；直接查 child 的项目会被远端必选项目校验拒绝。
        // 旧 child 索引也不能证明主任务身份；只信 Agent 持久化父链，再执行原项目校验。
      // 父链是外部数据，必须防环：visited 让 A→B→A 的损坏元数据变成稳定错误，
      // 而不是让循环把订阅请求拖到超时。
        const visited = new Set<string>();
        while (true) {
          if (visited.has(directorySessionId)) throw new Error("project.session-lineage-invalid");
          visited.add(directorySessionId);
          // 每次只查一个 id：sessionList 的过滤是精确匹配，顺带拿到 workspace 归属用于校验；
          // 批量查再本地筛选会把半条父链的错误状态混在一起。
          const { sessions } = await client.request(
            zcodeProtocolMethods.sessionList,
            { workspace: buildWorkspaceRef(params), sessionIds: [directorySessionId] },
            zcodeSessionListResultSchema,
          );
          const session = sessions.find((entry) => entry.sessionId === directorySessionId);
          // 根会话查不到是允许的（历史索引缺失/已清理），只有「父链中途断掉」才是 lineage 错误；
          // 把两者都判错会让老会话永远打不开。
          if (!session) {
            if (directorySessionId !== params.sessionId)
              throw new Error("project.session-lineage-invalid");
            break;
          }
          // 同时比对 identity key 与 workspacePath：只有 identity 相同还不够，
          // 同 identity 下路径被迁移时目录事实已经不同（INV-02）。
          if (
            resolveWorkspaceKey(session.workspace) !== resolveWorkspaceKey(params) ||
            session.workspace.workspacePath !== params.workspacePath
          )
            throw new Error("project.session-lineage-invalid");
          // 只有 auxiliary（子会话）才继续向上找父；主会话到此为止，
          // 继续上溯会把「同项目里的另一个主任务」误当祖先。
          if (!isAuxiliarySessionKind(session.sessionKind)) break;
          if (!session.parentSessionId) throw new Error("project.session-lineage-invalid");
          directorySessionId = session.parentSessionId;
        }
      }
      // 目录清单由 Host 的 resolveSessionDirectories 计算并覆盖 CLI 返回值；
      // 未注入该能力时保持 undefined，让 CLI 用自己的默认集合，避免伪造空数组清空目录。
      const additionalDirectories = await options?.resolveSessionDirectories?.({
        ...params,
        sessionId: directorySessionId,
      });
      // task meta 读取是可选旁路：耗时单独计量，便于区分「索引慢」与「CLI 慢」。
      const taskMetaReadMs = Math.max(0, Math.round(performance.now() - taskMetaStartedAt));
      const cliRequestStartedAt = performance.now();
      // 真正建立订阅：失败原样抛出，由上层决定是否重试；此时尚未登记 route，
      // 因此失败不会留下需要清理的 ownership 记录。
      const result = await client.request(
        V4_METHODS.conversationSubscribe,
        {
          topic,
          connectionId: connection.connectionId,
          clientMode: connection.clientMode,
          // 与 clientMode 同族的可信位（10 §3.1）：只由这里从连接的 clientHello 注入。
          // 缺席即 CLI 按旧消费者发整键 patch，并先裁到旧界——重订阅、recovery、手机
          // relay attachment 都走这一条 subscribe，所以这一处写全即可。
          // 只在可信连接声明时注入 workflowRunDeltas；缺省不传等价于旧消费者语义。
          ...(connection.workflowRunDeltas === true ? { workflowRunDeltas: true } : {}),
          ...(historyFirst
            ? {
                historyFirst: true,
                ...(params.retryInitialization
                  ? { retryInitialization: params.retryInitialization }
                  : {}),
              }
            : {}),
          // Bug 根因：冷订阅过去只传 sessionId，CLI 只能从历史 session.path 反推
          // workspace 身份；该路径已可能被 path.resolve 改写。当前 attachment 才是权威来源。
          workspace: buildWorkspaceRef(params),
          // 可选字段用条件展开：显式传 undefined 会让旧 CLI 判成「清空」。
          ...(resumeThoughtLevel ? { resumeThoughtLevel } : {}),
          ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        },
        v4ConversationSubscribeResultSchema,
      );
      // cliRequestMs 与 hostPrepareMs 相加约等于总耗时，用于把冷启动问题归因到具体一段。
      const cliRequestMs = Math.max(0, Math.round(performance.now() - cliRequestStartedAt));
      const hostPrepareMs = Math.max(0, Math.round(cliRequestStartedAt - subscribeStartedAt));
      const openTiming = {
        ...(result.ack.openTiming ? result.ack.openTiming : {}),
        version: 1 as const,
        hostPrepareMs,
        ...(cliBootstrapMs !== undefined ? { cliBootstrapMs } : {}),
        cliProcessState,
        providerRegistrySyncMs,
        taskMetaReadMs,
        cliRequestMs,
      };
      // 只有拿到 subscriptionId 才登记 route：它是 unsubscribe/resync 的唯一凭据，
      // 提前登记会让失败请求留下无法释放的 ownership（INV-04）。
      rememberV4SubscriptionRoute(
        params,
        topic,
        result.ack.subscriptionId,
        connection.connectionId,
      );
      // 回包时把 host 实测耗时合并进 openTiming，保留 CLI 自报字段不覆盖。
      return {
        ...result,
        ack: {
          ...result.ack,
          openTiming,
        },
      };
    },

    // unsubscribe 必须带 subscriptionId 并校验 ownership：只按 sessionId 取消会把同会话的
    // 另一个消费者（例如手机 relay）一起踢掉。
    // 找不到 route 时静默成功——重复 unsubscribe 幂等（INV-04/INV-12）。
    async unsubscribeConversationV4(params: ZCodeAgentConversationUnsubscribeParams) {
      await unsubscribeV4Route(params, "conversation/");
    },

    // resync 复用同一条 route 重新要 replay 缺口，不新建订阅：
    // 新建会得到第二个 subscriptionId，旧事件流仍然活着，等于泄漏一路订阅。
    // route 不属于当前调用方时抛 notOwned，避免替别人重同步。
    async resyncConversationV4(params: ZCodeAgentConversationResyncParams) {
      return resyncV4Route(params, "conversation/");
    },

    // V4 command 的唯一写入口：命令进 CommandInbox 串行化，host 不做排队（INV-01）。
    // 返回的 CommandAck 只表示「已受理/已去重」，不表示副作用完成；
    // 真正的终态由 conversation frame 推送。
    async sendConversationCommandV4(params: ZCodeAgentConversationCommandParams) {
      const client = await getClient(params);
      // planEnabled 可能出现在三个位置（顶层 / config / firstInput），是协议演进的兼容面；
      // 任一位置为 true 都必须先确认 CLI 支持 independentPlanState，否则命令会被静默降级。
      const planPayload = params.envelope.payload as {
        planEnabled?: boolean;
        config?: { planEnabled?: boolean };
        firstInput?: { planEnabled?: boolean };
      };
      if (
        planPayload.planEnabled ||
        planPayload.config?.planEnabled ||
        planPayload.firstInput?.planEnabled
      ) {
        // 能力探测失败直接抛出：让用户看到「当前 CLI 不支持计划模式」，
        // 比把 planEnabled 丢掉后假装成功更容易诊断。
        await ensureIndependentPlanSupport(client);
      }
      // RPC facade 会清掉调用方可伪造的顶层 clientMode，再用 trusted carrier 注入 host
      // 真值；host 内部 adapter 直调仍兼容显式 clientMode。
      // 优先取 RPC facade 注入的 trusted carrier，其次兼容 host 内部 adapter 直调时显式传入的
      // clientMode；两者都没有才用桌面默认。客户端自报的顶层字段在 facade 已被清除（INV-06）。
      const commandClientMode =
        readTrustedZCodeAgentV4Connection(params)?.clientMode ??
        params.clientMode ??
        "desktop-continuous";
      // envelope 的构造（commandId、payload schema）集中在 buildConversationCommandEnvelope：
      // 保证重发/重试时命令身份稳定——commandId 变一次就会变成两条独立命令。
      let envelope = await buildConversationCommandEnvelope(params);
      // 只有会解析或创建模型的命令才刷新 Registry 屏障：加到所有命令上会让每个按键
      // 都等一次账号同步，交互延迟不可接受。
      if (requiresProviderRegistryRefresh(envelope.type)) {
        await ensureAccountProviderConfigSynced({
          client,
          reason: "v4_command",
          workspace: params,
          refreshRegistry: true,
        });
      }
      // TTFT 首版只允许可信桌面本地 continuous，手机/远端透传不能开启本地观测。
      // TTFT 观测是桌面本地 continuous 专属能力：远端/手机链路若接受 host 打点，
      // 会把网络往返混进模型首字耗时，指标失去意义，因此直接剥掉字段。
      if (
        commandClientMode !== "desktop-continuous" ||
        params.workspaceIdentity?.trim() ||
        params.remoteSessionId
      ) {
        // 解构丢弃而不是置 undefined：字段存在但为空仍会被下游当成「已上报」。
        const { ttft: _ttft, ...withoutTtft } = envelope;
        envelope = withoutTtft;
      }
      // 只有 sendText 需要补 inputOrigin 与浏览器上下文：其余命令没有用户输入语义。
      if (envelope.type === "sendText" && envelope.sessionId) {
        const sessionId = envelope.sessionId;
        const payload = {
          ...commandPayloadSchemas.sendText.parse(envelope.payload),
        // inputOrigin 用于 CLI 区分输入来源（移动端/桌面），影响权限与默认模式；
        // 这里由可信 clientMode 推导，不读客户端自报字段。
          inputOrigin:
            commandClientMode === "web-remote-replayable"
              ? ("mobile" as const)
              : ("desktop" as const),
        };
        envelope = { ...envelope, payload };
        // 浏览器上下文是可选增强：收集失败返回 undefined，不阻断命令；
        // 远程会话不带桌面浏览器事实，避免把桌面可见页面误当远端上下文。
        const browserAmbientContext = await collectBrowserAmbientContext(
          options?.browserControlExecutor,
          {
            sessionId,
            workspacePath: params.workspacePath,
            ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
            ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
            clientMode: commandClientMode,
          },
        );
        // 有上下文才写 payload 键，避免用 undefined 覆盖已有值。
        if (browserAmbientContext) {
          envelope = {
            ...envelope,
            payload: { ...payload, browserAmbientContext },
          };
        }
      }
      // 不额外放宽 deadline：命令走串行队列，任何一段放宽都会把队头阻塞伪装成慢操作。
      const ack: CommandAck = await client.request(V4_METHODS.command, envelope, commandAckSchema);
      // Prompt command 在 committed TurnStarted 或 committed WorkspaceHookReviewRequested
      // 任一 authority 到达后即返回；人工审核不能占用 Host RPC，因此继续使用统一默认
      // timeout/watchdog。放宽到审核领域 deadline 只会掩盖串行协议队列死锁。
      // duplicate 只证明 commandId 曾处理过，不证明其目标仍是当前 session 配置。
      // 旧 B 命令在用户已切 C 后重放时，不能借 duplicate 把派生缓存再改回 B。
      // ack 不含 snapshot：调用方不要在收到 ACK 后自行拼会话状态，首个 committed frame 才是起点。
      return ack;
    },

    // 命令状态查询：用于补洞与 UI 恢复，必须校验连接可信且只读。
    // clock=true 让 CLI 在结果里附带服务端时间，供调用方校准本地时钟偏差。
    async queryConversationCommandsV4(params: ZCodeAgentCommandsQueryParams) {
      // 不可信连接连查询都不允许：命令 id 属于会话内部标识，
      // 跨连接可枚举会泄露其他 attachment 的活动。
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new Error("fault.command.queryConnectionUntrusted");
      }
      // 入参先过 schema 再发：commands 数组来自渲染层，长度与形状都需要在 host 侧收口。
      const query = commandsQueryParamsSchema.parse({
        commands: params.commands,
        ...(params.clock ? { clock: true } : {}),
      });
      const client = await getReadOnlyClient(params);
      return client.request(V4_METHODS.commandsQuery, query, commandsQueryResultSchema);
    },

    // 附件上传分四段（begin/chunk/commit/abort），全部绑定同一个可信 connectionId：
    // CLI 的 upload registry 以 connectionId + TTL 登记，连接断开时未完成的 upload 由 CLI 回收（INV-07）。
    // [事务] begin 只登记元数据（总字节/总块数/校验和），commit 才让附件对外可见；
    // 中途 abort 或连接断开都不会留下「半个可用附件」。
    async attachmentBeginV4(params: ZCodeAgentAttachmentBeginParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
      // [权衡] 这里用 getClient（模型执行 client）而不是只读 client：上传要写会话附件，需要可写 runtime；
      // 代价是 provider 未就绪时上传会先失败，但附件本来就服务于随后的 send，门禁一致可以接受。
      const client = await getClient(params);
      // 只把协议需要的字段拼进 wireParams，不发 params 原对象：
      // 防止渲染层多余字段（如本地路径）被带到 CLI 侧形成第二条数据通道。
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
        fileName: params.fileName,
        mime: params.mime,
        totalBytes: params.totalBytes,
        totalChunks: params.totalChunks,
        checksum: params.checksum,
      };
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentBegin, wireParams);
      return client.request(V4_METHODS.attachmentBegin, wireParams, v4AttachmentBeginResultSchema);
    },

    // 单块上传：dataBase64 是唯一的大字段，逐块发送避免整文件驻留内存。
    // 每块都重新校验 connectionId，不能在 begin 时记一次就当整条链可信（INV-07）。
    async attachmentChunkV4(params: ZCodeAgentAttachmentChunkParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
// 分块写入属于会话内容变更，必须用可执行 client，保证 upload registry 可写。
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
        chunkIndex: params.chunkIndex,
        dataBase64: params.dataBase64,
      };
      // 发前做 NDJSON 帧预算校验：超出 maxFrameBytes 时同步抛 proto.frameTooLarge，
      // 否则 CLI 会在解析中截断，客户端只看到连接错误而定位不到「块太大」。
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentChunk, wireParams);
      return client.request(V4_METHODS.attachmentChunk, wireParams, v4AttachmentChunkResultSchema);
    },

    // commit 是终态：CLI 校验总块数/校验和后才把附件写入会话；
    // 失败可用同一 uploadId 重试（幂等），但不能修改 totalBytes/checksum。
    async attachmentCommitV4(params: ZCodeAgentAttachmentTerminalParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
// commit 要把附件写入会话，必须走可写 runtime，否则只能读到空 upload。
      const client = await getClient(params);
// 三个字段都是幂等键的一部分，重试时不能增删，否则会被当成新 upload。
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
      };
      // commit 也走帧预算：提交参数虽小，统一检查可防止未来加字段时漏掉。
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentCommit, wireParams);
      return client.request(
        V4_METHODS.attachmentCommit,
        wireParams,
        v4AttachmentCommitResultSchema,
      );
    },

    // abort 是 best-effort 清理：即使 CLI 返回「upload 不存在」也应视为成功，
    // 因为目标状态（不留下未完成 upload）已经达成。
    async attachmentAbortV4(params: ZCodeAgentAttachmentTerminalParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.connectionUntrusted");
// abort 写入 registry 清理未完成上传，用可执行 client 才能命中对应进程。
      const client = await getClient(params);
      const wireParams = {
        connectionId: trusted.connectionId,
        uploadId: params.uploadId,
        sessionId: params.sessionId,
      };
      // 与 commit 共用 TerminalParams：两者互斥，先到者生效，后者被 CLI 拒绝。
      assertV4AttachmentNdjsonEnvelope(V4_METHODS.attachmentAbort, wireParams);
      await client.request(V4_METHODS.attachmentAbort, wireParams, v4AttachmentAbortResultSchema);
    },

    // 按 ref/target/attachmentIndex 读取附件片段（图片预览、大文件分页）。
    // ref 不是路径：CLI 先用 userInput 行证明归属，再由 ref 解析字节；
    // 因此渲染层无法用相对路径逃出附件目录（INV-06）。
    async attachmentReadV4(params: ZCodeAgentAttachmentReadParams) {
// 读附件同样要求可信连接：ref 的解析权限来自 connection 归属，不是调用方声明。
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new Error("fault.attachment.readConnectionUntrusted");
      }
// 用 zod 先收窄参数：offset/limit 越界在 Host 侧直接拒绝，不进 wire。
      const wireParams = v4AttachmentReadParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        ...(params.target ? { target: params.target } : {}),
        ...(params.attachmentIndex !== undefined
          ? { attachmentIndex: params.attachmentIndex }
          : {}),
        offset: params.offset,
        limit: params.limit,
      });
// 读是纯查询：只读 client 即可，不因预览图片而把 workspace 提升为可执行态。
      const client = await getReadOnlyClient(params);
      return client.request(V4_METHODS.attachmentRead, wireParams, v4AttachmentReadResultSchema);
    },

    // 会话级附件读取与 attachmentRead 的差别在授权粒度：这里要求调用方是该 conversation
    // 的订阅者，且 ref 必须属于该 session。
    // 用专门的 fault code（shareReadConnectionUntrusted）而不是通用 Error，
    // 便于上层区分「没权限」与「参数错」，不用 message 文本判断（INV-05）。
    async conversationAttachmentReadV4(params: ZCodeAgentConversationAttachmentReadParams) {
// 与单会话 read 的差异在授权：这里必须是该 conversation 的订阅者。
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new ZCodeAttachmentFaultError(
          ZCODE_ATTACHMENT_FAULT_CODES.shareReadConnectionUntrusted,
        );
      }
// 六字段全部必传（target/attachmentIndex 由 schema 决定可空），不做条件展开。
      const wireParams = v4ConversationAttachmentReadParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        target: params.target,
        attachmentIndex: params.attachmentIndex,
        offset: params.offset,
        limit: params.limit,
      });
// wire 参数先于 client 构建：参数非法时连进程都不必取，减少无谓启动。
// 读取内容不写会话，只读 client 即可，避免为预览启动执行 runtime。
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationAttachmentRead,
        wireParams,
        v4ConversationAttachmentReadResultSchema,
      );
    },

    // stat 只回元数据（大小/类型/分块数），不读内容，比 read 更适合列表渲染前探测；
    // 同样要求可信连接与会话归属。
    async conversationAttachmentStatV4(params: ZCodeAgentConversationAttachmentStatParams) {
// stat 只看元数据，但仍要求会话归属，防止用 ref 探测他人附件是否存在。
      if (!readTrustedZCodeAgentV4Connection(params)) {
        throw new ZCodeAttachmentFaultError(
          ZCODE_ATTACHMENT_FAULT_CODES.shareStatConnectionUntrusted,
        );
      }
// stat 只到 attachmentIndex，没有 offset/limit：它不读内容，没有分页语义。
      const wireParams = v4ConversationAttachmentStatParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        target: params.target,
        attachmentIndex: params.attachmentIndex,
      });
// 同样走只读 client：元数据查询不应提升 workspace 的执行能力。
      const client = await getReadOnlyClient(params);
      return client.request(
        V4_METHODS.conversationAttachmentStat,
        wireParams,
        v4ConversationAttachmentStatResultSchema,
      );
    },

    // 预览源要区分「本地路径」与「分块流」两种形态：
    // 只有桌面本地 continuous 才能拿到 local_path，因为只有本进程能验证该路径。
    // 远端/手机一律降级为 chunked，调用方走 read 分页，不暴露宿主机文件系统布局。
    // local_path 返回前必须经过 authorizeLocalMediaPreviewPath 授权改写，
    // 未注入授权能力时报错而不是原样返回（INV-06：能力由 allowlist 决定）。
    async attachmentPreviewSourceV4(params: ZCodeAgentAttachmentPreviewSourceParams) {
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.attachment.previewSourceConnectionUntrusted");
      if (trusted.clientMode !== "desktop-continuous" || params.remoteSessionId) {
        // 降级路径不查 CLI：远端拿到 local_path 也无法访问，提前返回省一次 RPC。
        return { kind: "chunked" } as const;
      }
      const wireParams = v4AttachmentPreviewSourceParamsSchema.parse({
        sessionId: params.sessionId,
        ref: params.ref,
        ...(params.target ? { target: params.target } : {}),
        ...(params.attachmentIndex !== undefined
          ? { attachmentIndex: params.attachmentIndex }
          : {}),
        clientMode: trusted.clientMode,
      });
      const client = await getReadOnlyClient(params);
      const source = await client.request(
        V4_METHODS.attachmentPreviewSource,
        wireParams,
        v4AttachmentPreviewSourceResultSchema,
      );
      // 非 local_path（内联 data 或 chunked）直接透传，不做二次改写。
      if (source.kind !== "local_path") return source;
      // 授权器缺失是配置错误而不是运行时错误：宁可失败，也不能让渲染层拿到未授权路径。
      if (!options?.authorizeLocalMediaPreviewPath) {
        throw new Error("fault.attachment.previewPathAuthorizationUnavailable");
      }
      // 授权器返回的 path 才是可下发给渲染层的值（可能被改写/加签名），
      // 覆盖 CLI 原始 path，避免两处各持一份路径。
      return {
        ...source,
        path: await options.authorizeLocalMediaPreviewPath(source.path),
      };
    },

    // 行分页：只读 query 透传（超时重发安全，无订阅状态）。
    // beforeRowId 表示「从哪一行之前继续」，翻页方向固定向历史；调用方不能用 limit 猜总行数。
    async conversationRowsRangeV4(params: ZCodeAgentConversationRowsRangeParams) {
// 行分页必须来自可信连接：connection 决定 clientMode 与可见的历史窗口。
      const trusted = readTrustedZCodeAgentV4Connection(params);
      if (!trusted) throw new Error("fault.conversation.rowsRangeConnectionUntrusted");
// 分页是可安全重发的只读 query，不需要可写 runtime。
      const client = await getReadOnlyClient(params);
// clientMode 取自可信连接而不是入参，防止渲染层伪造成只读模式绕过准入。
      return client.request(
        V4_METHODS.conversationRowsRange,
        {
          sessionId: params.sessionId,
          clientMode: trusted.clientMode,
          ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
          limit: params.limit,
        },
        v4ConversationRowsRangeResultSchema,
      );
    },

    // 只读计划目录沿现有 workspace attachment 透传，不建立新 runtime。
    async conversationPlansV4(params: ZCodeAgentConversationPlansParams) {
// 计划目录是静态只读数据，不需要 runtime 锁或账号屏障。
      const client = await getReadOnlyClient(params);
// 只带 sessionId：workspace 已由连接绑定，不在请求体里重复声明。
      return client.request(
        V4_METHODS.conversationPlans,
        { sessionId: params.sessionId },
        v4ConversationPlansResultSchema,
      );
    },

    // workflow run 事件日志：同样是只读 query，沿现有 workspace attachment 透传。
    // 分页发生在存储层（JournalStorePort.listEvents 带 afterSequence/limit），这里不切片；
    // 在 RPC 层切等于每翻一页把整条 journal 读进内存。
    async conversationWorkflowRunEventsV4(params: ZCodeAgentConversationWorkflowRunEventsParams) {
// journal 读取是纯查询：不建订阅、不在 Host 侧维护游标。
      const client = await getReadOnlyClient(params);
// afterSequence/limit 只在有值时下发，省略表示从开头读或使用网关默认页大小。
      return client.request(
        V4_METHODS.conversationWorkflowRunEvents,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        v4ConversationWorkflowRunEventsResultSchema,
      );
    },

    // workflow run 枚举：journal-backed 的重启后发现面（workflowRuns 投影跨进程不存活）。
    // 这是「恢复面」而不是实时面：run 枚举只来自 journal，不订阅、不缓存。
    async conversationWorkflowRunsV4(params: ZCodeAgentConversationWorkflowRunsParams) {
// run 枚举跨进程不持久，Host 不缓存结果，每次重启后发现都重新读 journal。
      const client = await getReadOnlyClient(params);
// 只带 sessionId 与可选 limit，不附加任何过滤条件。
      return client.request(
        V4_METHODS.conversationWorkflowRuns,
        {
          sessionId: params.sessionId,
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        v4ConversationWorkflowRunsResultSchema,
      );
    },

    // dwf 用户面产物的三条读面。
    // ⚠ 术语：artifact = 脚本发布给用户看的产出，不是 run 的顶层返回值。
    // 三条与 plans / workflowRunEvents 同族：只读、无状态、超时重发安全，走只读客户端。
    // 必须同时给 sessionId + runId：artifactId 只在 run 内唯一，单靠 artifactId 会跨 run 误读。
    async conversationWorkflowRunArtifactsV4(
      params: ZCodeAgentConversationWorkflowRunArtifactsParams,
    ) {
// 产物列表只读；artifactId 离开 run 上下文没有意义，因此 runId 必传。
      const client = await getReadOnlyClient(params);
// 返回的 artifact 元数据原样透传，Host 不按类型筛选或重排。
      return client.request(
        V4_METHODS.conversationWorkflowRunArtifacts,
        { sessionId: params.sessionId, runId: params.runId },
        v4ConversationWorkflowRunArtifactsResultSchema,
      );
    },

    // 看板取数：limit 的缺省与钳制在 CLI 网关侧，这里只透传——两处各钳一次，
    // 同一个 limit 迟早会在两层上得到不同的页大小。
    async conversationWorkflowRunArtifactDataV4(
      params: ZCodeAgentConversationWorkflowRunArtifactDataParams,
    ) {
// 取数只读，超时重发不会产生副作用，因此可以用只读 client。
      const client = await getReadOnlyClient(params);
// limit 不在这里补默认值：钳制只在 CLI 网关做一次，避免两层页大小不一致。
      return client.request(
        V4_METHODS.conversationWorkflowRunArtifactData,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          artifactId: params.artifactId,
// afterSequence 缺省表示从头取；它与 limit 各自独立展开，互不牵制。
          ...(params.afterSequence !== undefined ? { afterSequence: params.afterSequence } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        v4ConversationWorkflowRunArtifactDataResultSchema,
      );
    },

    // 字节：一次一块（≤ 512 KiB），拼接归 renderer 的 hook。授权全在 CLI 侧——
    // 这里传下去的 id 只用于在 journal 里查行，绝不成为路径。
    async conversationWorkflowRunArtifactReadV4(
      params: ZCodeAgentConversationWorkflowRunArtifactReadParams,
    ) {
// 分块读取：offset/limit 必须原样上送，Host 不预读整块再做切片。
      const client = await getReadOnlyClient(params);
// version 用于固定读取时的产物版本，避免读到写入中的新版本。
      return client.request(
        V4_METHODS.conversationWorkflowRunArtifactRead,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          artifactId: params.artifactId,
// version 不进 schema 的默认值，调用方必须显式给出版本才能读到确定内容。
          version: params.version,
          offset: params.offset,
          limit: params.limit,
        },
        v4ConversationWorkflowRunArtifactReadResultSchema,
      );
    },

    // dwf 工作区 transcript 的两条读面。同族：
    // 只读、无状态、超时重发安全，走只读客户端。maxBytes 的缺省与钳制在 CLI 网关侧。
    async conversationWorkflowRunWorkspaceV4(
      params: ZCodeAgentConversationWorkflowRunWorkspaceParams,
    ) {
// transcript 读取同属只读族：不创建、不修改 run 的工作区快照。
      const client = await getReadOnlyClient(params);
// maxBytes 缺省交给 CLI 网关，Host 不在这一层二次钳制。
      return client.request(
        V4_METHODS.conversationWorkflowRunWorkspace,
        { sessionId: params.sessionId, runId: params.runId },
        v4ConversationWorkflowRunWorkspaceResultSchema,
      );
    },

    // 单节点结果：siteId + ordinal 定位 run 内的具体执行点；
    // 复用同一 transcript 读取面，避免为节点结果单独开一套存储查询。
    async conversationWorkflowRunNodeResultV4(
      params: ZCodeAgentConversationWorkflowRunNodeResultParams,
    ) {
// 节点结果与 transcript 共用只读读取面，不为单个节点单独建连接。
      const client = await getReadOnlyClient(params);
// siteId + ordinal 共同定位执行点，两者都不可省。
      return client.request(
        V4_METHODS.conversationWorkflowRunNodeResult,
        {
          sessionId: params.sessionId,
          runId: params.runId,
          siteId: params.siteId,
// ordinal 是节点在站点内的执行顺序，与 siteId 组合才唯一。
          ordinal: params.ordinal,
          ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
        },
        v4ConversationWorkflowRunNodeResultResultSchema,
      );
    },

    // 后台 shell 输出轮询必须 existing-only：没有 runtime 时直接返回 unavailable，
    // 绝不能为了读输出拉起新 CLI——新进程里根本没有那个 workId。
    // [失败路径] 旧 CLI 不认识该方法时返回 unsupported，让 UI 隐藏入口而不是报错；
    // 只有这两类预期内错误被转换，其余原样抛出（INV-05：按 code 分流，不看 message）。
    async backgroundBashOutputV4(params: ZCodeAgentBackgroundBashOutputParams) {
// workId 只在可信连接的运行时里有意义，未通过校验时直接拒绝。
      if (!readTrustedZCodeAgentV4Connection(params))
        throw new Error("fault.bashOutput.connectionUntrusted");
// 只留 sessionId/workId：轮询参数不携带任何可写字段。
      const wireParams = v4BackgroundBashOutputParamsSchema.parse({
        sessionId: params.sessionId,
        workId: params.workId,
      });
      try {
        // existing-only 语义：只提升/复用当前 active client，找不到就抛 runtime unavailable。
        const client = await getReadOnlyClient(params, "existing-only");
        return await client.request(
          V4_METHODS.backgroundBashOutput,
          wireParams,
          backgroundBashOutputResultSchema,
        );
      } catch (error) {
        // unsupported 与 unavailable 的区别是「这台 CLI 永远不支持」与「此刻没进程」，
        // UI 据此选择隐藏入口还是提示稍后重试。
        if (isProtocolMethodNotFoundError(error))
          return { kind: "unsupported", workId: params.workId };
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE
        ) {
          return { kind: "unavailable", workId: params.workId };
        }
        throw error;
      }
    },

    // 文件变更视图：baseRevision/baseLogEpoch 是游标对，成对传递才能判断「日志已换代」；
    // 只传 revision 会把新一代的同号变更误判为增量。
    async conversationFileChangesV4(params: ZCodeAgentConversationFileChangesParams) {
// 变更视图是查询，不触碰文件系统，只读 client 足够。
      const client = await getReadOnlyClient(params);
// target/游标成组下发；Host 不补 baseLogEpoch，缺失应由 schema 拒绝。
      return client.request(
        V4_METHODS.conversationFileChanges,
        {
          sessionId: params.sessionId,
          target: params.target,
          baseRevision: params.baseRevision,
          baseLogEpoch: params.baseLogEpoch,
        },
        v4ConversationFileChangesResultSchema,
      );
    },

    // 回滚预览只计算差异，不执行回滚；真正的 rewind 走 command 通道。
    // 与 fileChanges 共用同一组游标，保证预览与列表基于同一基线。
    async conversationFileRewindPreviewV4(params: ZCodeAgentConversationFileRewindPreviewParams) {
// 预览只算差异不落盘，绝不在这里调用真正的 rewind。
      const client = await getReadOnlyClient(params);
// 与 fileChanges 相同的游标字段，保证预览与列表看到同一基线。
      return client.request(
        V4_METHODS.conversationFileRewindPreview,
        {
          sessionId: params.sessionId,
          target: params.target,
          baseRevision: params.baseRevision,
          baseLogEpoch: params.baseLogEpoch,
        },
        v4ConversationFileRewindPreviewResultSchema,
      );
    },

    // conversation frame 的 workspace 级订阅：frame 已按 topic 路由到对应 emitter，
    // 未命中的 workspace 会惰性创建，避免为所有打开过的项目常驻 emitter。
    onDynamicConversationFrame(params: ZCodeAgentWorkspaceTarget) {
      return getConversationFrameEmitter(params).event;
    },

    // TTFT 事实按 workspaceKey 过滤后再交给 listener：emitter 是进程级共享的，
    // 不在这里过滤会让 A 项目的耗时出现在 B 项目的指标面板。
    onDynamicLocalTtftFacts(params: ZCodeAgentWorkspaceTarget) {
// 返回退订函数；过滤条件在每次事件到达时现算，避免捕获过期的 key。
      return (listener: (facts: LocalTtftFacts) => void) =>
        localTtftFactsEmitter.event((event) => {
          if (event.workspaceKey === resolveWorkspaceKey(params)) listener(event.facts);
        });
    },
    // 遥测事实不做过滤：上报侧已带 workspaceKey，多一层过滤只会造成双份真相。
    onDynamicConversationTelemetryFact(params: ZCodeAgentWorkspaceTarget) {
      return getConversationTelemetryFactEmitter(params).event;
    },
    // off-peak 生命周期（开始/暂停/结束）按 workspace 订阅，用于 UI 展示低峰执行状态。
    onDynamicOffPeakLifecycle(params: ZCodeAgentWorkspaceTarget) {
      return getOffPeakLifecycleEmitter(params).event;
    },
    // off-peak 控制命令：pause/resume/cancel 是对 CLI 调度器的控制面写操作。
    // existing-only：没有 runtime 时返回 unavailable，不能为「暂停」拉起新进程——
    // 新进程没有正在执行的 off-peak 任务，暂停毫无意义且会污染 active client 表。
    async controlOffPeakExecutionV4(
      params: ZCodeAgentWorkspaceTarget & { control: OffPeakControlParams },
    ) {
// 先用 schema 收窄 control，非法 action 不进入 wire，也不影响 client 选择。
      const control = offPeakControlParamsSchema.parse(params.control);
// existing-only：控制命令必须命中已有 runtime，找不到就回 unavailable。
      const client = await getReadOnlyClient(params, "existing-only");
      return client.request(V4_METHODS.offPeakControl, control, offPeakControlResultSchema);
    },

    // 插件 UI 工具结果广播：插件在 CLI 侧产生的 UI 动作（打开面板等）由 host 转给渲染层；
    // 不按 workspace 过滤，因为结果自带来源标识，由渲染层按当前激活会话消费。
    onDynamicPluginUiToolResult() {
      return pluginUiToolResultEmitter.event;
    },
    // CUA 权限观察事件：只上报观察结果，不在此处做权限决策；
    // 决策仍在 CLI/操作系统权限层，host 转发避免形成第二套判定。
    onDynamicCuaPermissionObservation() {
      return cuaPermissionObservationEmitter.event;
    },

    // ── sessions-index 通道（列表活性）：复用 conversationSubscribe RPC，
    // 按 topic 前缀由 CLI server 分派 ──

    // 列表对账：把 host 已知的 sessionIds 交给 CLI，让它补齐/淘汰索引项。
    // existing-only：对账是观察者动作，不应该为了刷新列表启动进程。
    // workspaceId 用 resolveWorkspaceKey（identity 优先），同路径不同 authority 不互相认领（INV-02）。
    async reconcileSessionsIndexV4(params) {
// existing-only 已由注释说明；这里强调对账不会创建 runtime，也不会回写本地索引。
      const client = await getReadOnlyClient(params, "existing-only");
// sessionIds 只作为比对输入，CLI 返回哪些项缺失/多余，由调用方决定如何合并。
      return client.request(
        V4_METHODS.sessionsIndexReconcile,
        { workspaceId: resolveWorkspaceKey(params), sessionIds: params.sessionIds },
        sessionsIndexReconcileResultSchema,
      );
    },

    // sessions-index 与 conversation 共用同一条连接、同一套 route 记录，
    // 因此 unsubscribe/resync 与 conversation 完全同构，只是 topic 前缀不同。
    async subscribeSessionsIndexV4(params: ZCodeAgentSessionsIndexSubscribeParams) {
      // 侧栏会同时登记所有 restored workspace。被动订阅若使用启动型 client，
      // workspace 数量会直接放大成 CLI 数量；existing-only 缺 runtime 时只进入 dormant。
      const client = await getReadOnlyClient(params, params.runtimePolicy);
      // subscriberScope 参与 connectionId：多个消费者（renderer/syncer）各自独立订阅，
      // 共用一个 connectionId 会让取消/重同步互相影响。
      const connection = resolveV4Connection(params, v4ConnectionIdFor(params.subscriberScope));
      // topic 只由 workspaceKey 决定：同一 workspace 的所有订阅者共享一条 CLI 索引流。
      const topic = sessionsIndexTopic(resolveWorkspaceKey(params));
      // 3.3.6 的 CLI session 未写 remote workspace_id，但同版本 host task index
      // 已按完整 identity 隔离。升级时必须用当前 workspaceKey 下的 taskId 作归属证明；
      // 禁止只把 workspacePath 传给 CLI，否则同路径不同 SSH/WSL authority 会互相认领历史。
      // legacyTaskIds 只对 3.3.6 之前的远端会话补归属证明，且数量有上限：
      // 全量传给 CLI 会把订阅请求撑成大帧，并让旧索引变成隐式授权。
      let legacyTaskIds: string[] = [];
      if (supportsLegacyRemoteTaskAllowlist(params.workspaceIdentity)) {
          // 读失败只降级为「无 allowlist」：已有完整 identity 的 3.4 会话仍能严格查询，
          // 不能让兼容读取故障把整个列表打成不可用。
        try {
          legacyTaskIds = (
            await automationTaskIndexRepo.listTaskMetas({
              workspacePath: params.workspacePath,
              workspaceIdentity: params.workspaceIdentity,
              provider: "glm",
            })
          )
            // 截断到 MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE：这是请求体边界而不是业务过滤，
            // 超出部分只能靠用户重新打开对应会话补齐。
            .slice(0, MAX_LEGACY_TASK_IDS_PER_SUBSCRIBE)
            .map((task) => task.taskId);
        } catch (error) {
          // 归属证明只用于升级迁移；task index 不可用时仍要让已有完整
          // identity 的 3.4 会话走严格查询，不能让兼容读取故障变成整个列表不可用。
          logger.warn(undefined, "读取远端历史任务归属证明失败，继续按严格 identity 订阅", {
            error: error instanceof Error ? error.message : String(error),
            event: "sessions_index.legacy_remote_allowlist_read_failed",
            workspaceIdentity: params.workspaceIdentity,
            workspacePath: params.workspacePath,
          });
        }
      }
      // base/visibility 原样透传：快照基线由调用方给，host 不猜「从哪一版开始」。
      const result = await client.request(
        V4_METHODS.conversationSubscribe,
        {
          topic,
          connectionId: connection.connectionId,
          clientMode: connection.clientMode,
          ...(legacyTaskIds.length > 0 ? { legacyTaskIds } : {}),
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        },
        v4SessionsIndexSubscribeResultSchema,
      );
      // 登记 route 后才能 unsubscribe；与 conversation 共用 ownership 表，
      // 但 topic 前缀不同，取消时不会互相误伤。
      rememberV4SubscriptionRoute(
        params,
        topic,
        result.ack.subscriptionId,
        connection.connectionId,
      );
      return result;
    },

    // 取消索引订阅：找不到 route 视为已取消（幂等），不抛错；
    // 只按 subscriptionId + topic 前缀匹配，避免误删同名话题的其他订阅。
    async unsubscribeSessionsIndexV4(params: ZCodeAgentConversationUnsubscribeParams) {
      await unsubscribeV4Route(params, "sessions-index/");
    },

    // 重同步索引：复用旧 route 重新拉取全量/缺口，不新建订阅。
    async resyncSessionsIndexV4(params: ZCodeAgentConversationResyncParams) {
      return resyncV4Route(params, "sessions-index/");
    },

    // 索引帧按 workspace 分发；帧本身已含 workspaceKey，不再二次过滤。
    onDynamicSessionsIndexFrame(params: ZCodeAgentWorkspaceTarget) {
      return getSessionsIndexFrameEmitter(params).event;
    },

    // ── workspace-config 通道（配置目录活性）：复用 conversationSubscribe RPC，
    // 按 topic 前缀由 CLI server 分派 ──

    // 订阅而非轮询：配置目录变更频率低，轮询会让每个窗口周期性 stat 整棵目录。
    async subscribeWorkspaceConfigV4(params: ZCodeAgentWorkspaceConfigSubscribeParams) {
      const client = await getReadOnlyClient(params, params.runtimePolicy);
// subscriberScope 决定 connectionId：窗口级订阅与 syncer 级订阅互不干扰。
      const connection = resolveV4Connection(params, v4ConnectionIdFor(params.subscriberScope));
      // topic 按 workspaceKey 生成，同一 workspace 的所有窗口共享一条配置流。
      const topic = workspaceConfigTopic(resolveWorkspaceKey(params));
      const result = await client.request(
        V4_METHODS.conversationSubscribe,
        {
          topic,
          connectionId: connection.connectionId,
          clientMode: connection.clientMode,
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        },
        v4WorkspaceConfigSubscribeResultSchema,
      );
// ack 成功后立刻登记路由：后续 unsubscribe/resync 都依赖这层映射。
      rememberV4SubscriptionRoute(
        params,
        topic,
        result.ack.subscriptionId,
        connection.connectionId,
      );
// 原样返回 ack 与首帧，调用方无需再发一次读取来拿初始配置。
      return result;
    },

    // 取消配置订阅：与索引订阅同构，重复取消幂等。
    async unsubscribeWorkspaceConfigV4(params: ZCodeAgentConversationUnsubscribeParams) {
      await unsubscribeV4Route(params, "workspace-config/");
    },

    // 配置重同步：配置是低频事件，通常发生在窗口 focus 或 runtime 重启后。
    async resyncWorkspaceConfigV4(params: ZCodeAgentConversationResyncParams) {
      return resyncV4Route(params, "workspace-config/");
    },

    // 配置帧按 workspace 分发；emitter 惰性创建，未订阅的 workspace 不占内存。
    onDynamicWorkspaceConfigFrame(params: ZCodeAgentWorkspaceTarget) {
      return getWorkspaceConfigFrameEmitter(params).event;
    },

    // 进程资源采样：来自 CLI 的 CPU/内存快照，进程级共享，无 workspace 维度。
    onDynamicProcessResourceSample() {
      return processResourceSampleEmitter.event;
    },

    // 工具执行资源采样：用于 UI 展示单次工具调用的耗时/资源占用。
    onDynamicToolExecResource() {
      return toolExecResourceEmitter.event;
    },
    // MCP 资源采样：每个 MCP server 的请求/内存指标，按 server 维度聚合。
    onDynamicMcpResourceSamples() {
      return mcpResourceSamplesEmitter.event;
    },

    // MCP 遥测：协议级事件（握手、工具列表刷新），与资源采样分开，避免高频数值挤掉低频诊断。
    onDynamicMcpTelemetry() {
      return mcpTelemetryEmitter.event;
    },

    // （CLI 重连重订）：进程换代直通 process manager；v4 订阅方（task-index
    // syncer 等）据此重发 subscribe——订阅活在 CLI 进程内存，换代即静默失活。
    onAgentRuntimeRestarted(listener) {
      return processManager.onRuntimeRestarted(listener);
    },

    // 生命周期（starting/ready/exited）用于 UI 状态与诊断；同样直接透传，
    // host 不缓存最后一次状态，避免与 processManager 形成两份事实。
    onAgentRuntimeLifecycle(listener: (event: ZCodeAgentRuntimeLifecycleEvent) => void) {
      return processManager.onRuntimeLifecycle(listener);
    },

    // 释放单个 workspace 的 runtime 与本地派生状态：active client 的订阅、pending、
    // 定时器都必须在此刻断掉，否则会在 client 失效后继续向渲染层投递（INV-07）。
    // 重复调用幂等：找不到 active 时只清偏好同步记录，不会重复 close（INV-12）。
    async disposeWorkspace(params): Promise<void> {
      const workspaceKey = resolveWorkspaceKey(params);
      // 释放不仅要终止当前进程，还要让已排队的 provider-ready continuation 失效；
      // 否则它会在 dispose 完成后把同一个 workspace 的 Agent 再次启动。
      cancelWaitingWorkspaceStartup(workspaceKey);
      clearV4SubscriptionRoutes(workspaceKey);
      cuaOperationTurnTracker?.clearWorkspaceKey(workspaceKey);
      // active 存在时走 invalidate：它会清理该 client 的 pending 权限/询问/headers 与 disposable；
      // 不存在时只需清掉交互偏好同步的 in-flight 记录，避免下次启动误以为已同步。
      const active = activeClientsByWorkspaceKey.get(workspaceKey);
      if (active) {
        invalidateWorkspaceClient(workspaceKey, active.client);
      } else {
        interactionPreferenceSyncByWorkspaceKey.delete(workspaceKey);
      }
      // 该入口被 restartWorkspaceProcess 用作 runtime invalidation，并非
      // workspace/service 真 teardown。销毁 workspace emitter 会让既有 UI/task-index
      // listener 永久绑在死对象上；emitters 只由 disposeLocalState/disposeAll 释放。
      // 进程终止由 processManager 负责；host 只保证自己的派生表已清理，
      // 因此这里不 await client 级 dispose（它们在 invalidate 中同步完成）。
      await processManager.disposeWorkspace(params);
    },

    // 全量释放：三个 process manager 分别管理 chat / plugin / mcp-status 进程，
    // 任何一个漏掉都会留下孤儿进程（Windows 上还会占住日志文件）。
    disposeAll(): void {
      // 同步版本只发终止信号，不等待退出；需要确定进程已消失时用 disposeAllAndWait。
      processManager.disposeAll();
      pluginProcessManager.disposeAll();
      mcpStatusProcessManager.disposeAll();
      // automation 专用的 AutomationRepo / TaskIndexRepo 各持 tasks-index.sqlite
      // 连接句柄，dispose 后必须收口，否则 Windows 上句柄悬着（临时目录清理撞 EBUSY）
      // close 在进程 terminate 之后：先断进程，避免它们在关闭过程中继续写库。
      automationRepo.close();
      automationTaskIndexRepo.close();
      disposeLocalState();
    },

    // 与 disposeAll 的差别只在于等待三个 manager 的进程真正退出后再关库；
    // 用于测试/重启等需要「返回后句柄一定已释放」的场景。
    // [失败路径] Promise.all 任一 reject 会直接跳出本方法，下面的 close 不再执行：
    // 进程已退出但 sqlite 句柄仍在，Windows 上会表现为后续清理 EBUSY，调用方需自行兜底。
    async disposeAllAndWait(): Promise<void> {
      // 并行等待而非串行：三者互不依赖，串行只会线性放大退出时间。
      await Promise.all([
        processManager.disposeAllAndWait(),
        pluginProcessManager.disposeAllAndWait(),
        mcpStatusProcessManager.disposeAllAndWait(),
      ]);
// 走到这里说明三个进程都已退出，此时关库不会被仍在写入的进程重新打开。
      automationRepo.close();
      automationTaskIndexRepo.close();
      disposeLocalState();
    },
  };
}
