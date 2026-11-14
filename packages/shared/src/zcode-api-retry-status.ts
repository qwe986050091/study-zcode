// INV-01 null 表示明确无重试：守住位置 首个 if 的值判等；改错故障 已恢复会话被重新标成重试。
// INV-02 空对象表示无从判断：守住位置 Object.keys(record).length；改错故障 缺字段的上报被当成有重试。
// INV-03 attempt 可由 nextAttempt 反推：守住位置 两个 positiveIntegerValue 的 ?? 链；改错故障 上游只给下次序号时展示成 1/1。
// INV-04 attempt 下限为 1：守住位置 Math.max(..., 1)；改错故障 出现 0 次重试的非法文案。
// INV-05 maxRetries 不得小于 attempt：守住位置 外层 Math.max；改错故障 展示 3/2 这类自相矛盾进度。
// INV-06 maxAttempts 是总次数而非重试数：守住位置 减一运算；改错故障 上限整体多一。
// INV-07 延迟缺省为 0 而不是 undefined：守住位置 retryDelayMs 的 ?? 0；改错故障 下游计时器收到 NaN。
// INV-08 错误状态码缺省为 null：守住位置 errorStatus 的 ?? null；改错故障 0 被当成有效 HTTP 状态。
// INV-09 错误文案有多级回退：守住位置 error 的 ?? 链；改错故障 空提示让用户不知道在重试什么。
// INV-10 默认文案只在全缺失时使用：守住位置 末尾字符串常量；改错故障 上游文案被覆盖。
// INV-11 stream recovery 优先于普通 attempt 判断：守住位置 model_request_started 分支；改错故障 每次新请求都把重试计数清零。
// INV-12 request_started 且 attempt 不大于 1 才清空：守住位置 提前 return null；改错故障 重试中的状态被误清。
// INV-13 未识别事件返回 undefined 而非 null：守住位置 末尾 return；改错故障 投影层把未知事件当成已恢复。
// INV-14 恢复进展只认有内容的增量：守住位置 Boolean 包裹的取值；改错故障 空增量就清掉重试提示。
//
// 模块职责：把模型网络状态与 stream recovery 载荷归一成可展示的 API 重试状态。
// 阅读顺序：先看 normalize 的字段回退，再看事件分派，最后看恢复进展判定与 stream recovery 提取。
import type { ZCodeApiRetryStatus } from "./zcode-task-types-core.js";

export function normalizeZCodeApiRetryStatus(
  value: unknown,
): ZCodeApiRetryStatus | null | undefined {
  if (value === null) {
    return null;
  }
  // 非对象一律折成空对象，后续字段读取不需要再判空。
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return undefined;
  }
  // 优先取 attempt，缺失时从 nextAttempt 反推，两者都没有则按 2-1 兜底。
  const attempt =
    positiveIntegerValue(record.attempt) ??
    Math.max((positiveIntegerValue(record.nextAttempt) ?? 2) - 1, 1);
  // 外层再与 attempt 取大，保证进度不会出现已完成大于总数。
  const maxRetries = Math.max(
    nonNegativeIntegerValue(record.maxRetries) ??
      (positiveIntegerValue(record.maxAttempts) ?? attempt + 1) - 1,
    attempt,
  );
  return {
    // kind 固定，调用方据此区分重试态与普通错误。
    kind: "api_retry",
    attempt,
    maxRetries,
    retryDelayMs:
      nonNegativeIntegerValue(record.retryDelayMs) ?? nonNegativeIntegerValue(record.delayMs) ?? 0,
    errorStatus:
      nonNegativeIntegerValue(record.errorStatus) ??
      nonNegativeIntegerValue(record.statusCode) ??
      null,
    error:
      stringValue(record.error) ??
      stringValue(record.message) ??
      stringValue(record.reason) ??
      "Model retry scheduled",
  };
}

// 事件类型决定返回态：null 是已恢复，undefined 是无信息。
// 先看 stream recovery，再退回普通 attempt 判断。
export function zcodeApiRetryFromModelNetworkStatusPayload(
  payload: Record<string, unknown>,
): ZCodeApiRetryStatus | null | undefined {
  const type = stringValue(payload.type);
  if (type === "model_retry_scheduled") {
    return normalizeZCodeApiRetryStatus(payload);
  }
  if (type === "model_request_started") {
    const streamRecoveryRetry = zcodeApiRetryFromStreamRecoveryPayload(payload.streamRecovery);
    if (streamRecoveryRetry !== undefined) {
      return streamRecoveryRetry;
    }
    if ((positiveIntegerValue(payload.attempt) ?? 1) <= 1) {
      return null;
    }
    // 普通 adapter retry 的 request_started 只代表下一次请求开始，
    // 不代表已经恢复成功；这里保持 undefined，让投影层等首个有效模型进展再清理重试态。
  }
  // 完成事件是确定的恢复信号。
  if (type === "model_request_completed") {
    return null;
  }
  // 不可重试的失败同样说明重试链已结束。
  if (type === "model_request_failed" && payload.retryable !== true) {
    return null;
  }
  return undefined;
}

// 只有带内容的文本或推理增量才算有效进展。
// 工具调用必须有 id，否则无法证明是新一轮输出。
export function isZCodeModelRetryRecoveryProgressPayload(
  payload: Record<string, unknown>,
): boolean {
  const kind = stringValue(payload.kind);
  if (kind === "text_delta" || kind === "reasoning_delta") {
    return Boolean(stringValue(payload.delta));
  }
  const toolCallId = stringValue(payload.toolCallId);
  if (!toolCallId) {
    return false;
  }
  if (kind === "tool_input_start" || kind === "tool_input_end" || kind === "tool_call") {
    return true;
  }
  if (kind === "tool_input_delta") {
    return Boolean(stringValue(payload.delta));
  }
  return false;
}

// retryNumber 缺失即视为不是 stream recovery 载荷。
// maxRetries 缺省等于当前次数，展示为 n/n。
export function zcodeApiRetryFromStreamRecoveryPayload(
  value: unknown,
): ZCodeApiRetryStatus | undefined {
  const record = asRecord(value);
  const attempt = positiveIntegerValue(record.retryNumber);
  if (attempt === undefined) {
    return undefined;
  }
  // core stream recovery 每次新请求都是 adapter attempt=1，
  // 旧 UI 会误清空重试状态；这里改用 streamRecovery.retryNumber 展示 1/10、2/10。
  return {
    kind: "api_retry",
    attempt,
    maxRetries: Math.max(nonNegativeIntegerValue(record.maxRetries) ?? attempt, attempt),
    retryDelayMs: 0,
    errorStatus: null,
    error: stringValue(record.message) ?? "Model stream recovery retry started",
  };
}

// 数组也是 object，必须显式排除，否则下标会被当成字段。
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonNegativeIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
  // 正整数校验额外要求大于 0，0 视为缺失。
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
