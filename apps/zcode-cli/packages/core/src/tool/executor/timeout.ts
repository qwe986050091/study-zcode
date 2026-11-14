import {
  CoreErrorType,
  SessionEventType,
  createCoreError,
  type SessionEvent,
} from "@zcode/contracts";
import type { ToolExecutionContext, ToolEntry, ToolExecutionModelContext } from "../types.js";
import { isRecord } from "./utils.js";

/**
 * 可暂停的工具 deadline。
 *
 * 工具内部的模型请求在进程级准入闸门前排队时暂停计时，拿到票再续，剩余时长守恒。超时守的是
 * 「provider 挂了」，不是「我们自己的队列长」：否则闸门把 cap 压低时会把 WebSearch / WebFetch 逐个
 * 逼成 60 s 超时，模型再补搜，越限流越吵（deep-research 实例里 7 次这样的 cancel）。
 * 多个请求并存取并集（计数器）；退避 sleep 不暂停（那是 provider 慢）；`timeoutMs` 缺席时只累计
 * 排队时长、不计时。
 */
export class ToolDeadline {
  // 剩余毫秒；undefined 表示该工具没声明超时（只观测排队，不布墙钟）。
  private remainingMs: number | undefined;
  // 当前墙钟定时器；暂停时清空，恢复时按剩余时长重建。
  private timer: ReturnType<typeof setTimeout> | undefined;
  // 本轮计时起点（arm 时记录），暂停时用它扣减已跑时长。
  private armedAt = 0;
  // 最近一次进入暂停的时刻；resume 时用来累计 queuedTotalMs。
  private pausedAt = 0;
  // 重入计数：多个模型请求同时排队时只在 0→1 暂停、1→0 恢复，取并集。
  private pauseDepth = 0;
  // 累计排队时长；超时错误的 context 带上它，用于区分"provider 慢"与"我们排队久"。
  private queuedTotalMs = 0;
  // 到期回调；clear() 后置空，避免已取消的 deadline 仍被误触发。
  private onExpire: (() => void) | undefined;

  // timeoutMs 缺席 = 永不墙钟超时；remainingMs 以它为首轮预算。
  constructor(readonly timeoutMs: number | undefined) {
    this.remainingMs = timeoutMs;
  }

  /** 启动计时。onExpire 由 executeWithTimeout 提供（abort + reject）；重复 start 会覆盖回调，调用方只该调一次。 */
  start(onExpire: () => void): void {
    this.onExpire = onExpire;
    this.arm();
  }

  /** 暂停计时（可重入）。首次暂停才真正清定时器并把已跑时长从预算扣掉；重入只加计数。 */
  pause(): void {
    this.pauseDepth += 1;
    if (this.pauseDepth !== 1) return;
    this.pausedAt = Date.now();
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    // 已超时但回调还没跑时剩余可能为负，钳到 0：恢复后立即到期，而不是"倒欠"时间。
    this.remainingMs = Math.max(0, (this.remainingMs ?? 0) - (this.pausedAt - this.armedAt));
  }

  /** 结束一层暂停；只有计数归零才恢复计时，并把这段排队时长计入 queuedMs。 */
  resume(): void {
    if (this.pauseDepth === 0) return;
    this.pauseDepth -= 1;
    if (this.pauseDepth !== 0) return;
    this.queuedTotalMs += Date.now() - this.pausedAt;
    this.arm();
  }

  /** 停止计时并解绑回调；超时/正常结束/取消都会调用，必须幂等。 */
  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.onExpire = undefined;
  }

  /** 累计的排队时长（含仍在暂停中的这一段）；超时错误的 context 带它，便于区分「慢」与「等」。 */
  get queuedMs(): number {
    return this.queuedTotalMs + (this.pauseDepth > 0 ? Date.now() - this.pausedAt : 0);
  }

  /** 按剩余预算重新布防；没有回调/预算/仍在暂停时直接返回（暂停中绝不偷偷计时）。 */
  private arm(): void {
    if (this.onExpire === undefined || this.remainingMs === undefined || this.pauseDepth > 0)
      return;
    this.armedAt = Date.now();
    this.timer = setTimeout(() => {
      // 先清 timer 再回调：回调里可能 abort 触发 clear，避免同一到期被处理两次。
      this.timer = undefined;
      this.onExpire?.();
    }, this.remainingMs);
  }
}

/**
 * 从本次工具调用自己的模型状态事件里读准入等待的两端：`queued` 暂停、`admitted` 续。
 * 只认带本 toolCallId 的事件——同一 emitEvent 也会流过别的工具调用的状态。
 */
export function observeToolAdmissionClock(
  event: SessionEvent,
  toolCallId: string,
  deadline: ToolDeadline,
): void {
  // 同一 emitEvent 也会流过别的工具调用的状态，必须按 toolCallId 过滤，否则一次排队会暂停所有工具。
  if (event.type !== SessionEventType.ModelNetworkStatus) return;
  const payload = event.payload as { type?: unknown; toolCallId?: unknown } | undefined;
  if (payload?.toolCallId !== toolCallId) return;
  // queued/admitted 成对出现；只认这两种，其它 ModelNetworkStatus（重试、退避）不改变计时。
  if (payload.type === "model_request_queued") deadline.pause();
  else if (payload.type === "model_request_admitted") deadline.resume();
}

/**
 * 用 race 把 handler 包成"超时/取消/完成"三选一：
 *   - 父 signal 已 abort：立即 ToolCancelled，不启动 handler；
 *   - deadline 到期：abortController.abort(error) 让 handler 内部 IO 停手，同时 reject 超时错误；
 *   - 父 signal 取消：reject ToolCancelled，但不重复 abort（父信号本身就是取消源）。
 * 结算只发生一次（settled 守卫），cleanup 一定解绑 abort 监听并停 deadline。
 * 注意：handler 不会因超时被强杀，只能靠 abortSignal 协作退出；不配合的 handler 仍会跑完。
 */
export async function executeWithTimeout<TInput, TOutput>(
  handler: (input: TInput, context: ToolExecutionContext) => Promise<TOutput>,
  input: TInput,
  context: ToolExecutionContext,
  deadline: ToolDeadline,
  abortController: AbortController,
  entry: ToolEntry,
): Promise<TOutput> {
  return new Promise((resolve, reject) => {
    // 进入 handler 之前就取消：不建 timer、不跑 handler；错误文案优先用工具自报的用户可见文案。
    if (context.abortSignal.aborted) {
      reject(
        createCoreError(
          CoreErrorType.ToolCancelled,
          entry.cancellation?.userVisibleMessage ?? "Tool execution cancelled",
        ),
      );
      return;
    }

    // timedOut 用来让 abortHandler 不把"超时导致的 abort"误报成用户取消。
    let settled = false;
    let timedOut = false;
    // 统一清理：停 deadline + 解绑 abort；两个结算函数都会调用，保证只清理一次。
    const cleanup = () => {
      deadline.clear();
      context.abortSignal.removeEventListener("abort", abortHandler);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const resolveOnce = (result: TOutput) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    // 无 timeout 工具仍保留父级 abort 监听，但不创建墙钟定时器（deadline.start 对缺席的 timeoutMs 是空操作）。
    const timeoutMs = deadline.timeoutMs;
    deadline.start(() => {
      timedOut = true;
      const error = createCoreError(
        CoreErrorType.ToolTimeout,
        `Tool execution timed out after ${timeoutMs}ms`,
        {
          context: {
            cancellation: entry.cancellation?.cleanup ?? "none",
            queuedMs: deadline.queuedMs,
            timeoutMs,
            toolName: entry.metadata.name,
          },
          recoverable: true,
        },
      );
      // 先 abort 再 reject：让 handler 内部 IO 先收到取消原因；即使它随后抛错，rejectOnce 也只取首次终态。
      abortController.abort(error);
      rejectOnce(error);
    });

    const abortHandler = () => {
      // 超时已经 abort 过 controller，同一信号再触发时不能把超时改写成用户取消。
      if (timedOut) return;
      rejectOnce(
        createCoreError(
          CoreErrorType.ToolCancelled,
          entry.cancellation?.userVisibleMessage ?? "Tool execution cancelled",
          {
            context: {
              cancellation: entry.cancellation?.cleanup ?? "none",
              toolName: entry.metadata.name,
            },
            recoverable: true,
          },
        ),
      );
    };

    // 监听必须在 handler 启动之前挂上：父 signal 的取消可能早于 handler 内第一个 await，竞速两端要同时就绪。
    context.abortSignal.addEventListener("abort", abortHandler);

    // handler 的 rejected promise 与 timeout/cancel 竞争，settled 守卫保证后者不会二次结算。
    handler(input, context)
      .then((result) => {
        resolveOnce(result);
      })
      .catch((error) => {
        rejectOnce(error);
      });
  });
}

/**
 * 解析本次调用的墙钟预算（毫秒，含清理宽限）：
 *   预算 = 工具自定义 resolveTimeoutBudgetMs > 调用方覆盖(timeout_ms/timeout) > 工具默认 > executor 默认。
 * 最后按 policy.maxMs 封顶，加上 cleanupGraceMs（留给取消清理的时间），并钳到至少 1ms。
 * 返回 undefined 表示该工具声明 kind="none"（不设超时）；纯计算，无 IO。
 */
export function resolveTimeoutMs(
  entry: ToolEntry,
  input: unknown,
  defaultTimeoutMs: number,
  context?: ToolExecutionModelContext,
): number | undefined {
  const policy = entry.timeout;
  // 显式声明无超时的工具（长任务）不布墙钟，但仍受父 signal 取消。
  if (policy?.kind === "none") {
    return undefined;
  }

  // 默认值优先级：policy.defaultMs > metadata.timeoutMs > executor 默认。
  const defaultMs = policy?.defaultMs ?? entry.metadata.timeoutMs ?? defaultTimeoutMs;
  // 工具自定义预算优先于输入覆盖：它更了解本次调用的真实成本。
  const entryResolvedMs = entry.resolveTimeoutBudgetMs?.(input, context);
  const requestedMs =
    // 只有声明 allowCallOverride 才接受模型/调用方的覆盖；两个键名兼容旧 schema，timeout_ms 优先。
    entryResolvedMs ??
    (policy?.allowCallOverride && isRecord(input) && typeof input.timeout_ms === "number"
      ? input.timeout_ms
      : policy?.allowCallOverride && isRecord(input) && typeof input.timeout === "number"
        ? input.timeout
        : defaultMs);
  // maxMs 是硬上限，防止模型用一个超大 timeout 绕过保护。
  const cappedMs = policy?.maxMs === undefined ? requestedMs : Math.min(requestedMs, policy.maxMs);
  // 清理宽限单独加：取消/收尾需要时间，不应和业务预算混在一起被截断。
  const cleanupGraceMs = Math.max(0, Math.trunc(policy?.cleanupGraceMs ?? 0));
  // 钳到至少 1ms：setTimeout(0) 会被当成"立即到期"，给最小正时长避免误判。
  return Math.max(1, Math.trunc(cappedMs)) + cleanupGraceMs;
}

/**
 * 把父 signal 单向转发到子 controller（父取消 → 子取消，反向不传播）。
 * 返回解绑函数；父已取消时立刻同步 abort 子控制器并返回空解绑。
 * 用 childController.abort(parentSignal.reason) 保留取消原因，便于日志/错误归因。
 * 不持有授权状态、不负责子控制器生命周期：调用方必须在 finally 调用返回的解绑函数。
 */
export function linkAbortSignal(
  parentSignal: AbortSignal | undefined,
  childController: AbortController,
): () => void {
  // 无父信号是合法场景（测试/顶层调用）：返回 no-op，避免调用方到处判空。
  if (!parentSignal) {
    return () => {};
  }

  const abortChild = () => {
    // 子已取消时不重复 abort：AbortController 第二次 abort 是空操作，且会丢掉首次的 reason。
    if (!childController.signal.aborted) {
      childController.abort(parentSignal.reason);
    }
  };

  // 父已取消：监听器不会补发事件，必须同步转发一次。
  if (parentSignal.aborted) {
    abortChild();
    return () => {};
  }

  parentSignal.addEventListener("abort", abortChild);
  // 解绑必须在调用方 finally 执行：signal 可能长期存活，漏解绑会让监听器随调用次数累积。
  return () => {
    parentSignal.removeEventListener("abort", abortChild);
  };
}
