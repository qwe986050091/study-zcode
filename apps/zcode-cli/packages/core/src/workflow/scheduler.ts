/**
 * ============================================================================
 * workflow/scheduler.ts —— 图调度器（DAG 执行循环）
 * ============================================================================
 *
 * 【定位】按快照里的 strategy.executor 并发上限与连续错误上限，反复：
 *   - 计算 ready 节点 → 启动 runner（子会话）；
 *   - 等待任一节点结算 → 写快照/发事件 → 重新计算 frontier；
 *   - 连续错误达到上限则停止派发（但已在跑的节点继续收尾）。
 *
 * 【恢复优先】run() 一开始先 reconcileWorkflowSnapshotForResume：把旧进程
 * 留下的 active 节点重置为可重放，然后才进入调度循环。否则新进程会误以为
 * 那些节点还在跑。
 *
 * 【并发与收敛】maxConcurrentLoops 至少 1；frontierTarget 决定"保持多少个
 * 就绪节点在飞"；maxConsecutiveErrors 是"连续失败"而不是总失败数——
 * 一次成功会清零计数，避免长任务因历史偶发失败被永久停止。
 *
 * 【事件与快照】所有状态变化都经 WorkflowSchedulerEventLog + writeSnapshot，
 * 保证 UI/恢复看到的是同一份事实；派发本身不做业务判断（提示词/阶段由
 * collection-planner 与 node-runner 负责）。
 * ============================================================================
 */

import { reconcileWorkflowSnapshotForResume } from "./lifecycle.js";
import { checkCollectionPlanners } from "./scheduler/collection-planner.js";
import type { WorkflowCollectionPlannerRuntime } from "./scheduler/collection-runtime.js";
import { WorkflowSchedulerEventLog } from "./scheduler/events.js";
import {
  areExecutableNodesComplete,
  blockedExecutableNodes,
  orderedReadyExecutableNodes,
  readyExecutableNodes,
} from "./scheduler/graph.js";
import { runWorkflowNode, type WorkflowNodeRunnerRuntime } from "./scheduler/node-runner.js";
import type {
  WorkflowGraphSchedulerDeps,
  WorkflowGraphSchedulerRunOptions,
  WorkflowGraphSchedulerRunResult,
  WorkflowSchedulerNodePromise,
} from "./scheduler/types.js";

export { deriveWorkflowRunSchedulerState, deriveWorkflowSchedulerState } from "@zcode/contracts";
export type { WorkflowSchedulerDerivedNode, WorkflowSchedulerState } from "@zcode/contracts";
export type {
  WorkflowGraphSchedulerActivityInput,
  WorkflowGraphSchedulerActivityResult,
  WorkflowGraphSchedulerChildSessionStartedEvent,
  WorkflowGraphSchedulerDeps,
  WorkflowGraphSchedulerPlannerInput,
  WorkflowGraphSchedulerPlannerRunner,
  WorkflowGraphSchedulerPlannerRunResult,
  WorkflowGraphSchedulerRunOptions,
  WorkflowGraphSchedulerRunResult,
  WorkflowGraphSchedulerRunner,
} from "./scheduler/types.js";

/**
 * DAG 调度器：在 strategy.executor 的并发/错误上限内反复派发 ready 节点。
 * 输入 deps（runner/planner/writeSnapshot/eventLog 等）与 run options（快照/phase/abort）；
 * 输出 { status: completed|paused, reason, snapshot }。
 * 副作用：写快照、发调度事件、启动子会话（经注入 deps）。
 * 失败语义：中止信号抛错；连续错误达上限或 pending 全阻塞时暂停而非崩溃。
 * 不变量：一个节点同时最多一条 active promise；连续错误在成功结算后清零。
 */
export class WorkflowGraphScheduler {
  private readonly createActivityId: () => string;
  private readonly eventLog: WorkflowSchedulerEventLog;
  private readonly plannerRunner?: WorkflowGraphSchedulerDeps["plannerRunner"];
  private readonly runner: WorkflowGraphSchedulerDeps["runner"];
  private readonly writeArtifact: WorkflowGraphSchedulerDeps["writeArtifact"];
  private readonly writeSnapshot: WorkflowGraphSchedulerDeps["writeSnapshot"];

  /** 保存依赖并构造事件日志；不触发 I/O，run() 才写快照。 */
  constructor(deps: WorkflowGraphSchedulerDeps) {
    this.createActivityId = deps.createActivityId;
    this.eventLog = new WorkflowSchedulerEventLog(deps);
    this.plannerRunner = deps.plannerRunner;
    this.runner = deps.runner;
    this.writeArtifact = deps.writeArtifact;
    this.writeSnapshot = deps.writeSnapshot;
  }

  /**
   * 执行调度循环直到完成、暂停或中止。
   * 调度条件：ready 且未 active 的节点按 orderedReadyExecutableNodes 顺序派发，
   * 同时活跃数不超过 maxConcurrentLoops；planner 每轮可新增节点并扩容可执行集合。
   * 重试口径：maxConsecutiveErrors 统计"连续失败"，任一成功结算清零；
   * 达到上限后先等在飞节点收尾，再返回 paused/error_threshold，不重试已失败节点。
   * 终止条件：所有可执行节点完成且无在飞 → completed；
   * 无 ready、无 active 且未完成 → deadlock 暂停；abortSignal 触发则抛错。
   * 进度事件：frontier_changed（ready/active/blocked 变化时）、
   * executor_completed / executor_paused；所有状态变化同步写快照。
   */
  async run(options: WorkflowGraphSchedulerRunOptions): Promise<WorkflowGraphSchedulerRunResult> {
    const executableNodeIds = new Set(
      options.executableNodeIds ?? options.snapshot.graph.nodes.map((node) => node.id),
    );
    const resumeRepair = reconcileWorkflowSnapshotForResume(options.snapshot, {
      nodeIds: executableNodeIds,
      resetPhases: false,
      timestamp: this.eventLog.timestamp(),
    });
    let snapshot = resumeRepair.snapshot;
    if (resumeRepair.changed) {
      await this.writeSnapshot(snapshot, { signal: options.abortSignal });
    }

    const maxConcurrent = Math.max(1, snapshot.strategy.executor.maxConcurrentLoops);
    const maxConsecutiveErrors = Math.max(1, snapshot.strategy.executor.maxConsecutiveErrors);
    const active = new Map<string, WorkflowSchedulerNodePromise>();
    let consecutiveErrors = 0;
    let frontierKey = "";

    while (true) {
      throwIfAborted(options.abortSignal);
      const plannerResult = await checkCollectionPlanners(
        snapshot,
        executableNodeIds,
        options,
        this.collectionPlannerRuntime(),
      );
      snapshot = plannerResult.snapshot;
      for (const nodeId of plannerResult.addedNodeIds) {
        executableNodeIds.add(nodeId);
      }
      if (plannerResult.plannersRan > 0) {
        frontierKey = "";
      }

      frontierKey = await this.emitFrontierChangedIfNeeded(
        snapshot,
        executableNodeIds,
        frontierKey,
        options.abortSignal,
      );

      if (
        areExecutableNodesComplete(
          snapshot.graph,
          executableNodeIds,
          Boolean(this.plannerRunner),
        ) &&
        active.size === 0
      ) {
        await this.eventLog.emitEvent(snapshot, "executor_completed", {
          message: `${options.phase} scheduler completed.`,
          phase: options.phase,
          signal: options.abortSignal,
        });
        return { reason: "completed", snapshot, status: "completed" };
      }

      if (consecutiveErrors >= maxConsecutiveErrors) {
        if (active.size > 0) {
          await Promise.all(active.values());
          active.clear();
        }
        await this.eventLog.emitEvent(snapshot, "executor_paused", {
          message: `${options.phase} scheduler paused after ${consecutiveErrors} consecutive node error(s).`,
          payload: { consecutiveErrors },
          phase: options.phase,
          signal: options.abortSignal,
        });
        return { reason: "error_threshold", snapshot, status: "paused" };
      }

      const readyNodes = orderedReadyExecutableNodes(snapshot.graph, executableNodeIds).filter(
        (node) => !active.has(node.id),
      );
      let dispatched = 0;
      for (const node of readyNodes) {
        if (active.size >= maxConcurrent) break;
        const promise = runWorkflowNode(
          {
            getSnapshot: () => snapshot,
            setSnapshot: (nextSnapshot) => {
              snapshot = nextSnapshot;
              return nextSnapshot;
            },
          },
          node,
          options,
          maxConsecutiveErrors,
          this.nodeRunnerRuntime(),
        );
        active.set(node.id, promise);
        snapshot = (await promise.started).snapshot;
        dispatched++;
      }

      if (dispatched > 0) continue;

      if (active.size > 0) {
        const outcome = await Promise.race(active.values());
        active.delete(outcome.nodeId);
        consecutiveErrors = outcome.ok ? 0 : consecutiveErrors + 1;
        continue;
      }

      await this.eventLog.emitEvent(snapshot, "executor_paused", {
        message: `${options.phase} scheduler paused because pending nodes are blocked.`,
        payload: {
          blockedNodes: blockedExecutableNodes(snapshot.graph, executableNodeIds),
        },
        phase: options.phase,
        signal: options.abortSignal,
      });
      return { reason: "deadlock", snapshot, status: "paused" };
    }
  }

  /** 组装 planner 运行时端口：共享事件日志、活动 ID、快照写入等能力。 */
  private collectionPlannerRuntime(): WorkflowCollectionPlannerRuntime {
    return {
      createActivityId: this.createActivityId,
      eventLog: this.eventLog,
      plannerRunner: this.plannerRunner,
      writeArtifact: this.writeArtifact,
      writeSnapshot: this.writeSnapshot,
    };
  }

  /** 组装节点 runner 运行时端口：共享事件日志、活动 ID 与写盘能力。 */
  private nodeRunnerRuntime(): WorkflowNodeRunnerRuntime {
    return {
      createActivityId: this.createActivityId,
      eventLog: this.eventLog,
      runner: this.runner,
      writeArtifact: this.writeArtifact,
      writeSnapshot: this.writeSnapshot,
    };
  }

  /**
   * frontier 未变化时跳过事件；key 由 ready/active/blocked 三类节点 ID 组成。
   * 输入快照与上一 key，输出新 key；仅在有变化时发事件。
   */
  private async emitFrontierChangedIfNeeded(
    snapshot: WorkflowGraphSchedulerRunResult["snapshot"],
    executableNodeIds: Set<string>,
    previousKey: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const readyNodeIds = readyExecutableNodes(snapshot.graph, executableNodeIds).map(
      (node) => node.id,
    );
    const activeNodeIds = snapshot.graph.nodes
      .filter((node) => executableNodeIds.has(node.id) && node.status === "active")
      .map((node) => node.id);
    const blockedNodes = blockedExecutableNodes(snapshot.graph, executableNodeIds);
    const nextKey = JSON.stringify({ activeNodeIds, blockedNodes, readyNodeIds });
    if (nextKey === previousKey) return previousKey;
    await this.eventLog.emitEvent(snapshot, "frontier_changed", {
      message: "Workflow scheduler frontier changed.",
      payload: { activeNodeIds, blockedNodes, readyNodeIds },
      signal,
    });
    return nextKey;
  }
}

/**
 * 中止口径：abortSignal 已触发时抛其 reason（非 Error 则包成 Error）。
 * 在每轮循环开头调用，保证取消不会继续派发新节点。
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Workflow scheduler aborted");
}
