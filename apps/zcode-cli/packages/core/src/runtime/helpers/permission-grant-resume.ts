import {
  PERMISSION_FULL_ACCESS_ENTRY,
  permissionFullAccessReceiptSchema,
  traceContextToLogContext,
  type TraceContext,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * 冷恢复时重建"最近一次全量授权"的内存标记（runtime.lastPermissionGrantId）。
 *
 * 输入：runtime（含 sessionStore/logger）、traceContext（仅用于日志关联）。
 * 数据源：sessionStore.sessionEntries(type=PERMISSION_FULL_ACCESS_ENTRY) 的最后一条，
 *   其 data 必须是 permissionFullAccessReceiptSchema 校验通过的 receipt。
 * 副作用：无条件先清空 lastPermissionGrantId；成功时写回 receipt.interactionId。
 * 失败/降级：store 缺席、条目缺失、receipt 损坏或 sessionId 不匹配都只 warn 后返回，
 *   **不抛错**——授权标记只是辅助事实，不能让历史消息与执行状态恢复失败。
 * 不变量：会话隔离——receipt.event.sessionId 必须等于当前 sessionId，否则视为无效。
 */
/** 授权 receipt 在恢复时仅提供辅助标记；格式损坏不能阻断历史及执行状态恢复。 */
export async function restorePermissionGrantMarker(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  runtime.lastPermissionGrantId = undefined;
  const entries = await runtime.sessionStore?.sessionEntries?.({
    sessionID: runtime.sessionId,
    type: PERMISSION_FULL_ACCESS_ENTRY,
  });
  const lastGrant = entries?.at(-1);
  if (!lastGrant) return;
  const receipt = permissionFullAccessReceiptSchema.safeParse(lastGrant.data);
  if (!receipt.success || receipt.data.event.sessionId !== runtime.sessionId) {
    runtime.logger?.warn("Ignoring invalid permission grant marker during session resume", {
      ...traceContextToLogContext(traceContext),
      event: "session.resume.permission_grant_invalid",
      module: "core.runtime",
      entryId: lastGrant.id,
      reason: receipt.success ? "session_mismatch" : "invalid_receipt",
    });
    return;
  }
  runtime.lastPermissionGrantId = receipt.data.interactionId;
}
