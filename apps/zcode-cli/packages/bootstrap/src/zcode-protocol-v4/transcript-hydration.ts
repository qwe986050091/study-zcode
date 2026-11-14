/**
 * ============================================================================
 * zcode-protocol-v4/transcript-hydration.ts —— transcript → 等价事件序列
 * ============================================================================
 *
 * 【核心等价】reduce(transcript) ≡ reduce(events)。
 *   v4 投影是事件溯源，但部分历史突变（纯对话 fork 只复制 message 不复制 event、
 *   rewind 截断只动 message 库）会让事件日志覆盖不到可见 transcript。
 *   本文件把 message 库反向合成为 ProductProjection 能消费的最小事件序列，
 *   从而复用同一套归约逻辑，而不是再写一份 message→row 的平行归约器。
 *
 * 【为什么必须合成 tool/reasoning/subagent/compact part】
 *   冷恢复只能重放 ProductProjection 认识的事件；漏合成任何一种 part，
 *   重启后对应的历史可见运行态都会从快照里消失。
 *
 * 【守恒判据】eventsCoverTranscript 用 transcriptFootprint / projectionFootprint
 *   对比用户轮、assistant 文本、reasoning、toolCallId、compact、subagent、
 *   goal verify、model change 等计数；只有事件日志确实覆盖 transcript 时才跳过
 *   重建，否则必须走完整 hydration。
 *
 * 【确定性】合成使用调用方传入的 baseTimestampMs，不调用 Date.now；
 *   事件 id 是 `hydrate-N`，sequenceNumber 递增，保证重放可复现。
 *
 * 【合成事件与 live 如何共用 reducer】
 *   合成序列只使用 ProductProjection 已认识的 SessionEventType 与 payload 形状：
 *   TurnStarted / ModelStreaming / ToolCall* / Compact* /
 *   TargetCompletionVerification / Subagent* / SessionForked / TurnComplete / TurnError。
 *   冷路径不另写 message→row 归约器，因此同一份持久事实无论先经 live 还是先经
 *   hydration，进入 ProductProjection 后都得到相同 rows/state（不变量 17）。
 *
 * 【持久事实来源】
 *   message/part（user 轮、assistant text/reasoning/tool、compaction、timeline、
 *   subtask）、session_input ledger（intent/queue admission/guide delivery）、
 *   session metadata（workflowLaunch、originMeta、assistantFeedback）、
 *   session_target → TargetChanged（由 cold-event-merge 注入）、
 *   session_entry goal verification、workspace checkpoint artifact → 单轮文件变更摘要。
 *
 * 【失败与降级】
 *   - 历史 pending/running 工具与 goal verifier 无法证明仍在运行：统一收口 cancelled；
 *   - legacy 缺持久 messageId 的轮退回 hydrate-turn-N，只保证内容不丢；
 *   - 畸形 metadata/artifact 按字段缺席处理，由调用方诊断，绝不抛断整条冷恢复。
 * ============================================================================
 */

// 详细口径见上方文件头；这里只保留实现入口。
// 文件头：transcript（message/part 库）→ 与 live 归约等价的 SessionEvent 序列。
// 职责：轮次切分、part→事件合成、goal/model/compact 边界重建、覆盖判据。
// 边界：不做 IO、不读 registry、不写库；所有外部事实由 SynthesizeOptions 注入。
//
// 不变量（INV）：
// INV-01 断言：reduce(transcript) 必须与 reduce(events) 得到同一 ProductProjection 快照。
// 守护：所有合成只用 ProductProjection 已认识的 SessionEventType 与 payload 形状。
// 改错故障：冷恢复多出或缺少 row，刷新前后 UI 不一致。
// INV-02 断言：合成是确定性的，不得调用 Date.now/随机数。
// 守护：baseTimestampMs 由调用方传入，缺失时回落 messages[0] 创建时间。
// 改错故障：同一 transcript 两次恢复得到不同时间戳，测试与快照不可复现。
// INV-03 断言：事件 id 恒为 hydrate-N，sequenceNumber 严格单调递增。
// 守护：push 闭包内 seq += 1 后再写入。
// 改错故障：id 或 seq 重复，投影按 seq 排序时顺序抖动。
// INV-04 断言：sourceTimestamp 只影响 row 展示时间，不参与事件全序。
// 守护：push 的 timestamp 与 sequenceNumber 分离。
// 改错故障：用时间戳排序会让跨轮事件错位。
// INV-05 断言：guide steer 必须内联进当前轮，不另开轮。
// 守护：isTurnBoundaryStarter 对 guide 返回 false，collectTurnOutput 发 TurnSteerDrained。
// 改错故障：一条引导被拆成两个用户轮，内容重复。
// INV-06 断言：model-only 唤醒必须开独立轮，不能并进上一轮。
// 守护：isTurnBoundaryStarter 的 getConversationModelOnlyTurnTriggerSource 分支。
// 改错故障：后台任务结果被挂到上一轮，turn 统计与耗时错乱。
// INV-07 断言：workflow 启动轮必须在 real-user 分支之前识别。
// 守护：workflowLaunchOfMessage 判断位于 isRealUserTurnStarter 之前。
// 改错故障：启动轮被当 hiddenSynthetic 跳过，启动卡消失。
// INV-08 断言：历史 pending/running 工具必须收口为 cancelled。
// 守护：synthesizeToolPart 末尾无条件返回 cancelled。
// 改错故障：重启后 active work/stop 按钮复活，实际无执行者。
// INV-09 断言：stream-recovery 丢弃标记对本轮结果透明。
// 守护：isPersistedStreamRecoveryDiscard 在结果判定中映射为 success。
// 改错故障：重开会话凭空弹出“Partial assistant output was discarded”。
// INV-10 断言：缺少 completed 时间的 assistant 轮按 cancelled 处理。
// 守护：synthesizeAssistantParts 的 time.completed === undefined 分支。
// 改错故障：进程中断的半截输出被当成正常完成。
// INV-11 断言：providerContextOnly assistant 必须整条跳过。
// 守护：collectTurnOutput 与主循环的 isProviderContextOnlyAssistant 分支。
// 改错故障：副屏泄漏父会话时间线。
// INV-12 断言：compact 同 operationId 只发一次，durable part 优先。
// 守护：emittedCompactOperations 与 durableCompactPartsByOperation 覆盖逻辑。
// 改错故障：重复 compact marker，或丢失 tailStartMessageId。
// INV-13 断言：goal verify 的 timeline part 与 session_entry 按 key 跨源去重。
// 守护：emittedGoalVerifications 与统一 key targetId_goalIteration。
// 改错故障：每次冷恢复 goal marker 翻倍。
// INV-14 断言：anchor 失配的 goal entry 落到时间线末尾，不得丢弃。
// 守护：synthesizeEventsFromMessages 末尾对 entryFacts 的补发循环。
// 改错故障：漏发 entryFacts 会让历史验证结论在恢复后静默消失。
// INV-15 断言：model_change 的 toModel 是权威边界，先于滞后 user 快照。
// 守护：recordTimelineModel 写入 pendingTimelineModel，selectAcceptedTurnModel 优先取它。
// 改错故障：模型切换 marker 丢失或指向旧模型。
// INV-16 断言：hs 加速卡的 execution 作用域选型不得合成 ModelSelected。
// 守护：sessionModelSelectionOfHydratedMessage 对 highspeed provider 返回 null。
// 改错故障：highspeed provider 重启后出现“加速 → 原模型”的虚假切换提示。
// INV-17 断言：覆盖判据任一维度不足即必须完整 hydration。
// 守护：footprintCovered 的全维度与多重集包含。
// 改错故障：事件日志缺 tool/reasoning 时被误判为已覆盖，row 永久缺失。
// INV-18 断言：畸形 metadata/artifact 只丢字段，绝不抛断整条冷恢复。
// 守护：parseJsonObject 与各 safeParse 的 success 判断。
// 改错故障：一条坏记录让整会话无法打开。
import type {
  AssistantErrorInfo,
  BackgroundResultOriginMeta,
  CompactTimelineStatus as CompactTimelineStatusValue,
  MessagePart,
  MessageWithParts,
  ModelSelection,
  TurnFileChangeSummary,
  TurnInputIntentMetadata,
} from "@zcode/contracts";
import { isHighspeedProviderId } from "@zcode/shared";
import type { EventId, SessionEvent, SessionId, TraceId, TurnId } from "@zcode/contracts";
import {
  CompactTimelineStatus,
  CompactTrigger,
  CoreErrorType,
  createSessionId,
  ModelErrorCode,
  parseCompletedToolPartMetadata,
  SessionEventType,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
} from "@zcode/contracts";
import {
  getConversationModelOnlyTurnTriggerSource,
  getConversationMessageProjectionPolicy,
  highspeedMessageMetaSchema,
  isConversationRealUserTurnStarter,
} from "@zcode/shared";
import {
  conversationInputIntentSchema,
  errorAttributionSchema,
  workflowBlockedMetaSchema,
  workflowLaunchMetaSchema,
  workflowNotificationMetaSchema,
  type ErrorAttribution,
  type WorkflowLaunchMeta,
} from "@zcode/shared/zcode-protocol-v4";
import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";
import { ProductProjection } from "./product-projection.js";
import { HYDRATION_TRACE_ID } from "./projection-state.js";

// [契约] 只有这三个工具名会被合成为 subagent 生命周期。
// 新增内置子代理工具必须同步此集合，否则侧栏入口在冷恢复后消失。
// 大小写敏感，与持久化 tool 名原样比较。
const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);
const LEGACY_MODEL_REQUEST_CANCELLED_MESSAGE = "Model request was cancelled.";
const LEGACY_PROTOCOL_SESSION_STOPPED_MESSAGE = "ZCode Protocol session stopped";
// [契约] 判定“持久化取消”的错误码白名单，跨 contracts 与 model 两套枚举。
// 字符串字面量兜底旧数据的裸 code。
// 新增取消码必须加到这里，否则会被恢复成 TurnError。
const PERSISTED_CANCELLATION_CODES = new Set<string>([
  CoreErrorType.TurnCancelled,
  ModelErrorCode.ModelRequestCancelled,
  "MODEL_REQUEST_CANCELLED",
  "ABORT_ERR",
]);

// [契约] 合成事件的唯一出口，负责 id/seq/traceId 的确定性赋值。
// 所有合成函数都只接收它，不直接触碰 events 数组。
// 第四个参数是展示时间，不是排序依据。
type PushEvent = (
  type: SessionEventType,
  payload: unknown,
  turnId?: string,
  sourceTimestampMs?: number,
) => void;

type TurnResultForHydration = "success" | "cancelled" | "error_during_execution";

// [契约] 单条 assistant 的合成结果：本轮回合结果与工具计数。
// toolCallCount 会计入 TurnComplete，不能重复累计。
// resultType 经 normalizeTurnResult 单调变差，不可回升。
interface AssistantSynthesisState {
  toolCallCount: number;
  resultType: TurnResultForHydration;
}

// [契约] 期望值计数口径，必须与 ProductProjection 的 row 生成条件同源。
// 文本/工具用数组做多重集包含，其余用计数。
// 新增 row 类型（如 goal/model change）时必须同时扩这里与 projectionFootprint。
interface TranscriptFootprint {
  userTurnCount: number;
  assistantTexts: string[];
  reasoningTexts: string[];
  toolCallIds: string[];
  compactMarkerCount: number;
  subagentCount: number;
  forkTimelineCount: number;
  // 16-timeline-authority-plan P1：守恒判据曾对 goal verify / model change 全盲
  //（footprint 不计数 → 缺这两类 marker 的事件日志被误判为已覆盖）。
  goalVerificationCount: number;
  modelChangeCount: number;
}

interface ParsedSubagentOutput {
  agentId?: string;
  agentType?: string;
  childSessionId?: string;
  description?: string;
  parentToolCallId?: string;
  prompt?: string;
  summaryText?: string;
}

interface SynthesizeOptions {
  sessionId: string;
  /**
   * 当前 session 实际选中模型的权威上下文窗口。
   * transcript 只持久化 token 用量，不持久化模型能力，必须由当前 workspace registry 注入。
   */
  contextWindow?: number;
  /** 合成基准时间戳（确定性：不用 Date.now，由调用方传入首条消息时间兜底）。 */
  baseTimestampMs?: number;
  /**
   * session_entry legacy 源的 goal verify 事实：
   * 有 anchor 的按 anchorAssistantMessageId 落到对应 assistant 之后，
   * 无 anchor/anchor 失配的落到已知时间线末尾；与 timeline part 按 key 去重。
   */
  goalVerificationEntries?: readonly HydratedGoalVerificationEntry[];
  /**
   * workspace checkpoint artifact 按真实 user messageId 重建出的单轮摘要。
   * transcript 没有该字段，必须显式注入合成 ModelComplete 才能保持 live/cold 等价。
   */
  fileChangeSummariesByMessageId?: ReadonlyMap<string, TurnFileChangeSummary>;
}

// [契约] 包装 shared 的 projection policy，保证冷热两侧同一判据。
// 不要在本地复写可见性规则，policy 变更需一处生效。
// workflow 启动轮不满足该判据，需单独识别。
function isRealUserTurnStarter(message: MessageWithParts): boolean {
  return isConversationRealUserTurnStarter(message);
}

/**
 * 中枢直接启动工作流的启动轮消息。核心持久化时写
 * `source: "workflow_launch"` + `metadata.workflowLaunch`（冷恢复的权威来源）。它是 synthetic
 * 但语义上属于用户真实动作的可见消息，共享投影 policy 会把 synthetic user 归成 hiddenSynthetic，
 * 因此 `isConversationRealUserTurnStarter` 认不出它；冷路径据本判据在 real-user 分支之前显式重建
 * 与活投影同形的 controlOnly 启动轮（TurnStarted{inputSource, workflowLaunch, executionKind} +
 * TurnComplete），而不是被当作隐藏 synthetic 跳过。畸形 / 缺席元数据回 null（退回既有跳过语义）。
 */
// [失败路径] role 不是 user、source 不是 workflow_launch、元数据畸形都返回 null。
// null 意味着退回“跳过 synthetic user”的既有语义。
// 不要在此兜底构造默认元数据，会伪造启动事实。
function workflowLaunchOfMessage(message: MessageWithParts): WorkflowLaunchMeta | null {
  if (message.info.role !== "user") return null;
  if (message.info.source !== "workflow_launch") return null;
  const metadata = message.info.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const parsed = workflowLaunchMetaSchema.safeParse(
    (metadata as Record<string, unknown>).workflowLaunch,
  );
  return parsed.success ? parsed.data : null;
}

// [契约] 只命中 assistant 且 projection policy 为 providerContextOnly。
// 命中者整条跳过，其 parts 不产生任何 row。
// 不要改成只跳过 user carrier，那正是副屏泄漏的旧 bug。
function isProviderContextOnlyAssistant(message: MessageWithParts): boolean {
  return (
    message.info.role === "assistant" &&
    getConversationMessageProjectionPolicy(message) === "providerContextOnly"
  );
}

// [契约] 拼接所有未 ignored 的 text part，顺序即 parts 顺序。
// 空字符串是合法结果，调用方自行决定是否开轮。
// 不要在这里 trim，trim 由具体使用点（如 legacy compact 判定）负责。
function textOfMessage(parts: readonly MessagePart[]): string {
  return parts
    .filter(
      (part): part is Extract<MessagePart, { type: "text" }> =>
        part.type === "text" && part.ignored !== true,
    )
    .map((part) => part.text)
    .join("");
}

function finiteTimeMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function messageCreatedAtMs(message: MessageWithParts): number | undefined {
  return finiteTimeMs(message.info.time.created);
}

function intervalEndOrStartMs(time: { start: number } & Partial<{ end: number }>) {
  return finiteTimeMs(time.end) ?? finiteTimeMs(time.start);
}

function partEndAtMs(part: MessagePart): number | undefined {
  if (part.type === "reasoning") {
    return finiteTimeMs(part.time?.end) ?? finiteTimeMs(part.time?.start);
  }
  if (part.type === "tool" && "time" in part.state) {
    return intervalEndOrStartMs(part.state.time);
  }
  return undefined;
}

// [契约] 消息结束时间取 completed 或 created，再与各 part 结束时间取最大。
// user 消息没有 completed，必须按字段存在性收窄。
// 返回 undefined 表示无法确定时间，调用方保留原 turnEndedAtMs。
function messageEndAtMs(message: MessageWithParts): number | undefined {
  const time = message.info.time;
  // 冷恢复会同时处理 user/assistant message；user 只有 created，
  // assistant 才可能有 completed，所以这里必须按字段存在性收窄后再取结束时间。
  let end =
    ("completed" in time ? finiteTimeMs(time.completed) : undefined) ?? finiteTimeMs(time.created);
  for (const part of message.parts) {
    const partEnd = partEndAtMs(part);
    if (partEnd !== undefined) {
      end = end === undefined ? partEnd : Math.max(end, partEnd);
    }
  }
  return end;
}

// [契约] 结果合并是单调的：cancelled 优先于 error，error 优先于 success。
// 同一轮内出现 cancelled 即整轮取消，不因后续 success 而回升。
// 不要改成“最后一次写入覆盖”，工具循环会让结果抖动。
function normalizeTurnResult(
  current: TurnResultForHydration,
  next: TurnResultForHydration,
): TurnResultForHydration {
  if (current === "cancelled" || next === "cancelled") {
    return "cancelled";
  }
  if (current === "error_during_execution" || next === "error_during_execution") {
    return "error_during_execution";
  }
  return "success";
}

function assistantErrorData(error: AssistantErrorInfo): Record<string, unknown> | undefined {
  return error.data && typeof error.data === "object" && !Array.isArray(error.data)
    ? error.data
    : undefined;
}

function persistedErrorAttribution(
  data: Record<string, unknown> | undefined,
): ErrorAttribution | undefined {
  const parsed = errorAttributionSchema.safeParse(data?.attribution);
  return parsed.success ? parsed.data : undefined;
}

// [失败路径] 先看结构化 turnResult/resultType/code，再看 AbortError。
// 旧 session/stop 的普通 Error 需按 message 精确匹配，不能泛化。
// 新增取消形态必须收窄匹配，避免把真实错误当取消。
function isPersistedAssistantCancellation(error: AssistantErrorInfo): boolean {
  const data = assistantErrorData(error);
  const code = typeof data?.code === "string" ? data.code : undefined;
  if (
    data?.turnResult === "cancelled" ||
    data?.resultType === "cancelled" ||
    (code !== undefined && PERSISTED_CANCELLATION_CODES.has(code)) ||
    error.name === "AbortError"
  ) {
    return true;
  }

  if (
    code === undefined &&
    error.name === "Error" &&
    data?.message === LEGACY_PROTOCOL_SESSION_STOPPED_MESSAGE
  ) {
    // 旧 session/stop 使用普通 Error 作为 AbortSignal.reason，transcript 又未持久化
    // cancelled result；冷恢复若只认 AbortError，会把用户停止重新合成为 TurnError 和错误 Banner。
    return true;
  }

  // 旧 transcript 的 AiSdkModelAdapterError 没有持久化 model error code，
  // 只能用 ZCode 自身生成的标准 name/message 二元组兼容恢复；不泛化匹配 provider 文案。
  return (
    code === undefined &&
    error.name === "AiSdkModelAdapterError" &&
    data?.message === LEGACY_MODEL_REQUEST_CANCELLED_MESSAGE
  );
}

/**
 * stream recovery 把作废的半截 assistant 持久化成带 error 的消息，随后从锚点
 * 重发并正常完成；live 投影只把它收口为 interrupted 行，不产生 TurnError。旧冷恢复却把
 * 任何带 error 的 assistant 都当本轮失败，重开会话后凭空弹出「Partial assistant output
 * was discarded」的错误 Banner。这个标记只服务压缩/fork 边界隔离，对本轮结果必须透明。
 */
// [契约] 只按 STREAM_RECOVERY_DISCARDED_ERROR_NAME 判定。
// 该标记只服务压缩/fork 边界隔离，对本轮结果透明。
// 把它当失败会让恢复后多出错误 Banner。
function isPersistedStreamRecoveryDiscard(error: AssistantErrorInfo): boolean {
  return error.name === STREAM_RECOVERY_DISCARDED_ERROR_NAME;
}

// [契约] 合成工具固定为单工具串行调度，executionOrder 与 parallelGroups 一致。
// 历史调度信息未持久化，不能凭空推断并行关系。
// 改成空数组会让 ToolCallScheduled 被投影拒绝。
function stableToolSchedule(toolCallId: string) {
  return {
    executionOrder: [toolCallId],
    parallelGroups: [[toolCallId]],
  };
}

// [契约] Started/Retrying 映射 CompactStarted，Completed/Skipped 映射 Completed。
// 其余（含 Failed/Interrupted）一律 CompactFailed。
// 新增状态时需明确归属，否则静默落进失败分支。
function compactEventType(status: CompactTimelineStatusValue): SessionEventType {
  if (status === CompactTimelineStatus.Started || status === CompactTimelineStatus.Retrying) {
    return SessionEventType.CompactStarted;
  }
  if (status === CompactTimelineStatus.Completed || status === CompactTimelineStatus.Skipped) {
    return SessionEventType.CompactCompleted;
  }
  return SessionEventType.CompactFailed;
}

// [失败路径] 未知状态返回 null，表示该 part 不产生 compact 事件。
// legacy 的 cancelled 统一归一为 Interrupted。
// 不要为未知状态兜底成 Started，会伪造进行中的压缩。
function normalizeCompactTimelineStatus(
  status: string | undefined,
): CompactTimelineStatusValue | null {
  switch (status) {
    case CompactTimelineStatus.Started:
    case CompactTimelineStatus.Retrying:
    case CompactTimelineStatus.Skipped:
    case CompactTimelineStatus.Completed:
    case CompactTimelineStatus.Failed:
    case CompactTimelineStatus.Interrupted:
      return status;
    case "cancelled":
      return CompactTimelineStatus.Interrupted;
    default:
      return null;
  }
}

function compactTriggerOfPart(part: Extract<MessagePart, { type: "compaction" }>) {
  return part.trigger ?? (part.auto ? CompactTrigger.Auto : CompactTrigger.Manual);
}

// [契约] timeline part 的 payload 只做字段透传，缺省字段用条件展开省略。
// messageId/partId 强转字符串，保证与 live payload 同型。
// 不要在这里补默认 trigger，缺失就是缺失。
function compactPayloadFromTimelinePart(part: Extract<MessagePart, { type: "timeline" }>) {
  if (part.timelineType !== "context_compaction") return null;
  const status = normalizeCompactTimelineStatus(part.status);
  if (!status) return null;
  return {
    status,
    payload: {
      operationId: part.operationId,
      messageId: String(part.messageID),
      partId: part.id,
      status,
      trigger: part.trigger,
      display: part.display,
      ...(part.sourceCommandId ? { sourceCommandId: part.sourceCommandId } : {}),
      ...(part.anchorMessageId ? { anchorMessageId: part.anchorMessageId } : {}),
      ...(part.anchorTurnId ? { anchorTurnId: part.anchorTurnId } : {}),
      ...(part.phase ? { phase: part.phase } : {}),
      ...(part.compactReason ? { compactReason: part.compactReason } : {}),
      ...(part.reason ? { reason: part.reason } : {}),
      ...(part.boundaryId ? { boundaryId: part.boundaryId } : {}),
      ...(part.summaryMessageId ? { summaryMessageId: part.summaryMessageId } : {}),
      ...(part.preCompactTokenCount !== undefined
        ? { preCompactTokenCount: part.preCompactTokenCount }
        : {}),
      ...(part.postCompactTokenCount !== undefined
        ? { postCompactTokenCount: part.postCompactTokenCount }
        : {}),
      ...(part.truePostCompactTokenCount !== undefined
        ? { truePostCompactTokenCount: part.truePostCompactTokenCount }
        : {}),
      ...(part.attempt !== undefined ? { attempt: part.attempt } : {}),
      ...(part.maxAttempts !== undefined ? { maxAttempts: part.maxAttempts } : {}),
      ...(part.time?.start !== undefined ? { startedAt: part.time.start } : {}),
      ...(part.time?.end !== undefined ? { endedAt: part.time.end } : {}),
    },
  };
}

// [契约] legacy compaction part 是 durable 事实源，operationId 三级回退。
// display 缺省为 separator，与旧 UI 一致。
// 该函数也被 durable 覆盖逻辑复用，改动会影响两条路径。
function compactPayloadFromLegacyCompactionPart(
  part: Extract<MessagePart, { type: "compaction" }>,
) {
  const status = normalizeCompactTimelineStatus(part.timelineStatus);
  if (!status) return null;
  return {
    status,
    payload: {
      operationId: part.operationId ?? part.boundaryId ?? `legacy-compact-${String(part.id)}`,
      messageId: String(part.messageID),
      partId: part.id,
      status,
      trigger: compactTriggerOfPart(part),
      display: part.timelineDisplay ?? "separator",
      ...(part.phase ? { phase: part.phase } : {}),
      ...(part.compactReason ? { compactReason: part.compactReason } : {}),
      ...(part.reason ? { reason: part.reason } : {}),
      ...(part.boundaryId ? { boundaryId: part.boundaryId } : {}),
      ...(part.summaryMessageId ? { summaryMessageId: part.summaryMessageId } : {}),
      ...(part.tail_start_id ? { tailStartMessageId: part.tail_start_id } : {}),
      ...(part.preCompactTokenCount !== undefined
        ? { preCompactTokenCount: part.preCompactTokenCount }
        : {}),
      ...(part.postCompactTokenCount !== undefined
        ? { postCompactTokenCount: part.postCompactTokenCount }
        : {}),
      ...(part.truePostCompactTokenCount !== undefined
        ? { truePostCompactTokenCount: part.truePostCompactTokenCount }
        : {}),
      ...(part.attempt !== undefined ? { attempt: part.attempt } : {}),
      ...(part.maxAttempts !== undefined ? { maxAttempts: part.maxAttempts } : {}),
      ...(part.time?.start !== undefined ? { startedAt: part.time.start } : {}),
      ...(part.time?.end !== undefined ? { endedAt: part.time.end } : {}),
    },
  };
}

// [失败路径] 非字符串、非对象、数组、解析异常一律返回 null。
// 调用方据 null 让字段整体缺席，而不是抛错。
// 不要吞掉非 JSON 的纯文本输出，那是刻意保留的 fallback。
function parseJsonObject(input: string | undefined): Record<string, unknown> | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringField(
  source: Record<string, unknown> | undefined | null,
  key: string,
): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 用户消息 metadata 中的 ConversationInputIntent → TurnStarted.intent。
 *
 * 完整 schema 优先；旧 transcript 的 metadata.inputIntent 只在字段齐全且取值合法时
 * 才接受，否则整体按缺席处理（宁可少展示 context，也不伪造命令身份）。
 * highspeed 允许从独立 metadata 补齐；text 只读持久 intent，不从文案反解。
 * 副作用：无；不读取 workspace/model registry，也不写回消息。
 */
// [失败路径] 完整 schema 优先；legacy seed 必须字段齐全且取值合法才接受。
// 否则整体按缺席处理，宁可少展示 context 也不伪造命令身份。
// text 只读持久 intent，禁止从命令文案反解。
function inputIntentOfMessage(message: MessageWithParts): TurnInputIntentMetadata | undefined {
  const persistedHighspeed = highspeedMessageMetaSchema.safeParse(message.info.metadata?.highspeed);
  const fullIntent = conversationInputIntentSchema.safeParse(
    message.info.metadata?.conversationInputIntent,
  );
  if (fullIntent.success) {
    const value = fullIntent.data;
    return {
      sourceCommandId: value.sourceCommandId,
      queueItemId: value.queueItemId,
      clientId: value.clientId,
      kind: value.kind,
      // 可见 text 是展示事实；goal 的 canonical objective 只能读取持久 intent.text，
      // 禁止从 `/goal replace ...` 文案再做大小写/关键字解析。
      text: value.text,
      ...(value.modelSelection ? { modelSelection: value.modelSelection } : {}),
      ...(value.mode ? { mode: value.mode } : {}),
      ...(value.planEnabled !== undefined ? { planEnabled: value.planEnabled } : {}),
      admissionSeq: value.order.admissionSeq,
      admittedAt: value.admittedAt,
      requestedDelivery: value.delivery.requested,
      admittedDelivery: value.delivery.admitted,
      ...(value.order.queuePosition !== undefined
        ? { queuePosition: value.order.queuePosition }
        : {}),
      ...(value.delivery.fallbackReasonCode
        ? { fallbackReasonCode: value.delivery.fallbackReasonCode }
        : {}),
      ...(value.attachments.length > 0 ? { attachmentRefs: value.attachments } : {}),
      ...(value.highspeed
        ? { highspeed: value.highspeed }
        : persistedHighspeed.success
          ? { highspeed: persistedHighspeed.data }
          : {}),
      ...(value.inputOrigin ? { inputOrigin: value.inputOrigin } : {}),
      ...(value.conversationQuotes ? { conversationQuotes: value.conversationQuotes } : {}),
      ...(value.botGroupSource ? { botGroupSource: value.botGroupSource } : {}),
      ...(value.provenance ? { provenance: value.provenance } : {}),
      ...(value.source ? { source: value.source } : {}),
    };
  }

  // 兼容之前只持久化 metadata seed 的 transcript；新写入一律走上面的完整事实。
  const value = message.info.metadata?.inputIntent;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const intent = value as Record<string, unknown>;
  if (
    typeof intent.sourceCommandId !== "string" ||
    typeof intent.queueItemId !== "string" ||
    typeof intent.clientId !== "string" ||
    (intent.kind !== "sendText" && intent.kind !== "sendGoalCommand") ||
    typeof intent.admissionSeq !== "number" ||
    typeof intent.admittedAt !== "number" ||
    (intent.requestedDelivery !== "auto" &&
      intent.requestedDelivery !== "startNow" &&
      intent.requestedDelivery !== "queue" &&
      intent.requestedDelivery !== "guide") ||
    (intent.admittedDelivery !== "startNow" &&
      intent.admittedDelivery !== "queue" &&
      intent.admittedDelivery !== "guide")
  ) {
    return undefined;
  }
  return {
    ...(value as unknown as TurnInputIntentMetadata),
    ...(persistedHighspeed.success ? { highspeed: persistedHighspeed.data } : {}),
  };
}

function executionKindOfMessage(message: MessageWithParts): "agent" | "controlOnly" | undefined {
  const value = message.info.metadata?.executionKind;
  return value === "agent" || value === "controlOnly" ? value : undefined;
}

/**
 * 引擎附加文本的起点：热路径它在 TurnStarted 上，
 * 冷路径从用户消息 metadata 读回同一个字段。只认非负整数——别的形状按缺席处理（宁可多显示）。
 */
// [契约] epilogueStart 只接受非负整数，浮点或字符串按缺席处理。
// 这是冷热路径 epilogue 起点保持一致的关键字段。
// 不要用 >= 0 之外的宽松判断，浮点时间戳会错位。
function epilogueStartOfMessage(message: MessageWithParts): number | undefined {
  const value = message.info.metadata?.epilogueStart;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function contentBlocksToText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const chunks = value
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const text = (block as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    })
    .filter((text) => text.length > 0);
  return chunks.length > 0 ? chunks.join("\n\n") : undefined;
}

// [契约] 从 tool part 的 output/metadata/input 三级提取 subagent 事实。
// agentId 最终回退到 callID，保证永远可寻址。
// childSessionId 缺失时由稳定 agentId 推导，否则侧栏入口丢失。
function subagentInfoFromToolPart(
  part: Extract<MessagePart, { type: "tool" }>,
): ParsedSubagentOutput | null {
  if (!SUBAGENT_TOOL_NAMES.has(part.tool)) return null;
  const input =
    part.state.input && typeof part.state.input === "object"
      ? (part.state.input as Record<string, unknown>)
      : {};
  const output = part.state.status === "completed" ? parseJsonObject(part.state.output) : null;
  const metadata = part.metadata && typeof part.metadata === "object" ? part.metadata : {};
  const explicitAgentId =
    stringField(output, "agentId") ??
    stringField(metadata, "agentId") ??
    agentIdFromToolOutput(part.state.status === "completed" ? part.state.output : undefined);
  const agentId = explicitAgentId ?? part.callID;
  return {
    agentId,
    agentType:
      stringField(output, "agentType") ??
      stringField(metadata, "agentType") ??
      stringField(input, "agent") ??
      stringField(input, "agentType") ??
      "subagent",
    childSessionId:
      stringField(output, "childSessionId") ??
      stringField(metadata, "childSessionId") ??
      // 后台 Agent 的持久化 tool output 是人类可读文本而非 JSON；cold merge
      // 会抑制重复 durable spawned，若不从稳定 agentId 行恢复 child session，侧栏入口会丢失。
      (explicitAgentId ? createSessionId(`subagent_${agentId}`) : undefined),
    description:
      stringField(output, "description") ??
      stringField(input, "description") ??
      stringField(metadata, "description"),
    parentToolCallId: part.callID,
    prompt: stringField(output, "prompt") ?? stringField(input, "prompt"),
    summaryText:
      contentBlocksToText(output?.content) ??
      stringField(output, "result") ??
      stringField(output, "summary") ??
      stringField(input, "description") ??
      stringField(input, "prompt"),
  };
}

// [失败路径] 后台 Agent 的持久化 output 是文本而非 JSON，只能按行首匹配。
// 正则限定 agentId: 前缀，避免误抓正文。
// 匹配不到返回 undefined，由调用方回退 callID。
function agentIdFromToolOutput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return /(?:^|\r?\n)agentId:\s*([^\s(]+)/u.exec(value)?.[1];
}

// [契约] completed→completed，error→failed，其余一律 cancelled。
// pending/running 视为已终止（重启后无法证明仍在运行）。
// 与工具的 pending/running 收口语义保持一致。
function subagentStatusFromToolPart(
  part: Extract<MessagePart, { type: "tool" }>,
): "completed" | "failed" | "cancelled" {
  switch (part.state.status) {
    case "completed":
      return "completed";
    case "error":
      return "failed";
    default:
      return "cancelled";
  }
}

/**
 * 附件渲染：FilePart → TurnStarted 附件展示元信息（TurnAttachmentMeta）。
 * 冷订阅/fork-child 的历史附件由 transcript 反向合成——与 live 事件同一投影入口
 * （buildUserInputRow），保证冷/热路径行内容一致。
 */
// [契约] FilePart 投影为附件展示元信息，与 live 的 buildUserInputRow 同形。
// 只有稳定 ref（非 data: URL）才写入 ref，避免把内联大文本带进快照。
// bytes 缺失记 0，不推断。
function attachmentMetasOfMessage(
  parts: readonly MessagePart[],
): Array<{ fileName: string; mime: string; bytes: number; ref?: string }> {
  const fileParts = parts.filter(
    (part): part is Extract<MessagePart, { type: "file" }> => part.type === "file",
  );
  return fileParts.map((part, index) => {
    const urlIsStableRef = part.url.length > 0 && !part.url.startsWith("data:");
    const basenameFromUrl = urlIsStableRef ? (part.url.split(/[\\/]/).pop() ?? "") : "";
    return {
      fileName: part.filename ?? (basenameFromUrl || `attachment-${index + 1}`),
      mime: part.mime,
      bytes: part.metadata?.sizeBytes ?? 0,
      ...(urlIsStableRef ? { ref: part.url } : {}),
    };
  });
}

// [契约] 先找 session_fork timeline part，再退回 text part metadata，最后看消息 metadata。
// 该顺序决定同一消息存在多份 fork 事实时的权威来源。
// 返回 undefined 表示该消息不携带 fork 上下文。
function forkContextOfMessage(message: MessageWithParts):
  | {
      parentSessionId: string;
      restoredFileCount?: number;
      targetCheckpointId?: string;
      targetMessageId?: string;
    }
  | undefined {
  for (const part of message.parts) {
    if (part.type === "timeline" && part.timelineType === "session_fork") {
      return {
        parentSessionId: String(part.parentSessionId),
        ...(typeof part.restoredFileCount === "number"
          ? { restoredFileCount: part.restoredFileCount }
          : {}),
        ...(part.targetCheckpointId ? { targetCheckpointId: part.targetCheckpointId } : {}),
        ...(part.targetMessageId ? { targetMessageId: String(part.targetMessageId) } : {}),
      };
    }
    const metadata = part.type === "text" ? part.metadata : undefined;
    const context = forkContextFromMetadata(metadata);
    if (context) return context;
  }
  return message.info.role === "user" ? forkContextFromMetadata(message.info.metadata) : undefined;
}

function forkContextFromMetadata(metadata: Record<string, unknown> | undefined):
  | {
      parentSessionId: string;
      restoredFileCount?: number;
      targetCheckpointId?: string;
      targetMessageId?: string;
    }
  | undefined {
  const forkContext = metadata?.forkContext;
  if (typeof forkContext !== "object" || forkContext === null || Array.isArray(forkContext)) {
    return undefined;
  }
  const context = forkContext as Record<string, unknown>;
  if (context.kind !== "session_fork" || typeof context.parentSessionId !== "string") {
    return undefined;
  }
  return {
    parentSessionId: context.parentSessionId,
    ...(typeof context.restoredFileCount === "number"
      ? { restoredFileCount: context.restoredFileCount }
      : {}),
    ...(typeof context.targetCheckpointId === "string"
      ? { targetCheckpointId: context.targetCheckpointId }
      : {}),
    ...(typeof context.targetMessageId === "string"
      ? { targetMessageId: context.targetMessageId }
      : {}),
  };
}

// [契约] 必须同时满足 timelineOnly policy 与可解析的 fork 上下文。
// 命中者只发 SessionForked，不产生用户/助手 row。
// 只判 policy 会把无关 timeline 消息误当 fork。
function isForkTimelineMessage(message: MessageWithParts): boolean {
  return (
    getConversationMessageProjectionPolicy(message) === "timelineOnly" &&
    forkContextOfMessage(message) !== undefined
  );
}

/**
 * text part → text_start / text_delta / text_end 三段事件。
 * ignored 或空文本不产生 row；start 事件携带所属 assistant message 的创建时间，
 * 让冷恢复后的行时间与 live 一致（事件全序仍由 sequenceNumber 裁决）。
 * 副作用：仅 push 合成事件，不写持久层。
 */
// [契约] 一段 text 合成 start/delta/end 三段 ModelStreaming。
// text_start 必须带所属 assistant message 的创建时间，否则恢复后时间扎堆。
// ignored 或空文本直接跳过，不产生 row。
function synthesizeTextPart(
  part: Extract<MessagePart, { type: "text" }>,
  assistantMessageId: string,
  assistantMessageCreatedAtMs: number | undefined,
  push: PushEvent,
  turnId: string,
): void {
  if (part.ignored === true || part.text.length === 0) return;
  push(
    SessionEventType.ModelStreaming,
    {
      kind: "text_start",
      delta: "",
      done: false,
      assistantMessageId,
      partId: part.id,
    },
    turnId,
    // cold 合成事件不能统一用“首条消息时间 + seq”：刷新后
    // assistant 动作栏会把不同历史回复显示成接近同一时间。text row 创建时必须
    // 保留所属 transcript assistant message 的真实创建时间；事件顺序仍由 seq 裁决。
    assistantMessageCreatedAtMs,
  );
  push(
    SessionEventType.ModelStreaming,
    {
      kind: "text_delta",
      delta: part.text,
      done: false,
      assistantMessageId,
      partId: part.id,
    },
    turnId,
  );
  push(
    SessionEventType.ModelStreaming,
    { kind: "text_end", delta: "", done: false, partId: part.id },
    turnId,
  );
}

/**
 * reasoning part → reasoning_start / delta / end。
 * 空文本直接跳过，避免生成空 reasoning row；assistantMessageId 参与开段身份，
 * 使冷热路径复用同一 response 边界。
 */
// [契约] reasoning_start 携带 assistantMessageId，复用 live 的 response 边界。
// 空文本跳过，避免空 reasoning row。
// delta 只发一次，不再拆分，保证内容完整。
function synthesizeReasoningPart(
  part: Extract<MessagePart, { type: "reasoning" }>,
  assistantMessageId: string,
  push: PushEvent,
  turnId: string,
): void {
  if (part.text.length === 0) return;
  push(
    SessionEventType.ModelStreaming,
    {
      kind: "reasoning_start",
      delta: "",
      done: false,
      assistantMessageId,
      partId: part.id,
    },
    turnId,
  );
  push(
    SessionEventType.ModelStreaming,
    {
      kind: "reasoning_delta",
      delta: part.text,
      done: false,
      partId: part.id,
    },
    turnId,
  );
  push(
    SessionEventType.ModelStreaming,
    { kind: "reasoning_end", delta: "", done: false, partId: part.id },
    turnId,
  );
}

/**
 * tool/subtask 中的 subagent 事实 → SubagentSpawned + SubagentStopped。
 * status 由持久 tool state 决定；childSessionId 缺失时由稳定 agentId 推导，
 * 保证恢复后侧栏入口仍可寻址；agentId 缺失才退回 turn 兜底。
 */
// [契约] 一次生命周期固定发 Spawned(running) + Stopped(终态) 两事件。
// agentId 缺失时用 turnId 兜底，保证同一轮内可关联。
// 缺 Spawned 只发 Stopped 会让投影无法建立 subagent row。
function synthesizeSubagentLifecycle(
  info: ParsedSubagentOutput,
  status: "completed" | "failed" | "cancelled",
  push: PushEvent,
  turnId: string,
): void {
  const agentId = info.agentId ?? `subagent-${turnId}`;
  push(
    SessionEventType.SubagentSpawned,
    {
      agentId,
      agentType: info.agentType ?? "subagent",
      childSessionId: info.childSessionId,
      description: info.description ?? info.summaryText ?? info.prompt ?? agentId,
      parentToolCallId: info.parentToolCallId,
      prompt: info.prompt,
      status: "running",
    },
    turnId,
  );
  push(
    SessionEventType.SubagentStopped,
    {
      agentId,
      agentType: info.agentType ?? "subagent",
      childSessionId: info.childSessionId,
      description: info.description,
      parentToolCallId: info.parentToolCallId,
      prompt: info.prompt,
      summaryText: info.summaryText,
      status,
    },
    turnId,
  );
}

/**
 * tool part → ToolCallScheduled / Started / Result 事件。
 *
 * 返回本轮结果贡献：completed/error 记 success；pending/running 记 cancelled
 * （重启后无法证明工具仍在运行，不能让 active work / stop 按钮复活）。
 * 空名/无效工具的恢复 part 在事件源头跳过，与 footprint 过滤口径一致。
 * 副作用：仅 push 事件；subagent 工具附带 spawn/stop lifecycle。
 */
// [契约] tool part 合成 Scheduled (+Started) (+Result)，并返回本轮结果贡献。
// 空名/无效工具在事件源头跳过，与 footprint 过滤口径一致。
// pending/running 不合成 Result，由调用方收口 cancelled。
function synthesizeToolPart(
  part: Extract<MessagePart, { type: "tool" }>,
  assistantMessageId: string,
  push: PushEvent,
  turnId: string,
): AssistantSynthesisState {
  if (shouldHideInvalidToolCallFromProduct(part.tool, part.metadata)) {
    // footprint 过滤只决定是否需要补事件，不能阻止实际合成；这里必须在事件源头
    // 跳过带原始空名 metadata 的恢复 part，避免 cold hydration 重新物化工具行。
    return { resultType: "success", toolCallCount: 0 };
  }
  const toolCallId = part.callID;
  const persistedMetadata = parseCompletedToolPartMetadata(
    "metadata" in part.state ? part.state.metadata : part.metadata,
  );
  push(
    SessionEventType.ToolCallScheduled,
    {
      toolCallId,
      assistantMessageId,
      toolName: part.tool,
      input: part.state.input,
      ...(persistedMetadata?.display ? { display: persistedMetadata.display } : {}),
      schedule: stableToolSchedule(toolCallId),
    },
    turnId,
  );

  const started =
    part.state.status === "running" ||
    part.state.status === "completed" ||
    part.state.status === "error";
  if (started) {
    push(
      SessionEventType.ToolCallStarted,
      {
        toolCallId,
        toolName: part.tool,
        ...(persistedMetadata?.display ? { display: persistedMetadata.display } : {}),
        startedAt: new Date(
          "time" in part.state && typeof part.state.time.start === "number"
            ? part.state.time.start
            : 0,
        ),
      },
      turnId,
    );
  }

  // （2026-09-12）：历史 transcript 里残留的 metadata.widgetState 不再合成事件，
  // 冷恢复直接忽略（widgetState 只留 renderer 内存）。

  const subagentInfo = subagentInfoFromToolPart(part);
  if (subagentInfo && started) {
    synthesizeSubagentLifecycle(subagentInfo, subagentStatusFromToolPart(part), push, turnId);
  }

  // [契约] completed 必须产出成功 Result，duration 取 end-start 并下限 0。
  // output 原样作为 content，不做 JSON 解析。
  // 返回 success 而非 cancelled，避免把已完成工具当成中断。
  if (part.state.status === "completed") {
    push(
      SessionEventType.ToolCallResult,
      {
        toolCallId,
        duration: Math.max(0, part.state.time.end - part.state.time.start),
        result: {
          success: true,
          content: part.state.output,
          ...(persistedMetadata?.display ? { display: persistedMetadata.display } : {}),
        },
      },
      turnId,
    );
    return { resultType: "success", toolCallCount: 1 };
  }

  // [契约] error 产出失败 Result，但本轮结果记 success。
  // 工具失败不等于轮失败，只有 assistant.error 才影响轮结果。
  // error type 固定 fault.runtime.toolFailed，供 UI 归因。
  if (part.state.status === "error") {
    push(
      SessionEventType.ToolCallResult,
      {
        toolCallId,
        duration: Math.max(0, part.state.time.end - part.state.time.start),
        result: {
          success: false,
          content: part.state.error,
          error: {
            type: "fault.runtime.toolFailed",
            message: part.state.error,
          },
        },
      },
      turnId,
    );
    return { resultType: "success", toolCallCount: 1 };
  }

  // CLI 重启后无法证明历史 pending/running 工具仍在运行，不能把
  // active work / stop 按钮复活；让 TurnComplete(cancelled) 统一收口成只读历史。
  return { resultType: "cancelled", toolCallCount: 1 };
}

/**
 * timeline / compaction part → 单个 compact 事件（Started/Completed/Failed）。
 * 同 operationId 只发一次；durable compaction part 若带 coverage boundary，
 * 覆盖 timeline part 的同名事实，避免丢 tail_start_id / summaryMessageId。
 * 返回是否命中 compact 事实；副作用仅 push。
 */
// [契约] timeline 与 legacy compaction 两条来源归一为单个 compact 事件。
// durable part 优先，避免丢 tailStartMessageId 等覆盖边界字段。
// 同 operationId 只发一次，返回是否命中 compact 事实。
function synthesizeCompactPart(
  part: MessagePart,
  emittedCompactOperations: Set<string>,
  durableCompactPartsByOperation: ReadonlyMap<string, Extract<MessagePart, { type: "compaction" }>>,
  push: PushEvent,
  turnId: string,
): boolean {
  let compact =
    part.type === "timeline"
      ? compactPayloadFromTimelinePart(part)
      : part.type === "compaction"
        ? compactPayloadFromLegacyCompactionPart(part)
        : null;
  if (!compact) return false;
  const operationId = String(compact.payload.operationId);
  const durablePart = durableCompactPartsByOperation.get(operationId);
  // [事务] durable compaction part 覆盖 timeline part 的同名事实。
  // durable 解析失败时只补 tail/boundary/summary 三个字段，其余沿用。
  // 不要反过来让 timeline 覆盖 durable，会丢覆盖边界。
  if (durablePart) {
    // 同 operation 的 timeline part 通常排在 durable compaction part 前面。
    // 旧“先到先得”会丢 tail_start_id；优先采用带 coverage boundary 的 durable payload。
    const durablePayload = compactPayloadFromLegacyCompactionPart(durablePart);
    compact = durablePayload ?? {
      ...compact,
      payload: {
        ...compact.payload,
        ...(durablePart.tail_start_id ? { tailStartMessageId: durablePart.tail_start_id } : {}),
        ...(durablePart.boundaryId ? { boundaryId: durablePart.boundaryId } : {}),
        ...(durablePart.summaryMessageId ? { summaryMessageId: durablePart.summaryMessageId } : {}),
      },
    };
  }
  if (emittedCompactOperations.has(operationId)) return true;
  emittedCompactOperations.add(operationId);
  push(compactEventType(compact.status), compact.payload, turnId);
  return true;
}

// ── goal verification timeline part──
// 持久化契约（core events.ts persistDurableSessionEvent）：verifier 每次生命周期变化
// upsert 同一个 timeline part，身份 targetId_goalIteration，status 为最终生命周期态。
// 反向合成为 started(+终态) 事件对，复用投影既有 goalVerify marker 状态机。
// 旧 hydration 只认 context_compaction，goal_verification part 落入无人
// 消费的分支——每次冷恢复 goalVerify marker 都消失。
// [契约] goal verify 的身份键：goalIteration 存在时 targetId_iteration，否则 verificationId。
// 该键必须与 entry 侧完全一致，否则跨源去重失效。
// 非 goal_verification part 用 part.id 兜底，避免键碰撞。
function goalVerificationKeyOfPart(part: Extract<MessagePart, { type: "timeline" }>): string {
  if (part.timelineType !== "goal_verification") return String(part.id);
  return part.goalIteration !== undefined
    ? `${part.targetId}_${part.goalIteration}`
    : part.verificationId;
}

// 冷恢复无法证明历史 verifier 仍在运行（同 pending tool 收口为 cancelled 的先例）：
// started/未知态收口为 cancelled；completed/failed_closed 原样还原。
// [契约] completed 原样；failed/failed_closed 归一 failed_closed；其余 cancelled。
// 历史 started/未知态一律 cancelled，与 pending 工具同策略。
// 不要保留 started，冷恢复后会出现永不结束的验证中状态。
function goalVerificationTerminalStatus(
  status: string | undefined,
): "completed" | "failed_closed" | "cancelled" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "failed_closed":
      return "failed_closed";
    default:
      return "cancelled";
  }
}

/** goal verify 事实的归一形态：timeline part（新契约）与 session_entry（legacy 主体）共用。 */
interface GoalVerificationFact {
  key: string;
  targetId: string;
  verificationId: string;
  goalIteration?: number;
  anchorAssistantMessageId?: string;
  anchorTurnId?: string;
  status?: string;
  verification?: unknown;
}

// [契约] 一个 fact 固定发 started + 终态两事件，并登记去重键。
// key 已发射则直接返回 false，不做任何 push。
// verification 只在终态携带，避免 started 阶段渲染结论。
function pushGoalVerificationFact(
  fact: GoalVerificationFact,
  emittedGoalVerifications: Set<string>,
  push: PushEvent,
  turnId: string | undefined,
): boolean {
  if (emittedGoalVerifications.has(fact.key)) return false;
  emittedGoalVerifications.add(fact.key);
  const base = {
    targetId: fact.targetId,
    verificationId: fact.verificationId,
    ...(fact.goalIteration !== undefined ? { goalIteration: fact.goalIteration } : {}),
    ...(fact.anchorAssistantMessageId
      ? { anchorAssistantMessageId: fact.anchorAssistantMessageId }
      : {}),
    ...(fact.anchorTurnId ? { anchorTurnId: fact.anchorTurnId } : {}),
  };
  push(SessionEventType.TargetCompletionVerification, { ...base, status: "started" }, turnId);
  push(
    SessionEventType.TargetCompletionVerification,
    {
      ...base,
      status: goalVerificationTerminalStatus(fact.status),
      ...(fact.verification ? { verification: fact.verification } : {}),
    },
    turnId,
  );
  return true;
}

// [失败路径] 非 goal_verification timeline 返回 null。
// anchorMessageId/anchorTurnId 强转字符串，保持与 entry 同型。
// 缺 status 时不补默认值，由终态归一函数兜底。
function goalVerificationFactOfPart(
  part: Extract<MessagePart, { type: "timeline" }>,
): GoalVerificationFact | null {
  if (part.timelineType !== "goal_verification") return null;
  return {
    key: goalVerificationKeyOfPart(part),
    targetId: part.targetId,
    verificationId: part.verificationId,
    ...(part.goalIteration !== undefined ? { goalIteration: part.goalIteration } : {}),
    ...(part.anchorMessageId ? { anchorAssistantMessageId: String(part.anchorMessageId) } : {}),
    ...(part.anchorTurnId ? { anchorTurnId: String(part.anchorTurnId) } : {}),
    ...(part.status ? { status: part.status } : {}),
    ...(part.verification ? { verification: part.verification } : {}),
  };
}

function synthesizeGoalVerificationPart(
  part: MessagePart,
  emittedGoalVerifications: Set<string>,
  push: PushEvent,
  turnId: string,
): boolean {
  if (part.type !== "timeline") return false;
  const fact = goalVerificationFactOfPart(part);
  if (!fact) return false;
  pushGoalVerificationFact(fact, emittedGoalVerifications, push, turnId);
  return true;
}

// ── session_entry legacy 源──
// 历史上 goal verify 主要持久化在 session_entry（本机观测 1,402 行 vs timeline part
// 仅 10 行）；entry.data 保留了原始事件 payload。读取端跨源按 targetId_goalIteration
// 去重：timeline part 与 entry 表达同一事实时只发一次（先到先得，anchor 语义一致）。
export interface HydratedGoalVerificationEntry {
  payload: {
    targetId: string;
    status?: string;
    verificationId: string;
    verification?: unknown;
    goalIteration?: number;
    anchorAssistantMessageId?: string;
    anchorTurnId?: string;
  };
  sequenceNumber?: number;
  timeCreated: number;
}

/**
 * session_entry（legacy goal verify 权威）→ 归一 entry。
 *
 * 只接受 data.payload 中 targetId + verificationId 同时存在的记录，其余静默剔除；
 * 输出按 sequenceNumber（缺失回退 timeCreated）升序，供同 key 合并时终态覆盖 started。
 * 副作用：无；不读库、不写库。
 */
/** SessionEntryInfo（target_completion_verification）→ 归一 entry；非法数据静默剔除。 */
// [失败路径] 只接受 data.payload 中 targetId 与 verificationId 同时存在的记录。
// 其余记录（含 payload 解析失败）一律静默剔除，绝不抛错。
// 输出按 sequenceNumber（缺失回退 timeCreated）升序，供终态覆盖。
export function goalVerificationEntriesFromSessionEntries(
  entries: readonly { data: unknown; time: { created: number } }[],
): HydratedGoalVerificationEntry[] {
  const parsed: HydratedGoalVerificationEntry[] = [];
  for (const entry of entries) {
    const data =
      entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
        ? (entry.data as Record<string, unknown>)
        : null;
    const payload =
      data?.payload && typeof data.payload === "object" && !Array.isArray(data.payload)
        ? (data.payload as Record<string, unknown>)
        : null;
    if (!payload) continue;
    const targetId = typeof payload.targetId === "string" ? payload.targetId : null;
    const verificationId =
      typeof payload.verificationId === "string" ? payload.verificationId : null;
    if (!targetId || !verificationId) continue;
    parsed.push({
      payload: {
        targetId,
        verificationId,
        ...(typeof payload.status === "string" ? { status: payload.status } : {}),
        ...(typeof payload.goalIteration === "number"
          ? { goalIteration: payload.goalIteration }
          : {}),
        ...(typeof payload.anchorAssistantMessageId === "string"
          ? { anchorAssistantMessageId: payload.anchorAssistantMessageId }
          : {}),
        ...(typeof payload.anchorTurnId === "string" ? { anchorTurnId: payload.anchorTurnId } : {}),
        ...(payload.verification !== undefined ? { verification: payload.verification } : {}),
      },
      ...(typeof data?.sequenceNumber === "number" ? { sequenceNumber: data.sequenceNumber } : {}),
      timeCreated: entry.time.created,
    });
  }
  // 同一 key 多条（started/terminal 各一条 entry）：按事件序取最新终态。
  parsed.sort(
    (left, right) =>
      (left.sequenceNumber ?? left.timeCreated) - (right.sequenceNumber ?? right.timeCreated),
  );
  return parsed;
}

function goalVerificationFactOfEntry(entry: HydratedGoalVerificationEntry): GoalVerificationFact {
  const payload = entry.payload;
  return {
    key:
      payload.goalIteration !== undefined
        ? `${payload.targetId}_${payload.goalIteration}`
        : payload.verificationId,
    targetId: payload.targetId,
    verificationId: payload.verificationId,
    ...(payload.goalIteration !== undefined ? { goalIteration: payload.goalIteration } : {}),
    ...(payload.anchorAssistantMessageId
      ? { anchorAssistantMessageId: payload.anchorAssistantMessageId }
      : {}),
    ...(payload.anchorTurnId ? { anchorTurnId: payload.anchorTurnId } : {}),
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.verification !== undefined ? { verification: payload.verification } : {}),
  };
}

/**
 * 同一 key 的多条 entry（生命周期各一条）→ 单个 fact，供合成事件对使用。
 * 后到（终态）覆盖先前状态；anchor 取先有值，verification 取最新非空。
 */
/** 同一 key 的多条 entry（生命周期各一条）合并为单个 fact：终态覆盖 started。 */
// [契约] 同 key 多条 entry 合并为单 fact：后到覆盖，anchor 取先有值。
// verification 取最新非空，避免后续空值抹掉已有结论。
// 依赖输入已按事件序排序。
function mergeGoalVerificationEntryFacts(
  entries: readonly HydratedGoalVerificationEntry[],
): GoalVerificationFact[] {
  const byKey = new Map<string, GoalVerificationFact>();
  for (const entry of entries) {
    const fact = goalVerificationFactOfEntry(entry);
    const existing = byKey.get(fact.key);
    if (!existing) {
      byKey.set(fact.key, fact);
      continue;
    }
    // entries 已按事件序排序：后到的生命周期态（终态）覆盖，anchor 取先有值。
    byKey.set(fact.key, {
      ...existing,
      ...fact,
      anchorAssistantMessageId: existing.anchorAssistantMessageId ?? fact.anchorAssistantMessageId,
      anchorTurnId: existing.anchorTurnId ?? fact.anchorTurnId,
      verification: fact.verification ?? existing.verification,
    });
  }
  return [...byKey.values()];
}

// ── 轮次选型事实──
// modelChange marker 由投影在 TurnStarted 时对比 lastTurnModel 与 config 生成；
// 冷恢复没有 ModelSelected 事件，这里按每轮的持久化选型事实重建。
// 来源优先级：user prompt 的 model 快照（恒在场、与提交时 config 一致）；
// preface 轮（无 user）取 assistant 消息事实。合成 timeline 宿主消息
// （semantics.kind=timeline_event）的 model 是宿主兼容占位，不是本轮事实。
interface HydratedTimelineModel {
  modelSelection: ModelSelection;
  previousModelSelection?: ModelSelection | null;
}

// [契约] 选型身份 = providerId + modelId + reasoningLevel，用 NUL 分隔。
// NUL 分隔避免 id 中出现分隔符导致键碰撞。
// options 的其他字段不参与身份，改 key 会造成重复 ModelSelected。
function hydratedModelKey(modelSelection: ModelSelection): string {
  return `${modelSelection.providerId}\u0000${modelSelection.modelId}\u0000${modelSelection.options?.reasoningLevel ?? ""}`;
}

// [权衡] 加速卡 provider 的选型是单轮执行作用域，不构成会话选型。
// 对它返回 null，live 路径本就不发 ModelSelected，冷路径需同语义。
// 放宽这个判断会让重启后出现虚假的模型切换提示。
function sessionModelSelectionOfHydratedMessage(
  modelSelection: ModelSelection,
): ModelSelection | null {
  // Bug 原因：加速卡是单轮执行 Selection（selectionScope=execution），消息保留它用于记录
  // 真实执行模型；但冷恢复曾把该字段误当成会话选型，重启后因此生成「加速 → 原模型」的
  // 虚假切换提示。live 路径的 execution 作用域本就不发 ModelSelected，cold 必须同语义。
  return isHighspeedProviderId(modelSelection.providerId) ? null : modelSelection;
}

// [契约] 每轮选型的首选来源：user 消息上的提交时快照。
// 非 user 或缺 modelSelection 返回 null，由 assistant 事实接手。
// 该快照恒在场且与提交时 config 一致，优先于 assistant 消息事实。
function turnModelSelectionOfUserMessage(message: MessageWithParts): ModelSelection | null {
  if (message.info.role !== "user") return null;
  const modelSelection = message.info.modelSelection;
  return modelSelection ? sessionModelSelectionOfHydratedMessage(modelSelection) : null;
}

// [契约] preface 轮（无 user）的选型来源：assistant 消息的 provider/model 字段。
// 合成 timeline 宿主消息被显式排除，其 model 只是占位。
// 缺 providerId/modelId 返回 null，不猜默认模型。
function assistantModelSelectionOf(message: MessageWithParts): ModelSelection | null {
  if (message.info.role !== "assistant") return null;
  if (message.info.semantics?.kind === "timeline_event") return null;
  if (!message.info.providerId || !message.info.modelId) return null;
  return sessionModelSelectionOfHydratedMessage({
    providerId: String(message.info.providerId),
    modelId: String(message.info.modelId),
    ...(message.info.reasoningLevel
      ? { options: { reasoningLevel: message.info.reasoningLevel } }
      : {}),
  });
}

/**
 * 从 assistant 宿主消息的 model_change timeline part 还原该边界。
 * 取最后一个 part；缺 toModel 返回 null（无法证明切换，不猜测）。
 * 输出同时带 from/to，供投影生成 modelChange marker；无副作用。
 */
// [契约] 从消息的 model_change part 取最后一个边界，携带 from/to。
// 缺 toModel 返回 null：无法证明切换时不猜测。
// 倒序遍历保证同消息多次切换以最后一次为准。
function modelChangeToModelOf(message: MessageWithParts): HydratedTimelineModel | null {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index]!;
    if (part.type !== "timeline" || part.timelineType !== "model_change") continue;
    if (!part.toModel) return null;
    return {
      modelSelection: {
        providerId: part.toModel.providerId,
        modelId: part.toModel.modelId,
        ...(part.toModel.options ? { options: part.toModel.options } : {}),
      },
      previousModelSelection: part.fromModel
        ? {
            providerId: part.fromModel.providerId,
            modelId: part.fromModel.modelId,
            ...(part.fromModel.options ? { options: part.fromModel.options } : {}),
          }
        : null,
    };
  }
  return null;
}

function modelChangeKeyOfPart(
  part: Extract<MessagePart, { type: "timeline" }> & { timelineType: "model_change" },
): string {
  const from = part.fromModel
    ? `${part.fromModel.providerId}/${part.fromModel.modelId}/${part.fromModel.options?.reasoningLevel ?? ""}`
    : "<unknown>";
  const to = part.toModel
    ? `${part.toModel.providerId}/${part.toModel.modelId}/${part.toModel.options?.reasoningLevel ?? ""}`
    : "<unknown>";
  return `${String(part.anchorMessageId ?? part.messageID)}\u0000${from}\u0000${to}`;
}

// preface 轮开轮门槛：只含 model_change/session_fork 宿主等不可渲染内容的 assistant
// 消息不开轮，避免合成出只有「已工作」壳的空轮。
// [契约] preface 轮开轮门槛：只含不可渲染宿主内容时不开轮。
// text/reasoning/tool/subtask/compaction/goal-verify 任一存在即开轮。
// 放宽会让“只有已工作壳”的空轮出现在历史里。
function assistantMessageHasSynthesizableContent(message: MessageWithParts): boolean {
  return message.parts.some((part) => {
    switch (part.type) {
      case "text":
        return part.ignored !== true && part.text.length > 0;
      case "reasoning":
        return part.text.length > 0;
      case "tool":
        return !shouldHideInvalidToolCallFromProduct(part.tool, part.metadata);
      case "subtask":
      case "compaction":
        return true;
      case "timeline":
        return (
          part.timelineType === "context_compaction" || part.timelineType === "goal_verification"
        );
      default:
        return false;
    }
  });
}

/** 旧 subtask part 没有工具生命周期，按已完成 subagent 直接还原。 */
// [契约] 旧 subtask 缺工具生命周期，冷恢复不得据此推断失败，统一按 completed 还原。
// agentId 用 part.id，保证同 part 多次恢复稳定。
// 不要把它合成 failed/cancelled，历史 subtask 无失败事实。
function synthesizeSubtaskPart(
  part: Extract<MessagePart, { type: "subtask" }>,
  push: PushEvent,
  turnId: string,
): void {
  synthesizeSubagentLifecycle(
    {
      agentId: String(part.id),
      agentType: part.agent,
      description: part.description,
      prompt: part.prompt,
      summaryText: part.description,
    },
    "completed",
    push,
    turnId,
  );
}

/**
 * 单条 assistant message 的全部 part → 事件，并汇总本轮结果。
 *
 * 结果判定优先级：持久 error（区分 cancelled / stream-recovery-discard / 真错误）>
 *   无 completed 时间（进程退出只落半截输出，按 cancelled）> success。
 * 副作用：push 全部 part 事件；assistantFeedback 作为独立事实重建。
 */
// [事务] assistant 单消息合成：先定轮结果，再逐 part 合成，最后补 assistantFeedback。
// 结果优先级：持久 error > 缺 completed 时间 > success。
// tool 的 resultType 通过 normalizeTurnResult 单调合并。
function synthesizeAssistantParts(
  message: MessageWithParts,
  emittedCompactOperations: Set<string>,
  durableCompactPartsByOperation: ReadonlyMap<string, Extract<MessagePart, { type: "compaction" }>>,
  emittedGoalVerifications: Set<string>,
  push: PushEvent,
  turnId: string,
): AssistantSynthesisState {
  let resultType: TurnResultForHydration =
    message.info.role === "assistant" && message.info.error
      ? isPersistedAssistantCancellation(message.info.error)
        ? "cancelled"
        : isPersistedStreamRecoveryDiscard(message.info.error)
          ? "success"
          : "error_during_execution"
      : message.info.role === "assistant" && message.info.time.completed === undefined
        ? // Bug 根因：进程退出可能只持久化 step-start/partial，却没有 assistant error；
          // 旧 cold hydration 默认 success，伪造正常 TurnComplete 并让异常 Worked 被收起。
          "cancelled"
        : "success";
  let toolCallCount = 0;
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        synthesizeTextPart(
          part,
          String(message.info.id),
          messageCreatedAtMs(message),
          push,
          turnId,
        );
        break;
      case "reasoning":
        // cold hydration 过去没有把 transcript assistant message 身份带到
        // reasoning_start，导致恢复后的 ReasoningRow 无法复用 live projection 的 response 边界。
        synthesizeReasoningPart(part, String(message.info.id), push, turnId);
        break;
      case "tool": {
        const state = synthesizeToolPart(part, String(message.info.id), push, turnId);
        toolCallCount += state.toolCallCount;
        resultType = normalizeTurnResult(resultType, state.resultType);
        break;
      }
      case "timeline":
        if (synthesizeGoalVerificationPart(part, emittedGoalVerifications, push, turnId)) {
          break;
        }
        synthesizeCompactPart(
          part,
          emittedCompactOperations,
          durableCompactPartsByOperation,
          push,
          turnId,
        );
        break;
      case "compaction":
        synthesizeCompactPart(
          part,
          emittedCompactOperations,
          durableCompactPartsByOperation,
          push,
          turnId,
        );
        break;
      case "subtask":
        synthesizeSubtaskPart(part, push, turnId);
        break;
      default:
        break;
    }
  }
  const assistantFeedback = message.info.metadata?.assistantFeedback;
  if (assistantFeedback === "like" || assistantFeedback === "dislike") {
    push(
      SessionEventType.AssistantFeedbackUpdated,
      { entityId: String(message.info.id), feedback: assistantFeedback },
      turnId,
    );
  }
  return { resultType, toolCallCount };
}

// ── model-only 唤醒轮──
// live 路径的 background wake / goal continuation 以 TurnStarted(inputVisibility=
// model-only) 开独立轮；冷路径不能把这类 synthetic user 跳过、让其后的 assistant 并进
// 上一轮——live/cold 必须结构一致。触发 source 由 shared projection policy
// 唯一维护；compact summary / rewind notice 等非触发型 synthetic context 照旧不开轮。

// ── guide steer 内联──
// drain 持久化的 user message 带 metadata.turnSteerDelivery：guide=内联当前轮
// （不是轮边界），queue=独立轮（真实 starter，与 live 切分一致）。legacy 无标记按 queue。
// [契约] 只从 user 消息 metadata.turnSteerDelivery 读取，取值为 guide/queue。
// legacy 无标记返回 null，调用方按 queue 处理（独立轮）。
// 不要改成正则匹配消息正文。
function steerDeliveryOfMessage(message: MessageWithParts): "guide" | "queue" | null {
  if (message.info.role !== "user") return null;
  const metadata = (message.info as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const delivery = (metadata as Record<string, unknown>).turnSteerDelivery;
  return delivery === "guide" || delivery === "queue" ? delivery : null;
}

/**
 * 轮边界判定：真实 user starter（guide steer 除外——内联当前轮）或 model-only
 * 唤醒触发（background wake / goal continuation 各开一轮）。
 * 注：live 的「合流」场景（active loop 未结束时通知并入当前轮）冷路径无法从持久
 * 事实区分，统一按边界处理——内容不丢、无气泡，仅轮归属与 live 合流场景有已知差异。
 */
// [契约] 轮边界 = 真实 user（guide 除外）或 model-only 唤醒或 workflow 启动。
// guide steer 返回 false，从而内联进当前轮。
// live 的“合流”场景冷路径无法区分，统一按边界处理（已知差异）。
function isTurnBoundaryStarter(message: MessageWithParts): boolean {
  if (isRealUserTurnStarter(message)) {
    return steerDeliveryOfMessage(message) !== "guide";
  }
  // 启动轮是可见 controlOnly 用户轮，必须作为边界让前一轮输出收集在此停下（一会话一 run 下
  // 它本就是首条消息，但语义上仍是独立轮边界，不能被并进上一轮）。
  if (workflowLaunchOfMessage(message)) return true;
  return getConversationModelOnlyTurnTriggerSource(message) !== null;
}

/**
 * background 结果轮的 originMeta：只认 bash/subagent/workflow 三类 + workId + title；
 * workflowNotification / workflowBlocked 载荷用 shared schema 校验，畸形只丢载荷。
 * 副作用：无；绝不抛（投影重建路径不能被单个坏载荷打断）。
 */
// [失败路径] 只认 bash/subagent/workflow 三类，且 workId 与 title 均非空。
// workflowNotification/workflowBlocked 载荷畸形时只丢载荷，保基字段。
// 绝不能抛：这是投影重建路径，坏载荷不能打断整条冷恢复。
function backgroundResultOriginMetaOfMessage(
  message: MessageWithParts,
): BackgroundResultOriginMeta | undefined {
  const messageMetadata = message.info.metadata;
  const partMetadata = message.parts.find((part) => part.type === "text")?.metadata;
  const candidate = messageMetadata?.originMeta ?? partMetadata?.originMeta;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const record = candidate as Record<string, unknown>;
  const backgroundSource = record.backgroundSource;
  const workId = typeof record.workId === "string" ? record.workId.trim() : "";
  const title = typeof record.title === "string" ? record.title.trim() : "";
  // 三个取值与 BackgroundResultOriginMeta 保持同步（contracts/src/events/session.events.ts）。
  // "workflow" 是 workflow run（workId ≡ runId）：漏掉它，workflow 的后台结果轮在冷恢复后会
  // 静默退化成一条无标题 model-only 消息，工具卡→详情页的关联键随之丢失。
  if (
    (backgroundSource !== "bash" &&
      backgroundSource !== "subagent" &&
      backgroundSource !== "workflow") ||
    !workId ||
    !title
  ) {
    return undefined;
  }
  // manifest 载荷（workflowNotification）也要过冷恢复：这里若只回读三基字段，冷恢复后
  // 载荷就丢了——manifest 条目退回裸标题行。用 shared 的 zod schema 校验，畸形就**只丢载荷**
  // 保基字段，绝不抛：这是投影重建路径，一个坏载荷不该打挂整条冷恢复。
  const workflowNotification = parseWorkflowNotificationMeta(record.workflowNotification);
  // 空闲提醒的载荷在它自己的键上（contracts 的 WorkflowBlockedMeta），同样畸形只丢载荷。
  const workflowBlocked = workflowBlockedMetaSchema.safeParse(record.workflowBlocked);
  return {
    backgroundSource,
    title,
    workId,
    ...(workflowNotification ? { workflowNotification } : {}),
    ...(workflowBlocked.success ? { workflowBlocked: workflowBlocked.data } : {}),
  };
}

/** 防御性解析 manifest 载荷：畸形 / 缺席都回 undefined（调用方据此让字段缺席），绝不抛。 */
function parseWorkflowNotificationMeta(
  value: unknown,
): BackgroundResultOriginMeta["workflowNotification"] {
  if (value === undefined || value === null) return undefined;
  const parsed = workflowNotificationMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * 旧 `/compact` 用户宿主：仅当缺 canonical visibility/semantics，
 * 且下一条 assistant 带 compaction 事实时才视为维护命令并跳过宿主。
 * 显式可见的 `/compact` 必须原样下发，不能被按文本吞掉。
 */
// [权衡] 只修缺 canonical visibility/semantics 的旧数据。
// 显式 user-visible 的 /compact 必须原样下发，不能按文本吞掉。
// 还要求下一条 assistant 确实带 compaction 事实，否则不跳过。
function isLegacyCompactMaintenanceInput(
  message: MessageWithParts,
  nextMessage: MessageWithParts | undefined,
): boolean {
  if (message.info.role !== "user") return false;
  // 只修复缺 canonical policy 的旧数据；显式 user-visible `/compact` 必须原样下发，
  // UI 不得再靠文本覆盖 CLI visibility authority。
  if (message.info.visibility !== undefined || message.info.semantics !== undefined) return false;
  const text = textOfMessage(message.parts).trim();
  if (text !== "/compact" && !text.startsWith("/compact ")) return false;
  if (!nextMessage || nextMessage.info.role !== "assistant") return false;
  return nextMessage.parts.some(
    (part) =>
      part.type === "compaction" ||
      (part.type === "timeline" && part.timelineType === "context_compaction"),
  );
}

interface TurnOutputCollection {
  failure?: {
    type: string;
    message: string;
    attribution?: ErrorAttribution;
    retryable?: boolean;
    data?: unknown;
  };
  nextIndex: number;
  resultType: TurnResultForHydration;
  toolCallCount: number;
  historyRoundCount: number;
  turnEndedAtMs: number;
}

/**
 * 收集一轮内从 startIndex 到下一个轮边界前的所有 assistant 输出。
 *
 * 跳过 providerContextOnly / forkTimeline 消息；guide steer 内联成 TurnSteerDrained；
 * 首次真错误固化为 failure（供 finishTurn 发 TurnError）；
 * stream-recovery-discard 若为最后一条 assistant，则本轮按 cancelled 收口。
 * 返回值提供 nextIndex、toolCallCount、historyRoundCount 与结束时间。
 */
/** 收集一轮的 assistant 输出（直到下一个轮边界）；普通轮与 preface 轮共用。 */
// [事务] 收集一轮内到下一个边界前的全部输出，返回 nextIndex 与汇总结果。
// providerContextOnly/fork 消息跳过，guide 内联为 TurnSteerDrained。
// 首个真错误固化 failure，后续成功不覆盖。
function collectTurnOutput(options: {
  messages: readonly MessageWithParts[];
  startIndex: number;
  turnId: string;
  turnStartedAtMs: number;
  emittedCompactOperations: Set<string>;
  durableCompactPartsByOperation: ReadonlyMap<string, Extract<MessagePart, { type: "compaction" }>>;
  emittedGoalVerifications: Set<string>;
  goalVerificationsByAnchor: ReadonlyMap<string, GoalVerificationFact[]>;
  onModelChange: (selection: HydratedTimelineModel) => void;
  push: PushEvent;
}): TurnOutputCollection {
  const { messages, turnId, push } = options;
  let index = options.startIndex;
  let resultType: TurnResultForHydration = "success";
  let failure: TurnOutputCollection["failure"];
  // 被 stream recovery 作废的 tail 若是本轮最后一条 assistant，说明恢复请求没有落盘
  //（进程在重发前退出），本轮按 interrupted 收口；后续 assistant 出现则由它决定结果。
  let awaitingStreamRecovery = false;
  let toolCallCount = 0;
  let historyRoundCount = 0;
  let turnEndedAtMs = options.turnStartedAtMs;
  while (index < messages.length && !isTurnBoundaryStarter(messages[index]!)) {
    const message = messages[index]!;
    if (isProviderContextOnlyAssistant(message)) {
      // selection side chat 会把继承的 assistant 历史标成 model-only，
      // 旧 cold hydration 却只隐藏 user carrier，随后把 assistant 当作 preface/上一轮输出合成，
      // 导致副屏首次打开和冷恢复都泄漏父时间线。统一服从 projection policy，整条跳过。
      index += 1;
      continue;
    }
    if (isForkTimelineMessage(message)) {
      const forkContext = forkContextOfMessage(message);
      if (forkContext) {
        push(
          SessionEventType.SessionForked,
          {
            forkPoint: 0,
            originalSessionId: forkContext.parentSessionId,
            restoredFileCount: forkContext.restoredFileCount,
            targetCheckpointId: forkContext.targetCheckpointId,
            targetMessageId: forkContext.targetMessageId,
          },
          turnId,
        );
      }
      index += 1;
      continue;
    }
    // guide steer：内联进当前轮——合成 TurnSteerDrained（带 drainedInputs），
    // 投影按 delivery=guide 走内联 userInput 行，与 live 同一归约入口。
    if (message.info.role === "user" && steerDeliveryOfMessage(message) === "guide") {
      const intent = inputIntentOfMessage(message);
      // cold guide 过去只凭 messageId 临时拼 pendingInputId，且没有把
      // transcript 中已持久化的 ConversationInputIntent 带回事件；恢复后 row 会丢
      // sourceCommandId/clientId/attachments，命令去重与展示也不再和 live 等价。
      // 新数据优先复用原 queueItemId，legacy 才使用可诊断的 hydration fallback。
      const pendingInputId = intent?.queueItemId ?? `hydrate-steer-${String(message.info.id)}`;
      push(
        SessionEventType.TurnSteerDrained,
        {
          pendingInputIds: [pendingInputId],
          injectedMessageIds: [String(message.info.id)],
          drainedInputs: [
            {
              pendingInputId,
              messageId: String(message.info.id),
              text: textOfMessage(message.parts),
              delivery: "guide",
              ...(intent ? { intent } : {}),
            },
          ],
          targetTurnId: turnId,
        },
        turnId,
        messageCreatedAtMs(message),
      );
      index += 1;
      continue;
    }
    if (message.info.role !== "assistant") {
      index += 1;
      continue;
    }
    awaitingStreamRecovery =
      message.info.error !== undefined && isPersistedStreamRecoveryDiscard(message.info.error);
    if (
      message.info.error &&
      !isPersistedAssistantCancellation(message.info.error) &&
      !awaitingStreamRecovery
    ) {
      const data = assistantErrorData(message.info.error);
      const attribution = persistedErrorAttribution(data);
      failure = {
        type: message.info.error.name,
        message: (typeof data?.message === "string" && data.message) || message.info.error.name,
        // 旧 cold hydration 只把归因留在 data 内，TurnError 投影无法读取，重启后退化成 runtime。
        ...(attribution ? { attribution } : {}),
        ...(typeof data?.retryable === "boolean" ? { retryable: data.retryable } : {}),
        ...(message.info.error.data !== undefined ? { data: message.info.error.data } : {}),
      };
    }
    const timelineModel = modelChangeToModelOf(message);
    if (timelineModel) {
      options.onModelChange(timelineModel);
      index += 1;
      continue;
    }
    // Host 不能从 toolCallCount 或裁剪后的 history 长度反推模型轮次。
    // 新 transcript 在最终 assistant anchor 固化精确值；旧 transcript 才按独立
    // assistant history 条目做兼容计数。
    historyRoundCount = message.info.anchor?.historyRoundCount ?? historyRoundCount + 1;
    const messageEnd = messageEndAtMs(message);
    if (messageEnd !== undefined) {
      turnEndedAtMs = Math.max(turnEndedAtMs, messageEnd);
    }
    const synthesized = synthesizeAssistantParts(
      message,
      options.emittedCompactOperations,
      options.durableCompactPartsByOperation,
      options.emittedGoalVerifications,
      push,
      turnId,
    );
    resultType = normalizeTurnResult(resultType, synthesized.resultType);
    toolCallCount += synthesized.toolCallCount;
    if (
      message.info.role === "assistant" &&
      message.info.finish?.trim().toLowerCase() === "length" &&
      synthesized.toolCallCount === 0
    ) {
      // live ProductProjection 能从逐请求 ModelComplete 识别 output-token
      // Continue，但 cold transcript 过去只在整轮末尾合成一次 end_turn，导致刷新后
      // 同一句又退化成多条 assistant row。持久化 finish 是请求终止事实；用零 usage
      // 的 hydration-only ModelComplete 恢复资格，不重复累计 token 或注入 Continue user。
      push(
        SessionEventType.ModelComplete,
        {
          content: "",
          stopReason: "length",
          querySource: "main_turn",
          toolCallCount: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
        turnId,
        messageEnd,
      );
    }
    // session_entry 源的 goal verify：锚定本条 assistant 的事实紧随其后落位
    //（与 timeline part 同 key 去重，先到先得）。
    const anchored = options.goalVerificationsByAnchor.get(String(message.info.id));
    if (anchored) {
      for (const fact of anchored) {
        pushGoalVerificationFact(fact, options.emittedGoalVerifications, push, turnId);
      }
    }
    index += 1;
  }
  if (awaitingStreamRecovery) {
    resultType = normalizeTurnResult(resultType, "cancelled");
  }
  return {
    ...(failure ? { failure } : {}),
    nextIndex: index,
    resultType,
    toolCallCount,
    historyRoundCount,
    turnEndedAtMs,
  };
}

/**
 * transcript MessageWithParts[] → 与 live 归约等价的 SessionEvent[]。
 *
 * 轮分组：真实 user starter（guide steer 除外）开一轮；model-only 唤醒、
 * workflowLaunch、preface assistant 各开独立轮；其余非触发消息跳过。
 * 顺序：turn 内先 TurnStarted，再 part 事件，最后 ModelComplete + TurnComplete
 *（有 failure 则只发 TurnError）。事件 id 为 hydrate-N，seq 由 push 单调递增。
 * 副作用：无持久写入；contextWindow / fileChangeSummaries / goal entries 由调用方注入。
 */
/**
 * 把 transcript（按时间/parentID 顺序的 MessageWithParts）合成为归约等价的 SessionEvent 序列。
 * 轮次分组：user message 开一轮，紧随其后的 assistant message（同轮输出）直到下一个 user message。
 */
// [事务] 主循环按优先级分派：跳过项 → fork → model_change → workflow → model-only → preface → 真实 user。
// 每个开轮分支都以 collectTurnOutput + finishTurn 配对收口。
// 分支顺序即是语义优先级，调整会让同一消息被错误归类。
export function synthesizeEventsFromMessages(
  messages: readonly MessageWithParts[],
  options: SynthesizeOptions,
): SessionEvent[] {
  const sessionId = options.sessionId as SessionId;
  const traceId = HYDRATION_TRACE_ID as TraceId;
  let seq = 0;
  const baseMs = options.baseTimestampMs ?? messages[0]?.info.time.created ?? 0;
  const events: SessionEvent[] = [];

  // [契约] 事件构造：id=hydrate-seq，timestamp 仅作展示，seq 决定全序。
  // traceId 固定 HYDRATION_TRACE_ID，便于日志区分冷恢复。
  // 不要在这里读系统时钟，timestamp 取 sourceTimestampMs 或 baseMs+seq。
  const push = (
    type: SessionEventType,
    payload: unknown,
    turnId?: string,
    sourceTimestampMs?: number,
  ): void => {
    seq += 1;
    events.push({
      id: `hydrate-${seq}` as EventId,
      sessionId,
      turnId: turnId as TurnId | undefined,
      type,
      // source timestamp 仅恢复 row.createdAt 等展示事实；事件全序始终由 sequenceNumber 裁决。
      timestamp: new Date(sourceTimestampMs ?? baseMs + seq),
      traceId,
      sequenceNumber: seq,
      payload,
    });
  };

  // 历史消息不声明模型容量；调用方未知时保持未知，不能合成默认分母。
  const contextWindow = options.contextWindow;
  push(SessionEventType.SessionCreated, {
    mode: "default",
    contextWindow,
  });

  let turnNumber = 0;
  let index = 0;
  const emittedCompactOperations = new Set<string>();
  const durableCompactPartsByOperation = new Map<
    string,
    Extract<MessagePart, { type: "compaction" }>
  >();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "compaction") continue;
      if (!part.timelineStatus && !part.tail_start_id && !part.compactBoundary) continue;
      const operationId = String(
        part.operationId ?? part.boundaryId ?? `legacy-compact-${String(part.id)}`,
      );
      const existing = durableCompactPartsByOperation.get(operationId);
      if (!existing || (!existing.tail_start_id && part.tail_start_id)) {
        durableCompactPartsByOperation.set(operationId, part);
      }
    }
  }
  const emittedGoalVerifications = new Set<string>();
  let lastTurnId: string | undefined;

  const entryFacts = mergeGoalVerificationEntryFacts(options.goalVerificationEntries ?? []);
  const goalVerificationsByAnchor = new Map<string, GoalVerificationFact[]>();
  for (const fact of entryFacts) {
    if (!fact.anchorAssistantMessageId) continue;
    const list = goalVerificationsByAnchor.get(fact.anchorAssistantMessageId) ?? [];
    list.push(fact);
    goalVerificationsByAnchor.set(fact.anchorAssistantMessageId, list);
  }

  // MC-cold：modelChange marker 由投影在 TurnStarted 时
  // 对比 lastTurnModel 与 config 生成；冷恢复按每轮持久化选型事实在 TurnStarted 前
  // 合成 ModelSelected——普通首轮静默，显式 source-less 与后续 A→B 边界恒重建。
  // 该合成事件带 HYDRATION_TRACE_ID，不声明 种子权威（见 onModelSelected）。
  let lastSelectedModelKey: string | null = null;
  let pendingTimelineModel: HydratedTimelineModel | null = null;
  // 同一模型 key 不重复发 ModelSelected；冷恢复首轮静默，后续变化才产生 marker。
  const selectTurnModel = (selection: HydratedTimelineModel | null): void => {
    if (!selection) return;
    const key = hydratedModelKey(selection.modelSelection);
    if (key === lastSelectedModelKey) return;
    lastSelectedModelKey = key;
    push(SessionEventType.ModelSelected, {
      modelSelection: selection.modelSelection,
      ...(selection.previousModelSelection !== undefined
        ? {
            previousModelSelection: selection.previousModelSelection
              ? selection.previousModelSelection
              : null,
          }
        : {}),
    });
  };
  // 开轮选型：显式 timeline part 的 toModel 优先，否则退回本轮 user 消息快照。
  const selectAcceptedTurnModel = (fallback: ModelSelection | null): void => {
    const selected = pendingTimelineModel ?? (fallback ? { modelSelection: fallback } : null);
    pendingTimelineModel = null;
    selectTurnModel(selected);
  };
  // 记录待消费的边界事实，并立即同步 ModelSelected（保证发生在下一个 TurnStarted 前）。
  const recordTimelineModel = (selection: HydratedTimelineModel): void => {
    pendingTimelineModel = selection;
    selectTurnModel(selection);
  };

/**
 * 收口一轮：有 failure 只发 TurnError（保留 code/attribution），
 * 否则发 ModelComplete（end_turn + 本轮 fileChanges）与 TurnComplete。
 * duration 由持久时间差计算；usage 恒为 0（冷恢复不重新计费）。
 */
  // [事务] 有 failure 只发 TurnError；否则 ModelComplete + TurnComplete。
  // usage 恒为 0：冷恢复不重新计费。
  // contextWindow 用调用方注入真值，不能固定成 20 万。
  const finishTurn = (input: {
    failure?: TurnOutputCollection["failure"];
    fileChanges?: TurnFileChangeSummary;
    turnId: string;
    resultType: TurnResultForHydration;
    toolCallCount: number;
    historyRoundCount: number;
    turnStartedAtMs: number;
    turnEndedAtMs: number;
  }): void => {
    if (input.failure) {
      // provider 首字前失败只持久化在 assistant.info.error，旧 cold 路径
      // 折成 TurnComplete(error_during_execution)，导致 lastError 的 code/message 全丢。
      // 这里复用 live 的 TurnError 状态机，避免另建 cold-only 错误 reducer。
      push(
        SessionEventType.TurnError,
        { error: input.failure, turnPhase: "model" },
        input.turnId,
        input.turnEndedAtMs,
      );
      return;
    }
    push(
      SessionEventType.ModelComplete,
      {
        content: "",
        stopReason: "end_turn",
        querySource: "main_turn",
        // 冷恢复曾把合成事件的窗口固定成 20 万，覆盖同一模型在
        // workspace provider registry 中的 1M 能力；这里沿用调用方解析出的当前模型真值。
        contextWindow,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        ...(input.fileChanges ? { fileChanges: input.fileChanges } : {}),
      },
      input.turnId,
      input.turnEndedAtMs,
    );
    push(
      SessionEventType.TurnComplete,
      {
        response: "",
        tokenCount: 0,
        toolCallCount: input.toolCallCount,
        historyRoundCount: input.historyRoundCount,
        // 冷恢复是从 message transcript 反向合成事件，不能像 live
        // 事件一样依赖运行时 startedAt；固定 0 会让历史轮次显示成 1 秒。
        duration: Math.max(0, input.turnEndedAtMs - input.turnStartedAtMs),
        resultType: input.resultType,
      },
      input.turnId,
      input.turnEndedAtMs,
    );
  };

  while (index < messages.length) {
    const message = messages[index]!;
    if (isProviderContextOnlyAssistant(message)) {
      index += 1;
      continue;
    }
    if (isLegacyCompactMaintenanceInput(message, messages[index + 1])) {
      // 旧手动 compact 的 user 宿主只是维护命令，不是 real-user intent；跳过宿主后，
      // 下一条 assistant compact fact 会走 preface model-only 轮并生成 canonical marker。
      index += 1;
      continue;
    }
    if (isForkTimelineMessage(message)) {
      const forkContext = forkContextOfMessage(message);
      if (forkContext) {
        push(SessionEventType.SessionForked, {
          forkPoint: 0,
          originalSessionId: forkContext.parentSessionId,
          restoredFileCount: forkContext.restoredFileCount,
          targetCheckpointId: forkContext.targetCheckpointId,
          targetMessageId: forkContext.targetMessageId,
        });
      }
      index += 1;
      continue;
    }
    const timelineModel = modelChangeToModelOf(message);
    if (timelineModel) {
      // model_change timeline part 是已接受轮的持久边界事实；
      // 宿主消息不能完全跳过、只靠后续 user message model 快照碰巧重建：
      // 快照缺失/滞后时 marker 就会消失，所以先消费显式 toModel，
      // 下一个 TurnStarted 仅使用该权威选型，不再被滞后快照覆盖。
      recordTimelineModel(timelineModel);
      index += 1;
      continue;
    }
    const workflowLaunch = workflowLaunchOfMessage(message);
    if (workflowLaunch) {
      // 中枢直接启动的启动轮：可见 controlOnly 用户轮，冷恢复须与活投影同形——同一 messageId、
      // origin workflowLaunch（由 inputSource 映射）、同一份 workflowLaunch 元数据、无助手输出。
      // 放在 real-user 分支之前，避免这条 synthetic user 被 hiddenSynthetic 跳过。
      turnNumber += 1;
      const turnId = `hydrate-turn-${turnNumber}`;
      lastTurnId = turnId;
      const launchText = textOfMessage(message.parts);
      const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
      selectAcceptedTurnModel(turnModelSelectionOfUserMessage(message));
      push(
        SessionEventType.TurnStarted,
        {
          turnNumber,
          // 文本仍进 userInput.text（旧客户端 / TUI 的降级呈现）；GUI 用元数据画启动卡。
          input: launchText,
          // 持久 messageId 是该轮权威 target，与活投影同用，否则 productTurn 身份冷热分叉。
          messageId: String(message.info.id),
          // 启动轮不执行 Agent（controlOnly，无工时）；source 驱动 origin=workflowLaunch。
          executionKind: "controlOnly",
          inputSource: "workflow_launch",
          workflowLaunch,
        },
        turnId,
        turnStartedAtMs,
      );
      index += 1;
      const collected = collectTurnOutput({
        messages,
        startIndex: index,
        turnId,
        turnStartedAtMs,
        emittedCompactOperations,
        durableCompactPartsByOperation,
        emittedGoalVerifications,
        goalVerificationsByAnchor,
        onModelChange: recordTimelineModel,
        push,
      });
      index = collected.nextIndex;
      finishTurn({
        failure: collected.failure,
        turnId,
        resultType: collected.resultType,
        toolCallCount: collected.toolCallCount,
        historyRoundCount: collected.historyRoundCount,
        turnStartedAtMs,
        turnEndedAtMs: collected.turnEndedAtMs,
      });
      continue;
    }
    if (!isRealUserTurnStarter(message)) {
      // model-only 唤醒轮：background wake /
      // goal continuation 触发的 synthetic user 开独立 model-only 轮（无可见气泡，
      // 通知文本不进 rows），其后 assistant 归本轮——与 live 的 TurnStarted
      // (inputVisibility=model-only) 结构一致，不再并进上一轮。
      const wakeSource = getConversationModelOnlyTurnTriggerSource(message);
      if (wakeSource) {
        turnNumber += 1;
        const turnId = `hydrate-turn-${turnNumber}`;
        lastTurnId = turnId;
        const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
        selectAcceptedTurnModel(turnModelSelectionOfUserMessage(message));
        push(
          SessionEventType.TurnStarted,
          {
            turnNumber,
            // cold hydration 曾把 model-only background wake 的原文清空，
            // 导致 ProductProjection 即使能消费 task-notification，恢复时也拿不到
            // tool-use-id 与失败详情。输入仍是 model-only，不会生成用户气泡。
            input: wakeSource === "background_task" ? textOfMessage(message.parts) : "",
            inputVisibility: "model-only",
            inputSource: wakeSource,
            ...(wakeSource === "background_task"
              ? { originMeta: backgroundResultOriginMetaOfMessage(message) }
              : {}),
            // model-only trigger 同样是持久 user 实体；若不传 messageId，
            // cold 会退化到 hydrate-turn-N，live/cold productTurn 身份再次分叉。
            messageId: String(message.info.id),
          },
          turnId,
          turnStartedAtMs,
        );
        index += 1;
        const collected = collectTurnOutput({
          messages,
          startIndex: index,
          turnId,
          turnStartedAtMs,
          emittedCompactOperations,
          durableCompactPartsByOperation,
          emittedGoalVerifications,
          goalVerificationsByAnchor,
          onModelChange: recordTimelineModel,
          push,
        });
        index = collected.nextIndex;
        finishTurn({
          failure: collected.failure,
          fileChanges: options.fileChangeSummariesByMessageId?.get(String(message.info.id)),
          turnId,
          resultType: collected.resultType,
          toolCallCount: collected.toolCallCount,
          historyRoundCount: collected.historyRoundCount,
          turnStartedAtMs,
          turnEndedAtMs: collected.turnEndedAtMs,
        });
        continue;
      }
      // assistant-head-skip 修复（「assistant 回复整段消失」冷路径向量）：
      // 首条真实用户消息之前的消息不能一律跳过——会话头部是 rewind notice /
      // compact summary 等非真实用户消息时，其后 assistant 回复刷新后会整段消失。
      // 因此为头部 assistant 输出合成 preface model-only 轮（无可见 user 气泡，
      // 内容照常渲染）。user 角色的非触发型 synthetic context 仍按设计不可见，照旧跳过。
      if (message.info.role !== "assistant" || !assistantMessageHasSynthesizableContent(message)) {
        index += 1;
        continue;
      }
      turnNumber += 1;
      const turnId = `hydrate-turn-${turnNumber}`;
      lastTurnId = turnId;
      const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
      selectAcceptedTurnModel(assistantModelSelectionOf(message));
      push(
        SessionEventType.TurnStarted,
        { turnNumber, input: "", inputVisibility: "model-only" },
        turnId,
        turnStartedAtMs,
      );
      const collected = collectTurnOutput({
        messages,
        startIndex: index,
        turnId,
        turnStartedAtMs,
        emittedCompactOperations,
        durableCompactPartsByOperation,
        emittedGoalVerifications,
        goalVerificationsByAnchor,
        onModelChange: recordTimelineModel,
        push,
      });
      index = collected.nextIndex;
      finishTurn({
        failure: collected.failure,
        turnId,
        resultType: collected.resultType,
        toolCallCount: collected.toolCallCount,
        historyRoundCount: collected.historyRoundCount,
        turnStartedAtMs,
        turnEndedAtMs: collected.turnEndedAtMs,
      });
      continue;
    }

    turnNumber += 1;
    const turnId = `hydrate-turn-${turnNumber}`;
    lastTurnId = turnId;
    const userText = textOfMessage(message.parts);
    const attachments = attachmentMetasOfMessage(message.parts);
    const intent = inputIntentOfMessage(message);
    const executionKind = executionKindOfMessage(message);
    const epilogueStart = epilogueStartOfMessage(message);
    const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
    // timeline part 与下一个 accepted turn 之间可以夹着 legacy synthetic
    // context，不能靠「紧邻前一条」猜测；持有显式边界直到真正开轮。
    selectAcceptedTurnModel(turnModelSelectionOfUserMessage(message));
    push(
      SessionEventType.TurnStarted,
      {
        turnNumber,
        input: userText,
        ...(epilogueStart === undefined ? {} : { epilogueStart }),
        // 根因：cold hydration 过去只重建可见 user row，遗漏持久 messageId，导致
        // 同一条历史消息在 UI 中可见却无法被 edit/rewind 命令寻址。真实 user
        // transcript message 就是该 row 的权威 target，必须与 live TurnStarted
        // 使用同一个 messageId 字段进入 ProductProjection。
        messageId: String(message.info.id),
        ...(executionKind ? { executionKind } : {}),
        ...(message.info.anchor?.sourceCommandId
          ? { inputId: message.info.anchor.sourceCommandId }
          : {}),
        ...(intent ? { intent } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      turnId,
      turnStartedAtMs,
    );
    index += 1;

    const collected = collectTurnOutput({
      messages,
      startIndex: index,
      turnId,
      turnStartedAtMs,
      emittedCompactOperations,
      durableCompactPartsByOperation,
      emittedGoalVerifications,
      goalVerificationsByAnchor,
      onModelChange: recordTimelineModel,
      push,
    });
    index = collected.nextIndex;
    finishTurn({
      failure: collected.failure,
      fileChanges: options.fileChangeSummariesByMessageId?.get(String(message.info.id)),
      turnId,
      resultType: collected.resultType,
      toolCallCount: collected.toolCallCount,
      historyRoundCount: collected.historyRoundCount,
      turnStartedAtMs,
      turnEndedAtMs: collected.turnEndedAtMs,
    });
  }

  // anchor 缺失或指向未在 transcript 中出现的消息的 entry 事实：落到已知时间线末尾
  //（已按 key 去重，锚定成功的在上面循环里已发射；不猜 timestamp，不静默丢）。
  for (const fact of entryFacts) {
    pushGoalVerificationFact(fact, emittedGoalVerifications, push, lastTurnId);
  }

  return events;
}

/**
 * transcript 侧的产品态计数（期望值）。
 *
 * 统计 user 轮、assistant 文本、reasoning、toolCallId、compact、subagent、
 * fork、goal verify、model change；口径与 ProductProjection 的 row 生成条件同源。
 * goal entry 与 timeline part 按 key 去重；副作用：无。
 */
// [契约] 期望值统计，口径与投影 row 生成条件同源。
// modelChangeCount 取“相邻 user 选型变化数”与显式 part 数的最大值。
// 新增计数维度必须同时扩 projectionFootprint 与 footprintCovered。
function transcriptFootprint(
  messages: readonly MessageWithParts[],
  goalVerificationEntries: readonly HydratedGoalVerificationEntry[] = [],
): TranscriptFootprint {
  const compactOperations = new Set<string>();
  const goalVerificationKeys = new Set<string>();
  const modelChangeKeys = new Set<string>();
  for (const fact of mergeGoalVerificationEntryFacts(goalVerificationEntries)) {
    goalVerificationKeys.add(fact.key);
  }
  const footprint: TranscriptFootprint = {
    userTurnCount: 0,
    assistantTexts: [],
    reasoningTexts: [],
    toolCallIds: [],
    compactMarkerCount: 0,
    subagentCount: 0,
    forkTimelineCount: 0,
    goalVerificationCount: 0,
    modelChangeCount: 0,
  };
  // 模型切换 footprint = 相邻真实 user 轮持久化选型快照的变化次数（与投影 marker 的
  // 生成条件同源：本轮实际选型 ≠ 上一轮）。
  let lastModelKey: string | null = null;

  for (const message of messages) {
    if (isForkTimelineMessage(message)) {
      footprint.forkTimelineCount += 1;
    }
    if (isRealUserTurnStarter(message)) {
      footprint.userTurnCount += 1;
      const model = turnModelSelectionOfUserMessage(message);
      if (model) {
        const key = hydratedModelKey(model);
        if (lastModelKey !== null && key !== lastModelKey) {
          footprint.modelChangeCount += 1;
        }
        lastModelKey = key;
      }
    }
    if (message.info.role !== "assistant" || isProviderContextOnlyAssistant(message)) {
      continue;
    }
    for (const part of message.parts) {
      if (part.type === "text" && part.ignored !== true && part.text.length > 0) {
        footprint.assistantTexts.push(part.text);
        continue;
      }
      if (part.type === "reasoning" && part.text.length > 0) {
        footprint.reasoningTexts.push(part.text);
        continue;
      }
      if (part.type === "tool") {
        if (shouldHideInvalidToolCallFromProduct(part.tool, part.metadata)) continue;
        footprint.toolCallIds.push(part.callID);
        const subagentInfo = subagentInfoFromToolPart(part);
        if (subagentInfo && part.state.status !== "pending") {
          footprint.subagentCount += 1;
        }
        continue;
      }
      if (part.type === "subtask") {
        footprint.subagentCount += 1;
        continue;
      }
      if (part.type === "timeline" && part.timelineType === "goal_verification") {
        goalVerificationKeys.add(goalVerificationKeyOfPart(part));
        continue;
      }
      if (part.type === "timeline" && part.timelineType === "model_change") {
        modelChangeKeys.add(modelChangeKeyOfPart(part));
        continue;
      }
      const compact =
        part.type === "timeline"
          ? compactPayloadFromTimelinePart(part)
          : part.type === "compaction"
            ? compactPayloadFromLegacyCompactionPart(part)
            : null;
      if (compact) {
        compactOperations.add(String(compact.payload.operationId));
      }
    }
  }
  footprint.compactMarkerCount = compactOperations.size;
  footprint.goalVerificationCount = goalVerificationKeys.size;
  // 新数据的 timeline part 是显式 boundary authority；旧数据无 part 时才依赖
  // 相邻轮 model 快照变化数。两者表达同一批边界，取 max 避免重复计数。
  footprint.modelChangeCount = Math.max(footprint.modelChangeCount, modelChangeKeys.size);
  return footprint;
}

/**
 * 用真实 ProductProjection 重放事件，统计实际产品态（实际值）。
 * 这是"事件日志能否覆盖 transcript"的唯一裁判，不使用简化模拟器。
 */
// [契约] 用真实 ProductProjection 重放事件得到实际值，不用简化模拟器。
// 会话 id 用于投影实例化，取事件或消息的 sessionID。
// 重放是全量的，调用方需自行控制调用频率。
function projectionFootprint(
  events: readonly SessionEvent[],
  sessionId: string,
): TranscriptFootprint {
  const projection = new ProductProjection(sessionId, "hydrate-footprint");
  for (const event of events) {
    projection.applyEvent(event);
  }
  const rows = projection.getSnapshot().rows.window;
  return {
    userTurnCount: rows.filter((row) => row.kind === "userInput").length,
    assistantTexts: rows
      .filter((row) => row.kind === "assistantText")
      .map((row) => (row.kind === "assistantText" ? row.text : "")),
    reasoningTexts: rows
      .filter((row) => row.kind === "reasoning")
      .map((row) => (row.kind === "reasoning" ? row.text : "")),
    toolCallIds: rows
      .filter((row) => row.kind === "toolCall")
      .map((row) => (row.kind === "toolCall" ? row.toolCallId : "")),
    compactMarkerCount: rows.filter(
      (row) => row.kind === "timelineMarker" && row.marker.type === "compact",
    ).length,
    subagentCount: rows.filter((row) => row.kind === "subagent").length,
    forkTimelineCount: rows.filter(
      (row) =>
        row.kind === "timelineMarker" &&
        (row.marker.type === "forkNotice" || row.marker.type === "forkCreated"),
    ).length,
    goalVerificationCount: rows.filter(
      (row) => row.kind === "timelineMarker" && row.marker.type === "goalVerify",
    ).length,
    modelChangeCount: rows.filter(
      (row) => row.kind === "timelineMarker" && row.marker.type === "modelChange",
    ).length,
  };
}

/** 多重集包含：expected 每个值都要在 actual 中消耗一次，避免单条 row 冒充重复内容。 */
function valuesCover(expected: readonly string[], actual: readonly string[]): boolean {
  const remaining = [...actual];
  for (const value of expected) {
    const index = remaining.indexOf(value);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

/**
 * expected 被 actual 覆盖：计数类取 >=（允许多余状态），文本/工具集合取多重集包含。
 * 任一维度不足即判定未覆盖，调用方必须走完整 hydration。
 */
// [契约] 计数维度取 >=（允许多余状态），文本/工具取多重集包含。
// 任一维度不足即 false，调用方必须走完整 hydration。
// 文本比较不 trim，空白差异会被视为不同。
function footprintCovered(expected: TranscriptFootprint, actual: TranscriptFootprint): boolean {
  return (
    actual.userTurnCount >= expected.userTurnCount &&
    actual.compactMarkerCount >= expected.compactMarkerCount &&
    actual.subagentCount >= expected.subagentCount &&
    actual.forkTimelineCount >= expected.forkTimelineCount &&
    actual.goalVerificationCount >= expected.goalVerificationCount &&
    actual.modelChangeCount >= expected.modelChangeCount &&
    valuesCover(expected.assistantTexts, actual.assistantTexts) &&
    valuesCover(expected.reasoningTexts, actual.reasoningTexts) &&
    valuesCover(expected.toolCallIds, actual.toolCallIds)
  );
}

/**
 * 事件日志是否已覆盖 transcript 的可见产品态。
 *
 * 短路：transcript 全空 → 视为覆盖（无需 hydration）。
 * 否则分别计算 transcript / projection footprint 并逐维度比较；
 * 只有全部维度满足才返回 true，调用方据此跳过重建。
 * 返回 false 不是错误，只表示必须走 synthesizeEventsFromMessages 补齐。
 */
/**
 * 判断事件日志是否足以覆盖 transcript 的可见产品态。
 * 修复原因：旧判据只数 user turn，事件日志即使缺 tool/reasoning/compact/subagent
 * 也会被误判为完整，导致冷恢复 snapshot 没有对应 rows。
 */
// [契约] 覆盖判据的唯一对外入口；true 表示可跳过重建。
// transcript 全空时直接 true，避免无意义 hydration。
// 返回 false 不是错误，只表示需要补齐事件。
export function eventsCoverTranscript(
  events: readonly SessionEvent[],
  messages: readonly MessageWithParts[],
  options: {
    goalVerificationEntries?: readonly HydratedGoalVerificationEntry[];
  } = {},
): boolean {
  const expected = transcriptFootprint(messages, options.goalVerificationEntries ?? []);
  if (
    expected.userTurnCount === 0 &&
    expected.assistantTexts.length === 0 &&
    expected.reasoningTexts.length === 0 &&
    expected.toolCallIds.length === 0 &&
    expected.compactMarkerCount === 0 &&
    expected.subagentCount === 0 &&
    expected.forkTimelineCount === 0 &&
    expected.goalVerificationCount === 0 &&
    expected.modelChangeCount === 0
  ) {
    return true;
  }
  const sessionId = String(messages[0]?.info.sessionID ?? events[0]?.sessionId ?? "unknown");
  return footprintCovered(expected, projectionFootprint(events, sessionId));
}
