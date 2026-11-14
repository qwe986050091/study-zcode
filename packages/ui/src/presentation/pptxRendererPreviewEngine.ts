// INV-01 守住位置：pageIndex 必须先落在 presentation.slides 范围内；改错故障：越界读到 undefined，元素构建与渲染会静默退化成空白页。
// INV-02 守住位置：getPageElements 与 renderPage 的前置 disposed 校验；改错故障：释放后仍分配句柄与缓存，DOM 和内存一起泄漏。
// INV-03 守住位置：elementCache 的写入点必须在元素构建成功之后；改错故障：异常页被缓存成半成品，后续调用持续拿到残缺元素。
// INV-04 守住位置：renderPage 返回前把句柄登记进 activeHandles；改错故障：文档 dispose 时漏掉调用方仍持有的句柄。
// INV-05 守住位置：句柄释放由 handleDisposed 保证幂等；改错故障：重复释放触发上游二次清理，容器与事件状态错乱。
// INV-06 守住位置：释放句柄时同步移除上游 element；改错故障：容器里留下孤儿节点与未解绑的事件监听。
// INV-07 守住位置：文档 dispose 末尾清空 activeHandles 与 elementCache；改错故障：整份节点树随预览实例常驻，无法回收。
// INV-08 守住位置：group 文本索引只传入单页 presentation；改错故障：显式选一页也会 materialize 全篇，打开成本升到总页数量级。
// INV-09 守住位置：单页文本索引里 entry.slideIndex 恒为 0；改错故障：过滤条件若写成 pageIndex，非首页的 group 文本全部丢失。
// INV-10 守住位置：group 条目必须排除 directNodeIds 中的节点；改错故障：同一节点文本进两份，元素重复且命中区域重叠。
// INV-11 守住位置：group 条目路径前缀固定为 slides/0/nodes/；改错故障：跨页路径或非节点路径混入单页索引。
// INV-12 守住位置：buildTextIndex 的 includeTables 必须关闭；改错故障：表格文本既走 group 又走 rows，下游出现重复文本。
// INV-13 守住位置：只有 shape 节点读取 textBody；改错故障：picture 与 chart 带上空文本字段，下游按文本判定可见性时失真。
// INV-14 守住位置：表格缺失 columns 与 rows 时兜底为空数组；改错故障：下游直接遍历 undefined 抛错，整页元素构建失败。
// INV-15 守住位置：onNavigate 把上游 slideIndex 映射成 pageIndex；改错故障：跳页整体错位，跨页链接丢失 url。
// INV-16 守住位置：未提供 onNavigate 时保持 undefined，不塞空函数；改错故障：上游误判可导航，自身的默认行为被吞掉。
// INV-17 守住位置：上游 element 的挂载与摘除都由本模块负责；改错故障：重复 append 或节点脱离容器，预览区留白。
// INV-18 守住位置：open 只用 lazySlides 构建并沿用推荐 zip 上限；改错故障：打开大文件时首屏全量解析，界面长时间无响应。
//
// 模块职责：把上游 PPTX 解析与渲染能力适配成 PresentationPreviewEngine 契约，提供分页元素模型与可释放的渲染句柄。
// 状态所有权：句柄集合、页元素缓存与 disposed 标志归本文档实例；幻灯片数据归上游 presentation，本模块只读。
// 阅读顺序：类型结构、文本提取、文档实现的三个公开方法，最后是对外引擎入口。
import {
  RECOMMENDED_ZIP_LIMITS,
  buildTextIndex,
  buildPresentation,
  materializeSlideNodes,
  parseZipLazyMedia,
  renderSlide,
} from "@aiden0z/pptx-renderer/browser";
import type { SlideHandle } from "@aiden0z/pptx-renderer";
import type {
  PresentationPreviewDocument,
  PresentationPreviewEngine,
  PresentationPageElement,
  PresentationRenderHandle,
  PresentationRenderOptions,
} from "@/presentation/types.js";
import { buildPresentationPageElements } from "@/presentation/presentationElementModel.js";

// 上游段落与 run 结构按最小可用形状声明，只暴露 readTextBody 真正需要的 text 字段。
// 这是读取文本的唯一入口契约，字段层级一旦漂移，编译期只在恰好有结构兼容时才拦得住。
// 改错故障：把 paragraphs 改名或把 run 展平，readTextBody 会抛错或返回 undefined，形状文本整页丢失。
// 刻意不引入上游富文本类型，避免 UI 包被渲染器内部结构调整牵连。
interface TextBodyLike {
  paragraphs: Array<{ runs: Array<{ text: string }> }>;
}

// 这是节点联合体的窄化视图，只保留 id、位置、尺寸、文本体与表格网格四类信息。
// nodeType 的联合取值决定下游按形状还是表格取文本，新增节点种类必须在这里显式列出。
// 改错故障：漏写某个 nodeType，该节点会落到 unknown，元素模型与命中测试一起失真。
// columns 与 rows 声明为可选，因为非表格节点本来就不带网格，读取侧必须容忍缺省。
interface SlideNodeLike {
  id: string;
  name: string;
  nodeType: "shape" | "picture" | "table" | "group" | "chart" | "unknown";
  position: { x: number; y: number };
  size: { w: number; h: number };
  textBody?: TextBodyLike;
  columns?: number[];
  rows?: Array<{
    height: number;
    cells: Array<{
      gridSpan: number;
      rowSpan: number;
      hMerge: boolean;
      vMerge: boolean;
      textBody?: TextBodyLike;
    }>;
  }>;
}

// 只要求宽高与 slides 两项，上游更完整的演示文稿对象因结构兼容可直接传入。
// getPageElements 与 renderPage 都按 slides[pageIndex] 取页，页序即展示顺序，不能改按 slidePath 查找。
// 改错故障：改成路径查找后，任何部件重命名都会让分页错位或整页取空。
interface PresentationLike {
  width: number;
  height: number;
  slides: Array<{
    slidePath: string;
    nodes: SlideNodeLike[];
  }>;
}

interface TextIndexEntryLike {
  slideIndex: number;
  nodeId: string;
  nodePath: string;
  textKind: "shape" | "table-cell";
  text: string;
  bounds: { x: number; y: number; w: number; h: number };
}

// 段落之间用换行拼接、同一段内的 run 直接相连，是与上游文本模型对齐的最小重建方式。
// 末尾 trim 去掉 PPT 常见的尾随空白，空文本体返回 undefined 而不是空串。
// 改错故障：把 undefined 归一成空串，下游就区分不出「没有文本框」与「文本框为空」。
// 改错故障：在 run 之间补空格会污染中英文混排的字距，并让文本检索命中偏离原文。
function readTextBody(textBody: TextBodyLike | undefined) {
  return textBody?.paragraphs
    .map((paragraph) => paragraph.runs.map((run) => run.text).join(""))
    .join("\n")
    .trim();
}

// 文档对象是渲染句柄与页元素缓存的唯一所有者，一次 open 对应一个实例。
// activeHandles 记录尚未释放的句柄，elementCache 按页号缓存不可变元素数组。
// disposed 是幂等释放的总开关，构造函数里算好的 pageCount 与 pageSize 之后只读。
// 改错故障：缓存或句柄外泄后，关闭预览时无法一次性回收，残留会跨页累积。
class PptxRendererPreviewDocument implements PresentationPreviewDocument {
  readonly pageCount: number;
  readonly pageSize: { width: number; height: number };

  private readonly activeHandles = new Set<PresentationRenderHandle>();
  private readonly elementCache = new Map<number, readonly PresentationPageElement[]>();
  private disposed = false;

  constructor(private readonly presentation: PresentationLike) {
    this.pageCount = presentation.slides.length;
    this.pageSize = {
      width: presentation.width,
      height: presentation.height,
    };
  }

  // 先判 disposed 再查缓存，保证释放后的调用直接失败，而不是返回陈旧元素。
  // 越界页抛 RangeError 而不是返回空数组，避免静默空白页掩盖分页计算错误。
  // materializeSlideNodes 只对当前页调用，这是「显式选页不 materialize 全篇」的关键。
  // group 文本索引用单页 presentation 构建，所以下面的过滤条件里 slideIndex 恒为 0。
  getPageElements(pageIndex: number) {
    if (this.disposed) {
      throw new Error("Presentation preview document has been disposed");
    }
    const cached = this.elementCache.get(pageIndex);
    if (cached) {
      return cached;
    }
    const slide = this.presentation.slides[pageIndex];
    if (!slide) {
      throw new RangeError(`Presentation page index is out of range: ${pageIndex}`);
    }
    materializeSlideNodes(this.presentation, slide);
    // 只为当前页建立 group 文本索引，避免显式选择一页时提前 materialize 整份演示文稿。
    const groupTextIndex = buildTextIndex(
      { ...this.presentation, slides: [slide] },
      {
        includeGroups: true,
        includeShapes: true,
        includeTables: false,
      },
    ) as TextIndexEntryLike[];
    const directNodeIds = new Set(slide.nodes.map((node) => node.id));
    const elements = buildPresentationPageElements({
      slideIndex: pageIndex,
      slidePart: slide.slidePath,
      nodes: slide.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        nodeType: node.nodeType,
        position: node.position,
        size: node.size,
        ...(node.nodeType === "shape" ? { text: readTextBody(node.textBody) } : {}),
        ...(node.nodeType === "table"
          ? {
              columns: node.columns ?? [],
              rows: (node.rows ?? []).map((row) => ({
                height: row.height,
                cells: row.cells.map((cell) => ({
                  gridSpan: cell.gridSpan,
                  rowSpan: cell.rowSpan,
                  hMerge: cell.hMerge,
                  vMerge: cell.vMerge,
                  text: readTextBody(cell.textBody),
                })),
              })),
            }
          : {}),
      })),
      groupTextEntries: groupTextIndex
        .filter(
          (entry) =>
            entry.slideIndex === 0 &&
            entry.textKind === "shape" &&
            entry.nodePath.startsWith("slides/0/nodes/") &&
            !directNodeIds.has(entry.nodeId),
        )
        .map((entry) => ({
          nodeId: entry.nodeId,
          nodePath: entry.nodePath,
          text: entry.text,
          bounds: entry.bounds,
        })),
    });
    // 缓存写入放在元素构建成功之后，异常路径不会留下半成品。
    // 这里保存的数组与返回值是同一引用，后续调用方共享，不能再回头补写。
    // 改错故障：若提前 set 再填充，失败页会长期占据缓存并污染重试。
    this.elementCache.set(pageIndex, elements);
    return elements;
  }

  // 渲染前重复做 disposed 与越界校验，因为同一页允许在文档存续期内被多次渲染。
  // onNavigate 把上游 slideIndex 适配成 pageIndex 并透传 url，未提供时保持 undefined。
  // 不要用空函数占位，上游会据此判定「可导航」，从而吞掉自身的默认行为。
  // onNodeError 原样透传，节点级失败交由调用方决定是否降级展示。
  renderPage(
    pageIndex: number,
    container: HTMLElement,
    options?: PresentationRenderOptions,
  ): PresentationRenderHandle {
    if (this.disposed) {
      throw new Error("Presentation preview document has been disposed");
    }

    const slide = this.presentation.slides[pageIndex];
    if (!slide) {
      throw new RangeError(`Presentation page index is out of range: ${pageIndex}`);
    }

    const upstreamHandle: SlideHandle = renderSlide(this.presentation, slide, {
      onNavigate: options?.onNavigate
        ? (target: { slideIndex?: number; url?: string }) =>
            options.onNavigate?.({
              pageIndex: target.slideIndex,
              url: target.url,
            })
        : undefined,
      onNodeError: options?.onNodeError,
    });
    container.append(upstreamHandle.element);

    // 返回给调用方的句柄包装了上游句柄，释放时同时移除 DOM 并解绑登记。
    // 先置位再释放，避免上游释放过程抛错后重入导致二次释放；失败时不回滚位标。
    // 释放末尾从 activeHandles 删除自身，否则文档 dispose 会重复遍历已释放句柄。
    let handleDisposed = false;
    const handle: PresentationRenderHandle = {
      ready: upstreamHandle.ready,
      dispose: () => {
        if (handleDisposed) {
          return;
        }
        handleDisposed = true;
        upstreamHandle.dispose();
        upstreamHandle.element.remove();
        this.activeHandles.delete(handle);
      },
    };
    this.activeHandles.add(handle);
    return handle;
  }

  // 文档释放先置 disposed 阻断后续调用，再逐个释放存量句柄。
  // 末尾清空两个集合，切断对上游元素与页面模型的引用，让缓存可被回收。
  // 改错故障：不清理缓存时，整份演示文稿的节点树会随预览实例一起常驻。
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const handle of this.activeHandles) {
      handle.dispose();
    }
    this.activeHandles.clear();
    this.elementCache.clear();
  }
}

export const pptxRendererPreviewEngine: PresentationPreviewEngine = {
  // 对外只暴露一个引擎单例，UI 通过 PresentationPreviewEngine 契约调用 open。
  // 解析先套推荐 zip 上限，再以 lazySlides 构建，页内容留到真正取页时才展开。
  // 改错故障：关掉 lazySlides 或放宽 zip 上限，打开大文件会首屏全量解析并卡住界面。
  async open(data) {
    const files = await parseZipLazyMedia(data, RECOMMENDED_ZIP_LIMITS);
    const presentation = buildPresentation(files, { lazySlides: true });
    return new PptxRendererPreviewDocument(presentation);
  },
};
