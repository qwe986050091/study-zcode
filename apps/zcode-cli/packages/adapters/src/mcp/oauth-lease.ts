/* ============================================================
 * MCP OAuth 授权 lease 与 pending 广播（adapters/src/mcp/oauth-lease.ts）
 *
 * 定位：跨进程选主。同一 MCP server 的授权事务只允许一个 leader 开浏览器回调监听，
 * 其余进程降级为 follower，通过共享 pending 记录观察授权 URL 与新凭据。
 * 输入：凭据文件路径、credential keyPrefix、pending 记录。
 * 输出：lease（attemptId + release）或 undefined（竞争失败）；pending 记录或 undefined。
 * 副作用：创建/删除 `.authz` 锁文件；读写共享凭据文件中的 pending key。
 * 失败语义：锁竞争超时返回 undefined（调用方转 follower）；目录不可写等 I/O 错误
 * 直接抛出（交互授权不可能成功，必须上报）。删除 pending 采用 compare-and-delete。
 * 不变量：lease 文件独立于凭据文件；attemptId 唯一标识一次事务，旧 leader 的清理
 * 绝不能删掉新 leader 发布的 pending；pending 的 TTL 只用于展示，不承担锁语义。
 * ============================================================ */

import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { acquireFileLock } from "@zcode/shared/node";
import { ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE } from "@zcode/shared";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import { isRecord, mcpOAuthCredentialKey } from "./oauth-credentials.js";

export const MCP_OAUTH_PENDING_AUTHORIZATION_KEY = "pending_authorization";

/**
 * 授权 lease 的竞争等待预算。
 *
 * 不能用 0：`acquireFileLock` 在竞争时先判断 `elapsed >= maxWaitMs`，之后才尝试回收
 * abandoned lock。零等待会直接超时、永远不执行 owner-dead 检查；持锁进程崩溃后授权功能
 * 将永久不可用。给一个短预算即可保证「失败前至少做一次 owner-dead 回收」，同时把 follower
 * 的额外延迟限制在人机授权流程里无感的量级。
 */
const AUTHORIZATION_LEASE_MAX_WAIT_MS = 250;
const AUTHORIZATION_LEASE_RETRY_DELAYS_MS = [25] as const;
const AUTHORIZATION_LEASE_OWNERLESS_GRACE_MS = 100;

/**
 * 一次授权事务的 leader 凭证。
 *
 * attemptId：随机 16 字节 hex，用于 pending 的归属 CAS 与日志关联；
 * release()：释放文件锁，必须由 leader 在 finally 中调用，失败不重试。
 */
export interface McpOAuthAuthorizationLease {
  attemptId: string;
  release(): Promise<void>;
}

/**
 * lease 文件路径。
 *
 * basename 只允许 hash 与连字符：credential key prefix 形如 `mcp:oauth:<hash>`，冒号在
 * Windows 文件名中非法，直接拼进路径会让整个授权流程在 Windows 上失败。
 */
/**
 * 计算 lease 文件路径：与凭据文件同目录，basename 为 sanitize 后的 keyPrefix + `.authz`。
 * 副作用无；冒号等非法文件名字符被替换，保证 Windows 可创建。
 */
export function resolveAuthorizationLeasePath(
  credentialsFilePath: string,
  keyPrefix: string,
): string {
  return join(dirname(credentialsFilePath), `${sanitizeKeyPrefix(keyPrefix)}.authz`);
}

/** 把 keyPrefix 中非 `[a-zA-Z0-9-]` 字符替换为连字符，得到合法跨平台文件名。 */
export function sanitizeKeyPrefix(keyPrefix: string): string {
  return keyPrefix.replaceAll(/[^a-zA-Z0-9-]/g, "-");
}

/**
 * 尝试成为授权 leader。抢不到返回 `undefined`（调用方转 follower），不阻塞等待。
 *
 * 同进程竞争同样由 `mkdir` 的互斥保证：第二个 caller 的 `mkdir` 收到 EEXIST，随后读到的
 * owner PID 是本进程自己且存活，因此不会误回收，正确降级为 follower。所以不需要额外的
 * 进程内注册表。
 */
/**
 * 尝试获取授权 leader lease。
 *
 * 短预算（250ms）等待后仍抢不到返回 undefined，调用方降级为 follower；预算不能为 0，
 * 否则 acquireFileLock 在超时前不会执行 owner-dead 回收，持锁进程崩溃后授权会永久卡死。
 * 只有文件锁超时被吞；EACCES/EPERM 等目录不可写错误原样抛出。
 */
export async function tryAcquireAuthorizationLease(input: {
  credentialsFilePath: string;
  keyPrefix: string;
}): Promise<McpOAuthAuthorizationLease | undefined> {
  const leasePath = resolveAuthorizationLeasePath(input.credentialsFilePath, input.keyPrefix);
  try {
    const release = await acquireFileLock(
      leasePath,
      AUTHORIZATION_LEASE_RETRY_DELAYS_MS,
      AUTHORIZATION_LEASE_OWNERLESS_GRACE_MS,
      AUTHORIZATION_LEASE_MAX_WAIT_MS,
    );
    return {
      attemptId: randomBytes(16).toString("hex"),
      release,
    };
  } catch (error) {
    if (getErrorCode(error) === ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE) return undefined;
    // EACCES/EPERM 等表示凭据目录不可写，交互授权无论如何都不可能成功，必须上报而不是静默降级。
    throw error;
  }
}

/**
 * 对外暴露的 pending 授权记录。
 *
 * attemptId：发布者事务 id，删除时必须匹配；
 * authorizationUrl：leader 拿到的授权 URL，follower 用它投影同一入口；
 * baselineGeneration：leader 开始前的凭据 generation，用于判断“是否已有别人完成授权”；
 * expiresAt：epoch ms，仅用于展示过期判断；
 * state：OAuth state（回调校验用），不是机密但也不写入日志原值。
 */
export interface PendingAuthorizationRecord {
  attemptId: string;
  authorizationUrl: string;
  baselineGeneration?: string;
  expiresAt: number;
  state: string;
}

interface StoredPendingAuthorization {
  attempt_id: string;
  authorization_url: string;
  baseline_generation?: string;
  expires_at: number;
  state: string;
}

/** 发布/覆盖 pending 记录（同一 key 后写者胜）；写入失败向上冒泡，leader 应视为授权失败。 */
export async function publishPendingAuthorization(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  record: PendingAuthorizationRecord,
): Promise<void> {
  const stored: StoredPendingAuthorization = {
    attempt_id: record.attemptId,
    authorization_url: record.authorizationUrl,
    ...(record.baselineGeneration === undefined
      ? {}
      : { baseline_generation: record.baselineGeneration }),
    expires_at: record.expiresAt,
    state: record.state,
  };
  await credentialStore.save(pendingKey(keyPrefix), JSON.stringify(stored));
}

/** 读取 pending；已过期视为不存在（TTL 只用于展示判断，不承担锁所有权语义）。 */
/** 读取 pending：JSON 损坏、缺字段或已过期均返回 undefined（调用方按“无 leader 广播”处理）。 */
export async function loadPendingAuthorization(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  now = Date.now(),
): Promise<PendingAuthorizationRecord | undefined> {
  const raw = await credentialStore.load(pendingKey(keyPrefix));
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.attempt_id !== "string" ||
    typeof parsed.authorization_url !== "string" ||
    typeof parsed.state !== "string" ||
    typeof parsed.expires_at !== "number"
  ) {
    return undefined;
  }
  if (parsed.expires_at <= now) return undefined;
  return {
    attemptId: parsed.attempt_id,
    authorizationUrl: parsed.authorization_url,
    ...(typeof parsed.baseline_generation === "string"
      ? { baselineGeneration: parsed.baseline_generation }
      : {}),
    expiresAt: parsed.expires_at,
    state: parsed.state,
  };
}

/**
 * 只删除本 attempt 发布的 pending。
 *
 * 删除必须按 attempt CAS：旧 leader 的 `finally` 若无条件删除，会抹掉新 leader 刚发布的
 * pending，follower 随即失去授权 URL。先读当前值确认归属，再按原始值 compare-and-delete。
 */
/**
 * 仅在 pending 仍属于本 attempt 时删除。
 *
 * 返回 true 表示确实删除了当前值；false 表示已被替换（新 leader 发布）或不存在，
 * 此时保留新值，避免 follower 失去授权 URL。删除走 deleteIfValue 原始值 CAS。
 */
export async function deletePendingAuthorizationIfOwned(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  attemptId: string,
): Promise<boolean> {
  const key = pendingKey(keyPrefix);
  const raw = await credentialStore.load(key);
  if (!raw) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 无法解析的残留值只有在确实是当前值时才清理。
    return await credentialStore.deleteIfValue(key, raw);
  }
  if (!isRecord(parsed) || parsed.attempt_id !== attemptId) return false;
  return await credentialStore.deleteIfValue(key, raw);
}

function pendingKey(keyPrefix: string): string {
  return mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_PENDING_AUTHORIZATION_KEY);
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
