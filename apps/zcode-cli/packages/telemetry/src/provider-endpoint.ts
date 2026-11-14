/**
 * provider 端点脱敏工具。
 *
 * 职责：把模型请求的 baseURL 归一成可上报的 ProviderEndpointIdentity（origin + 脱敏路由），
 * 并提供带容量上限的缓存，避免同一会话内反复解析相同端点。
 * 输入口径：baseURL 为 provider 配置里的原始字符串，允许为空；providerKind 只参与缓存键，不参与脱敏。
 * 输出口径：undefined 表示「该端点不可安全上报」（非法 URL、非 http(s)、超长），调用方应按缺失值处理，
 * 不要伪造空 origin。
 * 失败语义：本模块不抛错；URL 解析失败一律降级为 undefined。
 * 不变量：上报结果永不含用户名、密码、query、hash 与敏感路径段；
 * 只有新增脱敏规则时才允许升级 sanitizerVersion。
 */

import type { ProviderEndpointIdentity } from "@zcode/contracts/telemetry";

export const PROVIDER_ENDPOINT_SANITIZER_VERSION = "1";

const MAX_ENDPOINT_CHARS = 4_096;
const MAX_ROUTE_CHARS = 1_024;
const MAX_ROUTE_SEGMENT_CHARS = 128;
// 敏感路径段识别规则：命中即替换为定长占位符，保证同构 URL 在脱敏后仍可按 route 聚合。
const EMAIL_PATTERN = /^[^/@\s]+@[^/@\s]+\.[^/@\s]+$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LONG_NUMBER_PATTERN = /^\d{7,}$/u;
const LONG_HEX_PATTERN = /^[0-9a-f]{16,}$/iu;
const TOKEN_PATTERN = /^(?=.{20,}$)(?=.*[a-z])(?=.*[A-Z0-9])[-._~+/A-Za-z0-9]+=*$/u;

/**
 * 端点身份的 LRU 缓存。
 *
 * 容量口径：默认 256 条，键由 providerKind + baseURL 组成；命中后移到队尾，维持 LRU 次序。
 * 副作用：只占用进程内存，不做任何 I/O。
 * 失败降级：不可上报的端点也缓存为 null，避免对同一坏 URL 反复解析；
 * 读取时把 null 还原为 undefined，让调用方只面对一种「缺失」语义。
 * 不变量：size 不超过 limit；缓存键区分 providerKind，防止不同 provider 复用同一 URL 时互相污染。
 */
export class ProviderEndpointIdentityCache {
  private readonly values = new Map<string, ProviderEndpointIdentity | null>();

  constructor(private readonly limit = 256) {}

  /**
   * 解析并缓存端点身份。
   *
   * 输入：baseURL 为空时直接返回 undefined 且不写缓存——空值本身就是确定的缺失态，无需占位；
   * providerKind 为空时归并为 "unknown" 参与键构造。
   * 副作用：可能淘汰最久未使用的条目（容量上限由构造参数 limit 决定）。
   * 失败语义：脱敏失败返回 undefined，同时把 null 写入缓存，让后续同键请求直接短路。
   */
  resolve(
    providerKind: string | undefined,
    baseURL: string | undefined,
  ): ProviderEndpointIdentity | undefined {
    const normalizedBaseURL = baseURL?.trim();
    if (!normalizedBaseURL) return undefined;
    const key = `${providerKind ?? "unknown"}\0${normalizedBaseURL}`;
    const cached = this.values.get(key);
    if (cached !== undefined) {
      // 命中后重插到队尾：Map 的插入顺序即 LRU 次序，淘汰时只需取队首。
      this.values.delete(key);
      this.values.set(key, cached);
      return cached ?? undefined;
    }

    const value = sanitizeProviderEndpoint(normalizedBaseURL) ?? null;
    this.values.set(key, value);
    if (this.values.size > this.limit) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest) this.values.delete(oldest);
    }
    return value ?? undefined;
  }

  /** 当前缓存条目数（含不可上报的 null 条目），供诊断与容量断言使用。 */
  get size(): number {
    return this.values.size;
  }
}

/**
 * 把 baseURL 脱敏成可上报的端点身份。
 *
 * 口径：保留 origin（协议 + 小写主机 + 非默认端口）与逐段脱敏后的 pathname；
 * 明确丢弃 userinfo、query、hash——它们最可能携带凭据或用户标识。
 * 输入上限：超过 MAX_ENDPOINT_CHARS 直接放弃，避免异常长串进入 telemetry 通道。
 * 失败语义：非 http/https 协议或 URL 无法解析时返回 undefined，调用方不得自行拼接兜底值。
 * 不变量：同一 baseURL 在同一 sanitizerVersion 下必须得到相同结果，缓存与聚合都依赖该确定性。
 */
export function sanitizeProviderEndpoint(baseURL: string): ProviderEndpointIdentity | undefined {
  if (baseURL.length > MAX_ENDPOINT_CHARS) return undefined;
  try {
    const parsed = new URL(baseURL);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    // userinfo/query/hash 是凭据与隐私最常见的藏身处，上报前一律清空而不是截断。
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    // 默认端口等价于省略：不清掉会让 https://x:443 与 https://x 被当成两个端点，破坏聚合。
    if (
      (parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")
    ) {
      parsed.port = "";
    }

    const origin = parsed.origin;
    const route = sanitizePathname(parsed.pathname).slice(0, MAX_ROUTE_CHARS);
    return {
      origin,
      route,
      sanitizerVersion: PROVIDER_ENDPOINT_SANITIZER_VERSION,
    };
  } catch {
    // 非法 URL 属于预期输入：降级为不可上报，不向上层抛出，以免 telemetry 影响主流程。
    return undefined;
  }
}

/**
 * 逐段脱敏 pathname。
 *
 * 空路径归一为 "/"，保证 origin + route 拼出的身份稳定且非空；
 * 每段交给 sanitizePathSegment 处理，整体再按 MAX_ROUTE_CHARS 截断。
 */
function sanitizePathname(pathname: string): string {
  const segments = pathname
    .split("/")
    .map((segment) => sanitizePathSegment(safeDecodeURIComponent(segment)));
  const sanitized = segments.join("/");
  return sanitized || "/";
}

/**
 * 尽力解码单个路径段。
 *
 * 非法百分号编码时保持原样返回：解码只是为了让敏感规则命中，不能因解码失败丢掉整条端点。
 */
function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 识别并替换路径里的敏感标识符。
 *
 * 规则按固定顺序短路：邮箱 → UUID → 长数字 → 长 hash → token；顺序决定唯一结果，
 * 否则同一段可能同时命中多条规则而得到两种脱敏值。
 * 未命中敏感规则时按 MAX_ROUTE_SEGMENT_CHARS 截断，防止异常长段撑大上报字段。
 */
function sanitizePathSegment(segment: string): string {
  if (EMAIL_PATTERN.test(segment)) return "{email}";
  if (UUID_PATTERN.test(segment)) return "{uuid}";
  if (LONG_NUMBER_PATTERN.test(segment)) return "{id}";
  if (LONG_HEX_PATTERN.test(segment)) return "{hash}";
  if (TOKEN_PATTERN.test(segment)) return "{token}";
  return segment.slice(0, MAX_ROUTE_SEGMENT_CHARS);
}
