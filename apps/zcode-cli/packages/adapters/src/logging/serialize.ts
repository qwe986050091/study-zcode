/**
 * ============================================================================
 * logging/serialize.ts —— 日志条目序列化与敏感信息脱敏
 * ============================================================================
 *
 * 【定位】LogEntry → 可 JSON.stringify 的纯对象；错误对象单独展开 cause 链；
 * DefaultLogRedactor 按 key 名正则脱敏。
 *
 * 【口径】undefined 字段整体省略（不写 null）；stack 仅在 includeStack 时保留；
 * 嵌套深度上限 8，环引用标记为 "[Redacted:Circular]"。
 *
 * 【失败语义】纯函数不抛错；错误对象退化为 UnknownError 字符串，保证日志
 * 永远可序列化（含 getter 抛错的对象也只读取自有 string 属性）。
 * ============================================================================
 */
import type { LogContext, LogEntry, LogRedactor } from "@zcode/contracts";

export interface SerializedLogError {
  name: string;
  message: string;
  /** Node 错误码（ENOENT 等）；仅非空字符串保留。 */
  code?: string;
  /** 领域错误类型（如 provider 错误分类）；仅非空字符串保留。 */
  type?: string;
  /** 默认不输出，避免日志体积与内部路径泄漏；由 includeStack 控制。 */
  stack?: string;
  /** 错误自带的上下文对象（仅普通对象）。 */
  context?: Record<string, unknown>;
  /** 递归展开的 cause；深度 8 或环引用时替换为占位错误。 */
  cause?: SerializedLogError;
}

export type SerializableLogEntry = Record<string, unknown>;

/**
 * 默认脱敏器：按 key 名匹配敏感词（api key/authorization/cookie/credential/
 * password/secret/token），命中即整体替换为 "[Redacted]"。
 *
 * 采用 key 名而非值内容匹配，避免误伤普通文本；深度 8 与 WeakSet 环检测
 * 保证任意对象图都能安全遍历。
 */
export class DefaultLogRedactor implements LogRedactor {
  private readonly sensitiveKeyPattern =
    /(?:api[-_]?key|authorization|cookie|credential|password|secret|token)/i;

  redact(value: unknown): unknown {
    return this.redactValue(value, new WeakSet(), 0);
  }

  /** 深度/环引用兜底，保证序列化不会因用户对象自引用而爆栈。 */
  private redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
    if (depth > 8) {
      return "[Redacted:DepthLimit]";
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (seen.has(value)) {
      return "[Redacted:Circular]";
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item, seen, depth + 1));
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
        key,
        this.sensitiveKeyPattern.test(key)
          ? "[Redacted]"
          : this.redactValue(entryValue, seen, depth + 1),
      ]),
    );
  }
}

/**
 * 从 LogContext 中剔除已被提升为 LogEntry 顶层字段的保留键。
 *
 * 返回 undefined 表示没有剩余自由字段，调用方据此省略 context 字段；
 * 仅做浅层解构，不修改入参。
 */
export function stripReservedContext(context: LogContext): Record<string, unknown> | undefined {
  const {
    durationMs: _durationMs,
    event: _event,
    module: _module,
    parentSpanId: _parentSpanId,
    sessionId: _sessionId,
    spanId: _spanId,
    status: _status,
    toolCallId: _toolCallId,
    traceId: _traceId,
    turnId: _turnId,
    ...rest
  } = context;

  return Object.keys(rest).length === 0 ? undefined : rest;
}

/**
 * 把 LogEntry 转成可 JSON 序列化的扁平对象。
 *
 * timestamp 用 ISO 字符串；level 用小写名；context/error 先经 redactor；
 * 最后统一剔除 undefined 字段，避免 JSONL 中出现大量 null 占位。
 */
export function toSerializableEntry(
  entry: LogEntry,
  redactor: LogRedactor,
): SerializableLogEntry {
  const value = {
    timestamp: entry.timestamp.toISOString(),
    level: entry.levelName.toLowerCase(),
    event: entry.event,
    module: entry.module,
    message: entry.message,
    traceId: entry.traceId,
    spanId: entry.spanId,
    parentSpanId: entry.parentSpanId,
    sessionId: entry.sessionId,
    turnId: entry.turnId,
    toolCallId: entry.toolCallId,
    durationMs: entry.durationMs,
    status: entry.status,
    context: redactor.redact(entry.context),
    error: redactor.redact(entry.error),
  };

  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

/**
 * 生成 stderr 人读行：`level [module] trace=xxxxxxxx event=x message`。
 *
 * traceId 只取前 8 位，够关联且不刷屏；缺失字段直接省略。
 */
export function formatConsoleLine(entry: LogEntry): string {
  const trace = entry.traceId ? ` trace=${entry.traceId.slice(0, 8)}` : "";
  const event = entry.event ? ` event=${entry.event}` : "";
  return `${entry.levelName.toLowerCase()} [${entry.module ?? "log"}]${trace}${event} ${entry.message}`;
}

/** 运行时校验 LogEntry.status 的五个合法值（started/waiting/completed/failed/cancelled）。 */
export function isLogStatus(value: unknown): value is LogEntry["status"] {
  return (
    value === "started" ||
    value === "waiting" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

/**
 * 递归序列化任意错误（含非 Error 值）。
 *
 * 只读取 name/message/code/type/stack/context/cause 自有字段；深度 8 与环
 * 引用分别返回占位错误，保证日志写入永不因错误对象形状异常而失败。
 */
export function serializeLogError(
  error: unknown,
  includeStack: boolean,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): SerializedLogError {
  if (depth > 8) {
    return {
      name: "ErrorCauseDepthLimit",
      message: "Error cause chain exceeded the serialization depth limit.",
    };
  }

  if (error === null || typeof error !== "object") {
    return {
      name: "UnknownError",
      message: String(error),
    };
  }

  if (seen.has(error)) {
    return {
      name: "ErrorCauseCircularReference",
      message: "Error cause chain contained a circular reference.",
    };
  }
  seen.add(error);

  const record = error as Record<string, unknown>;
  const cause = record.cause;
  const value: SerializedLogError = {
    name: typeof record.name === "string" ? record.name : "Error",
    message: typeof record.message === "string" ? record.message : String(error),
  };
  const code = stringProperty(record, "code");
  const type = stringProperty(record, "type");
  const context = record.context;

  if (code) value.code = code;
  if (type) value.type = type;
  if (includeStack && typeof record.stack === "string") value.stack = record.stack;
  if (isPlainObject(context)) value.context = context;
  if (cause !== undefined) value.cause = serializeLogError(cause, includeStack, seen, depth + 1);

  return value;
}

function stringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
