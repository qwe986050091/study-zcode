// goal/compact 命令组：compact / sendGoalCommand / pauseGoal / resumeGoal。
// 语义自旧 server-operations compactSession/goalSession/continueGoalAfterChange 搬运，
// 决策逻辑（compact 去重 / active turn barrier / goal 续跑）直驱 core，不经旧协议 op。
//
// 与旧协议路径的映射（保真基线）：
// - compactSession（server-operations.ts:1805）→ compact
// - goalSession action:"set"（:1919，含重复 set 收敛 replace）→ sendGoalCommand
// - goalSession action:"resume"（:1980）→ resumeGoal
// - continueGoalAfterChange / runGoalContinuationInBackground（:2204-2269）→ 组内私有共用函数
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { SteerTurnOptions, SubmitPromptOptions } from "../../../app/types.js";
import { runWithSessionResidencyFinalization } from "../../../session-execution/index.js";
import { inputIntentMetadata } from "../input-intent.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import {
  applyHeldQueueDisposition,
  enqueueDeferredInputForBusyWork,
  resolveSubmittedExecutionState,
  V4InputAdmissionRejectedError,
} from "../input-admission.js";

/** goal/compact 组的裁决拒绝（gateway 捕获后进 ACK failed，message 透传给客户端）。 */
/**
 * goal/compact 组的业务拒绝（reasonCode 进入 ACK 词表）。
 * 拒绝时一律没有 durable 写入：compact 锁冲突、restoreWarning、plan/goal 互斥、
 * 空目标都在落库前判定，客户端可安全重试。
 */
export class V4GoalCompactRejectedError extends Error {
  constructor(
    readonly reasonCode:
      | "activeTurn"
      | "compactOperationLock"
      | "restoreWarning"
      | "guard.planGoalMutuallyExclusive"
      | "emptyObjective",
    message: string,
  ) {
    super(message);
    this.name = "V4GoalCompactRejectedError";
  }
}

// 手动 compact 在后台 turn 真正登记前，下一条 command 已可能完成 admission。
// 仅看 runtime activeTurn 会留下一个极短的重复 compact 窗口；controller WeakSet 只补齐
// operation lock 的同步边界，不复制 queue 或 lifecycle 业务状态。
/**
 * 手动 compact 的同步锁集合：从登记 controller 到 runtime 真正 activeTurn 之间
 * 存在极短窗口，仅看 activeTurn 会漏判并发 compact。仅补同步边界，
 * 不复制 queue/lifecycle 业务状态（WeakSet 随 controller 回收）。
 */
const manualCompactControllers = new WeakSet<AbortController>();

/**
 * compact：手动上下文压缩。
 * ACK 只表示「压缩请求已被接纳并登记」，压缩结果经 CompactStarted/终态 marker 事件
 * 与 projection 收口；这个命令没有 user message，因此不能靠 SessionInputPromoted 解 pin。
 * 副作用：busy 时入队（保持 FIFO barrier），idle 时启动后台 compact turn 并登记
 * activeAbortController；无论成功/失败/取消都会写 timeline command fact，防止重启后
 * 把已执行命令再提示重放。
 * 失败：已有 compact 运行/排队 → compactOperationLock；restoreWarning → 拒绝；
 * 入队被拒 → 结构化错误（不吞错）。
 */
/**
 * compact：手动上下文压缩（v4 payload 为空对象，无 instructions 变体）。
 *
 * barrier 语义：
 * 1. running/goal verifier/goal continuation/tool work → typed compact intent 入 FIFO。
 * 2. held queue → 追加队尾，不绕过既有 future intent。
 * 3. running 或 queued compact 已存在 → compactOperationLock，禁止重复压缩。
 */
async function compact(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  const activeTurn = record.app.runtime.getActiveTurnInfo();
  const activeController = record.activeAbortController;
  if (
    activeTurn?.kind === "compact" ||
    (activeController ? manualCompactControllers.has(activeController) : false) ||
    host.hasQueueItemKind?.(record.app.sessionId, "compact")
  ) {
    host.logger?.info?.("v4 compact already running or queued, rejected", {
      commandId: envelope.commandId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
    throw new V4GoalCompactRejectedError(
      "compactOperationLock",
      "Compact is already running or queued",
    );
  }
  if (record.restoreWarning) {
    // 与 prompt-turn 相同的闸门：恢复失败的会话不能静默续写（含 compact turn）。
    throw new V4GoalCompactRejectedError("restoreWarning", record.restoreWarning.message);
  }

  const routingMode = host.getInputRoutingMode?.(record.app.sessionId) ?? null;
  const busy = Boolean(record.activeAbortController) || Boolean(activeTurn);
  if (busy || routingMode === "enqueue" || routingMode === "guide" || routingMode === "choice") {
    const intent = inputIntentMetadata(envelope, {
      requestedDelivery: "queue",
      text: "/compact",
    });
    const queueOptions = {
      commandKind: "compact" as const,
      inputId: envelope.commandId,
      intent,
      queryId: envelope.commandId as NonNullable<SteerTurnOptions["queryId"]>,
    };
    if (await enqueueDeferredInputForBusyWork(record, "/compact", queueOptions)) {
      return undefined;
    }
    const queued = await record.app.steerTurn("/compact", {
      ...queueOptions,
      delivery: "queue",
    });
    if (queued.kind === "rejected") {
      throw new V4InputAdmissionRejectedError(
        queued.reason === "input_too_large"
          ? "proto.payloadTooLarge"
          : queued.reason === "empty_input"
            ? "proto.invalidPayload"
            : "fault.command.inputRejected",
        `compact input queue rejected: ${queued.reason}`,
      );
    }
    return undefined;
  }

  await startManualCompact(host, record, envelope.commandId);
  return undefined;
}

/**
 * 手动 compact 的唯一启动路径（直接命令与 queue 提升共用）。
 * 副作用：先 ensureModelReady，再登记 activeAbortController + 同步锁，然后后台执行；
 * 后台错误只记事件流，不向调用方抛（避免 unhandled rejection）。
 * 失败：restoreWarning / 模型不可用直接抛给 handler → 拒绝 ACK（没有启动 turn）。
 */
/** queue promotion 与直接命令共用唯一手动 compact 启动路径。 */
export async function startManualCompact(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  inputId: string,
  foregroundPromotionLeaseId?: string,
): Promise<void> {
  if (record.restoreWarning) {
    throw new V4GoalCompactRejectedError("restoreWarning", record.restoreWarning.message);
  }
  // 冷恢复后用户可能直接触发 /compact（不先经 sendText），compact 的后台模型请求
  // 同样需要模型就绪检查——钩子（见 types.ts）。
  await host.ensureModelReady?.(record);
  const abortController = new AbortController();
  // compact 的真实模型请求在后台执行，但 Stop 仍通过
  // record.activeAbortController 中断。不登记 controller，压缩中的请求会跑到自然结束。
  record.activeAbortController = abortController;
  manualCompactControllers.add(abortController);
  void runWithSessionResidencyFinalization(record, () =>
    runCompactTurnInBackground(host, record, {
      abortController,
      foregroundPromotionLeaseId,
      inputId,
    }),
  ).catch(() => {
    // 后台 compact 的错误经事件流（CompactStarted/终态 marker）降级上报；兜底防 unhandled rejection。
  });
}

/**
 * 后台 compact turn 的生命周期：执行 → 失败/取消时 hold 后续队列 → 释放租约与
 * active lock（关键顺序：先释放锁再广播）→ 写 timeline 查重事实 → legacy 广播。
 * 失败语义：模型失败/取消不算 ACK 失败（ACK 早已返回），但必须把 autoDrain 置 false，
 * 防止后续文本越过用户显式维护意图；timeline fact 写失败只 warn，不伪装成模型失败。
 */
async function runCompactTurnInBackground(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    abortController: AbortController;
    foregroundPromotionLeaseId?: string;
    inputId: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  let mutationReason = "session_compacted";
  let lifecycleStatus: "success" | "failed" | "cancelled" = "success";
  host.logger?.info?.("v4 background compact started", {
    inputId: params.inputId,
    sessionId: record.app.sessionId,
    workspacePath: record.workspace.workspacePath,
  });
  try {
    await record.app.submitPrompt("/compact", {
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
    });
  } catch (error) {
    lifecycleStatus = params.abortController.signal.aborted ? "cancelled" : "failed";
    mutationReason =
      lifecycleStatus === "cancelled" ? "session_compact_cancelled" : "session_compact_failed";
    if ((host.getQueueLength?.(record.app.sessionId) ?? 0) > 0) {
      try {
        // queued compact 是 FIFO barrier；失败/Stop 后若继续 auto-drain，
        // 后续文本会越过用户显式维护意图。与普通 Stop 一致切为 held。
        await record.app.setQueueAutoDrain(false);
      } catch (holdError) {
        host.logger?.warn?.("v4 compact failed to hold following queue", {
          error: holdError instanceof Error ? holdError.message : String(holdError),
          inputId: params.inputId,
          sessionId: record.app.sessionId,
        });
      }
    }
    host.logger?.warn?.("v4 background compact failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } finally {
    if (params.foregroundPromotionLeaseId) {
      record.app.runtime.releaseForegroundPromotionLease(params.foregroundPromotionLeaseId);
    }
    manualCompactControllers.delete(params.abortController);
    if (record.activeAbortController === params.abortController) {
      // ready 边界（关键约束）：compact 结束后必须先释放 active lock 再广播；
      // 否则 queued prompt 或后续 /compact 会在 ready 边界短暂撞上旧 controller。
      record.activeAbortController = undefined;
    }
  }
  try {
    // compact 没有 user message，不能依赖 SessionInputPromoted 解 pin；无论 lifecycle
    // 成功/失败/取消，都用 timeline command fact 阻止重启后把已执行命令再次提示重放。
    await host.recordPersistentCommandFact?.(
      record.app.sessionId,
      "timeline",
      {
        commandId: params.inputId,
        status: "accepted",
        revisionAtDecision: 0,
      },
      { lifecycleStatus },
    );
  } catch (error) {
    // compact 已执行，不能因查重旁路写失败伪装为模型执行失败。
    host.logger?.warn?.("v4 compact persistent command fact failed", {
      commandId: params.inputId,
      error: error instanceof Error ? error.message : String(error),
      sessionId: record.app.sessionId,
    });
  }
  // 旧协议路径在此调 afterStateMutation → 用钩子等价替代（随旧广播删除）。
  await host.afterLegacyStateMutation?.(record, mutationReason);
}

/**
 * sendGoalCommand：设置/替换 active goal。
 * ACK 只表示并包含「目标已写入 + 续跑已决定」；目标与续跑的投影经 TargetChanged /
 * 续跑 turn 事件收敛。
 * durable 事实：setTarget(objective, status=active) 落库；重复 set 收敛为 replace
 * （已有 target 时直接替换，reason 记为 goal_replaced），不要求客户端二次确认。
 * 副作用：busy 时以 sendGoalCommand 身份入队（保留控制命令语义），idle 时写目标并
 * 可能启动后台 continuation。失败：空目标 / plan 与 goal 互斥 → 拒绝，不写库。
 * 幂等：同 commandId 由账本与 TargetChanged 事件收口；有副作用命令禁止静默重发。
 */
/**
 * sendGoalCommand：设置/更新 goal（旧 goalSession action:"set"）。
 *
 * barrier 语义（自旧协议路径保真 + v4 队列补齐）：
 * 1. active turn → 入队为 sendGoalCommand：/goal 是目标状态写入，不是普通 prompt；
 *    运行中不能直接改 target，但也不能丢弃。队列项必须保留命令身份，等 ready 边界执行。
 * 2. 重复 set 收敛 replace 语义（关键约束）：输入框里的 `/goal 新目标` 是用户
 *    显式提交的新目标；已有目标时继续要求 replace 会让用户以为目标已变更但数据库仍保留
 *    旧目标。这里读到已有 target 就按替换路径处理（差异只体现在广播 reason）。
 */
async function sendGoalCommand(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["sendGoalCommand"];
  const record = requireRecord(host, envelope.sessionId);
  const objective = payload.text.trim();
  if (objective.length === 0) {
    throw new V4GoalCompactRejectedError("emptyObjective", "Usage: /goal <objective>");
  }
  const submittedExecutionState = resolveSubmittedExecutionState(record, payload);
  if (submittedExecutionState.planEnabled) {
    throw new V4GoalCompactRejectedError(
      "guard.planGoalMutuallyExclusive",
      "Plan and Goal cannot be active at the same time.",
    );
  }
  const submissionIntent = (options: Parameters<typeof inputIntentMetadata>[1]) =>
    inputIntentMetadata(envelope, { ...options, ...submittedExecutionState });
  const routingMode = host.getInputRoutingMode?.(record.app.sessionId) ?? null;
  if (record.activeAbortController || routingMode === "enqueue" || routingMode === "guide") {
    // /goal 是目标控制命令，active turn 中不能直接写 target；
    // 但产品语义要求 running/compacting/goal verifier 可入队。busy projection 可能
    // 早于 controller 登记，因此同时消费 inputRouting；commandKind 保住控制命令身份，
    // 后续消费时走 sendGoalCommand，而不是普通 user prompt。
    const queuedText = goalCommandQueueText(payload.displayText, objective);
    if (
      await enqueueDeferredInputForBusyWork(record, queuedText, {
        commandKind: "sendGoalCommand",
        inputId: envelope.commandId,
        queryId: envelope.commandId as SteerTurnOptions["queryId"],
        intent: submissionIntent({ requestedDelivery: "queue", text: objective }),
      })
    ) {
      return undefined;
    }
    const queued = await record.app.steerTurn(queuedText, {
      commandKind: "sendGoalCommand",
      inputId: envelope.commandId,
      queryId: envelope.commandId as SteerTurnOptions["queryId"],
      intent: submissionIntent({ requestedDelivery: "queue", text: objective }),
    });
    if (queued.kind === "rejected") {
      throw new V4InputAdmissionRejectedError(
        queued.reason === "input_too_large"
          ? "proto.payloadTooLarge"
          : queued.reason === "empty_input"
            ? "proto.invalidPayload"
            : "fault.command.inputRejected",
        `goal input queue rejected: ${queued.reason}`,
      );
    }
    return undefined;
  }
  await applyGoalCommand(host, record, {
    displayText: goalCommandQueueText(payload.displayText, objective),
    heldQueueDisposition: payload.heldQueueDisposition,
    expectedHeldQueueItemIds: payload.expectedHeldQueueItemIds,
    inputId: envelope.commandId,
    objective,
    intent: submissionIntent({ requestedDelivery: "startNow", text: objective }),
  });
  return undefined;
}

/**
 * 写入 goal 并决定是否续跑（sendGoalCommand 与 queue 提升共用）。
 * 顺序：held 裁决 → 记录是否替换旧目标 → 若本次 intent 明确关闭 Plan 则先落执行状态
 * （不能在旧 plan 状态下拦住续跑）→ setTarget(active) → continueGoalAfterChange。
 * durable 事实：target 落库 + 可选 executionState 变更；失败直接上抛（不吞错）。
 * 副作用：可能启动后台 continuation（占用 activeAbortController）。
 */
export async function applyGoalCommand(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    displayText?: string;
    heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend";
    expectedHeldQueueItemIds?: readonly string[];
    inputId: string;
    objective: string;
    foregroundPromotionLeaseId?: string;
    intent?: SteerTurnOptions["intent"];
  },
): Promise<void> {
  // held choice 裁决（同 sendText；sendGoalCommand）。
  await applyHeldQueueDisposition(
    host,
    record,
    params.heldQueueDisposition,
    params.expectedHeldQueueItemIds,
  );
  const replacesExistingGoal = Boolean(await record.app.readTarget());
  // Goal 的提交也已冻结执行状态；先关闭本次明确取消的 Plan，不能按旧 Runtime 状态拦住续跑。
  if (params.intent?.planEnabled !== undefined) {
    if (params.intent.planEnabled)
      throw new V4GoalCompactRejectedError(
        "guard.planGoalMutuallyExclusive",
        "Plan and Goal cannot be active at the same time.",
      );
    await record.app.runtime.setExecutionState(
      { mode: params.intent.mode, planEnabled: false },
      record.traceContext,
    );
  }
  await record.app.setTarget({
    ...(params.displayText ? { displayText: params.displayText } : {}),
    objective: params.objective,
    status: "active",
    ...(params.intent ? { intent: params.intent } : {}),
  });
  await continueGoalAfterChange(host, record, {
    foregroundPromotionLeaseId: params.foregroundPromotionLeaseId,
    inputId: params.inputId,
    intent: params.intent,
    reason: replacesExistingGoal ? "goal_replaced" : "goal_set",
  });
}

/**
 * 从 `/goal` / `/target` 命令文本解析 objective：去掉命令前缀与可选 `replace` 关键字；
 * 不是该形式时按整段文本当作 objective（queue 里可能存的是已解析目标）。
 * 纯函数；解析结果为空由调用方拒绝。
 */
export function parseGoalObjectiveFromCommandText(text: string): string {
  const trimmed = text.trim();
  const match = /^\/(?:goal|target)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return trimmed;
  const args = match[1]?.trim() ?? "";
  return args.replace(/^replace\s+/i, "").trim();
}

/**
 * queue 项的展示文本：优先用客户端给的 displayText，缺省补回 `/goal <objective>`；
 * 只影响展示与审计，不改变已解析 objective。
 */
function goalCommandQueueText(displayText: string | undefined, objective: string): string {
  const trimmed = displayText?.trim();
  return trimmed ? trimmed : `/goal ${objective}`;
}

/**
 * pauseGoal：只暂停目标，不等价于 stop。
 * 顺序：先结算 target（updateTargetStatus("paused")）再 abort 当前 goal work，
 * 避免 abort 先触发续跑竞态；没有 active target → 幂等成功（不改状态）。
 * 副作用：target 落库 + abort + legacy 广播。失败：updateTargetStatus 返回空 → 幂等返回；
 * 持久化异常向上抛（不伪装已暂停）。
 */
/**
 * pauseGoal：独立 target 控制，不复用通用 stop 的 queue hold/disposition。
 * 旧 V4 只有 stop，导致没有 active controller 时无法暂停目标，也让 UI 无法
 * 准确表达“暂停目标”与“终止本轮”的差别。先结算 target active run，再终止当前 goal work。
 */
async function pauseGoal(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  const target = await record.app.readTarget();
  if (!target || target.status !== "active") {
    return undefined;
  }

  const activeController = record.activeAbortController;
  const paused = await record.app.updateTargetStatus("paused");
  if (!paused) return undefined;

  activeController?.abort(new Error("v4 goal paused"));
  await host.afterLegacyStateMutation?.(record, "goal_paused");
  return undefined;
}

/**
 * resumeGoal：paused/已存在目标 → active，并可能续跑。
 * 前置条件：运行中拒绝（activeTurn）；Plan 与 Goal 互斥先检查再写库
 * （不能先置 active 再拒绝，留下「有目标但 plan 也在跑」的分裂态）。
 * 无 target → 幂等成功（旧协议同语义，不抛错、不改状态）。
 * 副作用/失败语义同 applyGoalCommand。
 */
/**
 * resumeGoal：paused → active（stopPausesActiveGoalTarget 的逆操作）。
 * 无 target → 幂等成功（旧协议路径返回 "No goal to resume." 且不改状态，不抛错）。
 */
async function resumeGoal(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (record.activeAbortController) {
    // 同 sendGoalCommand：resume 属旧 goalSession 的非 pause 动作，运行中拒绝。
    throw new V4GoalCompactRejectedError(
      "activeTurn",
      "Cannot manage goals while a prompt is running",
    );
  }
  // 只跳过续跑仍会留下 active Goal + Plan；恢复目标前就检查，不能先写入再拒绝。
  const planEnabled = record.app.runtime?.getPlanEnabled?.() ?? record.app.getMode?.() === "plan";
  if (planEnabled && (await record.app.readTarget())) {
    throw new V4GoalCompactRejectedError(
      "guard.planGoalMutuallyExclusive",
      "Plan and Goal cannot be active at the same time.",
    );
  }
  const target = await record.app.updateTargetStatus("active");
  if (!target) {
    host.logger?.info?.("v4 resumeGoal without target, noop", {
      commandId: envelope.commandId,
      sessionId: record.app.sessionId,
    });
    return undefined;
  }
  await continueGoalAfterChange(host, record, {
    inputId: envelope.commandId,
    reason: "goal_resumed",
  });
  return undefined;
}

/**
 * goal 变更后的续跑决策：plan 模式或已有 active turn → 只落库目标，不续跑
 * （用户后续显式推进）；否则做模型就绪检查、上锁、后台 continueActiveTarget。
 * 副作用：可能占用 activeAbortController 并启动后台 turn；无论如何都补发
 * afterLegacyStateMutation(reason)（过渡广播，v4 投影走 TargetChanged 自收口）。
 * 失败：模型不可用直接抛（此时目标已写入，但不再续跑；调用方仍按失败告知）；
 * 后台续跑失败只降级为 goal_continuation_failed，不伪造成功。
 */
/**
 * goal 变更后的续跑（旧 continueGoalAfterChange 搬运，set/resume 两处共用）：
 * plan 模式或已有 active turn 时不续跑（只落库目标，用户后续显式推进）；
 * 否则模型就绪检查 → 上锁 → 后台 continueActiveTarget。
 */
async function continueGoalAfterChange(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    foregroundPromotionLeaseId?: string;
    inputId: string;
    intent?: SteerTurnOptions["intent"];
    reason: string;
  },
): Promise<void> {
  const isPlanMode = record.app.runtime?.getPlanEnabled?.() ?? record.app.getMode?.() === "plan";
  // continueActiveTarget 是 App 的必选能力；能否继续只取决于当前模式和是否已有活跃 turn。
  const canContinue = !isPlanMode && !record.activeAbortController;
  if (canContinue) {
    await host.ensureModelReady?.(record);
    const abortController = new AbortController();
    record.activeAbortController = abortController;
    void runWithSessionResidencyFinalization(record, () =>
      runGoalContinuationInBackground(host, record, {
        abortController,
        foregroundPromotionLeaseId: params.foregroundPromotionLeaseId,
        inputId: params.inputId,
        intent: params.intent,
      }),
    ).catch(() => {
      // 后台 goal continuation 的失败经事件流降级上报；兜底防 unhandled rejection。
    });
  }
  // 旧协议路径在续跑起跑后立即 afterStateMutation(goal_set/goal_replaced/goal_resumed)
  // → 钩子等价替代；v4 投影经 TargetChanged 事件自然收口。
  await host.afterLegacyStateMutation?.(record, params.reason);
}

/**
 * 后台 goal continuation：执行 → finally 释放 foreground lease 与 active lock
 * （先释放锁再广播，否则连续 /goal 会被误判已有活跃 turn）→ 广播完成/失败原因。
 * 失败：被吞到 mutationReason=goal_continuation_failed，由事件流与广播上报；
 * 不向 RPC 抛（ACK 早已返回），也不重发。
 */
async function runGoalContinuationInBackground(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    abortController: AbortController;
    foregroundPromotionLeaseId?: string;
    inputId: string;
    intent?: SteerTurnOptions["intent"];
  },
): Promise<void> {
  let mutationReason = "goal_continuation_completed";
  try {
    await record.app.continueActiveTarget?.({
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
      intent: params.intent,
      queryId: params.inputId as SubmitPromptOptions["queryId"],
    });
  } catch {
    mutationReason = "goal_continuation_failed";
  } finally {
    if (params.foregroundPromotionLeaseId) {
      record.app.runtime.releaseForegroundPromotionLease(params.foregroundPromotionLeaseId);
    }
    if (record.activeAbortController === params.abortController) {
      // 续跑结束后应立刻释放活跃锁；广播只是后续动作，
      // 如果继续占锁，连续 /goal 会被误判为已有活跃 turn。
      record.activeAbortController = undefined;
    }
  }
  await host.afterLegacyStateMutation?.(record, mutationReason);
}

/** 本组原生命令注册表（compact / goal 控制），供 handlers/index.ts 合并。 */
export const goalCompactHandlers = { compact, pauseGoal, resumeGoal, sendGoalCommand };
