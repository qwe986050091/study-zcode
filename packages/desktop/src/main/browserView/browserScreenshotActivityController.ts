// INV-01 同一 windowId 与 webContentsId 组合在 states 中最多存在一个活动条目；守住位置：acquire 的 stateKey 查表与删除；改错故障：owner 与 guest 两套 capturer 计数叠加，窗口退到后台后仍持续跑帧耗电。
// INV-02 active 为 false 的条目必须先删除再重建，不得复用；守住位置：acquire 的 state 与 active 判空；改错故障：复用条目的 invalidationController 已是 abort 状态，后续截图一拿到 lease 就秒失败。
// INV-03 tokens 非空等价于至少一份 lease 未释放，删 token 后必须唤醒泵重新判定模式；守住位置：releaseToken 的删表与 wakeCapturePumps 调用；改错故障：泵停在 continuous 模式空转，或该停的 paced 泵继续读回。
// INV-04 停泵判据是 restoreGeneration 而非 deleted 顺序，microtask 内若已有新 lease 复用则本次不停泵；守住位置：releaseToken 的 generation 比较；改错故障：连续截图之间 capturer 计数归零，隐藏页面被重新节流，下一帧卡住。
// INV-05 单份 lease 的 release 与 markPrepared 各自最多生效一次；守住位置：acquire 返回对象里的 released 标记；改错故障：重复 release 让 tokens 计数错乱，活动态在仍有租约时被提前判定结束。
// INV-06 capturePumpsAllowed 只在透明窗 bootstrap 的 grace 定时器触发后置真；守住位置：scheduleCapturePumpsAfterTransparentBootstrap；改错故障：showInactive 同 turn 并发读回，Chromium 报 UnknownVizError 甚至崩溃。
// INV-07 透明窗 bootstrap 句柄与 capturePumpStartTimer 必须成对释放；守住位置：releaseTransparentWindowBootstrap；改错故障：定时器在状态销毁后仍触发，访问已关闭窗口并残留隐藏的任务栏窗口。
// INV-08 每个 target 同一时刻最多一个 pump 循环，running 为真时不得再起；守住位置：ensureCapturePump 的 running 判断；改错故障：两条循环共用同一份 transientRetry 与 wakeDelay，退避预算被双倍消耗。
// INV-09 每个 target 最多两份 in-flight 探测，且必须先启动后等待；守住位置：runCapturePump 的 continuous 分支；改错故障：capturer 计数在两帧之间归零，owner 的 hidden 调度重新生效，稳定校验失败。
// INV-10 pump 每轮续泵前必须让出一次 main event loop；守住位置：waitForContinuousCaptureTurn；改错故障：1×1 截图立即 resolve 时 microtask 饥饿，Ready IPC 与 watchdog 无法调度，应用假死。
// INV-11 guest 在 paced 阶段两次探测的间隔不小于 200ms；守住位置：waitForGuestCaptureSlot 的 CAPTURING_GUEST_MIN_INTERVAL_MS；改错故障：已就绪的隐藏页面仍被高频 GPU readback，功耗与风扇噪音上升。
// INV-12 owner 在全部 token 就绪后必须停泵，只有 guest 保留低频脉冲；守住位置：getPumpMode 的准备中判定；改错故障：就绪后仍背靠背 CopyFromSurface，长截图把 35s watchdog 拖成连续读回。
// INV-13 瞬态探测失败不得直接失效活动，只有致命失败才 abort；守住位置：recoverFromPreparingCaptureFailure 与 captureOnce 的分类；改错故障：冷 guest 首帧被判死，首张截图 45ms 内失败，只能靠 agent 整轮重试。
// INV-14 退避重试期间禁止并发 CopyFromSurface，必须先等并发那份落定；守住位置：recoverFromPreparingCaptureFailure 首个 await；改错故障：surface 未就绪时并发读回曾在 smoke 中触发 SIGSEGV。
// INV-15 瞬态重试预算耗尽后必须回到快败语义并失效活动；守住位置：transientRetry.schedule 的返回判断；改错故障：泵在没有预算的退避里长期空转，截图请求一直挂到超时。
// INV-16 失效时先置 active 为 false 再释放资源、删表、abort，顺序不可调换；守住位置：invalidateActivity 的执行序列；改错故障：已回收的 lease 仍被 coordinator 当作有效，只能等完整 surface 准备超时。
// INV-17 invalidationController 只能 abort 一次，后到的失败不得覆盖首个原因；守住位置：invalidateActivity 的 signal.aborted 判断；改错故障：迟到失败覆盖真正元凶，日志里查不出根因。
// INV-18 目标解析必须同时校验窗口与 guest 未销毁、guest 归属正确；守住位置：resolveActivityTargets 的两段校验；改错故障：向已销毁 webContents 发 capturePage，主进程抛异常或截到其他窗口画面。
// INV-19 wakeDelay 槽位与 setTimeout 句柄必须一一对应，唤醒后要清空引用；守住位置：waitForPumpTurn 的 finish；改错故障：定时器泄漏，pump 退出后仍有回调 resolve 旧 Promise，泵被意外复活。
// INV-20 所有释放路径在状态已从 states 移除后必须幂等返回；守住位置：releaseToken 与 invalidateActivity 的身份比较；改错故障：旧状态的迟到回调删掉新状态条目，正在进行中的截图失去租约。
import type { BrowserScreenshotActivityLease } from "./browserScreenshotSurfaceContracts.js";
import {
  DesktopBrowserScreenshotTransientRetry,
  isTransientScreenshotCaptureError,
} from "./browserScreenshotTransientRetry.js";
import {
  startBrowserScreenshotTransparentWindowBootstrap,
  TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS,
  type BrowserWindowForTransparentBootstrap,
  type TransparentWindowBootstrap,
} from "./browserTransparentWindowBootstrap.js";

interface BrowserWindowForActivity extends BrowserWindowForTransparentBootstrap {
  webContents: {
    id: number;
    isDestroyed(): boolean;
    capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<unknown>;
  };
}

interface GuestWebContentsForActivity {
  id: number;
  isDestroyed(): boolean;
  readonly hostWebContents: { id: number } | null;
  capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<unknown>;
}

interface ScreenshotActivityState {
  key: string;
  windowId: number;
  webContentsId: number;
  tokens: Map<symbol, { prepared: boolean }>;
  restoreGeneration: number;
  active: boolean;
  invalidationController: AbortController;
  transparentWindowBootstrap?: TransparentWindowBootstrap;
  capturePumpsAllowed: boolean;
  capturePumpStartTimer?: ReturnType<typeof setTimeout>;
  pumps: Record<"owner" | "guest", CapturePumpRuntime>;
}

interface CapturePumpRuntime {
  running: boolean;
  wakeDelay?: () => void;
  transientRetry: DesktopBrowserScreenshotTransientRetry;
}

/** 1×1 探测结果：transient 表示 Viz surface 尚未建立这类可自愈的失败。 */
type CaptureProbeOutcome = { ok: true } | { ok: false; transient: boolean };

const CAPTURE_PROBE_SUCCEEDED: CaptureProbeOutcome = { ok: true };
const CAPTURE_PROBE_FATAL: CaptureProbeOutcome = { ok: false, transient: false };
const CAPTURE_PROBE_TRANSIENT: CaptureProbeOutcome = { ok: false, transient: true };

const ACTIVITY_CAPTURE_RECT = { x: 0, y: 0, width: 1, height: 1 };
const CAPTURING_GUEST_MIN_INTERVAL_MS = 200;

/**
 * 按 owner BrowserWindow 管理短生命周期后台活动租约。
 *
 * Electron 的 backgroundThrottling=false 会唤醒同一 BrowserWindow 内全部
 * WebContents。browser-use tab 又按进程生命周期保留，若在建窗时永久关闭节流，窗口退到后台后
 * renderer、所有 guest 与 GPU 仍会持续跑帧。动态改回 true 也不会重新触发 hidden 调度。
 * 这里在截图 preparation group 内同时为 owner renderer 和目标 guest 维持可逆的 capturer
 * count；结束后由 Chromium 原生 capture lifecycle 恢复后台节流，且同窗其他 guest 不被唤醒。
 */
export class DesktopBrowserScreenshotActivityController {
  private readonly states = new Map<string, ScreenshotActivityState>();

  constructor(
    private readonly options: {
      fromId(windowId: number): BrowserWindowForActivity | null;
      fromWebContentsId(webContentsId: number): GuestWebContentsForActivity | null;
      allowTransparentWindowBootstrap?: boolean;
      hideTaskbarDuringTransparentWindowBootstrap?: boolean;
      log?(message: string): void;
    },
  ) {}

  acquire(input: {
    windowId: number;
    webContentsId: number;
    requestId: string;
    reason: "browser-screenshot" | "plugin-execution";
  }): BrowserScreenshotActivityLease | undefined {
    // [并发] 主线程单线程持有 states，查表与写入之间没有 await，因此不存在同一 key 的
    // 双建窗口；一旦在这里插入 await，两路 acquire 会各自建出一套 pump 与 bootstrap。
    // [权衡] 键取 windowId 与 webContentsId 的拼接串，而不是 guest 对象引用：
    // guest 会在导航后换新对象，用引用做键会让同一逻辑目标分裂成两条活动。
    // 非活动条目直接删除而不是复用，因为它的 invalidationController 已经 abort，
    // 复用出来的 lease 一拿到就处于失效信号上，coordinator 会立刻放弃本次截图。
    // [失败路径] 目标解析不出来时只记日志并返回 undefined，由调用方降级为普通截图；
    // 不抛错是因为窗口正在关闭属于常态，抛错会把正常退场变成主进程异常。
    const stateKey = this.getStateKey(input.windowId, input.webContentsId);
    let state = this.states.get(stateKey);
    if (state && !state.active) {
      this.states.delete(stateKey);
      state = undefined;
    }
    if (!state) {
      const targets = this.resolveActivityTargets(input.windowId, input.webContentsId);
      if (!targets) {
        this.options.log?.(
          `[browser-screenshot-activity] acquire skipped windowId=${input.windowId} webContentsId=${input.webContentsId} requestId=${input.requestId}`,
        );
        return undefined;
      }
      const transparentWindowBootstrap = startBrowserScreenshotTransparentWindowBootstrap({
        win: targets.window,
        enabled: this.options.allowTransparentWindowBootstrap === true,
        windowId: input.windowId,
        webContentsId: input.webContentsId,
        requestId: input.requestId,
        hideTaskbarDuringBootstrap:
          this.options.hideTaskbarDuringTransparentWindowBootstrap === true,
        log: this.options.log,
      });
      if (transparentWindowBootstrap === false) {
        return undefined;
      }
      state = {
        key: stateKey,
        windowId: input.windowId,
        webContentsId: input.webContentsId,
        tokens: new Map(),
        restoreGeneration: 0,
        active: true,
        invalidationController: new AbortController(),
        transparentWindowBootstrap,
        capturePumpsAllowed: !transparentWindowBootstrap,
        pumps: {
          owner: { running: false, transientRetry: this.createTransientRetry() },
          guest: { running: false, transientRetry: this.createTransientRetry() },
        },
      };
      this.states.set(stateKey, state);
      this.scheduleCapturePumpsAfterTransparentBootstrap(state);
    } else {
      // 取消上一份 lease 安排的 microtask 停泵，连续截图复用同一 capturer activity。
      state.restoreGeneration += 1;
      state.pumps.owner.transientRetry.reset();
      state.pumps.guest.transientRetry.reset();
    }

    // [资源] 每份 lease 一个独占 symbol 作 token，Map 条目就是这份租约在控制器里的
    // 唯一凭据；改回用 requestId 做键的话，同一请求重试会互相顶掉释放时机。
    // [并发] 先唤醒再启动泵：唤醒只 resolve 已存在的等待，启动才可能新建循环；
    // 顺序反过来会让新循环先跑一轮，再被旧等待的续泵顶成两条并行循环。
    // markPrepared 只把本份 token 从准备中翻成就绪，重复调用被提前返回挡掉，
    // 因为就绪切换会触发停 owner 泵与释放透明窗，重复执行会打乱释放顺序。
    // release 幂等靠闭包里的 released 标记，而不是靠 tokens 里还有没有键，
    // 否则迟到调用会把别人的 token 当成自己的删掉，活动态被提前判定结束。
    const token = Symbol(input.requestId);
    state.tokens.set(token, { prepared: false });
    this.wakeCapturePumps(state);
    this.ensureCapturePumps(state);
    let released = false;
    return {
      invalidated: state.invalidationController.signal,
      markPrepared: () => {
        if (released) return;
        const leaseState = state.tokens.get(token);
        if (!leaseState || leaseState.prepared) return;
        leaseState.prepared = true;
        this.maybeReleaseTransparentWindowBootstrap(state);
        // Ready 后继续让 owner/guest 背靠背 CopyFromSurface，最坏会把 35s
        // watchdog 全部变成高频 GPU readback。owner 已完成 rAF 握手，应停泵；guest
        // 只需低频推进隐藏页面，切为单 in-flight 的 5Hz 脉冲。
        this.wakeCapturePumps(state);
        this.ensureCapturePumps(state);
      },
      release: () => {
        if (released) return;
        released = true;
        this.releaseToken(stateKey, state, token);
      },
    };
  }

  // [并发] 删 token 与比较 states 条目在同一步完成：先确认这条 state 仍是当前
  // 登记的实例，再删 token；反过来会让已作废状态的迟到释放删掉新实例的 token。
  // tokens 删空后不立即停泵，而是登记一个 generation 并交给 microtask，
  // 给紧随其后的连续截图一个复用窗口，避免 capturer 计数在两张图之间归零。
  // [失败路径] microtask 里三项条件任一不成立就整体放弃：状态被顶替、
  // 期间来了新 lease、或别的 release 推进了 generation；三种都说明停泵责任已转移。
  // 真正停泵时才置 active 为 false 并释放透明窗 bootstrap，顺序固定，
  // 因为 bootstrap 释放会清掉 grace 定时器，而定时器回调要去读 active。
  private releaseToken(stateKey: string, state: ScreenshotActivityState, token: symbol): void {
    if (this.states.get(stateKey) !== state || !state.tokens.delete(token)) return;
    this.wakeCapturePumps(state);
    if (state.tokens.size > 0) return;

    const restoreGeneration = ++state.restoreGeneration;
    queueMicrotask(() => {
      if (
        this.states.get(stateKey) !== state ||
        state.tokens.size > 0 ||
        state.restoreGeneration !== restoreGeneration
      ) {
        return;
      }
      state.active = false;
      this.releaseTransparentWindowBootstrap(state);
      this.wakeCapturePumps(state);
      if (this.states.get(stateKey) === state) {
        this.states.delete(stateKey);
      }
    });
  }

  private async runCapturePump(
    state: ScreenshotActivityState,
    target: "owner" | "guest",
  ): Promise<void> {
    const runtime = state.pumps[target];
    runtime.running = true;
    let pendingStartedAt = Date.now();
    // [资源] 进入循环前就先发一份探测，让 capturer 计数立刻从零抬起；
    // 如果改成先判断模式再发，preparing 阶段可能整段没有任何 in-flight 探测。
    // [并发] pending 始终代表已启动但未落定的那一份，循环内不会同时持有两份
    // 无人引用的探测，因此退出时最多只剩一份在飞，由下面的分支或 finally 收口。
    // 致命失败时不清 pending 直接 continue，是刻意让循环顶的 stopped 分支去等它落定：
    // hidden window 下 capturePage 可能永久 pending，提前丢弃会留下无人处理的 rejection。
    // [权衡] 用单个变量自持 pending 而不是数组：语义上只允许一份在飞加一份重叠，
    // 数组会让最多两份这个上限失效，退化成不限并发。
    let pending: Promise<CaptureProbeOutcome> | undefined = this.captureOnce(state, target);
    try {
      while (pending) {
        const mode = this.getPumpMode(state, target);
        if (mode === "stopped") {
          const completed = await pending;
          if (!completed.ok) this.invalidateActivity(state, target);
          pending = undefined;
          continue;
        }

        if (mode === "continuous") {
          // Prepare 阶段必须先启动下一份再等待前一份，保证 owner 的两帧稳定校验不会在
          // capturer count 归零时重新被 hidden 调度；每个 target 最多两份 in-flight。
          const nextStartedAt = Date.now();
          const next = this.captureOnce(state, target);
          const completed = await pending;
          if (!completed.ok) {
            if (!completed.transient) {
              // 致命错误保持快败：不等可能永远 pending 的并发探测（hidden window 下
              // capturePage 会挂死），立即失效；pending 已落定，循环顶按 stopped 分支
              // 排空退出，在飞那份由 captureOnce 内部消化，不会产生悬空 rejection。
              this.invalidateActivity(state, target);
              continue;
            }
            // 用对象包裹补发探测：async 函数直接 return Promise 会被吸收成
            // “等该探测落定才返回”，泵会停在串行探测上无法恢复重叠节奏。
            const recovered = await this.recoverFromPreparingCaptureFailure(
              state,
              runtime,
              target,
              next,
            );
            pending = recovered?.pending;
            continue;
          }
          runtime.transientRetry.reset();
          pending = next;
          pendingStartedAt = nextStartedAt;
          // hidden window 下 Electron 的 1×1 capturePage 可能立即 resolve。
          // 若这里直接续泵，Promise continuation 会无限占用 microtask 队列，连 Ready IPC、
          // timeout、watchdog 和 second-instance 事件都无法调度，表现为应用假死且打不开。
          // 保留“先启动下一份”的 capturer 重叠，但每轮必须让出一次 main event loop。
          // 让出只保证 capturer 的重叠节奏不变：下一份已在上一轮启动，这里等的是事件循环，
          // 不是等 GPU，所以延迟取 0，真正决定节奏的是扫描顺序而非时间。
          // [权衡] 改用 setImmediate 会多引入一个阶段，且各 Electron 版本排队位置不同；
          // 复用 waitForPumpTurn 还能被 wakeCapturePumps 提前唤醒，及时响应失效。
          await this.waitForContinuousCaptureTurn(state, runtime, target);
          continue;
        }

        const completed = await pending;
        if (!completed.ok) {
          this.invalidateActivity(state, target);
          pending = undefined;
          continue;
        }
        pending = undefined;
        await this.waitForGuestCaptureSlot(state, runtime, pendingStartedAt);
        if (this.getPumpMode(state, target) === "stopped") continue;
        pendingStartedAt = Date.now();
        pending = this.captureOnce(state, target);
      }
    } finally {
      runtime.wakeDelay = undefined;
      runtime.running = false;
      if (this.getPumpMode(state, target) !== "stopped") {
        this.ensureCapturePump(state, target);
      }
    }
  }

  /**
   * 刚激活的冷 guest 首帧尚未合成时，prepare 阶段的 1×1 探测在截图请求的
   * 同一 turn 就会撞上未建立的 Viz surface，Chromium 抛 UnknownVizError；把任何
   * 一次探测失败都当致命错误立即 invalidate 会让首张截图 45ms 内被判死，只能靠 agent
   * 整轮重试。
   * UnknownVizError 是瞬态的——surface 建立后同类请求立即成功。进入本函数的首份失败
   * 已确认瞬态；这里先等并发的下一份落定（失败处理期间不允许再并发 CopyFromSurface，
   * surface 未就绪时的并发读回曾在 smoke 中触发 SIGSEGV），再串行退避重试；预算耗尽
   * 或并发那份为致命错误时回到原有快败 invalidate 语义。Ready 后（paced 阶段）的
   * 失败仍立即失效，不放宽。
   */
  private async recoverFromPreparingCaptureFailure(
    state: ScreenshotActivityState,
    runtime: CapturePumpRuntime,
    target: "owner" | "guest",
    next: Promise<CaptureProbeOutcome>,
  ): Promise<{ pending: Promise<CaptureProbeOutcome> } | undefined> {
    // [并发] 先等并发那份落定再决定退避：surface 未就绪时的并发 CopyFromSurface
    // 曾在真实 smoke 中触发 SIGSEGV，所以失败处理期间不允许再叠一份读回。
    // 并发 captureOnce 成功说明 surface 已经建立，所以此时无需退避，直接把重叠节奏接回去，
    // 否则一次本可自愈的冷启动会被拖成一次完整的退避等待。
    // [失败路径] 两份都瞬态且 transientRetry 预算耗尽，或并发那份致命时，必须走原有
    // 快败语义：失效活动而不是继续重试，避免截图请求挂到 surface 准备超时。
    // 退避等待期间仍可能被 release 或失效唤醒，返回前必须重查模式，防止退出后重启泵。
    const nextCompleted = await next;
    if (nextCompleted.ok) {
      // 并发那份已成功：surface 已出现，无需退避，直接恢复常规重叠节奏。
      runtime.transientRetry.reset();
      return { pending: this.captureOnce(state, target) };
    }
    if (
      !nextCompleted.transient ||
      !runtime.transientRetry.schedule({
        target,
        windowId: state.windowId,
        webContentsId: state.webContentsId,
      })
    ) {
      this.invalidateActivity(state, target);
      return undefined;
    }
    await this.waitForTransientCaptureRetry(state, runtime, target);
    if (this.getPumpMode(state, target) === "stopped") return undefined;
    return { pending: this.captureOnce(state, target) };
  }

  private async captureOnce(
    state: ScreenshotActivityState,
    target: "owner" | "guest",
  ): Promise<CaptureProbeOutcome> {
    const targets = this.resolveActivityTargets(state.windowId, state.webContentsId);
    if (!targets) return CAPTURE_PROBE_FATAL;
    try {
      await targets[target].capturePage(ACTIVITY_CAPTURE_RECT);
      return CAPTURE_PROBE_SUCCEEDED;
    } catch (error) {
      this.options.log?.(
        `[browser-screenshot-activity] capture failed target=${target} windowId=${state.windowId} webContentsId=${state.webContentsId} error=${error instanceof Error ? error.message : String(error)}`,
      );
      return isTransientScreenshotCaptureError(error)
        ? CAPTURE_PROBE_TRANSIENT
        : CAPTURE_PROBE_FATAL;
    }
  }

  private createTransientRetry(): DesktopBrowserScreenshotTransientRetry {
    return new DesktopBrowserScreenshotTransientRetry({ log: this.options.log });
  }

  private ensureCapturePumps(state: ScreenshotActivityState): void {
    if (!state.capturePumpsAllowed) return;
    this.ensureCapturePump(state, "owner");
    this.ensureCapturePump(state, "guest");
  }

  private ensureCapturePump(state: ScreenshotActivityState, target: "owner" | "guest"): void {
    const runtime = state.pumps[target];
    if (runtime.running || this.getPumpMode(state, target) === "stopped") return;
    void this.runCapturePump(state, target);
  }

  private getPumpMode(
    state: ScreenshotActivityState,
    target: "owner" | "guest",
  ): "continuous" | "paced" | "stopped" {
    // [并发] 模式完全由活动态与 token 就绪情况推导，不额外维护布尔量，
    // 这样任何一处状态变化都不会与泵的实际行为脱节，也就不存在标记丢失的故障。
    // 只要还有一份 token 处于准备中，两个 target 都保持 continuous：
    // owner 需要连续两帧做稳定校验，guest 需要把冷页面推进到出帧。
    // [权衡] guest 就绪后仍保留 paced 脉冲而不是停泵，因为停止读回后隐藏页面
    // 会被重新纳入节流，后续迟到的截图只能等到超时；200ms 间隔是功耗与就绪的折中。
    if (!state.active || state.tokens.size === 0) return "stopped";
    const preparing = Array.from(state.tokens.values()).some((token) => !token.prepared);
    if (preparing) return "continuous";
    return target === "guest" ? "paced" : "stopped";
  }

  private async waitForGuestCaptureSlot(
    state: ScreenshotActivityState,
    runtime: CapturePumpRuntime,
    captureStartedAt: number,
  ): Promise<void> {
    const remainingMs = Math.max(
      0,
      CAPTURING_GUEST_MIN_INTERVAL_MS - (Date.now() - captureStartedAt),
    );
    if (remainingMs === 0 || this.getPumpMode(state, "guest") !== "paced") return;
    await this.waitForPumpTurn(runtime, remainingMs);
  }

  private async waitForContinuousCaptureTurn(
    state: ScreenshotActivityState,
    runtime: CapturePumpRuntime,
    target: "owner" | "guest",
  ): Promise<void> {
    if (this.getPumpMode(state, target) !== "continuous") return;
    await this.waitForPumpTurn(runtime, 0);
  }

  private async waitForTransientCaptureRetry(
    state: ScreenshotActivityState,
    runtime: CapturePumpRuntime,
    target: "owner" | "guest",
  ): Promise<void> {
    if (this.getPumpMode(state, target) === "stopped") return;
    await this.waitForPumpTurn(runtime, runtime.transientRetry.retryDelayMs());
  }

  /** 可被 wakeCapturePumps 提前唤醒的有界等待；pump 每轮续泵前必须让出 main event loop。 */
  // [资源] 每个 target 只有一个 wakeDelay 槽位，新等待覆盖旧引用前旧 Promise 必须已落定，
  // 因为泵是串行的；若允许并存，唤醒只能叫醒最后一个，前一个会一直等到定时器到期。
  // [失败路径] finish 用 settled 去重，所以定时器与唤醒两条路径同时到达也只 resolve 一次，
  // 并在 resolve 前清掉定时器与槽位，避免状态销毁后仍有回调把旧泵复活。
  // waitForPumpTurn 的延迟取 0 也走 setTimeout 而不是微任务，所以每轮续泵都真正让出一次事件循环。
  private waitForPumpTurn(runtime: CapturePumpRuntime, delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (runtime.wakeDelay === finish) runtime.wakeDelay = undefined;
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      runtime.wakeDelay = finish;
    });
  }

  private wakeCapturePumps(state: ScreenshotActivityState): void {
    state.pumps.owner.wakeDelay?.();
    state.pumps.guest.wakeDelay?.();
  }

  // [失败路径] 失效只对仍在活动且有租约的状态生效：状态已被 release 收尾时
  // 再次 abort 会把下一个复用同 key 的实例一起打死，且日志里看不出是谁动的手。
  // [并发] 执行顺序固定为置非活动、释放 bootstrap、唤醒泵、删表、abort；
  // 先置非活动让被唤醒的泵从 stopped 分支退出，避免它们在释放后又续上一份探测。
  // abort 只发一次并携带 target，用于区分是 owner 还是 guest 触发了本轮失效。
  private invalidateActivity(state: ScreenshotActivityState, target: "owner" | "guest"): void {
    if (!state.active || state.tokens.size === 0) return;
    state.active = false;
    this.releaseTransparentWindowBootstrap(state);
    this.wakeCapturePumps(state);
    if (this.states.get(state.key) === state) {
      this.states.delete(state.key);
    }
    if (!state.invalidationController.signal.aborted) {
      // 只停泵是不够的：coordinator 已拿到的 lease 仍显示有效，只能等完整的
      // surface 准备超时。显式失效让准备阶段立即失败，Ready 后也能拒绝迟到截图。
      state.invalidationController.abort(
        new Error(`browser screenshot activity capture failed for ${target}`),
      );
    }
  }

  private resolveActivityTargets(
    windowId: number,
    webContentsId: number,
  ):
    | {
        window: BrowserWindowForActivity;
        owner: BrowserWindowForActivity["webContents"];
        guest: GuestWebContentsForActivity;
      }
    | undefined {
    const win = this.options.fromId(windowId);
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return undefined;
    const guest = this.options.fromWebContentsId(webContentsId);
    if (
      !guest ||
      guest.isDestroyed() ||
      guest.id !== webContentsId ||
      guest.hostWebContents?.id !== win.webContents.id
    ) {
      return undefined;
    }
    return { window: win, owner: win.webContents, guest };
  }

  private releaseTransparentWindowBootstrap(state: ScreenshotActivityState): void {
    if (state.capturePumpStartTimer) {
      clearTimeout(state.capturePumpStartTimer);
      state.capturePumpStartTimer = undefined;
    }
    state.transparentWindowBootstrap?.release();
    state.transparentWindowBootstrap = undefined;
  }

  private scheduleCapturePumpsAfterTransparentBootstrap(state: ScreenshotActivityState): void {
    if (!state.transparentWindowBootstrap) return;
    state.capturePumpStartTimer = setTimeout(() => {
      state.capturePumpStartTimer = undefined;
      if (!state.active || this.states.get(state.key) !== state) return;
      state.capturePumpsAllowed = true;
      // showInactive 同一 turn 内并发 CopyFromSurface 时，Viz 尚未建立 surface，
      // Electron 会报 UnknownVizError，真实 smoke 甚至触发过 SIGSEGV。先给窗口一个有界
      // presentation grace，再启动 capturer；若 renderer 已 Ready，只启动 guest paced pump。
      this.ensureCapturePumps(state);
      this.maybeReleaseTransparentWindowBootstrap(state);
    }, TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS);
  }

  private maybeReleaseTransparentWindowBootstrap(state: ScreenshotActivityState): void {
    if (
      !state.capturePumpsAllowed ||
      Array.from(state.tokens.values()).some((candidate) => !candidate.prepared)
    ) {
      return;
    }
    this.releaseTransparentWindowBootstrap(state);
  }

  private getStateKey(windowId: number, webContentsId: number): string {
    return `${windowId}:${webContentsId}`;
  }
}
