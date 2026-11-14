// INV-01 折行主文案只取计数或空态，不展示运行明细：守住位置 primaryText；改错故障 折叠行被长文本撑开。
// INV-02 单复数使用独立文案键：守住位置 计数格式化；改错故障 英文出现 1 runs。
// INV-03 运行中与已结束使用不同动词：守住位置 kindLabel 条件；改错故障 进行中显示成已完成。
// INV-04 只有结构化结果才渲染行列表：守住位置 listDisplay 判定；改错故障 把任意输出解析成运行记录。
// INV-05 无结构化结果时回退到裁切后的纯文本：守住位置 fallbackText；改错故障 原始 JSON 直接铺满卡片。
// INV-06 空输出不产生展开区：守住位置 hasDetails；改错故障 出现空白可展开容器。
// INV-07 有运行记录才允许展开：守住位置 hasDetails 与 canToggle 组合；改错故障 空列表仍可点开。
// INV-08 截断提示只在服务端标记时出现：守住位置 truncated 判断；改错故障 正常结果也提示不完整。
// INV-09 失败状态必须走统一失败标签：守住位置 statusLabel 条件；改错故障 失败被渲染成普通完成。
// INV-10 快照字段提示必须保留全量加载入口：守住位置 ToolSnapshotFieldNotice；改错故障 被裁字段无法恢复。
// INV-11 行列表为空时单独渲染空态：守住位置 runs.length 判断；改错故障 出现空容器。
// INV-12 每行状态词由状态枚举拼键：守住位置 模板字符串；改错故障 未知状态显示原始枚举。
// INV-13 中断原因只在存在时追加：守住位置 stopReason 判断；改错故障 每行都显示空原因。
// INV-14 本会话标记是展示签，不是筛选条件：守住位置 ownedByThisSession；改错故障 其他会话的运行被隐藏。
// INV-15 可能中断只做行尾警示，不改写状态：守住位置 possiblyInterrupted；改错故障 状态点与文字矛盾。
// INV-16 运行标识必须单行截断并保留完整悬停标题：守住位置 title 与 truncate；改错故障 长标识撑破行。
// INV-17 时间与 token 都走统一格式化：守住位置 两个格式化函数；改错故障 数字精度与单位不一致。
// INV-18 行键必须使用运行标识：守住位置 key；改错故障 列表更新时行状态错位。
//
// 模块职责：把 ListWorkflowRuns 的结构化结果渲染为可折叠的聊天卡，并逐行展示运行状态。
// 状态所有权：运行数据来自工具结果；折叠与展开状态由通用 ToolLayout 持有。
// 阅读顺序：先看展示数据与文案派生，再读内容与展开条件，最后看逐行列表。
import { History } from "lucide-react";
import { useMemo } from "react";
import type { ToolCallListWorkflowRunsDisplay } from "@zcode/shared/zcode-protocol-v4";
import {
  RUN_STATUS_DOT,
  RUN_STATUS_TEXT,
  readWorkflowRunStopReason,
  workflowRunStopReasonMessageId,
} from "@/components/workflow-graph/run-status-presentation.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatWorkflowTimestamp,
  formatWorkflowTokenCount,
} from "@/lib/workflowObservationFormat.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

// LIST_WORKFLOW_RUNS_TOOL_ICON 在模块加载时创建一次 <History className="size-4 shrink-0 text-foreground-subtle" />：图标尺寸与颜色由工具卡统一样式决定，History 表达的是运行记录而非实时执行状态。
const LIST_WORKFLOW_RUNS_TOOL_ICON = <History className="size-4 shrink-0 text-foreground-subtle" />;

/**
 * ListWorkflowRuns 的聊天卡。
 *
 * 折叠行：kindLabel + 计数（单复数独立 key 的既有惯例）。展开：行式列表
 * ［状态点词 | label mono | 短时间 | tokens］，本会话 run 加边框小签，possiblyInterrupted
 * 行尾给警示标注——「可能已中断」是读面标注不是状态改写，卡片上同样只标注。
 */
// 只接受 list_workflow_runs 类型的结构化结果。
// ListWorkflowRunsToolCallBlock 在渲染前解析 kindLabel/emptyLabel/countLabel，primaryText 经 useMemo 依赖 [countLabel, emptyLabel, runCount] 保持引用稳定；renderContent 同时支持 listDisplay.runs 与 toolCall.output 纯文本回退，hasDetails 要求二者至少一种有内容才允许展开。
export function ListWorkflowRunsToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;

  const display = readToolResultDisplay(toolCall.raw);
  const listDisplay = display?.kind === "list_workflow_runs" ? display : undefined;

  const kindLabel = intl.formatMessage({
    id: context.isRunning
      ? "chat.toolCall.workflow.listRuns.listing"
      : "chat.toolCall.workflow.listRuns.listed",
  });
  const emptyLabel = intl.formatMessage({ id: "chat.toolCall.workflow.listRuns.empty" });
  const runCount = listDisplay?.runs.length ?? 0;
  const countLabel = intl.formatMessage(
    {
      id:
        runCount === 1
          ? "chat.toolCall.workflow.listRuns.countOne"
          : "chat.toolCall.workflow.listRuns.count",
    },
    { count: runCount },
  );

  // primaryText 用 runCount === 0 ? emptyLabel : countLabel 决定文案，useMemo 依赖只列 [countLabel, emptyLabel, runCount]：多放 intl 等对象会让每次渲染都重建 span。
  const primaryText = useMemo(
    () => (
      <span className="truncate text-foreground-subtlest">
        {runCount === 0 ? emptyLabel : countLabel}
      </span>
    ),
    [countLabel, emptyLabel, runCount],
  );

  const rows = useMemo(() => {
    if (listDisplay === undefined) return null;
    return <ListWorkflowRunsBody runs={listDisplay.runs} />;
  }, [listDisplay]);

  const fallbackText =
    listDisplay === undefined && typeof toolCall.output === "string"
      ? toolCall.output.trim()
      : undefined;

  // renderContent 优先 listDisplay !== undefined 分支渲染 rows 并在 truncated 时追加一行说明；否则用 fallbackText，为空返回 undefined 不挂内容；useMemo 依赖 [fallbackText, intl, listDisplay, rows] 保证函数在任一变化时重建。
  const renderContent = useMemo(() => {
    if (listDisplay !== undefined) {
      return () => (
        <div className="mb-2 space-y-2">
          {rows}
          {listDisplay.truncated ? (
            <p className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "chat.toolCall.workflow.listRuns.truncated" })}
            </p>
          ) : null}
        </div>
      );
    }
    if (fallbackText === undefined || fallbackText.length === 0) return undefined;
    return () => (
      <pre className="mb-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-panel px-4 py-3 font-mono text-ui-base text-foreground-subtle">
        {fallbackText}
      </pre>
    );
  }, [fallbackText, intl, listDisplay, rows]);

  // hasDetails 取 (listDisplay !== undefined && runCount > 0) || (fallbackText !== undefined && fallbackText.length > 0)：它同时控制 ToolLayout 的 canToggle 与 renderContent，空结果保持纯折叠行，不挂载空白内容区。
  const hasDetails =
    (listDisplay !== undefined && runCount > 0) ||
    (fallbackText !== undefined && fallbackText.length > 0);

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={LIST_WORKFLOW_RUNS_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasDetails && (context.canToggle ?? true)}
        forceOpen={hasDetails && (context.forceOpen ?? false)}
        kindLabel={context.kindLabelOverride ?? kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={toolCall.status === "failed" ? context.statusLabel : undefined}
        statusTooltip={context.errorText}
        showFailureStatus={toolCall.status === "failed"}
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

// ListWorkflowRunsBody 在 runs.length === 0 时渲染 chat.toolCall.workflow.listRuns.empty；每行 key 用 run.runId，状态点与状态词都由 run.status 枚举派生，本会话标记与 possiblyInterrupted 只做附加渲染，不改写状态。
function ListWorkflowRunsBody({ runs }: { runs: ToolCallListWorkflowRunsDisplay["runs"] }) {
  const { intl } = useZCodeIntl();
  const ownSessionLabel = intl.formatMessage({ id: "chat.toolCall.workflow.listRuns.ownSession" });
  const interruptedLabel = intl.formatMessage({
    id: "chat.toolCall.workflow.listRuns.interrupted",
  });

  if (runs.length === 0) {
    const emptyLabel = intl.formatMessage({ id: "chat.toolCall.workflow.listRuns.empty" });
    return <p className="text-ui-sm text-foreground-subtlest">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-1" data-workflow-run-list="true">
      {runs.map((run) => {
        const statusWord = intl.formatMessage({
          id: `chat.toolCall.workflow.run.status.${run.status}`,
        });
        const stopReason = readWorkflowRunStopReason(run);
        return (
          <div
            key={run.runId}
            className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5"
            data-workflow-run-row={run.runId}
            data-workflow-run-row-status={run.status}
          >
            <span className="flex shrink-0 items-center gap-1.5">
              <span
                aria-hidden="true"
                className={cn("size-1.5 rounded-full", RUN_STATUS_DOT[run.status])}
              />
              <span className={cn("text-ui-sm", RUN_STATUS_TEXT[run.status])}>{statusWord}</span>
              {stopReason ? (
                <span className="text-ui-xs text-foreground-subtlest">
                  {intl.formatMessage({ id: workflowRunStopReasonMessageId(stopReason) })}
                </span>
              ) : null}
            </span>
            <span
              className="min-w-0 flex-1 truncate font-mono text-ui-base text-foreground-subtle"
              title={run.runId}
            >
              {run.label}
            </span>
            {run.ownedByThisSession ? (
              <span className="shrink-0 rounded-xs border border-border px-1.5 py-0.5 text-ui-xs leading-none text-foreground-subtlest">
                {ownSessionLabel}
              </span>
            ) : null}
            {run.possiblyInterrupted === true ? (
              <span className="shrink-0 text-ui-xs text-warning">{interruptedLabel}</span>
            ) : null}
            <span className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
              {formatWorkflowTimestamp(run.updatedAt)}
            </span>
            <span className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
              {formatWorkflowTokenCount(run.spentTokens)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
