"use client";

// PDF 单页预览视图：把 pdf.js 的文档加载、range 按需传输、页码与双倍率缩放收拢到一个受控组件里。
// 只负责「显示当前页 + 翻页与缩放手势」；不负责 PDF 生成、上传、内容校验与访问权限判定。
// 也不持久化页码与缩放倍率——文档切换会整体重置，调用方不应依赖组件内状态跨文档存活。
//
// 不变量（每条都对应一类线上可见故障，改代码前先逐条确认仍成立）：
// INV-01 断言：worker 地址必须在任何 Document 渲染前于模块顶层赋值 —— 守住它的位置：模块顶层 pdfjs.GlobalWorkerOptions.workerSrc —— 改错故障：首屏一直停在加载文案，控制台报 worker 资源取不到
// INV-02 断言：range 分段字节数必须与 service 层 readFileRange 的默认分段一致 —— 守住它的位置：RANGE_CHUNK_BYTES 与 RANGE_DOCUMENT_OPTIONS 的 rangeChunkSize —— 改错故障：一次分段被拆成多次 RPC，翻页明显变慢
// INV-03 断言：两种 Document options 必须是引用稳定的模块级常量 —— 守住它的位置：DOCUMENT_OPTIONS 与 RANGE_DOCUMENT_OPTIONS —— 改错故障：每次渲染都重新加载文档，页码被打回第一页
// INV-04 断言：requestDataRange 的 length 是 end 减 begin 而不是 end —— 守住它的位置：PdfViewerRangeTransport.requestDataRange —— 改错故障：区间偏移错位，pdf.js 解析失败或长时间空白
// INV-05 断言：range 请求失败必须经 onRequestError 上抛 —— 守住它的位置：requestDataRange 的 catch 分支 —— 改错故障：失败被吞，文档永远停在加载态且没有错误提示
// INV-06 断言：ArrayBuffer 输入必须先复制再交给 pdf.js —— 守住它的位置：normalizePdfSource 的 ArrayBuffer 分支 —— 改错故障：原 buffer 被 worker transfer 后 detached，复用同一份数据直接抛错
// INV-07 断言：source 的引用变化是文档重置的唯一触发点 —— 守住它的位置：rangeTransport 与 file 的 useMemo 依赖 —— 改错故障：父组件内联构造 source 时反复重置页码与缩放
// INV-08 断言：手势期间只更新 displayScale，停顿后才提交 renderScale —— 守住它的位置：zoomTo 与提交定时器 effect —— 改错故障：每次滚轮都重排 canvas，缩放卡顿并闪烁
// INV-09 断言：提交 renderScale 之前必须先 stageZoomOverlay 留存旧位图 —— 守住它的位置：提交定时器回调开头 —— 改错故障：新 canvas 未绘制完成时出现一帧空白
// INV-10 断言：晚到的旧渲染回调必须按倍率比对丢弃 —— 守住它的位置：handlePageRenderSuccess 的 0.001 容差判断 —— 改错故障：旧回调提前清掉覆盖层，缩放后露出半张旧图
// INV-11 断言：文档切换或卸载时必须 abort 未完成的 range 传输 —— 守住它的位置：rangeTransport 的 effect cleanup —— 改错故障：旧文档的挂起请求继续占用连接，新文档加载排队
// INV-12 断言：页码必须夹紧在 1 与 numPages 之间 —— 守住它的位置：goToPage 的 clamped 计算 —— 改错故障：输入 0 或超大页码后 Page 抛错，整块视图空白
// INV-13 断言：滚轮缩放监听必须以 passive 为 false 的原生方式挂载 —— 守住它的位置：wheel effect 的 addEventListener —— 改错故障：preventDefault 失效，缩放时页面同时滚动
// INV-14 断言：缩放锚点必须在 layout 阶段消费并立即清空 —— 守住它的位置：useLayoutEffect 与 pendingZoomAnchorRef —— 改错故障：锚点晚一帧校正，指针下的内容点抖动
//
// 本文件只以「新增整行注释」方式维护，不改动任何既有 token；正文块与 INV 表共同构成改动检查清单。
import type { HTMLAttributes, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/TextLayer.css";
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import * as pdfZoom from "@/components/ui/usePdfZoomOverlay.js";
import { isAppleKeyboardPlatform } from "@/lib/keyboardShortcuts.js";
import { createPdfJsDocumentOptions } from "@/lib/pdfJsAssets.js";

// [契约] worker 必须在模块求值阶段绑定，此时还没有任何 Document 实例
// 放进组件 effect 会被首次渲染抢先，首屏要么走主线程解析要么直接报错
// workerSrc 由打包器以 ?url 产出为独立资源，路径随部署基址变化，不要手写字符串
// Desktop 的 file:// 与 Web 子路径部署共用这一份赋值，改一处即全局生效
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

// 与 service 层 readFileRange 的默认分段大小对齐，一次 range 请求对应一次 RPC 调用。
// `RANGE_CHUNK_BYTES` 同时喂给 pdf.js 的 `rangeChunkSize`，两处不同步会让预取范围与请求粒度错配。
// 调小会让翻页时 RPC 次数成倍增加，调大则首个分段到达更慢、首屏更迟
// 该值同时喂给 pdf.js 的 rangeChunkSize，两处必须同步修改，否则预取范围与请求粒度错配
// 不要改成按文件大小动态计算——那会让 options 引用不再稳定，文档反复重载
const RANGE_CHUNK_BYTES = 256 * 1024;

// ReportLab 的 STSong-Light 等 Type0 字体只声明预定义 CMap，PDF 内并未嵌入
// 字符映射；浏览器原生 PDF 预览自带该资源，而 PDF.js 必须显式传入 cMapUrl。
// 使用 Vite base 解析，Desktop 的 file:// 与 Web/手机远控的子路径部署都读取各自静态资源。
// [权衡] cMap 与标准字体资源必须显式给 URL：ReportLab 的 STSong-Light 只声明预定义 CMap
// PDF 内并未嵌入字符映射，缺了它中文会渲染成空白或乱码，而浏览器原生预览自带该资源
// 基址取 import.meta.env.BASE_URL 并以 location.href 兜底，同时兼容 file:// 与子路径部署
// 求值放在模块顶层，保证引用恒定，避免 react-pdf 把每次渲染当成换文档
const DOCUMENT_OPTIONS = createPdfJsDocumentOptions(
  typeof import.meta.env?.BASE_URL === "string" ? import.meta.env.BASE_URL : "./",
  globalThis.location?.href ?? "http://localhost/",
);

// range 模式关闭整档预取与流式加载，保持“只拉需要的页”；模块级常量保证引用稳定，
// 避免 react-pdf 因 options 引用变化重新加载文档。
const RANGE_DOCUMENT_OPTIONS = {
  ...DOCUMENT_OPTIONS,
  disableAutoFetch: true,
  disableStream: true,
  rangeChunkSize: RANGE_CHUNK_BYTES,
};

export interface PdfViewerRangeSource {
  totalBytes: number;
  initialData?: Uint8Array;
  requestRange: (offset: number, length: number) => Promise<Uint8Array>;
}

export type PdfViewerSource = string | Blob | ArrayBuffer | Uint8Array | PdfViewerRangeSource;

function isPdfViewerRangeSource(source: PdfViewerSource): source is PdfViewerRangeSource {
  return (
    typeof source === "object" &&
    source !== null &&
    "requestRange" in source &&
    typeof (source as PdfViewerRangeSource).requestRange === "function"
  );
}

// [资源] 这个子类只做一件事：把 pdf.js 的区间请求转给调用方的 requestRange
// 分页、缓存、并发上限都由 pdfjs.PDFDataRangeTransport 基类负责，不要在这里重写
// 也不要在子类里自建分段缓存：基类已维护已请求区间，重复缓存让 abort 后的状态难以收敛
// 构造时传入 totalBytes 与 initialData，首屏可省掉第一个 range 请求
class PdfViewerRangeTransport extends pdfjs.PDFDataRangeTransport {
  private readonly rangeSource: PdfViewerRangeSource;
  private readonly onRequestError: (error: Error) => void;

  constructor(rangeSource: PdfViewerRangeSource, onRequestError: (error: Error) => void) {
    super(rangeSource.totalBytes, rangeSource.initialData ?? null);
    this.rangeSource = rangeSource;
    this.onRequestError = onRequestError;
  }

  // [契约] length 是 end 减 begin，直接传 end 会让请求长度翻倍并越过文件末尾
  // 症状是 pdf.js 反复重试或长时间停在加载骨架，而不是立刻报错
  // then 与 catch 两条路径都必须收敛：成功走 onDataRange，失败走 onRequestError
  // 捕获分支要把非 Error 的抛出物包成 Error，否则上层拿不到可读信息
  override requestDataRange(begin: number, end: number): void {
    this.rangeSource
      .requestRange(begin, end - begin)
      .then((chunk) => {
        this.onDataRange(begin, chunk);
      })
      .catch((error: unknown) => {
        this.onRequestError(error instanceof Error ? error : new Error(String(error)));
      });
  }
}

export interface PdfViewerLabels {
  loading: string;
  loadError: string;
  noData: string;
  previousPage: string;
  nextPage: string;
  pageInput: string;
  zoomIn: string;
  zoomOut: string;
}

const DEFAULT_LABELS: PdfViewerLabels = {
  loading: "Loading PDF…",
  loadError: "Failed to load PDF",
  noData: "No PDF data",
  previousPage: "Previous page",
  nextPage: "Next page",
  pageInput: "Page number",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
};

export interface PdfViewerProps extends HTMLAttributes<HTMLDivElement> {
  source: PdfViewerSource;
  labels?: Partial<PdfViewerLabels>;
  onLoadError?: (error: Error) => void;
}

type PdfDocumentFile = string | Blob | { data: Uint8Array } | { range: PdfViewerRangeTransport };

function normalizePdfSource(
  source: Exclude<PdfViewerSource, PdfViewerRangeSource>,
): PdfDocumentFile {
  if (typeof source === "string" || source instanceof Blob) {
    return source;
  }

  // pdf.js 会把二进制数据 transfer 给 worker，导致原 buffer detached；
  // 复制一份，保证调用方复用同一份数据重新打开预览时不会报错。
  if (source instanceof ArrayBuffer) {
    return { data: new Uint8Array(source.slice(0)) };
  }
  return { data: new Uint8Array(source) };
}

// [契约] source 的引用身份是文档重置的唯一触发器：range 源经 useMemo 生成 transport
// 其余类型经 normalizePdfSource 生成 file，父组件每次渲染内联新建对象都会重置页码
// labels 只做浅合并，缺项回落到 DEFAULT_LABELS，不要在组件内做语言分支
// onLoadError 通过 ref 转发给 transport，因此更换回调不会重建 transport
// className 与其余属性透传到最外层可聚焦 div，键盘翻页依赖它的 tabIndex
export function PdfViewer({ source, labels, onLoadError, className, ...props }: PdfViewerProps) {
  const mergedLabels = { ...DEFAULT_LABELS, ...labels };
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  // renderScale 是真正传给 <Page> 的值；displayScale 是用户看到的目标倍率，
  // 缩放手势期间只更新 displayScale（CSS transform 预览），停顿后再提交给 renderScale。
  const [renderScale, setRenderScale] = useState(pdfZoom.DEFAULT_SCALE);
  const [displayScale, setDisplayScale] = useState(pdfZoom.DEFAULT_SCALE);
  const [pageIntrinsicSize, setPageIntrinsicSize] = useState<pdfZoom.PdfPageSize | null>(null);
  const [rangeError, setRangeError] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToTopRef = useRef(false);
  const displayScaleRef = useRef(pdfZoom.DEFAULT_SCALE);
  const renderScaleRef = useRef(pdfZoom.DEFAULT_SCALE);
  const pendingZoomAnchorRef = useRef<pdfZoom.PdfZoomAnchor | null>(null);
  const onLoadErrorRef = useRef(onLoadError);
  onLoadErrorRef.current = onLoadError;
  const { clearZoomOverlay, pageViewportRef, stageZoomOverlay } = pdfZoom.usePdfZoomOverlay();

  // [资源] transport 与 source 一一对应：source 换引用就新建一个，旧的由下方 effect 清理时 abort
  // 注入的错误回调只写 rangeError 与 ref，不直接读 source，避免闭包把 source 拖进依赖
  // 依赖只写 source：把 onLoadError 放进来会让父组件每次渲染都重建 transport 并中断下载
  // useMemo 体内不要顺手 abort 或发起 range 请求，StrictMode 下会被放大成两次副作用
  const rangeTransport = useMemo(() => {
    if (!isPdfViewerRangeSource(source)) {
      return null;
    }
    return new PdfViewerRangeTransport(source, (error) => {
      setRangeError(true);
      onLoadErrorRef.current?.(error);
    });
  }, [source]);

  // [契约] file 的身份决定 Document 是否重载，必须缓存；两种形态互斥
  // range 源永远走 range 形态，其余走字符串、Blob 或 data 形态
  // 不要把 range 源再包一层 data，否则 pdf.js 一次性读完整个文件，按需加载失效
  // normalizePdfSource 的返回要保持稳定，不要在 useMemo 里再做深拷贝
  const file = useMemo<PdfDocumentFile>(() => {
    if (rangeTransport) {
      return { range: rangeTransport };
    }
    return normalizePdfSource(source as Exclude<PdfViewerSource, PdfViewerRangeSource>);
  }, [rangeTransport, source]);

  useEffect(() => {
    return () => {
      // 文档切换/卸载时中止 range 传输，让 pdf.js 停止等待未完成的分段请求
      // [资源] 只能在 cleanup 里 abort：卸载或换文档时 pdf.js 仍可能在等待未完成的分段
      // 不 abort 会让这些 Promise 一直挂着，并把旧文档的 chunk 写进新文档的缓存
      // abort 必须在新的 transport 建立之前完成，顺序错了会连新文档的请求一起取消
      // 这里依赖 transport 而不是 file：file 包装层变化不需要中断传输
      // 严格模式下 effect 成对执行，abort 过的 transport 不可复用，所以只能新建
      rangeTransport?.abort();
    };
  }, [rangeTransport]);

  useEffect(() => {
    // [契约] 文档重置要一次清干净：页数、页码、输入框、双倍率、固有尺寸、错误标志与两个 ref
    // 漏掉 pendingZoomAnchorRef 会把上一个文档的缩放锚点套到新文档，画面跳到错误位置
    // displayScaleRef 与 renderScaleRef 必须与 state 同步重置，否则手势以旧倍率为基准
    // 清覆盖层放在最后，保证前面任何一处提前返回也不会留下旧位图
    setNumPages(null);
    setPageNumber(1);
    setPageInput("1");
    setRenderScale(pdfZoom.DEFAULT_SCALE);
    setDisplayScale(pdfZoom.DEFAULT_SCALE);
    setPageIntrinsicSize(null);
    setRangeError(false);
    displayScaleRef.current = pdfZoom.DEFAULT_SCALE;
    renderScaleRef.current = pdfZoom.DEFAULT_SCALE;
    pendingScrollToTopRef.current = false;
    pendingZoomAnchorRef.current = null;
    clearZoomOverlay();
  }, [clearZoomOverlay, file]);

  const goToPage = useCallback(
    (target: number) => {
      if (numPages === null) {
        return;
      }
      // [契约] 先四舍五入再夹紧到 1 与 numPages：小数倍率或外部调用都可能传进非整数页码
      // numPages 为 null 时上面已提前返回，这里不再兜底，新增分支要保证该前提仍成立
      // [失败路径] 越过末尾的翻页请求直接落到最后一页，不要报错或忽略，否则连按键盘会吃掉输入
      // 不要把夹紧下放到 Page，越界页码会让 react-pdf 抛错并让整块视图空白
      const clamped = Math.min(Math.max(1, Math.round(target)), numPages);
      setPageInput(String(clamped));
      // [契约] 目标页与当前页相同就不重置缩放与滚动锚点
      // 否则点击当前页码、或在输入框回车确认同一页，都会丢掉缩放覆盖层与滚动位置
      // pendingScrollToTopRef 只在此处置真，由渲染成功回调消费，提前消费会滚到旧页顶部
      // [权衡] 这里比较的是闭包里的 pageNumber，快速连翻时可能落后，但下一次渲染成功后会以实际页为准
      if (clamped !== pageNumber) {
        clearZoomOverlay();
        setPageIntrinsicSize(null);
        pendingZoomAnchorRef.current = null;
        pendingScrollToTopRef.current = true;
        setPageNumber(clamped);
      }
    },
    [clearZoomOverlay, numPages, pageNumber],
  );

  const handlePageRenderSuccess = useCallback(
    (completedScale: number, originalWidth: number, originalHeight: number) => {
      // react-pdf 的旧 render task 可能在新倍率提交后才回调，不能让旧回调提前移除覆盖层。
      // [并发] react-pdf 的旧 render task 会在新倍率提交之后才回调，不能让它清覆盖层
      // 用 page.width 除以 originalWidth 得到实际倍率，与当前提交倍率不一致就整段丢弃
      // 容差 0.001 用来吸收浮点误差：收紧会把正常回调误判成过期，放宽则挡不住旧回调
      // 丢弃时不要顺手清 pendingScrollToTopRef，那会让换页后的置顶逻辑失效
      // 只有正确回调才写固有尺寸并清覆盖层，顺序颠倒会出现先白后图的闪烁
      if (Math.abs(completedScale - renderScaleRef.current) > 0.001) {
        return;
      }

      setPageIntrinsicSize((current) =>
        pdfZoom.resolvePdfPageSize(current, originalWidth, originalHeight),
      );
      clearZoomOverlay();
      const container = scrollContainerRef.current;
      const pendingScrollToTop = pendingScrollToTopRef.current;
      pendingScrollToTopRef.current = false;
      if (!container) {
        return;
      }
      if (pendingScrollToTop) {
        container.scrollTop = 0;
      }
    },
    [clearZoomOverlay],
  );

  const commitPageInput = useCallback(() => {
    // [失败路径] 空串或非数字一律回滚到当前页，不要静默清零或跳到第一页
    // parseInt 会容忍 3abc 这类输入并取 3，对页码场景可接受，但不要换成 Number，空串会变 0
    // 提交失败只改显示值，不动 pageNumber，避免一次误输入触发整页重渲染
    // [契约] 回车与失焦共用这一个入口，两处逻辑不得分叉，否则会出现确认两次跳两页
    const parsed = Number.parseInt(pageInput.trim(), 10);
    if (Number.isNaN(parsed)) {
      setPageInput(String(pageNumber));
      return;
    }
    goToPage(parsed);
  }, [goToPage, pageInput, pageNumber]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // 页码输入框内保留方向键的光标语义
      // [契约] 页码输入框内方向键属于光标移动，必须原样放行
      // preventDefault 只在真正处理了翻页之后调用，先拦截再判断会让浏览器后退快捷键失效
      // 监听挂在可聚焦根节点上并依赖冒泡，子组件若 stopPropagation 翻页就会失灵
      // [权衡] 用 tagName 判断而不是比较 activeElement，避免焦点落在输入框内层节点时漏判
      if ((event.target as HTMLElement).tagName === "INPUT") {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goToPage(pageNumber - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goToPage(pageNumber + 1);
      }
    },
    [goToPage, pageNumber],
  );

  const documentLoaded = numPages !== null;

  const zoomTo = useCallback(
    (target: number, pointer?: pdfZoom.PdfZoomPointer) => {
      const current = displayScaleRef.current;
      // [契约] 缩放目标先夹紧到 MIN_SCALE 与 MAX_SCALE，按钮与滚轮都从这里进入，不要各自判边界
      // 倍率没变化就直接返回，避免一次无意义的 setState 让整棵子树重渲染
      // 锚点必须在改倍率之前捕获：此时 DOM 还是旧布局，能算准指针下的内容点
      // 改完之后由 layout effect 调 restorePdfZoomAnchor 把该内容点挪回指针下
      // 不要在 zoomTo 里直接改 renderScale，那会绕过双缓冲，手感顿挫且闪白
      const next = pdfZoom.clampScale(target);
      if (next === current) {
        return;
      }
      const container = scrollContainerRef.current;
      const pageViewport = pageViewportRef.current;
      pendingZoomAnchorRef.current =
        container && pageViewport
          ? pdfZoom.capturePdfZoomAnchor(container, pageViewport, pointer)
          : null;
      displayScaleRef.current = next;
      setDisplayScale(next);
    },
    [pageViewportRef],
  );

  useLayoutEffect(() => {
    // [并发] 必须在 useLayoutEffect 里同步消费锚点并在开头清空，放到 useEffect 会晚一帧
    // 那时浏览器已经绘制新布局，用户能看到页面在指针下抖动一下
    // 依赖 displayScale 而不是 renderScale：预览阶段就要校正，不必等 canvas 重绘
    // [失败路径] container 或 pageViewport 为空时跳过校正，但清空动作不能省，否则残留锚点会在下次缩放被误用
    const anchor = pendingZoomAnchorRef.current;
    const container = scrollContainerRef.current;
    const pageViewport = pageViewportRef.current;
    pendingZoomAnchorRef.current = null;
    if (anchor && container && pageViewport) {
      // 缩放布局提交后再校正，跨越“居中 / 横向滚动”边界时也保持指针下的内容点稳定。
      pdfZoom.restorePdfZoomAnchor(container, pageViewport, anchor);
    }
  }, [displayScale, pageViewportRef]);

  // 手势停顿后把预览倍率一次性提交给 <Page> 重渲染；displayScale 每次变化都会重置计时器。
  useEffect(() => {
    // [并发] 每个 displayScale 变化都会重置计时器，只有停顿满 ZOOM_COMMIT_DELAY_MS 才提交一次
    // 连续滚轮因此只产生最后一次重排，这是缩放手感的来源，不要改成即时提交
    // 提交前先 stageZoomOverlay 复制当前位图：scale 变化会让 react-pdf 卸载旧 canvas
    // 新 canvas 绘制完成前不可见，没有覆盖层就会闪一帧空白
    // renderScaleRef 必须先于 setRenderScale 写入；cleanup 必须清定时器，否则连点会堆积多次提交
    if (displayScale === renderScale) {
      return;
    }
    const timer = window.setTimeout(() => {
      // react-pdf 会在 scale key 变化时卸载旧 canvas，并隐藏尚未绘制完成的新 canvas。
      // 提交前复制当前位图作为双缓冲覆盖层，直到新 canvas 的 onRenderSuccess 到达。
      const pageViewport = pageViewportRef.current;
      if (pageViewport) {
        stageZoomOverlay(pageViewport.offsetWidth, pageViewport.offsetHeight);
      }
      renderScaleRef.current = displayScale;
      setRenderScale(displayScale);
    }, pdfZoom.ZOOM_COMMIT_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [displayScale, renderScale, stageZoomOverlay]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !documentLoaded) {
      return;
    }

    const zoomWithAppleModifier = isAppleKeyboardPlatform();
    const handleWheelZoom = (event: WheelEvent) => {
      // macOS 绑定 command，其余平台（Windows/Linux）绑定 ctrl
      const zoomModifierPressed = zoomWithAppleModifier ? event.metaKey : event.ctrlKey;
      if (!zoomModifierPressed) {
        return;
      }
      // 修饰键 + 滚轮独占为缩放手势，不再滚动页面内容
      event.preventDefault();
      if (event.deltaY === 0) {
        return;
      }
      zoomTo(
        displayScaleRef.current * Math.exp(-event.deltaY * pdfZoom.WHEEL_ZOOM_SENSITIVITY),
        event,
      );
    };

    // React 的 onWheel 委托在 root 上是 passive 监听，preventDefault 不生效；
    // 这里直接挂非 passive 的原生监听，避免缩放时页面同时滚动。
    // [契约] React 的 onWheel 在 root 上是 passive 委托，preventDefault 不生效
    // 所以这里直接挂原生非 passive 监听，独占修饰键加滚轮这个手势
    // 移除时必须用同一个函数引用，内联新函数会泄漏监听并继续拦截滚动
    // [契约] 监听只在文档加载完成后挂载，未就绪时滚轮保持普通滚动，不劫持页面
    container.addEventListener("wheel", handleWheelZoom, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheelZoom);
    };
  }, [documentLoaded, zoomTo]);

  // [契约] 控件可用性只看 numPages 是否为 null，不要混入加载中或 rangeError
  // range 出错时页码与缩放控件仍可聚焦，避免整块 UI 变成不可达的死区
  // 各按钮再叠加自身边界（首页、末页、缩放下限上限），禁用条件不要合并成一处布尔
  // [权衡] 缩放百分比显示 displayScale 而不是 renderScale，保证按钮数值与手势预览一致
  const controlsDisabled = numPages === null;
  const zoomPercent = Math.round(displayScale * 100);
  const zoomPreviewScale = displayScale / renderScale;
  const pageDisplaySize = pdfZoom.getPdfPageDisplaySize(pageIntrinsicSize, displayScale);
  const pagePreviewStyle = pdfZoom.getPdfPagePreviewStyle(
    pageDisplaySize !== undefined,
    zoomPreviewScale,
  );

  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={cn("flex h-full min-h-0 flex-col outline-none", className)}
      {...props}
    >
      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-max p-4">
          {rangeError ? (
            <div className="p-3 text-ui-base text-destructive">{mergedLabels.loadError}</div>
          ) : (
            <div ref={pageViewportRef} className="relative" style={pageDisplaySize}>
              <div style={pagePreviewStyle}>
                <Document
                  file={file}
                  options={rangeTransport ? RANGE_DOCUMENT_OPTIONS : DOCUMENT_OPTIONS}
                  onLoadSuccess={(document) => {
                    setNumPages(document.numPages);
                    const clamped = Math.min(pageNumber, document.numPages);
                    setPageNumber(clamped);
                    setPageInput(String(clamped));
                  }}
                  onLoadError={onLoadError}
                  loading={
                    <div className="p-3 text-ui-base text-foreground-subtle">
                      {mergedLabels.loading}
                    </div>
                  }
                  error={
                    <div className="p-3 text-ui-base text-destructive">
                      {mergedLabels.loadError}
                    </div>
                  }
                  noData={
                    <div className="p-3 text-ui-base text-foreground-subtle">
                      {mergedLabels.noData}
                    </div>
                  }
                >
                  <Page
                    pageNumber={pageNumber}
                    scale={renderScale}
                    renderAnnotationLayer={false}
                    onRenderSuccess={(page) =>
                      handlePageRenderSuccess(
                        page.width / page.originalWidth,
                        page.originalWidth,
                        page.originalHeight,
                      )
                    }
                    className="shadow-md"
                  />
                </Document>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-center gap-1 border-t border-border px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={mergedLabels.previousPage}
          disabled={controlsDisabled || pageNumber <= 1}
          onClick={() => goToPage(pageNumber - 1)}
        >
          <ChevronLeftIcon />
        </Button>
        <div className="flex items-center gap-1 text-ui-base text-foreground-subtle">
          <input
            value={pageInput}
            inputMode="numeric"
            disabled={controlsDisabled}
            aria-label={mergedLabels.pageInput}
            onChange={(event) => setPageInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitPageInput();
              }
            }}
            onBlur={commitPageInput}
            className="h-6 w-10 rounded-md border border-input-border bg-input px-1 text-center text-ui-base text-foreground outline-none transition-colors hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused disabled:pointer-events-none disabled:opacity-50"
          />
          <span>/ {numPages ?? "-"}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={mergedLabels.nextPage}
          disabled={controlsDisabled || numPages === null || pageNumber >= numPages}
          onClick={() => goToPage(pageNumber + 1)}
        >
          <ChevronRightIcon />
        </Button>

        <div className="mx-1 h-4 w-px bg-border" />

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={mergedLabels.zoomOut}
          disabled={controlsDisabled || displayScale <= pdfZoom.MIN_SCALE}
          onClick={() => zoomTo(displayScale - pdfZoom.ZOOM_STEP)}
        >
          <ZoomOutIcon />
        </Button>
        <span className="w-11 text-center text-ui-base text-foreground-subtle tabular-nums">
          {zoomPercent}%
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={mergedLabels.zoomIn}
          disabled={controlsDisabled || displayScale >= pdfZoom.MAX_SCALE}
          onClick={() => zoomTo(displayScale + pdfZoom.ZOOM_STEP)}
        >
          <ZoomInIcon />
        </Button>
      </div>
    </div>
  );
}
