// INV-01 ref 与 state 必须成对维护，ref 只供事件回调读取最新值：守住位置 三组 ref/state；改错故障 回调闭包读到过期状态，模式切换丢一次。
// INV-02 进入响应式模式时把缩放重置为默认值：守住位置 applyResponsiveMode 的假转真判断；改错故障 用户刚选的固定缩放被覆盖。
// INV-03 只有假转真才重置缩放，真转真不重置：守住位置 新值与 ref 的联合判断；改错故障 模型下发的尺寸同步把人工缩放冲掉。
// INV-04 视口同步必须等主进程指标完成后再回调：守住位置 updateControlledViewport 的成功回调；改错故障 提前设置的缩放被页面缩放异步传播改回。
// INV-05 同步失败只记调试日志，不抛给界面：守住位置 catch 分支；改错故障 一次视口失败变成全局错误提示。
// INV-06 模型变更的视口事件要按标签页与会话双重过滤：守住位置 事件回调前两行；改错故障 其他标签页的尺寸串到当前浏览器。
// INV-07 模型给出视口即进入响应式，给出空值即退出：守住位置 事件回调收尾分支；改错故障 人工模式与模型模式互相拉扯。
// INV-08 模式变更提示必须按「变更后是否与当前模式不同」计算：守住位置 回调内的布尔表达式；改错故障 重排弱提示误报。
// INV-09 人工偏好上报必须读 ref 而非 state：守住位置 reportHumanViewportPreference 的取值；改错故障 上报滞后一帧，丢失最后一次操作。
// INV-10 未提供初始偏好或未注入回调时不上报：守住位置 上报函数首行判断；改错故障 只读场景也产生写请求。
// INV-11 切换模式前先触发一次重排通知：守住位置 toggleResponsiveMode 首行；改错故障 容器已变但宿主未重排，出现空白条。
// INV-12 切换模式时立即同步宿主视口，退出时传空值：守住位置 toggleResponsiveMode 内的同步调用；改错故障 退出响应式后仍保留旧尺寸。
// INV-13 页面缩放变化只在响应式模式内重发同一视口：守住位置 第一个副作用的三项前置条件；改错故障 普通模式下产生多余的宿主调用。
// INV-14 初始人类视口同步只允许执行一次：守住位置 已同步标记；改错故障 每次重渲染都重设尺寸，用户无法手动调整。
// INV-15 尺寸更新必须同时写 ref、state 与宿主：守住位置 updateResponsiveViewportSize 三行；改错故障 三者不一致，切换模式后尺寸回跳。
// INV-16 缩放更新只写 ref/state 并上报，不调用宿主：守住位置 updateResponsiveViewportZoom；改错故障 每次缩放都触发一次昂贵的视口重设。
// INV-17 平台能力缺失时所有调用必须安全降级：守住位置 可选调用与空值判断；改错故障 Web 端渲染直接抛错。
// INV-18 订阅必须返回清理函数：守住位置 第二个副作用的返回；改错故障 卸载后回调仍持有旧状态，产生内存泄漏。
//
// 模块职责：管理嵌入式浏览器的响应式视口状态，并把它与宿主视口、模型事件、人类偏好三路同步。
// 状态所有权：模式、尺寸、缩放由本 hook 持有；宿主视口由主进程持有，本 hook 只发请求。
// 阅读顺序：先看参数与初始值，再看三组 ref/state，然后读上报、模式切换、宿主同步，最后看两个副作用与初始化同步。
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BrowserViewportSize,
  BrowserViewportZoom,
  EmbeddedBrowserViewportPreference,
} from "@zcode/shared";
import { DEFAULT_BROWSER_VIEWPORT_ZOOM } from "@/browser-use/browserViewportZoom.js";
import { DEFAULT_RESPONSIVE_BROWSER_VIEWPORT_SIZE } from "@/browser-use/ResponsiveBrowserViewport.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

export type HumanBrowserViewportPreferenceChangeSource = "mode" | "viewport" | "zoom";

// 入参分三类：浏览器标识、宿主缩放、三类回调。
// 浏览器标识决定操作哪个标签页，同时用于过滤该标签页的视口事件。
// 宿主缩放只用于感知页面缩放变化，不参与尺寸计算。
// 初始偏好决定首帧模式与尺寸，未提供时默认普通模式与默认尺寸。
// [权衡] 偏好通过回调外抛而不在本 hook 持久化，存储责任留给调用方。
export function useResponsiveBrowserViewportControl({
  browserKey,
  desktopZoomFactor,
  onAgentViewportChange,
  onViewportSynchronized,
  onViewportResize,
  initialHumanViewportPreference,
  onHumanViewportPreferenceChange,
  sessionId,
}: {
  browserKey: string;
  desktopZoomFactor: number;
  onAgentViewportChange: (willChangeResponsiveMode: boolean) => void;
  onViewportSynchronized: () => void;
  onViewportResize: () => void;
  initialHumanViewportPreference?: EmbeddedBrowserViewportPreference;
  onHumanViewportPreferenceChange?: (
    preference: EmbeddedBrowserViewportPreference,
    source: HumanBrowserViewportPreferenceChangeSource,
  ) => void;
  sessionId?: string;
}) {
  const platform = usePlatform();
  const initialResponsiveMode = initialHumanViewportPreference?.mode === "responsive";
  const initialResponsiveViewportSize =
    initialHumanViewportPreference?.viewport ?? DEFAULT_RESPONSIVE_BROWSER_VIEWPORT_SIZE;
  const initialResponsiveViewportZoom =
    initialHumanViewportPreference?.zoom ?? DEFAULT_BROWSER_VIEWPORT_ZOOM;
  const [isResponsiveMode, setIsResponsiveMode] = useState(initialResponsiveMode);
  const [responsiveViewportSize, setResponsiveViewportSize] = useState<BrowserViewportSize>({
    ...initialResponsiveViewportSize,
  });
  const [responsiveViewportZoom, setResponsiveViewportZoom] = useState<BrowserViewportZoom>(
    initialResponsiveViewportZoom,
  );
  const isResponsiveModeRef = useRef(initialResponsiveMode);
  const responsiveViewportSizeRef = useRef<BrowserViewportSize>({
    ...initialResponsiveViewportSize,
  });
  const responsiveViewportZoomRef = useRef<BrowserViewportZoom>(initialResponsiveViewportZoom);
  const didSynchronizeInitialHumanViewportRef = useRef(false);
  const lastDesktopZoomFactorRef = useRef(desktopZoomFactor);
  const wasResponsiveModeForZoomRef = useRef(initialResponsiveMode);

  // 只有同时具备初始偏好与上报回调时才上报，避免只读宿主产生写请求。
  // 取值一律读 ref：回调可能来自原生事件，闭包里的 state 已经过期。
  // 上报时用 { ...responsiveViewportSizeRef.current } 复制一份，防止调用方改掉 ref 里的共享对象。
  // 来源区分模式、尺寸、缩放三种，便于上层做差异化落盘。
  const reportHumanViewportPreference = useCallback(
    (source: HumanBrowserViewportPreferenceChangeSource) => {
      if (!initialHumanViewportPreference || !onHumanViewportPreferenceChange) return;
      onHumanViewportPreferenceChange(
        {
          mode: isResponsiveModeRef.current ? "responsive" : "normal",
          viewport: { ...responsiveViewportSizeRef.current },
          zoom: responsiveViewportZoomRef.current,
        },
        source,
      );
    },
    [initialHumanViewportPreference, onHumanViewportPreferenceChange],
  );

  // applyResponsiveMode 只在 nextMode 由假转真时把缩放重置为 DEFAULT_BROWSER_VIEWPORT_ZOOM，其他转换保持原值。
  // 真转真不重置，保证模型反复下发尺寸时人工缩放不被清掉。
  // ref 与 state 同时写，先写 ref 让同一事件循环内的后续读取立即生效。
  // applyResponsiveMode 只写 ref 与 state 不调平台接口，是否同步由调用方按场景决定。
  const applyResponsiveMode = useCallback((nextMode: boolean) => {
    // viewport 事件也会用于模式内尺寸同步；仅在 false → true 时重置，避免覆盖用户刚选的固定缩放。
    if (nextMode && !isResponsiveModeRef.current) {
      responsiveViewportZoomRef.current = DEFAULT_BROWSER_VIEWPORT_ZOOM;
      setResponsiveViewportZoom(DEFAULT_BROWSER_VIEWPORT_ZOOM);
    }
    isResponsiveModeRef.current = nextMode;
    setIsResponsiveMode(nextMode);
  }, []);

  // 平台不提供该方法时直接返回，Web 端与旧宿主共用同一实现。
  // updateControlledViewport 收到 null 时表示退出响应式，平台据此恢复普通浏览器视口。
  // [时序] 只有视口非空时才在成功后通知上层，退出路径无需重排。
  // 失败只记调试日志：视口同步是尽力而为，不应打断用户操作。
  const updateControlledViewport = useCallback(
    (viewport: BrowserViewportSize | null) => {
      const request = platform.browserViewUpdateViewport?.({ tabId: browserKey, viewport });
      if (!request) return;
      void request
        .then(() => {
          // metrics 在 main 内串行完成后再把 guest zoom 固定回 1。若提前在
          // React effect 中设置，Desktop page zoom 的异步传播会再将 guest 改回全局缩放。
          if (viewport) onViewportSynchronized();
        })
        .catch((error) => {
          logger.debug("[browser-use] 同步 tab viewport 失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [browserKey, onViewportSynchronized, platform],
  );

  // 该 effect 只在 isResponsiveMode 与上一帧同为真且缩放值变化时重发视口，避免首次进入时误触发。
  // 三个条件任一不满足即跳过：非响应式、首次进入、缩放未变。
  // Electron 的页面缩放传播可能晚于本副作用，因此重发同一尺寸让主进程再归一一次。
  // ref 记录上一帧的缩放与模式，副作用本身不依赖它们，避免额外重渲染。
  useEffect(() => {
    const wasResponsiveMode = wasResponsiveModeForZoomRef.current;
    const zoomChanged = lastDesktopZoomFactorRef.current !== desktopZoomFactor;
    wasResponsiveModeForZoomRef.current = isResponsiveMode;
    lastDesktopZoomFactorRef.current = desktopZoomFactor;
    if (!isResponsiveMode || !wasResponsiveMode || !zoomChanged) return;
    // Electron 会把新的 Desktop page zoom 传播到 guest，时机可能晚于 React effect。
    // zoom 每次变化都重发同一 viewport，让 main 在串行边界再次把 guest zoom 归一为 1。
    updateControlledViewport(responsiveViewportSize);
  }, [desktopZoomFactor, isResponsiveMode, responsiveViewportSize, updateControlledViewport]);

  // 订阅 platform.onBrowserViewViewportChanged，该事件由模型工具调用触发，人类操作走另一条上报路径。
  // 先按标签页过滤，再按会话过滤，避免多会话共享标签页时串台。
  // 卸载时由返回的清理函数退订，防止回调持有过期状态。
  useEffect(() => {
    return platform.onBrowserViewViewportChanged?.((payload) => {
      if (payload.tabId !== browserKey) return;
      if (sessionId && payload.sessionId !== sessionId) return;
      const willChangeResponsiveMode = (payload.viewport !== null) !== isResponsiveModeRef.current;
      onAgentViewportChange(willChangeResponsiveMode);
      logger.debug("[browser-use] 模型 viewport 变更不触发 resize 弱提示", {
        modeChanged: willChangeResponsiveMode,
        tabId: browserKey,
        viewport: payload.viewport,
      });
      if (payload.viewport) {
        responsiveViewportSizeRef.current = { ...payload.viewport };
        setResponsiveViewportSize({ ...payload.viewport });
        applyResponsiveMode(true);
        return;
      }
      applyResponsiveMode(false);
    });
  }, [applyResponsiveMode, browserKey, onAgentViewportChange, platform, sessionId]);

  const toggleResponsiveMode = useCallback(() => {
    onViewportResize();
    const nextMode = !isResponsiveModeRef.current;
    applyResponsiveMode(nextMode);
    updateControlledViewport(nextMode ? responsiveViewportSize : null);
    reportHumanViewportPreference("mode");
  }, [
    applyResponsiveMode,
    onViewportResize,
    reportHumanViewportPreference,
    responsiveViewportSize,
    updateControlledViewport,
  ]);

  const updateResponsiveViewportSize = useCallback(
    (viewportSize: BrowserViewportSize) => {
      responsiveViewportSizeRef.current = { ...viewportSize };
      setResponsiveViewportSize(viewportSize);
      updateControlledViewport(viewportSize);
      reportHumanViewportPreference("viewport");
    },
    [reportHumanViewportPreference, updateControlledViewport],
  );

  const updateResponsiveViewportZoom = useCallback(
    (zoom: BrowserViewportZoom) => {
      responsiveViewportZoomRef.current = zoom;
      setResponsiveViewportZoom(zoom);
      reportHumanViewportPreference("zoom");
    },
    [reportHumanViewportPreference],
  );

  // 仅当初始偏好是响应式且尚未同步过时执行一次。
  // 标记先置位再同步，防止并发调用重复下发。
  // 提供给调用方在浏览器挂载完成后主动调用，而不是在挂载时自动执行。
  const synchronizeInitialHumanViewport = useCallback(() => {
    if (
      !initialHumanViewportPreference ||
      initialHumanViewportPreference.mode !== "responsive" ||
      didSynchronizeInitialHumanViewportRef.current
    ) {
      return;
    }
    didSynchronizeInitialHumanViewportRef.current = true;
    updateControlledViewport(responsiveViewportSizeRef.current);
  }, [initialHumanViewportPreference, updateControlledViewport]);

  return {
    isResponsiveMode,
    responsiveViewportSize,
    responsiveViewportZoom,
    setResponsiveViewportZoom: updateResponsiveViewportZoom,
    synchronizeInitialHumanViewport,
    toggleResponsiveMode,
    updateResponsiveViewportSize,
  };
}
