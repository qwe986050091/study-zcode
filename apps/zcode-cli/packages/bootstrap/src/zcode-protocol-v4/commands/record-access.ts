// 会话查找共用件（各命令组 handler 复用）。
import type { V4CommandCoreHost, V4SessionRecordView } from "./types.js";

/**
 * 会话不存在（或 envelope.sessionId 为 null）的结构化错误。
 * 由 gateway 归入 rejected/failed ACK；不携带任何持久副作用。
 */
export class V4SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`v4 command session not found: ${sessionId}`);
    this.name = "V4SessionNotFoundError";
  }
}

/**
 * 命令层统一的会话查找：sessionId 为 null 或注册表查不到 → 抛 V4SessionNotFoundError。
 * 返回的是宿主 record 的同一对象引用（命令层只读/临时改字段，不复制注册表）。
 * 无副作用；失败不降级（不允许退回「最近会话」）。
 */
export function requireRecord(
  host: V4CommandCoreHost,
  sessionId: string | null,
): V4SessionRecordView {
  if (sessionId === null) {
    throw new V4SessionNotFoundError("(null)");
  }
  const record = host.getRecord(sessionId);
  if (!record) {
    throw new V4SessionNotFoundError(sessionId);
  }
  return record;
}
