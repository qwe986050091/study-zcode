import { formatLogPrefix, type TraceId } from "@zcode/shared";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";

// 本模块提供与具体 runtime 解耦的分级日志入口：调用方只关心 scope 与 traceId，
// 不依赖 ZCode Agent 的 logger 实现，也不再需要知道日志前缀如何拼接。
// sink 允许注入，便于测试断言输出或把日志转发到其他通道。
interface ServiceLogSink {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

// 对外契约：四个等级方法签名一致，traceId 为空表示该日志不属于任何请求链路。
// 统一成 (traceId, ...args) 形态，是为了让调用点保持稳定、避免业务代码分支处理。
export interface ServiceLogger {
  debug: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  info: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  warn: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  error: (traceId: TraceId | undefined, ...args: unknown[]) => void;
}

export function createServiceLogger(
  scope: string,
  options?: {
    pid?: number;
    sink?: ServiceLogSink;
    // debug 日志默认只在本地开发运行时打印；测试/正式安装包都使用 production 构建，避免高频日志落盘。
    isDebugEnabled?: boolean | (() => boolean);
  },
): ServiceLogger {
// pid 默认取当前进程，前缀中带上它便于区分 Desktop 主进程与各 Host/CLI 子进程的日志。
// sink 默认为 console，测试可替换为内存收集器以断言等级与内容。
  const pid = options?.pid ?? process.pid;
  const sink = options?.sink ?? console;
  const debugOption = options?.isDebugEnabled;
// debug 开关支持布尔值或惰性函数：函数形式用于跟随运行期配置变化（如测试中途切换环境），
// 布尔值用于调用方显式锁定，未提供时回退到统一的开发环境判据。
// 统一走 isEffectiveDevelopmentNodeEnv，避免各处自行读取 shell 的 NODE_ENV 导致判据分裂。
  const resolveDebugEnabled: () => boolean =
    typeof debugOption === "function"
      ? debugOption
      : typeof debugOption === "boolean"
        ? () => debugOption
        : () => isEffectiveDevelopmentNodeEnv();

// 所有等级最终汇聚到这里，保证前缀格式、debug 过滤和 sink 选择只有一份实现。
// 级别路由向下兼容：sink 未实现 debug 时降级到 log，避免老 sink 丢失 debug 输出。
  function write(
    level: "debug" | "info" | "warn" | "error",
    traceId: TraceId | undefined,
    ...args: unknown[]
  ): void {
    // 服务层日志过去常被复用到 ZCode Agent 命名 logger，导致新 ZCode 路径继续依赖 ZCode Agent 目录。
    // 这里把通用分级日志抽到独立模块，后续删除 ZCode Agent runtime 时不会牵连非 ZCode Agent 服务。
    if (level === "debug" && !resolveDebugEnabled()) {
      return;
    }
    const source = traceId ? `${scope}][trace:${traceId}` : scope;
    const consoleFn =
      level === "error"
        ? sink.error
        : level === "warn"
          ? sink.warn
          : level === "debug"
            ? (sink.debug ?? sink.log)
            : sink.log;
    consoleFn(formatLogPrefix(source, pid), ...args);
  }

// 返回的对象按等级预绑定，调用方拿到稳定引用，可安全放进模块级常量复用。
// 各方法不缓存 traceId，逐次透传，保证同一 logger 能被不同请求链路并发使用。
// info 与 debug 共用 sink.log，仅靠前缀与启用判据区分，便于日志按单流采集。
  return {
    debug: (traceId, ...args) => write("debug", traceId, ...args),
    info: (traceId, ...args) => write("info", traceId, ...args),
    warn: (traceId, ...args) => write("warn", traceId, ...args),
    error: (traceId, ...args) => write("error", traceId, ...args),
  };
}
