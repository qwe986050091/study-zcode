/* oxlint-disable eslint(max-lines) -- 旧 message/ARMS builders 共用同一 prompt 生命周期与时钟；拆散 fact 状态机会增加跨模块同步漂移。 */
// INV-1: 每个 fact 以「sessionId + eventId」为去重键，而非裸 eventId —— 破坏后果：主会话与
// detached 子会话的 eventId 各自从 0 起，裸键会把子代理事实误判为重复而整条丢弃。
// INV-2: send_click 与 send_result 必须严格 1:1，由 sendClickId first-wins 保证 —— 破坏后果：
// ACK 与 catch 对同一次点击各调一次落定时，漏斗会算出双倍的发送量与错误的成功率。
// INV-3: 后台任务 seed 没有 sendClickId，落定时必须直接跳过 —— 破坏后果：伪造一个点击来源
// 会让自动化任务进入「用户发送」漏斗，转化率被系统性抬高。
// INV-4: 等待渲染的定时器必须在 dispose 与成功落定两条路径上都被清除 —— 破坏后果：卸载后
// 仍会落定一批 render_timeout，产生指向已关闭工作区的幽灵失败上报。
// INV-5: 终态汇总（agent_step）每个 detached 子代理只上报一次，由 usageReported 门闩 ——
// 破坏后果：turn.terminal 与 stopped 双终态会各报一次，token 与调用数双双翻倍。
// INV-6: 汇总后再按 openToolCallIds 排空迟到工具终态，两步不可合并 —— 破坏后果：提前删账本
// 会丢掉已开始工具的终态，表现为「工具数少于实际、耗时缺失」。
// INV-7: workflow 子代理的终态只认 run-settled，turn.terminal 只是一次 ask 结束 —— 破坏后果：
// 把每次 ask 当终态会在多轮 ask 的 run 里提前收口，后续 ask 的 token 全部漏报。
// INV-8: 所有上报都经 enqueueReport 串行化，且首条立即发起 —— 破坏后果：异步 IPC 在 main
// 侧并发执行会偶发反序，数仓按到达顺序重建 turn 时得到错误的结束时间。
// INV-9: reportTail 只在「自己仍是队尾」时置空 —— 破坏后果：并发入队时前一条的清理回调
// 会把后一条的链尾清掉，串行化断裂，重新出现乱序。
// INV-10: 前台判定以「session 级引用计数」为准，多 pane 同时可见只算一份 —— 破坏后果：
// 关掉其中一个 pane 就误判为切后台，firstToken 与 stall 统计被提前关闭。
// INV-11: 切后台时必须清 stream stall 跟踪 —— 破坏后果：后台停留的墙钟时间会在回前台后
// 被当成一次超长流停顿，产出虚假的 stall 告警。
// INV-12: 未激活生命周期（未收到 turn.started）的事实必须先缓冲，不能丢弃 —— 破坏后果：
// ACK 早于 TurnStarted 时首个 chunk 丢失，TTFT 计算缺起点。
// INV-13: 缓冲裁剪优先丢普通 stream.chunk，绝不先丢 turn.started/firstChunk/终态 ——
// 破坏后果：高频正文挤掉生命周期锚点后，该轮永远无法激活，整轮指标全部缺失。
// INV-14: 缓冲命令数与单命令缓冲条数都有上界，溢出按插入序淘汰 —— 破坏后果：Host 长时间
// 不 ACK 时无限增长，renderer 内存随会话时长线性上涨直至崩溃。
// INV-15: 存在 deferred terminal 时，同 task 的新 turn.started 必须继续阻塞 —— 破坏后果：
// 上一轮的终态还没结算就开始下一轮，两轮 step 会挂到同一 messageId 下互相污染。
// INV-16: 去重集合都是有界 LRU（BoundedKeySet），淘汰最旧键 —— 破坏后果：长会话里 eventId
// 集合无界增长；反过来若整表清空，重放的历史事实会被当成新事实重复上报。
// INV-17: 所有上报的 taskKey 必须带 workspaceScopeKey 前缀 —— 破坏后果：多窗口共用进程时
// 不同工作区的同名 session 会共享生命周期，指标串台。
// INV-18: compaction 只按「终态到达瞬间是否前台」决定是否上报 —— 破坏后果：后台到达、
// 回前台补报会给出用户从未见过的压缩提示，误导排查。
// INV-19: 生命周期清理必须同时删 activeCommandBySessionId 与 commandIdByTurnKey ——
// 破坏后果：残留映射会把下一轮无 sourceCommandId 的事实解析到已结束的命令上。
// INV-20: 子代理子会话的 step id 必须带 agent/来源前缀 —— 破坏后果：父子工具 id 撞车后
// 同一条 step 被覆盖，父 Agent 的耗时与 token 归属错位。
// INV-21: token 归属只认已到达的 usage，缺失时沿用零值而不是跳过上报 —— 破坏后果：
// 跳过会让「调用发生了但没 token」的轮次在数仓里完全不存在，口径出现空洞。
// INV-22: 该 supervisor 不读 React rows/snapshot，只接收 fact 流 —— 破坏后果：引入快照读取
// 后两份真值会竞态，重连补发时出现重复 step 或状态回退。
import {
  legacyTelemetryModelValue,
  legacyTelemetryProviderId,
} from "@/lib/providerTelemetryIdentity.js";
import type {
  IPlatformService,
  RemoteWorkspaceIdentityKind,
  ZCodeContextCompactionTimelineMeta,
  ZCodeStreamEvent,
  ZCodeUsage,
} from "@zcode/shared";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import {
  reportChatErrorBannerTelemetry,
  resolveVisibleChatErrorTelemetryRecoveryAction,
  type ChatErrorBannerSurface,
} from "@/lib/chatErrorBannerTelemetry.js";
import {
  activatePromptTelemetry,
  activateDetachedAgentStepTelemetry,
  composeAgentComposition,
  type AgentStepRole,
  type PromptMessageSource,
  buildCompactionTelemetryExtraDetail,
  discardPromptTelemetry,
  discardQueuedPromptTelemetry,
  finalizePromptTelemetry,
  getActivePromptModelName,
  getActivePromptMessageId,
  queuePromptTelemetry,
  recordAgentStepTelemetryEvent,
  recordComposerFocus,
  recordComposerTextChange,
  recordSubagentToolAttribution,
  recordPromptModelRequestStarted,
  recordPromptPermissionRequest,
  recordPromptPermissionResponse,
  recordPromptTokenUsageDelta,
} from "@/lib/messageTelemetry.js";
import {
  reportPlanUsageModelRequestStartedToArms,
  reportPlanUsageTtftToArms,
} from "@/lib/planUsageArmsTelemetry.js";
import {
  reportSendFunnelInputFocus,
  reportSendFunnelSendClick,
  reportSendFunnelSendResult,
  type SendFunnelReasonCode,
} from "@/lib/sendFunnelArmsTelemetry.js";
import {
  clearStreamStallTracking,
  recordStreamChunkArrival,
  reportUiFirstToken,
  reportUiMessageComplete,
  reportUiToolCallDetail,
  reportUiTurnBreakdown,
} from "@/lib/uiPerfArmsTelemetry.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { resolveLegacyRuntimeModelValue } from "@/v4/telemetry/conversationPromptTelemetry.js";

// 去重集合的容量上限：2000 远超单次会话的事实量，但能在长时间不重启的窗口里封顶内存。
// 用固定值而不是按会话数缩放，是因为集合本身不区分会话，缩放会让早会话的键被加速淘汰。
const MAX_DEDUPE_KEYS = 2_000;
// 单命令缓冲上限 128：正常顺序下 ACK 只慢几帧，128 条足以覆盖首屏；再多说明 Host 异常，
// 此时保留生命周期锚点比保留全部正文更重要。
const MAX_BUFFERED_FACTS_PER_COMMAND = 128;
// 缓冲命令上限 200：一个窗口里同时在飞的命令通常个位数，200 是「用户疯狂连发」的安全余量。
const MAX_BUFFERED_COMMANDS = 200;

// 只取平台的两个上报方法而不是整个 IPlatformService：注入面越小，测试替身越简单，
// 也避免这个纯状态机顺手拿到文件系统等无关能力。
type TelemetryPlatform = Pick<IPlatformService, "reportArmsCustomEvent" | "reportTelemetryEvent">;

export interface ConversationPromptTelemetrySeed {
  // localTtft 是可选的本地首 token 观测：CLI 回放/导入的历史会话没有这项，
  // 因此下游所有取值都必须容忍 undefined，不能默认成 0 参与平均。
  localTtft?: import("@zcode/shared").LocalTtftContext;
  /** 用户触发原始发送动作的 renderer 时钟。 */
  // sendTime 用 renderer 时钟而不是服务端时间：所有 cost_ms 都是「本机感受到的时长」，
  // 混用两种时钟会因系统时差出现负值或数小时级别的假延迟。
  sendTime: number;
  /** 发送瞬间冻结的旧版模型/模式/套餐字段。 */
  extraDetail: Record<string, string>;
  /**
   * 发送漏斗关联 ID，配对 send_click ↔ send_result。仅 composer 真实点击产生；
   * 后台任务（off_peak / automation）seed 无此字段，落定时直接跳过不报。
   */
  sendClickId?: string;
  /** 是否中途经过队列二次确认弹窗（该子集的 send_cost_ms 含用户停留时间）。 */
  // 该子集的 send_cost_ms 含用户停留时间，因此分析发送耗时时必须按此字段分组，
  // 否则「弹窗确认过的发送」会被误判成一次慢发送，把整体 P90 拉高。
  queueConfirmed?: boolean;
}

/** 发送落定的失败原因，取值口径见 docs/monitoring/composer-send-funnel-telemetry.md。 */
export type ConversationSendFailureReason = SendFunnelReasonCode;

// completionMessageSource 在 admission 时冻结：等到终态再从设置里读，
// 用户在轮次进行中切换「记忆/来源」开关就会把本轮标成另一种来源。
export interface AcceptedConversationPromptTelemetrySeed extends ConversationPromptTelemetrySeed {
  /** CLI 会话记录的开关；缺失保持未知，不能用实时设置补齐。 */
  memoryEnabled?: boolean;
  sessionId: string;
  sourceCommandId: string;
  /** 独立 background wake 的 completion 来源在 TurnStarted admission 时冻结。 */
  completionMessageSource?: PromptMessageSource;
}

/** 队列二次确认的 ACK reasonCode，语义是「等用户裁决后复用同一 seed 重发」，不是终态。 */
const HELD_QUEUE_CONFIRMATION_STALE_REASON = "guard.heldQueueConfirmationStale";

// 30s 是「点击后到用户消息入列」的上限：低于它会把慢机器误判成失败，
// 高于它则会让一次卡死挂到用户主动取消，超时兜底就失去意义。
/** 从点击发送起算，超过这个时长仍未渲染出用户消息就判超时。 */
export const SEND_RENDER_WAIT_TIMEOUT_MS = 30_000;

/**
 * ACK 的处置：要么转入待渲染等待（命令被受理，但用户消息还没画出来），
 * 要么立即落定为失败。返回 null 表示本次两者都不做。
 */
export type ConversationSendAckOutcome =
  | { kind: "awaitRender"; ackStatus: string }
  | {
      kind: "settle";
      status: "fail";
      ackStatus: string;
      reasonCode: ConversationSendFailureReason;
    };

/**
 * 把 CommandAck 折算成 send_result 的处置口径，返回 null 表示本次不落定。
 * 抽成纯函数是为了让 dispatchCommand 只负责调用，分支逻辑可单测。
 */
// rejected/stale 之外的任何非 accepted 状态都归并为 failed：noop、未知状态对用户都是
// 「没发出去」，细分只会让漏斗出现长尾枚举，反而掩盖真正需要关注的 rejected。
export function resolveSendAckSettlement(ack: {
  status: string;
  reasonCode?: string;
}): ConversationSendAckOutcome | null {
  // 必须先于 status 判断：这条 ACK 的 status 本身非 accepted，
  // 一旦落定，first-wins 会把用户确认后的真实成败结果吃掉。
  if (ack.reasonCode === HELD_QUEUE_CONFIRMATION_STALE_REASON) return null;
  // accepted/duplicate 只代表 Host 收下了命令，此时屏幕上还什么都没有；
  // z-code 没有乐观渲染，要等投影回流出 userInput row 才算发送成功。
  if (ack.status === "accepted" || ack.status === "duplicate") {
    return { kind: "awaitRender", ackStatus: ack.status };
  }
  const reasonCode: ConversationSendFailureReason =
    ack.status === "rejected" || ack.status === "stale" ? ack.status : "failed";
  // noop 不单列 reason_code，用户视角就是没发出去；原始值保留在 ackStatus 供下钻。
  return { kind: "settle", status: "fail", ackStatus: ack.status, reasonCode };
}

/** ACK 已受理、等待用户消息渲染出来的一条待落定记录。 */
interface PendingSendRenderWait {
  seed: ConversationPromptTelemetrySeed;
  sessionId: string | null;
  ackStatus: string;
  ackCostMs: number;
  timer: ReturnType<typeof setTimeout>;
}

function backgroundSeedFromTurnStarted(
  fact: Extract<ConversationTelemetryFact, { kind: "turn.started" }>,
): AcceptedConversationPromptTelemetrySeed | null {
  if (!fact.sourceCommandId) return null;
  if (fact.offPeakTaskId) {
    return {
      sessionId: fact.sessionId,
      sourceCommandId: fact.sourceCommandId,
      sendTime: fact.occurredAt,
      extraDetail: {
        message_source: "off_peak_task",
        off_peak_task_id: fact.offPeakTaskId,
        ...(fact.offPeakRunType ? { off_peak_run_type: fact.offPeakRunType } : {}),
      },
    };
  }
  if (!fact.automationId || !fact.taskTrigger) {
    if (fact.inputSource !== "background_task") return null;
    return {
      sessionId: fact.sessionId,
      sourceCommandId: fact.sourceCommandId,
      sendTime: fact.occurredAt,
      extraDetail: { message_source: "background_task" },
      ...(fact.backgroundSource === "subagent"
        ? { completionMessageSource: "background_subagent" as const }
        : fact.backgroundSource === "workflow"
          ? { completionMessageSource: "background_workflow" as const }
          : {}),
    };
  }
  const scheduledAt = fact.taskTrigger === "schedule" ? fact.scheduledAt : undefined;
  return {
    sessionId: fact.sessionId,
    sourceCommandId: fact.sourceCommandId,
    sendTime: fact.occurredAt,
    extraDetail: {
      message_source: "scheduled_task",
      task_trigger: fact.taskTrigger,
      automation_id: fact.automationId,
      ...(scheduledAt !== undefined
        ? {
            scheduled_at: String(scheduledAt),
            schedule_lag_ms: String(Math.max(0, fact.occurredAt - scheduledAt)),
          }
        : {}),
    },
  };
}

/**
 * 冻结到每条 agent_step 的来源字段（与 completion 同值）。只挑来源归因字段：seed 里的模型/套餐
 * 维度不属于 step 契约，scheduled_at / schedule_lag_ms 描述整次运行、只随 completion 上报。
 */
const STEP_SOURCE_DETAIL_KEYS = [
  "memory_enabled",
  "message_source",
  "task_trigger",
  "automation_id",
  "off_peak_task_id",
  "off_peak_run_type",
] as const;

function stepSourceDetailOf(extraDetail: Record<string, string>): Record<string, string> {
  const detail: Record<string, string> = {};
  for (const key of STEP_SOURCE_DETAIL_KEYS) {
    const value = extraDetail[key];
    if (value !== undefined) detail[key] = value;
  }
  return detail;
}

interface PromptLifecycle {
  sessionId: string;
  sourceCommandId: string;
  taskKey: string;
  sendTime: number;
  foregroundFirstTokenAt: number | null;
  legacyFirstTokenObserved: boolean;
  turnId?: string;
  active: boolean;
  lastErrorMessage?: string;
  completionMessageSource?: PromptMessageSource;
  hasForegroundSubagentResult: boolean;
  hasBackgroundSubagentResult: boolean;
  /** 本轮消费过 dynamic-workflow run 的通知（agent_composition 的 wf 维度）。 */
  hasWorkflowResult: boolean;
  startedToolCallIds: Set<string>;
  stepSourceDetail: Record<string, string>;
}

interface BufferedFact {
  fact: ConversationTelemetryFact;
  receivedAt: number;
  foregroundAtReceipt: boolean;
}

interface ForegroundSubagentUsage {
  agentId: string;
  parentCommandId: string;
  parentToolCallId: string;
  requestIds: string[];
  requestCount: number;
  modelName: string;
  modelProvider: string;
  providerName: string;
  usage: ZCodeUsage | null;
  stopped: boolean;
  pendingFinalizedSteps: PendingFinalizedStep[];
}

/**
 * 一个 detached 子会话的埋点账本。两种来源共用：
 * - `background`：Agent 工具的后台子代理，登记自 `subagent.lifecycle`，终态是子会话自己的
 *   `turn.terminal` 或 `subagent.lifecycle(stopped)`；
 * - `workflow`：动态工作流子代理，登记自 `workflow.lifecycle(actor-spawned)`，终态**只有**
 *   `workflow.lifecycle(run-settled)`——子会话的每次 turn.terminal 只是一次 ask 的结束。
 */
interface BackgroundSubagentTelemetry {
  kind: "background" | "workflow";
  /** 仅 workflow：所属 run（终态汇总 step 的 tool_call_id 用它收尾）。 */
  runId?: string;
  parentSessionId: string;
  sourceCommandId: string;
  parentToolCallId: string;
  childSessionId: string;
  agentId: string;
  taskKey: string;
  stepSourceDetail: Record<string, string>;
  startedToolCallIds: Set<string>;
  usageReported: boolean;
  openToolCallIds: Set<string>;
  startedAt: number;
  requestIds: string[];
  requestCount: number;
  usage: ZCodeUsage | null;
  modelName: string;
  modelProvider: string;
  providerName: string;
}

type FinalizedAgentStep = ReturnType<typeof recordAgentStepTelemetryEvent>[number];

interface PendingFinalizedStep {
  step: FinalizedAgentStep;
  extraDetail?: Record<string, string>;
}

interface DeferredTerminal {
  lifecycle: PromptLifecycle;
  fact: Extract<ConversationTelemetryFact, { kind: "turn.terminal" }>;
  receivedAt: number;
  foregroundAtReceipt: boolean;
}

export interface ConversationTelemetryWorkspaceDetail {
  workspace_kind: "local" | "remote";
  remote_kind: RemoteWorkspaceIdentityKind | "";
}

// 有界去重集合：Set 的迭代顺序即插入顺序，因此「淘汰第一个」等价于 LRU 的最旧键。
// 不用 Map 或数组是因为这里只需要「见过没有」这一个位，额外的值只会增加内存。
class BoundedKeySet {
  private readonly keys = new Set<string>();

  // 返回 true 表示「首次见到」，调用方据此决定是否继续处理；false 表示重复，应整条丢弃。
  // 语义写成「remember」而不是「has+add」两步，是为了让判断与写入不可分割——
  // 分成两步时调用方一旦忘记 add，就会退化成完全不去重。
  remember(key: string): boolean {
    if (this.keys.has(key)) {
      return false;
    }
    this.keys.add(key);
    // 超过上限立刻淘汰最旧：延后到批量清理会让峰值内存不可控，
    // 而这里单次只多出一个元素，代价可忽略。
    if (this.keys.size > MAX_DEDUPE_KEYS) {
      const oldest = this.keys.values().next().value;
      if (typeof oldest === "string") {
        this.keys.delete(oldest);
      }
    }
    return true;
  }

  // dispose 时统一清空：不清的话 supervisor 被丢弃后这些字符串键仍被持有，
  // 窗口级热重载会留下整份旧会话的去重状态（虽不可达但占用堆）。
  clear(): void {
    this.keys.clear();
  }
}

// fact → 旧版 ZCodeStreamEvent 的适配层：messageTelemetry 与 ARMS 的既有 builder 只接受
// 旧事件形状，重写一套新 builder 会与 CLI 侧口径分叉，因此这里做「形状翻译」而不做逻辑。
function toLegacyNetworkEvent(
  fact: Extract<ConversationTelemetryFact, { kind: "model.request.status" }>,
): Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }> {
  return {
    // taskId 用 sessionId 而非 turnId：旧口径里网络调试归属于会话级视图。
    type: "task_network_debug_status",
    taskId: fact.sessionId,
    // traceId 复用 eventId，保证一条网络事件在旧视图里可被单独定位。
    traceId: fact.eventId,
    ...(fact.sourceCommandId ? { inputId: fact.sourceCommandId } : {}),
    ...(fact.queryId ? { queryId: fact.queryId } : {}),
    eventKey: fact.eventId,
    eventId: fact.eventId,
    statusType: fact.status,
    requestId: fact.requestId,
    providerId: fact.providerId,
    modelId: fact.modelId,
    providerKind: fact.providerKind,
    transport: fact.transport,
    // messageTelemetry 的旧入口只接受 baseURL；fact 已提前裁成 hostname，重新包装不扩大隐私面。
    baseURL: fact.providerHostname ? `https://${fact.providerHostname}` : undefined,
    querySource: fact.querySource,
    attempt: fact.attempt,
    maxAttempts: fact.maxAttempts,
    nextAttempt: fact.nextAttempt,
    retryable: fact.retryable,
    statusCode: fact.statusCode,
    durationMs: fact.durationMs,
    delayMs: fact.delayMs,
    idleMs: fact.idleMs,
    timeoutMs: fact.timeoutMs,
    reason: fact.reason,
    requestHeaders: {},
    responseHeaders: {},
    requestHeaderCount: 0,
    responseHeaderCount: 0,
  } as Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }>;
}

// 拼接顺序固定为「前缀_agentId_childToolCallId」：agentId 在前保证同一 agent 的所有子工具
// 在按 id 排序时聚在一起，也避免 childToolCallId 里恰好含 agentId 时产生歧义。
function scopedSubagentToolCallId(agentId: string, childToolCallId: string): string {
  return `tool_subagent_${agentId}_${childToolCallId}`;
}

// 前缀不能共用：workflow 与 background 是两套生命周期（前者 run-settled 收口），
// 若 id 同形，数仓按前缀区分来源的分析会失效，两批 step 会被合并统计。
/** detached 子会话的 step 用来源前缀区分：Agent 工具子代理 `tool_subagent_`，工作流子代理 `tool_workflow_`。 */
function scopedChildToolCallId(
  child: BackgroundSubagentTelemetry,
  childToolCallId: string,
): string {
  return child.kind === "workflow"
    ? `tool_workflow_${child.agentId}_${childToolCallId}`
    : scopedSubagentToolCallId(child.agentId, childToolCallId);
}

// runId 可能缺失（升级前的旧 run 或后端未透传），此时退回父 Agent 工具调用 id：
// 缺锚点时宁可把汇总 step 挂到父调用上，也不能产生一个无法归属的孤儿 step。
/** 终态汇总 step 的收尾 id：后台子代理是父 Agent 工具调用，工作流子代理是 run。 */
function terminalToolCallIdOf(child: BackgroundSubagentTelemetry): string {
  return child.kind === "workflow"
    ? (child.runId ?? child.parentToolCallId)
    : child.parentToolCallId;
}

// agentRole 是数仓区分「用户直连 Agent」与「工作流内部子代理」的唯一维度，
// 两种角色的正常耗时分布完全不同，混在一起会让 P90 失去参考价值。
function childAgentRole(child: BackgroundSubagentTelemetry): AgentStepRole {
  return child.kind === "workflow" ? "workflow subagent" : "background subagent";
}

// workflow 额外带 run 与 tool_call 锚点：同一个 run 有多个子代理，
// 没有这两个字段就无法把 step 归并回「哪一次 Agent 调用」。
// parentToolCallId 为空串时不写，避免数仓里出现空字符串与缺失两种编码。
/** step 上的归属字段。 */
function childStepExtraDetail(child: BackgroundSubagentTelemetry): Record<string, string> {
  if (child.kind === "workflow") {
    return {
      child_session_id: child.childSessionId,
      ...(child.runId === undefined ? {} : { workflow_run_id: child.runId }),
      ...(child.parentToolCallId === "" ? {} : { workflow_tool_call_id: child.parentToolCallId }),
    };
  }
  return {
    child_session_id: child.childSessionId,
    parent_tool_call_id: child.parentToolCallId,
  };
}

/** detached 子会话终态汇总的输入：谁触发（eventId）、成败、错误原文。 */
interface DetachedChildTerminalOutcome {
  eventId: string;
  success: boolean;
  errorMessage?: string;
}

// 终态判定必须同时接受 success 与 completed：不同事实源（turn 与 subagent.lifecycle）
// 用了不同词表，只认一个会把另一路的成功全部误判为失败。
function terminalOutcomeOf(
  fact: Extract<ConversationTelemetryFact, { kind: "turn.terminal" | "subagent.lifecycle" }>,
): DetachedChildTerminalOutcome {
  // turn.terminal 才有 errorCode 兜底：某些失败只给 code 不给 message，
  // 直接透传 undefined 会让汇总 step 变成「失败但无原因」，排查时无迹可寻。
  const errorMessage =
    fact.errorMessage ?? (fact.kind === "turn.terminal" ? fact.errorCode : undefined);
  return {
    eventId: fact.eventId,
    success: fact.status === "success" || fact.status === "completed",
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

// tool.lifecycle fact → tool_call / tool_call_update 的适配。
// hasStarted 决定发「首次出现」还是「状态更新」：旧 builder 用事件类型区分新建与更新，
// 若首帧就发 update，旧视图里会少一条工具记录。
function toToolLifecycleEvent(input: {
  fact: Extract<ConversationTelemetryFact, { kind: "tool.lifecycle" }>;
  toolId: string;
  inputId?: string;
  hasStarted: boolean;
}): ZCodeStreamEvent {
  const { fact } = input;
  const skillMetadata =
    fact.skillName || fact.skillQualifiedName || fact.skillPluginId || fact.skillSource
      ? {
          // 旧 CLI 的 scheduled 名称来自任意请求；只接受带解析来源的终态名称。
          ...(fact.skillName &&
          fact.skillSource &&
          (fact.phase === "completed" || fact.phase === "failed")
            ? { name: fact.skillName }
            : {}),
          ...(fact.skillQualifiedName ? { qualifiedName: fact.skillQualifiedName } : {}),
          ...(fact.skillPluginId ? { pluginId: fact.skillPluginId } : {}),
          ...(fact.skillSource ? { source: fact.skillSource } : {}),
        }
      : undefined;
  // 未开始且非终态时发 tool_call（新建）：进度类事件不创建记录，
  // 否则一次工具调用会在视图里被拆成「空壳 + 真身」两条。
  if (!input.hasStarted && fact.phase !== "completed" && fact.phase !== "failed") {
    return {
      type: "tool_call",
      taskId: fact.sessionId,
      traceId: fact.eventId,
      ...(input.inputId ? { inputId: input.inputId } : {}),
      toolId: input.toolId,
      parentToolUseId: fact.parentToolCallId,
      input: {},
      toolName: fact.toolName,
      kind: fact.toolName ?? "",
      title: "",
      raw: {},
      ...(skillMetadata ? { skillMetadata } : {}),
    } as Extract<ZCodeStreamEvent, { type: "tool_call" }>;
  }
  return {
    type: "tool_call_update",
    taskId: fact.sessionId,
    traceId: fact.eventId,
    ...(input.inputId ? { inputId: input.inputId } : {}),
    toolId: input.toolId,
    parentToolUseId: fact.parentToolCallId,
    // phase 用三元而非映射表，是为了让「未知 phase」默认落到 in_progress：
    // 提前标完成会让还在跑的工具被计入耗时统计，结论更差。
    status:
      fact.phase === "completed" ? "completed" : fact.phase === "failed" ? "failed" : "in_progress",
    toolName: fact.toolName,
    kind: fact.toolName,
    error: fact.errorMessage,
    raw: {},
    ...(skillMetadata ? { skillMetadata } : {}),
    ...(fact.pluginId
      ? { pluginMetadata: { pluginId: fact.pluginId, component: "mcp" as const } }
      : {}),
  } as Extract<ZCodeStreamEvent, { type: "tool_call_update" }>;
}

// 字段名在这里完成一次「协议词汇 → 旧 usage 词汇」的映射（cacheReadTokens → cachedInputTokens），
// 少映射一个就会出现 0：旧 builder 只读旧字段名，看不懂新协议，指标静默归零。
function toUsage(fact: Extract<ConversationTelemetryFact, { kind: "usage.delta" }>): ZCodeUsage {
  return {
    inputTokens: fact.inputTokens,
    outputTokens: fact.outputTokens,
    totalTokens: fact.totalTokens,
    reasoningTokens: fact.reasoningTokens,
    cachedInputTokens: fact.cacheReadTokens,
    cachedWriteInputTokens: fact.cacheWriteTokens,
  };
}

// 统一的 runtime 模型名口径：有 provider 时拼成 provider/model，已是带斜杠的全名则原样保留。
// 只在 model 存在时拼接——「provider/」这样的半截名字会被数仓当成另一个模型。
// provider 缺失时直接返回 model，而不是补成 "/model"：那会掩盖上游丢字段的问题。
function runtimeTelemetryModelName(providerId: string | undefined, modelId: string | undefined) {
  const provider = providerId?.trim() ?? "";
  const model = modelId?.trim() ?? "";
  if (!provider) return model;
  if (!model) return "";
  return model.includes("/") ? model : `${provider}/${model}`;
}

// usage 是「增量」而不是「累计」，因此同一子代理多次请求必须逐项相加；
// reasoning/cache 字段可能为 undefined，用 0 兜底而不是让整个表达式变成 NaN——
// NaN 一旦写进上报，数仓侧求和会污染整组数据。
function mergeUsage(left: ZCodeUsage | null, right: ZCodeUsage): ZCodeUsage {
  // 首条直接浅拷贝：不复用 right 引用，避免调用方后续修改 fact 对象时
  // 悄悄改到已累计的账本。
  if (!left) return { ...right };
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
    cachedWriteInputTokens:
      (left.cachedWriteInputTokens ?? 0) + (right.cachedWriteInputTokens ?? 0),
  };
}

// 超时判定同时看 errorCode 与 performance.timedOut：前者是工具层归类，后者是执行层事实，
// 只认一个会漏掉「执行器已超时但错误码被上层改写成 generic」的情况，
// 而超时是决定「要不要立即收口」而非等待迟到的 usage 的关键分支。
function isToolTimeout(
  fact: Extract<ConversationTelemetryFact, { kind: "tool.lifecycle" }>,
): boolean {
  return fact.errorCode === "tool_timeout" || fact.performance?.timedOut === true;
}

// interrupted 单独映射为 user_interrupt 而不是 fail：用户主动停止不是产品故障，
// 混进 fail 会把「用户取消率」算成「错误率」，掩盖真正的稳定性问题。
// success 之外的一切（error/timeout/cancelled）都归 fail，保证口径只有三态。
function terminalStatus(
  status: Extract<ConversationTelemetryFact, { kind: "turn.terminal" }>["status"],
): "success" | "fail" | "user_interrupt" {
  if (status === "success") return "success";
  return status === "interrupted" ? "user_interrupt" : "fail";
}

// detail 里的数字一律是字符串（ARMS 自定义事件只接受字符串），这里集中转回 number。
// 用 isFinite 而不是 !isNaN：Infinity 也会被 isNaN 放过，但上报后会变成 "Infinity"，
// 数仓侧聚合直接报错；非法值一律返回 undefined，由调用方决定跳过还是给默认值。
function finiteNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// 优先用 crypto.randomUUID：它的碰撞概率足以支撑「跨设备合并」；回退分支只是兜底，
// 时间戳 + 随机后缀在极端并发下仍可能重复，因此只在前者不可用时使用。
// 返回值必须在点击瞬间生成并随 seed 传递，不能在落定处再生成——那样配对必然失败。
function createSendClickId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `send_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
}

/**
 * renderer workspace 级 live telemetry 状态机。
 *
 * 它不读取 rows/snapshot，也不跟随 pane lease 销毁；React 只负责 attachment 和
 * foreground 引用，所有高频 fact 都进入这个命令式对象，避免 streaming 触发渲染。
 */
export class ConversationTelemetrySupervisor {
  private readonly platform: TelemetryPlatform;
  // workspace 维度在构造时冻结：远程工作区的 kind 可能随连接状态变化，
  // 但一条已开始的会话必须始终以「开始时的身份」上报，否则同一会话会被拆成两种口径。
  private readonly workspaceTelemetryDetail: ConversationTelemetryWorkspaceDetail | null;
  // scopeKey 参与每一个 taskKey 与去重键（INV-17）：多窗口共用一个 renderer 进程时，
  // 它是唯一能区分「同名 session 属于哪个工作区」的信息。
  private readonly workspaceScopeKey: string;
  // now 注入而不是直接调 Date.now：测试需要控制超时与 TTFT 的推进，
  // 硬编码时钟会让 30s 超时用例必须真等 30 秒。
  private readonly now: () => number;
  // 四个去重集合各自独立而不是共用一个：它们的键含义不同（事件/命令/点击/终态），
  // 合并后海量事件会加速淘汰点击键，导致重复落定。
  private readonly eventIds = new BoundedKeySet();
  private readonly acceptedCommandIds = new BoundedKeySet();
  private readonly settledSendClickIds = new BoundedKeySet();
  private readonly terminalKeys = new BoundedKeySet();
  private readonly compactionKeys = new BoundedKeySet();
  // 前景态用「owner 对象 → session」加「session → 引用计数」两张表：
  // 前者保证同一 pane 重复 attach 不重复计数，后者支持多 pane 同会话同时可见。
  private readonly foregroundOwnerSessions = new Map<object, string>();
  private readonly foregroundSessionCounts = new Map<string, number>();
  // 生命周期按 commandId 索引：commandId 是 ACK 与 fact 两侧都稳定的唯一锚点；
  // sessionId 在并发发送下会指向最新一条，无法承载多条在飞命令。
  private readonly lifecyclesByCommandId = new Map<string, PromptLifecycle>();
  // 两个反向索引服务于「事实不带 sourceCommandId」的情况：
  // turnId 精确、session 兜底。缺了它们，异步 fact 会被直接丢弃。
  private readonly activeCommandBySessionId = new Map<string, string>();
  private readonly commandIdByTurnKey = new Map<string, string>();
  private readonly pendingFactsByCommandId = new Map<string, BufferedFact[]>();
  // 前台子代理账本按 childSessionId 索引：事实到达时只带 sessionId，
  // 按 agentId 索引会让「同一 agent 并发多个子会话」互相覆盖。
  private readonly foregroundSubagentUsageByChildSession = new Map<
    string,
    ForegroundSubagentUsage
  >();
  /** 每个在飞 run 已登记的子代理会话（run-settled 时逐个结算）。 */
  private readonly workflowActorsByRun = new Map<string, Set<string>>();
  // 同一个 Map 承载 background 与 workflow 两种子代理，靠 kind 字段分流：
  // 拆成两张表会让「子会话事实该进哪张表」的判断分散到各处，容易漏。
  private readonly backgroundSubagentTelemetryByChildSession = new Map<
    string,
    BackgroundSubagentTelemetry
  >();
  // 被阻塞的终态：等待前台子代理收口后再结算，避免父轮次提前完成。
  private readonly deferredTerminalsByCommandId = new Map<string, DeferredTerminal>();
  private readonly pendingSendRenderWaits = new Map<string, PendingSendRenderWait>();
  // 串行化上报链的尾巴（INV-8）：只存 Promise，不存结果；
  // 完成即置空，避免长期持有一条已 resolve 的链导致内存无法释放。
  private reportTail: Promise<void> | null = null;
  // disposed 是所有入口的同步短路标志：卸载后到达的事实仍可能在事件循环里排队，
  // 没有这个检查就会继续写状态并发起上报。
  private disposed = false;

  constructor(options: {
    platform: TelemetryPlatform;
    workspaceScopeKey: string;
    workspaceTelemetryDetail?: ConversationTelemetryWorkspaceDetail;
    now?: () => number;
  }) {
    this.platform = options.platform;
    // detail 缺省为 null 而不是 {}：上报时用 null 判断「是否需要附加 workspace 维度」，
    // 空对象会让 withWorkspaceTelemetryDetail 拼出空键值对。
    this.workspaceTelemetryDetail = options.workspaceTelemetryDetail ?? null;
    // 不做 trim/规范化：scopeKey 是调用方生成的稳定标识，这里改写会与外部比较逻辑不一致。
    this.workspaceScopeKey = options.workspaceScopeKey;
    // 直接赋引用而不是包一层 `() => options.now()`：后者会拖延读取，
    // 测试里替换 options.now 就无法生效。
    this.now = options.now ?? Date.now;
  }

  // 这两条只写本地时间戳喂 send_btn 计算，不发任何网络请求：
  // 高频输入（每次按键）若直接上报，ARMS 事件量会被输入框放大两个数量级。
  recordComposerFocus(): void {
    // disposed 短路必须放在最前：卸载后仍可能有排队的事件回调进来，
    // 写进已清理的模块级时间戳会让下一个 supervisor 复用到旧值。
    if (this.disposed) return;
    recordComposerFocus(this.workspaceScopeKey, this.now());
  }

  // nextText 只用于判定「是否有实际输入」，因此不做截断或脱敏——
  // 用户正文不会离开本模块，下游只取长度与变更时刻。
  recordComposerTextChange(nextText: string): void {
    if (this.disposed) return;
    recordComposerTextChange(this.workspaceScopeKey, nextText, this.now());
  }

  /**
   * 用户真实点击/聚焦输入框。程序性自动聚焦（新建任务、切会话、挂载回焦、上下文块移除后回焦）
   * 由 composer 侧拦截，不得进入本方法，否则「点击输入框」会被切会话动作污染。
   * 与 recordComposerFocus 是两条独立链路：后者只写时间戳喂 send_btn，本方法只负责上报。
   */
  recordComposerFocusClick(input: { sessionId: string | null }): void {
    // sessionId 允许为 null（新建任务尚未有会话）：此时只报聚焦动作，
    // 若在这里临时生成一个 id，后续 send_click 的会话归属就对不上了。
    if (this.disposed) return;
    reportSendFunnelInputFocus({ sessionId: input.sessionId, focusTime: this.now() });
  }

  /**
   * 用户点击发送键 / Enter 提交并通过发送门禁的瞬间。返回补齐 sendClickId 的 seed，
   * 调用方需把它一路带到落定处，保证 send_click 与 send_result 严格 1:1。
   * 队列二次确认复用既有 seed 时不得再调本方法（否则一次点击报两条）。
   */
  recordSendClick(input: {
    sessionId: string | null;
    seed: ConversationPromptTelemetrySeed;
    trigger: "button" | "shortcut";
  }): ConversationPromptTelemetrySeed {
    // 只补 sendClickId，其余字段原样透传：seed 里的 sendTime/extraDetail 是点击瞬间的快照，
    // 在这里重新构造会引入「上报时读到的设置」与「点击时的设置」不一致。
    const seed: ConversationPromptTelemetrySeed = {
      ...input.seed,
      sendClickId: input.seed.sendClickId ?? createSendClickId(),
    };
    // disposed 时仍返回补齐后的 seed：调用方需要它继续走后续流程，
    // 直接返回 undefined 会让调用链出现空值分支。
    if (this.disposed) return seed;
    // 用 input.seed.sendTime 而非 now：send_cost_ms 的起点必须与后续 settle 的起点一致，
    // 否则同一次点击两段各自计时会得出互相矛盾的数字。
    reportSendFunnelSendClick({
      sessionId: input.sessionId,
      sendClickId: seed.sendClickId ?? "",
      sendTime: input.seed.sendTime,
      trigger: input.trigger,
      extraDetail: input.seed.extraDetail,
    });
    return seed;
  }

  /**
   * 发送落定（用户消息渲染完成、ACK 失败、产品 guard 拒绝、传输异常、等待渲染超时）。
   * 按 sendClickId first-wins 去重：ACK 与 catch 可能对同一次点击各调一次，只认最先到达的结果。
   */
  settleSendResult(input: {
    seed: ConversationPromptTelemetrySeed;
    sessionId: string | null;
    commandId?: string;
    status: "success" | "fail";
    ackStatus?: string;
    reasonCode?: ConversationSendFailureReason;
    /** 「点击发送 → 收到 ACK」那一段；未拿到 ACK 的失败路径不传。 */
    ackCostMs?: number;
    /** 覆盖端到端耗时；只有超时兜底会用（此时 now 已越过 30s 上限，需钉死在阈值上）。 */
    costMs?: number;
  }): void {
    if (this.disposed) return;
    const sendClickId = input.seed.sendClickId;
    // 后台自动任务的 seed 没有点击来源，落定不能伪造成用户发送。
    // 去重与写入在同一次 remember 里完成（INV-2）：先查后写若被并发调用穿插，
    // 两个调用可能都判定「未见」，各报一条 send_result。
    // remember 返回 false 时直接 return，这正是 first-wins 的实现点。
    if (!sendClickId || !this.settledSendClickIds.remember(sendClickId)) return;
    // costMs 允许外部覆盖（超时兜底），否则用 now - sendTime：
    // 超时场景下 now 已越过阈值，不钉死会得到 30001ms 这类不稳定数字。
    reportSendFunnelSendResult({
      sessionId: input.sessionId,
      commandId: input.commandId,
      sendClickId,
      status: input.status,
      ackStatus: input.ackStatus,
      reasonCode: input.reasonCode,
      costMs: input.costMs ?? this.now() - input.seed.sendTime,
      ackCostMs: input.ackCostMs,
      queueConfirmed: input.seed.queueConfirmed === true,
      extraDetail: input.seed.extraDetail,
    });
  }

  /**
   * ACK 已 accepted/duplicate：命令被 Host 收下了，但用户消息还没画到屏幕上。
   * 登记待渲染并挂超时定时器，等 notifyUserInputRendered 或超时任一先到再落定。
   */
  awaitSendRender(input: {
    seed: ConversationPromptTelemetrySeed;
    sessionId: string | null;
    commandId: string;
    ackStatus: string;
  }): void {
    if (this.disposed) return;
    // 后台自动任务无点击来源；同一 commandId 重复登记时保留首次（含其定时器）。
    if (!input.seed.sendClickId) return;
    if (this.pendingSendRenderWaits.has(input.commandId)) return;
    const ackCostMs = Math.max(0, this.now() - input.seed.sendTime);
    // 超时口径从点击发送起算，故剩余时长要扣掉已经花在 ACK 上的那一段。
    // clamp 到 0 是必要的：ACK 本身已超过 30s 时，负数的 setTimeout 会被当成 0，
    // 行为虽然相同，但显式 0 让「立即超时」这一路径在代码里可读。
    const remainingMs = Math.max(0, SEND_RENDER_WAIT_TIMEOUT_MS - ackCostMs);
    // 定时器回调里重新按 commandId 取一次 wait，而不是闭包捕获：期间可能已被
    // notifyUserInputRendered 删掉，靠这次查找才能正确跳过已落定的等待。
    const timer = setTimeout(() => {
      const wait = this.pendingSendRenderWaits.get(input.commandId);
      if (!wait) return;
      this.pendingSendRenderWaits.delete(input.commandId);
      this.settleSendResult({
        seed: wait.seed,
        sessionId: wait.sessionId,
        commandId: input.commandId,
        status: "fail",
        ackStatus: wait.ackStatus,
        reasonCode: "render_timeout",
        ackCostMs: wait.ackCostMs,
        costMs: SEND_RENDER_WAIT_TIMEOUT_MS,
      });
    }, remainingMs);
    this.pendingSendRenderWaits.set(input.commandId, {
      seed: input.seed,
      sessionId: input.sessionId,
      ackStatus: input.ackStatus,
      ackCostMs,
      timer,
    });
  }

  /**
   * 用户消息已渲染进对话历史（投影回流出 userInput row，且 React 完成 commit）。
   * 没登记过的 commandId 直接忽略——历史消息回填、切会话重载都会推一堆 row 过来。
   */
  notifyUserInputRendered(commandId: string): void {
    if (this.disposed) return;
    const wait = this.pendingSendRenderWaits.get(commandId);
    if (!wait) return;
    // 先删再落定：settleSendResult 内部也走 first-wins，但删掉登记可以避免
    // 之后迟到的 notifyUserInputRendered 再次命中这条等待。
    this.pendingSendRenderWaits.delete(commandId);
    // clearTimeout 与删除成对出现（INV-4）：只删不清理，定时器到点仍会执行，
    // 虽然找不到 wait 会安全返回，但会在卸载后继续占用一个计时器。
    clearTimeout(wait.timer);
    this.settleSendResult({
      seed: wait.seed,
      sessionId: wait.sessionId,
      commandId,
      status: "success",
      ackStatus: wait.ackStatus,
      ackCostMs: wait.ackCostMs,
    });
  }

  /** ACK=accepted 后才建立 seed；duplicate/retry/promotion 不会重复上报 send_btn。 */
  acceptPromptSeed(
    seed: AcceptedConversationPromptTelemetrySeed,
    options: { reportSendButton?: boolean } = {},
  ): void {
    // acceptedCommandIds 去重的是 commandId 而不是 seed 对象：duplicate ACK、retry、promotion
    // 会带着同一 sourceCommandId 再次进来，若这里放行，同一轮会有两条 send_btn 与两套生命周期。
    if (this.disposed || !this.acceptedCommandIds.remember(seed.sourceCommandId)) {
      return;
    }
    // taskKey 是 workspace + session 的组合（INV-17），后续所有模块级时间戳都以它为键，
    // 因此必须在这里算一次并贯穿整个生命周期，避免各处重复拼接产生不一致。
    const taskKey = this.taskKey(seed.sessionId);
    // memory_enabled 放在 seed.extraDetail 之后：三元结果必须是最终值，
    // 若放前面会被 seed 里可能存在的同名字段覆盖，出现「界面显示开启、上报为关」。
    const extraDetail = {
      ...seed.extraDetail,
      memory_enabled: seed.memoryEnabled === undefined ? "" : seed.memoryEnabled ? "1" : "0",
    };
    const eventExtraDetail = queuePromptTelemetry({
      workspacePath: this.workspaceScopeKey,
      taskId: taskKey,
      messageId: seed.sourceCommandId,
      sendTime: seed.sendTime,
      extraDetail,
    });
    // 生命周期初始 active=false：此时只有 ACK，还没有 TurnStarted。
    // 置成 true 会让首个 chunk 被当作「已激活轮次」处理，跳过缓冲导致 step 缺起点。
    this.lifecyclesByCommandId.set(seed.sourceCommandId, {
      sessionId: seed.sessionId,
      sourceCommandId: seed.sourceCommandId,
      taskKey,
      sendTime: seed.sendTime,
      foregroundFirstTokenAt: null,
      legacyFirstTokenObserved: false,
      active: false,
      completionMessageSource: seed.completionMessageSource,
      hasForegroundSubagentResult: false,
      hasBackgroundSubagentResult: false,
      hasWorkflowResult: false,
      startedToolCallIds: new Set(),
      stepSourceDetail: stepSourceDetailOf(extraDetail),
    });
    // 生命周期表也要封顶：它承载的生命周期对象比键大得多，无界增长比去重集合更危险。
    // 只淘汰「非 active」的最旧项：淘汰正在跑的轮次会让后续 fact 找不到锚点而被缓冲，
    // 表现为该轮指标永久缺失，比内存问题更不可接受。
    if (this.lifecyclesByCommandId.size > MAX_DEDUPE_KEYS) {
      const oldestInactive = [...this.lifecyclesByCommandId].find(
        ([commandId, lifecycle]) => commandId !== seed.sourceCommandId && !lifecycle.active,
      );
      if (oldestInactive) {
        this.lifecyclesByCommandId.delete(oldestInactive[0]);
        // 必须同步丢弃该轮的模块级队列与时间戳：只删本地表会让 messageTelemetry 里
        // 留下孤儿状态，之后同名 taskKey 复用时继承到旧数据。
        discardQueuedPromptTelemetry(oldestInactive[1].taskKey, oldestInactive[1].sourceCommandId);
      }
    }
    // reportSendButton=false 用于后台任务：它们没有用户点击，不能伪造 send_btn。
    // 用 !== false 而不是 === true，是为了让不传参的默认路径也上报。
    if (options.reportSendButton !== false) {
      this.enqueueReport({
        elementName: "send_btn",
        eventRegion: "app",
        eventType: "ck",
        eventExtraDetail,
        talkId: seed.sessionId,
        messageId: seed.sourceCommandId,
      });
    }
    // 最后再排空早到的缓冲：此时生命周期已建好，之前缓存的首批事实才有归属。
    // 顺序不能提前——先排空会因为 lifecyclesByCommandId 还没有条目而整批丢弃。
    this.drainPendingFacts(seed.sourceCommandId);
  }

  /** 同一 session 多 pane 可见仍只记一份 foreground；不同 session 可同时可见。 */
  attachForeground(owner: object, sessionId: string): () => void {
    // 已卸载时返回空函数而不是抛错：React 的清理函数可能在 dispose 之后才被调用，
    // 抛错会让卸载流程中断，掩盖真正的卸载原因。
    if (this.disposed) return () => undefined;
    const previous = this.foregroundOwnerSessions.get(owner);
    // 同一个 owner 重复 attach 同一 session 直接返回：不先减再加，
    // 否则计数会在 1/0 之间抖动，误触发一次「切后台」的 stall 清理。
    if (previous === sessionId) return () => this.detachForeground(owner);
    // owner 换 session 时必须先减旧再记新：反过来会让旧 session 的计数短暂偏高，
    // 这段时间到达的事实会被误判为前台，污染 TTFT 与 stall 统计。
    if (previous) this.decrementForeground(previous);
    this.foregroundOwnerSessions.set(owner, sessionId);
    this.foregroundSessionCounts.set(
      sessionId,
      (this.foregroundSessionCounts.get(sessionId) ?? 0) + 1,
    );
    // 返回幂等的 detach 闭包：React effect 的清理可能被调用一次，
    // 但同一 owner 也可能被不同 effect 各持有一次，detach 内部按 owner 查找保证重复调用安全。
    return () => this.detachForeground(owner);
  }

  handleFact(fact: ConversationTelemetryFact): void {
    // 主 session 与 detached child 的 eventId 都只保证各自 session 内唯一；
    // 若只按 eventId 去重，同号 child fact 会在 renderer 再次被主会话事实误杀。
    const eventKey = `${fact.sessionId}\0${fact.eventId}`;
    if (this.disposed || !this.eventIds.remember(eventKey)) {
      return;
    }
    const receivedAt = this.now();
    const foregroundAtReceipt = this.isForeground(fact.sessionId);

    // plan_request 只依赖真实模型网络事实，可前后台上报，也不要求本地 prompt seed。
    // 放在最前面是因为它不参与生命周期状态机，后面任何 return 都不应拦住这条指标。
    if (fact.kind === "model.request.status") {
      // 只做「发起」的上报，失败/成功由 messageTelemetry 侧按 eventId 自行关联，
      // 这里若也处理终态会与 prompt 生命周期里的同名逻辑重复计数。
      reportPlanUsageModelRequestStartedToArms(this.platform, toLegacyNetworkEvent(fact));
    }
    // 子代理/工作流的生命周期事实必须在「账本查找」之前分流：
    // 它们的 sessionId 正是账本的键，若先走查找会把自己当成子会话的普通事实。
    if (fact.kind === "subagent.lifecycle") {
      this.handleSubagentLifecycle(fact, receivedAt);
      return;
    }
    if (fact.kind === "workflow.lifecycle") {
      this.handleWorkflowLifecycle(fact, receivedAt);
      return;
    }
    // detached 子会话的事实走专用账本：它们的 sessionId 与父会话不同，
    // 用父会话的生命周期处理会找不到 commandId，最终被当成孤儿缓冲。
    const backgroundSubagent = this.backgroundSubagentTelemetryByChildSession.get(fact.sessionId);
    if (backgroundSubagent) {
      this.handleBackgroundSubagentFact(backgroundSubagent, fact, receivedAt);
      return;
    }
    // 镜像事实（同一事件在父/子两条流上各来一份）在这里被拦掉：
    // 放行会让一个工具调用产生两条 step，工具数与耗时分摊都会翻倍。
    if (this.shouldIgnoreBackgroundMirror(fact)) {
      return;
    }
    // 前台子代理账本同理，但它的 usage 只做累计、不单独上报 step，
    // 因此放在镜像过滤之后：被过滤的 mirror 不应污染累计值。
    const foregroundSubagent = this.foregroundSubagentUsageByChildSession.get(fact.sessionId);
    if (foregroundSubagent) {
      this.handleForegroundSubagentFact(foregroundSubagent, fact);
      return;
    }
    // compaction 独立于 prompt 生命周期：它描述上下文整理，可能发生在两轮之间，
    // 没有对应的 seed 或 turn，因此必须在 commandId 解析之前处理。
    if (fact.kind === "compaction.terminal") {
      this.handleCompaction(fact, foregroundAtReceipt);
      return;
    }
    if (fact.kind === "turn.started") {
      const backgroundSeed = backgroundSeedFromTurnStarted(fact);
      if (backgroundSeed) {
        // 原因：后台任务不经过 renderer ACK；用 Host admission 透传的无正文事实建 seed，
        // 但不能伪造只代表用户点击的 send_btn。
        this.acceptPromptSeed(
          { ...backgroundSeed, memoryEnabled: fact.memoryEnabled },
          { reportSendButton: false },
        );
      }
    }

    const commandId = this.resolveCommandId(fact);
    // 解析不到命令锚点就彻底丢弃：没有 commandId 既无法归属 step，也无法配对发送，
    // 强行落到「当前 active」会把这条事实算到无关的轮次上。
    if (!commandId) {
      return;
    }
    const lifecycle = this.lifecyclesByCommandId.get(commandId);
    // 上一轮终态被 defer 时，新 turn.started 必须继续阻塞（INV-15）：
    // 否则两轮的 step 会共用同一 messageId，token 与耗时互相覆盖。
    const blockedByDeferredTerminal =
      lifecycle !== undefined &&
      fact.kind === "turn.started" &&
      this.hasDeferredTerminalForTask(lifecycle.taskKey, lifecycle.sourceCommandId);
    // 三种「还不能处理」统一走缓冲（INV-12）：无生命周期、被终态阻塞、未激活。
    // 这里丢弃任何一类都会表现为「少量早期事实神秘消失」，而缓冲最多多占几 KB。
    if (
      !lifecycle ||
      blockedByDeferredTerminal ||
      (!lifecycle.active && fact.kind !== "turn.started")
    ) {
      this.bufferFact(commandId, { fact, receivedAt, foregroundAtReceipt });
      return;
    }
    this.processPromptFact(lifecycle, fact, receivedAt, foregroundAtReceipt);
    // turn.started 之后立刻排空：本轮激活前收到的事实此刻才具备处理条件，
    // 不在这里排空的话，它们要等到下一次事实到达才被处理，指标时间线整体后移。
    if (fact.kind === "turn.started") {
      this.drainPendingFacts(commandId);
    }
  }

  private handleSubagentLifecycle(
    fact: Extract<ConversationTelemetryFact, { kind: "subagent.lifecycle" }>,
    receivedAt: number,
  ): void {
    if (fact.phase === "spawned") {
      if (fact.background) {
        // 后台子代理必须有父命令与父工具调用两个锚点：缺任一都无法把汇总 step 挂回父轮次，
        // 强行上报会产生一条数仓里无人认领的孤儿记录。
        if (!fact.sourceCommandId || !fact.parentToolCallId) return;
        const parentLifecycle = this.lifecyclesByCommandId.get(fact.sourceCommandId);
        const child: BackgroundSubagentTelemetry = {
          kind: "background",
          parentSessionId: fact.sessionId,
          sourceCommandId: fact.sourceCommandId,
          parentToolCallId: fact.parentToolCallId,
          childSessionId: fact.childSessionId,
          agentId: fact.agentId,
          taskKey: this.taskKey(fact.childSessionId),
          // child 启动事实可能早于父消息 ACK；直接使用同源父会话事实，避免丢失开关。
          stepSourceDetail: parentLifecycle?.stepSourceDetail ?? {
            memory_enabled: fact.memoryEnabled === undefined ? "" : fact.memoryEnabled ? "1" : "0",
          },
          startedToolCallIds: new Set(),
          usageReported: false,
          openToolCallIds: new Set(),
          startedAt: this.now(),
          requestIds: [],
          requestCount: 0,
          usage: null,
          modelName: "",
          modelProvider: "",
          providerName: "",
        };
        this.backgroundSubagentTelemetryByChildSession.set(fact.childSessionId, child);
        // 登记账本后立即激活 detached step 通道：子会话的首个工具可能紧随 spawned 到达，
        // 晚一步激活就会让首批 step 找不到已激活的输入，被 messageTelemetry 丢弃。
        activateDetachedAgentStepTelemetry({
          taskId: child.taskKey,
          messageId: child.sourceCommandId,
          sendTime: fact.occurredAt,
          extraDetail: child.stepSourceDetail,
        });
        return;
      }
      // 前台子代理不建 detached 通道：它的 step 归到父 message 下，
      // 独立激活会让同一批工具在父/子两个 taskKey 上各算一次。
      if (!fact.parentToolCallId) return;
      // 用 resolveCommandId 而不是直接读 sourceCommandId：部分事实只带 turnId，
      // 这里必须走与 handleFact 相同的解析链，否则会漏掉一整类子代理。
      const parentCommandId = this.resolveCommandId(fact);
      if (!parentCommandId) return;
      const lifecycle = this.lifecyclesByCommandId.get(parentCommandId);
      // 父轮次未激活时直接放弃登记：此时没有可挂靠的 message，
      // 账本建了也永远不会被结算，只会占内存。
      if (!lifecycle?.active) return;
      const child: ForegroundSubagentUsage = {
        agentId: fact.agentId,
        parentCommandId,
        parentToolCallId: fact.parentToolCallId,
        requestIds: [],
        requestCount: 0,
        modelName: "",
        modelProvider: "",
        providerName: "",
        usage: null,
        stopped: false,
        pendingFinalizedSteps: [],
      };
      this.foregroundSubagentUsageByChildSession.set(fact.childSessionId, child);
      this.syncForegroundSubagentToolAttribution(child);
      return;
    }

    // 非 spawned 阶段一律视为终态：background 与 foreground 的账本形状不同，
    // 因此先用 childSessionId 精确匹配，再按 fact.background 决定结算方式，
    // 不能只看 fact.background——它描述来源，不描述我们是否登记过这个子会话。
    const backgroundChild = this.backgroundSubagentTelemetryByChildSession.get(fact.childSessionId);
    if (backgroundChild && fact.background) {
      this.reportBackgroundAgentUsage(backgroundChild, terminalOutcomeOf(fact), receivedAt);
      this.maybeCleanupBackgroundSubagentTelemetry(backgroundChild);
      return;
    }

    const child = this.foregroundSubagentUsageByChildSession.get(fact.childSessionId);
    if (!child) return;
    if (fact.background) {
      // 账本里记为 foreground、但终态标记为 background：说明配置在运行中变了，
      // 以终态为准标记 stopped，并放弃 attribution（false），避免把子代理 token 算进父轮次。
      child.stopped = true;
      this.reportPendingForegroundSubagentSteps(child, false);
      this.flushDeferredTerminal(child.parentCommandId);
      return;
    }
    // mirror 与 lifecycle 分属不同 event stream，stopped 之后仍可能收到已发出的 child tool
    // 终态。保留映射到父 message 收口，保证迟到工具仍能取得 child model 与 agent_id。
    this.syncForegroundSubagentToolAttribution(child);
    child.stopped = true;
    const lifecycle = this.lifecyclesByCommandId.get(child.parentCommandId);
    // 标记父轮次「消费过前台子代理结果」：agent_composition 需要它来区分
    // 「本轮只有主链」与「本轮包含子代理协作」，漏标会让 composition 统计偏少。
    if (lifecycle) lifecycle.hasForegroundSubagentResult = true;
    this.reportPendingForegroundSubagentSteps(child);
    this.flushDeferredTerminal(child.parentCommandId);
  }

  private handleForegroundSubagentFact(
    child: ForegroundSubagentUsage,
    fact: ConversationTelemetryFact,
  ): void {
    if (fact.kind === "model.request.status") {
      // 只认 model_request_started 来更新模型身份：failed/retried 帧里的 model 可能是
      // 回退模型或空值，写入会让整段子代理的模型归因漂移。
      if (fact.status !== "model_request_started") return;
      child.modelName = runtimeTelemetryModelName(fact.providerId, fact.modelId);
      child.modelProvider = fact.providerId;
      child.providerName = fact.providerHostname ?? "";
      this.syncForegroundSubagentToolAttribution(child);
      return;
    }
    if (fact.kind !== "usage.delta") return;

    // requestCount 每条 usage 都自增，而 requestIds 去重：两者口径刻意不同——
    // 前者是「发生过几次请求」（含失败重试），后者是「涉及几个唯一请求 id」，
    // 用前者替换后者会让单请求多次上报被统计成多个请求。
    child.usage = mergeUsage(child.usage, toUsage(fact));
    child.requestCount += 1;
    if (fact.requestId && !child.requestIds.includes(fact.requestId)) {
      child.requestIds.push(fact.requestId);
    }
    // Subagent 的 runtime model 在一次同步 Agent 调用内固定；usage fact 的 request identity
    // 比 spawned 配置更接近真实 provider 请求，因此到达时覆盖前一请求的同源值。
    if (fact.providerId || fact.modelId) {
      child.modelName = runtimeTelemetryModelName(fact.providerId, fact.modelId);
      child.modelProvider = fact.providerId ?? child.modelProvider;
      child.providerName = fact.providerHostname ?? child.providerName;
    }
    this.syncForegroundSubagentToolAttribution(child);
  }

  private syncForegroundSubagentToolAttribution(child: ForegroundSubagentUsage): void {
    const lifecycle = this.lifecyclesByCommandId.get(child.parentCommandId);
    // 父生命周期不活跃（尚未 turn.started 或已终结）时跳过：attribution 是往
    // 父 message 的账本里写回填值，没有活跃账本时写入无人消费，还会污染下一轮。
    if (!lifecycle?.active) return;
    // 传 taskKey 而不是 sessionId：messageTelemetry 内部以 taskKey 建索引，
    // 传 sessionId 会静默写入另一张表，表现为「归属字段永远为空」。
    recordSubagentToolAttribution({
      taskId: lifecycle.taskKey,
      toolCallId: child.parentToolCallId,
      requestIds: child.requestIds,
      requestCount: child.requestCount,
      modelName: child.modelName,
      modelProvider: child.modelProvider,
      providerName: child.providerName,
      agentId: child.agentId,
      ...(child.usage ? { usage: child.usage } : {}),
    });
  }

  private handleBackgroundSubagentFact(
    child: BackgroundSubagentTelemetry,
    fact: ConversationTelemetryFact,
    receivedAt: number,
  ): void {
    switch (fact.kind) {
      case "model.request.status":
        // 汇总上报之后不再接受模型请求事实：否则迟到帧会修改已冻结的身份，
        // 让「已落定的 step」与账本出现不一致。
        if (child.usageReported) return;
        recordPromptModelRequestStarted(child.taskKey, toLegacyNetworkEvent(fact));
        if (fact.status === "model_request_started") {
          child.modelName = runtimeTelemetryModelName(fact.providerId, fact.modelId);
          child.modelProvider = fact.providerId;
          child.providerName = fact.providerHostname ?? "";
        }
        return;
      case "usage.delta": {
        // 汇总后冻结 usage；汇总前则按 requestId 去重：同一次请求的 usage 可能被
        // 多条通道各推一次（正常流 + 重连补发），不去重会把 token 直接乘二。
        if (child.usageReported) return;
        if (fact.requestId && child.requestIds.includes(fact.requestId)) return;
        if (fact.requestId) child.requestIds.push(fact.requestId);
        // requestCount 不去重：即使 requestId 重复，也代表一次真实发生过的请求，
        // 它用于计算「平均每次请求 token」，需要偏保守的计数口径。
        child.requestCount += 1;
        child.usage = mergeUsage(child.usage, toUsage(fact));
        // usage 帧也带 model 信息，但只在缺失或明确给值时才覆盖：
        // 用 ?? 兜底保证不会把已识别的模型清空。
        if (fact.providerId || fact.modelId) {
          child.modelName = runtimeTelemetryModelName(fact.providerId, fact.modelId);
          child.modelProvider = fact.providerId ?? child.modelProvider;
          child.providerName = fact.providerHostname ?? child.providerName;
        }
        return;
      }
      case "stream.chunk":
        // 正文不进入 detached 账本：子代理的回复内容可能很长，
        // 而汇总只需要工具、token 与耗时；缓存正文会让内存随输出长度增长。
        return;
      case "tool.lifecycle":
        // 工具终态可能在 usage 汇总之后才到达（工具异步收尾），
        // 因此这里不按 usageReported 拦截，由 handleBackgroundToolLifecycle 自己判断排空。
        this.handleBackgroundToolLifecycle(child, fact, receivedAt);
        return;
      case "permission.lifecycle": {
        // 汇总后只处理「仍未收口」的工具：已 close 的工具再次请求权限说明是迟到帧，
        // 放行会让已上报的 step 在数仓里出现新的权限记录，前后矛盾。
        if (child.usageReported && !child.openToolCallIds.has(fact.toolCallId)) return;
        const toolCallId = scopedChildToolCallId(child, fact.toolCallId);
        const requestId = fact.requestId ?? fact.toolCallId;
        if (fact.phase === "requested") {
          recordPromptPermissionRequest({
            taskId: child.taskKey,
            requestId,
            toolCallId,
            now: receivedAt,
          });
        } else {
          recordPromptPermissionResponse({
            taskId: child.taskKey,
            requestId,
            now: receivedAt,
          });
        }
        return;
      }
      case "turn.terminal":
        // 工作流子代理会话承接多次 ask，每次 ask 是一个 turn：这里的终态只是一次 ask 结束，
        // 汇总 step 等 run-settled。
        if (child.kind === "workflow") return;
        // 先上报再清理：清理会删掉账本，顺序反了就拿不到 taskKey 与 usage。
        this.reportBackgroundAgentUsage(child, terminalOutcomeOf(fact), receivedAt);
        this.cleanupBackgroundSubagentTelemetry(child);
        return;
      case "turn.started":
      case "subagent.lifecycle":
      case "workflow.lifecycle":
      case "compaction.terminal":
        return;
    }
  }

  /**
   * 动态工作流子代理的登记与结算。与后台子代理共用同一本
   * detached 账本，差异只在登记事实、终态时机与 step 上的归属字段。
   */
  private handleWorkflowLifecycle(
    fact: Extract<ConversationTelemetryFact, { kind: "workflow.lifecycle" }>,
    receivedAt: number,
  ): void {
    if (fact.phase === "actor-spawned") {
      // 缺锚点（升级前的 run）或缺子会话身份：不猜测归属，不上报。
      if (!fact.sourceCommandId || !fact.childSessionId || !fact.agentId) return;
      // resume 会再发一遍 actor-created；同一子会话的账本只建一次。
      if (this.backgroundSubagentTelemetryByChildSession.has(fact.childSessionId)) return;
      const parentLifecycle = this.lifecyclesByCommandId.get(fact.sourceCommandId);
      const child: BackgroundSubagentTelemetry = {
        kind: "workflow",
        runId: fact.runId,
        parentSessionId: fact.sessionId,
        sourceCommandId: fact.sourceCommandId,
        parentToolCallId: fact.toolCallId ?? "",
        childSessionId: fact.childSessionId,
        agentId: fact.agentId,
        taskKey: this.taskKey(fact.childSessionId),
        // child 启动事实可能早于父消息 ACK；直接使用同源父会话事实，避免丢失开关。
        // 父生命周期缺失时用 memoryEnabled 兜底，三态编码成 "1"/"0"/""：
        // 空串表示未知，写成 "0" 会把「没读到」误判成「明确关闭」。
        stepSourceDetail: parentLifecycle?.stepSourceDetail ?? {
          memory_enabled: fact.memoryEnabled === undefined ? "" : fact.memoryEnabled ? "1" : "0",
        },
        startedToolCallIds: new Set(),
        usageReported: false,
        openToolCallIds: new Set(),
        startedAt: this.now(),
        requestIds: [],
        requestCount: 0,
        usage: null,
        modelName: "",
        modelProvider: "",
        providerName: "",
      };
      this.backgroundSubagentTelemetryByChildSession.set(fact.childSessionId, child);
      // 按 run 归集子会话（INV-6）：run-settled 时要逐个结算这些子代理，
      // 缺这张表就只能依赖「子会话自己上报终态」，而工作流子代理不会转发 turn.terminal。
      const siblings = this.workflowActorsByRun.get(fact.runId) ?? new Set<string>();
      siblings.add(fact.childSessionId);
      this.workflowActorsByRun.set(fact.runId, siblings);
      activateDetachedAgentStepTelemetry({
        taskId: child.taskKey,
        messageId: child.sourceCommandId,
        sendTime: fact.occurredAt,
        extraDetail: child.stepSourceDetail,
      });
      return;
    }

    // run-settled：该 run 全部子代理的终态。每个子代理一条汇总 step，然后排空迟到工具终态后清理。
    // 先删 run 映射再遍历：结算过程中若有事件触发重入（tool 终态同步排空），
    // 已经删掉的映射能防止同一 run 被重复结算。
    const actors = this.workflowActorsByRun.get(fact.runId);
    if (!actors) return;
    this.workflowActorsByRun.delete(fact.runId);
    for (const childSessionId of actors) {
      const child = this.backgroundSubagentTelemetryByChildSession.get(childSessionId);
      // 账本缺失说明该子代理已单独收口（例如先收到了自己的终态），跳过而不是重建：
      // 重建会得到 usageReported=false 的新对象，凭空多报一条汇总。
      if (!child) continue;
      // status===completed 才算成功，其余（failed/cancelled）统一失败：
      // 工作流 run 的终态词表比子代理更多，这里做的是显式收窄。
      this.reportBackgroundAgentUsage(
        child,
        {
          eventId: fact.eventId,
          success: fact.status === "completed",
          ...(fact.errorMessage === undefined ? {} : { errorMessage: fact.errorMessage }),
        },
        receivedAt,
      );
      this.maybeCleanupBackgroundSubagentTelemetry(child);
    }
  }

  private reportBackgroundAgentUsage(
    child: BackgroundSubagentTelemetry,
    outcome: DetachedChildTerminalOutcome,
    receivedAt: number,
  ): void {
    // Bug 根因：只等 child terminal 会漏掉准备阶段失败/取消；stopped 也必须结算。
    // 对齐 foreground 的已知 usage 快照：首个终态只报一次，后续不补算迟到 usage。
    if (child.usageReported) return;
    child.usageReported = true;
    // 无 usage 不代表调用未发生；真实终态仍上报，缺失 token 沿用 foreground builder 的零值。
    // toolId 用「作用域前缀 + 终态锚点」：run-settled 时多个子代理共享同一个 eventId，
    // 若 id 相同，vis/数仓侧会把它们当成同一个 step 互相覆盖。
    const toolId = scopedChildToolCallId(child, terminalToolCallIdOf(child));
    // Bug 根因：后台只报内部工具并丢弃 usage，缺少 foreground 外层 Agent 的 token owner。
    // 在 child 终态用共享 builder 结算一次；内部工具继续逐条上报，避免重复计算同一份 token。
    recordAgentStepTelemetryEvent({
      taskId: child.taskKey,
      event: {
        type: "tool_call",
        taskId: child.childSessionId,
        traceId: outcome.eventId,
        toolId,
        toolName: "Agent",
        kind: "Agent",
        input: {},
        title: "Agent",
        raw: {},
      },
      now: child.startedAt,
    });
    recordSubagentToolAttribution({
      taskId: child.taskKey,
      toolCallId: toolId,
      agentId: child.agentId,
      agentRole: childAgentRole(child),
      requestIds: child.requestIds,
      requestCount: child.requestCount,
      modelName: child.modelName,
      modelProvider: child.modelProvider,
      providerName: child.providerName,
      ...(child.usage ? { usage: child.usage } : {}),
    });
    // 两段事件共用 toolId：先 tool_call 建立记录，再 tool_call_update 落终态。
    // 只发 update 时旧视图会缺记录；只发 call 则永远不会完成，耗时统计卡在进行中。
    const finalized = recordAgentStepTelemetryEvent({
      taskId: child.taskKey,
      event: {
        type: "tool_call_update",
        taskId: child.childSessionId,
        traceId: outcome.eventId,
        toolId,
        toolName: "Agent",
        kind: "Agent",
        raw: {},
        status: outcome.success ? "completed" : "failed",
        error: outcome.errorMessage,
      },
      now: receivedAt,
    });
    this.reportBackgroundFinalizedSteps(child, finalized, childStepExtraDetail(child));
  }

  private handleBackgroundToolLifecycle(
    child: BackgroundSubagentTelemetry,
    fact: Extract<ConversationTelemetryFact, { kind: "tool.lifecycle" }>,
    receivedAt: number,
  ): void {
    // stopped 后仅排空已经开始的工具，避免重放/迟到事件重新创建已收口的 step。
    if (child.usageReported && !child.openToolCallIds.has(fact.toolCallId)) return;
    // hasStarted 在 add 之前读取：tool_call 与 tool_call_update 的区分依赖「本次是否是首帧」，
    // 顺序反了会让所有帧都变成 update，首条记录永远不出现。
    const hasStarted = child.startedToolCallIds.has(fact.toolCallId);
    child.startedToolCallIds.add(fact.toolCallId);
    // openToolCallIds 与 startedToolCallIds 语义不同：前者是「还没终态」，
    // 后者是「曾经开始过」。合并会让迟到的终态被当成新工具重新开一个 step。
    const isTerminal = fact.phase === "completed" || fact.phase === "failed";
    if (isTerminal) {
      child.openToolCallIds.delete(fact.toolCallId);
    } else {
      child.openToolCallIds.add(fact.toolCallId);
    }
    const finalized = recordAgentStepTelemetryEvent({
      taskId: child.taskKey,
      event: toToolLifecycleEvent({
        fact,
        toolId: scopedChildToolCallId(child, fact.toolCallId),
        hasStarted,
      }),
      clientMode: "desktop-continuous",
      toolAttribution: {
        agentId: child.agentId,
        agentRole: childAgentRole(child),
      },
      now: receivedAt,
    });
    // automation_id 追加在最后：它来自事实本身而不是子代理来源，
    // 放在前面会被 childStepExtraDetail 的同名字段覆盖，导致自动化任务无法区分子代理。
    const extraDetail = {
      ...childStepExtraDetail(child),
      ...(fact.automationId ? { automation_id: fact.automationId } : {}),
    };
    this.reportBackgroundFinalizedSteps(child, finalized, extraDetail);
    // 只有终态才尝试清理：中间进度帧清掉账本会让后续 usage 无处可记。
    if (isTerminal) this.maybeCleanupBackgroundSubagentTelemetry(child);
  }

  private reportBackgroundFinalizedSteps(
    child: BackgroundSubagentTelemetry,
    finalized: ReturnType<typeof recordAgentStepTelemetryEvent>,
    extraDetail: Record<string, string>,
  ): void {
    for (const step of finalized) {
      // 顺序固定为「来源 → step 自带 → 调用方追加」，后者优先级最高：
      // 反过来的话自动化/终态等本轮特有字段会被通用来源字段覆盖。
      this.enqueueReport({
        elementName: "agent_step",
        eventRegion: "app",
        eventType: "agent_trace",
        eventExtraDetail: this.withWorkspaceTelemetryDetail({
          ...child.stepSourceDetail,
          ...step.eventExtraDetail,
          ...extraDetail,
        }),
        talkId: child.parentSessionId,
        messageId: child.sourceCommandId,
      });
    }
  }

  private cleanupBackgroundSubagentTelemetry(child: BackgroundSubagentTelemetry): void {
    // 先丢模块级队列再删本地账本：discard 需要 child.taskKey，账本删了就取不到；
    // 反过来顺序虽然也能工作，但一旦 discard 抛错就会留下无法再访问的账本。
    discardPromptTelemetry(child.taskKey);
    this.backgroundSubagentTelemetryByChildSession.delete(child.childSessionId);
  }

  private maybeCleanupBackgroundSubagentTelemetry(child: BackgroundSubagentTelemetry): void {
    // 汇总上报与工具排空分开：stopped 不再丢汇总，也不丢已开始工具的迟到终态。
    // 两个条件必须同时满足：usageReported 保证汇总发过，openToolCallIds 为空保证
    // 没有进行中的工具——只满足一个就清理会让另一项永久丢失。
    if (child.usageReported && child.openToolCallIds.size === 0) {
      this.cleanupBackgroundSubagentTelemetry(child);
    }
  }

  private reportPendingForegroundSubagentSteps(
    child: ForegroundSubagentUsage,
    applyAttribution = true,
  ): void {
    const lifecycle = this.lifecyclesByCommandId.get(child.parentCommandId);
    if (!lifecycle?.active) return;
    // splice(0) 一次性取走并清空队列：边遍历边清理会因为回调里再次 push 变成死循环，
    // 而且取走后再上报，即使上报抛错也不会重复上报同一批 step。
    for (const pending of child.pendingFinalizedSteps.splice(0)) {
      // applyAttribution=false 用于「配置中途改为后台」的场景：此时 token 已归到子会话，
      // 再回填到父 message 会让同一份 token 被统计两次。
      if (applyAttribution) this.applyForegroundSubagentAttribution(pending.step, child);
      this.reportFinalizedSteps(lifecycle, [pending.step], pending.extraDetail);
    }
  }

  private applyForegroundSubagentAttribution(
    step: FinalizedAgentStep,
    child: ForegroundSubagentUsage,
  ): void {
    // 直接改写 step.eventExtraDetail 而不是复制：step 尚未上报（在 pending 队列里），
    // 原地补字段可以保证后续 reportFinalizedSteps 读到同一份对象；复制会让改动丢失。
    const detail = step.eventExtraDetail;
    detail.agent_id = child.agentId;
    // 只有拿到模型信息才写三个字段：空串会覆盖父轮次已有的模型归属，
    // 让「子代理未上报模型」退化成「模型未知」。
    if (child.modelName || child.modelProvider || child.providerName) {
      detail.model_name = legacyTelemetryModelValue(child.modelName);
      detail.model_provider = legacyTelemetryProviderId(child.modelProvider);
      detail.provider_name = child.providerName;
    }
    // 没有 usage 时提前返回：model_request_id 等字段无处可写，
    // 留空会让数仓把它当作「有请求但零 token」的异常样本。
    if (!child.usage) return;
    // 单请求才写 requestId，多请求写空串：多个 id 用逗号拼起来无法被数仓正确拆分，
    // 而 request_count 已经表达了「发生了几次」。
    detail.model_request_id = child.requestIds.length === 1 ? (child.requestIds[0] ?? "") : "";
    detail.model_request_count = String(child.requestCount);
    detail.token_usage_scope = "subagent_requests";
    detail.input_tokens = String(child.usage.inputTokens);
    detail.output_tokens = String(child.usage.outputTokens);
    detail.reasoning_tokens = String(child.usage.reasoningTokens ?? 0);
    detail.cached_tokens = String(child.usage.cachedInputTokens ?? 0);
    detail.cache_write_input_tokens = String(child.usage.cachedWriteInputTokens ?? 0);
    detail.total_tokens = String(child.usage.totalTokens);
  }

  private flushDeferredTerminal(commandId: string): void {
    const deferred = this.deferredTerminalsByCommandId.get(commandId);
    // 仍有未 stopped 的前台子代理时必须继续等待：父轮次的终态若先落定，
    // 子代理后续上报的 step 会挂到一个「已完成」的 message 上，指标时序倒置。
    if (
      !deferred ||
      [...this.foregroundSubagentUsageByChildSession.values()].some(
        (child) => child.parentCommandId === commandId && !child.stopped,
      )
    ) {
      return;
    }
    // 先删再处理：handleTerminal 内部可能同步触发新的终态判断，
    // 保留映射会让它被重复取到并二次上报。
    this.deferredTerminalsByCommandId.delete(commandId);
    this.handleTerminal(
      deferred.lifecycle,
      deferred.fact,
      deferred.receivedAt,
      deferred.foregroundAtReceipt,
    );
  }

  reportVisibleChatError(params: {
    surface?: ChatErrorBannerSurface;
    errorKey?: string | null;
    displayMessage: string;
    error: ZCodeUiError;
  }): void {
    // disposed 时静默返回：错误横幅可能在卸载动画期间才上报，
    // 此时继续上报会把「用户已经离开」记成一次错误曝光。
    if (this.disposed) return;
    // 用 void 而不是 await：入口是同步 API，上报失败不应阻塞 UI 的错误展示；
    // 恢复动作在这里现算，而不是让调用方传，保证与 error 对象始终对应。
    void reportChatErrorBannerTelemetry(this.platform, {
      ...params,
      providerBusinessRecoveryAction: resolveVisibleChatErrorTelemetryRecoveryAction(params.error),
    });
  }

  /** 仅供有界缓存单测观察；业务逻辑不依赖此值。 */
  getPendingCommandCountForTest(): number {
    return this.pendingFactsByCommandId.size;
  }

  /** 仅供 focused tests 等待串行 reporter 清空。 */
  async flushReportsForTest(): Promise<void> {
    await this.reportTail;
  }

  dispose(): void {
    // 幂等：React 严格模式下 effect 会挂载-卸载-再挂载，dispose 可能被调用两次，
    // 第二次执行会重复 discard，让新实例的模块级状态被误清。
    if (this.disposed) return;
    this.disposed = true;
    // 先清模块级状态再清本地表：discard 需要 taskKey，顺序反了就得额外保存一份键。
    for (const lifecycle of this.lifecyclesByCommandId.values()) {
      clearStreamStallTracking(lifecycle.taskKey);
      discardPromptTelemetry(lifecycle.taskKey);
    }
    for (const child of this.backgroundSubagentTelemetryByChildSession.values()) {
      discardPromptTelemetry(child.taskKey);
    }
    // 待渲染的定时器不清会在卸载后继续跑，落定一批没有意义的 render_timeout。
    for (const wait of this.pendingSendRenderWaits.values()) {
      clearTimeout(wait.timer);
    }
    this.pendingSendRenderWaits.clear();
    // 五个去重集合必须逐个 clear：漏掉任何一个，热重载后的新实例会把上一轮的事件
    // 当成重复直接丢弃，表现为「刷新后指标全空」。
    this.eventIds.clear();
    this.acceptedCommandIds.clear();
    this.settledSendClickIds.clear();
    this.terminalKeys.clear();
    this.compactionKeys.clear();
    this.foregroundSubagentUsageByChildSession.clear();
    this.backgroundSubagentTelemetryByChildSession.clear();
    this.workflowActorsByRun.clear();
    this.deferredTerminalsByCommandId.clear();
    this.foregroundOwnerSessions.clear();
    this.foregroundSessionCounts.clear();
    this.lifecyclesByCommandId.clear();
    this.activeCommandBySessionId.clear();
    this.commandIdByTurnKey.clear();
    this.pendingFactsByCommandId.clear();
  }

  private enqueueReport(payload: Parameters<typeof reportAppTelemetryEvent>[1]): void {
    const report = () =>
      reportAppTelemetryEvent(this.platform, payload, "v4-conversation-telemetry");
    // 修复原因：renderer 发起顺序虽然是 step → completion，但两个异步 IPC 会在 main
    // 并发执行，最终 net.fetch 偶发反序。workspace supervisor 内串行化最终 reporter，
    // 同时保持第一条立即发起，避免额外推迟 send_btn。
    const queued = this.reportTail ? this.reportTail.then(report) : report();
    // 尾指针更新在发起之后：report() 是同步调用，可能已经抛错，
    // 先赋值会让链上留一个已 reject 的 Promise，后续入队全部被跳过。
    this.reportTail = queued;
    // 只在仍是队尾时置空（INV-9）：并发入队时前一条的清理会误清后一条的链尾，
    // 那样串行化就断了，重新出现反序上报。
    void queued.then(() => {
      if (this.reportTail === queued) this.reportTail = null;
    });
  }

  private withWorkspaceTelemetryDetail(detail: Record<string, string>): Record<string, string> {
    // workspace 字段放后面覆盖：它是维度而不是业务字段，同名字段必须以工作区为准，
    // 否则一条来自子会话的自定义字段就能改写整份上报的工作区归属。
    return this.workspaceTelemetryDetail ? { ...detail, ...this.workspaceTelemetryDetail } : detail;
  }

  private taskKey(sessionId: string): string {
    // 用 \u0000 而不是 `:` 或 `|` 分隔：sessionId 与 scopeKey 都可能含可见分隔符，
    // 一旦拼接结果碰撞，两个不同会话的队列会被当成同一个，指标互相覆盖。
    return `${this.workspaceScopeKey}\u0000${sessionId}`;
  }

  private isForeground(sessionId: string): boolean {
    // 以引用计数 > 0 判断（INV-10）：多 pane 同时显示同一会话时，关闭其中一个 pane
    // 不应判定为切后台，计数保证只有最后一个可见者离开才算真正切走。
    return (this.foregroundSessionCounts.get(sessionId) ?? 0) > 0;
  }

  private shouldIgnoreBackgroundMirror(fact: ConversationTelemetryFact): boolean {
    // 只对两类可能被双发的事实做镜像判断：其他事实（usage/turn）不经过子会话镜像，
    // 在它们上面加条件会误杀父会话自己的正常事实。
    if (fact.kind !== "tool.lifecycle" && fact.kind !== "permission.lifecycle") return false;
    // 两个条件同时成立才丢：background=true 但已是前台账本的子会话（说明镜像与真实
    // 流混在一起），此时必须保留，否则该子代理的工具记录会整段缺失。
    return (
      fact.background === true &&
      (!fact.childSessionId || !this.foregroundSubagentUsageByChildSession.has(fact.childSessionId))
    );
  }

  private detachForeground(owner: object): void {
    const sessionId = this.foregroundOwnerSessions.get(owner);
    // 找不到 owner 说明已 detach 过：直接返回而不是抛错，
    // 因为 React 清理函数可能因双调用被触发两次。
    if (!sessionId) return;
    this.foregroundOwnerSessions.delete(owner);
    this.decrementForeground(sessionId);
  }

  private decrementForeground(sessionId: string): void {
    // 缺省按 1 计算而不是 0：若这里读到 undefined，说明计数已被清理，
    // 再减会得到 -1 并写入负数，之后所有 isForeground 判断都会失真。
    const next = (this.foregroundSessionCounts.get(sessionId) ?? 1) - 1;
    if (next > 0) {
      this.foregroundSessionCounts.set(sessionId, next);
      return;
    }
    this.foregroundSessionCounts.delete(sessionId);
    // 切走期间的墙钟时间不能被下一次回前台误判为 stream stall。
    clearStreamStallTracking(this.taskKey(sessionId));
  }

  private resolveCommandId(fact: ConversationTelemetryFact): string | undefined {
    // 三级解析，精度依次下降：显式 commandId > turnId 映射 > 会话内 active。
    // 之所以保留最后的会话兜底，是因为部分旧版 fact 既无 commandId 也无 turnId，
    // 直接丢弃会让这些机器的指标完全缺失，而落到当前 active 至少保证大概率正确。
    if (fact.sourceCommandId) return fact.sourceCommandId;
    // turnId 键必须带 sessionId 前缀：turnId 只在会话内唯一，
    // 不同会话的同名 turn 会互相命中，把事实算到别人的轮次上。
    return fact.turnId
      ? this.commandIdByTurnKey.get(`${fact.sessionId}\u0000${fact.turnId}`)
      : this.activeCommandBySessionId.get(fact.sessionId);
  }

  private bufferFact(commandId: string, buffered: BufferedFact): void {
    const current = this.pendingFactsByCommandId.get(commandId) ?? [];
    current.push(buffered);
    // 单命令超限时的淘汰顺序是硬性要求（INV-13）：普通 chunk 先丢，
    // 其次才轮到非 turn.started 的项，turn.started 永远最后（实际上不会被选中）。
    if (current.length > MAX_BUFFERED_FACTS_PER_COMMAND) {
      // ACK 极慢时只优先裁普通后续 chunk；turn.started、firstChunk、真实模型状态、工具和
      // terminal 都是旧指标的生命周期锚，不能被高频正文挤掉。
      const ordinaryChunkIndex = current.findIndex(
        (item) => item.fact.kind === "stream.chunk" && !item.fact.firstChunk,
      );
      const removableIndex =
        ordinaryChunkIndex >= 0
          ? ordinaryChunkIndex
          : current.findIndex((item) => item.fact.kind !== "turn.started");
      current.splice(removableIndex >= 0 ? removableIndex : 0, 1);
    }
    // Map 的插入顺序即 LRU：命中 command 时先删除再写回，保证最久未收到事实的整组先淘汰。
    // 若省略 delete，重复写入不会改变顺序，缓冲命令表就退化成 FIFO，
    // 活跃命令可能因为「插入早」而被优先清掉。
    this.pendingFactsByCommandId.delete(commandId);
    this.pendingFactsByCommandId.set(commandId, current);
    // 命令数上限的淘汰只看「最久未活动」，不区分是否含 turn.started：
    // 超过 200 个命令同时等待已经说明 Host 异常，此时保住内存优先。
    if (this.pendingFactsByCommandId.size > MAX_BUFFERED_COMMANDS) {
      const oldestCommandId = this.pendingFactsByCommandId.keys().next().value;
      if (typeof oldestCommandId === "string") {
        this.pendingFactsByCommandId.delete(oldestCommandId);
      }
    }
  }

  private drainPendingFacts(commandId: string): void {
    const lifecycle = this.lifecyclesByCommandId.get(commandId);
    const pending = this.pendingFactsByCommandId.get(commandId);
    // 三者任一为空都无事可做：没有生命周期时排空会再次触发缓冲，形成无意义往返。
    if (!lifecycle || !pending || pending.length === 0) return;
    // 先删再遍历：遍历过程中 bufferFact 会重新写回本命令，
    // 若不先删，旧数组会与新写入的条目混在一起，导致同一事实被处理两次。
    this.pendingFactsByCommandId.delete(commandId);
    for (const item of pending) {
      // 每轮都重新确认生命周期存在：processPromptFact 内部可能因终态清理把它删掉，
      // 继续处理剩余条目会写入一个已经结束的轮次。
      if (!this.lifecyclesByCommandId.has(commandId)) return;
      // turn.started 遇到同 task 的 deferred terminal 时重新入缓冲（INV-15），
      // continue 而不是 break：后面可能还有可以处理的事实。
      if (
        item.fact.kind === "turn.started" &&
        this.hasDeferredTerminalForTask(lifecycle.taskKey, lifecycle.sourceCommandId)
      ) {
        this.bufferFact(commandId, item);
        continue;
      }
      // 未激活时非 turn.started 条目回缓冲：这条分支是「缓冲 → 排空 → 再缓冲」的
      // 稳定收敛点，不会无限循环，因为排空只在 turn.started 之后被调用。
      if (!lifecycle.active && item.fact.kind !== "turn.started") {
        this.bufferFact(commandId, item);
        continue;
      }
      this.processPromptFact(lifecycle, item.fact, item.receivedAt, item.foregroundAtReceipt);
    }
  }

  private hasDeferredTerminalForTask(taskKey: string, exceptCommandId?: string): boolean {
    // 按 taskKey（工作区 + 会话）而不是 commandId 比较：同一会话里上一个命令的
    // deferred terminal 必须能阻塞下一个命令，否则日志相继的两轮会交叉污染。
    // exceptCommandId 排除自身，避免本命令的终态阻塞自己的 turn.started。
    return [...this.deferredTerminalsByCommandId].some(
      ([commandId, deferred]) =>
        commandId !== exceptCommandId && deferred.lifecycle.taskKey === taskKey,
    );
  }

  private drainPromptBlockedByDeferredTerminal(taskKey: string): void {
    // 本 task 仍有 deferred terminal 时不做任何事：此刻放行会让新一轮抢先激活，
    // 上一轮的终态结算就会挂到新一轮的 message 上。
    if (this.hasDeferredTerminalForTask(taskKey)) return;
    // 只挑「已缓冲 turn.started 且尚未激活」的下一个命令，并按 sendTime 取最早：
    // 同一会话可能连续排了多条 seed，必须按用户发送顺序激活，否则指标时间线会错序。
    const nextLifecycle = [...this.lifecyclesByCommandId.values()]
      .filter(
        (candidate) =>
          candidate.taskKey === taskKey &&
          !candidate.active &&
          this.pendingFactsByCommandId
            .get(candidate.sourceCommandId)
            ?.some((item) => item.fact.kind === "turn.started"),
      )
      .sort((left, right) => left.sendTime - right.sendTime)[0];
    if (nextLifecycle) this.drainPendingFacts(nextLifecycle.sourceCommandId);
  }

  private processPromptFact(
    lifecycle: PromptLifecycle,
    fact: ConversationTelemetryFact,
    receivedAt: number,
    foregroundAtReceipt: boolean,
  ): void {
    switch (fact.kind) {
      case "turn.started":
        // 激活是这一步的核心副作用：所有后续 handler 都以 lifecycle.active 作为
        // 「能否直接处理」的门槛，因此必须最先置位。
        lifecycle.active = true;
        lifecycle.turnId = fact.turnId;
        // 两个反向索引在同一处写入：只写其中一个会让「带 turnId 的事实」与
        // 「只带 session 的事实」解析到不同命令，出现同一轮被拆成两套记录。
        this.activeCommandBySessionId.set(fact.sessionId, lifecycle.sourceCommandId);
        if (fact.turnId) {
          this.commandIdByTurnKey.set(
            `${fact.sessionId}\u0000${fact.turnId}`,
            lifecycle.sourceCommandId,
          );
        }
        // 末尾激活模块级队列：必须在本地索引都就绪之后，否则首个 chunk 触发时
        // messageTelemetry 还找不到对应 message。
        activatePromptTelemetry(lifecycle.taskKey, lifecycle.sourceCommandId);
        return;

      case "model.request.status": {
        // 网络状态只做旁路记录，不改变生命周期：
        // 模型请求失败不等于整轮失败，重试后仍可能成功，提前收口会漏报。
        const legacyEvent = toLegacyNetworkEvent(fact);
        recordPromptModelRequestStarted(lifecycle.taskKey, legacyEvent, lifecycle.sourceCommandId);
        // 失败原因先暂存到 lifecycle，等终态时作为兜底错误信息——
        // 终态自身可能不带 message，只带 code，不留这份就会丢掉最有用的描述。
        if (fact.status === "model_request_failed") {
          lifecycle.lastErrorMessage = fact.reason;
        }
        return;
      }

      case "stream.chunk": {
        // legacyFirstTokenObserved 与 foregroundFirstTokenAt 分开记：
        // 前者只要有 chunk 就成立（用于后台/历史会话的 TTFT 兜底），
        // 后者只在前台到达时记录（用于真实用户体感），混用会让后台时间污染 TTFT。
        lifecycle.legacyFirstTokenObserved = true;
        if (foregroundAtReceipt && lifecycle.foregroundFirstTokenAt === null) {
          lifecycle.foregroundFirstTokenAt = receivedAt;
        }
        // content 固定为空串：旧 builder 只关心「有 chunk」这一事实与渠道，
        // 传正文会让上报体随回复长度膨胀，而正文另有隐私风险。
        const legacyEvent = {
          type: fact.channel === "thought" ? "agent_thought_chunk" : "agent_message_chunk",
          taskId: fact.sessionId,
          traceId: fact.eventId,
          inputId: lifecycle.sourceCommandId,
          content: "",
          ...(fact.channel === "text" && fact.assistantMessageId
            ? { messageId: fact.assistantMessageId }
            : {}),
          ...(fact.parentToolCallId ? { parentToolUseId: fact.parentToolCallId } : {}),
        } as Extract<ZCodeStreamEvent, { type: "agent_thought_chunk" | "agent_message_chunk" }>;
        this.reportFinalizedSteps(
          lifecycle,
          recordAgentStepTelemetryEvent({
            taskId: lifecycle.taskKey,
            event: legacyEvent,
            activeInputId: lifecycle.sourceCommandId,
            clientMode: "desktop-continuous",
            now: receivedAt,
          }),
        );
        if (foregroundAtReceipt) {
          // stall 监测只在真正前台推进：后台期间的静默不应该被算成用户等待，
          // 这正是 INV-11 的实现点。
          recordStreamChunkArrival(lifecycle.taskKey, {
            now: receivedAt,
            talkId: fact.sessionId,
            waitingTool: false,
            model: getActivePromptModelName(lifecycle.taskKey),
            messageId: fact.assistantMessageId,
            chunkType: fact.channel === "thought" ? "thought" : "message",
          });
        }
        return;
      }

      case "tool.lifecycle":
        this.handleToolLifecycle(lifecycle, fact, receivedAt, foregroundAtReceipt);
        return;

      case "permission.lifecycle": {
        // requestId 允许缺省，回退到 toolCallId：权限请求与工具调用通常一一对应，
        // 用 toolCallId 兜底能保证 requested/response 两帧仍能配对。
        const requestId = fact.requestId ?? fact.toolCallId;
        // requested 与其余状态分成两个 builder：响应侧只需要 id，
        // 混在一起上传会让响应事件带上多余的请求参数。
        if (fact.phase === "requested") {
          recordPromptPermissionRequest({
            taskId: lifecycle.taskKey,
            requestId,
            toolCallId: fact.toolCallId,
            now: receivedAt,
          });
        } else {
          recordPromptPermissionResponse({
            taskId: lifecycle.taskKey,
            requestId,
            now: receivedAt,
          });
        }
        return;
      }

      case "usage.delta":
        // eventKey 用 fact.eventId 而不是 requestId：同一次请求可能分多帧返回 usage，
        // 用 requestId 去重会把增量裁掉一部分；eventId 才是帧级唯一。
        recordPromptTokenUsageDelta({
          taskId: lifecycle.taskKey,
          eventKey: fact.eventId,
          usage: toUsage(fact),
          requestId: fact.requestId,
          modelName: runtimeTelemetryModelName(fact.providerId, fact.modelId),
          modelProvider: fact.providerId,
          providerName: fact.providerHostname,
        });
        return;

      case "turn.terminal":
        // active-loop 没有独立 TurnStarted；消费事实随终态到达后再更新本轮 composition。
        // 这两个标记必须在 handleTerminal 之前置位：finalizePromptTelemetry 会读它们
        // 计算 agent_composition，晚一步就永远是「未使用子代理」。
        if (fact.backgroundSubagentResultConsumed) {
          lifecycle.hasBackgroundSubagentResult = true;
        }
        if (fact.workflowResultConsumed) {
          lifecycle.hasWorkflowResult = true;
        }
        this.handleTerminal(lifecycle, fact, receivedAt, foregroundAtReceipt);
        return;

      case "compaction.terminal":
      case "workflow.lifecycle":
        return;
    }
  }

  private handleToolLifecycle(
    lifecycle: PromptLifecycle,
    fact: Extract<ConversationTelemetryFact, { kind: "tool.lifecycle" }>,
    receivedAt: number,
    foregroundAtReceipt: boolean,
  ): void {
    // 工具出现即视为「已有首 token」：某些模型先出工具调用再出正文，
    // 若只认 stream.chunk，这类轮次的 TTFT 会一直为空。
    lifecycle.legacyFirstTokenObserved = true;
    if (foregroundAtReceipt && lifecycle.foregroundFirstTokenAt === null) {
      lifecycle.foregroundFirstTokenAt = receivedAt;
    }
    // 工具活动意味着流并未停顿，必须清掉 stall 计时：
    // 否则一次长工具执行会被判成「模型卡住」，产出误报告警。
    clearStreamStallTracking(lifecycle.taskKey);
    // 子会话账本用于补全工具归属（agentId/model），但只在 childSessionId 存在时查：
    // 主链工具没有 child 账本，跳过可避免无谓 Map 查询。
    const child =
      fact.childSessionId !== undefined
        ? this.foregroundSubagentUsageByChildSession.get(fact.childSessionId)
        : undefined;
    const agentId = fact.agentId ?? child?.agentId;
    // 归属对象按字段逐个展开而不是整体赋值：缺失的字段必须真的缺席，
    // 写成空串会让下游「是否有归属」的判断永远为真，模型维度被写成空值。
    const toolAttribution =
      agentId || child
        ? {
            ...(agentId ? { agentId } : {}),
            ...(child?.modelName ? { modelName: child.modelName } : {}),
            ...(child?.modelProvider ? { modelProvider: child.modelProvider } : {}),
            ...(child?.providerName ? { providerName: child.providerName } : {}),
          }
        : undefined;
    const hasStarted = lifecycle.startedToolCallIds.has(fact.toolCallId);
    // 与后台账本同样先读后写：本帧是否是首帧决定发 tool_call 还是 update，
    // 顺序反了会让第一个工具记录永远缺失。
    lifecycle.startedToolCallIds.add(fact.toolCallId);
    const event = toToolLifecycleEvent({
      fact,
      toolId: fact.toolCallId,
      inputId: lifecycle.sourceCommandId,
      hasStarted,
    });
    const finalized = recordAgentStepTelemetryEvent({
      taskId: lifecycle.taskKey,
      event,
      activeInputId: lifecycle.sourceCommandId,
      clientMode: "desktop-continuous",
      ...(toolAttribution ? { toolAttribution } : {}),
      now: receivedAt,
    });
    const extraDetail = fact.automationId ? { automation_id: fact.automationId } : undefined;
    const isTerminal = fact.phase === "completed" || fact.phase === "failed";
    // 只在本工具终态时按 parentToolCallId 反查前台子代理：中间进度帧不需要归属结算，
    // 每帧都遍历全部账本会让工具密集的轮次出现可观测的卡顿。
    const foregroundChild = isTerminal
      ? [...this.foregroundSubagentUsageByChildSession.values()].find(
          (candidate) =>
            candidate.parentCommandId === lifecycle.sourceCommandId &&
            candidate.parentToolCallId === fact.toolCallId,
        )
      : undefined;
    if (foregroundChild && !foregroundChild.stopped) {
      // 超时是唯一「不等子代理收口」的例外：父 Agent 已判定超时，再等只会让
      // 整轮 completion 被一个已经卡死的子代理无限期拖住。
      const timeoutWon = isToolTimeout(fact);
      const immediate: FinalizedAgentStep[] = [];
      for (const step of finalized) {
        if (step.eventExtraDetail.tool_call_id === fact.toolCallId) {
          if (timeoutWon) {
            this.applyForegroundSubagentAttribution(step, foregroundChild);
            immediate.push(step);
          } else {
            // Bug 根因：父 Agent 工具终态可能早于 child usage。非 timeout 终态继续冻结，
            // 等 Runtime 的 SubagentStopped 后以 child 最终累计值回填，避免丢 token。
            foregroundChild.pendingFinalizedSteps.push({ step, extraDetail });
          }
        } else {
          // 非父级 Agent 的 step（子代理内部工具）立即上报：它们不依赖子代理收口，
          // 压进 pending 只会延后可见性，还可能因最终未 flush 而丢失。
          immediate.push(step);
        }
      }
      this.reportFinalizedSteps(lifecycle, immediate, extraDetail);
      if (timeoutWon) {
        // 外层 Agent timeout 是 Runtime 的真实终态；与 SubagentStopped 谁先到谁收口，
        // 不再额外等待 telemetry grace，迟到 stopped 只会命中已完成生命周期。
        foregroundChild.stopped = true;
        this.flushDeferredTerminal(foregroundChild.parentCommandId);
      }
    } else {
      this.reportFinalizedSteps(lifecycle, finalized, extraDetail);
    }
    if (fact.errorMessage) lifecycle.lastErrorMessage = fact.errorMessage;

    const performance = fact.performance;
    // 四个条件的短路顺序是有意的：先判前台（绝大多数后台工具直接返回，最便宜），
    // 再判终态，最后才检查 performance 是否存在。
    if (
      !foregroundAtReceipt ||
      !isTerminal ||
      !performance ||
      Object.keys(performance).length === 0
    ) {
      return;
    }
    // 这是「工具耗时拆解」的 UI 旁路上报，与 ARM step 是两条独立通道：
    // 它只在真实前台终态时发，因此不会污染后台任务的指标。
    reportUiToolCallDetail({
      toolName: fact.toolName,
      status: fact.phase === "completed" ? "completed" : "failed",
      talkId: fact.sessionId,
      messageId: getActivePromptMessageId(lifecycle.taskKey),
      toolCallId: fact.toolCallId,
      parentToolCallId: fact.parentToolCallId,
      childSessionId: fact.childSessionId,
      childToolCallId: fact.childToolCallId,
      agentId: fact.agentId,
      agentType: fact.agentType,
      totalMs: performance.totalMs ?? fact.durationMs,
      permissionWaitMs: performance.permissionWaitMs,
      commandRunMs: performance.commandRunMs,
      firstOutputMs: performance.firstOutputMs,
      noOutputMs: performance.noOutputMs,
      exitCode: performance.exitCode,
      timedOut: performance.timedOut,
      outputBytes: performance.outputBytes,
      commandCategory: performance.commandCategory,
      commandName: performance.commandName,
      commandCount: performance.commandCount,
      commandStatus: performance.commandStatus,
      fsReadMs: performance.fsReadMs,
      fsWriteMs: performance.fsWriteMs,
      patchMatchMs: performance.patchMatchMs,
      fileCount: performance.fileCount,
      totalBytes: performance.totalBytes,
      maxFileBytes: performance.maxFileBytes,
      hunkCount: performance.hunkCount,
      matchAttempts: performance.matchAttempts,
      workspaceKind: performance.workspaceKind,
    });
  }

  private handleTerminal(
    lifecycle: PromptLifecycle,
    fact: Extract<ConversationTelemetryFact, { kind: "turn.terminal" }>,
    receivedAt: number,
    foregroundAtReceipt: boolean,
  ): void {
    const hasRunningForegroundChild = [...this.foregroundSubagentUsageByChildSession.values()].some(
      (child) => child.parentCommandId === lifecycle.sourceCommandId && !child.stopped,
    );
    // 有未收口的子代理时先暂存终态（INV-5）：父轮次若立刻完成，
    // 子代理随后上报的 step 会挂到「已完成」的 message 上，数仓按时间排序会错乱。
    if (hasRunningForegroundChild) {
      // 已有暂存则直接返回：重复写入会覆盖首次到达的 receivedAt，
      // 让 completion 的 finishedAt 被推后，duration 虚高。
      if (this.deferredTerminalsByCommandId.has(lifecycle.sourceCommandId)) return;
      // 同一 parent stream 正常顺序是 Agent tool terminal -> turn terminal。这里只处理
      // transport 反序：等待真实 SubagentStopped 或 Agent tool terminal，二者都能立即 flush。
      this.deferredTerminalsByCommandId.set(lifecycle.sourceCommandId, {
        lifecycle,
        fact,
        receivedAt,
        foregroundAtReceipt,
      });
      return;
    }
    const terminalKey = `${fact.sessionId}\u0000${lifecycle.sourceCommandId}\u0000message_completion`;
    // remember 返回 false 说明终态已处理过：turn.terminal 可能被重连补发，
    // 重复处理会二次 finalize 并再报一条 message_completion。
    if (!this.terminalKeys.remember(terminalKey)) return;
    // status 由 fact.status 映射成三态；UI 的 user_interrupt 判定复用同一份映射，
    // 避免两处各自解释 interrupted 造成口径分裂。
    const status = terminalStatus(fact.status);
    const terminalEvent = // 修复原因：旧 adapter 把所有 TurnComplete（包括 cancelled）先投影成
      // task_complete；UI 再单独把 completion 标成 user_interrupt。
      (
        fact.status === "success" || fact.resultType !== undefined
          ? {
              type: "task_complete",
              taskId: fact.sessionId,
              traceId: fact.eventId,
              inputId: lifecycle.sourceCommandId,
              stopReason: fact.resultType ?? "complete",
            }
          : {
              type: "task_error",
              taskId: fact.sessionId,
              traceId: fact.eventId,
              inputId: lifecycle.sourceCommandId,
              error: fact.errorMessage ?? lifecycle.lastErrorMessage ?? fact.errorCode ?? "",
              code: fact.errorCode,
            }
      ) as Extract<ZCodeStreamEvent, { type: "task_complete" | "task_error" }>;
    this.reportFinalizedSteps(
      lifecycle,
      recordAgentStepTelemetryEvent({
        taskId: lifecycle.taskKey,
        event: terminalEvent,
        activeInputId: lifecycle.sourceCommandId,
        clientMode: "desktop-continuous",
        now: receivedAt,
      }),
    );
    const completion = finalizePromptTelemetry({
      taskId: lifecycle.taskKey,
      status,
      finishedAt: receivedAt,
      // 错误信息的优先级是「终态自带 → 生命周期暂存」：暂存值可能来自更早的
      // model_request_failed，只在终态没给原因时才有参考意义。
      errorType: fact.errorCode,
      errorMsg: fact.errorMessage ?? lifecycle.lastErrorMessage,
      // completionMessageSource 只在 admission 时冻结过才传：缺失表示调用方未采集，
      // 补默认值会让数仓把「未知来源」统计成某个具体来源。
      ...(lifecycle.completionMessageSource
        ? { messageSource: lifecycle.completionMessageSource }
        : {}),
      // composition 依赖前面置位的三个 consumed 标记，必须在此刻计算，
      // 放到 finalize 之后再读就拿不到 lifecycle 了。
      agentComposition: composeAgentComposition(lifecycle),
    });
    // completion 可能为 null（例如没有有效 sendTime 的导入会话）：此时只做清理，
    // 不构造一条字段残缺的 message_completion。
    if (completion) {
      this.enqueueReport({
        elementName: "message_completion",
        eventRegion: "app",
        eventType: "agent_trace",
        // 修复原因：workspace 场景维度必须和 completion/step 一起出现在最终 report，
        // 不能只停留在 attachment 的隔离 key，否则数仓无法区分本地与远程对话。
        eventExtraDetail: this.withWorkspaceTelemetryDetail(completion.eventExtraDetail),
        talkId: fact.sessionId,
        messageId: lifecycle.sourceCommandId,
      });
      if (foregroundAtReceipt) {
        // TTFT 的三态编码是刻意的：有真实首 token 时间就传毫秒差；没记录但见过 chunk
        // 就传 undefined（未知）；完全没见过 chunk 传 -1（明确的「未产出」）。
        // 合并成一种「未知」会让「模型一个字没出」与「采集缺失」无法区分。
        this.reportCompletionArms(
          fact.sessionId,
          lifecycle.sourceCommandId,
          completion.eventExtraDetail,
          lifecycle.foregroundFirstTokenAt === null
            ? lifecycle.legacyFirstTokenObserved
              ? undefined
              : -1
            : lifecycle.foregroundFirstTokenAt - lifecycle.sendTime,
        );
      }
    }
    clearStreamStallTracking(lifecycle.taskKey);
    // 清理顺序：deferred → activeCommand → lifecycle → turnKey，最后清子代理账本。
    // 先删 lifecycle 会让后面按 sourceCommandId 遍历子代理时失去比较基准。
    this.deferredTerminalsByCommandId.delete(lifecycle.sourceCommandId);
    // finalize 已清当前 active；同 session 后续 queued seed 仍需等待 promotion，不能整 task 丢弃。
    this.activeCommandBySessionId.delete(fact.sessionId);
    this.lifecyclesByCommandId.delete(lifecycle.sourceCommandId);
    if (lifecycle.turnId) {
      this.commandIdByTurnKey.delete(`${fact.sessionId}\u0000${lifecycle.turnId}`);
    }
    for (const [childSessionId, child] of this.foregroundSubagentUsageByChildSession) {
      // 遍历中删除是安全的：Map 的迭代器支持在遍历时 delete 当前项，
      // 但必须删每个命中的项，否则残留账本会让下一轮的 childSessionId 命中旧数据。
      if (child.parentCommandId === lifecycle.sourceCommandId) {
        this.foregroundSubagentUsageByChildSession.delete(childSessionId);
      }
    }
    // 最后尝试放行同会话中被阻塞的下一条 seed：放在所有清理之后，
    // 保证 hasDeferredTerminalForTask 看到的是清除后的真实状态。
    this.drainPromptBlockedByDeferredTerminal(lifecycle.taskKey);
  }

  private reportCompletionArms(
    sessionId: string,
    sourceCommandId: string,
    detail: Record<string, string>,
    foregroundTtftMs: number | undefined,
  ): void {
    if (foregroundTtftMs !== undefined) {
      // -1 是「明确未产出首 token」的哨兵，负值不能直接传给计时统计：
      // 这里只在非负时上报，让下游按「缺字段」而不是「-1ms」处理。
      // 传 undefined 时整段跳过，保持「未知」与「未产出」可区分。
      reportUiFirstToken({
        ttftMs: foregroundTtftMs,
        model: detail.model_name || undefined,
        talkId: sessionId,
        messageId: sourceCommandId,
      });
      reportPlanUsageTtftToArms(this.platform, {
        providerId: detail.model_provider,
        modelName: detail.model_name,
        askMode: detail.ask_mode,
        ttftMs: foregroundTtftMs,
      });
    }
    const durationMs = finiteNumber(detail.duration_ms);
    // duration 缺失时后面两条都发不出去：它们的核心字段就是时长，
    // 提前返回比发一条 0ms 的 completion 更诚实（0 会拉低整体分布）。
    if (durationMs === undefined) return;
    // detail 里的数字都是字符串，统一走 finiteNumber：直接 Number() 会把空串转成 0。
    reportUiMessageComplete({
      durationMs,
      result: detail.status ?? "",
      model: detail.model_name || undefined,
      talkId: sessionId,
      messageId: sourceCommandId,
    });
    reportUiTurnBreakdown({
      durationMs,
      result: detail.status ?? "",
      model: detail.model_name || undefined,
      talkId: sessionId,
      messageId: sourceCommandId,
      ttftMs: foregroundTtftMs,
      waitingMs: finiteNumber(detail.waiting_ms),
      toolCallTotal: finiteNumber(detail.tool_call_total),
      toolCallFailed: finiteNumber(detail.tool_call_failed),
      agentStepCount: finiteNumber(detail.agent_step_cnt),
      retryCount: finiteNumber(detail.retry_cnt),
      fileChangeCount: finiteNumber(detail.file_change_cnt),
      generatedCodeLines: finiteNumber(detail.generated_code_lines),
    });
  }

  private reportFinalizedSteps(
    lifecycle: PromptLifecycle,
    finalized: ReturnType<typeof recordAgentStepTelemetryEvent>,
    extraDetail?: Record<string, string>,
  ): void {
    for (const step of finalized) {
      // 与后台版本共用同一套合并顺序，差异只在 talkId 取 lifecycle.sessionId：
      // 这里必须是会话 id 而不是 taskKey，UI 侧按原始 sessionId 关联消息。
      this.enqueueReport({
        elementName: "agent_step",
        eventRegion: "app",
        eventType: "agent_trace",
        eventExtraDetail: this.withWorkspaceTelemetryDetail({
          ...lifecycle.stepSourceDetail,
          ...step.eventExtraDetail,
          ...extraDetail,
        }),
        talkId: lifecycle.sessionId,
        messageId: lifecycle.sourceCommandId,
      });
    }
  }

  private handleCompaction(
    fact: Extract<ConversationTelemetryFact, { kind: "compaction.terminal" }>,
    foregroundAtReceipt: boolean,
  ): void {
    const dedupeKey = `${fact.sessionId}\u0000${fact.operationId}\u0000context_compaction`;
    // 用 operationId 去重而不是 sessionId：同一会话可以压缩多次，
    // 按会话去重会把第二次之后的压缩全部吞掉。
    if (!this.compactionKeys.remember(dedupeKey)) return;
    // compaction 只按 terminal 到达瞬间是否前台决定；后台到达后切回不能补报。
    if (!foregroundAtReceipt) return;
    // timeline 结构必须完整（含 version/kind/type）：UI 侧按 version 做兼容分发，
    // 缺字段会被当成未知格式而整条丢弃。
    const timeline: ZCodeContextCompactionTimelineMeta = {
      version: 1,
      kind: "synthetic",
      type: "context_compaction",
      operationId: fact.operationId,
      status: fact.status,
      trigger: fact.trigger,
      display: "separator",
      reason: fact.reason,
      summaryMessageId: fact.summaryMessageId,
      preCompactTokenCount: fact.preCompactTokenCount,
      postCompactTokenCount: fact.postCompactTokenCount,
      truePostCompactTokenCount: fact.truePostCompactTokenCount,
      attempt: fact.attempt,
      maxAttempts: fact.maxAttempts,
      startedAt: fact.startedAt,
      endedAt: fact.endedAt,
    };
    const eventExtraDetail = buildCompactionTelemetryExtraDetail({
      timeline,
      modelName: resolveLegacyRuntimeModelValue({
        configProvider: fact.modelProvider,
        modelName: fact.modelName,
      }),
      modelProvider: fact.modelProvider,
    });
    if (!eventExtraDetail) return;
    // messageId 回退到 operationId：压缩摘要消息可能尚未生成 id，
    // 用 operationId 至少保证这条事件在数仓里能被唯一关联。
    this.enqueueReport({
      elementName: "context_compaction",
      eventRegion: "app",
      eventType: "agent_trace",
      eventExtraDetail,
      talkId: fact.sessionId,
      messageId: fact.summaryMessageId ?? fact.operationId,
    });
  }
}
