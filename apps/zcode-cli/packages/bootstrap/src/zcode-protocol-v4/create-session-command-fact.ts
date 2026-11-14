import type { SessionStorePort } from "@zcode/contracts";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import { queueItemIdForCommand } from "./command-inbox.js";

/**
 * createSession 使用 global command bucket，但 firstInput 的 durable fact 落在新 session。
 * 通过全局唯一 queue item id 找回真实 session，闭合 ACK 丢失/CLI restart 的查重路径。
 *
 * 输入：session input 存储（可缺省）+ 客户端 commandId；commandId 必须能反推出同一个
 * queue item id，否则视为不属于本命令。
 * 输出：命中 promoted → accepted 并带回新 sessionId（ACK 丢失后仍可导航）；
 * 命中 admitted → 先按 session_resumed 结算为 discarded，再返回 failed，要求用户确认重发；
 * 其余终态 → failed + 稳定 reasonCode。查不到或不匹配返回 null（交给上层返回 unknown）。
 * 副作用：只在 admitted 分支做一次 durable settle；不重建 session、不静默重放命令。
 * 失败语义：存储不可用（undefined）等同未命中，绝不猜测 session。
 */
export async function lookupGlobalCreateSessionCommand(
  store: SessionStorePort | undefined,
  commandId: string,
): Promise<CommandAck | null> {
  const record = await store?.getSessionInputById?.(queueItemIdForCommand(commandId));
  if (
    !record ||
    record.payload.sourceCommandType !== "createSession" ||
    (record.payload.conversationInputIntent as { sourceCommandId?: unknown } | undefined)
      ?.sourceCommandId !== commandId
  ) {
    return null;
  }
  if (record.status === "promoted") {
    return {
      commandId,
      status: "accepted",
      revisionAtDecision: 0,
      result: { type: "createSession", sessionId: String(record.sessionID) },
    };
  }
  if (record.status === "admitted") {
    await store?.settleSessionInput?.({
      id: record.id,
      sessionID: record.sessionID,
      status: "discarded",
      reason: "session_resumed",
    });
    return {
      commandId,
      status: "failed",
      reasonCode: "fault.command.inputDiscardedOnRestart",
      message: "Input was discarded when the CLI restarted; confirm before resending.",
      revisionAtDecision: 0,
    };
  }
  const reasonCode =
    record.status === "discarded" && record.statusReason === "session_resumed"
      ? "fault.command.inputDiscardedOnRestart"
      : record.statusReason?.startsWith("fault.") ||
          record.statusReason?.startsWith("proto.") ||
          record.statusReason?.startsWith("guard.")
        ? record.statusReason
        : "fault.command.inputCancelled";
  return {
    commandId,
    status: "failed",
    reasonCode,
    revisionAtDecision: 0,
  };
}
