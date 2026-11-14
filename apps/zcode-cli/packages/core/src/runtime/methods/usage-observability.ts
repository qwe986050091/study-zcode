// INV-01 旁路写入：守住位置 三个 try/catch；改错故障 用量库故障导致用户任务失败。
// INV-02 只记事实不估算：守住位置 result.usage ?? 失败事件 usage；改错故障 本地猜测冒充 provider 数据。
// INV-03 能力探测而非断言：守住位置 usageStoreFor；改错故障 精简 store 上直接崩溃。
// INV-04 四方法齐备才启用：守住位置 pruneUsage 检查；改错故障 半套写入造成口径不一致。
// INV-05 主键含 attemptIndex：守住位置 modelUsageId；改错故障 重试覆盖首次请求的用量。
// INV-06 逻辑 id 有降级链：守住位置 messageId → spanId → 合成键；改错故障 流式中断时无稳定主键。
// INV-07 TTFT 只认可见增量：守住位置 text_delta / reasoning_delta；改错故障 结构化增量拉低首 token 时间。
// INV-08 空增量不算首 token：守住位置 delta.length 判断；改错故障 占位 chunk 让 TTFT 系统性偏小。
// INV-09 turn 级按事件汇总：守住位置 createModelUsageSummaryFromEvents；改错故障 两条口径对不上。
// INV-10 工具调用单行 upsert：守住位置 sessionID + toolCallId 主键；改错故障 多阶段产生多行。
// INV-11 scheduled 不预设放行：守住位置 approvalStatus: "none"；改错故障 统计低估权限拦截。
// INV-12 取消与失败分开：守住位置 errorType.includes("cancel")；改错故障 用户取消被计入错误率。
// INV-13 错误归因按可信度：守住位置 errorInfoFor 的四段；改错故障 用错误文案分类导致统计漂移。
// INV-14 计数保守收敛：守住位置 numberValue；改错故障 负数与非有限值污染统计。
//
// 模块职责：把会话事件流投影成模型请求、turn 与工具调用三张用量事实表。
// 阅读顺序：先看 model 事实，再看 turn 汇总，最后看工具状态机与几个取值工具。
/**
 * ============================================================================
 * usage-observability.ts —— 用量事实的"旁路写入"
 * ============================================================================
 *
 * 【定位】把运行过程中已经产生的事件流，投影成三张用量表：
 *   - recordModelUsageFact：单次模型请求（含重试/失败/取消）
 *   - recordTurnUsageFact：一次 turn 的汇总（请求数、工具数、首 token 时间）
 *   - recordToolUsageFromEvent：单次工具调用（审批结果、字节数、退出码）
 *
 * 【关键设计：旁路，不参与主流程】
 *   所有写入都在 try/catch 内，失败只 warn。用量统计属于可观测性，
 *   不能因为数据库写入失败而让用户的任务失败或卡住。
 *
 * 【数据来源的优先级】
 *   1) result.usage：成功请求由 provider 返回的权威值；
 *   2) model_request_failed 事件里的 usage：失败请求在中断前已上报的部分消耗。
 *   这两者缺失时宁可不写字段，也不要用本地估算冒充 provider 事实。
 *
 * 【与 turn-model-step-usage 的分工】
 *   本文件只负责"落库"；何时记、归到哪个 querySource、运行中切模如何避免
 *   归因错位，由 turn-model-step-usage 决定。
 * ============================================================================
 */

import {
  CoreErrorType,
  SessionEventType,
  createModelUsageSummaryFromEvents,
  isCoreError,
  traceContextToLogContext,
} from "../deps.js";
import type {
  MessageId,
  Model,
  ModelUsage,
  SessionEvent,
  ToolCallId,
  TraceContext,
  TurnId,
  UsageStorePort,
} from "@zcode/contracts";
import type { RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { isModelContextExceededError } from "../helpers/index.js";

type ModelUsageQuerySource =
  | "main_turn"
  | "compact"
  | "session_title"
  | "goal_completion_verification"
  | string;

interface RecordModelUsageInput {
  assistantMessageId?: MessageId;
  attemptIndex?: number;
  error?: unknown;
  events: readonly SessionEvent[];
  model: Model;
  networkEventStartIndex: number;
  parentUserMessageId?: MessageId;
  querySource: ModelUsageQuerySource;
  result?: RuntimeModelTextResult;
  startedAt: number;
  status: "completed" | "error" | "cancelled";
  toolCallCount?: number;
  traceContext: TraceContext;
}

interface RecordTurnUsageInput {
  completedAt: number;
  error?: unknown;
  events: readonly SessionEvent[];
  startedAt: number;
  status: "completed" | "error" | "cancelled";
  traceContext: TraceContext;
  turnId: TurnId;
  userMessageId?: MessageId;
}

/**
 * 写入一次"模型请求级"用量事实。
 *
 * 关键口径:
 *   - usage 优先取 result.usage;失败请求则取最后一条 model_request_failed 事件携带的 usage;
 *   - retryCount 来自本步网络事件中的 model_retry_scheduled 次数;
 *   - contextExceeded 由错误类型或网络事件 reason 判定,供统计区分"超窗"与普通失败;
 *   - 写入失败只记 warn,不能影响主流程(用量统计是旁路)。
 */
// 请求级事实：成功与失败都记。
export async function recordModelUsageFact(
  runtime: AgentRuntimeInternal,
  input: RecordModelUsageInput,
): Promise<void> {
  const usageStore = usageStoreFor(runtime);
  if (!usageStore) return;

  const completedAt = Date.now();
  const networkEvents = modelNetworkEvents(input.events.slice(input.networkEventStartIndex));
  const retryCount = networkEvents.filter((event) => event.type === "model_retry_scheduled").length;
  const failedNetworkEvent = networkEvents.findLast(
    (event) => event.type === "model_request_failed",
  );
  // 权威用量优先，其次失败前上报。
  const usage = input.result?.usage ?? failedNetworkEvent?.usage;
  const firstTokenAt = firstModelTokenAt(input.events, input.networkEventStartIndex);
  const durationMs = completedAt - input.startedAt;
  const errorInfo = errorInfoFor(input.error, failedNetworkEvent);
  const contextExceeded =
    isModelContextExceededError(input.error) || failedNetworkEvent?.reason === "context_exceeded";

  try {
    // recordModelUsage 一次写入主键、归因与用量三组字段。
    await usageStore.recordModelUsage({
      id: modelUsageId(input),
      logicalRequestId:
        input.assistantMessageId ??
        input.traceContext.spanId ??
        `${input.querySource}:${input.startedAt}`,
      attemptIndex: input.attemptIndex,
      sessionID: runtime.sessionId,
      turnID: input.traceContext.turnId,
      traceID: input.traceContext.traceId,
      spanID: input.traceContext.spanId,
      assistantMessageID: input.assistantMessageId,
      parentUserMessageID: input.parentUserMessageId,
      querySource: input.querySource,
      providerId: input.model.providerId,
      modelId: input.model.modelId,
      reasoningLevel: input.model.options.reasoningLevel,
      agent: runtime.config.agentName ?? "zcode-agent",
      mode: runtime.config.mode ?? "build",
      taskType: runtime.config.taskType ?? "interactive",
      status: input.status,
      startedAt: input.startedAt,
      firstTokenAt,
      completedAt,
      durationMs,
      timeToFirstTokenMs: firstTokenAt === undefined ? undefined : firstTokenAt - input.startedAt,
      finishReason: input.result?.finishReason,
      toolCallCount: input.toolCallCount ?? 0,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      reasoningTokens: usage?.reasoningTokens,
      cacheCreationInputTokens: usage?.cacheWriteTokens,
      cacheReadInputTokens: usage?.cacheReadTokens,
      providerTotalTokens: usage?.totalTokens,
      retryCount,
      retryable: errorInfo.retryable ?? retryCount > 0,
      cancelledByUser: input.status === "cancelled",
      contextExceeded,
      errorType: errorInfo.type,
      errorCode: errorInfo.code,
      errorMessage: errorInfo.message,
      rawUsage: usage,
      providerMetadata: input.result?.providerMetadata,
    });
  } catch (error) {
    runtime.logger?.warn("Usage model fact write failed", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "usage.model.write.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

/**
 * 写入/更新一次"turn 级"用量事实:从本 turn 的事件流汇总 usage、
 * 请求数、重试数、工具调度/错误数、首 token 时间等。
 * 与 recordModelUsageFact 互补:前者按请求,后者按 turn 归组。
 */
// turn 级事实由本 turn 事件汇总。
export async function recordTurnUsageFact(
  runtime: AgentRuntimeInternal,
  input: RecordTurnUsageInput,
): Promise<void> {
  const usageStore = usageStoreFor(runtime);
  if (!usageStore) return;

  // turn 级汇总复用 createModelUsageSummaryFromEvents，与请求级口径一致。
  const usage = createModelUsageSummaryFromEvents(input.events);
  const modelRequests = input.events.filter(
    (event) => event.type === SessionEventType.ModelRequest,
  );
  const firstModelStartAt = modelRequests[0]?.timestamp.getTime();
  const firstTokenAt = firstModelTokenAt(input.events, 0);
  const toolScheduledIds = new Set<string>();
  const toolErrorIds = new Set<string>();
  for (const event of input.events) {
    if (event.type === SessionEventType.ToolCallScheduled) {
      const payload = event.payload as { toolCallId?: string };
      if (payload.toolCallId) toolScheduledIds.add(payload.toolCallId);
    }
    if (event.type === SessionEventType.ToolCallError) {
      const payload = event.payload as { toolCallId?: string };
      if (payload.toolCallId) toolErrorIds.add(payload.toolCallId);
    }
  }

  const errorInfo = errorInfoFor(input.error, undefined);
  const contextExceeded = isModelContextExceededError(input.error);

  try {
    // upsert 保证同一 turn 只有一行。
    await usageStore.upsertTurnUsage({
      sessionID: runtime.sessionId,
      turnID: input.turnId,
      traceID: input.traceContext.traceId,
      userMessageID: input.userMessageId,
      status: input.status,
      startedAt: input.startedAt,
      firstModelStartAt,
      firstTokenAt,
      completedAt: input.completedAt,
      durationMs: input.completedAt - input.startedAt,
      timeToFirstTokenMs: firstTokenAt === undefined ? undefined : firstTokenAt - input.startedAt,
      modelRequestCount: modelRequests.length,
      modelRetryCount: modelNetworkEvents(input.events).filter(
        (event) => event.type === "model_retry_scheduled",
      ).length,
      toolCallCount: toolScheduledIds.size,
      toolErrorCount: toolErrorIds.size,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      reasoningTokens: usage?.reasoningTokens,
      cacheCreationInputTokens: usage?.cacheWriteTokens,
      cacheReadInputTokens: usage?.cacheReadTokens,
      computedTotalTokens: usage?.totalTokens,
      retryable: errorInfo.retryable,
      cancelledByUser: input.status === "cancelled",
      contextExceeded,
      errorType: errorInfo.type,
      errorCode: errorInfo.code,
    });
  } catch (error) {
    runtime.logger?.warn("Usage turn fact write failed", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "usage.turn.write.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

/**
 * 按事件流增量维护"工具调用用量"。
 *
 * 这是一个状态机式的 upsert：同一个 toolCallId 会先后收到
 * scheduled → permission_requested/resolved/denied → started → progress → result/error，
 * 每次只带当前阶段字段，其余字段由 usage store 的 upsert 保留。
 *
 * 几个刻意的口径：
 *   - scheduled 阶段 approvalStatus 记为 "none"（还没请求过审批），
 *     不能默认成 "allowed"，否则统计会低估权限拦截；
 *   - PermissionResolved 后仍是 running（用户放行不等于工具执行完成）；
 *   - ToolCallProgress 的首个非零输出时间记 firstOutputAt，用于"卡住但无输出"分析；
 *   - ToolCallResult 的 outputBytes 优先 returnedBytes（真正回灌模型的大小），
 *     没有才退回 originalBytes，便于分析截断带来的上下文成本；
 *   - ToolCallError 通过 errorType 是否含 "cancel" 区分取消与失败
 *     （取消不算错误率，但要能被审计）。
 */
// 工具事实按事件阶段增量更新。
export async function recordToolUsageFromEvent(
  runtime: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  const usageStore = usageStoreFor(runtime);
  if (!usageStore) return;

  const payload = event.payload as Record<string, unknown>;
  // 没有调用 id 的事件无法归组。
  const toolCallId = stringValue(payload.toolCallId);
  if (!toolCallId) return;

  const toolName = stringValue(payload.toolName) ?? "unknown";
  const metadata = runtime.registry.get(toolName)?.metadata;
  const startedAt = event.timestamp.getTime();
  const base = {
    id: toolUsageId(runtime.sessionId, toolCallId),
    sessionID: runtime.sessionId,
    turnID: event.turnId ?? traceContext.turnId,
    traceID: event.traceId ?? traceContext.traceId,
    toolCallID: toolCallId as ToolCallId,
    toolName,
    sideEffectScope: metadata?.sideEffectScope,
    readOnly: metadata?.readOnly,
    destructive: metadata?.destructive,
    startedAt,
  };

  try {
    // 调度阶段只说明开始运行。
    if (event.type === SessionEventType.ToolCallScheduled) {
      await usageStore.upsertToolUsage({
        ...base,
        status: "running",
        approvalStatus: "none",
      });
      return;
    }
    if (event.type === SessionEventType.PermissionRequested) {
      await usageStore.upsertToolUsage({
        ...base,
        status: "running",
        approvalStatus: "requested",
      });
      return;
    }
    if (event.type === SessionEventType.PermissionResolved) {
      const decision = stringValue(payload.decision);
      await usageStore.upsertToolUsage({
        ...base,
        status: "running",
        approvalStatus: decision === "deny" ? "denied" : "allowed",
      });
      return;
    }
    if (event.type === SessionEventType.PermissionDenied) {
      await usageStore.upsertToolUsage({
        ...base,
        status: "error",
        approvalStatus: "denied",
      });
      return;
    }
    if (event.type === SessionEventType.ToolCallStarted) {
      const payloadStartedAt =
        payload.startedAt instanceof Date ? payload.startedAt.getTime() : startedAt;
      await usageStore.upsertToolUsage({
        ...base,
        startedAt: payloadStartedAt,
        status: "running",
      });
      return;
    }
    if (event.type === SessionEventType.ToolCallProgress) {
      const outputBytes = numberValue(payload.outputBytes);
      const stdoutBytes = numberValue(payload.stdoutBytes);
      const stderrBytes = numberValue(payload.stderrBytes);
      await usageStore.upsertToolUsage({
        ...base,
        status: "running",
        firstOutputAt:
          outputBytes > 0 || stdoutBytes > 0 || stderrBytes > 0
            ? event.timestamp.getTime()
            : undefined,
        outputBytes,
        stdoutBytes,
        stderrBytes,
      });
      return;
    }
    // 结果阶段记录退出码与真实输出字节。
    if (event.type === SessionEventType.ToolCallResult) {
      const result = payload.result as Record<string, unknown> | undefined;
      const performance = result?.perf as Record<string, unknown> | undefined;
      const detail = performance?.detail as Record<string, unknown> | undefined;
      const command =
        detail?.kind === "command"
          ? (detail.command as Record<string, unknown> | undefined)
          : undefined;
      await usageStore.upsertToolUsage({
        ...base,
        status: "completed",
        completedAt: event.timestamp.getTime(),
        durationMs: numberValue(payload.duration),
        exitCode: numberValue(command?.exitCode),
        outputBytes: numberValue(result?.returnedBytes ?? result?.originalBytes),
        truncated: result?.truncated === true,
      });
      return;
    }
    if (event.type === SessionEventType.ToolCallError) {
      const error = payload.error as Record<string, unknown> | undefined;
      const errorType = stringValue(error?.type) ?? CoreErrorType.ToolExecutionFailed;
      await usageStore.upsertToolUsage({
        ...base,
        // errorType 含 cancel 时 status 记 cancelled，不混入 error 计数。
        status: errorType.includes("cancel") ? "cancelled" : "error",
        completedAt: event.timestamp.getTime(),
        cancelledByUser: errorType.includes("cancel"),
        errorType,
        errorCode: stringValue(error?.code),
        errorMessage: stringValue(error?.message),
      });
    }
  } catch (error) {
    runtime.logger?.warn("Usage tool fact write failed", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "usage.tool.write.failed",
      module: "core.runtime",
      status: "failed",
      toolCallId,
    });
  }
}

/**
 * 能力探测：sessionStore 只有在同时具备 4 个方法时才当作 UsageStorePort。
 *
 * 用"能力探测"而不是类型断言，是因为测试替身/精简 store 可能只实现会话读写；
 * 缺任一方法就整体降级为"不记用量"，避免半套写入造成统计口径不一致。
 */
// 四个方法齐备才当作用量端口。
function usageStoreFor(runtime: AgentRuntimeInternal): UsageStorePort | undefined {
  const candidate = runtime.sessionStore as Partial<UsageStorePort> | undefined;
  return candidate?.recordModelUsage &&
    candidate.upsertTurnUsage &&
    candidate.upsertToolUsage &&
    candidate.pruneUsage
    ? (candidate as UsageStorePort)
    : undefined;
}

/**
 * 模型用量主键：querySource + 逻辑请求 id + attemptIndex。
 *
 * attemptIndex 必须进主键：同一个 assistantMessageId 的首次请求与重试是两条
 * 独立用量事实，只按 message id 会互相覆盖，重试成本就统计不到。
 * 逻辑请求 id 的降级链保证消息 id 缺失（流式中断）时仍有稳定键。
 */
// 重试是独立事实，必须进主键。
function modelUsageId(input: RecordModelUsageInput): string {
  const logicalId =
    input.assistantMessageId ??
    input.traceContext.spanId ??
    `${input.querySource}_${input.startedAt}`;
  return `usage_model_${input.querySource}_${logicalId}_${input.attemptIndex ?? 0}`;
}

// 工具用量主键 = session + toolCallId：同一次工具调用跨多阶段只产生一行，
// 阶段信息靠 upsert 合并；toolCallId 在 session 内唯一，无需再加 turnId。
function toolUsageId(sessionId: string, toolCallId: string): string {
  return `usage_tool_${sessionId}_${toolCallId}`;
}

/**
 * 提取网络状态事件 payload（重试计划、请求失败等）。
 *
 * 这里刻意做运行时形状过滤：事件 payload 可能来自旧版本或损坏数据，
 * 只有带 type 的对象才参与统计，避免访问 undefined.reason 直接抛错。
 */
function modelNetworkEvents(events: readonly SessionEvent[]) {
  return events
    .filter((event) => event.type === SessionEventType.ModelNetworkStatus)
    .map((event) => event.payload)
    .filter(
      (
        payload,
      ): payload is {
        type: string;
        reason?: string;
        retryable?: boolean;
        message?: string;
        usage?: ModelUsage;
      } => Boolean(payload && typeof payload === "object" && "type" in payload),
    );
}

/**
 * 首个可见 token 的时间戳（TTFT 口径）。
 *
 * 只认 text_delta / reasoning_delta 且内容非空：
 *   - 忽略 tool_call_delta 之类"结构化增量"，它们不是用户看到的输出；
 *   - 空 delta（有些 provider 先发占位 chunk）不能算首 token，
 *     否则 TTFT 会被系统性低估。
 */
function firstModelTokenAt(
  events: readonly SessionEvent[],
  startIndex: number,
): number | undefined {
  for (const event of events.slice(startIndex)) {
    if (event.type !== SessionEventType.ModelStreaming) continue;
    const payload = event.payload as { delta?: string; kind?: string };
    if (
      (payload.kind === "text_delta" || payload.kind === "reasoning_delta") &&
      payload.delta &&
      payload.delta.length > 0
    ) {
      return event.timestamp.getTime();
    }
  }
  return undefined;
}

/**
 * 统一错误归因，按"信息可信度"从高到低取：
 *   1) CoreError：有稳定 type/code/retryable，直接采信；
 *   2) 普通 Error + 失败网络事件：message 用 Error，type/retryable 用网络事件的 reason
 *      （provider 拒绝等语义只在事件里）；
 *   3) 只有网络事件：全部取自事件；
 *   4) 什么都没有：返回空对象（调用方写 undefined 字段）。
 * 不用错误文案做分类，避免本地化/措辞变化导致统计漂移。
 */
function errorInfoFor(
  error: unknown,
  failedNetworkEvent: { reason?: string; retryable?: boolean; message?: string } | undefined,
): { code?: string; message?: string; retryable?: boolean; type?: string } {
  if (isCoreError(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      type: error.type,
    };
  }
  if (error instanceof Error) {
    return {
      message: error.message,
      retryable: failedNetworkEvent?.retryable,
      type: failedNetworkEvent?.reason ?? error.name,
    };
  }
  if (failedNetworkEvent) {
    return {
      message: failedNetworkEvent.message,
      retryable: failedNetworkEvent.retryable,
      type: failedNetworkEvent.reason,
    };
  }
  return {};
}

// 空串等同于缺失：统计字段里空字符串没有意义，会让"未知"和"空值"混在一起。
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// 计数类字段的保守收敛：非有限值记 0，负数夹到 0（中止/旧数据可能给负值）。
function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
