// INV-01 窗口控制区留白只认有限正数，其余回落平台默认值：守住位置 readFinitePositivePx；改错故障 平台返回 0 或非法值时标题栏按钮被内容遮挡。
// INV-02 macOS 默认左留白与 Windows 默认右留白是常量，不在组件内写死：守住位置 两个默认常量；改错故障 设计稿调整时多处不同步。
// INV-03 窗口状态查询必须「先订阅再查询」并用修订号防覆盖：守住位置 第二个副作用；改错故障 启动时已最大化的窗口显示成普通态。
// INV-04 卸载时必须置销毁标记并退订：守住位置 查询副作用的清理函数；改错故障 卸载后回调仍写状态，触发警告。
// INV-05 仅 Linux 桌面把最大化状态映射到根元素类名：守住位置 根元素类名切换；改错故障 macOS 圆角被误裁。
// INV-06 全屏订阅只在 macOS 桌面启用：守住位置 第一个副作用的前置判断；改错故障 其它平台收到无意义全屏回调。
// INV-07 非 macOS 时左留白恒为默认值，非 Windows 时右留白恒为默认值：守住位置 两个解析分支；改错故障 平台间留白串用。
// INV-08 页面缩放后必须重新同步原生控制区几何：守住位置 第三个订阅副作用；改错故障 缩放后按钮与内容重叠。
// INV-09 控制区事件中只更新对应平台的留白：守住位置 两个条件赋值；改错故障 macOS 左右两侧互相覆盖。
// INV-10 更新就绪版本提升到应用级统一管理：守住位置 更新就绪订阅；改错故障 多个入口各自维护分叉状态。
// INV-11 更新状态查询与事件订阅要共用修订号：守住位置 修订号引用与两处比较；改错故障 较慢的查询覆盖较新的推送。
// INV-12 更新状态查询失败只记警告，不影响界面：守住位置 查询的拒绝分支；改错故障 一次网络失败阻塞启动。
// INV-13 旧的就绪版本只在新状态为已下载时保留：守住位置 resolveLegacyReadyVersionFromState；改错故障 进入安装错误后仍显示可安装。
// INV-14 Windows 更新提示每次会话只弹一次：守住位置 已提示引用；改错故障 重复推送遮挡主界面。
// INV-15 提示文案必须走国际化而不是拼接：守住位置 toast 调用；改错故障 多语言环境下出现硬编码英文。
// INV-16 初始留白只在挂载时求值一次：守住位置 状态初值函数；改错故障 每次渲染都读平台指标，造成抖动。
// INV-17 侧栏容器引用只暴露不写入，由使用方绑定：守住位置 返回对象；改错故障 引用被多处抢占。
// INV-18 所有订阅副作用都必须返回清理函数：守住位置 四个副作用的返回；改错故障 重复挂载后监听叠加。
//
// 模块职责：汇总应用外壳所需的窗口外观、平台留白与自动更新状态，并对外提供只读快照与容器引用。
// 状态所有权：四项状态都由本 hook 持有；平台原生窗口状态归主进程，本 hook 只订阅与查询。
// 阅读顺序：先看两个解析函数，再读 hook 的参数与初值，最后看窗口状态、控制区与更新三组副作用。
import { useEffect, useRef, useState } from "react";
import type { DesktopWindowChromeState, IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX = 96;
const WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX = 136;

// readFinitePositivePx 只接受 typeof value === "number" && Number.isFinite(value) && value > 0 的值并 Math.round：负数、NaN、Infinity 与字符串一律返回 null，让 resolveInitialWindowControlsPaddingPx 回落到平台默认留白而不是写 0；取整避免亚像素导致按钮半像素模糊。
function readFinitePositivePx(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

// resolveInitialWindowControlsPaddingPx 优先读平台上报的几何，读不到时回落到默认留白。
// macOS 只影响左侧，Windows 只影响右侧，互不干扰。
// 非桌面环境两侧都返回默认值，保证首帧稳定。
function resolveInitialWindowControlsPaddingPx({
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  platform,
}: {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  platform: IPlatformService;
}) {
  const metrics = platform.getWindowControlsOverlayMetrics?.();
  const leftPaddingPx =
    isDesktop && isMacDesktop
      ? (readFinitePositivePx(metrics?.leftPaddingPx) ??
        MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX)
      : MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX;
  const rightPaddingPx =
    isDesktop && isWindowsDesktop
      ? (readFinitePositivePx(metrics?.rightPaddingPx) ??
        WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX)
      : WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX;

  return { leftPaddingPx, rightPaddingPx };
}

// resolveLegacyReadyVersionFromState 只在 payload.kind === "update-downloaded" 时返回 payload.version，其余状态返回 null：旧的 UpdateReady 事件不知道后续 staging error，不在这里清掉旧 ready 会让已不可安装的版本继续显示可安装。
function resolveLegacyReadyVersionFromState(payload: UpdateStatePayload) {
  // 旧的 UpdateReady 事件只会告诉 renderer “某版本 ready”，不会告诉它后续
  // 进入 staging error 等不可安装状态。新状态流一旦不是 update-downloaded，就必须清掉旧 ready。
  return payload.kind === "update-downloaded" ? payload.version : null;
}

// useAppChromeState 的入参 isDesktop/isMacDesktop/isWindowsDesktop/platform/workspaceAbsPath 中，workspaceAbsPath 只进日志定位、不参与状态计算；返回值是只读快照加一个可写入的 sidebarContainerRef，引用只暴露不在此写入，由使用方绑定。
export function useAppChromeState({
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  platform,
  workspaceAbsPath,
}: {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  platform: IPlatformService;
  workspaceAbsPath: string;
}) {
  const initialWindowControlsPadding = resolveInitialWindowControlsPaddingPx({
    isDesktop,
    isMacDesktop,
    isWindowsDesktop,
    platform,
  });
  const [isMacFullscreen, setIsMacFullscreen] = useState(false);
  const [desktopWindowChromeState, setDesktopWindowChromeState] =
    useState<DesktopWindowChromeState | null>(null);
  const [macWindowControlsLeftPaddingPx, setMacWindowControlsLeftPaddingPx] = useState(
    () => initialWindowControlsPadding.leftPaddingPx,
  );
  const [windowsWindowControlsRightPaddingPx, setWindowsWindowControlsRightPaddingPx] = useState(
    () => initialWindowControlsPadding.rightPaddingPx,
  );
  const [updateReadyVersion, setUpdateReadyVersion] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null);
  const sidebarContainerRef = useRef<HTMLElement | null>(null);
  const hasShownUpdateToastRef = useRef(false);
  const updateStateEventRevisionRef = useRef(0);
  const { intl } = useZCodeIntl();

  useEffect(() => {
    if (!isDesktop || !isMacDesktop) {
      setIsMacFullscreen(false);
      setMacWindowControlsLeftPaddingPx(MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX);
      return;
    }

    // macOS 全屏后红绿灯会重新贴近左上角布局。
    // 顶部浮层继续沿用窗口态的 pl-24 会把左侧安全区撑得过大，视觉上像是三键"消失"。
    // 这里订阅桌面窗口全屏状态，只在 macOS 全屏时收窄留白，不影响普通窗口态。
    return platform.onWindowFullscreenChanged((fullscreen) => {
      setIsMacFullscreen(fullscreen);
    });
  }, [isDesktop, isMacDesktop, platform]);

  useEffect(() => {
    // 排除 macOS 会让版本始终未知，Tahoe 也错误采用 Sequoia 的 6px 圆角。
    // 所有桌面平台共用窗口状态查询，保留事件优先和卸载清理；Web 不读取原生状态。
    if (!isDesktop || !platform.getDesktopWindowChromeState) {
      setDesktopWindowChromeState(null);
      return;
    }

    // 先订阅事件再主动查询：启动时已最大化的窗口也能拿到状态。
    // 修订号在每次事件到达时自增，查询结果只有修订号未变才落地。
    // [并发] 查询较慢而事件先到时，修订号不等使查询结果被丢弃。
    // 清理时先置销毁标记再退订，双保险防止迟到回调写状态。
    let disposed = false;
    let eventRevision = 0;
    const dispose = platform.onDesktopWindowChromeStateChanged?.((state) => {
      eventRevision += 1;
      setDesktopWindowChromeState(state);
    });
    const requestRevision = eventRevision;

    // 只监听 maximize/unmaximize 会漏掉“应用启动时窗口已最大化”的初始状态。
    // 先订阅再主动查询，并用 revision 防止较慢的查询结果覆盖更新的窗口事件。
    void platform.getDesktopWindowChromeState().then(
      (state) => {
        if (!disposed && eventRevision === requestRevision) setDesktopWindowChromeState(state);
      },
      (error) => logger.warn("[app-chrome] 同步桌面窗口外观状态失败", { error }),
    );

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [isDesktop, platform]);

  useEffect(() => {
    const isLinuxDesktop = isDesktop && !isMacDesktop && !isWindowsDesktop;
    const rootElement = document.documentElement;
    if (!rootElement) return;
    // Linux 外壳由 renderer 裁切，若最大化后仍保留圆角，屏幕四角会露出透明缺口。
    // 复用 main 进程的窗口状态作为唯一来源，让 Workspace 与设置页同时切换。
    rootElement.classList.toggle(
      "window-maximized",
      isLinuxDesktop && (desktopWindowChromeState?.isMaximized ?? false),
    );
    return () => rootElement.classList.remove("window-maximized");
  }, [desktopWindowChromeState?.isMaximized, isDesktop, isMacDesktop, isWindowsDesktop]);

  useEffect(() => {
    if (
      !isDesktop ||
      (!isMacDesktop && !isWindowsDesktop) ||
      !platform.onWindowControlsOverlayChanged
    ) {
      setMacWindowControlsLeftPaddingPx(MACOS_WINDOW_CONTROLS_DEFAULT_LEFT_PADDING_PX);
      setWindowsWindowControlsRightPaddingPx(WINDOWS_WINDOW_CONTROLS_DEFAULT_RIGHT_PADDING_PX);
      return;
    }

    // 页面缩放后，原生窗口控制区不会随 renderer zoom 一起缩放。
    // macOS 同步左侧红绿灯安全区，Windows 同步右侧标题栏按钮安全区。
    return platform.onWindowControlsOverlayChanged((metrics) => {
      const leftPaddingPx = readFinitePositivePx(metrics.leftPaddingPx);
      const rightPaddingPx = readFinitePositivePx(metrics.rightPaddingPx);
      logger.debug("[app-chrome] 收到原生窗口控制区几何变化", {
        isMacDesktop,
        isWindowsDesktop,
        leftPaddingPx,
        rightPaddingPx,
      });
      if (isMacDesktop && leftPaddingPx !== null) {
        setMacWindowControlsLeftPaddingPx(leftPaddingPx);
      }
      if (isWindowsDesktop && rightPaddingPx !== null) {
        setWindowsWindowControlsRightPaddingPx(rightPaddingPx);
      }
    });
  }, [isDesktop, isMacDesktop, isWindowsDesktop, platform]);

  useEffect(() => {
    if (!platform.onUpdateReady) {
      return;
    }

    // 更新就绪状态之前散落在按钮组件内部，各处只能各自重复订阅平台事件。
    // 这样 WorkspaceHeader 无法知道"当前是否有更新"，也容易让多个入口各自维护一份分叉状态。
    // 这里把 version 提升到 App 统一管理，再按需往 Header / Overlay 分发。
    // 收到可安装版本即提升到应用级，供标题栏与浮层共用。
    // 日志带上工作区路径，便于定位是多窗口中的哪一个。
    // Windows 首次收到时弹一次轻提示，不阻塞主界面。
    // 提示标记用引用保存，避免重复推送。
    return platform.onUpdateReady((version) => {
      logger.info("[App] 收到可安装更新", {
        workspaceAbsPath,
        version,
      });
      setUpdateReadyVersion(version);

      // Windows 桌面端收到更新时显示轻提示，不阻塞主界面
      if (isWindowsDesktop && !hasShownUpdateToastRef.current) {
        hasShownUpdateToastRef.current = true;
        toast(intl.formatMessage({ id: "update.toast.ready" }, { version }), {
          durationMs: 4000,
          position: "bottom-left",
          variant: "update",
        });
      }
    });
  }, [platform, workspaceAbsPath, isWindowsDesktop, intl]);

  useEffect(() => {
    let cancelled = false;

    // 先记录当前修订号，查询结果回来时要求修订号未变。
    // [时序] 查询与推送共用修订号，较慢的查询不会覆盖较新的推送。
    // 查询失败只记警告，界面沿用上一次快照。
    // 每次 updateState 推送都让 updateStateEventRevisionRef 自增，慢查询回来时比对旧修订号即作废。
    if (platform.getUpdateState) {
      const requestRevision = updateStateEventRevisionRef.current;
      void platform.getUpdateState().then(
        (payload) => {
          if (!cancelled && updateStateEventRevisionRef.current === requestRevision) {
            setUpdateState(payload);
            setUpdateReadyVersion(resolveLegacyReadyVersionFromState(payload));
          }
        },
        (error) => {
          logger.warn("[App] 同步自动更新状态失败", { error });
        },
      );
    }

    if (!platform.onUpdateStateChanged) {
      return () => {
        cancelled = true;
      };
    }

    const dispose = platform.onUpdateStateChanged((payload) => {
      updateStateEventRevisionRef.current += 1;
      setUpdateState(payload);
      setUpdateReadyVersion(resolveLegacyReadyVersionFromState(payload));
    });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [platform]);

  return {
    isMacFullscreen,
    desktopWindowChromeState,
    macWindowControlsLeftPaddingPx,
    windowsWindowControlsRightPaddingPx,
    updateReadyVersion,
    updateState,
    sidebarContainerRef,
  };
}
