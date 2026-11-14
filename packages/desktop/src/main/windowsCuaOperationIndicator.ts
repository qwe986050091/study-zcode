// windowsCuaOperationIndicator：Windows 平台「ZCode 正在操作电脑」原生浮层的生命周期编排器。
// 职责边界：只负责窗口创建、定位、置顶层、状态下发与安全隐藏，自身不产生任何 CUA 事件，也不读取运行时数据。
// 依赖方向：Electron 主进程 → 本模块 → windowsCuaOperationIndicatorContent（尺寸、data URL、偏移常量）。
// 输入：HostCuaOperationStateResponse 必须携带 active 布尔、workspaceIdentity/workspacePath、sessionId、turnId。
// 输出：受控浮层窗口必须加五个外部入口 handleState、clearSource、ownsWindow、refreshContent、dispose。
//
// 不变量清单（每条都对应一处显式守卫；修改前先确认破坏面）：
// INV-01 平台封闭：仅 win32 才创建窗口，handleState/clearSource/refreshContent/ensureWindow 首行都校验 platform。
// INV-02 单例窗口：模块内 window 变量是唯一句柄，任何路径都不得并存两个浮层，否则会叠出双层 ghost 提示。
// INV-03 聚合键唯一：keyFor 用 workspace + 空字节 + sessionId + 空字节 + turnId 拼键，空字节避免前缀歧义。
// INV-04 计数语义：active 为真加键、为假删键，只有聚合集合由非空变空才允许隐藏。
// INV-05 计时器自证：安全计时器回调先比对桶内当前 timer 与自身，过期计时器不得删键。
// INV-06 离场可撤销：beginHide 置 hideTimer 后，新 active 到达必须先 cancelPendingHide 才能继续显示。
// INV-07 显隐同步：windowShown 只在 showWindowOnTop 成功后置真，hideOrDestroy 之后必须置假。
// INV-08 就绪门槛：windowReady 为假时绝不可显示，否则会闪一帧空白透明画布。
// INV-09 内容态一致：无活跃 turn 时必须下发 leaving，不能停在 active 状态。
// INV-10 层级恢复：每次 showInactive 之后都要重新声明 screen-saver 层级并 moveTop。
// INV-11 输入穿透：窗口创建后立即 setIgnoreMouseEvents 为真，任何状态下都不得拦截用户点击。
// INV-12 内容保护：setContentProtection 常开，防止录屏与截图泄露浮层文案。
// INV-13 安全配置：contextIsolation 与 sandbox 必须开启，nodeIntegration 与 devTools 必须关闭，不可放宽。
// INV-14 失败隔离：半初始化窗口进 failedWindows 后必须 destroy，不能复用。
// INV-15 重试有界：setupRetryAvailable 是一次性令牌，scheduleSetupRetry 消费后置假，避免重试风暴。
// INV-16 重建去重：closed 回调与 ensureWindow 重建前检查 reconcileTimer，防止同帧重复建窗。
// INV-17 零删除隐藏：退场只 hide 不 destroy，复用已加载窗口；只有 hide 抛错才降级销毁。
// INV-18 崩溃兜底：hide 失败必须销毁并把 window 置空，否则留下不可隐藏的置顶残留。
// INV-19 销毁幂等：disposed 一旦置真，所有入口立即返回，定时器、集合与窗口全部释放。
// INV-20 归属可判定：ownsWindow 用 WeakSet 记录创建过的窗口，供上层区分自建窗口与外来窗口。
//
// 变更风险：以上不变量彼此耦合，例如放宽 INV-03 会让 INV-04 的计数错位，不可把单条当作孤立约定。
// 术语：turn 键指一次 CUA 操作回合；source 指上报状态的上层对象；聚合指所有 source 的 turn 键并集。
import { BrowserWindow, screen } from "electron";
import type { BrowserWindowConstructorOptions, Display, Point, Rectangle } from "electron";
import type { HostCuaOperationStateResponse, Locale } from "@zcode/shared";
import {
  INDICATOR_CARD_TOP_OFFSET,
  INDICATOR_SHADOW_INSET,
  indicatorDataUrl,
  indicatorWindowSize,
} from "./windowsCuaOperationIndicatorContent.js";

// [权衡] HIDE_ANIMATION_MS 必须与渲染层 leaving 过渡时长对齐，短于过渡会把离场动画截成硬切。
// 120ms 只是动画时长，不承担兜底职责；它的唯一作用是给 CSS 过渡留出播完的时间窗。
// CREATE_RETRY_MS 是建窗失败后的单次重试间隔，取 250ms 以避开 Electron 首帧加载抖动期。
// HIDE_ANIMATION_MS 与 CREATE_RETRY_MS 只影响时延、不影响状态机；改动前先确认内容层的过渡时长没有同步变化。
const HIDE_ANIMATION_MS = 120;
/**
 * 兜底隐藏时限。主导隐藏的是 turn 终态 / session 关闭 / runtime 不可用 / workspace 销毁
 * 这几条显式清除路径，这个计时器只在它们全部失约时收场，保证浮层不会无限期停留。
 *
 * 取 30s 而不是更短：CUA 事实现在按 cell 上报（每个 node_repl cell 一次），同一 turn 内
 * 后续 cell 会刷新计时器，但单个 cell 本身可以跑很久，10s 会让浮层在操作中途熄灭。
 */
const AUTO_HIDE_MS = 30_000;
const CREATE_RETRY_MS = 250;

export interface WindowsCuaOperationIndicatorWindow {
  readonly webContents: Pick<BrowserWindow["webContents"], "executeJavaScript">;
  destroy(): void;
  hide(): void;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  moveTop(): void;
  on(event: "closed", listener: () => void): this;
  setAlwaysOnTop(flag: boolean, level?: Parameters<BrowserWindow["setAlwaysOnTop"]>[1]): void;
  setBounds(bounds: Rectangle): void;
  setContentProtection(enable: boolean): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  showInactive(): void;
}

export interface WindowsCuaOperationIndicator {
  handleState(source: object, event: HostCuaOperationStateResponse): void;
  clearSource(source: object): void;
  ownsWindow(candidate: object): boolean;
  refreshContent(): void;
  dispose(): void;
}

interface IndicatorLogger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

interface WindowsCuaOperationIndicatorOptions {
  platform?: NodeJS.Platform;
  getLocale: () => Locale;
  logger: IndicatorLogger;
  createWindow?: (options: BrowserWindowConstructorOptions) => WindowsCuaOperationIndicatorWindow;
  getCursorScreenPoint?: () => Point;
  getDisplayNearestPoint?: (point: Point) => Pick<Display, "workArea">;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function createWindowsCuaOperationIndicator(
  options: WindowsCuaOperationIndicatorOptions,
): WindowsCuaOperationIndicator {
  const platform = options.platform ?? process.platform;
  const createWindow =
    options.createWindow ??
    ((windowOptions: BrowserWindowConstructorOptions) =>
      new BrowserWindow(windowOptions) as WindowsCuaOperationIndicatorWindow);
  const getCursorScreenPoint =
    options.getCursorScreenPoint ?? (() => screen.getCursorScreenPoint());
  const getDisplayNearestPoint =
    options.getDisplayNearestPoint ?? ((point: Point) => screen.getDisplayNearestPoint(point));
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelSchedule = options.cancelSchedule ?? ((timer) => clearTimeout(timer));

  // [并发] 状态容器全部是普通 Map 与 WeakSet，依赖主进程单线程事件循环，禁止引入异步写入。
  // activeTurnKeysBySource 按 source 分桶存 turn 键，外层强引用，靠 clearSource 与 dispose 显式释放。
  // ownedWindows 与 failedWindows 用 WeakSet，避免窗口销毁后仍被本模块强引用而泄漏原生句柄。
  // window、windowReady、windowShown 三者共同描述单例窗口，必须同进同退，任何单点修改都会造成幽灵可见态。
  // hideTimer 与 reconcileTimer 各自至多一个在飞行：前者必须负责离场延迟，后者必须负责重建调度，职责不可混用。
  const activeTurnKeysBySource = new Map<object, Set<string>>();
  const ownedWindows = new WeakSet<object>();
  const failedWindows = new WeakSet<object>();
  let window: WindowsCuaOperationIndicatorWindow | null = null;
  let windowReady = false;
  let windowShown = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const autoHideTimersBySource = new Map<object, Map<string, ReturnType<typeof setTimeout>>>();
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let setupRetryAvailable = false;
  let disposed = false;

  // [事务] 聚合判定是所有显隐决策的唯一真相源：遍历全部 source 桶，任一非空即视为仍有操作在进行。
  // 这里不能缓存布尔结果，否则 source 增删与 turn 到期两条路径会读到过期聚合态。
  function hasActiveTurns(): boolean {
    for (const keys of activeTurnKeysBySource.values()) {
      if (keys.size > 0) return true;
    }
    return false;
  }

  // [并发] 键必须在同一 turn 的多次上报间保持稳定，否则 active 与 inactive 落进不同桶，浮层永不熄灭。
  // workspaceIdentity 优先于 workspacePath：路径可被符号链接或多根工作区改写，identity 才是稳定标识。
  // keyFor 拼三段时必须用空字节连接，避免 workspace 名里含分隔字符时与 sessionId、turnId 拼出碰撞键。
  // 空 identity 被 trim 后回落到 workspacePath，保证拼出的键永远非空。
  function keyFor(event: HostCuaOperationStateResponse): string {
    const workspaceKey = event.workspaceIdentity?.trim() || event.workspacePath;
    return `${workspaceKey}\0${event.sessionId}\0${event.turnId}`;
  }

  // [失败路径] 状态下发是尽力而为：窗口不存在或已销毁时直接返回，绝不为发状态而建窗。
  // executeJavaScript 的 Promise 只能挂 debug 日志，不能向上抛，避免渲染进程异常拖垮主进程状态机。
  // 入参只接受 active 与 leaving 两个字面量，非法值在类型层被拦死，运行期不再重复校验。
  function setDocumentState(nextState: "active" | "leaving"): void {
    if (!window || window.isDestroyed()) return;
    void window.webContents
      .executeJavaScript(`document.documentElement.dataset.state=${JSON.stringify(nextState)}`)
      .catch((error) =>
        options.logger.debug("[cua-operation-indicator] state update failed", error),
      );
  }

  // [事务] 撤销离场延迟是恢复显示的前置条件：残留的 hideTimer 会在新 turn 显示后把窗口藏掉。
  // 清空后必须把 hideTimer 置空，否则 beginHide 的守卫会永久拒绝再次排程。
  function cancelPendingHide(): void {
    if (!hideTimer) return;
    cancelSchedule(hideTimer);
    hideTimer = null;
  }

  function cancelAutoHide(source: object, key: string): void {
    const timers = autoHideTimersBySource.get(source);
    const timer = timers?.get(key);
    if (!timer) return;
    cancelSchedule(timer);
    timers?.delete(key);
    if (timers?.size === 0) autoHideTimersBySource.delete(source);
  }

  // [并发] 每个 turn 键独立计时：先撤销同键旧计时器，再注册新计时器，保证同一键只有最后一次上报有效。
  // [事务] 回调内三步顺序不可交换：先比对计时器身份，再删键，最后判聚合，否则会误判仍有活跃 turn。
  // 身份比对用桶内当前 timer 与自身做全等判断，覆盖「键被重建但旧计时器未取消」的竞态。
  // 删键与清桶必须成对：空桶留在 Map 里会让遍历白跑，并延长 source 对象存活时间。
  // [失败路径] 到期时若无活跃 turn 就调用 beginHide，这是 runtime 漏发 inactive 时的最后一道关。
  function scheduleAutoHide(source: object, key: string): void {
    cancelAutoHide(source, key);
    const timers = autoHideTimersBySource.get(source) ?? new Map();
    autoHideTimersBySource.set(source, timers);
    let timer: ReturnType<typeof setTimeout>;
    timer = schedule(() => {
      const currentTimers = autoHideTimersBySource.get(source);
      if (currentTimers?.get(key) !== timer) return;
      currentTimers.delete(key);
      if (currentTimers.size === 0) autoHideTimersBySource.delete(source);

      const sourceKeys = activeTurnKeysBySource.get(source);
      if (!sourceKeys?.delete(key)) return;
      if (sourceKeys.size === 0) activeTurnKeysBySource.delete(source);
      // 安全计时器是 fail-hidden 边界：即使 runtime 没有补发 inactive，也不能让
      // 原生浮层无限期可见；后续 CUA tool-started 会重新建立该键并重新计时。
      if (!hasActiveTurns()) beginHide();
    }, AUTO_HIDE_MS);
    timers.set(key, timer);
  }

  // [资源] setupRetryAvailable 令牌是一次性的：消费即置假，只有成功加载或窗口恢复后调用方才重新置真。
  // 已有 reconcileTimer 在飞行时直接放弃本次排程，避免失败风暴把重试堆成无限循环。
  // [权衡] 只在存在活跃 turn 时重试；无操作时宁可没有窗口，也不为空闲状态预建置顶浮层。
  function scheduleSetupRetry(): void {
    if (!setupRetryAvailable || !hasActiveTurns() || reconcileTimer) return;
    setupRetryAvailable = false;
    reconcileTimer = schedule(() => {
      reconcileTimer = null;
      ensureWindow();
    }, CREATE_RETRY_MS);
  }

  // [资源] 失败窗口先登记进 failedWindows，再尝试 destroy，防止 closed 回调把它误判为系统关闭而触发重建。
  // discardFailedWindow 仅当 target 仍是当前 window 单例时才清空三个标志位，避免误伤后来替换上的新窗口。
  // destroy 可能再次抛错，这里只记 debug 日志：句柄泄漏比状态机崩溃更可接受。
  function discardFailedWindow(target: WindowsCuaOperationIndicatorWindow): void {
    failedWindows.add(target);
    if (window === target) {
      window = null;
      windowReady = false;
      windowShown = false;
    }
    try {
      if (!target.isDestroyed()) target.destroy();
    } catch (destroyError) {
      options.logger.debug(
        "[cua-operation-indicator] failed to discard partial window",
        destroyError,
      );
    }
  }

  // [权衡] 定位跟随鼠标所在显示器的可用工作区而非主屏，保证多屏场景下浮层出现在用户正在看的那块屏。
  // 定位必须水平居中、垂直贴顶；y 由阴影内边距减去，使 CSS 阴影的可见部分正好落在设计位置。
  // 尺寸每次从 indicatorWindowSize 现算，locale 改变后无需重启即可拿到新文案对应的画布高度。
  function positionWindow(target: WindowsCuaOperationIndicatorWindow): void {
    const { width, height } = indicatorWindowSize(options.getLocale());
    const point = getCursorScreenPoint();
    const { workArea } = getDisplayNearestPoint(point);
    target.setBounds({
      width,
      height,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + INDICATOR_CARD_TOP_OFFSET - INDICATOR_SHADOW_INSET.top),
    });
  }

  function handleLoadFailure(target: WindowsCuaOperationIndicatorWindow, error: unknown): void {
    options.logger.warn("[cua-operation-indicator] failed to load window content", error);
    if (disposed || target !== window) return;
    discardFailedWindow(target);
    scheduleSetupRetry();
  }

  // [权衡] showInactive 只显示不抢焦点，避免浮层出现时打断用户正在输入的窗口。
  // 顺序固定为显示、置顶、前移；调换会让窗口在置顶生效前先闪现在错误层级。
  function showWindowOnTop(target: WindowsCuaOperationIndicatorWindow): void {
    target.showInactive();
    // Windows 隐藏透明窗口后可能清除 WS_EX_TOPMOST；showInactive 只恢复可见性，
    // 不会恢复原生 Z-order，因此每次显示后都必须重新声明层级并移到该层级最前方。
    target.setAlwaysOnTop(true, "screen-saver");
    target.moveTop();
  }

  // [并发] 加载是异步的，then 回调必须重新校验 disposed、target 同一性与 isDestroyed，因为期间可能已换窗或销毁。
  // 加载成功后先清重试令牌，再按聚合态决定显示或离场，两条分支都要显式下发 document 状态。
  // [失败路径] 同步异常与 Promise 拒绝共用 handleLoadFailure，保证任何加载失败都走同一套丢弃与重试逻辑。
  function loadContent(target: WindowsCuaOperationIndicatorWindow): void {
    try {
      positionWindow(target);
      void target
        .loadURL(indicatorDataUrl(options.getLocale()))
        .then(() => {
          if (disposed || target !== window || target.isDestroyed()) return;
          windowReady = true;
          setupRetryAvailable = false;
          if (!hasActiveTurns()) {
            // refreshContent 可能发生在窗口已经隐藏之后；HTML 默认是 active，必须在
            // 无活跃 turn 时显式恢复离场状态，避免后续错误 show() 暴露假提示。
            setDocumentState("leaving");
            return;
          }
          positionWindow(target);
          showWindowOnTop(target);
          windowShown = true;
          setDocumentState("active");
        })
        .catch((error) => handleLoadFailure(target, error));
    } catch (error) {
      handleLoadFailure(target, error);
    }
  }

  // [事务] 创建入口必须统一做四件事：平台校验、聚合校验、取消待隐藏、先复用再新建窗口，顺序不可调换。
  // 复用分支只在聚合由空转非空时重定位，避免并行 source 上报让浮层在多块屏之间跳动。
  // 已加载但已隐藏的窗口必须走 showWindowOnTop 恢复可见，只改状态位会让用户永远看不到。
  // 新建成功后立刻设置鼠标穿透与内容保护，任一条漏设都会让浮层可点击或被截屏捕获。
  // [资源] 创建抛错时先丢弃半成品窗口再排重试，绝不让半初始化句柄进入 window 单例槽位。
  function ensureWindow(repositionExisting = false): void {
    if (disposed || platform !== "win32" || !hasActiveTurns()) return;
    cancelPendingHide();
    if (window && !window.isDestroyed()) {
      if (repositionExisting) positionWindow(window);
      setDocumentState("active");
      // 根因：退场只隐藏而不销毁窗口；后续 turn 复用时必须重新显示已加载的窗口。
      if (windowReady && !windowShown) {
        showWindowOnTop(window);
        windowShown = true;
      }
      if (windowReady) setupRetryAvailable = false;
      return;
    }

    let created: WindowsCuaOperationIndicatorWindow | null = null;
    try {
      const { width, height } = indicatorWindowSize(options.getLocale());
      created = createWindow({
        width,
        height,
        alwaysOnTop: true,
        focusable: false,
        frame: false,
        // 旧窗口只给 CSS shadow 留 1px 透明边，并叠加默认 DWM 矩形阴影，
        // 导致圆角阴影被裁成硬边和灰带；扩大透明画布后由 CSS 独占阴影。
        hasShadow: false,
        resizable: false,
        show: false,
        skipTaskbar: true,
        transparent: true,
        backgroundColor: "#00000000",
        autoHideMenuBar: true,
        fullscreenable: false,
        maximizable: false,
        minimizable: false,
        movable: false,
        webPreferences: {
          contextIsolation: true,
          devTools: false,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      window = created;
      windowReady = false;
      windowShown = false;
      ownedWindows.add(created);
      created.setIgnoreMouseEvents(true);
      created.setContentProtection(true);
      created.on("closed", () => {
        const failedDuringSetup = failedWindows.delete(created as object);
        if (window === created) {
          window = null;
          windowReady = false;
          windowShown = false;
        }
        if (failedDuringSetup || disposed || !hasActiveTurns() || reconcileTimer) return;
        // 原因：系统意外关闭窗口时 Host 的 turn 仍然活跃，必须主动重建，不能等下一条状态。
        setupRetryAvailable = true;
        reconcileTimer = schedule(() => {
          reconcileTimer = null;
          ensureWindow();
        }, 0);
      });
      loadContent(created);
    } catch (error) {
      options.logger.warn("[cua-operation-indicator] failed to create secure window", error);
      if (created) discardFailedWindow(created);
      scheduleSetupRetry();
    }
  }

  // [失败路径] hide 是首选路径：保留已加载窗口供下一 turn 复用，省掉一次加载与一次首帧抖动。
  // 只有 hide 抛错才降级销毁，因为此时已无法保证窗口不可见，继续留存就是安全风险。
  function hideOrDestroy(target: WindowsCuaOperationIndicatorWindow): void {
    try {
      target.hide();
      windowShown = false;
      return;
    } catch (error) {
      // 关闭是这个浮层的安全底线：它在声称"ZCode 正在操作电脑"，隐藏失败就等于向用户
      // 撒谎。hide() 抛错时降级为销毁窗口——下一个 CUA cell 会由 ensureWindow 重建。
      options.logger.warn("[cua-operation-indicator] hide failed, destroying window", error);
    }
    if (window === target) {
      window = null;
      windowReady = false;
    }
    windowShown = false;
    try {
      if (!target.isDestroyed()) target.destroy();
    } catch (destroyError) {
      options.logger.warn(
        "[cua-operation-indicator] destroy after failed hide failed",
        destroyError,
      );
    }
  }

  // [事务] 进入离场前必须先作废 setupRetryAvailable 令牌：离场代表本轮操作结束，不应再为它重建窗口。
  // 已有 hideTimer 时直接返回，避免重复排程把离场延迟叠加成数倍时长。
  // 回调再次校验聚合与窗口同一性，只有仍未重启操作且窗口未被替换才真正隐藏。
  function beginHide(): void {
    setupRetryAvailable = false;
    if (!window || window.isDestroyed() || hideTimer) return;
    setDocumentState("leaving");
    const target = window;
    hideTimer = schedule(() => {
      hideTimer = null;
      if (!disposed && !hasActiveTurns() && target === window && !target.isDestroyed()) {
        hideOrDestroy(target);
      }
    }, HIDE_ANIMATION_MS);
  }

  // [并发] 入口先做平台与销毁校验，再解析键，保证非 Windows 环境下这条热路径零副作用。
  // 重复 active 上报走快路径：撤销待隐藏、刷新计时器、确保窗口，不重复改动聚合集合。
  // 首次激活必须记录聚合原本是否为空，这个布尔决定窗口是否需要重新贴到当前鼠标所在屏。
  // inactive 上报只有真正删掉键才继续，重复上报直接返回，避免把别人的 turn 计入离场判定。
  function handleState(source: object, event: HostCuaOperationStateResponse): void {
    if (disposed || platform !== "win32") return;
    const key = keyFor(event);
    const sourceKeys = activeTurnKeysBySource.get(source);
    if (event.active) {
      if (sourceKeys?.has(key)) {
        cancelPendingHide();
        scheduleAutoHide(source, key);
        ensureWindow();
        return;
      }
      const wasActive = hasActiveTurns();
      if (!wasActive) setupRetryAvailable = true;
      const nextKeys = sourceKeys ?? new Set<string>();
      nextKeys.add(key);
      activeTurnKeysBySource.set(source, nextKeys);
      scheduleAutoHide(source, key);
      // 只有 aggregate 从空变为非空时按当前鼠标显示器重定位，避免并行 source 让窗口跳动。
      ensureWindow(!wasActive);
      return;
    }
    if (!sourceKeys?.delete(key)) return;
    cancelAutoHide(source, key);
    if (sourceKeys.size === 0) activeTurnKeysBySource.delete(source);
    if (!hasActiveTurns()) beginHide();
  }

  // [资源] source 整体下线时先删桶，再逐个取消它的计时器，最后才判聚合，防止中途被并发上报插入。
  // 没有该 source 时立即返回，保证 clearSource 可被上层无条件重复调用。
  function clearSource(source: object): void {
    if (disposed || platform !== "win32" || !activeTurnKeysBySource.delete(source)) return;
    const timers = autoHideTimersBySource.get(source);
    for (const key of timers ? [...timers.keys()] : []) {
      cancelAutoHide(source, key);
    }
    if (!hasActiveTurns()) beginHide();
  }

  // 刷新只针对已存在且未销毁的窗口，窗口不存在时返回，由下一次 ensureWindow 顺带创建并加载。
  // 刷新前重新打开重试令牌，使新内容加载失败后仍能走一次重建而不是从此静默。
  function refreshContent(): void {
    if (disposed || platform !== "win32" || !window || window.isDestroyed()) return;
    if (hasActiveTurns()) setupRetryAvailable = true;
    loadContent(window);
  }

  function ownsWindow(candidate: object): boolean {
    return ownedWindows.has(candidate);
  }

  // [资源] 销毁顺序固定：置位、清集合、取消全部计时器、清隐藏与重建计时器、最后销毁窗口。
  // 先清集合再取消计时器，避免回调在遍历过程中改动正在迭代的 Map。
  // 窗口句柄先摘到局部变量再置空，随后统一 destroy，防止 closed 回调重入时读到悬空单例。
  // [失败路径] disposed 短路让本方法可重复调用，也保证销毁期间到达的上报不会再建出新窗口。
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    setupRetryAvailable = false;
    activeTurnKeysBySource.clear();
    for (const [source, timers] of autoHideTimersBySource) {
      for (const timer of timers.values()) cancelSchedule(timer);
      autoHideTimersBySource.delete(source);
    }
    cancelPendingHide();
    if (reconcileTimer) {
      cancelSchedule(reconcileTimer);
      reconcileTimer = null;
    }
    const target = window;
    window = null;
    windowReady = false;
    windowShown = false;
    if (target && !target.isDestroyed()) target.destroy();
  }

  return { handleState, clearSource, ownsWindow, refreshContent, dispose };
}
