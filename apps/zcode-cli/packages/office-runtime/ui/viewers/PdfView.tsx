// PDF 查看器（基于 pdf.js）：把文件字节渲染成可滚动的分页画布，并维护缩放、文字层、
// 选区上报、查找高亮与 Agent 标记。React 只负责外层滚动容器，页面、canvas、文字层和
// 链接层都在命令式代码里自建；对外副作用只经 props 回调（onPage/onZoom/onSelect 等），
// 本组件不持久化任何状态，也不直接访问网络。
// PDF 查看器：把 PDF 字节渲染成可滚动的分页画布，并维护缩放、文字层、选区与 Agent 标记
// 边界：只做渲染与交互编排，不负责文件读取解码、工具栏与快捷键，也不持久化跨会话状态
// 渲染全部由命令式代码完成，React 仅提供滚动容器，因此 DOM 生命周期必须在本文件内自洽
//
// INV-01 断言：slots 与 sizes 长度一致且下标恒为页码减一 —— 守住它的位置：加载效应里按页尺寸建占位节点 —— 改错故障：按索引取尺寸读到 undefined，整页白屏不渲染
// INV-02 断言：缩放倍率为 0 时一律跳过排版 —— 守住它的位置：缩放派生函数首行与布局效应的提前返回 —— 改错故障：用 0 倍率算出零宽高占位，文字层被挤成一条线
// INV-03 断言：缩放变化必须先自增代次再重设占位 —— 守住它的位置：布局效应里代次自增那一行 —— 改错故障：旧代画面回填到新尺寸槽位，出现撕裂与错位
// INV-04 断言：每次 await 之后都要复核渲染代次 —— 守住它的位置：单页绘制里的三处代次比较 —— 改错故障：缩放期间被取消的渲染仍挂上文字层，选区与高亮落在失效节点
// INV-05 断言：同一页只允许一个在途渲染 —— 守住它的位置：按页渲染入口的完成态缓存 —— 改错故障：观察者重复回调触发并发绘制，文字层被挂载两次
// INV-06 断言：交给 pdf.js 的字节必须是拷贝 —— 守住它的位置：取文档时的字节切片 —— 改错故障：pdf.js 转移底层缓冲区，调用方数据被清空，重开同一文件失败
// INV-07 断言：worker 全局单例且跨文档不销毁 —— 守住它的位置：模块级共享变量与空值合并赋值 —— 改错故障：销毁文档连带销毁 worker，换文件后新文档立刻失效
// INV-08 断言：卸载或换文件后所有回调都要被取消标志拦住 —— 守住它的位置：加载效应的取消标志与每个 await 后的判断 —— 改错故障：已卸载实例继续上报就绪，外部状态错乱
// INV-09 断言：文字层必须使用归一后的文字内容 —— 守住它的位置：单页绘制里对文字内容的包装 —— 改错故障：兼容区字符查找计数为零，Agent 引文定位失败
// INV-10 断言：Range 不能跨文字层复用 —— 守住它的位置：重挂标记时对已存范围做包含校验 —— 改错故障：重绘后高亮画不出来，却仍上报错误的定位框
// INV-11 断言：当前查找项必须从普通命中层剔除 —— 守住它的位置：统一重画时按引用过滤 —— 改错故障：当前项两层叠加变色，看起来像两处连续命中
// INV-12 断言：对外页码一律从 1 开始 —— 守住它的位置：定位器解析、目标解析的加一、截图页码校验 —— 改错故障：内部零基索引泄漏成页码，跳转整体偏一页
// INV-13 断言：越界页码抛错而不是回退 —— 守住它的位置：截图入口的范围检查 —— 改错故障：Agent 引用不存在的页被静默截到第一页，答案指向错误位置
// INV-14 断言：异步查找结果落地前必须校验身份 —— 守住它的位置：查找与查找跳转里的双重身份比较 —— 改错故障：旧查询结果覆盖新查询，跳到上一个关键词
// INV-15 断言：外链只走安全地址过滤 —— 守住它的位置：链接层里按过滤结果分支 —— 改错故障：脚本协议注释被当成普通链接点击，产生注入
// INV-16 断言：选区上报必须晚于浏览器更新选区 —— 守住它的位置：抬键与抬鼠标事件的零延时转发 —— 改错故障：读到上一轮选区，复制文本与高亮差一次操作
// INV-17 断言：容器尺寸变化小于一像素不上报 —— 守住它的位置：尺寸观察回调里的差值比较 —— 改错故障：亚像素抖动触发重排循环，滚动卡顿且中央处理器占满
// INV-18 断言：截图与缩略图必须白底填充 —— 守住它的位置：两处画布填充调用 —— 改错故障：透明底图片在深色主题下变黑块，Agent 截图不可读
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { parseLocator } from "#office/domain/anchor.ts";
import { normalizeCjkCompat } from "#office/domain/cjk.ts";
import { readBinary, readText } from "#ui/assets.ts";
import {
  boxOf,
  countMatches,
  pointOn,
  findAllRanges,
  findTextRange,
  paintRanges,
  safeExternalUrl,
  scrollToElement,
  scrollToRange,
  selectionIn,
  trackTopmost,
} from "#ui/dom.ts";
import { canvasToPng } from "#ui/raster.ts";
import {
  nextZoom,
  type FitMode,
  type RevealedTarget,
  type ViewerHandle,
  type ViewerProps,
} from "#ui/viewers/types.ts";

// pdf.js would fetch cMaps, fonts and wasm over the network; the sandbox has none, so read them
// through the plugin's MCP resources instead.
// CMap（中日韩等字符编码映射表）加载器。pdf.js 默认会按 cMapUrl 走网络 fetch，沙箱内没有
// 网络，因此改由插件资源入口 readBinary 读取随包分发的 .bcmap；字节恒为压缩格式。
class AssetCMapFactory {
  constructor(private readonly options: { baseUrl: string | null; isCompressed: boolean }) {}
  async fetch({ name }: { name: string }) {
    return {
      cMapData: await readBinary(`${this.options.baseUrl}${name}.bcmap`),
      isCompressed: true,
    };
  }
}
// 标准字体与 wasm 的二进制资源加载器，与 CMap 同理：按相对路径读本地资源，不发起网络请求。
// baseUrl 为 null 时直接拼接文件名（由打包目录结构决定）。
class AssetBinaryFactory {
  constructor(private readonly options: { baseUrl: string | null }) {}
  async fetch({ filename }: { filename: string }) {
    return readBinary(`${this.options.baseUrl}${filename}`);
  }
}

let sharedWorker: Promise<pdfjs.PDFWorker> | undefined;
/**
 * One pdf.js worker for the page's lifetime. Passed explicitly, so destroying a document (reload,
 * switching files) never tears down the worker the next document is about to use.
 */
function worker(): Promise<pdfjs.PDFWorker> {
  return (sharedWorker ??= readText("pdf-worker.js").then((source) => {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    return pdfjs.PDFWorker.create({ port: new Worker(url, { type: "module" }) });
  }));
}

type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

// 读取页面文字并把 CJK 兼容区/部首字符归一到常规汉字，使复制、选区引用、查找计数与
// Agent 引文定位都看到同一套字形；返回结构保持 pdf.js TextContent 原形，仅替换 items 的 str。
/** Page text with CJK radicals mapped back to ideographs (see src/domain/cjk.ts). */
async function pageTextContent(page: PDFPageProxy): Promise<TextContent> {
  const content = await page.getTextContent();
  return {
    ...content,
    items: content.items.map((item) =>
      "str" in item ? { ...item, str: normalizeCjkCompat(item.str) } : item,
    ),
  };
}

interface PageSlot {
  // 该页占位节点，宽高随缩放同步；dataset.at 固定为 `page:N`（N 从 1 开始）。
  element: HTMLDivElement;
  /** Resolves when the canvas and text layer of the current scale are in place. */
  done?: Promise<void>;
  // 当前进行中的渲染任务；缩放或卸载时用它取消上一次绘制，避免旧画面回填。
  task?: { cancel(): void };
  // 当前缩放下的文字层；未渲染完成、渲染被取消或已作废时为 undefined。
  textLayer?: HTMLDivElement;
}

/** Canvas padding and the gap between pages (CSS keeps these in step). */
const PADDING = 16;
/** pdf.js scale 1 is 72 dpi; "100%" means actual size at 96 CSS px per inch. */
const CSS_UNITS = 96 / 72;

interface Zoom {
  // 适配模式；为 null 表示按 percent（相对实际大小的百分比）自由缩放。
  mode: FitMode | null;
  /** Percent of actual size when mode is null. */
  percent: number;
}

// 一条 Agent 标记：页码区间 [page, to] 与可选引文。有 quote 时会在文字层里重新定位，
// 命中页可能不在区间首端，因此 page 是可变字段；无 quote 时按整页/页区间高亮。
interface RevealItem {
  // 命中（或起始）页码，1-based。
  page: number;
  // 区间末页，1-based；单页时等于 page。
  to: number;
  // Agent 给出原文引文；缺失表示按整页标记。
  quote?: string;
}

// PDF 查看器主体。输入：props.bytes（PDF 原始字节，会被拷贝后交给 pdf.js）、props.glance
// （内联卡片用的精简模式，只渲染前 4 页且默认双栏）；输出：通过 ref 暴露 ViewerHandle，
// 通过回调上报页码、缩放、选区、链接与错误。
// 副作用：创建 canvas/文字层 DOM、ObjectURL、共享 worker、IntersectionObserver，并调用 pdf.js 渲染。
// 不变量：slots.current 与 sizes.current 长度一致且下标 = 页码 - 1；缩放变化时 generation 自增，
// 旧代渲染结果一律丢弃，避免旧尺寸画面覆盖新画面。
// [契约] props.bytes 是唯一输入快照，内部不再复用其引用，调用方换文件只需换字节
// 组件不持有跨会话状态，缩放档位与滚动位置随实例销毁一起丢弃，重开需重新适配
// ref 暴露的命令句柄是唯一外部入口，调用方不得直接触碰槽位或画布节点
// 回调统一走 ref 转发，保证长生命周期副作用里读到的总是最新一次的 props
export const PdfView = forwardRef<ViewerHandle, ViewerProps>(function PdfView(props, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const slots = useRef<PageSlot[]>([]);
  const sizes = useRef<{ width: number; height: number }[]>([]);
  const [zoom, setZoom] = useState<Zoom>({ mode: "width", percent: 100 });
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [loaded, setLoaded] = useState(0);
  const callbacks = useRef(props);
  callbacks.current = props;
  const glance = Boolean(props.glance);

  // 缩放推导：先按“适宽”约束得到上限，再按“适页”取两者较小值；glance 预览且容器够宽时
  // 改为双栏排版，此时忽略用户缩放模式。
  // 未加载完成（loaded 为 0）或容器/页面尺寸未知时返回 0，调用方据此跳过排版，
  // 避免用 0 缩放渲染出空白页。
  // [契约] 缩放倍率是纯派生值，不落 state，避免缩放与容器尺寸互相触发重排死循环
  // 返回 0 是明确的未就绪信号，调用方据此跳过排版，而不是退化到某个默认倍率
  // 内联卡片模式强制适宽并忽略用户缩放模式，卡片本身不提供缩放交互
  // 上限钳到四倍，防止超宽页把画布撑过浏览器画布尺寸上限而静默失败
  const scale = (() => {
    if (!loaded || !box.width || !sizes.current.length) return 0;
    const maxWidth = Math.max(...sizes.current.map((size) => size.width));
    const maxHeight = Math.max(...sizes.current.map((size) => size.height));
    const columns = glance && box.width >= 520 ? 2 : 1;
    const fitWidth = Math.min(4, (box.width - PADDING * (columns + 1)) / columns / maxWidth);
    if (zoom.mode === "width" || glance) return fitWidth;
    if (zoom.mode === "page") return Math.min(fitWidth, (box.height - PADDING * 2) / maxHeight);
    if (zoom.mode === "actual") return CSS_UNITS;
    return (zoom.percent / 100) * CSS_UNITS;
  })();
  // [并发] 缩放引用每次渲染同步写入，供滚轮与布局效应等非 React 路径读取最新倍率
  // 不要改成从状态读取：滚轮回调里读状态会拿到上一轮值，连续滚动时缩放档位会丢
  // 前一轮倍率单独保存，只用于换算滚动比例，不能与当前倍率引用合并成一份
  // 三者的写入顺序固定为派生、同步、记录，改序会让首帧换算读到尚未更新的旧值
  const scaleRef = useRef(scale);
  const previousScale = useRef(0);
  scaleRef.current = scale;
  /** Point (in container coordinates) that should stay put across the next zoom change. */
  const zoomAnchor = useRef<{ x: number; y: number } | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  /** Bumped whenever pages are resized; a render from an older generation must not land. */
  const generation = useRef(0);

  // Decorations that must survive re-rendering a page (zoom replaces the text layers).
  const revealItems = useRef<RevealItem[]>([]);
  const revealRanges = useRef(new Map<number, Range>());
  const find = useRef<{
    query: string;
    matches: { page: number; k: number }[];
    current: number;
    ranges: Map<number, Range[]>;
  } | null>(null);
  const pageTexts = useRef<Promise<string>[]>([]);

  // 加载文档：拷贝字节（pdf.js 会转移底层 buffer，直接传 props 会污染调用方数据），
  // 逐页取 viewport(scale=1) 尺寸后重建占位节点，再通知 onPage/onReady。
  // 卸载或换文件时销毁文档并清空文字缓存；worker 是全局共享的，不在这里销毁。
  // Load the document.
  // [资源] 加载效应独占文档生命周期：创建文档与占位节点，卸载时统一回收
  // 依赖只有字节与内联卡片标志，改其他 props 不应重载，否则滚动位置会被清零
  // 字节拷贝必须同步完成，不要挪到 await 之后，pdf.js 会转移底层缓冲区
  // 逐页只按倍率一取原始尺寸，实际缩放统一由布局效应施加，两处不要重复缩放
  useEffect(() => {
    let cancelled = false;
    let loadedDoc: PDFDocumentProxy | null = null;
    (async () => {
      const task = pdfjs.getDocument({
        worker: await worker(),
        data: new Uint8Array(props.bytes.slice(0)),
        cMapUrl: "pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "pdfjs/standard_fonts/",
        wasmUrl: "pdfjs/wasm/",
        CMapReaderFactory: AssetCMapFactory,
        StandardFontDataFactory: AssetBinaryFactory,
        WasmFactory: AssetBinaryFactory,
        useWorkerFetch: false,
        isEvalSupported: false,
        enableXfa: false,
      });
      loadedDoc = await task.promise;
      // [失败路径] 文档已就绪但效应已取消时，必须就地销毁，不能让文档泄漏
      // 这里用返回收尾而不是抛错：取消是正常路径，不该触发错误回调让用户看到报错
      // 取页与取视口都可能比销毁更晚返回，每个 await 之后都要复查取消标志
      // 取消分支里不能再赋值文档引用，否则已卸载实例会留下悬空文档
      if (cancelled) return void loadedDoc.destroy();
      docRef.current = loadedDoc;
      const pageSizes: { width: number; height: number }[] = [];
      const count = glance ? Math.min(4, loadedDoc.numPages) : loadedDoc.numPages;
      for (let n = 1; n <= count; n++) {
        const page = await loadedDoc.getPage(n);
        const viewport = page.getViewport({ scale: 1 });
        pageSizes.push({ width: viewport.width, height: viewport.height });
      }
      if (cancelled) return;
      sizes.current = pageSizes;
      const container = scrollRef.current!;
      // [资源] 重建占位前先清空容器，否则换文件会残留上一份的页面节点
      // 槽位与页尺寸必须同步重建，长度不一致时按索引取尺寸会读到 undefined
      // 页面标记属性是对外定位器与滚动追踪的唯一契约，格式固定为 page 加页码
      // 此刻占位还没有画布，尺寸只由样式给出，真正绘制交给可见性观察者触发
      container.replaceChildren();
      slots.current = pageSizes.map((_, i) => {
        const element = document.createElement("div");
        element.className = "pdf-page";
        element.dataset.at = `page:${i + 1}`;
        container.append(element);
        return { element };
      });
      setBox({ width: container.clientWidth, height: container.clientHeight });
      setLoaded((value) => value + 1);
      callbacks.current.onPage?.({ current: 1, count: loadedDoc.numPages });
      callbacks.current.onReady();
    })().catch((error) => !cancelled && callbacks.current.onError(error));
    // [资源] 清理顺序是先断观察者再销毁文档，避免观察者回调访问已销毁的页
    // 纯文本缓存必须随文档一起清空，否则新文档会命中上一份文档的页文本
    // worker 刻意不在这里销毁，多文档共享同一 worker，销毁会切断下一次加载
    // 文档引用置空才算卸载完成，任何异步路径看到空值都应按未就绪处理
    return () => {
      cancelled = true;
      observer.current?.disconnect();
      void loadedDoc?.destroy();
      docRef.current = null;
      pageTexts.current = [];
    };
  }, [props.bytes, glance]);

  // 监听容器尺寸。只有宽高变化超过 1px 才更新状态，过滤亚像素抖动导致的重排循环。
  // Follow the pane size.
  useEffect(() => {
    const container = scrollRef.current!;
    const resize = new ResizeObserver(() =>
      setBox((previous) =>
        Math.abs(previous.width - container.clientWidth) > 1 ||
        Math.abs(previous.height - container.clientHeight) > 1
          ? { width: container.clientWidth, height: container.clientHeight }
          : previous,
      ),
    );
    resize.observe(container);
    return () => resize.disconnect();
  }, []);

  // 上报实际生效的缩放百分比，按 96/72 的 CSS 单位换算，供工具栏显示。
  // Report the zoom the control shows.
  useEffect(() => {
    if (!scale) return;
    callbacks.current.onZoom?.({
      mode: zoom.mode,
      percent: Math.round((scale / CSS_UNITS) * 100),
    });
  }, [scale, zoom.mode]);

  // 缩放/尺寸生效时：generation 自增作废旧渲染、取消在途任务、按新缩放重设占位尺寸，
  // 再按比例平移滚动位置让锚点保持不动（锚点默认为视口中心）。
  // 最后重建 IntersectionObserver，仅渲染视口前后 600px 内的页面。
  // Size page placeholders, keep the anchor point in place, render what is visible.
  // [并发] 该布局效应是缩放落地的唯一入口：作废旧代、重设尺寸、恢复锚点、重建观察者
  // 顺序不可调换：先自增代次再取消任务，否则取消回调里可能判定自己仍然有效
  // 锚点默认取视口中心，滚轮缩放会事先写入指针坐标把它覆盖掉
  // 依赖只有倍率，容器尺寸经倍率派生间接生效，显式加尺寸会多触发一次重排
  useLayoutEffect(() => {
    const doc = docRef.current;
    const container = scrollRef.current;
    if (!doc || !scale || !container) return;
    const before = previousScale.current;
    previousScale.current = scale;
    const anchor = zoomAnchor.current ?? {
      x: container.clientWidth / 2,
      y: container.clientHeight / 2,
    };
    zoomAnchor.current = null;
    const fraction = {
      x: container.scrollLeft + anchor.x,
      y: container.scrollTop + anchor.y,
    };
    observer.current?.disconnect();
    generation.current++;
    for (const [i, slot] of slots.current.entries()) {
      // [资源] 取消在途任务并清空完成态与文字层，让再次进入视口时重新完整绘制
      // 只清空不取消不够：旧任务仍会往已换成新尺寸的画布上写像素
      // 标记范围与查找范围必须同时清空，它们绑定的文字层马上要被替换
      // 占位尺寸按原始尺寸乘新倍率重设，不要用画布宽度反推，那里还带着设备像素比
      slot.task?.cancel();
      slot.done = undefined;
      slot.textLayer = undefined;
      slot.element.replaceChildren();
      slot.element.style.width = `${sizes.current[i].width * scale}px`;
      slot.element.style.height = `${sizes.current[i].height * scale}px`;
    }
    revealRanges.current.clear();
    find.current?.ranges.clear();
    paint();
    // [权衡] 滚动位置按倍率比例换算而非保持像素偏移，缩放后视觉内容才不会整体跳走
    // 先减去内边距再乘比例再加回，页间留白不参与缩放，否则页间距会随缩放胀缩
    // 首次排版时前一轮倍率为零，跳过换算，否则会把初始位置算成负值弹回顶部
    // 换算只做一次，不要逐页处理，每页都改滚动会叠加出累计偏移
    if (before && before !== scale) {
      const ratio = scale / before;
      container.scrollTo({
        left: Math.max(0, (fraction.x - PADDING) * ratio + PADDING - anchor.x),
        top: Math.max(0, (fraction.y - PADDING) * ratio + PADDING - anchor.y),
      });
    }
    observer.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = slots.current.findIndex((slot) => slot.element === entry.target);
          if (index >= 0) void renderPage(index);
        }
      },
      { root: container, rootMargin: "600px 0px" },
    );
    for (const slot of slots.current) observer.current.observe(slot.element);
  }, [scale]);

  // 同一页只渲染一次：已有 done 就复用，避免 IntersectionObserver 重复回调时并发绘制同一页。
  // [并发] 完成态缓存是幂等闸门，同一页的重复请求共享同一次绘制
  // 不要在这里再判可见性：调用方已按需触发，二次判断会让恢复路径永远拿不到页
  // 返回 Promise 而不是空值，等待方才能真正等到文字层可用之后再定位
  // 槽位不存在时返回已完成的任务，避免调用方拿到空值后继续链式等待
  function renderPage(index: number): Promise<void> {
    const slot = slots.current[index];
    if (!slot) return Promise.resolve();
    return (slot.done ??= draw(index, slot));
  }

  // 绘制单页：取页对象后先校验 generation，缩放期间被替换的渲染直接放弃（不写 DOM、不挂文字层）；
  // 顺序为 canvas → 文字层 → 链接层 → 重新挂载标记。RenderingCancelledException 属于正常取消，不告警。
  // [并发] 渲染代次是本次绘制的身份，任何 await 之后都要用它判断是否已被新代取代
  // [资源] 画布按设备像素比放大，样式尺寸保持逻辑像素，避免高分屏下文字发虚
  // 三层结构固定为画布、文字层、链接层，顺序决定层级，交换会让链接被文字盖住
  // 先替换子节点再开始绘制，旧画布必须在下笔前脱离文档，否则会与新画面叠影
  async function draw(index: number, slot: PageSlot) {
    const doc = docRef.current;
    if (!doc) return;
    const currentScale = scaleRef.current;
    const mine = generation.current;
    const page = await doc.getPage(index + 1);
    // The pane was resized while the page loaded: a newer render owns this slot now.
    if (generation.current !== mine) return;
    const viewport = page.getViewport({ scale: currentScale });
    const ratio = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    const links = document.createElement("div");
    links.className = "pdf-links";
    slot.element.style.setProperty("--scale-factor", String(currentScale));
    slot.element.style.setProperty("--user-unit", "1");
    slot.element.style.setProperty("--total-scale-factor", String(currentScale));
    slot.element.replaceChildren(canvas, textLayer, links);
    const task = page.render({
      canvas,
      canvasContext: canvas.getContext("2d")!,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
    });
    slot.task = task;
    // [失败路径] 只静默取消异常，其余渲染错误留痕，便于定位具体坏页
    // 这里不能向上抛：单页失败不应中断整篇，其他页仍需可读
    // 渲染任务必须在 await 之前挂到槽位上，否则后续取消永远命中不到它
    // 失败只影响当前页，下一次缩放会自增代次并重新触发绘制覆盖掉旧结果
    try {
      await task.promise;
      if (generation.current !== mine) return;
      // 文字层用归一后的文字：复制、选区引用、查找与 Agent 引文定位都要看到“文”而不是“⽂”。
      const content = await pageTextContent(page);
      if (generation.current !== mine) return;
      const text = new pdfjs.TextLayer({
        textContentSource: content,
        container: textLayer,
        viewport,
      });
      await text.render();
      if (generation.current !== mine || !textLayer.isConnected) return;
      slot.textLayer = textLayer;
      await addLinks(page, viewport, links);
      decorate(index + 1);
    } catch (error) {
      if ((error as Error)?.name !== "RenderingCancelledException")
        console.warn("pdf render", error);
    }
  }

  // 把 PDF 的 Link 注释转成覆盖层 <a>：有安全外链则回调 onLink；没有外链但有内部目标时
  // 解析为页码后滚动；两者都没有则跳过（不可点击的装饰性注释）。
  // safeExternalUrl 会过滤 javascript: 等危险协议，返回 null 时按内部跳转处理。
  // [契约] 链接层只处理链接类型的注释，其余类型一律跳过，避免误加可点区域
  // 每次重绘都重建链接层，不能复用旧节点，旧坐标随缩放已经失效
  // 点击时同时阻止默认行为与冒泡，否则会连带触发选区清理逻辑
  // 节点坐标用视口矩形换算后取左上角与绝对宽高，负的宽高必须先归一
  async function addLinks(
    page: PDFPageProxy,
    viewport: ReturnType<PDFPageProxy["getViewport"]>,
    layer: HTMLDivElement,
  ) {
    const annotations = await page.getAnnotations({ intent: "display" });
    for (const annotation of annotations) {
      if (annotation.subtype !== "Link") continue;
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annotation.rect);
      const link = document.createElement("a");
      link.className = "pdf-link";
      link.style.left = `${Math.min(x1, x2)}px`;
      link.style.top = `${Math.min(y1, y2)}px`;
      link.style.width = `${Math.abs(x2 - x1)}px`;
      link.style.height = `${Math.abs(y2 - y1)}px`;
      // [契约] 未过滤地址是 pdf.js 保留的原始值，只有经过安全过滤后才可信
      // 过滤结果为空不代表没有链接：若带内部目标则降级为页内跳转
      // 两者皆无时直接跳过，不要留下可聚焦却毫无行为的空链接
      // 外链只回调宿主去打开，组件本身不发起跳转也不访问网络
      const url = safeExternalUrl(annotation.url ?? annotation.unsafeUrl);
      if (url) {
        link.title = url;
        link.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          callbacks.current.onLink(url);
        });
      } else if (annotation.dest) {
        link.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          const target = await resolveDest(annotation.dest);
          if (target) scrollToPage(target);
        });
      } else continue;
      layer.append(link);
    }
  }

  // 把命名目标或显式目标解析成 1-based 页码；无法解析（含文档未加载）返回 null，调用方保持原位。
  async function resolveDest(dest: unknown): Promise<number | null> {
    const doc = docRef.current;
    if (!doc) return null;
    const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    const target = Array.isArray(explicit) ? explicit[0] : null;
    if (target && typeof target === "object") return (await doc.getPageIndex(target)) + 1;
    return typeof target === "number" ? target + 1 : null;
  }

  function scrollToPage(page: number) {
    const slot = slots.current[page - 1];
    if (slot) scrollToElement(slot.element, "start");
  }

  // 等待文字层就绪：缩放可能在等待期间开启新一轮渲染，因此最多重试 5 次；仍未就绪返回 null，
  // 调用方需容忍「页面存在但文字层不可用」的情况（例如引文定位失败退回整页）。
  /** Page `n` with its text layer for the current scale (null if it does not exist). */
  // [失败路径] 最多重试五次就放弃，避免持续缩放时无限等待
  // 返回空值表示页面存在但文字层不可用，调用方必须退回整页高亮
  // 重试之间不加延时：每次调用都会复用或重启渲染，延时只会拖慢定位
  // 判定条件是文字层已挂载且仍在文档中，仅判非空不够，旧层会被误判成可用
  async function rendered(n: number): Promise<PageSlot | null> {
    const slot = slots.current[n - 1];
    if (!slot) return null;
    // A resize while waiting starts a fresh render; wait for that one too.
    for (let attempt = 0; attempt < 5; attempt++) {
      await renderPage(n - 1);
      if (slot.textLayer?.isConnected) return slot;
    }
    return null;
  }

  // 页面重绘后重新挂载标记与查找结果：Range 绑定在旧的文字层节点上，重绘后必须重新查找，
  // 否则高亮画不出来；找不到引文时从映射中移除，避免留下空洞。
  /** Re-attach reveal and find highlights to a freshly rendered page. */
  // [并发] 只在文字层就绪时挂标记，未就绪直接返回，等下一次绘制再补
  // 找不到引文时从映射中删除而不是保留旧范围，否则会画到已脱离文档的节点
  // 查找结果每页只存一份，重绘后整页重算，局部补算会漏掉新增的文字节点
  // 最后统一重画一次高亮，不要在循环里逐条绘制，那会反复清空同一层
  function decorate(page: number) {
    const slot = slots.current[page - 1];
    if (!slot?.textLayer) return;
    revealItems.current.forEach((item, i) => {
      if (!item.quote || item.page !== page) return;
      // Always re-find on the live layer: a range on a replaced layer would paint nothing.
      const current = revealRanges.current.get(i);
      if (current && slot.textLayer!.contains(current.startContainer)) return;
      const range = findTextRange(slot.textLayer!, item.quote);
      if (range) revealRanges.current.set(i, range);
      else revealRanges.current.delete(i);
    });
    if (find.current?.query)
      find.current.ranges.set(page, findAllRanges(slot.textLayer, find.current.query));
    paint();
  }

  // 当前查找项对应的 Range：页码或序号越界（例如页面尚未建 Range）时返回 null，
  // 上层据此退化为滚动到该页。
  function currentFindRange(): Range | null {
    const state = find.current;
    const match = state?.matches[state.current];
    if (!state || !match) return null;
    const ranges = state.ranges.get(match.page) ?? [];
    return ranges[Math.min(match.k, ranges.length - 1)] ?? null;
  }

  // 统一重画三层高亮：Agent 标记、普通查找命中、当前命中；当前项从普通层剔除以免叠色。
  // [权衡] 三层分开绘制：Agent 标记、普通命中、当前命中，各自使用独立样式名
  // 当前项要从普通层剔除，否则同一段落两层叠色，看起来像两处连续命中
  // 重画是纯渲染动作，不负责查找，把它当刷新入口会重复解析整篇文本
  // 顺序固定为标记、普通、当前，后画的在上层，当前项才不会被普通命中盖住
  function paint() {
    paintRanges("office-reveal", [...revealRanges.current.values()]);
    const current = currentFindRange();
    paintRanges(
      "office-find",
      [...(find.current?.ranges.values() ?? [])].flat().filter((range) => range !== current),
    );
    paintRanges("office-find-current", current ? [current] : []);
  }

  // 每页纯文本按需缓存（缓存的是 Promise，重复调用不会重复解析）；
  // 解析失败降级为空串，只影响该页的查找计数，不阻断整体查找。
  function pageText(n: number): Promise<string> {
    const doc = docRef.current;
    if (!doc) return Promise.resolve("");
    return (pageTexts.current[n - 1] ??= doc
      .getPage(n)
      .then(pageTextContent)
      .then((content) => content.items.map((item) => ("str" in item ? item.str : "")).join(" "))
      .catch(() => ""));
  }

  // 可见位置追踪：以 1/3 视口高判定顶部页，回调 onLocation 与 onPage（页码从 `page:N` 解析）。
  // Visible page tracking.
  useEffect(() => {
    const container = scrollRef.current!;
    return trackTopmost(
      container,
      () => slots.current.map((slot) => slot.element),
      (element) => element.dataset.at ?? null,
      (at) => {
        callbacks.current.onLocation(at);
        callbacks.current.onPage?.({
          current: Number(at.slice(5)),
          count: docRef.current?.numPages ?? slots.current.length,
        });
      },
      1 / 3,
    );
  }, []);

  // 滚轮缩放累积 deltaY 达 40 才换一档，避免触控板轻微滑动就跳档；锚点取指针在容器内的坐标。
  // ⌘/Ctrl + wheel zooms around the pointer, like ZCode's PDF preview.
  useEffect(() => {
    const container = scrollRef.current!;
    let accumulated = 0;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      accumulated += event.deltaY;
      if (Math.abs(accumulated) < 40) return;
      const direction = accumulated < 0 ? 1 : -1;
      accumulated = 0;
      const rect = container.getBoundingClientRect();
      zoomAnchor.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      stepZoom(direction);
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  function stepZoom(direction: 1 | -1) {
    const percent = Math.round((scaleRef.current / CSS_UNITS) * 100);
    setZoom({ mode: null, percent: nextZoom(percent, direction) });
  }

  // 选区上报：有文字选区时上报（跨页则合并成 `page:a-b` 区间）；没有选区时处理页内点击——
  // 命中 Agent 标记则回放其注释，点链接忽略，点页面空白处选中整页，点文字或页外清空。
  // mouseup/keyup 延迟一拍执行，等浏览器先更新完 DOM 选区。
  // Selection: text selection inside pages, or a click on a page outside its text.
  useEffect(() => {
    const container = scrollRef.current!;
    // [契约] 选区端点必须能回溯到页容器，跨页时用起止页码拼成区间定位
    // 只有起点落在页内才上报，起点在页外时选区不可归属，直接放弃
    // 克隆范围再交给回调，延迟使用时原选区可能已被浏览器合并或清空
    // 页码必须从页面标记属性解析，不能靠节点序号推导，重排会让序号失真
    const pageOf = (node: Node | null) =>
      (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>(".pdf-page")
        ?.dataset.at;
    const clearPage = () =>
      container
        .querySelectorAll(".pdf-page.selected")
        .forEach((element) => element.classList.remove("selected"));
    const report = (event: Event) => {
      const selected = selectionIn(container);
      if (selected) {
        const start = pageOf(selected.range.startContainer);
        const end = pageOf(selected.range.endContainer);
        if (!start) return;
        clearPage();
        const a = Number(start.slice(5));
        const b = end ? Number(end.slice(5)) : a;
        const range = selected.range.cloneRange();
        callbacks.current.onSelect(
          { at: b > a ? `page:${a}-${b}` : start, text: selected.text },
          { text: true, locate: () => boxOf(range), user: true },
        );
        return;
      }
      if (event.type !== "mouseup") return;
      // A click on one of the agent's marks brings its note back instead of selecting.
      const { clientX, clientY } = event as MouseEvent;
      for (const [i, range] of revealRanges.current)
        if (pointOn(range, clientX, clientY) && callbacks.current.onRevealHit?.(i)) {
          clearPage();
          callbacks.current.onSelect(null);
          return;
        }
      const target = event.target as Element;
      if (target.closest(".pdf-link")) return;
      const page = target.closest<HTMLElement>(".pdf-page");
      clearPage();
      // A click on text (no drag) or outside the pages clears the selection.
      if (!page?.dataset.at || target.closest(".textLayer span")) {
        callbacks.current.onSelect(null);
        return;
      }
      page.classList.add("selected");
      callbacks.current.onSelect(
        { at: page.dataset.at, text: "" },
        { text: false, locate: () => boxOf(page), user: true },
      );
    };
    const onUp = (event: Event) => setTimeout(() => report(event), 0);
    container.addEventListener("mouseup", onUp);
    container.addEventListener("keyup", onUp);
    return () => {
      container.removeEventListener("mouseup", onUp);
      container.removeEventListener("keyup", onUp);
    };
  }, []);

  // 命令式接口：reveal 解析 `page:N[-M]` 定位器并按引文在文字层内定位；capture 直接以目标
  // 缩放重绘该页导出 PNG（白底，避免透明背景）；find 先逐页计数再在已渲染页建 Range。
  // 对外页码一律 1-based，未加载完成的操作按各自约定抛错或静默返回。
  // [契约] 命令接口是 Agent 与工具栏的唯一通道，所有方法都按从 1 开始的页码工作
  // 空依赖数组意味着闭包捕获首帧函数，内部一律通过引用读取最新状态
  // 未加载完成时按方法约定区分：截图类抛错，其余静默返回
  // 每个方法自行清理自己的副作用，调用方不需要成对调用清除系列
  useImperativeHandle(
    ref,
    (): ViewerHandle => ({
      async reveal(targets) {
        this.clearReveal();
        const items: RevealItem[] = [];
        for (const target of targets) {
          const locator = parseLocator("pdf", target.at);
          if (locator.kind !== "pdf" || !slots.current[locator.from - 1]) continue;
          items.push({
            page: locator.from,
            to: locator.to,
            ...(target.quote ? { quote: target.quote } : {}),
          });
        }
        revealItems.current = items;
        // Quotes may sit on any page of a range: find the page that has it.
        // [契约] 引文可能落在区间内任意一页，命中后要把页码改成实际命中页
        // 页码字段可变是刻意设计，定位框与滚动都以真实命中页为准
        // 循环内要等待文字层就绪，不能只看可见页，区间外的页可能尚未渲染
        // 找不到引文时保留原页并退回整页高亮，不要清空标记让用户以为定位失效
        for (const [i, item] of items.entries()) {
          if (!item.quote) {
            for (let n = item.page; n <= item.to; n++)
              slots.current[n - 1]?.element.classList.add("revealed");
            continue;
          }
          for (let n = item.page; n <= item.to; n++) {
            const slot = await rendered(n);
            const range = slot?.textLayer && findTextRange(slot.textLayer, item.quote);
            if (range) {
              item.page = n;
              revealRanges.current.set(i, range);
              break;
            }
          }
        }
        paint();
        const results: RevealedTarget[] = items.map((item, i) => ({
          at:
            item.to > item.page && !item.quote
              ? `page:${item.page}-${item.to}`
              : `page:${item.page}`,
          locate: () =>
            boxOf(revealRanges.current.get(i)) ?? boxOf(slots.current[item.page - 1]?.element),
          scrollTo: () => {
            const range = revealRanges.current.get(i);
            if (range?.startContainer.isConnected) scrollToRange(range, "upper");
            else if (item.quote)
              void rendered(item.page).then(() => {
                decorate(item.page);
                const again = revealRanges.current.get(i);
                if (again) scrollToRange(again, "upper");
                else scrollToPage(item.page);
              });
            else scrollToPage(item.page);
          },
        }));
        results[0]?.scrollTo();
        return results;
      },
      goTo(at) {
        const locator = parseLocator("pdf", at);
        if (locator.kind === "pdf") scrollToPage(locator.from);
      },
      clearReveal() {
        revealItems.current = [];
        revealRanges.current.clear();
        scrollRef.current
          ?.querySelectorAll(".pdf-page.revealed")
          .forEach((element) => element.classList.remove("revealed"));
        paint();
      },
      async capture(at, maxWidth) {
        const doc = docRef.current;
        if (!doc) throw new Error("The PDF is still loading.");
        const page = at ? parseLocator("pdf", at) : null;
        const number =
          page?.kind === "pdf"
            ? page.from
            : Number(
                (
                  slots.current.find(
                    (slot) =>
                      slot.element.getBoundingClientRect().bottom >
                      scrollRef.current!.getBoundingClientRect().top + 8,
                  )?.element.dataset.at ?? "page:1"
                ).slice(5),
              );
        // 页码越界直接抛错而不是回退到第 1 页：让 Agent 发现自己引用了不存在的页。
        if (number < 1 || number > doc.numPages)
          throw new Error(`Page ${number} does not exist; the PDF has ${doc.numPages} pages.`);
        const pdfPage = await doc.getPage(number);
        const base = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: Math.min(3, maxWidth / base.width) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
        return { ...canvasToPng(canvas, maxWidth), at: `page:${number}` };
      },
      zoom(direction) {
        stepZoom(direction);
      },
      fit(mode) {
        setZoom({ mode, percent: 100 });
      },
      // [并发] 查找状态是本次查询的身份凭证，await 之后必须确认它仍是当前查找
      // 逐页计数走全量文本，范围只对已渲染页建立，两者覆盖范围不同不能合并
      // 空查询按清除处理并返回零，调用方无需区分没找到与没查过
      // 计数用归一后的文本，与文字层同源，否则会出现计数为零而文字可见
      async find(query) {
        // 空查询视为清除查找，返回 0 而不是抛错，便于调用方统一处理。
        const doc = docRef.current;
        if (!doc || !query.trim()) {
          this.clearFind();
          return 0;
        }
        // 用局部 state 承载这次查找；异步返回后若 find.current 已不是它，说明被新查询覆盖，丢弃结果。
        const state = {
          query,
          matches: [] as { page: number; k: number }[],
          current: -1,
          ranges: new Map<number, Range[]>(),
        };
        find.current = state;
        const counts = await Promise.all(
          Array.from({ length: doc.numPages }, (_, i) =>
            pageText(i + 1).then((text) => countMatches(text, query)),
          ),
        );
        if (find.current !== state) return 0;
        counts.forEach((count, i) => {
          for (let k = 0; k < count; k++) state.matches.push({ page: i + 1, k });
        });
        for (const [i, slot] of slots.current.entries())
          if (slot.textLayer) state.ranges.set(i + 1, findAllRanges(slot.textLayer, query));
        paint();
        return state.matches.length;
      },
      findGo(index) {
        const state = find.current;
        const match = state?.matches[index];
        if (!state || !match) return;
        state.current = index;
        void rendered(match.page).then(() => {
          // 等待期间可能被新的 find/clearFind 覆盖，回调前再校验一次 state 与序号身份。
          if (find.current !== state || state.current !== index) return;
          if (!state.ranges.has(match.page)) decorate(match.page);
          paint();
          const range = currentFindRange();
          if (range) scrollToRange(range, "center");
          else scrollToPage(match.page);
        });
        paint();
      },
      clearFind() {
        find.current = null;
        paint();
      },
      clearSelection() {
        scrollRef.current
          ?.querySelectorAll(".pdf-page.selected")
          .forEach((element) => element.classList.remove("selected"));
        const selection = document.getSelection();
        if (selection && scrollRef.current && selectionIn(scrollRef.current))
          selection.removeAllRanges();
      },
      // 页码钳制到现有页范围，越界值不会访问到 slots 之外。
      goToPage(page) {
        scrollToPage(Math.min(Math.max(1, page), slots.current.length));
      },
      // 生成缩略图 canvas：按 devicePixelRatio 提升清晰度，白底填充避免透明 PNG 在深色主题下发灰；
      // 返回的 canvas 由调用方持有，本组件不缓存。
      async thumbnail(page, width) {
        const doc = docRef.current;
        if (!doc) throw new Error("The PDF is still loading.");
        const pdfPage = await doc.getPage(page);
        const base = pdfPage.getViewport({ scale: 1 });
        const ratio = window.devicePixelRatio || 1;
        const viewport = pdfPage.getViewport({ scale: (width / base.width) * ratio });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${(viewport.height / viewport.width) * width}px`;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
        return canvas;
      },
    }),
    [],
  );

  return <div ref={scrollRef} className={`viewer-scroll pdf-scroll${glance ? " glance" : ""}`} />;
});
