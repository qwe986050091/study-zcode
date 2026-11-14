// 启动阶段计时与结构化日志。
//
// 时间基准用 performance.now()（单调时钟，不受系统时间跳变影响），所有 duration 为非负整数毫秒。
// 每个事件都带 event/stage/status/totalDurationMs，便于按 startupKind 聚合各阶段耗时。
// 计时器只写日志，不持有任何资源；失败路径也必须能记录（fail 不应因 logger 异常改变启动结果）。
import { performance } from "node:perf_hooks";
import type { LogContext, Logger, LoggerFactory, LogLevel } from "@zcode/contracts";

// 计时日志的可选字段：context 为调用方补充字段（如 version），event/stage 用于聚合。
interface StartupTimerLogOptions {
  context?: LogContext;
  event: string;
  stage: string;
}

/**
 * 启动计时器：start 打起点，mark 记录自上一次 mark 的增量，complete 记录总耗时。
 *
 * - lastMarkAt 独立于 startedAt：mark 的 durationMs 是「距上次 mark」的分段耗时；
 * - 所有方法都不抛错、不等待，仅写日志；
 * - totalDurationMs 始终是「距 startedAt」的累计值，两种语义都可直接消费。
 */
export class StartupTimer {
  private lastMarkAt: number;

  constructor(
    private readonly logger: Logger,
    private readonly baseContext: LogContext,
    private readonly startedAt: number = startupNow(),
  ) {
    this.lastMarkAt = startedAt;
  }

  // 起点事件：durationMs 固定 0，status=started；只更新日志，不改 lastMarkAt。
  start(message: string, options: StartupTimerLogOptions): void {
    const now = startupNow();
    this.logger.info(message, this.createContext(options, now, 0, "started"));
  }

  // 分段标记：durationMs=距上次 mark/start，随后把 lastMarkAt 前移。
  mark(message: string, options: StartupTimerLogOptions): void {
    const now = startupNow();
    const durationMs = elapsedMs(this.lastMarkAt, now);
    this.lastMarkAt = now;
    this.logger.info(message, this.createContext(options, now, durationMs, "completed"));
  }

  // 完成：durationMs 与 totalDurationMs 都等于距 startedAt 的总耗时（stage=total 时使用）。
  complete(message: string, options: StartupTimerLogOptions): void {
    const now = startupNow();
    this.logger.info(
      message,
      this.createContext(options, now, elapsedMs(this.startedAt, now), "completed"),
    );
  }

  // 失败：error 归一为 Error 后作为日志错误对象，status=failed，仍记录总耗时。
  fail(message: string, error: unknown, options: StartupTimerLogOptions): void {
    const now = startupNow();
    this.logger.error(
      message,
      toError(error),
      this.createContext(options, now, elapsedMs(this.startedAt, now), "failed"),
    );
  }

  // 统一上下文：baseContext 先展开，允许调用方 context 覆盖少量字段；
  // 再写入计时与服务字段，确保 event/stage/status 不被外部覆盖。
  private createContext(
    options: StartupTimerLogOptions,
    now: number,
    durationMs: number,
    status: NonNullable<LogContext["status"]>,
  ): LogContext {
    return {
      ...this.baseContext,
      ...options.context,
      durationMs,
      event: options.event,
      stage: options.stage,
      status,
      totalDurationMs: elapsedMs(this.startedAt, now),
    };
  }
}

// 单调时钟：跨平台毫秒精度足够，且不受系统时间调整影响。
export function startupNow(): number {
  return performance.now();
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

function elapsedMs(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.round(endedAt - startedAt));
}
