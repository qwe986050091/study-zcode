// INV-01 缩放步长固定四分之一：守住位置 步长常量；改错故障 一次点击跳两档。
// INV-02 下限四分之一：守住位置 最小比例常量；改错故障 页面缩成不可读黑点。
// INV-03 上限四倍：守住位置 最大比例常量；改错故障 画布放大到内存吃紧。
// INV-04 默认一倍：守住位置 默认比例常量；改错故障 首次打开比例漂移。
// INV-05 滚轮灵敏度固定：守住位置 灵敏度常量；改错故障 触控板一划到底。
// INV-06 提交延迟二百毫秒：守住位置 延迟常量；改错故障 连续手势反复重渲染。
// INV-07 缩放双向钳制：守住位置 钳制函数；改错故障 越界比例传入画布。
// INV-08 页面尺寸同值复用：守住位置 相等判断；改错故障 每帧都换对象触发重绘。
// INV-09 无尺寸不给显示样式：守住位置 三元空分支；改错故障 未加载页面撑开零高容器。
// INV-10 预览未就绪不定位：守住位置 稳定布局判断；改错故障 首帧绝对定位导致跳动。
// INV-11 稳定后绝对定位：守住位置 位置三元；改错故障 旧画布尺寸继续占据文档流。
// INV-12 锚点缺省取容器中心：守住位置 指针缺省分支；改错故障 无指针缩放跳到左上角。
// INV-13 指针先钳进容器：守住位置 两次区间钳制；改错故障 容器外点击算出越界比例。
// INV-14 页面零尺寸放弃锚点：守住位置 宽高判断；改错故障 除零得到无效比例。
// INV-15 恢复按页面相对比例：守住位置 滚动差量；改错故障 缩放后视点漂移。
// INV-16 叠加层复用同一画布：守住位置 缓存引用；改错故障 每次缩放新建画布抖动。
// INV-17 源画布不可见不叠加：守住位置 可见性判断；改错故障 隐藏页面被拍成黑图。
// INV-18 卸载清理叠加层：守住位置 清理副作用；改错故障 切换文档后残留旧图。
//
// 模块职责：PDF 页面缩放的比例工具、视点锚点与轻量预览叠加层。
// 状态所有权：画布与视口引用由 hook 持有，比例由调用方传入。
// 阅读顺序：先看常量与钳制，再读锚点捕获恢复，最后看叠加层生命周期。
import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef } from "react";

export const ZOOM_STEP = 0.25;
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;
export const DEFAULT_SCALE = 1;
// 修饰键 + 滚轮的连续缩放灵敏度：兼容触控板高频小 delta 和鼠标滚轮大 delta。
export const WHEEL_ZOOM_SENSITIVITY = 0.002;
// 手势停顿后才提交真实渲染，连续手势期间只做 CSS 预览。
export const ZOOM_COMMIT_DELAY_MS = 200;

// clampScale 是外部比例的唯一边界，调用方传入的 displayScale 先过它再做布局计算。
// MIN_SCALE 与 MAX_SCALE 同时生效：内层 Math.max 抬下限，外层 Math.min 压上限。
// 越界值只收敛不抛错，缩放控件拿到坏输入时仍能继续渲染而不是整块崩掉。
// 输入是有限数时，返回值必落在 MIN_SCALE 与 MAX_SCALE 之间，调用方无需再夹取。
// clampScale 是纯函数：不修改入参 scale，也不读写模块状态，所以可以在渲染期反复调用。
// 调用方拿到返回值后不必再判上下限，二次夹取只会掩盖真正的越界来源。
export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export interface PdfZoomPointer {
  clientX: number;
  clientY: number;
}

export interface PdfPageSize {
  width: number;
  height: number;
}

export interface PdfZoomAnchor extends PdfZoomPointer {
  pageXRatio: number;
  pageYRatio: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolvePdfPageSize(
  current: PdfPageSize | null,
  width: number,
  height: number,
): PdfPageSize {
  return current?.width === width && current.height === height ? current : { width, height };
}

export function getPdfPageDisplaySize(
  intrinsicSize: PdfPageSize | null,
  displayScale: number,
): CSSProperties | undefined {
  return intrinsicSize
    ? {
        width: Math.floor(intrinsicSize.width * displayScale),
        height: Math.floor(intrinsicSize.height * displayScale),
      }
    : undefined;
}

// hasStableLayoutBox 为假且 previewScale === 1 时返回 undefined，未布局先不接管样式。
// 布局稳定后 position 取 absolute，旧画布尺寸不再占据文档流，滚动范围交给目标盒。
// inset 取 0 让四边贴合布局盒，容器滚动范围完全由当前页面尺寸决定。
// previewScale === 1 时 transform 留空，避免写入 scale(1) 触发无意义的重绘。
// transformOrigin 固定 top left，锚点比例才能按左上角为原点反算。
export function getPdfPagePreviewStyle(
  hasStableLayoutBox: boolean,
  previewScale: number,
): CSSProperties | undefined {
  if (!hasStableLayoutBox && previewScale === 1) {
    return undefined;
  }
  return {
    // 已知页面尺寸后脱离普通文档流，只让目标布局盒决定滚动范围，避免旧画布尺寸干扰缩放。
    position: hasStableLayoutBox ? "absolute" : undefined,
    inset: hasStableLayoutBox ? 0 : undefined,
    transform: previewScale === 1 ? undefined : `scale(${previewScale})`,
    transformOrigin: "top left",
  };
}

// pageRect 的宽或高为 0 时返回 null，页面还没布局，任何比例都算不准。
// pointer 缺席时取 containerRect 的中心，键盘缩放没有指针坐标可用。
// 指针先经 clamp 钳进 containerRect，容器外点击不会被算成越界比例。
// 再按 pageRect 折算成 pageXRatio 与 pageYRatio，两个轴的比例分开计算。
// 两个比例再夹到 0 与 1，边界点击也不会得到负值或超过一的比例。
// clientX 与 clientY 由比例反推回页面坐标，锚点与两个比例始终自洽。
export function capturePdfZoomAnchor(
  container: HTMLDivElement,
  pageViewport: HTMLDivElement,
  pointer?: PdfZoomPointer,
): PdfZoomAnchor | null {
  const containerRect = container.getBoundingClientRect();
  const pageRect = pageViewport.getBoundingClientRect();
  if (pageRect.width === 0 || pageRect.height === 0) {
    return null;
  }

  const requestedClientX = pointer?.clientX ?? containerRect.left + containerRect.width / 2;
  const requestedClientY = pointer?.clientY ?? containerRect.top + containerRect.height / 2;
  const visibleClientX = clamp(requestedClientX, containerRect.left, containerRect.right);
  const visibleClientY = clamp(requestedClientY, containerRect.top, containerRect.bottom);
  const pageXRatio = clamp((visibleClientX - pageRect.left) / pageRect.width, 0, 1);
  const pageYRatio = clamp((visibleClientY - pageRect.top) / pageRect.height, 0, 1);

  return {
    clientX: pageRect.left + pageRect.width * pageXRatio,
    clientY: pageRect.top + pageRect.height * pageYRatio,
    pageXRatio,
    pageYRatio,
  };
}

export function restorePdfZoomAnchor(
  container: HTMLDivElement,
  pageViewport: HTMLDivElement,
  anchor: PdfZoomAnchor,
): void {
  const pageRect = pageViewport.getBoundingClientRect();
  container.scrollLeft += pageRect.left + pageRect.width * anchor.pageXRatio - anchor.clientX;
  container.scrollTop += pageRect.top + pageRect.height * anchor.pageYRatio - anchor.clientY;
}

export function usePdfZoomOverlay() {
  const pageViewportRef = useRef<HTMLDivElement | null>(null);
  const zoomOverlayRef = useRef<HTMLCanvasElement | null>(null);

  const clearZoomOverlay = useCallback(() => {
    zoomOverlayRef.current?.remove();
    zoomOverlayRef.current = null;
  }, []);

  // zoomOverlayRef 已有画布时只改 style 的 width 与 height，不重建节点也不重新拷贝像素。
  // 首次创建按源画布的 width 与 height 设位图尺寸，再 drawImage 整幅拷贝一次像素。
  // 源画布 visibility 为 hidden 或任意一边为零尺寸时直接返回，隐藏页面不拍成黑图。
  // 叠加画布设 pointerEvents 与 userSelect 为 none，不参与命中测试与文本选中。
  const stageZoomOverlay = useCallback((targetWidth: number, targetHeight: number) => {
    const viewport = pageViewportRef.current;
    if (!viewport) {
      return;
    }

    let overlay = zoomOverlayRef.current;
    if (!overlay) {
      const sourceCanvas = viewport.querySelector<HTMLCanvasElement>(".react-pdf__Page__canvas");
      if (!sourceCanvas || sourceCanvas.style.visibility === "hidden") {
        return;
      }

      const width = sourceCanvas.offsetWidth;
      const height = sourceCanvas.offsetHeight;
      if (width === 0 || height === 0 || sourceCanvas.width === 0 || sourceCanvas.height === 0) {
        return;
      }

      overlay = document.createElement("canvas");
      overlay.width = sourceCanvas.width;
      overlay.height = sourceCanvas.height;
      overlay.style.position = "absolute";
      overlay.style.inset = "0";
      overlay.style.zIndex = "1";
      overlay.style.display = "block";
      overlay.style.pointerEvents = "none";
      overlay.style.userSelect = "none";
      overlay.setAttribute("aria-hidden", "true");
      const overlayContext = overlay.getContext("2d");
      if (!overlayContext) {
        return;
      }
      overlayContext.drawImage(sourceCanvas, 0, 0);
      viewport.appendChild(overlay);

      zoomOverlayRef.current = overlay;
    }

    overlay.style.width = `${targetWidth}px`;
    overlay.style.height = `${targetHeight}px`;
  }, []);

  useEffect(() => {
    return () => {
      zoomOverlayRef.current?.remove();
    };
  }, []);

  return {
    clearZoomOverlay,
    pageViewportRef,
    stageZoomOverlay,
  };
}
