import type { LogContext, Logger } from "@zcode/contracts";

// AI SDK 告警重定向：app-server --stdio 的 stdout 是协议 NDJSON 帧通道，
// 任何非帧文本都会破坏宿主解析，因此把 AI SDK 的全局 warning logger 改写到 logger.warn。
// 这里只做格式收敛（截断/字段化），不改写告警内容；安装是进程级一次性副作用。

interface AiSdkWarningLoggerOptions {
  model?: unknown;
  provider?: unknown;
  warnings?: unknown;
}

type AiSdkWarningLogger = (options: AiSdkWarningLoggerOptions) => void;

type AiSdkWarningGlobal = typeof globalThis & {
  AI_SDK_LOG_WARNINGS?: false | AiSdkWarningLogger;
};

/**
 * 安装进程级 AI SDK warning logger（覆盖 globalThis.AI_SDK_LOG_WARNINGS）。
 * 输入是 AI SDK 的 { model, provider, warnings }，输出一条结构化 warn 日志；
 * 内部任何异常都被吞掉，因为告警记录不得改变真实模型请求的成败。
 */
export function installZCodeProtocolAiSdkWarningLogger(logger: Logger): void {
  // AI SDK 默认 warning logger 第一次会用 console.info 写 stdout；
  // app-server --stdio 的 stdout 是 ZCode Protocol NDJSON 帧通道，任何普通文本都会让宿主解析失败。
  (globalThis as AiSdkWarningGlobal).AI_SDK_LOG_WARNINGS = (
    options: AiSdkWarningLoggerOptions,
  ) => {
    try {
      const warnings = Array.isArray(options.warnings) ? options.warnings : [];
      logger.warn("AI SDK model warning", {
        event: "model.sdk.warning",
        module: "bootstrap.zcode_protocol",
        status: "completed",
        model: stringValue(options.model),
        provider: stringValue(options.provider),
        warningCount: warnings.length,
        warnings: warnings.map(summarizeWarning),
      });
    } catch {
      // warning 记录不能影响真实模型请求；stdout 纯净性由不调用 console.* 保证。
    }
  };
}

/** 单条 warning → 定长日志上下文：非对象收敛为 value，对象只挑四个稳定字段，避免日志膨胀。 */
function summarizeWarning(warning: unknown): LogContext {
  if (!warning || typeof warning !== "object") {
    return { value: stringValue(warning) };
  }
  const record = warning as Record<string, unknown>;
  return {
    type: stringValue(record.type),
    feature: stringValue(record.feature),
    message: stringValue(record.message),
    details: stringValue(record.details),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
