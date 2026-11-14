// ============================================================================================
// L1 深度注释：一轮对话的分组与轮尾收口（packages/ui/src/v4/ConversationTurnGroup.tsx）
// 责任边界：只消费上游投影好的 ConversationTurnRenderUnit，决定“同一轮里各块怎么排、
// 折叠态归谁、轮尾挂哪些聚合卡”，不负责行的生成、排序与筛选。
// 读法：先看 INV 表，再看 ConversationTurnFlow（分段）→ ConversationWorkSegmentFlow（块序）
// → ConversationTurnGroupImpl（轮级收口与状态门）。
// ============================================================================================
// INV-1: 一个 render unit 就是一轮对话；分组边界只由 conversationTurnRenderUnits 决定，本文件不得二次切分 —— 破坏后果：同一轮的正文与工具被拆到两个轮容器，间距与操作栏各出现一次。
// INV-2: flowItems 的数组顺序就是屏幕顺序，禁止在本文件内排序 —— 破坏后果：用户行与助手正文的时间序被打乱，重放历史时出现“先回答后提问”。
// INV-3: workSegments 长度大于 1 时每段自己持有折叠态；只有长度等于 1 或为空时才沿用 unit.assistantHistoryDefaultOpen —— 破坏后果：多段 guide 共享一个 Collapsible，展开一段会连带展开全部。
// INV-4: segment.key 必须稳定且唯一，它是 Collapsible 的身份，也是 history chunkKey 的前缀 —— 破坏后果：key 抖动会让整段历史重挂载，折叠动画与滚动位置全部丢失。
// INV-5: 首个 history chunk 的 key 固定为 segment.key，后续才带 :chunk-N —— 破坏后果：改掉首块命名会让既有的 data-testid 断言与自动化定位失效。
// INV-6: assistantHistoryDefaultOpen 为 true 时该段是受控且不可折叠的（onOpenChange 传 undefined）—— 破坏后果：用户能手动收起本应始终展开的当前轮历史，正文直接消失。
// INV-7: historyOpen 必须随 (assistantHistoryDefaultOpen, segment.key) 一起重置 —— 破坏后果：切换到另一段历史时沿用上一段的展开态，出现“明明默认收起却展开着”。
// INV-8: stageTailIsRunning 只对“最后一项且是 history/work 块”成立 —— 破坏后果：中途段落被当成运行中，工时文案在已完成的历史上显示“正在工作”。
// INV-9: flowItems 为空且没有 workStatus 的段必须整轮返回 null —— 破坏后果：留下一个只有 pt-14 的空容器，轮与轮之间出现 56px 空白。
// INV-10: timelineOnly 轮只渲染 work items 与 loading slot，不渲染用户气泡、操作栏与文件摘要 —— 破坏后果：/compact 之类的维护轮冒出无法解释的按钮。
// INV-11: 后台结果轮（origin=backgroundResult）走独立渲染分支，不参与普通工时折叠 —— 破坏后果：一段短总结被套上折叠外壳，还显示错误的分段耗时。
// INV-12: 后台标题只认 bash/subagent/workflow 白名单，未知来源退回普通 assistant 分支 —— 破坏后果：新来源被冠上一个不属于它的标题，用户误判结果出处。
// INV-13: 轮顶 padding 由“是否存在用户气泡”决定，而不是“是否有轮” —— 破坏后果：后台结果轮与设置轮上方叠出 76px 空白。
// INV-14: 正文操作栏与 Highspeed 页脚互不吞并，hasHookActions 兜底只在没有正文操作栏时出现 —— 破坏后果：普通回复出现两个入口，或 Highspeed 无正文轮丢失全部入口。
// INV-15: 轮尾块顺序固定为 完成卡 → 摘要 → Cron 卡 → OffPeak 卡 → 文件摘要 → 截图 → 操作栏 → 页脚 → tail boundary —— 破坏后果：工具栏插到摘要之前，用户读起来像摘要不是本轮收尾。
// INV-16: 行 key 必须同时包含 rowId 与 entityId —— 破坏后果：同 rowId 的实体被替换（重新生成）时复用旧 DOM，正文残留上一次内容。
// INV-17: itemKey 对单行块用 rowId、对多行块用 rows[0].rowId ?? index，禁止直接用数组下标做主键 —— 破坏后果：插入或删除一项时后续块整体错位复用。
// INV-18: Cron/OffPeak 卡片只收集 status==="success" 的行，同 id 后者覆盖前者 —— 破坏后果：失败的调用被提升成成功卡片，或重复卡片堆叠。
// INV-19: CronDelete 必须撤销此前收集的同 id 卡片 —— 破坏后果：已经删除的自动化仍在轮尾显示“创建成功”。
// INV-20: Cron/OffPeak 卡片 key 用 rowId:toolCallId 复合 —— 破坏后果：同一工具被多次调用时 React 认为是同一张卡，内容互相覆盖。
// INV-21: highspeed 标识 = 内存记录 OR 行级持久化标记 —— 破坏后果：卡过期或冷恢复后，加速输出被降级成普通工时展示。
// INV-22: 紫色流光必须同时满足 isHighspeed && isRunning && expiresAt > nowMs —— 破坏后果：卡过期后仍在执行的工具被永久染成紫色。
// INV-23: 完成态统计只在 unit.isRunning 为 false 时可见 —— 破坏后果：统计先于整轮结束出现，数字随后又被续写改大。
// INV-24: 分享目标三级回退（内存卡 → unit 指定 → 持久化 meta），任一环节数据不完整即禁用 —— 破坏后果：分享按钮可点但提交空指标，或冷恢复后永久灰掉。
// INV-25: 代码评论投影需要特性开关 &&（运行中或终态）—— 破坏后果：关闭特性后正文仍被裁剪，用户看到残缺内容。
// INV-26: 代码评论卡片只在终态生成，流式期间只投影正文 —— 破坏后果：运行中先冒出卡片，模型续写后又回滚消失。
// INV-27: fork/retry 只挂在最新正文上，历史正文必须隐藏操作栏 —— 破坏后果：用户对历史段落点重试，实际重跑的是另一段。
// INV-28: assistantCopyText 必须与屏幕正文一致（经过评论投影）—— 破坏后果：复制出来的内容里夹着给模型看的特化标记。
// INV-29: apiRetry 只由 Timeline 注入给 live turn，历史轮恒为 null —— 破坏后果：滚动到旧轮时仍显示“正在重试”，用户以为整轮在重跑。
// INV-30: 重试计数从第 3 次才展示，且 maxRetries 要减 1（协议含首次请求）—— 破坏后果：默认 10 次重试被写成 1/11。
// INV-31: workStatus 的 running/interrupted/completed 三种文案互斥，且 interrupted 还要区分话题被中断 —— 破坏后果：已停止的轮显示“正在工作”，或停止原因张冠李戴。
// INV-32: 折叠外壳必须在确认内层有可渲染项之后才创建 —— 破坏后果：CUA 消费正文后留下 pt-5 加空 gap 容器。
// INV-33: 本文件用 memo 浅比较，依赖 unit 引用稳定 —— 破坏后果：上游每次渲染新建 unit，整轮所有块无条件重算。
// INV-34: leadingBoundaryRows / browserTurnEndRows / assistantTailRows 是轮的边界行，必须固定在各自位置 —— 破坏后果：fork 分割线跑到工具卡后面，轮的边界与内容错位。
// INV-35: visibleUserRows 必须代理 unit.visibleUserInputs（已被上游裁剪过），不得回退到原始 user 行 —— 破坏后果：被裁剪的规范句重新出现，用户看到自己没写过的指令。
// INV-36: Highspeed 订阅用 useSyncExternalStore，快照函数必须是稳定且幂等的版本号 —— 破坏后果：快照每次返回新对象会让组件无限重渲染。
// INV-37: isHighspeed 是内存记录与行级标记的并集，任一侧为真即成立 —— 破坏后果：刷新后加速轮退化成普通轮，页脚与紫光一起消失。
// INV-38: highspeedExpiresAt 用 -Infinity 作初值再取 max，空集合时比较恒为假 —— 破坏后果：用 0 作初值时，纪元时间戳的卡会让紫光在过期后仍然点亮。
// INV-39: 分享指标必须四个数值同时为正（outputTokens/regularTps/highspeedTps 及可聚合的卡）—— 破坏后果：分享出 0 tps 的空报告，或被 1.2x 以下的比例刷屏。
// INV-40: highspeedShareTarget 的三级回退顺序固定为 内存卡聚合 → unit 指定 → 持久化 meta —— 破坏后果：冷恢复后字段不全的 meta 抢先命中，分享按钮变灰。
// INV-41: assistantRowContext 只在 firstReasoningRowId 存在时才展开覆盖对象 —— 破坏后果：无条件写入 undefined 会让下游的“是否首块”判断从有值变成显式空，类型与行为同时漂移。
// INV-42: 代码评论投影开关 = 特性开关 &&（运行中或终态）；缺任一条件都不投影 —— 破坏后果：特性关闭时正文被裁掉注释，用户读到残缺内容。
// INV-43: assistantCopyText 必须由 assistantRawCopyText 经同一投影得到，二者不可各算一遍 —— 破坏后果：屏幕正文与复制文本不一致（INV-28）。
// INV-44: 文件摘要取全部 assistantTextRows 用空行拼接，不能只取最新一段 —— 破坏后果：多次续写的产物清单缺前半段。
// INV-45: 轮尾聚合卡（cron/offpeak/completion）在 isRunning 时必须为空 —— 破坏后果：运行中先冒出“创建成功”，随后又被最终状态改写。
// INV-46: deliverySourceCommandIds 是 header 与可见用户行的并集且允许重复，由下游去重 —— 破坏后果：在这里去重会让“同一指令多次投递”丢失归因。
// INV-47: canRenderAssistantActions 的三个条件（非 timelineOnly / 终态 complete / 有复制文本）必须同时成立 —— 破坏后果：无正文轮给出一个复制为空的操作栏。
// INV-48: hasAssistantTurnContent 是“是否渲染整块助手区”的总开关，必须包含文件变更与各类轮尾卡 —— 破坏后果：只有文件变更的一轮被整块丢弃，diff 摘要消失。
// INV-49: rewind 可用性按 noFiles → reverted → running → 权限 的优先级判定，顺序即提示文案的优先级 —— 破坏后果：正在运行时提示“不可用”而不是“运行中”。
import { BotTopicPreparation } from "@/v4/BotTopicPreparation.js";
import { useBotTopicInterruption } from "@/v4/botGroupDeliveryContext.js";
import { ConnectedBotGroupDeliveryAction } from "@/v4/BotGroupDeliveryAction.js";
/* eslint-disable max-lines -- turn group 需要在同一处维护普通 assistant 与后台结果的严格行序，拆分会重复 actions/preview/tail 协议。 */
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { ChevronRightIcon, EyeIcon } from "lucide-react";
import { type HighspeedMessageMeta, type ZCodeApiRetryStatus } from "@zcode/shared";
import {
  TID_CHAT_ASSISTANT_HISTORY_CONTENT,
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
  TID_CHAT_BACKGROUND_RESULT_TITLE,
  TID_CHAT_LOADING,
  TID_V4_ROW,
  testId,
} from "@zcode/shared/test-ids";
import type {
  ApiRetryState,
  AttachmentRef,
  CommandAck,
  ConversationRowTarget,
} from "@zcode/shared/zcode-protocol-v4";
import { ChatLoading } from "@/components/ai-elements/chat-loading.js";
import { ChatApiRetryStatus } from "@/chat-input-toolbar/display.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { MessageActions } from "@/components/ai-elements/message.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import {
  CronCreateAutomationCard,
  isCronAutomationCardToolCall,
  readCronCreateAutomationSummary,
  type CronCreateAutomationSummary,
} from "@/ToolCallBlocks/renderers/cron-create.js";
import {
  isOffPeakCreateToolCall,
  OffPeakCreateTaskCard,
  readOffPeakCreateTaskSummary,
  type OffPeakCreateTaskSummary,
} from "@/ToolCallBlocks/renderers/offpeak-create.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { HighspeedShareDialog } from "@/highspeed/HighspeedShareNoticeCard.js";
import { isHighspeedShareEligible } from "@/highspeed/highspeedShare.js";
import {
  aggregateHighspeedCardMetrics,
  getHighspeedTurnByCommandId,
  getHighspeedTurnVersion,
  subscribeHighspeedTurns,
  type HighspeedShareMetrics,
} from "@/highspeed/highspeedTurnStore.js";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";
import {
  buildAssistantCodeCommentCards,
  projectAssistantCodeComments,
  type AssistantCodeCommentCard,
} from "@/lib/assistantCodeComment.js";
import { useAssistantPreviewCardsForAssistantTextRow } from "@/v4/useAssistantPreviewCardsForRow.js";
import { shouldShowTurnChatLoading } from "@/v4/chatLoadingVisibility.js";
import {
  buildAssistantWorkRenderItems,
  ENABLE_CHANGES_TOOL_CALL_GROUPING,
  ENABLE_CUA_TOOL_CALL_GROUPING,
  ENABLE_EXPLORE_TOOL_CALL_GROUPING,
  ENABLE_TERMINAL_TOOL_CALL_GROUPING,
  type ConversationAssistantWorkRenderItem,
} from "@/v4/conversationAssistantWorkItems.js";
import type { ConversationCuaGroupEvent } from "@/v4/conversationCuaGroups.js";
import { ConversationAgentToolCallRow } from "@/v4/ConversationAgentToolCallRow.js";
import { ConversationFileSummaryPanel } from "@/v4/ConversationFileSummaryPanel.js";
import {
  WorkflowNotificationToolRow,
  workflowRowNotification,
  type WorkflowRowNotification,
} from "@/v4/WorkflowNotificationToolRow.js";
import { ConversationWorkflowDigests } from "@/v4/ConversationWorkflowDigests.js";
import { ConversationWorkflowCompletion } from "@/v4/ConversationWorkflowCompletion.js";
import { resolveWorkflowTurnDigests } from "@/v4/workflowTurnDigests.js";
import { resolveWorkflowTurnCompletion } from "@/v4/workflowTurnCompletion.js";
import { ConversationAssistantTextActions } from "@/v4/ConversationRowView.js";
import { readAssistantFeedback } from "@/v4/ConversationRowView.js";
import type {
  AssistantFeedbackHandler,
  EditWorkspaceRewindAvailability,
} from "@/v4/ConversationRowView.js";
import {
  isConversationReasoningRowVisible,
  type ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";
import type {
  AssistantWorkRow,
  ConversationTurnFlowItem,
  ConversationTurnRenderUnit,
  ConversationTurnWorkSegment,
} from "@/v4/conversationTurnRenderUnits.js";
import { formatConversationWorkDuration } from "@/v4/conversationWorkDuration.js";
import { ConversationTurnRow, resolveAssistantCopyText } from "@/v4/ConversationTurnRow.js";
import { ConversationHookDetailsAction } from "@/v4/ConversationHookDetailsAction.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";

// [事务] unit 是这一轮的唯一事实来源：本组件不持有对话数据，只按 unit 投影顺序。
// 这也是 memo 能生效的前提——unit 引用不变就说明本轮内容没变（见 INV-33）。
interface ConversationTurnGroupProps {
  unit: ConversationTurnRenderUnit;
  /** Timeline 的共享 UI 时钟；用于在 Highspeed 过期边界立即撤销运行态紫色流光。 */
  nowMs?: number;
  /** 仅由 Timeline 注入给当前 live turn；历史 turn 永远不携带运行时 retry。 */
  apiRetry?: ApiRetryState | null;
  // [事务] context 是渲染上下文而不是数据源：所有回调/主题/路径都从这一份往下传，
  // Timeline 为每个轮注入同一对象（仅 firstReasoningRowId 会派生一份）。
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  // [失败路径] onEdit 允许返回 void：命令可能被本地拒绝（无权限、正文不可编辑），
  // 调用方据此不弹错误。组件只等待 Promise 结束以恢复按钮态，不解释结果。
  onEdit?: (
    target: ConversationRowTarget,
    newText: string,
    attachments?: readonly AttachmentRef[],
    workspaceMode?: "preserve" | "rewind",
  ) => Promise<CommandAck | boolean | void> | CommandAck | boolean | void;
}

// [失败路径] rowId 与 toolCallId 双字段都不是装饰：卡片 key 用二者复合（INV-20），
// 而 rowId 同时是打开 automations 主面板时定位到那一行所需的锚点。
interface CronAutomationTurnCard {
  rowId: number;
  toolCallId: string;
  automation: CronCreateAutomationSummary;
}

interface OffPeakTurnCard {
  rowId: number;
  toolCallId: string;
  task: OffPeakCreateTaskSummary;
}

// [权衡] 阈值取 3 而不是 1：前两次短暂重试对用户与“普通加载”没有区别，
// 过早显示 1/10、2/10 会让每一次网络抖动都变成一次焦虑；第 3 次才说明真的卡住了。
const MIN_VISIBLE_API_RETRY_ATTEMPT = 3;

interface HighspeedOutputFooterProps {
  generatedLabel: string;
  shareLabel: string;
  shareAriaLabel: string;
  shareEnabled: boolean;
  sharePending: boolean;
  onShare: () => void;
}

// [权衡] 页脚只负责“生成来源 + 分享入口”，不参与操作栏布局：Highspeed 轮可能
// 没有正文（无 copy/fork 可挂），把页脚塞进 MessageActions 会导致空容器。
function HighspeedOutputFooter({
  generatedLabel,
  shareLabel,
  shareAriaLabel,
  shareEnabled,
  sharePending,
  onShare,
}: HighspeedOutputFooterProps) {
  // [失败路径] shareEnabled 为假时整个按钮不渲染，而不是渲染成 disabled：
  // 分享资格由指标完整度决定（INV-24），灰按钮会让人以为是临时故障、反复点击。
  return (
    // [权衡] 用 aria-hidden 的绝对定位细线而不是 border-bottom：页脚要压在分割线
    // 正中，让左右两段文字都“骑”在线上；border 只能贴在容器底边，视觉上会偏下。
    <div
      data-highspeed-output-footer="true"
      className="relative flex w-full items-center justify-center py-[18px] opacity-80"
    >
      <div aria-hidden="true" className="absolute inset-x-0 top-1/2 border-t border-border" />
      <div className="relative flex items-center gap-2 bg-background px-3">
        <span className="text-ui-base text-foreground-subtle">{generatedLabel}</span>
        {shareEnabled ? (
          <Button
            type="button"
            variant="ghost"
            size="default"
            className="h-7 gap-1 rounded-[8px] bg-black/5 px-2 py-1 text-ui-base font-medium leading-5 text-foreground hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10"
            data-highspeed-output-share="true"
            disabled={sharePending}
            aria-label={shareAriaLabel}
            onClick={onShare}
          >
            <EyeIcon
              className="size-4 text-foreground/85"
              strokeWidth={4 / 3}
              aria-hidden="true"
              data-highspeed-output-share-icon="true"
            />
            {shareLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// [事务] 这里是“协议口径 → 展示口径”的唯一换算点（INV-30）：attempt 至少为 1，
// maxRetries 取 maxAttempts-1 且不得小于 attempt，否则 UI 会出现 3/2 这种倒挂。
// 换算放在本文件而不是展示组件，是为了让所有入口（live / 历史）口径一致。
function toRetryStatus(apiRetry: ApiRetryState): ZCodeApiRetryStatus {
  const attempt = Math.max(1, Math.floor(apiRetry.attempt));
  // v4 maxAttempts 包含首次请求，而展示口径是重试次数；直接展示会把
  // 默认 10 次重试写成 1/11。
  const maxRetries = Math.max(Math.floor(apiRetry.maxAttempts) - 1, attempt);
  return {
    kind: "api_retry",
    attempt,
    maxRetries,
    // [权衡] retryDelayMs 恒置 0：v4 的重试不暴露精确退避剩余时间，
    // 编一个数字会与真实倒计时不符，宁可不显示进度条。
    retryDelayMs: 0,
    errorStatus: null,
    error: apiRetry.reasonCode,
  };
}

function TurnChatLoadingSlot({
  apiRetry,
  eligible,
}: {
  apiRetry: ApiRetryState | null;
  eligible: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const retryStatus = useMemo(() => (apiRetry ? toRetryStatus(apiRetry) : null), [apiRetry]);
  // 前两次短暂恢复对用户等价于普通加载；保留 apiRetry 运行态，但只在
  // 第三次重试开始后显示计数。必须在 retry/loading 分支前收敛，否则会留下空 slot，
  // 而不是回退到 ChatLoading。
  const visibleRetryStatus =
    retryStatus && retryStatus.attempt >= MIN_VISIBLE_API_RETRY_ATTEMPT ? retryStatus : null;
  // [失败路径] 双 false 时必须返回 null：留一个 min-h-5 的空 slot 会让轮尾凭空
  // 多出 20px，且用户看不到任何内容——这正是历史上“轮之间偶尔多一条缝”的来源。
  if (!visibleRetryStatus && !eligible) return null;
  return (
    <div data-zcode-chat-loading-slot="true" className="min-h-5">
      {visibleRetryStatus ? (
        <ChatApiRetryStatus apiRetry={visibleRetryStatus} intl={intl} locale={locale} />
      ) : (
        // running 是 ChatLoading 的权威事实；额外静默计时会让 projection
        // 更新反复重启可见性，并使 UI 晚于真实状态。
        <ChatLoading loading data-testid={TID_CHAT_LOADING} size="sm" />
      )}
    </div>
  );
}

// [事务] 三个分组行（explore / tool / cua）都只做“薄包装”：把 item 拆成 ToolCallBlock
// 需要的 props，并且在最外层挂 data-row-id / data-conversation-selectable。
// 选择与定位依赖这两个属性，漏挂会让该行无法被框选、也无法被“跳到行”功能命中。
function ConversationExploreGroupRow({
  item,
  context,
}: {
  item: Extract<ConversationAssistantWorkRenderItem, { kind: "exploreGroup" }>;
  context: ConversationRowRenderContext;
}) {
  // explore 分组行已经处在 turn 容器的统一边距内，单独再加 px-4
  // 会让同一串工具调用有的内缩、有的不内缩。
  // [权衡] exploreGroup 不展开事件列表，只把 node 交给 ToolCallBlock：检索类工具
  // 的中间结果由工具卡自身按需拉取，提前在这里聚合会让长会话一次性解析全部命中。
  return (
    <div
      data-row-id={item.rowId}
      data-conversation-selectable="true"
      data-testid={testId(TID_V4_ROW, String(item.rowId))}
    >
      <ToolCallBlock
        toolCallNode={item.node}
        workspacePath={context.workspacePath}
        theme={context.theme}
        codePreviewSettings={context.codePreviewSettings}
        showTodoToolCalls={context.messageStreamShowTodos === true}
        onOpenCodeViewer={context.onOpenCodeViewer}
        onOpenFileLink={context.onOpenFileLink}
        onOpenBrowserUrl={context.onOpenBrowserUrl}
        onOpenAutomationsMain={context.onOpenAutomationsMain}
      />
    </div>
  );
}

function ConversationToolGroupRow({
  item,
  context,
}: {
  item: Extract<
    ConversationAssistantWorkRenderItem,
    { kind: "cuaGroup" | "executeGroup" | "changesGroup" }
  >;
  context: ConversationRowRenderContext;
}) {
  const renderAssistantMessage = useCallback(
    (event: Extract<ConversationCuaGroupEvent, { kind: "assistantMessage" }>) => (
      <ConversationTurnRow
        row={event.row}
        context={context}
        // [事务] 分组内部的正文一律 hideAssistantActions：它是“工具调用的旁白”，
        // 不是本轮最终回答，出现操作栏会诱导用户对其复制/重试（INV-27）。
        hideAssistantActions
        assistantCodeCommentProjectionEnabled={false}
      />
    ),
    [context],
  );
  const renderReasoning = useCallback(
    (event: Extract<ConversationCuaGroupEvent, { kind: "reasoning" }>) => (
      <ConversationTurnRow row={event.row} context={context} reasoningContentVariant="nested" />
    ),
    [context],
  );
  // [失败路径] cuaGroupEvents 必须先过滤掉被隐藏的 reasoning 再交给 renderer：
  // 不在这里过滤，展开分组后会看到本应被设置隐去的思考块。
  // executeGroup/changesGroup 不消费事件，因此返回 undefined 而不是空数组——
  // 空数组会让 ToolCallBlock 以为“有事件但全被过滤”，从而隐藏展开区。
  const visibleCuaEvents = useMemo(
    () =>
      item.kind === "cuaGroup"
        ? item.events.filter(
            (event) =>
              event.kind !== "reasoning" ||
              isConversationReasoningRowVisible(event.row.rowId, context),
          )
        : undefined,
    [context, item],
  );
  // [失败路径] 只有 cuaGroup 才传 renderer：executeGroup/changesGroup 的 events
  // 结构不同，错传会让 ToolCallBlock 在展开时渲染出 undefined 的子节点。
  // [事务] showTodoToolCalls 只认严格 true，未注入时默认隐藏 todo 工具：
  // 这是历史行为，改成默认显示会让所有旧 transcript 多出一批待办工具行。
  return (
    <div
      data-row-id={item.rowId}
      data-conversation-selectable="true"
      data-testid={testId(TID_V4_ROW, String(item.rowId))}
    >
      <ToolCallBlock
        toolCallNode={item.node}
        workspacePath={context.workspacePath}
        theme={context.theme}
        codePreviewSettings={context.codePreviewSettings}
        showTodoToolCalls={context.messageStreamShowTodos === true}
        onOpenCodeViewer={context.onOpenCodeViewer}
        onOpenFileLink={context.onOpenFileLink}
        onOpenBrowserUrl={context.onOpenBrowserUrl}
        onOpenAutomationsMain={context.onOpenAutomationsMain}
        // history/background 兼容路径只传虚拟父节点时，已被分组投影消费的
        // Assistant message / reasoning 没有交给 renderer，展开后会永久丢失。
        cuaGroupEvents={visibleCuaEvents}
        renderCuaAssistantMessage={item.kind === "cuaGroup" ? renderAssistantMessage : undefined}
        renderCuaReasoning={item.kind === "cuaGroup" ? renderReasoning : undefined}
      />
    </div>
  );
}

function ConversationCuaGroupRow({
  item,
  context,
}: {
  item: Extract<ConversationTurnFlowItem, { kind: "cuaGroup" }>;
  context: ConversationRowRenderContext;
}) {
  const renderAssistantMessage = useCallback(
    (event: Extract<(typeof item.events)[number], { kind: "assistantMessage" }>) => (
      <ConversationTurnRow
        row={event.row}
        context={context}
        // [失败路径] 分组内的正文必须 hideAssistantActions 且关闭评论投影：
        // 它是历史中间态，给一个复制/重试入口会让用户以它为起点重跑（INV-27）。
        hideAssistantActions
        assistantCodeCommentProjectionEnabled={false}
      />
    ),
    [context],
  );
  const renderReasoning = useCallback(
    (event: Extract<(typeof item.events)[number], { kind: "reasoning" }>) => (
      // [事务] reasoningContentVariant 固定 nested：分组内部是“工具调用的上下文”，
      // 用默认样式会让思考块看起来比它所属的工具卡还醒目。
      <ConversationTurnRow row={event.row} context={context} reasoningContentVariant="nested" />
    ),
    [context],
  );
  // [权衡] 这是 flow 级 CUA 分组（与上面 work 级 CUA 分组并存）：两者的 item 类型
  // 不同、来源不同，合并成一个组件会引入大量类型分支，反而更容易出错。
  // 事件过滤规则必须与 work 级保持一致，否则分组展开内容会随来源不同而变化。
  const visibleCuaEvents = useMemo(
    () =>
      item.events.filter(
        (event) =>
          event.kind !== "reasoning" || isConversationReasoningRowVisible(event.row.rowId, context),
      ),
    [context, item.events],
  );
  return (
    <div
      data-row-id={item.rowId}
      data-conversation-selectable="true"
      data-testid={testId(TID_V4_ROW, String(item.rowId))}
    >
      <ToolCallBlock
        toolCallNode={item.node}
        workspacePath={context.workspacePath}
        theme={context.theme}
        codePreviewSettings={context.codePreviewSettings}
        showTodoToolCalls={context.messageStreamShowTodos === true}
        onOpenCodeViewer={context.onOpenCodeViewer}
        onOpenFileLink={context.onOpenFileLink}
        onOpenBrowserUrl={context.onOpenBrowserUrl}
        onOpenAutomationsMain={context.onOpenAutomationsMain}
        cuaGroupEvents={visibleCuaEvents}
        renderCuaAssistantMessage={renderAssistantMessage}
        renderCuaReasoning={renderReasoning}
      />
    </div>
  );
}

function ConversationAssistantWorkItems({
  rows,
  context,
  stageTailIsRunning = false,
  assistantCodeCommentProjectionEnabled = false,
  historyContainer,
}: {
  rows: readonly AssistantWorkRow[];
  context: ConversationRowRenderContext;
  stageTailIsRunning?: boolean;
  /** running turn 的正文可能暂时落在 history renderer，仍需隐藏特化协议原文。 */
  assistantCodeCommentProjectionEnabled?: boolean;
  // [事务] historyContainer 是三态字段：undefined = 不在折叠区（裸内容）、
  // 有值 = 由外层 Collapsible 包裹。它决定是否创建 CollapsibleContent 外壳（INV-32）。
  historyContainer?: {
    chunkKey: string;
    open: boolean;
  };
}) {
  const showReasoning = context.messageStreamShowReasoning === true;
  // [事务] firstReasoningRowId 只影响“本轮第一个思考块是否显示标题栏”，
  // 因此作为独立入参下沉；把它塞进 rows 会让工具项的 memo 依赖无谓变化。
  const firstReasoningRowId = context.messageStreamFirstReasoningRowId;
  // [事务] 分组投影是纯函数，输入是 (rows, 显示选项, 分组开关)。依赖数组必须
  // 逐项列出开关而不是整个 context——context 每次换引用会让所有轮重算分组（INV-33）。
  const items = useMemo(
    () =>
      buildAssistantWorkRenderItems(
        rows,
        {
          messageStreamShowReasoning: showReasoning,
          ...(firstReasoningRowId !== undefined
            ? { messageStreamFirstReasoningRowId: firstReasoningRowId }
            : {}),
        },
        {
          // [事务] 两个分组开关来自模块级特性常量：做成常量而不是 props，
          // 是为了让“同一版本内所有轮分组规则一致”，避免同一屏里新旧规则混用。
          stageTailIsRunning,
          enableCuaGrouping: ENABLE_CUA_TOOL_CALL_GROUPING,
          enableExploreGrouping:
            context.toolGroupingExploreEnabled ?? ENABLE_EXPLORE_TOOL_CALL_GROUPING,
          enableTerminalGrouping:
            context.toolGroupingTerminalEnabled ?? ENABLE_TERMINAL_TOOL_CALL_GROUPING,
          enableChangesGrouping:
            context.toolGroupingChangesEnabled ?? ENABLE_CHANGES_TOOL_CALL_GROUPING,
        },
      ),
    [
      context.toolGroupingChangesEnabled,
      context.toolGroupingExploreEnabled,
      context.toolGroupingTerminalEnabled,
      stageTailIsRunning,
      firstReasoningRowId,
      rows,
      showReasoning,
    ],
  );

  // history 外壳不能在这层投影前创建：当 CUA 消费原 message
  // 或运行中 shell 被延迟分类时，会留下 pt-5 和空的 gap-4 容器。只有确认
  // 内层存在可渲染项后才创建 CollapsibleContent，让外壳与内容一起消失。
  // [失败路径] items 为空必须返回 null（INV-32）：history 外壳（pt-5 + gap-4）
  // 只有在确认内层有可渲染项之后才创建，否则会留下一个纯空白容器。
  if (items.length === 0) {
    return null;
  }

  // 连续工作项（工具/explore/reasoning）统一 gap-4 组容器（对齐旧版 tool-call-group），
  // 取代继承父级 gap-5/gap-2 + 每行 py-2 的双重且不一致的间距。
  // [事务] 列表项的 key 用 item.key 而不是下标（INV-17）：分组项会随工具状态
  // 在 row / group 之间切换，用下标会让相邻项复用错 DOM，展开态与滚动位置错位。
  const content = (
    <div className="flex flex-col gap-4">
      {items.map((item) =>
        item.kind === "row" ? (
          <ConversationTurnRow
            key={item.key}
            row={item.row}
            context={context}
            hideAssistantActions={item.row.kind === "assistantText"}
            assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
          />
        ) : item.kind === "agentToolCall" ? (
          <ConversationAgentToolCallRow key={item.key} item={item} context={context} />
        ) : item.kind === "exploreGroup" ? (
          <ConversationExploreGroupRow key={item.key} item={item} context={context} />
        ) : (
          <ConversationToolGroupRow key={item.key} item={item} context={context} />
        ),
      )}
    </div>
  );

  // [失败路径] 非 history 调用方直接拿裸 content：history 外壳（CollapsibleContent）
  // 是“可选包裹”，让同一份内容既能嵌进折叠区、也能作为普通段落渲染。
  if (!historyContainer) {
    return content;
  }

  // [事务] data-history-open 必须显式写成字符串：Radix 的折叠动画依赖它判断
  // 本轮是“展开中”还是“收起中”，缺失会让首帧高度测量为 0、动画从 0 弹出。
  return (
    <CollapsibleContent
      data-testid={testId(TID_CHAT_ASSISTANT_HISTORY_CONTENT, historyContainer.chunkKey)}
      data-history-open={String(historyContainer.open)}
    >
      <div className="pt-5">{content}</div>
    </CollapsibleContent>
  );
}

// [事务] 这是 Cron 卡片的收集器，语义是“按发生顺序回放并允许撤销”（INV-18/19）：
// 不是简单 filter，因为 CronDelete 必须把之前收集的同 id 卡片删掉。
// 只认 status==="success"：失败/取消的创建不应出现在轮尾摘要里。
function resolveCronAutomationTurnCards(
  rows: readonly AssistantWorkRow[],
): CronAutomationTurnCard[] {
  let cards: CronAutomationTurnCard[] = [];

  for (const row of rows) {
    if (row.kind !== "toolCall" || row.status !== "success") {
      continue;
    }

    // [事务] 工具名先归一化再比较：CLI 侧可能给出 CronDelete / cron_delete / CRON-DELETE，
    // 统一去非字母数字并小写后才等价。直接比较字符串会漏掉大小写与分隔符变体。
    const normalizedToolName = row.toolName.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (normalizedToolName === "crondelete") {
      const deletedAutomationId = readCronDeleteAutomationId(row);
      if (deletedAutomationId) {
        // [失败路径] 这里必须 continue 而不是 fallthrough：删除行不是创建行，
        // 落到下面的 isCronAutomationCardToolCall 判定里可能被误读成一张卡。
        // 只累计本轮成功的 Create/Update 会忽略后续 CronDelete，导致已经
        // 撤销的中间结果仍被提升成轮尾成功卡片。
        cards = cards.filter((card) => card.automation.automationId !== deletedAutomationId);
      }
      continue;
    }

    const node = toolCallRowToLegacyNode(row);
    if (!isCronAutomationCardToolCall(node.toolCall)) {
      continue;
    }

    const automation = readCronCreateAutomationSummary(node.toolCall);
    if (!automation) {
      continue;
    }

    if (automation.automationId) {
      // [事务] 同 id 先删后加，保证“后者覆盖前者”：本轮 Create 后又 Update 时，
      // 轮尾只应剩更新后的那一张，而不是两张同名卡片。
      cards = cards.filter((card) => card.automation.automationId !== automation.automationId);
    }
    cards.push({
      rowId: row.rowId,
      toolCallId: row.toolCallId,
      automation,
    });
  }

  return cards;
}

// 只收本轮 status==="success" 的 OffPeakCreate；同 id 重复输出保留最新一次。
// 刻意不复用 resolveCronAutomationTurnCards——那套带 CronDelete 撤销过滤语义，闲时无对应工具。
function resolveOffPeakTurnCards(rows: readonly AssistantWorkRow[]): OffPeakTurnCard[] {
  let cards: OffPeakTurnCard[] = [];

  for (const row of rows) {
    if (row.kind !== "toolCall" || row.status !== "success") {
      continue;
    }
    const node = toolCallRowToLegacyNode(row);
    if (!isOffPeakCreateToolCall(node.toolCall)) {
      continue;
    }
    const task = readOffPeakCreateTaskSummary(node.toolCall);
    if (!task) {
      continue;
    }
    if (task.offPeakTaskId) {
      cards = cards.filter((card) => card.task.offPeakTaskId !== task.offPeakTaskId);
    }
    cards.push({
      rowId: row.rowId,
      toolCallId: row.toolCallId,
      task,
    });
  }

  return cards;
}

// [失败路径] 解析失败一律返回 null 而不是抛错：工具载荷是外部输入（模型生成），
// 非法 JSON 非常常见；抛错会让整轮渲染降级，而正确做法是“这张卡不显示”。
// [事务] 只接受“非数组的普通对象”：数组也满足 typeof === "object"，若不排除，
// 下游按 key 读字段会全部得到 undefined，卡片静默变空白。
function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
}

// [事务] 三个候选字段按“输出 → 原始输入对象 → 原始输入文本”顺序回退：
// 不同版本的工具把 id 放在不同位置，任一命中即可；顺序即优先级，
// 输出里的 id 最可信（它是真正生效的那一次）。
function readCronDeleteAutomationId(
  row: Extract<AssistantWorkRow, { kind: "toolCall" }>,
): string | undefined {
  for (const candidate of [row.output?.text, row.input, row.inputText]) {
    // [事务] 只认非空字符串 id：数字 id 在 JSON 里会被解析成 number，若直接返回
    // 会与自动化的 string id 比较失败，撤销悄悄不生效。
    const record = parseJsonRecord(candidate);
    const id = record?.id;
    if (typeof id === "string" && id.trim()) {
      return id.trim();
    }
  }
  return undefined;
}

function CronAutomationTurnCards({
  cards,
  context,
}: {
  cards: readonly CronAutomationTurnCard[];
  context: ConversationRowRenderContext;
}) {
  // [失败路径] 空数组必须整块返回 null：Cron 卡与 OffPeak 卡共享 gap-3 容器，
  // 留一个空容器会在轮尾多出 12px，且在轮与轮之间表现为“偶发多一条缝”（同类见 INV-9）。
  if (cards.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      {cards.map((card) => (
        // [事务] key 用 rowId:toolCallId 复合（INV-20）：同一工具在本轮被多次调用时
        // 只有 rowId 会不同；只用 toolCallId 会让两张卡被 React 视为同一张。
        <CronCreateAutomationCard
          key={`${card.rowId}:${card.toolCallId}`}
          automation={card.automation}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
        />
      ))}
    </div>
  );
}

function OffPeakTurnCards({
  cards,
  context,
}: {
  cards: readonly OffPeakTurnCard[];
  context: ConversationRowRenderContext;
}) {
  if (cards.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      {cards.map((card) => (
        // [事务] 与 Cron 卡同一套 key 规则（INV-20）：复合键保证多次调用不会互相覆盖，
        // 也保证卡片在列表增删时不会被错误复用。
        <OffPeakCreateTaskCard
          key={`${card.rowId}:${card.toolCallId}`}
          task={card.task}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
        />
      ))}
    </div>
  );
}

// [事务] 标题组件只读 workStatus / highspeed / sourceCommandIds，不读 flowItems：
// 标题的稳定性与正文无关，解耦之后流式 delta 不会触发标题重算，也不会让
// CollapsibleTrigger 在每次 delta 上重新绑定事件。
function AssistantHistoryStatus({
  segment,
  open,
  highspeed,
  highspeedMeta,
  sourceCommandIds,
}: {
  segment: ConversationTurnWorkSegment;
  open: boolean;
  highspeed: boolean;
  highspeedMeta?: HighspeedMessageMeta;
  sourceCommandIds: readonly string[];
}) {
  const { intl, locale } = useZCodeIntl();
  const topicInterrupted = useBotTopicInterruption(sourceCommandIds);
  // [事务] 耗时标签只从 workStatus.durationMs 派生：没有它时必须走“已工作”兜底文案，
  // 而不是显示 0 秒——0 秒会被用户理解为“什么都没做”。
  const durationLabel = formatConversationWorkDuration(
    segment.workStatus?.durationMs,
    intl,
    locale,
  );
  const savedDurationLabel =
    segment.workStatus?.state === "completed" &&
    // [权衡] 只有 completed 才计算“节省时长”：运行中的数字还在变，
    // 显示出来会随每次渲染跳动；interrupted 的对比也没有意义。
    highspeedMeta?.savedDurationMs !== undefined &&
    highspeedMeta.savedDurationMs > 0
      ? formatConversationWorkDuration(highspeedMeta.savedDurationMs, intl, locale)
      : null;
  // [事务] 四个分支严格互斥且按“中断 → 运行 → 有耗时 → 无耗时”排列（INV-31）：
  // 顺序即优先级，中断必须压过运行（停止事件可能晚于最后一次 projection），
  // 而“无耗时”必须兜底，否则老 transcript 的段落会显示空白标题。
  const label =
    segment.workStatus?.state === "interrupted"
      ? intl.formatMessage({
          id: topicInterrupted ? "chat.history.topicInterrupted" : "chat.history.stopped",
        })
      : segment.workStatus?.state === "running"
        ? intl.formatMessage({ id: "chat.history.workingFor" }, { duration: durationLabel ?? "" })
        : durationLabel
          ? intl.formatMessage({ id: "chat.history.workedFor" }, { duration: durationLabel })
          : intl.formatMessage({ id: "chat.history.worked" });

  // [事务] 整个标题是 CollapsibleTrigger 的子节点：点击区域必须覆盖整行，
  // 但 highspeed 徽标区（右侧）要留在触发器之外，否则点“已加速”标签也会折叠历史。
  return (
    <div
      className={cn(
        "flex w-full flex-wrap items-center justify-between gap-2 border-b",
        highspeed ? "border-icon-purple/30 pb-3 pl-1" : "border-[var(--color-border)]/50 pb-2",
      )}
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          // [事务] testId 后缀必须用 segment.key 而不是 chunk 序号：折叠标题每段只有一个，
          // 用序号会让“第几块”随渲染顺序变化，e2e 无法稳定定位。
          data-testid={testId(TID_CHAT_ASSISTANT_HISTORY_TRIGGER, segment.key)}
          // [事务] data-history-open 与 Receipt 同源同值：样式与测试都读它，
          // 若与 Collapsible 的 open 不同步，会出现“图标已转但内容未展开”。
          data-history-open={String(open)}
          className="group/history-message inline-flex max-w-full items-center gap-2 text-left text-ui-base text-foreground-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
        >
          <span
            className={cn("truncate", highspeed && "font-medium leading-5 text-icon-purple")}
            data-highspeed-duration={highspeed ? "true" : undefined}
          >
            {label}
          </span>
          {!segment.assistantHistoryDefaultOpen ? (
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-[var(--color-foreground-subtlest)] opacity-70 transition-transform",
                open ? "rotate-90" : "rotate-0",
              )}
            />
          ) : null}
        </button>
      </CollapsibleTrigger>
      {highspeed ? (
        <div className="ml-auto flex shrink-0 items-center gap-2 text-icon-purple">
          {savedDurationLabel ? (
            <span className="text-ui-sm font-medium leading-4" data-highspeed-saved-duration="true">
              {intl.formatMessage(
                { id: "chat.highspeed.savedDuration" },
                { duration: savedDurationLabel },
              )}
            </span>
          ) : null}
          <span
            className="rounded-full bg-hover px-2 py-0.5 text-ui-sm leading-4"
            data-highspeed-status-tag="true"
          >
            {intl.formatMessage({ id: "chat.highspeed.statusTag" })}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function ConversationWorkSegmentFlow({
  segment,
  sourceCommandIds,
  context,
  onFork,
  onRetry,
  onEdit,
  editWorkspaceRewindAvailability,
  assistantCopyText,
  assistantPreviewCards,
  assistantPreviewCardsAutoOpenKey,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  canForkLatestAssistant,
  canRetryLatestAssistant,
  highspeed,
  highspeedMeta,
}: {
  segment: ConversationTurnWorkSegment;
  sourceCommandIds: readonly string[];
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onEdit?: ConversationTurnGroupProps["onEdit"];
  editWorkspaceRewindAvailability: EditWorkspaceRewindAvailability;
  assistantCopyText?: string;
  assistantPreviewCards: AssistantPreviewCard[];
  assistantPreviewCardsAutoOpenKey?: string;
  assistantCodeCommentCards: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled: boolean;
  canForkLatestAssistant: boolean;
  canRetryLatestAssistant: boolean;
  highspeed: boolean;
  highspeedMeta?: HighspeedMessageMeta;
}) {
  // [事务] 折叠态是“本段自己持有”的受控 state（INV-3/6/7）：初值取默认展开，
  // 并在 (默认值, key) 变化时重置。没有这个 effect，复用的组件实例会把上一段的
  // 展开状态带过来——而 key 变化时 React 通常会重建，这条 effect 是兜底。
  const [historyOpen, setHistoryOpen] = useState(segment.assistantHistoryDefaultOpen);
  useEffect(() => {
    setHistoryOpen(segment.assistantHistoryDefaultOpen);
  }, [segment.assistantHistoryDefaultOpen, segment.key]);

  // [失败路径] shouldShowHistoryStatus 只看 workStatus 是否存在：没有工时的段落
  // 不该画标题行，否则会出现“已工作”配 0 秒的伪状态。
  const shouldShowHistoryStatus = segment.workStatus !== undefined;
  // [事务] 标题行插在“第一个非 userInput 块”之前：用户气泡必须留在折叠标题之上，
  // 否则折叠会把提问也一起藏起来，用户看不到自己说了什么。
  const firstAssistantFlowItemIndex = segment.flowItems.findIndex(
    (item) => item.kind !== "userInput",
  );
  // [资源] historyChunkIndex 是渲染期局部计数器，不能提到组件外：每段渲染都要
  // 从 0 开始分配 chunk 序号，跨段累计会让 testId 与 chunkKey 变得不可预测。
  let historyChunkIndex = 0;
  // [事务] 默认展开时 open 恒为 true 且不接收 onOpenChange（INV-6）：
  // 双保险写法，即使上游误传了 handler，这里也不会让用户收起当前段。
  const open = segment.assistantHistoryDefaultOpen ? true : historyOpen;

  return (
    <Collapsible
      // [事务] open 与 onOpenChange 必须成对推导（INV-6）：默认展开时段落永远打开，
      // 且没有回调，因此不存在“受控但可被外部改”的中间态。
      open={open}
      onOpenChange={segment.assistantHistoryDefaultOpen ? undefined : setHistoryOpen}
      // 外层 flex gap 不属于 Radix 测量的 content 高度，收起到 0 后会在
      // display:none 的最后一帧再少 20px。普通兄弟用外边距保持原盒模型，history
      // 的间距则放进动画层。
      className="history-message flex flex-col [&>*+*:not([data-slot='collapsible-content'])]:mt-5"
    >
      {segment.flowItems.map((item, index) => {
        // [事务] stageTailIsRunning 的三个条件缺一不可（INV-8）：运行态 + 最后一项 +
        // 该项是 history/work 块。只看运行态会让所有历史段落都进入“流式尾块”路径，
        // 表现为旧的工具卡被当成正在输出而抖动。
        const stageTailIsRunning =
          segment.workStatus?.state === "running" &&
          index === segment.flowItems.length - 1 &&
          (item.kind === "assistantHistory" || item.kind === "assistantWork");
        // [事务] 标题行只插一次，且必须插在第一个非用户块之前（见上方 findIndex 注释）：
        // 用 index 相等而不是“渲染后判断”，保证折叠标题与正文的相对顺序恒定。
        const showHistoryStatus = shouldShowHistoryStatus && index === firstAssistantFlowItemIndex;
        // [失败路径] 多行块回退到下标只是在“没有 rowId”时的最后手段（INV-17）：
        // 它不稳定，但比丢项或抛错更好；单行块必须用 rowId，避免插入项时错位复用。
        const itemKey =
          item.kind === "userInput" || item.kind === "assistantText"
            ? `${item.kind}:${item.row.rowId}`
            : `${item.kind}:${item.rows[0]?.rowId ?? index}`;
        let content: React.ReactNode;

        if (item.kind === "userInput") {
          // [失败路径] onEdit 只在 canEdit 明确为 true 时透传：传一个总是被调用的
          // handler 会让不可编辑消息也显示编辑按钮，点击后命令静默失败。
          const userRow = (
            <ConversationTurnRow
              row={item.row}
              context={context}
              onEdit={item.row.actions?.canEdit === true ? onEdit : undefined}
              editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
            />
          );
          content = userRow;
        } else if (item.kind === "cuaGroup") {
          const group = <ConversationCuaGroupRow item={item} context={context} />;
          if (item.flowKind === "assistantHistory") {
            // [事务] chunkKey 的首块固定等于 segment.key（INV-5），后续才追加序号：
            // 首块是最常被测试与外部定位的一块，改动命名会破坏既有断言。
            const chunkKey =
              historyChunkIndex === 0 ? segment.key : `${segment.key}:chunk-${historyChunkIndex}`;
            historyChunkIndex += 1;
            content = (
              <CollapsibleContent
                data-testid={testId(TID_CHAT_ASSISTANT_HISTORY_CONTENT, chunkKey)}
                data-history-open={String(open)}
              >
                <div className="pt-5">{group}</div>
              </CollapsibleContent>
            );
          } else {
            content = group;
          }
        } else if (item.kind === "assistantHistory") {
          const chunkKey =
            historyChunkIndex === 0 ? segment.key : `${segment.key}:chunk-${historyChunkIndex}`;
          historyChunkIndex += 1;
          content = (
            <ConversationAssistantWorkItems
              rows={item.rows}
              context={context}
              stageTailIsRunning={stageTailIsRunning}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
              historyContainer={{ chunkKey, open }}
            />
          );
        } else if (item.kind === "assistantText") {
          // [事务] latest 是“这一轮最后一段正文”的标记，它同时决定四件事：
          // fork/retry 可用性、隐藏操作栏、延迟出现操作栏、复制文本与卡片来源
          // （INV-27/28）。任何一项漏判都会让历史段落长出可点的重试按钮。
          content = (
            <ConversationTurnRow
              row={item.row}
              context={context}
              onFork={item.latest && canForkLatestAssistant ? onFork : undefined}
              onRetry={item.latest && canRetryLatestAssistant ? onRetry : undefined}
              hideAssistantActions={!item.latest}
              deferAssistantActions={item.latest}
              assistantCopyText={item.latest ? assistantCopyText : undefined}
              assistantPreviewCards={item.latest ? assistantPreviewCards : undefined}
              assistantPreviewCardsAutoOpenKey={
                item.latest ? assistantPreviewCardsAutoOpenKey : undefined
              }
              assistantCodeCommentCards={item.latest ? assistantCodeCommentCards : undefined}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          );
        } else {
          content = (
            <ConversationAssistantWorkItems
              rows={item.rows}
              context={context}
              stageTailIsRunning={stageTailIsRunning}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          );
        }

        return (
          // [事务] Fragment 带 key 而不是把 key 放在 content 上：同一个 item 可能
          // 额外渲染一个标题行，二者必须属于同一个 keyed 单元，否则插入标题时
          // React 会认为列表长度变了，导致后续项全部重挂载。
          <Fragment key={itemKey}>
            {showHistoryStatus ? (
              <AssistantHistoryStatus
                segment={segment}
                open={open}
                highspeed={highspeed}
                highspeedMeta={highspeedMeta}
                sourceCommandIds={sourceCommandIds}
              />
            ) : null}
            {content}
          </Fragment>
        );
      })}
      {shouldShowHistoryStatus && firstAssistantFlowItemIndex < 0 ? (
        <AssistantHistoryStatus
          segment={segment}
          sourceCommandIds={sourceCommandIds}
          open={open}
          highspeed={highspeed}
          highspeedMeta={highspeedMeta}
        />
      ) : null}
    </Collapsible>
  );
}

function ConversationTurnFlow({
  unit,
  apiRetry,
  context,
  onFork,
  onRetry,
  onEdit,
  editWorkspaceRewindAvailability,
  assistantCopyText,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  assistantPreviewCardsAutoOpenKey,
  highspeed,
  highspeedMeta,
}: {
  // [事务] apiRetry 是非可选但可为 null：null 表示“这一轮没有进行中的重试”，
  // 与“调用方忘了传”区分开；可选字段会让两种语义在类型上混为一谈（INV-29）。
  unit: ConversationTurnRenderUnit;
  apiRetry: ApiRetryState | null;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onEdit?: ConversationTurnGroupProps["onEdit"];
  editWorkspaceRewindAvailability: EditWorkspaceRewindAvailability;
  assistantCopyText?: string;
  assistantCodeCommentCards: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled: boolean;
  assistantPreviewCardsAutoOpenKey?: string;
  highspeed: boolean;
  highspeedMeta?: HighspeedMessageMeta;
}) {
  // 产品语义：可见正文或工具不代表主轮已经结束；ChatLoading 跟随最后一轮
  // running 生命周期，但等待用户回答/授权时由交互 UI 独占进度反馈。
  // [失败路径] showLoading 必须由“是否最后一轮 + 是否运行 + 是否被交互/活跃工作阻塞”
  // 共同决定：单看 isRunning 会让等待用户授权的那一轮同时出现加载气泡与授权卡，
  // 用户以为 AI 还在算，其实在等自己点确认。
  const showLoading = shouldShowTurnChatLoading({
    blockedByActiveWork: context.chatLoadingBlockedByActiveWork === true,
    blockedByInteraction: context.chatLoadingBlockedByInteraction === true,
    isLastTurn: unit.isLastTurn,
    isRunning: unit.isRunning,
    rows: unit.assistantWorkRows,
  });
  // [资源] 预览卡片（截图/产物）只在最新正文行上拉取：给历史段落也算一遍
  // 会触发 N 次文件变更请求，而历史内容不参与“本轮产物”语义（INV-27）。
  const assistantPreviewCards = useAssistantPreviewCardsForAssistantTextRow({
    row: unit.latestAssistantTextRow,
    assistantTextRows: unit.assistantTextRows,
    latestAssistantTextRow: unit.latestAssistantTextRow,
    workspacePath: context.workspacePath,
    workspaceHomePath: context.workspaceHomePath,
    compactForRemoteControl: context.compactForRemoteControl,
    fileChangesTarget: unit.header?.entityId
      ? { rowId: unit.header.rowId, entityId: unit.header.entityId }
      : null,
    fileChangesState: unit.header?.fileChanges?.state,
    fetchFileChanges: context.fetchFileChanges,
  });

  if (unit.timelineOnly) {
    // [事务] timelineOnly 分支必须在 work segment 归一之前返回（INV-10）：
    // 这类轮没有用户气泡也没有正文段，走下面的折叠逻辑会创建空壳与多余标题。
    // 注意仍然渲染 loading slot，否则 /compact 这类长任务看起来像卡死了。
    // [失败路径] loading slot 必须保留在 timelineOnly 分支内：维护轮往往没有正文，
    // 没有它就只剩一个静止的工具列表，用户无法判断任务是否还在推进。
    return (
      <div className="flex flex-col gap-2">
        <ConversationAssistantWorkItems
          rows={unit.assistantWorkRows}
          context={context}
          // [事务] 维护轮的 running 态直接透传（INV-8）：这里没有后续段落可分，
          // 因此“最后一项即尾块”天然成立，不需要再算 index。
          stageTailIsRunning={unit.isRunning}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
        <TurnChatLoadingSlot apiRetry={apiRetry} eligible={showLoading} />
      </div>
    );
  }

  // [事务] 这段归一化是“新旧 render unit 的兼容层”，三种输入都要产出同一种
  // 段落列表：0 段（旧调用方只给 flowItems）→ 包成一段；1 段 → 用 unit 的
  // assistantHistoryDefaultOpen 覆盖（旧调用方会直接覆写该字段）；多段 → 原样透传
  // （INV-3：多段必须各自持有折叠态，不能被统一覆盖）。
  const projectedWorkSegments = unit.workSegments ?? [];
  // [事务] 单段覆盖只发生在 projectedWorkSegments.length === 1 的分支上：
  // 多段时必须原样透传，否则所有段共享同一个展开态（INV-3 的具体实现点）。
  const workSegments: ConversationTurnWorkSegment[] =
    projectedWorkSegments.length > 0
      ? projectedWorkSegments.length === 1
        ? [
            {
              ...projectedWorkSegments[0]!,
              // 兼容仍直接构造/覆写旧 render unit 的调用方；真实 guide 多段不走这个分支。
              assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
            },
          ]
        : projectedWorkSegments
      : [
          {
            // [事务] 旧调用方没有 workSegments 时用 unit.key 兜底（INV-4）：
            // 它是轮级唯一标识，同一轮多次渲染保持稳定，折叠态不会丢。
            key: unit.key,
            flowItems: unit.flowItems,
            assistantWorkRows: unit.assistantWorkRows,
            assistantHistoryRows: unit.assistantHistoryRows,
            assistantFollowingRows: unit.assistantFollowingRows,
            assistantHistoryDefaultOpen: unit.assistantHistoryDefaultOpen,
            ...(unit.workStatus ? { workStatus: unit.workStatus } : {}),
          },
        ];
  // [失败路径] 空轮判定必须同时看“所有段都没有 flowItems 且没有 workStatus”与
  // “没有 loading slot”（INV-9）：漏掉后者会让“刚开始运行、正文还没到”的这一轮
  // 直接消失，用户点发送后界面毫无反应。
  if (
    workSegments.every(
      (segment) => segment.flowItems.length === 0 && segment.workStatus === undefined,
    ) &&
    !showLoading
  ) {
    return null;
  }

  const latestAssistantTextRow = unit.latestAssistantTextRow;
  // [事务] canRetry / canFork 必须取“最新正文行”的 actions，而不是 unit 级开关：
  // 重新生成与分叉在语义上都以最后一段回答为起点（INV-27）。
  const canRetryLatestAssistant = latestAssistantTextRow?.actions?.canRetry === true;
  const canForkLatestAssistant = latestAssistantTextRow?.actions?.canFork === true;

  // 即使恢复了 guide 的 row 全序，也不能让所有 history chunk 共享同一个
  // Collapsible。accepted guide 现在由 CLI workSegments 定界，每段组件自行维护折叠状态。
  return (
    // [事务] 段间间距用 gap-5 而不是给每段加 margin：Collapsible 收起时高度可为 0，
    // margin 会与外层 gap 叠加，收起后残留一条固定的缝（见上方 history 的同类注释）。
    <div className="flex flex-col gap-5">
      {workSegments.map((segment) => (
        // [事务] key 用 segment.key（INV-4）：它是 CLI 给出的稳定段标识，
        // 用下标会让“插入新段”把后续所有段的折叠态整体错位一位。
        <ConversationWorkSegmentFlow
          key={segment.key}
          segment={segment}
          // [事务] sourceCommandIds 是“轮内用户指令 + 首段的 header 指令”的并集：
          // header 的 sourceCommandId 只属于第一段，若每段都带上，中断判定会
          // 把后续段落也标记成“话题被中断”（INV-31）。
          sourceCommandIds={[
            ...segment.flowItems.flatMap((item) =>
              item.kind === "userInput" && item.row.sourceCommandId
                ? [item.row.sourceCommandId]
                : [],
            ),
            ...(segment === workSegments[0] && unit.header?.sourceCommandId
              ? [unit.header.sourceCommandId]
              : []),
          ]}
          context={context}
          onFork={onFork}
          onRetry={onRetry}
          onEdit={onEdit}
          editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
          assistantCopyText={assistantCopyText}
          assistantPreviewCards={assistantPreviewCards}
          assistantPreviewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          assistantCodeCommentCards={assistantCodeCommentCards}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
          canForkLatestAssistant={canForkLatestAssistant}
          canRetryLatestAssistant={canRetryLatestAssistant}
          highspeed={highspeed}
          highspeedMeta={highspeedMeta}
        />
      ))}
      <TurnChatLoadingSlot apiRetry={apiRetry} eligible={showLoading} />
    </div>
  );
}

/**
 * 能撑起「后台结果头」这套渲染的来源白名单。
 *
 * 这里刻意仍是白名单而不是直接信任 schema：`originMeta` 在 userInputRow 上是 optional，
 * 跨版本仍可能出现第四个取值，而没见过的来源拿不到合适的标题语义，退回普通 assistant
 * 分支比谎报一个标题好。
 *
 * workflow run 的 `backgroundSource` 是 `"workflow"`（CLI 侧
 * `background-tasks.ts` 在 CreateWorkflow 终态上报，title 由 `workflowTaskSubject` 铸造），
 * 原本落在白名单外，于是一条 run 跑完之后那一轮**既没有标题、也退化成按工时折叠的普通
 * assistant 段落**——后台结果分组整个消失。标题不需要本地化：它由 CLI 权威给出，
 * bash / subagent 同样直接透传。
 */
// [事务] 白名单必须是只读 Set 且模块级：它在每次渲染的 resolveBackgroundResultTitle
// 里被查询，内联 new Set 会为每条后台结果重建一次集合。只读约束则防止运行时被改。
const BACKGROUND_RESULT_TITLE_SOURCES: ReadonlySet<string> = new Set([
  "bash",
  "subagent",
  "workflow",
]);

function resolveBackgroundResultTitle(unit: ConversationTurnRenderUnit): string | undefined {
  // [失败路径] 三个早退条件顺序固定：origin 不是 backgroundResult 直接出局（普通轮
  // 不该有后台标题）；workId/title 任一为空则没有可展示的语义；来源不在白名单
  // 则宁可退回普通 assistant 分支（INV-12），也不能编一个标题。
  if (unit.header?.origin !== "backgroundResult") return undefined;
  const originMeta = unit.header.originMeta;
  if (!originMeta?.workId.trim() || !originMeta.title.trim()) return undefined;
  if (!BACKGROUND_RESULT_TITLE_SOURCES.has(originMeta.backgroundSource)) {
    return undefined;
  }
  return originMeta.title.trim();
}

/**
 * 该轮是否以 workflow 通知卡（ToolLayout 行）开头。
 *
 * 用于两处：`ConversationBackgroundResultWork` 决定渲染通知行还是裸标题行；轮容器决定是否
 * 去掉轮顶 `pt-14`。后台结果轮没有可见的 user 行，通知卡就是轮内第一个节点——若照常保留
 * 轮顶 padding，卡片上方会叠出 56px + 上一轮 pb-5 共约 76px 的空白，用户判为多余。
 */
function resolveWorkflowNotification(
  unit: ConversationTurnRenderUnit,
): WorkflowRowNotification | undefined {
  // [事务] 这里与 resolveBackgroundResultTitle 必须同源判断 origin：两处若不一致，
  // 会出现“有标题但无通知行”或反之，轮顶 padding 与首节点假定随之错位（INV-13）。
  if (unit.header?.origin !== "backgroundResult") return undefined;
  return workflowRowNotification(unit.header.originMeta);
}

function ConversationBackgroundResultWork({
  unit,
  apiRetry,
  context,
  onFork,
  onRetry,
  title,
  assistantCopyText,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  assistantPreviewCardsAutoOpenKey,
}: {
  // [事务] title 是必填字符串而不是可选：调用方必须先通过 resolveBackgroundResultTitle
  // 判定“确实是后台结果轮”，才允许挂载本组件；把判定下放会催生第二套逻辑（INV-12）。
  unit: ConversationTurnRenderUnit;
  apiRetry: ApiRetryState | null;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  title: string;
  assistantCopyText?: string;
  assistantCodeCommentCards: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled: boolean;
  assistantPreviewCardsAutoOpenKey?: string;
}) {
  // [事务] 后台结果轮的三个区段（history / latest / following）必须按序渲染且
  // 各自可空（INV-11）：它们的语义是“唤醒前的工具 → 总结正文 → 总结后追加的调用”，
  // 合并成一段会破坏时间序，历史里的工具会跑到总结之后。
  const hasHistory = unit.assistantHistoryRows.length > 0;
  const hasFollowing = unit.assistantFollowingRows.length > 0;
  // [事务] loading slot 在这里复用同一套判定（INV-11）：后台结果轮同样可能是最后一轮，
  // 若不复用，唤醒后仍在跑的 run 会显示成一个静止的总结。
  const showLoading = shouldShowTurnChatLoading({
    blockedByActiveWork: context.chatLoadingBlockedByActiveWork === true,
    blockedByInteraction: context.chatLoadingBlockedByInteraction === true,
    isLastTurn: unit.isLastTurn,
    isRunning: unit.isRunning,
    rows: unit.assistantWorkRows,
  });
  const latestAssistantTextRow = unit.latestAssistantTextRow;
  const assistantPreviewCards = useAssistantPreviewCardsForAssistantTextRow({
    row: latestAssistantTextRow,
    assistantTextRows: unit.assistantTextRows,
    latestAssistantTextRow,
    workspacePath: context.workspacePath,
    workspaceHomePath: context.workspaceHomePath,
    compactForRemoteControl: context.compactForRemoteControl,
    fileChangesTarget: unit.header?.entityId
      ? { rowId: unit.header.rowId, entityId: unit.header.entityId }
      : null,
    fileChangesState: unit.header?.fileChanges?.state,
    fetchFileChanges: context.fetchFileChanges,
  });

  // 后台结果已经由独立唤醒轮总结过；复用普通 assistant 的工时折叠
  // 会显示不准确的分段耗时，并让一段短总结产生没有意义的收起状态。
  //
  // workflow run 的 workflow 通知带结构化载荷时改渲染既有工具卡语法的通知行（替换裸标题行）；
  // 载荷缺席（批量轮、旧 transcript、bash/subagent）→ 原样退回标题行。
  const workflowNotification = resolveWorkflowNotification(unit);
  const workflowRunId = unit.header?.originMeta?.workId;
  // 打开 run 详情：宿主注入 onOpenWorkflowRun + 联查到 toolCallId 才可点；冷恢复查不到时
  // 展开体内不渲染链接。toolCallId 走投影/journal 联查表，与 CreateWorkflow 工具卡同一条打开路径。
  const workflowRunSummary =
    workflowNotification && workflowRunId
      ? context.workflowRunByRunId?.get(workflowRunId)
      : undefined;
  // [失败路径] 三个条件必须同时成立才给出 openWorkflowRun（fail closed，INV-24）：
  // 特别是 toolCallId——冷恢复后联查表里可能没有它，此时给一个“可点但点了没反应”
  // 的链接，比不给链接更糟。
  const openWorkflowRun =
    workflowNotification &&
    workflowRunId &&
    context.onOpenWorkflowRun &&
    context.sessionId &&
    workflowRunSummary?.toolCallId
      ? () =>
          context.onOpenWorkflowRun?.({
            parentSessionId: context.sessionId!,
            toolCallId: workflowRunSummary.toolCallId!,
            runId: workflowRunId,
            workflowName: title,
          })
      : undefined;
  const workflowPendingQids =
    workflowNotification && workflowRunId
      ? context.workflowRunPendingQuestionsByRunId?.get(workflowRunId)
      : undefined;
  // 产物 chip → 全尺寸查看 tab。门比 `openWorkflowRun` 松一格：产物 tab 只需要
  // (parentSessionId, runId, artifactId)，**不需要** toolCallId——它不画因果图，也就不必
  // 回到那条 CreateWorkflow 工具行。冷恢复后联查不到 toolCallId 的通知行因此仍能开产物。
  // [事务] 产物 chip → 全尺寸查看 tab 的入口独立于 openWorkflowRun（INV-24）：
  // 它只需要 parentSessionId / runId / artifactId，因此门槛跟着真实依赖走。
  const openWorkflowArtifact =
    workflowNotification && workflowRunId && context.onOpenWorkflowArtifact && context.sessionId
      ? (artifactId: string) => {
          // 载荷里那一枚的 `contentType`（终态通知才有产物清单）：宿主据它决定 html 产物
          // 直接开浏览器 tab 还是开产物 tab，所以这里带得到就带上。载荷刻意不带 `sourcePath`
          // （状态帧体积），宿主缺席时自己查 journal 补。
          const contentType =
            workflowNotification.kind === "terminal"
              ? workflowNotification.artifacts?.find((candidate) => candidate.id === artifactId)
                  ?.contentType
              : undefined;
          context.onOpenWorkflowArtifact?.({
            parentSessionId: context.sessionId!,
            runId: workflowRunId,
            artifactId,
            ...(contentType === undefined ? {} : { contentType }),
          });
        }
      : undefined;

  return (
    <div className="flex flex-col gap-5">
      {workflowNotification ? (
        <WorkflowNotificationToolRow
          notification={workflowNotification}
          runName={title}
          testIdKey={unit.key}
          theme={context.theme}
          onOpenRun={openWorkflowRun}
          onOpenArtifact={openWorkflowArtifact}
          pendingQids={workflowPendingQids}
          // 留白行的三态（docs/dynamic-workflow/transcript-and-notifications.md「The hole row's live state」）：
          // run 在活投影里就递它的留白表（可能为空 = 已补全 / 没记录），不在场即 undefined → 中性词。
          holes={
            workflowRunSummary?.run === undefined ? undefined : (workflowRunSummary.run.holes ?? [])
          }
        />
      ) : (
        <div className="flex w-full border-b border-[var(--color-border)]/50 pb-2">
          <div
            data-testid={testId(TID_CHAT_BACKGROUND_RESULT_TITLE, unit.key)}
            className="min-w-0 whitespace-pre-wrap break-words text-left text-ui-base text-[var(--color-foreground-subtle)]"
          >
            {title}
          </div>
        </div>
      )}
      {hasHistory ? (
        <div className="flex flex-col gap-2">
          <ConversationAssistantWorkItems
            rows={unit.assistantHistoryRows}
            // [事务] 历史段用 gap-2 而不是段间 gap-5：后台唤醒前的工具与总结正文
            // 属于同一轮，过大间距会让它们看起来是两个独立的轮（INV-11）。
            context={context}
            assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
          />
        </div>
      ) : null}
      {latestAssistantTextRow ? (
        // [事务] key 用 rowId:entityId（INV-16）：重新生成会替换同一 rowId 下的实体，
        // 少了 entityId 就会复用旧 DOM，正文停留在上一次回答上。
        <ConversationTurnRow
          key={`${latestAssistantTextRow.rowId}:${latestAssistantTextRow.entityId ?? ""}`}
          row={latestAssistantTextRow}
          context={context}
          onFork={latestAssistantTextRow.actions?.canFork === true ? onFork : undefined}
          onRetry={latestAssistantTextRow.actions?.canRetry === true ? onRetry : undefined}
          deferAssistantActions
          assistantCopyText={assistantCopyText}
          assistantPreviewCards={assistantPreviewCards}
          assistantPreviewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          assistantCodeCommentCards={assistantCodeCommentCards}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      ) : null}
      {hasFollowing ? (
        <ConversationAssistantWorkItems
          rows={unit.assistantFollowingRows}
          context={context}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      ) : null}
      <TurnChatLoadingSlot apiRetry={apiRetry} eligible={showLoading} />
    </div>
  );
}

function ConversationTurnGroupImpl({
  unit,
  nowMs = Date.now(),
  apiRetry = null,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
}: ConversationTurnGroupProps) {
  const isOfficeMode = useIsOfficeMode();
  // [权衡] 办公模式只影响两处（隐藏 diff 摘要、强制换行），不改变分组规则：
  // 若按模式切换分组，同一段历史在切换模式后会重排，用户会丢掉阅读位置。
  const { intl } = useZCodeIntl();
  // [事务] visibleUserRows 必须是 unit 已裁剪后的结果（INV-35）：conversationTurnRenderUnits
  // 会把“写给模型的规范句”裁掉，这里若重新过滤原始行，会把那些句子放回界面。
  const visibleUserRows = useMemo(() => unit.visibleUserInputs, [unit.visibleUserInputs]);
  // [并发] 这行订阅只为了拿到“Highspeed 卡片表变过”的通知：快照是版本号而非对象，
  // 因此不会因为返回新引用而无限重渲染（INV-36）；它没有返回值，副作用在 store 内。
  useSyncExternalStore(subscribeHighspeedTurns, getHighspeedTurnVersion, getHighspeedTurnVersion);
  // [失败路径] header 上没有 sourceCommandId 时回退到第一条可见用户行：
  // 后台结果轮与直接启动轮没有 header 指令，但仍有用户行（可能是被裁剪前的最后一条）。
  const sourceCommandId = unit.header?.sourceCommandId ?? visibleUserRows[0]?.sourceCommandId;
  const highspeedTurn = getHighspeedTurnByCommandId(sourceCommandId);
  // [事务] 内存卡优先于行级标记的判断顺序不能倒：内存卡携带实时的 expiresAt 与
  // 指标，行级标记是冷恢复后的兜底，只用它会丢掉“是否已过期”的精度（INV-21/22）。
  // Bug 根因：历史标识过去只依赖 Renderer 内存；卡过期或冷恢复后记录不可用，
  // 即使 transcript 已持久化 highspeed metadata，也会把 accelerated output 渲染成普通工时。
  const isHighspeed = highspeedTurn !== null || visibleUserRows.some((row) => row.highspeed);
  // [失败路径] 初值用 -Infinity 而不是 0（INV-38）：没有任何加速卡时，
  // max 的结果仍是 -Infinity，`> nowMs` 恒假；若用 0，纪元级时间戳的卡
  // 会让“过期”判定在 1970 之后永远成立。
  const highspeedExpiresAt = Math.max(
    highspeedTurn?.card.expiresAt ?? Number.NEGATIVE_INFINITY,
    ...visibleUserRows.flatMap((row) => (row.highspeed ? [row.highspeed.expiresAt] : [])),
  );
  // Bug 根因：紫色流光过去只看“本轮曾使用 Highspeed”，卡过期后 metadata 仍会保留，
  // 导致 fallback 阶段仍在执行的 Tool 被永久染成紫色。运行态样式必须同时服从卡片有效期。
  const showHighspeedAnimatedGradient = isHighspeed && unit.isRunning && highspeedExpiresAt > nowMs;
  // 完成态统计即使因 replayable 事件先到，也必须等整轮停止生成后才能进入 UI。
  const highspeedMeta = unit.isRunning
    ? undefined
    : visibleUserRows.find((row) => row.highspeed)?.highspeed;
  // [事务] 这里的三段 if/else 是严格的优先级链，不是“尽力找数据”（INV-39/40）：
  // 第一段要求卡在内存且指标已持久化，第二段是上游显式指定的分享目标，
  // 第三段才是冷恢复后的 transcript 回填。任何一段提前命中都会让后面的更可信数据被忽略。
  const highspeedShareTarget = useMemo(() => {
    let target: { cardId: string; metrics: HighspeedShareMetrics } | null = null;
    if (
      highspeedTurn?.metrics &&
      highspeedTurn.metricsPersistedAt !== undefined &&
      highspeedTurn.metrics.regularTps > 0 &&
      highspeedTurn.metrics.highspeedTps !== undefined &&
      highspeedTurn.metrics.highspeedTps > 0
    ) {
      target = {
        cardId: highspeedTurn.card.cardId,
        metrics: aggregateHighspeedCardMetrics(highspeedTurn.card.cardId),
      };
    } else if (unit.highspeedOutputFooterTarget) {
      target = unit.highspeedOutputFooterTarget;
    } else if (
      highspeedMeta?.outputTokens !== undefined &&
      highspeedMeta.outputTokens > 0 &&
      highspeedMeta.highspeedTps !== undefined &&
      highspeedMeta.highspeedTps > 0 &&
      highspeedMeta.regularTps !== undefined &&
      highspeedMeta.regularTps > 0
    ) {
      // Bug 原因：冷恢复后 Renderer 内存记录为空，但 transcript 已持久化完整分享统计；
      // 只依赖 highspeedTurn 会让可见的历史分享按钮永久 disabled。
      target = {
        cardId: highspeedMeta.cardId,
        metrics: {
          outputTokens: highspeedMeta.outputTokens,
          // 分享接口不要求 durationMs；缺失时仅让本地耗时降级为 0，不阻塞分享。
          durationMs: highspeedMeta.durationMs ?? 0,
          regularTps: highspeedMeta.regularTps,
          highspeedTps: highspeedMeta.highspeedTps,
          ...(highspeedMeta.savedDurationMs !== undefined
            ? { savedDurationMs: highspeedMeta.savedDurationMs }
            : {}),
        },
      };
    }
    // 卡片和历史标识继续保留，但不超过 1.2x 或缺少完整耗时数据时不提供分享入口。
    // [失败路径] 门槛用 isHighspeedShareEligible 统一判定（>=1.2x 且字段完整）：
    // 在这里再写一遍阈值会让“按钮可点”与“提交后接口拒绝”出现分歧。
    // 返回 null 而不是抛错——分享只是增强能力，缺数据时按钮自然不渲染。
    return target && isHighspeedShareEligible(target.metrics) ? target : null;
  }, [highspeedMeta, highspeedTurn, unit.highspeedOutputFooterTarget]);
  const [highspeedShareDialogOpen, setHighspeedShareDialogOpen] = useState(false);
  // [资源] firstReasoningRowId 只取第一个 reasoning 行：它用于给“思考”块标题去重，
  // 取全部会退化成集合，下游每帧都要做一次 includes 判断。
  const firstReasoningRowId = useMemo(
    () => unit.assistantWorkRows.find((row) => row.kind === "reasoning")?.rowId,
    [unit.assistantWorkRows],
  );
  // [事务] 这层上下文只是 context 的浅拷贝加一个字段（INV-41）：条件展开而不是
  // 无条件写 messageStreamFirstReasoningRowId，保证没有 reasoning 行时下游看到的
  // 是“字段不存在”，而不是“字段存在但为 undefined”，两者的可选链语义不同。
  const assistantRowContext = useMemo<ConversationRowRenderContext>(
    () => ({
      ...context,
      ...(firstReasoningRowId !== undefined
        ? { messageStreamFirstReasoningRowId: firstReasoningRowId }
        : {}),
    }),
    [context, firstReasoningRowId],
  );
  const latestAssistantTextRow = unit.latestAssistantTextRow;
  const assistantPreviewPptxAutoOpenTarget = context.assistantPreviewPptxAutoOpenTarget;
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  // [失败路径] 三个条件用 && 串联（INV-42/26）：特性开关关掉时即便行状态是 complete
  // 也不能投影，否则正文里给模型看的注释标记会被留在界面上。
  const assistantCodeCommentProjectionEnabled =
    codeCommentCardsEnabled &&
    (unit.isRunning ||
      latestAssistantTextRow?.state === "complete" ||
      latestAssistantTextRow?.state === "interrupted");
  // [事务] 原始复制文本是下游一切投影的输入：它必须来自 unit 的完整行集合，
  // 而不是当前可见 DOM 的文本，否则被折叠/裁剪的段落会从复制内容里消失。
  const assistantRawCopyText = useMemo(
    () => resolveAssistantCopyText(unit),
    [unit.assistantTextRows, unit.assistantWorkRows, unit.latestAssistantTextRow],
  );
  // [事务] 拼接分隔符必须是空行："\n\n" 让多段正文在 markdown 语义上仍分属不同段落；
  // 用单个换行会把两段合并成一段，文件摘要里的代码块围栏也会粘连。
  // [权衡] 这里不做 filter/trim：摘要只用于给文件面板提供上下文，改动段序或内容
  // 会让面板里引用的原文与聊天区对不上。
  const assistantFileSummaryText = useMemo(
    () => unit.assistantTextRows.map((row) => row.text).join("\n\n"),
    [unit.assistantTextRows],
  );
  // [事务] 复制文本与屏幕正文共用同一次投影（INV-43/28）：streaming 参数决定
  // 投影器是否保留未闭合的注释块——流式期间不能裁掉半截块，否则复制出的内容
  // 会随着每次 delta 变短再变长。
  const assistantCopyText = useMemo(
    () =>
      assistantCodeCommentProjectionEnabled && assistantRawCopyText !== undefined
        ? projectAssistantCodeComments(assistantRawCopyText, {
            streaming: unit.isRunning,
          }).visibleText
        : assistantRawCopyText,
    [assistantRawCopyText, assistantCodeCommentProjectionEnabled, unit.isRunning],
  );
  // [权衡] 卡片上限写死 50：这是“卡片是摘要、不是全文索引”的产品约束；
  // 放大上限会让超长回复的轮尾堆积上百张卡片，滚动性能与可读性同时崩。
  // [事务] 截断发生在池化之后而不是之前：先截断会漏掉前面被裁掉的重复项，
  // 导致同一处代码出现多张卡片。
  const assistantCodeCommentCards = useMemo(
    () =>
      codeCommentCardsEnabled &&
      assistantRawCopyText !== undefined &&
      // 卡片与 zcode-file-citation 的预览卡片保持一致：流式期间只投影正文，
      // 只有终态 row 才生成卡片，避免运行中卡片先出现又因模型续写而回滚。
      (latestAssistantTextRow?.state === "complete" ||
        latestAssistantTextRow?.state === "interrupted")
        ? buildAssistantCodeCommentCards(assistantRawCopyText, context.workspacePath, 50, {
            homePath: context.workspaceHomePath,
          })
        : [],
    [
      assistantRawCopyText,
      codeCommentCardsEnabled,
      context.workspaceHomePath,
      context.workspacePath,
      latestAssistantTextRow?.state,
    ],
  );
  // [事务] 运行中直接返回空数组（INV-45）：工具行本身正在显示，摘要卡必须等
  // 整轮结束；否则“创建成功”会先出现，随后又被 CronDelete 撤销而闪断。
  const cronAutomationTurnCards = useMemo(
    () => (unit.isRunning ? [] : resolveCronAutomationTurnCards(unit.assistantWorkRows)),
    [unit.assistantWorkRows, unit.isRunning],
  );
  // 上方已是工具摘要；下方运行卡在联接到 run 后立即显示，不能再等主代理回复结束。
  // 依赖联接表保持实时更新，并由解析器按 runId 去重。直接启动轮
  // 的 run 卡也从这里出：那一轮没有用户气泡、没有助手内容，run 卡就是它的全部呈现。
  // [权衡] 四张联查表各自独立引用取出来再做依赖：直接用 context 作依赖会随
  // 父级每次渲染变化而重算 digest，而真正影响结果的只有表本身（INV-33）。
  const workflowRunByToolCallId = context.workflowRunByToolCallId;
  const workflowRunByRunId = context.workflowRunByRunId;
  const workflowGraphByToolCallId = context.workflowGraphByToolCallId;
  const workflowFillGraphByRunId = context.workflowFillGraphByRunId;
  // [事务] digest 是“本轮涉及的 run 摘要”，必须把四张表一起传进去：
  // 只传 byToolCallId 会漏掉通知轮（没有 CreateWorkflow 行，只能按 runId 联）。
  // [权衡] 依赖数组显式列出四个表而不是 context：context 每次换引用都会让 digest
  // 重算，而 digest 内部要做图着色，属于本文件最贵的计算之一。
  const workflowTurnDigests = useMemo(
    () =>
      resolveWorkflowTurnDigests(unit, {
        byToolCallId: workflowRunByToolCallId,
        byRunId: workflowRunByRunId,
        graphByToolCallId: workflowGraphByToolCallId,
        fillGraphByRunId: workflowFillGraphByRunId,
      }),
    [
      unit,
      workflowFillGraphByRunId,
      workflowGraphByToolCallId,
      workflowRunByRunId,
      workflowRunByToolCallId,
    ],
  );
  // 完成卡：主代理消化 completed 通知的那一轮，轮尾落卡。
  // 同一条门（轮结束）；联接只认 byRunId——通知轮里没有 CreateWorkflow 行可按 toolCallId 联。
  // [事务] 完成卡与 digest 用同一个门（isRunning）但不同的联查口径（INV-45）：
  // 完成卡只认 byRunId，因为“通知轮”里根本没有可用来按 toolCallId 联的行。
  const workflowTurnCompletion = useMemo(
    () =>
      unit.isRunning
        ? undefined
        : resolveWorkflowTurnCompletion(unit.header, { byRunId: workflowRunByRunId }),
    [unit.header, unit.isRunning, workflowRunByRunId],
  );
  // [事务] OffPeak 与 Cron 完全同构：运行中为空、终态才聚合，否则同一张卡会在
  // 运行中与结束态各渲染一次，出现重复键警告与闪断。
  const offPeakTurnCards = useMemo(
    () => (unit.isRunning ? [] : resolveOffPeakTurnCards(unit.assistantWorkRows)),
    [unit.assistantWorkRows, unit.isRunning],
  );
  // [事务] 操作栏的三个条件缺一不可（INV-47）：timelineOnly 轮没有可操作的正文，
  // 非 complete 的正文还在流式（复制会得到半截内容），没有复制文本则按钮无意义。
  const canRenderAssistantActions =
    !unit.timelineOnly &&
    latestAssistantTextRow?.state === "complete" &&
    assistantCopyText !== undefined;
  // runtime turnId 与产品轮次 ID 不同；用 CLI 行上的命令归因关联投递，包含被裁剪输入的 header。
  // [事务] 这里允许重复、不在这里去重（INV-46）：下游按“投递记录”自行去重，
  // 这里若去重会把“同一指令在不同阶段被投递两次”的事实抹平，归因统计变少。
  const deliverySourceCommandIds = [
    ...(unit.header?.sourceCommandId ? [unit.header.sourceCommandId] : []),
    ...unit.visibleUserInputs.flatMap((row) => (row.sourceCommandId ? [row.sourceCommandId] : [])),
  ];
  const hasHookActions =
    // Hook action 与 copy/feedback/fork 共用 turn eligibility；
    // timelineOnly 维护 turn（compact/modelChange marker 轮）即使带历史遗留的
    // didExecute=true Hook row 也不得露出图标，否则 /compact 轮会凭 SessionStart
    // Hook 误挂出一个不可解释的操作栏。
    // [失败路径] timelineOnly 必须显式排除：/compact 维护轮常带历史遗留的
    // didExecute=true Hook 行，若只看 didExecute 会长出一个无法解释的操作栏。
    !unit.timelineOnly &&
    !unit.isRunning &&
    unit.hookInvocations.some((row) => row.executions.some((execution) => execution.didExecute));
  const canRetryLatestAssistant = latestAssistantTextRow?.actions?.canRetry === true;
  const canForkLatestAssistant = latestAssistantTextRow?.actions?.canFork === true;
  // [事务] 后台标题只在“确实是后台结果轮”时才非空，它是后续分支的总开关：
  // 非空走 ConversationBackgroundResultWork（独立渲染），为空走普通 ConversationTurnFlow。
  const backgroundResultTitle = resolveBackgroundResultTitle(unit);
  // [失败路径] 页脚四条件（上游开关 + 是加速轮 + 非维护轮 + 已结束）缺一不可：
  // 少判 isRunning 会让运行中的加速轮提前显示“由 xx 生成”并给出分享入口。
  const showHighspeedOutputFooter =
    unit.showHighspeedOutputFooter === true && isHighspeed && !unit.timelineOnly && !unit.isRunning;
  // [事务] “助手区是否有内容”必须把“正在运行的段”也算进来（INV-48）：
  // 正文与工具都还没到时，仅凭 isRunning 也要渲染容器，否则 loading 气泡无处可放。
  const hasAssistantWorkContent = unit.timelineOnly
    ? unit.assistantWorkRows.length > 0
    : unit.assistantWorkRows.length > 0 ||
      unit.workSegments?.some((segment) => segment.workStatus?.state === "running") === true ||
      unit.workStatus?.state === "running";
  // [失败路径] 总开关必须包含文件变更与四类轮尾卡：只有 diff 的一轮若被这个开关
  // 判成“无内容”，整行都不会渲染，用户看不到任何改动痕迹（INV-48）。
  const hasAssistantTurnContent =
    hasAssistantWorkContent ||
    Boolean(unit.header?.fileChanges) ||
    canRenderAssistantActions ||
    hasHookActions ||
    showHighspeedOutputFooter ||
    workflowTurnDigests.length > 0;
  const editWorkspaceRewindAvailability = useMemo<EditWorkspaceRewindAvailability>(() => {
    // [事务] 四条判定按“越具体越先”排列（INV-49）：noFiles → reverted → running → 权限。
    // 顺序决定用户看到的提示文案；把 running 放到权限之后，运行中会提示“无权限”，
    // 而用户其实只是需要等它跑完。
    const fileChanges = unit.header?.fileChanges;
    if (!fileChanges || fileChanges.files <= 0) return { enabled: false, reason: "noFiles" };
    if (fileChanges.state === "reverted") return { enabled: false, reason: "reverted" };
    if (unit.isRunning) return { enabled: false, reason: "running" };
    if (unit.header?.actions?.canRewindFiles !== true) {
      return { enabled: false, reason: "unavailable" };
    }
    return { enabled: true, reason: "available" };
  }, [unit.header?.actions?.canRewindFiles, unit.header?.fileChanges, unit.isRunning]);

  // workflow 通知卡开头的轮去掉轮顶 padding：卡片只贴上一轮 pb-5 的常规流内间距。
  const startsWithWorkflowNotificationCard =
    backgroundResultTitle !== undefined && resolveWorkflowNotification(unit) !== undefined;
  // 同一条规则的另外两个来源：中枢直接启动轮与「配置」的设置轮（docs/dynamic-workflow/presentation.md
  // 「The run card」）。它们的用户行是写给模型的规范句，conversationTurnRenderUnits 会裁掉，
  // 卡 / 「已调整设置」那一行于是成了轮内第一个节点。
  //
  // Bug 根因：`pt-14` 是给用户气泡留的呼吸，判据却一直是「有没有轮」而不是「有没有气泡」；
  // 没有气泡时这 56px 叠上一轮的 pb-5，在行上方堆出约 76px 空白（设置轮总落在对话中段，最显眼）。
  const startsWithoutUserBubble =
    startsWithWorkflowNotificationCard || unit.workflowLaunch !== undefined;

  // [事务] 轮的 DOM 契约都在 section 上：data-turn-id 与 data-turn-key 是虚拟列表
  // 与“跳到某一轮”的锚点，缺任一个都会让滚动定位退化到按文本搜索。
  // [权衡] 紫光用“数据属性 + 类名”双写：数据属性供测试与样式选择器使用，
  // 类名才是真正的视觉实现；只写类名会让 e2e 无法在不解析 CSS 的前提下断言。
  return (
    <section
      data-turn-id={unit.turnId}
      // [事务] turnId 与 key 两个属性都要写（INV-34）：turnId 是运行时对外的轮标识，
      // key 是渲染期稳定键，二者不总是相等（key 可能带来源前缀），混用会让定位错轮。
      data-turn-key={unit.key}
      data-highspeed-gradient={showHighspeedAnimatedGradient ? "true" : undefined}
      className={cn(
        "relative mx-auto flex w-full flex-col gap-5 px-4 @md/conversation:px-6 pb-5",
        startsWithoutUserBubble ? "pt-0" : "pt-14",
        showHighspeedAnimatedGradient && "highspeed-animated-gradient-text",
      )}
    >
      {unit.leadingBoundaryRows.map((row) => (
        <ConversationTurnRow
          key={`${row.rowId}:${row.entityId ?? ""}`}
          row={row}
          // [事务] leadingBoundaryRows 渲染在 group/assistant-turn 之外（INV-34）：
          // 它们是 fork 分割线这类“轮前边界”，必须位于一切轮内内容之前，
          // 放进 hover 容器会让分割线随正文一起淡入淡出。
          context={context}
        />
      ))}
      {hasAssistantTurnContent ? (
        // deferAssistantActions 后工具栏被移到文件 summary 之后，
        // 之前 hover group 只包住工具栏自己，导致必须悬停到不可见按钮位置才出现。
        // 这里把 assistant work、summary 和工具栏放进同一轮 hover 容器，对齐旧版。
        // [事务] hover 容器必须包住 work + summary + 工具栏（INV-14）：只包工具栏时，
        // 用户要先找到不可见的按钮位置才能让按钮出现，操作栏等于随机闪烁。
        <div className="group/assistant-turn flex w-full flex-col gap-5">
          {backgroundResultTitle ? (
            <>
              {visibleUserRows.map((row) => (
                <ConversationTurnRow
                  key={`${row.rowId}:${row.entityId ?? ""}`}
                  row={row}
                  context={context}
                  // [失败路径] 后台结果轮仍要渲染可见用户行（可能为空数组）：
                  // 它们是被裁剪后的残留，但仍是用户真实输入的一部分，
                  // 跳过会让“总结说了什么”缺少提问上下文。
                  onEdit={row.actions?.canEdit === true ? onEdit : undefined}
                  editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
                />
              ))}
              <ConversationBackgroundResultWork
                unit={unit}
                apiRetry={apiRetry}
                // [事务] context 传 assistantRowContext 而不是 context（INV-41）：
                // 第一个 reasoning 行的标识只在这一层组装，后台结果轮同样需要它。
                context={assistantRowContext}
                onFork={canForkLatestAssistant ? onFork : undefined}
                onRetry={onRetry}
                title={backgroundResultTitle}
                assistantCopyText={assistantCopyText}
                // [事务] 评论卡与预览卡的自动展开键都按 turnId 匹配：
                // 只有“当前这一轮”才允许自动弹开，历史轮即使 keys 相同也不抢焦点。
                assistantCodeCommentCards={assistantCodeCommentCards}
                assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
                assistantPreviewCardsAutoOpenKey={
                  assistantPreviewPptxAutoOpenTarget?.turnId === unit.turnId
                    ? assistantPreviewPptxAutoOpenTarget.key
                    : undefined
                }
              />
            </>
          ) : (
            <ConversationTurnFlow
              unit={unit}
              apiRetry={apiRetry}
              context={assistantRowContext}
              onFork={canForkLatestAssistant ? onFork : undefined}
              onRetry={onRetry}
              onEdit={onEdit}
              editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
              assistantCopyText={assistantCopyText}
              // [失败路径] 卡片只在“最新正文行”上生成（INV-27）：传给整轮的话，
              // 历史段落也会长出卡片，同一份分析被反复展示。
              assistantCodeCommentCards={assistantCodeCommentCards}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
              highspeed={isHighspeed}
              highspeedMeta={highspeedMeta}
              assistantPreviewCardsAutoOpenKey={
                assistantPreviewPptxAutoOpenTarget?.turnId === unit.turnId
                  ? assistantPreviewPptxAutoOpenTarget.key
                  : undefined
              }
            />
          )}
          {/* 完成卡：这一轮消化的那条 run 做了什么、花了多少，紧跟最后一段正文。 */}
          {workflowTurnCompletion === undefined ? null : (
            <ConversationWorkflowCompletion
              completion={workflowTurnCompletion}
              // [事务] 完成卡用 context 而不是 assistantRowContext：它不含 reasoning
              // 行，也就不需要“首个思考块”这类只对正文区有意义的字段。
              context={context}
              turnKey={unit.key}
            />
          )}
          {/* 轮尾摘要：这一轮留下在跑的 run，排在完成卡之后、其余轮尾块之前。 */}
          <ConversationWorkflowDigests
            context={context}
            digests={workflowTurnDigests}
            turnKey={unit.key}
          />
          {/* 修复原因：CronCreate/CronUpdate 工具本身仍按普通工具行展示；成功卡片属于整轮
              完成后的结果摘要，必须等回复结束再跟随最终 assistant 正文收尾。 */}
          <CronAutomationTurnCards cards={cronAutomationTurnCards} context={context} />
          <OffPeakTurnCards cards={offPeakTurnCards} context={context} />
          {!isOfficeMode && unit.header?.fileChanges ? (
            <ConversationFileSummaryPanel
              header={unit.header}
              // [权衡] 办公模式整体隐藏 diff 摘要：办公用户不按代码审阅的心智读结果，
              // 展开的文件清单会挤掉他们真正关心的正文与产物。
              context={context}
              assistantText={assistantFileSummaryText}
            />
          ) : null}
          {unit.browserTurnEndRows.length > 0 ? (
            // 自动截图表达轮次结束时页面最终状态；放在 assistant work 内会
            // 穿插到 Website 预览和 file diff 摘要之间。它应是操作栏之前的最后一个内容块。
            <ConversationAssistantWorkItems
              rows={unit.browserTurnEndRows}
              // [事务] 截图块必须位于“操作栏之前、文件摘要之后”（INV-15/34）：
              // 它表达轮次结束时的页面终态，混进 assistantWork 会插到预览与 diff 中间。
              context={assistantRowContext}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          ) : null}
          {canRenderAssistantActions && latestAssistantTextRow ? (
            // 文件 summary 是整轮完成后的聚合结果；轮尾工具栏如果跟着
            // assistant text 内联渲染，会插到 summary 前面，读起来像 summary 不是本轮收尾。
            <ConversationAssistantTextActions
              rowId={latestAssistantTextRow.rowId}
              entityId={latestAssistantTextRow.entityId}
              text={assistantCopyText}
              createdAt={latestAssistantTextRow.createdAt}
              compactForRemoteControl={context.compactForRemoteControl}
              feedback={readAssistantFeedback(latestAssistantTextRow)}
              sessionId={context.sessionId}
              onFork={canForkLatestAssistant ? onFork : undefined}
              onRetry={canRetryLatestAssistant ? onRetry : undefined}
              onFeedbackChange={onFeedbackChange}
              hookInvocations={unit.hookInvocations}
              turnId={unit.turnId}
              sourceCommandIds={deliverySourceCommandIds}
              className={cn(
                "flex items-center gap-1",
                context.compactForRemoteControl
                  ? "opacity-100"
                  : "opacity-0 transition-opacity group-hover/assistant-turn:opacity-100 focus-within:opacity-100 has-[[data-bot-group-delivery]]:opacity-100",
              )}
            />
          ) : (hasHookActions || !unit.isRunning) && !canRenderAssistantActions ? (
            // 冲突合并曾把此兜底接到 Highspeed 页脚的 else，导致普通回复重复入口，
            // Highspeed 无正文轮又丢失入口；它只与普通操作栏互斥，页脚独立渲染。
            // [事务] 条件里的 `!unit.isRunning` 只在“没有正文操作栏”时才决定是否出现：
            // 运行中仍允许显示 Hook 详情（INV-14），但不允许出现复制/反馈这类终态动作。
            <MessageActions
              className={cn(
                context.compactForRemoteControl
                  ? "opacity-100"
                  : "opacity-0 transition-opacity group-hover/assistant-turn:opacity-100 focus-within:opacity-100 has-[[data-bot-group-delivery]]:opacity-100",
              )}
            >
              {hasHookActions ? (
                <ConversationHookDetailsAction rows={unit.hookInvocations} turnId={unit.turnId} />
              ) : null}
              <ConnectedBotGroupDeliveryAction
                turnId={unit.turnId}
                sourceCommandIds={deliverySourceCommandIds}
              />
            </MessageActions>
          ) : null}
          {showHighspeedOutputFooter ? (
            <HighspeedOutputFooter
              // [事务] 文案全部走 intl，不在组件里拼字符串：Highspeed 页脚在
              // 分享截图里是可见的品牌元素，多语言下必须与产品其他位置一致。
              generatedLabel={intl.formatMessage({ id: "chat.highspeed.generatedBy" })}
              shareLabel={intl.formatMessage({ id: "chat.highspeed.viewAction" })}
              shareAriaLabel={intl.formatMessage({ id: "chat.highspeed.share" })}
              shareEnabled={highspeedShareTarget !== null}
              sharePending={false}
              onShare={() => setHighspeedShareDialogOpen(true)}
            />
          ) : null}
          {highspeedShareTarget ? (
            <HighspeedShareDialog
              metrics={highspeedShareTarget.metrics}
              open={highspeedShareDialogOpen}
              onOpenChange={setHighspeedShareDialogOpen}
            />
          ) : null}
          {unit.assistantTailRows.length > 0 ? (
            // turnTailBoundary 之前虽然从工作历史中拆出，却仍在 flow 内渲染，
            // 使 CronCreate、文件 summary 与操作栏看起来落在 fork 分割线之后。boundary
            // 必须统一收在全部 turn-local 附属 UI 之后，才是真正的 logical turn 结尾。
            // [事务] 这是轮尾的最后一个内容块（INV-15/34）：它之后只允许出现
            // topicPreparations，任何新块都应插在它之前，否则 boundary 不再是结尾。
            <ConversationAssistantWorkItems
              rows={unit.assistantTailRows}
              context={assistantRowContext}
              assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
            />
          ) : null}
        </div>
      ) : (
        <ConversationTurnFlow
          unit={unit}
          apiRetry={apiRetry}
          context={assistantRowContext}
          onEdit={onEdit}
          // [事务] 这个分支是“没有助手内容但有用户行/准备项”的轮：不套 hover 容器，
          // 因此也不传 actions 相关的 onFork/onRetry——它们只属于终态正文（INV-47）。
          editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
          assistantCopyText={assistantCopyText}
          assistantCodeCommentCards={assistantCodeCommentCards}
          assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
          highspeed={isHighspeed}
          highspeedMeta={highspeedMeta}
        />
      )}
      {unit.topicPreparations?.length ? (
        <BotTopicPreparation items={unit.topicPreparations} />
      ) : null}
    </section>
  );
}

// [权衡] 这里用默认浅比较而不是自定义比较器：unit 由上游 memo 化（INV-33），
// 引用不变即内容不变；写自定义比较反而容易漏字段，且无法受益于 React 的
// 浅比较短路。代价是上游一旦重建 unit，本轮所有块都会重算。
export const ConversationTurnGroup = memo(ConversationTurnGroupImpl);
