// 定时任务 run 的生命周期记账：claim 续租、终态回写、manual claim 释放。
//
// 职责：把一次 automation run 从「被认领」到「终态落库」的所有写操作收敛成 best-effort
// helper，调用方无需关心顺序与失败处理；repo 抽象由调用方注入，本文件不直接连数据库。
// 输入输出：输入 CronRunLifecycleIdentity（runId/automationId/workspaceKey/scheduledAt/trigger）
// 与 repo；输出 Promise<void>，不返回业务结果。
// 副作用：写 run 记录（ensureRunClaimed / markRunOutcome / markRunDispatch）、触碰或释放
// manual claim；startManualClaimHeartbeat 额外创建 interval 定时器，需调用方 dispose。
// 失败语义：除 start* 外均为 best-effort——失败只经 logWarn 上报，绝不覆盖调用方的原始
// dispatch error；manual claim 必须在真实终态后才释放，避免提前放开并发互斥。

import type {
  ZCodeAutomationRunOutcome,
  ZCodeAutomationTrigger,
} from "@zcode/shared";

export interface CronRunLifecycleRepo {
  ensureRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
  }): Promise<void>;
  markRunOutcome(
    runId: string,
    outcome: ZCodeAutomationRunOutcome,
    error?: string,
  ): Promise<void>;
  markRunDispatch(params: {
    runId: string;
    dispatchStatus: "failed_to_dispatch";
    error: string;
  }): Promise<void>;
  touchManualClaim(automationId: string, workspaceKey: string): Promise<void>;
  releaseManualClaim(automationId: string, workspaceKey: string): Promise<void>;
}

export interface CronRunLifecycleIdentity {
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: ZCodeAutomationTrigger;
}

type LogWarn = (message: string, error: unknown) => void;

const MANUAL_CLAIM_HEARTBEAT_MS = 60_000;

// 启动 manual claim 的心跳续租。
// 返回 { dispose } 而不是裸 timer：调用方必须在 run 结束（成功/失败/取消）时调用，
// 否则 interval 会一直续租一个已死的 claim，导致后续 manual 触发永久拿不到锁。
// 触租失败只记 warn 不抛出：心跳是旁路，不能因为一次写失败中断执行中的 run。
// 副作用：setInterval + 周期性写库；intervalMs 仅用于测试注入，默认为 60s。
export function startManualClaimHeartbeat(
  params: Pick<CronRunLifecycleIdentity, "automationId" | "runId" | "workspaceKey"> & {
    repo: Pick<CronRunLifecycleRepo, "touchManualClaim">;
    logWarn: LogWarn;
    intervalMs?: number;
  },
): { dispose(): void } {
  const timer = setInterval(() => {
    void params.repo
      .touchManualClaim(params.automationId, params.workspaceKey)
      .catch((error) =>
        params.logWarn(
          `续租 manual automation claim 失败 automation=${params.automationId} runId=${params.runId}`,
          error,
        ),
      );
  }, params.intervalMs ?? MANUAL_CLAIM_HEARTBEAT_MS);
  return { dispose: () => clearInterval(timer) };
}

// 回写 run 终态（best-effort）。
// 先 ensureRunClaimed 再 markRunOutcome：部分路径上 run 行可能尚未落库（例如调度器直接
// 推进到终态），先补 claim 才能保证 outcome 有对应记录。
// 失败语义：catch 后仅 logWarn，不向调用方抛出——终态回写失败不应把一次已完成的任务
// 反向标记为失败。
export async function recordCronRunOutcomeBestEffort(
  params: CronRunLifecycleIdentity & {
    repo: CronRunLifecycleRepo;
    outcome: ZCodeAutomationRunOutcome;
    error?: string;
    logWarn: LogWarn;
  },
): Promise<void> {
  try {
    await params.repo.ensureRunClaimed(params);
    await params.repo.markRunOutcome(params.runId, params.outcome, params.error);
  } catch (error) {
    params.logWarn(
      `回写定时任务运行结果失败 automation=${params.automationId} runId=${params.runId}`,
      error,
    );
  }
}

// 释放 manual claim（best-effort）。
// 只在 run 达到真实终态后调用；提前释放会让同一 automation 的后续 manual 触发并发执行。
// 失败语义：只记 warn，因为 claim 本身还有 TTL 兜底，不因释放失败阻塞收尾。
export async function releaseManualClaimBestEffort(
  params: Pick<CronRunLifecycleIdentity, "automationId" | "runId" | "workspaceKey"> & {
    repo: Pick<CronRunLifecycleRepo, "releaseManualClaim">;
    logWarn: LogWarn;
  },
): Promise<void> {
  try {
    await params.repo.releaseManualClaim(params.automationId, params.workspaceKey);
  } catch (error) {
    params.logWarn(
      `释放 manual automation claim 失败 automation=${params.automationId} runId=${params.runId}`,
      error,
    );
  }
}

// manual 派发失败时的收尾：记录 failed_to_dispatch 并释放 claim。
// dispatchError 先被规范化成字符串再落库，保证 markRunDispatch 的 error 字段稳定；
// 这里刻意不覆盖调用方手里的原始 dispatchError（由调用方自己抛出/上报）。
// 顺序：先写失败状态再释放 claim，避免释放后、写状态前有新的触发抢进来。
// 失败语义：写状态与释放均为 best-effort，任何异常只 logWarn。
/** 派发失败清理永不覆盖调用方持有的原始 dispatch error。 */
export async function settleManualDispatchFailureBestEffort(
  params: CronRunLifecycleIdentity & {
    repo: CronRunLifecycleRepo;
    dispatchError: unknown;
    logWarn: LogWarn;
  },
): Promise<void> {
  const errorMessage =
    params.dispatchError instanceof Error
      ? params.dispatchError.message
      : String(params.dispatchError);
  try {
    await params.repo.markRunDispatch({
      runId: params.runId,
      dispatchStatus: "failed_to_dispatch",
      error: errorMessage,
    });
  } catch (error) {
    params.logWarn(
      `回写 manual automation 派发失败状态失败 automation=${params.automationId} runId=${params.runId}`,
      error,
    );
  }
  await releaseManualClaimBestEffort(params);
}

// 一次 run 到终态后的统一收尾。
// 先回写 outcome；仅 manual 触发才释放 claim（scheduled 触发没有 manual claim，释放是空操作
// 但会多一次写库，因此用 trigger 提前短路）。
// 失败语义：两步都是 best-effort，不抛出。
/** manual claim 覆盖 queue 等待和 turn 执行，只能在真实终态后释放。 */
export async function settleCronRunTerminalOutcome(
  params: CronRunLifecycleIdentity & {
    repo: CronRunLifecycleRepo;
    outcome: Exclude<ZCodeAutomationRunOutcome, "running">;
    error?: string;
    logWarn: LogWarn;
  },
): Promise<void> {
  await recordCronRunOutcomeBestEffort(params);
  if (params.trigger !== "manual") return;
  await releaseManualClaimBestEffort(params);
}
