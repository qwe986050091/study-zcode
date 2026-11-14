// ============================================================
// 单次尝试的进程级请求准入
// 定位：把"provider 真正看到的在飞请求数"限制在进程内 cap；退避 sleep 期间不持票。
// 输入：可选 admission 端口、模型目标、abortSignal、排队/准入回调。
// 输出：AttemptAdmission（ticket 可缺席，release 幂等）。
// 副作用：可能排队等待（异步阻塞）、回调 onQueued/onAdmitted（发状态事件）。
// 失败语义：signal abort 时以 signal.reason reject；无 admission 端口时直接返回空实现，不改变 runner 行为。
// 不变量：票据在尝试结束（成功/失败/抛出/消费者弃流）必须归还；release 幂等（finally 与 sleep 前两处都调）。
// ============================================================

import type {
  ModelRequestAdmission,
  ModelRequestAdmissionTicket,
  ModelRequestTarget,
} from "@zcode/contracts";

/**
 * 一次尝试的准入。
 *
 * runner 在每次尝试**发出前** `admitAttempt`，拿到票据后才发请求；尝试结束（成功、失败、抛出、消费者
 * 提前放弃流）即 `release`——退避 sleep 期间不持票，所以进程级 cap 约束的是 provider 真正看到的在飞
 * 请求数。票据同时是该尝试的状态事件汇：`publishModelStatus` 把该尝试的事件也投递给它（见
 * `statusPublishOptions`），治理器据此判定结果；`release` 只是兜底，幂等。
 *
 * 请求没有 `modelRequestAdmission` 时返回一个空实现：调用点不必分叉，runner 行为逐字不变。
 */
export interface AttemptAdmission {
  /** 准入票据；请求没有准入端口时缺席（此时 publish 不转投）。 */
  readonly ticket?: ModelRequestAdmissionTicket;
  /** 归还槽位；幂等（finally 与「退避 sleep 之前」两处都会调）。 */
  release(): void;
}

const NO_ADMISSION: AttemptAdmission = { release() {} };

/**
 * 等待准入。先试同步快路径 `tryAcquire`；未命中才排队 `acquire`，并在两端回调 `onQueued` / `onAdmitted`
 * （runner 据此发 `model_request_queued` / `model_request_admitted`）。没有快路径的端口分不清
 * 「排了队」与「立即放行」，所以不回调。`signal` 被 abort 时 reject（以 `signal.reason`，与 `sleep` 的
 * abort 错误同一形状，由调用方按 cancelled 归类）。
 */
export async function admitAttempt(input: {
  admission?: ModelRequestAdmission;
  model: ModelRequestTarget;
  signal?: AbortSignal;
  onQueued?: () => Promise<void>;
  onAdmitted?: (queuedMs: number) => Promise<void>;
}): Promise<AttemptAdmission> {
  if (input.admission === undefined) return NO_ADMISSION;
  const hasFastPath = typeof input.admission.tryAcquire === "function";
  let ticket = hasFastPath ? input.admission.tryAcquire!({ model: input.model }) : undefined;
  if (ticket === undefined) {
    const queuedAt = Date.now();
    if (hasFastPath) await input.onQueued?.();
    ticket = await input.admission.acquire({
      model: input.model,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (hasFastPath) await input.onAdmitted?.(Date.now() - queuedAt);
  }
  let released = false;
  return {
    ticket,
    release() {
      if (released) return;
      released = true;
      ticket.release();
    },
  };
}
