// INV-01 单一实现：守住位置 文件树导入后立即再导出；改错故障：两处入口各自封装，行为分叉。
// INV-02 布局标识固定：守住位置 FILE_MANAGER_PANEL_IDS；改错故障：布局持久化键与面板 id 失配。
// INV-03 宽度驱动紧凑：守住位置 ResizeObserver 的阈值；改错故障：窄屏仍按宽屏排版导致挤压。
// INV-04 零宽不判定：守住位置 宽度大于零的判断；改错故障：面板隐藏时被误判为窄屏。
// INV-05 偏好按工作区：守住位置 workspaceKey 的取值；改错故障：不同工作区共用一份目录显隐。
// INV-06 偏好单一来源：守住位置 store 中的导航偏好；改错故障：新建标签或重启后目录重新展开。
// INV-07 临时覆盖不外泄：守住位置 compactNavigationOpenOverride；改错故障：自动收起被写成持久偏好。
// INV-08 宽屏缺省展开：守住位置 非紧凑分支的默认值；改错故障：桌面端首次打开目录是收起的。
// INV-09 折叠而非隐藏：守住位置 useLayoutEffect 的 collapse 与 expand；改错故障：外层占位导致预览留白。
// INV-10 绘制前同步：守住位置 useLayoutEffect 的时机；改错故障：收起时闪一下再消失。
// INV-11 手柄条件显示：守住位置 紧凑或隐藏时的 hidden；改错故障：无目录时仍可拖出空白面板。
// INV-12 手柄居中：守住位置 边框与高亮的中线类；改错故障：目录边框与拖拽指示线错位。
// INV-13 导航补上下文：守住位置 navigate 补齐的工作区字段；改错故障：跨工作区打开文件丢失远端会话。
// INV-14 自动收起：守住位置 紧凑布局下的覆盖写入；改错故障：选中文件后目录仍占满屏幕。
// INV-15 切换即持久化：守住位置 toggleNavigation 的写偏好与清覆盖；改错故障：手动切换后又被临时状态覆盖。
// INV-16 空态可见：守住位置 无文件时的占位；改错故障：预览区空白无提示。
// INV-17 无障碍状态：守住位置 切换按钮的展开状态；改错故障：读屏无法判断目录是否展开。
// INV-18 调试可观测：守住位置 布局变化与尺寸日志；改错故障：布局异常无法从日志定位。
//
// 模块职责：把文件预览与目录树组合成可调宽的文件管理面板，并管理目录显隐。
// 状态所有权：当前文件与目标工作区归调用方；目录显隐偏好归 workspace store。
// 阅读顺序：导入与标识 → 属性 → 宽度观察 → 显隐推导 → 布局同步 → 导航与手柄。
import { usePanelRef } from "react-resizable-panels";
import { logger } from "@/logger.js";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { FolderOpenIcon, PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import { PreviewPane } from "@/PreviewPane.js";
import { WorkspaceFileTree } from "@/workspace-file-tree/WorkspaceFileTree.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { FileManagerTarget } from "@/lib/workspaceSidePane.js";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
} from "@/components/ui/resizable.js";

export { WorkspaceFileTree };
const FILE_MANAGER_PANEL_IDS = ["preview", "directory"];

// 在预览属性基础上追加目录字段，source 单独声明以收窄类型。
// 回调只上抛导航结果，面板不自行修改当前文件。
// 其余属性整体透传给预览，避免逐项转写遗漏。
//
type FileManagerPaneProps = Omit<ComponentProps<typeof PreviewPane>, "source"> & {
  source: CodeViewerSource | null;
  target: FileManagerTarget;
  mobileOverlay: boolean;
  canOpenLocalFileManager: boolean;
  onNavigate: (source: CodeViewerSource) => void;
};

// 面板组合预览与目录两块，布局与显隐都在本层决策。
// 所有交互经回调回到调用方，面板不持有当前打开的文件。
// 目录树只在可导航时挂载，避免无工作区时解析服务。
//
export function FileManagerPane({
  source,
  target,
  mobileOverlay,
  canOpenLocalFileManager,
  onNavigate,
  ...previewProps
}: FileManagerPaneProps) {
  const { intl } = useZCodeIntl();
  const [headerContainer, setHeaderContainer] = useState<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isNarrow, setIsNarrow] = useState(mobileOverlay);
  // ResizeObserver 监听 containerRef 宽度决定 isNarrow，仅在挂载时绑定一次。
  // 宽度为零时不更新，避免面板隐藏时被判定为窄屏。
  // 卸载时断开观察器，面板重建不会累积监听。
  //
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setIsNarrow(entry.contentRect.width < 384);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  // 导航偏好按工作区隔离，远程用标识、本地用路径。
  // 标识为空串时回落路径，避免所有本地工作区共用默认键。
  //
  const workspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
  const storedNavigationPreferenceOpen = useZCodeStore(
    (state) => state.fileManagerNavigationOpenByWorkspace[workspaceKey],
  );
  const setNavigationPreferenceOpen = useZCodeStore((state) => state.setFileManagerNavigationOpen);
  const [compactNavigationOpenOverride, setCompactNavigationOpenOverride] = useState<
    boolean | null
  >(mobileOverlay ? !source : null);
  const compactLayout = mobileOverlay || isNarrow;
  // Bug 原因：显隐原本由每个 FileManagerPane 的 useState 持有，新文件 Tab 或 App 重启会再次默认展开。
  // workspace store 现在独占用户偏好；紧凑布局选中文件后的自动收起只保留在当前面板。
  // 紧凑布局优先用本次会话的临时覆盖，其次读工作区偏好。
  // 桌面宽屏直接读 workspace store 的偏好，缺省为展开。
  // 临时覆盖只为选中文件后的自动收起服务，不写回偏好。
  //
  const navigationOpen = compactLayout
    ? (compactNavigationOpenOverride ??
      storedNavigationPreferenceOpen ??
      (!mobileOverlay || !source))
    : (storedNavigationPreferenceOpen ?? true);
  const canNavigate = Boolean(target.workspacePath && (!source || source.path));
  const showNavigation = canNavigate && navigationOpen;
  const previewPanelRef = usePanelRef();
  const directoryPanelRef = usePanelRef();
  const navigationOnly = showNavigation && (isNarrow || mobileOverlay);
  // navigationOnly 用 Panel 的折叠与展开代替样式隐藏，避免外层仍占位。
  // useLayoutEffect 在绘制前同步布局，避免收起时闪一下再消失。
  // directoryPanelRef 与预览面板的显隐依赖同一组 navigationOnly，保证宽度分配一致。
  //
  useLayoutEffect(() => {
    // Panel 的 className 只作用于内层，hidden 会留下外层占位；用库的布局状态收起并恢复宽度。
    if (navigationOnly) previewPanelRef.current?.collapse();
    else previewPanelRef.current?.expand();
    if (showNavigation) directoryPanelRef.current?.expand();
    else directoryPanelRef.current?.collapse();
    logger.debug("[FileManager] 更新目录布局", { showNavigation, navigationOnly });
  }, [showNavigation, navigationOnly, previewPanelRef, directoryPanelRef]);
  const navigationLabel = intl.formatMessage({
    id: showNavigation ? "fileManager.hideNavigation" : "fileManager.showNavigation",
  });
  // 导航前从 workspace store 补齐目标工作区，防止跨工作区打开时丢上下文。
  // 紧凑布局下选中文件后自动收起目录，把空间让给预览。
  // 自动收起只改临时覆盖的 state，不写回用户持久偏好。
  // 切换后再展开由顶部按钮负责，两条路径互不覆盖。
  //
  const navigate = (nextSource: CodeViewerSource) => {
    onNavigate({
      ...nextSource,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      workspaceRemoteSessionId: target.workspaceRemoteSessionId,
    });
    if (mobileOverlay || isNarrow) {
      setCompactNavigationOpenOverride(false);
    }
  };
  const toggleNavigation = () => {
    const nextOpen = !navigationOpen;
    setNavigationPreferenceOpen(workspaceKey, nextOpen);
    setCompactNavigationOpenOverride(null);
  };

  return (
    <div
      ref={containerRef}
      className="@container flex h-full min-h-0 min-w-0 flex-col"
      data-file-manager-pane
    >
      <div className="flex h-10 shrink-0 items-center border-b border-border bg-surface/30">
        <div ref={setHeaderContainer} className="min-w-0 flex-1">
          {!source ? (
            <span className="px-3 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "fileManager.title" })}
            </span>
          ) : null}
        </div>
        {canNavigate ? (
          <div className="flex shrink-0 items-center border-l border-border px-1.5">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={toggleNavigation}
              aria-label={navigationLabel}
              title={navigationLabel}
              aria-expanded={showNavigation}
            >
              {showNavigation ? (
                <PanelRightCloseIcon className="size-4" />
              ) : (
                <PanelRightOpenIcon className="size-4" />
              )}
            </Button>
          </div>
        ) : null}
      </div>
      <ResizablePanelGroup
        layoutId="file-manager-layout"
        panelIds={FILE_MANAGER_PANEL_IDS}
        disabled={!showNavigation || isNarrow || mobileOverlay}
        className="min-h-0 flex-1"
      >
        <ResizablePanel
          id="preview"
          panelRef={previewPanelRef}
          collapsible
          collapsedSize="0px"
          minSize="160px"
          className="min-h-0 min-w-0"
        >
          {source ? (
            <PreviewPane {...previewProps} source={source} headerContainer={headerContainer} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-ui-base text-foreground-subtle">
              <FolderOpenIcon className="size-6" />
              <span>{intl.formatMessage({ id: "fileManager.empty" })}</span>
            </div>
          )}
        </ResizablePanel>
        <ResizableHandle
          aria-label={intl.formatMessage({ id: "fileManager.resizeNavigation" })}
          className={cn(
            WORKSPACE_VERTICAL_RESIZE_HANDLE_CLASS_NAME,
            // 边框与拖拽高亮共用热区中线，避免目录边框与 resize 指示线左右错位。
            "before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border before:content-[''] after:left-1/2 after:-translate-x-1/2",
            (!showNavigation || isNarrow || mobileOverlay) && "hidden",
          )}
        />
        <ResizablePanel
          id="directory"
          panelRef={directoryPanelRef}
          collapsible
          collapsedSize="0px"
          defaultSize="192px"
          minSize="160px"
          maxSize={navigationOnly ? "100%" : "60%"}
          className="h-full min-w-0"
          onResize={(size) => logger.debug("[FileManager] 目录面板尺寸", size)}
        >
          {canNavigate ? (
            <WorkspaceFileTree
              {...target}
              canOpenLocalFileManager={canOpenLocalFileManager}
              activePreviewPath={source?.path}
              onOpenPreview={navigate}
              onOpenBrowserUrl={previewProps.onOpenBrowserUrl}
            />
          ) : null}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
