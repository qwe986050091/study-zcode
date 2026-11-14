// INV-01 归一化不抛错：守住位置 visit 的所有分支；改错故障 错误处理本身成为新的崩溃源。
// INV-02 防环：守住位置 seen 集合；改错故障 自引用 cause 导致栈溢出。
// INV-03 已确认领域码优先：守住位置 explicitCode 早返回；改错故障 阶段兜底覆盖真实原因。
// INV-04 阶段码不算确认原因：守住位置 phaseCodes 排除；改错故障 外层包装码压掉内层认证失败。
// INV-05 内层更具体者优先：守住位置 递归 visit(child)；改错故障 AggregateError 只报笼统失败。
// INV-06 外层文案仍可用：守住位置 合并时回退 nested.message；改错故障 内层无文案时丢失上下文。
// INV-07 遍历顺序稳定：守住位置 errors → cause → error；改错故障 同一批错误产出不同结果。
// INV-08 系统错误码表：守住位置 systemCodes；改错故障 ECONNRESET 被改写成 preflight 失败。
// INV-09 名称兜底：守住位置 AbortError 判断；改错故障 取消被当未知错误。
// INV-10 文本猜测有优先级：守住位置 逐个 !code 守卫；改错故障 先匹配的宽泛正则吞掉具体原因。
// INV-11 身份变化只认明确文案：守住位置 HOST IDENTIFICATION / host key verification；改错故障 普通握手失败被误报为中间人。
// INV-12 阶段兜底只在顶层：守住位置 visit(error, true)；改错故障 内层 cause 被套上外层阶段码。
// INV-13 文案必然非空：守住位置 || "Remote connection failed"；改错故障 空聚合错误产出空消息。
// INV-14 retryable 原样透传：守住位置 typeof boolean 判断；改错故障 字符串 true 被当可重试。
//
// 模块职责：把远端连接阶段的异构错误收敛成可展示、可判定的公开错误码。
// 阅读顺序：先看两张码表，再看 visit 的确认码与递归，最后看文本猜测的优先级。
import { sanitizeRemoteConnectionLog } from "./connectionLog.js";
import { isPublicZCodeErrorCode, type PublicZCodeErrorCode } from "./errorCodes.js";

export interface RemoteConnectionFailure {
  code: PublicZCodeErrorCode;
  message: string;
  retryable?: boolean;
}

// 系统错误码是最高置信度的映射。
const systemCodes: Record<string, PublicZCodeErrorCode> = {
  ECONNREFUSED: "remote-host-unreachable",
  EHOSTUNREACH: "remote-host-unreachable",
  ENETUNREACH: "remote-host-unreachable",
  // Bug 原因：在线断连后的自动恢复经懒连接 probe 抛出 ECONNRESET；码表缺它时被
  // probe 的阶段兜底改写成 remote-preflight-failed，UI 误报“设备环境不满足安装要求”。
  ECONNRESET: "remote-host-unreachable",
  ETIMEDOUT: "remote-connection-timeout",
  ENOTFOUND: "remote-host-not-found",
  EAI_AGAIN: "remote-host-not-found",
  ENOSPC: "remote-space-insufficient",
  EACCES: "remote-permission-denied",
  EPERM: "remote-permission-denied",
  ABORT_ERR: "remote-connection-canceled",
  ERR_SSH_HOST_KEY_MISMATCH: "remote-host-key-changed",
};
// phaseCodes 只作顶层兜底，不能当作已确认的阶段事实。
const phaseCodes: Record<string, PublicZCodeErrorCode> = {
  download: "remote-download-failed",
  upload: "remote-upload-failed",
  preflight: "remote-preflight-failed",
  extract: "remote-install-failed",
  "verify-archive": "remote-install-failed",
  verify: "remote-install-failed",
  restart: "remote-install-failed",
  install: "remote-install-failed",
};

/** 空 AggregateError 曾生成空响应，被 Main schema 丢弃后 UI 永久等待。 */
// 对外的唯一归一化入口。
export function normalizeRemoteConnectionError(
  error: unknown,
  phase?: string,
): RemoteConnectionFailure {
  const seen = new Set<unknown>();
  // visit 递归遍历 cause 链，applyPhaseFallback 只有顶层调用才置 true。
  function visit(value: unknown, applyPhaseFallback = false): RemoteConnectionFailure {
    // 重复引用直接返回未知，防环。
    if (seen.has(value))
      return { code: "remote-connection-unknown", message: "Remote connection failed" };
    seen.add(value);
    const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const message =
      typeof record.message === "string"
        ? record.message.trim()
        : typeof value === "string"
          ? value.trim()
          : "";
    const rawCode = typeof record.code === "string" ? record.code : "";
    // 只有公开码表中存在的才算确认。
    const explicitCode = isPublicZCodeErrorCode(rawCode) ? rawCode : undefined;
    // 适配器已确认的领域原因优先于 cause 的文本猜测；阶段包装仍继续寻找更具体的内层原因。
    if (
      explicitCode &&
      explicitCode !== "remote-connection-unknown" &&
      !Object.values(phaseCodes).includes(explicitCode)
    ) {
      return {
        code: explicitCode,
        message: sanitizeRemoteConnectionLog(message) || "Remote connection failed",
        ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
      };
    }
    // 按 errors、cause、error 顺序下钻。
    for (const child of [
      ...(Array.isArray(record.errors) ? record.errors : []),
      record.cause,
      record.error,
    ]) {
      if (child === undefined) continue;
      const nested = visit(child);
      // 内层有结论就用内层，外层补文案。
      if (nested.code !== "remote-connection-unknown")
        return { ...nested, message: sanitizeRemoteConnectionLog(message) || nested.message };
    }
    // 先查表，再进入文本猜测。
    let code = explicitCode ?? systemCodes[rawCode];
    // 取消以 record.name === "AbortError" 为准，不看 message 文案。
    if (!code && record.name === "AbortError") code = "remote-connection-canceled";
    if (
      !code &&
      /all configured authentication methods failed|authentication failed|SSH\s*认证失败/iu.test(
        message,
      )
    )
      // 认证失败按双语文案识别。
      code = "remote-authentication-failed";
    if (
      !code &&
      /\b(?:ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET)\b|connection refused|no route to host/i.test(
        message,
      )
    )
      code = "remote-host-unreachable";
    if (!code && /\bETIMEDOUT\b|timed? out|timeout/i.test(message))
      code = "remote-connection-timeout";
    if (!code && /\b(?:ENOTFOUND|EAI_AGAIN)\b|could not resolve hostname/i.test(message))
      code = "remote-host-not-found";
    if (!code && /no space left on device|\bENOSPC\b/i.test(message))
      code = "remote-space-insufficient";
    if (!code && /permission denied|read-only file system/i.test(message))
      code = "remote-permission-denied";
    // 仅接受 SSH 明确的密钥校验失败，不从普通 handshake/authentication 失败猜测身份变化。
    if (
      !code &&
      /REMOTE HOST IDENTIFICATION HAS CHANGED|host key verification failed/i.test(message)
    )
      // 只认明确的 host key 变更文案。
      code = "remote-host-key-changed";
    return {
      code:
        code ??
        (message && applyPhaseFallback && phase ? phaseCodes[phase] : undefined) ??
        "remote-connection-unknown",
      message: sanitizeRemoteConnectionLog(message) || "Remote connection failed",
      ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
    };
  }
  // 未识别的内层 cause 不是阶段失败事实，不能提前覆盖外层已确认的认证等领域码。
  // visit(error, true) 仅在最外层允许阶段码兜底，内层必须保持 false。
  return visit(error, true);
}
