// ============================================================
// ==== model/failure-inspection ====
// ============================================================
// 定位：统一从任意错误值中提取 HTTP 状态码、响应头、响应体、业务 code，并给出失败分类判定。
// 输入：unknown error（可能被 RetryError 包裹，或通过 cause 链嵌套），可选 abortSignal。
// 输出：状态码/headers/body/code 或布尔分类；无法识别时返回 undefined/false，绝不抛错。
// 副作用：无 IO；只读取对象字段，递归时用 WeakSet 防止 cause 环导致栈溢出。
// 失败语义：JSON.parse/headers.forEach 失败一律吞掉并返回 undefined；分类判定失败即“不属于该类”。
// 不变量：状态与 headers 递归穿透 cause 链；文案类判定保持短语级窄化，避免把普通 400/422 误分类。

import { APICallError, RetryError } from "ai";

/**
 * 解开 AI SDK 的 RetryError 包装，返回最后一次失败；非 RetryError 原样返回。
 * 用于让上层状态码/文案检查能作用到真实 provider 错误，而不是重试聚合壳。
 */
export function unwrapRetryError(error: unknown): unknown {
  if (RetryError.isInstance(error)) {
    return error.lastError ?? error;
  }
  return error;
}

/**
 * 提取错误的 HTTP 状态码，依次检查 APICallError、statusCode/status、response.status 与 cause 链。
 * 输出：找到的数值状态码；完全无法识别返回 undefined。
 * 失败语义：不抛错；非对象值按空对象处理。
 */
export function getStatusCode(error: unknown): number | undefined {
  return getStatusCodeFromError(error, new WeakSet<object>());
}

/**
 * 只提取“真实 HTTP 响应”的状态：responseStatus / response.status，不把任意 status 字段当 HTTP 码。
 * 用于区分业务错误码与网络响应状态，避免把自定义 status 误判成 HTTP 状态。
 */
export function getHttpResponseStatus(error: unknown): number | undefined {
  return getHttpResponseStatusFromError(error, new WeakSet<object>());
}

/** getHttpResponseStatus 的递归实现；markSeen 命中环时返回 undefined。 */
function getHttpResponseStatusFromError(error: unknown, seen: WeakSet<object>): number | undefined {
  if (markSeen(error, seen)) {
    return undefined;
  }

  if (APICallError.isInstance(error) && error.statusCode !== undefined) {
    return error.statusCode;
  }

  const record = asRecord(error);
  const responseStatus = numberProperty(record, "responseStatus");
  if (responseStatus !== undefined) {
    return responseStatus;
  }

  const response = asRecord(record.response);
  const nestedResponseStatus =
    numberProperty(response, "status") ?? numberProperty(response, "statusCode");
  if (nestedResponseStatus !== undefined) {
    return nestedResponseStatus;
  }

  const cause = record.cause;
  return cause && cause !== error ? getHttpResponseStatusFromError(cause, seen) : undefined;
}

/** getStatusCode 的递归实现：按 APICallError -> 自身字段 -> response 字段 -> cause 的顺序查找。 */
function getStatusCodeFromError(error: unknown, seen: WeakSet<object>): number | undefined {
  if (markSeen(error, seen)) {
    return undefined;
  }

  if (APICallError.isInstance(error)) {
    const statusCode = error.statusCode;
    if (statusCode !== undefined) {
      return statusCode;
    }
  }

  const record = asRecord(error);
  const statusCode = numberProperty(record, "statusCode") ?? numberProperty(record, "status");
  if (statusCode !== undefined) {
    return statusCode;
  }

  const response = asRecord(record.response);
  const responseStatus =
    numberProperty(response, "status") ?? numberProperty(response, "statusCode");
  if (responseStatus !== undefined) {
    return responseStatus;
  }

  const cause = record.cause;
  return cause && cause !== error ? getStatusCodeFromError(cause, seen) : undefined;
}

/**
 * 读取 APICallError 的响应体；字符串会尝试 JSON.parse，失败返回 undefined。
 * 非 APICallError 一律返回 undefined（不沿 cause 链查找）。
 */
export function getApiCallResponseBody(error: unknown): unknown {
  if (!APICallError.isInstance(error)) {
    return undefined;
  }

  const { responseBody } = error;
  if (typeof responseBody === "string") {
    try {
      return JSON.parse(responseBody) as unknown;
    } catch {
      return undefined;
    }
  }

  return responseBody;
}

/** 读取 APICallError 的 data 字段（SDK 已解析的结构化错误体）；非该类型返回 undefined。 */
export function getApiCallErrorData(error: unknown): unknown {
  return APICallError.isInstance(error) ? error.data : undefined;
}

/**
 * 提取响应头对象，兼容 APICallError.responseHeaders、普通对象 headers、Headers 实例与 cause 链。
 * 输出：小写化无关的原始 key/value 字符串表；无可用 headers 返回 undefined。
 */
export function getResponseHeaders(error: unknown): Record<string, string> | undefined {
  return getResponseHeadersFromError(error, new WeakSet<object>());
}

/** getResponseHeaders 的递归实现：外层错误无 headers 时继续读 cause（业务错误常被包在 cause 里）。 */
function getResponseHeadersFromError(
  error: unknown,
  seen: WeakSet<object>,
): Record<string, string> | undefined {
  if (markSeen(error, seen)) {
    return undefined;
  }

  if (APICallError.isInstance(error)) {
    const headers = asStringRecord(error.responseHeaders);
    if (headers) {
      return headers;
    }
  }

  const record = asRecord(error);
  const headers = asStringRecord(record.responseHeaders) ?? asStringRecord(record.headers);
  if (headers) {
    return headers;
  }

  const response = asRecord(record.response);
  const responseHeaders = asStringRecord(response.headers);
  if (responseHeaders) {
    return responseHeaders;
  }

  // AI SDK/stream chunk 可能把 ProviderBusinessError 包在 cause 里；
  // 外层 APICallError 没有 responseHeaders 时，必须继续读取内层错误。
  const cause = record.cause;
  return cause && cause !== error ? getResponseHeadersFromError(cause, seen) : undefined;
}

/**
 * 提取错误的业务/网络 code，沿 cause 链查找第一个非空字符串 code。
 * 输出：code 字符串；无 code 返回 undefined。
 */
export function getErrorCode(error: unknown): string | undefined {
  return getErrorCodeFromError(error, new WeakSet<object>());
}

/** getErrorCode 的递归实现；只在自身与 cause 上查找，不进入 response 对象。 */
function getErrorCodeFromError(error: unknown, seen: WeakSet<object>): string | undefined {
  if (markSeen(error, seen)) {
    return undefined;
  }

  const record = asRecord(error);
  const code = stringProperty(record, "code");
  if (code) {
    return code;
  }

  const cause = record.cause;
  if (cause && cause !== error) {
    return getErrorCodeFromError(cause, seen);
  }

  return undefined;
}

/**
 * 判断是否为用户/调用方主动中止：signal 已 abort，或错误名/码为 AbortError/ABORT_ERR。
 * 该判定优先于重试，命中即不应重试。
 */
export function isAbortFailure(error: unknown, abortSignal?: AbortSignal): boolean {
  if (abortSignal?.aborted) {
    return true;
  }
  const record = asRecord(error);
  return (
    stringProperty(record, "name") === "AbortError" ||
    stringProperty(record, "code") === "ABORT_ERR"
  );
}

/**
 * 判断是否为超时失败：HTTP 408、常见网络超时码（ETIMEDOUT/UND_ERR_*）或 TimeoutError 名称。
 * 输入 code 与 statusCode 通常来自 getErrorCode/getStatusCode；缺省时仅按错误名判断。
 */
export function isTimeoutFailure(error: unknown, code?: string, statusCode?: number): boolean {
  if (statusCode === 408) {
    return true;
  }

  const normalizedCode = code?.toUpperCase();
  if (
    normalizedCode === "ETIMEDOUT" ||
    normalizedCode === "ETIMEOUT" ||
    normalizedCode === "UND_ERR_CONNECT_TIMEOUT" ||
    normalizedCode === "UND_ERR_HEADERS_TIMEOUT" ||
    normalizedCode === "UND_ERR_BODY_TIMEOUT"
  ) {
    return true;
  }

  const name = stringProperty(asRecord(error), "name")?.toLowerCase();
  return name === "timeouterror" || name === "timeout_error";
}

/**
 * 判断是否为上下文窗口超限：组合检查 code、providerCode、response body 的 code/message 与 cause 链。
 * 输出：true 表示应触发上下文压缩/截断策略，而非普通重试。
 */
export function isContextExceededFailure(error: unknown): boolean {
  return hasContextExceededSignal(error, new WeakSet<object>());
}

/** 递归检查超限信号：code/providerCode/标准 body code 与多条窄化文案，任一命中即 true。 */
function hasContextExceededSignal(error: unknown, seen: WeakSet<object>): boolean {
  if (markSeen(error, seen)) {
    return false;
  }

  const record = asRecord(error);
  const responseBody = getApiCallResponseBody(error);
  if (
    isContextExceededCode(stringProperty(record, "code")) ||
    // 标准 response body 会先被归一为 ProviderBusinessError，
    // 此时真实 provider code 位于 providerCode，外层 code 只是包装码。
    isContextExceededCode(stringProperty(record, "providerCode")) ||
    isContextExceededCode(standardResponseBodyCode(responseBody)) ||
    isContextExceededMessage(stringProperty(record, "message")) ||
    isContextExceededMessage(standardResponseBodyMessage(responseBody))
  ) {
    return true;
  }

  const cause = record.cause;
  return cause && cause !== error ? hasContextExceededSignal(cause, seen) : false;
}

/** 精确匹配已知的上下文超限 code（小写），避免与 general invalid_request 混淆。 */
function isContextExceededCode(value: string | undefined): boolean {
  const code = value?.toLowerCase();
  return (
    code === "context_length_exceeded" ||
    code === "context_window_exceeded" ||
    code === "model_context_exceeded" ||
    code === "model_context_window_exceeded"
  );
}

/** 文案级超限判定；各条件均为短语组合，防止把 max_tokens 参数错误误判为超窗。 */
function isContextExceededMessage(value: string | undefined): boolean {
  const message = value?.toLowerCase();
  if (!message) return false;

  return (
    message === "model_context_window_exceeded" ||
    (message.includes("context") && message.includes("exceed")) ||
    // 部分 OpenAI-compatible provider 只在 invalid_request 文本中报告
    // maximum context length 和 token 统计，不会在文案中包含 exceeded。
    (message.includes("maximum context length") &&
      message.includes("tokens") &&
      (message.includes("requested") || message.includes("resulted"))) ||
    // 官方 provider 的这些文案都明确指向输入超过上下文窗口；
    // 保持短语级匹配，避免把通用 400/422 或 max_tokens 参数错误归为超窗。
    message.includes("prompt is too long") ||
    (message.includes("input token count") &&
      message.includes("exceed") &&
      message.includes("maximum number of tokens allowed")) ||
    message.includes("range of input length should be") ||
    (message.includes("total message token length") &&
      message.includes("exceed") &&
      message.includes("model limit"))
  );
}

/** 从标准 {error:{code}} / {code} 响应体提取业务 code。 */
function standardResponseBodyCode(body: unknown): string | undefined {
  const record = asRecord(body);
  const nestedError = asRecord(record.error);
  return stringProperty(nestedError, "code") ?? stringProperty(record, "code");
}

/** 从标准 {error:{message}} / {message} 响应体提取错误文案。 */
function standardResponseBodyMessage(body: unknown): string | undefined {
  const record = asRecord(body);
  const nestedError = asRecord(record.error);
  return stringProperty(nestedError, "message") ?? stringProperty(record, "message");
}

/** code 中包含 PROXY（大小写不敏感）即视为代理层失败，通常不可通过换模型解决。 */
export function isProxyFailure(code?: string): boolean {
  return code?.toUpperCase().includes("PROXY") ?? false;
}

/**
 * 判断是否为可重试的网络类失败：连接重置/拒绝、DNS 失败、路由不可达、undici socket/连接超时。
 * 输入为归一化后的 code；未命中列表返回 false。
 */
export function isNetworkFailure(code?: string): boolean {
  const normalized = code?.toUpperCase();
  return (
    normalized === "ECONNRESET" ||
    normalized === "ECONNREFUSED" ||
    normalized === "EAI_AGAIN" ||
    normalized === "ENOTFOUND" ||
    normalized === "ENETUNREACH" ||
    normalized === "EHOSTUNREACH" ||
    normalized === "UND_ERR_SOCKET" ||
    normalized === "UND_ERR_CONNECT_TIMEOUT"
  );
}

/**
 * 读取 provider 显式标注的 isRetryable：APICallError 用其字段，其他对象读 isRetryable 布尔值。
 * 输出：无标注或非布尔时返回 false（保守不重试）。
 */
export function isProviderMarkedRetryable(error: unknown): boolean {
  if (APICallError.isInstance(error)) {
    return error.isRetryable;
  }

  const retryable = asRecord(error).isRetryable;
  return typeof retryable === "boolean" ? retryable : false;
}

/**
 * 解析 retry-after 类响应头，返回建议等待毫秒数。
 * 优先级：x-should-retry=false/0 时直接放弃（retry-after 仅作诊断）；其次 retry-after-ms；
 *   再次 retry-after 秒数；最后按 HTTP-date 时间戳计算差值。
 * 输出：非负整数毫秒；无可用值或头缺失返回 undefined，负值统一钳为 0。
 */
export function parseRetryAfterMs(headers?: Record<string, string>): number | undefined {
  if (!headers) {
    return undefined;
  }
  // 部分 provider 会同时返回 retry-after 和 x-should-retry=false；
  // 此时 retry-after 只能作为诊断信息，不能驱动 adapter 等待。
  if (isShouldRetryHeaderFalse(headers)) {
    return undefined;
  }

  const retryAfterMs = parseNumericHeaderMs(findHeaderValue(headers, "retry-after-ms"));
  if (retryAfterMs !== undefined) {
    return retryAfterMs;
  }

  const value = findHeaderValue(headers, "retry-after")?.trim();
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }

  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }

  return undefined;
}

/** 大小写不敏感地查找 header 值。 */
function findHeaderValue(headers: Record<string, string>, name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

/** provider 显式声明 x-should-retry=false/0 时返回 true，表示不得依据 retry-after 重试。 */
function isShouldRetryHeaderFalse(headers: Record<string, string>): boolean {
  const value = findHeaderValue(headers, "x-should-retry")?.trim().toLowerCase();
  return value === "false" || value === "0";
}

/** 解析毫秒数值头；非有限数返回 undefined，负值钳为 0。 */
function parseNumericHeaderMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const milliseconds = Number(value.trim());
  return Number.isFinite(milliseconds) ? Math.max(0, Math.round(milliseconds)) : undefined;
}

/** 非对象值统一视为空对象，简化后续属性读取。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * 把任意 headers 形状归一为字符串表：优先识别 Headers/fetch headers 实例，其次过滤纯字符串值对象。
 * 输出：无有效项时 undefined。
 */
function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  const headersLike = headersLikeToRecord(value);
  if (headersLike) {
    return headersLike;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** 识别带 forEach(name, value) 的 Headers 实例并转成记录；调用抛错时放弃返回 undefined。 */
function headersLikeToRecord(value: object): Record<string, string> | undefined {
  const forEach = (value as { forEach?: unknown }).forEach;
  if (typeof forEach !== "function") {
    return undefined;
  }

  const entries: Array<[string, string]> = [];
  try {
    forEach.call(value, (headerValue: unknown, headerName: unknown) => {
      if (typeof headerName === "string" && typeof headerValue === "string") {
        entries.push([headerName, headerValue]);
      }
    });
  } catch {
    return undefined;
  }
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

/** 将对象标记为已访问；返回 true 表示此前见过（存在环），调用方应立即终止递归。 */
function markSeen(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return true;
  }
  seen.add(value);
  return false;
}

/** 读取有限数值字段；类型不符或 NaN/Infinity 返回 undefined。 */
function numberProperty(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 读取非空字符串字段；空串与类型不符返回 undefined（避免空 code 被当作有效值）。 */
function stringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
