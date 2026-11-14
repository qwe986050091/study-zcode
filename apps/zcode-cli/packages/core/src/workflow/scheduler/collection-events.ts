import type { WorkflowGraphCollection, WorkflowRunSnapshot } from "@zcode/contracts";
import type { WorkflowCollectionPlannerRuntime } from "./collection-runtime.js";
import { edgeId, updateGraphCollection } from "./graph.js";
import type {
  AppliedPlannerExpansion,
  SchedulerCollection,
  WorkflowGraphSchedulerRunOptions,
} from "./types.js";

/**
 * ============================================================================
 * workflow/scheduler/collection-events.ts —— 集合扩张/耗尽的进度事件
 * ============================================================================
 *
 * 【定位】collection-planner 完成一轮扩张或决定关闭集合时，把结果广播成事件。
 * 事件经 eventLog.emitEvent 走 appendEvent（持久化）再回调 onWorkflowEvent，
 * 消费方是 UI 与恢复链路的监听者；本文件不修改快照，除非调用方显式要求。
 *
 * 【顺序】同一次扩张先发 graph_expanded（若有新增节点/边），再发
 * collection_exhausted（若本轮判定耗尽）；两者不可调换，否则消费方会先看到
 * 集合关闭、后看到最后一轮新增。
 * ============================================================================
 */

/**
 * 广播一轮 planner 扩张的进度事件（只读快照，不落库快照）。
 * 仅当 addedNodes 或 addedEdges 非空时才发 graph_expanded，payload 用节点 id
 * 与 from->to 边 id 描述增量；随后若集合已 exhausted 再发 collection_exhausted。
 * 副作用是追加事件与触发 onWorkflowEvent 回调；abortSignal 透传给底层 I/O。
 */
export async function emitExpansionEvents(
  snapshot: WorkflowRunSnapshot,
  expansion: AppliedPlannerExpansion,
  collectionId: string,
  options: WorkflowGraphSchedulerRunOptions,
  runtime: WorkflowCollectionPlannerRuntime,
): Promise<void> {
  if (expansion.addedNodes.length > 0 || expansion.addedEdges.length > 0) {
    await runtime.eventLog.emitEvent(snapshot, "graph_expanded", {
      message: `Graph expanded for collection: ${collectionId}`,
      payload: {
        collectionId,
        edgeIds: expansion.addedEdges.map(edgeId),
        nodeIds: expansion.addedNodes.map((node) => node.id),
      },
      phase: options.phase,
      signal: options.abortSignal,
    });
  }
  if (expansion.collection.exhausted || expansion.collection.status === "exhausted") {
    await runtime.eventLog.emitEvent(snapshot, "collection_exhausted", {
      message: `Collection exhausted: ${collectionId}`,
      payload: { collectionId },
      phase: options.phase,
      signal: options.abortSignal,
    });
  }
}

/**
 * 强制关闭一个集合（达到 planner 轮数上限或连续错误阈值时由调度器调用）。
 * 输入：当前快照、集合、运行选项、运行时与原因 payload；输出：已持久化的新快照。
 * 步骤固定为"更新集合 → 写快照 → 追加集合记录 → 发 collection_exhausted"，
 * 保证恢复与 UI 看到的是同一条事实链。
 * 幂等性：重复调用只会把已 exhausted 的集合再写一遍；不变量是 exhausted 与
 * status="exhausted" 必须同时置位。
 */
export async function exhaustCollection(
  snapshot: WorkflowRunSnapshot,
  collection: SchedulerCollection,
  options: WorkflowGraphSchedulerRunOptions,
  runtime: WorkflowCollectionPlannerRuntime,
  payload: Record<string, unknown>,
): Promise<WorkflowRunSnapshot> {
  const exhaustedCollection: WorkflowGraphCollection = {
    ...collection,
    exhausted: true,
    status: "exhausted",
  };
  const exhaustedSnapshot = updateGraphCollection(
    snapshot,
    collection.collectionId,
    exhaustedCollection,
    runtime.eventLog.timestamp(),
  );
  await runtime.writeSnapshot(exhaustedSnapshot, { signal: options.abortSignal });
  await runtime.eventLog.appendCollectionRecord(
    exhaustedSnapshot,
    exhaustedCollection,
    options.abortSignal,
  );
  await runtime.eventLog.emitEvent(exhaustedSnapshot, "collection_exhausted", {
    message: `Collection exhausted: ${collection.collectionId}`,
    payload: {
      collectionId: collection.collectionId,
      ...payload,
    },
    phase: options.phase,
    signal: options.abortSignal,
  });
  return exhaustedSnapshot;
}
