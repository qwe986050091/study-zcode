// INV-01 渲染选项固定为官方预览语义：守住位置 选项常量；改错故障：合并 section 会让封面后的正文丢分页。
// INV-02 最后一页分页标记必须保留：守住位置 ignoreLastRenderedPageBreak；改错故障：关闭后相邻页会被合并。
// INV-03 类名全局唯一：守住位置 自增计数器；改错故障：多实例共用类名会让作用域样式互相覆盖。
// INV-04 相同尺寸不重复提交：守住位置 尺寸比较函数；改错故障：每帧都写状态会引发持续重渲染。
// INV-05 只有就绪状态才测量：守住位置 适配更新前置判断；改错故障：加载期读到零尺寸会把缩放算成零。
// INV-06 缩放只缩小不放大：守住位置 适配计算；改错故障：窄屏放大后仍保留横向滚动区。
// INV-07 每次切换文件先清空容器：守住位置 替换子节点；改错故障：旧文档会与新文档叠加。
// INV-08 异步渲染用标记隔离：守住位置 成功与失败分支首行；改错故障：旧任务完成后会覆盖新文档。
// INV-09 渲染失败进入错误态并展示文案：守住位置 失败分支；改错故障：空白面板会让用户以为文件损坏。
// INV-10 包装层背景与内边距被重置：守住位置 包装层样式；改错故障：默认灰底与固定内边距会与主题冲突。
// INV-11 页面阴影通过作用域样式覆盖：守住位置 动态样式注入；改错故障：默认深黑边在深色界面过重。
// INV-12 链接安全安装后可释放：守住位置 释放函数；改错故障：切换文件后旧链接监听仍拦截点击。
// INV-13 清理时移除临时根节点：守住位置 effect 清理；改错故障：脱离文档树的节点会被反复累积。
// INV-14 尺寸观察器在就绪后才挂载：守住位置 布局 effect；改错故障：提前观察会拿到零尺寸。
// INV-15 同时观察视口与内容两侧：守住位置 观察调用；改错故障：只观察一侧会在内容自变高时漏掉更新。
// INV-16 卸载时断开观察器：守住位置 清理函数；改错故障：残留观察会持续触发已卸载组件的回调。
// INV-17 加载中通过忙碌标记暴露状态：守住位置 根节点属性；改错故障：读屏无法感知解析进行中。
// INV-18 错误态隐藏预览区：守住位置 条件类名；改错故障：错误文案会与残留画布同时出现。
//
// 模块职责：预览面板的文档渲染层，负责 `renderAsync` 解析与尺寸适配。
// 状态所有权：渲染状态与尺寸适配归本组件；缓冲区与错误文案由调用方提供。
// 阅读顺序：先看渲染选项与唯一类名，再看渲染 effect 的异步隔离，最后看尺寸适配与容器结构。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { renderAsync, type Options } from "docx-preview";
import {
  calculateDocxPreviewFit,
  installDocumentLinkSafety,
  type DocxPreviewFit,
} from "@/lib/officeFilePreview.js";
import { logger } from "@/logger.js";

const DOCX_RENDER_OPTIONS = {
  breakPages: true,
  debug: false,
  experimental: true,
  ignoreFonts: false,
  ignoreHeight: false,
  // docx-preview@0.4.0 在该选项为 false 时会合并纸张尺寸相同、
  // 但页边距不同的相邻 section，导致封面后的正文丢失分页并沿用封面的零边距。
  // 保持官方预览的默认行为，优先保留 OOXML section 边界和各页 pgMar。
  ignoreLastRenderedPageBreak: true,
  ignoreWidth: false,
  inWrapper: true,
  renderAltChunks: false,
  renderChanges: false,
  renderComments: false,
  renderEndnotes: true,
  renderFooters: true,
  renderFootnotes: true,
  renderHeaders: true,
  useBase64URL: true,
} satisfies Partial<Options>;

const DOCX_PAGE_BOX_SHADOW = "0 2px 10px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.05)";

let nextDocxPreviewClassId = 0;

// createDocxPreviewClassName 用模块级 nextDocxPreviewClassId 自增生成 `zcode-docx-preview-N`：renderAsync 的
// className 既是包装层查询前缀（`${className}-wrapper`），也是作用域样式的命名空间，必须进程内唯一且只增不减；
// 若改成随机串或复用同一串，两个实例的 section 样式会互相覆盖，卸载后的旧类名也无法在 DOM 里区分。
function createDocxPreviewClassName(): string {
  nextDocxPreviewClassId += 1;
  return `zcode-docx-preview-${nextDocxPreviewClassId}`;
}

// isSameDocxPreviewFit 用 scale<0.001、width/height<0.5 的阈值比较两次 calculateDocxPreviewFit 结果：
// 阈值必须宽于亚像素布局抖动，否则 ResizeObserver 每帧都会让 updateFit 的 setFit 提交新对象并持续重渲染；
// 但又必须窄到能捕捉真实拖拽，阈值过大时 Preview Pane 的缩放会滞后数像素。返回 true 时 updateFit 直接保留旧 current。
function isSameDocxPreviewFit(current: DocxPreviewFit | null, next: DocxPreviewFit): boolean {
  return (
    current !== null &&
    Math.abs(current.scale - next.scale) < 0.001 &&
    Math.abs(current.width - next.width) < 0.5 &&
    Math.abs(current.height - next.height) < 0.5
  );
}

export function PreviewPaneOfficeDocxContent({
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
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const renderContainerRef = useRef<HTMLDivElement | null>(null);
  const [previewClassName] = useState(createDocxPreviewClassName);
  const [fit, setFit] = useState<DocxPreviewFit | null>(null);
  const [renderState, setRenderState] = useState<"loading" | "ready" | "error">("loading");

  // updateFit 只在 renderState === "ready" 后测量：加载期 contentRef 还没有子节点，offsetWidth/offsetHeight 为 0，
  // calculateDocxPreviewFit 会把 scale 算成 0 并让画面消失；viewportRef/contentRef 任一为空也直接 return。
  // 结果先经 isSameDocxPreviewFit 去重才 setFit，logger.debug 放在去重之后，拖动时不会按帧刷日志。
  const updateFit = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || renderState !== "ready") {
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
  }, [renderState, sourcePath]);

  // 该 effect 以 buffer/previewClassName/sourcePath 为键重渲染整篇文档：先 replaceChildren() 清空 visibleContainer
  // 并 setFit(null)，防止旧文档残留；renderAsync 把样式与正文分别写进 styleContainer/bodyContainer，
  // 成功后才把 renderRoot 挂到可见容器，失败或过期任务（active === false）不会污染 DOM，只 setRenderState("error")。
  // installDocumentLinkSafety 必须在 renderRoot 挂载前调用并保存 disposeLinkSafety，供清理函数释放链接监听。
  useEffect(() => {
    const visibleContainer = renderContainerRef.current;
    if (!visibleContainer) {
      return;
    }

    let active = true;
    let disposeLinkSafety: (() => void) | undefined;
    const className = previewClassName;
    const renderRoot = document.createElement("div");
    const styleContainer = document.createElement("div");
    const bodyContainer = document.createElement("div");
    renderRoot.dataset.docxRenderRoot = "";
    styleContainer.dataset.docxRenderStyles = "";
    bodyContainer.dataset.docxRenderBody = "";
    renderRoot.append(styleContainer, bodyContainer);

    setRenderState("loading");
    setFit(null);
    visibleContainer.replaceChildren();

    void renderAsync(buffer, bodyContainer, styleContainer, {
      ...DOCX_RENDER_OPTIONS,
      className,
    })
      .then(() => {
        if (!active) {
          return;
        }

        const wrapper = bodyContainer.querySelector<HTMLElement>(`.${className}-wrapper`);
        if (wrapper) {
          // docx-preview 默认给页面包装层写入灰色背景和固定 30px padding，
          // 会与 Preview Pane 主题冲突，也会让窄屏缩放把装饰间距算进纸张宽度。
          wrapper.style.background = "transparent";
          wrapper.style.padding = "0";
          wrapper.style.width = "max-content";
        }

        // docx-preview 默认使用 50% 黑色页面阴影，在 Preview Pane 中会形成过深黑边；
        // 追加作用域样式复用原 react-docx 的浅色纸张阴影，并一次覆盖当前文档的所有页面。
        const pageSurfaceStyle = document.createElement("style");
        pageSurfaceStyle.dataset.docxPageSurfaceStyle = "";
        pageSurfaceStyle.textContent = `.${className}-wrapper>section.${className} { box-shadow: ${DOCX_PAGE_BOX_SHADOW}; }`;
        styleContainer.append(pageSurfaceStyle);

        disposeLinkSafety = installDocumentLinkSafety(renderRoot, onOpenBrowserUrl);

        visibleContainer.replaceChildren(renderRoot);
        setRenderState("ready");
      })
      .catch((error: unknown) => {
        if (!active) {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        logger.error("[PreviewPane] DOCX 文件解析失败", {
          path: sourcePath,
          error: message,
        });
        visibleContainer.replaceChildren();
        setRenderState("error");
      });

    return () => {
      // renderAsync 不提供取消能力；切换文件后只允许最新 source 提交可见 DOM，
      // 旧任务即使稍后完成也只能停留在脱离文档树的临时容器中。
      active = false;
      disposeLinkSafety?.();
      renderRoot.remove();
      visibleContainer.replaceChildren();
    };
  }, [buffer, onOpenBrowserUrl, previewClassName, sourcePath]);

  // useLayoutEffect 必须等 renderState === "ready" 才创建 ResizeObserver：就绪前 contentRef 尺寸为 0，
  // 提前 observe 会让 updateFit 把 fit 锁死在零缩放；同时 observe viewportRef 与 contentRef，因为视口宽度变化
  // 和内容自身变高都会改变 calculateDocxPreviewFit 的输入；清理函数 disconnect() 防止卸载后回调继续触发。
  useLayoutEffect(() => {
    if (renderState !== "ready") {
      return;
    }

    updateFit();
    if (typeof ResizeObserver === "undefined") {
      return;
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
    };
  }, [renderState, updateFit]);

  return (
    // viewportRef.clientWidth 是 calculateDocxPreviewFit 的唯一横向输入；contentRef 内层用 absolute + transform: scale
    // 承载缩放，只写 transform 会留下未缩放的横向滚动区，所以 fit.width/fit.height 必须同步写到 data-docx-fit-frame
    // 的 style，滚动条长度才等于缩放后的真实尺寸；外层宽度不跟随时内容还会溢出到错误态隐藏容器之外。
    <div
      aria-busy={renderState === "loading" ? "true" : undefined}
      className="h-full min-h-0 w-full min-w-0 bg-background"
      data-office-preview-kind="docx"
      data-office-preview-pending={renderState === "loading" ? "" : undefined}
    >
      {renderState === "error" ? (
        <div className="p-3 text-ui-base text-destructive" role="alert">
          {errorMessage}
        </div>
      ) : null}
      <div
        className={
          renderState === "error"
            ? "hidden"
            : "h-full min-h-0 w-full min-w-0 overflow-auto p-4 max-sm:p-2"
        }
      >
        <div ref={viewportRef} className="w-full min-w-0" data-docx-fit-viewport>
          <div
            className="relative mx-auto"
            data-docx-fit-frame
            style={fit ? { width: fit.width, height: fit.height } : undefined}
          >
            {/* docx-preview 保留纸张原始宽度；窄 Preview Pane 需要只缩小不放大，
                并同步包装层宽高，避免单独 transform 后仍保留未缩放的横向滚动区。 */}
            <div
              ref={contentRef}
              className="w-max"
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
              <div ref={renderContainerRef} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
