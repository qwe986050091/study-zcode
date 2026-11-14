// sessions-index fan-out 的高频事件节流（docs/v4-refactor/14-sessions-index.md「事件 fan-out 节奏」）。
// 纯调度：窗口状态与定时器在这里，publish 由调用方注入，网关只保留调用点。
//
// 根因备忘：一次工作流运行的引擎事件以 DynamicWorkflowRunProgress 回到父会话，实测 8s 内 4000 条。
// 每条都 bump record.updatedAt，摘要因此条条有变化 → 旧实现条条 flush 一帧 sessions-index 增量
// → 宿主重算 task 行 → renderer 按事件频率重拉任务列表。ModelStreaming 早已因同样的理由被排除。

/** 工作流进度事件的 fan-out 窗口：窗内的进度合并为窗末一次发布（侧栏运行行 ≤4Hz）。 */
export const WORKFLOW_PROGRESS_INDEX_FANOUT_MS = 250;

/** 定时器句柄对调度逻辑不透明：生产用 setTimeout，测试可注入任意实现。 */
export type FanoutTimerHandle = unknown;

export interface SessionsIndexFanoutThrottleOptions {
  /** 发布某会话当前摘要到 sessions-index（网关的 publishCurrentSummaryToIndex）。 */
  publish: (sessionId: string) => void;
  windowMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => FanoutTimerHandle;
  clearTimer?: (handle: FanoutTimerHandle) => void;
}

interface WindowState {
  /** 窗内是否还有未发布的进度；被任意即时发布满足后回落为 false。 */
  pending: boolean;
  handle: FanoutTimerHandle;
}

function defaultSetTimer(callback: () => void, delayMs: number): FanoutTimerHandle {
  const timer = setTimeout(callback, delayMs);
  // CLI 进程退出不被节流窗口挂住（与 scheduleFlush 同一姿态）。
  timer.unref?.();
  return timer;
}

function defaultClearTimer(handle: FanoutTimerHandle): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

/**
 * leading + trailing 窗口节流，按 session 独立计窗：
 * 静默后的第一条立即发布并开窗；窗内的后续请求只置 pending，在窗末合并成一次发布。
 * 窗末若确有 pending 就发布并续窗，保证突发期间每窗至多一帧；窗末无 pending 则关窗，
 * 下一条请求重新走 leading edge。
 */
// 纯调度组件：输入只有 sessionId 请求，输出经注入的 publish 落到 sessions-index topic；
// 本类不持有摘要、不构造帧，也不做 IO。定时器统一 unref，clearSession/clear 负责释放；
// publish 抛出的异常不在此吞掉，由调用方决定是否降级为 snapshot。
export class SessionsIndexFanoutThrottle {
  private readonly windows = new Map<string, WindowState>();
  private readonly publish: (sessionId: string) => void;
  private readonly windowMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => FanoutTimerHandle;
  private readonly clearTimer: (handle: FanoutTimerHandle) => void;

  /**
   * 绑定发布回调与窗口参数；windowMs 缺省 250ms，定时器实现可注入以便测试。
   * 构造不启动任何定时器，首个 request 才按会话开窗。
   */
  constructor(options: SessionsIndexFanoutThrottleOptions) {
    this.publish = options.publish;
    this.windowMs = options.windowMs ?? WORKFLOW_PROGRESS_INDEX_FANOUT_MS;
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
  }

  /** 高频事件的发布请求：立即发布（leading）或并入窗末的一次发布（trailing）。 */
  // 窗口已开时只置 pending=true 并返回，绝不额外发布；窗口未开时先开窗再立即 publish。
  // 返回 void，发布失败由 publish 实现自行处理。
  request(sessionId: string): void {
    const open = this.windows.get(sessionId);
    if (open) {
      open.pending = true;
      return;
    }
    this.openWindow(sessionId);
    this.publish(sessionId);
  }

  /**
   * 任意即时发布（非进度事件、hydration 补发等）都已经带上了窗内合并的进度，
   * 待发的 trailing 因此被它满足：只清 pending，窗口继续限流，不再补一帧空增量。
   */
  // 只认该会话已开的窗口；无窗口或会话不匹配时为无操作。
  notePublished(sessionId: string): void {
    const open = this.windows.get(sessionId);
    if (open) open.pending = false;
  }

  /** 会话运行态清理：窗口定时器必须随之消失（cleanupSessionRuntime）。 */
  // 清理后该会话的下一次 request 重新走 leading；对无窗口的 sessionId 幂等。
  clearSession(sessionId: string): void {
    const open = this.windows.get(sessionId);
    if (!open) return;
    this.clearTimer(open.handle);
    this.windows.delete(sessionId);
  }

  /** 网关 dispose：清掉全部窗口定时器。 */
  // 只负责调度资源释放，不发布最后的 pending 摘要（销毁代际不再需要在线帧）。
  clear(): void {
    for (const open of this.windows.values()) this.clearTimer(open.handle);
    this.windows.clear();
  }

  /**
   * 为会话开一个节流窗口，窗末统一回调 onWindowElapsed。
   * 每个 sessionId 同时只有一个窗口，窗口句柄存于 windows，供 clearSession/clear 释放。
   */
  private openWindow(sessionId: string): void {
    this.windows.set(sessionId, {
      pending: false,
      handle: this.setTimer(() => this.onWindowElapsed(sessionId), this.windowMs),
    });
  }

  /**
   * 窗口到期裁决：无 pending 则关窗（下次请求重新走 leading），有 pending 则只发布一次。
   *
   * 先续窗再 publish：publish 内部可能回调 notePublished 清 pending，
   * 状态必须已经代表新窗口，否则会把刚发布的请求误判成新的 trailing。
   */
  private onWindowElapsed(sessionId: string): void {
    const open = this.windows.get(sessionId);
    if (!open) return;
    if (!open.pending) {
      // 窗内没有新进度 → 关窗；下一条进度重新立即发布。
      this.windows.delete(sessionId);
      return;
    }
    // 先续窗再发布：publish 会回调 notePublished，状态必须已是新窗口的。
    open.pending = false;
    open.handle = this.setTimer(() => this.onWindowElapsed(sessionId), this.windowMs);
    this.publish(sessionId);
  }
}
