/**
 * ============================================================================
 * runtime/methods/runtime-command-generation.ts —— 分支代际(branchGeneration)过滤
 * ============================================================================
 *
 * rewind / 编辑重发会把会话切到新分支并推进 branchGeneration。
 * 但后台任务完成、子代理回传、controlOnly 轮都可能在 rewind 前后入队或到达:
 * 它们属于**旧分支**的结果,若被注入当前 turn,模型会看到"已被回退掉的未来"。
 *
 * 两道检查:
 *   isStaleBranchRuntimeCommand   命令入队时记录 branchGeneration,消费前比对;
 *   isStaleBranchRuntimeTaskEvent 任务事件到达时,按 registry 里登记的
 *                                 task.branchGeneration 比对(事件本身不带 generation)。
 * 不匹配一律只留 debug 日志后丢弃——丢弃是正常语义,不是错误。
 * ============================================================================
 */
import { SessionEventType, traceContextToLogContext } from "../deps.js";
import type { SessionEvent } from "../deps.js";
import type { RuntimeCommand } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";

export function isStaleBranchRuntimeCommand(
  runtime: AgentRuntimeInternal,
  command: RuntimeCommand,
): boolean {
  if (
    // 只有这三类命令带 branchGeneration;prompt/续跑属于用户显式意图,
    // 即使 rewind 也应继续执行,不能按分支代际丢弃。
    command.mode !== "task-notification" &&
    command.mode !== "subagent-message" &&
    command.mode !== "control-only-turn"
  ) {
    return false;
  }
  if (command.branchGeneration === runtime.branchGeneration) return false;
  // rewind 与后台 completion 存在竞态；命令即使已入队，也必须在持久化和
  // provider 注入前再次校验 generation，旧分支结果只留诊断日志。
  // 不变量 6：分支代际变化后，旧分支的通知/命令必须丢弃——否则模型会看到
  // "已被回退掉的未来"，造成当前分支的事实污染。
  runtime.logger?.debug("Dropped queued stale-branch runtime command", {
    ...traceContextToLogContext(command.traceContext),
    branchGeneration: command.branchGeneration,
    commandId: command.id,
    currentBranchGeneration: runtime.branchGeneration,
    event: "runtime.command.stale_branch_dropped",
    mode: command.mode,
    module: "core.runtime",
  });
  return true;
}

export function isStaleBranchRuntimeTaskEvent(
  runtime: AgentRuntimeInternal,
  event: SessionEvent,
): boolean {
  if (
    event.type !== SessionEventType.BackgroundTaskUpdated &&
    event.type !== SessionEventType.BackgroundTaskCompleted &&
    event.type !== SessionEventType.SubagentMessage &&
    event.type !== SessionEventType.SubagentStopped
  ) {
    return false;
  }
  const payload =
    event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : {};
  const taskId =
    // 事件 payload 里任务标识有两种口径:backgroundTaskId 统一叫 taskId,
    // subagent 事件用 agentId。取不到就无法判断代际,直接放行(不是 stale)。
    typeof payload.taskId === "string"
      ? payload.taskId
      : typeof payload.agentId === "string"
        ? payload.agentId
        : undefined;
  if (!taskId) return false;
  const task = runtime.runtimeTaskRegistry.get(taskId);
  // registry 里没有该任务(可能是已清理的旧任务)也无法判断代际,按非 stale 处理;
  // 有记录时比对 task.branchGeneration —— 它是任务启动时所在分支的权威值。
  // 不变量 6：事件本身不带 branchGeneration，必须从 registry 取任务出生时的代际；
  // 不匹配即丢弃，保证旧分支的后台结果不进入当前分支的事件流。
  if (!task || task.branchGeneration === runtime.branchGeneration) return false;
  runtime.logger?.debug("Dropped stale-branch runtime task event", {
    branchGeneration: task.branchGeneration,
    currentBranchGeneration: runtime.branchGeneration,
    event: "runtime.task_event.stale_branch_dropped",
    eventType: event.type,
    module: "core.runtime",
    taskId,
  });
  return true;
}
