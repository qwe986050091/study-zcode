// INV-01 input 读侧只宽容解析一次：守住位置 toRecord；改错故障 多层字符串反复解析。
// INV-02 非对象与数组一律视为无输入：守住位置 类型判断；改错故障 数组下标被当字段读取。
// INV-03 空白文本不算有效值：守住位置 readText 与 trim；改错故障 空答案渲染出空段落。
// INV-04 单行概要只用于折叠行：守住位置 toInlinePreview；改错故障 折叠行换行把高度撑开。
// INV-05 只有 failed 才走失败样式：守住位置 isFailed；改错故障 成功确认被标红。
// INV-06 进行中优先于 pending 判断：守住位置 isAnswering 组合；改错故障 运行中显示已成答。
// INV-07 结构化拒绝优先取错误通道：守住位置 outcomeText 三元；改错故障 拒绝原因被成功输出盖住。
// INV-08 无详情时不可展开：守住位置 hasDetails；改错故障 展开后是一片空白。
// INV-09 qid 用等宽且可断行：守住位置 code 的 break-all；改错故障 长标识撑破卡片。
// INV-10 答案保留换行：守住位置 whitespace-pre-wrap；改错故障 多段答案挤成一行。
// INV-11 概要截断必须加省略号：守住位置 模板拼接；改错故障 用户误以为答案就这么短。
// INV-12 失败时状态标签与提示同源：守住位置 statusTooltip；改错故障 悬浮提示与正文不一致。
// INV-13 折叠行为由外部 context 决定：守住位置 canToggle 与 forceOpen；改错故障 工具卡绕过统一展开策略。
//
// 模块职责：ResolveWorkflowQuestion 工具卡的折叠概要、详情与失败态渲染。
// 阅读顺序：先看输入读取，再看状态判定，最后看详情分区与工具外壳参数。
import { MessageCircleReply } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const RESOLVE_QUESTION_TOOL_ICON = (
  <MessageCircleReply className="size-4 shrink-0 text-foreground-subtle" />
);

/** 折叠头部的单行概要上限：概要只是「大概答了什么」，整段答案在展开后的 body 里。 */
const INLINE_PREVIEW_MAX_LENGTH = 160;

/** 读时把 input 归一成对象：字符串先试**一次**宽容 `JSON.parse`（照 submit-result 的读侧惯例）。 */
// 对象直接返回：`typeof value === "object"` 且非数组才算记录。
// 字符串只试一次宽容解析，`JSON.parse` 抛错即放弃。
// 解析结果仍要求 `typeof === "object"` 且非数组，防止把数组当输入。
function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** 折叠头部的单行概要：换行折叠成空格，超长截断。 */
function toInlinePreview(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.length > INLINE_PREVIEW_MAX_LENGTH
    ? `${collapsed.slice(0, INLINE_PREVIEW_MAX_LENGTH)}…`
    : collapsed;
}

/**
 * ResolveWorkflowQuestion 工具卡。主代理按 qid 回答一个
 * 子代理从**正在跑的** workflow 里升级上来的阻塞问题；答案会成为那次 escalate 调用的结果原文。
 *
 * 折叠行：kindLabel（answering/answered）+ 答案单行概要。展开：question_id（mono qid 行）+ 完整
 * 答案 + 工具输出文本（成功确认，或三种结构化拒绝之一）。
 *
 * 关键：拒绝（未知 qid / 已作答 / run 不在飞 / 本会话无应答能力）走的是结构化失败，会带上
 * `status==="failed"`，此时才走失败样式；成功确认是普通结果。
 */
export function ResolveWorkflowQuestionToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const input = toRecord(toolCall.input);
  const questionId = readText(input?.question_id);
  const answer = readText(input?.answer);

  const isFailed = toolCall.status === "failed";
  // 失败态一律不算进行中，失败优先于其它状态。
  // 外层 context 的运行态与工具自身的 pending 都算在飞。
  // 这个组合决定折叠行的标签文案，不要在别处重复推导。
  const isAnswering =
    !isFailed &&
    (context.isRunning || toolCall.status === "pending" || toolCall.status === "in_progress");

  const kindLabel = intl.formatMessage({
    id: isAnswering
      ? "chat.toolCall.workflow.resolveQuestion.answering"
      : "chat.toolCall.workflow.resolveQuestion.answered",
  });
  const questionIdHeading = intl.formatMessage({
    id: "chat.toolCall.workflow.resolveQuestion.questionId",
  });
  const answerHeading = intl.formatMessage({ id: "chat.toolCall.workflow.resolveQuestion.answer" });
  const outcomeHeading = intl.formatMessage({
    id: "chat.toolCall.workflow.resolveQuestion.outcome",
  });
  const fallbackName = intl.formatMessage({
    id: "chat.toolCall.workflow.resolveQuestion.fallbackName",
  });

  // 结果文本：成功的确认文案（普通结果 → output），或结构化拒绝（错误通道优先）。
  // 失败时按错误文本、错误字段、输出字段的顺序回退。
  // 进行中不展示结果文本，避免出现半截确认。
  // 成功时只认 output，这是服务端的确认原文。
  const outcomeText = isFailed
    ? (context.errorText ?? readText(toolCall.error) ?? readText(toolCall.output))
    : isAnswering
      ? undefined
      : readText(toolCall.output);

  // 概要只在折叠行用，超长时截断并加省略号。
  // 依赖只有 answer，其它字段变化不触发重算。
  const inlinePreview = useMemo(() => toInlinePreview(answer), [answer]);
  const primaryText = useMemo(
    () => (
      <span className="min-w-0 truncate">{inlinePreview ?? toolCall.title ?? fallbackName}</span>
    ),
    [inlinePreview, toolCall.title, fallbackName],
  );

  // 三个字段全缺时不提供展开，避免空白详情。
  // 有任一字段即允许展开，哪怕只有结果文本。
  const hasDetails = questionId !== undefined || answer !== undefined || outcomeText !== undefined;

  // qid 是不透明标识，必须等宽并允许任意位置断行。
  // 答案正文保留换行与原样空白，交给 pre-wrap 处理。
  // 结果段落按 failed 切换边框颜色，文案同源不另算。
  const renderContent = useCallback(
    () => (
      <div className="space-y-3">
        {questionId !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{questionIdHeading}</h4>
            {/* qid 是不透明标识键 → mono。 */}
            <code className="block break-all rounded-lg border border-border bg-panel px-4 py-2 font-mono text-ui-sm text-foreground-subtle">
              {questionId}
            </code>
          </section>
        ) : null}
        {answer !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{answerHeading}</h4>
            <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground">
              {answer}
            </p>
          </section>
        ) : null}
        {outcomeText !== undefined ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{outcomeHeading}</h4>
            <p
              className={
                isFailed
                  ? "whitespace-pre-wrap break-words rounded-lg border border-destructive/40 bg-panel px-4 py-3 text-ui-base leading-5 text-foreground"
                  : "whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground-subtle"
              }
            >
              {outcomeText}
            </p>
          </section>
        ) : null}
      </div>
    ),
    [questionId, answer, outcomeText, isFailed, questionIdHeading, answerHeading, outcomeHeading],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={RESOLVE_QUESTION_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        hideSecondaryTextWhenOpen
        kindLabel={kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={
          isFailed ? intl.formatMessage({ id: "chat.toolCall.status.failed" }) : undefined
        }
        statusTooltip={isFailed ? outcomeText : undefined}
        showFailureStatus={isFailed}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={hasDetails ? renderContent : undefined}
      />
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </>
  );
}
