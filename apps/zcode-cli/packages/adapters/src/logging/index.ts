// ============================================================
// Node logging adapter - JSONL file and optional stderr sink
// ============================================================
/**
 * ============================================================================
 * logging/index.ts —— JSONL 文件日志适配器
 * ============================================================================
 *
 * 【定位】Logger 契约的 Node 实现：每条日志序列化为一行 JSON 追加写入
 * `<logDir>/zcode-YYYY-MM-DD.jsonl`，可选同时输出到 stderr（人读格式）。
 *
 * 【副作用】appendFileSync 同步写文件（日志不能因为异步排队而在崩溃时丢失）；
 * consoleStream 存在时写 stderr。日志目录懒创建。
 *
 * 【失败语义】文件写入/建目录的任何异常都被吞掉——日志失败绝不能中断
 * Agent 执行（唯一的有意吞错点）。序列化前的敏感字段由 LogRedactor 脱敏。
 *
 * 【不变量】level 低于当前阈值时不落盘；child() 只合并默认 context，不改变
 * 级别/目录/redactor；保留字段（traceId/sessionId/...）不会重复进入 context。
 * ============================================================================
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LogContext, LogEntry, Logger, LoggerFactory, LogRedactor } from "@zcode/contracts";
import { LogLevel, LogLevelName } from "@zcode/contracts";
import { ZCODE_RUNTIME_ENV_KEY, normalizeZCodeRuntimeEnv } from "@zcode/shared";
import {
  formatLocalLogDate,
  scheduleLogRetentionCleanup as scheduleRetentionCleanup,
  type LogRetentionScheduleOptions,
  type LogRetentionTimer,
} from "./retention.js";
import {
  DefaultLogRedactor,
  formatConsoleLine,
  isLogStatus,
  serializeLogError,
  stripReservedContext,
  toSerializableEntry,
} from "./serialize.js";
import { maybeThrowStorageFsFault } from "../storage/fs-fault-injection.js";

export {
  LOG_CLEANUP_STARTUP_DELAY_MS,
  LOG_RETENTION_DAYS,
  cleanupLogRetention,
  formatLocalLogDate,
  scheduleLogRetentionCleanup,
} from "./retention.js";
export type {
  LogRetentionCleanupOptions,
  LogRetentionCleanupResult,
  LogRetentionScheduleOptions,
  LogRetentionTimer,
} from "./retention.js";
export { DefaultLogRedactor } from "./serialize.js";
export type { SerializableLogEntry, SerializedLogError } from "./serialize.js";

export interface NodeLoggerFactoryOptions {
  env?: NodeJS.ProcessEnv;
  logDir?: string;
  minLevel?: LogLevel;
  console?: boolean | { stream: NodeJS.WritableStream };
  includeErrorStack?: boolean;
  redactor?: LogRedactor;
}

export type NodeLogRetentionScheduleOptions = Pick<
  LogRetentionScheduleOptions,
  "delayMs" | "logger" | "now" | "retentionDays" | "setTimeout"
>;

export interface NodeLoggerFactory extends LoggerFactory {
  getLogDir(): string;
  scheduleLogRetentionCleanup(
    options?: NodeLogRetentionScheduleOptions,
  ): LogRetentionTimer | undefined;
}

/**
 * 文件日志器：一个实例绑定 category、默认 context 与日志目录。
 *
 * 级别阈值通过 getMinLevel 回调读取，因此工厂 setLevel 后已创建的 logger
 * 也会立即生效。所有写方法共享同一条 log() 管线：阈值过滤 → 合并 context →
 * 组装 LogEntry → 脱敏序列化 → 追加文件 → 可选 stderr。
 */
export class NodeFileLogger implements Logger {
  private readonly category: string;
  private readonly defaultContext: LogContext;
  private readonly getMinLevel: () => LogLevel;
  private readonly logDir: string;
  private readonly consoleStream?: NodeJS.WritableStream;
  private readonly includeErrorStack: boolean;
  private readonly redactor: LogRedactor;

  constructor(options: {
    category: string;
    defaultContext?: LogContext;
    getMinLevel: () => LogLevel;
    logDir: string;
    consoleStream?: NodeJS.WritableStream;
    includeErrorStack?: boolean;
    redactor: LogRedactor;
  }) {
    this.category = options.category;
    this.defaultContext = options.defaultContext ?? {};
    this.getMinLevel = options.getMinLevel;
    this.logDir = options.logDir;
    this.consoleStream = options.consoleStream;
    this.includeErrorStack = options.includeErrorStack ?? false;
    this.redactor = options.redactor;
  }

  /** 细节级日志；仅在开发模式或显式降低阈值时落盘。 */
  debug(message: string, context?: LogContext): void {
    this.log(LogLevel.Debug, message, undefined, context);
  }

  /** 生产默认可用的生命周期/权限/初始化事件。 */
  info(message: string, context?: LogContext): void {
    this.log(LogLevel.Info, message, undefined, context);
  }

  /** 可恢复异常；调用方已决定继续执行。 */
  warn(message: string, context?: LogContext): void {
    this.log(LogLevel.Warn, message, undefined, context);
  }

  /** 不可恢复错误；error 会被序列化（含 cause 链，stack 由选项控制）。 */
  error(message: string, error?: Error, context?: LogContext): void {
    this.log(LogLevel.Error, message, error, context);
  }

  /**
   * 派生子 logger：把传入 context 叠加到默认 context 上。
   *
   * 浅合并，后写覆盖先写；category/级别/目录/redactor 原样继承，不产生独立副本。
   */
  child(context: LogContext): Logger {
    return new NodeFileLogger({
      category: this.category,
      defaultContext: { ...this.defaultContext, ...context },
      getMinLevel: this.getMinLevel,
      logDir: this.logDir,
      consoleStream: this.consoleStream,
      includeErrorStack: this.includeErrorStack,
      redactor: this.redactor,
    });
  }

  /**
   * 统一写日志管线（所有级别的唯一落盘点）。
   *
   * 先做级别过滤；再合并默认/调用方 context 并组装 LogEntry；序列化时由
   * redactor 脱敏。文件写入失败只吞掉，不影响调用方；stderr 输出独立于文件
   * 写入是否成功。
   */
  private log(level: LogLevel, message: string, error?: Error, context?: LogContext): void {
    if (level < this.getMinLevel()) {
      return;
    }

    const mergedContext = { ...this.defaultContext, ...context };
    const entry = this.createEntry(level, message, mergedContext, error);
    const serialized = toSerializableEntry(entry, this.redactor);
    const line = JSON.stringify(serialized);

    try {
      ensureLogDir(this.logDir);
      const logPath = join(this.logDir, getLogFileName());
      maybeThrowStorageFsFault({ operation: "appendFile", path: logPath });
      appendFileSync(logPath, `${line}\n`, "utf8");
    } catch {
      // 日志是旁路能力：磁盘满/权限错/路径异常都不能把异常抛回 Agent 主链路。
      // Logging must never break the agent execution path.
    }

    if (this.consoleStream) {
      this.consoleStream.write(`${formatConsoleLine(entry)}\n`);
    }
  }

  /**
   * 把 LogContext 拆成结构化字段 + 自由 context。
   *
   * 只有类型正确的保留字段才会进入 LogEntry；其余键统一放进 context，
   * 由 stripReservedContext 剔除同名保留键，避免同一信息出现两份。
   */
  private createEntry(
    level: LogLevel,
    message: string,
    context: LogContext,
    error?: Error,
  ): LogEntry {
    return {
      timestamp: new Date(),
      level,
      levelName: LogLevelName[level],
      event: typeof context.event === "string" ? context.event : undefined,
      module: typeof context.module === "string" ? context.module : this.category,
      message,
      traceId: context.traceId,
      sessionId: typeof context.sessionId === "string" ? context.sessionId : undefined,
      turnId: typeof context.turnId === "string" ? context.turnId : undefined,
      spanId: typeof context.spanId === "string" ? context.spanId : undefined,
      parentSpanId: typeof context.parentSpanId === "string" ? context.parentSpanId : undefined,
      toolCallId: typeof context.toolCallId === "string" ? context.toolCallId : undefined,
      durationMs: typeof context.durationMs === "number" ? context.durationMs : undefined,
      status: isLogStatus(context.status) ? context.status : undefined,
      context: stripReservedContext(context),
      error: error ? serializeLogError(error, this.includeErrorStack) : undefined,
    };
  }
}

/**
 * 创建 logger 工厂（全局共享级别、目录、console 通道与 redactor）。
 *
 * 级别默认：开发模式 Debug，其余 Info；logDir 优先级：
 * options.logDir > ZCODE_LOG_DIR > ~/.zcode/cli/log。
 * console 为 true 或 ZCODE_LOG_CONSOLE=1 时输出到 stderr。
 * 保留清理任务用 scheduled 标记做进程内 single-flight，避免重复定时器。
 */
export function createNodeLoggerFactory(options: NodeLoggerFactoryOptions = {}): NodeLoggerFactory {
  let currentLevel = options.minLevel ?? getDefaultMinLevel(options.env);
  let retentionCleanupScheduled = false;
  const logDir = options.logDir ?? options.env?.ZCODE_LOG_DIR ?? getDefaultLogDir();
  const consoleStream =
    typeof options.console === "object"
      ? options.console.stream
      : options.console === true || options.env?.ZCODE_LOG_CONSOLE === "1"
        ? process.stderr
        : undefined;
  const redactor = options.redactor ?? new DefaultLogRedactor();

  const create = (category: string, defaultContext: LogContext = {}) =>
    new NodeFileLogger({
      category,
      defaultContext,
      getMinLevel: () => currentLevel,
      logDir,
      consoleStream,
      includeErrorStack: options.includeErrorStack,
      redactor,
    });

  return {
    createLogger(category: string): Logger {
      return create(category);
    },
    withContext(context: LogContext): Logger {
      return create("root", context);
    },
    setLevel(level: LogLevel): void {
      currentLevel = level;
    },
    getLogDir(): string {
      return logDir;
    },
    scheduleLogRetentionCleanup(scheduleOptions = {}): LogRetentionTimer | undefined {
      // 进程内只允许一个清理定时器；重复调用返回 undefined（幂等，不叠加定时器）。
      if (retentionCleanupScheduled) return undefined;
      retentionCleanupScheduled = true;
      return scheduleRetentionCleanup({
        ...scheduleOptions,
        logDir,
        logger:
          scheduleOptions.logger ??
          create("zcode", {
            module: "adapters.logging",
          }),
      });
    },
  };
}

/** 默认日志目录：`~/.zcode/cli/log`（跨平台由 homedir 解析）。 */
export function getDefaultLogDir(): string {
  return join(homedir(), ".zcode", "cli", "log");
}

function getDefaultMinLevel(env: NodeJS.ProcessEnv | undefined): LogLevel {
  return isDevelopmentMode(env ?? process.env) ? LogLevel.Debug : LogLevel.Info;
}

function isDevelopmentMode(env: NodeJS.ProcessEnv): boolean {
  const runtimeEnv = normalizeZCodeRuntimeEnv(env[ZCODE_RUNTIME_ENV_KEY]);
  if (runtimeEnv === "development") return true;
  // 显式 production/test 优先于进程参数推断，避免打包环境被误判为开发。
  if (runtimeEnv === "production" || runtimeEnv === "test") return false;

  // The local dev script runs `tsx src/main.ts`; packaged CLI entrypoints run from dist.
  const entrypoint = process.argv[1] ?? "";
  return entrypoint.endsWith(".ts") && entrypoint.includes(`${join("packages", "cli", "src")}`);
}

function ensureLogDir(logDir: string): void {
  if (!existsSync(logDir)) {
    maybeThrowStorageFsFault({ operation: "mkdir", path: logDir });
    mkdirSync(logDir, { recursive: true });
  }
}

function getLogFileName(): string {
  return `zcode-${formatLocalLogDate(new Date())}.jsonl`;
}
