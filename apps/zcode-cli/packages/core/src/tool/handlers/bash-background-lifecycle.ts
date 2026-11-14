/**
 * 后台执行生命周期的契约类型与能力探测：
 * bash.ts 通过 supportsBashBackgroundLifecycle 判断 ExecutionPort 是否支持"显式后台/超时自动转后台"，
 * 支持时调用 runBashWithBackgroundLifecycle，并按返回的 kind 决定回填前台结果还是后台任务句柄。
 * 本文件只定义形状、不做策略判断；何时允许转后台见 bash-background-policy.ts。
 */

import type {
  BackgroundExecutionStartResult,
  ExecutionPort,
  ExecutionRequest,
  ExecutionResult,
  ExecutionRunOptions,
} from "@zcode/contracts";

// explicit=模型显式指定 run_in_background；auto_on_timeout=前台超时后由执行层转后台，保留后续轮询能力。
export type BashBackgroundLifecycleMode = "explicit" | "auto_on_timeout";

export type BashBackgroundLifecycleResult =
  | {
      // 前台完成，携带完整执行结果（含 exitCode/stdout/stderr）。
      kind: "foreground";
      result: ExecutionResult;
    }
  | {
      // 已转入后台，只携带任务句柄；后续输出通过 BashOutput 读取。
      kind: "backgrounded";
      task: BackgroundExecutionStartResult;
    };

export interface BashBackgroundLifecycleExecutionPort extends ExecutionPort {
  runBashWithBackgroundLifecycle(
    request: ExecutionRequest,
    lifecycle: { mode: BashBackgroundLifecycleMode },
    options?: ExecutionRunOptions,
  ): Promise<BashBackgroundLifecycleResult>;
}

// 结构化探测而非 instanceof：ExecutionPort 由宿主注入，只有真实实现才有这个方法。
// 不支持时 bash.ts 会走普通 run 路径，超时即失败，不会转后台。
export function supportsBashBackgroundLifecycle(
  executionPort: ExecutionPort,
): executionPort is BashBackgroundLifecycleExecutionPort {
  return (
    typeof (executionPort as Partial<BashBackgroundLifecycleExecutionPort>)
      .runBashWithBackgroundLifecycle === "function"
  );
}
