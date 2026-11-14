// INV-01 阶段枚举封闭十项：守住位置 TurnPhase；改错故障 新阶段落到未处理分支。
// INV-02 等待类阶段可停留：守住位置 isWaitingPhase；改错故障 超时判定漏掉权限等待。
// INV-03 终态只含完成与错误：守住位置 isTerminalPhase；改错故障 仍在处理就被回收。
// INV-04 一轮事实集中单对象：守住位置 TurnState；改错故障 状态散落难以收尾。
// INV-05 附件保留原始形态：守住位置 attachments；改错故障 模型看不到附件。
// INV-06 工具调用状态六种：守住位置 ToolCallStateStatus；改错故障 权限拒绝被当成失败。
// INV-07 调度状态含依赖与并行组：守住位置 ToolScheduleState；改错故障 拓扑顺序错乱。
// INV-08 权限决定四选一：守住位置 PermissionDecision；改错故障 未知决定直通执行。
// INV-09 取消复用完成结果：守住位置 cancelled；改错故障 用户中断被报成错误。
// INV-10 三种上限错误分档：守住位置 三个错误值；改错故障 预算与轮次无法区分。
// INV-11 创建即置空闲阶段：守住位置 createTurnState；改错故障 首帧阶段为空。
// INV-12 集合字段预置空数组：守住位置 工厂默认值；改错故障 消费方处理 undefined。
// INV-13 起始时间在创建时冻结：守住位置 startedAt；改错故障 耗时从首次渲染算起。
// INV-14 完成时间只在收尾写入：守住位置 completedAt；改错故障 运行中已有完成时间。
// INV-15 转移表穷举全阶段：守住位置 validTransitions；改错故障 新增阶段默认可达。
// INV-16 未知转移一律拒绝：守住位置 空值兜底；改错故障 非法跳转静默通过。
// INV-17 完成与错误都可复位：守住位置 两条转移；改错故障 下一轮无法启动。
// INV-18 类型模块不持有运行时状态：守住位置 纯导出；改错故障 单例跨轮污染。
//
// 模块职责：定义单轮状态机、子状态与阶段转移规则。
// 状态所有权：纯类型与纯函数；运行实例由调用方持有。
// 阅读顺序：先看阶段枚举，再看状态结构，最后看转移表。
// ============================================================
// Turn State - Turn state machine types
// ============================================================

import type {
  ModelMessageContent,
  PendingTurnInput,
  SessionId,
  ToolCallId,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import type { ModelToolCall, ModelCallWrapper } from "@zcode/contracts";

// Re-export ToolCall for consumers of this module
export interface ToolCall extends ModelToolCall {
  modelCallWrapper?: ModelCallWrapper;
}

// Note: ModelMessage is defined locally to avoid conflicts with contracts' ModelMessage
// which uses ToolCallPayload[] instead of ModelToolCall[]

// -----------------------------------------------
// Turn Phase
// -----------------------------------------------

// TurnPhase 的十个枚举值覆盖一轮从 Idle 到 Error 的完整生命周期。
// AwaitingModelResponse 等等待阶段允许停留，不设超时转移。
// 只有 Completing 与 Error 是终态，其余阶段都必须继续转移。
export const TurnPhase = {
  Idle: "idle",
  ProcessingInput: "processing_input",
  AwaitingModelResponse: "awaiting_model_response",
  Streaming: "streaming",
  SchedulingTools: "scheduling_tools",
  ExecutingTools: "executing_tools",
  AggregatingResults: "aggregating_results",
  AwaitingPermission: "awaiting_permission",
  Completing: "completing",
  Error: "error",
} as const;

export type TurnPhase = (typeof TurnPhase)[keyof typeof TurnPhase];

// -----------------------------------------------
// Turn State
// -----------------------------------------------

// TurnState 把一轮会话的全部事实收在同一个对象里。
// input 与 attachments 保留调用方传入的原始形态，不做归一。
// completedAt 与 error 这类终态字段在收尾阶段才补齐。
export interface TurnState {
  id: TurnId;
  sessionId: SessionId;
  turnNumber: number;
  phase: TurnPhase;
  traceId: TraceId;
  input: string;
  attachments?: TurnAttachment[];
  modelRequest?: ModelRequestState;
  streamingContent: string;
  finalResponse?: string;
  toolCalls: ToolCallState[];
  toolResults: ToolResultState[];
  scheduledTools: ToolScheduleState;
  pendingInputs: PendingTurnInput[];
  acceptsPendingInput: boolean;
  pendingPermissions: PermissionRequestState[];
  resolvedPermissions: PermissionResultState[];
  resultType: TurnResultType;
  error?: TurnErrorState;
  startedAt: Date;
  completedAt?: Date;
}

// -----------------------------------------------
// Sub-states
// -----------------------------------------------

export interface ModelRequestState {
  model: string;
  messages: ModelMessage[];
  temperature?: number;
  maxTokens?: number;
  stopReason?: string;
  usage?: TokenUsageState;
}

// ModelMessage for turn state - uses ToolCall from contracts
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ModelMessageContent;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface TokenUsageState {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ToolCallState {
  id: ToolCallId;
  name: string;
  input: unknown;
  status: ToolCallStateStatus;
  scheduledAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: ToolResultState;
}

export type ToolCallStateStatus =
  | "scheduled"
  | "waiting_permission"
  | "permission_denied"
  | "running"
  | "completed"
  | "failed";

export interface ToolResultState {
  success: boolean;
  content: ModelMessageContent;
  error?: TurnErrorState;
}

// dependencies 决定 ToolScheduleItem 的执行先后。
// parallelGroups 由依赖分析划出可并行的 ToolCallId 分组。
// executionOrder 是依赖排序后的最终拓扑序列。
export interface ToolScheduleState {
  items: ToolScheduleItem[];
  parallelGroups: ToolCallId[][];
  executionOrder: ToolCallId[];
}

export interface ToolScheduleItem {
  toolCallId: ToolCallId;
  dependencies: ToolCallId[];
  canRunParallel: boolean;
}

export interface PermissionRequestState {
  toolCallId: ToolCallId;
  toolName: string;
  riskLevel: string;
  requestedAt: Date;
}

export interface PermissionResultState {
  toolCallId: ToolCallId;
  decision: PermissionDecision;
  reason?: string;
  modifiedInput?: unknown;
  resolvedAt: Date;
}

export type PermissionDecision = "allow" | "deny" | "escalate" | "modify";

// TurnResultType 里 cancelled 与 success 同走 TurnComplete 事件。
// error_max_turns 与 error_max_budget 等上限错误各自对应一类预算耗尽。
// error_during_execution 单独一档，区别于轮次与工具上限错误。
export type TurnResultType =
  | "success"
  // "cancelled": 用户主动中断（TurnCancelled）属于正常结束，复用 TurnComplete 上报而非 TurnError。
  | "cancelled"
  | "error_max_turns"
  | "error_max_budget"
  | "error_during_execution"
  | "error_max_tool_calls";

export interface TurnErrorState {
  type: string;
  message: string;
  recoverable: boolean;
}

export interface TurnAttachment {
  type: "file" | "image" | "video" | "pdf" | "url";
  path?: string;
  content?: string;
  /** clipboard-text 是 UI 长粘贴落盘生成的临时附件，模型请求中只保留路径引用。 */
  sourceKind?: "clipboard-text" | "topic-history";
  messageCount?: number;
  // 展示元信息（协议边界保真透传，TurnStarted 事件/v4 投影展示用；
  // 缺省时由 basename/扩展名推断兜底）。不参与内容解析。
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
}

// -----------------------------------------------
// Turn State Factory
// -----------------------------------------------

// createTurnState 的初始 phase 为 TurnPhase.Idle。
// toolCalls 与 pendingPermissions 等集合预置为空数组。
// startedAt 在创建时取 new Date()，后续不再改写。
export function createTurnState(
  id: TurnId,
  sessionId: SessionId,
  turnNumber: number,
  traceId: TraceId,
  input: string,
  attachments?: TurnAttachment[],
): TurnState {
  return {
    id,
    sessionId,
    turnNumber,
    phase: TurnPhase.Idle,
    traceId,
    input,
    attachments,
    streamingContent: "",
    toolCalls: [],
    toolResults: [],
    scheduledTools: {
      items: [],
      parallelGroups: [],
      executionOrder: [],
    },
    pendingInputs: [],
    acceptsPendingInput: true,
    pendingPermissions: [],
    resolvedPermissions: [],
    resultType: "success",
    startedAt: new Date(),
  };
}

// -----------------------------------------------
// Phase Predicates
// -----------------------------------------------

export function isTerminalPhase(phase: TurnPhase): boolean {
  return phase === TurnPhase.Completing || phase === TurnPhase.Error;
}

export function isWaitingPhase(phase: TurnPhase): boolean {
  return (
    phase === TurnPhase.AwaitingModelResponse ||
    phase === TurnPhase.AwaitingPermission ||
    phase === TurnPhase.ExecutingTools
  );
}

// validTransitions 为每个 TurnPhase 穷举全部合法后继。
// 未登记的后继一律返回 false。
// Idle 与各终态都可以回到 Idle。
export function canTransitionTo(current: TurnPhase, next: TurnPhase): boolean {
  const validTransitions: Record<TurnPhase, TurnPhase[]> = {
    [TurnPhase.Idle]: [TurnPhase.ProcessingInput],
    [TurnPhase.ProcessingInput]: [TurnPhase.AwaitingModelResponse, TurnPhase.Completing],
    [TurnPhase.AwaitingModelResponse]: [TurnPhase.Streaming, TurnPhase.Completing, TurnPhase.Error],
    [TurnPhase.Streaming]: [
      TurnPhase.SchedulingTools,
      TurnPhase.AggregatingResults,
      TurnPhase.Completing,
      TurnPhase.Error,
    ],
    [TurnPhase.SchedulingTools]: [
      TurnPhase.ExecutingTools,
      TurnPhase.AwaitingPermission,
      TurnPhase.Error,
    ],
    [TurnPhase.ExecutingTools]: [
      TurnPhase.AggregatingResults,
      TurnPhase.AwaitingPermission,
      TurnPhase.Error,
    ],
    [TurnPhase.AggregatingResults]: [
      TurnPhase.AwaitingModelResponse,
      TurnPhase.SchedulingTools,
      TurnPhase.Completing,
      TurnPhase.Error,
    ],
    [TurnPhase.AwaitingPermission]: [TurnPhase.ExecutingTools, TurnPhase.Error],
    [TurnPhase.Completing]: [TurnPhase.Idle],
    [TurnPhase.Error]: [TurnPhase.Idle],
  };

  return validTransitions[current]?.includes(next) ?? false;
}
