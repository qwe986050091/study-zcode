import type { SessionExecutionContract, SessionResidencyFinalizationOwner } from "./contract.js";

// 示例只演示「用现有 record 做收尾」：finalize 抛错时异常原样上抛，租约仍会释放；
// 不把租约当成 busy/idle 或命令准入依据，也不创建第二个 session 运行态。
/** 使用现有 record；不把租约当作 busy/idle 或命令准入依据。 */
export function finalizeSession<T>(
  contract: SessionExecutionContract,
  record: SessionResidencyFinalizationOwner,
  finalize: () => Promise<T>,
) {
  return contract.runWithSessionResidencyFinalization(record, finalize);
}
