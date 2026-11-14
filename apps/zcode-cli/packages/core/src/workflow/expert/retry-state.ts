/**
 * ============================================================================
 * workflow/expert/retry-state.ts —— retry 命令的快照预处理（纯内存变换）
 * ============================================================================
 *
 * 【定位】把"失败/暂停的 run"整理成"可以从头重放的 running run"：重置目标
 * 节点与阶段、清掉失败/恢复动作、重算 sessionLinks。本文件不写 store，落盘与
 * 事件由 runtime.retry 统一负责（保证"先算好再一次性写入"）。
 *
 * 【调度范围口径】显式 nodeId 精确重放单节点；否则按 phase（参数 > activity >
 * 快照 failure 的 phase > currentPhase）选取该阶段内所有 failed/active 节点；若连
 * phase 都推不出来，则只依赖 reconcile 修复"旧进程遗留的 active"节点。
 *
 * 【不变量】重试只重置范围内的节点，completed 历史节点保持不变；reconcile 的
 * 修复结果与本次重置合并去重（同一 nodeId 保留最后一次变更，即 pending）。
 * ============================================================================
 */

import { deriveWorkflowSessionLinks, type ExpertWorkflowRunSnapshot } from "@zcode/contracts";
import { reconcileWorkflowSnapshotForResume, type WorkflowGraphNodeChange } from "../lifecycle.js";
import { phaseNodeId } from "./ids.js";
import { dedupeWorkflowNodeChanges, type ExpertWorkflowRuntimeContext } from "./runtime-context.js";
import type { ExpertWorkflowRetryOptions } from "./types.js";

/**
 * 生成重试用的新快照与图变更清单。
 *
 * 输入：runtime 上下文（提供时钟）、当前快照、范围参数（activityId/nodeId/phase）。
 * 输出 { nodeChanges, snapshot }：nodeChanges 是"需要追加的 update_status 图记录"，
 * snapshot 是待写入的新事实（status 已置 running、failure/pauseReason 已清空）。
 *
 * 副作用：无（纯函数；只读 ctx.timestamp）。失败语义：不抛错——单节点/阶段找不到
 * 时按"范围为空"处理，交给 reconcile 兜底，由后续调度决定是否 deadlock。
 */
export function prepareSnapshotForRetry(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  options: Pick<ExpertWorkflowRetryOptions, "activityId" | "nodeId" | "phase">,
): {
  nodeChanges: WorkflowGraphNodeChange[];
  snapshot: ExpertWorkflowRunSnapshot;
} {
  const timestamp = ctx.timestamp();
  // activityId 只在用户从某个具体活动点"Retry"时传入；找不到就当作没指定。
  const activity = options.activityId
    ? snapshot.activities.find((entry) => entry.activityId === options.activityId)
    : undefined;
  // phase 的三级回退：显式参数 > 该活动所属阶段 > 快照失败事实 > 当前阶段。
  const phase =
    options.phase ?? activity?.phase ?? snapshot.failure?.phase ?? snapshot.currentPhase;
  // nodeId 只认显式参数或活动/失败事实，不从阶段推断。
  const nodeId = options.nodeId ?? activity?.nodeId ?? snapshot.failure?.nodeId;
  // 范围决定"哪些失败会被清除"：精确单节点，或该阶段内失败/进行中的节点集合。
  const nodeScope = nodeId
    ? new Set([nodeId])
    : new Set(
        snapshot.graph.nodes
          .filter((node) => !phase || node.phase === phase || node.id === phaseNodeId(phase))
          .filter((node) => node.status === "failed" || node.status === "active")
          .map((node) => node.id),
      );
  // 先让 lifecycle 修复"旧进程遗留的 active"（否则重放后会与幽灵节点并存）；
  // 限定 nodeIds 可以避免动到范围之外仍在别处活跃的节点。
  const resumeRepair = reconcileWorkflowSnapshotForResume(snapshot, {
    nodeIds: nodeScope.size > 0 ? nodeScope : undefined,
    timestamp,
  });
  const nodeChanges = [...resumeRepair.nodeChanges];
  // 把范围内的 failed/active 节点统一改回 pending：重试的语义就是"这些节点还没做完"。
  const resetNodes = resumeRepair.snapshot.graph.nodes.map((node) => {
    if (!nodeScope.has(node.id) || (node.status !== "failed" && node.status !== "active")) {
      return node;
    }
    nodeChanges.push({
      nodeId: node.id,
      phase: node.phase,
      status: "pending",
    });
    return {
      ...node,
      error: undefined,
      status: "pending" as const,
    };
  });
  // 阶段也只在 failed/active 时重置；completed 阶段与其产物保持原样（重试不抹历史）。
  const resetPhases = resumeRepair.snapshot.phases.map((entry) => {
    if (
      phase &&
      entry.phase === phase &&
      (entry.status === "failed" || entry.status === "active")
    ) {
      // 只保留 phase/status/error/completedAt 四项：activity/session/trace 关联随重放
      // 会重新建立，旧值留着会让 UI 指向已废弃的子会话；artifact 仍在 snapshot.artifacts。
      return {
        ...entry,
        completedAt: undefined,
        error: undefined,
        status: "pending" as const,
      };
    }
    return entry;
  });
  return {
    // 同一节点可能先被 reconcile 改成 pending、又被本次重置改成 pending：只保留最后一条。
    nodeChanges: dedupeWorkflowNodeChanges(nodeChanges),
    snapshot: {
      ...resumeRepair.snapshot,
      failure: undefined,
      graph: {
        collections: resumeRepair.snapshot.graph.collections,
        edges: resumeRepair.snapshot.graph.edges,
        nodes: resetNodes,
      },
      pauseReason: undefined,
      phases: resetPhases,
      // 恢复动作是"针对上一次失败"的候选，重试开始后必须清空，避免 UI 显示过期按钮。
      recoveryActions: [],
      // sessionLinks 由 activities 重新派生（重放会新增 activity，不能沿用旧链接）。
      sessionLinks: deriveWorkflowSessionLinks({
        activities: resumeRepair.snapshot.activities,
        runId: resumeRepair.snapshot.runId,
      }),
      status: "running",
      updatedAt: timestamp,
    },
  };
}
