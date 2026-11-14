// INV-01 state 只承载随机数与两个返回地址：守住位置 载荷接口；改错故障 敏感信息进入地址栏。
// INV-02 编码使用 URL 安全字符集且去掉填充：守住位置 编码函数；改错故障 地址中出现加号与斜杠。
// INV-03 解码必须先补填充再还原字符：守住位置 解码函数；改错故障 长度非四倍数时抛错。
// INV-04 解析失败一律返回空值：守住位置 捕获分支；改错故障 恶意 state 中断登录。
// INV-05 随机数必须是非空字符串：守住位置 非空判断；改错故障 空随机数被接受。
// INV-06 可选返回地址只在非空时写回：守住位置 条件展开；改错故障 序列化出现空字段。
// INV-07 回调地址白名单固定为两条远程路径：守住位置 回调路径集合；改错故障 任意路径被当作回调。
// INV-08 应用返回路径额外允许测试入口：守住位置 应用路径集合；改错故障 测试入口无法回跳。
// INV-09 分享路径使用受限正则：守住位置 分享路径模式；改错故障 路径穿越进入返回地址。
// INV-10 应用返回查询只允许四个键：守住位置 查询白名单；改错故障 任意参数被透传。
// INV-11 开发返回地址只信任内网与回环：守住位置 私有网段模式；改错故障 公网地址被当作开发回调。
// INV-12 生产来源与非生产来源分别解析：守住位置 允许来源函数；改错故障 跨环境回跳被放行。
// INV-13 分享路径只返回路径本身：守住位置 分享分支；改错故障 分享链接带回多余查询。
// INV-14 应用回跳必须同源：守住位置 来源比较；改错故障 开放重定向。
// INV-15 重定向地址构造只在双路径合法时生效：守住位置 组合判断；改错故障 非法回调被改写。
// INV-16 回调地址必须清空哈希：守住位置 哈希赋值；改错故障 旧片段残留。
// INV-17 返回回调必须以状态非空为前提：守住位置 状态判断；改错故障 无状态回调被接受。
// INV-18 所有解析函数都不修改入参：守住位置 模块边界；改错故障 调用方字符串被就地改写。
//
// 模块职责：编解码 OAuth state，并校验远程登录的返回地址与回调地址。
// 状态所有权：无状态；所有函数为纯函数，安全来源由调用方传入。
// 阅读顺序：先看编码与解析，再读应用返回地址校验，最后看回调地址构造。
import { DEFAULT_ZCODE_ENDPOINT_ORIGIN } from "@zcode/shared";

const PRODUCTION_WEB_REMOTE_ORIGIN = DEFAULT_ZCODE_ENDPOINT_ORIGIN;
const WEB_REMOTE_CALLBACK_PATHS = new Set(["/remote/v4", "/remote/v4/"]);
// 测试入口也经过登录门禁，必须保留原路径与扫码参数；OAuth 回调仍只使用已登记的 v4。
const WEB_REMOTE_APP_PATHS = new Set([
  ...WEB_REMOTE_CALLBACK_PATHS,
  "/remote/__test__",
  "/remote/__test__/",
]);
const WEB_CALLBACK_PATHS = new Set([
  ...WEB_REMOTE_CALLBACK_PATHS,
  "/cn/share/callback",
  "/share/callback",
]);
const SHARE_PATH_PATTERN = /^\/(?:cn\/share|share)\/[A-Za-z0-9._~-]{1,512}$/u;
const APP_RETURN_QUERY_ALLOWLIST = new Set(["app_version", "sid", "mid", "name"]);
const PRIVATE_DEV_RETURN_TO_PATTERN =
  /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?(\/|$)/;

interface OAuthStatePayload {
  nonce: string;
  app_return_to?: string;
  return_to?: string;
}

interface ResolveSafeAppReturnToOptions {
  currentOrigin?: string;
}

function getCurrentOrigin(): string {
  const location = globalThis.window?.location ?? globalThis.location;
  return location?.origin ?? PRODUCTION_WEB_REMOTE_ORIGIN;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// 先把字符串经 TextEncoder 转 UTF-8 字节，再逐字节 String.fromCharCode 拼成二进制串，最后 btoa 并替换 +→-、/→_、去掉尾部 =；顺序不能省——直接对含多字节字符的原串 btoa 会抛 InvalidCharacterError，不去掉 = 会让 state 在 URL 查询里被截断。
// 返回长度是 4 的倍数减填充数，decodeBase64Url 必须按相反规则先补 '=' 才能 atob。
function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new TextDecoder().decode(bytes);
}

export function buildOAuthState(payload: OAuthStatePayload): string {
  return encodeBase64Url(JSON.stringify(payload));
}

// 只信任 nonce/app_return_to/return_to 三个字段：decodeBase64Url 的 atob/TextDecoder 抛错、JSON.parse 抛错都进 catch 返回 null；nonce 非字符串或 trim 后为空也返回 null；两个 return_to 只在 isNonEmptyString 为真时展开，其余载荷字段一律丢弃，防止额外字段影响后续白名单判断。
export function parseOAuthState(state: string): OAuthStatePayload | null {
  try {
    const parsed = JSON.parse(decodeBase64Url(state)) as Partial<OAuthStatePayload>;
    if (!isNonEmptyString(parsed.nonce)) {
      return null;
    }

    return {
      nonce: parsed.nonce,
      ...(isNonEmptyString(parsed.app_return_to) ? { app_return_to: parsed.app_return_to } : {}),
      ...(isNonEmptyString(parsed.return_to) ? { return_to: parsed.return_to } : {}),
    };
  } catch {
    return null;
  }
}

export function parseOptionalUrl(value?: string): URL | null {
  if (!isNonEmptyString(value)) {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isTrustedDevReturnTo(url: URL): boolean {
  return PRIVATE_DEV_RETURN_TO_PATTERN.test(url.toString()) && WEB_CALLBACK_PATHS.has(url.pathname);
}

function resolveAllowedAppReturnOrigin(currentOrigin: string): string {
  return currentOrigin === PRODUCTION_WEB_REMOTE_ORIGIN
    ? PRODUCTION_WEB_REMOTE_ORIGIN
    : currentOrigin;
}

function pickAppReturnQuery(params: URLSearchParams): URLSearchParams {
  const safeSearch = new URLSearchParams();
  for (const key of APP_RETURN_QUERY_ALLOWLIST) {
    const existing = params.get(key);
    if (existing !== null) safeSearch.set(key, existing);
  }
  return safeSearch;
}

// 拒绝顺序：parseOptionalUrl(value) 失败先 null；pathname 既不在 WEB_REMOTE_APP_PATHS 也不匹配 SHARE_PATH_PATTERN 就 null；origin 必须等于 resolveAllowedAppReturnOrigin(options.currentOrigin ?? getCurrentOrigin())，不等即 null，这是防开放重定向的关键。
// 分享路径只返回 url.pathname 并丢弃查询与哈希；应用路径只保留 pickAppReturnQuery 选出的 APP_RETURN_QUERY_ALLOWLIST 键再拼 `${pathname}?${query}`，顺序反了会让分享链接带回任意参数。
export function resolveSafeAppReturnTo(
  value?: string,
  options: ResolveSafeAppReturnToOptions = {},
): string | null {
  const url = parseOptionalUrl(value);
  if (!url || (!WEB_REMOTE_APP_PATHS.has(url.pathname) && !SHARE_PATH_PATTERN.test(url.pathname))) {
    return null;
  }

  const currentOrigin = options.currentOrigin ?? getCurrentOrigin();
  const allowedOrigin = resolveAllowedAppReturnOrigin(currentOrigin);
  if (url.origin !== allowedOrigin) {
    return null;
  }

  if (SHARE_PATH_PATTERN.test(url.pathname)) return url.pathname;

  const query = pickAppReturnQuery(url.searchParams).toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

/** 网关在 JS 执行前选版本；扫码参数必须进入授权回调，不能只留在 state 中。 */
// 先解析 redirectUri 与 appReturnTo，任一失败即原样返回 redirectUri；redirectUri.pathname 必须属于 WEB_REMOTE_CALLBACK_PATHS，appReturnTo.pathname 必须属于 WEB_REMOTE_APP_PATHS 且能通过 resolveSafeAppReturnTo，任一不满足就回退。
// 全部通过后才把 callbackUrl.search 覆写成 pickAppReturnQuery(sourceUrl.searchParams) 并清空 hash；不清 hash 会把旧片段带进回调，不覆写 search 则扫码参数进不了授权回调。
export function buildWebRemoteOAuthRedirectUri(
  redirectUri: string,
  appReturnTo: string,
  options: ResolveSafeAppReturnToOptions = {},
): string {
  const callbackUrl = parseOptionalUrl(redirectUri);
  const sourceUrl = parseOptionalUrl(appReturnTo);
  if (
    !callbackUrl ||
    !WEB_REMOTE_CALLBACK_PATHS.has(callbackUrl.pathname) ||
    !sourceUrl ||
    !WEB_REMOTE_APP_PATHS.has(sourceUrl.pathname) ||
    !resolveSafeAppReturnTo(appReturnTo, options)
  ) {
    return redirectUri;
  }
  callbackUrl.search = pickAppReturnQuery(sourceUrl.searchParams).toString();
  callbackUrl.hash = "";
  return callbackUrl.toString();
}

// 要求 returnTo 可解析且 isTrustedDevReturnTo 为真（PRIVATE_DEV_RETURN_TO_PATTERN 命中内网/回环，且 pathname 在 WEB_CALLBACK_PATHS），同时 params.state 必须 isNonEmptyString，否则返回 null，避免无状态回调被接受。
// 之后先按 pathname 决定 search 保留白名单查询还是清空，再清 hash；code/error 只在 isNonEmptyString 时 set，state 最后无条件 set，防止入参覆盖或丢失 state。
export function buildReturnToCallbackUrl(
  returnTo: string,
  params: { code?: string; error?: string; state: string },
): string | null {
  const returnToUrl = parseOptionalUrl(returnTo);
  if (!returnToUrl || !isTrustedDevReturnTo(returnToUrl) || !isNonEmptyString(params.state)) {
    return null;
  }

  returnToUrl.search = WEB_REMOTE_CALLBACK_PATHS.has(returnToUrl.pathname)
    ? pickAppReturnQuery(returnToUrl.searchParams).toString()
    : "";
  returnToUrl.hash = "";
  if (isNonEmptyString(params.code)) {
    returnToUrl.searchParams.set("code", params.code);
  }
  if (isNonEmptyString(params.error)) {
    returnToUrl.searchParams.set("error", params.error);
  }
  returnToUrl.searchParams.set("state", params.state);

  return returnToUrl.toString();
}
