import {
  isAuxiliarySessionKind,
  isReadonlyAgentSessionKind,
  OFF_PEAK_EXECUTION_TOOL_DENYLIST,
} from "@zcode/shared";
/* eslint-disable max-lines -- ZCode Protocol 的 session/workspace 方法共享同一个 server context 与 snapshot helpers，迁移期先集中维护。 */
import { observeSessionDebug } from "./session-debug.js";
import {
  TASK_LIST_SESSION_TYPES,
  isTaskListSessionType,
} from "../zcode-protocol-v4/task-list-session-membership.js";
import { resolveEffectiveBashShellSelection } from "@zcode/adapters/exec";
import { inputIntentMetadata } from "../zcode-protocol-v4/commands/input-intent.js";
import { createModelExecutionContext } from "./model-execution.js";
import type { SendInputOptions } from "../app/types.js";
import { repairPersistedRemoteSessionPaths, type TurnAttachment } from "@zcode/core";
import {
  CoreErrorType,
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  createMessageId,
  createPartId,
  createSessionId,
  createCoreError,
  parseRewindTriggeredPayload,
  RewindScope,
  RewindStrategy,
  type EventId,
  type ExecutionShellSelection,
  type MessageWithParts,
  type ModelSelection,
  type MessageId,
  type ModelId,
  type ModelProviderId,
  type QueryId,
  type SessionEvent,
  SessionEventType,
  type SessionId,
  type SessionInfo,
  type SessionTaskType,
  type CollaborationMode,
  type TargetCompletionVerificationPayload,
  type TraceId,
  type TurnBackgroundAttribution,
  type TurnId,
  type UsageStorePort,
  type WorkspaceId,
} from "@zcode/contracts";
import {
  subagentRuntimeConfigSchema,
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
  zcodeProtocolErrorCodes,
  zcodeProtocolMethods,
  zcodeSessionCancelBackgroundTaskParamsSchema,
  zcodeSessionCompactParamsSchema,
  zcodeSessionCloseParamsSchema,
  zcodeSessionCreateParamsSchema,
  zcodeSessionEventsParamsSchema,
  zcodeSessionForkParamsSchema,
  zcodeSessionGoalParamsSchema,
  zcodeSessionListParamsSchema,
  zcodeSessionMessagesParamsSchema,
  zcodeSessionReadParamsSchema,
  elideSessionSnapshotForIndex,
  zcodeSessionRuntimePreferencesResultSchema,
  zcodeSessionResumeParamsSchema,
  zcodeSessionSendParamsSchema,
  zcodeSessionSetModeParamsSchema,
  zcodeSessionSetModelParamsSchema,
  zcodeSessionSetThoughtLevelParamsSchema,
  zcodeSessionStopParamsSchema,
  zcodeSessionSubscribeParamsSchema,
  zcodeSessionSubagentsParamsSchema,
  zcodeTaskTokenUsageParamsSchema,
  zcodeUsageStatsParamsSchema,
  zcodeWorkspaceGenerateTextParamsSchema,
  getConversationMessageProjectionPolicy,
  isRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  type AppToolSearchMode,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeSessionCreateParams,
  type ZCodeDeliveryKind,
  type IntegratedTerminalShellSelection,
  type ZCodeSessionRuntimePreferencesScope,
  type ZCodeSessionRuntimePreferencesResult,
  type ZCodeModelContextBudgetStrategy,
  type ZCodeProtocolTrace,
  type ZCodeSessionEvent,
  type ZCodeSessionHistoryTarget,
  type ZCodeSessionResumeParams,
  type ZCodeSessionPersistence,
  type ZCodeWorkspaceRef,
  type ZCodeStateUpdatedNotification,
} from "@zcode/shared";
import {
  buildSessionSnapshot,
  buildWorkspaceRef,
  formatProtocolModelSelection,
  mapSessionEventForProtocol,
  mapSessionInfo,
  resolveSessionContextUsage,
  shouldExposeSessionEventToProtocol,
} from "./mapper.js";
import { optionalModelSelectionFromString } from "./model-mapper.js";
import {
  ProtocolRequestError,
  assertExpectedRevision,
  createProtocolLogger,
  createProtocolRootTraceContext,
  protocolTraceFromTraceContext,
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
  type ZCodeProtocolToolInputTransmissionState,
} from "./server-types.js";
import { createWorkspaceZCodeApp, ensureSessionModelAvailable } from "./workspace-model-runtime.js";
import { buildAppUsageSnapshot, resolveTzOffsetMs } from "./usage-stats-builder.js";
import { createProtocolInteractionBroker } from "./interaction-broker.js";
import { createProtocolAutomationPort } from "./automation-port.js";
import { createProtocolOffPeakPort } from "./offpeak-port.js";
import { createProtocolTopicResourcePort } from "./topic-resource-port.js";
import { createProtocolBrowserControlBroker } from "./browser-control-broker.js";
import { mapComputerUseOperationEvent } from "./computer-use-operation-event.js";
import { protocolMcpServersToRuntimeMcpConfig } from "./protocol-mcp-config.js";
import { projectIdFromDirectory } from "../app/paths.js";
import {
  collectSubagentChildSessionIds,
  paginateEndedSubagents,
  projectSessionSubagents,
} from "./subagent-session-query.js";
import { runSessionModelConfigMutation } from "../zcode-protocol-v4/model-config-mutation.js";
import { runWithSessionResidencyFinalization } from "./session-residency.js";
import { resolveDynamicWorkflowRuntimeGate } from "./dynamic-workflow-policy.js";
import { abortMcpUiToolCallsForSession, clearMcpUiAppToolsForSession } from "./mcp-ui/index.js";

// ============================================================================
// ZCode Protocol server operations —— session / workspace / goal / usage 的协议实现层
// ============================================================================
// 定位：把 JSON-RPC 方法参数解析成强类型入参，驱动 App/runtime，再把结果投影成协议
// 快照或 session 事件。本文件不拥有业务事实：durable 事实在 SessionStore / eventStore，
// 运行态事实在 App/runtime，本文件只维护"协议侧镜像"（ZCodeProtocolSessionRecord）。
// 任何新增字段都必须能回答：它是 runtime 事实的镜像，还是本文件自己造的第二份真相。
//
// INV 不变量表（编号在本文件内唯一；跨文件的 20 条契约见阅读大纲 12.4）
// INV-01：同一 sessionId 任意时刻最多对应一份 runtime record。创建期必须在任何
//         await 之前占用 context.sessionCreationIds，再落库，最后进 context.sessions。
//         （守住它的位置：createSessionWithProjection）
// INV-02：创建失败必须把 record 从 context.sessions 摘除，并 close + disposeSession +
//         deleteSession(eventStore)，否则后续 workspace 请求会读到半初始化 app。
//         （守住它的位置：materializeCreatedSession 的 catch 分支）
// INV-03：resume 失败只允许释放"本次"的 record：discardFailedSessionResume 先比对
//         context.sessions.get(sessionId) === record，防止并发重试误删新 record。
// INV-04：resume 前必须 waitForDeactivation 等容量去激活收尾完成，禁止新旧 app 对
//         同一 session 的 sqlite 与工作区交错读写。（activateSessionForResume）
// INV-05：resume 不得沿用 createRecord 写死的 now()，必须回填 store 的
//         time.created / time.updated，否则 sessions-index 会把老任务当"刚创建"。
// INV-06：resume 必须带 taskType。缺省 interactive 会让 workflow_child /
//         subagent_child 通过 isTaskListSessionType，污染任务列表并触发反复 resume。
// INV-07：workspaceIdentity 管身份隔离、workspacePath 管执行；resume 只拿目录重建
//         workspace 会把 identity 退化成 path key，provider registry 随之命中失败。
// INV-08：协议 seq 必须按"协议可见事件流"重新连续编号；eventStore.sequenceNumber 是
//         内部全量账本（含被过滤的高频 delta），直接暴露会让客户端 replay 断档。
//         （守住它的位置：mapProtocolSessionEvent / assignProtocolEventSeq）
// INV-09：seq 分配按 (deliveryKind, sourceEventKey) 幂等：同一事件重复读取必须得到
//         同一个 seq，否则客户端 resume 时会重复或丢帧。
// INV-10：streaming delta 的合并边界必须可由事件自身推导（字节预算 + 事件 timestamp），
//         禁止用 setTimeout 之类墙钟，否则 replay 复现不出相同分帧。
// INV-11：tool_input_delta 必须带 toolCallId 才能进入批处理；缺失说明上游没有按
//         tool_call 生命周期投递，合并会把不同调用的参数粘在一起。
// INV-12：同一 toolCall 的 input 若已在 model.streaming 交付，随后的 ToolCallScheduled
//         必须剥离 input 并标记 inputOmitted/inputRef，避免 stdio 与 renderer 双倍放大。
// INV-13：session_title 的模型事件（model_request / model_network_status / model_complete）
//         不得透给协议：标题重试会吞掉主请求的 retry 计数，UI 状态随之失真。
// INV-14：session/send 的准入顺序固定为 子代理只读 → revision → active turn →
//         restoreWarning → 模型可用；调换顺序会让只读会话或旧 revision 先产生副作用。
// INV-15：record.activeAbortController 是该 session"是否存在活跃 turn"的唯一判据；
//         释放必须早于任何 ready/终态广播，否则客户端 drain 会被自己的 409 拒绝。
// INV-16：后台 turn 的 Promise 必须自吞错误（.catch），否则协议进程出现 unhandled
//         rejection 而不是一条可读的失败事件。
// INV-17：/goal 除 pause 外都要求无活跃 turn；pause 是唯一允许打断当前 turn 的控制动作。
// INV-18：fork 只复制消息是不够的：必须显式继承父会话 mode/model/thoughtLevel，
//         否则新 record 会从 workspace 默认值恢复，用户看到的选型被悄悄改掉。
// INV-19：fork 的 goal 继承只做 cloneTargetForFork，不新建 targetId，否则 verifier
//         timeline 与 copied transcript 的关联断开。
// INV-20：activeAutomationId / activeOffPeakTaskId / activeBotDeliveryTarget 是"本轮
//         归属"标记，turn 结束必须恢复上一轮的值——record 会跨 turn 复用。
// INV-21：automation 轮必须从 provider 工具面移除 CronCreate；offpeak 轮移除
//         OFF_PEAK_EXECUTION_TOOL_DENYLIST；远程 workspace 在 session 初始化即禁用
//         REMOTE_AUTOMATION_TOOL_NAMES。只靠 prompt 文本约束挡不住模型直接调用。
// INV-22：session/stop 必须同时把 active goal 置 paused，否则 verifier 会在
//         stopRequested 下保持 active，队列永远无法 drain。
// INV-23：record.persistence 是 runtime"会话已持久化"事实的镜像，只允许
//         deferred → immediate 单向推进；条件关闭按它做原子判断（INV-27）。
// INV-24：closeSession 只释放运行态与订阅，绝不删除持久化行，sessions-index 仍要可见。
// INV-25：纯配置事件与配置类 mutation 不 bump record.updatedAt：它是 sessions-index 的
//         lastActivityAt，切模型/点开任务不应把历史任务顶到列表最前。
// INV-26：detached child 事件必须按事件自身的 sessionId 路由（ingestDetachedLiveSession），
//         用父 record id ingest 会让 child topic 停更并错误 bump 父任务活动时间。
// INV-27：v4 ingest 无条件执行，legacy session/event 发送受 record.deliveryKind 门控；
//         两者不可互换，否则旧订阅退出后诊断与 v4 投影会一起断流。
// INV-28：snapshot 的 eventSeq 必须与 readEvents 使用同一 deliveryKind，否则快照的
//         lastSeq 与后续增量流不属于同一序列空间。
// INV-29：导入历史的时间戳必须单调递增：sessionStore 按 time_created 排序读取，
//         否则 UI 会把 assistant 显示在 user 之上。
// INV-30：导入消息清理只删 migrationSource 匹配的行，保留用户在导入会话里继续聊出的
//         真实消息；清理范围按当前 session 收敛，不跨会话删。
// INV-31：usage / token 读面在没有 store 时返回零值结构而不是抛错，让 UI 走空态。
// INV-32：snapshot 的 target / todos / goalVerification 读取失败必须降级为空值并留
//         warn 日志，不能让首屏恢复整体失败。
// INV-33：rewind 投影优先使用 runtime 保存的 keptMessageIDs；账本里的 target 前缀在
//         连续 rewind 后已不等于 active branch 前缀。
// INV-34：rewind 的 command ACK 消息必须从投影中过滤，它只是控制命令回执。
// INV-35：protocolEventSequences / protocolToolInputTransmissions 按 deliveryKind 分表；
//         desktop-continuous 与 web-remote-replayable 各有独立的序列空间。
// ============================================================================
const PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE = "Plan mode 下已记录 goal，但不会自动继续。";
// [权衡] 1s 是"用户已感知卡顿"和"日志噪声"的分界：低阈值会在冷启动时刷屏，高阈值
// 会让真正退化的 snapshot（例如大 transcript 全量投影）永远不出现在日志里。
// 这里只做观测，不触发超时降级——降级会让客户端拿到不完整快照而无法自愈。
const SLOW_SNAPSHOT_LOG_THRESHOLD_MS = 1000;
// [失败路径] 远程 workspace 的定时任务没有本地 scheduler 可依赖，Cron 工具必须从
// 工具面整体摘除。只在 prompt 里劝阻无效：模型会把 "CronCreate" 当作可用能力直接调，
// 调用必然失败并把一次本来正常的 turn 拖进错误重试。
const REMOTE_AUTOMATION_TOOL_NAMES = [
  "CronCreate",
  "CronList",
  "CronUpdate",
  "CronDelete",
] as const;

// [权衡] 目标结构直接取自 app.readTarget 的返回类型，而不是在协议层重新声明一份。
// 一旦 verifier 侧新增字段（例如阻塞原因、证据引用），协议层不改代码即可透出；
// 若在此处复制一份 interface，就会长期落后于 runtime，形成第二份真相。
type ProtocolGoalTarget = NonNullable<
  Awaited<ReturnType<NonNullable<ZCodeProtocolSessionRecord["app"]["readTarget"]>>>
>;

// [权衡] create/resume 共用同一个 record 初始化函数，因此 resume 入参必须声明
// 只属于 create 的字段（mode/model/parentSessionId/thoughtLevel/titleGenerationEnabled）。
// 若拆成两套入参，初始化函数就会被 if 分叉成两份，任何字段新增都要改两处。
// taskType 单独交叉进来：它不是客户端可传的协议字段，只由服务端内部调用方标注，
// 用来区分"用户会话"与"任务列表里的子会话"（见 INV-06）。
type ZCodeSessionRecordParams = (
  | ZCodeSessionCreateParams
  | (ZCodeSessionResumeParams & {
      mode?: ZCodeSessionCreateParams["mode"];
      model?: ZCodeSessionCreateParams["model"];
      parentSessionId?: ZCodeSessionCreateParams["parentSessionId"];
      thoughtLevel?: ZCodeSessionCreateParams["thoughtLevel"];
      // 自动化会话会在创建期关闭标题二次生成，而 create/resume
      // 共用 record 初始化函数；resume 兼容分支也必须声明该策略字段。
      titleGenerationEnabled?: ZCodeSessionCreateParams["titleGenerationEnabled"];
    })
) & { taskType?: SessionTaskType };

// [并发] 启动偏好是"会话创建那一刻"的一次性快照，不随后续设置变更热更新：
// app 在构造期读取这些开关并可能据此改变工具面，中途改动会造成同一会话前后轮次
// 的工具集不一致，模型行为不可解释。
interface SessionStartupPreferences {
  additionalDirectories?: readonly string[];
  subagentRuntimeConfigEnabled?: boolean;
  memoryEnabled: boolean;
  modelContextBudgetStrategy: ZCodeModelContextBudgetStrategy;
  nativeSearchEnhancementsEnabled: boolean;
  toolSearchMode: AppToolSearchMode;
  resolveInitialBashShellSelection: () => Promise<ExecutionShellSelection | undefined>;
}

// [资源] shell 选择必须延迟到异步探测完成后再给出，所以这里存的是 resolver 而不是
// 解析好的值。若在接口里放同步值，创建路径就被迫在构造 app 之前 await，拉长创建
// 关键路径；而探测本身可能访问文件系统（PATH 扫描）。
// [权衡] inherit 变体让 fork/subagent 复用父 record 的偏好来源，避免重新读一次全局
// 设置导致父子会话在同一时刻拿到不同配置。
type SessionStartupPreferencesSource =
  | { kind: "host" }
  | { kind: "inherit"; parent: ZCodeProtocolSessionRecord };

// [失败路径] 客户端传来的 thoughtLevel 可能是旧版本枚举值（跨版本恢复的会话）。
// 不在这里过滤，app 会在下次请求时抛出"不支持的推理强度"，把一次正常恢复变成 500。
// [权衡] 静默降到 undefined 而不是报错：undefined 表示"跟随模型默认"，是安全回落；
// 报错则会让旧客户端永远打不开自己的历史会话。
function resolveSupportedAppThoughtLevel(
  app: Pick<ZCodeProtocolSessionRecord["app"], "listThoughtLevels">,
  thoughtLevel: string | undefined,
): string | undefined {
  const normalizedThoughtLevel = thoughtLevel?.trim();
  if (!normalizedThoughtLevel) {
    return undefined;
  }
  const supportedLevels = app.listThoughtLevels();
  return supportedLevels.includes(normalizedThoughtLevel) ? normalizedThoughtLevel : undefined;
}

// [权衡] 两组预算差 4 倍不是随手选的：tool_input 每个 delta 都是一段 JSON 片段，
// 切得太碎会让客户端反复尝试 JSON.parse 半截字符串；text_delta 则是给人看的，
// 250ms 的节流才能把"逐字跳动"压成接近自然打字。
// [失败路径] 这两个上限同时是"单帧最大体积"的兜底：没有字节上限时，粘性很差的
// 模型会连续吐 10 万字符单帧，一条 WebSocket 消息就足以顶爆客户端的内存预算。
const DEFAULT_PROTOCOL_EVENT_SEQUENCE_KEY = "__default__";
const PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_CHARS = 4 * 1024;
const PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_INTERVAL_MS = 750;
const PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_CHARS = 2 * 1024;
const PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_INTERVAL_MS = 250;

// [事务] 三元素闭合枚举而不是 boolean 标记：新增第四种流式产物（例如附件增量）时
// 编译器会强制所有 switch 补分支，不会悄悄落进某个默认通道。
type ProtocolStreamingDeltaKind = "reasoning_delta" | "text_delta" | "tool_input_delta";

// [权衡] BatchInfo 是一次"判定"的不可变结果（能不能合、合完多大、是否立刻冲刷），
// Batch 才是"正在攒"的可变容器。分开是因为判定必须可重放：replay 时用同样的事件
// 序列重新跑一遍判定，必须得到同样的分帧，不能受当时内存里攒了多少影响。
interface ProtocolStreamingDeltaBatchInfo {
  batchKey: string;
  delta: string;
  kind: ProtocolStreamingDeltaKind;
  maxChars: number;
  shouldFlushFirstDelta: boolean;
  timestampMs: number;
}

interface ProtocolStreamingDeltaBatch {
  batchKey: string;
  delta: string;
  event: SessionEvent;
  kind: ProtocolStreamingDeltaKind;
  maxChars: number;
  startedAtMs: number;
  updatedAtMs: number;
}

// [资源] 用 WeakMap 以 record 为键：会话关闭后整张表随之被 GC 回收，不需要任何
// 显式清理钩子。若改成挂在 record 上的普通字段，record 与 batch 互相引用，只能靠
// 人工 close 时记得置空，漏一处就是长跑进程的稳定内存泄漏。
// [权衡] 值里再按 batchKey 分层：一个 turn 内可能并行多个 tool_input 通道
// （并行工具调用），各自独立计时，不能共用 lastFlushAt。
interface LiveProtocolStreamingDeltaBatch {
  batch?: ProtocolStreamingDeltaBatch;
  flushedFirstDeltaBatchKeys: Set<string>;
  lastFlushAtByBatchKey: Map<string, number>;
}

const liveProtocolStreamingDeltaBatches = new WeakMap<
  ZCodeProtocolSessionRecord,
  Map<string, LiveProtocolStreamingDeltaBatch>
>();

// [并发] 序列空间按 deliveryKind 分表：web-remote-replayable 只允许重放可持久事件，
// desktop-continuous 则包含瞬态的 delta。二者若共用一个 seq 计数器，客户端从
// desktop 掉线切到 web 时会看到 lastSeq 跳变，触发全量重新拉取。
// [权衡] 用固定字符串 "__default__" 兜底 undefined，而不是抛错：老调用点在
// 迁移期可能不传 deliveryKind，此时退化成单序列仍比直接 500 可用。
function protocolEventSequenceKey(deliveryKind?: ZCodeDeliveryKind): string {
  return deliveryKind ?? DEFAULT_PROTOCOL_EVENT_SEQUENCE_KEY;
}

// [事务] 读-建-写必须同步完成（中间无 await）：两个并发事件若都走到"不存在则创建"，
// 后者会覆盖前者刚分配的 seqBySourceEventKey，导致已发出的 seq 被重新分配。
// 这是本函数不做异步、也不返回 Promise 的根本原因。
function getProtocolEventSequenceState(
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
) {
  const key = protocolEventSequenceKey(deliveryKind);
  const existing = record.protocolEventSequences.get(key);
  if (existing) {
    return existing;
  }
  const created = {
    lastSeq: 0,
    seqBySourceEventKey: new Map<string, number>(),
  };
  record.protocolEventSequences.set(key, created);
  return created;
}

// [权衡] "已流式交付过 input"的判定必须按 deliveryKind 隔离：desktop 通道确实逐帧
// 送过 tool_input_delta，web 重放通道可能只消费最终事件，二者对"是否重复"的答案不同。
// 共用一个集合会让后连接的客户端整段拿不到 input（被误判为已交付）。
function getProtocolToolInputTransmissionState(
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): ZCodeProtocolToolInputTransmissionState {
  const key = protocolEventSequenceKey(deliveryKind);
  const existing = record.protocolToolInputTransmissions.get(key);
  if (existing) {
    return existing;
  }
  const created: ZCodeProtocolToolInputTransmissionState = {
    streamedToolCallIdsWithInput: new Set(),
  };
  record.protocolToolInputTransmissions.set(key, created);
  return created;
}

// [事务] 幂等键优先用 eventStore 的 sequenceNumber：它由数据库单调分配，跨进程、
// 跨连接稳定；只有在内存事件（sequenceNumber 为 0，尚未落库）时才退回到 event.id。
// [失败路径] 若反过来优先用 id，同一事件在"落库前后"会得到不同键，客户端会看到
// 同一条 assistant 消息出现两次。
function protocolSourceEventKey(event: SessionEvent): string {
  return event.sequenceNumber > 0 ? `seq:${event.sequenceNumber}` : `event:${String(event.id)}`;
}

// [事务] 分配是"先查后写"的同步临界区：lastSeq 递增与键表写入之间不允许 await，
// 否则同一事件被并发投影两次时，两次都会查不到并各分配一个 seq。
// [权衡] 保留 seqBySourceEventKey 而不只存 lastSeq，是拿内存换幂等：没有这张表，
// snapshot 与 readEvents 各自投影同一事件时序号必然错位，客户端 resume 会重复渲染。
function assignProtocolEventSeq(
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
): number {
  const state = getProtocolEventSequenceState(record, deliveryKind);
  const sourceEventKey = protocolSourceEventKey(event);
  const existing = state.seqBySourceEventKey.get(sourceEventKey);
  if (existing !== undefined) {
    return existing;
  }
  const nextSeq = state.lastSeq + 1;
  state.lastSeq = nextSeq;
  state.seqBySourceEventKey.set(sourceEventKey, nextSeq);
  return nextSeq;
}

// [失败路径] payload 来自持久化 JSON 或跨进程消息，类型不可信。这三个取值函数是
// 所有 payload 读取的唯一收口处：任何一处直接 `payload.x as string` 都会把脏数据
// 带进业务分支，最终在客户端表现为"字段是 undefined 但没报错"。
// [权衡] 返回 undefined 而不是抛错：单条事件字段坏了只该让该事件降级，不该让
// 整个 session 的事件流中断。
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// [并发] 与事件序列同样的两层结构，但这里是"运行时批处理状态"，不参与 replay：
// 它记录的是"这一秒里已经发过什么"，因此绝不能写进持久化 record。
// [权衡] flushedFirstDeltaBatchKeys 单独存在的原因：每个 batchKey 的首个 delta 需要
// 立刻冲刷（否则用户会看到空白停顿），后续 delta 才进节流窗口。用一个 Set 记住
// "首帧已发"，避免把首帧判定写成额外的状态机。
function getLiveProtocolStreamingDeltaBatchState(
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): LiveProtocolStreamingDeltaBatch {
  let byDeliveryKind = liveProtocolStreamingDeltaBatches.get(record);
  if (!byDeliveryKind) {
    byDeliveryKind = new Map();
    liveProtocolStreamingDeltaBatches.set(record, byDeliveryKind);
  }
  const key = protocolEventSequenceKey(deliveryKind);
  const existing = byDeliveryKind.get(key);
  if (existing) {
    return existing;
  }
  const created: LiveProtocolStreamingDeltaBatch = {
    flushedFirstDeltaBatchKeys: new Set(),
    lastFlushAtByBatchKey: new Map(),
  };
  byDeliveryKind.set(key, created);
  return created;
}

// [事务] batchKey 必须包含所有"内容归属"维度：kind 区分通道，assistantMessageId /
// inputId / partId 区分同一条消息内的多个内容块，parentToolUseId / toolCallId 区分
// 嵌套工具调用。
// [失败路径] 少拼任何一维都会把两个语义上无关的 delta 合并成一帧：例如并行工具
// 调用只按 toolCallId 拼接、漏掉 parentToolUseId，子代理的参数就会粘到主代理上。
// 用空串占位而不是省略字段，保证不同维度的组合不会因为分隔符错位而碰撞。
function buildProtocolStreamingDeltaBatchKey(params: {
  assistantMessageId?: string;
  inputId?: string;
  kind: ProtocolStreamingDeltaKind;
  partId?: string;
  parentToolUseId?: string;
  toolCallId?: string;
}): string {
  return [
    params.kind,
    params.assistantMessageId ?? "",
    params.inputId ?? "",
    params.partId ?? "",
    params.parentToolUseId ?? "",
    params.toolCallId ?? "",
  ].join(":");
}

// [失败路径] parentToolUseId 有四种来源：MCP/旧版 SDK 放顶层，Claude Code 兼容层放
// _meta 下，ZCode 自己的封装放 _meta.zcode。少识别一种，子代理内的流式事件就会被
// 归到主代理的 batchKey 上，表现为"子代理的参数长在主对话框里"。
// [权衡] 按"直接字段 → _meta → _meta.zcode → _meta.claudeCode"的优先级短路返回，
// 而不是合并多来源：同一事件出现两个不同的 parent 说明上游有 bug，取第一个稳定值
// 比拼接更可预测。
function readProtocolStreamingParentToolUseId(
  payload: Record<string, unknown>,
): string | undefined {
  const direct = stringValue(payload.parentToolUseId) ?? stringValue(payload.parentToolCallId);
  if (direct) {
    return direct;
  }
  const meta = asRecord(payload._meta);
  const zcode = asRecord(meta.zcode);
  const claudeCode = asRecord(meta.claudeCode);
  return (
    stringValue(meta.parentToolUseId) ??
    stringValue(meta.parentToolCallId) ??
    stringValue(zcode.parentToolUseId) ??
    stringValue(zcode.parentToolCallId) ??
    stringValue(claudeCode.parentToolUseId) ??
    stringValue(claudeCode.parentToolCallId)
  );
}

// [并发] 只用事件自带 timestamp，绝不读 Date.now()：批处理窗口的半衰点必须能在
// replay 时用同一条事件序列重算出来，墙钟会让两次重放的出包位置不同。
// [失败路径] 非法 Date 返回 0 而不是 NaN：NaN 参与比较恒为 false，会让该 batch
// 永远不按时间冲刷，卡到 4KB 才出包；0 至少保持单调可比较。
function timestampMsForProtocolEvent(event: SessionEvent): number {
  const timestampMs = event.timestamp.getTime();
  return Number.isFinite(timestampMs) ? timestampMs : 0;
}

// [权衡] 这个函数是"可批处理"的唯一判定点：类型、kind、非空 delta、toolCallId
// 四道门槛都在这里，下游 merge/flush 才敢假设字段齐全。
// [失败路径] tool_input_delta 缺 toolCallId 直接丢弃，而不是退化成 text_delta 发送：
// 客户端收到无主的工具参数片段会建出一个假的 toolCall，比丢帧更难排查。
// [事务] shouldFlushFirstDelta 三个分支都返回 true 目前等价于恒真，但保留三元写法是
// 为了给"首帧必须立即出包"的语义留下显式锚点——将来若有通道需要攒首帧（例如
// 需要与服务端序号对齐的重放通道），改动点只在这里。
function readStreamingDeltaBatchableEvent(
  event: SessionEvent,
): ProtocolStreamingDeltaBatchInfo | null {
  if (event.type !== SessionEventType.ModelStreaming) {
    return null;
  }
  const payload = asRecord(event.payload);
  const kind = stringValue(payload.kind) as ProtocolStreamingDeltaKind | undefined;
  if (kind !== "tool_input_delta" && kind !== "text_delta" && kind !== "reasoning_delta") {
    return null;
  }
  const delta = stringValue(payload.delta);
  if (!delta) {
    return null;
  }
  const assistantMessageId = stringValue(payload.assistantMessageId);
  const inputId = stringValue(payload.inputId);
  const partId = stringValue(payload.partId);
  const parentToolUseId = readProtocolStreamingParentToolUseId(payload);
  const toolCallId = stringValue(payload.toolCallId);
  if (kind === "tool_input_delta" && !toolCallId) {
    return null;
  }
  return {
    batchKey: buildProtocolStreamingDeltaBatchKey({
      assistantMessageId,
      inputId,
      kind,
      partId,
      parentToolUseId,
      toolCallId,
    }),
    delta,
    kind,
    maxChars:
      kind === "tool_input_delta"
        ? PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_CHARS
        : PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_CHARS,
    shouldFlushFirstDelta:
      kind === "text_delta" || kind === "reasoning_delta" || kind === "tool_input_delta",
    timestampMs: timestampMsForProtocolEvent(event),
  };
}

// [事务] 合并的语义是"把 n 条 delta 折叠成 1 条，但保留最后一条事件的元信息"：
// event 取最新的，这样 toolCallId/assistantMessageId 等归属字段与 delta 尾部一致；
// startedAtMs 取最早，用于时间窗口判定；updatedAtMs 取最新，用于节流比较。
// [失败路径] batchKey 不同时直接丢弃旧 batch 而不是先冲刷：调用方在切换批次前
// 必须已 flush 旧批次，这里再兜一次只是防止串味，静默丢弃意味着上游漏了 flush。
function mergeProtocolStreamingDeltaBatch(
  batch: ProtocolStreamingDeltaBatch | undefined,
  event: SessionEvent,
  deltaInfo: ProtocolStreamingDeltaBatchInfo,
): ProtocolStreamingDeltaBatch {
  if (!batch || batch.batchKey !== deltaInfo.batchKey) {
    return {
      batchKey: deltaInfo.batchKey,
      delta: deltaInfo.delta,
      event,
      kind: deltaInfo.kind,
      maxChars: deltaInfo.maxChars,
      startedAtMs: deltaInfo.timestampMs,
      updatedAtMs: deltaInfo.timestampMs,
    };
  }
  return {
    batchKey: deltaInfo.batchKey,
    delta: `${batch.delta}${deltaInfo.delta}`,
    event,
    kind: deltaInfo.kind,
    maxChars: deltaInfo.maxChars,
    startedAtMs: batch.startedAtMs,
    updatedAtMs: deltaInfo.timestampMs,
  };
}

// [事务] 只替换 payload.delta，其余字段整体沿用"最后一条事件"：这是把 n 条流式
// 事件压成 1 条的唯一合法方式。
// [权衡] 用浅展开而不是深拷贝 payload：payload 是刚从 JSON 反序列化出来的对象，
// 不与 runtime 共享引用，浅展开已足够且避免了大对象复制的开销。
function materializeProtocolStreamingDeltaBatch(batch: ProtocolStreamingDeltaBatch): SessionEvent {
  const payload = asRecord(batch.event.payload);
  return {
    ...batch.event,
    payload: {
      ...payload,
      delta: batch.delta,
    },
  };
}

// [并发] 记录的是"上一次出包用的 batch.updatedAtMs"而不是当前墙钟：只有用事件自身
// 时间，下一次的间隔判定才与 replay 一致。
// [失败路径] 若这里写 Date.now()，同一段事件流在实时与重放时的冲刷点会不同，客户端
// 重连后看到的文本分块与首次渲染不一致，diff 视图会抖动。
function rememberProtocolStreamingDeltaBatchFlush(
  lastFlushAtByBatchKey: Map<string, number>,
  batch: ProtocolStreamingDeltaBatch,
): void {
  lastFlushAtByBatchKey.set(batch.batchKey, batch.updatedAtMs);
}

// [权衡] 首次（没有 lastFlushAt）返回 false，把"首帧是否立即发"的决定权交回给
// shouldFlushFirstDelta：两处若都返回 true 会产生重复出包。
// [失败路径] 间隔判定用 >= 而不是 >：恰好等于窗口时若不发，只能等下一个 delta，
// 在低产出速率的工具（如长 Write）上会额外多积一整帧的延迟。
function shouldFlushProtocolStreamingDeltaBatchForInterval(
  batch: ProtocolStreamingDeltaBatch,
  lastFlushAtByBatchKey: Map<string, number>,
): boolean {
  const lastFlushAt = lastFlushAtByBatchKey.get(batch.batchKey);
  if (lastFlushAt === undefined) {
    return false;
  }
  // active 任务的流式 function call 不能只按 4KB 字节预算出包。
  // 单行 JSON 参数会在 protocol 边界长时间滞留，表现为工具卡参数不再流式更新。
  const maxIntervalMs =
    batch.kind === "tool_input_delta"
      ? PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_INTERVAL_MS
      : PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_INTERVAL_MS;
  return batch.updatedAtMs - lastFlushAt >= maxIntervalMs;
}

// [事务] 只登记"已完整交付 input 的 tool_call 事件"，而不是所有 model.streaming：
// 部分厂商会先发 kind=tool_call 的增量再补全，若把不含 input 的帧也登记，后面的
// scheduled 就会被误删 input，工具拿到空参数直接失败。
// [失败路径] 缺 toolCallId 时静默跳过：没有 id 就无法把 scheduled 与 stream 对上，
// 此时宁可重复发送也不能误删。
function markStreamedToolInputIfPresent(
  mappedEvent: ZCodeSessionEvent,
  toolInputTransmissions: ZCodeProtocolToolInputTransmissionState,
): void {
  if (mappedEvent.type !== "model.streaming") {
    return;
  }
  const payload = asRecord(mappedEvent.payload);
  if (payload.kind !== "tool_call" || !("input" in payload)) {
    return;
  }
  const toolCallId = stringValue(payload.toolCallId);
  if (!toolCallId) {
    return;
  }
  toolInputTransmissions.streamedToolCallIdsWithInput.add(toolCallId);
}

// [事务] 这个函数在每个事件投影时都会被调用，顺序敏感：必须先 mark 再判断，
// 这样同一次投影里"先到的 streaming"能给"后到的 scheduled"提供去重依据。
// [权衡] 只处理 kind=scheduled 且仍带 input 的 tool.updated：started/result 阶段
// 的 input 是客户端回填的展示信息，删掉会让工具卡片永远展开成空。
// [并发] 去重判定按 (session, deliveryKind) 的独立集合，见
// getProtocolToolInputTransmissionState——同一 toolCall 在不同通道的结论可以不同。
// [权衡] 删除 input 但补上 inputByteLength / inputOmitted / inputRef 三个字段，
// 是为了让客户端知道"参数确实存在，只是走流式通道传过了"，从而复用已渲染的
// toolCall，而不是当成空参数重绘。三个字段缺一不可：只有 inputOmitted 时客户端
// 无法预估高度，只有 inputByteLength 时无法区分"空对象"与"省略"。
// [失败路径] 不做深拷贝 input，直接 delete 新对象上的字段：旧 payload 仍被
// mappedEvent 的浅拷贝持有，若就地修改会污染调用方持有的原事件（replay 会二次丢字段）。
function omitDuplicateScheduledToolInput(
  event: SessionEvent,
  mappedEvent: ZCodeSessionEvent,
  toolInputTransmissions: ZCodeProtocolToolInputTransmissionState,
): ZCodeSessionEvent {
  markStreamedToolInputIfPresent(mappedEvent, toolInputTransmissions);
  if (event.type !== SessionEventType.ToolCallScheduled || mappedEvent.type !== "tool.updated") {
    return mappedEvent;
  }
  const payload = asRecord(mappedEvent.payload);
  if (payload.kind !== "scheduled" || !("input" in payload)) {
    return mappedEvent;
  }
  const toolCallId = stringValue(payload.toolCallId);
  if (!toolCallId || !toolInputTransmissions.streamedToolCallIdsWithInput.has(toolCallId)) {
    return mappedEvent;
  }

  const nextPayload: Record<string, unknown> = { ...payload };
  const input = nextPayload.input;
  delete nextPayload.input;
  nextPayload.inputByteLength = measureJsonBytes(input);
  nextPayload.inputOmitted = true;
  nextPayload.inputRef = "model_stream";
  // 性能修复：AI SDK 的 tool_call 已经在 model.streaming 里交付完整 input；
  // scheduled 只是生命周期边界，重复携带 Write/Edit 大参数会让 stdio 和 renderer 双重放大。
  return {
    ...mappedEvent,
    payload: nextPayload,
  };
}

// [权衡] 空数组与 undefined 在这里被刻意区分：undefined 表示"这次请求没带附件"，
// 空数组表示"带了但全部非法被过滤"。runtime 对两者的处理相同，但保留 undefined
// 可以让 prompt 摘要与日志不显示一个误导性的 "[]"。
function mapProtocolPromptAttachments(
  attachments: unknown[] | undefined,
): TurnAttachment[] | undefined {
  const mapped = (attachments ?? [])
    .map(mapProtocolPromptAttachment)
    .filter((attachment): attachment is TurnAttachment => attachment !== undefined);
  return mapped.length > 0 ? mapped : undefined;
}

// [事务] 这是 renderer 传输格式 → core TurnAttachment 语义的唯一转换点。协议侧用
// kind/localPath/dataBase64，runtime 只认 type/path/content；转换放在边界而不是
// runtime 内部，是为了让 core 不依赖 GUI 协议版本（两个版本可以并行演进）。
// [权衡] 每个分支都优先走 localPath 零拷贝，只有 Web 端没有本地路径时才把
// dataBase64 拼成 data URL inline：把 10MB 视频塞进 JSON-RPC 会拖垮 stdio。
// [失败路径] 无路径且无内容时返回 undefined（被上层过滤），而不是抛错：一批附件里
// 坏一个不应该让整条 prompt 发不出去。
function mapProtocolPromptAttachment(attachment: unknown): TurnAttachment | undefined {
  const record = asRecord(attachment);
  const kind = stringValue(record.kind);
  const filename = stringValue(record.filename) ?? "attachment";
  const localPath = stringValue(record.localPath);
  const mimeType = stringValue(record.mimeType);
  const isPdf =
    kind === "pdf" || mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
  // GUI 协议附件使用 kind/localPath/dataBase64，而 core runtime 只认 type/path/content。
  // 这里在协议边界完成语义转换，避免把 renderer 的传输格式泄漏到 agent 内部。
  // 展示元信息（filename/mimeType/sizeBytes）在协议边界保真透传，
  // TurnStarted 事件与 v4 userInput row 的附件展示不再依赖 basename/扩展名推断。
  const displayMeta = {
    filename,
    ...(mimeType ? { mimeType } : {}),
    ...(typeof record.sizeBytes === "number" ? { sizeBytes: record.sizeBytes } : {}),
  };
  if (isPdf) {
    if (localPath) {
      return { path: localPath, type: "pdf", ...displayMeta };
    }
    const dataBase64 = stringValue(record.dataBase64);
    return dataBase64
      ? {
          content: `data:application/pdf;base64,${dataBase64}`,
          path: filename,
          type: "pdf",
          ...displayMeta,
        }
      : undefined;
  }
  if (kind === "image") {
    if (localPath) {
      return { path: localPath, type: "image", ...displayMeta };
    }
    const dataBase64 = stringValue(record.dataBase64);
    const mimeType = stringValue(record.mimeType) ?? "image/*";
    return dataBase64
      ? {
          content: `data:${mimeType};base64,${dataBase64}`,
          path: filename,
          type: "image",
          ...displayMeta,
        }
      : undefined;
  }

  // video：localPath 零拷贝（agent 侧读文件做大小校验）；Web 端 dataBase64 组 data URL inline。
  if (kind === "video") {
    if (localPath) {
      return { path: localPath, type: "video", ...displayMeta };
    }
    const dataBase64 = stringValue(record.dataBase64);
    const mimeType = stringValue(record.mimeType) ?? "video/mp4";
    return dataBase64
      ? {
          content: `data:${mimeType};base64,${dataBase64}`,
          path: filename,
          type: "video",
          ...displayMeta,
        }
      : undefined;
  }

  if (kind === "file" || kind === "audio") {
    if (localPath) {
      return {
        path: localPath,
        ...(kind === "file" &&
        (stringValue(record.sourceKind) === "clipboard-text" ||
          stringValue(record.sourceKind) === "topic-history")
          ? { sourceKind: stringValue(record.sourceKind) as "clipboard-text" | "topic-history" }
          : {}),
        type: "file",
        ...displayMeta,
      };
    }
    const textContent = stringValue(record.textContent);
    if (textContent !== undefined) {
      return {
        content: textContent,
        path: filename,
        type: "file",
        ...displayMeta,
      };
    }
    const decoded = decodeTextProtocolAttachment(record);
    return decoded !== undefined
      ? { content: decoded, path: filename, type: "file", ...displayMeta }
      : undefined;
  }

  return undefined;
}

// [权衡] 64KB 上限是"文本附件"的语义边界而不是内存边界：超过这个体积的 base64
// 多半是二进制文件被错误标成 text，解码成 UTF-8 会得到一屏乱码并污染 prompt。
// [失败路径] Buffer.from 对非法 base64 不抛错（会静默截断），因此这里只把 try 当作
// 对极端输入的兜底；真正的把关是上面的体积与调用方的 mimeType 判定。
function decodeTextProtocolAttachment(record: Record<string, unknown>): string | undefined {
  const dataBase64 = stringValue(record.dataBase64);
  if (!dataBase64) return undefined;
  const sizeBytes = numberValue(record.sizeBytes);
  if (sizeBytes !== undefined && sizeBytes > 64 * 1024) return undefined;
  try {
    return Buffer.from(dataBase64, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

// [并发] 三个分支都用 querySource === "session_title" 精确判定，而不是用一个
// "标题生成中"的全局布尔：标题请求与主请求并发时，全局标记会把主请求的
// model_network_status 一起吞掉，用户在输入框右下角看不到重试次数（注释 867 行）。
// [权衡] 只隐藏这三类事件而非整条标题流：标题文本本身要用于列表展示，隐藏过多会
// 让首屏标题一直停留在"新会话"。
function shouldHideProtocolSessionEvent(
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
): boolean {
  const payload = asRecord(event.payload);
  const querySource = stringValue(payload.querySource);
  if (event.type === "model_request" && querySource === "session_title") {
    return true;
  }
  if (event.type === "model_network_status" && querySource === "session_title") {
    // 不能用标题生成的全局 suppress 标记隐藏 model_network_status：
    // 标题请求重试时会把并发主请求的 retry 事件也吞掉，导致 app 输入框右下角看不到重试次数。
    // status 事件带 querySource，只隐藏标题生成自己的网络状态。
    return true;
  }
  if (event.type === "model_complete" && querySource === "session_title") {
    return true;
  }
  return false;
}

// [事务] 投影顺序不可交换：先隐藏（业务无关）→ 再按协议可见性过滤（高频中间态）
// → 再分配 seq → 再映射 → 最后做 tool input 去重。
// [失败路径] 若把 assignProtocolEventSeq 提到过滤之前，被过滤的事件会先吃掉一个
// seq，客户端 resume 时按 afterSeq 拉取就会永久缺号并触发全量重拉。
// [权衡] 过滤分支打 debug 日志而不是 trace：线上定位"某事件没到客户端"时，
// 唯一线索就是这条日志里的 eventType/payloadKind，级别太低会默认被裁掉。
function mapProtocolSessionEvent(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
  options: {
    toolInputTransmissions?: ZCodeProtocolToolInputTransmissionState;
  } = {},
): ZCodeSessionEvent | null {
  if (shouldHideProtocolSessionEvent(record, event)) {
    return null;
  }
  if (!shouldExposeSessionEventToProtocol(event)) {
    const payload = asRecord(event.payload);
    context.logger?.debug("ZCode Protocol session event filtered", {
      event: "zcode_protocol.session_event.filtered",
      eventId: String(event.id),
      module: "bootstrap.zcode_protocol",
      payloadKind: stringValue(payload.kind),
      sessionEventSequenceNumber: event.sequenceNumber,
      sessionEventType: event.type,
      sessionId: String(event.sessionId),
      turnId: event.turnId ? String(event.turnId) : undefined,
    });
    return null;
  }
  // eventStore 的 sequenceNumber 是内部全量账本，包含被协议过滤的
  // tool_input_delta 等高频模型中间态。ZCode Protocol 的 seq 是 UI/replay 的恢复键，
  // 必须按“协议实际可见事件流”重新连续编号，不能直接暴露内部 sequenceNumber。
  // sequenceNumber=0 的 subagent mirror/live-only 事件没有进入父 eventStore，也必须
  // 按 eventId 分配独立 seq，不能全部复用同一个 0 号映射。
  const protocolSeq = assignProtocolEventSeq(record, event, deliveryKind);
  const mappedEvent = mapSessionEventForProtocol(event, deliveryKind, {
    seq: protocolSeq,
  });
  if (!mappedEvent) {
    return null;
  }
  return omitDuplicateScheduledToolInput(
    event,
    mappedEvent,
    options.toolInputTransmissions ?? getProtocolToolInputTransmissionState(record, deliveryKind),
  );
}

// [事务] 这个函数是"事件重放"的核心：它把 eventStore 里的全量历史压成协议可见流。
// 三条不变量必须同时成立：seq 连续、delta 分帧可复现、before/after 过滤在压缩后仍
// 生效（afterSeq 比较的是压缩后的映射结果，所以压缩必须发生在过滤之前）。
// [并发] 所有批处理状态都是函数内局部变量：一次重放一个实例，绝不复用 record 上
// 的 live 状态，否则历史回放会被正在进行的实时流污染。
// [失败路径] 遇到被隐藏/不可见事件时先 reset（flush 挂起批次）再 push：不 reset 会把
// 跨越一个被过滤事件的两段 delta 合并，客户端看到的时间线里少了一个中断点。
async function readProtocolSessionEvents(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
  options: { afterSeq?: number; limit?: number } = {},
): Promise<ZCodeSessionEvent[]> {
  const events = await record.eventStore.getEvents(record.app.sessionId as SessionId);
  const visibleEvents: ZCodeSessionEvent[] = [];
  const toolInputTransmissions: ZCodeProtocolToolInputTransmissionState = {
    streamedToolCallIdsWithInput: new Set(),
  };
  let pendingStreamingDeltaBatch: ProtocolStreamingDeltaBatch | undefined;
  const flushedFirstDeltaBatchKeys = new Set<string>();
  const lastFlushAtByBatchKey = new Map<string, number>();
  const pushMappedEvent = (event: SessionEvent): void => {
    const mappedEvent = mapProtocolSessionEvent(context, record, event, deliveryKind, {
      toolInputTransmissions,
    });
    if (!mappedEvent) return;
    if (options.afterSeq !== undefined && mappedEvent.seq <= options.afterSeq) return;
    visibleEvents.push(mappedEvent);
  };
  const flushPendingStreamingDeltaBatch = (): void => {
    if (!pendingStreamingDeltaBatch) {
      return;
    }
    rememberProtocolStreamingDeltaBatchFlush(lastFlushAtByBatchKey, pendingStreamingDeltaBatch);
    pushMappedEvent(materializeProtocolStreamingDeltaBatch(pendingStreamingDeltaBatch));
    pendingStreamingDeltaBatch = undefined;
  };
  const resetPendingStreamingDeltaBatch = (): void => {
    flushPendingStreamingDeltaBatch();
    flushedFirstDeltaBatchKeys.clear();
    lastFlushAtByBatchKey.clear();
  };
  for (const event of events) {
    if (
      shouldHideProtocolSessionEvent(record, event) ||
      !shouldExposeSessionEventToProtocol(event)
    ) {
      resetPendingStreamingDeltaBatch();
      pushMappedEvent(event);
      continue;
    }
    const deltaInfo = readStreamingDeltaBatchableEvent(event);
    if (deltaInfo) {
      if (
        pendingStreamingDeltaBatch &&
        pendingStreamingDeltaBatch.batchKey !== deltaInfo.batchKey
      ) {
        flushPendingStreamingDeltaBatch();
      }
      pendingStreamingDeltaBatch = mergeProtocolStreamingDeltaBatch(
        pendingStreamingDeltaBatch,
        event,
        deltaInfo,
      );
      if (deltaInfo.shouldFlushFirstDelta && !flushedFirstDeltaBatchKeys.has(deltaInfo.batchKey)) {
        flushPendingStreamingDeltaBatch();
        flushedFirstDeltaBatchKeys.add(deltaInfo.batchKey);
        continue;
      }
      if (
        pendingStreamingDeltaBatch.delta.length >= pendingStreamingDeltaBatch.maxChars ||
        shouldFlushProtocolStreamingDeltaBatchForInterval(
          pendingStreamingDeltaBatch,
          lastFlushAtByBatchKey,
        )
      ) {
        flushPendingStreamingDeltaBatch();
      }
      continue;
    }
    resetPendingStreamingDeltaBatch();
    pushMappedEvent(event);
  }
  flushPendingStreamingDeltaBatch();
  return options.limit ? visibleEvents.slice(-options.limit) : visibleEvents;
}

// [事务] 先完整跑一遍投影再取 lastSeq，而不是维护一个独立计数器：只有投影过程
// 亲自分配过的 seq 才是"协议已暴露的序号"。独立计数器会在过滤规则变化后与实际
// 交付的序列脱节，快照携带的 eventSeq 就会大于客户端真正收到的最后一条。
async function getProtocolEventSeq(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): Promise<number> {
  await readProtocolSessionEvents(context, record, deliveryKind);
  return getProtocolEventSequenceState(record, deliveryKind).lastSeq;
}

// [权衡] 日志里存字节数和键名摘要，绝不存内容本体：一个 Write 工具的 input 可能有
// 数百 KB，整段落 debug 日志会把日志文件撑爆，也会把用户代码写进日志。
// 需要排查时用 protocolSeq + eventId 回查事件库，而不是回放日志文本。
// [失败路径] payloadSummary 的每个 copy* 都做类型判定后跳过，而不是抛错：日志路径
// 绝不能因为一条脏 payload 把正常的事件发送打断。
function logProtocolSessionEventSent(
  context: ZCodeProtocolAgentServerContext,
  sourceEvent: SessionEvent,
  mappedEvent: ZCodeSessionEvent,
): void {
  const payload =
    typeof mappedEvent.payload === "object" && mappedEvent.payload !== null
      ? (mappedEvent.payload as Record<string, unknown>)
      : {};
  const protocolMessage = {
    method: "session/event",
    params: mappedEvent,
  };
  context.logger?.debug("ZCode Protocol session event sent", {
    deliveryKind: mappedEvent.deliveryKind,
    event: "zcode_protocol.session_event.sent",
    eventId: mappedEvent.eventId,
    method: "session/event",
    module: "bootstrap.zcode_protocol",
    payloadKeys: Object.keys(payload).sort(),
    payloadKind: typeof payload.kind === "string" ? payload.kind : undefined,
    payloadSummary: summarizeProtocolPayload(payload),
    protocolMessageBytes: measureJsonBytes(protocolMessage),
    protocolPayloadBytes: measureJsonBytes(mappedEvent.payload),
    protocolEventType: mappedEvent.type,
    protocolSeq: mappedEvent.seq,
    sessionEventSequenceNumber: sourceEvent.sequenceNumber,
    sessionEventType: sourceEvent.type,
    sessionId: mappedEvent.sessionId,
    turnId: mappedEvent.turnId,
  });
}

// [权衡] 白名单式摘要而不是"过滤黑名单"：payload 字段只增不减，黑名单会让新加的
// 大字段（例如新工具的 output）自动漏进日志；白名单的代价是排查时字段少，但可控。
// [资源] 所有"列表/对象"类字段都只保留前 20 个键：并行的 200 个 toolCall 或超长
// 请求头会把一次 debug 日志放大成 MB 级，超出日志采样器能承受的量级。
function summarizeProtocolPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  copyStringFields(summary, payload, [
    "action",
    "anchorId",
    "assistantMessageId",
    "inputId",
    "kind",
    "queryId",
    "reason",
    "requestId",
    "resultPartId",
    "source",
    "status",
    "taskId",
    "terminalId",
    "toolCallId",
    "toolName",
  ]);
  copyBooleanFields(summary, payload, ["concurrentSafe", "destructive", "done", "readOnly"]);
  copyNumberFields(summary, payload, [
    "durationMs",
    "elapsedMs",
    "outputBytes",
    "stderrBytes",
    "stdoutBytes",
    "tokenCount",
    "toolCallCount",
  ]);
  copyByteLength(summary, payload, "content", "contentBytes");
  copyByteLength(summary, payload, "delta", "deltaBytes");
  copyByteLength(summary, payload, "input", "inputBytes");
  copyByteLength(summary, payload, "outputTail", "outputTailBytes");
  copyByteLength(summary, payload, "previousTarget", "previousTargetBytes");
  copyByteLength(summary, payload, "response", "responseBytes");
  copyByteLength(summary, payload, "result", "resultBytes");
  copyByteLength(summary, payload, "stderrTail", "stderrTailBytes");
  copyByteLength(summary, payload, "stdoutTail", "stdoutTailBytes");
  copyByteLength(summary, payload, "target", "targetBytes");
  copyObjectKeySummary(summary, payload, "input", "input");
  copyObjectKeySummary(summary, payload, "requestHeaders", "requestHeader");
  copyObjectKeySummary(summary, payload, "responseHeaders", "responseHeader");
  copyObjectKeySummary(summary, payload, "result", "result");
  copySmallObject(summary, payload, "usage");
  copyContextUsageBreakdownSummary(summary, payload);
  return summary;
}

// [权衡] 这一组 copy* 是 summarizeProtocolPayload 的字段白名单实现，彼此只差类型
// 判断，因此不复用泛型工具：泛型会把"运行时类型判定 + 跳过非法值"的语义藏进
// 类型体操，日志代码反而更难读。
// [失败路径] 每个函数都"取不到就跳过"而不是写 undefined：JSON 日志里出现
// `"x": undefined` 会被序列化成 null，与真实的 null 无法区分。
function copyStringFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      target[key] = value;
    }
  }
}

function copyBooleanFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") {
      target[key] = value;
    }
  }
}

function copyNumberFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      target[key] = value;
    }
  }
}

function copyByteLength(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
  targetKey: string,
): void {
  if (source[sourceKey] !== undefined) {
    target[targetKey] = measureJsonBytes(source[sourceKey]);
  }
}

function copyObjectKeySummary(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
  targetPrefix: string,
): void {
  const value = source[sourceKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const keys = Object.keys(value).sort();
  target[`${targetPrefix}KeyCount`] = keys.length;
  target[`${targetPrefix}Keys`] = keys.slice(0, 20);
}

function copySmallObject(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
): void {
  const value = source[sourceKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  if (measureJsonBytes(value) <= 1024) {
    target[sourceKey] = value;
  }
}

function copyContextUsageBreakdownSummary(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  const value = source.contextUsageBreakdown;
  if (!Array.isArray(value)) {
    return;
  }
  target.contextUsageBreakdownCount = value.length;
  target.contextUsageBreakdownSources = value
    .map((item) => asRecord(item).source)
    .filter((source): source is string => typeof source === "string")
    .slice(0, 20);
}

// [失败路径] stringify 在遇到循环引用或 BigInt 时抛错，返回 0 而不是让整个事件
// 投影失败：字节数只用于日志与 UI 估算，缺一个数值远好过丢一条事件。
// [权衡] 每个字符按 UTF-8 字节计而不是 length：中文与 emoji 在 length 上是 1，
// 在传输层是 3~4 字节，用 length 会系统性低估 2/3 的带宽。
function measureJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return 0;
  }
}

// [失败路径] slug 会写进 sessions-index 并作为 workspace 下的目录名，因此必须把
// 非 [a-z0-9._-] 一律折叠成 "-"：中文标题直接拼路径在 Windows 上可能撞保留名，
// 带 "/" 的标题会试图创建子目录。
// [权衡] 空结果回落成固定 "imported-session" 而不是报错：标题是展示信息，不值得
// 为它拒绝一次导入；后续同名的会话由 sessionId 区分，不靠 slug 去重。
function slugifyImportedSession(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return slug.length > 0 ? slug : "imported-session";
}

// [事务] 识别迁移消息用三种并行依据：ID 前缀（旧版本写入的固定模式）、消息级
// metadata.migrationSource、part 级 metadata.migrationSource。
// [失败路径] 只认 ID 前缀会漏掉新版（ID 已带 sessionId 前缀）；只认消息级 metadata
// 会漏掉历史上只给 part 打过标记的数据。三者取并集，才能覆盖跨版本累积的存量。
function isImportedHistoryMessage(
  message: MessageWithParts,
  source: NonNullable<ZCodeSessionCreateParams["importedHistory"]>["source"],
): boolean {
  const messageId = String(message.info.id);
  if (/^msg_import_\d+$/u.test(messageId) || messageId.startsWith("msg_claude-import-")) {
    return true;
  }
  const messageMetadata = asRecord((message.info as unknown as { metadata?: unknown }).metadata);
  if (messageMetadata.migrationSource === source) {
    return true;
  }
  return message.parts.some((part) => {
    const partMetadata = asRecord((part as unknown as { metadata?: unknown }).metadata);
    return partMetadata.migrationSource === source;
  });
}

// [事务] 清理是"按当前 sessionId 逐条 remove"，不是按前缀批量删：批量删需要先
// 枚举全库，跨会话误删的代价不可逆；逐条删天然被 sessionId 限定在本会话内。
// [失败路径] 返回删除条数并写日志：重导入后条数为 0 说明识别规则失效（旧版
// msg_import_N 已改名或 metadata 丢失），这是排查"会话串消息"的第一手证据。
async function removePreviousImportedSessionHistory(params: {
  sessionStore: NonNullable<ZCodeProtocolAgentServerContext["deps"]["sessionStore"]>;
  sessionId: SessionId;
  source: NonNullable<ZCodeSessionCreateParams["importedHistory"]>["source"];
}): Promise<number> {
  const existingMessages = await params.sessionStore.messages({
    sessionID: params.sessionId,
  });
  let removedCount = 0;
  for (const message of existingMessages) {
    if (!isImportedHistoryMessage(message, params.source)) {
      continue;
    }
    // 旧导入版本复用了 msg_import_0/msg_import_1 这类全局固定 ID。
    // 第二个导入 session 会通过 saveMessage 的 upsert 把前一个 session 的消息改绑过来，
    // 并保留旧 time_created，最终导致会话串消息、顺序反转或恢复为空。重导入前只清理
    // 当前 session 的迁移消息，保留用户后续在导入会话里继续聊出的真实消息。
    await params.sessionStore.removeMessage({
      sessionID: params.sessionId,
      messageID: message.info.id,
    });
    removedCount += 1;
  }
  return removedCount;
}

// [事务] 导入是"先建 session 行、再清旧迁移消息、再按数组顺序逐条写 message+part"，
// 三步不可重排：会话行不存在时 saveMessage 会创建孤儿；清理放在写之前才能让
// 旧固定 ID 的 upsert 不再改绑到别的会话（注释 1269 行）。
// [失败路径] 缺 sessionStore 直接抛 -32003 而不是静默跳过：导入半成功后客户端会
// 看到一个"有标题没内容"的会话，比明确失败更难排查。
// [权衡] 导入不要求模型可用（currentModel 可为空）：历史只是文本回放，绑定一个
// 用户当前没权限的模型会让打开会话时立刻报错。
// [事务] sharedContext 分支必须走 commitSharedContextImportBundle 的原子事务：
// 会话行 + context 消息 + provenance 三者要么全有要么全无，否则恢复时会出现
// "有 provenance 无消息"的悬挂记录。
async function persistImportedSessionHistory(params: {
  context: ZCodeProtocolAgentServerContext;
  record: ZCodeProtocolSessionRecord;
  sessionId: SessionId;
  createParams: ZCodeSessionCreateParams;
}): Promise<void> {
  const importedHistory = params.createParams.importedHistory;
  const sessionStore = params.context.deps.sessionStore;
  if (!importedHistory) return;
  if (!sessionStore) {
    throw new ProtocolRequestError(-32003, "Cannot import session history without session store");
  }

  // [失败路径] created/updated 的兜底链是"显式 → 首条消息时间 → now"：直接用 now
  // 会让 2024 年的历史会话出现在列表最前，用户以为是新任务。
  // [事务] updatedAt 必须 >= createdAt（下面的 Math.max）：部分来源给的 updatedAt
  // 早于首条消息，写库后列表排序与"最后活动"展示会互相矛盾。
  const workspace = params.record.workspace;
  const workspaceIdentity = workspace.workspaceIdentity?.trim();
  const now = Date.now();
  const createdAt =
    importedHistory.createdAt ??
    (importedHistory.source === "claudeCode"
      ? importedHistory.messages[0]?.timestamp
      : undefined) ??
    now;
  const updatedAt =
    importedHistory.source === "claudeCode"
      ? (importedHistory.updatedAt ?? importedHistory.messages.at(-1)?.timestamp ?? createdAt)
      : createdAt;
  // 历史导入不执行模型；未绑定时保留消息内容，不能要求当前选择或伪造消息来源。
  const currentModel = optionalModelSelectionFromString(params.record.app.getModel());
  const providerId = currentModel?.providerId as ModelProviderId | undefined;
  const modelId = currentModel?.modelId as ModelId | undefined;

  if (importedHistory.source === "sharedContext") {
    if (!sessionStore.commitSharedContextImportBundle) {
      throw new ProtocolRequestError(
        -32003,
        "Shared context import requires atomic session storage",
      );
    }
    const messageId = createMessageId(`${params.sessionId}_shared_context`);
    const importedAt = importedHistory.createdAt ?? now;
    const contextId =
      importedHistory.provenance.contextId ?? `legacy-shared-context-${params.sessionId}`;
    const contextStatus = importedHistory.provenance.status ?? "pending";
    await sessionStore.commitSharedContextImportBundle({
      session: {
        id: params.sessionId,
        projectID: projectIdFromDirectory(workspace.workspacePath),
        workspaceID: workspaceIdentity as WorkspaceId | undefined,
        traceID: params.record.traceContext.traceId,
        slug: slugifyImportedSession(params.sessionId),
        directory: workspace.workspacePath,
        path: workspace.workspacePath,
        title: importedHistory.title,
        titleSource: "custom",
        version: params.context.deps.version ?? "0.0.0",
        permission: { mode: params.record.app.getMode() },
        time: { created: importedAt, updated: importedAt },
      },
      contextMessage: {
        info: {
          id: messageId,
          sessionID: params.sessionId,
          role: "user",
          time: { created: importedAt },
          agent: "zcode-agent",
          // 合并新增分享导入时仍沿用旧 model 字段，既引用了失效变量，也会丢失未绑定语义。
          // 与普通导入共用结构化选择合同；导入不要求模型可执行。
          ...(currentModel ? { modelSelection: currentModel } : {}),
          synthetic: true,
          source: "shared_context",
          visibility: "model-only",
          semantics: {
            origin: "import",
            kind: "shared_context",
            source: "conversation_share",
            uiVisibility: "hidden",
            providerVisibility: "visible",
            transcriptVisibility: "visible",
          },
          metadata: {
            shareId: importedHistory.provenance.shareId,
            contextId,
            sharedContextStatus: contextStatus,
          },
        },
        parts: [
          {
            id: createPartId(`${params.sessionId}_shared_context_text`),
            sessionID: params.sessionId,
            messageID: messageId,
            type: "text",
            text: importedHistory.markdown,
            time: { start: importedAt, end: importedAt },
            metadata: { sharedContext: true },
          },
        ],
      },
      // [事务] provenance.id 必须含 sessionId：session_entry.id 是全库主键，旧模板只
      // 用 shareId 时，同一个分享导入第二个 workspace 会走 on conflict(id) 把第一个
      // 会话的 provenance 改绑过来（见下方注释）。读取侧只按 (session_id, type) 查，
      // 因此新旧 id 共存是安全的。
      provenance: {
        // session_entry.id 是全库主键（同类修复见 sqlite-session-store.ts
        // 的 fork command fact），旧模板只含 shareId。同一个 share 导入到第二个
        // workspace 时按 (shareCode, workspaceKey) 的去重不命中、marker 也各在自己
        // workspace 下不冲突，saveSessionEntry 的 on conflict(id) 就把第一个会话的
        // provenance 改绑到新会话，旧会话的 shared context 记录静默消失。
        // 校验：所有读取都走 (session_id, type) + data.contextId，没有一处按 id 反查，
        // 因此新旧 id 共存安全，不需要数据迁移。
        id: `v4_shared_context_import:${params.sessionId}:${importedHistory.provenance.shareId}`,
        sessionID: params.sessionId,
        type: "v4/shared_context_import",
        time: { created: importedAt, updated: importedAt },
        data: {
          ...importedHistory.provenance,
          contextId,
          status: contextStatus,
        },
      },
    });
    return;
  }

  await sessionStore.createSession({
    id: params.sessionId,
    projectID: projectIdFromDirectory(workspace.workspacePath),
    // 导入会话创建后会立即 resume；必须先落盘当前 identity，避免恢复时退化为路径隔离。
    workspaceID: workspaceIdentity as WorkspaceId | undefined,
    traceID: params.record.traceContext.traceId,
    slug: slugifyImportedSession(params.sessionId),
    directory: workspace.workspacePath,
    path: workspace.workspacePath,
    title: importedHistory.title?.trim() || "Imported session",
    titleSource: "custom",
    version: params.context.deps.version ?? "0.0.0",
    permission: {
      mode: params.record.app.getMode(),
    },
    time: {
      created: createdAt,
      updated: Math.max(createdAt, updatedAt),
    },
  });

  const removedMessageCount = await removePreviousImportedSessionHistory({
    sessionStore,
    sessionId: params.sessionId,
    source: importedHistory.source,
  });
  let lastUserMessageId: MessageId | undefined;
  let lastImportedMessageTimestamp = createdAt - 1;
  // [事务] 时间戳收敛只做"加一补齐"，不改数组顺序、不重排角色：导入的语义边界
  // 由来源数组决定，用户看到的顺序必须与原始 transcript 完全一致。
  // [失败路径] lastImportedMessageTimestamp 初值取 createdAt-1，保证第一条消息即使
  // 没有 timestamp 也不会与 session 创建时间相同（同一毫秒内排序不稳定）。
  for (const [index, message] of importedHistory.messages.entries()) {
    const rawTimestamp = message.timestamp ?? createdAt + index;

    // sessionStore 按 time_created 排序读取消息，如果 assistant 时间早于 user，
    // UI 会把导入会话显示成 assistant 在上、user 在下。导入边界以数组顺序为准，
    // 只在写库前把时间戳收敛为单调递增，保留消息内容和角色不变。
    const timestamp =
      rawTimestamp > lastImportedMessageTimestamp ? rawTimestamp : lastImportedMessageTimestamp + 1;
    lastImportedMessageTimestamp = timestamp;
    const messageId = createMessageId(`${params.sessionId}_import_${index}`);
    if (message.role === "user") {
      lastUserMessageId = messageId;
      await sessionStore.saveMessage({
        id: messageId,
        sessionID: params.sessionId,
        role: "user",
        time: { created: timestamp },
        agent: "zcode-agent",
        ...(currentModel ? { modelSelection: currentModel } : {}),
        metadata: { migrationSource: importedHistory.source },
      });
    } else {
      await sessionStore.saveMessage({
        id: messageId,
        sessionID: params.sessionId,
        role: "assistant",
        time: { created: timestamp, completed: timestamp },
        parentID:
          lastUserMessageId ?? createMessageId(`${params.sessionId}_import_parent_${index}`),
        ...(currentModel ? { modelId, providerId } : {}),
        mode: params.record.app.getMode(),
        agent: "zcode-agent",
        path: {
          cwd: workspace.workspacePath,
          root: workspace.workspacePath,
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        finish: "stop",
      });
    }
    // [事务] message 与 part 共用同一个 timestamp：part 的时间早于 message 会让
    // 部分读取端（按 part 排序的旧客户端）把内容挂到上一条消息下面。
    // [失败路径] assistant 的 parentID 回落到伪造 id 而不是抛错：历史里存在没有
    // 前置 user 的 assistant 片段（截断导入），伪造 parent 至少保证树不倒挂。
    await sessionStore.savePart({
      id: createPartId(`${params.sessionId}_import_${index}_text`),
      sessionID: params.sessionId,
      messageID: messageId,
      type: "text",
      text: message.content,
      time: { start: timestamp, end: timestamp },
      metadata: { migrationSource: importedHistory.source },
    });
  }

  params.context.logger?.info("ZCode Protocol imported history persisted", {
    event: "zcode_protocol.session_import.persisted",
    messageCount: importedHistory.messages.length,
    module: "bootstrap.zcode_protocol",
    removedMessageCount,
    sessionId: params.sessionId,
    source: importedHistory.source,
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
  });
}

// 旧 session/create 入口：复用统一物化流程，成功后返回带分阶段耗时的完整快照。
// [事务] legacy 入口只做"参数解析 + 复用统一骨架 + 投影成完整快照"，不重复实现
// 任何创建逻辑：两条入口一旦分叉，V4 修复（幂等、清理、taskType）就不会回流到 CLI。
export async function createSession(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  trace?: ZCodeProtocolTrace,
) {
  return createSessionWithProjection(context, rawParams, trace, async (record) => {
    const result = await snapshotWithDiagnostics(context, record);
    return {
      value: result.snapshot,
      phaseDurationsMs: result.phaseDurationsMs,
      messageCount: result.snapshot.messages.length,
    };
  });
}

/** V4 创建只需要 record；不要为了丢弃的 legacy snapshot 强制解析空模型。 */
// [权衡] 两个入口共用同一骨架，差异只在 project 回调：legacy 返回完整 snapshot，
// V4 只返回 sessionId。用泛型回调而不是布尔开关，是为了让"创建完成后做什么"成为
// 编译期可见的单一分叉点，而不是散落在骨架里的 if (isV4)。
// [失败路径] V4 入口传 trace=undefined：它由 gateway 层自己带 trace，重复传入会让
// 子 span 挂到两条 trace 上，火焰图出现重复段。
export async function createSessionRecordForV4(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  return createSessionWithProjection(context, rawParams, undefined, async (record) => ({
    value: { sessionId: record.app.sessionId },
  }));
}

// 通用创建骨架：调用方通过 project 决定返回完整 legacy snapshot 还是仅 sessionId；
// 初始模型/思考档位写入、导入历史恢复与失败清理都在这里统一完成。
// [并发] ID 预占必须在任何 await 之前完成（INV-01）：native 与 V4 两条创建路径可能
// 同时 materialize 同一个 runtime，只有在同步段里写 claims 才能保证二者互相可见。
// [失败路径] 三道判重各有覆盖面：sessions.has 拦活实例，claims.has 拦正在创建的，
// sessionStore.getSession 拦"进程重启前已落库但尚未加载"的。少任何一道都会出现
// 两个 app 抢同一个 sqlite 会话。
// [资源] finally 必须删除 claim，哪怕创建成功：claims 的语义是"创建窗口"，不是
// 终身占位；成功后由 context.sessions 接管唯一性。
async function createSessionWithProjection<T>(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  trace: ZCodeProtocolTrace | undefined,
  project: (
    record: ZCodeProtocolSessionRecord,
  ) => Promise<{ value: T; phaseDurationsMs?: SnapshotPhaseDurationsMs; messageCount?: number }>,
): Promise<T> {
  const params = parseParams(zcodeSessionCreateParamsSchema, rawParams);
  const sessionId = (params.sessionId ?? createSessionId()) as SessionId;
  const claims = (context.sessionCreationIds ??= new Set<string>());
  // Host 预留只决定身份与归属，不能覆盖 CLI 已有/软删/正在创建的会话。
  // 在任何 await 前占用 ID，防止 native 与 V4 并发 materialize 同一 runtime。
  if (context.sessions.has(sessionId) || claims.has(sessionId))
    throw new ProtocolRequestError(-32602, "sessionId already exists");
  claims.add(sessionId);
  try {
    if (await context.deps.sessionStore?.getSession(sessionId))
      throw new ProtocolRequestError(-32602, "sessionId already exists");
    return await materializeCreatedSession(context, { ...params, sessionId }, trace, project);
  } finally {
    claims.delete(sessionId);
  }
}

// [事务] 这里必须"先建 app、再绑定 automationPort、最后回写 record.controller"，
// 三步都在 try 内部（见下方失败清理）：任何一步失败都要走同一套清理，否则会留下
// 一个已连上 sqlite 的 app 无人关闭。
// [并发] 创建期不广播状态：此时 record 还没进 context.sessions，广播会让客户端
// 拿到一个它无法 resume 的 sessionId。
async function materializeCreatedSession<T>(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  trace: ZCodeProtocolTrace | undefined,
  project: (
    record: ZCodeProtocolSessionRecord,
  ) => Promise<{ value: T; phaseDurationsMs?: SnapshotPhaseDurationsMs; messageCount?: number }>,
): Promise<T> {
  const params = parseParams(zcodeSessionCreateParamsSchema, rawParams);
  const startedAt = Date.now();
  const sessionId = params.sessionId! as SessionId;
  const workspace = params.workspace;
  context.logger?.info("ZCode Protocol session/create started", {
    event: "zcode_protocol.session_create.started",
    hasInitialModel: params.model !== undefined,
    hasInitialThoughtLevel: params.thoughtLevel !== undefined,
    inboundTraceId: trace?.traceId,
    module: "bootstrap.zcode_protocol",
    persistence: params.persistence,
    sessionId,
    status: "started",
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
  });
  const recordStartedAt = Date.now();
  const record = await materializeSessionRecord(
    context,
    { ...params, workspace },
    sessionId,
    false,
    { kind: "host" },
    trace,
  );
  const recordCreateDurationMs = Date.now() - recordStartedAt;
  // [事务] record 成功物化后立刻入表，再配置模型：配置期间的并发 send 必须能拿到
  // 同一个 record，否则会出现"创建已完成、发送却报会话不存在"的窗口。
  // [失败路径] 配置/快照失败时不能只 throw：必须 unsubscribe + disposeSession +
  // sessions.delete + close + eventStore.deleteSession 五步全做（INV-02）。
  // 少做 unsubscribe 会留下仍在往已删 record 写事件的订阅；少做 disposeSession 会
  // 留下 publisher 内存泄漏；少做 deleteSession 会让后续 readEvents 读到孤Event。
  context.assertServing?.();
  context.sessions.set(sessionId, record);
  let setInitialModelDurationMs: number | undefined;
  let setInitialThoughtLevelDurationMs: number | undefined;
  let snapshotDurationMs = 0;
  let snapshotPhaseDurationsMs: SnapshotPhaseDurationsMs | undefined;
  const initialModel = params.model;
  const initialThoughtLevel = params.thoughtLevel;
  try {
    // [事务] 模型与思考档位在同一个 mutation 块内下发：runSessionModelConfigMutation
    // 会合并成一次 state 变更广播，否则客户端会先看到模型变了、档位还是旧的中间态。
    // [失败路径] 不支持的档位只 warn 不抛错：workspace 默认档位可能来自上一个模型，
    // 硬塞给 runtime 会抛 Unsupported reasoning effort，把创建整个打断（见下方分支）。
    // [事务] importedHistory 必须"先落库再 resume"：resume 从 store 重建历史，顺序
    // 反过来会恢复出一个空 transcript，随后写入的消息与 runtime 的内存态永久分叉。
    await runSessionModelConfigMutation(record.app, async () => {
      if (initialModel) {
        const setInitialModelStartedAt = Date.now();
        await record.app.setModel(formatProtocolModelSelection(initialModel));
        setInitialModelDurationMs = Date.now() - setInitialModelStartedAt;
        record.stateRevision++;
      }
      const supportedInitialThoughtLevel = resolveSupportedAppThoughtLevel(
        record.app,
        initialThoughtLevel,
      );
      if (supportedInitialThoughtLevel) {
        // app 已接管默认模型/思考深度持久化，session/create 会显式传入 thoughtLevel。
        // Workspace Preferences 必须持久化读取：只读 Agent 内存会在重启后丢掉用户上次选择。
        const setInitialThoughtLevelStartedAt = Date.now();
        await record.app.setThoughtLevel(supportedInitialThoughtLevel);
        setInitialThoughtLevelDurationMs = Date.now() - setInitialThoughtLevelStartedAt;
        record.stateRevision++;
      } else if (initialThoughtLevel) {
        // workspace 默认 thoughtLevel 可能来自上一个模型。新 session 继承另一模型时，
        // 不能把不支持的档位硬塞给 runtime，否则创建阶段会抛 Unsupported reasoning effort。
        context.logger?.warn("ZCode Protocol session/create skipped unsupported thought level", {
          event: "zcode_protocol.session_create.thought_level_skipped",
          module: "bootstrap.zcode_protocol",
          requestedThoughtLevel: initialThoughtLevel,
          sessionId,
          supportedThoughtLevels: record.app.listThoughtLevels(),
          workspaceKey: workspace.workspaceKey,
          workspacePath: workspace.workspacePath,
        });
      }
    });
    if (params.importedHistory) {
      // 历史导入过去只写 legacy snapshot，taskId 不是真实 protocol sessionId，
      // setModel/sendPrompt 会打到不存在的 runtime。这里在创建期把历史写入 sessionStore 并 resume，
      // 让导入结果从第一刻起就是可续聊、可切模型的 ZCode session。
      await persistImportedSessionHistory({
        context,
        record,
        sessionId,
        createParams: params,
      });
      await record.app.resume();
      record.stateRevision++;
    }
    const snapshotStartedAt = Date.now();
    const createdSnapshotResult = await project(record);
    const createdSnapshot = createdSnapshotResult.value;
    snapshotPhaseDurationsMs = createdSnapshotResult.phaseDurationsMs;
    snapshotDurationMs = Date.now() - snapshotStartedAt;
    context.logger?.info("ZCode Protocol session/create completed", {
      durationMs: Date.now() - startedAt,
      event: "zcode_protocol.session_create.completed",
      hasInitialModel: initialModel !== undefined,
      hasInitialThoughtLevel: initialThoughtLevel !== undefined,
      messageCount: createdSnapshotResult.messageCount,
      module: "bootstrap.zcode_protocol",
      persistence: params.persistence,
      recordCreateDurationMs,
      rootTraceId: record.traceContext.traceId,
      sessionId,
      setInitialModelDurationMs,
      setInitialThoughtLevelDurationMs,
      snapshotPhaseDurationsMs,
      snapshotDurationMs,
      status: "completed",
      workspaceKey: workspace.workspaceKey,
      workspacePath: workspace.workspacePath,
    });
    return createdSnapshot;
  } catch (error) {
    context.logger?.warn("ZCode Protocol session/create failed", {
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.session_create.failed",
      module: "bootstrap.zcode_protocol",
      persistence: params.persistence,
      recordCreateDurationMs,
      rootTraceId: record.traceContext.traceId,
      sessionId,
      setInitialModelDurationMs,
      setInitialThoughtLevelDurationMs,
      snapshotPhaseDurationsMs,
      snapshotDurationMs,
      status: "failed",
      workspaceKey: workspace.workspaceKey,
      workspacePath: workspace.workspacePath,
    });
    // draft 创建会用用户上次选择的模型作为启动种子。
    // 如果该模型已被删除，失败的 record 不能留在 context.sessions：
    // 后续 workspace 状态继续读到这个半初始化 app，造成模型/思考档位串台。
    // [失败路径] 这个清理块是创建失败路径的最后一道闸：任何一步漏掉都会让
    // context.sessions 里留下一个"半初始化 app"，后续 workspace 状态接口继续读到它，
    // 表现为模型/思考档位串台（见下方注释）。
    // [权衡] close 与 deleteSession 都用 best-effort 吞错：原始失败原因（例如模型被删）
    // 才是用户需要看到的，清理阶段的次生错误不应覆盖它。
    // [事务] 清理顺序固定为 unsubscribe → disposeSession → delete → close → deleteSession：
    // 先断订阅再关 app，避免 close 期间还在投递事件；先删表再 close，避免 close 的
    // await 期间有新的请求又把 record 读出来。
    record.unsubscribe?.();
    // v4 通道：创建期已 ingest 的事件会惰性建出 publisher，失败清理时一并回收。
    // 创建失败只释放运行态，不把它宣告为 CLI 已持久化的软删除。
    context.v4Gateway?.disposeSession(sessionId);
    context.sessions.delete(sessionId);
    try {
      await record.app.close?.();
    } catch {
      // 保留原始 create 失败原因；close 只是清理半初始化 runtime 的 best-effort 动作。
    }
    // 内存 event store 随 record 释放。
    await record.eventStore.deleteSession(sessionId as SessionId).catch(() => undefined);
    throw error;
  }
}

export interface ActivatedSessionForResume {
  record: ZCodeProtocolSessionRecord;
  knownSession?: SessionInfo;
  /** 仅供启动本次 V4 hydration，不写入 record 或跨请求缓存。 */
  persistedMessages?: MessageWithParts[];
}

/** 只拆掉本次失败的 record；不删除持久历史或 gateway publisher。 */
// [失败路径] resume 失败时这里做三件事：删除可能已落库的 partial record、释放
// 运行态、把错误原样抛出。调用方需要原始错误（例如模型被删）来展示修复建议，
// 因此不能包装成统一的 -32010（见 INV-03）。
export async function discardFailedSessionResume(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  record: ZCodeProtocolSessionRecord,
): Promise<void> {
  if (context.sessions.get(sessionId) !== record) return;
  record.unsubscribe?.();
  context.sessions.delete(sessionId);
  try {
    await record.app.close?.();
  } catch {
    /* 保留原始恢复错误。 */
  }
  await record.eventStore.deleteSession(sessionId as SessionId).catch(() => undefined);
}

/**
 * 只恢复 session runtime 生命周期，不物化任何协议表示。
 *
 * V4 冷订阅过去复用 resumeSession，虽然返回值会被直接丢弃，仍会为大历史
 * 构建一份完整 legacy snapshot。runtime 激活和 legacy 表示是两个职责；这里保留
 * snapshot 之前的原有顺序与副作用，让 V4 随后用自己的 durable projection 水合。
 */
// [并发] 激活前必须先等"同会话的去激活"完成（INV-04）：容量池为省内存会把 app
// 关掉，若新 app 在旧的 sqlite 句柄释放前打开，两边会看到不同的 WAL 快照。
// [事务] 激活顺序为 读持久行 → 修复 legacy workspace → 物化 runtime → 回填真实
// 时间/taskType/选型 → 入表；其中任何一步失败都必须能被 discardFailedSessionResume
// 干净地回滚。
export async function activateSessionForResume(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionResumeParams,
  options: { reusePersistedMessages?: boolean; persistedMessages?: MessageWithParts[] } = {},
): Promise<ActivatedSessionForResume> {
  const resumeStartedAt = Date.now();
  const activeBeforeWait = context.sessions.has(params.sessionId);
  context.logger?.debug("ZCode Protocol session resume started", {
    activeBeforeWait,
    event: "zcode_protocol.session.resume_started",
    hasSessionStore: Boolean(context.deps.sessionStore),
    module: "bootstrap.zcode_protocol",
    sessionId: params.sessionId,
  });
  // 再激活闸门：该 session 正在容量去激活（app.close 收尾未完成）时先等待，
  // 防止新旧 app 对同一 session 资源交错读写。无 in-flight 时立即返回。
  await context.sessionResidentPool?.waitForDeactivation(params.sessionId);
  const existing = context.sessions.get(params.sessionId);
  if (existing) {
    return { record: existing };
  }
  let session = await getPersistedSession(context, params.sessionId);
  if (!session || session.time.deleted !== undefined) {
    // 诊断：冷恢复只有在持久化记录也不存在时才会走到这里；单凭错误文本无法和
    // readSession 的“runtime 尚未活跃”区分，因此把两层状态和等待耗时一起落盘。
    context.logger?.warn("ZCode Protocol session resume found no persisted record", {
      activeBeforeWait,
      activeSessionCount: context.sessions.size,
      durationMs: Math.max(0, Date.now() - resumeStartedAt),
      event: "zcode_protocol.session.resume_persisted_missing",
      hasSessionStore: Boolean(context.deps.sessionStore),
      module: "bootstrap.zcode_protocol",
      sessionId: params.sessionId,
    });
    throw new ProtocolRequestError(
      zcodeProtocolErrorCodes.sessionUnavailable,
      `Session not found: ${params.sessionId}`,
    );
  }
  session = await repairLegacyRemoteSessionWorkspaceForResume(context, session);
  const workspace =
    params.workspace ??
    buildWorkspaceRef({
      // V4 历史会话冷订阅只传 sessionId；远端会话若在这里仅用目录
      // 重建 workspace，identity 会退化成 path key，无法命中按 workspaceID 隔离的
      // provider registry，最终把可用模型误判为不可用并永久触发 restoreWarning。
      workspaceIdentity: session.workspaceID,
      workspacePath: session.path ?? session.directory,
    });
  let persistedMessages =
    options.persistedMessages ?? (await readPersistedSessionMessages(context, params.sessionId));
  const mode = derivePersistedSessionMode(persistedMessages);
  // shell 设置变更只对新 session 生效；冷恢复必须使用创建时落库的
  // Bash shell 快照。runtime.resumeFromStore 会读取快照；这里只负责不把
  // resume 请求里携带的当前 settings 重新注入老 session。
  const record = await materializeSessionRecord(
    context,
    {
      ...params,
      mode,
      // 模型只由 App 的单向迁移/当前 entry 恢复，不能先用消息或调用方 hint 构造一次选择。
      model: undefined,
      ...(session.parentID ? { parentSessionId: String(session.parentID) } : {}),
      // resume 曾丢掉持久化 taskType，createRecord 落回缺省
      // "interactive"。于是被 resume 的 workflow_child / subagent_child 会话通过
      // isTaskListSessionType 的筛，经 getSessionWorkspaceId 漏进 sessions-index，
      // desktop 任务列表长出「workflow actor actor#N@k」假任务，任务索引同步器还会
      // 反复对它们发 session/resume。fork 路径一直带着 taskType，这里必须同样带。
      taskType: session.taskType,
      workspace,
    },
    params.sessionId as SessionId,
    true,
    { kind: "host" },
    session.traceID ? { traceId: session.traceID } : undefined,
  );
  // createRecord 把 createdAt/updatedAt 写死为 Date.now()——resume 老会话
  // 会让 sessions-index 把它当"刚创建"的会话（配合 hydration 前的空标题，侧栏
  // 表现为原会话消失、冒出"新任务刚刚"）。恢复路径回填 store 的真实时间。
  // [事务] 回填真实时间必须在入表之前完成（INV-05）：先入表再回填，会有一个极短
  // 窗口让并发的 session/list 读到 now()，把老会话排到列表顶部且标题还是空的。
  // [并发] restoredModelSelection 只是"首次投影的种子"而不是可执行选择：
  // 用户一旦在本轮发了 ModelSelected 事件，record 必须清掉它（见 setModel），
  // 否则重启后的 resume 会用旧模型覆盖用户新选。
  if (session.time?.created) record.createdAt = session.time.created;
  if (session.time?.updated) record.updatedAt = session.time.updated;
  record.lastOutcome = session.lastOutcome;
  context.assertServing?.();
  context.sessions.set(params.sessionId, record);
  try {
    const resumeResult = await runSessionModelConfigMutation(record.app, async () => {
      const result = options.reusePersistedMessages
        ? await record.app.resume({ persistedMessages })
        : await record.app.resume();
      // 仅用于首次投影种子，包含有效模型+空档位；它不是第二份可执行 Runtime 选择。
      record.restoredModelSelection = result.modelSelection;
      return result;
    });
    if (options.reusePersistedMessages && resumeResult.persistedMessagesReloadRequired) {
      persistedMessages = await readPersistedSessionMessages(context, params.sessionId);
    }
    context.logger?.info("ZCode Protocol session resume completed", {
      activeSessionCount: context.sessions.size,
      durationMs: Math.max(0, Date.now() - resumeStartedAt),
      event: "zcode_protocol.session.resume_completed",
      module: "bootstrap.zcode_protocol",
      persistedMessageCount: persistedMessages.length,
      sessionId: params.sessionId,
      traceId: record.traceContext.traceId,
    });
    return {
      knownSession: session,
      record,
      ...(options.reusePersistedMessages ? { persistedMessages } : {}),
    };
  } catch (error) {
    // resume 入册后失败曾留下半初始化 app，重试误判已就绪；只回收本次 record，保留历史投影。
    await discardFailedSessionResume(context, params.sessionId, record);
    throw error;
  }
}

// 旧 session/resume 入口：激活 runtime 后构建 legacy 快照；V4 冷订阅应改用
// activateSessionForResume，避免为丢弃的返回值构建完整历史投影。
// [失败路径] 失败只能走 discardFailedSessionResume，不能在这里内联清理：那条路径带有
// "只删本次 record"的同一性校验（INV-03），内联清理会误删并发重试刚建好的新 record。
// [事务] knownSession 与 persistedMessages 一起返回：调用方（resumeSession）需要
// store 的原始 time/lastOutcome 构建快照，重新查库会与本次激活的事实不一致。
export async function resumeSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionResumeParamsSchema, rawParams);
  const activated = await activateSessionForResume(context, params);
  return await snapshot(context, activated.record, activated.knownSession);
}

// [事务] 这是"历史数据修复"而不是运行期兼容：只在 workspaceID 为空、且 directory
// 仍等于 path（说明从未被修复过）时才动手，避免把正常会话当成 legacy 反复改写。
// [失败路径] 修复后必须回读 store 确认已落盘（见下方 1947 行注释）：内存里改了但
// 事务返回 false 时如果继续用旧值物化 runtime，工具会在错误 cwd 下执行——这是
// 数据损坏级后果，所以这里选择抛 SessionCorrupted 而不是降级继续。
// [并发] 用 getSession 回读而不是相信 repair 的返回值：repair 的布尔只表示"是否
// 执行了更新"，不表示新值已被本次事务提交可见。
async function repairLegacyRemoteSessionWorkspaceForResume(
  context: ZCodeProtocolAgentServerContext,
  session: SessionInfo,
): Promise<SessionInfo> {
  if (session.workspaceID || !context.deps.sessionStore?.repairLegacyRemoteSessionWorkspace) {
    return session;
  }
  const legacyWorkspaceDirectory = session.path ?? session.directory;
  if (session.directory !== legacyWorkspaceDirectory) return session;
  const legacyRemote = resolveLegacyRemoteWorkspace(context, legacyWorkspaceDirectory);
  if (!legacyRemote) return session;

  const repaired = await context.deps.sessionStore.repairLegacyRemoteSessionWorkspace({
    sessionID: session.id,
    projectID: projectIdFromDirectory(legacyRemote.workspacePath),
    legacyWorkspaceDirectory,
    workspaceID: legacyRemote.workspaceIdentity,
    workspacePath: legacyRemote.workspacePath,
  });
  // 原子修复返回 false 后仍用旧 directory/path 物化 runtime，最终在错误 cwd
  // 中执行工具。这里必须读取原始持久事实，不能让已有 identity 的内存路径修复伪装成已落盘。
  const refreshed = await context.deps.sessionStore.getSession(session.id);
  const repairPersisted =
    refreshed?.workspaceID === legacyRemote.workspaceIdentity &&
    refreshed.directory === legacyRemote.workspacePath &&
    refreshed.path === legacyRemote.workspacePath;
  if (!repairPersisted) {
    context.logger?.warn("legacy remote session workspace repair was not persisted", {
      event: "zcode_protocol.session_resume.legacy_remote_workspace_repair_rejected",
      legacyWorkspaceDirectory,
      legacyWorkspaceIdentity: legacyRemote.workspaceIdentity,
      module: "bootstrap.zcode_protocol",
      repaired,
      sessionId: session.id,
      workspacePath: legacyRemote.workspacePath,
    });
    throw createCoreError(
      CoreErrorType.SessionCorrupted,
      "Legacy remote session workspace repair was not persisted",
      {
        context: {
          directory: refreshed?.directory ?? session.directory,
          path: refreshed?.path ?? session.path,
          reason: "legacy_remote_session_workspace_repair_rejected",
          sessionId: session.id,
          workspaceIdentity: legacyRemote.workspaceIdentity,
        },
        recoverable: true,
      },
    );
  }
  if (repaired) {
    context.logger?.info("legacy remote session workspace repaired", {
      event: "zcode_protocol.session_resume.legacy_remote_workspace_repaired",
      legacyWorkspaceDirectory,
      legacyWorkspaceIdentity: legacyRemote.workspaceIdentity,
      module: "bootstrap.zcode_protocol",
      sessionId: session.id,
      workspacePath: legacyRemote.workspacePath,
    });
  }
  // Core resumeFromStore 会重新读库；NULL identity 修复必须先持久化，不能只改 bootstrap 内存值。
  return refreshed;
}

function resolveLegacyRemoteWorkspace(
  context: ZCodeProtocolAgentServerContext,
  legacyWorkspaceDirectory: string,
): { workspaceIdentity: WorkspaceId; workspacePath: string } | null {
  const currentWorkspacePath = context.deps.cwd ?? process.cwd();
  const direct = parseRemoteWorkspaceIdentity(legacyWorkspaceDirectory);
  if (direct?.kind === "wsl" && direct.workspacePath === currentWorkspacePath) {
    return {
      workspaceIdentity: legacyWorkspaceDirectory as WorkspaceId,
      workspacePath: direct.workspacePath,
    };
  }

  const identityPrefix = currentWorkspacePath === "/" ? "/" : `${currentWorkspacePath}/`;
  if (!legacyWorkspaceDirectory.startsWith(identityPrefix)) return null;
  const embeddedIdentity = legacyWorkspaceDirectory.slice(identityPrefix.length);
  const embedded = parseRemoteWorkspaceIdentity(embeddedIdentity);
  if (
    embedded?.kind !== "wsl" ||
    `${identityPrefix}${embeddedIdentity}` !== legacyWorkspaceDirectory ||
    embedded.workspacePath !== currentWorkspacePath
  ) {
    return null;
  }

  // [失败路径] 只接受"当前 cwd 直接拼出的精确形态"，不在路径里模糊搜索 remote:
  // 前缀。宽松匹配会把用户自己的 ~/remote:xxx 目录误判成 WSL 工作区，随后用错误的
  // workspaceIdentity 执行工具——这比不修复更危险，因此宁可返回 null 放弃修复。
  // [事务] 三段校验（前缀、拼回原文、内层 workspacePath）缺一不可：只校验前缀时
  // "…/remote:wsl:<别的路径>" 也会通过，identity 与 path 就会指向两个不同工作区。
  // 只接受当前 app-server cwd 直接拼出的精确形态，不在任意路径中模糊搜索 remote: 前缀。
  return {
    workspaceIdentity: embeddedIdentity as WorkspaceId,
    workspacePath: embedded.workspacePath,
  };
}

// session/list 合并两类来源：持久化行（可跨冷启动）与内存中尚未落库的活跃
// record；列表只服务 task index，不能借查询触发 runtime 激活。
export async function listSessions(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionListParamsSchema, rawParams ?? {});
  const store = context.deps.sessionStore;
  // 显式 ID 查询只读持久化身份，供 Host 修复旧索引；不能为了识别 child 激活 runtime。
  const candidates = params.sessionIds
    ? await Promise.all(params.sessionIds.map((id) => store?.getSession(id as SessionId) ?? null))
    : store
      ? await store.listSessions({
          directory: params.workspace?.workspacePath,
          limit: params.limit ?? 50,
          taskTypes: [...TASK_LIST_SESSION_TYPES],
        })
      : [];
  // [性能] scoped 用 Promise.all 并发逐行校验，但每行的父链遍历是串行的（需要上一
  // 跳才拿到 parentID），所以这里控制的是"会话之间"的并发，不是单链深度。
  // [失败路径] visited 防环：历史数据里出现过 parentID 自指或父子互指，没有它就会
  // 无限循环把 list 请求挂死。
  // [权衡] 子 runtime 的历史行可能只有 cwd、没有远端 identity，仅显式 ID 查询才允许
  // 凭父链证明归属；列表查询不做这层放宽，否则任务列表会被子会话刷屏。
  const scoped = await Promise.all(
    candidates.map(async (session) => {
      if (!session) return null;
      if (!params.workspace) return session.time.deleted === undefined ? session : null;
      const expectedKey =
        params.workspace.workspaceIdentity?.trim() || params.workspace.workspacePath;
      const visited = new Set<string>();
      let current: SessionInfo | null = session;
      while (current && current.time.deleted === undefined && !visited.has(current.id)) {
        visited.add(current.id);
        const path = current.path || current.directory;
        const key = current.workspaceID?.trim() || path;
        if (key === expectedKey) return session;
        // 子 runtime 的历史行可能只有 cwd，没有远端 workspace identity；仅精确 ID 查询
        // 可凭持久化父链证明归属。目录或显式身份不同就拒绝，不回写身份、不激活 runtime。
        if (
          !params.sessionIds ||
          !isAuxiliarySessionKind(current.taskType) ||
          !current.parentID ||
          path !== params.workspace.workspacePath ||
          (current.workspaceID?.trim() && key !== path)
        )
          return null;
        current = (await store?.getSession(current.parentID)) ?? null;
        if (current && (current.path || current.directory) !== params.workspace.workspacePath)
          return null;
      }
      return null;
    }),
  );
  const stored = scoped.filter((session): session is SessionInfo => session !== null);
  const storedIds = new Set(stored.map((session) => String(session.id)));
  const sessions = stored.map((session) =>
    mapSessionInfo({
      session,
      workspace:
        params.workspace ?? buildWorkspaceRef({ workspacePath: session.path ?? session.directory }),
    }),
  );
  if (params.sessionIds) return { sessions };
  // [事务] 合并内存 record 的四道过滤顺序有意义：deferred（尚未落库）不能出现在
  // 列表里，否则客户端点开时 store 里还查不到；taskType 过滤挡住子会话；storedIds
  // 去重让持久行优先（它带完整 time 与标题）；最后才按 workspaceKey 收敛作用域。
  // [权衡] 只在非 sessionIds 查询时合并内存 record：显式 ID 查询是给 Host 修索引用的，
  // 混入内存态会让修复结果随进程生命周期漂移。
  for (const record of context.sessions.values()) {
    if (record.persistence === "deferred") continue;
    if (!isTaskListSessionType(record.taskType)) continue;
    if (storedIds.has(record.app.sessionId)) continue;
    if (params.workspace && params.workspace.workspaceKey !== record.workspace.workspaceKey)
      continue;
    sessions.push(
      mapSessionInfo({
        app: record.app,
        workspace: record.workspace,
        taskType: record.taskType,
        parentSessionId: record.parentSessionId,
      }),
    );
  }
  return { sessions };
}

// 子代理列表：以持久化父子行与 live projection 重建 running/ended 视图，
// ended 段按游标分页，避免一次把历史全部推给 host。
// [事务] 子代理列表是只读投影：不激活 runtime、不修改 record，纯粹从持久行与
// live 状态拼装。任何"顺手 resume"都会让打开侧栏面板变成一次昂贵的冷启动。
export async function listSessionSubagents(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  persistedMessages?: MessageWithParts[],
) {
  const params = parseParams(zcodeSessionSubagentsParamsSchema, rawParams ?? {});
  const store = context.deps.sessionStore;
  const liveParent = context.sessions.get(params.sessionId);
  if (!store) {
    return {
      revision: liveParent?.stateRevision ?? 0,
      childSessionIds: [],
      running: [],
      ended: { total: 0, items: [] },
    };
  }

  const parentSession = await store.getSession(params.sessionId as SessionId);
  if (!parentSession) {
    // 诊断：hydrate 会复用子任务种子读取；若 task index/旧 ACP task 残留了无效 ID，
    // 这里会把“持久化记录不存在”包装成 v4.hydrate，必须记录调用阶段而不是只看错误文本。
    context.logger?.warn("ZCode Protocol session subagents has no persisted parent", {
      activeSessionCount: context.sessions.size,
      activeSession: Boolean(liveParent),
      event: "zcode_protocol.session.persisted_missing",
      module: "bootstrap.zcode_protocol",
      operation: "session_subagents",
      sessionId: params.sessionId,
    });
    throw new ProtocolRequestError(
      zcodeProtocolErrorCodes.sessionUnavailable,
      `Session not found: ${params.sessionId}`,
    );
  }
  const messages = persistedMessages ?? (await store.messages({ sessionID: parentSession.id }));
  const parentEvents = liveParent
    ? await liveParent.eventStore.getEvents(parentSession.id).catch(() => [])
    : [];
  const childSessionIds = collectSubagentChildSessionIds(parentSession, messages, parentEvents);
  // [失败路径] eventStore.getEvents 与 runtime.getProjection 都吞错降级为 undefined：
  // 子代理列表是"锦上添花"的读面，一条历史事件坏了不该让整个面板报错。
  // [权衡] childSession.taskType 必须是 subagent_child 才计入：同一父链下还有
  // workflow_child，混进来会让子代理面板出现无对应 transcript 的空行。
  // [事务] revision 优先取 liveParent.stateRevision（有内存态时才有意义），否则退化
  // 为持久行的 time.updated：客户端用它判断"是否需要重新拉取"，两者都单调即可。
  const childEntries = await Promise.all(
    childSessionIds.map(async (childSessionId) => {
      const childSession = await store.getSession(childSessionId as SessionId);
      if (!childSession || childSession.taskType !== "subagent_child") return null;
      const childMessages = await store.messages({
        sessionID: childSession.id,
      });
      const liveChild = context.sessions.get(childSessionId);
      const childProjection = liveChild
        ? await liveChild.app.runtime.getProjection().catch(() => undefined)
        : undefined;
      return { childMessages, childProjection, childSession, childSessionId };
    }),
  );
  const persistedChildren = childEntries.filter(
    (entry): entry is NonNullable<typeof entry> => entry !== null,
  );
  const parentProjection = liveParent
    ? await liveParent.app.runtime.getProjection().catch(() => undefined)
    : undefined;
  const projection = projectSessionSubagents({
    revision: liveParent?.stateRevision ?? parentSession.time.updated,
    parentSession,
    messages,
    childSessionsById: new Map(
      persistedChildren.map((entry) => [entry.childSessionId, entry.childSession]),
    ),
    childMessagesById: new Map(
      persistedChildren.map((entry) => [entry.childSessionId, entry.childMessages]),
    ),
    childProjectionsById: new Map(
      persistedChildren.flatMap((entry) =>
        entry.childProjection ? [[entry.childSessionId, entry.childProjection]] : [],
      ),
    ),
    ...(parentProjection ? { parentProjection } : {}),
    ...(parentEvents.length > 0 ? { parentEvents } : {}),
  });
  const ended = paginateEndedSubagents(projection.ended, {
    cursor: params.endedCursor,
    limit: params.endedLimit,
  });
  return {
    revision: projection.revision,
    childSessionIds: persistedChildren.map((entry) => entry.childSessionId),
    running: projection.running,
    ended: {
      total: projection.ended.length,
      items: ended.items,
      ...(ended.nextCursor ? { nextCursor: ended.nextCursor } : {}),
    },
  };
}

const APP_USAGE_RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30 };

// usage 聚合：先固定查询时点与 tz 偏移，再读取 usage store 并构建快照；
// 无 store 时返回零值空快照，让 UI 走空态而不是把查询打成错误。
// [事务] 时间窗口在函数开头一次性固定（until/since/tzOffsetMs），后续所有聚合都用
// 同一组边界：中途再读 Date.now() 会让"按天分桶"和"总计"跨过午夜时对不上。
// [失败路径] store 缺 queryAppUsage 时返回零值快照而不是抛错（INV-31）：UsageStore
// 与 SessionStore 是分离接口，某些嵌入式宿主只实现了后者，报错会让整个设置页空白。
// [权衡] "all" 的 since 传 0 而不是很久以前的时间戳：SQL 侧按整数比较，0 语义明确
// 且不会因时区偏移溢出。
export async function getUsageStats(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeUsageStatsParamsSchema, rawParams ?? {});
  const timeZone = params.timeZone ?? "UTC";
  const until = Date.now();
  const tzOffsetMs = resolveTzOffsetMs(timeZone, until);
  const rangeDays = APP_USAGE_RANGE_DAYS[params.range] ?? 30;
  const since = params.range === "all" ? 0 : until - rangeDays * 86_400_000;
  const buildOptions = {
    range: params.range,
    timeZone,
    tzOffsetMs,
    generatedAt: until,
    since,
    until,
  };

  // SessionStorePort 与 UsageStorePort 是分离接口，但实际 store 同时实现两者；
  // 沿用 core/usage-observability 的运行时收窄方式访问只读聚合方法。
  const usageStore = context.deps.sessionStore as Partial<UsageStorePort> | undefined;
  if (!usageStore?.queryAppUsage) {
    // 无 usage store（不应发生）：返回空快照而非抛错，便于 UI 显示空态。
    return buildAppUsageSnapshot(
      {
        totals: {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          modelRequestCount: 0,
          modelErrorCount: 0,
          avgTimeToFirstTokenMs: null,
        },
        turnTotals: {
          totalSessions: 0,
          totalTurns: 0,
          avgTurnDurationMs: null,
          longestSessionMs: 0,
        },
        toolTotals: { toolCallCount: 0, toolErrorCount: 0 },
        models: [],
        tools: [],
        days: [],
        dayModels: [],
      },
      buildOptions,
    );
  }

  const result = await usageStore.queryAppUsage({ since, until, tzOffsetMs });
  return buildAppUsageSnapshot(result, buildOptions);
}

// [权衡] contentProfile=index 先按 full 构建再裁剪，而不是走一条精简查询路径：
// 索引派生字段（标题/搜索文本/可见性）必须与 full 同源，否则任务索引与打开后的
// 会话不一致，搜索会命中一个打开后标题不同的任务。
// [并发] deliveryKind 在这里回写 record：读请求本身携带通道偏好，写入后后续的
// 事件推送与 readEvents 才会落在同一个序列空间（INV-28）。
export async function readSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionReadParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, {
    deliveryKind: params.deliveryKind,
    operation: "session_read",
  });
  record.deliveryKind = params.deliveryKind ?? record.deliveryKind;
  const result = await snapshot(context, record, undefined, {
    messageLimit: params.messageLimit,
    modelAvailability: "current",
  });
  // task index resync 只需标题/搜索文本/可见性/状态，完整历史单行可达 ~15MB 会打满 host stdio；
  // 先按 full 构建再裁剪大载荷，保证 index 派生字段与 full 同源一致。
  return params.contentProfile === "index" ? elideSessionSnapshotForIndex(result) : result;
}

/**
 * V4 冷恢复 usage 的窄读取：复用 legacy snapshot 的 meter 计算，但不映射完整协议快照。
 */
// [并发] 三路读取用 Promise.all 并行，但 runtime.getProjection 必须等它们完成后再
// 串行取（见下方 2314 行注释）：并行取 projection 会和 ModelComplete/rewind 产生
// 新的跨水位组合，算出与 legacy 快照不同的 token 数。
// [失败路径] record 不在内存时返回 undefined 而不是激活 runtime：这是 V4 冷恢复的
// 窄读取，调用方已经持有 record，凭空激活会让"只是看看用量"变成一次冷启动。
export async function readSessionContextUsage(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  persistedMessages?: MessageWithParts[],
) {
  const record = context.sessions.get(sessionId);
  if (!record) return undefined;
  const [resolvedPersistedMessages, session, events] = await Promise.all([
    persistedMessages ?? readSessionMessages(context, record),
    getPersistedSession(context, sessionId),
    record.eventStore.getEvents(sessionId as SessionId),
  ]);
  // 保持 legacy buildSessionSnapshot 的取数顺序：先固定持久事实，再读取 runtime
  // projection。运行中首订阅若恰逢 ModelComplete/rewind，不能因窄读把 projection
  // 提前到并行阶段而制造新的跨水位组合。
  const projection = await record.app.runtime.getProjection();
  const messages = projectActiveSessionMessages(
    resolvedPersistedMessages,
    session,
    events.filter((event) => event.type === SessionEventType.RewindTriggered),
  );
  return resolveSessionContextUsage({
    messages,
    persistedContextUsageBreakdownEvents: events,
    projection,
  });
}

// 消息读取支持 afterMessageId 增量续读与 limit 尾部截断；afterMessageId 未命中
// 时回退成全量，避免客户端拿到空页后无法自愈。
// [失败路径] afterMessageId 未命中时返回全量而不是空页（见 2352 行注释）：客户端
// 的 afterMessageId 可能来自被 rewind 掉的分支，返回空会让它永久停在"没有更多消息"。
// [权衡] limit 截尾而不是截头：增量续读语义关心"最新一页"，截头会让客户端漏掉
// 刚产生的内容。
export async function readMessages(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionMessagesParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  const allMessages = await readActiveSessionMessages(context, record);
  const afterMessageIndex = params.afterMessageId
    ? allMessages.findIndex((message) => String(message.info.id) === params.afterMessageId)
    : -1;
  const messages = afterMessageIndex >= 0 ? allMessages.slice(afterMessageIndex + 1) : allMessages;
  return {
    messages: params.limit ? messages.slice(-params.limit) : messages,
  };
}

// 事件读取按 afterSeq 续传，并且只返回允许透出的协议事件。
// [并发] 这里用的是 record.deliveryKind（订阅时确立的通道），而不是请求参数：
// 同一条序列必须始终由订阅方持有，否则 afterSeq 会跨序列空间比较（INV-28）。
// [失败路径] 不做"没有新事件就返回空快照"的短路：空数组本身就是合法答复，
// 客户端据此推进游标。
export async function readEvents(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionEventsParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  return {
    events: await readProtocolSessionEvents(context, record, record.deliveryKind, {
      afterSeq: params.afterSeq,
      limit: params.limit,
    }),
  };
}

// [并发] legacyStreamSubscribed 与 deliveryKind 分开记录（见下方 2386 行注释）：
// deliveryKind 会被 session/read 顺手写入，若拿它当作"是否订阅"的判据，一次普通
// 读取就会永久阻止 resident 回收，长跑进程的会话数只增不减。
// [失败路径] afterSeq 未提供时返回空数组而不是全量：订阅是"从此刻开始"的语义，
// 首连时客户端会用 snapshot 补齐历史，重复推全量会让它渲染两遍。
export async function subscribeSession(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeSessionSubscribeParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  record.deliveryKind = params.deliveryKind;
  // 兼容保护：旧 replayable 流没有 unsubscribe RPC。这里只记录真正的 subscribe，
  // 不复用会被 session/read 写入的 deliveryKind，避免普通读取永久阻止 resident 回收。
  record.legacyStreamSubscribed = true;
  const events =
    params.afterSeq === undefined
      ? []
      : await readProtocolSessionEvents(context, record, record.deliveryKind, {
          afterSeq: params.afterSeq,
        });
  return {
    eventSeq: await getProtocolEventSeq(context, record, record.deliveryKind),
    events,
    sessionId: params.sessionId,
    snapshot: params.includeSnapshot
      ? await snapshot(context, record, undefined, {
          modelAvailability: "current",
        })
      : undefined,
  };
}

// 旧 session/send：先过子代理只读、活跃 turn、restoreWarning 与模型可用性闸门，
// 再把输入交给后台 turn；协议层立即 ACK，进度通过事件与 state.updated 推送。
// [事务] sendPrompt 的函数体只做"准入 + 登记 + 起后台任务 + 立即 ACK"，
// 真正的模型调用在 runPromptTurnInBackground 里（见 2500 行注释）：把准入留在
// 同步段，才能保证 ACK 之前的失败都会以 -32010/-32031 同步返回。
export async function sendPrompt(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionSendParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  // [事务] 准入顺序是契约（INV-14）：只读 → 乐观并发 → 活跃 turn → 恢复告警 →
  // 模型可用。把"只读"放最后，子代理会话会先跑一遍 revision 校验并产生日志；
  // 把"模型可用"提前，则会在已有活跃 turn 时白跑一次模型探测。
  // legacy 输入入口同样必须保持子代理只读，不能绕过 V4 用户输入准入。
  if (isReadonlyAgentSessionKind(record.taskType)) {
    throw new ProtocolRequestError(-32010, "Subagent sessions are read-only", {
      reasonCode: "guard.subagentReadOnly",
    });
  }
  // [并发] 两个 revision 断言分别覆盖"协议状态"与"provider 配置"两个维度：
  // stateRevision 做乐观并发，防止两个标签页同时改设置后静默覆盖；providerRevision
  // 覆盖模型注册表变更（例如用户刚删掉某个 provider）。合并成一个会让错误码失去区分度。
  assertExpectedRevision(record, params.expectedRevision);
  assertExpectedProviderRevision(context, record, params.expectedProviderRevision);
  // [并发] activeAbortController 是唯一判据（INV-15）：不用 app.runtime 的 turn 状态，
  // 因为它可能已进入收尾而协议侧还没把 ACK 发完；两者不同步会让新输入插进正在
  // 排空缓冲的旧 turn。
  if (record.activeAbortController) {
    context.logger?.warn("ZCode Protocol session/send rejected: active prompt exists", {
      inputId: params.inputId,
      queryId: params.queryId,
      sessionId: params.sessionId,
      textLength: params.content.length,
      workspacePath: record.workspace.workspacePath,
    });
    throw new ProtocolRequestError(-32010, "A prompt is already running for this session");
  }
  // [失败路径] restoreWarning 必须在这里拦，而不是等 runtime 拒绝：告警携带的是
  // "会话恢复时模型/工作区不可用"的修复建议，直接发出去只会得到含糊的模型报错，
  // 用户不知道要先去设置里修什么。
  if (record.restoreWarning) {
    throw new ProtocolRequestError(-32031, record.restoreWarning.message, {
      code: record.restoreWarning.type,
      sessionId: record.app.sessionId,
      workspace: record.workspace,
    });
  }
  await ensureSessionModelAvailableForNextTurn(context, record);
  if (record.persistence === "deferred") {
    // 未发送前的 draft session 不进入两份 sqlite；用户真正发送首条消息时，
    // 才把它提升为普通 session，让后续 list/syncer/task index 按真实任务处理。
    record.persistence = "immediate";
  }
  // [事务] persistence 只允许 deferred → immediate 单向推进（INV-23）：回退成
  // deferred 会让已经写进 sqlite 的会话在列表里消失，而磁盘上仍有数据。
  const abortController = new AbortController();
  record.activeAbortController = abortController;
  context.logger?.info("ZCode Protocol session/send accepted", {
    attachmentCount: params.attachments?.length ?? 0,
    inputId: params.inputId,
    queryId: params.queryId,
    sessionId: params.sessionId,
    textLength: params.content.length,
    workspacePath: record.workspace.workspacePath,
  });
  const inputId = params.inputId ?? (params.modelSelection ? crypto.randomUUID() : undefined);
  // 旧附件载荷也经同一个 canonical intent 固定本次选择，不先改 Session。这里只借用
  // 公共 metadata 构造器（非 V4 ACK/重放入口）；无 V4 admission 的序号沿既有值 0。
  const intent =
    params.modelSelection && inputId
      ? inputIntentMetadata(
          {
            commandId: inputId,
            clientId: "legacy-session-send",
            sessionId: params.sessionId,
            type: "sendText",
            payload: {},
            issuedAt: Date.now(),
          },
          {
            text: params.content,
            requestedDelivery: "startNow",
            modelSelection: params.modelSelection,
          },
        )
      : undefined;
  // [资源] 整个 turn 包在 runWithSessionResidencyFinalization 里：turn 结束（含异常）
  // 时统一释放 resident 占用，否则会话会一直被判定为"热"，容量池无法降级。
  // [失败路径] 末尾的 .catch 是 INV-16 的落点：后台 turn 的错误走状态与事件上报，
  // 这里只负责不让它变成 unhandled rejection 把进程打崩。
  void runWithSessionResidencyFinalization(record, () =>
    runPromptTurnInBackground(context, record, {
      abortController,
      attachments: params.attachments,
      browserAmbientContext: params.browserAmbientContext,
      inputId,
      intent,
      modelExecution: params.modelExecution
        ? createModelExecutionContext(params.modelExecution)
        : undefined,
      queryId: (params.queryId ?? inputId) as QueryId | undefined,
      content: params.content,
      ...(params.automationId
        ? { automationId: params.automationId }
        : params.offPeakTaskId
          ? {
              offPeakTaskId: params.offPeakTaskId,
              ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
            }
          : {}),
      toolDenylist: params.toolDenylist,
      botDeliveryTarget: params.botDeliveryTarget,
    }),
  ).catch(() => {
    // 后台 turn 的错误会通过状态/事件流降级上报；这里兜底防止协议进程出现 unhandled rejection。
  });
  // session/send 只是“提交用户输入”的协议请求，不能同步等待整轮模型生成完成。
  // 同步等待首 token/整轮会让超过 30s 的请求触发 host timeout，并且阻塞后续 session/resume、list 等协议消息。
  // 这里收到输入后立即 ACK，后台 turn 继续通过 session event/state.updated 推送进度。
  // [并发] 这里必须"立即 ACK"而不是 await 整轮（见下方 2500 行注释）：超过 30s 的
  // 请求会触发 host 侧超时，并且把同一连接上的 session/resume、session/list 全部堵住。
  // 协议层能立即返回的唯一前提是：上面的所有准入校验都已同步完成，且 turn 的失败
  // 有事件通道兜底——两者缺一，ACK 之后就会丢失失败信息。
  return afterPromptAccepted(context, record, "prompt_started");
}

// 压缩：已在压缩中直接返回 already_running 快照；否则登记 abortController 后台执行，
// 并立即返回 accepted 让 UI 先收起命令气泡。
// [并发] compact 与普通 prompt 共用 activeAbortController，因此必须先判"活跃的是
// 不是 compact"（见 2580 行注释）：重复点击压缩应得到 already_running，而不是排队
// 第二个压缩——两次摘要会互相覆盖对方的 summary 消息。
export async function compactSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionCompactParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  // [并发] 幂等判定必须读 runtime 的 activeTurn 而不是 record.activeAbortController：
  // 普通 prompt 也可能正在跑，但只有 kind=compact 才应该走 already_running 分支；
  // 用协议侧的 controller 无法区分"正在压缩"和"正在聊天"。
  const activeTurn = record.app.runtime.getActiveTurnInfo();
  if (activeTurn?.kind === "compact") {
    // 重复 `/compact` 是同一 session 的上下文维护请求；压缩中再收到时应直接丢弃，
    // 不能进入普通 prompt/steer 队列，也不能渲染成一次失败的压缩横条。
    return {
      response: "",
      snapshot: await snapshot(context, record, undefined, {
        modelAvailability: "current",
      }),
      compact: {
        state: "already_running" as const,
        ...(params.inputId ? { inputId: params.inputId } : {}),
      },
    };
  }
  ensureNoActiveTurn(record, "Cannot compact while a prompt is running");
  if (record.restoreWarning) {
    throw new ProtocolRequestError(-32031, record.restoreWarning.message, {
      code: record.restoreWarning.type,
      sessionId: record.app.sessionId,
      workspace: record.workspace,
    });
  }
  await ensureSessionModelAvailableForNextTurn(context, record);
  const instructions = params.instructions?.trim();
  const command = instructions ? `/compact ${instructions}` : "/compact";
  // [事务] 顺序固定为：登记 controller → 起后台任务 → stateRevision++ →
  // 取 accepted 快照 → 广播 compact_started。revision 必须在快照之前自增，否则
  // 客户端拿到的快照 revision 与下一次 state.updated 相同，乐观并发无法收敛。
  const abortController = new AbortController();
  // compact 的真实模型请求在后台执行，但 Stop 仍通过 record.activeAbortController 中断。
  // 如果这里不登记 controller，压缩中的模型请求会继续跑到自然结束。
  record.activeAbortController = abortController;
  void runWithSessionResidencyFinalization(record, () =>
    runCompactTurnInBackground(context, record, {
      abortController,
      command,
      inputId: params.inputId,
    }),
  ).catch(() => {
    // 后台 compact 的错误会通过 compact timeline/state.updated 降级上报；这里兜底防 unhandled rejection。
  });
  record.stateRevision++;
  record.updatedAt = Date.now();
  const acceptedSnapshot = await snapshot(context, record, undefined, {
    modelAvailability: "current",
  });
  emitStateUpdated(context, record, "compact_started", { status: "running" });
  return {
    response: "",
    snapshot: acceptedSnapshot,
    compact: {
      state: "accepted" as const,
      ...(params.inputId ? { inputId: params.inputId } : {}),
    },
  };
}

// [失败路径] 异常一律吞掉并把原因折算成 mutationReason：compact 失败是"上下文维护
// 失败"，不该把整个会话打成错误态；状态更新走 afterStateMutation 让 UI 能解释
// 为什么压缩条消失（取消 vs 失败）。
// [事务] finally 里必须先释放 activeAbortController 再广播状态（见 2642 行注释）：
// 顺序反过来，ready 边界上排队的 prompt 会短暂撞上旧 controller 并被拒绝。
async function runCompactTurnInBackground(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    abortController: AbortController;
    command: string;
    inputId?: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  let mutationReason = "session_compacted";
  context.logger?.info("ZCode Protocol background compact started", {
    inputId: params.inputId,
    sessionId: record.app.sessionId,
    workspacePath: record.workspace.workspacePath,
  });
  try {
    await record.app.submitPrompt(params.command, {
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
    });
    context.logger?.info("ZCode Protocol background compact completed", {
      durationMs: Date.now() - startedAt,
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } catch (error) {
    mutationReason = params.abortController.signal.aborted
      ? "session_compact_cancelled"
      : "session_compact_failed";
    context.logger?.warn("ZCode Protocol background compact failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } finally {
    // [并发] 同一性校验（===）而不是直接置 undefined：compact 期间若用户先 stop
    // 再发起新 prompt，新 controller 已被登记，这里无条件清空会把新 turn 的锁删掉。
    if (record.activeAbortController === params.abortController) {
      // compact 结束后必须先释放 active lock 再广播状态；否则 queued prompt
      // 或后续 `/compact` 会在 ready 边界短暂撞上旧 controller。
      record.activeAbortController = undefined;
    }
  }
  await afterStateMutation(context, record, mutationReason);
}

// /goal 控制面：show/pause/resume/clear/set(replace) 五种动作。pause 是显式停止
// 控制命令，允许打断 active turn；其余动作都要求当前没有进行中的 turn。
// [事务] 五个动作（set/append/cancel/pause/status）共用一个入口，但只有 pause 与
// status 允许在活跃 turn 中执行：其余动作会改写目标，从而改变正在跑的 verifier 的
// 判定基准（INV-17）。
export async function goalSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionGoalParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  // /goal 是目标状态写入，不是普通 prompt；除 pause 外运行中允许执行会绕过前端队列并污染当前 turn。
  // pause 是用户显式停止 active goal 的控制面命令，必须能打断当前 assistant turn 或 verifier。
  const goalPauseMayInterruptActiveTurn = params.action === "pause";
  if (!goalPauseMayInterruptActiveTurn) {
    ensureNoActiveTurn(record, "Cannot manage goals while a prompt is running");
  }

  // [权衡] 目标能力缺失时返回提示而不是抛错：老版本 App 没有 target 四件套，
  // 抛错会让 /goal 在旧客户端上表现为"命令不存在"以外的莫名失败；返回文本至少
  // 能告诉用户是客户端不支持。
  if (
    !record.app.readTarget ||
    !record.app.setTarget ||
    !record.app.updateTargetStatus ||
    !record.app.clearTarget
  ) {
    return {
      response: "Goal management is not available in this client.",
      snapshot: await snapshot(context, record),
      startedTurn: false,
    };
  }

  if (params.action === "show") {
    return {
      response: formatGoalSummary(await record.app.readTarget()),
      snapshot: await snapshot(context, record),
      startedTurn: false,
    };
  }

  // [事务] pause 的取值顺序不可换：先读现有 controller、再改目标状态、最后 abort。
  // 先 abort 再改状态，会在 turn 收尾的日志与事件里看到"已暂停但目标仍是 active"；
  // 若 updateTargetStatus 返回空（没有目标），则不能 abort——用户只是想暂停一个
  // 不存在的目标，不该顺手打断正在跑的普通对话。
  if (params.action === "pause") {
    const activeAbortController = record.activeAbortController;
    const target = await record.app.updateTargetStatus("paused");
    if (target && activeAbortController) {
      context.logger?.info("ZCode Protocol goal pause aborting active turn", {
        inputId: params.inputId,
        sessionId: params.sessionId,
        targetId: target.targetID,
        workspacePath: record.workspace.workspacePath,
      });
      activeAbortController.abort(new Error("ZCode Protocol goal paused"));
    }
    const snapshotAfterGoal = await afterStateMutation(context, record, "goal_paused");
    return {
      // pause 是状态控制动作，UI 已通过目标面板和 runtime 收口体现结果；
      // 返回 "Goal paused Objective..." 会被渲染成一条无意义 assistant 气泡并重复暴露目标正文。
      response: target ? "" : "No goal to pause.",
      snapshot: snapshotAfterGoal,
      startedTurn: false,
    };
  }

  if (params.action === "resume") {
    const target = await record.app.updateTargetStatus("active");
    if (!target) {
      return {
        response: "No goal to resume.",
        snapshot: await snapshot(context, record),
        startedTurn: false,
      };
    }
    return await continueGoalAfterChange(context, record, {
      inputId: params.inputId,
      reason: "goal_resumed",
      target,
      title: "Goal resumed",
    });
  }

  if (params.action === "clear") {
    const cleared = await record.app.clearTarget();
    const snapshotAfterGoal = await afterStateMutation(context, record, "goal_cleared");
    return {
      response: cleared ? "Goal cleared." : "No goal to clear.",
      snapshot: snapshotAfterGoal,
      startedTurn: false,
    };
  }

  const objective = params.objective?.trim() ?? "";
  if (objective.length === 0) {
    return {
      response:
        params.action === "replace"
          ? "Usage: /goal replace <objective>"
          : "Usage: /goal <objective>",
      snapshot: await snapshot(context, record),
      startedTurn: false,
    };
  }

  // App 输入框里的 `/goal 新目标` 是用户显式提交的新目标；已有目标时继续要求
  // replace 会让用户以为目标已变更但数据库仍保留旧目标。这里把重复 set 收敛成 replace 语义。
  // [事务] "是 set 还是 replace"必须由"是否已有目标"决定，而不是由命令字面决定：
  // 用户在输入框敲 `/goal 新目标` 时 action 仍是 set，若按 set 处理会让旧目标残留，
  // 用户以为已改但数据库里还是旧的（见下方注释）。
  const replacesExistingGoal =
    params.action === "replace" || Boolean(await record.app.readTarget());

  const target = await record.app.setTarget({ objective, status: "active" });
  return await continueGoalAfterChange(context, record, {
    inputId: params.inputId,
    reason: replacesExistingGoal ? "goal_replaced" : "goal_set",
    target,
    title: "Goal active",
  });
}

// 分叉：先让 core 复制 checkpoint，再以父会话的 mode/model/thoughtLevel 注册 child
// record；注册细节与 V4 running fork 共用 registerForkedSession。
// [事务] 父会话的 mode/model/thoughtLevel 必须在 fork 之前读取（不是 resume 之后）：
// fork 期间父会话仍可被并发修改，晚读会拿到与"被复制的 transcript"不一致的选型。
// [失败路径] 分叉前必须 ensureNoActiveTurn：turn 进行中复制 checkpoint 会得到
// 一个"半条 assistant 消息"的分支，客户端渲染时会出现没有结束标记的气泡。
export async function forkSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionForkParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  ensureNoActiveTurn(record, "Cannot fork while a prompt is running");
  const forkTarget = await resolveForkTarget(context, record, params.target);
  const parentMode = record.app.getMode();
  const parentModel = record.app.getModel();
  const parentThoughtLevel = record.app.getThoughtLevel();
  const fork = await record.app.forkFromCheckpoint({
    targetCheckpointId: forkTarget.targetCheckpointId,
    targetMessageId: forkTarget.targetMessageId,
  });
  return await registerForkedSession(context, record, fork, {
    runtimeConfig: {
      mode: parentMode,
      model: parentModel,
      thoughtLevel: parentThoughtLevel,
    },
    inheritLatestTarget: true,
  });
}

/**
 * 已完成 core copy 后只注册 child record。V4 running fork 复用这段宿主生命周期，
 * 但不会进入 forkSession 的 active-turn guard / workspace fork；runtimeConfig 可固定在 fork 点。
 */
export async function registerForkedSession(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  fork: Awaited<ReturnType<ZCodeProtocolSessionRecord["app"]["forkFromCheckpoint"]>>,
  options: {
    runtimeConfig: {
      mode: CollaborationMode;
      model: string;
      thoughtLevel?: string;
      followupMode?: "queue" | "guide";
    };
    inheritLatestTarget: boolean;
  },
) {
  const parentMode = options.runtimeConfig.mode;
  const parentModel = options.runtimeConfig.model;
  const parentThoughtLevel = options.runtimeConfig.thoughtLevel;
  const parentFollowupMode = options.runtimeConfig.followupMode;
  const forkedSession = await getPersistedSession(context, fork.forkedSessionId);
  if (!forkedSession) {
    throw new Error(`Persisted child session not found: ${fork.forkedSessionId}`);
  }
  const forkRecord = await materializeSessionRecord(
    context,
    {
      sessionId: fork.forkedSessionId,
      mode: parentMode,
      // 未绑定父会话也允许复制历史；不能因分叉而选择默认模型或解析空字符串。
      model: optionalModelSelectionFromString(parentModel),
      ...(fork.parentSessionId ? { parentSessionId: fork.parentSessionId } : {}),
      taskType: forkedSession.taskType,
      workspace: record.workspace,
    },
    fork.forkedSessionId as SessionId,
    true,
    { kind: "inherit", parent: record },
  );
  context.assertServing?.();
  context.sessions.set(fork.forkedSessionId, forkRecord);
  // [事务] 三个 set 都带"不等于才写"的前置判断：无谓的 set 会 bump stateRevision，
  // 让客户端收到一串其实没有变化的 state.updated，乐观并发会因此误判冲突。
  // [失败路径] 模型为空时跳过（见 2835 行注释）：未绑定模型的会话也能复制历史，
  // 强行 resolve 会退回默认模型，用户 fork 出来的分支会突然换成另一个模型。
  await runSessionModelConfigMutation(forkRecord.app, async () => {
    // fork 是父会话运行态的分支；只复制消息的话新 record 会从 workspace 默认值恢复，
    // 于是 fork 后的当前模型/模式会被最新默认设置覆盖。这里在 resume 前显式继承父会话设置。
    if (forkRecord.app.getMode() !== parentMode) {
      await forkRecord.app.setMode(parentMode);
      forkRecord.stateRevision++;
    }
    if (parentModel && forkRecord.app.getModel() !== parentModel) {
      await forkRecord.app.setModel(parentModel);
      forkRecord.stateRevision++;
    }
    if (parentThoughtLevel && forkRecord.app.getThoughtLevel() !== parentThoughtLevel) {
      await forkRecord.app.setThoughtLevel(parentThoughtLevel);
      forkRecord.stateRevision++;
    }
    if (parentFollowupMode && parentFollowupMode !== "queue") {
      await forkRecord.app.setFollowupMode(parentFollowupMode);
      forkRecord.stateRevision++;
    }
  });
  if (options.inheritLatestTarget) {
    await inheritForkedSessionTarget(context, record, forkRecord, fork.forkedSessionId);
  }
  await forkRecord.app.resume();
  return {
    forkedSessionId: fork.forkedSessionId,
    parentSessionId: fork.parentSessionId,
    targetMessageId: fork.targetMessageId,
    targetCheckpointId: fork.targetCheckpointId,
    response: fork.response,
    snapshot: await snapshot(context, forkRecord, forkedSession),
  };
}

// [事务] 只在子会话尚无目标时克隆（INV-19）：已有目标说明 core 的 fork 已经复制过，
// 再 clone 会覆盖掉 core 写入的 verifier 进度。
// [失败路径] 不能用 setTarget 重建目标：那会生成新的 targetId，verifier timeline
// 与 copied transcript 的关联立即断开（下方注释）。
// [权衡] cloneTargetForFork 缺失时静默跳过而不是报错：旧 store 实现没有这条能力，
// fork 本身仍然可用，只是目标面板为空。
async function inheritForkedSessionTarget(
  context: ZCodeProtocolAgentServerContext,
  parentRecord: ZCodeProtocolSessionRecord,
  forkRecord: ZCodeProtocolSessionRecord,
  forkedSessionId: string,
) {
  const parentTarget = await parentRecord.app.readTarget();
  if (!parentTarget || !context.deps.sessionStore) {
    return;
  }
  const existingChildTarget = await context.deps.sessionStore.readTarget({
    sessionID: forkedSessionId as SessionId,
  });
  if (existingChildTarget) {
    return;
  }
  if (!context.deps.sessionStore.cloneTargetForFork) {
    return;
  }

  // core fork 现在会复制 goal state；bootstrap 只保留旧 app/fake app 的兜底。
  // 不能再 setTarget 新建 targetId，否则 verifier timeline 会和 copied transcript 断开。
  await context.deps.sessionStore.cloneTargetForFork({
    sessionID: forkedSessionId as SessionId,
    source: parentTarget,
    status: parentTarget.status,
  });
  forkRecord.stateRevision++;
  forkRecord.updatedAt = Date.now();
}

// [事务] 后台 turn 是"协议手里的唯一 runner"：把 attachments/inputId/intent 原样
// 交给 appendAndRun，不在这里做任何转换——转换放在边界（mapProtocolPromptAttachments）
// 已经完成一次，二次加工会让两条入口的语义漂移。
// [失败路径] rejected 必须转成协议错误并 break：continue 会让循环拿着一个未开始的
// turnId 继续等终态，直到超时（见 3005 行注释）。
// [资源] finally 的三件事顺序固定：清 controller → 恢复归属标记 → 广播终态。
async function runPromptTurnInBackground(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    abortController: AbortController;
    intent?: SendInputOptions["intent"];
    modelExecution?: SendInputOptions["modelExecution"];
    attachments?: unknown[];
    browserAmbientContext?: {
      tabCount: number;
      currentUrl?: string;
    };
    inputId?: string;
    queryId?: QueryId;
    content: string;
    toolDenylist?: readonly string[];
    botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  } & TurnBackgroundAttribution,
): Promise<void> {
  const startedAt = Date.now();
  context.logger?.info("ZCode Protocol background turn started", {
    inputId: params.inputId,
    queryId: params.queryId,
    sessionId: record.app.sessionId,
    textLength: params.content.length,
    workspacePath: record.workspace.workspacePath,
  });
  let mutationReason = "prompt_completed";
  // [事务] 先保存上一轮归属再覆盖（INV-20）：record 会跨 turn 复用，finally 里必须
  // 恢复成"上一轮的值"而不是 undefined，否则 fork/detached 场景下后续普通 turn 会
  // 丢掉自己继承来的归属标记。
  // [失败路径] 只置位不恢复，会让第一轮 automation turn 之后的所有普通 turn 都被
  // 当成 automation 轮——CronCreate 被永久禁用，用户再也不能建定时任务。
  const previousAutomationId = record.activeAutomationId;
  const previousOffPeakTaskId = record.activeOffPeakTaskId;
  const previousBotDeliveryTarget = record.activeBotDeliveryTarget;
  const activeAutomationId = resolvePromptTurnAutomationId(params);
  const activeOffPeakTaskId = resolvePromptTurnOffPeakTaskId(params);
  // [并发] 工具面去重是"双层防护"：port 拒绝只能挡住一次调用，模型看到工具仍然
  // 可用时会改调别的路径（CronCreate 失败后改 CronDelete）。因此本轮的 provider
  // 工具面里必须直接没有这些名字（INV-21）。
  // [权衡] automation 轮不加 OffPeakCreate：定时派生闲时任务是合法链路，禁掉会让
  // "夜间批处理"这一产品能力整体失效。
  const turnToolDisallowlist = buildPromptTurnToolDisallowlist(
    params,
    activeAutomationId,
    activeOffPeakTaskId,
  );
  if (activeAutomationId) {
    // 附件输入仍走旧 session/send；automation 派发可能漏传 automationId，
    // 但 inputId 会保留 automation-* runId。这里兜底标记，避免 CronCreate 在绑定 active
    // 会话里递归创建定时任务。
    record.activeAutomationId = activeAutomationId;
  }
  if (activeOffPeakTaskId) {
    // 闲时派发轮同型兜底标记，供 offpeak-port 拒绝递归 OffPeakCreate。
    record.activeOffPeakTaskId = activeOffPeakTaskId;
  }
  record.activeBotDeliveryTarget = params.botDeliveryTarget;
  try {
    const admission = await record.app.sendInput(
      {
        attachments: mapProtocolPromptAttachments(params.attachments),
        text: params.content,
      },
      {
        abortSignal: params.abortController.signal,
        intent: params.intent,
        modelExecution: params.modelExecution,
        browserAmbientContext: params.browserAmbientContext,
        inputId: params.inputId,
        queryId: params.queryId,
        ...(params.automationId
          ? { automationId: params.automationId }
          : params.offPeakTaskId
            ? {
                offPeakTaskId: params.offPeakTaskId,
                ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
              }
            : {}),
        // legacy session/send 同样可能复用 active runtime；只做 port 拒绝时模型仍看得到
        // CronCreate，并可能在失败后改调 CronDelete。automation turn 与 cron task 会话后续输入
        // 都直接从本轮 provider 工具面移除。
        ...(turnToolDisallowlist ? { toolDisallowlist: turnToolDisallowlist } : {}),
      },
    );
    // admission 不是整轮结束。提前清理会丢失 automation 归属及 Stop controller；
    // ACK 已由 session/send 返回，后台只在真实 completion 后释放本轮资源。
    // [事务] admission 只是"已接受"，不是整轮结束（见 3005 行注释）：在这里提前
    // 清 controller 会让 Stop 按钮在模型仍在输出时失效，也会让归属标记提前回滚。
    // [失败路径] rejected 必须转成协议错误码而不是静默返回：sendInput 的拒绝原因
    // （队列满/只读/重复 inputId）只有转成 -32010 才能被客户端渲染成一次明确失败。
    if (admission.kind === "rejected") {
      throw new ProtocolRequestError(-32010, `Prompt admission rejected: ${admission.reason}`);
    }
    if (admission.kind === "started_turn") await admission.completion;
    context.logger?.info("ZCode Protocol background turn completed", {
      durationMs: Date.now() - startedAt,
      inputId: params.inputId,
      queryId: params.queryId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } catch (error) {
    mutationReason = "prompt_failed";
    context.logger?.warn("ZCode Protocol background turn failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } finally {
    // [并发] 释放顺序是 ready 边界正确性的前提（INV-15）：先清 controller 再广播
    // afterStateMutation，否则手机端收到 ready 立刻 drain 时会被自己的 409 拒绝。
    // [失败路径] 同一性校验仍是必要的：这一轮已被 stop 且新 prompt 接手时，这里的
    // controller 已不是记录里的那个，无条件清空会把新 turn 的锁删掉。
    if (record.activeAbortController === params.abortController) {
      // prompt_completed/prompt_failed 是下游 host queue 的 ready 边界。
      // 必须先释放 active lock 再广播状态，否则手机端收到 ready 后立刻 drain 会被
      // session/send 拒绝为 "A prompt is already running for this session"。
      record.activeAbortController = undefined;
      context.logger?.info("ZCode Protocol background turn cleared active controller", {
        durationMs: Date.now() - startedAt,
        inputId: params.inputId,
        sessionId: record.app.sessionId,
        workspacePath: record.workspace.workspacePath,
      });
    }
    record.activeAutomationId = previousAutomationId;
    record.activeOffPeakTaskId = previousOffPeakTaskId;
    // Bug 原因：legacy record 会跨 turn 复用；必须恢复 Bot 地址，避免后续普通 UI turn
    // 创建的定时任务错误继承上一轮 Bot 会话。
    record.activeBotDeliveryTarget = previousBotDeliveryTarget;
  }
  await afterStateMutation(context, record, mutationReason);
}

// [事务] 远程 workspace 的禁用在 session 初始化阶段完成，而不是每次 turn 再判断：
// 工具面在 app 构造期就固化了，晚一步加 deny 对已经建好的 provider 无效。
// [失败路径] 只覆盖 Cron 四件套而保留 CronList 的读能力会让用户看到"有任务但删不掉"，
// 因此四个名字一起禁，UI 层面表现为能力整体不可用。
function resolveSessionToolDenylist(
  params: Pick<ZCodeSessionCreateParams, "toolDenylist">,
  workspace: ZCodeWorkspaceRef,
): readonly string[] | undefined {
  const tools = new Set(params.toolDenylist ?? []);
  if (workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity)) {
    // Bug 原因：SSH/WSL/Docker/Server 等远程会话仍注入 automationPort，导致 Cron 工具在远端被注册；
    // 远程 workspace 没有本地调度器的可靠触发边界，所以必须在 session 初始化时统一禁用，
    // 不能只依赖 UI 或 prompt 文本约束。
    for (const toolName of REMOTE_AUTOMATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  return tools.size > 0 ? [...tools] : undefined;
}

// [事务] 两个默认参数（activeAutomationId / activeOffPeakTaskId）让调用方可以传入
// "兜底解析后的归属"，而不必重复写一遍 params.automationId：归属解析逻辑集中在
// resolvePromptTurn* 里，这里只负责把它翻译成工具黑名单。
// [失败路径] 返回值保持 undefined 而不是空数组：空数组会被下游当作"显式清空黑名单"，
// 覆盖掉 workspace 级（远程）已有的人 deny 项。
function buildPromptTurnToolDisallowlist(
  params: {
    automationId?: string;
    offPeakTaskId?: string;
    inputId?: string;
    toolDenylist?: readonly string[];
  },
  activeAutomationId = params.automationId,
  activeOffPeakTaskId = params.offPeakTaskId,
): readonly string[] | undefined {
  const tools = new Set(params.toolDenylist ?? []);
  if (activeAutomationId) tools.add("CronCreate");
  // 闲时派发轮隐藏 OffPeakCreate（防递归自我派生）；OffPeakList 只读保留。
  // 注意 automation 轮不加 OffPeakCreate——cron 轮放行（定时派生闲时任务）。
  // SendMessage / Workflow 同样隐藏，与 V4 prompt-turn 及 core turn-loop-state 同值。
  if (activeOffPeakTaskId) {
    for (const toolName of OFF_PEAK_EXECUTION_TOOL_DENYLIST) tools.add(toolName);
  }
  return tools.size > 0 ? [...tools] : undefined;
}

// [失败路径] automation 归属有两条来源：显式 automationId（V4 派发）与 inputId 前缀
// （旧 session/send 兜底）。后者用第一个 ":" 之前的部分作为 id，因为 runId 形如
// `automation-<uuid>:<step>`；用 lastIndexOf 会把 uuid 里的分隔符也吃进来。
// [权衡] 解析不出 id 时返回 undefined 而不是抛错：偶发一次归属丢失的后果只是本轮
// 少禁一个工具，而抛错会让用户的输入整条发不出去。
function resolvePromptTurnAutomationId(params: {
  automationId?: string;
  inputId?: string;
}): string | undefined {
  const explicit = params.automationId?.trim();
  if (explicit) return explicit;
  const inputId = params.inputId?.trim();
  if (!inputId?.startsWith("automation-")) return undefined;
  const separatorIndex = inputId.indexOf(":");
  const automationId = separatorIndex >= 0 ? inputId.slice(0, separatorIndex) : inputId;
  return automationId.length > "automation-".length ? automationId : undefined;
}

// [失败路径] 与 automation 同构，但 offpeak 的 inputId 首段不带固定前缀语义（见下方
// 注释：`offpeak-<uuid>:resume:<uuid>` 的首段是 traceId），因此显式 offPeakTaskId
// 永远是主信号，前缀解析只是兜底。
function resolvePromptTurnOffPeakTaskId(params: {
  offPeakTaskId?: string;
  inputId?: string;
}): string | undefined {
  const explicit = params.offPeakTaskId?.trim();
  if (explicit) return explicit;
  // 兜底：续跑派发的 inputId 形如 `offpeak-<uuid>:resume:<uuid>`（首段 traceId 无固定前缀，
  // 主信号必须是显式 offPeakTaskId）。
  const inputId = params.inputId?.trim();
  if (!inputId?.startsWith("offpeak-")) return undefined;
  const separatorIndex = inputId.indexOf(":");
  const offPeakTaskId = separatorIndex >= 0 ? inputId.slice(0, separatorIndex) : inputId;
  return offPeakTaskId.length > "offpeak-".length ? offPeakTaskId : undefined;
}

async function continueGoalAfterChange(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    inputId?: string;
    reason: string;
    target: ProtocolGoalTarget;
    title: string;
  },
) {
  const response = formatGoalChanged(params.title, params.target);
  const isPlanMode = record.app.runtime.getPlanEnabled?.() ?? record.app.getMode?.() === "plan";
  // continueActiveTarget 是 App 的必选能力；能否继续只取决于当前模式和是否已有活跃 turn。
  // [并发] canContinue 的三元条件就是"能否自动续跑"的全部判据：plan 模式下继续会
  // 立刻写文件，越过用户还没确认的计划；已有活跃 turn 时再起一个会把两条输出
  // 交错写进同一条消息。
  // [失败路径] 只有真正起跑才登记 controller 并自吞后台错误（INV-16）：没起跑时
  // 登记会让下一次输入被 409 拒绝。
  const canContinue = !isPlanMode && !record.activeAbortController;

  if (canContinue) {
    await ensureSessionModelAvailableForNextTurn(context, record);
    const abortController = new AbortController();
    record.activeAbortController = abortController;
    void runWithSessionResidencyFinalization(record, () =>
      runGoalContinuationInBackground(context, record, {
        abortController,
        inputId: params.inputId,
      }),
    ).catch(() => {
      // 后台 goal continuation 的失败会通过状态/事件流降级上报；这里兜底防 unhandled rejection。
    });
  }

  const snapshotAfterGoal = await afterStateMutation(context, record, params.reason);
  return {
    response: isPlanMode ? appendPlanModeGoalContinuationNote(response) : response,
    snapshot: snapshotAfterGoal,
    startedTurn: canContinue,
  };
}

async function runGoalContinuationInBackground(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    abortController: AbortController;
    inputId?: string;
  },
): Promise<void> {
  let mutationReason = "goal_continuation_completed";
  try {
    await record.app.continueActiveTarget?.({
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
    });
  } catch {
    mutationReason = "goal_continuation_failed";
  // [事务] 先释放锁再广播（与 prompt 路径同构）：连续 `/goal` 在 ready 边界立即
  // 重入，锁若晚一步释放，第二次命令会被误判为"已有活跃 turn"而不起跑。
  // [失败路径] 续跑失败不抛给调用方：/goal 的响应已经返回，失败只能通过
  // goal_continuation_failed 的 mutationReason 让 UI 解释（见上）。
  } finally {
    if (record.activeAbortController === params.abortController) {
      // 续跑本身结束后应立刻释放活跃锁；snapshot/command discovery 只是后续广播，
      // 如果继续占锁，连续 `/goal` 会被误判为已有活跃 turn。
      record.activeAbortController = undefined;
    }
  }
  await afterStateMutation(context, record, mutationReason);
}

// session/stop 的终止边界是 activeAbortController；同时把 active goal 置为 paused，
// 让 goal verifier 与队列都能感知停止并完成 drain。
// [事务] 停止的幂等性由 activeAbortController 是否存在决定：重复 stop 是 no-op，
// 不产生第二次 state.updated——否则客户端会看到一次"已停止"的重复提示。
export async function stopSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionStopParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  const hadActivePrompt = Boolean(record.activeAbortController);
  let pausedTarget: ProtocolGoalTarget | null = null;
  context.logger?.info("ZCode Protocol session/stop received", {
    hadActivePrompt,
    sessionId: params.sessionId,
    workspacePath: record.workspace.workspacePath,
  });
  // [事务] 顺序固定为 读目标 → 置 paused → abort（INV-22）：先 abort 再置 paused
  // 时，verifier 可能在 abort 回调里先跑完一轮并写回 active，把 paused 覆盖掉。
  // 只有真正存在活跃 prompt 才尝试暂停（hadActivePrompt）：空闲时 stop 不应改动
  // 一个用户手动暂停/未开始的目标状态。
  if (hadActivePrompt) {
    pausedTarget = await pauseActiveGoalForSessionStop(context, record, {
      sessionId: params.sessionId,
    });
  }
  record.activeAbortController?.abort(new Error("ZCode Protocol session stopped"));
  if (pausedTarget) {
    await afterStateMutation(context, record, "session_stop_goal_paused");
  }
  return {};
}

async function pauseActiveGoalForSessionStop(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: { sessionId: string },
): Promise<ProtocolGoalTarget | null> {
  if (!record.app.readTarget || !record.app.updateTargetStatus) {
    return null;
  }
  const target = await record.app.readTarget();
  if (!target || target.status !== "active") {
    return null;
  }

  // [失败路径] 暂停失败只 warn 并返回 null：stop 的主语义是"停下当前输出"，
  // 目标状态只是附带修复；为它抛错会让用户的 stop 请求整体失败，反而停不下来。
  // [事务] 返回值决定是否广播 state.updated（见上）：没暂停成功就不该产生一次
  // 无变化的快照推送。
  try {
    // Stop 只 abort controller 时，goal verifier 若没及时收到 abort，
    // 会在队列仍持有 stopRequested 的情况下保留 active goal，导致后续队列无法 drain。
    const pausedTarget = await record.app.updateTargetStatus("paused");
    if (pausedTarget) {
      context.logger?.info("ZCode Protocol session/stop paused active goal", {
        sessionId: params.sessionId,
        targetId: pausedTarget.targetID,
        workspacePath: record.workspace.workspacePath,
      });
    }
    return pausedTarget;
  } catch (error) {
    context.logger?.warn("ZCode Protocol session/stop failed to pause active goal", {
      error: error instanceof Error ? error.message : String(error),
      sessionId: params.sessionId,
      targetId: target.targetID,
      workspacePath: record.workspace.workspacePath,
    });
    return null;
  }
}

export async function cancelBackgroundTask(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeSessionCancelBackgroundTaskParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  context.logger?.info("ZCode Protocol session/cancelBackgroundTask received", {
    sessionId: params.sessionId,
    taskId: params.taskId,
    workspacePath: record.workspace.workspacePath,
  });

  // [失败路径] 能力缺失时抛 -32031 并带 taskId：客户端据此把"取消"按钮灰掉，
  // 而不是以为网络失败反复重试。
  // [事务] 取消成功后必须走 afterStateMutation：后台 bash 的取消不产生 turn 终态，
  // 不发 state.updated 的话手机端要等下一次轮询才看到任务消失（见下方注释）。
  if (!record.app.cancelBackgroundTask) {
    throw new ProtocolRequestError(
      -32031,
      "Background task cancellation is not supported by this session runtime",
      {
        sessionId: params.sessionId,
        taskId: params.taskId,
      },
    );
  }

  const result = await record.app.cancelBackgroundTask(params.taskId);
  // 后台 bash 取消是运行态变更，不会经过普通 prompt 终态。
  // 取消后立即发 state.updated，让桌面 continuous 和手机 replayable 都通过各自 snapshot 边界刷新投影。
  await afterStateMutation(context, record, "background_task_cancelled");
  return result;
}

// 模型/思考档位/模式三个 setter 共用模式：校验 session revision，变更 runtime，
// 再由 afterStateMutation 广播最新快照。
// [并发] 三个 setter 都先 assertExpectedRevision 再改 runtime：乐观并发只挡"陈旧
// 快照"，挡不住 runtime 内部已失败，因此真正的原子性靠 setModel 内的共享 setter
// （它会同时校验并保存 reasoning，避免"模型换了、档位还是旧的"）。
// [事务] mutationReason 三种取值是给 UI 区分动画与提示的：model_changed 会重排
// 模型徽标，thought_level_changed 只更新档位，mode_changed 可能整体切换面板布局。
export async function setModel(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionSetModelParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  await runSessionModelConfigMutation(record.app, async () => {
    // 完整 Session 配置命令不能经身份字符串丢掉 reasoning；由共享 setter 原子校验/保存。
    await record.app.setModel(params.model);
  });
  return await afterStateMutation(context, record, "model_changed");
}

export async function setThoughtLevel(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeSessionSetThoughtLevelParamsSchema, rawParams);
  // [失败路径] 空 thoughtLevel 用 -32602（invalid params）而不是 -32010：这是参数
  // 结构错误而非会话状态错误，客户端应据此修正请求而不是提示"会话不可用"。
  if (!params.thoughtLevel) {
    throw new ProtocolRequestError(-32602, "thoughtLevel is required");
  }
  const thoughtLevel = params.thoughtLevel;
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  await runSessionModelConfigMutation(record.app, async () => {
    await record.app.setThoughtLevel(thoughtLevel);
  });
  return await afterStateMutation(context, record, "thought_level_changed");
}

export async function setMode(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionSetModeParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  await record.app.setMode(params.mode);
  return await afterStateMutation(context, record, "mode_changed");
}

// 条件关闭：expectedPersistence 与 record 当前值不匹配时返回 closed:false；
// 关闭只释放运行态与订阅，不删除持久化行。
export async function closeSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionCloseParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  // [事务] 条件关闭是"跨端竞态"的闸门（INV-23/24）：send 会先把 deferred 提升为
  // immediate，关闭必须基于 Agent record 做原子判断，不能信 renderer 的旧快照
  // （见下方注释）。返回 closed:false 而不是报错，让调用方自己决定是否重试。
  if (!shouldCloseSessionForExpectedPersistence(record.persistence, params.expectedPersistence)) {
    // 连接切换与跨端首发可能并发。session/send 会先把 deferred 提升为
    // immediate；条件关闭必须在 Agent record 上原子判断，不能依赖 renderer 的旧快照。
    return { closed: false };
  }
  record.unsubscribe?.();
  // 会话关闭时 abort 仍在进行的插件 UI 工具调用，登记表不留孤儿。
  abortMcpUiToolCallsForSession(params.sessionId);
  // App-Provided Tools：结束本会话全部待执行的页面调用并丢弃登记。
  clearMcpUiAppToolsForSession(context, params.sessionId);
  // 清掉本会话全部资源订阅（refcount 归零的 uri 才真正向 server 退订）。
  await record.app.unsubscribeMcpResourcesForUi?.(`${params.sessionId}|`).catch(() => 0);
  await record.app.close?.();
  // v4 通道（M3）：会话关闭同时清 publisher / 订阅调度；重开会话走 snapshot 冷启动。
  // 关闭运行实例不删除持久化事实，因此必须保留 sessions-index 中的行。
  context.v4Gateway?.disposeSession(params.sessionId);
  context.sessions.delete(params.sessionId);
  // 内存 event store 随 record 释放。
  await record.eventStore.deleteSession(params.sessionId as SessionId);
  return { closed: true };
}

// [事务] 关闭是"按期望持久化状态"的条件操作：expectedPersistence 让调用方能表达
// "只关草稿"或"只关已持久化"，从而在连接切换的竞态里避免把刚提升为 immediate 的
// 会话误关（INV-23/24）。
export function shouldCloseSessionForExpectedPersistence(
  currentPersistence: ZCodeSessionPersistence,
  expectedPersistence?: ZCodeSessionPersistence,
): boolean {
  return expectedPersistence === undefined || currentPersistence === expectedPersistence;
}

// 无会话绑定的工作区文本生成：优先复用同 workspace 的活跃 app，否则临时创建
// 一个 app 在 finally 中关闭，避免为一次性请求长期驻留 runtime。
// [事务] 三条路径必须对齐：直接新建 app、复用活跃 app、以及 finally 中的条件 close。
// 任何一条漏掉，要么泄漏 sqlite 句柄，要么把用户正在用的会话关掉。
// [失败路径] 生成失败时也要 close 临时 app：异常路径里 finally 依然执行，这正是
// 用 try/finally 而不是"成功后再 close"的原因。
export async function generateWorkspaceText(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
) {
  const params = parseParams(zcodeWorkspaceGenerateTextParamsSchema, rawParams);
  // [资源] 优先复用同 workspace 的活跃 app（见下方 3436 行注释）：new 一个 app 会
  // 重新加载 provider registry 与 MCP 连接，一次标题/润色请求的延迟从几十毫秒变成
  // 数秒，还会在日志里留下一条"虚惊一场"的连接失败。
  // [失败路径] 复用到的 app 绝不 close（finally 里以 active 判定）：它属于某个真实
  // 会话，关掉会让用户的对话在下一次输入时失去上下文。
  const active = Array.from(context.sessions.values()).find(
    (record) => record.workspace.workspaceKey === params.workspace.workspaceKey,
  );
  const input = {
    selection: params.selection,
    ...(params.prompt ? { prompt: params.prompt } : {}),
    ...(params.messages ? { messages: params.messages } : {}),
    ...(params.tools
      ? {
          tools: params.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        }
      : {}),
    querySource: params.querySource,
    ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
  };
  const app =
    active?.app ??
    (await createWorkspaceZCodeApp(context, params.workspace, {
      env: context.deps.env,
      eventStore: context.deps.createSessionEventStore("workspace-generate-text"),
      runtimeConfig: {
        workingDirectory: params.workspace.workspacePath,
      },
      sessionStore: context.deps.sessionStore,
      version: context.deps.version,
    }));

  // [资源] 临时 app 必须在 finally 里 close：它是为了这一次 generate 造出来的，
  // 持有 eventStore 句柄与子进程；漏关会在批量生成（例如批量重命名）时线性累积
  // 文件描述符。
  // [失败路径] close 用可选调用（app.close?.）：workspace app 的构造契约允许实现
  // 不提供 close，缺少它时不能让一个已经成功的生成结果变成失败。
  try {
    const result = await app.generateWorkspaceText(input, { abortSignal });
    return {
      text: result.text,
      selection: result.selection,
      finishReason: result.finishReason,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
    };
  } finally {
    if (!active) {
      await app.close?.();
    }
  }
}

// [并发] 统一用 -32010（会话忙）而不是各自定义错误码：客户端只有一套"稍后重试 +
// 显示停止按钮"的交互，错误码分散会让它无法统一处理。
// [权衡] 判据仍取 record.activeAbortController，而不是 runtime 的 turn 状态：
// 与 send 路径保持同一个真相源，避免"send 说有活跃、fork 说没有"（INV-15）。
function ensureNoActiveTurn(record: ZCodeProtocolSessionRecord, message: string): void {
  if (!record.activeAbortController) {
    return;
  }
  throw new ProtocolRequestError(-32010, message);
}

function appendPlanModeGoalContinuationNote(response: string): string {
  return `${response}\n\n${PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE}`;
}

// [权衡] 用自然语言拼装而不是返回结构化目标：这些字符串会直接作为斜杠命令的
// 回显出现在对话流里，结构化目标需要客户端再渲染一次，反而多一份不一致的风险。
// [失败路径] 无目标时返回引导语而不是空串：空回显会让用户以为命令没生效。
function formatGoalSummary(target: ProtocolGoalTarget | null): string {
  if (!target) {
    return "No goal is set. Use /goal <objective> to set one.";
  }

  return formatGoalChanged(`Goal ${target.status}`, target);
}

function formatGoalChanged(title: string, target: ProtocolGoalTarget): string {
  const lines = [title, `Objective: ${target.objective}`];
  if (target.tokensUsed !== undefined || target.tokenBudget !== undefined) {
    const budget =
      target.tokenBudget === null || target.tokenBudget === undefined
        ? "none"
        : target.tokenBudget.toString();
    lines.push(`Usage: ${target.tokensUsed ?? 0} tokens / ${budget}`);
  }
  if (target.timeUsedSeconds !== undefined) {
    lines.push(`Time: ${target.timeUsedSeconds} seconds`);
  }
  return lines.join("\n");
}

function assertExpectedProviderRevision(
  _context: ZCodeProtocolAgentServerContext,
  _record: ZCodeProtocolSessionRecord,
  expectedProviderRevision: string | undefined,
): void {
  // 兼容旧客户端字段。Provider revision 已由进程 Registry 自己管理，不再接受 Host CAS。
  void expectedProviderRevision;
}

// 发送/继续前确保当前模型仍可用；发生 fallback 时递增 revision，让客户端刷新选择。
// [失败路径] fallback 发生时必须 bump stateRevision（见下）：客户端缓存的 model
// 已失效，不递增它会让客户端的乐观并发以为自己还是最新的，继续用旧模型发请求。
// [并发] 这里不做"模型可用就返回"以外的副作用：真正的切换发生在 runtime 内部，
// 协议层只负责让 revision 与视图跟上。
export async function ensureSessionModelAvailableForNextTurn(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<void> {
  if (await ensureSessionModelAvailable(context, record)) {
    record.stateRevision++;
  }
}

// [权衡] 四种历史目标在这里收敛成 core 的两种寻址方式（checkpointId / messageId）：
// latestCheckpoint 返回空对象表示"从最新 checkpoint 复制"，交给 core 决定；其余
// 三种都必须解析出具体锚点，否则 fork 会退化成整段复制。
// [失败路径] turnIndex 解析失败抛 sessionUnavailable：静默回落到 latest 会让用户
// 以为 fork 的是某一轮，实际拿到的是全会话。
async function resolveForkTarget(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  target: ZCodeSessionHistoryTarget,
): Promise<{ targetCheckpointId?: string; targetMessageId?: string }> {
  if (target.kind === "latestCheckpoint") {
    return {};
  }
  if (target.kind === "checkpoint") {
    return { targetCheckpointId: target.checkpointId };
  }
  if (target.kind === "message") {
    return { targetMessageId: target.messageId };
  }
  return {
    targetMessageId: await resolveTurnMessageId(context, record, target.turnIndex, "assistant"),
  };
}

// [事务] 轮次计数只由 user 消息推进（currentTurn += 1），assistant 只记录"当前轮
// 最后一条"：这样 synthetic user（compact summary / fork notice）会被当成新一轮，
// 与 UI 里看到的轮次划分一致。
// [失败路径] 找到目标轮的 assistant 后立即返回而不是扫描到底（见下方注释）：否则
// 只要目标轮之后还有 user，target 就会被清空，"只有最后一轮能 fork"。
async function resolveTurnMessageId(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  turnIndex: number,
  role: "assistant" | "user",
): Promise<MessageId> {
  const messages = (await readActiveSessionMessages(context, record)).filter(
    isUserVisibleSessionMessage,
  );
  let currentTurn = -1;
  let lastAssistantForTargetTurn: MessageId | undefined;
  for (const message of messages) {
    if (message.info.role === "user") {
      if (role === "assistant" && currentTurn === turnIndex && lastAssistantForTargetTurn) {
        // fork/rewind 的 legacy turn target 是“目标轮次的 assistant”，
        // 不是“扫描到历史末尾时仍然处于目标轮次”。遇到下一条 user 就清空已找到的
        // assistant，导致只有最后一轮能 fork；compact summary 和 fork notice 这类 synthetic
        // user 又会把最后一轮变成非最后一轮。离开目标轮次前直接返回稳定目标。
        return lastAssistantForTargetTurn;
      }
      currentTurn += 1;
      if (role === "user" && currentTurn === turnIndex) {
        return message.info.id as MessageId;
      }
      continue;
    }
    if (message.info.role === "assistant" && currentTurn === turnIndex) {
      lastAssistantForTargetTurn = message.info.id as MessageId;
    }
  }
  if (role === "assistant" && lastAssistantForTargetTurn) {
    return lastAssistantForTargetTurn;
  }
  throw new ProtocolRequestError(
    zcodeProtocolErrorCodes.sessionUnavailable,
    `Cannot resolve ${role} message for turnIndex=${turnIndex}`,
  );
}

// 单 session token 用量读面；无 usage store 时返回零值结构，保持 schema 可解析。
// [失败路径] 无 usage store 时返回全零结构（INV-31）：schema 必须始终可解析，
// 否则设置页的用量卡片会因为一个可选依赖缺失而整块白屏。
// [权衡] 逐字段拷贝而不是直接返回 usage：返回值要经 JSON-RPC 序列化，直接透传
// 内部对象会把 store 私有字段（例如 sqlite 行版本）也带给客户端。
export async function getTaskTokenUsage(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeTaskTokenUsageParamsSchema, rawParams ?? {});
  const usageStore = context.deps.sessionStore as Partial<UsageStorePort> | undefined;
  if (!usageStore?.queryTaskUsage) {
    return {
      sessionId: params.sessionId,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
      inputBaselineBySource: {},
    };
  }

  const usage = await usageStore.queryTaskUsage({
    sessionID: params.sessionId as SessionId,
  });
  return {
    sessionId: params.sessionId,
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    modelRequestCount: usage.modelRequestCount,
    modelErrorCount: usage.modelErrorCount,
    inputBaselineBySource: usage.inputBaselineBySource,
  };
}

/**
 * 纯配置事件集合：只改变会话选型（模型/协作模式），不代表用户消息活动。
 * 这些事件不 bump record.updatedAt（= sessions-index lastActivityAt），
 * 避免配置操作驱动侧栏列表按活动时间重排。
 * - ModelSelected / SessionModeChanged：纯配置变更（切模型/切模式）。
 * - FollowupModeChanged：打开会话会自动同步 queue/guide 偏好；这是配置，不应刷新历史活动时间。
 * - SessionTitleUpdated：标题是会话元数据；冷恢复会为了 v4 投影补发标题事件，
 *   不能因此把历史任务当成刚活动过并顶到列表最前。
 * - SessionResumed：打开/恢复会话是读取，不是活动。冷恢复路径刚把
 *   record.updatedAt 回填成 store 的真实时间（见 resumeSession op 内说明），
 *   若再被 resume 事件冲成 Date.now()，点开/刷新任务就会被顶到列表最前并整列重排。
 * - WorkspaceHookAdmissionUpdated：冷恢复重新评估工作区 hook 准入状态，不代表用户活动；
 *   若漏掉黑名单，SessionResumed 后的准入状态事件会把历史任务显示为“刚刚”。
 * - HookRun*：hook lifecycle 是 turn/session 的内部执行细节；正常 turn 已有消息、工具等
 *   活动事件负责更新时间，冷恢复的 SessionStart hook 不能单独制造一次用户活动。
 */
// [权衡] 用"黑名单事件类型"而不是"白名单活动事件"：新增业务事件默认会被当作活动，
// 这符合大多数场景（用户确实做了操作）；只有确认为元数据/生命周期的事件才进黑名单。
// 反过来做则每新增一个真实活动事件都要回来登记，漏登记就是"消息来了但列表不动"。
// [并发] 判定纯函数、无副作用：调用点在 3700 行左右用它决定是否 bump updatedAt，
// 这样"是否活动"的策略与"如何更新"解耦，单测可以只测这个函数。
function isNonActivitySessionEvent(event: SessionEvent): boolean {
  return (
    event.type === SessionEventType.ModelSelected ||
    event.type === SessionEventType.SessionModeChanged ||
    event.type === SessionEventType.FollowupModeChanged ||
    event.type === SessionEventType.SessionTitleUpdated ||
    event.type === SessionEventType.SessionResumed ||
    event.type === SessionEventType.WorkspaceHookAdmissionUpdated ||
    event.type === SessionEventType.HookRunStarted ||
    event.type === SessionEventType.HookRunProgress ||
    event.type === SessionEventType.HookRunCompleted ||
    event.type === SessionEventType.HookRunFailed ||
    event.type === SessionEventType.HookRunBlocked
  );
}

/**
 * `record.persistence` 是 runtime「会话已持久化」事实的协议侧镜像：deferred = draft（不进 session/list、
 * 不进 sessions-index、可被 expectedPersistence="deferred" 的条件关闭收回）。首发路径在 accepted 时刻
 * 抢先提升（关闭竞态需要原子判断，见 startPromptTurn / admission），但**任何**经 runtime 首次持久化的
 * 路径都必须让会话离开 draft——中枢直接启动的会话由 runtime 落行、走 controlOnly
 * 启动轮，没有首发，record 一直是 deferred，sessions-index 视其为 draft 而跳过，侧栏永远不出现。
 * 于是在事件流的唯一入口按 runtime 事实对齐一次：持久化之后 runtime 必定至少发一条事件
 * （SessionTitleUpdated first_input），紧随其后的 ingest 便把会话推进 sessions-index。
 * 测试桩的 runtime 可能没有这个方法（`as never`），缺席即不对齐。
 */
// [失败路径] 测试桩 runtime 可能没有 isSessionPersisted（类型上标为 never），
// 因此用可选调用并只在 === true 时推进：缺少能力时保持 deferred，宁可晚一步
// 出现在列表里，也不能凭猜测把草稿会话写进 sessions-index。
// [事务] 只允许 deferred → immediate（INV-23），不提供反向；这是一条单向闸门，
// 保证任何"曾经落库"的会话不会重新变回 draft。
function reconcileRecordPersistence(record: ZCodeProtocolSessionRecord): void {
  if (record.persistence !== "deferred") return;
  if (record.app.runtime?.isSessionPersisted?.() === true) record.persistence = "immediate";
}

// runtime 事件的唯一协议入口：先路由 detached child 与对齐活动时间，再无条件喂
// v4 投影；最后按 legacy deliveryKind 决定是否发送，streaming delta 在此按确定性
// 预算合并，避免高频小包唤醒 renderer。
export function onSessionEvent(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
): void {
  const computerUseOperationEvent = mapComputerUseOperationEvent(event);
  if (computerUseOperationEvent) {
    try {
      // 桌面 v4 主链没有旧 session/event 的 deliveryKind 订阅，顶部提示不能继续
      // 依赖该旧门控；这里只发送无内容的生命周期元数据，并与 v4 投影并行、互不阻断。
      context.notify({
        method: zcodeProtocolMethods.computerUseOperationEvent,
        params: computerUseOperationEvent,
      });
      // 这条 notify 过去只在抛错时有日志，成功路径无痕，于是「agent 压根没发」
      // 与「发了但宿主侧静默丢弃」无法区分。CLI 自己的 jsonl 收 debug 级，足够闭环到源头。
      context.logger?.debug("Computer Use operation lifecycle notification sent", {
        event: "zcode_protocol.computer-use.operation-event.sent",
        eventId: computerUseOperationEvent.eventId,
        sessionId: computerUseOperationEvent.sessionId,
        kind: computerUseOperationEvent.kind,
        turnId:
          "turnId" in computerUseOperationEvent ? computerUseOperationEvent.turnId : undefined,
      });
    } catch (error) {
      context.logger?.warn("Computer Use operation lifecycle notification failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.computer-use.operation-event.failed",
        eventId: computerUseOperationEvent.eventId,
        sessionId: computerUseOperationEvent.sessionId,
        turnId:
          "turnId" in computerUseOperationEvent ? computerUseOperationEvent.turnId : undefined,
      });
    }
  }
  // [并发] detached child 先路由再返回（INV-26）：subagent 复用父级的 event sink，
  // 事件却属于 child session。先 ingest 到 child topic 再 return，父级镜像事件会在
  // 下一次以 parent sessionId 进来，走正常链路。
  if (String(event.sessionId) !== record.app.sessionId) {
    // subagent runtime 复用父 runtime 的外部 event sink，但 raw child event
    // 仍属于 child session。无条件用 parent record id ingest 会让 child topic 打开后
    // 不再更新，同时还可能错误 bump 父任务活动时间。这里必须先按事件自己的 sessionId
    // 路由并返回；parent mirror event 本身使用 parent sessionId，继续走下方既有链路。
    context.v4Gateway?.ingestDetachedLiveSession(
      String(event.sessionId),
      event,
      record.app.sessionId,
    );
    return;
  }
  // record.updatedAt 是 sessions-index 的 lastActivityAt 事实源（v4-bridge
  // getSessionIndexMeta），UI 侧栏按它排序。纯配置/恢复/标题元数据事件不是用户会话活动，
  // 之前无差别 bump 会让"切一次模型/点开任务"把任务顶到列表最前并触发整表重排。
  // core 已在发布终态前持久化结果；列表复用同一事实，不从裁剪正文窗口猜测结果。
  // [事务] lastOutcome 的三态由 TurnError 与 resultType=cancelled 共同决定：
  // "interrupted" 必须区别于 "error"，列表与通知文案据此区分"用户主动停"和"执行失败"。
  // [失败路径] payload 缺 resultType 时归为 completed 而不是抛错：终态事件已经发生，
  // 缺字段只是上报不全，不应让事件处理中断。
  if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
    const payload = event.payload as { resultType?: string };
    record.lastOutcome =
      event.type === SessionEventType.TurnError
        ? "error"
        : payload.resultType === "cancelled"
          ? "interrupted"
          : "completed";
  }
  const nonActivityEvent = isNonActivitySessionEvent(event);
  if (event.type === SessionEventType.ModelSelected) {
    // 恢复候选只服务初始 UI；用户新选择生效后不能在后续清空时被旧候选复活。
    delete record.restoredModelSelection;
  }
  if (!nonActivityEvent) {
    record.updatedAt = Date.now();
  }
  reconcileRecordPersistence(record);
  // 调试旁路不依赖聊天订阅；放在 deliveryKind 判断之前，避免旧订阅退出后诊断再次断流。
  observeSessionDebug(record, event);
  // v4 通道：权威事件无条件喂给 v4 投影/发布器——v4 订阅不依赖旧协议的
  // deliveryKind 订阅态，帧节奏由 gateway 按订阅者 profile 自行调度。
  context.v4Gateway?.ingest(record.app.sessionId, event);
  // [事务] 顺序不可交换：先 observeSessionDebug（不依赖订阅），再 ingest v4（权威），
  // 最后才按 deliveryKind 走 legacy（INV-27）。把 v4 ingest 放到门控之后就复现了
  // "旧订阅退出 ⇒ 诊断与 v4 投影一起断流"的历史故障。
  // [并发] deltaInfo 为真时走批处理并 return，绝不同时发一条原始 delta：双发会让
  // 客户端把同一段文本追加两次（下方 reset/send 分支只处理非 delta 事件）。
  if (!record.deliveryKind) return;
  const deltaInfo = readStreamingDeltaBatchableEvent(event);
  if (deltaInfo && !shouldHideProtocolSessionEvent(record, event)) {
    // [事务] 换 batchKey 前必须先冲刷旧批次：否则新内容会覆盖旧 batch，用户丢掉
    // 最后一段尚未出包的文本（这段文本在界面上表现为"光标停了但没字"）。
    // [失败路径] 被隐藏的事件不参与批处理（shouldHideProtocolSessionEvent）：
    // 标题模型的 delta 混进来会打断主对话的批，产生一次无意义的提前出包。
    const batchState = getLiveProtocolStreamingDeltaBatchState(record, record.deliveryKind);
    if (batchState.batch && batchState.batch.batchKey !== deltaInfo.batchKey) {
      flushLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
    }
    batchState.batch = mergeProtocolStreamingDeltaBatch(batchState.batch, event, deltaInfo);
    // [并发] 首帧标记必须在 flush 之后再 add：先 add 后 flush 的话，flush 抛错时
    // 该 batchKey 已被标记为"首帧已发"，后续 delta 会全部走节流窗口，用户看到
    // 一段明显的空白停顿（下方 3818 行的注释描述同一现象）。
    if (
      deltaInfo.shouldFlushFirstDelta &&
      !batchState.flushedFirstDeltaBatchKeys.has(deltaInfo.batchKey)
    ) {
      flushLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
      batchState.flushedFirstDeltaBatchKeys.add(deltaInfo.batchKey);
      return;
    }
    if (
      batchState.batch.delta.length >= batchState.batch.maxChars ||
      shouldFlushProtocolStreamingDeltaBatchForInterval(
        batchState.batch,
        batchState.lastFlushAtByBatchKey,
      )
    ) {
      flushLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
    }
    return;
  }

  // [事务] 非流式事件会打断连续 delta，因此先 reset 再发：reset 内含一次 flush，
  // 保证"先到的半句文本"严格排在这条事件之前，客户端不会看到工具调用先于它的
  // 触发文本出现。
  resetLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
  sendProtocolSessionEvent(context, record, event, record.deliveryKind);
}

function flushLiveProtocolStreamingDeltaBatch(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): void {
  const batchState = getLiveProtocolStreamingDeltaBatchState(record, deliveryKind);
  if (!batchState.batch) {
    return;
  }
  // [并发] 先记 flush 时间再清 batch（顺序与注释相反是安全的）：remember 用的是
  // batch 自带的 updatedAtMs，清空后再记就拿不到了；而 materialize 与清空之间
  // 没有 await，不存在"半清空"的中间态。
  // [事务] materialize 结果必须与 batch 一起原子地"取出并清空"，否则同一批 delta
  // 会被 flush 两次（例如 reset 与首次 flush 在同一次调用栈里前后触发）。
  rememberProtocolStreamingDeltaBatchFlush(batchState.lastFlushAtByBatchKey, batchState.batch);
  const event = materializeProtocolStreamingDeltaBatch(batchState.batch);
  batchState.batch = undefined;
  // 性能修复：provider 会把 Write/Edit input 和 reasoning/text 输出切成大量很小的 delta。
  // 在 protocol 边界按确定性字节预算合并相邻 diff，renderer 仍按 delta 追加，但不再被每个小包唤醒。
  // 文本体感用 SessionEvent.timestamp 做低频 flush，不能用 live setTimeout，否则 replay 无法复现边界。
  sendProtocolSessionEvent(context, record, event, deliveryKind);
}

// [事务] reset 的语义是"结束一个逻辑段"：必须 flush 未出包的内容，并清空两个
// 时间/首帧表，让下一段重新享受"首帧立即发"的待遇。
// [失败路径] 只清 batch 不清 lastFlushAtByBatchKey，会让下一段的第一帧按上一段的
// 旧时间戳计算间隔，若间隔足够大就直接进节流窗口，首字延迟可感知。
function resetLiveProtocolStreamingDeltaBatch(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): void {
  const batchState = getLiveProtocolStreamingDeltaBatchState(record, deliveryKind);
  flushLiveProtocolStreamingDeltaBatch(context, record, deliveryKind);
  batchState.flushedFirstDeltaBatchKeys.clear();
  batchState.lastFlushAtByBatchKey.clear();
}

// [事务] 唯一的出口：所有 legacy 事件都必须经这里投影 + notify + 记日志，
// 不允许任何分支直接 context.notify("session/event")。绕过它就会跳过 seq 分配与
// tool input 去重，客户端看到的序列会出现空洞或重复。
// [失败路径] mapProtocolSessionEvent 返回 undefined 表示"按规则不应发送"，直接
// 返回而不是发空壳：空壳会让客户端的 seq 游标前进但没有内容可渲染。
function sendProtocolSessionEvent(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
): void {
  const mappedEvent = mapProtocolSessionEvent(context, record, event, deliveryKind);
  if (!mappedEvent) return;
  context.notify({
    method: "session/event",
    params: mappedEvent,
  });
  logProtocolSessionEventSent(context, event, mappedEvent);
}

// [权衡] 只透传"用户在设置里显式选过的 shell"，auto 一律返回 undefined 交给
// 探测逻辑：把 auto 解释成某个具体 shell 会让 Windows 用户在没装 Git Bash 时
// 收到一条"路径不存在"，而实际上应该回落到 PowerShell。
// [失败路径] 未知 dialect 按 CMD 显示（三元表达式），只在 display.name 层面：
// 执行时仍用真实 id/path，显示名错了不会影响实际行为。
function integratedTerminalShellToExecutionSelection(
  selection: IntegratedTerminalShellSelection | undefined,
): ExecutionShellSelection | undefined {
  if (!selection || selection.mode === "auto") {
    return undefined;
  }
  return {
    display: {
      name: selection.dialect === "git-bash" ? "Git Bash" : "CMD",
    },
    dialect: selection.dialect,
    id: selection.id,
    label: selection.label,
    path: selection.path,
    source: "user-config",
  };
}

function resolveProtocolBashShellSelection(
  context: ZCodeProtocolAgentServerContext,
  selection: IntegratedTerminalShellSelection | undefined,
): ExecutionShellSelection {
  const configuredSelection = integratedTerminalShellToExecutionSelection(selection);
  return resolveEffectiveBashShellSelection({
    env: context.deps.env ?? process.env,
    override: configuredSelection,
    platform: context.deps.platform ?? process.platform,
  }).selection;
}

// [失败路径] -32601（方法不存在）与 -32020（不支持）走"兼容性回落"，其余错误一律
// 上抛（见 4030 行注释）：旧 Host / 纯 CLI 没有这个 RPC，回落是产品默认值；但超时
// 或序列化错误意味着 Host 存在却出了问题，降级会把真实故障伪装成"默认配置"。
// [并发] 超时用 -32022 单独记录 warn：这条日志是区分"Host 没收到/没回包"与"恢复
// 过程中其他阶段失败"的唯一线索。
// [资源] startedAt 在函数入口取一次，所有日志共用：多次读 Date.now() 会让
// request_started 与 response_received 的时长在时钟回拨时出现负数（见 Math.max）。
async function requestSessionRuntimePreferences(
  context: ZCodeProtocolAgentServerContext,
  sessionId: SessionId,
  scope: ZCodeSessionRuntimePreferencesScope,
  trace?: ZCodeProtocolTrace,
): Promise<ZCodeSessionRuntimePreferencesResult> {
  const startedAt = Date.now();
  // ZCodeProtocolTrace.traceId 是协议层的 string；LogContext 需要 branded TraceId，
  // 按本文件既有惯例断言收口，避免多处日志构造重复转换。
  const traceId = trace?.traceId as TraceId | undefined;
  context.logger?.debug("ZCode Protocol runtime preferences request started", {
    event: "zcode_protocol.runtime_preferences.request_started",
    module: "bootstrap.zcode_protocol",
    scope,
    sessionId,
    traceId,
  });
  try {
    const result = await context.requestClient(
      zcodeProtocolMethods.sessionRequestRuntimePreferences,
      { sessionId, scope },
      zcodeSessionRuntimePreferencesResultSchema,
      {
        timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
        ...(trace ? { trace } : {}),
      },
    );
    context.logger?.debug("ZCode Protocol runtime preferences response received", {
      durationMs: Math.max(0, Date.now() - startedAt),
      event: "zcode_protocol.runtime_preferences.response_received",
      module: "bootstrap.zcode_protocol",
      scope,
      sessionId,
      traceId,
    });
    return result;
  } catch (error) {
    const errorCode = error instanceof ProtocolRequestError ? error.code : undefined;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const diagnostic = {
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode,
      errorMessage,
      event: "zcode_protocol.runtime_preferences.request_failed",
      module: "bootstrap.zcode_protocol",
      scope,
      sessionId,
      traceId,
    };
    if (errorCode === -32022) {
      // 诊断：偏好请求超时发生在 runtime 注册前；记录 session/scope，区分
      // “Host 没收到/没回包”和“恢复过程中其他阶段失败”。
      context.logger?.warn("ZCode Protocol runtime preferences request timed out", diagnostic);
    } else if (errorCode !== -32601 && errorCode !== -32020) {
      context.logger?.warn("ZCode Protocol runtime preferences request failed", diagnostic);
    } else {
      context.logger?.debug(
        "ZCode Protocol runtime preferences compatibility fallback",
        diagnostic,
      );
    }
    if (error instanceof ProtocolRequestError && (error.code === -32601 || error.code === -32020)) {
      // 兼容旧 Host 或无 Host 的纯 CLI 创建路径；Memory 服从产品默认关闭，
      // 增强搜索维持原有默认开启，其他协议/传输错误仍阻止 runtime 创建。
      return {
        askUserQuestionAutoResolutionEnabled: true,
        memoryEnabled: false,
        modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
        nativeSearchEnhancementsEnabled: true,
        toolSearchMode: "off",
      };
    }
    throw error;
  }
}

// [并发] inherit 分支不发起任何 RPC：fork/subagent 必须与父会话共享同一份偏好快照，
// 重新请求会让父子在同一时刻拿到不同配置（例如 Host 刚改完 memory 开关）。
// [事务] askUserQuestion 的初始化必须先于"返回偏好"完成：runtime 在构造后立刻可能
// 发出第一次提问，晚一步应用会让首个问题用上全局默认的自动解决策略。
// [权衡] modelContextBudgetStrategy 直接取常量而不是 Host 值：该策略目前由 core
// 固定，透传一个 Host 值会让人误以为可配置，实际不会生效。
async function resolveSessionStartupPreferences(
  context: ZCodeProtocolAgentServerContext,
  sessionId: SessionId,
  source: SessionStartupPreferencesSource,
  trace?: ZCodeProtocolTrace,
): Promise<SessionStartupPreferences> {
  if (source.kind === "inherit") {
    const inheritedShellSelection = source.parent.app.runtime.getSessionShellSelection();
    return {
      memoryEnabled: source.parent.memoryEnabled,
      subagentRuntimeConfigEnabled: source.parent.subagentRuntimeConfigEnabled,
      modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
      nativeSearchEnhancementsEnabled: source.parent.nativeSearchEnhancementsEnabled,
      toolSearchMode: source.parent.toolSearchMode,
      resolveInitialBashShellSelection: async () => inheritedShellSelection,
    };
  }

  const runtimePreferences = await requestSessionRuntimePreferences(
    context,
    sessionId,
    "runtime-materialization",
    trace,
  );
  // 必须在 session runtime 可发出第一次提问前应用；关闭路径会等待已有 snooze 持久化完成。
  await context.v4Interactions.initializeAskUserQuestionAutoResolutionEnabled(
    runtimePreferences.askUserQuestionAutoResolutionEnabled,
  );
  return {
    additionalDirectories: runtimePreferences.additionalDirectories,
    subagentRuntimeConfigEnabled: runtimePreferences.subagentRuntimeConfigEnabled,
    memoryEnabled: runtimePreferences.memoryEnabled,
    modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    nativeSearchEnhancementsEnabled: runtimePreferences.nativeSearchEnhancementsEnabled,
    toolSearchMode: runtimePreferences.toolSearchMode,
    resolveInitialBashShellSelection: async () => {
      const executionPreferences = await requestSessionRuntimePreferences(
        context,
        sessionId,
        "user-execution",
        trace,
      );
      return resolveProtocolBashShellSelection(
        context,
        executionPreferences.integratedTerminalShell,
      );
    },
  };
}

// [并发] 偏好解析必须发生在 createWorkspaceZCodeApp 之前：app 构造期就会读取
// memory / toolSearch / shell 等开关并固化工具面，晚读会让首轮工具集与配置不一致。
// [失败路径] 这里不 catch：偏好请求的真实故障必须阻止 runtime 创建，否则会话会以
// "默认但错误"的能力集启动，用户后续所有轮次都受影响。
async function materializeSessionRecord(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionRecordParams,
  sessionId: SessionId,
  resume: boolean,
  source: SessionStartupPreferencesSource,
  trace?: ZCodeProtocolTrace,
): Promise<ZCodeProtocolSessionRecord> {
  const startupPreferences = await resolveSessionStartupPreferences(
    context,
    sessionId,
    source,
    trace,
  );
  return createRecord(context, params, sessionId, resume, startupPreferences, trace);
}

// [重量级] createRecord 是本文件唯一构造 runtime 的地方：workspace 解析、eventStore
// 绑定、trace 根 span、MCP 配置转换、app 构造、record 组装都在这里。
// [事务] taskType 默认 interactive，但只对"确实没有"生效：resume 路径必须显式传入
// 持久行里的 taskType，否则 workflow_child 会被当成任务列表会话（INV-06）。
// [并发] automation-port 需要读"本会话"的实时 model/mode/thought，而 record 在 app
// 之后才存在，因此用 ownSessionRecord 做惰性绑定（见下方注释）：CronCreate 在 turn
// 中调用 create() 时 record 一定已就绪，不会读到 undefined。
async function createRecord(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionRecordParams,
  sessionId: SessionId,
  resume: boolean,
  startupPreferences: SessionStartupPreferences,
  trace?: ZCodeProtocolTrace,
): Promise<ZCodeProtocolSessionRecord> {
  const workspace =
    "workspace" in params && params.workspace
      ? params.workspace
      : buildWorkspaceRef({ workspacePath: context.deps.cwd ?? process.cwd() });
  const eventStore = context.deps.createSessionEventStore(sessionId);
  const traceContext = createProtocolRootTraceContext(sessionId, trace);
  const initialModel = "model" in params ? params.model : undefined;
  const parentSessionId =
    "parentSessionId" in params && params.parentSessionId
      ? (params.parentSessionId as SessionId)
      : undefined;
  const taskType = params.taskType ?? "interactive";
  const runtimeMcp = protocolMcpServersToRuntimeMcpConfig(params.mcpServers);
  context.logger?.info("ZCode Protocol createRecord MCP config", {
    event: "zcode_protocol.create_record.mcp_config",
    rootTraceId: traceContext.traceId,
    inboundTraceId: trace?.traceId,
    paramMcpServerCount: params.mcpServers?.length ?? 0,
    runtimeHasMcpConfig: Boolean(runtimeMcp),
    runtimeMcpServerCount: Object.keys(runtimeMcp?.servers ?? {}).length,
    sessionId,
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
  });
  // automation-port 需要读取「本会话」的实时 model/mode/thought；record 在 app 之后才建。
  // 用可变持有者做惰性绑定：CronCreate 在 turn 中调用 create() 时 record 早已就绪。
  let ownSessionRecord: ZCodeProtocolSessionRecord | undefined;
  const app = await createWorkspaceZCodeApp(context, workspace, {
    env: context.deps.env,
    eventStore,
    resume,
    additionalDirectories: params.additionalDirectories ?? startupPreferences.additionalDirectories,
    runtimeConfig: {
      mode: "mode" in params ? params.mode : undefined,
      modelSelection: "model" in params ? toRuntimeModelSelection(initialModel) : undefined,
      parentSessionId,
      taskType,
      // 动态工作流灰度门（docs/dynamic-workflow/launch.md「Gray release」「On demand: activation」）：
      // 与 offPeakPort 同一套读法——本次 create/resume 参数优先，缺席时读 Host 同步到进程的
      // workspace 级结论。取值与「必须显式布尔」的理由收在 resolveDynamicWorkflowRuntimeGate。
      ...resolveDynamicWorkflowRuntimeGate(
        {
          dynamicWorkflowEnabled:
            "dynamicWorkflowEnabled" in params ? params.dynamicWorkflowEnabled : undefined,
          dynamicWorkflowMode:
            "dynamicWorkflowMode" in params ? params.dynamicWorkflowMode : undefined,
        },
        context.appRuntimePreferences,
      ),
      // 修复原因：协议侧的工具允许/拒绝列表是 session 级安全边界，必须进入 runtimeConfig，
      // 不能只依赖 prompt 文本约束，否则内置工具和动态 MCP 工具仍可能越过调用面。
      toolAllowlist: "toolAllowlist" in params ? params.toolAllowlist : undefined,
      toolDisallowlist: resolveSessionToolDenylist(params, workspace),
      nativeSearchEnhancementsEnabled: startupPreferences.nativeSearchEnhancementsEnabled,
      toolSearch: { mode: startupPreferences.toolSearchMode },
      modelContextBudgetStrategy: startupPreferences.modelContextBudgetStrategy,
      // Memory Settings 是现有 CLI features.memory/use 之外的总开关。只在关闭时
      // 写入 override，避免开启值反向覆盖用户已有的 CLI 禁用配置。
      ...(startupPreferences.memoryEnabled ? {} : { memory: { enabled: false } }),
      // desktop-continuous session/create 由 UI 先解析 ~/.zcode/.agents 的 enabled MCP，
      // 但 protocol app-server 自己不会读取 UI/main 侧的 MCP store；之前 createRecord 没把
      // params.mcpServers 注入 runtimeConfig，导致日志里 runtimeHasMcpConfig=false，工具永远不启动。
      // MCP 是 runtime 启动期配置，因此必须在 session 创建/恢复边界一次性写入 runtimeConfig.mcp。
      ...(runtimeMcp ? { mcp: runtimeMcp } : {}),
      // 之前只有 TUI 路径（tui-prompt-handler）注入 titleGeneration，
      // ZCode Protocol app-server 创建的 session（desktop/web/mobile）没有传，导致
      // shouldAttemptSessionTitleGeneration 的 `if (!config.titleGeneration) return false`
      // 永远命中，模型生成 title 的请求从不触发，侧边栏标题一直停在 first_input 的用户 query。
      // 这里补一份默认配置开启；具体是否生成仍由 runtime 按 parent/taskType/turnNumber 把关。
      // automation 执行会话显式关闭二次命名，避免回答内容覆盖原始用户 query 标题。
      titleGeneration: params.titleGenerationEnabled === false ? { enabled: false } : {},
      workingDirectory: workspace.workspacePath,
      // 身份隔离与路径执行分开：core 只把 identity 写入 session.workspace_id，
      // workingDirectory 仍是远端机器上的实际路径；本地 workspace 保持 undefined。
      workspaceIdentity: workspace.workspaceIdentity as WorkspaceId | undefined,
    },
    // ZCode Protocol app-server 以前没有注入可等待的交互 broker，
    // core 遇到 permission / AskUserQuestion 只能走默认拒绝，UI 永远收不到阻塞请求。
    // 这里把阻塞交互转换成 server-to-client JSON-RPC request，由 app 通过 response 释放 runtime。
    permissionBroker: createProtocolInteractionBroker(context),
    automationPort: createProtocolAutomationPort(context, () => ownSessionRecord),
    topicResourcePort: createProtocolTopicResourcePort(context),
    // 只接入 Host 已开放的工具面；缺省不注入。复用现行异步工厂，
    // 不恢复旧 deferred ModelAdapter/Registry overlay，也不改变 Session Selection。
    ...(("offPeakToolEnabled" in params && params.offPeakToolEnabled === true) ||
    context.appRuntimePreferences.offPeakToolEnabled === true
      ? { offPeakPort: createProtocolOffPeakPort(context, () => ownSessionRecord) }
      : {}),
    resolveInitialBashShellSelection: startupPreferences.resolveInitialBashShellSelection,
    ...(startupPreferences.subagentRuntimeConfigEnabled &&
    !(workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity))
      ? {
          readSubagentRuntimeConfig: async ({ signal, traceContext }) => {
            signal.throwIfAborted();
            const result = await context.requestClient(
              zcodeProtocolMethods.subagentsReadRuntimeConfig,
              { sessionId },
              subagentRuntimeConfigSchema,
              {
                signal,
                timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
                trace: { traceId: traceContext.traceId },
              },
            );
            signal.throwIfAborted();
            return result;
          },
        }
      : {}),
    // browser-use：agent.browsers.* 经此把命令转成 interaction/browserExecute 反向请求。
    browserControlPort: createProtocolBrowserControlBroker(context),
    // Protocol server 是受信任的 Desktop/Web/Mobile Host；灰度开关由这里显式注入，
    // 不从 workspace/project 配置或环境变量读取，关闭时仍可通过删掉该字段回滚到 hard block。
    workspaceHookTrustEnabled: true,
    // 无 session 的 Settings Trust 曾绕过 managed policy；session Runtime 与
    // workspace RPC 必须共享 Host 持有的同一 provider，不能各自创建默认 policy。
    workspaceHookPolicyProvider: context.deps.workspaceHookPolicyProvider,
    workspaceHookReviewHost: {
      taskId: sessionId,
      runId: `workspace-hook-run:${sessionId}:${crypto.randomUUID()}`,
      workspaceLabel:
        workspace.workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspace.workspacePath,
      ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
    },
    sessionId,
    sessionStore: context.deps.sessionStore,
    traceContext,
    version: context.deps.version,
    modelIoFullRetentionEnabled: context.appRuntimePreferences.modelIoFullRetentionEnabled,
  });
  const now = Date.now();
  // [事务] record 组装时 createdAt/updatedAt 共用同一个 now：分成两次 Date.now()
  // 会让"创建时间"晚于"更新时间"，列表排序与详情页互相矛盾。
  // [并发] persistence 默认 immediate，但 create 入参显式给了 deferred 时以入参为准：
  // 首发前关闭的竞态依赖 record 从一开始就诚实反映 draft 状态（INV-23）。
  // [资源] 订阅在 record 组装之后建立且必须在本函数返回前完成：返回后再订阅会漏掉
  // app 构造期的首条事件（例如 SessionTitleUpdated first_input）。
  const record: ZCodeProtocolSessionRecord = {
    app,
    createdAt: now,
    eventStore,
    memoryEnabled: startupPreferences.memoryEnabled,
    subagentRuntimeConfigEnabled: startupPreferences.subagentRuntimeConfigEnabled,
    modelContextBudgetStrategy: startupPreferences.modelContextBudgetStrategy,
    nativeSearchEnhancementsEnabled: startupPreferences.nativeSearchEnhancementsEnabled,
    toolSearchMode: startupPreferences.toolSearchMode,
    ...(parentSessionId ? { parentSessionId } : {}),
    persistence: "persistence" in params ? (params.persistence ?? "immediate") : "immediate",
    protocolEventSequences: new Map(),
    protocolToolInputTransmissions: new Map(),
    stateRevision: 0,
    taskType,
    traceContext,
    updatedAt: now,
    workspace,
  };
  // [事务] 必须等 subscribeEvents 返回后才能把 record 交给 automation-port：
  // 绑定发生在这里而不是构造参数里，是因为订阅回调本身需要持有 record 引用，存在
  // 先有鸡还是先有蛋的问题；getter 形式把"尚未就绪"的窗口压缩到零（见上）。
  // [资源] unsubscribe 包一层闭包而不是直接赋值 app 的返回值：record 的寿命长于
  // 订阅句柄，闭包能保证 close 时拿到的一定是本次订阅。
  const unsubscribeSessionEvents = app.runtime.subscribeEvents({
    onSessionEvent: (event) => onSessionEvent(context, record, event),
  });
  record.unsubscribe = () => {
    unsubscribeSessionEvents();
  };
  // 绑定归属会话，供 automation-port 读取本会话实时 model/mode/thought。
  ownSessionRecord = record;
  return record;
}

async function readPersistedSessionMessages(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<MessageWithParts[]> {
  return await (context.deps.sessionStore?.messages({
    sessionID: sessionId as SessionId,
  }) ?? []);
}

// [事务] 从后往前找第一条 assistant 的 mode：resume 时 mode 要以"最后一次实际使用"
// 为准，从头找会拿到会话最早的 plan 模式，把用户后来切到的 build 覆盖掉。
// [失败路径] 找不到（纯用户消息、或旧数据没有 mode）返回 undefined，让上层回落到
// workspace 默认值，而不是硬编码一个 "build"。
function derivePersistedSessionMode(
  messages: readonly MessageWithParts[],
): ZCodeSessionCreateParams["mode"] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (info?.role === "assistant" && isZCodeSessionMode(info.mode)) return info.mode;
  }
  return undefined;
}

// [权衡] 白名单六个字面量而不是 typeof string：mode 会被写进 workspace 配置并影响
// 工具权限（yolo 放开写权限），任何拼写错误或历史遗留值都必须被挡在运行时之外。
function isZCodeSessionMode(
  value: unknown,
): value is NonNullable<ZCodeSessionCreateParams["mode"]> {
  return (
    value === "plan" ||
    value === "build" ||
    value === "edit" ||
    value === "yolo" ||
    value === "guarded" ||
    value === "auto"
  );
}

// [权衡] options 原样透传而不是在此处合并默认值：modelSelection 的 options 是
// provider 前缀缓存/推理强度等私有开关，协议层不解释、不校验，只负责搬运。
// [失败路径] model 为空返回 undefined 而不是空对象：空对象会被 runtime 当成
// "显式选择了一个没有 id 的模型"，直接抛错。
function toRuntimeModelSelection(
  model: ZCodeSessionCreateParams["model"],
): ModelSelection | undefined {
  if (!model) return undefined;
  return {
    modelId: model.modelId,
    providerId: model.providerId,
    ...(model.options ? { options: model.options } : {}),
  };
}

interface SnapshotPhaseDurationsMs {
  contextUsageBreakdownEvents: number;
  eventSeq: number;
  goalVerificationEvents: number;
  persistedMessages: number;
  persistedSession: number;
  rewindEvents: number;
  target: number;
  todos: number;
  buildSnapshot: number;
}

interface SnapshotWithDiagnostics {
  snapshot: Awaited<ReturnType<typeof buildSessionSnapshot>>;
  phaseDurationsMs: SnapshotPhaseDurationsMs;
}

async function snapshot(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  knownSession?: SessionInfo | null,
  options: {
    messageLimit?: number;
    modelAvailability?: "all" | "current";
  } = {},
) {
  return (await snapshotWithDiagnostics(context, record, knownSession, options)).snapshot;
}

async function snapshotWithDiagnostics(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  knownSession?: SessionInfo | null,
  options: {
    messageLimit?: number;
    modelAvailability?: "all" | "current";
  } = {},
): Promise<SnapshotWithDiagnostics> {
  const snapshotStartedAt = Date.now();
  const phaseDurationsMs: SnapshotPhaseDurationsMs = {
    contextUsageBreakdownEvents: 0,
    eventSeq: 0,
    goalVerificationEvents: 0,
    persistedMessages: 0,
    persistedSession: 0,
    rewindEvents: 0,
    target: 0,
    todos: 0,
    buildSnapshot: 0,
  };
  // [性能] 分阶段计时器的存在意义只有一个：snapshot 变慢时能指出是"读库慢"还是
  // "投影慢"。没有它，一条 3s 的 SLOW_SNAPSHOT 日志无法定位到具体阶段。
  // [失败路径] 计时在 finally 里写回，读取抛错也会留下耗时：失败的阶段往往正是最慢
  // 的那一个，漏记会让诊断恰好丢失最关键的数据。
  const measureSnapshotPhase = async <T>(
    phase: keyof Omit<SnapshotPhaseDurationsMs, "buildSnapshot">,
    read: () => Promise<T>,
  ): Promise<T> => {
    const phaseStartedAt = Date.now();
    try {
      return await read();
    } finally {
      phaseDurationsMs[phase] = Date.now() - phaseStartedAt;
    }
  };
  // [事务] 八个读面 Promise.all 并发，但语义上互不依赖：任一项失败都不影响其他项
  // （各自内部已降级）。若改成串行，SSH/远端 workspace 的 snapshot 会线性叠加成
  // 数秒的首屏延迟。
  // [并发] knownSession 传入时跳过持久行读取，直接用调用方刚拿到的事实：resume 路径
  // 已经查过一次库，重查会与本次激活的时间戳不一致（见 INV-05）。
  // [失败路径] eventSeq 与 persistedMessages 必须来自同一时刻的读取：分开读会出现
  // "快照里有第 N 条消息、但 eventSeq 停在第 N-1 条"的错位，客户端 resume 时重复拉取。
  const [
    eventSeq,
    persistedMessages,
    session,
    rewindEvents,
    persistedTarget,
    persistedTodos,
    persistedGoalVerificationEvents,
    persistedContextUsageBreakdownEvents,
  ] = await Promise.all([
    measureSnapshotPhase("eventSeq", () =>
      getProtocolEventSeq(context, record, record.deliveryKind),
    ),
    measureSnapshotPhase("persistedMessages", () => readSessionMessages(context, record)),
    knownSession === undefined
      ? measureSnapshotPhase("persistedSession", () =>
          getPersistedSession(context, record.app.sessionId),
        )
      : knownSession,
    measureSnapshotPhase("rewindEvents", () => readSessionRewindEvents(record)),
    measureSnapshotPhase("target", () => readSnapshotTarget(context, record)),
    measureSnapshotPhase("todos", () => readSnapshotTodos(context, record)),
    measureSnapshotPhase("goalVerificationEvents", () =>
      readSessionTargetCompletionVerificationEvents(context, record),
    ),
    measureSnapshotPhase("contextUsageBreakdownEvents", () =>
      readSessionContextUsageBreakdownEvents(record),
    ),
  ]);
  // [事务] rewind 投影必须在 build 之前完成（INV-33）：buildSessionSnapshot 收到的
  // 是"已经按 keptMessageIDs 裁剪过"的消息，若把 rewindEvents 一起传进去让它自己裁，
  // 两处裁剪规则会不一致，出现"快照里有但 UI 列表没有"的幽灵消息。
  // [性能] buildSnapshot 单独计时：它是唯一包含纯 CPU 投影的阶段，与读库耗时分开
  // 记录才能判断该优化 SQL 还是优化渲染数据结构（见 SLOW_SNAPSHOT 日志）。
  const messages = projectActiveSessionMessages(persistedMessages, session, rewindEvents);
  const buildStartedAt = Date.now();
  const builtSnapshot = await buildSessionSnapshot({
    app: record.app,
    deliveryKind: record.deliveryKind,
    eventSeq,
    fallbackCreatedAt: record.createdAt,
    fallbackUpdatedAt: record.updatedAt,
    lastError: record.restoreWarning,
    messages: limitMessages(messages, options.messageLimit),
    modelAvailability: options.modelAvailability,
    persistedContextUsageBreakdownEvents,
    persistedGoalVerificationEvents,
    session,
    // [权衡] slashCommandOptions 的灰度开关取进程级偏好，且必须与 workspace
    // presentation 使用同一个来源：两处不一致时，关闭态下侧栏面板仍能看到 workflow。
    // [事务] stateRevision 原样透传，不在这里自增：snapshot 是读操作，自增会让客户端
    // 的乐观并发把"读"误判为"写"。
    slashCommandOptions: {
      // session snapshot 的 `/` 目录与 workspace presentation 必须给出同一份灰度结论，
      // 否则关闭态下侧栏面板还能看到 `workflow`。
      dynamicWorkflowEnabled: context.appRuntimePreferences.dynamicWorkflowEnabled,
      env: context.deps.env,
      logger: context.logger,
    },
    stateRevision: record.stateRevision,
    target: persistedTarget,
    todos: persistedTodos,
    workspace: record.workspace,
  });
  phaseDurationsMs.buildSnapshot = Date.now() - buildStartedAt;
  const totalDurationMs = Date.now() - snapshotStartedAt;
  // [性能] 慢日志里带完整 phaseDurationsMs 与 messageCount：只有总耗时无法区分
  // "sqlite 等待"和"投影构建"，而这两者的修复方向完全相反。
  // [失败路径] 只 warn 不改变返回值（INV-32 的上半句）：慢不是错误，客户端仍应拿到
  // 完整快照。
  if (totalDurationMs >= SLOW_SNAPSHOT_LOG_THRESHOLD_MS) {
    // SSH 场景下慢点集中在 session snapshot，但旧日志只有总耗时。
    // 超过阈值时记录各子阶段，便于区分 sqlite 等待、消息读取和 projection 构建。
    context.logger?.warn("ZCode Protocol session snapshot slow", {
      durationMs: totalDurationMs,
      event: "zcode_protocol.session_snapshot.slow",
      messageCount: messages.length,
      module: "bootstrap.zcode_protocol",
      phaseDurationsMs,
      sessionId: record.app.sessionId,
      status: "completed",
      workspaceKey: record.workspace.workspaceKey,
      workspacePath: record.workspace.workspacePath,
    });
  }
  return { snapshot: builtSnapshot, phaseDurationsMs };
}

async function readSnapshotTarget(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
) {
  try {
    return await record.app.readTarget();
  } catch (error) {
    // goal 是 session_target 的持久业务状态；snapshot 恢复失败时不能静默吞掉，
    // 否则 UI 会误以为历史 session 没有目标。这里保留运行期 projection 并记录协议层日志。
    context.logger?.warn("Failed to read persisted session goal for protocol snapshot", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.snapshot.target_read_failed",
      sessionId: record.app.sessionId,
    });
    return undefined;
  }
}

async function readSnapshotTodos(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
) {
  try {
    return await record.app.readTodos();
  } catch (error) {
    // todo 是 DB 中的权威短期计划；如果恢复读取失败，UI 需要看到明确日志，
    // 但协议 snapshot 仍可用消息历史继续恢复首屏。
    context.logger?.warn("Failed to read persisted session todos for protocol snapshot", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.snapshot.todos_read_failed",
      sessionId: record.app.sessionId,
    });
    return [];
  }
}

// [失败路径] 读取失败返回空数组并 warn（INV-32）：goal verifier 的时间线是增强信息，
// 读不到不应阻止会话主体恢复。
// [权衡] 用 sessionEntries 而不是 eventStore：verification 是"业务账本"而非事件流，
// 从事件流重建会丢失被裁剪/归档的历史结论。
async function readSessionTargetCompletionVerificationEvents(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<SessionEvent[]> {
  const sessionStore = context.deps.sessionStore;
  if (!sessionStore?.sessionEntries) {
    return [];
  }
  try {
    const entries = await sessionStore.sessionEntries({
      sessionID: record.app.sessionId as SessionId,
      type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
    });
    return entries
      .map((entry, index) =>
        sessionEntryToTargetCompletionVerificationEvent(entry, record.app.sessionId, index),
      )
      .filter((event): event is SessionEvent => event !== null);
  } catch (error) {
    // goal verifier timeline 是 UI 轮次的持久事实；读取失败时不能影响
    // session 主体恢复，但必须留下日志，否则冷启动后分组丢失很难排查。
    context.logger?.warn("Failed to read persisted goal verification entries", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.snapshot.goal_verification_entries_read_failed",
      sessionId: record.app.sessionId,
    });
    return [];
  }
}

function sessionEntryToTargetCompletionVerificationEvent(
  entry: {
    id: string;
    sessionID: SessionId;
    time: { created: number; updated: number };
    data: unknown;
  },
  fallbackSessionId: string,
  index: number,
): SessionEvent | null {
  const data = asRecord(entry.data);
  const payload = readTargetCompletionVerificationPayload(data.payload);
  if (!payload) {
    return null;
  }
  const eventId = stringValue(data.eventId) ?? entry.id;
  const traceId = stringValue(data.traceId) ?? "trace_restored_goal_verification";
  const turnId = stringValue(data.turnId);
  return {
    id: eventId as EventId,
    payload,
    sequenceNumber: numberValue(data.sequenceNumber) ?? index + 1,
    sessionId: (entry.sessionID ?? fallbackSessionId) as SessionId,
    timestamp: new Date(entry.time.updated || entry.time.created),
    traceId: traceId as TraceId,
    ...(turnId ? { turnId: turnId as TurnId } : {}),
    type: SessionEventType.TargetCompletionVerification,
  };
}

// [失败路径] 只要有一个必填字段缺失就返回 null（见下方注释），由调用方过滤：
// 半条 verification 事件会让 UI 渲染出一个"无目标 id"的分组，比丢整条更糟。
// [事务] sequenceNumber 缺失时用 index+1 兜底：恢复后的事件没有原始 seq，
// 用稳定递增的序号保证同一次投影里的排序一致。
function readTargetCompletionVerificationPayload(
  value: unknown,
): TargetCompletionVerificationPayload | null {
  const record = asRecord(value);
  const targetId = stringValue(record.targetId);
  const verificationId = stringValue(record.verificationId);
  const status = stringValue(record.status);
  if (!targetId || !verificationId || !isTargetCompletionVerificationStatus(status)) {
    return null;
  }
  const verification = asGoalCompletionVerification(record.verification);
  const goalIteration = numberValue(record.goalIteration);
  const anchorAssistantMessageId = stringValue(record.anchorAssistantMessageId);
  const anchorTurnId = stringValue(record.anchorTurnId);
  return {
    targetId,
    verificationId,
    status,
    ...(verification ? { verification } : {}),
    ...(goalIteration ? { goalIteration } : {}),
    ...(anchorAssistantMessageId
      ? { anchorAssistantMessageId: anchorAssistantMessageId as MessageId }
      : {}),
    ...(anchorTurnId ? { anchorTurnId: anchorTurnId as TurnId } : {}),
  };
}

// [权衡] 状态白名单用显式比较而不是 Set：只有三个取值，显式比较让"新增状态必须
// 回来改这里"成为一次编译期可见的改动，避免上游加了新状态却被静默过滤成 null。
function isTargetCompletionVerificationStatus(
  status: string | undefined,
): status is TargetCompletionVerificationPayload["status"] {
  return (
    status === "started" ||
    status === "completed" ||
    status === "failed_closed" ||
    status === "cancelled"
  );
}

// [失败路径] 嵌套字段解析失败时返回 undefined 并让上层省略该字段，而不是返回
// 一个空壳对象：客户端会用 `verification != null` 判断是否展示详情，空壳会渲染出
// 一张全是占位符的卡片。
function asGoalCompletionVerification(
  value: unknown,
): TargetCompletionVerificationPayload["verification"] | undefined {
  const record = asRecord(value);
  if (typeof record.passed !== "boolean") {
    return undefined;
  }
  const reason = stringValue(record.reason);
  if (!reason) {
    return undefined;
  }
  return {
    nextAction: stringValue(record.nextAction),
    passed: record.passed,
    reason,
  };
}

// [权衡] limit 截尾（slice(-limit)）而不是截头：快照的用途是"打开会话时先看到最新
// 状态"，头部历史由 readMessages 分页补齐。
// [失败路径] limit 为 0 或负数时视为"不限"而不是"全部裁掉"：0 通常在协议里被用作
// "未设置"的默认值，按字面执行会让首屏空白（与下方注释的语义一致）。
function limitMessages<T>(messages: T[], limit?: number): T[] {
  return limit && limit > 0 ? messages.slice(-limit) : messages;
}

// [失败路径] 无 sessionStore 时返回空数组（INV-31）：纯 V4 宿主也调用本函数，
// 抛错会让"只读投影"整条链路失败。
// [权衡] 一次性读全量消息而不是分页：projectActiveSessionMessages 需要全量才能
// 正确应用 rewind 的 keptMessageIDs，分页会把被裁掉的分支重新算进来。
async function readSessionMessages(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
) {
  if (!context.deps.sessionStore) return [];
  return await context.deps.sessionStore.messages({
    sessionID: record.app.sessionId as SessionId,
  });
}

// [事务] ModelComplete 是上下文用量的事实源：只按类型过滤，不按 seq 截断，
// 因为用量需要"从会话开始累计"，任何截断都会让百分比偏低。
// [性能] 全量读取 + filter 的成本与事件数成正比；对超长会话这是一次 O(n) 扫描，
// 但相比正确性（用量显示）这个代价是必要的。
async function readSessionContextUsageBreakdownEvents(
  record: ZCodeProtocolSessionRecord,
): Promise<SessionEvent[]> {
  const events = await record.eventStore.getEvents(record.app.sessionId as SessionId);
  return events.filter((event) => event.type === SessionEventType.ModelComplete);
}

// [事务] 必须用 eventStore 全量事件而不是 projection 的增量窗口：上下文用量是
// "所有 ModelComplete 的累计"，从窗口里算会随窗口滚动而忽大忽小。
// [性能] 这里只做一次全量扫描 + 一次 filter，不做去重或排序：事件本身按 seq 追加，
// 顺序已经是权威的。
async function readActiveSessionMessages(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<MessageWithParts[]> {
  const [messages, session, rewindEvents] = await Promise.all([
    readSessionMessages(context, record),
    getPersistedSession(context, record.app.sessionId),
    readSessionRewindEvents(record),
  ]);
  return projectActiveSessionMessages(messages, session, rewindEvents);
}

// [事务] rewind 事件必须按 eventStore 的追加顺序读取（不是按 timestamp 排序）：
// 同一毫秒内的两次 rewind 只有 seq 能区分先后，按时间排序会让投影结果不稳定。
async function readSessionRewindEvents(
  record: ZCodeProtocolSessionRecord,
): Promise<SessionEvent[]> {
  const events = await record.eventStore.getEvents(record.app.sessionId as SessionId);
  return events.filter((event) => event.type === SessionEventType.RewindTriggered);
}

// [事务] rewind 投影是"从后往前叠加"的：先应用持久 session 上的 revert 事实，再按
// 事件顺序逐条应用 rewind。反过来（先事件后 session）会让最后一次 rewind 被 session
// 的旧锚点覆盖，用户看到的消息比实际多。
// [失败路径] 第二条及之后的事件应用在 activeMessages 上、但 allMessages 始终传原始
// 全量：裁剪后的集合里找不到 createdMessageId 时，必须能回到全量里取"之后的消息"，
// 否则第二次 rewind 会把重做出来的内容一起丢掉。
function projectActiveSessionMessages(
  messages: MessageWithParts[],
  session: SessionInfo | null | undefined,
  rewindEvents: readonly SessionEvent[],
): MessageWithParts[] {
  const activeConversationRewinds: ActiveConversationRewindPayload[] = [];
  const sessionRewindPayload = activeConversationRewindPayloadFromSession(session);
  if (sessionRewindPayload) {
    activeConversationRewinds.push(sessionRewindPayload);
  }
  let activeMessages = applyRewindBranch(messages, messages, {
    createdMessageId: sessionRewindPayload?.createdMessageId,
    keptMessageIds: session?.revert?.keptMessageIDs,
    targetMessageId: sessionRewindPayload?.targetMessageId,
  });

  for (const event of rewindEvents) {
    const payload = parseActiveConversationRewindPayload(event);
    if (!payload?.targetMessageId) {
      continue;
    }
    activeConversationRewinds.push(payload);
    activeMessages = applyRewindBranch(activeMessages, messages, payload);
  }

  return filterRewindCommandAckMessages(activeMessages, activeConversationRewinds);
}

type ActiveConversationRewindPayload = {
  createdMessageId: MessageId;
  targetMessageId: MessageId;
};

function activeConversationRewindPayloadFromSession(
  session: SessionInfo | null | undefined,
): ActiveConversationRewindPayload | null {
  const createdMessageId = session?.revert?.createdMessageID;
  const targetMessageId = session?.revert?.targetMessageID;
  if (!createdMessageId || !targetMessageId) {
    return null;
  }
  return { createdMessageId, targetMessageId };
}

// [失败路径] 除 ActiveChain + conversation/both 之外的 rewind 一律忽略（见下方注释）：
// core 会为不可用的 rewind 记 unavailable 事件，它没有 createdMessageId；拿它裁剪
// 会让"连续编辑"把可见消息投空，用户以为自己的历史被删了。
// [事务] 这里只做"能不能用"的判定，不修改任何状态：投影是纯函数，事件流的真相不
// 因读取而改变。
function parseActiveConversationRewindPayload(
  event: SessionEvent,
): ActiveConversationRewindPayload | null {
  try {
    const payload = parseRewindTriggeredPayload(event.payload);
    if (
      payload.strategy !== RewindStrategy.ActiveChain ||
      (payload.scope !== RewindScope.Conversation && payload.scope !== RewindScope.Both) ||
      !payload.createdMessageId ||
      !payload.targetMessageId
    ) {
      // core 会为不可用的 rewind 记录 unavailable event，但这类事件没有 createdMessageId。
      // 它不是新的 active branch 起点，协议投影不能用它裁剪消息，否则连续编辑会把可见消息投空。
      return null;
    }
    return {
      createdMessageId: payload.createdMessageId,
      targetMessageId: payload.targetMessageId,
    };
  } catch {
    return null;
  }
}

// [事务] ACK 过滤依据的是"parentID 命中 rewind.createdMessageId"这一结构关系，
// 而不是文本匹配单独成立：只按文本删会把用户自己引用的那句话一起删掉（INV-34）。
// [失败路径] 文本比较允许 "以换行 + ack 结尾"：旧版本会把回执拼在上一条 assistant
// 文本后面，严格相等会漏删，导致刷新后又冒出一条假消息。
function filterRewindCommandAckMessages(
  messages: MessageWithParts[],
  activeConversationRewinds: readonly ActiveConversationRewindPayload[],
): MessageWithParts[] {
  if (activeConversationRewinds.length === 0) {
    return messages;
  }
  const targetByNoticeMessageId = new Map<MessageId, MessageId>();
  for (const rewind of activeConversationRewinds) {
    targetByNoticeMessageId.set(rewind.createdMessageId, rewind.targetMessageId);
  }
  return messages.filter((message) => !isRewindCommandAckMessage(message, targetByNoticeMessageId));
}

function isRewindCommandAckMessage(
  message: MessageWithParts,
  targetByNoticeMessageId: ReadonlyMap<MessageId, MessageId>,
): boolean {
  if (message.info.role !== "assistant") {
    return false;
  }
  const targetMessageId = targetByNoticeMessageId.get(message.info.parentID);
  if (!targetMessageId) {
    return false;
  }
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  const ackText = `Rewound conversation to before message ${targetMessageId}.`;
  // 内部 `/rewind conversation <messageId>` 的成功回执可能被旧事件投影落成
  // assistant 文本。它只是编辑/重试的控制命令 ACK，刷新或恢复时不能再渲染给用户。
  return text === ackText || text.endsWith(`\n${ackText}`);
}

function isUserVisibleSessionMessage(message: MessageWithParts): boolean {
  if (message.info.role !== "user") {
    return true;
  }
  const policy = getConversationMessageProjectionPolicy(message);
  return policy === "realUserInput" || policy === "timelineOnly";
}

function applyRewindBranch(
  activeMessages: MessageWithParts[],
  allMessages: MessageWithParts[],
  options: {
    createdMessageId?: MessageId;
    keptMessageIds?: readonly MessageId[];
    targetMessageId?: MessageId;
  },
): MessageWithParts[] {
  if (!options.targetMessageId) {
    return activeMessages;
  }

  // [事务] keptMessageIDs 优先（INV-33）：连续 rewind 后账本里的 target 前缀已不等于
  // active branch 前缀，按 target 重算会把旧分支复活。
  // [失败路径] createdMessageId 存在时还要把"从 created 开始的全量尾部"接回去：
  // 这是 rewind 后用户继续提问产生的新消息，只返回 kept 会把新对话藏起来。
  if (options.keptMessageIds) {
    // 连续 rewind 后，账本里的 target 前缀不等于 active branch 前缀。
    // 优先使用 runtime 在 rewind 当时保存的 keptMessageIDs，避免旧分支在 snapshot/readMessages 中复活。
    const messagesById = new Map(allMessages.map((message) => [message.info.id, message]));
    const keptMessages = options.keptMessageIds
      .map((messageId) => messagesById.get(messageId))
      .filter((message): message is MessageWithParts => message !== undefined);
    if (!options.createdMessageId) {
      return keptMessages;
    }

    const createdIndex = allMessages.findIndex(
      (message) => message.info.id === options.createdMessageId,
    );
    return createdIndex >= 0 ? [...keptMessages, ...allMessages.slice(createdIndex)] : keptMessages;
  }

  const targetIndex = activeMessages.findIndex(
    (message) => message.info.id === options.targetMessageId,
  );
  if (targetIndex < 0) {
    return activeMessages;
  }
  const keptMessages = activeMessages.slice(0, targetIndex);
  if (!options.createdMessageId) {
    return keptMessages;
  }

  const createdIndex = allMessages.findIndex(
    (message) => message.info.id === options.createdMessageId,
  );
  if (createdIndex < 0) {
    return keptMessages;
  }

  // conversation rewind 的持久化账本会保留被回滚的旧分支。
  // UI snapshot/readMessages 必须投影 active branch，否则编辑重发后会同时看到错发原文和新消息。
  return [...keptMessages, ...allMessages.slice(createdIndex)];
}

// [事务] 分发前必须先修复 legacy 的 identity/cwd 混写（见下方注释）：修复发生在
// "读出 session 之后、被用于物化 runtime 之前"，这是唯一能保证后续所有读取者都
// 看到一致值的时机。
// [失败路径] 修复失败只 warn 并继续（onPersistenceFailure）：读路径不能因为一次
// 写修复失败而整体不可用，内存里的修复值仍然正确。
async function getPersistedSession(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<SessionInfo | null> {
  const sessionStore = context.deps.sessionStore;
  if (!sessionStore) return null;
  const session = await sessionStore.getSession(sessionId as SessionId);
  if (!session) return null;
  // 协议冷恢复先用 session.path 创建 runtime，必须在物化前清理旧版 identity/cwd 混写数据。
  return await repairPersistedRemoteSessionPaths(sessionStore, session, {
    onPersistenceFailure: (error) => {
      context.logger?.warn("Session path repair persistence failed; using in-memory repair", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.session.path_repair.persist_failed",
        sessionId,
      });
    },
  });
}

/**
 * 纯配置类 mutation reason：只改会话选型，不算用户活动。
 * 与 isConfigOnlySessionEvent 同一裁决——record.updatedAt 是 sessions-index
 * lastActivityAt / snapshot.session.updatedAt（task index 排序时间）的事实源，
 * 切模型/切思考深度/切模式不能把任务顶到列表最前。
 */
// [事务] 纯配置类 mutation 与 isNonActivitySessionEvent 必须保持同一套裁决（INV-25）：
// 两处判据若分叉，会出现"事件不 bump、但 setModel 的 mutation 会 bump"或反之，
// 侧栏的 lastActivityAt 就会随一次切模型跳变。
const CONFIG_ONLY_MUTATION_REASONS = new Set([
  "model_changed",
  "thought_level_changed",
  "mode_changed",
]);

// 所有写操作的统一收尾：无活跃 turn 时补模型 fallback、递增 revision、产出快照并
// 广播 state.updated；返回的快照同时作为 RPC 结果。
// [事务] 写操作的统一收尾，四步顺序固定：补模型 fallback → revision++ → 可能更新
// updatedAt → 取快照并广播。
// [并发] fallback 只在无活跃 turn 时做（见下方注释）：改写设置会打断在途请求，
// 而 turn 结束时会主动经过这里，因此不需要在 turn 中抢占。
// [失败路径] 快照失败会让整个 RPC 失败而不是发空 patch：客户端拿到 revision 却没有
// 内容，会陷入"revision 前进但视图不更新"的循环。
export async function afterStateMutation(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  reason: string,
) {
  if (!record.activeAbortController) {
    // provider registry 可能在 turn 运行中删除当前模型。更新时不能改写在途请求；turn/compact/
    // goal continuation 释放 active lock 后统一经过此安全边界，立即完成同一 Agent fallback，
    // 无需等待用户下一次发送，也不把兜底职责重新交给 renderer。
    await ensureSessionModelAvailable(context, record);
  }
  record.stateRevision++;
  const configOnlyMutation = CONFIG_ONLY_MUTATION_REASONS.has(reason);
  if (!configOnlyMutation) {
    record.updatedAt = Date.now();
  }
  const stateSnapshot = await snapshot(context, record, undefined, {
    modelAvailability: "current",
  });
  emitStateUpdated(context, record, reason, stateSnapshot.settings);
  return stateSnapshot;
}

// [事务] revision 必须在 emit 之前自增，且 emit 的 patch 与返回值共享同一个 revision：
// 客户端用返回值里的 revision 作为下一次 expectedRevision，任何错位都会立刻产生
// 一次假的冲突错误。
// [权衡] patch 只带 { status: "running" } 而不是完整快照：ACK 要快（见 2500 行注释），
// 完整快照由之后的 state.updated 或 snapshot 拉取补齐。
function afterPromptAccepted(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  reason: string,
) {
  record.stateRevision++;
  record.updatedAt = Date.now();
  emitStateUpdated(context, record, reason, { status: "running" });
  return {
    accepted: true as const,
    sessionId: record.app.sessionId,
    stateRevision: record.stateRevision,
  };
}

// [并发] 广播统一走 context.notify（单播给当前连接），而不是广播给所有连接：
// state.updated 携带的是"某会话的完整设置"，多端各自持有自己的 revision，
// 群发会让无关连接也推进游标。
function emitStateUpdated(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  reason: string,
  patch: unknown,
): void {
  const notification: ZCodeStateUpdatedNotification = {
    patch,
    reason,
    revision: record.stateRevision,
    scope: "session",
    sessionId: record.app.sessionId,
    type: "state.updated",
    workspace: record.workspace,
  };
  context.notify({ method: "state.updated", params: notification });
}
