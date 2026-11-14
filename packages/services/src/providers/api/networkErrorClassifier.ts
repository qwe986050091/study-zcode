// feedback 与模型连通性曾分别维护错误码列表，导致 Undici 建连超时只在部分链路被识别。
// 统一沿 cause/AggregateError 链归一化错误，避免调用方再次因运行时包装层级不同而漏判。
// 判定「网络失败」的错误码集合：只收连接层与解析层可确定的失败，不放宽到所有 IO 错误，
// 避免把业务 4xx 或本地参数错误误报为网络问题。
const NETWORK_FAILURE_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_CONNECT_ERROR",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNREFUSED",
  "ECONNRESET",
]);

// 可安全重试的子集：仅限建连阶段失败；请求体已发出后的中断不在其中，
// 因为此时服务端可能已产生副作用。
const RETRYABLE_CONNECTION_ESTABLISHMENT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_CONNECT_ERROR",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNREFUSED",
]);

// 归一化中间态：同一错误链上的多个 code 与 message 全部收集，供上层分别按码或按文案判断。
interface NetworkErrorDetails {
  codes: Set<string>;
  messages: string[];
}

// 导出诊断用错误码：排序后返回，保证日志与快照在相同错误链上稳定可比；
// 调用方只需展示，不应基于该顺序做逻辑判断。
export function getNetworkErrorCodes(error: unknown): string[] {
  return [...collectNetworkErrorDetails(error).codes].sort();
}

// 只要错误链上任一节点命中已知网络码即视为网络失败；
// 这里不区分阶段，用于决定是否展示「网络异常」而不是抛原始错误。
export function isNetworkFailure(error: unknown): boolean {
  const { codes } = collectNetworkErrorDetails(error);
  return [...codes].some((code) => NETWORK_FAILURE_CODES.has(code));
}

// 重试判定比网络失败更严格：先看建连阶段的明确错误码，
// 再对 ETIMEDOUT / ECONNRESET 要求错误文案提供建连证据。
export function isRetryableConnectionEstablishmentError(error: unknown): boolean {
  const { codes, messages } = collectNetworkErrorDetails(error);
// 命中白名单即可直接重试，无需再解析文案。
  if ([...codes].some((code) => RETRYABLE_CONNECTION_ESTABLISHMENT_CODES.has(code))) {
    return true;
  }
  // ETIMEDOUT 也可能发生在 POST 请求体已经发出后，不能只凭错误码重试创建工单。
  // Node 的建连超时会明确包含 connection attempts/connect ETIMEDOUT，只有该证据存在时才安全重试。
  if (
    codes.has("ETIMEDOUT") &&
    messages.some((message) => /connection attempts timed out|connect ETIMEDOUT/i.test(message))
  ) {
    return true;
  }
  return (
    codes.has("ECONNRESET") &&
    messages.some((message) => /before secure TLS connection was established/i.test(message))
  );
}

// 沿 cause 与 AggregateError.errors 展开整条错误链：Undici 与 Node 的包装层级不同，
// 只看顶层 code 会漏判，因此统一收敛为 codes 与 messages 两个集合。
function collectNetworkErrorDetails(error: unknown): NetworkErrorDetails {
  const details: NetworkErrorDetails = { codes: new Set(), messages: [] };
  const seen = new Set<object>();
  const pending: unknown[] = [error];

// 显式栈遍历替代递归，避免深层嵌套错误链导致调用栈溢出。
  while (pending.length > 0) {
    const current = pending.pop();
// 跳过空值、非对象节点与已访问节点，错误链中可能存在环或重复引用。
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const record = current as {
      cause?: unknown;
      code?: unknown;
      errors?: unknown;
      message?: unknown;
    };
// 只接受字符串 code；数字 errno 语义不一致，宁可不判定也不误判。
    if (typeof record.code === "string") {
      details.codes.add(record.code);
    }
// 保留原始文案供后续正则证据匹配，不做归一化改写。
    if (typeof record.message === "string") {
      details.messages.push(record.message);
    }
// fetch/Undici 常把底层 socket 错误挂在 cause 上，必须继续下钻。
    if (record.cause !== undefined) {
      pending.push(record.cause);
    }
// AggregateError 表示多路并发建连的多个失败，全部纳入才能覆盖所有分支。
    if (Array.isArray(record.errors)) {
      pending.push(...record.errors);
    }
  }

  return details;
}
