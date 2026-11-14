// ============================================================
// 文件定位：网络出口配置解析——代理 URL、NO_PROXY 匹配、TLS CA 证书路径。
// 输入输出：输入请求 URL 与配置/环境变量，输出代理 URL 或 CA 文件路径（未配置为 undefined）。
// 副作用：仅 loadTlsCaCertificates 同步读一次证书文件；其余为纯计算。
// 失败语义：非法 URL/配置静默忽略并降级为“走直连”，不让坏配置阻断请求。
// 不变量：优先级 = 显式 options > ZCODE_* 环境变量 > 工具环境透传；NO_PROXY 命中即不走代理。
// ============================================================
import { readFileSync } from "node:fs";
import {
  ZCODE_AGENT_CA_CERT_ENV_KEY,
  ZCODE_HTTP_PROXY_ENV_KEY,
  ZCODE_NO_PROXY_ENV_KEY,
  ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY,
  readZCodeToolEnvPassthroughEnv,
} from "@zcode/shared";

// 代理解析输入：显式 httpProxy/noProxy 覆盖 env；env 缺省为空对象（不代表 process.env）。
interface NetworkProxyOptions {
  // 环境变量来源；用于读 ZCODE_HTTP_PROXY/ZCODE_NO_PROXY 等键。
  env?: Record<string, string | undefined>;
  // 显式代理地址（可省略协议，缺省按 http:// 补全）。
  httpProxy?: string;
  // 显式 NO_PROXY 列表（逗号分隔），优先于环境变量。
  noProxy?: string;
}

// TLS 配置输入：显式 CA 文件路径优先，其次读 ZCODE_AGENT_CA_CERT 环境变量。
interface NetworkTlsOptions {
  // CA 证书文件绝对/相对路径；空串视为未配置。
  caCertFile?: string;
  // 环境变量来源。
  env?: Record<string, string | undefined>;
}

// 解析结果：noProxyMatched=true 表示命中直连规则（可同时无 proxyUrl）。
interface NetworkProxyResolution {
  // 是否命中 NO_PROXY（含 "*" 全直连）。
  noProxyMatched: boolean;
  // 代理来源标识，仅用于日志排查（如 "network.httpProxy" / "env:..."）。
  proxySource?: string;
  // 规范化后的代理 URL；未配置时为 undefined。
  proxyUrl?: string;
}

// 用户环境透传的代理键按优先级排序：https 优先于 http，小写优先于大写（POSIX 惯例）。
const CAPTURED_USER_PROXY_KEYS = [
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "HTTP_PROXY",
  "all_proxy",
  "ALL_PROXY",
] as const;

/**
 * 只取代理 URL 的便捷入口（用于底层 http/https 请求）：命中 NO_PROXY 时返回 undefined。
 * 不区分“直连”与“未配置”，调用方只关心是否需要代理。
 */
export function resolveProxyUrlForRequest(
  requestUrl: string | URL,
  options: NetworkProxyOptions,
): string | undefined {
  return resolveProxyForRequest(requestUrl, options).proxyUrl;
}

/**
 * WebFetch 专用解析：额外允许回退到“工具环境透传”的 https_proxy/http_proxy/all_proxy。
 * 仅此调用方开启该回退，避免普通请求被宿主机用户环境代理意外影响。
 */
export function resolveWebFetchProxyForRequest(
  requestUrl: string | URL,
  options: NetworkProxyOptions,
): NetworkProxyResolution {
  return resolveProxyForRequestInternal(requestUrl, options, true);
}

/**
 * 通用解析：只认显式配置与 ZCODE_* 环境变量，不读取用户透传代理。
 * 返回完整解析结果（含 noProxyMatched 与来源标识）。
 */
export function resolveProxyForRequest(
  requestUrl: string | URL,
  options: NetworkProxyOptions,
): NetworkProxyResolution {
  return resolveProxyForRequestInternal(requestUrl, options, false);
}

// 代理解析主流程：URL 合法性 → NO_PROXY → 显式配置 → ZCODE 环境 →（可选）用户透传代理。
// 任何一步拿到可用值即返回，保证“先命中先胜出”的确定性优先级。
function resolveProxyForRequestInternal(
  requestUrl: string | URL,
  options: NetworkProxyOptions,
  useCapturedUserProxyFallback: boolean,
): NetworkProxyResolution {
  const url = typeof requestUrl === "string" ? safeUrl(requestUrl) : requestUrl;
  // 非 http(s)（如 data:/file:）没有代理语义，直接按直连返回，避免代理误转发。
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return { noProxyMatched: false };
  }

  // 显式 NO_PROXY 先于任何代理配置判定：命中即绝不使用代理。
  if (shouldBypassProxy(url, readExplicitNoProxyValue(options))) {
    return { noProxyMatched: true };
  }

  const explicitProxy = normalizeProxyUrl(options.httpProxy);
  if (explicitProxy) {
    return {
      noProxyMatched: false,
      proxySource: "network.httpProxy",
      proxyUrl: explicitProxy,
    };
  }

  const env = options.env ?? {};
  const candidates = [[`env:${ZCODE_HTTP_PROXY_ENV_KEY}`, env[ZCODE_HTTP_PROXY_ENV_KEY]]];

  for (const [source, candidate] of candidates) {
    const proxyUrl = normalizeProxyUrl(candidate);
    if (proxyUrl) {
      return {
        noProxyMatched: false,
        proxySource: source,
        proxyUrl,
      };
    }
  }

  // 未开启回退的调用方到此为止：只认显式配置，不继承用户 shell 里的代理。
  if (!useCapturedUserProxyFallback) {
    return { noProxyMatched: false };
  }

  const capturedNoProxy = readCapturedUserNoProxy(env);
  if (shouldBypassProxy(url, capturedNoProxy)) {
    return { noProxyMatched: true };
  }

  const capturedProxy = readCapturedUserProxy(env);
  if (capturedProxy) {
    return {
      noProxyMatched: false,
      proxySource: `env:${ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY}.${capturedProxy.key}`,
      proxyUrl: capturedProxy.proxyUrl,
    };
  }
  return { noProxyMatched: false };
}

/**
 * 解析自定义 CA 证书文件：显式 caCertFile 优先，其次 ZCODE_AGENT_CA_CERT。
 * 只做路径裁剪与空串过滤，不校验文件是否存在；不存在由后续读取失败暴露。
 */
export function resolveTlsCaCertFile(options: NetworkTlsOptions): string | undefined {
  const candidates = [
    options.caCertFile,
    options.env?.[ZCODE_AGENT_CA_CERT_ENV_KEY],
  ];

  for (const candidate of candidates) {
    const normalized = normalizePathLike(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

/**
 * 同步读取 CA 证书内容：未配置返回 undefined；配置了但读不到则抛错（由调用方决定降级）。
 * 由 proxy-fetch 懒加载缓存，避免每个请求都做一次磁盘读取。
 */
export function loadTlsCaCertificates(options: NetworkTlsOptions): Buffer | undefined {
  const caCertFile = resolveTlsCaCertFile(options);
  if (!caCertFile) {
    return undefined;
  }
  return readFileSync(caCertFile);
}

// NO_PROXY 取值：显式 options.noProxy > ZCODE_NO_PROXY；两者都按原串返回（由匹配器切分）。
function readExplicitNoProxyValue(options: NetworkProxyOptions): string | undefined {
  return (
    normalizePathLike(options.noProxy) ??
    normalizePathLike(options.env?.[ZCODE_NO_PROXY_ENV_KEY])
  );
}

// 从工具环境透传里挑第一个可用代理；返回 key 仅用于日志来源标注。
function readCapturedUserProxy(
  env: Record<string, string | undefined>,
): { key: string; proxyUrl: string } | undefined {
  const captured = readZCodeToolEnvPassthroughEnv(env);

  for (const key of CAPTURED_USER_PROXY_KEYS) {
    const proxyUrl = normalizeProxyUrl(captured[key]);
    if (proxyUrl) {
      return { key, proxyUrl };
    }
  }
  return undefined;
}

// 用户透传的 no_proxy 同 key 大小写两种写法都接受，取第一个非空值。
function readCapturedUserNoProxy(env: Record<string, string | undefined>): string | undefined {
  const captured = readZCodeToolEnvPassthroughEnv(env);
  return normalizePathLike(captured.no_proxy) ?? normalizePathLike(captured.NO_PROXY);
}

/**
 * 代理地址规范化：缺协议时补 `http://`，再交给 URL 校验并返回 href。
 * 非法值返回 undefined（调用方按未配置处理），不做猜测或抛错。
 */
function normalizeProxyUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return new URL(candidate).href;
  } catch {
    return undefined;
  }
}

// 通用字符串配置裁剪：仅去掉首尾空白并把空串折算为 undefined。
function normalizePathLike(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// 容错 URL 解析：失败返回 undefined，让代理判定退化为直连而不是抛异常。
function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * NO_PROXY 匹配：逐个逗号 token 比较主机与可选端口，任一命中即返回 true。
 * token 支持 `*`、`host`、`host:port`、`[ipv6]`、`scheme://host:port`，端口仅在与请求端口一致时生效。
 */
function shouldBypassProxy(url: URL, noProxy: string | undefined): boolean {
  const host = normalizeNoProxyHost(url.hostname);
  if (!host || !noProxy) {
    return false;
  }

  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  for (const rawToken of noProxy.split(",")) {
    const token = parseNoProxyToken(rawToken);
    if (!token) {
      continue;
    }
    if (token.host === "*") {
      // 整串通配：等价于关闭代理，立即短路。
      return true;
    }
    if (token.port && token.port !== port) {
      // 端口限定不匹配：继续看下一个 token，不要因为主机相同就误判直连。
      continue;
    }
    if (matchesNoProxyHost(host, token.host)) {
      return true;
    }
  }
  return false;
}

/**
 * 解析单个 NO_PROXY token：统一小写；支持 `*`、`scheme://host[:port]`、`[ipv6]`、`host[:port]`。
 * 空 token 返回 undefined；格式可疑（如坏 URL）同样返回 undefined，由调用方跳过。
 */
function parseNoProxyToken(rawToken: string): { host: string; port?: string } | undefined {
  const trimmed = rawToken.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "*") {
    return { host: "*" };
  }

  if (trimmed.includes("://")) {
    const parsed = safeUrl(trimmed);
    if (!parsed) {
      return undefined;
    }
    return {
      host: normalizeNoProxyHost(parsed.hostname),
      port: parsed.port || undefined,
    };
  }

  const withoutBrackets = trimmed.startsWith("[") ? trimmed.slice(1, trimmed.indexOf("]")) : "";
  if (withoutBrackets) {
    return { host: normalizeNoProxyHost(withoutBrackets) };
  }

  const separatorIndex = trimmed.lastIndexOf(":");
  // 只有一个冒号才当 host:port；IPv6（多个冒号）不加括号时按整串主机处理。
  const hasPort = separatorIndex > 0 && trimmed.indexOf(":") === separatorIndex;
  if (!hasPort) {
    return { host: normalizeNoProxyHost(trimmed) };
  }

  return {
    host: normalizeNoProxyHost(trimmed.slice(0, separatorIndex)),
    port: trimmed.slice(separatorIndex + 1),
  };
}

// 主机名归一：去空白、去 IPv6 方括号、去末尾单点、统一小写，用于大小写无关比较。
function normalizeNoProxyHost(value: string): string {
  return value
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

/**
 * 主机模式匹配：`*.example.com` 与 `.example.com` 都表示“本域及其子域”，
 * 裸 `example.com` 同时匹配精确主机与子域（与 curl 的 NO_PROXY 语义对齐）。
 */
function matchesNoProxyHost(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  if (pattern.startsWith(".")) {
    const suffix = pattern.slice(1);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === pattern || host.endsWith(`.${pattern}`);
}
