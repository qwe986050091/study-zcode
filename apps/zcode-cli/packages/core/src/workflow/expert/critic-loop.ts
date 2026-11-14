/**
 * ============================================================================
 * workflow/expert/critic-loop.ts —— final_critic 阶段：验收评审与打回重做
 * ============================================================================
 *
 * 【定位】critic 阶段不是"再跑一次 agent"，而是一个验收循环：
 *   1) 跑 critic 子会话（用 buildPhasePrompt，要求返回 JSON verdict）；
 *   2) verdict=pass → 发 critic_passed，阶段结束，run 继续收尾；
 *   3) verdict=fail → 发 critic_failed；若给出 reopenProposals，则把对应节点
 *      重开（每节点 reopenAttempts 预算 2 次），然后重置 exec 与 final_critic
 *      两个阶段为 pending，重跑 exec，进入下一轮；
 *   4) 迭代次数由 strategy.finalCritic.maxIterations 限制（默认 3）。
 *
 * 【终止条件（按发生顺序）】
 *   - critic 判定 pass → 立即返回快照；
 *   - critic 判 fail 但没有任何可重开提案 → 直接返回（不再重跑，也不会把阶段标 failed）；
 *   - 所有提案都被 lifecycle 拒绝（预算耗尽/状态不可重开）→ 返回；
 *   - 迭代耗尽 → 把 final_critic 置 failed 并发 critic_iteration_limit_reached。
 *     注意此处不抛错：continueRun 不会被中断，后续 complete 阶段仍会写报告。
 *
 * 【进度事件顺序】critic_started → （每轮）critic_passed | critic_failed →
 * [node_reopened + reopen_node 图记录] → 重新进入下一轮 critic_started。
 * 事件先写 events 账本、后回调 onWorkflowEvent（见 runtime-context.appendEvent）。
 * ============================================================================
 */

import type {
  ExpertWorkflowRunSnapshot,
  WorkflowCriticReopenProposal,
  WorkflowPhaseDefinition,
} from "@zcode/contracts";
import { reopenWorkflowGraphNode } from "../lifecycle.js";
import { phaseNodeId } from "./ids.js";
import { dedupeReopenProposals, parseCriticResult } from "./parsers/critic.js";
import type { ExpertWorkflowRuntimeContext } from "./runtime-context.js";
import type { ExpertWorkflowRunOptions } from "./types.js";
import { runPhase } from "./phase-runner.js";
import { runScheduledPhase } from "./scheduled-phase.js";

/**
 * 执行 final_critic 验收循环。
 *
 * 输入：runtime ctx、进入 critic 时的快照、critic 阶段定义、run 参数。
 * 输出：循环结束后的最新快照（多数路径 phase 已 completed；迭代耗尽时 failed）。
 * 副作用：写快照、追加 graph 记录（update_status/reopen_node）、追加 workflow 事件，
 * 以及通过 runPhase/runScheduledPhase 启动子会话。所有写入都带 abortSignal。
 *
 * 失败语义：critic 响应解析失败会由 parseCriticResult 抛错，向上冒泡到 continueRun
 * （最终转为 paused 失败，而不是静默算 pass）——"无法判定"绝不能当作通过。
 */
export async function runFinalCriticLoop(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  definition: WorkflowPhaseDefinition,
  options: ExpertWorkflowRunOptions,
): Promise<ExpertWorkflowRunSnapshot> {
  let current = snapshot;
  // critic 打回必须能重跑"执行阶段"，所以先定位 scheduled_graph 阶段定义；
  // 定义缺失属于装配错误（无法完成重做），直接抛错而不是假装通过。
  const execDefinition = ctx.definition.phases.find(
    (phaseDefinition) => phaseDefinition.behavior === "scheduled_graph",
  );
  if (!execDefinition) {
    throw new Error(`${ctx.definition.title} definition is missing a scheduled graph phase`);
  }

  // 迭代预算读自快照里的 strategy（已持久化），恢复后仍使用同一预算，不会因代码
  // 默认值变化在 resume 时多跑几轮。
  for (let iteration = 1; iteration <= current.strategy.finalCritic.maxIterations; iteration++) {
    await ctx.appendEvent(current.runId, "critic_started", {
      message: `Final critic iteration ${iteration} started.`,
      payload: { iteration },
      phase: definition.phase,
      signal: options.abortSignal,
    });

    const phaseRun = await runPhase(ctx, current, definition, options);
    current = phaseRun.snapshot;
    // 解析失败会抛错（而不是当成 pass）：verdict 无法确认时宁可让 run paused，
    // 也不能把"模型没按格式回答"误判为验收通过。
    const critic = parseCriticResult(phaseRun.response);

    if (critic.verdict === "pass") {
      await ctx.appendEvent(current.runId, "critic_passed", {
        message: critic.reasoning || `Final critic iteration ${iteration} passed.`,
        payload: {
          acceptanceGaps: critic.acceptanceGaps,
          iteration,
        },
        phase: definition.phase,
        signal: options.abortSignal,
      });
      return current;
    }

    const reopenProposals = dedupeReopenProposals(critic.reopenProposals);
    await ctx.appendEvent(current.runId, "critic_failed", {
      message: critic.reasoning || `Final critic iteration ${iteration} failed.`,
      payload: {
        acceptanceGaps: critic.acceptanceGaps,
        iteration,
        reopenProposals,
      },
      phase: definition.phase,
      signal: options.abortSignal,
    });

    if (reopenProposals.length === 0) {
      // 判 fail 却没给可执行的重开提案：已无可重做目标，只能返回现状。
      // 这里刻意不改阶段状态（阶段本轮已 completed），避免把"判不通过"写成 failed
      // 从而触发恢复 UI 的重试动作。
      return current;
    }

    const reopenedNodeIds: string[] = [];
    // 逐个提案尝试重开：单个节点被预算拒绝只影响它自己，不终止整轮；
    // 只要有任一节点成功重开，就值得重跑执行阶段。
    for (const proposal of reopenProposals) {
      const reopen = await tryReopenCriticNode(
        ctx,
        current,
        proposal,
        iteration,
        definition.phase,
        options.abortSignal,
      );
      if (!reopen) continue;
      current = reopen.snapshot;
      reopenedNodeIds.push(proposal.nodeId);
      await ctx.store.writeSnapshot(current, { signal: options.abortSignal });
      await appendGraphReopen(
        ctx,
        current,
        proposal,
        iteration,
        reopen.reopenAttempts,
        definition.phase,
        options.abortSignal,
      );
      await ctx.appendEvent(current.runId, "node_reopened", {
        message: `Node reopened by final critic: ${proposal.nodeId}`,
        nodeId: proposal.nodeId,
        payload: {
          iteration,
          reason: proposal.reason,
          reopenAttempts: reopen.reopenAttempts,
          severity: proposal.severity,
        },
        phase: definition.phase,
        signal: options.abortSignal,
      });
    }

    if (reopenedNodeIds.length === 0) {
      // 提案全被拒（典型原因：node 不存在、状态不是 completed/failed/skipped、
      // 或 reopenAttempts 已达上限 2）：没有可重跑目标，结束循环但不判失败。
      return current;
    }

    const retryReason = `Final critic reopened node(s): ${reopenedNodeIds.join(", ")}`;
    // 同时重置 exec 与 final_critic：exec 需要重新跑被重开的节点，critic 需要重新评审；
    // 两者置 pending 后由下面的 runScheduledPhase 与下一轮 runPhase 各自推进。
    current = resetPhaseForRetry(ctx, current, execDefinition.phase, retryReason);
    current = resetPhaseForRetry(ctx, current, definition.phase, retryReason);
    await ctx.store.writeSnapshot(current, { signal: options.abortSignal });
    await ctx.appendGraphStatus(current, execDefinition.phase, "pending", options.abortSignal);
    await ctx.appendGraphStatus(current, definition.phase, "pending", options.abortSignal);
    current = await runScheduledPhase(ctx, current, execDefinition, options);
  }

  // 迭代耗尽：把 critic 阶段标记失败并说明原因，让报告与 UI 能看到"未通过验收"。
  // 注意此处不抛错，continueRun 会继续走到 complete 阶段写报告（run 不会被置 failed）。
  current = ctx.updatePhase(current, definition.phase, {
    completedAt: ctx.timestamp(),
    error: "Final critic iteration limit reached.",
    status: "failed",
  });
  await ctx.store.writeSnapshot(current, { signal: options.abortSignal });
  await ctx.appendGraphStatus(current, definition.phase, "failed", options.abortSignal);
  await ctx.appendEvent(current.runId, "critic_iteration_limit_reached", {
    message: "Final critic iteration limit reached.",
    payload: { maxIterations: current.strategy.finalCritic.maxIterations },
    phase: definition.phase,
    signal: options.abortSignal,
  });
  return current;
}

/**
 * 尝试重开一个被 critic 点名的节点。
 *
 * 重开预算硬编码 maxReopens=2（与 lifecycle 的默认值一致）：同一节点最多被打回
 * 两次，防止 critic 与执行阶段形成无限来回。
 * 返回 null 表示"不可重开"——lifecycle 会因状态不合法或预算耗尽抛错，本函数把它
 * 转成一条 critic_failed(rejected=true) 事件后吞掉，避免单点问题中断整轮评审。
 * 副作用：成功时返回新快照（尚未落盘），失败时仅追加事件。
 */
async function tryReopenCriticNode(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  proposal: WorkflowCriticReopenProposal,
  iteration: number,
  phase: string,
  signal?: AbortSignal,
): Promise<{ reopenAttempts: number; snapshot: ExpertWorkflowRunSnapshot } | null> {
  try {
    const result = reopenWorkflowGraphNode(snapshot, {
      maxReopens: 2,
      nodeId: proposal.nodeId,
      reason: proposal.reason,
      timestamp: ctx.timestamp(),
    });
    return {
      reopenAttempts: result.reopenAttempts,
      snapshot: result.snapshot,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 被拒绝的重开也要留痕：payload.rejected 让 UI 区分"critic 判失败"与"重开未执行"。
    await ctx.appendEvent(snapshot.runId, "critic_failed", {
      message: `Critic reopen rejected for ${proposal.nodeId}: ${message}`,
      payload: {
        iteration,
        nodeId: proposal.nodeId,
        reason: proposal.reason,
        rejected: true,
      },
      phase,
      signal,
    });
    return null;
  }
}

/**
 * 把某个阶段重置为 pending，供重跑使用。
 *
 * 只改 phase 节点（kind=phase 且 id=phase:<phase>）与 phases 条目，error 写入
 * 重跑原因以便追溯；不动其他节点、artifact 与 activity（历史产物保留）。
 * 纯函数，返回新快照，不落盘（由调用方统一 writeSnapshot）。
 */
function resetPhaseForRetry(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  phase: string,
  reason: string,
): ExpertWorkflowRunSnapshot {
  return {
    ...snapshot,
    currentPhase: phase,
    graph: {
      collections: snapshot.graph.collections,
      edges: snapshot.graph.edges,
      nodes: snapshot.graph.nodes.map((node) =>
        node.id === phaseNodeId(phase) && node.kind === "phase"
          ? {
              ...node,
              error: reason,
              status: "pending" as const,
            }
          : node,
      ),
    },
    phases: snapshot.phases.map((item) =>
      item.phase === phase
        ? {
            error: reason,
            phase,
            status: "pending" as const,
          }
        : item,
    ),
    updatedAt: ctx.timestamp(),
  };
}

/**
 * 追加一条 reopen_node 图记录（recordType=op）。
 *
 * 与 node_reopened 事件互补：事件给 UI/人看，图记录用于恢复时重放节点状态；
 * 因此顺序要求先写快照、再写记录、最后发事件（调用方已按此顺序执行）。
 */
async function appendGraphReopen(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  proposal: WorkflowCriticReopenProposal,
  iteration: number,
  reopenAttempts: number,
  phase: string,
  signal?: AbortSignal,
): Promise<void> {
  await ctx.store.appendGraphRecord(
    snapshot.runId,
    {
      nodeId: proposal.nodeId,
      payload: {
        iteration,
        reason: proposal.reason,
        reopenAttempts,
        severity: proposal.severity,
      },
      phase,
      recordType: "op",
      runId: snapshot.runId,
      status: "pending",
      timestamp: ctx.timestamp(),
      type: "reopen_node",
    },
    { signal },
  );
}
