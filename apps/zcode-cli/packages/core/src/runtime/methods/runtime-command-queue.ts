// INV-01 排空单飞：守住位置 runtimeCommandDrainActive 早退；改错故障 两条 drain 各取一条，命令被执行两次。
// INV-02 置位与复位包住整个消费循环：守住位置 try/finally；改错故障 中途异常留下半开临界区。
// INV-03 复位必须在 finally：守住位置 finally 第一行；改错故障 消费抛错后队列永久卡死。
// INV-04 同批通知合并一次模型轮：守住位置 runTaskNotificationBatch；改错故障 每条通知各起一个 turn。
// INV-05 混合批直接抛错：守住位置 length 比较；改错故障 语义不同的输入混进同一轮。
// INV-06 非通知批只允许一条：守住位置 commands.length 判断；改错故障 续跑与设置轮被打乱顺序。
// INV-07 消费前校验分支代际：守住位置 isStaleBranchRuntimeCommand；改错故障 rewind 前的命令仍被执行。
// INV-08 有租约只出队预留项：守住位置 dequeueNextRunnableBatch 分支；改错故障 普通命令抢在预留之前出队。
// INV-09 出队与消费租约同一同步步：守住位置 removeById 后立即清 lease；改错故障 中间窗口被别的命令插入。
// INV-10 前台执行槽是唯一取消域：守住位置 beginForegroundExecution；改错故障 Stop 停不到 goal 续跑。
// INV-11 父信号已取消要立即兑现：守住位置 parentAbortSignal.aborted；改错故障 已取消命令仍完整跑完。
// INV-12 释放槽位无条件执行：守住位置 finally 内 finishForegroundExecution；改错故障 runtime 永久 busy。
// INV-13 busy 判定含六项：守住位置 hasActiveOrQueuedTurnWork；改错故障 admission 误判空闲，开出第二条 turn。
// INV-14 Stop 幂等且校验 expected：守住位置 两处早退；改错故障 重复点击报错，或停错别的执行。
//
// 模块职责：runtime command 的入队、批量排空、前台执行槽与晋升租约。
// 阅读顺序：先看 enqueue 与 drain，再看租约与 busy 判定，最后看单条命令生命周期与 Stop。
/**
 * ============================================================================
 * runtime/methods/runtime-command-queue.ts —— runtime command 的入队与排空
 * ============================================================================
 *
 * 这一层只回答"谁先执行、执行多久、被取消时谁收口"：
 *   enqueue/drain 把 FIFO 消费成一次前台执行，同一时刻只允许一个；
 *   promotion lease 让调用方预占某条已排队命令的启动权，避免被通知抢先出队；
 *   stopActiveForegroundExecution 覆盖整条 runtime command（含 goal 续跑）的取消域。
 * 不变量：同时最多一个 active turn / 前台执行（#5）；旧分支命令消费前必须丢弃（#6）。
 * ============================================================================
 */
import { traceContextToLogContext } from "../deps.js";
import { refreshOffPeakWork } from "../off-peak/runtime.js";
import type { RuntimeCommand, TaskNotificationRuntimeCommand } from "../command-queue.js";
import { uuidv7 } from "@zcode/shared";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  persistBackgroundTaskNotificationBatch,
  shouldSuppressTaskNotificationRuntimeCommand,
} from "./background-notifications.js";
import { persistSubagentMessageCommand } from "./subagent-messages.js";
import { runControlOnlyTurnCommand } from "./control-only-turn.js";
import { createTurnCancelledError } from "../helpers/index.js";
import { executeTargetContinuationCommand } from "./target.js";
import { runActiveTargetContinuationLoop } from "./target-continuation-loop.js";
import { isStaleBranchRuntimeCommand } from "./runtime-command-generation.js";
import { noteWorkflowReminderCommandStarted } from "./dynamic-workflow-blocked-reminder.js";
import type {
  AcquireForegroundPromotionLeaseResult,
  ActiveForegroundExecutionState,
  ForegroundPromotionLeaseMode,
  StopActiveForegroundExecutionOptions,
  StopActiveForegroundExecutionResult,
} from "../types.js";

// enqueueRuntimeCommand 只写内存队列，不等待排空。
export function enqueueRuntimeCommand(this: AgentRuntimeInternal, command: RuntimeCommand): void {
  // 只有通知与子代理回复能反查"来源任务"；其它 mode 没有任务身份，不做取消与 off-peak 绑定。
  const sourceTaskId =
    command.mode === "task-notification"
      ? command.taskId
      : command.mode === "subagent-message"
        ? command.agentId
        : undefined;
  // 任务卡取消封住该执行的迟到通知；聊天 Stop 不设置此标记，保持原有唤起行为。
  // 这里的早退是"丢弃"而不是"拒绝"：命令没有调用方在等，静默消失即终态。
  // 已取消任务的通知直接丢弃，没有等待方。
  if (sourceTaskId && this.runtimeTaskRegistry.get(sourceTaskId)?.offPeakCancelled) return;
  const offPeakExecutionId =
    sourceTaskId && this.runtimeTaskRegistry.get(sourceTaskId)?.offPeakExecutionId;
  // 回填任务的执行批次：队列按 offPeakExecutionId 划分批量边界，丢了这条同批通知就无法合并。
  // 回填执行批次，队列按它划分批量边界。
  if (offPeakExecutionId) command = { ...command, offPeakExecutionId };
  // 入队是纯内存态事实，不落盘；drain 失败也不会回滚这一步，命令仍留在队列等下一轮。
  this.runtimeCommandQueue.enqueue(command);
  if (command.mode === "task-notification") {
    this.logger?.info?.("Background task notification enqueued into runtime command queue", {
      ...traceContextToLogContext(command.traceContext),
      commandId: command.id,
      event: "background_task.notification.runtime_enqueued",
      module: "core.runtime",
      queueSize: this.runtimeCommandQueue.size(),
    });
  }
  // 不等待排空：提交侧要立刻拿到回执；drain 内部单飞，重复触发只会被挡回。
  // 提交侧拿到回执即返回，drain 在后台单飞排空。
  void this.drainRuntimeCommandQueue();
}

export async function drainRuntimeCommandQueue(this: AgentRuntimeInternal): Promise<void> {
  // 单飞标志：并发的 drain 会各自 dequeue，同一条命令可能被执行两次（不变量 #5 的队列侧）。
  // 单飞标志挡住并发 drain。
  if (this.runtimeCommandDrainActive) return;

  // 先置位再消费：置位与 finally 复位构成一次排空的临界区，嵌套调用在这里被挡回。
  // 置位与 finally 复位构成一次临界区。
  this.runtimeCommandDrainActive = true;
  try {
    let commands: readonly RuntimeCommand[];
    // 将同批后台通知合并到一个模型轮，避免每条通知都单独发起请求。
    while ((commands = dequeueNextRunnableBatch.call(this)).length > 0) {
      const firstCommand = commands[0];
      // 空批在这里再兜一次：dequeue 返回空数组时上面的 while 已退出，这行只防首元素空洞。
      if (!firstCommand) continue;
      // 提醒钟从"命令真正开始消费"起算，而不是入队时刻，否则排队等待会被误判成 run 停滞。
      noteWorkflowReminderCommandStarted(this, firstCommand);
      // 通知批必须整批同 mode；混合批会让一次模型轮同时承载语义不同的输入。
      if (firstCommand.mode === "task-notification") {
        const notificationCommands = commands.filter(
          (command): command is TaskNotificationRuntimeCommand =>
            command.mode === "task-notification",
        );
        if (notificationCommands.length !== commands.length) {
          // 队列契约被破坏时直接失败、不降级执行：错序注入比这一批丢失更难排查。
          // 混合批属于契约破坏，直接失败。
          throw new Error("Runtime command queue returned a mixed task-notification batch");
        }
        // 一批通知=一次模型轮；跑完继续下一批，而不是把通知逐条串成多个 turn。
        await runTaskNotificationBatch.call(this, notificationCommands);
        continue;
      }
      // 其它 mode 一次只能一条：prompt/续跑/设置轮有严格轮次语义，批量会打乱顺序。
      if (commands.length !== 1) {
        // 同样属于编程错误而非运行时输入，抛给上层暴露而不是静默丢弃。
        // 非通知批 length !== 1 属于契约破坏，直接 throw 而不降级。
        throw new Error(`Runtime command queue returned an unsupported ${firstCommand.mode} batch`);
      }
      // 单条命令的完整生命周期（前台执行槽 + 终态收口）在 runRuntimeCommand 内闭合。
      await runRuntimeCommand.call(this, firstCommand);
    }
  } finally {
    // 复位必须在 finally：消费抛错时若不清标志，队列会永久卡死（后续 drain 全部早退）。
    // 复位必须在 finally，否则队列永久卡死。
    this.runtimeCommandDrainActive = false;
    // off-peak 刷新放在复位之后：此时 busy 事实已回到真实值，调度判定才准确。
    refreshOffPeakWork(this);
  }

  // 递归重扫只针对"无 lease"的空闲沿：持 lease 时队列里那条属于被预留命令，
  // 这里抢跑会绕过 promotion 语义；releaseForegroundPromotionLease 也会主动再 drain。
  // 仅当 hasPending() 为真且 foregroundPromotionLease 为空时递归重扫。
  if (this.runtimeCommandQueue.hasPending() && this.foregroundPromotionLease === undefined) {
    await this.drainRuntimeCommandQueue();
    return;
  }
  // 空闲沿：队列排空，且没有任何在跑 / 排着 / 预留的回合（持着晋升租约、或 prompt 已预留未入队时不算，
  // 那一轮自己排空时会再走到这里）。「run 还欠着决定」的提醒钟从这里起算。
  // 空闲判定用完整 busy 集（含 reservation 与 lease），漏判会让预约中的回合被误报 idle。
  // 完整 busy 集为空才报告空闲。
  if (!hasActiveOrQueuedTurnWork.call(this)) this.workflowBlockedReminder?.sessionIdle();
}

function dequeueNextRunnableBatch(this: AgentRuntimeInternal): readonly RuntimeCommand[] {
  // 有 lease 时只能出队被预留的那一条；普通命令即使优先级更高也必须等 lease 释放。
  const lease = this.foregroundPromotionLease;
  if (!lease) return this.runtimeCommandQueue.dequeueNextBatch();

  const promotedCommand = this.runtimeCommandQueue
    .snapshot()
    .find((command) => runtimeCommandInputId(command) === lease.promotedInputId);
  // 预留命令已不在队列（被取消/移走）→ 空批结束本次排空，不能顺带执行别的命令。
  // 预留项不在队列就结束本批，不顺手跑别的。
  if (!promotedCommand) return Object.freeze([]);
  const removedPromotedCommand = this.runtimeCommandQueue.removeById(promotedCommand.id);
  // removeById 失败说明已被别处消费：同样返回空批，保证出队与 lease 消费在同一同步步。
  if (!removedPromotedCommand) return Object.freeze([]);

  // sendQueuedNow 过去在 Stop A 与 promoted command 入队之间没有 Core
  // 调度所有权，notification B 会抢先出队。匹配 command 出队与 lease 消费必须同一同步步。
  // removeById 成功后立即清空 foregroundPromotionLease，出队与消费同一同步步。
  this.foregroundPromotionLease = undefined;
  // 冻结数组：批次会被当作命令来源直接执行，调用方不得改写内容。
  return Object.freeze([removedPromotedCommand]);
}

function runtimeCommandInputId(command: RuntimeCommand): string | undefined {
  // 只有能携带 inputId 的三类命令可成为 promotion 目标；通知/子代理/设置轮没有输入身份。
  if (
    command.mode === "prompt" ||
    command.mode === "target-continuation" ||
    command.mode === "target-continuation-loop"
  ) {
    return command.options?.inputId;
  }
  return undefined;
}

export function hasActiveOrQueuedTurnWork(this: AgentRuntimeInternal): boolean {
  // busy 的唯一权威定义：前台执行 / drain 中 / 队列积压 / active turn / 启动预约 / 晋升租约。
  // 少判任何一项都会让 admission 误认为空闲，从而开出第二条 turn（不变量 #5）。
  return (
    this.foregroundPromotionLease !== undefined ||
    this.activeForegroundExecution !== undefined ||
    this.runtimeCommandDrainActive ||
    this.runtimeCommandQueue.hasPending() ||
    this.activeTurn !== undefined ||
    this.activeTurnStartReservation !== undefined
  );
}

export function acquireForegroundPromotionLease(
  this: AgentRuntimeInternal,
  options: {
    leaseId: string;
    mode: ForegroundPromotionLeaseMode;
    promotedInputId: string;
  },
): AcquireForegroundPromotionLeaseResult {
  const existing = this.foregroundPromotionLease;
  // lease 是排他预占：已存在时只允许原持有者幂等重入，其它调用方拿 conflict 而不是等待。
  if (existing) {
    return existing.leaseId === options.leaseId
      ? { kind: "acquired", leaseId: existing.leaseId }
      : { kind: "conflict", leaseId: existing.leaseId };
  }
  // idle-only 要求除"lease 自身"外全部空闲；这里复刻同一 busy 集，
  // 若与 hasActiveOrQueuedTurnWork 漂移，就会出现"以为空闲却抢占正在跑的 turn"。
  if (
    options.mode === "idle-only" &&
    (this.activeForegroundExecution !== undefined ||
      this.runtimeCommandDrainActive ||
      this.runtimeCommandQueue.hasPending() ||
      this.activeTurn !== undefined ||
      this.activeTurnStartReservation !== undefined)
  ) {
    // 返回 busy 而不是阻塞等待：调用方（queue promotion）据此放弃本次提升，避免跨层异步窗口。
    return { kind: "busy" };
  }
  // 写入租约即成为 busy 事实的一部分，直到 release 或被 dequeue 消费。
  this.foregroundPromotionLease = {
    leaseId: options.leaseId,
    promotedInputId: options.promotedInputId,
  };
  return { kind: "acquired", leaseId: options.leaseId };
}

export function releaseForegroundPromotionLease(
  this: AgentRuntimeInternal,
  leaseId: string,
): boolean {
  // 非持有者不得释放：误释放会让别人的预留命令被普通命令抢先出队。
  if (this.foregroundPromotionLease?.leaseId !== leaseId) return false;
  // 清租约与下面主动 drain 之间不能插入 await，否则中间态可被其它命令观察到。
  this.foregroundPromotionLease = undefined;
  // 启动前失败时 B 可能已在 lease 后等待；释放必须主动恢复 drain，不能等下一条 enqueue。
  void this.drainRuntimeCommandQueue();
  return true;
}

async function runPostCommandActiveTargetLoop(
  this: AgentRuntimeInternal,
  command: RuntimeCommand,
  abortSignal: AbortSignal,
): Promise<Awaited<ReturnType<AgentRuntimeInternal["continueActiveTargetLoop"]>> | null> {
  // 用户 prompt 结束后若目标仍 active，紧接着跑续跑循环；结果会覆盖 turn 结果，
  // 否则调用方只看到"这一轮结束"，不知道 goal 其实还没跑完。
  if (command.mode === "prompt" && command.options?.continueActiveTargetAfterTurn === true) {
    return await runActiveTargetContinuationLoop.call(this, {
      abortSignal,
      inputId: command.options.inputId,
      traceContext: command.options.traceContext ?? command.traceContext,
      trigger: "user-prompt",
      verifyBeforeFirstContinue: true,
    });
  }
  // 通知批同样可能推动 goal：任务完成本身就是续跑触发源之一。
  if (command.mode === "task-notification") {
    // 续跑失败不能反过来让已消费的通知批判失败：只记 warn，命令仍算消费成功。
    try {
      return await runActiveTargetContinuationLoop.call(this, {
        abortSignal,
        traceContext: command.traceContext,
        trigger: "task-notification",
        verifyBeforeFirstContinue: true,
      });
    } catch (error) {
      this.logger?.warn("Post-command goal continuation failed", {
        ...traceContextToLogContext(command.traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "target.continuation.after_command_failed",
        module: "core.runtime",
      });
    }
  }
  // 子代理回复/设置轮不触发目标续跑，返回 null 让调用方回落到原结果。
  return null;
}

async function runRuntimeCommand(
  this: AgentRuntimeInternal,
  command: RuntimeCommand,
): Promise<void> {
  // 单条通知也走批量实现，保持落库/合并/续跑只有一条代码路径。
  if (command.mode === "task-notification") {
    await runTaskNotificationBatch.call(this, [command]);
    return;
  }
  // 消费前二次校验分支代际（不变量 #6）：入队之后才发生的 rewind 必须在这里拦下。
  if (isStaleBranchRuntimeCommand(this, command)) return;
  // 建立前台执行槽：它既是 Stop 的取消域，也是 busy 判定的一部分（不变量 #5）。
  const foregroundExecution = beginForegroundExecution.call(this, command);
  try {
    if (command.mode === "prompt") {
      // 两阶段取消的第二段：命令已出队，取消标记在此兑现（不变量 #5）。
      if (this.runtimeCommandQueue.consumeCancelPending(command.id)) {
        // 必须释放预约，否则该 runtime 会一直被判 busy，后续 prompt 全部排队或被拒。
        if (command.startReservation) this.releaseTurnStart(command.startReservation.turnId);
        // 取消按错误回给提交方：调用方据此结束等待，且不会把这一轮当成功。
        command.reject(createTurnCancelledError(command.options?.abortSignal?.reason));
        return;
      }
      try {
        // 真正的模型轮在 reservation 保护下启动；执行期状态（queueAutoDrain 等）由 turn 自己维护。
        const result = await this.executeTurnCommand(
          command.input,
          command.attachments,
          {
            ...command.options,
            abortSignal: foregroundExecution.controller.signal,
          },
          command.startReservation,
        );
        // 续跑结果优先于本轮结果：对调用方来说这一次提交是"整个任务"，不是"一次请求"。
        const continuationResult = await runPostCommandActiveTargetLoop.call(
          this,
          command,
          foregroundExecution.controller.signal,
        );
        // 一次性收口：resolve 之后提交 Promise 结算，队列对该命令不再有任何所有权。
        command.resolve(continuationResult ?? result);
      } finally {
        // 成功/失败/取消都要清标记，残留标记会让下一条同 id 命令被误取消。
        this.runtimeCommandQueue.clearCancelPending(command.id);
      }
      return;
    }
    // 目标续跑与 loop 共用同一前台执行槽和取消语义，差异只在入参。
    if (command.mode === "target-continuation") {
      // 与 prompt 同理：已出队命令只能靠标记识别取消，不能依赖 removeById 成功。
      if (this.runtimeCommandQueue.consumeCancelPending(command.id)) {
        command.reject(createTurnCancelledError(command.options.abortSignal?.reason));
        return;
      }
      try {
        const result = await executeTargetContinuationCommand.call(this, {
          ...command.options,
          abortSignal: foregroundExecution.controller.signal,
        });
        command.resolve(result);
      } finally {
        this.runtimeCommandQueue.clearCancelPending(command.id);
      }
      return;
    }
    if (command.mode === "target-continuation-loop") {
      // loop 版由队列自身推进 goal；出队后兑现取消，避免同一条目标链路被跑两遍。
      if (this.runtimeCommandQueue.consumeCancelPending(command.id)) {
        command.reject(createTurnCancelledError(command.options.abortSignal?.reason));
        return;
      }
      try {
        const result = await runActiveTargetContinuationLoop.call(this, {
          ...command.options,
          abortSignal: foregroundExecution.controller.signal,
          yieldBeforeFirstContinue: false,
        });
        command.resolve(result);
      } finally {
        this.runtimeCommandQueue.clearCancelPending(command.id);
      }
      return;
    }
    if (command.mode === "subagent-message") {
      // 子代理回复是 model-only 输入：先落一条可见性为 model 的消息，再跑一次独立 turn。
      this.logger?.debug("Subagent response command started", {
        ...traceContextToLogContext(command.traceContext),
        agentId: command.agentId,
        commandId: command.id,
        event: "subagent.response.command_started",
        messageLength: command.messageLength,
        module: "core.runtime",
        queueSize: this.runtimeCommandQueue.size(),
        responseId: command.responseId,
        summary: command.summary.slice(0, 200),
      });
      const messageId = await persistSubagentMessageCommand.call(this, command);
      // skipInputRecord/skipUserPromptSubmitHooks 因为消息已由上面 persist 落了账本，
      // 再走一遍会重复计入输入账本、并重复触发用户提交 hook。
      await this.executeTurnCommand(command.text, undefined, {
        offPeakExecutionId: command.offPeakExecutionId,
        abortSignal: foregroundExecution.controller.signal,
        inputSource: "subagent_message",
        inputVisibility: "model-only",
        recordedInputMessageId: messageId,
        skipInputRecord: true,
        skipUserPromptSubmitHooks: true,
        traceContext: command.traceContext,
      });
      this.logger?.debug("Subagent response command completed", {
        ...traceContextToLogContext(command.traceContext),
        agentId: command.agentId,
        commandId: command.id,
        event: "subagent.response.command_completed",
        messageId,
        module: "core.runtime",
        queueSize: this.runtimeCommandQueue.size(),
        responseId: command.responseId,
      });
      return;
    }
    if (command.mode === "control-only-turn") {
      // 设置轮不进入模型请求：只改配置并留一个空 turn 边界，维持轮次互斥（不变量 #5）。
      await runControlOnlyTurnCommand.call(this, command);
      return;
    }
  } catch (error) {
    // 只有自带等待方的三类命令能把错误回传；其余命令的错误无人接收，只能记日志。
    if (
      command.mode === "prompt" ||
      command.mode === "target-continuation" ||
      command.mode === "target-continuation-loop"
    ) {
      // 失败与取消走同一收口路径，提交方不必区分（错误类型已在 turn 事件里保留）。
      command.reject(error);
      return;
    }
    // 通知/子代理/设置轮没有调用方 Promise，只能靠日志留痕，不能重抛打断整轮排空。
    this.logger?.warn("Runtime command failed", {
      ...traceContextToLogContext(command.traceContext),
      commandMode: command.mode,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "runtime_command.failed",
      module: "core.runtime",
    });
  } finally {
    // 释放前台执行槽必须无条件执行，否则 Stop 失效、runtime 会永久 busy（不变量 #5）。
    finishForegroundExecution.call(this, foregroundExecution);
  }
}

async function runTaskNotificationBatch(
  this: AgentRuntimeInternal,
  commands: readonly TaskNotificationRuntimeCommand[],
): Promise<void> {
  // 出队后、落库前再筛一次：stale（rewind 之前）与被抑制（同任务已有更新）的通知不再注入模型。
  const eligibleCommands = commands.filter(
    (command) =>
      !isStaleBranchRuntimeCommand(this, command) &&
      !shouldSuppressTaskNotificationRuntimeCommand.call(this, command),
  );
  const firstCommand = eligibleCommands[0];
  // 整批被过滤时直接返回：命令已出队且没有等待方，不需要额外收口。
  if (!firstCommand) return;

  // 整批共用一次前台执行：batch 是一条模型轮，不能按单条命令各建取消域。
  const foregroundExecution = beginForegroundExecution.call(this, firstCommand);
  const commandIds = eligibleCommands.map((command) => command.id);
  try {
    // durable 落库先于模型请求；messageId 之后作为 recordedInputMessageId 复用，避免二次记录。
    const persisted = await persistBackgroundTaskNotificationBatch.call(
      this,
      eligibleCommands as [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
    );
    this.logger?.info?.("Background task notification batch started", {
      ...traceContextToLogContext(firstCommand.traceContext),
      batchSize: eligibleCommands.length,
      commandId: firstCommand.id,
      commandIds,
      event: "background_task.notification.batch_started",
      messageId: persisted.messageId,
      module: "core.runtime",
    });
    // 整批合成一条 model-only 输入：模型侧看到的是"多个任务结果"，而不是一条用户消息。
    await this.executeTurnCommand(persisted.text, undefined, {
      offPeakExecutionId: firstCommand.offPeakExecutionId,
      // wake 缺 inputId，telemetry 借用了持久化 msg_*，与普通 main turn 分叉。
      // 每个独立 batch 使用同一 UUID v7 规则；持久化消息仍使用 recordedInputMessageId。
      inputId: uuidv7(),
      abortSignal: foregroundExecution.controller.signal,
      // 批次展示 metadata 只保留代表任务，composition 必须检查整批，不能被首个 Bash 任务遮蔽。
      backgroundSubagentResultConsumed: eligibleCommands.some(
        (command) => command.originMeta?.backgroundSource === "subagent",
      ),
      // 同一规则的 workflow 维度：run 的完成 / 提问通知在批里。
      workflowResultConsumed: eligibleCommands.some(
        (command) => command.originMeta?.backgroundSource === "workflow",
      ),
      ...(persisted.backgroundSource ? { backgroundSource: persisted.backgroundSource } : {}),
      inputSource: "background_task",
      inputVisibility: "model-only",
      ...(persisted.originMeta ? { originMeta: persisted.originMeta } : {}),
      recordedInputMessageId: persisted.messageId,
      skipInputRecord: true,
      skipUserPromptSubmitHooks: true,
      traceContext: firstCommand.traceContext,
    });
    // 通知批结束后同样给 goal 一次续跑机会；续跑失败在内部被吞掉，不影响本批已落库的事实。
    await runPostCommandActiveTargetLoop.call(
      this,
      firstCommand,
      foregroundExecution.controller.signal,
    );
    this.logger?.info?.("Background task notification batch completed", {
      ...traceContextToLogContext(firstCommand.traceContext),
      batchSize: eligibleCommands.length,
      commandId: firstCommand.id,
      commandIds,
      event: "background_task.notification.batch_completed",
      messageId: persisted.messageId,
      module: "core.runtime",
    });
  } catch (error) {
    // 批量失败只降级为日志：抛出会中断整个 drain，让一条坏通知卡住后面所有命令。
    this.logger?.warn("Background task notification batch failed", {
      ...traceContextToLogContext(firstCommand.traceContext),
      batchSize: eligibleCommands.length,
      commandId: firstCommand.id,
      commandIds,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "background_task.notification.batch_failed",
      module: "core.runtime",
    });
  } finally {
    // 无论成功失败都释放槽位，下一次 drain 才能重新占用并继续排空。
    finishForegroundExecution.call(this, foregroundExecution);
  }
}

function beginForegroundExecution(
  this: AgentRuntimeInternal,
  command: RuntimeCommand,
): ActiveForegroundExecutionState {
  // 每条 runtime command 一个独立 controller：Stop 只取消当前这条，不波及其它命令。
  const controller = new AbortController();
  const parentAbortSignal = runtimeCommandAbortSignal(command);
  const abortFromParent = (): void => {
    controller.abort(parentAbortSignal?.reason);
  };
  // 父信号可能在建槽前就已取消（提交侧 abort 先到）；不补这一步，命令会以"未取消"身份跑完。
  if (parentAbortSignal?.aborted) {
    abortFromParent();
  } else {
    // once 监听：abort 只会兑现一次，长会话里否则会不断累积监听器。
    parentAbortSignal?.addEventListener("abort", abortFromParent, { once: true });
  }
  // foregroundExecutionId 直接取命令 id：Stop 用它做 expected 校验，防止停错执行。
  const state: ActiveForegroundExecutionState = {
    controller,
    disposeParentAbort: () => {
      parentAbortSignal?.removeEventListener("abort", abortFromParent);
    },
    foregroundExecutionId: String(command.id),
    // 默认不保留队列自动排空：用户 Stop 的语义是"连后面的排队输入也一起停下"。
    preserveQueueAutoDrainOnCancel: false,
  };
  // 旧 Stop 只持有 bootstrap 外层 controller，而 goal verifier/continuation
  // 已经越过普通 turn 生命周期。取消域必须覆盖整条 runtime command，才能在两个阶段
  // 的交界处仍命中同一次前台执行。
  // 写入即 busy 事实：admission、Stop、队列提升都以它为准（不变量 #5）。
  this.activeForegroundExecution = state;
  return state;
}

function finishForegroundExecution(
  this: AgentRuntimeInternal,
  state: ActiveForegroundExecutionState,
): void {
  // 先解绑父 abort 监听，避免已结束的执行仍被上游取消信号牵连。
  state.disposeParentAbort();
  // 只清自己：期间可能已被新的前台执行覆盖，误清会让新执行的 Stop 失效。
  if (this.activeForegroundExecution === state) {
    this.activeForegroundExecution = undefined;
  }
}

function runtimeCommandAbortSignal(command: RuntimeCommand): AbortSignal | undefined {
  // 只有 prompt/续跑携带可传播的父 abortSignal；通知/子代理/设置轮的取消由队列标记负责。
  if (
    command.mode === "prompt" ||
    command.mode === "target-continuation" ||
    command.mode === "target-continuation-loop"
  ) {
    return command.options?.abortSignal;
  }
  return undefined;
}

export function stopActiveForegroundExecution(
  this: AgentRuntimeInternal,
  options: StopActiveForegroundExecutionOptions = {},
): StopActiveForegroundExecutionResult {
  const active = this.activeForegroundExecution;
  // 无执行或已取消都返回 idle：Stop 必须幂等，重复点击不应产生错误态。
  if (!active || active.controller.signal.aborted) {
    return { kind: "idle" };
  }
  // expected 校验挡住"停错对象"：调用方手里的 id 已过期时返回 mismatch，由它自己刷新。
  if (
    options.expectedForegroundExecutionId !== undefined &&
    options.expectedForegroundExecutionId !== active.foregroundExecutionId
  ) {
    return {
      kind: "mismatch",
      activeForegroundExecutionId: active.foregroundExecutionId,
    };
  }
  // sendQueuedNow 的内部抢占过去与用户手动 Stop 共用同一种 cancelled，
  // turn catch 因而把 queueAutoDrain 关闭。把调用意图固定在当前 foreground
  // execution 上，保证超时后迟到的 TurnComplete 仍能保留原队列授权。
  active.preserveQueueAutoDrainOnCancel = options.preserveQueueAutoDrainOnCancel === true;
  // 用真实 Error 作为 reason：下游 turn 才能归一化成 TurnCancelled，而不是 undefined。
  active.controller.abort(new Error(options.reason ?? "foreground execution stopped"));
  return {
    kind: "stopped",
    foregroundExecutionId: active.foregroundExecutionId,
  };
}

export function getActiveForegroundExecutionId(this: AgentRuntimeInternal): string | undefined {
  // 只暴露 id、不暴露 controller：调用方必须经 stopActiveForegroundExecution 才能取消。
  return this.activeForegroundExecution?.foregroundExecutionId;
}
