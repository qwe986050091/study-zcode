import { CoreErrorType, createCoreError } from "../deps.js";
import { isPlainRecord } from "./data.js";

/**
 * 从 provider 响应/元数据里识别出的"业务失败"事实。
 *
 * 字段口径：
 * - message：归一化后的可读错误信息；provider 没给时调用方补默认文案；
 * - providerCode：provider 自己的业务码（数字已转成字符串），0 视为成功；
 * - responseBodySummary：只保留标量/字符串数组的响应体摘要，用于诊断，
 *   避免把嵌套大对象或二进制内容带进错误上下文。
 */
interface ProviderBusinessMetadataFailure {
  message: string;
  providerCode?: string;
  responseBodySummary?: Record<string, unknown>;
}

/**
 * 在 provider metadata 的任意嵌套层级里查找业务失败。
 *
 * 输入：providerMetadata 是 provider 返回的原始元数据（结构不固定，可能嵌多层）。
 * 遍历方式：广度优先 + WeakSet 去环——metadata 里可能存在自引用对象，直接递归会爆栈。
 * 判定：某个 record 只要 `success === false` 或业务码非 0，就视为失败；返回第一个命中，
 * 因为上层只需要一条可展示的错误。
 * 输出：ProviderBusinessMetadataFailure；未命中返回 undefined。
 * 失败语义：不抛错；非对象/空节点直接跳过。纯函数，无副作用。
 */
export function findProviderBusinessFailureInMetadata(
  providerMetadata: Record<string, unknown> | undefined,
): ProviderBusinessMetadataFailure | undefined {
  if (!providerMetadata) {
    return undefined;
  }

  const queue: unknown[] = [providerMetadata];
  const seen = new WeakSet<object>();

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

    const record = current as Record<string, unknown>;
    const providerCode = readProviderBusinessCode(record);
    const providerMessage = readProviderBusinessMessage(record);
    const failedBySuccess = record.success === false;
    const failedByCode = isNonZeroProviderBusinessCode(providerCode);

    if (failedBySuccess || failedByCode) {
      return {
        message: providerMessage ?? "Provider returned a business error.",
        providerCode,
        responseBodySummary: summarizeProviderBusinessMetadataBody(record),
      };
    }

    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") {
        queue.push(nested);
      }
    }
  }

  return undefined;
}

/**
 * 把任意 thrown error 里的 provider 业务失败转成统一的 CoreError。
 *
 * 输入：provider adapter 抛出的 unknown（可能是带标记的 ProviderBusinessError，
 * 也可能是普通 Error，业务信息藏在 context 里）。
 * 输出：CoreError (ModelError)；识别不到业务失败时返回 undefined，交回上层按普通错误处理。
 * 语义：recoverable=true、retryable=false——这类错误通常是鉴权/配额/参数问题，
 * 重试不会自愈，但用户修正后同一轮可以继续。
 * 副作用：无 IO；只构造错误对象。
 */
export function createCoreErrorFromProviderBusinessLike(
  error: unknown,
): ReturnType<typeof createCoreError> | undefined {
  const failure = readProviderBusinessFailureFromUnknown(error);
  if (!failure) {
    return undefined;
  }

  return createCoreError(CoreErrorType.ModelError, failure.message, {
    context: {
      ...(failure.providerCode ? { providerCode: failure.providerCode } : {}),
      ...(failure.responseBodySummary
        ? { responseBodySummary: failure.responseBodySummary }
        : {}),
    },
    recoverable: true,
    retryable: false,
  });
}

/**
 * 从 unknown error 的三类来源中提取业务失败，并做归一化合成。
 *
 * 识别顺序：
 * 1. 显式标记（isProviderBusinessError 或 name=ProviderBusinessError）；
 * 2. context 里的业务字段——把 context 与顶层 message 合成一个 record 再判定，
 *    因为 adapter 常把 provider 原始 body 放在 context 里；
 * 3. error 自身字段（success/code/message）。
 * 输出：命中的失败事实；都没有时返回 undefined。纯函数，无副作用。
 */
function readProviderBusinessFailureFromUnknown(
  error: unknown,
): ProviderBusinessMetadataFailure | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const record = error as Record<string, unknown>;
  if (record.isProviderBusinessError === true || record.name === "ProviderBusinessError") {
    return readProviderBusinessFailureFromRecord(record);
  }

  const context = isPlainRecord(record.context) ? record.context : undefined;
  if (context) {
    const contextFailure = readProviderBusinessFailureFromRecord({
      ...context,
      msg: context.msg ?? context.providerMessage ?? record.message,
      message: context.message ?? record.message,
      code: context.providerCode ?? context.code,
    });
    if (contextFailure) {
      return contextFailure;
    }
  }

  return readProviderBusinessFailureFromRecord(record);
}

/**
 * 在单个 record 上判定业务失败并整理成失败事实。
 *
 * 判定条件二选一：success 显式为 false，或业务码非 0。仅当两者都不成立时返回
 * undefined（success 缺失、code 为 0 或缺失都按成功处理）。纯函数，无副作用。
 */
function readProviderBusinessFailureFromRecord(
  record: Record<string, unknown>,
): ProviderBusinessMetadataFailure | undefined {
  const providerCode = readProviderBusinessCode(record);
  const providerMessage = readProviderBusinessMessage(record);
  const failedBySuccess = record.success === false;
  const failedByCode = isNonZeroProviderBusinessCode(providerCode);

  if (!failedBySuccess && !failedByCode) {
    return undefined;
  }

  return {
    message: providerMessage ?? "Provider returned a business error.",
    providerCode,
    responseBodySummary: summarizeProviderBusinessMetadataBody(record),
  };
}

/**
 * 按固定优先级读取业务码：顶层 code → providerCode → error_code，
 * 再看 error 子对象，最后看 context。
 *
 * 这样排序是因为顶层字段最接近 adapter 的显式结论，嵌套字段只是 provider 原始
 * body 的透传；越靠后越可能是无关的模型/请求码。输出已归一化，空值返回 undefined。
 * 纯函数，无副作用。
 */
function readProviderBusinessCode(record: Record<string, unknown>): string | undefined {
  const errorRecord = isPlainRecord(record.error) ? record.error : undefined;
  const contextRecord = isPlainRecord(record.context) ? record.context : undefined;
  return (
    normalizeProviderBusinessCode(record.code) ??
    normalizeProviderBusinessCode(record.providerCode) ??
    normalizeProviderBusinessCode(record.error_code) ??
    normalizeProviderBusinessCode(errorRecord?.code) ??
    normalizeProviderBusinessCode(errorRecord?.providerCode) ??
    normalizeProviderBusinessCode(errorRecord?.error_code) ??
    normalizeProviderBusinessCode(contextRecord?.providerCode) ??
    normalizeProviderBusinessCode(contextRecord?.code)
  );
}

/**
 * 按固定优先级读取可读错误信息：msg → providerMessage → message，
 * 再看 error 子对象与 context。
 *
 * 只接受非空字符串并 trim；数字/对象一律忽略，避免把 provider 的原始 body
 * 直接塞进用户可见错误。纯函数，无副作用。
 */
function readProviderBusinessMessage(record: Record<string, unknown>): string | undefined {
  const errorRecord = isPlainRecord(record.error) ? record.error : undefined;
  const contextRecord = isPlainRecord(record.context) ? record.context : undefined;
  return (
    normalizeProviderBusinessMessage(record.msg) ??
    normalizeProviderBusinessMessage(record.providerMessage) ??
    normalizeProviderBusinessMessage(record.message) ??
    normalizeProviderBusinessMessage(errorRecord?.msg) ??
    normalizeProviderBusinessMessage(errorRecord?.providerMessage) ??
    normalizeProviderBusinessMessage(errorRecord?.message) ??
    normalizeProviderBusinessMessage(contextRecord?.providerMessage) ??
    normalizeProviderBusinessMessage(contextRecord?.msg) ??
    normalizeProviderBusinessMessage(contextRecord?.message)
  );
}

/**
 * 为响应体生成可安全落进错误上下文的摘要。
 *
 * 只保留 string/number/boolean 标量与"全字符串数组"字段；嵌套对象、混合数组、
 * undefined 一律丢弃，防止把凭据/大 payload 或循环引用带进日志与错误展示。
 * 摘要为空时返回 undefined，让调用方省略该字段。纯函数，无副作用。
 */
function summarizeProviderBusinessMetadataBody(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      summary[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      summary[key] = value;
    }
  }

  return Object.keys(summary).length > 0 ? summary : undefined;
}

/**
 * 归一化业务码：有限数字截断取整后转字符串，字符串 trim 后非空才保留。
 *
 * 统一成字符串是为了让"0"/"200" 之类的比较只有一种形态；无法识别的布尔/对象
 * 返回 undefined，交由上层视为"没有业务码"。纯函数，无副作用。
 */
function normalizeProviderBusinessCode(value: unknown): string | undefined {
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
 * 归一化错误信息：只接受字符串，trim 后为空视为缺失。
 * 不做截断或脱敏，脱敏由更外层的错误展示层负责。纯函数，无副作用。
 */
function normalizeProviderBusinessMessage(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * 判定业务码是否代表失败：0（含 "0"）视为成功，任何非 0 视为失败。
 *
 * 非数字字符串（如 "invalid_api_key"）同样算失败——这类码无法用数值 0 表达成功，
 * 缺省按失败处理更安全，避免把真实错误当成成功放过。纯函数，无副作用。
 */
function isNonZeroProviderBusinessCode(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric !== 0 : true;
}
