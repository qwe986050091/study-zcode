// ============================================================
// AI SDK 错误 → ProviderBusinessError（业务码映射）
// 定位：把 AI SDK 已解析的 error data 映射为统一 ProviderBusinessError，供失败分类器使用。
// 输入：unknown（通常 APICallError）。输出：ProviderBusinessError 或 undefined（无可识别业务码）。
// 副作用：无（纯读取 error 上的 data/headers）。失败语义：不抛错；无法识别即返回 undefined 交给通用分类。
// 不变量：providerId 固定 unknown、providerKind 固定 openai-compatible；字段长度截断到 1000 字符。
// ============================================================

import { getApiCallErrorData, getResponseHeaders, getStatusCode } from "./failure-inspection.js";
import { getProviderBusinessCodeMapping } from "./failure-provider-business-codes.js";
import { ProviderBusinessError } from "./model-execution.js";

const MAX_SAFE_PROVIDER_FIELD_CHARS = 1_000;

/**
 * 只读取 AI SDK 已解析并暴露的错误对象；未知业务码继续交给既有通用分类链路。
 * 返回 undefined 的两种情况：error data 不可解析，或 code/type 都不在业务码映射表内。
 */
export function readMappedAiSdkProviderBusinessError(
  error: unknown,
): ProviderBusinessError | undefined {
  const data = asRecord(getApiCallErrorData(error));
  const errorData = asRecord(data?.error) ?? asRecord(error);
  if (!errorData) return undefined;

  // OpenAI-compatible schema 的 code 比 type 更具体；例如 type 可能统一为
  // insufficient_quota，而 code 才区分余额或组织/项目消费上限。
  const providerCode = [
    normalizeProviderCode(errorData.code),
    normalizeProviderCode(errorData.type),
  ].find(
    (candidate) =>
      candidate !== undefined && getProviderBusinessCodeMapping(candidate) !== undefined,
  );
  if (!providerCode) return undefined;

  const statusCode = getStatusCode(error);
  return new ProviderBusinessError({
    providerCode,
    providerId: "unknown",
    providerKind: "openai-compatible",
    providerMessage: stringValue(errorData.message),
    providerRequestId: readProviderRequestId(data, errorData),
    responseBodySummary: summarizeAiSdkErrorData(data, errorData),
    responseHeaders: getResponseHeaders(error),
    responseStatus: statusCode,
    statusCode,
  });
}

/** 从 data 与 errorData 依次找 request id，命中后截断到安全长度；全部缺失返回 undefined。 */
function readProviderRequestId(
  data: Record<string, unknown> | undefined,
  errorData: Record<string, unknown>,
): string | undefined {
  for (const record of [data, errorData]) {
    if (!record) continue;
    for (const key of ["request_id", "requestId", "id"] as const) {
      const value = stringValue(record[key]);
      if (value) return value.slice(0, MAX_SAFE_PROVIDER_FIELD_CHARS);
    }
  }
  return undefined;
}

/** 构造只含标量的响应摘要（request id + code/type），用于错误归因，绝不复制自由文本或大对象。 */
function summarizeAiSdkErrorData(
  data: Record<string, unknown> | undefined,
  errorData: Record<string, unknown>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  if (data) {
    copyScalar(data, summary, "request_id");
    copyScalar(data, summary, "requestId");
  }

  const errorSummary: Record<string, unknown> = {};
  // message 已由 ProviderBusinessError 统一清理和截断；摘要只保留分类字段。
  copyScalar(errorData, errorSummary, "code");
  copyScalar(errorData, errorSummary, "type");
  copyScalar(errorData, errorSummary, "request_id");
  copyScalar(errorData, errorSummary, "requestId");
  summary.error = errorSummary;
  return summary;
}

/** 复制单个标量字段：只接受 string/number/boolean，对象与数组一律跳过，防止摘要膨胀。 */
function copyScalar(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    target[key] = value;
  }
}

function normalizeProviderCode(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return stringValue(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
