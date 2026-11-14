/* ============================================================
 * MCP OAuth Phase 1 运行期 AuthProvider（adapters/src/mcp/oauth-provider.ts）
 *
 * 定位：只负责“给请求拿一个可用 access token”，不参与 discovery / DCR / 浏览器授权。
 * 输入：authorization_code 配置、共享凭据 store、可选 fetch / logger、keyPrefix、服务器信息。
 * 输出：实现 AuthProvider 的 { token(), onUnauthorized() }。
 * 副作用：读取凭据文件；临期或 401 时进入跨进程刷新锁（可能发起网络请求并写回凭据）。
 * 失败语义：无 token 返回 undefined 让请求吃到 401；无 refresh token 直接抛
 * interactiveRequired；刷新失败由 oauth-refresh 决定（临时错误 / 交互授权）。
 * 不变量：该对象故意不是 OAuthClientProvider，SDK 因此不会走 auth()，所有刷新都被
 * 强制汇入单一跨进程锁，避免并发 refresh 触发 token family 撤销。
 * ============================================================ */

import type { FetchLike, AuthProvider } from "@modelcontextprotocol/client";
import type { Logger, McpOAuthConfig } from "@zcode/contracts";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import { isCanonicalTokenNearExpiry, loadCredentialPair } from "./oauth-credentials.js";
import { createInteractiveAuthorizationRequiredError } from "./oauth-errors.js";
import { refreshMcpOAuthTokensUnderLock } from "./oauth-refresh.js";

type McpAuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

/** 创建 Phase 1 provider 所需依赖；fetchFn 用于刷新网络请求，缺省走 SDK 默认 fetch。 */
export interface CreateMcpOAuthTokenProviderInput {
  config: McpAuthorizationCodeOAuthConfig;
  credentialStore: SharedZCodeCredentialStore;
  fetchFn?: FetchLike;
  keyPrefix: string;
  logger?: Logger;
  serverName: string;
  serverUrl: string;
}

/**
 * Phase 1 运行期 AuthProvider。
 *
 * 只实现 `token()` 与 `onUnauthorized()`，**不是** `OAuthClientProvider`：transport 的
 * `isOAuthClientProvider()` 判定因此为 false，`_oauthProvider` 保持为空
 * （client@2.0.0 `index.mjs:4977-4980`），于是：
 *
 * - 建连不做 discovery、不做 DCR、不开 callback listener；
 * - 401 只调用我们的 `onUnauthorized()` 并自动重试一次，SDK 的 `auth()` 完全不参与，
 *   所有 refresh 都被强制汇入我们的跨进程单飞锁。
 *
 * 绝不要把 `OAuthClientProvider` 传给运行期 transport：它会被 `adaptOAuthProvider` 包裹，
 * 401 走 SDK 的 `handleOAuthUnauthorized()` → `auth()`，绕过 refresh 锁，并发刷新问题立即复发。
 */
/**
 * 构造运行期 AuthProvider（Phase 1）。
 *
 * token()：读 canonical/legacy pair；无 token 返回 undefined；未临期直接返回现值；
 * 临期且有 refresh token 时在跨进程锁内做 proactive 刷新（reactive=false，可 fail-soft）。
 * onUnauthorized()：无凭据或无 refresh token 抛 interactiveRequired；否则在锁内做
 * reactive 刷新（失败必须抛临时错误，绝不返回刚被拒绝的 token）。
 * 副作用：可能读写凭据文件并发起 token endpoint 请求；不创建 transport、不打开浏览器。
 */
export function createMcpOAuthTokenProvider(
  input: CreateMcpOAuthTokenProviderInput,
): AuthProvider {
  const refreshInput = {
    credentialStore: input.credentialStore,
    ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    keyPrefix: input.keyPrefix,
    ...(input.logger ? { logger: input.logger } : {}),
    serverName: input.serverName,
    serverUrl: input.serverUrl,
    ...(input.config.clientId ? { staticClientId: input.config.clientId } : {}),
  };

  return {
    async token(): Promise<string | undefined> {
      const pair = await loadCredentialPair(input.credentialStore, input.keyPrefix);
      // 没有 token 时返回 undefined：请求照发、拿到 401，再由 onUnauthorized 统一分类。
      if (!pair?.tokens) return undefined;
      if (!isCanonicalTokenNearExpiry(pair)) return pair.tokens.access_token;
      // 临期主动刷新。没有 refresh token 就直接用现值撑到 401，不虚构刷新。
      if (!pair.tokens.refresh_token) return pair.tokens.access_token;
      return await refreshMcpOAuthTokensUnderLock({ ...refreshInput, reactive: false });
    },

    async onUnauthorized(): Promise<void> {
      const pair = await loadCredentialPair(input.credentialStore, input.keyPrefix);
      if (!pair?.tokens?.refresh_token) {
        throw createInteractiveAuthorizationRequiredError({
          reason: pair?.tokens ? "no_refresh_token" : "no_credentials",
          serverName: input.serverName,
        });
      }
      // 契约是「让下一次 token() 返回可用 token」，返回值本身被 SDK 忽略；刷新结果已发布到
      // canonical，下一次 token() 会重新读取。
      await refreshMcpOAuthTokensUnderLock({ ...refreshInput, reactive: true });
    },
  };
}
