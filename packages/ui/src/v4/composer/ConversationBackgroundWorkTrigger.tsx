// INV-01 只统计运行中的工作：守住位置 状态判断；改错故障 已完成条目被算进徽标。
// INV-02 工作流单独计数：守住位置 分支位置；改错故障 只有工作流时徽标消失。
// INV-03 总数汇总三类来源：守住位置 求和表达式；改错故障 打开面板后看不到实时条目。
// INV-04 子代理计数不得为负：守住位置 下限钳制；改错故障 负数抵消其他计数。
// INV-05 无回调或无计数时不渲染：守住位置 提前返回；改错故障 空徽标占住工具栏。
// INV-06 活动类别数由三类派生：守住位置 过滤长度；改错故障 混合文案判断错误。
// INV-07 工作流详情优先于混合文案：守住位置 分支顺序；改错故障 详情入口显示成混合提示。
// INV-08 单一类别使用专属文案：守住位置 三元链顺序；改错故障 终端活动被说成智能体。
// INV-09 读屏标签携带全部计数：守住位置 参数对象；改错故障 屏幕阅读器只听到总数。
// INV-10 宽屏与窄屏两套布局：守住位置 容器查询类；改错故障 窄屏下图标互相挤压。
// INV-11 图标顺序保持终端在前：守住位置 元素次序；改错故障 老用户视觉定位被打乱。
// INV-12 零计数类别不渲染图标：守住位置 条件渲染；改错故障 出现没有数字的空图标。
// INV-13 测试标识唯一且固定：守住位置 属性常量；改错故障 端到端选择器失效。
// INV-14 计数同时写入数据属性：守住位置 四个属性；改错故障 测试只能读文本推断。
// INV-15 点击行为交给宿主回调：守住位置 事件接线；改错故障 徽标自行猜测打开目标。
// INV-16 组件记忆化不比较上下文：守住位置 记忆包装；改错故障 每次渲染都重算计数。
// INV-17 计数派生走引用缓存：守住位置 依赖数组；改错故障 后台条目变化后数字停住。
// INV-18 数字使用等宽数字排版：守住位置 字体类；改错故障 计数跳动时行宽抖动。
//
// 模块职责：输入区上显示运行中后台工作的计数徽标与打开入口。
// 状态所有权：无内部状态；计数完全由传入的后台工作与子代理数派生。
// 阅读顺序：先看计数派生，再看文案选择，最后看两种布局的渲染。
import { memo, useMemo } from "react";
import { ActivityIcon, BotIcon, SquareTerminalIcon, Workflow } from "lucide-react";
import { TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER } from "@zcode/shared/test-ids";
import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface ComposerBackgroundWorkCounts {
  bashCount: number;
  workflowCount: number;
  subagentCount: number;
  totalCount: number;
}

// getComposerBackgroundWorkCounts 只统计 work.status === "running" 的条目。
// workflow 记入 workflowCount，不并入 bashCount。
// subagentCount 用 Math.max 把 runningSubagentCount 下限钳到 0。
// totalCount 恒等于 bashCount 加 workflowCount 加 subagentCount。
export function getComposerBackgroundWorkCounts(
  backgroundWorks: readonly BackgroundWorkSummary[],
  runningSubagentCount = 0,
): ComposerBackgroundWorkCounts {
  let bashCount = 0;
  let workflowCount = 0;
  for (const work of backgroundWorks) {
    if (work.status !== "running") continue;
    if (work.kind === "bash") {
      bashCount += 1;
    } else if (work.kind === "workflow") {
      // workflow run 单独计数，不并入 bashCount。totalCount 汇总三类后台工作，
      // 确保只有 workflow run 时也显示 badge，用户仍能打开面板使用停止按钮。
      workflowCount += 1;
    }
  }
  const subagentCount = Math.max(0, runningSubagentCount);
  return {
    bashCount,
    workflowCount,
    subagentCount,
    totalCount: bashCount + workflowCount + subagentCount,
  };
}

export interface ConversationBackgroundWorkTriggerProps {
  backgroundWorks: readonly BackgroundWorkSummary[];
  runningSubagentCount?: number;
  onOpen?: () => void;
  /**
   * onOpen 的落点：
   * `"workflow-run"` 时 tooltip 说的是「打开工作流详情」，否则沿用按类型的「打开运行中的…」。
   * 判定归宿主（要 toolCallId 与宿主回调，徽标看不到），这里只如实自述。
   */
  openTarget?: "panel" | "workflow-run";
}

// 组件体内先 useZCodeIntl 取文案，再 useMemo 派生 counts。
// onOpen 缺失或 counts.totalCount 为 0 时直接 return null。
// activeKindCount 统计三类中大于 0 的个数，用于选择 tooltip 文案。
// openTarget === "workflow-run" 时优先取 tooltipWorkflowDetails。
function ConversationBackgroundWorkTriggerImpl({
  backgroundWorks,
  runningSubagentCount = 0,
  onOpen,
  openTarget = "panel",
}: ConversationBackgroundWorkTriggerProps) {
  const { intl } = useZCodeIntl();
  const counts = useMemo(
    () =>
      getComposerBackgroundWorkCounts(backgroundWorks, runningSubagentCount),
    [backgroundWorks, runningSubagentCount],
  );

  if (!onOpen || counts.totalCount === 0) return null;

  // 恰好一类时用该类文案，否则混合：三类两两组合各写一句会堆出六条同义 tooltip，
  // 而 badge 的作用只是「有实时活动，点开看」，不承担精确枚举。
  const activeKindCount = [counts.bashCount, counts.workflowCount, counts.subagentCount].filter(
    (count) => count > 0,
  ).length;
  // activeKindCount 为 1 时按 bashCount/workflowCount 选终端或工作流文案。
  // activeKindCount 大于 1 时统一用 tooltipMixed。
  // ariaLabel 传入 bashCount/workflowCount/subagentCount/count 四个占位值。
  const tooltip = intl.formatMessage({
    id:
      openTarget === "workflow-run"
        ? "chat.composer.backgroundWorks.tooltipWorkflowDetails"
        : activeKindCount > 1
          ? "chat.composer.backgroundWorks.tooltipMixed"
          : counts.bashCount > 0
            ? "chat.composer.backgroundWorks.tooltipTerminal"
            : counts.workflowCount > 0
              ? "chat.composer.backgroundWorks.tooltipWorkflow"
              : "chat.composer.backgroundWorks.tooltipAgent",
  });
  const ariaLabel = intl.formatMessage(
    { id: "chat.composer.backgroundWorks.ariaLabel" },
    {
      bashCount: String(counts.bashCount),
      workflowCount: String(counts.workflowCount),
      subagentCount: String(counts.subagentCount),
      count: String(counts.totalCount),
    },
  );

  return (
    <ControlHintTooltip title={tooltip}>
      <Button
        type="button"
        variant="ghost"
        size="default"
        data-testid={TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER}
        data-background-bash-count={counts.bashCount}
        data-background-workflow-count={counts.workflowCount}
        data-background-subagent-count={counts.subagentCount}
        data-background-total-count={counts.totalCount}
        data-background-open-target={openTarget}
        aria-label={ariaLabel}
        onClick={onOpen}
        className="rounded-lg px-1.5 text-ui-base text-[var(--color-foreground-subtle)] tabular-nums"
      >
        <span
          data-composer-background-layout="typed"
          className="inline-flex items-center gap-1 @max-[480px]/composer:hidden"
          aria-hidden
        >
          {/* 终端在前，保持 workflow 拆出之前的视觉次序不变；workflow 插在终端与智能体之间。 */}
          {counts.bashCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <SquareTerminalIcon className="size-3.5" />
              <span>{counts.bashCount}</span>
            </span>
          ) : null}
          {counts.workflowCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <Workflow className="size-3.5" />
              <span>{counts.workflowCount}</span>
            </span>
          ) : null}
          {counts.subagentCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <BotIcon className="size-3.5" />
              <span>{counts.subagentCount}</span>
            </span>
          ) : null}
        </span>
        <span
          data-composer-background-layout="compact"
          className="hidden items-center gap-0.5 @max-[480px]/composer:inline-flex"
          aria-hidden
        >
          <ActivityIcon className="size-3.5" />
          <span>{counts.totalCount}</span>
        </span>
      </Button>
    </ControlHintTooltip>
  );
}

export const ConversationBackgroundWorkTrigger = memo(
  ConversationBackgroundWorkTriggerImpl,
);
