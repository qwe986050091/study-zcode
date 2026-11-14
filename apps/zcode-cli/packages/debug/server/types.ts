/**
 * 调试服务端观测数据的类型契约。
 *
 * 职责：统一描述日志、会话事件、数据库快照与抓包数据的记录结构，供 analyzer、sources、
 * observation-events 与前端共享，避免各层各自定义字段口径。
 * 字段口径：所有记录都带 `sourcePath` 与 `line` 以便原样定位；`traceId/sessionId/turnId` 等
 * 为可选过滤键，缺省表示“不施加过滤”，不等价于匹配空值。
 * 副作用：纯类型声明，运行时完全擦除，不参与任何 IO。
 */
import type { ObservationSourceKind } from "../src/shared.js";

/** 观测查询参数（来自 HTTP query 或 SSE 请求）；未提供即不过滤。 */
export interface ObservationOptions {
  traceId?: string;
  sessionId?: string;
  logDir?: string;
  dbPath?: string;
  eventPath?: string;
  projectId?: string;
  limit?: number;
}

/** JSONL 单行解析结果；保留行号用于在前端回跳原始文件。 */
export interface JsonRecord {
  value: Record<string, unknown>;
  sourcePath: string;
  line: number;
}

/**
 * 单个数据源的加载结果。
 * `warning` 非空表示该源缺失或部分不可读，但整体观测仍可用——调用方应展示告警，
 * 不应把单源问题升级为整次观测失败。
 */
export interface SourceLoadResult<TRecord> {
  kind: ObservationSourceKind;
  label: string;
  path?: string;
  records: TRecord[];
  warning?: string;
}

/** 结构化日志记录；`context/error` 保留原始结构，展示裁剪由前端负责。 */
export interface LogRecord {
  timestamp?: string;
  level?: string;
  event?: string;
  module?: string;
  message?: string;
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  spanId?: string;
  parentSpanId?: string;
  toolCallId?: string;
  durationMs?: number;
  status?: string;
  context?: Record<string, unknown>;
  error?: unknown;
  sourcePath: string;
  line: number;
}

/** 会话事件记录；`id` 为事件唯一键，`sequenceNumber` 用于同一 trace 内的时间线排序。 */
export interface EventRecord {
  id: string;
  type: string;
  timestamp?: string;
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  spanId?: string;
  parentSpanId?: string;
  sequenceNumber?: number;
  payload?: Record<string, unknown>;
  sourcePath: string;
  line: number;
}

/** 数据库会话记录；`projectId` 用于按项目聚合，`directory` 为会话工作目录。 */
export interface DbSessionRecord {
  id: string;
  projectId: string;
  title: string;
  directory: string;
  createdAt?: string;
  updatedAt?: string;
}

/** 数据库消息记录；`data` 保存消息原始 JSON，字段解释权归读取端。 */
export interface DbMessageRecord {
  id: string;
  sessionId: string;
  role?: string;
  createdAt?: string;
  updatedAt?: string;
  data: Record<string, unknown>;
}

/** 消息片段记录；通过 `messageId` 挂到消息、`sessionId` 用于跨表过滤。 */
export interface DbPartRecord {
  id: string;
  messageId: string;
  sessionId: string;
  type?: string;
  createdAt?: string;
  updatedAt?: string;
  data: Record<string, unknown>;
}

/** 数据库观测快照：会话、消息、part 三段一次读取，由调用方按 id 关联。 */
export interface DbObservation {
  sessions: DbSessionRecord[];
  messages: DbMessageRecord[];
  parts: DbPartRecord[];
}

/** 三类来源的聚合结果；各源独立解析，单源失败只体现为自身 warning。 */
export interface LoadedObservation {
  logs: SourceLoadResult<LogRecord>;
  events: SourceLoadResult<EventRecord>;
  db: SourceLoadResult<DbObservation>;
}
