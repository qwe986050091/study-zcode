// ============================================================
// 官方编码套餐网关路由（静态 URL 决策）
// 定位：把官方 Messages 端点改写到 ultra 网关路径，供 Provider 端点路由端口使用。
// 输入：endpointOrigin（目标网关 origin）+ 请求 URL。输出：{routed,url}；不命中时 routed=false 且 url 原样。
// 副作用：无网络请求；仅做 URL 重写（保留原 query）。
// 失败语义：URL 解析失败、非 https、未登记端点均保守返回未路由，绝不猜路径。
// 不变量：只改 origin+pathname，不携带原请求 header/凭据；匹配键含 hostname、显式端口与去尾斜杠路径。
// ============================================================

import type {
  ProviderEndpointRoutingDecision,
  ProviderEndpointRoutingPort,
} from "@zcode/contracts";

const HTTPS_DEFAULT_PORT = "443";
const ROOT_PATH = "/";
// 键为 "<scheme>//<host>:<port><path>" 的规范化形态，值为网关侧等价路径；新增官方端点须同步登记。
const GATEWAY_PATH_BY_ENDPOINT: ReadonlyMap<string, string> = new Map([
  ["https://open.bigmodel.cn:443/api/anthropic/v1/messages", "/api/v1/ultra/anthropic/v1/messages"],
  ["https://api.z.ai:443/api/anthropic/v1/messages", "/api/v1/ultra-zai/anthropic/v1/messages"],
]);

/** 静态实现只提供 URL 决策；Host 清理、请求与响应透传由公共 fetch wrapper 负责。 */
export function createStaticProviderEndpointRoutingPort(
  endpointOrigin: string,
): ProviderEndpointRoutingPort {
  return {
    /**
     * 解析并尝试改写请求 URL：命中登记表则返回改写后的绝对 URL（query 保留），
     * 否则 routed=false 且原样返回，调用方据此决定是否继续直连。
     */
    async resolve(requestUrl): Promise<ProviderEndpointRoutingDecision> {
      let parsed: URL;
      try {
        parsed = new URL(requestUrl);
      } catch {
        return { routed: false, url: requestUrl };
      }
      if (parsed.protocol !== "https:") return { routed: false, url: requestUrl };
      const path =
        parsed.pathname === ROOT_PATH
          ? ROOT_PATH
          : parsed.pathname.replace(/\/+$/u, "") || ROOT_PATH;
      const key = `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${parsed.port || HTTPS_DEFAULT_PORT}${path}`;
      // 只按精确 key 命中；未知端点宁可直连也不推断网关路径，避免把请求打到错误网关。
      const targetPath = GATEWAY_PATH_BY_ENDPOINT.get(key);
      if (!targetPath) return { routed: false, url: requestUrl };
      const target = new URL(targetPath, endpointOrigin);
      target.search = parsed.search;
      return { routed: true, url: target.href };
    },
  };
}
