// ==== model/provider-finish-business-error.ts ====
// 定位：从 AI SDK 的 finish/error chunk 里识别 provider 业务错误，并重建统一 ProviderBusinessError。
// 输入：providerId/providerKind 与任意 source（finish chunk、error chunk 或已包装错误）。
// 输出：命中时返回 ProviderBusinessError；非 finish 形态或缺少业务信号时返回 undefined。
// 副作用：无 IO；只做对象遍历与 WeakSet 去重，不修改 source。
// 失败语义：不抛错；字段缺失保持 undefined，由上层决定可重试性与归因。
// 不变量：只有“结构化业务码 / 显式 business 标记 / 特定 finishReason”才升级为业务错误；
//           包装码 PROVIDER_BUSINESS_ERROR 不被当作真实上游码。
import type { AiSdkProviderKind, ProviderBusinessErrorOptions } from "./model-execution.js";
import { ProviderBusinessError } from "./model-execution.js";
import { getHttpResponseStatus, getResponseHeaders } from "./failure-inspection.js";
import { asRecord, stringProperty } from "./runner-record.js";

const BIGMODEL_BRACKETED_BUSINESS_CODE_PATTERN = /^\[(\d{4})\](?=\[)/;
const PROVIDER_BUSINESS_ERROR_WRAPPER_CODE = "PROVIDER_BUSINESS_ERROR";

interface DetectProviderBusinessFinishErrorOptions {
  /** 提供商标识，写入错误上下文用于归因。 */
  providerId: string;
  /** 协议族；未知或缺失时归一到 openai-compatible。 */
  providerKind?: AiSdkProviderKind | string;
  /** 待检测的 finish/error chunk 或已包装错误，允许任意形态。 */
  source: unknown;
}

/**
 * 检测并重建 provider 业务错误。
 * 仅当 source 具备 finish/error 形态且存在业务信号（结构化 code、provider_success_false、
 * 或显式 ProviderBusinessError 标记）时才返回错误；普通 Error.message（如 rate limited）
 * 缺少业务码，不能仅凭文案升级，否则会把可重试限流误判成业务错误。
 * 命中的错误会保留 retry-after 相关响应头、状态码与 request id，供重试计算使用。
 */
export function detectProviderBusinessFinishError(
  options: DetectProviderBusinessFinishErrorOptions,
): ProviderBusinessError | undefined {
  const record = asRecord(options.source);
  if (!isFinishLikeRecord(record)) {
    return undefined;
  }

  const rawFinishReason = readRawFinishReason(record);
  const extracted = extractBusinessFailurePayload(record);
  const errorPayload = asRecord(record.error);
  const providerCode =
    extracted.providerCode ??
    normalizeStringish(record.providerCode) ??
    normalizeStringish(errorPayload?.code);

  // AI SDK 的 error chunk 常带普通 Error.message（如 rate limited），没有业务码；
  // 仅凭 providerMessage 命中会把可重试限流误判成 ProviderBusinessError。
  const hasBusinessSignal =
    providerCode !== undefined ||
    rawFinishReason === "provider_success_false" ||
    record.isProviderBusinessError === true ||
    record.name === "ProviderBusinessError";

  if (!hasBusinessSignal) {
    return undefined;
  }

  const errorOptions: ProviderBusinessErrorOptions = {
    providerId: options.providerId,
    providerKind: normalizeProviderKind(options.providerKind),
    providerCode,
    providerMessage:
      extracted.providerMessage ??
      normalizeStringish(record.providerMessage) ??
      normalizeStringish(record.message) ??
      (rawFinishReason === "provider_success_false"
        ? "Provider returned a business error."
        : undefined),
    providerRequestId: extracted.providerRequestId,
    responseBodySummary: extracted.responseBodySummary,
    // AI SDK 的 error chunk 会把 fetch 层业务错误重新包一层；
    // 重建 ProviderBusinessError 时不带 responseHeaders，会让 retry-after 在重试计算前丢失。
    responseHeaders: extracted.responseHeaders,
    responseStatus: extracted.responseStatus,
    statusCode: extracted.statusCode,
  };

  return new ProviderBusinessError(errorOptions);
}

/** 把未知 providerKind 归一到 openai-compatible，避免缺省值导致分支漏判。 */
function normalizeProviderKind(value: AiSdkProviderKind | string | undefined): AiSdkProviderKind {
  return value === "openai" || value === "anthropic" || value === "openai-compatible"
    ? value
    : "openai-compatible";
}

/** 判断记录是否呈现 finish/error chunk 形态；不满足则无需继续解析业务码。 */
function isFinishLikeRecord(record: Record<string, unknown>): boolean {
  const chunkType = stringProperty(record, "type");
  if (chunkType === "finish" || chunkType === "error") {
    return true;
  }

  if (stringProperty(record, "finishReason") || readRawFinishReason(record)) {
    return true;
  }

  if (record.isProviderBusinessError === true || record.name === "ProviderBusinessError") {
    return true;
  }

  return false;
}

/** 读取原始 finishReason，优先顶层字段，其次 providerMetadata 内嵌值。 */
function readRawFinishReason(record: Record<string, unknown>): string | undefined {
  return (
    stringProperty(record, "rawFinishReason") ??
    stringProperty(asRecord(record.providerMetadata), "rawFinishReason")
  );
}

/**
 * 在候选记录集合中提取业务失败载荷。
 * 每个字段都取“首个非空”值：providerCode/message/requestId 需真值，headers/status 允许 0；
 * responseBodySummary 取第一个具备业务信号的记录，供错误摘要与排障使用。
 */
function extractBusinessFailurePayload(record: Record<string, unknown>) {
  const candidates = collectCandidateRecords(record);
  const providerCode = candidates.map(readProviderCode).find(Boolean);
  const providerMessage = candidates.map(readProviderMessage).find(Boolean);
  const providerRequestId = candidates.map(readProviderRequestId).find(Boolean);
  const responseHeaders = candidates.map(getResponseHeaders).find(Boolean);
  const responseBodySummary = candidates.find(hasBusinessSignal);
  const responseStatus = candidates.map(getHttpResponseStatus).find((value) => value !== undefined);
  const statusCode = candidates.map(readStatusCode).find((value) => value !== undefined);

  return {
    providerCode,
    providerMessage,
    providerRequestId,
    responseHeaders,
    responseBodySummary,
    responseStatus,
    statusCode,
  };
}

/**
 * 广度遍历记录图，收集可扫描的候选对象。
 * 先沿已知字段链展开，再兜底遍历全部对象值；WeakSet 防环，数组元素入队而非入结果。
 */
function collectCandidateRecords(record: Record<string, unknown>): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const seen = new WeakSet<object>();
  const queue: unknown[] = [record];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item);
      }
      continue;
    }

    const currentRecord = current as Record<string, unknown>;
    result.push(currentRecord);

    queue.push(
      currentRecord.providerMetadata,
      currentRecord.response,
      asRecord(currentRecord.response).body,
      currentRecord.body,
      currentRecord.error,
      currentRecord.data,
      currentRecord.choices,
    );

    // zcode-plan 等业务错误可能只出现在 AI SDK finish chunk 的深层 JSON（如 response.body），
    // 仅沿固定字段链扫描会漏掉 3007，最终让 core 误判为 suspicious empty。
    for (const nested of Object.values(currentRecord)) {
      if (nested && typeof nested === "object") {
        queue.push(nested);
      }
    }
  }

  return result;
}

/**
 * 按优先级读取上游业务码。
 * 结构化 providerCode/error_code 优先，其后是 code；显式 code 若只是包装码会被跳过，
 * 最后才尝试 BigModel 的 `[xxxx][...]` message 强格式前缀，避免普通文案误判。
 */
function readProviderCode(record: Record<string, unknown>): string | undefined {
  const errorRecord = asRecord(record.error);
  const contextRecord = asRecord(record.context);
  const value =
    normalizeProviderCode(record.providerCode) ??
    normalizeProviderCode(errorRecord?.providerCode) ??
    normalizeProviderCode(contextRecord?.providerCode) ??
    normalizeProviderCode(record.error_code) ??
    normalizeProviderCode(errorRecord?.error_code) ??
    // ProviderBusinessError 二次进入 AI SDK chunk 时，外层 code 是包装类型；
    // 真实上游码在 providerCode/嵌套 body 中，不能让包装码提前截断扫描。
    normalizeProviderCode(record.code) ??
    normalizeProviderCode(errorRecord?.code) ??
    normalizeProviderCode(contextRecord?.code) ??
    // BigModel/Z.AI 的 SSE error chunk 有时只有 `[1302][...][request_id]` message，
    // 没有结构化 code；只解析这个强格式前缀，避免把普通 rate limit 文案误判成业务码。
    readBigModelBracketedBusinessCode(record.message) ??
    readBigModelBracketedBusinessCode(record.providerMessage) ??
    readBigModelBracketedBusinessCode(errorRecord?.message) ??
    readBigModelBracketedBusinessCode(errorRecord?.providerMessage) ??
    readBigModelBracketedBusinessCode(contextRecord?.message) ??
    readBigModelBracketedBusinessCode(contextRecord?.providerMessage);
  return value;
}

/** 读取人类可读的错误消息，覆盖顶层与 error/context 嵌套层的 msg/message/providerMessage。 */
function readProviderMessage(record: Record<string, unknown>): string | undefined {
  const errorRecord = asRecord(record.error);
  const contextRecord = asRecord(record.context);
  return (
    normalizeStringish(record.msg) ??
    normalizeStringish(record.providerMessage) ??
    normalizeStringish(record.message) ??
    normalizeStringish(errorRecord?.msg) ??
    normalizeStringish(errorRecord?.providerMessage) ??
    normalizeStringish(errorRecord?.message) ??
    normalizeStringish(contextRecord?.providerMessage) ??
    normalizeStringish(contextRecord?.msg) ??
    normalizeStringish(contextRecord?.message)
  );
}

/** 读取上游 request id（request_id/requestId/id），顶层优先、error 嵌套兜底。 */
function readProviderRequestId(record: Record<string, unknown>): string | undefined {
  const errorRecord = asRecord(record.error);
  return (
    normalizeStringish(record.request_id) ??
    normalizeStringish(record.requestId) ??
    normalizeStringish(record.id) ??
    normalizeStringish(errorRecord.request_id) ??
    normalizeStringish(errorRecord.requestId) ??
    normalizeStringish(errorRecord.id)
  );
}

/** 读取数值状态码，statusCode 优先于 status，只接受有限数字。 */
function readStatusCode(record: Record<string, unknown>): number | undefined {
  return toFiniteNumber(record.statusCode) ?? toFiniteNumber(record.status);
}

/** 判断记录是否含业务信号：业务码、消息，或非空 allowed_models（配额/权限类响应）。 */
function hasBusinessSignal(record: Record<string, unknown>): boolean {
  return Boolean(
    readProviderCode(record) ||
    readProviderMessage(record) ||
    (Array.isArray(record.allowed_models) && record.allowed_models.length > 0),
  );
}

/**
 * 把字符串/有限数字规整为去空白后的非空字符串。
 * 数字统一截断为整数串；空串与非法类型返回 undefined，保证 truthy 判定可靠。
 */
function normalizeStringish(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * 规整业务码，并过滤包装码。
 * 已包装的 ProviderBusinessError 会暴露 PROVIDER_BUSINESS_ERROR，跳过它才能继续扫描真实上游码。
 */
function normalizeProviderCode(value: unknown): string | undefined {
  const normalized = normalizeStringish(value);
  return normalized?.toUpperCase() === PROVIDER_BUSINESS_ERROR_WRAPPER_CODE
    ? undefined
    : normalized;
}

/** 解析 BigModel `[1302][...]` 前缀中的 4 位业务码；不匹配返回 undefined。 */
function readBigModelBracketedBusinessCode(value: unknown): string | undefined {
  const message = normalizeStringish(value);
  const match = message?.match(BIGMODEL_BRACKETED_BUSINESS_CODE_PATTERN);
  return match?.[1];
}

/** 仅接受有限数字，其余（NaN/Infinity/非 number）返回 undefined。 */
function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
