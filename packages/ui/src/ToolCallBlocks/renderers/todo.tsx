// INV-01 计划优先取输出：守住位置 输出提取函数；改错故障 已完成计划回退成空。
// INV-02 输出缺失再取输入：守住位置 空值合并；改错故障 运行中计划不可见。
// INV-03 三态样式集中映射：守住位置 状态样式表；改错故障 各状态样式漂移。
// INV-04 当前项优先进行中：守住位置 第一层查找；改错故障 高亮错误任务。
// INV-05 无进行中取首个未完成：守住位置 第二层查找；改错故障 当前项恒为首条。
// INV-06 全完成取最后一项：守住位置 末尾兜底；改错故障 完成后标题为空。
// INV-07 标题逐级回退：守住位置 步骤与工具标题；改错故障 卡片标题缺失。
// INV-08 进度显示完成比总数：守住位置 模板拼接；改错故障 副标题只剩数字。
// INV-09 无计划回退状态文案：守住位置 三元回退；改错故障 副标题为空。
// INV-10 主副文本节点缓存：守住位置 两个缓存钩子；改错故障 每次渲染重建节点。
// INV-11 有计划渲染清单：守住位置 计划分支；改错故障 有数据仍显示原始内容。
// INV-12 无计划回退通用正文：守住位置 片段分支；改错故障 空计划丢失工具输出。
// INV-13 快照提示两处一致：守住位置 两个分支的提示组件；改错故障 提示不同步。
// INV-14 加载全字段按工具标识：守住位置 回调包裹；改错故障 加载到其它工具字段。
// INV-15 失败态才传状态文案：守住位置 失败判断；改错故障 成功卡片显示错误文案。
// INV-16 失败态才传错误提示：守住位置 三元透传；改错故障 悬浮出现无关错误。
// INV-17 进行中状态单独传入：守住位置 运行标志；改错故障 运行指示不显示。
// INV-18 本组件不改写计划数据：守住位置 只读渲染；改错故障 渲染层回写任务状态。
//
// 模块职责：待办工具调用的折叠卡，展示计划进度与逐步状态。
// 状态所有权：无状态；计划来自工具输入输出，展示状态由上下文传入。
// 阅读顺序：先看计划提取与当前项推导，再读文本缓存，最后看两个分支。
import { ArrowRightIcon, CircleCheckIcon, CircleIcon, ListTodoIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { extractPlanStepsFromToolInput, extractPlanStepsFromToolOutput } from "@zcode/shared";
import type { ZCodePlanStep } from "@zcode/shared";
import { ToolCallBody } from "@/ToolCallBlocks/ToolCallBody.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const TODO_TOOL_ICON = <ListTodoIcon className="size-4 shrink-0 text-foreground-subtle" />;

const todoTextClasses: Record<ZCodePlanStep["status"], string> = {
  pending: "text-foreground-subtle",
  in_progress: "text-foreground",
  completed: "text-foreground-subtlest line-through",
};

// readTodoPlan 先尝试 extractPlanStepsFromToolOutput，从工具输出提取。
// 输出为空时再读 toolCall.input，交给 extractPlanStepsFromToolInput。
// 输出与输入两条路径都可能为空，调用方要处理 null。
// readTodoPlan 不改写 toolCall，只由 title、kind 与 input 读取计划。
// 返回原始 ZCodePlanStep 数组，顺序与工具给出的一致。
// 读取只依赖 title 与 input，不碰其他字段。
function readTodoPlan(context: ToolCallBlockRenderContext): ZCodePlanStep[] | null {
  const { toolCall } = context.toolCallNode;
  return (
    extractPlanStepsFromToolOutput({
      title: toolCall.title,
      kind: toolCall.kind,
      output: toolCall.output,
    }) ??
    extractPlanStepsFromToolInput({
      title: toolCall.title,
      kind: toolCall.kind,
      input: toolCall.input,
    })
  );
}

function TodoStatusIcon({ status }: { status: ZCodePlanStep["status"] }) {
  if (status === "completed") {
    return <CircleCheckIcon className="size-3.5 shrink-0 text-success" />;
  }
  if (status === "in_progress") {
    // 工具输出里的 todo running 状态会长时间留在页面上；
    // 用静态箭头表达当前项，避免和加载动画语义混在一起。
    return <ArrowRightIcon className="size-3.5 shrink-0 text-foreground" />;
  }
  return <CircleIcon className="size-3.5 shrink-0 text-foreground-subtlest" />;
}

// 计划缺失时 completedCount 计为 0。
// activeStep 由 in_progress、未完成、末项三级优先级选取。
// activeStep 标题缺失时回退到 todo.panel.currentTask 文案。
// 有计划时副标题优先显示 completedCount / plan.length 进度。
// context.statusLabel 的失败状态单独透传，不并入进度。
// 卡片布局交由 ToolLayout 通用外壳，本组件只填内容。
export function TodoToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const plan = readTodoPlan(context);
  const completedCount = plan?.filter((step) => step.status === "completed").length ?? 0;
  const activeStep =
    plan?.find((step) => step.status === "in_progress") ??
    plan?.find((step) => step.status !== "completed") ??
    plan?.at(-1);
  const kindLabel = intl.formatMessage({ id: "todo.panel.title" });
  const primaryText =
    activeStep?.title ?? toolCall.title ?? intl.formatMessage({ id: "todo.panel.currentTask" });
  const secondaryText = plan ? `${completedCount}/${plan.length}` : context.statusLabel;
  // primaryTextNode 只依赖 primaryText，其他字段变化不触发重算。
  // 截断交给 min-w-0 truncate 样式类，不在 JS 里切字符串。
  // 图标由 TodoStatusIcon 单独渲染，不在此处拼接。
  // useMemo 复用节点避免重排，依赖数组只放文本。
  // 副标题节点使用独立 useMemo 缓存，与主文本分开。
  const primaryTextNode = useMemo(
    () => <span className="min-w-0 truncate text-foreground-subtlest">{primaryText}</span>,
    [primaryText],
  );
  const secondaryTextNode = useMemo(
    () => (
      <span className="shrink-0 font-mono text-ui-base text-foreground-subtlest">
        {secondaryText}
      </span>
    ),
    [secondaryText],
  );
  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  // 有计划时 renderContent 渲染步骤清单。
  // 每个 step 带 TodoStatusIcon 状态图标。
  // 样式由 todoTextClasses[step.status] 集中取。
  // 无计划时回退到 ToolLayout 的通用正文。
  // 两个分支都带 context 快照提示。
  const renderContent = useCallback(
    () =>
      plan ? (
        <div className="space-y-1 rounded-xl bg-surface px-3 py-2">
          {plan.map((step) => (
            <div key={step.id} className="flex min-w-0 items-center gap-2 py-1">
              <TodoStatusIcon status={step.status} />
              <span
                className={cn("min-w-0 break-words text-ui-base", todoTextClasses[step.status])}
              >
                {step.title}
              </span>
            </div>
          ))}
          <ToolSnapshotFieldNotice
            refs={toolCall.snapshotRefs ?? []}
            onLoadFullToolCallFields={
              handleLoadFullToolCallFields
                ? () => handleLoadFullToolCallFields(toolCall.toolId)
                : undefined
            }
          />
        </div>
      ) : (
        <>
          <ToolCallBody
            childToolList={context.childToolList}
            displayModel={context.displayModel}
            toolCall={toolCall}
            workspacePath={context.workspacePath}
            theme={context.theme}
            codePreviewSettings={context.codePreviewSettings}
            onOpenCodeViewer={context.onOpenCodeViewer}
            onOpenFileLink={context.onOpenFileLink}
            onOpenBrowserUrl={context.onOpenBrowserUrl}
          />
          <ToolSnapshotFieldNotice
            refs={toolCall.snapshotRefs ?? []}
            onLoadFullToolCallFields={
              handleLoadFullToolCallFields
                ? () => handleLoadFullToolCallFields(toolCall.toolId)
                : undefined
            }
          />
        </>
      ),
    [
      context.childToolList,
      context.codePreviewSettings,
      context.displayModel,
      context.onOpenBrowserUrl,
      context.onOpenCodeViewer,
      context.onOpenFileLink,
      context.theme,
      context.workspacePath,
      handleLoadFullToolCallFields,
      plan,
      toolCall,
    ],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={TODO_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={context.canToggle ?? true}
      forceOpen={context.forceOpen ?? false}
      kindLabel={kindLabel}
      sourceLabel={context.sourceLabel}
      primaryText={primaryTextNode}
      secondaryText={secondaryTextNode}
      statusLabel={toolCall.status === "failed" ? context.statusLabel : undefined}
      statusTooltip={toolCall.status === "failed" ? context.errorText : undefined}
      showFailureStatus={toolCall.status === "failed"}
      isRunning={context.isRunning}
      title={toolCall.title}
      renderContent={renderContent}
    />
  );
}
