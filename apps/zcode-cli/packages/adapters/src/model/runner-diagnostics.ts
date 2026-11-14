// INV-01 只汇总不改写：守住位置 诊断函数体；改错故障：诊断篡改 chunk，后续消费拿到脏数据。
// INV-02 脏数据不抛：守住位置 类型兜底；改错故障：一个异常 chunk 中断整条流。
// INV-03 四条件判定：守住位置 可疑完成判断；改错故障：合法空对象被误报为异常完成。
// INV-04 停止原因归一：守住位置 大小写与空白处理；改错故障：正常停止被当成可疑完成。
// INV-05 用量求和：守住位置 分项回退；改错故障：缓存读取被忽略，零用量误判。
// INV-06 服务器工具：守住位置 请求计数；改错故障：仅调工具无文本被当成零用量。
// INV-07 推理签名：守住位置 元数据判断；改错故障：带签名的空推理被丢弃。
// INV-08 头值不落盘：守住位置 出站头摘要；改错故障：请求头值进入日志。
// INV-09 序列化降级：守住位置 预览的捕获；改错故障：循环引用让日志抛错。
// INV-10 预览有界：守住位置 字符上限；改错故障：超大 finish 原文写满日志。
// INV-11 空对象即省略：守住位置 摘要早退；改错故障：空 chunk 产生无意义日志。
// INV-12 业务扫描兜底：守住位置 最小 finish 源；改错故障：无 finish 原文时漏报业务码。
// INV-13 取消单列：守住位置 失败状态分支；改错故障：用户取消被记成普通失败。
// INV-14 finish 前后：守住位置 原因是否存在；改错故障：错误阶段判断失真。
// INV-15 超窗收敛：守住位置 原因集合；改错故障：各供应商命名差异导致漏判。
// INV-16 仅无输出转换：守住位置 助手内容与工具判断；改错故障：部分输出被丢弃。
// INV-17 重试排除：守住位置 排除集合；改错故障：确定性终态被反复重试。
// INV-18 纯日志副作用：守住位置 模块体；改错故障：诊断层引入网络或落盘。
//
// 模块职责：runner-diagnostics 累积模型调用诊断、输出结构化日志，并识别空完成与上下文超限；漏判会让空回复被当成成功结算。
// 状态所有权：诊断累加器由调用方持有；本模块只读改写传入对象。
// 阅读顺序：类型 → 累加器 → chunk 累积 → generate 日志 → 摘要 → stream 日志 → 空完成判定。
// ============================================================
// model/runner-diagnostics —— 模型调用诊断与“空完成”判定
// 定位：为 generate/stream 生命周期提供轻量诊断累积、结构化日志与空响应识别，
//       并决定“零输出”是否应转成上下文超限错误或走空完成重试。
// 输入：SDK chunk / 结果对象 / statusContext；输出：诊断快照、日志字段、布尔判定。
// 副作用：仅写日志（logger.info/warn/error/debug），无网络、无落盘、无持久化。
// 失败语义：诊断函数不得因脏 chunk 抛错；JSON 序列化失败时降级为结构摘要。
// 不变量：诊断只做汇总不改写 chunk；suspicious 判定要求“无文本/无工具/非 stop/零 usage”四条件同时成立。
// ============================================================
import { summarizeRequestVerificationHeaders } from "@zcode/shared";
import type { LanguageModelUsage } from "ai";
import type { Logger, ModelUsage } from "@zcode/contracts";
import { ModelErrorCode, ModelFailureReason as ModelFailureReasonValue } from "@zcode/contracts";
import { AiSdkModelAdapterError } from "./errors.js";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";
import type { AiSdkGenerateTextResult } from "./runner-runtime.js";
import { normalizeUsage } from "./runner-normalization.js";
import { asRecord, stringProperty } from "./runner-record.js";
import { modelStatusContextToLogContext, type ModelStatusContext } from "./runner-status.js";

type GenerateTextResultWithMetadata = AiSdkGenerateTextResult & {
  /** SDK 原始请求体（可能含大对象）；仅在摘要时浅读。 */
  request?: { body?: unknown };
  /** 原始响应：body/headers/id/messages/modelId/timestamp，用于诊断与溯源。 */
  response?: {
    body?: unknown;
    headers?: Record<string, string>;
    id?: string;
    messages?: unknown[];
    modelId?: string;
    timestamp?: Date;
  };
  /** 多步生成的中间步骤（若存在）。 */
  steps?: unknown[];
};

interface StreamDiagnostics {
  /** 各类 chunk 的计数，键为 chunk type（未知类型用 typeof）。 */
  chunkCounts: Record<string, number>;
  /** 流中 error chunk 数量；>0 表示 SDK 已报错。 */
  errorChunkCount: number;
  /** 最终 finishReason（SDK 归一化后的值）。 */
  finishReason?: string;
  /** 最近一个 chunk 的 type，用于判断失败发生在哪个阶段。 */
  lastChunkType?: string;
  /** 最近一个 error chunk 原文，用于错误摘要。 */
  lastErrorChunk?: unknown;
  /** 最近一个 finish chunk 原文，用于业务错误扫描。 */
  lastFinishChunk?: unknown;
  /** provider 原始 finish 原因（未归一化）。 */
  rawFinishReason?: unknown;
  /** reasoning delta 累计字符数。 */
  reasoningDeltaChars: number;
  /** 是否见到有效 reasoning（空文本但带签名也算）。 */
  hasReasoningContent: boolean;
  /** text delta 累计字符数，用于空输出判定。 */
  textDeltaChars: number;
  /** tool-call chunk 计数。 */
  toolCallCount: number;
  /** 最终 usage（来自 finish chunk）。 */
  usage?: ModelUsage;
}

/** 创建一次流式调用所需的空诊断累加器（每个物理/逻辑 attempt 各一份）。 */
export function createStreamDiagnostics(): StreamDiagnostics {
  return {
    // chunkCounts 以 chunk.type 为键，未知 chunk 退化为 typeof 结果，保证任何脏数据都能被计数。
    chunkCounts: {},
    // 三个计数与 hasReasoningContent 显式给初值：缺省 undefined 会让下游把「未观测」当成「未收到」。
    errorChunkCount: 0,
    reasoningDeltaChars: 0,
    hasReasoningContent: false,
    textDeltaChars: 0,
    toolCallCount: 0,
  };
}

/**
 * 累积单个 chunk 的诊断信息：计数、文本/推理字符数、工具调用、finish 的 usage 与错误原文。
 * 输入 chunk 可能非对象，按 typeof 兜底；原地修改 diagnostics，无返回值。
 * 注意 reasoning 空文本也可能携带签名，因此以 providerMetadata 是否存在辅助判定。
 */
export function recordStreamChunkDiagnostic(diagnostics: StreamDiagnostics, chunk: unknown): void {
  // chunk 来自 SDK 流，可能是 null 或字符串或数组；asRecord 统一兜成对象；INV-02 要求这里绝不抛错。
  const record = asRecord(chunk);
  // 非对象 chunk 没有 type 字段，用 typeof 兜底，保证 chunkCounts 仍能记录到具体形态。
  const chunkType = stringProperty(record, "type") ?? typeof chunk;
  diagnostics.lastChunkType = chunkType;
  diagnostics.chunkCounts[chunkType] = (diagnostics.chunkCounts[chunkType] ?? 0) + 1;

  if (chunkType === "text-delta") {
    // text 缺失或非字符串时 stringProperty 返回 undefined，按 0 计，避免 NaN 污染累计字符数。
    diagnostics.textDeltaChars += stringProperty(record, "text")?.length ?? 0;
    return;
  }

  if (chunkType.startsWith("reasoning-")) {
    // 空文本可能携带有效的 reasoning 签名，不能当作空超窗丢弃。
    // 判据是 providerMetadata 有键：Anthropic 系把 signature 放在元数据里，键在即视为有推理。
    diagnostics.hasReasoningContent ||= Object.keys(asRecord(record.providerMetadata)).length > 0;
  }
  if (chunkType === "reasoning-delta") {
    // 不同 SDK 版本把增量放在 delta 或 text 字段；这里两个都读，任一非空即累加。
    diagnostics.reasoningDeltaChars += stringProperty(record, "text")?.length ?? 0;
    // 用 ||= 只做补足：已经观测到的推理证据不能被后续空 delta 覆盖回 false（INV-07）。
    diagnostics.hasReasoningContent ||=
      (stringProperty(record, "delta") ?? stringProperty(record, "text") ?? "").length > 0;
    return;
  }

  if (chunkType === "tool-call") {
    // 每次工具调用独立计 1：零用量判定要靠它把「只调工具、无文本」排除在空完成之外（INV-06）。
    diagnostics.toolCallCount += 1;
    return;
  }

  if (chunkType === "finish") {
    // finishReason 缺失时沿用上一个值，避免多 finish chunk 场景把已确定的原因抹成 undefined。
    diagnostics.finishReason = stringProperty(record, "finishReason") ?? diagnostics.finishReason;
    // 原始原因先取 chunk 顶层，再取 providerMetadata：OpenAI 系多放在元数据里；
    // 该值会进日志与超窗判定，因此保留供应商原文，不在这一层做归一化。
    diagnostics.rawFinishReason =
      record.rawFinishReason ?? asRecord(record.providerMetadata).rawFinishReason;
    // 保留原始 chunk 引用而不是深拷贝：它只在可疑空完成的 warn 分支被读取，
    // 且读取路径有 2048 字符上限，不会把整段响应体写进日志。
    diagnostics.lastFinishChunk = chunk;
    // totalUsage 优先于 usage：多步生成时只有 totalUsage 含缓存与推理的汇总值。
    diagnostics.usage = normalizeUsage(
      (record.totalUsage ?? record.usage) as Partial<LanguageModelUsage> | undefined,
    );
    return;
  }

  if (chunkType === "error") {
    // error chunk 只计数并保留最后一条原文，不在这里抛错，终止由上层失败结算决定。
    diagnostics.errorChunkCount += 1;
    diagnostics.lastErrorChunk = chunk;
  }
}

/** 把结果对象按“携带 SDK 元数据”的宽类型返回，仅用于读取 response/request/steps。 */
export function getGenerateTextResultMetadata(
  result?: AiSdkGenerateTextResult,
): GenerateTextResultWithMetadata | undefined {
  // 纯类型拓宽，不做运行时拷贝；metadata 只读；避免在热路径上复制大对象。
  return result as GenerateTextResultWithMetadata | undefined;
}

/**
 * 记录 generateText 成功完成的结构化日志（耗时、finishReason、文本长度、usage、响应摘要）。
 * 若结果属于“空且非 stop”的可疑完成，额外打 warn 事件便于告警/排障。
 * 副作用仅日志；不返回结果、不改 result。
 */
export function logGenerateTextDiagnostics(input: {
  attempt: number;
  completedAt: number;
  logger?: Logger;
  result: AiSdkGenerateTextResult;
  startedAt: number;
  statusContext: ModelStatusContext;
  toolCallCount: number;
  usage: ModelUsage;
}): void {
  const resultWithMetadata = getGenerateTextResultMetadata(input.result);
  // textLength 取 SDK 聚合后的文本长度，是可疑空完成判定的第一判据。
  const textLength = input.result.text.length;
  const context = {
    ...modelStatusContextToLogContext(input.statusContext, input.attempt),
    durationMs: input.completedAt - input.startedAt,
    event: "model.sdk.generate.completed",
    finishReason: input.result.finishReason,
    module: "adapters.model",
    // providerMetadata 只取键名：值里可能含 provider 的 trace 或加密字段，原文不进日志。
    providerMetadataKeys: objectKeys(input.result.providerMetadata),
    // response.body 走摘要：字符串截 500 字符；对象只留 code/message/status，不落原始响应。
    responseBody: summarizeProviderBody(resultWithMetadata?.response?.body),
    // response.id 是供应商请求标识，用于跨系统对账；本身不含凭据。
    responseId: resultWithMetadata?.response?.id,
    status: "completed" as const,
    textLength,
    toolCallCount: input.toolCallCount,
    // usage 只输出 token 计数与 serverToolUse，不包含请求或响应正文。
    usage: summarizeModelUsage(input.usage),
  };

  input.logger?.info("AI SDK generateText resolved", context);
  if (
    isSuspiciousModelCompletion({
      finishReason: input.result.finishReason,
      textLength,
      toolCallCount: input.toolCallCount,
      usage: input.usage,
    })
  ) {
    // warn 复用同一份 context 摘要，只换 event 名：两条日志字段不会漂移。
    // 该事件是运维告警入口，因此不再追加请求头或 body 原文，避免告警链路放大暴露面。
    input.logger?.warn("AI SDK generateText returned an empty non-stop result", {
      ...context,
      event: "model.sdk.generate.suspicious_empty",
    });
  }
}

/**
 * 把 finish chunk 压缩为可安全落日志的摘要：键名、finishReason、响应状态/body、metadata 键。
 * 空对象返回 undefined（避免无意义日志）；不遍历大 body 的具体内容。
 */
// 空对象直接返回空，避免无意义日志。
// 只取键名与关键字段，不遍历大响应体，否则大对象会拖慢日志链路。
//
export function summarizeFinishChunkForDiagnostics(
  chunk: unknown,
): Record<string, unknown> | undefined {
  const record = asRecord(chunk);
  // 空对象返回 undefined：上层展开后字段直接消失，不产生「finishChunk: {}」这类无信息日志。
  if (Object.keys(record).length === 0) {
    return undefined;
  }

  // response 可能是字符串或 null；asRecord 失败即得空对象，后续可选链读 body/status。
  const response = asRecord(record.response);
  // providerMetadata 同样只用于取键名，不读取其值。
  const providerMetadata = asRecord(record.providerMetadata);
  // 逐字段显式挑取，绝不 spread record：record 可能带 request.body（完整 prompt 与鉴权头回显都在里面）。
  // 整体展开会把用户输入和凭据写进日志。
  return {
    // chunkKeys 只暴露键名，用于识别 SDK 协议漂移；不含 payload。
    chunkKeys: objectKeys(record),
    finishReason: summarizeScalar(record.finishReason),
    rawFinishReason: summarizeScalar(record.rawFinishReason),
    providerMetadataKeys: objectKeys(providerMetadata),
    // body 走 summarizeProviderBody：字符串截 500 字符、对象只保留状态类字段。
    responseBody: summarizeProviderBody(response?.body ?? record.body),
    responseStatus: summarizeScalar(response?.status),
  };
}

/** 出站请求头诊断：只记录键名与请求验证头摘要，绝不输出头值。 */
function summarizeOutboundModelHeaders(
  headers: Record<string, string> | undefined,
): Record<string, unknown> {
  // 没有出站头时返回空数组而不是 undefined：让「确实没发头」与「字段漏写」在排障时可区分。
  if (!headers) {
    return { outboundHeaderKeys: [] };
  }

  // 脱敏字段：Object.keys 只暴露头名，所有头值一律不落盘。
  // 会泄露的东西：Authorization、x-api-key、api-key、Cookie、Proxy-Authorization 都是长期凭据，
  // 值一旦进日志就等于落到本地日志文件与远端上报链路，属于不可撤销的凭据泄露。
  // 保留 outboundHeaderKeys 键名反而是排障需要的：它能说明鉴权方式是否被正确注入、有没有多余头被带出。
  // 脱敏放在这里而不交给调用方：本函数是唯一出口，收敛后调用点无法自行拼出原始 headers。
  // 调用位置也做了收敛——只在 logStreamDiagnostics 的 suspicious 空完成 warn 分支调用，
  // 正常 path 的 info 日志根本不接触 headers，把风险压在低概率分支上（INV-08）。
  return {
    outboundHeaderKeys: Object.keys(headers),
    // 请求验证头摘要由 @zcode/shared 提供：只返回存在性/指纹字段，不返回头值；
    // 当前开源版实现返回空对象。放在这里统一拼接，避免各调用点重复实现时漏掉脱敏。
    ...summarizeRequestVerificationHeaders(headers),
  };
}

/**
 * 汇总 finish 阶段业务错误扫描结果；没有 lastFinishChunk 时用已记录的 finishReason
 * 造一个最小 finish 源，保证仍能识别业务码。纯读，不修改 diagnostics。
 */
// 没有 finish 原文时用已记录原因造最小源。
// 业务码扫描因此在前置失败时仍可执行。
//
function summarizeFinishChunkBusinessScan(input: {
  providerId: string;
  providerKind?: string;
  diagnostics: StreamDiagnostics;
}): Record<string, unknown> {
  // 优先用真实的 finish 原文；没有时用已记录原因造最小源，让前置失败也能扫出业务码（INV-12）。
  // 只补 type/finishReason/rawFinishReason 三个字段；不伪造 response/body，避免摘要读到假数据。
  const finishSource =
    input.diagnostics.lastFinishChunk ??
    ({
      type: "finish",
      finishReason: input.diagnostics.finishReason,
      rawFinishReason: input.diagnostics.rawFinishReason,
    } satisfies Record<string, unknown>);

  // 业务码扫描只读 finish 源，不改 diagnostics；providerKind 决定按哪家供应商的字段取名。
  const finishBusinessError = detectProviderBusinessFinishError({
    providerId: input.providerId,
    providerKind: input.providerKind,
    source: finishSource,
  });

  return {
    // providerCode/providerMessage 是供应商回传的业务错误信封；只在可疑空完成时落日志，
    // 用于把「模型真的没输出」归因到额度不足、风控拦截等 provider 侧原因。
    finishBusinessErrorCode: finishBusinessError?.providerCode ?? null,
    finishBusinessErrorMessage: finishBusinessError?.providerMessage ?? null,
    // finishChunk 与 finishChunkPreview 都经过摘要或截断；lastErrorChunk 也只取结构，
    // 三者都不会把原始 payload 整体落盘。
    finishChunk: summarizeFinishChunkForDiagnostics(input.diagnostics.lastFinishChunk),
    finishChunkPreview: summarizeRawFinishChunkPreview(input.diagnostics.lastFinishChunk),
    lastErrorChunk: summarizeFinishChunkForDiagnostics(input.diagnostics.lastErrorChunk),
  };
}

/**
 * finish chunk 原文预览：≤2048 字符原样返回，超出截断并标 truncated；不可序列化
 * （如含循环引用）时退回结构摘要，保证日志链路永不抛错。
 */
// 短原文原样返回，超长截断并标记。
// 不可序列化时退回结构摘要，日志链路不能抛错，否则一次日志失败会中断结算。
//
function summarizeRawFinishChunkPreview(chunk: unknown): Record<string, unknown> | undefined {
  // undefined 表示没有原文，与「序列化失败」区分：后者要退回结构摘要，不能都当空处理。
  if (chunk === undefined) {
    return undefined;
  }

  try {
    const serialized = JSON.stringify(chunk);
    // 2048 字符以内用 JSON 解析回对象，保留嵌套结构便于人工阅读；
    // 上限来自 INV-10：finish chunk 可能带整段响应体，不设界会把日志写爆。
    if (serialized.length <= 2_048) {
      return JSON.parse(serialized) as Record<string, unknown>;
    }
    // 超长时只留前 2048 字符并显式标 truncated：截断点可能落在 JSON 中间，
    // 因此不再尝试解析，否则会产出半个坏 JSON 干扰日志消费方。
    return {
      truncated: true,
      preview: serialized.slice(0, 2_048),
    };
  } catch {
    // 循环引用或 BigInt 会让 JSON.stringify 抛错；此时退回结构摘要保住键名，
    // 因为一次日志序列化失败不能中断整条流（INV-09 与 INV-18）。
    return summarizeFinishChunkForDiagnostics(chunk);
  }
}

/**
 * 记录一次流式调用的完成日志：chunk 分布、字符数、finishReason、usage、是否已发 error/event。
 * 可疑空完成时追加 warn，并附出站头摘要与 finish 业务扫描，便于定位 provider 侧静默失败。
 */
export function logStreamDiagnostics(input: {
  attempt: number;
  diagnostics: StreamDiagnostics;
  durationMs: number;
  emittedError: boolean;
  emittedEvent: boolean;
  logger?: Logger;
  outboundHeaders?: Record<string, string>;
  statusContext: ModelStatusContext;
}): void {
  const context = {
    ...modelStatusContextToLogContext(input.statusContext, input.attempt),
    // chunkCounts 是 chunk.type 的直方图；只含类型名与次数，不含 payload。
    chunkCounts: input.diagnostics.chunkCounts,
    durationMs: input.durationMs,
    emittedError: input.emittedError,
    emittedEvent: input.emittedEvent,
    event: "model.sdk.stream.completed",
    errorChunkCount: input.diagnostics.errorChunkCount,
    finishReason: input.diagnostics.finishReason,
    lastChunkType: input.diagnostics.lastChunkType,
    module: "adapters.model",
    // rawFinishReason 走 summarizeScalar：供应商可能回传对象，先降级成 [object] 再落日志。
    rawFinishReason: summarizeScalar(input.diagnostics.rawFinishReason),
    reasoningDeltaChars: input.diagnostics.reasoningDeltaChars,
    status: "completed" as const,
    textDeltaChars: input.diagnostics.textDeltaChars,
    toolCallCount: input.diagnostics.toolCallCount,
    usage: summarizeModelUsage(input.diagnostics.usage),
  };

  input.logger?.info("AI SDK stream completed", context);
  if (
    isSuspiciousModelCompletion({
      finishReason: input.diagnostics.finishReason,
      textLength: input.diagnostics.textDeltaChars,
      toolCallCount: input.diagnostics.toolCallCount,
      usage: input.diagnostics.usage,
    })
  ) {
    // 出站头摘要只拼在这个 warn 分支，不进 info 的 context：
    // info 每次流式调用都写；warn 只在四条件同时成立时才写，把唯一接触请求头的位置压在低概率分支。
    // 同一分支再拼 finish 业务扫描：空回复往往源于 provider 侧额度或风控，
    // 业务码能把「模型确实没输出」与「请求被拒却返回 200」区分开。
    input.logger?.warn("AI SDK stream returned an empty non-stop result", {
      ...context,
      event: "model.sdk.stream.suspicious_empty",
      ...summarizeOutboundModelHeaders(input.outboundHeaders),
      ...summarizeFinishChunkBusinessScan({
        providerId: String(input.statusContext.providerId),
        providerKind: input.statusContext.providerKind,
        diagnostics: input.diagnostics,
      }),
    });
  }
}

/**
 * 记录流式失败日志：区分失败发生在 finish 前后（errorAfterFinish），并携带
 * 分类结果、是否可重试、是否已发 error/retry 边界事件；Cancel 单独标 status=cancelled。
 */
// 失败日志区分 finish 前后，并带分类与可重试标记。
// 取消单独标记，不与普通失败混淆。
//
export function logStreamFailureDiagnostics(input: {
  attempt: number;
  canRetry: boolean;
  diagnostics: StreamDiagnostics;
  durationMs: number;
  emittedError: boolean;
  emittedEvent: boolean;
  emittedRetryBoundaryEvent: boolean;
  error: unknown;
  failure: ClassifiedModelFailure;
  logger?: Logger;
  statusContext: ModelStatusContext;
}): void {
  // error 可能是任意抛出值（字符串、对象、AbortError），先由 toLogError 规整成 Error 再交给 logger。
  input.logger?.error("AI SDK stream failed", toLogError(input.error), {
    ...modelStatusContextToLogContext(input.statusContext, input.attempt),
    chunkCounts: input.diagnostics.chunkCounts,
    durationMs: input.durationMs,
    emittedError: input.emittedError,
    emittedEvent: input.emittedEvent,
    emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
    // finishReason 已存在说明 finish chunk 已到达后才失败，属于结算后错误，重试策略与前置失败不同（INV-14）。
    errorAfterFinish: input.diagnostics.finishReason !== undefined,
    errorChunkCount: input.diagnostics.errorChunkCount,
    event: "model.sdk.stream.failed",
    finishReason: input.diagnostics.finishReason,
    lastChunkType: input.diagnostics.lastChunkType,
    module: "adapters.model",
    rawFinishReason: summarizeScalar(input.diagnostics.rawFinishReason),
    reason: input.failure.reason,
    reasoningDeltaChars: input.diagnostics.reasoningDeltaChars,
    retryable: input.canRetry,
    // 取消是用户主动行为，单独标 cancelled，不与可重试的 failed 混在一起统计（INV-13）。
    status: input.failure.reason === ModelFailureReasonValue.Cancelled ? "cancelled" : "failed",
    // statusCode/statusMessage 来自失败分类器，已是脱敏后的描述；不在这里重新拼原始 error 文本。
    statusCode: input.failure.statusCode,
    statusMessage: input.failure.message,
    textDeltaChars: input.diagnostics.textDeltaChars,
    toolCallCount: input.diagnostics.toolCallCount,
    usage: summarizeModelUsage(input.diagnostics.usage),
  });
}

/** 记录被忽略的流式 chunk（debug 级），仅包含类型/键名等结构摘要，便于排查协议漂移。 */
export function logIgnoredStreamChunk(input: {
  attempt: number;
  chunk: unknown;
  logger?: Logger;
  statusContext: ModelStatusContext;
}): void {
  // 被忽略的 chunk 走 debug：生产不落盘，只在排查协议漂移时临时打开。
  // 摘要只含键名与 type/finishReason；不复制 payload，避免未知 chunk 携带的内容进入日志。
  input.logger?.debug("AI SDK stream chunk was ignored", {
    ...modelStatusContextToLogContext(input.statusContext, input.attempt),
    ...summarizeStreamChunk(input.chunk),
    event: "model.sdk.stream.chunk_ignored",
    module: "adapters.model",
    status: "completed",
  });
}

/**
 * provider body 摘要：字符串截取前 500 字符；对象提取 code/message/status/success 等关键字段；
 * 数组标 type=array。目的仅是日志可读性，不保留完整响应体。
 */
function summarizeProviderBody(body: unknown): Record<string, unknown> | undefined {
  // undefined 表示字段不存在，直接省略；避免日志出现 body: undefined 的噪声键。
  if (body === undefined) return undefined;
  // null 是合法响应体（部分供应商用 null 表示成功）；单独标 type，不与「没有 body」混淆。
  if (body === null) return { type: "null" };

  if (typeof body === "string") {
    // 字符串体只留前 500 字符：它可能包含模型输出或上游 error 回显，
    // 完整写入会同时放大日志体积与内容泄露面。
    return {
      length: body.length,
      preview: body.slice(0, 500),
      type: "string",
    };
  }

  if (typeof body !== "object") {
    // number/boolean 这类标量体降级输出，调用方不会因为奇怪类型拿到 undefined。
    return {
      type: typeof body,
      value: summarizeScalar(body),
    };
  }

  const record = body as Record<string, unknown>;
  // 对象体只挑状态类字段：code/message/msg/status/success 足以归因，
  // 其余字段（messages/choices/embedding 等）可能含用户内容；一律不展开。
  return {
    code: summarizeScalar(record.code),
    // 嵌套 error 交给 summarizeProviderError，同样只取 code/message/type。
    error: summarizeProviderError(record.error),
    // keys 只保留前 20 个键名，用于判断供应商返回结构是否符合预期。
    keys: objectKeys(record),
    message: summarizeScalar(record.message),
    msg: summarizeScalar(record.msg),
    status: summarizeScalar(record.status),
    // success 仅在确实是布尔时保留：字符串 "true" 不冒充成功标志，避免误判。
    success: typeof record.success === "boolean" ? record.success : undefined,
    // 数组与对象共用这个分支，用 type 区分；避免数组被当成带索引键的对象展开。
    type: Array.isArray(body) ? "array" : "object",
  };
}

/** 嵌套 error 对象摘要：只取 code/keys/message/type，非对象退化为标量摘要。 */
function summarizeProviderError(error: unknown): unknown {
  // 非对象错误（字符串/数字/null）没有可摘字段，退回标量摘要。
  if (error === undefined || error === null || typeof error !== "object") {
    return summarizeScalar(error);
  }

  const record = error as Record<string, unknown>;
  // 只取 code/message/type 与键名：嵌套 error 里可能带 request 回显或堆栈，
  // 完整展开会把请求上下文写进日志。
  return {
    code: summarizeScalar(record.code),
    keys: objectKeys(record),
    message: summarizeScalar(record.message),
    type: summarizeScalar(record.type),
  };
}

/** chunk 结构摘要：键名、类型、finishReason；用于 debug 日志，不复制 payload。 */
function summarizeStreamChunk(chunk: unknown): Record<string, unknown> {
  const record = asRecord(chunk);
  // debug 摘要只描述结构：键名、type、finishReason，任何文本字段都不进入返回值。
  return {
    chunkKeys: objectKeys(record),
    chunkType: stringProperty(record, "type") ?? typeof chunk,
    finishReason: summarizeScalar(record.finishReason),
    rawFinishReason: summarizeScalar(record.rawFinishReason),
  };
}

/** usage 摘要：仅输出 token 计数与 serverToolUse，undefined 时返回 undefined 以省略字段。 */
function summarizeModelUsage(usage?: ModelUsage): Record<string, unknown> | undefined {
  // 没有 usage 时返回 undefined：调用方展开后字段直接消失，而不是输出 usage: undefined。
  if (!usage) return undefined;
  // 只输出 token 计数与 serverToolUse：ModelUsage 是归一化后的结构，不含请求正文或工具参数。
  return {
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    serverToolUse: usage.serverToolUse,
    totalTokens: usage.totalTokens,
  };
}

/** 标量透传，复杂值降级为 "[array:N]"/"[object]"，确保日志值可序列化且不泄露内容。 */
function summarizeScalar(value: unknown): unknown {
  // 基础标量原样返回：调用方只传入 finishReason/code/status 这类短状态字段，不用于正文。
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  // 复杂值一律降级：数组只报长度，对象只报 [object]；
  // 避免 JSON.stringify 展开大对象、泄露内容；遇到循环引用时也不会抛错。
  return Array.isArray(value) ? `[array:${value.length}]` : "[object]";
}

/** 取对象键名（最多 20 个）；非对象返回 undefined。 */
function objectKeys(value: unknown): string[] | undefined {
  // 非对象（含 null/字符串）没有键名，返回 undefined 让调用方省略该字段。
  if (!value || typeof value !== "object") return undefined;
  // Object.keys 最多取 20 个键：防止超大对象把单条日志撑到不可读，也限制单条日志的体积。
  return Object.keys(value).slice(0, 20);
}

/** 流诊断的可疑空完成判定：以文本字符数/工具数/usage 为准，语义等同 generate 侧。 */
export function isSuspiciousStreamDiagnostics(diagnostics: StreamDiagnostics): boolean {
  // stream 侧以 textDeltaChars 代替 generate 的 text.length，其余三项直接透传；
  // 复用 isSuspiciousModelCompletion 同一判据，避免两条链路对「空完成」给出不同结论。
  return isSuspiciousModelCompletion({
    finishReason: diagnostics.finishReason,
    textLength: diagnostics.textDeltaChars,
    toolCallCount: diagnostics.toolCallCount,
    usage: diagnostics.usage,
  });
}

/** 明确的“超出上下文”finish 原因集合（小写），不同 provider 命名各异，统一在此收敛。 */
// 六种拼写分别来自 OpenAI/Anthropic/Google 等供应商，统一小写后在这里收敛；
// 新增供应商只补这一处，超窗判定与重试排除都会跟着生效（INV-15）。
const CONTEXT_LIMIT_FINISH_REASONS = new Set([
  "context_exceeded",
  "context_length_exceeded",
  "context_window_exceeded",
  "model_context_exceeded",
  "model_context_window_exceeded",
  "prompt_too_long",
]);

/**
 * 不允许“空完成重试”的原因集合：上下文超限已有明确失败语义，拒绝/内容过滤属于
 * 确定性终态；对这些原因重试只会放大延迟与费用，因此交回 Core 处理。
 */
const EMPTY_COMPLETION_RETRY_EXCLUSIONS = new Set([
  // 超窗原因整体展开：超窗已有明确失败语义，重试不会改变结果。
  ...CONTEXT_LIMIT_FINISH_REASONS,
  // 拒绝与内容过滤是确定性终态：重试只会放大延迟与费用（INV-17）。
  "refusal",
  "content-filter",
  "content_filter",
]);

/**
 * 把“无任何有效输出 + 明确超窗 finish”的成功终态转成 ModelContextExceeded 错误。
 * 有 assistant 内容或工具调用时返回 undefined（保留部分输出语义，不迁移 Core 续写策略）。
 * 返回的错误携带本次 usage 与 finish 上下文，供失败结算。
 */
export function createEmptyContextExceededError(input: {
  finishReason?: string;
  rawFinishReason?: unknown;
  hasAssistantContent: boolean;
  toolCallCount: number;
  usage?: ModelUsage;
}): AiSdkModelAdapterError | undefined {
  // 只转换无有效输出的明确超窗；任何 partial 都保留给原调用方，不能迁移 Core 的续写策略。
  if (input.hasAssistantContent || input.toolCallCount > 0) return undefined;
  // finishReason 与 rawFinishReason 都查：SDK 归一化可能改写供应商原文，
  // 只认其中一个会在部分供应商上漏判超窗（INV-16）。
  if (
    ![input.finishReason, input.rawFinishReason].some(
      (reason) =>
        // trim + toLowerCase：供应商会带空格或大小写差异，例如 Context_Length_Exceeded。
        typeof reason === "string" && CONTEXT_LIMIT_FINISH_REASONS.has(reason.trim().toLowerCase()),
    )
  )
    return undefined;
  // 在成功终态前走既有失败链，避免无效 Continue 和遗留的成功请求身份；已报告用量随失败结算。
  // context 同时带上两个原始原因，失败结算据此区分「SDK 归一化后超窗」与「供应商原始超窗」。
  return new AiSdkModelAdapterError(
    ModelErrorCode.ModelContextExceeded,
    "Model request exceeded the provider context window.",
    {
      usage: input.usage,
      context: { finishReason: input.finishReason, rawFinishReason: input.rawFinishReason },
    },
  );
}

/** 判断 finish 原因是否在“禁止空完成重试”集合内（大小写/空白不敏感）。 */
function excludesEmptyCompletionRetry(value: unknown): boolean {
  // 只接受字符串：rawFinishReason 可能是对象，非字符串一律视为不在排除集合。
  return (
    typeof value === "string" && EMPTY_COMPLETION_RETRY_EXCLUSIONS.has(value.trim().toLowerCase())
  );
}

/**
 * 判定是否为“可重试的零输出完成”：finish 原因存在、无 reasoning、且命中可疑空完成。
 * 超窗/拒绝/内容过滤在排除集合内时直接返回 false，交由 Core 处理。
 */
// 超窗、拒绝与内容过滤不进入空完成重试。
// 其余零输出仍按原重试边界处理，否则重试次数会被这条兜底逻辑改写。
//
export function isZeroOutputModelCompletion(input: {
  finishReason?: string;
  rawFinishReason?: unknown;
  reasoningLength: number;
  textLength: number;
  toolCallCount: number;
  usage?: ModelUsage;
}): boolean {
  // 上下文超限、拒绝和内容过滤已有明确原因；此前零输出会先被原样重试。
  // 这三类结果直接交给 core；普通输出额度和其他原因保持现有空响应重试边界。
  // 两个字段都要查：SDK 归一化后的 finishReason 可能已丢失供应商原始措辞。
  if (
    excludesEmptyCompletionRetry(input.finishReason) ||
    excludesEmptyCompletionRetry(input.rawFinishReason)
  ) {
    return false;
  }
  // finishReason 必须存在：原因缺失时无法判断是否可重试，交回上层按未知失败处理。
  // 其余三条件与 generate 侧共用 isSuspiciousModelCompletion，避免两处判据漂移。
  return (
    input.finishReason !== undefined &&
    input.reasoningLength === 0 &&
    isSuspiciousModelCompletion({
      finishReason: input.finishReason,
      textLength: input.textLength,
      toolCallCount: input.toolCallCount,
      usage: input.usage,
    })
  );
}

/**
 * 可疑完成的四条件：无文本、无工具调用、finish 非正常停止、usage 全零。
 * 任一不满足即视为正常完成，避免把合法空对象/纯 usage 结果误判为异常。
 */
function isSuspiciousModelCompletion(input: {
  finishReason?: string;
  textLength: number;
  toolCallCount: number;
  usage?: ModelUsage;
}): boolean {
  return (
    // 条件一：没有文本增量。空字符串与从未收到 text-delta 都算。
    input.textLength === 0 &&
    // 条件二：没有工具调用。只调工具不产出文本是合法完成，不能误判（INV-06）。
    input.toolCallCount === 0 &&
    // 条件三：finish 原因不是正常停止。stop/tool-calls 说明模型正常收尾，不该告警。
    isNonStopFinish(input.finishReason) &&
    // 条件四：usage 全零。只要有一个 token 被计费，就说明确实产生过输出（INV-05）。
    isZeroUsage(input.usage)
  );
}

/** finish 是否为“非正常停止”（stop/tool-calls/tool_calls 视为正常）。 */
function isNonStopFinish(finishReason?: string): boolean {
  // 归一化后再比：供应商会返回 STOP/Stop 或带尾随空格，直接比较会把正常停止误判成异常（INV-04）。
  const normalized = finishReason?.trim().toLowerCase();
  // tool-calls 与 tool_calls 是同一语义的两种拼写，都要视为正常停止。
  return normalized !== "stop" && normalized !== "tool-calls" && normalized !== "tool_calls";
}

/**
 * usage 是否为零：serverToolUse 有请求时视为非零；totalTokens 缺省时用各分项求和。
 * 注意 cacheRead/cacheWrite/reasoning 也计入总消耗，避免“主 token 为 0 但有缓存读取”被误判。
 */
function isZeroUsage(usage?: ModelUsage): boolean {
  // 没有 usage 对象等同零用量：无法证明产生过输出，交给可疑完成判定处理。
  if (!usage) return true;
  // 先看服务器工具请求数：webSearch/webFetch 可能不产生 token，但确实是有效输出（INV-06）。
  const serverToolUse =
    (usage.serverToolUse?.webSearchRequests ?? 0) + (usage.serverToolUse?.webFetchRequests ?? 0);
  if (serverToolUse > 0) return false;
  // totalTokens 缺省时用分项求和：cacheRead/cacheWrite/reasoning 都计入消耗，
  // 否则「主 token 为 0 但有缓存读取」会被误判成零用量。
  const total =
    usage.totalTokens ??
    (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0) +
      (usage.reasoningTokens ?? 0);
  return total === 0;
}

/** 把任意抛出值规整为 Error，保证 logger.error 的签名可用且不丢原值文本。 */
function toLogError(error: unknown): Error {
  // 已是 Error 直接透传，保留原始堆栈与 cause 链。
  if (error instanceof Error) {
    return error;
  }
  // 字符串/对象等非 Error 抛出值转成 Error：logger.error 需要 Error 签名，String() 保证不丢文本。
  return new Error(String(error));
}
