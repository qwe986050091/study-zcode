// ============================================================
// 网络 header 脱敏（诊断/日志投影）
// 定位：把 fetch 的 Headers 类、数组或普通对象统一成小写键映射，并对敏感头打码。
// 输入：unknown（任何 HeadersInit 形态或已解析对象）。输出：Record<string,string>，敏感值替换为 [redacted]。
// 副作用：无（纯转换，不读取网络）。失败语义：不可识别形态返回空对象，不抛错。
// 不变量：键名必须小写；命中敏感规则的只暴露"存在性"，绝不泄露值。
// ============================================================

import { requestSecuritySensitiveHeaders } from "@zcode/shared";
const HEADER_REDACTION_VALUE = "[redacted]";

const redactedHeaderNames = new Set([
  ...requestSecuritySensitiveHeaders,
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "openai-api-key",
  "x-off-peak-ticket-id",
]);

/**
 * 生成可安全落日志的 header 快照：先归一化为小写键，再按敏感规则逐条决定打码。
 * 无论输入是否为空都返回对象（可能是 {}），调用方可直接序列化。
 */
export function sanitizeModelNetworkHeaders(value: unknown): Record<string, string> {
  const headers = normalizeModelNetworkHeaders(value);
  const sanitized: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    sanitized[normalizedName] = shouldRedactHeader(normalizedName)
      ? HEADER_REDACTION_VALUE
      : headerValue;
  }
  return sanitized;
}

/**
 * 双层判定：精确名单 + 名称包含关键片段（token/secret/cookie/api-key/authorization）。
 * 用"包含"是为了覆盖厂商自定义前缀（如 x-provider-api-key），宁可多打码也不泄露。
 */
function shouldRedactHeader(normalizedName: string): boolean {
  return (
    redactedHeaderNames.has(normalizedName) ||
    normalizedName.includes("authorization") ||
    normalizedName.includes("api-key") ||
    normalizedName.includes("token") ||
    normalizedName.includes("secret") ||
    normalizedName.includes("cookie")
  );
}

/** 把 Headers 实例 / 数组 / 普通对象归一成 Record；无法识别时返回空对象（宁可缺数据也不抛错）。 */
function normalizeModelNetworkHeaders(value: unknown): Record<string, string> {
  if (!value) {
    return {};
  }

  const forEach = (value as { forEach?: unknown }).forEach;
  if (typeof forEach === "function") {
    const headers: Record<string, string> = {};
    forEach.call(value, (headerValue: unknown, name: unknown) => {
      if (typeof name === "string") {
        headers[name] = headerValueToString(headerValue);
      }
    });
    return headers;
  }

  if (Array.isArray(value)) {
    const headers: Record<string, string> = {};
    for (const item of value) {
      if (!Array.isArray(item) || item.length < 2 || typeof item[0] !== "string") {
        continue;
      }
      headers[item[0]] = headerValueToString(item[1]);
    }
    return headers;
  }

  if (typeof value !== "object") {
    return {};
  }

  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    headers[name] = headerValueToString(headerValue);
  }
  return headers;
}

/** 单值转字符串：数组按 ", " 拼接（多值头语义），null/undefined 变空串；数字/布尔转字符串。 */
function headerValueToString(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(headerValueToString).join(", ");
  }
  return value === undefined || value === null ? "" : String(value);
}
