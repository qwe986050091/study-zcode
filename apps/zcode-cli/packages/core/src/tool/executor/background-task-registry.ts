import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
} from "@zcode/contracts";
import type {
  ExecutionPort,
  DynamicWorkflowRunSnapshot,
  SubagentTaskSnapshot,
  WorkflowTaskSnapshot,
} from "@zcode/contracts";
import {
  isTerminalRuntimeTask,
  type RuntimeTaskSnapshot,
  type RuntimeTaskType,
} from "../../runtime-task/registry.js";
import type { ExecutableToolCall } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { isRecord } from "./utils.js";
import { backgroundTaskOutputMetadata } from "./background-task-output.js";
import { serializeWorkflowArtifact } from "./workflow-artifact.js";

type BackgroundTaskSnapshot =
  | NonNullable<Awaited<ReturnType<NonNullable<ExecutionPort["getBackgroundTask"]>>>>
  | SubagentTaskSnapshot
  | WorkflowTaskSnapshot
  // workflow run 的快照沿用 WorkflowTaskSnapshot 的形状但把 output 放宽成 unknown（产物由脚本
  // 的顶层返回值决定），所以它不是 WorkflowTaskSnapshot 的子类型，必须单列一支。
  | DynamicWorkflowRunSnapshot;

/**
 * dwf run 的名字分派谓词：CreateWorkflow = 新启动 / ResumeWorkflowRun = 恢复，同一 run
 * 生命周期的两个入口，快照/等待/取消/通知/registry 全部同构。
 *
 * 注意：CreateWorkflow 确认窗的 Refine 特判（product-projection.ts / turn-control.ts）
 * 刻意**不**换用本谓词——ResumeWorkflowRun 的确认窗没有 causalityGraph、没有图精炼，走
 * 默认 ask；把名字加进那些特判会让确认窗长出一个无图的 Refine 选项。
 *
 * 维护不变量：这三个名字在 `runtimeTaskTypeForToolCall` 里必须映射到同一个 taskType
 * `local_dynamic_workflow`；漏掉一个会让它的 register/update/claim 全部静默 no-op。
 */
export function isDynamicWorkflowRunDispatchToolName(name: string): boolean {
  return (
    name === CREATE_WORKFLOW_TOOL_NAME ||
    name === AMEND_WORKFLOW_TOOL_NAME ||
    name === RESUME_WORKFLOW_RUN_TOOL_NAME
  );
}

/**
 * 登记/刷新一个后台任务的 runtime-task registry 条目（工具启动与 resume 重臂共用入口）。
 *
 * 输入：`taskId` 是任务唯一 id（Bash/Agent 等一轮即弃；dwf run 的 runId 会跨 resume 复用）；
 * `output` 是启动阶段回填的原始输出，只用于推导描述与 outputFile；`turnId` 只在首次登记时定格。
 *
 * 副作用：写 runtimeTaskRegistry（首次/新生命走 register，其余走 update），并置
 * status="running"、isBackgrounded=true——这是会话回收护栏与 TaskOutput 可见性的唯一登记点。
 *
 * 失败/降级：没有 registry 或工具名不在分派表时静默返回；任务照常执行，只是不会被回收护栏
 * 与 TaskOutput 看见。不变量：`branchGeneration` 只能由 register 按当前活跃分支盖章。
 */
export function registerRuntimeBackgroundTask(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
  output: Record<string, unknown>,
  turnId?: RuntimeTaskSnapshot["turnId"],
): void {
  const taskType = runtimeTaskTypeForToolCall(toolCall);
  // 静默返回是刻意的：任务照常执行，只是不会进入会话回收护栏与 TaskOutput 的可见集合。
  if (!taskType || !deps.runtimeTaskRegistry) return;
  const existing = deps.runtimeTaskRegistry.get(taskId);
  const description = runtimeTaskDescription(toolCall, output) ?? defaultRuntimeTaskDescription(taskType);
  const outputFile = backgroundTaskOutputMetadata(output).outputFile;
  // 同进程 cancel 终态 → 未重启即 resume（dwf 的 resume 重臂，
  // v4 命令路径与工具路径在 trackBackgroundTask 汇合同病）时，既有条目携带上一轮 claim 的
  // notified:true，重建若原样保留，claimRuntimeBackgroundTaskNotification 会据此拒收——
  // 恢复 run 的终态模型通知被吞。同族 error/completedAt/resultText 残留还会让 running 期
  // 条目经 updateRuntimeBackgroundTask 的 `?? current.*` 链挂着旧失败/旧完成时间/旧产物。
  // 因此重臂时整体复位**结算面**（notified/completedAt/error/exitCode/resultText/pid）；
  // **身份面**维持 existing??new 不动（agentId/agentType/parentToolCallId/turnId/description/
  // startedAt）——parentToolCallId 是「工具卡 → 详情页链路跨 resume 保持」的锚，换成本次
  // 重臂的描述子 id 会把 join 打断。
  //
  // 复位必须以**重臂为界**：只有 dwf 分派名会跨 resume 复用同一
  // runId 在终态条目上再启动新生命周期（重臂），此时上一轮的 notified 属于旧生命周期、
  // 必须作废。Bash/Agent 等单生命周期任务的 task id 一轮即弃，但 tracker 晚挂载时
  // register 同样会撞上已认领（notified:true）的终态条目——那是**同一**生命周期的认领
  // 令牌，无差别复位会让同一终态的模型通知被二次入队。「缺陷名字无关」指可达路径
  // （v4 命令路径同样经 CreateWorkflow 名重臂），而非任何 register 都该复位。
  //
  // outputFile 有意**不**随结算面复位：workflow run 从不写 outputFile，existing 兜底仅为产物
  // 外部化预留的透传；外部化落地时应随其语义重新裁决（勿顺手清空、也勿顺手扩大语义）。
  const rearm = isDynamicWorkflowRunDispatchToolName(toolCall.name);
  // 新生命 = 在**终态**条目上重臂。它必须走 register() 而非 update()：register 会用当前
  // activeBranchGeneration 重盖 branchGeneration，而 update 的 {...existing} 会把上一段生命
  // 周期的分支代带进新生命——cancel → rewind（分支代 +1）→ resume 时，新生命的任务事件会被
  // runtime-command-generation 的 stale-branch fencing 当旧分支残留整体丢弃（终态通知再次失踪）。
  // 仍在 running 的既有条目不是新生命，维持 update 的合并语义与它自己的分支代。
  const newLife = rearm && existing !== undefined && isTerminalRuntimeTask(existing);
  const next: RuntimeTaskSnapshot = {
    ...existing,
    agentId: existing?.agentId ?? taskId,
    agentType: existing?.agentType ?? taskType,
    description: existing?.description ?? description,
    isBackgrounded: true,
    outputFile: outputFile ?? existing?.outputFile,
    parentToolCallId: existing?.parentToolCallId ?? toolCall.id,
    startedAt: existing?.startedAt ?? new Date(),
    status: "running",
    taskId,
    taskType,
    type: taskType,
    turnId: existing?.turnId ?? turnId,
    // —— 结算面复位（仅重臂 = 新的一轮生命周期；非重臂的重挂载保留既有结算面）——
    notified: rearm ? false : (existing?.notified ?? false),
    completedAt: rearm ? undefined : existing?.completedAt,
    error: rearm ? undefined : existing?.error,
    exitCode: rearm ? undefined : existing?.exitCode,
    resultText: rearm ? undefined : existing?.resultText,
    pid: rearm ? undefined : existing?.pid,
    // 上一轮是谁停的，与新生命无关。
    stopInitiator: rearm ? undefined : existing?.stopInitiator,
  };
  if (existing && !newLife) {
    deps.runtimeTaskRegistry.update(taskId, () => next);
    return;
  }
  // 首次登记或新生命：剥掉继承来的 branchGeneration，交给 register 按当前 active 分支盖章。
  const { branchGeneration: _previousLife, ...fresh } = next;
  deps.runtimeTaskRegistry.register(fresh);
}

/**
 * 用一次轮询 / 终态快照刷新 registry 条目（running 中间态与终态都走这里）。
 *
 * 口径：终态条目整体冻结（`isTerminalRuntimeTask` 时原样返回），迟到的 running 快照不得把
 * completed 改回 running；其余字段一律 `新值 ?? current.*` 合并，undefined 绝不清掉已存值。
 *
 * 副作用：只写 registry，不发事件、不发通知。无 registry / 非受管工具名时静默返回。
 *
 * 不变量：`resultText` 只能由终态快照覆盖——中转快照没有产物时不能抹掉之前落下的 workflow 产物。
 */
export function updateRuntimeBackgroundTask(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot?: BackgroundTaskSnapshot,
): void {
  const taskType = runtimeTaskTypeForToolCall(toolCall);
  if (!taskType || !deps.runtimeTaskRegistry) return;
  deps.runtimeTaskRegistry.update(taskId, (current) => ({
    // 终态条目整体冻结：迟到的 running 快照不得把 completed 改回 running，
    // 否则 UI 会把已经收口的任务重新画成进行中。
    ...(isTerminalRuntimeTask(current)
      ? current
      : {
          ...current,
          completedAt: runtimeTaskCompletedAt(status, snapshot) ?? current.completedAt,
          description:
            runtimeTaskDescription(toolCall, undefined, snapshot) ?? current.description,
          error: runtimeTaskError(snapshot) ?? current.error,
          exitCode: runtimeTaskExitCode(snapshot) ?? current.exitCode,
          isBackgrounded: true,
          outputFile: backgroundTaskOutputMetadata(snapshot).outputFile ?? current.outputFile,
          pid: runtimeTaskPid(snapshot) ?? current.pid,
          // `?? current.resultText`：undefined 绝不清掉已存下的产物（中途的 running 快照
          // 与产物缺席的终态都会走到这里）。
          resultText: runtimeTaskResultText(toolCall, status, snapshot) ?? current.resultText,
          status: normalizeRuntimeTaskStatus(status),
          taskType,
          type: taskType,
        }),
  }));
}

/**
 * workflow run 的产物文本。只在 dwf 分派名（CreateWorkflow / ResumeWorkflowRun）的**终态**
 * 快照上取：TaskOutput 的投影只读得到 registry 条目（dwf 从不写 outputFile），产物不存在
 * 条目上就在重启后彻底不可达。
 *
 * legacy `Workflow` 刻意不参与——它的结果经 `output.response` 走既有通知路径，契约不变。
 */
function runtimeTaskResultText(
  toolCall: ExecutableToolCall,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
): string | undefined {
  if (!isDynamicWorkflowRunDispatchToolName(toolCall.name)) return undefined;
  if (status === "running") return undefined;
  if (!snapshot || !("output" in snapshot)) return undefined;
  return serializeWorkflowArtifact(snapshot.output);
}

/**
 * 认领该后台任务"模型通知"的唯一令牌，返回本次是否认领成功（幂等保护）。
 *
 * 语义：只有把 `notified` 从 false 翻成 true 的调用者拿到 true；已被认领过则拿到 false。
 * `notified` 一旦置位，后续 completion 通知不再入队，避免同一终态被工具结果与通知双投。
 *
 * 降级：无 registry 或非受管工具名时返回 true（视为"无需去重"），调用方不会因此吞通知；
 * registry 条目已被回收/删除时也返回 true。
 */
export function claimRuntimeBackgroundTaskNotification(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
): boolean {
  if (!runtimeTaskTypeForToolCall(toolCall) || !deps.runtimeTaskRegistry) return true;
  let claimed = false;
  const task = deps.runtimeTaskRegistry.update(taskId, (current) => {
    if (current.notified) return current;
    claimed = true;
    return { ...current, notified: true };
  });
  // 条目缺席视为"无需去重"（registry 可能在任务结束/回收后被清掉）；
  // 条目在但已被别人认领时返回 false，调用方必须放弃本次通知。
  return task === undefined ? true : claimed;
}

/**
 * 把已认领的 `notified` 复位为 false（只用于通知入队失败后的回滚）。
 *
 * 注意：它不是"重发已送达通知"的开关；复位后下一次 claim 会重新入队，所以调用点必须
 * 只在自身的入队动作整体失败时调用（background-tasks.ts 的 catch 分支）。
 */
export function releaseRuntimeBackgroundTaskNotification(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
): void {
  if (!runtimeTaskTypeForToolCall(toolCall) || !deps.runtimeTaskRegistry) return;
  deps.runtimeTaskRegistry.update(taskId, (current) =>
    current.notified ? { ...current, notified: false } : current,
  );
}

/**
 * 从 registry 删除任务条目，之后 TaskOutput 不再能读到这个任务。
 * 无 registry / 非受管工具名时静默返回；删除是幂等的。
 */
export function removeRuntimeBackgroundTask(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
): void {
  if (!runtimeTaskTypeForToolCall(toolCall) || !deps.runtimeTaskRegistry) return;
  deps.runtimeTaskRegistry.remove(taskId);
}

/**
 * 工具名 → runtime task 类型的唯一分派表。返回 undefined 时，本文件所有登记/刷新/认领
 * 入口都会静默 no-op；新增后台工具必须同时在这里加 case，否则回收护栏与 TaskOutput 全失。
 */
function runtimeTaskTypeForToolCall(toolCall: ExecutableToolCall): RuntimeTaskType | undefined {
  switch (toolCall.name) {
    case "Bash":
      return "local_bash";
    case "Workflow":
      return "local_workflow";
    default:
      // dwf 的两个入口（CreateWorkflow / ResumeWorkflowRun）共用一个 taskType：缺席则
      // registerRuntimeBackgroundTask 直接 return——会话回收护栏与 TaskOutput 可见性全失。
      return isDynamicWorkflowRunDispatchToolName(toolCall.name)
        ? "local_dynamic_workflow"
        : undefined;
  }
}

/** 各 taskType 的兜底描述（UI 折叠行标题用）；exhaustive switch 保证新增 taskType 时编译期报错。 */
function defaultRuntimeTaskDescription(taskType: RuntimeTaskType): string {
  switch (taskType) {
    case "local_bash":
      return "Bash background command";
    case "local_workflow":
      return "Workflow background task";
    case "local_dynamic_workflow":
      return "Dynamic workflow run";
    case "local_agent":
      return "Agent background task";
    case "monitor_mcp":
      return "Monitor background task";
  }
}

/**
 * 外部状态字符串 → registry 的有限状态集合。cancelled/timed_out 一律折成 killed；
 * 任何未知值按 failed 收口，绝不把未知状态留成 "running"——那会让任务永远无法被回收。
 */
function normalizeRuntimeTaskStatus(status: string): RuntimeTaskSnapshot["status"] {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "cancelled":
    case "timed_out":
      return "killed";
    case "lost":
      return "lost";
    default:
      return "failed";
  }
}

/**
 * 描述优先级：快照的 description → 快照/输出的 name → 工具入参的 description / command /
 * name / scriptPath。最终都没有则由 register 用 taskType 兜底。
 */
function runtimeTaskDescription(
  toolCall: ExecutableToolCall,
  output?: Record<string, unknown>,
  snapshot?: BackgroundTaskSnapshot,
): string | undefined {
  const input = isRecord(toolCall.input) ? toolCall.input : {};
  if (snapshot && "description" in snapshot && typeof snapshot.description === "string") {
    return snapshot.description;
  }
  if (snapshot && "name" in snapshot && typeof snapshot.name === "string") return snapshot.name;
  if (output && typeof output.name === "string") return output.name;
  if (typeof input.description === "string") return input.description;
  if (typeof input.command === "string") return input.command;
  if (typeof input.name === "string") return input.name;
  if (typeof input.scriptPath === "string") return input.scriptPath;
  return undefined;
}

/** running 快照不写完成时间；终态优先用快照自带的 completedAt，缺失才取当前时刻。 */
function runtimeTaskCompletedAt(
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
): Date | undefined {
  if (status === "running") return undefined;
  return snapshot?.completedAt ?? new Date();
}

/** 快照 error 可能是字符串或 Error 对象，统一压成字符串；缺席即 undefined，不伪造空错误。 */
function runtimeTaskError(snapshot: BackgroundTaskSnapshot | undefined): string | undefined {
  if (!snapshot || !("error" in snapshot)) return undefined;
  const error = snapshot.error;
  return typeof error === "string" ? error : error?.message;
}

/** 退出码只在快照带 result 时存在；workflow/agent 类快照没有该字段。 */
function runtimeTaskExitCode(snapshot: BackgroundTaskSnapshot | undefined): number | undefined {
  if (!snapshot || !("result" in snapshot)) return undefined;
  return snapshot.result?.exitCode;
}

/** PID 只在本地进程类快照上存在；缺失表示非进程任务或已无法观测，不补 0。 */
function runtimeTaskPid(snapshot: BackgroundTaskSnapshot | undefined): number | undefined {
  if (!snapshot || !("pid" in snapshot)) return undefined;
  return snapshot.pid;
}
