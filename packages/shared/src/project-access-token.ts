// INV-01 响应先补默认 enable：守住位置 responseSchema 预处理；改错故障 旧服务端响应被判非法。
// INV-02 enable 为判别键：守住位置 discriminatedUnion；改错故障 关闭态仍带令牌字段。
// INV-03 令牌文本必须非空：守住位置 accessToken 约束；改错故障 空串被缓存为有效凭据。
// INV-04 有效期必须为正有限数：守住位置 expiresIn 与 expiresAt；改错故障 无穷大令牌常驻。
// INV-05 作用域八元组共同定键：守住位置 scopeKey；改错故障 不同场景误共享令牌。
// INV-06 登录代次不得用令牌派生：守住位置 loginGeneration；改错故障 令牌原文进入键与日志。
// INV-07 缓存只做内存态：守住位置 ProjectAccessTokenCache；改错故障 实例被跨宿主共享。
// INV-08 时间与随机源可注入：守住位置 构造选项；改错故障 刷新时序无法单测。
// INV-09 指纹只清被拒绝的那一代：守住位置 rejectedFingerprint 判断；改错故障 迟到 401 废掉新凭据。
// INV-10 同一键的并发只发一个请求：守住位置 pending 复用；改错故障 同步重入触发重复签发。
// INV-11 未到刷新点直接返回缓存：守住位置 有效期比较；改错故障 每次调用都换证。
// INV-12 签发延迟到微任务：守住位置 Promise 首段；改错故障 同步重入绕过 pending 登记。
// INV-13 换人后旧请求必须作废：守住位置 三处对象身份比较；改错故障 旧登录态结果写回新缓存。
// INV-14 有效期从请求发起时起算：守住位置 startedAt；改错故障 网络耗时被算成额外有效期。
// INV-15 刷新点保留提前量与抖动：守住位置 refreshAt 计算；改错故障 到期瞬间并发雪崩。
// INV-16 仅临时故障允许降级：守住位置 捕获分支；改错故障 认证拒绝被当成可重试。
// INV-17 降级不延长原有效期：守住位置 重试截止比较；改错故障 过期令牌被继续使用。
// INV-18 异常不携带响应与令牌：守住位置 自定义错误；改错故障 凭据进入日志或堆栈。
//
// 模块职责：项目访问令牌的解析、缓存、并发合并与临时故障降级。
// 状态所有权：缓存实例由各宿主各自持有；模块本身无全局单例。
// 阅读顺序：先看响应 schema，再读缓存类，最后看指纹与作用域键。
import { z } from "zod";
import { projectTokenSuccessCodeSchema } from "./project-access-token-response.js";
import type { ApiKeyCreationUsageScene } from "./api-key-usage-scene.js";

const SECOND_MS = 1_000;
const REFRESH_LEAD_MS = 120 * SECOND_MS;
const REFRESH_JITTER_MS = 60 * SECOND_MS;
const REFRESH_RETRY_BACKOFF_MS = 5 * SECOND_MS;

// responseSchema 在解析前用 z.preprocess() 补 enable 默认值。
// 缺少 enable 字段时按启用处理。
// 兼容旧服务端只返回令牌体。
// enable 为假时走关闭分支。
// accessToken、expiresIn 与 type 都由 schema 严格校验。
// 解析失败统一转成凭据错误。
const responseSchema = z.preprocess(
  (raw) => {
    if (
      raw &&
      typeof raw === "object" &&
      "data" in raw &&
      raw.data &&
      typeof raw.data === "object" &&
      !("enable" in raw.data)
    ) {
      return { ...raw, data: { ...raw.data, enable: true } };
    }
    return raw;
  },
  z.object({
    code: projectTokenSuccessCodeSchema,
    data: z.discriminatedUnion("enable", [
      z.object({ enable: z.literal(false) }),
      z.object({
        enable: z.literal(true),
        accessToken: z.string().trim().min(1),
        tokenType: z.literal("Bearer"),
        expiresIn: z.number().finite().positive(),
        expiresAt: z.number().finite().positive(),
      }),
    ]),
  }),
);

export interface ProjectAccessTokenScope {
  readonly origin: string;
  readonly family: "bigmodel" | "zai";
  readonly accountId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly apiKeyId: string;
  readonly usageScene: ApiKeyCreationUsageScene;
  /** 登录生命周期标识，不能使用 Token 原文或短期 Token 的哈希。 */
  readonly loginGeneration: string;
}

export type ProjectAccessTokenResult =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly token: string;
      readonly expiresAt: number;
    };

export class ProjectAccessTokenError extends Error {
  constructor(readonly code: "project_token_invalid_response" | "project_token_scope_invalidated") {
    // 响应包含凭据；不把 zod issues、原始响应或 Token 放进异常/日志。
    super(code);
    this.name = "ProjectAccessTokenError";
  }
}

/** I/O adapter 确认的临时故障；不携带原始响应、URL、Token 或 cause。 */
export class ProjectAccessTokenTransientError extends Error {
  constructor() {
    super("project_token_transient_failure");
    this.name = "ProjectAccessTokenTransientError";
  }
}

interface CacheEntry {
  fingerprint?: string;
  value?: Extract<ProjectAccessTokenResult, { enabled: true }>;
  refreshAt?: number;
  pending?: Promise<ProjectAccessTokenResult>;
}

/**
 * 账号鉴权 owner 的纯内存状态，不含网络、存储、定时器或全局单例。
 * Host 和 Standalone 分别持有实例；签发由其已有 I/O adapter 注入。
 */
// ProjectAccessTokenCache 只做内存缓存，不落磁盘。
// Host 与 Standalone 各自持有实例。
// now 与 random 两个时间源都可注入。
// scopeKey() 由八元组序列化得到。
// 同一账号不同场景由 scope.scene 区分，互不共享。
// scope 中的登录代次变化即视为换人，旧条目全部失效。
export class ProjectAccessTokenCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #onRefreshDeferred?: () => void;

  constructor(
    options: { now?: () => number; random?: () => number; onRefreshDeferred?: () => void } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#onRefreshDeferred = options.onRefreshDeferred;
  }

  // 先按指纹清理被拒绝的那一代。
  // 迟到的 401 不得废弃新凭据。
  // 同步重入复用同一个 pending。
  // now < entry.expiresAt 时直接返回缓存值。
  // 签发用 queueMicrotask() 延到微任务再发起。
  // 换人后旧 pending 请求一律作废。
  async resolve(
    scope: ProjectAccessTokenScope,
    issue: () => Promise<unknown>,
    rejectedFingerprint?: string,
  ): Promise<ProjectAccessTokenResult> {
    const key = scopeKey(scope);
    let entry = this.#entries.get(key);
    // 仅清理被拒绝的那一代 PAT；迟到的 401 不得废弃新凭据或打断正在进行的换证。
    if (rejectedFingerprint && entry?.fingerprint === rejectedFingerprint) {
      entry.value = undefined;
      entry.refreshAt = undefined;
    }
    if (entry?.pending) return entry.pending;
    if (entry?.value && this.#now() < Math.min(entry.refreshAt!, entry.value.expiresAt)) {
      return entry.value;
    }
    if (!entry) {
      entry = {};
      this.#entries.set(key, entry);
    }
    const current = entry;
    const startedAt = this.#now();
    // 延迟到微任务执行签发，先登记 pending，确保同步重入也只生成一个请求。
    const pending = Promise.resolve()
      .then(() => {
        // 退出可能先于签发微任务发生；此时连旧登录态的网络请求也不得发出。
        if (this.#entries.get(key) !== current) {
          throw new ProjectAccessTokenError("project_token_scope_invalidated");
        }
        return issue();
      })
      .then(async (raw) => {
        if (this.#entries.get(key) !== current) {
          throw new ProjectAccessTokenError("project_token_scope_invalidated");
        }
        const response = responseSchema.safeParse(raw);
        if (!response.success) throw new ProjectAccessTokenError("project_token_invalid_response");
        const data = response.data.data;
        if (!data.enable) {
          this.#entries.delete(key);
          return Object.freeze({ enabled: false } as const);
        }
        // expiresIn 从发出签发请求时保守起算，不能把网络耗时变成额外有效期。
        const expiresAt = Math.min(
          data.expiresAt * SECOND_MS,
          startedAt + data.expiresIn * SECOND_MS,
        );
        if (!Number.isFinite(expiresAt) || expiresAt <= this.#now()) {
          throw new ProjectAccessTokenError("project_token_invalid_response");
        }
        const jitter = Math.max(0, Math.min(1, this.#random())) * REFRESH_JITTER_MS;
        const fingerprint = await projectAccessTokenFingerprint(data.accessToken);
        if (this.#entries.get(key) !== current)
          throw new ProjectAccessTokenError("project_token_scope_invalidated");
        current.fingerprint = fingerprint;
        current.value = Object.freeze({
          enabled: true,
          token: data.accessToken,
          expiresAt,
        });
        current.refreshAt = expiresAt - REFRESH_LEAD_MS - jitter;
        return current.value;
      })
      .catch((error: unknown) => {
        if (this.#entries.get(key) !== current)
          throw new ProjectAccessTokenError("project_token_scope_invalidated");
        // 只保留仍有效且未被 401 指纹清除的 PAT；认证拒绝和格式错误必须失败。
        // 降级属于同一个 pending，使所有并发调用获得一致结果，不延长原有效期。
        if (
          error instanceof ProjectAccessTokenTransientError &&
          current.value &&
          this.#now() < current.value.expiresAt
        ) {
          current.refreshAt = Math.min(
            this.#now() + REFRESH_RETRY_BACKOFF_MS,
            current.value.expiresAt,
          );
          this.#onRefreshDeferred?.();
          return current.value;
        }
        this.#entries.delete(key);
        throw error;
      })
      .finally(() => {
        if (current.pending === pending) current.pending = undefined;
      });
    current.pending = pending;
    return pending;
  }

  // 作废指定作用域的缓存。
  // 登出与切号都调用 invalidate()。
  // clear 用于整表回收。
  // rejectedFingerprint 只做比较，不做身份。
  // 摘要不进入日志与上游。
  invalidate(scope: ProjectAccessTokenScope): void {
    this.#entries.delete(scopeKey(scope));
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** 仅用于拒绝某一代 PAT 的比较，不作为账号身份，也不传给模型上游。 */
export async function projectAccessTokenFingerprint(token: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function scopeKey(scope: ProjectAccessTokenScope): string {
  return JSON.stringify([
    scope.origin,
    scope.family,
    scope.accountId,
    scope.organizationId,
    scope.projectId,
    scope.apiKeyId,
    scope.usageScene,
    scope.loginGeneration,
  ]);
}
