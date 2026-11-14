// INV-01 组件是 journal 的只读投影：守住位置 无任何事件处理器；改错故障 出现第二份权威状态。
// INV-02 卡片只按 key upsert：守住位置 applyArtifactItems 的结果；改错故障 刷新后卡片重复或顺序漂移。
// INV-03 卡片 id 即 React key：守住位置 BoardCard 的 key；改错故障 新卡不播揭示动画、旧卡被整体重建。
// INV-04 状态变化只换列不重建卡：守住位置 key 的稳定性；改错故障 每次刷新都重播揭示动画。
// INV-05 compact 只出各列计数：守住位置 compact 分支；改错故障 侧板被卡片撑爆。
// INV-06 空态在两种形态下都渲染：守住位置 cardCount 判断；改错故障 侧板一片空白没有任何提示。
// INV-07 全尺寸标题带总数：守住位置 PresetHeading 的 trailing；改错故障 用户无法确认投影是否完整。
// INV-08 列标题优先取本地化文案：守住位置 columnLabel；改错故障 other 列直接显示英文 id。
// INV-09 列宽固定并横向滚动：守住位置 w-44 与 overflow-x-auto；改错故障 窄面板挤压正文。
// INV-10 长值截断但保留 title：守住位置 truncate 与 title 成对出现；改错故障 撑破布局且看不到全文。
// INV-11 memo 与 useMemo 依赖 spec 与 items：守住位置 组件包裹与依赖数组；改错故障 上游换引用导致无谓重算。
//
// 模块职责：workflow-artifact 的 board 预置渲染器，按 status 分列展示卡片。
// 阅读顺序：先看两类形态的分支，再看卡片与列标题的取值口径。
/**
 * `board` 预置渲染器：按 `status` 分列的卡片墙，卡片按 `key` upsert。
 *
 * 两种形态：
 * - `compact`：run 侧板卡片里的**各列计数**（一眼看出「12 个里 3 个还没过」）；
 * - 全尺寸：`workflow-artifact` tab 里的列 + 卡片。
 *
 * **无拖拽**：这是 journal 的只读投影，卡片的位置由脚本 `report` 出来的 status 决定；
 * 让用户拖动会凭空造出一个「谁是权威」的问题（v1 明确不做交互式筛选 / 排序）。
 */

import { memo, useMemo } from "react";
import {
  applyArtifactItems,
  type ArtifactItem,
  type BoardCardModel,
  type BoardColumnModel,
} from "@/app-shell/workflow-artifacts/presets/apply.js";
import {
  PresetEmpty,
  PresetHeading,
  REVEAL_ANIMATION_CLASS,
  type PresetLabels,
} from "@/app-shell/workflow-artifacts/presets/parts.js";
import type { BoardSpec } from "@/app-shell/workflow-artifacts/presets/spec.js";
import { cn } from "@/components/lib/utils.js";

// other 是脚本没给出 status 时的兜底列，文案走本地化。
// 已知状态直接用 id 展示，避免文案与脚本取值不一致。
function columnLabel(column: BoardColumnModel, labels: PresetLabels): string {
  return column.other ? labels.otherColumn : column.id;
}

// key 由父级按 card.id 提供，这里只负责渲染。
// 揭示动画挂在卡片上，换列不会重建节点因此不会重播。
// 详情逐条渲染为定义列表，标签与值分别截断。
// title 挂原值，截断后仍可悬停查看全文。
function BoardCard({ card }: { card: BoardCardModel }) {
  return (
    // key 是卡片 id（稳定），所以只有**新卡**播揭示动画；状态变化让卡换列，但不重播。
    <div
      className={cn(
        "rounded-lg border border-card-border bg-card px-2 py-1.5",
        REVEAL_ANIMATION_CLASS,
      )}
      data-card-id={card.id}
      data-testid="artifact-board-card"
    >
      <div className="truncate text-ui-sm font-medium text-foreground" title={card.title}>
        {card.title}
      </div>
      {card.details.length > 0 ? (
        <dl className="mt-1 space-y-0.5">
          {card.details.map((detail) => (
            <div className="flex min-w-0 items-baseline gap-1.5" key={detail.label}>
              <dt className="shrink-0 text-ui-xs text-foreground-subtlest">{detail.label}</dt>
              <dd
                className="min-w-0 flex-1 truncate text-right font-mono text-ui-xs text-foreground-subtle"
                title={detail.value}
              >
                {detail.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

// 整体 memo 化：侧板高频刷新时不重算整块卡片墙。
// spec 与 items 都是上游不可变数据，比较成本低。
// 只读组件，不接 onSelect 之类的回调。
export const ArtifactBoard = memo(function ArtifactBoard({
  spec,
  items,
  compact = false,
  labels,
  className,
}: {
  spec: BoardSpec;
  items: readonly ArtifactItem[];
  compact?: boolean;
  labels: PresetLabels;
  className?: string;
}) {
  // 投影计算全部收敛到 applyArtifactItems，组件不做二次归并。
  // 依赖只有 spec 与 items，labels 变化不影响列结构。
  // 返回值同时给出列与总数，两种形态共用一份结果。
  const model = useMemo(() => applyArtifactItems("board", spec, items), [spec, items]);

  // 空态仍渲染 `PresetHeading`：标题在场才能区分「空列表」与「未加载」。
  // compact 下不渲染标题，避免侧板占用高度。
  if (model.cardCount === 0) {
    return (
      <div className={className}>
        {compact ? null : (
          <PresetHeading className="mb-3" description={spec.description} title={spec.title} />
        )}
        <PresetEmpty compact={compact} label={labels.empty} />
      </div>
    );
  }

  // compact 侧板只渲染列名与计数，不实例化卡片本体。
  // 列数由脚本输出决定，可能多于一屏，因此 `flex-wrap` 允许换行。
  // 计数用 `font-mono` + `tabular-nums`，避免刷新时宽度跳动。
  if (compact) {
    return (
      <div className={cn("flex flex-wrap gap-1.5", className)} data-testid="artifact-board-compact">
        {model.columns.map((column) => (
          <span
            className="flex min-w-0 items-baseline gap-1 rounded-md bg-surface px-1.5 py-0.5"
            data-column-id={column.id}
            data-testid="artifact-board-column-count"
            key={column.id}
          >
            <span className="truncate text-ui-xs text-foreground-subtle">
              {columnLabel(column, labels)}
            </span>
            <span className="shrink-0 font-mono text-ui-xs text-foreground tabular-nums">
              {column.cards.length}
            </span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className={cn("min-w-0", className)} data-testid="artifact-board">
      <PresetHeading
        className="mb-3"
        description={spec.description}
        title={spec.title}
        trailing={
          <span className="font-mono text-ui-xs text-foreground-subtlest tabular-nums">
            {labels.itemsCount(model.cardCount)}
          </span>
        }
      />
      {/* 列在自己的容器里横向滚动；窄面板下也不改变组件身份，只是要划一下。 */}
      <div className="flex min-w-0 gap-2 overflow-x-auto pb-1">
        {model.columns.map((column) => (
          <section
            className="flex w-44 shrink-0 flex-col gap-1.5 rounded-lg bg-surface p-2"
            data-column-id={column.id}
            data-testid="artifact-board-column"
            key={column.id}
          >
            <header className="flex items-baseline justify-between gap-2">
              <h4
                className="min-w-0 truncate text-ui-sm font-medium text-foreground"
                title={columnLabel(column, labels)}
              >
                {columnLabel(column, labels)}
              </h4>
              <span className="shrink-0 font-mono text-ui-xs text-foreground-subtlest tabular-nums">
                {column.cards.length}
              </span>
            </header>
            {column.cards.map((card) => (
              <BoardCard card={card} key={card.id} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
});
