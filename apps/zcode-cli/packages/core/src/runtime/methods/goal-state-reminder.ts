/**
 * ============================================================================
 * goal-state-reminder.ts —— Goal 状态变更提醒的延迟物化
 * ============================================================================
 * 定位：链路 8（Goal 续跑与完成验证）的收尾通知。target 状态变化要以 model-only 的
 *       synthetic user notice 进入下一轮请求，但 Stop 期间不能立即写入历史。
 * 输入/输出：输入是提醒文本与 trace；输出是 messageHistory attachment + 持久化 notice。
 * 关键不变量：Stop 顺序（先 pause goal、再 abort 在飞工具）期间延迟写入，避免在
 *       tool_use 与 cancelled tool_result 之间插入 user 消息而破坏 provider 配对语法
 *       （不变量 #1）；权威 target 已先落库，物化失败只记 warn（链路 8）。
 * ============================================================================
 */
import { createMessageId, traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ActiveTurnSteeringState } from "../types.js";

export async function recordGoalStateChangeReminder(
  this: AgentRuntimeInternal,
  input: {
    text: string;
    traceContext?: TraceContext;
  },
): Promise<void> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  const activeTurn = this.activeTurn;
  // deferral 只对 regular turn 生效：只有它有 Stop 收尾钩子；其它 kind 没有可等待的关闭点。
  if (
    activeTurn?.kind === "regular" &&
    activeTurn.goalStateChangeReminderDeferralOpen
  ) {
    // Stop 会先暂停 goal、再 abort 正在执行的工具。此处若立即写 history，
    // reminder 会落在 tool_use 与 cancelled tool_result 之间，导致下一次请求违反 provider grammar。
    activeTurn.pendingGoalStateChangeReminder = { text: input.text };
    // 只暂存文本、不落 attachment/不持久化，所有权随 activeTurn 走到 close 收尾。
    return;
  }
  // 无 deferral 的普通状态变化直接物化；这里的失败向上抛，由调用方决定如何处理。
  await materializeGoalStateChangeReminder.call(this, input.text, traceContext);
}

export function openGoalStateChangeReminderDeferral(
  activeTurn: ActiveTurnSteeringState | undefined,
): void {
  if (activeTurn?.kind === "regular") {
    // 只有 regular turn 有 Stop 收尾钩子；其它 kind 不设 deferral，提醒走即时物化。
    activeTurn.goalStateChangeReminderDeferralOpen = true;
  }
}

export async function closeGoalStateChangeReminderDeferral(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState | undefined,
  traceContext: TraceContext,
): Promise<void> {
  // 非 regular（没有对应 Stop 收尾）既不开 deferral，也没有 pending 可结算。
  if (activeTurn?.kind !== "regular") return;

  // activeTurn 会继续存活到 terminal/accounting 全部结束，不能再用它的
  // 存在与否判断 pending 所有权。先同步关闭，之后到达的 reminder 会直接物化。
  activeTurn.goalStateChangeReminderDeferralOpen = false;
  const pending = activeTurn.pendingGoalStateChangeReminder;
  // deferral 期间没有提醒到达：关闭后无需补写。
  if (!pending) return;

  // 先清 pending 再 await：物化期间新提醒到达时会看到 deferral 已关，直接物化而不是再次排队。
  activeTurn.pendingGoalStateChangeReminder = undefined;
  try {
    // 补写暂存提醒；权威 target 已先落库，这里的失败不能阻止 Stop turn 发出 terminal event。
    await materializeGoalStateChangeReminder.call(this, pending.text, traceContext);
  } catch (error) {
    // 权威 target 已先落库；reminder 持久化失败不能阻止 Stop turn 发出 terminal event。
    // 保持单次物化，不在 turn 收尾引入 retry、cursor 或额外持久化状态机。
    this.logger?.warn("Failed to materialize pending goal state reminder", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.reminder.materialize.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

async function materializeGoalStateChangeReminder(
  this: AgentRuntimeInternal,
  text: string,
  traceContext: TraceContext,
): Promise<void> {
  // 先确保 context 初始化，否则 attachment 会落在未初始化的 history 上。
  await this.ensureContextInitialized(traceContext);
  // 内存态 attachment 让本轮/后续请求立即看到提醒；source 供 UI 与恢复逻辑归组。
  this.messageHistory.addAttachment("goal_state_change", text);
  // model-only：只进 provider transcript，不进用户 transcript；持久化是冷恢复的权威来源。
  await this.persistSyntheticUserNoticeForSession({
    messageID: createMessageId(),
    sessionId: this.sessionId,
    source: "goal_state_change",
    text,
    traceContext,
    visibility: "model-only",
  });
}
