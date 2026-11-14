// ============================================================================
// [b18 深注] 文件头：pptx-preview-viewer.tsx —— 职责边界
//   PPTX 只读预览器：加载阶段把 ArrayBuffer 交给 renderer engine，页渲染委托给
//   PresentationPreviewDocument.renderPage；本文件只做 UI 编排（缩略图、翻页、缩放、
//   元素选择浮层、导出 PDF、元素引用入对话）。
//   不做：OOXML 解析、布局计算、PDF 生成（都在 presentation/ 下），也不修改源文件。
// ============================================================================
// 不变量（INV）表：断言 —— 守住位置 —— 改错后的故障
//   INV-01 renderer 只能挂到不含 React 子节点的 leaf mount —— mountRef 的绑定点 —— 改错：cleanup 的 replaceChildren 删到浮层后 React 崩溃。
//   INV-02 每次加载必须递增 generation，迟到结果只能释放不能写状态 —— 加载 effect 与 generationRef —— 改错：旧文档覆盖新文档。
//   INV-03 卸载必须置 cancelled 并 dispose 已打开文档 —— 加载 effect 的 cleanup —— 改错：文档与渲染资源泄漏。
//   INV-04 renderPage 的 ready 失败只上报不重试 —— reportRenderError —— 改错：错误渲染循环刷屏。
//   INV-05 页面外链必须净化并阻断主窗口导航 —— installDocumentLinkSafety 与 sanitizeDocumentHref —— 改错：点击链接把应用导航走。
//   INV-06 幻灯片内部滚动必须复位 —— resetScroll 的捕获监听 —— 改错：内容无声偏移且无法拖回。
//   INV-07 选择浮层的指针命中与原生文本选择互斥 —— textSelectionEnabled 分支 —— 改错：无法划选文本或误触底层超链接。
//   INV-08 命中比较必须按稳定元素身份 —— isSamePresentationElement 的四字段 —— 改错：同位置不同元素被判为同一个。
//   INV-09 退出选择必须同时清 aiEditDraft 与 selectedElement —— exitElementSelection —— 改错：浮层残留指向已消失元素。
//   INV-10 页码解析失败必须回填当前页 —— commitPageInput —— 改错：输入框显示非法值且状态不同步。
//   INV-11 键盘翻页必须豁免 INPUT/TEXTAREA/contentEditable —— handleKeyDown 的首个判断 —— 改错：评论框方向键翻页并清空草稿。
//   INV-12 Esc 在编辑态只回退编辑条 —— handleKeyDown 的分支顺序 —— 改错：误按丢弃已输入评论。
//   INV-13 引用跳转按 requestId 去重且先关闭选择态 —— 引用 effect —— 改错：重复跳转或浮层误恢复。
//   INV-14 引用页码越界只提示，不改变当前页 —— 引用 effect 的越界分支 —— 改错：翻到不存在的页。
//   INV-15 来源指纹不一致只提示，仍允许跳转 —— 引用 effect 末尾比较 —— 改错：用户失去引用上下文。
//   INV-16 元素引用必须用新一代 generation 校验 —— handleAddToConversation 的 referenceGeneration —— 改错：旧文档引用被派发到新会话。
//   INV-17 addingReference 期间禁止重复提交 —— 该标志与浮层 disabled —— 改错：重复派发 add-to-chat 事件。
//   INV-18 导出 PDF 必须先释放打印 DOM 再弹保存框 —— handleExportPdf —— 改错：保存期间占着全量页面内存。
//   INV-19 导出 finally 必须兜底 dispose 并复位 exportingPdf —— 同上 —— 改错：按钮卡在导出中。
//   INV-20 缩略图必须按可见性懒渲染 —— IntersectionObserver 与 visible 判断 —— 改错：上百页同时渲染卡死。
//   INV-21 观察器在卸载时必须 disconnect —— 两处 effect cleanup —— 改错：回调持有已卸载 DOM。
//   INV-22 缩放必须夹在 MIN/MAX 之间 —— clampPresentationZoomPercent —— 改错：数值越界而按钮禁用态不一致。
//   INV-23 loading/error/empty 三种早退必须在主区域渲染前判定 —— 组件尾部的三个 if —— 改错：空文档进主区域后崩溃。
"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FileDownIcon,
  Loader2Icon,
  MousePointer2Icon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { PopoverAnchor } from "@/components/ui/popover.js";
import { toast } from "@/components/ui/toast.js";
import { PptxSelectionActionBar } from "@/components/ui/pptx-selection-action-bar.js";
import { cn } from "@/components/lib/utils.js";
import { logger } from "@/logger.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import type { PresentationPrintHost } from "@/presentation/presentationPdfPrintExport.js";
import {
  PPTX_MAX_ZOOM_PERCENT,
  PPTX_MIN_ZOOM_PERCENT,
  PPTX_ZOOM_STEP_PERCENT,
  clampPresentationPageNumber,
  clampPresentationZoomPercent,
} from "@/presentation/presentationPreviewControls.js";
import { hitTestPresentationElement } from "@/presentation/presentationElementModel.js";
import { getPresentationElementSelectedText } from "@/presentation/presentationTextSelection.js";
import type {
  PresentationPageSize,
  PresentationPageElement,
  PresentationPreviewDocument,
  PresentationRenderHandle,
} from "@/presentation/types.js";
import { installDocumentLinkSafety, sanitizeDocumentHref } from "@/lib/officeFilePreview.js";
import type { PptxReferencePreviewNavigation } from "@/lib/codeViewer.js";
import {
  createPptxElementReference,
  dispatchPptxElementReferenceAddToChat,
  sha256Fingerprint,
  type PptxElementReferenceSource,
} from "@/lib/pptxElementReference.js";

// [契约] 全部文案由调用方注入，组件内不写死中文或英文。
// 含函数的字段（thumbnail、referencedPageMissing）必须由调用方按 locale 实现。
// 新增标签要同时更新所有调用点，缺失会导致运行时 undefined 调用。
export interface PptxPreviewViewerLabels {
  loading: string;
  loadError: string;
  noSlides: string;
  previousPage: string;
  nextPage: string;
  pageInput: string;
  zoomIn: string;
  zoomOut: string;
  thumbnails: string;
  thumbnail: (pageNumber: number) => string;
  exportPdf: string;
  exportingPdf: string;
  exportPdfSuccess: (path: string) => string;
  exportPdfFailed: string;
  selectElement: string;
  exitElementSelection: string;
  aiEdit: string;
  commentPlaceholder: string;
  cancelAiEdit: string;
  addToConversation: string;
  referencedPageMissing: (pageNumber: number) => string;
  referencedSourceChanged: (pageNumber: number) => string;
}

// [契约] generation 用于把渲染结果绑定到某一代文档；跨代结果必须丢弃。
// elements 与 selectedElement 只在 selectionMode 下有意义，缺省为空。
// renderSurfaceRef 允许外部持有主区域挂载点，缩略图不传则用内部 ref。
interface RenderedPageProps {
  document: PresentationPreviewDocument;
  pageIndex: number;
  scale: number;
  generation: number;
  interactive?: boolean;
  onNavigate?: (pageIndex: number) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onRenderError?: (generation: number, error: Error) => void;
  selectionMode?: boolean;
  elements?: readonly PresentationPageElement[];
  selectedElement?: PresentationPageElement | null;
  onSelectElement?: (element: PresentationPageElement) => void;
  renderSurfaceRef?: RefObject<HTMLDivElement | null>;
}

// [契约] 身份由 nodeId + nodeType + rowIndex + cellIndex 四元组决定。
// 不能只比 nodeId：表格单元格共享同一条目且索引不同。
// 任一侧为 null 直接返回 false，避免把「未选中」判成同一元素。
// 该判定同时用于高亮与命中测试，口径必须一致。
function isSamePresentationElement(
  left: PresentationPageElement | null | undefined,
  right: PresentationPageElement | null | undefined,
) {
  if (!left || !right) {
    return false;
  }
  return (
    left.nodeId === right.nodeId &&
    left.nodeType === right.nodeType &&
    left.rowIndex === right.rowIndex &&
    left.cellIndex === right.cellIndex
  );
}

// [契约] 客户端坐标按 rect 缩放换算到页面逻辑坐标，保证缩放后命中不变。
// rect 宽高为 0 时返回 null：元素尚未布局，任何命中都不可信。
// 只做坐标换算，不读取滚动位置（页面自身禁止内部滚动）。
function toPresentationPoint(
  surface: HTMLElement,
  pageSize: PresentationPageSize,
  clientX: number,
  clientY: number,
) {
  const rect = surface.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return {
    x: ((clientX - rect.left) / rect.width) * pageSize.width,
    y: ((clientY - rect.top) / rect.height) * pageSize.height,
  };
}

// [契约] 单页渲染单元：负责挂载 renderer、链接净化、选择浮层与滚动复位。
// 缩略图与主区域共用本组件，只通过 interactive/selectionMode 区分行为。
// 组件不持有文档生命周期，document 变化由父级 effect 负责释放。
function RenderedPage({
  document,
  pageIndex,
  scale,
  generation,
  interactive = false,
  onNavigate,
  onOpenBrowserUrl,
  onRenderError,
  selectionMode = false,
  elements = [],
  selectedElement = null,
  onSelectElement,
  renderSurfaceRef,
}: RenderedPageProps) {
  // [资源] 外层 frame 只用于挂 scroll 捕获监听与定位，不交给 renderer 操作。
  // 内层 mount 才是 renderer 的挂载点，两者不能合并。
  const frameRef = useRef<HTMLDivElement | null>(null);
  const internalMountRef = useRef<HTMLDivElement | null>(null);
  // [契约] 外部传入 ref 时复用调用方节点，否则用内部 leaf mount。
  // 该节点必须没有 React 子节点：renderer 会 replaceChildren。
  // 把浮层放进该节点会导致 React removeChild 崩溃，历史缺陷即源于此。
  const mountRef = renderSurfaceRef ?? internalMountRef;
  // [契约] 只有选中且元素含文本时才允许原生划选。
  // 无文本元素保持指针可命中，用于切换选择而不是划选。
  const textSelectionEnabled = selectionMode && Boolean(selectedElement?.text?.trim());

  useEffect(() => {
    // [失败路径] 首帧 ref 可能为 null（组件尚未提交），此时不挂监听。
    // 该 effect 不依赖任何 props，只在挂载与卸载时执行。
    const frame = frameRef.current;
    // [失败路径] 首帧未提交时 ref 为空，直接跳过监听安装。
    // 监听只装一次，不随 scale 或 pageIndex 变化重建。
    if (!frame) {
      return;
    }
    // 幻灯片内部 overflow:hidden 容器的滚动条已被全局隐藏，但选区拖拽自动滚动、
    // 链接焦点 scrollIntoView 等原生行为仍能滚动它们，内容会无声偏移且无法拖回。
    // scroll 不冒泡，这里用捕获监听把内部任何滚动偏移复位。
    // [资源] 监听用 capture=true：scroll 不冒泡，冒泡阶段收不到内部容器事件。
    // 只复位非零偏移，避免无意义写入触发额外布局。
    // 任何滚动偏移都会让页面内容与浮层坐标错位，必须归零。
    const resetScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.scrollTop !== 0 || target.scrollLeft !== 0)) {
        target.scrollTop = 0;
        target.scrollLeft = 0;
      }
    };
    // [资源] capture=true 是必须的：scroll 不冒泡也不支持委托。
    frame.addEventListener("scroll", resetScroll, true);
    return () => frame.removeEventListener("scroll", resetScroll, true);
  }, []);

  useEffect(() => {
    // [失败路径] 挂载点缺失直接返回，不创建任何 renderer 句柄。
    // 缩略图宽度为 0 时不渲染页内容，也是同一个原因。
    const mount = mountRef.current;
    // [失败路径] 挂载点不存在时不调用 renderPage，避免把 undefined 传给引擎。
    // 此时既无 handle 也无订阅，cleanup 只做空操作。
    if (!mount) {
      return;
    }

    // [资源] 句柄在 try 之前声明，保证抛错后 cleanup 仍能安全访问。
    // handle 为 null 表示 renderPage 未成功，cleanup 需跳过 dispose。
    let handle: PresentationRenderHandle | null = null;
    let disposeLinkSafety: (() => void) | undefined;
    let cancelled = false;
    // [失败路径] 已取消的页面不得再上报，避免卸载后写入父级状态。
    // 非 Error 值统一包装成 Error，保证上层拿到稳定类型。
    // 上报携带 generation，由父级复核是否仍是当代。
    const reportRenderError = (error: unknown) => {
      if (cancelled) {
        return;
      }
      onRenderError?.(generation, error instanceof Error ? error : new Error(String(error)));
    };
    try {
      // [契约] 导航回调优先处理页码跳转，其次才是外链。
      // 外链必须经 sanitizeDocumentHref 并排除锚点，才交给浏览器打开。
      // 返回值 handle 只在 ready 成功后可用，失败走 catch。
      handle = document.renderPage(pageIndex, mount, {
        onNavigate: (target) => {
          // [契约] 页码导航优先于 URL：同一 target 两者可能同时存在。
          if (target.pageIndex !== undefined) {
            onNavigate?.(target.pageIndex);
            return;
          }
          // [契约] 必须净化后使用：OOXML 外链可能是 javascript 或 file 协议。
          // 净化失败返回空值，直接丢弃该次导航。
          const safeUrl = sanitizeDocumentHref(target.url);
          // [契约] 页内锚点不交给浏览器：预览器没有对应的文档上下文。
          // 只有通过净化的外部地址才回调 onOpenBrowserUrl。
          if (safeUrl && !safeUrl.startsWith("#")) {
            onOpenBrowserUrl?.(safeUrl);
          }
        },
      });
      // PPTX renderer 会把 OOXML 外链直接写成 <a href>；必须在页面挂载点
      // 统一净化并阻断主 renderer 导航，同时覆盖异步追加的链接节点。
      // [契约] 必须在 renderPage 之后安装，才能覆盖本轮插入的节点。
      // 该安装同时阻断主 renderer 导航并覆盖异步追加的链接。
      // dispose 与安装成对，漏掉会让监听从旧页面继续生效。
      disposeLinkSafety = installDocumentLinkSafety(mount, onOpenBrowserUrl);
      // [失败路径] ready 是异步的，必须单独挂 catch，不能被 try/catch 覆盖。
      // 该 catch 必须消费错误，否则产生 unhandled rejection。
      void handle.ready.catch(reportRenderError);
    } catch (error) {
      reportRenderError(error);
    }

    return () => {
      // dispose() 不保证 ready Promise 同步结束；先取消回调，避免已卸载页面的迟到错误写入下一次会话。
      cancelled = true;
      disposeLinkSafety?.();
      handle?.dispose();
      // [资源] 卸载时清空挂载点，避免 renderer 生成的节点残留在 React 树外。
      // 只能对 leaf mount 调用：对含 React 子节点的容器调用会破坏协调。
      mount.replaceChildren();
    };
  }, [document, generation, onNavigate, onOpenBrowserUrl, onRenderError, pageIndex]);

  return (
    <div
      ref={frameRef}
      className="relative shrink-0 overflow-hidden bg-background shadow-md"
      style={{
        width: document.pageSize.width * scale,
        height: document.pageSize.height * scale,
      }}
    >
      {/* renderer mount ref 曾同时绑定这一 React 容器和内层节点，cleanup 的
          replaceChildren() 会误删 selection overlay，随后 React removeChild 因节点已不存在而崩溃。
          renderer 只能操作下面不包含 React 子节点的独立 leaf mount。 */}
      <div
        data-zcode-pptx-render-surface=""
        className="absolute left-0 top-0 origin-top-left"
        style={{
          width: document.pageSize.width,
          height: document.pageSize.height,
          transform: `scale(${scale})`,
        }}
      >
        <div
          ref={mountRef}
          data-zcode-pptx-render-surface="true"
          className={cn(
            "absolute inset-0",
            interactive && (!selectionMode || textSelectionEnabled)
              ? "pointer-events-auto"
              : "pointer-events-none",
            textSelectionEnabled && "select-text",
          )}
          onPointerDownCapture={(event) => {
            if (!textSelectionEnabled) {
              return;
            }
            const point = toPresentationPoint(
              event.currentTarget,
              document.pageSize,
              event.clientX,
              event.clientY,
            );
            const hitElement = point ? hitTestPresentationElement(elements, point) : null;
            if (isSamePresentationElement(hitElement, selectedElement)) {
              return;
            }
            // 选中浮层覆盖真实文本，且底层页面禁用了指针命中，浏览器无法创建原生文字 Selection。
            // 含文本元素高亮后只放行其 bounds；bounds 外仍由稳定元素模型切换选择，避免打开底层超链接。
            event.preventDefault();
            event.stopPropagation();
            if (hitElement) {
              onSelectElement?.(hitElement);
            }
          }}
          onClickCapture={(event) => {
            if (!selectionMode) {
              return;
            }
            // 文字划选结束后的 click 不得恢复 PPTX 内部跳转；原生 Selection 已在 pointer 序列中完成。
            event.preventDefault();
            event.stopPropagation();
          }}
        />
        {selectionMode ? (
          <div
            className="pointer-events-none absolute inset-0"
            data-pptx-element-selection-overlay="true"
          >
            {elements.map((element) => {
              const elementKey = [
                element.nodeId,
                element.nodeType,
                element.rowIndex ?? "",
                element.cellIndex ?? "",
              ].join(":");
              const selected = isSamePresentationElement(selectedElement, element);
              const elementButton = (
                <button
                  key={elementKey}
                  type="button"
                  aria-pressed={selected}
                  aria-label={element.text || element.nodeName || element.nodeType}
                  className={cn(
                    "absolute border outline-none transition-colors",
                    textSelectionEnabled ? "pointer-events-none" : "pointer-events-auto",
                    selected
                      ? "border-primary bg-accent/30"
                      : "border-transparent bg-transparent hover:border-primary hover:bg-accent/20",
                  )}
                  style={{
                    left: element.bounds.x,
                    top: element.bounds.y,
                    width: element.bounds.width,
                    height: element.bounds.height,
                    zIndex: element.zIndex * 2 + (element.nodeType === "table-cell" ? 1 : 0),
                  }}
                  onClick={() => onSelectElement?.(element)}
                />
              );
              return selected ? (
                <PopoverAnchor key={`anchor:${elementKey}`} asChild>
                  {elementButton}
                </PopoverAnchor>
              ) : (
                elementButton
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// [契约] scrollRoot 决定懒加载的观察根，主区域滚动时也能正确判定可见性。
// labels 必须透传，缩略图自身不生成文案。
interface ThumbnailProps {
  document: PresentationPreviewDocument;
  pageIndex: number;
  generation: number;
  selected: boolean;
  scrollRoot: HTMLElement | null;
  labels: PptxPreviewViewerLabels;
  onSelect: () => void;
}

// [契约] Thumbnail 是纯展示 + 选择入口，除 onSelect 外不承载交互。
// 未量到宽度前不渲染页内容，避免用错误 scale 渲染。
// 选中时滚动到最近可见位置，由父级维护唯一选中态。
function PptxThumbnail({
  document,
  pageIndex,
  generation,
  selected,
  scrollRoot,
  labels,
  onSelect,
}: ThumbnailProps) {
  // [资源] buttonRef 同时是 ResizeObserver 观测目标与 scrollIntoView 定位目标。
  // 两个 effect 共用同一个 ref，不能拆成两个节点。
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // [资源] 可见性状态驱动懒渲染；无 IntersectionObserver 时退化为始终可见。
  const [visible, setVisible] = useState(false);
  // [契约] 0 表示尚未测量，渲染分支据此跳过。
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const button = buttonRef.current;
    // [失败路径] 无观察器能力时退化为始终可见，保证功能可用。
    // 退化路径不设置 visible=false，避免永久空白。
    if (!button || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    // [资源] rootMargin 预取 200px，滚动时减少空白。
    // root 用外部滚动容器，否则以视口为根会误判。
    // 卸载必须 disconnect，避免观察已卸载节点。
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { root: scrollRoot, rootMargin: "200px 0px" },
    );
    observer.observe(button);
    return () => observer.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    const button = buttonRef.current;
    // [失败路径] 按钮未挂载时跳过测量，宽度保持 0。
    // 此时不渲染页内容，等待下一次 ref 提交。
    // button 未挂载分支不需要 cleanup，因为没有创建任何观察器。
    if (!button) {
      return;
    }
    // [契约] 扣除左右 padding 后的内容宽度才是渲染宽度。
    // 夹到 0 以上，避免除零与负 scale。
    // 首帧主动调用一次，不能只依赖 ResizeObserver 的首次回调。
    const updateWidth = () => setWidth(Math.max(0, button.clientWidth - 16));
    updateWidth();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateWidth);
      return () => window.removeEventListener("resize", updateWidth);
    }
    // [资源] 观察按钮自身尺寸，容器宽度变化时即时重算 scale。
    const observer = new ResizeObserver(updateWidth);
    observer.observe(button);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // [契约] 仅选中项滚动到可见区域，block=nearest 防止整列跳动。
    if (selected) {
      buttonRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);

  // [契约] 宽度未知时 scale=0，配合 visible 判断阻止渲染。
  const scale = width > 0 ? width / document.pageSize.width : 0;
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-current={selected ? "page" : undefined}
      aria-label={labels.thumbnail(pageIndex + 1)}
      className={cn(
        "flex w-full flex-col items-center gap-1 rounded-lg border p-2 text-ui-xs text-foreground-subtle outline-none transition-colors",
        selected
          ? "border-border-hover bg-selected text-foreground"
          : "border-transparent hover:border-border hover:bg-surface-hover",
      )}
      onClick={onSelect}
    >
      <div
        className="flex w-full items-center justify-center overflow-hidden bg-surface"
        style={{
          aspectRatio: `${document.pageSize.width} / ${document.pageSize.height}`,
        }}
      >
        {visible && scale > 0 ? (
          <RenderedPage
            document={document}
            generation={generation}
            pageIndex={pageIndex}
            scale={scale}
          />
        ) : null}
      </div>
      <span className="tabular-nums">{pageIndex + 1}</span>
    </button>
  );
}

// [资源] 观测单个节点的尺寸，node 变化时重建观察器。
// 无 ResizeObserver 时降级为 window resize 监听。
// 初始值 0×0，调用方必须处理未测量状态。
function useElementSize(node: HTMLElement | null) {
  // [契约] 初值 0×0：调用方必须把未测量态当作不可用。
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    // [失败路径] 节点未挂载时不做观测，避免对 null 建观察器。
    if (!node) {
      return;
    }
    // [契约] 读取 clientWidth/clientHeight（不含边框），保证主区域布局计算与 CSS 一致。
    const update = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    // [资源] 尺寸变化驱动重算，避免只在 window resize 时更新。
    // 与 resize 监听分支互斥，不能同时挂两种监听。
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return size;
}

// [契约] 顶层组件只负责状态编排，渲染细节下沉到 RenderedPage。
// data 是 ArrayBuffer，变化即代表换文件，会触发完整重载。
// referenceNavigation 是外部指令，必须按 requestId 去重。
export function PptxPreviewViewer({
  data,
  labels,
  onOpenBrowserUrl,
  className,
  fileName,
  referenceSource,
  referenceNavigation,
  referenceNavigationReady = true,
}: {
  data: ArrayBuffer;
  labels: PptxPreviewViewerLabels;
  onOpenBrowserUrl?: (url: string) => void;
  className?: string;
  fileName?: string;
  referenceSource?: PptxElementReferenceSource;
  referenceNavigation?: PptxReferencePreviewNavigation;
  referenceNavigationReady?: boolean;
}) {
  // [契约] 文档与 generation、指纹打包成一个状态，保证三者同步切换。
  // 拆成三个 state 会出现「新文档配旧 generation」的中间态。
  const [presentation, setPresentation] = useState<{
    generation: number;
    document: PresentationPreviewDocument;
    sourceFingerprint: string;
  } | null>(null);
  // [失败路径] 只保存布尔值：错误细节进日志，不进 UI。
  const [loadError, setLoadError] = useState(false);
  // [契约] 1-based 页码是 UI 唯一口径；内部索引在使用处减 1。
  // 切换文档时必须复位为 1，否则会指向不存在的页。
  const [pageNumber, setPageNumber] = useState(1);
  // [契约] 输入框文本是受控的独立状态，允许中间非法值。
  // 提交或失焦时由 commitPageInput 归一，不在此处校验。
  // 页码变化时必须同步回写，保持输入框与真实页一致。
  const [pageInput, setPageInput] = useState("1");
  // [契约] 缩放是百分比整数，最终会被 clamp 到 MIN/MAX。
  const [zoomPercent, setZoomPercent] = useState(100);
  // [资源] 导出互斥标志：为 true 时按钮禁用且处理器早退。
  const [exportingPdf, setExportingPdf] = useState(false);
  // [资源] 用回调 ref 保存滚动容器，供缩略图的观察器作为 root。
  const [thumbnailRoot, setThumbnailRoot] = useState<HTMLElement | null>(null);
  // [资源] 主区域容器：既用于尺寸观测，也作为选择浮层的 boundary。
  const [previewViewport, setPreviewViewport] = useState<HTMLElement | null>(null);
  // [契约] 选择模式开关；关闭时必须同时清空选中元素与编辑草稿。
  // 该状态只在配置了 referenceSource 时可用，按钮也按此渲染。
  const [selectionMode, setSelectionMode] = useState(false);
  // [契约] 选中元素只在当前页有效：翻页或换文档必须清空。
  // 元素对象来自 document.getPageElements，跨代引用不可复用。
  const [selectedElement, setSelectedElement] = useState<PresentationPageElement | null>(null);
  // [契约] 非 null 表示编辑条已展开；selectedText 为 undefined 表示未取到划选。
  // comment 不放在这里，由浮层内部管理，提交时才回传。
  const [aiEditDraft, setAiEditDraft] = useState<{
    selectedText?: string;
  } | null>(null);
  // [并发] 创建引用期间的互斥标志，防止重复派发。
  // 必须在 finally 中复位，且只在同一 generation 下复位。
  const [addingReference, setAddingReference] = useState(false);
  // [契约] 主区域尺寸驱动适配缩放；未测量时为 0×0。
  const viewportSize = useElementSize(previewViewport);
  // [并发] 文档代际计数，ref 而非 state：异步回调需要读到最新值且不触发渲染。
  // 每次加载 effect 与卸载 effect 都会推进它，使旧回调全部失效。
  // 任何写回 presentation/loadError 的分支都必须先比对它。
  // 它不参与渲染，不要改成 state。
  const generationRef = useRef(0);
  // [契约] 可选平台：Web 环境下为 undefined，导出能力随之关闭。
  const platform = useOptionalPlatform();
  // [契约] 两个能力必须同时存在才显示导出按钮。
  // 缺一即不渲染，而不是渲染后失败。
  const canExportPdf = Boolean(platform?.printPageToPdf && platform?.saveFile);
  // [并发] 记录已应用的引用请求 id，防止同一指令在重渲染时重复执行。
  // 切换文档时不清空：requestId 全局唯一，天然隔离。
  const appliedReferenceNavigationRequestIdRef = useRef<string | null>(null);
  // [资源] 主区域的 leaf mount，交给 RenderedPage 复用。
  const mainRenderSurfaceRef = useRef<HTMLDivElement | null>(null);
  // [契约] 派生值，未加载完成时为 null，后续早退分支依赖它。
  const document = presentation?.document ?? null;
  const documentGeneration = presentation?.generation ?? 0;

  useEffect(() => {
    // [并发] 先自增再写回 ref，任何此前的回调立即过期。
    // 该值同时用于本次加载的校验与渲染 props。
    // 不能在 await 之后重新取 ref：那时可能已被下一轮推进。
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    let cancelled = false;
    // [资源] 记录已打开文档，供 cleanup 兜底释放。
    // 必须在 then 中赋值后才可能被 cleanup 使用。
    let openedDocument: PresentationPreviewDocument | null = null;
    // [并发] 换文件先清空旧文档引用，避免旧页在新加载期间仍可交互。
    // 随后会把 pageIndex、scale、selection 与 editDraft 逐项复位。
    // 清空不等于释放：真正的 dispose 在 effect cleanup 中完成。
    // 这里不再推 generation：本 effect 开头已推进过一次。
    setPresentation(null);
    setLoadError(false);
    setPageNumber(1);
    setPageInput("1");
    setZoomPercent(100);
    setSelectionMode(false);
    setSelectedElement(null);
    setAiEditDraft(null);
    setAddingReference(false);

    // [契约] 指纹在解析前计算，用于后续引用跳转的来源校验。
    // 动态 import 渲染引擎，避免把 OOXML/WASM 打进首屏包。
    // 两步串行：先取引擎再 open，避免同时持有多份文档。
    void sha256Fingerprint(data)
      .then((sourceFingerprint) =>
        import("@/presentation/pptxRendererPreviewEngine.js")
          .then(({ pptxRendererPreviewEngine }) => pptxRendererPreviewEngine.open(data))
          .then((nextDocument) => ({ nextDocument, sourceFingerprint })),
      )
      .then(({ nextDocument, sourceFingerprint }) => {
        // [资源] 一旦 open 成功就登记，即使随后判定过期也要能 dispose。
        // 登记必须在任何 await 之前完成，避免窗口期内泄漏。
        openedDocument = nextDocument;
        if (cancelled || generation !== generationRef.current) {
          // [资源] 过期文档在 then 中立即释放，不能留给父级。
          // 不写任何状态：此时新文档可能已经就位。
          nextDocument.dispose();
          return;
        }
        setPresentation({
          generation,
          document: nextDocument,
          sourceFingerprint,
        });
      })
      .catch((error: unknown) => {
        if (cancelled || generation !== generationRef.current) {
          return;
        }
        // [失败路径] 只记录日志并置错误态，不上抛给 React。
        // 解析失败通常是文件损坏，不做自动重试。
        logger.error("[PptxPreviewViewer] PPTX 解析失败", error);
        setLoadError(true);
      });

    return () => {
      // open() 的 Promise 不会因 effect cleanup 自动取消；generation 让旧会话的迟到结果只能释放资源，不能污染新会话状态。
      cancelled = true;
      // [并发] 仅当本轮仍是最新时才额外推进一次，使在飞的 then 全部失效。
      // 若已被下一轮推进，则不能再加，否则会把新文档判为过期。
      if (generation === generationRef.current) {
        generationRef.current += 1;
      }
      // [资源] cleanup 兜底释放已打开文档，覆盖 open 成功但 then 未执行的窗口。
      // 必须在 cancelled 置位之后调用，避免释放后又被使用。
      openedDocument?.dispose();
    };
  }, [data]);

  // [契约] 唯一的翻页入口：统一 clamp 并同步 pageInput。
  // 文档为空或零页时直接返回，不写状态。
  const goToPage = useCallback(
    (target: number) => {
      if (!document || document.pageCount === 0) {
        return;
      }
      // [契约] 页码夹取到 1..pageCount，越界输入不报错而是就近取值。
      const nextPage = clampPresentationPageNumber(target, document.pageCount);
      setPageNumber(nextPage);
      setPageInput(String(nextPage));
    },
    [document],
  );

  // [失败路径] 解析失败时回填当前页，保持受控输入与状态一致。
  // 成功时统一走 goToPage，复用夹取逻辑。
  const commitPageInput = useCallback(() => {
    // [契约] 只接受十进制整数前缀，非法字符自然被截断。
    // NaN 是唯一失败信号，不额外做范围校验。
    const parsed = Number.parseInt(pageInput.trim(), 10);
    if (Number.isNaN(parsed)) {
      setPageInput(String(pageNumber));
      return;
    }
    goToPage(parsed);
  }, [goToPage, pageInput, pageNumber]);

  // [契约] 键盘交互只在预览器聚焦时生效，事件由外层容器冒泡。
  // 所有被消费的按键都要 preventDefault，避免滚动容器同时响应。
  // 分支顺序固定：Esc 优先于方向键。
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // 评论草稿的 Textarea 经 Popover Portal 渲染，但仍在 React 树内向此处冒泡；
      // 只豁免 INPUT 会让方向键在评论框里翻页，并连带清空未提交的评论。
      // [契约] 评论框经 Portal 渲染但仍在 React 树内冒泡，必须豁免 TEXTAREA。
      // contentEditable 同样豁免，覆盖富文本输入。
      // 只豁免 INPUT/TEXTAREA 与 contentEditable，按钮等仍允许翻页。
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }
      if (event.key === "Escape" && selectionMode) {
        event.preventDefault();
        if (aiEditDraft) {
          // 编辑评论时 Esc 只回退到 AI 编辑条，避免误按直接丢弃已输入内容。
          setAiEditDraft(null);
          return;
        }
        setSelectionMode(false);
        setSelectedElement(null);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        goToPage(pageNumber - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goToPage(pageNumber + 1);
      }
    },
    [aiEditDraft, goToPage, pageNumber, selectionMode],
  );

  // [契约] 三个状态一起复位，缺一个就会留下悬空浮层或草稿。
  const exitElementSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedElement(null);
    setAiEditDraft(null);
  }, []);

  // [契约] fitScale 先按视口适配再乘 zoom，两步不可合并。
  // 未测量或未加载时返回 1，避免 0 或 NaN 传给 transform。
  // 适配计算预留 32px 边距，保证滚动条与内边距不裁切页面。
  // 依赖只含尺寸与 zoomPercent，文档变化由调用方重新渲染。
  const mainScale = useMemo(() => {
    if (!document || viewportSize.width === 0 || viewportSize.height === 0) {
      return 1;
    }
    // [契约] 取宽高比例较小者，保证整页可见。
    // 内层 Math.max(1, ...) 防止负尺寸导致负缩放。
    const fitScale = Math.min(
      Math.max(1, viewportSize.width - 32) / document.pageSize.width,
      Math.max(1, viewportSize.height - 32) / document.pageSize.height,
    );
    return fitScale * (zoomPercent / 100);
  }, [document, viewportSize.height, viewportSize.width, zoomPercent]);

  // [失败路径] 只接受当代错误：旧文档的失败不得影响新文档。
  // 统一转 loadError，交给早退分支展示。
  const handleRenderError = useCallback((generation: number, error: Error) => {
    if (generation !== generationRef.current) {
      return;
    }
    logger.error("[PptxPreviewViewer] PPTX 页面渲染失败", error);
    setLoadError(true);
  }, []);
  // [契约] renderer 的导航回调是 0-based 索引，统一加 1 转成 UI 页码。
  const handlePageNavigate = useCallback(
    (targetPageIndex: number) => goToPage(targetPageIndex + 1),
    [goToPage],
  );
  useEffect(() => {
    // [契约] 无引用指令时不做任何状态改动，避免无谓重渲染。
    // referenceNavigation 有指令时先清 selection，引用跳转不应恢复旧元素选择。
    if (!referenceNavigation) {
      return;
    }
    // 引用跳转的入口位于 Composer；旧选择浮层若继续存在，会让用户误以为引用页定位同时恢复了元素。
    // 因此先关闭 generation-local 选择，再等待文件存在性校验和文档解析完成后尝试页码定位。
    setSelectionMode(false);
    setSelectedElement(null);
    setAiEditDraft(null);
    if (
      !referenceNavigationReady ||
      !document ||
      appliedReferenceNavigationRequestIdRef.current === referenceNavigation.requestId
    ) {
      return;
    }
    // [并发] 先登记再执行：即使后续越界提示，也不重复处理同一请求。
    // 登记发生在就绪校验之后，未就绪的请求不会被吞掉。
    appliedReferenceNavigationRequestIdRef.current = referenceNavigation.requestId;
    // [契约] 引用侧是 0-based，提示文案与跳转都要用 1-based。
    // 越界判断必须同时检查整数性与上下界。
    const referencedPageNumber = referenceNavigation.pageIndex + 1;
    if (
      !Number.isInteger(referenceNavigation.pageIndex) ||
      referenceNavigation.pageIndex < 0 ||
      referenceNavigation.pageIndex >= document.pageCount
    ) {
      toast(labels.referencedPageMissing(referencedPageNumber));
      return;
    }
    goToPage(referencedPageNumber);
    if (presentation?.sourceFingerprint !== referenceNavigation.expectedSourceFingerprint) {
      toast(labels.referencedSourceChanged(referencedPageNumber));
    }
  }, [
    document,
    goToPage,
    labels,
    presentation?.sourceFingerprint,
    referenceNavigation,
    referenceNavigationReady,
  ]);
  useEffect(() => {
    setSelectedElement(null);
    setAiEditDraft(null);
  }, [documentGeneration, pageNumber]);

  // [契约] 元素列表只在选择模式下拉取，避免非选择态的无谓布局计算。
  // 页码变更即重新计算，不能缓存跨页结果。
  const pageElements = useMemo(
    () => (document && selectionMode ? document.getPageElements(pageNumber - 1) : []),
    [document, pageNumber, selectionMode],
  );
  // [失败路径] 缺少选中元素、文档、引用来源或正在提交时直接返回。
  // 划选文本可能只是元素文本的子串，交给引用构建阶段区分。
  // 取不到划选时仍展开编辑条（草稿为空对象）。
  const handleAiEdit = useCallback(() => {
    if (!selectedElement || !presentation || !referenceSource || addingReference) {
      return;
    }
    // [资源] 读当前挂载点用于取 window 与 selection，缺失时按无划选处理。
    const renderSurface = mainRenderSurfaceRef.current;
    // [契约] 只取落在元素 bounds 内的原生选区，bounds 之外不算。
    // 该结果仅作模型上下文，冲突校验仍用完整文本。
    // 返回空串时视为未划选。
    const selectedText = getPresentationElementSelectedText({
      selection: renderSurface?.ownerDocument.defaultView?.getSelection() ?? null,
      renderSurface,
      pageSize: presentation.document.pageSize,
      elementBounds: selectedElement.bounds,
      elementText: selectedElement.text,
    });
    setAiEditDraft(selectedText ? { selectedText } : {});
  }, [addingReference, presentation, referenceSource, selectedElement]);

  // [契约] 切换选中必须清空编辑草稿，避免草稿指向旧元素。
  const handleSelectElement = useCallback((element: PresentationPageElement) => {
    setAiEditDraft(null);
    setSelectedElement(element);
  }, []);

  // [并发] 五个前置条件缺一不可，否则会产生无来源的引用。
  // capture referenceGeneration 后所有回调都必须复核。
  // 成功才清草稿；失败保留草稿供用户重试。
  const handleAddToConversation = useCallback(
    (comment: string) => {
      if (
        !selectedElement ||
        !presentation ||
        !referenceSource ||
        !aiEditDraft ||
        addingReference
      ) {
        return;
      }
      // [契约] 空白评论视为未填，不写入引用对象。
      const normalizedComment = comment.trim();
      // [并发] 快照当前代际，避免 await 期间被新文档覆盖。
      // finally 中复位 addingReference 也要先比对它。
      const referenceGeneration = generationRef.current;
      setAddingReference(true);
      // 部分文字划选曾覆盖完整 element.text，导致 textFingerprint 锁定子串，
      // 而 OOXML resolver 校验的是整个 shape/cell。完整文本用于冲突校验，子串只作模型上下文。
      // [契约] 完整文本用于冲突校验，划选子串只作模型上下文。
      // sourceFingerprint 让下游能识别源文件是否已变。
      // 成功后派发 add-to-chat 事件，由 composer 侧消费。
      // 该调用是异步 IO，不得在失败时改变选中状态。
      void createPptxElementReference({
        element: selectedElement,
        ...aiEditDraft,
        ...(normalizedComment ? { comment: normalizedComment } : {}),
        ...referenceSource,
        sourceFingerprint: presentation.sourceFingerprint,
      })
        .then((reference) => {
          if (referenceGeneration !== generationRef.current) {
            return;
          }
          dispatchPptxElementReferenceAddToChat(reference);
          setAiEditDraft(null);
        })
        .catch((error: unknown) => {
          if (referenceGeneration === generationRef.current) {
            logger.error("[PptxPreviewViewer] 创建 PPTX 元素引用失败", error);
          }
        })
        .finally(() => {
          if (referenceGeneration === generationRef.current) {
            setAddingReference(false);
          }
        });
    },
    [addingReference, aiEditDraft, presentation, referenceSource, selectedElement],
  );

  // [契约] 由源文件名推导 PDF 名，扩展名不区分大小写。
  // 无文件名时回退 presentation.pdf。
  // 只做重命名，不改变保存目录。
  const suggestedPdfName = useMemo(() => {
    const base = fileName?.split(/[\\/]/).pop()?.trim();
    if (!base) {
      return "presentation.pdf";
    }
    const pptExtension = /\.(pptx?|ppsx?)$/i;
    return pptExtension.test(base) ? base.replace(pptExtension, ".pdf") : `${base}.pdf`;
  }, [fileName]);

  // [并发] 导出互斥：exportingPdf 为 true 时立即返回。
  // 能力缺失直接返回，不做降级导出。
  // 先渲染打印宿主再取 PDF，顺序不可颠倒。
  // 任何异常都只提示 exportPdfFailed，不抛给 React。
  const handleExportPdf = useCallback(async () => {
    // [契约] 先取出方法再判空，避免调用时 this 丢失。
    const printPageToPdf = platform?.printPageToPdf;
    const saveFile = platform?.saveFile;
    if (!document || exportingPdf || !printPageToPdf || !saveFile) {
      return;
    }
    // [并发] 先置互斥标志再 await，防止用户连点触发两次导出。
    setExportingPdf(true);
    // [资源] 打印宿主句柄，必须在 finally 中兜底释放。
    // 提前置 null 表示已释放，finally 的 ?.dispose 才不会重复。
    let printHost: PresentationPrintHost | null = null;
    try {
      // [契约] 按需加载打印模块，导出失败不应影响预览本身。
      // 加载失败会落入 catch，统一提示 exportPdfFailed。
      const { renderPresentationToPrintHost } =
        await import("@/presentation/presentationPdfPrintExport.js");
      // [资源] 动态 import 失败时 printHost 仍为 null，finally 安全。
      // 渲染宿主会挂载全量页面 DOM，用完必须尽快释放。
      printHost = await renderPresentationToPrintHost(document, window.document);
      // [失败路径] 打印失败与取消都走抛错路径，统一提示。
      // data 为空同样视为失败。
      const printResult = await printPageToPdf();
      // 拿到 PDF 字节立即释放打印 DOM，避免保存对话框期间占着全量页面的内存
      // [资源] 拿到字节后立即释放 DOM，避免保存对话框期间占用全量页面内存。
      // 释放后必须置 null，防止 finally 重复释放。
      printHost.dispose();
      printHost = null;
      // [失败路径] 统一抛错，由 catch 提示，避免两套失败处理。
      // error 字段只用于日志，不作为用户文案。
      if (!printResult.success || !printResult.data) {
        throw new Error(printResult.error ?? "print_failed");
      }
      // [失败路径] 用户取消不是错误：直接返回且不提示成功。
      // 缺少 path 或 success=false 视为保存失败。
      // 成功后用返回路径提示，而不是猜测的 suggestedPdfName。
      const saveResult = await saveFile({
        data: printResult.data,
        suggestedName: suggestedPdfName,
      });
      // [失败路径] 用户取消不是失败：直接返回，不提示也不报错。
      // 此时 printHost 已在前面释放，finally 不会重复释放。
      if (saveResult.canceled) {
        return;
      }
      // [失败路径] 缺 path 视为失败：提示文案需要真实路径才能展示。
      // 成功后用返回路径提示，不猜测文件名。
      if (!saveResult.success || !saveResult.path) {
        throw new Error(saveResult.error ?? "save_failed");
      }
      toast(labels.exportPdfSuccess(saveResult.path));
    } catch (error) {
      logger.error("[PptxPreviewViewer] PPTX 导出 PDF 失败", error);
      // [失败路径] 导出链路的所有失败都收敛到这一条提示。
      toast(labels.exportPdfFailed);
    } finally {
      // [资源] finally 兜底：正常路径已置 null，这里只覆盖异常路径。
      // 重复 dispose 必须安全，这是打印宿主实现的契约。
      printHost?.dispose();
      // [资源] finally 中复位，保证异常路径按钮不会永久禁用。
      setExportingPdf(false);
    }
  }, [document, exportingPdf, labels, platform, suggestedPdfName]);

  // [失败路径] 错误态优先于空态：解析失败时不能再尝试渲染。
  // 三种早退都在主区域渲染前，保证 document 非空且 pageCount>0。
  if (loadError) {
    return <div className="p-3 text-ui-base text-destructive">{labels.loadError}</div>;
  }
  // [契约] 未加载完成时展示 loading，此时其他状态一律不读取。
  if (!document) {
    return <div className="p-3 text-ui-base text-foreground-subtle">{labels.loading}</div>;
  }
  // [契约] 零页文档是合法输入（纯空白文件），展示 noSlides 而不是错误。
  if (document.pageCount === 0) {
    return <div className="p-3 text-ui-base text-foreground-subtle">{labels.noSlides}</div>;
  }

  // [契约] UI 1-based 与内部 0-based 的唯一换算点，禁止在别处重复加减。
  const pageIndex = pageNumber - 1;
  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={cn("flex h-full min-h-0 outline-none", className)}
    >
      <aside
        ref={setThumbnailRoot}
        aria-label={labels.thumbnails}
        className="w-24 shrink-0 overflow-y-auto border-r border-border bg-surface/30 p-2 sm:w-32"
      >
        <div className="flex flex-col gap-2">
          {Array.from({ length: document.pageCount }, (_, index) => (
            <PptxThumbnail
              key={index}
              document={document}
              generation={documentGeneration}
              pageIndex={index}
              selected={index === pageIndex}
              scrollRoot={thumbnailRoot}
              labels={labels}
              onSelect={() => goToPage(index + 1)}
            />
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col bg-background">
        <div ref={setPreviewViewport} className="min-h-0 flex-1 overflow-auto">
          <div className="grid min-h-full min-w-full place-items-center p-4">
            <PptxSelectionActionBar
              open={selectionMode && selectedElement !== null}
              boundary={previewViewport}
              label={labels.aiEdit}
              commentPlaceholder={labels.commentPlaceholder}
              cancelLabel={labels.cancelAiEdit}
              addToConversationLabel={labels.addToConversation}
              editing={aiEditDraft !== null}
              disabled={addingReference}
              onAiEdit={handleAiEdit}
              onCancelAiEdit={() => setAiEditDraft(null)}
              onAddToConversation={handleAddToConversation}
              onExitSelection={exitElementSelection}
            >
              <RenderedPage
                document={document}
                generation={documentGeneration}
                pageIndex={pageIndex}
                scale={mainScale}
                interactive
                selectionMode={selectionMode}
                elements={pageElements}
                selectedElement={selectedElement}
                onSelectElement={handleSelectElement}
                renderSurfaceRef={mainRenderSurfaceRef}
                onNavigate={handlePageNavigate}
                onOpenBrowserUrl={onOpenBrowserUrl}
                onRenderError={handleRenderError}
              />
            </PptxSelectionActionBar>
          </div>
        </div>

        <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-center gap-1 border-t border-border bg-surface/30 px-2 py-1.5 text-ui-base">
          {referenceSource ? (
            <Button
              type="button"
              size="sm"
              variant={selectionMode ? "secondary" : "ghost"}
              aria-pressed={selectionMode}
              aria-label={selectionMode ? labels.exitElementSelection : labels.selectElement}
              title={selectionMode ? labels.exitElementSelection : labels.selectElement}
              onClick={() => {
                setSelectionMode((current) => !current);
                setSelectedElement(null);
                setAiEditDraft(null);
              }}
            >
              <MousePointer2Icon className="size-4" />
              {selectionMode ? labels.exitElementSelection : labels.selectElement}
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-md"
            variant="ghost"
            aria-label={labels.previousPage}
            title={labels.previousPage}
            disabled={pageNumber <= 1}
            onClick={() => goToPage(pageNumber - 1)}
          >
            <ChevronLeftIcon />
          </Button>
          <Input
            type="text"
            inputMode="numeric"
            aria-label={labels.pageInput}
            value={pageInput}
            onChange={(event) => setPageInput(event.target.value)}
            onBlur={commitPageInput}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitPageInput();
                event.currentTarget.blur();
              }
            }}
            className="w-12 text-center text-mobile-input-safe tabular-nums md:text-ui-base"
          />
          <span className="min-w-10 text-center tabular-nums text-foreground-subtle">
            / {document.pageCount}
          </span>
          <Button
            type="button"
            size="icon-md"
            variant="ghost"
            aria-label={labels.nextPage}
            title={labels.nextPage}
            disabled={pageNumber >= document.pageCount}
            onClick={() => goToPage(pageNumber + 1)}
          >
            <ChevronRightIcon />
          </Button>
          <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
          <Button
            type="button"
            size="icon-md"
            variant="ghost"
            aria-label={labels.zoomOut}
            title={labels.zoomOut}
            disabled={zoomPercent <= PPTX_MIN_ZOOM_PERCENT}
            onClick={() =>
              setZoomPercent((current) =>
                clampPresentationZoomPercent(current - PPTX_ZOOM_STEP_PERCENT),
              )
            }
          >
            <ZoomOutIcon />
          </Button>
          <span className="w-12 text-center tabular-nums text-foreground-subtle">
            {zoomPercent}%
          </span>
          <Button
            type="button"
            size="icon-md"
            variant="ghost"
            aria-label={labels.zoomIn}
            title={labels.zoomIn}
            disabled={zoomPercent >= PPTX_MAX_ZOOM_PERCENT}
            onClick={() =>
              setZoomPercent((current) =>
                clampPresentationZoomPercent(current + PPTX_ZOOM_STEP_PERCENT),
              )
            }
          >
            <ZoomInIcon />
          </Button>
          {canExportPdf ? (
            <>
              <div className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
              <Button
                type="button"
                size="icon-md"
                variant="ghost"
                aria-label={exportingPdf ? labels.exportingPdf : labels.exportPdf}
                title={exportingPdf ? labels.exportingPdf : labels.exportPdf}
                disabled={exportingPdf}
                onClick={() => void handleExportPdf()}
              >
                {exportingPdf ? <Loader2Icon className="animate-spin" /> : <FileDownIcon />}
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
