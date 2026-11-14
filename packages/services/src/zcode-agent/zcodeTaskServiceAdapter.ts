/**
 * ============================================================================
 * services/zcode-agent/zcodeTaskServiceAdapter.ts —— 旧 task 面 → ZCode session 的适配门面
 * ============================================================================
 *
 * 【定位】迁移期兼容层：把旧的 IZCodeTaskService / task projection 调用翻译成
 * V4 ZCode session 命令与快照。文件头的 max-lines disable 已说明"迁移期需要在
 * 一个门面里集中维护协议适配"——这是有意保留的过渡结构，不是新的架构方向。
 *
 * 【事实源纪律】
 *   - conversation 正文事实源是 CLI 的 command inbox + ProductProjection；
 *   - task 行集合/组织态（pin、archive、group、unread）由 tasks-index 持有；
 *   - 本文件只做字段级 join 与协议转换，不建立第二份 accepted queue，
 *     也不在 UI/Host 侧缓存"已提交输入"。
 *
 * 【迁移判据】判断某个旧方法能否删除，证据不是"调用点变少"，而是：
 *   1) V4 对应命令/查询已覆盖同一产品语义；
 *   2) 冷恢复与 replay 能产出同一终态；
 *   3) 旧端（legacy CLI/旧 Desktop）已无调用方。
 *
 * 【兼容风险】这里同时读旧 task meta 与新 session snapshot；字段缺失时必须
 * 区分"旧数据没有"与"新链路尚未写入"，不能用一个默认值同时糊住两种情况。
 * ============================================================================
 */
// ============================ 本文件不变量索引（L1 深注） ============================
// 依赖/维护的不变量（编号沿用批次总表，不另起编号）：
//   INV-01：conversation 权威状态在 CLI（CommandInbox + ProductProjection）。本文件的 Map 只放
//            host 侧会话轮转状态（emitter、runtime command、live 工具镜像），不放消息/队列第二份。
//            反过来：若在此缓存 accepted 输入，冷恢复后 CLI 与本 Map 会给出两个队列，重放重复起 turn。
//   INV-08：迁移判据是「V4 覆盖 + 冷恢复/replay 同终态 + 旧端无调用方」三元组，不是「调用点变少」；
//            所以 legacy 读取与旧 op 回退都保留，删任何一条都要先补齐另外两条证据。
//   INV-09：旧 task meta 与 session snapshot 同时可读时，字段缺失必须区分「旧数据没有该字段」（可补）
//            与「新链路尚未写入」（不可用默认值顶替），否则会把运行中 task 误判成已完成。
//   INV-10：task 行集合与组织态（pin/archive/group/unread）由 tasks-index 持有；本文件只 join 字段，
//            不复制成第二事实源，否则 archive/pin 会在适配层与 index 之间分叉。
//   INV-11：live tool projection、streaming tool input、runtime command 都是进程级缓存，必须显式有界
//            并在终态/换轮/dispose 释放；漏释放会让长驻 Host 的堆随会话数线性增长。
//   INV-05：协议错误按稳定 code/reasonCode 分流，禁止用 message 文本判断成功与否（本文件仅对
//            legacy session 缺失这一条历史文本做正则兜底，见 isSessionMissingError）。
// 阅读顺序（按数据流）：sendPromptToAgent（唯一写路径）→ resumeSnapshotOrLegacy（三态读路径）→
//   snapshotToMeta（session → task 投影）→ readLegacyTaskSnapshot（旧数据补位）→ 末尾 index 同步。
import { isAuxiliarySessionKind } from "@zcode/shared";
// Bot 话题准入是进程级单例：同一机器人并发 webhook 必须共享同一个去重窗口，
// 否则两条同时到达的消息会各自判定「首次」并重复创建 topic/session。
import { createBotTopicAdmission } from "#src/zcode-agent/botTopicAdmission.js";
// 群执行运行时快照：只读 CLI 已发布状态（等待点/执行中成员），不在此层推断完成，
// 避免 Host 与 CLI 各自算一份「群任务是否结束」。（INV-01）
import {
  readBotGroupRuntimeSnapshot,
  waitBotGroupExecutionEnd,
} from "#src/zcode-agent/groupRuntimeSnapshot.js";
// 群附件上传是副作用出口：先完成上传拿到引用，再进 sendPrompt，
// 避免命令已被 CLI 接受但附件仍在本地、冷恢复后消息指向不存在的文件。
import { uploadBotGroupAttachments } from "./groupAttachmentUpload.js";
// max-lines 豁免的理由是迁移期单门面收敛协议适配；若把方法拆散到多个文件，
// 旧 task 到 V4 的字段口径会重新碎片化，删除旧路径时无法一次性核对覆盖面。
/* oxlint-disable eslint(max-lines) -- 迁移期需要在一个门面里集中维护旧 task projection 到 ZCode session 的协议适配。 */
// crypto 同时承担两种身份：commandId（幂等键，必须客户端生成、可重试）+ traceId 兜底，
// 不能用递增计数器——Host 重启后计数器归零会与历史 commandId 撞车，导致 CLI 侧判为重复命令。
import { createHash, randomUUID } from "node:crypto";
// connection scope 工厂是 Bot 接入的传输边界：附件、命令、对账共用一条连接，
// 这样 INV-07（client 断开释放订阅/pending）只需要在 scope 内实现一次。
import { createZCodeAgentConnectionScope } from "#src/zcode-agent/zcodeAgentConnectionScope.js";
// fs 只用于 legacy 只读快照探测/解析（existsSync + readFileSync）。本文件不写盘：
// 任何落盘都会与 tasks-index 争事实源（INV-10），且 Host 崩溃窗口无法与 CLI 事务对齐。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Emitter/Event 是进程内广播原语，不保证跨进程投递：跨进程一致性一律由 CLI 快照承担，
// emitter 只负责把同一快照推给本进程内的订阅者（同 workspace 多窗口）。
import {
  Emitter,
  Event,
  emitNetworkTelemetryObservation,
  type NetworkObservation,
} from "@zcode/rpc";
// 以下第一批是「投影口径」共享函数：状态推导、标题解析、模型值编解码都放在 @zcode/shared，
// Host 与 UI 必须调用同一份，否则同一 session 在任务列表与详情页会给出不同标题/状态。
import {
  coalesceConsecutiveZCodeAssistants,
  createSessionTraceId,
  decodeCustomModelValue,
  deriveZCodeTaskStatusFromSessionSnapshot,
  extractPlanStepsFromToolInput,
  extractPlanStepsFromToolOutput,
  generateTraceId,
  getZCodeGoalActiveIterationCount,
  getZCodeGoalIterationByAssistantMessageId,
  getZCodeUserVisibleMessages,
  isMainAgentToolProjectionSource,
  normalizeZCodeApiRetryStatus,
  // 第二批是后台任务通知（notification/control item）的解析与合并：它们把 CLI 的文本通知还原成
  // 结构化工具更新，属于「协议转换」而非本地状态，故无副作用、可纯函数化。
  attachZCodeBackgroundTaskNotificationToRaw,
  collectZCodeBackgroundTaskNotificationsByToolUseId,
  mergeZCodeBackgroundTaskControlItems,
  parseZCodeBackgroundTaskControlItems,
  parseZCodeBackgroundTaskNotificationText,
  parseModelPickerValue as parseSharedModelSelection,
  // resolveWorkspaceKey 是 INV-02 的唯一入口：所有 task key、连接 key、index 查询都必须经过它，
  // 禁止手写 workspacePath 拼接，否则远程 workspace（同路径不同 identity）会被合并成一条。
  resolveWorkspaceKey,
  resolveZCodeVisibleSessionTitle,
  textFromZCodeMessageParts,
  // provider 常量固定为 zcode-agent：task meta.provider 只用于 UI 分组与历史兼容，
  // 不代表实际执行进程，禁止据此分支路由。
  ZCODE_AGENT_PROVIDER,
  zcodeBackgroundTaskNotificationToolUpdateStatus,
  appendZCodeStreamingToolInputDelta,
  buildZCodeStreamingToolInputPreview,
  createZCodeToolProjectionMemory,
  finalizeZCodeToolProjectionInput,
  forgetZCodeToolProjectionMetadata,
  isZCodeModelRetryRecoveryProgressPayload,
  markZCodeStreamingToolInputPreviewMaterialized,
  resolveZCodeToolProjectionMetadata,
  zcodeApiRetryFromModelNetworkStatusPayload,
  zcodeApiRetryFromStreamRecoveryPayload,
  zcodeTaskNetworkDebugStatusFromPayload,
  shouldMaterializeZCodeStreamingToolInputPreview,
  // 以下 type-only 导入不产生运行时依赖，删除它们不会改变 bundle；
  // 但它们定义了跨层契约（task/session/event 的形状），改动必须与 CLI 的 schema 同步。
  type ZCodeApiRetryStatus,
  type ZCodeAssistantMessageFeedback,
  type ZCodeBackgroundTaskNotificationInfo,
  type ZCodeBackgroundTaskControlItem,
  type ZCodeBackgroundTurnAttribution,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeCancelTaskCommandResult,
  type ZCodeCodexConnectivityCheckResult,
  type ZCodeConfigOption,
  type ZCodeEnqueueTaskCommandResult,
  type ZCodeError,
  type ZCodeGoalVerificationTimelineMeta,
  type ZCodeImportSessionsResult,
  type ZCodeImportableSessionCandidate,
  type ZCodeUsage,
  type ZCodePersistedMessage,
  type ZCodePersistedMessagePart,
  type ZCodePersistedToolCall,
  type ZCodePromptAttachment,
  type ZCodeProvider,
  type ZCodeSessionFile,
  type ZCodeTaskGoal,
  type ZCodeTaskGoalStats,
  type ZCodeTaskMode,
  type ZCodePlanStep,
  type ZCodeSlashCommand,
  type ZCodeStreamEvent,
  type ZCodeSwitchAgentResult,
  type ZCodeSyncTaskSessionBindingResult,
  type ZCodeTaskCreateResult,
  type ZCodeTaskMeta,
  type ZCodeTaskClientMode,
  type ZCodeTaskRuntimeCommand,
  type ZCodeTaskSnapshot,
  type ZCodeTaskSnapshotBody,
  type ZCodeTaskSnapshotRefContent,
  type ZCodeTaskSnapshotToolCallsSlice,
  type ZCodeTaskTokenUsageResult,
  type ZCodeTodoGroup,
  type ZCodeTurnSteerCommandKind,
  type ZCodeTurnSteerSource,
  type ZCodeWorkspaceEvent,
  type ZCodeWorkspaceTaskListChanged,
  type InputId,
  type TraceId,
  // schema 值导入用于在边界处校验外部 payload（context usage、session settings），
  // 校验失败走降级分支而不是抛错——这些 payload 来自旧版本 CLI，不能让 UI 整页失败。
  zcodeContextUsageBreakdownSchema,
  zcodeSessionSettingsStateSchema,
  type ZCodeDeliveryKind,
  type ZCodeMessagePart,
  type ZCodeMessageWithParts,
  type ModelSelection,
  type ZCodePermissionOption,
  type ZCodePermissionRequestParams,
  type ZCodePermissionRequest,
  type ZCodeSessionEvent,
  type ZCodeSessionMode,
  type ZCodeSessionSettingsState,
  type ZCodeSessionStateSnapshot,
  type ZCodeStateUpdatedNotification,
  type ZCodeContextCompactionTimelineMeta,
  type ZCodeTimelineMeta,
  type ZCodeTimelineStatus,
  type ZCodeTimelineTrigger,
  type ZCodeToolProjectionMemory,
  type ZCodeUserInputRequestParams,
  type ZCodeUserInputResponse,
  type ZCodeAgentMcpServer,
} from "@zcode/shared";
// 旧 task 面接口 IZCodeTaskService 是本次适配的目标契约：本文件返回它就是「旧端无需改动」的证明，
// 但方法存在 ≠ 语义已迁移（见 unsupported 与各方法内注释）。
import type {
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeWorkspaceEventSubscriptionParams,
  IZCodeTaskService,
  ZCodeArchivedTaskDeletionResult,
  ZCodeTaskReadyOutcome,
  ZCodeTaskTerminalOutcome,
} from "../session/zcodeTaskService.js";
// 日志按 services/AGENTS.md 分级：消息流同量级用 debug，生命周期/失败用 info/warn；
// 高频路径写 info 会让生产日志随流量膨胀，排查时反而找不到信号。
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  AUTOMATION_MUTATION_TOOL_NAMES,
  OFF_PEAK_MUTATION_TOOL_NAMES,
// 自动化/闲时工具名单来自策略模块，本文件只做「本轮是否该隐藏」的判定：
// 把名单写死在这里会让 CLI 侧策略升级后 Host 静默放行不该出现的写操作。
} from "#src/zcode-agent/automationToolPolicy.js";
import type { ISettingService } from "#src/setting/setting.js";
// sessionMailbox 的两个类型用于 enqueue 语义：请求与投递结果分开建模，
// 这样「命令已接受」和「消息已投递给 CLI」不会被混成一个布尔值。
import type {
  SessionMessageDeliveryResult,
  SessionMessageSendRequested,
} from "#src/session/sessionMailbox.js";
// TaskIndexRepo 是 tasks-index 的读写入口（INV-10）：本文件只能用它的 get/update 系列，
// 不得绕过它直接改 task 行集合，否则索引与 UI 快照会失去原子性。
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
// IZCodeAgentService 是新链路能力面：本文件对它的依赖只到「session 命令 + 快照 + 连接 scope」，
// 不依赖具体 transport，测试与未来 client 可替换实现。
import type {
  IZCodeAgentService,
  ZCodeAgentServiceEvent,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
// syncer 持有 workspace emitter 与 broadcast 入口，因此是「共用同一实例」的强约束：
// adapter 若自建 emitter，desktop-continuous 与 task 路径会分裂成两份订阅，UI 收不全事件。
import type {
  ZCodeTaskIndexReadyEvent,
  ZCodeTaskIndexSyncer,
  ZCodeTaskIndexTerminalEvent,
} from "./zcodeTaskIndexSyncer.js";
import { readModelTrajectory } from "./modelTrajectory.js";
// V4 host command 三件套：envelope 构造、CAS 发送、ACK 断言。ACK 必须断言而不是忽略，
// 否则命令被 CLI 拒绝时 Host 仍返回成功，pendingCommands 会永久悬挂（INV-05）。
import { errorAttributionSchema, type CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import {
  assertV4CommandAckOk,
  createHostCommandEnvelope,
  sendHostCasCommandV4,
} from "./zcodeV4HostCommand.js";
// legacy 路径解析集中在 #src/paths，删除态与在态两个路径都要探测：
// 用户删除 task 后仍可能从回收站视图恢复，只读在态路径会让已删任务永久不可见。
import {
  getLegacyDeletedTaskSessionSnapshotPath,
  getLegacyTaskSessionSnapshotPath,
} from "#src/paths.js";
// Claude 原生会话导入是另一条历史来源：导入态 session 的 snapshot 可能为空，
// 因此读路径必须先 repair 再投影，否则任务列表出现「有 task 无消息」的幽灵行。
import { claudeNativeSessionImportRepo } from "#src/session/claude-native/claudeNativeSessionImportRepo.js";
import { importClaudeNativeSessions } from "#src/session/claude-native/claudeNativeSessionImportService.js";
import { repairImportedClaudeSessionSnapshot } from "#src/session/claude-native/importedClaudeHistoryRepair.js";
import { safeParseLegacyTaskSessionFile } from "#src/session/legacyTaskSessionFile.js";
// 配置项编解码（model/mode/thoughtLevel）必须用 configOptions 这一份：
// 直接拼 model 值会在 picker 与 task meta 之间产生格式漂移（见 formatModelPickerValue）。
import {
  MODEL_CONFIG_ID,
  MODE_CONFIG_ID,
  THOUGHT_LEVEL_CONFIG_ID,
  formatTaskMetaModelSelectionFromSnapshot,
  formatModelPickerValue,
  getZCodeAgentAvailableModes,
  normalizeAvailableZCodeMode,
  settingsToConfigOptions,
} from "./zcodeConfigOptions.js";
// CUA 产品 MCP 解析器把「产品级 MCP 配置」展开成实际 server 列表；
// 内存诊断 provider 只读注册 size 计数，不持有引用，避免诊断本身阻止 GC。
import type { CuaProductMcpServerResolver } from "#src/cua-permission-broker/index.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

// 依赖注入只允许「能力」不允许「实现」：session 命令面、快照读取、index repo、syncer。
// taskIndexRepo 可选是为了让测试用内存实现；生产必须注入同一个 repo 实例，
// 否则 adapter 写一份、UI 读另一份，pin/archive 状态会立刻分叉（INV-10）。
// taskIndexSyncer 必填（见 325 行注释）：它持有 workspace emitter，
// 若 adapter 自行 new 一个，desktop-continuous 路径与 task 路径的事件订阅会分裂。
// 本文件不接管任何依赖的 dispose，生命周期由组装方（service 容器）负责。
interface CreateZCodeTaskServiceAdapterOptions {
  zcodeAgentService: IZCodeAgentService;
  taskIndexRepo?: TaskIndexRepo;
  // syncer 现在持有 workspace emitter 和 broadcast 入口，adapter 必须共用同一实例，
  // 否则 desktop-continuous 路径和 task adapter 路径的事件订阅会分裂成两份，UI 收不全。
  taskIndexSyncer: ZCodeTaskIndexSyncer;
  settingService?: Pick<ISettingService, "get">;
  cuaProductMcpServerResolver?: CuaProductMcpServerResolver;
}

// TaskTarget 是「旧 task 身份」的最小完备集，用来拼 taskKey 并做连接路由。
// 注意 taskId 与 sessionId 是同一个值：旧协议叫 task，新协议叫 session，本文件全程做同义转换，
// 禁止在中间层再引入一个 id 映射表，否则映射表就成了第二事实源（INV-01/INV-10）。
// workspacePath 与 workspaceIdentity 必须成对贯穿（INV-02）：只带 path 会让远程 workspace
// 在 key 上与其他同路径 workspace 合并，事件与命令投递到错误的 client。
// cronAutomationId 是 sticky 归属标记（UI 展示用），不是本轮执行身份，权限判定只看 automationId。
// remoteSessionId 仅远程链路存在；缺失时不得用空串伪造，否则会命中本地连接。
interface TaskTarget {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  cronAutomationId?: string;
  remoteSessionId?: string;
}

// 带 MCP/模型参数的 target 只用于 resume/create 入口：这些字段是「恢复 hint」，
// 描述该 session 应该以什么配置重建，而不是本 turn 的执行权限。
// additionalDirectories 属于 session 级能力，透传后由 CLI 侧校验准入。
interface TaskTargetWithMcpServers extends TaskTarget {
  additionalDirectories?: string[];
  model?: string;
  thoughtLevel?: string;
  mcpServers?: ZCodeAgentMcpServer[];
  toolDenylist?: string[];
}

// WorkspaceEventInput 允许 string 简写只是 ergonomics，内部仍会归一成带 identity 的对象。
type WorkspaceEventInput = string | ZCodeWorkspaceEventSubscriptionParams;
type ZCodeSendPromptRuntimeCommand = Extract<ZCodeTaskRuntimeCommand, { type: "send_prompt" }>;
type ZCodeTerminalStreamEvent =
  | Extract<ZCodeStreamEvent, { type: "task_complete" }>
  | Extract<ZCodeStreamEvent, { type: "task_error" }>;

// GLM_PROVIDER 是历史命名别名，值固定为 ZCODE_AGENT_PROVIDER：保留旧名只为少改调用点，
// 不要把 provider 字段当路由依据。
// EMPTY_SLASH_COMMANDS 作为共享常量必须冻结语义（调用方只读），
// 若某处 push 进去，会让所有 workspace 的斜杠命令列表被污染。
const GLM_PROVIDER: ZCodeProvider = ZCODE_AGENT_PROVIDER;
const EMPTY_SLASH_COMMANDS: ZCodeSlashCommand[] = [];
const logger = createServiceLogger("zcode-task-service");
const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";
const EXIT_PLAN_MODE_APPROVAL_QUESTION = "Review this implementation plan.";
const EXIT_PLAN_MODE_APPROVAL_APPROVE = "approve";

// 这两个上限是 INV-11 的显式边界，不是性能调优：live projection 按 task、按 tool 两级有界，
// 128 个活跃 task、每 task 2000 个工具，足以覆盖真实会话，同时把最坏内存钉在常量上。
// 没有上限时，一个长跑 agent 反复调用工具会让 Map 随工具数增长且永不回收。
// 淘汰策略是「最旧 order 优先」，即丢头部工具；终态 snapshot 仍能补齐已落库工具，
// 因此丢尾部不会污染事实源，只会让极长历史的前段在 live 镜像里缺失。
const MAX_LIVE_TOOL_PROJECTION_TASKS = 128;
const MAX_LIVE_TOOL_PROJECTION_TOOLS_PER_TASK = 2000;

// LiveToolProjection 存的是「live 事件合并后的工具镜像」，不是持久化事实：
// order 单调递增（跨 task 共享计数器），用于跨 task 稳定排序与淘汰最旧；
// parentToolUseId 用于把 subagent 子工具挂到父工具所在消息，缺失时退化到最近 assistant 消息。
// toolId 冗余保存，避免每次淘汰/查找时再去 raw.toolCallId 解析字符串。
interface LiveToolProjection {
  order: number;
  parentToolUseId: string | null;
  tool: ZCodePersistedToolCall;
  toolId: string;
}

// 日志日期用本地时区而不是 UTC：排查按天对账时用户与日志的「今天」必须一致；
// 改 UTC 会让东八区早上 8 点前的日志落到前一天文件。
function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}

// collect 成数组再 join，避免模板字符串拼接产生隐式顺序差异（月份必须补零）。
function formatZCodeAgentLogDate(now: Date): string {
  return [now.getFullYear(), padDatePart(now.getMonth() + 1), padDatePart(now.getDate())].join("-");
}

// ZCODE_LOG_DIR 优先于默认目录，是为了让容器/测试把日志重定向到挂载卷；
// 默认落到 ~/.zcode/cli/log 与 CLI 同目录，便于按 session 与 CLI 日志并排对账。
// 该函数只做路径计算，不创建目录、不打开文件：写盘由 logger 实现负责，
// 本文件保持零落盘（否则会与 CLI 的持久化事务窗口错位）。
function resolveZCodeAgentCurrentLogFilePath(now = new Date()): string {
  const configuredLogDir = process.env.ZCODE_LOG_DIR?.trim();
  const logDir = configuredLogDir || join(homedir(), ".zcode", "cli", "log");
  return join(logDir, `zcode-${formatZCodeAgentLogDate(now)}.jsonl`);
}

/**
 * 创建旧 task 面适配器。
 *
 * 依赖注入的是"新链路能力"（session 命令、快照读取、connection scope）而不是
 * 具体 transport；这样 Host/测试/未来 client 都能复用同一适配层。
 *
 * 返回对象上的每个方法都应满足：
 *   - 读：只读 CLI 已发布的 snapshot/查询，不在 Host 侧二次归约；
 *   - 写：转成 V4 command（带 commandId/baseRevision），不直接改本地状态；
 *   - 兼容：旧字段缺失时返回缺省，但不得伪造"已完成"事实。
 */
// 适配器工厂：返回对象即完整 IZCodeTaskService 实现，供 service 容器装配。
// 职责边界（三条，改动时逐条核对）：
//   1) 读：只读 CLI 已发布的 snapshot/查询，不在 Host 做二次归约（INV-01）；
//   2) 写：转成 V4 command 或旧 op，带 commandId 幂等键，不改本地权威状态；
//   3) 兼容：旧字段缺失时返回缺省，但绝不伪造「已完成/turn 结束」这类终态事实。
// 副作用面：进程内广播（emitter）、tasks-index 读写、启动后台 drain Promise；
// 不启动定时器、不监听网络、不写文件——这些都属于 zcodeAgentService / syncer。
// 失败语义：所有 public 方法把底层错误原样抛给调用方（保留 code），
// 只在本层把「不可恢复的协议错」转成显式 throw，不做静默降级。
export function createZCodeTaskServiceAdapter(
  options: CreateZCodeTaskServiceAdapterOptions,
): IZCodeTaskService {
  // Bot 原来绕过连接 facade，导致真实附件 admission 缺少可信身份；复用既有 scope，
  // 同一 Bot 接入的附件、命令及对账共用连接，不改变桌面与手机各自的传输模式。
  // Bot 连接 scope 表：key = workspaceKey + remoteSessionId，懒创建、进程内复用。
  // 为什么必须复用：同一 bot 的附件上传、命令发送、对账若各建一条连接，
  // CLI 侧会看到多个 client，attachment 归属与 pending 清理就会跨连接错配（INV-07）。
  // [权衡] 该 Map 目前没有删除路径（scope 无 dispose 面暴露给本文件）；
  // workspace 数量有界时可接受，若未来支持大量临时 bot workspace，需要补 LRU 并由 scope 释放订阅。
  // clientMode=desktop-continuous 与 role=trusted-host-relay 决定能力面：
  // bot 不走移动端 allowlist，因此这里能下发附件与命令（INV-06）。
  const botConnectionScopes = new Map<string, ReturnType<typeof createZCodeAgentConnectionScope>>();
  // 用 JSON.stringify([key, remoteSessionId]) 而非字符串拼接：remoteSessionId 可为空串，
  // 手拼 `${key}:${id}` 会让 ["a:b", ""] 与 ["a", "b"] 撞成同一个 key。
  // 只返回 scope.service，不把 scope 本身交出去：能力面收敛为「服务方法」，
  // 调用方拿不到 connection 句柄，就无法绕过 scope 自行 teardown（INV-07）。
  function botAgent(workspace: ZCodeAgentWorkspaceTarget) {
    const key = JSON.stringify([resolveWorkspaceKey(workspace), workspace.remoteSessionId ?? ""]);
    let scope = botConnectionScopes.get(key);
    if (!scope) {
      scope = createZCodeAgentConnectionScope(options.zcodeAgentService, {
        connectionId: `bot-${randomUUID()}`,
        clientMode: "desktop-continuous",
        role: "trusted-host-relay",
      });
      botConnectionScopes.set(key, scope);
    }
    return scope.service;
  }
  // errorEmitter 是全局错误通道；taskEmitters/globalTaskEmitters 是两层流式事件通道：
  //   - taskEmitters：key 含 workspace（INV-04），给「某个 workspace 的某个 task」订阅；
  //   - globalTaskEmitters：只按 taskId，给跨 workspace 的单任务视图订阅。
  // 两条通道都 fire 同一事件（emitTaskEvent），避免出现「详情页收到、列表页收不到」。
  // [资源] Emitter 自身没有 dispose 语义，删除 task 时必须由 deleteTask 主动释放，
  // 否则 task 被删后 Map 仍持有 emitter 及其闭包，形成进程级泄漏。
  const errorEmitter = new Emitter<ZCodeError>();
  const taskEmitters = new Map<string, Emitter<ZCodeStreamEvent>>();
  const globalTaskEmitters = new Map<string, Emitter<ZCodeStreamEvent>>();
  const taskTargets = new Map<string, TaskTarget>();
  // 话题准入需要跨 turn 保存「已处理」标记，因此挂在 adapter 实例上，
  // 而不是每次 sendPrompt 新建；新建会让同一 webhook 的重试被当成新话题。
  const topicAdmission = createBotTopicAdmission();
  // runtimeCommands 是「Host 侧尚未被 CLI 接受的命令」镜像，不是会话队列（INV-01）：
  // 一旦 sendPrompt ACK，命令仍保持 running 直到终态事件到达，然后 remove。
  // value 用数组保持提交顺序：drain 只取第一条 accepted，保证串行；
  // 若改成 Set/Map 会丢失顺序，后提交的命令可能先发给 CLI，与用户可见顺序相反。
  // [资源] 生命周期终点是 removeRuntimeCommand（终态/失败/取消），不是 ACK。
  // runtimeCommandDrains 记录每 task 的链式 drain Promise，用于串行化（见 scheduleRuntimeCommandDrain）。
  const runtimeCommands = new Map<string, ZCodeTaskRuntimeCommand[]>();
  const runtimeCommandDrains = new Map<string, Promise<void>>();
  // apiRetry 状态与后台任务控制项都按 taskKey 存：它们是「投影元数据」，
  // 只在 live 期间有意义，snapshot 读取时被 join 回 runtime 字段供 UI 展示。
  const apiRetryByTaskKey = new Map<string, ZCodeApiRetryStatus | null>();
  // 控制项来自通知文本解析（parseZCodeBackgroundTaskControlItems），
  // 合并时以 toolUseId 为键去重；缓存存在的原因是通知可能先于对应 tool_call 到达。
  const backgroundTaskControlsByTaskKey = new Map<string, ZCodeBackgroundTaskControlItem[]>();
  // streamedTurnText 缓存本轮已累积的文本片段，用于在没有 messageId 的 delta 上做出稳定聚合；
  // 轮次结束或新输入开始时清空，否则跨轮文本会串到下一次回复里。
  const streamedTurnText = new Map<string, { messageId?: string; text: string }>();
  // activePromptInputIds 是本轮的 owner 边界：value 是本次输入的 inputId（旧字段名 traceId）。
  // 两个用途：1) drain 时判断「该 task 是否已有在跑的一轮」，避免并发起 turn；
  // 2) assertCurrentOwnerRun 用它拒绝过期 owner 命令（远端 stale 防护）。
  // [失败路径] 发送失败会 delete，确保不会因为一次失败把 task 永久锁在「运行中」。
  const activePromptInputIds = new Map<string, InputId>();
  // toolProjectionMemory 由 createZCodeToolProjectionMemory 创建，装着 streaming tool input 的分片累积；
  // 按 taskKey 有界（每个 task 一份，内部 per-tool 表由 shared 模块裁剪），终态时整体释放。
  const toolProjectionMemoryByTaskKey = new Map<string, ZCodeToolProjectionMemory>();
  // live 工具镜像按 taskKey 二级 Map：外层有 MAX_LIVE_TOOL_PROJECTION_TASKS 上限，
  // 内层有 MAX_LIVE_TOOL_PROJECTION_TOOLS_PER_TASK 上限（INV-11）。
  const liveToolProjectionsByTaskKey = new Map<string, Map<string, LiveToolProjection>>();
  // 跨 task 的单调 order 计数器：只增不减，用于内层淘汰时比较「谁更旧」。
  let liveToolProjectionOrder = 0;
  // legacySnapshotTaskKeys 记录「已按旧快照恢复过」的 key，用于后续读路径分流：
  // 命中说明该 task 没有对应 CLI session，不能再按 session 语义订阅或发送命令。
  const legacySnapshotTaskKeys = new Set<string>();
  // 内存诊断计数器（docs/monitoring/memory-diagnostics-log.md）：对应审计里 deleteTask
  // 不清理的 per-task 表，只读 size。
  // 内存诊断（docs/monitoring/memory-diagnostics-log.md）：只上报 size，不遍历值、不持有引用。
  // 这里刻意只登记三张审计中被点名的 per-task 表；新增 Map 若不加计数，
  // 泄漏排查时就会缺少证据，但也不要把大对象塞进闭包。
  // 审计里 deleteTask 不清理这些表是已知缺口，本注释只记录现状，不在此修复。
  // [权衡] 用闭包读 size 而不是维护独立计数器：少一份需要同步的状态，
  // 代价是每次采样要做一次 Map.size 读取（O(1)，可接受）。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("task", () => ({
    runtimeCommands: runtimeCommands.size,
    toolMemoryTasks: toolProjectionMemoryByTaskKey.size,
    taskEmitters: taskEmitters.size,
  }));
  // repo 默认 new 一个只在「测试/无容器装配」时成立；生产注入共享实例，
  // 否则 adapter 的 updateTaskPresentation 与 UI 读的 index 不是同一份（INV-10）。
  const taskIndexRepo = options.taskIndexRepo ?? new TaskIndexRepo();
  const taskIndexSyncer = options.taskIndexSyncer;

  // 之前 adapter 自带 notifySyncerSession 时把 syncer 视为可选；现在 syncer 是构造必填项，
  // 简化为直接调用，避免每个 callsite 都做空判断。
  // 会话订阅登记必须走 syncer：它负责把 (workspaceKey, sessionId) 映射到 workspace emitter，
  // 并按 INV-04 做重复订阅幂等与旧 disposable 释放。
  // 本函数没有返回值也不等待：订阅是「确保存在」，失败由 syncer 内部记录，
  // 读路径不应因为订阅失败而整体失败（降级为「这次拿不到增量，下次全量」）。
  function notifySyncerSession(target: TaskTarget): void {
    taskIndexSyncer.ensureSessionSubscription({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      sessionId: target.taskId,
    });
  }

  // unsupported 是「显式未迁移」的唯一表达：抛带稳定 code 的错误，让旧端能区分
  // 「方法不存在」与「方法存在但语义未覆盖」。
  // 为什么不用返回空值：空值会让旧 UI 显示成功但没有效果，问题被推迟到用户侧；
  // 抛错至少能在迁移看板里被统计到（INV-08 的「旧端无调用方」证据也依赖这个信号）。
  function unsupported(name: string): never {
    throw Object.assign(
      new Error(`ZCode task service adapter does not support IZCodeTaskService.${name} yet.`),
      {
        code: "ZCODE_AGENT_UNSUPPORTED_LEGACY_TASK_METHOD",
      },
    );
  }

  // 本轮工具黑名单：只根据「本轮执行身份」追加，不看持久化的会话归属。
  // automationId（本轮自动化触发）与 offPeakTaskId（闲时派发）互斥语义不同，两个分支不合并：
  // cron 轮必须放行 OffPeakCreate，合并会让定时任务错误隐藏闲时入口。
  // [失败路径] 返回 undefined 而不是空数组：undefined 表示「不下发 disallowlist 字段」，
  // 空数组会被 CLI 当成显式「全部允许」，两者在协议上不等价。
  function resolvePromptToolDenylist(params: {
    automationId?: string;
    offPeakTaskId?: string;
    toolDenylist?: string[];
  }): string[] | undefined {
    const toolDenylist = new Set(params.toolDenylist);
    // 关键：判断依据只能是 automationId（本轮），不能是 cronAutomationId（会话归属）。
    // 反之：一旦用持久化归属做权限，用户在同一会话手动修改调度也会被永久禁掉 CronUpdate。
    // 持久化的 cronAutomationId 不能当成当前 turn 的执行身份，否则定时任务
    // 跑过一次后，用户在同一会话主动修改调度也永久看不到 CronUpdate。权限必须只看本轮
    // automationId；cronAutomationId 仅保留任务归属和 UI 展示语义。
    if (params.automationId) {
      for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
        toolDenylist.add(toolName);
      }
    }
    // 闲时派发轮纵深隐藏 OffPeakCreate；该分支与 automation 独立，
    // 因为两者可能同时存在（自动化在闲时窗口跑），此时禁用的是并集。
    // 闲时派发轮纵深隐藏 OffPeakCreate；不与 automation 分支合并（cron 轮放行）。
    if (params.offPeakTaskId) {
      for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
        toolDenylist.add(toolName);
      }
    }
    return toolDenylist.size > 0 ? [...toolDenylist] : undefined;
  }

  // 轮次归因归一化：背景自动化与闲时任务在协议上是两个可选字段，
  // 本函数保证「最多一种归因」并剔除空值，避免向下游发送 {automationId: undefined} 这类脏字段。
  // offPeakRunType 只在有 offPeakTaskId 时透传：单独出现没有意义，且会让 CLI 归因失败。
  function turnAttributionOf(
    params: ZCodeBackgroundTurnAttribution,
  ): ZCodeBackgroundTurnAttribution {
    if (params.automationId) return { automationId: params.automationId };
    if (params.offPeakTaskId) {
      return {
        offPeakTaskId: params.offPeakTaskId,
        ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
      };
    }
    return {};
  }

  // 产品级 MCP 展开：只有配置非空且解析器存在时才调用，避免每次 resume 都走一遍 IO。
  // 解析失败向上抛：MCP 配置错误属于「恢复不可能正确」的场景，静默降级会起一个缺工具的会话。
  // [权衡] 空数组归一成 undefined：协议里「未配置」与「配置为空」语义相同，
  // 传空数组会让 CLI 侧显式清空 session 级 MCP，与用户预期相反。
  async function resolveProductMcpServers(
    servers: ZCodeAgentMcpServer[] | undefined,
  ): Promise<ZCodeAgentMcpServer[] | undefined> {
    const configuredServers = (servers?.length ?? 0) > 0 ? servers : undefined;
    if (!configuredServers || !options.cuaProductMcpServerResolver) {
      return configuredServers;
    }
    return options.cuaProductMcpServerResolver.resolveMcpServers(configuredServers);
  }

  // workspaceKey 只做转发，禁止在调用点手写拼接：这是 INV-02 的唯一收口点，
  // 以后 key 规则变化（例如加租户维度）只需改 resolveWorkspaceKey。
  function workspaceKey(params: { workspacePath: string; workspaceIdentity?: string }): string {
    return resolveWorkspaceKey(params);
  }

  // taskKey 用 \u0000 分隔 workspaceKey 与 taskId：NUL 不可能出现在路径/identity/ID 中，
  // 因此不会出现「a\0b + c」与「a + \0b\0c」的歧义拼接。
  // 该 key 用于所有 per-task Map；键不一致会导致「写进 A 表、读 B 表」的静默丢状态。
  function taskKey(params: { workspacePath: string; workspaceIdentity?: string; taskId: string }) {
    return `${workspaceKey(params)}\u0000${params.taskId}`;
  }

  // owner 命令错误用 Object.assign 挂 code，而不是自定义 Error 子类：
  // 错误要跨进程/序列化边界传给远端，code 字段比 instanceof 更可靠（INV-05）。
  // 两个 code 的语义互斥：NO_ACTIVE_TASK_OWNER 表示 task 已终态收口，
  // STALE_TASK_OWNER_COMMAND 表示 task 仍在跑但不是这一轮，远端应丢弃而不是重试。
  function createTaskOwnerCommandError(
    message: string,
    code: "NO_ACTIVE_TASK_OWNER" | "STALE_TASK_OWNER_COMMAND",
  ): Error & { code: "NO_ACTIVE_TASK_OWNER" | "STALE_TASK_OWNER_COMMAND" } {
    return Object.assign(new Error(message), { code });
  }

  // ownerRunId 缺省时直接放行：本地/旧端调用不带 owner，兼容路径不能因为缺少字段而失败。
  // 有关键值时做两步校验，顺序不能换：先判「有没有在跑」，再判「是不是同一轮」。
  // 反过来（先比 id）会把「已终态」误报成 stale，远端会重试一条永远不会被接受的命令。
  // [失败路径] 两种情况都抛错而不是返回 false：调用方必须感知拒绝，
  // 否则旧命令会被写进 host 队列，在桌面 shared host 上误发历史输入（本层最危险的串台路径）。
  function assertCurrentOwnerRun(params: TaskTarget, ownerRunId: TraceId | undefined): void {
    if (!ownerRunId) {
      return;
    }
    const key = taskKey(params);
    const activeRunId = activePromptInputIds.get(key);
    if (!activeRunId) {
      // 手机端 owner command 到达 host 时，task 可能已经终态收口。
      // 没有 active run 时不能再把旧 command 写入 host 队列，否则会在桌面 shared host 上误发旧输入。
      throw createTaskOwnerCommandError("No active task owner.", "NO_ACTIVE_TASK_OWNER");
    }
    if (activeRunId !== ownerRunId) {
      // ownerRunId 是远控请求的 stale 防护边界。
      // 旧 run 的 enqueue/promote 不能修改当前 task command queue。
      throw createTaskOwnerCommandError("Stale task owner command.", "STALE_TASK_OWNER_COMMAND");
    }
  }

  // 唯一写路径：所有「让 agent 说一句话」的入口最终都收敛到这里。
  // 进入即做四件事，顺序有约束：
  //   1) notifySyncerSession —— 先确保订阅存在，否则本轮事件可能丢首帧；
  //   2) clearLiveToolProjection / clearStreamingToolInputCache —— 清上一轮 live 残留；
  //   3) 记录 activePromptInputIds —— 建立本轮 owner 边界；
  //   4) 打开始日志 —— 日志含 workspaceKey 以便跨进程对账。
  // 为什么先清缓存再记 inputId：若先记再清，清理过程中的异常会让 task 处于「有 owner 无缓存」的半态。
  // 两条发送分支（附件走旧 sendPrompt、纯文本走 V4 sendText）见下方分别说明。
  // 失败语义：catch 中必须 delete activePromptInputIds 再 rethrow，否则一次 ACK 失败会锁死后续输入。
  async function sendPromptToAgent(
    target: TaskTarget,
    params: {
      traceId: TraceId;
      queryId?: string;
      messageId?: string;
      content: string;
      attachments?: ZCodePromptAttachment[];
      toolDenylist?: string[];
      botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
      clientId?: string;
      clientMode?: ZCodeTaskClientMode;
      logReason?: string;
      modelSelection?: CommandPayloadMap["sendText"]["modelSelection"];
      modelExecution?: CommandPayloadMap["sendText"]["modelExecution"];
    } & ZCodeBackgroundTurnAttribution,
  ): Promise<void> {
    // startedAt 只用于日志耗时；不进协议、不参与幂等判断。
    const startedAt = Date.now();
    notifySyncerSession(target);
    // live 工具镜像只服务于「当前运行轮」的终态收口：清掉上一轮仅 live 存在的子工具，
    // 否则本轮 snapshot 会把旧工具补到新回复尾部，UI 出现「历史工具挂在新消息下」。
    // live tool projection 只用于当前运行的终态收口。
    // 新输入开始时必须清掉上一轮 live-only 子工具，避免后续 snapshot 把旧工具补到新回复尾部。
    clearLiveToolProjection(target);
    clearStreamingToolInputCache(target);
    // 字段名 traceId 是旧协议遗留，语义已经是单次输入的 inputId：
    // 记录后，CLI 回投的终态事件（inputId）才能按轮次收口，避免多轮共用 taskId 时错配。
    // ZCode task wrapper 的字段仍叫 traceId，但这里语义已经是单次输入 inputId。
    // 先记录 inputId，后续 ZCode session 事件回投 ZCode Agent 时才能让 UI 终态按输入轮次收口。
    activePromptInputIds.set(taskKey(target), params.traceId);
    logger.info(params.traceId, "ZCode task facade sendPrompt 开始", {
      attachmentCount: params.attachments?.length ?? 0,
      queryId: params.queryId ?? null,
      reason: params.logReason ?? "direct",
      taskId: target.taskId,
      textLength: params.content.length,
      workspaceIdentity: target.workspaceIdentity ?? null,
      workspaceKey: resolveWorkspaceKey(target),
      workspacePath: target.workspacePath,
    });
    // 从这里开始进入「已建立 owner」的临界区：所有失败都必须走 catch 清理。
    try {
      // 黑名单只在本轮计算一次并复用：两份分支（附件/文本）若各算一次，
      // 未来任一处漏改就会让某个分支的自动化工具权限失效。
      const promptToolDenylist = resolvePromptToolDenylist(params);
      // 附件分支保留旧 session/send：V4 sendText 的 attachments 是 attachmentRef 引用模型，
      // 上传/寄存命令面尚未建模。若强行切 V4，手机 replayable 图片/文件输入会回归（发不出附件）。
      if (params.attachments?.length) {
        // 遗留（附件命令面）：v4 sendText 的 attachments 是 attachmentRef 引用模型，
        // 上传/寄存命令面尚未建模（CLI 侧 fork-edit-retry.ts 同款裁决“附件命令面后续”）。
        // 带附件输入保留旧 session/send，避免手机 replayable 图片/文件输入回归；
        // 过渡归宿 = v4 附件命令面（届时由 v4 sendText 承接）。
        await options.zcodeAgentService.sendPrompt({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
          sessionId: target.taskId,
          inputId: params.traceId,
          queryId: params.queryId,
          messageId: params.messageId,
          content: params.content,
          attachments: params.attachments.map((attachment) => ({
            ...attachment,
          })),
          // 附件回退只改变载荷传输，不得丢掉本次已解析的模型或执行范围。
          modelSelection: params.modelSelection,
          modelExecution: params.modelExecution,
          ...turnAttributionOf(params),
          toolDenylist: promptToolDenylist,
          botDeliveryTarget: params.botDeliveryTarget,
          ...(params.clientMode ? { clientMode: params.clientMode } : {}),
        });
      } else {
        // 主路径：无附件输入一律走 V4 sendText，旧 session/send 只作为附件兜底。
        // 幂等键对齐：commandId = traceId(=本次 inputId)。CLI 侧以 commandId 作为 inputId 起 turn，
        // 终态事件回来的 inputId 才能与 host runtime command 的 traceId 对上（completeRuntimeCommandByInputId）。
        // 若这里另生成 commandId，终态永远收不到口，pendingCommands 会永久残留一条 running。
        // heldQueueDisposition=keepQueueAndSend：旧 send 没有 held choice 闸门，
        // 按「立即发送、不动队列」才是与旧语义等价的映射（换成 enqueue 会把输入挂起）。
        // modelSelection/modelExecution/turnAttribution 都做稀疏展开：不传字段 = 不覆盖 session 现值。
        // clientId 保留提交端身份，供 CLI 侧 pendingCommands 展示与幂等表按提交端区分。
        // send 主路径收敛 v4 sendText。幂等键 inputId→commandId 对齐：
        // CLI 侧以 commandId 为 inputId 起 turn，终态事件 inputId 才能与 host command
        // queue 的 traceId 对账（completeRuntimeCommandByInputId 语义不变）。
        // heldQueueDisposition=keepQueueAndSend：旧 session/send 没有 held choice 闸门，
        // replayable 无人机交互路径按“立即发送、不动队列”等价老语义。
        const ack = await options.zcodeAgentService.sendConversationCommandV4({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
          ...(params.clientMode ? { clientMode: params.clientMode } : {}),
          envelope: createHostCommandEnvelope({
            type: "sendText",
            payload: {
              text: params.content,
              heldQueueDisposition: "keepQueueAndSend",
              ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
              ...(params.modelExecution ? { modelExecution: params.modelExecution } : {}),
              ...turnAttributionOf(params),
              ...(params.botDeliveryTarget ? { botDeliveryTarget: params.botDeliveryTarget } : {}),
              ...(promptToolDenylist ? { toolDisallowlist: promptToolDenylist } : {}),
            },
            sessionId: target.taskId,
            commandId: params.traceId,
            clientId: params.clientId,
          }),
        });
        // ACK 必须断言：非 ok 的 ACK 说明 CLI 拒绝了命令（revision 冲突、命令非法等），
        // 此时若继续返回成功，UI 会显示「已发送」但后端没有 turn，属于最难排查的一类不一致（INV-05）。
        // 断言抛出进入下方 catch，会清掉本轮 owner，下一次输入仍可正常发起。
        assertV4CommandAckOk("sendText", ack, `session=${target.taskId}`);
      }
      logger.info(params.traceId, "ZCode task facade sendPrompt ACK", {
        durationMs: Date.now() - startedAt,
        queryId: params.queryId ?? null,
        reason: params.logReason ?? "direct",
        taskId: target.taskId,
        workspaceIdentity: target.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(target),
        workspacePath: target.workspacePath,
      });
    // [失败路径] 无论哪种失败（ACK 否定、网络、超时），第一件事是删除本轮 owner 标记。
    // 遗漏这一步的后果：task 永久停留在「已有 active run」，drain 永远早退，后续所有输入静默不发送。
    // 日志用 warn 而不是 error：单次发送失败可由用户重试恢复，不属于进程级不可恢复错误。
    // 错误原样 rethrow，保留底层 code：调用方（UI/远端）需要据此区分可重试与不可重试。
    // 注意：这里不清理 runtimeCommands，失败的那条命令保留为 failed 状态，供手机端看到失败原因。
    } catch (error) {
      activePromptInputIds.delete(taskKey(target));
      logger.warn(params.traceId, "ZCode task facade sendPrompt 失败", {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        queryId: params.queryId ?? null,
        reason: params.logReason ?? "direct",
        taskId: target.taskId,
        workspaceIdentity: target.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(target),
        workspacePath: target.workspacePath,
      });
      throw error;
    }
  }

  // 写 runtimeCommands 的唯一入口。空数组即删除键，避免「存在但为空」的残留状态：
  // 残留会让 has/get 判断与 UI 的 pendingCommands 长度出现「键存在但无内容」的不一致。
  function setRuntimeCommands(params: TaskTarget, commands: ZCodeTaskRuntimeCommand[]): void {
    const key = taskKey(params);
    if (commands.length === 0) {
      runtimeCommands.delete(key);
      return;
    }
    runtimeCommands.set(key, commands);
  }

  // 把命令标记为 running 并返回新对象：数组按 commandId 原位替换，不改变顺序。
  // 为什么返回字面量而不是让调用方再查一次：drain 需要拿到 running 版本继续发送，
  // 若重新从 Map 取，中间可能有并发替换，拿到的是别的对象。
  function markRuntimeCommandRunning(
    params: TaskTarget,
    command: ZCodeSendPromptRuntimeCommand,
  ): ZCodeSendPromptRuntimeCommand {
    const key = taskKey(params);
    const runningCommand: ZCodeSendPromptRuntimeCommand = {
      ...command,
      status: "running",
      updatedAt: Date.now(),
    };
    runtimeCommands.set(
      key,
      (runtimeCommands.get(key) ?? []).map((item) =>
        item.commandId === command.commandId ? runningCommand : item,
      ),
    );
    return runningCommand;
  }

  // 失败标记保留在数组中（而不是删除）：手机端刷新时仍要看到「这条命令失败了」，
  // 删除会让失败凭空消失，用户以为消息丢了。真正移除只发生在终态收口。
  function markRuntimeCommandFailed(
    params: TaskTarget,
    command: ZCodeSendPromptRuntimeCommand,
    error: unknown,
  ): void {
    const key = taskKey(params);
    const failedCommand: ZCodeSendPromptRuntimeCommand = {
      ...command,
      status: "failed",
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    };
    runtimeCommands.set(
      key,
      (runtimeCommands.get(key) ?? []).map((item) =>
        item.commandId === command.commandId ? failedCommand : item,
      ),
    );
  }

  // 删除单条命令：filter 后走 setRuntimeCommands，从而复用「空数组自动删键」的语义。
  // 该函数是「从未被接受或被终态消费」的唯一出口，不改变其余命令状态。
  function removeRuntimeCommand(params: TaskTarget, commandId: string): void {
    setRuntimeCommands(
      params,
      (runtimeCommands.get(taskKey(params)) ?? []).filter(
        (command) => command.commandId !== commandId,
      ),
    );
  }

  // 通知 UI 刷新快照：reason 固定 task_status_changed（命令队列变化属于任务状态变化），
  // traceId 缺省时生成一个，而不是复用旧 traceId——否则 UI 侧按 traceId 去重会丢掉这次刷新。
  function emitRuntimeCommandSnapshotUpdated(params: TaskTarget, traceId?: TraceId): void {
    emitTaskEvent(params, {
      type: "task_snapshot_updated",
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      workspaceKey: workspaceKey(params),
      taskId: params.taskId,
      traceId: traceId ?? generateTraceId(params.taskId),
      reason: "task_status_changed",
    });
  }

  // 终态收口：只处理「running 状态的 send_prompt 且 traceId 等于终态 inputId」的命令。
  // 三个条件缺一不可：不看状态会把已 failed 的命令再删一次（幂等但无意义）；
  // 不看 traceId 会把别的轮次从队列里删掉，导致那一轮的 pendingCommands 消失。
  // 找不到命令时静默返回：同一终态事件可能重复投递（replay、重连），重复收口必须幂等。
  function completeRuntimeCommandByInputId(
    params: TaskTarget,
    terminalInputId: string | undefined,
    terminalType: string,
  ): void {
    if (!terminalInputId) {
      return;
    }
    const command = (runtimeCommands.get(taskKey(params)) ?? []).find(
      (candidate) =>
        candidate.type === "send_prompt" &&
        // ACK 之后仍保持 running 是刻意的：手机刷新需要看到「已开始发送」的 pendingCommands。
        // 只有真实终态（task_complete/task_error/cancel）到达才从 host 队列移除。
        candidate.status === "running" &&
        candidate.traceId === terminalInputId,
    );
    if (!command) {
      return;
    }
    // 注释即契约：这里说的是「终态才移除」，所以上面的 find 只匹配 running，
    // 任何在 ACK 处提前删除的改动都会破坏手机端待发送列表。
    // 手机 host command 在 sendPrompt ACK 后仍要保持 running，
    // 否则手机刷新拿不到“已开始发送”的 pendingCommands。只有真实终态到达后才能从 host 队列移除。
    removeRuntimeCommand(params, command.commandId);
    logger.info(command.traceId, "ZCode task command 终态收口", {
      commandId: command.commandId,
      terminalType,
      taskId: params.taskId,
      workspaceIdentity: params.workspaceIdentity ?? null,
      workspaceKey: resolveWorkspaceKey(params),
      workspacePath: params.workspacePath,
    });
  }

  // 终态事件的 inputId 优先于 traceId：新协议用 inputId 精确标识一轮，traceId 只是旧字段兜底。
  // 顺序反过来（先 traceId）会在多轮场景下把旧轮的 traceId 与新轮终态匹配上，删错命令。
  function completeRuntimeCommandForTerminalEvent(
    params: TaskTarget,
    event: ZCodeTerminalStreamEvent,
  ): void {
    completeRuntimeCommandByInputId(params, event.inputId ?? event.traceId, event.type);
  }

  // 串行 drain：每 task 最多同时发一条命令，条件按代价从低到高排列。
  //   1) 已有 active run → 直接返回（本轮正在跑，不能并发起 turn）；
  //   2) 已有 running 命令 → 返回（等它终态）；
  //   3) 取第一条 accepted → 发送。
  // 为什么必须先 markRunning 再 await sendPrompt：await 期间可能有第二个 drain 进入，
  // 先落状态能把并发挡在条件 2；不先落状态会发出两条 turn，用户消息重复。
  // 本函数不抛错：内部 catch 后只标记 failed，避免 drain 链断掉导致后续命令永久卡住。
  // 返回后队列可能仍有 accepted 命令，需要调用方（终态事件/调度器）再次触发 drain。
  async function drainRuntimeCommands(params: TaskTarget, reason: string): Promise<void> {
    const key = taskKey(params);
    if (activePromptInputIds.has(key)) {
      return;
    }
    const commands = runtimeCommands.get(key) ?? [];
    if (commands.some((command) => command.status === "running")) {
      return;
    }
    const command = commands.find(
      (candidate): candidate is ZCodeSendPromptRuntimeCommand =>
        candidate.type === "send_prompt" && candidate.status === "accepted",
    );
    if (!command) {
      return;
    }

    // 先标记再发送：把「正在发送」这个中间态写进 UI 可见的队列，
    // 否则用户在 ACK 前看到的状态会从 accepted 直接跳 completed，中间态缺失。
    const runningCommand = markRuntimeCommandRunning(params, command);
    logger.info(runningCommand.traceId, "ZCode task command drain 开始", {
      commandId: runningCommand.commandId,
      queryId: runningCommand.queryId ?? null,
      reason,
      taskId: params.taskId,
      workspaceIdentity: params.workspaceIdentity ?? null,
      workspaceKey: resolveWorkspaceKey(params),
      workspacePath: params.workspacePath,
    });
    try {
      await sendPromptToAgent(params, {
        traceId: runningCommand.traceId,
        queryId: runningCommand.queryId,
        messageId: runningCommand.commandId,
        content: runningCommand.content,
        attachments: runningCommand.attachments,
        ...turnAttributionOf(
          runningCommand.automationId ? { automationId: runningCommand.automationId } : {},
        ),
        // v4 sendText 信封保留手机提交端 clientId（pendingCommands 展示与幂等表按提交端区分）。
        clientId: runningCommand.clientId,
        logReason: "host-command-drain",
      });
    // 失败只标记不抛出：drain 是后台调度，抛出会变成未处理的 Promise 拒绝；
    // 标记 failed 同时保留错误文本，UI 能展示原因，用户可重试。
    } catch (error) {
      markRuntimeCommandFailed(params, runningCommand, error);
      logger.warn(runningCommand.traceId, "ZCode task command drain 失败", {
        commandId: runningCommand.commandId,
        error: error instanceof Error ? error.message : String(error),
        reason,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
    }
  }

  // drainRuntimeCommandsSafely 只多做一件事：吞掉调度层异常并记 warn。
  // 区分层次的意义：drainRuntimeCommands 内部已处理「发送失败」，
  // 这里兜的是「调度本身出错」（例如 task 已被删除导致 getTaskTarget 抛错）。
  async function drainRuntimeCommandsSafely(params: TaskTarget, reason: string): Promise<void> {
    try {
      await drainRuntimeCommands(params, reason);
    } catch (error) {
      logger.warn(undefined, "ZCode task command drain 调度失败", {
        error: error instanceof Error ? error.message : String(error),
        reason,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
    }
  }

  // 按 taskKey 串行化 drain：若已有 drain 在跑，就把新的 drain 挂在它后面（链式 finally），
  // 而不是并行启动。并行启动会让两条命令同时通过「无 running」检查（TOCTOU），
  // 结果是同一 task 上出现两个 turn（INV-01 被破坏的典型表现）。
  // 链式实现要点：新的 Promise 必须在旧 Promise settle 之后才开始，
  // 且只有「当前 Map 里仍是自己」时才删除键（身份比较），否则会误删后来者。
  // [权衡] 用 Promise 链而不是队列+worker：无需管理 worker 生命周期与 dispose，
  // 代价是每个 task 每次触发都会多一层 Promise 包装；在命令频率下可忽略。
  // 调度失败不会向上传播（drainRuntimeCommandsSafely 已兜底），因此这里不需要 catch。
  function scheduleRuntimeCommandDrain(params: TaskTarget, reason: string): void {
    const key = taskKey(params);
    const existingDrain = runtimeCommandDrains.get(key);
    if (existingDrain) {
      const nextDrainPromise = existingDrain
        .finally(() => drainRuntimeCommandsSafely(params, reason))
        .finally(() => {
          if (runtimeCommandDrains.get(key) === nextDrainPromise) {
            runtimeCommandDrains.delete(key);
          }
        });
      runtimeCommandDrains.set(key, nextDrainPromise);
      return;
    }
    const drainPromise = (async () => {
      await drainRuntimeCommandsSafely(params, reason);
    })().finally(() => {
      if (runtimeCommandDrains.get(key) === drainPromise) {
        runtimeCommandDrains.delete(key);
      }
    });
    runtimeCommandDrains.set(key, drainPromise);
  }

  // 取（或创建）某 task 的 live 工具镜像。外层超限时按 Map 插入顺序淘汰最旧 task：
  // 这里淘汰的是「整个 task 的镜像」，粒度粗但实现简单，且极端数量下优先保住活跃任务。
  // [权衡] 这不是 LRU：读取/更新不会刷新插入顺序，一个持续更新但很早创建的 task
  // 仍会被淘汰。可接受的原因是 live 镜像只是终态 snapshot 的补充，丢了只会少显示子工具。
  function getLiveToolProjectionMap(params: TaskTarget): Map<string, LiveToolProjection> {
    const key = taskKey(params);
    let projection = liveToolProjectionsByTaskKey.get(key);
    if (!projection) {
      projection = new Map<string, LiveToolProjection>();
      liveToolProjectionsByTaskKey.set(key, projection);
      // while 而不是 if：一次插入可能因并发降级导致落后多个（例如批量恢复时连续创建），
      // 循环收敛到上限，避免一次只淘汰一个导致长期超限。
      while (liveToolProjectionsByTaskKey.size > MAX_LIVE_TOOL_PROJECTION_TASKS) {
        const oldestKey = liveToolProjectionsByTaskKey.keys().next().value;
        if (typeof oldestKey !== "string") break;
        liveToolProjectionsByTaskKey.delete(oldestKey);
      }
    }
    return projection;
  }

  // 内层淘汰：每次工具更新后调用，超限时线性扫描找 order 最小者删除。
  // [权衡] 扫描是 O(n)，在上限 2000 且只在「超限」时触发，实际成本可控；
  // 用最小堆可以把淘汰降到 O(log n)，但要额外维护索引一致性，收益不划算。
  // order 由全局计数器产生，因此「最小 order」等价于「最早出现的工具」。
  function trimLiveToolProjectionMap(projection: Map<string, LiveToolProjection>): void {
    while (projection.size > MAX_LIVE_TOOL_PROJECTION_TOOLS_PER_TASK) {
      let oldestKey: string | undefined;
      let oldestOrder = Number.POSITIVE_INFINITY;
      for (const [toolId, item] of projection) {
        if (item.order < oldestOrder) {
          oldestOrder = item.order;
          oldestKey = toolId;
        }
      }
      if (!oldestKey) return;
      projection.delete(oldestKey);
    }
  }

  // 清空某 task 的 live 镜像：新输入开始/终态/删除 task 时调用，
  // 这是 INV-11 的释放点；漏调用会让旧工具持续被 merge 进新 snapshot。
  function clearLiveToolProjection(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): void {
    liveToolProjectionsByTaskKey.delete(taskKey(params));
  }

  // 归一 live 工具的 raw 载荷：不同来源（本地 CLI、远端 relay、旧版本）给的形状不一致，
  // 必须先统一，否则下游 persistedToolId 取不到 toolCallId，工具就会在合并时被当成新工具重复插入。
  // raw === undefined 时给 {}，其余非对象值包成 { raw }：保证结果始终是对象，
  // 避免把字符串展开进对象造成字符下标键（{0:'a',1:'b'...}）。
  // parentToolCallId 只在确实解析出父子关系时写入：写成 undefined 会让字段出现在 JSON 里，
  // 远端按「字段存在」判断父子归属，从而把顶层工具误挂到父工具下。
  function normalizeLiveToolRaw(
    raw: unknown,
    toolId: string,
    parentToolUseId: string | null | undefined,
  ): unknown {
    // raw 的形态由外部决定（可能是 string/number/null），asRecord 统一成对象视图，
    // 读字段一律走它而不是直接 `raw.parentToolUseId`，否则 string 上取属性会拿到 undefined 而不报错。
    const rawRecord = asRecord(raw);
    const rawBase =
      Object.keys(rawRecord).length > 0 ? rawRecord : raw === undefined ? {} : { raw };
    const parentFromRaw =
      stringValue(rawRecord.parentToolUseId) ??
      stringValue(rawRecord.parentToolCallId) ??
      parentToolUseId ??
      null;
    return {
      ...rawBase,
      toolCallId: stringValue(rawRecord.toolCallId) ?? toolId,
      ...(parentFromRaw
        ? {
            parentToolCallId: stringValue(rawRecord.parentToolCallId) ?? parentFromRaw,
          }
        : {}),
    };
  }

  // 只有四个终态可以落到 persisted 状态；running/pending 等过程态返回 undefined。
  // 区分「undefined = 沿用旧值」与「明确的状态值」是本函数的核心语义：
  // 如果给过程态返回旧值或 'running'，mergeLiveToolProjectionIntoSnapshotMessages 会把它当终态写进 snapshot。
  function persistedStatusFromToolUpdate(
    status: Extract<ZCodeStreamEvent, { type: "tool_call_update" }>["status"],
  ): ZCodePersistedToolCall["status"] | undefined {
    return status === "completed" ||
      status === "failed" ||
      status === "denied" ||
      status === "stopped"
      ? status
      : undefined;
  }

  // 把 tool_call/tool_call_update 合并成 live 镜像，键是 toolId。
  // 合并规则（与 822 行的分支一一对应）：
  //   - tool_call：携带完整定义（name/title/kind/input），出现时以它为准覆盖元数据；
  //   - tool_call_update：增量（output/error/status），缺字段时沿用已有值。
  // 两次事件可能乱序（update 先到），因此两个分支都先展开 existing?.tool 再覆盖，
  // 否则乱序时 update 会用一个只有 output 的对象覆盖掉 name/title，UI 显示「未知工具」。
  // order 只在首次出现时分配，保证同一工具在排序中位置稳定（后续 update 不改变顺序）。
  function rememberLiveToolProjection(params: TaskTarget, event: ZCodeStreamEvent): void {
    if (event.type !== "tool_call" && event.type !== "tool_call_update") {
      return;
    }

    // existing 既用于继承父归属，也用于 order 稳定性：先取投影 Map 的当前值，
    // 再与事件里的 parentToolUseId 做优先级判断（事件值 > 已记录值 > null）。
    const projection = getLiveToolProjectionMap(params);
    const existing = projection.get(event.toolId);
    const parentToolUseId = event.parentToolUseId ?? existing?.parentToolUseId ?? null;
    const raw = normalizeLiveToolRaw(event.raw, event.toolId, parentToolUseId);
    // 三元链的兜底顺序是「本次事件 > 已有镜像 > 事件里的另一个字段」：
    // title 兜 event.toolName 是为了老版本 CLI 不发 title 时 UI 至少显示工具名，
    // kind 再兜 existing.tool.toolName 是给「只有 tool_call 没有 kind」的老数据。
    // update 分支里 input/output 用 !== undefined 判断而不是 ??：null 是合法值（表示显式清空），
    // 用 ?? 会把 null 当成缺失，从而错误保留上一份大字段。
    const nextTool: ZCodePersistedToolCall =
      event.type === "tool_call"
        ? {
            ...existing?.tool,
            toolName: event.toolName ?? existing?.tool.toolName,
            title: event.title ?? existing?.tool.title ?? event.toolName,
            kind: event.kind ?? existing?.tool.kind ?? event.toolName,
            input: event.input,
            raw,
          }
        : {
            ...existing?.tool,
            toolName: event.toolName ?? existing?.tool.toolName,
            title: event.title ?? existing?.tool.title ?? event.toolName ?? event.kind,
            kind: event.kind ?? existing?.tool.kind ?? event.toolName ?? existing?.tool.toolName,
            input: event.input !== undefined ? event.input : existing?.tool.input,
            output: event.content !== undefined ? event.content : existing?.tool.output,
            error: event.error ?? existing?.tool.error,
            raw,
            status: persistedStatusFromToolUpdate(event.status) ?? existing?.tool.status,
          };
    // set 时重新构造对象（而非原地改 existing）：投影值会被下游快照读取，
    // 原地改会让「已经交给调用方的旧引用」也发生变化，破坏 diff/比较语义。
    // 随后立刻 trim，保证任何一次写入都不会让内层超出上限（INV-11）。
    projection.set(event.toolId, {
      order: existing?.order ?? ++liveToolProjectionOrder,
      parentToolUseId,
      tool: nextTool,
      toolId: event.toolId,
    });
    trimLiveToolProjectionMap(projection);
  }

  // 持久化工具没有独立 id 字段，id 只存在于 raw.toolCallId：
  // 因此所有「找工具」的逻辑都必须经过这里，禁止在别处假设 tool.id 存在。
  function persistedToolId(tool: ZCodePersistedToolCall): string | undefined {
    return stringValue(asRecord(tool.raw).toolCallId);
  }

  // raw 合并：snapshot 优先（终态事实源），但两个关键字段用 ?? 保证不丢。
  // 为什么不能简单 {...snapshot, ...live}：终态 snapshot 来自父 session 的 message parts，
  // 可能缺少 subagent 才有的 parentToolCallId/toolCallId，直接覆盖会让工具树塌平成顶层。
  // 为什么不能反过来 {...live, ...snapshot} 之外的字段也全用 snapshot：
  // live 侧可能带 snapshot 不含的诊断字段（耗时、协议原文），保留它们才能排查。
  // 空对象短路：一侧为空时直接返回另一侧，避免生成只含两个 undefined 键的对象。
  function mergeToolRaw(snapshotRaw: unknown, liveRaw: unknown): unknown {
    const snapshotRecord = asRecord(snapshotRaw);
    const liveRecord = asRecord(liveRaw);
    if (Object.keys(snapshotRecord).length === 0) {
      return liveRaw;
    }
    if (Object.keys(liveRecord).length === 0) {
      return snapshotRaw;
    }
    return {
      ...liveRecord,
      ...snapshotRecord,
      parentToolCallId:
        stringValue(snapshotRecord.parentToolCallId) ?? stringValue(liveRecord.parentToolCallId),
      toolCallId: stringValue(snapshotRecord.toolCallId) ?? stringValue(liveRecord.toolCallId),
    };
  }

  // 把 live 镜像与持久化工具合并成最终展示用工具。
  // 事实源优先序：snapshot 是终态事实（落库），live 只做补充。
  // 但每个字段都用「snapshot ?? live」而不是整体覆盖：
  // 终态 snapshot 可能没有 output（工具被截断）或没有 raw（旧数据），
  // 整体覆盖会让 task_complete 之后工具树丢失已显示的父子关系与大字段。
  // status 也用 ??：snapshot 的 status 为空表示「未记录」，不代表「未完成」。
  function mergePersistedToolCall(
    snapshotTool: ZCodePersistedToolCall | undefined,
    liveTool: ZCodePersistedToolCall,
  ): ZCodePersistedToolCall {
    if (!snapshotTool) {
      return liveTool;
    }
    return {
      ...liveTool,
      ...snapshotTool,
      // 终态 snapshot 来自父 session message parts，可能没有 live mirror 的
      // subagent parentToolCallId/raw/output。这里把 snapshot 作为终态事实源，同时保留
      // live 协议事件已经提供的父子归属和大字段，避免 task_complete 后工具树被覆盖丢失。
      input: snapshotTool.input ?? liveTool.input,
      output: snapshotTool.output ?? liveTool.output,
      raw: mergeToolRaw(snapshotTool.raw, liveTool.raw),
      error: snapshotTool.error ?? liveTool.error,
      status: snapshotTool.status ?? liveTool.status,
      snapshotRefs: snapshotTool.snapshotRefs ?? liveTool.snapshotRefs,
    };
  }

  // 线性扫描所有消息的工具列表定位 toolId：消息数在单 task 内有界（一轮几十条），
  // 建索引反而要在每次 snapshot 变更时维护，收益不成立。
  // 找不到返回 null 而不是抛错：live 工具可能属于尚未投影进 snapshot 的消息，属正常中间态。
  function findToolLocation(
    messages: readonly ZCodePersistedMessage[],
    toolId: string,
  ): { messageIndex: number; toolIndex: number } | null {
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex];
      if (!message?.tools) continue;
      const toolIndex = message.tools.findIndex((tool) => persistedToolId(tool) === toolId);
      if (toolIndex >= 0) {
        return { messageIndex, toolIndex };
      }
    }
    return null;
  }

  // 从后往前找最近一条 assistant 消息：live 工具无法确定父消息时就挂到这里。
  // 为什么必须从后往前：工具事件总是属于最近一次回复，从前往后会挂到历史回复上。
  function latestAssistantMessageIndex(messages: readonly ZCodePersistedMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") {
        return index;
      }
    }
    return -1;
  }

  // 为 assistant 消息补一个 tool-call part（幂等）：part 是 UI 渲染顺序的依据。
  // 先 some 再 push，避免同一 toolIndex 重复 part；重复会让 React 列表出现重复 key。
  // 返回新数组而不是 push 原数组：message.parts 可能被上一版 snapshot 共享引用。
  function upsertPersistedToolPart(
    parts: readonly ZCodePersistedMessagePart[] | undefined,
    toolIndex: number,
  ): ZCodePersistedMessagePart[] {
    if (parts?.some((part) => part.type === "tool-call" && part.toolIndex === toolIndex)) {
      return [...parts];
    }
    return [...(parts ?? []), { type: "tool-call", toolIndex }];
  }

  // 更新消息中某个下标的工具：先复制 tools 数组再替换，保持不可变。
  // 只有 assistant 消息才补 part：user/system 消息的 tools 属于历史遗留，
  // 补 part 会让它们出现在正文渲染里（用户消息的工具卡片）。
  function updateSnapshotMessageTool(
    message: ZCodePersistedMessage,
    toolIndex: number,
    tool: ZCodePersistedToolCall,
  ): ZCodePersistedMessage {
    const tools = [...(message.tools ?? [])];
    tools[toolIndex] = mergePersistedToolCall(tools[toolIndex], tool);
    return {
      ...message,
      tools,
      parts:
        message.role === "assistant"
          ? upsertPersistedToolPart(message.parts, toolIndex)
          : message.parts,
    };
  }

  // 追加工具到消息尾部，并以新下标补 part（与 update 分支共用 upsert，索引天然一致）。
  function appendSnapshotMessageTool(
    message: ZCodePersistedMessage,
    tool: ZCodePersistedToolCall,
  ): ZCodePersistedMessage {
    const tools = [...(message.tools ?? []), tool];
    const toolIndex = tools.length - 1;
    return {
      ...message,
      tools,
      parts:
        message.role === "assistant"
          ? upsertPersistedToolPart(message.parts, toolIndex)
          : message.parts,
    };
  }

  // 纯函数式地把 live 工具镜像合并进 snapshot 消息数组（不修改入参）。
  // 两条路径：
  //   A) toolId 已存在于 snapshot → 原地 update（mergePersistedToolCall）；
  //   B) 不存在 → 新工具，按 parentToolUseId 找父工具所在消息，找不到就挂最近 assistant。
  // B 的父消息查找是必要的：subagent 子工具必须跟在父工具同一条消息里，
  // 否则 UI 的工具树会把子工具渲染成顶层工具（层级错乱）。
  // 任何路径都没有可用消息时（例如 snapshot 只有 user 消息）直接跳过，不伪造消息。
  // 性能：每个 live 工具都重扫一次消息，live 工具上限 2000、消息数十级，
  // 最坏 O(tools×messages)，只在读取 snapshot 路径上发生，可接受。
  // changed 标志让无实际合并时返回原数组引用，供上层做引用相等判断以避免多余广播。
  // 日志用 debug：该路径与消息流同数量级（services/AGENTS.md 的日志分级要求）。
  function mergeLiveToolProjectionIntoSnapshotMessages(
    meta: ZCodeTaskMeta,
    messages: ZCodePersistedMessage[],
  ): ZCodePersistedMessage[] {
    const projection = liveToolProjectionsByTaskKey.get(taskKey(meta));
    if (!projection || projection.size === 0 || messages.length === 0) {
      return messages;
    }

    let nextMessages = messages;
    let changed = false;
    let mergedToolCount = 0;
    // 按 order 稳定排序：先出现的工具先合并，父工具因此通常先于子工具被写入 snapshot，
    // 从而 B 路径能用 findToolLocation 找到父消息。
    const liveTools = [...projection.values()].sort((a, b) => a.order - b.order);
    for (const liveTool of liveTools) {
      const existingLocation = findToolLocation(nextMessages, liveTool.toolId);
      if (existingLocation) {
        nextMessages = nextMessages.map((message, index) =>
          index === existingLocation.messageIndex
            ? updateSnapshotMessageTool(message, existingLocation.toolIndex, liveTool.tool)
            : message,
        );
        changed = true;
        mergedToolCount += 1;
        continue;
      }

      // 父工具可能不在 snapshot 里（live-only），此时退化为「最近 assistant 消息」，
      // 代价是层级丢失但内容仍在；比丢弃子工具更可取。
      const parentLocation = liveTool.parentToolUseId
        ? findToolLocation(nextMessages, liveTool.parentToolUseId)
        : null;
      const targetMessageIndex =
        parentLocation?.messageIndex ?? latestAssistantMessageIndex(nextMessages);
      if (targetMessageIndex < 0) {
        continue;
      }

      nextMessages = nextMessages.map((message, index) =>
        index === targetMessageIndex ? appendSnapshotMessageTool(message, liveTool.tool) : message,
      );
      changed = true;
      mergedToolCount += 1;
    }

    // 只在确实发生变化时打日志，避免空合并刷屏；mergedToolCount 用于判断是否异常偏低。
    if (changed) {
      logger.debug(undefined, "ZCode snapshot 合并 live tool projection", {
        event: "zcode_task.snapshot.live_tool_projection.merged",
        liveToolCount: liveTools.length,
        mergedToolCount,
        taskId: meta.taskId,
        workspaceIdentity: meta.workspaceIdentity,
        workspacePath: meta.workspacePath,
      });
    }
    return changed ? nextMessages : messages;
  }

  // 登记 task 身份（按 taskId，不带 workspace）：这是「最近一次已知的 target」，
  // 用于事件回投时反查 workspace，因此后写覆盖先写是正确语义。
  // 唯一例外是 cronAutomationId：它是 sticky 归属，恢复/事件入口常常不带该字段，
  // 若无条件覆盖会把归属清空，UI 的自动化标签就会消失（INV-09 的典型误用）。
  // 因此这里用 ?? existing 保留旧值；真正要清除归属只能走 rememberIndexedTaskMeta。
  function rememberTaskTarget(params: TaskTarget): void {
    const existing = taskTargets.get(params.taskId);
    taskTargets.set(params.taskId, {
      ...params,
      // cronAutomationId 是会话的 sticky 归属标记，供 UI 展示和任务关联使用，不参与当前
      // turn 的工具权限。resume/onDynamicTaskEvent 等入口不带值时仍需保留权威归属；明确设置
      // 或清除只能走 rememberIndexedTaskMeta。
      cronAutomationId: params.cronAutomationId ?? existing?.cronAutomationId,
    });
  }

  // 找不到 target 就抛带 code 的错误，不尝试用 taskId 现造一个：
  // 现造会丢掉 workspaceIdentity，后续所有命令都可能投递到同路径的另一个 workspace（INV-02）。
  // 调用方（事件处理）应把该错误视为「task 不存在/已删除」，而不是重试。
  function getTaskTarget(taskId: string): TaskTarget {
    const target = taskTargets.get(taskId);
    if (!target) {
      throw Object.assign(new Error(`ZCode session target is not loaded: ${taskId}`), {
        code: "ZCODE_SESSION_TARGET_NOT_FOUND",
      });
    }
    return target;
  }

  // tool projection memory 按 taskKey 懒创建，装着 streaming tool input 的分片累积。
  // 它是有状态的（deltas 追加），因此必须 per-task 隔离；跨 task 共用会让两个会话的
  // 同一 toolId 互相追加，预览文本串台。
  // 释放点是终态/删除 task；本文件没有全局上限，依赖「每个 task 终态必清」，
  // 若将来出现永不终态的 task，需要补与 live projection 同级的 task 数上限（INV-11）。
  function getToolProjectionMemory(params: TaskTarget): ZCodeToolProjectionMemory {
    const key = taskKey(params);
    let memory = toolProjectionMemoryByTaskKey.get(key);
    if (!memory) {
      memory = createZCodeToolProjectionMemory();
      toolProjectionMemoryByTaskKey.set(key, memory);
    }
    return memory;
  }

  // 新输入开始时只清内层 streaming 表、保留 memory 对象：
  // 整体 delete 会让下一轮重新分配并丢掉 memory 里的其他投影元数据（如已 materialize 标记）。
  // 用可选链是因为该 task 可能从未产生过工具事件，此时无需创建空对象。
  function clearStreamingToolInputCache(params: TaskTarget): void {
    toolProjectionMemoryByTaskKey.get(taskKey(params))?.streamingToolInputById?.clear();
  }

  // Bugfix: workspace emitter 已上提到 syncer，adapter 通过 syncer 获取共享 emitter，
  // 保证 task adapter 路径和 desktop-continuous 路径走同一份订阅，UI 不会漏事件。
  // workspace emitter 由 syncer 单点持有：adapter 只做转发，不自己 new。
  // 理由见文件底部与构造函数注释——两条路径必须共用一份订阅，否则 UI 收不全事件。
  function getWorkspaceEmitter(workspace: WorkspaceEventInput): Emitter<ZCodeWorkspaceEvent> {
    return taskIndexSyncer.getWorkspaceEmitter(workspace);
  }

  // task 级 emitter：key 为 (workspaceKey, taskId)，隔离不同 workspace 的同名 session。
  // 懒创建是因为绝大多数 task 从未被订阅；预先为所有 task 建 emitter 会白白持有闭包。
  // [资源] 该 Map 的条目在 deleteTask 时释放；未释放的 emitter 不会被 GC 回收，
  // 因为 Map 是长驻单例的一部分（内存诊断把它计入 taskEmitters）。
  function getTaskEmitter(params: TaskTarget): Emitter<ZCodeStreamEvent> {
    const key = taskKey(params);
    let emitter = taskEmitters.get(key);
    if (!emitter) {
      emitter = new Emitter<ZCodeStreamEvent>();
      taskEmitters.set(key, emitter);
    }
    return emitter;
  }

  // global emitter 只按 taskId：给「不知道/不关心 workspace」的订阅者（例如全局通知中心）。
  // 与 task 级 emitter 同时 fire，保证两类订阅者看到同一份事件序列。
  function getGlobalTaskEmitter(taskId: string): Emitter<ZCodeStreamEvent> {
    let emitter = globalTaskEmitters.get(taskId);
    if (!emitter) {
      emitter = new Emitter<ZCodeStreamEvent>();
      globalTaskEmitters.set(taskId, emitter);
    }
    return emitter;
  }

  // 统一的事件出口：先 fire task 级，再 fire global 级。
  // 顺序有意为之——task 级订阅者通常是详情页，对事件顺序更敏感；
  // 两级都 fire 而不是二选一，避免「详情页收到、列表页收不到」。
  // 注意此处没有 try/catch：订阅回调抛错会中断 global fire，因此订阅方必须自行保证不抛。
  function emitTaskEvent(params: TaskTarget, event: ZCodeStreamEvent): void {
    getTaskEmitter(params).fire(event);
    getGlobalTaskEmitter(params.taskId).fire(event);
  }

  // 委托到 syncer，让 archive/rename/pin/delete 等 task 元数据变更和
  // desktop-continuous 路径（turn.completed 等）走同一条广播通道。
  // 设计修正：reason 必填，发射点必须声明变更类别。
  // 任务列表变更必须走 syncer 广播：archive/rename/pin/delete 与 desktop-continuous 的
  // turn.completed 共用同一条通道，否则两条路径的刷新频率/去重规则会不一致。
  // reason 必填是设计约束：发射点必须声明变更类别，UI 才能决定是否重建列表。
  function emitWorkspaceTaskListChanged(
    params: {
      workspacePath: string;
      workspaceIdentity?: string;
      taskId?: string;
    },
    taskMeta: ZCodeTaskMeta | undefined,
    reason: ZCodeWorkspaceTaskListChanged["reason"],
  ) {
    taskIndexSyncer.emitWorkspaceTaskListChanged(params, taskMeta, reason);
  }

  // workspace 配置广播：把 session settings 转成 config options 后整体推送，
  // UI 侧据此重建模型/模式选择器；转换必须用 settingsToConfigOptions，
  // 手拼会让 picker 的值域与 CLI 的 allowed values 不一致。
  function emitWorkspaceConfig(
    params: ZCodeAgentWorkspaceTarget,
    settings: ZCodeSessionSettingsState,
  ) {
    getWorkspaceEmitter(params).fire({
      type: "workspace_config_options_update",
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      configOptions: settingsToConfigOptions(settings),
    });
  }

  // 恢复 session 快照（新链路主读路径）。
  // 先 rememberTaskTarget 再发请求：snapshot 回来之前可能已有事件到达，
  // 此时事件处理需要 target 才能算出 taskKey，登记晚了会「查不到 target」直接抛错。
  // thoughtLevel 先 trim 再判空，避免把纯空白串当合法配置下发。
  // 产品 MCP 解析放在请求前：它可能触发 IO，失败应让 resume 直接失败，
  // 而不是起一个缺少 MCP 的会话让用户以为工具丢了。
  // additionalDirectories 用 !== undefined 判断（空数组是合法的「显式清空」语义）。
  async function resumeSnapshot(
    params: TaskTargetWithMcpServers,
  ): Promise<ZCodeSessionStateSnapshot> {
    rememberTaskTarget(params);
    const thoughtLevel = params.thoughtLevel?.trim();
    const mcpServers = await resolveProductMcpServers(params.mcpServers);
    return options.zcodeAgentService.resumeSession({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      sessionId: params.taskId,
      ...(params.additionalDirectories !== undefined
        ? { additionalDirectories: params.additionalDirectories }
        : {}),
      // Bugfix: replayable 手机端恢复仍经 task adapter，但 stale model guard 在
      // session resume 内执行；这里带上当前 UI 模型，避免只保护 desktop continuous 主链路。
      // model 走 parseModelPickerValue 而不是原样透传：UI 存的 picker 值可能是编码串，
      // 直接下发给 CLI 会被当作未知模型；解析失败返回 undefined，等于不指定模型。
      model: params.model ? parseModelPickerValue(params.model) : undefined,
      ...(thoughtLevel ? { thoughtLevel } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(params.toolDenylist ? { toolDenylist: params.toolDenylist } : {}),
    });
  }

  /**
   * 会话级配置写（模型/思考深度/模式）的 v4 CAS 命令提交。
   * host 无本地 v4 投影，revision 用 stale ACK 的 revisionAtDecision 收敛（sendHostCasCommandV4）。
   * 注意与 compact/goal 标注同一坑位：旧协议 stateRevision 与 v4 conversation revision
   * 是两套计数器，这里全程只用 v4 ACK 回报的 revision，绝不混入旧 expectedRevision。
   */
  // 会话级配置写的 V4 CAS 封装：只负责把「发送能力」适配成 sendHostCasCommandV4 需要的形状。
  // revision 全部来自上一次 ACK 的 revisionAtDecision，Host 不维护本地 v4 投影（INV-01）。
  // 重要：旧协议的 stateRevision 与 v4 conversation revision 是两套计数器，
  // 混用会导致每次 CAS 都失败或错误覆盖，因此这里绝不接受外部 expectedRevision。
  async function sendConfigCasCommandV4<T extends "switchModelConfig" | "switchCollaborationMode">(
    target: TaskTarget,
    type: T,
    payload: CommandPayloadMap[T],
    contextMessage: string,
  ): Promise<void> {
    await sendHostCasCommandV4({
      send: (envelope) =>
        options.zcodeAgentService.sendConversationCommandV4({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          envelope,
        }),
      type,
      payload,
      sessionId: target.taskId,
      contextMessage,
    });
  }

  /**
   * session/setMode → v4 switchCollaborationMode。
   * auto 例外保真：v4 命令值域刻意排除 auto（「auto 非用户可切，不进 UI 命令面」，
   * command.ts 裁决），而旧协议 ZCodeSessionMode 含 auto 且旧 op 接受它——为 UI 行为
   * 零变化，auto 继续走旧 op，其余值一律 v4 原生。过渡归宿 = auto 语义在 v4 侧裁决后收口。
   */
  // 模式切换的协议分流：auto 是唯一例外，继续走旧 setMode。
  // 原因：v4 switchCollaborationMode 的值域刻意排除 auto（auto 不是用户可切模式，不进 UI 命令面），
  // 而旧协议 ZCodeSessionMode 含 auto 且旧 op 接受；若不特殊处理，选 auto 会直接 CAS 失败。
  // 其余值一律走 v4 原生，保证 revision 语义统一（旧 op 不参与 v4 revision 推进）。
  async function switchCollaborationModeViaProtocol(
    target: TaskTarget,
    mode: ZCodeSessionMode,
  ): Promise<void> {
    if (mode === "auto") {
      await options.zcodeAgentService.setMode({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: target.taskId,
        mode,
      });
      return;
    }
    await sendConfigCasCommandV4(
      target,
      "switchCollaborationMode",
      { mode },
      `session=${target.taskId} mode=${mode}`,
    );
  }

  // 修复 Claude 导入产生的空快照：导入链路只写入了 legacy 文件，session 侧可能没有历史，
  // repair 会按来源（claude 原生 jsonl 或 legacy task 文件）回填消息。
  // 修复成功后必须重跑 index 同步并把 migrationSource 写回 presentation：
  // 否则任务列表里该会话仍显示为「未迁移」，下次打开又会走一次修复。
  // repaired 为空表示「无需修复」，此时原样返回，避免无谓的 index 写与广播。
  // onRepair 用 warn：这是数据异常后的自动恢复，需要留痕但不属于不可恢复错误。
  async function repairEmptyImportedClaudeSnapshot(
    params: TaskTargetWithMcpServers,
    snapshot: ZCodeSessionStateSnapshot,
  ): Promise<ZCodeSessionStateSnapshot> {
    const repaired = await repairImportedClaudeSessionSnapshot({
      snapshot,
      target: params,
      createSession: (input) => options.zcodeAgentService.createSession(input),
      onRepair: (history) => {
        logger.warn(
          undefined,
          `Claude 导入 protocol session 历史异常，按 ${history.source} 回填 taskId=${params.taskId}`,
        );
      },
    });
    if (!repaired) {
      return snapshot;
    }
    const meta = await syncTaskIndexSnapshot(repaired);
    await updateIndexedPresentation({ ...meta, migrationSource: "claudeCode" });
    return repaired;
  }

  // 唯一一处用 message 文本判断错误的地方，因此必须把匹配面收窄到历史的固定前缀。
  // 为什么不能拿到 code：旧 session op 的错误没有稳定 code，只有文本；
  // 而这条判断只用于「是否降级到 legacy 只读」，误判的最坏后果是多读一次本地文件，
  // 不会造成写副作用，所以这里接受文本匹配（对 INV-05 的显式例外）。
  function isSessionMissingError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /\bSession (not found|is not active):/i.test(message);
  }

  // 读取旧 task 快照（只读）：这是 INV-08 中「旧端仍可能只有 legacy 数据」的兜底读路径。
  // 两个路径都探测：在态路径 + 已删除路径，因为回收站视图仍要能看到已删任务的内容。
  // 两者都不存在 → 返回 null（让调用方决定抛什么错），而不是抛「文件不存在」：
  // 调用方需要保留原始的 Session not found 作为最终错误，否则错误归因会被替换成文件系统错误。
  // 解析用 safeParseLegacyTaskSessionFile（schema 校验）：文件可能被旧版本写坏，
  // 非法数据只 warn 并返回 null，绝不把半解析对象当事实源投影出去。
  // 补齐策略（INV-09 的核心）：
  //   - taskId/workspacePath/workspaceIdentity 以调用参数为准（旧文件可能根本没写 identity）；
  //   - title/updatedAt 以 tasks-index 优先（用户改名/归档后 index 才是权威）；
  //   - mode/provider/status 以 legacy 文件优先，缺失时再取 index，最后才用默认值。
  // 为什么不统一用默认值兜住：旧数据没有 status 与「新链路未写入 status」含义不同，
  // 前者可补 completed，后者若补 completed 会让运行中的 task 提前显示完成。
  // 读取成功后登记 legacySnapshotTaskKeys，后续读路径据此判断该 task 不能按 session 语义操作。
  async function readLegacyTaskSnapshot(params: TaskTarget): Promise<ZCodeTaskSnapshot | null> {
    const paths = [
      getLegacyTaskSessionSnapshotPath(
        params.workspacePath,
        params.taskId,
        params.workspaceIdentity,
      ),
      getLegacyDeletedTaskSessionSnapshotPath(
        params.workspacePath,
        params.taskId,
        params.workspaceIdentity,
      ),
    ];
    const snapshotPath = paths.find((path) => existsSync(path));
    if (!snapshotPath) {
      return null;
    }

    try {
      const rawSnapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as unknown;
      const parsed = safeParseLegacyTaskSessionFile(rawSnapshot);
      if (!parsed.success) {
        logger.warn(
          undefined,
          `读取 legacy task snapshot 非法 taskId=${params.taskId}`,
          parsed.error.flatten(),
        );
        return null;
      }

      // legacyFile 已经是 schema 校验过的结构，后续只做字段级覆盖，不再二次解析。
      const legacyFile = parsed.data;
      const indexedMeta = await taskIndexRepo.getTaskMeta(params).catch(() => null);
      // index meta 读取失败按 null 处理：index 只是补位来源，缺失不应让整条旧数据读不出来。
      // 注意这里先展开 legacyFile.meta 再逐字段覆盖：旧的扩展字段（如 traceId、createdAt）必须保留，
      // 如果只挑几个字段重建，legacy 侧独有的信息会在投影时静默丢失。
      const legacyMeta: ZCodeTaskMeta = {
        ...legacyFile.meta,
        // Bugfix: 旧 ACP task 只落在 ~/.zcode/v2/sessions/*.json，没有写入
        // zcode-cli 的 sqlite session 表。新协议 resume 会把 taskId 当 sessionId
        // 直接报 Session not found；这里按旧快照恢复只读历史内容，并用 task index
        // 补齐用户改名、归档状态和终态 status，避免把旧 task 误当成可订阅的新 session。
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity ?? legacyFile.meta.workspaceIdentity,
        title: indexedMeta?.title ?? legacyFile.meta.title,
        updatedAt: indexedMeta?.updatedAt ?? legacyFile.meta.updatedAt,
        mode: legacyFile.meta.mode ?? indexedMeta?.mode ?? "default",
        provider: legacyFile.meta.provider ?? indexedMeta?.provider ?? GLM_PROVIDER,
        status: legacyFile.meta.status ?? indexedMeta?.status ?? "completed",
        lastError: legacyFile.meta.lastError ?? indexedMeta?.lastError,
      };
      // 组装旧 task snapshot：messages/tools 直接沿用 legacy 文件，runtime 则从 live Map join。
      // 为什么 runtime 要 join：旧文件只存历史，不含本轮 apiRetry/pendingCommands，
      // 不 join 的话，恢复出来的旧 task 永远看不到「重试中/待发送」状态。
      // meta 再叠一层 index 的 title/unreadAt：unread 属于组织态（INV-10），只有 index 有。
      const snapshot: ZCodeTaskSnapshot = {
        ...legacyFile,
        meta: {
          ...legacyMeta,
          ...(indexedMeta ? { title: indexedMeta.title, unreadAt: indexedMeta.unreadAt } : {}),
        },
        runtime: {
          apiRetry: apiRetryByTaskKey.get(taskKey(params)) ?? null,
          pendingCommands: runtimeCommands.get(taskKey(params)) ?? [],
        },
      };
      // 登记两个副作用：标记 legacy 来源 + 刷新 target 的权威归属；
      // 顺序不能反——rememberIndexedTaskMeta 依赖已存在的 target 做合并。
      legacySnapshotTaskKeys.add(taskKey(params));
      rememberIndexedTaskMeta(snapshot.meta);
      return snapshot;
    // [失败路径] 读文件/解析/index 任一环节异常都降级为 null，只记 warn。
    // 理由：这条路径本身是兜底，兜底失败不应改变调用方原本要抛的错误语义。
    } catch (error) {
      logger.warn(undefined, `读取 legacy task snapshot 失败 taskId=${params.taskId}`, error);
      return null;
    }
  }

  // 三态读路径：session（新链路）/ legacy（只读旧数据）/ 抛原错。
  // 判定顺序固定，不能并行猜：先按新链路 resume，只有明确「session 不存在」才降级，
  // 因为 session 存在时 legacy 文件可能是过期副本，用旧副本会覆盖新状态（INV-09）。
  // 三态的意义在于「降级是一次性的、可观测的」：返回 kind 让上层知道当前是只读恢复，
  // 从而禁止发送/订阅等写操作，而不是靠再查一次 legacySnapshotTaskKeys 猜。
  // 注意 session 分支会先做 Claude 空快照修复，保证返回给上层的 snapshot 已经可投影。
  async function resumeSnapshotOrLegacy(
    params: TaskTargetWithMcpServers,
  ): Promise<
    | { kind: "session"; snapshot: ZCodeSessionStateSnapshot }
    | { kind: "legacy"; snapshot: ZCodeTaskSnapshot }
  > {
    // resumeSnapshot 内部已 rememberTaskTarget，因此失败时 target 仍在表里；
    // 这不算泄漏（后续 legacy 分支还要用它），且 task 数有界。
    try {
      const snapshot = await resumeSnapshot(params);
      return {
        kind: "session",
        snapshot: await repairEmptyImportedClaudeSnapshot(params, snapshot),
      };
    // 只对 Session not found 降级：超时、鉴权、协议错都必须原样抛出。
    // 反例：若把所有错误都当「旧任务」降级，一次 CLI 重启期间的临时失败会让 task
    // 永久钉在只读模式，用户再也发不出消息。
    } catch (error) {
      if (!isSessionMissingError(error)) {
        throw error;
      }
      const legacySnapshot = await readLegacyTaskSnapshot(params);
      if (!legacySnapshot) {
        throw error;
      }
      // Claude 导入的 legacy task 可以「升级」成真正的 ZCode session：这类数据有完整历史，
      // createSession + importedHistory 能把历史写进 CLI，之后就走新链路。
      // persistence=immediate：导入是用户可见的一次性动作，必须立刻落盘，
      // 否则 Host 重启后升级结果丢失，用户又要重新导入。
      // sessionTraceId 复用 legacy traceId（缺失才新建）：升级重试时保持同一条链路身份。
      // 升级成功后同样要 sync index + 写 migrationSource，让列表知道它已可写。
      if (legacySnapshot.meta.migrationSource === "claudeCode") {
        try {
          const mcpServers = await resolveProductMcpServers(params.mcpServers);
          const snapshot = await options.zcodeAgentService.createSession({
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
            sessionId: params.taskId,
            sessionTraceId: legacySnapshot.meta.traceId ?? createSessionTraceId(),
            persistence: "immediate",
            model: params.model ? parseModelPickerValue(params.model) : undefined,
            ...(mcpServers ? { mcpServers } : {}),
            ...(params.toolDenylist ? { toolDenylist: params.toolDenylist } : {}),
            importedHistory: {
              source: "claudeCode",
              title: legacySnapshot.meta.title,
              createdAt: legacySnapshot.meta.createdAt,
              updatedAt: legacySnapshot.meta.updatedAt,
              messages: legacySnapshot.messages.map((message) => ({
                role: message.role,
                content: message.content,
                timestamp: message.timestamp,
              })),
            },
          });
          const meta = await syncTaskIndexSnapshot(snapshot);
          await updateIndexedPresentation({ ...meta, migrationSource: "claudeCode" });
          logger.info(
            undefined,
            `legacy Claude 导入 task 已升级为 ZCode session taskId=${params.taskId}`,
          );
          return { kind: "session", snapshot };
        // 升级失败只 warn 并继续走只读恢复：导入数据存在但 CLI 拒绝创建时，
        // 用户至少还能看到历史，比整条读路径失败更有用。
        } catch (upgradeError) {
          logger.warn(
            undefined,
            `legacy Claude 导入 task 升级为 ZCode session 失败，继续只读恢复 taskId=${params.taskId}`,
            upgradeError,
          );
        }
      }
      logger.warn(
        undefined,
        `ZCode Protocol session 缺失，已按 legacy task snapshot 恢复 taskId=${params.taskId}`,
        error,
      );
      return { kind: "legacy", snapshot: legacySnapshot };
    }
  }

  // session snapshot → 旧 task meta 的投影（纯映射 + 一个副作用）。
  // 输入：CLI 已发布的 ZCodeSessionStateSnapshot；输出：IZCodeTaskService 需要的 ZCodeTaskMeta。
  // 副作用：rememberTaskTarget 登记 target，使后续事件能找到 workspace。
  // 口径：所有派生字段都调用 @zcode/shared 的共享函数（标题、状态、模型），
  // 本函数不自行实现优先级规则，否则详情页与任务列表会给出不同状态。
  // traceId 缺失时生成一个但不写回 snapshot：这里只保证 meta 可展示，不改事实源（INV-01）。
  // provider 固定 GLM_PROVIDER：它不是执行者，只是历史 UI 分组字段（见 238 行）。
  // 任何人想在这里加「读本地 Map 兜底字段」都必须先确认不会与 index 冲突（INV-10）。
  function snapshotToMeta(snapshot: ZCodeSessionStateSnapshot): ZCodeTaskMeta {
    const target = {
      taskId: snapshot.session.sessionId,
      workspacePath: snapshot.session.workspace.workspacePath,
      workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
    };
    rememberTaskTarget(target);
    // 字段级口径：taskId=sessionId（同义转换）；mode 走 fromZCodeMode 收敛旧枚举；
    // model 走 formatTaskMetaModelSelectionFromSnapshot，保证与 picker 值同源。
    // thoughtLevel 取 settings 的 current（当前生效值），不是 draft：
    // draft 是用户正在编辑但未提交的偏好，写进 task meta 会让列表显示未提交配置。
    return {
      taskId: snapshot.session.sessionId,
      traceId: snapshot.session.traceId ?? generateTraceId(snapshot.session.sessionId),
      title: deriveTitleFromSnapshot(snapshot),
      workspacePath: snapshot.session.workspace.workspacePath,
      workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
      createdAt: snapshot.session.createdAt,
      updatedAt: snapshot.session.updatedAt,
      mode: fromZCodeMode(snapshot.session.mode),
      model: formatTaskMetaModelSelectionFromSnapshot(snapshot),
      thoughtLevel: snapshot.settings.thoughtLevel.current,
      provider: GLM_PROVIDER,
      // 状态必须由 deriveZCodeTaskStatusFromSessionSnapshot 统一推导：
      // 它考虑 projection 终态、错误、是否在跑等条件；在这里手写 if 链会出现
      // 「CLI 认为完成、Host 认为失败」这类不可对账的分歧。
      status: deriveZCodeTaskStatusFromSessionSnapshot(snapshot),
      lastError: snapshot.projection.lastError
        ? {
            code: snapshot.projection.lastError.code ?? snapshot.projection.lastError.type,
            ...(snapshot.projection.lastError.detail
              ? { detail: snapshot.projection.lastError.detail }
              : {}),
            // 修复原因：service snapshot 是 mobile replayable/cold task meta 的来源，不能
            // 让它与 UI 直接投影的 lastError 产生归因漂移。
            ...(snapshot.projection.lastError.attribution
              ? { attribution: snapshot.projection.lastError.attribution }
              : {}),
            message: snapshot.projection.lastError.message,
          }
        : undefined,
      // target（goal 校验时间线）做类型转换而不是直接透传：旧协议与 projection 的结构不同，
      // fromZCodeGoal 负责字段对齐；转换结果为 undefined 时保留 undefined，
      // 不要用 {} 顶替——空对象会被 UI 当成「有目标」，渲染出空的目标面板。
      target: snapshot.projection.target
        ? fromZCodeGoal(snapshot.projection.target)
        : snapshot.projection.target,
    };
  }

  // 写 target 的「权威归属」通道，语义与 rememberTaskTarget 相反：
  // index meta 是唯一可以设置/清除 cronAutomationId 的来源，因此这里直接以 meta 为准覆盖，
  // 不走 ?? existing 的保留逻辑。
  // 为什么需要两条通道：恢复/事件入口拿不到归属信息（必须保留旧值），
  // 而 index 更新是用户显式解绑自动化后的结果（必须能真正清空）。
  // 同时刷新 workspacePath/Identity：task 迁移到另一个 workspace 后，旧 target 会让命令发错地方（INV-02）。
  function rememberIndexedTaskMeta(meta: ZCodeTaskMeta): ZCodeTaskMeta {
    const existing = taskTargets.get(meta.taskId);
    // 权威归属刷新：index meta 是唯一可以设置/清除 cronAutomationId 的来源，直接以 meta 为准
    // 写入（绕过 rememberTaskTarget 的 merge-preserve），以便解绑/删除 automation 后能真正清空。
    taskTargets.set(meta.taskId, {
      ...existing,
      taskId: meta.taskId,
      workspacePath: meta.workspacePath,
      workspaceIdentity: meta.workspaceIdentity,
      cronAutomationId: meta.cronAutomationId,
    });
    return meta;
  }

  // 从 tasks-index 读取 resume hint（model/thoughtLevel）：旧协议把「该 session 上次用的配置」
  // 存在 task meta 里，新链路 resume 不接收这些字段时必须由本层补上。
  // 读取失败降级为「不带 hint 恢复」，只 warn：hint 缺失只会回落到 workspace 默认值，
  // 而让 resume 整体失败则是完全不可用，两者代价差一个量级。
  // reason 参数仅用于日志区分调用来源（replayable_snapshot / resume_task）。
  // 返回值做稀疏展开：不传字段 = 不改 session 现值，传 undefined 会显式清空。
  async function resolveTaskIndexResumeHints(
    params: TaskTarget,
    reason: "replayable_snapshot" | "resume_task",
  ): Promise<{ model?: string; thoughtLevel?: string }> {
    const meta = await taskIndexRepo.getTaskMeta(params).catch((error) => {
      logger.warn(undefined, "读取 task index resume hint 失败，继续不带历史配置恢复", {
        error: error instanceof Error ? error.message : String(error),
        reason,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return null;
    });
    // trim 后判空：index 里的历史值可能是空白串（早期写入未校验），
    // 空白串下发会被 CLI 当成合法模型名而报 unknown model。
    const model = meta?.model?.trim();
    const thoughtLevel = meta?.thoughtLevel?.trim();
    if (model || thoughtLevel) {
      // task-local thoughtLevel 和 model 一样属于历史 session 恢复 hint。
      // 不回填 thoughtLevel 时，同 workspace 的 draft 默认值会在 session/resume 后覆盖 active task。
      logger.info(undefined, "从 task index 回填 ZCode session resume 配置", {
        model: model || null,
        thoughtLevel: thoughtLevel || null,
        reason,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
    }
    return {
      ...(model ? { model } : {}),
      ...(thoughtLevel ? { thoughtLevel } : {}),
    };
  }

  // 把 meta 中的「展示相关字段」白名单式写回 index 的 presentation 列。
  // 为什么必须白名单：meta 里还有 messages、tools、标题等大字段，
  // 整份写进 presentation 会让 index 行体积随会话增长，且这些字段另有归属（INV-10）。
  // filter(value !== undefined) 而不是 ?? 默认值：undefined 表示「本次不改」，
  // 写 null 会把已有展示信息抹掉，两者语义必须分开（INV-09）。
  // 写入后统一走 rememberIndexedTaskMeta，保证内存 target 与落库值一致。
  async function updateIndexedPresentation(meta: ZCodeTaskMeta): Promise<ZCodeTaskMeta> {
    const {
      mode,
      model,
      thoughtLevel,
      lastError,
      target,
      migrationSource,
      cronAutomationId,
      offPeakTaskId,
    } = meta;
    // Object.fromEntries 保留字段顺序，便于日志/diff 时肉眼对比；
    // 如果 index 返回空（更新未命中），回落到入参 meta，避免向上返回 undefined 造成调用方崩溃。
    const presentation = Object.fromEntries(
      Object.entries({
        mode,
        model,
        thoughtLevel,
        lastError,
        target,
        migrationSource,
        cronAutomationId,
        offPeakTaskId,
      }).filter(([, value]) => value !== undefined),
    );
    const indexedMeta = await taskIndexRepo.updateTaskPresentation({ ...meta, presentation });
    return rememberIndexedTaskMeta(indexedMeta ?? meta);
  }

  // snapshot → index 的同步入口：先判会话种类，再交给 syncer 做原子合并 + 广播。
  // 辅助会话（bot topic / subagent 等）不写入任务列表：它们不是用户可见的 task，
  // 写进去会让任务列表被内部会话污染，且这些会话通常没有稳定的用户命名。
  // broadcastReason 允许传 null 表示「只落库不广播」，用于批量恢复时避免事件风暴。
  async function syncTaskIndexSnapshot(
    snapshot: ZCodeSessionStateSnapshot,
    broadcastReason: ZCodeWorkspaceTaskListChanged["reason"] | null = "task_status_changed",
  ): Promise<ZCodeTaskMeta> {
    // 辅助会话直接走投影（不落 index、不广播）：返回值仍需满足调用方对 meta 的预期，
    // 因此用 snapshotToMeta 而不是返回 undefined。
    if (isAuxiliarySessionKind(snapshot.session.sessionKind)) return snapshotToMeta(snapshot);
    return rememberIndexedTaskMeta(
      await taskIndexSyncer.syncSnapshotAndBroadcast(snapshot, {
        broadcastReason,
      }),
    );
  }

  // task 行组织态（pin/archive/unread）的唯一写入入口：参数直接转交 tasks-index repo，
  // 适配层不缓存、不合并、不乐观改写结果。INV-10 要求行集合与组织态只有 tasks-index
  // 一个事实源；若在这里再维护一份 meta 副本，pin 与未读水位会在旧/新链路间分叉，
  // 且写入失败时无法判断哪一份才是权威。
  async function updateIndexedTaskState(
    params: TaskTarget,
    patch: { pinned?: boolean; archived?: boolean; unreadAt?: number },
  ): Promise<ZCodeTaskMeta> {
    // 只传 workspace 三元组 + patch，不带 snapshot 派生字段：组织态写入与正文投影解耦。
    // reject 直接上抛给 setTaskPinned/setTaskUnread 等调用方，由它们决定是否广播。
    return taskIndexRepo.updateTaskState({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      taskId: params.taskId,
      patch,
    });
  }

  // 把 stream 事件里的 apiRetry 归约成 task 级缓存，供后续快照（含冷恢复首屏）回填。
  // 只认 session_info_update 的显式 apiRetry 与 turn 终态清空；中间态工具事件不得改写，
  // 否则重试横幅会在一次普通 tool_call_update 之后被抹掉。
  // [权衡] 这是进程内派生缓存而非 conversation 事实（INV-01），丢失只影响首屏的一次提示，
  // 因此不落盘、不做跨进程同步。
  function updateTaskApiRetryFromStreamEvent(params: TaskTarget, event: ZCodeStreamEvent): void {
    const key = taskKey(params);
    // apiRetry 是可选字段：undefined 表示“本次事件未携带”，不能当成“无重试”清空旧值。
    // 显式 null 才是“重试已结束”。
    if (event.type === "session_info_update" && event.apiRetry !== undefined) {
      apiRetryByTaskKey.set(key, event.apiRetry ?? null);
      return;
    }
    // 终态无条件清空：回合结束后仍保留 retry 状态，会让下一次 snapshot 挂着过期横幅。
    if (event.type === "task_complete" || event.type === "task_error") {
      apiRetryByTaskKey.set(key, null);
    }
  }

  // 供 mapSessionEvent 判断“当前是否处于 API 重试中”，同步读缓存、无副作用。
  // 用 != null 而非真值判断：缓存里的 null（已知无重试）与 undefined（从未观察）
  // 对 UI 走同一分支，只有对象状态才算“正在重试”。
  function hasActiveTaskApiRetry(params: TaskTarget): boolean {
    return apiRetryByTaskKey.get(taskKey(params)) != null;
  }

  // 纯投影：把 CLI 的 ZCodeSessionStateSnapshot 压成旧 task 面的 ZCodeTaskSnapshot。
  // 输入是某一时刻的完整快照，输出只做字段重排与切片；唯一的副作用是刷新
  // backgroundTaskControlsByTaskKey 这个派生缓存，不写 DB、不发命令。
  // 顺序敏感：先算 goal 轮次 → 再 map 消息 → 再补 fork/verifier 分隔线 → 最后合并 live tool。
  // 反过来写，补进去的 synthetic 消息拿不到 goalIteration，或 live 工具会挂到错误的回复上。
  // 维护 INV-01（正文以 snapshot 为准）与 INV-09（缺字段不等于默认值）。
  function snapshotToZCode(
    snapshot: ZCodeSessionStateSnapshot,
    // includeEmptyPendingElicitations 只给 replayable 首屏用：空数组本身是“输入队列已清空”
    // 的语义信号；desktop-continuous 省略该字段则保持旧投影形状不变。
    options?: { includeEmptyPendingElicitations?: boolean },
  ): ZCodeTaskSnapshot {
    const meta = snapshotToMeta(snapshot);
    // meta 由 snapshotToMeta 派生，它会同时 rememberTaskTarget；后续所有按 taskKey 查缓存的
    // 步骤都依赖这次登记。goal 轮次上限取“仍在进行的验证轮次”，避免历史 timeline 把轮次号推高。
    const activeGoalIterationCount = getSnapshotGoalActiveIterationCount(snapshot);
    // 轮次映射只对 assistant 生效，并被 activeGoalIterationCount 截断：
    // 冷恢复时 timeline 可能长于 messages，未截断会把旧轮次错贴到当前回复上。
    const goalIterationByAssistantMessageId = getZCodeGoalIterationByAssistantMessageId(
      snapshot.messages,
      {
        ...(activeGoalIterationCount > 0 ? { maxGoalIteration: activeGoalIterationCount } : {}),
        target: snapshot.projection.target,
      },
    );
    // 后台任务通知按 toolUseId 建索引：父消息里的工具调用要靠它把“后台任务完成/失败”
    // 挂回对应 toolCall，而不是新增一条孤立消息。
    const backgroundTaskNotifications = collectZCodeBackgroundTaskNotificationsByToolUseId(
      snapshot.messages,
    );
    // 消息管线由内到外的顺序即语义：
    //   getZCodeUserVisibleMessages（滤掉 hidden/系统消息）
    //   → coalesceConsecutiveZCodeAssistants（合并连续 assistant）
    //   → addSessionForkSnapshotFallback（补 fork 分割线）
    //   → addGoalVerificationTimelineSnapshotFallback（补 verifier 分割线）
    //   → normalizeGoalVerificationTimelineMessageOrder（按 anchor 重排已有分割线）
    const messages = mergeLiveToolProjectionIntoSnapshotMessages(
      meta,
      normalizeGoalVerificationTimelineMessageOrder(
        // [权衡] 每一步都返回新数组而不是原地改：snapshot.messages 属于 CLI 投影缓存，
        // 原地改会把派生结果写回上游，下一次快照出现重复 appended 工具。
        addGoalVerificationTimelineSnapshotFallback(
          addSessionForkSnapshotFallback(
            // map 必须在 coalesce 之前：goalIterationByAssistantMessageId 以原始 messageId 为键，
            // 先合并会改写 messageId/mergedMessageIds，查表将命中不到轮次。
            coalesceConsecutiveZCodeAssistants(
              getZCodeUserVisibleMessages(snapshot.messages, {
                target: snapshot.projection.target,
              }).map((message) =>
                mapMessage(
                  message,
                  message.info.role === "assistant"
                    ? goalIterationByAssistantMessageId.get(message.info.messageId)
                    : undefined,
                  backgroundTaskNotifications,
                ),
              ),
            ),
            // fork fallback 只依赖 session.parentSessionId，与消息内容无关；
            // 传入 snapshot 仅用于取 createdAt 作为分割线时间戳。
            snapshot,
          ),
          // verifier fallback 读 runtime.goalVerificationTimeline：这是持久投影，不保证有对应消息，
          // 冷恢复必须由快照补齐，否则验证记录整段丢失。
          snapshot,
        ),
      ),
    );
    // pending 权限按“是否由 user-input 工具承载”二分：AskUserQuestion/ExitPlanMode 在旧 task 面上
    // 归为 elicitation，其余才是 permission_request。两侧同源于 projection.pendingPermissions，
    // 保证同一 requestId 不会同时出现在两类事件里。
    const pendingPermissions: ZCodePermissionRequest[] = snapshot.projection.pendingPermissions
      .filter((permission) => !isUserInputBackedPermissionToolName(permission.toolName))
      .map((permission) => pendingPermissionToStreamEvent(snapshot.session.sessionId, permission));
    // elicitation 侧可能返回 null（例如 AskUserQuestion 未带 questions），
    // 用类型守卫过滤而不是断言，避免把 null 塞进 stream 事件数组。
    const pendingElicitations = snapshot.projection.pendingPermissions
      .filter((permission) => isUserInputBackedPermissionToolName(permission.toolName))
      .map((permission) =>
        pendingUserInputBackedPermissionToElicitationEvent(snapshot.session.sessionId, permission),
      )
      .filter(
        (event): event is Extract<ZCodeStreamEvent, { type: "elicitation_request" }> =>
          event !== null,
      );
    // 后台任务控件取自 projection.backgroundJobs：它是 CLI 归约后的可操作集合，
    // 不是本层从事件流拼出来的，因此直接映射、无需去重。
    const backgroundTaskControls = parseZCodeBackgroundTaskControlItems(
      snapshot.projection.backgroundJobs,
    );
    // [资源] 先写 taskKey(meta) 再返回：冷恢复路径不经过 mapServiceEvent，
    // 这里不写，首屏就拿不到 backgroundBashJobs。按 task 覆盖，本层不设上限。
    setTaskBackgroundTaskControlCache(
      backgroundTaskControlsByTaskKey,
      taskKey(meta),
      backgroundTaskControls,
    );
    // 输出是旧 task 协议形状：除 messages/fileChanges/configOptions 外的 runtime 字段
    // 都是派生视图，调用方不得回写（回写会变成第二份会话状态，违反 INV-01）。
    return {
      meta,
      messages,
      // fileChanges 恒为空数组：ZCode session 快照不携带 diff 事实，本链路也不从工具结果反推。
      // [权衡] 不用 undefined 是因为旧 UI 直接读 fileChanges.length；空数组表示“本链路不提供”。
      fileChanges: [],
      configOptions: settingsToConfigOptions(snapshot.settings),
      // agent 协议 snapshot 含有 `/compact` 等命令；task facade 投影时必须保留，
      // 否则 replayable/legacy task restore 会把 UI 的 slashCommands 回填成空。
      // 用 ?? 而非 ||：CLI 明确给出空数组时保留该引用，避免每次投影新建数组导致引用比较失效。
      slashCommands: snapshot.slashCommands ?? EMPTY_SLASH_COMMANDS,
      runtime: {
        activeTurnKind: snapshot.runtime.activeTurnKind,
        // apiRetry 来自进程内缓存：snapshot.runtime 不携带该状态，冷恢复首屏靠它保真。
        apiRetry: apiRetryByTaskKey.get(taskKey(meta)) ?? null,
        // contextUsage 三级回退：runtime 实时值 → projection 归约值 → undefined。
        // 回退到 undefined 而不是 0，否则 UI 会把“未知”画成“空上下文”。
        contextUsage:
          contextUsageFromRuntime(snapshot.runtime.contextUsage) ??
          contextUsageFromProjection(snapshot.projection) ??
          undefined,
        pendingPermissions,
        backgroundBashJobs: backgroundTaskControls,
        // 手机 replayable 快照需要用空数组表达“用户输入队列已清空”。
        // desktop-continuous 主链路仍保持原投影形态，避免把 replayable 的集合恢复语义扩散过去。
        ...(pendingElicitations.length > 0 || options?.includeEmptyPendingElicitations
          ? { pendingElicitations }
          : {}),
        // pendingCommands 是 host runtime command queue 的只读视图（手机队列的事实源在 host）；
        // 这里直接引用数组，调用方不得原地修改。
        pendingCommands: runtimeCommands.get(taskKey(meta)) ?? [],
        // todo 的权威数据在 agent DB；历史恢复时必须随 snapshot 映射给 UI，
        // 不能只依赖 renderer 运行期收到过的 plan stream event。
        // todo 只投影成线性 plan steps，与下面的 todoGroups 分开：前者是旧 UI 的计划区，
        // 后者保留 goal 分组；两者同源于 snapshot，不能互相推导。
        plan: sessionTodosToPlanSteps(snapshot.todos),
        // goal 相关字段缺省为 null 而不是 []：旧 UI 用 null 表示“该会话没有 goal”，
        // [] 会被当成“有 goal 但内容为空”，正是 INV-09 要避免的默认值混淆。
        goalStats: sessionGoalStatsToRuntime(snapshot.goalStats),
        goalVerifications: snapshot.runtime.goalVerifications ?? null,
        goalVerificationTimeline: snapshot.runtime.goalVerificationTimeline ?? null,
        todoGroups: sessionTodoGroupsToRuntime(snapshot.todoGroups),
      },
    };
  }

  // ZCodeAgentServiceEvent → 旧 task stream 事件的分发器。
  // 只有 session.event 会落到下面的通用映射；snapshot/state.updated/permission/userInput 是
  // 协议层的独立事件类型，各有固定出站形状，混进通用映射会产生重复事件。
  // 副作用：snapshot 分支异步同步 task index 并广播列表/配置变更，其余分支只 fire emitter。
  function mapServiceEvent(params: TaskTarget, event: ZCodeAgentServiceEvent): void {
    // snapshot 是“对账”而非“增量”：先异步写 index，再广播 task_snapshot_updated 让 UI 重读。
    // [失败路径] 同步失败只 warn 不抛出——事件流不能因索引写失败而中断；
    // 广播照常发出，UI 下一次快照会自然收敛。
    if (event.type === "snapshot") {
      void syncTaskIndexSnapshot(event.snapshot).catch((error) => {
        logger.warn(undefined, "同步 ZCode snapshot 到 task index 失败", error);
      });
      // 事件体只带定位信息，不带快照正文：旧协议约定 UI 收到后按 taskId 重新拉取，
      // 避免把整份 messages 塞进广播通道并被多订阅者放大。
      const snapshotEvent: ZCodeStreamEvent = {
        type: "task_snapshot_updated",
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        workspaceKey: workspaceKey(params),
        taskId: params.taskId,
        traceId: generateTraceId(params.taskId),
      };
      emitTaskEvent(params, snapshotEvent);
      // workspace 配置跟随快照广播：模型/模式/思考档位是 workspace 级 UI 状态，
      // 漏发会让切换任务后配置面板停留在旧会话的值。
      emitWorkspaceConfig(params, event.snapshot.settings);
      return;
    }

    // state.updated 是 settings patch 通知，可能含多个字段，mapStateUpdated 返回 0..n 个事件；
    // 空数组表示 patch 未通过 schema 校验。这里静默丢弃而不抛错：
    // 坏 patch 不能打断订阅，否则一次脏数据会让后续所有事件收不到。
    if (event.type === "state.updated") {
      for (const streamEvent of mapStateUpdated(params, event.notification)) {
        emitTaskEvent(params, streamEvent);
      }
      return;
    }

    // permission.request 只转发，不写 pending 表：pending 的权威在 CLI projection，
    // 本层任何“记住待办”都会在应答后留下无法清理的副本（INV-01）。
    if (event.type === "permission.request") {
      emitTaskEvent(params, permissionRequestToStreamEvent(params.taskId, event.request));
      return;
    }

    // userInput.request/response 是 elicitation 的双向事件；response 在本端主动应答后
    // 仍需回投，供其它 observer 清理同一 requestId 的弹窗。
    if (event.type === "userInput.request") {
      emitTaskEvent(params, userInputRequestToElicitationStreamEvent(params.taskId, event.request));
      return;
    }

    if (event.type === "userInput.response") {
      emitTaskEvent(
        params,
        userInputResponseToElicitationStreamEvent(params.taskId, event.requestId, event.response),
      );
      return;
    }

    // providerRuntimeHeaders.request 在 task 面没有消费者：它是 host 与 CLI 之间的
    // 凭据协商事件，转发给 UI 会泄漏 provider 头字段，因此显式吞掉。
    // 注意这里必须 return，不能落到下面的公共投影段。
    if (event.type === "providerRuntimeHeaders.request") {
      return;
    }

    // session.event 是唯一进入通用映射的分支，处理完不 return，继续走下面的公共段。
    if (event.type === "session.event") {
      // 网络遥测先记录再映射：即使后续映射抛错，provider 网络事实也已采集。
      recordAgentModelNetworkTelemetry(event.event);
      if (event.event.type === "turn.started") {
        const payload = asRecord(event.event.payload);
        const inputId = stringValue(payload.inputId);
        // 覆盖写入而不是合并：同一 task 的新 turn 必然接管上一轮，旧 inputId 留在缓存里
        // 会让终态收口命中已结束的轮次。
        if (inputId) {
          // remote/replayable/fallback 订阅不一定由 sendPrompt 建立。
          // turn.started 是后续 model.streaming 事件归属当前输入的协议事实，必须在 services 投影层同步记录。
          activePromptInputIds.set(taskKey(params), inputId);
        }
      }
    }

    // 循环前先取出 activePromptInputId：映射内部需要它归置流式片段，
    // 而循环里可能因终态把该 input 删除，循环后再读会得到 undefined。
    // 传的是取值快照而不是惰性读取，保证同一批事件归属一致。
    const activePromptInputId = activePromptInputIds.get(taskKey(params));
    const streamEvents = mapSessionEvent(
      params,
      event.event,
      streamedTurnText,
      activePromptInputId,
      // 传缓存引用而不是拷贝：live tool projection 在映射内部按 toolId 增量更新，
      // 拷贝会让本轮新增工具在下一事件中丢失。
      getToolProjectionMemory(params),
      backgroundTaskControlsByTaskKey,
      // hasActiveTaskApiRetry 在此求值一次：它只影响终态事件的可重试标记，
      // 同一批事件处理期间不会变化。
      hasActiveTaskApiRetry(params),
    );
    // 每个事件三件事的顺序有依赖：
    // 1) rememberLiveToolProjection 先登记本次工具，2) 归约 apiRetry，3) 广播；
    // 若先广播后登记，慢消费者触发的新 snapshot 会缺本轮工具。
    // [资源] 终态必须 completeRuntimeCommand：手机队列在 ACK 后仍保持 running，
    // 只有真实终态才允许移除，否则刷新拿不到“已开始发送”的 pendingCommands，
    // 并且 running 项会长期驻留在进程级 Map 里（INV-11 要求的释放点）。
    for (const streamEvent of streamEvents) {
      rememberLiveToolProjection(params, streamEvent);
      updateTaskApiRetryFromStreamEvent(params, streamEvent);
      emitTaskEvent(params, streamEvent);
      if (streamEvent.type === "task_complete" || streamEvent.type === "task_error") {
        completeRuntimeCommandForTerminalEvent(params, streamEvent);
      }
    }
    // 只有 turn 级终态才删 inputId：单个 task_complete/task_error 可能来自子代理或后台任务，
    // 不代表主回合结束；提前删除会让主回合后续事件失去归属。
    if (event.event.type === "turn.completed" || event.event.type === "turn.failed") {
      activePromptInputIds.delete(taskKey(params));
    }
  }

  // [资源] 适配层销毁标志：两个 syncer 回调都经 queueMicrotask 延迟执行，
  // 销毁与回调入队可能交错，回调必须再检查一次，否则 dispose 之后仍会写 runtimeCommands。
  // 重复 dispose 的幂等由各 disposable 自身保证（INV-12）。
  let disposed = false;

  // 处理 v4 sessions-index 的 phase → 终态迁移。摘要事件不携带 inputId（字段被裁掉），
  // 只能用 host 本地记录的 active input 收口；找不到本地记录说明不是本端发起的轮次，
  // 直接返回，避免误删 desktop-continuous 链路的队列项。
  function handleTaskIndexTerminalEvent(event: ZCodeTaskIndexTerminalEvent): void {
    const params: TaskTarget = {
      taskId: event.target.sessionId,
      workspacePath: event.target.workspacePath,
      workspaceIdentity: event.target.workspaceIdentity,
    };
    const key = taskKey(params);
    // 两个条件都不成立说明该 task 在本 adapter 没有待收口状态：complete/delete
    // 都是空操作，提前返回省掉一次日志与 Map 查找。
    if (!activePromptInputIds.has(key) && !runtimeCommands.has(key)) {
      return;
    }
    // 不推进队列：下一条 accepted 命令必须等 ready 事件才 drain，
    // 否则会撞上尚未释放的 active lock 并被 busy 拒绝。
    // 终态事件源换成 v4 sessions-index 的 phase 迁移，摘要不携带 inputId，
    // 一律用本地记录的 active input 收口（旧协议 payload.inputId 缺失时的兜底路径，语义不变）。
    const terminalInputId = activePromptInputIds.get(key);
    completeRuntimeCommandByInputId(params, terminalInputId, event.kind);
    // turn 终态只说明 stream 收口已到，不代表 agent server 的 active lock 已释放。
    // 这里仅收口当前 input；下一条 host command 必须等 ready 事件触发。
    activePromptInputIds.delete(key);
  }

  // [资源] 订阅持有 disposable，disposeLocalTaskState 必须释放。
  // 用 queueMicrotask 而非同步调用：syncer 可能在写事务过程中 fire，
  // 同步回调里再写同一 index 会重入 BEGIN IMMEDIATE 并报错。
  const taskIndexTerminalDisposable = taskIndexSyncer.onSessionTerminalEvent((event) => {
    queueMicrotask(() => {
      if (!disposed) {
        handleTaskIndexTerminalEvent(event);
      }
    });
  });

  // ready = agent server 已释放 activeAbortController（prompt_completed/prompt_failed 之后）。
  // 与 terminal 分开处理的原因：terminal 只保证 stream 收口，ready 才允许发下一条命令；
  // 合并两者会让手机队列在 agent lock 仍被持有时 drain，产生稳定 busy 拒绝。
  function handleTaskIndexReadyEvent(event: ZCodeTaskIndexReadyEvent): void {
    const params: TaskTarget = {
      taskId: event.target.sessionId,
      workspacePath: event.target.workspacePath,
      workspaceIdentity: event.target.workspaceIdentity,
    };
    const key = taskKey(params);
    // 无本地 active input 也无队列时直接返回：ready 也会广播给非本端发起的会话，
    // 这里没有需要推进的状态。
    if (!activePromptInputIds.has(key) && !runtimeCommands.has(key)) {
      return;
    }
    const activeInputId = activePromptInputIds.get(key);
    // 用 activeInputId 收口“已 running”的命令；若 ACK 丢失导致队列里仍是 accepted，
    // 该调用是空操作，命令由后面的 scheduleRuntimeCommandDrain 继续推进。
    completeRuntimeCommandByInputId(params, activeInputId, event.reason);
    // prompt_completed/prompt_failed 由 agent server 在释放 activeAbortController 后发出。
    // 手机 host command queue 以它作为“下一条可以发送”的 ready 边界，避免 fixed delay 重试，
    // 也不改变桌面 continuous 的 renderer-local queue。
    activePromptInputIds.delete(key);
    // 先删 inputId 再 drain：drainRuntimeCommands 以 activePromptInputIds 为空为前提，
    // 顺序反过来会永远看不到可发送状态。
    scheduleRuntimeCommandDrain(params, "session-ready");
  }

  // ready 订阅同样经 microtask 隔离，并在销毁后短路，理由同 terminal 订阅。
  const taskIndexReadyDisposable = taskIndexSyncer.onSessionReadyEvent((event) => {
    queueMicrotask(() => {
      if (!disposed) {
        handleTaskIndexReadyEvent(event);
      }
    });
  });

  // [资源] 本地状态释放，顺序不可交换：
  // 1) 先断订阅，防止释放过程中再有回调入队；
  // 2) 再关 index repo（其内部写队列与 DB 句柄）；
  // 3) 最后销毁 emitter 并清空按 taskKey 的调度/流式缓存。
  // [权衡] 这里没清 activePromptInputIds/apiRetryByTaskKey/backgroundTaskControlsByTaskKey：
  // 它们是纯派生缓存，随 adapter 闭包一起被 GC；加清理只拉长销毁路径，不改变正确性。
  function disposeLocalTaskState(): void {
    taskIndexTerminalDisposable.dispose();
    taskIndexReadyDisposable.dispose();
    taskIndexRepo.close();
    for (const emitter of taskEmitters.values()) emitter.dispose();
    for (const emitter of globalTaskEmitters.values()) emitter.dispose();
    errorEmitter.dispose();
    taskEmitters.clear();
    globalTaskEmitters.clear();
    runtimeCommandDrains.clear();
    streamedTurnText.clear();
  }

  // 优先走 disposeAllAndWait：RPC 关闭需要等待在途命令落盘。
  // [失败路径] 旧 service 没有该方法时退化为同步 disposeAll，
  // 调用方只能保证“已发起”，拿不到“已结束”的信号。
  async function disposeZCodeAgentServiceAndWait(): Promise<void> {
    const agentService = options.zcodeAgentService as IZCodeAgentService & {
      disposeAllAndWait?: () => Promise<void>;
    };
    if (agentService.disposeAllAndWait) {
      await agentService.disposeAllAndWait();
      return;
    }
    // 兼容旧实现：disposeAll 是同步签名，返回后仍可能有子进程回收未完成。
    agentService.disposeAll();
  }

  // 对外暴露的旧 task 服务实现。每个方法遵循同一纪律：
  // 读 → 只读 CLI/repo 已发布事实；写 → 发 V4 命令或写 task-index；不在此保存会话状态。
  const service: IZCodeTaskService & {
    disposeAll(): void;
    disposeAllAndWait(): Promise<void>;
  } = {
    // initialize 只探测 agent 可用性与协议名，不做 workspace 预热。
    // 缺 protocolName 时 version 返回 undefined，而不是造一个假版本号。
    async initialize(params) {
      const result = await options.zcodeAgentService.initialize(params);
      return {
        available: result.available,
        version: result.protocolName
          ? `${result.protocolName}/${result.protocolVersion ?? 1}`
          : undefined,
      };
    },

    // 释放 workspace 预热 runtime。与“关闭 UI”不同：UI 断开只释放 RPC 使用方，已预热的
    // Agent 仍在跑；不显式 disposeWorkspace，WSL 共享 Host 会持续驻留（INV-07 的 workspace 侧）。
    async releaseWorkspacePreparation(params): Promise<void> {
      // 关闭 workspace UI 只会释放 RPC 使用方，不会自动终止已预热的 Agent。
      // WSL Host 共享后 Host 会继续存活，因此必须按 workspaceKey 显式回收对应 runtime。
      await options.zcodeAgentService.disposeWorkspace(normalizeWorkspaceParams(params));
    },

    // 旧面用它探测 Codex CLI 的连通性；task 链路直连 zcode-cli，没有可失败的握手，
    // 恒返回 reachable，保留方法只为接口完整性。
    async checkCodexConnectivity(): Promise<ZCodeCodexConnectivityCheckResult> {
      return { target: "zcode-agent", reachable: true };
    },

    // 创建 task = 创建 ZCode session + 同步 task index + 广播 task_created。
    // 两条创建路径：
    //   v4Create=true → V4 createSession 命令（desktop v4 UI 在用，载荷面窄）；
    //   否则 → 旧 createSession（承载 mcpServers/model/importedHistory 并返回 snapshot）。
    // [权衡] 默认走旧路径不是遗漏：v4 createSession 尚未建模这些载荷，
    // 强行迁移会丢 MCP 与导入历史，违反 INV-08 的迁移判据。
    async createTask(params): Promise<ZCodeTaskCreateResult> {
      const target = normalizeWorkspaceParams(params);
      // 显式 modelSelection 优先；否则从旧面的 model 字符串解析。
      // thoughtLevel 只作为 options.reasoningLevel 合入，不单独成字段。
      const requestedSelection =
        params.modelSelection ??
        (params.model
          ? {
              ...parseModelPickerValue(params.model),
              ...(params.thoughtLevel ? { options: { reasoningLevel: params.thoughtLevel } } : {}),
            }
          : undefined);
      // MCP 解析可能访问产品侧 resolver（配置/网络），失败向上抛：
      // 创建一个半残 task 比创建失败更难收拾。
      const mcpServers = await resolveProductMcpServers(params.mcpServers);
      let snapshot: ZCodeSessionStateSnapshot;
      // M5 ③-2 评估标注（生命周期 op，不迁）：v4 createSession 命令已原生（desktop
      // v4 UI 在用），但 replayable createTask 需要 mcpServers/model/importedHistory
      // 载荷与 snapshot 返回值（task index 同步依赖），v4 命令面均未建模；
      // 迁移属 ③-3/波次 3 生命周期收口。
      // v4 分支只返回 ack，不返回 snapshot；必须再 readSession 补齐，
      // 否则后续 syncTaskIndexSnapshot 没有正文可写，task 行会是空壳。
      if (params.v4Create === true) {
        const model = requestedSelection;
        const ack = assertV4CommandAckOk(
          "createSession",
          await options.zcodeAgentService.sendConversationCommandV4({
            ...target,
            projectId: params.projectId ?? null,
            envelope: createHostCommandEnvelope({
              type: "createSession",
              sessionId: null,
              payload: {
                // workspaceId 与 INV-02 同口径：identity 去空后优先，其次路径。
                // projectId 缺省显式写 null，避免序列化层把 undefined 当成“沿用上次值”。
                workspaceId: target.workspaceIdentity?.trim() || target.workspacePath,
                // additionalDirectories/permissionScope 只在调用方给出时展开：
                // 显式 undefined 会被 CLI 当成“清除”，与“未提供”语义不同（INV-09）。
                ...(params.additionalDirectories !== undefined
                  ? { additionalDirectories: params.additionalDirectories }
                  : {}),
                ...(params.permissionScope ? { permissionScope: params.permissionScope } : {}),
                // config 只写有值的字段：空对象表示沿用会话默认，
                // 传 provider/model 的 undefined 会被 CLI 判为非法枚举。
                config: {
                  ...(model ? { provider: model.providerId, model: model.modelId } : {}),
                  ...(model?.options?.reasoningLevel
                    ? { thought: model.options.reasoningLevel }
                    : {}),
                  ...(params.mode ? { mode: toZCodeMode(params.mode) } : {}),
                },
                ...(mcpServers ? { mcpServers } : {}),
              },
            }),
          }),
          `workspace=${target.workspacePath}`,
        );
        // ack 本身已由 assertV4CommandAckOk 校验；这里再校验 result.sessionId：
        // CLI 接受命令却没有建会话时继续走，会写出一个没有 CLI 主体的 task 行。
        // 抛错而不是回退旧路径：命令可能已落地，双写会产生两个 session。
        const sessionId = ack.result?.type === "createSession" ? ack.result.sessionId : undefined;
        if (!sessionId) {
          throw new Error("v4 createSession accepted without sessionId result");
        }
        // 创建后显式读一次 session 做对账；不缓存，snapshot 始终是唯一正文事实源（INV-01）。
        snapshot = await options.zcodeAgentService.readSession({
          ...target,
          sessionId,
        });
      } else {
        snapshot = await options.zcodeAgentService.createSession({
          ...target,
          projectId: params.projectId ?? null,
          additionalDirectories: params.additionalDirectories,
          // 旧路径的 sessionTraceId 每次新建：trace 是日志关联 id，不复用来源 hash，
          // 否则重新导入会让两条会话指向同一 trace，日志无法区分。
          sessionTraceId: createSessionTraceId(),
          mode: toZCodeMode(params.mode),
          model: requestedSelection,
          thoughtLevel: requestedSelection?.options?.reasoningLevel,
          ...(params.automationId || params.deferPersistenceUntilFirstPrompt
            ? {
                // 修复原因：automation / 闲时任务新建空 session 后会立即 sendText。session_input 有
                // session 外键，必须让 V4 admission 在首发前统一持久化 session 主记录；
                // 否则 create 返回成功后第一条 prompt 会稳定触发 FOREIGN KEY constraint failed。
                persistence: "deferred" as const,
              }
            : {}),
          // automation 会话关闭标题自动生成：首条输入是模板正文，生成结果没有展示价值，
          // 还会额外消耗一次模型调用。
          ...(params.automationId
            ? {
                titleGenerationEnabled: false,
              }
            : {}),
          // Bugfix: replayable task facade 创建 session 时同样会启动 runtime；
          // 之前这里丢掉 mcpServers，导致手机远控路径和 desktop-continuous 的 MCP 行为不一致。
          mcpServers,
        });
      }
      // 先 sync（写 index 并广播 task_status_changed）再写归属列：
      // baseMeta 只是中间值，最终以 updateIndexedPresentation 返回的 meta 为准。
      const baseMeta = await syncTaskIndexSnapshot(snapshot, null);
      const meta = await updateIndexedPresentation({
        // 归属标记单独走 presentation 写入：cronAutomationId/offPeakTaskId 是 sticky 归属，
        // 不是本次 turn 的权限上下文；与 snapshot 派生的 mode/model 分列，避免被快照同步覆盖。
        ...baseMeta,
        ...(params.automationId ? { cronAutomationId: params.automationId } : {}),
        // 闲时派发在创建时即盖章持久归属；月亮图标与后续系统分组归属都只看该标记。
        ...(params.offPeakTaskId ? { offPeakTaskId: params.offPeakTaskId } : {}),
      });

      // 登记 syncer 会话关联：后续 turn 事件才能按 taskId 路由到 workspace 广播。
      notifySyncerSession({
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
        workspaceIdentity: meta.workspaceIdentity,
      });
      // 创建后补发 workspace 配置：新会话的 settings 可能带入了 model，与上次广播不同，
      // UI 必须立刻对齐。
      emitWorkspaceConfig(target, snapshot.settings);
      // 手机端通过 shared-host 创建 task 时，桌面 renderer 没有本地乐观插入。
      // create 事件必须保留 task_created 语义，否则 UI 会按普通 meta 事件只重排已存在项，远控首页就拿不到新任务。
      emitWorkspaceTaskListChanged(target, meta, "task_created");
      // task 创建结果需要携带 agent 协议快照里的命令列表；否则 replayable 首屏会覆盖为空。
      // initialSlashCommands 与 snapshotToZCode 的 slashCommands 同源：
      // replayable 首屏在拿到完整快照前就能渲染命令面板。
      return {
        ...meta,
        initialSlashCommands: snapshot.slashCommands ?? EMPTY_SLASH_COMMANDS,
      };
    },

    // 读取 bot 话题摘要：只取 role=user 且 source=bot_topic_context 的消息，
    // 每条抽 checkpoint/displayText，最后取最近 20 条。
    // [权衡] limit=200 是读取上限而非返回上限：先多读再在内存里过滤，
    // 因为话题上下文消息在长历史里占比可能很低，按条截断会漏掉摘要。
    async readBotTopicSummaries(params) {
      const target = taskTargets.get(params.taskId);
      // 缓存里有该 taskId 但 workspaceKey 不一致，说明跨 workspace 冒用；
      // 抛错而不是回退到参数里的 workspace，否则会读错目录。
      if (target && taskKey(target) !== taskKey(params))
        throw new Error("Topic task workspace mismatch");
      const messages = await options.zcodeAgentService.readSessionMessages({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        remoteSessionId: params.remoteSessionId ?? target?.remoteSessionId,
        sessionId: params.taskId,
        limit: 200,
      });
      return messages
        // displayText 是 bot 侧渲染用的展示串，优先于 parts 拼文本；
        // checkpoint 缺失回落空串，保持旧 UI 的字符串契约。
        .flatMap(({ info, parts }) => {
          if (info.role !== "user" || info.source !== "bot_topic_context") return [];
          return [
            {
              checkpoint: String(info.metadata?.checkpoint ?? ""),
              text:
                typeof info.metadata?.displayText === "string"
                  ? info.metadata.displayText
                  : textFromParts(parts),
            },
          ];
        })
        // 先 flatMap 过滤再 slice(-20)：这样得到的是“最近 20 条摘要”；
        // 反过来先截断会把符合条件但较早的摘要挤掉。
        .slice(-20);
    },

    // 让话题输入 admission 失效：key 由 (taskKey, remoteSessionId) 组成，
    // 与 submitBotGroupInput 的 capture/run 使用同一 key，保证取消与提交看到同一代次。
    // 不在这里删队列：队列在 CLI，失效只影响本端后续的代次校验。
    async invalidateBotTopicInputs(params) {
      const target = getTaskTarget(params.taskId);
      if (taskKey(target) !== taskKey(params)) throw new Error("Group task workspace mismatch");
      // remoteSessionId 参与 key：同一 taskId 在本地与远程链路是两代输入，
      // 只按 taskKey 失效会把另一条链路上的待发送输入一起作废。
      const key = JSON.stringify([
        taskKey(params),
        params.remoteSessionId ?? target.remoteSessionId ?? null,
      ]);
      await topicAdmission.invalidate(key);
    },
    // 读取话题当前前台执行身份，供停止与展示使用。
    // idle 时返回 undefined 而不是抛错：调用方按“没有可停止执行”处理。
    async readBotTopicExecution(params) {
      const target = getTaskTarget(params.taskId);
      if (taskKey(target) !== taskKey(params)) throw new Error("Group task workspace mismatch");
      const workspace = {
        ...params,
        remoteSessionId: params.remoteSessionId ?? target.remoteSessionId,
      };
      // remoteSessionId 取参数优先、已登记 target 兜底：话题链路可能在本端尚未登记 target 时
      // 被调用（例如由另一台设备的会话发起）。
      const snapshot = await readBotGroupRuntimeSnapshot(botAgent(workspace), {
        ...workspace,
        sessionId: params.taskId,
      });
      if (snapshot.control.stopState === "idle") return undefined;
      // activeWorks 里可能同时有多个 work，只有带 foregroundExecutionId 的才是前台执行；
      // 找不到说明 projection 处于过渡态，抛错让调用方重试而不是返回半截身份。
      const execution = snapshot.control.activeWorks.find((work) => work.foregroundExecutionId);
      if (!execution?.foregroundExecutionId)
        throw new Error("Topic execution identity is unavailable");
      return {
        executionId: execution.foregroundExecutionId,
        sourceCommandId: execution.sourceCommandId,
      };
    },
    // 停止话题执行：先建终态观察，再发 stop 命令，最后等观察结束。
    // [事务] stop 是 CAS 语义（expectedForegroundExecutionId）：执行身份不匹配时 CLI 拒绝，
    // assertV4CommandAckOk 抛错；此时观察仍在等，finally 的 abort 负责释放。
    async stopBotTopicExecution(params) {
      const target = getTaskTarget(params.taskId);
      if (taskKey(target) !== taskKey(params)) throw new Error("Group task workspace mismatch");
      const workspace = {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        remoteSessionId: params.remoteSessionId ?? target.remoteSessionId,
      };
      const agent = botAgent(workspace);
      // 先注册终态监听再停止，避免快速结束发生在 ACK 与订阅之间。
      const observation = new AbortController();
      const ended = waitBotGroupExecutionEnd(
        agent,
        { ...workspace, sessionId: params.taskId },
        params.executionId,
        observation.signal,
      );
      void ended.catch(() => undefined);
      // 只有 ACK 成功才等待终态；ACK 失败直接抛出，避免为一个未生效的 stop 死等。
      try {
        const ack = await agent.sendConversationCommandV4({
          ...workspace,
          envelope: createHostCommandEnvelope({
            type: "stop",
            sessionId: params.taskId,
            payload: { expectedForegroundExecutionId: params.executionId },
          }),
        });
        assertV4CommandAckOk("stop", ack, `session=${params.taskId}`);
        await ended;
      // [资源] abort 放在 finally：无论 stop 成功、失败还是等待期间抛错，
      // 观察订阅都会被释放，防止事件监听泄漏到 adapter 销毁之后。
      } finally {
        observation.abort();
      }
    },

    // 判定群任务当前是否可接受新输入：interaction > running > queued 的优先级
    // 对应 UI 的三个阻塞提示；返回 null 表示可以立即发送。
    async getBotGroupTaskBlockReason(params) {
      const target = taskTargets.get(params.taskId);
      if (target && taskKey(target) !== taskKey({ ...params, taskId: params.taskId }))
        throw new Error("Group task workspace mismatch");
      const snapshot = await readBotGroupRuntimeSnapshot(botAgent(params), {
        ...params,
        ...((params.remoteSessionId ?? target?.remoteSessionId)
          ? { remoteSessionId: params.remoteSessionId ?? target?.remoteSessionId }
          : {}),
        sessionId: params.taskId,
      });
      // 顺序即优先级：有待交互时用户必须先回答，running 次之，队列非空最后。
      // 反过来先判 running 会把“等待回答”显示成“正在运行”，用户不知道该操作什么。
      if (snapshot.pendingInteractions.length > 0) return "interaction";
      if (snapshot.control.phase === "running" || snapshot.control.phase === "prewarming")
        return "running";
      if (snapshot.queue.items.length > 0) return "queued";
      return null;
    },
    // 取消群任务里尚未派发的队列项：先按 sourceCommandId 找项，再校验 bot/chat/发送者身份，
    // 最后以本次快照的 revision 为基准发 deleteQueueItem。
    // 授权规则：发起者本人或群主，二者之外一律拒绝。
    async cancelBotGroupInput(params) {
      const target = getTaskTarget(params.taskId);
      // 只在调用方显式给了 workspacePath 时校验：部分旧调用方不带路径，用已登记 target 兜底；
      // 无条件强校验会让历史调用全部报 mismatch。
      if (
        params.workspacePath &&
        taskKey(target) !== taskKey({ ...params, workspacePath: params.workspacePath })
      )
        throw new Error("Group task workspace mismatch");
      const workspace = {
        workspacePath: params.workspacePath ?? target.workspacePath,
        workspaceIdentity: params.workspaceIdentity ?? target.workspaceIdentity,
        ...((params.remoteSessionId ?? target.remoteSessionId)
          ? { remoteSessionId: params.remoteSessionId ?? target.remoteSessionId }
          : {}),
      };
      const snapshot = await readBotGroupRuntimeSnapshot(botAgent(workspace), {
        ...workspace,
        sessionId: target.taskId,
      });
      const item = snapshot.queue.items.find(
        (entry) => entry.sourceCommandId === params.sourceCommandId,
      );
      // 已派发（非 queued）不能取消：输入已进入 CLI inbox，删队列项撤不回它，
      // 返回成功会误导 UI。
      if (!item || item.dispatch.state !== "queued") throw new Error("Input is no longer queued");
      const source = item.botGroupSource;
      // 授权只看队列项里记录的 botGroupSource：它由提交时写入，调用方无法伪造。
      if (
        !source ||
        source.botId !== params.botId ||
        source.chatId !== params.chatId ||
        (params.actorId !== params.ownerId && source.senderId !== params.actorId)
      )
        throw new Error("Queue cancellation is not authorized");
      return botAgent(workspace).sendConversationCommandV4({
        ...workspace,
        envelope: createHostCommandEnvelope({
          type: "deleteQueueItem",
          sessionId: target.taskId,
          commandId: params.commandId,
          // revision 作为 CAS 基准：删除必须基于本次读到的快照，否则并发提交/派发会让
          // baseRevision 过期，CLI 拒绝而不是误删。
          baseRevision: snapshot.revision,
          payload: { queueItemId: item.queueItemId },
        }),
      });
    },

    // 提交群输入：冷恢复屏障 → 上传附件 → 代次校验 → 发 sendText。
    // 关键是附件上传有网络 IO，期间可能被 stop/invalidate；因此用 admission 的 capture/run
    // 包住“版本快照”，让取消与提交在同一代次上判定。
    async submitBotGroupInput(params) {
      const target = getTaskTarget(params.taskId);
      if (
        params.workspacePath &&
        taskKey(target) !== taskKey({ ...params, workspacePath: params.workspacePath })
      )
        throw new Error("Group task workspace mismatch");
      const workspace = {
        workspacePath: params.workspacePath ?? target.workspacePath,
        workspaceIdentity: params.workspaceIdentity ?? target.workspaceIdentity,
        ...((params.remoteSessionId ?? target.remoteSessionId)
          ? { remoteSessionId: params.remoteSessionId ?? target.remoteSessionId }
          : {}),
      };
      const admissionKey = JSON.stringify([
        taskKey({ ...workspace, taskId: target.taskId }),
        workspace.remoteSessionId ?? null,
      ]);
      // capture 必须在任何 await 之前：之后才取版本，会把“上传期间发生的取消”当成合法代次。
      const version = topicAdmission.capture(admissionKey);
      // Bug 原因：Host 重启后任务索引仍在，但 CLI 尚未加载原会话；直接 admission
      // 会返回 sessionNotFound。复用后台订阅的冷恢复屏障，不依赖 Desktop 打开任务。
      await readBotGroupRuntimeSnapshot(botAgent(workspace), {
        ...workspace,
        sessionId: target.taskId,
      });
      // 上传在屏障之后：session 未加载时附件找不到归属。上传失败向上抛，不重试——
      // 重试会重复占用附件存储。
      const attachments = await uploadBotGroupAttachments(
        botAgent(workspace),
        { ...workspace, sessionId: target.taskId },
        params.attachments ?? [],
      );
      // 停止可以发生在附件上传期间；完成上传不代表旧输入仍允许被接受。
      // 只在 thread 场景复核代次：thread 启动即 startNow，取消语义必须严格；
      // 普通群消息走 queue，迟到一条由 CLI 队列串行化，不需要在这里拒绝。
      if (params.source.threadId && version !== topicAdmission.capture(admissionKey)) {
        throw new Error("Topic input was cancelled during preparation");
      }
      // clientId 由 bot/chat/发送者拼成稳定值：CLI 用它参与幂等判定，
      // 随机值会让同一条消息在重投时被当成新提交。
      const envelope = createHostCommandEnvelope({
        type: "sendText",
        sessionId: target.taskId,
        commandId: params.commandId,
        clientId: `bot:${params.source.botId}:${params.source.chatId}:${params.source.senderId}`,
        payload: {
          text: params.content,
          attachments,
          // requestedDelivery 由是否存在 threadId 决定：thread 输入立即开始，群消息排队。
          // 若一律 startNow，会打断正在进行的回合。
          requestedDelivery: params.source.threadId ? "startNow" : "queue",
          botGroupSource: params.source,
          conversationQuotes: params.conversationQuotes,
          // botDeliveryTarget 是回复路由而非会话身份：providerUserId 放 chatId，
          // 因为群场景的投递目标是会话而不是个人。
          botDeliveryTarget: {
            provider: params.source.provider,
            botId: params.source.botId,
            providerUserId: params.source.chatId,
            chatType: "group",
            ...(params.source.threadId
              ? { threadId: params.source.threadId, rootMessageId: params.source.rootMessageId }
              : {}),
          },
        },
      });
      // send 外层做 ACK 对账：网络抖动导致 ACK 丢失时，用同一 commandId 反查，
      // 已落地的命令视为成功。绝不能换新 commandId 重发，否则会产生两条输入。
      // 这是“至多一次输入”的唯一保障，不能用超时重试替代。
      const send = async () => {
        try {
          return await botAgent(workspace).sendConversationCommandV4({
            ...workspace,
            envelope,
          });
        } catch (error) {
          // 查询失败（网络/超时）吞成 null，再 fall through 抛原始错误：
          // 此时无法判断命令是否落地，交给上层重试，由幂等表兜底。
          // ACK 丢失时查询同一个命令，不能生成新 ID 重发输入。
          const query = await botAgent(workspace)
            .queryConversationCommandsV4({
              ...workspace,
              commands: [{ sessionId: target.taskId, commandId: params.commandId }],
            })
            .catch(() => null);
          const result = query?.results[0]?.result;
          if (result && result !== "unknown") return result;
          throw error;
        }
      };
      // 仅 thread 输入进 admission.run：它串行化同一代次的提交与取消；
      // 普通群消息直接发，避免把群聊吞吐限制在单条处理上。
      return params.source.threadId ? topicAdmission.run(admissionKey, version, send) : send();
    },

    // 旧 task 的 sendPrompt → agent 输入。
    // target 以已登记 target 为准，只允许参数补 remoteSessionId：路径/identity 在登记时确定，
    // 调用方传入的路径不能改写会话归属（INV-02）。
    async sendPrompt(params): Promise<void> {
      const storedTarget = getTaskTarget(params.taskId);
      const target = {
        ...storedTarget,
        ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
      };
      // 只透传协议字段，不在此补默认值：默认值属于 agent 侧契约，
      // 适配层补会让 replayable 与 desktop 的输入形状分叉。
      await sendPromptToAgent(target, {
        traceId: params.traceId,
        queryId: params.queryId,
        messageId: params.messageId,
        content: params.content,
        attachments: params.attachments,
        ...turnAttributionOf(params),
        toolDenylist: params.toolDenylist,
        botDeliveryTarget: params.botDeliveryTarget,
        clientId: params.clientId,
        clientMode: params.clientMode,
        modelSelection: params.modelSelection,
        modelExecution: params.modelExecution,
      });
    },

    // session mailbox 的方法在 task 面没有实现：旧协议无对应语义。
    // unsupported 抛稳定错误码，避免调用方拿到“成功但未投递”的假结果。
    async deliverSessionMessage(
      _request: SessionMessageSendRequested,
    ): Promise<SessionMessageDeliveryResult> {
      unsupported("deliverSessionMessage");
    },

    // 同上：投递结果回执未建模，显式 unsupported。
    async sendSessionMessageDeliveryResult(): Promise<void> {
      unsupported("sendSessionMessageDeliveryResult");
    },

    // 手机 replayable 的 host command 入队。ownerRunId 是 stale 防护边界：
    // 旧 run 的命令不允许写进当前队列，否则会在共享 host 上误发旧输入。
    // 入队后本端自行调度 drain：手机侧本地队列会主动跳过 hostCommand，不会替 host 消费，
    // 因此不触发 drain 就会永远停在 accepted。
    async enqueueTaskCommand(params): Promise<ZCodeEnqueueTaskCommandResult> {
      assertCurrentOwnerRun(params, params.ownerRunId);
      // workspaceKey 在入队时固化：命令可能在跨 workspace 复用 taskId 时被取出，
      // 出队时重新计算会得到不同的 key。
      const workspaceKeyValue = workspaceKey(params);
      const command: ZCodeTaskRuntimeCommand = {
        commandId: params.commandId,
        taskId: params.taskId,
        traceId: params.traceId,
        queryId: params.queryId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        workspaceKey: workspaceKeyValue,
        // status 从 accepted 起步；createdAt/updatedAt 允许同毫秒，
        // UI 只按数组顺序展示，不依赖时间排序。
        status: "accepted",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        clientId: params.clientId,
        clientLabel: params.clientLabel,
        type: "send_prompt",
        content: params.content,
        attachments: params.attachments,
        // manual run / 手机 replayable 的 prompt 可能先进入 host command queue；
        // 若这里丢 automationId，drain 时会按普通用户输入发送，CronCreate 会重新暴露。
        automationId: params.automationId,
      };
      // 追加而不是覆盖：队列语义是 FIFO，覆盖会丢掉尚未发送的旧命令。
      const key = taskKey(params);
      // [并发] 以整数组替换写入，单线程事件循环下不会撕裂；
      // 但不能在 await 之后再基于旧数组追加，否则并发入队会互相覆盖。
      runtimeCommands.set(key, [...(runtimeCommands.get(key) ?? []), command]);
      // 手机 replayable host command 被 accepted 后，前端本地 drain 会主动跳过 hostCommand。
      // 因此 host 需要在当前 task 已空闲时自行触发消费；桌面 continuous 不调用该入口，不会受影响。
      scheduleRuntimeCommandDrain(params, "enqueue");
      return { accepted: true, command };
    },

    // 把命令提升到队首并重置为 accepted（用户点“立即发送”）。
    // running 命令直接返回原对象：对已执行命令重排没有意义，还会破坏 running 唯一性。
    async promoteTaskCommand(params): Promise<ZCodeEnqueueTaskCommandResult> {
      assertCurrentOwnerRun(params, params.ownerRunId);
      const key = taskKey(params);
      const commands = runtimeCommands.get(key) ?? [];
      const command = commands.find((candidate) => candidate.commandId === params.commandId);
      // 找不到时返回稳定 code OWNER_COMMAND_FAILED：调用方按 code 分支，
      // 不解析 message 文本（INV-05）。
      if (!command) {
        throw Object.assign(new Error("Task command not found."), {
          code: "OWNER_COMMAND_FAILED",
        });
      }
      if (command.status === "running") {
        return { accepted: true, command };
      }
      // 提升 = 新对象 + 放到首位，其余命令保持相对顺序。
      // [权衡] 重建对象而不是原地改 status：对象可能已被 drain 的闭包引用，
      // 原地改会让在途发送看到中途变化的状态。
      const nextCommand = {
        ...command,
        status: "accepted" as const,
        updatedAt: Date.now(),
      };
      runtimeCommands.set(key, [nextCommand, ...commands.filter((item) => item !== command)]);
      scheduleRuntimeCommandDrain(params, "promote");
      return { accepted: true, command: nextCommand };
    },

    // 取消队列中的命令，三种结果都是可预期的：
    //   not_found（已被 drain 发出）→ canceled=true，幂等
    //   already_running → canceled=false
    //   真正删除 → canceled=true
    // 删除后必须广播 task_snapshot_updated，否则 renderer 下一次快照会把 accepted 命令恢复回来。
    // 这里的“事实源”是 host 队列本身，不是 renderer 本地 store。
    async cancelTaskCommand(params): Promise<ZCodeCancelTaskCommandResult> {
      assertCurrentOwnerRun(params, params.ownerRunId);
      const key = taskKey(params);
      const commands = runtimeCommands.get(key) ?? [];
      const command = commands.find((candidate) => candidate.commandId === params.commandId);
      // 找不到时返回成功而不是抛错：用户点取消时命令可能刚好被发送，
      // 抛错会让 UI 显示“取消失败”，但实际已无可取消对象。
      if (!command) {
        logger.info(undefined, "ZCode task command 取消时已不存在", {
          commandId: params.commandId,
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return {
          canceled: true,
          commandId: params.commandId,
          reason: "not_found",
        };
      }
      // running 不能取消：撤回队列项不会终止已开始的 turn，
      // 真正的停止走 stopGeneration（V4 stop 命令）。
      if (command.status === "running") {
        logger.info(command.traceId, "ZCode task command 已开始运行，跳过取消", {
          commandId: command.commandId,
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return {
          canceled: false,
          commandId: command.commandId,
          reason: "already_running",
          status: command.status,
        };
      }
      // 手机 replayable 队列的事实源在 host runtime command queue。
      // 删除按钮不能只清 renderer 本地 store，否则下一次 snapshot 会把已 accepted 的命令恢复回来。
      // 先写队列事实，再广播让 renderer 重拉；反过来 renderer 可能读到删除前的快照，
      // 把删除按钮又渲染出来。
      setRuntimeCommands(
        params,
        commands.filter((item) => item.commandId !== command.commandId),
      );
      emitRuntimeCommandSnapshotUpdated(params, command.traceId);
      // 日志带 status：区分“删了 accepted”与“删了 failed”，后者通常是上次 drain 失败的残留。
      logger.info(command.traceId, "ZCode task command 已取消", {
        commandId: command.commandId,
        status: command.status,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      return {
        canceled: true,
        commandId: command.commandId,
        status: command.status,
      };
    },

    // 停止当前生成：发 V4 stop 命令，等价旧 session/stop；goal-pause barrier 由 CLI 原生
    // handler 承接，本层不模拟暂停状态。日志用 runId 作为 traceId 关联一次停止动作。
    async stopGeneration(params): Promise<void> {
      const startedAt = Date.now();
      // 带 workspacePath 时以参数为准（可能是新窗口尚未登记的 task），否则回落已登记 target；
      // 两者都没有会抛 ZCODE_SESSION_TARGET_NOT_FOUND。
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      logger.info(params.runId, "ZCode task facade stopGeneration 开始", {
        hasRunId: Boolean(params.runId),
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(target),
        workspacePath: target.workspacePath,
      });
      // session/stop → v4 stop 命令（goal-pause barrier 语义由 CLI 原生 handler 承接）。
      const ack = await options.zcodeAgentService.sendConversationCommandV4({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        // expectedForegroundExecutionId 只在话题链路给出：它是 CLI 的执行身份，
        // 不能用日志 traceId 顶替；缺省时空 payload 表示“停止当前前台执行”。
        envelope: createHostCommandEnvelope({
          type: "stop",
          // 话题停止必须保留已观察到的执行身份；日志 traceId 不能替代 CLI 执行身份。
          payload: params.expectedForegroundExecutionId
            ? { expectedForegroundExecutionId: params.expectedForegroundExecutionId }
            : {},
          sessionId: params.taskId,
        }),
      });
      // ACK 失败直接抛：调用方（停止按钮）必须知道停止未生效，不能因为“反正会停”静默成功。
      assertV4CommandAckOk("stop", ack, `session=${params.taskId}`);
      logger.info(params.runId, "ZCode task facade stopGeneration ACK", {
        durationMs: Date.now() - startedAt,
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(target),
        workspacePath: target.workspacePath,
      });
    },

    // 触发 context compact。仍走旧协议路径：v4 compact 要求 v4 conversation revision 作为
    // baseRevision，而旧面传的 expectedRevision 是 stateRevision；两套计数器不可互换，
    // 直接映射会造成假 stale。等 replayable 读路径收口 v4 revision 后再迁。
    async compactSession(params) {
      // v4 compact 是 CAS 命令（必带 v4 conversation revision
      // 的 baseRevision），而本 facade 的 expectedRevision 是旧协议 stateRevision——
      // 两套计数器不可互换；replayable 侧拿到 v4 revision 前强行迁移会造成假 stale。
      // 且 v4 compact 无 instructions/runtimeModel 载荷。
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      // 先登记 session 关联与 active input：compact 会产流事件，
      // 没有 inputId 时终态无法按输入收口，队列会残留 running 命令。
      notifySyncerSession(target);
      if (params.inputId) {
        activePromptInputIds.set(taskKey(target), params.inputId);
      }
      try {
        // expectedRevision 原样透传：本层不改写旧 revision 语义，改了就变成两套状态混用。
        const result = await options.zcodeAgentService.compactSession({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          sessionId: params.taskId,
          inputId: params.inputId,
          instructions: params.instructions,
          expectedRevision: params.expectedRevision,
        });
        // accepted 表示 CLI 已受理但未完成：此时不要同步 index，
        // 否则会把“压缩中”的中间快照写成终态。
        if (result.compact?.state === "accepted") {
          return result;
        }
        // 完成态用返回的 snapshot 对账。reason 固定 task_status_changed：
        // compact 不改变归属，用 task_meta_changed 会触发全局 membership 重拉。
        const meta = await syncTaskIndexSnapshot(result.snapshot);
        // compact 收敛是状态同步，不涉及归属；缺省 task_meta_changed 会触发全局 membership 重拉。
        emitWorkspaceTaskListChanged(target, meta, "task_status_changed");
        activePromptInputIds.delete(taskKey(target));
        return result;
      } catch (error) {
        // [失败路径] 失败也要删 activeInputId：否则下一次 drain 永远认为有轮次在跑，
        // 手机队列被永久卡住。删除后原样抛出，调用方仍能感知失败。
        activePromptInputIds.delete(taskKey(target));
        throw error;
      }
    },

    // 目标（goal）操作：set/resume/clear/replace/status，仍走旧 op（v4 只覆盖 set）。
    // 输入：objective 仅在 set/replace 有意义；inputId 由调用方生成，用于终态收口。
    // 副作用：可能清 live 工具缓存、登记 activeInputId、写 index 并广播 task_status_changed。
    // [失败路径] 命令失败不外抛本地状态；轮次是否终结以 CLI 返回的 snapshot.status 为准。
    async goalSession(params) {
      // v4 sendGoalCommand 只覆盖 set 语义（text 原文），
      // 本 facade 的 action=resume/clear/replace/status 依赖旧 op 的结构化 action 面
      // （v4 侧 resumeGoal 是 CAS 命令，revision 计数器问题同 compactSession）。
      // 过渡归宿 = replayable v4 读路径收口，与 compactSession 同批。
      const startedAt = Date.now();
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      notifySyncerSession(target);
      // 只有可能启动新一轮输出的动作才需要清 live projection 与登记 inputId；
      // clear/status 不产生 turn，登记会让队列误以为有轮次在跑。
      const mayStartContinuation =
        params.action === "set" || params.action === "replace" || params.action === "resume";
      if (mayStartContinuation) {
        // 不清 live-only 工具，新快照会把这些已结束的工具补到新回复尾部，UI 出现幽灵工具卡。
        // goal resume 也可能启动新一轮模型输出，不能继承上一轮 live-only 工具。
        clearLiveToolProjection(target);
        clearStreamingToolInputCache(target);
      }
      if (params.inputId && mayStartContinuation) {
        activePromptInputIds.set(taskKey(target), params.inputId);
      }
      logger.info(params.inputId, "[zcode-task-service] goalSession start", {
        action: params.action,
        hasObjective: Boolean(params.objective?.trim()),
        mayStartContinuation,
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity,
        workspacePath: target.workspacePath,
      });
      // 请求体逐字段透传：objective 只在 set/replace 有意义，其余 action 传 undefined 由 CLI 忽略；
      // 本层预判会与 CLI 校验规则漂移。
      const result = await options.zcodeAgentService.goalSession({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: params.taskId,
        inputId: params.inputId,
        action: params.action,
        objective: params.objective,
        expectedRevision: params.expectedRevision,
      });
      logger.info(params.inputId, "[zcode-task-service] goalSession agent 返回", {
        action: params.action,
        durationMs: Date.now() - startedAt,
        responseLength: result.response?.length ?? 0,
        startedTurn: result.startedTurn,
        status: result.snapshot.session.status,
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity,
        workspacePath: target.workspacePath,
      });
      const syncStartedAt = Date.now();
      // 用返回 snapshot 对账 index：goal 可能改变 status/target，二者都是 row 列；
      // 广播 reason 固定 task_status_changed，避免一次 goal 操作触发全局列表重拉。
      const meta = await syncTaskIndexSnapshot(result.snapshot);
      // goal 动作后的快照收敛同为状态同步，不涉及归属，避免全局 membership 重拉。
      emitWorkspaceTaskListChanged(target, meta, "task_status_changed");
      logger.info(params.inputId, "[zcode-task-service] goalSession task index 同步完成", {
        action: params.action,
        durationMs: Date.now() - startedAt,
        startedTurn: result.startedTurn,
        status: result.snapshot.session.status,
        syncDurationMs: Date.now() - syncStartedAt,
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity,
        workspacePath: target.workspacePath,
      });
      // 只有“可能启动续跑且 CLI 确认仍在 running”时才保留 inputId；
      // 否则立即释放，防止后续 drain 被一个已结束的轮次挡住。
      if (!mayStartContinuation || result.snapshot.session.status !== "running") {
        activePromptInputIds.delete(taskKey(target));
      }
      return result;
    },

    // 权限回执 → v4 resolveInteraction。interactionId 直接复用业务 requestId：
    // CLI 的 interaction-broker 以同一 id 注册，改成新 id 会导致 broker 找不到待处理项。
    // 只发命令、不写本地 pending 表（INV-01）；返回 true 表示 ACK 已校验通过。
    // [失败路径] 过期/重复的 requestId 由 CLI 拒绝，assertV4CommandAckOk 抛出稳定错误。
    async respondPermission(params): Promise<boolean> {
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      // permission 回执收敛 v4 resolveInteraction。
      // interactionId ≡ 业务 requestId（CLI interaction-broker 同源注册）；optionId 由
      // CLI 侧 buildProtocolPermissionOptions 精确回映 response（allow_project 的
      // permissionUpdates 持久化规则不丢，见 interaction-broker v4AnswerToPermissionResponse）。
      const ack = await options.zcodeAgentService.sendConversationCommandV4({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        envelope: createHostCommandEnvelope({
          type: "resolveInteraction",
          payload: {
            interactionId: params.requestId,
            // answer 只带 optionId：permissionUpdates 的持久化规则由 broker 白名单决定，
            // 本层展开会绕过它。
            answer: { optionId: params.optionId },
          },
          sessionId: params.taskId,
        }),
      });
      // 权限应答是一次性操作，重复 ACK 会抛错；因此不做本地幂等缓存，
      // 由调用方按 requestId 保证只提交一次。
      assertV4CommandAckOk("resolveInteraction", ack, `permission ${params.requestId}`);
      return true;
    },

    // 多题答案/plan-approval 回执：与 permission 共用 resolveInteraction，但 answer 是结构化载荷。
    // 副作用：v4 命令 + （replayable 下）本地补投 elicitation_response，供离屏 observer 清弹窗。
    // [权衡] 补投只限 web-remote-replayable：desktop 走原生事件链路，重复投递会让同一次应答
    // 被两处观察者各清理一次。
    async respondElicitation(params): Promise<boolean> {
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      // AskUserQuestion/plan-approval 回执收敛 v4 resolveInteraction。
      // answer.action/content 是 additive 扩展（多题答案/注解无损承载，CLI 侧
      // interaction-broker 优先按 action 精确映射，缺省回落 optionId/freeText 兼容路径）。
      const ack = await options.zcodeAgentService.sendConversationCommandV4({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        envelope: createHostCommandEnvelope({
          type: "resolveInteraction",
          payload: {
            interactionId: params.requestId,
            answer: {
              action: params.action,
              // content 只在有值时展开：显式传空串会被 broker 当成“用户回答了空文本”，
              // 与“未提供补充说明”不同。
              ...(params.content ? { content: params.content } : {}),
            },
          },
          sessionId: params.taskId,
        }),
      });
      assertV4CommandAckOk("resolveInteraction", ack, `elicitation ${params.requestId}`);
      if (params.clientMode === "web-remote-replayable") {
        // 语义保真（原 agentService.respondUserInput 的 web-remote-replayable 分支）：
        // 手机远控应答后，桌面/其它 observer 需要显式响应事件清理同一 requestId 的弹窗；
        // v4 命令路径不再经过旧 respondUserInput，这里由 adapter 本地补投同一事件。
        emitTaskEvent(
          target,
          userInputResponseToElicitationStreamEvent(params.taskId, params.requestId, {
            action: params.action,
            content: params.content,
          }),
        );
      }
      return true;
    },

    // 恢复 task：显式 model/thoughtLevel 优先于 task index 的历史 hint，
    // 用户刚选的模型不能被历史值覆盖。
    // 副作用：可能创建 CLI runtime、写 index、广播配置与列表状态、登记 syncer 会话。
    // [失败路径] 只有 sessionMissing 才降级 legacy 文件；其它 resume 失败直接上抛。
    async resumeTask(params): Promise<ZCodeTaskMeta> {
      // v4 侧 resume 已走 subscribe 冷恢复钩子
      // （CLI cold-resume），但 replayable resumeTask 还承担 model/thoughtLevel 回填与
      // snapshot→task index 正文索引回源，旧 resumeSession op 保留到 v4 生命周期收口。
      const explicitModel = params.model?.trim();
      const explicitThoughtLevel = params.thoughtLevel?.trim();
      // 两个 hint 都显式给出时跳过 index 查询：少一次 DB 读，也避免旧 hint 覆盖显式值。
      const indexHints =
        explicitModel && explicitThoughtLevel
          ? {}
          : await resolveTaskIndexResumeHints(params, "resume_task");
      const model = explicitModel || indexHints.model;
      const thoughtLevel = explicitThoughtLevel || indexHints.thoughtLevel;
      // 内部先试 session，仅 sessionMissing 才回落 legacy 文件；
      // 其它错误直接抛，不能把“协议失败”降级成“读旧文件”。
      const restored = await resumeSnapshotOrLegacy({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        model,
        thoughtLevel,
        mcpServers: params.mcpServers,
        additionalDirectories: params.additionalDirectories,
      });
      // legacy 分支没有 CLI settings，不能广播 workspace config，只补归属并广播列表状态。
      if (restored.kind === "legacy") {
        const meta = await updateIndexedPresentation({
          ...restored.snapshot.meta,
          ...(params.automationId ? { cronAutomationId: params.automationId } : {}),
          // D48：pre-打点会话被闲时续跑恢复时补写归属；backfill 之外的双保险。
          ...(params.offPeakTaskId ? { offPeakTaskId: params.offPeakTaskId } : {}),
        });
        // 打开/恢复任务是快照收敛，不涉及归属，与 resumeSession 广播同语义。
        emitWorkspaceTaskListChanged(params, meta, "task_status_changed");
        return meta;
      }
      // session 分支：snapshot 是权威。先广播 workspace 配置，再对账 index；
      // 顺序反了，UI 可能用旧的 settings 渲染新 meta。
      const snapshot = restored.snapshot;
      emitWorkspaceConfig(params, snapshot.settings);
      const snapshotMeta = await syncTaskIndexSnapshot(snapshot);
      // 只有确实带了归属参数才写 presentation：无条件写会把 index 里已有的
      // cronAutomationId/offPeakTaskId 覆盖成 undefined，正是 INV-09 的默认值陷阱。
      const meta =
        params.automationId || params.offPeakTaskId
          ? await updateIndexedPresentation({
              ...snapshotMeta,
              ...(params.automationId ? { cronAutomationId: params.automationId } : {}),
              // 续跑时补写闲时归属标记。
              ...(params.offPeakTaskId ? { offPeakTaskId: params.offPeakTaskId } : {}),
            })
          : snapshotMeta;
      // 恢复后重新登记 syncer 会话：Host 重启后 syncer 的会话表是空的，
      // 不登记会让后续 turn 事件找不到 workspace 广播目标。
      notifySyncerSession({
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
        workspaceIdentity: meta.workspaceIdentity,
      });
      return meta;
    },

    // 读任务列表：过滤条件下推到 tasks-index（provider/pinned/archived），
    // 本层不做二次筛选，否则分页与总数会和 DB 口径不一致（INV-10）。
    // 返回项逐条 remember 进内存 target 表，供后续 rename/pin 等按 taskId 定位 workspace。
    async listTasks(params): Promise<ZCodeTaskMeta[]> {
      const tasks = await taskIndexRepo.listTaskMetas({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: GLM_PROVIDER,
        // pinned/archived 显式 false：listTaskMetas 的三态（undefined=不过滤）不能表达“只要常规任务”。
        pinned: false,
        archived: false,
      });
      // rememberIndexedTaskMeta 同步内存 target 表：后续按 taskId 发命令需要 workspace 归属。
      return tasks.map(rememberIndexedTaskMeta);
    },

    // 全局置顶 id 列表（不限 workspace）：侧栏置顶区跨项目展示，因此不传 workspacePath。
    // 只回 id 不回 meta：调用方自己控制展示顺序，也不把另一 workspace 的正文读进本端。
    async listPinnedTaskIds(): Promise<string[]> {
      const tasks = await taskIndexRepo.listTaskMetas({
        provider: GLM_PROVIDER,
        pinned: true,
        archived: false,
      });
      return tasks.map((task) => task.taskId);
    },

    // 本 workspace 的置顶任务完整 meta：与 listPinnedTaskIds 的区别是带 workspace 过滤与展示字段。
    // 跨项目置顶展示由调用方组合 id 列表与逐条 meta 完成，本方法不跨 workspace。
    async listPinnedTasks(params): Promise<ZCodeTaskMeta[]> {
      const tasks = await taskIndexRepo.listTaskMetas({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: GLM_PROVIDER,
        pinned: true,
        archived: false,
      });
      return tasks.map(rememberIndexedTaskMeta);
    },

    // 已删除 task id：读 index 的墓碑集合（deleted=1），
    // 供 UI 区分“被删除”与“从未存在”。
    // [权衡] 只回 id 不回正文：墓碑只用于过滤与提示，读正文会绕过 CLI 的会话事实源。
    async listDeletedTaskIds(params): Promise<string[]> {
      return taskIndexRepo.listDeletedTaskIds({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: GLM_PROVIDER,
      });
    },

    // 本 workspace 内仍活跃的 task：事实源是 syncer 持有 runtime 的会话表，不是 index 行集合；
    // 两者口径不同，不能互相替代（INV-10）。
    // 返回顺序不保证，调用方只做集合判断；CLI 释放 runtime 后该 id 会自然消失。
    async listActiveTaskIds(params): Promise<string[]> {
      const key = workspaceKey(params);
      // 用 workspaceKey 比较：远程会话的 identity 与路径可能不同，只比路径会漏掉远程任务（INV-02）。
      return taskIndexSyncer
        .activeTaskRefs()
        .filter((ref) => workspaceKey(ref) === key)
        .map((ref) => ref.taskId);
    },

    // 保留全局搜索与 Controller 的显式 scopes 查询；项目侧栏不再维护旧远端列表镜像。
    // 保留它的原因是项目侧栏已不再维护旧远端列表镜像，搜索仍需要一个跨 workspace 的查询面；
    // 条件原样下推、只强制 provider=GLM，保证与 index 口径一致。
    // items 逐条 remember：搜索结果同样可能成为后续命令的 target。
    async listTaskList(params: ZCodeTaskListQuery): Promise<ZCodeTaskListResult> {
      const result = await taskIndexRepo.queryTaskList({
        ...params,
        provider: GLM_PROVIDER,
      });
      return {
        ...result,
        items: result.items.map(rememberIndexedTaskMeta),
      };
    },

    // 归档列表：不传 pinned 过滤，归档与置顶互不排斥（同一任务可以既置顶又归档）。
    // 返回项同样 remember，归档任务仍可被恢复/删除等命令按 taskId 定位。
    async listArchivedTasks(params): Promise<ZCodeTaskMeta[]> {
      const tasks = await taskIndexRepo.listTaskMetas({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: GLM_PROVIDER,
        archived: true,
      });
      return tasks.map(rememberIndexedTaskMeta);
    },

    // 读取任务历史快照（首屏/冷恢复主入口）。
    // 流程：解析 resume hint → resumeSnapshotOrLegacy → 投影成旧快照 → 裁剪消息 → 对账 index。
    // 两条分支的 meta 来源不同：legacy 分支 index meta 优先、旧文件兜底；
    // session 分支以 snapshot 派生 meta 为准，index 只负责落库。
    // 全程记录分阶段耗时，用于区分“CLI 慢”与“投影/裁剪慢”。
    async getTaskSnapshot(params): Promise<ZCodeTaskSnapshot | null> {
      const startedAt = Date.now();
      const resumeStartedAt = Date.now();
      const explicitModel = params.model?.trim();
      const explicitThoughtLevel = params.thoughtLevel?.trim();
      // 只有 replayable 首屏且未显式给全配置时才回填 index hint：
      // ui-resolved-only 表示 UI 已解析过模型，服务端再补会覆盖用户选择。
      const shouldBackfillTaskIndexResumeHints =
        params.clientMode === "web-remote-replayable" &&
        params.resumeModelPolicy !== "ui-resolved-only" &&
        (!explicitModel || !explicitThoughtLevel);
      // 回填失败不阻塞打开：resolveTaskIndexResumeHints 内部已 catch，
      // 返回 {} 表示按 workspace/draft 默认配置恢复（比打不开任务好）。
      const indexHints = shouldBackfillTaskIndexResumeHints
        ? await resolveTaskIndexResumeHints(params, "replayable_snapshot")
        : {};
      const model = explicitModel || indexHints.model;
      const thoughtLevel = explicitThoughtLevel || indexHints.thoughtLevel;
      // 该调用内部会 rememberTaskTarget，后续所有按 taskKey 的缓存都依赖这次登记。
      const restored = await resumeSnapshotOrLegacy({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        // 手机 replayable 首屏 snapshot 会先于后续 resumeTask 读取。
        // 这里必须把 task meta 解析出的历史模型和 thoughtLevel 传进 session/resume，
        // 避免冷恢复用 workspace/draft 默认配置污染 context window 与思考强度。
        model,
        thoughtLevel,
      });
      const resumeDurationMs = Date.now() - resumeStartedAt;
      // legacy 分支：先裁剪再取 index meta。
      // [权衡] index meta 优先只针对展示字段（标题/未读）；mode/provider/status 仍以旧文件为准，
      // 因为旧文件记录的是该会话最后一次真实运行配置，index 可能已被迁移改写。
      if (restored.kind === "legacy") {
        const limitStartedAt = Date.now();
        const legacySnapshot = limitTaskSnapshotMessages(restored.snapshot, params.messageLimit);
        const limitDurationMs = Date.now() - limitStartedAt;
        const indexStartedAt = Date.now();
        // index meta 是“当前展示事实”，旧文件 meta 是“历史运行事实”；
        // 两者都缺时才回落到 legacySnapshot.meta（即旧文件解析结果）。
        const indexedMeta = (await taskIndexRepo.getTaskMeta(params)) ?? legacySnapshot.meta;
        const indexDurationMs = Date.now() - indexStartedAt;
        logger.info(undefined, "[zcode-task-service] 历史快照读取完成", {
          clientMode: params.clientMode ?? "unknown",
          durationMs: Date.now() - startedAt,
          indexDurationMs,
          limitDurationMs,
          messageLimit: params.messageLimit ?? null,
          resumeDurationMs,
          snapshotKind: "legacy",
          stats: getTaskSnapshotMessageDiagnostics(legacySnapshot),
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspacePath: params.workspacePath,
        });
        // 用 spread 覆盖 meta：legacy 快照的 runtime 只补 apiRetry/pendingCommands，
        // 其余字段保持旧文件原样；缺字段就是缺，不补默认值（INV-09）。
        return { ...legacySnapshot, meta: indexedMeta };
      }
      // session 分支：先投影再裁剪。裁剪必须在投影之后，
      // 否则 goal 轮次与后台任务索引会基于被截断的消息集合计算，轮次号错位。
      const snapshot = restored.snapshot;
      const projectionStartedAt = Date.now();
      // includeEmptyPendingElicitations 与 clientMode 绑定传入：投影函数不知道调用方是谁，
      // 只有这里能决定“空队列”要不要显式表达。
      const zcodeSnapshot = limitTaskSnapshotMessages(
        snapshotToZCode(snapshot, {
          includeEmptyPendingElicitations: params.clientMode === "web-remote-replayable",
        }),
        params.messageLimit,
      );
      const projectionDurationMs = Date.now() - projectionStartedAt;
      // 恢复先从 CLI 对账事实，再补模型/思考深度/正文；快照不再推导持久状态。
      const indexStartedAt = Date.now();
      // 同步失败会直接抛错：此时不应返回一份与 index 不一致的快照。
      // 与 legacy 分支相反——legacy 读不到 index 也能返回旧文件；session 分支的 meta 本身
      // 派生自 snapshot，写失败说明 index 不可用，继续返回会掩盖故障。
      const indexedMeta = await syncTaskIndexSnapshot(snapshot);
      const indexDurationMs = Date.now() - indexStartedAt;
      logger.info(undefined, "[zcode-task-service] 历史快照读取完成", {
        clientMode: params.clientMode ?? "unknown",
        durationMs: Date.now() - startedAt,
        indexDurationMs,
        messageLimit: params.messageLimit ?? null,
        projectionDurationMs,
        resumeDurationMs,
        snapshotKind: "session",
        stats: getTaskSnapshotMessageDiagnostics(zcodeSnapshot),
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return { ...zcodeSnapshot, meta: indexedMeta };
    },

    // 带 ETag 的快照读取：ETag = sha256(JSON.stringify(snapshot))。
    // [权衡] 整份序列化再哈希会多一次内存拷贝，但比维护增量版本号可靠：快照是投影产物，
    // 没有可比较的 revision，漏更新版本号会导致“内容已变但 304”。
    async getTaskSnapshotWithEtag(params) {
      const startedAt = Date.now();
      const snapshot = await service.getTaskSnapshot(params);
      // 快照为空时不生成 ETag：null 没有内容可比较，返回 { snapshot: null } 让 UI 走空态。
      if (!snapshot) {
        logger.info(undefined, "[zcode-task-service] 历史快照 ETag 读取为空", {
          clientMode: params.clientMode ?? "unknown",
          durationMs: Date.now() - startedAt,
          messageLimit: params.messageLimit ?? null,
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspacePath: params.workspacePath,
        });
        return { snapshot: null };
      }
      const etagStartedAt = Date.now();
      const etag = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
      const etagDurationMs = Date.now() - etagStartedAt;
      // 命中返回 notModified:true 且 snapshot:null（不重复传正文）；
      // UI 必须保留本地已有快照，不能把 null 当成“任务被删”。
      if (params.ifNoneMatch && params.ifNoneMatch === etag) {
        logger.info(undefined, "[zcode-task-service] 历史快照 ETag 命中缓存", {
          clientMode: params.clientMode ?? "unknown",
          durationMs: Date.now() - startedAt,
          etagDurationMs,
          messageLimit: params.messageLimit ?? null,
          stats: getTaskSnapshotMessageDiagnostics(snapshot),
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspacePath: params.workspacePath,
        });
        return { snapshot: null, etag, notModified: true };
      }
      logger.info(undefined, "[zcode-task-service] 历史快照 ETag 生成完成", {
        clientMode: params.clientMode ?? "unknown",
        durationMs: Date.now() - startedAt,
        etagDurationMs,
        messageLimit: params.messageLimit ?? null,
        stats: getTaskSnapshotMessageDiagnostics(snapshot),
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return { snapshot, etag };
    },

    // 首屏预算裁剪后的补拉接口：本链路不做 body/ref/toolCalls 三段式切片，
    // 快照一次性返回完整消息（由 messageLimit 控制窗口），因此恒返回 null。
    // [权衡] 返回 null 而不是抛 unsupported：调用方按“无该切片”回退到已持有正文。
    async getTaskSnapshotBody(): Promise<ZCodeTaskSnapshotBody | null> {
      return null;
    },

    // 同上：无 ref 切片。真正迁到分段快照时，需与 snapshotToZCode 的裁剪口径一起改。
    async getTaskSnapshotRef(): Promise<ZCodeTaskSnapshotRefContent | null> {
      return null;
    },

    // 不做 tools 增量切片：tools 随消息体返回，messageLimit 之外的整条消息被裁掉而非部分裁剪。
    async getTaskSnapshotToolCallsSlice(): Promise<ZCodeTaskSnapshotToolCallsSlice | null> {
      return null;
    },

    // 轻量 meta 读取：只查 index，不碰 CLI。无行返回 null（任务不存在），
    // 与“存在但字段为空”区分开（INV-09）。
    // 纯读接口不写 target 缓存，避免一次远端查询覆盖本地命令路由。
    async getTaskMeta(params): Promise<ZCodeTaskMeta | null> {
      const meta = await taskIndexRepo.getTaskMeta(params);
      return meta ? rememberIndexedTaskMeta(meta) : null;
    },

    // 读当前 active task 的配置选项：resumeSnapshot 会确保 runtime 存在，但不写 index；
    // 失败向上抛，UI 显示配置不可用而不是空白面板。
    // 与 getTaskSnapshot 的区别是不返回 messages，调用方只需要配置面板数据。
    async getTaskConfigOptions(params): Promise<ZCodeConfigOption[]> {
      const snapshot = await resumeSnapshot(getTaskTarget(params.taskId));
      return settingsToConfigOptions(snapshot.settings);
    },

    // 读会话当前模型选择：直接 readSession，不做候选解析也不写入。
    // current 为 null 表示尚未绑定模型（新会话），保留 null 而不是猜默认模型。
    // index 的 model 列由 snapshot 同步更新，这里不读 index，避免读到滞后值。
    async getTaskModelSelection(params): Promise<ModelSelection | null> {
      const target = getTaskTarget(params.taskId);
      const snapshot = await options.zcodeAgentService.readSession({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: params.taskId,
      });
      return snapshot.settings.model.current ?? null;
    },

    // 本地反馈（点赞/点踩）：只在返回的 snapshot 对象上打标，不落盘、不发命令——
    // 这是 UI 本地态，回写会被下一次快照覆盖。turnIndex 指 assistant 消息序号而非全局下标。
    // 返回新对象而不是原地改：调用方可能持有上一份快照做 diff，原地改会污染其基线。
    async setAssistantMessageFeedback(params): Promise<ZCodeSessionFile> {
      const snapshot = await service.getTaskSnapshot(params);
      // 快照缺失说明 task 不存在：unsupported 抛稳定错误，同时让类型收窄为非空。
      if (!snapshot) {
        unsupported("setAssistantMessageFeedback");
      }
      const assistantMessages = snapshot.messages.filter((message) => message.role === "assistant");
      // 只在 assistant 子集里按下标取：user 消息不参与点赞，
      // 用全局下标会让 turnIndex 与 UI 的轮次编号错位。
      const targetMessage = assistantMessages[params.turnIndex];
      if (targetMessage) {
        targetMessage.feedback = params.feedback as ZCodeAssistantMessageFeedback | undefined;
      }
      return snapshot;
    },

    // 旧协议的会话绑定同步在 ZCode 链路无对应语义（绑定由 session workspace 字段承载），
    async syncTaskSessionBinding(): Promise<ZCodeSyncTaskSessionBindingResult> {
      unsupported("syncTaskSessionBinding");
    },

    // 切换 agent（旧多后端）已不在本链路：provider 固定为 ZCode，无可切对象。
    async switchAgent(): Promise<ZCodeSwitchAgentResult> {
      unsupported("switchAgent");
    },

    // 扫描可导入的 Claude Code 会话：数据源是 ~/.claude/projects 的 jsonl，按文件内 cwd 与
    // 可选 workspacePath 过滤；workspaceIdentity 不参与扫描。
    // 这是迁移向导入口，不是新链路依赖。
    // 只读操作：不创建会话、不写 index，副作用仅为读文件系统。
    async scanImportableClaudeSessions(params: {
      workspacePath?: string;
      workspaceIdentity?: string;
      modifiedSince?: number;
      limit?: number;
    }): Promise<ZCodeImportableSessionCandidate[]> {
      // legacy ACP 下线后 scanImportableClaudeSessions 被留成空桩，迁移向导扫不到 ~/.claude/projects。
      // workspaceIdentity 仅影响导入落盘目录，扫描仍按 jsonl 内 cwd 与可选 workspacePath 过滤。
      void params.workspaceIdentity;
      return claudeNativeSessionImportRepo.scanImportableSessions({
        workspacePath: params.workspacePath,
        modifiedSince: params.modifiedSince,
        limit: params.limit,
      });
    },

    // 导入 Claude Code 会话：每个来源会话都新建一条真实 ZCode session，而非只写 index 行——
    // 否则后续 setModel/sendPrompt 找不到 runtime。
    // 单条失败在 importClaudeNativeSessions 内部按 session 汇总，不在这里中断整批。
    // 每个来源会话互不依赖：已成功的不会因后续失败而回滚。
    async importClaudeSessions(params: {
      workspacePath?: string;
      workspaceIdentity?: string;
      sessionIds: string[];
    }): Promise<ZCodeImportSessionsResult> {
      return importClaudeNativeSessions({
        taskIndexRepo,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        sessionIds: params.sessionIds,
        // 导入历史必须 immediate 持久化：导入后可能立刻 resume，deferred 会让会话不存在。
        createImportedSession: async (source) => {
          // 显式给 workspacePath 时沿用调用方 identity（可能是远程 workspace）；不给时留空，
          // 由 CLI 按路径派生，避免写入错误的身份 key。
          const targetWorkspaceIdentity = params.workspacePath
            ? params.workspaceIdentity
            : undefined;
          const snapshot = await options.zcodeAgentService.createSession({
            workspacePath: source.workspacePath,
            workspaceIdentity: targetWorkspaceIdentity,
            // 显式重新导入产生新 CLI 会话，不能用来源 hash 覆盖已删除或已继续对话的记录。
            sessionTraceId: createSessionTraceId(),
            persistence: "immediate",
            importedHistory: {
              source: "claudeCode",
              title: source.title,
              createdAt: source.createdAt,
              updatedAt: source.updatedAt,
              messages: source.messages.map((message) => ({
                role: message.role,
                content: message.content,
                timestamp: message.timestamp,
              })),
            },
          });
          // 导入后先对账 index（写入正文/标题），再补 migrationSource 展示标记。
          const meta = await syncTaskIndexSnapshot(snapshot);
          // 导入后的任务必须是真实 ZCode session，setModel/sendPrompt 才能继续命中 runtime。
          // 同时保留 migrationSource，避免任务列表把 Claude Code 迁移历史当成本地新会话。
          return updateIndexedPresentation({ ...meta, migrationSource: "claudeCode" });
        },
        // 单个任务导入完成：先 remember（内存 target 表），再广播 task_meta_changed。
        // 用旧语义而不是 task_created，是因为列表项可能已由批量导入预插入。
        onTaskImported: (meta) => {
          rememberIndexedTaskMeta(meta);
          emitWorkspaceTaskListChanged(
            {
              workspacePath: meta.workspacePath,
              workspaceIdentity: meta.workspaceIdentity,
              taskId: meta.taskId,
            },
            meta,
            // 导入沿用 task_meta_changed 旧语义。
            "task_meta_changed",
          );
        },
      });
    },

    // 切换协作模式：非 auto 走 v4 CAS 命令，auto 仍走旧 op（v4 值域刻意排除 auto）。
    // 副作用：写 CLI 投影 → resumeSnapshot 重读 → syncTaskIndexSnapshot 落 index。
    // [失败路径] 任一环节失败直接上抛、不广播：mode 只有 CLI 接受后才算生效。
    // 与 setConfigOption 的 MODE 分支共用同一条协议路径，避免两处值域转换分叉。
    async setMode(params): Promise<void> {
      // session/setMode → v4 switchCollaborationMode（CAS，revision 收敛见
      // sendHostCasCommandV4）。v4 handler 不发旧 state.updated，观察端一致性与桌面
      // v4 工具条切换同批（读路径 v4 store 收口）；发起端由下方 resumeSnapshot 保真。
      const target = getTaskTarget(params.taskId);
      // 缺省回落 "build"：旧协议允许不带 mode，v4 命令要求显式值；选 build 与 UI 默认一致。
      await switchCollaborationModeViaProtocol(target, toZCodeMode(params.mode) ?? "build");
      const snapshot = await resumeSnapshot(target);
      await syncTaskIndexSnapshot(snapshot);
    },

    // 通用配置写入，按 configId 分三条路径：
    //   MODEL_CONFIG_ID → setModel（需要 provider 凭据解析，未迁 v4）
    //   THOUGHT_LEVEL_CONFIG_ID → v4 switchModelConfig（同 provider+model，仅换 thought）
    //   MODE_CONFIG_ID → 协作模式切换
    async setConfigOption(params): Promise<ZCodeConfigOption[]> {
      const target = getTaskTarget(params.taskId);
      // 模型配置委托 service.setModel：它内部走旧 session/setModel 并返回完整 configOptions，
      // 这里不再重复 resume，避免两次快照。
      if (params.configId === MODEL_CONFIG_ID) {
        return service.setModel({
          taskId: params.taskId,
          traceId: params.traceId,
          modelSelection: parseModelPickerValue(params.value),
        });
      }
      if (params.configId === THOUGHT_LEVEL_CONFIG_ID) {
        // session/setThoughtLevel → v4 switchModelConfig（v4 无独立思考深度命令，
        // thought 字段承载；provider/model 取当前会话选型，与桌面 v4 工具条同一命令面）。
        // 同 provider 同 model 直切，不涉及 runtimeModel（provider 凭据）解析——这正是
        // setModel 尚不能迁移的原因（见下方 setModel 标注）。
        // 思考档位必须先读当前模型：v4 switchModelConfig 要求 provider+model 必填，
        // 单独换档不能猜模型（猜错会把会话切到别的 provider）。
        const current = await options.zcodeAgentService.readSession({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          sessionId: params.taskId,
        });
        const model = current.settings.model.current;
        // 未绑定会话可以查看，但单独切档位不能猜测 Provider/Model。
        // 新会话尚未绑定模型：抛错让用户先选模型。若静默用 workspace 默认模型，
        // 用户会在不知情下被切换 provider。
        if (!model) throw new Error("请先选择模型，再设置思考档位");
        await sendConfigCasCommandV4(
          target,
          "switchModelConfig",
          {
            provider: model.providerId,
            model: model.modelId,
            thought: params.value,
          },
          `session=${params.taskId} thought=${params.value}`,
        );
      // 模式配置：只切协作模式，不碰模型；失败向上抛，不吞成“部分成功”。
      } else if (params.configId === MODE_CONFIG_ID) {
        await switchCollaborationModeViaProtocol(
          target,
          toZCodeMode(params.value as ZCodeTaskMode) ?? "build",
        );
      }
      // 三条路径统一在此对账：读一次 session 并把 settings 写回 index，
      // 返回的 configOptions 是 CLI 真实状态而非本地期望值。
      const snapshot = await resumeSnapshot(target);
      await syncTaskIndexSnapshot(snapshot);
      return settingsToConfigOptions(snapshot.settings);
    },

    // 设置模型：仍走旧 op（需要 runtimeModel/provider 凭据解析与返回快照），
    // 模型执行事实已收敛到目标 Worker Registry，Host 只发送 Selection。
    // 过渡归宿 = task facade 原生消费 V4 config 投影与 revision。
    async setModel(params): Promise<ZCodeConfigOption[]> {
      // replayable facade 仍依赖 legacy op 返回的 Session
      // Snapshot；模型执行事实已经收敛到目标 Worker Registry，Host 只发送 Selection。
      // 过渡归宿 = task facade 原生消费 V4 config 投影与 revision。
      const target = getTaskTarget(params.taskId);
      // 只信任结构化 ModelSelection：旧面传的 modelId 可能只是 UI 运行态模型名（如 gpt-5.5），
      // 多个自定义 provider 同名时按名字解析会命中错误 provider。
      await options.zcodeAgentService.setModel({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: params.taskId,
        // replayable/legacy facade 的 modelId 可能只是 UI 运行态模型名（如 gpt-5.5）。
        // 多个自定义 provider 同名时只能信任 UI 传入的结构化 ModelSelection。
        model: params.modelSelection,
      });
      // 写后必须重新读快照：旧 op 的返回可能不含全量派生字段，
      // 直接复用会把不完整状态广播给 UI。
      const snapshot = await resumeSnapshot(target);
      await syncTaskIndexSnapshot(snapshot);
      return settingsToConfigOptions(snapshot.settings);
    },

    // automation 专用会话配置写入：模型 + 思考档位 + 模式一次收敛。
    // 输入是结构化 ModelSelection（provider/model 已由表单解析），本层不做候选解析。
    // 副作用：1~2 条 v4 CAS 命令 +（模式变化时）协作模式命令 + resume/sync 对账。
    // [失败路径] 任一命令 ACK 失败即抛；先前已生效的命令不回滚（CLI 侧已是新状态）。
    async setAutomationSessionConfig(params): Promise<ZCodeConfigOption[]> {
      const target = getTaskTarget(params.taskId);
      const model = params.modelSelection;
      // thoughtLevel 缺省归一成空串：空串表示“不指定”，与 undefined 走同一条“不改 thought”分支，
      // 避免序列化差异。
      const thoughtLevel = params.thoughtLevel?.trim() ?? "";
      // automation 过去先走 legacy session/setModel，再发 V4 Think。若目标模型
      // 已带相同默认 Think，第二步会 noop 且不产 ModelSelected，导致 runtime 已切换但
      // conversation 投影仍显示旧模型。这里用一条 V4 命令原子更新 runtime 与投影。
      // provider/model/thought 同一条命令：v4 handler 在同一次 CAS 事务里写两处投影。
      await sendConfigCasCommandV4(
        target,
        "switchModelConfig",
        {
          provider: model.providerId,
          model: model.modelId,
          thought: thoughtLevel,
        },
        `automation session=${params.taskId} model=${model.providerId}/${model.modelId} thought=${thoughtLevel}`,
      );
      if (thoughtLevel) {
        // 跨模型 switchModelConfig 会先采用目标模型默认 Think，避免误用源模型档位。
        // automation 的 thought 已由创建/编辑表单按目标模型校验，可在模型事件落地后
        // 再以同模型命令显式收敛；同默认值时 noop，非默认值时发布第二个 config delta。
        await sendConfigCasCommandV4(
          target,
          "switchModelConfig",
          {
            provider: model.providerId,
            model: model.modelId,
            thought: thoughtLevel,
          },
          `automation session=${params.taskId} thought=${thoughtLevel}`,
        );
      }
      // 模式单独走协作模式命令：模式与模型是两个命令面，合并会破坏 CAS 语义。
      if (params.mode?.trim()) {
        await switchCollaborationModeViaProtocol(target, toZCodeMode(params.mode) ?? "build");
      }
      // 最终统一对账：automation 后续可能立即 sendText，index 里的 model/mode
      // 必须已是落库值，否则首条 prompt 会带旧配置。
      const snapshot = await resumeSnapshot(target);
      await syncTaskIndexSnapshot(snapshot);
      return settingsToConfigOptions(snapshot.settings);
    },

    // [段内导读] 2949-3229 是 service 对象的委派方法：查询类只读 tasks-index / agent SQLite，
    // 变更类统一走 taskIndexRepo（CAS 落库）+ taskIndexSyncer（广播）；3232 之后是本文件的纯映射函数。
    // 读这段抓住两条线：谁能写 tasks-index（只有 repo/syncer），以及事件在哪一层被归一化。
    // 旧 task 面在这里只做字段级 join 与协议转换，不新增第二份会话/队列状态（INV-01、INV-10）。
    // 旧面要求每个 workspace 有一份 provider 配置文件；ZCode 链路的 provider 由 CLI 运行时持有，
    // Host 侧没有对应文件，因此本方法固定返回 exists:false 的占位描述。
    // [权衡] 不抛错而是返回占位：UI 用 exists 决定是否渲染「打开配置」入口，抛错会让整个
    // workspace 面板无法渲染；若将来引入落盘的 provider 配置，必须在此返回真实路径而不是改调用方。
    async getWorkspaceProviderConfigFile(params) {
      return {
        provider: GLM_PROVIDER,
        path: params.workspacePath,
        exists: false,
      };
    },

    // 任务级日志入口固定指向当前进程的结构化 JSONL；日志内每行的 sessionId 才是任务维度过滤依据，
    // 因此这里刻意不接受 taskId，避免造成「按 task 返回不同文件」的假象。
    // exists 每次同步 stat 一次、不做缓存：进程轮转（重启/换日志文件）后缓存会指向旧文件，
    // 而 UI 打开日志是低频操作，这点 IO 可以接受。
    async getTaskNativeSessionLogFile() {
      const path = resolveZCodeAgentCurrentLogFilePath();
      // 返回 ZCode Agent 的结构化日志 JSONL；日志行中的 sessionId 用于按当前任务排查。
      return { provider: GLM_PROVIDER, path, exists: existsSync(path) };
    },

    // 轨迹查询把 taskId 直接当作 sessionId（本文件全程 taskId 与 ZCode sessionId 一对一），
    // 只读 model-io 落盘记录，不改运行时状态；失败时异常原样上抛，由调用方降级为空轨迹。
    // limit 的尾部截断在 readModelTrajectory 内部完成，这里只记录命中数量，便于排查「轨迹为空」。
    // 返回的 sourceFiles 是命中的落盘文件列表，供 UI 展示数据来源，不参与任何判定。
    async getModelTrajectory(params) {
      // ZCode Agent 把 taskId 当作 sessionId 落盘 model-io（见本文件其它 sessionId: params.taskId 用法），
      // 这里按 sessionId 还原该 task 的模型调用轨迹，供 UI 侧边栏可视化。
      const trajectory = await readModelTrajectory(params.taskId, params.limit);
      logger.info(
        `[ZCodeTaskService] getModelTrajectory taskId=${params.taskId} records=${trajectory.records.length} files=${trajectory.sourceFiles.length} truncated=${trajectory.truncated}`,
      );
      return trajectory;
    },

    // token 用量必须来自同一条事实源：桌面本地与手机远控都读 agent SQLite 的 model_usage 聚合，
    // 不把 usage_update 的 context window 当累计消耗（二者口径不同，混用会给出错误账单）。
    // [并发] 这是请求-响应式读取，不持有 session 订阅；workspace 进程重启期间的失败由调用方重试。
    async getTaskTokenUsage(params): Promise<ZCodeTaskTokenUsageResult> {
      // 摘要面板需要展示 task 的累计模型消耗，不能复用 usage_update 的 context window。
      // 这里通过 ZCode Protocol 读 agent SQLite 的 model_usage 聚合，保持桌面和远控同一事实源。
      return options.zcodeAgentService.getTaskTokenUsage({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        sessionId: params.taskId,
      });
    },

    // 旧接口要求返回可打开的历史文件；ZCode 的会话历史在 agent SQLite / CLI 侧，不存在该后缀文件。
    // 返回 exists:false 而非抛错，保持与 getWorkspaceProviderConfigFile 相同的降级契约。
    // 路径字符串仍按旧面格式拼出，仅为满足调用方对 path 字段的非空预期，不保证可读。
    async getTaskSessionFilePath(params) {
      return {
        path: `${params.workspacePath}/${params.taskId}.zcode-session`,
        exists: false,
      };
    },

    // 重启语义被收敛为「先 dispose，再等下一次 getClient 懒启动」：这里不主动拉起进程，
    // 因为重启时机由调用方的下一次请求决定，提前启动会与并发请求竞争同一 workspace 槽位。
    // [资源] disposeWorkspace 负责释放该 workspace 的 client/订阅/pending，本方法不额外持有句柄。
    async restartWorkspaceProcess(params): Promise<void> {
      await options.zcodeAgentService.disposeWorkspace(normalizeWorkspaceParams(params));
    },

    // 删除以 session facts 变更的形式下发，由 syncer 保证 tasks-index 与 sessions-index 一致；
    // adapter 不直接删 task 行，否则会绕开组织态（pin/archive/group）的清理顺序（INV-10）。
    // 失败直接抛出：调用方依赖异常判断删除未生效，不返回布尔值以免掩盖「部分索引已清」的中间态。
    async deleteTask(params): Promise<void> {
      await taskIndexSyncer.mutateSessionFacts(
        { ...params, sessionId: params.taskId },
        { type: "delete" },
      );
    },

    // 只允许删已归档任务：repo.deleteArchivedTask 自带 archive guard，返回 undefined 表示
    // 「任务不存在或未归档」，此时不广播也不改 facts，避免把活跃任务从索引里抹掉。
    // 先落库再改 facts、最后广播：反序会让 UI 在数据尚未提交时先收到删除事件，刷新又读回旧行。
    // 返回 true/false 而不是抛错：单个删除的「不存在」是调用方可接受的常态，批量接口另有三分类结果。
    async deleteArchivedTask(params): Promise<boolean> {
      const meta = await taskIndexRepo.deleteArchivedTask(params);
      if (!meta) return false;
      await taskIndexSyncer.mutateSessionFacts(
        { ...params, sessionId: params.taskId },
        { type: "delete" },
      );
      emitWorkspaceTaskListChanged(params, meta, "task_deleted");
      return true;
    },

    // 批量删除是「逐项独立事务 + 单次广播」：单条失败只进 failedTaskIds，不回滚已成功项，
    // 也不因此跳过剩余项；返回值三分类让 UI 能精确提示哪些没删掉。
    // [并发] 批次间不复用 repo 事务；taskIndexSyncer.mutateSessionFacts 内部对同一 workspace 串行化。
    // 入参先去重：重复 taskId 若不去重，第二次会因 archive guard 判成 skipped，污染统计与 UI 提示。
    // deleted / skipped / failed 的划分只由 repo 返回值与异常决定，不在这里做二次推断。
    // [资源] 循环内只依赖请求级对象，不持有订阅或定时器；提前 return 的分支也不会遗留句柄。
    async deleteArchivedTasks(params): Promise<ZCodeArchivedTaskDeletionResult> {
      const result: ZCodeArchivedTaskDeletionResult = {
        deletedTaskIds: [],
        skippedTaskIds: [],
        failedTaskIds: [],
      };
      const taskIds = [...new Set(params.taskIds)];
      if (taskIds.length === 0) return result;
      const startedAt = Date.now();
      for (const taskId of taskIds) {
        const target = {
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          taskId,
        };
        try {
          // 保留逐项事务与归档 guard：一项失败不能回滚其它成功项，也不能提前隐藏失败项。
          const meta = await taskIndexRepo.deleteArchivedTask(target);
          if (!meta) {
            result.skippedTaskIds.push(taskId);
            continue;
          }
          await taskIndexSyncer.mutateSessionFacts(
            { ...target, sessionId: taskId },
            { type: "delete" },
          );
          result.deletedTaskIds.push(taskId);
        } catch (error) {
          result.failedTaskIds.push(taskId);
          logger.warn(undefined, "[ArchivedTaskDeletion] 批次目标删除失败", { ...target, error });
        }
      }
      if (result.deletedTaskIds.length > 0) {
        // 根因：循环调用单条接口会逐项广播，驱动 Host 与 UI 各自全量重读。
        // 批次完成只发一次 workspace 事件，仍使所有观察端换代 deleted membership，防止任务复活。
        emitWorkspaceTaskListChanged(params, undefined, "task_deleted");
      }
      logger.info(undefined, "[ArchivedTaskDeletion] batch completed", {
        workspaceKey: resolveWorkspaceKey(params),
        requested: taskIds.length,
        deleted: result.deletedTaskIds.length,
        skipped: result.skippedTaskIds.length,
        failed: result.failedTaskIds.length,
        durationMs: Date.now() - startedAt,
      });
      return result;
    },

    // 重命名只改 title 这一个投影字段，仍走 syncer 以复用同一把 workspace 级串行化。
    // 返回 undefined 代表任务行不存在（可能已被并发删除），转成稳定错误文本抛出而非静默成功；
    // 这里用 Error 文本而非 code：旧面调用方按 message 展示，属迁移期的已知妥协（对照 INV-05）。
    async renameTask(params): Promise<ZCodeTaskMeta> {
      const meta = await taskIndexSyncer.mutateSessionFacts(
        { ...params, sessionId: params.taskId },
        { type: "rename", title: params.title },
      );
      if (!meta) throw new Error("task.not-found");
      return meta;
    },

    // pin 属于组织态，唯一写入点是 tasks-index；适配层只做参数翻译 + 事后广播，
    // 不在内存里维护第二份 pin 集合（否则断线重连后与索引分叉，INV-10）。
    // reason 按目标状态分成 task_pinned / task_unpinned，UI 据此只刷新对应列表的 membership。
    async setTaskPinned(params): Promise<ZCodeTaskMeta> {
      const meta = await updateIndexedTaskState(params, {
        pinned: params.pinned,
      });
      emitWorkspaceTaskListChanged(params, meta, params.pinned ? "task_pinned" : "task_unpinned");
      return meta;
    },

    // 取消未读走 CAS 分支：expectedUnreadAt 存在时必须「值匹配才清」，
    // 保证旧的「标记已读」请求不会把随后到达的新未读一起清掉。
    // 标记未读走普通写入：unreadAt 用当前毫秒时间戳作为 marker，顺序由 tasks-index 决定。
    async setTaskUnread(params): Promise<ZCodeTaskMeta> {
      if (!params.unread && typeof params.expectedUnreadAt === "number") {
        const result = await taskIndexRepo.clearTaskUnreadIfMatches({
          taskId: params.taskId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          expectedUnreadAt: params.expectedUnreadAt,
        });
        // Bug 原因：旧手机点击可能晚于新的终态未读到达。CAS 未命中时必须把当前 meta
        // 广播出去让 renderer 对账，不能先乐观清除后留下 renderer-only 已读状态。
        if (result.cleared) {
          emitWorkspaceTaskListChanged(params, result.meta, "task_meta_changed");
        }
        return result.meta;
      }

      // repo 可能为避免同毫秒 CAS 版本碰撞而推进 unreadAt，因此下面广播的是 persist 后的 meta，
      // 而不是这里的 unreadAt；用本地值广播会让 renderer 的后续 CAS 全部落空。
      const unreadAt = params.unread ? Date.now() : undefined;
      const meta = await updateIndexedTaskState(params, { unreadAt });
      // Bug 原因：repository 可能为避免同毫秒 CAS 版本碰撞而推进 unreadAt；
      // 必须把最终持久值广播给 renderer 对账，否则后续 snapshot 会继续暴露旧 marker。
      // unread 归属在 tasks-index、sessions-index 不携带，必须走 task_meta_changed 触发 membership 重拉。
      emitWorkspaceTaskListChanged(params, meta, "task_meta_changed");
      return meta;
    },

    // 归档只切 archived 标志，不移动消息、不改 session 生命周期：归档态只影响列表 membership，
    // 不影响会话可订阅性；恢复由 unarchiveTask 反向写回 archived:false。
    async archiveTask(params): Promise<ZCodeTaskMeta> {
      const meta = await updateIndexedTaskState(params, { archived: true });
      emitWorkspaceTaskListChanged(params, meta, "task_archived");
      return meta;
    },

    // 取消归档是 archived:false 的反向写入，同样经 updateIndexedTaskState 做 CAS，
    // 避免两个端同时改归档态时后者静默覆盖前者。
    async unarchiveTask(params): Promise<ZCodeTaskMeta> {
      const meta = await updateIndexedTaskState(params, { archived: false });
      emitWorkspaceTaskListChanged(params, meta, "task_unarchived");
      return meta;
    },

    // 旧面的「从某条 prompt 分叉」在新链路没有等价能力（session fork 的语义不同）。
    // [失败路径] 用 unsupported 抛出带稳定 code 的错误，而不是返回空结果：调用方必须显式感知
    // 该能力缺失，避免 UI 以为分叉成功却拿不到新任务。
    // 这也是 INV-08 的删方法判据：没有 V4 等价能力之前，只能保留显式失败，不能假装可用。
    // unsupported 的 never 返回类型让调用方无需再写 return，编译期即知该分支不会产出值。
    async branchTaskFromPrompt(): Promise<ZCodeTaskCreateResult> {
      unsupported("branchTaskFromPrompt");
    },

    // 全局 stream 订阅按 taskId 索引、不分 workspace：调用方只有 taskId，且 taskId 全局唯一；
    // 若改成按 taskKey 索引，这里就必须先反查 workspace，反而把路由责任推给订阅方（INV-04）。
    // 返回的 Event 不持有上游订阅，因此无需 dispose；emitter 生命周期由 disposeLocalTaskState 统一回收。
    onDynamicStreamEvent(taskId: string): Event<ZCodeStreamEvent> {
      return getGlobalTaskEmitter(taskId).event;
    },

    onDynamicTaskTerminalOutcome(taskId: string): Event<ZCodeTaskTerminalOutcome> {
      // 合并迁移：V4 syncer 只暴露归一化后的终态 kind，不再携带旧协议 event payload。
      // automation 只需要稳定收口运行结果，因此 completed/failed 在此映射为公开 outcome。
      return (listener) =>
        // 订阅方按 taskId 扇出：syncer 的终态事件带 target.sessionId，非本任务的事件必须丢弃，
        // 否则同一 workspace 下并行任务的失败会串到当前 task 的 automation（INV-04）。
        taskIndexSyncer.onSessionTerminalEvent((terminal) => {
          if (terminal.target.sessionId !== taskId) {
            return;
          }
          const target = {
            taskId,
            workspacePath: terminal.target.workspacePath,
            workspaceIdentity: terminal.target.workspaceIdentity,
          };
          // inputId 是本轮用户输入的 trace 关联键，终态时可能已被释放；拿不到就不带该字段，
          // 而不是补一个假 id 让下游对不上账。
          const inputId = activePromptInputIds.get(taskKey(target));
          listener({
            taskId,
            ...(inputId ? { inputId } : {}),
            // 只把 turn.failed 判为 failed，其余终态都算本轮已收口；事件词表的新增只应改 syncer 的
            // kind 归一化，不应在这里继续加分支，否则两端会形成两套终态判定。
            outcome: terminal.kind === "turn.failed" ? "failed" : "succeeded",
          });
        });
    },

    // ready 事件表示 session 已可接受输入（create/resume 完成），automation 用它决定何时下发下一步。
    // 与终态订阅一样只按 taskId 过滤，reason 直接透传 syncer 的归一化结果，不在适配层重新解释。
    // 这里不校验 workspace：taskId 已能唯一定位会话，多带一次 workspace 比较反而在身份字段缺失时误杀。
    onDynamicTaskReady(taskId: string): Event<ZCodeTaskReadyOutcome> {
      return (listener) =>
        taskIndexSyncer.onSessionReadyEvent((ready) => {
          if (ready.target.sessionId !== taskId) {
            return;
          }
          listener({ taskId, reason: ready.reason });
        });
    },

    // 动态 task 事件是「本地 emitter + 可选上游 session 订阅」的复合入口：
    // 1) 先记住 target，保证后续 emit/mapping 能按 taskKey 找到 workspace、cronAutomationId 等上下文；
    // 2) 订阅拆除时必须同时释放本地 emitter 与上游订阅，任一遗漏都会在热重载后泄漏回调（INV-07）。
    // [并发] rememberTaskTarget 是幂等覆盖写，同一 taskId 只保留最后一次 target，sticky 字段单独合并。
    // 这里把 rememberTaskTarget 放在订阅创建之前：订阅建立后立刻到达的事件也要能找到 workspace 上下文。
    // target 不含 deliveryKind，deliveryKind 只在建立上游订阅时使用，避免把订阅参数混进任务身份。
    onDynamicTaskEvent(params): Event<ZCodeStreamEvent> {
      const target = {
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      };
      rememberTaskTarget(target);
      return (listener) => {
        // 本地 emitter 先订阅：adapter 自己发出的元数据事件（rename/archive）不依赖上游 session 订阅，
        // 先就位可保证上游不可用时本地链路仍然可用。
        const localDisposable = getTaskEmitter(target).event(listener);
        if (legacySnapshotTaskKeys.has(taskKey(target))) {
          // Bugfix: legacy ACP task 没有 zcode-cli sqlite session，恢复后只能作为只读历史。
          // 若继续向 ZCode Protocol 建 desktop-continuous/replayable 订阅，会反复触发
          // Session is not active 并刷爆日志；本地 emitter 已足够承接 rename/archive 等元数据事件。
          return localDisposable;
        }
        // M5 ③-2 复核（2026-07-06）：这里仍是 services/ 内旧 session/subscribe 词表的
        // 最后消费点（replayable/bots 的 stream 投影源）。写路径（send/stop/交互回执）
        // 本波已收敛 v4 命令；读路径消费方是 bots handleStreamEvent（10 种事件词表）与
        // host 镜像 taskRealtimePort（词表同为 ZCodeStreamEvent），二者换 v4 帧 = relay
        // 协议 + 手机 store + bots 投影整波重做（且 ui/store 本波由并行 agent 主修，避让）。
        // 死期改判 = replayable 读路径 v4 store 波次（波次 3），与 host/index.ts 镜像、
        // mapStateUpdated/mapServiceEvent、agentService.onDynamicSessionEvent 同批摘除。
        // [失败路径] 上游 subscribe 同步抛错时，本函数已创建的 localDisposable 不会被返回，
        // 调用方拿不到句柄也就无法释放；这是只在 subscribe 立刻失败时出现的半订阅窗口。
        const upstreamDisposable = options.zcodeAgentService.onDynamicSessionEvent({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          sessionId: params.taskId,
          deliveryKind: toZCodeDeliveryKind(params.deliveryKind),
          includeSnapshot: params.deliveryKind === "replayable",
        })((event) => mapServiceEvent(target, event));
        // [资源] 复合 disposable 的释放顺序无强依赖，但必须两个都调：先断上游可阻止新事件进入
        // mapServiceEvent，再断本地可保证正在 fire 的回调不再重入。
        // [权衡] 不用一个共享开关做「是否已释放」判断：Event 的 dispose 本身幂等，多一层状态只增加分叉。
        return {
          dispose() {
            upstreamDisposable.dispose();
            localDisposable.dispose();
          },
        };
      };
    },

    // workspace 级事件（config / 任务列表变更）直接委托 syncer：adapter 与 desktop-continuous
    // 共用同一份 emitter，保证 UI 只按一个订阅源刷新，不会因为两条链路各发一次而抖动。
    // 这里不缓存 emitter 句柄：emitter 归属 syncer，adapter 提前持有会在 syncer.disposeAll 后变成悬空引用。
    onDynamicWorkspaceEvent(workspace): Event<ZCodeWorkspaceEvent> {
      return taskIndexSyncer.onDynamicWorkspaceEvent(workspace);
    },

    // 错误通道直接复用同一 emitter，不在这里过滤或包装：code 与 taskId 由发送方保证，订阅方按需筛选。
    onError: errorEmitter.event,

    // [资源] 同步 dispose 只保证「不再新增订阅」，不等待进程退出；bot scope 的 dispose 是异步的，
    // 这里刻意不 await（fire-and-forget），因为调用方是同步的 app 退出钩子，等待会阻塞主线程退出。
    // disposed 置位在函数开头：重复调用直接返回，避免二次 dispose 触发 emitter 对已释放资源的回调（INV-12）。
    // memoryDiagnostics 自身也是注册项，先注销它再拆其他表，否则计数回调会读到正在被清空的 Map。
    disposeAll(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      memoryDiagnostics.dispose();
      // syncer 持有 agentService 的 v4 帧订阅（sessions-index/workspace-config），
      // 必须在 agentService.disposeAll 前释放，否则 emitter dispose 时仍会回调到已失效的 syncer。
      // workspaceEmitters 已下沉到 syncer，由 syncer.disposeAll 统一回收。
      taskIndexSyncer.disposeAll();
      // [资源] bot scope 与 agentService 共享同一底层连接：必须在 agentService.disposeAll() 之前
      // 逐个释放，否则 service 侧先销毁 emitter，scope.dispose 再回调到已失效订阅会抛异常。
      for (const scope of botConnectionScopes.values()) void scope.dispose();
      botConnectionScopes.clear();
      options.zcodeAgentService.disposeAll();
      // 最后清 adapter 自己的 task 表（emitter/target/runtimeCommands）；放在 agentService 之后，
      // 保证销毁期间迟到的上游回调仍能按 taskKey 找到 target 而不抛 not-loaded。
      disposeLocalTaskState();
    },

    // 与 disposeAll 的差别只有两点：等待 bot scope 与 agent 进程树真正收口。
    // [资源] 顺序不可交换：先断订阅（避免清理期间仍有事件写索引），再等进程退出，最后释放本地表。
    // disposeZCodeAgentServiceAndWait 内部负责 SIGKILL 兜底 timer；若提前清表，兜底逻辑会读不到 task 归属。
    // 重复调用由开头 disposed 判断拦住，保证同一进程树不会被等待两次。
    async disposeAllAndWait(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      // app 退出必须先断开 task index syncer 的订阅，再等待 agent 进程树完成清理；
      // 否则 host 退出时会把 zcode-cli 的 SIGKILL 兜底 timer 一起带走。
      taskIndexSyncer.disposeAll();
      // [资源] 等所有 bot scope 完成再清表：清表后无法再对这些 scope 调 dispose，
      // 提前 clear 会让未完成的 dispose Promise 失去引用，进程退出时可能被直接截断。
      await Promise.all([...botConnectionScopes.values()].map((scope) => scope.dispose()));
      botConnectionScopes.clear();
      await disposeZCodeAgentServiceAndWait();
      disposeLocalTaskState();
    },
  };

  return service;
}

// 旧面参数可能带大量无关字段（UI state、权限、model 等）；只挑 workspace 身份下传，
// 防止 caller 的私有字段被当成协议字段透传到 V4（INV-02：身份只认 identity + path）。
// 这里刻意不 trim/规范化：身份 key 的归一化由 resolveWorkspaceKey 统一负责，避免两套规则。
function normalizeWorkspaceParams(params: {
  workspacePath: string;
  workspaceIdentity?: string;
}): ZCodeAgentWorkspaceTarget {
  return {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  };
}

// 标题解析必须与 UI 列表同源：session.title 为空时由首条用户消息推导，规则集中在
// resolveZCodeVisibleSessionTitle；适配层不复制一套「取第一条 content」的近似逻辑。
// target 一并传入：标题推导可能需要目标/项目名作为前缀，缺失会得到与 UI 不一致的标题。
function deriveTitleFromSnapshot(snapshot: ZCodeSessionStateSnapshot): string {
  return resolveZCodeVisibleSessionTitle({
    title: snapshot.session.title,
    messages: snapshot.messages,
    target: snapshot.projection.target,
  });
}

// [失败路径] 0 / 负数 / NaN / Infinity 一律视作「不裁剪」：调用方常用 0 表示未配置，
// 若按 0 裁剪会返回空历史，UI 首屏直接白屏。
// 合法值向下取整：上游可能传浮点，slice 的负数语义对小数不友好，先归一再使用。
function normalizeSnapshotMessageLimit(messageLimit: number | undefined): number | undefined {
  if (!messageLimit || !Number.isFinite(messageLimit) || messageLimit <= 0) {
    return undefined;
  }
  return Math.floor(messageLimit);
}

// history 与 messages 必须同一次构造下发：只裁剪 messages 不带 history 时，UI 只能靠
// 「返回条数 == limit」猜测还有更早历史，而尾部同样可能恰好等于 limit（INV-13）。
// totalMessages 传的是裁剪前总数，truncatedBefore 由它和窗口大小比较得出，二者必须同源。
function buildSnapshotHistory(
  totalMessages: number,
  messageLimit: number,
): NonNullable<ZCodeTaskSnapshot["history"]> {
  return {
    truncatedBefore: totalMessages > messageLimit,
    totalMessages,
  };
}

// 纯观测函数：遍历一次快照做计数，用于评估裁剪/附件/工具投影的体积，不改变入参也不缓存。
// [权衡] 放在适配层而不是 UI：这些计数要在手机 replayable 与桌面 continuous 两条链路一致，
// 放到 UI 会因两端渲染差异得出不同结论；O(messages) 的代价只在诊断路径调用。
// bodyRefs / toolSliceMessages 统计的是切片投影的规模，用来判断手机首屏是否需要继续降窗口。
// fileChanges / slashCommands 用可选链兜底：字段缺失与空数组在诊断口径上都记为 0。
// 这里只做累加，不校验一致性（例如 historyTotalMessages < messages），异常快照应由上游告警。
function getTaskSnapshotMessageDiagnostics(snapshot: ZCodeTaskSnapshot) {
  let assistantMessages = 0;
  let userMessages = 0;
  let toolCalls = 0;
  let bodyRefs = 0;
  let toolSliceMessages = 0;
  let contentChars = 0;
  let thoughtChars = 0;

  for (const message of snapshot.messages) {
    if (message.role === "assistant") {
      assistantMessages += 1;
    } else {
      userMessages += 1;
    }
    toolCalls += message.tools?.length ?? 0;
    bodyRefs += message.bodyRefs?.length ?? 0;
    if (message.toolSlice) {
      toolSliceMessages += 1;
    }
    contentChars += message.content.length;
    thoughtChars += message.thought?.length ?? 0;
  }

  return {
    assistantMessages,
    bodyRefs,
    contentChars,
    fileChanges: snapshot.fileChanges?.length ?? 0,
    historyTotalMessages: snapshot.history?.totalMessages ?? snapshot.messages.length,
    messages: snapshot.messages.length,
    slashCommands: snapshot.slashCommands?.length ?? 0,
    thoughtChars,
    toolCalls,
    toolSliceMessages,
    truncatedBefore: snapshot.history?.truncatedBefore ?? false,
    userMessages,
  };
}

function limitTaskSnapshotMessages(
  snapshot: ZCodeTaskSnapshot,
  messageLimit: number | undefined,
): ZCodeTaskSnapshot {
  // 归一化后的 limit 为 undefined 表示调用方没要求裁剪，直接返回原快照（零拷贝）。
  const limit = normalizeSnapshotMessageLimit(messageLimit);
  if (!limit) {
    return snapshot;
  }
  // 裁剪只保留尾部窗口（slice(-limit)），因为快照消费方总是从最新一条往回渲染；
  // 若取头部，replayable 首屏看不到最新回答，用户会以为消息丢失。
  // truncatedBefore 由「总数 > 窗口」显式算出，而不是「本次是否真的切掉东西」；两者在
  // totalMessages == limit 时结果不同，后者会让 UI 误判还有历史并触发无意义分页（INV-13）。
  const history = buildSnapshotHistory(snapshot.messages.length, limit);
  return {
    ...snapshot,
    messages: history.truncatedBefore ? snapshot.messages.slice(-limit) : snapshot.messages,
    // 手机 replayable 首屏为了性能只拿尾部窗口。
    // UI 不能再用“返回条数是否等于 limit”猜测是否还有更早历史，因为短尾部终态快照也可能是裁剪窗口。
    history,
  };
}

// UI 下拉值有两种形态：custom:provider:model（自定义模型编码）与共享的 provider/model 串。
// 自定义值必须先还原成 providerId/modelId 再下发，否则 CLI 收到 custom 会按未知模型处理。
// 两个字段都齐全才走自定义分支：半截编码（缺 provider 或 model）退回共享解析，避免下发空 id。
function parseModelPickerValue(value: string): ModelSelection {
  const customModel = decodeCustomModelValue(value);
  if (customModel?.providerId && customModel.modelName) {
    // UI 下拉的 custom:provider:model 只是展示态，不能原样传给 zcode-cli。
    // 旧解析会先按冒号截断成 custom，最终下发 glm/custom，触发 Unsupported model。
    return {
      providerId: customModel.providerId,
      modelId: customModel.modelName,
    };
  }

  return parseSharedModelSelection(value);
}

// 旧 task 面的 mode 词表混了历史别名（yolo/bypassPermissions/dontAsk、build/default/acceptEdits/
// autoEdit）；这里全部收敛到 ZCodeSessionMode，未知值返回 undefined 让调用方决定默认值。
// [权衡] 不做「未知即 build」的兜底：那会把用户显式选择的受限模式静默放宽成自动编辑。
// plan/edit/guarded/auto 是两端同名值，直接透传，不经过额外表。
function toZCodeMode(mode: ZCodeTaskMode | undefined): ZCodeSessionMode | undefined {
  switch (mode) {
    case "plan":
      return "plan";
    case "edit":
      // automation UI 保存的“自动编辑”使用 canonical edit。旧映射漏掉该值，
      // 调用方的 ?? build 会把权限模式静默降级成“变更前确认”。
      return "edit";
    case "guarded":
      return "guarded";
    case "yolo":
    case "bypassPermissions":
    case "dontAsk":
      return "yolo";
    case "auto":
      return "auto";
    case "build":
    case "default":
    case "acceptEdits":
    case "autoEdit":
      return "build";
    default:
      return undefined;
  }
}

// 反向只做恒等映射（build → build），其余原样返回：适配层不发明旧面没有的模式，
// 避免 UI 拿到它不认识的值后在下拉框里显示空选项。
// 之所以写成三元而不是 switch：正向是多别名收敛，反向是一对一，加 switch 只会诱使别人继续加别名。
function fromZCodeMode(mode: ZCodeSessionMode): ZCodeTaskMode {
  return mode === "build" ? "build" : mode;
}

// fork 出来的子会话历史里缺少「来源分隔线」时补一条 synthetic 消息：
// 判定依据是 session.parentSessionId；已有 session_fork 分区线则直接返回，防止重复插入。
// 只按 type 判重而不按 id 判重：fallback 的 id 由 parentSessionId 生成，与 CLI 落库的 id 规则不同，
// 按 id 判重会漏判、导致同一条分隔线出现两次。
function addSessionForkSnapshotFallback(
  messages: ZCodePersistedMessage[],
  snapshot: ZCodeSessionStateSnapshot,
): ZCodePersistedMessage[] {
  const parentSessionId = snapshot.session.parentSessionId;
  if (
    !parentSessionId ||
    messages.some((message) => message.syntheticTimeline?.type === "session_fork")
  ) {
    return messages;
  }

  return [
    // 这条 fallback 消息没有可跳转目标（targetMessageId 为空串），只让用户看到
    // 「此会话由某会话分叉而来」的边界；真正的跳转依赖 CLI 落库的 forkContext。
    ...messages,
    {
      id: `zcode-timeline-fork-${parentSessionId}-`,
      role: "user",
      content: "",
      timestamp: snapshot.session.createdAt,
      // 旧的纯对话 fork 没有落库 synthetic notice，只能从 session.parentSessionId
      // 恢复一个不可跳转的分割线，避免历史 fork 会话完全看不到来源边界。
      syntheticTimeline: {
        version: 1,
        kind: "synthetic",
        type: "session_fork",
        display: "separator",
        parentSessionId,
        targetMessageId: "",
      },
    },
  ];
}

// goal verifier 的生命周期（各 iteration 的验证结果）是 runtime 的持久状态，
// 但不一定写成 message history；这里按 target+iteration 去重后补 divider，恢复后不重复不错位。
// 没有 timeline 时直接返回原数组（引用不变），避免每次恢复都产生新快照对象。
function addGoalVerificationTimelineSnapshotFallback(
  messages: ZCodePersistedMessage[],
  snapshot: ZCodeSessionStateSnapshot,
): ZCodePersistedMessage[] {
  const timeline = snapshot.runtime.goalVerificationTimeline ?? [];
  if (timeline.length === 0) {
    return messages;
  }
  // 去重键用「身份键」而不是 message id：历史消息的 id 与 runtime timeline 的 id 生成规则不同，
  // 同一个 verification 在两个来源里 id 可能不同，只有 targetId+goalIteration 稳定。
  // 只收集 goal_verification 类型的 syntheticTimeline，其它 divider（fork/compaction）不参与去重。
  const existingIds = new Set(
    messages
      .map((message) =>
        message.syntheticTimeline?.type === "goal_verification"
          ? goalVerificationTimelineIdentityKey(message.syntheticTimeline)
          : null,
      )
      .filter((id): id is string => Boolean(id)),
  );
  // 只为缺失项补消息；已存在的 divider 交给 normalizeGoalVerificationTimelineMessageOrder 重排，
  // 两处职责分开，避免「补」与「排」互相覆盖。
  const timelineMessages = timeline
    .filter((item) => !existingIds.has(goalVerificationTimelineIdentityKey(item)))
    .map<ZCodePersistedMessage>((item) => ({
      id: goalVerificationTimelineMessageId(item),
      role: "assistant",
      content: "",
      timestamp: item.startedAt ?? item.updatedAt,
      // goal verifier lifecycle 是 agent snapshot 的持久状态，不一定有
      // 对应 message history；task facade 也要按 target+iteration 和 anchor 补 divider，避免恢复后重复或错位。
      syntheticTimeline: item,
    }));
  if (timelineMessages.length === 0) {
    return messages;
  }
  return insertGoalVerificationTimelineMessages(messages, timelineMessages);
}

// 身份键：有 goalIteration 时用 targetId+iteration（同一目标的第 N 轮），
// 否则退回 verificationId；旧数据可能没有 iteration，不能强行拼 targetId 造成误合并。
// 分隔符用冒号：targetId/verificationId 均不含冒号，拼接无歧义。
function goalVerificationTimelineIdentityKey(
  item: Extract<ZCodeGoalVerificationTimelineMeta, { type: "goal_verification" }>,
): string {
  if (typeof item.goalIteration === "number") {
    return `${item.targetId}:${item.goalIteration}`;
  }
  return `verification:${item.verificationId}`;
}

// 消息 id 必须由身份键确定性生成：重复调用要得到同一 id，否则 React key 变化会让
// divider 每次恢复都重挂载、动画闪烁。
// 两种形态（带 iteration / 带 verificationId）前缀相同但后缀不同，不会互相碰撞。
function goalVerificationTimelineMessageId(
  item: Extract<ZCodeGoalVerificationTimelineMeta, { type: "goal_verification" }>,
): string {
  if (typeof item.goalIteration === "number") {
    return `zcode-goal-verification-${item.targetId}-${item.goalIteration}`;
  }
  return `zcode-goal-verification-${item.verificationId}`;
}

// 按 timestamp 升序逐个插入，每个 divider 要么挂在 anchorAssistantMessageId 之后，
// 要么按时间戳找位置；先排序再插入保证结果与插入顺序无关（同一批 timeline 幂等）。
// 原地复制 result 再 splice：入参可能是上游缓存的数组，直接改动会污染其它快照。
function insertGoalVerificationTimelineMessages(
  messages: ZCodePersistedMessage[],
  timelineMessages: ZCodePersistedMessage[],
): ZCodePersistedMessage[] {
  const result = [...messages];
  for (const message of [...timelineMessages].sort(
    (left, right) => left.timestamp - right.timestamp,
  )) {
    // anchor 可能因 compaction 合并而找不到（findPersistedMessageIndexById 会检查 mergedMessageIds），
    // 找不到时降级为按时间插，而不是丢弃——丢一条 divider 会让用户看不出验证发生过。
    const timeline = message.syntheticTimeline;
    const anchorIndex =
      timeline?.type === "goal_verification" && timeline.anchorAssistantMessageId
        ? findPersistedMessageIndexById(result, timeline.anchorAssistantMessageId)
        : -1;
    if (anchorIndex >= 0) {
      result.splice(goalVerificationAnchorInsertIndex(result, anchorIndex), 0, message);
      continue;
    }
    // 时间戳插入点是「第一条更晚的消息之前」；相等时插在其后，保证稳定排序。
    result.splice(timestampInsertIndex(result, message.timestamp), 0, message);
  }
  return result;
}

// 已存在的 divider 也可能排错位（异步到达时落在下一条用户输入之后），所以这里把所有 divider
// 摘出来按 anchor 重新投影；只给缺失项做 fallback 无法修正已有错位。
// 没有 divider 时提前返回原数组，保持引用不变，避免空操作产生新快照。
function normalizeGoalVerificationTimelineMessageOrder(
  messages: ZCodePersistedMessage[],
): ZCodePersistedMessage[] {
  const timelineMessages = messages.filter(
    (message) => message.syntheticTimeline?.type === "goal_verification",
  );
  if (timelineMessages.length === 0) {
    return messages;
  }
  // agent history 已存在的 verifier divider 也可能因为异步到达排到下一条用户输入后面；
  // task facade snapshot 必须按 anchor 重新投影，而不是只给缺失 divider 做 fallback。
  // 摘掉旧 divider 后重新插入，等价于一次稳定重排；非 divider 消息的相对顺序保持不变。
  return insertGoalVerificationTimelineMessages(
    messages.filter((message) => message.syntheticTimeline?.type !== "goal_verification"),
    timelineMessages,
  );
}

// 同一 anchor 后可能已有多条验证 divider（一个 assistant 消息对应多轮验证），
// 必须跳到这些 divider 之后插入，否则新 divider 会插到旧的前面导致轮次倒序。
function goalVerificationAnchorInsertIndex(
  messages: readonly ZCodePersistedMessage[],
  anchorIndex: number,
): number {
  let index = anchorIndex + 1;
  while (
    index < messages.length &&
    messages[index]?.syntheticTimeline?.type === "goal_verification"
  ) {
    index += 1;
  }
  return index;
}

// [权衡] 用线性查找而非二分：快照消息已被窗口裁剪，n 很小；二分要求数组先按时间有序，
// 而重排过程中这个前提并不总是成立，反而容易给出错误插入点。
// 找不到更晚消息时返回 length，即追加到末尾。
function timestampInsertIndex(
  messages: readonly ZCodePersistedMessage[],
  timestamp: number,
): number {
  const index = messages.findIndex((message) => message.timestamp > timestamp);
  return index >= 0 ? index : messages.length;
}

// 合并消息会把多个原始 message id 收进 mergedMessageIds；anchor 指向被合并的旧 id 时
// 仍要命中合并后的那一条，否则 divider 会退化成按时间插入、落在错误位置。
// 用 === true 而非真值判断：mergedMessageIds 可能来自宽松 JSON，非布尔真值不应算命中。
function findPersistedMessageIndexById(
  messages: readonly ZCodePersistedMessage[],
  messageId: string,
): number {
  return messages.findIndex(
    (message) => message.id === messageId || message.mergedMessageIds?.includes(messageId) === true,
  );
}

// 统计 active iteration 时先按 targetId 过滤 timeline：同一 session 可能有多个 target，
// 混算会让进度条显示成其它目标的历史轮次。
// targetStatus 缺失时传 null 而不是 active：由 getZCodeGoalActiveIterationCount 明确处理未知态。
// timeline 为空数组同样走同一个统计函数，保证「无验证」与「有验证但已完成」可区分。
function getSnapshotGoalActiveIterationCount(snapshot: ZCodeSessionStateSnapshot): number {
  const targetId = snapshot.projection.target?.targetId;
  const timeline =
    snapshot.runtime.goalVerificationTimeline?.filter(
      (item) => !targetId || item.targetId === targetId,
    ) ?? [];
  return getZCodeGoalActiveIterationCount({
    targetStatus: snapshot.projection.target?.status ?? null,
    timeline,
  });
}

// 对外只暴露两种 deliveryKind：replayable 走 web-remote-replayable（需要快照 + 重放），
// 其余（continuous / mixed / bot-channel-continuous / 未指定）都按桌面连续流处理。
// [权衡] mixed 不单独建模：它仍是「在线连续 + 可补快照」，多一种 kind 只会让下游多一倍分支。
// 未指定时默认 desktop-continuous：adapter 的默认调用方是桌面链路，未声明的 channel 不按远控处理。
function toZCodeDeliveryKind(
  deliveryKind: "continuous" | "bot-channel-continuous" | "replayable" | "mixed" | undefined,
): ZCodeDeliveryKind {
  return deliveryKind === "replayable" ? "web-remote-replayable" : "desktop-continuous";
}

// 把 background task notification 的 input 文本解析成一条 tool_call_update：
// 这类通知在 CLI 侧只是普通 tool input，但桌面端需要在没有工具运行的情况下也展示结果卡片。
// 返回 null 表示「这段 input 不是通知格式」，调用方应原样按普通输入处理，不能当成失败。
function backgroundTaskNotificationToolUpdateFromInput(params: {
  input: string | undefined;
  inputId: InputId | undefined;
  taskId: string;
  traceId: TraceId;
}): Extract<ZCodeStreamEvent, { type: "tool_call_update" }> | null {
  const parsed = parseZCodeBackgroundTaskNotificationText(params.input);
  // 解析失败返回 null 而不是抛错：input 可能是任意用户文本（非通知格式），
  // 抛错会让整个 turn.started 映射失败、丢掉 task_run_started。
  if (!parsed) {
    return null;
  }
  const status = zcodeBackgroundTaskNotificationToolUpdateStatus(parsed.notification.status);
  return {
    type: "tool_call_update",
    taskId: params.taskId,
    traceId: params.traceId,
    ...(params.inputId ? { inputId: params.inputId } : {}),
    toolId: parsed.toolUseId,
    status,
    content: parsed.notification.result ?? parsed.notification.summary,
    // replayable 动态事件也必须把 notification error 放到标准 tool error，
    // 否则手机远控与桌面 continuous 的失败详情会产生分叉。
    ...(status === "failed" && parsed.notification.error
      ? { error: parsed.notification.error }
      : {}),
    raw: attachZCodeBackgroundTaskNotificationToRaw(
      { toolCallId: parsed.toolUseId },
      parsed.notification,
    ),
  };
}

// 把 CLI 的 message+parts 单向映射成旧 task 面的持久化消息：
// - content 只取 text part（reasoning/tool 分字段），保证搜索/预览不会命中思考内容；
// - user 消息额外反投影 attachments，恢复后 UI 的附件 chip 才不会消失；
// - assistant 消息才带 tools/parts/thought/duration，user 侧多带字段会让 UI 走错渲染分支。
// 纯函数：不读写缓存、不改入参；同一 message 多次映射结果一致（幂等）。
function mapMessage(
  message: ZCodeMessageWithParts,
  goalIteration?: number,
  backgroundTaskNotifications?: ReadonlyMap<string, ZCodeBackgroundTaskNotificationInfo>,
): ZCodePersistedMessage {
  const tools: ZCodePersistedToolCall[] = [];
  const parts: ZCodePersistedMessagePart[] = [];
  const attachments =
    message.info.role === "user" ? mapPromptAttachmentsFromParts(message.parts) : undefined;
  let syntheticTimeline: ZCodeTimelineMeta | undefined;
  // 第一趟只看非正文 part，抽 synthetic timeline。必须与下面的正文/工具组装分开：
  // timeline 挂在 message 级，且 text/compaction 的优先级不同，混在一趟里会产生
  // 「先遇到 tool 就再也没机会设置 timeline」的顺序依赖。
  for (const part of message.parts) {
    if (part.type === "text") {
      // fork notice 等结构化 synthetic 消息把 timeline meta 写在 part.metadata 上；
      // 持久化层不带 metadata 字段，所以提取一份挂到 message 级别供 UI 渲染分隔条。
      if (!syntheticTimeline) {
        const fromText = extractSyntheticTimelineFromTextPart(part);
        if (fromText) {
          syntheticTimeline = fromText;
        }
      }
    } else if (part.type === "compaction" && !syntheticTimeline) {
      // compact 的模型 summary/timelineText 属于 agent 内部上下文，不能作为正文透出。
      // 持久化恢复只从结构化字段合成横线，展示文案由 UI/TUI 本地 i18n 决定。
      syntheticTimeline = synthesizeCompactionTimeline(part);
    }
  }
  // 第二趟按 part 原始顺序组装 parts 与 tools；toolIndex 是「该 message 内第几个工具」的
  // 相对下标，UI 靠它把 tool-call part 指回 tools 数组，不能用全局工具序号。
  // file/其它 part 不进 parts：附件已在 attachments 字段单独投影，重复会让 UI 渲染两次。
  for (const part of message.parts) {
    if (part.type === "text") {
      parts.push({ type: "content", content: part.text });
    } else if (part.type === "reasoning") {
      parts.push({ type: "thought", content: part.text });
    } else if (part.type === "tool") {
      const toolIndex = tools.length;
      tools.push(mapToolPart(part, backgroundTaskNotifications));
      parts.push({ type: "tool-call", toolIndex });
    }
  }
  // model 只在原始消息带 model 时输出：未绑定恢复仍需完整历史，补一个默认模型会让
  // 「历史消息用了哪个模型」这一事实被伪造（INV-09：区分「没有该字段」与「尚未写入」）。
  // syntheticTimeline / attachments / assistant 字段都用条件展开：旧面用 undefined 表示缺失，
  // 不能写成 null，否则 UI 的判空分支会走到「有值但为空」的错误路径。
  return {
    id: message.info.messageId,
    role: message.info.role,
    content: textFromParts(message.parts),
    timestamp: message.info.time.created,
    // 未绑定恢复仍需呈现完整历史，不能为缺失的消息来源补默认模型。
    model: message.info.model ? formatModelPickerValue(message.info.model) : undefined,
    ...(syntheticTimeline ? { syntheticTimeline } : {}),
    ...(attachments ? { attachments } : {}),
    ...(message.info.role === "assistant"
      ? {
          ...(goalIteration ? { goalIteration } : {}),
          durationMs: message.info.time.completed
            ? message.info.time.completed - message.info.time.created
            : undefined,
          thought: reasoningFromParts(message.parts),
          tools: tools.length > 0 ? tools : undefined,
          parts: parts.length > 0 ? parts : undefined,
        }
      : {}),
  };
}

// 只在 user 消息上调用；file part 过滤后逐个反投影，任何一个无法还原都被丢弃而不是
// 补成占位附件——UI 宁可少一个 chip，也不该展示打不开的假附件。
function mapPromptAttachmentsFromParts(
  parts: readonly ZCodeMessagePart[],
): ZCodePromptAttachment[] | undefined {
  const attachments = parts
    .filter((part): part is Extract<ZCodeMessagePart, { type: "file" }> => part.type === "file")
    .map(mapPromptAttachmentFromFilePart)
    .filter((attachment): attachment is ZCodePromptAttachment => attachment !== undefined);
  return attachments.length > 0 ? attachments : undefined;
}

// file part 的反投影规则：mime 前缀决定 kind（image/audio/video/file），
// 本地绝对路径优先（可用 localPath 直接打开），data URL 则抽出 base64 供远端预览。
// 三者都缺时仍返回 file 附件，filename 退回 attachment，保证数量与发送时一致。
// mime 缺失按 application/octet-stream 处理：无法判定类型时降级为普通文件最安全。
function mapPromptAttachmentFromFilePart(
  part: Extract<ZCodeMessagePart, { type: "file" }>,
): ZCodePromptAttachment | undefined {
  const mimeType = part.mime || "application/octet-stream";
  const metadata = asRecord(part.metadata);
  const filename = part.filename?.trim() || filenameFromPathLike(part.url) || "attachment";
  const sizeBytes = numberValue(metadata.sizeBytes);
  const dataBase64 = dataBase64FromDataUrl(part.url);
  const localPath = localPathFromAttachmentPart(part.url, metadata);

  // 历史恢复链路之前只把 file part 当作模型上下文，不回填 UI 的 attachments 字段。
  // 用户消息恢复后附件 chip 因此消失；这里从 agent 持久化的 file part 反投影回发送时的附件形态。
  if (mimeType.startsWith("image/")) {
    return {
      kind: "image",
      filename,
      mimeType,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(localPath ? { localPath } : {}),
    };
  }

  if (mimeType.startsWith("audio/")) {
    return {
      kind: "audio",
      filename,
      mimeType,
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(localPath ? { localPath } : {}),
    };
  }

  if (mimeType.startsWith("video/")) {
    return {
      kind: "video",
      filename,
      mimeType,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(localPath ? { localPath } : {}),
    };
  }

  // 文本预览只在此处取用，且仅在没有本地路径时使用：base64/本地文件都能按需读取，
  // 把大段文本同时塞进 snapshot 会让手机 replayable 首屏体积翻倍。
  // sizeBytes 在 file 分支用 0 兜底（旧面字段非可选），其它 kind 允许缺省。
  const preview = asRecord(metadata.preview);
  const textContent = !localPath ? stringValue(preview.text) : undefined;
  return {
    kind: "file",
    filename,
    mimeType,
    sizeBytes: sizeBytes ?? 0,
    ...(dataBase64 ? { dataBase64 } : {}),
    ...(textContent !== undefined ? { textContent } : {}),
    ...(localPath ? { localPath } : {}),
  };
}

// 只做「data:...;base64,」前缀剥离，不校验 base64 合法性：校验要扫全串，
// 大附件上会带来一次额外的 O(n) 与内存峰值，而下游解码本就会失败并降级。
function dataBase64FromDataUrl(value: string): string | undefined {
  const match = /^data:[^;,]+;base64,(.*)$/i.exec(value);
  return match?.[1] || undefined;
}

// 优先用 metadata.originalUrl（用户选的本地文件），其次是 part.url；
// 只有绝对路径才算 localPath——相对路径/URL 交给 filename 与 dataBase64 分支处理。
// 不复用 filenameFromPathLike 的判定：那个函数会剥掉 scheme，这里需要原样路径。
function localPathFromAttachmentPart(
  url: string,
  metadata: Record<string, unknown>,
): string | undefined {
  const originalUrl = stringValue(metadata.originalUrl);
  if (originalUrl && isAbsolutePathLike(originalUrl)) {
    return originalUrl;
  }
  return isAbsolutePathLike(url) ? url : undefined;
}

// 覆盖 POSIX、Windows 盘符与 UNC 三种形态；不用 path.isAbsolute 是为了不绑定运行时平台，
// 因为同一份 snapshot 可能由远端 Host 产生、再在另一平台渲染。
function isAbsolutePathLike(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");
}

// 先按 ?/# 截断再按分隔符取最后一段；带 scheme 的结果（如 https://host）视为无文件名，
// 避免把主机名当附件名展示。
// data: 开头直接返回 undefined：base64 串里可能含 /，会被误当成路径分隔符。
function filenameFromPathLike(value: string): string | undefined {
  if (value.startsWith("data:")) {
    return undefined;
  }
  const pathPart = value.split(/[?#]/u)[0] ?? "";
  const segments = pathPart.split(/[\\/]/u).filter(Boolean);
  const filename = segments.at(-1)?.trim();
  return filename && !filename.includes("://") ? filename : undefined;
}

// forkContext 写在 text part 的 metadata 上，持久化层不保留 metadata，
// 因此恢复时要从这里把它提升成 message 级 syntheticTimeline；字段缺失或类型不符一律返回 undefined。
// metadata 是 unknown：先判对象再取值，任何非对象（字符串/数组）都按无 metadata 处理。
function extractSyntheticTimelineFromTextPart(
  part: Extract<ZCodeMessagePart, { type: "text" }>,
): ZCodeTimelineMeta | undefined {
  const metadata = part.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const forkContext = (metadata as Record<string, unknown>)["forkContext"];
  if (!forkContext || typeof forkContext !== "object") return undefined;
  const ctx = forkContext as Record<string, unknown>;
  if (ctx["kind"] !== "session_fork") return undefined;
  // parentSessionId 与 targetMessageId 必须同时存在才认为可渲染分隔线：
  // 只有一半的 fork 上下文无法定位来源，强行渲染会让用户点到一个不存在的目标。
  const parentSessionId = typeof ctx["parentSessionId"] === "string" ? ctx["parentSessionId"] : "";
  const targetMessageId = typeof ctx["targetMessageId"] === "string" ? ctx["targetMessageId"] : "";
  const targetCheckpointId =
    typeof ctx["targetCheckpointId"] === "string" ? ctx["targetCheckpointId"] : undefined;
  if (!parentSessionId || !targetMessageId) return undefined;
  return {
    version: 1,
    kind: "synthetic",
    type: "session_fork",
    display: "separator",
    parentSessionId,
    targetMessageId,
    ...(targetCheckpointId ? { targetCheckpointId } : {}),
    ...(typeof ctx["restoredFileCount"] === "number"
      ? { restoredFileCount: ctx["restoredFileCount"] }
      : {}),
  };
}

// compaction part 的 timeline 完全由结构化 metadata 合成，不读模型 summary 正文：
// summary 属于 agent 内部上下文，展示文案由 UI/TUI 本地 i18n 决定。
// operationId 缺失时退回 partId：至少要有一个稳定标识，否则 UI 无法去重同一次压缩的多条事件。
function synthesizeCompactionTimeline(
  part: Extract<ZCodeMessagePart, { type: "compaction" }>,
): ZCodeTimelineMeta | undefined {
  const metadata = asRecord(part.metadata);
  const operationId = stringValue(metadata.operationId) ?? part.partId;
  const status = timelineStatusValue(metadata.timelineStatus);
  // 既无 timelineStatus 又无 summaryMessageId 说明这条 compaction part 是 summary 的载体，
  // 不是 UI 分隔线；把它也投影出去会让恢复后的快照多出一条重复横线。
  if (!status && !part.summaryMessageId) {
    // compact summary user message 也带 compaction metadata，
    // 但它是模型上下文，不是 UI timeline；否则 snapshot 恢复会多渲染一条横线。
    return undefined;
  }
  const trigger = timelineTriggerValue(metadata.trigger) ?? (part.auto ? "auto" : "manual");
  const replace = booleanValue(metadata.replace);
  const reason = part.reason ?? stringValue(metadata.reason);
  const boundaryId = stringValue(metadata.boundaryId) ?? part.summaryMessageId;
  const summaryMessageId = part.summaryMessageId ?? stringValue(metadata.summaryMessageId);
  const preCompactTokenCount = numberValue(metadata.preCompactTokenCount);
  const postCompactTokenCount = numberValue(metadata.postCompactTokenCount);
  const truePostCompactTokenCount = numberValue(metadata.truePostCompactTokenCount);
  const attempt = numberValue(metadata.attempt);
  const maxAttempts = numberValue(metadata.maxAttempts);
  const startedAt = numberValue(metadata.startedAt);
  const endedAt = numberValue(metadata.endedAt);
  return {
    version: 1,
    kind: "synthetic",
    type: "context_compaction",
    operationId,
    status: status ?? "completed",
    trigger,
    display: "separator",
    ...(replace !== undefined ? { replace } : {}),
    ...(reason ? { reason } : {}),
    ...(boundaryId ? { boundaryId } : {}),
    ...(summaryMessageId ? { summaryMessageId } : {}),
    ...(preCompactTokenCount !== undefined ? { preCompactTokenCount } : {}),
    ...(postCompactTokenCount !== undefined ? { postCompactTokenCount } : {}),
    ...(truePostCompactTokenCount !== undefined ? { truePostCompactTokenCount } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
}

// tool part → 旧面 toolCall 的映射。三个分支按 CLI state.status 分流：
// completed / error 带 output|error，其余（pending/running/未开始）只带 input。
// raw 统一补 toolCallId 并附加 background notification，保证终态快照能覆盖流式临时工具。
// [权衡] 不做「status → 旧面枚举」的集中表：三种状态字段形态不同，集中映射会退化成三个 if。
function mapToolPart(
  part: Extract<ZCodeMessagePart, { type: "tool" }>,
  backgroundTaskNotifications?: ReadonlyMap<string, ZCodeBackgroundTaskNotificationInfo>,
): ZCodePersistedToolCall {
  const state = part.state;
  const taskNotification = backgroundTaskNotifications?.get(part.callId);
  // ZCode Protocol 的 part.callId 是实时流和终态 snapshot 共同的工具身份。
  // 以前只保存 metadata 会丢掉 toolCallId，手机 replayable 里 result-only 临时工具就无法被终态快照覆盖。
  const raw = attachZCodeBackgroundTaskNotificationToRaw(
    attachToolCallIdToRaw("metadata" in state ? (state.metadata ?? state) : state, part.callId),
    taskNotification,
  );
  // completed 只代表 launch ACK，不代表后台任务成功；notification 的 failed 必须覆盖它。
  // [权衡] 只覆盖 failed 而不把 notification 的 completed 写回：避免把「ACK 即完成」的旧语义
  // 扩散到其它状态（stopped 等仍需保持原样）。
  if (state.status === "completed") {
    // snapshot 里的 completed 是 background Agent launch ACK；failed
    // notification 必须在 replayable restore 中覆盖它，但不能顺带改变 stopped 等既有语义。
    const notificationStatus = taskNotification?.status
      ? zcodeBackgroundTaskNotificationToolUpdateStatus(taskNotification.status)
      : undefined;
    const notificationFailed = notificationStatus === "failed";
    return {
      toolName: part.tool,
      title: state.title || part.tool,
      kind: part.tool,
      status: notificationFailed ? "failed" : "completed",
      input: state.input,
      output: state.output,
      ...(notificationFailed && taskNotification?.error ? { error: taskNotification.error } : {}),
      raw,
    };
  }
  // error 分支不带 output：CLI 的 error state 可能同时有半截 output，透出会让 UI 把
  // 失败结果当成功内容渲染。kind/title 都退回工具名，避免空的 state.title 造成空白卡片。
  if (state.status === "error") {
    return {
      toolName: part.tool,
      title: part.tool,
      kind: part.tool,
      status: "failed",
      input: state.input,
      error: state.error,
      raw,
    };
  }
  return {
    toolName: part.tool,
    title: "title" in state && state.title ? state.title : part.tool,
    kind: part.tool,
    input: state.input,
    raw,
  };
}

// raw 可能是任意形状（对象/数组/标量）；数组与非对象一律包成 { toolCallId, raw }，
// 防止 {...raw} 把数组展开成下标键。已有 toolCallId 时不覆盖：CLI 写入的才是权威身份。
function attachToolCallIdToRaw(raw: unknown, toolCallId: string): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { toolCallId, raw };
  }
  return {
    ...raw,
    toolCallId:
      typeof (raw as Record<string, unknown>).toolCallId === "string"
        ? (raw as Record<string, unknown>).toolCallId
        : toolCallId,
  };
}

// 正文 = 所有 text part 拼接（顺序即 part 顺序）；reasoning 与 tool 不计入 content，
// 因此同一 message 的 content 与 thought 不会重复。
function textFromParts(parts: readonly ZCodeMessagePart[]): string {
  return textFromZCodeMessageParts(parts);
}

// 思考内容拼成一个字符串（而不是 parts 数组）：旧面的 thought 字段是纯文本；
// 空串归一成 undefined，避免 UI 渲染一个空的思考折叠块。
function reasoningFromParts(parts: readonly ZCodeMessagePart[]): string | undefined {
  const text = parts
    .filter(
      (part): part is Extract<ZCodeMessagePart, { type: "reasoning" }> => part.type === "reasoning",
    )
    .map((part) => part.text)
    .join("");
  return text || undefined;
}

// goal 来自 runtime 的宽松 JSON，字段可能是 sessionID/targetID 或 sessionId/targetId 两种拼写；
// 两种都接受，缺失用 "" / 0 / null 兜底，保证 UI 形状稳定（字段有类型，不返回 undefined）。
// time.created 兼容 time 对象与顶层 createdAt 两种布局，旧快照只有后者。
// tokenBudget 只接受 number：null 表示不限预算，与 0（预算为零）语义不同，不能合并。
function fromZCodeGoal(goal: unknown): ZCodeTaskGoal {
  const record = asRecord(goal);
  const time = asRecord(record.time);
  const status = stringValue(record.status);
  // status 只接受协议枚举，其它值退回 active（[权衡] 展示态坏字段不应让整个快照失败），
  // 代价是异常状态会被显示成「进行中」，因此协议新增状态时必须同步更新白名单。
  return {
    sessionID: stringValue(record.sessionID) ?? stringValue(record.sessionId) ?? "",
    targetID: stringValue(record.targetID) ?? stringValue(record.targetId) ?? "",
    objective: stringValue(record.objective) ?? "",
    summaryTitle: stringValue(record.summaryTitle) ?? null,
    status: isZCodeTaskGoalStatus(status) ? status : "active",
    tokenBudget: typeof record.tokenBudget === "number" ? record.tokenBudget : null,
    tokensUsed: numberValue(record.tokensUsed) ?? 0,
    timeUsedSeconds: numberValue(record.timeUsedSeconds) ?? 0,
    time: {
      created: numberValue(time.created) ?? numberValue(record.createdAt) ?? 0,
      updated: numberValue(time.updated) ?? numberValue(record.updatedAt) ?? 0,
    },
  };
}

// 协议枚举白名单；新增状态必须同时改这里与 UI 的映射，否则会走 active 兜底并被误判为进行中。
function isZCodeTaskGoalStatus(status: string | undefined): status is ZCodeTaskGoal["status"] {
  return (
    status === "active" ||
    status === "paused" ||
    status === "budget_limited" ||
    status === "complete"
  );
}

// todo → plan step 的适配：旧面 plan 以 index 生成 id（todo 本身没有 id），
// 因此重排/增删会让 id 漂移——这是已知限制，不能拿它做跨快照 diff 的 key。
// 空数组返回 null 而不是 []：旧面用 null 表示「没有计划」，空数组会渲染一个空计划面板。
// content 直接作为 title，不做截断：截断属于 UI 展示策略，放在这里会丢信息。
function sessionTodosToPlanSteps(
  todos: ZCodeSessionStateSnapshot["todos"],
): ZCodePlanStep[] | null {
  if (!todos || todos.length === 0) {
    return null;
  }
  return todos.map((todo, index) => ({
    id: `todo-${index}`,
    status: todo.status,
    title: todo.content,
  }));
}

// 浅拷贝：runtime 的 stats 对象在 snapshot 生命周期内视为只读，拷贝是防止调用方改到上游对象；
// 不做深拷贝是因为字段都是标量，且快照本身每次都是新对象。
// 无 stats 返回 null 而非零值对象：零值会让 UI 显示「0 轮验证」而不是「未启用验证」。
function sessionGoalStatsToRuntime(
  stats: ZCodeSessionStateSnapshot["goalStats"],
): ZCodeTaskGoalStats | null {
  return stats ? { ...stats } : null;
}

// todo group 透传 id/source/goalIteration/targetId 等归属字段，只把 todo 数组重命名成 plan step 形状；
// 归属字段不能丢，UI 依赖它们把分组挂到对应的 goal iteration 下。
function sessionTodoGroupsToRuntime(
  groups: ZCodeSessionStateSnapshot["todoGroups"],
): ZCodeTodoGroup[] | null {
  if (!groups || groups.length === 0) {
    return null;
  }
  return groups.map((group) => ({
    id: group.id,
    source: group.source,
    ...(group.goalIteration ? { goalIteration: group.goalIteration } : {}),
    ...(group.targetId ? { targetId: group.targetId } : {}),
    ...(group.startedAt ? { startedAt: group.startedAt } : {}),
    ...(group.updatedAt ? { updatedAt: group.updatedAt } : {}),
    todos: group.todos.map((todo, index) => ({
      id: `${group.id}-todo-${index}`,
      status: todo.status,
      title: todo.content,
    })),
  }));
}

// state.updated 通知 → 两个 UI 事件（权限模式 + 模型/思考档位）。二者必须同时产出：
// UI 的模型下拉与权限模式来自同一次 settings patch，只发一半会让两个控件显示不同代状态。
// 两个事件共用同一 traceId：UI 以 traceId 做一轮内的批处理，拆成不同 trace 会打乱顺序。
function mapStateUpdated(
  params: TaskTarget,
  notification: ZCodeStateUpdatedNotification,
): ZCodeStreamEvent[] {
  // patch 用 schema 强校验；校验失败返回空数组而不是抛错——单条脏 patch 不应中断整条事件流。
  // [失败路径] 代价是这类事件被静默丢弃，排查时需要对照 CLI 侧 protocol 日志。
  const parsedSettings = zcodeSessionSettingsStateSchema.safeParse(notification.patch);
  if (!parsedSettings.success) {
    return [];
  }
  const traceId = generateTraceId(params.taskId);
  // 返回成对事件而不是合并成一个：旧面协议没有「设置全量」事件，两条各自有独立消费方。
  return [
    {
      type: "mode_update",
      taskId: params.taskId,
      traceId,
      // 当前模式要经过 normalizeAvailableZCodeMode：patch 里的值可能是别名或已下线模式，
      // 直接透出会让 UI 下拉框选不中任何一项。
      currentModeId: normalizeAvailableZCodeMode(parsedSettings.data.mode.current),
      availableModes: getZCodeAgentAvailableModes(),
    },
    {
      type: "glm_agent_model_state_update",
      taskId: params.taskId,
      traceId,
      version: 1,
      sessionId: params.taskId,
      reason:
        notification.reason === "thought_level_changed"
          ? "thought_level_changed"
          : notification.reason === "model_changed"
            ? "model_changed"
            : "session_initialized",
      model: {
        currentValue: formatModelPickerValue(parsedSettings.data.model.current),
      },
      thoughtLevel: {
        enabled: parsedSettings.data.thoughtLevel.enabled,
        currentValue: parsedSettings.data.thoughtLevel.current,
        options: parsedSettings.data.thoughtLevel.available.map((option) => ({
          value: option.value,
          name: option.label,
        })),
      },
      contextWindow: {
        tokens:
          parsedSettings.data.model.available.find(
            (option) =>
              formatModelPickerValue(option.ref) ===
              formatModelPickerValue(parsedSettings.data.model.current),
          )?.contextWindow ?? 0,
      },
    },
  ];
}

// 把一条 ZCodeSessionEvent 映射成 0..n 个旧面 stream 事件，是 realtime 读路径的唯一分叉点。
// 结构是「先算公共身份，再按 event.type 依次短路」：traceId/inputId → turn.started →
// compact/part timeline → 模型流 → tool/permission → steer → completed/failed → 兜底 info 类。
// 顺序不可重排：timeline 判定要早于模型流（否则 compact 文本会被当正文），turn.completed
// 要晚于模型流（否则补齐后缀时看不到本轮已发文本）。
// 返回空数组是合法结果（例如 user-input 类权限），表示该事件对旧面没有投影，不是失败。
function mapSessionEvent(
  params: TaskTarget,
  event: ZCodeSessionEvent,
  streamedTurnText: Map<string, { messageId?: string; text: string }>,
  activePromptInputId?: InputId,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
  backgroundTaskControlsByTaskKey?: Map<string, ZCodeBackgroundTaskControlItem[]>,
  hasActiveApiRetry = false,
): ZCodeStreamEvent[] {
  // event.traceId 是协议运行时 trace，可能缺失；缺失时用 taskId 派生一个，保证事件永远有 trace 可挂。
  // 它只是兜底：真正的轮次 trace 由下面的 eventInputId 决定，二者不可混用。
  // 两者不一致时打一条 debug：这是排查「一轮被拆成多个 trace」的唯一现场证据。
  const protocolTraceId = event.traceId ?? generateTraceId(params.taskId);
  const payload = asRecord(event.payload);
  const inputId = stringValue(payload.inputId);
  const queryId = stringValue(payload.queryId);
  // 兼容层对外的 traceId 语义是“一次用户输入到本轮回复结束”的轮次标识。
  // ZCode Protocol runtime trace 只在事件没有 inputId 时兜底，避免同一轮 chunk/tool/complete 被拆成不同 trace。
  const eventInputId = inputId ?? activePromptInputId;
  const traceId = eventInputId ?? protocolTraceId;
  if (eventInputId && eventInputId !== protocolTraceId) {
    logger.debug(
      eventInputId,
      `对齐 ZCode prompt inputId eventType=${event.type} protocolTrace=${protocolTraceId}`,
    );
  }
  // turnKey 用于本轮正文累计：workspace + session + turnId（优先）保证同一 turn 的多个 chunk
  // 命中同一条记录；带 workspace 是因为不同 workspace 可能存在同名 sessionId。
  // turnId 缺失时退回 inputId/traceId：重放场景（无 turnId）也要能对上本轮。
  const turnKey = `${resolveWorkspaceKey(params)}:${event.sessionId}:${event.turnId ?? eventInputId ?? traceId}`;

  // turn.started 先清掉 turnKey 的旧累计：同一 turnId 被复用（重放/重试）时，
  // 残留的上轮正文会让 turn.completed 的「补齐后缀」多算一段。
  if (event.type === "turn.started") {
    streamedTurnText.delete(turnKey);
    // inputOrigin 只透传 desktop/mobile 两个已知来源；缺失时不写字段，
    // 因为 automation/off-peak 触发的轮次没有用户来源，编一个值会误导 UI 的输入框归属。
    // 用条件展开而不是直接赋 undefined：下游按「字段是否存在」判断来源，不读 value。
    const inputOrigin = asRecord(payload.intent).inputOrigin;
    const runStartedEvent: ZCodeStreamEvent = {
      ...(inputOrigin === "desktop" || inputOrigin === "mobile" ? { inputOrigin } : {}),
      type: "task_run_started",
      taskId: params.taskId,
      traceId,
      ...(eventInputId ? { inputId: eventInputId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      startedAt: event.timestamp,
    };
    // 同一 input 可能是 background task notification 的 Markdown 文本，需要在 run_started 之后
    // 额外投一条 tool_call_update；顺序固定，UI 先建卡片再更新状态。
    const taskNotificationToolUpdate = backgroundTaskNotificationToolUpdateFromInput({
      input: stringValue(payload.input),
      taskId: params.taskId,
      traceId,
      inputId: eventInputId,
    });
    if (taskNotificationToolUpdate) {
      return [runStartedEvent, taskNotificationToolUpdate];
    }
    // goal-continuation + model-only 是 agent 自驱的继续轮：对用户不可见，
    // 但需要一条 goal_iteration_started 让 UI 把后续工具挂到正确的迭代下。
    if (
      stringValue(payload.inputSource) === "goal-continuation" &&
      stringValue(payload.inputVisibility) === "model-only"
    ) {
      return [
        runStartedEvent,
        {
          type: "goal_iteration_started",
          taskId: params.taskId,
          traceId,
          ...(eventInputId ? { inputId: eventInputId } : {}),
          ...(stringValue(payload.targetId) ? { targetId: stringValue(payload.targetId) } : {}),
          startedAt: event.timestamp,
        },
      ];
    }
    return [runStartedEvent];
  }

  // compact / synthetic part 的 timeline 必须先于模型流判定：它们的 payload 也带
  // text/kind 字段，走模型流分支会被渲染成普通回答正文。
  const compactTimeline = mapCompactTimelinePayload(params.taskId, traceId, eventInputId, payload);
  if (compactTimeline) {
    return [compactTimeline];
  }

  // synthetic part（fork 等）同理：命中即只返回 timeline 事件，不再继续消费 payload。
  // 两个 map* 都是纯函数，返回 null 表示「这条事件不归我」，不是失败。
  const partTimeline = mapSyntheticTimelinePartPayload(
    params.taskId,
    traceId,
    eventInputId,
    payload,
  );
  if (partTimeline) {
    return [partTimeline];
  }

  // 模型流（text_delta / reasoning_delta / tool_input_*）投影；非模型类 payload 返回 null。
  const modelStreaming = mapModelStreaming(
    params.taskId,
    traceId,
    eventInputId,
    payload,
    toolProjectionMemory,
  );
  // api retry 的清除事件与模型流同批返回且排在前：先撤掉「重试中」运行态，再投正文，
  // 避免 UI 在收到内容后仍显示重试横条（顺序反了会闪一下）。
  const apiRetryClearEvent = maybeBuildApiRetryClearOnModelProgress(
    hasActiveApiRetry,
    params.taskId,
    traceId,
    eventInputId,
    payload,
  );
  if (modelStreaming) {
    // 只累计「无 parentToolUseId」的正文 chunk：工具内部的模型输出属于该工具的中间内容，
    // 混进本轮正文会让 turn.completed 的后缀计算把工具输出当成已发文本。
    if (modelStreaming.type === "agent_message_chunk" && !modelStreaming.parentToolUseId) {
      const previous = streamedTurnText.get(turnKey);
      const messageId = modelStreaming.messageId;
      // messageId 变化说明进入了新的 assistant 消息：重置累计，否则会把两条消息的正文拼成一段
      //（历史 bug：最终回答前的前言被当成同一消息的前缀）。
      // 任一侧 messageId 缺失时视为同一条：宁可少重置，也不要把同一消息拆成两段。
      const sameMessage = !messageId || !previous?.messageId || messageId === previous.messageId;
      streamedTurnText.set(turnKey, {
        messageId: messageId ?? previous?.messageId,
        text: (sameMessage ? (previous?.text ?? "") : "") + modelStreaming.content,
      });
    }
    // 有模型流时只返回它（外加可能的 retry 清除）；即使同一 payload 还能产出别的投影也
    // 不再继续，保持「一条事件最多一条主投影」的可预测性。
    return apiRetryClearEvent ? [apiRetryClearEvent, modelStreaming] : [modelStreaming];
  }
  if (apiRetryClearEvent) {
    return [apiRetryClearEvent];
  }

  // 工具更新：scheduled 且不在任何父工具内，说明这是工具调用前的「前言」，
  // 下一段模型消息需要独立核对正文，所以清掉本轮累计。
  // 有 parentToolUseId 时不清理：子工具流不打断主回答的正文累计。
  // 返回值直接来自 mapToolUpdated，可能为空数组（例如只有内部字段变化），不做额外兜底。
  if (event.type === "tool.updated") {
    // 工具调用前的前言不是最终回答；下一条模型消息需要独立核对已接收正文。
    if (payload.kind === "scheduled" && !parentToolUseIdFromToolPayload(payload)) {
      streamedTurnText.delete(turnKey);
    }
    return mapToolUpdated(params.taskId, traceId, eventInputId, payload, toolProjectionMemory);
  }

  // permission.requested 只登记 toolCallId→toolName，供后续 permission.resolved 补齐名字；
  // user-input 型工具（AskUserQuestion/ExitPlanMode）不投影，见下方分支。
  // 登记是覆盖写：同一 toolCallId 的后续请求会更新名字，保证用的是最新一次 permission 携带的 toolName。
  if (event.type === "permission.requested") {
    const toolCallId = stringValue(payload.toolCallId);
    const toolName = stringValue(payload.toolName);
    if (toolCallId && toolName) {
      toolProjectionMemory?.toolNameById?.set(toolCallId, toolName);
    }
    if (isUserInputBackedPermissionToolName(toolName)) {
      // AskUserQuestion/ExitPlanMode 的 permission.requested 只是 core 的等待态标记；
      // 真正需要展示的问题会通过 interaction/requestUserInput 到达。继续把它投成普通权限，
      // UI 会出现 Allow/Deny 弹窗且无法把答案写回工具 input。
      return [];
    }
    return [permissionPayloadToStreamEvent(params.taskId, traceId, eventInputId, payload)];
  }

  // permission.resolved 依赖上面的工具名映射：事件本身通常只带 toolCallId，没有缓存时
  // UI 只能显示「未知工具」，这里把 map 传下去补齐。
  if (event.type === "permission.resolved") {
    return permissionResolvedPayloadToStreamEvents(
      params.taskId,
      traceId,
      eventInputId,
      payload,
      toolProjectionMemory?.toolNameById,
    );
  }

  // steer 排队只投「已受理」状态，不在这里改本轮正文；真正注入发生在 turn.steerDrained。
  // pendingInputId 缺失时用 eventId 兜底：它是这条排队记录的唯一稳定标识。
  if (event.type === "turn.steerQueued") {
    const source = turnSteerSourceValue(payload.source);
    return [
      {
        type: "turn_steer_queued",
        taskId: params.taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        ...(queryId ? { queryId } : {}),
        pendingInputId: stringValue(payload.pendingInputId) ?? event.eventId,
        messageId: eventInputId,
        ...(turnSteerCommandKindValue(payload.commandKind)
          ? { commandKind: turnSteerCommandKindValue(payload.commandKind) }
          : {}),
        ...(source ? { source } : {}),
        targetTurnId: stringValue(payload.targetTurnId),
        content: stringValue(payload.input) ?? "",
        raw: payload,
      },
    ];
  }

  // drain 表示排队输入已注入当前 turn，queryIds / pendingInputIds 由 CLI 给出；
  // 这里不自行推断哪些被注入，避免与 CLI 的 admission 顺序不一致。
  if (event.type === "turn.steerDrained") {
    return [
      {
        type: "turn_steer_status",
        taskId: params.taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        ...(stringArray(payload.queryIds).length > 0
          ? { queryIds: stringArray(payload.queryIds) }
          : {}),
        status: "drained",
        pendingInputIds: stringArray(payload.pendingInputIds),
        injectedMessageIds: stringArray(payload.injectedMessageIds),
        targetTurnId: stringValue(payload.targetTurnId),
        raw: payload,
      },
    ];
  }

  // turn.completed 是唯一产出 task_complete 的位置；在此之前补一条「缺失后缀」，
  // 防止流式正文因工具前言被重置后，最终回答只在 complete 的 response 里出现。
  // 这里同时是本轮投影元数据的释放点，顺序是「先补正文、再释放、最后返回」。
  if (event.type === "turn.completed") {
    const events: ZCodeStreamEvent[] = [];
    // response 是 CLI 的最终整段回答；与已发累计做前缀比较而不是相等比较：
    // 流式中途重置（工具前言）会让累计为空或较短，前缀匹配能覆盖这两种情况。
    const response = stringValue(payload.response);
    // Bugfix: 只记录“本轮收到过文字”会让工具前言屏蔽最终回答兜底。
    // 在终态之前补齐当前模型消息缺少的后缀；完整正文已到达时不重复投递。
    const streamed = streamedTurnText.get(turnKey)?.text ?? "";
    const missingResponse = response?.startsWith(streamed)
      ? response.slice(streamed.length)
      : response;
    // 只有 response 以累计开头才能安全地只补差量；不满足前缀关系说明两端不同源，
    // 此时整段重投（missingResponse = response），宁可重复也不能丢最终答案。
    if (missingResponse) {
      events.push({
        type: "agent_message_chunk",
        taskId: params.taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        content: missingResponse,
      });
    }
    events.push({
      type: "task_complete",
      taskId: params.taskId,
      traceId,
      ...(eventInputId ? { inputId: eventInputId } : {}),
      stopReason: stringValue(payload.resultType) ?? "complete",
      usage: usageFromPayload(payload.usage),
    });
    // 终态必须释放本轮投影元数据：streamingToolInputById 是进程级 Map，
    // 不在这里 clear 会随任务数增长（INV-11）。
    toolProjectionMemory?.streamingToolInputById?.clear();
    streamedTurnText.delete(turnKey);
    return events;
  }

  // 失败也要先释放投影元数据，再按 turnPhase 分流：compact 失败投影成 timeline 事件，
  // 其余投影成 task_error；两条路径都不能把半截流式工具留在缓存里。
  // 释放放在分支之前：任何 return 路径都经过它，避免新增分支时漏掉清理。
  if (event.type === "turn.failed") {
    toolProjectionMemory?.streamingToolInputById?.clear();
    streamedTurnText.delete(turnKey);
    const errorPayload = asRecord(payload.error);
    if (stringValue(payload.turnPhase) === "compact") {
      return [
        compactFailureToTimelineEvent(
          params.taskId,
          traceId,
          eventInputId,
          stringValue(errorPayload.message) ?? "ZCode compact failed",
        ),
      ];
    }
    // attribution 只在 schema 校验通过时透传；错误的归因比没有归因更危险，
    // 会让 UI 把 provider 错误显示成子 agent 错误。
    const attribution = errorAttributionSchema.safeParse(errorPayload.attribution);
    // dynamic task event 也会写入 task index；只修 snapshot 读路径仍会丢 live 归因。
    // 稳定错误码同时保留在 error 文本与 code 字段：message 仅供展示，判断逻辑只认 code；
    // 缺 code 时退回 type，保证老 CLI 的事件也能给出非空分类。
    // 这里不做 message 子串匹配（INV-05）：文本会随 i18n/版本变化，只能作为兜底展示。
    return [
      {
        type: "task_error",
        taskId: params.taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        error: stringValue(errorPayload.message) ?? "ZCode session failed",
        // type 是外层错误分类，code 才是 provider/subagent 要展示的真实错误码。
        code: stringValue(errorPayload.code) ?? stringValue(errorPayload.type),
        detail: stringValue(errorPayload.detail),
        ...(attribution.success ? { attribution: attribution.data } : {}),
      },
    ];
  }

  // 兜底交给 session_info 类映射（config/model/unsupported 等）：不在本函数穷举所有事件名，
  // 新增 informational 事件只需扩展 mapSessionInfoLikePayload。
  // composite key 与 taskKey 同构（workspaceKey + NUL + taskId），用于定位 background controls。
  return mapSessionInfoLikePayload(
    params.taskId,
    traceId,
    eventInputId,
    event.eventId,
    payload,
    backgroundTaskControlsByTaskKey,
    `${resolveWorkspaceKey(params)}\u0000${params.taskId}`,
  );
}

// retry 运行态的清除条件：已存在 apiRetry，且本次 payload 是「重试后真正产出了内容」。
// [权衡] 只看「retry 请求开始」就清会立刻清空，UI 输入栏会在每次重试时闪一下；
// 因此保留到首个有效内容为止，代价是极端情况下重试空白期会多显示一会儿。
function maybeBuildApiRetryClearOnModelProgress(
  hasActiveApiRetry: boolean,
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "session_info_update" }> | null {
  // 纯判定函数：不读也不写 apiRetry 状态，是否清除由调用方按返回值决定，
  // 保证同一 payload 多次映射不产生副作用。
  if (!hasActiveApiRetry || !isZCodeModelRetryRecoveryProgressPayload(payload)) {
    return null;
  }
  // 重试请求开始不代表恢复成功，立即清会让输入栏闪烁；
  // 只有 retry attempt 真的产出模型内容，才清掉“重试中”运行态。
  return {
    type: "session_info_update",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    apiRetry: null,
  };
}

// 模型流的三类投影：text_delta→agent_message_chunk、reasoning_delta→agent_thought_chunk、
// 其余（tool_input_start/delta/end）交给 mapToolInputStreaming。
// 空 delta 直接返回 null：CLI 会在边界发空片段，投出去会让 UI 多一次无内容渲染。
function mapModelStreaming(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
): ZCodeStreamEvent | null {
  const kind = stringValue(payload.kind);
  const delta = stringValue(payload.delta);
  const parentToolUseId = parentToolUseIdFromToolPayload(payload);
  if (kind === "text_delta") {
    if (!delta) {
      return null;
    }
    return {
      type: "agent_message_chunk",
      taskId,
      traceId,
      // messageId 透传 assistantMessageId，供上层判断「是否同一条消息」；缺失时上层按未知处理。
      ...(inputId ? { inputId } : {}),
      ...(parentToolUseId ? { parentToolUseId } : {}),
      messageId: stringValue(payload.assistantMessageId),
      content: delta,
    };
  }
  // reasoning 也带 parentToolUseId：子 agent 的思考要挂在父工具卡片内，不能混进主对话。
  if (kind === "reasoning_delta") {
    if (!delta) {
      return null;
    }
    return {
      type: "agent_thought_chunk",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      ...(parentToolUseId ? { parentToolUseId } : {}),
      content: delta,
    };
  }
  return mapToolInputStreaming(taskId, traceId, inputId, payload, toolProjectionMemory);
}

// 工具入参流式投影：tool_input_start 先建 pending 卡片，delta 累积原文后按预算决定是否
// 物化预览，后续事件在调用方收尾。toolId 是唯一键，缺失即丢弃（无法关联后续 update）。
// [资源] streamingToolInputById 的条目在 turn.completed/turn.failed 统一 clear（INV-11）。
// 本函数只产出单条事件或 null，不在这里做批处理，保证上层「一条事件一条投影」的假设成立。
function mapToolInputStreaming(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
): ZCodeStreamEvent | null {
  // 两个 Map 分工：streamingToolInputById 存原文累积与是否已物化，
  // toolNameById 存「首见即定型」的工具名，避免每个 delta 都重新推断名字。
  const streamingToolInputById = toolProjectionMemory?.streamingToolInputById;
  const toolNameById = toolProjectionMemory?.toolNameById;
  const kind = stringValue(payload.kind);
  const toolId = stringValue(payload.toolCallId);
  // 没有 toolCallId 就无法把 delta 挂到任何卡片上；丢弃比投一个匿名 update 更安全。
  // 注意该判断在取 toolName 之前：匿名事件即使带名字也不登记，防止污染 toolNameById。
  if (!toolId) {
    return null;
  }
  // 工具名可能只在 start 里给一次，后续 delta 不再重复；缓存回填保证 update 卡片不改名。
  const toolName = stringValue(payload.toolName) ?? toolNameById?.get(toolId);
  if (toolName) {
    toolNameById?.set(toolId, toolName);
  }
  const title = toolName ?? "tool";
  const parentToolUseId = parentToolUseIdFromToolPayload(payload);
  const buildRaw = (input: unknown, rawInput: string | undefined) => ({
    ...payload,
    ...(input !== undefined ? { input } : {}),
    ...(rawInput ? { streamingRawInputLength: rawInput.length } : {}),
  });

  // start 只建空 input 的占位卡片并重置 buffer：同一 toolId 复用时旧原文必须清掉，
  // 否则新调用的预览会带上一轮的入参后缀。
  // 这里就把 toolId 落进 raw，后续 delta 的 update 才能被 UI 关联到同一张卡片。
  if (kind === "tool_input_start") {
    streamingToolInputById?.set(toolId, { rawInput: "" });
    logStreamingToolInputProjection(traceId, {
      inputKeys: [],
      kind,
      projectedType: "tool_call",
      rawInputLength: 0,
      taskId,
      toolId,
      toolName,
    });
    return {
      type: "tool_call",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      input: {},
      toolName,
      kind: title,
      title,
      raw: buildRaw({}, undefined),
    };
  }

  // delta 先累积再判断是否物化；未到预算就返回 null，上层不会看到任何事件。
  // [权衡] 累计解析是 O(n²) 的根源，因此正常路径只维护 tombstone buffer，
  // 只有跨过预算或控制边界才 buildZCodeStreamingToolInputPreview 一次（见下方性能修复注释）。
  if (kind === "tool_input_delta") {
    const state = appendZCodeStreamingToolInputDelta(
      streamingToolInputById?.get(toolId),
      stringValue(payload.delta) ?? "",
    );
    streamingToolInputById?.set(toolId, state);
    if (!shouldMaterializeZCodeStreamingToolInputPreview(state, { toolName })) {
      // 性能修复：services 兼容投影曾经每个 delta 都解析累计 JSON，并把 rawInput 全量塞进 raw。
      // 这里先只维护 tombstone buffer，达到预算或控制边界再 emit，避免 host/renderer 双端 O(n²)。
      return null;
    }
    // 走到这里才真正解析累计 JSON：state 上的 marked 标记保证同一 buffer 只物化一次，
    // 后续 delta 继续追加原文也不会重复解析，直到下一次跨过控制边界。
    // rawInputLength 只记长度不记原文，避免把大段未完成 JSON 复制进事件对象。
    const preview = buildZCodeStreamingToolInputPreview(state.rawInput);
    markZCodeStreamingToolInputPreviewMaterialized(state);
    const previewToolName = toolName ?? inferStreamingToolInputToolName(preview.input);
    const previewTitle = previewToolName ?? title;
    // 名字优先用 start 阶段缓存的 toolName；只有缺失时才从已解析的入参推断，
    // 推断结果回填 Map，后续 delta 不再重复推断。
    if (previewToolName && !toolName) {
      toolNameById?.set(toolId, previewToolName);
    }
    logStreamingToolInputProjection(traceId, {
      inputKeys: inputPreviewKeys(preview.input),
      kind,
      projectedType: "tool_call_update",
      rawInputLength: state.rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
    });
    return {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      status: "pending",
      title: previewTitle,
      toolName: previewToolName,
      kind: previewTitle,
      input: preview.input,
      raw: buildRaw(preview.input, preview.rawInput),
    };
  }

  // [资源] tool_input_end 是流式输入的收口点，只读累计长度并投一条 pending 边界事件。
  // 这里不解析 JSON、也不写 completeToolInputById：紧随其后的 tool_call 已携带完整 input，
  // 在此重复解析等于让同一份大 JSON 在每个 Write/Edit 上被解析两次。
  // 反过来若不收口：UI 无法知道“输入阶段已结束”，工具卡片会一直停在输入中状态。
  // 维护 INV-11：流式缓冲的生命周期止于 end，完整事实交给后续的权威事件。
  if (kind === "tool_input_end") {
    // [失败路径] state 可能不存在（start 丢失、或 session 恢复后直接收到 end）：
    // 用空 state 兜底而不是返回 null，因为 end 对 UI 是必须消费的边界信号。
    // 兜底对象不写回 Map，避免为一条一次性事件制造无主条目。
    const state = streamingToolInputById?.get(toolId) ?? { rawInput: "" };
    // [权衡] end 阶段没有权威工具名：优先用 delta/scheduled 阶段记住的名字，
    // 再退回标题占位。这里刻意不做字段推断——半截 JSON 在 end 时不保证可解析，
    // 推断失败会得到 undefined，反而把已经正确的名字覆盖成占位。
    const previewToolName = toolName ?? title;
    const previewTitle = previewToolName ?? title;
    logStreamingToolInputProjection(traceId, {
      inputKeys: [],
      kind,
      projectedType: "tool_call_update",
      rawInputLength: state.rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
    });
    return {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      status: "pending",
      title: previewTitle,
      toolName: previewToolName,
      kind: previewTitle,
      // 性能修复：tool_input_end 与最终 tool_call 相邻时不再重复解析同一份大 JSON；
      // end 只作为生命周期边界，完整 input 交给 tool_call 一次性落库/渲染。
      // [资源] raw 只附带 streamingRawInputLength（buildRaw 仅在 rawInput 非空时加该字段），
      // 不把累计原文复制进事件。否则一次 end 就把整段文件内容再拷贝一份进事件流，
      // renderer 侧还要再持有一次，INV-11 的有界内存在这里被直接破坏。
      raw: buildRaw(undefined, state.rawInput),
    };
  }

  // [资源] tool_call 是唯一持有完整 input 的分支：先把 input 固化进
  // completeToolInputById 供后续 result/error 复用（协议 ToolCallResult 不带 input），
  // 然后立刻清空流式 rawInput。保留 state 条目而不是整条删除，是因为
  // deltaCount/lastPreviewAt 仍参与后续去重与节流判断。维护 INV-11。
  if (kind === "tool_call") {
    const state = streamingToolInputById?.get(toolId);
    // state 缺失时 rawInput 取空串：此时 input 以 payload 的完整值为准，
    // rawInput 只用于日志长度与 raw 上的长度标记，不参与语义。
    const rawInput = state?.rawInput ?? "";
    // [权衡] 用 in 判断而不是比较 undefined：显式带 input: undefined 也表示
    // “本次是完整调用”，与“根本没带 input 字段”是两种语义，后者才需要回退到流式 buffer。
    const hasCompleteInput = "input" in payload;
    const completeInput = hasCompleteInput ? payload.input : undefined;
    // [失败路径] 完整值优先：传入 completeInput 时构建函数直接返回 complete=true，
    // 不再尝试解析 rawInput，因此坏 JSON 不会在这里抛错（工具输入本就是任意文本）。
    const preview = buildZCodeStreamingToolInputPreview(
      rawInput,
      hasCompleteInput ? completeInput : undefined,
    );
    const previewToolName = toolName ?? inferStreamingToolInputToolName(preview.input);
    const previewTitle = previewToolName ?? title;
    // 只在本次事件没带 toolName 时回填 Map：协议在 scheduled 之后会回收名字，
    // 记住它是为了让后续 result/error 事件仍能投射出正确的工具类型与图标。
    if (previewToolName && !toolName) {
      toolNameById?.set(toolId, previewToolName);
    }
    // [资源] 只有 input 已完整时才固化：把半截 JSON 的预览对象写进
    // completeToolInputById，会让 result 阶段读到残缺 input 并投出错误的 todo/plan。
    // 固化也是后续 forget 能真正释放内存的前提（INV-11）。
    if ((hasCompleteInput || preview.complete) && toolProjectionMemory) {
      finalizeZCodeToolProjectionInput(toolId, preview.input, toolProjectionMemory);
    }
    // [资源] 保留条目、清空 rawInput：条目本身只占常量级字段，
    // 真正的大字符串在这里释放，避免并发长任务时 host 内存随工具数线性增长。
    streamingToolInputById?.set(toolId, {
      // 性能修复：最终 tool_call 已经持有完整 input，compat projection 不再长期保留
      // streaming raw buffer，避免并发长任务时 host 侧内存和序列化成本继续放大。
      // 置空即释放；下一行的 lastPreviewRawInputLength 只记录长度，不保留内容。
      rawInput: "",
      deltaCount: state?.deltaCount,
      lastPreviewAt: Date.now(),
      lastPreviewRawInputLength: rawInput.length,
    });
    logStreamingToolInputProjection(traceId, {
      inputKeys: inputPreviewKeys(preview.input),
      kind,
      projectedType: "tool_call_update",
      rawInputLength: rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
    });
    return {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      status: "pending",
      title: previewTitle,
      toolName: previewToolName,
      kind: previewTitle,
      input: preview.input,
      raw: buildRaw(preview.input, preview.rawInput),
    };
  }

  return null;
}

// 职责：记录一条流式工具输入投影的 debug 遥测。
// 输入：traceId、taskId、toolId 与投影摘要（字段名列表 + 长度），不含任何原文。
// 副作用：仅写日志，不读写投影状态；即使 logger 内部失败也不影响调用方。
// [权衡] 必须是 debug：它与 delta 同频，用 info 会让生产日志量随 token 线性膨胀。
// 只记字段名与长度，避免把用户文件正文、命令或密钥写进日志（INV-11 的隐私侧）。
function logStreamingToolInputProjection(
  traceId: TraceId,
  details: {
    inputKeys: string[];
    kind: string;
    projectedType: "tool_call" | "tool_call_update";
    rawInputLength: number;
    taskId: string;
    toolId: string;
    toolName?: string;
  },
): void {
  logger.debug(traceId, "ZCode streaming tool input projected", {
    ...details,
    event: "zcode.task.streaming_tool_input.projected",
  });
}

// 只取顶层字段名：既让日志能判断“半截 JSON 已长到哪个字段”，
// 又不复制任何值。嵌套结构不展开，保证单条日志长度与 payload 大小无关。
function inputPreviewKeys(input: unknown): string[] {
  return Object.keys(asRecord(input));
}

// 职责：协议未带 toolName 时，按 input 的字段形状推断 Edit/Write。
// 输入：可能是半截 JSON 的预览对象；输出：工具名或 undefined，不做猜测性默认。
// [权衡] 先判 old_string 再判 content/new_string：Edit 的 input 同时包含
// old_string 与 new_string，若先判后者，所有 Edit 都会被误标成 Write，
// UI 图标与实际渲染路径（diff vs 全文）都会错。
function inferStreamingToolInputToolName(input: unknown): string | undefined {
  const record = asRecord(input);
  const filePath = readStreamingToolInputStringField(record, [
    "file_path",
    "filePath",
    "path",
    "target_path",
    "targetPath",
    "filename",
    "file",
  ]);
  if (!filePath) {
    return undefined;
  }
  if (
    // [失败路径] 字段存在但为空串时不会判定为 Edit：该读取函数返回 ""，
    // 在 if 条件里为假，于是落到 Write 分支——空 old_string 本身就是“新建文件”语义。
    readStreamingToolInputStringField(record, ["old_string", "oldString", "old_text", "oldText"])
  ) {
    return "Edit";
  }
  if (
    readStreamingToolInputStringField(record, [
      "content",
      "new_string",
      "newString",
      "new_text",
      "newText",
    ]) !== undefined
  ) {
    return "Write";
  }
  return undefined;
}

// 按数组顺序返回第一个字符串字段；不 trim、不校验内容，
// 调用方只关心该字段是否以字符串形态出现过。多个别名共存时以顺序为准，
// 保证同一份 input 在不同别名写法下推断结果稳定。
function readStreamingToolInputStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

// 职责：把 compact 生命周期 payload 投成由 agent_message_chunk 承载的 timeline 分隔条。
// 输出：content 恒为空串——压缩摘要属于内部状态，不能作为 assistant 正文流进聊天区。
// [失败路径] 缺 operationId 或 status 时返回 null：宁可不显示分隔条，
// 也不投一条无法闭合的状态，否则 UI 会留下一个永远“压缩中”的占位。
function mapCompactTimelinePayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> | null {
  const timeline = compactTimelineMetaFromPayload(payload, inputId);
  if (!timeline) {
    return null;
  }
  // messageId 只透传不生成：压缩分隔条不属于任何 assistant 消息，
  // 凭空空造 id 会让 UI 的排序与重放对不上真实消息序列。
  const messageId = stringValue(payload.messageId);
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(messageId ? { messageId } : {}),
    // compact lifecycle 是结构化状态事件，不是 assistant 正文。
    // 即使上游误带 text，也不能把内部 summary/prompt 投影到聊天区。
    content: "",
    zcodeTimeline: timeline,
  };
}

// 职责：识别 part.upserted 中的 synthetic text（例如 fork notice），投成 timeline 分隔条。
// 输入：payload.part 必须 type=text 且能解析出 timeline 元数据，否则返回 null。
// [权衡] 正文仍放进 content 而不是丢弃：fork notice 需要可见，
// 但 timeline 字段让 UI 按分隔条而不是普通气泡渲染，避免多出一轮假对话。
function mapSyntheticTimelinePartPayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> | null {
  const part = asRecord(payload.part);
  // [失败路径] 非 text part（tool/image/reasoning）一律不处理：它们各有独立投影通道，
  // 在这里统一抽 text 会把工具卡片内容重复投成聊天消息。
  if (part.type !== "text") {
    return null;
  }
  const timeline = extractSyntheticTimelineFromTextPart(
    part as Extract<ZCodeMessagePart, { type: "text" }>,
  );
  if (!timeline) {
    return null;
  }
  // 两级 messageId 回退：part 级优先、payload 级兜底；两者都缺失就不带该字段，
  // 让 UI 按 timeline 顺序自行渲染，而不是生成一个伪造 id。
  const messageId = stringValue(part.messageId) ?? stringValue(payload.messageId);
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(messageId ? { messageId } : {}),
    content: stringValue(part.text) ?? "",
    // fork notice 是 part.upserted 里的结构化 synthetic text，不是模型正文 delta。
    // 这里提前投成 timeline divider，避免 UI 按普通消息渲染后丢掉横线。
    zcodeTimeline: timeline,
  };
}

// 职责：把任意来源的 compact 元数据归一成 ZCodeContextCompactionTimelineMeta（version=1）。
// 输入口径：operationId 与 status 是必需项，缺一即视为不是 compact 事件。
// [权衡] 可选字段用条件展开而不是赋 undefined：显式 undefined 会覆盖上一次投影里的
// 已知值（例如 startedAt），让 UI 在 started→retrying 转换时丢失开始时间。
function compactTimelineMetaFromPayload(
  payload: Record<string, unknown>,
  inputId: InputId | undefined,
): ZCodeContextCompactionTimelineMeta | null {
  const operationId = stringValue(payload.operationId);
  const status = timelineStatusValue(payload.status ?? payload.timelineStatus);
  if (!operationId || !status) {
    return null;
  }
  // [权衡] 缺 trigger 时降级为 manual 而不是丢弃事件：压缩已经发生，UI 必须有分隔条；
  // 但 status 绝不设默认值——“进行中/已完成/失败”猜错会让用户误判数据是否已压缩。
  const trigger = timelineTriggerValue(payload.trigger) ?? "manual";
  const replace = booleanValue(payload.replace);
  const reason = stringValue(payload.reason);
  const boundaryId = stringValue(payload.boundaryId);
  const summaryMessageId = stringValue(payload.summaryMessageId);
  const preCompactTokenCount = numberValue(payload.preCompactTokenCount);
  const postCompactTokenCount = numberValue(payload.postCompactTokenCount);
  const truePostCompactTokenCount = numberValue(payload.truePostCompactTokenCount);
  const attempt = numberValue(payload.attempt);
  const maxAttempts = numberValue(payload.maxAttempts);
  const startedAt = numberValue(payload.startedAt);
  const endedAt = numberValue(payload.endedAt);
  return {
    version: 1,
    kind: "synthetic",
    type: "context_compaction",
    operationId,
    status,
    trigger,
    display: "separator",
    ...(inputId ? { inputId } : {}),
    ...(replace !== undefined ? { replace } : {}),
    ...(reason ? { reason } : {}),
    ...(boundaryId ? { boundaryId } : {}),
    ...(summaryMessageId ? { summaryMessageId } : {}),
    ...(preCompactTokenCount !== undefined ? { preCompactTokenCount } : {}),
    ...(postCompactTokenCount !== undefined ? { postCompactTokenCount } : {}),
    ...(truePostCompactTokenCount !== undefined ? { truePostCompactTokenCount } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
}

// 职责：compact 失败只带回 reason 文本时，合成一条 failed/interrupted 分隔条。
// 副作用：无；endedAt 取当前时间，用于结束 UI 上“压缩中”的转圈状态。
// [权衡] 用 reason 正则区分 interrupted/failed：上游没有稳定 reasonCode，
// 只能在文本上兜底；若将来补上稳定码，应改为按码分流（与 INV-05 一致）。
function compactFailureToTimelineEvent(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  reason: string,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> {
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    content: "",
    zcodeTimeline: {
      version: 1,
      kind: "synthetic",
      type: "context_compaction",
      operationId: `compact-failed-${inputId ?? traceId}`,
      // 先匹配“被打断”语义、其余归 failed：用户取消与真正报错在 UI 上是两种终态，
      // 归错会让用户主动取消的压缩被显示成系统故障。
      status: /abort|cancel|interrupt|stop/i.test(reason) ? "interrupted" : "failed",
      trigger: "manual",
      display: "separator",
      ...(inputId ? { inputId } : {}),
      reason,
      endedAt: Date.now(),
    },
  };
}

// 职责：把协议 tool.updated 的三种载荷形态（scheduled / result / error）投成一到两个流事件。
// 输入：payload 至少含 toolCallId；memory 提供跨事件的工具名与已固化 input。
// 输出：[tool_call] / [tool_call_update]，必要时追加 [plan]；无 toolCallId 时返回空数组。
// [资源] 终态统一走 forgetZCodeToolProjectionMetadata 释放三张 Map（名字/完整 input/流式缓冲），
// 这是 INV-11 在结果侧的收口点；漏掉会让每个工具在进程生命周期内留下残留条目。
// 分支顺序：input+toolName → result → error → in_progress。三者协议上互斥，
// 顺序判错会把 error 当成中间态，工具卡片永远停在进行中。
function mapToolUpdated(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
): ZCodeStreamEvent[] {
  // toolCallId 是整条投影的锚点：没有它既不能更新已发事件，也无法定位要释放的记忆，
  // 因此直接返回空数组，而不是造一个临时 id 制造无法回收的条目。
  const toolId = stringValue(payload.toolCallId);
  if (!toolId) {
    return [];
  }
  // 父工具 id 在这里一次性归一：嵌套 subagent 的卡片层级完全依赖它，
  // 若让 UI 自己兼容三种字段名，任何一条链路漏改都会导致子工具挂错父级。
  const parentToolUseId = parentToolUseIdFromToolPayload(payload);
  // memory 缺省时退化成空对象：内部所有读写都是可选链，投影仍能产出事件，
  // 只是失去跨事件的工具名/input 记忆，不改变本函数的纯函数性质。
  const memory = toolProjectionMemory ?? {};
  const toolNameById = memory.toolNameById;
  // 先解析记忆再分支：scheduled 会写入名字与 input，result/error 只读取；
  // 读写顺序反了会让 result 读到本次尚未写入的旧值（或读不到值）。
  const rememberedTool = resolveZCodeToolProjectionMetadata(payload, toolId, memory);
  const rememberedToolName = rememberedTool.toolName;
  const rememberedInput = rememberedTool.hasInput ? rememberedTool.input : undefined;
  // 同时存在 input 与 toolName 才是“工具已调度”的完整信号；
  // 只有 input 没有名字时无法区分这是 scheduled 还是某条 update 的补充字段，
  // 落到后面的分支语义更安全。
  if ("input" in payload && "toolName" in payload) {
    // [权衡] scheduled 分支必须有名字：协议此处一定带 toolName，缺失时用 "tool" 占位
    // 而不是跳过事件——跳过会让整张工具卡片消失，占位至少保留可读的进行中状态。
    const toolName = rememberedToolName ?? "tool";
    toolNameById?.set(toolId, toolName);
    finalizeZCodeToolProjectionInput(toolId, payload.input, memory);
    const toolEvent: ZCodeStreamEvent = {
      type: "tool_call",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      input: payload.input,
      toolName,
      kind: toolName,
      title: toolName,
      raw: payload,
    };
    // [权衡] 只在主 agent 的 scheduled 上尝试抽取 plan：并行 subagent 也会调用 TodoWrite，
    // 若一并投射，子 agent 的待办会覆盖主任务进度条。
    const planSteps = isMainAgentToolProjectionSource(payload)
      ? extractPlanStepsFromToolInput({
          title: toolName,
          kind: toolName,
          input: payload.input,
        })
      : null;
    if (!planSteps) {
      return [toolEvent];
    }
    return [
      toolEvent,
      {
        type: "plan",
        taskId,
        traceId,
        ...(inputId ? { inputId } : {}),
        steps: planSteps,
      },
    ];
  }
  // result 分支既不带 input 也不带 toolName，只能靠 memory 还原；
  // 事件里回填 rememberedInput 是为了让 UI 不重放 scheduled 也能渲染工具卡片，
  // 冷恢复路径尤其依赖这一点。
  if ("result" in payload) {
    const result = asRecord(payload.result);
    // ZCode Protocol 的 ToolCallResult 只有 toolCallId/result，不再重复带 toolName。
    // 去掉 ZCode Agent 后如果不记住前序 ToolCallScheduled 的 TodoWrite 名称，result 里的 todos
    // 就只能当普通字符串输出，无法继续投射成顶部 todo/plan 事件。
    // 这里刻意不做 ?? "tool" 兜底：undefined 会显式告诉 UI “名字未知”，
    // 比伪造一个 "tool" 更利于排查协议丢字段，也避免用错图标。
    const toolName = rememberedToolName;
    // content 归一与 status 判定都依赖 toolName：名字丢失时 normalize 只能做字符串兜底，
    // 这正是前面必须在 scheduled 阶段记住名字的原因。
    const content = normalizeToolResultContent(toolName, result);
    // status 由工具语义与后台启动 ACK 共同决定，不能只看 success：
    // 后台 subagent 的启动确认是成功返回，但任务仍在运行（见 toolResultStatus）。
    const status = toolResultStatus(toolName, result);
    const toolEvent: ZCodeStreamEvent = {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      toolName,
      kind: toolName,
      title: toolName,
      ...(rememberedInput !== undefined ? { input: rememberedInput } : {}),
      status,
      content,
      error: stringValue(asRecord(result.error).message),
      raw: payload,
    };
    // [资源] 非 in_progress 即终态，立刻释放名字/完整 input/流式缓冲三张 Map。
    // delete 天然幂等，重复清理不会报错，满足 INV-12 对清理可重入的要求。
    // 若在 in_progress 就释放：后续 result 会丢工具名，todo/plan 投射失效。
    if (status !== "in_progress") {
      forgetZCodeToolProjectionMetadata(toolId, memory);
    }
    // result 侧同样只对主 agent 抽取 plan：工具输出里的 todos 可能来自子 agent，
    // 不能覆盖主任务进度。
    const planSteps = isMainAgentToolProjectionSource(payload)
      ? extractPlanStepsFromToolOutput({
          title: toolName,
          kind: toolName,
          output: content ?? result,
        })
      : null;
    if (!planSteps) {
      return [toolEvent];
    }
    return [
      toolEvent,
      {
        type: "plan",
        taskId,
        traceId,
        ...(inputId ? { inputId } : {}),
        steps: planSteps,
      },
    ];
  }
  // error 分支既没有 result 也没有 input：先把名字与 input 读进局部变量，
  // 再释放记忆并投 failed，保证异常工具不会把大 input 留在进程里（INV-11）。
  if ("error" in payload) {
    forgetZCodeToolProjectionMetadata(toolId, memory);
    return [
      {
        type: "tool_call_update",
        taskId,
        traceId,
        ...(inputId ? { inputId } : {}),
        toolId,
        parentToolUseId,
        // 即使 error 只有 message，也必须投 failed 终态：否则 UI 的进行中指示会一直存在，
        // 用户无法区分“工具还在跑”与“工具已失败但上游没发 result”。
        toolName: rememberedToolName,
        kind: rememberedToolName,
        title: rememberedToolName,
        ...(rememberedInput !== undefined ? { input: rememberedInput } : {}),
        status: "failed",
        error: stringValue(asRecord(payload.error).message) ?? "Tool failed",
        raw: payload,
      },
    ];
  }
  return [
    {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      toolName: rememberedToolName,
      kind: rememberedToolName,
      title: rememberedToolName,
      // [权衡] inputOmitted 为 true 时不再回填 rememberedInput：上游已用该标记声明
      // “本次不要重发大 input”，继续带上会让每条 update 都复制一遍完整文件内容（INV-11）。
      ...(rememberedInput !== undefined && payload.inputOmitted !== true
        ? { input: rememberedInput }
        : {}),
      status: "in_progress",
      raw: payload,
    },
  ];
}

// 职责：把 ToolCallResult 映射成 UI 工具状态。
// 输入：toolName 可能为 undefined（协议 result 不带名字），result 为结构化结果。
// [失败路径] success === false 优先判 failed，即使它看起来像后台启动返回：
// 启动失败必须立即报错，不能像启动确认那样保持 in_progress。
function toolResultStatus(
  toolName: string | undefined,
  result: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "tool_call_update" }>["status"] {
  if (result.success === false) {
    return "failed";
  }
  // [权衡] 后台启动 ACK 投成 in_progress 而不是 completed：子 agent 的真实完成
  // 由后续 background task notification 驱动；提前标完成会让前端在真实结束前
  // 停掉 subagent 卡片的刷新，用户看到的是错误的“已完成”。
  if (isBackgroundAgentLaunchResult(toolName, result)) {
    // Agent 后台启动 ACK 只是子 agent 已创建，不代表子 agent 已完成；
    // 投影成 completed 会让前端在真实 completion 前把 subagent 卡片误标为完成。
    return "in_progress";
  }
  return "completed";
}

// 职责：判断 result.content 是“后台 Agent 已启动”的确认，还是执行结果本身。
// 输入：content 可能是纯文本 ACK，也可能是 JSON 字符串，两种形态都要识别。
// [权衡] toolName 为 undefined 时也接受文本 ACK：冷恢复路径可能丢名字，
// 此时宁可多认一条 ACK，也不要把启动确认投成 completed 掩盖仍在运行的任务。
function isBackgroundAgentLaunchResult(
  toolName: string | undefined,
  result: Record<string, unknown>,
): boolean {
  const content = stringValue(result.content);
  if (!content) {
    return false;
  }
  if (
    (isSubagentDispatchToolName(toolName) || toolName === undefined) &&
    isBackgroundAgentLaunchAcknowledgement(content)
  ) {
    return true;
  }
  // [失败路径] 非 JSON 的 content 在这里得到 null，函数回落为 false；
  // 解析失败不能抛错，因为工具输出本来就是模型自由生成的任意文本。
  const parsed = parseJsonRecord(content);
  const parsedStatus = stringValue(parsed?.status);
  return (
    parsed !== null &&
    (isSubagentDispatchToolName(toolName) || stringValue(parsed.agentId) !== undefined) &&
    ((parsedStatus === "backgrounded" && stringValue(parsed.backgroundTaskId) !== undefined) ||
      (parsedStatus === "async_launched" &&
        stringValue(parsed.agentId) !== undefined &&
        stringValue(parsed.outputFile) !== undefined))
  );
}

// 三代 ACK 文案都要识别：模型可见文案随版本演进（backgroundTaskId→outputFile→output_file），
// 但历史会话的 replay 仍会带旧文案；只认最新一代会让旧任务在恢复后显示成已完成。
function isBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  // subagent async launch 的模型可见 ACK 从 backgroundTaskId/outputFile 文案迁到 output_file 文案；
  // service projection 需要同时识别新旧格式，否则会把启动确认当成已完成结果发给 UI。
  return (
    isLegacyBackgroundAgentLaunchAcknowledgement(content) ||
    isPreviousBackgroundAgentLaunchAcknowledgement(content) ||
    isCurrentBackgroundAgentLaunchAcknowledgement(content)
  );
}

// 第一代：带 backgroundTaskId 且声明 runtime 会等待。
// 两个特征同时命中才认，避免普通说明文本里出现同名词就被误判。
function isLegacyBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  return (
    content.includes("backgroundTaskId:") &&
    content.includes("Runtime will wait for this background Agent")
  );
}

// 第二代：agentId + outputFile + 固定尾句；用 startsWith 限定句首，
// 防止结果正文里引用这段说明时被误判成启动确认。
function isPreviousBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  return (
    content.startsWith("Agent ") &&
    content.includes(" started in background.") &&
    content.includes("agentId:") &&
    content.includes("outputFile:") &&
    content.includes("You will be notified when the Agent completes.")
  );
}

// 第三代：output_file 文案 + “notified automatically”；同样要求句首与尾句同时命中。
function isCurrentBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  return (
    content.startsWith("Async agent launched successfully.") &&
    content.includes("agentId:") &&
    content.includes("The agent is working in the background.") &&
    content.includes("notified automatically when it completes")
  );
}

// Agent 是当前协议的工具名，Task 是旧命名；两者都要认，
// 否则旧会话恢复后后台启动 ACK 会被当成普通结果立即标完成。
function isSubagentDispatchToolName(toolName: string | undefined): boolean {
  return toolName === "Agent" || toolName === "Task";
}

// 把三种父级字段来源归一成一个 UI 字段：UI 侧 parentToolUseId、
// 协议侧 parentToolCallId、以及 raw Claude 透传的 _meta.claudeCode.parentToolUseId。
// [权衡] 按优先级取第一个非空值而不是合并：三者语义相同，
// 混用会让同一工具出现两个父 id，嵌套层级错乱。
function parentToolUseIdFromToolPayload(payload: Record<string, unknown>): string | null {
  // ZCode Protocol 发送的父级字段叫 parentToolCallId；
  // UI stream 模型统一消费 parentToolUseId，必须在服务投影层完成一次性归一。
  return (
    stringValue(payload.parentToolUseId) ??
    stringValue(payload.parentToolCallId) ??
    rawClaudeParentToolUseId(payload)
  );
}

// 纯防御式读取：raw 可能不是对象，_meta/claudeCode 也可能是 null；
// 任一层缺失都返回 null 而不抛错，因为该字段只影响嵌套展示，不应中断投影。
function rawClaudeParentToolUseId(raw: unknown): string | null {
  const meta = asRecord(raw)._meta;
  const claudeCode = asRecord(meta).claudeCode;
  return stringValue(asRecord(claudeCode).parentToolUseId) ?? null;
}

// 职责：把 result.content 归一成 UI 可直接渲染的形态。
// 输出：Agent 类结果转 agent_activity 结构，其余仅接受字符串。
// [权衡] 非字符串且非 Agent 的结构化 content 在这里被丢弃（返回 undefined）：
// 当前协议只保证 text，保留原始数组会迫使每个 UI 入口各自解析一遍。
function normalizeToolResultContent(
  toolName: string | undefined,
  result: Record<string, unknown>,
): unknown {
  const content = result.content;
  const agentActivity = parseAgentActivityResultContent(toolName, content);
  return agentActivity ?? stringValue(content);
}

// 职责：识别 Agent/Task 的 JSON 结果并抽出正文与 thought。
// 输入：content 必须是非空字符串且能被 JSON.parse，否则返回 null 交由上层字符串兜底。
// [失败路径] 判据同时接受 toolName 与 agentId/agentType 字段：
// 冷恢复时工具名可能丢失，靠结果自身字段仍能识别出这是 agent 结果。
function parseAgentActivityResultContent(
  toolName: string | undefined,
  content: unknown,
): { kind: "agent_activity"; content: string; thought?: string } | null {
  // 空串/空白串直接放弃：JSON.parse("") 会抛异常，而且空内容也没有可展示的摘要。
  if (typeof content !== "string" || content.trim().length === 0) {
    return null;
  }
  const parsed = parseJsonRecord(content);
  if (!parsed) {
    return null;
  }
  const isAgentResult =
    toolName === "Agent" ||
    toolName === "Task" ||
    stringValue(parsed.agentId) !== undefined ||
    stringValue(parsed.agentType) !== undefined;
  if (!isAgentResult) {
    return null;
  }
  // Agent 工具结果是 JSON 字符串，最终摘要在 content[].text；
  // 服务层先转成 agent_activity，避免 UI 每条渲染路径都猜原始 JSON。
  // 摘要正文在 content 数组的 text 字段里；取不到就返回 null，
  // 让上层退回原始字符串，而不是投出一张空白的 agent 卡片。
  const output = agentTextFromContentField(parsed.content);
  if (!output) {
    return null;
  }
  const thought = stringValue(parsed.thought);
  return {
    kind: "agent_activity",
    content: output,
    ...(thought ? { thought } : {}),
  };
}

// [失败路径] 解析失败返回 null 而不抛出：流式投影路径上的任何异常都会中断整条消息流，
// 而工具输出是模型自由生成的文本，坏 JSON 属于正常输入而非异常。
function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

// 兼容两种形态：直接字符串，或 [{text}] 数组（按换行拼接）。
// 过滤空字符串，避免数组里存在占位项时产生多余空行。
function agentTextFromContentField(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const text = value
    .map((item) => stringValue(asRecord(item).text))
    .filter((item): item is string => Boolean(item))
    .join("\n");
  return text || undefined;
}

// 职责：把权限请求参数投成旧 task 流能消费的 permission_request。
// 副作用：无；traceId 按 taskId 现生成，保证每条请求都能独立追踪。
// [权衡] description 用 reason 优先、toolName 兜底：reason 才是给用户看的文案，
// toolName 只是机器标识；反过来会让审批弹窗出现 “Bash” 这种无信息文本。
function permissionRequestToStreamEvent(
  taskId: string,
  request: ZCodePermissionRequestParams,
): ZCodePermissionRequest {
  return {
    type: "permission_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: request.requestId,
    description: request.reason || request.toolName,
    kind: request.toolName,
    title: request.toolName,
    options: request.options,
    ...(request.origin ? { origin: request.origin } : {}),
    raw: request,
  };
}

// 与 permissionRequestToStreamEvent 口径一致，区别是数据来自 snapshot 的 pendingPermissions：
// 用于冷恢复/replay 时把仍挂起的审批重新投给 UI。字段映射必须与实时路径完全对齐，
// 否则恢复前后同一条审批的 title/options 会变化。这里不做去重，去重由调用方负责。
function pendingPermissionToStreamEvent(
  taskId: string,
  permission: ZCodeSessionStateSnapshot["projection"]["pendingPermissions"][number],
): ZCodePermissionRequest {
  return {
    type: "permission_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: permission.requestId,
    description: permission.reason || permission.toolName,
    kind: permission.toolName,
    title: permission.toolName,
    options: permission.options,
    ...(permission.origin ? { origin: permission.origin } : {}),
    raw: permission,
  };
}

// 职责：把 user-input 请求投成 elicitation_request，并保留全部问题供多步表单渲染。
// 输出：顶层 message/header/options 取第一问，questions 保留完整列表（含多选标记）。
// [失败路径] 没有 questions 时降级为空数组并用 request.prompt 兜底，绝不返回 null：
// 请求已经发出，UI 缺条目会导致用户无法响应、任务永久挂起。
function userInputRequestToElicitationStreamEvent(
  taskId: string,
  request: ZCodeUserInputRequestParams,
): ZCodeStreamEvent {
  const questions =
    // 逐字段白名单拷贝：只透出 UI 需要的 value/label/description，
    // 不把上游 question 的额外字段（内部 id、默认值）带进事件流。
    request.questions?.map((question) => ({
      question: question.question,
      header: question.header,
      options: question.options.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description,
      })),
      ...(question.multiSelect ? { multiSelect: true } : {}),
    })) ?? [];
  const firstQuestion = questions[0];
  const requestSchema = asRecord(request.schema);
  const requestInput = asRecord(request.input);
  const plan =
    // ExitPlanMode 的计划正文在 request.input.plan，schema 只描述交互形态；
    // 两者必须合并投影，否则审批卡片拿不到计划正文。
    requestSchema.interaction === "plan_approval" &&
    typeof requestInput.plan === "string" &&
    requestInput.plan.trim()
      ? requestInput.plan.trim()
      : undefined;
  return {
    type: "elicitation_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: request.requestId,
    message: firstQuestion?.question ?? request.prompt ?? "Input required",
    header: firstQuestion?.header,
    options: firstQuestion?.options ?? [],
    ...(firstQuestion?.multiSelect ? { multiSelect: true } : {}),
    ...(questions.length > 0 ? { questions } : {}),
    ...(request.origin ? { origin: request.origin } : {}),
    // ExitPlanMode 的 request 同时携带 schema 和 input；直接取 `schema ?? input`
    // 会丢掉 input.plan，审批投影因而缺少正文。
    // 这里只合入 plan，保持普通 elicitation 以及其他工具 input 的数据边界。
    // 只合入 plan 一个键：把整个 input 并进 schema 会越界暴露其他工具参数，
    // 也会让普通 elicitation 的 schema 形状随工具变化而不稳定。
    schema: plan ? { ...requestSchema, plan } : (request.schema ?? request.input),
  };
}

// 职责：把用户对 elicitation 的响应原样投回流。action 不做归一：
// accept/decline/cancel 是协议约定值，改写会让 CLI 无法区分取消与拒绝。
// 空 content 不展开字段，避免 UI 把“未填写”当成空字符串答案。
function userInputResponseToElicitationStreamEvent(
  taskId: string,
  requestId: string,
  response: ZCodeUserInputResponse,
): Extract<ZCodeStreamEvent, { type: "elicitation_response" }> {
  return {
    type: "elicitation_response",
    taskId,
    traceId: generateTraceId(taskId),
    requestId,
    action: response.action,
    ...(response.content ? { content: response.content } : {}),
  };
}

// 投影层中间类型：只描述“渲染一个问题”所需的字段，与协议 question 解耦，
// 便于 AskUserQuestion 与 ExitPlanMode 两种来源复用同一套 UI 契约。
type PendingElicitationQuestion = {
  question: string;
  header: string;
  options: Array<{ value: string; label: string; description?: string }>;
  multiSelect?: boolean;
};

// 职责：把“以权限形式挂起、实质是 user input”的工具请求改投成 elicitation。
// [权衡] 按工具名分流而不是看 options 形状：这两种工具的语义只有名字能稳定表达，
// 靠字段猜测会把普通权限请求误投成表单。
function pendingUserInputBackedPermissionToElicitationEvent(
  taskId: string,
  permission: ZCodeSessionStateSnapshot["projection"]["pendingPermissions"][number],
): Extract<ZCodeStreamEvent, { type: "elicitation_request" }> | null {
  if (isAskUserQuestionToolName(permission.toolName)) {
    return pendingAskUserQuestionToElicitationEvent(taskId, permission);
  }
  if (isExitPlanModeToolName(permission.toolName)) {
    return pendingExitPlanModeToElicitationEvent(taskId, permission);
  }
  return null;
}

// 把 AskUserQuestion 的 input.questions 转成 elicitation；解析不出任何完整问题时
// 返回 null，让调用方回落成普通 permission_request，而不是投一个没有选项的死表单。
// schema 直接透传 permission.input，供 UI 提交时原样回填。
function pendingAskUserQuestionToElicitationEvent(
  taskId: string,
  permission: ZCodeSessionStateSnapshot["projection"]["pendingPermissions"][number],
): Extract<ZCodeStreamEvent, { type: "elicitation_request" }> | null {
  const questions = askUserQuestionInputToElicitationQuestions(permission.input);
  if (questions.length === 0) {
    return null;
  }
  const firstQuestion = questions[0];
  return {
    type: "elicitation_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: permission.requestId,
    // 顶层 message 必须有内容：没有 question 时用 permission.reason 兜底，
    // 空 message 会让审批卡片的标题区塌陷。
    message: firstQuestion?.question ?? permission.reason,
    header: firstQuestion?.header,
    options: firstQuestion?.options ?? [],
    ...(firstQuestion?.multiSelect ? { multiSelect: true } : {}),
    questions,
    ...(permission.origin ? { origin: permission.origin } : {}),
    schema: permission.input,
  };
}

// ExitPlanMode 在快照里只剩一条 permission：这里合成固定的 Approve 问题，
// 让桌面与移动端用同一套 elicitation 交互渲染计划审批。
// [权衡] 不单独建 Reject 选项：拒绝走 permission_response 的 deny 语义，
// 若这里也提供拒绝，两个通道会产生互相矛盾的终态。
function pendingExitPlanModeToElicitationEvent(
  taskId: string,
  permission: ZCodeSessionStateSnapshot["projection"]["pendingPermissions"][number],
): Extract<ZCodeStreamEvent, { type: "elicitation_request" }> {
  const questions = createExitPlanModeApprovalQuestions();
  const firstQuestion = questions[0];
  const input = asRecord(permission.input);
  // 计划正文只取非空白字符串；trim 后为空视为没有正文，不投空 schema.plan。
  const plan = typeof input.plan === "string" && input.plan.trim() ? input.plan.trim() : undefined;
  return {
    type: "elicitation_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: permission.requestId,
    message: firstQuestion.question,
    header: firstQuestion.header,
    options: firstQuestion.options,
    questions,
    ...(permission.origin ? { origin: permission.origin } : {}),
    // 计划审批投影必须展示本次 ExitPlanMode 对应的计划正文；
    // 这里只定向投影 plan，避免把其他 permission input 泄漏到通用 elicitation schema。
    schema: {
      // 定向投影：只带 interaction/toolName/plan 三个键，
      // 防止 permission.input 中的其他参数进入通用 elicitation schema。
      interaction: "plan_approval",
      toolName: permission.toolName,
      ...(plan ? { plan } : {}),
    },
  };
}

// 职责：把某个 taskKey 的后台任务控制项整表写回进程级缓存。
// [资源] cache 可能为 undefined（调用方未持有 task 记忆），此时静默跳过；
// 写入是覆盖而非合并，重复调用幂等（INV-12）。条目随外层 Map 在任务销毁时释放。
function setTaskBackgroundTaskControlCache(
  cache: Map<string, ZCodeBackgroundTaskControlItem[]> | undefined,
  cacheKey: string,
  jobs: ZCodeBackgroundTaskControlItem[],
) {
  cache?.set(cacheKey, jobs);
}

// 职责：解析单条 payload 里的后台任务变更，与同 taskKey 的缓存列表按 jobId 合并。
// 输出：合并后的完整列表（供本次事件直接下发）；payload 不含任何 job 时返回 null，不投事件。
// [权衡] 返回合并结果而不是增量：后台任务面板是整表渲染，
// 只发增量会让晚加入的 renderer 无法重建全量状态。
// [资源] 合并按 jobId 覆盖，不随更新次数增长；但不同 jobId 永不淘汰，
// 规模取决于单个任务出现过的后台任务数（已在汇报中标注为风险点）。
function updateTaskBackgroundTaskControlCacheFromPayload(
  cache: Map<string, ZCodeBackgroundTaskControlItem[]> | undefined,
  cacheKey: string,
  payload: Record<string, unknown>,
): ZCodeBackgroundTaskControlItem[] | null {
  // 把单条 payload 包成数组复用批量解析：字段校验与 jobId 归一都由解析器负责，
  // 这里不再自行判断 payload 形状，避免两套口径。
  const parsedJobs = parseZCodeBackgroundTaskControlItems([payload]);
  if (parsedJobs.length === 0) {
    return null;
  }
  // 无缓存时只做本次投影，不承担跨事件合并：这是纯函数式降级，
  // 调用方若需要全量列表必须自己持有 cache。
  if (!cache) {
    return parsedJobs;
  }
  // 按 jobId 覆盖合并：同一 job 的 status/progress 更新不会产生重复行；
  // 不同 jobId 只增不减，因此列表规模取决于本任务出现过的后台任务数。
  const nextJobs = mergeZCodeBackgroundTaskControlItems(cache.get(cacheKey) ?? [], parsedJobs);
  cache.set(cacheKey, nextJobs);
  return nextJobs;
}

// 固定的计划审批问题：文案来自常量，保证同一版本内所有入口渲染一致。
// 返回一元组类型而不是数组，让调用方无需再判空（问题项在此处必然存在）。
function createExitPlanModeApprovalQuestions(): [PendingElicitationQuestion] {
  return [
    {
      header: "Plan",
      options: [
        {
          description: "Exit plan mode and start implementation.",
          label: "Approve",
          value: EXIT_PLAN_MODE_APPROVAL_APPROVE,
        },
      ],
      question: EXIT_PLAN_MODE_APPROVAL_QUESTION,
    },
  ];
}

// 职责：把 AskUserQuestion 的 input.questions 解析成投影问题列表。
// 输出：只保留 question/header/options 都有效的条目，任一缺失即丢弃该项。
// [权衡] value 使用 label：协议的结构化选项没有独立 value，
// 若保留空 value，UI 回填时会提交空串导致 CLI 无法匹配选项。
// [失败路径] 整体非法（input 不是对象、questions 不是数组）时返回空数组，
// 由调用方决定回落成 permission_request，而不是抛错。
function askUserQuestionInputToElicitationQuestions(input: unknown): PendingElicitationQuestion[] {
  type ElicitationOption = PendingElicitationQuestion["options"][number];
  const questions = asRecord(input).questions;
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions
    .map((question) => {
      const record = asRecord(question);
      const questionText = stringValue(record.question);
      // header 缺失时退回问题正文：UI 的折叠标题需要非空字符串，空标题会让分组错位。
      const header = stringValue(record.header) ?? questionText;
      const rawOptions = Array.isArray(record.options) ? record.options : [];
      const options: ElicitationOption[] = rawOptions
        .map((option) => {
          const optionRecord = asRecord(option);
          // 没有 label 的选项直接丢弃：它既无法被点击，也无法回填成答案。
          const label = stringValue(optionRecord.label);
          if (!label) {
            return null;
          }
          const description = stringValue(optionRecord.description);
          const parsedOption: ElicitationOption = {
            value: label,
            label,
            ...(description ? { description } : {}),
          };
          return parsedOption;
        })
        .filter((option): option is ElicitationOption => option !== null);
      // 三项齐全才算有效问题：空问题、空标题或空选项都会让表单无法提交，
      // 提前过滤比让 UI 渲染一个死表单更安全。
      if (!questionText || !header || options.length === 0) {
        return null;
      }
      const parsedQuestion: PendingElicitationQuestion = {
        question: questionText,
        header,
        options,
        // 只有严格 true 才标多选：协议缺省等同单选，用真值判断会把 "false" 字符串也当多选。
        ...(record.multiSelect === true ? { multiSelect: true } : {}),
      };
      return parsedQuestion;
    })
    .filter((question): question is PendingElicitationQuestion => question !== null);
}

// 职责：把实时 permission 请求 payload 投成 permission_request。
// [失败路径] requestId 三级回退到 "unknown"：缺少它 UI 无法回传结果，
// 但丢掉事件会让用户看不到审批入口，因此保留事件并显式标记异常。
// options 直接透传协议数组，不在这一层校验（类型由协议保证）。
function permissionPayloadToStreamEvent(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): ZCodeStreamEvent {
  return {
    type: "permission_request",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    requestId: stringValue(payload.requestId) ?? stringValue(payload.toolCallId) ?? "unknown",
    description:
      stringValue(payload.reason) ?? stringValue(payload.toolName) ?? "Permission required",
    kind: stringValue(payload.toolName) ?? "tool",
    title: stringValue(payload.toolName),
    options: permissionOptionsFromPayload(payload),
    raw: payload,
  };
}

// 非数组一律视为无选项，返回空数组而不是 undefined：
// UI 契约里 options 是可迭代字段，undefined 会让调用方多一层判空。
function permissionOptionsFromPayload(payload: Record<string, unknown>): ZCodePermissionOption[] {
  return Array.isArray(payload.options) ? (payload.options as ZCodePermissionOption[]) : [];
}

// 职责：把 permission.resolved 投成“权限响应 + 可能的工具失败终态”。
// [权衡] AskUserQuestion/ExitPlanMode 走 elicitation_response 而不是 permission_response：
// 它们的结果是表单答案，不是 allow/deny；混用会让 UI 把答案当成授权结果。
// 顺序：先发响应解除弹窗，再发 tool_call_update(failed) 收尾工具卡片；
// 反过来会出现“工具已失败但审批弹窗仍在”的中间态。
function permissionResolvedPayloadToStreamEvents(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolNameById?: Map<string, string>,
): ZCodeStreamEvent[] {
  const toolCallId = stringValue(payload.toolCallId);
  const toolName =
    // 名字优先用事件自带值，缺失时用 memory 反查：resolved 事件经常只带 toolCallId。
    stringValue(payload.toolName) ?? (toolCallId ? toolNameById?.get(toolCallId) : undefined);
  const decision = stringValue(payload.decision);
  const requestId = stringValue(payload.requestId) ?? toolCallId ?? "unknown";

  // 只有这两种工具的结果才算“用户输入”；其余工具即使 options 长得像问题，
  // 也必须走 permission_response，否则 UI 会把授权结果当成答案回填。
  if (isUserInputBackedPermissionToolName(toolName)) {
    return [
      {
        type: "elicitation_response",
        taskId,
        traceId,
        ...(inputId ? { inputId } : {}),
        requestId,
        // decision 只区分 deny 与其他：非 deny 一律 accept，
        // 这样上游新增 "allow_always" 之类取值时用户答案不会丢失。
        action: decision === "deny" ? "decline" : "accept",
      },
    ];
  }

  // permission_response 先构造但延后返回：deny 分支需要把它与 tool_call_update
  // 放进同一个数组，保证 UI 在同一帧内既能关弹窗又能结束工具卡片。
  const permissionResponse = {
    type: "permission_response",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    requestId,
    // optionId 保留原始 decision 供 CLI 判定具体授权范围；response.decision 才归一到两值。
    optionId: decision ?? "allow",
    response: {
      decision: decision === "deny" ? "deny" : "allow",
    },
  } as Extract<ZCodeStreamEvent, { type: "permission_response" }>;

  // 只有明确 deny 且知道工具 id 时才补发失败终态：
  // 没有 toolCallId 就无法定位卡片，补发只会制造孤儿事件。
  if (decision !== "deny" || !toolCallId) {
    return [permissionResponse];
  }

  // Plan mode 等运行时拒绝会先发 permission.resolved，
  // 但不一定有对应 tool.updated(error) 实时事件；只清权限请求会让已 started 的工具卡一直转。
  return [
    permissionResponse,
    {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId: toolCallId,
      parentToolUseId: parentToolUseIdFromToolPayload(payload),
      status: "failed",
      toolName,
      kind: toolName,
      title: toolName,
      error: stringValue(payload.reason) ?? "Permission denied",
      raw: payload,
    },
  ];
}

// 职责：把 session.updated 一类的大杂烩 payload 拆成多条旧 task 流事件。
// 输出顺序固定：token 用量 → 网络诊断 → context 用量 → 标题 → API retry → target →
// 后台任务列表。UI 依赖这个顺序做同帧批处理，改动顺序会让 meter/标题闪回。
// [资源] backgroundTaskControlsByTaskKey 是按 workspace-aware taskKey 索引的进程级缓存，
// 本函数只读写不清理，task 销毁由外层 dispose 统一回收。
// 纯函数性质：除上述缓存外无副作用，重复投递同一 payload 结果一致（INV-12 的前提）。
function mapSessionInfoLikePayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  eventId: string | undefined,
  payload: Record<string, unknown>,
  backgroundTaskControlsByTaskKey?: Map<string, ZCodeBackgroundTaskControlItem[]>,
  cacheKey = taskId,
): ZCodeStreamEvent[] {
  // 用可变数组累积后一次性返回：调用方按数组顺序同步广播，避免边算边发导致顺序抖动。
  const events: ZCodeStreamEvent[] = [];
  // event.taskId 是对外 session id；内部 cache 必须沿用 workspace-aware taskKey，
  // 否则 replayable snapshot seed 和后续 live update 会分裂成两份 background job 状态。
  // [权衡] 不在这里重新计算 key：调用方传入的 cacheKey 已包含 workspace 维度，
  // 若用 event.taskId 重建，同一 session 的本地与远程 attachment 会各存一份后台任务。
  const backgroundTaskControlCacheKey = cacheKey;
  const tokenUsageDelta = taskTokenUsageDeltaFromPayload(
    taskId,
    traceId,
    inputId,
    eventId,
    payload,
  );
  // 各项独立判空后逐个 push：payload 可能只带其中一两种信息，
  // 用一次大对象过滤会把“缺字段”和“值为空”混为一谈。
  if (tokenUsageDelta) {
    events.push(tokenUsageDelta);
  }
  // 网络诊断与 token/context 分属不同消费者：它只驱动调试面板，
  // 即使 payload 缺字段也不会影响会话主状态。
  const networkDebugStatus = zcodeTaskNetworkDebugStatusFromPayload({
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(eventId ? { eventId } : {}),
    payload,
  });
  if (networkDebugStatus) {
    events.push(networkDebugStatus);
  }
  // context 用量单独抽取：它可能来自 usage（模型返回）或 projection（runtime 估算），
  // 优先级在 contextUsageFromPayload 内部统一处理，这里不重复判断。
  const contextUsage = contextUsageFromPayload(payload);
  // context 与 token delta 是两条独立通道：前者驱动上下文 meter，后者驱动累计计费，
  // 任意一方缺失都不应阻塞另一方下发。
  if (contextUsage) {
    events.push({
      type: "usage_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      used: contextUsage.used,
      size: contextUsage.size,
      cost: contextUsage.cost ?? null,
      ...(contextUsage.cache ? { cache: contextUsage.cache } : {}),
      ...(contextUsage.breakdown ? { breakdown: contextUsage.breakdown } : {}),
    });
  }
  const title = stringValue(payload.title);
  // 标题是可选字段，空串视为没改：投空标题会让会话列表退化成“未命名”。
  if (title) {
    events.push({
      type: "session_info_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      title,
    });
  }
  // apiRetry 的三态语义必须保留：undefined=本次未提及，null=明确清除，对象=重试中。
  // 这里只在 !== undefined 时投事件，否则会把“没提”误当成“重试已结束”。
  const apiRetry = apiRetryFromSessionInfoPayload(payload);
  if (apiRetry !== undefined) {
    events.push({
      type: "session_info_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      apiRetry,
    });
  }
  // target 变更只在同时带 action/source 时才投影：
  // 单纯携带 target 字段的其它事件不应驱动进度条刷新。
  if ("target" in payload && ("action" in payload || "source" in payload)) {
    events.push({
      type: "session_info_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      target: {
        action: stringValue(payload.action) === "cleared" ? "cleared" : "set",
        source: stringValue(payload.source) === "tool" ? "tool" : "runtime",
        target: payload.target ? fromZCodeGoal(payload.target as never) : null,
        previousTarget: payload.previousTarget
          ? fromZCodeGoal(payload.previousTarget as never)
          : undefined,
      },
    });
  }
  // projection 快照与顶层 payload 可能同时携带后台任务信息，两者都要处理（见下）。
  const projection = asRecord(payload.projection);
  // projection.backgroundJobs 是权威全量快照：直接覆盖缓存并整表下发，
  // 与后面的单条增量合并区分开，避免 replay 时旧增量盖住新全量。
  if (Array.isArray(projection.backgroundJobs)) {
    const jobs = parseZCodeBackgroundTaskControlItems(projection.backgroundJobs);
    setTaskBackgroundTaskControlCache(
      backgroundTaskControlsByTaskKey,
      backgroundTaskControlCacheKey,
      jobs,
    );
    events.push({
      type: "background_bash_jobs_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      jobs,
    });
  }
  // 单条 job 增量与全量快照可能同帧到达：先全量覆盖、再增量合并；
  // 顺序反过来会让新增 job 被前一条快照抹掉。
  const backgroundJobUpdate = updateTaskBackgroundTaskControlCacheFromPayload(
    backgroundTaskControlsByTaskKey,
    backgroundTaskControlCacheKey,
    payload,
  );
  // 只有解析/合并出结果才投事件：payload 不含后台任务时静默跳过，
  // 防止每次 session.updated 都刷新一遍后台任务面板。
  if (backgroundJobUpdate) {
    events.push({
      type: "background_bash_jobs_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      jobs: backgroundJobUpdate,
    });
  }
  return events;
}

// 职责：从 model_complete payload 抽一次 token 增量。
// 输出：eventKey 为去重键——有 protocol eventId 时直接用它，
// 否则用 trace/input/query 与三个 token 数拼指纹，保证前后台两个 monitor 只记一次账。
// [失败路径] 没有 usage 或 totalTokens<=0 时返回 null，不投零值事件污染累计曲线。
function taskTokenUsageDeltaFromPayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  eventId: string | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "task_token_usage_delta" }> | null {
  if (!isModelCompleteUsagePayload(payload)) {
    return null;
  }
  const usage = usageFromPayload(payload.usage);
  // 0 token 的完成事件（例如纯本地短路）不记账：否则累计曲线会出现平段并触发无意义刷新。
  if (!usage || usage.totalTokens <= 0) {
    return null;
  }
  // 指纹只由稳定字段组成，不含时间戳：同一事件从不同通道到达时必须得到同一个键。
  const querySource = stringValue(payload.querySource);
  const queryId = stringValue(payload.queryId);
  // 累计 Token 要跟随每次模型完成实时更新，而不是等 task_complete 的整轮汇总；
  // eventId 是 protocol 流的稳定单事件标识，用它去重可避免前后台 monitor 重复记账。
  // [权衡] 无 eventId 时的指纹包含 trace/input/query 与三个 token 数：
  // 足以区分不同请求，又不引入时间信息，重复投递可稳定去重。
  const eventKey =
    eventId ??
    `${traceId}:${inputId ?? "no-input"}:${queryId ?? "no-query"}:${querySource ?? "unknown"}:${usage.inputTokens}:` +
      `${usage.outputTokens}:${usage.totalTokens}`;
  return {
    type: "task_token_usage_delta",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(queryId ? { queryId } : {}),
    eventKey,
    ...(eventId ? { eventId } : {}),
    ...(querySource ? { querySource } : {}),
    usage,
  };
}

// 判据不是“有 usage”就够：工具执行、压缩等内部步骤也会带 usage，
// 只有同时出现 stopReason / contextWindow / querySource 之一才视为一次模型调用完成。
function isModelCompleteUsagePayload(payload: Record<string, unknown>): boolean {
  if (!("usage" in payload)) {
    return false;
  }
  return (
    // 三个标记任选其一：不同 provider/协议版本的 model_complete 载荷字段并不一致，
    // 用“或”保证都能识别，同时仍能排除只带 usage 的内部步骤。
    stringValue(payload.stopReason) !== undefined ||
    "contextWindow" in payload ||
    stringValue(payload.querySource) !== undefined
  );
}

// 职责：从 session.updated 的多个可能位置提取 API retry 状态。
// 返回值三态：对象=重试中，null=明确结束，undefined=本次未提及（不要覆盖 UI 现有状态）。
// [权衡] 多级回退（payload → runtime → _meta.zcode → streamRecovery/modelNetwork）
// 是为兼容协议演进与新老 CLI；每一级都必须先区分“字段不存在”与“字段为 null”，
// 否则重试徽标会在下一次无关 session.updated 时被误清除（对应 INV-09 的口径）。
function apiRetryFromSessionInfoPayload(
  payload: Record<string, unknown>,
): ZCodeApiRetryStatus | null | undefined {
  // 用 in 判断而不是值判断：显式 null 表示“重试已结束”，必须原样返回给 UI 清除徽标。
  if ("apiRetry" in payload) {
    return normalizeZCodeApiRetryStatus(payload.apiRetry);
  }

  const runtimeRetry = normalizeZCodeApiRetryStatus(asRecord(payload.runtime).apiRetry);
  // 只有明确的 null/对象才返回；undefined 继续向下回退，避免上层字段“存在但为空”时提前终止。
  if (runtimeRetry !== undefined) {
    return runtimeRetry;
  }

  const metaRetry = normalizeZCodeApiRetryStatus(asRecord(asRecord(payload._meta).zcode).apiRetry);
  if (metaRetry !== undefined) {
    return metaRetry;
  }

  return (
    // 最后两级是流恢复/网络状态推导：断线重连后没有显式 retry 字段，只能从恢复事件反推。
    zcodeApiRetryFromStreamRecoveryPayload(payload) ??
    zcodeApiRetryFromModelNetworkStatusPayload(payload)
  );
}

// 职责：把模型请求完成/失败事件转成旁路网络遥测上报。
// [失败路径] 整段 try/catch：遥测 sink 可能因网络或序列化抛错，
// 但它是旁路指标，绝不能中断主会话消息流；失败只记 warn。
function recordAgentModelNetworkTelemetry(event: ZCodeSessionEvent): void {
  // 先转换再判断：不是模型网络事件时得到 null，直接返回，不触发任何上报逻辑。
  const observation = agentModelNetworkObservationFromEvent(event);
  if (!observation) {
    return;
  }
  try {
    emitNetworkTelemetryObservation(observation);
  } catch (error) {
    // 修复原因：agent 模型网络遥测属于旁路指标，sink 异常不能影响主会话消息流。
    logger.warn(undefined, "上报 agent 模型网络遥测失败", error);
  }
}

// 职责：把 model_request_completed/failed 事件压成一条网络观测。
// [失败路径] 只识别这两个 type，其余返回 null——网络遥测只关心模型请求这一层，
// 工具/进程事件混进来会污染时延与成功率口径。
function agentModelNetworkObservationFromEvent(
  event: ZCodeSessionEvent,
): NetworkObservation | null {
  const payload = asRecord(event.payload);
  const type = stringValue(payload.type);
  if (type !== "model_request_completed" && type !== "model_request_failed") {
    return null;
  }
  // 修复原因：retryable failed 只是同一次逻辑请求的中间 attempt，最终 completed/failed 会带总 attempt。
  // 如果这里也计数，会把成功率、失败率和重试率同时放大。
  if (type === "model_request_failed" && booleanValue(payload.retryable) === true) {
    return null;
  }

  // 时长做非负取整：负数/NaN 来自时钟回拨或字段缺失，直接透传会污染分位数统计。
  const durationMs = Math.max(0, Math.round(numberValue(payload.durationMs) ?? 0));
  // 状态码只接受非负整数：字符串 "502" 或浮点会被丢弃，
  // 保证 errorKind 的 5xx/4xx 判定不会因类型漂移落到 other。
  const statusCode = nonNegativeIntegerValue(payload.statusCode);
  const ok = type === "model_request_completed";
  return {
    transport: "http",
    interface: buildAgentModelNetworkInterface(payload),
    durationMs,
    ok,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(ok ? {} : { errorKind: classifyAgentModelNetworkError(payload, statusCode) }),
    // attempt 缺省按 1 计：没有重试信息的旧事件至少能贡献一条首次尝试样本。
    attempt: positiveIntegerValue(payload.attempt) ?? 1,
  };
}

// 拼出有界的指标维度串：providerKind.transport.host+path。
// [权衡] 用 host+path 而不是完整 URL：去掉 scheme/query 避免把签名参数、
// 一次性 token 写进指标标签，同时把基数限制在服务端可控范围内。
function buildAgentModelNetworkInterface(payload: Record<string, unknown>): string {
  const providerKind = safeNetworkDimension(stringValue(payload.providerKind)) ?? "unknown";
  const transport = safeNetworkDimension(stringValue(payload.transport)) ?? "unknown";
  const base = normalizeAgentModelBaseUrl(stringValue(payload.baseURL));
  return `zcode_agent.model.${providerKind}.${transport}.${base}`;
}

// 从 baseURL 中只保留 host 与截断后的 path：
// [资源] path 超过 80 字符即截断，防止用户自定义的长路径让指标标签基数爆炸；
// 解析失败时按普通字符串消毒后截到 120，绝不把原样 URL 写进标签。
function normalizeAgentModelBaseUrl(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }
  try {
    const parsed = new URL(value);
    // 去掉尾部斜杠并保留根路径：否则 host 与 host/ 会生成两个不同维度。
    const pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    const safePath = pathname.length > 80 ? `${pathname.slice(0, 80)}...` : pathname;
    // 只保留 host+path：scheme 在这种指标里没有信息量，query/hash 可能含凭据。
    return `${parsed.host}${safePath}`;
  } catch {
    return safeNetworkDimension(value, 120) ?? "unknown";
  }
}

// 把任意字符串压成安全标签值：空白与分隔符替换成下划线，超长截断。
// [权衡] 不删除字符而是替换，是为了保持可读性与相邻维度可区分；
// 截断保留前缀，避免不同值截断后几乎相同却仍被当成两个维度。
function safeNetworkDimension(value: string | undefined, maxLength = 48): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  // 替换的字符集覆盖 URL 分隔符、引号、尖括号与空白：它们会破坏指标标签的转义与解析。
  const safe = trimmed.replace(/[?#[\]{}|\\^`"'<>\s]+/gu, "_");
  return safe.length > maxLength ? `${safe.slice(0, maxLength)}...` : safe;
}

// 职责：把失败原因归入稳定桶（timeout/connection_reset/proxy_error/tls_error/
// server_error/client_error/other），供指标聚合。
// [权衡] 先按 reason 码匹配、再按 HTTP 状态码兜底：reason 是语义最准确的来源；
// 两者都没有就归 other，绝不解析 message 文本。
function classifyAgentModelNetworkError(
  payload: Record<string, unknown>,
  statusCode: number | undefined,
): string {
  const reason = stringValue(payload.reason);
  switch (reason) {
    case "timeout":
    case "stream_idle_timeout":
      return "timeout";
    case "network_error":
    case "stale_connection":
      return "connection_reset";
    case "proxy_error":
      return "proxy_error";
    case "tls_error":
      return "tls_error";
    default:
      // 只在没有明确 reason 时才看状态码：proxy_error 也可能带 502，
      // 若先按 5xx 归类会丢失代理这一根因。
      if (statusCode !== undefined && statusCode >= 500) {
        return "server_error";
      }
      if (statusCode !== undefined && statusCode >= 400) {
        return "client_error";
      }
      return "other";
  }
}

// 从 usage_update 事件里挑出可复用的字段子集：
// 避免为投影中间值再声明一份与协议平行的类型，字段口径只在一处定义。
type ContextUsageUpdate = Pick<
  Extract<ZCodeStreamEvent, { type: "usage_update" }>,
  "used" | "size" | "cost" | "cache" | "breakdown"
>;

// 从 snapshot.projection 取 context 用量；contextWindow 或 contextUsed <=0 时返回 null。
// [权衡] 0 不是“上下文为空”，而是“尚无数据/尚未估算”，
// 渲染成 0% 会让用户以为上下文被清空（对应 INV-09 的“没有字段”与“值未写入”之分）。
function contextUsageFromProjection(
  projection: ZCodeSessionStateSnapshot["projection"],
): ContextUsageUpdate | null {
  if (projection.contextWindow <= 0 || projection.contextUsed <= 0) {
    return null;
  }
  return {
    used: projection.contextUsed,
    size: projection.contextWindow,
    cost: null,
  };
}

// 从 runtime.contextUsage（持久化的 assistant token 记录）恢复 context 用量。
// session resume 时 projection 可能还没重放主轮次 usage，runtime 是更可靠的旧任务事实源；
// 缺 cost 时显式给 null（协议字段）而不是省略，保持 usage_update 形状稳定。
function contextUsageFromRuntime(
  runtimeUsage: ZCodeSessionStateSnapshot["runtime"]["contextUsage"] | undefined,
): ContextUsageUpdate | null {
  if (!runtimeUsage || runtimeUsage.size <= 0 || runtimeUsage.used <= 0) {
    return null;
  }
  // session resume 时 protocol projection 可能还没重放主轮次 usage。
  // runtime.contextUsage 来自持久化 assistant token 记录，应优先用于恢复旧 task UI。
  return {
    used: runtimeUsage.used,
    size: runtimeUsage.size,
    cost: runtimeUsage.cost ?? null,
    ...(runtimeUsage.cache ? { cache: runtimeUsage.cache } : {}),
    ...(runtimeUsage.breakdown ? { breakdown: runtimeUsage.breakdown } : {}),
  };
}

// 职责：从 session.updated payload 同时读 usage 与 projection，决定 context meter 的 used/size。
// 优先级：主轮次模型 usage > projection.contextUsed；sidecar 请求的 usage 一律不用。
// [失败路径] size 缺失/<=0 或 used 缺失/<=0 时返回 null：宁可不投事件，
// 也不要用 0 覆盖 UI 上已有的有效 meter。
function contextUsageFromPayload(payload: Record<string, unknown>): ContextUsageUpdate | null {
  const projection = asRecord(payload.projection);
  const usage = asRecord(payload.usage);
  // size 与 used 同源读取顶层 payload、缺失再取 projection：session.updated 两种形态都存在。
  const size = numberValue(payload.contextWindow ?? projection.contextWindow);
  const explicitUsed = numberValue(payload.contextUsed ?? projection.contextUsed);
  // 是否采用模型 usage 只看 querySource：标题、压缩、prompt enhance 等 sidecar
  // 也带 token，但它们不代表当前可见上下文，采用后会把小请求的用量写进 meter。
  const useModelUsageForContext = shouldUseModelUsageForContext(payload);
  // sidecar 请求把 modelUsageUsed 置为 undefined，后面的 ?? 才会回落到 projection 值。
  const modelUsageUsed = useModelUsageForContext ? contextUsageTokensFromPayload(usage) : undefined;
  const used =
    modelUsageUsed ??
    // 主轮次模型返回 usage 时必须以真实网络 token 统计为准；
    // context window 是 input + output 共享窗口，不能再只用 inputTokens 渲染 meter。
    // projection.contextUsed 是 runtime 估算/恢复事实源，只在缺少 usage 时兜底。
    explicitUsed;
  if (size === undefined || size <= 0) {
    return null;
  }
  // ZCode Protocol 的 session.updated 里 contextUsed/contextWindow 是 projection 事实源；
  // 旧 task stream 只认识 usage_update，adapter 不转换就会让右下角 context meter 永远拿不到数据。
  // used=0 只表示初始化或异常兜底，不能渲染成可用的 context meter。
  // used=0 只出现在初始化或异常兜底：投出去会让 UI 把 meter 画成 0%，
  // 比保持上一次有效值更容易误导用户。
  if (used === undefined || used <= 0) {
    return null;
  }
  return {
    used,
    size,
    cost: null,
    ...(useModelUsageForContext ? optionalContextCacheUsageFromPayload(payload, usage) : {}),
    ...(useModelUsageForContext ? optionalContextUsageBreakdownFromPayload(payload) : {}),
  };
}

// breakdown 走 zcodeContextUsageBreakdownSchema 运行时校验：
// [失败路径] 校验失败或空数组时返回 {}，用条件展开保留字段缺失语义，
// 而不是把非法数据透给 UI 让渲染层各自兜底。
function optionalContextUsageBreakdownFromPayload(
  payload: Record<string, unknown>,
): Pick<ContextUsageUpdate, "breakdown"> {
  const parsed = zcodeContextUsageBreakdownSchema.safeParse(payload.contextUsageBreakdown);
  return parsed.success && parsed.data.length > 0 ? { breakdown: parsed.data } : {};
}

// 计算“当前上下文 token”的口径：input + output，而不是叠加 cache 部分。
// [权衡] AI SDK v6 已把 Anthropic cache read/write 并入 inputTokens，
// 这里再加 cacheReadTokens 会把输入侧重复计入，meter 显示偏大。
// 退化顺序：input+output → totalTokens → (cacheRead+cacheWrite)+output。
function contextUsageTokensFromPayload(usage: Record<string, unknown>): number | undefined {
  const inputTokens = positiveIntegerValue(usage.inputTokens ?? usage.input);
  if (inputTokens !== undefined) {
    // AI SDK v6 已把 Anthropic cache read/write 并入 inputTokens。
    // adapter 只需要加 output；再加 cacheReadTokens 会把输入栏 context meter 算大。
    return inputTokens + (nonNegativeIntegerValue(usage.outputTokens ?? usage.output) ?? 0);
  }

  // 没有 inputTokens 时才用 total：total 通常已含 output，
  // 不能再与 output 相加，否则上下文被算成两倍。
  const totalTokens = positiveIntegerValue(usage.totalTokens ?? usage.total);
  if (totalTokens !== undefined) {
    return totalTokens;
  }

  const cacheTokens =
    (nonNegativeIntegerValue(usage.cachedReadTokens ?? usage.cacheReadTokens) ?? 0) +
    (nonNegativeIntegerValue(usage.cachedWriteTokens ?? usage.cacheWriteTokens) ?? 0);
  // 最后的兜底：provider 只报 cache 字段时，用 cache 读写 + output 近似上下文规模；
  // 全都没有就返回 undefined，让上层退回 projection 估算。
  return cacheTokens > 0
    ? cacheTokens + (nonNegativeIntegerValue(usage.outputTokens ?? usage.output) ?? 0)
    : undefined;
}

// cache 字段同样用条件展开：没有缓存信息时不产生 cache 键，
// 避免 UI 把“无数据”渲染成 0 命中率。
function optionalContextCacheUsageFromPayload(
  payload: Record<string, unknown>,
  usage: Record<string, unknown>,
): Pick<ContextUsageUpdate, "cache"> {
  const cache = contextCacheUsageFromPayload(payload, usage);
  return cache ? { cache } : {};
}

// 只有主会话轮次（querySource 缺省或 main_turn）的 inputTokens 才代表当前可见上下文。
// [权衡] 缺省视为 main_turn：旧协议不带 querySource，若一律拒绝会丢失 meter 更新。
function shouldUseModelUsageForContext(payload: Record<string, unknown>): boolean {
  const querySource = stringValue(payload.querySource);
  // 只有主会话模型请求的 inputTokens 才代表当前可见上下文。
  // 标题、压缩、prompt enhance 等 sidecar 请求即使带 contextWindow，也不能覆盖输入栏 context meter。
  return querySource === undefined || querySource === "main_turn";
}

// 职责：产出 usage_update.cache 的缓存指标。
// 两条来源：payload.cacheHit 是 runtime 聚合的权威累计值（优先），
// usage 里的单次 cache 字段是退化来源。
// [权衡] aggregate 命中时完全不看 usage：混用累计与单次会让命中率在两次更新间跳变。
// 返回 undefined 表示“没有任何缓存信息”，由调用方条件展开成字段缺失。
function contextCacheUsageFromPayload(
  payload: Record<string, unknown>,
  usage: Record<string, unknown>,
): ContextUsageUpdate["cache"] {
  const aggregate = asRecord(payload.cacheHit);
  // 空对象视为没有 aggregate：asRecord 对非对象也给 {}，用键数区分“无数据”与“全零”。
  if (Object.keys(aggregate).length > 0) {
    // aggregate 的 input/cache 字段缺失按 0 补齐：键已存在即代表 runtime 已开始聚合。
    const inputTokens = nonNegativeIntegerValue(aggregate.inputTokens) ?? 0;
    const cacheReadTokens = nonNegativeIntegerValue(aggregate.cacheReadTokens) ?? 0;
    const cacheWriteTokens = nonNegativeIntegerValue(aggregate.cacheWriteTokens) ?? 0;
    // latestHitRate 是最近一次请求的命中率，hitRate 是窗口累计命中率：
    // 两者语义不同，不能互相回退，否则 UI 的“当前”和“平均”会显示同一个数。
    const latestHitRate = numberValue(aggregate.latestHitRate);
    const hitRate = numberValue(aggregate.hitRate);
    const hitRateRequestCount = nonNegativeIntegerValue(aggregate.hitRateRequestCount);
    const totalInputTokens = nonNegativeIntegerValue(aggregate.totalInputTokens);
    const totalCacheReadTokens = nonNegativeIntegerValue(aggregate.totalCacheReadTokens);
    const totalCacheWriteTokens = nonNegativeIntegerValue(aggregate.totalCacheWriteTokens);
    return {
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(latestHitRate !== undefined ? { latestHitRate: Math.max(0, latestHitRate) } : {}),
      ...(hitRateRequestCount !== undefined ? { hitRateRequestCount } : {}),
      ...(totalInputTokens !== undefined ? { totalInputTokens } : {}),
      ...(totalCacheReadTokens !== undefined ? { totalCacheReadTokens } : {}),
      ...(totalCacheWriteTokens !== undefined ? { totalCacheWriteTokens } : {}),
      // hitRate 缺失时给 null 而不是 0：null 表示无数据，0 表示真实零命中，UI 展示不同。
      hitRate: hitRate !== undefined ? Math.max(0, hitRate) : null,
    };
  }

  // 必须先判字段是否存在再取值：显式 0 是有效数据（表示本次无缓存命中），
  // 若用真值判断会把它当成“没有缓存信息”。
  const hasCacheRead = "cachedReadTokens" in usage || "cacheReadTokens" in usage;
  const hasCacheWrite = "cachedWriteTokens" in usage || "cacheWriteTokens" in usage;
  const hasHitRate = "cacheHitRate" in usage || "hitRate" in usage;
  if (!hasCacheRead && !hasCacheWrite && !hasHitRate) {
    return undefined;
  }
  // 退化路径下 latestHitRate 与 hitRate 取同一个值：这里没有历史窗口，
  // 单次请求的命中率就是当前命中率；两个字段交由不同 UI 组件消费。
  const inputTokens = nonNegativeIntegerValue(usage.inputTokens ?? usage.input) ?? 0;
  const cacheReadTokens =
    // cache 字段缺失按 0 计：只有确认存在缓存字段才会进入该分支，0 在这里是有效值。
    nonNegativeIntegerValue(usage.cachedReadTokens ?? usage.cacheReadTokens) ?? 0;
  const cacheWriteTokens =
    nonNegativeIntegerValue(usage.cachedWriteTokens ?? usage.cacheWriteTokens) ?? 0;
  // 优先级 cacheHitRate > hitRate：前者是 provider 语义字段，后者是兼容别名。
  const explicitHitRate = numberValue(usage.cacheHitRate ?? usage.hitRate);
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    latestHitRate:
      explicitHitRate !== undefined
        ? Math.max(0, explicitHitRate)
        : inputTokens > 0
          ? cacheReadTokens / inputTokens
          : null,
    // UI 展示的是 agent/app 协议返回的命中率；provider 没直接给时，
    // 在 adapter 侧按 provider usage 归一化一次，避免各 UI 入口重复理解 token 字段。
    hitRate:
      explicitHitRate !== undefined
        ? Math.max(0, explicitHitRate)
        : inputTokens > 0
          ? cacheReadTokens / inputTokens
          : null,
  };
}

// 职责：把任意 provider usage 归一成 ZCodeUsage。
// 空对象（无任何 usage 字段）返回 undefined，让调用方区分“没有用量”与“用量为 0”。
// [权衡] inputTokens 为 0 时用 cache 读写之和替代输入侧：
// 部分 provider 只报 cache 明细，不报总 input，否则 total 会少算缓存部分。
function usageFromPayload(value: unknown): ZCodeUsage | undefined {
  const usage = asRecord(value);
  if (Object.keys(usage).length === 0) {
    return undefined;
  }
  const inputTokens = numberValue(usage.inputTokens ?? usage.input) ?? 0;
  const outputTokens = numberValue(usage.outputTokens ?? usage.output) ?? 0;
  const reasoningTokens = numberValue(usage.reasoningTokens ?? usage.reasoning);
  const cachedInputTokens = numberValue(usage.cachedReadTokens ?? usage.cacheReadTokens);
  const cachedWriteInputTokens = numberValue(usage.cachedWriteTokens ?? usage.cacheWriteTokens);
  // 输入侧口径统一：优先总 input，缺失时用 cache 读写之和，避免 total 少算缓存。
  const inputSideTokens =
    inputTokens > 0 ? inputTokens : (cachedInputTokens ?? 0) + (cachedWriteInputTokens ?? 0);
  const totalTokens =
    // total 优先用 provider 自报值；缺失时用输入侧 + output 估算，
    // 保证 task_token_usage_delta 的累计值单调可加。
    numberValue(usage.totalTokens ?? usage.total) ?? inputSideTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cachedInputTokens,
    cachedWriteInputTokens,
  };
}

// 类型守卫式取值：null/非对象统一给 {}，调用方可无条件点访问。
// 返回原引用不拷贝，避免高频投影路径上产生额外分配；
// 数组也会通过 typeof "object" 判定，但调用方只读命名字段，不受影响。
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

// [权衡] 空字符串按“缺失”处理：协议里 "" 与字段缺失等价，
// 若返回 ""，后续 ?? 回退不会触发，UI 会渲染出空白标题或空白错误信息。
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// 工具名判据集中在此，避免各处手写字符串比较后出现拼写漂移。
function isAskUserQuestionToolName(value: string | undefined): boolean {
  return value === ASK_USER_QUESTION_TOOL_NAME;
}

// ExitPlanMode 的计划审批与普通权限共用 permission 通道，
// 只有工具名能把两者区分开。
function isExitPlanModeToolName(value: string | undefined): boolean {
  return value === EXIT_PLAN_MODE_TOOL_NAME;
}

// 这两个工具的结果是“表单答案”而不是“授权决定”，
// 投影成 elicitation_response 还是 permission_response 由此判定。
function isUserInputBackedPermissionToolName(value: string | undefined): boolean {
  return isAskUserQuestionToolName(value) || isExitPlanModeToolName(value);
}

// 只接受有限数：NaN/Infinity 会从 JSON、除法或缺失字段计算中产生，
// 透传后会让 meter 宽度、时长统计出现 NaN。
function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// token 计数/状态码等字段要求非负整数：小数或负数说明上游口径异常，
// 返回 undefined 让调用方走缺省分支，而不是把异常值带进 UI。
function nonNegativeIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

// 用于“必须是正数才有意义”的字段（上下文档位、attempt）：
// 0 在这里表示未设置，与 nonNegativeIntegerValue 的语义区别必须保持。
function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

// 只认真正的布尔值：协议里出现 "true" 字符串时视为缺失，
// 避免把字符串当条件导致分支走向与协议意图不一致。
function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

// 白名单校验 timeline 状态：未知取值返回 undefined，让调用方保留上一条投影，
// 而不是把未识别状态硬投给 UI（新状态必须显式加到这里才生效）。
function timelineStatusValue(value: unknown): ZCodeTimelineStatus | undefined {
  return value === "started" ||
    value === "retrying" ||
    value === "skipped" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted"
    ? value
    : undefined;
}

// 触发原因同样白名单化：它决定分隔条文案（手动/自动/响应式…），
// 未知值不能猜成 manual，否则会把自动压缩显示成用户操作。
function timelineTriggerValue(value: unknown): ZCodeTimelineTrigger | undefined {
  return value === "manual" ||
    value === "auto" ||
    value === "reactive" ||
    value === "partial" ||
    value === "session_memory"
    ? value
    : undefined;
}

// 过滤非字符串项：协议数组里可能混入 null 或对象，
// 直接透传会让下游 join/渲染抛错；空数组是合法结果。
function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// steer 来源只允许两个已知值：它决定 UI 的反馈归属，
// 未知来源返回 undefined 由调用方回落到默认展示。
function turnSteerSourceValue(value: unknown): ZCodeTurnSteerSource | undefined {
  return value === "plan_approval_feedback" || value === "workflow_refine_feedback"
    ? value
    : undefined;
}

// 命令种类白名单：sendGoalCommand/sendText/compact 对应不同气泡样式，
// 未知值不猜，避免把压缩命令渲染成普通消息。
function turnSteerCommandKindValue(value: unknown): ZCodeTurnSteerCommandKind | undefined {
  return value === "sendGoalCommand" || value === "sendText" || value === "compact"
    ? value
    : undefined;
}
