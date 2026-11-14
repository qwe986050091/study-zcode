// INV-01 虚拟列表键必须稳定：守住位置 getItemKey；改错故障：用下标当键会让搜索定位滚动到错误行。
// INV-02 估算高度只作初始值：守住位置 estimateSize；改错故障：固定高度会让长调用块被裁掉。
// INV-03 搜索期关闭自动锚点修正：守住位置 shouldAdjustScrollPositionOnItemSizeChange；改错故障：每次测高都改滚动会与文本定位互相拉扯。
// INV-04 挂载集合键只收行 key：守住位置 mountedRowsKey；改错故障：把起点放进依赖会触发无休止的精确滚动。
// INV-05 目标已挂载时不做 Call 级预滚动：守住位置 首屏检查；改错故障：两次滚动接力会让视口先跳后抖。
// INV-06 高亮应用放在双帧之后：守住位置 requestAnimationFrame 链；改错故障：布局未稳就测量会得到过期矩形。
// INV-07 卸载时清理高亮：守住位置 空依赖 effect；改错故障：残留高亮会污染下一次打开的面板。
// INV-08 搜索清空时同步清除高亮：守住位置 提前返回分支；改错故障：空查询仍保留标记会让轨迹看起来被涂色。
// INV-09 活动命中变化触发重新定位：守住位置 依赖数组；改错故障：不监听命中会让上一个高亮停留。
// INV-10 取消动画帧避免旧任务写入：守住位置 清理函数；改错故障：快速输入时旧帧会覆盖新高亮。
// INV-11 首条记录展示完整上下文：守住位置 首条分支；改错故障：首条也做差分会丢失系统提示。
// INV-12 后续主会话过滤 assistant 消息：守住位置 过滤条件；改错故障：重复展示 assistant 会与本条输出重复。
// INV-13 辅助请求不套用消息差量：守住位置 shouldUseConversationDelta；改错故障：sidecar 的独立 prompt 会被整段隐藏。
// INV-14 差量按上一条记录的消息数计算：守住位置 游标推进；改错故障：用当前长度当游标会让每轮都为空。
// INV-15 消息变短时退回全量：守住位置 长度比较分支；改错故障：负数切片会得到空数组。
// INV-16 消息数不变时差量为空：守住位置 相等分支；改错故障：重复展示全部消息会让时间线翻倍。
// INV-17 行键由请求 id 加序号组成：守住位置 key 拼接；改错故障：同请求多轮会命中同一个键。
// INV-18 顶部与底部占位按虚拟窗口计算：守住位置 spacer 计算；改错故障：占位缺失会让滚动条长度跳变。
//
// 模块职责：模型轨迹时间线的虚拟滚动容器，并把记录差量解析成每次调用的输入消息。
// 状态所有权：虚拟器与滚动容器由调用方持有；消息游标在解析函数内部顺序推进。
// 阅读顺序：先看虚拟器配置与搜索期滚动策略，再看双帧高亮 effect，最后看差量与首条特例。
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, type RefObject } from "react";
import type { ZCodeModelTrajectoryRecord } from "@zcode/services";
import {
  type TrajectorySearchMatch,
  type TrajectorySearchTimelineItem,
} from "@/ModelTrajectorySearch.js";
import {
  applyTrajectorySearchHighlights,
  clearTrajectorySearchHighlights,
  isTrajectorySearchTargetMounted,
  scrollTrajectorySearchRangeIntoView,
} from "@/ModelTrajectorySearchHighlight.js";
import { CallCard, type IntlShape } from "@/ModelTrajectoryPaneParts.js";

export function ModelTrajectoryTimeline({
  items,
  searchQuery,
  searchMatches,
  activeSearchMatch,
  intl,
  scrollContainerRef,
}: {
  items: TrajectorySearchTimelineItem[];
  searchQuery: string;
  searchMatches: TrajectorySearchMatch[];
  activeSearchMatch: TrajectorySearchMatch | null;
  intl: IntlShape;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}) {
  // useVirtualizer 绑定 scrollContainerRef.current：容器未挂载时 getScrollElement 返回 null，虚拟器渲染 0 项；
  // getItemKey 优先取 items[index].key，缺失才退回 index——用下标当键会让搜索的 scrollToIndex 落到错误行；
  // estimateSize 固定 240 只是首帧估算，真实高度由 measureElement 写回，overscan 3 兼顾快速滚动与首屏开销。
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollContainerRef.current,
    getItemKey: (index) => items[index]?.key ?? index,
    estimateSize: () => 240,
    overscan: 3,
  });
  // 搜索切换会同时收起旧命中并展开新命中；此时禁止 virtualizer 根据每次测高回调连续
  // 修正滚动锚点，由下方文本级定位在布局稳定后一次完成滚动。
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => !searchQuery;
  const roleWidthLabels = ["system", "user", "assistant", "tool"].map((role) =>
    intl.formatMessage({ id: `modelTrajectory.role.${role}` }),
  );
  const virtualItems = virtualizer.getVirtualItems();
  const firstVirtualItem = virtualItems[0];
  const lastVirtualItem = virtualItems.at(-1);
  const topSpacerHeight = firstVirtualItem?.start ?? 0;
  const bottomSpacerHeight = lastVirtualItem ? virtualizer.getTotalSize() - lastVirtualItem.end : 0;
  // 只跟踪挂载集合。把 start 放进依赖会让每次动态测高都重新安排一次精确滚动。
  const mountedRowsKey = virtualItems.map((item) => item.key).join("|");

  // 这个空依赖 effect 只在卸载时执行 clearTrajectorySearchHighlights()：高亮是直接写进 root DOM 的，
  // 不受 React 生命周期管理，不清理会残留到下一次打开的面板；搜索清空由下面那个 effect 的提前返回分支负责。
  useEffect(() => () => clearTrajectorySearchHighlights(), []);

  useEffect(() => {
    const root = scrollContainerRef.current;
    if (
      !activeSearchMatch ||
      !root ||
      isTrajectorySearchTargetMounted(root, activeSearchMatch.expansionKey)
    ) {
      return;
    }
    // 目标已经挂载时跳过 Call 级预滚动，否则随后文本级定位会造成连续两次跳动。
    virtualizer.scrollToIndex(activeSearchMatch.callIndex, { align: "center" });
  }, [activeSearchMatch, scrollContainerRef, virtualizer]);

  // 该 effect 用两帧完成「测量 → 高亮/定位」：第一帧 virtualizer.measure() 让刚挂载的行写回真实高度，
  // 第二帧才 applyTrajectorySearchHighlights 并 scrollTrajectorySearchRangeIntoView——布局未稳时测量会得到过期矩形；
  // searchQuery 为空或 root 缺失时提前 clearTrajectorySearchHighlights() 并 return，避免空查询仍留下涂色；
  // 清理函数同时 cancelAnimationFrame(firstFrame/secondFrame)，快速输入时旧帧不会覆盖新高亮；
  // 依赖里的 mountedRowsKey 只随行集合变化，不会因 start 抖动触发无休止的精确滚动。
  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root || !searchQuery) {
      clearTrajectorySearchHighlights();
      return;
    }
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      virtualizer.measure();
      secondFrame = window.requestAnimationFrame(() => {
        const activeRange = applyTrajectorySearchHighlights({
          root,
          query: searchQuery,
          matches: searchMatches,
          activeMatch: activeSearchMatch,
        });
        if (activeRange) scrollTrajectorySearchRangeIntoView(activeRange, root);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [
    activeSearchMatch,
    mountedRowsKey,
    scrollContainerRef,
    searchMatches,
    searchQuery,
    virtualizer,
  ]);

  return (
    <ol
      data-trajectory-timeline=""
      className="grid grid-cols-[max-content_minmax(0,1fr)_auto] gap-x-2"
    >
      {roleWidthLabels.map((label) => (
        <li
          key={label}
          aria-hidden="true"
          className="invisible col-start-1 row-start-1 h-0 overflow-hidden whitespace-nowrap font-mono text-ui-sm"
        >
          {label}
        </li>
      ))}
      {topSpacerHeight > 0 ? (
        <li aria-hidden="true" className="col-span-full" style={{ height: topSpacerHeight }} />
      ) : null}
      {virtualItems.map((virtualItem) => {
        const item = items[virtualItem.index];
        if (!item) return null;
        return (
          <li
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={virtualItem.index}
            data-trajectory-virtual-row=""
            className="col-span-full grid w-full grid-cols-subgrid"
          >
            <CallCard
              record={item.record}
              index={virtualItem.index}
              inputMessages={item.inputMessages}
              expansionKeyPrefix={item.key}
              intl={intl}
            />
          </li>
        );
      })}
      {bottomSpacerHeight > 0 ? (
        <li aria-hidden="true" className="col-span-full" style={{ height: bottomSpacerHeight }} />
      ) : null}
    </ol>
  );
}

// resolveTrajectoryTimelineItems 顺序遍历 records 并维护 previousConversationMessageCount 游标：
// 每条记录调用 resolveTrajectoryInputMessages 后把 nextConversationMessageCount 写回游标，
// key 由 `${record.requestId}:${index}` 组成，同一请求多轮也不会撞键；返回值直接交给 virtualizer，不再二次加工。
export function resolveTrajectoryTimelineItems(records: ZCodeModelTrajectoryRecord[]) {
  let previousConversationMessageCount = 0;

  return records.map((record, index) => {
    const resolvedInput = resolveTrajectoryInputMessages({
      index,
      previousConversationMessageCount,
      record,
    });
    previousConversationMessageCount = resolvedInput.nextConversationMessageCount;

    return {
      key: `${record.requestId}:${index}`,
      record,
      inputMessages: resolvedInput.inputMessages,
    };
  });
}

// resolveTrajectoryInputMessages 先用 shouldUseConversationDelta(record) 分流：辅助请求（sidecar/compact）
// 直接拿原始 messages，主会话才走 computeDeltaMessages；首条（index === 0）保留完整上下文，
// 后续主会话再 filter 掉 role === "assistant"（本条 Output 已经展示）。
// nextConversationMessageCount 只在参与差量时推进到 messages.length，否则保持入参，避免游标被辅助请求打乱。
export function resolveTrajectoryInputMessages({
  record,
  index,
  previousConversationMessageCount,
}: {
  record: ZCodeModelTrajectoryRecord;
  index: number;
  previousConversationMessageCount: number;
}): {
  inputMessages: ZCodeModelTrajectoryRecord["request"]["messages"];
  nextConversationMessageCount: number;
} {
  const messages = record.request.messages;
  const usesConversationDelta = shouldUseConversationDelta(record);
  const deltaMessages = usesConversationDelta
    ? computeDeltaMessages(messages, previousConversationMessageCount, index)
    : messages;

  return {
    // 首条展示完整起始上下文；后续主会话只展示非 assistant 的新增（assistant 由上一条 Output 呈现）。
    // sidecar/compact 等辅助请求有独立 prompt，不能套用主会话的消息数 delta，否则会隐藏标题生成 prompt。
    inputMessages: usesConversationDelta
      ? index === 0
        ? deltaMessages
        : deltaMessages.filter((message) => message.role !== "assistant")
      : deltaMessages,
    nextConversationMessageCount: usesConversationDelta
      ? messages.length
      : previousConversationMessageCount,
  };
}

// shouldUseConversationDelta 只在 callSource.kind 为 undefined/"main"/"subagent" 时返回 true：
// undefined 兼容早期没有 callSource 的记录；sidecar/compact 等辅助请求有独立 prompt，
// 套用主会话的消息数 delta 会把标题生成等输入整段隐藏。
function shouldUseConversationDelta(record: ZCodeModelTrajectoryRecord): boolean {
  const kind = record.callSource?.kind;
  return kind === undefined || kind === "main" || kind === "subagent";
}

// computeDeltaMessages 按 previousMessageCount 游标切片：index === 0 或 messages.length < previousMessageCount
// （上下文被重建）时返回全量，增长时返回 messages.slice(previousMessageCount)，相等时返回 []；
// 三种分支的顺序不能交换，先判变短可以避免负数切片得到空数组而丢失整段上下文。
function computeDeltaMessages(
  messages: ZCodeModelTrajectoryRecord["request"]["messages"],
  previousMessageCount: number,
  index: number,
): ZCodeModelTrajectoryRecord["request"]["messages"] {
  if (index === 0) return messages;
  if (messages.length > previousMessageCount) return messages.slice(previousMessageCount);
  if (messages.length < previousMessageCount) return messages;
  return [];
}
