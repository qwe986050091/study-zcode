// 各格式查看器（docx/pdf/pptx/xlsx）与外壳之间的公共契约：只定义类型、常量和纯函数，
// 不含 React/DOM 实现，便于外壳统一驱动不同渲染器。
// 口径：对外位置字符串（at）由各查看器的定位器语法决定；页码/行列均为 1-based；
// 可空字段一律用 undefined 表示「不适用」，不使用 null 作为业务语义。
import type { DocumentInfo, DocxBlockKey, Selection, ShowTarget } from "#office/contract.ts";

// 截图结果：PNG 的 base64 负载与它对应的位置。data 不含 `data:` 前缀，由调用方自行拼装。
export interface Capture {
  /** PNG as base64 (no data: prefix). */
  data: string;
  // 截图对应的定位器字符串，通常是本次 capture 的目标位置或当时视口顶部。
  at: string;
  // 图片像素宽（CSS 像素，未乘 devicePixelRatio）。
  width: number;
  // 图片像素高（CSS 像素）。
  height: number;
}

// 惰性定位函数：调用时才读取当前屏幕位置，未渲染或已滚出视口时返回 null。
// 返回值是视口坐标，滚动后必须重新调用；不得缓存结果用于滚动后的位置判断。
/** Current on-screen box of something in the document, or null when it is not rendered. */
export type Locate = () => DOMRect | null;

// 适配模式：width=适宽，page=整页可见，actual=实际大小（96 CSS px/inch）。
export type FitMode = "width" | "page" | "actual";

// 缩放状态：mode 为 null 表示自由缩放，此时以 percent 为准；两者都由查看器上报给外壳。
// 口径与 nextZoom/ZOOM_STEPS 对齐，percent 取整显示，不保证等于实际 CSS scale。
/** Zoom as the page/zoom control shows it: a fit mode, or a percentage of actual size. */
export interface ZoomState {
  // 当前适配模式；null 表示用户做过自由缩放，此时百分比优先。
  mode: FitMode | null;
  // 相对实际大小的百分比（100 = actual），仅用于显示，不保证落在 ZOOM_STEPS 上。
  percent: number;
}

// 分页状态：current 为视口顶部所在页（1-based），count 为总页/幻灯片数。
// 只用于页码胶囊显示，不参与定位；未就绪时的 count 可能小于真实值，以 onReady 后为准。
export interface PageState {
  /** 1-based page (or slide) at the top of the view. */
  current: number;
  // 总页数/幻灯片数；文件尚未加载完时可能为占位值，就绪后以 onReady 为准。
  count: number;
}

// 选择来源描述：text 区分文本选择与块/页/范围点击，user 区分用户主动选择与程序初始化。
// locate 用于给操作条定位；不参与 anchor 生成，anchor 只来自 Selection 本身。
/** How a selection was made, for the selection bar. */
export interface SelectionDetail {
  /** True for a text selection (the bar offers Copy); false for a clicked block, page or range. */
  text: boolean;
  locate: Locate;
  /** False when the selection changed without the user acting on it (e.g. a sheet's first cell). */
  user: boolean;
}

// 一个已解析的 Agent 目标：at 为归一后的定位器（可能比请求时更具体），
// locate 返回当前屏幕位置（未渲染/已滚出时为 null），scrollTo 负责滚动到可视区域。
/** One agent target after it was resolved in the rendered document, in the order given. */
export interface RevealedTarget {
  // 归一后的定位器，可回传给 goTo/capture 复用。
  at: string;
  // 惰性求值：调用时才读取当前 DOM 位置，避免滚动后位置过期。
  locate: Locate;
  // 立即滚动到该目标，重复调用应幂等。
  scrollTo(): void;
}

// 外壳驱动查看器的命令式接口：所有方法都由查看器实现，外壳不直接触碰渲染细节。
// 约定：reveal/goTo 需滚动到目标，find 返回命中数，capture 返回 PNG；可缺省的能力用可选方法表达。
/** Imperative interface the shell uses to drive a viewer. */
export interface ViewerHandle {
  /** Mark the targets, scroll to the first and return where each one is. */
  reveal(targets: ShowTarget[]): Promise<RevealedTarget[]>;
  clearReveal(): void;
  /** Scroll to a locator without marking it (outline entries). */
  goTo(at: string): void;
  /** Render a location (null = what is visible) to an image. */
  capture(at: string | null, maxWidth: number): Promise<Capture>;
  // direction = 1 放大、-1 缩小；实现可忽略（如 pptx 无缩放能力）。
  zoom(direction: 1 | -1): void;
  // 切到指定适配模式；实现可忽略。
  fit(mode: FitMode): void;
  /** Paint every match of `query` and return how many there are. */
  find(query: string): Promise<number>;
  /** Make match `index` (0-based) current and scroll to it. */
  findGo(index: number): void;
  clearFind(): void;
  /** Clear the user's selection (DOM selection and block outline). */
  clearSelection(): void;
  /** Paged viewers (pdf, docx, pptx). */
  goToPage?(page: number): void;
  /** Small rendering of a page or slide for the pages drawer. */
  thumbnail?(page: number, width: number): Promise<HTMLElement>;
}

// 查看器输入：原始字节 + 文档元信息 + 主题/预览开关 + 一组上报回调。
// bytes 归查看器只读使用；所有位置与选择都经回调交还外壳，组件不自行持久化。
export interface ViewerProps {
  // 文件原始字节；查看器内部应自行拷贝/转移，不得修改调用方持有的数据。
  bytes: ArrayBuffer;
  // 文档元信息；info.path 是文件名（用于格式/编码判断），也用于缩略图等辅助能力。
  info: DocumentInfo;
  // docx 专用：只渲染这些块（目录/大纲视图）；undefined 表示渲染全文。
  blocks?: DocxBlockKey[];
  // 当前是否深色主题；查看器据此决定截图底色（xlsx）与内容配色。
  dark: boolean;
  /** A short, non-interactive preview (inline card): first pages only, no scrolling. */
  glance?: boolean;
  /** Visible location changed (topmost page / slide / block, or active sheet + cell). */
  onLocation(at: string): void;
  /** The user selected something (click or text selection), or cleared it. */
  onSelect(selection: Selection | null, detail?: SelectionDetail): void;
  /**
   * The user clicked one of the agent's marks (a quote, block, shape or cell range; not a whole
   * page or slide). `index` is the target's position in the last `reveal` result. Returns true
   * when the shell showed the note; otherwise the click selects as usual.
   */
  onRevealHit?(index: number): boolean;
  onPage?(state: PageState): void;
  onZoom?(state: ZoomState): void;
  onLink(url: string): void;
  onReady(): void;
  onError(error: Error): void;
}

// 缩放下限/上限即首尾元素：nextZoom 在超出范围时分别返回 25/400。
/** Zoom steps (percent of actual size), as browsers and ZCode's PDF preview use. */
export const ZOOM_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400];

// percent 不要求落在 ZOOM_STEPS 上；0.5 容差避免 66.6 这类显示值被跳档，返回始终是表内整数。
// 取下一档缩放：方向 +1 取严格大于当前值的最近一档（0.5 容差吸收四舍五入），
// -1 取严格小于的最近一档；已到端点时返回端点值，因此调用是幂等的。
export function nextZoom(percent: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > percent + 0.5) ?? 400;
  return [...ZOOM_STEPS].reverse().find((step) => step < percent - 0.5) ?? 25;
}
