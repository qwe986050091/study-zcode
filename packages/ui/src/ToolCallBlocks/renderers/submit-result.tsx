// INV-01 读时归一化不抛错：守住位置 所有 try/catch；改错故障 一条畸形载荷让整张卡崩掉。
// INV-02 字符串只解析一次：守住位置 normalizeSubmittedResult；改错故障 多层 parse 把普通文本改成结构。
// INV-03 标量字面量保持原样：守住位置 typeof parsed 判断；改错故障 模型写的数字被当成结构化载荷。
// INV-04 展开门是 result 键在场：守住位置 "result" in input；改错故障 提交 null 时没有展开入口。
// INV-05 驳回态是扁平行：守住位置 hasDetails 的 !isRejected；改错故障 驳回时仍提供空展开面板。
// INV-06 驳回原文按通道优先：守住位置 errorText 到 output 的空值链；改错故障 只显示泛化失败。
// INV-07 拒绝与停止同一句话：守住位置 isStopped 合并 denied；改错故障 状态文案缺词条。
// INV-08 提交中三条件：守住位置 isSubmitting 的与运算；改错故障 失败态仍显示转圈。
// INV-09 概要截断有上限：守住位置 INLINE_PREVIEW_MAX_LENGTH；改错故障 折叠头被长文本撑开。
// INV-10 结构化走 CodeBlock：守住位置 isProse 的另一分支；改错故障 JSON 被当普通文本挤成一行。
// INV-11 文本结果不渲染 markdown：守住位置 isProse 分支的 p；改错故障 用户原话被当成文档解析。
// INV-12 序列化失败退回 String：守住位置 stringifyResult 的 catch；改错故障 循环引用让卡片白屏。
// INV-13 快照提示独立挂载：守住位置 ToolSnapshotFieldNotice；改错故障 不展开就看不到字段缺失。
// INV-14 图标纯装饰：守住位置 aria-hidden；改错故障 读屏重复播报图标语义。
//
// 模块职责：submit_result 工具卡的折叠头与展开体，含结果归一化与两种渲染形态。
// 阅读顺序：先看归一化与序列化，再看状态判定，最后看折叠摘要与展开内容。
import { ClipboardCheckIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

const SUBMIT_RESULT_TOOL_ICON = (
  <ClipboardCheckIcon className="size-4 shrink-0 text-foreground-subtle" />
);

/** 折叠头部的单行概要上限：概要只是「大概提交了什么」，整段内容在展开后的 body 里。 */
// 概要只给大概，完整内容在展开体 `detailExpanded` 里。
const INLINE_PREVIEW_MAX_LENGTH = 160;

// 输入可能是对象，也可能是 JSON 字符串。
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

/**
 * 提交内容的读时归一化：字符串先试**一次**宽容 `JSON.parse`，解析出对象/数组才用解析值。
 *
 * 这是引擎侧实盘结论的读侧镜像——`engine/scheduler.ts` 记档「真实模型常把 result 序列化成
 * JSON 字符串」并做同款单次宽容 parse。不做多层递归 parse（引擎也只做一次），解析失败就按
 * 字符串对待，绝不抛错毁卡，也绝不改写任何数据。
 */
// 与引擎侧一致：`JSON.parse` 只调用一次，失败即换展示。
function normalizeSubmittedResult(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  if (value.trim().length === 0) {
    return value;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    // 数字 / 布尔 / null 的字面量字符串保持原样：那是模型写的那句话，不是结构化载荷。
    // 标量字面量保留原字符串。
    return typeof parsed === "object" && parsed !== null ? parsed : value;
  } catch {
    return value;
  }
}

/** JSON 分支的缩进文本。循环引用之类的病态载荷退回 `String(...)`，卡片不能因载荷而崩。 */
// 序列化失败退回字符串，卡片不能崩。
function stringifyResult(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 折叠头部的单行概要：换行折叠成空格，超长截断。 */
function toInlinePreview(value: unknown): string | undefined {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }

  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) {
    return undefined;
  }

  return collapsed.length > INLINE_PREVIEW_MAX_LENGTH
    ? `${collapsed.slice(0, INLINE_PREVIEW_MAX_LENGTH)}…`
    : collapsed;
}

export function SubmitResultToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const input = toRecord(toolCall.input);
  // 修复原因照 send-message：streaming 首帧的 input 可能还是 `{}`，不能为一个空面板提供
  // 展开入口。门是「result 键在场」而不是「result 有值」——提交 null 也是一次真实提交。
  // 门是键在场，提交 null 也是一次真实提交。
  const hasResult = input !== undefined && "result" in input;
  const normalizedResult = useMemo(
    () => (hasResult ? normalizeSubmittedResult(input?.result) : undefined),
    [hasResult, input?.result],
  );
  const isProse = typeof normalizedResult === "string";

  // 驳回与停止是两种结果：`rejected` 与 `stopped` 卡面文案不同。
  const isRejected = toolCall.status === "failed";
  // 拒绝与停止在卡面上是同一句话：提交没走完。spec 只定义四相，不为 denied 造第五个词条。
  // 拒绝与停止共用「未走完」文案。
  const isStopped = toolCall.status === "stopped" || toolCall.status === "denied";
  const isSubmitting =
    !isRejected &&
    !isStopped &&
    (context.isRunning || toolCall.status === "pending" || toolCall.status === "in_progress");
  const kindLabelId = isRejected
    ? "chat.toolCall.submitResult.rejected"
    : isStopped
      ? "chat.toolCall.submitResult.stopped"
      : isSubmitting
        ? "chat.toolCall.submitResult.submitting"
        : "chat.toolCall.submitResult.submitted";

  // 驳回原文：错误通道优先，其次工具自己的错误字段与纯文本输出。接受态的输出恒为
  // 「The result was accepted.」，没有信息量，从不读。
  // 错误通道优先，其次错误字段与纯文本输出。
  const rejectionText = isRejected
    ? (context.errorText ?? readText(toolCall.error) ?? readText(toolCall.output))
    : undefined;
  // 驳回态是扁平行，不给展开入口；驳回原文走失败态 tooltip（可悬停复制），不再有逐字段
  // 违规面板。rejectionText 只在驳回态存在，故非驳回态的展开门只看 result 键是否在场。
  // 驳回态扁平展示，不提供展开。
  const hasDetails = !isRejected && hasResult;

  const resultLabel = intl.formatMessage({ id: "chat.toolCall.submitResult.resultHeading" });
  const inlinePreview = useMemo(
    () => (hasResult ? toInlinePreview(normalizedResult) : undefined),
    [hasResult, normalizedResult],
  );
  const primaryText = useMemo(
    () => (
      <span className="min-w-0 truncate">{inlinePreview ?? toolCall.title ?? "submit_result"}</span>
    ),
    [inlinePreview, toolCall.title],
  );

  const theme = context.theme;
  const renderContent = useCallback(
    () => (
      <div className="space-y-3">
        {hasResult ? (
          <section className="space-y-1.5">
            <h4 className="text-ui-sm font-medium text-foreground-subtlest">{resultLabel}</h4>
            {isProse ? (
              // 人话是 prose：DESIGN.md 把 mono 留给路径/命令/代码/标识符/终端数据。
              // 刻意不做 markdown 渲染——result 字符串没有 markdown 契约。
              <p className="whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 text-ui-base leading-5 text-foreground">
                {normalizedResult as string}
              </p>
            ) : (
              // 结构化载荷走 CodeBlock（尊重用户的代码字号设置），容器逐字照 mcp.tsx。
              <div className="max-h-72 overflow-auto rounded-xl border border-border bg-card">
                <CodeBlock
                  appTheme={theme}
                  // 结构化载荷交给 CodeBlock 渲染。
                  code={stringifyResult(normalizedResult)}
                  language="json"
                />
              </div>
            )}
          </section>
        ) : null}
      </div>
    ),
    [hasResult, isProse, normalizedResult, resultLabel, theme],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={SUBMIT_RESULT_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        hideSecondaryTextWhenOpen
        kindLabel={intl.formatMessage({ id: kindLabelId })}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={
          isRejected ? intl.formatMessage({ id: "chat.toolCall.status.failed" }) : undefined
        }
        statusTooltip={isRejected ? rejectionText : undefined}
        showFailureStatus={isRejected}
        isRunning={context.isRunning}
        title={toolCall.title}
        // 只有可展开时才挂内容渲染器。
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
