// 会话轮次导航条：把 renderUnits 投影成一条可虚拟化的刻度 rail，提供逐轮次的快速跳转。
// 数据流：renderUnits 经 buildConversationTurnNavigatorItems 生成项，再经行虚拟化落到 DOM；高亮由受控 rowId 与滚动几何共同决定。
// 组件不持有会话事实，只从 props 派生可视状态；所有跳转意图通过 onJumpToQuery 上抛给父级。
// 阅读顺序：Props 契约 → 派生索引 → 虚拟化 rail → 定位副作用 → 渲染分支。
// INV-01 少于两条可导航项时整体不渲染，避免单条会话出现无意义刻度；守住位置：items.length < 2 的提前返回；改错故障：空会话或单轮对话侧边出现孤零零的高亮条，被误认成滚动条。
// INV-02 活动项由滚动偏移与视口高度算出，不依赖鼠标；守住位置：activeUnitIndex 的 useMemo；改错故障：用户滚动正文时刻度一直停在顶部，导航失去定位意义。
// INV-03 显式 activeQueryRowId 优先于滚动推导结果，外部指定的行必须压过几何计算；守住位置：activeItemIndex 的回退链；改错故障：搜索命中高亮被滚动位置覆盖，点击后立刻跳回旧位置。
// INV-04 行到项索引的映射必须按 rowId 与 unitIndex 双键建立，两者不可互相替代；守住位置：itemIndexes 的 byRowId 与 firstByUnitIndex；改错故障：同一轮次含多条查询时高亮错行，跳转到相邻轮次。
// INV-05 同一 unitIndex 只取首个出现的项，保证轮次级回退稳定；守住位置：itemIndexes 构建时的 has 判断；改错故障：回退索引随 items 顺序抖动，高亮在两个刻度间闪烁。
// INV-06 派生索引全部用 useMemo 并声明完整依赖，items 变化才重建映射；守住位置：itemIndexes 的依赖数组；改错故障：目录扩展后映射仍指向旧长度，点击跳到已消失的项。
// INV-07 交互索引只承载 hover 与 focus 的临时焦点，不得写回会话状态；守住位置：interactionItemIndex 的各 setter 调用点；改错故障：鼠标划过即改变持久高亮，正文与刻度长期不同步。
// INV-08 指针离开 rail 或轨道滚动时必须清空交互索引，避免残留焦点压住活动色；守住位置：rail 的 onPointerLeave 与 onScroll；改错故障：滚动后刻度停在最后一次悬停的位置，误导用户当前所在轮次。
// INV-09 视觉焦点由活动索引与交互索引共同裁决，交互优先；守住位置：resolveConversationTurnNavigatorVisualFocusItemIndex 调用；改错故障：悬停反馈消失，用户无法预判点击将跳转到哪一轮。
// INV-10 活动项变化时 rail 必须滚到可见区，只在存在有效活动项且至少两项时执行；守住位置：定位副作用的守卫；改错故障：长会话中活动刻度被裁到可视区外，导航条看似随机闪烁。
// INV-11 定位副作用在同一 commit 内补发一次 scroll 事件，用于驱动虚拟化窗口重算；守住位置：queueMicrotask 内的派发；改错故障：目录从尾部批量扩展后目标项未挂载，高亮缺位直到用户手动滚动。
// INV-12 补发事件前必须校验 ref 仍指向同一节点，防止组件已卸载或换挂载点后向游离 DOM 派发；守住位置：微任务内的身份比较；改错故障：切换会话瞬间抛错或污染新实例的观察者。
// INV-13 rail 只允许纵向滚动，否则悬停放大后的刻度会撑出横向滚动条；守住位置：rail 容器的 overflow 类；改错故障：导航条出现横向条并挤压正文宽度。
// INV-14 reduced-motion 偏好必须映射为跳转行为 auto，其余场景用 smooth；守住位置：点击时的 behavior 三元；改错故障：开启减少动效的用户仍被长距离平滑滚动，触发前庭不适。
// INV-15 媒体查询监听必须在卸载时移除，浏览器不支持时静默降级为 false；守住位置：usePrefersReducedMotion 的清理函数；改错故障：反复挂载累积监听器，内存增长并读到过期偏好。
// INV-16 rail 虚拟化以 item.key 作稳定键，items 重排后复用 DOM 而非重挂；守住位置：getRailItemKey；改错故障：目录更新导致整条 rail 重挂，hover 状态与过渡动画中断。
// INV-17 行高估算固定为 10，必须与渲染间距一致，否则虚拟化偏移与真实布局错位；守住位置：useVirtualizer 的 estimateSize；改错故障：滚动越远偏差越大，刻度与正文轮次错位。
// INV-18 每个刻度按钮必须同时暴露 posinset 与 setsize 及跳转标签，读屏用户才能获知序号与总数；守住位置：按钮的 aria 属性；改错故障：屏幕阅读器只念出按钮，导航对无障碍用户不可用。
// INV-19 点击只上抛 unitIndex 与 rowId，不在组件内直接操作正文滚动容器；守住位置：onClick 的 onJumpToQuery 调用；改错故障：出现第二条滚动写入路径，与父级定位逻辑互相覆盖产生抖动。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  TID_V4_TURN_NAVIGATOR,
  TID_V4_TURN_NAVIGATOR_ITEM,
  TID_V4_TURN_NAVIGATOR_TOOLTIP,
  testId,
} from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildConversationTurnNavigatorItems,
  resolveConversationTurnNavigatorActiveUnitIndex,
  resolveConversationTurnNavigatorBarVisualState,
  resolveConversationTurnNavigatorVisualFocusItemIndex,
  type ConversationTurnNavigatorVirtualItem,
} from "@/v4/conversationTurnNavigatorHelpers.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

// [权衡] 该组件是纯投影：只收 renderUnits 与几何量，不读 store，父级因此可以复用到任意会话视图。
// [失败路径] 滚动量或视口高度缺失为 NaN 时，活动索引推导静默返回空值，表现是刻度全暗而非报错。
// [资源] virtualItems 必须来自同一虚拟化实例，跨实例混用会让索引空间不一致。
export interface ConversationTurnNavigatorProps {
  renderUnits: readonly ConversationTurnRenderUnit[];
  scrollOffsetPx: number;
  viewportHeightPx: number;
  virtualItems: readonly ConversationTurnNavigatorVirtualItem[];
  activeQueryRowId?: number;
  isHydratingDirectory?: boolean;
  onJumpToQuery: (
    target: { unitIndex: number; rowId: number },
    behavior: ScrollBehavior,
  ) => void;
}

// [资源] 系统偏好订阅随组件生命周期存在，首帧先给 false，避免首屏与服务端渲染不一致。
// [失败路径] 环境无媒体查询能力时直接返回 false，不建立订阅也不抛错，服务端渲染路径据此安全退化。
// [并发] 监听回调只写本组件本地状态，不跨实例共享，多实例之间无需同步。
function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    // [失败路径] 这是唯一的环境探测点，缺失时提前退出，后续代码因此可以假定查询对象可用。
    // [资源] 清理函数与注册成对出现，防止热更新时累积旧查询对象。
    // [权衡] 用事件监听而非轮询媒体查询，代价是多一个订阅，换来零空转。
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return prefersReducedMotion;
}

// [权衡] 内部分成实现体与 memo 包装两层，便于 ref 比较与调试；对外只暴露记忆化后的组件。
// [失败路径] isHydratingDirectory 默认 false，父级未传时按目录就绪渲染，只影响 aria-busy 不影响项数。
// [并发] props 全量浅比较记忆化，父级若每次新建数组会让记忆化失效；此处不做深比较以避免遍历开销。
function ConversationTurnNavigatorImpl({
  renderUnits,
  scrollOffsetPx,
  viewportHeightPx,
  virtualItems,
  activeQueryRowId,
  isHydratingDirectory = false,
  onJumpToQuery,
}: ConversationTurnNavigatorProps) {
  const { intl } = useZCodeIntl();
  const prefersReducedMotion = usePrefersReducedMotion();
  // [权衡] 交互焦点用索引而非 rowId 存储，省一次映射；代价是 items 收缩时需靠 undefined 兜底。
  // [失败路径] 若 items 变短而索引未清，视觉解析会读到不存在的项，因此所有离开事件都必须复位。
  const [interactionItemIndex, setInteractionItemIndex] = useState<number | undefined>(
    undefined,
  );
  // [事务] 空助手与运行中助手文案来自 intl，items 的重建以 intl 与 renderUnits 为边界，语言切换即整体重算。
  // [权衡] 把预览文案注入放到组件层，helper 保持纯函数，便于单测而不依赖国际化上下文。
  // [失败路径] 文案解析在挂载期一次性求值，避免渲染中抛错导致整条 rail 失败。
  // [资源] items 是后续所有派生值的唯一来源，任何直接读 renderUnits 的分支都会形成第二份投影。
  const items = useMemo(
    () =>
      buildConversationTurnNavigatorItems(renderUnits, {
        assistantEmptyPreview: intl.formatMessage({
          id: "chat.turnNavigator.emptyAssistant",
        }),
        assistantRunningPreview: intl.formatMessage({
          id: "chat.turnNavigator.runningAssistant",
        }),
        userFallbackPreview: intl.formatMessage({
          id: "chat.turnNavigator.userFallback",
        }),
      }),
    [intl, renderUnits],
  );

  // [事务] 活动轮次由滚动偏移与虚拟项交集推导，输入四元组任一变化都整体重算，不做增量修补。
  // [失败路径] 滚动位置落在虚拟项间隙时返回空值，调用方必须接受“无活动轮次”这一合法状态。
  // [并发] 推导是纯计算且不写 ref，因此可以与虚拟化渲染在同一次 commit 中安全执行。
  const activeUnitIndex = useMemo(
    () =>
      resolveConversationTurnNavigatorActiveUnitIndex({
        items,
        scrollOffsetPx,
        viewportHeightPx,
        virtualItems,
      }),
    [items, scrollOffsetPx, viewportHeightPx, virtualItems],
  );
  // [权衡] 用两张 Map 换单次遍历：rowId 走精确命中，unitIndex 走轮次级回退，避免每次查找都线性扫描。
  // [失败路径] 后出现的重复 rowId 会覆盖先前者，依赖 items 已在上游去重；重复项会让点击跳到最后一处。
  // [事务] 映射一次性构建，不在渲染中增量修改，保证同一次渲染内所有查询看到一致快照。
  // [资源] 映射随 items 引用变化而重建，长会话下这是唯一的线性成本，需保持 items 引用稳定。
  const itemIndexes = useMemo(() => {
    const byRowId = new Map<number, number>();
    const firstByUnitIndex = new Map<number, number>();
    items.forEach((item, index) => {
      byRowId.set(item.rowId, index);
      if (!firstByUnitIndex.has(item.unitIndex)) {
        firstByUnitIndex.set(item.unitIndex, index);
      }
    });
    return { byRowId, firstByUnitIndex };
  }, [items]);
  // [权衡] 三级回退用空值合并而非逻辑或，索引 0 是合法值，用逻辑或会把首项误判为缺失。
  // [失败路径] 全部回退失败时落到 -1 作为哨兵，下游据此跳过滚动定位与活动样式。
  // [并发] 该表达式每次渲染重算而不记忆化，因为两次映射查找是常数开销，胜过额外依赖追踪。
  const activeItemIndex =
    (activeQueryRowId === undefined
      ? undefined
      : itemIndexes.byRowId.get(activeQueryRowId)) ??
    (activeUnitIndex === undefined
      ? undefined
      : itemIndexes.firstByUnitIndex.get(activeUnitIndex)) ??
    -1;
  const visualFocusItemIndex = resolveConversationTurnNavigatorVisualFocusItemIndex({
    activeItemIndex,
    interactionItemIndex,
  });
  // [资源] rail 滚动容器由 ref 交给虚拟化实例，稳定的 getter 保证重渲染不会重新绑定监听。
  // [失败路径] 首帧 ref 为空，虚拟化拿到空值后需等待挂载完成，故定位副作用依赖活动项而非挂载时机。
  // [权衡] 键函数回退到索引，只在项缺失时生效，正常路径始终用稳定业务键。
  // [事务] 键函数随 items 变化重建，虚拟化据此判定是否需要重排缓存。
  const railScrollRef = useRef<HTMLDivElement>(null);
  const getRailScrollElement = useCallback(() => railScrollRef.current, []);
  const getRailItemKey = useCallback(
    (index: number) => items[index]?.key ?? index,
    [items],
  );
  // [资源] 行高固定 10 与刻度容器高度一致，估算不再依赖实测，避免首屏抖动。
  // [权衡] overscan 6 平衡挂载成本与滚动空白；目录上千项时窗口外的刻度不进入 DOM。
  // [失败路径] count 直接取 items 长度，items 收缩后虚拟化同步变短，无需手动清理缓存条目。
  // [并发] `railVirtualizer` 的滚动订阅由库在卸载时回收，不要另建第 2 个实例。
  const railVirtualizer = useVirtualizer({
    count: items.length,
    estimateSize: () => 10,
    getItemKey: getRailItemKey,
    getScrollElement: getRailScrollElement,
    overscan: 6,
  });
  const virtualRows = railVirtualizer.getVirtualItems();

  // [事务] 该副作用把活动索引投影到 rail 的滚动位置，是组件内唯一的命令式写入点。
  // [失败路径] 活动索引为负说明无有效轮次，此时不滚动，避免把 rail 拉回顶部。
  // [资源] 补发的 scroll 事件在微任务里执行，落在本次 commit 之后，确保虚拟化的测量已提交。
  // [并发] 派发前比较 ref 身份，挂载点变化或卸载后直接放弃，不向游离节点发事件。
  // [权衡] 用一次性事件补偿浏览器合并滚动通知的行为，属已知 Chromium 时序缺陷的最小规避。
  useEffect(() => {
    if (activeItemIndex < 0 || items.length < 2) return;
    railVirtualizer.scrollToIndex(activeItemIndex, { align: "auto" });
    const element = railScrollRef.current;
    if (!element) return;
    window.queueMicrotask(() => {
      if (railScrollRef.current !== element) return;
      // 目录从 tail 一次扩展到上千项时，scrollToIndex 与 virtualizer 的
      // measurement 更新处于同一个 commit，Chromium 可能合并 scroll 通知。补发通知
      // 只同步 rail observer，确保活动项对应的可视窗口立即挂载。
      element.dispatchEvent(new Event("scroll"));
    });
  }, [activeItemIndex, items.length, railVirtualizer]);

  // [失败路径] 这是渲染前的最后一道门，空会话、单轮对话与目录尚在加载都表现为不渲染。
  // [权衡] 选择返回 null 而非隐藏容器，省掉不可见节点的虚拟化与订阅开销。
  // [事务] 该判断位于所有 hook 之后，保证 hook 调用顺序在项数变化时保持稳定。
  if (items.length < 2) {
    return null;
  }

  return (
    // [权衡] nav 默认不可见且不接收指针，仅在宽视口断点放开，窄屏把空间让给正文。
    // [失败路径] aria-busy 只反映目录注水状态，不影响项的可点击性，避免加载期锁死导航。
    // [资源] 测试钩子同时暴露项数与已渲染项数，用于断言虚拟化窗口而非真实项数。
    <nav
      aria-label={intl.formatMessage({ id: "chat.turnNavigator.label" })}
      aria-busy={isHydratingDirectory}
      data-testid={TID_V4_TURN_NAVIGATOR}
      data-item-count={items.length}
      data-rendered-item-count={virtualRows.length}
      className="pointer-events-none invisible absolute inset-y-0 left-0 z-10 w-12 -translate-x-2 opacity-0 transition-[opacity,transform,visibility] duration-150 ease-out motion-reduce:transition-none @min-[864px]/conversation:visible @min-[864px]/conversation:translate-x-0 @min-[864px]/conversation:opacity-100"
    >
      <div
        // [失败路径] 若放开横向滚动，悬停放大的刻度会撑出横向条并挤压布局，故必须显式隐藏横向溢出。
        // [并发] 滚动与指针离开都复位交互索引，两个来源任一触发即可，无需去重。
        // [资源] 滚动条由 `scrollbar-hide` 隐藏但滚动保留，轨道高度上限取视口的百分比。
        ref={railScrollRef}
        // 只声明 overflow-y-auto 时，浏览器会把 overflow-x 计算为 auto；
        // hover 山峰横向放大后便可能触发横向滚动条，因此 rail 必须只开放纵向滚动。
        className="!scrollbar-hide pointer-events-auto absolute left-3 top-1/2 max-h-[calc(100%-6rem)] w-9 -translate-y-1/2 overflow-x-hidden overflow-y-auto py-1"
        onPointerLeave={() => setInteractionItemIndex(undefined)}
        onScroll={() => setInteractionItemIndex(undefined)}
      >
        <div
          className="relative w-9"
          style={{ height: `${railVirtualizer.getTotalSize()}px` }}
        >
          {virtualRows.map((virtualRow) => {
            const itemIndex = virtualRow.index;
            const item = items[itemIndex];
            if (!item) return null;
            const active = itemIndex === activeItemIndex;
            const visualState = resolveConversationTurnNavigatorBarVisualState({
              itemIndex,
              visualFocusItemIndex,
            });
            const showScrollActiveColor =
              visualFocusItemIndex === undefined && active;
            return (
              <div
                key={item.key}
                className="absolute left-0 top-0 h-2.5 w-9"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <HoverCard closeDelay={80} openDelay={120}>
                  <HoverCardTrigger asChild>
                    <button
                      type="button"
                      aria-current={active ? "location" : undefined}
                      aria-label={intl.formatMessage(
                        { id: "chat.turnNavigator.jumpToQuery" },
                        { index: String(itemIndex + 1) },
                      )}
                      aria-posinset={itemIndex + 1}
                      aria-setsize={items.length}
                      data-testid={testId(TID_V4_TURN_NAVIGATOR_ITEM, item.key)}
                      data-item-index={itemIndex}
                      data-unit-index={item.unitIndex}
                      data-turn-id={item.turnId}
                      data-query-row-id={item.rowId}
                      data-active={active ? "true" : "false"}
                      data-running={item.isRunning ? "true" : "false"}
                      data-visual-color-tone={visualState.colorTone}
                      data-visual-scale={String(visualState.scaleX)}
                      data-visual-tone={visualState.tone}
                      onBlur={() => setInteractionItemIndex(undefined)}
                      // [事务] 点击只上抛目标轮次与滚动行为，正文滚动由父级执行，组件不持有第二份滚动状态。
                      // [失败路径] 跳转期间若 items 已变化，rowId 仍能定位到新位置或安全落空，不会跳到错误轮次。
                      onClick={() =>
                        onJumpToQuery(
                          { unitIndex: item.unitIndex, rowId: item.rowId },
                          prefersReducedMotion ? "auto" : "smooth",
                        )
                      }
                      onFocus={() => setInteractionItemIndex(itemIndex)}
                      onPointerEnter={() => setInteractionItemIndex(itemIndex)}
                      onPointerLeave={() => setInteractionItemIndex(undefined)}
                      className="flex h-2.5 w-9 items-center justify-start rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <span
                        className={cn(
                          "block h-0.5 w-3 origin-left rounded-full transition-[height,opacity,transform,background-color] duration-150 ease-out motion-reduce:transition-none",
                          visualState.colorTone === "focus" && "bg-foreground",
                          visualState.colorTone === "muted" &&
                            (showScrollActiveColor
                              ? "bg-foreground"
                              : "bg-foreground-subtlest"),
                        )}
                        style={{
                          opacity:
                            showScrollActiveColor
                              ? 0.9
                              : item.isRunning
                                ? Math.max(visualState.opacity, 0.72)
                                : visualState.opacity,
                          transform: `scaleX(${visualState.scaleX})`,
                        }}
                      />
                    </button>
                  </HoverCardTrigger>
                  <HoverCardContent
                    align="start"
                    side="right"
                    sideOffset={8}
                    data-testid={testId(
                      TID_V4_TURN_NAVIGATOR_TOOLTIP,
                      item.key,
                    )}
                    className="w-80 max-w-[calc(100vw-2rem)] border border-popover-border bg-popover p-3 text-popover-foreground shadow-lg"
                  >
                    <div className="space-y-2">
                      <p className="line-clamp-2 whitespace-pre-line text-ui-base font-medium leading-5">
                        {item.userPreview}
                      </p>
                      <p
                        className={cn(
                          "line-clamp-3 whitespace-pre-line text-ui-base leading-5",
                          item.assistantPreviewKind === "text"
                            ? "text-popover-foreground/80"
                            : "text-foreground-subtle",
                        )}
                      >
                        {item.assistantPreview}
                      </p>
                    </div>
                  </HoverCardContent>
                </HoverCard>
              </div>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

export const ConversationTurnNavigator = memo(ConversationTurnNavigatorImpl);
