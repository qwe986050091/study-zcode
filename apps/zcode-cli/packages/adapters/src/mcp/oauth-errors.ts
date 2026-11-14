/* ============================================================
 * MCP OAuth 错误品牌与分类（adapters/src/mcp/oauth-errors.ts）
 *
 * 定位：Phase 1 刷新链路与上层编排之间唯一的“认证失败类型”契约。
 * 两条互斥语义：interactiveRequired（必须重新走交互授权）与 temporaryRefreshFailure
 * （AS 暂时故障，保留凭据、原样失败、不得打断用户）。
 * 输入：错误原因枚举、serverName、可选 cause / requiredScope / resourceMetadataUrl。
 * 输出：带 `Symbol.for` 品牌与稳定 error.code 的 Error；分类函数返回 trigger 或 undefined。
 * 副作用：无 IO；品牌通过 Object.defineProperty 挂在实例上。
 * 失败语义：本模块只构造与分类，不吞错；未知错误分类为 undefined 交给调用方继续冒泡。
 * 不变量：品牌使用全局 symbol registry，跨 bundler 双装/版本偏斜时仍能识别；
 * 判断只依赖品牌或稳定 code，绝不解析 message 文本。
 * ============================================================ */

import { InsufficientScopeError, SdkErrorCode, UnauthorizedError } from "@modelcontextprotocol/client";

/**
 * 交互授权需求的稳定标识。
 *
 * 用 `Symbol.for` 注册到全局 symbol registry：bundler 双装或版本偏斜导致同进程存在两份
 * adapter 代码时，两份都解析到同一个 symbol，`instanceof` 做不到这一点。SDK 在 transport
 * auth seam 上用同样的手法（`Symbol.for("mcp.authSeamEscape")`），并且 `markAuthSeamEscape()`
 * 是 identity-preserving 的，所以我们的品牌能原样穿过 SDK 冒泡到编排层。
 */
const INTERACTIVE_REQUIRED_BRAND = Symbol.for("zcode.mcp.oauth.interactiveAuthorizationRequired");
const TEMPORARY_REFRESH_FAILURE_BRAND = Symbol.for("zcode.mcp.oauth.temporaryRefreshFailure");

export const MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE = "MCP_OAUTH_INTERACTIVE_REQUIRED";
export const MCP_OAUTH_TEMPORARY_REFRESH_FAILURE_ERROR_CODE =
  "MCP_OAUTH_TEMPORARY_REFRESH_FAILURE";

/** 需要交互授权的稳定原因枚举；由调用方按原因决定提示与跳转，不解析文案。 */
export type McpOAuthInteractiveRequiredReason =
  | "no_credentials"
  | "no_refresh_token"
  | "invalid_grant"
  | "invalid_client"
  | "insufficient_scope"
  | "unauthorized"
  | "legacy_provider_seam";

/**
 * 需要交互授权的错误。
 *
 * - code：固定字符串，供跨进程/跨序列化边界识别；
 * - reason：为什么必须重新授权（凭据缺失、无 refresh token、grant/client 失效等）；
 * - requiredScope：403 step-up 时要求追加的最小 scope，缺省表示未指定；
 * - resourceMetadataUrl：RFC 9728 资源元数据地址，缺省表示服务端未返回。
 */
export interface McpOAuthInteractiveRequiredError extends Error {
  code: typeof MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE;
  reason: McpOAuthInteractiveRequiredReason;
  requiredScope?: string;
  resourceMetadataUrl?: string;
}

/** 临时刷新失败（网络/5xx/server_error）；必须保留凭据，调用方可稍后重试。 */
export interface McpOAuthTemporaryRefreshFailureError extends Error {
  code: typeof MCP_OAUTH_TEMPORARY_REFRESH_FAILURE_ERROR_CODE;
}

/**
 * 构造“需要交互授权”错误并打上全局品牌。
 *
 * serverName 只用于 message 文本，不影响分类；cause 保留原始错误链。
 * 品牌用 `Symbol.for` 注册（不用 `Symbol()`），保证同进程两份 adapter 代码互相识别。
 * requiredScope / resourceMetadataUrl 仅在非空时挂到实例上，避免出现空字符串字段。
 */
export function createInteractiveAuthorizationRequiredError(input: {
  cause?: unknown;
  reason: McpOAuthInteractiveRequiredReason;
  requiredScope?: string;
  resourceMetadataUrl?: string;
  serverName: string;
}): McpOAuthInteractiveRequiredError {
  const error = new Error(
    `MCP server ${input.serverName} requires interactive OAuth authorization (${input.reason})`,
    input.cause === undefined ? undefined : { cause: input.cause },
  ) as McpOAuthInteractiveRequiredError;
  Object.defineProperty(error, INTERACTIVE_REQUIRED_BRAND, {
    configurable: true,
    value: true,
  });
  error.code = MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE;
  error.reason = input.reason;
  if (input.requiredScope) error.requiredScope = input.requiredScope;
  if (input.resourceMetadataUrl) error.resourceMetadataUrl = input.resourceMetadataUrl;
  return error;
}

/**
 * reactive refresh 的网络 / 5xx 失败。
 *
 * 与 `interactiveRequired` 必须区分：临时 AS 故障不代表 grant 已失效，把它误转成交互授权会
 * 无谓打断用户；而返回已被资源服务器拒绝的旧 token 又必然产生第二次 401。
 */
/**
 * 构造“临时刷新失败”错误并打上独立品牌。
 *
 * 与 interactiveRequired 严格区分：它表示 AS 网络/5xx 故障，凭据仍然有效，
 * 绝不能转成“请重新授权”，也不能把刚被拒绝的旧 token 再发给资源服务器。
 */
export function createTemporaryRefreshFailureError(input: {
  cause?: unknown;
  serverName: string;
}): McpOAuthTemporaryRefreshFailureError {
  const error = new Error(
    `MCP server ${input.serverName} OAuth token refresh failed temporarily`,
    input.cause === undefined ? undefined : { cause: input.cause },
  ) as McpOAuthTemporaryRefreshFailureError;
  Object.defineProperty(error, TEMPORARY_REFRESH_FAILURE_BRAND, {
    configurable: true,
    value: true,
  });
  error.code = MCP_OAUTH_TEMPORARY_REFRESH_FAILURE_ERROR_CODE;
  return error;
}

/** 品牌判定：同时接受对象与函数（SDK 有时把错误包装成可调用对象）。 */
export function isInteractiveAuthorizationRequiredError(
  error: unknown,
): error is McpOAuthInteractiveRequiredError {
  return hasBrand(error, INTERACTIVE_REQUIRED_BRAND);
}

/**
 * 品牌判定：临时刷新失败。
 * 与 interactiveRequired 互斥，分类函数先用它短路，避免临时故障被误判成重新授权。
 */
export function isTemporaryRefreshFailureError(
  error: unknown,
): error is McpOAuthTemporaryRefreshFailureError {
  return hasBrand(error, TEMPORARY_REFRESH_FAILURE_BRAND);
}

/** 分类结果：交给编排层展示授权入口所需的最小上下文。 */
export interface InteractiveAuthorizationTrigger {
  reason: McpOAuthInteractiveRequiredReason;
  requiredScope?: string;
  resourceMetadataUrl?: string;
}

/**
 * 把连接期 / 运行期错误归类为「需要交互授权」。
 *
 * 纯 AuthProvider 下 SDK 只可能给出这几种确定性认证错误：
 * - 我们自己抛的 `interactiveRequired`（token 缺失、invalid_grant、invalid_client）；
 * - 重试后仍 401 的 `SdkHttpError(ClientHttpAuthentication)`；
 * - 没有 `onUnauthorized` 时的 `UnauthorizedError`（防御路径）；
 * - Streamable HTTP 403 的 `InsufficientScopeError`（带 requiredScope）。
 *
 * `temporaryRefreshFailure` 显式不在此列：它必须保留凭据并原样失败。
 */
/**
 * 把连接期 / 运行期错误归类为“需要交互授权”，返回 undefined 表示不属于此类。
 *
 * 输入 unknown；输出最小 trigger（reason + 可选 scope / metadata URL），不抛错。
 * 判定顺序：先排除临时刷新失败，再认自家品牌，然后按 SDK 类型
 * （InsufficientScopeError / UnauthorizedError / ClientHttpAuthentication code）。
 * 副作用无。最后沿 cause 链递归一次，因为 SDK 会在若干 seam 包裹原始错误；
 * cause 环（cause === error）直接终止，避免无限递归。
 */
export function classifyInteractiveAuthorizationTrigger(
  error: unknown,
): InteractiveAuthorizationTrigger | undefined {
  if (isTemporaryRefreshFailureError(error)) return undefined;
  if (isInteractiveAuthorizationRequiredError(error)) {
    return {
      reason: error.reason,
      ...(error.requiredScope ? { requiredScope: error.requiredScope } : {}),
      ...(error.resourceMetadataUrl ? { resourceMetadataUrl: error.resourceMetadataUrl } : {}),
    };
  }
  if (error instanceof InsufficientScopeError) {
    return {
      reason: "insufficient_scope",
      ...(error.requiredScope ? { requiredScope: error.requiredScope } : {}),
      ...(error.resourceMetadataUrl
        ? { resourceMetadataUrl: String(error.resourceMetadataUrl) }
        : {}),
    };
  }
  if (error instanceof UnauthorizedError) return { reason: "unauthorized" };
  if (isSdkAuthenticationHttpError(error)) return { reason: "unauthorized" };
  // cause 链：SDK 在若干 seam 上包裹错误，分类不能只看最外层。
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (cause !== undefined && cause !== error) {
    return classifyInteractiveAuthorizationTrigger(cause);
  }
  return undefined;
}

/** 重试后仍 401：`SdkHttpError(SdkErrorCode.ClientHttpAuthentication)`。按 code 比较，不依赖 instanceof。 */
function isSdkAuthenticationHttpError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === SdkErrorCode.ClientHttpAuthentication;
}

/** 品牌读取：仅当品牌值严格为 true 时命中；其他值（含伪造的 false）都不算。 */
function hasBrand(error: unknown, brand: symbol): boolean {
  return (
    (typeof error === "object" && error !== null) ||
    typeof error === "function"
      ? (error as Record<symbol, unknown>)[brand] === true
      : false
  );
}
