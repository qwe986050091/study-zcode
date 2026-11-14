/**
 * ============================================================================
 * workflow/expert/scheduled-phase.ts —— 阶段级的图调度执行器
 * ============================================================================
 *
 * 【定位】把"一个阶段里可能有多个 task 节点"交给 WorkflowGraphScheduler 执行：
 * 本文件只做适配（把 ctx 的 store/runner/artifact 端口接到 scheduler）+ 阶段
 * 收尾（写摘要产物、置 completed）。节点的并发/重试/dependency 判定全部在
 * scheduler 内部，本文件不重复实现。
 *
 * 【调度口径】executableNodeIds 只取本阶段的 task 节点（无 task 时退化为 phase
 * 节点）；scheduler 会在这些节点中按依赖/并发上限挑选，全部成功才算阶段完成，
 * 任一节点耗尽重试或出现死锁则整个阶段暂停。
 *
 * 【失败语义】scheduler.run 返回非 completed → 直接抛错（携带 paused 原因），
 * 由 continueRun 统一写 run 级 paused；planner 产物解析失败也以抛错表达。
 * 因此本文件不写 paused/recoveryActions，只负责"成功收尾"。
 * ============================================================================
 */

import { type ExpertWorkflowRunSnapshot, type WorkflowPhaseDefinition } from "@zcode/contracts";
import { WorkflowGraphScheduler } from "../scheduler.js";
import { executableNodeIdsForPhase, safeArtifactName } from "./ids.js";
import { parseWorkflowPlannerResult } from "./parsers/planner-result.js";
import { buildScheduledNodePrompt, buildScheduledPhaseSummary } from "./prompts.js";
import type { ExpertWorkflowRuntimeContext } from "./runtime-context.js";
import type { ExpertWorkflowRunOptions } from "./types.js";

/**
 * 执行一个 scheduled_graph 阶段。
 *
 * 输入：ctx、进入本阶段前的快照、阶段定义、run 参数。输出：阶段 completed 后的
 * 快照（已登记摘要 artifact）。纯"编排 + 收尾"，不直接跑子会话。
 *
 * 副作用：写 active 快照、追加 phase_started；scheduler 内部会写节点级快照/事件；
 * 收尾再写摘要 artifact、completed 快照、图记录与 artifact_written/phase_completed。
 *
 * 抛错语义：scheduler 未 completed、planner 输出非法、摘要写入失败都会抛错；
 * 调用方（run-loop）负责把它归并为 run paused。abort 时抛错即为取消信号。
 */
export async function runScheduledPhase(
  ctx: ExpertWorkflowRuntimeContext,
  snapshot: ExpertWorkflowRunSnapshot,
  definition: WorkflowPhaseDefinition,
  options: ExpertWorkflowRunOptions,
): Promise<ExpertWorkflowRunSnapshot> {
  // 先置 active 并落盘，再交给 scheduler：调度期间若进程中断，快照仍能说明"该阶段
  // 曾经开始过"，resume 才会去 reconcile 它的 active 节点而不是当作从未执行。
  const active = ctx.updatePhase(snapshot, definition.phase, {
    error: undefined,
    startedAt: ctx.timestamp(),
    status: "active",
  });
  await ctx.store.writeSnapshot(active, { signal: options.abortSignal });
  await ctx.appendEvent(active.runId, "phase_started", {
    message: `${definition.title} started.`,
    phase: definition.phase,
    signal: options.abortSignal,
  });

  const scheduler = new WorkflowGraphScheduler({
    // 端口全部转发到 ctx/store，scheduler 不知道 cwd/run 目录布局。
    appendEvent: (event, eventOptions) => ctx.store.appendEvent(event, eventOptions),
    appendGraphRecord: (runId, record, graphOptions) =>
      ctx.store.appendGraphRecord(runId, record, graphOptions),
    createActivityId: ctx.createActivityId,
    now: ctx.now,
    onWorkflowEvent: ctx.onWorkflowEvent,
    // plannerRunner：产物超出子会话原文，还要解析成结构化计划；解析失败即抛错
    // （不能让"模型没按格式输出"被当成空计划继续调度）。
    plannerRunner: {
      run: async (input) => {
        const result = await ctx.agentRunner.run({
          abortSignal: input.abortSignal,
          activityId: input.activityId,
          cwd: input.cwd,
          onChildSessionStarted: input.onChildSessionStarted,
          onEvent: input.onEvent,
          parentSessionId: input.parentSessionId,
          phase: input.phase,
          prompt: input.prompt,
          runId: input.runId,
          task: input.task,
          traceContext: input.traceContext,
          workflowKind: ctx.definition.kind,
        });
        const plannerResult = parseWorkflowPlannerResult(result.response, definition.phase);
        return {
          ...plannerResult,
          model: result.model,
          response: result.response,
          sessionId: result.sessionId,
          traceId: result.traceId,
          turnId: result.turnId,
        };
      },
    },
    // runner：普通 task 节点直接透传，scheduler 已负责拼好 prompt 与 activity 口径。
    runner: {
      run: async (input) =>
        ctx.agentRunner.run({
          abortSignal: input.abortSignal,
          activityId: input.activityId,
          cwd: input.cwd,
          onChildSessionStarted: input.onChildSessionStarted,
          onEvent: input.onEvent,
          parentSessionId: input.parentSessionId,
          phase: input.phase,
          prompt: input.prompt,
          runId: input.runId,
          task: input.task,
          traceContext: input.traceContext,
          workflowKind: ctx.definition.kind,
        }),
    },
    writeArtifact: (runId, relativePath, content, writeOptions) =>
      ctx.store.writeArtifact(runId, relativePath, content, writeOptions),
    writeSnapshot: (nextSnapshot, writeOptions) =>
      ctx.store.writeSnapshot(nextSnapshot, writeOptions),
  });
  const result = await scheduler.run({
    abortSignal: options.abortSignal,
    // 每个阶段独立目录，避免同名节点覆盖彼此产物；safeArtifactName 防止 phase 名
    // 里的特殊字符进入路径。
    artifactDirectory: `artifacts/${safeArtifactName(definition.phase)}`,
    buildPrompt: ({ node, snapshot: promptSnapshot }) =>
      buildScheduledNodePrompt(promptSnapshot, definition, node),
    cwd: options.cwd,
    // 只看本阶段的 task 节点；空图时退化到 phase 节点，保证阶段仍能收敛。
    executableNodeIds: executableNodeIdsForPhase(active.graph, definition.phase),
    onEvent: options.onEvent,
    parentSessionId: active.sessionId,
    phase: definition.phase,
    snapshot: active,
    traceContext: options.traceContext,
  });

  if (result.status !== "completed") {
    // paused/deadlock 一律抛错升级为 run 级失败：本文件不自行写 recoveryActions，
    // 由 continueRun 的 catch 统一处理（paused 原因经 message 透传）。
    throw new Error(`Workflow ${definition.phase} scheduler paused: ${result.reason}`);
  }

  // 摘要从"调度后的快照"派生（节点 attempts/error 已是最新），而不是用进入时的快照。
  const summary = buildScheduledPhaseSummary(result.snapshot, definition.phase);
  const artifact = await ctx.store.writeArtifact(
    result.snapshot.runId,
    definition.artifactPath ?? `artifacts/${definition.phase}.md`,
    summary,
    { signal: options.abortSignal },
  );
  // 阶段自身的 session 关联取"该阶段最后一条 completed activity"：scheduler 可能
  // 起过多个节点会话，取最后一条最接近阶段收尾时的上下文；没有则全部 undefined。
  const phaseActivity = result.snapshot.activities
    .filter((activity) => activity.phase === definition.phase && activity.status === "completed")
    .at(-1);
  const completed = ctx.updatePhase(result.snapshot, definition.phase, {
    activityId: phaseActivity?.activityId,
    artifactPath: artifact.relativePath,
    completedAt: ctx.timestamp(),
    sessionId: phaseActivity?.sessionId,
    status: "completed",
    traceId: phaseActivity?.traceId,
    turnId: phaseActivity?.turnId,
  });
  const withArtifact = ctx.addArtifact(completed, {
    contentType: "text/markdown",
    createdAt: ctx.timestamp(),
    label: definition.title,
    path: artifact.relativePath,
    phase: definition.phase,
  });
  await ctx.store.writeSnapshot(withArtifact, { signal: options.abortSignal });
  // 收尾顺序与 phase-runner 一致：快照 → 图状态 → artifact_written → phase_completed。
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
  return withArtifact;
}
