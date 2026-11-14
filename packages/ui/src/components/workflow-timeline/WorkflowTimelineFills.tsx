// INV-01 新鲜窗口两秒：守住位置 FILL_FRESH_MS；改错故障 新补全不再高亮。
// INV-02 只按补全身份与时刻重算：守住位置 稳定键 key；改错故障 定时器每帧重置。
// INV-03 时钟只在新鲜窗口内存在：守住位置 compute 与定时器；改错故障 常驻计时持续渲染。
// INV-04 统一按最新到期时刻清空：守住位置 最新时刻求和；改错故障 先到的补全提前熄灭。
// INV-05 定时器卸载即清理：守住位置 effect 返回函数；改错故障 卸载后仍写状态。
// INV-06 空集合不设定时器：守住位置 空集提前返回；改错故障 空转计时浪费。
// INV-07 头识别只认元素：守住位置 元素类型判断；改错故障 图标目标被忽略。
// INV-08 内部模式也认笔标：守住位置 查询分支；改错故障 站头按钮取不到补全。
// INV-09 非可见焦点不画框：守住位置 可见焦点判断；改错故障 点击后框常亮。
// INV-10 旧环境不抛错：守住位置 try 包裹；改错故障 旧测试环境直接报错。
// INV-11 悬停优先于焦点：守住位置 空值合并顺序；改错故障 鼠标与键盘状态互相覆盖。
// INV-12 禁用时不挂委托：守住位置 三元返回；改错故障 禁用组件仍响应指针。
// INV-13 行宽按起始列归档：守住位置 Map 键；改错故障 多行图例互相覆盖。
// INV-14 宽度未变复用旧对象：守住位置 深度比较；改错故障 每次提交都重渲染。
// INV-15 尺寸变化由观察者补量：守住位置 尺寸观察器；改错故障 字体缩放后遮罩错位。
// INV-16 量不到宽度时框照画：守住位置 零宽回退；改错故障 测试环境整块不渲染。
// INV-17 同起点的头排成一行：守住位置 按起始列分组；改错故障 同起点头重叠。
// INV-18 一次只亮一个框：守住位置 单值活动项；改错故障 嵌套补全叠加高亮。
//
// `WorkflowTimelineFills` 渲染补全的头行与描边框；新鲜判定归 `useFreshFills`，活动项与行宽分别归 `useFillHeadTarget` 与 `useRowWidths`。
// 状态所有权：新鲜集合由 hook 自维护；活动补全由调用方传入。
// 阅读顺序：先看新鲜判定，再读头识别与行宽测量，最后看头与框渲染。
import { PenIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { TimelineFill } from "./timeline-holes.js";
import { framePath, legendGaps, type TimelineFrame } from "./timeline-frames.js";
import { HEAD_ROW, MARK_X, stationX } from "./timeline-geometry.js";

/** 补全接进 run 之后框自己画一遍、头染警示色的时长（docs/dynamic-workflow/presentation.md「The stroke」）。 */
export const FILL_FRESH_MS = 2_000;

/**
 * 哪些补全此刻「新鲜」：`filledAt` 之后两秒内。用 state + 定时器而不是每帧读时钟：模型没有时间，
 * 时钟只在这里、只为这两秒存在。有头的补全与无阶段的补全（笔标）一视同仁。
 */
// `useFreshFills` 的 effect 依赖是 `key`（`holeId@filledAt` 串）：`fills` 每帧都是新数组引用，直接依赖会让定时器每帧重置、两秒永远走不完。
// `next.size === 0` 时不建定时器；否则按最晚到期时刻算 `latest + FILL_FRESH_MS - now` 一次性 `setFresh(new Set())`，`clearTimeout` 挂在该 effect 的清理函数上。
export function useFreshFills(
  fills: readonly { holeId: string; filledAt?: number }[],
): ReadonlySet<string> {
  const compute = () => {
    const now = Date.now();
    return new Set(
      fills
        .filter((fill) => fill.filledAt !== undefined && now - fill.filledAt < FILL_FRESH_MS)
        .map((fill) => fill.holeId),
    );
  };
  const [fresh, setFresh] = useState<ReadonlySet<string>>(compute);
  const key = fills.map((fill) => `${fill.holeId}@${fill.filledAt ?? ""}`).join("\u0000");
  useEffect(() => {
    const next = compute();
    setFresh(next);
    if (next.size === 0) return undefined;
    const now = Date.now();
    const latest = Math.max(
      ...fills.filter((fill) => next.has(fill.holeId)).map((fill) => fill.filledAt ?? now),
    );
    const timer = setTimeout(() => setFresh(new Set()), Math.max(0, latest + FILL_FRESH_MS - now));
    return () => clearTimeout(timer);
    // 只按补全的身份与时刻重算（`key`）：`fills` 数组每帧是新引用，按它依赖会让定时器每帧重置。
  }, [key]);
  return fresh;
}

/** 事件目标所属的补全头（`data-fill-head`）；`inside` 时也认目标里面的笔标（站头按钮拿到焦点）。 */
// `fillHeadOf` 先 `closest([data-fill-head])`；`inside` 为真时才回落到目标内部的笔标，站头按钮拿焦点时命中的是内部元素。
// 目标不是 `Element`（如 `window`）时直接返回 `undefined`，`dataset.fillHead` 是唯一取值来源，不读类名。
// `fillHeadOf` 不读事件坐标也不派发事件，只按 `data-fill-head` 归属返回 `holeId`。
function fillHeadOf(target: EventTarget, inside: boolean): string | undefined {
  // 指针常落在头里的笔图标上——那是 SVGElement，不是 HTMLElement，所以认 Element。
  if (!(target instanceof Element)) return undefined;
  const owner =
    target.closest<HTMLElement>("[data-fill-head]") ??
    (inside ? target.querySelector<HTMLElement>("[data-fill-head]") : null);
  return owner?.dataset.fillHead;
}

function focusVisible(target: EventTarget): boolean {
  if (!(target instanceof Element)) return false;
  try {
    return target.matches(":focus-visible");
  } catch {
    // 不认 :focus-visible 的环境（旧 jsdom）：当作指针点出来的焦点，不画框。
    return false;
  }
}

/**
 * 哪一个框此刻该画（卡与侧板共用）：挂在根上的委托只认**头**——`data-fill-head` 的元素（卡上的头、
 * 侧板的标题行、无阶段补全的笔标）。指针在上面，或 focus-visible 的焦点在上面（站头按钮里带笔标的
 * 也算）。只认 focus-visible：点头开侧板时焦点留在头上，不该让框一直亮着。`enabled` 为假时不挂委托。
 */
// `useFillHeadTarget` 把 `hovered` 与 `focused` 分开存；`active` 取 `hovered ?? focused`；指针离开只清 `hovered`；键盘焦点仍能维持高亮。
// `onFocus` 只在 `focusVisible` 为真时记录，否则点头开侧板后焦点留在头上会让框常亮；`enabled` 为假时返回空 handlers，不挂委托。
export function useFillHeadTarget(enabled: boolean): {
  active: string | undefined;
  handlers: {
    onPointerOver?: (event: PointerEvent<HTMLDivElement>) => void;
    onPointerLeave?: () => void;
    onFocus?: (event: FocusEvent<HTMLDivElement>) => void;
    onBlur?: () => void;
  };
} {
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  const [focused, setFocused] = useState<string | undefined>(undefined);
  const onPointerOver = useCallback((event: PointerEvent<HTMLDivElement>) => {
    setHovered(fillHeadOf(event.target, false));
  }, []);
  const onPointerLeave = useCallback(() => setHovered(undefined), []);
  const onFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    setFocused(focusVisible(event.target) ? fillHeadOf(event.target, true) : undefined);
  }, []);
  const onBlur = useCallback(() => setFocused(undefined), []);
  return enabled
    ? { active: hovered ?? focused, handlers: { onBlur, onFocus, onPointerLeave, onPointerOver } }
    : { active: undefined, handlers: {} };
}

/**
 * 头那几行的宽度（图例在框的上缘上挖的空）：每次提交后量一遍，字体或文案变了由 ResizeObserver 补量。
 * 量不到（jsdom、首帧之前）时为空——框照画，只是不挖空。
 */
// `rows` 以起始列 `from` 为键存元素，`measure` 逐项读 `offsetWidth`；`widths` 与旧对象逐键相等时返回原引用，避免无谓重渲染。
// `useLayoutEffect` 在提交后立即量一次；`ResizeObserver` 在 `key` 变化后对全部元素重新 `observe`；卸载时 `disconnect`。
function useRowWidths(key: string): {
  refFor: (from: number) => (element: HTMLElement | null) => void;
  widths: Readonly<Record<number, number>>;
} {
  const rows = useRef(new Map<number, HTMLElement>());
  const [widths, setWidths] = useState<Readonly<Record<number, number>>>({});
  const measure = useCallback(() => {
    const next: Record<number, number> = {};
    for (const [from, element] of rows.current) next[from] = element.offsetWidth;
    setWidths((previous) => {
      const same =
        Object.keys(previous).length === Object.keys(next).length &&
        Object.entries(next).every(([from, width]) => previous[Number(from)] === width);
      return same ? previous : next;
    });
  }, []);
  useLayoutEffect(measure);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    for (const element of rows.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [key, measure]);
  const refFor = useCallback(
    (from: number) => (element: HTMLElement | null) => {
      if (element === null) rows.current.delete(from);
      else rows.current.set(from, element);
    },
    [],
  );
  return { refFor, widths };
}

/**
 * 补全的头与框（docs/dynamic-workflow/presentation.md「Holes on the timeline」）。
 *
 * 头：只在有补全的时间线上存在的 24px 一行，笔（12px）对准第一枚新灯的 x，留白的名字（caption、
 * medium、subtle、300px 截断）。没有底、没有线。点它开侧板、落到补全的标题。它（与无阶段补全的笔标）
 * 带 `data-fill-head`：时间线只从这里读悬停与键盘焦点，站与药丸不再点亮任何东西。
 * 框：`timeline-frames.ts` 算好的外接矩形，一条 `pathLength` 为 1 的路径；`data-fill-on` 时虚线偏移
 * 从 1 走到 0（一笔画出，420ms），离开时整根线 160ms 淡出。新鲜的两秒里它带 `wf-fill-frame-fresh`
 * 自己画一遍（动画而不是过渡：它挂载的那一帧就已经是亮的）。头那几行在上缘上挖空（遮罩），所以
 * 头是图例，而且不管时间线落在哪种底上都成立。一次只亮一个框：嵌套的补全不叠。
 * 嵌套的补全与外层同起于一列时，内层的头排在外层的头之后：外层头的右缘再过 12px，同一行——同起点的头
 * 放进同一个 flex 行（gap 12px），由布局而不是量宽度得出；起点不同的头各自对准自己的第一盏灯。
 */
export function WorkflowTimelineFills({
  active,
  fills,
  frames,
  fresh,
  height,
  inset,
  onOpenFill,
  width,
}: {
  fills: readonly TimelineFill[];
  /** 每次补全一个框（有头的与无阶段的都在，`timelineFrames`）。 */
  frames: readonly TimelineFrame[];
  /** 此刻画出的那一个框：指针在它的头上，或键盘焦点在头上。 */
  active: string | undefined;
  fresh: ReadonlySet<string>;
  height: number;
  width: number;
  inset: number;
  onOpenFill?: (fill: TimelineFill) => void;
}) {
  const { intl } = useZCodeIntl();
  const maskId = `wf-fill-legend-${useId().replace(/:/gu, "")}`;
  // 模型按 from 升序、同起点外层在前，所以同起点的头按同一顺序排成一行。
  const headRows = new Map<number, TimelineFill[]>();
  for (const fill of fills) {
    const row = headRows.get(fill.from);
    if (row === undefined) headRows.set(fill.from, [fill]);
    else row.push(fill);
  }
  const rowLeft = (from: number): number => stationX(from, inset) + MARK_X - 6;
  const { refFor, widths } = useRowWidths([...headRows.keys()].join(","));
  if (frames.length === 0 && fills.length === 0) return null;
  const gaps = legendGaps(
    [...headRows.keys()].map((from) => ({ left: rowLeft(from), width: widths[from] ?? 0 })),
  );

  const renderHead = (fill: TimelineFill) => {
    const isFresh = fresh.has(fill.holeId);
    const on = active === fill.holeId;
    const time =
      fill.filledAt === undefined ? undefined : new Date(fill.filledAt).toLocaleTimeString();
    const title = intl.formatMessage(
      {
        id:
          time === undefined
            ? "chat.toolCall.workflow.hole.head.title.untimed"
            : "chat.toolCall.workflow.hole.head.title",
      },
      { name: fill.name, time: time ?? "" },
    );
    const body = (
      <>
        <PenIcon aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 max-w-[300px] truncate text-ui-caption font-medium">
          {fill.name}
        </span>
      </>
    );
    const className = cn(
      "wf-fill-head flex h-full items-center gap-1.5 whitespace-nowrap rounded-md",
      isFresh ? "wf-land text-warning" : on ? "text-foreground" : "text-foreground-subtle",
      onOpenFill !== undefined &&
        "cursor-pointer outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
    );
    const shared = {
      className,
      "data-fill-head": fill.holeId,
      "data-fill-on": on ? "true" : undefined,
      "data-testid": "workflow-timeline-fill-head",
      title,
    };
    return onOpenFill === undefined ? (
      <span key={fill.holeId} {...shared}>
        {body}
      </span>
    ) : (
      <button key={fill.holeId} onClick={() => onOpenFill(fill)} type="button" {...shared}>
        {body}
      </button>
    );
  };
  return (
    <>
      {/* 框在一切之下：灯与轨道画在它的边上。 */}
      <svg
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 overflow-visible"
        data-testid="workflow-timeline-fill-frames"
        height={height}
        width={width}
      >
        {gaps.length === 0 ? null : (
          <defs>
            <mask
              height={height + 40}
              id={maskId}
              maskUnits="userSpaceOnUse"
              width={width + 40}
              x={-20}
              y={-20}
            >
              <rect fill="white" height={height + 40} width={width + 40} x={-20} y={-20} />
              {gaps.map((gap) => (
                <rect
                  fill="black"
                  height={HEAD_ROW}
                  key={gap.x}
                  width={gap.width}
                  x={gap.x}
                  y={0}
                />
              ))}
            </mask>
          </defs>
        )}
        {frames.map((frame) => {
          const isFresh = fresh.has(frame.holeId);
          return (
            <path
              className={cn("wf-fill-frame", isFresh && "wf-fill-frame-fresh")}
              d={framePath(frame.box)}
              data-fill-frame={frame.holeId}
              data-fill-fresh={isFresh ? "true" : undefined}
              data-fill-on={isFresh || active === frame.holeId ? "true" : undefined}
              data-testid="workflow-timeline-fill-frame"
              key={frame.holeId}
              {...(gaps.length === 0 ? {} : { mask: `url(#${maskId})` })}
              pathLength={1}
            />
          );
        })}
      </svg>
      {[...headRows].map(([from, row]) => (
        // 笔心对准灯心：灯心在站左缘 + MARK_X，笔 12px 宽、左缘再退 6。同起点的第二个头接在前一个之后 12px。
        <span
          className="absolute flex items-center gap-3"
          data-testid="workflow-timeline-fill-heads"
          key={from}
          ref={refFor(from)}
          style={{ height: HEAD_ROW, left: rowLeft(from), top: 0 }}
        >
          {row.map(renderHead)}
        </span>
      ))}
    </>
  );
}
