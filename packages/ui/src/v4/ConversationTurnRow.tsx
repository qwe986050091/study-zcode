// INV-01 薄壳装配：守住位置 组件体只有透传；改错故障 单轮行自行取 store 或改写行数据。
// INV-02 行数据只读：守住位置 row / context 两个必填参数；改错故障 组件内部派生第二份行状态。
// INV-03 回调全部可选：守住位置 onFork / onRetry / onEdit 的 ?；改错故障 只读场景必须伪造空函数。
// INV-04 编辑返回值宽类型：守住位置 Promise<CommandAck | boolean | void>；改错故障 上层无法区分拒绝与成功。
// INV-05 属性名不重命名：守住位置 解构与透传同名；改错故障 下游 context 字段与 props 脱节。
// INV-06 不吞未声明属性：守住位置 显式列举参数；改错故障 新增能力被静默丢弃。
// INV-07 复制文本有单一来源：守住位置 resolveAssistantCopyText；改错故障 各按钮各自拼串。
// INV-08 无文本行即无复制：守住位置 latestAssistantTextRow 早退；改错故障 空回答给出空剪贴板。
// INV-09 分段优先多段文本：守住位置 assistantTextRows.length 判断；改错故障 多段回答只复制最后一段。
// INV-10 计划正文按需补入：守住位置 ExitPlanMode 过滤；改错故障 漏掉结构化计划原文。
// INV-11 去重按内容判等：守住位置 includedSegments；改错故障 计划与正文重复复制两遍。
// INV-12 只认 toolCall 行：守住位置 row.kind 判断；改错故障 非工具行被当计划解析。
// INV-13 空计划跳过：守住位置 !markdown 分支；改错故障 末尾多出两个换行。
// INV-14 段间双换行拼接：守住位置 join("\n\n")；改错故障 复制出的段落黏成一段。
//
// 模块职责：单轮会话行的渲染入口，以及本轮回答复制文本的组装规则。
// 阅读顺序：先看属性透传，再看复制文本的分段来源，最后看计划去重。
import type {
  AttachmentRef,
  CommandAck,
  ConversationRow,
  ConversationRowTarget,
} from "@zcode/shared/zcode-protocol-v4";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";
import type { AssistantCodeCommentCard } from "@/lib/assistantCodeComment.js";
import { extractPlanToolCallContent } from "@/lib/planToolCall.js";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import type {
  AssistantFeedbackHandler,
  EditWorkspaceRewindAvailability,
} from "@/v4/ConversationRowView.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";

interface ConversationTurnRowProps {
  row: ConversationRow;
  context: ConversationRowRenderContext;
  onFork?: (target: ConversationRowTarget) => void;
  onRetry?: (target: ConversationRowTarget) => void;
  onFeedbackChange?: AssistantFeedbackHandler;
  onEdit?: (
    target: ConversationRowTarget,
    newText: string,
    attachments?: readonly AttachmentRef[],
    workspaceMode?: "preserve" | "rewind",
  ) => Promise<CommandAck | boolean | void> | CommandAck | boolean | void;
  editWorkspaceRewindAvailability?: EditWorkspaceRewindAvailability;
  hideAssistantActions?: boolean;
  deferAssistantActions?: boolean;
  assistantCopyText?: string;
  assistantPreviewCards?: AssistantPreviewCard[];
  assistantPreviewCardsAutoOpenKey?: string;
  assistantCodeCommentCards?: AssistantCodeCommentCard[];
  assistantCodeCommentProjectionEnabled?: boolean;
  reasoningContentVariant?: "default" | "nested";
  userInputStatus?: string;
}

// 单轮行只负责把属性交给行视图。
export function ConversationTurnRow({
  // row 必须原样下传给 ConversationRowView，不做拷贝，保持行数据只读。
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
// 解构到此结束，属性名必须与 ConversationTurnRowProps 逐字一致，否则透传会漏字段。
}: ConversationTurnRowProps) {
  return (
    // 渲染收敛到唯一行视图实现。
    <ConversationRowView
      row={row}
      context={context}
      // 分叉入口缺省时保持未连接。
      onFork={onFork}
      onRetry={onRetry}
      onFeedbackChange={onFeedbackChange}
      onEdit={onEdit}
      editWorkspaceRewindAvailability={editWorkspaceRewindAvailability}
      hideAssistantActions={hideAssistantActions}
      deferAssistantActions={deferAssistantActions}
      assistantCopyText={assistantCopyText}
      assistantPreviewCards={assistantPreviewCards}
      assistantPreviewCardsAutoOpenKey={assistantPreviewCardsAutoOpenKey}
      assistantCodeCommentCards={assistantCodeCommentCards}
      assistantCodeCommentProjectionEnabled={assistantCodeCommentProjectionEnabled}
      // reasoningContentVariant 由调用方选择，这里只透传，不读默认值。
      reasoningContentVariant={reasoningContentVariant}
      userInputStatus={userInputStatus}
    />
  );
}

// 复制文本从渲染单元推导，不读 DOM。
export function resolveAssistantCopyText(unit: ConversationTurnRenderUnit): string | undefined {
  // 没有回答文本就没有可复制内容。
  if (!unit.latestAssistantTextRow) {
    return undefined;
  }

  // assistantTextRows 多段优先，为空时退回 latestAssistantTextRow.text，保证总有可复制文本。
  const segments =
    unit.assistantTextRows.length > 0
      ? unit.assistantTextRows.map((segment) => segment.text)
      : [unit.latestAssistantTextRow.text];
  // 按内容建集合用于后续去重。
  const includedSegments = new Set(segments);
  for (const row of unit.assistantWorkRows) {
    // 只有计划工具行才是正文来源。
    if (row.kind !== "toolCall" || row.toolName !== "ExitPlanMode") continue;
    const markdown = extractPlanToolCallContent(toolCallRowToLegacyNode(row).toolCall, "").markdown;
    // 空正文与重复正文都不再追加。
    if (!markdown || includedSegments.has(markdown)) continue;
    // 产品边界：assistant 复制代表本轮完整可见回答。计划正文来自原位结构化 tool row，
    // 不能读取被 max-height/mask 裁切的卡片 DOM，也不能顺手混入普通工具输出。
    segments.push(markdown);
    includedSegments.add(markdown);
  }
  // 段落之间保留空行便于阅读。
  return segments.join("\n\n");
}
