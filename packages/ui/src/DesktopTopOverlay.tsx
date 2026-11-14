// INV-01 顶层容器恒为 absolute left-0 top-0 z-20，守住位置在标题栏之上，改为 relative 即改错故障，会推开下方三栏布局
// INV-02 外层 pointer-events-none 与内层 pointer-events-auto 成对出现，守住位置只让按钮区接管鼠标，删掉任一侧都是改错故障
// INV-03 内层交互容器带 [app-region:no-drag]，守住位置在 Electron 拖拽区之外，缺省时改错故障表现为点击被窗口拖动吞掉
// INV-04 平台判定顺序为 Windows 先于 Linux 先于 mac，守住位置在 isLinuxDesktop 的三重排除，先判 mac 就是改错故障
// INV-05 usesCustomCaptionArea 等价于 Windows 或 Linux，守住位置决定自绘标题栏分支，mac 桌面误入即改错故障
// INV-06 mac 左内边距只在非全屏且数值有限时生效，守住位置避免全屏下留出空洞，NaN 直传属于改错故障
// INV-07 Windows 右内边距走 CSS 变量回退，守住位置让原生 caption 按钮不被覆盖，写死像素值即改错故障
// INV-08 浮层宽度仅在侧栏可见时绑定 --workspace-sidebar-panel-width，守住位置与侧栏同宽，常驻固定宽度是改错故障
// INV-09 工具组高度 mac 为 h-14、自绘标题栏为 h-12，守住位置保证与 Header 中心线对齐，混用高度即改错故障
// INV-10 mt-px 只在自绘标题栏追加，守住位置补偿 1px 边框，给 mac 加上属于改错故障
// INV-11 Windows 额外 top-1.5、Linux 额外 top-1，守住位置抵消各平台留白差异，互换偏移即改错故障
// INV-12 新建任务按钮可见性默认取侧栏收起态，守住位置在展开态由容器查询隐藏，忽略 showNewTaskButton 覆盖是改错故障
// INV-13 新建任务按钮用零宽加透明折叠而非卸载，守住位置保留 300ms 宽度过渡，改成条件渲染即改错故障
// INV-14 hideTaskNavigationButtons 为真时前进后退整组不挂载，守住位置在远程移动端窄屏，只加 disabled 是改错故障
// INV-15 前进后退的 disabled 分别绑 canTaskNavBack 与 canTaskNavForward，守住位置隔离两个方向能力，共用 canGoBack 即改错故障
// INV-16 新建任务按钮的 disabled 由禁用原因文案是否存在决定，守住位置单点收口，另设布尔标志即改错故障
// INV-17 更新按钮位于按钮组末端且不参与平台留白包裹，守住位置常驻全局入口，随侧栏宽度隐藏属于改错故障
// INV-18 组件不持有任何本地 state，守住位置是 props 到样式与 DOM 的纯映射，加 state 缓存派生值即改错故障
//
// 模块职责：渲染工作区顶部浮层，聚合侧栏开关、任务前进后退、新建任务与更新状态入口，并按平台适配标题栏留白。
// 状态所有权：全部状态由父级提供，本组件只做 props 到样式与 DOM 的派生映射，不保存副本。
// 阅读顺序：先看 props 契约，再看平台判定与 padding 派生，最后进入三层 DOM 与各按钮分支。
import { SidebarTooltipProvider } from "@/ControlHintTooltip.js";
import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  MessageCirclePlus,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { UpdateStatusButton } from "@/UpdateStatusButton.js";
import { DesktopTopOverlayActionButton } from "@/DesktopTopOverlayActionButton.js";
import { ZCodeStartupLogoBadge } from "@/root/RootStartupLoading.js";
import {
  createWindowsCaptionControlsStyle,
  WINDOWS_CAPTION_CONTROLS_RIGHT_INSET_VAR,
} from "@/windowCaptionControls.js";

// props 由平台标志与回调两组构成，平台标志均可选，缺省即按浏览器环境降级
// workspaceAbsPath、appLogoUrl、canGoBack、canGoForward 在解构处被显式丢弃，仅保留签名兼容
// newTaskDisabledReason 承载禁用文案而非布尔，undefined 与空串都表示可点击
interface DesktopTopOverlayProps {
  workspaceAbsPath: string;
  isMacDesktop?: boolean;
  isMacFullscreen?: boolean;
  isWindowsDesktop?: boolean;
  isDesktop?: boolean;
  macWindowControlsLeftPaddingPx?: number;
  windowsWindowControlsRightPaddingPx?: number;
  isSidebarVisible: boolean;
  updateReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
  toggleSidebarShortcutLabel: string;
  newTaskShortcutLabel: string;
  goBackShortcutLabel: string;
  goForwardShortcutLabel: string;
  canTaskNavBack: boolean;
  canTaskNavForward: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  showNewTaskButton?: boolean;
  appLogoUrl: string;
  platform: IPlatformService;
  onToggleSidebar: () => void;
  onCreateTask: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  hideTaskNavigationButtons?: boolean;
  newTaskDisabledReason?: string;
}

export function DesktopTopOverlay({
  workspaceAbsPath: _workspaceAbsPath,
  isMacDesktop,
  isMacFullscreen,
  isWindowsDesktop,
  isDesktop,
  macWindowControlsLeftPaddingPx,
  windowsWindowControlsRightPaddingPx,
  isSidebarVisible,
  updateReadyVersion,
  updateState,
  toggleSidebarShortcutLabel,
  newTaskShortcutLabel,
  goBackShortcutLabel,
  goForwardShortcutLabel,
  canTaskNavBack,
  canTaskNavForward,
  canGoBack: _canGoBack,
  canGoForward: _canGoForward,
  showNewTaskButton,
  appLogoUrl: _appLogoUrl,
  platform,
  onToggleSidebar,
  onCreateTask,
  onGoBack,
  onGoForward,
  hideTaskNavigationButtons = false,
  newTaskDisabledReason,
}: DesktopTopOverlayProps) {
  // 所有可见文案先取 intl，再分发到 title、ariaLabel 与 shortcut 三处
  // 标题与 ariaLabel 复用同一 id，读屏提示与悬停提示保持一致，不要在此拼接平台后缀
  // shortcut 文本由调用方按当前快捷键配置生成，组件内不做任何格式化
  const { intl } = useZCodeIntl();
  const SidebarToggleIcon = isSidebarVisible ? PanelLeftClose : PanelLeftOpen;
  // 三平台互斥判定以 isDesktop 为前提，纯浏览器环境恒为 false
  // usesCustomCaptionArea 依赖本行结果，Linux 与 Windows 共用自绘标题栏分支
  // isDesktop 缺省时 Linux 判定失败，浮层退化为无留白的纯按钮条
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  const usesCustomCaptionArea = isWindowsDesktop || isLinuxDesktop;
  const toggleSidebarTitle = intl.formatMessage({
    id: "workspaceSidebar.toggleSidebar",
  });
  const newTaskTitle = intl.formatMessage({ id: "sidebar.newTask" });
  const taskBackTitle = intl.formatMessage({ id: "taskNav.back" });
  const taskForwardTitle = intl.formatMessage({ id: "taskNav.forward" });
  // 空值合并而非逻辑或，showNewTaskButton 显式 false 必须能压制默认值
  // 默认策略是侧栏收起才显示新建任务，展开态把入口让给侧栏自带按钮
  // 可见性同时驱动 aria-hidden 与宽度类，两者必须同源，否则留下可聚焦的零宽按钮
  const isNewTaskButtonVisible = showNewTaskButton ?? !isSidebarVisible;
  // 仅在 mac 桌面且非全屏时计算左内边距，全屏下红绿灯隐藏，留白必须归零
  // Number.isFinite 过滤 undefined 与 NaN，防止拼出 paddingLeft 为 NaNpx 的非法样式
  // Math.round 吸收亚像素测量值后再兜底 96，顺序颠倒会让兜底值失去意义
  const macTopOverlayPaddingStyle =
    isMacDesktop && !isMacFullscreen && Number.isFinite(macWindowControlsLeftPaddingPx)
      ? { paddingLeft: `${Math.round(macWindowControlsLeftPaddingPx ?? 96)}px` }
      : undefined;
  const windowsTopOverlayPaddingStyle = isWindowsDesktop
    ? {
        ...createWindowsCaptionControlsStyle(windowsWindowControlsRightPaddingPx),
        paddingRight: WINDOWS_CAPTION_CONTROLS_RIGHT_INSET_VAR,
      }
    : undefined;
  // 侧栏可见时宽度锁定为侧栏面板宽度的 CSS 变量，收起时交回内容自适应
  // 宽度绑定影响容器查询阈值，展开态下更新按钮的显隐由此间接决定
  // 此处只写 width 不写 minWidth，避免过渡期间撑破绝对定位容器
  const topOverlayWidthStyle = isSidebarVisible
    ? { width: "var(--workspace-sidebar-panel-width)" }
    : undefined;

  return (
    <SidebarTooltipProvider>
      <div
        style={topOverlayWidthStyle}
        className={cn(
          // 容器查询锚点 @container/topoverlayer 供更新按钮判断自身可用宽度
          // h-14 是默认高度，自绘标题栏分支再用 h-12 覆盖，8px 差值用于对齐 Header 中心线
          // w-fit 让浮层随按钮数量收缩，固定宽度会在隐藏导航时留下空白点击热区
          "@container/topoverlayer pointer-events-none absolute h-14 flex left-0 top-0 z-20 w-fit",
          // 工具组计入各平台顶部留白和 1px 边框，与 Header 中心线对齐。
          usesCustomCaptionArea && "mt-px",
          isWindowsDesktop ? "top-1.5" : isLinuxDesktop && "top-1",
        )}
      >
        <div
          style={{
            ...macTopOverlayPaddingStyle,
            ...windowsTopOverlayPaddingStyle,
          }}
          className={cn(
            "flex items-center",
            isMacDesktop && "h-14",
            usesCustomCaptionArea && "h-12",
            // Windows/Linux 工具组计入 4px 外沿留白和 1px 边框，较 8px 左边距右移 5px。
            usesCustomCaptionArea && "pl-3 ml-px",
            isMacDesktop &&
              (isMacFullscreen ? (!isSidebarVisible ? "pl-5 pt-1" : "pl-3 pt-1") : "pt-1"),
          )}
        >
          <div
            className={cn(
              // 顶部浮层按钮虽然单个按钮打了 no-drag，但外层容器本身仍悬在窗口标题区上方。
              // Electron 在这类覆盖层上会优先按父级命中拖拽区域，导致点击被窗口拖动吞掉。
              // 这里把整块交互容器一起标成 no-drag，确保展开/收起和新建 task 都能稳定点击。
              "pointer-events-auto flex items-center gap-1 shrink-0 [app-region:no-drag]",
            )}
          >
            {usesCustomCaptionArea && (
              <DesktopTopOverlayActionButton
                title={toggleSidebarTitle}
                shortcut={toggleSidebarShortcutLabel}
                ariaLabel={toggleSidebarTitle}
                testId="desktop-top-logo-sidebar-toggle"
                buttonClassName="group relative overflow-hidden rounded-lg"
                onClick={onToggleSidebar}
              >
                <span
                  aria-hidden="true"
                  data-desktop-logo-visual
                  className="flex size-5 items-center justify-center transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
                >
                  <ZCodeStartupLogoBadge size="titlebar" animated={false} />
                </span>
                <SidebarToggleIcon className="absolute inset-0 m-auto size-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100" />
              </DesktopTopOverlayActionButton>
            )}

            {isMacDesktop && (
              <DesktopTopOverlayActionButton
                title={toggleSidebarTitle}
                shortcut={toggleSidebarShortcutLabel}
                ariaLabel={toggleSidebarTitle}
                onClick={onToggleSidebar}
              >
                <SidebarToggleIcon className="size-4" />
              </DesktopTopOverlayActionButton>
            )}

            {/* 远程控制移动端左上角空间有限，任务前进/后退在这里会与主操作拥挤重叠。*/}
            {hideTaskNavigationButtons ? null : (
              <>
                <DesktopTopOverlayActionButton
                  title={taskBackTitle}
                  shortcut={goBackShortcutLabel}
                  ariaLabel={taskBackTitle}
                  testId="desktop-top-nav-back"
                  disabled={!canTaskNavBack}
                  onClick={onGoBack}
                >
                  <ArrowLeftIcon className="size-4" />
                </DesktopTopOverlayActionButton>
                <DesktopTopOverlayActionButton
                  title={taskForwardTitle}
                  shortcut={goForwardShortcutLabel}
                  ariaLabel={taskForwardTitle}
                  disabled={!canTaskNavForward}
                  onClick={onGoForward}
                >
                  <ArrowRightIcon className="size-4" />
                </DesktopTopOverlayActionButton>
              </>
            )}

            <div
              // 折叠用 width 与 opacity 过渡，收起时同步挂 pointer-events-none 拦截命中
              // aria-hidden 跟随可见性，避免读屏用户聚焦到零宽入口
              // 外层宽度 w-7 与按钮内在尺寸对齐，改动按钮内边距需同步这里
              // disabled 仅由 newTaskDisabledReason 决定，可见性与禁用是两条独立通道
              aria-hidden={!isNewTaskButtonVisible}
              className={cn(
                "inline-flex overflow-hidden transition-[opacity,width] duration-300 ease-out",
                isNewTaskButtonVisible ? "w-7 opacity-100" : "pointer-events-none w-0 opacity-0",
              )}
            >
              <DesktopTopOverlayActionButton
                title={newTaskDisabledReason ?? newTaskTitle}
                shortcut={newTaskShortcutLabel}
                ariaLabel={newTaskTitle}
                disabled={Boolean(newTaskDisabledReason)}
                onClick={onCreateTask}
              >
                <MessageCirclePlus className="size-4" />
              </DesktopTopOverlayActionButton>
            </div>

            {/* <div className="flex items-center [app-region:no-drag]"> */}
            {/* 侧栏收起后，更新按钮之前会跟着“展开态的容器宽度阈值”一起被隐藏。
                  但收起态本身已经改成把操作集中到顶部浮层里，如果这里还继续依赖侧栏宽度判断，
                  用户就会在最需要全局入口的时候反而看不到更新按钮。
                  所以展开态继续走容器查询，收起态则强制显示。 */}
            <UpdateStatusButton
              platform={platform}
              version={updateReadyVersion}
              updateState={updateState}
              isMacDesktop={isMacDesktop}
              isWindowsDesktop={isWindowsDesktop}
            />
            {/* </div> */}
          </div>
        </div>
      </div>
    </SidebarTooltipProvider>
  );
}
