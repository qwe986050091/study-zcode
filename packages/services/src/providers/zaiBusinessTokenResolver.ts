// 业务 token 解析器：用 OAuth token 换取 zai 业务 token，并在内存中做带提前量的缓存。
// INV-01：缓存必须按 oauthAccessToken 精确绑定，换号后绝不能复用上一个账号的业务 token。
// INV-02：命中条件是 expiresAt - 5 分钟 > now()，必须提前失效而不是到期才失效。
// INV-03：任何换取失败都收敛为 zai_oauth_required，调用方只依赖这一个错误码重新登录。
// INV-04：无 expires_in 的响应不写缓存，避免把寿命未知的 token 长期留在内存。
// 破坏后果：跨账号复用会以他人身份计费；提前量不足会让临界期请求带着过期 token 发车。
// [权衡] 缓存只有一格：多账号并发会互相驱逐，但换来无并发写入与更小的状态面。
// 本类不做主动刷新，刷新时机完全由每轮 resolve 前的有效性判断决定。
import type { ApiClient } from "@zcode/shared";
import { readApiJson } from "./api/apiJson.js";

// 提前量取 5 分钟：覆盖一次请求的排队与网络耗时，避免“取出即过期”。
const ZAI_BUSINESS_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

// 同时声明两种命名风格：不同网关版本分别返回 access_token 与 accessToken。
interface ZaiBusinessLoginEnvelope {
  code?: number;
  msg?: string;
  success?: boolean;
  data?: {
    access_token?: string;
    accessToken?: string;
    expires_in?: number;
  } | null;
}

// 缓存项同时记录换取它的 oauth token：这是防止换号后误用的唯一凭据。
interface CachedZaiBusinessToken {
  oauthAccessToken: string;
  accessToken: string;
  expiresAt: number;
}

// now 可注入便于测试过期边界；生产缺省用 Date.now，避免在判断里直接读时钟。
interface ZaiBusinessTokenResolverOptions {
  apiClient: ApiClient;
  loginUrl: string;
  timeoutMs: number;
  now?: () => number;
}

// [并发] cachedToken 是普通字段且无锁：写入是整体替换，读者只会看到旧对象或新对象，
// 因此最坏情况是重复换取一次，不会出现半个缓存项。
export class ZaiBusinessTokenResolver {
  private readonly apiClient: ApiClient;
  private readonly loginUrl: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
// 显式初始化 null：若留成 undefined，“尚未缓存”与“字段未赋值”两种状态会混淆。
  private cachedToken: CachedZaiBusinessToken | null = null;

// [权衡] 用构造注入而非模块级单例：同一进程可能连多个网关，配置不能共享。
  constructor(options: ZaiBusinessTokenResolverOptions) {
    this.apiClient = options.apiClient;
    this.loginUrl = options.loginUrl;
    this.timeoutMs = options.timeoutMs;
// [契约] this.now 存 Date.now 函数引用而非时间戳：每次 resolve 判断有效性时才能读到当时的时钟。
    this.now = options.now ?? Date.now;
  }

// 唯一对外入口：先归一化、再查缓存、最后才走网络，换取失败也不会污染已有缓存。
  async resolve(oauthAccessToken: string): Promise<string> {
// 先 trim 再比较：调用方常从配置或头部带来首尾空白，不归一会让同一 token 被反复换发。
    const normalizedToken = oauthAccessToken.trim();
// [失败路径] 空 token 抛 zai_oauth_required 而不是返回空串，让调用方走统一登录取值流程。
    if (!normalizedToken) {
      throw new Error("zai_oauth_required");
    }

// [并发] 先取本地快照再判断：判断期间其他请求可能替换 cachedToken，
// 用快照保证被校验对象与最终返回的 accessToken 来自同一份数据。
    const cachedToken = this.cachedToken;
    if (this.isCachedTokenValid(cachedToken, normalizedToken)) {
      return cachedToken.accessToken;
    }

// [权衡] 未命中先清空再换取：失败路径上不留下一个已知无效的缓存项。
    this.cachedToken = null;
    return this.exchangeBusinessToken(normalizedToken);
  }

// 类型守卫返回谓词：命中分支里 cachedToken 被收窄为非 null，调用方无需再做断言。
  private isCachedTokenValid(
    cachedToken: CachedZaiBusinessToken | null,
    oauthAccessToken: string,
  ): cachedToken is CachedZaiBusinessToken {
    return Boolean(
      cachedToken &&
// 账号绑定必须精确相等：任何前缀或大小写宽容都会让不同账号的 token 互相命中。
      cachedToken.oauthAccessToken === oauthAccessToken &&
      cachedToken.expiresAt - ZAI_BUSINESS_TOKEN_REFRESH_SKEW_MS > this.now(),
    );
  }

// 真正的网络换取：所有异常与业务失败都收敛为同一错误码，调用方无需理解网关细节。
  private async exchangeBusinessToken(oauthAccessToken: string): Promise<string> {
// [失败路径] catch 后不保留原始错误：调用方只按 zai_oauth_required 触发重新登录，
// 透传底层网络错误会让上层把“网关抖动”误判成需要重新授权。
    let payload: ZaiBusinessLoginEnvelope;
    try {
      payload = await readApiJson<ZaiBusinessLoginEnvelope>(this.apiClient, this.loginUrl, {
        method: "POST",
        timeoutMs: this.timeoutMs,
        headers: {
          "Content-Type": "application/json",
        },
// 字段名固定为 token：这是网关契约，改成 access_token 会被当成空凭据拒绝。
        body: JSON.stringify({ token: oauthAccessToken }),
      });
    } catch {
      throw new Error("zai_oauth_required");
    }

// 两个成功标志都要看：code 缺省视为成功，但 success=false 仍必须判失败。
    if (!isSuccessfulZaiBusinessCode(payload.code) || payload.success === false) {
      throw new Error("zai_oauth_required");
    }

// 两种字段名依次回退，各自 trim 后再判空，避免空白 token 被当作有效值缓存。
    const accessToken =
      payload.data?.access_token?.trim() ?? payload.data?.accessToken?.trim() ?? "";
    if (!accessToken) {
      throw new Error("zai_oauth_required");
    }

// [权衡] 只有 expires_in 是有限数才缓存：缺省时无法判断寿命，
// 缓存反而会把过期 token 固化，导致后续请求持续 401 且无法自愈。
    const expiresIn = payload.data?.expires_in;
    if (expiresIn && Number.isFinite(expiresIn)) {
      this.cachedToken = {
        oauthAccessToken,
        accessToken,
        expiresAt: this.now() + expiresIn * 1000,
      };
    }

    return accessToken;
  }
}

function isSuccessfulZaiBusinessCode(code: unknown): boolean {
  if (code === null || code === undefined) {
    return true;
  }
  if (typeof code === "number") {
    return code === 0 || code === 200;
  }
  if (typeof code === "string") {
    return code === "0" || code === "200";
  }
  return false;
}
