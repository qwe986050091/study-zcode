// INV-01 站头无背景：守住位置 StationHead 容器；改错故障：站头变成按钮块，时间线视觉断裂。
// INV-02 不可点用 span：守住位置 onSelect 缺席分支；改错故障：禁用按钮吞掉点击，整块开关失效。
// INV-03 可点用 button：守住位置 onSelect 存在分支；改错故障：键盘与焦点语义丢失。
// INV-04 待定归一：守住位置 状态判空；改错故障：未定义状态被渲染成其他颜色的灯。
// INV-05 留白弱化：守住位置 名字颜色；改错故障：未到达的站与已完成站同样醒目。
// INV-06 补全标记：守住位置 留白分支；改错故障：已填充与等待态同时渲染两套元数据。
// INV-07 标题外置：守住位置 titleOf 注入；改错故障：站内重复取名，轮次文案不一致。
// INV-08 格宽推导：守住位置 末站宽度；改错故障：末站少留尾巴残段，轨道被截断。
// INV-09 轨道成对：守住位置 railKey 查找；改错故障：相邻站查不到轨道，线不可见。
// INV-10 缺轨占位：守住位置 不可见样式；改错故障：无轨道时撑出多余留白。
// INV-11 流轨缺口：守住位置 流轨最小宽度；改错故障：chevron 压住两侧线段。
// INV-12 虚线语义：守住位置 dashed 样式；改错故障：未填写的留白被画成实线。
// INV-13 折叠一致：守住位置 灯与站头类名；改错故障：灯折起而名字仍在，视觉错位。
// INV-14 草稿截断：守住位置 名字切片；改错故障：草稿显示完整名字，笔的揭示失效。
// INV-15 光标唯一：守住位置 末站判断；改错故障：每站都出现光标。
// INV-16 尾巴条件：守住位置 残段渲染；改错故障：已填充的末站也画出开放残段。
// INV-17 站台几何：守住位置 站台行定位；改错故障：站头与灯不在同一列。
// INV-18 药丸不折：守住位置 药丸列；改错故障：折叠时药丸一起隐藏，只剩轨道。
//
// 模块职责：时间线站头、轨道行与站台行的展示组件。
// 状态所有权：无状态；站数据、折叠集合与生长参数全部由外部传入。
// 阅读顺序：站头 → 行属性 → 轨道行 → 站台行。
import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import type { TimelineRail, TimelineStation } from "./timeline-model.js";
import {
  CAPTION_X,
  PLATFORM_ROW,
  RAIL_ROW,
  STATION_PITCH,
  STATION_WIDTH,
  TAIL_STUB,
  stationX,
  type TimelineLayout,
} from "./timeline-geometry.js";
import { railKey } from "./timeline-ledge.js";
import type { TypewriterState } from "./use-typewriter.js";
import { HoleFillMark, HoleWaitingMeta } from "./WorkflowHoleParts.js";
import { StationMeta } from "./WorkflowStationMeta.js";
import { StreamChevronsBox } from "./WorkflowStreamChevrons.js";
import { stationLampClass } from "./WorkflowTimelineLedge.js";
import { slideClass, slideStyle, type FillSlide } from "./use-fill-growth.js";

/**
 * 站头：名字 + 元数据，一枚没有背景的
 * 药丸。没有带时它排在轨道行上、灯的右边；有带时它搬到站台行，
 * 灯留在自己那条轨道上——两处的标记完全一样，所以从 `WorkflowTimeline.tsx` 拆出来共用一份。
 *
 * 不可点的站头是 `span` 而不是禁用的 `button`：浏览器对禁用控件不派发
 * click，整块开关就收不到；span 没有语义，点击照常冒泡。
 */
// StationHead 渲染站头：名字与元数据组成一枚无背景药丸。
// 有带时 StationHead 搬到站台行，无带时留在轨道行灯的右侧。
// 不可点时渲染 span，保证点击继续冒泡。
// 可点时用 button，保留键盘与焦点语义。
//
export function StationHead({
  caret,
  foldClass,
  name,
  onSelect,
  station,
  title,
}: {
  station: TimelineStation;
  name: string;
  /** 草稿里跟着笔走的光标；其余时候 null。 */
  caret: ReactNode;
  foldClass: string;
  title: string;
  /** 缺席即站头不是控件——点击冒泡给宿主（轮尾摘要的整块开关）。 */
  onSelect?: () => void;
}) {
  // pending 同时覆盖 station.status 缺省与 "pending" 两种取值。
  // 留白站名字用 text-foreground-subtle，补全到达后转 text-foreground。
  // hole.state 为 filled 时渲染 HoleFillMark，waiting 时改渲染 HoleWaitingMeta。
  // title 直接透传给原生 title 属性，文案由调用方给出。
  //
  const pending = station.status === undefined || station.status === "pending";
  // 留白站（docs/dynamic-workflow/presentation.md「Holes on the timeline」）：名字到达前 subtle，
  // 等待时元数据位写「等待补全」；无阶段的补全在名字之后放一枚笔标。类型不上界面。
  const hole = station.hole;
  const head = (
    <>
      <span
        className={cn(
          "truncate text-ui-caption font-medium",
          pending ? "text-foreground-subtle" : "text-foreground",
        )}
      >
        {name}
        {caret}
      </span>
      {hole?.state === "filled" ? <HoleFillMark holeId={hole.siteId} /> : null}
      {hole?.state === "waiting" ? (
        <HoleWaitingMeta hole={hole} />
      ) : (
        <StationMeta station={station} />
      )}
    </>
  );
  return onSelect === undefined ? (
    <span
      className={cn(
        "wf-station flex h-6 min-w-0 shrink items-center gap-2 rounded-md text-left",
        foldClass,
      )}
      data-testid="workflow-timeline-station-head"
      title={title}
    >
      {head}
    </span>
  ) : (
    <button
      className={cn(
        "wf-station wf-station-open flex h-6 min-w-0 shrink cursor-pointer items-center gap-2 rounded-md text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
        foldClass,
      )}
      onClick={onSelect}
      title={title}
      type="button"
    >
      {head}
    </button>
  );
}

// RowProps 只描述数据与回调，不掺布局常量。
// 标题函数由外层注入，避免站内重复取名。
//
interface RowProps {
  stations: readonly TimelineStation[];
  /** 补全的生长（`use-fill-growth.ts`）：下标大于 `after` 的站带 `wf-slide`，从 −shift 滑到位。 */
  slide?: FillSlide;
  /** 站的全名，按下标；草稿里笔只写出前几个字。 */
  fullNames: readonly string[];
  folded: ReadonlySet<number>;
  titleOf: (station: TimelineStation) => string;
  onSelectStation?: (station: TimelineStation) => void;
}

/**
 * 轨道行（没有带时）：站头（灯 + 名字 + 元数据）与到下一站的轨道段，一站一格。折到檐上的站只留
 * 轨道段；药丸列不折（用户修订：两侧对称）——它们只随滚动走，在视口真正的边界处渐隐。
 */
// 轨道行每站一格，格宽取 STATION_PITCH 而末站用 STATION_WIDTH。
// 末站带 tailStub 时额外留出 TAIL_STUB 宽度。
// 轨道段按相邻两站的 railKey 查找，缺段回退不可见占位。
// 流轨在正中让出 chevron 缺口，并保证最小宽度。
// 触到未填充留白的段改为虚线。
// landing 判定 draft 或 fill 落在 fresh 集合，命中时加 wf-land。
export function WorkflowStationRow({
  draft,
  folded,
  fresh,
  fullNames,
  onSelectStation,
  pen,
  rails,
  slide,
  stations,
  tailStub,
  titleOf,
  top,
  width,
}: RowProps & {
  /** 相邻两站之间的轨道段，按 `railKey` 查。 */
  rails: ReadonlyMap<string, TimelineRail>;
  draft: boolean;
  pen: TypewriterState;
  top: number;
  width: number;
  /** 末站是尾巴留白：`open` 在它之后画 40px 淡出的虚线残段，`filled` 只留余地。 */
  tailStub?: "open" | "filled";
  /** 刚接进 run 的补全所写的站：灯落地、轨道段长出（`wf-land` / `wf-rail-grow`）。 */
  fresh?: ReadonlySet<string>;
}) {
  // draft 时名字按 pen.shown[i] 截断。
  // penHere 只在最后一站成立，pen.idle 时加 wf-caret 闪烁。
  // foldClass 同时作用于灯与 StationHead，保证两侧一致。
  // data-lamp 区分 hole 的留白态与 station.status。
  // tailStub === "open" 时才渲染 tail-stub 残段。
  // 药丸列不随 folded 隐藏，只在视口边界渐隐。
  const n = stations.length;
  return (
    <div className="absolute left-0 flex" style={{ height: RAIL_ROW, top, width }}>
      {stations.map((station, i) => {
        const rail = rails.get(railKey(i, i + 1));
        const stream = rail?.kind === "stream";
        const full = fullNames[i]!;
        const name = draft ? full.slice(0, pen.shown[i] ?? 0) : full;
        const penHere = draft && i === n - 1;
        const foldClass = cn("wf-foldable", folded.has(i) && "wf-folded");
        const landing = draft || (station.fill !== undefined && fresh?.has(station.fill) === true);
        const last = i === n - 1;
        return (
          <div
            className={cn(
              "flex h-6 min-w-0 items-center",
              station.ghost && "wf-ghost",
              slideClass(i, slide),
            )}
            data-fill={station.fill}
            data-station-folded={folded.has(i) ? "true" : undefined}
            data-station-ghost={station.ghost ? "true" : undefined}
            data-station-hole={station.hole?.state}
            data-station-status={station.status ?? "pending"}
            data-testid="workflow-timeline-station"
            key={station.id}
            style={{
              ...slideStyle(i, slide),
              width: !last
                ? STATION_PITCH
                : STATION_WIDTH + (tailStub === undefined ? 0 : TAIL_STUB),
            }}
          >
            <span
              aria-hidden
              className={cn(
                stationLampClass(station.status, station.hole),
                "mx-3",
                foldClass,
                landing && "wf-land",
              )}
              data-lamp={
                station.hole !== undefined && station.hole.state !== "filled"
                  ? `hole-${station.hole.state}`
                  : (station.status ?? "pending")
              }
            />
            <StationHead
              caret={
                penHere ? (
                  // 光标跟着笔：写字时稳住，追上流时闪烁。
                  <span
                    aria-hidden
                    className={cn(
                      "ml-px inline-block h-3 w-px bg-foreground align-[-1px]",
                      pen.idle && "wf-caret",
                    )}
                    data-pen={pen.idle ? "idle" : "writing"}
                    data-testid="workflow-timeline-caret"
                  />
                ) : null
              }
              foldClass={foldClass}
              name={name}
              station={station}
              title={titleOf(station)}
              {...(onSelectStation === undefined
                ? {}
                : { onSelect: () => onSelectStation(station) })}
            />
            {!last ? (
              <span
                aria-hidden
                className={cn(
                  "wf-ink relative h-0 flex-1 rounded-full border-t border-foreground-subtlest",
                  // 流轨（presentation.md「Stream rails」）：线在正中让出 chevron 的缺口（`::before`
                  // 画线、border 透明），至少 42px 宽，三枚两侧各留得下一段线；它从不叠行进的光。
                  stream ? "wf-rail-stream min-w-[42px]" : "min-w-3",
                  landing && "wf-rail-grow",
                  rail === undefined && "invisible",
                  // 触到开着的留白的段是虚线：那里还不是代码（docs/dynamic-workflow/presentation.md）。
                  rail?.dashed && "border-dashed",
                  // 行进的段照常画底线，再叠一道不动的光（`.wf-rail-march::after`）：朝着灯渐亮。
                  !stream && rail?.ink === "march" && "wf-rail-march",
                )}
                data-rail-dashed={rail?.dashed ? "true" : undefined}
                data-rail-from={i}
                data-rail-ink={rail?.ink ?? "none"}
                data-rail-kind={rail?.kind}
                data-rail-to={i + 1}
                data-testid="workflow-timeline-rail"
                style={{ marginLeft: 10, marginRight: -6 }}
              >
                {stream ? (
                  <StreamChevronsBox ink={rail.ink} style={{ left: "50%", top: -0.5 }} />
                ) : null}
              </span>
            ) : tailStub === "open" ? (
              // 尾巴留白：轨道在它之后再跑 40px 并淡出——脚本的结尾还没有写下。
              <span
                aria-hidden
                className="wf-tail-stub h-0 shrink-0 border-t border-dashed border-foreground-subtlest"
                data-testid="workflow-timeline-tail-stub"
                style={{ marginLeft: 10, width: TAIL_STUB }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 站台行：有带时站头一律搬到轨道下面
 * 这一行，灯留在自己的轨道上，分支轨道的站由一条点状引线接回名字——主线的站不需要，它的灯就在
 * 名字正上方。草稿永远没有带，所以这里不必管笔。
 */
// WorkflowStationPlatform 把站头搬到轨道下方，灯留在原轨道。
// station.track 非 0 的站由点状引线接回名字。
// 草稿永远没有带，这里不处理 pen。
//
export function WorkflowStationPlatform({
  folded,
  fullNames,
  layout,
  onSelectStation,
  slide,
  stations,
  titleOf,
}: RowProps & { layout: TimelineLayout }) {
  return (
    <>
      {stations.map((station, i) => (
        <div
          className={cn(
            "absolute flex h-6 min-w-0 items-center",
            station.ghost && "wf-ghost",
            slideClass(i, slide),
          )}
          data-fill={station.fill}
          data-station-folded={folded.has(i) ? "true" : undefined}
          data-station-hole={station.hole?.state}
          data-station-status={station.status ?? "pending"}
          data-station-track={station.track}
          data-testid="workflow-timeline-station"
          key={station.id}
          style={{
            ...slideStyle(i, slide),
            left: stationX(i, layout.inset) + CAPTION_X,
            top: layout.capY - PLATFORM_ROW / 2,
            width: STATION_WIDTH - CAPTION_X,
          }}
        >
          <StationHead
            caret={null}
            foldClass={cn("wf-foldable", folded.has(i) && "wf-folded")}
            name={fullNames[i]!}
            station={station}
            title={titleOf(station)}
            {...(onSelectStation === undefined ? {} : { onSelect: () => onSelectStation(station) })}
          />
        </div>
      ))}
    </>
  );
}
