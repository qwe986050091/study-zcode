// INV-01 留白灯优先于状态灯：守住位置 stationLampClass 首支；改错故障 等待留白显示成运行灯。
// INV-02 已补全留白回到普通灯：守住位置 state 判断；改错故障 补全后仍是虚线。
// INV-03 等待留白用警示描边：守住位置 warning 分支；改错故障 等待态不可辨。
// INV-04 其余留白用最浅描边：守住位置 默认分支；改错故障 留白比实体更抢眼。
// INV-05 运行灯带呼吸光晕：守住位置 wf-lamp-running；改错故障 画面失去唯一动效焦点。
// INV-06 减少动效时关闭呼吸：守住位置 motion-reduce；改错故障 前庭敏感用户被迫看动画。
// INV-07 双线段用于并行两站：守住位置 Segment 首支；改错故障 并行被画成单线。
// INV-08 两条线相距两像素：守住位置 top 偏移；改错故障 双线黏成一条。
// INV-09 单线段缺轨道时隐藏：守住位置 invisible 分支；改错故障 空段出现接缝。
// INV-10 线宽固定一像素：守住位置 border-t；改错故障 檐与主轨粗细不一致。
// INV-11 墨色随轨道数据变化：守住位置 data-ledge-ink；改错故障 分叉与汇合无法区分。
// INV-12 空索引直接不渲染：守住位置 首行返回；改错故障 空檐占位。
// INV-13 超过五枚折叠为加号：守住位置 ledgeLamps；改错故障 檐被灯挤爆。
// INV-14 靠内容一侧接短轨道：守住位置 stub 三元；改错故障 檐与内容断开。
// INV-15 每枚灯是可点按钮：守住位置 button 元素；改错故障 键盘无法回到折叠站。
// INV-16 标签含站名与状态：守住位置 aria-label；改错故障 读屏只剩编号。
// INV-17 左右两侧镜像排列：守住位置 末尾三元；改错故障 加号与短轨位置颠倒。
// INV-18 滚动条点击到此终止：守住位置 stopClick；改错故障 拖拇指折叠宿主卡片。
//
// 模块职责：时间线边檐灯带与底部滚动条。
// 状态所有权：拖动状态与指针标识为滚动条局部状态；视口数据由外部传入。
// 阅读顺序：先看灯样式，再读轨道段，最后看边檐与滚动条。
import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { TimelineHole } from "./timeline-holes.js";
import type { TimelineRail, TimelineStation } from "./timeline-model.js";
import { LEDGE_PITCH, LEDGE_LAMP, ledgeLamps, railKey, scrollbarThumb } from "./timeline-ledge.js";
import type { TimelineViewport } from "./use-timeline-viewport.js";

/**
 * 边檐与滚动条。
 *
 * 边檐：折叠到视口一侧的站，画成一排同一枚 10px 灯（16px 一枚），之间是那条边的墨色小轨道段，
 * 靠内容的一端一段短轨道接到第一个开着的站，远端是超出五枚时的 `+n`。每枚灯是按钮：点一下，
 * 镜头把那一站带回来。折叠的站在内容里不画——檐上那枚灯**就是**它。
 *
 * 滚动条：时间线底部 2px 一根，轨道 border 色、拇指 foreground-subtlest；静止时 opacity 0，指针在
 * 卡上或正在滚时露出，悬停轨道加粗到 4px；拇指可拖，点轨道翻页。原生滚动条隐藏。
 */

/** 站灯：`STATUS_DOT` 词汇表，running 外加 3px 光晕（呼吸）——它是画面上唯一发光的东西。 */
export function stationLampClass(
  status: StepRunStatus | undefined,
  /**
   * 留白灯（docs/dynamic-workflow/presentation.md「Holes on the timeline」）：开着 / 等着的留白是一枚
   * 1.5px 虚线、无填充的灯；等待时描边换警示色、外加 3px 常亮的光晕——**不搏动**，那里没有东西在跑。
   * 补全后就是普通的灯。三处画灯的地方（轨道行、带的灯层、边檐）都经这里，留白在哪都长一样。
   */
  hole?: TimelineHole,
): string {
  if (hole !== undefined && hole.state !== "filled") {
    return cn(
      "wf-lamp wf-lamp-hole size-2.5 shrink-0 rounded-full border-[1.5px] border-dashed bg-transparent",
      hole.state === "waiting"
        ? "wf-lamp-hole-waiting border-warning"
        : "border-foreground-subtlest",
    );
  }
  const resolved = status ?? "pending";
  return cn(
    "wf-lamp size-2.5 shrink-0 rounded-full",
    STATUS_DOT[resolved],
    resolved === "running" && "wf-lamp-running motion-reduce:animate-none",
  );
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// 补线需与静态主轨道同为 1px，避免滚动边缘出现粗细接缝。
// 双线段：檐上两站并行时不是一条线，
// 而是两条 1px、相距 2px——檐把带压扁了，分叉与汇合画不下，两条并排的线是这里唯一还说得出
// 「同时」的记号。
// rail 缺省时整段 invisible 占位，宽度固定取调用方给的 width；墨色写进 data-ledge-ink 供样式钩子读。
function Segment({ rail, width }: { rail: TimelineRail | undefined; width: number }) {
  if (rail?.kind === "twin") {
    return (
      <span
        aria-hidden
        className="relative h-0 shrink-0"
        data-ledge-ink={rail.ink}
        data-ledge-twin="true"
        style={{ width }}
      >
        <span
          className="absolute inset-x-0 h-0 border-t border-foreground-subtlest"
          style={{ top: -1 }}
        />
        <span
          className="absolute inset-x-0 h-0 border-t border-foreground-subtlest"
          style={{ top: 1 }}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "h-0 shrink-0 border-t border-foreground-subtlest",
        rail === undefined && "invisible",
      )}
      data-ledge-ink={rail?.ink ?? "none"}
      style={{ width }}
    />
  );
}

// indexes 为空返回 null；超过五枚时折叠成 `+{more}`（分界由 ledgeLamps 决定），檐不撑开。
// 灯本身是 button，aria-label 与 title 都是「站名 · 状态」；stub 与 `+n` 按 side 排且 stub 永远靠内容一侧。
export function WorkflowLedge({
  indexes,
  nameOf,
  onSelect,
  rails,
  side,
  stations,
  stubWidth,
  top,
}: {
  side: "left" | "right";
  /** 折叠到这一侧的站（升序）。 */
  indexes: readonly number[];
  stations: readonly TimelineStation[];
  /** 相邻站之间的轨道段，按**一对站**索引（`railKey`）：带里一站会长出好几条段。 */
  rails: ReadonlyMap<string, TimelineRail>;
  /** 檐到第一个开着的站之间那段短轨道的宽；0 = 不画。 */
  stubWidth: number;
  /** 轨道行的顶（檐与灯同高）。 */
  top: number;
  nameOf: (index: number) => string;
  onSelect: (index: number) => void;
}) {
  const { intl } = useZCodeIntl();
  if (indexes.length === 0) return null;
  const { shown, more } = ledgeLamps(indexes, side);
  const stubRail =
    side === "left"
      ? rails.get(railKey(indexes[indexes.length - 1]!, indexes[indexes.length - 1]! + 1))
      : rails.get(railKey(indexes[0]! - 1, indexes[0]!));
  const stub = stubWidth > 0 ? <Segment rail={stubRail} width={stubWidth} /> : null;
  const count =
    more > 0 ? (
      <span
        className="shrink-0 text-center font-mono text-ui-2xs text-foreground-subtlest"
        data-testid="workflow-timeline-ledge-more"
        style={{ width: 26 }}
      >
        +{more}
      </span>
    ) : null;
  const lamps = shown.map((index, k) => {
    const station = stations[index]!;
    const label = `${nameOf(index)} · ${intl.formatMessage({ id: `chat.toolCall.workflow.graph.status.${station.status ?? "pending"}` })}`;
    return (
      <span className="flex items-center" key={station.id}>
        {k > 0 ? (
          <Segment
            rail={rails.get(railKey(shown[k - 1]!, index))}
            width={LEDGE_PITCH - LEDGE_LAMP}
          />
        ) : null}
        <button
          aria-label={label}
          className="wf-ledge-lamp relative flex shrink-0 cursor-pointer items-center justify-center rounded-full outline-none before:absolute before:-inset-1 before:content-[''] focus-visible:ring-2 focus-visible:ring-ring/40"
          data-station-index={index}
          data-testid="workflow-timeline-ledge-lamp"
          onClick={() => onSelect(index)}
          style={{ height: LEDGE_LAMP, width: LEDGE_LAMP }}
          title={label}
          type="button"
        >
          <span
            aria-hidden
            className={cn(stationLampClass(station.status, station.hole), "wf-land")}
            data-lamp={station.status ?? "pending"}
          />
        </button>
      </span>
    );
  });
  return (
    <div
      aria-label={intl.formatMessage(
        { id: `chat.toolCall.workflow.timeline.ledge.${side === "left" ? "earlier" : "later"}` },
        { count: indexes.length },
      )}
      className={cn(
        "wf-ledge pointer-events-auto absolute flex h-6 items-center",
        side === "left" ? "left-0 pl-2" : "right-0 pr-2",
      )}
      data-testid={`workflow-timeline-ledge-${side}`}
      role="group"
      style={{ top }}
    >
      {side === "left" ? count : stub}
      {lamps}
      {side === "left" ? stub : count}
    </div>
  );
}

/**
 * 拖完拇指或点完轨道，浏览器还会补发一次 click，它会沿着 DOM 冒到宿主卡片——轮尾摘要卡把
 * 「空白处点一下」当成折叠 / 展开，而它的子控件谓词只认 button / a / 表单件，不认 scrollbar。
 * 用户拖一下滑块，卡片就折起来了。滚动条的点击到此为止：它已经把这次交互消费掉了。
 */
function stopClick(event: ReactMouseEvent<HTMLDivElement>) {
  event.stopPropagation();
}

// thumb 为 undefined（内容不宽于视口）时整条不渲染；拖动按 pointerId 跟踪，位移 × ratio 换算成滚动量。
// 点轨道翻半屏；prefersReducedMotion() 时改为瞬时滚动，结束时的 click 由 stopClick 截住不冒到卡片。
export function WorkflowTimelineScrollbar({
  scrollRef,
  viewport,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  viewport: TimelineViewport;
}) {
  const { intl } = useZCodeIntl();
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startLeft: number } | null>(null);
  const thumb = scrollbarThumb(viewport.scrollLeft, viewport.clientWidth, viewport.scrollWidth);
  if (thumb === undefined) return null;
  const range = viewport.scrollWidth - viewport.clientWidth;
  const ratio = viewport.scrollWidth / viewport.clientWidth;

  const onThumbDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    event.preventDefault();
    drag.current = {
      pointerId: event.pointerId,
      startLeft: viewport.scrollLeft,
      startX: event.clientX,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onThumbMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const state = drag.current;
    const element = scrollRef.current;
    if (state === null || element === null || state.pointerId !== event.pointerId) return;
    element.scrollLeft = state.startLeft + (event.clientX - state.startX) * ratio;
  };
  const onThumbUp = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(false);
  };
  const onTrackDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const element = scrollRef.current;
    if (element === null) return;
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const direction = x < thumb.left ? -1 : 1;
    element.scrollBy({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      left: direction * viewport.clientWidth,
    });
  };
  return (
    <div
      aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.timeline.scrollbar" })}
      aria-orientation="horizontal"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.round((100 * Math.min(viewport.scrollLeft, range)) / range)}
      className="wf-sb absolute inset-x-0 bottom-0 h-0.5 cursor-pointer rounded-full bg-border"
      data-dragging={dragging ? "true" : undefined}
      data-scrolling={viewport.scrolling ? "true" : undefined}
      data-testid="workflow-timeline-scrollbar"
      onClick={stopClick}
      onPointerDown={onTrackDown}
      role="scrollbar"
    >
      <span
        className="wf-sb-thumb absolute inset-y-0 rounded-full bg-foreground-subtlest"
        data-testid="workflow-timeline-scrollbar-thumb"
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={onThumbUp}
        style={{ left: thumb.left, width: thumb.width }}
      />
    </div>
  );
}
