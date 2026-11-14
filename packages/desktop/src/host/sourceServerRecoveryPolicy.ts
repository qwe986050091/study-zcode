// Source Server 自动恢复的终态判定与「关闭事件」映射。
//
// 用途：windowRemoteConnectionRegistry 在物理连接断开时只拿到一个 close event；本文件把
// Host 侧连接状态机（retrying / offline / needs-install / ...）翻译成上层可理解的
// recoverable / reasonCode / retryable 字段，决定是否继续自动重连以及手机侧如何提示。
// 判据口径：只有 retrying 视为「可恢复」；needs-install、needs-upgrade、
// identity-change-pending 以及 retryable=false 的 failed 属于终态，不再自动恢复。
// 失败语义：无异常路径，纯函数；输入 undefined（连接从未建立）按「非终态」处理。
// 副作用：无；不读写任何全局状态。

import type { SourceServerConnectionStateSnapshot } from "@zcode/shared";
import type { WindowRemoteConnectionCloseEvent } from "./windowRemoteConnectionRegistry.js";

// 判断某状态是否已进入「自动恢复终态」：进入后不再重试，需用户显式操作。
// 输入：连接状态快照（可能 undefined）；输出：布尔值，纯判定不产生副作用。
// 口径：needs-install/needs-upgrade/identity-change-pending 即终态；failed 只有
// retryable === false 才算终态（retryable 缺省视为可重试）。
export function isSourceServerAutomaticRecoveryTerminalState(
  state: SourceServerConnectionStateSnapshot | undefined,
): boolean {
  return (
    state?.state === "needs-install" ||
    state?.state === "needs-upgrade" ||
    state?.state === "identity-change-pending" ||
    (state?.state === "failed" && state.retryable === false)
  );
}

// 把连接状态翻译成给 windowRemoteConnectionRegistry 的 close event。
// 输入：非终态/非重试态（connecting、ready 等）返回 undefined，表示「这次不是断开事件」。
// 输出：仅 retrying / offline / 自动恢复终态会生成事件；recoverable 只在 retrying 时为 true。
// 字段口径：error/errorCode 分别映射为 error 与 reasonCode；retryable/预算耗尽原样透传，
// 便于上层区分「再等等」与「别再等了」。exitCode/signal 固定为 null（远程连接没有进程退出码）。
// 副作用：无；纯映射，不改变状态机。
export function createSourceServerRecoveryCloseEvent(
  state: SourceServerConnectionStateSnapshot,
): WindowRemoteConnectionCloseEvent | undefined {
  if (
    state.state !== "retrying" &&
    state.state !== "offline" &&
    !isSourceServerAutomaticRecoveryTerminalState(state)
  ) {
    return undefined;
  }
  return {
    exitCode: null,
    signal: null,
    recoverable: state.state === "retrying",
    ...(state.error ? { error: state.error } : {}),
    ...(state.recoveryAttempt ? { recoveryAttempt: state.recoveryAttempt } : {}),
    ...(state.recoveryLimit ? { recoveryLimit: state.recoveryLimit } : {}),
    ...(state.recoveryBudgetExhausted !== undefined
      ? { recoveryBudgetExhausted: state.recoveryBudgetExhausted }
      : {}),
    ...(state.errorCode ? { reasonCode: state.errorCode } : {}),
    ...(state.retryable !== undefined ? { retryable: state.retryable } : {}),
  };
}
