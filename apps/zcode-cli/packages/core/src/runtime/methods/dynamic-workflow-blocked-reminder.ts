// ============================================================
// 「run 还欠着决定、主代理闲着」的提醒：runtime 侧的宿主与接线
// ============================================================
// docs/dynamic-workflow/transcript-and-notifications.md「Reminding an idle main agent」。规则（空闲钟、
// 两次、谁给新的一对）在 runtime-task/workflow-blocked-reminder.ts 的钟里；本文件只做两件事：
//
//   1. 把钟要的四样东西接到 runtime 上：在飞的 run 来自任务注册表，开集来自端口快照
//      （`pendingQuestions` 与 `waiting` 的 `holes`——与 GetWorkflowRun 念的是同一份投影），空闲与否来自
//      命令队列，发出走既有的后台通知入口（同一条队列、账本、分支围栏与关闭丢弃，不新增投递路径）。
//   2. 接线点只在调用方留一行：命令开始与 run 的开集事件各有一个函数在这里；队列排空（空闲沿）与
//      用户 steer 直接调钟，分别在 runtime-command-queue.ts 与 steering.ts。
//
// 与 `run-stalled` 的差别：停滞是 run 自己的事实，由 driver 的钟发现、进 journal；这里的「闲」是**父会话**
// 的事实，run 与 journal 都不知道，所以它不是一条 run 事件，也不随进程重启恢复——进程没了，在飞的 run
// 结算为 interrupted，resume 会让每个开着的决定带着自己的通知重新出现。

import type { RuntimeCommand } from "../command-queue.js";
import type { DynamicWorkflowRunProgressPayload } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  WorkflowBlockedReminderClock,
  type WorkflowBlockedReminder,
  type WorkflowOpenDecisions,
} from "../../runtime-task/workflow-blocked-reminder.js";
import { formatWorkflowBlockedNotification } from "../../runtime-task/workflow-notification-copy.js";

/** workflow run 在任务注册表里的类型。 */
const WORKFLOW_RUN_TASK_TYPE = "local_dynamic_workflow";
/** 注册表里「还在飞」的状态词。 */
const RUNNING_TASK_STATUS = "running";

/** 改变一个 run 开集的四种事件（引擎的 `RunEvent.type`）。 */
const OPEN_SET_EVENT_TYPES: ReadonlySet<string> = new Set([
  "escalation-raised",
  "escalation-resolved",
  "hole-reached",
  "hole-filled",
]);

/** 造这个 runtime 的提醒钟（构造函数里调一次）。 */
export function createWorkflowBlockedReminder(
  runtime: AgentRuntimeInternal,
): WorkflowBlockedReminderClock {
  // 钟只通过这五个回调读事实，不持有 runtime；每项都是当下的投影，不能在闭包里缓存。
  return new WorkflowBlockedReminderClock({
    // 关停中也算「不空闲」：此时入队的提醒会随进程退出一起丢，白烧一对次数。
    isIdle: () => !runtime.shuttingDown && !runtime.hasActiveOrQueuedTurnWork(),
    // 在飞集合每次现算：注册表会被 driver 增删，缓存会让提醒漏掉新 run 或提醒已结束的 run。
    liveRunIds: () => liveWorkflowRunIds(runtime),
    // 快照读失败归一成一条 warn：提醒是观察面，不能因读失败打断命令队列。
    onReadError: (runId, error) => {
      runtime.logger?.warn?.("Dynamic workflow blocked reminder: snapshot read failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "dynamic_workflow.blocked.snapshot_failed",
        module: "core.runtime",
        runId,
      });
    },
    readOpen: (runId) => readOpenDecisions(runtime, runId),
    remind: (reminder) => {
      enqueueBlockedReminder(runtime, reminder);
    },
  });
}

/**
 * 本会话在飞的 workflow run。注册表是 per-runtime 的，所以这里看到的都是本会话发起的；被 rewind 掉的
 * 分支上的 run 不算——它的通知会被入口的分支围栏丢掉，提醒它只会白烧一次次数。
 */
function liveWorkflowRunIds(runtime: AgentRuntimeInternal): string[] {
  const live: string[] = [];
  // 只挑本会话的 workflow run：注册表是 per-runtime 的，其它类型（bash/subagent 等）不产生这类提醒。
  for (const task of Object.values(runtime.runtimeTaskRegistry.all())) {
    // 非 running（完成/失败/interrupted）不在飞，提醒它已没有可补的决定。
    if (task.type !== WORKFLOW_RUN_TASK_TYPE || task.status !== RUNNING_TASK_STATUS) continue;
    // 分支代际不一致的 run 已被 rewind：其通知会被入口围栏丢弃（不变量 #6），提醒只会白烧次数。
    if ((task.branchGeneration ?? runtime.branchGeneration) !== runtime.branchGeneration) continue;
    // taskId 即 runId，后续 getTask 与通知锚点都直接复用它。
    live.push(task.taskId);
  }
  return live;
}

async function readOpenDecisions(
  runtime: AgentRuntimeInternal,
  runId: string,
): Promise<WorkflowOpenDecisions | undefined> {
  // 端口缺席或快照不存在都视作「没有开集」：run 已结算时提醒没有意义，且不能因此抛错。
  const snapshot = await runtime.dynamicWorkflowRunPort?.getTask(runId);
  if (snapshot === undefined) return undefined;
  // 与 GetWorkflowRun 同源的两份投影：待答问题 + 等待中的留白；filled/closed 等状态不算欠决定。
  const questions = snapshot.pendingQuestions ?? [];
  const holes = (snapshot.holes ?? []).filter((hole) => hole.state === "waiting");
  // 没有欠决定就不造提醒对象，钟侧也就不会为这个 run 累计次数。
  if (questions.length + holes.length === 0) return undefined;
  // draftPath 映射 scriptPath：通知要念草稿位置，但端口快照只暴露 scriptPath 这个字段名。
  return {
    questions,
    holes,
    ...(snapshot.scriptPath === undefined ? {} : { draftPath: snapshot.scriptPath }),
  };
}

function enqueueBlockedReminder(
  runtime: AgentRuntimeInternal,
  reminder: WorkflowBlockedReminder,
): void {
  const { runId, open, now } = reminder;
  // 展示名的兜底链与其余 run 通知同源：registry 条目的 description → runId。
  const runLabel = runtime.runtimeTaskRegistry.get(runId)?.description ?? runId;
  // 取开集里最久的等待时长（问题用 askedAt、留白用 since）；空集时 Math.max(0) 兜底为 0。
  const sinceMs = Math.max(
    0,
    ...open.questions.map((question) => Math.floor(now - question.askedAt)),
    ...open.holes.map((hole) => (hole.since === undefined ? 0 : Math.floor(now - hole.since))),
  );
  // 生产也留的一条：每个停住的 run 在一段空闲里至多两条，出问题时要能在日志里看见「提醒过了」。
  runtime.logger?.info?.("Dynamic workflow blocked reminder sent", {
    event: "dynamic_workflow.blocked.reminder_sent",
    holes: open.holes.length,
    module: "core.runtime",
    ordinal: reminder.ordinal,
    questions: open.questions.length,
    runId,
    sinceMs,
  });
  // 统一走后台通知入口，继承命令队列、账本、分支围栏与关闭丢弃，不新增投递路径（不变量 #6）。
  runtime.enqueueBackgroundTaskNotification({
    originMeta: {
      backgroundSource: "workflow",
      title: runLabel,
      // workId ≡ runId：与该 run 的其余通知同一个展示锚点。
      workId: runId,
      // 载荷只带计数与最久的等待：每个决定的原文在它自己那条通知行上，这一行不重复。
      // 走自己的键而不是 `workflowNotification` 的一个 kind：那个 union 在线上是闭集，多一个成员会让
      // 不认识它的客户端拒掉整帧（contracts 的 WorkflowBlockedMeta 上有来由）。
      workflowBlocked: {
        questions: open.questions.length,
        holes: open.holes.length,
        sinceMs,
      },
    },
    // taskId 让通知继承该 run 的 branchGeneration（迟到通知的 fencing）。
    taskId: runId,
    text: formatWorkflowBlockedNotification({
      runLabel,
      runId,
      ordinal: reminder.ordinal,
      total: reminder.total,
      now,
      questions: open.questions,
      holes: open.holes,
      ...(open.draftPath === undefined ? {} : { draftPath: open.draftPath }),
    }),
    traceContext: runtime.rootTraceContext,
  });
}

/**
 * 命令队列开始跑一条命令（或一批通知）：钟停。带合成来源的 prompt（提醒类注入、goal 续跑等）不是
 * 用户发话；没有来源的 prompt 才是用户自己敲的那一条，它给每个 run 新的一对提醒。
 */
export function noteWorkflowReminderCommandStarted(
  runtime: AgentRuntimeInternal,
  command: RuntimeCommand,
): void {
  const clock = runtime.workflowBlockedReminder;
  // 钟没装（非 onDemand 或旧构造路径）时无事可做，调用方无需分支。
  if (clock === undefined) return;
  // 任何命令开跑都先停钟：忙时的提醒会与进行中的一轮抢注意力，也违反「主代理空闲」前提。
  clock.sessionBusy();
  // 只有「用户亲自敲的 prompt」才重置一对次数；合成来源（goal 续跑、提醒注入）不算用户发话。
  if (command.mode === "prompt" && command.options?.inputSource === undefined) clock.userSpoke();
}

/** 一条 run 进度事件：改变开集的那四种让该 run 重新得到一对提醒，其余不理会。 */
export function noteWorkflowReminderRunEvent(
  runtime: AgentRuntimeInternal,
  payload: DynamicWorkflowRunProgressPayload,
): void {
  // 其余事件（progress 等）不改变开集，直接忽略，避免每条进度都触发一轮提醒判定。
  if (!OPEN_SET_EVENT_TYPES.has(payload.eventType)) return;
  // 开集变化让该 run 重新得到一对提醒：旧决定可能已补全，新决定需要重新计时。
  runtime.workflowBlockedReminder?.openSetChanged(payload.runId);
}
