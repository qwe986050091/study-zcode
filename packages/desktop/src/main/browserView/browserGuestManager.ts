/* eslint-disable max-lines -- IAB owner registry、ready/abort lifecycle 与 guest CDP 状态必须在同一状态机内原子维护，拆散会重新引入跨 scope 竞态。 */
// ===========================================================================
// INV 不变量表（IAB guest 状态机）
// 本文件同时持有 owner registry、ready/abort lifecycle 与 guest CDP 状态。以下断言在任
// 何时刻都必须成立；每条都标注唯一守住它的位置，改这些位置前先证明不破坏断言。
// 格式：INV-nn：<断言>（守住它的位置：<函数/变量>）
// ===========================================================================
// INV-01：同一 scopeKey 最多一个 active tab，activeTabByScope 与 tab.active 必须一致。
//   （守住它的位置：selectTab / effectiveActiveTabId / reportResidency）
// INV-02：tab.guest 与 guestGeneration 必须成对更新；换代漏 +1 会让旧命令落到新 guest。
//   （守住它的位置：attachGuest 的 isSameGuest 分支 / assertCurrentGuest）
// INV-03：guestLifecycle 只能 attached→detaching→detached/destroyed 退行，不得跳级。
//   （守住它的位置：attachGuest / runGuestTeardown / detachGuest）
// INV-04：DOM 卸载 webview 前 native CDP 必须已 detach；否则 DevToolsSession 隐式析构会 UAF。
//   （守住它的位置：detachGuestBeforeReplacement / setupCdpCrashGuard / runGuestTeardown）
// INV-05：pendingCdpCommands 归零前禁止宣称 CDP 空闲或 teardown 成功。
//   （守住它的位置：sendGuestCdpCommandRaw 的 finally / waitForGuestCdpIdle）
// INV-06：每个 tab 最多一个 guestAttachFlight；并发命令必须复用同一 flight，不能各自建 webview。
//   （守住它的位置：ensureGuest / guestAttachFlights）
// INV-07：每个 tab 最多一个 restoreFlight / recoveryFlight / teardownFlight。
//   （守住它的位置：restoreSuspendedGuest / waitForGuestRecovery / beginGuestTeardown）
// INV-08：requestId 在 runningRequests 生命周期内唯一；重复入队必须在 dispatch 前失败。
//   （守住它的位置：execute 的 duplicate_request_id 分支）
// INV-09：runningRequests 的删除必须按 entry identity，不能按 key 盲删。
//   （守住它的位置：execute 的 finally 块）
// INV-10：取消只对 sameScope 的请求生效；requestId 只是关联键，不是授权凭证。
//   （守住它的位置：abortRequest）
// INV-11：tab 查找必须经 sameScope/resolveTab；跨 window/workspace/session 一律不可见。
//   （守住它的位置：resolveTab / ownedTabs / requireRendererOwnedTab）
// INV-12：user tab 只能被同 window/workspace/session 的上下文 claim 一次。
//   （守住它的位置：canClaimUserTab / claimTab）
// INV-13：claim 即激活；未激活的 human tab 不产帧，截图 prepare 会超时。
//   （守住它的位置：claimTab 内的 selectTab(tab, true)）
// INV-14：deliverable / closeSession / turnEnded 只释放控制权，不销毁用户可见 tab。
//   （守住它的位置：releaseToUser / endTurn / closeSession / finalizeTabs）
// INV-15：tab.lifecycle=closed 是终态；关闭先写 tombstone 再通知 renderer，持久化删除随后完成。
//   （守住它的位置：closeTabDurably / closeTab / closedTabIds）
// INV-16：closedTabIds tombstone 只增不清（除 disposeAll），用于拒绝迟到 attach 复活 tab。
//   （守住它的位置：closeTab / attachGuest 的 closed 分支）
// INV-17：快照先写 shell(URL/title) 再写 pageState；pageState 与 shell URL 不一致时必须丢弃。
//   （守住它的位置：persistRecoverySnapshot / restoreGuestState）
// INV-18：guest 重绑恢复未完成时，不得用临时 guest 的 URL/title 覆盖 logical cache。
//   （守住它的位置：summary / userTabInfo / attachGuest 的 guestRecoveryFlights 处理）
// INV-19：suspended/restoring 只允许当前旧 guest 重复上报，不接受新 attach。
//   （守住它的位置：attachGuest 的 rejectsNewGuest 分支 / markAttached）
// INV-20：residency generation 单调递增；迟到 attach 的 generation 不匹配必须 fail closed。
//   （守住它的位置：runRestoreSuspendedGuest / attachGuest 的 generation-mismatch 分支）
// INV-21：viewport set/reset/clear 必须串行；临界区内不得再次入队等待自己。
//   （守住它的位置：enqueueViewportMutation / insideViewportMutation）
// INV-22：backgroundViewportFallback 只服务后台执行，tab 回前台必须清除，否则页面钉死。
//   （守住它的位置：readTabViewport / maybeRestoreBackgroundViewport）
// INV-23：同 tab 最多一个在飞截图；abandoned capture 上限 3，超过后快速失败不再叠 CDP。
//   （守住它的位置：executeInScope 的 screenshot 分支 / abandonBackendCapture）
// INV-24：截图 abort/deadline 必须先于底层 capture 结算返回，且只按 entry identity 清理。
//   （守住它的位置：settleScreenshotCapture / clearTrackedScreenshot）
// INV-25：recording 终态幂等；cleanupTimer 只挂一次，artifact 在 TTL 后删除。
//   （守住它的位置：setRecordingTerminal / abortRecordings）
// INV-26：download waiter 必须在 resolve/abort/timeout/closeTab 四条路径都被移除。
//   （守住它的位置：waitForDownload / finishDownloadWaiter / closeTab）
// INV-27：CDP message / render-process-gone / will-download 监听必须随 guest 换代注销。
//   （守住它的位置：setupDialogTracking / setupCdpCrashGuard / setupDownloadTracking / detachGuest）
// INV-28：dialog 缓存只反映当前 guest；detach、closeTab、成功的 handleDialog 都必须清理。
//   （守住它的位置：pendingDialogs / handleDialog / detachGuest）
// INV-29：所有 CDP 调用必须经 toControlledView/sendGuestCdpCommand 做代际断言。
//   （守住它的位置：toControlledView 的 assertCurrent 包装）
// INV-30：meta 中的 URL 必须脱敏（去 userinfo/query/hash），不得进入模型轨迹。
//   （守住它的位置：sanitizeBrowserMetaUrl / withMeta）
// INV-31：closeWindow 必须清空该窗口的 tab 与 natural viewport 缓存，避免窗口复用时串味。
//   （守住它的位置：closeWindow / naturalViewportByWindow）
// INV-32：attachGuest 的 reason 必须与 BrowserGuestAttachRejectReason 对齐；非 webview 一律 fail closed。
//   （守住它的位置：attachGuest 的 not-webview / window-mismatch / session-mismatch 分支）
// INV-33：ok=false 时 sideEffect 必须如实反映是否已 dispatch；已下发只能报 uncertain。
//   （守住它的位置：cancelledResult / raceBackendExecution / running.dispatched）
// INV-34：disposeAll 之后所有 flight、waiter、timer 都必须已结算，不能留下悬挂 promise。
//   （守住它的位置：disposeAll）
// ===========================================================================
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { webContents, type WebFrameMain } from "electron";
import {
  BROWSER_VIEWPORT_LIMITS,
  DEFAULT_AGENT_BROWSER_VIEWPORT,
  type BrowserClientMode,
  type BrowserCommand,
  type BrowserCommandResult,
  type BrowserGuestAttachRejectReason,
  type BrowserGuestAttachResult,
  type BrowserDialog,
  type BrowserRecordingAction,
  type BrowserRecordingJob,
  type BrowserRecordingOptions,
  type BrowserResponseMeta,
  type BrowserTabSummary,
  type BrowserUserTabInfo,
  type BrowserViewCloseTabRequest,
  type BrowserViewResidencyReportPayload,
  type BrowserViewResidencyTransitionPayload,
  type BrowserViewRestoredTabShell,
  type BrowserViewportSize,
} from "@zcode/shared";
import { executeBrowserCommandOnView, type ControlledView } from "./browserCommandExecutor.js";
import { executeIabPlaywrightLocator } from "./browserPlaywrightLocatorExecutor.js";
import { recordBrowserVideo, type BrowserWebmRecorderFactory } from "./browserVideoRecorder.js";
import { normalizePlaywrightTimeout } from "./browserPlaywrightTimeout.js";
import type {
  BrowserScreenshotSurfaceCoordinator,
  BrowserScreenshotSurfaceLease,
} from "./browserScreenshotSurfaceCoordinator.js";
import {
  startBrowserScreenshotTransparentWindowBootstrap,
  TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS,
  type BrowserWindowForTransparentBootstrap,
  type TransparentWindowBootstrap,
} from "./browserTransparentWindowBootstrap.js";
import {
  BrowserTabResidencyCoordinator,
  type BrowserTabResidencyRecord,
} from "./browserTabResidencyCoordinator.js";
import type {
  BrowserTabPageStateRecord,
  BrowserTabRecoveryStore,
  BrowserTabShellRecord,
} from "./browserTabRecoveryStore.js";

// GuestWebContents 用结构类型声明而不是 Electron.WebContents：单测与旧 renderer 传入的
// 替身只实现这几十个成员，若绑定真实类型，所有测试都要伪造完整 WebContents 继承链。
// 这里的成员就是 guest 生命周期的全部接触面——少一个（如 isDestroyed）会在崩溃路径上
// 失去 fail-closed 判断；多一个则把 main 侧实现细节泄漏给调用方。
// 所有可选成员（on/removeListener/isCurrentlyAudible/session）都必须经 safeBool/safeStr
// 调用，旧替身缺方法时不能让整个 tab 收口抛错。
interface GuestWebContents {
  readonly id: number;
  readonly hostWebContents?: { getZoomFactor(): number } | null;
  readonly mainFrame: WebFrameMain;
  getType(): string;
  getZoomFactor(): number;
  setZoomFactor(factor: number): void;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  reload(): void;
  stop(): void;
  capturePage(): Promise<{ toPNG(): Buffer }>;
  executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>;
  navigationHistory: {
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack(): void;
    goForward(): void;
    getAllEntries(): Array<{ url: string; title?: string; pageState?: string }>;
    getActiveIndex(): number;
    restore(options: {
      entries: Array<{ url: string; title?: string; pageState?: string }>;
      index: number;
    }): Promise<void>;
  };
  close(options?: { waitForBeforeUnload?: boolean }): void;
  isCurrentlyAudible?(): boolean;
  isBeingCaptured?(): boolean;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
  debugger: {
    isAttached(): boolean;
    attach(protocolVersion?: string): void;
    detach(): void;
    sendCommand(method: string, params?: unknown, sessionId?: string): Promise<unknown>;
    on(event: "message", listener: (event: unknown, method: string, params: unknown) => void): void;
    removeListener(
      event: "message",
      listener: (event: unknown, method: string, params: unknown) => void,
    ): void;
  };
  once(event: "destroyed", listener: () => void): void;
  session?: {
    on(
      event: "will-download",
      listener: (event: unknown, item: GuestDownloadItem, contents: GuestWebContents) => void,
    ): void;
    removeListener(
      event: "will-download",
      listener: (event: unknown, item: GuestDownloadItem, contents: GuestWebContents) => void,
    ): void;
  };
}

// DownloadItem 只暴露本文件需要的两个方法（取保存路径、等 done 事件）。will-download
// 的完整对象还有 pause/cancel/resume，但 IAB 的语义只是“等文件落盘后把路径交给
// Playwright”，多暴露能力会诱导调用方在不持有下载归属时取消别人的下载。
// getSavePath 在 done 之前可能返回空串，因此记录里的 path 允许为 null，由 done 回填。
// 这里只声明结构不引用 Electron 类型，避免下载替身在测试里被迫实现无关方法。
interface GuestDownloadItem {
  getSavePath(): string;
  once(event: "done", listener: (event: unknown, state: string) => void): void;
}

// 执行上下文是 IAB 的唯一授权凭证：windowId/workspaceKey/sessionId/remoteSessionId 共同
// 决定一个 tab 对谁可见、能被谁操作。remoteSessionId 单独存在是为了区分“同一 session
// 但重连后的 remote runtime”，attach 时严格比对可以阻止旧 runtime 接管新对话的 tab。
// legacy 标志只由 string 入参的兼容路径产生（normalizeLegacyContext），新调用方一旦
// 传字符串就落入独立 legacy scope，不会与结构化上下文意外共享 tab。
// turnId 是结算单位：turnEnded 只 abort 同一 turn 的请求，不能误杀并行 turn。
export interface BrowserGuestExecutionContext {
  // requestId 是 runningRequests 的键：重复入队必须在 dispatch 前被拒（INV-08），
  // 换成别的字段会让两个并发请求共用同一 AbortController，取消一个就连带杀掉另一个。
  requestId: string;
  browserId: string;
  // browserGeneration 参与 scopeKey 与 attach 比对：换代后旧命令必须 fail closed（INV-20），
  // 缺这一维时同一 browser 重启前后的 tab 会互相可见。
  browserGeneration: number;
  // windowId 由 IPC 层从 sender 绑定，是跨窗口隔离的唯一依据；renderer 自报的值一旦被采信，
  // 任意窗口都能借 closeWindow 清掉别的窗口的 tab。
  windowId: number;
  // workspaceKey 既进 scopeKey 又写进 BrowserTabShellRecord：改名会让重启前的恢复记录
  // 全部归属到另一个工作区，用户看到的是“tab 全没了”而不是报错。
  workspaceKey: string;
  // sessionId 参与 ownedBySession 比对并被持久化到 shell 记录；写成窗口级 id 会让同窗口
  // 两个会话互相 claim 对方的 user tab。
  sessionId: string;
  turnId?: string;
  remoteSessionId?: string;
  clientMode: BrowserClientMode;
}

interface InternalExecutionContext extends BrowserGuestExecutionContext {
  legacy?: boolean;
}

// 两个生命周期正交：TabLifecycle 描述产品语义（active/deliverable/handoff/closed），
// GuestBindingLifecycle 描述 native CDP 绑定（detached/attached/detaching/destroyed）。
// 不能合并成一个枚举：deliverable 的 tab 仍可能 attached，detaching 期间 tab 也可能
// 仍是 active。混淆二者会让 closeTab 误以为 CDP 已断开，或让 detachGuest 提前清掉
// 仍需要保留的产品态。GuestRecoveryReason 额外并入 guest-destroyed/attach-timeout，
// 因为它们是重绑触发条件而不是 attach 拒绝原因。
type TabLifecycle = "active" | "deliverable" | "handoff" | "closed";
// 取值只能沿 attached→detaching→destroyed 单向推进，detached 是未绑定起点，不得跳级（INV-03）；
// 跳过 detaching 直接 destroyed 会让 native CDP 在 DOM 卸载后仍挂着，DevToolsSession
// 隐式析构即 UAF（INV-04）。
type GuestBindingLifecycle = "detached" | "attached" | "detaching" | "destroyed";
type GuestRecoveryReason = BrowserGuestAttachRejectReason | "guest-destroyed" | "attach-timeout";

// 这段提示会原样进入模型上下文，措辞必须区分“动作前 stale binding 恢复”和“动作后
// popup 观察”：直接建议新建 tab 会在已有绑定上再开一个空页，导致用户页面被顶掉。
// 先 list/get 再回退到 user.openTabs/claimTab，保证模型只在受控列表真的为空时才换 tab。
// 改这段文案等于改模型行为，不能删掉 claimTab 前缀，否则 human tab 永远无法被接管。
const TAB_CONTEXT_RECOVERY_HINT =
  "This is pre-action stale-binding recovery, not post-action popup observation. " +
  "Keep the existing browser binding; call browser.tabs.list(), then browser.tabs.get(info.id). " +
  "If the controlled list is empty, inspect browser.user.openTabs() and use browser.user.claimTab(info) " +
  "before creating a new tab.";

// ManagedTab 是 logical tab 的全部事实：owner、guest 代际、viewport、恢复缓存。
// 关键不变量是“logical tab 比 guest 长寿”——guest 销毁/换代只清 guest 相关字段，
// tabId/owner/cachedUrl/lifecycle 必须保留，否则关闭后的 tombstone 与恢复快照都会丢。
// 每个可选清理字段都对应一条独立路径（downloadCleanup/activityCleanup/...），新增字段
// 时必须同步更新 detachGuest 与 disposeAll，只加字段不加清理会随 guest 换代累积。
// 禁止把 guest 与 cached* 混用：cached* 是 logical 事实，guest 只是当前实现。
interface ManagedTab {
  // tabId 同时是恢复仓库主键、closedTabIds 墓碑键与 renderer 侧寻址键；三处必须同一个值，
  // 换掉会让恢复记录、迟到 attach 拒绝与 UI 选中项各自指向不同 tab。
  tabId: string;
  // owner 是命令派发时 sameScope 的比对基准，不是创建时的快照：claimTab 与 finalizeTabs
  // 都会整体替换它，漏换会让新会话继续操作上一个会话留下的 tab。
  owner: InternalExecutionContext;
  guest?: GuestWebContents;
  /** guest replacement generation；命令 dispatch 前用来拒绝 stale guest。 */
  guestGeneration: number;
  /** 曾经成功绑定过 guest；用于区分新建 tab 的首次等待与已有 tab 的自愈。 */
  hasAttachedGuest: boolean;
  attachFailure?: GuestRecoveryReason;
  // 重绑请求的在途标志：requestGuestRebind 置真、attachGuest 成功时复位。漏复位会让
  // runGuestAttachFlight 跳过 onOpenTabRequested，从未挂载过 webview 的新 tab 只能等超时。
  rebindRequested: boolean;
  // guest.debugger.isAttached() 的镜像，供空闲释放与 teardown 快速判定；native detach 后
  // 必须同步置 false（INV-04），残留 true 会让 teardown 误以为 CDP 仍连着而不必先断开。
  cdpAttached: boolean;
  /** guest 的 native CDP 生命周期；DOM 销毁前必须先经过 detaching。 */
  guestLifecycle: GuestBindingLifecycle;
  /** 尚未 settle 的 debugger.sendCommand 数量，teardown 会等待其归零或超时。 */
  pendingCdpCommands: number;
  /** 命令流空闲释放的计时器；每次 CDP 命令完成后重置，detachGuest 时清除。 */
  guestCdpIdleTimer?: ReturnType<typeof setTimeout>;
  /** re-attach 会话态恢复 flight；业务命令必须 await 它完成才能派发（串行屏障）。 */
  guestCdpRestoreFlight?: Promise<void>;
  /** 当前已持有 viewport 临界区；CDP 重连直接重放，不能再次入队等待自己。 */
  insideViewportMutation?: boolean;
  /** 同一 guest 的 replacement teardown 只允许一个 flight，重复 ACK 共享结果。 */
  guestTeardownFlight?: Promise<boolean>;
  // lifecycle=closed 是终态（INV-15）：先写墓碑再通知 renderer，任何路径都不能把它改回
  // active，否则关闭中的 tab 会被迟到的命令复活。
  lifecycle: TabLifecycle;
  origin: "agent" | "user";
  /** human IAB tab 在同 window/workspace 首次操作前可被任一 session 发现。 */
  claimable: boolean;
  /** claimed user tab finalize/closeSession 时恢复为用户 tab，不能像 agent tab 一样关闭。 */
  userOwner?: InternalExecutionContext;
  // active 必须与 activeTabByScope 中该 scope 的取值一致（INV-01）；只改一边会让
  // effectiveActiveTabId 与 tab.active 给出两个不同的“当前 tab”。
  active: boolean;
  /** Agent/UI 设置的单 tab CSS viewport；undefined 表示跟随宿主自然尺寸。 */
  viewportOverride?: BrowserViewportSize;
  /** pane 隐藏为 0×0 时仅供后台执行使用；重新前台可见后必须清除。 */
  backgroundViewportFallback?: BrowserViewportSize;
  /** 串行化 transient clear 与显式 set/reset，保证最后一次用户/Agent 设置胜出。 */
  viewportMutation?: Promise<void>;
  downloadCleanup?: () => void;
  activityCleanup?: () => void;
  /**
   * 注销 debugger 的 "message" 监听。guest 换代后旧监听不该继续挂着：它每次事件都要查表
   * 再靠 current.guest !== guest 兜底丢弃，属于纯泄漏。注意这只是 JS 层清理，native 侧的
   * CDP 通路要靠 debugger.detach() 才真正断开。
   */
  cdpMessageCleanup?: () => void;
  /**
   * 注销 render-process-gone 监听。该监听负责在 guest renderer 被杀、WebContents 尚存的
   * 窗口里主动断开 CDP —— 这是唯一能避免 api::Debugger 走隐式析构的时机。
   */
  crashGuardCleanup?: () => void;
  loading: boolean;
  mediaActive: boolean;
  // cached* 是 logical 事实，guest 换代时不能清也不能用临时 guest 的 URL 覆盖（INV-18）；
  // 覆盖后恢复快照会记住重绑时的 about:blank，用户回来看到空页而不是原页面。
  cachedUrl: string;
  cachedTitle: string;
  cachedFaviconUrl: string | null;
  openedAt: number;
  // 标记该 shell 来自恢复仓库且 restore 尚未完成：只有它为真时，无 cachedUrl 才允许按
  // recovery-orphan 关闭（closeTab 的孤儿分支），提前置假会让空 URL 的恢复 tab 永远留在内存里。
  restoredFromStore?: boolean;
}

// waiters 是“命令在等 renderer 完成 attach”的挂起队列。timer 必须有，因为 renderer
// 可能永远不 ready（窗口隐藏、崩溃、webview 未挂载）；没有超时会让 execute 永久挂起。
// signal/onAbort 也必须保存：request abort 后要立刻从队列摘除并 resolve(null)，
// 否则已取消的命令仍占着 tab 的 attach flight。resolve 只接受 null 或 guest，
// 不允许 reject——超时/取消对调用方都是“没拿到 guest”，走同一 fail-closed 分支。
interface PendingWaiter {
  resolve: (guest: GuestWebContents | null) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

// dispatched 记录是否真正把命令交给 backend（CDP 或 executeBrowserCommandOnView）。
// 取消结果里的 sideEffect 完全由它决定：未下发报 none，已下发必须报 uncertain，
// 否则模型会以为取消等于“什么都没发生”而重复执行写操作。
// tabId 用于 refreshRuntimeProtection 与 teardown 精准 abort；未解析到 tab 的请求
// （list/nameSession 等）保持 undefined，不能误伤同 scope 其它 tab。
interface RunningRequest {
  context: InternalExecutionContext;
  controller: AbortController;
  dispatched: boolean;
  tabId?: string;
}

// 截图没有单请求取消 API，所以 tracker 只保存 promise 与起始时间，不保存取消句柄。
// requestId 用来判断“对应命令是否还在 runningRequests 里”——条目消失意味着命令早已
// 返回（watchdog 判死）而 execution 悬空，属于可被新截图取代的死槽位。
// 禁止在这里存 tab/guest 引用：tab 关闭后若 tracker 还持有 guest，会把已销毁对象
// 拖到 GC 之后，并在迟到 settle 时误触发 refresh。
interface InFlightScreenshot {
  execution: Promise<BrowserCommandResult>;
  requestId: string;
  startedAt: number;
}

// 录制是长任务，必须在 tab 关闭/turn 结束/窗口关闭时都能被 abort。controller 由 entry
// 自己持有而不是复用请求 signal，因为 recordingStart 会立即返回，命令生命周期早已结束。
// cleanupTimer 负责 TTL 后删除 artifact 文件；重复进入终态时不能重复挂 timer，否则
// 第二次 setTimeout 会把已删除 entry 的路径再删一次（rm force 幂等但计数会乱）。
// status 与 phase 分离：status 是终态机（running/completed/failed/cancelled），
// phase 只是进度展示（preparing/capturing/finalizing），不能拿 phase 判断是否可取消。
interface BrowserRecordingEntry {
  id: string;
  context: InternalExecutionContext;
  tabId: string;
  controller: AbortController;
  status: BrowserRecordingJob["status"];
  phase: BrowserRecordingJob["phase"];
  progress: number;
  startedAt: number;
  updatedAt: number;
  artifact?: BrowserRecordingJob["artifact"];
  error?: string;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

interface DownloadRecord {
  tabId: string;
  // path=null 表示 done 事件尚未到达，此时 getSavePath 可能是空串或临时名；调用方必须
  // 同时检查 state=pending，不能只凭 path 非空就去打开文件。
  path: string | null;
  // 四态里只有 completed 可以读 path；interrupted/cancelled 仍保留记录是为了让迟到 waiter
  // 拿到明确失败，而不是继续等下一个 will-download。
  state: "pending" | "completed" | "cancelled" | "interrupted";
}

interface DownloadWaiter {
  resolve: (downloadId: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal;
  onAbort: () => void;
}

// 10s 是 renderer 挂载 webview 并回传 attach 的上限。调小会在慢机器上把正常首次
// attach 判成超时并触发重绑，形成“越重试越慢”的抖动；调大则会让真正失败的 tab
// 长时间占住 execute，用户侧表现为命令卡住而不是明确报错。
// 该值同时是 waitForGuest 的 timer 与 attach-timeout 重绑判定依据，两处必须一致。
const DEFAULT_ATTACH_TIMEOUT_MS = 10_000;
// 透明 presentation 已就位时整幅 capture 的硬上限；正常应在数百 ms 内完成。
const HIDDEN_WINDOW_CAPTURE_DEADLINE_MS = 5_000;
// 单个 tab 上"已放弃等待但底层 CDP capture 仍未结算"的硬上限。CDP 截图没有单请求
// 取消 API，重试会在 Chromium 内遗留 pending command；compositor 持续不可用时
// 不设上限会无限叠加（帧恢复时它们会同时排空，但 pendingCdpCommands 不归零、
// detach 走超时路径）。达到上限后同 tab 截图快速失败并提示重开 tab，旧 capture
// 真实落定后名额自动回收。
const MAX_ABANDONED_SCREENSHOT_CAPTURES = 3;
/** teardown 等待 CDP 在途命令收敛的上限；超时后仍会尝试 native detach。 */
const DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS = 1_000;
// CDP 命令流空闲释放阈值：覆盖实测崩溃窗口（turn 内命令间隙 0.4~9s）的同时，
// 不打断 agent 密集操作流（命令间隔通常远小于该值）。
const DEFAULT_GUEST_CDP_IDLE_RELEASE_MS = 1_500;
// 录制结果保留 1 小时：turn 结束后模型仍可能通过 recordingStatus 读取下载地址，
// 过早删除会让“刚录完就取不到文件”。但 artifact 是磁盘文件，不能永久保留。
// 到期时同时删 map entry 与文件，二者必须在同一回调里完成，否则会出现 map 已删、
// 文件仍在（泄漏）或文件已删、map 仍返回坏路径（误导调用方）。
const RECORDING_RESULT_TTL_MS = 60 * 60 * 1_000;
// 800×600 只是“拿不到自然尺寸”时的兜底，不是产品默认窗口。它必须落在
// BROWSER_VIEWPORT_LIMITS 内，否则 applyBackgroundViewportFallback 会被
// assertViewportOverride 拒绝，后台 tab 永久 0×0。不能改大：后台并发 tab 多时
// 每个 guest 都按该尺寸合成，尺寸越大显存/CPU 越高，而用户根本看不见。
const DEFAULT_BACKGROUND_BROWSER_VIEWPORT: BrowserViewportSize = {
  width: 800,
  height: 600,
};

type BrowserTabRecoveryStorePort = Pick<
  BrowserTabRecoveryStore,
  "upsert" | "upsertPageState" | "getPageState" | "removePageState" | "remove" | "listShells"
> &
  Partial<Pick<BrowserTabRecoveryStore, "whenIdle">>;

// residency 选项把“资源预算/恢复仓库/录制能力”注入管理器，生产与测试用不同实现。
// recoveryStore 是唯一持久化出口：缺省时恢复逻辑退化为内存态，但不能因此改变 tab
// 生命周期语义。onSuspend/onRestore/onResidencyChanged 是 renderer 通知通道，
// 必须允许缺失（单测），但缺失时 coordinator 仍要完成状态迁移，否则 generation 会卡住。
// recording.createRecorder 缺失时 recordingStart 必须明确失败，不能静默产出空 artifact。
export interface BrowserGuestManagerResidencyOptions {
  tabLimit?: number;
  suspendAckTimeoutMs?: number;
  now?: () => number;
  recoveryStore?: BrowserTabRecoveryStorePort;
  onSuspendTabRequested?(payload: BrowserViewResidencyTransitionPayload): void;
  onRestoreTabRequested?(payload: BrowserViewResidencyTransitionPayload): void;
  onResidencyChanged?(payload: BrowserViewResidencyTransitionPayload): void;
  // 恢复失败且无缓存 URL 的孤儿 tab 由 main 直接 closeTab(tab, false)，不通知 renderer，
  // 因此必须靠这个回调让 UI 移除标签；缺省时 renderer 会留下一个点不动的死 tab。
  onRecoveryOrphanCloseRequested?(payload: { tabId: string; reason: "recovery-orphan" }): void;
  warn?(message: string): void;
  recording?: {
    tempRoot?: string;
    createRecorder?: BrowserWebmRecorderFactory;
    now?: () => number;
  };
}
// Desktop zoom 的布局补偿只在 renderer 完成；metrics 是 per-session 状态，命令空闲 detach
// 后会被清掉，若在这里带 scale，空闲时页面会退回另一套布局，操作期间变大、空闲变回。
// metrics 是 per-session 状态：CDP detach 后被 Chromium 清空，重连时必须原样重放。
// 这里刻意不带 Desktop 的布局缩放补偿——缩放只在 renderer 完成，若写进 metrics，
// 空闲 detach 后页面会退回另一套布局，操作期间变大、空闲变回，用户看到明显跳变。
// dontSetVisibleSize 保留 Electron webview 的真实 bounds：CDP 只接管 CSS viewport，
// 否则 Retina 上只分配 1x surface，网页只覆盖 frame 左上角。
// buildViewportMetricsOverride 是普通命令、截图、录制的共同基准，改任一字段都必须同时验证三条路径。
function buildViewportMetricsOverride(viewport: BrowserViewportSize): Record<string, unknown> {
  // 返回类型写成 Record<string, unknown> 而不是 Emulation.setDeviceMetricsOverride 的参数类型：
  // 这个对象同时喂给普通命令、截图与录制三条 CDP 路径，过早绑定某一条的参数形状会让另外
  // 两条无法复用同一基准。改任一字段都必须三条路径一起验证。
  return {
    // 宽高取 tab 级 viewportOverride，不是窗口尺寸：同一窗口内不同 tab 可以有各自的 CSS viewport。
    width: viewport.width,
    // height 与 width 必须成对写入：Emulation.setDeviceMetricsOverride 缺任一项会沿用上一次的值。
    height: viewport.height,
    // CDP 默认会让 DPR=1 的页面指标同时接管 visible size，Retina 上因此只分配
    // 1x native surface，虽然 DOM bounds 正确，网页却只覆盖 frame 左上角。visible surface
    // 应继续由 Electron <webview> 的实际 bounds 管理，CDP 只负责 CSS viewport 与截图 DPR。
    deviceScaleFactor: 1,
    // mobile=false 不能改成 true 来“模拟手机”：它同时切换 UA 与 viewport meta 行为，
    // 会让现有站点的响应式断点整体偏移，且无法通过 viewport 宽高单独纠正。
    mobile: false,
    // 值固定为 true，不是可配置项：一旦允许调用方覆盖，截图 DPR 与布局 bounds 会来自两套坐标系。
    dontSetVisibleSize: true,
  };
}

// scope 是 Map 的复合 key，用 \u0000 分隔避免字段拼接碰撞（workspace 名里可能出现 : /）。
// legacy 单独短路成 "legacy"：旧 renderer 只传字符串时没有 browserId/generation，
// 若参与正常拼接会与某个真实 scope 偶然同 key，导致 legacy 命令操作到新对话的 tab。
// 字段顺序一旦改变，内存中的旧 key 全部失配（表现为 tab 突然消失），不能重排。
// 注意不要加入 requestId/turnId：它们是单请求维度，会把同一会话拆成多个 scope。
function scopeKey(context: InternalExecutionContext): string {
  if (context.legacy) return "legacy";
  // 七段顺序固定且不能重排：browserId、browserGeneration、windowId、workspaceKey、remoteSessionId、
  // sessionId、clientMode。调换任意两段会让内存中已有 scopeKey 全部失配（表现为 tab 集体
  // 消失），只能整体迁移；remoteSessionId 缺省填空串是为了保持段数恒定。
  return [
    context.browserId,
    String(context.browserGeneration),
    String(context.windowId),
    context.workspaceKey,
    context.remoteSessionId ?? "",
    context.sessionId,
    context.clientMode,
  ].join("\u0000");
}

/** tab 归属的 session 身份：不含 browserId / generation，释放回 user-tab 集合的 tab 仍然匹配。 */
// 只比较 window/workspace/session，不含 browserId 与 generation：finalize/session 关闭
// 会把 tab 释放回 unclaimed-iab scope，但它的“会话归属”没变，原 session 仍能认领。
// 若把 browserId 纳入，releaseToUser 后的 tab 就永远认领不回来；若去掉 windowId，
// 多窗口同 workspace 会互相看到对方的用户 tab，造成跨窗口接管。
// remoteSessionId 用空串归一：local 与 remote 的缺省值必须区分于显式 id。
function ownedBySession(
  owner: InternalExecutionContext,
  context: InternalExecutionContext,
): boolean {
  // 四个字段全部相等才算同一会话归属：windowId 防跨窗口接管，workspaceKey 防跨项目，
  // remoteSessionId 区分重连后的新旧 runtime，sessionId 是最终身份。刻意不比较 browserId
  // 与 browserGeneration：finalize 后 tab 退回未认领集合，但会话归属从未改变。
  return (
    owner.windowId === context.windowId &&
    owner.workspaceKey === context.workspaceKey &&
    (owner.remoteSessionId ?? "") === (context.remoteSessionId ?? "") &&
    owner.sessionId === context.sessionId
  );
}

// legacy 只与 legacy 相等，且不比较 scopeKey：旧调用方没有 browserId，强行比较会把
// 所有 legacy 请求判成跨 scope，导致旧 renderer 完全不可用。结构化上下文则必须全字段
// 相等——browserGeneration 参与比较是为了让同一 browser 的新旧代际互不可见。
// 这里不比较 requestId/turnId：它们是单请求维度，不是隔离维度。
function sameScope(left: InternalExecutionContext, right: InternalExecutionContext): boolean {
  // legacy 与 legacy 恒等，其余走 scopeKey 全串比较。不能让 legacy 与结构化上下文相等：
  // 旧调用方没有 browserId/generation，任何“宽容匹配”都会把它接进真实 scope 的 tab。
  return (left.legacy === true && right.legacy === true) || scopeKey(left) === scopeKey(right);
}

// 旧入参只有一个字符串 key，这里把它同时当作 workspaceKey 与 sessionId，再冻结成独立 legacy scope。
// requestId 每次随机是为了让重复调用的取消/去重仍能工作；
// browserGeneration=0 是哨兵：真实 browser 从 1 开始，避免与 legacy 混同。
// 不能把 legacy 上下文写进共享状态，否则会污染真实 scope 的 active/default 索引。
function normalizeLegacyContext(defaultKey: string): InternalExecutionContext {
  // 每次调用生成新的 requestId，保证两次 legacy 调用的 abort/去重互不影响。browserGeneration
  // 固定为 0 作为哨兵：真实 browser 从 1 开始，0 永远不会与结构化 scope 的 key 碰撞。
  // windowId=0 表示“不属于任何真实窗口”，因此 legacy tab 不会被窗口级清理逻辑误伤。
  return {
    requestId: `legacy:${randomUUID()}`,
    browserId: "legacy-iab",
    browserGeneration: 0,
    windowId: 0,
    workspaceKey: defaultKey,
    sessionId: defaultKey,
    clientMode: "desktop-continuous",
    legacy: true,
  };
}

// suspend ACK 用 tabId+generation 复合键：同一 tab 可能连续经历多轮 suspend/restore，
// 只按 tabId 会让上一轮的迟到 ACK 直接释放这一轮的等待者，把未真正卸载的 guest 当成
// 已挂起。generation 由 coordinator 单调递增，因此旧 ACK 永远匹配不到新 waiter。
function suspendAckKey(tabId: string, generation: number): string {
  // 复合 key 用 \u0000 分隔，否则 tabId 文本里的分隔符会让两轮 key 拼出同一串；generation 单调递增，
  // 上一轮挂起迟到的 ACK 只会命中已删除的 waiter，不会唤醒这一轮正在等待的 suspend。
  return `${tabId}\u0000${generation}`;
}

// 恢复 shell 是 renderer 重建 UI 的最小事实集，不含 guest/CDP 细节。browserId 与
// generation 取自当前 owner 而不是 record：恢复后 tab 属于这次启动的 browser 代际，
// 沿用旧代际会让后续 attach 被 generation-mismatch 拒绝。
// remoteSessionId 只有存在时才写入，避免序列化出 undefined 键污染严格校验。
// restoreUrl 允许为空：空 URL 的 shell 只用于展示“待恢复”占位，不触发自动导航。
function toRestoredShell(
  record: BrowserTabShellRecord,
  owner: InternalExecutionContext,
): BrowserViewRestoredTabShell {
  // browserId/browserGeneration 取自 owner 而不是 record：恢复出的 shell 属于本次启动的
  // browser 代际，沿用 record 里的旧代际会让紧接着的 attachGuest 被判 generation-mismatch。
  // remoteSessionId 用条件展开写入，值为空时不产生该键，避免严格校验把空串当成真实会话。
  return {
    tabId: record.tabId,
    workspaceKey: record.workspaceKey,
    ...(record.remoteSessionId ? { remoteSessionId: record.remoteSessionId } : {}),
    sessionId: record.sessionId,
    browserId: owner.browserId,
    browserGeneration: owner.browserGeneration,
    origin: record.origin,
    restoreUrl: record.restoreUrl,
    title: record.title,
    faviconUrl: record.faviconUrl,
    openedAt: record.openedAt,
    lastSelectedAt: record.lastSelectedAt,
  };
}

// sideEffect 只能靠命令名白名单推断，不能靠“backend promise 是否 reject”判断：
// 很多写操作在 CDP 层已成功但 promise 因 abort 提前 reject，必须报 uncertain。
// playwright locator 只把真正改变页面状态的操作算作副作用；evaluate 任意代码一律
// 视为有副作用。新增 BrowserCommand 方法时必须同步登记，漏登记会让取消误报 none，
// 模型据此重试会造成重复点击、重复提交等不可逆结果。
function isSideEffecting(command: BrowserCommand): boolean {
  // 判定顺序不能调换：playwright locator 的 operation 是字符串枚举，必须先从根命令里取出，
  // 否则会落到下面的 method 白名单，把 click 之外的 locator 操作全当成只读。
  if (command.method === "playwright" && command.action.name === "locator") {
    // locator 只有这七种 operation 会改变页面状态；其余（textContent/screenshot 之类）失败后
    // 重试是安全的，报 uncertain 反而会让模型放弃本可重试的读取。
    return [
      "click",
      "dblclick",
      "downloadMedia",
      "fill",
      "press",
      "selectOption",
      "setChecked",
    ].includes(command.action.operation);
  }
  // evaluate 执行任意脚本，不能静态判断是否写页面，因此一律按有副作用处理。
  if (command.method === "playwright" && command.action.name === "evaluate") return true;
  // 其余命令按 method 白名单判定：这份列表是 sideEffect 的唯一事实源，新增 BrowserCommand
  // 方法必须同步登记。漏登记会让取消结果报 sideEffect=none，模型据此重试会重复点击、
  // 重复提交；多登记只会让取消更保守，不会产生错误动作。
  return [
    "navigate",
    "back",
    "forward",
    "reload",
    "click",
    "fill",
    "type",
    "press",
    "cuaKeypress",
    "scroll",
    "cuaScroll",
    "domCuaScroll",
    "hover",
    "select",
    "check",
    "drag",
    "cuaDrag",
    "recordingStart",
    "recordingCancel",
    "handleDialog",
    "close",
    "evaluate",
    "finalize",
    "finalizeTabs",
    "claimTab",
    "activateTab",
    "markDeliverable",
    "markHandoff",
    "newTab",
  ].includes(command.method);
}

/**
 * IAB guest registry。生产路径严格按 BrowserGuestExecutionContext 隔离；string 入参只保留给
 * 旧 renderer/单测兼容，不能由新调用方使用。
 */
// guest 销毁后访问 id/zoom 等属性会抛 "Object has been destroyed"。资源管理器遍历时
// 不能因为单个 tab 已销毁就中断整个列表，所以统一在这里吞错并返回 undefined。
// 只吞同步异常：异步失败由各自 promise 的 catch 处理，不能在这里扩大范围。
// 返回值用 undefined 而不是 0，避免把“读不到”误当成合法的 webContents id。
function safeNumber(read: () => number | undefined): number | undefined {
  try {
    // read 是调用方传的取值闭包，属性访问本身会抛错，因此闭包把“读哪个字段”的决策留在调用点。
    const value = read();
    return typeof value === "number" ? value : undefined;
  } catch {
    // guest 已销毁时访问 id 会抛错；资源管理器只需跳过该 tab。
    return undefined;
  }
}

// 管理器把所有可变状态收在实例字段里，方法之间必须通过 tabId/scopeKey 关联，禁止跨实例共享 guest。
// 这样 disposeAll 能一次收口，也保证测试可并行创建多个实例。
// 类本身不做 IPC 鉴权：windowId 必须由 IPC 层从 sender 绑定后注入，不能信任 renderer
// 自报的值，否则任意窗口都能操作别的窗口的 tab。
export class BrowserGuestManager {
  // tabs 是唯一权威 registry；activeTabByScope/defaultTabByScope 只是索引，必须能由它
  // 重算。任何“只改索引不改 tabs”的路径都会在下次 reconcile 时暴露；反向则会让命令
  // 找到已删除的 tab，因此 closeTab 必须同步完成索引与 registry 两边的删除。
  private readonly tabs = new Map<string, ManagedTab>();

  /** 资源管理器：当前仍活着的浏览器 guest webContents id，用于把其 renderer 归到内置插件 browser-use */
  // 资源管理器用它把 guest renderer 归到内置 browser-use 插件配额。排除 closed tab
  // 与无 guest 的 shell：suspended tab 没有 renderer，计入会让配额虚高。
  // 必须用 safeNumber 读取：遍历期间 guest 可能被销毁，直接取 tab.guest.id 会抛错
  // 并中断统计，导致资源管理器看到不完整的列表。
  listGuestWebContentsIds(): number[] {
    const ids: number[] = [];
    for (const tab of this.tabs.values()) {
      if (tab.lifecycle === "closed" || !tab.guest) continue;
      const id = safeNumber(() => tab.guest?.id);
      if (id !== undefined) ids.push(id);
    }
    return ids;
  }
  /** close 后只保留 opaque id tombstone，拒绝迟到的 renderer attach，不保留 owner/guest。 */
  // tombstone 只存 opaque tabId，不保留 owner/guest：关闭后仍可能有迟到的 dom-ready
  // attach 到达，若没有 tombstone 就会重建一个“幽灵 tab”，用户下次启动看到已关页面。
  // 这也是 closeTab 先加 tombstone 再删 registry 的原因；条目随关闭次数增长，但每条
  // 只是一个字符串，且拒绝复活的价值高于这点内存。
  private readonly closedTabIds = new Set<string>();
  private readonly activeTabByScope = new Map<string, string>();
  private readonly defaultTabByScope = new Map<string, string>();
  // waiters 按 tabId 分组：同一 tab 可能同时有多个命令在等同一个 ready 事件（并发
  // ensureGuest），attach 成功时全部 resolve，不能只唤醒第一个。
  // 用数组而不是单 promise，是为了让 abort/timeout 能精确摘除自己而不影响其它等待者。
  private readonly waiters = new Map<string, PendingWaiter[]>();
  // dialog 是 per-tab 瞬时状态：JS dialog 会阻塞该页面渲染，必须能被 getDialog/
  // handleDialog 读取和关闭。缓存以 tabId 为键而不是 guest id，因为 guest 换代时
  // dialog 随 document 销毁，detach 必须能按 tab 清掉旧条目（否则新 guest 会读到
  // 上一个页面的 prompt 文本）。不能持久化：重启后的 dialog 已不存在。
  private readonly pendingDialogs = new Map<string, BrowserDialog>();
  private readonly runningRequests = new Map<string, RunningRequest>();
  /**
   * CDP Page.captureScreenshot 没有单请求取消 API。外层 timeout/cancel 后 promise 可能仍在
   * Chromium 内执行。请求 abort/deadline 即刻
   * settle 并释放屏障，允许同 tab 立即重试——重叠是瞬态且自排空的：下一次截图的透明
   * presentation 会恢复产帧，旧的挂起 capture 随之落定；结果按各自 promise 链归属，迟到
   * 结果不会误挂到新请求（clearTrackedScreenshot 以 entry identity 幂等）。旧的“保留屏障
   * 直到真实 settle”会把永不落定的挂起请求变成该 tab 的截图死锁（生产实测 pendingMs
   * 120s+），已被废弃。堆积风险由 abandonedScreenshotCaptures 的硬上限兜底。
   */
  private readonly inFlightScreenshots = new Map<string, InFlightScreenshot>();
  /** 见 MAX_ABANDONED_SCREENSHOT_CAPTURES；key 为 tabId。 */
  private readonly abandonedScreenshotCaptures = new Map<string, number>();
  // recordings 以 recordingId 为键，跨 tab 共享查询；tab 关闭时按 tabId 反向扫描 abort。
  // 为什么不挂在 ManagedTab 上：recordingStatus/recordingCancel 用 id 寻址，命令可能
  // 不带 tabId，挂在 tab 上会让已释放的 tab 无法查询终态结果。
  // 条目在 TTL 后删除，但 artifact 路径先写入 entry，读取方必须容忍文件已被清理。
  private readonly recordings = new Map<string, BrowserRecordingEntry>();
  // downloads 记录 will-download 产生的每个下载及其落盘状态。key 是 downloadId 而不是
  // tabId：同一 tab 可并发多个下载，Playwright 的 download.path() 按 id 精确寻址。
  // state=pending 表示文件尚未写完，此时 path 可能还是临时名，绝不能提前返回给调用方。
  // 关 tab 时按 tabId 反查删除，避免下载记录比 tab 活得更久。
  private readonly downloads = new Map<string, DownloadRecord>();
  // will-download 可能早于 waitForEvent(download) 到达（页面点击后立刻触发下载），
  // 因此先到的下载进入该队列，等待后续 waiter 取走。若只保留 waiter 列表，早到事件
  // 会被丢弃，调用方永远等不到那次下载；队列按 tabId 隔离，防止 A tab 的下载被
  // B tab 的 waitForEvent 误领。
  private readonly queuedDownloads = new Map<string, string[]>();
  // 与下载队列互补：等待者按 tabId 排队，下载事件到达时 shift 最早的一个。
  // 必须支持 abort/timeout：页面可能根本不触发下载，没有超时会让命令永久挂起。
  // 一个 tab 允许同时有多个 waiter（并发 waitForEvent），因此用数组而不是单槽。
  private readonly downloadWaiters = new Map<string, DownloadWaiter[]>();
  // session 名只用于 UI 展示与日志，不参与授权；key 用 scopeKey 而不是 sessionId，
  // 因为同一 session 在不同 browser/window 下是不同作用域，名字不能互相覆盖。
  // closeSession 时删除，避免 scopeKey 复用（同 id 新会话）读到旧名字。
  private readonly sessionNames = new Map<string, string>();
  // visibility 表示“整个 browser scope 是否在前台可见”，与 tab 级 selected 是两个维度：
  // 面板展开但未选中某 tab 时 visibility=true、selected=false。
  // attachGuest 只据此回放 visibility，不能把 inactive guest 也标成可见，否则用户切走后
  // 旧 tab 会被重新激活。closeSession 删除它，因为 scope 已结束。
  private readonly visibilityByScope = new Map<string, boolean>();
  // 记录每个窗口最近一次真实 window.innerWidth/Height。后台 pane 隐藏时 guest 读到
  // 0×0，只能复用该缓存作为 fallback。按 windowId 而不是 tab/scope：同一窗口的所有
  // 后台 tab 共享同一物理尺寸，缓存一份即可。
  // closeWindow 必须删除，否则窗口 id 被复用时新窗口会继承旧尺寸。
  private readonly naturalViewportByWindow = new Map<number, BrowserViewportSize>();
  // coordinator 是资源预算与 suspend/restore 状态机的唯一来源；管理器只负责把 tab
  // 事实同步给它（report/upsert），不能自己维护第二份 residency 状态。
  // 所有状态迁移都带 generation，管理器侧的迟到回调会被 generation 校验挡住。
  // disposeAll 必须 dispose 它，否则内部计时器会在测试结束后继续跑。
  private readonly residencyCoordinator: BrowserTabResidencyCoordinator;
  // suspend 流程是“请求 renderer 卸载 → 等 ACK → 才认为 guest 已挂起”。等待者按
  // suspendAckKey(tabId+generation) 存放；ACK 到达时只唤醒对应 generation。
  // 没有 ACK 时由 suspendAckTimeoutMs 兜底，否则挂起流程会永久占住 restore 入口。
  private readonly suspendAckWaiters = new Map<string, () => void>();
  // suspend flight 是“挂起进行中”的屏障：ensureGuest 看到它必须先等收敛，不能复用
  // 即将销毁的旧 guest。它与 restoreFlights 分离，因为挂起和恢复可能交错发生，
  // 合并成一个字段会让错误的一方清除另一方的 flight。
  private readonly suspendFlights = new Map<string, Promise<void>>();
  // 恢复 flight 由 tab 生命周期拥有，不能采用首个 caller 的 AbortSignal：首个命令取消
  // 会毒化所有并发 caller，并把 coordinator 留在 restoring。调用方各自用
  // waitForPromiseWithSignal 等待，取消只影响自己。
  // 同一 tab 只允许一个恢复，重复调用共享结果。
  private readonly restoreFlights = new Map<string, Promise<GuestWebContents | null>>();
  /** guest 被销毁后重绑时，替代 guest 必须先完成原页面恢复再接收新的 browser 命令。 */
  private readonly guestRecoveryFlights = new Map<string, Promise<GuestWebContents | null>>();
  /** 同一 tab 的 attach/rebind 只允许一个 flight，避免并发命令各自重建 webview。 */
  private readonly guestAttachFlights = new Map<string, Promise<GuestWebContents | null>>();
  // 记录恢复出的 tab 被哪个窗口认领。同一份恢复仓库可能被多个窗口同时 restoreTabs，
  // 若不加 claim，同一 tabId 会在两个窗口各建一个 shell，用户看到重复标签。
  // claim 一旦写入不随窗口关闭回滚：该 tab 的归属已确定，另一个窗口不能半路抢走。
  private readonly restoredTabClaims = new Map<string, number>();

  // 构造函数只建立 residency coordinator，不做任何 I/O 或 Electron 调用：测试可在无窗口环境实例化；所有回调都必须以可选参数注入，缺失时退化为无通知（状态机仍运行）。
  // 参数位置有历史包袱（第七位被截图归一化占用），新能力只能追加，不能插入中间，
  // 否则所有既有 main/test 调用点会静默错位。
  constructor(
    // log 可选：缺省时告警静默，但状态机仍走相同分支，不会因为没日志而跳过收口。
    private readonly log?: (msg: string) => void,
    // attachTimeoutMs 只约束等待时长，不参与代际校验；测试注入更短值可以加快失败路径。
    private readonly attachTimeoutMs: number = DEFAULT_ATTACH_TIMEOUT_MS,
    // onCloseTabRequested 只通知 renderer，manager 不替它决定 UI 去留，真正的关闭由上层发起。
    private readonly onCloseTabRequested?: (
      // tabId 由 renderer 自报，回调里不能据此删 registry，否则伪造 id 就能关别人的标签。
      tabId: string,
      // owner 可缺省：未 claim 的 tab 关闭时没有完整上下文，按 legacy 处理。
      owner?: BrowserGuestExecutionContext,
    ) => void,
    // onOpenTabRequested 在 attach 失败或需要重绑时触发，返回 void，renderer 不响应只能等超时。
    private readonly onOpenTabRequested?: (
      // 同一 tabId 可能被多次请求：renderer 必须幂等，重复建 webview 会让两个 guest 抢同一 tab。
      tabId: string,
      // owner 必填：新建 tab 必须有归属，缺失会被当成 legacy 并被 scope 校验拒绝。
      owner: BrowserGuestExecutionContext,
    ) => void,
    // onVisibilityChanged 的 visible 是 scope 级信号，不是单个 tab 的显示状态。
    private readonly onVisibilityChanged?: (
      // false 表示整组页面失焦，manager 据此更新 visibilityByScope 并触发挂起判定。
      visible: boolean,
      // owner 用来定位 scope，缺 tabId 时不做单 tab 精确更新。
      owner: BrowserGuestExecutionContext,
      // tabId 可选：只有渲染层明确知道是哪一页时才传，否则按 scope 整体处理。
      tabId?: string,
    ) => void,
    // onViewportChanged 的 null 是「清除 override」哨兵，与 0×0 尺寸含义不同。
    private readonly onViewportChanged?: (
      // 尺寸变化只对 owner 对应的 pane 生效，跨窗口的调用应被忽略。
      viewport: BrowserViewportSize | null,
      // owner 决定写入哪个 tab 的缓存，混用会让 A 窗口的尺寸写到 B 窗口。
      owner: BrowserGuestExecutionContext,
      // tabId 必填：viewport 缓存按 tab 存储，缺省会写到错误的条目。
      tabId: string,
    ) => void,
    // 第七位已被 screenshot CSS 像素归一化使用；新门禁依赖只能追加，避免打破已有 main/test 调用。
    private readonly resizeScreenshotToCssPixels?: ControlledView["resizeScreenshotToCssPixels"],
    // coordinator 缺失时截图直接失败，不能回退 guest.capturePage，否则两套 surface 语义混用。
    private readonly screenshotSurfaceCoordinator?: BrowserScreenshotSurfaceCoordinator,
    // residencyOptions 只透传 tabLimit/now/onEvict，其余字段由 coordinator 自己兜底。
    private readonly residencyOptions: BrowserGuestManagerResidencyOptions = {},
    // 隐藏窗口截图的透明 presentation 依赖 owner BrowserWindow；测试注入替身，生产由
    // index.ts 接 BrowserWindow.fromId。不注入时该能力整体禁用，行为与旧版一致。
    private readonly resolveOwnerWindow?: (
      // windowId 只用于按窗口找 owner BrowserWindow，不参与 scope 判定。
      windowId: number,
    ) => BrowserWindowForTransparentBootstrap | null,
    // CDP 命令流空闲多久后主动释放（detach）。guest renderer 被
    // Chromium 杀且 render-process-gone 未送达 main 时，destroyed 直达 + CDP attached 即
    // 主进程 UAF；turn 内命令间隙（0.4~9s）是实测崩溃窗口，命令级 idle 释放将其收窄。
    private readonly cdpIdleReleaseMs: number = DEFAULT_GUEST_CDP_IDLE_RELEASE_MS,
  ) {
    // onEvict 直接绑 closeTabForLimit：换成匿名包装会让淘汰绕过 durable 关闭，留下可恢复的 shell。
    this.residencyCoordinator = new BrowserTabResidencyCoordinator({
      tabLimit: residencyOptions.tabLimit,
      now: residencyOptions.now,
      onEvict: (record) => this.closeTabForLimit(record),
    });
  }

  // attachGuest 是 renderer 的“webview 已就绪”上报入口，也是本文件最宽的跨 scope
  // 攻击面：webContentsId 由 renderer 自报，必须依次校验存在性、webview 类型、
  // tombstone、window/workspace/session/remoteSession。任一项缺失都可能让别的对话的
  // guest 替换当前 tab，或让 main 窗口 id 被当成 guest 操作。
  // 校验顺序有意从便宜到昂贵：先排除已销毁/非 webview，再查 scope，最后才动 residency。
  attachGuest(
    // tabId 是 tabs 与 closedTabIds 共用的主键，必须原样透传，不能按 webContentsId 反查。
    tabId: string,
    // webContentsId 由 renderer 自报，从这里起每个字段都按不可信处理。
    webContentsId: number,
    // options 全部可选：旧 renderer 只传两参，缺省必须落到 legacy/哨兵分支而不是默认放行。
    options?: {
      active?: boolean;
      windowId?: number;
      workspaceKey?: string;
      remoteSessionId?: string;
      sessionId?: string;
      residencyGeneration?: number;
    },
  ): BrowserGuestAttachResult {
    // 这里用 let 而不是 const：未登记的 tabId 会在下面按 options 现场创建 shell。
    // 但“创建”不是无条件信任：只有带 workspaceKey 的调用才产生 user tab，否则落入
    // legacy/unclaimed 哨兵，避免一个随机 tabId 被当成受控 tab 获得默认 viewport。
    // 注意 tab 变量后续全程持有同一对象，不能在中途重新 get，否则并发 attach 会分叉。
    let tab = this.tabs.get(tabId);
    // fromId 只按进程内 id 取对象、不校验归属，所以传入别的窗口句柄也能共享 CDP（D-16-1）。
    const guest = webContents.fromId(webContentsId) as GuestWebContents | undefined;
    // fromId 返回 undefined 或已销毁对象都走同一 fail-closed 分支。此时若 tab 仍活着，
    // 主动 requestGuestRebind 让 renderer 重建 webview；不重绑的话 waitForGuest 只能
    // 等满 10s 超时。这里不能先 closeTab：tab 的 logical 事实（URL/历史）还要用于恢复。
    if (!guest || guest.isDestroyed()) {
      // 只有 tab 未关闭才请求重绑：对 closed tab 重绑会让 renderer 重建一个已删除的页面。
      const recoveryRequested =
        tab && tab.lifecycle !== "closed"
          // requestGuestRebind 会先写 tab.attachFailure，下一次 attach 的 rebindReason 靠它选恢复策略。
          ? this.requestGuestRebind(tab, guest ? "destroyed" : "not-found")
          : false;
      // 日志带被跳过的 id 与 reason，并发 attach 时才能定位是哪个句柄被拒。
      this.log?.(
        `[browser-use] attachGuest skip tabId=${tabId} id=${webContentsId} reason=${guest ? "destroyed" : "not-found"}`,
      );
      // 失败信封不回传 owner/tabId：回传会让调用方误以为已获得该 tab 的授权。
      return {
        ok: false,
        reason: guest ? "destroyed" : "not-found",
        recoveryRequested,
      };
    }
    // fromId 接受进程内任意 WebContents id；若 renderer 误传主窗口 id，后续 CDP/Runtime
    // 输入会直接操作 ZCode composer，等价于把用户主界面交给页面脚本。IAB 只允许真实
    // webview guest，类型不符必须 fail closed，且不能触发重绑（重绑只会得到同一错误）。
    if (guest.getType() !== "webview") {
      // fromId 接受进程内任意 WebContents id；若 renderer 误传主窗口 id，后续
      // CDP/Runtime 输入会直接操作 ZCode composer。IAB 只允许真实 <webview> guest fail closed。
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} id=${webContentsId} reason=not-webview type=${guest.getType()}`,
      );
      // not-webview 不请求重绑：换一个 webview 还是同一类型错误，重绑只会空转。
      return { ok: false, reason: "not-webview", recoveryRequested: false };
    }

    // closed 检查必须早于“未登记则创建”：已关闭 tab 的迟到 dom-ready 会带同一个 tabId
    // 回来，若允许重建，用户点 × 后页面会自己复活。tombstone 是唯一能区分“新建”与
    // “迟到”的信息，因此这里只拒绝、不清理。
    if (this.closedTabIds.has(tabId)) {
      // closed 只打日志、不动 registry：tombstone 本身就是要留到来路可查（INV-15）。
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=closed`);
      return { ok: false, reason: "closed", recoveryRequested: false };
    }
    // 兼容旧 renderer：未经历 create request 的 key 只进入 legacy scope。
    if (!tab) {
      // 未登记 tab 没有 create request，只能从 attach 参数重建 owner。带 workspaceKey
      // 视为 user tab：sessionId 缺失时用 unscoped 哨兵，宁可让该 tab 不可认领，也不能
      // 让它被任意新对话通过 openTabs() 看到。origin 与 userOwner 必须同时设置，
      // 否则 releaseToUser 会把它当成 agent tab 直接关闭。
      const owner = options?.workspaceKey
        ? {
            requestId: `unclaimed:${randomUUID()}`,
            browserId: "unclaimed-iab",
            browserGeneration: 0,
            windowId: options.windowId ?? 0,
            workspaceKey: options.workspaceKey,
            // human tab 原来只按 workspace 登记为全局 unclaimed，任意新对话都能
            // 从 user.openTabs() 枚举并接管。ownerTaskId 现在随 attach 冻结；旧 renderer
            // 未传 sessionId 时保留不可认领哨兵，宁可隐藏也不能跨对话泄漏。
            sessionId: options.sessionId?.trim() || "unscoped",
            ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
            clientMode: "desktop-continuous" as const,
          }
        // 无 workspaceKey 的调用一律进 legacy scope，兼容路径不能得到 user tab 的可见性。
        : normalizeLegacyContext(tabId);
      // 允许 attach 参数覆盖默认 windowId，是为了兼容“renderer 在 shell 创建前就上报”
      // 的时序；但只允许在 owner 刚创建时覆盖，已有 tab 的 windowId 变更必须走下面的
      // window-mismatch 拒绝，否则 tab 会在窗口之间漂移。
      if (options?.windowId !== undefined) owner.windowId = options.windowId;
      // 新建的 tab 按「尚未挂载」初始化：cdpAttached=true 会让 teardown 对不存在的 guest 发 detach。
      tab = {
        // tabId 与 owner 必须同一段写入：分开写会让 registry 短暂指向没有 owner 的 tab。
        tabId,
        owner,
        cdpAttached: false,
        guestLifecycle: "detached",
        pendingCdpCommands: 0,
        guestGeneration: 0,
        hasAttachedGuest: false,
        rebindRequested: false,
        lifecycle: "active",
        origin: options?.workspaceKey ? "user" : "agent",
        claimable: Boolean(options?.workspaceKey && options.sessionId?.trim()),
        ...(options?.workspaceKey ? { userOwner: { ...owner } } : {}),
        active: false,
        loading: false,
        mediaActive: false,
        cachedUrl: "",
        cachedTitle: "",
        cachedFaviconUrl: null,
        openedAt: this.now(),
      };
      // attach 时创建 tab 必须先写 registry 再继续后续逻辑：后续任何 await 都可能让
      // 并发命令按 tabId 查表，未写入会得到 unknown tab。
      // 写入的是同一个 tab 对象，后续修改字段无需再次 set。
      // 这里不报告 residency：新 tab 尚未有 guest，报告 active 会让预算误判。
      // 若后续校验失败（如 closed tombstone），必须把刚插入的 tab 回滚删除。
      // 该路径只用于“renderer 先于 create 上报”的兼容场景，正常创建走 createTab。
      this.tabs.set(tabId, tab);
      // 入表后立即登记 residency：中间让出会让预算看到这个 tab 却算不出它的可见性。
      this.registerTabResidency(tab, options?.active === true);
    }
    // 二次检查 closed：上面的创建分支可能刚插入一个新 tab，而同一时刻另一条 close
    // 请求可能已把它标记为关闭（JS 单线程下只可能发生在 await 之前，仍保留防御）。
    // 关闭是终态，任何 attach 都不能把它改回 active。
    if (tab.lifecycle === "closed") {
      // 二次 closed 检查覆盖「刚插入、close 同时在途」：终态不能被 attach 改回 active（INV-15）。
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=closed`);
      return { ok: false, reason: "closed", recoveryRequested: false };
    }
    // windowId 是 IPC 授权的一部分：renderer 只能操作自己窗口的 tab。这里拒绝而不重绑，
    // 因为重绑会请求错误的窗口再开一个 webview，等于把越权请求变成资源消耗。
    if (options?.windowId !== undefined && tab.owner.windowId !== options.windowId) {
      // windowId 不一致直接拒绝且不重绑：重绑会请求错误窗口再开一个 webview，放大越权消耗。
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=window-mismatch expected=${tab.owner.windowId} actual=${options.windowId}`,
      );
      return { ok: false, reason: "window-mismatch", recoveryRequested: false };
    }
    // workspace 不同意味着属于另一个项目/对话。拒绝的同时必须清理 incoming guest
    // （rejectGuestAttach 负责），否则这个 WebContents 没有任何 owner，会永久泄漏。
    if (options?.workspaceKey && tab.owner.workspaceKey !== options.workspaceKey) {
      // workspace 不一致走 rejectGuestAttach：它统一重绑并清理未被收养的 incoming guest。
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=workspace-mismatch`);
      // 返回信封的 recoveryRequested 来自 rejectGuestAttach，调用方据此决定等回调还是重试。
      return this.rejectGuestAttach(tab, guest, "workspace-mismatch");
    }
    // renderer 的迟到 dom-ready 不能用另一个对话的 ownership 复用既有 tabId。
    // window/workspace 相同也必须拒绝，避免 guest 被跨对话替换后绕过 openTabs 隔离。
    if (options?.sessionId && tab.owner.sessionId !== options.sessionId) {
      // renderer 的迟到 dom-ready 不能用另一个对话的 ownership 复用既有 tabId。
      // window/workspace 相同也必须拒绝，避免 guest 被跨对话替换后绕过 openTabs 隔离。
      this.log?.(`[browser-use] attachGuest rejected tabId=${tabId} reason=session-mismatch`);
      // session 不一致即使窗口相同也要拒绝：迟到 dom-ready 不能复用别人 tabId 的迁移。
      return this.rejectGuestAttach(tab, guest, "session-mismatch");
    }
    // remote owner 过去只在 renderer 提供 remoteSessionId 时校验，缺失值会 fail-open；
    // 远程重连后的旧 tab 因而可能被新 runtime attach。这里对空串也严格比对：
    // local 与 remote 的缺省值必须视为不同来源。
    if ((tab.owner.remoteSessionId ?? "") !== (options?.remoteSessionId ?? "")) {
      // remote owner 过去只在 renderer 主动提供 remoteSessionId 时校验，缺失值会
      // fail-open；远程重连后的旧 tab 因而可能被新 runtime attach。
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=remote-session-mismatch`,
      );
      // remoteSessionId 空串也参与比对：local 与 remote 的缺省值必须视为不同来源，否则 fail-open。
      return this.rejectGuestAttach(tab, guest, "remote-session-mismatch");
    }

    // 后面的判断需要知道 tab 当前是否 suspended/restoring。先取一次快照而不是多次
    // get，是为了让本轮所有判断基于同一 generation，避免中途状态迁移导致前后矛盾。
    const residency = this.residencyCoordinator.get(tabId);
    // 恢复 timeout 已回滚后，旧 generation 的迟到 guest 仍会尝试占用 tab。
    // suspended/suspend-pending 只允许当前旧 guest 重复上报，不接受新 attach；
    // 否则“已挂起”的 tab 会被迟到 renderer 重新挂上，资源预算随之失真。
    const rejectsNewGuest =
      tab.guest !== guest &&
      (residency?.residency === "suspended" || residency?.residency === "suspend-pending");
    // 区分“同一个 guest 重复上报”与“新 guest 抢占”：同一个 guest 的 dom-ready 允许
    // 重复，因为 renderer 可能多次上报同一句柄；新 guest 在 suspended 状态下必须被
    // 拒绝并关闭，否则刚释放的 renderer 会被另一个（可能是上一轮迟到的）webview 顶替。
    // 这里直接 closeGuestWebContents 而不是只 return，避免 incoming WebContents 无主泄漏。
    if (rejectsNewGuest) {
      // 恢复 timeout 已回滚后，旧 generation 的迟到 guest 原来仍会绕过 restoring
      // 校验并重新占用 tab。suspended/pending 只允许当前旧 guest 重复上报，不接受新 attach。
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=residency-${residency.residency}`,
      );
      // 拒绝挂起中的新 guest 必须销毁 incoming：只 return 会让这个 WebContents 无主驻留。
      this.closeGuestWebContents(tab, guest);
      // reason 统一归为 residency-suspended：细分 suspended/suspend-pending 会诱使 renderer 重试。
      return {
        ok: false,
        reason: "residency-suspended",
        recoveryRequested: false,
      };
    }
    // restoring 是唯一带代际校验的入口：markAttached 返回 false 说明上报的是恢复超时回滚前
    // 的旧代 guest，必须连 incoming guest 一起关闭；只 return 会让它继续占住 tab，新一轮
    // 恢复永远 attach 不上，预算则以为这个 tab 仍有一个活 guest。
    if (
      residency?.residency === "restoring" &&
      !this.residencyCoordinator.markAttached(
        tabId,
        options?.active === true,
        options?.residencyGeneration,
      )
    ) {
      // 日志同时打印 expected 与 actual generation，代际冲突只能靠这两个数定位。
      this.log?.(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=residency-generation-mismatch expected=${residency.generation} actual=${options?.residencyGeneration ?? "missing"}`,
      );
      // 代际不符同样销毁 incoming：它属于上一轮恢复，留着会继续占住 tab。
      this.closeGuestWebContents(tab, guest);
      // generation-mismatch 与 suspended 分开：前者说明新一轮在推进，renderer 不该重试旧句柄（INV-20）。
      return {
        ok: false,
        reason: "residency-generation-mismatch",
        recoveryRequested: false,
      };
    }
    // isSameGuest 决定后续走“幂等重放”还是“换代迁移”。同一个 guest 时不能 +1
    // generation，否则正在执行的命令会被自己的 dom-ready 判成 stale；不同 guest 时
    // 必须 +1，让旧命令的 assertCurrentGuest 立即失败而不是落到新页面。
    const isSameGuest = tab.guest === guest;
    // restoring 期间 guest 的初始 src 是延迟 protocol，会先发起一个 provisional 导航；
    // 这里先 stop 掉，再由 restoreGuestState 创建唯一的首次有效导航。漏掉 stop 会让
    // pageState.restore 与初始导航竞争，最终 URL 取决于时序，用户会看到随机页面。
    if (residency?.residency === "restoring") {
      // 恢复态 src 使用不会提交 document 的延迟 protocol；scope/generation 校验通过后
      // 终止 provisional request，确保 restoreGuestState 创建唯一首次有效导航。
      try {
        // stop 只终止 provisional 导航，不触发 did-stop-loading，恢复前的 logical cache 因此不被回写。
        guest.stop();
      } catch (error) {
        // stop 失败只告警：tab 已进 restoring，摧毁 guest 会丢掉本轮唯一的恢复机会。
        this.warn(`browser tab provisional navigation stop failed tabId=${tabId}`, error);
      }
    }
    // 换代前必须先 detach 旧 guest：否则旧 guest 的 CDP message 监听仍挂着，且 native
    // session 会在旧 WebContents 销毁时走隐式析构，留下 UAF 窗口。
    // 先 detach 再建新 flight：避免旧 guest 的 message 事件被新 flight 的监听误收。
    if (tab.guest && !isSameGuest) this.detachGuest(tab);
    // 换代时旧 guest 关联的恢复 flight 已失去意义：它恢复的是即将销毁的 WebContents。
    // 必须同步清除，否则后续 summary 会一直忽略新 guest 的 URL/title（误以为仍在恢复）。
    // 这里不需要 await flight 结算：flight 自身持有旧 guest 引用，settle 后会自然释放。
    // 也不在这里 abort：恢复流程没有独立 controller，取消由 detach/teardown 路径负责。
    // 新 guest 若需要恢复状态，会在下方 shouldRestoreAfterRebind 分支重新建 flight。
    // 清 map 是同步的，保证后续命令看到的“无在途恢复”状态一致。
    if (!isSameGuest) this.guestRecoveryFlights.delete(tab.tabId);

    // detachGuest 会从仍存活的旧 guest 读取最后 URL；恢复判定必须放在它之后，避免 renderer
    // 尚未来得及上报 residency 时，把刚刚发生过的导航误判成没有可恢复事实。
    // 捕获 rebindReason 是为了在重置 attachFailure 之前保留“上一次为什么失败”，
    // 它决定重绑是否需要恢复页面（guest-destroyed 与 attach-timeout 的策略不同）。
    // 若在重置之后再读，重绑会被当成首次 attach，丢失 pageState 恢复，页面停在空白。
    // 该值只在本次 attach 内使用，不写入持久化，避免旧失败原因影响下次启动。
    // 与 cachedUrl 不同，它描述的是“故障类型”而不是“页面事实”。
    const rebindReason = tab.attachFailure;
    // shouldRestoreAfterRebind 只对「曾挂载 + 非挂起拒绝 + 有可恢复 URL」成立，首次 attach 重放会闪一次 about:blank。
    const shouldRestoreAfterRebind =
      tab.hasAttachedGuest &&
      !isSameGuest &&
      rebindReason !== undefined &&
      rebindReason !== "residency-suspended" &&
      rebindReason !== "residency-generation-mismatch" &&
      tab.cachedUrl.trim() !== "" &&
      tab.cachedUrl !== "about:blank";

    // attach 失败不能抛出：CDP 不可用只意味着后续命令会走 ensureGuestCdpAttached
    // 重试，logical tab 仍应成功挂载（否则 renderer 会不断重试 attach，形成死循环）。
    // 用 safeBool 读取是为了让“attach 后立即崩溃”的极端时序不把异常抛给 IPC 调用方。
    let cdpAttached = false;
    try {
      // debugger.attach 可能被别的 session 占用而抛错，因此整段包 try；失败仍继续，后续命令会按需重试。
      if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
      // 以 isAttached 回读结果而不是假定成功：native 可能在 attach 后立即 detach。
      cdpAttached = guest.debugger.isAttached();
    } catch {
      // 异常路径用 safeBool 再读一次：attach 抛错时 guest 可能正好被销毁，直接读会二次抛出。
      cdpAttached = safeBool(() => guest.debugger.isAttached(), false);
    }
    // 从这里开始 tab 指向新 guest，必须同步重置所有与 guest 绑定的字段：teardown
    // flight 清空（旧 flight 属于旧 guest）、hasAttachedGuest 置真、attachFailure 与 rebindRequested 复位。漏掉任一字段会让下一轮命令误以为仍处于崩溃恢复中。
    tab.guest = guest;
    // cdpAttached 是 native 状态镜像，残留 true 会让 teardown 向不存在的 session 发 detach。
    tab.cdpAttached = cdpAttached;
    // guestLifecycle 只能从 detached 前进到 attached，倒退会破坏 INV-03 的单向退行。
    tab.guestLifecycle = "attached";
    // 旧 teardownFlight 属于旧 guest，必须清空；留着会让新 guest 复用一个已结算的 promise。
    tab.guestTeardownFlight = undefined;
    // 只有换代才 +1：同一 guest 重复 dom-ready 也 +1 会把在途命令全判成 stale（INV-02）。
    if (!isSameGuest) tab.guestGeneration += 1;
    // hasAttachedGuest 是「曾经成功挂载过」的唯一证据，删除它会让重绑恢复永不触发。
    tab.hasAttachedGuest = true;
    // attachFailure 复位必须晚于 rebindReason 取值，提前清会让重绑丢失故障类型。
    tab.attachFailure = undefined;
    // rebindRequested 复位：残留 true 会让 runGuestAttachFlight 跳过开窗请求，新 guest 永远等不到。
    tab.rebindRequested = false;
    // 每次成功 attach 后启动空闲释放计时：即使 turn 还没结束，只要命令流停了，CDP
    // 也会在 cdpIdleReleaseMs 后主动 detach，把 guest 崩溃时的 UAF 窗口从整个 tab
    // 生命周期收窄到命令在途。密集命令会不断重置计时，不会误断。
    if (cdpAttached) this.scheduleGuestCdpIdleRelease(tab);
    // 恢复期新 guest 的初始 URL 是 about:blank。若在 pageState/restoreUrl 消费前
    // 覆盖 logical cache，损坏快照会错误降级到空白页，三类事实全缺失的 orphan 也无法识别。
    if (residency?.residency !== "restoring" && !shouldRestoreAfterRebind) {
      // restoring 或待重放时都不回写 cachedUrl：此刻 URL 还是 about:blank，写进去会顶掉真实地址（INV-18）。
      tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
      // title 同理，恢复期回写会把快照标题换成空白页标题。
      tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
    }
    // active=true 表示 renderer 已把这个 tab 呈现在前台。此时必须清掉后台 fallback
    // viewport，否则页面会保持隐藏 pane 的尺寸。claimable 的 human tab 不调用
    // selectTab：它还没被认领，不能因为“恰好可见”就写进 agent 的 activeTabByScope。
    if (options?.active === true) {
      // claimable 的 tab 不经过 selectTab，active 必须在这里显式置真，否则列表里没有任何 active 项。
      tab.active = true;
      // claimable 的 user tab 不进 activeTabByScope：未认领的页面不能成为 agent 命令的默认落点。
      if (!tab.claimable) this.selectTab(tab, false);
      // selectTab(tab,false) 跳过 maybeRestoreBackgroundViewport，自然尺寸只能由这行补回（INV-22）。
      this.restoreNaturalViewportAfterBackground(tab);
    } else if (options?.active === false) {
      // active=false 是显式失焦，与「未提供」不同，必须把 active 置回让 list 投影立即一致。
      tab.active = false;
      // 显式失焦要同步给 coordinator：只改 tab.active 会让预算仍按可见计，该 tab 永远不被挂起。
      this.residencyCoordinator.report(tab.tabId, {
        selected: false,
        visible: false,
      });
      // 只删指向自己的条目：并行 attach 可能已把该 scope 切到别的 tab，盲删会让新的
      // active 丢失，effectiveActiveTabId 会退回空值，截图 prepare 找不到可产帧的 tab。
      if (this.activeTabByScope.get(scopeKey(tab.owner)) === tabId) {
        // 删除用现算的 scopeKey(tab.owner)：claim 会整体换 owner，缓存旧 key 会删错 scope 的索引。
        this.activeTabByScope.delete(scopeKey(tab.owner));
      }
    }
    // 成功日志带 cdp 状态：attach 成功但未连上 CDP 时，后续命令会走 ensureGuestCdpAttached 重试。
    this.log?.(
      `[browser-use] attachGuest tabId=${tabId} windowId=${tab.owner.windowId} cdp=${cdpAttached}`,
    );

    // destroyed 是所有回收路径的最后兜底：guest 可能先于 detach 被 Chromium 销毁，
    // 此时必须先做 JS 层收口，再请求重绑。比较 current.guest === guest 是为了避免
    // 旧 guest 的 destroyed 事件把已换代的新 guest 误 detach。
    guest.once("destroyed", () => {
      // destroyed 回调重新查表而不是闭包捕获 tab：换代后 registry 里已是另一个对象。
      const current = this.tabs.get(tabId);
      // 取到 current 后还要再判 guest 身份，tabId 相同不代表是同一个 WebContents（INV-02）。
      if (current?.guest === guest) {
        // detachGuest 负责摘监听与清 CDP 镜像，漏掉它后续命令会打到已销毁对象（INV-04）。
        this.detachGuest(current);
        // 重绑原因固定 guest-destroyed，restoreReboundGuest 据此与 attach-timeout 走不同恢复策略。
        this.requestGuestRebind(current, "guest-destroyed");
      }
    });
    // 放在其余接线之前：后面几个 setup 在 guest 已销毁时可能同步抛错并跳过剩余接线，
    // 而这是唯一能关闭 UAF 窗口的监听，不该被别的接线牵连。
    // 这几个 setup 只在换代时执行：重复注册会让同一个 guest 挂多份监听，事件触发时
    // 重复 abort/重复刷新 residency。顺序上 crash guard 最先，因为它是唯一能关闭
    // UAF 窗口的监听；其余接线失败也不能让它被跳过。
    if (!isSameGuest) this.setupCdpCrashGuard(tab, guest);
    // dialog 监听只随换代注册：同一 guest 重复注册会让一个 dialog 触发多次 abort。
    if (!isSameGuest) this.setupDialogTracking(tab, guest);
    // download 监听同理，重复注册会让同一 will-download 建出两条 waiter。
    if (!isSameGuest) this.setupDownloadTracking(tab, guest);
    // activity 的注册本身幂等（先 cleanup 再挂），但仍只在换代时走，避免无谓解绑重绑。
    if (!isSameGuest) this.setupActivityTracking(tab, guest);
    // applyViewportOverride 只在换代时跑：同一 guest 重复 attach 会重发一次 CDP override。
    if (!isSameGuest) this.applyViewportOverride(tab);
    // 判断放在 applyViewportOverride 之后：刚写入的 override 必须能被这里看到并重放。
    if (tab.viewportOverride) {
      // Agent 可能在 renderer 完成自动打开前就发出 viewport 事件；guest attach 后重放一次，
      // 保证刚挂载的自由尺寸 UI 不会漏掉 main → renderer 的一次性同步。
      this.onViewportChanged?.({ ...tab.viewportOverride }, tab.owner, tab.tabId);
    }
    // visibilityByScope 首次 attach 时可能尚未写入，为 false 时直接跳过回放。
    if (options?.active !== false && this.visibilityByScope.get(scopeKey(tab.owner)) === true) {
      // visibilityByScope 表示整个 browser scope 可见，不表示本次 attach 的 tab
      // 被选中。把 inactive guest 也回放为 visible=true 会让 renderer 在用户切换后
      // 又激活旧 tab；关闭后迟到的同类事件还会复活 tab shell。只有非 inactive attach 才能
      // 沿用 scope 可见性，显式选中仍由 selectTab/browserVisibilitySet 通知。
      this.onVisibilityChanged?.(true, tab.owner, tab.tabId);
    }
    // 只有“曾经成功 attach 过 + 不是被挂起/代际拒绝 + 有可恢复 URL”才重放页面。
    // 首次 attach 时 cachedUrl 还是空，重放会多一次 about:blank→URL 的闪烁；
    // 被挂起拒绝的 guest 若也重放，会把刚释放的页面重新拉起来，破坏资源预算。
    if (shouldRestoreAfterRebind) {
      // guest-destroyed 只重放 Ready 时，新 guest 的初始 URL 是 about:blank；若直接
      // 将它标记为可用，renderer 又不会重新消费已应用过的 initialUrl，右侧面板就永久停在空白页。
      // 这里沿用已有 pageState → restoreUrl 恢复逻辑，并以 tab 级 flight 串住后续命令。
      const recoveryFlight = this.restoreReboundGuest(tab, guest);
      // 登记恢复 flight 后，summary/userTabInfo 会暂时忽略临时 guest 的 URL/title，
      // 避免把 about:blank 写进 logical cache。flight 结束必须按 identity 清除。
      this.guestRecoveryFlights.set(tab.tabId, recoveryFlight);
      // clearRecoveryFlight 按 flight identity 删除：迟到的旧 flight 不能清掉新一轮登记的条目。
      const clearRecoveryFlight = () => {
        // 比较对象是 promise 本身：tabId 相同但 flight 已换代时必须保留新的那条。
        if (this.guestRecoveryFlights.get(tab.tabId) === recoveryFlight) {
          // 删除后 summary/userTabInfo 恢复读取 guest 的 URL/title（INV-18 解除）。
          this.guestRecoveryFlights.delete(tab.tabId);
        }
      };
      // 成功与失败都要摘除：失败同样意味着 flight 已结算，留着会让 summary/userTabInfo
      // 永远忽略该 tab 的 URL/title（INV-18），表现为标签标题一直停在重置前的旧值。
      void recoveryFlight.then(clearRecoveryFlight, clearRecoveryFlight);
    }
    // attach 成功要把所有等这个 tabId 的 waiter 一起唤醒。必须传 guest 而不是 null：
    // null 表示“等不到”，调用方会走失败分支并 closeTab；这里已经成功，误传 null
    // 会让并发命令把刚挂好的 tab 关掉。
    this.resolveWaiters(tabId, guest);
    // restoring 分支已在 markAttached 里登记过，这里再调用会二次推进 generation，让本轮 attach 判 stale。
    if (residency?.residency !== "restoring") {
      // visible 取 active===true，缺省 undefined 视为后台，不能当成选中。
      this.residencyCoordinator.markAttached(tabId, options?.active === true);
    }
    // 每次 attach 都落盘 shell：旧 guest 可能已经导航过，持久化里的地址未必等于当前
    // cachedUrl；少这一写，重启恢复会回到上一次 attach 之前的页面。
    void this.persistShell(tab);
    // 返回 guestGeneration 让 renderer 能把它带回后续命令；不带 generation 的旧
    // renderer 仍可用，但会失去 stale 拒绝能力。成功路径不返回 owner/tabId，避免
    // 调用方误把“attach 成功”当成获得了该 tab 的授权。
    return { ok: true, guestGeneration: tab.guestGeneration };
  }

  /** Renderer 自由尺寸交互回写；发送方窗口由 IPC 层绑定，不能跨窗口修改其它 tab。 */
  // renderer 只在用户拖拽分隔条/窗口 resize 时上报自然尺寸，写入必须走 enqueue 串行化：
  // 它与 setTabViewport(Agent) 竞争，直接赋值会让 Agent 的显式 viewport 被一次 resize
  // 覆盖。renderer 上来的 pane 尺寸在这里按显式 override 处理，同样要过 assertViewportOverride：
  // 0 宽或越界会让页面按无效尺寸布局；只有 readTabViewport 读 guest 实际尺寸时才不做钳制。
  // [并发] 队列保证“最后一次设置胜出”，且 CDP 重连期间不会丢写。
  // [失败路径] guest 已销毁时仅更新缓存，不触发 apply，避免向死对象发 CDP。
  async updateViewportFromRenderer(
    tabId: string,
    viewport: BrowserViewportSize | null,
    windowId: number,
  ): Promise<void> {
    // 只按 tabs.get + windowId 比对、不走 requireRendererOwnedTab：跨 workspace/session 不会越权，
    // 因为 viewport 只是窗口内的布局事实；但已关闭 tab 必须拒绝，否则 override 会写到正在析构的 guest 上。
    // [失败路径] 这里抛错而不是静默返回：pane 与 guest 尺寸不一致时页面点击坐标整体偏移，
    // 静默会让 renderer 以为同步成功、不再重试。
    const tab = this.tabs.get(tabId);
    if (!tab || tab.lifecycle === "closed" || tab.owner.windowId !== windowId) {
      throw new Error(`browser tab '${tabId}' is unavailable for viewport update`);
    }
    // null 与对象是两个动作：对象写入显式 override，null 清除 override 回落到 guest 自然尺寸；
    // 把 null 当成 0×0 下发会让页面钉死在零尺寸。
    if (viewport) {
      assertViewportOverride(viewport);
      await this.setTabViewport(tab, viewport);
      return;
    }
    await this.resetTabViewport(tab);
  }

  // 返回副本而不是内部 owner 引用：调用方可能把它缓存到异步回调里，直接暴露会在
  // releaseToUser/claimTab 改写 owner 后读到半新半旧的字段。
  // 不查 scope：这是“按 id 取事实”的 API，鉴权由 requireRendererOwnedTab 负责。
  // [权衡] 返回 null 而不是抛错，便于 UI 在 tab 刚关闭时静默降级。
  getTabOwner(tabId: string): BrowserGuestExecutionContext | null {
    const owner = this.tabs.get(tabId)?.owner;
    return owner ? { ...owner } : null;
  }

  /** 根据 guest WebContents 反查受控 tab，供 webview popup 事件保留原始 session scope。 */
  // renderer 可能只知道 webContentsId（webview 的 dom-ready 事件），这里反查 logical
  // tab 的 owner。取第一个匹配即可：同一 WebContents 不可能属于两个 tab，出现多匹配
  // 说明 attach 状态已损坏，返回 null 让调用方 fail closed 而不是随机选一个。
  // [资源] 用 safeNumber 读取 id，避免遍历中某个 guest 被销毁导致整个查询抛错。
  getTabOwnerByWebContentsId(
    webContentsId: number,
  ): (BrowserGuestExecutionContext & { tabId: string }) | null {
    for (const tab of this.tabs.values()) {
      if (tab.guest?.id === webContentsId && tab.lifecycle !== "closed") {
        return { ...tab.owner, tabId: tab.tabId };
      }
    }
    return null;
  }

  // renderer 上报的是“这个 webview 当前的驻留态”，不是命令，所以不进入 runningRequests。
  // 必须校验 tab 存在且 webContentsId 匹配当前 guest：否则页面脚本可伪造 report 把
  // 别的 tab 标成 active，骗过资源预算。id 不匹配时按 stale 忽略，不触发重绑。
  // [事务] 状态写入必须在同一同步块内完成，避免 report 与 close 交错出“已关闭但 active”。
  async reportResidency(
    payload: BrowserViewResidencyReportPayload & { windowId: number },
  ): Promise<void> {
    const tab = this.requireRendererOwnedTab(payload);
    // restoreUrl 为空串/纯空白时保留旧值：webview 重建期间 renderer 会先报一次空地址，
    // 直接覆盖会让恢复仓库丢掉真实 URL（INV-17 的快照一致性校验随后会把整条 pageState 判为过期）。
    tab.cachedUrl = payload.restoreUrl?.trim() || tab.cachedUrl;
    // undefined 表示本次没上报该字段（沿用），null 表示页面确实没有标题（清空）；
    // 用同一分支处理会把“没上报”当成“清空”，标签标题在每次驻留上报时被抹掉。
    if (payload.title !== undefined) tab.cachedTitle = payload.title ?? "";
    if (payload.faviconUrl !== undefined) tab.cachedFaviconUrl = payload.faviconUrl;
    tab.loading = payload.loading;
    // 只信任 renderer 能看见的四项（selected/visible/currentTask/loading）；audible 现读 guest，
    // operation/capture/download 查 manager 自身注册表——这些事实不在 renderer 侧，
    // 也就不给页面脚本一次伪造上报把预算里最贵的几项清零的机会。
    this.residencyCoordinator.report(tab.tabId, {
      selected: payload.selected,
      visible: payload.visible,
      currentTask: payload.currentTask,
      loading: payload.loading,
      audible: safeBool(() => tab.guest?.isCurrentlyAudible?.() ?? false, false),
      mediaActive: tab.mediaActive,
      operationActive: this.hasRunningRequestForTab(tab.tabId),
      captureActive: this.isTabCaptureActive(tab),
      downloadActive: this.hasPendingDownloadForTab(tab.tabId),
    });
    if (payload.selected) {
      // user tab（claimable）只自报 active，不进 activeTabByScope：它的可见性由用户控制，
      // 进索引会让不带 tabId 的 agent 命令落到用户页面上（见 effectiveActiveTabId 的回退）。
      // agent tab 走 selectTab 是为了同时把同 scope 其它候选的 active 置 false（INV-01）。
      tab.active = true;
      if (!tab.claimable) this.selectTab(tab, false);
      // renderer 前台上报是用户真实在看的信号（面板展开/切 tab），与 claimable 无关，
      // 必须独立于 selectTab 触发恢复。
      this.maybeRestoreBackgroundViewport(tab);
    } else {
      tab.active = false;
      // key 必须现算：claim/release 会整体替换 tab.owner，用创建时缓存的 key 会去删旧 scope 的索引项。
      // 只删指向自己的条目，否则会把同 scope 刚选中的另一个 tab 从索引里抹掉。
      const key = scopeKey(tab.owner);
      if (this.activeTabByScope.get(key) === tab.tabId) this.activeTabByScope.delete(key);
    }
    await this.persistShell(tab);
    await this.residencyCoordinator.whenIdle();
  }

  // ACK 只在 generation 完全匹配时生效：renderer 可能因消息延迟发出上一轮的 ACK，
  // 若按 tabId 直接放行，会让当前轮次的等待者提前解除，把仍存活的 guest 当已挂起。
  // [失败路径] 找不到 waiter 是正常的（超时已兜底），静默丢弃，不能抛错中断 IPC。
  acknowledgeSuspend(payload: { tabId: string; generation: number; windowId: number }): void {
    // windowId 先于 waiter 查表：同一 tabId 在另一窗口的迟到 ACK 不该唤醒本窗口的等待者，
    // 否则窗口复用时会把新 guest 的挂起流程提前解除。
    const tab = this.tabs.get(payload.tabId);
    if (!tab || tab.owner.windowId !== payload.windowId) return;
    const key = suspendAckKey(payload.tabId, payload.generation);
    this.suspendAckWaiters.get(key)?.();
  }

  // renderer 的 × 按钮走这里。先做 owner 校验再 close：用户只能关自己窗口/会话的 tab，
  // 否则任意页面脚本都能发 IPC 关掉别的对话的标签。
  // [事务] closeTab 内部同步删 registry + 写 tombstone，异步删持久化；本方法 await
  // 后者是为了让 renderer 收到结果时磁盘也已清理，避免“关闭后重启又出现”。
  async closeTabFromRenderer(
    payload: BrowserViewCloseTabRequest & { windowId: number },
  ): Promise<void> {
    // Agent close 已把 logical tab 从 main 删除，而 BrowserViewCloseTab 通知可能落在
    // 非当前 workspace 被 renderer 丢弃，UI 侧仍留着壳。此时用户点 × 走到这里，直接抛
    // "unavailable for renderer scope"，renderer 拿不到授权就永不移除 UI —— tab 永远关不掉。
    // main 已经没有这个 logical tab，renderer 想收敛自己的壳是安全且必要的：幂等放行，
    // 同时补上 tombstone，阻止迟到 attach 把它复活。scope 校验只对仍存活的 tab 生效，
    // 跨 window/workspace 越权关闭他人 tab 仍然被拒绝。
    const existing = this.tabs.get(payload.tabId);
    if (!existing || existing.lifecycle === "closed") {
      // 补墓碑而不是只返回：没有 tombstone 时，一条迟到的 attach 会把刚被 Agent 关掉的 tab
      // 原地复活（INV-16），用户会看到自己刚关掉的标签又出现。
      this.closedTabIds.add(payload.tabId);
      return;
    }
    // close 是收敛意图：remoteSessionId 的防重连语义只属于 attach（见 attachGuest 的
    // remote-session-mismatch）。attach 侧 renderer 对该字段有 workspaceRemoteSessionId 兜底、
    // close 侧没有，严格比对会让远程 human tab 永远关不掉。renderer 关闭自己看得见的 tab 不构成
    // 越权，window/workspace/session 三项仍严格校验，跨作用域越权关闭照旧拒绝。
    const tab = this.requireRendererOwnedTab(payload, { skipRemoteSession: true });
    // notifyRenderer=false：关闭是用户点 × 触发的，再发一次 onCloseTabRequested 会让 renderer
    // 收到自己引发的重复关闭事件。durable 版本先删恢复仓库再删 registry，避免重启后复活。
    await this.closeTabDurably(tab, false);
  }

  // 只等恢复仓库自己的 mutation 队列（whenIdle 内部 await 该队列），不覆盖 guest 恢复 flight：
  // 需要“没有在途 guest 恢复”的调用方必须另行 waitForGuestRecovery（D-9-4）。
  // recoveryStore 未注入时（当前 main 装配即如此）两个等待都是空操作，本方法会立即 resolve；
  // 调用方不能把它当作“恢复已完成”的证据。
  async whenRecoveryIdle(): Promise<void> {
    await this.residencyOptions.recoveryStore?.whenIdle?.();
  }

  // 用户切回一个 suspended tab 时，renderer 请求“确保驻留”。这里不能直接 attach：
  // 必须先让 coordinator 把状态迁出 suspended，再由 renderer 重建 webview 并回调 attach。
  // 重复调用是幂等的：restoreFlights 复用同一 Promise，避免连点造成多个 guest。
  async ensureResidentFromRenderer(
    payload: BrowserViewCloseTabRequest & { windowId: number },
  ): Promise<void> {
    const tab = this.requireRendererOwnedTab(payload);
    // 用一次性 signal 而不是调用方的：这条路径没有可取消的上层请求，复用外部 signal 会让
    // 前一个命令的 abort 把这次用户触发的恢复一起取消。
    // ensureGuest 内部复用 guestAttachFlights（INV-06），连点只会得到同一个 flight。
    const guest = await this.ensureGuest(tab, new AbortController().signal);
    // 返回 null 表示恢复失败（webview 创建失败或代际不匹配），必须抛错让 renderer 停在
    // “不可用”占位；静默返回会留下一个永远空白的 pane。
    if (!guest) throw new Error(`browser tab '${tab.tabId}' restore failed`);
  }

  // 启动/重开窗口时把恢复仓库里的 shell 灌回 renderer。只恢复未被其它窗口 claim 的
  // tab，且按 owner 过滤：恢复仓库是全局的，不能把别的 workspace 的页面塞进当前窗口。
  // [事务] 先把 shell 写进 tabs registry 再返回给 renderer，保证 renderer 立刻 attach
  // 时能查到 owner；反之会得到 unknown tab 并被拒绝。
  // [失败路径] 单条记录损坏只跳过该条，不能让整个恢复流程失败。
  async restoreTabs(payload: {
    windowId: number;
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId?: string;
  }): Promise<BrowserViewRestoredTabShell[]> {
    // [可达性] 生产装配未注入 recoveryStore（index.ts 的 residency 选项显式不提供，产品语义为
    // 「完整退出即清空」），因此 listShells 恒返回空数组、本函数恒返回 []，
    // 下面的墓碑跳过、claim 抢占、owner/tab 重建分支在当前生产路径中全部不可达；见 D-9-4。
    // 作用域过滤交给 listShells：workspaceKey 必填，remoteSessionId/sessionId 缺省时不会收窄，
    // 省略 sessionId 即恢复该 workspace 下所有会话的 shell。
    // [信任边界] workspaceKey 由调用方自报，main 侧未与 sender 窗口所属 workspace 比对（D-16-1 落点）。
    const records =
      (await this.residencyOptions.recoveryStore?.listShells({
        workspaceKey: payload.workspaceKey,
        ...(payload.remoteSessionId ? { remoteSessionId: payload.remoteSessionId } : {}),
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      })) ?? [];
    this.log?.(
      `[browser-use] restoreTabs windowId=${payload.windowId} workspaceKey=${payload.workspaceKey} remoteSessionId=${payload.remoteSessionId ?? "<local>"} sessionId=${payload.sessionId ?? "<all>"} records=${records.length}`,
    );
    const restored: BrowserViewRestoredTabShell[] = [];
    for (const record of records) {
      // 墓碑优先于一切恢复依据（INV-16）：恢复仓库里的 shell 可能比 tombstone 旧，
      // 放行会让用户明确关掉的标签在下次启动时回来。
      if (this.closedTabIds.has(record.tabId)) continue;
      // claim 先到先得：同一份恢复仓库可能被多个窗口同时请求，已归属其它窗口的 shell 不重复建。
      // 同一窗口重复调用是幂等的（写入同值，set 无副作用）。
      const claimedWindowId = this.restoredTabClaims.get(record.tabId);
      if (claimedWindowId !== undefined && claimedWindowId !== payload.windowId) continue;
      this.restoredTabClaims.set(record.tabId, payload.windowId);

      let tab = this.tabs.get(record.tabId);
      if (!tab) {
        // 恢复出的 owner 必须重建而不是沿用记录里的标识：
        // requestId 是 INV-08 的去重键，复用会让首个命令被判成 duplicate_request_id；
        // browserId 缺失时按 origin 分流，user shell 落 unclaimed-iab，避免被同会话的 agent 认领；
        // browserGeneration 缺失填 0 是哨兵，任何带真实代际的迟到 attach 都会被 INV-20 拒掉；
        // windowId 取 payload（shell 迁到当前窗口），其余作用域字段取记录（持久化事实为准）。
        const owner: InternalExecutionContext = {
          requestId: `restore:${randomUUID()}`,
          browserId:
            record.browserId ?? (record.origin === "user" ? "unclaimed-iab" : "restored-iab"),
          browserGeneration: record.browserGeneration ?? 0,
          windowId: payload.windowId,
          workspaceKey: record.workspaceKey,
          ...(record.remoteSessionId ? { remoteSessionId: record.remoteSessionId } : {}),
          sessionId: record.sessionId,
          // 恢复出的 shell 固定走 desktop-continuous：web-remote-replayable 靠重放队列重建页面，
          // 同一条记录被两条链路各自恢复一次会重复 attach 同一个 webview。
          clientMode: "desktop-continuous",
        };
        // 这里构造的是“没有 guest 的 logical shell”，CDP 与 guest 字段全部按未挂载初始化：
        // cdpAttached=false 与 guestLifecycle="detached" 让 teardown 不会对不存在的 guest 发 detach；
        // guestGeneration=0 + hasAttachedGuest=false 让首次 attach 走新建路径而不是 isSameGuest；
        // rebindRequested=false 保证首次挂载不会跳过 onOpenTabRequested。
        tab = {
          tabId: record.tabId,
          owner,
          cdpAttached: false,
          guestLifecycle: "detached",
          pendingCdpCommands: 0,
          guestGeneration: 0,
          hasAttachedGuest: false,
          rebindRequested: false,
          lifecycle: record.lifecycle,
          origin: record.origin,
          // claimable 由 origin 推出：只有用户手开的 shell 允许 agent 后续 claim；
          // 恢复出的 agent tab 直接可被同 scope 命令寻址，不需要再 claim 一次。
          claimable: record.origin === "user",
          // userOwner 只在 user shell 上留底，releaseToUser 靠它把 owner 还原成用户视角；
          // 给 agent shell 留底会让 finalize 把一个本应受控的 tab 错误交还给用户。
          ...(record.origin === "user" ? { userOwner: { ...owner } } : {}),
          active: false,
          ...(record.viewport ? { viewportOverride: { ...record.viewport } } : {}),
          loading: false,
          mediaActive: false,
          cachedUrl: record.restoreUrl ?? "",
          cachedTitle: record.title ?? "",
          cachedFaviconUrl: record.faviconUrl,
          // openedAt 沿用记录：淘汰按真实打开时间排序，用恢复时刻会让所有 shell 同岁、
          // 退化成按 Map 插入顺序关闭。
          openedAt: record.openedAt,
          // 孤儿关闭开关：只在 forced mount 后三类恢复事实全缺时触发 recovery-orphan 关闭；
          // 首次成功恢复后会被清回 false，避免下一次普通 page-state 淘汰被误判成孤儿。
          restoredFromStore: true,
        };
        this.tabs.set(record.tabId, tab);
        // 入册即 suspended 而不是 live：shell 还没 attach guest，标 live 会让驻留预算
        // 把它算作已占资源，超限时反而先关掉真正在用的 tab。
        this.registerTabResidency(tab, false, "suspended", record.lastSelectedAt);
      } else if (tab.owner.windowId !== payload.windowId) {
        // 内存里已有同 tabId 但归属别的窗口：不抢、不覆盖 owner，交给原窗口继续持有。
        continue;
      }
      // 用 tab.owner 而不是 record：内存中的 owner 可能已被 claim/release 改写过代际与 browserId，
      // 回放记录里的旧代际会让紧接着的 attachGuest 判 generation-mismatch。
      restored.push(toRestoredShell(record, tab.owner));
    }
    return restored;
  }

  // execute 是 IPC 入口：负责 requestId 去重、signal 注册、以及把命令路由到对应 tab。
  // requestId 重复必须直接失败而不是排队：重复通常来自 renderer 重发，排队会导致同一
  // 点击被执行两次。注册 signal 监听后要在 finally 注销，否则长时间运行会累积监听。
  // [失败路径] 未提供 context 的旧调用走 legacy scope；不能让缺字段落到默认值后
  // 与真实 scope 撞车。
  async execute(
    contextOrKey: BrowserGuestExecutionContext | string,
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<BrowserCommandResult> {
    // legacy 字符串入口必须在这里归一化：下游 withMeta 与 scopeKey 都假定 context 已是结构化对象，混用会让 scope 比较退化。
    const context =
      typeof contextOrKey === "string" ? normalizeLegacyContext(contextOrKey) : contextOrKey;
    // 日志在去重判断之前打：重复请求也要留下 browserId/generation，否则重发问题无法从日志复原。
    this.log?.(
      `[browser-use] execute requestId=${context.requestId} browserId=${context.browserId} generation=${context.browserGeneration} windowId=${context.windowId} sessionId=${context.sessionId} method=${command.method}`,
    );

    // 重复 requestId 在 dispatch 前直接失败：renderer 重连重发同一请求时，排队会让同一次
    // 点击执行两次。这里不覆盖旧 entry，因为覆盖会让前一个命令的 finally 无法按 identity 清理。
    // [失败路径] 返回 duplicate_request_id，模型不应重试同一 id。
    if (this.runningRequests.has(context.requestId)) {
      // requestId 是取消与 lifecycle cleanup 的 correlation key。同 key 覆盖会让
      // 取消命中错误 scope，且旧 finally 会删除仍在执行的新 entry。重复请求必须在下发前失败。
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "duplicate_request_id",
            message: `browser requestId '${context.requestId}' is already running`,
            sideEffect: "none",
          },
          elapsedMs: 0,
        },
        context,
      );
    }

    // cancelRequest 必须先于 controller 创建处理：它取消的是别的 requestId，给自己建 controller 反而留下无人回收的条目。
    if (command.method === "cancelRequest") {
      // abortRequest 按 requestId 命中目标条目并返回是否真的取消；条目不存在时返回 false，调用方据此区分「已结束」与「从未存在」。
      const cancelled = this.abortRequest(command.requestId, context);
      return this.withMeta({ ok: true, value: { cancelled }, elapsedMs: 0 }, context);
    }
    // turnEnded 只清本 turn 的资源，不取消仍在执行的请求；取消是 cancelRequest 的职责，合并会让正常收尾误杀在飞命令。
    if (command.method === "turnEnded") {
      // turnId 缺省回落到 context.turnId：renderer 未显式上报时仍要能关掉当前 turn 的 tab。
      this.endTurn(context, command.turnId ?? context.turnId);
      return this.withMeta({ ok: true, elapsedMs: 0 }, context);
    }
    // closeSession 先收会话级状态，再按 closeTabs 决定是否连 tab 一起关；顺序颠倒会让 tab 关闭回调读到已清空的 session 名。
    if (command.method === "closeSession") {
      // closeSession 只清会话索引、不 await；下面 closeTabs 才做异步卸载。
      this.closeSession(context);
      // closeTabs 必须 await：renderer 收到成功前 tab 仍在 registry，紧接着的 list 会看到已关闭会话的残留。
      if (command.closeTabs === true) await this.closeSessionTabs(context);
      return this.withMeta({ ok: true, elapsedMs: 0 }, context);
    }

    // 内部 controller 与调用方 signal 分离：abortRequest 只能通过它取消，避免外部 signal 被多个请求共享时互相牵连。
    const controller = new AbortController();
    // linkAbortSignal 返回注销函数，finally 必须调用；不注销会让已结束请求的 signal 持续持有 controller。
    const unlink = linkAbortSignal(signal, controller);
    // dispatched 初始 false：直到真正下发 backend 前，取消都必须报 sideEffect=none。
    // tabId 先留空，由 resolveTab 回填；这样 abort 在解析前到达也能找到条目。
    // controller 独立于调用方 signal，abortRequest 通过它统一取消。
    const running: RunningRequest = { context, controller, dispatched: false };
    // 登记必须早于 executeInScope：命令内部查 runningRequests 判断是否已被取消，登记晚了会漏掉首个同步段。
    this.runningRequests.set(context.requestId, running);
    try {
      // 真正分发在 executeInScope，否则 execute 的 finally 无法统一收口。
      return await this.executeInScope(context, command, running);
    } finally {
      // unlink 放在 finally 首位：即使 executeInScope 抛错，也要先断开外部 signal，避免迟到 abort 改已结束请求的状态。
      unlink();
      // 清理必须绑定 entry identity；即使未来其它入口误写同 key，旧请求也不能删除新状态。
      if (this.runningRequests.get(context.requestId) === running) {
        // 删除按 entry identity：renderer 可能复用 requestId，旧命令的 finally 若按 key
        // 盲删，会删掉新命令的条目，导致新命令无法取消、sideEffect 统计失真。
        // 比较后再删保证只有 owner 清理自己的条目。
        this.runningRequests.delete(context.requestId);
      }
      // tabId 由 resolveTab 回填；只有回填过才需要刷新保护，未解析到 tab 的命令没有可保护的 guest。
      if (running.tabId) this.refreshRuntimeProtection(running.tabId);
    }
  }

  // 真正分发命令的地方。先按 command 决定是否需要 guest，再解析 tab；list/nameSession
  // 这类命令不接触 guest，不能因为 tab 无 guest 就失败。
  // [事务] tab 解析与 dispatched 标记必须在同一同步段完成，避免 abort 在两者之间插入造成“已取消但仍执行”。
  // [并发] 每个 tab 的 viewportMutation/restoreFlight 是串行屏障，命令必须等它们收敛。
  private async executeInScope(
    // context 携带 sender 绑定的 window/workspace/session，后续每次 resolveTab 都以它为准。
    context: InternalExecutionContext,
    // command 的 method 已由 execute 校验过，这里只按它分流。
    command: BrowserCommand,
    // running 持有 controller 与 dispatched，取消与副作用上报都读它。
    running: RunningRequest,
  ): Promise<BrowserCommandResult> {
    // startedAt 在入口取一次：所有分支的 elapsedMs 都以它为基准，分支内再取会让返回值彼此不可比。
    const startedAt = Date.now();
    // 进入分发前先判 aborted：execute 已登记 runningRequests，此时取消必须立刻返回，不能继续解析 tab。
    if (running.controller.signal.aborted) {
      // 取消结果 sideEffect 固定 false：此刻尚未触碰 guest，报 uncertain 会让上层误以为页面已被改写。
      return this.cancelledResult(context, false, startedAt);
    }

    // list 只投影 ownedTabs、不触碰 guest，因此排在 ensureGuest 之前；未挂载的 tab 也必须能列出。
    if (command.method === "list") {
      // summary 是异步的，必须 Promise.all 并行；串行会让响应时间随 tab 数量线性放大。
      const tabs = await Promise.all(this.ownedTabs(context).map((tab) => this.summary(tab)));
      return this.withMeta({ ok: true, tabs, elapsedMs: Date.now() - startedAt }, context);
    }

    // listUserTabs 走 openUserTabs：只回用户可见且未关闭的 tab，agent tab 不能出现在用户面板。
    if (command.method === "listUserTabs") {
      // userTabInfo 是同步投影，不读 guest，避免列表面板触发恢复或 attach。
      const userTabs = this.openUserTabs(context).map((tab) => this.userTabInfo(tab));
      return this.withMeta({ ok: true, userTabs, elapsedMs: Date.now() - startedAt }, context);
    }

    // nameSession 只写 scopeKey 维度、不碰 tab；名字不参与鉴权，不能凭它认领他人会话。
    if (command.method === "nameSession") {
      // session 名写入按 scopeKey：同一 sessionId 在不同 browser/window 下是不同名字，
      // 用 sessionId 会让两侧互相覆盖。名字不参与鉴权。
      this.sessionNames.set(scopeKey(context), command.name);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context);
    }

    // visibilityGet 缺省返回 false 而不是 undefined：renderer 按布尔值渲染，三态会让面板状态抖动。
    if (command.method === "browserVisibilityGet") {
      // 可见性查询不带 tab 参数，withMeta 也不传 tab；否则 selected 为空会让 scope 判定走另一条分支。
      return this.withMeta(
        {
          ok: true,
          value: this.visibilityByScope.get(scopeKey(context)) === true,
          elapsedMs: Date.now() - startedAt,
        },
        context,
      );
    }

    // visibilitySet 必须与 selectTab 分离：可见不等于选中，面板显示时不能顺手改 active。
    if (command.method === "browserVisibilitySet") {
      // key 只算一次并复用给 visibilityByScope 与 active 查询，同一命令内不允许出现两把 scope key。
      const key = scopeKey(context);
      // visibility 与 selected 分开存：面板可见但未选中任何 tab 时也要能回放可见性。
      // 写入 true 时不能顺带把某个 tab 设为 active，那属于 selectTab 的职责。
      this.visibilityByScope.set(key, command.visible);
      // active 只是候选：activeTabByScope 可能指向已关闭 tab，后面还要用 tabs.get 过滤。
      const active = this.activeTabByScope.get(key);
      // active 失效时回落到最后一个 owned tab；完全没有 tab 时 selected 为 undefined，withMeta 必须接受。
      const selected = active ? this.tabs.get(active) : this.ownedTabs(context).at(-1);
      // 通知放在 set 之后：origin renderer 收到回调时会回读可见性，先通知会读到旧值。
      this.onVisibilityChanged?.(command.visible, context, selected?.tabId);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, selected);
    }

    // viewportSet 先 resolveTab 再建 viewport：tab 不存在时不能先写 override，否则会留下无主尺寸。
    if (command.method === "browserViewportSet") {
      // resolveTab 只返回当前 context 可见的 tab，跨 scope 的 tabId 在这里就被挡掉。
      const tab = this.resolveTab(context, command.tabId);
      // unavailableTabResult 统一生成 backend_unavailable，避免每个分支各写一份错误码。
      if (!tab) return this.unavailableTabResult(context, command.tabId, startedAt);
      const viewport = { width: command.width, height: command.height };
      // setTabViewport 内部串行化同一 tab 的 viewport 写入，必须 await 完再通知 renderer。
      await this.setTabViewport(tab, viewport);
      // setTabViewport 成功后 selectTab(tab, true)：改尺寸意味着用户要看这个 tab。
      this.selectTab(tab, true);
      // 通知放在 setTabViewport 之后，renderer 回读时 override 已生效。
      this.onViewportChanged?.(viewport, tab.owner, tab.tabId);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }

    // reset 与 set 走两个命令：reset 落 null 表示回落自然尺寸，不是 0×0。
    if (command.method === "browserViewportReset") {
      // reset 同样先 resolveTab；对不存在 tab 的 reset 不能静默成功。
      const tab = this.resolveTab(context, command.tabId);
      // reset 对不存在的 tab 必须报 backend_unavailable，静默成功会让 pane 保留旧尺寸。
      if (!tab) return this.unavailableTabResult(context, command.tabId, startedAt);
      // resetTabViewport 清 override 并重算 background fallback；只删字段会让页面停在旧尺寸。
      await this.resetTabViewport(tab);
      // reset 通知传 null：renderer 据此删除 pane 的内联宽高，而不是写入零值。
      this.onViewportChanged?.(null, tab.owner, tab.tabId);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }

    // 两个录制查询命令共用一段，因为它们只读 recordings 且不需要 guest，所以放在 ensureGuest 之前。
    if (command.method === "recordingStatus" || command.method === "recordingCancel") {
      // 按 recordingId 直查、不遍历：id 由 main 生成，跨 scope 猜测不应有命中机会。
      const entry = this.recordings.get(command.recordingId);
      // entry 必须再比 sameScope：recordingId 可被跨会话猜到，仅凭 id 会让别的会话读到录制状态。
      if (!entry || !sameScope(entry.context, context)) {
        // 不可用分支不回 recording 字段，返回半截快照会让调用方以为录制仍存在。
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser recording '${command.recordingId}' is unavailable in this context`,
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      // 命令带 tabId 时必须与 entry.tabId 一致，否则同一录制会被当成另一个 tab 的状态查询。
      if ("tabId" in command && command.tabId && command.tabId !== entry.tabId) {
        // tab 不匹配的错误与「录制不存在」分开：调用方需要区分 id 错和 tab 错。
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser recording '${command.recordingId}' does not belong to tab '${command.tabId}'`,
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      // 只有 running 才 abort：已进入 terminal 的录制再 cancel 会覆盖原始失败原因。
      if (command.method === "recordingCancel" && entry.status === "running") {
        // abort reason 用 AbortError：runRecording 按 name 识别取消，普通 Error 会被判 failed。
        entry.controller.abort(new DOMException("recording cancelled", "AbortError"));
        // 状态必须在这里同步写定：runRecording 的 catch 可能晚到，晚写会让 status 查询短暂看到 running。
        this.setRecordingTerminal(entry, "cancelled");
      }
      // 取消与查询共用返回；cancel 后立刻回快照，调用方无需再轮询一次。
      return this.withMeta(
        {
          ok: true,
          recording: this.snapshotRecording(entry),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        this.tabs.get(entry.tabId),
      );
    }

    // activateTab 允许恢复已挂起的 tab，因此先查 tabs 再 ensureGuest，而不是走 resolveTab。
    if (command.method === "activateTab") {
      // 直接读 tabs 而不是 ownedTabs：需要区分「不存在」与「存在但不属于本 scope」。
      const tab = this.tabs.get(command.tabId);
      // closed 必须拒绝：对已关闭 tab 调 ensureGuest 会重建 guest，等于把用户关掉的标签复活。
      if (!tab || tab.lifecycle === "closed" || !sameScope(tab.owner, context)) {
        // 不可用分支不带 tab：错误路径不能把别人的 tab 摘要泄露出去。
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser tab '${command.tabId}' is unavailable for activation. ${TAB_CONTEXT_RECOVERY_HINT}`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      // tabId 在 ensureGuest 之前回填：恢复期间 abort 也要能找到这条请求。
      running.tabId = tab.tabId;
      // 恢复前刷新：ensureGuest 期间 tab 仍可能被 LRU 选中，保护要覆盖整个异步窗口。
      this.refreshRuntimeProtection(tab.tabId);
      // activation 允许重建 guest；传 running.signal，取消能中断恢复。
      const guest = await this.ensureGuest(tab, running.controller.signal);
      // ensureGuest 返回 null 或 guest 已销毁都算恢复失败；只看 null 会把已销毁的 guest 当成可用。
      if (!guest || safeBool(() => guest.isDestroyed(), true)) {
        // 恢复失败不回滚 tab：tab 仍有效，只是本次激活没成功，删掉会让用户丢失页面。
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser tab '${command.tabId}' could not be restored for activation`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      // 旧 tabs.get 只在 agent 内创建 Tab binding，renderer 仍可能展示另一个页面。
      // 激活必须先原子更新 main selected 状态，再通知 origin renderer；renderer 仅在该 scope
      // 正处前台时展开对应 view，后台对话只能记录激活态，不能抢用户当前会话。
      this.selectTab(tab, true);
      // 成功路径先 selectTab 再 summary，summary 读到的 active 才是刚激活的 tab。
      return this.withMeta(
        {
          ok: true,
          tab: await this.summary(tab),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    // claimTab 只接管 canClaimUserTab 认可的 user tab；agent 自建 tab 不需要 claim。
    if (command.method === "claimTab") {
      // candidate 用 tabs.get 而不是 ownedTabs：待认领的 user tab 此刻还不属于调用方 scope。
      const candidate = this.tabs.get(command.tabId);
      // 校验放在 claimTab 之前：claimTab 会整体替换 owner，先改再验会让失败路径留下半改状态。
      if (!candidate || !this.canClaimUserTab(candidate, context)) {
        // 不可用分支不能回 tab：认领失败时 tab 仍属原 owner，回摘要等于泄露。
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `user browser tab '${command.tabId}' is unavailable or already claimed`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      // claimTab 同步完成 owner 替换与 active 更新，因此这里不需要 await。
      const tab = this.claimTab(candidate, context);
      // 成功返回当前 owner 的 summary，summary 内部按 tab.owner 判定 scope。
      return this.withMeta(
        {
          ok: true,
          tab: await this.summary(tab),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    // finalizeTabs 一次性收敛多个 tab，先校验全部 tabId 再改状态，避免部分成功。
    if (command.method === "finalizeTabs") {
      // keep 用 Map 去重：同一 tabId 重复出现时后者覆盖前者，避免 finalize 被调用两次。
      const keep = new Map(command.keep.map((item) => [item.tabId, item.status]));
      // unknown 只查 ownedTabs：不能 finalize 别人 scope 的 tab，否则等于跨会话改生命周期。
      const unknown = [...keep.keys()].filter(
        (tabId) => !this.ownedTabs(context).some((tab) => tab.tabId === tabId),
      );
      // 有未知 tabId 就整体失败：部分 finalize 会让调用方以为全部成功。
      if (unknown.length > 0) {
        // 错误信息必须带全部未知 id，以便调用方一次修正而不用逐个试。
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `cannot finalize unknown tab(s): ${unknown.join(", ")}`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        );
      }
      // 校验通过后才落状态；finalizeTabs 内部不再做 scope 判断。
      this.finalizeTabs(context, keep);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context);
    }

    // newTab 在 resolveTab 之前处理：它没有 tabId，走 resolveTab 会落到「不可用」分支。
    if (command.method === "newTab") {
      // createTab 先建 shell 再 ensureGuest；shell 必须在异步前登记，否则 list 看不到创建中的 tab。
      const tab = this.createTab(context);
      // 新 tab 的 tabId 立即回填：ensureGuest 失败时 finally 也要能刷新保护。
      running.tabId = tab.tabId;
      // 新 tab 尚未 attach，保护按 pre-attach 规则计算；漏刷会让并发 LRU 先回收它。
      this.refreshRuntimeProtection(tab.tabId);
      // ensureGuest 传 running.signal；newTab 被取消时不能留下半建的 guest。
      const guest = await this.ensureGuest(tab, running.controller.signal);
      // ensureGuest 返回 null 表示取消或不可用，两种都要走 closeTabDurably，不能只 return。
      if (!guest) {
        // 先算 cancelledOrUnavailable 再 close：close 会把 lifecycle 置 closed，之后再算就拿不到取消原因。
        const result = this.cancelledOrUnavailable(context, running, startedAt, tab);
        // newTab 在 ready ack 前失败时不能留下无 guest 的 provisional tab；否则后续 list/attach
        // 会把一次已取消的创建误当成仍存活的 tab。close 同时给 renderer 发卸载请求并留下 tombstone。
        await this.closeTabDurably(tab);
        // closed 标记让 withMeta 按已关闭 tab 投影，避免返回一个随后就消失的 tabId。
        return this.withMeta(result, context, tab, "closed");
      }
      // 成功路径在 ensureGuest 之后才 summary：summary 需要 guest 已挂载后的 URL/title。
      return this.withMeta(
        {
          ok: true,
          tab: await this.summary(tab),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    // 非 newTab 命令统一 resolveTab；tabId 缺省时按 context 选 active，不能直接取 tabs 第一个。
    const tab = this.resolveTab(context, "tabId" in command ? command.tabId : undefined);
    // 解析失败分成「指定 id 不可见」与「没有可用 tab」两种文案，前者带恢复提示。
    if (!tab) {
      // 失败分支不回 tab：resolveTab 失败时拿不到归属，回任何 tab 都会越权。
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "backend_unavailable",
            message:
              "tabId" in command && command.tabId
                ? `browser tab '${command.tabId}' is not visible in the current context. ${TAB_CONTEXT_RECOVERY_HINT}`
                : "browser tab is unavailable",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
      );
    }
    // 解析成功后回填 tabId；后面的 ensureGuest 与 CDP 都依赖这条绑定。
    running.tabId = tab.tabId;
    // 通用命令进入 ensureGuest 前刷新，避免解析完成到恢复完成之间出现保护空档。
    this.refreshRuntimeProtection(tab.tabId);

    // recordingStart 在 ensureGuest 之前处理：录制器自己管理 guest，重复 start 不应触发恢复。
    if (command.method === "recordingStart") {
      // 按 tabId 找 running 录制：同一 tab 只允许一个 running，cancelled 的允许重开。
      const active = [...this.recordings.values()].find(
        (entry) => entry.tabId === tab.tabId && entry.status === "running",
      );
      // 已有 running 直接失败而不是排队：排队会让 renderer 的 start 返回成功但实际未开始。
      if (active) {
        // 错误带 sideEffect:none：没有创建录制条目，页面也未被触碰。
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "execution_error",
              message: `browser tab '${tab.tabId}' already has active recording '${active.id}'`,
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      // entry 由 main 创建，id 不取调用方值；renderer 传入的 id 不能成为跨会话寻址键。
      const entry = this.createRecordingEntry(context, tab);
      // 登记必须早于异步 run：renderer 拿到 id 后可能立刻 cancel，若 map 里还没有
      // entry，cancel 会静默无效，录制继续跑到结束。entry.id 由 main 生成，不能用
      // 调用方传入值。
      this.recordings.set(entry.id, entry);
      // running 录制计入 captureActive，登记后必须刷新才能挡住回收。
      this.refreshRuntimeProtection(tab.tabId);
      // runRecording 不 await：start 要立刻返回 id，生命周期由 catch 收敛。
      void this.runRecording(entry, tab, command.options).catch((error: unknown) => {
        // catch 先判 status：cancel 已写 terminal 时不能再覆盖成 failed。
        if (entry.status !== "running") return;
        // signal.reason 是 DOMException 且 name 为 TimeoutError 才算超时，其余 abort 归 cancelled。
        if (
          entry.controller.signal.aborted &&
          entry.controller.signal.reason instanceof DOMException &&
          entry.controller.signal.reason.name === "TimeoutError"
        ) {
          // 超时取消与普通取消分开：超时要报 failed 并带原因，普通取消报 cancelled。
          this.setRecordingTerminal(entry, "failed", entry.controller.signal.reason.message);
        } else if (entry.controller.signal.aborted) {
          // 非超时的 abort 一律记 cancelled，包括 renderer 主动 cancel 与 turn 结束。
          this.setRecordingTerminal(entry, "cancelled");
        } else {
          // 未知错误按 failed 记录并带 message；吞掉错误会让录制永远停在 running。
          this.setRecordingTerminal(
            entry,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
      // start 返回快照而不是 entry：entry 持有 controller，不能跨 IPC 暴露。
      return this.withMeta(
        {
          ok: true,
          recording: this.snapshotRecording(entry),
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    // getDialog 只读 pendingDialogs、不需要 guest；对话框由 CDP 事件写入。
    if (command.method === "getDialog") {
      // dialog 缺省 null 而不是 undefined：renderer 依此判断「当前无对话框」。
      return this.withMeta(
        {
          ok: true,
          dialog: this.pendingDialogs.get(tab.tabId) ?? null,
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    // close 走 closeTabDurably：先删恢复仓库再删 registry，重启后不会复活。
    if (command.method === "close") {
      // 必须 await：renderer 收到成功时 tab 应已从 registry 移除。
      await this.closeTabDurably(tab);
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab, "closed");
    }
    // finalize 只改 lifecycle、不关 tab；deliverable=false 表示留在 active 供用户继续看。
    if (command.method === "finalize") {
      // 显式 false 才回 active，缺省按 deliverable；缺省值不能变成 active，否则交付页会被回收。
      tab.lifecycle = command.deliverable === false ? "active" : "deliverable";
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    // markDeliverable 只做单向提升，因此重复调用不会把 tab 退回 active。
    if (command.method === "markDeliverable") {
      // 直接赋 deliverable：从 handoff 也能提升，表示用户重新接管。
      tab.lifecycle = "deliverable";
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    // markHandoff 把 tab 交还用户，后续 agent 命令不再默认命中它。
    if (command.method === "markHandoff") {
      // handoff 是终态之一，selectTab 会跳过非 active 的 agent tab。
      tab.lifecycle = "handoff";
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    // 固定等待不要求 guest：它只计时，提前校验 guest 会让未挂载 tab 的等待直接失败。
    if (command.method === "playwrightWaitForTimeout") {
      // 固定等待前先验证 tab；等待本身不触碰页面，也不要求 guest/CDP 已 attach。
      // turn/session/request abort 必须提前结束 timer，避免已取消的 sleep 继续占住生命周期。
      const completed = await waitForDelay(command.timeoutMs, running.controller.signal);
      // waitForDelay 返回 false 表示被 abort；此时必须返回取消结果，不能继续下发后续命令。
      if (!completed) {
        // 取消结果 sideEffect=false：等待期间没有触碰页面。
        return this.withMeta(this.cancelledResult(context, false, startedAt), context, tab);
      }
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab);
    }
    // IAB 不支持 filechooser，必须在进入 executor 前拒绝；否则会落到普通 fill 并伪造成功。
    if (
      command.method === "playwright" &&
      (command.action.name === "fileChooserSetFiles" ||
        (command.action.name === "waitForEvent" && command.action.event === "filechooser"))
    ) {
      // IAB backend 不支持 filechooser；不能伪造成功或把它误当普通 DOM fill。
      return this.withMeta(
        {
          // capability_unsupported 是能力缺失、不是执行失败；调用方据此换 backend 而不是重试。
          ok: false,
          error: {
            code: "capability_unsupported",
            message: "File uploads are not supported by iab",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    // downloadPath 只查 downloads、不需要 guest；下载记录在 will-download 时已登记。
    if (command.method === "playwright" && command.action.name === "downloadPath") {
      // 按 downloadId 直查并比 tabId：下载 id 可被跨 tab 猜到，只查 id 会读到别的 tab 的路径。
      const record = this.downloads.get(command.action.downloadId);
      // 记录不存在或 tab 不匹配都报 unavailable，不能回退到「最近一次下载」。
      if (!record || record.tabId !== tab.tabId) {
        // 失败分支仍带 tab 返回，调用方需要知道是哪条下载记录不可用。
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: "download is unavailable for this tab",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      // 等到 state 离开 pending 才返回：will-download 阶段已有 savePath，但文件可能还没写完。
      const status = await waitForCondition(
        // Playwright 的 download.path() 等下载完成后再返回；will-download 阶段已有
        // savePath 不代表文件已经可安全读取，不能提前 resolve。
        () => record.state !== "pending",
        command.action.timeoutMs ?? 30_000,
        running.controller.signal,
      );
      // cancelled 与 timeout 分开：取消要报 sideEffect=false，超时要报 timeout。
      if (status === "cancelled") {
        // 取消路径不读 record.state，避免把半写文件当成结果。
        return this.withMeta(this.cancelledResult(context, false, startedAt), context, tab);
      }
      // 超时返回 timeout 而不是 execution_error：错误码决定调用方是否重试。
      if (status === "timeout") {
        // 超时分支不带 value：路径尚未确定，回部分路径会误导调用方去读。
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "timeout",
              message: "Timeout waiting for download path",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      // 只有 completed 才能读 path；cancelled/interrupted 的 path 可能指向未完成文件。
      if (record.state !== "completed") {
        // 非 completed 报 execution_error 且 sideEffect=uncertain：下载可能已产生部分副作用。
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "execution_error",
              message: `download ${record.state}`,
              sideEffect: "uncertain",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      // 成功返回 record.path；state 为 completed 时 path 必非空，未落盘的文件不会走到这里。
      return this.withMeta(
        { ok: true, value: record.path, elapsedMs: Date.now() - startedAt },
        context,
        tab,
      );
    }

    // 通用命令在这里才需要 guest，前面所有分支都在此之前返回。
    const guest = await this.ensureGuest(tab, running.controller.signal);
    // ensureGuest 返回 null 统一走 cancelledOrUnavailable，区分取消与不可用。
    if (!guest) return this.cancelledOrUnavailable(context, running, startedAt, tab);
    // guest 已销毁但 tab 仍指向它：必须先 detachGuest，否则后续 CDP 会打到死对象。
    if (safeBool(() => guest.isDestroyed(), false)) {
      // detachGuest 清理 tracker 与 CDP 状态；不清理会让 teardown 重复 detach。
      this.detachGuest(tab);
      // 销毁分支仍带 tab 返回，tab.guest 已经置空，meta 只剩 tabId 与生命周期。
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: "browser guest destroyed",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    // 有 viewport override 时把 zoom 复位到 1：renderer 已按逻辑像素布局，zoom 会二次缩放。
    if ((tab.viewportOverride || tab.backgroundViewportFallback) && guest.getZoomFactor() !== 1)
      // setZoomFactor 是同步调用；异常直接冒泡到 execute 的 finally，不会留下半状态。
      guest.setZoomFactor(1);
    // 记下当前代际：assertCurrentGuest 用它识别 await 期间的换代。
    const guestGeneration = tab.guestGeneration;
    // 闭包捕获 guest 与 generation，后续每个 CDP 下发前都要调用。
    const assertCurrentGuest = (): void => {
      // detaching 是单向退行；此时再下发 CDP 会与 teardown 的 detach 竞争。
      if (tab.guestLifecycle === "detaching") {
        // 抛错而不是返回 false：调用方必须中断命令，不能让 CDP 落到正在拆的会话。
        throw new Error("browser guest is detaching");
      }
      // guest 引用、代际、销毁状态三者任一变化都算换代；只比引用会漏掉同对象重建。
      if (
        tab.guest !== guest ||
        tab.guestGeneration !== guestGeneration ||
        safeBool(() => guest.isDestroyed(), true)
      ) {
        // 换代后抛错，调用方据此返回 backend_unavailable，而不是继续用旧会话。
        throw new Error("browser guest changed before command dispatch");
      }
    };
    // 把 tab/guest/assert 绑进闭包，避免每个调用点重复传参导致漏校验。
    const sendCdpCommand = (method: string, params?: unknown, sessionId?: string) =>
      // sendGuestCdpCommand 内部还会再判 guest 生命周期并按需重放会话；闭包这层是早期拦截。
      this.sendGuestCdpCommand(tab, guest, method, params, sessionId, assertCurrentGuest);

    // download 等待单独处理：先登记 waiter，再由页面后续动作触发下载事件。
    if (
      command.method === "playwright" &&
      command.action.name === "waitForEvent" &&
      command.action.event === "download"
    ) {
      // 超时上限 120s：真实下载可能远超默认 3s，但必须有上界防止永久挂起。
      const downloadId = await this.waitForDownload(
        tab.tabId,
        // 下载事件默认等待 3s，但允许调用方为真实下载显式扩到最多 120s。
        normalizePlaywrightTimeout(command.action.timeoutMs, 120_000),
        running.controller.signal,
      );
      // null 表示超时或被取消，按 signal 状态区分，不能一律报 timeout。
      if (!downloadId) {
        // 取消优先于超时：两者同时成立时报 cancelled，调用方才知道是主动取消。
        const result = running.controller.signal.aborted
          // 取消结果不带 error.code=timeout，避免调用方重试已取消的命令。
          ? this.cancelledResult(context, false, startedAt)
          // 非取消分支才构造 timeout 结果，error.code=timeout 供调用方决定是否重试。
          : {
              ok: false as const,
              error: {
                code: "timeout" as const,
                message: "Timeout waiting for download",
              },
              elapsedMs: Date.now() - startedAt,
            };
        // 失败分支也带 tab 返回，调用方据 error.code 区分取消与超时。
        return this.withMeta(result, context, tab);
      }
      // download 事件成功只回 id、不回 path；path 在 completed 前不可用。
      return this.withMeta(
        {
          ok: true,
          value: { id: downloadId },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }

    // handleDialog 单独分支：它必须先 assert 再标记 dispatched，因为 CDP 调用会真实改变页面。
    if (command.method === "handleDialog") {
      try {
        // try 只包 assertCurrentGuest：断言失败要回 sideEffect:none，不能进下面的 CDP 发送。
        assertCurrentGuest();
      } catch {
        // assert 失败回 backend_unavailable 且不重试；guest 换代后重试会打到新页面。
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: "browser guest changed before command dispatch",
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        );
      }
      // 标记 dispatched 在 CDP 调用前：handleDialog 一旦下发就可能已经改变页面。
      running.dispatched = true;
      // Page.handleJavaScriptDialog 必须带 accept；promptText 只在 prompt 类型存在时展开。
      const execution = sendCdpCommand("Page.handleJavaScriptDialog", {
        accept: command.accept,
        ...(command.promptText !== undefined ? { promptText: command.promptText } : {}),
      })
        .then<BrowserCommandResult>(() => ({
          ok: true,
          elapsedMs: Date.now() - startedAt,
        }))
        .catch<BrowserCommandResult>((error: unknown) => ({
          ok: false,
          error: {
            code: "execution_error",
            message: error instanceof Error ? error.message : String(error),
          },
          elapsedMs: Date.now() - startedAt,
        }));
      // handleDialog 也过 race：取消可能发生在 CDP 调用与结果返回之间。
      const result = await raceBackendExecution(
        execution,
        running.controller.signal,
        command,
        startedAt,
      );
      // 只有 CDP 真的处理了对话框才清缓存；失败时保留 pendingDialogs，留给 detach/closeTab
      // 按 INV-28 统一清理，避免这里提前删掉后页面上仍挂着的对话框再也关不掉。
      if (result.ok) {
        // 只有 result.ok 才清 pendingDialogs，失败时保留给 detach/closeTab 按 INV-28 统一处理。
        this.pendingDialogs.delete(tab.tabId);
      }
      // 对话框结果带 tab 返回，生命周期取 tab 当前值而不是 dialog 类型。
      return this.withMeta(result, context, tab);
    }

    // 截图命令必须在此一次性定性，因为后面的在飞闸门、abandoned 计数与 surface 分支都复用它；
    // 否则各处各自判断 method，口径漂移会让某条路径绕过并发闸门去叠 CDP。
    const screenshotCommand = isScreenshotCommand(command);
    // 截图命令先取在飞 tracker；非截图命令不取，避免普通命令影响截图闸门。
    const previousScreenshot = screenshotCommand
      // 截图命令取 inFlightScreenshots 里的 tracker，普通命令不参与这道闸门。
      ? this.inFlightScreenshots.get(tab.tabId)
      // 非截图命令显式给 undefined，避免复用上一次截图的 tracker 造成误拒。
      : undefined;
    // 只有 tracker 对应的请求仍在 runningRequests 且未 abort 才算真占位；命令已返回但
    // execution 悬空的死槽位不挡新请求，否则该 tab 会秒拒到自己被关闭（INV-23）。
    if (previousScreenshot && this.isInFlightScreenshotAlive(previousScreenshot)) {
      // 日志带 pendingMs：判断是「刚超时」还是「卡了两分钟」只能靠这个差值。
      const elapsedMs = Date.now() - previousScreenshot.startedAt;
      // 拒绝前先打日志：该分支不产生 execution，事后再查不到是哪次请求被挡。
      this.log?.(
        `[browser-use] screenshot rejected tabId=${tab.tabId} requestId=${context.requestId} pendingRequestId=${previousScreenshot.requestId} pendingMs=${elapsedMs}`,
      );
      // 在飞截图未结算时直接拒绝、不排队；并发叠 CDP 会让两条 capture 互相污染。
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "timeout",
            message:
              "A previous screenshot for this browser tab is still completing after timeout. " +
              "Wait before retrying, or reopen the tab if it does not recover.",
            // 拒绝时没有下发新 capture，sideEffect 必须是 none。
            sideEffect: "none",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    // abandoned 计数只对截图读：别的命令不会叠加底层 capture，拿残留计数拒绝会误伤正常调用。
    // 此处读计数只用于并发闸门，因此它不会影响 isTabCaptureActive 的保护判定；两者口径不同，见 D-9-6。
    const abandonedCaptures = screenshotCommand
      // 只对截图读 abandoned 计数；其他命令不叠 capture，读它只会误伤。
      ? (this.abandonedScreenshotCaptures.get(tab.tabId) ?? 0)
      // 非截图命令把计数归零，保证下面的上限判断不会被无关命令触发。
      : 0;
    // 达到硬上限就快速失败：底层 capture 已堆积，再叠加只会让恢复更慢。
    if (screenshotCommand && abandonedCaptures >= MAX_ABANDONED_SCREENSHOT_CAPTURES) {
      // 未结算的底层 capture 已达硬上限：不再叠加新的 pending CDP command，快速失败
      // 并提示重开 tab；旧 capture 落定后名额自动回收，无需人工干预即可恢复。
      this.log?.(
        `[browser-use] screenshot rejected tabId=${tab.tabId} requestId=${context.requestId} abandonedCaptures=${abandonedCaptures}`,
      );
      // 失败提示重开 tab：旧 capture 不会自行回收，继续重试只会累加。
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "timeout",
            message:
              `${abandonedCaptures} previous screenshot captures for this browser tab are still ` +
              "stuck in the backend after timeout. Reopen the tab to recover.",
            sideEffect: "none",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      );
    }
    // 走到这里说明 tracker 已死（命令已返回或被 abort），新请求直接取代它。
    if (previousScreenshot) {
      // 整幅 capture 在隐藏窗口等帧时，30s watchdog 判死但底层 execution 永不
      // settle，tracker 无法清理，该 tab 后续截图全部被 0ms 秒拒直至关 tab（生产日志
      // pendingMs 高达 120s）。命令已返回或已被 abort 的挂起截图视为死条目，
      // 由新请求直接取代；清理以 entry identity 幂等，迟到的 settle 不会误删新请求。
      this.log?.(
        `[browser-use] screenshot superseded stale pending tabId=${tab.tabId} requestId=${context.requestId} pendingRequestId=${previousScreenshot.requestId} pendingMs=${Date.now() - previousScreenshot.startedAt}`,
      );
    }

    // 截图必须先拿 surface lease 再 capture，因此走独立分支；其余命令直接交给页面 executor。
    // 两条路径最终都要过下面的 raceBackendExecution，取消语义才对得上。
    const execution = screenshotCommand
      // 截图分支先拿 surface lease 再 capture，参数里带上 running 供内部标记 dispatched。
      ? this.executeScreenshotWithPreparedSurface(
          context,
          tab,
          guest,
          command,
          running,
          startedAt,
          assertCurrentGuest,
          sendCdpCommand,
        )
      // 非截图命令直接交给 executeBrowserCommandOnView，不经过 surface 协调器。
      : executeBrowserCommandOnView(
          this.toControlledView(
            guest,
            Boolean(tab.viewportOverride || tab.backgroundViewportFallback),
            undefined,
            assertCurrentGuest,
            sendCdpCommand,
          ),
          command,
          { signal: running.controller.signal },
        );
    // 非截图命令没有 surface prepare 阶段，解析完 tab 就可以标记 dispatched。
    // 截图要等 lease 就绪后才标记，避免取消时报“已下发”却又没有任何副作用。
    if (!screenshotCommand) running.dispatched = true;
    // 只有截图需要登记在飞 tracker，因为录制有独立生命周期，普通命令没有可被放弃的底层 capture；
    // 若给普通命令也登记，captureActive 会虚高并拖住 tab 回收。
    if (screenshotCommand) {
      // tracked 必须在 capture 开始前构造，abort 与 watchdog 都靠它定位槽位。
      const tracked: InFlightScreenshot = {
        // execution 与 tracker 一一对应，identity 比较是清理时的唯一依据。
        execution,
        requestId: context.requestId,
        startedAt: Date.now(),
      };
      // tracker 在 capture 开始前登记：这样 abort/deadline 才能找到它并释放槽位。
      // 登记对象包含 requestId，结算时必须按 identity 删除，避免删掉后来者的 tracker。
      this.inFlightScreenshots.set(tab.tabId, tracked);
      // tracker 登记后刷新，captureActive 从这一刻开始为真。
      this.refreshRuntimeProtection(tab.tabId);
      // clearTrackedScreenshot 先比对当前 tracker 是否仍是自己，迟到 settle 不得删后来者。
      const clearTrackedScreenshot = () => {
        // identity 不符直接 return，删除动作对旧 tracker 是空操作。
        if (this.inFlightScreenshots.get(tab.tabId) !== tracked) return;
        // 结算时按 identity 删除：只有当前 tracker 仍是自己才删，防止迟到 settle 删掉
        // 新截图的 tracker。删除后 refreshRuntimeProtection 才会解除 capture 保护。
        // 这里不 abort 底层 capture：CDP 没有取消 API，只能让它自然落定。
        // 若命令仍挂在 runningRequests，删除 tracker 不影响 finally 的 sideEffect 判断。
        // 重复删除是幂等的，watchdog 与正常返回可能各调一次。
        // tab 关闭时由 closeTab 直接 delete，不经过此路径。
        this.inFlightScreenshots.delete(tab.tabId);
        // 删除 tracker 后必须 refreshRuntimeProtection，captureActive 才会真正下降。
        this.refreshRuntimeProtection(tab.tabId);
        // settle 日志带 elapsedMs，用于区分正常落定与 watchdog 清理。
        this.log?.(
          `[browser-use] screenshot backend settled tabId=${tab.tabId} requestId=${context.requestId} elapsedMs=${Date.now() - tracked.startedAt}`,
        );
      };
      // 同时提供 fulfilled/rejected handler，避免仅调用 finally 产生未处理的派生 rejection。
      void execution.then(clearTrackedScreenshot, clearTrackedScreenshot);
    }
    // 第二道 race：settleScreenshotCapture 已按 abort/deadline 收敛 capture 层，这里再包一层
    // 是为了覆盖「结果已产生、请求恰被 abort」的窗口；非截图路径也靠它接入 signal。
    const result = await raceBackendExecution(
      execution,
      running.controller.signal,
      command,
      startedAt,
    );
    // 最终结果统一由 raceBackendExecution 产出，这里只做投影。
    return this.withMeta(result, context, tab);
  }

  /**
   * renderer 的 logical viewport ready 只能证明 CSS 坐标系正确；Windows 负缩放
   * 下 Fit 预览仍可能只有 800×450 raster，CDP 会把它平铺为 1280×720。main 直接读取
   * 已合成的 guest surface，再归一化到逻辑 viewport；这不走曾触发 V8 FATAL 的 renderer
   * `<webview>.capturePage()` 调用，也不改变页面布局、DPR 或交互态 metrics。
   */
  // 截图需要先确保 surface 可见并拿到 lease，否则隐藏窗口截出黑图。lease 的释放必须
  // 放在 finally：异常/取消路径漏释放会让透明窗口永久显示，用户看到闪烁的空白面板。
  // [资源] 同一 tab 只允许一个在飞截图，第二次请求要么复用要么快速失败，不能并发叠 CDP。
  private async executeScreenshotWithPreparedSurface(
    // context 带 window/workspace/session 三元组：prepare 用它做 surface 归属，缺一项会被 coordinator 拒绝。
    context: InternalExecutionContext,
    // tab 与 guest 必须成对传入：截图期间任何一项被替换都要放弃本次。
    tab: ManagedTab,
    // guest 是本函数的唯一操作对象，不能中途从 tab.guest 重取。
    guest: GuestWebContents,
    // command 原样交给 executeBrowserCommandOnView，本函数不解析截图参数。
    command: BrowserCommand,
    // running 提供取消信号与 dispatched 标记，两者都在 capture 前后被读取。
    running: RunningRequest,
    // startedAt 只用于 elapsedMs，跨 await 传值而不是在末尾取时钟。
    startedAt: number,
    // assertCurrentGuest 由调用方绑定代际断言，本函数不自己查 tab.guest。
    assertCurrentGuest: () => void,
    // sendCdpCommand 是已绑定控制的发送器，避免在闭包里重做 toControlledView。
    sendCdpCommand: ControlledView["cdp"]["send"],
  ): Promise<BrowserCommandResult> {
    // lease 必须在 try 外声明：finally 要能释放 prepare 成功但后续失败的 surface。
    let lease: BrowserScreenshotSurfaceLease | undefined;
    try {
      // 只读依赖也要先判空：测试装配可以只注入部分能力，缺省时本函数必须显式失败。
      const screenshotSurfaceCoordinator = this.screenshotSurfaceCoordinator;
      // 显式失败：截图路径不允许偷偷换实现，否则隐藏窗口会截出黑图却报成功。
      if (!screenshotSurfaceCoordinator) {
        // 错误文案固定，日志检索 surface coordinator unavailable 即可定位装配缺失。
        throw new Error("browser screenshot surface coordinator is unavailable");
      }
      // viewport 在进入 viewport 临界区前读取：排队期间若插入 resize，prepare 载荷可能过期，
      // ready 会被 sameBrowserScreenshotViewport 拒绝并拖到 35s 超时。未立缺陷（不收录纯竞态）：
      // 触发需精确并发、后果仅该次截图失败、无状态损坏。
      const viewport = await this.readTabViewport(tab);
      // result 由临界区闭包回填：enqueueViewportMutation 的回调返回 void，无法把 capture 结果
      // 作为返回值带出；下面的 !result 兜住「回调走完却没赋值」的漏分支。
      let result: BrowserCommandResult | undefined;

      // 不能先 acquire activity、再排队 viewport mutation：前序 resize/CDP 卡住时，
      // owner + guest 会在队列外背靠背 capture，最长烧满 35s。surface 准备必须在轮到本次
      // viewport 临界区之后才开始，确保 activity 只覆盖真实 prepare + raster 生命周期。
      await this.enqueueViewportMutation(tab, async () => {
        // prepare 在 viewport 临界区内调用，保证 surface 与本次 viewport 一致。
        lease = await screenshotSurfaceCoordinator.prepare({
          requestId: context.requestId,
          windowId: context.windowId,
          workspaceKey: context.workspaceKey,
          sessionId: context.sessionId,
          browserId: context.browserId,
          browserGeneration: context.browserGeneration,
          tabId: tab.tabId,
          webContentsId: guest.id,
          viewport,
          // 自然 viewport 未安装 metrics；不能让 renderer 的临时 Fit 扩张 guest 布局并触发网页重排。
          viewportMode:
            tab.viewportOverride || tab.backgroundViewportFallback ? "emulated" : "natural",
          signal: running.controller.signal,
        });
        // prepare 期间 guest 可能被换掉：aborted / 换代 / 已销毁 / lease 指向别的 webContents
        // 任一成立都必须放弃，否则会对着旧 guest 的 surface 截图并把结果当成本 tab 的。
        if (
          running.controller.signal.aborted ||
          tab.guest !== guest ||
          guest.isDestroyed() ||
          lease.webContentsId !== guest.id
        ) {
          // 四种失效条件合并成一条 error：调用方只需知道本轮作废，细分原因看 lease.invalidated。
          throw new Error("browser guest changed while preparing screenshot surface");
        }
        // ready 之后、capture 之前 surface 仍可能失效（renderer 切 tab / 缩放），因此必须提前判一次，
        // 避免拿一个已被收回的 surface 去截。
        const invalidationError = readScreenshotSurfaceInvalidation(lease.invalidated);
        // ready 后立即判失效：此时 surface 已被收回就没必要再发 capture。
        if (invalidationError) throw invalidationError;
        // 普通 fallback 也使用临时 responsive surface；idle detach 后先在同一 mutation 内重装 metrics。
        if (
          tab.backgroundViewportFallback &&
          (!guest.debugger.isAttached() || tab.guestCdpRestoreFlight)
        ) {
          // idle detach 后 metrics 可能已丢，所以必须在同一 mutation 内重装，否则下一次 capture 读不到布局。
          await this.sendGuestCdpCommand(
            tab,
            guest,
            "Emulation.setDeviceMetricsOverride",
            buildViewportMetricsOverride(tab.backgroundViewportFallback),
          );
        }
        // 归一化分支做成惰性闭包：只有 capture 真正要读合成 surface 时才调用，普通 CDP 路径
        // 不产生额外的 capturePage。
        const normalizedScreenshot = Boolean(
          tab.viewportOverride || tab.backgroundViewportFallback,
        );
        // Windows 125% 显示缩放 + Desktop 110% 时，renderer 即使上报
        // surfaceScale=1，CDP 仍会把较小的 native raster 周期平铺成目标尺寸。
        // Desktop 放大时的 viewport 截图也读取实际 surface，再统一归一为 CSS px。
        const captureViewportScreenshot =
          normalizedScreenshot &&
          (lease.surfaceScale < 0.999 || (guest.hostWebContents?.getZoomFactor() ?? 1) > 1)
            // 归一化闭包只在真的需要读合成 surface 时才构造，普通 CDP 路径不额外 capturePage。
            ? async (): Promise<string | undefined> => {
                // 归一化能力未注入时直接抛错：返回原图会让模型拿到非 CSS 像素的尺寸。
                if (!this.resizeScreenshotToCssPixels) {
                  throw new Error("browser screenshot CSS pixel normalizer is unavailable");
                }
                // 读合成 surface 而不是 CDP 截图：Windows 缩放下 CDP 会平铺较小的 native raster。
                const surface = await guest.capturePage();
                // toPNG 可能产出空 buffer（surface 尚未合成），空值按「没有截图」返回。
                const surfacePng = surface.toPNG();
                // 空 PNG 返回 undefined，让上层走 backend_unavailable 而不是把 0 字节传给模型。
                if (surfacePng.byteLength === 0) return undefined;
                // 统一归一到逻辑 viewport，渲染尺寸与 CSS 像素解耦。
                return this.resizeScreenshotToCssPixels(surfacePng.toString("base64"), viewport);
              }
            // 不需要归一化时保持 undefined，toControlledView 走原生 CDP 截图。
            : undefined;
        // 截图在真正调用 capture 前才置 dispatched：prepare/lease 阶段取消仍可报 none，
        // 一旦 capture 下发，取消只能报 uncertain。此行位于 await 之前，位置不能后移。
        running.dispatched = true;
        // owner 窗口隐藏（关闭到托盘）后 Windows 合成器不再为 guest 合成任何
        // 帧；prepare 阶段的透明 bootstrap 又在 renderer ready 时提前释放，整幅 capture
        // 只能等用户重新打开窗口才拿得到帧（日志里仅在 tray-show 后约 140ms
        // 完成，其余全部 30s watchdog 判死）。capture 生命周期内临时持有透明 presentation
        // （showInactive + opacity 0，用户不可见）主动要帧；同时 capture 结算必须竞速
        // abort/有界 deadline——悬空的 execution 会把 viewport mutation 队列和 in-flight
        // 槽位一起拖死，mutation 绝不能比请求本身活得更久。
        const capturePresentation = this.startHiddenWindowCapturePresentation(context, guest);
        try {
          // 与 activity pump 同一约束：showInactive 后 Viz surface 建立前同 turn 读回会抛
          // UnknownVizError。先等统一的有界 presentation grace 再发起 capture——归一化
          // 路径（后台 tab）的 guest.capturePage() 对此同样敏感。
          if (
            capturePresentation &&
            !(await waitForDelay(
              TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS,
              running.controller.signal,
            ))
          ) {
            // grace 期间被取消必须抛错：继续 capture 会对着未建立的 Viz surface 取帧。
            throw new Error("browser screenshot capture cancelled during presentation grace");
          }
          // native capture 不经过 sendCdpCommand，也必须等待 idle detach 后的 metrics 恢复。
          if (!guest.debugger.isAttached() || tab.guestCdpRestoreFlight) {
            // native capture 不经过 sendCdpCommand，也必须先补 CDP 连接，否则 metrics 恢复不可见。
            await this.ensureGuestCdpAttached(tab, guest);
          }
          // captureExecution 是裸 promise，不 await 而是交给 settle 竞速取消与 deadline。
          const captureExecution = executeBrowserCommandOnView(
            this.toControlledView(
              guest,
              normalizedScreenshot,
              captureViewportScreenshot,
              assertCurrentGuest,
              sendCdpCommand,
            ),
            command,
            { signal: running.controller.signal },
          );
          // settle 返回的是最终结果，超时/取消时底层 capture 仍在跑，由 abandon 计数兜住。
          result = await this.settleScreenshotCapture(
            captureExecution,
            running.controller.signal,
            context,
            startedAt,
            tab.tabId,
            capturePresentation ? HIDDEN_WINDOW_CAPTURE_DEADLINE_MS : undefined,
          );
        } finally {
          // presentation 独立于 lease 释放：deadline/abort 先结算时也不能让透明窗口继续显示。
          capturePresentation?.release();
        }
        // capture 期间 surface 若被收回（renderer 切走/缩放），这张图可能是黑帧或旧帧，丢弃比
        // 返给模型更安全；此处抛出会走 catch 的 backend_unavailable 分支。
        const lateInvalidationError = readScreenshotSurfaceInvalidation(lease.invalidated);
        // capture 结束后再判一次失效：这时的黑帧或旧帧最容易发生，丢弃比返给模型安全。
        if (lateInvalidationError) throw lateInvalidationError;
      });
      // 回调正常返回却没赋值 result，说明某个分支漏写；抛错比返回 undefined 更早暴露问题。
      if (!result) throw new Error("browser screenshot did not produce a result");
      // result 必填：回调走完却没赋值说明漏了分支，抛错比返回 undefined 更早暴露。
      return result;
    } catch (error) {
      // 取消与装配失败分开报：取消是可重试的，backend_unavailable 需要排查环境。
      const cancelled = running.controller.signal.aborted;
      // 截图是只读命令：即使已下发的 capture 在结算前抛错，报 none 也不会让调用方以为发生了
      // 写操作；这不同于写命令——后者必须由 raceBackendExecution 按 dispatched 报 uncertain。
      return {
        ok: false,
        error: {
          code: cancelled ? "cancelled" : "backend_unavailable",
          message: cancelled
            ? "browser screenshot surface preparation cancelled"
            : error instanceof Error
              ? error.message
              : String(error),
          sideEffect: "none",
        },
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      // lease 释放放在 finally 最外层：任何异常路径都不能让透明 surface 永久驻留。
      lease?.release();
    }
  }

  /** 窗口隐藏时为整幅 capture 建立一次性透明 presentation；窗口可见或能力未注入时为 no-op。 */
  // 隐藏窗口截图需要临时把窗口呈现出来并等待 grace，否则 compositor 还没产出首帧。
  // 这个 bootstrap 只做 presentation，不会改变 tab 的 selected 状态，避免用户看到焦点跳转。
  // [权衡] grace 是经验值：太小会截到黑帧，太大会让“后台截图”明显卡顿。
  private startHiddenWindowCapturePresentation(
    context: InternalExecutionContext,
    guest: GuestWebContents,
  ): TransparentWindowBootstrap | undefined {
    // 能力未注入 / 找不到 owner 窗口时返回 undefined（no-op）：截图不该因为无法呈现窗口就直接
    // 失败，交给下层的 compositor 兜底；bootstrap 返回 false 也归一为 undefined，调用方只认
    // 「有没有 presentation」，不区分「不需要」和「建不出来」。
    if (!this.resolveOwnerWindow) return undefined;
    const win = this.resolveOwnerWindow(context.windowId);
    if (!win) return undefined;
    return (
      startBrowserScreenshotTransparentWindowBootstrap({
        win,
        enabled: true,
        windowId: context.windowId,
        webContentsId: guest.id,
        requestId: context.requestId,
        hideTaskbarDuringBootstrap: process.platform === "win32",
        log: this.log,
      }) || undefined
    );
  }

  /**
   * capture 结算的统一出口：execution、请求 abort、可选的有界 deadline 三者先到先结算。
   * 隐藏窗口等帧、上游 30s cancelRequest 等场景下 execution 可能永不落定；不等它，
   * 保证 viewport mutation 队列和 in-flight 槽位随请求一起释放。abort/deadline 先胜时
   * 底层 CDP command 仍在 Chromium 内 pending，计入 abandonedScreenshotCaptures 硬上限。
   */
  // 截图结算必须按 entry identity 清理：超时后新截图可能已占用同一 tabId，按 tabId
  // 盲删会把新截图的 tracker 删掉，导致新的 capture 永远悬空。
  // [失败路径] 底层 capture 仍可能成功返回，但命令早已超时；这里只丢弃结果，不能让
  // 迟到的 PNG 覆盖更新的截图。
  private async settleScreenshotCapture(
    // execution 是已下发的 promise，不能取消，只能等它结算或主动放弃等待。
    execution: Promise<BrowserCommandResult>,
    // signal 控制提前收口：一旦 abort 就返回 cancelled，底层由 abandonBackendCapture 记账。
    signal: AbortSignal,
    // context 只用于日志关联，不参与结算判断。
    context: InternalExecutionContext,
    // startedAt 跨 await 传入，保证 elapsedMs 包含排队与 prepare 时间。
    startedAt: number,
    // tabId 用于 abandon 记账，必须与发起 capture 的 tab 一致。
    tabId: string,
    // deadlineMs 只在隐藏窗口路径出现，undefined 表示不设本地超时。
    deadlineMs?: number,
  ): Promise<BrowserCommandResult> {
    // Promise 内不 reject：所有失败都转成 BrowserCommandResult，调用方只需看 ok。
    return await new Promise<BrowserCommandResult>((resolve) => {
      // settled 先置位再清理：abort 与 execution 同时到达时只有一方能触发 finish，
      // 后续的 abandonBackendCapture 也只会记一次名额。
      let settled = false;
      // finish 返回布尔值，让调用方知道这次结算是否由自己触发，从而决定是否 abandon。
      const finish = (result: BrowserCommandResult): boolean => {
        // 幂等守卫：abort 与 execution 同时到达时只有先到者生效。
        if (settled) return false;
        // settled 先置位，后续所有路径都读它，保证 finish 只执行一次。
        settled = true;
        // timer 可能尚未创建（无 deadline），清之前必须判 undefined。
        if (timer !== undefined) clearTimeout(timer);
        // 摘掉 abort 监听，避免 promise 结算后仍持有闭包。
        signal.removeEventListener("abort", onAbort);
        // resolve 放在清理之后：监听与 timer 都清干净再唤醒调用方。
        resolve(result);
        // 返回 true 表示本次 finish 有效，调用方据此记账。
        return true;
      };
      // 只有本次真的结算成 cancelled 才记 abandoned：若 execution 已抢先结算，底层 capture
      // 已落定，再计数会让名额永远回不到 0。
      const onAbort = () => {
        // 只有 finish 真的成功才记 abandoned，否则名额会被重复扣减。
        if (
          finish({
            ok: false,
            error: {
              code: "cancelled",
              message: "browser screenshot capture cancelled",
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          })
        ) {
          // abandon 只登记「已放弃等待、底层仍在跑」的 capture，不会取消 native 命令。
          this.abandonBackendCapture(tabId, execution);
        }
      };
      // deadline 只在隐藏窗口路径传入（capturePresentation 存在时）；可见窗口仍由上游 30s
      // cancelRequest 约束，这里不重复设表。
      const timer =
        deadlineMs !== undefined
          // deadline 用 setTimeout 而不是 race：需要在日志里区分超时与执行失败。
          ? setTimeout(() => {
              // 超时日志带 requestId/windowId/deadlineMs，三个字段足以定位一次后台截图。
              this.log?.(
                `[browser-use] hidden window capture deadline exceeded requestId=${context.requestId} windowId=${context.windowId} deadlineMs=${deadlineMs}`,
              );
              // 超时同样只在 finish 成功时记账，避免与 abort 重复。
              if (
                finish({
                  ok: false,
                  error: {
                    code: "timeout",
                    message: `browser screenshot capture timed out after ${deadlineMs}ms while the window was hidden`,
                    sideEffect: "none",
                  },
                  elapsedMs: Date.now() - startedAt,
                })
              ) {
                // abandon 后底层 capture 仍可能完成，其结果由它自己的 then 丢弃。
                this.abandonBackendCapture(tabId, execution);
              }
            }, deadlineMs)
          : undefined;
      // 先挂监听再查 aborted：反过来会在两步之间漏掉一次 abort，execution 一直悬空到上游
      // watchdog 才收口。
      signal.addEventListener("abort", onAbort, { once: true });
      // 先挂监听再查 aborted：两步之间若发生 abort，addEventListener 会立即补发。
      if (signal.aborted) {
        // 已取消时同步走 onAbort，再 return，不再注册 execution 回调。
        onAbort();
        // 提前返回，避免下面再挂 execution 的 then，造成同一 promise 双结算。
        return;
      }
      // rejection 分支也必须 finish：漏掉它会让 execution 的失败永远不结算，
      // viewport mutation 队列与 in-flight 槽位一起卡死。
      // 这里不 catch 而是用 then 的第二参数：确保 rejection 也走同一条结算路径。
      execution.then(finish, (error: unknown) =>
        // 错误对象转成文本进 message，保留原始信息但不把 Error 实例透给 IPC。
        finish({
          ok: false,
          error: {
            code: "execution_error",
            message: error instanceof Error ? error.message : String(error),
          },
          elapsedMs: Date.now() - startedAt,
        }),
      );
    });
  }

  /** 记一笔“已放弃等待但底层仍在执行”的 capture；真实落定后名额自动回收。 */
  // 为什么单独登记“已放弃但未结算”的 capture：watchdog 先返回后，底层 CDP command
  // 仍在 Chromium 里 pending；若不计数，下一张截图会继续叠加，compositor 恢复时几十个
  // capture 同时排空，内存峰值会击穿主进程。
  // 达到 MAX_ABANDONED_SCREENSHOT_CAPTURES 后同 tab 快速失败并提示重开 tab，这是唯一
  // 不会把“慢”变成“崩”的降级路径。
  private abandonBackendCapture(tabId: string, execution: Promise<BrowserCommandResult>): void {
    // 每次放弃等待都必须 +1，即使计数已超上限：只有这样才能在真实落定后逐次递减，否则计数永远回不到 0，tab 后续截图全部快速失败。
    // map 删条由 release 负责，不在超限分支里提前清。
    // 此处只登记「已放弃但未结算」的名额供并发闸门限流；保护判定不会读到它，保护链在此断开（D-9-6）。
    this.abandonedScreenshotCaptures.set(
      tabId,
      (this.abandonedScreenshotCaptures.get(tabId) ?? 0) + 1,
    );
    execution.then(
      () => this.releaseAbandonedBackendCapture(tabId),
      () => this.releaseAbandonedBackendCapture(tabId),
    );
  }

  // 计数必须与 tracker 一一对应：只在 capture 真实落定或 tab 关闭时递减，不能在命令
  // 超时时就减，否则上限形同虚设。
  // tab 关闭时由 closeTab 直接删除计数（abandonedScreenshotCaptures.delete，原 3749 行），不等 capture 落定，与 2384 行说明一致；
  // 旧 capture 迟到结算时 release 读到 undefined 直接返回。本条原句「保留到落定」与两者矛盾，按实际行为改写（D-9-3）。
  private releaseAbandonedBackendCapture(tabId: string): void {
    const count = this.abandonedScreenshotCaptures.get(tabId);
    if (count === undefined) return;
    // 计数降到 0 才删 key：提前删会让下一次 abandoned +1 重新从 1 开始，
    // 上限判断失效。count<=1 时本次递减后必为 0，所以在此删除。
    // 删除与 tracker 清理相互独立：tracker 可能已被新截图替换，计数仍要正确递减。
    // tab 关闭时也会直接 delete（不等落定），避免 manager 持有已关闭 tab 的计数。
    // 该 map 只增删不重排，诊断计数直接取 size 即可。
    // 上限判断读取的是 get ?? 0，key 不存在等价于 0。
    if (count <= 1) this.abandonedScreenshotCaptures.delete(tabId);
    else this.abandonedScreenshotCaptures.set(tabId, count - 1);
  }

  // 注入时钟而不是直接 Date.now，是为了让录制进度/超时在测试里可控。
  // 生产路径必须与 residencyOptions.now 使用同一来源，否则同一事件在两个模块得到
  // 不同时间戳，排序与过期判断会互相打架。
  private recordingNow(): number {
    return this.residencyOptions.recording?.now?.() ?? Date.now();
  }

  /**
   * 挂起截图是否仍存活：对应命令还在执行中（runningRequests 里有未 abort 的条目）。
   * 条目已消失说明命令早已返回（典型为 30s watchdog 判死）而 execution 悬空——死槽位。
   */
  // 不能只看 promise 是否 settled：命令可能已被 watchdog 判死（从 runningRequests 移除）
  // 而 execution 仍 pending，这种槽位应视为“可回收”，允许新截图替换。
  // 判定必须包含 requestId 相等，避免旧请求的 tracker 挡住新请求。
  private isInFlightScreenshotAlive(tracked: InFlightScreenshot): boolean {
    const running = this.runningRequests.get(tracked.requestId);
    return running !== undefined && !running.controller.signal.aborted;
  }

  // 创建即登记，确保 recordingStart 返回后立刻能用 id 查询/取消；若等异步 run 完成
  // 再登记，用户在这段窗口期无法取消。
  // controller 独立于请求 signal：请求结束不代表录制结束；但 tab 关闭/turn 结束会显式 abort。
  // id 加 `iab-recording:` 前缀而不复用 requestId：录制是跨请求的长生命周期对象，复用请求 id
  // 会让 recordingStatus 与 INV-08 的去重键撞语义。
  // context 必须整体快照：recordingStatus/recordingCancel 用 entry.context 做 sameScope 比对，
  // 若持有 tab.owner 引用，claim/finalize 整体替换 owner 后旧 scope 再也查不到自己的录制。
  // status 与 phase 必须分开维护：只有 status 的终态不可逆，phase 只影响展示；混用会让已取消的录制仍显示为进行中。
  private createRecordingEntry(
    context: InternalExecutionContext,
    tab: ManagedTab,
  ): BrowserRecordingEntry {
    const now = this.recordingNow();
    return {
      id: `iab-recording:${randomUUID()}`,
      context: { ...context },
      tabId: tab.tabId,
      controller: new AbortController(),
      status: "running",
      phase: "preparing",
      progress: 0,
      startedAt: now,
      updatedAt: now,
    };
  }

  // 返回副本而不是 entry 引用：renderer 会序列化它，暴露内部 controller/cleanupTimer
  // 会让结构化克隆失败，也泄漏可变状态。
  // 进度按当前时钟重算，不能缓存 snapshot，否则轮询会看到冻结的进度条。
  // artifact/error 用条件展开而不是显式 undefined：结构化克隆保留值为 undefined 的键，
  // 条件展开让「从未有错误」与「错误已清空」在 renderer 侧同形，避免 UI 显示空错误条。
  private snapshotRecording(entry: BrowserRecordingEntry): BrowserRecordingJob {
    return {
      id: entry.id,
      status: entry.status,
      phase: entry.phase,
      progress: entry.progress,
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt,
      ...(entry.artifact ? { artifact: { ...entry.artifact } } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };
  }

  // 终态后禁止再改 phase：runRecording 的 finally 可能晚于 cancel，若覆盖回 capturing，
  // UI 会显示一个已取消的录制仍在进行。
  // phase 只做展示、不参与取消判定，因此这里不触发额外的资源清理。
  // progress 只给 0.1 / 0.9 两个锚点：MediaRecorder 不暴露真实取景进度，若按时间插值，用户会
  // 误以为录制线性推进，因此这里只在终态才把 progress 置 1。
  private setRecordingPhase(
    entry: BrowserRecordingEntry,
    phase: Extract<BrowserRecordingJob["phase"], "capturing" | "finalizing">,
  ): void {
    if (entry.status !== "running") return;
    entry.phase = phase;
    entry.progress = phase === "capturing" ? 0.1 : 0.9;
    entry.updatedAt = this.recordingNow();
    this.refreshRuntimeProtection(entry.tabId);
  }

  // 终态幂等：completed/failed/cancelled 只允许第一次写入，后续调用直接返回，避免
  // cleanupTimer 被重复挂（重复 setTimeout 会让同一文件被删两次并扰乱测试时钟）。
  // 挂 timer 时先 unref，防止残留的 1 小时计时器阻止进程退出。
  // 幂等的实际守卫在调用方：abortRecordings / recordingCancel / runRecording 的 catch 都先判
  // status==="running"，本函数只保证 cleanupTimer 单挂（INV-25 的守卫分布在两处）。
  // 新增调用点若不判 status，会把已写下的 cancelled 覆盖成 failed/completed，snapshot 随即自相矛盾。
  private setRecordingTerminal(
    entry: BrowserRecordingEntry,
    status: Extract<BrowserRecordingJob["status"], "completed" | "failed" | "cancelled">,
    error?: string,
  ): void {
    entry.status = status;
    entry.phase = status;
    entry.progress = status === "completed" ? 1 : entry.progress;
    entry.updatedAt = this.recordingNow();
    if (error) entry.error = error;
    else delete entry.error;
    if (!entry.cleanupTimer) {
      entry.cleanupTimer = setTimeout(() => {
        // TTL 到期后同时移出 map 与删除 artifact；entry 已处于终态，删除不会影响正在
        // 进行的录制。若文件删除失败，只 warn，不能把已完成的录制改判为失败。
        // 先删 map 再删文件：即使 rm 卡住，查询也不会再返回过期路径。
        // 删除只针对本 entry 的 artifact，不影响共享 tmp 目录中的其它文件。
        // 重复进入终态已由 setRecordingTerminal 挡住，这里不会重复挂 timer。
        // 清理后 recordingStatus 返回 not_found，调用方应提示结果已过期。
        this.recordings.delete(entry.id);
        if (entry.artifact?.path) {
          void rm(entry.artifact.path, { force: true }).catch(() => undefined);
        }
      }, RECORDING_RESULT_TTL_MS);
      entry.cleanupTimer.unref?.();
    }
    this.refreshRuntimeProtection(entry.tabId);
  }

  // 取消录制只能 abort controller，不能直接删 entry：runRecording 还需要把 status 写回
  // cancelled 并保存已录到的部分 artifact。
  // 按 tabId 过滤时也要处理 tab 已删除的情况，否则关 tab 后录制会继续写文件。
  // 顺序必须是先 abort 再写终态：反过来 runRecording 的 catch 会先看到 running，把本次取消记成 failed。
  // 上面「由 runRecording 写回 status 并保存部分 artifact」与实现不符：状态在本函数同步落定，
  // runRecording 的 catch 因 status 已非 running 直接返回，半成品也由 recordBrowserVideo 主动删除（D-9-8）。
  private abortRecordings(
    predicate: (entry: BrowserRecordingEntry) => boolean,
    reason: string,
  ): void {
    for (const entry of this.recordings.values()) {
      if (entry.status !== "running" || !predicate(entry)) continue;
      entry.controller.abort(new DOMException(reason, "AbortError"));
      this.setRecordingTerminal(entry, "cancelled");
    }
  }

  // 录制的失败必须落成 failed 终态而不是抛出：recordingStart 早已返回，unhandled
  // rejection 会变成主进程告警，且 UI 永远停在 preparing。
  // 每个关键节点都要检查 signal.aborted，因为软件编码很慢，用户可能中途取消。
  // 结束时恢复 viewport 与光标 overlay，漏掉会让页面永久保持录制布局。
  // try 必须从第一次可能改到 tab 状态的位置开始，否则 viewport 改写、surface 租约、超时表、
  // 光标这四条清理会有一条落空：任何一步失败都要走同一段收尾，分开写必然漏。
  private async runRecording(
    entry: BrowserRecordingEntry,
    tab: ManagedTab,
    rawOptions?: BrowserRecordingOptions,
  ): Promise<void> {
    // signal 取 entry.controller：录制取消只有这一个入口，不接外部 AbortSignal。
    const signal = entry.controller.signal;
    // rawOptions 缺省空对象，下面每个字段各自取默认值，不能解构后统一兜底。
    const options = rawOptions ?? {};
    // viewport 缺省 DEFAULT_AGENT_BROWSER_VIEWPORT；录制必须固定尺寸才能稳定输出分辨率。
    const viewport = options.viewport ?? DEFAULT_AGENT_BROWSER_VIEWPORT;
    // fps 缺省 25，再高只会放大编码压力，不增加可用帧。
    const fps = options.fps ?? 25;
    // maxDurationMs 只约束页面取景，编码收尾不受它限制。
    const maxDurationMs = options.maxDurationMs ?? 60_000;
    // settleMs 缺省 300ms，等首帧稳定后再执行动作，避免录进白屏。
    const settleMs = options.settleMs ?? 300;
    assertViewportOverride(viewport);
    // 上面两行与 ensureGuest 放在 try 之外，因为失败时还没改过 tab 状态，因此不需要回滚，
    // 这样也能避免 finally 对「从未离开原尺寸」的 tab 再下发一次 setTabViewport。

    const guest = await this.ensureGuest(tab, signal);
    // ensureGuest 返回 null 或 guest 已销毁都视为不可用；只判 null 会让死 guest 进入录制。
    if (!guest || guest.isDestroyed()) throw new Error("browser guest unavailable for recording");
    // 录制会临时改写 tab viewport override 去换取 100% surface；先记下录制前的值。
    const previousViewport = tab.viewportOverride ? { ...tab.viewportOverride } : undefined;
    // lease 在 try 外声明，finally 才看得到并释放；只在 try 内声明会泄漏 surface。
    let lease: BrowserScreenshotSurfaceLease | undefined;
    // timeout 同样在 try 外声明，异常路径也必须 clearTimeout。
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // 先改 tab override 再 prepare surface：surface 按 tab 当前 viewport 建，顺序反了会拿到旧尺寸。
      await this.setTabViewport(tab, viewport);
      // 只改 CDP metrics 不会同步 renderer 中承载 WebView 的自由尺寸 frame；自定义录制
      // viewport 会继续使用旧 DOM bounds，最终要么 prepare 超时，要么从缩小表面放大而变模糊。
      this.onViewportChanged?.(viewport, tab.owner, tab.tabId);
      // coordinator 可能未注入，缺它必须显式失败，不能录出空帧。
      const coordinator = this.screenshotSurfaceCoordinator;
      // 缺少 coordinator 时抛错而不是降级：录制没有无 surface 的备用路径。
      if (!coordinator) throw new Error("browser recording surface coordinator is unavailable");
      lease = await coordinator.prepare({
        requestId: `recording:${entry.id}`,
        windowId: entry.context.windowId,
        workspaceKey: entry.context.workspaceKey,
        sessionId: entry.context.sessionId,
        browserId: entry.context.browserId,
        browserGeneration: entry.context.browserGeneration,
        tabId: tab.tabId,
        webContentsId: guest.id,
        viewport,
        surfaceScaleMode: "unscaled",
        signal,
        activityTimeoutMs: maxDurationMs + 30_000,
      });
      // 租约必须属于当前 guest；prepare 期间重绑会让录制拍到另一个页面。
      if (!lease || lease.webContentsId !== guest.id) {
        // lease 的 webContentsId 与 guest 不一致即判失败，不做二次 prepare。
        throw new Error("browser guest changed while preparing recording surface");
      }
      // prepare 后立刻读 invalidated：surface 可能在建好前就已失效。
      const invalidationError = readScreenshotSurfaceInvalidation(lease.invalidated);
      // 失效原因非空就中止；继续录只会拿到黑帧。
      if (invalidationError) throw invalidationError;
      // 失效回调把 lease 的 reason 原样转给 controller，保留窗口隐藏等真实原因。
      const invalidateRecording = () =>
        entry.controller.abort(
          lease?.invalidated?.reason instanceof Error
            ? lease.invalidated.reason
            : new Error("browser recording surface invalidated"),
        );
      lease.invalidated?.addEventListener("abort", invalidateRecording, { once: true });
      // 只绑一次：surface 被判失效（窗口隐藏、尺寸被回收）后必须立刻中止整段录制，
      // 继续拍只会拿到黑帧或已销毁表面的内容；once 也让失效信号不会反复中止同一个 controller。
      // 超时的起算点是 surface 就绪之后，不含 prepare 耗时；prepare 那段由
      // activityTimeoutMs = maxDurationMs + 30s 单独兜底，两段预算分开才不会互相吞掉。
      timeout = setTimeout(
        () =>
          // 超时用 TimeoutError，runRecording 的调用方据此判 failed 而不是 cancelled。
          entry.controller.abort(new DOMException("browser recording timed out", "TimeoutError")),
        maxDurationMs,
      );
      // 记代际用于 assertCurrentGuest；引用相同但代际变化说明 guest 已被重建。
      const guestGeneration = tab.guestGeneration;
      // detaching 必须先于对象/代际比对：该阶段 tab.guest 可能还没替换，只比引用会放行一个
      // 正在被 teardown 的 guest，录制随后在已 detach 的 CDP 会话上失败。
      const assertCurrentGuest = (): void => {
        // detaching 先判：该阶段 tab.guest 可能还未替换，只比引用会放行正在拆的会话。
        if (tab.guestLifecycle === "detaching") {
          // 正在 detach 时抛错，避免在已关闭的 CDP 会话上继续录制。
          throw new Error("browser guest is detaching");
        }
        if (
          tab.guest !== guest ||
          tab.guestGeneration !== guestGeneration ||
          safeBool(() => guest.isDestroyed(), true)
        ) {
          // 换代后抛错，录制不能带着旧 guest 继续。
          throw new Error("browser guest changed before recording dispatch");
        }
      };
      // view 绑定 assertCurrentGuest 与 sendGuestCdpCommand，录制内部每个 CDP 都过同一道校验。
      const view = this.toControlledView(
        guest,
        true,
        undefined,
        assertCurrentGuest,
        (method, params, sessionId) =>
          this.sendGuestCdpCommand(tab, guest, method, params, sessionId, assertCurrentGuest),
      );
      // 光标 overlay 只在录制开始注入一次，导航后不会自动重注入（见 D-9-7）。
      if (options.showCursor !== false) await this.installRecordingCursorOverlay(guest);
      // createRecorder 由装配注入，缺它说明 WebM 录制能力未启用。
      const createRecorder = this.residencyOptions.recording?.createRecorder;
      if (!createRecorder) throw new Error("browser WebM recorder is unavailable");
      // 半成品的删除归 recordBrowserVideo 一家：它比这里清楚文件为何不可用，两层都 rm 会
      // 把真实失败原因盖成「文件不存在」。
      entry.artifact = await recordBrowserVideo({
        targetFrame: guest.mainFrame,
        tempRoot: this.residencyOptions.recording?.tempRoot ?? tmpdir(),
        recordingId: entry.id.replace(/[^A-Za-z0-9._-]/gu, "-"),
        viewport,
        fps,
        signal,
        onPhase: (phase) => this.setRecordingPhase(entry, phase),
        onCaptureComplete: () => {
          // maxDurationMs 只约束页面取景；编码是收尾阶段，不能把一段已完整拍下的视频误杀掉。
          // 代价是编码阶段再无超时兜底：recorder.stop() 卡住时 entry 会停在 running，只能靠
          // 调用方 cancel（closeTab / turnEnd / disposeAll）收场，这是换取「不误杀成片」的让步。
          if (timeout) {
            clearTimeout(timeout);
            timeout = undefined;
          }
          lease?.release();
        },
        executeScenario: async () => {
          // settle 等的是首帧稳定：页面刚 load 完 compositor 还在补帧，立刻执行动作会录进白屏。
          if (settleMs > 0 && !(await waitForDelay(settleMs, signal))) throw abortError();
          await this.executeRecordingActions(view, options.actions ?? [], signal, viewport);
        },
        createRecorder,
      });
      // 只有 recordBrowserVideo 正常返回（文件已 flush 且非空）才算 completed；写在
      // executeScenario 之后会把「动作跑完但编码失败」误记为成功。
      this.setRecordingTerminal(entry, "completed");
    } finally {
      // 四步顺序不能换：停表 → 摘光标 → 还原 viewport → 释放 surface。各自的漏做后果是：
      // 表不清会打断编码、光标不摘会留在页面上、viewport 不还原会把录制尺寸留给后续截图、
      // surface 先释放则后面的 setTabViewport 落在已换比例的画面上。
      if (timeout) clearTimeout(timeout);
      // 只在 showCursor 时移除；没注入过却调用 remove 会多执行一次脚本。
      if (options.showCursor !== false) await this.removeRecordingCursorOverlay(guest);
      // lease.release() 只收回瞬时 surface 比例，tab 自己的 viewport override 会
      // 留在录制尺寸上，之后的预览与截图都按录制 viewport 走。录制是临时借用，必须还原。
      await this.restoreRecordingViewport(tab, previousViewport).catch(() => undefined);
      // release 放最后：前面的 viewport 还原仍需要 surface 保持当前比例。
      lease?.release();
    }
  }

  /** 把录制期间临时改写的 tab viewport 交还给录制前的状态。 */
  // 录制期间会临时放大 viewport 以保证输出分辨率；结束必须恢复用户/Agent 的原设置，
  // 不能调用 reset，否则会丢掉显式 override。
  // 恢复失败只记录 warn：录制结果已经可用，不能因为 viewport 报错把它判失败。
  // closed 直接返回：此时 guest 可能正在 teardown，再下发 viewport 会与 detach 抢同一个 CDP
  // 会话，而还原只影响视觉，丢弃不影响正确性。
  // previous 为空走 reset 而不是 set 默认尺寸：要区分「从未设置 override」与「显式设成默认值」，
  // 后者一旦 reset 就把用户的显式选择抹掉了。
  private async restoreRecordingViewport(
    tab: ManagedTab,
    previous: BrowserViewportSize | undefined,
  ): Promise<void> {
    if (tab.lifecycle === "closed") return;
    if (previous) {
      await this.setTabViewport(tab, previous);
      this.onViewportChanged?.(previous, tab.owner, tab.tabId);
      return;
    }
    await this.resetTabViewport(tab);
    this.onViewportChanged?.(null, tab.owner, tab.tabId);
  }

  // 动作按顺序串行执行：录制脚本表达的是“先点这里再输入”，并行会打乱页面状态。
  // executeRecordingActions 给每个动作独立超时，避免一个卡死的选择器拖垮整段录制。
  // pointer 初值必须取视口中心而不是 (0,0)：move/hover 的动画从上一位置起算，从左上角起算
  // 会让首个动作的光标从屏幕角落飞入，看起来像误操作，因此不能留成零值。
  private async executeRecordingActions(
    view: ControlledView,
    actions: BrowserRecordingAction[],
    signal: AbortSignal,
    viewport: BrowserViewportSize,
  ): Promise<void> {
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 };
    for (const action of actions) {
      if (signal.aborted) throw abortError();
      await this.executeRecordingAction(view, action, signal, pointer);
      const delayAfterMs = "delayAfterMs" in action ? action.delayAfterMs : undefined;
      if (delayAfterMs && !(await waitForDelay(delayAfterMs, signal))) throw abortError();
    }
  }

  // 这里只做参数归一化与分发，真正的页面操作复用 executeRecordingBrowserCommand，保证录制路径与普通命令共享同一套 CDP 代际校验。
  // 未知 action 必须报错而不是跳过，否则录制会静默丢步骤，用户拿到缺帧的视频。
  // click 的 selector 与坐标二选一，缺坐标必须抛错：静默取 (undefined,undefined) 会点到页面
  // 左上角，产出「点了但没生效」的视频，因此不能降级成跳过。
  // waitFor 的 timeoutMs 可调（上限 30s），click/type 固定 3s，因为点不到就是脚本与页面不符；
  // 给更长时间只会让整段录制卡在同一个选择器上，因此不能放宽。
  // cancelled 与 timeout 必须分开处理：取消要落成 cancelled 终态，超时必须落成 failed，
  // 混用会让用户主动取消的录制在结果里显示为失败。
  private async executeRecordingAction(
    // view 是当前录制命中的 ControlledView，action 的所有坐标都相对它，不能换成 tab.guest 重算。
    view: ControlledView,
    // action 已通过 schema 校验，这里不再复检字段形状，只按 type 分流。
    action: BrowserRecordingAction,
    // signal 由录制 controller 持有，waitForDelay 与每个 CDP 动作都要透传它。
    signal: AbortSignal,
    pointer: { x: number; y: number },
  ): Promise<void> {
    // wait 分支不产生 CDP 动作，pointer 保持原值。
    if (action.type === "wait") {
      // wait 分支必须能被打断：waitForDelay 返回 false 说明 signal 已 abort，抛 abortError 才能落 cancelled 终态。
      if (!(await waitForDelay(action.durationMs, signal))) throw abortError();
      // wait 不移动 pointer，提前 return 让后续 action 仍从上一个落点起算。
      return;
    }
    // click/type/waitFor 共用 locator 路径，其余动作类型不得进入这段。
    if (action.type === "click" || action.type === "type" || action.type === "waitFor") {
      // locatorAction 为 undefined 只发生在没有 selector 的 click。
      const locatorAction =
        action.type === "click"
          // 有 selector 时构造 locator，双击映射成 dblclick 而不是两次 click。
          ? action.selector
            // click 有 selector 时构造 locator 分支，operation 取 dblclick 由 doubleClick 决定。
            ? {
                name: "locator" as const,
                selector: action.selector,
                // operation 按 doubleClick 选择；两次 click 会漏掉浏览器识别的双击间隔。
                operation: action.doubleClick ? ("dblclick" as const) : ("click" as const),
                ...(action.button ? { button: action.button } : {}),
              }
            // 无 selector 的 click 落到坐标分支，这里不传空 selector 给 Playwright。
            : undefined
          // type 没有坐标回退路径，无 selector 时下一步必然抛错。
          : action.type === "type"
            // type 分支没有坐标回退：selector 缺失时仍构造 locator，由下面统一报错。
            ? {
                name: "locator" as const,
                selector: action.selector,
                operation: "fill" as const,
                // value 必须原样传 action.text，否则页面会把转义字符当成输入。
                value: action.text,
              }
            // waitFor 分支取 state，缺省 visible 由 schema 语义保证。
            : {
                name: "locator" as const,
                selector: action.selector,
                operation: "waitFor" as const,
                // waitFor 缺省 visible；要等消失必须显式传 state。
                state: action.state ?? "visible",
              };
      // 有 locator 就只走 Playwright，不再落到坐标点击，避免同一动作执行两次。
      if (locatorAction) {
        // locatorAction 一旦存在就只走 executeIabPlaywrightLocator，坐标分支被完全跳过。
        const result = await executeIabPlaywrightLocator(
          view,
          locatorAction,
          // waitFor 可用 action.timeoutMs，click/type 固定 3s，防止整段录制卡在同一选择器。
          action.type === "waitFor" ? (action.timeoutMs ?? 3_000) : 3_000,
          signal,
        );
        // cancelled 抛 abortError 而不是普通 Error，录制终态才能落 cancelled。
        if (result.kind === "cancelled") throw abortError();
        // timeout 必须抛普通 Error，否则录制终态会被记成 cancelled。
        if (result.kind === "timeout")
          // timeout 抛普通 Error 而非 abortError，否则录制终态会被记成 cancelled。
          throw new Error(`recording action timed out: ${result.reason}`);
        // locator 成功后直接 return，pointer 保持原值：locator 路径不维护轨迹。
        return;
      }
      // 没有 selector 的 type/waitFor 直接报错，它们没有坐标回退。
      if (action.type !== "click") {
        // 只有 click 允许无 selector，type/waitFor 走到这里说明 schema 与执行器约定不一致。
        throw new Error(`recording ${action.type} requires a selector`);
      }
      // click 既无 selector 又缺坐标时报错，不能静默跳过。
      if (typeof action.x !== "number" || typeof action.y !== "number") {
        // 坐标 click 必须同时有 x 与 y，typeof 判断保证 0 坐标也合法。
        throw new Error("recording click requires selector or (x,y)");
      }
      // 坐标 click 走 executeRecordingBrowserCommand，与普通命令共用取消与超时。
      await this.executeRecordingBrowserCommand(view, {
        method: "click",
        x: action.x,
        y: action.y,
        ...(action.button ? { button: action.button } : {}),
        ...(action.doubleClick !== undefined ? { doubleClick: action.doubleClick } : {}),
      });
      // click 后把 pointer 移到落点，后续 hover/move 从这里起算。
      pointer.x = action.x;
      // 坐标 click 后同步 pointer.x，后续 hover/move 才从真实落点起算。
      pointer.y = action.y;
      // pointer.y 与 pointer.x 成对更新，少写一个会让轨迹斜跳。
      return;
    }
    // hover 优先 selector，其次坐标，两者都没有才报错。
    if (action.type === "hover") {
      // hover 有 selector 时先经 resolveRecordingSelectorPoint 求元素中心。
      if (action.selector) {
        // selector hover 先算元素中心，直接 move 到 (0,0) 会录成错误轨迹。
        const point = await this.resolveRecordingSelectorPoint(view, action.selector, signal);
        // moveRecordingPointer 负责插值与取消，hover 不能直接发 mouseMoved。
        await this.moveRecordingPointer(
          view,
          point.x,
          point.y,
          action.durationMs ?? 0,
          signal,
          pointer,
        );
      // 坐标 0 是合法值，因此用 typeof 判断而不是真值判断。
      } else if (typeof action.x === "number" && typeof action.y === "number") {
        // 坐标 hover 复用同一插值函数，durationMs 缺省 0 表示瞬移。
        await this.moveRecordingPointer(
          view,
          action.x,
          action.y,
          action.durationMs ?? 0,
          signal,
          pointer,
        );
      } else {
        // hover 缺 selector 与坐标时报错，不能退化成一次 move。
        throw new Error("recording hover requires selector or (x,y)");
      }
      // hover 两个分支都 return，落到 else 只剩「缺参」一种情况。
      return;
    }
    // move 必须走 moveRecordingPointer，直接发 CDP 不会更新 pointer 轨迹。
    if (action.type === "move") {
      // move 动作必须更新 pointer 轨迹，直接发 CDP 会让下一次动作从错误原点起算。
      await this.moveRecordingPointer(
        view,
        action.x,
        action.y,
        action.durationMs ?? 0,
        signal,
        pointer,
      );
      // move 完成后 return，避免继续落到 scroll 分支。
      return;
    }
    // scroll 是相对滚动，deltaY 必须传，deltaX 可缺省为 0。
    if (action.type === "scroll") {
      // scroll 是相对位移：deltaY 必填由 schema 保证，deltaX 缺省必须补 0。
      await this.animateRecordingScroll(
        view,
        action.deltaX ?? 0,
        action.deltaY,
        action.durationMs ?? 0,
        signal,
      );
      // scroll 不改 pointer，滚轮与光标位置是两个独立状态。
      return;
    }
    // scrollTo 先读当前滚动位置再算差值，目标可能只给一个轴。
    if (action.type === "scrollTo") {
      // 读滚动位置用 executeJavaScript，不依赖 DOM 域已启用。
      const current = (await view.webContents.executeJavaScript(
        "({ x: window.scrollX, y: window.scrollY })",
      )) as { x?: unknown; y?: unknown };
      // 有 selector 时目标是元素位置；否则用 action.x/y 覆盖单个轴，另一轴保持当前值。
      const target = action.selector
        // scrollTo 有 selector 时目标由 resolveRecordingSelectorScrollTarget 求元素位置。
        ? await this.resolveRecordingSelectorScrollTarget(view, action.selector, signal)
        // Number(current.x ?? 0) 兜底：页面刚导航时 scrollX 可能不是数字。
        : { x: action.x ?? Number(current.x ?? 0), y: action.y ?? Number(current.y ?? 0) };
      // animateRecordingScroll 接收的是差值，这里必须用 target 减 current 换算。
      await this.animateRecordingScroll(
        view,
        // animateRecordingScroll 收的是差值而不是绝对坐标，传绝对值会滚到错误位置。
        target.x - Number(current.x ?? 0),
        target.y - Number(current.y ?? 0),
        action.durationMs ?? 0,
        signal,
      );
      // scrollTo 完成后 return，wheel 分支处理的是重复滚动而不是绝对定位。
      return;
    }
    // wheel 按 times 重复滚动，每轮之间可插 intervalMs。
    if (action.type === "wheel") {
      // times 缺省 1；传 0 时循环不执行，动作视为已完成。
      const times = action.times ?? 1;
      // 每轮独立下发 scroll，不合并成一次大 delta，否则会丢失中间帧。
      for (let index = 0; index < times; index += 1) {
        // wheel 每轮单独下发 scroll，合并成一次 delta 会丢中间帧。
        await this.executeRecordingBrowserCommand(view, {
          method: "scroll",
          x: action.deltaX ?? 0,
          y: action.deltaY,
        });
        // intervalMs 为 0 时不等待；等待被取消必须抛 abortError。
        if (action.intervalMs && !(await waitForDelay(action.intervalMs, signal)))
          // intervalMs 为真才等待，等待被 abort 时抛 abortError 终止整段录制。
          throw abortError();
      }
      // wheel 循环结束直接 return，drag 分支只接受 path。
      return;
    }
    // drag 用原始 CDP 事件，因为需要按下—移动—抬起的精确顺序。
    if (action.type === "drag") {
      // steps 至少 1：path 只有一个点时只发 move/press/release，不做插值。
      const steps = Math.max(1, action.path.length - 1);
      // 每步间隔由总时长均分，Math.floor 保证总耗时不超出 durationMs。
      const intervalMs = Math.floor((action.durationMs ?? 0) / steps);
      // 先把鼠标移到起点再按下，否则 press 会落在上一个 pointer 位置。
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: action.path[0]!.x,
        y: action.path[0]!.y,
      });
      // 按下必须带 clickCount:1 与 button:left，缺一项页面拿不到完整 click 序列。
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: action.path[0]!.x,
        y: action.path[0]!.y,
        button: "left",
        clickCount: 1,
      });
      // 从第二个点开始插值；起点已经 move 过，重复会多一帧。
      for (const point of action.path.slice(1)) {
        // 拖拽中的 move 必须带 buttons:1，否则页面认为鼠标已松开。
        await view.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: point.x,
          y: point.y,
          button: "left",
          buttons: 1,
        });
        // 每步之间必须等待，取消时立即中止以避免留下半程拖拽。
        if (intervalMs > 0 && !(await waitForDelay(intervalMs, signal))) throw abortError();
      }
      // path 至少一个点由 schema 保证，at(-1) 即终点。
      const last = action.path.at(-1)!;
      // 抬起必须用终点坐标，否则 drop 落在错误元素上。
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: last.x,
        y: last.y,
        button: "left",
        clickCount: 1,
      });
      // 拖拽结束更新 pointer，后续动作从终点继续。
      pointer.x = last.x;
      // drag 结束把 pointer 落到终点，与 press 前从起点移动形成闭环。
      pointer.y = last.y;
    }
  }

  // 录制内部命令不经过 runningRequests：它们不是 IPC 请求，abort 由录制 controller
  // 统一控制。必须使用 tab 当前的 guest，并在派发前断言未换代，否则录制会操作到重绑后的新页面，产出与用户预期不符的视频。
  // 失败必须抛而不是返回 result：录制脚本没有「部分成功」语义，在错误页面上继续执行，
  // 会让产出的视频比中止更糟。
  private async executeRecordingBrowserCommand(
    view: ControlledView,
    command: BrowserCommand,
  ): Promise<void> {
    const result = await executeBrowserCommandOnView(view, command);
    if (!result.ok)
      throw new Error(result.error?.message ?? `recording action ${command.method} failed`);
  }

  // 光标动画需要屏幕坐标；resolveRecordingSelectorPoint 拿不到元素时直接抛错，整段录制会随之中止，
  // 不是「跳过动画」：签名非空且调用点直接取 point.x，抛错是这条失败路径的既定结果（D-9-2）。
  // 用 bounding box 中心而不是点击点：高亮要覆盖元素，偏移会让用户误以为点错了位置。
  // 3s 探测预算必须与 click 保持一致，否则会出现「光标已停在元素上、点击却已超时」的错位画面。
  private async resolveRecordingSelectorPoint(
    view: ControlledView,
    selector: string,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const result = await executeIabPlaywrightLocator(
      view,
      {
        name: "locator",
        selector,
        operation: "evaluate",
        expressionKind: "function",
        expression:
          "(element) => { const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }",
      },
      3_000,
      signal,
    );
    if (result.kind !== "done" || !isBrowserPointValue(result.value)) {
      throw new Error(`recording selector '${selector}' has no visible point`);
    }
    return result.value;
  }

  // 滚动动画需要知道容器/页面可滚动距离，取不到时回退到窗口滚动，不能抛错。
  // resolveRecordingSelectorScrollTarget 的计算只用于视觉，不改变真实滚动结果，所以精度要求低于命令本身。
  // 但「不能抛错」没有做到：解析失败会直接 throw，把整段录制中止，与 resolveRecordingSelectorPoint
  // 同一条失败路径（D-9-2）；上面那句按意图保留，不按现状改写。
  private async resolveRecordingSelectorScrollTarget(
    view: ControlledView,
    selector: string,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const result = await executeIabPlaywrightLocator(
      view,
      {
        name: "locator",
        selector,
        operation: "evaluate",
        expressionKind: "function",
        expression:
          "(element) => { const rect = element.getBoundingClientRect(); return { x: window.scrollX + rect.left, y: window.scrollY + rect.top }; }",
      },
      3_000,
      signal,
    );
    if (result.kind !== "done" || !isBrowserPointValue(result.value)) {
      throw new Error(`recording selector '${selector}' has no scroll target`);
    }
    return result.value;
  }

  // 指针动画是纯装饰，任何异常都必须吞掉：它不能影响真实点击是否成功。
  // 动画期间要检查 signal，否则取消录制后指针还在页面上移动。
  // 帧数必须封顶 60，否则长 duration 按 16ms 逐帧发时一次 move 就是上千条 CDP；
  // 那会压住主进程，也会让后续动作排不进时间轴，因此不能按真实时长展开帧序列。
  private async moveRecordingPointer(
    // view 提供 cdp.send：插值帧必须经它下发，不走 executeBrowserCommandOnView。
    view: ControlledView,
    // x 是目标横坐标，pointer 最终会被写成这个值。
    x: number,
    // y 与 x 必须同时给出，单轴移动没有对应动作类型。
    y: number,
    // durationMs 为 0 时 steps 仍为 1，保证至少有一帧 mouseMoved。
    durationMs: number,
    // signal 在每帧与每段等待前检查，取消要立即停在中途。
    signal: AbortSignal,
    pointer: { x: number; y: number },
  ): Promise<void> {
    // steps 钳在 1..60：60 帧约等于 1 秒 60Hz，再多没有视觉收益。
    const steps = Math.max(1, Math.min(60, Math.round(durationMs / 16)));
    // startX 取 pointer.x 作为插值起点，录制轨迹必须连续。
    const startX = pointer.x;
    // startY 与 startX 同源，二者共同构成这一段的起点。
    const startY = pointer.y;
    // index 从 1 开始，第 0 帧就是起点本身，重复下发会多一帧抖动。
    for (let index = 1; index <= steps; index += 1) {
      // 每帧先判 signal.aborted，取消不能被下一帧的 await 吞掉。
      if (signal.aborted) throw abortError();
      // progress 归一化到 (0,1]，最后一帧正好落在目标坐标。
      const progress = index / steps;
      // Input.dispatchMouseEvent 的 mouseMoved 是唯一会更新页面 hover 态的事件。
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: startX + (x - startX) * progress,
        y: startY + (y - startY) * progress,
      });
      // durationMs 均分到每帧，index===steps 时不再等待，末帧无需延迟。
      if (durationMs > 0 && index < steps && !(await waitForDelay(durationMs / steps, signal))) {
        // waitForDelay 返回 false 表示取消，抛 abortError 让上层落 cancelled。
        throw abortError();
      }
    }
    // 循环结束后 pointer.x 对齐目标，舍入误差不会累积到下一次移动。
    pointer.x = x;
    // pointer.y 同步落位，指针状态必须与最后一帧一致。
    pointer.y = y;
  }

  // overlay 用 fixed 定位 + 高 z-index，必须注入到当前 document；导航会丢 overlay，
  // 所以每次动作前都要确保它存在。注入失败只 warn：没有光标动画仍可完成录制。
  // 这两句与实现的出入必须当场指路：本函数只在 runRecording 开头调用一次，页面导航后随 document
  // 消失且不会重注入；注入也没有 try/catch，失败会把整段录制判 failed（见 D-9-7）。
  private async installRecordingCursorOverlay(guest: GuestWebContents): Promise<void> {
    await guest.executeJavaScript(`(() => {
      const id = "__zcode_browser_recording_cursor";
      document.getElementById(id)?.remove();
      const cursor = document.createElement("div");
      cursor.id = id;
      cursor.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;border-radius:50%;background:#ff4d4f;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45);pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);opacity:0;transition:opacity 80ms linear";
      document.documentElement.appendChild(cursor);
      const move = (event) => {
        cursor.style.left = event.clientX + "px";
        cursor.style.top = event.clientY + "px";
        cursor.style.opacity = "1";
      };
      const down = () => {
        cursor.style.transform = "translate(-50%,-50%) scale(.72)";
      };
      const up = () => {
        cursor.style.transform = "translate(-50%,-50%) scale(1)";
      };
      window["__zcodeBrowserRecordingCursorCleanup"]?.();
      window.addEventListener("mousemove", move, true);
      window.addEventListener("mousedown", down, true);
      window.addEventListener("mouseup", up, true);
      window["__zcodeBrowserRecordingCursorCleanup"] = () => {
        window.removeEventListener("mousemove", move, true);
        window.removeEventListener("mousedown", down, true);
        window.removeEventListener("mouseup", up, true);
        cursor.remove();
        delete window["__zcodeBrowserRecordingCursorCleanup"];
      };
    })()`);
  }

  // 移除必须幂等：导航后旧 document 已销毁，executeJavaScript 会 reject，不能因此
  // 把录制判失败。只删自己插入的节点 id，不能清理页面其它元素。
  private async removeRecordingCursorOverlay(guest: GuestWebContents): Promise<void> {
    if (guest.isDestroyed()) return;
    await guest
      .executeJavaScript('window["__zcodeBrowserRecordingCursorCleanup"]?.()')
      .catch(() => undefined);
  }

  // 滚动动画用 rAF/定时器推进，必须响应 abort，否则用户取消后页面还在动。
  // 动画结束后以真实 scrollTo 收敛，避免中途被页面自身滚动打断后停在半路。
  // 步数同样封顶 60：滚动是逐条 CDP 位移，步数等于 duration/16 会让长动画自己把录制拖超时；
  // 最后一帧不再等 delay，否则动画结束还要多睡一个 step 才收敛。
  private async animateRecordingScroll(
    view: ControlledView,
    deltaX: number,
    deltaY: number,
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const steps = Math.max(1, Math.min(60, Math.round(durationMs / 16)));
    for (let index = 0; index < steps; index += 1) {
      await this.executeRecordingBrowserCommand(view, {
        method: "scroll",
        x: deltaX / steps,
        y: deltaY / steps,
      });
      if (
        durationMs > 0 &&
        index + 1 < steps &&
        !(await waitForDelay(durationMs / steps, signal))
      ) {
        throw abortError();
      }
    }
  }

  // 解析顺序是 tabId → active tab → default tab，任一环节都必须经过 sameScope。
  // 指定了不存在的 tabId 必须报错而不是回退到 active：静默回退会让命令操作错页面，
  // 这比失败更糟。解析成功后立即把 tabId 写入 running，供 abort 与资源保护使用。
  // [并发] 解析是同步的，不能 await guest/attach，否则取消与解析之间会产生竞态，
  // 命令可能在取消后仍拿到 tab。
  private resolveTab(
    context: InternalExecutionContext,
    explicitTabId?: string,
  ): ManagedTab | undefined {
    if (explicitTabId) {
      // 显式 tabId 是授权边界：查不到、已关闭、跨 scope 一律返回 undefined，不能回退到 active，
      // 否则调用方的越权/拼写错误会被静默改写成「操作另一个页面」。
      const explicit = this.tabs.get(explicitTabId);
      if (!explicit || explicit.lifecycle === "closed" || !sameScope(explicit.owner, context)) {
        return undefined;
      }
      return explicit;
    }
    const key = scopeKey(context);
    // 索引可能陈旧：close/release 只清指向自己的条目，并行切换还会覆盖 key，因此读路径必须
    // 重新校验 lifecycle 与 owner；这里不顺手清理索引，避免并发读在遍历中修改 map。
    const activeId = this.activeTabByScope.get(key);
    const active = activeId ? this.tabs.get(activeId) : undefined;
    if (active && active.lifecycle !== "closed" && sameScope(active.owner, context)) return active;
    const defaultId = this.defaultTabByScope.get(key);
    const existingDefault = defaultId ? this.tabs.get(defaultId) : undefined;
    if (
      existingDefault &&
      existingDefault.lifecycle !== "closed" &&
      sameScope(existingDefault.owner, context)
    ) {
      return existingDefault;
    }
    // 后台会话（renderer 只上报 active:false）且 tab 由显式 newTab 创建时，activeTabByScope 与
    // defaultTabByScope 都是空的。这里必须复用该 scope 最近存活的 tab，否则不带 tabId 的命令会
    // 凭空再开一个空 tab，也会让 tabs.list() 报的 active 与实际落点不一致。
    // 回退顺序固定为 active → default → 最近存活：recent 只保证「同 scope 还有 tab」，不代表
    // 被选中过，放在最后才不会让一个从未激活的 tab 抢走命令落点。
    const recent = this.ownedTabs(context).at(-1);
    if (recent) return recent;
    // legacy 用 sessionId 作 tabId，让旧 renderer 的隐式单 tab 稳定复用一个身份；结构化上下文
    // 每次都生成新 UUID，避免并发命令共用同一 tabId。但墓碑不会随创建清除，关闭后重建的这个
    // id 会被 attachGuest 判成 closed，见 D-9-9。
    return this.createTab(context, context.legacy ? context.sessionId : undefined, true);
  }

  // 新 tab 的 owner 继承调用上下文，但 tabId 由 main 生成，不能信任 renderer 提供。
  // 创建后立即写 registry 并报告 residency，否则并发命令可能在写入前用 tabId 查不到。
  // [资源] origin=agent 的 tab 受预算限制，超限必须走 closeTabForLimit 而不是无限创建。
  private createTab(
    context: InternalExecutionContext,
    preferredTabId?: string,
    makeDefault = false,
  ): ManagedTab {
    const tabId = preferredTabId ?? `iab-tab:${randomUUID()}`;
    const existing = this.tabs.get(tabId);
    if (existing && existing.lifecycle !== "closed" && sameScope(existing.owner, context)) {
      return existing;
    }
    // 同一 tabId 的旧条目（已关闭）直接被覆盖，但 closedTabIds 里的墓碑不清：legacy 复用
    // sessionId 作 tabId 时，新 tab 会被自己的墓碑拦住 attach，见 D-9-9。
    const tab: ManagedTab = {
      tabId,
      owner: { ...context },
      cdpAttached: false,
      guestLifecycle: "detached",
      pendingCdpCommands: 0,
      guestGeneration: 0,
      hasAttachedGuest: false,
      rebindRequested: false,
      lifecycle: "active",
      origin: "agent",
      claimable: false,
      active: false,
      loading: false,
      mediaActive: false,
      cachedUrl: "",
      cachedTitle: "",
      cachedFaviconUrl: null,
      openedAt: this.now(),
      // 模型创建路径（显式 newTab 与无 tab 时的隐式创建）默认使用桌面自由尺寸。
      // viewport 属于 tab 创建事实；claim、activate、navigate 只复用已有 tab，不能再次套默认值。
      viewportOverride: { ...DEFAULT_AGENT_BROWSER_VIEWPORT },
    };
    this.tabs.set(tabId, tab);
    // 先入 registry 再报 residency：反序会让并发命令在登记前用 tabId 查不到 tab。
    this.registerTabResidency(tab, false);
    // shell 落盘不 await：写盘失败只 warn，创建路径不能因为磁盘问题阻塞；代价是进程在落盘前
    // 退出会丢掉这一个 tab 的 shell。
    void this.persistShell(tab);
    if (makeDefault) this.defaultTabByScope.set(scopeKey(context), tabId);
    return tab;
  }

  // 这是所有需要 guest 的命令入口，必须复用同一 flight：同一 tab 的并发命令若各自
  // 等待 renderer 新建 webview，会产生多个 guest 抢同一个 tabId。
  // 先等 suspend/restore flight 收敛，再判断 guest 是否可用；顺序反了会拿到即将销毁的 guest。
  // [失败路径] 超时返回 null，由调用方决定是否 closeTab；这里不主动关闭，避免误杀
  // 仍在恢复的 tab。
  private async ensureGuest(
    // tab 由调用方传入而不是按 tabId 反查：命令派发时已解析过 scope，重查会放大 TOCTOU 窗口。
    tab: ManagedTab,
    // signal 只取消本调用方的等待，底层 flight 会继续跑，下一个调用方仍能复用同一 promise。
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    // 入口先判 aborted：信号可能在上游入队前就已取消，此时不能创建任何 flight。
    if (signal.aborted) return null;
    // suspend flight 未收敛时不能看 guest：挂起中的 guest 可能已被 renderer 卸载。
    const suspendFlight = this.suspendFlights.get(tab.tabId);
    // 等 suspend 必须只看 completed：suspend 不产出 guest，所以这段只为确认旧 guest 已收口。
    if (suspendFlight) {
      // 保护状态只能取消 coordinator generation，不能立刻证明 renderer 未卸载。
      // Browser command 必须等待 snapshot/ack/必要恢复收敛，不能复用即将销毁的旧 guest。
      const settled = await waitForPromiseWithSignal(suspendFlight, signal);
      // 等待被取消返回 null，与超时同路径，调用方统一报 cancelled。
      if (!settled.completed) return null;
    }
    // residency 是唯一可信的挂起状态来源，tab 上的 guest 字段可能是旧代残留。
    const residency = this.residencyCoordinator.get(tab.tabId);
    // suspended/restoring 的 tab 没有可用 guest，必须先走恢复流程；直接等 attach 会永远
    // 等不到（renderer 不会为挂起的 tab 重建 webview）。
    // 恢复失败返回 null，由调用方报 backend_unavailable 而不是让命令挂起。
    if (residency?.residency === "suspended" || residency?.residency === "restoring") {
      // suspended/restoring 必须先走 restore：renderer 不会为挂起 tab 重建 webview，直接等 attach 会挂到超时。
      return await this.restoreSuspendedGuest(tab, signal);
    }
    // guest 存活时只等恢复完成，不再建新 flight，避免两个 guest 抢同一 tabId。
    if (tab.guest && !safeBool(() => tab.guest!.isDestroyed(), true)) {
      // 恢复结果可能是 null（重绑失败），这里不吞掉，交给调用方报 backend_unavailable。
      return await this.waitForGuestRecovery(tab, tab.guest, signal);
    }
    // 已销毁的 guest 必须先 detach 再建 flight，否则 runGuestAttachFlight 会直接返回死对象。
    if (tab.guest) {
      // detach 是同步的：必须先摘掉已销毁 guest 再建 flight，否则 runGuestAttachFlight 会直接
      // 返回这个死对象；中间若留 await，另一个命令就会复用到它。
      this.detachGuest(tab);
    }

    // 已有 flight 必须复用：并发命令各自建一个会让 renderer 收到多次 openTab 请求（INV-06）。
    const existingFlight = this.guestAttachFlights.get(tab.tabId);
    // existingFlight 只是快照，可能已被 clearFlight 删除，所以下面必须按 identity 再比较一次。
    let flight = existingFlight;
    // 只有没有在飞 flight 时才创建：这是单飞保护的实际入口。
    if (!flight) {
      // runGuestAttachFlight 内部不再去重，单飞完全由这里的 set 保证。
      flight = this.runGuestAttachFlight(tab);
      // attach flight 只允许一个：并发 ensureGuest 共享同一 Promise，防止 renderer 被
      // 要求创建多个 webview 抢同一 tabId。finally 中必须比较 identity 再删。
      this.guestAttachFlights.set(tab.tabId, flight);
      // clearFlight 必须按 identity 删除，否则迟到的旧 flight 会清掉新一轮登记的条目。
      const clearFlight = () => {
        // 比较 promise 本身而不是 tabId：换代后 tabId 不变但 flight 已换。
        if (this.guestAttachFlights.get(tab.tabId) === flight) {
          // finally 中按 identity 清除：旧 flight 完成时新 flight 可能已登记，盲删会让
          // 新 flight 失去单飞保护，导致并发命令各自创建 webview。
          // 清除后下一次 ensureGuest 才会创建新 flight；在此之前都会复用当前 Promise。
          // flight resolve 的 guest 可能已被替换，调用方仍要校验 tab.guest 是否一致。
          // 清除是同步的，避免 await 间隙被新命令看到旧 flight。
          // 若 attach 抛错，flight 仍会 settle，清除逻辑不受影响。
          this.guestAttachFlights.delete(tab.tabId);
        }
      };
      // 成功失败都挂同一个清理：flight reject 时残留条目会让后续命令永远复用一个已失败的 promise。
      void flight.then(clearFlight, clearFlight);
    }
    // 等 flight 同样受 signal 控制，取消只影响本调用方，不会取消底层 flight。
    const settled = await waitForPromiseWithSignal(flight, signal);
    // completed=false 是取消，value 为空是 attach 失败；两者都返回 null。
    if (!settled.completed || !settled.value) return null;
    // attach 成功后还要等 CDP 恢复：guest 存在不代表调试会话已可用（INV-29）。
    return await this.waitForGuestRecovery(tab, settled.value, signal);
  }

  // 恢复 flight 是 tab 级屏障；命令必须 await 它，否则会在 recovery 尚未应用 pageState
  // 时就执行，导致“命令跑在 about:blank 上”。
  // 这里不接受 signal 取消：取消单个命令不应中断 tab 的恢复，恢复属于 tab 生命周期。
  private async waitForGuestRecovery(
    tab: ManagedTab,
    guest: GuestWebContents,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    const flight = this.guestRecoveryFlights.get(tab.tabId);
    if (!flight) return guest;
    const settled = await waitForPromiseWithSignal(flight, signal);
    // 必须比对 identity：恢复 flight 期间 guest 可能已经换代，只判 completed 会把新 guest
    // 当成旧 guest 交给调用方，后续 CDP 全部打在错误的会话上。
    return settled.completed && settled.value === guest ? guest : null;
  }

  // 整个 attach 流程放进 flight：ready 事件可能因 renderer 重试而来多次，flight 保证
  // 只创建一个 guest，其余调用共享结果。
  // flight 必须在 finally 删除，且删除前比较 map 中的 Promise 是否仍是自己，避免
  // 旧 flight 的 finally 删掉新 flight。
  private async runGuestAttachFlight(tab: ManagedTab): Promise<GuestWebContents | null> {
    // 新 tab 的首次 ready 仍只等待一次；已有 guest 或已明确收到拒绝时允许一次有界重放。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (tab.lifecycle === "closed") return null;
      // create/ready 是可重放状态；事件丢失或 guest 崩溃后发起一次有界重放。
      // 如果 destroyed/mismatch 已经发起过重绑，沿用该请求，避免同一 tab 重复创建 webview。
      if (!tab.rebindRequested) this.onOpenTabRequested?.(tab.tabId, tab.owner);
      // 某些测试/旧 renderer 会在 Ready 回调内同步 attach；不能在 attach 已成功后再注册 waiter。
      // Bug 原因：guest 是可变字段，进入回调后 TypeScript 会撤销属性收窄；固定本轮引用，
      // 同时保证销毁检查与返回的是同一个 guest。
      const attachedGuest = tab.guest;
      if (attachedGuest && !safeBool(() => attachedGuest.isDestroyed(), true)) {
        return attachedGuest;
      }
      const guest = await this.waitForGuest(tab.tabId);
      if (guest && !safeBool(() => guest.isDestroyed(), true)) return guest;
      if (attempt === 0 && !tab.hasAttachedGuest && !tab.attachFailure) return null;
      if (attempt === 1) return null;
      // 只有「曾经 attach 成功过」或「已知失败原因」才重放：新 tab 的第一次等待超时说明
      // renderer 还没处理 create request，此时重放只会不断重建 webview。
      this.requestGuestRebind(tab, tab.attachFailure ?? "attach-timeout");
    }
    return null;
  }

  // ownedTabs 是 scope 过滤的唯一实现：所有“列出可见 tab”的路径都必须走它，否则
  // openTabs/list/查重会各自实现一套过滤，漏掉 window 或 remoteSession 造成越权。
  // 不返回 closed tab：tombstone 只用于拒绝迟到 attach，不应出现在 UI 列表。
  // 返回顺序是 Map 插入序，不做排序：需要「最近」的调用方必须自己 .at(-1)，不能假定它有序。
  private ownedTabs(context: InternalExecutionContext): ManagedTab[] {
    return [...this.tabs.values()].filter(
      (tab) => tab.lifecycle !== "closed" && sameScope(tab.owner, context),
    );
  }

  // “可认领”必须同时满足 origin=user、claimable、未被 agent 占用，且同 window/workspace/session。
  // remoteSessionId 用严格相等：本地会话不能认领远程会话留下的页面，反之亦然。
  // 已经 claimed 的 tab 不允许换 owner，否则两个对话会同时操作同一页面。
  // 这里用 ownedBySession 而不是 sameScope：user tab 的 browserId/generation 本来就与 agent
  // 不同，换成 sameScope 会让 claim 永远失败；代际隔离由 claim 之后的 owner 改写负责。
  private canClaimUserTab(tab: ManagedTab, context: InternalExecutionContext): boolean {
    return (
      tab.origin === "user" &&
      tab.claimable &&
      tab.lifecycle !== "closed" &&
      ownedBySession(tab.owner, context)
    );
  }

  // 给模型/用户展示“当前窗口真实打开的用户页面”。这里必须用 ownedTabs 而不是全局
  // 遍历，否则会把别的窗口、别的项目的标签暴露给当前对话。
  // 结果按 openedAt 排序，保证列表稳定，避免每次调用顺序变化干扰模型判断。
  // 实现上只比较 active，组内顺序靠 sort 的稳定性维持插入序；恢复的 tab 插入晚但 openedAt 早，
  // 此时顺序与 openedAt 并不一致，因此不能拿它推断真实新近度。
  private openUserTabs(context: InternalExecutionContext): ManagedTab[] {
    return [...this.tabs.values()]
      .filter((tab) => this.canClaimUserTab(tab, context) && this.hasDiscoverableUserPage(tab))
      .sort((left, right) => Number(right.active) - Number(left.active));
  }

  // openTabs 里是否还有可认领页面，决定是“claim 已有 tab”还是“新建 tab”。
  // 这里排除 agent tab 与已关闭 tab：把 agent 自己的页面算进来会让模型误以为用户已经打开了目标站点，从而跳过新建，最终操作到错误页面。
  private hasDiscoverableUserPage(tab: ManagedTab): boolean {
    const url = tab.guest
      ? safeStr(() => tab.guest!.getURL(), tab.cachedUrl).trim()
      : tab.cachedUrl.trim();
    // 已 mount 的 human webview 在首次导航前会以 about:blank/空 URL ready。
    // 这只是 UI 占位态，不是可供 agent 认领的用户页面；受控 tabs.list() 不受此过滤影响。
    return url.length > 0 && url !== "about:blank";
  }

  // claim 是“把用户 tab 移交给当前对话”的唯一入口，必须原子完成 owner 改写与
  // userOwner 备份：finalize 时靠 userOwner 把它还原成用户 tab。
  // 认领后立即 selectTab(tab, true)：未激活的 tab 不产帧，截图会等不到 surface。
  // [事务] 同一 tab 只能被 claim 一次，重复 claim 直接返回已有结果。
  // 不满足条件时返回原 tab 而不是抛错：claim 通常「先查后取」两段调用，重复进入必须幂等，
  // 抛错会让第二个调用方在无错场景下中断。
  private claimTab(tab: ManagedTab, context: InternalExecutionContext): ManagedTab {
    if (!this.canClaimUserTab(tab, context)) return tab;
    tab.owner = { ...context };
    tab.claimable = false;
    // claim 只接管所有权，不改激活态；未激活的
    // human tab webview 不产帧，被 claim 后截图的 prepare 握手 3s 超时（renderer ready
    // 永不到来）。claim 即激活：与 activateTab 相同的 selectTab(tab, true) 语义——前台
    // scope 展开对应 view，后台 scope 只记录激活态，不抢用户当前会话焦点。
    this.selectTab(tab, true);
    this.log?.(
      `[browser-use] claim human tab tabId=${tab.tabId} windowId=${context.windowId} sessionId=${context.sessionId}`,
    );
    return tab;
  }

  // selectTab 同时维护 active 标志与 activeTabByScope 索引，二者必须一起改。
  // notifyRenderer=false 用于内部切换（如 closeTab 选下一个），避免在关闭流程里再发
  // 一次选中通知造成 UI 闪烁。只有 agent tab 才写索引；user tab 的可见性由用户控制。
  // 本方法直接采信 tab.owner、不校验调用方身份，因此越权防线必须在 resolveTab / canClaimUserTab，
  // 任何新调用点都必须先过那两道，否则可以直接改写别的 scope 的 active。
  private selectTab(tab: ManagedTab, notifyRenderer: boolean): void {
    const key = scopeKey(tab.owner);
    // 同一 browser scope 最多只能有一个 active tab；旧 attach 路径只把新 tab 设为 active，
    // 没有清掉旧 tab.active，导致 tabs.list() 可能同时返回多个 active=true。
    for (const candidate of this.tabs.values()) {
      if (!sameScope(candidate.owner, tab.owner)) continue;
      candidate.active = candidate.tabId === tab.tabId;
      // 未选中的候选也必须上报 selected:false：漏报会让上一个 active 继续自报选中，
      // coordinator 据此认为它有帧，LRU 会把它排在保护名单里。
      this.residencyCoordinator.report(candidate.tabId, {
        selected: candidate.tabId === tab.tabId,
      });
    }
    // active 索引必须与 tab.active 同步写：只写一个会让 list 与命令落点不一致。
    // 同一 scope 的旧 active 在循环里已置 false，这里只写新值。
    this.activeTabByScope.set(key, tab.tabId);
    if (!notifyRenderer) return;
    this.visibilityByScope.set(key, true);
    this.onVisibilityChanged?.(true, tab.owner, tab.tabId);
    // activateTab / claim 都以 selectTab(tab, true) 收口；attach 路径走 notifyRenderer=false
    // 且已自行调用恢复，不会重复。
    this.maybeRestoreBackgroundViewport(tab);
  }

  // finalize/session 结束时把 claimed user tab 还原为 user tab，而不是关闭它：
  // 用户手动打开的页面不能因为对话结束而消失。
  // 有 userOwner 时必须恢复 owner/claimable，并清掉 agent 设置的后台 viewport，
  // 否则用户接手后会看到一个 800×600 的页面。
  // 上面这句里的 viewport 清理并没有在本函数发生：复位被交给 readTabViewport / selectTab 的
  // INV-22 自愈路径，release 只改归属、不会主动清 viewport，见 D-9-10。
  private releaseToUser(tab: ManagedTab): void {
    if (tab.claimable) return;
    if (!tab.userOwner) {
      // requestId 必须新生成：INV-08 要求它在 runningRequests 生命周期内唯一，复用 claim 时的
      // 请求 id 会让后续同名请求被判成重复。
      tab.userOwner = {
        ...tab.owner,
        requestId: `unclaimed:${randomUUID()}`,
        // 释放后必须脱离原 controlled browser scope，否则同 session 的 tabs.list() 仍会把
        // user tab 当作受控 tab；sessionId/workspaceKey 保留，供 owner session 显式重新 claim。
        browserId: "unclaimed-iab",
        browserGeneration: 0,
        turnId: undefined,
      };
    }
    const claimedScope = scopeKey(tab.owner);
    // 释放时必须摘掉 activeTabByScope：留着会让同 scope 的读路径仍把这个 user tab 当成受控 active。
    if (this.activeTabByScope.get(claimedScope) === tab.tabId) {
      this.activeTabByScope.delete(claimedScope);
    }
    // defaultTabByScope 同样要摘：默认索引指向已释放的 tab 后，attach 回退会落到一个不可认领的页面。
    if (this.defaultTabByScope.get(claimedScope) === tab.tabId) {
      this.defaultTabByScope.delete(claimedScope);
    }
    tab.owner = { ...tab.userOwner };
    tab.origin = "user";
    tab.claimable = true;
    // 必须回到 active：handoff/deliverable 是 turn 级状态，留着会让交还后的 tab 在下一轮
    // attach/resize 时被当成仍在收尾的 tab 拒绝。
    tab.lifecycle = "active";
  }

  // turn/会话结束时按 origin 分流：agent tab 关闭，user tab 交还。
  // 先复制快照再遍历，因为 closeTab 会修改 tabs map，直接迭代会跳过元素。
  // [失败路径] 单个 tab 关闭失败只记录 warn，不能中断其它 tab 的收尾。
  private finalizeTabs(
    context: InternalExecutionContext,
    keep: Map<string, "handoff" | "deliverable">,
  ): void {
    // 产品语义：IAB tab 在当前 ZCode 进程内默认持久。keep 是状态标记集合，不是清理白名单；
    // 遗漏的 tab 不能当成临时页关闭：模型未显式 close 时用户页面会在 turn end 消失。
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      const status = keep.get(tab.tabId);
      if (status === "handoff") tab.lifecycle = status;
      else if (status === "deliverable") {
        tab.lifecycle = status;
        this.releaseToUser(tab);
      }
    }
  }

  /**
   * tabs.list() 里 active 的唯一判定。语义是「不带 tabId 的命令会落到哪个 tab」，与 resolveTab
   * 对齐，而不是「UI 当前是否可见」——可见性有独立的 browserVisibilitySet/Get 通道。
   *
   * 必须带回退：会话在后台跑时 renderer 的 isVisible 恒为 false，只会上报
   * attachGuest({active:false})，scope 内没有任何 tab 自报 active，activeTabByScope 也是空的。
   * CLI 的 turn-end 自动截图用 tabs.find(t => t.active === true) 寻址且没有回退，于是静默跳过，
   * 用户侧表现为后台会话结束时没有截图。回退到该 scope 最近存活的 tab（与 browserVisibilitySet
   * 和 CLI 侧 tabs.selected() 的 at(-1) 回退一致）后，list 报的 active 与命令落点重新一致。
   */
  // activeTabByScope 可能指向已关闭/已释放的 tab，这里做二次校验并回退到 default。
  // 不在此处清理索引：清理应由 close/release 负责，读路径只做无副作用的降级，
  // 否则并发读会在遍历中改 map，导致迭代行为不确定。
  private effectiveActiveTabId(owner: InternalExecutionContext): string | undefined {
    const key = scopeKey(owner);
    const activeId = this.activeTabByScope.get(key);
    const activeTab = activeId ? this.tabs.get(activeId) : undefined;
    if (activeTab && activeTab.lifecycle !== "closed") return activeId;
    // human tab 在 claim 前只置 tab.active、不进 activeTabByScope；这种自报 active 优先于回退，
    // 且一旦命中就不再往下走，保证同 scope 只有一个 active=true。
    for (const tab of this.tabs.values()) {
      if (tab.active && tab.lifecycle !== "closed" && sameScope(tab.owner, owner)) return tab.tabId;
    }
    return this.ownedTabs(owner).at(-1)?.tabId;
  }

  // summary 需要 guest 的实时 title/url，但恢复中的 tab 不能读临时 guest：那会把
  // about:blank 写进 logical cache，覆盖真正的恢复目标。
  // [失败路径] guest 已销毁时回退到 cached*，不能让一次 UI 轮询把 tab 判成错误。
  private async summary(tab: ManagedTab): Promise<BrowserTabSummary> {
    // guest 重绑恢复尚未完成时，替代 guest 仍可能报告 about:blank；各状态读取点
    // 都必须保留 logical cache，不能让临时 guest URL 覆盖后续恢复事实。
    if (tab.guest && !this.guestRecoveryFlights.has(tab.tabId)) {
      tab.cachedUrl = safeStr(() => tab.guest!.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => tab.guest!.getTitle(), tab.cachedTitle);
    }
    return {
      tabId: tab.tabId,
      url: tab.cachedUrl,
      title: tab.cachedTitle,
      viewport: await this.readTabViewport(tab),
      // active 用索引现算而不是读 tab.active：字段在 close/release 之后可能滞后，索引才是
      // 同一时刻的权威；两者不一致时以索引为准，否则列表会出现两个 active。
      ...(this.effectiveActiveTabId(tab.owner) === tab.tabId ? { active: true } : {}),
      // lifecycle 只暴露 deliverable/handoff：closed 不该出现在列表里，suspended/restoring 是
      // 内部中间态，暴露给调用方只会诱发对不可用 tab 的重试。
      ...(tab.lifecycle === "deliverable" || tab.lifecycle === "handoff"
        ? { lifecycle: tab.lifecycle }
        : {}),
    };
  }

  // viewport 优先级：显式 override > 后台 fallback > guest 自然尺寸 > 默认 800×600。
  // 顺序不能反：把 fallback 放在 override 之前会让 Agent 的设置被后台尺寸覆盖。
  // 0×0 的自然尺寸必须视为“不可用”，否则页面会以 0 宽布局，DOM 查询全部失败。
  private async readTabViewport(tab: ManagedTab): Promise<BrowserViewportSize> {
    if (tab.viewportOverride) return { ...tab.viewportOverride };
    if (tab.backgroundViewportFallback) {
      // 前台 tab 不应停留在外台 fallback 尺寸：readTabViewport 的「fallback 存在即短路」
      // 会让残留自我强化（页面钉死在后台尺寸，窗口 resize/全屏
      // 都不跟随）。即使两个前台信号（selectTab / reportResidency）都丢失，前台 tab 的
      // 下一次 viewport 读取也必须自愈；本次仍返回 fallback，恢复在 mutation 队列中随后完成。
      if (tab.active) {
        this.maybeRestoreBackgroundViewport(tab);
      }
      return { ...tab.backgroundViewportFallback };
    }
    if (!tab.guest || safeBool(() => tab.guest!.isDestroyed(), true)) {
      return { ...DEFAULT_BACKGROUND_BROWSER_VIEWPORT };
    }
    const value = await tab.guest.executeJavaScript(
      "({ width: window.innerWidth, height: window.innerHeight })",
    );
    if (isBrowserViewportSize(value)) {
      this.naturalViewportByWindow.set(tab.owner.windowId, { ...value });
      return value;
    }

    // 后台 session 的 Browser pane 会保留 guest 但通过 display:none 隐藏，首次
    // tabs.new() 仍能 dom-ready/attach，却只得到 0×0 viewport。隐藏是展示状态，不能阻断
    // 后台 Browser 执行；临时复用同窗口最近自然尺寸，重新前台后再清除 CDP override。
    const fallback = normalizeBackgroundViewport(
      this.naturalViewportByWindow.get(tab.owner.windowId) ?? DEFAULT_BACKGROUND_BROWSER_VIEWPORT,
    );
    await this.applyBackgroundViewportFallback(tab, fallback);
    this.log?.(
      `[browser-use] applied background viewport fallback tabId=${tab.tabId} width=${fallback.width} height=${fallback.height}`,
    );
    return { ...fallback };
  }

  // user tab 只暴露 UI 需要的最小信息，不含 owner/session：把 sessionId 发给 renderer
  // 会让页面脚本知道当前对话标识，属于不必要的信息泄漏。
  // favicon 允许 null，UI 需自行回退；这里不做网络补全，否则会在列表轮询里发请求。
  private userTabInfo(tab: ManagedTab): BrowserUserTabInfo {
    if (tab.guest && !this.guestRecoveryFlights.has(tab.tabId)) {
      tab.cachedUrl = safeStr(() => tab.guest!.getURL(), tab.cachedUrl);
      tab.cachedTitle = safeStr(() => tab.guest!.getTitle(), tab.cachedTitle);
    }
    return {
      id: tab.tabId,
      ...(tab.cachedUrl ? { url: tab.cachedUrl } : {}),
      ...(tab.cachedTitle ? { title: tab.cachedTitle } : {}),
    };
  }

  // meta 是返回给模型的观测信息，URL 必须脱敏后再写入：query 里可能带 token、
  // userinfo 可能带密码。sanitize 只保留 origin+pathname，不能图省事直接回传。
  // [权衡] 脱敏会丢失部分调试信息，但模型只需要知道“在哪个站点”，不需要完整 URL。
  private withMeta(
    result: BrowserCommandResult,
    context: InternalExecutionContext,
    tab?: ManagedTab,
    lifecycleOverride?: BrowserResponseMeta["lifecycle"],
  ): BrowserCommandResult {
    const openTabs = this.ownedTabs(context);
    // openTabIds 每次现算、不缓存：缓存版本在 tab 关闭后会继续把死 id 报给模型，模型据此
    // 选择一个不存在的 tab，唯一结果是多一轮报错。
    // currentUrl 优先从 guest 现读：重绑恢复期间 cachedUrl 可能还是旧页面；但无论来源都必须
    // 过 sanitize（INV-30），页面自己也可以把 token 写进 location。
    const currentUrl = tab
      ? sanitizeBrowserMetaUrl(
          tab.guest ? safeStr(() => tab.guest!.getURL(), tab.cachedUrl) : tab.cachedUrl,
        )
      : undefined;
    const meta: BrowserResponseMeta = {
      browserUse: true,
      backendType: "iab",
      browserId: context.browserId,
      browserGeneration: context.browserGeneration,
      openTabIds: openTabs.map((candidate) => candidate.tabId),
      ...(tab ? { tabId: tab.tabId } : {}),
      ...(currentUrl ? { currentUrl } : {}),
      ...(lifecycleOverride
        ? { lifecycle: lifecycleOverride }
        : tab
          ? { lifecycle: tab.lifecycle }
          : {}),
    };
    return { ...result, meta };
  }

  // 两个 helper 的区别只在错误码：cancelled 表示用户/turn 主动取消，unavailable 表示
  // 后端/guest 不可用。错误码决定模型是否重试，混用会让取消被当成可重试故障。
  // sideEffect 必须由调用方传入，不能在这里猜，已下发的取消必须报 uncertain。
  private cancelledOrUnavailable(
    context: InternalExecutionContext,
    running: RunningRequest,
    startedAt: number,
    tab: ManagedTab,
  ): BrowserCommandResult {
    if (running.controller.signal.aborted) {
      return this.withMeta(
        this.cancelledResult(context, running.dispatched, startedAt),
        context,
        tab,
      );
    }
    return this.withMeta(
      {
        ok: false,
        error: {
          code: "backend_unavailable",
          message: "browser guest not attached (webview not ready)",
        },
        elapsedMs: Date.now() - startedAt,
      },
      context,
      tab,
    );
  }

  // tab 不存在/已关闭统一走这里，错误码固定 tab_not_found，不能把内部状态泄漏成不同文案。
  // message 只描述用户可见事实，不包含 owner/session 等敏感字段。
  // [失败路径] 返回 ok=false 而不是抛错，IPC 层才能稳定序列化错误结构。
  private unavailableTabResult(
    context: InternalExecutionContext,
    tabId: string | undefined,
    startedAt: number,
  ): BrowserCommandResult {
    return this.withMeta(
      {
        ok: false,
        error: {
          code: "backend_unavailable",
          message: tabId
            ? `browser tab '${tabId}' is not visible in the current context. ${TAB_CONTEXT_RECOVERY_HINT}`
            : "browser tab is unavailable",
        },
        elapsedMs: Date.now() - startedAt,
      },
      context,
    );
  }

  // _context 故意不用：meta 由调用方 withMeta 统一组装，这里自带一份会覆盖调用方的
  // lifecycleOverride；sideEffect 三态由 dispatched 决定（INV-33），未下发才是 none。
  private cancelledResult(
    _context: InternalExecutionContext,
    dispatched: boolean,
    startedAt: number,
  ): BrowserCommandResult {
    return {
      ok: false,
      error: {
        code: "cancelled",
        message: dispatched
          ? "browser request cancelled after backend dispatch; side effects may have occurred"
          : "browser request cancelled before backend dispatch",
        sideEffect: dispatched ? "uncertain" : "none",
      },
      elapsedMs: Date.now() - startedAt,
    };
  }

  // abort 的鉴权点：只有 sameScope 的上下文能取消，且不能跨 window/session。
  // 取消只置 signal，不直接删 runningRequests：执行路径的 finally 还要据此决定
  // sideEffect 与日志。提前删会让 finally 找不到 entry，无法判断是否已下发。
  // 返回 true/false 供调用方决定是否回报“已取消”。
  private abortRequest(requestId: string, context: InternalExecutionContext): boolean {
    const request = this.runningRequests.get(requestId);
    // requestId 是 correlation id，不是授权凭证；取消也必须服从完整 IAB scope。
    if (!request || !sameScope(request.context, context)) return false;
    request.controller.abort(new DOMException("aborted", "AbortError"));
    return true;
  }

  // turn 结束只取消本 turn 的请求，不能扫掉整个 session：并行 turn（同一 session 多个
  // 工具调用）各自结算，误杀会让另一个 turn 的点击半途中断。
  // 同时把 agent tab 的 handoff/deliverable 状态交由 finalizeTabs 处理，顺序不能反：
  // 先 abort 再 finalize，避免 finalize 关 tab 时还有命令在写。
  endTurn(context: InternalExecutionContext, turnId?: string): void {
    this.abortRecordings(
      (entry) =>
        sameScope(entry.context, context) &&
        (turnId === undefined || entry.context.turnId === turnId),
      "turn ended",
    );
    for (const request of this.runningRequests.values()) {
      if (
        sameScope(request.context, context) &&
        (turnId === undefined || request.context.turnId === turnId)
      ) {
        request.controller.abort(new DOMException("turn ended", "AbortError"));
      }
    }
    // turn end 只结束请求，不结束 tab。旧的“只保留最终活动页”兜底会在已有 handoff 时
    // 自动关闭后续新 tab，使页面存活依赖模型记得写 finalize JS。active/handoff tab 现在原样保留；
    // deliverable 和 claimed user tab 仍按显式生命周期约定释放控制权，但 view 不关闭。
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      if (tab.lifecycle === "handoff") continue;
      if (tab.lifecycle === "deliverable" || tab.origin === "user") this.releaseToUser(tab);
    }
    // guest WebContents 在 CDP 仍 attached 时被销毁（destroyed 直达，
    // 触发路径不可枚举：React 卸载 webview / 系统行为均可达）会让 DevToolsSession 隐式析构后在途
    // 通知 UAF 掉主进程。turn 结束即 agent 不再操作，此刻主动 detach 把 CDP 暴露窗口从「tab 整个
    // 生命周期」收窄到「turn 内命令在途」；下次命令经 sendGuestCdpCommand lazy re-attach。
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      this.releaseGuestCdpAfterIdle(tab, "turn ended");
    }
  }

  // 空闲释放只 detach CDP，不关闭 guest：页面仍需保持渲染供用户查看，下次命令再 attach。
  // [资源] detach 前必须等待在途命令收敛；直接 detach 会让 sendCommand 的 promise 永远 pending，pendingCdpCommands 不归零，后续 teardown 走超时路径。
  // reason 只用于日志，不能参与业务判断。
  private releaseGuestCdpAfterIdle(tab: ManagedTab, reason: string): void {
    const guest = tab.guest;
    if (!guest || tab.guestLifecycle !== "attached") return;
    void (async () => {
      // 在途 CDP 命令（playwright cdp.send / viewport override / dialog 处理）结束后再断开，
      // 避免中途拆掉正在使用的管线；超时兜底与 runGuestTeardown 共用同一预算。
      const settled = await this.waitForGuestCdpIdle(tab, DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS);
      if (!settled) {
        this.warn(
          `browser guest cdp release pending timeout tabId=${tab.tabId} ` +
            `pending=${tab.pendingCdpCommands} reason=${reason}`,
        );
      }
      // 等待期间 tab 可能已换代/关闭/再次进入命令期，此时放弃本轮释放。
      // 先比 identity 再比 lifecycle：换代后新 guest 的 lifecycle 仍是 attached，只查生命周期
      // 会把 detach 打到新 guest 上；放弃而不是重试，避免与新一代的 release 互相打断。
      if (this.tabs.get(tab.tabId) !== tab || tab.guest !== guest) return;
      if (tab.guestLifecycle !== "attached") return;
      if (tab.pendingCdpCommands > 0) return;
      if (safeBool(() => guest.isDestroyed(), true)) return;
      try {
        if (!guest.debugger.isAttached()) {
          tab.cdpAttached = false;
          return;
        }
        guest.debugger.detach();
        tab.cdpAttached = false;
        this.log?.(`[browser-use] cdp released after ${reason} tabId=${tab.tabId}`);
      } catch (error) {
        this.warn(`browser guest cdp release failed tabId=${tab.tabId} reason=${reason}`, error);
      }
    })();
  }

  /**
   * 命令级空闲释放：每次 CDP 命令完成后重置计时，超过 cdpIdleReleaseMs 无新命令即主动
   * detach。guest renderer 被 Chromium 杀且 render-process-gone 丢失（Electron 已知缺口，
   * 实测 destroyed 直达 + CDP attached → 主进程 UAF）的崩溃窗口集中在 turn 内命令间隙，
   * turnEnded 级释放覆盖不到；密集命令流间隔远小于阈值，不会被误打断。
   */
  // 每次 CDP 命令完成都重置计时器；先 clear 再 set，避免多个 timer 同时存在导致
  // 提前 detach。tab 已 closed/destroyed 时不再排程，防止引用已释放 guest。
  // [并发] timer 回调里要再次检查 tab.guest 是否仍是同一个，避免换代后 detach 新 guest。
  private scheduleGuestCdpIdleRelease(tab: ManagedTab): void {
    if (tab.guestCdpIdleTimer) clearTimeout(tab.guestCdpIdleTimer);
    tab.guestCdpIdleTimer = setTimeout(() => {
      tab.guestCdpIdleTimer = undefined;
      this.releaseGuestCdpAfterIdle(tab, "cdp idle");
    }, this.cdpIdleReleaseMs);
  }

  // 只是清理计时器，不改变 guest 状态；它被 detachGuest/closeTab 调用，保证 tab 销毁后
  // 不会再有 timer 持有引用。
  // 允许重复调用：teardown 与 close 两条路径都可能清理同一个 timer。
  private clearGuestCdpIdleRelease(tab: ManagedTab): void {
    if (tab.guestCdpIdleTimer) {
      clearTimeout(tab.guestCdpIdleTimer);
      tab.guestCdpIdleTimer = undefined;
    }
  }

  // session 关闭是“释放控制权”而非“删除页面”：先把 user tab 交还，再关闭 agent tab。
  // 通知 renderer 清 sessionName/visibility 必须在删除 map 之后，保证 UI 查到的是空值而不是瞬时旧值。
  // [事务] 同一 scope 的 close 幂等，重复调用不应重复 abort 同一批录制。
  closeSession(context: InternalExecutionContext): void {
    this.abortRecordings((entry) => sameScope(entry.context, context), "session closed");
    for (const request of this.runningRequests.values()) {
      if (sameScope(request.context, context)) {
        request.controller.abort(new DOMException("session closed", "AbortError"));
      }
    }
    for (const tab of this.tabs.values()) {
      if (!sameScope(tab.owner, context)) continue;
      // session 是控制权边界，不是可见 tab 的生命边界。view 继续保留，但释放后仍绑定
      // 原 session；不能再写成全局 unclaimed，否则其它对话会通过 user.openTabs() 看到并接管。
      this.releaseToUser(tab);
      // 同 endTurn：会话结束释放 CDP，消除 guest 后续任意销毁路径上的主进程 UAF 窗口。
      this.releaseGuestCdpAfterIdle(tab, "session closed");
    }
    this.activeTabByScope.delete(scopeKey(context));
    // closeSession 清理 default 索引：scope 已结束，留着会让新会话复用同 key 时默认
    // 指向已删除 tab。active 索引由 closeTab 逐个清理。
    // 两处删除都不能省：同 key 的新会话（sessionId 被复用）会直接读到上一轮的 active/default，
    // 把命令落到已删除的 tab 上，因此这里按 scopeKey 再兜底清一遍。
    this.defaultTabByScope.delete(scopeKey(context));
    // closeSession 清名字与可见性是 scope 终止的一部分：保留它们会让同 key 的新会话
    // （sessionId 被复用）读到旧名字/旧可见性，UI 显示上一轮对话的状态。
    // 删除必须在通知 renderer 之前完成，否则 UI 查询会命中旧值。
    // 名字不参与鉴权，因此清理失败无需阻断关闭流程。
    // 这里按 scopeKey 而不是 sessionId：同一 session 在不同 browser 下是不同 scope。
    // 若将来增加 session 级缓存，必须同步在此清理，避免同类泄漏。
    this.sessionNames.delete(scopeKey(context));
    // 与 sessionNames 成对删除；单独漏掉会让新会话默认可见，面板一打开就显示错误状态。
    // 注意 closeTab 不删它：同一 scope 可能还有其它 tab，可见性是 scope 级事实。
    // 删除后不主动触发 onVisibilityChanged：关闭流程会统一通知一次，避免重复渲染。
    // 若 scope 仍有 tab 且用户重新打开面板，下一次 browserVisibilitySet 会重建该值，因此这里不需要保留“最后一个可见性”用于恢复。
    // 清理顺序与 sessionNames 无关，但两者必须在同一同步段完成。
    this.visibilityByScope.delete(scopeKey(context));
  }

  /**
   * `closeSession({ closeTabs: true })`：真正关闭该 session 名下的全部 tab。按 session 归属而非完整
   * browser scope 匹配——finalize / deliverable 已释放回该 session 的 tab 换到了 `unclaimed-iab` scope，
   * 仍归它。只给永不回来认领的 session 用（dwf 子代理，
   * docs/browser-use/2026-07-14-browser-tab-conversation-isolation-spec.md §2.3）：它的 sessionId 不是任何
   * 对话，closeSession 保留的 view 无人可见、无人可认领，只会一直挂着 guest。
   */
  // 按 owner 过滤而不是按 tabId 列表：关闭时可能有新 tab 刚创建，只要属于该 session
  // 就必须一起收口。
  // 用 Promise.allSettled：单个持久化删除失败不能让其它 tab 留在 registry 里。
  // 实现是逐条 await，不是 allSettled：removeTabRecovery 抛错会让后续 tab 留在 registry，见 D-9-11。
  private async closeSessionTabs(context: InternalExecutionContext): Promise<void> {
    const owned = [...this.tabs.values()].filter(
      (tab) => tab.lifecycle !== "closed" && ownedBySession(tab.owner, context),
    );
    for (const tab of owned) await this.closeTabDurably(tab);
  }

  // 窗口关闭时该窗口的所有 tab 都必须销毁，否则 guest 会继续占用 renderer 配额，
  // 且下次同 id 窗口打开时会看到“幽灵标签”。
  // 同时清 naturalViewportByWindow：Electron 会复用 windowId，缓存不删会串味。
  // [资源] 先释放 CDP 再删 registry，避免 close 回调里访问已删除 tab。
  closeWindow(windowId: number): void {
    this.abortRecordings((entry) => entry.context.windowId === windowId, "window closed");
    for (const request of this.runningRequests.values()) {
      if (request.context.windowId === windowId) {
        request.controller.abort(new DOMException("window closed", "AbortError"));
      }
    }
    for (const tab of this.tabs.values()) {
      if (tab.owner.windowId !== windowId) continue;
      this.detachAndCloseGuest(tab);
      this.residencyCoordinator.remove(tab.tabId);
      this.restoredTabClaims.delete(tab.tabId);
      // closeWindow 走快速路径不经过 closeTab；per-tab 截图状态若不在此清理，
      // 迟到 settle 的回调会按 tabId 污染恢复流程可能复用的新 tab 计数。decrement 对
      // 已删除的 key 是 no-op，前提是条目先在这里删干净。
      this.inFlightScreenshots.delete(tab.tabId);
      this.abandonedScreenshotCaptures.delete(tab.tabId);
      this.tabs.delete(tab.tabId);
    }
    this.naturalViewportByWindow.delete(windowId);
    // 但 active/default 索引与 sessionNames/visibilityByScope 没有在这里清：Electron 会复用
    // windowId，同 workspace/session 重开窗口会继承上一轮的可见性，见 D-9-12。
  }

  // 删除恢复快照必须按 tabId + owner 精确匹配；只按 tabId 可能删掉另一个窗口刚恢复的
  // 同名 tab（历史 tabId 由 renderer 生成，存在碰撞可能）。
  // 存储失败只 warn：关闭动作不能因为磁盘错误失败，tombstone 已保证本进程内不复活。
  private async removeTabRecovery(tab: ManagedTab): Promise<void> {
    await this.residencyOptions.recoveryStore?.remove(tab.tabId);
  }

  // closeTab 是同步收口，持久化删除是异步的；两者分开是为了让 renderer 的关闭按钮
  // 立即反馈，同时保证磁盘最终一致。
  // [失败路径] 持久化失败时 tab 已在内存中关闭，不能回滚：回滚会让用户看到 tab 复活。
  private async closeTabDurably(tab: ManagedTab, notifyRenderer = true): Promise<void> {
    if (tab.lifecycle === "closed") return;
    // 旧 close 先回命令/通知 renderer，再 fire-and-forget 删除恢复仓库；紧接着退出时
    // 已关闭 tab 会从旧 shell 复活。先完成持久删除，失败时保留当前 logical tab 供调用方重试。
    await this.removeTabRecovery(tab);
    this.closeTab(tab, notifyRenderer);
  }

  // closeTab 的顺序不可交换：写 tombstone → 清索引 → detach/close guest → 删 registry
  // → 通知 renderer。先删 registry 会让迟到 attach 查不到 tab 而重建；先 detach 会让
  // renderer 在收到关闭通知前先失去画面。
  // [资源] 必须 abort 该 tab 的录制/下载 waiter/截图 tracker，否则关闭后仍有异步写。
  // selected 的下一个 tab 只能从同 scope 选，不能跨 scope 借用。
  private closeTab(tab: ManagedTab, notifyRenderer = true): void {
    // lifecycle 已是 closed 时直接返回，closeTab 可能被 closeWindow 与单条命令重复调用。
    if (tab.lifecycle === "closed") return;
    // closeTab 先取消录制再 detach：录制持有 guest 引用，若不取消，runRecording 的
    // finally 会在 guest 销毁后访问它。
    this.abortRecordings((entry) => entry.tabId === tab.tabId, "tab closed");
    // 先置 closed 再清资源：后面的 detachAndCloseGuest 与 resolveWaiters 都假定终态已写。
    tab.lifecycle = "closed";
    // tombstone 在持久化删除前写入：即使删除失败，本进程内也拒绝复活。
    // 只增不清是刻意的，清理只能随 disposeAll 整体丢弃。
    this.closedTabIds.add(tab.tabId);
    // tab 已不可再执行命令；不必为一个可能永久不回包的旧 CDP capture 保留 manager 引用。
    this.inFlightScreenshots.delete(tab.tabId);
    // abandonedScreenshotCaptures 记录的是已放弃的底层 capture，tab 关闭后不再有意义。
    this.abandonedScreenshotCaptures.delete(tab.tabId);
    // resolveWaiters 用 null 结算所有等待者，关闭后不应再有命令挂在这个 tab 上。
    this.resolveWaiters(tab.tabId, null);
    // detachAndCloseGuest 负责 guest 与 CDP，必须在删 registry 之前完成。
    this.detachAndCloseGuest(tab);
    // 反向遍历 downloads 按 tabId 清理，下载记录很少因此不值得维护反向索引。
    for (const [downloadId, record] of this.downloads) {
      // 按 tabId 反向清理该 tab 的所有下载记录；用遍历删除而不是维护反向索引，
      // 因为下载数很少，反向索引反而增加同步负担。pending 记录也删：session 已销毁，
      // 不可能再收到 done 事件。
      // 只删记录不 cancel 下载：closeGuestWebContents 已经负责中断。
      // 这里在 closeTab 内同步执行，保证关闭返回时诊断里不再有该 tab 的下载。
      // 遍历 downloads 是 O(n)，n 为全局下载数；关闭路径调用频率低，所以该成本可接受。
      if (record.tabId === tab.tabId) this.downloads.delete(downloadId);
    }
    // closeTab 清空该 tab 的早到下载队列：队列里的 id 已无 waiter 会消费，留着只会
    // 让 downloads map 的记录无法回收。删除是幂等的，重复 close 不会报错。
    // 只删队列不删 downloads：下载记录由上面的反向遍历统一清理，避免两处各删一半。
    // 若下载仍在 pending，closeGuestWebContents 会中断它并触发 cancelled 状态。
    // 队列按 tabId 隔离，不会影响其它 tab 的等待者。
    // 清空后同一 tabId 若被复用，新下载从空队列开始，不会继承旧 id。
    this.queuedDownloads.delete(tab.tabId);
    // 取队首 waiter 逐条结算，队列在结算过程中会自我缩短。
    let waiter = this.downloadWaiters.get(tab.tabId)?.[0];
    // while 读的是实时队首，finishDownloadWaiter 会把已处理的条目移走。
    while (waiter) {
      // 传给 waiter 的是 null，表示 tab 已关闭而不是下载完成。
      this.finishDownloadWaiter(tab.tabId, waiter, null);
      // 重新读队首而不是用索引递增，finishDownloadWaiter 可能整段清空队列。
      waiter = this.downloadWaiters.get(tab.tabId)?.[0];
    }
    // scopeKey 只在清理 active/default 时算一次，避免同一 tab 出现两把 key。
    const key = scopeKey(tab.owner);
    // 只有 active 仍指向自己才删，否则会误删后来 select 的 tab。
    if (this.activeTabByScope.get(key) === tab.tabId) this.activeTabByScope.delete(key);
    // default 索引同理按值比对，换过默认 tab 后这里不应动手。
    if (this.defaultTabByScope.get(key) === tab.tabId) this.defaultTabByScope.delete(key);
    // notifyRenderer 为 false 时跳过回调，closeWindow 批量关闭不需要逐条通知。
    if (notifyRenderer) this.onCloseTabRequested?.(tab.tabId, tab.owner);
    // residencyCoordinator.remove 释放预算登记，漏掉会让内存诊断里留下幽灵 tab。
    this.residencyCoordinator.remove(tab.tabId);
    // restoredTabClaims 是恢复期的认领记录，tab 关闭后必须一并抹掉。
    this.restoredTabClaims.delete(tab.tabId);
    // 最后才删 tabs，前面各步都以 registry 里的 tab 为输入。
    this.tabs.delete(tab.tabId);
  }

  /**
   * guest renderer 崩溃/被杀时立即断开 CDP。
   *
   * 崩溃链条（主进程 UAF，minidump 落在 DevToolsSession::DispatchProtocolNotification，
   * client_ 的 vptr 为 0）：
   *   Chromium 在内存压力下杀掉 guest renderer
   *     → render-process-gone：WebContents 仍存活，CDP 仍 attached
   *     → renderer 侧递增 webviewGeneration，React 卸载旧 <webview>
   *     → 旧 WebContents 此刻才销毁，api::Debugger 走隐式析构
   *     → DevToolsSession 仍持 client_ 派发在途通知 → UAF → 主进程崩溃 → 整个 app 退出
   *
   * 实测（Electron 41.0.3 / forcefullyCrashRenderer，带毫秒时间戳的对照实验）：
   *   - render-process-gone 时 isDestroyed()=false、isCrashed()=true、isAttached()=true，
   *     detach() 成功且随后 isAttached()=false；
   *   - destroyed 时 isCrashed()/isAttached() 全抛 "Object has been destroyed"，
   *     那里已经不可能 detach —— 所以 destroyed 兜底修不了这个 UAF；
   *   - 崩溃后若不卸载 <webview>，WebContents 无限期停在 crashed 态（10s destroyed 未到）；
   *     一旦 renderer 卸载 <webview>，destroyed 在 ~5ms 内到达。即销毁时机由 renderer 决定，
   *     native detach 的安全窗口只存在于 WebContents 销毁之前。
   * main 的 render-process-gone 是第一道守卫；renderer 重建前的显式 detach ACK 是第二道屏障，
   * 用来覆盖 main 事件未到达的现场。两者都不改变销毁时机，只保证销毁时 CDP 已经断开。
   */
  // render-process-gone 是唯一能在 WebContents 仍存活时发现 renderer 崩溃的信号。
  // 此时必须主动 detach CDP：等 DOM 卸载再 detach 会走隐式析构，出现 UAF。
  // 监听必须在 detachGuest 中注销，否则 guest 换代后旧监听仍持有 tab 引用。
  private setupCdpCrashGuard(tab: ManagedTab, guest: GuestWebContents): void {
    // 入口先注销上一次的监听：重复 setup（rebind/恢复重放）会给同一 guest 挂两份，
    // 崩溃时 detach 执行两次，第二次抛 "not attached" 会污染告警日志。
    tab.crashGuardCleanup?.();
    if (!guest.on || !guest.removeListener) return;
    const tabId = tab.tabId;
    const onRenderProcessGone = (...args: unknown[]): void => {
      const reason = safeStr(
        () => String((args[1] as { reason?: string } | undefined)?.reason ?? "unknown"),
        "unknown",
      );
      const guestId = safeStr(() => String(guest.id), "?");
      // 不校验 tab.guest === guest：断开一个已换代 guest 的 CDP 同样正确且必要，
      // 而漏掉它就等于把 UAF 窗口留着。
      try {
        // 只在身份匹配时改 lifecycle：已换代的旧 guest 崩溃不能把当前 tab 标成 detaching，
        // 否则 INV-03 会卡在中间态，后续 attach 会被「正在 detach」挡住。
        if (this.tabs.get(tabId)?.guest === guest) tab.guestLifecycle = "detaching";
        if (!guest.debugger.isAttached()) return;
        guest.debugger.detach();
        this.log?.(
          `[browser-use] cdp detached on render-process-gone tabId=${tabId} ` +
            `guestId=${guestId} reason=${reason}`,
        );
      } catch (error) {
        // 这里失败意味着 UAF 窗口没能关上，必须留痕以便与后续崩溃关联。
        this.warn(
          `browser guest cdp detach on render-process-gone failed tabId=${tabId} ` +
            `guestId=${guestId} reason=${reason}`,
          error,
        );
      } finally {
        if (this.tabs.get(tabId)?.guest === guest) tab.cdpAttached = false;
      }
    };
    guest.on("render-process-gone", onRenderProcessGone);
    tab.crashGuardCleanup = () => {
      guest.removeListener?.("render-process-gone", onRenderProcessGone);
    };
  }

  // JS dialog 事件在 CDP 层是 Page.javascriptDialogOpening；这里只缓存元数据，不自动
  // 关闭：自动 accept 会让模型失去处理 confirm 的机会。
  // 监听必须随 guest 换代注销，且 detach 时必须清 pendingDialogs，避免新页面读到旧 prompt。
  private setupDialogTracking(tab: ManagedTab, guest: GuestWebContents): void {
    const tabId = tab.tabId;
    // Page.enable 失败只记日志：dialog 缓存是增强能力，不能因为域未开启就让 attach 失败；
    // 代价是这一代 guest 上的 dialog 事件不会到达，getDialog 会返回 null。
    void this.sendGuestCdpCommand(tab, guest, "Page.enable").catch((error: unknown) => {
      this.log?.(`[browser-use] Page.enable failed tabId=${tabId}: ${String(error)}`);
    });
    const onMessage = (_event: unknown, method: string, params: unknown): void => {
      const current = this.tabs.get(tabId);
      // 身份必须匹配：removeListener 之前到达的迟到事件来自旧 guest，写进 pendingDialogs
      // 会让新页面读到上一个页面的 prompt（INV-28 要求缓存只反映当前 guest）。
      if (!current || current.guest !== guest || current.lifecycle === "closed") return;
      if (method === "Page.javascriptDialogOpening") {
        // 打点：dialog 事件到达 main 的时刻，用于区分「事件黑洞」与「dialog 已被 detach
        // 清理」两种 getDialog=null 成因。
        this.log?.(`[browser-use] dialog opening event received tabId=${tabId}`);
        const data = (params ?? {}) as {
          type?: string;
          message?: string;
          defaultPrompt?: string;
        };
        const dialog: BrowserDialog = {
          type: normalizeDialogType(data.type),
          message: typeof data.message === "string" ? data.message : "",
          ...(typeof data.defaultPrompt === "string" ? { defaultPrompt: data.defaultPrompt } : {}),
        };
        this.pendingDialogs.set(tabId, dialog);
      } else if (method === "Page.javascriptDialogClosed") {
        this.pendingDialogs.delete(tabId);
      }
    };
    guest.debugger.on("message", onMessage);
    tab.cdpMessageCleanup = () => {
      guest.debugger.removeListener("message", onMessage);
    };
  }

  // 把 tab.viewportOverride 应用到当前 guest；没有 override 时应用 natural 尺寸。
  // 必须经 enqueueViewportMutation：直接调用 Emulation.setDeviceMetricsOverride 会与
  // 正在执行的 set/reset 竞争，导致页面尺寸来回跳。
  // apply 失败只 warn，viewport 是增强能力，不能阻断命令。
  private applyViewportOverride(tab: ManagedTab): void {
    const viewport = tab.viewportOverride;
    if (!viewport) return;
    void this.setTabViewport(tab, viewport).catch((error: unknown) => {
      this.log?.(`[browser-use] viewport apply failed tabId=${tab.tabId}: ${String(error)}`);
    });
  }

  // Agent 显式设置 viewport：写入前必须校验 BROWSER_VIEWPORT_LIMITS，否则 0 宽会让
  // 页面布局崩坏，过大则让隐藏窗口分配巨幅 surface。
  // 写入后同步 tab.viewportOverride 再 apply，保证读路径立即看到新值；顺序反了会让
  // 并发 readTabViewport 读到旧尺寸。
  private async setTabViewport(tab: ManagedTab, viewport: BrowserViewportSize): Promise<void> {
    assertViewportOverride(viewport);
    if (tab.lifecycle === "closed") return;
    // 必须同时清掉 fallback：readTabViewport 在没有 override 时优先读 fallback，
    // 只写 override 而留下 fallback，会让 agent 显式设置的尺寸被后台兜底顶掉。
    tab.backgroundViewportFallback = undefined;
    tab.viewportOverride = { ...viewport };
    if (!tab.guest) return;
    const guest = tab.guest;
    await this.enqueueViewportMutation(tab, async () => {
      if (tab.guest !== guest || tab.lifecycle === "closed") return;
      await this.sendGuestCdpCommand(
        tab,
        guest,
        "Emulation.setDeviceMetricsOverride",
        buildViewportMetricsOverride(viewport),
      );
    });
  }

  // reset 清除 override 并回退到自然尺寸；不能把它实现成“设置成 800×600”，否则用户调整窗口后页面不再跟随。
  // 后台 tab 没有自然尺寸时使用 background fallback，而不是默认值，保持与 read 一致。
  private async resetTabViewport(tab: ManagedTab): Promise<void> {
    if (tab.lifecycle === "closed") return;
    tab.viewportOverride = undefined;
    tab.backgroundViewportFallback = undefined;
    if (!tab.guest) return;
    const guest = tab.guest;
    await this.enqueueViewportMutation(tab, async () => {
      if (tab.guest !== guest || tab.lifecycle === "closed") return;
      await this.sendGuestCdpCommand(tab, guest, "Emulation.clearDeviceMetricsOverride");
    });
  }

  // 后台 pane 隐藏导致 guest 读到 0×0，这里用缓存的自然尺寸兜底，避免页面以 0 宽布局。
  // 只对没有显式 override 的 tab 生效：Agent 明确指定尺寸时不能被后台逻辑覆盖。
  // [资源] fallback 必须记录在 tab 上，回前台时据此判断是否需要恢复。
  private async applyBackgroundViewportFallback(
    tab: ManagedTab,
    viewport: BrowserViewportSize,
  ): Promise<void> {
    const guest = tab.guest;
    if (!guest || tab.lifecycle === "closed") {
      throw new Error(`browser tab '${tab.tabId}' has no readable viewport`);
    }
    const fallback = { ...viewport };
    tab.backgroundViewportFallback = fallback;
    // 用引用比对而不是字段比对：await 期间 agent 可能已设 override 或写了新 fallback，
    // 只有仍指向自己这份对象才允许下发，否则会覆盖更新的状态。
    try {
      await this.enqueueViewportMutation(tab, async () => {
        if (
          tab.guest !== guest ||
          tab.lifecycle === "closed" ||
          tab.backgroundViewportFallback !== fallback ||
          tab.viewportOverride
        ) {
          return;
        }
        await this.sendGuestCdpCommand(
          tab,
          guest,
          "Emulation.setDeviceMetricsOverride",
          buildViewportMetricsOverride(fallback),
        );
      });
    } catch (error) {
      if (tab.backgroundViewportFallback === fallback) {
        tab.backgroundViewportFallback = undefined;
      }
      throw error;
    }
  }

  /**
   * 前台激活路径的统一收口：后台 fallback viewport 不能在 tab 回到前台后残留。
   * 仅在 attachGuest({active:true}) 时清除是不够的：guest 存活期间的前台切换
   * （activateTab / claim / renderer residency 上报）不会重新 attach，页面就永久钉死在
   * 后台尺寸。restoreNaturalViewportAfterBackground 自带幂等守卫与串行 mutation 队列，
   * 多个前台信号重复触发是安全的。
   */
  // tab 回到前台时必须清掉 fallback，否则 readTabViewport 会一直短路在后台尺寸，
  // 页面被“钉死”，窗口 resize 也不再跟随。
  // 只在 fallback 仍等于当前生效尺寸时恢复，避免覆盖期间 Agent 新设的 override。
  private maybeRestoreBackgroundViewport(tab: ManagedTab): void {
    if (tab.lifecycle === "closed" || !tab.backgroundViewportFallback) return;
    this.restoreNaturalViewportAfterBackground(tab);
  }

  // 恢复自然尺寸需要读窗口/框的实际尺寸，拿不到时保留 fallback，不能猜一个默认值。
  // 恢复后清 backgroundViewportFallback，保证下一次后台切换能重新计算。
  // 失败只 warn：viewport 错误不应让 tab 变成不可用。
  private restoreNaturalViewportAfterBackground(tab: ManagedTab): void {
    const fallback = tab.backgroundViewportFallback;
    const guest = tab.guest;
    if (!fallback || tab.viewportOverride || !guest) return;
    void this.enqueueViewportMutation(tab, async () => {
      // 每个 await 之后都要重校验：清 override 与读 innerWidth 之间页面可能已经按新尺寸
      // 布局，读到的值会属于另一次 mutation；三次校验任一失败就放弃本次恢复。
      if (
        tab.guest !== guest ||
        tab.lifecycle === "closed" ||
        tab.backgroundViewportFallback !== fallback ||
        tab.viewportOverride
      ) {
        return;
      }
      await this.sendGuestCdpCommand(tab, guest, "Emulation.clearDeviceMetricsOverride");
      if (tab.backgroundViewportFallback !== fallback || tab.viewportOverride) return;
      const value = await guest.executeJavaScript(
        "({ width: window.innerWidth, height: window.innerHeight })",
      );
      if (tab.backgroundViewportFallback !== fallback || tab.viewportOverride) return;
      if (isBrowserViewportSize(value)) {
        this.naturalViewportByWindow.set(tab.owner.windowId, { ...value });
        tab.backgroundViewportFallback = undefined;
        return;
      }
      // active=true 已到达但 Chromium 尚未完成可见布局时，继续保留 transient；下一次
      // renderer 可见 attach 或 viewport 读取仍可恢复，不能短暂退回 0×0。
      await this.sendGuestCdpCommand(
        tab,
        guest,
        "Emulation.setDeviceMetricsOverride",
        buildViewportMetricsOverride(fallback),
      );
    }).catch((error: unknown) => {
      this.log?.(
        `[browser-use] background viewport restore failed tabId=${tab.tabId}: ${String(error)}`,
      );
    });
  }

  // 所有 viewport 写入都排进 tab.viewportMutation 链；用 then 串联而不是 await 队列，
  // 是为了让调用方拿到“自己这次 mutation 完成”的 Promise，而不是排到队尾就返回。
  // [并发] 链上任何一步 reject 都必须被吞掉再继续，否则一次失败会让后续所有写入
  // 永久跳过（Promise 链一旦 rejected 就短路）。
  // insideViewportMutation 防止 CDP 重连重放时再次入队等待自己，形成死锁。
  private enqueueViewportMutation(tab: ManagedTab, mutation: () => Promise<void>): Promise<void> {
    const previous = tab.viewportMutation ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        // CDP 恢复据此在当前临界区直接重放，避免二次入队后等待自己。
        tab.insideViewportMutation = true;
        try {
          await mutation();
        } finally {
          tab.insideViewportMutation = false;
        }
      });
    tab.viewportMutation = current;
    // 两处都要比 identity 再清空：若期间已有新 mutation 入队，tab.viewportMutation 指向它，
    // 这里盲清会让队列从中间断开，之后入队的写入不再串行。
    current.then(
      () => {
        if (tab.viewportMutation === current) tab.viewportMutation = undefined;
      },
      () => {
        if (tab.viewportMutation === current) tab.viewportMutation = undefined;
      },
    );
    return current;
  }

  // will-download 绑定在 guest.session 上而不是 guest 本身：下载属于 session 生命周期，
  // guest 换代后同一 session 仍会继续接收下载。
  // 监听必须保存 cleanup 供 detach 注销；否则每次换代都会多一份监听，同一文件被记录多次。
  // 先入队再唤醒 waiter：事件可能早于等待者到达。
  private setupDownloadTracking(tab: ManagedTab, guest: GuestWebContents): void {
    // 先注销上一任 session 的监听：不注销会让同一文件被记两次并唤醒两个 waiter。
    tab.downloadCleanup?.();
    // session 缺失（测试替身）直接返回，不给 tab 留一个永远不触发的 cleanup。
    if (!guest.session) return;
    // listener 闭包捕获 guest 与 tab：session 级事件不区分来源，身份比对只能在回调内做。
    const listener = (_event: unknown, item: GuestDownloadItem, contents: GuestWebContents) => {
      // will-download 挂在 session 上，同一 session 里其它 guest 的下载也会进来；
      // 不比对 contents 就会把别的 tab 的下载记到本 tab，并唤醒错误的 waiter。
      if (contents !== guest || tab.guest !== guest || tab.lifecycle === "closed") return;
      // downloadId 带 iab- 前缀与随机段，必须跨 tab 唯一，否则日志无法反查记录归属。
      const downloadId = `iab-download:${randomUUID()}`;
      // record 在 done 之前就入表：waitForDownload 可能先读到 pending，状态由 done 更新。
      const record: DownloadRecord = {
        tabId: tab.tabId,
        path: safeStr(() => item.getSavePath(), "") || null,
        state: "pending",
      };
      // 先入表再唤醒 waiter，反过来会让等待方在表里查不到刚拿到的 id。
      this.downloads.set(downloadId, record);
      // 新下载立即重算保护：下载期间页面不能被后台节流，否则写盘会卡住。
      this.refreshRuntimeProtection(tab.tabId);
      // done 只挂一次：once 保证同一 item 不会重复结算。
      item.once("done", (_event, state) => {
        // 保存路径可能直到 done 才有值，空值回退到入表时的快照。
        record.path = safeStr(() => item.getSavePath(), "") || record.path;
        // 三类终态显式归一：未知 state 归为 interrupted，不保留原生字符串以免下游漏判。
        record.state =
          state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted";
        // 终态同样 refreshRuntimeProtection：下载结束后页面才允许回到后台。
        this.refreshRuntimeProtection(tab.tabId);
      });
      // waiter 按 tab 取：一个 tab 同时只允许一个下载等待者。
      const waiters = this.downloadWaiters.get(tab.tabId);
      // shift 而不是 pop：FIFO 保证先等待的命令先拿到下载。
      const waiter = waiters?.shift();
      // 有 waiter 时直接调用 finishDownloadWaiter，不把下载 id 留在队列里。
      if (waiter) {
        // finishDownloadWaiter 负责从 downloadWaiters 删除并 resolve，这里不要重复结算。
        this.finishDownloadWaiter(tab.tabId, waiter, downloadId);
      } else {
        // 无等待者时按 tab 入队：早到的下载不能丢，waitForEvent 可能晚几百毫秒注册。
        const queued = this.queuedDownloads.get(tab.tabId) ?? [];
        // 队列只由真实事件写入、由 waiter 消费，长度天然有界。
        queued.push(downloadId);
        // 早到的下载按 tab 入队而不是直接丢弃：waitForEvent 可能晚几百毫秒才注册。
        // 队列只由真实下载事件写入，并会被 waiter 消费，长度自然有界。
        this.queuedDownloads.set(tab.tabId, queued);
      }
    };
    // 监听挂在 session 而不是 guest 上：Electron 的 will-download 只在 session 层触发。
    guest.session.on("will-download", listener);
    // cleanup 存进 tab 供 detachGuest 调用，缺它每次换代都会多一份监听（INV-27）。
    tab.downloadCleanup = () => guest.session?.removeListener("will-download", listener);
  }

  // 等待下载要同时处理“事件已到达（队列有值）”和“事件未来（挂 waiter）”两种时序。
  // 超时/abort 必须调用 finishDownloadWaiter 从数组摘除自己，否则 signal 监听泄漏。
  // [失败路径] 超时返回 null，让调用方报 timeout 而不是把空字符串当成下载路径。
  private waitForDownload(
    tabId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<string | null> {
    const queued = this.queuedDownloads.get(tabId);
    // 先消费队列再挂 waiter：反序时早到的事件会被留在队列里，下一次 waitForDownload
    // 立刻拿到上一次的下载 id，表现为「等下载」返回了别的文件。
    const existing = queued?.shift();
    if (existing) return Promise.resolve(existing);
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = {} as DownloadWaiter;
      waiter.resolve = resolve;
      waiter.signal = signal;
      waiter.timer = setTimeout(() => this.finishDownloadWaiter(tabId, waiter, null), timeoutMs);
      waiter.onAbort = () => this.finishDownloadWaiter(tabId, waiter, null);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      const waiters = this.downloadWaiters.get(tabId) ?? [];
      waiters.push(waiter);
      this.downloadWaiters.set(tabId, waiters);
    });
  }

  // 只移除指定 waiter 而不是清空整个数组：同一 tab 可能有其它并发 waitForEvent。
  // resolve 必须在移除之后：resolve 会同步唤醒调用方继续执行，若此时 waiter 仍在数组里，
  // 下一次事件可能重复 resolve 同一个 Promise（无效但会扰乱计数）。
  private finishDownloadWaiter(
    tabId: string,
    waiter: DownloadWaiter,
    downloadId: string | null,
  ): void {
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    // 取 waiter 列表后 shift 最早的一个；顺序语义是“先等待先满足”，不能随机取，
    // 否则并发 waitForEvent 的返回值会错配。
    const waiters = this.downloadWaiters.get(tabId);
    if (waiters) {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      // 最后一个 waiter 移除后删 key，避免空数组累积；与 waiters 的清理规则一致。
      // 必须在 splice 之后判断长度，否则最后一个 waiter 会留下空数组。
      // 删除后不影响已经 resolve 的 waiter，它们已从数组摘除。
      // 并发 waitForEvent 各自独立，不会因为别人完成而丢失自己的等待。
      // 空数组与无 key 语义等价，读取方统一按 ?? [] 处理。
      // 该 map 不参与鉴权，删除时机不影响安全边界。
      if (waiters.length === 0) this.downloadWaiters.delete(tabId);
    }
    waiter.resolve(downloadId);
  }

  /**
   * CDP session 态恢复式 attach：idle/turn 结束释放后再次进入命令期时调用，
   * 返回可等待的 flight——Page.enable 与 viewport override 重放完成后业务命令才允许派发。
   *
   * Page 域 enable 与 Emulation.setDeviceMetricsOverride 都是 per-session 的，
   * detach 时已被 Chromium 清空；
   * 裸 attach("1.3") 得到的是干净 session——dialog 事件黑洞（getDialog 恒 null、evaluate
   * 遇 JS dialog 挂到超时实测 62s）、viewport 仿真与 manager 缓存分叉。且 fire-and-forget
   * 重放没有等待屏障：业务命令（截图/evaluate）可能在恢复完成前执行，重放在首命令场景
   * 失效。恢复命令经 raw 发送（不走 ensure，避免自等待）；viewport 重放走既有串行队列，
   * 队列内触发恢复时直接重放，避免二次入队与当前 flight 互相等待死锁。
   */
  // attach 是显式且幂等的：guest.debugger.isAttached() 为真时直接返回，不能重复 attach
  // （Chromium 会抛 "Another debugger is already attached"）。
  // [并发] 多个命令同时进入时由 pendingCdpCommands/attach 状态拦住，只能有一个真正 attach。
  private async ensureGuestCdpAttached(tab: ManagedTab, guest: GuestWebContents): Promise<void> {
    if (!tab.guestCdpRestoreFlight) {
      const flight = this.runGuestCdpSessionRestore(tab, guest).finally(() => {
        if (tab.guestCdpRestoreFlight === flight) tab.guestCdpRestoreFlight = undefined;
      });
      tab.guestCdpRestoreFlight = flight;
    }
    await tab.guestCdpRestoreFlight;
  }

  // CDP 会话状态（viewport metrics、page state）在 detach 后会被清空，重连必须重放。
  // 重放属于 guest 生命周期而不是单条命令：用 guestCdpRestoreFlight 串行，业务命令
  // 必须 await 它，否则会在 metrics 尚未生效时截图，得到错误尺寸。
  // [失败路径] 重放失败要 rollback，避免 coordinator 认为已恢复而实际是空设置。
  private async runGuestCdpSessionRestore(tab: ManagedTab, guest: GuestWebContents): Promise<void> {
    // 先查 native isAttached，已附着时不再 attach，重复 attach 会抛异常。
    if (!safeBool(() => guest.debugger.isAttached(), false)) {
      // 协议版本必须与 attachGuest 一致（1.3），否则两处 capability 集合会分叉。
      guest.debugger.attach("1.3");
      // cdpAttached 必须是 native isAttached() 的镜像而不是直接置 true：attach 可能静默
      // 失败，写死 true 会让 teardown 去 detach 一个不存在的会话，并让后续命令跳过重建。
      tab.cdpAttached = safeBool(() => guest.debugger.isAttached(), false);
      // attach 后重新读 isAttached，写死 true 会让 cdpAttached 变成谎言。
      if (!tab.cdpAttached) {
        // 拿不到附着态必须抛错，恢复 flight 的屏障语义不允许带着未知状态继续。
        throw new Error(`browser guest cdp restore attach failed tabId=${tab.tabId}`);
      }
    }
    // 恢复失败必须上抛：屏障契约是「Page.enable 与 viewport 状态就绪后才
    // 允许业务命令派发」。吞掉异常会让后续命令见 attached 即跳过恢复——Page.enable
    // 丢失把 dialog 事件黑洞延长到整个 attach 期，且 "replayed" 日志误导排障。异常上抛
    // 前先 rollback 到 detached：半途 session 不可用，还原释放态后下一次命令才会重建
    // 恢复 flight（否则 attached=true 会让 lazy attach 跳过恢复，失败被永久固化）。
    try {
      // Page.enable 是重放的第一项，dialog 与 frame 事件都依赖它。
      await this.sendGuestCdpCommandRaw(tab, guest, "Page.enable");
    } catch (error) {
      // warn 只记录不吞异常，error 会继续上抛给调用方。
      this.warn(`browser guest Page.enable replay failed tabId=${tab.tabId}`, error);
      // rollbackGuestCdpRestore 把 cdpAttached 还原成 false，下一次命令才会重建恢复。
      this.rollbackGuestCdpRestore(tab, guest);
      // rollback 之后重新抛原始 error，调用方拿到的是真实失败原因。
      throw error;
    }
    // viewport 取 override 优先、background fallback 次之，两者都没有就跳过重放。
    const viewport = tab.viewportOverride ?? tab.backgroundViewportFallback;
    // 只有存在 viewport 时才重放 metrics，否则保持浏览器自然尺寸。
    if (viewport) {
      try {
        // replayViewport 是入队执行的闭包，入队与执行之间可能发生换代。
        const replayViewport = async () => {
          // 入队到真正执行之间可能换代或关闭，必须重新比对：把旧 tab 的 metrics 写到
          // 新 guest 上会让首帧尺寸与 manager 缓存分叉，且之后没有任何路径会纠正它。
          if (tab.guest !== guest || tab.lifecycle === "closed") return;
          // Emulation.setDeviceMetricsOverride 必须与首次 attach 使用同一构造，参数形状不能分叉。
          await this.sendGuestCdpCommandRaw(
            tab,
            guest,
            "Emulation.setDeviceMetricsOverride",
            buildViewportMetricsOverride(viewport),
          );
        };
        // 截图也占用 viewport 队列，但并不重设 metrics。若把队列内 re-attach
        // 一律当作等效恢复而跳过，首张图会读到宿主缩放后的自然尺寸。
        // 已在临界区时直接重放；再次入队并等待自己会死锁。
        if (tab.insideViewportMutation) await replayViewport();
        // outsideViewportMutation 才入队，已经在临界区时再入队会等自己而死锁。
        else await this.enqueueViewportMutation(tab, replayViewport);
      } catch (error) {
        // viewport 重放失败同样先 warn 再 rollback，日志与状态必须成对。
        this.warn(`browser guest viewport replay failed tabId=${tab.tabId}`, error);
        // rollbackGuestCdpRestore 释放半途的 session，避免 attached=true 固化失败。
        this.rollbackGuestCdpRestore(tab, guest);
        // 抛原始 error 而不是包装，调用方按 error.message 排障。
        throw error;
      }
    }
    // 走到这里 Page.enable 与 viewport 都已就绪，日志里的 pageEnable=1 是完成标记。
    this.log?.(`[browser-use] cdp session state replayed tabId=${tab.tabId} pageEnable=1`);
  }

  /** 恢复失败时把半途 session 还原为释放态；rollback 自身的失败不得掩盖原始错误。 */
  // 回滚只清“本次恢复写入的状态”，不能 detach 整个 CDP：调用方可能仍需发送命令。
  // 回滚失败只 warn，它本身是失败路径的补偿，不能再次抛出掩盖原始错误。
  // [权衡] 上一句写的是回滚应止于「撤销本次恢复写入的状态」，当前实现是无条件 detach 本
  // guest 的 debugger session。可到达路径里 restore flight 只在 !isAttached() 时新建，
  // 因此这次 detach 就是撤销本次 attach，未观测到「拆掉调用方仍在用的会话」的触发条件；
  // 若将来新增「已 attach 的入口复用本函数」，必须先记录 attach 前状态再回滚，否则会拆掉别人的会话。
  private rollbackGuestCdpRestore(tab: ManagedTab, guest: GuestWebContents): void {
    try {
      if (guest.debugger.isAttached()) guest.debugger.detach();
    } catch {
      // session 可能已销毁；cdpAttached 复位仍需完成。
    }
    tab.cdpAttached = false;
  }

  /** 恢复命令专用发送：只做 pending 计数与下发，不触发 ensure（避免自等待死锁）。 */
  // 所有 CDP 命令的最终出口：必须递增 pendingCdpCommands 并在 finally 递减，
  // teardown 靠它判断“是否还有在途命令”。
  // [并发] 计数与 debugger.sendCommand 必须严格配对；提前 return 的分支也要在 finally 里减，
  // 否则计数永久 >0，detach 只能等超时。
  // 命令失败不在这里重试：重试会掩盖 guest 已崩溃的事实。
  private async sendGuestCdpCommandRaw(
    tab: ManagedTab,
    guest: GuestWebContents,
    method: string,
    params?: unknown,
    sessionId?: string,
  ): Promise<unknown> {
    tab.pendingCdpCommands += 1;
    try {
      const result = await guest.debugger.sendCommand(method, params, sessionId);
      if (!sessionId && tab.guest === guest) {
        // renderer 的归一化回调可能被 Electron 后续 page zoom 传播覆盖。
        // 固定 viewport 的设置和 CDP 重连都必须在同一执行边界恢复 guest zoom。
        // 条件里两个前缀缺一不可：!sessionId 排除 OOPIF 子会话（zoom 属于宿主 view，
        // 子会话复位会改错对象）；tab.guest === guest 排除换代，否则会把上一页的缩放
        // 状态写到新 guest 上，掩盖新页面自己的首条命令设置。
        if (method === "Emulation.setDeviceMetricsOverride" && guest.getZoomFactor() !== 1) {
          guest.setZoomFactor(1);
        }
      }
      return result;
    } finally {
      tab.pendingCdpCommands = Math.max(0, tab.pendingCdpCommands - 1);
      this.scheduleGuestCdpIdleRelease(tab);
    }
  }

  // 包装 raw 版本，额外做代际断言与超时：guest 在 await 期间可能被替换，直接发命令会
  // 落到新页面。断言失败按 backend_unavailable 返回，让调用方重试而不是误判页面错误。
  // 超时用 AbortSignal 触发，但不能取消底层 CDP（没有 API），只能放弃等待。
  // 顺序固定为先 assertCurrentGuest 再比 guest/lifecycle：前者带得出「请求已取消 / 代际
  // 不匹配」的具体原因，后者只会给出笼统的 detaching；反过来先撞后者会把排查引向错误的
  // 方向（看起来像正在卸载，实际是本次请求已被 abort）。
  private async sendGuestCdpCommand(
    tab: ManagedTab,
    guest: GuestWebContents,
    method: string,
    params?: unknown,
    sessionId?: string,
    assertCurrentGuest?: () => void,
  ): Promise<unknown> {
    assertCurrentGuest?.();
    if (tab.guest !== guest || tab.guestLifecycle !== "attached") {
      throw new Error("browser guest is detaching");
    }
    // turnEnded/closeSession/命令空闲后 CDP 已主动释放（防 guest
    // 销毁时的主进程 UAF），命令路径在此恢复式 re-attach 并 await 会话态重放完成（显式
    // 串行屏障：Page.enable / viewport override 先于本命令被 Chromium 处理）。
    if (!safeBool(() => guest.debugger.isAttached(), false) || tab.guestCdpRestoreFlight) {
      await this.ensureGuestCdpAttached(tab, guest);
    }
    return this.sendGuestCdpCommandRaw(tab, guest, method, params, sessionId);
  }

  // 把 guest 包装成 executor 需要的 ControlledView；这是唯一的“受控视图”适配层，
  // 所有页面操作都必须经它，保证 CDP 代际断言与 viewport 设置一致。
  // [失败路径] guest 已销毁时返回的 view 在调用时抛错，而不是构造时抛，便于调用方
  // 统一走 result 错误处理而不是 try/catch。
  private toControlledView(
    guest: GuestWebContents,
    normalizeScreenshotToCssPixels = false,
    captureViewportScreenshot: ControlledView["captureViewportScreenshot"] | undefined,
    assertCurrentGuest: () => void,
    sendCdpCommand: ControlledView["cdp"]["send"],
  ): ControlledView {
    const assertCurrent = () => assertCurrentGuest();
    return {
      webContents: {
        loadURL: (url) => {
          assertCurrent();
          return guest.loadURL(url);
        },
        getURL: () => {
          assertCurrent();
          return guest.getURL();
        },
        getTitle: () => {
          assertCurrent();
          return guest.getTitle();
        },
        canGoBack: () => {
          assertCurrent();
          return guest.navigationHistory.canGoBack();
        },
        canGoForward: () => {
          assertCurrent();
          return guest.navigationHistory.canGoForward();
        },
        goBack: () => {
          assertCurrent();
          return guest.navigationHistory.goBack();
        },
        goForward: () => {
          assertCurrent();
          return guest.navigationHistory.goForward();
        },
        reload: () => {
          assertCurrent();
          return guest.reload();
        },
        // userGesture=true 让脚本携带 user activation：站点把写操作/滚动绑在真实手势上时，
        // 不带手势的 evaluate 会被静默拒绝，命令报成功但页面没有任何变化。
        executeJavaScript: (script) => {
          assertCurrent();
          return guest.executeJavaScript(script, true);
        },
      },
      cdp: {
        send: (method, params, sessionId) => {
          try {
            assertCurrent();
            return sendCdpCommand(method, params, sessionId);
          } catch (error) {
            // CDP consumer 会在 abort/terminate 路径上直接调用 .catch；生命周期守卫必须
            // 返回 rejected Promise，不能同步 throw 破坏该清理链路。
            return Promise.reject(error);
          }
        },
      },
      captureViewportScreenshot,
      normalizeScreenshotToCssPixels,
      resizeScreenshotToCssPixels: this.resizeScreenshotToCssPixels,
    };
  }

  // 把新 tab 登记进 coordinator 并立即上报一次事实，否则 coordinator 在首次 report 前
  // 不知道它的存在，预算统计会漏。
  // 重复登记是幂等的：resume 路径可能对同一 tab 再调一次，不能重置 generation。
  // lastActivityAt 取 openedAt 而不是 now()：恢复出来的 tab 不该因为「刚登记」就变成最近
  // 活跃，否则 LRU 永远挑不到它，后台 tab 会一直堆积到预算硬顶。
  private registerTabResidency(
    tab: ManagedTab,
    visible: boolean,
    residency: BrowserTabResidencyRecord["residency"] = visible
      ? "live-visible"
      : "live-background",
    lastSelectedAt: number | null = null,
  ): void {
    this.residencyCoordinator.upsert({
      tabId: tab.tabId,
      windowId: tab.owner.windowId,
      sessionId: tab.owner.sessionId,
      residency,
      guestAttached: Boolean(tab.guest && !safeBool(() => tab.guest!.isDestroyed(), true)),
      openedAt: tab.openedAt,
      lastActivityAt: tab.openedAt,
      lastSelectedAt,
      preferred: visible,
      currentTask: false,
      selected: visible,
      visible,
      operationActive: false,
      captureActive: false,
      audible: false,
      mediaActive: false,
      loading: false,
      downloadActive: false,
    });
  }

  // 超预算时选择“最久未使用且非 active”的 tab 关闭，不能关 active：用户正在看的页面
  // 被关掉是明显 bug。关闭前再次确认它仍属于同一 scope，避免预算计算后 owner 已变。
  // [失败路径] 返回 false 表示没有可关的 tab，调用方应拒绝新建而不是无限超限。
  private async closeTabForLimit(record: BrowserTabResidencyRecord): Promise<boolean> {
    const tab = this.tabs.get(record.tabId);
    // 记录过期（tab 已不在 registry 或已关闭）不等于「没有可关的 tab」：返回 false 会让
    // 调用方拒绝新建，而实际预算早已低于上限，新建被永久卡死。这里的 true 只表示无需再关。
    if (!tab || tab.lifecycle === "closed") return true;
    try {
      // 旧的数量门禁只销毁 WebContents 并保留 suspended logical tab，
      // 因此标签栏会突破 32。必须复用 durable close，按“恢复数据 → guest → renderer tab 壳”
      // 的顺序完整关闭，避免已关闭 tab 在当前 UI 或下次启动时复活。
      await this.closeTabDurably(tab);
      this.log?.(
        `[browser-use] closed tabId=${tab.tabId} reason=tab-limit windowId=${tab.owner.windowId}`,
      );
      return true;
    } catch (error) {
      this.warn(`browser tab limit close failed tabId=${tab.tabId}`, error);
      return false;
    }
  }

  // 恢复 suspended guest 时先创建 restoreFlight 再真正恢复，保证并发命令共享同一结果。
  // flight 在 finally 删除并比较 identity，避免旧 flight 删掉新 flight。
  // [失败路径] 恢复失败要把 coordinator 回滚到 suspended，否则预算显示已驻留但实际没有 guest。
  private async restoreSuspendedGuest(
    tab: ManagedTab,
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    if (signal.aborted) return null;
    let flight = this.restoreFlights.get(tab.tabId);
    if (!flight) {
      // 旧 single-flight 直接采用首个 caller 的 AbortSignal；首个 command 取消会
      // 毒化所有并发 caller，并把 coordinator 留在 restoring。flight 改由 tab 生命周期拥有。
      flight = this.runRestoreSuspendedGuest(tab, new AbortController().signal).finally(() => {
        if (this.restoreFlights.get(tab.tabId) === flight) this.restoreFlights.delete(tab.tabId);
      });
      // 恢复 flight 与 attach flight 分离：恢复要驱动 coordinator generation，attach
      // 只是等 renderer 上报。合并会让 suspended 状态被 attach 提前清除。
      this.restoreFlights.set(tab.tabId, flight);
    }
    // 取消/超时只表示本轮调用方没等到结果：底层 restore flight 仍由 tab 生命周期继续
    // 推进（共享 flight 不能被单个 caller 的 signal 毒化），所以这里不能顺手回滚 coordinator。
    const result = await waitForPromiseWithSignal(flight, signal);
    return result.completed ? result.value : null;
  }

  // 真正的恢复流程：先让 coordinator 分配 generation，再驱动 renderer 重建 webview。
  // attach 回调若带旧 generation 必须拒绝并销毁 incoming guest，防止“恢复期间旧页面
  // 顶替新页面”。[事务] generation 的检查与 markAttached 必须在同一同步段。
  private async runRestoreSuspendedGuest(
    // tab 在整条恢复链上复用同一对象，中途重新查表会让 generation 与 guest 落到两份状态上。
    tab: ManagedTab,
    // signal 只控制本轮等待是否提前结束，底层 flight 由 tab 生命周期持有，不会被单次取消毒化。
    signal: AbortSignal,
  ): Promise<GuestWebContents | null> {
    // before 必须先取：markRestoring 之后状态已变，再判「是否从 suspended 进入」永远为 false。
    const before = this.residencyCoordinator.get(tab.tabId);
    // markRestoring 返回 undefined 说明该 tab 已被别的路径推进（live/销毁），本轮只能放弃。
    const transition = this.residencyCoordinator.markRestoring(tab.tabId);
    // 分配不到 generation 说明该 tab 已被别的路径推进（已 live 或已销毁），这不是恢复失败：
    // 返回 null 而不是 failRestore，否则会把一个刚恢复成功的 tab 重新打回 suspended。
    if (!transition) return null;
    // 只有从 suspended 进入才需要 renderer 重建 webview；从 restoring 重复进入不再发第二次请求，
    // 否则并发 restore 会各自拉起一个 webview，等到 attach 时争抢同一个 tab.guest。
    if (before?.residency === "suspended") {
      // generation 必须取 transition.generation（本轮分配值），不能取观测量：它是 renderer 与
      // attachGuest 共用的栅栏，取值不一致会让迟到的 attach 通过代际比对。
      const payload: BrowserViewResidencyTransitionPayload = {
        tabId: tab.tabId,
        workspaceKey: tab.owner.workspaceKey,
        remoteSessionId: tab.owner.remoteSessionId,
        sessionId: tab.owner.sessionId,
        browserId: tab.owner.browserId,
        browserGeneration: tab.owner.browserGeneration,
        generation: transition.generation,
        residency: "restoring",
      };
      // 优先走 onRestoreTabRequested：它带完整 payload，旧装配只有 onOpenTabRequested 时才退回两参形式。
      if (this.residencyOptions.onRestoreTabRequested) {
        // payload.generation 必须来自 transition，renderer 会原样带回 attach，取值不一致会让 attach 判 mismatch。
        this.residencyOptions.onRestoreTabRequested(payload);
      } else {
        // 旧回调拿不到 generation，只能靠 tabId+owner 让 renderer 重建，代际校验由 attachGuest 侧补。
        this.onOpenTabRequested?.(tab.tabId, tab.owner);
      }
    }

    // waitForGuest 只等本 tab 的 attach，超时/取消/被抢都返回 null，三种情况走同一条失败收口。
    const guest = await this.waitForGuest(tab.tabId, signal);
    // 拿不到 guest 必须 failRestore：不推进 generation 的话，迟到的旧 guest 还能占住 tab（INV-20）。
    if (!guest) {
      // 超时/取消/代际被抢都走这里：failRestore 会推进 generation 并降回 suspended，
      // 新 generation 让本轮迟到的 attach 在 attachGuest 处被判 generation-mismatch。
      const failed = this.residencyCoordinator.failRestore(tab.tabId, transition.generation);
      // failed 为空说明 generation 已被并发路径替换，此时再发 suspend 通知会把新状态误报成挂起。
      if (failed) {
        // 通知 renderer 回到轻量 shell；新 generation 同时让本轮迟到 attach fail closed。
        // 回退通知用 failed.generation（比本轮请求更大）：renderer 据此丢弃本轮迟到的 attach 结果，
        // 用 transition.generation 会让新旧两轮在同一个代际上竞争。
        // 通知在 failRestore 之后发：先发会让 renderer 在 coordinator 回退前就重建，代际对不上。
        this.residencyOptions.onSuspendTabRequested?.({
          tabId: tab.tabId,
          workspaceKey: tab.owner.workspaceKey,
          remoteSessionId: tab.owner.remoteSessionId,
          sessionId: tab.owner.sessionId,
          browserId: tab.owner.browserId,
          browserGeneration: tab.owner.browserGeneration,
          generation: failed.generation,
          residency: "suspended",
        });
      }
      // 返回 null 表示本轮没拿到 guest；是否重试由 tab 生命周期上的 flight 决定。
      return null;
    }
    // restored=false 有两种来源：无可恢复事实或导航失败，所以下面按 restoredFromStore 分流。
    const restored = await this.restoreGuestState(tab, guest);
    // 三个条件同时成立才判孤儿：普通淘汰仍留 cachedUrl，误判会形成 restore/close 循环。
    if (!restored && tab.restoredFromStore && !tab.cachedUrl) {
      // 仅 forced restore mount 后三类恢复事实全部缺失才清理孤儿；普通 page-state 淘汰
      // 仍会保留 restoreUrl，不得进入这个分支形成 restore/close 循环。
      // 先删恢复仓库再关 tab：顺序反了会让 shell 留在磁盘上，下次启动又恢复出同一条孤儿。
      await this.removeTabRecovery(tab);
      // 通知 renderer 关闭孤儿必须在删恢复仓库之后、closeTab 之前，顺序反了会留下残留 shell。
      this.residencyOptions.onRecoveryOrphanCloseRequested?.({
        tabId: tab.tabId,
        reason: "recovery-orphan",
      });
      // notifyRenderer=false：renderer 已收到 orphan 通知，再发一次关闭会重复弹提示。
      this.closeTab(tab, false);
      // 孤儿路径返回 null 而不是 guest：调用方不能对即将关闭的 tab 继续下发命令。
      return null;
    }
    // 这里覆盖「有 URL 但导航失败」：只处理事实全缺会让 bootstrap 页被当成成功页面提交 live。
    if (!restored) {
      // 不能只处理“恢复事实全缺失”：history 与 URL 都失败时仍提交 live 的话，
      // bootstrap/about:blank 因而被永久当成成功页面。失败必须销毁本轮 guest 并回到可重试 shell。
      const failed = this.residencyCoordinator.failRestore(tab.tabId, transition.generation);
      // 先销毁本轮 guest 再发 suspend：留着活 guest 会让下一轮 waitForGuest 拿到旧句柄。
      this.detachAndCloseGuest(tab);
      // failed 为空时 generation 已换代，发挂起通知会覆盖并发路径刚写入的状态。
      if (failed) {
        this.residencyOptions.onSuspendTabRequested?.({
          tabId: tab.tabId,
          workspaceKey: tab.owner.workspaceKey,
          remoteSessionId: tab.owner.remoteSessionId,
          sessionId: tab.owner.sessionId,
          browserId: tab.owner.browserId,
          browserGeneration: tab.owner.browserGeneration,
          generation: failed.generation,
          residency: "suspended",
        });
      }
      // 恢复失败返回 null，tab 留在 suspended，等 renderer 下一次 resume 重新发起。
      return null;
    }
    // 提交失败只可能是 generation 已被并发路径替换（例如 suspend 抢先），页面已由对方接管，
    // 这时不能再发终态通知，否则 renderer 会收到一个过期的 live 状态。
    if (!this.residencyCoordinator.completeRestore(tab.tabId, transition.generation)) return null;
    // completeRestore 之后再读快照：终态以 coordinator 实际值为准，不能假设一定就是 live。
    const completed = this.residencyCoordinator.get(tab.tabId);
    // 快照可能已被并发改成 suspended，此时不发终态，避免覆盖更新的状态。
    if (completed) {
      // renderer 原来只收到 restoring 起点，成功后没有终态，会永久保留 restoring shell。
      this.residencyOptions.onResidencyChanged?.({
        tabId: tab.tabId,
        workspaceKey: tab.owner.workspaceKey,
        remoteSessionId: tab.owner.remoteSessionId,
        sessionId: tab.owner.sessionId,
        browserId: tab.owner.browserId,
        browserGeneration: tab.owner.browserGeneration,
        generation: completed.generation,
        // 终态只允许两档：restoring/suspended 不在这条通道上，原样回传会让 renderer 收到一个
        // 既非 live-visible 也非 live-background 的状态并停在 restoring 占位。
        residency: completed.residency === "live-visible" ? "live-visible" : "live-background",
      });
    }
    // 成功恢复后清掉孤儿标记：不清的话下一次普通 page-state 淘汰会被误判成 recovery-orphan。
    tab.restoredFromStore = false;
    // [可达性] persistShell 在未注入 recoveryStore 的生产装配里首行就 return，这里只是空操作；
    // 恢复本身（重建 webview + loadURL）不依赖存储，进程内 suspend/resume 仍然可用（D-9-4）。
    await this.persistShell(tab);
    // 成功返回已挂载的 guest，调用方据此进入命令下发；null 才代表本轮失败。
    return guest;
  }

  // 恢复 pageState 前必须校验它与 shell URL 一致：历史条目可能因重定向/站点变化失效，
  // 强行 restore 会得到空白页或错误页面。
  // 失败时回退到 loadURL(cachedUrl)，并返回 false 让调用方决定是否重试。
  private async restoreGuestState(tab: ManagedTab, guest: GuestWebContents): Promise<boolean> {
    // [可达性] 生产未注入 recoveryStore 会让 getPageState 恒为 undefined，因此下面整段 pageState
    // 校验与 navigationHistory.restore 都不会执行；恢复退化为末尾的 loadURL(cachedUrl)，
    // 多步历史会塌成单页。进程内 suspend/resume 仍能恢复 URL（D-9-4）。
    const pageState = await this.residencyOptions.recoveryStore?.getPageState(tab.tabId);
    // entries 为空等同于没有快照：navigationHistory.restore 传空历史会清掉当前页。
    if (pageState && pageState.entries.length > 0) {
      // activeIndex 由快照写入方保证有效，这里仍用可选链兜底，越界时按「无快照」处理。
      const activePageState = pageState.entries[pageState.activeIndex];
      // 只有两侧都有 URL 才比对，cachedUrl 为空时不能凭快照猜路径。
      if (tab.cachedUrl && activePageState?.url !== tab.cachedUrl) {
        // pageState 只在预算挂起时刷新；恢复后导航会更新 shell，却留下旧快照。
        // 冷启动必须以 logical shell 的当前 URL 为准，不能把 B 回滚成快照里的 A。
        this.warn(
          `browser tab stale page-state ignored tabId=${tab.tabId} shellUrl=${tab.cachedUrl} pageStateUrl=${activePageState?.url ?? "missing"}`,
        );
        // 丢弃过期快照必须真删：留在仓库里下次恢复还会再命中同一条旧记录（INV-17）。
        await this.residencyOptions.recoveryStore?.removePageState(tab.tabId);
      } else {
        // 接受快照时回写 cachedUrl/cachedTitle：renderer 的标签标题与地址栏都读这两个字段。
        const acceptRestoredPageState = () => {
          // 重新按 activeIndex 取条目：restore 后条目顺序可能已被 Chromium 归一化。
          const active = pageState.entries[pageState.activeIndex];
          // 快照缺 URL 时保留旧值：写成空串会让下一次恢复走到「无 URL」的失败分支。
          tab.cachedUrl = active?.url ?? tab.cachedUrl;
          // 标题同理，快照条目里 title 可能为空，不能被当成「确实无标题」。
          tab.cachedTitle = active?.title ?? tab.cachedTitle;
          // 返回 true 才允许调用方 completeRestore，避免无页面事实的 tab 被提交为 live。
          return true;
        };
        try {
          // 恢复前先记录 entries：失败日志里才能区分「历史条目不匹配」与「导航抛错」。
          this.log?.(
            `[browser-use] restore page-state start tabId=${tab.tabId} index=${pageState.activeIndex} entries=${JSON.stringify(pageState.entries.map((entry) => entry.url))}`,
          );
          // 传拷贝而不是原数组：Electron 会改写传入对象，复用快照会让下一次恢复拿到归一化后的数据。
          await guest.navigationHistory.restore({
            entries: pageState.entries.map((entry) => ({ ...entry })),
            index: pageState.activeIndex,
          });
          // 成功后回读 getURL/activeIndex：以 native 实际值为准，restore 可能被重定向改写。
          this.log?.(
            `[browser-use] restore page-state complete tabId=${tab.tabId} url=${safeStr(() => guest.getURL(), "")} index=${safeStr(() => String(guest.navigationHistory.getActiveIndex()), "unknown")} entries=${safeStr(() => JSON.stringify(guest.navigationHistory.getAllEntries().map((entry) => entry.url)), "unknown")}`,
          );
          // 正常路径也要走 accept 回写，否则 cachedUrl 与实际页面不一致。
          return acceptRestoredPageState();
        } catch (error) {
          // ERR_ABORTED 不代表失败：Electron 41 会在历史已写入后仍报默认 about:blank 被取消。
          const restoreAppliedDespiteAbort =
            String(error).includes("ERR_ABORTED") &&
            safeBool(() => {
              // 以实际历史为准判定是否已生效：错误码不足以证明 restore 成功。
              const actualEntries = guest.navigationHistory.getAllEntries();
              // 三项必须同时相等（index、条数、逐条 URL），任一项不符就不能判定 restore 已生效。
              return (
                guest.navigationHistory.getActiveIndex() === pageState.activeIndex &&
                actualEntries.length === pageState.entries.length &&
                actualEntries.every((entry, index) => entry.url === pageState.entries[index]?.url)
              );
            }, false);
          // 已生效就不清 pageState：删掉会让下一次恢复少一段历史。
          if (restoreAppliedDespiteAbort) {
            // Electron 41 会在完整历史已写入后，仍以 ERR_ABORTED 报告默认 about:blank 被取消。
            // 以实际 navigationHistory 为准，避免误删有效 pageState 并发起第二次 URL 导航。
            return acceptRestoredPageState();
          }
          // 真正失败才告警并删快照；日志带 tabId，便于按 tab 追踪重复失败。
          this.warn(`browser tab page-state restore failed tabId=${tab.tabId}`, error);
          // 失败快照必须删除，否则每次恢复都会重试同一条坏数据。
          await this.residencyOptions.recoveryStore?.removePageState(tab.tabId);
        }
      }
    }
    // 没有任何可恢复 URL 时必须返回 false：loadURL("") 会落到 about:blank，
    // 调用方会把空白页当成恢复成功并提交 live（见上面对 bootstrap 页的说明）。
    if (!tab.cachedUrl) return false;
    try {
      // 快照路径失败后退回单页 loadURL，这是恢复的最终兜底。
      await guest.loadURL(tab.cachedUrl);
      // loadURL 成功即视为恢复完成：此时没有历史，但页面事实有效。
      return true;
    } catch (error) {
      // loadURL 失败必须返回 false，让调用方 failRestore 而不是提交一个空白页。
      this.warn(`browser tab URL restore failed tabId=${tab.tabId}`, error);
      // false 会触发 detachAndCloseGuest 与 suspend 通知，是本函数唯一的失败出口。
      return false;
    }
  }

  private async restoreReboundGuest(
    tab: ManagedTab,
    guest: GuestWebContents,
  ): Promise<GuestWebContents | null> {
    // 入口先验身份：重建请求可能在上一个 guest 已被替换后才到达，此时不能再拿旧 guest
    // 写 navigationHistory，否则会把历史写进一个即将析构的对象。
    if (tab.lifecycle === "closed" || tab.guest !== guest) return null;
    const restored = await this.restoreGuestState(tab, guest);
    // await 期间 tab 可能被关闭；lifecycle 是可变字段，重新读取以撤销上面的收窄。
    const lifecycleAfterRestore = tab.lifecycle as TabLifecycle;
    if (!restored || lifecycleAfterRestore === "closed" || tab.guest !== guest) {
      if (lifecycleAfterRestore !== "closed" && tab.guest === guest) {
        this.warn(`browser tab guest rebind restore failed tabId=${tab.tabId}`);
      }
      return null;
    }
    this.log?.(
      `[browser-use] guest rebind restore complete tabId=${tab.tabId} url=${tab.cachedUrl}`,
    );
    await this.persistShell(tab);
    return guest;
  }

  // 快照写入顺序是 shell → pageState：崩溃可能发生在两次写之间，先有 shell 至少能
  // 恢复 URL。pageState 包含导航历史，体积大且易与 shell 不一致，必须最后写。
  // [事务] 两次写之间不能 await 业务逻辑，避免中间态被其它路径读到。
  private async persistRecoverySnapshot(tab: ManagedTab, guest: GuestWebContents): Promise<void> {
    tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
    tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
    await this.persistShell(tab);
    try {
      const entries = guest.navigationHistory.getAllEntries().map((entry) => ({ ...entry }));
      if (entries.length === 0) return;
      const pageState: BrowserTabPageStateRecord = {
        schemaVersion: 1,
        tabId: tab.tabId,
        entries,
        activeIndex: guest.navigationHistory.getActiveIndex(),
        updatedAt: this.now(),
      };
      await this.residencyOptions.recoveryStore?.upsertPageState(pageState);
    } catch (error) {
      // 快照失败不能让资源预算永久突破；shell 的 restoreUrl 已先保存。
      this.warn(`browser tab page-state snapshot failed tabId=${tab.tabId}`, error);
    }
  }

  // 只写 shell 的轻量路径，用于 attach/导航等高频事件；它不能覆盖 pageState。
  // 存储失败只 warn：恢复是增强能力，不能阻断命令。
  // 频率控制交给 recoveryStore.whenIdle，管理器不做节流，避免丢最后一次写入。
  // [可达性] 生产装配未注入 recoveryStore，第一行的 store 判空会直接返回，
  // 本函数与 persistRecoverySnapshot 的落盘分支在当前生产路径中不执行；见 D-9-4。
  private async persistShell(tab: ManagedTab): Promise<void> {
    const store = this.residencyOptions.recoveryStore;
    if (!store || tab.lifecycle === "closed") return;
    const residency = this.residencyCoordinator.get(tab.tabId);
    // windowBindingId 必须写 null：跨进程恢复时无法预知将来落在哪个窗口，写死会把它绑回旧窗口。
    // viewport 只能持久化显式 override：backgroundViewportFallback 是运行态临时值，
    // 落盘会让下次启动把“曾经的后台尺寸”当成用户布局，从而跳过自然尺寸回退。
    const record: BrowserTabShellRecord = {
      schemaVersion: 1,
      tabId: tab.tabId,
      windowBindingId: null,
      workspaceKey: tab.owner.workspaceKey,
      ...(tab.owner.remoteSessionId ? { remoteSessionId: tab.owner.remoteSessionId } : {}),
      sessionId: tab.owner.sessionId,
      browserId: tab.owner.browserId,
      browserGeneration: tab.owner.browserGeneration,
      origin: tab.origin,
      lifecycle: tab.lifecycle,
      restoreUrl: tab.cachedUrl || null,
      title: tab.cachedTitle || null,
      faviconUrl: tab.cachedFaviconUrl,
      viewport: tab.viewportOverride ? { ...tab.viewportOverride } : null,
      openedAt: tab.openedAt,
      lastSelectedAt: residency?.lastSelectedAt ?? null,
      updatedAt: this.now(),
    };
    try {
      await store.upsert(record);
    } catch (error) {
      this.warn(`browser tab shell persist failed tabId=${tab.tabId}`, error);
    }
  }

  private requireRendererOwnedTab(
    payload: BrowserViewCloseTabRequest & { windowId: number },
    options?: { skipRemoteSession?: boolean },
  ): ManagedTab;
  private requireRendererOwnedTab(
    payload: BrowserViewResidencyReportPayload & { windowId: number },
    options?: { skipRemoteSession?: boolean },
  ): ManagedTab;
  private requireRendererOwnedTab(
    payload:
      | (BrowserViewCloseTabRequest & { windowId: number })
      | (BrowserViewResidencyReportPayload & { windowId: number }),
    options?: { skipRemoteSession?: boolean },
  ): ManagedTab {
    const tab = this.tabs.get(payload.tabId);
    if (
      !tab ||
      tab.lifecycle === "closed" ||
      tab.owner.windowId !== payload.windowId ||
      tab.owner.workspaceKey !== payload.workspaceKey ||
      tab.owner.sessionId !== payload.sessionId ||
      (!options?.skipRemoteSession &&
        (tab.owner.remoteSessionId ?? "") !== (payload.remoteSessionId ?? ""))
    ) {
      // 鉴权失败统一抛同一句话，不区分“不存在/窗口不符/会话不符”：区分会让调用方
      // 探测其它窗口的 tab 是否存在。异常由 IPC 层转成 tab_not_found。
      // skipRemoteSession 只给 closeTabFromRenderer 这类“关闭收敛”路径用：操作与 attach
      // 必须严格比对该字段，否则重连后的旧 runtime 能操作新会话的 tab。
      throw new Error(`browser tab '${payload.tabId}' is unavailable for renderer scope`);
    }
    return tab;
  }

  // 监听 media-started/stopped 与音频状态，用于资源管理器判断 tab 是否值得保活。
  // 回调必须按 tabId + guest 双重校验：旧 guest 的迟来事件不能改写新 tab 的 mediaActive。
  // cleanup 随 detach 注销，否则换代后事件会累积并持有旧 tab 引用。
  private setupActivityTracking(tab: ManagedTab, guest: GuestWebContents): void {
    // 先解绑上一任 guest 的监听：重复注册会让 events 累积并持有旧 tab 引用（INV-27）。
    tab.activityCleanup?.();
    // 测试替身可能没有 EventEmitter 接口，直接返回而不是抛错，避免 attach 因测试桩失败。
    if (!guest.on || !guest.removeListener) return;
    // 每个回调都闭包捕获 guest：身份比对用它，不能用 tab.guest 反查。
    const onLoadingStarted = () => {
      // 旧 guest 的迟到事件不能改写新 tab 的 loading，否则新页面会被标记成加载中。
      if (tab.guest !== guest) return;
      // loading 参与 runtime protection 判定，置真必须和 refresh 同段完成。
      tab.loading = true;
      // 每次状态翻转都重算保护：批量命令期间漏一次就会让页面被后台节流。
      this.refreshRuntimeProtection(tab.tabId);
    };
    // stop 是唯一能安全回写 cachedUrl 的时机：加载中读 getURL 会拿到上一页地址。
    const onLoadingStopped = () => {
      // 同 loading 的守卫：换代的旧事件不能清掉新 guest 的 loading。
      if (tab.guest !== guest) return;
      // 置 false 后立刻可能触发挂起判定，所以下面必须同步刷新保护与持久化。
      tab.loading = false;
      // 恢复 flight 在飞时禁止回写：此时 guest 是临时页面，写进去会覆盖 logical cache（INV-18）。
      if (!this.guestRecoveryFlights.has(tab.tabId)) {
        // 恢复 flight 在飞时不能回写：此时 guest 是临时页面，它的 URL/title 会覆盖 logical cache（INV-18）。
        tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
        // 标题与 URL 一起回写：只写一个会让快照出现「新地址配旧标题」的错配。
        tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
      }
      // 加载结束后保护条件可能全部消失，必须重算才能释放 CDP。
      this.refreshRuntimeProtection(tab.tabId);
      // 落盘不 await：导航结束是高频事件，串行等待会拖慢渲染进程回调。
      void this.persistShell(tab);
    };
    // 音频事件不做身份比对：它不写 tab 字段，只让 refreshRuntimeProtection 重读当前 guest 的
    // 状态；换代瞬间最多多报一次，下一次事件就会把读数纠正回来。
    const onAudioChanged = () => this.refreshRuntimeProtection(tab.tabId);
    // media 事件只维护 mediaActive，不读 URL/title，所以不需要额外的恢复态判断。
    const onMediaStarted = () => {
      // 旧 guest 的播放事件不能让新 tab 被标记为活跃媒体。
      if (tab.guest !== guest) return;
      // mediaActive=true 会阻止挂起，误置会让页面永久保活。
      tab.mediaActive = true;
      // 媒体状态变化必须立即重算，否则录制/截图期间会被节流。
      this.refreshRuntimeProtection(tab.tabId);
    };
    // paused 只覆盖「暂停」，不是结束：页面可能随时继续播放，不能据此清 activity。
    const onMediaPaused = () => {
      // 同 started 的守卫：换代后的迟到 paused 不能清掉新 guest 的媒体标记。
      if (tab.guest !== guest) return;
      // 置 false 是释放保活的唯一信号，漏掉会让 runtime protection 永远保持开启。
      tab.mediaActive = false;
      // 暂停后立即重算，确保挂起判定能马上看到 mediaActive=false。
      this.refreshRuntimeProtection(tab.tabId);
    };
    // 五个监听必须一次注册完：漏一个会让对应状态永远停在初值。
    guest.on("did-start-loading", onLoadingStarted);
    // stop 监听是 cachedUrl 与持久化的唯一写入口，缺它标签地址永远不更新。
    guest.on("did-stop-loading", onLoadingStopped);
    // audio 事件不复用 media 的 identity 判断，它只触发重算，不写 tab 字段。
    guest.on("audio-state-changed", onAudioChanged);
    // 播放事件只在真正出声时触发，与 media-paused 成对，缺一不可。
    guest.on("media-started-playing", onMediaStarted);
    // 暂停事件同样必须注册，否则 mediaActive 只能置真不能复位。
    guest.on("media-paused", onMediaPaused);
    // cleanup 存进 tab 而不是返回：detachGuest 没有上下文拿返回值，只能从 tab 上取。
    tab.activityCleanup = () => {
      // 逐个按函数引用解绑：用 removeAllListeners 会连带摘掉别的模块的监听。
      guest.removeListener?.("did-start-loading", onLoadingStarted);
      // stop 监听持有 persistShell 引用，不解绑会拖住整个 manager。
      guest.removeListener?.("did-stop-loading", onLoadingStopped);
      // audio 监听虽不写状态，也会让 guest 持有 manager 的闭包。
      guest.removeListener?.("audio-state-changed", onAudioChanged);
      // 播放监听必须与注册成对，否则旧 guest 销毁后仍能触发 protection 重算。
      guest.removeListener?.("media-started-playing", onMediaStarted);
      // paused 同理，漏解绑会让 mediaActive 被旧事件反复置假。
      guest.removeListener?.("media-paused", onMediaPaused);
    };
  }

  // 通知 Electron 对该 guest 的 renderer 采取/解除保护（如阻止后台节流）。
  // 保护条件包含录制、截图、有在途命令；漏掉任一条件会让页面在后台被 throttle，
  // 录制的帧率突变。它必须在状态变化后调用，不能只在 tab 创建时调用一次。
  private refreshRuntimeProtection(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.residencyCoordinator.report(tabId, {
      loading: tab.loading,
      operationActive: this.hasRunningRequestForTab(tabId),
      captureActive: this.isTabCaptureActive(tab),
      audible: safeBool(() => tab.guest?.isCurrentlyAudible?.() ?? false, false),
      mediaActive: tab.mediaActive,
      downloadActive: this.hasPendingDownloadForTab(tabId),
    });
  }

  // 只统计 dispatched 且未 abort 的请求：已取消但尚未 finally 的请求不应阻止 detach，
  // 否则取消后 teardown 仍要等它。
  // 遍历 runningRequests 是 O(n)，但 n 是并发命令数（个位数），所以可接受。
  // 实现只按 tabId 过滤，未检查 dispatched/aborted，会把已取消但仍未 finally 的请求继续算作
  // 活跃——偏差见 D-9-1；上面两句必须保留为水位，判断实际行为时以本函数的实现为准。
  private hasRunningRequestForTab(tabId: string): boolean {
    return [...this.runningRequests.values()].some((request) => request.tabId === tabId);
  }

  // 截图活跃包括“命令在跑”和“已放弃但底层未结算”两种，后者同样占用 compositor。
  // 只用 tracker 判断会漏掉 abandoned 计数，导致 teardown 在 capture 未结束时销毁 guest。
  // 但下面这个判定并未读取 abandonedScreenshotCaptures，保护链在此断开——偏差见 D-9-6；
  // 因此上面那句意图保留作为水位，不会按现状改写。
  private isTabCaptureActive(tab: ManagedTab): boolean {
    return (
      this.inFlightScreenshots.has(tab.tabId) ||
      [...this.recordings.values()].some(
        (entry) => entry.tabId === tab.tabId && entry.status === "running",
      ) ||
      safeBool(() => tab.guest?.isBeingCaptured?.() ?? false, false)
    );
  }

  // 有 pending 下载时不能关闭 guest：session 销毁会中断下载并留下半截文件。
  // 只看 state=pending，completed/cancelled 不应阻止 teardown。
  private hasPendingDownloadForTab(tabId: string): boolean {
    return [...this.downloads.values()].some(
      (record) => record.tabId === tabId && record.state === "pending",
    );
  }

  // 先 detach CDP 再 close WebContents：反序会让 debugger 随 WebContents 隐式析构。
  // 同步版本只能用于已知安全时机（tab 已 closed、renderer 已发 ACK），异步 teardown 则用于需要等待在途命令的场景。
  private detachAndCloseGuest(tab: ManagedTab): void {
    const guest = tab.guest;
    // 先保存引用：detachGuest 会触发 cleanup 与 destroyed 回调，最后再读 tab.guest 可能已为空
    // 或指向新 guest，旧 WebContents 就漏关了。
    // 先 close 会让 destroyed 事件与后续 listener cleanup 都落在已销毁对象上，
    // Electron 会持续打印 "Object has been destroyed"。先拆 CDP/session/listener，再关闭保存的
    // WebContents 引用，既释放真实 renderer，也不会改变 logical tab 的生命周期。
    this.detachGuest(tab);
    this.closeGuestWebContents(tab, guest);
  }

  // 拒绝 attach 时必须关闭 incoming guest，并保留 tab 现有 guest 不变：不能因为一次
  // 非法 attach 就把正在工作的页面拆掉。
  // reason 原样返回给 renderer，便于它决定是重试还是重建。
  private rejectGuestAttach(
    tab: ManagedTab,
    guest: GuestWebContents,
    reason: BrowserGuestAttachRejectReason,
  ): BrowserGuestAttachResult {
    // scope/session 不匹配过去只 return，renderer 不知道拒绝原因，waitForGuest
    // 只能等满 timeout；同时被拒绝的 incoming guest 没有统一清理，可能留下 orphan WebContents。
    const recoveryRequested = this.requestGuestRebind(tab, reason);
    // 只有 incoming 没被 tab 收养时才关：并发 attach 可能已把它写进 tab.guest，盲关会把
    // 刚接管的页面拆掉，留下一个指向已销毁对象的 tab。
    if (tab.guest !== guest) this.closeGuestWebContents(tab, guest);
    return { ok: false, reason, recoveryRequested };
  }

  // 重绑是“请 renderer 换一个 webview”的请求，不是状态迁移；必须先置 rebindRequested
  // 防止重复请求刷屏，再由 renderer 的 ready 事件真正 attach。
  // 已被挂起/关闭的 tab 不重绑：那会把刚释放的资源重新拉起。
  private requestGuestRebind(tab: ManagedTab, reason: GuestRecoveryReason): boolean {
    tab.attachFailure = reason;
    // attachFailure 必须在三个早退之前写：即使不重绑，也要让后续 summary 与重试看到最近一次失败原因。
    if (tab.lifecycle === "closed" || tab.rebindRequested || !this.onOpenTabRequested) return false;
    tab.rebindRequested = true;
    this.log?.(`[browser-use] request guest rebind tabId=${tab.tabId} reason=${reason}`);
    this.onOpenTabRequested?.(tab.tabId, tab.owner);
    return true;
  }

  // 关闭 guest 只做 WebContents.close，不负责清 tab 字段；调用方必须随后 detachGuest
  // 或已确认 tab 关闭。默认参数允许传入 incoming guest，用于拒绝 attach 时清理。
  // 关闭本身可能同步触发 destroyed 回调，因此不能在回调里再 close 同一对象。
  private closeGuestWebContents(tab: ManagedTab, guest = tab.guest): void {
    if (!guest || safeBool(() => guest.isDestroyed(), true)) return;
    try {
      // 不等 beforeunload：站点可以用它无限拖延，teardown 会被一条页面脚本永久挂起。
      guest.close({ waitForBeforeUnload: false });
    } catch (error) {
      this.warn(`browser guest close failed tabId=${tab.tabId}`, error);
    }
  }

  // 统一时间源，供 startedAt/elapsedMs 使用；与 recordingNow 分开是因为录制可注入
  // 独立时钟做测试，而命令时延必须用真实时钟保证错误信息可信。
  // 不能缓存返回值，每次调用重新取。
  private now(): number {
    return this.residencyOptions.now?.() ?? Date.now();
  }

  // 统一日志出口：第二参数存在时打印堆栈，否则只打印消息。所有“不应失败但可能失败”
  // 的路径都必须经它，不能用 console，方便测试注入与生产日志分级。
  // 不能在 warn 里抛错，否则会把可恢复问题升级成崩溃。
  private warn(message: string, error?: unknown): void {
    const suffix =
      error === undefined ? "" : ` error=${error instanceof Error ? error.message : String(error)}`;
    this.residencyOptions.warn?.(`${message}${suffix}`);
    this.log?.(`[browser-use] ${message}${suffix}`);
  }

  // 按 key 主动断开 CDP，供 renderer 在销毁 webview 前调用（第二道屏障）。
  // 只 detach 不关 tab：tab 的 logical 状态与恢复快照仍要保留。
  // 必须在等待在途命令前先标记 detaching，防止新命令 attach 回来。
  // detachGuest 全部同步完成：字段清空与 lifecycle 落到 detached 之间没有 await，
  // 新命令不会在中间插入；未知 key 必须静默返回，否则 renderer 关闭后重发屏障会多一条报错。
  detach(key: string): void {
    const tab = this.tabs.get(key);
    if (tab) this.detachGuest(tab);
  }

  /**
   * renderer 即将用 React key 替换 `<webview>` 时，先关闭旧 guest 的 native CDP 通路。
   *
   * Electron 的 `render-process-gone` 并非每次都会先到达 main 的 WebContents
   * 监听；renderer 若直接卸载节点，`destroyed` 才到达时已无法调用 debugger.detach()，
   * DevToolsSession 仍可能向已析构 client 派发在途通知并触发主进程 UAF。这里把 DOM 销毁
   * 变成 main ACK 之后的第二阶段，并用 sender window + 当前 guest id 双重校验，避免迟到
   * 的旧代事件断开刚接管 tab 的新 guest。
   */
  // renderer 重建 webview 前的显式 detach：必须等 in-flight CDP 收敛并拿到 ACK，
  // 再允许 DOM 卸载。超时也要返回，让 renderer 继续销毁而不是永久卡住。
  // [事务] flight 去重：同一 guest 的重复 ACK 共享同一个 detach 结果。
  async detachGuestBeforeReplacement(
    // tabId 由 renderer 上报，必须再用 windowId 与 guest.id 双重校验，不能只信 id。
    tabId: string,
    // webContentsId 是 renderer 看到的 guest id，与 tab.guest.id 比对通过才继续。
    webContentsId: number,
    // windowId 用于确认调用方窗口拥有该 tab，跨窗口的 tabId 一律拒绝。
    windowId: number,
  ): Promise<boolean> {
    // tabs.get 返回 undefined 说明 tab 已关闭或从未存在，两种都按幂等成功处理。
    const tab = this.tabs.get(tabId);
    // 未知 tab 按“已拆完”返回：renderer 可能持有已关闭 tab 的 id，回 false 会让它永远停在
    // 重建前的等待里，而那个 ACK 事件不会再来。
    if (!tab) return true;
    // owner.windowId 不符说明调用方拿错了 tabId，回 false 阻止它继续销毁 DOM。
    if (tab.owner.windowId !== windowId) {
      // window-mismatch 日志带 tabId 与 guestId，便于反查是哪个 renderer 报错。
      this.log?.(
        `[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} ` +
          `guestId=${webContentsId} reason=window-mismatch`,
      );
      // 返回 false 而不是「当作已 detach」：调用方是另一个窗口的 renderer，它拿错了 tabId，
      // 回 true 会让它以为已安全卸载并继续销毁 DOM，而本 tab 的 guest 与 CDP 其实一条都没断。
      return false;
    }

    // tab.guest 为 null 表示已经拆完，幂等返回 true 让 renderer 继续重建。
    const guest = tab.guest;
    // 没有 guest 就是已经拆完了：这是幂等返回，不是失败。回 false 会让 renderer 卡在重建前
    // 的等待里，而它等的事件永远不会再来。
    if (!guest) return true;
    // safeBool 包住 guest.id 访问，guest 处于析构中时属性读取本身可能抛错。
    const guestIdMatches = safeBool(() => guest.id === webContentsId, false);
    // id 不符说明 renderer 报的是上一代 webContents，当前 guest 仍活着。
    if (!guestIdMatches) {
      // guest-mismatch 时不能继续拆，否则等于替迟到的重建杀掉新 guest。
      this.log?.(
        `[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} ` +
          `guestId=${webContentsId} reason=guest-mismatch`,
      );
      // id 对不上说明 renderer 报的是上一代 webContents：真正要拆的旧 guest 已经不在了，
      // 而当前 guest 还活着。此时若继续拆，等于替一次迟到的重建杀掉新 guest。
      return false;
    }
    // isDestroyed 为 true 时 native detach 已无安全窗口，只剩 cdpAttached 需要确认。
    if (safeBool(() => guest.isDestroyed(), true)) {
      // destroyed 后 native detach 已经没有安全窗口；只有先前确认过 CDP 已断开才允许换代。
      if (tab.cdpAttached) {
        // destroyed-with-cdp 说明还有未断的调试会话，回 false 让上层先处理。
        this.log?.(
          `[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} ` +
            `guestId=${webContentsId} reason=destroyed-with-cdp`,
        );
        // 返回 false 而不是抛错，renderer 需要区分「拒绝」与「异常」两种结果。
        return false;
      }
      // cdpAttached 为 false 才走 detachGuest，这条路径不会进入 teardown flight。
      this.detachGuest(tab);
      // detachGuest 后返回 true，tab 已断干净可以安全卸载 DOM。
      return true;
    }

    // 正常路径交给 beginGuestTeardown，flight 去重保证同一 guest 只拆一次。
    return this.beginGuestTeardown(tab, guest, "renderer replacement");
  }

  // teardown flight 是“同一 guest 只允许一次销毁流程”的锁；重复调用共享结果，
  // 避免 closeTab 与崩溃回收同时销毁同一个 WebContents。
  // flight 必须保存到 tab 上，且在 guest 换代时清空，否则新 guest 会被旧 flight 挡住。
  private beginGuestTeardown(
    tab: ManagedTab,
    guest: GuestWebContents,
    reason: string,
  ): Promise<boolean> {
    const existing = tab.guestTeardownFlight;
    if (existing) return existing;
    const flight = this.runGuestTeardown(tab, guest, reason);
    tab.guestTeardownFlight = flight;
    const clearFlight = () => {
      // 必须比对引用再清：本 flight 落定时 tab 可能已经换过一代并挂上了新的 teardown flight，
      // 无条件清会把后来者的锁抹掉，让并发的第二次销毁流程对同一 guest 重入。
      if (tab.guestTeardownFlight === flight) tab.guestTeardownFlight = undefined;
    };
    // 成功与失败都要挂同一个 clearFlight，否则 reject 的那次会变成 unhandledRejection，
    // 而失败的 teardown 恰恰是最需要被观察到的路径。void 只是声明调用方不 await 这个清理。
    void flight.then(clearFlight, clearFlight);
    return flight;
  }

  // 销毁顺序：清监听 → 等 CDP 空闲 → detach → close → 清 tab 字段。
  // 等待 CDP 空闲有超时：底层命令可能永远不返回，不能让 closeTab 永久挂起。
  // [资源] 每一步都要容忍“对象已销毁”，否则销毁流程本身会抛错，留下半清理状态。
  private async runGuestTeardown(
    // tab 只承载 teardown 状态，guest 才是本次要拆的对象，两者身份必须分开判。
    tab: ManagedTab,
    // guest 以参数传入而不是读 tab.guest：等 CDP 空闲期间 tab 可能已被换绑。
    guest: GuestWebContents,
    // reason 进 abort 的 message 与日志，用于区分 close/rebind/crash 三类拆解。
    reason: string,
  ): Promise<boolean> {
    // 入口先判身份：tab 已换绑说明这次 teardown 已被别人接手，只报告 CDP 是否干净。
    if (tab.guest !== guest) return !tab.cdpAttached;
    // 先置 detaching 再取消请求：并发到的 attachGuest 会看到中间态并按 INV-03 拒绝，
    // 顺序反了它会在取消与置位之间看到 attached，把一个正在拆的 guest 当成可复用。
    tab.guestLifecycle = "detaching";

    // 先停止新的 request/recording 进入 CDP；已经下发的请求仍由 pendingCdpCommands
    // 计数保护，直到真实 Promise settle。这样外层取消不会把 native command 误判成已结束。
    for (const request of this.runningRequests.values()) {
      // 只 abort 本 tab 的请求：别的 tab 的写命令不能因为一个 guest 销毁被取消。
      if (request.tabId !== tab.tabId) continue;
      // AbortError 的 message 带 reason，renderer 侧可直接看出是 guest 被销毁。
      request.controller.abort(new DOMException(`browser guest ${reason}`, "AbortError"));
    }
    // 录制同步中止：继续录只会拿到已销毁 guest 的黑帧。
    this.abortRecordings((entry) => entry.tabId === tab.tabId, `browser guest ${reason}`);

    // 记录起始 pending 数：超时日志要能区分「本来就多」与「等待期间新增」。
    const pendingAtStart = tab.pendingCdpCommands;
    // 等待有上限：底层命令可能永远不 settle，不能让它把 closeTab 永久挂起。
    const settled = await this.waitForGuestCdpIdle(tab, DEFAULT_GUEST_CDP_TEARDOWN_TIMEOUT_MS);
    // 超时只记 warn 不返回失败：底层 command 可能永远不 settle（renderer 已卡死），若在这里
    // 判负，closeTab 会永久挂起，tab 与 waiter 都收不回来。这是对 INV-05 的有意降级而非
    // 疏漏：返回 true 只保证 native CDP 已 detach，不保证那条未结算的写命令已经落地。
    // 取舍与「pending 含写操作时才会变成真问题」的边界见 ZC-DEFECTS 的 D-9-5。
    // INV-05 的 pendingCdpCommands 判据保持不变，继续作为 gate 水位，不得靠改写条款消掉它。
    if (!settled) {
      // 超时只 warn 不判负：判负会让 tab 与 waiter 都收不回来（D-9-5 的有意降级）。
      this.warn(
        `browser guest teardown cdp pending timeout tabId=${tab.tabId} ` +
          `pending=${tab.pendingCdpCommands} started=${pendingAtStart} reason=${reason}`,
      );
    }

    // destroyed 事件可能在等待期间先到达；此时 detachGuest 已经完成了 JS 侧收口，但 native
    // detach 只有在 cdpAttached=false 时才可认为安全。
    if (tab.guest !== guest) return !tab.cdpAttached;
    // 等 CDP 期间 guest 可能先被销毁，此时 native detach 已无机会，只能看 cdpAttached 是否干净。
    if (safeBool(() => guest.isDestroyed(), true)) {
      // 走到这里说明 guest 先于 teardown 被销毁（destroyed 回调或 renderer 卸载 webview）。
      // 此时 cdpAttached 仍为 true 意味着没有任何安全窗口再做 native detach：返回 false 让
      // 调用方按「替换失败」处理，因为继续重建会在未经 detach 的 DOM 上卸载 webview，正是
      // INV-04 禁止的 UAF 窗口；反过来把 cdpAttached 直接改成 false 假装已断开，又会让后续
      // 命令的代际断言放过一个仍挂着旧 Debugger 的 guest。
      if (tab.cdpAttached) {
        // 日志带 tabId 与 guestId：销毁竞态只能靠这两个 id 与时间戳对齐。
        this.log?.(
          `[browser-use] guest teardown rejected on destroyed guest tabId=${tab.tabId} ` +
            `guestId=${safeStr(() => String(guest.id), "?")}`,
        );
        // 返回 false 让调用方按「替换失败」处理，不能假装已断开（INV-04）。
        return false;
      }
      // guest 已销毁且 cdpAttached 为假时才走这里：JS 侧收口即可，不再碰 native。
      this.detachGuest(tab);
      // 返回 true 只表示没有残留 CDP 连接，不表示那个 guest 曾被正常关闭。
      return true;
    }

    try {
      // detach() 是同步 void、失败既不抛也不返回，唯一证据就是再查一次 isAttached()。
      // 第二次仍为 true 必须判负：此时卸载 DOM 会让 DevToolsSession 走隐式析构，在仍被
      // 引用的 agent host 上触发 UAF（INV-04），而这正是本函数存在的理由。
      if (guest.debugger.isAttached()) guest.debugger.detach();
      // detach 是同步 void，唯一的证据是再查一次 isAttached。
      if (guest.debugger.isAttached()) {
        // 第二次仍 attached 必须判负：卸载 DOM 会走隐式析构，正是 UAF 窗口。
        this.warn(
          `browser guest replacement cdp detach not confirmed tabId=${tab.tabId} ` +
            `guestId=${safeStr(() => String(guest.id), "?")}`,
        );
        // 判负前只告警不重试：重试 detach 对已卡住的 DevToolsSession 没有意义。
        return false;
      }
    } catch (error) {
      // fail closed：detach 失败时保留旧节点，不能用“继续重建”重新打开已知的 native UAF 窗口。
      this.warn(
        `browser guest replacement cdp detach failed tabId=${tab.tabId} ` +
          `guestId=${safeStr(() => String(guest.id), "?")}`,
        error,
      );
      // 回滚 detaching → attached 是 INV-03 唯一允许的例外：本函数还没成功断开任何东西，
      // 而留着 detaching 会让该 guest 上任何后续 CDP 命令与录制在 assertCurrentGuest 处
      // 永久抛 "browser guest is detaching"，把一次可重试的失败变成 tab 永久不可用。
      // 只在 guest 未被销毁时回滚：给销毁中的对象写 attached 会掩盖它真实的终态。
      if (tab.guest === guest && !safeBool(() => guest.isDestroyed(), true)) {
        // 只在 guest 未销毁时回滚 lifecycle：给销毁中的对象写 attached 会掩盖真实终态。
        tab.guestLifecycle = "attached";
      }
      // 返回 false 表示本轮替换失败，旧节点保留，调用方不能继续重建。
      return false;
    }

    // 只有确认断开才打这条日志：它的语义是可以安全卸载 DOM。
    this.log?.(
      `[browser-use] cdp detached before guest replacement tabId=${tab.tabId} ` +
        `guestId=${safeStr(() => String(guest.id), "?")}`,
    );
    // 先置 cdpAttached=false 再交给 detachGuest：后者用这个字段判断「销毁时是否仍挂着 CDP」，
    // 并据此决定要不要留崩溃线索。顺序反了会把一次已确认断开的正常收口误报成崩溃路径。
    tab.cdpAttached = false;
    // 先置 detached 再交给 detachGuest：后者据此区分正常收口与崩溃路径。
    tab.guestLifecycle = "detached";
    // detachGuest 完成 JS 侧收口与字段清理，是 native 断开之后的最后一步。
    this.detachGuest(tab);
    // true 表示 native CDP 已确认断开，DOM 卸载是安全的。
    return true;
  }

  // 轮询 pendingCdpCommands 直到归零或超时；用轮询而不是事件，是因为命令完成点分散
  // 在各 finally 里，加事件源会引入新的泄漏面。
  // 超时返回 false，调用方仍会尝试 detach，只是记一条 warn。
  private async waitForGuestCdpIdle(tab: ManagedTab, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    // 睡眠上限取 min(10, 剩余预算)：固定 10ms 会让最后一轮睡过 deadline，超时判定凭空晚一拍；
    // 而剩余为 0 时 setTimeout(0) 只是让出一次事件循环，不会变成忙等。
    while (tab.pendingCdpCommands > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(10, deadline - Date.now())),
      );
    }
    // 唯一判据是最终读数，不是「循环结束了」：因超时退出时 pendingCdpCommands 仍可能大于 0，
    // 把它当成功会让调用方在没有空闲的 guest 上继续 detach。
    return tab.pendingCdpCommands === 0;
  }

  /** 内存诊断计数器；只读 size。 */
  // 只读诊断：统计 tab/guest/waiter/recording 数量，供资源管理器展示与测试断言。
  // 不能在这里触发任何清理，诊断调用必须无副作用，否则 UI 轮询会改变行为。
  // 实现只回 tabs/closedTabIds 两项，guest/waiter/recording 的计数缺失会让资源管理器
  // 看不到这三类泄漏——偏差见 D-9-13。
  collectMemoryDiagnostics(): Record<string, number> {
    return { tabs: this.tabs.size, closedTabIds: this.closedTabIds.size };
  }

  // detach 不清 logical tab：owner/cachedUrl/lifecycle/活跃标志都必须保留，供重绑恢复。
  // 只清理与 guest 绑定的字段（监听 cleanup、CDP 计数、dialog、下载），其余 logical tab 字段保持不动。
  // 必须在最后把 guest 置 undefined 并 +1 generation，保证旧命令的断言失败。
  private detachGuest(tab: ManagedTab): void {
    // guest 先存局部变量：下面多处会把它清空，闭包里再读 tab.guest 会拿到 undefined。
    const guest = tab.guest;
    // 没有 guest 也按「已销毁」处理，后续清理全部走安全分支。
    const guestDestroyed = guest ? safeBool(() => guest.isDestroyed(), true) : true;
    // 恢复在飞时不回写 logical cache（INV-18）：此时 tab.guest 是替身，getURL() 读到的是
    // 上一代残留地址或 about:blank，写回去会让下一次恢复用错误地址重新加载。
    // 没有在飞恢复才说明当前 guest 就是用户最后看到的页面，可以安全作为恢复用的逻辑地址。
    if (guest && !this.guestRecoveryFlights.has(tab.tabId)) {
      // 只有无在飞恢复才回写 URL：恢复期的 guest 是替身，读到的是 about:blank 或旧代地址（INV-18）。
      tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl);
      // 标题与 URL 同源同条件，分开写会让快照出现地址与标题不同代的错配。
      tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle);
    }
    // dialog 缓存属于上一代 guest：必须在 guest 字段清空前删掉，否则遗留的对话框记录会让
    // 后续 handleDialog 去回一个已经消失的 requestId（INV-28 要求 detach 必清）。
    this.pendingDialogs.delete(tab.tabId);
    try {
      // Electron 会在 renderer 卸载 <webview> 时先销毁 guest；此时 listener 已随对象释放，
      // 再调用 session.removeListener 只会产生无意义的 "Object has been destroyed" 日志。
      if (!guestDestroyed) tab.downloadCleanup?.();
    } catch (error) {
      // guest renderer 被 Chromium 杀死后，旧 session 的 removeListener 也会抛
      // "Object has been destroyed"；清理失败不能阻断替代 guest 的 CDP 重新绑定。
      this.log?.(
        `[browser-use] detachGuest download cleanup failed tabId=${tab.tabId} error=${
          // 日志保留原始 error 文本：cleanup 失败通常只在销毁竞态下出现，文本是唯一线索。
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      // 无论 cleanup 成功与否都清引用，避免下一次 detach 对旧函数重复调用。
      tab.downloadCleanup = undefined;
    }
    try {
      // activityCleanup 挂在 guest 的 media/audible 事件上，和 downloadCleanup 一样受
      // guestDestroyed 约束；但即使跳过它，下面的 loading/mediaActive 也必须复位。
      if (!guestDestroyed) tab.activityCleanup?.();
    } catch {
      // guest 已销毁时 listener cleanup 可能失败；residency 状态仍需继续收口。
    } finally {
      // activityCleanup 必须无条件清引用：即使跳过调用，也不能让下一轮复用它。
      tab.activityCleanup = undefined;
      // loading 复位是必须的：残留 true 会让新 guest 的 runtime protection 一直认为在加载。
      tab.loading = false;
      // mediaActive 同理，残留 true 会阻止 tab 进入挂起。
      tab.mediaActive = false;
    }
    // 崩溃守卫的注销不能受 guestDestroyed 约束：removeListener 是纯 JS 侧操作，
    // 而这里的 guest 引用在换代场景下往往还活着，漏掉就会让监听随代际累积。
    try {
      // 崩溃守卫的注销不受 guestDestroyed 约束：removeListener 是纯 JS 操作。
      tab.crashGuardCleanup?.();
    } catch {
      // guest 已销毁时 removeListener 可能抛 "Object has been destroyed"，不影响收口。
    } finally {
      // 清引用放在 finally，保证注册失败时也不会留下一个不可用的 cleanup。
      tab.crashGuardCleanup = undefined;
    }
    // JS 层监听清理：guest 换代/销毁后旧 "message" 监听不该继续挂着。这一步与 native 侧的
    // CDP 断开无关（DevToolsSession 派发不查 JS 监听），纯粹是防止监听随 guest 代际累积。
    const cdpWasAttached = tab.cdpAttached;
    try {
      // CDP message 监听是 JS 侧资源，必须摘掉，否则会随 guest 代际累积。
      tab.cdpMessageCleanup?.();
    } catch (error) {
      // 清理失败只记日志：native 侧收口不依赖这个监听是否摘干净。
      // 日志只带 error 文本而不带 guest 对象，避免在销毁路径上做多余属性访问。
      this.log?.(
        `[browser-use] detachGuest cdp message cleanup failed tabId=${tab.tabId} error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      // finally 清引用，防止下一次 detach 复用同一 cleanup。
      tab.cdpMessageCleanup = undefined;
    }
    // guest 存在时要区分「先被销毁」与「主动断开」，两条路径的日志语义不同。
    if (guest) {
      // 经 safeStr 取 id 而不是直接读 guest.id：guest 可能已销毁，连读 id 都会抛，
      // 而这里只是组织日志，不能因为取日志字段让整个收口中断。
      const guestId = safeStr(() => String(guest.id), "?");
      // 已销毁路径不再调用 detach：对已析构对象调用只会抛，没有清理价值。
      if (guestDestroyed) {
        // guest 先于 detach 被销毁（destroyed 回调 / renderer 卸载 webview）。此时 detach()
        // 必抛且无意义：native DevToolsAgentHost 已随 WebContents 一起收口，主进程只能被动
        // 接受这个结果。而崩溃现场（DevToolsSession::DispatchProtocolNotification 里 client_
        // vptr=0）正落在「CDP 未经主动 detach 就走隐式析构」之后，所以这条路径必须留痕 ——
        // 否则日志里完全看不到它发生过，无法把崩溃与具体 tab 生命周期对上。
        if (cdpWasAttached) {
          // 留痕是给崩溃排查用的：这条日志出现即说明有 CDP 未经主动 detach 就析构。
          this.log?.(
            `[browser-use] detachGuest cdp still attached on destroyed guest ` +
              `tabId=${tab.tabId} guestId=${guestId}`,
          );
        }
      } else {
        try {
          // 这里再 detach 一次不是重复劳动：detachGuest 也会被 destroyed 路径直接调用，
          // 不能假设调用方已经断过 native CDP。这是 guest 还活着时最后一次主动断开机会，
          // 漏掉就只能等 WebContents 析构时的隐式 detach，而那正是崩溃窗口。
          if (guest.debugger.isAttached()) guest.debugger.detach();
        } catch (error) {
          // 这里不能静默吞掉：detach 失败与成功在日志上无法区分 —— 而「本该能主动 detach
          // 却失败了」正是需要与崩溃关联的信号。
          this.warn(`browser guest cdp detach failed tabId=${tab.tabId} guestId=${guestId}`, error);
        }
      }
    }
    // 先停计时器再清 guest 字段：否则 timer 回调可能在 guest 已置 undefined 后触发，
    // 对一个空 tab 执行 detach。这里同时复位 cdpAttached，避免下一轮误判已连接。
    this.clearGuestCdpIdleRelease(tab);
    // destroyed 与 detached 的区别只在语义，当前没有任何分支按这个值分叉：前者表示 guest 已
    // 先于本次 detach 被 renderer 销毁（native 侧只能被动接受），后者表示本进程主动断开了
    // CDP。保留这个区分是为了事后从 tab 状态就能判断崩溃路径走过哪一支，而不是看日志考古。
    tab.guest = undefined;
    // cdpAttached 必须复位：残留 true 会让下一轮误判当前 guest 已连接。
    tab.cdpAttached = false;
    // destroyed 与 detached 只作事后区分，当前没有分支依赖这个值。
    tab.guestLifecycle = guestDestroyed ? "destroyed" : "detached";
    // 后台 viewport fallback 属于 guest，换代后必须清，否则新 guest 会被按旧尺寸布局（INV-22）。
    tab.backgroundViewportFallback = undefined;
    // 未完成的 viewport mutation 引用也要清，避免持有旧闭包。
    tab.viewportMutation = undefined;
    // 通知 coordinator 已 detach：预算与可见性都要立刻反映「没有 guest」。
    this.residencyCoordinator.markDetached(tab.tabId);
    // 最后重算保护：guest 已清空，相关保活条件应全部失效。
    this.refreshRuntimeProtection(tab.tabId);
  }

  // 判断 key 是否仍有可用 guest；closed tab 即使还挂着对象也返回 false，
  // 避免调用方对已关闭 tab 继续发命令。
  hasGuest(key: string): boolean {
    const tab = this.tabs.get(key);
    return Boolean(tab?.guest && tab.lifecycle !== "closed");
  }

  // 进程退出前的总收口：必须先 abort 所有 recording/download/running，再 detach 所有 guest，然后 dispose coordinator。顺序不能反：先 dispose coordinator 会让回调在销毁中途触发。
  // 每一步都必须 try/catch，不能因为一个 tab 出错而跳过剩余清理。
  disposeAll(): void {
    // 先 abort 所有在飞命令：后面要清 registry，留着它们会让回调在空表上继续跑。
    for (const request of this.runningRequests.values()) {
      // AbortError 的 message 固定，renderer 可据此把结果标成「进程退出」而不是普通失败。
      request.controller.abort(new DOMException("browser manager disposed", "AbortError"));
    }
    // 直接迭代 Map 是安全的：closeTab 只删自己这一个 key，而 Map 迭代器允许在迭代中删除
    // 已访问项，不会跳过后续 tab。若将来 closeTab 改成连带删别的 key（比如同 scope 的其它
    // tab），必须先 [...this.tabs.values()] 复制再遍历，否则会静默漏掉尚未访问的 tab。
    for (const tab of this.tabs.values()) this.closeTab(tab, false);
    // waiter 用 resolveWaiters(null) 结算：dispose 不是失败，等待方应拿到「没有结果」。
    for (const key of this.waiters.keys()) this.resolveWaiters(key, null);
    // tabs 清空必须在 closeTab 之后：closeTab 需要 tab 对象完成持久化删除。
    this.tabs.clear();
    // 只在 disposeAll 清空 tombstones：实例销毁后不再接收 IPC，复活风险随实例消失。
    // 若在别处清空，迟到 attach 就能重建已关闭 tab，INV-16 被破坏。
    // 清空后不得再复用该实例；disposeAll 之后的方法调用都应视为编程错误。
    // 这里不逐个 close tab：正常关闭流程已在 closeTab 中完成，disposeAll 只兜底。
    // 清空是同步的，避免 finally 清理中被新 attach 插入。
    // tombstones 的内存随实例一起释放，不需要额外上限。
    this.closedTabIds.clear();
    // 下面五个只是「指向 tab 的索引」，tab 对象本身已在 tabs.clear() 时丢弃；不清会留下悬空键，
    // 让 dispose 之后迟到的 report 命中一个不存在的 tab，并据此重建 scope 状态。
    this.activeTabByScope.clear();
    // 索引类 Map 一并清空：留着悬空 key 会让 dispose 之后的 report 重建 scope 状态。
    this.defaultTabByScope.clear();
    // sessionNames 按 scope 存，scope 已随 tabs 消失，留着会留下悬空引用。
    this.sessionNames.clear();
    // 按窗口的自然尺寸缓存必须在实例销毁前清，避免同一进程内的新实例读到旧值。
    this.naturalViewportByWindow.clear();
    // 每轮都重读 waiters[0]：finishDownloadWaiter 会把该 waiter 从数组里摘掉，用索引递增会
    // 跳过被前移的元素，用快照遍历则会对已结算的 waiter 重复 resolve。
    // 结果传 null 而不是抛错：dispose 不是失败路径，等待方应按「没有下载结果」返回。
    for (const [tabId, waiters] of this.downloadWaiters) {
      // 每轮重读 waiters[0]：finishDownloadWaiter 会摘元素，用索引递增会跳过被前移的 waiter。
      let waiter = waiters[0];
      // while 而不是 forEach：结算过程中数组会变，快照遍历会重复 resolve。
      while (waiter) {
        // 传 null 表示「没有下载结果」，不是失败。
        this.finishDownloadWaiter(tabId, waiter, null);
        // 重新取队首，直到该 tab 的 waiter 清空。
        waiter = waiters[0];
      }
    }
    // 只清索引，不删文件：下载文件是用户资产，进程退出时删除等于替用户做破坏性决定；
    // 下面 recording artifact 的删法相反，那是本次运行自建的临时产物。
    this.downloads.clear();
    // 队列只存 downloadId，记录已在上一步清空，所以这里必须一并断引用。
    this.queuedDownloads.clear();
    // 截图与 abandoned 计数只断引用：底层 capture 的 promise 由各自的 finally 收口，
    // 这里提前删只是不让 dispose 之后的诊断再统计到它们，并不会取消已经在飞的截图。
    this.inFlightScreenshots.clear();
    // abandoned 计数只断引用，底层 capture 由自己的 finally 收口，不会在这里被取消。
    this.abandonedScreenshotCaptures.clear();
    // 录制是本次运行自建的临时产物，可以删：先 abort 让录制循环停止写盘，再清 TTL 计时器
    // 防止 dispose 后的回调再碰这个条目，最后才删文件；顺序反了会出现「删完又被写入」的窗口。
    for (const entry of this.recordings.values()) {
      // 先 abort 让录制循环停止写盘，再清 timer，最后删文件。
      entry.controller.abort(new DOMException("browser manager disposed", "AbortError"));
      // 清 TTL 计时器：dispose 后的回调不能再碰这个条目。
      if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
      // artifact 可能尚未落盘（录制刚开始），只删有 path 的条目。
      if (entry.artifact?.path)
        void rm(entry.artifact.path, { force: true }).catch(() => undefined);
    }
    // recordings 清空放在删文件之后，避免中途被新录制写入。
    this.recordings.clear();
    // dispose 放最后：它会让所有后续 report 变成 no-op，提前调用会让前面的 guest 收口
    // 失去预算与状态更新。dispose 后实例不可复用。
    this.residencyCoordinator.dispose();
    // restoredTabClaims 指向已清空的 tabs，必须一起清，否则迟到 claim 会命中悬空 tabId。
    this.restoredTabClaims.clear();
    // 必须逐个 resolve 而不是直接 clear：这些 waiter 是 renderer 等暂停确认的回执，
    // 只清引用会让对端永远挂在 await 上，INV-34 要求的「dispose 后无悬挂 promise」就不成立。
    for (const resolve of this.suspendAckWaiters.values()) resolve();
    // suspendAckWaiters 先逐个 resolve 再 clear：只清引用会让 renderer 永远挂在 await 上（INV-34）。
    this.suspendAckWaiters.clear();
    // 四个 flight 只清引用，不在这里结算：缓存里存的是 Promise 而不是可 resolve 的 deferred，
    // 真正的结算点不在本函数——waitForGuestCdpIdle 的超时会让 teardown flight 落定，而
    // resolveWaiters(key, null) 与 closeTab 会各自解锁挂在其上的 waiter。
    // 清引用是为了让 dispose 之后迟到的调用拿不到旧 flight，只能走各自的 fail-closed 分支。
    this.suspendFlights.clear();
    // 四个 flight 只断引用不结算：缓存里是 Promise，真正的结算点不在这里。
    this.restoreFlights.clear();
    // 清引用后迟到的调用拿不到旧 flight，只能走各自的 fail-closed 分支。
    this.guestRecoveryFlights.clear();
    // attach flight 也必须清，否则 dispose 之后的命令会复用已失效的单飞 promise。
    this.guestAttachFlights.clear();
  }

  // 等待 attach 时挂 waiter 并设置超时；超时后 resolve(null) 而不是 reject，让调用方
  // 走统一的“拿不到 guest”分支。
  // signal abort 时必须 removeWaiter，否则 waiters 数组会随取消次数增长。
  private waitForGuest(tabId: string, signal?: AbortSignal): Promise<GuestWebContents | null> {
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise<GuestWebContents | null>((resolve) => {
      const waiter: PendingWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.removeWaiter(tabId, waiter);
          this.log?.(`[browser-use] waitForGuest timeout tabId=${tabId}`);
          resolve(null);
        }, this.attachTimeoutMs),
        signal,
      };
      waiter.onAbort = () => {
        this.removeWaiter(tabId, waiter);
        resolve(null);
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      const list = this.waiters.get(tabId) ?? [];
      list.push(waiter);
      this.waiters.set(tabId, list);
    });
  }

  // 按 identity 从数组中移除并清理 signal 监听；必须同时 clearTimeout，
  // 否则超时仍会触发一次 resolve(null)（Promise 只 settle 一次，但 timer 会持有闭包）。
  // 找不到 waiter 是正常竞态，静默返回。
  private removeWaiter(tabId: string, waiter: PendingWaiter): void {
    clearTimeout(waiter.timer);
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
    const list = this.waiters.get(tabId);
    if (!list) return;
    const index = list.indexOf(waiter);
    if (index >= 0) list.splice(index, 1);
    // 移除后若队列为空必须删 key，避免 map 随 tab 数量无限累积空数组。
    // 删除前先判断长度，不能 delete 后重新 set：并发 remove 会互相覆盖。
    // 空队列与“没有 key”在语义上等价，读取方都按 ?? [] 处理。
    // 这一步与 clearTimeout/removeEventListener 无关，放在最后保证监听已释放。
    // 若 waiter 已被 resolve 清空，这里再次 delete 是幂等的。
    // map 大小不会成为内存问题，但空 key 会让诊断计数失真。
    if (list.length === 0) this.waiters.delete(tabId);
  }

  // 一次性唤醒并清空该 tab 的所有 waiter；传 null 表示失败，传 guest 表示成功。
  // 先复制再清空 map，防止 resolve 同步触发的回调再次注册 waiter 到同一 tab。
  // 每个 waiter 都要 clearTimeout 并注销 signal 监听，不能只 resolve。
  private resolveWaiters(tabId: string, guest: GuestWebContents | null): void {
    const list = this.waiters.get(tabId);
    if (!list) return;
    // resolveWaiters 一次性清空：resolve 过程中 waiter 可能重新入队（重试命令），
    // 所以必须先 delete 再逐个 resolve，保证新 waiter 进入的是新队列。
    // 若边遍历边删，新入队的 waiter 可能被本轮循环误唤醒，拿到不属于它的 guest。
    // resolve 传 null 表示失败，调用方会走 tab 不可用分支。
    // 每个 waiter 的 timer 与 abort 监听在 resolve 前已清理，不能依赖 GC。
    // 清空后该 tab 的 attach 成功不会再唤醒任何旧等待者。
    this.waiters.delete(tabId);
    for (const waiter of list) {
      clearTimeout(waiter.timer);
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(guest);
    }
  }
}

// 返回注销函数而不是让调用方自己 remove：abort 包装器是匿名闭包，外部无法移除，
// 漏调这个返回值会让 signal 一直持有已结束请求的 controller，长生命周期 signal 上会累积泄漏。
// signal 已 abort 时必须同步转抛一次，否则 controller 永远收不到这次取消。
function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

// 用三态返回而不是在 abort 时 reject：取消是正常路径，reject 会迫使每个调用点重复写一遍
// 取消归一化。底层 promise 不会被真正取消，只是不再被等待，它的结算仍由自己的 finally 收口。
// rejection 必须统一包成 Error：IPC 只序列化 message，非 Error 的 reason 会在桥上丢失。
function waitForPromiseWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<{ completed: true; value: T } | { completed: false }> {
  if (signal.aborted) return Promise.resolve({ completed: false });
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ completed: false });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ completed: true, value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

// 只回 boolean 而不是三态：调用方只需要区分「等到了」和「被取消」，超时归外层 deadline 判。
// abort 时必须 clearTimeout，否则 timer 会一直攥着闭包直到超时，取消频繁时等于持续泄漏。
function waitForDelay(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// 三态而不是 boolean：调用方必须把「超时」与「取消」分开报——前者是 timeout 错误，
// 后者是 cancelled；合成 false 会让取消也走超时分支，产生用户没做过的重试提示。
// 轮询上限 min(50, remaining) 与 waitForGuestCdpIdle 同理：固定间隔会睡过 deadline。
async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<"matched" | "timeout" | "cancelled"> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal.aborted) return "cancelled";
    if (predicate()) return "matched";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "timeout";
    if (!(await waitForDelay(Math.min(50, remaining), signal))) return "cancelled";
  }
}

// 只有 signal 已 abort 才产出错误；原样透传 Error reason（surface 失效/超时都靠它区分），
// 非 Error reason 才退回通用文案，否则日志里会丢掉「被哪条路径取消」。
function readScreenshotSurfaceInvalidation(signal: AbortSignal | undefined): Error | undefined {
  if (!signal?.aborted) return undefined;
  if (signal.reason instanceof Error) return signal.reason;
  return new Error("browser screenshot activity was invalidated");
}

// 入口必须先判 aborted：监听器还没挂上时 signal 就可能已被取消，漏判会把取消结果落到
// execution.then 上当成成功。sideEffect 只按命令白名单推断，已下发且可能写页面才报 uncertain。
// 拒绝分支省略 sideEffect 是防御性的：executeBrowserCommandOnView 按 INV-02 永不 reject，
// 真走到那里说明上游契约被破坏，调用方必须把缺失当作 uncertain 处理。
async function raceBackendExecution(
  execution: Promise<BrowserCommandResult>,
  signal: AbortSignal,
  command: BrowserCommand,
  startedAt: number,
): Promise<BrowserCommandResult> {
  // 监听器挂载前 signal 可能已 abort，这里必须先判；漏判会让已经取消的请求继续等 execution 落定。
  if (signal.aborted) {
    return {
      ok: false,
      error: {
        code: "cancelled",
        message: "browser request cancelled after backend dispatch; side effects may have occurred",
        sideEffect: isSideEffecting(command) ? "uncertain" : "none",
      },
      elapsedMs: Date.now() - startedAt,
    };
  }
  // 手写 Promise 而不是 Promise.race：需要在 settle 时移除 abort 监听，Promise.race 无法注销失败分支的监听。
  return await new Promise((resolve) => {
    // settled 是单次结算闸：abort 与 execution 可能同时到达，先到者胜，后到者不能覆盖结果。
    let settled = false;
    // finish 统一收口：移除监听、置 settled、resolve 三件事必须同序，否则会重复 resolve 或漏摘监听。
    const finish = (result: BrowserCommandResult) => {
      // 重复结算直接返回；watchdog 与正常返回都会调用 finish，幂等靠这个早退。
      if (settled) return;
      // 先置 settled 再摘监听：若先摘监听，另一条分支可能在 settled 仍为 false 时插入并重复 resolve。
      settled = true;
      // abort 监听是 once，但仍要显式移除：execution 先落定时残留的监听会在 signal 生命周期内累积。
      signal.removeEventListener("abort", onAbort);
      // resolve 放在最后：监听移除完成前 resolve 会让调用方在监听仍挂着时继续执行。
      resolve(result);
    };
    // onAbort 只在 signal 触发时构造取消结果；它不 abort 底层 execution，CDP 没有取消 API。
    const onAbort = () =>
      // abort 分支同样走 finish，保证与正常结果竞争时只有一条路径生效。
      finish({
        ok: false,
        error: {
          code: "cancelled",
          message: isSideEffecting(command)
            ? "browser request cancelled after backend dispatch; side effects may have occurred"
            : "browser request cancelled",
          sideEffect: isSideEffecting(command) ? "uncertain" : "none",
        },
        elapsedMs: Date.now() - startedAt,
      });
    // once:true 只是兜底，finish 里仍会 remove；依赖 once 而不 remove 会在 execution 先完成时留下监听。
    signal.addEventListener("abort", onAbort, { once: true });
    // 同时挂 fulfilled 和 rejected：只挂 finally 会产生未处理的派生 rejection。
    execution.then(finish, (error: unknown) =>
      // execution 拒绝时包成 execution_error；按 INV-02 正常路径不会走到这里，走到即上游契约被破坏。
      finish({
        ok: false,
        error: {
          code: "execution_error",
          message: error instanceof Error ? error.message : String(error),
        },
        elapsedMs: Date.now() - startedAt,
      }),
    );
  });
}

// 只判形状（正整数），不查上下限：越界由 assertViewportOverride 在真正下发前抛具体错误，
// 两处分开后 renderer 收到的是“超出可调范围”而不是笼统的“类型不对”，能据此提示用户。
function isBrowserViewportSize(value: unknown): value is BrowserViewportSize {
  if (!value || typeof value !== "object") return false;
  const viewport = value as Record<string, unknown>;
  return (
    Number.isInteger(viewport.width) &&
    Number(viewport.width) > 0 &&
    Number.isInteger(viewport.height) &&
    Number(viewport.height) > 0
  );
}

// 允许负数与小数：坐标是相对视口的 CSS 像素，负值表示元素在滚动容器可视区之外，必须原样放行，
// 用整数/正数判断会把这些合法命中全部拒掉。
function isBrowserPointValue(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return typeof point.x === "number" && typeof point.y === "number";
}

// name 必须是 AbortError：上层按 name 识别取消而不是文案；文案带 recording 只为在日志里
// 与截图、命令取消区分开，改文案不会影响取消判定。
function abortError(): DOMException {
  return new DOMException("Browser recording cancelled", "AbortError");
}

// 后台兜底尺寸必须夹到 BROWSER_VIEWPORT_LIMITS：CDP 收到越界 metrics 会直接拒绝命令，
// 兜底反而让所有后台操作一起失败；静默夹取在这里是合法的，因为它只是“可见性替身”。
function normalizeBackgroundViewport(viewport: BrowserViewportSize): BrowserViewportSize {
  return {
    width: Math.min(
      BROWSER_VIEWPORT_LIMITS.maxWidth,
      Math.max(BROWSER_VIEWPORT_LIMITS.minWidth, viewport.width),
    ),
    height: Math.min(
      BROWSER_VIEWPORT_LIMITS.maxHeight,
      Math.max(BROWSER_VIEWPORT_LIMITS.minHeight, viewport.height),
    ),
  };
}

// 截图有两条入口：原生 method 与 playwright elementScreenshot；漏掉后者会让元素截图
// 不进入 captureActive 与 surface 预算，与整页截图并发时抢占同一个 compositor。
function isScreenshotCommand(command: BrowserCommand): boolean {
  return (
    command.method === "screenshot" ||
    (command.method === "playwright" && command.action.name === "elementScreenshot")
  );
}

// 越界必须抛而不是夹取：静默夹取会让 renderer 以为设置成功，实际布局与请求值长期不一致；
// 抛出后 IPC 层会把原因原样带回，调用方才能改成合法尺寸后重试。
function assertViewportOverride(viewport: BrowserViewportSize): void {
  if (
    !Number.isInteger(viewport.width) ||
    viewport.width < BROWSER_VIEWPORT_LIMITS.minWidth ||
    viewport.width > BROWSER_VIEWPORT_LIMITS.maxWidth ||
    !Number.isInteger(viewport.height) ||
    viewport.height < BROWSER_VIEWPORT_LIMITS.minHeight ||
    viewport.height > BROWSER_VIEWPORT_LIMITS.maxHeight
  ) {
    throw new Error("browser viewport is outside the supported free-size range");
  }
}

// 属性访问本身就可能抛：guest 销毁后 getURL()/getTitle() 会直接抛 "Object has been destroyed"，
// 只判返回值类型拦不住，所以整次调用必须包在 try 里；fallback 是调用方愿意接受的旧值。
function safeStr(fn: () => string, fallback: string): string {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// 同 safeStr，但 fallback 必须由调用方显式给出：true 表示“拿不到就按最坏情况处理”，
// 传 false 表示“拿不到就不阻断”，这个选择不能在函数里替调用方猜。
function safeBool(fn: () => boolean, fallback: boolean): boolean {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

// 未知类型统一按 alert 而不是丢弃：丢弃会让弹窗永远挂在页面上（没有 handleDialog 入口），
// 按 alert 至少能用默认按钮关掉，用户不会被一个无记录的对话框卡住。
function normalizeDialogType(type: string | undefined): BrowserDialog["type"] {
  switch (type) {
    case "alert":
    case "confirm":
    case "prompt":
    case "beforeunload":
      return type;
    default:
      return "alert";
  }
}

/** Browser response meta 会进入模型轨迹和调试日志；只保留 origin/path，绝不携带 credential/query/hash。 */
export function sanitizeBrowserMetaUrl(value: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const sanitized = url.toString();
    // 根路径去掉尾斜杠：origin 与 "/" 两种写法必须得到同一个 key，否则同一页面会在轨迹里
    // 出现两条不同 URL，后续按 URL 去重/归并都会失效。
    return url.pathname === "/" ? sanitized.slice(0, -1) : sanitized;
  } catch {
    // about:blank 等合法 opaque URL 也可由 URL 解析；无法解析的页面内部串不应进入 meta。
    return undefined;
  }
}
