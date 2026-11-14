// INV-01 双线段不画：守住位置 跳过；改错故障 卡上出现重复轨道。
// INV-02 无前驱长尾巴：守住位置 尾巴段；改错故障 首站轨道缺失。
// INV-03 无汇合长残段：守住位置 残段；改错故障 末站轨道悬空。
// INV-04 分支离开主线有固定偏移：守住位置 偏移公式；改错故障 分叉点重叠。
// INV-05 分支先升后横：守住位置 路径顺序；改错故障 曲线穿过灯。
// INV-06 汇合是分叉镜像：守住位置 镜像公式；改错故障 汇合落点错位。
// INV-07 跨带普通段走主线：守住位置 带不同判断；改错故障 相邻带之间断线。
// INV-08 缺带时跳过：守住位置 空值判断；改错故障 越界访问。
// INV-09 流轨中间断开：守住位置 缺口常量；改错故障 箭头与线重叠。
// INV-10 首尾点与路径同源：守住位置 返回结构；改错故障 渐变方向错。
// INV-11 段键包含两端：守住位置 键拼接；改错故障 并行边键冲突。
// INV-12 墨色三档映射：守住位置 常量表；改错故障 行进边颜色错误。
// INV-13 渐变标识清洗：守住位置 替换非法字符；改错故障 标识含冒号失效。
// INV-14 折叠站引线同淡出：守住位置 类名条件；改错故障 引线残留。
// INV-15 分支引线点状：守住位置 描边样式；改错故障 引线与主线混淆。
// INV-16 灯仍为 DOM：守住位置 组件选择；改错故障 状态类无法生效。
// INV-17 灯按轨道行定位：守住位置 取行回退；改错故障 灯落到零轨。
// INV-18 补全滑入复用样式：守住位置 工具函数；改错故障 插入列后灯不跟随。
//
// 模块职责：时间线带视图的轨道层与灯层绘制。
// 状态所有权：几何来自布局对象，折叠态由上层传入。
// 阅读顺序：先看轨道段纯函数，再看分支路径，最后看两个渲染组件。
import { useId } from "react";
import { cn } from "@/components/lib/utils.js";
import type {
  TimelineBand,
  TimelineInk,
  TimelineStation,
  WorkflowTimelineModel,
} from "./timeline-model.js";
import {
  bandAt,
  bandForkX,
  bandMergeX,
  lampX,
  STUB,
  TAIL,
  type TimelineLayout,
} from "./timeline-geometry.js";
import { MarchLight } from "./WorkflowMarchLight.js";
import { STREAM_GAP, StreamChevrons } from "./WorkflowStreamChevrons.js";
import { stationLampClass } from "./WorkflowTimelineLedge.js";
import { slideClass, slideStyle, type FillSlide } from "./use-fill-growth.js";

/**
 * 轨道层。
 *
 * 没有带的时间线里轨道段还是站头行里的一截 border（逐像素不动）。**有带**时整条轨道搬进弧那一层
 * SVG：主线走最下面一行、分支轨道叠在它上面，带前分叉、带后汇合，两段 8px 的四分之一圆把分支
 * 抬上去再放下来（分支向上）。灯仍是 DOM（状态类要
 * 用），绝对定位落在自己那条轨道的行上；站头搬到站台行，分支轨道的站用一条点状引线接回自己的名字。
 */
const INK_STROKE: Record<TimelineInk, string> = {
  faint: "var(--color-workflow-trace)",
  march: "var(--color-workflow-trace-strong)",
  strong: "var(--color-workflow-trace-strong)",
};

/** 画布上的一个点。 */
export interface TimelinePoint {
  x: number;
  y: number;
}

/** 画面上的一段轨道：一条路径、一种墨，外加它接的两站（测试与调试的抓手）。 */
export interface TimelineRailPiece {
  key: string;
  d: string;
  /**
   * 路径的首尾两点，与 `d` 出自同一组数——行进边的光要按这两点铺渐变（`MarchLight`），
   * 而不是回头去解析 `d`。
   */
  start: TimelinePoint;
  end: TimelinePoint;
  ink: TimelineInk;
  /**
   * `fork` / `merge` 是带两端的曲线；`tail` / `stub` 是没有前驱 / 汇合站时主线的那一小截；`stream`
   * 是一条轨道上的流轨——路径在正中断开 `STREAM_GAP`，`chevrons` 是缺口的中心。
   */
  kind?: "fork" | "merge" | "tail" | "stub" | "stream";
  chevrons?: TimelinePoint;
  from?: number;
  to?: number;
}

/** 路径与它的首尾两点：`timelineRailPieces` 里每种段都先算出这三样，再配上墨与两站。 */
type RailShape = Pick<TimelineRailPiece, "d" | "end" | "start">;

/**
 * 轨道段 → 路径（纯函数）。一条轨道上的普通段是那一行上的一条直线（灯 + 8 → 灯 − 8）；主线的
 * 那几条穿过分叉点与汇合点，于是主线自然是一条直线。两端都在**不同的带**里的普通段只可能是
 * 相邻两带之间的那一段，画在主线上、从前一带的汇合点到后一带的分叉点。双线段不画在卡上。
 */
// 双线段只在卡上表达「并行」，timelineRailPieces 里直接 continue 跳过。
// 首站没有前驱时补 TAIL 尾巴段，主线不从半途开始。
// 末站没有汇合时补 STUB 残段，主线不悬空收尾。
// 两端跨带的普通段只可能落在相邻 band，沿主线从上一带汇合点画到下一带分叉点。
// 段键拼上 from / to 两端站号，并行边不会键冲突。
export function timelineRailPieces(
  model: Pick<WorkflowTimelineModel, "bands" | "rails" | "stations">,
  layout: TimelineLayout,
): TimelineRailPiece[] {
  const { bands, rails, stations } = model;
  const { inset, rowY } = layout;
  const y0 = rowY[0]!;
  const rowOf = (track: number): number => rowY[track] ?? y0;
  const lx = (i: number): number => lampX(i, inset);
  const forkX = (band: TimelineBand): number => bandForkX(band, inset);
  const mergeX = (band: TimelineBand): number => bandMergeX(band, inset);
  const trackOfStation = (i: number): number => stations[i]?.track ?? 0;

  /** 一行上的一条直线段。 */
  const straight = (x1: number, x2: number, y: number): RailShape => ({
    d: `M${x1},${y} H${x2}`,
    end: { x: x2, y },
    start: { x: x1, y },
  });
  // 分支轨道 t 在 forkX − 8(t−1) 处离开主线，两段四分之一圆升到自己的行，再横到第一枚灯前 8px。
  // 起点落在主线 rowY 的 y0 行，forkX 处开始抬升。
  // 用 Q 曲线升到 track 自己的 yt 行，四分之一圆半径固定 8px。
  // 抬升后横到 head 灯前 8px，接上灯的左侧。
  // xf 按 forkX(band) - 8*(track-1) 计算，多轨分支依次错开。
  // 返回 d 与 start / end 两点，供 MarchLight 铺渐变。
  const forkPath = (band: TimelineBand, track: number, head: number): RailShape => {
    const xf = forkX(band) - 8 * (track - 1);
    const yt = rowOf(track);
    return {
      d: `M${xf},${y0} Q${xf + 8},${y0} ${xf + 8},${y0 - 8} V${yt + 8} Q${xf + 8},${yt} ${xf + 16},${yt} H${lx(head) - 8}`,
      end: { x: lx(head) - 8, y: yt },
      start: { x: xf, y: y0 },
    };
  };
  // 汇合是分叉的镜像：从末站的灯后 8px 横到 xm − 8，落回主线。带里轨道越高，落点越靠左。
  const mergePath = (band: TimelineBand, track: number, tail: number): RailShape => {
    const xm = mergeX(band) - 8 * (band.tracks.length - 1 - track);
    const yt = rowOf(track);
    return {
      d: `M${lx(tail) + 8},${yt} H${xm - 8} Q${xm},${yt} ${xm},${yt + 8} V${y0 - 8} Q${xm},${y0} ${xm + 8},${y0}`,
      end: { x: xm + 8, y: y0 },
      start: { x: lx(tail) + 8, y: yt },
    };
  };

  const pieces: TimelineRailPiece[] = [];
  // 没有前驱 / 没有汇合站的带自己长出两端：主线的一小截尾巴 / 残段，和分支轨道的曲线——模型里
  // 没有对应的轨道段（分叉与汇合都要有那一站才成段），墨色取轨道自己的 entry / exit。
  for (const band of bands) {
    const main = band.tracks[0]!;
    if (band.pred === undefined) {
      const head = main.stations[0]!;
      pieces.push({
        ...straight(forkX(band) - TAIL, lx(head) - 8, y0),
        ink: main.entry,
        key: `tail:${band.from}`,
        kind: "tail",
        to: head,
      });
      band.tracks.forEach((track, t) => {
        if (t === 0) return;
        const first = track.stations[0]!;
        pieces.push({
          ...forkPath(band, t, first),
          ink: track.entry,
          key: `fork:${band.from}:${t}`,
          kind: "fork",
          to: first,
        });
      });
    }
    if (band.join === undefined) {
      const last = main.stations[main.stations.length - 1]!;
      pieces.push({
        ...straight(lx(last) + 8, mergeX(band) + STUB, y0),
        ink: main.exit,
        key: `stub:${band.to}`,
        kind: "stub",
        from: last,
      });
      band.tracks.forEach((track, t) => {
        if (t === 0) return;
        const end = track.stations[track.stations.length - 1]!;
        pieces.push({
          ...mergePath(band, t, end),
          ink: track.exit,
          key: `merge:${band.to}:${t}`,
          kind: "merge",
          from: end,
        });
      });
    }
  }

  for (const rail of rails) {
    // 双线段只说「这两站并行」，卡上不画——分叉与汇合已经把并行说清楚了。
    if (rail.kind === "twin") continue;
    const ends = { from: rail.from, ink: rail.ink, key: `${rail.from}>${rail.to}`, to: rail.to };
    if (rail.kind === "fork") {
      const band = bandAt(bands, rail.to);
      if (band === undefined) continue;
      pieces.push({ ...ends, ...forkPath(band, trackOfStation(rail.to), rail.to), kind: "fork" });
      continue;
    }
    if (rail.kind === "merge") {
      const band = bandAt(bands, rail.from);
      if (band === undefined) continue;
      pieces.push({
        ...ends,
        ...mergePath(band, trackOfStation(rail.from), rail.from),
        kind: "merge",
      });
      continue;
    }
    const source = bandAt(bands, rail.from);
    const target = bandAt(bands, rail.to);
    if (source !== undefined && target !== undefined && source !== target) {
      pieces.push({ ...ends, ...straight(mergeX(source), forkX(target), y0) });
      continue;
    }
    const yt = rowOf(trackOfStation(rail.from));
    const x1 = lx(rail.from) + 8;
    const x2 = lx(rail.to) - 8;
    if (rail.kind === "stream") {
      // 流轨（presentation.md「Stream rails」）：一条直线两笔，中间让出 chevron 的缺口。
      const mid = (x1 + x2) / 2;
      pieces.push({
        ...ends,
        chevrons: { x: mid, y: yt },
        d: `M${x1},${yt} H${mid - STREAM_GAP / 2} M${mid + STREAM_GAP / 2},${yt} H${x2}`,
        end: { x: x2, y: yt },
        kind: "stream",
        start: { x: x1, y: yt },
      });
      continue;
    }
    pieces.push({ ...ends, ...straight(x1, x2, yt) });
  }
  return pieces;
}

/**
 * 轨道与引线，画在弧那一层 SVG 里（只有带时才挂上）。行进的段照弧的老规矩叠一层，只是那一层
 * 如今是**不动的**光（`MarchLight`）：从段的起点淡入、在灯那一头最亮。
 */
// 先由 timelineRailPieces 算出全部轨道段，再逐段渲染。
// 渐变 id 用 useId 前缀加段 key，满足整张 SVG 内唯一。
// 底墨 path 与 MarchLight 分层绘制，光不覆盖线色。
// kind === "stream" 的段跳过 MarchLight，流只在 chevron 上着色。
// track !== 0 的站补一条 strokeDasharray="1 2" 的点状引线。
export function WorkflowTimelineTracks({
  folded,
  layout,
  model,
}: {
  model: Pick<WorkflowTimelineModel, "bands" | "rails" | "stations">;
  layout: TimelineLayout;
  /** 折到檐上的站：它的引线跟着灯一起淡出。 */
  folded: ReadonlySet<number>;
}) {
  const pieces = timelineRailPieces(model, layout);
  // 轨道层挂在弧那一层 SVG 里，渐变 id 要在整张 SVG 里唯一：实例前缀 + 段的 key（去掉 `:` `>` 这些）。
  const gradientBase = useId();
  return (
    <g>
      {pieces.map((piece) => (
        <g
          data-rail-from={piece.from}
          data-rail-ink={piece.ink}
          data-rail-kind={piece.kind}
          data-rail-to={piece.to}
          data-testid="workflow-timeline-rail"
          key={piece.key}
        >
          <path
            className="wf-ink"
            d={piece.d}
            fill="none"
            stroke={INK_STROKE[piece.ink]}
            strokeWidth={1}
          />
          {piece.chevrons === undefined ? null : (
            <StreamChevrons ink={piece.ink} x={piece.chevrons.x} y={piece.chevrons.y} />
          )}
          {/* 流从不叠行进的光：它的墨在 chevron 上。 */}
          {piece.ink === "march" && piece.kind !== "stream" ? (
            <MarchLight
              d={piece.d}
              from={piece.start}
              id={`${gradientBase}lit-${piece.key.replace(/[^\w-]/g, "-")}`}
              to={piece.end}
            />
          ) : null}
        </g>
      ))}
      {model.stations.map((station, i) =>
        station.track === 0 ? null : (
          <path
            className={cn("wf-foldable", folded.has(i) && "wf-folded")}
            d={`M${lampX(i, layout.inset)},${(layout.rowY[station.track] ?? layout.rowY[0]!) + 7} V${layout.capY - 10}`}
            data-leader-station={i}
            data-testid="workflow-timeline-leader"
            fill="none"
            key={station.id}
            stroke="var(--color-workflow-trace)"
            strokeDasharray="1 2"
            strokeLinecap="round"
            strokeWidth={1}
          />
        ),
      )}
    </g>
  );
}

/**
 * 灯（有带时）：还是 DOM 的 span——状态类、光晕与搏动都在 CSS 里——只是绝对定位到自己那条轨道
 * 的行上，而不再跟着站头排。
 */
// 灯仍是 DOM 元素。
// 灯仍是 span 而非 SVG 元素，纵向绝对定位到站台行并保留 stationLampClass 状态类。
// 折叠站的 class 含 wf-folded，与引线同步淡出。
// draft 补全时套 slideClass 与 slideStyle，插入列右侧的灯随站滑开。
// 纵向位置取 layout.rowY[station.track]，缺行时回退 rowY[0]。
export function WorkflowTimelineLamps({
  draft,
  folded,
  layout,
  slide,
  stations,
}: {
  stations: readonly TimelineStation[];
  layout: TimelineLayout;
  folded: ReadonlySet<number>;
  draft: boolean;
  /** 补全的生长（`use-fill-growth.ts`）：插入列右侧的灯随站滑开。 */
  slide?: FillSlide;
}) {
  return (
    <>
      {stations.map((station, i) => (
        <span
          aria-hidden
          className={cn(
            stationLampClass(station.status, station.hole),
            "absolute",
            "wf-foldable",
            folded.has(i) && "wf-folded",
            draft && "wf-land",
            slideClass(i, slide),
          )}
          data-lamp={station.status ?? "pending"}
          data-lamp-track={station.track}
          key={station.id}
          style={{
            ...slideStyle(i, slide),
            left: lampX(i, layout.inset) - 5,
            top: (layout.rowY[station.track] ?? layout.rowY[0]!) - 5,
          }}
        />
      ))}
    </>
  );
}
