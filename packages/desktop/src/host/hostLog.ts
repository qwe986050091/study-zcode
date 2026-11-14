// Host 日志参数序列化与过滤。
//
// 职责：把任意 console 参数转成可中继给 main 的字符串（Error 展开为 name/message/stack/cause），
// 并过滤掉 Node 自身的 ExperimentalWarning / DeprecationWarning / Warning 行，避免噪音。
// 输入输出：shouldReportHostConsoleError 输入参数数组，输出是否应上报；stringifyHostLogArg
// 输入单值，输出字符串（永不抛错）。
// 副作用：无（纯转换）。
// 失败语义：JSON.stringify 失败时回退到 String / 手工拼接；循环引用不会抛出。
// 维护的不变量：Error 的 cause 必须递归序列化——直接 stringify Error 会得到 {}，导致
// 远端握手失败在日志里只剩空对象，丢失真实错误链路。

const NODE_WARNING_LOG_PATTERN =
  /^\(node:\d+\)\s+(?:ExperimentalWarning|DeprecationWarning|Warning):/u;

// 判断一条 console.error 是否值得中继到 main。
// Node 启动期警告（如 ExperimentalWarning）不是 Host 业务错误，混入会淹没真实告警。
// 先把参数拼成一行再匹配前缀，兼容 warn 被打印成多参数的情况。
export function shouldReportHostConsoleError(args: unknown[]): boolean {
  const message = args
    .map((arg) => stringifyHostLogArg(arg))
    .join(" ")
    .trimStart();
  return !NODE_WARNING_LOG_PATTERN.test(message);
}

// 把单个日志参数转为字符串；保证不抛出（日志路径不能因序列化失败而中断）。
// 字符串原样返回；Error 走结构化序列化；其他值先尝试 JSON，失败回落 String。
export function stringifyHostLogArg(arg: unknown): string {
  if (typeof arg === "string") {
    return arg;
  }

  if (arg instanceof Error) {
    try {
      return JSON.stringify(serializeErrorForHostLog(arg));
    } catch {
      return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ""}`;
    }
  }

  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

// 结构化序列化 Error：只保留 name / message / stack / cause 四个字段。
// 递归处理 cause（cause 可能是 Error 链），非 Error 的 cause 原样保留。
// stack 不存在时不写入该键，保持输出形态稳定（避免出现 stack: undefined）。
function serializeErrorForHostLog(error: Error): {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
} {
  const serialized: {
    name: string;
    message: string;
    stack?: string;
    cause?: unknown;
  } = {
    name: error.name,
    message: error.message,
  };
  if (error.stack) {
    serialized.stack = error.stack;
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause !== undefined) {
    // Error 被 JSON.stringify 时会变成 {}，导致远端握手失败只剩空对象。
    // cause 也可能是 Error，这里递归压成普通对象，保证 host 日志中继能保留真实错误链路。
    serialized.cause = cause instanceof Error ? serializeErrorForHostLog(cause) : cause;
  }
  return serialized;
}
