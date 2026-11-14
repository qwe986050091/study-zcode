import { createConfig } from "@zcode/adapters/config";
import { openStartupSqliteSessionStore } from "@zcode/adapters/storage";
import type { SessionInfo } from "@zcode/contracts";
import type { ListZCodeSessionsOptions, ResolveLatestSessionOptions } from "./app/types.js";
import { getSessionDbPath, isClosableSessionStore } from "./app/session-store.js";

/**
 * 取最近一个会话（按 store 默认排序，limit=1）。
 *
 * roots:true 只列根会话（不含 subagent/子会话）。store 由本函数创建时负责 close，
 * 外部传入的 store 不关闭（所有权归调用方）；无会话返回 null 而不是抛错。
 */
export async function resolveLatestSession(
  options: ResolveLatestSessionOptions,
): Promise<SessionInfo | null> {
  const ownsStore = options.sessionStore === undefined;
  let sessionStore = options.sessionStore;
  if (!sessionStore) {
    const configResult = createConfig({ env: options.env });
    sessionStore = await openStartupSqliteSessionStore({ dbPath: getSessionDbPath(configResult) });
  }

  try {
    const sessions = await sessionStore.listSessions({
      directory: options.directory,
      limit: 1,
      roots: true,
    });
    return sessions[0] ?? null;
  } finally {
    if (ownsStore && isClosableSessionStore(sessionStore)) {
      sessionStore.close();
    }
  }
}

/**
 * 列出会话：默认 limit=50，只列根会话；directory 用于按 workspace 过滤。
 * 同样遵循「谁创建谁关闭」：外部 store 不 close，本地创建的 store 在 finally 关闭。
 */
export async function listZCodeSessions(
  options: ListZCodeSessionsOptions = {},
): Promise<SessionInfo[]> {
  const ownsStore = options.sessionStore === undefined;
  let sessionStore = options.sessionStore;
  if (!sessionStore) {
    const configResult = createConfig({ env: options.env });
    sessionStore = await openStartupSqliteSessionStore({ dbPath: getSessionDbPath(configResult) });
  }

  try {
    return await sessionStore.listSessions({
      directory: options.directory,
      limit: options.limit ?? 50,
      roots: true,
    });
  } finally {
    if (ownsStore && isClosableSessionStore(sessionStore)) {
      sessionStore.close();
    }
  }
}
