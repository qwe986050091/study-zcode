// Host 关闭阶段（shutdown phases）的顺序执行器。
//
// 职责：串行执行每个关闭 phase，并为每个 phase 施加独立 deadline，最终汇总失败/超时的 phase
// 名并给出 exitCode。用于 Host 退出与「临时所有权」失败清理两条路径。
// 输入输出：输入 phases（name/run/timeoutMs）与 options（默认 phaseTimeoutMs + log）；
// 输出 { exitCode, failedPhases, timedOutPhases }，永不抛出。
// 副作用：执行各 phase 的副作用；超时/失败时写日志。
// 失败语义：phase 抛错 → 记入 failedPhases 并继续下一个；超过 deadline → 记入 timedOutPhases
// 并继续；两者都会把 exitCode 置 1。超时的 phase 不会被取消，只是不再等待。
// 维护的不变量：必须串行——关闭顺序本身有依赖（先停入口再释放资源）；单个 phase 卡死
// 不能阻塞后续 phase，否则进程无法退出。

export interface HostShutdownPhase {
  name: string;
  run: () => Promise<void>;
  timeoutMs?: number;
}

export interface HostShutdownResult {
  exitCode: 0 | 1;
  failedPhases: string[];
  timedOutPhases: string[];
}

interface HostShutdownPhaseOptions {
  phaseTimeoutMs: number;
  log: (message: string, details: Record<string, unknown>) => void;
}

// 逐个执行关闭阶段并收集结果。
// 每个 phase 用 Promise.race(operation, deadline) 实现超时：operation 已包装成
// completed/failed，因此不会出现未处理的 rejection。timeoutMs <= 0 会被钳到 0，
// 表示立即超时（仍让 operation 起跑，只是不等待）。
// 失败语义：本函数不抛错；任何 phase 失败/超时只体现在返回值与日志里。
export async function runHostShutdownPhases(
  phases: HostShutdownPhase[],
  options: HostShutdownPhaseOptions,
): Promise<HostShutdownResult> {
  const failedPhases: string[] = [];
  const timedOutPhases: string[] = [];

  for (const phase of phases) {
    const startedAt = Date.now();
    const timeoutMs = Math.max(phase.timeoutMs ?? options.phaseTimeoutMs, 0);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const operation = phase.run().then(
      () => ({ kind: "completed" as const }),
      (error: unknown) => ({ kind: "failed" as const, error }),
    );
    const deadline = new Promise<{ kind: "timed-out" }>((resolve) => {
      timeout = setTimeout(() => resolve({ kind: "timed-out" }), timeoutMs);
    });
    const result = await Promise.race([operation, deadline]);
    if (timeout) {
      clearTimeout(timeout);
    }

    if (result.kind === "timed-out") {
      timedOutPhases.push(phase.name);
      options.log("host shutdown phase timed out", {
        elapsedMs: Date.now() - startedAt,
        phase: phase.name,
        timeoutMs,
      });
      continue;
    }
    if (result.kind === "failed") {
      failedPhases.push(phase.name);
      options.log("host shutdown phase failed", {
        elapsedMs: Date.now() - startedAt,
        error: result.error,
        phase: phase.name,
      });
    }
  }

  return {
    exitCode: failedPhases.length > 0 || timedOutPhases.length > 0 ? 1 : 0,
    failedPhases,
    timedOutPhases,
  };
}
