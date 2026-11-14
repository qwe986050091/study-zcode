// INV-01 WASM 先行：守住位置 模块顶层的 setWasmSource；改错故障：查看器创建时找不到解析器而空白。
// INV-02 只读预览：守住位置 XlsxViewer 的 readOnly；改错故障：预览页可编辑源文件。
// INV-03 标签键位：守住位置 getNextSheetTabIndex 的分支；改错故障：方向键在首尾不回绕。
// INV-04 不接管未知键：守住位置 返回 null 的默认分支；改错故障：其它快捷键被标签栏吞掉。
// INV-05 单表不出标签：守住位置 tabs 长度判断；改错故障：只有一个工作表时出现孤零零的标签栏。
// INV-06 焦点同步：守住位置 切换后对 role=tab 的焦点移动；改错故障：键盘切换后焦点留在旧标签。
// INV-07 roving tabindex：守住位置 选中标签为 0、其余为 -1；改错故障：Tab 键逐个遍历所有标签。
// INV-08 长名截断：守住位置 标签的最大宽度与 title；改错故障：长表名把标签栏撑爆且看不到全名。
// INV-09 链接安全：守住位置 installDocumentLinkSafety 的安装点；改错故障：单元格链接绕过预览打开策略。
// INV-10 安全清理：守住位置 effect 的返回值；改错故障：卸载后仍拦截点击。
// INV-11 错误只报一次：守住位置 错误 effect 的依赖；改错故障：每次渲染都写一条失败日志。
// INV-12 错误文案不泄内部：守住位置 错误态渲染内容；改错故障：堆栈或路径直接暴露给用户。
// INV-13 加载留底：守住位置 loadingState 的占位块；改错故障：加载期间闪出透明底。
// INV-14 超大文件同文案：守住位置 fileTooLargeState；改错故障：超大文件提示与解析失败文案不一致。
// INV-15 关闭默认工具栏：守住位置 showDefaultToolbar；改错故障：只读预览出现编辑动作。
// INV-16 标签栏回填：守住位置 toolbar 渲染函数；改错故障：关闭默认工具栏后多表无法导航。
// INV-17 尺寸撑满：守住位置 外层与查看器的高度类；改错故障：表格只占半屏或出现双滚动条。
// INV-18 无外部请求：守住位置 组件入参；改错故障：预览自行拉取文件，绕开调用方授权。
//
// 模块职责：用 react-xlsx 渲染只读 Excel 预览，并补回被关闭的默认工具栏中的工作表标签。
// 状态所有权：查看器句柄属于 react-xlsx；本文件只持有根节点引用与当前语言文案。
// 阅读顺序：WASM 初始化 → 标签键位换算 → 标签栏 → 错误态 → 预览主体。
import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { XlsxViewer, setWasmSource, type XlsxViewerController } from "@extend-ai/react-xlsx";
import xlsxWasmUrl from "@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { installDocumentLinkSafety } from "@/lib/officeFilePreview.js";
import { logger } from "@/logger.js";

// 模块加载即设置 WASM 源，必须先于任何查看器实例创建。
// 重复设置是幂等的，热更新重载也不会产生副作用。
//
setWasmSource(xlsxWasmUrl);

// 只处理 Home、End 与左右方向键，其余键返回空让浏览器默认行为生效。
// (index + delta + count) % count 回绕，首尾相接符合 Tab 惯例。
//
function getNextSheetTabIndex({
  currentIndex,
  key,
  tabCount,
}: {
  currentIndex: number;
  key: string;
  tabCount: number;
}): number | null {
  if (tabCount < 1) {
    return null;
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return tabCount - 1;
  }
  if (key === "ArrowLeft") {
    return (currentIndex - 1 + tabCount) % tabCount;
  }
  if (key === "ArrowRight") {
    return (currentIndex + 1) % tabCount;
  }
  return null;
}

// sheetNames.length === 1 时不渲染 tab bar，省掉无意义的占位。
// 切换时记录 sheetNames[index]，便于排查渲染异常。
// tab bar 固定在预览顶部，不随表格纵向滚动。
//
function XlsxSheetTabs({ controller, label }: { controller: XlsxViewerController; label: string }) {
  const { activeTabIndex, setActiveTabIndex, tabs } = controller;

  if (tabs.length <= 1) {
    return null;
  }

  const selectTab = (tabIndex: number) => {
    setActiveTabIndex(tabIndex);
    logger.debug("[PreviewPane] Excel 工作表已切换", {
      sheetIndex: tabIndex,
      sheetName: tabs[tabIndex]?.name,
    });
  };

  // ArrowLeft/ArrowRight 换算为下一标签下标，返回 null 表示不接管该键。
  // preventDefault 阻止默认滚动，再把焦点移到目标 tab 按钮。
  // 焦点查询限定 role=tab，避免误移到底层按钮。
  //
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tabIndex: number) => {
    const nextTabIndex = getNextSheetTabIndex({
      currentIndex: tabIndex,
      key: event.key,
      tabCount: tabs.length,
    });
    if (nextTabIndex === null) {
      return;
    }

    event.preventDefault();
    selectTab(nextTabIndex);
    const tabButtons =
      event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
    tabButtons?.item(nextTabIndex).focus();
  };

  return (
    <div
      aria-label={label}
      className="flex min-h-0 shrink-0 gap-1 overflow-x-auto border-b border-border bg-surface px-2 py-1"
      // 标签栏横向滚动不换行，长表名截断并保留 title 提示。
      // 选中标签 tabIndex 为 0，其余为 -1，符合 roving tabindex 惯例。
      //
      role="tablist"
    >
      {tabs.map((tab, tabIndex) => {
        const isActive = tabIndex === activeTabIndex;
        return (
          <button
            aria-selected={isActive}
            className={cn(
              "h-7 max-w-48 shrink-0 truncate rounded-md px-2 text-ui-sm transition-colors",
              isActive
                ? "bg-selected text-foreground"
                : "text-foreground-subtle hover:bg-hover hover:text-foreground",
            )}
            key={tab.id}
            onClick={() => selectTab(tabIndex)}
            onKeyDown={(event) => handleKeyDown(event, tabIndex)}
            role="tab"
            tabIndex={isActive ? 0 : -1}
            title={tab.name}
            type="button"
          >
            {tab.name}
          </button>
        );
      })}
    </div>
  );
}

// 错误只在挂载或错误对象变化时上报一次，避免重复日志。
// 渲染区只显示调用方给的文案，原始错误不进界面。
// 根节点带告警角色，读屏会立即播报失败。
//
function XlsxPreviewError({
  error,
  message,
  sourcePath,
}: {
  error: Error;
  message: string;
  sourcePath: string;
}) {
  useEffect(() => {
    logger.error("[PreviewPane] Excel 文件解析失败", {
      path: sourcePath,
      error: error.message,
    });
  }, [error, sourcePath]);

  return (
    <div className="p-3 text-sm text-destructive" role="alert">
      {message}
    </div>
  );
}

// 配置全部由上层传入，组件自身不发起文件读取。
// 关闭默认工具栏以隐藏编辑入口，只保留只读工作表标签。
// wrapper 撑满父级并 overflow: hidden，表格滚动交给 viewer 内部。
//
export function PreviewPaneOfficeXlsxContent({
  buffer,
  errorMessage,
  isDark,
  onOpenBrowserUrl,
  sourcePath,
}: {
  buffer: ArrayBuffer;
  errorMessage: string;
  isDark: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  sourcePath: string;
}) {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const { intl } = useZCodeIntl();
  const sheetTabsLabel = intl.formatMessage({ id: "codeViewer.excel.sheetTabs" });
  // react-xlsx 的默认工具栏同时承载编辑动作和 sheet tabs。
  // 预览关闭默认工具栏后会丢失多表导航，因此只通过 toolbar render prop 补回只读 sheet tabs。
  const renderSheetTabs = useCallback(
    (controller: XlsxViewerController) => (
      <XlsxSheetTabs controller={controller} label={sheetTabsLabel} />
    ),
    [sheetTabsLabel],
  );
  useEffect(() => {
    // 链接安全只安装在预览根节点，卸载时由返回值清理。
    // 回调变化会重新安装，保证打开方式始终指向最新处理器。
    //
    const root = viewerRef.current;
    return root ? installDocumentLinkSafety(root, onOpenBrowserUrl) : undefined;
  }, [onOpenBrowserUrl]);

  return (
    <div
      ref={viewerRef}
      className="h-full min-h-0 w-full min-w-0 overflow-hidden bg-background"
      data-office-preview-kind="excel"
    >
      <XlsxViewer
        file={buffer}
        fileName={sourcePath}
        height="100%"
        isDark={isDark}
        readOnly
        rounded={false}
        showDefaultToolbar={false}
        toolbar={renderSheetTabs}
        // 加载态是与预览同底的空白占位，避免加载期间闪白。
        // 错误与超大文件共用同一文案，保持提示一致。
        //
        loadingState={
          <div
            aria-busy="true"
            className="h-full min-h-0 w-full bg-background"
            data-office-preview-pending
          />
        }
        errorState={(error) => (
          <XlsxPreviewError error={error} message={errorMessage} sourcePath={sourcePath} />
        )}
        fileTooLargeState={() => (
          <div className="p-3 text-sm text-destructive" role="alert">
            {errorMessage}
          </div>
        )}
      />
    </div>
  );
}
