/**
 * ============================================================================
 * runtime/methods/turn-loop-state.ts —— 单个 turn 循环的可变状态与闸门常量
 * ============================================================================
 *
 * 【定位】RegularTurnLoopState 是"一轮内部"的全部事实：本轮固定模型、事件数组、
 * 压缩计数、steering 诊断、后台结果消费标记等。它不持久化，冷恢复时由
 * 事件流重建；因此这里的字段名/语义一旦变化，必须同步检查恢复路径。
 *
 * 【三类身份闸门（互斥，均来自 Host admission，不从持久 meta 推断）】
 *   - automationId：cron 自动轮。写工具被禁（AUTOMATION_MUTATION_TOOL_NAMES），
 *     但放行 OffPeakCreate（定时派生闲时任务）；
 *   - offPeakTaskId：闲时任务轮。写侧工具被禁（OFF_PEAK_MUTATION_TOOL_NAMES，
 *     含 OffPeakCreate 自身，防止递归派生），Workflow/动态执行入口也不可用；
 *   - 普通用户轮：两者都缺席。
 *   automationId 与 offPeakTaskId 必须互斥：一轮不能同时是两种自动执行身份。
 *
 * 【快速重填闸门】RAPID_REFILL_TOOL_TURN_THRESHOLD / MAX_CONSECUTIVE_RAPID_REFILLS
 *   用于识别"压缩后立刻又被填满"的循环；连续命中达上限时本步禁止再压缩
 *   （rapid_refill_blocked），否则会出现压缩-重填死循环。
 *
 * 【查询前缀】OFF_PEAK_QUERY_ID_PREFIX 只是 resume 段的兜底信号，
 *   主信号必须是显式 offPeakTaskId；automation 用固定前缀便于统计区分。
 * ============================================================================
 */

import { OFF_PEAK_EXECUTION_TOOL_DENYLIST } from "@zcode/shared";
import type {
  CompactPhase,
  CompactReason,
  MessageId,
  ModelStreamRecoveryStatus,
  Model,
  ModelSelection,
  OutputStylePromptConfig,
  SessionEvent,
  TraceContext,
  TraceId,
  TurnId,
} from "../deps.js";
import type { ActiveTurnSteeringState } from "../types.js";
import type { ModelToolContract, SubagentRunOptions } from "@zcode/contracts";
import type { DrainedPendingInputDiagnostics, ModelExecutionContext } from "../types.js";
import type { TurnMachineImpl } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";

export type PendingStreamRecoveryRequest = ModelStreamRecoveryStatus;

// 连续 3 次"工具轮后立刻又触发压缩"视为快速重填；达到 3 次即阻断本步压缩。
export const RAPID_REFILL_TOOL_TURN_THRESHOLD = 3;
export const MAX_CONSECUTIVE_RAPID_REFILLS = 3;
export const AUTOMATION_MUTATION_TOOL_NAMES = ["CronCreate", "CronUpdate", "CronDelete"] as const;
// automation 轮的 queryId 固定前缀：让用量/遥测在不读 turn 状态时也能区分自动轮。
const AUTOMATION_QUERY_ID_PREFIX = "automation-";
/**
 * 闲时派发轮隐藏的工具；OffPeakList 只读保留。
 * - OffPeakCreate：防止闲时任务递归自我派生、无限调度。
 * - Workflow 与动态执行入口：独立工作流运行器尚未加入闲时票据生命周期。
 *
 * 独立常量，绝不并入 AUTOMATION_MUTATION_TOOL_NAMES——cron automation turn 明确放行
 * OffPeakCreate（定时派生闲时任务），混入会让 automation turn 误 deny。
 */
export const OFF_PEAK_MUTATION_TOOL_NAMES = OFF_PEAK_EXECUTION_TOOL_DENYLIST;
// 闲时派发 init 段 traceId 无固定前缀，只有 resume 段是 `${offPeakTaskId}:resume:*`
// （offpeak- 开头）；前缀只是 resume 兜底信号，主信号必须是显式 offPeakTaskId。
const OFF_PEAK_QUERY_ID_PREFIX = "offpeak-";

export interface CompactLoopTracking {
  consecutiveRapidRefills: number;
  toolTurnsSinceCompact: number;
}

export interface RapidRefillDecision {
  consecutiveRapidRefills: number;
  shouldBlock: boolean;
  toolTurnsSinceCompact: number;
}

export type CompactAttemptOutcome = "skipped" | "compacted" | "failed";

export type AutoCompactOutcome = CompactAttemptOutcome | "rapid_refill_blocked";

export interface AutoCompactLoopContext {
  getAgentListingTools?: () => readonly { name: string }[];
  compactReason: CompactReason;
  modelStepIndex: number;
  phase: CompactPhase;
  rapidRefill: RapidRefillDecision;
  model: Model;
  turnRequestState: TurnRequestState;
  getContinuationTools?: () => readonly ModelToolContract[];
}

export interface ReactiveCompactLoopContext {
  agentListingTools?: readonly { name: string }[];
  activeEntries?: readonly RuntimeMessageEntry[];
  modelStepIndex: number;
  model: Model;
  rapidRefillCount: number;
  turnRequestState: TurnRequestState;
  getContinuationTools?: () => readonly ModelToolContract[];
}

export interface TurnRequestState {
  entries: readonly RuntimeMessageEntry[];
  outputTokenContinuationCount: number;
}

/**
 * 一轮执行的可变状态。
 *
 * 注意字段的"生命周期"：
 *   - model/modelSelectionScope/selectionFallback：本轮创建时定格，运行中切模不影响；
 *   - compactTracking/repeatedToolCall*：纯过程计数，轮结束即丢弃；
 *   - backgroundSubagentResultConsumed/workflowResultConsumed：标记"本轮已消费过
 *     该类后台结果"，用于决定是否还需继续续跑（避免同一结果触发第二轮）；
 *   - automationCreateLimitReached：一旦命中全局上限，本轮永久切纯文本，
 *     不允许模型通过重试自行恢复。
 */
export interface RegularTurnLoopState {
  offPeakExecutionId?: string;
  activeTurn?: ActiveTurnSteeringState;
  /** Host admission 显式传入的本轮 automation 身份；不能从持久 task metadata 推断。 */
  automationId?: string;
  /** Host admission 显式传入的本轮闲时任务身份；与 automationId 互斥，不从持久 meta 推断。 */
  offPeakTaskId?: string;
  /** CronCreate 命中全局上限后，本用户 turn 永久切为纯文本回复，禁止模型自行恢复。 */
  automationCreateLimitReached?: boolean;
  anomalyWarningsInjected: number;
  /** 本轮是否已消费来源为 subagent 的后台结果通知。 */
  backgroundSubagentResultConsumed: boolean;
  /** 本轮是否已消费来源为 workflow（dynamic-workflow run）的后台通知。 */
  workflowResultConsumed: boolean;
  compactTracking?: CompactLoopTracking;
  currentUserMessageId: MessageId;
  drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
  events: SessionEvent[];
  input: string;
  inputId?: string;
  modelResponse: string;
  /** 本轮固定使用的可调用模型；配置变化只影响以后创建的 Loop。 */
  model: Model;
  /** execution 表示当前 Active Model 不能被同 loop 的 guide 改写。 */
  modelSelectionScope?: "execution";
  /** 本轮执行 Selection 的降级声明；命中一次后清空，退回后的模型不再二次降级。 */
  selectionFallback?: ModelExecutionContext["selectionFallback"];
  /** 请求期失败已命中退回声明但无可用退回目标；TurnError 归因据此发布，Renderer 作废匹配卡。 */
  highspeedFallbackUnavailable?: boolean;
  /** 仅加速卡过期回退使用的启动快照；不用于闲时换票。 */
  highspeedFallbackSelection?: ModelSelection;
  /** Core Server 的前台 child Selection override；优先于 profile 与父模型继承。 */
  subagentModelOverride?: SubagentRunOptions["modelOverride"];
  modelStepCount: number;
  /** 当前 query 已成功写入 provider 可见持久历史的 assistant/compact 产物数量。 */
  historyRoundCount: number;
  completedRealToolResultBatch: boolean;
  reactiveCompactAttemptedInCurrentModelStep: boolean;
  repeatedToolCallSignature?: string;
  repeatedToolCallStreakCount: number;
  pendingStreamRecoveryRequest?: PendingStreamRecoveryRequest;
  stopHookContinuationCount: number;
  /** 最终成功 product turn 的 raw transcript 起点；只有确认不再 continue 时才赋值。 */
  stableProductStartMessageId?: MessageId;
  /** 最终成功 assistant boundary；与 stableProductStartMessageId 成对出现。 */
  stableBoundaryAssistantMessageId?: MessageId;
  streamRecoveryRetryCount: number;
  tokenCount: number;
  toolCallCount: number;
  /** 当前 Turn 的 provider-local history；Turn 结束后直接释放。 */
  turnRequestState: TurnRequestState;
  /** 当前 turn 不向 provider 暴露的工具名；registry 仍保留，供执行边界做纵深校验。 */
  toolDisallowlist?: readonly string[];
  traceId: TraceId;
  turnAbortSignal: AbortSignal;
  turnId: TurnId;
  turnMachine: TurnMachineImpl;
  /** 当前 Turn 捕获的 provider-visible output style；不表示显式 subagent model override。 */
  turnOutputStyle?: OutputStylePromptConfig;
  turnTraceContext: TraceContext;
  userMessageId: MessageId;
}

export function isAutomationMutationRestrictedTurn(state: RegularTurnLoopState): boolean {
  // 三重信号任一命中即视为 automation:显式 id 是主事实,queryId 前缀兼容旧 host,
  // 下面的 denylist 是最后兜底。宁可多限制一轮,也不让自动轮拿到写工具。
  if (state.automationId?.trim()) return true;
  if (state.turnTraceContext.queryId?.trim().startsWith(AUTOMATION_QUERY_ID_PREFIX)) return true;

  const disallowedTools = new Set(state.toolDisallowlist ?? []);
  // active/busy automation 输入会把 turn-scoped denylist 合并进当前 loop；即使原始
  // automationId 不再是 loop 首输入，也必须把同一事实继续传到 handler 执行边界。
  return AUTOMATION_MUTATION_TOOL_NAMES.every((toolName) => disallowedTools.has(toolName));
}

/**
 * 本轮是否为闲时自动派发 turn（需 deny OffPeakCreate）。三重信号与
 * isAutomationMutationRestrictedTurn 同构：显式 offPeakTaskId 为主信号；
 * resume 段 traceId 前缀与 turn denylist 是纵深兜底。
 */
export function isOffPeakCreateRestrictedTurn(state: RegularTurnLoopState): boolean {
  if (state.offPeakTaskId?.trim()) return true;
  // resume 段 traceId 带 offpeak- 前缀:旧 host 可能只恢复了 trace 而没带 offPeakTaskId,
  // 此时仍必须维持"禁止再派生闲时任务"的约束。
  if (state.turnTraceContext.queryId?.trim().startsWith(OFF_PEAK_QUERY_ID_PREFIX)) return true;

  // 兜底只认 OffPeakCreate 这一哨兵：旧 host 派发的 denylist 可能尚未带上 新增的工具。
  const disallowedTools = new Set(state.toolDisallowlist ?? []);
  return disallowedTools.has(OFF_PEAK_MUTATION_TOOL_NAMES[0]);
}

export function evaluateRapidRefill(
  tracking: CompactLoopTracking | undefined,
): RapidRefillDecision {
  const toolTurnsSinceCompact = tracking?.toolTurnsSinceCompact ?? 0;
  // 距上次压缩不足 RAPID_REFILL_TOOL_TURN_THRESHOLD 个工具轮又触发压缩 = 一次"快速重填";
  // 经历过足够工具轮则归零(说明压缩确实换来了可推进的空间)。
  // 这里只算候选值,只有压缩真的成功才会被 recordCompactSuccess 写回。
  const consecutiveRapidRefills =
    tracking && toolTurnsSinceCompact < RAPID_REFILL_TOOL_TURN_THRESHOLD
      ? tracking.consecutiveRapidRefills + 1
      : 0;

  return {
    consecutiveRapidRefills,
    shouldBlock: consecutiveRapidRefills >= MAX_CONSECUTIVE_RAPID_REFILLS,
    toolTurnsSinceCompact,
  };
}

export function recordCompactSuccess(
  state: RegularTurnLoopState,
  decision: RapidRefillDecision,
): void {
  // 关键:写回的是 decision 里已经 +1 的计数,而不是 0——压缩成功本身就算一次
  // "很快又满"的证据;若在此归零,rapid-refill 熔断永远累计不到上限。
  // toolTurnsSinceCompact 归零表示"从这次压缩重新开始计工具轮"。
  state.compactTracking = {
    consecutiveRapidRefills: decision.consecutiveRapidRefills,
    toolTurnsSinceCompact: 0,
  };
}

export function recordCompletedToolBatch(state: RegularTurnLoopState): void {
  // 旧 guard 活在整个用户 turn，完整工具批次结束后仍保持 used，导致后续真实 overflow 无法再次 reactive compact。
  state.reactiveCompactAttemptedInCurrentModelStep = false;
  // 每个完整工具批次代表模型确实推进了一轮;累计到阈值后,evaluateRapidRefill 才会
  // 不再把下一次压缩算作"快速重填"(避免正常长任务被误熔断)。
  if (state.compactTracking) {
    state.compactTracking.toolTurnsSinceCompact += 1;
  }
}

export function recordModelHistoryRound(state: RegularTurnLoopState): void {
  // toolCallCount 会把并行工具按数量展开，无法表达模型真正写入历史的轮次。
  // 调用点沿用既有 modelStepCount 的提交边界，额外累计历史轮次而不改变 loop 控制语义。
  state.historyRoundCount += 1;
}

export function recordCompactHistoryRound(state: RegularTurnLoopState): void {
  // compact summary 是独立的 provider 可见持久历史，但不是普通模型步骤，单独累计一次。
  state.historyRoundCount += 1;
}
