// WebFetch 的错误工厂：把内部分支翻译成带稳定错误码的 CoreError。
//
// 稳定错误码（webFetchCode）是遥测归因与用户提示的唯一依据，调用方不得靠 message 文本
// 分支；message 面向模型/用户，code 面向统计。所有错误统一归到
// CoreErrorType.ToolExecutionFailed，因为对 executor 来说它们都发生在 handler 内部，
// 区别只体现在可重试性和上下文里。context 中的 url/hostname 等字段会进入错误对象，
// 调用方须保证已剔除 URL 内嵌凭据。
import { CoreErrorType, createCoreError } from "@zcode/contracts";
import { WEBFETCH_TOOL_NAME } from "./webfetch-constants.js";

type WebFetchErrorCode = keyof typeof WEBFETCH_ERROR_CODE_MAP;

/**
 * 构造 WebFetch 的统一错误。
 *
 * 输入：code 取自下方映射表；message 是可展示文案；context 会浅合并进错误上下文，
 * 但 webFetchCode 与 toolName 由本函数最后写入，调用方同名键会被覆盖。
 *
 * 语义：所有错误 recoverable=true（工具失败不会让 turn 直接崩），但 retryable 只有
 * FetchFailed / ProcessingFailed——其余（URL 非法、协议不支持、egress 阻断、重定向越界、
 * 响应过大）重试也是同样结果，标成可重试只会诱发无意义的重复出网。
 *
 * 降级取舍：cause 只在确实是 Error 实例时保留（字符串/对象形态的底层原因会丢失，
 * 避免非错误值进入错误链）。下方映射表声明在使用点之后是安全的，因为函数体延迟执行，
 * 调用时模块初始化已完成；但不要把映射表内联进函数，否则每次构造都会重建对象。
 */
export function webFetchError(
  code: WebFetchErrorCode,
  message: string,
  context: Record<string, unknown> = {},
  cause?: unknown,
): Error {
  return createCoreError(CoreErrorType.ToolExecutionFailed, message, {
    cause: cause instanceof Error ? cause : undefined,
    context: {
      ...context,
      webFetchCode: WEBFETCH_ERROR_CODE_MAP[code],
      toolName: WEBFETCH_TOOL_NAME,
    },
    recoverable: true,
    retryable: code === "FetchFailed" || code === "ProcessingFailed",
  });
}

/**
 * 错误码 → 对外 snake_case 标识。这些字符串已进入遥测与日志，属于稳定契约：
 * 只能新增，不能改名或复用；`InvalidUrl` 与 `UnsupportedProtocol` 等语义不同，
 * 合并会让「URL 过长/协议不支持/含凭据」在统计里不可区分。
 */
const WEBFETCH_ERROR_CODE_MAP = {
  InvalidUrl: "webfetch_invalid_url",
  UnsupportedProtocol: "webfetch_unsupported_protocol",
  CredentialsInUrl: "webfetch_credentials_in_url",
  MissingRedirectLocation: "webfetch_missing_redirect_location",
  UnsafeRedirect: "webfetch_unsafe_redirect",
  EgressBlocked: "webfetch_egress_blocked",
  TooManyRedirects: "webfetch_too_many_redirects",
  ResponseTooLarge: "webfetch_response_too_large",
  FetchFailed: "webfetch_fetch_failed",
  ProcessingFailed: "webfetch_processing_failed",
} as const;
