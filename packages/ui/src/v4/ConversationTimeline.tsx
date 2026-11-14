// ============================================================================================
// L1 深度注释：会话时间线（packages/ui/src/v4/ConversationTimeline.tsx）
// 责任边界：把投影好的 rows/renderUnits 变成虚拟列表 + live tail + 滚动锚定 + 目录 rail；
// 不生成行、不改写内容、不持有会话数据（订阅经 sessionDataLayer lease）。
// 读法：先看 INV 表，再按“分区 → 虚拟化 → 滚动意图 → 记忆恢复 → 目录”顺序读。
// ============================================================================================
// INV-1: 分区顺序固定为 rows → withTopicPreparationMessages → splitConversationTimelineLiveTail —— 破坏后果：准备项被追加到 live tail 之后，最后一轮的下方反而出现“待办”卡片。
// INV-2: liveUnit 只能排在虚拟列表末尾（start=totalSize），不得插入虚拟项中间 —— 破坏后果：正在流式的轮被前置虚拟项挤出屏幕，滚到底部看不到最新输出。
// INV-3: 虚拟项 key 必须来自 unit.key，禁止用 index 充当 —— 破坏后果：插入新轮后所有行整体复用错 DOM，展开态与高度缓存全部串位。
// INV-4: estimateSize 必须优先查 TimelineRowHeightCache，再回退固定估计值 —— 破坏后果：行卸载重挂时高度突跳，滚动条抖动。
// INV-5: measureElement 依赖 data-index 反查 ref 里的最新列表 —— 破坏后果：用闭包里的旧列表解析，测到的高度会写到别的轮的缓存上。
// INV-6: scrollMargin 必须严格等于 headerSlotHeight —— 破坏后果：虚拟窗口整体偏移一个 header 高度，用户滚到的区域是空白。
// INV-7: following 存 ref（每帧可变、不触发渲染），只有 backToBottomVisible 走 state —— 破坏后果：跟随态每次变化都重渲染整棵列表，流式期间直接掉帧。
// INV-8: 程序化贴底必须是 instant 赋值 —— 破坏后果：平滑滚动的中间帧被 scroll 判定读成“离底”，跟随态被误关。
// INV-9: 贴底/离底判定必须与 lastObservedScrollTop 对账 —— 破坏后果：滚动已发生但 scroll 事件未派发时，过期的 following=true 会把用户拽回底部。
// INV-10: 用户滚动意图 TTL 为 1200ms，但触摸/拖滚动条期间不得过期 —— 破坏后果：长按拖拽中途意图失效，自动跟随把正在拖的内容抢走。
// INV-11: awayFromBottom 必须在 scroll 事件之前先 commitFollowing(false) —— 破坏后果：终态 layout effect 读到过期 following=true，用户上滚被弹回底部。
// INV-12: prepend 锚定基线由首行 rowId 与上一次 totalSize 组成 —— 破坏后果：补拉历史后用户阅读位置整体下移，视觉上“跳了一下”。
// INV-13: 恢复滚动记忆期间必须抑制 virtualizer 的自动尺寸调整 —— 破坏后果：恢复与自动调整互相拉扯，最终停在错误位置。
// INV-14: scrollMemoryKey 为 null（draft）时既不保存也不恢复 —— 破坏后果：草稿态覆盖真实会话的滚动记忆。
// INV-15: 恢复意图在“目标不可表示且还有更早历史”时必须保留 —— 破坏后果：把临时 clamp 的 scrollTop 当成最终锚点，历史加载完后停在顶部。
// INV-16: headerSlot 高度的 effect 依赖只能是 Boolean(headerSlot)，不能是 ReactNode —— 破坏后果：流式期间每帧重建 ResizeObserver。
// INV-17: 消息层 mask 只在离底时启用 —— 破坏后果：贴底时最后一条消息被淡出，看起来像“内容被截断”。
// INV-18: 浮窗形态下必须关闭 mask —— 破坏后果：输入区不在滚动视口内，遮罩只会吃掉消息。
// INV-19: mask 只能作用在消息层 —— 破坏后果：连 composer 与回底按钮一起被裁掉，出现“按钮下半截消失”。
// INV-20: liveNowMs 只在存在运行中轮时按 1s 推进，停止后不再计时 —— 破坏后果：终态耗时继续增长，与协议事实不一致。
// INV-21: Highspeed 到期只订阅“最近一个边界”，不刷新整表 —— 破坏后果：为等倒计时而每秒重算全部 renderUnits。
// INV-22: 目录 hydration 的 key 必须包含 turnNavigatorDirectoryRevision —— 破坏后果：real-user query 增删后仍被 terminal 永久拦截。
// INV-23: terminal 态必须能被 key 变化打破 —— 破坏后果：同一会议里目录永远不再补拉，rail 少条目。
// INV-24: stale 结果回到 idle，hydrated/not-enough-queries 才是 terminal —— 破坏后果：一次短暂 stale 就永久放弃补拉，或反过来无限重试。
// INV-25: 重试定时器必须在卸载时清理，回调内还要再校验 key —— 破坏后果：卸载后 setState 报警，或旧会话的定时器改写新会话状态。
// INV-26: 目录虚拟项把 live tail 视为 size=MAX_SAFE-totalSize 的尾项 —— 破坏后果：目录判定“当前在第几轮”时永远停在最后一个虚拟行。
// INV-27: activeQueryRowId 优先用已挂载的 row anchor，未挂载才回退 unit —— 破坏后果：虚拟轮未挂载时高亮错位到相邻提问。
// INV-28: 内容宽度变化期间禁用 virtualizer 自动调整 —— 破坏后果：拖拽窗口宽度时列表反复补偿，滚动位置跳动。
// INV-29: 分享面板几何必须写入共享父容器 —— 破坏后果：面板与 dock 各算一套坐标，勾选目标漂走。
// INV-30: 浮窗 dock 高度经 CSS 变量下发给时间线根节点 —— 破坏后果：滚动容器没有让出输入区高度，最后一条消息被输入框盖住。
// INV-31: pointerdown 只在命中滚动容器自身时登记“未知方向”意图 —— 破坏后果：点正文按钮被当成滚动，跟随态被误关。
// INV-32: 可编辑元素上的键盘事件不算滚动意图 —— 破坏后果：在输入框按方向键会让时间线停止跟随。
// INV-33: scrollToBottomActionRef 是宿主的一次性通道，必须每次渲染覆盖 —— 破坏后果：宿主拿到旧闭包，跳到底部失效。
// INV-34: 目录 rail 的显隐由 CSS container query 裁决，宽度测量只用于分页资格 —— 破坏后果：用 JS 宽度重复控制显隐，与 CSS 打架产生闪烁。
// INV-35: 滚动相关回调必须保持稳定引用（高频值经 ref 读取）—— 破坏后果：virtualizer 因回调变化重建，滚动位置丢失。
// INV-36: headerSlot 必须落在 emptyState 分支之外渲染 —— 破坏后果：rows 为空时只读导入块消失，而它本应始终可见。
import { useBotTopicPreparations } from "@/v4/BotTopicPreparation.js";
import { withTopicPreparationMessages } from "@/v4/topicPreparationRenderUnits.js";
/* oxlint-disable eslint(max-lines) -- ConversationTimeline 集中承载虚拟滚动、滚动锚定、loadOlder 与 find 高亮协调；拆散会让同一滚动状态跨文件传递。 */
import {
  Component,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { flushSync } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import { TID_V4_TIMELINE, TID_V4_TIMELINE_BOTTOM } from "@zcode/shared/test-ids";
import type {
  ApiRetryState,
  AttachmentRef,
  CommandAck,
  ConversationRow,
  ConversationRowTarget,
  QueueItem,
  SessionPhase,
} from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import {
  deriveLogicalUiInstances,
  getPluginUiDisclosureVersion,
  getPluginUiManualPin,
  setPluginUiInstanceDerivation,
  subscribePluginUiDisclosure,
  type PluginUiRowPinResolver,
} from "@/plugin-ui/index.js";
import { ConversationPendingGuideList } from "@/v4/ConversationPendingGuideList.js";
import type { AssistantFeedbackHandler } from "@/v4/ConversationRowView.js";
import { ConversationTurnNavigator } from "@/v4/ConversationTurnNavigator.js";
import { syncConversationShareSelectionPanelLayout } from "@/v4/conversationShareSelectionPanelLayout.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import {
  isSameConversationLatestTurnSummary,
  resolveConversationLatestTurnSummary,
  splitConversationTimelineLiveTail,
  type ConversationLatestTurnSummary,
} from "@/v4/conversationTimelineLiveTail.js";
import { armHighspeedFooterExpiryClock } from "@/highspeed/highspeedFooterExpiryClock.js";
import {
  getConversationContentWidthClassName,
  getConversationStatusPanelOffsetClassName,
} from "@/v4/conversationLayout.js";
import {
  buildConversationTurnRenderUnits,
  resolveNextHighspeedExpiryMs,
  type ConversationTurnRenderUnit,
} from "@/v4/conversationTurnRenderUnits.js";
import {
  resolveConversationTurnNavigatorActiveQueryRowId,
  resolveConversationTurnNavigatorHydrationRetryDelayMs,
  shouldHydrateConversationTurnNavigatorDirectory,
  type ConversationTurnNavigatorHydrationResult,
  type ConversationTurnNavigatorQueryPosition,
  type ConversationTurnNavigatorVirtualItem,
} from "@/v4/conversationTurnNavigatorHelpers.js";
import {
  DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
  TimelineRowHeightCache,
} from "@/v4/timelineRowHeightCache.js";
import {
  readChatSessionScrollMemoryState,
  resolveChatSessionScrollRestoreTop,
  saveChatSessionScrollMemoryState,
  type ChatSessionScrollMemoryState,
} from "@/lib/chatSessionScrollMemory.js";
import type {
  ChatSearchResultHighlightRequest,
  ConversationFindMatchState,
} from "@/v4/legacyChatViewTypes.js";
import {
  anchorActionAfterContentChange,
  historyPrefetchTriggerPx,
  initialFollowing,
  isAtBottom,
  prependScrollAdjustment,
  prependVirtualAnchorAdjustment,
  reconcileFollowingForContentAnchor,
  resolveFollowingAfterScroll,
  shouldAdjustVirtualizerForItemSizeChange,
  shouldShowBackToBottom,
  shouldTriggerLoadOlder,
  timelineKeyboardScrollIntent,
  timelineTouchScrollIntent,
  timelineWheelScrollIntent,
  type PrependVirtualAnchor,
  type TimelineUserScrollIntent,
} from "@/v4/timelineScrollAnchor.js";
import { useConversationTimelineFind } from "@/v4/useConversationTimelineFind.js";
import { ConversationSelectionTooltip } from "@/v4/ConversationSelectionTooltip.js";
import type { ConversationSelectionReference } from "@/lib/conversationSelectionReference.js";

// memo 组件参数中的 `pendingGuides = []` 会在每次调用时创建新引用，
// 让未传该属性的渲染绕过稳定引用边界；共享只读空数组可保持默认值恒定。
// [资源] 这个常量是“默认参数引用稳定”的补丁：组件默认值 `pendingGuides = []`
// 会在每次调用时新建数组，让 memo 的浅比较永远判不等（见 INV-35 的同类问题）。
const EMPTY_PENDING_GUIDES: readonly QueueItem[] = [];

// [权衡] 这批常量全部提为模块级并带单位后缀：
// - ROW_OVERSCAN=8 是“屏幕外交付多少行”的性能/流畅度折中，调大能减少快速滚动白屏，
//   但流式期间每个多挂载的行都要重算，设为 8 是实测平衡点；
// - USER_SCROLL_INTENT_TTL_MS=1200 覆盖“滚一下停住”的手势间隔；
// - LAYOUT_SCROLL_GUARD_MS=250 覆盖一次布局提交后的连续 scroll 回调窗口。
const ROW_OVERSCAN = 8;
const RUNNING_WORK_DURATION_TICK_MS = 1000;
const COMPOSER_MESSAGE_MASK_FADE_PX = 24;
const COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX = 96;
const USER_SCROLL_INTENT_TTL_MS = 1200;
const LAYOUT_SCROLL_GUARD_MS = 250;
const CONTENT_WIDTH_RESIZE_SETTLE_MS = 120;
const SCROLL_MEMORY_RESTORE_TOLERANCE_PX = 1;

function scheduleMicrotask(callback: () => void): void {
  // 部分 WebView/最小 DOM 运行时没有 window.queueMicrotask；调度能力应从
  // globalThis 注入，并保留 Promise 微任务降级，避免滚动恢复在 commit 阶段直接中断。
  // [失败路径] 降级路径必须再包一层 try：Promise 被 polyfill 成同步执行时，
  // 回调里的读取会发生在 DOM 更新中途，得到 0 高度。
  if (typeof globalThis.queueMicrotask === "function") {
    globalThis.queueMicrotask(callback);
    return;
  }
  void Promise.resolve().then(callback);
}

// [失败路径] 必须用 instanceof 判空再读属性：事件目标可能是 window、document
// 或 SVG 元素，直接取 tagName 会得到 undefined；而 contentEditable 的宿主
// 可能是 div 内嵌的 span，所以 contentEditable 要单独判而不是靠 tagName。
function isEditableScrollTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

// v4 时间线重写滚动控件时把可访问名称误做成了可见文字，偏离旧版
// 的圆形下箭头样式；这里集中渲染图标按钮，避免两个定位分支再次产生视觉差异。
function ConversationBackToBottomButton({
  className,
  label,
  onClick,
}: {
  className: string;
  label: string;
  onClick: () => void;
}) {
  return (
    // [事务] aria-label 与 title 取同一个 label，但可见内容只有图标：
    // 旧实现把“回到底部”当可见文字渲染，会在窄屏把浮起按钮撑成胶囊，
    // 因此这里必须用 sr-only 承接文字，按钮形状只由图标决定。
    <Button
      aria-label={label}
      title={label}
      type="button"
      size="icon"
      variant="outline"
      className={cn("rounded-full bg-card hover:bg-card-selected", className)}
      data-testid={TID_V4_TIMELINE_BOTTOM}
      // [事务] 点击必须包一层 runUserAction：跳出行为要进 telemetry 的
      // featureId/action/trigger 唯一口径，否则“回到底部”的使用率永远统计不到。
      onClick={() =>
        runUserAction({
          input: { featureId: "conversation.navigation", action: "jump_bottom", trigger: "button" },
          operation: onClick,
          completed: { resultSource: "local_commit" },
          failureStage: "timeline_scroll",
        })
      }
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  );
}

interface ConversationScrollMemoryScopeSnapshot {
  key: string;
  state: ChatSessionScrollMemoryState;
}

type PendingScrollMemoryRestoreWait = "rows" | "content";

interface PendingScrollMemoryRestore extends ConversationScrollMemoryScopeSnapshot {
  rowWindowKey: string;
  waitFor: PendingScrollMemoryRestoreWait;
}

function resolvePendingScrollMemoryRestoreWait(
  state: ChatSessionScrollMemoryState | null,
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight"> | null,
  hasRows: boolean,
): PendingScrollMemoryRestoreWait | null {
  // [事务] 三个早退条件是“能不能现在恢复”的三道门（INV-15）：
  // 没有记忆 → 不用恢复；上次就贴底 → 直接吸底，不必恢复中间位置；
  // 没行或没元素 → 只能等 rows 到达，等待类型记为 "rows"。
  if (!state || state.wasPinnedToBottom !== false) return null;
  if (!hasRows || !element) return "rows";

  const restoredTop = resolveChatSessionScrollRestoreTop(state, element);
  return restoredTop + SCROLL_MEMORY_RESTORE_TOLERANCE_PX < state.scrollTop ? "content" : null;
}

function canReleasePendingScrollMemoryRestore(
  pendingRestore: PendingScrollMemoryRestore,
  element: Pick<HTMLElement, "clientHeight" | "scrollHeight"> | null,
  rowCount: number,
  hasOlderRows: boolean,
  rowWindowKey: string,
): boolean {
  if (!element) return false;
  // [失败路径] 等 rows 的意图遇到 rowCount 仍为 0 时必须继续等待：
  // 此时 element 已挂载但内容为空，任何 restoreTop 都等于 0，提前放行会把
  // “恢复到中间位置”变成“直接跳到顶部”。
  if (pendingRestore.waitFor === "rows" && rowCount === 0) return false;
  const restoredTop = resolveChatSessionScrollRestoreTop(pendingRestore.state, element);
  const targetIsRepresentable =
    restoredTop + SCROLL_MEMORY_RESTORE_TOLERANCE_PX >= pendingRestore.state.scrollTop;
  if (targetIsRepresentable || element.scrollHeight >= pendingRestore.state.scrollHeight) {
    return true;
  }
  // 新 lease 的首帧 rows 可能仍是截断尾窗；只要还能拉取更早历史，就继续保留原始
  // 恢复意图，避免把临时 clamp 后的 scrollTop 当成最终阅读锚点。
  // [事务] 三条同时成立才算“应该继续等”（INV-15）：有行、没有更早历史可拉、
  // 且行窗口已经换过一次。少了 rowWindowKey 比较，同一个窗口会无限重试。
  return rowCount > 0 && !hasOlderRows && pendingRestore.rowWindowKey !== rowWindowKey;
}

interface ConversationScrollMemoryScopeCaptureProps {
  scopeKey: string | null;
  capture: (previousKey: string | null) => ConversationScrollMemoryScopeSnapshot | null;
  commit: (snapshot: ConversationScrollMemoryScopeSnapshot | null) => void;
}

/** React 的 before-mutation snapshot：scope cleanup 时普通 layout effect 已看到新 DOM。 */
class ConversationScrollMemoryScopeCapture extends Component<
  ConversationScrollMemoryScopeCaptureProps,
  unknown,
  ConversationScrollMemoryScopeSnapshot | null
> {
  getSnapshotBeforeUpdate(
    previousProps: ConversationScrollMemoryScopeCaptureProps,
  ): ConversationScrollMemoryScopeSnapshot | null {
    // [事务] scopeKey 没变必须返回 null 而不是重新快照：切换会话时才需要
    // “先读旧 DOM 再换新 DOM”，同会话内的普通更新重新读会把 restore 状态打乱。
    if (previousProps.scopeKey === this.props.scopeKey) return null;
    return this.props.capture(previousProps.scopeKey);
  }

  componentDidUpdate(
    _previousProps: ConversationScrollMemoryScopeCaptureProps,
    _previousState: unknown,
    snapshot: ConversationScrollMemoryScopeSnapshot | null,
  ): void {
    // [并发] commit 在这里而不是在 getSnapshot 里：快照阶段 React 仍在渲染流程中，
    // 只允许读取；写 store 必须等 DOM 提交完成，否则会触发 re-render 告警。
    this.props.commit(snapshot);
  }

  render(): null {
    return null;
  }
}

/** tanstack 默认测量的竖向复刻：优先 ResizeObserver entry（不触发同步布局）。 */
function measureRowHeight(element: Element, entry: ResizeObserverEntry | undefined): number {
  // [资源] 优先读 ResizeObserver entry 的 borderBoxSize：这是回调已算好的布局盒子，
  // 不触发布局计算；回退到 getBoundingClientRect 会强制同步 reflow，
  // 在流式期间每次 delta 后对每行都做一次是不可接受的代价。
  const boxSize = entry?.borderBoxSize?.[0];
  if (boxSize) {
    return Math.round(boxSize.blockSize);
  }
  return Math.round(element.getBoundingClientRect().height);
}

// [事务] 缓存 key 直接取 unit.key（INV-3/4）：它既是虚拟项 key 也是测高缓存 key，
// 两者同一来源才能保证“行换了 key 就换缓存”，不会把上一轮的高度套到下一轮。
function getUnitHeightCacheKey(unit: ConversationTurnRenderUnit | undefined): string | undefined {
  return unit?.key;
}

export interface ConversationTimelineProps {
  rows: readonly ConversationRow[];
  // [事务] rows 是“当前窗口”而不是全量：totalCount 才是全序行数（INV-1 的输入），
  // 两者混用会让滚动条按窗口长度估算，补拉历史后总高度忽然变长。
  /** 手机远控窄屏允许整条会话 flex 链按抽屉宽度收缩；桌面布局保持原样。 */
  compactForRemoteControl?: boolean;
  /** CLI 权威 queue 中等待 model-step 注入的 guide；只改变 renderer 落位。 */
  pendingGuides?: readonly QueueItem[];
  // [事务] apiRetry 只交给 live turn（INV-2 的同类约束）：它描述“正在重试”，
  // 历史轮渲染它会让用户以为旧消息还在重跑。
  /** runtime memory 状态，只交给当前 live turn，不进入历史虚拟列表。 */
  apiRetry?: ApiRetryState | null;
  /** 投影全序行数（rows.totalCount；窗口截断后大于 rows.length，仅用于滚动条估计/诊断）。 */
  totalCount: number;
  /**
   * 会话身份键（sessionId ?? "draft"）。切换时重置滚动锚定与测高缓存——
   * rowId 在不同 session 间会重复，测高缓存禁止跨会话串号。
   */
  sessionKey: string;
  /** renderer-local 滚动记忆 key；draft 为 null，不参与保存或恢复。 */
  scrollMemoryKey?: string | null;
  /** 行渲染上下文（theme/codePreviewSettings/workspacePath）；宿主保证引用稳定。 */
  rowContext: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  onEdit?: (
    target: ConversationRowTarget,
    newText: string,
    attachments?: readonly AttachmentRef[],
    workspaceMode?: "preserve" | "rewind",
  ) => Promise<CommandAck | boolean | void> | CommandAck | boolean | void;
  /** 还有更早历史可拉（窗口首行 > 全序首行）。 */
  canLoadOlder?: boolean;
  /** loadOlder 在途，抑制重复触发。 */
  loadingOlder?: boolean;
  /** 拉取更早一窗历史（接近顶部时自动预取）。 */
  onLoadOlder?: () => Promise<void> | void;
  /** 宽屏问题目录挂载后一次补齐当前有效分支的全部历史。 */
  onLoadAllOlder?: () => Promise<ConversationTurnNavigatorHydrationResult>;
  /**
   * 问题导航目录失效代际（store turnNavigatorDirectoryRevision）。
   * real-user query 增删后终态必须失效重探测；组件 hydration key
   * 追加此 revision，避免同一 logEpoch 内永久拦截。
   */
  turnNavigatorDirectoryRevision?: number;
  /** 与旧 ChatView 对齐：composer dock 属于同一个滚动视口，sticky 到滚动容器底部。 */
  bottomDock?: ReactNode;
  /** 分享选择面板所在的共享父容器；用于把 dock 的真实位置写入同一坐标系。 */
  selectionPanelLayoutContainerRef?: { current: HTMLElement | null };
  /**
   * 锁定背景滚动。
   *
   * 分享选择面板只用 scrim 隔离了正文指针事件，滚动容器仍是 overflow-y-auto，
   * 原生滚动条拖拽和键盘 PageUp/Down 仍能改变 scrollTop，勾选目标会在面板下方漂走。
   */
  backgroundScrollLocked?: boolean;
  /** rows 为空时的可选内容；正式空 session 传空，草稿态传问候语。 */
  emptyState?: ReactNode;
  /**
   * 滚动容器内、消息层之上的常驻内容（分享导入的只读块 + 分割线）。
   *
   * 必须在容器内而不是做成固定横幅，才能与实时对话一起滚动；rows 为空时也要渲染，
   * 所以它落在 emptyState 分支之外。
   */
  headerSlot?: ReactNode;
  /** 草稿态让 emptyState 与同一个 bottomDock 作为整体居中，不重挂 composer。 */
  centerEmptyStateWithDock?: boolean;
  /** 窄屏/粗指针视口保留紧凑居中布局，不复用桌面草稿安全间距。 */
  compactEmptyStateWithDock?: boolean;
  /**
   * Side Pane 完整视图浮窗形态：底部输入区不留内边距，输入框外壳即浮窗最外层；
   * 输入区脱离滚动流贴在时间线底部，滚动容器（含滚动条）止于输入框上方。
   */
  floatingComposerDock?: boolean;
  /** 浮窗形态下上报底部输入区实测高度，宿主据此裁剪收起态。 */
  onComposerDockHeightChange?: (heightPx: number) => void;
  // [事务] 该回调“只在值变化时触发”：它会被写进宿主 state，若每次布局都回调，
  // 宿主 setState → 时间线重渲染 → 再测高，形成稳定循环。
  /**
   * 浮窗形态下上报最后一个回合的运行状态、运行时长与最终回答（同一个 render unit），
   * 供输入框占位「工作中 N 秒」与回答气泡使用；值变化时才回调。
   */
  onLatestTurnSummaryChange?: (summary: ConversationLatestTurnSummary) => void;
  /** 右侧状态面板对消息列的布局模式；auto 由 conversation container query 裁决。 */
  summaryPanelLayout?: "none" | "auto" | "inline";
  conversationFindQuery?: string;
  conversationFindActiveIndex?: number;
  conversationFindNavigationRequestId?: number;
  onConversationFindMatchStateChange?: (state: ConversationFindMatchState) => void;
  searchResultHighlightRequest?: ChatSearchResultHighlightRequest | null;
  onSearchResultHighlightDone?: (requestId: number) => void;
  sessionPhase?: SessionPhase;
  /** 宿主可调用的一次性“滚动到底部”动作；不持有 conversation 或跨 renderer 状态。 */
  scrollToBottomActionRef?: { current: (() => void) | null };
  // [事务] 两个 actionRef 都是“命令通道”而非状态：组件每次渲染都会覆盖 current（INV-33），
  // 因此宿主必须在调用时读取 current，不能把函数缓存到自己的闭包里。
  /** 宿主可调用的一次性 query 定位动作；不改变分享面板 view。 */
  scrollToQueryActionRef?: {
    current: ((target: { unitIndex: number; rowId: number }) => void) | null;
  };
  selectionActions?: {
    enabled: boolean;
    sideActionDisabled?: boolean;
    onAddToCurrentTask: (reference: ConversationSelectionReference) => void;
    onAskInSideChat: (reference: ConversationSelectionReference) => void;
  };
  /** 范围编辑时，左侧 rail 由分享选择面板独占。 */
  hideTurnNavigator?: boolean;
}

/**
 * 虚拟滚动 timeline：动态测高（ResizeObserver 驱动 remeasure）+ 底部锚定 +
 * 「回到底部」。滚动位置/跟随态/测高缓存全部为组件实例状态——多 pane（同会话或
 * 异会话）各自独立，互不干扰；数据订阅共享经 sessionDataLayer lease 处理。
 *
 * React 性能：rows 高频变化（流式 delta），滚动相关回调全部经 ref 读取最新值，
 * 保持稳定引用；跟随态存 ref（每帧变化不触发渲染），仅「回到底部」可见性走 state。
 */
function ConversationTimelineImpl({
  rows,
  compactForRemoteControl = false,
  pendingGuides = EMPTY_PENDING_GUIDES,
  apiRetry = null,
  totalCount,
  sessionKey,
  scrollMemoryKey = null,
  rowContext,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
  canLoadOlder = false,
  loadingOlder = false,
  onLoadOlder,
  onLoadAllOlder,
  turnNavigatorDirectoryRevision = 0,
  bottomDock,
  selectionPanelLayoutContainerRef,
  backgroundScrollLocked = false,
  emptyState,
  headerSlot,
  centerEmptyStateWithDock = false,
  compactEmptyStateWithDock = false,
  floatingComposerDock = false,
  onComposerDockHeightChange,
  onLatestTurnSummaryChange,
  summaryPanelLayout = "none",
  conversationFindQuery = "",
  conversationFindActiveIndex = -1,
  conversationFindNavigationRequestId = 0,
  onConversationFindMatchStateChange,
  searchResultHighlightRequest,
  onSearchResultHighlightDone,
  sessionPhase,
  scrollToBottomActionRef,
  scrollToQueryActionRef,
  selectionActions,
  hideTurnNavigator = false,
}: ConversationTimelineProps) {
  const { intl } = useZCodeIntl();
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerSlotRef = useRef<HTMLDivElement>(null);
  // [事务] headerSlotHeight 直接参与 virtualizer 的 scrollMargin 换算（INV-6）：
  // 这里量的是“滚动容器内、虚拟列表之上的高度”，单位必须与 scrollMargin 一致，
  // 因此用 getBoundingClientRect 实测而不是按行数估算。
  // headerSlot 高度参与虚拟窗口换算（scrollMargin），必须随内容与宽度变化实时跟进，
  // 否则只读块加载完成或窗口变宽换行后，虚拟行会整体错位。
  //
  // 依赖必须是「有没有 slot」而不是 headerSlot 本身：后者是 ReactNode，宿主传的是内联 JSX，
  // 每次渲染都是新对象，会让 ResizeObserver 在流式输出期间每帧重建。
  const hasHeaderSlot = Boolean(headerSlot);
  const [headerSlotHeight, setHeaderSlotHeight] = useState(0);
  useEffect(() => {
    const element = headerSlotRef.current;
    if (!element) {
      setHeaderSlotHeight(0);
      return;
    }
    const sync = () => {
      const next = element.getBoundingClientRect().height;
      // [权衡] 0.5px 容差是必需的：子像素高度在缩放/DPR 变化时会在 x 与 x+0.6 之间
      // 抖动，无容差会让 setState 每帧触发，进而让整个时间线每秒重渲染几十次。
      setHeaderSlotHeight((current) => (Math.abs(current - next) < 0.5 ? current : next));
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasHeaderSlot]);
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  // [事务] “当前时间”是整棵 renderUnits 的输入（builder 用它算工作中耗时），
  // 因此它变化会让 renderUnits 全量重建；下面只在存在运行中轮时才推进它（INV-20）。
  // 插件卡片展示模型——同资源替代 + 最近三回合自动展开 + 手动固定；推导结果发布给卡片自己读。
  const pluginUiDerivation = useMemo(() => deriveLogicalUiInstances(rows), [rows]);
  useEffect(() => {
    setPluginUiInstanceDerivation(sessionKey, pluginUiDerivation);
  }, [pluginUiDerivation, sessionKey]);
  const pluginUiDisclosureVersion = useSyncExternalStore(
    subscribePluginUiDisclosure,
    getPluginUiDisclosureVersion,
    getPluginUiDisclosureVersion,
  );
  const pluginUiPinResolver = useMemo<PluginUiRowPinResolver>(() => {
    // 手动固定 / 收起变化（version 递增）时重建 resolver，折叠边界随之重算。
    // [事务] 这里 `void pluginUiDisclosureVersion` 是刻意的“依赖占位”：值本身不参与
    // 计算，但必须让它进依赖并且触发重建，否则手动固定后卡片不会重新分组。
    void pluginUiDisclosureVersion;
    return (toolCallId) => ({
      disposition: pluginUiDerivation.byToolCallId[toolCallId],
      manualPinned: getPluginUiManualPin(sessionKey, toolCallId),
    });
  }, [pluginUiDerivation, sessionKey, pluginUiDisclosureVersion]);
  const topicPreparations = useBotTopicPreparations();
  // [事务] 分区三步必须按序执行（INV-1）：先建轮、再把准备项并入（它会修改最后一轮），
  // 最后才切出 live tail。把拆尾放到最前，准备项会被追加到一个已冻结的虚拟项之后。
  const renderUnits = useMemo(
    () =>
      withTopicPreparationMessages(
        buildConversationTurnRenderUnits(rows, {
          nowMs: liveNowMs,
          sessionPhase,
          pluginUiPinResolver,
        }),
        rows,
        topicPreparations,
      ),
    [liveNowMs, pluginUiPinResolver, rows, sessionPhase, topicPreparations],
  );
  const { virtualizedUnits, liveUnit, liveUnitIndex } = useMemo(
    // [事务] split 只拆“最后一个运行中/可追加的轮”（INV-2）：liveUnit 不进虚拟列表，
    // 因此它的高度永远不被测量缓存，避免每帧 delta 都写一次缓存。
    () => splitConversationTimelineLiveTail(renderUnits),
    [renderUnits],
  );
  const hasRunningUnit = useMemo(() => renderUnits.some((unit) => unit.isRunning), [renderUnits]);
  // [事务] liveNowMs 的推进开关就是它（INV-20）：用 some 而不是取最后一个轮的 isRunning，
  // 因为用户可能上滚阅读，最后一个可见轮不是运行中的那一轮。
  const latestTurnSummary = useMemo(
    () => resolveConversationLatestTurnSummary(renderUnits),
    [renderUnits],
  );
  // 回调随会话 owner 变化；换了回调必须重新上报，不能因值相同而跳过。
  const reportedLatestTurnSummaryRef = useRef<{
    callback: (summary: ConversationLatestTurnSummary) => void;
    summary: ConversationLatestTurnSummary;
  } | null>(null);
  useEffect(() => {
    if (!onLatestTurnSummaryChange) {
      // [资源] 回调消失时必须清空最后一次上报的记录：否则回调再次挂载时，
      // 因“summary 相同”而跳过上报，新宿主永远收不到当前状态。
      reportedLatestTurnSummaryRef.current = null;
      return;
    }
    const reported = reportedLatestTurnSummaryRef.current;
    if (
      reported?.callback === onLatestTurnSummaryChange &&
      isSameConversationLatestTurnSummary(reported.summary, latestTurnSummary)
    ) {
      return;
    }
    reportedLatestTurnSummaryRef.current = {
      callback: onLatestTurnSummaryChange,
      summary: latestTurnSummary,
    };
    onLatestTurnSummaryChange(latestTurnSummary);
  }, [latestTurnSummary, onLatestTurnSummaryChange]);
  const nextHighspeedExpiryMs = useMemo(
    // [事务] 只订阅“最近一个到期时间”而不是整表（INV-21）：计时器只需要知道
    // 下一次该在什么时候醒来，其余卡片的过期状态由那次唤醒一次算清。
    () => resolveNextHighspeedExpiryMs(rows, liveNowMs),
    [liveNowMs, rows],
  );
  const turnNavigatorQueryRowIds = useMemo(
    // [事务] 目录只认 origin === "realUser" 的行：guide/注入句也有 rowId，
    // 若不筛会让目录里出现用户从未输入过的问题（见 INV-27 的同类口径）。
    () =>
      new Set(
        renderUnits.flatMap((unit) =>
          unit.visibleUserInputs.filter((row) => row.origin === "realUser").map((row) => row.rowId),
        ),
      ),
    [renderUnits],
  );
  const turnNavigatorQueryRowIdsRef = useRef(turnNavigatorQueryRowIds);
  turnNavigatorQueryRowIdsRef.current = turnNavigatorQueryRowIds;
  const centeredEmptyLayout = centerEmptyStateWithDock && renderUnits.length === 0;
  // [失败路径] 两个居中开关必须分开：窄屏/粗指针视口不适用桌面草稿安全间距，
  // 合并成一个会让手机草稿态上下各多出一大块留白。
  const responsiveCenteredEmptyLayout = centeredEmptyLayout && !compactEmptyStateWithDock;
  // 高频值经 ref 供稳定回调读取（不进依赖数组）。
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const unitsRef = useRef(renderUnits);
  unitsRef.current = renderUnits;
  const virtualizedUnitsRef = useRef(virtualizedUnits);
  virtualizedUnitsRef.current = virtualizedUnits;
  const liveTailRef = useRef<HTMLDivElement>(null);
  const messageLayerRef = useRef<HTMLDivElement>(null);
  const virtualHistoryRef = useRef<HTMLDivElement>(null);
  const stableContentWidthRef = useRef<number | null>(null);
  const contentWidthResizeActiveRef = useRef(false);
  const contentWidthResizeSettleTimerRef = useRef<number | null>(null);
  const committingMeasuredLayoutRef = useRef(false);
  const messageLayerMaskObserverRef = useRef<ResizeObserver | null>(null);
  const isContentWidthChanging = useCallback(() => {
    // [事务] 三个来源任一成立都算“宽度正在变”（INV-28）：提交测高期间、resize
    // 静默窗内、以及实测宽度与稳定宽度不一致。漏掉第一个会让测高写成旧宽度的高度。
    const currentContentWidth = virtualHistoryRef.current?.clientWidth ?? null;
    const stableContentWidth = stableContentWidthRef.current;
    return (
      committingMeasuredLayoutRef.current ||
      contentWidthResizeActiveRef.current ||
      (currentContentWidth !== null &&
        stableContentWidth !== null &&
        currentContentWidth !== stableContentWidth)
    );
  }, []);
  // loadOlder 相关值经 ref 读取，保持 handleScroll 稳定引用。
  const loadOlderRef = useRef({ canLoadOlder, loadingOlder, onLoadOlder });
  loadOlderRef.current = { canLoadOlder, loadingOlder, onLoadOlder };
  const followingRef = useRef(initialFollowing());
  const programmaticScrollFrameRef = useRef<number | null>(null);
  const userScrollIntentRef = useRef<{
    intent: TimelineUserScrollIntent;
    observedAt: number;
  }>({ intent: "none", observedAt: 0 });
  const touchClientYRef = useRef<number | null>(null);
  const scrollbarPointerIdRef = useRef<number | null>(null);
  const layoutScrollGuardUntilRef = useRef(0);
  const userAdjustedScrollSinceRestoreRef = useRef(false);
  const suppressVirtualizerAdjustmentDuringRestoreRef = useRef(false);
  const latestScrollMemoryStateRef = useRef<{
    key: string;
    state: ChatSessionScrollMemoryState;
  } | null>(null);
  const pendingDetachedScrollRestoreRef = useRef<PendingScrollMemoryRestore | null>(null);
  // 组件「已账目」的 scrollTop——scroll 事件读取值或组件自身
  // 程序化写入（贴底/prepend 平移）后的回读值。贴底 effect 拿它对账未观察滚动
  // （滚动已发生、scroll 事件未派发），防止过期 following=true 把用户/测试的上滚拽回底部。
  const lastObservedScrollTopRef = useRef(0);
  // prepend 锚定基线（上一 commit 的首行/总高度），见下方对账效应。
  const prependAnchorRef = useRef<{
    firstRowId: number | null;
    totalSize: number;
  }>({ firstRowId: null, totalSize: 0 });
  const pendingPrependVirtualAnchorRef = useRef<PrependVirtualAnchor | null>(null);
  const heightCacheRef = useRef<TimelineRowHeightCache | null>(null);
  if (heightCacheRef.current === null) {
    heightCacheRef.current = new TimelineRowHeightCache();
  }
  const [backToBottomVisible, setBackToBottomVisible] = useState(false);
  const [turnNavigatorViewport, setTurnNavigatorViewport] = useState({
    scrollOffsetPx: 0,
    viewportHeightPx: 0,
    activeQueryRowId: undefined as number | undefined,
  });
  const [turnNavigatorContainerWidthPx, setTurnNavigatorContainerWidthPx] = useState(0);
  const turnNavigatorJumpFrameRef = useRef<number | null>(null);
  const turnNavigatorHydrationAttemptRef = useRef<{
    attemptCount: number;
    key: string | null;
    retryTimer: number | null;
    status: "idle" | "in-flight" | "waiting" | "terminal";
  }>({ attemptCount: 0, key: null, retryTimer: null, status: "idle" });
  const [turnNavigatorHydrationRetryRevision, setTurnNavigatorHydrationRetryRevision] = useState(0);
  const timelineRootRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const floatingComposerDockRef = useRef(floatingComposerDock);
  floatingComposerDockRef.current = floatingComposerDock;
  const shareSelectionPanelLayoutRef = useRef<{
    centerYPx: number;
    maxHeightPx: number;
  } | null>(null);
  // 右侧状态面板完整 inline 展开时，中间消息列和输入 dock 必须使用同一偏移；
  // 否则面板会覆盖正文，而不是并排布局。
  const summaryPanelInlineOffsetClassName =
    getConversationStatusPanelOffsetClassName(summaryPanelLayout);
  const contentWidthClassName = getConversationContentWidthClassName({
    centeredEmptyLayout,
    statusPanelLayout: summaryPanelLayout,
  });

  const syncShareSelectionPanelLayout = useCallback(() => {
    if (!backgroundScrollLocked) return;
    const container = selectionPanelLayoutContainerRef?.current;
    const dock = composerDockRef.current;
    if (!container || !dock) return;

    // 选择面板是 SessionPane 的兄弟节点，不能把 CSS 变量写在 Timeline
    // 自身，否则面板拿不到 dock 的真实边界；统一写入共享父容器供两者使用。
    const layout = syncConversationShareSelectionPanelLayout(container, dock);
    const previous = shareSelectionPanelLayoutRef.current;
    if (previous?.centerYPx === layout.centerYPx && previous.maxHeightPx === layout.maxHeightPx) {
      return;
    }
    shareSelectionPanelLayoutRef.current = layout;
  }, [backgroundScrollLocked, selectionPanelLayoutContainerRef]);

  useLayoutEffect(() => {
    if (!backgroundScrollLocked) return;
    const container = selectionPanelLayoutContainerRef?.current;
    const dock = composerDockRef.current;
    if (!container || !dock) return;

    syncShareSelectionPanelLayout();
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(syncShareSelectionPanelLayout);
      resizeObserver.observe(container);
      resizeObserver.observe(timelineRootRef.current ?? container);
      if (scrollRef.current) resizeObserver.observe(scrollRef.current);
      resizeObserver.observe(dock);
    }

    // ResizeObserver 在部分 Electron flex 布局中可能晚于窗口尺寸变化回调，
    // 因此窗口 resize 也始终触发一次几何同步，保证面板随窗口放大/缩小。
    window.addEventListener("resize", syncShareSelectionPanelLayout);
    return () => {
      window.removeEventListener("resize", syncShareSelectionPanelLayout);
      resizeObserver?.disconnect();
    };
  }, [backgroundScrollLocked, selectionPanelLayoutContainerRef, syncShareSelectionPanelLayout]);

  const hasBottomDock = Boolean(bottomDock);
  useLayoutEffect(() => {
    // 完整视图浮窗收起态只露出底部输入区：由 dock 自身测量并上报高度（权限/问答卡片
    // 替换输入框时高度随之变化），宿主不去猜 SessionPane 内部结构。
    const dock = composerDockRef.current;
    if (!onComposerDockHeightChange || !dock || !hasBottomDock) return;
    const report = () => onComposerDockHeightChange(dock.getBoundingClientRect().height);
    report();
    if (typeof ResizeObserver === "undefined") return;
    const resizeObserver = new ResizeObserver(report);
    resizeObserver.observe(dock);
    return () => resizeObserver.disconnect();
  }, [hasBottomDock, onComposerDockHeightChange]);

  useEffect(() => {
    if (!hasRunningUnit) {
      // [事务] 没有运行中轮就直接返回且不清理时钟：清理在 effect 的 return 里，
      // 这里返回 undefined 表示“本 effect 没有需要回收的资源”，符合 React 契约。
      return;
    }

    // 运行中的 assistant work 状态文案要显示“工作中 N 秒”并随时间推进；
    // 完成态耗时由协议事实固定，builder 会拒绝把这个 UI 时钟用于已结束轮次。
    setLiveNowMs(Date.now());
    const timer = window.setInterval(() => {
      setLiveNowMs(Date.now());
    }, RUNNING_WORK_DURATION_TICK_MS);

    // [资源] 清理必须清掉 interval 而不是只置空引用：运行中 → 终态的切换会重跑
    // 这个 effect，漏清理会让多个 1s 定时器同时推进 liveNowMs，耗时数字跳得比时间快。
    return () => window.clearInterval(timer);
  }, [hasRunningUnit]);

  useEffect(() => {
    if (nextHighspeedExpiryMs === undefined) return;

    // Bug 根因：会话完成后工作时钟会停止；若 Highspeed 卡稍后才到期，footer 不会自行出现。
    // 单独订阅最近的卡片到期边界，避免为了等待倒计时持续刷新整个历史列表。
    // spec §9.3：到期唤醒基于 renderer setTimeout，窗口隐藏/被遮挡时会被 Chromium 冻结停摆；
    // helper 额外监听窗口恢复可见/获得焦点并即时追平 liveNowMs，footer 才能不依赖用户再发
    // 消息就出现。与 SessionPane 的 highspeedAutoShareClock 窗口唤醒补偿分工：那条刷新分享
    // 入口/查看按钮的完成态数据，这条刷新组尾 footer 的显隐时钟。
    return armHighspeedFooterExpiryClock(nextHighspeedExpiryMs, () => setLiveNowMs(Date.now()));
  }, [nextHighspeedExpiryMs]);

  useLayoutEffect(() => {
    const element = timelineRootRef.current;
    if (!element) return;

    // rail 改由 CSS container query 隐藏后，完整历史补拉失去了同一宽度
    // 资格边界，手机远控与窄分屏也会请求全部 rows。这里仅同步只读分页资格；
    // rail 的显隐、占位与过渡仍完全由 CSS 裁决，不恢复 composer 几何测量。
    const commitWidth = (width: number) => {
      // [权衡] 取整后比较再写 state：ResizeObserver 的 inlineSize 带小数，
      // 直接写入会让缩放窗口时每帧 setState，整棵时间线跟着重渲染。
      const normalizedWidth = Math.max(0, Math.round(width));
      setTurnNavigatorContainerWidthPx((current) =>
        current === normalizedWidth ? current : normalizedWidth,
      );
    };
    const readWidth = () => commitWidth(element.clientWidth);
    readWidth();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        const borderBox = entry?.borderBoxSize?.[0];
        commitWidth(borderBox?.inlineSize ?? entry?.contentRect.width ?? element.clientWidth);
      });
      observer.observe(element);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", readWidth);
    return () => window.removeEventListener("resize", readWidth);
  }, []);

  useEffect(() => {
    if (
      !shouldHydrateConversationTurnNavigatorDirectory({
        canLoadOlder,
        containerWidthPx: turnNavigatorContainerWidthPx,
        hasLoadHandler: Boolean(onLoadAllOlder),
        loadingOlder,
      })
    ) {
      return;
    }
    // terminal key 必须与 store turnNavigatorDirectoryRevision 同步。
    // 仅用 sessionKey + logEpoch 时，real-user query 增删不换 epoch，
    // 组件层 terminal 永久拦截，store 即使失效缓存也无法重新探测。
    const hydrationKey = `${sessionKey}:${rowContext.logEpoch ?? "unknown"}:${turnNavigatorDirectoryRevision}`;
    const attempt = turnNavigatorHydrationAttemptRef.current;
    // [事务] key 变化必须同时清掉在途重试定时器（INV-22/23）：否则旧 key 的定时器
    // 到点后会把新 key 的状态改回 idle，触发一次多余的全量补拉。
    if (attempt.key !== hydrationKey) {
      if (attempt.retryTimer !== null) window.clearTimeout(attempt.retryTimer);
      Object.assign(attempt, {
        attemptCount: 0,
        key: hydrationKey,
        retryTimer: null,
        status: "idle" as const,
      });
    }
    if (attempt.status !== "idle" || !onLoadAllOlder) return;
    attempt.status = "in-flight";
    logger.debug("[v4-turn-navigator] 目录请求补齐完整历史", {
      attempt: attempt.attemptCount + 1,
      loadedRows: rows.length,
      sessionKey,
      totalRows: totalCount,
    });
    void onLoadAllOlder().then((result) => {
      // [并发] 回调第一件事就是校验 key（INV-25）：请求可能跨越会话切换，
      // 直接改 attempt 会把旧会话的结局写进新会话的状态机。
      if (attempt.key !== hydrationKey) return;
      if (result.status === "hydrated" || result.status === "not-enough-queries") {
        // [事务] 只有这两种视为终态（INV-24）：前者目录已经完整，后者说明本来就没有
        // 足够问题可列，重试只会浪费一次全量补拉。
        attempt.status = "terminal";
        return;
      }
      if (result.status === "stale") {
        // [失败路径] stale 必须回到 idle 而不是 terminal：它表示“这次结果不算数”，
        // 下一次 render 应允许重新发起，否则目录会永久缺一段。
        attempt.status = "idle";
        return;
      }
      attempt.attemptCount += 1;
      const retryDelayMs = resolveConversationTurnNavigatorHydrationRetryDelayMs(
        attempt.attemptCount,
      );
      if (retryDelayMs === null) {
        attempt.status = "terminal";
        return;
      }
      attempt.status = "waiting";
      attempt.retryTimer = window.setTimeout(() => {
        if (attempt.key !== hydrationKey) return;
        attempt.retryTimer = null;
        attempt.status = "idle";
        setTurnNavigatorHydrationRetryRevision((revision) => revision + 1);
      }, retryDelayMs);
    });
  }, [
    canLoadOlder,
    loadingOlder,
    onLoadAllOlder,
    rowContext.logEpoch,
    rows,
    sessionKey,
    totalCount,
    turnNavigatorContainerWidthPx,
    turnNavigatorDirectoryRevision,
    turnNavigatorHydrationRetryRevision,
  ]);

  useEffect(
    () => () => {
      // [资源] 这是唯一的卸载清理点（INV-25）：重试定时器持有 setState，
      // 不清理会在组件卸载后触发更新，也会在开发模式下反复警告。
      const timer = turnNavigatorHydrationAttemptRef.current.retryTimer;
      if (timer !== null) window.clearTimeout(timer);
    },
    [],
  );

  const getScrollElement = useCallback(() => scrollRef.current, []);
  // [事务] 稳定引用（INV-35）：getItemKey 只在组件首次渲染时被 virtualizer 捕获，
  // 因此它必须通过 ref 读最新列表，而不能闭包捕获 virtualizedUnits。
  const getItemKey = useCallback(
    (index: number) => virtualizedUnitsRef.current[index]?.key ?? index,
    [],
  );
  // 测高缓存兜底：行卸载重挂（甚至 virtualizer 重建）时用上次真实测量代替固定估计。
  // [失败路径] 缓存不可用时回退 DEFAULT_ROW_HEIGHT_ESTIMATE_PX 而不是 0：
  // 0 会让总高度估算严重偏小，滚动条瞬间变短并把用户位置夹到顶部。
  const estimateSize = useCallback(
    (index: number) =>
      heightCacheRef.current?.estimate(
        getUnitHeightCacheKey(virtualizedUnitsRef.current[index]),
        DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
      ) ?? DEFAULT_ROW_HEIGHT_ESTIMATE_PX,
    [],
  );
  // 动态测高：virtualizer 对窗口内元素挂 ResizeObserver，流式行长高即回调此处；
  // 同时把真实高度写入稳定的 turnId 缓存。
  const measureElement = useCallback((element: Element, entry: ResizeObserverEntry | undefined) => {
    const height = measureRowHeight(element, entry);
    // [事务] data-index 是 virtualizer 自己的索引，必须用它回查列表（INV-5）：
    // 用元素上的 data-turn-id 之类业务属性反查会多一层映射，且在复用 key 时失效。
    const indexAttr = element.getAttribute("data-index");
    const unit = indexAttr === null ? undefined : virtualizedUnitsRef.current[Number(indexAttr)];
    const cacheKey = getUnitHeightCacheKey(unit);
    if (cacheKey !== undefined) {
      heightCacheRef.current?.set(cacheKey, height);
    }
    return height;
  }, []);

  const [, commitMeasuredLayout] = useState(0);
  // [事务] 这个空渲染只在 virtualizer 通知“需要重算”时被调用：它的唯一作用是
  // 强制一次 re-render，让 getVirtualItems 的结果应用到 DOM。
  const virtualizer = useVirtualizer({
    count: virtualizedUnits.length,
    getScrollElement,
    estimateSize,
    overscan: ROW_OVERSCAN,
    getItemKey,
    measureElement,
    // headerSlot（分享导入的只读块）与虚拟列表同处一个滚动容器，
    // 且高度可观。不告知这段偏移，虚拟窗口会按 scrollTop 直接索引 item，
    // 渲染窗口整体偏移一个 header 高度，用户滚到的区域会是空白。
    scrollMargin: headerSlotHeight,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
    // [事务] 这个钩子是“自适应高度 + 贴底”的核心（INV-8/13/28/9）：
    // 四个条件任一成立就不补偿滚动位置。它必须读 ref 而不是 state，
    // 因为 virtualizer 会在渲染中间同步调用它，此时 state 还是上一帧的值。
    return shouldAdjustVirtualizerForItemSizeChange({
      suppressAdjustment: suppressVirtualizerAdjustmentDuringRestoreRef.current,
      following: followingRef.current,
      contentWidthChanging: isContentWidthChanging(),
      itemEnd: item.end,
      scrollTop: scrollRef.current?.scrollTop ?? 0,
    });
  };
  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const turnNavigatorVirtualItems: ConversationTurnNavigatorVirtualItem[] = useMemo(() => {
    // [事务] live tail 用 MAX_SAFE_INTEGER 撑到无穷远（INV-26）：目录只需要
    // “最后一项覆盖剩余全部滚动区”，声明真实高度反而要等一轮测高才有值。
    const historyItems = virtualRows.map((row) => ({
      index: row.index,
      size: row.size,
      start: row.start,
    }));
    if (liveUnitIndex === null) return historyItems;
    return [
      ...historyItems,
      {
        index: liveUnitIndex,
        start: totalSize,
        // live tail 不参与 virtualizer 测高；覆盖剩余滚动区即可供目录判定当前轮次。
        size: Number.MAX_SAFE_INTEGER - totalSize,
      },
    ];
  }, [liveUnitIndex, totalSize, virtualRows]);
  const mountedRowsKey = useMemo(
    () =>
      [
        ...virtualRows.map((row) => String(row.key)),
        ...(liveUnit === null ? [] : [String(liveUnit.key)]),
      ].join(":"),
    [liveUnit, virtualRows],
  );

  const markProgrammaticScroll = useCallback(() => {
    // [事务] 用 rAF 打一个“这一帧是程序化滚动”的标记（INV-8）：scroll 事件在
    // 下一帧派发，正是靠这个标记把“我们自己的滚动”与用户滚动区分开。
    if (programmaticScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(programmaticScrollFrameRef.current);
    }
    programmaticScrollFrameRef.current = window.requestAnimationFrame(() => {
      programmaticScrollFrameRef.current = null;
    });
  }, []);

  const commitFollowing = useCallback((following: boolean) => {
    // [事务] 值未变必须早退：following 在滚动回调里被高频调用，每次 setState
    // 都会重渲染整条时间线（含所有已挂载轮），这是流式掉帧的主要来源之一。
    if (followingRef.current === following) return;
    followingRef.current = following;
    // [事务] 只有“离底且存在轮”才显示回底按钮：空会话里显示它毫无意义，
    // 也会让首屏出现一个孤立按钮（shouldShowBackToBottom 内部再判一次）。
    setBackToBottomVisible(shouldShowBackToBottom(following, unitsRef.current.length));
  }, []);

  const clearUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = { intent: "none", observedAt: 0 };
    touchClientYRef.current = null;
    scrollbarPointerIdRef.current = null;
  }, []);

  const getActiveUserScrollIntent = useCallback((): TimelineUserScrollIntent => {
    const current = userScrollIntentRef.current;
    // [事务] 进行中的交互不过期（INV-10）：长按拖滚动条可能持续数秒，
    // 若按 TTL 判，拖到一半意图就变成 none，自动跟随会把用户正在拖的位置抢走。
    const interactionActive =
      touchClientYRef.current !== null || scrollbarPointerIdRef.current !== null;
    if (interactionActive) {
      return current.intent === "none" ? "unknown" : current.intent;
    }
    return Date.now() - current.observedAt <= USER_SCROLL_INTENT_TTL_MS ? current.intent : "none";
  }, []);

  const markLayoutScrollGuard = useCallback(() => {
    // [失败路径] 布局守卫窗口用于吞掉“由我们这次布局变化引发的 scroll 事件”，
    // 否则一次补拉历史就会被当成用户上滚，跟随态被误关（见 INV-9 的同类问题）。
    layoutScrollGuardUntilRef.current = Date.now() + LAYOUT_SCROLL_GUARD_MS;
  }, []);

  const markUserScrollIntent = useCallback(
    (intent: TimelineUserScrollIntent) => {
      if (intent === "none") return;
      userScrollIntentRef.current = { intent, observedAt: Date.now() };
      const element = scrollRef.current;
      // running -> terminal 会在同一帧迁移 live tail、折叠工作历史并触发
      // virtualizer 测高。向上滚动必须在 scroll 事件之前先拿走滚动权，否则终态
      // layout effect 会拿过期的 following=true 把用户重新拽到底部。
      if (intent === "awayFromBottom" && element && element.scrollHeight > element.clientHeight) {
        commitFollowing(false);
      }
    },
    [commitFollowing],
  );

  const handleWheelCapture = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      // [事务] 只在 capture 阶段判定意图，不 preventDefault：滚轮默认行为必须照常，
      // 我们只借它记录方向，用于“跟随态该不该被关掉”。
      markUserScrollIntent(timelineWheelScrollIntent(event.deltaY));
    },
    [markUserScrollIntent],
  );

  const handleTouchStartCapture = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    // [事务] 只记起点 Y，不判断方向：单指点击与滑动在这里无法区分，
    // 方向必须等 move 之后由 delta 决定，否则轻点一下就会关掉跟随。
    touchClientYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMoveCapture = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      const nextClientY = event.touches[0]?.clientY;
      const previousClientY = touchClientYRef.current;
      // [失败路径] 两个缺失条件必须显式返回：touches 为空（多指抬起）或没有起点时，
      // 计算出的 delta 是无意义的 0，会把“未知方向”误登记成“向上/向下”。
      if (nextClientY === undefined || previousClientY === null) return;
      markUserScrollIntent(timelineTouchScrollIntent(previousClientY, nextClientY));
      touchClientYRef.current = nextClientY;
    },
    [markUserScrollIntent],
  );

  const handleTouchEndCapture = useCallback(() => {
    // [事务] 只清起点、不清 intent：intent 需要靠 TTL 继续生效一小段时间，
    // 这样“抬手后仍在惯性滚动”的位移不会被误判成自动跟随的时机。
    touchClientYRef.current = null;
  }, []);

  const handleKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      // [失败路径] editableTarget 必须传进去（INV-32）：在输入框里按方向键是
      // 移动光标，不是滚动列表；不排除会让用户打字时时间线停止跟随。
      markUserScrollIntent(
        timelineKeyboardScrollIntent({
          key: event.key,
          shiftKey: event.shiftKey,
          editableTarget: isEditableScrollTarget(event.target),
        }),
      );
    },
    [markUserScrollIntent],
  );

  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // 内容区点击（尤其 composer 发送）不是滚动意图；只有 scrollbar/空白命中
      // scroll container 自身时才登记未知方向，随后由真实 scroll 落点裁决。
      if (event.target !== event.currentTarget) return;
      scrollbarPointerIdRef.current = event.pointerId;
      markUserScrollIntent("unknown");
    },
    [markUserScrollIntent],
  );

  const handlePointerEndCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    // [资源] 只清与本次 pointerId 匹配的记录：多点触控下第二个指针抬起时，
    // 不能把仍按着的第一个指针的记录清掉，否则拖动中途意图失效。
    if (scrollbarPointerIdRef.current === event.pointerId) {
      scrollbarPointerIdRef.current = null;
    }
  }, []);

  const syncMessageLayerMask = useCallback((element: HTMLDivElement) => {
    const messageLayer = messageLayerRef.current;
    if (!messageLayer) return;

    if (
      // 浮窗形态下输入区不在滚动视口内，消息不会经过输入框，底部遮罩只会吃掉消息。
      floatingComposerDockRef.current ||
      isAtBottom({
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      })
    ) {
      // 贴底时消息已经位于正常文档流末尾，不会经过 sticky composer；
      // 继续保留 mask 会无意义地淡出最后一条消息，只有离底滚动时才需要遮罩。
      messageLayer.style.maskImage = "none";
      messageLayer.style.webkitMaskImage = "none";
      return;
    }

    const viewportHeight = element.clientHeight;
    // [事务] 遮罩几何全部由“视口底边往上减固定高度”推导（INV-17/18/19）：
    // transparentStart 是开始透明的位置，opaqueEnd 是淡出结束位置，
    // 两者用减去常量而不是百分比，保证不同字号下淡出带宽度一致。
    const transparentStart = Math.max(
      0,
      viewportHeight - COMPOSER_MESSAGE_MASK_TRANSPARENT_HEIGHT_PX,
    );
    const opaqueEnd = Math.max(0, transparentStart - COMPOSER_MESSAGE_MASK_FADE_PX);
    const viewportTopInLayer = Math.max(0, element.scrollTop - messageLayer.offsetTop);
    const maskImage = `linear-gradient(to bottom, black 0, black ${opaqueEnd}px, transparent ${transparentStart}px, transparent 100%)`;

    // dock 的透明 padding 能保留分屏 focus ring，但消息会从留白透出；
    // mask 必须随 scroll viewport 对齐且只裁消息层，不能裁掉 sticky composer 与按钮。
    messageLayer.style.maskImage = maskImage;
    messageLayer.style.webkitMaskImage = maskImage;
    messageLayer.style.maskPosition = `0 ${viewportTopInLayer}px`;
    messageLayer.style.webkitMaskPosition = `0 ${viewportTopInLayer}px`;
    messageLayer.style.maskSize = `100% ${viewportHeight}px`;
    messageLayer.style.webkitMaskSize = `100% ${viewportHeight}px`;
  }, []);

  useLayoutEffect(() => {
    // 修复原因：浮窗展开态输入区曾是滚动容器内的 sticky 层，滚动条一直延伸到输入框后面。
    // 浮窗形态下输入区改为相对时间线根节点贴底（同一 DOM，不重挂载），滚动容器底边让出输入区高度。
    // [事务] CSS 变量写在 root 而不是 scroll 容器（INV-30）：dock 是 root 的子节点、
    // 滚动容器之外，变量必须在共同祖先上才同时可被两者读取。
    const root = timelineRootRef.current;
    const dock = composerDockRef.current;
    if (!floatingComposerDock || !root || !dock) return;
    const sync = () =>
      // [事务] 用 getBoundingClientRect 而不是 offsetHeight：dock 有 transform 动画时，
      // 前者给的是视觉高度，后者给布局高度，两者在展开动画期间会差出几十像素。
      root.style.setProperty(
        "--v4-floating-composer-dock-height",
        `${dock.getBoundingClientRect().height}px`,
      );
    sync();
    if (scrollRef.current) syncMessageLayerMask(scrollRef.current);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    resizeObserver?.observe(dock);
    return () => {
      // [资源] 卸载时必须删掉变量（INV-30）：否则下一次以非浮窗形态挂载时，
      // 仍会读到上一份 dock 高度，滚动容器凭空少一截。
      resizeObserver?.disconnect();
      root.style.removeProperty("--v4-floating-composer-dock-height");
    };
  }, [floatingComposerDock, hasBottomDock, syncMessageLayerMask]);

  const syncTurnNavigatorViewport = useCallback(
    (element: HTMLDivElement) => {
      syncMessageLayerMask(element);
      const viewportRect = element.getBoundingClientRect();
      const queryPositions: ConversationTurnNavigatorQueryPosition[] = [];
      for (const rowElement of element.querySelectorAll<HTMLElement>("[data-row-id]")) {
        const rowId = Number(rowElement.dataset.rowId);
        // [失败路径] 两道过滤缺一不可（INV-27）：非安全整数说明属性被污染；
        // 不在 realUser 集合里说明这行不是用户提问（工具行也有 rowId）。
        if (!Number.isSafeInteger(rowId) || !turnNavigatorQueryRowIdsRef.current.has(rowId)) {
          continue;
        }
        const rowRect = rowElement.getBoundingClientRect();
        const start = element.scrollTop + rowRect.top - viewportRect.top;
        queryPositions.push({ rowId, start, end: start + rowRect.height });
      }
      const nextViewport = {
        scrollOffsetPx: element.scrollTop,
        viewportHeightPx: element.clientHeight,
        // turn 级 active 只能命中同 turn 的第一条 query。这里从已挂载
        // 的稳定 row anchor 推导当前 query；虚拟 turn 尚未挂载时组件再回退 unit。
        activeQueryRowId: resolveConversationTurnNavigatorActiveQueryRowId({
          positions: queryPositions,
          scrollOffsetPx: element.scrollTop,
          viewportHeightPx: element.clientHeight,
        }),
      };
      setTurnNavigatorViewport((current) =>
        // [事务] 三个字段全等时返回原对象：这个 setter 在每次 scroll 上被调用，
        // 无条件替换对象会让目录每个滚动帧都重渲染（目录条目可能上百个）。
        current.scrollOffsetPx === nextViewport.scrollOffsetPx &&
        current.viewportHeightPx === nextViewport.viewportHeightPx &&
        current.activeQueryRowId === nextViewport.activeQueryRowId
          ? current
          : nextViewport,
      );
    },
    [syncMessageLayerMask],
  );

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    const messageLayer = messageLayerRef.current;
    if (!scrollElement || !messageLayer) return;

    const sync = () => syncMessageLayerMask(scrollElement);
    sync();
    // [资源] ResizeObserver 同时观察滚动容器与消息层：前者变化改变视口高度，
    // 后者变化改变 mask-size。只观察其一会让遮罩在图片加载后错位。
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(sync);
      messageLayerMaskObserverRef.current = observer;
      observer.observe(scrollElement);
      observer.observe(messageLayer);
      return () => {
        observer.disconnect();
        if (messageLayerMaskObserverRef.current === observer)
          messageLayerMaskObserverRef.current = null;
      };
    }

    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, [syncMessageLayerMask, renderUnits.length === 0]);

  const buildCurrentScrollMemoryState = useCallback(
    (element: HTMLDivElement): ChatSessionScrollMemoryState => {
      const metrics = {
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      };
      const wasPinnedToBottom = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics,
        lastObservedScrollTop: lastObservedScrollTopRef.current,
      });
      // [事务] wasPinnedToBottom 必须由“对账函数”算而不是直接抄 followingRef（INV-9）：
      // 保存时若状态已过期，下次恢复会错误地吸底或错误地停在中间。
      return {
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        wasPinnedToBottom,
        updatedAt: Date.now(),
      };
    },
    [],
  );

  const cacheCurrentScrollMemoryState = useCallback(
    (element: HTMLDivElement): ChatSessionScrollMemoryState => {
      const state = buildCurrentScrollMemoryState(element);
      // [事务] key 为 null 时不写 latest（INV-14）：草稿态没有会话身份，
      // 写下之后切到真实会话会被当成“同一会话的记忆”恢复。
      if (scrollMemoryKey) {
        latestScrollMemoryStateRef.current = { key: scrollMemoryKey, state };
      }
      return state;
    },
    [buildCurrentScrollMemoryState, scrollMemoryKey],
  );

  const notifyScrollObserversAfterCommit = useCallback((element: HTMLDivElement) => {
    // [并发] 用微任务而不是同步派发（INV-8 的配套）：赋值 scrollTop 后立刻派发
    // 事件，订阅方读到的仍是同一帧的中间态；等提交后再通知才是稳定值。
    scheduleMicrotask(() => {
      // [失败路径] 回调里必须重新取 scrollRef 并比对：微任务执行时组件可能已卸载
      // 或滚动容器已被替换，往旧节点派发事件会让监听方读到已失效的坐标。
      if (scrollRef.current !== element) return;
      element.dispatchEvent(new Event("scroll"));
    });
  }, []);

  const captureScrollMemoryBeforeScopeMutation = useCallback(
    (previousKey: string | null): ConversationScrollMemoryScopeSnapshot | null => {
      const pendingRestore = pendingDetachedScrollRestoreRef.current;
      // [失败路径] 有未落地的恢复意图时必须原样返回它（INV-15）：此时 DOM 还是
      // 空的（scrollTop 被钳到 0），用它去覆盖记忆等于把用户的位置抹成顶部。
      if (pendingRestore?.key === previousKey) {
        // 会话数据尚未到达时 DOM 只能读到被钳制的 scrollTop=0；此时切换
        // 任务不能用空时间线覆盖原记忆，必须保留尚未落地的 detached 恢复意图。
        return pendingRestore;
      }
      const element = scrollRef.current;
      if (!previousKey || !element) return null;
      return {
        key: previousKey,
        state: buildCurrentScrollMemoryState(element),
      };
    },
    [buildCurrentScrollMemoryState],
  );

  const commitCapturedScrollMemory = useCallback(
    (snapshot: ConversationScrollMemoryScopeSnapshot | null) => {
      // [事务] 双写：内存副本供本进程内的下一次切换即时使用，持久化副本供重启后使用。
      // 只写其一会导致“切回上一个会话”与“重启后回到该会话”两种行为不一致。
      if (!snapshot) return;
      latestScrollMemoryStateRef.current = snapshot;
      saveChatSessionScrollMemoryState(snapshot.key, snapshot.state);
    },
    [],
  );

  // 贴底必须 instant（scrollTop 赋值）：smooth 的中间帧会被 scroll 判定误读为「离底」。
  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    markProgrammaticScroll();
    // 草稿安全居中允许内容在低高度下向下溢出；若沿用真实会话吸底，
    // 顶部安全留白会被滚走。草稿始终展示顶部，真实会话继续吸底。
    element.scrollTop = responsiveCenteredEmptyLayout ? 0 : element.scrollHeight;
    // 回读取钳制后的落点入账（浏览器会把赋值钳到最大可滚动距离）。
    // [失败路径] 必须回读而不是用 scrollHeight 入账：写入的期望值与浏览器实际
    // 钳制后的值可能相差一屏，用期望值会让下一次判定误以为“内容又长高了”。
    lastObservedScrollTopRef.current = element.scrollTop;
    syncTurnNavigatorViewport(element);
    userAdjustedScrollSinceRestoreRef.current = false;
    cacheCurrentScrollMemoryState(element);
    notifyScrollObserversAfterCommit(element);
  }, [
    cacheCurrentScrollMemoryState,
    responsiveCenteredEmptyLayout,
    markProgrammaticScroll,
    notifyScrollObserversAfterCommit,
    syncTurnNavigatorViewport,
  ]);

  useLayoutEffect(() => {
    const contentColumn = virtualHistoryRef.current;
    if (!contentColumn || typeof ResizeObserver === "undefined") return;

    stableContentWidthRef.current = contentColumn.clientWidth;
    let observedViewportHeight = scrollRef.current?.clientHeight ?? 0;
    // [资源] 帧回调句柄与 disposed 标志成对出现：observer 回调可能在 rAF 待执行时
    // 再次触发，disposed 保证卸载后不会重新 observe 已断开的观察者。
    let observeContentFrame: number | null = null;
    let disposed = false;
    const observer = new ResizeObserver(() => {
      const nextWidth = contentColumn.clientWidth;
      const element = scrollRef.current;
      if (!element) return;
      const viewportHeightChanged = observedViewportHeight !== element.clientHeight;
      observedViewportHeight = element.clientHeight;
      if (nextWidth === stableContentWidthRef.current && !viewportHeightChanged) return;
      markLayoutScrollGuard();
      // [事务] 宽度或视口高度变了才重算跟随（INV-4/28）：这是“内容列尺寸变化”的
      // 唯一入口，重算后若仍跟随，还要在下面同步测高并吸底一次。
      commitFollowing(
        reconcileFollowingForContentAnchor({
          following: followingRef.current,
          metrics: {
            scrollTop: element.scrollTop,
            viewportHeight: element.clientHeight,
            contentHeight: element.scrollHeight,
          },
          lastObservedScrollTop: lastObservedScrollTopRef.current,
          userScrollIntent: getActiveUserScrollIntent(),
        }),
      );
      if (followingRef.current) {
        if (contentWidthResizeSettleTimerRef.current !== null) {
          window.clearTimeout(contentWidthResizeSettleTimerRef.current);
          contentWidthResizeSettleTimerRef.current = null;
        }
        // 本批次统一提交布局与吸底，其间其他内容 effect 不得按中间高度吸底。
        // [并发] unobserve 是必要的“自己停自己”：在 observer 回调里改高度会再次
        // 触发自己，形成通知风暴，浏览器甚至会丢通知（undelivered notifications）。
        observer.unobserve(contentColumn);
        const messageLayer = messageLayerRef.current;
        const maskObserver = messageLayerMaskObserverRef.current;
        // 同步占位高度也会改变父消息层的高度；其蒙层观察器需要一起暂停，
        // 否则在更深层的 RO 通知中改变父层，会产生 undelivered notifications。
        if (messageLayer) maskObserver?.unobserve(messageLayer);
        // [事务] committingMeasuredLayoutRef 是给 shouldAdjustScrollPositionOnItemSizeChange
        // 看的信号：本批测高提交期间禁止 virtualizer 自行补偿，否则会与下面的
        // scrollToBottom 抢同一帧的 scrollTop（INV-13）。
        committingMeasuredLayoutRef.current = true;
        try {
          // virtualizer 的 ResizeObserver 默认异步提交 React；先吸底会使用旧占位高度，
          // 下一帧测高提交后再跳一次。仅在 observer 内批量测高并同步提交，避免跨帧追赶。
          const measurements = Array.from(
            contentColumn.querySelectorAll(":scope > [data-index]"),
            (node) => ({
              index: Number(node.getAttribute("data-index")),
              height: measureElement(node, undefined),
            }),
          );
          flushSync(() => {
            // [事务] 一次 flushSync 内批量写入：如果逐条 resizeItem，每条都会触发
            // 一次 virtualizer 的通知与可能的 React 更新，行数多时直接卡住一帧。
            for (const item of measurements) virtualizer.resizeItem(item.index, item.height);
            // 缓存可能已经更新且没有差量，仍需明确提交，不能依赖空回调冲刷旧任务。
            commitMeasuredLayout((revision) => revision + 1);
          });
        } finally {
          committingMeasuredLayoutRef.current = false;
          // 暂停的是本批次会写入高度的观察目标，不推迟测高或吸底。下一帧继续
          // 观察内容列宽度，以覆盖视口停止后仍在进行的 CSS 宽度过渡。
          if (observeContentFrame !== null) window.cancelAnimationFrame(observeContentFrame);
          if (!disposed) {
            observeContentFrame = window.requestAnimationFrame(() => {
              observeContentFrame = null;
              observer.observe(contentColumn);
              if (
                messageLayer &&
                messageLayerRef.current === messageLayer &&
                messageLayerMaskObserverRef.current === maskObserver
              )
                maskObserver?.observe(messageLayer);
            });
          }
        }
        if (disposed) return;
        stableContentWidthRef.current = contentColumn.clientWidth;
        contentWidthResizeActiveRef.current = false;
        // 同步提交可能触发其他布局处理；用户上滚或定位始终优先。
        // [失败路径] 末尾再查一次 awayFromBottom（INV-11）：测高提交本身可能引发
        // 一次 scroll，用户此时上滚的意图必须压过“我们还想吸底”的念头。
        if (followingRef.current && getActiveUserScrollIntent() !== "awayFromBottom")
          scrollToBottom();
        return;
      }
      if (nextWidth === stableContentWidthRef.current) return;

      // 宽度变化会让虚拟行分批重新测高；逐行补偿或逐批追底都会
      // 连续改写 scrollTop。resize 期间暂停两者，稳定后只执行一次最终贴底。
      contentWidthResizeActiveRef.current = true;
      if (contentWidthResizeSettleTimerRef.current !== null) {
        window.clearTimeout(contentWidthResizeSettleTimerRef.current);
      }
      contentWidthResizeSettleTimerRef.current = window.setTimeout(() => {
        stableContentWidthRef.current = contentColumn.clientWidth;
        contentWidthResizeActiveRef.current = false;
        contentWidthResizeSettleTimerRef.current = null;
        if (followingRef.current) {
          scrollToBottom();
        }
      }, CONTENT_WIDTH_RESIZE_SETTLE_MS);
    });
    observer.observe(contentColumn);
    if (scrollRef.current) observer.observe(scrollRef.current);

    return () => {
      disposed = true;
      observer.disconnect();
      if (observeContentFrame !== null) window.cancelAnimationFrame(observeContentFrame);
      if (contentWidthResizeSettleTimerRef.current !== null) {
        window.clearTimeout(contentWidthResizeSettleTimerRef.current);
        contentWidthResizeSettleTimerRef.current = null;
      }
      contentWidthResizeActiveRef.current = false;
    };
  }, [
    commitFollowing,
    getActiveUserScrollIntent,
    markLayoutScrollGuard,
    measureElement,
    renderUnits.length === 0,
    scrollToBottom,
    virtualizer,
  ]);

  useLayoutEffect(() => {
    const element = liveTailRef.current;
    const cacheKey = getUnitHeightCacheKey(liveUnit ?? undefined);
    if (!element || cacheKey === undefined) return;

    const cacheHeight = (entry?: ResizeObserverEntry) => {
      const height = measureRowHeight(element, entry);
      heightCacheRef.current?.set(cacheKey, height);
      return height;
    };
    let observedHeight = cacheHeight();
    if (typeof ResizeObserver === "undefined") return;

    // projection revision 的父 layout effect 可能早于 Markdown 子树最终测高；
    // 旧 observer 只缓存高度，正文会先把 loading 槽顶下去，后续 commit 才补 scrollTop。
    // ResizeObserver 在绘制前拿到真实高度，这里仅在仍拥有 following 滚动权时同步吸底；
    // 用户已经上滚（包括 scroll event 尚未入账的竞态）则只缓存，不夺回阅读位置。
    // [资源] live tail 的 observer 只缓存高度，并仅在仍拥有 following 滚动权时吸底：
    // Markdown 子树的最终测高晚于 projection 的 layout effect，不补这一步会让
    // loading 槽把正文顶下去，直到下一次 commit 才回到底部。
    const observer = new ResizeObserver((entries) => {
      const nextHeight = cacheHeight(entries[0]);
      if (nextHeight === observedHeight) return;
      observedHeight = nextHeight;

      const scrollElement = scrollRef.current;
      if (!scrollElement) return;
      markLayoutScrollGuard();
      const following = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics: {
          scrollTop: scrollElement.scrollTop,
          viewportHeight: scrollElement.clientHeight,
          contentHeight: scrollElement.scrollHeight,
        },
        lastObservedScrollTop: lastObservedScrollTopRef.current,
        // [事务] userScrollIntent 必须参与对账（INV-9/11）：用户上滚但 scroll 事件
        // 还没入账的竞态里，仅凭几何会算出“仍然贴底”，从而把用户拽回底部。
        userScrollIntent: getActiveUserScrollIntent(),
      });
      commitFollowing(following);
      if (anchorActionAfterContentChange(following, isContentWidthChanging()) === "stickToBottom") {
        scrollToBottom();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [
    commitFollowing,
    getActiveUserScrollIntent,
    isContentWidthChanging,
    liveUnit?.key,
    markLayoutScrollGuard,
    scrollToBottom,
  ]);

  const saveCurrentScrollMemory = useCallback(() => {
    const key = scrollMemoryKey;
    const element = scrollRef.current;
    if (!key) return;
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    const cached = latestScrollMemoryStateRef.current;
    const cachedState = cached?.key === key ? cached.state : null;
    // [事务] 保存时按“未落地的恢复意图 > 现场测量 > 上次缓存”三级取值（INV-14/15）：
    // 有 pending restore 说明 DOM 还没体现用户位置，现场测量会得到错误的顶部。
    const state =
      pendingRestore?.key === key
        ? pendingRestore.state
        : element
          ? cacheCurrentScrollMemoryState(element)
          : cachedState;
    if (state) saveChatSessionScrollMemoryState(key, state);
  }, [cacheCurrentScrollMemoryState, scrollMemoryKey]);

  const restoreScrollMemory = useCallback(
    (state: ChatSessionScrollMemoryState) => {
      const element = scrollRef.current;
      if (!element) return;
      // [事务] 恢复动作必须清空用户意图并打程序化标记（INV-8/13）：
      // 否则恢复本身会被 handleScroll 判成用户滚动，立刻又把跟随态关掉。
      clearUserScrollIntent();
      markProgrammaticScroll();
      element.scrollTop = resolveChatSessionScrollRestoreTop(state, element);
      // [事务] 恢复后必须立刻回写 lastObservedScrollTop：下一次 scroll 事件会以它为
      // 基准判断“位移来自我们自己还是用户”，不写就会把恢复误判成用户上滚。
      lastObservedScrollTopRef.current = element.scrollTop;
      followingRef.current = false;
      setBackToBottomVisible(shouldShowBackToBottom(false, unitsRef.current.length));
      syncTurnNavigatorViewport(element);
      userAdjustedScrollSinceRestoreRef.current = false;
      cacheCurrentScrollMemoryState(element);
    },
    [
      cacheCurrentScrollMemoryState,
      clearUserScrollIntent,
      markProgrammaticScroll,
      syncTurnNavigatorViewport,
    ],
  );

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    // [事务] programmaticScroll 的判据是“有标记 且 位移小于 1px”（INV-8）：
    // 只看标记会把“程序化赋值后用户立刻接管”的滚动也当成自己的，丢失用户意图。
    const programmaticScroll =
      programmaticScrollFrameRef.current !== null &&
      Math.abs(element.scrollTop - lastObservedScrollTopRef.current) < 1;
    const userScrollIntent = getActiveUserScrollIntent();
    // 用户输入优先；其余 scroll 若落在内容/测高 guard 内视为布局补偿，guard 外的
    // 未分类事件继续按真实用户滚动处理，兼容原生滚动条和辅助技术。
    const scrollSource =
      userScrollIntent !== "none"
        ? "user"
        : programmaticScroll
          ? "programmatic"
          : Date.now() <= layoutScrollGuardUntilRef.current
            ? "layout"
            : "user";
    // virtualizer 的原生 offset observer 会先于 React onScroll 入账；到这里即可确认它
    // 已看见恢复后的真实 scrollTop。用户滚动也应立即结束保护窗，把滚动权交还用户。
    if (scrollSource !== "layout") {
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    }
    lastObservedScrollTopRef.current = element.scrollTop;
    syncTurnNavigatorViewport(element);
    // [事务] scrollSource 的三级判定顺序即优先级（INV-9/11）：用户意图 > 程序化 >
    // 布局守卫 > 默认按用户处理。默认必须落到 user，否则原生滚动条与辅助技术
    // 触发的滚动会被当成布局补偿，跟随态永远关不掉。
    const following = resolveFollowingAfterScroll({
      following: followingRef.current,
      source: scrollSource,
      metrics: {
        scrollTop: element.scrollTop,
        viewportHeight: element.clientHeight,
        contentHeight: element.scrollHeight,
      },
    });
    commitFollowing(following);
    if (scrollSource === "user") {
      // [事务] 真实用户滚动要同时做三件事：作废未落地的恢复意图、记为“用户已调整”、
      // 保存记忆。少任一件都会出现“切回来又回到旧位置”或“恢复把用户顶走”。
      pendingDetachedScrollRestoreRef.current = null;
      userAdjustedScrollSinceRestoreRef.current = true;
      saveCurrentScrollMemory();
    }
    // 只在 64px 顶边才补页时，用户会先撞到窗口边界再看到内容跳入；提前两个
    // 视口预取，让桌面和手机 Web 共用的 renderer 在用户抵达边界前完成补页。
    const loadOlder = loadOlderRef.current;
    const triggerPx = historyPrefetchTriggerPx(element.clientHeight);
    if (
      shouldTriggerLoadOlder({
        scrollTop: element.scrollTop,
        canLoadOlder: loadOlder.canLoadOlder,
        loadingOlder: loadOlder.loadingOlder,
        triggerPx,
      })
    ) {
      // 前插超过 viewport + overscan 后旧可见 turn 会被卸载，DOM 不能作为跨
      // commit 锚点；这里保存 virtualizer 按稳定 turn key 维护的 measurement 起点。
      const anchorMeasurement = virtualizer.getVirtualItemForOffset(element.scrollTop);
      // [事务] 锚点必须用 key 校验（INV-3/12）：index 在补拉后会整体右移，
      // 只有 key 能确认“这一项仍是同一轮”，否则会把锚点记到相邻轮上。
      const anchorUnit = anchorMeasurement
        ? virtualizedUnitsRef.current[anchorMeasurement.index]
        : undefined;
      pendingPrependVirtualAnchorRef.current =
        anchorMeasurement && anchorUnit?.key === anchorMeasurement.key
          ? {
              key: anchorUnit.key,
              offsetTop: anchorMeasurement.start - element.scrollTop,
              start: anchorMeasurement.start,
            }
          : null;
      logger.debug("[v4-timeline] 接近历史窗口顶部，自动预取更早行", {
        scrollTop: element.scrollTop,
        triggerPx,
      });
      loadOlder.onLoadOlder?.();
    }
  }, [
    commitFollowing,
    getActiveUserScrollIntent,
    saveCurrentScrollMemory,
    syncTurnNavigatorViewport,
    virtualizer,
  ]);

  const handleBackToBottom = useCallback(() => {
    pendingDetachedScrollRestoreRef.current = null;
    // [事务] 回底按钮必须把“意图清理 + 跟随置真 + 立即吸底 + 保存记忆”四步走完：
    // 少最后一步时，用户点完立刻切任务会把旧位置写回记忆（见下面注释）。
    clearUserScrollIntent();
    commitFollowing(true);
    scrollToBottom();
    // scrollToBottom 只更新组件内 ref；若用户点击后立刻切任务，scope
    // cleanup/scroll 事件可能还没运行，旧 Map 会把下次恢复重新带回中部甚至顶部。
    saveCurrentScrollMemory();
  }, [clearUserScrollIntent, commitFollowing, saveCurrentScrollMemory, scrollToBottom]);

  useLayoutEffect(() => {
    if (!scrollToBottomActionRef) return;
    scrollToBottomActionRef.current = handleBackToBottom;
    return () => {
      // 只清理本实例登记的动作，避免切 pane 时旧 cleanup 覆盖新 timeline。
      // [并发] 比较身份再置空是必需的（INV-33）：新实例可能已经写入自己的函数，
      // 无条件置空会让宿主的“跳到底部”在切 pane 后彻底失效。
      if (scrollToBottomActionRef.current === handleBackToBottom) {
        scrollToBottomActionRef.current = null;
      }
    };
  }, [handleBackToBottom, scrollToBottomActionRef]);

  const scrollToQuery = useCallback(
    (target: { unitIndex: number; rowId: number }, behavior: ScrollBehavior = "auto") => {
      clearUserScrollIntent();
      commitFollowing(false);
      if (turnNavigatorJumpFrameRef.current !== null) {
        window.cancelAnimationFrame(turnNavigatorJumpFrameRef.current);
        turnNavigatorJumpFrameRef.current = null;
      }

      const scrollMountedQuery = (element: HTMLDivElement): boolean => {
        const rowElement = element.querySelector<HTMLElement>(`[data-row-id="${target.rowId}"]`);
        if (!rowElement) return false;
        // [事务] 目标位置用“滚动容器内相对坐标”计算，而不是 offsetTop：
        // 行可能被虚拟化包裹在有 transform 的定位层里，offsetTop 会漏掉这一段。
        const targetTop =
          element.scrollTop +
          rowElement.getBoundingClientRect().top -
          element.getBoundingClientRect().top;
        if (behavior === "auto") {
          element.scrollTop = targetTop;
        } else {
          element.scrollTo({ top: targetTop, behavior });
        }
        lastObservedScrollTopRef.current = element.scrollTop;
        syncTurnNavigatorViewport(element);
        logger.debug("[v4-turn-navigator] 定位用户 query", {
          behavior,
          rowId: target.rowId,
          unitIndex: target.unitIndex,
        });
        return true;
      };

      const element = scrollRef.current;
      if (!element || scrollMountedQuery(element)) return;

      // product turn 是虚拟列表的最小挂载单元，steer query 是单元内锚点。目标未挂载时
      // 先无动画挂载所属 turn，再按用户 motion 偏好精确滚到 row，不能退回 turn 开头。
      if (target.unitIndex === liveUnitIndex) {
        const liveTail = liveTailRef.current;
        if (liveTail) {
          element.scrollTop =
            element.scrollTop +
            liveTail.getBoundingClientRect().top -
            element.getBoundingClientRect().top;
        }
      } else {
        virtualizer.scrollToIndex(target.unitIndex, {
          align: "start",
          behavior: "auto",
        });
      }

      let remainingAttempts = 12;
      const alignMountedQuery = () => {
        turnNavigatorJumpFrameRef.current = null;
        const currentElement = scrollRef.current;
        if (currentElement && scrollMountedQuery(currentElement)) return;
        // [失败路径] 12 帧后放弃并 warn，而不是无限重试：目标可能已被删除
        // （real-user query 行被裁剪），持续 rAF 会白白占满帧预算。
        remainingAttempts -= 1;
        if (remainingAttempts <= 0) {
          logger.warn("[v4-turn-navigator] query 锚点挂载超时", {
            rowId: target.rowId,
            unitIndex: target.unitIndex,
          });
          return;
        }
        turnNavigatorJumpFrameRef.current = window.requestAnimationFrame(alignMountedQuery);
      };
      turnNavigatorJumpFrameRef.current = window.requestAnimationFrame(alignMountedQuery);
    },
    [clearUserScrollIntent, commitFollowing, liveUnitIndex, syncTurnNavigatorViewport, virtualizer],
  );

  useLayoutEffect(() => {
    if (!scrollToQueryActionRef) return;
    const action = (target: { unitIndex: number; rowId: number }) => {
      scrollToQuery(target);
    };
    scrollToQueryActionRef.current = action;
    return () => {
      if (scrollToQueryActionRef.current === action) {
        scrollToQueryActionRef.current = null;
      }
    };
  }, [scrollToQuery, scrollToQueryActionRef]);

  useEffect(
    () => () => {
      // [资源] 会话切换时取消未完成的定位帧：旧会话的 target 在新会话里没有意义，
      // 继续对齐会把新会话的滚动位置拉到一个随机锚点。
      if (turnNavigatorJumpFrameRef.current !== null) {
        window.cancelAnimationFrame(turnNavigatorJumpFrameRef.current);
        turnNavigatorJumpFrameRef.current = null;
      }
    },
    [sessionKey],
  );

  const scrollToUnit = useCallback(
    (unitIndex: number, behavior: ScrollBehavior = "auto") => {
      clearUserScrollIntent();
      commitFollowing(false);
      if (unitIndex === liveUnitIndex) {
        const element = scrollRef.current;
        const liveTail = liveTailRef.current;
        if (!element || !liveTail) return;
        const targetTop =
          element.scrollTop +
          liveTail.getBoundingClientRect().top -
          element.getBoundingClientRect().top;
        if (behavior === "auto") {
          element.scrollTop = targetTop;
        } else {
          element.scrollTo({ top: targetTop, behavior });
        }
        lastObservedScrollTopRef.current = element.scrollTop;
        syncTurnNavigatorViewport(element);
        return;
      }
      virtualizer.scrollToIndex(unitIndex, { align: "start", behavior });
    },
    [clearUserScrollIntent, commitFollowing, liveUnitIndex, syncTurnNavigatorViewport, virtualizer],
  );

  useConversationTimelineFind({
    rootRef: scrollRef,
    renderUnits,
    rows,
    mountedRowsKey,
    canLoadOlder,
    loadingOlder,
    onLoadOlder,
    sessionPhase,
    conversationFindQuery,
    conversationFindActiveIndex,
    conversationFindNavigationRequestId,
    onConversationFindMatchStateChange,
    searchResultHighlightRequest,
    onSearchResultHighlightDone,
    scrollToUnit,
  });

  const saveCurrentScrollMemoryRef = useRef(saveCurrentScrollMemory);
  saveCurrentScrollMemoryRef.current = saveCurrentScrollMemory;

  useLayoutEffect(() => {
    return () => {
      // 真正卸载时 DOM 尚在；scope 更新则由 before-mutation capture 读取旧 DOM。
      saveCurrentScrollMemoryRef.current();
    };
  }, []);

  const rowCount = renderUnits.length;
  const rowWindowKey = `${rows.length}:${rows[0]?.rowId ?? "none"}:${rows[rows.length - 1]?.rowId ?? "none"}`;
  const pendingGuideKey = pendingGuides.map((item) => item.queueItemId).join(":");

  // V4 迁移删除旧 ChatView 滚动 hook 后，sessionKey effect 仍固定滚到底部，
  // 导致残留的 renderer-local 记忆模块彻底断线。这里在清测高并重新 measure 后按 scope
  // 恢复；首个 layout 立即写入防闪动，下一帧再校正异步测高，但必须把滚动权让给用户。
  useLayoutEffect(() => {
    clearUserScrollIntent();
    heightCacheRef.current?.clear();
    // prepend 锚定基线一并重置：rowId 跨会话可重复，禁止拿旧会话首行比较。
    prependAnchorRef.current = { firstRowId: null, totalSize: 0 };
    pendingPrependVirtualAnchorRef.current = null;
    // draft 默认吸底会留下旧 virtualizer.scrollOffset；在恢复写入派发 scroll 事件前，
    // 测高若继续按旧 offset 校正，会把刚恢复的历史位置重新推回 draft 的落点。
    suppressVirtualizerAdjustmentDuringRestoreRef.current = true;
    virtualizer.measure();
    userAdjustedScrollSinceRestoreRef.current = false;

    const restoredState = readChatSessionScrollMemoryState(scrollMemoryKey);
    const pendingRestoreWait = resolvePendingScrollMemoryRestoreWait(
      restoredState,
      scrollRef.current,
      unitsRef.current.length > 0,
    );
    pendingDetachedScrollRestoreRef.current =
      scrollMemoryKey && restoredState && pendingRestoreWait
        ? {
            key: scrollMemoryKey,
            rowWindowKey,
            state: restoredState,
            waitFor: pendingRestoreWait,
          }
        : null;
    const restore = () => {
      if (!restoredState || restoredState.wasPinnedToBottom === true) {
        suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
        followingRef.current = initialFollowing();
        setBackToBottomVisible(false);
        scrollToBottom();
        return;
      }
      restoreScrollMemory(restoredState);
    };

    restore();
    let releaseGuardFrame: number | null = null;
    const correctionFrame = window.requestAnimationFrame(() => {
      // [事务] 下一帧再校正一次是必需的：首次 restore 发生在虚拟层还没测完时，
      // scrollHeight 偏小会把 scrollTop 钳住；第二帧拿到了真实高度，才落到位。
      if (!userAdjustedScrollSinceRestoreRef.current) {
        restore();
      }
      releaseGuardFrame = window.requestAnimationFrame(() => {
        suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
      });
    });
    return () => {
      window.cancelAnimationFrame(correctionFrame);
      if (releaseGuardFrame !== null) {
        window.cancelAnimationFrame(releaseGuardFrame);
      }
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    };
  }, [
    clearUserScrollIntent,
    restoreScrollMemory,
    scrollMemoryKey,
    scrollToBottom,
    sessionKey,
    virtualizer,
  ]);

  useLayoutEffect(() => {
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    if (rowCount === 0 || !pendingRestore || pendingRestore.key !== scrollMemoryKey) {
      return;
    }

    // session scope 往往先于 rows 订阅完成；只在 scope commit 和下一帧
    // 恢复会把历史 scrollTop 钳成 0。首批内容到达后重新落地，并再等一帧校正测高。
    suppressVirtualizerAdjustmentDuringRestoreRef.current = true;
    restoreScrollMemory(pendingRestore.state);
    let releaseGuardFrame: number | null = null;
    // [并发] 每个回调都要重新比对 pendingRestore 的身份（INV-15/25）：
    // 两次 rAF 之间用户可能已经滚动或再次切会话，旧意图不该继续生效。
    const correctionFrame = window.requestAnimationFrame(() => {
      if (
        pendingDetachedScrollRestoreRef.current === pendingRestore &&
        !userAdjustedScrollSinceRestoreRef.current
      ) {
        restoreScrollMemory(pendingRestore.state);
      }
      releaseGuardFrame = window.requestAnimationFrame(() => {
        if (
          pendingDetachedScrollRestoreRef.current === pendingRestore &&
          canReleasePendingScrollMemoryRestore(
            pendingRestore,
            scrollRef.current,
            rowCount,
            canLoadOlder || totalCount > rows.length,
            rowWindowKey,
          )
        ) {
          pendingDetachedScrollRestoreRef.current = null;
        }
        suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
      });
    });

    return () => {
      window.cancelAnimationFrame(correctionFrame);
      if (releaseGuardFrame !== null) {
        window.cancelAnimationFrame(releaseGuardFrame);
      }
      suppressVirtualizerAdjustmentDuringRestoreRef.current = false;
    };
  }, [
    canLoadOlder,
    restoreScrollMemory,
    rowCount,
    rowWindowKey,
    scrollMemoryKey,
    totalCount,
    totalSize,
  ]);

  // prepend 锚定：loadOlder 前插历史行时平移 scrollTop，阅读位置不跳。
  // 既有 turn key=turnId 且测量缓存不失效 → 前插只把总高度撑高 delta，scrollTop += delta
  // 即恢复锚点（绘制前完成，无闪动）；本效应声明在会话切换效应之后，切换 commit 上
  // 先重置基线再对账，防跨会话 rowId 误判为前插。
  useLayoutEffect(() => {
    const prev = prependAnchorRef.current;
    const nextFirstRowId = rowsRef.current[0]?.rowId ?? null;
    const nextTotalSize = virtualizer.getTotalSize();
    const pendingRestore = pendingDetachedScrollRestoreRef.current;
    const pendingRestoreOwnsAnchor = pendingRestore?.key === scrollMemoryKey;
    const didPrepend =
      prev.firstRowId !== null && nextFirstRowId !== null && nextFirstRowId < prev.firstRowId;
    // [事务] 判据是“新的首行 rowId 更小”而不是“行数变多”（INV-12）：追加新轮也会
    // 让行数变多，但那不需要补偿；只有历史前插才会把阅读位置顶下去。
    let viewportAdjustment: number | null = null;
    if (didPrepend && !pendingRestoreOwnsAnchor && scrollRef.current) {
      const previousVirtualAnchor = pendingPrependVirtualAnchorRef.current;
      const nextAnchorMeasurement = previousVirtualAnchor
        ? virtualizer.measurementsCache.find(
            (measurement) => measurement.key === previousVirtualAnchor.key,
          )
        : undefined;
      if (previousVirtualAnchor && nextAnchorMeasurement) {
        viewportAdjustment = prependVirtualAnchorAdjustment(
          previousVirtualAnchor,
          {
            key: previousVirtualAnchor.key,
            offsetTop: previousVirtualAnchor.offsetTop,
            start: nextAnchorMeasurement.start,
          },
          scrollRef.current.scrollTop,
        );
      }
    }
    // [事务] 前插成功后必须立刻清掉「待测虚拟锚点」：下一帧若该行已卸载，
    // 残留的 anchor 会让下一次前插拿一个不存在的 key 去换算 offset。
    if (didPrepend) pendingPrependVirtualAnchorRef.current = null;
    // [失败路径] 有未落地的恢复意图时，本效应必须让位（pendingRestoreOwnsAnchor）：
    // 恢复是用户显式记忆的位置，前插补偿在同一次 commit 里会与它抢 scrollTop。
    const adjustment = pendingRestoreOwnsAnchor
      ? null
      : (viewportAdjustment ??
        prependScrollAdjustment({
          prevFirstRowId: prev.firstRowId,
          nextFirstRowId,
          prevTotalSize: prev.totalSize,
          nextTotalSize,
        }));
    if (adjustment !== null && scrollRef.current) {
      const element = scrollRef.current;
      markLayoutScrollGuard();
      element.scrollTop += adjustment;
      // 程序化平移同样入账，避免被下方贴底对账误读为「未观察滚动」。
      lastObservedScrollTopRef.current = element.scrollTop;
      // [时序] rail 视口必须跟着这次平移一起更新，否则目录高亮还停留在平移前
      // 的那一轮，用户点「跳到第 N 轮」会落到错位的位置。
      syncTurnNavigatorViewport(element);
      // [事务] 平移后的 scrollTop 就是新的「当前记忆位置」；不同步保存的话，
      // 切走再切回会用平移前的值恢复，阅读位置整体上移。
      cacheCurrentScrollMemoryState(element);
      // 一次前插数千行时，measurement cache 与 scrollTop 会在同一 commit
      // 更新，Chromium 可能合并掉原生 scroll 通知，virtualizer 仍按旧 offset 挂载首屏，
      // 形成“滚动条在底部、正文却空白”。commit 后按最终落点补发只读通知；若同帧存在
      // 用户 wheel/pointer 意图，handleScroll 仍会优先识别为 user，不夺回滚动权。
      notifyScrollObserversAfterCommit(element);
    }
    // 待恢复的离底记忆拥有当前 commit 的坐标系；不能让 prepend 把临时 clamp 值再次
    // 平移。恢复 effect 会在同一 commit 的下一帧按最终内容高度重放原始位置。
    // [事务] 基线要用本帧最终值重写（INV-12）：这里写 next 而不是 prev，
    // 否则下一次前插会拿两帧前的 totalSize 做差，补偿量多算一倍。
    prependAnchorRef.current = {
      firstRowId: nextFirstRowId,
      totalSize: nextTotalSize,
    };
  });

  // 底部锚定：内容变化（新行 / 流式 delta / 动态测高修正 → totalSize 变化）时，
  // 跟随中贴底，解除跟随保持阅读位置。useLayoutEffect 在绘制前完成贴底，避免闪动。
  // terminal 会同时迁移 live tail、自动折叠历史并
  // 触发 virtualizer 多阶段测高；这些 scrollTop 回退属于布局，必须保持 following。
  // 若同帧有用户向上滚动，capture handler 会先登记 awayFromBottom，本 effect 必须让位。
  useLayoutEffect(() => {
    const element = scrollRef.current;
    // [时序] guard 必须在读 scrollTop 之前登记：它的语义是「接下来这段时间的
    // scroll 回调由布局自身引起」，晚一步登记，本帧位移就会被当成用户上滚。
    markLayoutScrollGuard();
    if (element) {
      const following = reconcileFollowingForContentAnchor({
        following: followingRef.current,
        metrics: {
          scrollTop: element.scrollTop,
          viewportHeight: element.clientHeight,
          contentHeight: element.scrollHeight,
        },
        lastObservedScrollTop: lastObservedScrollTopRef.current,
        userScrollIntent: getActiveUserScrollIntent(),
      });
      // [并发] 结果写回 ref 而不是直接依赖 state：本 effect 与 capture 阶段的
      // 手势在同一帧内竞争，只有 ref 能读到刚提交的跟随态（INV-7/9）。
      commitFollowing(following);
    }
    // [权衡] 宽度变化期间即使跟随中也不贴底：换行重排会让 scrollHeight 连续跳变，
    // 每帧跟随等于把正在拖拽窗口的用户钉在底部；等宽度稳定后由下一帧 effect 补上。
    if (
      anchorActionAfterContentChange(followingRef.current, isContentWidthChanging()) ===
      "stickToBottom"
    ) {
      scrollToBottom();
    }
  }, [
    getActiveUserScrollIntent,
    isContentWidthChanging,
    markLayoutScrollGuard,
    commitFollowing,
    headerSlotHeight,
    pendingGuideKey,
    rowCount,
    rows,
    scrollToBottom,
    totalSize,
  ]);

  // [时序] rail 的视口几何只依赖「内容高度 / 行数 / 引导卡」这些离散量，单独一个
  // effect 承接，避免把 virtualizer 每帧变化的 scrollOffset 混进下面的贴底依赖。
  // [失败路径] 回调里必须判空：卸载阶段 ref 已置 null，直接读 clientHeight 会抛错。
  useLayoutEffect(() => {
    if (scrollRef.current) {
      syncTurnNavigatorViewport(scrollRef.current);
    }
  }, [pendingGuideKey, rowCount, syncTurnNavigatorViewport, totalSize]);

  // 行清空（如 editUserQuery 大范围 rewind）：重置为跟随并收起按钮，
  // 后续重新出现的行走上面的锚定 effect 贴底。
  // [失败路径] 存在未落地的「离底记忆恢复」时不能重置成跟随：那是一次显式的位置
  // 还原，行清空只是中间态，重置 ref 会把恢复意图直接冲掉（INV-15）。
  useEffect(() => {
    if (rowCount === 0) {
      if (pendingDetachedScrollRestoreRef.current?.key === scrollMemoryKey) {
        return;
      }
      // [事务] 这里直接改 ref 而不走 commitFollowing：同一 commit 内没有别的读者，
      // 省掉一次 setState 可避免「先渲染离底、下一帧又弹回底部」的闪烁。
      followingRef.current = initialFollowing();
      if (backToBottomVisible) {
        setBackToBottomVisible(false);
      }
    }
  }, [rowCount, backToBottomVisible, scrollMemoryKey]);

  // [资源] 待执行的 rAF 必须在卸载时取消：它内部会读 scrollRef 并回调外部 observer，
  // 组件已销毁还跑一次，轻则空转，重则对已卸载节点派发滚动通知。
  useEffect(() => {
    return () => {
      if (programmaticScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(programmaticScrollFrameRef.current);
        programmaticScrollFrameRef.current = null;
      }
    };
  }, []);

  // raw projection row 与按 turn 合并后的 render unit 不是同一计量单位；
  // 分开暴露才能让恢复/分页验证不再把可见 unit 误当成持久 row。
  //
  // [事务] 根节点只提供「相对定位 + 纵向布局」：rail、浮窗 dock、回底按钮都以它为
  // 包含块，因此这里不能引入 overflow/transform，否则 absolute 子控件的坐标系会
  // 退到 scrollRef 内部，按钮会跟着内容滚走而不是贴在视口上。
  return (
    <div
      // [权衡] compactForRemoteControl 只追加 min-w-0 而不分叉布局：远程控制把容器
      // 压窄时，只有允许收缩才能让内部省略号生效，否则整列横向溢出。
      ref={timelineRootRef}
      className={cn("relative flex min-h-0 flex-1 flex-col", compactForRemoteControl && "min-w-0")}
    >
      {selectionActions ? (
        <ConversationSelectionTooltip
          // [失败路径] rootRef 必须指向滚动容器而不是根节点：选区探针要读
          // scrollTop/clientHeight 判断「选区是否仍在视口内」，传根节点会永远判不可见。
          rootRef={scrollRef}
          // [事务] rows 用原始投影行而不是 renderUnits：选区要按 DOM 里的 row id
          // 精确匹配文本节点，虚拟化后的轮粒度对不上。
          rows={rows}
          sourceSessionId={sessionKey}
          enabled={selectionActions.enabled}
          sideActionDisabled={selectionActions.sideActionDisabled}
          onAddToCurrentTask={selectionActions.onAddToCurrentTask}
          onAskInSideChat={selectionActions.onAskInSideChat}
        />
      ) : null}
      <ConversationScrollMemoryScopeCapture
        // [时序] 这个哨兵不渲染内容，只在 commit 前后各采一次记忆：scopeKey 切换
        // （会话 / draft）发生在渲染之外，没有可挂的事件（INV-14）。
        scopeKey={scrollMemoryKey}
        capture={captureScrollMemoryBeforeScopeMutation}
        // [事务] 采集与提交必须成对使用同一组回调：commit 阶段要拿 capture 存下的
        // 旧 scope 值写回新 key，缺一半就会把位置写到别的会话名下。
        commit={commitCapturedScrollMemory}
      />
      {/* Bugfix：分享选择流程无论面板展开还是收起，左 rail 都由分享面板或 reopen 按钮独占，
          必须隐藏对话轮导航，避免两个绝对定位控件互相覆盖。退出分享选择后自动恢复。 */}
      {hideTurnNavigator ? null : (
        <ConversationTurnNavigator
          // [权衡] 目录需要完整的 renderUnits 而不是虚拟窗口：rail 要能跳到尚未挂载
          // 的轮，传可见项会让快速滚动时丢条目（INV-26）。
          renderUnits={renderUnits}
          // [时序] 补拉历史期间禁止目录补拉自身：两者都打同一个接口，会让
          // loadOlder 与 hydration 互相取消进度。
          isHydratingDirectory={loadingOlder}
          scrollOffsetPx={virtualizer.scrollOffset ?? turnNavigatorViewport.scrollOffsetPx}
          viewportHeightPx={
            virtualizer.scrollRect?.height ?? turnNavigatorViewport.viewportHeightPx
          }
          virtualItems={turnNavigatorVirtualItems}
          // [事务] activeQueryRowId 由 viewport 状态提供（已挂载优先、未挂载回退 unit）：
          // 两处算法必须共用同一份数据，否则高亮会漂到相邻提问（INV-27）。
          activeQueryRowId={turnNavigatorViewport.activeQueryRowId}
          onJumpToQuery={scrollToQuery}
        />
      )}
      <div
        // [资源] 整个时间线只能有一个滚动容器：ref 同时供 virtualizer、
        // 记忆恢复与 rail 同步读取，多包一层会各自量到不同的元素。
        ref={scrollRef}
        data-testid={TID_V4_TIMELINE}
        data-v4-timeline-scroll="true"
        // [事务] 分享选择期间用属性而不是卸载容器来锁滚动：scrollTop 与
        // scrollbar-gutter 都必须保持不变，勾选目标才不会漂走。
        data-v4-timeline-scroll-locked={backgroundScrollLocked ? "true" : "false"}
        data-markdown-table-layout-root="true"
        // [事务] row-count 与 render-unit-count 是两个计量单位，断言与测试各自依赖，
        // 不要为了「看起来统一」把其中一个改掉。
        data-row-count={rows.length}
        data-window-row-count={rows.length}
        data-render-unit-count={renderUnits.length}
        data-total-row-count={totalCount}
        data-following={backToBottomVisible ? "false" : "true"}
        // [事务] 反向取值是刻意的：可见回底按钮等价于「已离底」，自动化依赖这个
        // 映射判断跟随态，改成同向会让所有滚动断言反转。
        data-loading-older={loadingOlder ? "true" : "false"}
        // [时序] 六个 capture 处理器必须绑在容器上：只有容器内的手势才算
        // 「正在看这段历史」，页面别处的拖拽不该关掉跟随（INV-31/32）。
        onKeyDownCapture={handleKeyDownCapture}
        onPointerCancelCapture={handlePointerEndCapture}
        onPointerDownCapture={handlePointerDownCapture}
        onPointerUpCapture={handlePointerEndCapture}
        onScroll={handleScroll}
        onTouchCancelCapture={handleTouchEndCapture}
        onTouchEndCapture={handleTouchEndCapture}
        onTouchMoveCapture={handleTouchMoveCapture}
        onTouchStartCapture={handleTouchStartCapture}
        onWheelCapture={handleWheelCapture}
        // [权衡] 滚动区自己声明 overflow-x-hidden：宽内容交给代码块与表格的内部
        // 容器滚动，时间线永远不产生横向滚动条（否则 rail 与内容列会被推歪）。
        className={cn(
          // 原生滚动条按内容高度动态出现时会缩窄会话视口，导致消息与 composer
          // 横向跳动；稳定预留 gutter，让桌面与手机 Web 共用的滚动区宽度保持不变。
          // 只声明 overflow-y-auto 会让浏览器把横轴计算为 auto，宽内容会把
          // 整条 Conversation 撑出横向滚动；表格和代码块应由各自内部容器滚动。
          "min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable] [--markdown-table-layout-left-inset:16px] [--markdown-table-layout-right-inset:16px] max-md:[--markdown-table-layout-left-inset:8px] max-md:[--markdown-table-layout-right-inset:8px]",
          // 分享选择面板展开时改为 overflow-hidden：scrollTop 与 scrollbar-gutter 都保持不变，
          // 但原生滚动条、滚轮和键盘翻页都不再能移动背景，勾选目标不会漂走。
          backgroundScrollLocked && "!overflow-y-hidden",
          compactForRemoteControl && "min-w-0",
          // 浮窗形态：滚动容器止于输入框上方 12px，消息底部再留 16px 空白。
          floatingComposerDock &&
            "mb-[calc(var(--v4-floating-composer-dock-height,0px)+12px)] pb-4",
          // 修复原因：Conversation turn map 覆盖 timeline 左侧 48px；表格增强滚动如果仍按
          // 普通 16px 边距借位，会有 32px 落到 turn map 下方，必须把完整占用计入左边界。
          turnNavigatorQueryRowIds.size >= 2 &&
            "@min-[864px]/conversation:[--markdown-table-layout-left-inset:48px]",
        )}
      >
        <div
          // [权衡] 这一层只负责「最小高度 + 内容纵向排布」，不承担滚动：
          // min-h-full 让空态分支拿到真实高度，居中计算才不会退化为 0。
          // [事务] 内容层与滚动容器分离，是为了让 composer 的 sticky 定位
          // 以内容层为参照，而不是以滚动的 scrollRef 为参照。
          className={cn(
            // 固定高度断点会在窗口跨过临界值时让问候语与 composer 整组跳动。
            // 顶部留白按视口高度伸缩，输入框的位置不再受下方推荐列表高度影响；
            // 空间不足时顶部可收缩到底线，底部继续随内容自然排布。
            responsiveCenteredEmptyLayout
              ? // Bugfix 根因：动态修改原生窗口下限会把内容换行反馈到窗口拖动，产生阻尼；
                // 容器保留固有最小高度，由外层 timeline 统一承接受限高度下的溢出内容。
                "flex min-h-full flex-col items-center px-4 before:block before:min-h-[52px] before:w-full before:shrink before:basis-[29dvh] before:content-[''] after:block after:min-h-4 after:w-full after:flex-1 after:content-['']"
              : centeredEmptyLayout
                ? "flex min-h-full flex-col items-center justify-center gap-4 px-4"
                : "flex min-h-full flex-col",
          )}
          // session 切到 draft 时内容高度骤降，Chrome 会把子树里的
          // sticky composer 选作原生 scroll anchor，并在切回后覆盖 layout/RAF 恢复值。
          // V4 已自管 prepend、吸底和记忆锚点；和其它虚拟列表一致，应从内容子树禁用锚点候选。
          style={{ overflowAnchor: "none" }}
        >
          {renderUnits.length === 0 && !headerSlot ? (
            <div
              className={cn(
                centeredEmptyLayout
                  ? "flex w-full max-w-2xl shrink-0 items-center justify-center"
                  : "min-h-0 flex-1",
                !centeredEmptyLayout && summaryPanelInlineOffsetClassName,
              )}
            >
              {emptyState}
            </div>
          ) : (
            <div
              // [资源] messageLayerRef 是 mask 几何的唯一来源：遮罩的起始透明高度
              // 按这一层的高度算，换成子元素会让「离底淡出」的比例随后续内容变化。
              ref={messageLayerRef}
              data-v4-timeline-message-layer="true"
              data-sandbox-page-container="true"
              // [权衡] mask-repeat 必须在标准和 -webkit- 前缀上都声明：只写标准属性时
              // Safari 仍会平铺遮罩，淡出区域会在每一屏重复出现（INV-17/19）。
              className="relative w-full flex-1 [mask-repeat:no-repeat] [-webkit-mask-repeat:no-repeat]"
            >
              {/*
               * headerSlot 必须落在被 mask 的消息层内、并套用与实时消息列相同的宽度类：
               * 放在消息层之外会既比正文宽、又从 sticky composer 下方透出来。
               */}
              {headerSlot ? (
                <div
                  // [事务] headerSlot 放在 message layer 之内（INV-36）：它要参与同一套
                  // mask 与同一列宽，放到外层会既比正文宽、又从 composer 下方透出来。
                  ref={headerSlotRef}
                  data-v4-timeline-header-slot="true"
                  data-v4-timeline-content-column="true"
                  // [时序] 列宽类必须与虚拟层 / live tail 完全一致：三者任一不同，
                  // ResizeObserver 就会在切换宽度时报告两次，触发额外的测高重排。
                  className={cn(
                    "relative mx-auto w-full shrink-0",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  {headerSlot}
                </div>
              ) : null}
              <div
                // [时序] 高度直接写 totalSize：虚拟层的 scrollHeight 必须与
                // virtualizer 的测量总和完全一致，否则滚动条长度与实际内容不符（INV-6）。
                ref={virtualHistoryRef}
                data-v4-timeline-virtual-history="true"
                data-v4-timeline-content-column="true"
                // [权衡] 只过渡 transform（≥1280px）：宽度过渡会让每一行都重排，
                // 面板让位时用位移代替宽度变化，动画成本低一个数量级。
                className={cn(
                  // 默认（< 1280px）过渡 width/max-width/transform，让 w-full ↔ max-w-4xl
                  // 的中等宽度切换平滑；≥1280px 触发的面板让位（max-w-6xl + 168px 左移）
                  // 用 @min-[1280px] 降级为只过渡 transform，避免大范围跳变叠加位移抖动。
                  "relative mx-auto w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                  contentWidthClassName,
                  summaryPanelInlineOffsetClassName,
                )}
                // [事务] 用内联 height 而不是 min-height：绝对定位子项不参与父级
                // 高度计算，必须显式撑开，scrollTop 的最大值才能覆盖整个历史。
                style={{ height: totalSize }}
              >
                {virtualRows.map((virtualRow) => {
                  const unit = virtualizedUnits[virtualRow.index];
                  // [失败路径] 必须判空返回：虚拟窗口是按上一帧的 totalSize 算的，
                  // 同帧内 rows 缩短时索引可能越界，直接解引用会整屏白掉。
                  if (!unit) return null;
                  return (
                    <div
                      // [事务] key 拼上 logEpoch：日志重载后同一轮内容可能被整体替换，
                      // 只靠 virtualRow.key 会复用旧 DOM，展开态与代码高亮都会残留（INV-3）。
                      key={`${virtualRow.key}:${rowContext.logEpoch ?? ""}`}
                      ref={virtualizer.measureElement}
                      data-index={virtualRow.index}
                      data-v4-turn-unit="true"
                      data-turn-id={unit.turnId}
                      // virtual history 的子项通过 absolute 定位，父级 padding 不会缩小
                      // 它们的 containing block；正文响应式内边距必须落在 turn wrapper 自身。
                      className="absolute left-0 top-0 w-full"
                      // [事务] 位移用 transform 而不是 top：transform 不触发布局，
                      // 滚动时只走合成层；减 headerSlotHeight 是因为虚拟坐标已含 scrollMargin。
                      style={{ transform: `translateY(${virtualRow.start - headerSlotHeight}px)` }}
                    >
                      <ConversationTurnGroup
                        // [事务] 历史项恒传 apiRetry=null（INV-29）：重试态只属于
                        // live tail，否则滚到旧轮还会看到「正在重试」。
                        unit={unit}
                        nowMs={liveNowMs}
                        apiRetry={null}
                        context={rowContext}
                        onFork={onFork}
                        onRetry={onRetry}
                        onFeedbackChange={onFeedbackChange}
                        onEdit={onEdit}
                      />
                    </div>
                  );
                })}
              </div>
              {liveUnit !== null && liveUnitIndex !== null ? (
                <div
                  // [并发] live tail 不进虚拟窗口（INV-2）：它每帧都在长高，交给
                  // virtualizer 测量会让整张 offset 表每帧重排，滚动直接掉帧。
                  key={`${liveUnit.key}:${rowContext.logEpoch ?? ""}`}
                  // [资源] liveTailRef 只用于把真实高度写回 height cache，不参与定位；
                  // 因此这里刻意不设 data-index，设了会被 measureElement 当成虚拟项测高。
                  ref={liveTailRef}
                  data-index={liveUnitIndex}
                  data-v4-running-live-tail="true"
                  data-v4-turn-unit="true"
                  data-turn-id={liveUnit.turnId}
                  data-v4-timeline-content-column="true"
                  className={cn(
                    // ≥1280px 面板让位时降级为只过渡 transform，避免大范围跳变叠加位移抖动。
                    "relative mx-auto w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  <ConversationTurnGroup
                    // [事务] apiRetry 只注入 live turn（INV-29），历史轮同字段恒为 null；
                    // 两者不能共用一个 prop 默认值，否则重试条会在历史里复现。
                    unit={liveUnit}
                    nowMs={liveNowMs}
                    apiRetry={apiRetry}
                    context={rowContext}
                    onFork={onFork}
                    onRetry={onRetry}
                    onFeedbackChange={onFeedbackChange}
                    onEdit={onEdit}
                  />
                </div>
              ) : null}
              {pendingGuides.length > 0 ? (
                <div
                  // [权衡] 引导卡排在 live tail 之后且不参与虚拟化：数量是个位数，
                  // 但位置必须紧贴最新输出，放进虚拟层会被窗口裁掉。
                  data-v4-timeline-content-column="true"
                  // [事务] 列宽类与正文保持一致：引导卡是内容的一部分，宽度不同会让
                  // 空态/浮窗两种布局下出现「卡片比气泡宽」的观感差异。
                  className={cn(
                    "relative mx-auto w-full shrink-0",
                    contentWidthClassName,
                    summaryPanelInlineOffsetClassName,
                  )}
                >
                  <ConversationPendingGuideList
                    context={rowContext}
                    items={pendingGuides}
                    // [失败路径] turnId 三级回退（live → 最后一行 productTurnId → turnId）：
                    // 缺它卡片无法回填到某一轮，投递状态就永远停在 pending。
                    turnId={
                      liveUnit?.turnId ??
                      rows.at(-1)?.productTurnId ??
                      rows.at(-1)?.turnId ??
                      "pending-guide"
                    }
                  />
                </div>
              ) : null}
            </div>
          )}
          {bottomDock ? (
            <div
              // [资源] dock 高度经 ResizeObserver 写成 CSS 变量下发（INV-30），
              // 所以 ref 必须指向外壳而不是内容列，否则量到的是去掉 padding 后的值。
              ref={composerDockRef}
              data-v4-composer-dock="true"
              // [权衡] sticky / absolute / 静态三种定位由一个三元链决定：它们对应
              // 浮窗、空态居中、普通会话，混用会让输入框在切换布局时跳一下。
              className={cn(
                // sticky dock 是 z-20 的全宽透明层，过去会盖住 z-10 rail
                // 在 composer 左侧留白内的按钮。外壳不接事件，只让实际内容列恢复命中。
                "pointer-events-none z-20 flex w-full justify-center",
                // 浮窗形态：滚动容器与内容层都没有定位，absolute 的包含块是时间线根节点，
                // 输入区贴在时间线底部、不随消息滚动，也不被滚动容器裁剪。
                floatingComposerDock
                  ? "absolute inset-x-0 bottom-0"
                  : responsiveCenteredEmptyLayout
                    ? "mt-3 shrink-0"
                    : centeredEmptyLayout
                      ? "shrink-0"
                      : "sticky bottom-0",
              )}
            >
              <div
                // [事务] 外壳 pointer-events-none、内容列 pointer-events-auto：
                // 只有这样 sticky 层才不会挡住 rail 与回底按钮的点击。
                data-v4-composer-dock-content="true"
                // [时序] 内容列自带 z-10，必须高于外壳的 z-20 之外的兄弟遮罩，
                // 否则消息层的淡出遮罩会盖住输入框的下半截。
                className={cn(
                  // 同 virtual history/live tail，恢复宽度过渡避免硬跳。
                  // ≥1280px 面板让位时降级为只过渡 transform，避免大范围跳变叠加位移抖动。
                  "pointer-events-auto relative z-10 w-full shrink-0 transition-[width,max-width,transform] duration-150 ease-out @min-[1280px]/conversation:transition-[transform]",
                  contentWidthClassName,
                  // 浮窗形态下输入框外壳就是浮窗最外层，不留内边距。
                  !centeredEmptyLayout && !floatingComposerDock && "px-4 pb-4",
                  !centeredEmptyLayout && summaryPanelInlineOffsetClassName,
                )}
              >
                <div data-v4-back-to-bottom-anchor="composer-dock" className="relative">
                  {backToBottomVisible ? (
                    <ConversationBackToBottomButton
                      // 分屏下 composer 属于滚动视口内的 sticky dock；按钮若挂在
                      // timeline 外层 absolute bottom，会相对整个 pane 落到 input 下方。
                      //
                      // 圆钮采用自己的居中定位；`pointer-events-auto` 保留：
                      // 它是"按钮点得动"唯一可断言的契约。
                      // [事务] z-30 必须高于 dock 的 z-20：否则按钮被透明外壳吃掉点击，
                      // pointer-events-auto 只在内容列生效，按钮看着在却点不动。
                      className="pointer-events-auto absolute bottom-full left-1/2 z-30 mb-2 -translate-x-1/2 shadow-sm"
                      label={intl.formatMessage({ id: "chat.scrollToBottom" })}
                      onClick={handleBackToBottom}
                    />
                  ) : null}
                  {bottomDock}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {backToBottomVisible && !bottomDock ? (
        <ConversationBackToBottomButton
          // [权衡] 无 dock 的布局没有 sticky 锚点，按钮退回根节点的 absolute 定位；
          // 条件里的 !bottomDock 与上一条分支互斥，保证同时只有一个回底入口。
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm"
          label={intl.formatMessage({ id: "chat.scrollToBottom" })}
          onClick={handleBackToBottom}
        />
      ) : null}
    </div>
  );
}

// [权衡] 这里用默认浅比较而不是自定义比较器：rows/renderUnits/context 都由上游
// 投影保证引用稳定，回调由 useCallback 固定；一旦改成深比较，流式期间每帧都要
// 遍历成百上千行，成本反而更高（INV-35）。
export const ConversationTimeline = memo(ConversationTimelineImpl);
