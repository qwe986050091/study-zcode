// ── 文件职责 ──
// v4 会话时间线的“行渲染器”：把协议行 ConversationRow 按 kind 分派到各自的 memo 叶子，
// 它位于 TurnGroup 与具体工具/消息组件之间，是最靠近协议的一层 UI。
// 因此这里只允许出现“读字段、传回调、选分支”，任何跨行聚合都属于上层。
// 违反这一点会让虚拟列表的复用假设失效：叶子可能看到被本地改写过的 row。
// 每个叶子只负责一种行的视觉与交互（附件、userInput、assistantText、reasoning、
// timelineMarker、toolCall、subagent、artifact）。这里不做投影、不做状态聚合，
// 所有权威数据都来自 row 与 context。
//
// ── 渲染链路 ──
// TurnGroup 计算轮级信息（copyText/previewCards/codeCommentCards/hideActions）
//   → ConversationRowView（switch 按 kind 分派）
//   → 每种 RowView（memo，props 引用稳定才跳过）
//   → RowShell（统一 data-row-id/testid；虚拟列表的定位锚点）。
// 行内交互（fork/feedback/edit）通过 props 回调上抛，本文件不直接调用 RPC。
//
// ── 不变量表 ──
// INV-01：每个 kind 只在 switch 里出现一次；新增行类型必须补 case，否则默认分支静默 return null
//         会让整类消息从时间线消失。（ConversationRowViewImpl 的 switch）
// INV-02：RowShell 的 data-row-id 必须等于 row.rowId：它是虚拟列表测量与滚动定位的唯一键。
// INV-03：memo 叶子的 props 必须是稳定引用或原始值；context 由宿主保证稳定，
//         本文件禁止在渲染期创建新数组/对象传给子组件（空数组用模块级 EMPTY_SOURCE_COMMAND_IDS）。
// INV-04：hook 只能出现在各自叶子内部；分派组件（switch）里不得按 kind 条件调用 hook。
// INV-05：assistant 动作只在轮尾段渲染：complete + !hideActions + !deferActions 三者同时成立。
//         一轮对用户是一个回复，多段 text 各自出动作会让复制/fork 语义重复。
// INV-06：复制文本用 copyText ?? row.text：轮尾段复制整轮合并文本，非轮尾段不渲染动作。
// INV-07：reasoning 的可见性由 isConversationReasoningRowVisible 统一裁决；
//         关闭“显示思考过程”只隐藏后续段，首条最小思考提示必须保留。
// INV-08：流式增量只影响渲染容错，不改 row：streaming 由 row.state 派生，
//         不得在本地缓存半截文本（否则与投影竞争）。
// INV-09：附件读取必须带 AbortSignal，并在卸载/切换时 abort；只丢弃结果不停传输会让 IPC
//         继续拉完整视频，泄漏文件 IO。（UserInputAttachmentList 的所有 effect）
// INV-10：object URL 只释放本组件创建的；Desktop 本地媒体返回自定义协议 URL，
//         对其调用 revokeObjectURL 会误伤其它查看器。（thumbnailObjectUrlsRef 的记账）
// INV-11：编辑态删除附件必须同时删 editAttachments 与 editAttachmentIndices；
//         二者长度不等会让按 attachmentIndex 的分块读取指向错误文件。
// INV-12：编辑提交必须显式传附件数组（含空数组）：缺省会让 CLI 按“未修改”恢复原附件。
// INV-13：反馈是乐观更新 + 失败回滚：命令返回 false 或 reject 都必须回到点击前的投影值。
// INV-14：工具卡与权限卡的挂载条件必须与 ToolCallBlock 内部判定同源
//         （messageStreamShowTodos / resolveToolCallIdentity），否则会留下空 RowShell 与多余间距。
// INV-15：workflow 关联键是“发起行 toolCallId + runId”；resume 行不能用自己的 toolCallId 去查。
// INV-16：timelineMarker 的 default 分支必须返回 null（隐形行清零），不能兜底成可见文案。
// INV-17：JSX children 区域禁止插入行注释；本文件的注释只出现在声明/语句/表达式容器上方。
// INV-18：所有时间/文案格式走 intl 或共享格式化函数，叶子内不硬编码语言。
//
// ── 阅读顺序建议 ──
// 先看 ConversationRowViewImpl 的 switch 建立行类型地图，再按需下钻叶子；
// 附件叶子约 630 行，是资源生命周期最密集的区域；toolCall 叶子是 workflow 关联规则的集中地。
import { GenUiMessageResponse } from "@/gen-ui/index.js";
import { ConversationUserInputBubble } from "@/v4/ConversationUserInputBubble.js";
import { expandTopicInputMessages } from "@/v4/topicInputMessages.js";
import { ConnectedBotGroupDeliveryAction } from "@/v4/BotGroupDeliveryAction.js";
/* oxlint-disable eslint(max-lines) -- v4 逐行 row 渲染分发集中收口（每种 row 一个 memo 叶子 + timelineMarker 分隔线），拆分会打散行类型对照。 */
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import {
  type ComponentProps,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArchiveIcon,
  ArrowRightLeftIcon,
  CheckIcon,
  Clock,
  CopyIcon,
  FileClockIcon,
  FileIcon,
  GitBranchIcon,
  GoalIcon,
  PencilIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TrendingUpDownIcon,
  XIcon,
} from "lucide-react";
import { parseAutomationRunId } from "@zcode/shared";
import {
  TID_V4_EDIT,
  TID_V4_EDIT_ATTACHMENT_REMOVE,
  TID_V4_EDIT_CANCEL,
  TID_V4_EDIT_INPUT,
  TID_V4_EDIT_SUBMIT,
  TID_V4_EDIT_REWIND_WORKSPACE,
  TID_V4_FEEDBACK_DISLIKE,
  TID_V4_FEEDBACK_LIKE,
  TID_V4_FORK,
  TID_V4_ROW,
  TID_V4_ROW_ATTACHMENTS,
  testId,
} from "@zcode/shared/test-ids";
import type {
  AttachmentRef,
  ArtifactRow,
  AssistantTextRow,
  CommandAck,
  ConversationRow,
  ConversationRowTarget,
  HookInvocationRow,
  ReasoningRow,
  SubagentRow,
  TimelineMarkerRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
  V4ConversationFileRewindPreviewResult,
} from "@zcode/shared/zcode-protocol-v4";
import { AssistantPreviewCards } from "@/AssistantPreviewCards.js";
import { AssistantCodeCommentCards } from "@/AssistantCodeCommentCards.js";
import { useAssistantCodeCommentFeatureEnabled } from "@/AssistantCodeCommentFeatureProvider.js";
import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments.js";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  ChatMediaAttachmentPreviewDialog,
  type ChatMediaAttachmentPreviewTarget,
} from "@/ChatMediaAttachmentPreviewDialog.js";
import type { PdfViewerRangeSource } from "@/components/ui/pdf-viewer.js";
import { MessageAction, MessageActions } from "@/components/ai-elements/message.js";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { WorkflowToolSummary } from "@/v4/WorkflowToolSummary.js";
import {
  readWorkflowName,
  readWorkflowRetuneCall,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import { WorkflowRetuneRow } from "@/ToolCallBlocks/renderers/WorkflowRetuneRow.js";
import { workflowRunDefaultConcurrency } from "@/components/workflow-timeline/workflowRunSettings.js";
import { isAmendWorkflowToolCall, isFillWorkflowHoleToolCall } from "@/lib/workflowToolNames.js";
import {
  readWorkflowHoleTarget,
  workflowFillCounts,
} from "@/ToolCallBlocks/renderers/createWorkflowHoleInput.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { resolveWorkflowRunOpenToolCallId } from "@/v4/workflowRunCardJoin.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { logger } from "@/logger.js";
import { PluginUiModelContextChip, formatPluginDisplayName } from "@/plugin-ui/index.js";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";
import {
  FileDisplayIcon,
  FileDisplayInline,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import {
  projectAssistantCodeComments,
  type AssistantCodeCommentCard,
} from "@/lib/assistantCodeComment.js";
import { resolveProviderLabel } from "@/lib/registryProviderView.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import {
  isConversationReasoningRowVisible,
  type ConversationRowRenderContext,
} from "@/v4/conversationRowContext.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { CodeCommentAttachmentChip } from "@/v4/composer/CodeCommentAttachmentChip.js";
import {
  countComposerPromptContexts,
  parseComposerPromptContexts,
  serializeComposerPromptContexts,
} from "@/v4/composer/composerPromptContexts.js";
import { WebElementContextAttachmentChip } from "@/v4/composer/WebElementContextAttachmentChip.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import { PptxElementReferenceChip } from "@/v4/composer/PptxElementReferenceChip.js";
import { useOpenPptxElementReference } from "@/v4/composer/useOpenPptxElementReference.js";
import { ConversationFileRewindDialog } from "@/v4/ConversationFileRewindDialog.js";
import { BotGroupSourceLabel } from "@/v4/BotGroupSourceLabel.js";
import { splitUserInputEpilogue } from "@/v4/ConversationUserInputEpilogue.js";
import { ConversationHookDetailsAction } from "@/v4/ConversationHookDetailsAction.js";
import { formatModelChangeLabel } from "@/v4/composer/modelTriggerDisplay.js";
import { formatMessageTimeLabel } from "@/v4/messageTimeLabel.js";
import { parseConversationShareContext } from "@/lib/conversationShareContext.js";

// 所有行的公共外壳：统一 data-row-id 与 data-testid，让虚拟列表、e2e 与选择逻辑
// 相同的 rowId 也出现在 timelineMarker 的 button 分支，因此可点分隔线同样能被定位。
// 不要在这里追加 key 或 ref：定位由调用方按 rowId 负责，重复会引入第二套身份。
// 只依赖一个锚点。它刻意不包任何样式，避免影响各行自己的布局假设。
function RowShell({
  rowId,
  children,
  className = "",
}: {
  rowId: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-row-id={rowId}
      data-testid={testId(TID_V4_ROW, String(rowId))}
      className={cn(className)}
    >
      {children}
    </div>
  );
}

// artifact 行：最小可读投影（文件名 + 类型 + 字节数）。
// displayName 可能很长，统一 truncate 而不是换行，保证行高固定。
// 类型与字节数放在第二行弱化，避免与正文型消息争夺视觉焦点。
// 不提供打开入口，是因为 artifact 的权威查看器在产物面板，行内再开一套会分叉。
const ArtifactRowView = memo(function ArtifactRowView({ row }: { row: ArtifactRow }) {
  return (
    <RowShell rowId={row.rowId} className="px-4 py-1">
      <div className="flex items-center gap-2 rounded-lg border border-card-border bg-card px-3 py-2">
        <FileIcon className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui-base text-foreground">{row.displayName}</p>
          <p className="text-ui-sm text-foreground-subtle">
            {row.artifactType.toUpperCase()} · {row.sizeBytes} bytes
          </p>
        </div>
      </div>
    </RowShell>
  );
});

/** 复制行文本：图标 ghost 按钮 + 1200ms 打勾态（对齐旧版 message copy）。
 *  label/tooltip 必须由调用方传入 i18n 文案，禁止硬编码语言。 */
// 复制按钮：点击后 1200ms 打勾反馈。计时器不清理是有意的——组件通常随行常驻，
// 若未来把该按钮放进条件挂载的浮层，需要补 clearTimeout，避免重复点击叠加多个定时器。
// 打勾期间禁用再次写入没有意义：重复点击只会重置 1200ms 窗口。
// 卸载后 setState 在 React 18 已静默；若要复用为短生命周期组件需补 cleanup。
const CopyRowAction = memo(function CopyRowAction({
  text,
  rowId,
  label,
  tooltip = label,
}: {
  text: string;
  rowId: number;
  label: string;
  tooltip?: string;
}) {
  // copied 只驱动图标，不进入任何持久状态；刷新后必然回到未复制态。
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    // 空文本不写剪贴板：否则会把空串覆盖用户已有剪贴板内容，且按钮本应 disabled。
    if (!text || !navigator.clipboard) return;
    void runUserActionAsync({
      input: { featureId: "conversation.history.feedback", action: "copy", trigger: "button" },
      operation: () => navigator.clipboard.writeText(text),
      completed: { resultSource: "platform_result" },
      failureStage: "clipboard_write",
// [失败路径] 写入失败时 telemetry 已记录，这里不再提示；打勾只在成功回调里发生，
// 因此失败不会出现“复制成功”的假反馈。
    }).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [text]);
  return (
    <MessageAction
      aria-label={label}
      label={label}
      tooltip={tooltip}
      data-testid={`v4-copy-${rowId}`}
      disabled={text.length === 0}
      onClick={handleCopy}
    >
      {copied ? <CheckIcon className="size-3.5 text-success" /> : <CopyIcon className="size-3.5" />}
    </MessageAction>
  );
});

// 编辑回调的返回值有三种语义：CommandAck（可能 blocked + preview）、
// 类型上用一个联合而不是多个布尔，是为了强制调用方先用 typeof 判对象再读 result。
// 新增返回值时必须同步更新 handleSubmitEdit，否则会被当成“成功”而退出编辑态。
// false（失败/未执行）、void（旧实现）。调用方必须区分，不能只用真值判断。
type UserInputEditHandler = (
  target: ConversationRowTarget,
  newText: string,
  attachments?: readonly AttachmentRef[],
  workspaceMode?: "preserve" | "rewind",
  conversationQuotes?: import("@zcode/shared").ConversationSelectionText[],
) => Promise<CommandAck | boolean | void> | CommandAck | boolean | void;

// 反馈只有两态 + null（取消）：null 表示“没有反馈”，不是“未加载”。
type AssistantMessageFeedback = "like" | "dislike";

// 附件类型标签：优先扩展名，其次 MIME 子类型；两者都缺失时返回 MIME 原文的大写。
// 返回值只用于展示，不参与任何协议字段，因此大小写与本地化都不影响语义。
// 无扩展名且 MIME 为空串时得到空标签；调用方用固定行高保证不塌陷。
function getAttachmentTypeLabel(filename: string, mimeType: string): string {
  // 同时按 / 与 \ 切分：Windows 路径与 POSIX 路径都会出现在 fileName 里。
  const leaf = filename.split(/[\\/]/u).at(-1) ?? filename;
  const dotIndex = leaf.lastIndexOf(".");
  // dotIndex > 0 排除隐藏文件（.env）：它的“扩展名”没有展示意义。
  if (dotIndex > 0 && dotIndex < leaf.length - 1) {
    return leaf.slice(dotIndex + 1).toUpperCase();
  }
  return (mimeType.split("/").at(-1) ?? mimeType).toUpperCase();
}

// 反馈处理器：返回 false 表示 CAS 失败（服务端已有其它值），调用方需回滚乐观更新。
// Promise<void> 与 false 的区别是“成功”与“冲突”，不是“失败”与“成功”。
// 抛错同样视为失败，由叶子统一回滚并记日志。
export type AssistantFeedbackHandler = (
  target: ConversationRowTarget,
  feedback: AssistantMessageFeedback | null,
) => Promise<boolean | void> | boolean | void;

// 读取 row.feedback 时做白名单校验：旧 CLI 可能给出未知字符串，
// 未知值一律折成 null，等价于“没有反馈”，这样按钮不会误显示为已选中。
// 该函数是纯函数，便于在投影层与叶子层共用同一口径。
// 直接透传会让按钮进入既非 like 也非 dislike 的第三态。
export function readAssistantFeedback(row: AssistantTextRow): AssistantMessageFeedback | null {
  // feedback 是 additive V4 row 字段；兼容旧 CLI 的 row 时缺省为 null。
  const feedback = row.feedback;
  return feedback === "like" || feedback === "dislike" ? feedback : null;
}

// 编辑时“重置会话与文件”的可用性：enabled 与 reason 必须同时给出，
// noFiles 与 reverted 的区别只在文案：前者没有可回滚文件，后者已经回滚过。
// 宿主不提供该对象时，按钮按“不可用 + noFiles 文案”降级，而不是隐藏。
// reason 用于 tooltip 文案，不能由 enabled 反推（noFiles 与 running 文案不同）。
export interface EditWorkspaceRewindAvailability {
  enabled: boolean;
  reason: "available" | "noFiles" | "reverted" | "running" | "unavailable";
}

// 行渲染的完整入参：row/context 是必填，其余都是可选交互能力。
// hideAssistantActions 与 deferAssistantActions 是两个独立维度：前者表示“这段不是轮尾”，
// 后者表示“动作要等在文件 summary 之后再画”，二者不能合并成一个布尔。
// assistantCopyText 只对轮尾段有意义，非轮尾段即使传了也不会被使用。
// 可选回调缺省时对应入口整体不渲染，而不是渲染成禁用按钮——设置页/只读面板会复用本组件。
export interface ConversationRowViewProps {
  row: ConversationRow;
  /** 渲染上下文（theme/codePreviewSettings/workspacePath）；宿主保证引用稳定。 */
  context: ConversationRowRenderContext;
  /** 完成态 assistant 行的 fork 入口（forkAssistant command）。 */
  onFork?: (target: ConversationRowTarget) => void;
  /** assistant entity 反馈 CAS；UI 先乐观更新，命令失败时回滚。 */
  onFeedbackChange?: AssistantFeedbackHandler;
  /** 协议兼容：上层仍可提供 retryTurn capability，但产品 UI 不渲染普通重试入口。 */
  onRetry?: (target: ConversationRowTarget) => void;
  /** user 行的 edit 入口（editUserQuery command，用行内编辑文本替换该轮）。 */
  onEdit?: UserInputEditHandler;
  editWorkspaceRewindAvailability?: EditWorkspaceRewindAvailability;
  /** 嵌套在工具 Group 内时去掉 Reasoning 内容的重复左导线与缩进。 */
  reasoningContentVariant?: "default" | "nested";
  /** renderer-only 提交状态；不写入协议 row，也不冒充已 drain 的历史事实。 */
  userInputStatus?: string;
  /**
   * 一轮对用户是一个回复：非最后一段 text 不显示任何
   * action（复制/fork 都没有），入口只在轮尾段。
   */
  hideAssistantActions?: boolean;
  /** TurnGroup 需要把轮级 action 延后到文件 summary 后渲染。 */
  deferAssistantActions?: boolean;
  /** 轮尾段的复制内容 = 整轮全部 text 段合并（不是只复制最后一段）。 */
  assistantCopyText?: string;
  /** Assistant Preview Cards 只由 TurnGroup 为轮尾 terminal assistant text 计算后下发。 */
  assistantPreviewCards?: AssistantPreviewCard[];
  /** 仅当前 renderer 观察到 running -> complete 时下发的一次性自动打开身份。 */
  assistantPreviewCardsAutoOpenKey?: string;
  /** Assistant code-comment cards 只由 TurnGroup 为轮尾终态 assistant text 计算后下发。 */
  assistantCodeCommentCards?: AssistantCodeCommentCard[];
  /** 由 TurnGroup 统一裁决整轮正文是否隐藏 code-comment 协议原文。 */
  assistantCodeCommentProjectionEnabled?: boolean;
}

// ── 每种行拆成独立 memo 叶子：虚拟列表下父级重渲染时，只有 props 真变的行重渲染；
// 需要 hook 的行类型（assistantText/toolCall）hook 调用留在各自组件内，避免
// switch 分发组件里出现条件 hook。──

/**
 * 附件渲染：row 仍只保存 AttachmentRef；图片挂载时按 session/ref 分块读取缩略图，点击后复用已加载 URL 进入共享预览。
 * 非图片与失败后的图片保持纯展示，避免无动作的假手型。
 */
// 附件叶子：同时服务“已发送消息展示”和“行内编辑器（可删除）”。
// directItems 让调用方决定是否自己包一层 Attachments：媒体与文件两行需要共享外层 flex，
// 若叶子强制包裹，换行顺序就无法由父级控制。
// 两种形态共用同一份读取/预览状态机，靠 attachmentKind 与 onRemove 区分。
const UserInputAttachmentList = memo(function UserInputAttachmentList({
  attachments,
  attachmentIndices,
  entityId,
  attachmentKind = "all",
  directItems = false,
  onRemove,
  rowId,
  sessionId,
  readAttachment,
  readAttachmentRange,
}: {
  attachments: readonly AttachmentRef[] | undefined;
  /** 编辑态删除附件后仍保留其在持久 FilePart 列表中的原序号。 */
  attachmentIndices?: readonly number[];
  entityId?: string;
  attachmentKind?: "all" | "media" | "file";
  directItems?: boolean;
  onRemove?: (index: number) => void;
  rowId: number;
  sessionId?: string;
  readAttachment?: NonNullable<ConversationRowRenderContext["readAttachment"]>;
  readAttachmentRange?: NonNullable<ConversationRowRenderContext["readAttachmentRange"]>;
}) {
  // 文案全部走 intl：预览按钮的 aria-label 与 tooltip 需要随语言切换。
  // 这些 label 只在这里计算一次，传给所有附件条目，避免逐条 formatMessage。
  // 它们不进入依赖数组：语言变化会整体重渲染。
  const { intl } = useZCodeIntl();
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  // failedRefs 只记录缩略图读取失败的 ref：失败后不再显示可点手型，避免反复触发读取。
  // 它按 ref 而不是 index 记录：同一文件在消息里出现多次时，失败是资源级事实。
  // 集合更新用新 Set，保证 memo 化的子项能感知变化。
  const [failedRefs, setFailedRefs] = useState<ReadonlySet<string>>(() => new Set());
  // thumbnailUrls 是不可变快照，配合 ref 记账：state 触发渲染，ref 保证 cleanup 能拿到全部 URL。
  // 直接改 Map 再 setState(同一个 Map) 不会触发渲染，因此每次都要 new Map。
  // 两套结构必须同增同删，否则会把已释放的 URL 继续渲染成碎图。
  const [thumbnailUrls, setThumbnailUrls] = useState<ReadonlyMap<string, string>>(() => new Map());
  // 可见消息行预取 image/video Blob：图片直接显示，视频由无控件播放器展示首帧；
  // video URL 同时供 gallery 复用，避免用户点击后再次读取大文件。
  // 视频预览先挂载 Dialog 再异步读：这样用户能立刻看到加载态，而不是点击后无反应。
  // 预览对象在读取前只有 filename/mediaType，url 在成功后才补上。
  // 失败时对象保留、error 置真，Dialog 内部展示错误而不是关闭。
  const [videoPreview, setVideoPreview] = useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [videoPreviewRef, setVideoPreviewRef] = useState<string | null>(null);
  const [videoPreviewLoading, setVideoPreviewLoading] = useState(false);
  const [videoPreviewError, setVideoPreviewError] = useState(false);
  const [textPreview, setTextPreview] = useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState(false);
  // 文本预览的 AbortController 用 ref 持有：关闭/切换时必须中止上一次读取。
  // 用 ref 而不是 state：中止动作发生在事件回调里，不需要触发渲染。
  // 每次打开都新建 controller，旧 controller 先 abort，天然实现“最后一次生效”。
  const textReadAbort = useRef<AbortController | null>(null);
  // 卸载时统一 abort：否则读取完成后的 setState 会落在已卸载组件上。
  useEffect(() => () => textReadAbort.current?.abort(), []);
  // 关闭文本预览先中断请求再清空数据，避免迟到的响应把 Dialog 重新填上内容。
  // 同时把 ref 置空：否则下一次打开会 abort 一个已结束的 controller。
  // 关闭不释放额外资源：文本预览没有 object URL。
  const closeTextPreview = () => {
    textReadAbort.current?.abort();
    textReadAbort.current = null;
    setTextPreview(null);
  };
  // [资源] 文本预览按需读取整块 bytes；sessionId/readAttachment 缺失时直接返回，
  // 文本没有缩略图，只能整块读；大文本由服务端限制大小，前端不做额外截断。
  // 解码用 TextDecoder 默认 UTF-8，与服务端写入编码一致。
  // 不进入 loading，避免出现永远转圈的 Dialog。
  const openTextPreview = async (attachment: AttachmentRef, index: number) => {
    // 没有读取通道就没有预览能力：静默返回比抛错更符合“只读历史”场景。
    if (!sessionId || !readAttachment) return;
    // 打开文本预览先 abort 掉 textReadAbort 上的上一次请求：连续点击不同附件时，只允许最后一次结果落地。
    textReadAbort.current?.abort();
    const controller = new AbortController();
    textReadAbort.current = controller;
    setTextPreview({ filename: attachment.fileName, mediaType: "text/plain" });
    setTextLoading(true);
    setTextError(false);
    // 先展示空壳 + loading，再等 bytes：TextDecoder 解码放在成功分支，失败时保留错误态。
    try {
      const result = await readAttachment({
        sessionId,
        ref: attachment.ref,
        mediaType: attachment.mime,
        ...(entityId ? { target: { rowId, entityId }, attachmentIndex: index } : {}),
        signal: controller.signal,
      });
      // abort 后不再写任何 state：关闭动作已经把状态清空，迟到结果不能复活它。
      if (controller.signal.aborted) return;
      if (!("bytes" in result)) throw new Error("Text attachment bytes unavailable");
      setTextPreview({
        filename: attachment.fileName,
        mediaType: "text/plain",
        textContent: new TextDecoder().decode(result.bytes),
      });
    // [失败路径] 读取失败只标记错误并记日志，不关闭 Dialog：用户能看到文件名与失败提示。
    } catch (error) {
      if (!controller.signal.aborted) {
        setTextError(true);
        logger.warn("Text attachment preview failed", error);
      }
    // abort 时不关闭 loading：状态已由关闭流程重置，这里再写会与关闭竞争。
    } finally {
      if (!controller.signal.aborted) setTextLoading(false);
    }
  };
  // PDF 预览状态与视频同构：ref 记录当前预览对象身份，loading/error 各自独立。
  // pdfPreviewRef 同时作为 Dialog 的 open 判据：为 null 即关闭。
  // 三者分离是为了让“加载中”与“失败”都能保留同一个文件身份用于标题展示。
  const [pdfPreview, setPdfPreview] = useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [pdfPreviewLoading, setPdfPreviewLoading] = useState(false);
  const [pdfPreviewError, setPdfPreviewError] = useState(false);
  const [pdfPreviewRef, setPdfPreviewRef] = useState<string | null>(null);
  // 三个 ref 分别负责：已创建的 object URL、请求序号、可中止的传输。
  // 序号与 abort 并用：abort 停止传输，序号兜住“abort 之后仍 resolve”的实现差异。
  // 关闭流程必须同时推进三者，缺一项都会留下悬挂请求或泄漏 URL。
  // 请求序号用于丢弃迟到结果；object URL 只由本组件创建、也只由本组件释放。
  const pdfPreviewUrlRef = useRef<string | null>(null);
  const pdfPreviewRequestRef = useRef(0);
  const pdfPreviewAbortRef = useRef<AbortController | null>(null);
  const videoPreviewUrlRef = useRef<string | null>(null);
  const videoPreviewRequestRef = useRef(0);
  const videoPreviewAbortRef = useRef<AbortController | null>(null);
  const thumbnailUrlsRef = useRef<Map<string, string>>(new Map());
  const thumbnailObjectUrlsRef = useRef<Set<string>>(new Set());
  const previewOpenLabel = intl.formatMessage({
    id: "chat.attachments.preview.open",
  });
  const previewVideoOpenLabel = intl.formatMessage({
    id: "chat.attachments.preview.openVideo",
  });
  const previewPdfOpenLabel = intl.formatMessage({
    id: "chat.attachments.preview.openPdf",
  });
  const previewUnavailableLabel = intl.formatMessage({
    id: "chat.attachments.preview.unavailable",
  });

  // [资源] 缩略图预取：只对 image/video 生效，且只在可见行挂载时执行。
  // 依赖里包含 attachments/rowId/entityId：同一条行换消息内容时必须重新预取。
  // 不依赖 thumbnailUrls，避免预取写 state 后自己触发自己。
  // 预取结果同时供画廊复用，避免用户点击后再次读取大文件。
  useEffect(() => {
    if (attachmentKind === "file" || !attachments || !sessionId || !readAttachment) {
      return;
    }
    // cancelled 与 controller.signal 双保险：signal 停传输，cancelled 阻止 await 之后写状态。
    let cancelled = false;
    // 只丢弃读取结果不会停止底层分块传输，消息行卸载后仍可能拉取完整视频。
    // 预取生命周期必须通过 AbortSignal 贯穿 transport，及时释放文件 IO 与 IPC 资源。
    // 一个 effect 一个 controller：cleanup 时 abort 会把同一批所有附件读取一起取消。
    // 不按附件各建 controller：行级挂载/卸载是同一生命周期，分批取消没有收益。
    // controller 只在 effect 内可见，不放进 ref，避免跨渲染复用失效信号。
    const controller = new AbortController();
    const mediaAttachments = attachments.flatMap((attachment, index) =>
      attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/")
        // 非媒体附件不预取：文本/PDF 体积不可控，按需读取更安全。
        ? [{ attachment, index }]
        : [],
    );

    // V4 虚拟列表只挂载可见行，避免扫描整段历史。视频仍使用稳定 row target，
    // 保证同一路径多次发送时缩略图来自当前消息的 durable artifact。
    // 并行读取全部媒体：行内附件通常个位数，串行会让首屏缩略图逐个出现。
    // 单个失败不影响其它：每个任务内部 catch，Promise.all 永远不会 reject。
    // 因此这里不需要 catch，只需要在 cleanup 处理取消。
    // Promise.all 不被 await，effect 的清理只依赖 abort，不等待读取完成。
    void Promise.all(
      mediaAttachments.map(async ({ attachment, index }) => {
        const ref = attachment.previewRef ?? attachment.ref;
        const isVideo = attachment.mime.startsWith("video/");
        try {
          // 视频带 mediaType 与稳定 row target：同一路径多次发送时，缩略图必须来自本消息的产物。
          // 图片只按 ref 读取：缩略图是纯展示资源，不需要绑定消息身份。
          // attachmentIndices 映射可见序到持久序，删除过附件后二者才会不同。
          const result = await readAttachment({
            sessionId,
            ref,
            signal: controller.signal,
            ...(isVideo ? { mediaType: attachment.mime } : {}),
            ...(isVideo && entityId
              ? {
                  target: { rowId, entityId },
                  attachmentIndex: attachmentIndices?.[index] ?? index,
                }
              : {}),
          });
          // 读取完成后再判一次 cancelled：abort 与 resolve 可能同时发生。
          if (cancelled) return;
          const isLocalUrl = "url" in result;
          const url = isLocalUrl
            ? result.url
            : URL.createObjectURL(
                new Blob([Uint8Array.from(result.bytes)], {
                  type: result.mediaType,
                }),
              );
          // [资源] 只把本组件创建的 Blob URL 记入 objectUrls；本地协议 URL 不参与释放。
          if (!isLocalUrl) thumbnailObjectUrlsRef.current.add(url);
          if (cancelled) {
            if (!isLocalUrl) {
              thumbnailObjectUrlsRef.current.delete(url);
              URL.revokeObjectURL(url);
            }
            return;
          }
          // ref 是真相，state 是快照：先写 ref 再 new Map 触发渲染，保证 cleanup 能释放全部。
          thumbnailUrlsRef.current.set(ref, url);
          setThumbnailUrls(new Map(thumbnailUrlsRef.current));
  // [失败路径] 图片失败会禁用点击（failedRefs）；视频失败不标记，允许下次重试预览。
        } catch (error) {
          if (cancelled || controller.signal.aborted) return;
          if (!isVideo) setFailedRefs((current) => new Set(current).add(ref));
          logger.warn(
            `[v4-attachment-preview] failed to read sent ${isVideo ? "video" : "image"} thumbnail`,
            error,
          );
        }
      }),
    );

    // [资源] cleanup 三件事：停传输、标记取消、释放本 effect 创建的 URL。
    // 先 abort 再清 map：abort 可能同步触发 catch，此时 cancelled 已为真，不会写状态。
    // 不把 controller 存进 ref：effect 重跑时旧 controller 已在 cleanup 中被 abort。
    // 不清理 ref 里的 map 会让下一次挂载复用失效 URL；不 abort 会让传输在卸载后继续跑。
    return () => {
      controller.abort();
      cancelled = true;
      // Desktop local video 返回自定义协议 URL，不是 renderer 创建的 Blob；
      // 只释放本 effect 创建的 object URL，避免把本地媒体 URL 当成 Blob 生命周期管理。
      for (const url of thumbnailObjectUrlsRef.current) URL.revokeObjectURL(url);
      thumbnailObjectUrlsRef.current.clear();
      thumbnailUrlsRef.current.clear();
    };
  }, [attachmentIndices, attachmentKind, attachments, entityId, readAttachment, rowId, sessionId]);

  // ── sent video 预览读取：staging 语义原样保留 ──
  // 释放视频预览 URL：只释放本组件创建的那个，且置空引用保证幂等。
  const releaseVideoPreviewUrl = useCallback(() => {
    if (!videoPreviewUrlRef.current) return;
    URL.revokeObjectURL(videoPreviewUrlRef.current);
    videoPreviewUrlRef.current = null;
  }, []);

  // 取消视频预览读取用“序号自增 + abort”：序号让迟到结果失效，abort 停止传输。
  // 两者缺一不可：只 abort 时某些实现仍可能 resolve。
  const cancelVideoPreviewRead = useCallback(() => {
    videoPreviewRequestRef.current += 1;
    videoPreviewAbortRef.current?.abort();
    videoPreviewAbortRef.current = null;
  }, []);

  // 卸载兜底：视频读取与 URL 都必须在这里释放，不能依赖用户点关闭。
  useEffect(
    () => () => {
      cancelVideoPreviewRead();
      releaseVideoPreviewUrl();
    },
    [cancelVideoPreviewRead, releaseVideoPreviewUrl],
  );

  // 关闭视频预览：取消读取、释放 URL、清空四个状态，顺序保证不会闪回旧帧。
  // 先取消再释放：若先释放，仍可能在飞的 resolve 写回一个已释放的 URL。
  // 清空 videoPreviewRef 同时关闭 Dialog，二者必须同批更新。
  const closeVideoPreview = useCallback(() => {
    cancelVideoPreviewRead();
    releaseVideoPreviewUrl();
    setVideoPreview(null);
    setVideoPreviewRef(null);
    setVideoPreviewLoading(false);
    setVideoPreviewError(false);
  }, [cancelVideoPreviewRead, releaseVideoPreviewUrl]);

  // 关闭 PDF 预览与视频同构；PDF 的 range 读取还持有同一个 abortController。
  // range 回调闭包持有 controller，关闭后查看器再请求会立即失败，这是预期行为。
  // 释放 URL 只针对整块读取分支；range 分支没有创建 object URL。
  const closePdfPreview = useCallback(() => {
    pdfPreviewRequestRef.current += 1;
    pdfPreviewAbortRef.current?.abort();
    pdfPreviewAbortRef.current = null;
    if (pdfPreviewUrlRef.current) URL.revokeObjectURL(pdfPreviewUrlRef.current);
    pdfPreviewUrlRef.current = null;
    setPdfPreview(null);
    setPdfPreviewRef(null);
    setPdfPreviewLoading(false);
    setPdfPreviewError(false);
  }, []);

  // PDF 卸载兜底：与视频分开注册，避免任一分支遗漏资源释放。
  useEffect(
    () => () => {
      closePdfPreview();
    },
    [closePdfPreview],
  );

  // [资源] 打开视频预览：若缩略图已有 URL 直接复用，否则按稳定 target 读取完整媒体。
  // 复用分支不设置 loading：缩略图已经是可播放资源，再显示转圈反而像卡住。
  // 读取分支先清空旧 URL，保证 Dialog 不会短暂播放上一个视频。
  // 两条路径都要先取消上一次请求，保证同一时刻只有一个预览请求在飞。
  const openVideoPreview = useCallback(
    async (attachment: AttachmentRef, attachmentIndex: number, galleryIndex: number) => {
      // 无读取通道直接返回：不发请求、不改状态，避免出现空 Dialog。
      if (!sessionId || !readAttachment) return;
      const ref = attachment.previewRef ?? attachment.ref;
      cancelVideoPreviewRead();
      // 缩略图命中时不需要再读：video 的首帧与完整视频共用同一个 Blob，
      // 复用可以避免用户点击后等待一次大文件传输。
      const thumbnailUrl = thumbnailUrlsRef.current.get(ref);
      if (thumbnailUrl) {
        releaseVideoPreviewUrl();
        setPreviewIndex(galleryIndex);
        setPreviewOpen(true);
        setVideoPreviewRef(ref);
        setVideoPreview({
          filename: attachment.fileName,
          mediaType: attachment.mime,
          url: thumbnailUrl,
        });
        setVideoPreviewLoading(false);
        setVideoPreviewError(false);
        return;
      }
      // 请求序号在发起前读取：后续任何一次新的打开都会自增它，从而让本次结果失效。
      const requestId = videoPreviewRequestRef.current;
      const abortController = new AbortController();
      videoPreviewAbortRef.current = abortController;
      releaseVideoPreviewUrl();
      setPreviewIndex(galleryIndex);
      setPreviewOpen(true);
      setVideoPreviewRef(ref);
      setVideoPreview({
        filename: attachment.fileName,
        mediaType: attachment.mime,
      });
      setVideoPreviewLoading(true);
      setVideoPreviewError(false);
      try {
        const result = await readAttachment({
          sessionId,
          ref,
          mediaType: attachment.mime,
          // 有 entityId 时按稳定 row target 精确读取；否则退回按 ref 匹配。
          ...(entityId ? { target: { rowId, entityId }, attachmentIndex } : {}),
          signal: abortController.signal,
        });
        // 序号不匹配说明用户已切换到别的附件：丢弃结果，不写任何状态。
        if (videoPreviewRequestRef.current !== requestId) return;
        const isLocalUrl = "url" in result;
        const url = isLocalUrl
          ? result.url
          : URL.createObjectURL(
              new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }),
            );
        // [资源] 序号在创建 URL 之后又变化：必须立刻释放刚创建的 URL，否则泄漏。
        if (videoPreviewRequestRef.current !== requestId) {
          if (!isLocalUrl) URL.revokeObjectURL(url);
          return;
        }
        videoPreviewUrlRef.current = isLocalUrl ? null : url;
        setVideoPreview({
          filename: attachment.fileName,
          mediaType: result.mediaType,
          url,
        });
    // [失败路径] 读取失败只标记 error，不关闭 Dialog、不永久禁用入口：
    // 每次打开都重新读取，错误在 Dialog 内展示。
      } catch (error) {
        if (videoPreviewRequestRef.current !== requestId) return;
        // 一次 read 失败曾永久禁用附件入口，把可否打开 Dialog 错绑到读取结果。
        // 失败只属于本次预览；保留入口，让每次打开都重新读取并在 Dialog 内展示错误。
        setVideoPreviewError(true);
        logger.warn("[v4-attachment-preview] failed to read sent media", error);
    // 只有仍是最新请求才清 loading/abort 引用；否则会把新请求的状态清掉。
      } finally {
        if (videoPreviewRequestRef.current === requestId) {
          videoPreviewAbortRef.current = null;
          setVideoPreviewLoading(false);
        }
      }
    },
    [cancelVideoPreviewRead, entityId, readAttachment, releaseVideoPreviewUrl, rowId, sessionId],
  );

  // PDF 打开：优先用 range 读取（大文件不整块进内存），没有 range 通道时退回整块读取。
  // 两条路径共用请求序号：任何一次新的打开都会让旧路径的结果失效。
  // range 模式把 requestRange 交给查看器，翻页由查看器驱动，本组件不缓存分块。
  // 两条路径都必须带同一 abortController，关闭时才能一起停。
  const openPdfPreview = useCallback(
    async (attachment: AttachmentRef, attachmentIndex: number) => {
      // 两个通道都缺才返回；只有其中一个也能工作。
      if (!sessionId || (!readAttachment && !readAttachmentRange)) return;
      const ref = attachment.previewRef ?? attachment.ref;
      // 序号自增先于 abort：即使 abort 不生效，迟到结果也会因序号不匹配被丢弃。
      // abort 旧 controller 后立即置空，避免 finally 分支把新请求的引用清掉。
      // 这一步同时承担“关闭上一次预览”的职责：新打开天然互斥。
      pdfPreviewRequestRef.current += 1;
      const requestId = pdfPreviewRequestRef.current;
      pdfPreviewAbortRef.current?.abort();
      const abortController = new AbortController();
      pdfPreviewAbortRef.current = abortController;
      if (pdfPreviewUrlRef.current) URL.revokeObjectURL(pdfPreviewUrlRef.current);
      pdfPreviewUrlRef.current = null;
      setPdfPreviewRef(ref);
      setPdfPreview({ filename: attachment.fileName, mediaType: "application/pdf" });
      setPdfPreviewLoading(true);
      setPdfPreviewError(false);
      try {
        const target = entityId ? { target: { rowId, entityId }, attachmentIndex } : {};
        // range 模式的首次读取同时拿到 totalBytes 与首块数据，PDF 查看器据此按需再取。
        if (readAttachmentRange) {
          const firstRange = await readAttachmentRange({
            sessionId,
            ref,
            ...target,
            offset: 0,
            limit: 256 * 1024,
            signal: abortController.signal,
          });
          // requestRange 闭包复用同一 sessionId/ref/target：查看器翻页时不需要重新解析身份。
          const source: PdfViewerRangeSource = {
            totalBytes: firstRange.totalBytes,
            initialData: firstRange.bytes,
            requestRange: async (offset, limit) => {
              const range = await readAttachmentRange({
                sessionId,
                ref,
                ...target,
                offset,
                limit,
                signal: abortController.signal,
              });
              return range.bytes;
            },
          };
          // 首块读取后以 pdfPreviewRequestRef 复核 requestId：期间被关闭或被另一次打开取代就丢弃，避免旧内容灌进新 Dialog。
          // 只有仍是最新请求才 setPdfPreview，否则会把旧文件内容灌进新 Dialog。
          // totalBytes 来自首块响应，查看器据此显示总页数/总大小。
          if (pdfPreviewRequestRef.current !== requestId) return;
          setPdfPreview({
            filename: attachment.fileName,
            mediaType: firstRange.mediaType,
            pdfSource: source,
          });
          return;
        }
        // 没有 range 通道又没有整块通道：直接返回，保持 loading=false 的初始态。
        if (!readAttachment) return;
        const result = await readAttachment({
          sessionId,
          ref,
          ...target,
          signal: abortController.signal,
        });
        // 整块读取同样要校验序号；PDF 体积大，迟到结果覆盖的代价更高。
        // 只有 Blob 分支才记录 object URL；本地协议 URL 由 Desktop 管理，不参与释放。
        // mediaType 用响应值而不是入参：服务端可能纠正 application/octet-stream。
        if (pdfPreviewRequestRef.current !== requestId) return;
        const url =
          "url" in result
            ? result.url
            : URL.createObjectURL(
                new Blob([Uint8Array.from(result.bytes)], { type: result.mediaType }),
              );
        if (!("url" in result)) pdfPreviewUrlRef.current = url;
        setPdfPreview({
          filename: attachment.fileName,
          mediaType: result.mediaType,
          url,
        });
    // [失败路径] PDF 失败只进错误态；Dialog 仍打开，用户可以关闭后重试。
      } catch (error) {
        if (pdfPreviewRequestRef.current !== requestId) return;
        setPdfPreviewError(true);
        logger.warn("[v4-attachment-preview] failed to read sent PDF", error);
    // 清理 abort 引用与 loading 只在最新请求时进行，避免踩掉后续请求的状态。
      } finally {
        if (pdfPreviewRequestRef.current === requestId) {
          pdfPreviewAbortRef.current = null;
          setPdfPreviewLoading(false);
        }
      }
    },
    [entityId, readAttachment, readAttachmentRange, rowId, sessionId],
  );

  // 可见附件按 attachmentKind 过滤：media 只保留图片/视频，file 只保留其余。
  // “其余”包含 PDF、文本与任意二进制；判定只看 MIME 前缀，不看扩展名。
  // 过滤结果保留原 index，是删除与按块读取能够正确对应的前提。
  // 过滤保留原始 index，后续读取与删除都依赖它。
  const visibleAttachments = (attachments ?? [])
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ attachment }) => {
      if (attachmentKind === "all") return true;
      const isMedia = attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/");
      return attachmentKind === "media" ? isMedia : !isMedia;
    });
  // 编辑器内把媒体排到前面，与输入框“媒体 → 文件”的视觉顺序一致；
  // sort 只改渲染顺序，index 仍指向原数组。
  if (attachmentKind === "all") {
    // 行内编辑器过去直接沿用只读消息的通用附件列表，既没有按输入框的
    // “媒体 → 文件”视觉顺序排列，也误用了已发送消息的 pill。排序只改变渲染顺序，
    // index 仍指向原数组，避免删除后提交错误的附件。
    visibleAttachments.sort(
      ({ attachment: left }, { attachment: right }) =>
        Number(right.mime.startsWith("image/") || right.mime.startsWith("video/")) -
        Number(left.mime.startsWith("image/") || left.mime.startsWith("video/")),
    );
  }
  // 没有可见附件就整体不渲染：调用方可能传了附件但全被 kind 过滤掉。
  if (visibleAttachments.length === 0) return null;
  // 画廊条目只包含有缩略图的图片与可读取的视频；图片缺图不入画廊，避免空白页。
  const previewEntries = (attachments ?? []).flatMap((attachment, index) => {
    const isImage = attachment.mime.startsWith("image/");
    const isVideo = attachment.mime.startsWith("video/");
    if (!isImage && !isVideo) return [];
    const ref = attachment.previewRef ?? attachment.ref;
    const src = thumbnailUrls.get(ref);
    if (isImage && !src) return [];
    return [
      {
        attachment,
        index,
        persistedAttachmentIndex: attachmentIndices?.[index] ?? index,
      },
    ];
  });
  // 画廊 item 的 src/loading/error 只对“当前激活的视频”生效，图片始终用缩略图。
  const previewItems = previewEntries.map(({ attachment }) => {
    const ref = attachment.previewRef ?? attachment.ref;
    const isVideo = attachment.mime.startsWith("video/");
    return {
      alt: attachment.fileName,
      filename: attachment.fileName,
      mediaType: attachment.mime,
      src: isVideo && videoPreviewRef === ref ? videoPreview?.url : thumbnailUrls.get(ref),
      loading: isVideo && videoPreviewRef === ref && videoPreviewLoading,
      error: isVideo && videoPreviewRef === ref && videoPreviewError,
    };
  });
  // 切换画廊条目：视频走异步读取，图片只更新 index 并打开 Dialog。
  const selectPreviewItem = (galleryIndex: number) => {
    const entry = previewEntries[galleryIndex];
    if (!entry) return;
    if (entry.attachment.mime.startsWith("video/")) {
      void openVideoPreview(entry.attachment, entry.persistedAttachmentIndex, galleryIndex);
      return;
    }
    cancelVideoPreviewRead();
    releaseVideoPreviewUrl();
    setVideoPreview(null);
    setVideoPreviewRef(null);
    setVideoPreviewLoading(false);
    setVideoPreviewError(false);
    setPreviewIndex(galleryIndex);
    setPreviewOpen(true);
  };
  // 单个附件条目由 canOpen 与 onOpen 同一组布尔推导：先定能力再定样式与内容分支，避免“看起来能点但点击无反应”。
  // canOpen 与 onOpen 是同一件事的两个投影：前者决定是否显示手型与 tooltip，后者决定行为。
  // 二者必须由同一组布尔推导，否则会出现“看起来能点但点击无反应”。
  // 这里的布尔组合决定了 6 种视觉形态，改动前先确认 canOpen 与 isThumbnail 的对应关系。
  const items = visibleAttachments.map(({ attachment, index }) => {
    const isTextMaterial =
      attachment.sourceKind === "topic-history" || attachment.sourceKind === "clipboard-text";
    const ref = attachment.previewRef ?? attachment.ref;
    const isImage = attachment.mime.startsWith("image/");
    const isVideo = attachment.mime.startsWith("video/");
    const isPdf = attachment.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
    const isMedia = isImage || isVideo;
    const isEditingAttachment = attachmentKind === "all";
    const isThumbnail = attachmentKind === "media" || (isEditingAttachment && isMedia);
    const fileDisplayDescriptor = resolveFileDisplayDescriptor(attachment.fileName);
    // 读取失败只影响“能否打开”，不影响展示：文件名与类型标签仍然可见。
    // 失败时把 title 设为“不可预览”，比整条隐藏更有利于用户理解。
    // 重新发送同一附件会得到新的 ref，从而自动脱离失败集合。
    const isUnavailable = failedRefs.has(ref);
    const thumbnailUrl = thumbnailUrls.get(ref) ?? "";
    const previewItemIndex = previewEntries.findIndex((entry) => entry.index === index);
    // 图片与视频共用当前消息的媒体 gallery；video 首次成为 active item 时再读取。
    const canOpen =
      (isTextMaterial && Boolean(sessionId && readAttachment)) ||
      (isImage && !isUnavailable && previewItemIndex >= 0) ||
      (isVideo && Boolean(sessionId && readAttachment)) ||
      (isPdf && Boolean(sessionId && (readAttachment || readAttachmentRange)));
    // 打开能力按附件类型分流：文本/PDF/媒体各有独立通道，任一缺失即不可点。
    // 文本与 PDF 需要完整读取通道；媒体可以先靠缩略图打开画廊。
    // 失败图片被排除在画廊之外，因此 !isUnavailable 也要参与判定。
    return (
      <Attachment
        key={`${attachment.ref}-${index}`}
        variant={isThumbnail ? "grid" : "inline"}
        data-v4-user-edit-attachment-kind={
          isEditingAttachment
            ? isImage
              ? "image"
              : isVideo
                ? "video"
                : isPdf
                  ? "pdf"
                  : "file"
            : undefined
        }
        data-v4-user-input-attachment-pill={isThumbnail ? undefined : "true"}
        data-v4-user-input-media-attachment={isThumbnail ? "true" : undefined}
        className={cn(
          isThumbnail &&
            (isEditingAttachment
              ? "relative size-12 overflow-hidden rounded-lg bg-surface p-0 after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:border after:border-border after:content-[''] hover:bg-surface-hover"
              : "relative size-20 overflow-hidden rounded-xl bg-surface p-0 after:pointer-events-none after:absolute after:inset-0 after:rounded-xl after:border after:border-border after:content-[''] hover:bg-surface-hover"),
          !isThumbnail &&
            (isEditingAttachment
              ? "h-12 w-fit max-w-full min-w-0 gap-2 rounded-lg border border-border bg-surface p-1.5 pr-6 [--attachment-bg:var(--color-surface)] hover:bg-surface-hover"
              : "rounded-full border-0 bg-surface px-3 py-1.5 hover:bg-surface-hover"),
        )}
        // 只有编辑态传 onRemove；只读消息不出现删除按钮。
        // onRemove 由父级传入，叶子不自行判断权限：谁能编辑由上层决定。
        // 删除回调携带可见序 index，父级负责同步两个数组。
        onRemove={onRemove ? () => onRemove(index) : undefined}
        // onOpen 为 undefined 时 Attachment 不渲染手型与键盘入口，避免假可点。
        onOpen={
          canOpen
            ? () =>
                isTextMaterial
                  ? void openTextPreview(attachment, attachmentIndices?.[index] ?? index)
                  : isPdf
                    ? void openPdfPreview(attachment, attachmentIndices?.[index] ?? index)
                    : selectPreviewItem(previewItemIndex)
            : undefined
        }
        openLabel={
          canOpen
            ? isTextMaterial
              ? intl.formatMessage({ id: "chat.attachments.preview.openText" })
              : isVideo
                ? previewVideoOpenLabel
                : isPdf
                  ? previewPdfOpenLabel
                  : previewOpenLabel
            : undefined
        }
        // 失败态用 title 说明原因；成功态不占用 tooltip，交给 Attachment 自己处理。
        title={isUnavailable ? previewUnavailableLabel : undefined}
        data={{
          id: `${rowId}-${index}`,
          type: "file",
          filename: attachment.fileName,
          mediaType: attachment.mime,
          url: thumbnailUrl,
        }}
      >
        {isThumbnail ? (
          <div className="relative size-full">
            <AttachmentPreview className="size-full rounded-none" />
          </div>
        ) : isEditingAttachment ? (
          <>
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-background">
              <FileDisplayIcon
                src={fileDisplayDescriptor.fileIconSrc}
                size={16}
                className="size-4 shrink-0"
              />
            </div>
            <div className="min-w-0 max-w-40 flex-1">
              <span
                className="block truncate text-ui-base font-medium text-foreground"
                title={attachment.fileName}
              >
                {attachment.fileName}
              </span>
              <span className="block truncate text-ui-sm font-normal text-foreground-subtle">
                {getAttachmentTypeLabel(attachment.fileName, attachment.mime)}
              </span>
            </div>
          </>
        ) : attachment.sourceKind === "topic-history" ? (
          <span className="truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage(
              { id: "chat.attachments.topicHistory" },
              { count: attachment.messageCount ?? 0 },
            )}
          </span>
        ) : (
          <FileDisplayInline
            path={attachment.fileName}
            options={{
              className: "inline-flex min-w-0 max-w-40 items-center gap-1.5",
              iconSize: 16,
              fileNameClassName: "truncate text-ui-base font-medium text-foreground",
            }}
          />
        )}
        {onRemove && isEditingAttachment ? (
          <AttachmentRemove
            placement="corner"
            size="icon"
            variant="default"
            aria-label={intl.formatMessage({ id: "chat.attachments.remove" })}
            label={intl.formatMessage({ id: "chat.attachments.remove" })}
            data-testid={testId(TID_V4_EDIT_ATTACHMENT_REMOVE, `${rowId}-${index}`)}
            className="absolute top-0.5 right-0.5 z-10 size-3.5 rounded-full p-0 text-primary-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <XIcon className="size-2.5" />
          </AttachmentRemove>
        ) : null}
      </Attachment>
    );
  });
  return (
    <>
      {directItems ? (
        items
      ) : (
        <Attachments
          variant="inline"
          data-testid={testId(TID_V4_ROW_ATTACHMENTS, String(rowId))}
          className="max-w-full gap-2"
        >
          {items}
        </Attachments>
      )}
      <ChatMediaAttachmentPreviewDialog
        attachment={textPreview}
        open={textPreview !== null}
        onOpenChange={(open) => {
          if (!open) closeTextPreview();
        }}
        loading={textLoading}
        error={textError}
      />
      <ImagePreviewDialog
        initialIndex={previewIndex}
        items={previewItems}
        onActiveIndexChange={selectPreviewItem}
        onOpenChange={(open) => {
          if (open) {
            setPreviewOpen(true);
            return;
          }
          setPreviewOpen(false);
          closeVideoPreview();
        }}
        open={previewOpen}
      />
      <ChatMediaAttachmentPreviewDialog
        attachment={pdfPreview}
        open={pdfPreviewRef !== null}
        loading={pdfPreviewLoading}
        error={pdfPreviewError}
        onOpenChange={(open) => {
          if (!open) closePdfPreview();
        }}
      />
    </>
  );
});

// userInput 行：只读气泡 + 行内编辑。编辑态整体替换为 ChatPromptEditor，
// 提交走 editUserQuery：它以 (rowId, entityId) 定位这一轮，而不是靠文本匹配。
// 因此同一文本重复出现时也不会改错轮次。
// 提交时把正文、上下文引用与附件一起交给 onEdit（editUserQuery）。
const SingleUserInputRowView = memo(function SingleUserInputRowView({
  row,
  context,
  onEdit,
  editWorkspaceRewindAvailability,
  status,
}: {
  row: UserInputRow;
  context: ConversationRowRenderContext;
  onEdit?: UserInputEditHandler;
  editWorkspaceRewindAvailability?: EditWorkspaceRewindAvailability;
  status?: string;
}) {
  const { intl } = useZCodeIntl();
  // 引擎尾注折叠：正文只到 epilogueStart，
  // 之后的引擎文本折进气泡底部的披露。提示词上下文解析也只看正文——尾注里没有用户引用。
  const { body: bodyText, epilogue } = splitUserInputEpilogue(row.text, row.epilogueStart);
  // 提示词上下文解析只作用于正文：尾注是引擎文本，里面没有用户引用。
  // 解析结果按 workspacePath 缓存：同一正文在不同工作区可能解析出不同文件引用。
  // conversationQuotes 来自协议字段，直接并进解析结果，不重新解析正文。
  // 解析结果同时供只读展示（chips）与编辑初值使用，避免两处规则不一致。
  const parsedPrompt = useMemo(
    () => ({
      ...parseComposerPromptContexts(bodyText, {
        workspacePath: context.workspacePath,
        workspaceIdentity: context.workspaceIdentity,
      }),
      ...(row.conversationQuotes ? { conversationSelections: row.conversationQuotes } : {}),
    }),
    [context.workspaceIdentity, context.workspacePath, bodyText, row.conversationQuotes],
  );
  // 只用于把历史消息里的 share URL 尾块从可见正文里剥掉。
  // 该块已不再产出（见 ConversationComposer 的 promptText 注释）；这里保留解析，是为了让
  // 接线修复到本次删除之间发出的消息不至于把裸 markup 当正文显示出来。
  // 历史消息可能残留 share URL 尾块：从可见正文剥掉，但保留解析以便识别裸 markup。
  // 该块已不再产出，这里只为兼容旧消息；新消息的 visibleContent 与 row.text 一致。
  // 复制仍用 row.text：用户复制到的是原始输入，包含已被隐藏的 share 块。
  const parsedShareContext = useMemo(
    () => parseConversationShareContext(parsedPrompt.visibleContent),
    [parsedPrompt.visibleContent],
  );
  // 编辑态是纯本地 UI 状态：不写入协议 row，刷新后回到只读。
  const [editing, setEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // draft 初值是“剥掉尾注与 share 块”的可见正文，而不是 row.text。
  const [draft, setDraft] = useState(row.text);
  // 编辑附件是 row.attachments 的浅拷贝：删除只影响草稿，取消即丢弃。
  // AttachmentRef 是不可变对象，浅拷贝足够；不需要深拷贝 bytes。
  // 初值在进入编辑与取消时各重建一次，保证与最新投影一致。
  const [editAttachments, setEditAttachments] = useState<AttachmentRef[]>(() => [
    ...(row.attachments ?? []),
  ]);
  // 编辑态删除附件后，持久 FilePart 列表仍保留全部附件；序号数组把可见列表
  // 映射回原 index，避免 video 预览等按 attachmentIndex 的读取指错分块。
  // 序号数组与 editAttachments 同长同序：删除时两者必须同步删。
  const [editAttachmentIndices, setEditAttachmentIndices] = useState<number[]>(() =>
    (row.attachments ?? []).map((_, index) => index),
  );
  // 编辑态的上下文引用也独立成 state：用户可以在提交前逐个移除。
  const [editPromptContexts, setEditPromptContexts] = useState(() => parsedPrompt);
  // 冲突预览来自 editUserQuery 的 blocked 结果：需要同时控制数据与 Dialog 开关。
  // 数据与开关分开存：关闭 Dialog 后仍保留 preview，便于用户再次打开查看。
  // 成功提交时两者一起清空，避免残留旧冲突影响下一轮。
  const [conflictPreview, setConflictPreview] =
    useState<V4ConversationFileRewindPreviewResult | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  // 编辑器句柄用于进入编辑态后自动聚焦；不参与提交。
  // 句柄类型来自 LexicalChatInputHandle，提交走编辑器自己的 onSubmit。
  // 这里只调用 focus，不读写选区，避免与编辑器的内部状态竞争。
  const inputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const editContextCount = countComposerPromptContexts(editPromptContexts);
  // 可提交 = 有正文或有附件或有上下文引用；三者任一即可，空提交被服务端拒绝没有意义。
  // 与 ChatPromptEditor 的 allowSubmitWhenEmpty 配合：只有附件/引用时也允许提交。
  // 两个条件必须同源：submitDisabled 用 !canSubmit，编辑器内部再按 allowSubmitWhenEmpty 放行。
  // 只改一处会导致“按钮亮但提交无效”或反之。
  // 判定使用 trim 后的正文，纯空白不算内容。
  const canSubmit = draft.trim().length > 0 || editAttachments.length > 0 || editContextCount > 0;
  const submitLabel = intl.formatMessage({ id: "chat.send" });
  const cancelLabel = intl.formatMessage({ id: "common.cancel" });
  const rewindWorkspaceLabel = intl.formatMessage({
    id: "chat.edit.resetConversationAndFiles",
  });
  const rewindWorkspaceTooltipTitle = intl.formatMessage({
    id: "chat.edit.resetConversationAndFiles.tooltip",
  });
  // tooltip 描述按不可用原因取文案；可用时不传 description，只显示标题。
  const rewindWorkspaceTooltipDescription =
    editWorkspaceRewindAvailability?.reason === "available"
      ? undefined
      : intl.formatMessage({
          id: `chat.edit.resetConversationAndFiles.${editWorkspaceRewindAvailability?.reason ?? "noFiles"}`,
        });
  // 展示用正文已剥离 share 块；row.text 仍用于复制，保证复制到的是原始输入。
  // visibleText 走 parsedShareContext.visibleContent 做展示；row.text 仍是复制用的完整原文。
  // 编辑初值用 visibleContent，用户不会看到并误删隐藏块。
  const visibleText = parsedShareContext.visibleContent;
  const codeCommentContexts = parsedPrompt.codeComments;
  const webElementContexts = parsedPrompt.webElements;
  const pptxElementReferences = parsedPrompt.pptxElements;
  const conversationSelections = parsedPrompt.conversationSelections;
  // 附件区与气泡分开判定：只有附件没有正文时，气泡不渲染（否则出现空气泡）。
  const hasAttachments = (row.attachments?.length ?? 0) > 0;
  const hasMediaAttachments =
    row.attachments?.some(
      (attachment) => attachment.mime.startsWith("image/") || attachment.mime.startsWith("video/"),
    ) ?? false;
  const hasFileAttachments =
    row.attachments?.some(
      (attachment) =>
        !attachment.mime.startsWith("image/") && !attachment.mime.startsWith("video/"),
    ) ?? false;
  const hasVisibleText = visibleText.trim().length > 0;
  const pluginUiContexts = parsedPrompt.pluginUiContexts;
  // nudge 轮整条都是引擎文本：正文为空但气泡仍要画，里面只有那一枚披露。
  // 尾注存在时即使正文为空也要画气泡：nudge 轮整条都是引擎文本，气泡里只有披露。
  const hasBubble = hasVisibleText || epilogue !== undefined;
  const hasContextReferences =
    codeCommentContexts.length > 0 ||
    webElementContexts.length > 0 ||
    pptxElementReferences.length > 0 ||
    conversationSelections.length > 0 ||
    pluginUiContexts.length > 0;
  // 附件区 = 真附件 或 上下文引用；两者都没有时整块不渲染，减少空 DOM。
  // 只含上下文引用的消息也可能没有正文，此时气泡仍按 hasBubble 规则决定。
  // hasAttachmentArea 与 hasBubble 各自独立求值：附件区是否存在不参与气泡可见性的推断。
  const hasAttachmentArea = hasAttachments || hasContextReferences;
  const hasAttachmentPills =
    hasFileAttachments ||
    codeCommentContexts.length > 0 ||
    webElementContexts.length > 0 ||
    pptxElementReferences.length > 0 ||
    (!row.botGroupSource && conversationSelections.length > 0);
  // Bug 根因：旧逻辑只接受 schedule runId，导致用户点击「立即运行」产生的 manual run
  // 没有来源标识。两种合法 automation runId 都应展示；普通会话输入仍因解析失败而不展示。
  const isScheduledAutomationPrompt = parseAutomationRunId(row.sourceCommandId ?? "") !== null;
  // PPT 元素引用的打开能力来自宿主回调；缺失时 chip 仍展示但不可跳转。
  // 这是只读历史场景的常见形态：引用还在，但当前宿主没有代码查看器。
  // chip 的删除与打开是两个独立能力，不能因缺一个而隐藏另一个。
  const openPptxElementReference = useOpenPptxElementReference({
    workspacePath: context.workspacePath,
    workspaceIdentity: context.workspaceIdentity,
    remoteSessionId: context.workspaceRemoteSessionId,
    onOpenCodeViewer: context.onOpenCodeViewer,
  });

  // 退出编辑时把草稿重置为最新投影：这样外部 row 更新（重发/回滚）能反映到下一次编辑。
  // 依赖 parsedPrompt 与 row.attachments：二者任一变化都意味着投影已更新。
  // 不依赖 editing：否则每次进入/退出编辑都会重置一遍草稿（多余且可能与输入竞争）。
  // 该 effect 在挂载时也会跑一次，保证首次渲染的草稿与投影一致。
  // 进入编辑时只做聚焦，不动草稿——草稿已由 handleOpenEdit 初始化。
  useEffect(() => {
    if (!editing) {
      setDraft(parsedShareContext.visibleContent);
      setEditAttachments([...(row.attachments ?? [])]);
      setEditAttachmentIndices((row.attachments ?? []).map((_, index) => index));
      setEditPromptContexts(parsedPrompt);
      return;
    }
    // rAF 聚焦是为了等编辑器挂载完成；无 rAF 环境（测试）同步聚焦。
    // 只调度一次，不做重试：编辑器若未挂载，句柄为空，focus 是空操作。
    // 不清理 rAF：一帧内完成，且清理反而可能取消掉必要的聚焦。
    const focusEditor = () => inputApiRef.current?.focus();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(focusEditor);
      return;
    }
    focusEditor();
  }, [editing, parsedPrompt, row.attachments]);

  // onEdit 消失（切换为只读）时强制退出编辑态，避免提交到不存在的回调。
  // 同时复位 submitting：否则下次进入编辑会带着旧的禁用态。
  // 该 effect 不重置草稿，草稿在下次打开时按最新投影重建。
  useEffect(() => {
    if (!onEdit) {
      setEditing(false);
      setSubmitting(false);
    }
  }, [onEdit]);

  // handleOpenEdit 用 parsedShareContext.visibleContent 重建 draft 再 setEditing，不复用上次取消后残留的草稿。
  // 三个 setState 与 setEditing 同批提交，React 会合并成一次渲染，不会闪旧值。
  // 不复用 draft：用户上次取消后 draft 可能仍是旧编辑内容。
  const handleOpenEdit = useCallback(() => {
    // v4 迁移时把 user query 编辑误接成“直接读取主 composer 提交”，
    // 主 composer 为空时点击只会 warn。这里恢复旧行内编辑态。
    setDraft(parsedShareContext.visibleContent);
    setEditAttachments([...(row.attachments ?? [])]);
    setEditAttachmentIndices((row.attachments ?? []).map((_, index) => index));
    setEditPromptContexts(parsedPrompt);
    setEditing(true);
  }, [parsedPrompt, parsedShareContext, row.attachments]);

  // 取消编辑：重置全部草稿字段并退出；不调用 onEdit，不产生任何副作用。
  // 重置四个字段是必须的：残留的附件序号会让下一次编辑删除错文件。
  // 退出编辑后 parse/可见正文仍来自 row，本地改动全部丢弃。
  const handleCancelEdit = useCallback(() => {
    setDraft(parsedShareContext.visibleContent);
    setEditAttachments([...(row.attachments ?? [])]);
    setEditAttachmentIndices((row.attachments ?? []).map((_, index) => index));
    setEditPromptContexts(parsedPrompt);
    setEditing(false);
  }, [parsedPrompt, parsedShareContext, row.attachments]);

  // [事务] 删除附件必须两个数组同时删，且用同一 index；只删一个会让后续读取错位。
  const handleRemoveEditAttachment = useCallback((index: number) => {
    setEditAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setEditAttachmentIndices((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }, []);

  // [事务] 提交编辑：序列化上下文 → 带上完整附件数组 → 交给 onEdit。
  // serializeComposerPromptContexts 把正文与上下文合并成最终 prompt 文本，
  // conversationSelections 单独作为参数传，避免同时出现在 prompt 与引用列表里。
  // 三种结果：blocked（打开冲突预览）、false（保持编辑态）、其它（退出编辑态）。
  const handleSubmitEdit = useCallback(
    async (nextText: string, workspaceMode: "preserve" | "rewind" = "preserve") => {
      // onEdit 缺失时直接返回：这是只读宿主，不应出现提交入口。
      if (!onEdit) return;
      // 空内容不提交：与 canSubmit 同源，防止回车绕过按钮禁用。
      if (!nextText.trim() && editAttachments.length === 0 && editContextCount === 0) return;
      // submitting 覆盖整个异步过程：期间编辑器禁用提交，避免重复 editUserQuery。
      // 它与 rewindWorkspaceDisabled 共享同一来源，保证两个提交入口同时冻结。
      // 冲突预览打开时仍在 submitting 内，直到 finally 复位。
      setSubmitting(true);
      try {
        const result = await onEdit(
          { rowId: row.rowId, entityId: row.entityId! },
          serializeComposerPromptContexts(nextText, {
            ...editPromptContexts,
            conversationSelections: [],
          }),
          // conversationSelections 在这里被清空再单独作为参数传：避免同一引用被序列化两次。
          // 省略空数组会让 CLI 按 attachments 缺省语义恢复 canonical 原附件，
          // 因此 edit 必须始终提交当前完整列表，显式 [] 才能表达“删除全部”。
          editAttachments,
          workspaceMode,
          ...(parsedPrompt.conversationSelections.length || row.conversationQuotes
            ? [[...editPromptContexts.conversationSelections]]
            : []),
        );
        // [失败路径] blocked 表示文件已被修改：展示冲突预览，让用户选择仅改会话或放弃。
        // 冲突时不复位 submitting 之外的状态：编辑内容必须保留，否则用户要重打一遍。
        // preview 为空时不进入冲突分支，按普通失败处理。
        // 此时不能退出编辑态，否则用户失去对冲突的处理入口。
        if (
          typeof result === "object" &&
          result !== null &&
          result.result?.type === "editUserQuery" &&
          result.result.disposition === "blocked" &&
          result.result.preview
        ) {
          setConflictPreview(result.result.preview);
          setConflictOpen(true);
          return;
        }
        // 返回 false 表示未执行（例如宿主拒绝）：保持编辑态，用户可修改后重试。
        if (result !== false) {
          setEditing(false);
          setConflictOpen(false);
        }
    // 无论成功失败都要复位 submitting，否则按钮永久禁用。
  // 这里用 finally 而不是 catch：blocked 分支提前 return 也必须复位。
  // 不在这里弹错：错误提示由 onEdit 的实现方负责，叶子只维护交互状态。
      } finally {
        setSubmitting(false);
      }
    },
    [
      editAttachments,
      editContextCount,
      editPromptContexts,
      onEdit,
      row.entityId,
      row.rowId,
      row.conversationQuotes,
      parsedPrompt.conversationSelections.length,
    ],
  );
  // “重置会话与文件”要求可用且不在提交中；可用性由宿主按文件状态计算。
  // enabled 为 undefined（宿主未提供）时按不可用处理，按钮仍展示原因。
  // 它与普通提交互斥：同一时刻只允许一个 editUserQuery 在飞。
  const rewindWorkspaceDisabled = submitting || editWorkspaceRewindAvailability?.enabled !== true;
  // 按钮复用于两处（编辑器动作区与冲突 Dialog），因此抽成变量而不是重复 JSX。
  // 复用保证两处的 disabled/aria/testid 完全一致，不会出现一处可点一处不可点。
  // 元素本身无状态，重复渲染不会共享内部状态。
  const rewindWorkspaceButton = (
    <Button
      type="button"
      variant="outline"
      size="icon-md"
      disabled={rewindWorkspaceDisabled}
      data-testid={testId(TID_V4_EDIT_REWIND_WORKSPACE, String(row.rowId))}
      aria-label={rewindWorkspaceLabel}
      onClick={() => {
        void handleSubmitEdit(draft, "rewind");
      }}
    >
      <FileClockIcon className="size-4" />
    </Button>
  );

  // 编辑态整体替换气泡：不叠加，避免只读内容与编辑器同时可交互。
  if (editing) {
    // 编辑器初值用 parsedPrompt.visibleContent（与草稿同源），而不是 draft：
    // ChatPromptEditor 是半受控组件，初值只在挂载时读取。
    // 若用 draft，取消后再次进入可能拿到上一次未提交的编辑内容。
    // 冲突 Dialog 的“仅修改会话”复用同一提交函数（preserve 模式），不改文件。
    // onApply 为空实现：冲突场景下不提供“同时改文件”的按钮语义。
    // applying 复用 submitting，保证重试期间按钮禁用。
    return (
      <RowShell rowId={row.rowId} className="flex flex-col items-end">
        <ChatPromptEditor
          workspacePath={context.workspacePath}
          taskId={context.sessionId ?? null}
          initialValue={parsedPrompt.visibleContent}
          submitting={submitting}
          submitDisabled={!canSubmit || submitting}
          allowSubmitWhenEmpty={editAttachments.length > 0 || editContextCount > 0}
          submitLabel={submitLabel}
          cancelLabel={cancelLabel}
          showMentionButton
          showSlashButton
          enableWorkspaceFileDrop
          topContent={
            editAttachments.length > 0 || editContextCount > 0 ? (
              <div className="flex max-w-full flex-col items-start gap-2">
                {editAttachments.length > 0 ? (
                  <UserInputAttachmentList
                    attachments={editAttachments}
                    attachmentIndices={editAttachmentIndices}
                    entityId={row.entityId}
                    rowId={row.rowId}
                    onRemove={handleRemoveEditAttachment}
                    sessionId={context.sessionId ?? undefined}
                    readAttachment={context.readAttachment}
                    readAttachmentRange={context.readAttachmentRange}
                  />
                ) : null}
                {editContextCount > 0 ? (
                  <div
                    className="flex max-w-full flex-wrap items-center gap-2"
                    data-v4-user-edit-context-attachments-row="true"
                  >
                    <CodeCommentAttachmentChip
                      comments={editPromptContexts.codeComments}
                      onRemove={(comment) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          codeComments: current.codeComments.filter((item) => item !== comment),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          codeComments: [],
                        }))
                      }
                    />
                    <WebElementContextAttachmentChip
                      contexts={editPromptContexts.webElements}
                      onRemove={(id) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          webElements: current.webElements.filter((item) => item.id !== id),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          webElements: [],
                        }))
                      }
                    />
                    <PptxElementReferenceChip
                      references={editPromptContexts.pptxElements}
                      onOpen={context.onOpenCodeViewer ? openPptxElementReference : undefined}
                      onRemove={(id) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          pptxElements: current.pptxElements.filter((item) => item.id !== id),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          pptxElements: [],
                        }))
                      }
                    />
                    <ConversationSelectionReferenceChip
                      references={editPromptContexts.conversationSelections}
                      onRemove={(id) =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          conversationSelections: current.conversationSelections.filter(
                            (item) => !("id" in item) || item.id !== id,
                          ),
                        }))
                      }
                      onRemoveAll={() =>
                        setEditPromptContexts((current) => ({
                          ...current,
                          conversationSelections: [],
                        }))
                      }
                    />
                  </div>
                ) : null}
              </div>
            ) : null
          }
          inputApiRef={inputApiRef}
          inputTestId={testId(TID_V4_EDIT_INPUT, String(row.rowId))}
          submitTestId={testId(TID_V4_EDIT_SUBMIT, String(row.rowId))}
          cancelTestId={testId(TID_V4_EDIT_CANCEL, String(row.rowId))}
          // [权衡] 禁用按钮套一层 span 承接 hover：Button 的 disabled 带 pointer-events-none，
          // data-disabled-tooltip-trigger 是该补偿的稳定标记，e2e 依赖它判断禁用原因可见性。
          // 可用时直接返回按钮，不额外包 DOM，避免影响动作区间距。
          // 直接作为 TooltipTrigger 收不到鼠标事件，原因文案就永远看不到。
          betweenCancelAndSubmitAction={
            <ControlHintTooltip
              title={rewindWorkspaceTooltipTitle}
              description={rewindWorkspaceTooltipDescription}
            >
              {rewindWorkspaceDisabled ? (
                // Button disabled 会应用 pointer-events-none，TooltipTrigger 直接落在
                // 按钮上时收不到 hover。禁用态用外层 span 承接 hover，实际按钮仍保持 disabled。
                <span className="inline-flex" data-disabled-tooltip-trigger="true">
                  {rewindWorkspaceButton}
                </span>
              ) : (
                rewindWorkspaceButton
              )}
            </ControlHintTooltip>
          }
          className="w-full max-w-xl"
          shellClassName="min-h-32"
          onChange={setDraft}
          // 编辑器提交携带的是编辑器内部最新文本，不是 draft：两者在输入过程中可能短暂不同步。
          // draft 由 onChange 同步，但提交瞬间可能还没落到 state。
          // 因此 handleSubmitEdit 的 nextText 参数优先于 draft。
          onSubmit={(nextText) => {
            void handleSubmitEdit(nextText, "preserve");
          }}
          onCancel={handleCancelEdit}
        />
        <ConversationFileRewindDialog
          variant="editConflict"
          open={conflictOpen}
          onOpenChange={setConflictOpen}
          preview={conflictPreview}
          previewLoading={false}
          applying={submitting}
          error={null}
          onApply={() => {}}
          onConversationOnly={() => {
            void handleSubmitEdit(draft, "preserve");
          }}
        />
      </RowShell>
    );
  }

  // 只读气泡视图：附件/引用在上，正文居中，动作行在最后；三段各自按需渲染。
  // 顺序固定：来源标签 → 附件区 → 气泡 → 来源说明 → 状态 → 动作。
  // 每一段都是独立条件渲染，避免任何一段为空时留下 margin。
  // 两类 runId（定时与立即运行）都算合法来源；旧逻辑只认 schedule 导致 manual run 缺标。
  // 解析失败即普通会话输入，不显示任何来源前缀。
  // 群来源消息的对话引用单独一行：与下面的 pill 行分开，避免来源标签被挤走。
  // 文件 → 评论 → 网页 → PPT → 对话引用 → 插件上下文：顺序固定，不随数据变化。
  // 固定顺序让同一会话的多次输入在视觉上可对比，降低扫描成本。
  // 每种 chip 自己在为空时不渲染，因此顺序不会留下空洞。
  return (
    <RowShell rowId={row.rowId} className="group/user-row flex flex-col items-end">
      {isScheduledAutomationPrompt ? (
        <div
          data-v4-user-input-automation-origin="schedule"
          className="mb-1 flex max-w-xl items-center gap-1 text-ui-sm text-foreground-subtle"
        >
          <Clock data-cron-task-icon="true" aria-hidden="true" className="size-3.5 shrink-0" />
          <span>{intl.formatMessage({ id: "chat.message.sentByScheduledTask" })}</span>
        </div>
      ) : null}
      {row.botGroupSource ? (
        // 群来源原先插在材料与正文之间，割裂同一输入；统一放在材料之前。
        <div data-v4-user-input-source="true" className="mb-2 flex min-w-0 max-w-full">
          <BotGroupSourceLabel source={row.botGroupSource} />
        </div>
      ) : null}

      {hasAttachmentArea ? (
        <div
          data-v4-user-input-attachments="true"
          data-testid={testId(TID_V4_ROW_ATTACHMENTS, String(row.rowId))}
          className="mb-2 flex max-w-xl flex-col items-end gap-2"
        >
          {row.botGroupSource && conversationSelections.length > 0 ? (
            <div data-v4-user-input-quotes="true" className="flex max-w-full justify-end">
              <ConversationSelectionReferenceChip
                references={conversationSelections}
                contentAlign="end"
              />
            </div>
          ) : null}
          {hasMediaAttachments ? (
            <div
              data-v4-user-input-media-attachments="true"
              className="flex max-w-full flex-wrap justify-end gap-2"
            >
              <UserInputAttachmentList
                attachments={row.attachments}
                entityId={row.entityId}
                attachmentKind="media"
                directItems
                rowId={row.rowId}
                sessionId={context.sessionId ?? undefined}
                readAttachment={context.readAttachment}
                readAttachmentRange={context.readAttachmentRange}
              />
            </div>
          ) : null}
          {hasAttachmentPills ? (
            <div
              data-v4-user-input-attachment-pills="true"
              // 非媒体文件与上下文引用必须共享这一层，才能在换行时
              // 保持“文件→评论→网页→PPT→对话引用”的顺序和统一右对齐。
              className="flex max-w-full flex-wrap justify-end gap-2"
            >
              {hasFileAttachments ? (
                <UserInputAttachmentList
                  attachments={row.attachments}
                  entityId={row.entityId}
                  attachmentKind="file"
                  directItems
                  rowId={row.rowId}
                  sessionId={context.sessionId ?? undefined}
                  readAttachment={context.readAttachment}
                  readAttachmentRange={context.readAttachmentRange}
                />
              ) : null}
              <CodeCommentAttachmentChip comments={codeCommentContexts} contentAlign="end" />
              <WebElementContextAttachmentChip contexts={webElementContexts} contentAlign="end" />
              <PptxElementReferenceChip
                references={pptxElementReferences}
                contentAlign="end"
                onOpen={context.onOpenCodeViewer ? openPptxElementReference : undefined}
              />
              {!row.botGroupSource ? (
                <ConversationSelectionReferenceChip
                  references={conversationSelections}
                  contentAlign="end"
                />
              ) : null}
              <PluginUiModelContextChip contexts={pluginUiContexts} contentAlign="end" />
            </div>
          ) : null}
        </div>
      ) : null}
      {hasBubble ? (
        // 附件和上下文引用只属于消息行，不属于气泡；否则仅附件消息会留下空气泡。
        // 同一 row 会渲染在主会话和 Subagent 侧栏，固定宽度会忽略实际宿主宽度。
        // 气泡保留 flex item 的自动宽度；宿主至少 624px 时再以 36rem 封顶并保留 48px 余量。
        <ConversationUserInputBubble
          text={visibleText}
          contentParts={row.botGroupSource?.contentParts}
          rowId={row.rowId}
          epilogue={epilogue}
          attachments={row.attachments}
          contextAttachmentCount={countComposerPromptContexts(parsedPrompt)}
        />
      ) : null}
      {row.source?.kind === "genUi" && (
        <div
          className="mt-1 text-right text-ui-sm text-foreground-subtlest"
          data-v4-user-input-source="genUi"
        >
          {intl.formatMessage({ id: "genUi.from" }, { name: row.source.title || "Gen UI" })}
        </div>
      )}
      {row.source?.kind === "pluginUi" ? (
        // 插件 UI 代发：来源标记来自 CLI 持久化的 intent.source，不由 renderer 推断。
        <div
          data-v4-user-input-source={row.source.pluginId}
          className="mt-1 text-right text-ui-sm text-foreground-subtlest"
        >
          {intl.formatMessage(
            { id: "pluginUi.fromPlugin" },
            { name: formatPluginDisplayName(row.source.pluginId) },
          )}
        </div>
      ) : null}
      {status ? (
        <div
          data-v4-user-input-status="true"
          className="mt-1 text-right text-ui-sm text-foreground-subtlest"
          aria-live="polite"
        >
          {status}
        </div>
      ) : null}
      {/* Bugfix：手机远控没有 hover，v4 迁移时漏掉了旧 UserMessage 的常显分支，
          导致复制和编辑入口不可发现；远控直接显示，桌面端继续通过 hover/focus 降噪。 */}
      <MessageActions
        className={cn(
          "mt-1",
          context.compactForRemoteControl
            ? "opacity-100"
            : "opacity-0 transition-opacity group-hover/user-row:opacity-100 focus-within:opacity-100",
        )}
      >
        <CopyRowAction
          text={row.text}
          rowId={row.rowId}
          label={intl.formatMessage({ id: "chat.message.copy" })}
        />
        {onEdit && row.entityId ? (
          <MessageAction
            label={intl.formatMessage({ id: "chat.message.edit" })}
            tooltip={intl.formatMessage({ id: "chat.message.edit" })}
            data-testid={testId(TID_V4_EDIT, String(row.rowId))}
            onClick={handleOpenEdit}
          >
            <PencilIcon className="size-3.5" />
          </MessageAction>
        ) : null}
      </MessageActions>
    </RowShell>
  );
});

// 话题历史消息可能是一条 row 展开成多条：这里做展开与逐条渲染，
// 展开只发生在渲染层，协议仍是一条消息；因此复制/引用都按整批语义处理。
// 每条子消息仍需 RowShell 之外的 topic-message-id 标记，供滚动定位使用。
// 但禁用编辑——局部编辑无法表达“替换整批原文”。
const UserInputRowView = memo(function UserInputRowView(
  props: ComponentProps<typeof SingleUserInputRowView>,
) {
  // 展开结果是纯派生：同一 row 引用不变就不重算。
  // 返回长度 1 时直接复用单行组件，避免多包一层 DOM 影响布局。
  const rows = useMemo(() => expandTopicInputMessages(props.row), [props.row]);
  if (rows.length === 1) return <SingleUserInputRowView {...props} row={rows[0]!} />;
  return (
    // 多条时按 messageId 做 key：它们共享同一个已接收输入，但各自有稳定身份。
    <div className="flex min-w-0 flex-col gap-3" data-v4-topic-messages="true">
      {rows.map((row) => (
        <div
          key={row.botGroupSource!.messageId}
          data-topic-message-id={row.botGroupSource!.messageId}
        >
          {/* 多条原文共用一个已接收输入，不能把局部编辑误当作替换整批。 */}
          <SingleUserInputRowView {...props} row={row} onEdit={undefined} />
        </div>
      ))}
    </div>
  );
});

// memo 组件的数组默认值必须是模块级常量：内联 [] 每次渲染都是新引用，会让 memo 比较失效。
// memo 组件的数组默认值必须是模块级常量：内联 [] 每次渲染都是新引用，会让 memo 比较失效。
const EMPTY_SOURCE_COMMAND_IDS: readonly string[] = [];

// assistant 动作行：复制 / 赞 / 踩 / fork / 钩子详情 / 时间 / 群投递。
// 按钮顺序即优先级：复制最高频，反馈次之，fork 与详情属于低频但需要常驻可见。
// ConversationAssistantTextActions 的每个入口各自判断能力，缺能力时整颗按钮不渲染而不是置灰。
// 它是纯展示组件，反馈的乐观更新与回滚都在内部完成，但持久化由 onFeedbackChange 注入。
export const ConversationAssistantTextActions = memo(function ConversationAssistantTextActions({
  rowId,
  entityId,
  text,
  createdAt,
  compactForRemoteControl = false,
  feedback = null,
  hookInvocations,
  sessionId,
  turnId,
  sourceCommandIds = EMPTY_SOURCE_COMMAND_IDS,
  onFork,
  onFeedbackChange,
  className,
}: {
  rowId: number;
  entityId?: string;
  text: string;
  createdAt: number;
  compactForRemoteControl?: boolean;
  feedback?: AssistantMessageFeedback | null;
  hookInvocations?: readonly HookInvocationRow[];
  sessionId?: string | null;
  turnId?: string;
  sourceCommandIds?: readonly string[];
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  className?: string;
}) {
  // locale 同时用于时间格式：不能只依赖 intl 的当前语言，时间格式需要显式 locale。
  const { intl, locale } = useZCodeIntl();
  const platform = useOptionalPlatform();
  // localFeedback 是乐观投影：外部 feedback 变化时同步回来（见下面的 effect）。
  // 用 useState 初值而不是 useMemo：反馈需要能被点击改写，且要在回滚时恢复。
  // feedback 为 undefined 与 null 都按“无反馈”处理，避免出现未选中却高亮。
  // localFeedback 是乐观投影，与外部 feedback 不一致的时间窗只存在于请求在飞期间。
  const [localFeedback, setLocalFeedback] = useState<AssistantMessageFeedback | null>(feedback);
  const copyLabel = intl.formatMessage({ id: "chat.message.copy" });
  const likeLabel = intl.formatMessage({
    id: localFeedback === "like" ? "chat.message.liked" : "chat.message.like",
  });
  const dislikeLabel = intl.formatMessage({
    id: localFeedback === "dislike" ? "chat.message.disliked" : "chat.message.dislike",
  });
  const forkLabel = intl.formatMessage({ id: "chat.message.fork" });
  const timeLabel = formatMessageTimeLabel(createdAt, locale, intl);
  const resolveTooltip = (label: string): string | undefined =>
    compactForRemoteControl ? undefined : label;

  // 权威反馈到达时覆盖本地：包括回滚后的值，避免本地状态永久漂移。
  useEffect(() => {
    setLocalFeedback(feedback);
  }, [feedback]);

  // [事务] 反馈点击：先乐观写本地，再发命令；false 或 reject 都回滚到点击前值。
  // 回滚用闭包捕获的 previousFeedback，而不是再读 state：避免批处理下拿到新值。
  // handleFeedback 成功后不做第二次写入：localFeedback 已是目标值，交由 feedback 的同步 effect 校正。
  // 同一个按钮再次点击表示取消（resolvedFeedback = null）。
  const handleFeedback = useCallback(
    (nextFeedback: AssistantMessageFeedback) => {
      const previousFeedback = localFeedback;
      // 再次点击同一反馈 = 取消：协议用 null 表达“无反馈”，不是用相反值。
      const resolvedFeedback = previousFeedback === nextFeedback ? null : nextFeedback;
      setLocalFeedback(resolvedFeedback);
      logger.info("[ConversationRowView] 用户反馈 assistant 消息", {
        messageId: entityId ?? null,
        reaction: resolvedFeedback ?? "none",
      });
      // 没有 entityId 时只改本地：历史行可能缺少实体身份，无法持久化。
      if (entityId) {
        void Promise.resolve(onFeedbackChange?.({ rowId, entityId }, resolvedFeedback)).then(
          (result) => {
            // [失败路径] CAS 失败返回 false：回滚。注意成功时 result 为 void，不能写成 !result。
            if (result === false) setLocalFeedback(previousFeedback);
          },
          (error: unknown) => {
            setLocalFeedback(previousFeedback);
            // V4 初版只改 renderer local state，command 失败后会显示并不存在的反馈。
            // 失败必须回滚到点击前投影值，等待后续权威 row 再校正。
            logger.warn("[ConversationRowView] 持久化 assistant 反馈失败", {
              error: error instanceof Error ? error.message : String(error),
              messageId: entityId,
            });
          },
        );
      }
      // telemetry 与持久化解耦：即使用户未登录或命令失败，点击行为仍然计数。
      if (platform && entityId) {
        void reportAppTelemetryEvent(
          platform,
          {
            elementName: "assistant_message_feedback",
            eventRegion: "chat",
            eventType: "ck",
            eventExtraDetail: { reaction: resolvedFeedback ?? "none" },
            ...(sessionId ? { talkId: sessionId } : {}),
            messageId: entityId,
          },
          "ConversationRowView",
        );
      }
    },
    [entityId, localFeedback, onFeedbackChange, platform, rowId, sessionId],
  );
  // fork 走 runUserAction：同步操作包装，异常由 telemetry 层记录，不阻断 UI。
  const handleFork = useCallback(() => {
    if (entityId) {
      runUserAction({
        input: { featureId: "conversation.history.branch", action: "fork", trigger: "button" },
        operation: () => onFork?.({ rowId, entityId }),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "fork",
      });
    }
  }, [entityId, onFork, rowId]);
  // 赞/踩只在有持久化通道时渲染：否则点击后刷新即丢失，属于假功能。
  // 同样要求 entityId：没有实体身份的旧行无法 CAS，只能只读。
  // aria-pressed 反映当前态，供屏幕阅读器区分“已赞/未赞”。
  // fork 需要 entityId 与 onFork 同时存在：前者是分支点身份，后者是宿主能力。
  // 钩子详情需要 turnId + rows：二者共同定位一轮内的 hook 调用记录。
  // 群投递动作只依赖 turnId：sourceCommandIds 只是过滤条件，缺省为空数组。
  return (
    // has-[[data-bot-group-delivery]] 让群投递状态存在时动作行常显：
    // 否则投递按钮会被 hover 隐藏规则一起藏掉。
    <MessageActions className={cn(className, "has-[[data-bot-group-delivery]]:opacity-100")}>
      <CopyRowAction
        text={text}
        rowId={rowId}
        label={copyLabel}
        tooltip={resolveTooltip(copyLabel)}
      />
      {entityId && onFeedbackChange ? (
        <>
          <MessageAction
            aria-label={likeLabel}
            aria-pressed={localFeedback === "like"}
            label={likeLabel}
            tooltip={resolveTooltip(likeLabel)}
            data-testid={testId(TID_V4_FEEDBACK_LIKE, String(rowId))}
            className={localFeedback === "like" ? "!bg-success/10" : undefined}
            onClick={() => handleFeedback("like")}
          >
            <span
              className={cn(
                "relative inline-flex",
                localFeedback === "like" && "zcode-reaction-burst",
              )}
            >
              <ThumbsUpIcon className="size-3.5" />
            </span>
          </MessageAction>
          <MessageAction
            aria-label={dislikeLabel}
            aria-pressed={localFeedback === "dislike"}
            label={dislikeLabel}
            tooltip={resolveTooltip(dislikeLabel)}
            data-testid={testId(TID_V4_FEEDBACK_DISLIKE, String(rowId))}
            className={localFeedback === "dislike" ? "!bg-warning/10" : undefined}
            onClick={() => handleFeedback("dislike")}
          >
            <span
              className={cn(
                "relative inline-flex",
                localFeedback === "dislike" && "zcode-reaction-burst",
              )}
            >
              <ThumbsDownIcon className="size-3.5" />
            </span>
          </MessageAction>
        </>
      ) : null}
      {onFork && entityId ? (
        <MessageAction
          aria-label={forkLabel}
          label={forkLabel}
          tooltip={resolveTooltip(forkLabel)}
          data-testid={testId(TID_V4_FORK, String(rowId))}
          onClick={handleFork}
        >
          <TrendingUpDownIcon className="size-3.5" />
        </MessageAction>
      ) : null}
      {turnId && hookInvocations ? (
        <ConversationHookDetailsAction rows={hookInvocations} turnId={turnId} />
      ) : null}
      {/* Bugfix: 旧 conversation surface 删除后，V4 动作栏漏掉了消息创建时间；
          时间是 row.createdAt 的只读派生展示，不新增 renderer 状态。 */}
      {timeLabel ? (
        <span className="select-none text-ui-sm text-foreground-subtlest">{timeLabel}</span>
      ) : null}
      {turnId ? (
        <ConnectedBotGroupDeliveryAction turnId={turnId} sourceCommandIds={sourceCommandIds} />
      ) : null}
    </MessageActions>
  );
});

// assistant 正文行：markdown/代码块渲染 + 代码评论投影 + 预览卡 + 轮尾动作。
// 它是流式渲染的主路径：每个 delta 都会让 row 换新引用，从而触发本叶子重渲染。
// 因此这里避免任何 O(全量文本) 的额外解析——代码评论投影只在开关开启时执行。
// 流式与非流式共用同一渲染器，只把 streaming 传给底层做容错。
const AssistantTextRowView = memo(function AssistantTextRowView({
  row,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  hideActions,
  deferActions,
  copyText,
  previewCards,
  previewCardsAutoOpenKey,
  codeCommentCards,
  codeCommentProjectionEnabled,
}: {
  row: AssistantTextRow;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  hideActions?: boolean;
  deferActions?: boolean;
  copyText?: string;
  previewCards?: AssistantPreviewCard[];
  previewCardsAutoOpenKey?: string;
  codeCommentCards?: AssistantCodeCommentCard[];
  codeCommentProjectionEnabled?: boolean;
}) {
  // streaming 是 row.state 的派生，不额外保存：投影更新时自然切换。
  const streaming = row.state === "streaming";
  const isOfficeMode = useIsOfficeMode();
  // 代码评论投影同时受全局开关与轮级裁决控制：二者都真才剥离协议原文。
  const codeCommentCardsEnabled = useAssistantCodeCommentFeatureEnabled();
  const projectsCodeComments = codeCommentCardsEnabled && codeCommentProjectionEnabled === true;
  // [流式] 投影只改可见文本，不改 row.text：复制与 fork 仍使用原文。
  // 流式时未闭合的标记可能被误判为评论块，投影函数内部按 streaming 放宽匹配。
  // 关闭开关时直接返回 row.text，零额外开销。
  // streaming 时投影必须容忍未闭合的标记，因此把 streaming 一并传入。
  const visibleText = useMemo(
    () =>
      projectsCodeComments
        ? projectAssistantCodeComments(row.text, { streaming }).visibleText
        : row.text,
    [projectsCodeComments, row.text, streaming],
  );
  // 空数组视为无卡片：避免渲染一个空的 mt-3 容器。
  const visiblePreviewCards = previewCards && previewCards.length > 0 ? previewCards : null;
  // selectable 语义放在稳定 DOM 包装层：MessageResponse 不透传 data-*，
  // 直接标在组件上会让框选逻辑找不到区域。
  // 代码评论卡只在轮尾终态由 TurnGroup 下发；这里只负责渲染，不自行计算。
  // 开关与投影开关同时为真才显示，避免关掉功能后仍残留卡片。
  // 卡片为空数组时整块不渲染，不留间距。
  // 轮级动作三条件：完成态、非隐藏段、非延迟段。任一不满足都不渲染动作行，
  // 延迟段由 TurnGroup 在文件 summary 之后单独渲染同一组件。
  // 这样一轮只会出现一组复制/fork。
  return (
    <RowShell rowId={row.rowId} className="group/assistant-row">
      {/* M5④ 阶段2：assistant 文本走 streamdown（MessageResponse），
          markdown/代码块正式渲染；streaming 模式对未闭合 markdown 容错。 */}
      {/* Bugfix：MessageResponse 只消费自身声明的 props，不会把 data-* 透传到真实 DOM，
          导致 assistant 正文虽然在 JSX 上标了 selectable，框选逻辑却永远找不到该区域。
          selectable 语义必须放在稳定的 DOM 包装层上，完成态和 streaming 共用同一路径。 */}
      <div data-conversation-selectable="true" className="w-full text-ui-base">
        <GenUiMessageResponse
          completed={row.state === "complete"}
          messageKey={`${row.rowId}:${row.entityId ?? ""}`}
          renderZCodeFileCitations
          streaming={streaming}
          workspacePath={context.workspacePath}
          workspaceIdentity={context.workspaceIdentity}
          workspaceRemoteSessionId={context.workspaceRemoteSessionId}
          theme={context.theme}
          codePreviewSettings={context.codePreviewSettings}
          forceCodeWrap={isOfficeMode}
          onOpenCodeViewer={context.onOpenCodeViewer}
          onOpenFileLink={context.onOpenFileLink}
          onOpenExternalUrl={context.onOpenBrowserUrl}
          sessionId={context.sessionId ?? undefined}
          readAttachment={context.readAttachment}
        >
          {visibleText}
        </GenUiMessageResponse>
      </div>
      {codeCommentCardsEnabled && codeCommentCards && codeCommentCards.length > 0 ? (
        <div className="mt-3">
          <AssistantCodeCommentCards
            cards={codeCommentCards}
            workspacePath={context.workspacePath}
            workspaceIdentity={context.workspaceIdentity}
            workspaceRemoteSessionId={context.workspaceRemoteSessionId}
            onOpenCodeViewer={context.onOpenCodeViewer}
          />
        </div>
      ) : null}
      {visiblePreviewCards ? (
        <div className="mt-3">
          <AssistantPreviewCards
            cards={visiblePreviewCards}
            workspacePath={context.workspacePath}
            workspaceIdentity={context.workspaceIdentity}
            workspaceRemoteSessionId={context.workspaceRemoteSessionId}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            autoOpenPptxKey={previewCardsAutoOpenKey}
            onAutoOpenPptx={context.onAutoOpenAssistantPptx}
            compactForRemoteControl={context.compactForRemoteControl}
          />
        </div>
      ) : null}
      {/* 完成态动作行悬停显现（对齐旧 MessageActions）：复制 + fork（图标 ghost）。
          一轮对用户是一个回复：action 只在轮尾段（hideActions 由 TurnGroup 裁决），
          复制内容 = 整轮全部 text 段合并（copyText 覆盖）。 */}
      {row.state === "complete" && !hideActions && !deferActions ? (
        <ConversationAssistantTextActions
          rowId={row.rowId}
          entityId={row.entityId}
          text={copyText ?? row.text}
          createdAt={row.createdAt}
          compactForRemoteControl={context.compactForRemoteControl}
          feedback={readAssistantFeedback(row)}
          sessionId={context.sessionId}
          onFork={onFork}
          onRetry={onRetry}
          onFeedbackChange={onFeedbackChange}
          className={cn(
            "mt-1",
            context.compactForRemoteControl
              ? "opacity-100"
              : "opacity-0 transition-opacity group-hover/assistant-row:opacity-100 focus-within:opacity-100",
          )}
        />
      ) : null}
    </RowShell>
  );
});

// reasoning 行：折叠展示思考过程。流式且无文本时完全不渲染，避免空折叠条。
// ReasoningRowView 只负责展示，是否显示思考过程由分派器裁决，本组件不读全局开关。
// 因此本组件对隐藏逻辑无感知，便于单独测试折叠行为。
// 展开/收起由 ai-elements 组件内部管理，本组件只传状态与文案。
const ReasoningRowView = memo(function ReasoningRowView({
  row,
  contentVariant,
}: {
  row: ReasoningRow;
  contentVariant?: "default" | "nested";
}) {
  // 运行态决定文案与流光效果；完成态仍默认收起，用户可手动展开。
  const streaming = row.state === "streaming";
  // 外观对齐旧 ThoughtBlock（旧版 chatMessageParts）：ai-elements Reasoning
  // 折叠组件。交互调整原因：流式 reasoning 默认展开会持续挤压工具和正文空间；
  // 现在 streaming/complete 都默认收起，只保留运行态文案，用户可手动展开。
  // autoCollapseKey 仍保证状态边界不会覆盖已经发生过的用户交互。
  // 时长向上取整且至少 1 秒：0 秒会让“思考了 0 秒”显得像缺陷。
  // durationMs 缺失时不传 duration，组件只显示“思考中/已思考”文案。
  // 取整只影响展示，不写回 row。
  const durationSeconds =
    row.durationMs !== undefined ? Math.max(1, Math.ceil(row.durationMs / 1000)) : undefined;
  // 流式但还没有任何文本：整行不渲染；否则会出现一个空的“思考中”占位。
  // 一旦有首个 token，行出现并保持到完成；不会因为文本清空而闪烁消失。
  // 完成态即使文本为空也渲染：那是投影给出的“确实没有思考内容”。
  if (streaming && row.text.length === 0) {
    return null;
  }
  // autoCollapseKey 在完成时切换，保证状态边界不会覆盖用户已发生的展开操作。
  // streaming 传 null：流式期间不触发自动折叠，用户手动展开后保持展开。
  // autoCollapseKey 只驱动折叠而不参与内容渲染；完成态取 row.state，流式传 null。
  return (
    <RowShell rowId={row.rowId}>
      <Reasoning
        className="w-full"
        isStreaming={streaming}
        autoCollapseKey={streaming ? null : row.state}
        {...(durationSeconds !== undefined ? { duration: durationSeconds } : {})}
      >
        {/* Bug 原因：附件重构合并时误丢了 streamingText 接线，导致摘要组件仍在但永远收到空文本。 */}
        <ReasoningTrigger streamingText={row.text} />
        <div data-conversation-selectable="true">
          <ReasoningContent variant={contentVariant}>{row.text}</ReasoningContent>
        </div>
      </Reasoning>
    </RowShell>
  );
});

// 轮头：调试/诊断用的一行元信息（来源与状态），不参与产品主视觉。
// 它不做 i18n：origin/state 是协议枚举，直接展示便于排查。
// 视觉上用 border-b 与正文分隔，但不加背景，避免看起来像可交互区块。
const TurnHeaderRowView = memo(function TurnHeaderRowView({ row }: { row: TurnHeaderRow }) {
  return (
    <RowShell
      rowId={row.rowId}
      className="border-b border-[var(--color-border)] py-1 text-ui-sm text-[var(--color-foreground-subtle)]"
    >
      turn · {row.origin} · {row.state}
    </RowShell>
  );
});

/** 分隔线图标（对齐旧版 synthetic-timeline dividers：size-3.5 subtle）。 */
// 分隔线图标是模块级 JSX 常量：它们不含状态，复用同一元素可避免每次渲染重建。
// 常量元素被多处 memo 组件共享是安全的：React 元素不可变，复用不会导致更新。
// 图标统一 size-3.5 + subtle，保持四种标记的视觉权重一致。
const MARKER_ARCHIVE_ICON = (
  <ArchiveIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);
const MARKER_FORK_ICON = (
  <GitBranchIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);
const MARKER_GOAL_ICON = (
  <GoalIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);
const MARKER_MODEL_ICON = (
  <ArrowRightLeftIcon
    aria-hidden="true"
    className="size-3.5 shrink-0 text-[var(--color-foreground-subtle)]"
  />
);

/**
 * 系统标记分隔线壳：两侧细横线 + 居中「图标 + 文案」pill，视觉对齐旧版
 * ChatMessage synthetic-timeline dividers（fork / compaction / goal 同款）。
 * running（压缩/校验进行中）隐藏图标、文案走 animated-gradient-text 流光（同旧版）。
 */
// 分隔线壳：两侧细线 + 居中 pill。running 时隐藏图标并给文案加流光，
// 细线用 h-px 而不是 border，避免在不同 DPI 下变成 2px。
// 两侧 min-w-8 保证长文案时仍有可见线段，短文案时也不会挤成一点。
// 与旧版 synthetic-timeline 的视觉保持一致。
function MarkerDividerRow({
  rowId,
  markerType,
  markerStatus,
  markerOrigin,
  markerSourceCommandId,
  icon,
  label,
  running = false,
  onClick,
}: {
  rowId: number;
  markerType: TimelineMarkerRow["marker"]["type"];
  markerStatus: string;
  markerOrigin?: string;
  markerSourceCommandId?: string;
  icon: React.ReactNode;
  label: React.ReactNode;
  running?: boolean;
  /** 传入即整行可点（fork→跳父会话）；不传为静态分隔线。 */
  onClick?: () => void;
}) {
  // 可点性只由 onClick 决定：传入即整行 button，不传即静态 div。
  // 这里不做 disabled：没有 onClick 就已经不可交互，不需要第三种态。
  // running 与 clickable 独立：压缩进行中的提示也可以是可点的 fork 提示。
  const clickable = Boolean(onClick);
  const rowClassName =
    "flex w-full items-center gap-3 px-4 py-2 text-ui-base text-[var(--color-foreground-subtle)]";
  // inner 复用于 button 与 div 两种外壳，保证视觉完全一致，只有语义不同。
  // 文案断行用 break-words：长模型名或长会话名不能撑破居中 pill。
  // 两侧线条 aria-hidden：它们是装饰，不应被读屏朗读。
  const inner = (
    <>
      <div aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
      <span className="inline-flex min-w-0 shrink items-center justify-center gap-1.5 text-center leading-5">
        {running ? null : icon}
        <span
          className={`min-w-0 break-words${running ? " animated-gradient-text font-medium" : ""}${clickable ? " underline-offset-4 group-hover/marker:underline" : ""}`}
        >
          {label}
        </span>
      </span>
      <div aria-hidden="true" className="h-px min-w-8 flex-1 bg-border/50" />
    </>
  );
  // 整行 button：hover 变亮 + 文案下划线，示意可跳转（fork → 父会话）。
  // 用 button 而不是 div + role，直接获得键盘与焦点语义。
  // data-* 与静态分支完全一致，e2e 无需区分两种外壳。
  if (onClick) {
    // 整行 <button>（对齐旧版 fork divider）：hover 变亮 + 文案下划线示意可点。
    return (
      <button
        type="button"
        data-row-id={rowId}
        data-row-kind="timelineMarker"
        data-marker-type={markerType}
        data-status={markerStatus}
        data-origin={markerOrigin}
        data-source-command-id={markerSourceCommandId}
        data-testid={testId(TID_V4_ROW, String(rowId))}
        onClick={onClick}
        className={`group/marker ${rowClassName} text-left transition-colors hover:text-[var(--color-foreground)]`}
      >
        {inner}
      </button>
    );
  }
  return (
    <div
      data-row-id={rowId}
      data-row-kind="timelineMarker"
      data-marker-type={markerType}
      data-status={markerStatus}
      data-origin={markerOrigin}
      data-source-command-id={markerSourceCommandId}
      data-testid={testId(TID_V4_ROW, String(rowId))}
      className={rowClassName}
    >
      {inner}
    </div>
  );
}

/**
 * timelineMarker 行渲染：compact / forkNotice / goalVerify / modelChange 画成分隔线。
 * modelChange 可见化 = 裁决（切换后实际发送出去的轮才落分隔，含
 * model-only 续跑轮）；goalSet/forkCreated 已在投影层停产（隐形行清零），
 * retryNotice·checkpointRestored 无 UI，default 分支兜底不渲染。
 */
// timelineMarker 行：把协议 marker 映射成人类可读的分隔线。
// 映射层不读全局状态，只依赖 marker、intl 与模型目录视图。
// 因此同一条 marker 在任意会话中渲染结果一致（模型名除外）。
// 映射集中在 useMemo 的 switch 里，返回 null 表示“该 marker 无 UI”。
const TimelineMarkerRowView = memo(function TimelineMarkerRowView({
  row,
  context,
}: {
  row: TimelineMarkerRow;
  context: ConversationRowRenderContext;
}) {
  // intl 与 office 模式都参与文案选择，因此都在依赖里。
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const marker = row.marker;
  // 模型名解析依赖当前模型目录快照：目录水合后同名模型也能显示正确 provider。
  // 目录缺失时 resolveProviderLabel 回退到 provider id，至少不会显示空白。
  // marker 自身携带的 from/to 元组是主信息，目录只用于美化。
  const modelSelectionView = context.modelSelectionView ?? null;
  // [权衡] view 用 useMemo 计算：marker 是引用稳定的协议对象，
  // 目录/语言变化时才需要重算文案；避免每次渲染都做 switch 与格式化。
  const view = useMemo((): {
    icon: React.ReactNode;
    label: React.ReactNode;
    running: boolean;
  } | null => {
    // 只处理有 UI 的类型；其它 marker 必须落到 default 返回 null（隐形行清零）。
    switch (marker.type) {
  // compact：状态文案有 6 种组合，先算 running，再按 status/origin 取 i18n 键。
  // 所有键都在 chat.contextCompaction 或 chat.contextOptimization 命名空间下。
  // 新增 status 必须同时补两个命名空间的文案，否则会显示 key 本身。
      case "compact": {
        const running = marker.status === "running";
        const automaticOptimization = isOfficeMode && marker.origin === "auto";
        const scope = automaticOptimization ? "chat.contextOptimization" : "chat.contextCompaction";
        // 状态优先级：running → noop → cancelled → failed → 自动完成 → 完成。
        // 顺序不能换，否则 failed 会被“自动完成”覆盖。
        const statusMessage =
          marker.status === "running"
            ? "started"
            : marker.status === "noop"
              ? "skipped"
              : marker.status === "cancelled"
                ? "interrupted"
                : marker.status === "failed"
                  ? "failed"
                  // 仅“非 Office 模式的自动压缩完成”用 completedAuto 文案；Office 模式统一叫上下文优化。
                  : marker.origin === "auto" && !automaticOptimization
                    ? "completedAuto"
                    : "completed";
        return {
          icon: MARKER_ARCHIVE_ICON,
          label: intl.formatMessage({ id: `${scope}.${statusMessage}` }),
          running,
        };
      }
  // forkNotice：派生会话提示，图标固定，不可点由上层决定。
  // 它不携带状态：派生关系是既成事实，没有 running/complete 之分。
  // 文案里的会话名由宿主提供，这里只显示固定句式。
      case "forkNotice":
        return {
          icon: MARKER_FORK_ICON,
          label: intl.formatMessage({ id: "chat.message.fork.derivedFrom" }),
          running: false,
        };
  // modelChange：marker 自带 provider/model 元组，渲染必须两者都用，
  // 只读 model 会让同名模型看起来“没有切换”。
      case "modelChange": {
        // marker 已携带完整 provider/model 元组，旧渲染却只读取 model，
        // 且没有订阅 provider snapshot，导致同名模型无差异、目录水合后名称不刷新。
        // 这里保留 provider ID fallback，并让现有 marker 随目录更新。
        const fromProvider = resolveProviderLabel(marker.fromProvider, modelSelectionView);
        const toProvider = resolveProviderLabel(marker.toProvider, modelSelectionView);
        const to = formatModelChangeLabel(marker.toProvider, toProvider, marker.toModel, intl);
        // source-less 表示首次使用的模型事实，不是切换：不显示箭头，文案用“正在使用”。
        if (marker.fromProvider === undefined || marker.fromModel === undefined) {
          return {
            // source-less 表示首次使用的模型事实，不是模型切换，因此不显示切换箭头。
            icon: null,
            label: intl.formatMessage({ id: "chat.modelChange.using" }, { model: to }),
            running: false,
          };
        }
        // 有 from 才显示切换箭头与 from→to 文案。
        return {
          icon: MARKER_MODEL_ICON,
          label: intl.formatMessage(
            { id: "chat.modelChange.switched" },
            {
              from: formatModelChangeLabel(
                marker.fromProvider,
                fromProvider,
                marker.fromModel,
                intl,
              ),
              to,
            },
          ),
          running: false,
        };
      }
  // goalVerify：running/pass/其余 三态；notSatisfied 与 failed 统一归“未完成”。
  // 迭代次数始终展示，即使未完成也能看出跑到第几轮。
  // 文案由两个 span 拼接，innerText 形如“第 1 次迭代 · 目标校验中”，e2e 依赖该形态。
      case "goalVerify": {
        const running = marker.outcome === "running";
        // pass→完成；notSatisfied/failed→未完成（沿用旧版 failed_closed 归「未完成」的处理）。
        const statusId =
          marker.outcome === "running"
            ? "chat.goalVerification.checking"
            : marker.outcome === "pass"
              ? "chat.goalVerification.complete"
              : "chat.goalVerification.incomplete";
        return {
          icon: MARKER_GOAL_ICON,
          running,
          // innerText 形如「第 1 次迭代 · 目标校验中」，对齐 goal-timeline 待命 e2e 断言。
          label: (
            <>
              <span>
                {intl.formatMessage(
                  { id: "chat.summaryPanel.goalIterationValue" },
                  { count: String(marker.iteration) },
                )}
              </span>
              <span aria-hidden="true"> · </span>
              {intl.formatMessage({ id: statusId })}
            </>
          ),
        };
      }
  // 未覆盖的 marker 一律不渲染：新增类型必须先在这里显式接入，避免出现裸文案。
      default:
        return null;
    }
  }, [intl, isOfficeMode, marker, modelSelectionView]);

  // fork 跳父会话（Tier 1）：仅 forkNotice 且宿主提供 onNavigateToRow 时可点，
  // 切到 marker.parentSessionId（rowId 预留 Tier 2 精确滚动，当前恒 0 占位）。
  const onNavigate = context.onNavigateToRow;
  // forkNotice 且宿主提供导航能力时才可点；parentRowId 目前恒 0，预留给精确滚动。
  const handleClick = useMemo(() => {
    if (marker.type !== "forkNotice" || !onNavigate) {
      return undefined;
    }
    return () => onNavigate(marker.parentSessionId, marker.parentRowId);
  }, [marker, onNavigate]);

  // view 为 null 直接不渲染：连 RowShell 都不产生，避免空行参与虚拟列表测量。
  if (!view) {
    return null;
  }
  // markerStatus 按类型取不同字段：compact 用 status、goal 用 outcome、其余用固定值，
  // 这些值同时供 e2e 断言与样式选择。
  return (
    <MarkerDividerRow
      rowId={row.rowId}
      markerType={marker.type}
      markerStatus={
        marker.type === "compact"
          ? marker.status
          : marker.type === "goalVerify"
            ? marker.outcome
            : marker.type === "forkNotice"
              ? "created"
              : "applied"
      }
      markerOrigin={marker.type === "compact" ? marker.origin : undefined}
      markerSourceCommandId={row.sourceCommandId}
      icon={view.icon}
      label={view.label}
      running={view.running}
      onClick={handleClick}
    />
  );
});

// 工具卡行：把 v4 ToolCallRow 适配成旧 ToolCallBlock 的节点，再叠加 workflow 三种特化：
// 三种特化的判定顺序有依赖：补全行必须排在“发起行”之前，因为它的 toolCallId 不会命中 run 表。
// retune 必须排在最后：它要求“没有 display 且没有 run”，前两种都不满足。
// 已接进 run 的发起行、补全行、就地修订（retune）。命中特化时整个工具卡被摘要行替换。
const ToolCallRowView = memo(function ToolCallRowView({
  row,
  context,
}: {
  row: ToolCallRow;
  context: ConversationRowRenderContext;
}) {
  // toolCall 行回接 ToolCallBlocks（execute/read/edit/... renderer 按
  // tool identity 分流）。适配 memo 按 row 引用：row.delta/upserted 换新对象才重建。
  // [流式] 适配结果按 row 引用 memo：delta/upsert 更新会换新对象，未变时复用节点。
  // 适配不做深拷贝：ToolCallBlock 只读节点，不会就地修改。
  // 若上层原地修改 row，memo 与适配都会失效——这是全文件的不可变契约。
  // 这里不做深比较——row 的不可变更新是上层契约。
  const toolCallNode = useMemo(() => toolCallRowToLegacyNode(row), [row]);
  // workflow run 详情入口的门控：run 身份走 workflowRuns 投影（schema 里 toolCallId 就是
  // 「工具卡 → 详情页的关联键」），不从工具输出里读——v4 行的 output 只剩一句散文。
  // 命中的摘要同时决定卡片形态：有 run 就是紧凑可点卡，没有就是可展开卡。
  // run 身份只从投影查（toolCallId 是工具卡到详情页的关联键），不从输出文本推断。
  // 输出文本在 v4 行里已被压缩成一句散文，无法可靠解析出 runId。
  // workflowRun 只从 workflowRunByToolCallId 投影取；投影缺失时不解析输出文本猜测 runId，卡片退回普通形态。
  // resume 行额外按 runId 兜底：它的 toolCallId 永远不是原始发起行。
  const workflowRun =
    context.workflowRunByToolCallId?.get(row.toolCallId) ??
    // ResumeWorkflowRun 行按 runId 联接：display 载荷带 runId（≡ backgroundTaskId），而投影
    // 的 run.toolCallId 跨 resume 沿用原始 CreateWorkflow 行——resume 行按 toolCallId 永远
    // 查不到。命中后 onOpenWorkflowRun 的收窄走同一条路径，tab 身份 runId 键、幂等。
    (row.display?.kind === "resume_workflow_run"
      ? context.workflowRunByRunId?.get(row.display.runId)
      : undefined);
  // 已接进 run 的补全行（docs/dynamic-workflow/presentation.md「The fill row」）：「留白已补全 · {name} ·
  // {k} 个阶段 · {m} 个子代理 ↗」。按入参的 `run_id` 联接投影（补全行的 toolCallId 不是发起行的），只认成功
  // 且编过的行——编不过的补全走下面的编译反馈行，什么都没接进 run。卡下方随之长出新的站（轮尾摘要
  // 取的是这一行的图）。
  // 名字来自 display 的 `fill` 块（行的入参没有名字——transcript 只存模型自己的入参）。
  // 补全行按入参 run_id 联接：toolCallId 属于补全行自己，不能用于找发起行。
  // 名字来自 display.fill，因为 transcript 只保存模型入参，不含展示名。
  const fillTarget = isFillWorkflowHoleToolCall(row)
    ? readWorkflowHoleTarget(
        row.input,
        row.display?.kind === "create_workflow" ? row.display.fill : undefined,
      )
    : undefined;
  // fillRun 缺失表示还没接进 run（或投影未到）：此时继续走普通工具卡，不吞掉编译反馈。
  const fillRun =
    fillTarget?.runId === undefined ? undefined : context.workflowRunByRunId?.get(fillTarget.runId);
  // 只有“成功 + 编过 + 有 hole + 能找到 run”四个条件同时满足才替换成摘要卡；
  // row.status === error 时保留完整工具卡，编译诊断才能被看到。
  // display.ok 为假表示编译失败，同样走普通渲染。
  // 任一不满足都退回普通渲染，保证失败信息仍然可见。
  if (
    fillTarget !== undefined &&
    fillTarget.holeId !== undefined &&
    fillRun !== undefined &&
    row.status === "success" &&
    row.display?.kind === "create_workflow" &&
    row.display.ok
  ) {
    const sessionId = context.sessionId;
    const counts = workflowFillCounts(row.display.causalityGraph, fillTarget.holeId);
    return (
      <RowShell rowId={row.rowId} className="py-0">
        <WorkflowToolSummary
          toolCallId={row.toolCallId}
          summary={fillRun}
          fill={{
            name: fillTarget.name ?? fillTarget.holeId,
            ...counts,
          }}
          onOpen={
            context.onOpenWorkflowRun && sessionId
              ? () =>
                  context.onOpenWorkflowRun?.({
                    parentSessionId: sessionId,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, fillRun),
                    runId: fillRun.runId,
                  })
              : undefined
          }
        />
      </RowShell>
    );
  }
  // 原因：已启动的工具卡与轮尾摘要重复画同一条实时进度；上方改为普通摘要入口。
  // 只替换成功关联的发起行，编译诊断及 Resume 等其他工具仍走原有渲染。
  // 发起行特化：必须是 workflowRunByToolCallId 直接命中（resume 兜底不算），
  // 用 has() 再判一次，是为了区分“按 toolCallId 命中”与“按 runId 兜底命中”。
  // 只有前者才是这一行的实时进度卡，后者仍需要完整工具卡展示恢复参数。
  // 且状态不是 error。error 时保留完整工具卡，让用户看到失败详情。
  if (
    workflowRun &&
    context.workflowRunByToolCallId?.has(row.toolCallId) &&
    row.status !== "error"
  ) {
    const workflowName = readWorkflowName(row.input);
    const sessionId = context.sessionId;
    return (
      <RowShell rowId={row.rowId} className="py-0">
        <WorkflowToolSummary
          toolCallId={row.toolCallId}
          summary={workflowRun}
          amend={isAmendWorkflowToolCall(row)}
          onOpen={
            context.onOpenWorkflowRun && sessionId
              ? () =>
                  context.onOpenWorkflowRun?.({
                    parentSessionId: sessionId,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                    ...(workflowName === undefined ? {} : { workflowName }),
                  })
              : undefined
          }
        />
      </RowShell>
    );
  }
  // 就地生效的修订（docs/dynamic-workflow/concurrency.md）：只改并发上限、run 又在飞时这次调用
  // 不编译、不铸新 run，结果只有一句话。判据全在已经上线的字段上——入参的形状、**没有** display、
  // 成功且非错误；工具的结构化输出不过 v4，而三处 create_workflow display schema 都是冻结字段集
  // 的 `.strict()`，多一个键会让旧端把整条工具结果丢掉，所以这条路不新增任何协议字段。
  // 退回真修订的那一条（run 已结算）两条判据都不成立：它有 display，也铸出一条按 toolCallId
  // 联接得上的 run，上面那个分支先接走它。
  const retune = isAmendWorkflowToolCall(row) ? readWorkflowRetuneCall(row.input) : undefined;
  // 有 display 或已能按 toolCallId 找到 run 的调用属于“真修订”，由上两个分支接走。
  if (
    retune !== undefined &&
    row.status === "success" &&
    (row.output?.display ?? row.display) === undefined &&
    !context.workflowRunByToolCallId?.has(row.toolCallId)
  ) {
    const sessionId = context.sessionId;
    // 被调整那条 run 的投影：只为两件事——默认并发（措辞据它把「等于默认」念成「恢复为默认」）与
    // 打开请求里那条 run 的发起行 id。它不进上面的 `workflowRun`：那个变量回答的是「这一行是不是
    // 某条 run 的发起行」，而这一行不是。
    // 被调整的 run 投影只用于两件事：默认并发措辞、打开详情时的发起行 id。
    // 它不进入 workflowRun 变量——那一行不是该 run 的发起行。
    const retuned = context.workflowRunByRunId?.get(retune.runId);
    const defaultConcurrency =
      retuned?.run === undefined ? undefined : workflowRunDefaultConcurrency(retuned.run);
    return (
      <RowShell rowId={row.rowId} className="py-0">
        <WorkflowRetuneRow
          requested={retune.requested}
          runId={retune.runId}
          {...(defaultConcurrency === undefined ? {} : { defaultConcurrency })}
          {...(context.onOpenWorkflowRun && sessionId
            ? {
                onOpen: () =>
                  context.onOpenWorkflowRun?.({
                    parentSessionId: sessionId,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, retuned),
                    runId: retune.runId,
                  }),
              }
            : {})}
        />
      </RowShell>
    );
  }
  // 工具行去掉纵向内边距（对齐 z-code-2 无 per-tool padding）；连续工具间距由
  // 若在这里加 padding，连续工具卡之间会出现双倍间距，且与文本行的节奏不一致。
  // 因此调整间距只能改外层容器，不能改行。
  // ConversationAssistantWorkItems 的 gap-4 组容器统一给。
  // ToolCallBlock 是旧渲染器的统一入口：execute/read/edit 等按 tool identity 分流。
  // 权限卡与工具卡都由它内部按身份挂载，本文件不重复判定。
  // 唯一例外是 todo 的整行裁剪（见分派器），因为空 RowShell 会留下间距。
  return (
    <RowShell rowId={row.rowId} className="py-0">
      <div data-conversation-selectable="true">
        <ToolCallBlock
          toolCallNode={toolCallNode}
          workspacePath={context.workspacePath}
          theme={context.theme}
          codePreviewSettings={context.codePreviewSettings}
          showTodoToolCalls={context.messageStreamShowTodos === true}
          onOpenCodeViewer={context.onOpenCodeViewer}
          onOpenFileLink={context.onOpenFileLink}
          onOpenBrowserUrl={context.onOpenBrowserUrl}
          onOpenAutomationsMain={context.onOpenAutomationsMain}
          // plan 详情需要 parentSessionId：宿主用它定位会话，行内只补这一项。
          onOpenPlanDetail={
            context.onOpenPlanDetail && context.sessionId
              ? (request) =>
                  context.onOpenPlanDetail?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                  })
              : undefined
          }
          // 打开 run 详情的关联键是发起行 id（不是当前行 id）：resume 与补全行都会不同。
          // resolveWorkflowRunOpenToolCallId 已封装这条规则，所有入口都必须调用它。
          // 手写 row.toolCallId 会让 resume 行打开错误的 causalityGraph。
          onOpenWorkflowRun={
            context.onOpenWorkflowRun && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowRun?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                    // 打开请求的关联键是发起行（CreateWorkflow）id，不是点中行的 id——
                    // resume 行点开时两者不同，详情页拿它找 causalityGraph/脚本。
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                  })
              : undefined
          }
          // actor 打开同样需要 sessionId；workflowRun 缺失时不提供入口。
          onOpenWorkflowActor={
            context.onOpenWorkflowActor && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowActor?.({ ...request, parentSessionId: context.sessionId! })
              : undefined
          }
          // 脚本药丸 → 脚本 transcript：关联键同 onOpenWorkflowRun（发起行 id + runId）。
          // 脚本工作区与 run 详情共用关联键：发起行 id + runId，保证落到同一份 causalityGraph。
          onOpenWorkflowWorkspace={
            context.onOpenWorkflowWorkspace && context.sessionId && workflowRun
              ? (request) =>
                  context.onOpenWorkflowWorkspace?.({
                    ...request,
                    parentSessionId: context.sessionId!,
                    toolCallId: resolveWorkflowRunOpenToolCallId(row.toolCallId, workflowRun),
                    runId: workflowRun.runId,
                  })
              : undefined
          }
          // 恢复入口只在 run 可恢复时提供：不可恢复时传 undefined，卡片不渲染按钮。
          // 恢复需要 workflowName：它来自入参，缺失时传 undefined 由卡片回退。
          // 该回调不携带 parentSessionId，宿主按 runId 自行定位。
          onResumeWorkflowRun={
            context.onResumeWorkflowRun && workflowRun?.resumable
              ? (request) => context.onResumeWorkflowRun?.(workflowRun.runId, request.workflowName)
              : undefined
          }
          // 产物药丸 → 产物 tab：与通知行的 chips 同一条打开路径（不带版本号，打开即最新版）。
          // 产物打开：从活投影里取该 artifact 的最新摘要（title/contentType），
          // 找不到也照常打开——宿主会自行查 journal 补齐。
          onOpenWorkflowArtifact={
            context.onOpenWorkflowArtifact && context.sessionId && workflowRun
              ? (artifactId) => {
                  // 活投影的产物摘要带最新版的 `contentType`（宿主据它把 html 产物直接开成
                  // 浏览器 tab）；`sourcePath` 那份摘要刻意不带，缺席时宿主自己查 journal。
                  const artifact = workflowRun.run?.artifacts?.find(
                    (candidate) => candidate.id === artifactId,
                  );
                  context.onOpenWorkflowArtifact?.({
                    parentSessionId: context.sessionId!,
                    runId: workflowRun.runId,
                    artifactId,
                    ...(artifact?.title === undefined ? {} : { title: artifact.title }),
                    ...(artifact?.contentType === undefined
                      ? {}
                      : { contentType: artifact.contentType }),
                  });
                }
              : undefined
          }
          workflowRun={workflowRun}
          workflowDraft={context.workflowDraftByToolCallId?.get(row.toolCallId)}
        />
      </div>
    </RowShell>
  );
});

// subagent 裸行：正常情况下与 Agent/Task 工具行配对渲染，这里只做异常兜底摘要，
// 因此它没有独立的下钻入口，也没有状态图标——避免与工具卡形成两套交互。
// 若未来需要独立卡片，应先确认配对逻辑是否已经移除，否则会出现重复入口。
// 不再生成第二套子会话卡片或下钻入口。
const SubagentRowView = memo(function SubagentRowView({ row }: { row: SubagentRow }) {
  // subagent 行已经和 Agent/Task 工具行配对渲染；裸行只保留异常兜底摘要，
  // 避免再生成一个“子会话”卡片或第二套下钻入口。
  // 摘要只拼三要素：类型 · 状态 — 概要；缺失概要时不留分隔符。
  // 该行不是主渲染路径，因此不做 i18n 与图标，保持最小信息量。
  // 若未来需要交互，应回到配对渲染逻辑，而不是给裸行加入口。
  const summary = (
    <>
      {row.subagentType} · {row.status}
      {row.summaryText ? ` — ${row.summaryText}` : ""}
    </>
  );
  return (
    <RowShell rowId={row.rowId}>
      <div className="text-ui-sm text-[var(--color-foreground-subtle)]">{summary}</div>
    </RowShell>
  );
});

/**
 * v4 row 渲染分发。memo：虚拟列表逐行渲染，父投影变化时只有 props 真正变化的行才重渲染
 * （前提是 onFork/onRetry/onEdit 为稳定引用 + context 引用稳定，见 SessionPane 的
 * useCallback/useMemo）。
 */
// 行分派器：一个 switch 覆盖全部 kind，每个分支只做“传参 + 选择叶子”。
// 分支内不做条件 hook，也不做数据加工；这保证每次渲染的 hook 顺序稳定。
// 传入的 props 直接来自 ConversationRowViewProps，不做默认值合并（默认值在叶子内部）。
// 不在分支里做数据加工，保证叶子看到的就是协议行原样。
function ConversationRowViewImpl({
  row,
  context,
  onFork,
  onRetry,
  onFeedbackChange,
  onEdit,
  editWorkspaceRewindAvailability,
  hideAssistantActions,
  deferAssistantActions,
  assistantCopyText,
  assistantPreviewCards,
  assistantPreviewCardsAutoOpenKey,
  assistantCodeCommentCards,
  assistantCodeCommentProjectionEnabled,
  reasoningContentVariant,
  userInputStatus,
}: ConversationRowViewProps) {
  // switch 的完备性靠类型检查兜底：新增 kind 会在这里报错，而不是静默不渲染。
  // default 分支只服务“旧 renderer 读到新协议行”的向下兼容。
  // 它必须返回 null，不能兜底成通用文本，否则未知行会以半成品形式出现。
  // default 返回 null 只服务“未来协议行向下兼容”，正常类型不会走到。
  switch (row.kind) {
  // userInput 叶子的 status 来自 renderer-only 的 userInputStatus，不写回协议。
    case "userInput":
      return (
        <UserInputRowView
          row={row}
          context={context}
          onEdit={onEdit}
          editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
          status={userInputStatus}
        />
      );
  // assistantText 的轮级参数都由 TurnGroup 计算后下发；叶子不自行推导。
    case "assistantText":
      return (
        <AssistantTextRowView
          row={row}
          context={context}
          onFork={onFork}
          onRetry={onRetry}
          onFeedbackChange={onFeedbackChange}
          hideActions={hideAssistantActions}
          deferActions={deferAssistantActions}
          copyText={assistantCopyText}
          previewCards={assistantPreviewCards}
          previewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
          codeCommentCards={assistantCodeCommentCards}
          codeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
        />
      );
    case "reasoning":
      // 关闭“显示思考过程”只隐藏每轮后续 reasoning；首条 reasoning
      // 是该轮最小必要思考提示，必须由 turn 全序派生的 rowId 保留下来。
      return isConversationReasoningRowVisible(row.rowId, context) ? (
        <ReasoningRowView row={row} contentVariant={reasoningContentVariant} />
      ) : null;
  // turnHeader 是调试信息行，无交互、无上下文依赖。
    case "turnHeader":
      return <TurnHeaderRowView row={row} />;
  // timelineMarker 需要 context 读模型目录与导航回调。
  // 只读两个字段：modelSelectionView 与 onNavigateToRow，其余上下文与它无关。
  // 因此该叶子的重渲染面比 assistantText 小得多。
    case "timelineMarker":
      return <TimelineMarkerRowView row={row} context={context} />;
  // [挂载条件] todo 工具卡在开关关闭时连 RowShell 都不渲染：
  // 判定用 resolveToolCallIdentity 的 family，而不是比较工具名，
  // 这样新增的 todo 类工具（不同名字）也会被同一规则收口。
  // 只在叶子内部返回 null 会留下空壳与 gap，导致时间线出现无法解释的间隔。
    case "toolCall":
      // 只在 ToolCallBlock 内返回 null 会留下空 RowShell 和多余间距；
      // 在行分发处按同一工具身份规则裁剪，设置关闭时不产生任何 Todo DOM。
      if (
        context.messageStreamShowTodos !== true &&
        resolveToolCallIdentity({ toolName: row.toolName, kind: row.toolName }).family === "todo"
      ) {
        return null;
      }
      return <ToolCallRowView row={row} context={context} />;
    case "subagent":
      return <SubagentRowView row={row} />;
    case "artifact":
      return <ArtifactRowView row={row} />;
  // 未知 kind 不渲染：向下兼容旧 renderer 读到新协议行时不至于崩溃。
  // 与“已知但当前不可见”的行不同：后者返回 null 是产品裁决，这里是协议兜底。
  // 两种情况都不会产生 RowShell，因此不会打乱虚拟列表的测量。
    default:
      return null;
  }
}

// memo 包在最外层：虚拟列表逐行渲染时，只有 props 真正变化的行才重渲染。
// 这是整个文件唯一导出的组件；叶子全部内部可见，避免外部绕过 memo 直接调用。
// 若宿主的回调引用不稳定，这层 memo 会退化成每次重渲染——性能问题应回到 SessionPane 修。
// 该优化成立的前提是 onFork/onRetry/onEdit/context 均为稳定引用（见 SessionPane）。
export const ConversationRowView = memo(ConversationRowViewImpl);
