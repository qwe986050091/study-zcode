// INV-01 五种模型网络状态是白名单：守住位置 MODEL_NETWORK_STATUS_TYPES；改错故障 未知类型进入事件。
// INV-02 类型不在白名单即丢弃：守住位置 首个提前返回；改错故障 客户端收到无意义状态。
// INV-03 事件键缺省由六段拼接：守住位置 eventKey 构造；改错故障 同类事件互相覆盖。
// INV-04 调用方事件标识优先：守住位置 eventId 回退顺序；改错故障 上游编号被覆盖。
// INV-05 查询标识双来源：守住位置 resolvedQueryId；改错故障 旧载荷丢失关联。
// INV-06 请求头只收字符串值：守住位置 stringRecordValue；改错故障 嵌套对象进入事件。
// INV-07 头部计数缺省取实际键数：守住位置 空值回退；改错故障 计数与内容不一致。
// INV-08 可选字段只在合法时展开：守住位置 条件展开；改错故障 未定义键污染事件。
// INV-09 模型标识拆成两个可选字段：守住位置 asRecord 与逐字段取值；改错故障 整个对象被透传。
// INV-10 数值必须非负有限：守住位置 nonNegativeNumberValue；改错故障 负数时长进入看板。
// INV-11 整数必须非负：守住位置 nonNegativeIntegerValue；改错故障 小数计数被接受。
// INV-12 尝试次数必须为正：守住位置 positiveIntegerValue；改错故障 零次尝试被记录。
// INV-13 布尔只接受真布尔：守住位置 booleanValue；改错故障 字符串真值被当可重试。
// INV-14 空字符串视为缺失：守住位置 stringValue；改错故障 空值占位进入事件。
// INV-15 数组不当作记录：守住位置 asRecord；改错故障 数组下标被当字段名。
// INV-16 头部保持原始键序：守住位置 fromEntries；改错故障 顺序抖动影响快照。
// INV-17 状态类型收窄不用断言逃逸：守住位置 类型守卫；改错故障 非法字符串进入联合类型。
// INV-18 本文件不做 I/O 与状态缓存：守住位置 纯函数边界；改错故障 事件构造被副作用污染。
//
// 模块职责：把任务载荷归类为网络调试状态事件。
// 状态所有权：无状态；只有只读白名单集合与纯转换函数。
// 阅读顺序：先看白名单，再读事件构造，最后看各类型守卫。
import type {
  InputId,
  QueryId,
  TraceId,
  ZCodeStreamEvent,
  ZCodeTaskNetworkDebugStatusType,
} from "./zcode-task-types-core.js";

// MODEL_NETWORK_STATUS_TYPES 是五类模型网络状态的白名单。
// networkStatusTypeValue 遇到未知类型返回 undefined，调用方直接丢弃该事件。
// 集合在模块加载时固定，运行期不再增删成员。
// 新增状态类型必须同步写进 MODEL_NETWORK_STATUS_TYPES，否则会被静默丢弃。
// model_retry_scheduled 与 model_stream_stalled 都属于调试面。
// MODEL_NETWORK_STATUS_TYPES 只做成员判断，不参与任何运行时推导。
const MODEL_NETWORK_STATUS_TYPES = new Set<ZCodeTaskNetworkDebugStatusType>([
  "model_request_started",
  "model_request_completed",
  "model_request_failed",
  "model_retry_scheduled",
  "model_stream_stalled",
]);

// networkStatusTypeValue 返回空时整个函数返回 null，不构造半成品事件。
// requestHeaders 与 responseHeaders 先经 stringRecordValue 收敛成字符串字典。
// model 记录里的 providerId、modelId 拆成两个可选字段。
// eventKey 缺省由 traceId、inputId、statusType 等六段 join 拼出。
// attempt、timestamp 等可选数值只在通过 positiveIntegerValue 校验时写入。
// requestHeaderCount 缺省取 Object.keys(requestHeaders).length，即实际键数。
export function zcodeTaskNetworkDebugStatusFromPayload(params: {
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryId?: QueryId;
  eventId?: string;
  payload: Record<string, unknown>;
}): Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }> | null {
  const statusType = networkStatusTypeValue(params.payload.type);
  if (!statusType) {
    return null;
  }

  const requestHeaders = stringRecordValue(params.payload.requestHeaders);
  const responseHeaders = stringRecordValue(params.payload.responseHeaders);
  const model = asRecord(params.payload.model);
  const requestId = stringValue(params.payload.requestId);
  const queryId = stringValue(params.payload.queryId) as QueryId | undefined;
  const resolvedQueryId = params.queryId ?? queryId;
  const attempt = positiveIntegerValue(params.payload.attempt);
  const timestamp = stringValue(params.payload.timestamp);
  const eventKey =
    params.eventId ??
    [
      params.traceId,
      params.inputId ?? "no-input",
      statusType,
      requestId ?? "no-request",
      attempt ?? "no-attempt",
      timestamp ?? "no-time",
    ].join(":");

  return {
    type: "task_network_debug_status",
    taskId: params.taskId,
    traceId: params.traceId,
    ...(params.inputId ? { inputId: params.inputId } : {}),
    ...(resolvedQueryId ? { queryId: resolvedQueryId } : {}),
    eventKey,
    ...(params.eventId ? { eventId: params.eventId } : {}),
    statusType,
    ...(requestId ? { requestId } : {}),
    ...(stringValue(model.providerId) ? { providerId: stringValue(model.providerId) } : {}),
    ...(stringValue(model.modelId) ? { modelId: stringValue(model.modelId) } : {}),
    ...(stringValue(params.payload.providerKind)
      ? { providerKind: stringValue(params.payload.providerKind) }
      : {}),
    ...(stringValue(params.payload.transport)
      ? { transport: stringValue(params.payload.transport) }
      : {}),
    ...(stringValue(params.payload.baseURL)
      ? { baseURL: stringValue(params.payload.baseURL) }
      : {}),
    ...(stringValue(params.payload.querySource)
      ? { querySource: stringValue(params.payload.querySource) }
      : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(positiveIntegerValue(params.payload.maxAttempts) !== undefined
      ? { maxAttempts: positiveIntegerValue(params.payload.maxAttempts) }
      : {}),
    ...(positiveIntegerValue(params.payload.nextAttempt) !== undefined
      ? { nextAttempt: positiveIntegerValue(params.payload.nextAttempt) }
      : {}),
    ...(booleanValue(params.payload.retryable) !== undefined
      ? { retryable: booleanValue(params.payload.retryable) }
      : {}),
    ...(nonNegativeIntegerValue(params.payload.statusCode) !== undefined
      ? { statusCode: nonNegativeIntegerValue(params.payload.statusCode) }
      : {}),
    ...(nonNegativeNumberValue(params.payload.durationMs) !== undefined
      ? { durationMs: nonNegativeNumberValue(params.payload.durationMs) }
      : {}),
    ...(nonNegativeNumberValue(params.payload.delayMs) !== undefined
      ? { delayMs: nonNegativeNumberValue(params.payload.delayMs) }
      : {}),
    ...(nonNegativeNumberValue(params.payload.idleMs) !== undefined
      ? { idleMs: nonNegativeNumberValue(params.payload.idleMs) }
      : {}),
    ...(nonNegativeNumberValue(params.payload.timeoutMs) !== undefined
      ? { timeoutMs: nonNegativeNumberValue(params.payload.timeoutMs) }
      : {}),
    ...(stringValue(params.payload.reason) ? { reason: stringValue(params.payload.reason) } : {}),
    ...(stringValue(params.payload.message)
      ? { message: stringValue(params.payload.message) }
      : {}),
    ...(timestamp ? { timestamp } : {}),
    requestHeaders,
    responseHeaders,
    requestHeaderCount:
      nonNegativeIntegerValue(params.payload.requestHeaderCount) ??
      Object.keys(requestHeaders).length,
    responseHeaderCount:
      nonNegativeIntegerValue(params.payload.responseHeaderCount) ??
      Object.keys(responseHeaders).length,
  };
}

// networkStatusTypeValue 只接受 typeof 为 string 的入参。
// 命中 MODEL_NETWORK_STATUS_TYPES 白名单才做类型断言。
// 其余情况一律返回 undefined，不抛异常。
// 该守卫不做二次解析，调用方需要自己保证 payload 形状。
// 调用方拿到 undefined 就提前退出，不再往下构造事件。
function networkStatusTypeValue(value: unknown): ZCodeTaskNetworkDebugStatusType | undefined {
  return typeof value === "string" && MODEL_NETWORK_STATUS_TYPES.has(value as never)
    ? (value as ZCodeTaskNetworkDebugStatusType)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// asRecord 把非对象一律当空记录，null 与 undefined 走同一条路。
// Array.isArray 为真时也不接受，数组不是键值记录。
// Object.entries 过滤后只保留 typeof 为 string 的条目。
// Object.fromEntries 保持原键顺序，不重排也不丢失。
// stringRecordValue 遇到空对象也返回空记录，调用方不需要判空。
function stringRecordValue(value: unknown): Record<string, string> {
  const record = asRecord(value);
  return Object.fromEntries(
    Object.entries(record)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, entryValue]) => [key, entryValue]),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function nonNegativeNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeIntegerValue(value: unknown): number | undefined {
  return Number.isInteger(value) && typeof value === "number" && value >= 0 ? value : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
  return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}
