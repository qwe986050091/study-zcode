// INV-01 WASM 先行：守住位置 模块顶层 setWasmSource；改错故障：模型解析时找不到解码器而整页失败。
// INV-02 渲染键稳定：守住位置 WeakMap 的读写；改错故障：同一模型每次渲染都换编辑器实例，滚动位置丢失。
// INV-03 键不持久化：守住位置 模块级计数器；改错故障：把键写入序列化数据，跨会话不可复现。
// INV-04 适配容忍度：守住位置 缩放与尺寸的比较阈值；改错故障：浮点抖动导致每帧都重渲染。
// INV-05 首帧必写：守住位置 当前值为空的判断；改错故障：首帧尺寸被跳过，页面不缩放。
// INV-06 只读渲染：守住位置 DocxEditorViewer 的 mode；改错故障：预览页暴露编辑能力。
// INV-07 虚拟列表同步：守住位置 pageVirtualization 的 zoomScale；改错故障：滚动坐标按未缩放页高计算，出现闪白。
// INV-08 测量防零：守住位置 两个引用节点的判空；改错故障：零尺寸参与计算得到无意义比例。
// INV-09 结果为空不改：守住位置 calculateDocxPreviewFit 的空返回；改错故障：容器隐藏时把适配重置为空。
// INV-10 等价不写：守住位置 setFit 内的比较；改错故障：尺寸微抖引发整棵文档树更新。
// INV-11 日志分级：守住位置 logger.debug；改错故障：拖动分隔条时生产日志被刷屏。
// INV-12 布局期安装：守住位置 useLayoutEffect；改错故障：链接拦截晚一帧生效，首次点击走默认行为。
// INV-13 无观察器兜底：守住位置 typeof 判断；改错故障：旧环境缺少观察器时链接安全也被跳过。
// INV-14 双节点观察：守住位置 两个 observe；改错故障：只监听容器，内容变化后比例不更新。
// INV-15 清理成对：守住位置 返回函数；改错故障：卸载后仍响应尺寸变化并向已销毁节点写入。
// INV-16 三态渲染：守住位置 加载、错误、成功分支；改错故障：加载中同时渲染错误视图。
// INV-17 错误只报一次：守住位置 错误 effect 的依赖；改错故障：每次渲染写一条失败日志。
// INV-18 文案不泄内部：守住位置 错误视图内容；改错故障：堆栈或路径直接展示给用户。
//
// 模块职责：以只读方式渲染 DOCX，并按容器宽度等比缩放页面、同步虚拟列表缩放比例。
// 状态所有权：模型归解析 hook；适配比例与引用归响应式查看器。
// 阅读顺序：WASM 初始化 → 渲染键 → 适配比较 → 响应式查看器 → 布局 effect → 外层三态。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DocxEditorViewer,
  setWasmSource,
  useDocxEditor,
  useDocxModel,
  type DocModel,
  type DocxPageVirtualizationOptions,
} from "@extend-ai/react-docx";
import docxWasmUrl from "@extend-ai/react-docx/docx_wasm_bg.wasm?url";
import {
  calculateDocxPreviewFit,
  installDocumentLinkSafety,
  type DocxPreviewFit,
} from "@/lib/officeFilePreview.js";
import { logger } from "@/logger.js";

// 模块加载即注入 WASM 地址，必须早于任何文档模型解析。
// 地址由打包器生成，热更新重载不会留下旧路径。
//
setWasmSource(docxWasmUrl);

// 渲染键是递增整数，仅在弱映射未命中时分配。
// 计数器只在模块内使用，不参与任何持久化。
//
let nextDocxModelRenderKey = 0;
const docxModelRenderKeys = new WeakMap<DocModel, number>();

// 同一模型始终得到同一键，重建时不会误换编辑器实例。
// 弱映射随模型释放自动回收，不需要显式清理。
//
function getDocxModelRenderKey(model: DocModel): number {
  const existingKey = docxModelRenderKeys.get(model);
  if (existingKey !== undefined) {
    return existingKey;
  }
  nextDocxModelRenderKey += 1;
  docxModelRenderKeys.set(model, nextDocxModelRenderKey);
  return nextDocxModelRenderKey;
}

// `isSameDocxPreviewFit` 的缩放容差 0.001 与尺寸容差半像素，用来吸收浮点误差。
// 当前为空时一律视为不同，保证首帧一定写入状态。
//
function isSameDocxPreviewFit(current: DocxPreviewFit | null, next: DocxPreviewFit): boolean {
  return (
    current !== null &&
    Math.abs(current.scale - next.scale) < 0.001 &&
    Math.abs(current.width - next.width) < 0.5 &&
    Math.abs(current.height - next.height) < 0.5
  );
}

// 固定只读模式，复用编辑器的完整分页与排版链路。
// 文件名为编辑器提供初始上下文，不参与界面展示。
//
function ResponsiveDocxEditorViewer({
  model,
  onOpenBrowserUrl,
  sourcePath,
}: {
  model: DocModel;
  onOpenBrowserUrl?: (url: string) => void;
  sourcePath: string;
}) {
  // 轻量 ReactDocxViewer 不走编辑器的完整分页与排版链路，预览结果会和编辑画布不一致。
  // 使用同一个 editor controller 驱动文档画布，但固定为只读模式，避免暴露任何编辑能力。
  const editor = useDocxEditor({
    starterModel: model,
    initialFileName: sourcePath,
    initialDocumentTheme: "light",
  });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<DocxPreviewFit | null>(null);
  // 外层使用 transform 缩放页面，但 react-docx 的虚拟列表不会自动识别 transform。
  // 必须同步传入相同 zoomScale，否则滚动坐标会按未缩放页高计算，导致闪白或末页无法挂载。
  // 外层用变换缩放，虚拟列表必须同步相同比例。
  // 比例未就绪时按一处理，避免首帧按零缩放渲染。
  //
  const pageVirtualization = useMemo<DocxPageVirtualizationOptions>(
    () => ({ zoomScale: fit?.scale ?? 1 }),
    [fit?.scale],
  );

  // 先取两个节点，任一缺失直接返回，避免测量到零尺寸。
  // 写入状态前做等价比较，尺寸未变则不触发重渲染。
  // 日志只走调试级别，高频拖动不会放大生产日志。
  //
  const updateFit = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) {
      return;
    }

    const next = calculateDocxPreviewFit({
      availableWidth: viewport.clientWidth,
      naturalHeight: content.offsetHeight,
      naturalWidth: content.offsetWidth,
    });
    if (!next) {
      return;
    }

    setFit((current) => {
      if (isSameDocxPreviewFit(current, next)) {
        return current;
      }
      // 调试说明：拖动 Preview Pane 时会按帧触发 ResizeObserver；高频尺寸轨迹只走 debug，
      // 生产构建不落盘，避免响应式布局把日志量放大到和 resize 事件同数量级。
      logger.debug("[PreviewPane] DOCX 预览宽度已同步", {
        path: sourcePath,
        availableWidth: viewport.clientWidth,
        naturalWidth: content.offsetWidth,
        scale: next.scale,
      });
      return next;
    });
  }, [sourcePath]);

  // 环境不支持观察器时仍返回链接安全的清理函数。
  // 观察器同时监听容器与内容，任一侧变化都会重算适配。
  // 清理时断开观察器再卸载链接拦截，顺序固定。
  //
  useLayoutEffect(() => {
    const content = contentRef.current;
    const disposeLinkSafety = content ? installDocumentLinkSafety(content, onOpenBrowserUrl) : null;
    updateFit();
    if (typeof ResizeObserver === "undefined") {
      return disposeLinkSafety ?? undefined;
    }

    const resizeObserver = new ResizeObserver(updateFit);
    if (viewportRef.current) {
      resizeObserver.observe(viewportRef.current);
    }
    if (contentRef.current) {
      resizeObserver.observe(contentRef.current);
    }
    return () => {
      resizeObserver.disconnect();
      disposeLinkSafety?.();
    };
  }, [onOpenBrowserUrl, updateFit]);

  return (
    <div ref={viewportRef} className="w-full min-w-0" data-docx-fit-viewport>
      <div
        className="relative mx-auto"
        data-docx-fit-frame
        style={fit ? { width: fit.width, height: fit.height } : undefined}
      >
        {/* react-docx 按纸张原始像素宽度渲染，窄 Preview Pane 会被 794px 页面撑破。
            只缩小不放大，并同步包装层宽高，避免单独 transform 后仍保留未缩放的横向滚动区。 */}
        <div
          ref={contentRef}
          className="theme-zai-light min-w-max text-foreground"
          data-docx-fit-content
          style={
            fit
              ? {
                  position: "absolute",
                  left: 0,
                  top: 0,
                  transform: `scale(${fit.scale})`,
                  transformOrigin: "top left",
                }
              : undefined
          }
        >
          <DocxEditorViewer
            className="min-w-max"
            editor={editor}
            mode="read-only"
            pageGapBackgroundColor="transparent"
            pageVirtualization={pageVirtualization}
          />
        </div>
      </div>
    </div>
  );
}

// `PreviewPaneOfficeLegacyDocContent` 只做加载态 / 错误态 / 成功态三选一渲染。
// 成功态把模型与 `onOpenBrowserUrl` 交给响应式查看器。
//
export function PreviewPaneOfficeLegacyDocContent({
  buffer,
  errorMessage,
  onOpenBrowserUrl,
  sourcePath,
}: {
  buffer: ArrayBuffer;
  errorMessage: string;
  onOpenBrowserUrl?: (url: string) => void;
  sourcePath: string;
}) {
  const { model, isLoading, error } = useDocxModel(buffer);

  useEffect(() => {
    if (!error) {
      return;
    }
    logger.error("[PreviewPane] DOCX 文件解析失败", {
      path: sourcePath,
      error: error.message,
    });
  }, [error, sourcePath]);

  if (isLoading) {
    return (
      <div
        aria-busy="true"
        className="h-full min-h-0 w-full bg-background"
        data-office-preview-pending
      />
    );
  }

  // 解析失败与模型为空共用同一错误视图，文案由上层提供。
  // 错误视图带告警角色，读屏会立即播报。
  //
  if (error || !model) {
    return (
      <div className="p-3 text-ui-base text-destructive" role="alert">
        {errorMessage}
      </div>
    );
  }

  return (
    <div
      className="h-full min-h-0 w-full min-w-0 overflow-auto bg-background p-4 max-sm:p-2"
      data-office-preview-kind="doc"
    >
      <ResponsiveDocxEditorViewer
        key={getDocxModelRenderKey(model)}
        model={model}
        onOpenBrowserUrl={onOpenBrowserUrl}
        sourcePath={sourcePath}
      />
    </div>
  );
}
