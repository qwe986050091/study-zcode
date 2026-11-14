// 工作区文件回滚组：applyFileRewind。
// 按「某条消息/某一轮」把工作区文件恢复到当时的快照，属于破坏性写操作，
// 不做任何静默重试；行→messageIds 的翻译由 core 完成。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { MessageId, TurnId } from "@zcode/contracts";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import { V4RowTranslationError } from "./fork-edit-retry.js";

/**
 * applyFileRewind：把工作区文件回滚到目标消息/轮次对应的快照。
 * 输入：target（entityId/rowId）；经 host.resolveRowActionTarget 得到
 * messageIds 与 targetTurnId（可能为空，缺省只按消息边界回滚）。
 * 输出：ACK.result 携带 applied / preview / response——applied=false 也是
 * 成功结果（例如无差异可回滚），不是失败；客户端据此展示预览或差异。
 * 副作用：runtime.applyWorkspaceFileRewind 实际改写工作区文件，不可自动回滚，
 * 因此本命令禁止 ACK 丢失后静默重发；客户端应先查询命令结果。
 * 失败：翻译失败抛 V4RowTranslationError；runtime 抛错原样上抛（不吞错、
 * 不伪造 applied=true）。
 */
async function applyFileRewind(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["applyFileRewind"];
  const record = requireRecord(host, envelope.sessionId);
  const resolution = host.resolveRowActionTarget?.(
    record.app.sessionId,
    payload.target,
    "applyFileRewind",
  );
  if (!resolution?.ok) {
    throw new V4RowTranslationError("applyFileRewind", payload.target.rowId);
  }
  const targetMessageIds = (resolution.messageIds ?? []) as MessageId[];
  const targetTurnId = resolution.row.turnId as TurnId;
  const result = await record.app.runtime.applyWorkspaceFileRewind({
    targetMessageIds,
    ...(targetTurnId ? { targetTurnId } : {}),
  });
  return {
    type: "applyFileRewind",
    applied: result.applied,
    preview: result.preview,
    response: result.response,
  };
}

/** 本组原生命令注册表（工作区文件回滚），供 handlers/index.ts 合并。 */
export const fileRewindHandlers = { applyFileRewind };
