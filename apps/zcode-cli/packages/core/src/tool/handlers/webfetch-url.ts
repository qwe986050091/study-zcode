// WebFetch 的 URL 形态层：规范化、重定向判定、凭据脱敏、主机阻断。
//
// 这里只做「无需解析 DNS 就能判定」的检查：协议、凭据、主机字面量形态。真正的私网/内网
// IP 阻断放在 webfetch-egress-guard，并在每次真实 GET 前执行——分层的原因是 WebFetch
// 从 runtime 所在机器出网，NO_PROXY/代理可能改写连接目标，只在入参阶段查一次不够。
//
// 三个对外口径互相关联：normalizeWebFetchUrl 的输出才是真正出站的 URL（http 会升级成
// https）；isPermittedRedirect 决定哪些跳转可以静默跟随，其余交回模型重新发起（从而
// 重新走权限与 egress）；redactUrlCredentials 是唯一允许把带凭据 URL 拼进日志/结果的地方。
import {
  getIpAddressVersion,
  getPublicEgressIpBlockReason,
  normalizeIpAddressLiteral,
} from "@zcode/contracts";
import { MAX_WEBFETCH_URL_CHARS } from "./webfetch-constants.js";
import { isWebFetchIpLiteral } from "./webfetch-egress-guard.js";
import { webFetchError } from "./webfetch-errors.js";

/**
 * 把模型给的 URL 校验并规范成可出站形态。
 *
 * 输入口径：原始字符串，做长度上限、可解析性、协议、凭据、主机形态五连检查；任一项不过
 * 抛 InvalidUrl / UnsupportedProtocol / CredentialsInUrl，调用方不做兜底（不会「尽力抓」）。
 * 输出：URL 对象，http 已被升级成 https（provider 可见约定），主机已是可访问的公开形态。
 *
 * 反直觉两点：
 * 1. http→https 升级放在所有校验之后：校验看到的是用户原始 URL，错误信息与上下文同入参
 *    一致；升级只影响真正出站的形态，不改变判定依据。
 * 2. 字面量公网 IP 直接放行到 egress guard 复核，而不是在这里二次解析；重复实现两套
 *    IP 判定会互相漂移。
 *
 * 调用方注意：即使命中缓存，本函数也会被调用（见 webfetch.ts），所以它是每次调用的
 * 必经校验点，不能被短路。
 */
export function normalizeWebFetchUrl(value: string): URL {
  if (value.length > MAX_WEBFETCH_URL_CHARS) {
    throw webFetchError("InvalidUrl", "URL is too long", {
      maxLength: MAX_WEBFETCH_URL_CHARS,
      urlLength: value.length,
    });
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch (error) {
    throw webFetchError("InvalidUrl", `Invalid URL: ${value}`, { url: value }, error);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw webFetchError("UnsupportedProtocol", "WebFetch only supports http and https URLs", {
      protocol: url.protocol,
      url: value,
    });
  }

  if (url.username || url.password) {
    throw webFetchError("CredentialsInUrl", "WebFetch URLs must not include credentials", {
      url: redactUrlCredentials(url),
    });
  }

  // provider-visible WebFetch 约定会把模型传入的 HTTP URL 升级成 HTTPS 后再出站请求。
  if (url.protocol === "http:") {
    url.protocol = "https:";
  }

  assertPublicHost(url);
  return url;
}

/**
 * 把 Location 头解析成绝对 URL（相对路径按当前 URL 补齐）。
 *
 * 解析失败抛 UnsafeRedirect——宁可中断也不返回相对串，否则后续 egress/同源判定会拿到
 * 一个无法校验的目标。注意这里只保证「可解析」，是否允许跟随由 isPermittedRedirect 决定。
 */
export function resolveRedirectUrl(location: string, currentUrl: URL): URL {
  try {
    return new URL(location, currentUrl);
  } catch (error) {
    throw webFetchError(
      "UnsafeRedirect",
      `Redirect Location is not a valid URL: ${location}`,
      {
        location,
        url: currentUrl.toString(),
      },
      error,
    );
  }
}

/**
 * 判断这跳重定向能否在工具内部静默跟随（true=跟，false=作为终态交回模型）。
 *
 * 允许条件同时满足：目标无内嵌凭据、目标主机通过公开形态检查、协议与有效端口不变、
 * 主机名去掉 `www.` 后相同。任何一条不满足就停在这里，由模型再次调用 WebFetch。
 *
 * 为什么这么严：跨主机跳转意味着出站目标换了域名，权限审批、egress 白名单、审计归属
 * 都应按新域名重新计算；只有「同一站点的 www 变体/同端口路径跳转」才被视作同一资源。
 * 注意 `to` 的端口规范：默认端口按协议补 80/443，避免显式 `:443` 与隐式被误判为不同。
 */
export function isPermittedRedirect(from: URL, to: URL): boolean {
  if (to.username || to.password) {
    return false;
  }

  if (!isPublicHost(to)) {
    return false;
  }

  if (from.protocol !== to.protocol || effectivePort(from) !== effectivePort(to)) {
    return false;
  }

  if (!sameHostModuloWww(from.hostname, to.hostname)) {
    return false;
  }

  return true;
}

/**
 * 去除 URL 内嵌的用户名/密码后重新序列化，供日志、错误上下文与重定向提示展示。
 *
 * 只做展示脱敏，不改变请求行为；不要用它替代「含凭据即拒绝」的校验。
 */
export function redactUrlCredentials(url: URL): string {
  const clone = new URL(url);
  clone.username = "";
  clone.password = "";
  return clone.toString();
}

/**
 * 主机形态的兜底校验：命中阻断原因就抛 InvalidUrl（错误码统一，不为每种原因增设码）。
 * 与 egress guard 的分工是「此处拦明显非法/本地形态，彼处拦每次真实出站的私网 IP」。
 */
function assertPublicHost(url: URL): void {
  const blocked = getBlockedHostReason(url);
  if (!blocked) return;
  throw webFetchError("InvalidUrl", blocked.message, {
    hostname: blocked.hostname,
    url: url.toString(),
  });
}

/** 与 assertPublicHost 同源判定的布尔形态，供重定向检查复用，避免两套规则漂移。 */
function isPublicHost(url: URL): boolean {
  return getBlockedHostReason(url) === undefined;
}

/**
 * 计算主机被阻断的原因（undefined=放行）。
 *
 * 判定顺序有讲究：
 * 1. 空主机直接拒绝（`http:///path` 这类可解析但无 host 的输入）。
 * 2. 字面量 IP 在此放行——私网判定交给 egress guard，保证「入参检查」与「每次 GET 前
 *    检查」用的是同一套 IP 规则（含 IPv4-mapped/NAT64 还原）。
 * 3. localhost / *.localhost / *.local 明确拒绝：这些是本地开发/内网发现的典型形态。
 * 4. 非字面量、但能识别成 IP 的输入按版本给出不同文案，便于模型区分 v4/v6。
 * 5. 单标签域名（不含 `.`）拒绝：`http://foo` 多是拼写错误或内网别名，不是公网资源。
 */
function getBlockedHostReason(
  url: URL,
): { hostname: string; message: string } | undefined {
  const hostname = normalizeHostname(url.hostname);
  if (hostname.length === 0) {
    return { hostname, message: "URL must include a hostname" };
  }

  // URL 层只负责稳定的形态过滤；WebFetch 的本地字面量 IP egress
  // guard 贴近每次真实 GET，普通域名不再做 DNS preflight。
  if (isWebFetchIpLiteral(hostname)) {
    return undefined;
  }

  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return { hostname, message: "WebFetch requires a public hostname" };
  }

  const ipVersion = getIpAddressVersion(hostname);
  const blockedIp = ipVersion === 0 ? undefined : getPublicEgressIpBlockReason(hostname);
  if (blockedIp && ipVersion === 4) {
    return { hostname, message: "WebFetch blocks non-public IPv4 hosts" };
  }
  if (blockedIp && ipVersion === 6) {
    return { hostname, message: "WebFetch blocks non-public IPv6 hosts" };
  }

  if (ipVersion === 0 && hostname.split(".").length < 2) {
    return { hostname, message: "Invalid URL" };
  }

  return undefined;
}

/** 主机名规范化统一走 contracts 的 IP 字面量规范化，避免手写小写/去点规则与别处不一致。 */
function normalizeHostname(hostname: string): string {
  return normalizeIpAddressLiteral(hostname);
}

/** 有效端口：显式端口优先，否则按协议补默认值；重定向同源判定依赖它来处理 `:443` 写法差异。 */
function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : "80";
}

/** 只比较去掉 `www.` 前缀后的主机名：同站点换 www 前缀不应触发「交回模型」的额外一轮。 */
function sameHostModuloWww(left: string, right: string): boolean {
  return stripWww(left) === stripWww(right);
}

function stripWww(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}
