// 启动期日志保留清理的接线。
//
// 清理逻辑属于 adapters/logging；Bootstrap 只做能力探测后调度一次（fire-and-forget），
// 不在启动关键路径等待结果。工厂不提供该能力（精简注入/测试替身）时静默跳过，绝不报错，
// 因为日志清理失败不应影响进程启动。
import type { Logger, LoggerFactory } from "@zcode/contracts";

// 只检测能力、不调用具体实现：返回类型守卫，让调用点在 TS 层可安全访问该扩展方法。
interface RetentionAwareLoggerFactory extends LoggerFactory {
  scheduleLogRetentionCleanup(options?: { logger?: Logger }): unknown;
}

// 调度后不 await：返回值只用于确认已受理，清理异步执行；logger 派生子 logger 便于过滤。
export function scheduleStartupLogRetentionCleanup(
  loggerFactory: LoggerFactory,
  logger: Logger,
): void {
  if (!hasRetentionScheduler(loggerFactory)) return;

  loggerFactory.scheduleLogRetentionCleanup({
    logger: logger.child({
      module: "adapters.logging",
    }),
  });
}

// 双重检查（存在性 + 函数类型），防止把同名非函数属性误当成可调用能力。
function hasRetentionScheduler(
  loggerFactory: LoggerFactory,
): loggerFactory is RetentionAwareLoggerFactory {
  return (
    "scheduleLogRetentionCleanup" in loggerFactory &&
    typeof loggerFactory.scheduleLogRetentionCleanup === "function"
  );
}
