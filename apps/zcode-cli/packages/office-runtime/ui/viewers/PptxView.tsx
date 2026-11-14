// PPTX 查看器：按幻灯片纵向排布，用 pptx-renderer 把每页渲染成 DOM，并按视口懒加载。
// 与 PDF 不同，这里没有缩放能力（幻灯片恒适宽），字号与位置均由渲染器按幻灯片坐标系生成。
// 副作用：创建幻灯片 DOM、ObjectURL 媒体缓存、IntersectionObserver，并调用渲染库绘制。
// 状态全部保存在 ref 中，React 只负责外层容器与「解析完成」重渲染信号。
// PPTX 查看器：按幻灯片纵向排布，逐页懒渲染成 DOM，并按容器宽度适宽缩放。
// 副作用：创建幻灯片 DOM、持有媒体 ObjectURL、注册 IntersectionObserver 与 ResizeObserver。
// 状态存放在 ref 中，React 只承担外层容器与「解析完成」的重渲染信号。
// 下方不变量按渲染链路顺序排列，改动任一分支前先确认对应条目。
// INV-01 幻灯片槽位下标与页码一一对应，slots 下标恒等于页码减 1；守住位置：所有槽位索引与 locator.from 换算；改错故障：定位跳到错页并选中错误形状
// INV-02 屏幕坐标必须先除以 scaleRef 才能用于命中测试与选区换算；守住位置：点击处理的 x/y 计算；改错故障：点击位置整体偏移，选中相邻形状
// INV-03 渲染完成信号 ready 必须复用，同一页不得并行渲染两次；守住位置：ensureRendered 的提前返回分支；改错故障：重复挂载 DOM 导致内容重影
// INV-04 单页渲染失败不得让调用方 await 抛错，ready 恒为已决状态；守住位置：ensureRendered 对句柄 ready 的兜底；改错故障：损坏页使整份文档的定位与缩略图全部失败
// INV-05 媒体 ObjectURL 与幻灯片句柄只在卸载时统一释放，释放后清空缓存表；守住位置：解析 effect 的清理函数；改错故障：切换文档后浏览器内存持续增长
// INV-06 卸载后的异步回调必须被 cancelled 拦截，不得再触发 onError 或 onReady；守住位置：解析 effect 各 await 之后与最终 catch；改错故障：切页时报错弹窗指向已关闭的文档
// INV-07 无手动缩放能力，scale 由容器宽度除以幻灯片原始宽度得出；守住位置：组件体 scale 计算与 zoom 空实现；改错故障：缩放按钮无响应或内容溢出面板
// INV-08 容器宽度下限 200px，窄面板不得把 scale 压到不可读；守住位置：初始宽度设置与 ResizeObserver 回调；改错故障：侧栏收窄后幻灯片挤成一条
// INV-09 覆盖层坐标恒为幻灯片原始坐标系，缩放只作用于外层 transform；守住位置：outline 绘制与 transform 赋值；改错故障：选中框随缩放整体漂移
// INV-10 懒渲染以 800px 预取，观察器的 root 必须是滚动容器本身；守住位置：IntersectionObserver 构造参数；改错故障：预取失效，滚动到该页才白屏
// INV-11 命中测试从最后一个节点倒序扫描，后绘制者优先命中；守住位置：hitTest 的循环方向；改错故障：上层遮挡物被下层抢走点击
// INV-12 零面积占位节点不参与命中，极小形状加 4px 容差；守住位置：hitTest 的跳过判断与容差计算；改错故障：细线图标点不中或点击穿透到空白
// INV-13 形状描边按 selected 与 revealed 分命名空间，重画前只清同类；守住位置：outline 的查询与移除；改错故障：选中框误删 Agent 标记或残留旧框
// INV-14 点击 Agent 标记优先回放注释，回调未接住时才降级为选区；守住位置：点击处理中的 onRevealHit 分支；改错故障：点注释标记反而改掉用户选区
// INV-15 引文查找依赖已渲染 DOM，reveal 必须先等目标页渲染完成；守住位置：reveal 循环内的 ensureRendered 调用；改错故障：未懒加载的页永远定位不到引文
// INV-16 capture 遇到越界定位器必须抛错而非回退到当前页；守住位置：capture 的槽位校验分支；改错故障：Agent 截到错误页并据此下结论
// INV-17 缩略图按页码缓存 DOM 与句柄，调用方不得修改返回节点；守住位置：thumbnail 的缓存命中；改错故障：画册复用同一节点导致样式互相覆盖
// INV-18 查找会强制渲染全部幻灯片，代价随页数线性增长；守住位置：find 中的批量渲染；改错故障：大文档查找卡住主线程导致界面假死
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  RECOMMENDED_ZIP_LIMITS,
  buildPresentation,
  materializeSlideNodes,
  parseZipLazyMedia,
  renderSlide,
  type PresentationData,
  type SlideHandle,
  type SlideNode,
} from "@aiden0z/pptx-renderer/browser";
import { parseLocator } from "#office/domain/anchor.ts";
import { cut } from "#office/domain/text.ts";
import {
  boxOf,
  findAllRanges,
  pointOn,
  findTextRange,
  paintRanges,
  scrollToElement,
  scrollToRange,
  selectionIn,
  trackTopmost,
} from "#ui/dom.ts";
import { rasterize } from "#ui/raster.ts";
import type { RevealedTarget, ViewerHandle, ViewerProps } from "#ui/viewers/types.ts";

// 【契约】frame 决定滚动占位与懒加载观察目标，尺寸恒为幻灯片原始尺寸乘 scale
// 【契约】host 保持幻灯片原始尺寸，只靠 transform 缩放，overlay 坐标因此无需换算
// 【生命周期】handle 与 ready 同时为空表示未渲染，卸载时只对存在的 handle 做一次释放
interface SlideSlot {
  // 外层定位框，宽高 = 幻灯片尺寸 × scale，dataset.at 为 `slide:N`（N 从 1 开始）。
  frame: HTMLDivElement;
  // 渲染器挂载点，保持幻灯片原始尺寸并通过 transform: scale 缩放。
  host: HTMLDivElement;
  // 覆盖层，用于绘制选中/标记形状的描边框；坐标与幻灯片原始坐标系一致。
  overlay: HTMLDivElement;
  // 渲染器返回的句柄；未渲染或已销毁时为 undefined。
  handle?: SlideHandle;
  // 该页渲染完成信号（失败也 resolve），用于避免重复渲染。
  ready?: Promise<void>;
}

// 文本体（textBody）的最小结构：段落 → 运行片段。渲染库类型没有导出该形状，这里只按需读取。
type TextBodyLike = { paragraphs?: { runs?: { text?: string }[] }[] };

// 把文本体拼成纯文本：段落内 runs 直接相连（保留原换行语义），段落之间换行并去掉首尾空白。
// 输入缺失（undefined）时返回空串，供上层作为选区文本的兜底。
function bodyText(body: TextBodyLike | undefined): string {
  return (body?.paragraphs ?? [])
    .map((paragraph) => (paragraph.runs ?? []).map((run) => run.text ?? "").join(""))
    .join("\n")
    .trim();
}

// 取节点的可读文本用于选区上报：表格按行拼接（单元格之间用 ` | `），其它形状取文本体。
// 只做展示与剪贴板用途，不参与定位；无文字的形状返回空串。
function nodeText(node: SlideNode): string {
  const data = node as unknown as {
    textBody?: TextBodyLike;
    rows?: { cells: { textBody?: TextBodyLike }[] }[];
  };
  if (data.rows)
    return data.rows
      .map((row) => row.cells.map((cell) => bodyText(cell.textBody)).join(" | "))
      .join("\n");
  return bodyText(data.textBody);
}

// 幻灯片列表左右留白（CSS 与此保持一致），用于算适宽宽度。
const GAP = 16;

// PPTX 查看器主体。输入 bytes（演示文稿原始字节）、glance（内联卡片预览，仅影响样式）；
// 输出 ViewerHandle，并回调 onPage/onLocation/onSelect/onReady/onError。
// 不变量：slots.current 下标 = 幻灯片序号 - 1；所有坐标换算都以幻灯片原始坐标系为基准，
// 屏幕坐标需先除以 scaleRef.current 才能用于命中测试。
// 【不变量】组件渲染只输出空容器，幻灯片 DOM 全部由 effect 直接操作，React 不参与每页结构
// 【不变量】scaleRef 每次渲染同步为最新 scale，事件回调读 ref 而不是闭包里的旧值
// 【并发】props.bytes 变化先跑旧 effect 的清理再建新文档，旧文档的异步结果被 cancelled 丢弃
// 【权衡】回调放进 ref 逐帧覆盖，避免父组件内联函数变化触发解析与渲染整链重跑
export const PptxView = forwardRef<ViewerHandle, ViewerProps>(function PptxView(props, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const presentation = useRef<PresentationData | null>(null);
  const slots = useRef<SlideSlot[]>([]);
  // 【生命周期】媒体 URL 按资源键缓存，同一图片在多页复用同一个 ObjectURL，避免重复解码
  // 【生命周期】该表由解析 effect 的清理函数统一 revoke，谁创建谁释放，渲染库不承担回收
  // 【失败路径】漏掉释放会让文档切换后 URL 常驻，长会话里内存随翻页次数线性上涨
  const mediaCache = useRef(new Map<string, string>());
  const [width, setWidth] = useState(0);
  // Bumped when a presentation finishes parsing; the ref alone would not re-render.
  const [loaded, setLoaded] = useState(0);
  const callbacks = useRef(props);
  callbacks.current = props;
  // Slides always fit the pane width; there is no zoom.
  // 【不变量】解析完成前 scale 恒为 0，依赖 scale 的 effect 直接返回，不触碰空槽位
  // 【权衡】适宽是唯一适配策略，没有手动缩放，故 scale 只是宽度比值而非交互状态
  // 【失败路径】此处不夹取上限，超宽容器会把幻灯片放大到超出原始分辨率而发虚
  const scale = loaded && presentation.current ? width / presentation.current.width : 0;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const thumbs = useRef(new Map<number, { element: HTMLElement; handle: SlideHandle }>());
  const reveal = useRef<Range[]>([]);
  /** Per agent target, what a click on it hits: its quote or its shape (not a whole slide). */
  const revealHits = useRef<(Range | Element | null)[]>([]);
  const find = useRef<{ ranges: Range[]; current: number } | null>(null);
  const glance = Boolean(props.glance);

  // 解析演示文稿：先按推荐上限懒加载媒体 zip，再建立幻灯片数据（lazySlides 表示暂不建节点）。
  // 每页先只建占位框，真正渲染交给 IntersectionObserver。失败走 onError，卸载时释放全部句柄
  // 与 ObjectURL，避免媒体缓存泄漏。
  useEffect(() => {
    // 【并发】清理先置 cancelled 再释放句柄，正在等待的解析链在下一个检查点自行退出
    // 【事务】解析分三步提交：替换子节点、按序建槽位、最后通知页码与就绪，中途失败不留半成品
    // 【不变量】槽位数组在解析成功后整体替换而非增量追加，旧文档不会残留页参与命中与绘制
    // 【失败路径】建立演示数据抛错时列表已清空，界面呈现空列表而不是上一份文档的残影
    let cancelled = false;
    const list = listRef.current!;
    (async () => {
      // 【安全】解包按推荐上限校验条目数与体积，超限即抛错，防止恶意演示文稿撑爆内存
      // 【权衡】媒体采用懒加载，解析阶段只登记引用，真正解码推迟到该页首次渲染
      // 【失败路径】解包失败沿 Promise 链上抛，由外层 catch 转成错误回调，界面停在没有幻灯片的空态
      const files = await parseZipLazyMedia(props.bytes, RECOMMENDED_ZIP_LIMITS);
      if (cancelled) return;
      const built = buildPresentation(files, { lazySlides: true });
      presentation.current = built;
      list.replaceChildren();
      slots.current = built.slides.map((_: unknown, i: number) => {
        const frame = document.createElement("div");
        frame.className = "slide-frame";
        frame.dataset.at = `slide:${i + 1}`;
        const host = document.createElement("div");
        host.className = "slide-host";
        host.style.width = `${built.width}px`;
        host.style.height = `${built.height}px`;
        const overlay = document.createElement("div");
        overlay.className = "slide-overlay";
        host.append(overlay);
        frame.append(host);
        list.append(frame);
        return { frame, host, overlay };
      });
      setWidth(Math.max(200, scrollRef.current!.clientWidth - GAP * 2));
      setLoaded((count) => count + 1);
      callbacks.current.onPage?.({ current: 1, count: built.slides.length });
      callbacks.current.onReady();
    // 【失败路径】解析失败只上报错误回调，不抛向 React 边界，避免整个查看器被错误边界卸载
    // 【并发】cancelled 为真时静默丢弃错误，已换成新文档的旧任务不得污染当前错误提示
    })().catch((error) => !cancelled && callbacks.current.onError(error));
    return () => {
      cancelled = true;
      for (const slot of slots.current) slot.handle?.dispose();
      slots.current = [];
      for (const thumb of thumbs.current.values()) thumb.handle.dispose();
      thumbs.current.clear();
      // 【生命周期】释放顺序固定：先销毁每页渲染句柄，再销毁缩略图句柄，最后回收媒体 URL
      // 【生命周期】句柄释放会摘除其 DOM 与监听，缩略图缓存独立于主列表，两处都要清
      // 【不变量】清空槽位与缓存表放在释放之后，重入时不会对已销毁句柄二次释放
      // 【失败路径】只清表不释放会让 DOM 节点脱离文档仍被强引用，切换文档后内存不回落
      for (const url of mediaCache.current.values()) URL.revokeObjectURL(url);
      mediaCache.current.clear();
    };
  }, [props.bytes]);

  // 跟随容器宽度重算适宽缩放；下限 200px，避免面板极窄时缩放后完全不可读。
  useEffect(() => {
    const scroll = scrollRef.current!;
    // 【不变量】宽度来源唯一：初始测量与观察器回调写入同一个 width，scale 由它单点推导
    // 【生命周期】观察器只观察滚动容器，卸载时断开，容器被替换也不会留下悬空订阅
    // 【权衡】仅响应容器宽度忽略高度，纵向滚动交给浏览器原生处理，省掉一次布局抖动
    const resize = new ResizeObserver(() => setWidth(Math.max(200, scroll.clientWidth - GAP * 2)));
    resize.observe(scroll);
    return () => resize.disconnect();
  }, []);

  // 缩放变化后刷新每页定位框尺寸，并重建观察器：进入视口前 800px 的页才触发渲染，
  // 依赖 loaded 让「解析完成」后重新观察一次（此时 slots 才有内容）。
  // Apply scale and (re)observe for lazy rendering.
  useEffect(() => {
    const built = presentation.current;
    if (!built || !scale) return;
    for (const slot of slots.current) {
      slot.frame.style.width = `${built.width * scale}px`;
      slot.frame.style.height = `${built.height * scale}px`;
      // 【不变量】定位框尺寸与 host 缩放必须同步更新，二者不一致会出现空白带或内容溢出
      // 【契约】--slide-scale 供覆盖层子元素反向补偿，子元素按原始坐标绘制即可
      // 【失败路径】只改 frame 不改 host 会让幻灯片按原始像素铺满，滚动高度算错导致跳转失准
      slot.host.style.transform = `scale(${scale})`;
      slot.frame.style.setProperty("--slide-scale", String(scale));
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = slots.current.findIndex((slot) => slot.frame === entry.target);
          if (index >= 0) void ensureRendered(index);
        }
      },
      // 【权衡】800px 预取是滚动流畅度与首屏渲染量的折中，过大会一次渲染多页拖慢打开
      // 【并发】观察器随 scale 与 loaded 重建，解析完成后再观察一遍，避免槽位未就绪时错过进入事件
      { root: scrollRef.current, rootMargin: "800px 0px" },
    );
    for (const slot of slots.current) observer.observe(slot.frame);
    return () => observer.disconnect();
  }, [scale, loaded]);

  // 懒加载单页：已渲染则复用 ready；materializeSlideNodes 把该页节点实例化后交给 renderSlide。
  // 渲染失败被吞掉（catch 返回 undefined），保证调用方等待不会因单页损坏而整体失败。
  // 【不变量】ready 一旦存在即代表该页已提交渲染，后续调用直接复用，绝不再建第二个句柄
  // 【契约】节点实例化与渲染分离，同一页被多次实例化也保持幂等，不会重复插入 DOM
  // 【契约】新渲染的节点插到 overlay 之前，保证描边覆盖层始终位于最上层
  // 【失败路径】越界下标返回已决 Promise，调用方无需区分空页与已渲染页
  function ensureRendered(index: number): Promise<void> {
    const built = presentation.current;
    const slot = slots.current[index];
    if (!built || !slot) return Promise.resolve();
    if (slot.ready) return slot.ready;
    const slide = built.slides[index];
    materializeSlideNodes(built, slide);
    const handle = renderSlide(built, slide, {
      mediaUrlCache: mediaCache.current,
      pdfjs: false,
      onNavigate: (target: { slideIndex?: number; url?: string }) => {
        if (target.url) callbacks.current.onLink(target.url);
        else if (typeof target.slideIndex === "number") {
          const frame = slots.current[target.slideIndex]?.frame;
          if (frame) scrollToElement(frame, "start");
        }
      },
    });
    slot.handle = handle;
    slot.host.insertBefore(handle.element, slot.overlay);
    // 【失败路径】吞掉单页渲染错误并归一为成功，损坏页只留空白，不阻断其它页的定位与截图
    // 【不变量】处理后的 Promise 才是权威 ready，缓存它而非原始句柄 Promise，避免重复订阅
    const ready = handle.ready.catch(() => undefined);
    slot.ready = ready;
    return ready;
  }

  // 命中测试从最后一个节点往前扫（后绘制的在上层）；宽高都为 0 的占位节点跳过，
  // 极小形状（< 6px）加 4px 容差，避免点不中细线/小图标。
  /** Topmost node under a point in slide coordinates (later nodes paint on top). */
  // 【不变量】入参是幻灯片坐标系，调用方必须先完成除以 scale 的换算，本函数不做任何缩放
  // 【不变量】倒序扫描等价于绘制顺序，最后绘制的节点在视觉最上层，应优先响应点击
  // 【契约】未命中返回 null，调用方据此降级为整页定位而不是猜测相邻形状
  function hitTest(index: number, x: number, y: number): SlideNode | null {
    const built = presentation.current;
    if (!built) return null;
    const slide = built.slides[index];
    materializeSlideNodes(built, slide);
    for (let i = slide.nodes.length - 1; i >= 0; i--) {
      const node = slide.nodes[i];
      const { x: left, y: top } = node.position;
      const { w, h } = node.size;
      if (w <= 0 && h <= 0) continue;
      const pad = Math.min(w, h) < 6 ? 4 : 0;
      if (x >= left - pad && x <= left + w + pad && y >= top - pad && y <= top + h + pad)
        return node;
    }
    return null;
  }

  // 在覆盖层画出形状描边（选中/标记各一类）；先清除同类旧框，node 为 null 即只清除。
  // 坐标直接用幻灯片原始坐标，由外层 transform 统一缩放。
  // 【不变量】每次重画先清同类旧框，描边数量恒为零或一，避免叠加出更粗的边框
  // 【契约】node 为空表示仅清除不清画，清除标记与取消选中都复用它
  // 【权衡】描边用 DOM 而非画布，换取样式可主题化与可点击，代价是形状多时节点数偏高
  function outline(slot: SlideSlot, node: SlideNode | null, kind: "selected" | "revealed") {
    slot.overlay.querySelectorAll(`.shape-${kind}`).forEach((element) => element.remove());
    if (!node) return;
    const box = document.createElement("div");
    box.className = `shape-${kind}`;
    box.style.left = `${node.position.x}px`;
    box.style.top = `${node.position.y}px`;
    box.style.width = `${node.size.w}px`;
    box.style.height = `${node.size.h}px`;
    slot.overlay.append(box);
  }

  // 可见位置追踪 + 点击选区：文字选区优先（取其包围盒中心）；无选区时按点击位置命中形状，
  // 命中形状上报 `slide:N/shape:id`，否则上报整页。点击 Agent 标记优先回放注释。
  // mouseup 延迟一拍，等浏览器更新完 DOM 选区；坐标先换算回幻灯片坐标系再做命中测试。
  useEffect(() => {
    const scroll = scrollRef.current!;
    // 【契约】位置上报格式固定为 slide 加页码，页码从 1 起，上层据此解析当前页
    // 【并发】可见位置追踪做 1/3 节流，快速滚动时只上报最终稳定页，减少上层重渲染
    // 【生命周期】卸载时解绑追踪与抬起监听，监听挂在滚动容器上，必须成对移除
    const untrack = trackTopmost(
      scroll,
      () => slots.current.map((slot) => slot.frame),
      (element) => element.dataset.at ?? null,
      (at) => {
        callbacks.current.onLocation(at);
        callbacks.current.onPage?.({ current: Number(at.slice(6)), count: slots.current.length });
      },
      1 / 3,
    );
    const pick = (event: MouseEvent) => {
      const frame = (event.target as Element).closest<HTMLElement>(".slide-frame");
      const index = slots.current.findIndex((slot) => slot.frame === frame);
      if (index < 0) {
        for (const other of slots.current) outline(other, null, "selected");
        callbacks.current.onSelect(null);
        return;
      }
      const slot = slots.current[index];
      const selected = selectionIn(slot.host);
      // A click on one of the agent's marks brings its note back instead of selecting.
      const hit = selected
        ? -1
        : revealHits.current.findIndex((mark) => pointOn(mark, event.clientX, event.clientY));
      if (hit >= 0 && callbacks.current.onRevealHit?.(hit)) {
        for (const other of slots.current) outline(other, null, "selected");
        callbacks.current.onSelect(null);
        return;
      }
      const rect = slot.host.getBoundingClientRect();
      const point = selected
        ? selected.range.getBoundingClientRect()
        : { left: event.clientX, top: event.clientY, width: 0, height: 0 };
      const x = (point.left + point.width / 2 - rect.left) / scaleRef.current;
      const y = (point.top + point.height / 2 - rect.top) / scaleRef.current;
      const node = hitTest(index, x, y);
      for (const other of slots.current) outline(other, null, "selected");
      outline(slot, node, "selected");
      const at = node ? `slide:${index + 1}/shape:${node.id}` : `slide:${index + 1}`;
      const text = selected?.text ?? (node ? nodeText(node) : "");
      const range = selected?.range.cloneRange();
      const box = slot.overlay.querySelector(".shape-selected");
      callbacks.current.onSelect(
        { at, text: cut(text, 0, 2000) },
        {
          text: Boolean(range),
          locate: () => (range ? boxOf(range) : (boxOf(box) ?? boxOf(slot.frame))),
          user: true,
        },
      );
    };
    const onUp = (event: MouseEvent) => setTimeout(() => pick(event), 0);
    scroll.addEventListener("mouseup", onUp);
    return () => {
      untrack();
      scroll.removeEventListener("mouseup", onUp);
    };
  }, []);

  // 解析定位器并取出对应幻灯片槽位；定位类型不匹配或页码越界时返回 null（调用方跳过该目标）。
  function slotFor(at: string) {
    const locator = parseLocator("pptx", at);
    if (locator.kind !== "pptx") return null;
    return { locator, slot: slots.current[locator.from - 1] ?? null };
  }

  // 统一重画高亮：Agent 标记层与查找层分开，当前命中从普通层剔除，避免两种背景叠加。
  function paint() {
    paintRanges("office-reveal", reveal.current);
    const state = find.current;
    const current = state ? state.ranges[state.current] : undefined;
    paintRanges("office-find", state ? state.ranges.filter((range) => range !== current) : []);
    paintRanges("office-find-current", current ? [current] : []);
  }

  // 命令式接口。reveal 会先确保目标页已渲染（引文只能在已渲染的 DOM 里查找），
  // 有 shape 时画形状描边、否则整页/页区间加 revealed 类；点击命中项按 reveal 顺序回填索引。
  // zoom/fit 为空实现：幻灯片恒适宽，无缩放概念。
  useImperativeHandle(
    ref,
    (): ViewerHandle => ({
      // 【事务】先整体清空旧标记再逐条重建，部分目标定位失败时其余目标仍然可见
      // 【并发】目标按顺序串行等待渲染完成，保证结果顺序与入参一致，调用方不必重排
      // 【契约】空引文只按形状或整页定位，不生成文本区间，后续查找与滚动走元素分支
      async reveal(targets) {
        this.clearReveal();
        const results: RevealedTarget[] = [];
        for (const target of targets) {
          const found = slotFor(target.at);
          if (!found?.slot) continue;
          const { locator, slot } = found;
          await ensureRendered(locator.from - 1);
          if (locator.shape) {
            const built = presentation.current!;
            const slide = built.slides[locator.from - 1];
            materializeSlideNodes(built, slide);
            outline(
              slot,
              slide.nodes.find((node: SlideNode) => node.id === locator.shape) ?? null,
              "revealed",
            );
          } else {
            for (let n = locator.from; n <= locator.to; n++)
              slots.current[n - 1]?.frame.classList.add("revealed");
          }
          const range = target.quote ? findTextRange(slot.host, target.quote) : null;
          if (range) reveal.current.push(range);
          const shape = locator.shape ? slot.overlay.querySelector(".shape-revealed") : null;
          revealHits.current.push(range ?? shape);
          results.push({
            at: target.at,
            locate: () => boxOf(range) ?? boxOf(shape) ?? boxOf(slot.frame),
            scrollTo: () =>
              range
                ? scrollToRange(range, "upper")
                : scrollToElement(shape ?? slot.frame, shape ? "upper" : "start"),
          });
        }
        paint();
        results[0]?.scrollTo();
        return results;
      },
      goTo(at) {
        const found = slotFor(at);
        if (found?.slot) scrollToElement(found.slot.frame, "start");
      },
      clearReveal() {
        reveal.current = [];
        revealHits.current = [];
        for (const slot of slots.current) {
          slot.frame.classList.remove("revealed");
          outline(slot, null, "revealed");
        }
        paint();
      },
      // 【失败路径】文档未解析完或定位器越界一律抛错，让 Agent 收到明确原因而不是拿到错页图
      // 【契约】缺省定位取视口顶部第一条可见页，8px 阈值容忍半像素滚动偏移
      async capture(at, maxWidth) {
        const built = presentation.current;
        if (!built) throw new Error("The presentation is still loading.");
        let index: number;
        if (at) {
          const found = slotFor(at);
          // 传入的定位器不在本演示文稿内时抛错而非回退，让 Agent 感知引用了不存在的页/形状。
          if (!found?.slot)
            throw new Error(`${at} is not in this presentation (${built.slides.length} slides).`);
          index = found.locator.from - 1;
        } else {
          const top = scrollRef.current!.getBoundingClientRect().top;
          index = Math.max(
            0,
            slots.current.findIndex((slot) => slot.frame.getBoundingClientRect().bottom > top + 8),
          );
        }
        await ensureRendered(index);
        const slot = slots.current[index];
        const raster = await rasterize(slot.handle!.element, {
          maxWidth,
          context: slot.host,
          background: "#fff",
        });
        return { ...raster, at: at ?? `slide:${index + 1}` };
      },
      // 【契约】zoom 与 fit 是空实现，幻灯片恒适宽，调用方不得依赖返回值或缩放状态
      zoom() {},
      fit() {},
      async find(query) {
        if (!query.trim()) {
          this.clearFind();
          return 0;
        }
        // 查找依赖 DOM Range，未渲染的页里没有文字节点，因此先全部渲染（懒加载页会被一并初始化）。
        await Promise.all(slots.current.map((_, i) => ensureRendered(i)));
        const ranges = slots.current.flatMap((slot) => findAllRanges(slot.host, query));
        find.current = ranges.length ? { ranges, current: -1 } : null;
        paint();
        return ranges.length;
      },
      findGo(index) {
        const state = find.current;
        if (!state?.ranges[index]) return;
        state.current = index;
        paint();
        scrollToRange(state.ranges[index], "center");
      },
      clearFind() {
        find.current = null;
        paint();
      },
      clearSelection() {
        for (const slot of slots.current) outline(slot, null, "selected");
        if (scrollRef.current && selectionIn(scrollRef.current))
          document.getSelection()?.removeAllRanges();
      },
      goToPage(page) {
        const slot = slots.current[Math.min(Math.max(1, page), slots.current.length) - 1];
        if (slot) scrollToElement(slot.frame, "start");
      },
      // 缩略图按页缓存（画册会反复请求同一页）；缓存的是已渲染 DOM 与句柄，卸载时统一 dispose。
      // 【生命周期】缩略图句柄与主列表句柄并列持有，卸载时同样需要逐个释放
      // 【并发】并发请求同一页会命中同一缓存项，先写入再等待就绪，避免重复渲染同页
      // 【权衡】缩略图只在包装层做 transform，渲染仍按原始尺寸，保证画册与正文视觉一致
      async thumbnail(page, thumbWidth) {
        const built = presentation.current;
        if (!built) throw new Error("The presentation is still loading.");
        const cached = thumbs.current.get(page);
        if (cached) return cached.element;
        const slide = built.slides[page - 1];
        materializeSlideNodes(built, slide);
        const handle = renderSlide(built, slide, {
          mediaUrlCache: mediaCache.current,
          pdfjs: false,
        });
        const thumbScale = thumbWidth / built.width;
        const element = document.createElement("div");
        element.className = "slide-thumb";
        element.style.width = `${thumbWidth}px`;
        element.style.height = `${built.height * thumbScale}px`;
        const inner = document.createElement("div");
        inner.className = "slide-host";
        inner.style.width = `${built.width}px`;
        inner.style.height = `${built.height}px`;
        inner.style.transform = `scale(${thumbScale})`;
        inner.append(handle.element);
        element.append(inner);
        thumbs.current.set(page, { element, handle });
        await handle.ready.catch(() => undefined);
        return element;
      },
    }),
    [],
  );

  return (
    <div ref={scrollRef} className={`viewer-scroll pptx-scroll${glance ? " glance" : ""}`}>
      <div ref={listRef} className="slide-list" />
    </div>
  );
});
