// INV-01 只做本地弱提示：守住位置 文件头注释；改错故障 提示顺带取消工具或改写快照。
// INV-02 同一 active 周期只提示一次：守住位置 warnedForActiveCycleRef；改错故障 连续拖拽提示风暴。
// INV-03 提示三秒后自动消失：守住位置 RESIZE_WARNING_DURATION_MS；改错故障 提示常驻遮挡页面。
// INV-04 离开 active 立即复位：守住位置 isAgentOperating effect；改错故障 下一周期不再提示。
// INV-05 回调前同步 ref：守住位置 render 期赋值；改错故障 首帧回调读到上一帧状态。
// INV-06 零尺寸不算变化：守住位置 <= 0 判断；改错故障 隐藏面板触发误报。
// INV-07 首次尺寸只建基线：守住位置 previousSize !== null；改错故障 挂载即弹提示。
// INV-08 稳定期内不提示：守住位置 isAgentLayoutSettling；改错故障 模型布局动画被当成用户拖拽。
// INV-09 稳定期三段时长：守住位置 三个常量；改错故障 静默窗口无限延长或瞬间结束。
// INV-10 只有模型布局 marker 开稳定期：守住位置 hasInitialAgentMarker 与 changed；改错故障 用户切 tab 被静默。
// INV-11 普通挂载不扩大窗口：守住位置 注释与条件；改错故障 用户主动 resize 被吞掉。
// INV-12 baseline 版本变化清旧尺寸：守住位置 lastSizeRef 赋值；改错故障 跨版本比较出错行提示。
// INV-13 卸载清计时器：守住位置 末尾 effect；改错故障 定时器在卸载后写状态。
// INV-14 只暴露 ref 与三个入口：守住位置 返回值；改错故障 调用方直接改内部 state。
//
// 模块职责：Browser Use active 周期内的浏览器区域尺寸监听与本地弱提示。
// 阅读顺序：先看四个时长常量，再看提示与稳定期回调，最后看监听与清理。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBrowserUseOperationActive } from "@/browser-use/useBrowserUseOperationActive.js";
import { logger } from "@/logger.js";

// RESIZE_WARNING_DURATION_MS = 3_000，提示三秒后自动消失。
const RESIZE_WARNING_DURATION_MS = 3_000;
// 稳定期至少覆盖首帧。
const AGENT_LAYOUT_SETTLE_MIN_DURATION_MS = 300;
// AGENT_LAYOUT_SETTLE_QUIET_DURATION_MS = 100，每次回调由该值顺延 100ms，上限取 MAX 常量。
const AGENT_LAYOUT_SETTLE_QUIET_DURATION_MS = 100;
// 稳定期最多半秒，避免吞掉用户操作。
const AGENT_LAYOUT_SETTLE_MAX_DURATION_MS = 500;

/**
 * 在与 tab 鼠标图标相同的 Browser Use active 周期内监听浏览器区域尺寸。
 * 这里只产生 renderer 本地弱提示，不取消工具、不修改 snapshot，也不把状态写入协议层。
 */
export function useBrowserResizeOperationWarning({
  browserKey,
  isVisible,
  operationUntil,
  resizeBaselineVersion,
}: {
  browserKey: string;
  isVisible: boolean;
  operationUntil?: number;
  resizeBaselineVersion?: number;
}) {
  const [showResizeWarning, setShowResizeWarning] = useState(false);
  const browserRegionRef = useRef<HTMLDivElement | null>(null);
  const lastSizeRef = useRef<{ width: number; height: number } | null>(null);
  const warnedForActiveCycleRef = useRef(false);
  const warningTimerRef = useRef<number | null>(null);
  const agentLayoutSettleUntilRef = useRef(0);
  const agentLayoutSettleMaxUntilRef = useRef(0);
  const previousResizeBaselineVersionRef = useRef(resizeBaselineVersion);
  const hasAppliedResizeBaselineVersionRef = useRef(false);
  const isVisibleRef = useRef(isVisible);
  const isAgentOperating = useBrowserUseOperationActive(operationUntil);
  const isAgentOperatingRef = useRef(isAgentOperating);
  // ResizeObserver 可能在 effect 刷新前回调；render 时同步 ref，确保它和图标当帧状态一致。
  isVisibleRef.current = isVisible;
  isAgentOperatingRef.current = isAgentOperating;

  const warnForBrowserResize = useCallback(() => {
    // 不可见、非 active 或已提示过都直接返回。
    if (!isVisibleRef.current || !isAgentOperatingRef.current || warnedForActiveCycleRef.current) {
      return;
    }

    // 同一周期只提示一次，避免拖拽风暴。
    warnedForActiveCycleRef.current = true;
    setShowResizeWarning(true);
    warningTimerRef.current = window.setTimeout(() => {
      warningTimerRef.current = null;
      setShowResizeWarning(false);
    }, RESIZE_WARNING_DURATION_MS);
  }, []);

  // 稳定期从布局变化那一刻起算。
  const beginAgentLayoutSettlement = useCallback(() => {
    const now = Date.now();
    lastSizeRef.current = null;
    agentLayoutSettleUntilRef.current = now + AGENT_LAYOUT_SETTLE_MIN_DURATION_MS;
    agentLayoutSettleMaxUntilRef.current = now + AGENT_LAYOUT_SETTLE_MAX_DURATION_MS;
  }, []);

  const prepareForAgentViewportChange = useCallback(
    (willChangeResponsiveMode: boolean) => {
      if (!willChangeResponsiveMode) return;
      beginAgentLayoutSettlement();
    },
    [beginAgentLayoutSettlement],
  );

  // baseline 用 layout effect，抢在绘制前生效。
  useLayoutEffect(() => {
    const previousVersion = previousResizeBaselineVersionRef.current;
    const hasAppliedVersion = hasAppliedResizeBaselineVersionRef.current;
    const hasInitialAgentMarker = !hasAppliedVersion && (resizeBaselineVersion ?? 0) > 0;
    const agentMarkerChanged = hasAppliedVersion && previousVersion !== resizeBaselineVersion;
    previousResizeBaselineVersionRef.current = resizeBaselineVersion;
    hasAppliedResizeBaselineVersionRef.current = true;

    // 模型 newTab 的 ready/visibility 先挂载 view，真实 tabId 对应的 operation 后到；
    // marker 之后 guest 挂载和 side-pane 动画还会产生多帧 ResizeObserver 回调。只清一次
    // baseline 会吞掉第一帧，却把第二帧误报成用户 resize。这里对模型布局 marker 开启
    // 有界稳定期；普通初挂载/用户切 tab 仍只重建 baseline，不扩大静默窗口。
    lastSizeRef.current = null;
    // 只有模型布局 marker 才开稳定期。
    if (hasInitialAgentMarker || agentMarkerChanged) beginAgentLayoutSettlement();
  }, [beginAgentLayoutSettlement, isVisible, resizeBaselineVersion]);

  useEffect(() => {
    // active 期间不复位，避免状态抖动。
    if (isAgentOperating) return;
    warnedForActiveCycleRef.current = false;
    setShowResizeWarning(false);
    if (warningTimerRef.current !== null) {
      window.clearTimeout(warningTimerRef.current);
      warningTimerRef.current = null;
    }
  }, [isAgentOperating]);

  useEffect(() => {
    const element = browserRegionRef.current;
    // 无 element 或 ResizeObserver 未定义时静默返回，不注册监听。
    if (!element || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const nextSize = {
        width: Math.round(entry.contentRect.width),
        height: Math.round(entry.contentRect.height),
      };
      // 宽或高 ≤ 0 时视为零尺寸直接返回，不写入 lastSizeRef。
      if (nextSize.width <= 0 || nextSize.height <= 0) return;

      const previousSize = lastSizeRef.current;
      lastSizeRef.current = nextSize;
      const now = Date.now();
      const isAgentLayoutSettling = now <= agentLayoutSettleUntilRef.current;
      if (isAgentLayoutSettling) {
        agentLayoutSettleUntilRef.current = Math.min(
          agentLayoutSettleMaxUntilRef.current,
          Math.max(agentLayoutSettleUntilRef.current, now + AGENT_LAYOUT_SETTLE_QUIET_DURATION_MS),
        );
      }
      const sizeChanged =
        previousSize !== null &&
        (previousSize.width !== nextSize.width || previousSize.height !== nextSize.height);
      logger.debug("[browser-use] browser region ResizeObserver", {
        browserKey,
        isAgentOperating: isAgentOperatingRef.current,
        isVisible: isVisibleRef.current,
        nextSize,
        previousSize,
        resizeBaselineVersion,
        isAgentLayoutSettling,
        sizeChanged,
        warnedForActiveCycle: warnedForActiveCycleRef.current,
      });
      // 首次回调与稳定期内都不提示。
      if (!sizeChanged || isAgentLayoutSettling) return;

      // 坐标类动作可能仍基于 resize 前的视觉信息。同一 active 周期只提示一次，
      // 避免连续拖拽产生提示风暴，同时保持 locator/CUA 的既有执行语义不变。
      warnForBrowserResize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [browserKey, resizeBaselineVersion, warnForBrowserResize]);

  useEffect(
    () => () => {
      if (warningTimerRef.current !== null) window.clearTimeout(warningTimerRef.current);
    },
    [],
  );

  return {
    browserRegionRef,
    notifyBrowserViewportResize: warnForBrowserResize,
    prepareForAgentViewportChange,
    showResizeWarning,
  };
}
