/**
 * ============================================================================
 * runtime/helpers/turn-errors.ts —— 轮次错误的分类、收敛与终态事件
 * ============================================================================
 *
 * 【定位】turn 的 catch 块最终都走这里，完成三件事：
 *   1) 把任意异常归一成 CoreError（createTurnFailureError）；
 *   2) 决定"这是取消还是失败"（isTurnCancellationError）；
 *   3) 发终态事件：取消 → TurnComplete(resultType="cancelled")，
 *      真实失败 → TurnError（appendTurnOutcomeEvent）。
 *
 * 【为什么取消不能发 TurnError】reducer/UI/桌面端会把 TurnError 统一映射成
 *   turn.failed（status=error + 追加错误消息）。用户主动中断是正常结束，
 *   必须干净回到 idle，否则每次 ESC 都会留下一条红色错误。
 *
 * 【外部宿主故障】createExternalTurnFaultError 用 zcodeTurnFault 标记，
 *   穿透 6 层 cause 链仍能识别：即使 abortSignal 已被同一次中止触发，
 *   也判定为"宿主故障"而不是"用户取消"，从而持久化 TurnError。
 *
 * 【wrapper 角色】turn 级 UnknownError 只是生命周期外壳，标记 Wrapper 后
 *   错误投影会跳过它，展示下层 provider/tool 的真实根因。
 *
 * 【读法】先把本文件当作"取消/失败"的唯一判定口径，再看 turn-stop.ts 与
 *   methods/turn.ts 的 catch 如何调用 appendTurnOutcomeEvent。这里不包含任何
 *   重试策略——是否重试由 turn-model-step 的恢复链决定。
 * ============================================================================
 */

import {
  CoreErrorType,
  SessionEventType,
  createCoreError,
  createModelUsageSummaryFromEvents,
  isCoreError,
  traceContextToLogContext,
} from "../deps.js";
import type { SessionEvent, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  ErrorPayloadRole,
  projectExecutionErrorPayload,
  withErrorPayloadRole,
} from "../../errors/error-payload.js";
import { isModelContextExceededError } from "./model-errors.js";

export { projectExecutionErrorPayload } from "../../errors/error-payload.js";

/**
 * turn 级取消作用域。
 * dispose：只解绑父 signal 的监听，不主动 abort（turn 正常结束时调用）。
 * signal：turn 自己的 controller.signal，下游只应消费它，避免父子生命周期串味。
 */
interface TurnAbortScope {
  dispose: () => void;
  signal: AbortSignal;
}

/** 打在 Error 上的标记值；用字符串常量而非 Symbol，保证跨序列化/跨层包装后仍可识别。 */
const EXTERNAL_TURN_FAULT_MARKER = "zcode.externalTurnFault";

/**
 * 宿主故障错误的形状：Error 上额外挂 code（宿主错误码）与 zcodeTurnFault 标记。
 * code 会被写入 TurnError.error.type，因此必须稳定可枚举，便于 UI 归因。
 */
interface ExternalTurnFaultError extends Error {
  code: string;
  zcodeTurnFault: typeof EXTERNAL_TURN_FAULT_MARKER;
}

/** 宿主用此窄入口中止 turn，同时要求 core 持久化 TurnError 而不是用户取消。 */
export function createExternalTurnFaultError(code: string, message = code): Error {
  return Object.assign(new Error(message), {
    code,
    zcodeTurnFault: EXTERNAL_TURN_FAULT_MARKER as typeof EXTERNAL_TURN_FAULT_MARKER,
  }) satisfies ExternalTurnFaultError;
}

/**
 * 沿 cause 链（≤6 层）寻找宿主故障标记；命中要求"是 Error 且 code 为字符串"。
 * 失败语义：null 表示不是宿主故障；检测到环/超深也返回 null（保守判定为用户侧）。
 * 纯查询，无副作用。为什么要遍历：宿主通常把错误包在自己的 Error 里再 abort，
 *   标记必须穿透包装层才不会被误判成用户取消。
 */
function findExternalTurnFault(error: unknown): ExternalTurnFaultError | null {
  let current = error;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= 6; depth += 1) {
    if (!current || typeof current !== "object" || seen.has(current)) return null;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (
      record.zcodeTurnFault === EXTERNAL_TURN_FAULT_MARKER &&
      typeof record.code === "string" &&
      current instanceof Error
    ) {
      return current as ExternalTurnFaultError;
    }
    current = record.cause;
  }
  return null;
}

/**
 * 创建 turn 级 AbortScope：把父 signal 的取消"转发"成 turn 自己的 controller。
 *
 * 不直接复用父 signal 的原因：turn 结束后需要 dispose 监听，避免长会话里
 * 每个 turn 都往父 signal 上挂一个永不释放的 listener。
 * 父已取消时立即同步 abort，并返回空 dispose。
 */
export function createTurnAbortScope(parentSignal?: AbortSignal): TurnAbortScope {
  const controller = new AbortController();

  const abortTurn = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason);
    }
  };

  if (parentSignal?.aborted) {
    abortTurn();
    return { dispose: () => {}, signal: controller.signal };
  }

  parentSignal?.addEventListener("abort", abortTurn, { once: true });

  return {
    dispose: () => {
      parentSignal?.removeEventListener("abort", abortTurn);
    },
    signal: controller.signal,
  };
}

/**
 * 同步检查点：signal 已中止则抛 TurnCancelled，否则静默返回。
 * 供"发请求前/执行工具前"等边界显式插入，确保取消后不再产生新的副作用。
 * 副作用：无（只抛错）；抛出的错误带 signal.reason 作为 cause，便于诊断真实中止原因。
 */
export function throwIfTurnAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw createTurnCancelledError(signal.reason);
}

/**
 * 把任意异常归一成 turn 级 CoreError。判定优先级：
 *   1) 外部宿主故障（zcodeTurnFault）：UnknownError 但保留原 message 与 cause，
 *      recoverable=true——宿主要求持久化失败，不是用户取消；
 *   2) 取消（isTurnCancellationError）：TurnCancelled；
 *   3) 已是 ModelContextExceeded，或 fallback 是默认文案且错误是 ModelError：
 *      原样返回（这两类已有稳定语义，不能再包一层）；
 *   4) 可识别的上下文超窗错误 → ModelContextExceeded(retryable)；
 *   5) 其余 → UnknownError(fallbackMessage)，标 Wrapper，让下层根因浮出。
 */
export function createTurnFailureError(
  error: unknown,
  abortSignal: AbortSignal | undefined,
  fallbackMessage: string,
) {
  const externalFault = findExternalTurnFault(abortSignal?.reason) ?? findExternalTurnFault(error);
  if (externalFault) {
    return createCoreError(CoreErrorType.UnknownError, externalFault.message, {
      cause: externalFault,
      recoverable: true,
    });
  }
  if (isTurnCancellationError(error, abortSignal)) {
    return createTurnCancelledError(error);
  }

  if (
    isCoreError(error) &&
    (error.type === CoreErrorType.ModelContextExceeded ||
      (fallbackMessage === "Turn execution failed" && error.type === CoreErrorType.ModelError))
  ) {
    return error;
  }

  if (isModelContextExceededError(error)) {
    return createCoreError(
      CoreErrorType.ModelContextExceeded,
      "Model request exceeded the provider context window.",
      { cause: error instanceof Error ? error : undefined, recoverable: true, retryable: true },
    );
  }

  return createCoreError(CoreErrorType.UnknownError, fallbackMessage, {
    cause: error instanceof Error ? error : undefined,
    // turn 级 UnknownError 只是统一生命周期包装；UI/error payload
    // 需要展示下层 provider/tool 给出的用户可读根因，不能让泛化文案抢占摘要。
    context: withErrorPayloadRole(undefined, ErrorPayloadRole.Wrapper),
  });
}

/**
 * 把任意值收敛成 TurnCancelled CoreError。
 * 已是该类型则原样返回（保留原始 cause 与上下文）；否则包一层并挂 Error cause。
 * recoverable=true：取消不是系统故障，UI 应回到 idle 而不是给"错误"恢复动作。
 * 纯工厂；不发事件，事件由 appendTurnOutcomeEvent 统一发。
 */
export function createTurnCancelledError(error: unknown) {
  if (isCoreError(error) && error.type === CoreErrorType.TurnCancelled) {
    return error;
  }

  return createCoreError(CoreErrorType.TurnCancelled, "Turn was cancelled.", {
    cause: error instanceof Error ? error : undefined,
    recoverable: true,
  });
}

/**
 * 发 turn 终态事件。
 *
 * 用户主动中断（TurnCancelled）属于正常结束，不应记为错误。turn/compact/rewind
 * 三处 catch 之前都无条件 emit TurnError，会被 reducer/UI/桌面统一映射成
 * turn.failed（status:error、追加错误消息）；这里统一收口：
 * 取消改发 TurnComplete(resultType="cancelled") 让状态干净回到 idle，真实错误才发 TurnError。
 * 调用方仍负责向上 throw coreError 与记录 usage。
 *
 * 取消：TurnComplete + resultType="cancelled"（token/tool 计数为 0，
 *   usage 仍从事件流汇总，保留"取消前已消耗"的事实）。
 * 失败：TurnError，错误体用 projectExecutionErrorPayload 投影后的根因 +
 *   attribution（highspeedCardId / highspeedFallbackUnavailable 等结构化字段）。
 *
 * 无论哪种结局都记 error 级日志（cancelled 标 status=cancelled），
 * 并把事件 push 进本 turn 的 events，保证后续 usage/诊断能看到终态。
 */
export async function appendTurnOutcomeEvent(
  runtime: AgentRuntimeInternal,
  params: {
    coreError: ReturnType<typeof createTurnFailureError>;
    /** 本 turn 已累积的事件流；终态事件会 push 进来，供 usage 汇总与诊断读取。 */
    events: SessionEvent[];
    /** turn 从开始到收口的耗时（毫秒），写入 TurnComplete.duration。 */
    durationMs: number;
    /** 收口发生的阶段（request/tool/stop 等），写入 TurnError.turnPhase 帮助归因。 */
    turnPhase: string;
    /** 触发本 turn 的输入 id（用户输入或自动派发输入），用于事件回溯。 */
    inputId?: string;
    /** 创建期高速卡关联 id；null 与缺省有语义差异，这里由调用方显式传入或落 null。 */
    highspeedCardId?: string;
    /** 已归因且无处可退时置 true，作为结构化事实发布给 Renderer，不让其按错误码推断。 */
    highspeedFallbackUnavailable?: boolean;
    /** 本 turn 的 trace 上下文，用于事件与日志关联；不可在此重建新 trace。 */
    traceContext: TraceContext;
    /** 兜底文案：仅当错误自身没有可读根因时用于展示。 */
    fallbackMessage: string;
    /** 日志事件名（如 turn.failed），供监控按事件聚合。 */
    logEvent: string;
    /** 日志前缀（如 "Turn"），与 status 组合成可读日志行。 */
    logLabel: string;
    /** 取消时是否保留队列自动 drain（避免用户中断把后续排队输入一并取消）。 */
    preserveQueueAutoDrainOnCancel?: boolean;
    /** 本轮是否已消费子代理后台结果，写入终态事件供续跑判定。 */
    backgroundSubagentResultConsumed?: boolean;
    /** 本轮是否已消费工作流后台结果，写入终态事件供续跑判定。 */
    workflowResultConsumed?: boolean;
    /** 本轮历史轮数；取消终态写 0 以外的真实值以便 usage/诊断对齐。 */
    historyRoundCount?: number;
  },
): Promise<void> {
  const { coreError, events, traceContext, turnPhase, inputId } = params;
  const cancelled = coreError.type === CoreErrorType.TurnCancelled;
  const externalFault = findExternalTurnFault(coreError);
  const projectedError = projectExecutionErrorPayload(coreError, params.fallbackMessage);

  const outcomeEvent = cancelled
    ? runtime.createEvent(
        SessionEventType.TurnComplete,
        {
          response: "",
          tokenCount: 0,
          usage: createModelUsageSummaryFromEvents(events),
          toolCallCount: 0,
          historyRoundCount: params.historyRoundCount ?? 0,
          duration: params.durationMs,
          resultType: "cancelled",
          inputId,
          ...(params.backgroundSubagentResultConsumed
            ? { backgroundSubagentResultConsumed: true }
            : {}),
          ...(params.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
          ...(params.preserveQueueAutoDrainOnCancel
            ? { preserveQueueAutoDrainOnCancel: true }
            : {}),
        },
        traceContext,
      )
    : runtime.createEvent(
        SessionEventType.TurnError,
        {
          error: {
            type: externalFault?.code ?? coreError.type,
            // coreError.message 常是泛化文案，真实 provider/network 原因藏在 cause 链里；
            // 写入可读 payload fields 让桌面端和恢复链路都能展示根因。
            ...projectedError,
            attribution: {
              ...projectedError.attribution,
              // Bug 根因：创建期尚无 userInput 行。每个新错误都发布 string/null，
              // 让 Renderer 区分“普通轮”与“旧 Agent 没有该字段”。
              highspeedCardId: params.highspeedCardId ?? null,
              // 无处可退时没有 fallback 事件，且请求期失败的 code 是 provider 错误码（如 3402），
              // Renderer 不能按错误码推断退卡；由 Core 把“已归因且无处可退”作为结构化事实发布。
              ...(params.highspeedFallbackUnavailable
                ? { highspeedFallbackUnavailable: true }
                : {}),
            },
            stack: coreError.stack,
          },
          turnPhase,
          inputId,
          ...(params.backgroundSubagentResultConsumed
            ? { backgroundSubagentResultConsumed: true }
            : {}),
          ...(params.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
        },
        traceContext,
      );
  await runtime.appendEvent(outcomeEvent, traceContext);
  events.push(outcomeEvent);

  runtime.logger?.error(`${params.logLabel} failed`, coreError, {
    ...traceContextToLogContext(traceContext),
    event: params.logEvent,
    module: "core.runtime",
    status: cancelled ? "cancelled" : "failed",
    turnPhase,
  });
}

/**
 * 判断"取消" vs "失败"。
 *
 * 先排除外部宿主故障（即使 signal 已 abort，也必须是失败）；
 * 再看 signal.aborted（取消通常伴随 signal）；
 * 最后沿 cause 链（最多 6 层）找取消标记：CoreError.TurnCancelled、type/code、
 * MODEL_REQUEST_CANCELLED、ABORT_ERR、AbortError。
 * 多来源识别是必要的：不同 adapter/旧版本用不同字段表达同一次取消。
 */
export function isTurnCancellationError(error: unknown, abortSignal?: AbortSignal): boolean {
  if (findExternalTurnFault(abortSignal?.reason) || findExternalTurnFault(error)) return false;
  if (abortSignal?.aborted) return true;

  let current = error;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= 6; depth += 1) {
    if (current === undefined || current === null) return false;
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);

    if (isCoreError(current) && current.type === CoreErrorType.TurnCancelled) {
      return true;
    }

    const record = current as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    const code = typeof record.code === "string" ? record.code : undefined;
    const name = typeof record.name === "string" ? record.name : undefined;
    if (
      type === CoreErrorType.TurnCancelled ||
      code === CoreErrorType.TurnCancelled ||
      code === "MODEL_REQUEST_CANCELLED" ||
      code === "model_request_cancelled" ||
      code === "ABORT_ERR" ||
      name === "AbortError"
    ) {
      return true;
    }

    current = record.cause;
  }

  return false;
}
