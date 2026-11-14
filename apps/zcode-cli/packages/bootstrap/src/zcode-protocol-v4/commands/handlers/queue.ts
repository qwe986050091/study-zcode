// queue 命令组：deleteQueueItem / editQueueItem / reorderQueueItem / setAutoDrain /
// setFollowupMode / sendQueuedNow（原生重做，组文件样板见 session-flow.ts）。
// 决策逻辑直驱 core（app 层 queue API，批1 已搬运）；queueItemId ≡ core 的
// pendingInputId（同一 id 空间，无需翻译）。queue 变更的事件由 core runtime 自发，
// 经 gateway ingest 推进 v4 投影——本组不需要 legacy 广播钩子。
//
// dispatchState 口径（与 core queue reducer 同源）：
//   queued    可被 auto-drain / 手动 sendQueuedNow 提升；只有 queued 才允许自动提升；
//   reserved  已被某个 reservationId 占位，防并发提升；失败可回滚回 queued；
//   promoting 已开始/已启动 turn；此时不得释放租约或回滚，否则另一端会重复执行。
// admissionSeq 是排队顺序的权威（不是 issuedAt）；sourceCommandId 是幂等与
// optimistic overlay 的收口锚点，提升全程不得替换成 promotion commandId。
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { isHighspeedProviderId } from "@zcode/shared";
import { createModelExecutionContext } from "../../../session-execution/index.js";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { inputIntentMetadataFromQueueItem } from "../input-intent.js";
import { startPromptTurn } from "../prompt-turn.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import {
  applyGoalCommand,
  parseGoalObjectiveFromCommandText,
  startManualCompact,
  V4GoalCompactRejectedError,
} from "./goal-compact.js";
import { resolveSessionFallbackModelSelection } from "../input-admission.js";
import { preemptActiveTurnAndWait } from "./session-flow.js";
import { V4CommandNoopError } from "../../v4-gateway.js";
import { commandExecutionContextOf } from "../executor.js";
export { V4SessionIdleTimeoutError } from "./session-flow.js";

/** sendQueuedNow 在投影里查不到该项原文（已被 drain/删除或 id 无效）→ 拒绝。 */
/**
 * 提升时找不到完整 QueueItem（已被 drain/删除或 id 无效）→ 拒绝。
 * 禁止退化成 text-only 重发：那样会丢 sourceCommandId/附件/client/order，
 * 产生一条无法与原 overlay 收口的新输入。
 */
export class V4QueueItemTextUnavailableError extends Error {
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow queue item text unavailable: ${queueItemId}`);
    this.name = "V4QueueItemTextUnavailableError";
  }
}

/**
 * 并发提升冲突：该项已被其他 reservation 占位（或 reservation 在 promote 前失效）。
 * 拒绝但不破坏队列，原项保持原位；客户端可重试或等待自动 drain。
 */
export class V4QueueItemReservedError extends Error {
  readonly reasonCode = "guard.queueItemReserved";
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow queue item already reserved: ${queueItemId}`);
    this.name = "V4QueueItemReservedError";
  }
}

/**
 * turn 已启动但删除 queue 项失败：这是「已执行但收口不完整」的故障态。
 * 必须显式失败（不能 pretend accepted），保留 promoting 供 resync 处理；
 * 否则 UI 会看到队列项仍在，而实际执行已发生。
 */
export class V4QueuePromotionCommitError extends Error {
  readonly reasonCode = "fault.command.queuePromotionCommitFailed";
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow started but failed to remove queue item: ${queueItemId}`);
    this.name = "V4QueuePromotionCommitError";
  }
}

/**
 * typed maintenance intent（如 compact）不可编辑：改文本会保留 commandKind 却改变
 * 用户看到的语义，消费时产生与文案不一致的副作用，因此直接拒绝。
 */
export class V4QueueItemNotEditableError extends Error {
  readonly reasonCode = "guard.queueItemNotEditable";
  constructor(queueItemId: string) {
    super(`v4 queue item is not editable: ${queueItemId}`);
    this.name = "V4QueueItemNotEditableError";
  }
}

/**
 * 提升租约不可用：另一条提升持有 lease，或 Core 非 idle 且本次不允许抢占。
 * 拒绝时不改动队列项（reservation 尚未建立），可安全重试。
 */
export class V4QueuePromotionLeaseUnavailableError extends Error {
  readonly reasonCode = "guard.queuePromotionBusy";
  constructor(activeLeaseId?: string) {
    super(
      activeLeaseId
        ? `v4 queue promotion is owned by another lease: ${activeLeaseId}`
        : "v4 queue promotion requires an idle Core runtime",
    );
    this.name = "V4QueuePromotionLeaseUnavailableError";
  }
}

/**
 * deleteQueueItem：删除一条排队输入。
 * 幂等语义：未命中（并发 drain/重复删除）→ noop（queue.itemMissing），不能报 accepted，
 * 否则客户端可能把已消费的旧投影恢复进 composer。
 * 副作用：从 core 队列移除并清掉对应的内存加速执行包；不可回滚。
 */
async function deleteQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["deleteQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
  // 未命中（并发 drain/重复删除的竞态）= noop，不算失败；留 warn 供观测。
  const removed = await record.app.removeQueueItem(payload.queueItemId);
  if (!removed) {
    host.logger?.warn?.("v4 deleteQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
    // 未命中曾返回 undefined，gateway 会把并发 drain/重复删除误报为 accepted；
    // queue 撤回编辑因此可能把已消费的旧投影再次恢复到 composer。
    throw new V4CommandNoopError("queue.itemMissing");
  }
  if (queueItem) {
    host.deleteQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
  }
  return undefined;
}

/**
 * editQueueItem：原地改文本（core reducer 保位更新，不产生新 queue 项）。
 * compact 等 typed maintenance 项不可编辑；未命中 → warn 但 still accepted（
 * 与 delete 不同：编辑丢失不会让用户误以为可撤回已消费输入，故不升级为 noop）。
 * 副作用：仅 core queue 内存状态，不触发 projection 之外的 durable 写入。
 */
async function editQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["editQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
  if (queueItem?.kind === "compact") {
    // compact 是 typed maintenance intent；允许改文本会把它伪装成普通输入，
    // 但 commandKind 仍是 compact，消费时产生与 UI 文案不一致的压缩副作用。
    throw new V4QueueItemNotEditableError(payload.queueItemId);
  }
  // core reducer 同 id 原地更新（保位）；未命中 = noop + warn（同 delete 的竞态语义）。
  const edited = await record.app.editQueueItem(payload.queueItemId, payload.newText);
  if (!edited) {
    host.logger?.warn?.("v4 editQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
  }
  return undefined;
}

/**
 * reorderQueueItem：把某项移到 beforeQueueItemId 之前（null = 队尾）。
 * 只改顺序，不改 admissionSeq 以外的身份；未命中 → warn，不伪造移动成功。
 */
async function reorderQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["reorderQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  // beforeQueueItemId = null → 移到队尾（协议与 app API 同形，直传）。
  const moved = await record.app.reorderQueueItem(payload.queueItemId, payload.beforeQueueItemId);
  if (!moved) {
    host.logger?.warn?.("v4 reorderQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
  }
  return undefined;
}

/**
 * setAutoDrain：切换队列自动消费授权位。
 * 开启时不能只写标志：idle 且已有暂停队列时没有 active turn 替它启动队首，
 * 因此复用宿主的 ready hook（busy 时只武装，idle 时按 sendQueuedNow 原子路径提升）。
 * 关闭只改授权位，不动已有项。副作用：core 状态 + 可能的立即提升。
 */
async function setAutoDrain(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setAutoDrain"];
  const record = requireRecord(host, envelope.sessionId);
  await record.app.setQueueAutoDrain(payload.autoDrain);
  if (payload.autoDrain) {
    // 不能只翻授权位：idle 暂停队列没有 active turn 可替它启动队首。复用 CLI
    // 权威 ready hook，busy 时只武装，idle 时立即按 sendQueuedNow 原子路径提升。
    await host.afterLegacyStateMutation?.(record, "queue_auto_drain_resumed");
  }
  return undefined;
}

/**
 * setFollowupMode：切换「本轮结束后是否继续跟进」的会话级策略。
 * 直驱 core，事件由 core 自发；无额外广播、无队列改动。
 */
async function setFollowupMode(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setFollowupMode"];
  const record = requireRecord(host, envelope.sessionId);
  await record.app.setFollowupMode(payload.mode);
  return undefined;
}

/**
 * sendQueuedNow：手动/自动提升一条排队输入，是 queue 组唯一有 turn 副作用的命令。
 * ACK 语义：accepted 只表示提升流程已走完（turn 已启动且 queue 项已删除），
 * 不表示模型输出已产生；客户端仍以 projection 收敛。
 * 幂等与顺序：reservationId=commandId，提升全程沿用原 item 的 sourceCommandId；
 * 只有 queued 可提升，reserved/promoting 一律拒绝（reserved 由本命令自己建立）。
 * 副作用顺序（不可交换）：getQueueItem 完整性 → 租约 → reserve → stop barrier →
 * markPromoting → start/goal/compact → removeQueueItem。
 * 失败：start 之前任一步失败回滚 reservation（原项留在 queued）；start 之后失败
 * 显式报 queuePromotionCommitFailed，保留 promoting 防重复执行，绝不静默重发。
 */
/**
 * sendQueuedNow：reserve → Core promotion lease → stop barrier → start/promote → remove。
 * - 必须读取完整 QueueItem；text-only fallback 会丢 sourceCommandId/附件/client/order，禁止使用。
 * - stop 复用 session-flow 的语义：goal-pause barrier（否则 verifier 未收 abort 时
 *   queue 无法 drain）→ abort；只 abort 不 await。
 * - 等 idle 语义：锁由后台 turn 的 finally 释放（见 prompt-turn 文件头 3），
 *   abort 后立刻重发会撞 "A prompt is already running"，必须轮询等锁释放。
 * - start 之前任一步失败都 release reservation，原项原位保留；start 成功后才 remove。
 */
async function sendQueuedNow(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["sendQueuedNow"];
  const record = requireRecord(host, envelope.sessionId);
  const reservationId = envelope.commandId;
  const autoDrainPromotion = commandExecutionContextOf(envelope)?.autoDrainPromotion === true;
  const foregroundPromotionLeaseId = `queue-promotion:${reservationId}`;
  const traceOptions = { traceContext: record.traceContext };
  let queueItemReserved = false;
  let startAdmitted = false;
  let leaseReleaseOwnedByBackground = false;
  let foregroundPromotionLeaseAcquired = false;
  try {
    const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
    if (queueItem === null) {
      throw new V4QueueItemTextUnavailableError(payload.queueItemId);
    }
    const acquirePromotionLease = (mode: "after-current" | "idle-only"): void => {
      const leaseResult = record.app.runtime.acquireForegroundPromotionLease({
        leaseId: foregroundPromotionLeaseId,
        mode,
        promotedInputId: queueItem.sourceCommandId,
      });
      if (leaseResult.kind !== "acquired") {
        throw new V4QueuePromotionLeaseUnavailableError(
          leaseResult.kind === "conflict" ? leaseResult.leaseId : undefined,
        );
      }
      foregroundPromotionLeaseAcquired = true;
    };
    if (autoDrainPromotion) acquirePromotionLease("idle-only");
    if (!(await record.app.reserveQueueItem(payload.queueItemId, reservationId, traceOptions))) {
      throw new V4QueueItemReservedError(payload.queueItemId);
    }
    queueItemReserved = true;
    const objective =
      queueItem.kind === "sendGoalCommand"
        ? parseGoalObjectiveFromCommandText(queueItem.text)
        : undefined;
    if (queueItem.kind === "sendGoalCommand" && !objective) {
      throw new V4GoalCompactRejectedError("emptyObjective", "Usage: /goal <objective>");
    }
    const attachments =
      queueItem.kind === "compact"
        ? undefined
        : await mapAttachmentRefsToTurnAttachments(record.app, queueItem.attachments);
    if (!autoDrainPromotion) acquirePromotionLease("after-current");
    let preempted = false;
    if (!autoDrainPromotion) {
      preempted = await preemptActiveTurnAndWait(host, record, {
        abortMessage: "v4 sendQueuedNow preempts active turn",
        goalPausedMutationReason: "send_queued_now_goal_paused",
        preserveQueueAutoDrainOnCancel: true,
      });
    }
    if (
      !(await record.app.markQueueItemPromoting(payload.queueItemId, reservationId, traceOptions))
    ) {
      throw new V4QueueItemReservedError(payload.queueItemId);
    }
    if (queueItem.kind === "compact") {
      await startManualCompact(host, record, queueItem.sourceCommandId, foregroundPromotionLeaseId);
      leaseReleaseOwnedByBackground = true;
    } else if (queueItem.kind === "sendGoalCommand") {
      const intent = inputIntentMetadataFromQueueItem(queueItem, objective ?? queueItem.text);
      const goalContinuationWillStart = !(
        intent.planEnabled ??
        record.app.runtime?.getPlanEnabled?.() ??
        record.app.getMode?.() === "plan"
      );
      await applyGoalCommand(host, record, {
        displayText: queueItem.text,
        foregroundPromotionLeaseId,
        inputId: queueItem.sourceCommandId,
        intent,
        objective: objective!,
      });
      leaseReleaseOwnedByBackground = goalContinuationWillStart;
    } else {
      const intent = inputIntentMetadataFromQueueItem(queueItem, queueItem.text);
      // 手动提升允许 Renderer 为同一张卡补一份新执行材料；卡不同一律忽略，避免跨卡换凭据。
      const refreshedHighspeedMatchesQueue =
        payload.highspeedMeta !== undefined &&
        queueItem.highspeed !== undefined &&
        payload.highspeedMeta.cardId === queueItem.highspeed.cardId &&
        payload.highspeedMeta.taskId === queueItem.highspeed.taskId;
      const ordinarySelection = isHighspeedProviderId(intent.modelSelection?.providerId)
        ? resolveSessionFallbackModelSelection(record)
        : intent.modelSelection;
      // Bug 根因：旧版本已把临时 Highspeed Selection 持久化到 QueueItem。进程升级后
      // execution bundle 必然丢失；若不在提升边界迁移，会继续用内部 Provider 并直接报错。
      intent.modelSelection = ordinarySelection;
      if (refreshedHighspeedMatchesQueue && payload.highspeedMeta) {
        intent.highspeed = payload.highspeedMeta;
      }
      // 凭据不入队列持久化面：先用本次补供的完整 bundle，其次取 CLI 内存暂存。
      const refreshedExecution =
        refreshedHighspeedMatchesQueue && payload.modelSelection && payload.modelExecution
          ? { modelSelection: payload.modelSelection, modelExecution: payload.modelExecution }
          : undefined;
      const stagedExecution =
        refreshedExecution ??
        host.readQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
      // Bug 根因：QueueItem.modelSelection 同时承担普通模型和临时加速模型，导致编辑恢复与
      // 降级目标互相污染。提升边界才临时应用 bundle；失败时保留队列项自己的普通 Selection。
      const highspeedStillValid =
        intent.highspeed !== undefined &&
        intent.highspeed.expiresAt > Date.now() &&
        stagedExecution !== undefined &&
        isHighspeedProviderId(stagedExecution.modelSelection.providerId);
      if (highspeedStillValid && stagedExecution) {
        intent.modelSelection = stagedExecution.modelSelection;
      } else if (intent.highspeed) {
        if (intent.highspeed.expiresAt > Date.now()) {
          host.logger?.warn?.("v4 queued Highspeed execution unavailable; using queued model", {
            cardId: intent.highspeed.cardId,
            queueItemId: queueItem.queueItemId,
            reason: "execution_missing",
            sessionId: record.app.sessionId,
          });
        }
        delete intent.highspeed;
        host.deleteQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
      }
      // 退回目标统一为上面的普通 Selection（规则 9）。新队列项的 bundle target 本来就相同；
      // 旧队列项“立即发送”且服务仍持有同一张卡时，Renderer 以持久化的临时 Provider 重新准备，
      // target 也是临时 Provider，这里改回，避免降级仍落到内部 Provider。
      const turnExecution =
        highspeedStillValid && stagedExecution
          ? {
              ...stagedExecution.modelExecution,
              ...(stagedExecution.modelExecution.selectionFallback
                ? {
                    selectionFallback: {
                      ...stagedExecution.modelExecution.selectionFallback,
                      target: ordinarySelection,
                    },
                  }
                : {}),
            }
          : undefined;
      const started = await startPromptTurn(host, record, {
        content: queueItem.text,
        inputId: queueItem.sourceCommandId,
        // 手动提升若实际抢占旧执行，同样是 human steer；自动 drain 不产生此标记。
        ...(preempted && !attachments?.length ? { inputPresentation: "user_steer" as const } : {}),
        intent,
        requireIdle: true,
        toolDisallowlist: queueItem.toolDisallowlist,
        ...(turnExecution ? { modelExecution: createModelExecutionContext(turnExecution) } : {}),
        ...(attachments ? { attachments } : {}),
      });
      // 旧 fake app/兼容命令可能不返回 admission receipt；真实 app 已在 Core admission
      // 处完成 started 校验。只有明确 queued/rejected 才能判定 promotion 未启动。
      if (started.admission.kind === "queued" || started.admission.kind === "rejected") {
        throw new V4QueuePromotionLeaseUnavailableError();
      }
      // 凭据已随本轮冻结进 Core；启动成功后立刻销毁暂存副本，失败路径保留以便重试仍能加速。
      host.deleteQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
    }
    // 提交点：一旦置位，finally 不再允许回滚 reservation（回滚会让队列项回到 queued
    // 并被另一端再次提升，造成同一输入被执行两次）。
    startAdmitted = true;
    const removed = await record.app.removeQueueItem(payload.queueItemId, {
      reason: "promoted",
      reservationId,
      ...traceOptions,
    });
    if (!removed) throw new V4QueuePromotionCommitError(payload.queueItemId);
    if (queueItem.kind === "compact") {
      // no-op compact 可能在 promoting 项删除前就完成；它的 ready hook 此时看见的
      // 仍是 dispatch=promoting，无法继续消费下一条 typed intent。删除后再过一次 mutation
      // 边界可关闭这个竞态；正常慢 compact 因 active controller 存在不会重复 drain。
      await host.afterLegacyStateMutation?.(record, "queue_compact_promoted");
    }
    return undefined;
  } finally {
    if (foregroundPromotionLeaseAcquired && !leaseReleaseOwnedByBackground) {
      record.app.runtime.releaseForegroundPromotionLease(foregroundPromotionLeaseId);
    }
    // start 一旦 admitted 就不能 release，否则 remove 异常时另一端会重复执行；此时保持
    // promoting 供显式 resync/故障处理。start 前失败则安全回滚到 queued。
    if (queueItemReserved && !startAdmitted) {
      await record.app.releaseQueueItemReservation(
        payload.queueItemId,
        reservationId,
        traceOptions,
      );
    }
  }
}

/** 本组原生命令注册表（队列与自动消费），供 handlers/index.ts 合并。 */
export const queueHandlers = {
  deleteQueueItem,
  editQueueItem,
  reorderQueueItem,
  setAutoDrain,
  setFollowupMode,
  sendQueuedNow,
};
