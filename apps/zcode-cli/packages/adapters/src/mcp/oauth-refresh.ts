/* ============================================================
 * MCP OAuth token 跨进程刷新（adapters/src/mcp/oauth-refresh.ts）
 *
 * 定位：Phase 1 唯一的 refresh 实现。把 discovery + token exchange 放进
 * 独立于凭据文件的跨进程文件锁，保证同一 server 全机单飞（single-flight）。
 * 输入：credential store、keyPrefix、serverUrl、reactive 标记、静态 clientId、fetch/logger。
 * 输出：可用 access_token 字符串；失败按类型抛 interactiveRequired 或 temporaryRefresh。
 * 副作用：文件锁、凭据读写、discovery 网络请求、token endpoint 网络请求、日志（不含 token）。
 * 失败语义：锁超时先重读（赢家可能已发布）否则抛临时错误；discovery/网络/5xx 走 failSoft；
 * invalid_grant 清 tokens 保留 client；invalid_client 看 staticClientId 决定报配置错误或清空。
 * 不变量：锁内发布后任何等待者都能观察到 generation 变化并直接复用；reactive 失败绝不
 * 返回刚被拒绝的旧 token；日志只记录 generation 前 12 位与是否轮换，不记录凭据值。
 * ============================================================ */

import { dirname, join } from "node:path";
import {
  discoverOAuthServerInfo,
  OAuthError,
  OAuthErrorCode,
  refreshAuthorization,
  selectResourceURL,
  type AuthorizationServerMetadata,
  type FetchLike,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/client";
import type { Logger } from "@zcode/contracts";
import { isZCodeFileLockTimeoutError } from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import {
  invalidateCanonicalCredentials,
  loadCredentialPair,
  publishCanonicalCredentials,
  type CredentialPairSnapshot,
} from "./oauth-credentials.js";
import {
  createInteractiveAuthorizationRequiredError,
  createTemporaryRefreshFailureError,
} from "./oauth-errors.js";
import { sanitizeKeyPrefix } from "./oauth-lease.js";
import { loadDiscoveryRecord, saveDiscoveryRecord } from "./oauth-shared.js";

/**
 * refresh 锁的获取预算。
 *
 * 必须覆盖锁内的网络预算（一次 discovery + 一次 token 请求），否则等待者会在 winner 还没
 * 发布结果时就超时。`withFileLock` 的默认值只有 8 秒（privateFilePersistence.ts:9），不够。
 */
const REFRESH_LOCK_MAX_WAIT_MS = 45_000;

/**
 * 刷新入参。
 * reactive 语义见字段注释；serverName 只用于错误与日志；serverUrl 用于 discovery 与
 * RFC 8707 resource 绑定；staticClientId 存在时 invalid_client 无法自愈。
 */
export interface RefreshMcpOAuthTokensInput {
  credentialStore: SharedZCodeCredentialStore;
  fetchFn?: FetchLike;
  keyPrefix: string;
  logger?: Logger;
  /**
   * reactive = 由 401 的 `onUnauthorized` 触发。
   *
   * 决定网络失败时的语义：proactive（临期主动刷新）可以 fail-soft 返回现值，因为那个 token 还没
   * 被资源服务器拒绝；reactive 不能——它刚被拒绝，返回它必然产生第二次 401 并抛
   * `ClientHttpAuthentication`，还会把临时 AS 故障误判成需要交互授权。
   */
  reactive: boolean;
  serverName: string;
  serverUrl: string;
  /** 静态配置的 clientId。存在时 `invalid_client` 不能靠交互授权自愈。 */
  staticClientId?: string;
}

/**
 * discovery 结果：authorizationServerUrl 必填；metadata 为 AS 元数据；resource 为
 * 经 RFC 8707 校验后的资源标识（缺失表示无法确定受众，refresh 请求不带 resource）。
 */
export interface ResolvedAsMetadata {
  authorizationServerUrl: string;
  metadata?: AuthorizationServerMetadata;
  resource?: URL;
}

/**
 * 在跨进程单飞锁内刷新 access token，返回可用的 access token。
 *
 * 并发刷新问题：多个 CLI 进程共享同一份凭据文件，`withFileLock` 只覆盖凭据读写、不覆盖网络
 * token exchange。access token 过期时各进程并发用同一个 refresh token 刷新，撞授权服务器的
 * rotation reuse-detection，整个 token family 被撤销，最终退化成重新授权。
 */
/**
 * 记录进入锁前的 generation，用于锁内/锁超时后判断“是否有别人完成刷新”。
 * 锁超时不是刷新失败：赢家可能已发布结果，先重读；只有没换代或无 token 才抛临时错误。
 * 副作用：文件锁与网络；失败语义见文件头。
 */
export async function refreshMcpOAuthTokensUnderLock(
  input: RefreshMcpOAuthTokensInput,
): Promise<string> {
  const observedGeneration = (await loadCredentialPair(input.credentialStore, input.keyPrefix))
    ?.generation;
  const lockPath = resolveRefreshLockPath(input.credentialStore.filePath, input.keyPrefix);

  try {
    return await withFileLock(lockPath, async () => await refreshLocked(input, observedGeneration), {
      lockMaxWaitMs: REFRESH_LOCK_MAX_WAIT_MS,
    });
  } catch (error) {
    if (!isZCodeFileLockTimeoutError(error)) throw error;
    // 等锁超时不代表刷新失败：winner 可能已经发布结果。先重读，确认换代且有 token 就直接用。
    const current = await loadCredentialPair(input.credentialStore, input.keyPrefix);
    if (current?.tokens && current.generation !== observedGeneration) {
      return current.tokens.access_token;
    }
    throw createTemporaryRefreshFailureError({ cause: error, serverName: input.serverName });
  }
}

/**
 * 锁内主体。
 *
 * 先重读并比较 generation：已换代且带 token → 直接复用（避免重复 refresh 触发 family 撤销）；
 * 无 token → 交互授权（不能假装“无凭据”静默返回）；无 refresh_token/client → 交互授权。
 * discovery 失败与 refresh 失败分别归类：前者绝不算 grant 失效，后者交给 handleRefreshFailure。
 * 成功后一次 publishCanonicalCredentials 原子发布并记录脱敏日志。
 */
async function refreshLocked(
  input: RefreshMcpOAuthTokensInput,
  observedGeneration: string | undefined,
): Promise<string> {
  const current = await loadCredentialPair(input.credentialStore, input.keyPrefix);

  // 合并：等锁期间别人已经刷新过就直接复用，零二次请求。这是 rotation reuse-detection 的关键。
  if (current?.tokens && current.generation !== observedGeneration) {
    return current.tokens.access_token;
  }
  if (!current?.tokens) {
    // generation 变了但 winner 没留下 token（例如它收到 invalid_grant）：不能当成「没有凭据」
    // 静默返回，必须转入交互授权。
    throw createInteractiveAuthorizationRequiredError({
      reason: "no_credentials",
      serverName: input.serverName,
    });
  }
  const refreshToken = current.tokens.refresh_token;
  const clientInformation = current.clientInformation;
  if (!refreshToken || !clientInformation) {
    throw createInteractiveAuthorizationRequiredError({
      reason: "no_refresh_token",
      serverName: input.serverName,
    });
  }

  let resolved: ResolvedAsMetadata;
  try {
    resolved = await resolveAsMetadata(input, current);
  } catch (error) {
    // discovery 失败绝不能当作 grant 失效。
    return failSoft(input, current, error);
  }

  try {
    const next = await refreshAuthorization(resolved.authorizationServerUrl, {
      clientInformation,
      refreshToken,
      ...(resolved.metadata ? { metadata: resolved.metadata } : {}),
      ...(resolved.resource ? { resource: resolved.resource } : {}),
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    });
    const published = await publishCanonicalCredentials(input.credentialStore, input.keyPrefix, {
      clientInformation,
      ...(current.issuer ? { issuer: current.issuer } : {}),
      publishedBy: `refresh:${input.keyPrefix}`,
      tokens: next,
    });
    input.logger?.info("MCP OAuth access token refreshed", {
      event: "mcp.oauth.refresh.completed",
      credentialKeyPrefix: input.keyPrefix,
      mcpServerName: input.serverName,
      processId: process.pid,
      publishedGeneration: published.generation.slice(0, 12),
      reactive: input.reactive,
      refreshTokenRotated: next.refresh_token !== refreshToken,
      status: "completed",
    });
    return next.access_token;
  } catch (error) {
    return await handleRefreshFailure(input, current, error);
  }
}

/**
 * 刷新失败分类。
 *
 * invalid_grant：条件失效 canonical（scope=tokens，保留 client）后要求交互授权；
 * invalid_client/unauthorized_client：静态 clientId 时直接报配置错误（否则循环），
 * 动态 client 则 scope=all 清空后要求交互授权；
 * 其余（网络/5xx/server_error）交给 failSoft，proactive 可返回旧 token。
 * 副作用：可能删除凭据 key；日志只含错误码与来源，不含 token。
 */
async function handleRefreshFailure(
  input: RefreshMcpOAuthTokensInput,
  current: CredentialPairSnapshot,
  error: unknown,
): Promise<never | string> {
  const oauthErrorCode = error instanceof OAuthError ? error.code : undefined;
  input.logger?.warn("MCP OAuth access token refresh failed", {
    event: "mcp.oauth.refresh.failed",
    credentialKeyPrefix: input.keyPrefix,
    credentialSource: current.source,
    mcpServerName: input.serverName,
    oauthErrorCode,
    processId: process.pid,
    reactive: input.reactive,
    status: "failed",
  });

  if (oauthErrorCode === OAuthErrorCode.InvalidGrant) {
    // 确定性失效：refresh token 已被撤销或过期。CAS 清 tokens、保留 client 作为重新授权种子。
    if (current.raw) {
      await invalidateCanonicalCredentials(
        input.credentialStore,
        input.keyPrefix,
        current.raw,
        "tokens",
      );
    }
    throw createInteractiveAuthorizationRequiredError({
      cause: error,
      reason: "invalid_grant",
      serverName: input.serverName,
    });
  }

  if (
    oauthErrorCode === OAuthErrorCode.InvalidClient ||
    oauthErrorCode === OAuthErrorCode.UnauthorizedClient
  ) {
    if (input.staticClientId) {
      // 静态配置 client 的 invalid_client 无法靠交互授权自愈：Phase 2 仍会使用同一个 client，
      // 转授权只会形成循环。按配置错误上报。
      throw new Error(
        `MCP server ${input.serverName} OAuth client was rejected by the authorization server (invalid_client). ` +
          `The configured clientId is not usable; fix the MCP oauth configuration.`,
        { cause: error },
      );
    }
    if (current.raw) {
      await invalidateCanonicalCredentials(
        input.credentialStore,
        input.keyPrefix,
        current.raw,
        "all",
      );
    }
    throw createInteractiveAuthorizationRequiredError({
      cause: error,
      reason: "invalid_client",
      serverName: input.serverName,
    });
  }

  return failSoft(input, current, error);
}

/**
 * 非确定性失败（网络、5xx、`server_error`）。
 *
 * proactive 返回现值：token 还没被拒绝，让请求继续走，401 路径保留最终裁决权。
 * reactive 必须抛临时错误：现值刚被拒绝，返回它一定再 401。
 */
function failSoft(
  input: RefreshMcpOAuthTokensInput,
  current: CredentialPairSnapshot,
  error: unknown,
): string {
  if (input.reactive || !current.tokens) {
    throw createTemporaryRefreshFailureError({ cause: error, serverName: input.serverName });
  }
  return current.tokens.access_token;
}

/**
 * 解析授权服务器元数据与经校验的 resource。
 *
 * discovery 记录带 TTL 且与 Phase 2 共用；`resource` 必须求出并带进 refresh 请求（RFC 8707），
 * SDK 自己的 refresh 会传它，我们绕开 `auth()` 后必须自己补上，否则受众绑定丢失。
 */
/**
 * 边解析 discovery、边复用缓存。
 *
 * 缓存命中直接使用；未命中才 discover 并保存（TTL 与 Phase 2 共享）。
 * resource 必须显式 selectResourceURL 并带入 refresh：绕过 SDK auth() 后 SDK 不会替我们补，
 * 丢失会导致 RFC 8707 受众绑定失效。空壳 provider 只满足函数签名，不产生回调。
 */
export async function resolveAsMetadata(
  input: Pick<
    RefreshMcpOAuthTokensInput,
    "credentialStore" | "fetchFn" | "keyPrefix" | "serverUrl"
  >,
  current: Pick<CredentialPairSnapshot, "issuer">,
): Promise<ResolvedAsMetadata> {
  const cached = await loadDiscoveryRecord(input.credentialStore, input.keyPrefix, {
    ...(current.issuer ? { expectedIssuer: current.issuer } : {}),
  });
  const discovered: OAuthDiscoveryState =
    cached ??
    (await discoverOAuthServerInfo(input.serverUrl, {
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    }));
  if (!cached) {
    await saveDiscoveryRecord(input.credentialStore, input.keyPrefix, discovered);
  }

  const resource = await selectResourceURL(
    input.serverUrl,
    // selectResourceURL 只读 provider 的 validateResourceURL；这里没有 provider，传一个空壳即可。
    {} as never,
    discovered.resourceMetadata,
  );
  return {
    authorizationServerUrl: discovered.authorizationServerUrl,
    ...(discovered.authorizationServerMetadata
      ? { metadata: discovered.authorizationServerMetadata }
      : {}),
    ...(resource ? { resource } : {}),
  };
}

/**
 * refresh 锁文件路径。
 *
 * 必须独立于 credentials 文件：锁内会调用 `publishCanonicalCredentials`，后者自己对
 * credentials.json 加锁；同一路径会自重入死锁。basename 只含 hash 与连字符（Windows 文件名
 * 不允许冒号）。
 */
export function resolveRefreshLockPath(credentialsFilePath: string, keyPrefix: string): string {
  return join(dirname(credentialsFilePath), `${sanitizeKeyPrefix(keyPrefix)}.refresh`);
}
