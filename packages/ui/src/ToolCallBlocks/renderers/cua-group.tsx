// INV-01 组内节点的渲染顺序必须严格等于 events 数组顺序，且该顺序就是 CUA 步骤的真实执行顺序；守住位置：CuaGroupChildren 的 events.map；改错故障：任何排序、去重或按 kind 归组都会让用户看到倒放的操作序列，故障无法复现
// INV-02 events 是只读快照，禁止在渲染路径内原地 splice、sort 或 reverse；守住位置：CuaGroupChildren 的 events 形参与 context.events 透传；改错故障：就地改动会话层共享数组后，历史消息下次渲染顺序漂移，两条消息内容互换
// INV-03 组内每个事件必须使用带 kind 前缀的稳定 key，三个分支各自独立命名；守住位置：tool、assistantMessage、reasoning 三个 key 属性；改错故障：前缀缺失导致跨类型撞号，React 复用错误节点，截图与正文挂到别的步骤上
// INV-04 tool 行的 key 只能取 row.toolCallId，不能取数组下标或步骤序号；守住位置：tool 分支的 key 模板；改错故障：流式追加新步骤时下标整体前移，已展开的步骤把展开态传给下一步，滚动位置被清空
// INV-05 assistantMessage 与 reasoning 的 key 只能取 row.rowId，且两类前缀不可互换；守住位置：message 与 reasoning 两个分支的 key；改错故障：前缀互换后正文块渲染成推理块的样式，模型思考内容被当作回答展示
// INV-06 折叠只改变内容可见性，不得改变事件构建、计数与摘要取值；守住位置：CuaGroupToolCallBlock 中 events 的推导与 ToolLayout 的 canToggle；改错故障：折叠时跳过构建会让事件数、消息数与标题随展开收起变化，同一组出现两套统计
// INV-07 context.events 缺省时必须由 childToolCalls 按原数组顺序逐项补齐，不排序不合并；守住位置：CuaGroupToolCallBlock 的空值回退分支；改错故障：合并同一工具名的连续调用会把重复点击压缩成一步，用户看到少执行了一次
// INV-08 由 childToolCalls 合成的 tool 行状态必须固定为 success，不得继承父调用状态；守住位置：合成事件对象的 status 字段；改错故障：父层 in_progress 被下放到子行后，摘要与每个步骤都显示运行中，完成标签永远不出现
// INV-09 合成 tool 行的 toolName 必须按 toolName、kind、Computer Use 三级回退，顺序不可调整；守住位置：合成事件对象的 toolName 表达式；改错故障：回退顺序颠倒会让有名字的步骤统一显示成通用占位文案，用户分不清执行的是哪个应用
// INV-10 摘要只取最后一个终态 tool 事件，不得取数组末尾事件或第一个事件；守住位置：events.findLast 加状态过滤；改错故障：取末尾会把标题固定成最后一步的进行中文案，取首个则整组读完仍停在第一步的结果
// INV-11 终态集合必须恰好是 completed、failed、stopped 三项；守住位置：TERMINAL_CUA_STATUSES 常量；改错故障：漏掉 stopped 会让被用户中断的组永远显示运行中并持续播放渐变动画，看起来像还在执行
// INV-12 isRunning 必须同时取 context.isRunning 或 toolCall.status 为 in_progress 两者之一；守住位置：CuaGroupToolCallBlock 的 isRunning 赋值；改错故障：只看一处会让已结束的组继续吸底滚动，或在运行中提前露出完成标签与图标
// INV-13 强制吸底只允许在用户原本位于底部时发生；守住位置：shouldStickToBottomRef 与两处回调里的判断；改错故障：无条件吸底会在用户回看历史时被新到达的截图或流式文本拽回底部，无法阅读上一步
// INV-14 吸底判定的容差必须走 STICK_TO_BOTTOM_THRESHOLD_PX 常量，禁止内联魔法数；守住位置：isCuaGroupViewportAtBottom；改错故障：容差改大后用户轻微上滚仍被判在底部，改小则临界位置反复切换，视觉上出现一像素跳动
// INV-15 滚动事件必须同时刷新遮罩状态与吸底标记，二者不可只更新其一；守住位置：updateScrollState；改错故障：只更新遮罩不更新标记，用户上滚后仍会被拉回底部；只更新标记则渐隐提示与实际可滚范围不一致
// INV-16 viewport 尚未挂载时必须回落到空遮罩态，不能保留上一次的状态值；守住位置：updateScrollState 的提前返回分支；改错故障：保留旧遮罩会让已卸载或刚重建的组继续显示上下渐隐，遮挡真实内容边缘
// INV-17 ResizeObserver 不可用时必须静默降级为不自动跟随，不得抛出异常；守住位置：effect 内的 typeof 检查与提前返回；改错故障：在旧内核或测试环境直接构造会抛 ReferenceError，整个工具块渲染失败并白屏
// INV-18 观察者必须在 effect 清理函数中 disconnect，与 observe 成对出现；守住位置：effect 的返回闭包；改错故障：泄漏的观察者在卸载后继续回调并写 state，长会话里叠加成大量无效渲染，出现卸载后报警与卡顿
// INV-19 新事件追加与内容尺寸变化必须复用同一条 scrollToBottom 路径，不得各自计算目标位置；守住位置：useLayoutEffect 与 ResizeObserver 两个调用点；改错故障：两条路径分别写 scrollTop 会相互覆盖，最终位置取决于回调顺序，滚动表现为抖动
// INV-20 组内容器必须限制最大高度并隔离滚动链；守住位置：外层 div 的 max-h-72 与 overscroll-contain；改错故障：去掉隔离后在组内滚到边界会连带拖动整个消息列表，用户失去当前阅读位置
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  EMPTY_SCROLL_MASK_STATE,
  getVerticalScrollMaskStyle,
  resolveVerticalScrollMaskState,
  type ScrollMaskState,
} from "@/mentions/components/scrollMask.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { buildCuaSummaryPresentation } from "@/ToolCallBlocks/renderers/cua.js";
import { CUA_TOOL_ICON } from "@/ToolCallBlocks/renderers/cuaIcon.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import type { ConversationCuaGroupEvent } from "@/v4/conversationCuaGroups.js";

// [权衡] 用 Set 而不是数组做终态判断：每次渲染都要在事件列表上做一次反向扫描，
// 事件数随流式输出增长，数组的 includes 是线性查找，扫描会退化成平方级。
// 该集合决定哪一步能代表整组，所以必须是模块级常量，不能从 props 或 intl 推导。
// 新增状态（例如 paused）必须同步加到这里，否则这类组永远停在运行中的动画态。
// 不回退成父层 toolCall 的状态：父层只有粗粒度的 in_progress，无法区分成功与失败。
// 集合成员必须是 tool 行 status 的子集，否则过滤永远命中不到，
// findLast 返回 undefined、摘要退化为空标题，只剩事件计数可见。
const TERMINAL_CUA_STATUSES = new Set(["completed", "failed", "stopped"]);
const STICK_TO_BOTTOM_THRESHOLD_PX = 8;

export function scrollCuaGroupToBottom(viewport: Pick<HTMLElement, "scrollHeight" | "scrollTop">) {
  // [权衡] 直接写 scrollTop 而不是平滑滚动：本函数在布局阶段被调用，平滑动画会在
  // 首帧之后继续改写 scrollTop，同一帧里刚算出的遮罩状态随即过期，遮罩闪一次。
  // 参数只要求 Pick 出来的几何字段，使该函数能在没有真实布局的环境里用普通对象验证。
  // 赋值为 scrollHeight 时浏览器会自行夹到 scrollHeight 减 clientHeight，
  // 因此这里不再减一次；减了会在内容比视口矮时把位置写成负数，反而触不了顶。
  // 该赋值不会触发滚动事件回调，调用方必须自己接着刷新遮罩与吸底标记。
  // 若改成在 rAF 里延迟执行，首个事件到达时会先渲染旧位置一帧，表现为闪动。
  viewport.scrollTop = viewport.scrollHeight;
}

export function isCuaGroupViewportAtBottom(
  viewport: Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">,
) {
  return (
    // [权衡] 判定用容差而不是严格相等：高分屏与页面缩放下 scrollTop 会被取整成小数，
    // 严格相等几乎永远不成立，组到底后仍被当成用户已上滚，跟随就此中断。
    // 用 scrollHeight 减 clientHeight 再减 scrollTop，而不是比较前两者之和：
    // 后者在内容尚未撑满视口时恒为真，会把空组也判定在底部并持续触发滚动。
    // 差值可能为负（回弹时 scrollTop 会超过上限），负数天然小于容差，等同于在底部。
    // 超过一个容差才认为用户接管滚动，之后不再强制吸底，直到用户自己回到底部。
    // 容差取 8 而非 0，用于吸收子像素渲染与截图异步加载造成的 1 到 2 像素偏差。
    viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <=
    STICK_TO_BOTTOM_THRESHOLD_PX
  );
}

interface CuaGroupRenderProps extends ToolCallBlockRenderContext {
  events?: readonly ConversationCuaGroupEvent[];
  renderAssistantMessage?: (
    event: Extract<ConversationCuaGroupEvent, { kind: "assistantMessage" }>,
  ) => ReactNode;
  renderReasoning?: (event: Extract<ConversationCuaGroupEvent, { kind: "reasoning" }>) => ReactNode;
}

function CuaGroupChildren({
  events,
  context,
  renderAssistantMessage,
  renderReasoning,
}: {
  events: readonly ConversationCuaGroupEvent[];
  context: ToolCallBlockRenderContext;
  renderAssistantMessage?: CuaGroupRenderProps["renderAssistantMessage"];
  renderReasoning?: CuaGroupRenderProps["renderReasoning"];
}) {
  const ToolCallBlock = context.nestedToolRenderer;
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // [并发] 该 ref 是用户是否接管滚动的唯一来源，必须与遮罩状态分开存：
  // 遮罩进 state 会触发重渲染，而写 ref 不触发，滚动回调里逐帧写 state 会造成
  // 每帧一次额外渲染，又在同一帧里再触发一次滚动。
  // 写入只发生在滚动回调与观察者回调中，二者都在主线程同步执行，
  // 不存在两个异步任务交错读到旧值，因此无需额外同步原语。
  // 初值 true 表示新挂载的组默认跟随到底部，符合流式新增步骤的期望；
  // 初值为 false 会让首屏停在切片顶部，看不到最新一步。
  const shouldStickToBottomRef = useRef(true);
  const [scrollMaskState, setScrollMaskState] = useState<ScrollMaskState>(EMPTY_SCROLL_MASK_STATE);
  const updateScrollState = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      setScrollMaskState(EMPTY_SCROLL_MASK_STATE);
      return;
    }
    shouldStickToBottomRef.current = isCuaGroupViewportAtBottom(viewport);
    setScrollMaskState(
      resolveVerticalScrollMaskState({
        clientHeight: viewport.clientHeight,
        scrollHeight: viewport.scrollHeight,
        scrollTop: viewport.scrollTop,
      }),
    );
  }, []);
  const scrollToBottom = useCallback(() => {
    if (!viewportRef.current) return;
    scrollCuaGroupToBottom(viewportRef.current);
    updateScrollState();
  }, [updateScrollState]);

  // [权衡] 用 useLayoutEffect 而不是 useEffect 跟随新事件：前者在浏览器绘制前
  // 执行，滚动与绘制在同一帧完成；后者要等一帧，用户会先看到新步骤停在视口外，
  // 再看到它被拽进视野，表现为一次闪跳。
  // 依赖里用 events.length 而不是数组本身：会话层每次渲染都可能产出新的数组实例，
  // 按引用比较会在内容没变时也滚动，把用户上滚的位置重置到顶部。
  // 长度不变但内容替换（状态从运行中变为失败）不改变布局高度，因此不必再吸底。
  // 吸底标记在回调内部读取，拿到的是最近一次滚动后的真实值，而非布局时的旧快照。
  useLayoutEffect(() => {
    if (shouldStickToBottomRef.current) scrollToBottom();
  }, [events.length, scrollToBottom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || typeof ResizeObserver === "undefined") return;

    // 每次尺寸变化都强制吸底会让用户向上查看历史时被截图加载或流式
    // message 拉回底部。只有用户原本位于底部时才跟随新内容。
    // [资源] 同时观察 viewport 与 content：前者捕获容器自身尺寸变化（窗口缩放、
    // 折叠面板展开），后者捕获截图占位替换为真实图片、流式文本追加引起的高度增长；
    // 只观察其中一个都会漏掉另一类变化，表现为滚动条停在旧高度、底部仍是空白。
    // [失败路径] 非吸底分支只刷新遮罩、不执行滚动：用户上滚期间若仍吸底，
    // 正在阅读的步骤会被推出视口；但完全不刷新又会让遮罩停留在加载前的状态，
    // 出现已可上滚却没有顶部渐隐的错位。
    // disconnect 与 observe 成对放在清理函数里，避免 StrictMode 二次挂载留下两份观察者。
    const observer = new ResizeObserver(() => {
      if (shouldStickToBottomRef.current) scrollToBottom();
      else updateScrollState();
    });
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToBottom, updateScrollState]);

  const scrollMaskData =
    scrollMaskState.showTop && scrollMaskState.showBottom
      ? "both"
      : scrollMaskState.showTop
        ? "top"
        : scrollMaskState.showBottom
          ? "bottom"
          : "none";

  return (
    <div
      ref={viewportRef}
      className="max-h-72 overflow-y-auto overscroll-contain"
      data-cua-group-scroll-mask={scrollMaskData}
      onScroll={updateScrollState}
      style={getVerticalScrollMaskStyle(scrollMaskState)}
    >
      <div ref={contentRef} className="ml-2 space-y-2 border-border border-l pl-3.5">
        {events.map((event) =>
          event.kind === "tool" ? (
            <ToolCallBlock
              // key 必须带 tool 前缀并取 toolCallId：同组内 tool 行与 message 行来自不同行表，
              // rowId 各自从零编号，不加前缀会在两类事件之间撞号。
              // [权衡] 不用数组下标做 key：步骤是流式追加的，下标稳定而内容整体前移，
              // 折叠状态与截图懒加载状态会挂到错误的步骤上。
              // toolCallId 在一次会话内唯一，因此同时承担渲染身份与去重依据；
              // 若上游出现同一 toolCallId 的两次调用，React 只保留第一个节点，表现为丢步骤。
              // 该 key 不参与排序，events 数组顺序才是执行顺序，key 只负责身份稳定。
              key={`tool:${event.row.toolCallId}`}
              toolCallNode={event.node}
              workspacePath={context.workspacePath}
              theme={context.theme}
              codePreviewSettings={context.codePreviewSettings}
              showIcon
              cuaAppIconClassName="size-5"
              onOpenCodeViewer={context.onOpenCodeViewer}
              onOpenFileLink={context.onOpenFileLink}
              onOpenBrowserUrl={context.onOpenBrowserUrl}
              onOpenAutomationsMain={context.onOpenAutomationsMain}
              onLoadFullToolCallFields={context.onLoadFullToolCallFields}
            />
          ) : event.kind === "assistantMessage" ? (
            <div
              key={`message:${event.row.rowId}`}
              className="min-w-0 py-1 text-ui-base text-foreground-subtle"
            >
              <div className="min-w-0">
                {renderAssistantMessage?.(event) ?? (
                  <span className="whitespace-pre-wrap break-words">{event.row.text}</span>
                )}
              </div>
            </div>
          ) : (
            <div key={`reasoning:${event.row.rowId}`} className="min-w-0 py-1">
              {renderReasoning?.(event) ?? (
                <span className="whitespace-pre-wrap break-words">{event.row.text}</span>
              )}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

export function CuaGroupToolCallBlock(context: CuaGroupRenderProps) {
  const { intl } = useZCodeIntl();
  const { toolCall, childToolCalls } = context.toolCallNode;
  const events: readonly ConversationCuaGroupEvent[] =
    context.events ??
    childToolCalls.map((node) => ({
      kind: "tool" as const,
      row: {
        rowId: 0,
        turnId: "",
        createdAt: 0,
        createdAtSeq: 0,
        kind: "toolCall" as const,
        toolCallId: node.toolCall.toolId,
        toolName: node.toolCall.toolName ?? node.toolCall.kind ?? "Computer Use",
        status: "success" as const,
        input: node.toolCall.input,
        inputText: "",
      },
      node,
    }));
  // 摘要取最后一个终态事件，而不是数组末尾事件：末尾往往是刚插入的运行中步骤，
  // 用它做标题会让整组读完了仍显示正在打开下一步。
  // [权衡] findLast 从尾部反向扫描，成本只与末尾非终态步骤数相关，
  // 而不是与整组长度相关；长任务组也只需扫过最后几步。
  // 判定只读 node.toolCall.status，不读 row.status：row 是会话行快照，
  // 流式更新时可能落后于 toolCall，用它会让摘要滞后于列表里已显示的状态。
  // 找不到终态事件时保留 null，由调用方渲染空摘要并显示事件计数，外观保持稳定。
  const latestSummaryEvent = events.findLast(
    (event): event is Extract<ConversationCuaGroupEvent, { kind: "tool" }> =>
      event.kind === "tool" && TERMINAL_CUA_STATUSES.has(event.node.toolCall.status),
  );
  const latestToolSummary =
    latestSummaryEvent !== undefined
      ? buildCuaSummaryPresentation(latestSummaryEvent.node.toolCall, intl, {
          appIconClassName: "size-5",
        })
      : null;
  const isRunning = context.isRunning || toolCall.status === "in_progress";
  const eventCount = events.length;
  const messageCount = events.filter((event) => event.kind === "assistantMessage").length;
  const eventCountText = intl.formatMessage(
    {
      id:
        eventCount === 1
          ? "chat.toolCall.cua.group.event.one"
          : "chat.toolCall.cua.group.event.other",
    },
    { count: eventCount },
  );
  const messageCountText =
    messageCount > 0 || !isRunning
      ? intl.formatMessage(
          {
            id:
              messageCount === 1
                ? "chat.toolCall.cua.group.message.one"
                : "chat.toolCall.cua.group.message.other",
          },
          { count: messageCount },
        )
      : null;
  const animatedTextClass = isRunning
    ? "cua-group-gradient-text min-w-0 truncate"
    : "min-w-0 truncate text-foreground-subtlest";
  const primaryText = latestSummaryEvent ? (
    <span className="inline-flex min-w-0 items-center gap-2">
      <span className="shrink-0 size-4 flex items-center justify-center [&_svg]:size-4">
        {latestToolSummary?.icon ?? CUA_TOOL_ICON}
      </span>
      <span className={animatedTextClass}>
        {latestToolSummary ? (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 font-medium">{latestToolSummary.appName}</span>
            <span className="min-w-0 truncate">{latestToolSummary.primaryText}</span>
          </span>
        ) : null}
      </span>
      {latestToolSummary?.isFailed ? (
        <span className="shrink-0 text-foreground-subtlest">
          {intl.formatMessage({ id: "chat.toolCall.status.failed" })}
        </span>
      ) : null}
    </span>
  ) : null;
  const diffCount = (
    <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap">
      {latestSummaryEvent || !isRunning ? <span>·</span> : null}
      <span>
        {eventCountText}
        {messageCountText ? `, ${messageCountText}` : null}
      </span>
    </span>
  );
  const renderContent = useCallback(
    () => (
      <CuaGroupChildren
        events={events}
        context={context}
        renderAssistantMessage={context.renderAssistantMessage}
        renderReasoning={context.renderReasoning}
      />
    ),
    [context, events],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={isRunning ? null : CUA_TOOL_ICON}
      showIcon={!isRunning}
      canToggle={context.canToggle ?? true}
      forceOpen={!isRunning && (context.forceOpen ?? false)}
      kindLabel={
        isRunning ? null : intl.formatMessage({ id: "chat.toolCall.cua.group.completedLabel" })
      }
      primaryText={isRunning ? primaryText : null}
      prioritizePrimaryText
      diffCount={diffCount}
      animateSummaryContent={isRunning}
      disableSummaryContentAnimation={context.disableSummaryContentAnimation}
      // summaryContentKey 同时编码 toolCallId、最新步骤 id 与状态：ToolLayout 用它决定
      // 是否重播一次摘要切换动画，只编码 toolId 会让第二步开始时动画不触发。
      // 空摘要时退化为固定后缀 empty，保证尚无终态步骤这一状态也有稳定 key，
      // 否则 key 为空会让布局在每次渲染重建摘要节点。
      // 状态这一维不可省：同一步骤从进行中变为失败时步骤 id 不变，
      // 只有状态变化，缺了它失败高亮要等到下一次结构变化才更新。
      summaryContentKey={
        latestSummaryEvent
          ? `cua:${toolCall.toolId}:tool:${latestSummaryEvent.row.toolCallId}:${latestSummaryEvent.node.toolCall.status}`
          : `cua:${toolCall.toolId}:empty`
      }
      isRunning={isRunning}
      title={
        isRunning
          ? (latestToolSummary?.title ?? toolCall.title)
          : intl.formatMessage({ id: "chat.toolCall.cua.group.completedLabel" })
      }
      renderContent={renderContent}
    />
  );
}
