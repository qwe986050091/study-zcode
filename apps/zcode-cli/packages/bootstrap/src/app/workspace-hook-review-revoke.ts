// ============================================================
// workspace hook 的「撤销信任」（review 面板的 revoke 命令）
// ============================================================
// 位置：review controller 收到 revoke 后调用。先按 workspaceIdentity 读信任策略，只有
// user_decides 才允许撤销；随后持久化删除记录、用文件结果重建内存信任表，再撤销协调器里
// 的即时信任。顺序保证「内存看到的」与「磁盘写下的」一致。
// 失败语义：策略不允许时回 accepted=false + 明确 reasonCode；存储/协调器抛错时统一收敛为
// workspace_hooks_trust_store_corrupt（不把异常放给 UI）。

import type { WorkspaceHookBundleSnapshot } from "@zcode/contracts";
import type { WorkspaceHookTrustCoordinator } from "@zcode/core";
import type {
  WorkspaceHookReviewCommandResult,
  WorkspaceHookTrustStoreMutationPort,
} from "./workspace-hook-review-types.js";

/**
 * 撤销一组 hook 声明的持久信任与即时信任；成功时回显被处理的 reviewItemIds。
 *
 * `digests` 是 hook 声明的归一化摘要，不是文件路径；`workspaceIdentity` 决定作用域。
 * 策略为 allow_trusted_only 时回 requires_pretrust，blocked 时回 blocked_by_policy——
 * 两者都**不改**存储。store 是 Promise，因为它由应用装配异步打开。
 */
export async function applyWorkspaceHookRevoke(input: {
  coordinator: WorkspaceHookTrustCoordinator;
  digests: readonly string[];
  reviewItemIds: readonly string[];
  snapshot: WorkspaceHookBundleSnapshot;
  store: Promise<WorkspaceHookTrustStoreMutationPort>;
}): Promise<WorkspaceHookReviewCommandResult> {
  const policy = input.coordinator.getPolicy(input.snapshot.workspaceIdentity);
  if (policy.mode !== "user_decides") {
    // 策略只读：被预信任/阻断的工作区不允许从面板撤销，避免绕过管理策略。
    return {
      accepted: false,
      reasonCode:
        policy.mode === "allow_trusted_only"
          ? "workspace_hooks_policy_requires_pretrust"
          : "workspace_hooks_blocked_by_policy",
    };
  }
  try {
    // 先落库拿到权威记录集，再用它整体替换内存表：避免两边各自增量删除后出现漂移。
    const file = await (
      await input.store
    ).revoke({
      workspaceIdentity: input.snapshot.workspaceIdentity,
      hookDeclarationDigests: input.digests,
    });
    input.coordinator.replacePersistentTrustRecords(file.records, { status: "ok" });
    // 持久记录先就位，再撤销本进程内的即时信任；反序会让下次检查读到尚未更新的内存状态。
    input.coordinator.revoke({
      workspaceIdentity: input.snapshot.workspaceIdentity,
      hookDeclarationDigests: input.digests,
    });
    return { accepted: true, reviewItemIds: [...input.reviewItemIds] };
  } catch {
    return { accepted: false, reasonCode: "workspace_hooks_trust_store_corrupt" };
  }
}
