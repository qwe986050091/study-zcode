// INV-01 终端首次展开后才创建会话：守住位置 渲染条件；改错故障 从未打开也占用进程。
// INV-02 首次展开标记只前进不回退：守住位置 置真赋值；改错故障 收起后会话被卸载重建。
// INV-03 拖拽期间标记为调整中：守住位置 指针回调；改错故障 每帧都触发完整重排。
// INV-04 非左键与不可见时忽略拖拽：守住位置 早退条件；改错故障 右键也能开始调整。
// INV-05 松手与失焦都结束拖拽：守住位置 事件绑定；改错故障 拖拽状态永久残留。
// INV-06 拖拽标记在收起时清零：守住位置 可见性副作用；改错故障 收起后仍按调整中限流。
// INV-07 面板隐藏时不接受拖拽：守住位置 禁用条件；改错故障 从边缘把隐藏面板拖出。
// INV-08 折叠仅在显式关闭时允许：守住位置 折叠属性；改错故障 拖到最小即自动收起。
// INV-09 隐藏时不渲染拖拽手柄：守住位置 条件渲染；改错故障 透明手柄仍占据热区。
// INV-10 收起时保留已建会话：守住位置 隐藏样式；改错故障 每次展开都重建终端。
// INV-11 错误边界按工作区重置：守住位置 重置键；改错故障 切换工作区后保留旧错误。
// INV-12 隐藏面板屏蔽指针事件：守住位置 类名合并；改错故障 透明面板仍挡住点击。
// INV-13 拖拽手柄使用统一玻璃质感：守住位置 类名常量；改错故障 三平台外观不一致。
// INV-14 面板尺寸区间由外部句柄托管：守住位置 引用透传；改错故障 多处状态互相打架。
// INV-15 关闭动作由上层提供：守住位置 回调透传；改错故障 面板自行销毁外部布局。
// INV-16 浏览器跳转经回调上抛：守住位置 参数透传；改错故障 终端内链接无法打开。
// INV-17 工作区标识空值时回落到路径：守住位置 逻辑或表达式；改错故障 错误边界键为空。
// INV-18 调整结束监听成对增删：守住位置 清理函数；改错故障 卸载后仍响应全局事件。
//
// 模块职责：工作区终端面板的可见性动画与可拖拽尺寸边界。
// 状态所有权：是否已渲染与是否正在拖拽由组件内部持有。
// 阅读顺序：先看状态与回调，再看副作用，最后看面板结构。
import { useCallback, useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { IServiceAccessor } from "@zcode/services";
import { Terminal } from "@/Terminal.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { cn } from "@/components/lib/utils.js";
import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable.js";

// hasRenderedTerminal 只在 isVisible 首次为真时置位，隐藏后仍保留已建终端。
// 收起只改 isVisible 而不卸载 Terminal 实例；重开时免去重建成本。
// isTerminalPanelResizing 期间尺寸更新降频；pointerup/pointercancel/blur 统一收尾。
// workspaceKey 由 workspaceIdentity 裁剪后回退 workspaceAbsPath，供 ScopedErrorBoundary 定位。
export function AnimatedTerminalPanel({
  services,
  workspaceAbsPath,
  workspaceIdentity,
  openWorkspaceKeys,
  isVisible,
  isWindowsDesktop,
  frameClassName = "rounded-xl border border-border",
  panelRef,
  panelElementRef,
  onClose,
  onOpenBrowserUrl,
}: {
  services: IServiceAccessor;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  openWorkspaceKeys?: string[];
  isVisible: boolean;
  isWindowsDesktop?: boolean;
  frameClassName?: string;
  panelRef: RefObject<PanelImperativeHandle | null>;
  panelElementRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  onOpenBrowserUrl: (url: string) => void;
}) {
  const [hasRenderedTerminal, setHasRenderedTerminal] = useState(isVisible);
  const [isTerminalPanelResizing, setIsTerminalPanelResizing] = useState(false);
  const isDragCollapsible = !isVisible;
  const isResizeDisabled = !isVisible;
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;

  // finishTerminalPanelResize 只把 isTerminalPanelResizing 置 false。
  // 收尾不触碰 Terminal 实例本身，避免拖拽结束时重置终端尺寸。
  // finishTerminalPanelResize 同时绑到 pointerup/pointercancel/blur 三类全局事件，共用同一收尾。
  // 回调依赖为空数组：重复调用结果一致，可安全被多个监听共用。
  const finishTerminalPanelResize = useCallback(() => {
    setIsTerminalPanelResizing(false);
  }, []);

  const handleTerminalPanelResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isVisible || (event.pointerType === "mouse" && event.button !== 0)) {
        return;
      }

      // 终端面板拖拽时会产生连续 ResizeObserver 回调。
      // 显式标记拖拽窗口，让 TerminalSession 在拖拽中低频 resize，松手后再 flush 最终尺寸。
      setIsTerminalPanelResizing(true);
    },
    [isVisible],
  );

  useEffect(() => {
    if (isVisible) {
      // Terminal 首次展开前不应该提前创建会话，否则即使用户从未打开终端，
      // 也会白白创建 xterm 和后端 terminal 进程。这里改成首次展开后再渲染，
      // 后续收起只隐藏不卸载，这样既保留会话，又避免重复初始化。
      setHasRenderedTerminal(true);
    }
  }, [isVisible]);

  useEffect(() => {
    if (!isVisible) {
      setIsTerminalPanelResizing(false);
    }
  }, [isVisible]);

  useEffect(() => {
    if (!isTerminalPanelResizing) {
      return;
    }

    window.addEventListener("pointerup", finishTerminalPanelResize);
    window.addEventListener("pointercancel", finishTerminalPanelResize);
    window.addEventListener("blur", finishTerminalPanelResize);
    return () => {
      window.removeEventListener("pointerup", finishTerminalPanelResize);
      window.removeEventListener("pointercancel", finishTerminalPanelResize);
      window.removeEventListener("blur", finishTerminalPanelResize);
    };
  }, [finishTerminalPanelResize, isTerminalPanelResizing]);

  // 拖拽手柄仅在 isVisible 为真时渲染，隐藏时不留可交互热区。
  // isDragCollapsible 取 !isVisible，只有显式关闭终端后才允许拖拽折叠。
  // isResizeDisabled 同样取 !isVisible，隐藏时 ResizableHandle 不接受尺寸拖拽。
  // Terminal 实例包在 ScopedErrorBoundary 内，终端崩溃不拖垮整个面板。
  return (
    <>
      {isVisible ? (
        <ResizableHandle
          data-workspace-terminal-resize-handle="true"
          className={cn(
            "aria-[orientation=horizontal]:h-1 aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:mx-0 aria-[orientation=horizontal]:translate-y-0 aria-[orientation=horizontal]:[mask-image:none] aria-[orientation=horizontal]:[-webkit-mask-image:none] hover:bg-transparent data-[separator=hover]:bg-transparent data-[separator=active]:bg-transparent focus-visible:bg-transparent after:pointer-events-none after:absolute after:rounded-full after:bg-foreground-subtlest/50 platform-mac-desktop:after:bg-resize-handle platform-windows-desktop:after:bg-resize-handle platform-linux-desktop:after:bg-resize-handle after:opacity-0 after:transition-opacity after:content-[''] after:inset-x-[var(--workspace-panel-radius,var(--radius-xl))] after:h-0.5 hover:after:opacity-100 data-[separator=hover]:after:opacity-100 data-[separator=active]:after:opacity-100 focus-visible:after:opacity-100",
            isTerminalPanelResizing && "after:opacity-100",
          )}
          onPointerCancel={finishTerminalPanelResize}
          onPointerDown={handleTerminalPanelResizeStart}
          onPointerUp={finishTerminalPanelResize}
        />
      ) : null}
      <ResizablePanel
        id="terminal"
        panelRef={panelRef}
        elementRef={panelElementRef}
        defaultSize="0px"
        minSize="140px"
        maxSize="50%"
        collapsedSize="0px"
        // 终端面板之前拖到最小高度就会直接进入 collapsed，和手动关闭共用了同一触发条件。
        // 这里只在显式关闭终端时允许折叠，保留原有开关动画，同时去掉“拖到最小自动收起”。
        collapsible={isDragCollapsible}
        // 收起后虽然不渲染 ResizableHandle，库仍会把 collapsed panel 边缘当成可拖拽热区。
        // 禁用隐藏终端面板的 resize target，避免用户从边缘把 terminal 拖出来。
        disabled={isResizeDisabled}
        className={cn(
          "transition-opacity duration-200 ease-out",
          isVisible ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <div
          data-workspace-terminal-frame="true"
          className={cn("h-full overflow-hidden bg-background", frameClassName)}
        >
          {hasRenderedTerminal ? (
            <div aria-hidden={!isVisible} className="h-full">
              {/* terminal 首次展开前不渲染，避免无意义初始化；
                  首次展开后保持挂载，收起时只隐藏不卸载，这样下一次展开就能直接复用现有会话。 */}
              <ScopedErrorBoundary
                scope="workspace-terminal"
                resetKeys={[workspaceKey]}
                variant="panel"
                className="h-full"
              >
                <Terminal
                  services={services}
                  cwd={workspaceAbsPath}
                  workspaceIdentity={workspaceIdentity}
                  openWorkspaceKeys={openWorkspaceKeys}
                  isVisible={isVisible}
                  isPanelResizing={isTerminalPanelResizing}
                  isWindowsDesktop={isWindowsDesktop}
                  onClose={onClose}
                  onOpenBrowserUrl={onOpenBrowserUrl}
                />
              </ScopedErrorBoundary>
            </div>
          ) : null}
        </div>
      </ResizablePanel>
    </>
  );
}
