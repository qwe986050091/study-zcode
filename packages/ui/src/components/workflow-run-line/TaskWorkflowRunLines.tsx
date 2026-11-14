// INV-01 没有可变运行行时整块返回空：守住位置 选择结果为空判断；改错故障 任务行下多出一条空行。
// INV-02 实时运行显示当前阶段，结束运行只显示中性词：守住位置 runLineText 分支；改错故障 结束的运行仍显示「运行中」。
// INV-03 等待补全时优先显示留白提示：守住位置 waitingHole 判断；改错故障 用户看到阶段名却不知道在等输入。
// INV-04 隐式轨道回落到通用工作流文案：守住位置 rail.implicit 分支；改错故障 空阶段渲染成空字符串。
// INV-05 错误态在词后追加阶段名：守住位置 错误分支；改错故障 无法从行文本判断失败发生在哪一站。
// INV-06 结束原因文案必须经消息标识映射：守住位置 原因分支；改错故障 直接把内部枚举值展示给用户。
// INV-07 并行阶段优先于单个当前阶段：守住位置 提示行阶段拼接；改错故障 并行时只显示其中一站。
// INV-08 仅在实时且有代理在跑时展示代理数：守住位置 代理数判断；改错故障 结束的运行仍显示「N 个代理工作中」。
// INV-09 提示行段落缺失时省略而不是留空占位：守住位置 段落数组与连接；改错故障 出现连续两个分隔符。
// INV-10 打开会话即确认其所有已结束运行：守住位置 确认副作用；改错故障 历史运行行永远折叠不掉。
// INV-11 确认键由已结束运行标识拼接，稳定且去重：守住位置 标识收集函数；改错故障 每次渲染都触发一次确认写。
// INV-12 确认副作用仅在会话活跃且确有已结束运行时执行：守住位置 effect 首行判断；改错故障 后台会话被误标已读。
// INV-13 行是否可交互取决于打开能力与会话地址同时存在：守住位置 交互判定；改错故障 手机首页出现点了没反应的按钮。
// INV-14 可交互行的点击必须阻止冒泡与默认行为：守住位置 点击处理前两行；改错故障 一次点击同时选中会话并打开面板。
// INV-15 不可交互时用普通元素而不是禁用按钮：守住位置 行元素二选一；改错故障 读屏把静态行读成不可用控件。
// INV-16 每行必须带运行标识与状态的测试属性：守住位置 行属性对象；改错故障 端到端用例无法定位具体运行。
// INV-17 超出可显示条数时展示折叠计数：守住位置 溢出分支；改错故障 运行行无限增长挤占任务行。
// INV-18 紧凑密度只改高度与字号，不改结构：守住位置 紧凑类名；改错故障 手机远控行与桌面行结构分叉。
//
// 模块职责：渲染任务行下方的工作流运行摘要，并提供跳转到运行详情的交互。
// 状态所有权：已确认运行记录存放于确认存储；本组件只读取并触发确认。
// 阅读顺序：先看三个文案函数，再读组件内的确认副作用与选择计算，最后看单行渲染与溢出提示。
// 侧栏任务行标题下的工作流运行行：
// Workflow 图标 + 迷你轨道灯 + 当前 phase 名。一眼看懂「这个会话在跑工作流、跑到哪一站」，
// 别的都不画：没有光晕、没有行进虚线、没有问题 chip（升级问答由主代理作答，不是用户）、
// 没有子代理数、没有箭头——那些进 hover tooltip。结束的 run 只剩一个中性词，颜色只留给灯。
import { useEffect, useMemo, type MouseEvent } from "react";
import { Workflow } from "lucide-react";
import type {
  SessionWorkflowActivity,
  SessionWorkflowRunSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { isSessionWorkflowRunLive } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  readWorkflowRunStopReason,
  workflowRunStopReasonMessageId,
} from "@/components/workflow-graph/run-status-presentation.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { getWorkflowRunAckStore, useWorkflowRunAcknowledged } from "@/lib/workflowRunAckStore.js";
import {
  foldWorkflowRunRail,
  selectWorkflowRunLines,
  settledWorkflowRunIds,
  workflowRunParallelPhaseLabel,
  type WorkflowRunRail,
} from "@/lib/workflowRunLine.js";
import { WorkflowRunRail as RunRail } from "@/components/workflow-run-line/WorkflowRunRail.js";
import { useWorkflowRunOpen } from "@/v4/workflowRunOpenContext.js";

export interface TaskWorkflowRunLinesIntl {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
}

interface TaskWorkflowRunLinesProps {
  activity: SessionWorkflowActivity | undefined;
  /** 会话是否正被打开：为真时确认它所有已结束的 run（结束的行随即折叠）。 */
  isActive: boolean;
  intl: TaskWorkflowRunLinesIntl;
  /** 点击打开 run pane 所需的会话地址；缺席（手机首页）时运行行不是按钮。 */
  session?: { workspacePath: string; workspaceIdentity?: string; sessionId: string };
  /** compact = 手机远控行（24px、更小字号）。 */
  density?: "default" | "compact";
  className?: string;
}

const SEPARATOR = " · ";

// runStatusWord 只查 `chat.toolCall.workflow.run.status.<status>`：新增状态补词典即可；函数不兜底，调用方保证 status 来自协议枚举。
function runStatusWord(run: SessionWorkflowRunSummary, intl: TaskWorkflowRunLinesIntl): string {
  return intl.formatMessage({ id: `chat.toolCall.workflow.run.status.${run.status}` });
}

/** 行上的词：在跑 → 当前 phase 名（无阶段词汇表 → 「Workflow」）；结束 → 中性词（+ phase / 原因）。 */
// 实时分支依次回落：waitingHole 文案 → rail.implicit 的「Workflow」→ currentPhase → 状态词；留白句答的是「在等什么」，优先于阶段名。
// 结束分支先取中性词；errored 且 currentPhase 存在时追加阶段名，其余原因经 workflowRunStopReasonMessageId 映射，不暴露内部枚举。
function runLineText(
  run: SessionWorkflowRunSummary,
  rail: WorkflowRunRail,
  intl: TaskWorkflowRunLinesIntl,
): string {
  if (isSessionWorkflowRunLive(run.status)) {
    // 停在留白上：「决定分组 · 等待补全」（docs/dynamic-workflow/presentation.md「Holes on the timeline」）。
    if (run.waitingHole !== undefined) {
      return intl.formatMessage(
        { id: "taskList.workflowRun.holeWaiting" },
        { name: run.waitingHole },
      );
    }
    if (rail.implicit) {
      return intl.formatMessage({ id: "chat.toolCall.workflow.graph.phase.workflow" });
    }
    return run.currentPhase ?? runStatusWord(run, intl);
  }
  const word = runStatusWord(run, intl);
  if (run.status === "errored" && run.currentPhase !== undefined) {
    return `${word}${SEPARATOR}${run.currentPhase}`;
  }
  const reason = readWorkflowRunStopReason(run);
  if (reason !== undefined) {
    return `${word}${SEPARATOR}${intl.formatMessage({ id: workflowRunStopReasonMessageId(reason) })}`;
  }
  return word;
}

// runName 取 run.name，缺省回落到「Workflow」；只用于提示标题与无障碍标签而不进入行文本，也不在此截断。
function runName(run: SessionWorkflowRunSummary, intl: TaskWorkflowRunLinesIntl): string {
  return run.name ?? intl.formatMessage({ id: "chat.toolCall.workflow.graph.phase.workflow" });
}

/** tooltip 第二行：`{phase} · {n agents working} · {elapsed}`，缺的段落省略。 */
// 阶段段：并行时列出 workflowRunParallelPhaseLabel 的全部站，否则用 currentPhase。
// 代理数只在实时运行且 agentsWorking > 0 时追加，startedAt 存在则末尾补相对时间；parts 为空返回 undefined。
function runTooltipDescription(
  run: SessionWorkflowRunSummary,
  intl: TaskWorkflowRunLinesIntl,
): string | undefined {
  const parts: string[] = [];
  // 并行时「当前阶段」不再是一个站：同时在跑的几站并排列出，谁都不比谁更当前。
  const parallel = workflowRunParallelPhaseLabel(run.phases);
  if (parallel !== undefined) parts.push(parallel);
  else if (run.currentPhase !== undefined) parts.push(run.currentPhase);
  if (isSessionWorkflowRunLive(run.status) && run.agentsWorking > 0) {
    parts.push(
      intl.formatMessage(
        { id: "chat.toolCall.workflow.card.agentsWorking" },
        { count: String(run.agentsWorking) },
      ),
    );
  }
  if (run.startedAt !== undefined) parts.push(formatTaskRelativeTime(run.startedAt, intl));
  return parts.length === 0 ? undefined : parts.join(SEPARATOR);
}

// 入参包含活动、是否活跃、国际化函数与可选会话地址。
// 没有 session 时整块只读、不给跳转；density 只影响高度与字号（默认 "default"），className 由调用方注入以便在任务行内对齐。
export function TaskWorkflowRunLines({
  activity,
  isActive,
  intl,
  session,
  density = "default",
  className,
}: TaskWorkflowRunLinesProps) {
  const isAcknowledged = useWorkflowRunAcknowledged();
  const openRun = useWorkflowRunOpen();
  const settledKey = settledWorkflowRunIds(activity).join(" ");
  // 打开会话 = 确认它此刻所有已结束的 run；会话保持打开时 run 结束也立即确认（在读者眼前折叠）。
  useEffect(() => {
    if (!isActive || settledKey.length === 0) return;
    getWorkflowRunAckStore().acknowledge(settledKey.split(" "));
  }, [isActive, settledKey]);
  // selection 由 selectWorkflowRunLines(activity, isAcknowledged) 算出：未确认的已结束 run 仍留在行上，渲染阶段不再过滤。
  const selection = useMemo(
    () => selectWorkflowRunLines(activity, isAcknowledged),
    [activity, isAcknowledged],
  );
  if (selection.lines.length === 0) return null;
  // interactive 要求 openRun 与 session 同时存在；缺一退化为静态行，同一个布尔值决定类名与元素类型。
  const interactive = openRun !== null && session !== undefined;
  const compact = density === "compact";

  return (
    <div
      data-workflow-run-lines="true"
      className={cn("flex min-w-0 max-w-full flex-col items-start", className)}
    >
      {selection.lines.map((run) => {
        const rail = foldWorkflowRunRail(run.phases);
        const text = runLineText(run, rail, intl);
        const name = runName(run, intl);
        const statusWord = runStatusWord(run, intl);
        const ariaLabel = intl.formatMessage(
          { id: "taskList.workflowRun.ariaLabel" },
          { name, status: statusWord },
        );
        const content = (
          <>
            <Workflow aria-hidden="true" className="size-3 shrink-0 text-foreground-subtle" />
            <RunRail rail={rail} intl={intl} />
            <span className="min-w-0 truncate">{text}</span>
          </>
        );
        const lineClassName = cn(
          "flex min-w-0 max-w-full items-center gap-1.5 rounded-md text-foreground-subtle",
          compact ? "h-6 text-ui-sm" : "h-5 text-ui-sm",
          interactive && "-ml-1 px-1 hover:bg-surface-hover hover:text-foreground",
        );
        const lineProps = {
          "data-workflow-run-line": "true",
          "data-run-id": run.runId,
          "data-run-status": run.status,
          className: lineClassName,
        };
        const line =
          interactive && session !== undefined && openRun !== null ? (
            <button
              type="button"
              {...lineProps}
              aria-label={ariaLabel}
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                // 行本身也可点（选中会话）；运行行是更具体的落点，不让点击再冒泡成一次普通选中。
                event.preventDefault();
                event.stopPropagation();
                openRun({
                  workspacePath: session.workspacePath,
                  ...(session.workspaceIdentity
                    ? { workspaceIdentity: session.workspaceIdentity }
                    : {}),
                  sessionId: session.sessionId,
                  run,
                });
              }}
            >
              {content}
            </button>
          ) : (
            <span {...lineProps} aria-label={ariaLabel}>
              {content}
            </span>
          );
        const description = runTooltipDescription(run, intl);
        return (
          <ControlHintTooltip
            key={run.runId}
            title={`${name}${SEPARATOR}${statusWord}`}
            {...(description === undefined ? {} : { description })}
            side="right"
            align="center"
          >
            {line}
          </ControlHintTooltip>
        );
      })}
      {selection.overflow > 0 ? (
        <span
          data-workflow-run-overflow={String(selection.overflow)}
          className={cn("text-foreground-subtlest", compact ? "h-6 text-ui-sm" : "h-5 text-ui-xs")}
        >
          {intl.formatMessage(
            { id: "taskList.workflowRun.moreRuns" },
            { count: String(selection.overflow) },
          )}
        </span>
      ) : null}
    </div>
  );
}
