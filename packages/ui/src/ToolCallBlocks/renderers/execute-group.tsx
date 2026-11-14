// INV-01 活跃集合集中定义：守住位置 唯一常量；改错故障 流式与待审批被判为已结束。
// INV-02 最近活跃子项优先：守住位置 查找顺序；改错故障 运行态展示已结束的子命令。
// INV-03 无活跃时回退末项：守住位置 空值兜底；改错故障 运行中不显示任何命令。
// INV-04 Office 模式不取命令：守住位置 布尔判断；改错故障 文档模式露出终端命令。
// INV-05 概述按状态计数：守住位置 过滤长度；改错故障 失败与停止数不准。
// INV-06 单条与多条走不同消息键：守住位置 三元选择；改错故障 英文单复数错乱。
// INV-07 统计片段按需拼接：守住位置 条件追加；改错故障 出现零失败提示。
// INV-08 运行态主文案来自本地化：守住位置 消息键；改错故障 界面出现硬编码。
// INV-09 主文案按运行态切换：守住位置 三元表达式；改错故障 结束后仍显示运行中。
// INV-10 次文案仅运行时给出：守住位置 条件属性；改错故障 完成态残留最后一条命令。
// INV-11 展开态清空次文案：守住位置 显式空值；改错故障 命令数量后粘连当前命令。
// INV-12 摘要动画随运行态启停：守住位置 布尔属性；改错故障 结束后仍在滚动。
// INV-13 摘要键包含命令与状态：守住位置 模板拼接；改错故障 换命令不触发动画。
// INV-14 子项渲染保留父级回调：守住位置 属性透传；改错故障 子项无法打开文件或浏览器。
// INV-15 子项不重复显示图标：守住位置 图标开关；改错故障 树状结构出现双图标。
// INV-16 子项以标识为键：守住位置 键属性；改错故障 列表重排导致状态串位。
// INV-17 折叠能力默认开启：守住位置 兜底表达式；改错故障 点击标题无响应。
// INV-18 标题区分折叠与展开：守住位置 两个标题属性；改错故障 展开后标题信息缺失。
//
// 模块职责：把一组串行命令渲染为可折叠的单个工具块。
// 状态所有权：无状态；运行态、子项与回调全部来自渲染上下文。
// 阅读顺序：先看活跃集合与统计，再看运行态文案，最后看子项渲染与布局属性。
import { SquareTerminalIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { getExecuteSecondaryText } from "@/ToolCallBlocks/renderers/execute.js";

const EXECUTE_GROUP_ICON = (
  <SquareTerminalIcon className="size-4 shrink-0 text-foreground-subtle" />
);

// V4 row 进入共享 renderer 前会把 inputStreaming/pendingApproval 统一适配为 pending。
// 活跃状态统一为两种。
// V4 适配层把流式与待审批压成 pending。
// 集合用于寻找最近的活跃子项。
// ACTIVE_STATUSES 是模块级常量，不随渲染重建。
const ACTIVE_STATUSES = new Set(["pending", "in_progress"]);

// formatCompletedSummary 用两个消息键拼命令数，failed 与 stopped 各自追加。
// 单条走 command.one，多条走 command.other。
// stoppedCount 与 failedCount 各自独立追加，可以同时出现。
function formatCompletedSummary(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  childStatuses: string[],
) {
  const parts = [
    intl.formatMessage(
      {
        id:
          childStatuses.length === 1
            ? "chat.toolCall.executeGroup.command.one"
            : "chat.toolCall.executeGroup.command.other",
      },
      { count: childStatuses.length },
    ),
  ];
  const failedCount = childStatuses.filter((status) => status === "failed").length;
  const stoppedCount = childStatuses.filter((status) => status === "stopped").length;
  if (failedCount > 0) {
    parts.push(
      intl.formatMessage({ id: "chat.toolCall.executeGroup.failed" }, { count: failedCount }),
    );
  }
  if (stoppedCount > 0) {
    parts.push(
      intl.formatMessage({ id: "chat.toolCall.executeGroup.stopped" }, { count: stoppedCount }),
    );
  }
  return parts.join(", ");
}

// 子项渲染器取自 context.nestedToolRenderer。
// 最近活跃子项优先于末项。
// Office 模式不展示命令细节。
export function ExecuteGroupToolCallBlock(context: ToolCallBlockRenderContext) {
  const ToolCallBlock = context.nestedToolRenderer;
  const { intl } = useZCodeIntl();
  const { toolCallNode, isRunning, statusLabel, isOfficeMode = false } = context;
  const { toolCall, childToolCalls } = toolCallNode;
  const latestActiveChild = childToolCalls.findLast((child) =>
    ACTIVE_STATUSES.has(child.toolCall.status),
  );
  const latestChild = latestActiveChild ?? childToolCalls.at(-1);
  const latestCommand =
    !isOfficeMode && latestChild ? getExecuteSecondaryText(latestChild.toolCall.input) : undefined;
  const runningActionLabel = latestCommand
    ? intl.formatMessage({ id: "chat.toolCall.execute.running" })
    : undefined;
  const runningPrimaryText = useMemo(
    () =>
      runningActionLabel ? (
        <span className="shrink-0 text-foreground-subtle">{runningActionLabel}</span>
      ) : null,
    [runningActionLabel],
  );
  const runningSecondaryText = useMemo(
    () =>
      latestCommand ? (
        // Tailwind v4 preflight 会给 code 默认 mono 字体，
        // 不显式指定时运行态命令会和 execute/explore 收起态的 sans 约定不一致。
        <code className="min-w-0 truncate font-sans">{latestCommand}</code>
      ) : undefined,
    [latestCommand],
  );
  const completedSummary = formatCompletedSummary(
    intl,
    childToolCalls.map((child) => child.toolCall.status),
  );
  // 子项以 child.toolCall.toolId 作为 React key。
  // ml-2 与左侧 border-l 表达子项对父命令的从属关系。
  // onOpenCodeViewer 等回调原样透传，子项保持父级能力。
  const renderContent = useCallback(
    () => (
      <div className="ml-2 space-y-2 border-border border-l pl-3.5">
        {childToolCalls.map((child) => (
          <ToolCallBlock
            key={child.toolCall.toolId}
            toolCallNode={child}
            workspacePath={context.workspacePath}
            showIcon={false}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
            onOpenAutomationsMain={context.onOpenAutomationsMain}
            onLoadFullToolCallFields={context.onLoadFullToolCallFields}
          />
        ))}
      </div>
    ),
    [
      childToolCalls,
      context.onLoadFullToolCallFields,
      context.onOpenAutomationsMain,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.workspacePath,
    ],
  );

  // 只在 Execute 阶段运行时滚动新增 command；阶段结束必须立即清空旧队列并显示最终统计。
  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={EXECUTE_GROUP_ICON}
      canToggle={!isOfficeMode && (context.canToggle ?? true)}
      forceOpen={!isOfficeMode && (context.forceOpen ?? false)}
      kindLabel={intl.formatMessage({ id: "chat.toolCall.executeGroup.label" })}
      expandedKindLabel={intl.formatMessage({
        id: "chat.toolCall.executeGroup.label",
      })}
      primaryText={isRunning && runningActionLabel ? runningPrimaryText : completedSummary}
      secondaryText={isRunning ? runningSecondaryText : undefined}
      summaryContentSeparator="·"
      expandedPrimaryText={completedSummary}
      // ToolLayout 默认会在展开态沿用 secondaryText，导致命令数量后残留当前命令。
      // 父组展开后由子 tool summary 表达当前命令，因此这里必须显式清空。
      expandedSecondaryText={null}
      animateSummaryContent={isRunning}
      disableSummaryContentAnimation={context.disableSummaryContentAnimation}
      summaryContentKey={
        isRunning && latestChild
          ? `execute:${toolCall.toolId}:${latestChild.toolCall.toolId}:${runningActionLabel ?? "running"}:${latestCommand ?? "command"}`
          : `execute:${toolCall.toolId}:done:${completedSummary}`
      }
      statusLabel={statusLabel}
      isRunning={isRunning}
      title={isOfficeMode ? undefined : isRunning && latestCommand ? latestCommand : toolCall.title}
      expandedTitle={toolCall.title}
      renderContent={renderContent}
    />
  );
}
