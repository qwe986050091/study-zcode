// OAuth 回调归属解析：只从回调 URL 参数中提取投放归因，不参与任何鉴权判定。
// 边界：本模块无 IO、无状态；持久化与会话绑定由调用方负责。
// INV：参数缺失或全为空白时返回 undefined 而非空对象，避免落库产生无效归因。
// INV：只认固定白名单 key，新增渠道须同步 ATTRIBUTION_PARAM_KEYS，否则会被静默丢弃。
import type { OAuthLoginAttribution } from "@zcode/shared";

const ATTRIBUTION_PARAM_KEYS = ["channel_id", "utm_source", "utm_campaign"] as const;

// 先 trim 再判空：渠道方常传空串或纯空格占位，直接透传会污染统计口径。
export function parseOAuthLoginAttribution(
  searchParams: URLSearchParams,
): OAuthLoginAttribution | undefined {
  const attribution: OAuthLoginAttribution = {};

  for (const key of ATTRIBUTION_PARAM_KEYS) {
    const value = searchParams.get(key)?.trim();
    if (value) {
      attribution[key] = value;
    }
  }

  return Object.keys(attribution).length > 0 ? attribution : undefined;
}

// 两个 code 名称来自不同 OAuth 供应商的约定，必须并列判断，否则部分回调会被误判为失败。
export function hasOAuthAuthorizationCode(searchParams: URLSearchParams): boolean {
  return Boolean(searchParams.get("code") || searchParams.get("authCode"));
}
