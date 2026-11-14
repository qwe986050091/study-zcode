/**
 * ============================================================================
 * runtime/methods/prompt-admission.ts —— prompt 准入的唯一裁决点
 * ============================================================================
 *
 * 一次 prompt 只在这里落到三种去向：
 *   start（空闲）：先建 turn 启动预约，再入 FIFO，最后交给 drain 执行；
 *   steer（有 active 且可 steer 且无附件）：内联进当前 turn，进当前轮不是新轮；
 *   queue（其余 busy）：作为独立命令排队，由队列在空闲时再拉起一个新 turn。
 * 预约（reservation）必须与入队在同一同步段完成，否则"检查 busy → 真正启动"之间的
 * 异步窗口会开出第二条 turn（不变量 #5）。拒绝一律用回执表达，不抛异常。
 * ============================================================================
 */
import { createChildTraceContext, createQueryId, createTurnId } from "../deps.js";
import type { QueryId, TurnInputIntentMetadata } from "../deps.js";
import type { PromptRuntimeCommand } from "../command-queue.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";
import { acceptSubmissionModelSelection, captureHighspeedFallbackSelection } from "./turn-model.js";
import type {
  ActiveTurnStartReservation,
  ExecuteTurnOptions,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  TurnResult,
} from "../types.js";

/**
 * 每个 AgentRuntime 自己完成 prompt 的 admission：检查 busy 边界、建立 reservation、
 * 把 command 放进该 runtime 的 FIFO。Bootstrap 不应把这些步骤拆开，否则 reservation
 * 建立前的异步窗口会让同一 session 产生第二条 turn。
 */
export async function admitPrompt(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: Parameters<AgentRuntimeInternal["executeTurn"]>[1],
  options?: PromptAdmissionOptions,
): Promise<PromptAdmissionReceipt> {
  // requireQueue 表示调用方明确要求"必须是未来某个独立 turn"，不允许被空闲快照改成 start。
  if (options?.requireQueue === true) {
    // Bug 根因：Highspeed 临时 provider 只能在独立 turn 的提升边界安装。如果仅依据
    // Bootstrap 的 busy 快照决定是否排队，状态在跨层 await 期间转为空闲会误用普通模型启动。
    return await this.enqueueDeferredInput({
      attachments,
      commandKind: options.commandKind,
      delivery: "queue",
      input,
      inputId: options.inputId,
      intent: admissionIntent(options.intent, "queue"),
      modelSelectionScope: options.modelExecution?.selectionScope,
      highspeedFallbackSelection: options.modelExecution?.selectionFallback?.target,
      queryId: options.queryId,
      toolDisallowlist: options.toolDisallowlist,
      traceContext: options.traceContext,
    });
  }
  // 只持 promotion lease 时，rest 全空：这条 lease 本身已为某条排队命令预留了启动权，
  // 不能当成第三方 busy 拒绝它，否则被提升的命令永远拿不到自己的 turn。
  const promotionLeaseOnly =
    options?.requireIdle === true &&
    this.foregroundPromotionLease !== undefined &&
    this.activeForegroundExecution === undefined &&
    this.runtimeCommandDrainActive === false &&
    this.runtimeCommandQueue.hasPending() === false &&
    this.activeTurn === undefined &&
    this.activeTurnStartReservation === undefined;
  const busy = this.hasActiveOrQueuedTurnWork() && !promotionLeaseOnly;
  if (busy) {
    // requireIdle / 带 modelExecution 的调用不接受排队或 steer：状态机在跨层 await 期间
    // 可能变化，硬性要求只能立刻执行，否则宁可拒绝也不产生第二条 turn（不变量 #5）。
    if (options?.requireIdle === true || options?.modelExecution !== undefined) {
      // 拒绝是回执而非异常：调用方按 kind 渲染提示，不触发错误链路。
      return {
        activeTurnId: this.activeTurn?.turnId,
        kind: "rejected",
        reason: this.activeTurn ? "turn_not_steerable" : "no_active_turn",
      };
    }

    const activeTurn = this.activeTurn;
    // steer 的四个前提缺一不可：无附件（附件无法内联进当前轮）、当前 turn 可 steer、
    // 调用方意图是 auto/steer/guide、且没有显式要求 queue。
    const canSteer =
      attachments === undefined &&
      activeTurn?.steerable === true &&
      (options?.queueDelivery === "guide" ||
        options?.delivery === "auto" ||
        options?.delivery === "steer_active_turn") &&
      options?.queueDelivery !== "queue";
    if (canSteer) {
      // guide 语义：输入进入当前 turn 的 pendingInputs，由 drainPendingInput 在模型步之间注入。
      const delivery = options?.queueDelivery === "guide" ? "guide" : undefined;
      // 默认展示为 user_steer，让 UI 区分"用户手动插话"与调用方内部注入。
      return await this.steerTurn({
        commandKind: options?.commandKind,
        delivery,
        expectedTurnId: options?.expectedTurnId,
        input,
        inputPresentation:
          options?.inputPresentation ?? (!options?.inputSource ? "user_steer" : undefined),
        inputId: options?.inputId,
        intent: admissionIntent(options?.intent, delivery ?? "queue"),
        queryId: options?.queryId,
        toolDisallowlist: options?.toolDisallowlist,
        traceContext: options?.traceContext,
      });
    }

    // guide 只在无附件时保留；带附件无法内联，直接降级 queue 而不是丢弃输入。
    const delivery =
      options?.queueDelivery === "guide" && attachments === undefined ? "guide" : "queue";
    // queue 路径不建 reservation：新 turn 的启动权由命令出队时自己取得（见 drain）。
    return await this.enqueueDeferredInput({
      attachments,
      commandKind: options?.commandKind,
      delivery,
      input,
      inputPresentation:
        options?.inputPresentation ?? (!options?.inputSource ? "user_steer" : undefined),
      inputId: options?.inputId,
      intent: admissionIntent(options?.intent, delivery),
      queryId: options?.queryId,
      toolDisallowlist: options?.toolDisallowlist,
      traceContext: options?.traceContext,
    });
  }

  // queryId 优先继承调用方或 inputId：同一条输入的重试/恢复要能落回同一个 query 账本。
  const queryId = options?.queryId ?? (options?.inputId as QueryId | undefined) ?? createQueryId();
  const turnId = createTurnId();
  // turn traceContext 挂在 root 之下而不是替换 root：session/turn 的因果链必须可串起来。
  const turnTraceContext = createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
    queryId,
    sessionId: this.sessionId,
    turnId,
    attributes: { turnNumber: this.turnNumber },
  });
  const reservation: ActiveTurnStartReservation = {
    kind: "regular",
    traceContext: turnTraceContext,
    turnId,
  };
  // 预约与入队必须在同一同步段完成；中间若有 await，别的 prompt 会看到"无 reservation"
  // 而通过 busy 检查，开出第二条 turn（不变量 #5）。
  this.reserveTurnStart(turnId, turnTraceContext, "regular");
  let selectionAccepted = Promise.resolve();

  if (options?.modelExecution) {
    // 先固化降级目标：真正安装发生在 onCommandAccepted（同步接纳点），此处只做快照。
    options = {
      ...options,
      modelExecution: captureHighspeedFallbackSelection(this, options.modelExecution),
    };
  }
  const executeOptions = options as ExecuteTurnOptions | undefined;
  const completion = enqueueCancellableRuntimeCommand<TurnResult, PromptRuntimeCommand>(this, {
    abortSignal: options?.abortSignal,
    // 命令在入队前/排队中被取消：必须撤销 reservation，否则该 runtime 永久判 busy。
    onCommandCancelled: () => this.releaseTurnStart(turnId),
    // 同步接纳点：此时已通过取消检查、尚未入队，是安装临时运行模型的唯一安全窗口。
    onCommandAccepted: () => {
      selectionAccepted = acceptSubmissionModelSelection(
        this,
        options?.intent,
        turnTraceContext,
        options?.modelExecution,
      );
    },
    createCommand: ({ reject, resolve }) => ({
      attachments,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      input,
      mode: "prompt",
      options: {
        ...executeOptions,
        queryId,
        traceContext: options?.traceContext ?? this.rootTraceContext,
      },
      priority: "next",
      reject,
      resolve,
      // reservation 随命令传递：执行侧据此证明启动权已被占用，不得再竞争 active turn。
      startReservation: reservation,
      traceContext: turnTraceContext,
    }),
  });
  // admission 已经完成；执行失败由现有 turn 事件/调用方消费，不制造 unhandled rejection。
  void completion.catch(() => undefined);
  // 等模型选择安装完成再回回执：调用方拿到 started 时 selection 已是最终事实。
  await selectionAccepted;
  return { completion, kind: "started", turnId };
}

function admissionIntent(
  intent: TurnInputIntentMetadata | undefined,
  admittedDelivery: "guide" | "queue",
): TurnInputIntentMetadata | undefined {
  // 把实际投递方式写回 intent（而不是调用方期望值）：冷恢复与遥测据此还原真实路径。
  return intent ? { ...intent, admittedDelivery } : undefined;
}
