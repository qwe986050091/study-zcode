import { ProjectAccessTokenTransientError } from "@zcode/shared";

/*
 * ============================================================
 * auth / zai-business-token-cache.ts —— Z.ai 业务 JWT 单飞缓存
 *
 * 定位：OAuth token → 业务 JWT 的换取会被并发复用，本类保证同一 OAuth 只有一次
 * 在途请求，并按 JWT exp / expires_in 计算提前刷新点。
 *
 * 输入输出：resolve(oauth, exchange) 返回不可变 ZaiBusinessToken；同一 oauth 命中缓存
 * 直接返回；不同 oauth 视为新会话。
 *
 * 副作用：调用注入的 exchange（网络）；无持久化；构造时可注入“刷新被推迟”回调。
 *
 * 失败语义：瞬时故障且旧 JWT 仍有效→保留旧值并推迟刷新（不降级）；其余失败清空并抛出。
 *
 * 不变量：并发调用拿到同一个 Promise/同一个对象；迟到的 401 通过对象身份校验，
 * 不会误清其他请求已换好的 JWT。
 * ============================================================
 */

const REFRESH_LEAD_MS = 120_000;
const REFRESH_RETRY_BACKOFF_MS = 5_000;
const UNKNOWN_TTL_MS = 300_000;
const SECOND_MS = 1_000;

export interface ZaiBusinessToken {
  /** 业务 JWT 原文，仅用于 Authorization，不应写日志。 */
  readonly token: string;
  /** 建议开始刷新的时间戳（毫秒），提前 expiresAt 120s。 */
  readonly refreshAt: number;
  /** 真实过期时间戳（毫秒）；无法确定时 undefined。 */
  readonly expiresAt?: number;
}
interface Session {
  /** 该会话绑定的 OAuth token，用于判断是否换账号。 */
  oauth: string;
  /** 在途换取 Promise；并发调用共享。 */
  pending?: Promise<ZaiBusinessToken>;
  /** 已换好的值。 */
  value?: ZaiBusinessToken;
  /** 瞬时失败后的最早重试时间。 */
  retryAt?: number;
}

/** 业务 JWT 与 PAT 生命周期不同；缓存只由 CLI 换证 adapter 持有。 */
export class ZaiBusinessTokenCache {
  #session?: Session;
  readonly #rejected = new WeakSet<ZaiBusinessToken>();

  constructor(private readonly onRefreshDeferred?: () => void) {}

  /** 清空会话；下次 resolve 视为全新 oauth。 */
  clear(): void {
    this.#session = undefined;
  }

  /** 标记某代 JWT 被 401 拒绝；按对象身份判断，迟到/重复的 401 不会影响新值。 */
  invalidate(value: ZaiBusinessToken): void {
    // 迟到的旧 401 不得清除其它请求已经换好的业务 JWT。
    this.#rejected.add(value);
    if (this.#session?.value === value) this.#session.value = undefined;
  }

  /** 查询该对象是否已被标记拒绝，供上层区分“需重登”与普通失败。 */
  wasRejected(value: ZaiBusinessToken): boolean {
    return this.#rejected.has(value);
  }

  /**
   * 获取业务 JWT：同 oauth 命中 pending/有效缓存直接复用，否则发起一次 exchange。
   *
   * 时间口径：以 exp 与 expires_in 的最早者为准，未知时按 5 分钟保守 TTL；
   * 瞬时失败但旧值仍有效时只推迟刷新，绝不返回伪造 token。
   */
  async resolve(oauth: string, exchange: () => Promise<unknown>): Promise<ZaiBusinessToken> {
    // OAuth 变了说明已换账号/重新登录，旧会话（含 pending）必须整体作废。
    if (this.#session?.oauth !== oauth) this.#session = { oauth };
    const session = this.#session;
    if (session.pending) return session.pending;
    if (
      session.value &&
      Date.now() <
        Math.min(session.retryAt ?? session.value.refreshAt, session.value.expiresAt ?? Infinity)
    )
      return session.value;
    const startedAt = Date.now();
    const pending = Promise.resolve()
      .then(() => {
        if (this.#session !== session) throw new Error("project_token_scope_invalidated");
        return exchange();
      })
      .then((raw) => {
        if (this.#session !== session) throw new Error("project_token_scope_invalidated");
        const response = raw as {
          code?: unknown;
          data?: {
            access_token?: string;
            accessToken?: string;
            expires_in?: number;
            expiresIn?: number;
          };
        };
        // 兼容业务信封的多种成功码（0/200 及其字符串形式），其余一律视为登录失败。
        if (response.code != null && ![0, 200, "0", "200"].includes(response.code as number))
          throw new Error("project_token_login_failed");
        const data = response.data;
        const token = data?.access_token?.trim() || data?.accessToken?.trim();
        if (!token) throw new Error("project_token_login_failed");
        const ttl = data?.expires_in ?? data?.expiresIn;
        // 同时从 JWT exp 与 expires_in 推导过期时间，取更早者，防止任一来源夸大寿命。
        const deadlines = [
          readJwtExpiry(token),
          typeof ttl === "number" && Number.isFinite(ttl) ? startedAt + ttl * SECOND_MS : undefined,
        ].filter((value): value is number => value !== undefined);
        const expiresAt = deadlines.length ? Math.min(...deadlines) : undefined;
        const cacheUntil = expiresAt ?? startedAt + UNKNOWN_TTL_MS;
        // 已过期或马上过期的 token 不予缓存，直接按换取失败处理。
        if (cacheUntil <= Date.now()) throw new Error("project_token_login_failed");
        const value = Object.freeze({ token, expiresAt, refreshAt: cacheUntil - REFRESH_LEAD_MS });
        session.value = value;
        session.retryAt = undefined;
        return value;
      })
      .catch((error: unknown) => {
        if (this.#session !== session) throw new Error("project_token_scope_invalidated");
        const value = session.value;
        // 真实有效期未知时不能降级；保留原对象身份，让迟到的 401 仍能拒绝这一代 JWT。
        if (
          error instanceof ProjectAccessTokenTransientError &&
          value &&
          !this.wasRejected(value) &&
          value.expiresAt !== undefined &&
          Date.now() < value.expiresAt
        ) {
          session.retryAt = Math.min(Date.now() + REFRESH_RETRY_BACKOFF_MS, value.expiresAt);
          this.onRefreshDeferred?.();
          return value;
        }
        session.value = undefined;
        session.retryAt = undefined;
        throw error;
      })
      .finally(() => {
        // 降级与清理属于共享 pending，所有并发调用必须获得同一个结果。
        if (session.pending === pending) session.pending = undefined;
      });
    session.pending = pending;
    return pending;
  }
}

/**
 * 解码 JWT 的 exp（秒→毫秒），仅用于计算缓存期限。
 * 不校验签名（这是本地缓存，不是鉴权）；格式非法返回 undefined。
 */
function readJwtExpiry(token: string): number | undefined {
  try {
    const raw = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { exp?: unknown };
    return typeof raw.exp === "number" && Number.isFinite(raw.exp)
      ? raw.exp * SECOND_MS
      : undefined;
  } catch {
    return undefined;
  }
}
