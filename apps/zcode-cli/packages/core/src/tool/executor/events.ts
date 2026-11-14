import {
  SessionEventType,
  createRootTraceContext,
  traceContextToLogContext,
  type PermissionBrokerResult,
  type PermissionOptionsPolicy,
  type PermissionUpdate,
  type ToolResultDisplayPayload,
  type ToolSideEffectScope,
  type ToolExecutionTelemetry,
  type SkillTelemetryMetadata,
  type TraceContext,
  type TurnId,
} from "@zcode/contracts";
import type { PermissionContext } from "../../permission/service.js";
import type { ExecutableToolCall, ToolExecutionResult, ToolResultSerialization } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { summarizeInput } from "./utils.js";

/**
 * 发布 ToolCallStarted：UI 工具行从"已解析"进入"执行中"。
 *
 * payload 带上可选的预览 `display` 与已解析的副作用能力（`readOnly` / `sideEffectScope`），
 * 让订阅者在使用者动手前就知道"要写了"；能力字段缺失表示不声明，而不是"只读"。
 *
 * 输入：`startTime` 是 `Date.now()` 毫秒时间戳，事件里转成 `startedAt: Date`；
 * `traceContext` 提供 traceId，`turnId` 应已由调用方兜底。
 *
 * 副作用：调用 `deps.emitEvent` 写一条 SessionEvent。`sequenceNumber` 固定 0，真正的序号
 * 由 eventStore 落库时统一补号；emitEvent 抛错时按契约向上抛，不吞。
 */
export async function emitToolCallStarted(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  traceContext: TraceContext,
  turnId: TurnId | undefined,
  startTime: number,
  display?: ToolResultDisplayPayload,
  // 解析后的副作用能力（与权限判定同源）：订阅者据此在工具动手前知道「要写了」。
  capability?: { readOnly?: boolean; sideEffectScope?: ToolSideEffectScope },
): Promise<void> {
  await deps.emitEvent({
    id: crypto.randomUUID() as any,
    sessionId: deps.sessionId,
    turnId,
    type: SessionEventType.ToolCallStarted,
    timestamp: new Date(),
    traceId: traceContext.traceId,
    sequenceNumber: 0,
    payload: {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      startedAt: new Date(startTime),
      display,
      ...(capability?.readOnly === undefined ? {} : { readOnly: capability.readOnly }),
      ...(capability?.sideEffectScope === undefined
        ? {}
        : { sideEffectScope: capability.sideEffectScope }),
    },
  });
}

/**
 * 发布 ToolCallResult（**只在 handler 成功路径**调用；失败走 `emitToolCallError`）。
 *
 * payload 的 `success` 恒为 true：这条事件表示"执行完成并有可回灌的结果"，不表示业务成败。
 *
 * 序列化口径：`originalBytes` 是 handler 原始输出的 UTF-8 字节（截断前，仅诊断）；
 * `returnedBytes` 是**真实发给模型的字节**，结构化媒体（CUA 栅格）必须已计入；
 * `truncated=true` 表示模型看不到全文，只能按 `artifactPath` 再读。
 *
 * 副作用：写一条 SessionEvent；`durationMs` 只含 handler 主执行段，不含权限等待。
 */
export async function emitToolCallResult(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  traceContext: TraceContext,
  turnId: TurnId | undefined,
  serialization: ToolResultSerialization,
  durationMs: number,
  display: ToolResultDisplayPayload | undefined,
  perf: ToolExecutionTelemetry | undefined,
  skillMetadata: SkillTelemetryMetadata | undefined,
  pluginId?: string,
): Promise<void> {
  await deps.emitEvent({
    id: crypto.randomUUID() as any,
    sessionId: deps.sessionId,
    turnId,
    type: SessionEventType.ToolCallResult,
    timestamp: new Date(),
    traceId: traceContext.traceId,
    sequenceNumber: 0,
    payload: {
      toolCallId: toolCall.id,
      ...(skillMetadata ? { skillMetadata } : {}),
      ...(pluginId ? { pluginId } : {}),
      result: {
        // 注意：恒 true，仅表示"有可回灌的结果"；失败结果绝不经由这条事件发布。
        success: true,
        content: serialization.content,
        display,
        perf,
        truncated: serialization.truncated,
        originalBytes: serialization.originalBytes,
        returnedBytes: serialization.returnedBytes,
        budgetStrategy: serialization.budgetStrategy,
        artifactPath: serialization.artifactPath,
      },
      duration: durationMs,
    },
  });
}

/**
 * 发布 ToolCallError：失败工具行的唯一收口事件。
 *
 * registry miss、schema/语义校验失败、权限拒绝、handler 抛错都必须走到这里，否则模型永远
 * 收不到配对结果、UI 工具行停在 inputStreaming——这是"每个 tool_call 必须有配对结果"的
 * 早退维护点。
 *
 * `error` 携带稳定的 type/code（调用方不得依赖 message 文本判流程）；skillMetadata / pluginId
 * 只在对应失败阶段有值。副作用：写一条 SessionEvent，无返回值。
 */
export async function emitToolCallError(
  deps: ToolExecutorDeps,
  toolCallId: string,
  traceContext: TraceContext,
  turnId: TurnId | undefined,
  error: ToolExecutionResult["error"],
  skillMetadata?: SkillTelemetryMetadata,
  pluginId?: string,
): Promise<void> {
  await deps.emitEvent({
    id: crypto.randomUUID() as any,
    sessionId: deps.sessionId,
    turnId,
    type: SessionEventType.ToolCallError,
    timestamp: new Date(),
    traceId: traceContext.traceId,
    sequenceNumber: 0,
    payload: {
      toolCallId,
      error,
      ...(skillMetadata ? { skillMetadata } : {}),
      ...(pluginId ? { pluginId } : {}),
    },
  });
}

/**
 * 为"因上游阻塞失败而被跳过"的工具调用补发 ToolCallError，并留一条 warn 日志。
 *
 * `traceContext` 可选：批量执行里跳过项可能拿不到调用级上下文，这里按
 * 入参 → `deps.traceContext` → 新建 root（sessionId + turnId）兜底，保证事件仍可关联。
 *
 * 为什么需要它：跳过不是"没发生"，模型仍必须收到该 tool_call 的配对结果；这是跨链路
 * "每个 tool_call 必须有配对结果"不变量的早退维护点之一。
 */
export async function emitSkippedToolError(
  deps: ToolExecutorDeps,
  result: ToolExecutionResult,
  traceContext?: TraceContext,
): Promise<void> {
  const eventTraceContext =
    traceContext ??
    deps.traceContext ??
    createRootTraceContext({ sessionId: deps.sessionId, turnId: deps.turnId });
  const turnId = eventTraceContext.turnId ?? deps.turnId;

  await emitToolCallError(deps, result.toolCallId, eventTraceContext, turnId, result.error);

  deps.logger?.warn("Tool call skipped after blocking failure", {
    ...traceContextToLogContext(eventTraceContext),
    event: "tool.call.skipped",
    module: "core.tool.executor",
    status: "failed",
    toolCallId: result.toolCallId,
    toolName: result.toolName,
  });
}

/**
 * 发布 PermissionRequested：审批门打开时的一次性事件，后续由 PermissionResolved 配对。
 *
 * 输入：`requestId` 由审批层生成；`input` 是**将要执行**的输入（已过 hook rewrite），
 * 不是模型原始入参；`suggestedPermissionUpdates` 是"记住选择"的候选更新。
 *
 * `fullAccessSupported` 只在非 user-once 且会话模式端口支持全量授权时出现——客户端据此
 * 决定是否展示"完全访问"选项。副作用：写一条 SessionEvent。
 */
export async function emitPermissionRequested(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  input: unknown,
  requestId: string,
  riskLevel: PermissionContext["riskLevel"],
  reason: string | undefined,
  suggestedPermissionUpdates: PermissionUpdate[],
  traceContext: TraceContext,
  approval?: {
    approvalMode?: "user-once";
    display?: ToolResultDisplayPayload;
    optionsPolicy?: PermissionOptionsPolicy;
  },
): Promise<void> {
  await deps.emitEvent({
    id: crypto.randomUUID() as any,
    sessionId: deps.sessionId,
    turnId: traceContext.turnId ?? deps.turnId,
    type: SessionEventType.PermissionRequested,
    timestamp: new Date(),
    traceId: traceContext.traceId,
    sequenceNumber: 0,
    payload: {
      requestId,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      riskLevel,
      reason: reason ?? `Tool ${toolCall.name} requires approval`,
      input,
      suggestedPermissionUpdates,
      ...(approval?.approvalMode ? { approvalMode: approval.approvalMode } : {}),
      ...(approval?.display ? { display: approval.display } : {}),
      ...(approval?.optionsPolicy ? { optionsPolicy: approval.optionsPolicy } : {}),
      ...(approval?.approvalMode !== "user-once" &&
      deps.sessionModePort?.supportsPermissionFullAccess?.()
        ? { fullAccessSupported: true }
        : {}),
    },
  });
}

/**
 * 发布 PermissionResolved：审批结果与 requestId 配对。
 *
 * `modifiedInput` 是审批方改写后的输入；存在时执行器必须使用这一份，而不是原输入。
 * `decision.decision` 是稳定枚举（allow/deny/...），`reason` 只供展示，不能用于流程判断。
 *
 * 副作用：写一条 SessionEvent；不改变权限状态本身（状态由审批层维护）。
 */
export async function emitPermissionResolved(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  requestId: string,
  decision: PermissionBrokerResult,
  traceContext: TraceContext,
): Promise<void> {
  await deps.emitEvent({
    id: crypto.randomUUID() as any,
    sessionId: deps.sessionId,
    turnId: traceContext.turnId ?? deps.turnId,
    type: SessionEventType.PermissionResolved,
    timestamp: new Date(),
    traceId: traceContext.traceId,
    sequenceNumber: 0,
    payload: {
      requestId,
      toolCallId: toolCall.id,
      decision: decision.decision,
      reason: decision.reason,
      modifiedInput: decision.modifiedInput,
    },
  });
}

/**
 * 发布 PermissionDenied：拒绝路径的独立事件（与 PermissionResolved 的 deny 互补，
 * 供只在 deny 上做展示的客户端使用）。
 *
 * `inputSummary` 只含形状摘要（type/keys/长度），**绝不带输入值**——避免把命令原文、
 * 文件内容等敏感数据写进事件与持久化日志。
 *
 * 副作用：写一条 SessionEvent。
 */
export async function emitPermissionDenied(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  reason: string | undefined,
  traceContext: TraceContext,
): Promise<void> {
  await deps.emitEvent({
    id: crypto.randomUUID() as any,
    sessionId: deps.sessionId,
    turnId: traceContext.turnId ?? deps.turnId,
    type: SessionEventType.PermissionDenied,
    timestamp: new Date(),
    traceId: traceContext.traceId,
    sequenceNumber: 0,
    payload: {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      reason: reason ?? `Permission denied for ${toolCall.name}`,
      inputSummary: summarizeInput(toolCall.input),
    },
  });
}
