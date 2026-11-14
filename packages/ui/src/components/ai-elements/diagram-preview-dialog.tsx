"use client";

// ===== 深度注释：Mermaid 图表预览对话框 =====
// 职责边界（做什么 / 不做什么 / 依赖谁）：
// - 做：把调用方提供的一段 SVG 字符串挂到 content 容器上，负责 fit/平移/缩放/双指手势，并保证 transform 与测量同坐标系。
// - 做：把 viewBox、声明尺寸、可见图形 bbox 三种来源收敛成一次 fit 计算，供「适应窗口 / 重置 / 百分比缩放」共用。
// - 不做：不解析、不生成、不清洗 Mermaid 源码；svg 在进入本组件前必须已完成 sanitize，本组件只负责展示。
// - 不做：不保存任何图表状态到外部 store；transform 是纯 UI 局部状态，关闭即丢弃。
// - 依赖：diagramViewport 的纯函数（fit/pan/zoom）、ControlHintTooltip 与 UI Button/Select 原语、logger 单点测量日志。
//
// 不变量（INV，改动前逐条确认）：
// INV-01 断言：svg 只经 dangerouslySetInnerHTML 注入且必须是已清洗字符串 —— 守住它的位置：contentRef 元素 —— 改错故障：直接拼 DOM 会造成 XSS。
// INV-02 断言：transform 只作用于 content 父容器，不写入 SVG 内部 —— 守住它的位置：transformStyle —— 改错故障：坐标基准分裂，fit 与手势互相打架。
// INV-03 断言：applyPreviewSvgLayout 必须先于 resolveSvgBounds 执行 —— 守住它的位置：fitToViewport/reset —— 改错故障：父级仍按 300px 收缩，bbox 与显示不一致。
// INV-04 断言：父容器与 SVG 的 width/height 必须同时设置 —— 守住它的位置：applyPreviewSvgLayout —— 改错故障：只改一处会让 fit 按旧尺寸计算。
// INV-05 断言：root bounds 取值顺序为 viewBox → width/height 属性 → client 尺寸 —— 守住它的位置：readRootSvgBounds —— 改错故障：顺序反转会把 100% 当成真实宽度。
// INV-06 断言：fill 画布背景的 rect 必须从可见 bbox 中排除 —— 守住它的位置：isCanvasBackgroundElement —— 改错故障：fit 永远等于 viewBox，图形被缩到很小。
// INV-07 断言：defs/clipPath/mask/symbol 等不可见祖先必须跳过 —— 守住它的位置：nonVisibleSvgAncestorSelector —— 改错故障：bbox 命中不可见几何，视图偏移。
// INV-08 断言：display/visibility/opacity 判断必须在 getBBox 之前 —— 守住它的位置：resolveSvgBounds 循环 —— 改错故障：读取隐藏元素得到错误边界。
// INV-09 断言：单元素 getBBox 抛错只能跳过该元素，不能中断整次测量 —— 守住它的位置：循环内 try/catch —— 改错故障：一个未布局节点导致整图不 fit。
// INV-10 断言：只有可见 union 为空时才回退根 bbox —— 守住它的位置：resolveSvgBounds 尾部 —— 改错故障：直接回退会让裁剪图留出大片空白。
// INV-11 断言：pointerdown 必须立刻 setPointerCapture —— 守住它的位置：handlePointerDown —— 改错故障：指针移出元素后拖动中断、ref 状态滞留。
// INV-12 断言：双指分支要求 activePointers>=2 且已有 pinch 基准 —— 守住它的位置：handlePointerMove —— 改错故障：每帧重算基准导致画面漂移。
// INV-13 断言：pinch 的 center/distance/transform 在第二指按下时冻结 —— 守住它的位置：handlePointerDown —— 改错故障：缩放中心跟手跳动。
// INV-14 断言：pointerup/pointercancel 必须同时清空 pointers、dragOrigin、pinch —— 守住它的位置：handlePointerEnd —— 改错故障：下次手势继承旧基准，画面瞬移。
// INV-15 断言：wheel 事件必须 preventDefault 后再判断 ctrlKey —— 守住它的位置：handleWheel —— 改错故障：页面滚动与图表缩放同时发生。
// INV-16 断言：ctrlKey 走缩放，否则走平移，两者不可交换 —— 守住它的位置：handleWheel —— 改错故障：触控板体验反向，用户无法浏览长图。
// INV-17 断言：fit 必须在 requestAnimationFrame 内执行 —— 守住它的位置：open 时的 effect —— 改错故障：同步读取到未布局尺寸，首帧错位。
// INV-18 断言：resize 监听只在 open 时注册并在清理函数移除 —— 守住它的位置：resize effect —— 改错故障：关闭后仍持续测量，泄漏且卡顿。
// INV-19 断言：键盘 +/- 只处理未被 defaultPrevented 的事件 —— 守住它的位置：handleKeyDown —— 改错故障：输入框内的加号被劫持。
// INV-20 断言：dialog 关闭时必须清空手势 ref —— 守住它的位置：open 变化的 effect —— 改错故障：重新打开后沿用上次未完成的拖动。
// INV-21 断言：zoomPercent 只是四舍五入展示值，不参与任何计算 —— 守住它的位置：渲染前 —— 改错故障：累积舍入误差导致百分比与实际缩放不符。
// INV-22 断言：title 只用于对话标题与 aria-label，不参与 SVG 布局 —— 守住它的位置：DialogTitle/content —— 改错故障：标题变化触发布局重算。
//
// 标注约定：[并发] 指针状态机；[资源] 事件监听与 rAF；[失败路径] 测量失败时的降级。
import { ChevronDownIcon, CircleMinusIcon, CirclePlusIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  fitDiagramToViewport,
  panDiagram,
  zoomDiagramAtPoint,
  type DiagramPoint,
  type DiagramViewportBounds,
  type DiagramViewportTransform,
} from "@/lib/diagramViewport.js";
import { logger } from "@/logger.js";

// [契约] svg 必须是已清洗的完整 SVG 字符串；组件不做二次校验，传空串只会渲染空白而不是报错。
// open 由调用方持有：关闭即卸载内容并复位手势，组件不自行决定何时关闭。
// title 同时用于可访问名称与视觉标题，不能只给其中一处。
type DiagramPreviewDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  svg: string;
  title: string;
};

// 手势基准在第二指按下时冻结，之后每帧都以它推算 scale 与平移；中途更新基准会让双指缩放抖动。
type PinchGestureState = {
  center: DiagramPoint;
  distance: number;
  transform: DiagramViewportTransform;
};

// 默认 transform 是恒等变换，也是所有失败路径的兜底值；不要改成「上次会话值」。
const defaultTransform: DiagramViewportTransform = {
  scale: 1,
  translateX: 0,
  translateY: 0,
};

// 下拉菜单只提供这三档，百分比由 scale 计算；新增档位要同步国际化文案的占位符。
const zoomScaleOptions = [0.5, 1, 2] as const;

// 这里列出所有可能承载可见几何的 SVG 标签，用于求 union bbox；漏掉标签会让 fit 忽略对应图形。
// 选择器保持小写与 SVG 标签名一致，querySelectorAll 对 SVG 大小写敏感。
// g 也参与选择，是因为部分 Mermaid 输出把可视图元挂在 g 上；但背景 rect 会被单独排除。
const svgGraphicSelector = [
  "circle",
  "ellipse",
  "foreignObject",
  "g",
  "image",
  "line",
  "path",
  "polygon",
  "polyline",
  "rect",
  "text",
  "use",
].join(",");
// 这些祖先只提供定义或裁剪，不直接可见；不排除会把 defs 里的模板几何算进 bbox。
// script/style/title 的文本也不能参与几何测量。
const nonVisibleSvgAncestorSelector = [
  "clipPath",
  "defs",
  "linearGradient",
  "marker",
  "mask",
  "metadata",
  "pattern",
  "radialGradient",
  "script",
  "style",
  "symbol",
  "title",
].join(",");

// 单指时退化为该点本身，双指时取中点；单指分支不是错误路径，而是手势起始的合法状态。
// 缺少指针时返回 0,0 只是防御，调用方已保证至少一个指针。
function getPointerCenter(points: PointerEvent[]): DiagramPoint {
  const [first, second] = points;
  if (!first || !second) {
    return { x: first?.clientX ?? 0, y: first?.clientY ?? 0 };
  }

  return {
    x: (first.clientX + second.clientX) / 2,
    y: (first.clientY + second.clientY) / 2,
  };
}

// 少于两个指针时返回 0，调用方需用 distance>0 判断除零；不在这里抛错是为了让手势可降级。
function getPointerDistance(points: PointerEvent[]): number {
  const [first, second] = points;
  if (!first || !second) {
    return 0;
  }

  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

// 空值、none、transparent 与全透明 rgba 都视为透明填充；缺一档会让画布背景被当成内容。
// 只用于背景识别，不用于可见性判断。
function isTransparentPaint(value: string): boolean {
  // 透明度判断对大小写与空白不敏感；CSS 输出的 "None" 也要识别。
  const normalized = value.trim().toLowerCase();
  // 渲染结构固定为「标题栏 + viewport + 单个 transformed content」；不要在中间插入额外滚动容器，否则坐标基准会变。
  // viewport 是唯一手势区域，标题栏按钮不参与指针捕获。
  // content 使用 absolute + origin-top-left，transform 才能与测量坐标系重合。
  return (
    normalized.length === 0 ||
    normalized === "none" ||
    normalized === "transparent" ||
    normalized === "rgba(0, 0, 0, 0)"
  );
}

// [契约] 优先 viewBox：它描述内容坐标系，是 fit 计算唯一可信的根尺寸。
// 其次读 width/height 属性，最后回退 client 尺寸；顺序体现「越接近作者意图越优先」。
// viewBox 存在但宽高为 0 时视为无效，继续降级，避免 0 尺寸让 fit 除零。
function readRootSvgBounds(svgElement: SVGSVGElement): DiagramViewportBounds {
  const viewBox = svgElement.viewBox.baseVal;
  // viewBox 是内容坐标系，宽高都为正是有效前提；只有一个正数时视为无效并降级。
  if (viewBox.width > 0 && viewBox.height > 0) {
    return {
      height: viewBox.height,
      width: viewBox.width,
      x: viewBox.x,
      y: viewBox.y,
    };
  }

  // 100% 等百分比在 baseVal 中可能解析为 0，因此必须继续回退到 client 尺寸。
  const width = svgElement.width.baseVal.value;
  const height = svgElement.height.baseVal.value;
  if (width > 0 && height > 0) {
    return { height, width };
  }

  return {
    height: svgElement.clientHeight,
    width: svgElement.clientWidth,
  };
}

// 这一步解决 Mermaid 输出的 width=100% + 父级收缩问题：把父容器和 SVG 都固定到 viewBox 尺寸。
// 必须在测量前执行，否则 getBoundingClientRect 与 bbox 分属两个坐标系，fit 结果必然偏移。
// 只改样式不改属性，避免覆盖作者写下的 viewBox。
function applyPreviewSvgLayout(
  contentElement: HTMLDivElement,
  svgElement: SVGSVGElement,
): DiagramViewportBounds {
  // 根尺寸只读一次，后面所有相对偏移都以它为原点，避免重复读取得到不同结果。
  const rootBounds = readRootSvgBounds(svgElement);
  if (rootBounds.width > 0 && rootBounds.height > 0) {
    // Mermaid 输出的 SVG 常见为 width="100%" + max-width=viewBox 宽度。
    // transform 实际作用在父级 content 上；如果只改 SVG，父级仍可能保持 300px 级别的收缩宽度。
    // 因此父级和 SVG 都要对齐到 viewBox 尺寸，保证 fit 计算和 CSS transform 使用同一个坐标系。
    // 父容器先定尺寸，SVG 再撑满 100%；反过来会让 SVG 先按旧父宽布局一次。
    // maxWidth=none 不能省：默认样式会把 SVG 压回 300px 级别。
    contentElement.style.width = `${rootBounds.width}px`;
    contentElement.style.height = `${rootBounds.height}px`;
    svgElement.style.width = "100%";
    svgElement.style.height = "100%";
    svgElement.style.maxWidth = "none";
  }

  return rootBounds;
}

// 只读不写，用于日志与背景识别；返回 null 而不是零矩形，避免把「不存在」当成「在原点」。
function readRect(element: Element | null): null | {
  height: number;
  width: number;
  x: number;
  y: number;
} {
  if (!element) {
    return null;
  }

  const rect = element.getBoundingClientRect();
  return {
    height: rect.height,
    width: rect.width,
    x: rect.x,
    y: rect.y,
  };
}

// getBBox 在元素未布局时会抛错，这里吞掉并返回 null，只服务日志，不影响主流程。
// 不要让这个函数参与 fit 决策：它没有可见性过滤。
function readSvgBBox(svgElement: SVGSVGElement): null | {
  height: number;
  width: number;
  x: number;
  y: number;
} {
  try {
    const box = svgElement.getBBox();
    return {
      height: box.height,
      width: box.width,
      x: box.x,
      y: box.y,
    };
  } catch {
    return null;
  }
}

// null 表示「还没有可见图形」，直接以当前盒初始化；用零矩形初始化会污染 union。
// x/y 缺失按 0 处理，兼容只有 width/height 的返回结构。
// union 用「最小左上 + 最大右下」，不能简单取最大宽高。
function mergeBounds(
  current: DiagramViewportBounds | null,
  box: Pick<DOMRect, "height" | "width" | "x" | "y">,
): DiagramViewportBounds {
  if (!current) {
    return {
      height: box.height,
      width: box.width,
      x: box.x,
      y: box.y,
    };
  }

  const minX = Math.min(current.x ?? 0, box.x);
  const minY = Math.min(current.y ?? 0, box.y);
  const maxX = Math.max((current.x ?? 0) + current.width, box.x + box.width);
  const maxY = Math.max((current.y ?? 0) + current.height, box.y + box.height);

  return {
    height: maxY - minY,
    width: maxX - minX,
    x: minX,
    y: minY,
  };
}

// 只识别「覆盖根 95% 以上且无描边或是 background 类」的 rect，避免误删真实的大背景图形。
// 95% 阈值是权衡：严格 100% 会漏掉 1px 取整误差，阈值过低会误删内容矩形。
// className 在 SVG 中可能是 SVGAnimatedString，必须区分 baseVal 与字符串两种形态。
function isCanvasBackgroundElement(
  element: SVGGraphicsElement,
  box: DOMRect,
  rootBounds: DiagramViewportBounds,
): boolean {
  // 只有 rect 才可能是画布背景；根尺寸无效时不做判断，避免把 0 尺寸当成「覆盖全部」。
  if (element.tagName.toLowerCase() !== "rect" || rootBounds.width <= 0 || rootBounds.height <= 0) {
    return false;
  }

  const style = getComputedStyle(element);
  const className =
    typeof element.className === "object" && "baseVal" in element.className
      ? element.className.baseVal
      : String(element.className ?? "");
  // 覆盖判定用 95% 容差而不是严格相等：导出 SVG 常有 1px 的取整误差，严格相等会漏判。
  const coversRoot =
    Math.abs(box.x - (rootBounds.x ?? 0)) <= 1 &&
    Math.abs(box.y - (rootBounds.y ?? 0)) <= 1 &&
    box.width >= rootBounds.width * 0.95 &&
    box.height >= rootBounds.height * 0.95;

  return coversRoot && (isTransparentPaint(style.stroke) || className.includes("background"));
}

// [权衡] 用逐图形 union 代替根 bbox：多花一次遍历，换来对透明画布与隐藏元素的准确排除。
// 空元素直接返回 0 尺寸，让调用方的 fit 走兜底分支而不是抛错。
// 这是纯测量函数，不修改 DOM；调用前必须已完成 applyPreviewSvgLayout。
function resolveSvgBounds(svgElement: SVGSVGElement | null): DiagramViewportBounds {
  // 空元素返回零尺寸而不是抛错：Dialog 关闭瞬间仍可能有调用进来。
  if (!svgElement) {
    return { height: 0, width: 0 };
  }

  const rootBounds = readRootSvgBounds(svgElement);
  // null 表示「尚未发现可见图形」，与零矩形区分开；零矩形会污染 union 起点。
  let visibleBounds: DiagramViewportBounds | null = null;

  // [并发] 遍历期间不等待布局，读取的是当前帧快照；因此必须在 rAF 之后调用。
  // querySelectorAll 返回静态列表，循环内删除节点也不会跳过元素。
  for (const element of svgElement.querySelectorAll(svgGraphicSelector)) {
    // 选择器命中的元素必须真的是图形元素；防御性地过滤掉非 SVG 命名空间节点。
    if (!(element instanceof SVGGraphicsElement)) {
      continue;
    }
    // closest 会向上穿透到根，能一次排除 defs/clipPath 内部的全部几何。
    if (element.closest(nonVisibleSvgAncestorSelector)) {
      continue;
    }

    const style = getComputedStyle(element);
    // 三种隐藏方式都要覆盖：display 不参与布局，visibility 与 opacity 仍可读 bbox。
    // 必须在 getBBox 之前判断，读取隐藏元素会得到无意义的边界。
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      continue;
    }

    try {
      // getBBox 是相对自身坐标系的几何，不含 transform；这正是 fit 需要的「内容尺寸」。
      const box = element.getBBox();
      if (
        // 零宽或零高的图形不贡献可见区域；纳入 union 会让 fit 结果被拉向空图形。
        box.width <= 0 ||
        box.height <= 0 ||
        isCanvasBackgroundElement(element, box, rootBounds)
      ) {
        continue;
      }
      // 逐个合并可见 bbox；这里不排序也不优化，保持一次遍历的确定性。
      visibleBounds = mergeBounds(visibleBounds, box);
    } catch {
      // 某些 SVG 元素未完成布局时不能读取 bbox；继续用其余可见图形求 union。
    }
  }

  // 只有确实找到可见几何才返回 union；宽或高为 0 视为无内容，继续走根 bbox 兜底。
  if (visibleBounds && visibleBounds.width > 0 && visibleBounds.height > 0) {
    return visibleBounds;
  }

  try {
    const box = svgElement.getBBox();
    if (box.width > 0 && box.height > 0) {
      return {
        height: box.height,
        width: box.width,
        x: box.x,
        y: box.y,
      };
    }
  } catch {
    // 根 bbox 不可用时回退到 viewBox / 声明尺寸。
  }

  // 没有任何可见几何时回退根尺寸：这是最后兜底，不是首选路径；直接走这里会保留画布空白。
  return rootBounds;
}

// 把客户端坐标换算到 viewport 容器坐标；缩放与拖动都必须基于容器而不是页面。
function getViewportPoint(
  container: HTMLDivElement,
  clientX: number,
  clientY: number,
): DiagramPoint {
  const rect = container.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

// 组件本身不缓存 svg 解析结果：每次 open 或 svg 变化都重新测量，避免展示过期图形。
// 所有手势状态都是 ref，不触发渲染；只有 transform 进 state。
// 把 open 当作唯一挂载开关，不提供「隐藏但保留状态」模式。
export function DiagramPreviewDialog({
  open,
  onOpenChange,
  svg,
  title,
}: DiagramPreviewDialogProps) {
  // 所有可见文案走 intl；title 来自调用方，属于内容而不是界面文案。
  const { intl } = useZCodeIntl();
  // 四个 ref 分工固定：dialog 用于诊断日志，viewport 是手势坐标基准，content 承载 transform，activePointers 记录多指。
  // 复用 ref 会让手势与布局互相污染。
  // ref 只在事件与 effect 中读取，渲染期不依赖其存在。
  const dialogContentRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // [并发] 用 Map 按 pointerId 记录，而不是单变量：多指同时活动时顺序不可预期。
  // 存 nativeEvent 是为了随时读取最新坐标，React 合成事件对象会被回收。
  const activePointersRef = useRef(new Map<number, PointerEvent>());
  const dragOriginRef = useRef<{
    point: DiagramPoint;
    transform: DiagramViewportTransform;
  } | null>(null);
  const pinchGestureRef = useRef<PinchGestureState | null>(null);
  // transform 是唯一进 state 的手势结果；关闭对话框时不需要手动复位，因为 open=false 的 effect 会清空手势。
  const [transform, setTransform] = useState<DiagramViewportTransform>(defaultTransform);

  // fit 的完整顺序：布局对齐 → 测量可见边界 → 读取 viewport 尺寸 → 计算 transform。顺序不可交换。
  // 缺少 viewport/content/svg 任一元素时直接复位为默认 transform，而不是抛错：首帧尚未挂载是正常状态。
  // 依赖数组为空：函数只读取 ref，不捕获外部变量，避免每次渲染重建并重复触发 effect。
  const fitToViewport = useCallback(() => {
    // 所有手势都从同一个 viewport ref 取坐标基准；不要换成 content 或 dialog。
    const viewport = viewportRef.current;
    // content 是承载 transform 的元素，测量与样式写入都必须指向它。
    const content = contentRef.current;
    // 只取第一个根 svg；嵌套 svg 的尺寸由根统一表达。
    const svgElement = content?.querySelector("svg");
    // 任一元素缺失都恢复默认 transform 并返回：首帧未挂载、Dialog 未展开都属于正常路径，不能抛错。
    // 这里不重试，重新挂载后 open/svg 的 effect 会再次触发 fit。
    if (!viewport || !content || !(svgElement instanceof SVGSVGElement)) {
      setTransform(defaultTransform);
      return;
    }

    // 先对齐父容器与 SVG 尺寸；后续所有 bbox 偏移都以 rootBounds 为基准。
    // rootBounds 同时用于把 bbox 从 SVG 坐标平移到父容器坐标，不能只用宽度。
    const rootBounds = applyPreviewSvgLayout(content, svgElement);
    // 这里必须拿到可见 union，而不是根 bbox；否则画布背景会让 fit 失去意义。
    const diagramBounds = resolveSvgBounds(svgElement);
    // 每次 fit 都重新读取 viewport rect；缓存宽度会在侧栏展开或窗口缩放后失效。
    const viewportRect = viewport.getBoundingClientRect();
    // 把 bbox 相对 root 的偏移交给纯函数，组件不自行推导缩放比例，保证「适应窗口」与「重置」口径一致。
    // viewport 尺寸用实时 rect，而不是缓存值：侧栏展开与窗口缩放都会改变可用空间。
    const nextTransform = fitDiagramToViewport({
      diagramHeight: diagramBounds.height,
      diagramWidth: diagramBounds.width,
      diagramX: (diagramBounds.x ?? 0) - (rootBounds.x ?? 0),
      diagramY: (diagramBounds.y ?? 0) - (rootBounds.y ?? 0),
      viewportHeight: viewportRect.height,
      viewportWidth: viewportRect.width,
    });

    const viewBox = svgElement.viewBox.baseVal;
    const computedStyle = getComputedStyle(svgElement);
    // 这条日志是一次性信息级诊断，包含 SVG 属性、bbox、rect 与最终 transform，用于复现「预览空白/错位」问题。
    // 字段全部来自只读测量，不包含文档内容，避免把用户图表数据写进日志。
    // 新增字段只能追加，不能改既有键名：E2E 与排障脚本按这些键定位。
    logger.info("[DiagramPreviewDialog] preview layout measured", {
      content: {
        rect: readRect(content),
        transform: content.style.transform,
      },
      dialog: {
        rect: readRect(dialogContentRef.current),
      },
      fit: {
        bounds: diagramBounds,
        rootBounds,
        transform: nextTransform,
      },
      svg: {
        attributes: {
          height: svgElement.getAttribute("height"),
          style: svgElement.getAttribute("style"),
          viewBox: svgElement.getAttribute("viewBox"),
          width: svgElement.getAttribute("width"),
        },
        bbox: readSvgBBox(svgElement),
        client: {
          height: svgElement.clientHeight,
          width: svgElement.clientWidth,
        },
        computedStyle: {
          height: computedStyle.height,
          maxHeight: computedStyle.maxHeight,
          maxWidth: computedStyle.maxWidth,
          width: computedStyle.width,
        },
        rect: readRect(svgElement),
        rootBounds: readRootSvgBounds(svgElement),
        viewBox: {
          height: viewBox.height,
          width: viewBox.width,
          x: viewBox.x,
          y: viewBox.y,
        },
      },
      transform: nextTransform,
      viewport: {
        rect: readRect(viewport),
      },
    });
    // fit 结果只在测量完成后一次性写入，避免中间态触发多次渲染。
    setTransform(nextTransform);
  }, []);

  // 按钮缩放以 viewport 中心为锚点，与滚轮缩放保持同一语义；不要改成左上角。
  // 缩放是乘在当前 scale 上，不是设置绝对值，因此连续点击可累积。
  const zoomBy = useCallback((factor: number) => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    // 按钮缩放以 viewport 可视区中心为锚点，因此必须读实时 rect 而不是缓存尺寸。
    const rect = viewport.getBoundingClientRect();
    // 中心使用 viewport 局部坐标，与 zoomDiagramAtPoint 的输入约定一致。
    const center = { x: rect.width / 2, y: rect.height / 2 };
    // 用函数式更新读取最新 transform，避免双击时闭包拿到过期 scale。
    setTransform((current) => zoomDiagramAtPoint(current, center, current.scale * factor));
  }, []);

  // 菜单选择是绝对档位，与按钮的相对缩放区分开；两者共用 zoomDiagramAtPoint 保证锚点行为一致。
  const zoomToScale = useCallback((scale: number) => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const rect = viewport.getBoundingClientRect();
    const center = { x: rect.width / 2, y: rect.height / 2 };
    setTransform((current) => zoomDiagramAtPoint(current, center, scale));
  }, []);

  // 重置不是「回到默认 transform」，而是「按 100% 居中」；因此必须重新测量并计算 translate。
  // 与 fit 的区别只在 scale 固定为 1，测量顺序完全相同，不能合并成一次缓存复用。
  const reset = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const svgElement = content?.querySelector("svg");
    if (!viewport || !content || !(svgElement instanceof SVGSVGElement)) {
      setTransform(defaultTransform);
      return;
    }

    // 重置与 fit 共用同一段测量前处理，避免两条路径对父容器尺寸做出不同假设。
    // 重置路径同样需要 rootBounds 的 x/y 偏移来居中，不能只取宽高。
    const rootBounds = applyPreviewSvgLayout(content, svgElement);
    // 重置使用同一份可见边界；若这里改用根 bbox，重置与 fit 的居中度会不一致。
    // 测量必须在 applyPreviewSvgLayout 之后，顺序与 fitToViewport 完全一致。
    const diagramBounds = resolveSvgBounds(svgElement);
    const viewportRect = viewport.getBoundingClientRect();
    // 居中偏移要减去 bbox 相对 root 的偏移，否则有 viewBox 偏移的图会偏离中心。
    // scale 固定为 1 表示真实像素，不继承当前缩放。
    setTransform({
      scale: 1,
      translateX:
        (viewportRect.width - diagramBounds.width) / 2 -
        ((diagramBounds.x ?? 0) - (rootBounds.x ?? 0)),
      translateY:
        (viewportRect.height - diagramBounds.height) / 2 -
        ((diagramBounds.y ?? 0) - (rootBounds.y ?? 0)),
    });
  }, []);

  useEffect(() => {
    if (!open) {
      // 关闭时清空指针表，防止重新打开后第一帧就把旧指针当成按下状态。
      activePointersRef.current.clear();
      dragOriginRef.current = null;
      pinchGestureRef.current = null;
      return;
    }

    // [资源] 必须等一帧让 Dialog 完成布局；同步测量会得到 0 尺寸并留下错误 transform。
    // 清理函数取消未执行的帧，避免关闭后仍写 state。
    // 依赖 svg 是有意的：同一对话框打开时切换图表需要重新 fit。
    const frame = window.requestAnimationFrame(fitToViewport);
    // [资源] 关闭或切换图表时取消尚未执行的帧，避免对已卸载节点写 state。
    return () => window.cancelAnimationFrame(frame);
  }, [fitToViewport, open, svg]);

  useEffect(() => {
    if (!open) {
      return;
    }

    // 窗口尺寸变化会改变可用 viewport，必须重新 fit，而不是等比缩放当前 transform。
    const handleResize = () => fitToViewport();
    // 只在 open 时注册，返回的清理函数必须移除同一个函数引用。
    window.addEventListener("resize", handleResize);
    // 清理必须使用同一个 handleResize 引用；匿名函数会导致监听泄漏。
    return () => window.removeEventListener("resize", handleResize);
  }, [fitToViewport, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    // 快捷键是窗口级的，因此必须先尊重 defaultPrevented，避免抢占输入框与其他组件。
    // `handleKeyDown` 只认 + / = / - 三个键：方向键留给页面滚动。
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      // 键盘布局差异让加号常以 "=" 上报，必须同时匹配；只认 "+" 会让部分键盘无效。
      if (event.key === "+" || event.key === "=") {
        // [默认行为] wheel 必须先阻止页面滚动，再决定缩放或平移；两者同时发生会让用户失去焦点。
        event.preventDefault();
        zoomBy(1.18);
        return;
      }

      // 缩小与放大使用互逆系数（1.18 / 0.85），保证一次放大一次缩小能回到原比例。
      if (event.key === "-") {
        event.preventDefault();
        zoomBy(0.85);
        return;
      }
    };

    // keydown 与 resize 一样是窗口级监听，必须在 effect 清理阶段解除。
    window.addEventListener("keydown", handleKeyDown);
    // 键盘监听同样是窗口级资源，关闭对话框后必须解除，否则其他页面也会被缩放快捷键影响。
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, zoomBy]);

  // [并发] wheel 是高频事件，回调内只做同步计算与一次 setState，不触发测量。
  // 必须先 preventDefault：否则浏览器会同时滚动页面。
  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    // ctrlKey 表示触控板捏合或 Ctrl+滚轮，走以指针为锚点的缩放；其余情况是双指滚动，走平移。
    // 锚点取 client 坐标换算后的容器坐标，不能取元素中心。
    if (event.ctrlKey) {
      // 单指时记录起点与当时的 transform；后续 move 用增量平移，而不是逐帧累加。
      const point = getViewportPoint(viewport, event.clientX, event.clientY);
      // 指数映射让缩放感受线性，且始终为正；不要改成加法，否则可能得到 0 或负数 scale。
      const factor = Math.exp(-event.deltaY * 0.01);
      // 滚轮缩放锚点是鼠标位置而不是容器中心，这对查看局部细节至关重要。
      setTransform((current) => zoomDiagramAtPoint(current, point, current.scale * factor));
      return;
    }

    // `panDiagram` 取负位移的原因：滚轮向下时内容应向上移动。
    setTransform((current) => panDiagram(current, { x: -event.deltaX, y: -event.deltaY }));
  }, []);

  // [并发] pointerdown 是所有手势的入口，先登记指针再分支，保证多指顺序无关。
  // 依赖 transform：按下瞬间要冻结当前变换作为拖动/缩放基准。
  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const viewport = viewportRef.current;
      if (!viewport) {
        return;
      }

      // 捕获后指针移出容器仍能收到 move/up；去掉这一步会让快速拖动在边界处丢失事件。
      // 捕获在登记之前能保证后续事件都能命中同一元素。
      event.currentTarget.setPointerCapture(event.pointerId);
      activePointersRef.current.set(event.pointerId, event.nativeEvent);
      const activePointers = Array.from(activePointersRef.current.values());

      // 第二指按下即进入 pinch，并清空拖拽基准，避免两套手势同时生效。
      // 基准只在这里写一次，move 阶段不再更新 center/distance。
      if (activePointers.length >= 2) {
        pinchGestureRef.current = {
          center: getPointerCenter(activePointers),
          distance: getPointerDistance(activePointers),
          transform,
        };
        dragOriginRef.current = null;
        return;
      }

      const point = getViewportPoint(viewport, event.clientX, event.clientY);
      // 拖拽基准同时记录起点与当时的 transform，move 阶段据此计算总位移而不是增量累加。
      dragOriginRef.current = { point, transform };
    },
    [transform],
  );

  // [并发] 只处理已登记指针，未按下时的 move 直接忽略，避免悬停就触发平移。
  // 每帧更新指针坐标后再分支，保证双指数据是当前帧的。
  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport || !activePointersRef.current.has(event.pointerId)) {
      return;
    }

    activePointersRef.current.set(event.pointerId, event.nativeEvent);
    // [并发] move 阶段重新取快照，不信任上一帧的数组；指针可能在两帧之间增减。
    // Map 的插入顺序稳定，getPointerCenter 取前两个指针因此不会随机抖动。
    const activePointers = Array.from(activePointersRef.current.values());

    // pinch 的 scale 以「当前距离 / 起始距离」推算，再乘起始 scale；不能乘当前 scale，否则会指数放大。
    // 先缩放后平移：先以冻结中心缩放，再叠加中心位移，顺序反过来会产生漂移。
    // viewportCenter 用最新中心换算，保证缩放锚点跟随双指。
    if (activePointers.length >= 2 && pinchGestureRef.current) {
      // 当前中心只用于计算本帧位移，缩放基准仍用冻结的 gesture.center。
      const nextCenter = getPointerCenter(activePointers);
      // `nextDistance` 与冻结 `gesture.distance` 的比值就是本帧缩放增量，不能拿累计比值连乘。
      const nextDistance = getPointerDistance(activePointers);
      // 取冻结基准的局部引用；中途读取 ref 可能拿到已被其他事件清空的值。
      const gesture = pinchGestureRef.current;
      // 双指中心是页面坐标，必须先换算到容器坐标再参与缩放。
      const viewportCenter = getViewportPoint(viewport, nextCenter.x, nextCenter.y);
      // 平移量是双指中心的位移，与缩放分开计算，便于先缩放后平移的组合。
      const panDelta = {
        x: nextCenter.x - gesture.center.x,
        y: nextCenter.y - gesture.center.y,
      };
      // 起始 scale 乘以距离比；distance 为 0 时退化为 1，防止除零产生 Infinity。
      // 不限制上下界是有意的：用户需要放大查看细节，越界由下一帧手势自然回收。
      const nextScale =
        gesture.transform.scale * (gesture.distance > 0 ? nextDistance / gesture.distance : 1);
      // 始终以冻结 transform 为缩放输入，而不是当前 state，避免多指抖动被逐帧放大。
      const zoomed = zoomDiagramAtPoint(gesture.transform, viewportCenter, nextScale);
      // 先以冻结基准缩放，再叠加中心位移；顺序与 zoomDiagramAtPoint 的坐标约定一致。
      setTransform(panDiagram(zoomed, panDelta));
      return;
    }

    // 单指平移以「当前点 - 起点」作为总位移，始终基于按下时的 transform，天然无累积误差。
    // 没有起点时忽略：可能是一次没有 down 的 move（如触控笔悬停）。
    if (dragOriginRef.current) {
      const point = getViewportPoint(viewport, event.clientX, event.clientY);
      setTransform(
        panDiagram(dragOriginRef.current.transform, {
          x: point.x - dragOriginRef.current.point.x,
          y: point.y - dragOriginRef.current.point.y,
        }),
      );
    }
  }, []);

  // [并发] up 与 cancel 共用同一清理函数；cancel 不清理会让后续手势继承僵尸指针。
  // 一次抬起就清空 pinch：当前实现不支持抬起一指后继续单指拖动，这是有意的简化。
  const handlePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    // 只删除当前指针而不是 clear：多指场景下其他手指可能仍在按着。
    activePointersRef.current.delete(event.pointerId);
    dragOriginRef.current = null;
    pinchGestureRef.current = null;
  }, []);

  // transform 字符串拼装顺序固定为 translate 再 scale：先平移后缩放，与 zoomDiagramAtPoint 的数学约定一致。
  // 用 useMemo 避免每次渲染生成新对象，减少 content 的样式写入。
  const transformStyle = useMemo(
    () => ({
      transform: `translate(${transform.translateX}px, ${transform.translateY}px) scale(${transform.scale})`,
    }),
    [transform],
  );

  // 百分比只用于展示；不要把它喂回 scale，否则会累积舍入误差。
  const zoomPercent = Math.round(transform.scale * 100);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none grid-rows-none flex-col gap-0 rounded-2xl border-0 p-0 sm:h-[86vh] sm:max-h-[86vh] sm:w-[90vw] sm:border sm:border-popover-border"
        ref={dialogContentRef}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">
          {intl.formatMessage({ id: "codeBlock.mermaid.previewDescription" })}
        </DialogDescription>
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-border border-b px-3">
          <div className="min-w-0 truncate text-ui-base font-medium text-foreground">{title}</div>
          <div className="flex shrink-0 items-center gap-1">
            <PreviewButton
              label={intl.formatMessage({ id: "codeBlock.mermaid.zoomOut" })}
              onClick={() => zoomBy(0.85)}
            >
              <CircleMinusIcon className="size-3.5" />
            </PreviewButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={intl.formatMessage({ id: "codeBlock.mermaid.zoomLevel" })}
                  className="min-w-14 gap-1 px-1.5 font-mono text-foreground-subtle"
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <span>{zoomPercent}%</span>
                  <ChevronDownIcon className="size-3 text-foreground-subtlest" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center" className="min-w-36">
                {zoomScaleOptions.map((scale) => {
                  // 菜单项按绝对比例生成文案，与当前缩放无关；key 用 percent 而不是 scale，避免 0.5 与 0.50 重复。
                  const percent = Math.round(scale * 100);
                  return (
                    <DropdownMenuItem key={percent} onSelect={() => zoomToScale(scale)}>
                      {intl.formatMessage(
                        { id: "codeBlock.mermaid.zoomToPercent" },
                        { percent: String(percent) },
                      )}
                    </DropdownMenuItem>
                  );
                })}
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={fitToViewport}>
                  {intl.formatMessage({ id: "codeBlock.mermaid.zoomToFit" })}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={reset}>
                  {intl.formatMessage({ id: "codeBlock.mermaid.resetZoom" })}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <PreviewButton
              label={intl.formatMessage({ id: "codeBlock.mermaid.zoomIn" })}
              onClick={() => zoomBy(1.18)}
            >
              <CirclePlusIcon className="size-3.5" />
            </PreviewButton>
            <PreviewButton
              label={intl.formatMessage({ id: "codeBlock.mermaid.close" })}
              onClick={() => onOpenChange(false)}
            >
              <XIcon className="size-3.5" />
            </PreviewButton>
          </div>
        </div>
        <div
          ref={viewportRef}
          className={cn(
            "relative min-h-0 flex-1 touch-none overflow-hidden bg-popover",
            "cursor-grab active:cursor-grabbing",
          )}
          onPointerCancel={handlePointerEnd}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onWheel={handleWheel}
        >
          <div
            ref={contentRef}
            aria-label={title}
            className="absolute top-0 left-0 origin-top-left select-none [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-none"
            dangerouslySetInnerHTML={{ __html: svg }}
            role="img"
            style={transformStyle}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// 工具栏按钮统一包一层 tooltip 并把 aria-label 设为同一个 label，保证视觉提示与可访问名称不漂移。
// 按钮不持有状态，点击行为完全由父组件传入。
function PreviewButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <ControlHintTooltip title={label} side="bottom">
      <Button aria-label={label} onClick={onClick} size="icon-md" type="button" variant="ghost">
        {children}
      </Button>
    </ControlHintTooltip>
  );
}
