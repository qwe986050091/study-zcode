// ══════════════════════════════════════════════════════════════════════════
// 文件头：本文件维持 / 依赖的不变量
//
// 本文件是旧协议目录里唯一的 v4 适配层，两端语义都很强：一侧是域无关的
// ConversationV4Gateway（投影、队列、帧），另一侧是 bootstrap 的会话注册表与
// transcript。下面每条不变量都对应「写错不会立刻抛错，但会在重启 / 重连 / 并发
// 时才变成错误终态」的隐含前提；正文注释只补「为什么」，不重复陈述结论。
// 阅读顺序建议：INV-1..6（方向与命令账本）→ INV-7..9（冷恢复）→
// INV-10..13（队列与资源）→ INV-14..18（失败路径与投影）→ INV-19..21（身份）。
//
// INV-1: 依赖方向只允许 旧目录 → v4 目录，v4 目录不得 import 本文件 —— 破坏后果：循环依赖在 bootstrap 装配期形成 TDZ，createConversationV4Gateway 拿到 undefined 导出。
// INV-2: executeCommand 必须先问 nativeExecutor.supports，未命中一律 reject V4CommandNotImplementedError —— 破坏后果：未知命令被静默吞掉，client 永远等不到 ACK 而卡在 pending。
// INV-3: admission 只为真正产生用户输入的命令写 ledger（sendText/sendGoalCommand/compact/editUserQuery/retryTurn） —— 破坏后果：纯查询命令落进 session_input，重启后被当成未消费输入重放。
// INV-4: Fork bundle commit 是命令的 PONR，commit 之后的 catalog/model/resume 失败不得把 durable accepted child 反转成 failed —— 破坏后果：transcript 与投影终态互相矛盾，用户重试会长出第二棵分支。
// INV-5: edit/retry 的 intent 必须复用 projection 的 canonical target，禁止从 envelope payload 重新推导 —— 破坏后果：附件与 provenance 丢失，重试实际发出与原轮不同的 prompt。
// INV-6: 文件变更摘要与回滚预览是只读面，不得写文件、不得为只读查询激活第二个 runtime —— 破坏后果：预览即改动工作区，或一次侧栏查询把子会话拉成重复 runtime。
// INV-7: 子会话没有自己的 bootstrap record 时借父 record 的共享 event/artifact store，但事件读写始终用 child sessionId —— 破坏后果：用父会话水位算 sourceEventSeq，冷恢复漏事件或重复回放。
// INV-8: 冷恢复的 sourceEventSeq 必须取 eventStore.getLatestSequenceNumber，不能用 max(events.seq) —— 破坏后果：内存 store 淘汰过的 delta 被当成 await 窗口尾部重放，正文重复。
// INV-9: workflow journal 回放事件必须先于内存事件参与 cold merge —— 破坏后果：重启后 workflowRuns 从投影消失，run 面板变成空列表。
// INV-10: 高频耗时持久化必须先按 userInput.highspeed 短路，再触达 sessionStore —— 破坏后果：每个普通 turn 终态都做一次 O(N) 全量消息扫描。
// INV-11: 自动提升队首只在 session 真正空闲且 goal 终态可证时执行，busy 时只挂 100ms 重试 —— 破坏后果：抢占前台 turn，或越过用户暂停的 FIFO barrier 插队。
// INV-12: queuedTurnExecutions 只驻留内存、按 session/sourceCommandId 索引、消费即删 —— 破坏后果：含临时凭据的执行材料被写进 transcript，或内存随会话数无界增长。
// INV-13: 删除会话必须先 disposeSession 再 context.sessions.delete —— 破坏后果：getSessionWorkspaceId 拿到 null，session.removed 推不到 sessions-index，侧栏项永不消失。
// INV-14: deferred 会话必须先走 ensureSessionPersistedForExternalActivity 再做 ledger 写入 —— 破坏后果：session_input 外键指向尚不存在的 session，admission 直接失败。
// INV-15: sharedContext 被 admission 占用时状态必须是 reserved，取消/失败必须回到 pending 或 discarded —— 破坏后果：引用永久挂起，用户既不能复用也不能释放。
// INV-16: 帧出口统一走 context.notify，gateway 不得直接接触 messageSink —— 破坏后果：出现旁路写通道，帧顺序与 snapshot 版本脱节。
// INV-17: 投影种子（config / usage / 模型窗口）只能读当前 runtime 真值 —— 破坏后果：旧 projection 的分母被写回首帧，auto-compact 阈值长期漂移。
// INV-18: terminateTurnForProjectionFault 只 abort 现有 controller，不在 gateway 层伪造 TurnError —— 破坏后果：越层写终态导致 active lock 不释放，下一次 turn 永远起不来。
// INV-19: 任务列表 membership 由 taskType 决定，parentID 只表达层级 —— 破坏后果：fork 出的子会话在重启后从侧栏消失。
// INV-20: 远端 workspace 查询必须同时带 directory 与 workspaceID —— 破坏后果：同一路径下其他 authority 的会话被误标进当前工作区。
// INV-21: 附件读写必须按 sessionId 找到 record，找不到即抛 fault.attachment.sessionNotFound —— 破坏后果：兜底到全局 store 后可以跨会话读到别人的附件。
// INV-22: 日志 sink 自身抛错不得跨过 PONR 改变命令终态 —— 破坏后果：一次 logger 异常把已 durable 的成功的命令 settle 成 failed。
// INV-23: 队列提升失败必须重新暂停 auto-drain 并保留原项，不能静默继续 —— 破坏后果：FIFO barrier 被绕过，后面的输入越过卡住的那条。
// INV-24: admission 的 requestedDelivery 是「预计投递边界」，startNow 不得伪装成 queue —— 破坏后果：重启后 discarded 诊断把立即执行当成排队丢弃，统计与用户提示都失真。
// INV-25: 能力缺失（listDynamicWorkflowRuns 等可选方法不存在）必须抛 V4CapabilityUnsupportedError，不能返回空数组 —— 破坏后果：renderer 无法区分「没有数据」与「没有这个能力」。
// INV-26: 经 app 调用的可选能力不得解构后再调用 —— 破坏后果：实现依赖 this 绑定时丢失接收者，运行期抛 TypeError。
// INV-27: 冷恢复时 transcript 是正文权威，session_entry 只补 legacy goal，内存事件只补 ephemeral 状态 —— 破坏后果：三源优先级颠倒会把过期 live 事件覆盖已提交正文。
// INV-28: 投影由 durable transcript 重物化时 synthesized 必须为 true —— 破坏后果：ingest 抢先建立的 cold publisher 不被替换，live 与 cold 停在两个终态。
// INV-29: legacy 空 identity 不能只凭路径 claim 归属，只能由 host task-index 的精确 taskId 证明 —— 破坏后果：同一目录下别的远端 authority 会话被错误划进当前工作区。
// INV-30: 兜底创建默认 workspace 的结果必须按最新 active workspace 再判一次 —— 破坏后果：迟到的默认项目抢走用户上次恢复的 tab。
// ══════════════════════════════════════════════════════════════════════════
import { isReadonlyAgentSessionKind } from "@zcode/shared";
import { readBackgroundBashOutputFromOwner } from "./background-work-owner.js";
// v4 网关 binder。
// 定位：ConversationV4Gateway 是域无关的通道运行时，本文件把它绑到协议服务器上下文：
// - 帧出口 = context.notify（stdio NDJSON notification，与旧 session/event 同一条管道并存）；
// - 命令执行 = V4CommandExecutor（zcode-protocol-v4/commands/，原生直驱 core）；
//   20 命令全部原生，supports() 未命中（未知命令）→ notImplemented。
// - 过渡钩子（ensureModelReady / afterLegacyStateMutation / deleteSession /
//   createSessionRecord / child record registration / resumePersistedSession）在此注入旧实现，
//   死期 = M5 波次 2（随旧协议一同删除）。
//
// 不做桥接：依赖方向只允许 旧目录 → v4 目录。
// 本文件在旧目录，import v4 executor 合法；v4 目录禁止反向 import 本目录任何模块。
import {
  isConversationRealUserTurnStarter,
  parseRemoteWorkspaceIdentity,
  type ZCodeSessionContextUsage,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import { createExternalTurnFaultError } from "@zcode/core";
import {
  V4_NOTIFICATIONS,
  conversationInputIntentSchema,
  type AttachmentRef,
  type CommandEnvelope,
  type ConversationInputIntent,
  type ConversationSnapshot,
  type V4ConversationFileChangesResult,
  type V4ConversationFileRewindPreviewResult,
  type SessionSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { V4CommandExecutor } from "../zcode-protocol-v4/commands/executor.js";
import { V4QueuePromotionLeaseUnavailableError } from "../zcode-protocol-v4/commands/handlers/queue.js";
import { V4CapabilityUnsupportedError } from "../zcode-protocol-v4/commands/handlers/interaction-background.js";
import {
  buildColdFileChangeSummaries,
  readConversationFileChangesFromEvents,
} from "../zcode-protocol-v4/cold-file-change-summaries.js";
import {
  loadPersistedConversationMaterialization,
  mergeColdConversationEvents,
} from "../zcode-protocol-v4/cold-event-merge.js";
import { lookupGlobalCreateSessionCommand } from "../zcode-protocol-v4/create-session-command-fact.js";
import type {
  V4CommandCoreHost,
  V4QueuedTurnExecution,
} from "../zcode-protocol-v4/commands/types.js";
import type {
  ConversationRowTargetResolution,
  SessionUsageSeed,
} from "../zcode-protocol-v4/product-projection.js";
import { PersistentCommandIndex } from "../zcode-protocol-v4/persistent-command-index.js";
import { queueItemIdForCommand } from "../zcode-protocol-v4/command-inbox.js";
import { resolveStableForkTargetFromTranscript } from "../zcode-protocol-v4/stable-fork-target.js";
import { shouldAutoDrainV4QueueHead } from "../zcode-protocol-v4/queue-auto-drain.js";
import { persistAssistantFeedback } from "../zcode-protocol-v4/assistant-feedback-persistence.js";
import {
  persistHighspeedMetrics,
  persistHighspeedTiming,
} from "../zcode-protocol-v4/highspeed-metrics-persistence.js";
import {
  TASK_LIST_SESSION_TYPES,
  isTaskListSessionType,
} from "../zcode-protocol-v4/task-list-session-membership.js";
import {
  loadPersistentCommandFacts,
  savePersistentCommandFact,
} from "../zcode-protocol-v4/persistent-command-facts.js";
import {
  ConversationV4Gateway,
  V4CommandNotImplementedError,
} from "../zcode-protocol-v4/v4-gateway.js";
import {
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SessionEventType,
  createEventId,
  createSessionId,
} from "@zcode/contracts";
import type {
  CollaborationMode,
  DynamicWorkflowRunProgressPayload,
  EventId,
  ForkCommitBundle,
  GoalStatus,
  MessageId,
  MessageWithParts,
  SessionEvent,
  SessionEventStorePort,
  SessionId,
  SessionStorePort,
  StableForkGoalBoundaryMetadata,
  TraceId,
  TurnId,
  WorkspaceId,
} from "@zcode/contracts";
import { HYDRATION_TRACE_ID } from "../zcode-protocol-v4/projection-state.js";
import { cloneModelSelection, derivedSessionModelSelection } from "./fork-model-selection.js";
import { resolveWorkspaceRefFromId } from "./mapper.js";
import { buildLiveWorkspaceConfigStateV4 } from "./v4-workspace-config.js";
import {
  hasSessionModelProvider,
  resolveSessionModelContextWindow,
} from "./workspace-model-runtime.js";
import {
  afterStateMutation,
  activateSessionForResume,
  discardFailedSessionResume,
  createSessionRecordForV4,
  ensureSessionModelAvailableForNextTurn,
  listSessionSubagents,
  registerForkedSession,
  readSessionContextUsage,
} from "./server-operations.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { createProtocolLogger } from "./server-types.js";

// 存档里的 titleSource 是宽松字符串，v4 契约只认三值。这里做的是「收敛而不是猜测」：
// 未知值一律落到 generated，因为 custom 会阻止后续自动改名、default 会让 UI 显示占位标题，
// 只有 generated 在两种错误下都还能被自动标题重新覆盖，属于唯一安全默认。
function normalizeStoredTitleSource(
  source: string | undefined,
): NonNullable<SessionSummary["titleSource"]> {
  if (source === "custom") return "custom";
  if (source === "default") return "default";
  return "generated";
}

// [失败路径] used <= 0 时返回 null 而不是构造一个全零 seed：投影对 null 的解释是
// 「本会话还没有可信分母」，会保留 hydration 给出的首帧；而全零 seed 会被当成真实
// 读数写进 usage 行，把进度条钉死在 0% 且再也不接受后续覆盖。
function sessionUsageSeedFromRuntimeContextUsage(
  contextUsage: ZCodeSessionContextUsage | undefined,
  contextWindowOverride?: number,
): SessionUsageSeed | null {
  if (!contextUsage || contextUsage.used <= 0) {
    return null;
  }
  return {
    contextWindow: {
      usedTokens: contextUsage.used,
      maxTokens: contextWindowOverride ?? null,
      // 阈值必须留 null：auto-compact 的触发点由 core 的模型限制表计算，
      // binder 若在这里填一个本地常量，重启后两侧会用不同阈值判断，出现
      // 「UI 已显示告急但服务端不压缩」或反之的错位。
      autoCompactThresholdTokens: null,
      ...(contextUsage.cache ? { cache: contextUsage.cache } : {}),
      ...(contextUsage.breakdown ? { breakdown: contextUsage.breakdown } : {}),
    },
  };
}

// [权衡] 这里用白名单而不是「Cast 后直接用」：分叉点消息里的 mode 是历史字符串，
// 未来新增的协作模式（例如更细的 auto 子态）在旧客户端写下的 transcript 里可能不存在。
// 无条件 cast 会让子会话带着一个当前 runtime 不认识的状态启动，getMode() 之后的所有
// 权限/工具集推导都落到未定义分支；白名单 + fallback 至少保证子会话可用。
const STABLE_FORK_MODES = new Set<CollaborationMode>([
  "plan",
  "build",
  "edit",
  "yolo",
  "guarded",
  "auto",
]);

// [失败路径] fallback 取父会话当前模式而不是硬编码 build：用户从 yolo 会话分叉时，
// 静默降级成 build 会突然开始弹权限确认，看起来像分叉丢了设置；沿用父模式则最多
// 沿用了一个已过期但语义一致的值。
function stableForkMode(value: string, fallback: CollaborationMode): CollaborationMode {
  return STABLE_FORK_MODES.has(value as CollaborationMode)
    ? (value as CollaborationMode)
    : fallback;
}

// 文件变更读面：从会话事件重建变更摘要，artifact 内容按需回读，不返回本地路径。
async function readConversationFileChanges(
  record: ZCodeProtocolSessionRecord,
  sessionId: string,
  messageIds: readonly string[],
  targetTurnId?: TurnId | null,
): Promise<V4ConversationFileChangesResult> {
  const events = await record.eventStore.getEvents(sessionId as SessionId);
  // artifact 读取走闭包而不是把 record 交给下游：一来下游只允许读内容，二来回调
  // 失败时由 readConversationFileChangesFromEvents 决定「跳过该条还是整页失败」，
  // 若在这里 try 掉，下游会以为文件确实没有内容，摘要从「读失败」变成「空变更」。
  return readConversationFileChangesFromEvents({
    events,
    messageIds,
    readArtifact: async (snapshotRef) =>
      (await record.app.readToolResultArtifact(snapshotRef)).content,
    // 仅在有目标 turn 时才放这个键：undefined 键会让下游做「按 turn 过滤」而不是
    // 「整段会话」，两者在 turn-window 外的变更上结果完全不同。
    ...(targetTurnId ? { targetTurnId } : {}),
  });
}

/**
 * 冷物化时把本会话的 workflow run 从 journal 回放成 `DynamicWorkflowRunProgress` 会话事件。
 *
 *   - 只对**直接命中** record 的父会话补种：经 parentID 回落到父 record 的子会话（actor
 *     transcript）不补——journal 按父会话建键，子会话的投影不该长出父会话的 run；
 *   - 内存事件里已出现过的 runId 交给 CLI 排除（本进程跑过的 run 事件全在内存 store 里，
 *     进度事件不带 turnId、不受 turn-window 淘汰），暖物化因此零重复；
 *   - 回放失败只记日志、回空：观察面绝不让冷开失败。
 *
 * 事件 id / traceId 照 transcript hydration 的合成事件；sequenceNumber 由 cold merge 统一重排。
 */
async function replayDynamicWorkflowRunEvents(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  record: ZCodeProtocolSessionRecord,
  memoryEvents: readonly SessionEvent[],
): Promise<SessionEvent[]> {
  // 引用相等而非 id 相等：同一个 sessionId 可能刚被冷恢复换掉 record（旧 record 已
  // dispose）。若这里只比 id，会给已释放的 record 继续回放 journal，事件被写进
  // 一个没人订阅的 sink，表现为「run 进度偶尔不刷新」。
  if (context.sessions.get(sessionId) !== record) return [];
  const replay = record.app.replayDynamicWorkflowRuns;
  // 能力在 run service 构造成功时才存在。这里返回空数组而不是抛错，是因为回放属于
  // 观察面增强，冷开本身不能因此失败；真正需要区分能力缺失的读命令会显式抛
  // V4CapabilityUnsupportedError。
  if (!replay) return [];
  const excludeRunIds = new Set<string>();
  for (const event of memoryEvents) {
    if (event.type !== SessionEventType.DynamicWorkflowRunProgress) continue;
    // payload 来自历史 transcript，可能是旧版本写入的任意形状；只接受 string 的
    // runId 是为了让 exclude 集合保持精确，避免 String(undefined) 这类脏键把
    // 所有 run 都意外排除。
    const runId = (event.payload as { runId?: unknown } | undefined)?.runId;
    if (typeof runId === "string") excludeRunIds.add(runId);
  }
  let payloads: DynamicWorkflowRunProgressPayload[];
  try {
    payloads = await replay({ excludeRunIds });
  } catch (error) {
    // [失败路径] journal 可能是半写状态（进程被杀在 append 与 fsync 之间）。
    // 回放失败只降级为「本次没有 run 历史」，且必须记事件名，否则用户看到 run
    // 面板为空时无从判断是「没跑过」还是「回放坏了」。
    context.logger?.warn("v4 hydrate dynamic workflow replay failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.v4.hydrate_workflow_replay_failed",
      module: "bootstrap.zcode_protocol",
      sessionId,
    });
    return [];
  }
  // [权衡] 事件 id 用确定性的 `dwf-replay-N` 而非 createEventId：冷恢复会在同一会话上
  // 反复执行（每次订阅重开都可能进来），随机 id 会让 reducer 认为这是新事件，run 进度
  // 被重复累加。sequenceNumber 统一给 0 是把排序权交给 cold merge，本函数不猜水位。
  return payloads.map((payload, index) => ({
    id: `dwf-replay-${index + 1}` as EventId,
    sessionId: sessionId as SessionId,
    type: SessionEventType.DynamicWorkflowRunProgress,
    timestamp: new Date(0),
    traceId: HYDRATION_TRACE_ID as TraceId,
    sequenceNumber: 0,
    payload,
  }));
}

async function resolveConversationBackingRecord(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<ZCodeProtocolSessionRecord | undefined> {
  const direct = context.sessions.get(sessionId);
  if (direct) return direct;

  // 运行中 subagent 有独立 child event log，但没有独立 bootstrap record。
  // 文件摘要只需要共享 event/artifact store，因此通过持久化 parentID 找到父 record 作为
  // artifact reader，读取事件时仍显式使用 childSessionId；不能为了只读查询 cold resume
  // 第二个 child runtime。
  const stored = await context.deps.sessionStore?.getSession(sessionId as SessionId);
  const parentSessionId = stored?.parentID ? String(stored.parentID) : null;
  // 只回落到父 record，绝不继续向上递归：多层 parent 说明数据已经异常（正常 fork 只
  // 有一级），继续追会读到与本会话无关的 artifact 库，摘要串会话比没有摘要更糟。
  return parentSessionId ? context.sessions.get(parentSessionId) : undefined;
}

// 回滚预览只读 runtime 的待变更清单，不实际写文件；真正回滚由后续命令提交。
async function previewConversationFileRewind(
  record: ZCodeProtocolSessionRecord,
  messageIds: readonly string[],
  targetTurnId?: TurnId | null,
): Promise<V4ConversationFileRewindPreviewResult> {
  // 预览必须用与提交完全相同的 messageId 集合和目标 turn：若这里做任何「补齐」
  // （例如自动带上最新 turn），用户在预览里看到的文件列表就和真正回滚时不一致，
  // 而这种不一致只会在按下确认后才暴露，属于不可回滚的体验损坏。
  return record.app.runtime.previewWorkspaceFileRewind({
    targetMessageIds: messageIds as MessageId[],
    ...(targetTurnId ? { targetTurnId } : {}),
  });
}

// admission 的中间形状：只保留「写 ledger 与恢复意图」需要的字段，刻意不复用
// ConversationInputIntent。理由是 intent 里还有 delivery.dispatch / steer 等
// 由 gateway 运行时决定的状态，若在这里就带上，admission 会把「预计」写成「已发生」，
// 重启后无法区分哪些字段是客户端声明、哪些是服务端裁决。
interface InputCommandForAdmission {
  inputOrigin?: "desktop" | "mobile";
  conversationQuotes?: import("@zcode/contracts").TurnInputIntentMetadata["conversationQuotes"];
  botGroupSource?: ConversationInputIntent["botGroupSource"];
  kind: ConversationInputIntent["kind"];
  text: string;
  attachments: readonly AttachmentRef[];
  sharedContextRefs?: ConversationInputIntent["sharedContextRefs"];
  // requested 与 admitted 必须分开存：前者是客户端诉求，后者是服务端裁决，
  // 二者在 guide→queue 降级时不同，合并成一个字段就再也无法解释降级原因。
  requestedDelivery?: ConversationInputIntent["delivery"]["requested"];
  admittedDelivery?: ConversationInputIntent["delivery"]["admitted"];
  fallbackReasonCode?: string;
  highspeed?: ConversationInputIntent["highspeed"];
  provenance?: ConversationInputIntent["provenance"];
}

// 通过回调注入而不是直接 import projection：本文件的依赖方向必须保持在
// 旧目录 → v4 目录，且 handler 侧（v4）不得反过来依赖 binder 里的事务语义。
type ResolveAdmissionRowTarget = (
  sessionId: string,
  target: { rowId: number; entityId: string },
  action: "editUserQuery" | "retryTurn",
) => ConversationRowTargetResolution | null;

// [权衡] 只保留带 ref 的附件，而不是把无 ref 的也透传：无 ref 的附件是「纯文本材料」，
// 重试时重新枚举会把它当成新上传，触发第二次落盘并改变附件顺序；直接丢弃则保证
// 重试使用与原轮完全相同的引用集合（顺序与来源都不变）。
function admissionAttachmentRefs(
  attachments: NonNullable<
    Extract<ConversationRowTargetResolution, { ok: true }>["editTarget"]
  >["intent"]["attachments"],
): AttachmentRef[] {
  return (
    attachments?.flatMap((attachment) =>
      attachment.ref
        ? [
            {
              // 重试／编辑必须保留与原 row 相同的附件来源，不能重新枚举字段丢失文本材料标记。
              ...attachment,
              ref: attachment.ref,
            },
          ]
        : [],
    ) ?? []
  );
}

/**
 * admission 只持久化真正会产生输入的命令。edit/retry 不能从 payload 猜 intent；
 * 必须复用 projection 的 canonical target，并把旧来源折叠进 provenance。
 */
export function resolveInputCommandForAdmission(
  envelope: CommandEnvelope,
  admissionSessionId: string,
  resolveRowTarget: ResolveAdmissionRowTarget,
): InputCommandForAdmission | null {
  if (envelope.type === "createSession") {
    // createSession 的首条输入挂在 payload.firstInput 上，而不是复用 sendText：
    // 这两条路径的 admission 时机不同（create 时 session 还不存在），若统一走
    // sendText 分支，会先要求 sessionId 再取 payload，导致首条输入永远丢失。
    const firstInput = (
      envelope.payload as {
        firstInput?: { text: string; attachments?: AttachmentRef[] };
      }
    ).firstInput;
    return firstInput
      ? {
          kind: "sendText",
          text: firstInput.text,
          attachments: firstInput.attachments ?? [],
        }
      : null;
  }
  if (envelope.type === "createSelectionSideSession") {
    // 侧会话首输入语义上等价于 sendText，但 schema 里只有 text（不允许附件）：
    // 这里统一补空数组而不是透传 undefined，避免下游对 attachments 做可选判断时
    // 出现「有键但为 undefined」与「无键」两种形状。
    const firstInput = (
      envelope.payload as {
        firstInput?: { text: string };
      }
    ).firstInput;
    return firstInput
      ? {
          kind: "sendText",
          text: firstInput.text,
          attachments: [],
        }
      : null;
  }
  if (envelope.type === "sendText" || envelope.type === "sendGoalCommand") {
    const payload = envelope.payload as {
      text: string;
      attachments?: AttachmentRef[];
      context_refs?: ConversationInputIntent["sharedContextRefs"];
      highspeedMeta?: ConversationInputIntent["highspeed"];
      inputOrigin?: "desktop" | "mobile";
      conversationQuotes?: import("@zcode/contracts").TurnInputIntentMetadata["conversationQuotes"];
      botGroupSource?: ConversationInputIntent["botGroupSource"];
    };
    return {
      kind: envelope.type,
      text: payload.text,
      attachments: payload.attachments ?? [],
      // 每个可选字段都用「有值才展开」的写法：显式写 undefined 会让
      // conversationInputIntentSchema.parse 之后的对象带上该键，持久化 JSON 里
      // 出现 null/缺失两种形态，冷恢复的兼容分支要处理双份情况。
      ...(payload.context_refs ? { sharedContextRefs: payload.context_refs } : {}),
      ...(payload.highspeedMeta ? { highspeed: payload.highspeedMeta } : {}),
      ...(payload.inputOrigin ? { inputOrigin: payload.inputOrigin } : {}),
      ...(payload.conversationQuotes ? { conversationQuotes: payload.conversationQuotes } : {}),
      ...(payload.botGroupSource ? { botGroupSource: payload.botGroupSource } : {}),
    };
  }
  if (envelope.type === "compact") {
    // compact 的 text 固定成 "/compact" 字面量：它不是用户输入，但 ledger 需要一个
    // 可展示的文本，若留空会让侧栏的输入历史出现一条无内容记录。
    return { kind: "compact", text: "/compact", attachments: [] };
  }
  // 到这里剩下的只有 edit/retry；其余命令返回 null 表示「不写 ledger」。
  // 用反向判断而不是正向列举，是为了让未来新增的纯查询命令默认不落库（fail-safe）。
  if (envelope.type !== "editUserQuery" && envelope.type !== "retryTurn") return null;
  // edit/retry 必须带 sessionId 才能去 projection 查 canonical target；
  // 缺失时返回 null 而不是报错，让上层走「无 admission」路径，由 handler 报
  // 更精确的 guard 错误（错误码不能在这里被降级成通用失败）。
  if (!envelope.sessionId) return null;
  const payload = envelope.payload as {
    target: { rowId: number; entityId: string };
    newText?: string;
    conversationQuotes?: ConversationInputIntent["conversationQuotes"];
    attachments?: AttachmentRef[];
  };
  const resolution = resolveRowTarget(envelope.sessionId, payload.target, envelope.type);
  // 解析失败必须返回 null 而不是回退成「按 payload 文本发送」：projection 查不到这一行
  // 意味着它已被新的投影代际淘汰，此时凭 payload 继续执行会让用户编辑的是别的分支。
  if (!resolution?.ok || !resolution.editTarget) return null;
  const canonical = resolution.editTarget;

  // 会先提交 append-only branch cut，不再为 edit 创建 hidden child。
  // 同时读 provenance 与旧字段 sourceCommandId：老数据只有后者，新数据以后者为准
  // 且被折叠进 provenance，二者取到一个就够，缺失则意味着这条 intent 无法回溯来源。
  const originalSourceCommandId =
    canonical.intent.provenance?.sourceCommandId ?? canonical.intent.sourceCommandId;
  return {
    kind: canonical.intent.kind,
    ...(canonical.intent.inputOrigin ? { inputOrigin: canonical.intent.inputOrigin } : {}),
    // 引用（conversationQuotes）优先用本次请求里的：用户可能重新框选了引用，
    // 但其余身份字段仍必须取 canonical，避免「换了引用就换了来源」。
    ...((payload.conversationQuotes ?? canonical.intent.conversationQuotes)
      ? { conversationQuotes: payload.conversationQuotes ?? canonical.intent.conversationQuotes }
      : {}),
    ...(canonical.intent.botGroupSource ? { botGroupSource: canonical.intent.botGroupSource } : {}),
    // [权衡] 只有 editUserQuery 才允许用 payload.newText 覆盖文本，retryTurn 永远复用
    // 原文本。若 retry 也接受 newText，用户在重试接口上的一次误传就会静默改写历史提问。
    text:
      envelope.type === "editUserQuery"
        ? (payload.newText ?? canonical.intent.text)
        : canonical.intent.text,
    // 编辑时若客户端显式给了附件集合就用它（用户可能增删附件），否则回落到原行里
    // 带 ref 的附件；绝不能两者合并，否则被删掉的附件会「复活」。
    attachments:
      envelope.type === "editUserQuery" && payload.attachments
        ? payload.attachments
        : admissionAttachmentRefs(canonical.intent.attachments),
    ...(canonical.intent.requestedDelivery
      ? { requestedDelivery: canonical.intent.requestedDelivery }
      : {}),
    ...(canonical.intent.admittedDelivery
      ? { admittedDelivery: canonical.intent.admittedDelivery }
      : {}),
    ...(canonical.intent.fallbackReasonCode
      ? { fallbackReasonCode: canonical.intent.fallbackReasonCode }
      : {}),
    // provenance 只在能取到来源命令 id 时构造：空 provenance 对象会通过 schema，
    // 但下游会据此认为「这是一个有来源但没有 id 的输入」，诊断面板显示成空链接。
    ...(originalSourceCommandId
      ? {
          provenance: canonical.intent.provenance ?? {
            sourceCommandId: originalSourceCommandId,
            ...(canonical.intent.queueItemId ? { queueItemId: canonical.intent.queueItemId } : {}),
            ...(canonical.intent.clientId ? { clientId: canonical.intent.clientId } : {}),
          },
        }
      : {}),
  };
}

// 只有真正产生用户输入的命令需要 admission 持久化；纯查询/控制命令返回 null。
// [权衡] 白名单写死在这里而不是放到 CommandEnvelope 的元数据里：命令表是协议契约，
// 新增命令时若忘记标注「是否产生输入」，代价是跳过 admission、重启后输入丢失；
// 而忘记更新这里只影响诊断完整性，把风险留在本文件比扩散到 contracts 更可控。
export function isConversationInputAdmissionCommand(type: CommandEnvelope["type"]): boolean {
  return (
    type === "sendText" ||
    type === "sendGoalCommand" ||
    type === "compact" ||
    type === "editUserQuery" ||
    type === "retryTurn"
  );
}

function buildForkInitialInput(
  envelope: CommandEnvelope,
  childSessionId: string,
  admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  input: InputCommandForAdmission,
): ForkCommitBundle["initialInput"] {
  const requested = input.requestedDelivery ?? "startNow";
  const fallbackReasonCode = input.fallbackReasonCode;
  // 三态推导：显式 fallback 必须落到 queue（说明运行时已拒绝原意图），auto 才展开成
  // startNow，其余原样透传。若把 auto 也原样写入，下游拿到一个不认识的 delivery 值，
  // 队列插入点会退化成「忽略该输入」。
  const admitted =
    input.admittedDelivery ??
    (fallbackReasonCode ? "queue" : requested === "auto" ? "startNow" : requested);
  // 这里必须过 schema.parse 而不是 as：intent 会原样进入 child 的 transcript，
  // 形状错误只会在下一次冷恢复读出来时炸，届时分叉早已提交，无法回退。
  const intent = conversationInputIntentSchema.parse({
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId: envelope.clientId || "cli",
    kind: input.kind,
    ...(input.inputOrigin ? { inputOrigin: input.inputOrigin } : {}),
    ...(input.conversationQuotes ? { conversationQuotes: input.conversationQuotes } : {}),
    ...(input.botGroupSource ? { botGroupSource: input.botGroupSource } : {}),
    text: input.text,
    attachments: input.attachments,
    delivery: {
      requested,
      admitted,
      ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
    },
    order: { admissionSeq: admission.admissionSeq },
    // steer.state 与 delivery 必须是同一份判断：出现 fallbackReasonCode 就说明原意图
    // （guide）没被接受，此时再写 notRequested 会让 UI 显示「从没要求过 steer」，
    // 而 delivered 的文本其实进了队列，用户找不到这份输入去了哪。
    steer: fallbackReasonCode
      ? { state: "fellBack", reasonCode: fallbackReasonCode }
      : { state: "notRequested" },
    dispatch: { state: "admitted" },
    admittedAt: admission.admittedAt,
    ...(input.highspeed ? { highspeed: input.highspeed } : {}),
    ...(input.provenance ? { provenance: input.provenance } : {}),
  });
  return {
    id: admission.queueItemId,
    sessionID: childSessionId as SessionId,
    kind: intent.kind,
    delivery: intent.delivery.admitted,
    payload: {
      text: intent.text,
      conversationInputIntent: intent,
      attachments: intent.attachments,
      // sourceCommandType 保留 envelope 原始类型而不是 intent.kind：edit/retry 在
      // intent 里被归一成 sendText，只有原始类型才能让调试面板还原用户点的是哪个命令。
      sourceCommandType: envelope.type,
    },
  };
}

async function recordForkStartFailureBestEffort(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  command: Pick<CommandEnvelope, "commandId">,
  error: unknown,
  details: { parentSessionId?: string; registrationRequired?: boolean } = {},
): Promise<void> {
  const store = context.deps.sessionStore;
  const record = context.sessions.get(sessionId);
  const now = Date.now();
  const message = error instanceof Error ? error.message : String(error);
  // [失败路径] warn 包了自己的 try：这条函数整体运行在 PONR 之后，日志 sink 抛错
  // 若冒泡出去，gateway 会把「已经 durable 的子会话」当命令失败处理，durable 事实
  // 与用户看到的终态直接反了。这是 INV-22 的唯一执行点。
  const warn = (stage: string, failure: unknown) => {
    try {
      context.logger?.warn("fork child post-commit failure recording degraded", {
        commandId: command.commandId,
        error: failure instanceof Error ? failure.message : String(failure),
        forkedSessionId: sessionId,
        parentSessionId: details.parentSessionId,
        stage,
      });
    } catch {
      // 日志 sink 失败也属于 post-commit；durable child/fact 不得因此反转。
    }
  };

  // 三段写入刻意互相独立（ledger → session_entry → TurnError 事件），每段各自 catch：
  // 它们对应的读面不同（队列诊断、会话条目、时间线），任何一段失败都不该取消后两段，
  // 否则「有子会话但没有失败痕迹」的状态会同时存在于三个面里。
  try {
    await store?.settleSessionInput?.({
      id: queueItemIdForCommand(command.commandId),
      sessionID: sessionId as SessionId,
      status: "failed",
      // 原因码固定：队列项失败原因参与重启后的 discarded 统计，这里只表达
      // 「子会话启动失败」，不把底层 error message 混进可聚合维度。
      reason: "fault.command.childStartFailed",
    });
  } catch (failure) {
    warn("ledger", failure);
  }
  try {
    await store?.saveSessionEntry?.({
      id: `v4_fork_start_failure:${command.commandId}`,
      sessionID: sessionId as SessionId,
      type: "v4/fork_start_failure",
      time: { created: now, updated: now },
      data: {
        commandId: command.commandId,
        forkedSessionId: sessionId,
        parentSessionId: details.parentSessionId,
        ...(details.registrationRequired ? { registrationRequired: true } : {}),
        retryable: true,
        status: "failed",
        reasonCode: "fault.command.childStartFailed",
        message,
      },
    });
  } catch (failure) {
    warn("entry", failure);
  }
  if (!record) return;
  try {
    const event: SessionEvent = {
      id: createEventId(),
      sessionId: sessionId as SessionId,
      type: SessionEventType.TurnError,
      timestamp: new Date(now),
      traceId: record.traceContext.traceId,
      // 重新读一次水位再 +1：前面两段 await 期间 eventStore 可能已被 live turn 推进，
      // 用函数入口时的快照号会与已有事件撞号，冷恢复排序时该 TurnError 被丢弃。
      sequenceNumber: (await record.eventStore.getLatestSequenceNumber(sessionId as SessionId)) + 1,
      payload: {
        inputId: command.commandId,
        // turnPhase 标成 fork_child_start 而不是普通 turn 阶段：UI 据此走「子会话
        // 启动失败」的重试文案，而不是「模型调用失败」。
        turnPhase: "fork_child_start",
        error: {
          type: "fault.command.childStartFailed",
          message,
          // retryable 恒为 true：子会话已 durable，重试只是重建 runtime，
          // 不会产生第二棵分支，因此这里的可重试性由 commit 阶段决定，而非错误本身。
          retryable: true,
        },
      },
    };
    const persisted = await record.eventStore.append(event);
    context.v4Gateway?.ingest(sessionId, persisted);
  } catch (failure) {
    warn("event", failure);
  }
}

/**
 * Fork bundle commit 是命令 PONR；后续 catalog/model/resume/snapshot 仅恢复 runtime 可达性。
 * 该阶段失败必须留下可重试事实与 warning，但不能把 durable accepted child 反转成 failed。
 */
export async function registerCommittedForkBestEffort(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  fork: Parameters<typeof registerForkedSession>[2],
  options: Parameters<typeof registerForkedSession>[3] & { commandId: string },
  register: typeof registerForkedSession = registerForkedSession,
): Promise<void> {
  const { commandId, ...registrationOptions } = options;
  try {
    await register(context, record, fork, registrationOptions);
  } catch (error) {
    const forkedSessionId = String(fork.forkedSessionId);
    // parentSessionId 回落用 record.app.sessionId 而不是 record 上的字段：fork 的
    // 父身份在 durable bundle 里可能是显式 null（例如侧会话），此时用执行侧 record
    // 才能让诊断指向真正发起分叉的会话。
    const parentSessionId = String(fork.parentSessionId ?? record.app.sessionId);
    await recordForkStartFailureBestEffort(context, forkedSessionId, { commandId }, error, {
      parentSessionId,
      registrationRequired: true,
    });
    // 这个 logger 也包 try：它是 PONR 之后最后一个可能抛错的点，一旦冒泡，
    // 前面的 best-effort 事实写入就白做了（命令仍会被 settle 成 failed）。
    try {
      context.logger?.warn("fork child registration failed after durable commit", {
        commandId,
        error: error instanceof Error ? error.message : String(error),
        forkedSessionId,
        parentSessionId,
        retryable: true,
      });
    } catch {
      // logger 自身异常过去会越过 PONR 冒泡，让 gateway 错误 settle 为 failed。
    }
  }
}

/** turn 终态耗时持久化所需的窄化上下文；结构化类型保证与完整 server context 兼容。 */
export interface HighspeedTurnTerminalPersistenceContext {
  sessions: Map<
    string,
    { eventStore: SessionEventStorePort; traceContext: { traceId: string | number } }
  >;
  deps: { sessionStore?: SessionStorePort };
  v4Gateway?: { ingest(sessionId: string, event: SessionEvent): unknown };
  logger?: { warn(message: string, data?: Record<string, unknown>): void };
}

/**
 * turn 终态钩子：把投影累计的真实耗时拆分落到 transcript 的 metadata.highspeed。
 * Bug 根因（2026-08-31 审计 #1）：该钩子由 gateway 对所有 TurnComplete/TurnError 触发，
 * 且投影对普通 turn 也写入 modelDurationMs/toolDurationMs，原“双 undefined 才返回”的
 * 守卫永不生效——每个普通 turn 终态都会先做一次全量 sessionStore.messages() 扫描，
 * 最后才因 metadata.highspeed 缺失返回，长会话热路径白白承担 O(N) I/O。
 * userInput row 自带持久化的 highspeed 身份，进入扫描前先按它短路。
 */
export function persistHighspeedTimingOnTurnTerminal(
  context: HighspeedTurnTerminalPersistenceContext,
  sessionId: string,
  event: SessionEvent,
  snapshot: ConversationSnapshot,
): void {
  const record = context.sessions.get(sessionId);
  const sessionStore = context.deps.sessionStore;
  const payload = event.payload as { inputId?: unknown; duration?: unknown };
  // [失败路径] 只接受 string 的 inputId：终态事件可能来自重放或旧版本写入，数字 id
  // 与 undefined 在这里都会让下面的行匹配退化成「按 turnId 找」，
  // 而 turnId 在 steer 之后不再唯一，必须显式排除而不是 String() 强转。
  const inputId = typeof payload.inputId === "string" ? payload.inputId : undefined;
  const header = snapshot.rows.window
    .filter(
      (row): row is Extract<(typeof snapshot.rows.window)[number], { kind: "turnHeader" }> =>
        row.kind === "turnHeader" &&
        (inputId === undefined
          ? row.turnId === String(event.turnId)
          : row.sourceCommandId === inputId),
    )
    // 取最后一条：同一 commandId 可能因重试在窗口里出现多个 turnHeader，
    // 终态耗时只属于最近一次执行，取首条会把上一轮的耗时反复累加。
    .at(-1);
  // 四道早退的顺序即 INV-10：先判上下文是否存在（避免无谓查询），再用 userInput 的
  // highspeed 身份短路（普通 turn 占绝大多数），最后才看耗时字段是否真的存在。
  if (!record || !sessionStore || !header?.sourceCommandId) return;
  const user = snapshot.rows.window.find(
    (row) => row.kind === "userInput" && row.sourceCommandId === header.sourceCommandId,
  );
  if (!user || user.kind !== "userInput") return;
  if (!user.highspeed) return;
  // 两个耗时都为 undefined 说明本轮没有任何计时样本（例如极短 turn 被合并），
  // 此时写 0 会把上一轮已持久化的真实耗时覆盖成 0，宁可整条跳过。
  if (header.modelDurationMs === undefined && header.toolDurationMs === undefined) {
    return;
  }
  void persistHighspeedTiming({
    sessionStore,
    eventStore: record.eventStore,
    sessionId,
    sourceCommandId: header.sourceCommandId,
    timing: {
      // 缺失的耗时补 0 而不是省略：highspeed 行一旦写入就是「完整快照」语义，
      // 省略字段会让冷恢复后的 UI 无法区分「本轮没花时间」与「这个维度没采集」。
      modelDurationMs: header.modelDurationMs ?? 0,
      toolDurationMs: header.toolDurationMs ?? 0,
      otherDurationMs: header.otherDurationMs ?? 0,
    },
    ...(header.outputTokens !== undefined ? { outputTokens: header.outputTokens } : {}),
    ...(header.activeMs !== undefined ? { durationMs: header.activeMs } : {}),
    // fallbackAt 只存在于 live 投影：终态一并写入 transcript，HighspeedMetricsUpdated 与 cold
    // hydration 才不会丢掉它（spec §5）。
    ...(user.highspeed.fallbackAt !== undefined ? { fallbackAt: user.highspeed.fallbackAt } : {}),
    ...(user.highspeed.fallbackReason !== undefined
      ? { fallbackReason: user.highspeed.fallbackReason }
      : {}),
    traceId: String(record.traceContext.traceId),
    // 落库事件必须回灌 gateway，否则同进程内的投影要等下一次 snapshot 才能看到
    // 这次耗时，用户在当前会话里看到的是旧的计时条。
    onPersistedEvent: (persisted) => context.v4Gateway?.ingest(sessionId, persisted),
    // [失败路径] live 投影失败只降级为日志：持久化已经成功，回滚它会造成
    // 「磁盘有、内存没有」，冷恢复后反而更一致，因此这里不能让错误冒泡成 turn 失败。
    onLiveProjectionError: (error) =>
      context.logger?.warn("v4 highspeed timing live projection failed", {
        error: error instanceof Error ? error.message : String(error),
        sessionId,
      }),
  }).catch((error) => {
    // 整体 fire-and-forget：这个钩子由 gateway 在所有 TurnComplete/TurnError 上同步调用，
    // 返回 promise 会被丢弃；不 catch 会变成 unhandledRejection 直接打崩进程。
    context.logger?.warn("v4 highspeed timing persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      sessionId,
    });
  });
}

// 把域无关的 ConversationV4Gateway 绑定到协议 server 上下文：帧出口走 context.notify
// 的 NDJSON 通知，命令交给 V4CommandExecutor 直驱 core；过渡期钩子在此注入旧实现，
// 依赖方向保持「旧目录 → v4 目录」单向。
export function createConversationV4Gateway(
  context: ZCodeProtocolAgentServerContext,
): ConversationV4Gateway {
  const log = createProtocolLogger(context.deps)?.child({
    module: "bootstrap.zcode_protocol_v4_gateway",
  });
  // PersistentCommandIndex 是「命令去重 + 断线重放」的唯一事实入口：它按 session
  // 惰性建索引，四个读面（transcript/timeline/child/discarded）共用一次加载结果，
  // 若各面各自去 store 读，重复 commandId 会在不同面得到不同结论。
  const persistentCommands = new PersistentCommandIndex({
    loadSession: async (sessionId) => {
      const live = context.sessions.get(sessionId);
      const stored = await context.deps.sessionStore?.getSession(sessionId as SessionId);
      // live 与 stored 都没有就必须返回 null：返回空对象会让索引认为「这个会话确实
      // 没有任何命令」，之后的重放请求一律判为重放失败，而不是「会话不存在」。
      if (!live && !stored) return null;
      // workspacePath 优先取 live record：stored.directory 可能是规范化前的旧路径，
      // 用它做索引键会让同一会话在重启前后落到两个 workspace 分片。
      const workspacePath = live?.workspace.workspacePath ?? stored?.directory;
      if (!workspacePath) return null;
      const workspaceIdentity = live?.workspace.workspaceIdentity ?? stored?.workspaceID;
      const facts = context.deps.sessionStore
        ? await loadPersistentCommandFacts(context.deps.sessionStore, sessionId as SessionId, {
            // [权衡] 冷会话加载时丢弃 admitted 但未 settle 的事实：它们属于上一个进程
            // 的在途命令，恢复后无法再执行；保留会让客户端收到「已接纳」却永远没有结果。
            // live 会话则必须保留，因为本进程仍会给出终态。
            discardAdmittedOnLoad: !live,
          })
        : undefined;
      return {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity: String(workspaceIdentity) } : {}),
        ...(facts ? { facts } : {}),
      };
    },
  });
  let nativeExecutor: V4CommandExecutor;
  // 每个 session 只挂一个重试 timer：不去重的话，一次 busy 期间到达 N 条队列变更
  // 会生成 N 个 100ms 回调，全部在空闲瞬间并发执行 sendQueuedNow，前 N-1 个
  // 会撞上 lease 失败并再次排期，形成忙等风暴。
  const autoDrainRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Highspeed 执行材料含临时凭据：只按 session/sourceCommandId 驻留内存，绝不进入
  // TurnSteerQueued、snapshot 或 transcript。CLI 重启后缺失时队列提升自动走原模型。
  const queuedTurnExecutions = new Map<string, Map<string, V4QueuedTurnExecution>>();
  // 自动提升队首只在 session 真正空闲且 goal 终态可证时执行；busy 或 target 未知
  // 时挂 100ms 重试，绝不抢占前台执行，也不越过暂停的 FIFO barrier。
  const autoDrainV4QueueIfReady = async (record: ZCodeProtocolSessionRecord): Promise<void> => {
    const head = context.v4Gateway?.getQueueHead(record.app.sessionId);
    if (!head) {
      // 外层恢复 FIFO 已消费到空；guide 仍只由 core tool-batch 边界行内消费。
      // 这里必须显式 complete 一次，否则 blocked/queue-active 的派发锁会一直挂着，
      // 后续新输入会被判定为「仍有外层恢复在进行」而拒绝启动。
      record.app.completeExternalQueueDrain();
      return;
    }
    const coreForegroundBusy = record.app.runtime.getActiveForegroundExecutionId() !== undefined;
    if (
      head.autoDrain &&
      head.dispatchState === "queued" &&
      (record.activeAbortController !== undefined || coreForegroundBusy)
    ) {
      // Bootstrap controller 不覆盖 model-only notification；旧 auto-drain
      // 只看外层锁，因而把“空闲后消费”错误执行成抢占。busy 时不碰 reservation。
      // 注意这里两个 busy 源必须同时看：activeAbortController 覆盖 bootstrap 侧 turn，
      // getActiveForegroundExecutionId 覆盖 core 侧（工具批/子代理）尚未回到 bootstrap 的执行。
      scheduleAutoDrainRetry(record);
      return;
    }
    let targetStatus: GoalStatus | null = null;
    if (head.autoDrain && head.dispatchState === "queued" && !record.activeAbortController) {
      try {
        targetStatus = (await record.app.readTarget())?.status ?? null;
      } catch (error) {
        // target 读取失败时按“未知且未完成”处理；直接提升会让
        // goal verification 的持久终态尚未可证时普通 queue 偷跑。
        context.logger?.warn("v4 auto-drain held because target state could not be read", {
          error: error instanceof Error ? error.message : String(error),
          queueItemId: head.queueItemId,
          sessionId: record.app.sessionId,
        });
        // 不排重试：target 读失败通常是持久层故障，按 100ms 轮询只会放大 I/O；
        // 下一次真实状态变更（afterLegacyStateMutation / target completed）会自然重入。
        return;
      }
    }
    if (
      !shouldAutoDrainV4QueueHead({
        autoDrain: head.autoDrain,
        dispatchState: head.dispatchState,
        sessionBusy: Boolean(record.activeAbortController) || coreForegroundBusy,
        targetStatus,
      })
    ) {
      return;
    }
    // 暂停队列恢复后，旧项只存在于投影而不在新 activeTurn 内存中；普通文本也必须
    // 和 typed /goal、/compact 一样走完整投影的队首，避免新输入越过旧暂停项。
    try {
      await nativeExecutor.execute(
        {
          baseRevision: 0,
          clientId: "v4-auto-drain",
          commandId: `auto-${head.kind}-${Date.now()}-${head.queueItemId}`,
          issuedAt: Date.now(),
          payload: { queueItemId: head.queueItemId },
          sessionId: record.app.sessionId,
          type: "sendQueuedNow",
        },
        undefined,
        { autoDrainPromotion: true },
      );
    } catch (error) {
      if (error instanceof V4QueuePromotionLeaseUnavailableError) {
        // precheck 与 handler 之间可能新入队 notification；idle-only 是最终原子判据。
        // 这一类错误是「预期内」的竞争，不能暂停队列：一旦 setQueueAutoDrain(false)，
        // 用户会看到队列莫名暂停，而后面的输入其实都还排得好好的。
        scheduleAutoDrainRetry(record);
        return;
      }
      // 自动提升失败不能继续越过该 FIFO barrier；重新暂停并保留原项，交用户重试。
      // 这里刻意不 rethrow：外层调用点（afterLegacyStateMutation）在 turn 收尾路径上，
      // 抛出去会把「队列暂停」升级成「本轮 turn 失败」，掩盖真正的失败原因。
      await record.app.setQueueAutoDrain(false);
      context.logger?.warn("v4 auto-drain failed and queue was paused", {
        error: error instanceof Error ? error.message : String(error),
        queueItemId: head.queueItemId,
        sessionId: record.app.sessionId,
      });
    }
  };
  // 延迟 100ms 是经验值：既要让当前 turn 的 abort / complete 回调先跑完（同 tick 内
  // 排期会在 controller 还没清理时重入），又不能长到用户感知出「队列卡了一下」。
  const scheduleAutoDrainRetry = (record: ZCodeProtocolSessionRecord): void => {
    const sessionId = record.app.sessionId;
    // 去重是 INV-12 的前半段；后半段是下面的 delete-before-run。
    if (autoDrainRetryTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      autoDrainRetryTimers.delete(sessionId);
      // 定时器持有的是旧 record：期间会话可能已被关闭并重建（context.sessions 换成
      // 新对象）。引用不等就直接退出，否则会给已 dispose 的 record 触发 turn。
      if (context.sessions.get(sessionId) !== record) return;
      void autoDrainV4QueueIfReady(record).catch((error: unknown) => {
        context.logger?.warn("v4 auto-drain idle reevaluation failed", {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });
      });
    }, 100);
    // unref 让待触发的重试不阻止 CLI 退出：100ms 的排期在进程收尾时很容易剩下一个，
    // 没有 unref 时 node 会为了它多等一个事件循环轮次，表现为 Ctrl+C 后卡顿一下。
    timer.unref?.();
    autoDrainRetryTimers.set(sessionId, timer);
  };
  const coreHost: V4CommandCoreHost = {
    // 同一注册表对象引用：view 是旧 record 的结构化窄视图，字段变更双向可见。
    getRecord: (sessionId) => context.sessions.get(sessionId),
    // 同一登记表实例：broker（旧目录）注册反向请求 deferred，
    // v4 resolveInteraction handler 经此投递应答（v4 原生基础设施，非过渡钩子）。
    interactions: context.v4Interactions,
    logger: {
      info: (message, fields) => context.logger?.info(message, fields),
      warn: (message, fields) => context.logger?.warn(message, fields),
    },
    // v4 原生能力（非过渡钩子）：sendQueuedNow 必须读取 v4 投影里的完整 intent。
    // 命令执行时 context.v4Gateway 已由 server 注入（createConversationV4Gateway
    // 返回值回填），这里惰性取用避免构造期自引用。
    getQueueItem: (sessionId, queueItemId) =>
      context.v4Gateway?.getQueueItem(sessionId, queueItemId) ?? null,
    hasQueueItemKind: (sessionId, kind) =>
      context.v4Gateway?.hasQueueItemKind(sessionId, kind) ?? false,
    hasQueuedDelivery: (sessionId, delivery) =>
      context.v4Gateway?.hasQueuedDelivery(sessionId, delivery) ?? false,
    // 队列长度与「有没有某类项」都从投影读，而不是在 binder 里再维护一份计数：
    // 双份计数一旦与投影分叉，queue/start 的去重判断就会与 UI 看到的队列不一致。
    getQueueLength: (sessionId) => context.v4Gateway?.getQueueLength(sessionId) ?? 0,
    // [资源] 高频执行材料按 session → sourceCommandId 两层索引：外层用 session 是为了
    // 会话关闭时能整表清理，内层用 commandId 是为了 steer 后同一 session 里仍能按
    // 具体输入精确取回。扁平键（`session:command`）无法做 O(1) 的整会话释放。
    retainQueuedTurnExecution: (sessionId, sourceCommandId, execution) => {
      const sessionExecutions = queuedTurnExecutions.get(sessionId) ?? new Map();
      sessionExecutions.set(sourceCommandId, execution);
      queuedTurnExecutions.set(sessionId, sessionExecutions);
    },
    readQueuedTurnExecution: (sessionId, sourceCommandId) =>
      queuedTurnExecutions.get(sessionId)?.get(sourceCommandId),
    deleteQueuedTurnExecution: (sessionId, sourceCommandId) => {
      const sessionExecutions = queuedTurnExecutions.get(sessionId);
      sessionExecutions?.delete(sourceCommandId);
      // 空 Map 必须一并删除：否则「曾经有过高频 turn」的每个会话都会在外层留下一个
      // 空条目，长时间运行的 CLI 里等于按会话数线性泄漏（INV-12）。
      if (sessionExecutions?.size === 0) queuedTurnExecutions.delete(sessionId);
    },
    clearQueuedTurnExecutions: (sessionId) => {
      queuedTurnExecutions.delete(sessionId);
    },
    waitForProjectionEventCommit: (sessionId, eventId, options) => {
      const gateway = context.v4Gateway;
      if (!gateway) {
        return Promise.reject(new Error("v4 gateway unavailable for projection commit wait"));
      }
      return gateway.waitForProjectionEventCommit(sessionId, eventId, options);
    },
    admitInputCommand: async (envelope, sessionId, admission) => {
      // store 不支持 ledger（纯内存模式）时返回 null 表示「没有账本」，
      // 而不是写一份假记录：handler 会把它当作 no-op，命令照常执行。
      if (!context.deps.sessionStore?.saveSessionInput) return null;
      // 解析必须在这里做一次并把 canonical target 带下去：若让 handler 自己再解析，
      // edit 在两次解析之间可能已被新的投影代际改写，ledger 与执行就会指向不同行（INV-5）。
      const input = resolveInputCommandForAdmission(
        envelope,
        sessionId,
        (sourceSessionId, target, action) =>
          context.v4Gateway?.resolveRowActionTarget(sourceSessionId, target, action) ?? null,
      );
      if (!input) return null;
      const kind = input.kind;
      const record = context.sessions.get(sessionId);
      if (record?.persistence === "deferred") {
        // session_input 有 session 外键；draft 要到 startPromptTurn 后台阶段才持久化，
        // 如果先写 ledger 会直接 FK 失败，accepted 前仍没有权威记录。因此 admission
        // 先走 runtime 的统一首发持久化边界，再落 ledger，随后 handler 只负责执行。
        await record.app.runtime.ensureSessionPersistedForExternalActivity(input.text ?? "", {
          traceContext: record.traceContext,
        });
        // 持久化成功后立刻改标记：这是本地状态缓存，若留到 handler 再改，
        // 同一命令重试时会第二次走 ensure 路径（它是幂等的，但会多一次空 turn 提交）。
        record.persistence = "immediate";
      }
      const routingMode = context.v4Gateway?.getInputRoutingMode(sessionId) ?? null;
      // 这是执行前账本的“预计投递边界”；TurnSteerQueued 会用实际 delivery/回退原因
      // 幂等更新同一记录。startNow 不能伪装成 queue，否则重启 discarded 的诊断事实失真。
      const requestedDelivery =
        input.requestedDelivery ??
        (kind === "compact" && routingMode !== null && routingMode !== "startNow"
          ? "queue"
          : routingMode === "enqueue"
            ? "queue"
            : routingMode === "guide" && kind === "sendText"
              ? "guide"
              : "startNow");
      const attachmentRefs = input.attachments;
      // [权衡] 附件不支持 guide 是 core 的硬限制，必须在 admission 阶段就降级成 queue 并
      // 打上原因码：如果留给 handler 抛错，用户看到的是「输入失败」而不是「已排队」，
      // 而这份输入其实完全可执行，只是不能插进当前 turn 的工具批之间。
      const fallbackReasonCode =
        input.fallbackReasonCode ??
        (requestedDelivery === "guide" && attachmentRefs.length > 0
          ? "guide.attachmentsUnsupported"
          : undefined);
      const admittedDelivery =
        input.admittedDelivery ??
        (fallbackReasonCode
          ? "queue"
          : requestedDelivery === "auto"
            ? "startNow"
            : requestedDelivery);
      const conversationInputIntent = conversationInputIntentSchema.parse({
        ...(input.inputOrigin ? { inputOrigin: input.inputOrigin } : {}),
        ...(input.conversationQuotes ? { conversationQuotes: input.conversationQuotes } : {}),
        ...(input.botGroupSource ? { botGroupSource: input.botGroupSource } : {}),
        sourceCommandId: envelope.commandId,
        queueItemId: admission.queueItemId,
        // 空 clientId 回落成 "cli" 而不是保留空串：provenance 里空串会被当作
        // 「客户端主动声明自己无名」，诊断与去重都会缺少可归属维度。
        clientId: envelope.clientId || "cli",
        kind,
        text: input.text ?? "",
        attachments: attachmentRefs,
        ...(input.sharedContextRefs ? { sharedContextRefs: input.sharedContextRefs } : {}),
        delivery: {
          requested: requestedDelivery,
          admitted: admittedDelivery,
          ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
        },
        order: { admissionSeq: admission.admissionSeq },
        // steer.state 必须与 delivery 同步落到 fellBack：只写 delivery 的话，
        // 断线重放的客户端会看到「投递方式已变」但「没有发生回退」的矛盾投影。
        steer: fallbackReasonCode
          ? { state: "fellBack", reasonCode: fallbackReasonCode }
          : requestedDelivery === "guide"
            ? { state: "submitting" }
            : { state: "notRequested" },
        dispatch: { state: "admitted" },
        admittedAt: admission.admittedAt,
        ...(input.highspeed ? { highspeed: input.highspeed } : {}),
        ...(input.provenance ? { provenance: input.provenance } : {}),
      });
      await context.deps.sessionStore.saveSessionInput({
        id: admission.queueItemId,
        sessionID: sessionId as SessionId,
        kind,
        delivery: conversationInputIntent.delivery.admitted,
        // payload 是「扁平摘要 + 完整 intent」两份：扁平字段供 SQL 侧直接筛选
        // （按 kind / delivery 查），intent 供冷恢复还原全部语义。只留其一都会让
        // 恢复端不得不再 parse 一次字符串化 JSON，或在 SQL 里做 JSON 提取。
        payload: {
          text: conversationInputIntent.text,
          intent: {
            sourceCommandId: conversationInputIntent.sourceCommandId,
            queueItemId: conversationInputIntent.queueItemId,
            clientId: conversationInputIntent.clientId,
            kind: conversationInputIntent.kind,
            admissionSeq: admission.admissionSeq,
            admittedAt: admission.admittedAt,
            requestedDelivery: conversationInputIntent.delivery.requested,
            admittedDelivery: conversationInputIntent.delivery.admitted,
            ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
            attachmentRefs,
            ...(conversationInputIntent.sharedContextRefs
              ? { sharedContextRefs: conversationInputIntent.sharedContextRefs }
              : {}),
          },
          conversationInputIntent,
          attachments: attachmentRefs,
          ...(conversationInputIntent.sharedContextRefs
            ? { sharedContextRefs: conversationInputIntent.sharedContextRefs }
            : {}),
          sourceCommandType: envelope.type,
        },
      });
      if (
        conversationInputIntent.sharedContextRefs?.length &&
        // [并发] 只有「立即执行」才在这里占用引用：排队项的引用要等到真正提升时再由
        // startQueuedTurn 占用，否则一条可能被取消的排队输入会长期把上下文锁成 reserved。
        conversationInputIntent.delivery.admitted !== "startNow"
      ) {
        const reference = conversationInputIntent.sharedContextRefs[0]!;
        // CAS 语义：只有 pending → reserved 成功才算「本条命令独占了这个引用」。
        // 用 transition 而不是 update 的原因是两个客户端同时发送同一上下文时，
        // 后到者必须失败而不是静默覆盖 sourceId（否则先到者取消时会误放引用）。
        const reserved = await context.deps.sessionStore.transitionSharedContextImport?.({
          sessionID: sessionId as SessionId,
          contextId: reference.context_id,
          expectedStatus: "pending",
          status: "reserved",
          sourceId: admission.queueItemId,
        });
        if (!reserved) {
          // [失败路径] ledger 已经写入了 admitted，这里必须显式置 failed：仅抛错会让
          // 命令终态为 failed、账本却停在 "已接纳"，重启后的 discarded 诊断多出一条
          // 永远不会消费的输入。
          await context.deps.sessionStore.settleSessionInput?.({
            id: admission.queueItemId,
            sessionID: sessionId as SessionId,
            status: "failed",
            reason: "shared_context_not_attachable",
          });
          throw new Error("fault.command.sharedContextNotAttachable");
        }
        const entry = (
          await context.deps.sessionStore.sessionEntries?.({
            sessionID: sessionId as SessionId,
            type: "v4/shared_context_import",
          })
        )?.find((candidate) => {
          const data = candidate.data;
          return Boolean(
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            (data as Record<string, unknown>).contextId === reference.context_id,
          );
        });
        const data = entry?.data;
        const session = await context.deps.sessionStore.getSession(sessionId as SessionId);
        // 展示信息（标题 / shareUrl）失败只影响侧栏富文本，不影响引用本身已经 reserved
        // 的事实，因此这里用可选链而不是抛错：抛出去会让刚成功的 admission 变成失败，
        // 而 reservation 已经落库，反而要再走一次手工清理。
        if (
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          typeof (data as Record<string, unknown>).shareUrl === "string" &&
          session?.title
        ) {
          context.v4Gateway?.updateSharedContextImport(sessionId, {
            contextId: reference.context_id,
            title: session.title,
            shareUrl: String((data as Record<string, unknown>).shareUrl),
            status: "reserved",
          });
        }
      }
      return conversationInputIntent;
    },
    cancelInputCommand: async (sessionId, queueItemId, reason) => {
      // 先 settle ledger 再释放引用：反过来会在两步之间留下「引用已 released、账本仍
      // admitted」的窗口，此时进程被杀，重启后该命令既不会执行也不会被丢弃。
      await context.deps.sessionStore?.settleSessionInput?.({
        id: queueItemId,
        sessionID: sessionId as SessionId,
        status: "cancelled",
        reason,
      });
      const store = context.deps.sessionStore;
      const entries = await store?.sessionEntries?.({
        sessionID: sessionId as SessionId,
        type: "v4/shared_context_import",
      });
      // 只认 sourceId 精确匹配、且状态仍为 reserved 的条目：同一上下文可能被别的
      // 排队项 reserve 过，只按 contextId 释放会替别人解锁（INV-15）。
      const reserved = entries?.find((entry) => {
        const data = entry.data;
        return Boolean(
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          (data as Record<string, unknown>).status === "reserved" &&
          (data as Record<string, unknown>).sourceId === queueItemId,
        );
      });
      const contextId =
        reserved?.data && typeof reserved.data === "object"
          ? (reserved.data as Record<string, unknown>).contextId
          : undefined;
      if (typeof contextId === "string") {
        // expectedStatus 必须是 reserved：若期间已被 startQueuedTurn 消费成 consumed，
        // 这次回滚会把它改回 pending，导致同一上下文被第二次导入。
        await store?.transitionSharedContextImport?.({
          sessionID: sessionId as SessionId,
          contextId,
          expectedStatus: "reserved",
          status: "pending",
          sourceId: queueItemId,
        });
      }
    },
    discardSharedContext: async (sessionId, contextId) => {
      const store = context.deps.sessionStore;
      // 不支持引用的 store 返回 false 而不是抛错：丢弃是清理动作，调用方
      // （handler）已经把输入当失败了，再抛一次只会覆盖更准确的原始错误。
      if (!store?.transitionSharedContextImport) return false;
      // 只允许 pending → discarded：reserved 表示有输入正在用，consumed 表示已写进
      // 上下文，这两者都不该被「用户点了删除」直接抹掉（INV-15）。
      const updated = await store.transitionSharedContextImport({
        sessionID: sessionId as SessionId,
        contextId,
        expectedStatus: "pending",
        status: "discarded",
      });
      if (updated) {
        const entry = (
          await store.sessionEntries?.({
            sessionID: sessionId as SessionId,
            type: "v4/shared_context_import",
          })
        )?.find((candidate) => {
          const data = candidate.data;
          return Boolean(
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            (data as Record<string, unknown>).contextId === contextId,
          );
        });
        const data = entry?.data;
        const session = await store.getSession(sessionId as SessionId);
        if (
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          typeof (data as Record<string, unknown>).shareUrl === "string" &&
          typeof (data as Record<string, unknown>).contextId === "string" &&
          session?.title
        ) {
          context.v4Gateway?.updateSharedContextImport(sessionId, {
            contextId: String((data as Record<string, unknown>).contextId),
            title: session.title,
            shareUrl: String((data as Record<string, unknown>).shareUrl),
            status: "discarded",
          });
        }
      }
      return updated;
    },
    recordPersistentCommandFact: async (sessionId, source, ack, metadata) => {
      const store = context.deps.sessionStore;
      const live = context.sessions.get(sessionId);
      const stored = await store?.getSession(sessionId as SessionId);
      // 两处都没有时抛「会话不存在」而不是静默成功：这条事实是断线重放的唯一依据，
      // 写进一个不存在的会话等于制造一条永远不会被读到的记录，客户端却以为已确认。
      if (!store || (!live && !stored)) {
        throw new Error("fault.command.persistentFactSessionNotFound");
      }
      await savePersistentCommandFact(store, sessionId as SessionId, source, ack, metadata);
      // workspacePath 是索引键，缺它就无法把事实挂到正确的 workspace 分片；
      // 这里必须抛而不是回落空串，空串会把所有 workspace 的命令混进同一个索引。
      const workspacePath = live?.workspace.workspacePath ?? stored?.directory;
      if (!workspacePath) throw new Error("fault.command.persistentFactWorkspaceMissing");
      const workspaceIdentity = live?.workspace.workspaceIdentity ?? stored?.workspaceID;
      await persistentCommands.record(
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity: String(workspaceIdentity) } : {}),
        },
        sessionId,
        source,
        ack,
      );
    },
    // held choice 裁决（heldQueueInputRequiresChoice）：读投影 inputRouting.mode。
    getInputRoutingMode: (sessionId) => context.v4Gateway?.getInputRoutingMode(sessionId) ?? null,
    // rowId→messageId 翻译面（fork/edit/retry 的定位决策，数据源 = v4 投影）：
    // 惰性走 gateway 的投影查表。
    getMessageIdForRow: (sessionId, rowId) =>
      context.v4Gateway?.getMessageIdForRow(sessionId, rowId) ?? null,
    resolveRowActionTarget: (sessionId, target, action) =>
      context.v4Gateway?.resolveRowActionTarget(sessionId, target, action) ?? null,
    getMessageIdsForTurnRow: (sessionId, rowId) =>
      context.v4Gateway?.getMessageIdsForTurnRow(sessionId, rowId) ?? [],
    isLatestAssistantSegmentRow: (sessionId, rowId) =>
      context.v4Gateway?.isLatestAssistantSegmentRow(sessionId, rowId) ?? null,
    resolveStableForkTarget: async (sessionId, rowId) => {
      const candidate = context.v4Gateway?.resolveStableForkCandidate(sessionId, rowId) ?? null;
      if (!candidate) return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
      if (!candidate.ok) return candidate;
      const store = context.deps.sessionStore;
      // 没有 store 时同样报 ambiguous 而不是抛错：分叉点校验属于 guard，
      // 用统一 reasonCode 让 UI 能给出「换个位置再试」的提示，而不是原始异常。
      if (!store) return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
      // 候选来自 v4 投影（可能已领先 transcript），必须再用 transcript 复核一次：
      // snapshot 里的 row 只保证「界面上存在」，而分叉需要的是「磁盘上可切」。
      const messages = await store.messages({ sessionID: sessionId as SessionId });
      return await resolveStableForkTargetFromTranscript({
        candidate: candidate.candidate,
        messages,
        store,
      });
    },
    isLatestRetryAssistantRow: (sessionId, rowId) =>
      context.v4Gateway?.isLatestRetryAssistantRow(sessionId, rowId) ?? null,
    isLatestEditableUserRow: (sessionId, rowId) =>
      context.v4Gateway?.isLatestEditableUserRow(sessionId, rowId) ?? null,
    getTurnIdForRow: (sessionId, rowId) =>
      context.v4Gateway?.getTurnIdForRow(sessionId, rowId) ?? null,
    // restoreWarning 时序自愈探针：App 的模型视图直接来自进程 Registry。
    hasUsableRuntimeModelTarget: (record) => record.app.listModels().length > 0,
    getTurnRewindAnchor: (sessionId, rowId) =>
      context.v4Gateway?.getTurnRewindAnchor(sessionId, rowId) ?? null,
    resolveUserMessageIdForRow: async (sessionId, rowId) => {
      const turnId = context.v4Gateway?.getTurnIdForRow(sessionId, rowId) ?? null;
      const sessionStore = context.deps.sessionStore;
      if (!turnId || !sessionStore) return null;
      const messages = await sessionStore.messages({
        sessionID: sessionId as SessionId,
      });
      // 只认「真实用户轮起点」（isConversationRealUserTurnStarter）：synthetic 的
      // user 消息（例如系统注入的摘要请求）也带 turnId，回滚锚点若落到它上面，
      // 用户会看到工作区被恢复到一次自己从未发起的提问之前。
      const user = messages
        .filter(
          (message) =>
            message.info.role === "user" &&
            String(message.info.anchor?.turnId ?? "") === turnId &&
            isConversationRealUserTurnStarter(message),
        )
        // 同一 turn 可能有多次 edit 产生的多条 user 消息，取最后一条才是当前分支的
        // 起点；取最早一条会回滚到已被编辑掉的旧内容。
        .at(-1);
      return user ? String(user.info.id) : null;
    },
    // retryTurn 原 prompt 解析：assistant messageId → parentID（user 消息）→ 文本。
    // 数据源 = core sessionStore（transcript 权威）；实现放 binder 只因 deps 注入点
    // 在宿主（随 host 原生持有）。找不到返回 null → handler 只截断不重发。
    resolveTurnUserPrompt: async (sessionId, assistantMessageId) => {
      const sessionStore = context.deps.sessionStore;
      if (!sessionStore) return null;
      const messages = await sessionStore.messages({
        sessionID: sessionId as SessionId,
      });
      const assistantInfo = messages.find(
        (message) => message.info.id === assistantMessageId,
      )?.info;
      if (assistantInfo?.role !== "assistant") return null;
      const user = messages.find((message) => message.info.id === assistantInfo.parentID);
      if (!user || user.info.role !== "user") return null;
      const text = user.parts
        .filter(
          (part): part is Extract<(typeof user.parts)[number], { type: "text" }> =>
            // ignored 的 part 是渲染层占位（例如被折叠的工具摘要），把它拼回来会让
            // 重试的 prompt 与原轮不同，且用户无法在自己的输入框里看到这段多出来的文本。
            part.type === "text" && part.ignored !== true,
        )
        .map((part) => part.text)
        .join("");
      // 空文本返回 null：handler 会退化成「只截断不重发」，而空字符串会让它真的发出
      // 一次空 prompt，产生一个没有用户输入的 turn。
      return text.length > 0 ? text : null;
    },
    setAssistantFeedback: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      const sessionStore = context.deps.sessionStore;
      if (!record || !sessionStore) throw new Error("proto.sessionNotFound");
      // 原因：反馈必须先落 transcript，CLI 重启后才能从 cold hydration 恢复；
      // eventStore/投影随后推进，失败重试仍可从同一持久事实幂等补齐。
      await persistAssistantFeedback({
        sessionStore,
        eventStore: record.eventStore,
        sessionId,
        messageId: input.messageId,
        entityId: input.entityId,
        feedback: input.feedback,
        traceId: String(record.traceContext.traceId),
        onPersistedEvent: (persisted) => context.v4Gateway?.ingest(sessionId, persisted),
        onLiveProjectionError: (error) =>
          context.logger?.warn("v4 assistant feedback live projection failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          }),
      });
    },
    setHighspeedMetrics: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      const sessionStore = context.deps.sessionStore;
      // 与 feedback 不同，这里缺 record/store 直接抛：metrics 是用户显式操作，
      // 静默成功会让 UI 的「已保存」与实际磁盘状态相反。
      if (!record || !sessionStore) throw new Error("proto.sessionNotFound");
      await persistHighspeedMetrics({
        sessionStore,
        eventStore: record.eventStore,
        sessionId,
        messageId: input.messageId,
        entityId: input.entityId,
        metrics: input.metrics,
        traceId: String(record.traceContext.traceId),
        onPersistedEvent: (persisted) => context.v4Gateway?.ingest(sessionId, persisted),
        onLiveProjectionError: (error) =>
          context.logger?.warn("v4 highspeed metrics live projection failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          }),
      });
    },
    // ── 过渡钩子（死期 = M5 波次 2）──────────────────────────────
    ensureModelReady: (record) =>
      ensureSessionModelAvailableForNextTurn(context, record as ZCodeProtocolSessionRecord),
    // 切模型前确认目标 Provider 已存在于当前 Environment Registry。普通模型命令只提交
    // Selection；Provider 事实始终由 Worker 自己的 Registry 解释。
    ensureProviderAvailable: async (sessionId, providerId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return { available: false, reason: "session_not_found" };
      if (!hasSessionModelProvider(context, record, providerId)) {
        return { available: false, reason: "provider_not_in_registry" };
      }
      return { available: true };
    },
    afterLegacyStateMutation: async (record, reason) => {
      // 顺序不能反：afterStateMutation 负责把旧 op 的变更灌进投影，auto-drain 的判断
      // （队首是谁、goal 是否终态）读的正是这份投影。先 drain 会基于过期投影提升，
      // 把刚刚被暂停或取消的队首又执行一次。
      await afterStateMutation(context, record as ZCodeProtocolSessionRecord, reason);
      await autoDrainV4QueueIfReady(record as ZCodeProtocolSessionRecord);
    },
    // deleteSession 的执行面：先由 CLI 持久化软删除事实，再内联旧 closeSession op 的
    // 4 步释放运行实例（不 import 旧 op；随波次 2 会话注册表归 v4 后收编）。
    deleteSession: async (sessionId) => {
      if (!context.deps.sessionStore?.softDeleteSession)
        throw new Error("Session soft deletion is unavailable");
      await context.deps.sessionStore.softDeleteSession(sessionId as SessionId);
      const record = context.sessions.get(sessionId);
      if (!record) {
        // handler 已校验存在性；此处只兜并发竞态（重复删除幂等成功）。
        return;
      }
      record.unsubscribe?.();
      await record.app.close?.();
      // v4 通道：会话关闭同时清 publisher / 订阅调度；重开会话走 snapshot 冷启动。
      // disposeSession 必须在注册表删除之前调用——
      // gateway 靠 getSessionWorkspaceId（读 context.sessions）定位 workspace 才能把
      // session.removed 推给 sessions-index 订阅者；先 delete 再 dispose 时 workspaceId
      // 恒为 null，删除会话后侧栏列表项永不消失（e2e conversation-session-v4-sidebar 抓出）。
      context.v4Gateway?.disposeSession(sessionId, { deleted: true });
      // 高频执行材料必须在这里显式清：它含临时凭据，而 disposeSession 只认识投影，
      // 不认识 binder 这张本地表（INV-12）。
      queuedTurnExecutions.delete(sessionId);
      context.sessions.delete(sessionId);
    },
    // createSession 的执行面：record 建立/事件接线/catalog 同步/失败自清理全在旧
    // createSession op 内（半初始化 record 的回收顺序修过 bug，不重复实现）。
    // 语义决策（draft persistence / firstInput 走原生 prompt turn）在原生 handler。
    createSessionRecord: async ({
      sessionId,
      additionalDirectories,
      workspaceId,
      mcpServers,
      offPeakToolEnabled,
      dynamicWorkflowEnabled,
      dynamicWorkflowMode,
      permissionScope,
    }) => {
      if (permissionScope && !context.deps.sessionStore)
        throw new Error("Group task permission scope requires persistence");
      // workspaceId 双形态（Workspace Identity 约束）：
      // - 本地工作区 = workspacePath（identity 缺省时的 fallback）；
      // - 远程 pane（跨 workspace 分屏）= 远程 identity
      //   （remote:ssh/wsl/docker:...:<path>，UI buildRemoteWorkspaceIdentity 构造）。
      //   经统一解析工具还原真实 workspacePath 作 workingDirectory——CLI 本就跑在
      //   远端机器上，path 即本机路径；identity 原样保留进 workspace ref
      //   （workspaceKey = identity，sessions-index topic / 隔离语义不变）。
      // shared parser 统一兼容 WSL legacy 与显式 user identity；非远程格式继续按
      // 本地 workspacePath 处理。
      const created = await createSessionRecordForV4(context, {
        sessionId,
        additionalDirectories,
        workspace: resolveWorkspaceRefFromId(workspaceId),
        // 群任务已经由首条真实需求触发，先落盘隔离授权，再开放任务与配置。
        // 普通 Desktop draft 仍保持 deferred。
        persistence: "deferred",
        // MCP 是 runtime 创建期配置；v4 createSession 必须与 legacy
        // session/create 等价透传，否则创建的 session 永远不会启动这些工具。
        mcpServers,
        // Off-Peak 工具面 flag 同为 runtime 创建期配置，必须随 create 进入 record。
        ...(offPeakToolEnabled === true ? { offPeakToolEnabled: true } : {}),
        // 动态工作流灰度门同为 runtime 创建期配置：
        // v4 createSession 必须与 legacy session/create 等价透传，否则无界面创建的会话
        // 会绕过 Host 的灰度判定，只剩进程级缺省。
        ...(dynamicWorkflowEnabled === true ? { dynamicWorkflowEnabled: true } : {}),
        ...(dynamicWorkflowEnabled === true && dynamicWorkflowMode !== undefined
          ? { dynamicWorkflowMode }
          : {}),
      });
      if (permissionScope) {
        const record = context.sessions.get(created.sessionId);
        if (!record) throw new Error("Group task runtime is unavailable");
        await record.app.runtime.ensureSessionPersistedForExternalActivity("", {
          traceContext: record.traceContext,
        });
        await context.deps.sessionStore!.updateSession({
          id: created.sessionId as SessionId,
          permission: { version: 1, scope: "session", mode: "build" },
        });
        await record.app.runtime.setExecutionState({ mode: "build" }, record.traceContext);
        record.persistence = "immediate";
      }
      return { sessionId: created.sessionId };
    },
    createSelectionSideSession: async (sessionId, options) => {
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      // clone 是必须的：modelSelection 会作为 child 的常驻选型被后续 turn 复用，
      // 直接持有调用方对象（可能来自 projection 快照）会让后续 mutation 同时改到父会话。
      const modelSelection = cloneModelSelection(
        options.modelSelection ?? record.app.runtime.getSessionModelSelection(),
      );
      const fork = await record.app.runtime.createSelectionSideConversation({
        modelSelection,
        sourceCommandId: options.sourceCommandId,
        revisionAtDecision: options.revisionAtDecision,
        traceContext: record.traceContext,
      });
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: options.sourceCommandId,
        runtimeConfig: {
          mode: record.app.getMode(),
          // 选型缺省时写空串而不是省略：runtimeConfig.model 是 child record 的必填列，
          // 空串表示「沿用环境默认」，省略会让下游回落到父会话的模型并留下错误快照。
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
          // followupMode 只在侧会话显式继承：默认 queue 与 v4 网关的会话级默认一致，
          // 若这里读不到就回落 undefined，让 child 使用自己的默认而不是父会话的设置。
          followupMode: context.v4Gateway?.getSessionFollowupMode(sessionId) ?? "queue",
        },
        // 侧会话不继承父的当前 goal：它的语义是「就选区内的一段内容再问一次」，
        // 带上 goal 会让它在下一轮被 goal verification 判成未完成。
        inheritLatestTarget: false,
      });
      return { sessionId: String(fork.forkedSessionId) };
    },
    // running stable fork：只走 core transcript copy，再注册 child record。父 runtime、queue、
    // background/continuation inbox 与 shared workspace 均不读取、不停止、不复制。
    forkStableConversation: async (sessionId, options) => {
      const { goalBoundary, revisionAtDecision, sourceCommandId, target } = options;
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      const store = context.deps.sessionStore;
      if (!store) throw new Error("fault.command.stableForkStoreUnavailable");
      const messages = await store.messages({ sessionID: sessionId as SessionId });
      const boundary = messages.find(
        (message) => String(message.info.id) === target.boundaryMessageId,
      );
      // 越界必须报 guard 而不是 falls through：boundary 若指向 user 消息，复制出来的
      // child 会缺 assistant 回复，新会话的第一条 assistant 会「回答上一轮」，
      // 看起来像是串了对话。
      if (boundary?.info.role !== "assistant") {
        throw new Error("guard.forkTargetAmbiguous");
      }
      // 分叉继承分叉点的会话选型；加速轮消息记录的是单轮执行 Selection，必须跳过后退回父会话常驻选型。
      const modelSelection = derivedSessionModelSelection(
        boundary.info.providerId && boundary.info.modelId
          ? {
              providerId: boundary.info.providerId,
              modelId: boundary.info.modelId,
              ...(boundary.info.reasoningLevel
                ? { options: { reasoningLevel: boundary.info.reasoningLevel } }
                : {}),
            }
          : undefined,
        record.app.runtime.getSessionModelSelection(),
      );
      const fork = await record.app.runtime.forkStableConversationAtMessage({
        modelSelection,
        target,
        goalBoundary,
        sourceCommandId,
        revisionAtDecision,
        traceContext: record.traceContext,
      });
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: sourceCommandId,
        runtimeConfig: {
          mode: stableForkMode(boundary.info.mode, record.app.getMode()),
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
        },
        // core 已按 copied message/verifier 边界复制 goal；禁止再用 parent 当前 target 覆盖。
        inheritLatestTarget: false,
      });
      return { forkedSessionId: String(fork.forkedSessionId) };
    },
    forkConversationBeforeInput: async (sessionId, { editTarget, envelope, admission }) => {
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      const store = context.deps.sessionStore;
      if (!store) throw new Error("fault.command.stableForkStoreUnavailable");
      const messages = await store.messages({
        sessionID: sessionId as SessionId,
      });
      const targetMessage = messages.find(
        (message) => String(message.info.id) === editTarget.transcriptMessageId,
      );
      if (targetMessage?.info.role !== "user") {
        throw new Error("guard.latestQueryEditOnly");
      }
      const modelSelection = derivedSessionModelSelection(
        targetMessage.info.modelSelection,
        record.app.runtime.getSessionModelSelection(),
      );
      const events = await record.eventStore.getEvents(sessionId as SessionId);
      // 找 target 那一轮开始的位置，用来回推「这轮开始时 goal 是什么」。用 messageId
      // 而不是顺序号：TurnStarted 的载荷在 replay 与 live 两条路径下顺序号可能被重排。
      const targetStarted = events.find(
        (event) =>
          event.type === SessionEventType.TurnStarted &&
          String((event.payload as { messageId?: unknown }).messageId ?? "") ===
            editTarget.transcriptMessageId,
      );
      // 取该轮之前最后一个 TargetChanged：goal 是「随时间变化的状态」，分叉点必须拿到
      // 当时的快照。若取最新一条，用户会带着分叉之后才设立的目标进入 child。
      const priorTargetChange = targetStarted
        ? events
            .filter(
              (event) =>
                event.sequenceNumber < targetStarted.sequenceNumber &&
                event.type === SessionEventType.TargetChanged,
            )
            .at(-1)
        : undefined;
      // forkedSessionId 由 binder 预先生成并同时用于 initialInput 的内外键：让 runtime
      // 自己生成会导致「先有 intent 后知道 sessionId」，admission 必须先绑定到具体会话。
      const forkedSessionId = String(createSessionId());
      const input = resolveInputCommandForAdmission(
        envelope,
        forkedSessionId,
        (sourceSessionId, target, action) =>
          context.v4Gateway?.resolveRowActionTarget(sourceSessionId, target, action) ?? null,
      );
      if (!input) throw new Error("fault.command.forkInputAdmissionMissing");
      const initialInput = buildForkInitialInput(envelope, forkedSessionId, admission, input);
      // goalBoundary 三态：null = 无法判断（继续往下找）、snapshot = 有当时的目标快照、
      // none = 明确没有目标。区分 null 与 none 是关键：把 null 当 none 处理会漏掉
      // 「上一轮结束时其实有 goal」的情况，child 的 goal 面板会凭空清空。
      let goalBoundary: StableForkGoalBoundaryMetadata | null = priorTargetChange
        ? (() => {
            const target = (priorTargetChange.payload as { target?: unknown }).target;
            return target
              ? {
                  kind: "snapshot" as const,
                  target: target as Extract<
                    StableForkGoalBoundaryMetadata,
                    { kind: "snapshot" }
                  >["target"],
                  verificationEntryIds: [],
                }
              : { kind: "none" as const };
          })()
        : null;
      // verificationEntryIds 必须按「时间点」而不是「是否已完成」筛选：分叉后新增的
      // 验证记录不属于这个历史目标，带过去会让 child 一开局就显示 3/3 完成。
      if (goalBoundary?.kind === "snapshot" && store.sessionEntries && targetStarted) {
        const targetId = goalBoundary.target.targetID;
        const boundaryTime = targetStarted.timestamp.getTime();
        const entries = await store.sessionEntries({
          sessionID: sessionId as SessionId,
          type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
        });
        goalBoundary = {
          ...goalBoundary,
          verificationEntryIds: entries.flatMap((entry) => {
            const data = entry.data as { payload?: { targetId?: unknown } };
            return entry.time.updated <= boundaryTime && data.payload?.targetId === targetId
              ? [entry.id]
              : [];
          }),
        };
      }
      if (!goalBoundary) {
        // 兜底走 transcript 的锚点：goalBoundary 已经按消息持久化过，比继续在事件流里
        // 推测更可靠；取「target 之前最近的一条 assistant」是因为 goal 状态只在
        // assistant 收尾时被写进消息锚点。
        const targetIndex = messages.indexOf(targetMessage);
        const previousAssistant = messages
          .slice(0, targetIndex)
          .reverse()
          .find((message) => message.info.role === "assistant");
        goalBoundary = previousAssistant?.info.anchor?.goalBoundary ?? null;
        // 明确找不到任何 assistant，说明这是会话第一轮：可以断定「没有目标」。
        // 注意这里不能把 undefined 也当成 none，那会掩盖 transcript 损坏。
        if (!previousAssistant) goalBoundary = { kind: "none" };
      }
      if (!goalBoundary) {
        // 走到这里等于有 assistant 但锚点缺失（旧版本数据），宁可拒绝分叉：
        // 猜一个 none 会让用户以为 child 与父的 goal 一致。
        throw new Error("guard.forkTargetAmbiguous");
      }
      const fork = await record.app.runtime.forkConversationBeforeMessage({
        modelSelection,
        forkedSessionId: forkedSessionId as SessionId,
        targetMessageId: targetMessage.info.id,
        targetProductTurnId: editTarget.productTurnId,
        targetTranscriptTurnId: String(
          targetMessage.info.anchor?.turnId ?? editTarget.productTurnId,
        ),
        sourceCommandId: envelope.commandId,
        initialInput,
        commandFact: {
          parentSessionId: sessionId,
          sourceCommandId: envelope.commandId,
          ack: {
            commandId: envelope.commandId,
            status: "accepted",
            revisionAtDecision: envelope.baseRevision ?? 0,
            result: {
              type: "editUserQuery",
              disposition: "fork",
              sessionId: forkedSessionId,
            },
          },
          metadata: {
            parentSessionId: sessionId,
            sourceCommandId: envelope.commandId,
            editTarget,
          },
        },
        // 严格取 TurnStarted 之前的 TargetChanged 或上一稳定 assistant anchor；禁止
        // 把 parent 当前（可能正由被编辑 goal 写入）的 target 冒充 input 前状态。
        goalBoundary,
        traceContext: record.traceContext,
      });
      // 这里的 runtimeConfig.mode 用 record 当前模式而非稳定白名单：edit 产生的 child
      // 应该延续用户此刻的协作模式，分叉点消息里的 mode 可能早于一次显式切换。
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: envelope.commandId,
        runtimeConfig: {
          mode: record.app.getMode(),
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
        },
        inheritLatestTarget: false,
      });
      return { forkedSessionId: String(fork.forkedSessionId) };
    },
    recordForkStartFailure: async (sessionId, envelope, error) => {
      await recordForkStartFailureBestEffort(context, sessionId, envelope, error, {
        parentSessionId: String(envelope.sessionId ?? ""),
      });
    },
  };
  nativeExecutor = new V4CommandExecutor(coreHost);
  const loadStoredSessionSummaries = async (
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ) => {
    // 未加载会话的轻量摘要：store 元信息 → SessionSummary（phase 取空闲完成态默认、
    // sessionEnded=true 对齐 「成功轮收口即 true」口径；加载后的准确
    // phase/preview/backgroundWork 由 gateway 用 live 投影覆盖）。
    // workspaceKey 的本地 fallback = workspacePath，故用它作 listSessions 的 directory 过滤。
    if (!context.deps.sessionStore) return [];
    try {
      // 远端 sessions-index 的 workspaceId 是隔离 identity，而 session store 的
      // directory 是实际文件路径。查询必须同时带路径和 identity；否则同一路径下其他
      // authority 的会话会被误标成当前 workspace。legacy 空 identity 不能只凭路径
      // claim，只允许使用 host task-index 给出的精确 taskId 归属证明。
      const parsedRemote = parseRemoteWorkspaceIdentity(workspaceId);
      const persistedWorkspacePath = parsedRemote?.workspacePath ?? workspaceId;
      // 旧数据迁移必须满足三个前提同时成立才尝试：远端 identity（本地不需要分隔）、
      // 宿主给出了 task-index 白名单（这是唯一的归属证明）、store 支持该能力。
      // 三者缺一都不应调用，否则会退化成「按路径猜测归属」，误标别人的会话。
      if (
        parsedRemote &&
        legacyTaskIds &&
        legacyTaskIds.length > 0 &&
        context.deps.sessionStore.claimLegacySessionWorkspace
      ) {
        try {
          const claimedCount = await context.deps.sessionStore.claimLegacySessionWorkspace({
            sessionIDs: legacyTaskIds as SessionId[],
            directory: persistedWorkspacePath,
            workspaceID: workspaceId as WorkspaceId,
          });
          if (claimedCount > 0) {
            context.logger?.info("legacy remote sessions claimed by task-index allowlist", {
              claimedCount,
              event: "zcode_protocol.v4.sessions_index_legacy_remote_claimed",
              module: "bootstrap.zcode_protocol",
              workspaceId,
            });
          }
        } catch (error) {
          // claim 只是旧数据兼容步骤；失败后仍要读取已有完整 identity 的会话。
          // 后续携带 allowlist 的订阅会再次进入这里，不能用失败结果封死迁移。
          context.logger?.warn("legacy remote sessions claim failed; continuing strict load", {
            error: error instanceof Error ? error.message : String(error),
            event: "zcode_protocol.v4.sessions_index_legacy_remote_claim_failed",
            module: "bootstrap.zcode_protocol",
            workspaceId,
          });
        }
      }
      const stored = await context.deps.sessionStore.listSessions({
        directory: persistedWorkspacePath,
        limit: 200,
        // parentID 只表达会话层级，不能作为左侧任务 membership。
        // 显式 fork 必然带 parentID，但重启后仍应由 taskType 投影进 sessions-index。
        taskTypes: [...TASK_LIST_SESSION_TYPES],
        // 远端必须带上 identity，本地必须显式传 null：传 undefined 会让 store 走
        // 「按 directory 模糊匹配」的老路径，把本地查询也变成跨 workspace 查询。
        workspaceID: parsedRemote ? (workspaceId as WorkspaceId) : null,
      });
      // phase 由 lastOutcome 反推：这里拿到的是「持久化的收尾事实」，不是实时状态。
      // 未加载的会话一律 sessionEnded=true，因为进程重启后没有任何 turn 在跑；
      // 若这里给 false，侧栏会在重启后把所有会话显示成「进行中」。
      return stored.map((session) => ({
        sessionId: String(session.id),
        workspaceId,
        ...(session.parentID ? { parentSessionId: String(session.parentID) } : {}),
        title: session.title ?? "",
        titleSource: normalizeStoredTitleSource(session.titleSource),
        phase:
          session.lastOutcome === "error"
            ? ("error" as const)
            : session.lastOutcome === "interrupted"
              ? ("completedInterrupted" as const)
              : ("completedSuccess" as const),
        ...(session.lastOutcome ? { lastOutcome: session.lastOutcome } : {}),
        sessionEnded: true,
        hasBackgroundWork: false,
        lastActivityAt: session.time?.updated ?? 0,
        createdAt: session.time?.created ?? 0,
      }));
    } catch (error) {
      // 列表读取失败返回空数组而不是抛错：sessions-index 的订阅会因抛错被整体关闭，
      // 用户侧会看到「侧栏一直空白且不再更新」，比暂时空列表更难恢复。
      context.logger?.warn("sessions-index stored summaries failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.v4.sessions_index_stored_failed",
        module: "bootstrap.zcode_protocol",
      });
      return [];
    }
  };
  return new ConversationV4Gateway({
    cliVersion: context.deps.version,
    sessionExists: (sessionId) => context.sessions.has(sessionId),
    reconcileSessions: async ({ workspaceId, sessionIds }) => {
      const store = context.deps.sessionStore;
      if (!store) throw new Error("Session store is unavailable");
      const remote = parseRemoteWorkspaceIdentity(workspaceId);
      const directory = remote?.workspacePath ?? workspaceId;
      // Set 去重是必要的：renderer 可能在一次重连里把同一 id 报多遍，不去重会让
      // 返回数组出现重复项，sessions-index 的 diff 会反复插入删除同一条。
      const sessions = await Promise.all(
        [...new Set(sessionIds)].map(async (sessionId) => {
          const session = await store.getSession(sessionId as SessionId);
          // 三条件同时校验：路径相等只是必要条件，远端还要 identity 精确相等，
          // 本地则必须「没有 identity 或 identity 等于当前 workspace」。
          // 少了后两条，同一个路径下不同远端 authority 的会话会被误判为存在。
          const sameWorkspace =
            session &&
            session.directory === directory &&
            (remote
              ? session.workspaceID === workspaceId
              : !session.workspaceID || session.workspaceID === workspaceId);
          // 不属于本 workspace 时返回 exists:false, deleted:false，而不是 deleted:true：
          // deleted 会被 renderer 用来「从列表移除并提示已删除」，这里只是不归你管。
          if (!sameWorkspace) return { sessionId, exists: false as const, deleted: false as const };
          return {
            sessionId,
            exists: true as const,
            deleted: session.time.deleted !== undefined,
            title: session.title,
            titleSource: normalizeStoredTitleSource(session.titleSource),
            createdAt: session.time.created,
            updatedAt: session.time.updated,
            ...(session.lastOutcome ? { lastOutcome: session.lastOutcome } : {}),
          };
        }),
      );
      return { sessions };
    },
    onDebug: (message) => log?.debug(message),
    onTargetCompleted: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return;
      // background task-notification 的 goal verifier 不经过 v4 prompt 的
      // finally/afterLegacyStateMutation；TargetChanged(complete) 虽已提交，future queue
      // 因而没有下一次 mutation 来重评。这里只 detached 触发既有 gate，不能阻塞投影。
      void Promise.resolve()
        .then(() => autoDrainV4QueueIfReady(record))
        .catch((error: unknown) => {
          context.logger?.warn("v4 auto-drain reevaluation after target completion failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
        });
    },
    onHighspeedTurnTerminal: (sessionId, event, snapshot) => {
      persistHighspeedTimingOnTurnTerminal(context, sessionId, event, snapshot);
    },
    // Gateway 的单一 READY promise 负责并发与水位；binder 只恢复 runtime 并返回 M0/M1。
    // 池不可用时返回空 disposer 而不是抛错：会话仍能用已加载的 transcript 只读展示，
    // 直接抛会让一次「打开历史会话」变成硬失败。
    retainSessionRuntime: async (sessionId) =>
      (await context.sessionResidentPool?.acquireOperation(sessionId)) ?? (() => undefined),
    loadPersistedMessages: async (sessionId) => {
      const store = context.deps.sessionStore;
      // 先探一次 getSession：messages 对不存在的会话会返回空数组，冷启动会因此
      // 把「会话不存在」当成「这是一个空会话」，先创建出幽灵 publisher。
      if (!store || !(await store.getSession(sessionId as SessionId)))
        throw new Error("fault.subscribe.sessionNotFound");
      return store.messages({ sessionID: sessionId as SessionId });
    },
    resumePersistedSession: async (
      sessionId,
      resumeThoughtLevel,
      workspace?: ZCodeWorkspaceRef,
      additionalDirectories?: string[],
      persistedMessages?: MessageWithParts[],
    ) => {
      const persisted = await context.deps.sessionStore?.getSession(sessionId as SessionId);
      // 软删除的会话也按 notFound 处理：若放行，冷恢复会把一个用户已经删掉的会话
      // 重新挂回侧栏，并且后续写入都落在一个「已删除」的行上（外键还在但语义已废）。
      if (!persisted || persisted.time.deleted !== undefined) {
        context.logger?.warn("ZCode Protocol v4 cold resume has no persisted session", {
          activeSessionCount: context.sessions.size,
          event: "zcode_protocol.v4.resume_persisted_missing",
          module: "bootstrap.zcode_protocol",
          sessionId,
        });
        return { status: "notFound" };
      }
      const existingRecord = context.sessions.get(sessionId);
      const activated = await activateSessionForResume(
        context,
        {
          sessionId,
          // session.path 可能是规范化后的执行 cwd，不能覆盖当前 attachment
          // 已知的 workspace 身份。旧 session 没有 attachment 上下文时仍走原有持久化回退。
          ...(workspace ? { workspace } : {}),
          ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
          ...(resumeThoughtLevel ? { thoughtLevel: resumeThoughtLevel } : {}),
        },
        { reusePersistedMessages: true, persistedMessages },
      );
      // [资源] 只有「本次新建了 record」才提供回滚钩子：已有 record 说明它是被别的
      // 订阅或命令建好的，失败时把它 dispose 会连带杀掉对方正在用的会话。
      return {
        status: "resumed",
        persistedMessages: activated.persistedMessages,
        ...(!existingRecord
          ? {
              disposeOnFailure: () =>
                discardFailedSessionResume(context, sessionId, activated.record),
            }
          : {}),
      };
    },
    // v4 帧出口：统一封装 conversationFrame 通知，gateway 不直接接触 messageSink。
    emitWireFrame: (wire) =>
      context.notify({
        method: V4_NOTIFICATIONS.conversationFrame,
        params: wire,
      }),
    emitLocalTtftFacts: (facts) =>
      context.notify({ method: V4_NOTIFICATIONS.localTtftFacts, params: facts }),
    emitConversationTelemetryFact: (fact) =>
      context.notify({
        method: V4_NOTIFICATIONS.conversationTelemetryFact,
        params: fact,
      }),
    emitPluginUiToolResult: (result) =>
      context.notify({ method: V4_NOTIFICATIONS.pluginUiToolResult, params: result }),
    emitCuaPermissionObservation: (observation) =>
      context.notify({
        method: V4_NOTIFICATIONS.cuaPermissionObservation,
        params: observation,
      }),
    // ── config 种子：投影初值 = runtime 真值 ─────────────
    // 覆盖三个种子来源：启动缺省（Workspace 模型偏好 + 项目持久化 mode）、
    // createSession.config（handler 先应用到 runtime 再种）、历史会话 resume
    // （App 恢复结果可以只有模型身份，不能为了投影而绑定半成品执行模型）。
    getSessionMemoryEnabled: (sessionId) => context.sessions.get(sessionId)?.memoryEnabled,
    getSessionConfigSeed: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      // runtime 选型优先于 restoredModelSelection：前者是用户本次会话真正在用的，
      // 后者只是冷启动时从 transcript 恢复的候选，可能已被一次显式切模型覆盖。
      const selection =
        record.app.runtime.getSessionModelSelection() ?? record.restoredModelSelection;
      // [权衡] thoughtLevels 从当前 registry 现查而不是从 selection 反推：listModels 的
      // 结果是 Provider 侧真值，缓存进 projection 后会与一次模型升级后的可用档位脱节。
      return {
        modelSelection: cloneModelSelection(selection),
        // provider/model 拆开成空串而不是 undefined：v4 config 帧是定长结构，
        // 缺键会让 renderer 的 merge 保留上一帧的值，显示成「没切换成功」。
        provider: selection?.providerId ?? "",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
        thoughtLevels: selection
          ? (record.app
              .listModels()
              .find(
                (model) =>
                  model.ref.providerId === selection.providerId &&
                  model.ref.modelId === selection.modelId,
              )
              ?.reasoning?.levels.map((level) => level.value) ?? [])
          : [],
        // mode 取 getMode 而不是 taskType：二者在 plan/yolo 这类协作模式下不同，
        // 投影需要的是「接下来一轮会怎么跑」，只有 getMode 表达这个。
        mode: record.app.getMode(),
        planEnabled: record.app.runtime.getPlanEnabled(),
        // permissionGrant 只在有 id 时出现：空对象会覆盖掉 renderer 里仍有效的授权提示，
        // 让用户在一次重启后看到「权限已收回」但其实授权还在。
        ...(record.app.runtime.lastPermissionGrantId
          ? { permissionGrant: { interactionId: record.app.runtime.lastPermissionGrantId } }
          : {}),
      };
    },
    getSessionUsageSeed: async (sessionId, persistedMessages) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      const contextUsage = await readSessionContextUsage(context, sessionId, persistedMessages);
      // usage seed 会在 hydration 后再次覆盖首帧分母；必须与合成事件
      // 使用同一份当前模型 registry 真值，不能把旧 runtime projection 的窗口写回来。
      return sessionUsageSeedFromRuntimeContextUsage(
        contextUsage,
        resolveSessionModelContextWindow(context, record),
      );
    },
    // ── sessions-index hooks（workspace 分桶 + 冷启动 store 种子）──────────
    getSessionWorkspaceId: (sessionId) => {
      const record = context.sessions.get(sessionId);
      // 非任务类会话（子代理）返回 null：它们不该出现在侧栏分桶里。用 null 而不是
      // undefined 是因为调用方据此判断「没有 workspace」，undefined 会被当成默认桶。
      return !record || !isTaskListSessionType(record.taskType)
        ? null
        : record.workspace.workspaceKey;
    },
    getSessionIndexMeta: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      // parentSessionId 无条件保留：它是「fork 关系」的唯一表达，删掉后 UI 无法把
      // 子会话折叠到父会话下面，重启后看起来像多出来的独立任务（INV-19）。
      return {
        createdAt: record.createdAt,
        lastActivityAt: record.updatedAt,
        ...(record.lastOutcome ? { lastOutcome: record.lastOutcome } : {}),
        ...(record.parentSessionId ? { parentSessionId: String(record.parentSessionId) } : {}),
      };
    },
    listWorkspaceSessionIds: (workspaceId) =>
      [...context.sessions.values()]
        .filter(
          (record) =>
            // workspaceKey 而不是 workspacePath：远端 pane 的两个 workspace 可能共享
            // 同一个物理路径，用 path 会把它们混进同一个分桶。
            isTaskListSessionType(record.taskType) && record.workspace.workspaceKey === workspaceId,
        )
        .map((record) => record.app.sessionId),
    // draft 判定：deferred = 未发首条输入（prompt-turn 首发提升为 immediate）。
    // 旧 workspace prepare 预建的 deferred 会话不得以「新任务」漏进侧栏列表。
    isDraftSession: (sessionId) => context.sessions.get(sessionId)?.persistence === "deferred",
    // ── workspace-config hook（配置目录订阅种子；live session 快路径，避免临时 app）──
    getWorkspaceConfig: (workspaceId) => buildLiveWorkspaceConfigStateV4(context, workspaceId),
    getStoredSessionSummaries: loadStoredSessionSummaries,
    refreshLegacySessionSummaries: (workspaceId, legacyTaskIds) =>
      parseRemoteWorkspaceIdentity(workspaceId)
        ? loadStoredSessionSummaries(workspaceId, legacyTaskIds)
        : null,
    // 回落面已清零（20 命令全部原生）：supports 未命中（未知命令类型）→
    // notImplemented → ACK failed fault.command.notImplemented。
    // [失败路径] 这里只做二选一，绝不允许「先尝试再兜底」：execute 内部已经进入
    // 事务/PONR 语义，一旦开始执行再抛 notImplemented，账本与投影会停在半途。
    executeCommand: (envelope, admission) =>
      nativeExecutor.supports(envelope.type)
        ? nativeExecutor.execute(envelope, admission)
        : Promise.reject(new V4CommandNotImplementedError(envelope.type)),
    admitCommandInput: async (envelope, admission) => {
      // 仅隐藏 composer 不能阻止旧 child 标签页续聊。类型准入必须早于
      // ledger/输入历史写入；detached child 没有 record 时只查元数据，不激活第二个 runtime。
      if (
        envelope.sessionId &&
        (isConversationInputAdmissionCommand(envelope.type) ||
          envelope.type === "resumeGoal" ||
          envelope.type === "sendQueuedNow" ||
          envelope.type === "forkAssistant" ||
          envelope.type === "createSelectionSideSession")
      ) {
        const taskType =
          context.sessions.get(envelope.sessionId)?.taskType ??
          (await context.deps.sessionStore?.getSession(envelope.sessionId as SessionId))?.taskType;
        if (isReadonlyAgentSessionKind(taskType)) {
          throw Object.assign(new Error("Subagent sessions are read-only"), {
            reasonCode: "guard.subagentReadOnly",
          });
        }
      }
      if (!isConversationInputAdmissionCommand(envelope.type)) return null;
      if (!envelope.sessionId) return null;
      // 这里必须用信封里的 sessionId 而不是参数里的：admission 的内外键要与 ACK
      // 回包中的 sessionId 一致，否则客户端按命令 id 查询账本时会查不到。
      return (await coreHost.admitInputCommand?.(envelope, envelope.sessionId, admission)) ?? null;
    },
    cancelCommandInput: async (envelope, queueItemId, reason) => {
      // 无 sessionId 的命令（全局 createSession）没有队列项可取消，直接 no-op：
      // 抛错会让「清理一个已经被消费的命令」变成客户端可见的失败。
      if (!envelope.sessionId) return;
      await coreHost.cancelInputCommand?.(envelope.sessionId, queueItemId, reason);
    },
    terminateTurnForProjectionFault: (sessionId, reasonCode) => {
      const record = context.sessions.get(sessionId);
      const controller = record?.activeAbortController;
      // 已经 aborted 就不要再 abort 一次：重复 abort 会触发第二次 finally，
      // 而 finally 里的 settle 与 afterLegacyStateMutation 对同一 turn 不是幂等的。
      if (!controller || controller.signal.aborted) return;
      // 修复原因：投影越过 16MiB 后继续生成只会让所有后续 snapshot 都无法编码。
      // gateway 先原子拒绝越界事件并登记 protocol fault，再单次调用这里中止模型 turn；
      // abort 的正常终态负责释放 active lock，不能在 gateway 里越层伪造 TurnError。
      controller.abort(createExternalTurnFaultError(reasonCode));
    },
    // commands/query 持久化 fallback：同 session 首次查询惰性建索引，后续四个来源
    // 共用该索引；anchor/marker/child/discarded 写入走 record 增量更新。
    lookupTranscriptCommand: (key) =>
      // sessionId === null 表示 createSession 这类「还没有会话」的全局命令：
      // 它不在任何 session 分片里，只能走全局索引，否则重连后永远查不到 ACK。
      key.sessionId === null
        ? lookupGlobalCreateSessionCommand(context.deps.sessionStore, key.commandId)
        : persistentCommands.lookup("transcript", key),
    lookupTimelineCommand: (key) => persistentCommands.lookup("timeline", key),
    lookupChildCommand: (key) => persistentCommands.lookup("child", key),
    lookupDiscardedCommand: (key) => persistentCommands.lookup("discarded", key),
    invalidatePersistentCommandFacts: (sessionId) => persistentCommands.invalidate(sessionId),
    // gateway 已完成逐片总量/checksum 校验，只把完整 bytes 原子写 artifact。
    putSessionAttachment: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      // [失败路径] 这里绝不回落到「按 workspace 找任意 record」：附件路径里含 sessionId，
      // 一旦写进别的会话目录，读取侧会跨会话命中，等于权限穿透（INV-21）。
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      return record.app.writePromptAttachment(input);
    },
    readBackgroundBashOutput: (sessionId, workId) =>
      readBackgroundBashOutputFromOwner(context, sessionId, workId),
    readSessionAttachment: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      return record.app.readPromptAttachment(input);
    },
    statSessionAttachment: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      // stat 是可选能力：单独抛 statUnsupported，让 renderer 能降级成「不知道大小」
      // 而不是把整条附件显示成损坏。
      if (!record.app.statPromptAttachment) {
        throw new Error("fault.attachment.statUnsupported");
      }
      return record.app.statPromptAttachment(input);
    },
    resolveSessionAttachmentPreviewSource: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      return record.app.resolvePromptAttachmentPreviewSource(input);
    },
    getConversationFileChanges: async (sessionId, _targetRowId, messageIds, targetTurnId) => {
      // 用 backing record 而不是 context.sessions.get：fork 出来的子会话可能没有
      // 自己的 record，但它的事件确实写在父的共享 store 里，取不到就会把已有的
      // 文件变更显示成「本轮没有改动」。
      const record = await resolveConversationBackingRecord(context, sessionId);
      if (!record) {
        throw new Error(`fault.fileChanges.sessionNotFound: ${sessionId}`);
      }
      return readConversationFileChanges(record, sessionId, messageIds, targetTurnId);
    },
    // dwf 事件日志：能力在 app 上（run service 构造成功才有），缺席时不在这里兜底成空页——
    // gateway 会回结构化的能力不支持错误，让 renderer 能区分"没有事件"与"没有这个能力"。
    listDynamicWorkflowRunEvents: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunEvents.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunEvents) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunEvents", sessionId);
      }
      // 经 app 调用（不可解构：实现可能依赖 this 绑定）。
      return record.app.listDynamicWorkflowRunEvents(input);
    },
    // workflow run 枚举：能力条件同上（run service 构造成功才有）。
    listDynamicWorkflowRuns: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRuns.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRuns) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRuns", sessionId);
      }
      // 经 app 调用（不可解构：实现可能依赖 this 绑定）。
      return record.app.listDynamicWorkflowRuns(input);
    },
    // dwf 用户面产物的三个读面：能力条件同上。
    // ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出，不是 run 的顶层返回值。
    listDynamicWorkflowRunArtifacts: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunArtifacts.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunArtifacts) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifacts", sessionId);
      }
      return record.app.listDynamicWorkflowRunArtifacts(input);
    },
    listDynamicWorkflowRunArtifactItems: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunArtifactData.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunArtifactItems) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifactItems", sessionId);
      }
      return record.app.listDynamicWorkflowRunArtifactItems(input);
    },
    readDynamicWorkflowRunArtifact: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunArtifactRead.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.readDynamicWorkflowRunArtifact) {
        throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunArtifact", sessionId);
      }
      return record.app.readDynamicWorkflowRunArtifact(input);
    },
    // dwf 工作区 transcript 的两个读面：能力条件同上。
    listDynamicWorkflowRunWorkspaceNodes: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunWorkspace.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunWorkspaceNodes) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunWorkspaceNodes", sessionId);
      }
      return record.app.listDynamicWorkflowRunWorkspaceNodes(input);
    },
    readDynamicWorkflowRunNodeResult: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunNodeResult.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.readDynamicWorkflowRunNodeResult) {
        throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunNodeResult", sessionId);
      }
      return record.app.readDynamicWorkflowRunNodeResult(input);
    },
    previewConversationFileRewind: async (sessionId, _targetRowId, messageIds, targetTurnId) => {
      // 这里用 sessions.get 而非 backing record：真正执行回滚改的是「这个会话自己的
      // 工作区」，借父 record 预览会把父会话的文件列表当成子会话的展示给用户。
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.fileRewindPreview.sessionNotFound: ${sessionId}`);
      }
      return previewConversationFileRewind(record, messageIds, targetTurnId);
    },
    // 冷订阅不再在 eventStore / transcript 之间 XOR。message/part
    // 是已完成正文权威，session_entry 只补 legacy goal，内存事件只补
    // 未持久 in-flight 和 queue/permission/control 等 ephemeral 状态。
    loadPersistedEvents: async (sessionId, persistedMessages) => {
      // dwf workflow actor / subagent 这类 detached live child 没有自己的
      // bootstrap record（事件经 ingestDetachedLiveSession 走父 record 的 sink 路由）。
      // context.sessions.get 取不到 record 时不能直接返回 synthesized:false——
      // 否则首次订阅的 performHydration 会走"保留健康 live publisher"早退分支，
      // durable transcript 三源合并从不执行——只由 live 事件喂养的投影会丢掉所有
      // 不以 live 事件形式出现的持久正文。amend-resume 把前驱 transcript 前缀直接
      // 复制进 session store 来播种 actor 会话，
      // 这段前缀正属于此类，于是侧栏 actor transcript 只剩本次 live 增量；
      // 普通崩溃恢复后 warm 窗口同样看不到 crash 前的 actor 消息。
      // 改用 resolveConversationBackingRecord：child 自身没有 record 时按持久
      // parentID 落到父 record，只借它的共享 event/artifact store，事件读取仍显式用
      // child 自己的 sessionId（script workflow child runtime 共享父 event store，
      // 事件按 child sessionId 归档），因此 sourceEventSeq 仍是 child 的真实水位。
      // 代价：contextWindow 分母会按父 record 的当前模型解析而不是 actor 模型，纯展示层偏差。
      const record = await resolveConversationBackingRecord(context, sessionId);
      if (!record) {
        // detached live child 继续使用在线尾部；仅显式携带 M0 的冷打开可以独立物化历史。
        if (persistedMessages === undefined)
          return { events: [], synthesized: false, sourceEventSeq: 0 };
        // 主对话历史只依赖持久化事实；旧路径在这里返回空数组会把冷会话误画成空白。
        const store = context.deps.sessionStore;
        // 没有 store 说明宿主没装持久层，此时「有 M0 但读不了」是硬错误：
        // 返回空数组会让 UI 认为这是一个空会话，用户会以为历史被清除。
        if (!store) throw new Error("fault.subscribe.sessionNotFound");
        const source = await loadPersistedConversationMaterialization({
          sessionId,
          persistedMessages,
          memoryEvents: [],
          store,
        });
        const merged = mergeColdConversationEvents({ ...source, sessionId });
        // synthesized:true 是「这是重物化结果」的显式声明：ingest 可能已经抢建了
        // 一个 cold publisher，gateway 靠这个标记决定是否用本次结果替换它；标 false
        // 会让 live 与 cold 各自停在两个不同终态（INV-28）。
        return {
          events: merged.events,
          synthesized: true,
          sourceEventSeq: 0,
          ...(source.sharedContextImport
            ? { sharedContextImport: source.sharedContextImport }
            : {}),
        };
      }
      // message/part 与 session_entry 的异步读取期间 live sink 仍可收到新事件。
      // gateway 必须知道 memory eventStore 取快照时的 raw cursor，才能只补 await 窗口内
      // 的尾部，并把 transcript 合成的 1..N 序列稳定映射回后续 runtime raw seq。
      // 内存 event store 会淘汰已完成 turn 的瞬态事件，max(events.seq) 会小于真实
      // 游标，让已淘汰的 delta 被当成 await 窗口尾部重放。两次调用之间没有 await，拿到的是
      // 同一时刻的一致快照。
      const [liveEvents, sourceEventSeq] = await Promise.all([
        record.eventStore.getEvents(sessionId as SessionId),
        record.eventStore.getLatestSequenceNumber(sessionId as SessionId),
      ]);
      // workflow run 的冷回放：journal 回放出的进度
      // 事件前置到内存事件之前——cold merge 已把该类型归为 memory-only 权威（保序进 supplements），
      // 投影经同一个 reducer 归约，`workflowRuns` 因此在重启前后一致。
      const replayed = await replayDynamicWorkflowRunEvents(context, sessionId, record, liveEvents);
      const events = replayed.length === 0 ? liveEvents : [...replayed, ...liveEvents];
      const store = context.deps.sessionStore;
      const source = await loadPersistedConversationMaterialization({
        memoryEvents: events,
        persistedMessages,
        sessionId,
        ...(store
          ? {
              store: {
                getSession: (id) => store.getSession(id),
                messages: (input) => store.messages(input),
                readTarget: (input) => store.readTarget(input),
                ...(store.sessionEntries
                  ? {
                      sessionEntries: (input) =>
                        store.sessionEntries!(input).catch((error) => {
                          context.logger?.warn("v4 hydrate session entries read failed", {
                            error: error instanceof Error ? error.message : String(error),
                            event: "zcode_protocol.v4.hydrate_session_entries_failed",
                            module: "bootstrap.zcode_protocol",
                          });
                          return [];
                        }),
                    }
                  : {}),
              },
            }
          : {}),
      });
      // live ModelComplete.fileChanges 只存在于内存事件；cold merge 以持久
      // transcript 为正文权威时会压掉该事件，而 transcript 本身没有文件摘要字段。
      // workspace checkpoint + artifact 才是跨进程持久事实，这里按 user messageId
      // 重建摘要，再交给 transcript hydration 合成同构 ModelComplete。
      const fileChangeSummariesByMessageId = await buildColdFileChangeSummaries({
        events: source.memoryEvents,
        messageIds: source.messages.map((message) => String(message.info.id)),
        readArtifact: async (snapshotRef) =>
          (await record.app.readToolResultArtifact(snapshotRef)).content,
        onArtifactError: (messageId, error) =>
          context.logger?.warn("v4 cold file change artifact read failed", {
            error: error instanceof Error ? error.message : String(error),
            event: "zcode_protocol.v4.hydrate_file_changes_failed",
            messageId,
            module: "bootstrap.zcode_protocol",
            sessionId,
          }),
      });
      // 冷恢复 transcript 不保存模型能力，旧 hydration 自行填 20 万；
      // provider registry 已在 resume 前同步完成，应按恢复/退避后的当前模型精确取值。
      const contextWindow = resolveSessionModelContextWindow(context, record);
      const usageSeed = sessionUsageSeedFromRuntimeContextUsage(
        await readSessionContextUsage(context, sessionId, source.messages),
        contextWindow,
      );
      const merged = mergeColdConversationEvents({
        contextWindow,
        fileChangeSummariesByMessageId,
        memoryEvents: source.memoryEvents,
        messages: source.messages,
        sessionId,
        goalVerificationEntries: source.goalVerificationEntries,
        ...(Object.prototype.hasOwnProperty.call(source, "target")
          ? { target: source.target }
          : {}),
      });
      for (const diagnostic of merged.diagnostics) {
        const fields = {
          ...diagnostic,
          event: "zcode_protocol.v4.hydrate_three_source_merge",
          module: "bootstrap.zcode_protocol",
          sessionId,
        };
        if (
          diagnostic.code === "cold_merge.ambiguous_legacy_turn_preserved" ||
          diagnostic.code === "cold_merge.memory_boundary_preserved" ||
          diagnostic.code === "cold_merge.unclassified_event_preserved"
        ) {
          context.logger?.warn("v4 hydrate preserved ambiguous cold fact", fields);
        } else {
          log?.debug("v4 hydrate merged duplicate cold facts", fields);
        }
      }
      // transcript 可恢复 Agent row，却不能证明 child session 已经落库。
      // 这里在 gateway 的 raw-event buffer 补回前生成校验种子，既排除旧幽灵引用，
      // 又避免异步查询覆盖 seed 之后新到达的 live spawn/stop。
      const subagents = await listSessionSubagents(
        context,
        { sessionId, endedLimit: 1 },
        persistedMessages,
      );
      return {
        events: merged.events,
        // 与合成事件共用本次查询结果；不在后续回填阶段重新读取另一份容量。
        // 不同步读取会导致首帧分母与实际事件里的读数来自两个时间点，进度条先跳后回。
        usageSeed,
        // gateway 旧字段名仍叫 synthesized；这里表示投影已由 durable
        // transcript 重物化，需替换 ingest 抢先建的 cold publisher。
        synthesized: merged.usedDurableTranscript,
        // subagentsSeed 必须在 raw-event buffer 回放之前给出：回放会把本进程内
        // spawn/stop 事件重新计一遍，若种子晚到就会覆盖这些更新（INV-9 同类约束）。
        subagentsSeed: {
          revision: subagents.revision,
          childSessionIds: subagents.childSessionIds,
          running: subagents.running,
        },
        ...(source.sharedContextImport ? { sharedContextImport: source.sharedContextImport } : {}),
        // sourceEventSeq 用 eventStore 的真实 water mark 而不是 max(events.seq)：
        // 淘汰机制让后者偏小，delta 会被当作尾部重复回放（INV-8）。
        sourceEventSeq,
      };
    },
    onError: (scope, error, errorContext) =>
      // 统一出口而不是各处 logger：gateway 内部的异常没有调用方可以接住，
      // 收敛到一处才能保证每条都带 scope，便于定位是哪一类命令/订阅出的问题。
      context.logger?.warn("ZCode Protocol v4 gateway error", {
        ...errorContext,
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.v4.gateway_error",
        module: "bootstrap.zcode_protocol",
        scope,
      }),
  });
}
