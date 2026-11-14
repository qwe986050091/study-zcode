import { requestVerificationDiagnostics } from "@zcode/shared";
import { CoreErrorType, ModelErrorCode, createCoreError, isCoreError } from "../deps.js";
import type { ModelUsage } from "../deps.js";
import { isPlainRecord, stringProperty } from "./data.js";
import {
  createCoreErrorFromProviderBusinessLike,
  findProviderBusinessFailureInMetadata,
} from "./provider-business-error.js";

/**
 * 从 providerMetadata 读取原始 finish reason（`rawFinishReason`）。
 * 只认 string，其余类型/缺省一律 undefined；纯读，不做归一化。
 */
export function readRawFinishReason(
  providerMetadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!providerMetadata) return undefined;
  const direct = providerMetadata.rawFinishReason;
  return typeof direct === "string" ? direct : undefined;
}

/**
 * 判断 finishReason 或 provider 原始 finishReason 是否表达"上下文超窗"。
 * 两个来源都要看：adapter 归一化可能改写了 finishReason，而 raw 才是 provider 原话。
 * 纯函数；任一命中即 true（宽松判定，宁可多识别超窗也不能漏成普通失败）。
 */
export function isContextExceededFinishReason(
  finishReason: string | undefined,
  rawFinishReason: string | undefined,
): boolean {
  return (
    isModelContextExceededMarker(finishReason) || isModelContextExceededMarker(rawFinishReason)
  );
}

/**
 * 构造"provider 上下文窗口超限"的 CoreError。
 * 输入：归一化与原始 finish reason（用于诊断与被 UI 展示）。
 * 输出：CoreErrorType.ModelContextExceeded，recoverable/retryable 均为 true——
 *   该错误可由 reactive compact 或下一次请求恢复，不属于终态失败。
 * 副作用：无；纯工厂函数，不发事件、不落盘。
 */
export function createModelContextExceededFinishError(input: {
  finishReason: string | undefined;
  rawFinishReason: string | undefined;
}) {
  return createCoreError(
    CoreErrorType.ModelContextExceeded,
    "Model request exceeded the provider context window.",
    {
      context: {
        finishReason: input.finishReason,
        rawFinishReason: input.rawFinishReason,
      },
      recoverable: true,
      retryable: true,
    },
  );
}

/**
 * 构造"压缩后快速重填熔断"错误（rapid-refill breaker）。
 * 场景：连续多次压缩后仅隔很少工具轮上下文又被填满，继续压缩无意义，必须让本轮失败。
 * 类型刻意复用 ModelContextExceeded：让 UI/错误投影命中既有的"上下文超窗"文案与恢复动作；
 * context.reason="compact_rapid_refill_breaker" 保留结构化归因以便遥测区分真实超窗。
 * 纯工厂；recoverable/retryable 为 true（信息可被上层继续观察），真正终止由 turn-loop 抛出决定。
 */
export function createCompactRapidRefillError(input: {
  consecutiveRapidRefills: number;
  maxConsecutiveRapidRefills: number;
  toolTurnThreshold: number;
  toolTurnsSinceCompact: number;
}) {
  return createCoreError(
    CoreErrorType.ModelContextExceeded,
    `Autocompact stopped because the context refilled within fewer than ${input.toolTurnThreshold} tool turns after compaction ${input.maxConsecutiveRapidRefills} times in a row. A file or tool output may be too large. Read it in smaller chunks, or start a new session.`,
    {
      context: {
        consecutiveRapidRefills: input.consecutiveRapidRefills,
        maxConsecutiveRapidRefills: input.maxConsecutiveRapidRefills,
        reason: "compact_rapid_refill_breaker",
        toolTurnsSinceCompact: input.toolTurnsSinceCompact,
        toolTurnThreshold: input.toolTurnThreshold,
      },
      recoverable: true,
      retryable: true,
    },
  );
}

/**
 * 判定"可疑空响应"：无文本、无工具调用、finish 不是正常终态、usage 全零。
 * isNonStopFinish 把 stop / tool-calls 视为正常结束；其余（length、error、空值等）
 *   都可能是 provider 异常中断，因此必须与"真的空回答"区分。
 * isZeroUsage 在 usage 缺失时也按零处理：没有 usage 比"零 usage"更可疑。
 * 纯函数；只做判定，不抛错、不记录。
 */
export function isSuspiciousEmptyModelResult(
  finishReason: string | undefined,
  responseLength: number,
  toolCallCount: number,
  usage?: ModelUsage,
): boolean {
  return (
    responseLength === 0 &&
    toolCallCount === 0 &&
    isNonStopFinish(finishReason) &&
    isZeroUsage(usage)
  );
}

const SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE =
  "Model returned no text, no tool calls, and no usage before completing the turn.";

/**
 * 构造"可疑空响应"错误：类型 ModelError、context.suspiciousEmpty=true。
 * 输入：finish reason（归一化/原始）与可选 model 身份。
 * 副作用：无。失败语义：调用方（finalizeSuspiciousEmptyModelResult）负责抛出；
 *   本函数只保证 context.reason="empty_model_response"、source="provider"，
 *   让 UI 能展示中文文案与 Coding Plan 恢复动作，监控也能按 provider/SSE 聚合。
 */
export function createSuspiciousEmptyModelResultError(
  finishReason: string | undefined,
  rawFinishReason: string | undefined,
  model?: { modelId: string; providerId: string },
) {
  return createCoreError(CoreErrorType.ModelError, SUSPICIOUS_EMPTY_MODEL_RESULT_MESSAGE, {
    context: {
      finishReason,
      ...(model ? { modelId: model.modelId, providerId: model.providerId } : {}),
      rawFinishReason,
      // UI/turn-errors 需识别空 completion，才能展示中文文案与 Coding Plan 恢复动作。
      // 空响应不能只有展示标记，否则监控无法与 provider/SSE 类故障做结构化聚合。
      reason: "empty_model_response",
      source: "provider",
      suspiciousEmpty: true,
    },
    recoverable: true,
    retryable: true,
  });
}

/** 空流终态诊断：供 core/adapters 日志与 UI 错误归因对照。 */
/**
 * 汇总空流诊断信息（写日志/遥测用，不进入用户文案）。
 * providerMetadataKeys 只取前 20 个键，避免异常 payload 撑爆日志；
 * null 表示"该事实缺席"，与空字符串区分；requestVerificationDiagnostics 提供请求校验标记。
 * 纯函数，无 I/O，不读取/不脱敏业务内容（只读结构化 code/message 摘要）。
 */
export function buildSuspiciousEmptyDiagnostics(
  input: {
    finishReason: string | undefined;
    providerMetadata: Record<string, unknown> | undefined;
    rawFinishReason: string | undefined;
    outboundHeaderKeys?: string[];
  } & Record<string, unknown>,
): Record<string, unknown> {
  const businessFailure = findProviderBusinessFailureInMetadata(input.providerMetadata);
  return {
    finishReason: input.finishReason ?? null,
    rawFinishReason: input.rawFinishReason ?? null,
    outboundHeaderKeys: input.outboundHeaderKeys ?? [],
    ...requestVerificationDiagnostics(input),
    providerMetadataKeys: input.providerMetadata
      ? Object.keys(input.providerMetadata).slice(0, 20)
      : [],
    providerBusinessCodeFromMetadata: businessFailure?.providerCode ?? null,
    providerBusinessMessageFromMetadata: businessFailure?.message ?? null,
    responseBodySummaryFromMetadata: businessFailure?.responseBodySummary ?? null,
  };
}

/**
 * 空流终态收口：先尝试从 providerMetadata 还原 provider 业务错误，再退回空响应错误。
 * 输入：finish/rawFinish/model/providerMetadata。返回类型为 void 且**必定抛错**（无正常返回）。
 * 优先级原因：adapter 偶尔把 zcode-plan 业务错误落成"空 finish + 零 usage"，
 *   若不先识别业务码，UI 会拿到泛化的 empty_model_response，错过业务错误文案。
 * 副作用：无（不落盘/不发事件）；抛出的错误由 turn 层统一收口。
 */
export function finalizeSuspiciousEmptyModelResult(input: {
  finishReason: string | undefined;
  model: { modelId: string; providerId: string };
  providerMetadata: Record<string, unknown> | undefined;
  rawFinishReason: string | undefined;
}): void {
  const providerBusinessError = tryCreateProviderBusinessModelErrorFromMetadata(
    input.providerMetadata,
    input.model,
  );
  if (providerBusinessError) {
    throw providerBusinessError;
  }

  throw createSuspiciousEmptyModelResultError(
    input.finishReason,
    input.rawFinishReason,
    input.model,
  );
}

/**
 * 从 providerMetadata 中提取 provider 业务失败（providerCode/message/响应摘要），
 * 命中时构造 ModelError，context 带 providerCode 与 source="provider"。
 * 失败语义：未命中返回 undefined（调用方继续走空响应分支）。
 * retryable=false：业务错误（如套餐/额度/风控）重试不会改变结果；
 *   recoverable=true 仍保留，让 UI 提供可操作恢复。
 * 纯工厂；不写日志（日志由外层统一记录）。
 */
export function tryCreateProviderBusinessModelErrorFromMetadata(
  providerMetadata: Record<string, unknown> | undefined,
  model?: { modelId: string; providerId: string },
): ReturnType<typeof createCoreError> | undefined {
  const failure = findProviderBusinessFailureInMetadata(providerMetadata);
  if (!failure) {
    return undefined;
  }

  // adapter 偶发把 zcode-plan 业务错误落成空 finish + 零 usage，core 会先抛 suspicious empty。
  // 在 anomaly guard 前先从 providerMetadata 恢复 providerCode（如 3007），让 UI 能命中业务错误文案。
  return createCoreError(CoreErrorType.ModelError, failure.message, {
    context: {
      ...(model ? { modelId: model.modelId, providerId: model.providerId } : {}),
      ...(failure.providerCode ? { providerCode: failure.providerCode } : {}),
      source: "provider",
      ...(failure.responseBodySummary ? { responseBodySummary: failure.responseBodySummary } : {}),
    },
    recoverable: true,
    retryable: false,
  });
}

/**
 * 判断正常终态以外的 finish：只有 stop / tool-calls / tool_calls 视为正常完成，
 * 其余（含 undefined）都可能是异常中断，交给可疑空响应判定继续核对 usage。
 */
function isNonStopFinish(finishReason?: string): boolean {
  const normalized = finishReason?.trim().toLowerCase();
  return normalized !== "stop" && normalized !== "tool-calls" && normalized !== "tool_calls";
}

/**
 * 判断 usage 是否"零消耗"：优先用 provider 给的 totalTokens；缺席时把五个分项相加。
 * usage 整体缺失也视为零——没有 usage 事实比零更像异常，交由上层判定。
 */
function isZeroUsage(usage?: ModelUsage): boolean {
  if (!usage) return true;
  const total =
    usage.totalTokens ??
    (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0) +
      (usage.reasoningTokens ?? 0);
  return total === 0;
}

/**
 * 把任意流错误归一成 Error，优先级：
 *   1) 形似 provider 业务错误 → CoreError（保留 providerCode，供 UI/恢复动作）；
 *   2) 已是 Error → 原样返回（保留 stack/identity）；
 *   3) 字符串/可 JSON 化对象 → new Error(文本)；JSON.stringify 失败退回固定文案。
 * 纯函数；不吞错、不重试；调用方负责决定重试/降级。
 */
export function normalizeStreamError(error: unknown): Error {
  const providerBusinessError = createCoreErrorFromProviderBusinessLike(error);
  if (providerBusinessError) {
    return providerBusinessError;
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(
    typeof error === "string" ? error : (JSON.stringify(error) ?? "Model stream failed"),
  );
}

const MODEL_CONTEXT_EXCEEDED_MARKERS = new Set<string>([
  CoreErrorType.ModelContextExceeded,
  ModelErrorCode.ModelContextExceeded,
  "context_exceeded",
  "context_length_exceeded",
  "context_window_exceeded",
  "model_context_window_exceeded",
  "prompt_too_long",
]);

const MODEL_MEDIA_TOO_LARGE_MARKERS = new Set<string>([
  "media_too_large",
  "media_payload_too_large",
  "image_too_large",
  "document_too_large",
]);

/**
 * 沿 cause/lastError/error 链（最多 6 层）识别"上下文超窗"，用于把不同 adapter/
 * 中间层包装过的错误统一收敛到 ModelContextExceeded 恢复路径。
 * 判定来源（任一命中即 true）：CoreError.type；record.type/code/reason/stopReason 标记；
 *   message 的 "context exceeded/too long、prompt too long" 启发式；record.context.* 标记。
 * 失败/降级：非对象、空值、超过 6 层或检测到环（WeakSet）都返回 false，不抛错。
 * 纯查询函数，无副作用；宁可漏判也不能误把普通错误升级成可压缩恢复。
 */
export function isModelContextExceededError(error: unknown): boolean {
  let current = error;
  const seen = new WeakSet<object>();

  for (let depth = 0; depth <= 6; depth += 1) {
    if (current === undefined || current === null) return false;
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);

    if (isCoreError(current) && current.type === CoreErrorType.ModelContextExceeded) {
      return true;
    }

    const record = current as Record<string, unknown>;
    if (
      isModelContextExceededMarker(stringProperty(record, "type")) ||
      isModelContextExceededMarker(stringProperty(record, "code")) ||
      isModelContextExceededMarker(stringProperty(record, "reason")) ||
      isModelContextExceededMarker(stringProperty(record, "stopReason")) ||
      isModelContextExceededMessage(stringProperty(record, "message"))
    ) {
      return true;
    }

    const context = isPlainRecord(record.context) ? record.context : undefined;
    if (
      context &&
      (isModelContextExceededMarker(stringProperty(context, "type")) ||
        isModelContextExceededMarker(stringProperty(context, "code")) ||
        isModelContextExceededMarker(stringProperty(context, "reason")))
    ) {
      return true;
    }

    current = record.cause ?? record.lastError ?? record.error;
  }

  return false;
}

/**
 * 标记集合判定：去空白 + 小写后与 MODEL_CONTEXT_EXCEEDED_MARKERS 精确匹配。
 * undefined 返回 false；不做子串匹配（子串启发式只在 message 上使用）。
 */
export function isModelContextExceededMarker(value: string | undefined): boolean {
  return value !== undefined && MODEL_CONTEXT_EXCEEDED_MARKERS.has(value.trim().toLowerCase());
}

/**
 * 识别"媒体过大"类错误（image/document/video 超限），用于走媒体降级而非上下文压缩。
 * 与 context-exceeded 共用同一条 cause 链遍历策略（≤6 层 + 环检测），但只看
 *   type/code/reason 与 message 启发式，不把 CoreError.type 当作判据（无专用类型）。
 * 纯查询；非对象/超深/环都返回 false，不抛错。
 * 口径补充：当前标记集合实际覆盖 image/document（media_too_large 为统称，video 不在此集合）。
 */
export function isModelMediaTooLargeError(error: unknown): boolean {
  let current = error;
  const seen = new WeakSet<object>();

  for (let depth = 0; depth <= 6; depth += 1) {
    if (current === undefined || current === null) return false;
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);

    const record = current as Record<string, unknown>;
    if (
      isModelMediaTooLargeMarker(stringProperty(record, "type")) ||
      isModelMediaTooLargeMarker(stringProperty(record, "code")) ||
      isModelMediaTooLargeMarker(stringProperty(record, "reason")) ||
      isModelMediaTooLargeMessage(stringProperty(record, "message"))
    ) {
      return true;
    }

    const context = isPlainRecord(record.context) ? record.context : undefined;
    if (
      context &&
      (isModelMediaTooLargeMarker(stringProperty(context, "type")) ||
        isModelMediaTooLargeMarker(stringProperty(context, "code")) ||
        isModelMediaTooLargeMarker(stringProperty(context, "reason")))
    ) {
      return true;
    }

    current = record.cause ?? record.lastError ?? record.error;
  }

  return false;
}

/**
 * 标记集合判定：去空白 + 小写后与 MODEL_MEDIA_TOO_LARGE_MARKERS 精确匹配。
 * 覆盖 media/image/document_too_large 一类 provider 自定义 code。
 */
function isModelMediaTooLargeMarker(value: string | undefined): boolean {
  return value !== undefined && MODEL_MEDIA_TOO_LARGE_MARKERS.has(value.trim().toLowerCase());
}

/**
 * message 文本启发式（仅在缺 code/type 时兜底）：同时出现 context+exceed、
 * context+too long 或 prompt+too long 视为超窗。纯字符串判定，不抛错。
 */
function isModelContextExceededMessage(value: string | undefined): boolean {
  const message = value?.trim().toLowerCase();
  if (!message) return false;
  return (
    (message.includes("context") && message.includes("exceed")) ||
    (message.includes("context") && message.includes("too long")) ||
    (message.includes("prompt") && message.includes("too long"))
  );
}

/**
 * message 文本启发式：媒体类关键词（media/image/document）叠加 too large/exceed。
 * 最后一道兜底，只在结构化字段都识别不到时使用。
 */
function isModelMediaTooLargeMessage(value: string | undefined): boolean {
  const message = value?.trim().toLowerCase();
  if (!message) return false;
  return (
    (message.includes("media") || message.includes("image") || message.includes("document")) &&
    (message.includes("too large") || message.includes("exceed"))
  );
}
