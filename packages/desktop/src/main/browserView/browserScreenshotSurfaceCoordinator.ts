// Desktop 主进程侧的「瞬时截图表面」协调器。renderer 需要为某个 guest 视图准备 capture
// surface 时，先经由这里发起 prepare/ready/release 三段握手；主进程只负责排队与校验，不碰像素。
//
// 职责边界：按时序与身份（window/workspace/session/browser/generation/tab/webContents/viewport）
// DesktopBrowserScreenshotSurfaceCoordinator 只去重并串行化握手，不负责 surface 创建与缩放，所以也不决定截图时机与窗口生命周期：
// 窗口销毁与协调器 dispose 必须由外部显式通知，据此收敛在途请求并归还资源。
//
// INV-01 断言：同一个 guest key 同时最多只有一个组在排队或活跃 —— 守住它的位置：groupsByGuestKey 的 get/set 与 queuedGroups —— 改错故障：两个 capture layer 指向同一窗口内不同 webview，ready 归属错乱、截图串台。
// INV-02 断言：ready 只接受当前 activeGroup 且 requestId 匹配的回执 —— 守住它的位置：handleReady 首段三重判断 —— 改错故障：迟到的旧回执把已释放的组复活，后续 lease 指向已销毁的 surface。
// INV-03 断言：回执的 requestId/window/workspace/session/browser/generation/tab/webContents/viewportMode 必须逐项等于 prepare 载荷 —— 守住它的位置：handleReady 的 expected 逐字段比较块 —— 改错故障：跨窗口或跨 tab 的回执被当作成功，截到别人的页面。
// INV-04 断言：senderWebContentsId 一经冻结不得改写 —— 守住它的位置：handleReady 中的空值合并赋值与后续比较 —— 改错故障：另一个 renderer 的迟到回执接管请求，主进程把 lease 发给错误发送方。
// INV-05 断言：回执 surfaceScale 必须是有限正数 —— 守住它的位置：handleReady 的 Number.isFinite 分支 —— 改错故障：0 或 NaN 传下去后 canvas 尺寸退化为 0，截图空白且无异常。
// INV-06 断言：unscaled 模式下 surfaceScale 与 1 的偏差不超过 0.001 —— 守住它的位置：UNSCALED_SURFACE_EPSILON 与 unscaled 分支 —— 改错故障：录制器把放大后的 surface 当原尺寸回执，产出模糊的伪高清录像。
// INV-07 断言：请求必须在 sendPrepare 之前登记进 group.requests —— 守住它的位置：prepare 的 Promise 执行体内语句顺序 —— 改错故障：同步回传的 ready 找不到请求，promise 悬挂到超时。
// INV-08 断言：登记请求后必须再检查一次 signal.aborted —— 守住它的位置：prepare 中挂完 abort 监听的二次判断 —— 改错故障：登记与中止竞争，已取消的调用方仍拿到表面租约。
// INV-09 断言：每个 request 只能从 group.requests 删除一次，删除成功者才能 reject 或 resolve —— 守住它的位置：finishRequestError 对 delete 返回值的判断 —— 改错故障：重复 settle 触发二次 reject 被吞掉，泄漏未清理的 timer。
// INV-10 断言：清 timer 与移除 abort 监听必须成对发生在 clearRequest —— 守住它的位置：所有 resolve/reject 之前的统一清理 —— 改错故障：请求结束后 abort 仍回调，对已 settle 的 promise 再次操作。
// INV-11 断言：只有组内最后一个 request 失败才调用 settleGroup —— 守住它的位置：finishRequestError 的 size 为零判断 —— 改错故障：一个调用者中止就把同组其他并发请求一起失败。
// INV-12 断言：finishGroupReady 必须先取 requests 快照再清空 —— 守住它的位置：该函数中的展开拷贝与 clear —— 改错故障：边遍历边删导致部分等待者永远不 resolve。
// INV-13 断言：group.released 是所有入口的第一道短路 —— 守住它的位置：prepare/handleReady/finish 系列/settleGroup —— 改错故障：已释放组被重新激活，重复 sendRelease 或写回已删映射。
// INV-14 断言：每个 lease 的 release 只能生效一次 —— 守住它的位置：releaseBrowserScreenshotResourceOnce 与 leaseReleases —— 改错故障：重复 release 让计数提前归零，surface 在被使用时被回收。
// INV-15 断言：leaseReleases 归零后才允许 settleGroup —— 守住它的位置：createLease 里注册的释放回调 —— 改错故障：还有租约存活就发 release，进行中的截图拿到已销毁表面。
// INV-16 断言：只要组已 ready，sendPrepare 返回 false 或抛异常都不能提前释放 —— 守住它的位置：activateNextGroup 的 sent 分支与 catch 分支 —— 改错故障：测试替身同步 ready 后立刻被释放，调用方拿到失效 lease。
// INV-17 断言：sendRelease 抛异常也必须走完 finally 的租约与占位释放 —— 守住它的位置：settleGroup 的 try/finally —— 改错故障：activeGroup 永久占位，之后所有截图请求排队到超时。
// INV-18 断言：窗口销毁与 dispose 期间必须暂停调度（schedulingSuspended），结束后统一重新激活下一组 —— 守住它的位置：handleWindowDestroyed —— 改错故障：销毁回调中递归激活，把请求发往正在关闭的窗口。
//
// 所有等待都必须能收敛：request timer、activity watchdog、abort 监听三处任一处失效，
// 表现都是 promise 悬挂或租约泄漏，属于不可接受的回归。
import {
  BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS,
  type BrowserViewportSize,
  type BrowserViewScreenshotSurfacePreparePayload,
  type BrowserViewScreenshotSurfaceReadyPayload,
  type BrowserViewScreenshotSurfaceReleasePayload,
} from "@zcode/shared";
import {
  releaseBrowserScreenshotResourceOnce,
  sameBrowserScreenshotViewport,
  toBrowserScreenshotSurfacePreparePayload,
  toBrowserScreenshotSurfaceReleasePayload,
  type BrowserScreenshotActivityLease,
  type BrowserScreenshotPendingRequest as PendingRequest,
  type BrowserScreenshotPreparationGroup as PreparationGroup,
  type BrowserScreenshotSurfaceCoordinator,
  type BrowserScreenshotSurfaceLease,
  type BrowserScreenshotSurfacePrepareInput,
} from "./browserScreenshotSurfaceContracts.js";

const DEFAULT_SCREENSHOT_ACTIVITY_TIMEOUT_MS = 35_000;
const UNSCALED_SURFACE_EPSILON = 0.001;
export type {
  BrowserScreenshotSurfaceCoordinator,
  BrowserScreenshotSurfaceLease,
} from "./browserScreenshotSurfaceContracts.js";

/**
 * Desktop main 与 owner renderer 之间的瞬时截图表面握手。
 *
 * 同一 guest 的并发截图复用一份 renderer 表面，避免相互覆盖；不同 guest 必须串行，
 * 否则单个背景 capture layer 会在同一窗口内同时指向两个 webview，导致 ready 归属不确定。
 */
// 同一时刻只允许一个组处于 active：单个背景 capture layer 在一个窗口内只能指向一个 webview。
// 三个容器分工固定：groupsByGuestKey 做身份去重，groupsByReadyRequestId 做回执寻址，queuedGroups 保持先来先服务。
// 三者必须同步增删，任何一处漏删都会让某个 guest 卡在「永远排队」或「ready 无人认领」。
// 新增字段前先确认它归属 groupsByGuestKey、groupsByReadyRequestId 还是 queuedGroups，避免出现第二份可由外部改写的状态。
export class DesktopBrowserScreenshotSurfaceCoordinator implements BrowserScreenshotSurfaceCoordinator {
  // 两档超时语义不同：前者限制单个 prepare 等待 ready，后者限制整组 surface 的存活时长，不可合并。
  // groupsByGuestKey 与 groupsByReadyRequestId 是同一 group 的双索引，键分别是身份串与 requestId。
  // activeGroup 表示已发出 prepare 且尚未 settle 的唯一组；schedulingSuspended 只在销毁或批量收尾时短暂为真。
  // disposed 一旦为真就不再接受新 prepare，并保证 dispose 可重复调用而不产生二次副作用。
  private readonly timeoutMs: number;
  private readonly activityTimeoutMs: number;
  private readonly groupsByGuestKey = new Map<string, PreparationGroup>();
  private readonly groupsByReadyRequestId = new Map<string, PreparationGroup>();
  private readonly queuedGroups: PreparationGroup[] = [];
  private activeGroup: PreparationGroup | undefined;
  private schedulingSuspended = false;
  private disposed = false;

  constructor(
    private readonly options: {
      timeoutMs?: number;
      activityTimeoutMs?: number;
      acquireActivity?(
        windowId: number,
        payload: BrowserViewScreenshotSurfacePreparePayload,
      ): BrowserScreenshotActivityLease | undefined;
      sendPrepare(windowId: number, payload: BrowserViewScreenshotSurfacePreparePayload): boolean;
      sendRelease(windowId: number, payload: BrowserViewScreenshotSurfaceReleasePayload): void;
      log?(message: string): void;
      warn?(message: string): void;
    },
  ) {
    // 这里用空值合并而非逻辑或：显式传 0 会被当成有效配置，测试靠它注入「立刻超时」。
    // 两个超时在构造时固化，运行期再改 options 不生效，排查配置问题时先确认实例创建时机。
    this.timeoutMs = options.timeoutMs ?? BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS;
    this.activityTimeoutMs = options.activityTimeoutMs ?? DEFAULT_SCREENSHOT_ACTIVITY_TIMEOUT_MS;
  }

  prepare(input: BrowserScreenshotSurfacePrepareInput): Promise<BrowserScreenshotSurfaceLease> {
    if (this.disposed) {
      return Promise.reject(new Error("browser screenshot surface coordinator disposed"));
    }

    if (input.signal.aborted) {
      return Promise.reject(new Error("browser screenshot surface preparation cancelled"));
    }

    if (input.viewport.width <= 0 || input.viewport.height <= 0) {
      return Promise.reject(
        new Error("browser screenshot surface preparation requires a non-zero viewport"),
      );
    }

    // 走到这里三个前置拒绝已完成：disposed、signal 已中止、viewport 非正，全部返回 rejected promise 而非同步抛出。
    // 保持统一的 Promise 形状，调用方只需 await，不必同时写 try/catch 与同步分支。
    // viewport 为 0 必须在此拒绝，否则下游按宽高换算会得到 NaN 尺寸并静默产出空图。
    const key = this.getGuestKey(input);
    let group = this.groupsByGuestKey.get(key);
    // 已 ready 的组不再排队，直接用新 signal 派生 lease，这是并发截图的快路径。
    // lease 会计入 leaseReleases，必须等最后一个持有者释放，组才会 settle。
    if (group?.ready) {
      return Promise.resolve(this.createLease(group, input.signal));
    }

    if (!group) {
      group = {
        key,
        payload: toBrowserScreenshotSurfacePreparePayload(input, this.timeoutMs),
        windowId: input.windowId,
        requests: new Set(),
        prepareSent: false,
        ready: false,
        released: false,
        leaseReleases: new Set(),
        activityTimeoutMs: input.activityTimeoutMs,
        invalidationController: new AbortController(),
      };
      // 组对象在此同步建好并立刻入队，早于 Promise 构造，保证同一 tick 内的第二个 prepare 能复用它。
      // requests 使用 Set 而非数组：重复登记天然幂等，也便于用 size 判断是否为最后一个等待者。
      // prepareSent/ready/released 三个布尔构成组状态机，只允许单向翻转，任何回写都会破坏幂等。
      // invalidationController 在建组时即存在，失败原因通过它广播给所有已发出的 lease。
      this.groupsByGuestKey.set(key, group);
      this.queuedGroups.push(group);
    }

    return new Promise<BrowserScreenshotSurfaceLease>((resolve, reject) => {
      const request = {} as PendingRequest;
      const failForAbort = () =>
        this.finishRequestError(
          request,
          new Error("browser screenshot surface preparation cancelled"),
        );
      request.input = input;
      request.group = group;
      request.resolve = resolve;
      request.reject = reject;
      request.timer = setTimeout(() => {
        this.finishRequestError(
          request,
          new Error(`browser screenshot surface preparation timed out after ${this.timeoutMs}ms`),
        );
      }, this.timeoutMs);
      request.abortListener = failForAbort;

      // 该 Promise 的执行体是同步运行的，request 字段填完后立即入 Set 并挂 abort 监听。
      // timer 从登记时刻起算，包含排队时间：等待久的组可能还没发出 prepare 就先超时。
      // 这是有意设计，调用方的等待预算应当覆盖排队，否则端到端时延不可控。
      // 必须先登记再发送：测试替身和真实 IPC 都可能在 sendPrepare 同步期间回传 ready。
      group.requests.add(request);
      // once 保证中止只触发一次，与 clearRequest 的显式移除形成双保险。
      // 监听必须在 activateNextGroup 之前挂上，否则同步 ready 先到时会漏掉中止信号。
      input.signal.addEventListener("abort", failForAbort, { once: true });

      if (input.signal.aborted) {
        failForAbort();
        return;
      }

      this.activateNextGroup();
    });
  }

  handleReady(input: {
    windowId: number;
    senderWebContentsId: number;
    payload: BrowserViewScreenshotSurfaceReadyPayload;
  }): void {
    // 这里的输入是 renderer 主动推送的 ready，可能重复、跨窗口、在组已释放后才到达，一律按不可信数据处理。
    // 只按 requestId 反查组，不复用调用方上下文，防止伪造 id 命中错误的组。
    // 反查到的组还必须等于 activeGroup：排队中的组尚未收到 prepare，理论上不存在合法 ready。
    // 不匹配一律静默丢弃并记日志，不回错给 renderer，避免握手期出现双向报错风暴。
    const group = this.groupsByReadyRequestId.get(input.payload.requestId);
    if (!group || group !== this.activeGroup || group.released || group.ready) {
      return;
    }

    // 逐字段比对 prepare 载荷与回执：少比一项就可能让 A 窗口的回执被当成 B 窗口的成功。
    // viewportMode 用 emulated 兜底，兼容旧 renderer 不回传该字段的情况。
    // 这里刻意不做「部分匹配」的宽松处理：宁可超时重试，也不接受身份可疑的 surface。
    const expected = group.payload;
    if (
      group.windowId !== input.windowId ||
      expected.requestId !== input.payload.requestId ||
      expected.workspaceKey !== input.payload.workspaceKey ||
      expected.sessionId !== input.payload.sessionId ||
      expected.browserId !== input.payload.browserId ||
      expected.browserGeneration !== input.payload.browserGeneration ||
      expected.tabId !== input.payload.tabId ||
      expected.webContentsId !== input.payload.webContentsId ||
      (expected.viewportMode ?? "emulated") !== (input.payload.viewportMode ?? "emulated")
    ) {
      this.options.log?.("[browser-screenshot-surface] ignored ready with mismatched identity");
      return;
    }

    if (
      group.senderWebContentsId !== undefined &&
      group.senderWebContentsId !== input.senderWebContentsId
    ) {
      this.options.log?.("[browser-screenshot-surface] ignored ready from a different renderer");
      return;
    }

    // 首个完整 scope 的可信 renderer 一经确认即冻结，防止另一个窗口的迟到回执接管请求。
    // 首位通过全部身份校验的发送方被记为该组的可信 renderer，之后不可更换。
    // 冻结时机故意放在 viewport 与 scale 校验之前：这两项失败同样说明发送方身份有效。
    // 顺序敏感，若把冻结挪到全部校验之后，另一个 renderer 的合法回执可能先抢占该组。
    // 已有值时只做比较不做赋值，第二个来源的 ready 会被直接丢弃。
    group.senderWebContentsId ??= input.senderWebContentsId;
    if (!sameBrowserScreenshotViewport(expected.viewport, input.payload.viewport)) {
      this.options.log?.("[browser-screenshot-surface] ignored ready with unstable viewport");
      return;
    }
    if (!Number.isFinite(input.payload.surfaceScale) || input.payload.surfaceScale <= 0) {
      this.options.log?.("[browser-screenshot-surface] ignored ready with invalid surface scale");
      return;
    }
    if (
      expected.surfaceScaleMode === "unscaled" &&
      Math.abs(input.payload.surfaceScale - 1) > UNSCALED_SURFACE_EPSILON
    ) {
      // 该分支守护 unscaled 契约：文件分辨率必须就是真实分辨率，容差只吸收浮点误差，不吸收缩放。
      // 拒绝发生在 finishGroupReady 之前，保证任何租约都不会携带可疑的 surfaceScale。
      // 录制器会把 Fit 后的小 surface 放大到目标 canvas，文件分辨率虽然正确但画面已模糊。
      // Main 必须在握手边界拒绝非 100% 回执，避免 renderer 回归时静默产出伪高清录像。
      this.options.log?.(
        "[browser-screenshot-surface] ignored ready with scaled recording surface",
      );
      return;
    }

    // 全部校验通过才抵达提交点：此后组变 ready，等待者被一次性 resolve。
    // 提交点之后不再有异步分支，否则会留下「部分等待者已放行、组尚未 ready」的半提交状态。
    this.finishGroupReady(group, input.payload.viewport, input.payload.surfaceScale);
  }

  handleWindowDestroyed(windowId: number): void {
    const groups = Array.from(this.groupsByGuestKey.values());
    // 销毁一个窗口可能同时失败多个组，逐个 settle 会反复触发 activateNextGroup。
    // 因此期间挂起调度，最后在 finally 统一恢复并只激活一次，避免把请求发往正在关闭的窗口。
    // 必须保留进入时的挂起值，否则会把外层已暂停的调度误恢复成运行态。
    const schedulingWasSuspended = this.schedulingSuspended;
    this.schedulingSuspended = true;
    try {
      for (const group of groups) {
        if (group.windowId === windowId) {
          this.finishGroupError(
            group,
            new Error("browser screenshot surface preparation window destroyed"),
          );
        }
      }
    } finally {
      this.schedulingSuspended = schedulingWasSuspended;
      if (!schedulingWasSuspended) this.activateNextGroup();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    // 本方法必须幂等：重复调用不得二次失败队列，也不得重复 sendRelease。
    // 置位后 prepare 立即拒绝，不再新建组，避免销毁后仍有新握手续上。
    // 这里不等待在途 lease 自行结束，而是通过 invalidationController 让持有者感知失效。
    this.disposed = true;
    const groups = Array.from(this.groupsByGuestKey.values());
    for (const group of groups) {
      this.finishGroupError(group, new Error("browser screenshot surface coordinator disposed"));
    }
  }

  private getGuestKey(input: BrowserScreenshotSurfacePrepareInput): string {
    // key 必须覆盖全部身份维度与 viewport/scale 模式，少一维就会把两种不同的 surface 需求合并。
    // 使用 JSON 数组而非字符串拼接，避免字段值里出现分隔符导致 key 碰撞。
    return JSON.stringify([
      input.windowId,
      input.workspaceKey,
      input.sessionId,
      input.browserId,
      input.browserGeneration,
      input.tabId,
      input.webContentsId,
      input.viewport.width,
      input.viewport.height,
      input.surfaceScaleMode ?? "current",
      input.viewportMode ?? "emulated",
    ]);
  }

  private activateNextGroup(): void {
    if (this.activeGroup || this.disposed) return;

    // 只有 activeGroup 为空才出队，保证 capture layer 同一时刻只有一个 owner。
    // 出队后若组已释放或已无等待者就跳过并继续，不占用 active 槽。
    // 用递归而非循环继续，是为了每次状态变化都重新走完整的前置检查。
    const group = this.queuedGroups.shift();
    if (!group) return;
    // 空组直接跳过：它可能在排队期间就被 prepare 超时或 abort 清空了请求。
    // 递归深度受队列长度约束，且每轮都 shift，不会重复处理同一个组。
    if (group.released || group.requests.size === 0) {
      this.activateNextGroup();
      return;
    }

    this.activeGroup = group;
    this.groupsByReadyRequestId.set(group.payload.requestId, group);
    if (this.options.acquireActivity) {
      // activity 租约用于截图期间抑制后台节流，拿不到就整组失败，而不是降级继续。
      // 失败走 finishGroupError，activityLease 保持未设置，settle 时不会误释放别人的租约。
      group.activityLease = this.options.acquireActivity(group.windowId, group.payload);
      if (!group.activityLease) {
        this.finishGroupError(
          group,
          new Error("browser screenshot activity could not be acquired"),
        );
        return;
      }
      const invalidated = group.activityLease.invalidated;
      if (invalidated) {
        const failForInvalidActivity = () => {
          const reason =
            invalidated.reason instanceof Error
              ? invalidated.reason
              : new Error("browser screenshot activity was invalidated");
          this.finishGroupError(group, reason);
        };
        group.activityAbortListener = failForInvalidActivity;
        invalidated.addEventListener("abort", failForInvalidActivity, { once: true });
        if (invalidated.aborted) {
          failForInvalidActivity();
          return;
        }
      }
      // 兜底定时器覆盖「activity 未失效但 ready 迟迟不来」的情形，保证整组最终仍然收敛。
      // 单请求 timer 可能在排队阶段就触发，两者叠加确保任何路径都有上限。
      // 触发时先 warn 再失败，日志带 requestId 与 windowId，便于对齐 renderer 侧记录。
      const activityTimeoutMs = group.activityTimeoutMs ?? this.activityTimeoutMs;
      group.activityTimer = setTimeout(() => {
        this.options.warn?.(
          `[browser-screenshot-surface] activity watchdog released requestId=${group.payload.requestId} windowId=${group.windowId}`,
        );
        this.finishGroupError(
          group,
          new Error(`browser screenshot activity timed out after ${activityTimeoutMs}ms`),
        );
      }, activityTimeoutMs);
    }
    // 即使 sendPrepare 返回 false，也要 release；renderer 可能已处理了消息但发送端感知到失败。
    group.prepareSent = true;
    let sent = false;
    try {
      // 发送前就把 prepareSent 置真：只要尝试过发送，settle 时必须回一次 release。
      // 返回 false 与抛异常语义不同，但都不能在组已 ready 后提前释放。
      // 同步 ready 是允许的：测试替身会立刻回调，因此 catch 与 false 分支都要重新看组状态。
      // 只有既未 ready 也未 released 时，发送失败才等价于整组失败。
      sent = this.options.sendPrepare(group.windowId, group.payload);
    } catch {
      // sendPrepare 允许测试替身同步 ready；此时 lease 已有效，后续发送异常不能提前释放它。
      if (!group.ready && !group.released) {
        this.finishGroupError(
          group,
          new Error("browser screenshot surface preparation could not be sent"),
        );
      }
      return;
    }

    if (!sent && !group.ready && !group.released) {
      this.finishGroupError(
        group,
        new Error("browser screenshot surface preparation could not be sent"),
      );
    }
  }

  private finishGroupReady(
    group: PreparationGroup,
    viewport: BrowserViewportSize,
    surfaceScale: number,
  ): void {
    if (group.ready || group.released) return;
    // 对 markPrepared 的调用可能同步触发 activity 失效，所以调用后必须重新检查 released。
    // 二次检查不是冗余：失效回调会走 finishGroupError 并把该组标记为已释放。
    // 若把顺序颠倒，后面会往已 settle 的组写 ready 状态，映射里留下幽灵条目。
    group.activityLease?.markPrepared?.();
    if (group.released) return;
    group.ready = true;
    group.readySurfaceScale = surfaceScale;
    group.readyViewport = viewport;
    this.groupsByReadyRequestId.delete(group.payload.requestId);

    const requests = [...group.requests];
    group.requests.clear();
    for (const request of requests) {
      this.clearRequest(request);
      request.resolve(this.createLease(group, request.input.signal));
    }
  }

  private finishRequestError(request: PendingRequest, error: Error): void {
    // 以 delete 是否成功作为「本次失败是否有效」的判据，天然防止重复 settle。
    // 失败后若组仍未 ready 且已无其他等待者，立即 settle 释放 active 槽。
    // 组已 ready 时不清组：其余 lease 仍在使用该 surface，清掉会让它们失去归属。
    const { group } = request;
    if (!group.requests.delete(request)) return;
    this.clearRequest(request);
    request.reject(error);
    if (!group.ready && group.requests.size === 0) {
      this.settleGroup(group);
    }
  }

  private finishGroupError(group: PreparationGroup, error: Error): void {
    if (group.released) return;
    if (!group.invalidationController.signal.aborted) {
      // 用同一个 error 中止 invalidationController，所有已发出的 lease 会同步收到失效通知。
      // abort 前检查信号状态，避免重复中止覆盖掉首个根因。
      // 先广播失效再拒绝等待者，保证租约持有者不会经历「已失效但未通知」的空窗。
      group.invalidationController.abort(error);
    }
    const requests = [...group.requests];
    group.requests.clear();
    for (const request of requests) {
      this.clearRequest(request);
      request.reject(error);
    }
    this.settleGroup(group);
  }

  private clearRequest(request: PendingRequest): void {
    clearTimeout(request.timer);
    request.input.signal.removeEventListener("abort", request.abortListener);
  }

  private createLease(group: PreparationGroup, signal: AbortSignal): BrowserScreenshotSurfaceLease {
    let release!: () => void;
    // 先声明后赋值：onAbort 闭包捕获变量本身，而不是赋值前的占位值，调用时才指向真正实现。
    // 监听注册在赋值之后，因此不存在监听先于实现就绪而触发的窗口。
    // 每个 lease 移除自己的监听，不影响同一 signal 上的其他监听者。
    const onAbort = () => release();
    release = releaseBrowserScreenshotResourceOnce(() => {
      signal.removeEventListener("abort", onAbort);
      group.leaseReleases.delete(release);
      if (group.released) return;
      if (group.leaseReleases.size === 0) {
        this.settleGroup(group);
      }
    });
    group.leaseReleases.add(release);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) release();

    return {
      invalidated: group.invalidationController.signal,
      surfaceScale: group.readySurfaceScale ?? 1,
      webContentsId: group.payload.webContentsId,
      viewport: group.readyViewport ?? group.payload.viewport,
      release,
    };
  }

  private settleGroup(group: PreparationGroup): void {
    if (group.released) return;
    // 本方法是组的唯一终结点：置 released 后所有入口短路，因此必须先置位再开始清理。
    // settleGroup 的清理范围必须包含两张映射、队列、activity 定时器、全部 lease 以及 activity 租约。
    // 先删映射再 splice 队列，保证任何重入都看不到半清理状态。
    group.released = true;
    if (group.activityTimer) {
      clearTimeout(group.activityTimer);
      group.activityTimer = undefined;
    }
    this.groupsByGuestKey.delete(group.key);
    this.groupsByReadyRequestId.delete(group.payload.requestId);

    const queuedIndex = this.queuedGroups.indexOf(group);
    if (queuedIndex >= 0) {
      this.queuedGroups.splice(queuedIndex, 1);
    }

    try {
      if (group.prepareSent) {
        this.options.sendRelease(
          group.windowId,
          toBrowserScreenshotSurfaceReleasePayload(group.payload),
        );
      }
    } catch {
      // release 发生在 timeout/abort/backend finally 中，transport 同步异常不能让
      // activeGroup 永久占位，也不能阻止 screenshot activity lease 恢复后台节流。
      this.options.log?.("[browser-screenshot-surface] release send failed");
    } finally {
      for (const release of group.leaseReleases) release();
      group.leaseReleases.clear();
      const activityInvalidated = group.activityLease?.invalidated;
      if (activityInvalidated && group.activityAbortListener) {
        activityInvalidated.removeEventListener("abort", group.activityAbortListener);
      }
      group.activityAbortListener = undefined;
      group.activityLease?.release();
      group.activityLease = undefined;
    }

    if (this.activeGroup === group) {
      this.activeGroup = undefined;
      if (!this.schedulingSuspended) this.activateNextGroup();
    }
  }
}
