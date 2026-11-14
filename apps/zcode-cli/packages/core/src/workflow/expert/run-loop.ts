/**
 * ============================================================================
 * workflow/expert/run-loop.ts —— run 的主推进循环（阶段顺序执行器）
 * ============================================================================
 *
 * 【定位】expert 工作流的总调度：按 definition.phaseOrder 顺序，把已
 * completed 的阶段跳过，逐个交给对应行为的执行器（scheduled_graph → scheduler、
 * critic → 验收循环、agent → 单子会话、complete → 写报告并结束）。
 * start/resume/retry/startBackground 都汇聚到这里的 continueRun。
 *
 * 【派发条件】只有"轮到该阶段且尚未 completed"才执行；agent 阶段结束后还会用
 * 产物去播种执行图 / 更新节点 prompt（解析失败按阶段失败处理，不静默忽略）。
 *
 * 【失败语义（catch 分支）】
 *   - 外部 abort：已 cancelled 则原样返回；否则用 cancelWorkflowSnapshot 落盘
 *     cancelled 并发 run_cancelled，绝不把取消写成 paused。
 *   - 其他错误：读最新快照后置 paused，写入 WorkflowFailure + recoveryActions，
 *     发 workflow_paused，并把错误文本拼进 response（不向调用方抛错）。
 *
 * 【进度事件】run_started/run_completed/run_cancelled/workflow_paused 由本文件与
 * runtime 发出；阶段/节点级事件由 phase-runner、scheduled-phase、critic-loop 发。
 * ============================================================================
 */

import { cancelWorkflowSnapshot } from "../lifecycle.js";
import { runFinalCriticLoop } from "./critic-loop.js";
import {
  latestWorkflowActivity,
  workflowFailureFromError,
  workflowRecoveryActions,
} from "./failures.js";
import { formatExpertWorkflowCompletion, formatExpertWorkflowStatus } from "./formatters.js";
import {
  seedGraphFromPhaseArtifact,
  updateNodePromptsFromPhaseArtifact,
} from "./graph-artifacts.js";
import { compactWorkflowPayload, lifecyclePayload } from "./runtime-context.js";
import type { ExpertWorkflowRuntimeContext } from "./runtime-context.js";
import { runPhase } from "./phase-runner.js";
import { buildReport } from "./prompts.js";
import { runScheduledPhase } from "./scheduled-phase.js";
import type { ExpertWorkflowCommandResult, ExpertWorkflowRunOptions } from "./types.js";
import type { ExpertWorkflowRunSnapshot, WorkflowPhaseDefinition } from "@zcode/contracts";

/**
 * 从给定快照继续推进 run，直到 complete/失败/paused。
 *
 * 输入：runtime ctx、初始快照（可能来自 start/resume/retry，状态各异）、run 参数。
 * 输出：命令结果（response 已完成快照的投影，status 取自快照）。
 * 副作用：大量快照/事件/图记录写入，并启动多个子会话；全部透传 abortSignal。
 *
 * 不变量：进入时先把状态改为 running（startedAt 只补一次）；已 completed 的阶段
 * 永不重复执行，因此 resume/retry 是幂等的推进而不是重跑全流程。
 * 失败语义：本函数不向上抛错——所有异常都被归并为 cancelled 或 paused 结果。
 */
export async function continueRun(
  ctx: ExpertWorkflowRuntimeContext,
  initialSnapshot: ExpertWorkflowRunSnapshot,
  options: ExpertWorkflowRunOptions,
): Promise<ExpertWorkflowCommandResult> {
  let snapshot = ctx.updateSnapshot(initialSnapshot, {
    startedAt: initialSnapshot.startedAt ?? ctx.timestamp(),
    status: "running",
  });

  try {
    for (const phaseId of ctx.definition.phaseOrder) {
      const phaseDefinition = ctx.getPhaseDefinition(phaseId);
      if (phaseDefinition.behavior === "complete") {
        // complete 是收尾动作而非"执行阶段"：写报告、置 completed 后立即结束循环，
        // 不能继续遍历（phaseOrder 约定 complete 为最后一项）。
        snapshot = await completeRun(ctx, snapshot, phaseDefinition, options.abortSignal);
        break;
      }

      const phase = snapshot.phases.find((item) => item.phase === phaseDefinition.phase);
      // 恢复/重试后重新进入时，已完成的阶段直接跳过，避免重复消耗子会话与覆盖产物。
      if (phase?.status === "completed") continue;
      switch (phaseDefinition.behavior) {
        case "scheduled_graph":
          snapshot = await runScheduledPhase(ctx, snapshot, phaseDefinition, options);
          break;
        case "critic":
          snapshot = await runFinalCriticLoop(ctx, snapshot, phaseDefinition, options);
          break;
        case "agent": {
          const phaseRun = await runPhase(ctx, snapshot, phaseDefinition, options);
          snapshot = phaseRun.snapshot;
          // agent 阶段产物可能同时驱动两件事：给目标阶段播种图、给已有节点改 prompt。
          // 两个函数内部各自判断 definition 是否声明了来源；解析/校验失败会抛错，
          // 由外层 catch 转成 paused（不允许"产物坏了但继续跑"）。
          snapshot = await seedGraphFromPhaseArtifact(
            ctx,
            snapshot,
            phaseDefinition,
            phaseRun.response,
            options.abortSignal,
          );
          snapshot = await updateNodePromptsFromPhaseArtifact(
            ctx,
            snapshot,
            phaseDefinition,
            phaseRun.response,
            options.abortSignal,
          );
          break;
        }
      }
    }
    return {
      reportPath: snapshot.reportPath,
      response: formatExpertWorkflowCompletion(snapshot),
      runId: snapshot.runId,
      snapshot,
      status: snapshot.status,
      traceId: snapshot.traceId,
    };
  } catch (error) {
    // 以 store 里的最新快照为准（可能已被 cancel() 或并发写入更新）；已 abort 时
    // 去掉 signal，否则读操作本身会被同一个取消信号打断，拿不到真实终态。
    const latest =
      (await ctx.store.readRun(
        snapshot.runId,
        options.abortSignal?.aborted ? undefined : { signal: options.abortSignal },
      )) ?? snapshot;
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (options.abortSignal?.aborted) {
      // 取消路径：若已经有人（cancel 命令）落盘了 cancelled，就直接用那份事实，
      // 不重复写；否则补一次取消变换，保证"信号已 abort"时 run 最终一定是 cancelled。
      if (latest.status === "cancelled") {
        return {
          response: formatExpertWorkflowStatus(latest),
          runId: latest.runId,
          snapshot: latest,
          status: latest.status,
          traceId: latest.traceId,
        };
      }
      const cancelRepair = cancelWorkflowSnapshot(latest, {
        reason: errorMessage,
        timestamp: ctx.timestamp(),
      });
      const cancelled = cancelRepair.snapshot;
      await ctx.store.writeSnapshot(cancelled);
      await ctx.appendLifecycleGraphChanges(cancelled, cancelRepair.nodeChanges);
      await ctx.appendEvent(cancelled.runId, "run_cancelled", {
        message: errorMessage,
        payload: lifecyclePayload(cancelRepair),
      });
      return {
        response: formatExpertWorkflowStatus(cancelled),
        runId: cancelled.runId,
        snapshot: cancelled,
        status: cancelled.status,
        traceId: cancelled.traceId,
      };
    }

    const paused = pauseRunForFailure(ctx, latest, error, errorMessage);
    // 非取消错误：paused 是"可恢复"的终态（不是 failed），保留 recoveryActions 供
    // retry/resume 使用；response 同时附上错误文本，避免用户只能看到 Status: paused。
    await ctx.store.writeSnapshot(paused, { signal: options.abortSignal });
    await ctx.appendEvent(paused.runId, "workflow_paused", {
      message: errorMessage,
      payload: compactWorkflowPayload({
        failureKind: paused.failure?.kind,
        retryable: paused.failure?.retryable,
      }),
      phase: paused.currentPhase,
      signal: options.abortSignal,
    });
    return {
      response: `${formatExpertWorkflowStatus(paused)}\n\nPaused: ${errorMessage}`,
      runId: paused.runId,
      snapshot: paused,
      status: paused.status,
      traceId: paused.traceId,
    };
  }
}

/**
 * 收尾：写最终报告、登记报告 artifact，并把 run 置 completed。
 *
 * 输入：最新快照、complete 阶段定义、取消信号。输出完成后的快照。
 * 顺序要求：先 buildReport + writeReport（拿到相对路径），再更新 phase/artifact/
 * reportPath 并写快照，最后发 run_completed——若先写快照，会出现"状态已 completed
 * 但报告文件不存在"的窗口，冷恢复与 UI 都会看到坏事实。
 * 副作用：写报告文件、写快照、追加阶段图状态、追加 run_completed 事件。
 */
async function completeRun(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  definition: WorkflowPhaseDefinition,
  signal?: AbortSignal,
): Promise<ExpertWorkflowRunSnapshot> {
  const report = buildReport(snapshot);
  const written = await ctx.store.writeReport(snapshot.runId, report, { signal });
  const completedPhase = ctx.updatePhase(snapshot, definition.phase, {
    artifactPath: written.relativePath,
    completedAt: ctx.timestamp(),
    startedAt: ctx.timestamp(),
    status: "completed",
  });
  const completed = ctx.addArtifact(
    ctx.updateSnapshot(completedPhase, {
      completedAt: ctx.timestamp(),
      reportPath: written.relativePath,
      status: "completed",
    }),
    {
      contentType: "text/markdown",
      createdAt: ctx.timestamp(),
      label: "Report",
      path: written.relativePath,
      phase: definition.phase,
    },
  );
  await ctx.store.writeSnapshot(completed, { signal });
  await ctx.appendGraphStatus(completed, definition.phase, "completed", signal);
  await ctx.appendEvent(completed.runId, "run_completed", {
    message: `${ctx.definition.title} completed.`,
    signal,
  });
  return completed;
}

/**
 * 把失败归因写入快照并置 paused。
 *
 * 归因对象取自 latestWorkflowActivity（最近失败/进行中或当前阶段的 activity），
 * 找不到则退化为 run 级 failure（无 activityId/nodeId/phase）。
 * 输出快照含 failure、pauseReason（=message）、recoveryActions（retry/retry_with_
 * current_model/cancel）与 status=paused。纯函数，不落盘、不发事件。
 */
function pauseRunForFailure(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  error: unknown,
  message: string,
): ExpertWorkflowRunSnapshot {
  const activity = latestWorkflowActivity(snapshot);
  const failure = workflowFailureFromError(error, message, activity);
  return ctx.updateSnapshot(snapshot, {
    failure,
    pauseReason: failure.message,
    recoveryActions: workflowRecoveryActions(failure),
    status: "paused",
  });
}
