/* ============================================================
 * MCP OAuth discovery 缓存共享（adapters/src/mcp/oauth-shared.ts）
 *
 * 定位：Phase 1（运行期刷新）与 Phase 2（交互授权）共用同一份 AS metadata 记录，
 * 避免两套授权路径各自缓存、互相看到过期端点。
 * 输入：凭据 store、credential keyPrefix、可选 expectedIssuer / now / ttlMs。
 * 输出：`OAuthDiscoveryState` 或 undefined（缺失、过期、损坏、issuer 不匹配）。
 * 副作用：读写共享凭据文件（两个 key：状态与抓取时间戳）。
 * 失败语义：读取路径全部吞错并返回 undefined，让调用方重新 discovery（自愈）；
 * 保存路径不吞错，I/O 失败向上冒泡。
 * 不变量：状态值保持裸 `OAuthDiscoveryState` 形态，时间戳另存一个可选 key，
 * 这样未升级的 CLI/desktop 仍能读取；TTL 过期即视为不存在。
 * ============================================================ */

import type { OAuthDiscoveryState } from "@modelcontextprotocol/client";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import { isRecord, mcpOAuthCredentialKey } from "./oauth-credentials.js";

export const MCP_OAUTH_DISCOVERY_STATE_KEY = "discovery_state";
export const MCP_OAUTH_DISCOVERY_FETCHED_AT_KEY = "discovery_state_fetched_at";

/** discovery metadata 缓存寿命。过期后重新发现，避免长期使用换过端点的旧 AS metadata。 */
export const MCP_OAUTH_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

/** 授权上下文：展示给用户的授权 URL、本地回调地址与所属 server 名。 */
export interface McpOAuthAuthorizationContext {
  authorizationUrl: string;
  redirectUrl: string;
  serverName: string;
}

/**
 * discovery 记录的时间戳单独存一个 key，不包裹 `discovery_state` 本身。
 *
 * `discovery_state` 的值形态必须继续是裸 `OAuthDiscoveryState`：CLI 与 desktop 独立升级、
 * 共享同一个凭据文件，把它换成 `{fetched_at, state}` 包裹结构会让未升级的 reader 读到一个
 * 不含 `authorizationServerUrl` 的对象，静默失去 discovery 缓存。追加一个可选 key 才是
 * 向后兼容的做法。
 */
/**
 * 保存 discovery 记录：状态与抓取时间戳写入两个 key。
 *
 * 时间戳单独存放（不包裹状态）是向后兼容要求，见文件头与下方说明。
 * now 可注入以便测试；saveMany 必须在同一个跨进程临界区内完成，避免只写一半。
 */
export async function saveDiscoveryRecord(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  state: OAuthDiscoveryState,
  now = Date.now(),
): Promise<void> {
  await credentialStore.saveMany({
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_STATE_KEY)]: JSON.stringify(state),
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_FETCHED_AT_KEY)]: String(now),
  });
}

/**
 * 读取未过期的 discovery 记录。
 *
 * 缺时间戳（旧版本写入）或已过期都返回 `undefined`，让调用方重新发现一次；下一次保存就会补上
 * 时间戳，自愈。
 */
/**
 * 读取 discovery 记录：TTL 内且 issuer 一致才返回。
 *
 * 以下任一情况返回 undefined，调用方应重新 discovery：
 * - 状态 key 不存在；
 * - 时间戳缺失/非有限数（旧版本写入）或已过期；
 * - JSON 损坏或缺少 `authorizationServerUrl` 字符串；
 * - expectedIssuer 与缓存 issuer（metadata.issuer 或 authorizationServerUrl）不一致。
 * 只读两个 key，无网络副作用；解析失败不回写、不删 key。
 */
export async function loadDiscoveryRecord(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  options: { expectedIssuer?: string; now?: number; ttlMs?: number } = {},
): Promise<OAuthDiscoveryState | undefined> {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? MCP_OAUTH_DISCOVERY_TTL_MS;
  const stateKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_STATE_KEY);
  const fetchedAtKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_FETCHED_AT_KEY);
  const values = await credentialStore.loadMany([stateKey, fetchedAtKey]);
  const raw = values[stateKey];
  if (!raw) return undefined;

  const fetchedAt = Number(values[fetchedAtKey]);
  if (!Number.isFinite(fetchedAt) || now - fetchedAt >= ttlMs) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.authorizationServerUrl !== "string") return undefined;

  const state = parsed as unknown as OAuthDiscoveryState;
  if (options.expectedIssuer && !issuersMatch(state, options.expectedIssuer)) {
    // canonical 记录的 issuer 与缓存不一致：授权服务器换了，缓存必须作废。
    return undefined;
  }
  return state;
}

function issuersMatch(state: OAuthDiscoveryState, expectedIssuer: string): boolean {
  const cachedIssuer = state.authorizationServerMetadata?.issuer ?? state.authorizationServerUrl;
  if (!cachedIssuer) return false;
  return normalizeIssuer(cachedIssuer) === normalizeIssuer(expectedIssuer);
}

/** issuer 比较前去掉末尾斜杠（RFC 中 trailing slash 不改变身份）。 */
function normalizeIssuer(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
