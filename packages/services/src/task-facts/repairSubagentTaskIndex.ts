// 冷恢复之后的子 Agent 索引修复：只清理旧版本遗留的派生索引行，绝不触碰 Agent 转录本身。
// 边界：候选集取自本地 taskIndex，但是否为 child 一律由 CLI 返回的权威身份裁决，不能反向推断。
// 不变量：可见会话永不删除；跨 workspace、不在本批返回结果中的会话直接跳过。
// 改错后果：放宽身份校验会误删用户可见会话，收紧到无法删除则旧索引永久残留并重复出现。
import { isAuxiliarySessionKind } from "@zcode/shared";
import { resolveWorkspaceKey } from "@zcode/shared";
import type { SubagentIndexRepair } from "#src/task-facts/contract.js";

// 分批上限：避免把大量 sessionId 压进单次 RPC，同时把单批超时后的重扫代价限制在 64 条。
// 批大小相对 CLI 参数长度上限仍有充足余量；调大只摊薄往返，不改变批次之间的独立性。
const IDENTITY_QUERY_BATCH_SIZE = 64;

/** 旧版本曾把冷恢复 child 写入主列表；只清理权威身份确认的派生索引，不删除 Agent 转录。 */
export async function repairSubagentTaskIndex(params: SubagentIndexRepair): Promise<void> {
  const { target, taskIndexRepo, agentService, isCurrent } = params;
  // 旧索引可能保留旧 provider 标签；是否为 child 只按 CLI 返回的权威身份裁决。
  const rows = await taskIndexRepo.listTaskMetas(target);
  // 先剔除调用方给出的可见会话，剩余候选才交给 CLI 做权威身份判定，避免误删用户可见行。
  const ids = rows
    .filter((row) => !params.visibleSessionIds.has(row.taskId))
    .map((row) => row.taskId);
  // 每批重新校验 isCurrent：这是后台低优先级修复，随时可能被更新的快照取代而作废。
  // 批次之间没有外层事务，单批失败不撤销已确认的清理结果；未处理部分留待下次重扫，由调用方决定是否补齐。
  for (let offset = 0; offset < ids.length; offset += IDENTITY_QUERY_BATCH_SIZE) {
    if (!isCurrent()) return;
    // 每批最多 64 个 sessionId，保证超时后的重扫代价有上界；批内顺序与 ids 一致，便于按偏移定位失败批次。
    const batch = ids.slice(offset, offset + IDENTITY_QUERY_BATCH_SIZE);
    // existing-only 表示只查已存在会话、不会创建；旧 Agent 不支持该参数时整批失败，由调用方决定是否重试。
    const sessions = await agentService.listSessions({
      ...target,
      sessionIds: batch,
      runtimePolicy: "existing-only",
    });
    // 旧 Agent 不支持参数时直接失败；缺失记录、跨身份结果和已失效订阅均不能推断为可删除。
    for (const session of sessions) {
      if (!isCurrent()) return;
      if (
        !isAuxiliarySessionKind(session.sessionKind) ||
        !batch.includes(session.sessionId) ||
        resolveWorkspaceKey(session.workspace) !== resolveWorkspaceKey(target)
      )
        continue;
      // 删除前已同时校验辅助类型、批次归属与 workspace 一致；任一条不满足就跳过该行。
      await taskIndexRepo.removeSubagentIndexRow({
        ...target,
        taskId: session.sessionId,
      });
      // 删除后若快照已过期就不再上报计数，避免把作废批次的结果写回调用方。
      if (isCurrent()) params.onRemoved();
    }
  }
}
