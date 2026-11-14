// ============================================================
// Logger contracts - cross-cutting logging capability
// ============================================================

import type { TraceId } from "../interfaces/shared.js";

// -----------------------------------------------
// Log Levels
// -----------------------------------------------

/**
 * 日志级别枚举：数值越大越严重，供阈值比较与落盘过滤。
 *
 * 生产者：LoggerFactory.setLevel 与各 logger 的 debug/info/warn/error 方法。
 * 消费者：Adapter 的序列化/落盘实现按“当前级别 ≥ 本级别”决定是否输出。
 *
 * 不变量：数值是持久化与配置比较的事实（不是展示名）；跨进程只传数值或名称，
 * 不得在别处重新编号，否则历史日志的级别门槛会漂移。
 */
export const LogLevel = {
  Debug: 0,
  Info: 1,
  Warn: 2,
  Error: 3,
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/**
 * 级别的稳定展示名：与 `LogLevel` 数值一一映射，大写且固定。
 *
 * 生产者：Adapter 在序列化日志条目时由数值反查；`LogEntry.levelName` 即由此产生。
 * 消费者：日志检索、终端着色与外部采集系统的级别过滤。
 *
 * 不变量：这里是名称到数值的反向表，映射集合必须与 LogLevel 完全一致；
 * 持久化后的 levelName 不能作为无损失的数值还原来源（应以 level 字段为准）。
 */
export const LogLevelName = {
  [LogLevel.Debug]: "DEBUG",
  [LogLevel.Info]: "INFO",
  [LogLevel.Warn]: "WARN",
  [LogLevel.Error]: "ERROR",
} as const;

// -----------------------------------------------
// Log Entry
// -----------------------------------------------

/**
 * 单条日志的完整可持久化投影：由 Logger 实现把调用参数与上下文归一后产出。
 *
 * 生产者：Adapter/logger 实现（调用 debug/info/warn/error 时组装）。
 * 消费者：落盘、终端渲染与外部日志采集；字段一经写入即视为历史事实。
 *
 * 跨进程不变量：error 必须是 `LogError` 结构而不是 Error 实例（Error 不可 JSON 序列化、
 * stack 也可能含路径）；context 必须是已脱敏后的普通键值，不得放原始凭据或完整用户内容。
 */
export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  levelName: string;
  event?: string;
  module?: string;
  message: string;
  /** 顶层追踪标识：一次顶层任务的完整链路；日志侧只做关联，不决定业务归属。 */
  traceId?: TraceId;
  sessionId?: string;
  turnId?: string;
  spanId?: string;
  parentSpanId?: string;
  toolCallId?: string;
  /** 已完成的耗时（毫秒）；只有事件收尾日志才应填写，进行中的日志缺省。 */
  durationMs?: number;
  /** 事件生命周期阶段；与 message 互补，供 UI/检索按状态过滤。 */
  status?: "started" | "waiting" | "completed" | "failed" | "cancelled";
  /** 脱敏后的结构化补充字段；键值必须可序列化，禁止放 Error 实例或二进制。 */
  context?: Record<string, unknown>;
  /** 归一化后的错误投影；不含原始异常对象，避免把内部引用带出进程。 */
  error?: LogError;
}

/**
 * 错误的可序列化投影：把 Error/自定义错误压成稳定字段，供跨进程与持久化消费。
 *
 * 生产者：Logger.error 或适配层的错误归一化函数。
 * 消费者：日志检索、错误聚合与 UI 错误提示；code/type 用于流程判断，message 只用于人读。
 *
 * 不变量：cause 允许递归但必须有界，避免环形引用；stack 属于高敏诊断信息，
 * 只应进入受控日志路径，不能默认回显给终端用户。
 */
export interface LogError {
  name: string;
  message: string;
  code?: string;
  type?: string;
  stack?: string;
  context?: Record<string, unknown>;
  cause?: LogError;
}

// -----------------------------------------------
// Log Context
// -----------------------------------------------

/**
 * 日志调用的上下文袋（scoped fields）：由调用方逐次传入，Logger.child 负责向下继承。
 *
 * 生产者：core/adapter 的业务日志点、`traceContextToLogContext` 的追踪投影。
 * 消费者：Logger 实现把它合并进 `LogEntry.context` 并经过 `LogRedactor`。
 *
 * 不变量：索引签名允许业务自由附带字段，但这些字段同样受脱敏约束；
 * trace/session/turn/span/toolCall 这些固定键只表达关联，不改变层级或归属。
 */
export interface LogContext {
  traceId?: TraceId;
  sessionId?: string;
  turnId?: string;
  spanId?: string;
  parentSpanId?: string;
  toolCallId?: string;
  event?: string;
  module?: string;
  durationMs?: number;
  status?: "started" | "waiting" | "completed" | "failed" | "cancelled";
  [key: string]: unknown;
}

// -----------------------------------------------
// Logger Port Interface
// -----------------------------------------------

/**
 * 日志端口：各层只依赖这五个方法，不直接触碰 console/文件/进程环境。
 *
 * 生产者：Adapter 的 logger 实现与 `createServiceLogger` 等工厂。
 * 消费者：core、tool runtime、provider client、CLI 入口的跨切面诊断调用。
 *
 * 不变量：`child` 必须返回携带合并上下文的派生 logger，且继承不得丢失 traceId；
 * 调用本身不得抛错影响主链路（日志失败最多降级为丢弃）。error 较重载固定为
 * `(message, error?, context?)`，避免调用方把 error 塞进第二参数造成类型漂移。
 */
export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: Error, context?: LogContext): void;
  child(context: LogContext): Logger;
}

// -----------------------------------------------
// Logger Factory
// -----------------------------------------------

/**
 * 进程级 Logger 工厂：负责类别划分、全局上下文与级别阈值的唯一入口。
 *
 * 生产者：bootstrap/CLI 启动时按运行环境创建一次并注入各层。
 * 消费者：各模块通过 `createLogger(category)` 取得稳定类别名，便于按 module 过滤。
 *
 * 不变量：`setLevel` 影响的是后续输出阈值而非历史条目；`withContext` 产生的 logger
 * 不得反向污染全局上下文（上下文按实例继承，不能改写入参对象）。
 */
export interface LoggerFactory {
  createLogger(category: string): Logger;
  withContext(context: LogContext): Logger;
  setLevel(level: LogLevel): void;
}

/**
 * 脱敏端口：日志落盘/外发前的最后一道边界，按敏感键名与值形态做替换。
 *
 * 生产者：Adapter 的日志序列化实现（如 DefaultLogRedactor）。
 * 消费者：所有日志 sink；UI 日志与 CLI 文件日志共用同一口径。
 *
 * 不变量：redact 必须保持输入结构（对象/数组形态不变，仅敏感叶子被替换），
 * 且要处理循环引用；它不负责“决定哪些字段该记”，那是调用点的职责边界。
 */
export interface LogRedactor {
  redact(value: unknown): unknown;
}
