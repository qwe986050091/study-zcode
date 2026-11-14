/**
 * ============================================================================
 * workflow/expert/phase-runner.ts —— 单阶段子会话执行器（agent 语义）
 * ============================================================================
 *
 * 【定位】负责一个"整段一个子会话"的阶段：置 active → 建 activity → 发
 * phase_started → 调 agentRunner → 写产物 → 置 completed → 发 artifact_written/
 * phase_completed。critic 阶段也复用本函数（其产物按 JSON verdict 解析）。
 *
 * 【进度事件顺序（不可乱）】phase_started → [workflow_session_linked...] →
 * artifact_written → phase_completed。快照/图记录都先于对应事件落盘：
 * 事件是"事实已成立"的通知，而不是"即将发生"的信号。
 *
 * 【失败语义】
 *   - abort：不写 failed（取消不是阶段失败），原样抛错交给 continueRun 判 cancelled。
 *   - 其他错误：先落盘 failed 快照 + phase_failed 事件，再抛错；continueRun 的
 *     catch 再把 run 置 paused 并生成 recoveryActions。两级都要写，缺一不可。
 * ============================================================================
 */

import { createChildTraceContext, type WorkflowPhaseDefinition } from "@zcode/contracts";
import { phaseNodeId } from "./ids.js";
import { buildPhasePrompt } from "./prompts.js";
import type { ExpertWorkflowRuntimeContext } from "./runtime-context.js";
import type { ExpertPhaseRunResult, ExpertWorkflowRunOptions } from "./types.js";
import type { ExpertWorkflowRunSnapshot } from "@zcode/contracts";

/**
 * 执行一个 agent 阶段。
 *
 * 输入：ctx、进入本阶段前的快照、阶段定义、run 参数（含 cwd/abortSignal/onEvent/
 * traceContext）。输出：阶段产物原文 + 已落盘的最新快照（phase=completed）。
 *
 * 副作用：写快照（active、session 回填、completed、failed 共 3~4 次）、写 artifact
 * 文件、追加 phase 节点状态图记录、追加 4 类事件；全程透传取消信号。
 *
 * 不变量：一个阶段最多一个 activityId 贯穿始终（active 与 completed 是同一记录
 * 的覆盖）；产物路径缺省 `artifacts/<phase>.md`，与 definition.artifactPath 互斥。
 * 抛错语义：成功返回；失败先落盘 failed 再抛原错误（abort 时直接抛、不落失败态）。
 */
export async function runPhase(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  definition: WorkflowPhaseDefinition,
  options: ExpertWorkflowRunOptions,
): Promise<ExpertPhaseRunResult> {
  const activityId = ctx.createActivityId();
  // 输入产物只记路径不记内容：子会话按路径自行读取，避免把大文件塞进 activity。
  const inputArtifactPaths = snapshot.artifacts.map((artifact) => artifact.path);
  // 每个阶段一个子 trace，继承父 sessionId 并打上 run/phase/activity 属性，
  // 用于把子会话的 span 归位到具体阶段；缺父 trace 时整段不产生 traceId。
  const phaseTraceContext = options.traceContext
    ? createChildTraceContext(options.traceContext, {
        attributes: {
          workflowActivityId: activityId,
          workflowKind: ctx.definition.kind,
          workflowPhase: definition.phase,
          workflowRunId: snapshot.runId,
        },
        sessionId: options.traceContext.sessionId,
      })
    : undefined;
  // 先把阶段与活动都置 active 再落盘：若先跑子会话后写状态，中途崩溃会留下
  // "快照里没有任何活动，但日志里已有子会话"的不可恢复状态。
  const active = ctx.updatePhase(snapshot, definition.phase, {
    activityId,
    error: undefined,
    startedAt: ctx.timestamp(),
    status: "active",
    traceId: phaseTraceContext?.traceId,
  });
  const activeWithActivity = ctx.upsertActivity(active, {
    activityId,
    inputArtifactPaths,
    kind: "agent_session",
    nodeId: phaseNodeId(definition.phase),
    outputArtifactPaths: [],
    parentSessionId: active.sessionId,
    phase: definition.phase,
    startedAt: ctx.timestamp(),
    status: "active",
    traceId: phaseTraceContext?.traceId,
  });
  await ctx.store.writeSnapshot(activeWithActivity, { signal: options.abortSignal });
  // 顺序：快照 → 图记录 → 事件。事件消费方默认"看到 phase_started 时快照已 active"。
  await ctx.appendGraphStatus(active, definition.phase, "active", options.abortSignal);
  await ctx.appendEvent(active.runId, "phase_started", {
    message: `${definition.title} started.`,
    phase: definition.phase,
    signal: options.abortSignal,
  });
  // runningSnapshot 是回调链里滚动的"最新事实"：onChildSessionStarted 会就地推进它，
  // 成功后用它（而不是最初 activeWithActivity）作为 completed 的基线，避免丢 session 信息。
  let runningSnapshot = activeWithActivity;

  try {
    const result = await ctx.agentRunner.run({
      abortSignal: options.abortSignal,
      activityId,
      cwd: options.cwd,
      onChildSessionStarted: async (event) => {
        const currentActivity = runningSnapshot.activities.find(
          (activity) => activity.activityId === activityId,
        );
        // 活动已不处于 active（阶段已结束/已失败）时晚到的回执必须丢弃，
        // 否则会把一个已 finalized 的 activity 改回"有 session"的中间态。
        if (!currentActivity || currentActivity.status !== "active") return;
        runningSnapshot = ctx.upsertActivity(
          ctx.updatePhase(runningSnapshot, definition.phase, {
            sessionId: event.sessionId,
            traceId: event.traceId ?? currentActivity.traceId,
            turnId: event.turnId ?? currentActivity.turnId,
          }),
          {
            ...currentActivity,
            ...(event.model ? { model: event.model } : {}),
            sessionId: event.sessionId,
            traceId: event.traceId ?? currentActivity.traceId,
            turnId: event.turnId ?? currentActivity.turnId,
          },
        );
        await ctx.store.writeSnapshot(runningSnapshot, { signal: options.abortSignal });
        // 会话链接事件与快照同步写入：UI 收到后立即可按 activityId 找到该子会话。
        await ctx.appendEvent(runningSnapshot.runId, "workflow_session_linked", {
          message: `Workflow session linked: ${event.sessionId}`,
          nodeId: phaseNodeId(definition.phase),
          payload: {
            activityId,
            ...(event.model ? { model: event.model } : {}),
            sessionId: event.sessionId,
            ...(event.traceId ? { traceId: event.traceId } : {}),
            ...(event.turnId ? { turnId: event.turnId } : {}),
          },
          phase: definition.phase,
          signal: options.abortSignal,
        });
      },
      onEvent: options.onEvent,
      parentSessionId: active.sessionId,
      phase: definition.phase,
      prompt: buildPhasePrompt(runningSnapshot, definition),
      runId: active.runId,
      task: active.task,
      traceContext: phaseTraceContext,
      workflowKind: ctx.definition.kind,
    });
    // 产物路径口径：定义显式指定优先，否则落在 artifacts/<phase>.md（跨阶段唯一）。
    const artifactPath = definition.artifactPath ?? `artifacts/${definition.phase}.md`;
    const artifact = await ctx.store.writeArtifact(active.runId, artifactPath, result.response, {
      signal: options.abortSignal,
    });
    const completed = ctx.updatePhase(runningSnapshot, definition.phase, {
      activityId,
      artifactPath: artifact.relativePath,
      completedAt: ctx.timestamp(),
      sessionId: result.sessionId,
      status: "completed",
      traceId: result.traceId ?? phaseTraceContext?.traceId,
      turnId: result.turnId,
    });
    const completedWithActivity = ctx.upsertActivity(completed, {
      activityId,
      artifactPath: artifact.relativePath,
      completedAt: ctx.timestamp(),
      inputArtifactPaths,
      kind: "agent_session",
      ...(result.model ? { model: result.model } : {}),
      nodeId: phaseNodeId(definition.phase),
      outputArtifactPaths: [artifact.relativePath],
      parentSessionId: active.sessionId,
      phase: definition.phase,
      sessionId: result.sessionId,
      startedAt:
        runningSnapshot.activities.find((activity) => activity.activityId === activityId)
          ?.startedAt ?? ctx.timestamp(),
      status: "completed",
      traceId: result.traceId ?? phaseTraceContext?.traceId,
      turnId: result.turnId,
    });
    const withArtifact = ctx.addArtifact(completedWithActivity, {
      contentType: "text/markdown",
      createdAt: ctx.timestamp(),
      label: definition.title,
      path: artifact.relativePath,
      phase: definition.phase,
    });
    await ctx.store.writeSnapshot(withArtifact, { signal: options.abortSignal });
    await ctx.appendGraphStatus(withArtifact, definition.phase, "completed", options.abortSignal);
    await ctx.appendEvent(withArtifact.runId, "artifact_written", {
      message: `Artifact written: ${artifact.relativePath}`,
      phase: definition.phase,
      signal: options.abortSignal,
    });
    await ctx.appendEvent(withArtifact.runId, "phase_completed", {
      message: `${definition.title} completed.`,
      phase: definition.phase,
      signal: options.abortSignal,
    });
    return { response: result.response, snapshot: withArtifact };
  } catch (error) {
    if (options.abortSignal?.aborted) {
      // 取消也走 reject 路径（子会话被 abort 时通常抛错），但取消不是阶段失败：
      // 不写 failed、不发 phase_failed，直接上抛让 continueRun 落盘 cancelled。
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    const currentActivity = runningSnapshot.activities.find(
      (activity) => activity.activityId === activityId,
    );
    const failed = ctx.updatePhase(runningSnapshot, definition.phase, {
      activityId,
      completedAt: ctx.timestamp(),
      error: errorMessage,
      status: "failed",
    });
    const failedWithActivity = ctx.upsertActivity(failed, {
      activityId,
      completedAt: ctx.timestamp(),
      error: errorMessage,
      inputArtifactPaths,
      kind: "agent_session",
      ...(currentActivity?.model ? { model: currentActivity.model } : {}),
      nodeId: phaseNodeId(definition.phase),
      outputArtifactPaths: [],
      parentSessionId: active.sessionId,
      phase: definition.phase,
      ...(currentActivity?.sessionId ? { sessionId: currentActivity.sessionId } : {}),
      startedAt: currentActivity?.startedAt ?? ctx.timestamp(),
      status: "failed",
      traceId: currentActivity?.traceId ?? phaseTraceContext?.traceId,
      ...(currentActivity?.turnId ? { turnId: currentActivity.turnId } : {}),
    });
    await ctx.store.writeSnapshot(failedWithActivity, { signal: options.abortSignal });
    await ctx.appendGraphStatus(
      failedWithActivity,
      definition.phase,
      "failed",
      options.abortSignal,
    );
    // 先落盘失败事实再发事件，最后抛原错误（保留 cause 链供 failures.ts 分类）。
    await ctx.appendEvent(failedWithActivity.runId, "phase_failed", {
      message: errorMessage,
      phase: definition.phase,
      signal: options.abortSignal,
    });
    throw error;
  }
}
