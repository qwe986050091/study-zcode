// INV-01 路径先解析为绝对路径：守住位置 三个 loader 的首行 resolve；改错故障 相对路径随进程 cwd 漂移。
// INV-02 日志目录有默认值、事件文件没有：守住位置 loadLogs 与 loadEventLog 的入参处理；改错故障 猜错事件文件位置反而读到别的数据。
// INV-03 SQLite 一律只读打开：守住位置 DatabaseSync 的 readOnly；改错故障 调试端写坏生产会话库。
// INV-04 三表读取上限固定：守住位置 三个 read* 的 limit；改错故障 全库拉取拖垮调试接口。
// INV-05 句柄必在 finally 关闭：守住位置 loadSqlite 收尾块；改错故障 WAL/SHM 被长期占用，CLI 写入被拖慢。
// INV-06 源缺失降级为 warning：守住位置 各 loader 的早退分支；改错故障 一个源缺文件就让整页 500。
// INV-07 单行坏 JSON 只影响该行：守住位置 readJsonlFiles 的内层捕获；改错故障 一条坏行清空整个文件。
// INV-08 单文件读失败不影响其他文件：守住位置 外层捕获；改错故障 一个权限错误丢掉整批记录。
// INV-09 行号是 1 基物理行号：守住位置 entries 索引加一；改错故障 前端回跳错行。
// INV-10 目录只认 .jsonl/.log 并按名排序：守住位置 filter 与 sort；改错故障 读到垃圾文件、顺序不稳定。
// INV-11 每条记录都带来源：守住位置 JsonRecord 包装；改错故障 前端无法定位原始行。
// INV-12 空串等同未提供：守住位置 stringValue；改错故障 空 event 被当成合法事件。
// INV-13 数字只认有限值：守住位置 numberValue；改错故障 NaN 进入时间戳与用量。
// INV-14 解析结果只收普通对象：守住位置 isRecord；改错故障 数组被当记录读取、字段全是 undefined。
//
// 模块职责：把日志 JSONL、Session 事件 JSONL 与 SQLite 会话库读成 types.ts 的统一记录集。
// 状态所有权：无模块级状态；数据库句柄在单次调用内创建并关闭。
// 阅读顺序：先看默认路径，再看三个 loader，最后看 JSONL 读取与字段归一工具。
/**
 * 观测数据源读取：日志 JSONL、Session 事件 JSONL 与 SQLite 会话库。
 *
 * 职责：把本地文件/数据库里的原始记录转换为 `types.ts` 定义的统一记录，
 * 并以 `SourceLoadResult` 返回“数据 + 局部告警”，供 analyzer 与 HTTP/SSE 层直接消费。
 * 输入口径：路径优先取 `ObservationOptions`，缺省回落到 `~/.zcode/cli/...`。
 * 输出口径：每条记录都带 `sourcePath` 与行号；SQLite 以只读方式打开，读取上限固定。
 * 失败语义：源缺失/解析失败不抛错，降级为 `warning`，保证其他源仍可展示。
 * 不变量：数据库句柄必须在 finally 中关闭，避免调试端长期占用 WAL。
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DbMessageRecord,
  DbObservation,
  DbPartRecord,
  DbSessionRecord,
  EventRecord,
  JsonRecord,
  LogRecord,
  ObservationOptions,
  SourceLoadResult,
} from "./types.js";

/** 默认结构化日志目录（`~/.zcode/cli/log`）；仅提供路径，不检查存在性。 */
export function defaultLogDir(): string {
  return join(homedir(), ".zcode", "cli", "log");
}

/** 默认 SQLite 会话库路径（`~/.zcode/cli/db/db.sqlite`）；WAL/SHM 由调用方按后缀推导。 */
export function defaultDbPath(): string {
  return join(homedir(), ".zcode", "cli", "db", "db.sqlite");
}

/**
 * 加载结构化日志。
 * 输入：`options.logDir` 优先，缺省用 `defaultLogDir()`；目录下只读 .jsonl/.log，单文件直接读取。
 * 输出：合法日志记录（保留文件与行号）；无 message 且无 event 的行被过滤。
 * 副作用：只读文件系统，不创建目录。
 * 失败语义：目录不存在、单文件不可读或个别行非法 JSON 都汇总进 `warning`，不中断读取。
 */
export async function loadLogs(options: ObservationOptions): Promise<SourceLoadResult<LogRecord>> {
  // 先解析成绝对路径，调用方给相对路径也不会随 cwd 漂移。
  // 缺省回落到 ~/.zcode/cli/log，与 CLI 写入侧约定一致。
  // 读取失败不在这里判断，统一交给 readJsonlFiles 转成 warning。
  // 返回结构固定三件套：记录、路径、告警。
  const logDir = resolve(options.logDir ?? defaultLogDir());
  const jsonl = await readJsonlFiles(logDir, "结构化日志");
  return {
    kind: "log",
    label: "结构化日志",
    path: logDir,
    records: jsonl.records.map(toLogRecord).filter((record) => record !== null),
    warning: jsonl.warning,
  };
}

/**
 * 加载 Session 事件 JSONL。
 * 输入：必须显式提供 `options.eventPath`——事件文件位置无法可靠推断，故不做默认路径猜测。
 * 输出：事件记录（带来源文件与行号）；`id` 缺失时按 文件:行号 兜底。
 * 失败语义：未配置或文件/目录不可读时返回空记录 + warning，调用方可继续展示其他源。
 */
export async function loadEventLog(
  options: ObservationOptions,
): Promise<SourceLoadResult<EventRecord>> {
  // 事件文件位置无法推断，缺省就是空态而不是猜路径。
  // 空记录加 warning，让页面其他源照常展示。
  // 这里不抛错，否则一个未配置项会打断整个观测接口。
  if (!options.eventPath) {
    return {
      kind: "eventlog",
      label: "Session 事件 JSONL",
      records: [],
      warning: "未配置 Session 事件 JSONL 路径。",
    };
  }

  const eventPath = resolve(options.eventPath);
  const jsonl = await readJsonlFiles(eventPath, "Session 事件 JSONL");
  return {
    kind: "eventlog",
    label: "Session 事件 JSONL",
    path: eventPath,
    records: jsonl.records.map(toEventRecord).filter((record) => record !== null),
    warning: jsonl.warning,
  };
}

/**
 * 以只读方式加载 SQLite 会话快照（session/message/part 三表）。
 * 输入：`options.dbPath` 优先，缺省用 `defaultDbPath()`；不存在的库按“未配置”降级。
 * 输出：单元素数组形式的三表快照，读取上限固定（200/1000/2000），避免全库拉取。
 * 副作用：只读打开数据库；`finally` 中关闭句柄，避免长期持有 WAL/SHM。
 * 失败语义：打开或查询异常返回空记录 + warning；不会抛出到 HTTP 层。
 */
export function loadSqlite(options: ObservationOptions): SourceLoadResult<DbObservation> {
  const dbPath = resolve(options.dbPath ?? defaultDbPath());
  if (!existsSync(dbPath)) {
    return {
      kind: "sqlite",
      label: "SQLite Session 数据库",
      path: dbPath,
      records: [],
      warning: "未找到 SQLite Session 数据库。",
    };
  }

  // 保存句柄是为了 finally 里无条件关闭，提前 return 也必须走到。
  // 只读打开：调试端绝不能写生产会话库。
  // 三张表各自限流，顺序固定为 session、message、part。
  // 打开或查询异常统一降级为 warning，不向 HTTP 层抛。
  // 关闭放在 finally，避免长期占用 WAL/SHM 阻塞 CLI 写入。
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const observation: DbObservation = {
      sessions: readSessions(db),
      messages: readMessages(db),
      parts: readParts(db),
    };
    return {
      kind: "sqlite",
      label: "SQLite Session 数据库",
      path: dbPath,
      records: [observation],
    };
  } catch (error) {
    return {
      kind: "sqlite",
      label: "SQLite Session 数据库",
      path: dbPath,
      records: [],
      warning: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}

interface JsonlReadResult {
  records: JsonRecord[];
  warning?: string;
}

/**
 * 读取 JSONL 文件或目录。
 * 行为：目录下按文件名排序读取 .jsonl/.log；逐行解析，跳过空行，非对象 JSON 与非法行计入 warning。
 * 输出：记录带原始文件路径与 1 基行号，便于前端回跳定位。
 * 副作用：只读；单文件读取失败不影响其他文件。
 */
async function readJsonlFiles(inputPath: string, label: string): Promise<JsonlReadResult> {
  if (!existsSync(inputPath)) {
    return { records: [], warning: `${label} 路径不存在。` };
  }

  // 目录与单文件两种输入：目录只扫一层，避免递归过深拖慢请求。
  // 只认 .jsonl/.log 并按文件名排序，保证多次读取顺序稳定。
  // 逐行解析：空行跳过，非对象与坏 JSON 只记 warning。
  // 行号是 1 基物理行号，前端据此回跳原始文件。
  // 单文件读失败不中断其余文件，告警最后合并成一条。
  const inputStat = await stat(inputPath);
  const files = inputStat.isDirectory()
    ? (await readdir(inputPath))
        .filter((entry) => entry.endsWith(".jsonl") || entry.endsWith(".log"))
        .sort()
        .map((entry) => join(inputPath, entry))
    : [inputPath];
  const records: JsonRecord[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      const lines = content.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (isRecord(parsed)) {
            records.push({ value: parsed, sourcePath: file, line: index + 1 });
          }
        } catch {
          warnings.push(`${basename(file)}:${index + 1} 不是合法 JSON。`);
        }
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    records,
    warning: warnings.length > 0 ? warnings.join(" ") : undefined,
  };
}

/** 把原始 JSON 行映射为结构化日志记录；既无 message 也无 event 视为非日志行，返回 null 过滤。 */
function toLogRecord(record: JsonRecord): LogRecord | null {
  const value = record.value;
  const message = stringValue(value.message);
  const event = stringValue(value.event);
  if (!message && !event) return null;

  return {
    timestamp: stringValue(value.timestamp),
    level: stringValue(value.level),
    event,
    module: stringValue(value.module),
    message,
    traceId: stringValue(value.traceId),
    sessionId: stringValue(value.sessionId),
    turnId: stringValue(value.turnId),
    spanId: stringValue(value.spanId),
    parentSpanId: stringValue(value.parentSpanId),
    toolCallId: stringValue(value.toolCallId),
    durationMs: numberValue(value.durationMs),
    status: stringValue(value.status),
    context: isRecord(value.context) ? value.context : undefined,
    error: value.error,
    sourcePath: record.sourcePath,
    line: record.line,
  };
}

/** 把原始 JSON 行映射为会话事件；无 type 视为非法事件返回 null。 */
function toEventRecord(record: JsonRecord): EventRecord | null {
  const value = record.value;
  const type = stringValue(value.type);
  if (!type) return null;

  return {
    // 缺少稳定 id 时退化为“来源文件:行号”，保证前端 key 唯一且能回溯原始行。
    id: stringValue(value.id) ?? stringValue(value.eventId) ?? `${record.sourcePath}:${record.line}`,
    type,
    timestamp:
      stringValue(value.timestamp) ?? stringValue(value.occurredAt) ?? stringValue(value.recordedAt),
    traceId: stringValue(value.traceId),
    sessionId: stringValue(value.sessionId),
    turnId: stringValue(value.turnId),
    spanId: stringValue(value.spanId),
    parentSpanId: stringValue(value.parentSpanId),
    sequenceNumber: numberValue(value.sequenceNumber),
    payload: isRecord(value.payload) ? value.payload : undefined,
    sourcePath: record.sourcePath,
    line: record.line,
  };
}

/** 读取会话表（上限 200，按最近更新倒序）；字段名由 snake_case 归一为 camelCase。 */
function readSessions(db: DatabaseSync): DbSessionRecord[] {
  const rows = db
    .prepare(
      `
      select id, project_id, title, directory, time_created, time_updated
      from session
      order by time_updated desc
      limit 200
      `,
    )
    .all() as Record<string, unknown>[];
  // 上限 200 条按最近更新时间倒序，优先展示活跃会话，避免全库读取拖慢调试接口。

  return rows.map((row) => ({
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title ?? ""),
    directory: String(row.directory ?? ""),
    createdAt: millisToIso(row.time_created),
    updatedAt: millisToIso(row.time_updated),
  }));
}

/** 按创建顺序读取消息（上限 1000），保证时间线与会话内顺序一致。 */
function readMessages(db: DatabaseSync): DbMessageRecord[] {
  const rows = db
    .prepare(
      `
      select id, session_id, time_created, time_updated, data
      from message
      order by time_created asc, rowid asc
      limit 1000
      `,
    )
    .all() as Record<string, unknown>[];

  return rows.map((row) => {
    const data = parseData(row.data);
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      role: stringValue(data.role),
      createdAt: millisToIso(row.time_created),
      updatedAt: millisToIso(row.time_updated),
      data,
    };
  });
}

/** 按创建时间读取消息片段（上限 2000），以 id 作为同毫秒内的稳定次序。 */
function readParts(db: DatabaseSync): DbPartRecord[] {
  const rows = db
    .prepare(
      `
      select id, message_id, session_id, time_created, time_updated, data
      from part
      order by time_created asc, id asc
      limit 2000
      `,
    )
    .all() as Record<string, unknown>[];

  return rows.map((row) => {
    const data = parseData(row.data);
    return {
      id: String(row.id),
      messageId: String(row.message_id),
      sessionId: String(row.session_id),
      type: stringValue(data.type),
      createdAt: millisToIso(row.time_created),
      updatedAt: millisToIso(row.time_updated),
      data,
    };
  });
}

/** 解析数据库中的 JSON 文本字段；非字符串或非法 JSON 一律降级为空对象，保证单行坏数据不影响整表展示。 */
function parseData(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 把毫秒时间戳转为 ISO 字符串；非数字返回 undefined，由 UI 决定占位展示。 */
function millisToIso(value: unknown): string | undefined {
  const millis = numberValue(value);
  return millis === undefined ? undefined : new Date(millis).toISOString();
}

/** 类型守卫：仅接受普通对象（排除 null 与数组），用于 JSON 解析结果收窄。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 取非空字符串；空串视为“字段未提供”，与 undefined 语义一致，避免出现空值过滤。 */
export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 取有限数字；NaN/Infinity/非数字统一视为未提供。 */
export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
