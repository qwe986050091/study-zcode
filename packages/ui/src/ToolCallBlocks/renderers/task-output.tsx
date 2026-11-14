// INV-01 对象与 JSON 字符串都能解析：守住位置 toRecord；改错故障 输入字段全部丢失。
// INV-02 数组与标量视为无效：守住位置 类型判断；改错故障 数组被当成记录。
// INV-03 解析失败返回空：守住位置 catch；改错故障 非法输入导致整块崩溃。
// INV-04 任务标识只认非空串：守住位置 readTaskId；改错故障 数字 id 被强转。
// INV-05 失败状态两种：守住位置 failed 与 lost；改错故障 丢失任务显示成功。
// INV-06 停止状态三种：守住位置 三个词；改错故障 取消被当成完成。
// INV-07 拒绝与停止不算失败：守住位置 showFailureStatus；改错故障 用户主动中止被染红。
// INV-08 输出存在才渲染内容：守住位置 hasOutput；改错故障 空内容仍占位。
// INV-09 状态标签有优先级：守住位置 分支顺序；改错故障 具体原因被通用状态覆盖。
// INV-10 未知任务态回退原文：守住位置 末段判断；改错故障 标签为空。
// INV-11 成功读取需显式检索状态：守住位置 retrievalStatus；改错故障 未读取也显示已获取。
// INV-12 类别标签随运行切换：守住位置 kindLabel；改错故障 运行中仍显示类型名。
// INV-13 主文本优先任务标识：守住位置 primaryText；改错故障 标题掩盖真实任务。
// INV-14 回调依赖完整：守住位置 依赖数组；改错故障 截断状态陈旧。
// INV-15 快照引用缺省为空：守住位置 空数组兜底；改错故障 访问 undefined 报错。
// INV-16 加载完整字段按需回调：守住位置 可选调用；改错故障 无回调时按钮可点。
// INV-17 失败提示仅传错误文本：守住位置 statusTooltip；改错故障 成功状态也带提示。
// INV-18 图标常量共享：守住位置 模块常量；改错故障 每次渲染新建元素。
//
// 模块职责：渲染 TaskOutput 工具调用块，汇总任务标识、状态与输出内容。
// 状态所有权：展示数据全部来自工具调用与结果；组件无本地状态。
// 阅读顺序：先看记录归一与状态判定，再看标签优先级，最后看内容渲染。
import { FileOutputIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { readToolResultDisplay } from "@/ToolCallBlocks/toolResultDisplay.js";

const TASK_OUTPUT_TOOL_ICON = <FileOutputIcon className="size-4 shrink-0 text-foreground-subtle" />;

// 对象直接透传。
// 字符串按 JSON 解析。
// 数组与标量视为无效。
// 解析失败返回空。
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

function readTaskId(input: unknown): string | undefined {
  const taskId = toRecord(input)?.task_id;
  return typeof taskId === "string" && taskId.trim().length > 0 ? taskId : undefined;
}

function isFailedTaskStatus(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return normalized === "failed" || normalized === "lost";
}

function isStoppedTaskStatus(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return normalized === "cancelled" || normalized === "killed" || normalized === "stopped";
}

// 图标与布局交给 ToolLayout 通用块。
// 状态标签由 outcomeLabel 的多重判定得出。
// hasOutput 为假时不传 renderContent，内容区随之折叠。
// display 为空时由 ToolSnapshotFieldNotice 走通用提示。
export function TaskOutputToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const display = readToolResultDisplay(toolCall.raw);
  const taskOutputDisplay = display?.kind === "task_output" ? display : undefined;
  const taskId = readTaskId(toolCall.input);
  const taskStatus = taskOutputDisplay?.taskStatus;
  const normalizedTaskStatus = taskStatus?.trim().toLowerCase();
  const isDenied = toolCall.status === "denied";
  const isStopped = toolCall.status === "stopped";
  const isExecutionFailed = toolCall.status === "failed";
  const isTaskFailed = isFailedTaskStatus(taskStatus);
  // isDenied 与 isStopped 都被排除在 showFailureStatus 之外。
  // isTaskFailed 与 isExecutionFailed 同样算失败。
  // showFailureStatus 驱动 ToolLayout 的警示样式。
  const showFailureStatus = !isDenied && !isStopped && (isExecutionFailed || isTaskFailed);
  const output = taskOutputDisplay?.output;
  const hasOutput = output !== undefined;

  // else-if 链的顺序即优先级。
  // 先判 toolCall.status，再判 retrievalStatus 与 taskStatus。
  // else-if 首个命中分支赋值后即跳出整条链。
  let outcomeLabel: string | undefined;
  if (isExecutionFailed) {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.status.failed" });
  } else if (isDenied) {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.status.denied" });
  } else if (isStopped) {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.status.stopped" });
  } else if (taskOutputDisplay?.retrievalStatus === "not_ready") {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.taskOutput.running" });
  } else if (taskOutputDisplay?.retrievalStatus === "timeout") {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.taskOutput.timeout" });
  } else if (isTaskFailed) {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.taskOutput.taskFailed" });
  } else if (isStoppedTaskStatus(taskStatus)) {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.taskOutput.taskStopped" });
  } else if (normalizedTaskStatus === "pending" || normalizedTaskStatus === "running") {
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.taskOutput.running" });
  } else if (normalizedTaskStatus && normalizedTaskStatus !== "completed") {
    outcomeLabel = taskStatus ?? normalizedTaskStatus;
  } else if (taskOutputDisplay?.retrievalStatus === "success") {
    // 类别标签只能说明这是 TaskOutput，不能替代 display 已确认的成功读取结果。
    outcomeLabel = intl.formatMessage({ id: "chat.toolCall.taskOutput.retrieved" });
  }
  const kindLabel = intl.formatMessage({
    id: context.isRunning ? "chat.toolCall.taskOutput.fetching" : "chat.toolCall.kind.taskOutput",
  });

  const primaryText = useMemo(
    () => (
      <code className="min-w-0 truncate font-mono">{taskId ?? toolCall.title ?? "TaskOutput"}</code>
    ),
    [taskId, toolCall.title],
  );
  // hasOutput 为真时才把 renderContent 交给 ToolLayout。
  // renderContent 用 <pre> 原样展示 output。
  // truncated 为真时在末尾追加截断提示。
  const renderContent = useCallback(
    () => (
      <div className="rounded-lg border border-border bg-panel px-4 py-3">
        <pre className="max-h-25 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-base text-foreground-subtle">
          {output}
        </pre>
        {taskOutputDisplay?.truncated === true ? (
          <p className="mt-3 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.taskOutput.truncated" })}
          </p>
        ) : null}
      </div>
    ),
    [intl, output, taskOutputDisplay?.truncated],
  );

  return (
    <>
      <ToolLayout
        toolId={toolCall.toolId}
        icon={TASK_OUTPUT_TOOL_ICON}
        showIcon={context.showIcon !== false}
        canToggle={hasOutput && (context.canToggle ?? true)}
        forceOpen={hasOutput && (context.forceOpen ?? false)}
        kindLabel={kindLabel}
        sourceLabel={context.sourceLabel}
        primaryText={primaryText}
        statusLabel={outcomeLabel}
        showStatusLabel={outcomeLabel != null}
        statusTooltip={isExecutionFailed ? context.errorText : undefined}
        showFailureStatus={showFailureStatus}
        isRunning={context.isRunning}
        title={toolCall.title}
        renderContent={hasOutput ? renderContent : undefined}
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
