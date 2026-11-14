// INV-01 配置契约：ZAI 的 authorizeUrl、tokenUrl、clientId、redirectUri 与 BigModel 的 bigmodelAuthorizeUrl、bigmodelAppId 必须成组提供。守住位置：构造函数注入的唯一配置对象。改错故障：缺字段时拼出空参数的授权链接。
// INV-02 参数名差异：BigModel 用 redirect 与 appId，ZAI 用 redirect_uri、response_type、client_id。守住位置：buildAuthorizeUrl 的 provider 分支。改错故障：授权端拒绝请求导致回跳失败。
// INV-03 state 必填：回调解析拿不到 state 直接抛错。守住位置：parseCallbackParams 的入口校验。改错故障：CSRF 防护形同虚设。
// INV-04 授权码兼容：原生 code 与 BigModel 的 authCode 都映射到 code，且 authCode 后写入。守住位置：回调参数的展开顺序。改错故障：BigModel 回调始终取不到授权码。
// INV-05 provider 缺省为 ZAI_PROVIDER_ID。守住位置：exchangeToken 的首行赋值。改错故障：未传 provider 的旧调用点换到错误令牌。
// INV-06 业务码判定：后端 payload 的 code 必须严格等于 0。守住位置：normalizeTokenResponse 的首段校验。改错故障：失败响应被当成成功结果写入凭据。
// INV-07 zcodeJwtToken 取自 data.token，trim 后为空即抛错。守住位置：令牌归一的中段。改错故障：持久化一条没有 JWT 的凭据。
// INV-08 access_token 按 provider 分别取自 data.zai 与 data.bigmodel。守住位置：按 provider 选取的三元分支。改错故障：两家的令牌被串用。
// INV-09 expires_in 单位是秒，过期时刻等于 now 加 expires_in 乘 1000。守住位置：resolveExpiresAt。改错故障：令牌提前或延后过期。
// INV-10 缺少有效 expires_in 时不下发 expiresAt 字段。守住位置：tokenSet 的条件展开。改错故障：写入 NaN 过期时间使刷新逻辑失效。
// INV-11 用户信息有严格与宽松两条识别路径。守住位置：toUserInfo 的先后早返回。改错故障：登录后展示的用户名与头像为空。
// INV-12 宽松路径的 id 缺省为 unknown，只有 name、email 全空且 id 为 unknown 才返回 null。守住位置：toUserInfo 尾部的成立条件。改错故障：无意义的占位用户被当成真实用户。
// INV-13 头像只在 data 图片或 http 链接时原样保留。守住位置：normalizeBackendAvatarUrl 的放行分支。改错故障：相对路径头像直接破图。
// INV-14 纯 base64 且长度不小于 16 的头像补 data:image/png 前缀。守住位置：字符集正则分支。改错故障：浏览器无法解码后端返回的裸 base64。
// INV-15 HTTP 状态非 2xx 视为交换失败，不解析响应体。守住位置：exchangeToken 的 response.ok 判断。改错故障：错误页 HTML 被当作 JSON 解析抛出生僻异常。
// INV-16 请求体始终显式携带 provider，不依赖服务端缺省。守住位置：fetch 的 body 构造。改错故障：BigModel 的授权码走到 ZAI 分支换令牌。
// INV-17 now 可注入，时间计算不直接读系统时钟。守住位置：构造函数的默认参数。改错故障：单测无法固定过期时间只能靠等待。
// INV-18 本模块只做协议转换，不落盘、不重试。守住位置：类与纯函数的边界。改错故障：凭据写入与重试策略散落到两处实现。
//
// 模块职责：把 Web 端 ZAI 与 BigModel 的授权地址构造、回调解析、令牌交换归一为同一份结果结构。
// 状态所有权：本模块不持有任何登录状态，全部输入来自调用方与注入的 config，持久化由上层决定。
// 阅读顺序：配置与结果类型 → 纯函数工具 → 令牌归一化 → 授权地址与回调解析 → 网络交换。
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import type { OAuthTokenSet, UserInfo } from "@zcode/shared";
import type { WebOAuthProviderId } from "./browserOAuthCredentialRepo.js";

// 配置对象是唯一的依赖来源，构造函数不提供任何缺省回退，缺字段只会在运行时拼出坏链接。
// BigModel 只共享 tokenUrl 语义，授权地址与 appId 独立，因为两家的应用注册体系并不互通。
// redirectUri 允许调用方按次覆盖，同一实例在 Web 与桌面场景下回跳地址可能不同。
// 改错故障：给 BigModel 复用 ZAI 的 clientId，授权页会直接报应用不存在。
export interface WebZaiOAuthProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  redirectUri: string;
  /** BigModel 授权入口；参数名与 ZAI 不同（redirect/appId vs redirect_uri/client_id）。 */
  bigmodelAuthorizeUrl: string;
  bigmodelAppId: string;
}

interface WebZaiOAuthCallbackParams {
  code?: string;
  error?: string;
  state: string;
}

// 交换结果一次给出三件东西：归一后的令牌集、展示用用户信息、以及后端原始 user。
// 保留 rawUserInfo 是为了上游临时需要额外字段时不必回头改归一逻辑。
// tokenSet 的 expiresAt 是可选的，后端没给有效期时宁可缺字段也不编造时间。
// 改错故障：去掉 rawUserInfo 会让新增字段的兼容改造必须改这里。
interface WebZaiTokenExchangeResult {
  tokenSet: OAuthTokenSet;
  userInfo: UserInfo;
  rawUserInfo: unknown;
}

interface WebZaiBackendTokenPayload {
  code?: number;
  msg?: string;
  data?: {
    token?: string;
    zai?: {
      access_token?: string;
    } | null;
    bigmodel?: {
      access_token?: string;
    } | null;
    expires_in?: number;
    user?: unknown;
  } | null;
}

// 所有来自后端的 unknown 都先过这道守卫，避免在 null 上读取属性抛 TypeError。
// 数组同样会被判为 record，但本文件只对用户对象做字段读取，不会进入数组分支。
// 改错故障：只判 typeof 为 object 会把 null 放进下游的字段访问。
// 这是纯函数，不写日志也不抛错，缺字段的语义由调用方决定。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeBackendAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^data:image\/[^;]+;base64,/i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length >= 16) {
    return `data:image/png;base64,${trimmed}`;
  }

  return trimmed;
}

// 对外契约：无法识别的输入返回 null，绝不返回半成品对象。
// 严格形状要求 id、username、displayName 三者都是字符串，命中即返回并顺带可选 avatarUrl。
// 严格形状优先于宽松形状，因为新版后端字段语义更准，不能被旧字段覆盖。
// 宽松形状只在 id、name、email 至少有一个有效值时成立，三者全空视为没有用户。
// 改错故障：把返回 null 改成抛错会让可选用户信息变成登录硬失败。
export function toUserInfo(user: unknown): UserInfo | null {
  if (!isRecord(user)) {
    return null;
  }

  if (
    typeof user.id === "string" &&
    typeof user.username === "string" &&
    typeof user.displayName === "string"
  ) {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      ...(typeof user.avatarUrl === "string" ? { avatarUrl: user.avatarUrl } : {}),
    };
  }

  const id = typeof user.user_id === "string" ? user.user_id : "unknown";
  const name = typeof user.name === "string" ? user.name.trim() : "";
  const email = typeof user.email === "string" ? user.email.trim() : "";
  const username = name || email || id;
  if (!name && !email && id === "unknown") {
    return null;
  }

  return {
    id,
    username,
    displayName: username,
    ...(normalizeBackendAvatarUrl(user.avatar)
      ? { avatarUrl: normalizeBackendAvatarUrl(user.avatar) }
      : {}),
  };
}

function resolveExpiresAt(expiresIn: number | undefined, now: () => number): number | undefined {
  if (!expiresIn || !Number.isFinite(expiresIn)) {
    return undefined;
  }

  return now() + expiresIn * 1000;
}

// 这里是令牌结果的唯一归一入口：业务码、JWT、access_token、用户、过期时间按序校验。
// 任一校验失败立即抛错且不返回部分结果，避免调用方拿到半截 tokenSet。
// 错误文案带上 provider 名，便于区分是 ZAI 还是 BigModel 的响应缺字段。
// data.user 归一失败时退回占位用户而非中断登录，因为此时令牌本身已经有效。
// 改错故障：删掉占位用户分支会让只回令牌不回用户的后端响应永久登录失败。
function normalizeTokenResponse(
  payload: WebZaiBackendTokenPayload,
  now: () => number,
  provider: WebOAuthProviderId,
): WebZaiTokenExchangeResult {
  if (payload.code !== 0) {
    throw new Error(payload.msg?.trim() || "OAuth token exchange failed");
  }

  const zcodeJwtToken = payload.data?.token?.trim();
  if (!zcodeJwtToken) {
    throw new Error("Token exchange response missing data.token");
  }

  // 服务端按 provider 把 access_token 放在不同子对象里（GrantJWT 的 resp.Zai / resp.Bigmodel）。
  const accessToken = (
    provider === BIGMODEL_PROVIDER_ID
      ? payload.data?.bigmodel?.access_token
      : payload.data?.zai?.access_token
  )?.trim();
  if (!accessToken) {
    throw new Error(`Token exchange response missing data.${provider}.access_token`);
  }

  const rawUserInfo =
    payload.data?.user && toUserInfo(payload.data.user)
      ? payload.data.user
      : {
          id: "unknown",
          username: "user",
          displayName: "User",
        };
  const userInfo = toUserInfo(rawUserInfo);
  if (!userInfo) {
    throw new Error("Token exchange response missing user info");
  }

  const expiresAt = resolveExpiresAt(payload.data?.expires_in, now);

  return {
    tokenSet: {
      accessToken,
      zcodeJwtToken,
      ...(expiresAt ? { expiresAt } : {}),
    },
    userInfo,
    rawUserInfo,
  };
}

export class ZaiWebOAuthProvider {
  constructor(
    private readonly config: WebZaiOAuthProviderConfig,
    private readonly now: () => number = Date.now,
  ) {}

  // 对外契约：返回可直接跳转的完整地址，编码交给 URLSearchParams，调用方不再手工拼接。
  // 回跳地址取调用方入参优先，其次才是配置里的默认值，两条路径必须保持一致语义。
  // state 原样透传不改写，服务端要靠它与回调时的 state 对齐。
  // 两家参数名没有共通形状，所以保留显式分支而不是造一层映射配置。
  // 改错故障：把 BigModel 的 appId 写法套到 ZAI 上，授权端会忽略 state 并拒绝回跳。
  buildAuthorizeUrl(params: {
    state: string;
    redirectUri?: string;
    provider?: WebOAuthProviderId;
  }): string {
    const redirectUri = params.redirectUri ?? this.config.redirectUri;
    // 两家的授权参数名完全不同，没有共通形状可抽；直接分支比造一层映射配置更好读。
    if (params.provider === BIGMODEL_PROVIDER_ID) {
      const query = new URLSearchParams({
        redirect: redirectUri,
        appId: this.config.bigmodelAppId,
        state: params.state,
      });
      return `${this.config.bigmodelAuthorizeUrl}?${query.toString()}`;
    }

    const query = new URLSearchParams({
      redirect_uri: redirectUri,
      response_type: "code",
      client_id: this.config.clientId,
      state: params.state,
    });

    return `${this.config.authorizeUrl}?${query.toString()}`;
  }

  // 对外契约：只做解析不做业务判定，缺 state 抛错，其余字段按是否出现选择性展开。
  // state 先 trim 再判空，避免只含空白的串绕过校验。
  // code 与 authCode 都接受，后出现的 authCode 会覆盖前者，这是刻意的兼容顺序。
  // error 原样透传，是否展示由上层决定，本模块不吞掉授权端返回的错误。
  // 改错故障：去掉 trim 会让空白 state 被当成有效值继续走令牌交换。
  parseCallbackParams(url: string): WebZaiOAuthCallbackParams {
    const parsed = new URL(url);
    const state = parsed.searchParams.get("state")?.trim();
    if (!state) {
      throw new Error("OAuth callback missing state");
    }

    return {
      state,
      ...(parsed.searchParams.get("code") ? { code: parsed.searchParams.get("code")! } : {}),
      ...(parsed.searchParams.get("authCode")
        ? { code: parsed.searchParams.get("authCode")! }
        : {}),
      ...(parsed.searchParams.get("error") ? { error: parsed.searchParams.get("error")! } : {}),
    };
  }

  // 对外契约：只接收已解析的 code 与 state，返回归一结果或抛出带原因的 Error。
  // provider 缺省取 ZAI_PROVIDER_ID，用于兼容还没有 provider 概念的旧调用点。
  // 请求体显式携带 provider，让服务端不必依赖缺省约定来判断走哪套授权。
  // response.ok 为假时直接抛错且不读响应体，避免把错误页当 JSON 解析。
  // 网络异常与 JSON 解析异常都向上冒泡，本模块不重试，重试策略属于调用方。
  // 改错故障：从请求体删掉 provider 会让 BigModel 的授权码换回 ZAI 令牌。
  async exchangeToken(params: {
    code: string;
    state: string;
    redirectUri?: string;
    provider?: WebOAuthProviderId;
  }): Promise<WebZaiTokenExchangeResult> {
    const provider = params.provider ?? ZAI_PROVIDER_ID;
    const response = await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // 服务端 provider 缺省即 zai，这里仍显式发送：默认值靠约定不如写清楚。
        provider,
        code: params.code,
        redirect_uri: params.redirectUri ?? this.config.redirectUri,
        state: params.state,
      }),
    });

    if (!response.ok) {
      throw new Error(`OAuth token exchange failed with HTTP ${response.status}`);
    }

    return normalizeTokenResponse(
      (await response.json()) as WebZaiBackendTokenPayload,
      this.now,
      provider,
    );
  }
}
