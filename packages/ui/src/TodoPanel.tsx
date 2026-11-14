// INV-01 无计划或空计划时不渲染面板：守住位置 早退；改错故障 出现空壳标题。
// INV-02 全部完成时隐藏面板：守住位置 全完成判断；改错故障 完成间隙仍显示待办。
// INV-03 展开态只展示未完成项：守住位置 可见项过滤；改错故障 面板随完成项变长。
// INV-04 活动步骤优先进行中，其次首个未完成，最后末项：守住位置 查找顺序；改错故障 标题显示已完成步骤。
// INV-05 加载动画只在运行期出现：守住位置 流式与全完成组合；改错故障 停止后仍转圈。
// INV-06 运行期与非运行期使用两套状态样式：守住位置 样式表选择；改错故障 停止后仍显示渐变。
// INV-07 完成项样式始终带删除线：守住位置 两套样式表；改错故障 完成与未完成难以区分。
// INV-08 进度计数使用完成数比总数：守住位置 计数计算；改错故障 进度与列表不一致。
// INV-09 展开时计数显示在标题行：守住位置 分支位置；改错故障 计数缺失。
// INV-10 折叠时计数显示在标题之后：守住位置 折叠分支；改错故障 折叠后无法看到进度。
// INV-11 折叠标题优先显示活动步骤标题：守住位置 标题回退；改错故障 折叠态丢失当前任务。
// INV-12 活动步骤缺失时回退到当前任务文案：守住位置 空值合并；改错故障 标题为空白。
// INV-13 标题行按钮负责展开而不是整个头部：守住位置 点击绑定位置；改错故障 空白区误触展开。
// INV-14 标题按钮必须报告展开状态：守住位置 展开状态属性；改错故障 读屏无法感知。
// INV-15 右侧图标按钮必须阻止冒泡：守住位置 冒泡拦截；改错故障 一次点击切换两次。
// INV-16 图标按钮必须带读屏标签与提示：守住位置 标签与提示组件；改错故障 图标按钮无含义。
// INV-17 展开内容使用队列列表并保留状态点：守住位置 列表渲染；改错故障 状态不可辨认。
// INV-18 列表项键使用步骤标识：守住位置 键属性；改错故障 重排时状态错位。
//
// 模块职责：渲染任务计划面板，折叠时展示当前步骤，展开时列出未完成步骤。
// 状态所有权：计划与流式标记来自入参；展开状态由组件本地持有。
// 阅读顺序：先看三张状态样式表，再读早退与活动步骤推导，最后看头部与列表。
import { useState } from "react";
import type { ZCodePlanStep } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Plan,
  PlanAction,
  PlanContent,
  PlanDescription,
  PlanHeader,
  PlanTitle,
} from "@/components/ai-elements/plan.js";
import {
  QueueItem,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
} from "@/components/ai-elements/queue.js";
import {
  ChevronsUpDownIcon,
  ListTodo,
  LoaderIcon,
} from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "./components/lib/utils.js";

// todoStatusIndicatorClasses 按 ZCodePlanStep["status"] 映射：pending 用 text-foreground-subtlest、in_progress 用 text-foreground、completed 用 text-success；该表只控制左侧状态点，内容样式由 todoStatusContentClassesStreaming/Idle 单独维护。
const todoStatusIndicatorClasses: Record<ZCodePlanStep["status"], string> = {
  pending: "text-foreground-subtlest",
  in_progress: "text-foreground",
  completed: "text-success",
};

const todoStatusContentClassesStreaming: Record<ZCodePlanStep["status"], string> = {
  pending: "text-foreground-subtle",
  in_progress: "animated-gradient-text",
  completed: "text-foreground-subtlest line-through",
};

// Bugfix: 任务停止/结束后 plan 可能还留着 in_progress 项，如果继续套 animated-gradient-text，
// 面板就会一直显示 loading 态。非运行期降级为普通文本，仅保留状态色。
// todoStatusContentClassesIdle 在非运行期把 in_progress 从 animated-gradient-text 降级为 text-foreground，completed 保留 line-through：任务停止后 plan 可能残留 in_progress，继续套渐变会让面板一直显示 loading。
const todoStatusContentClassesIdle: Record<ZCodePlanStep["status"], string> = {
  pending: "text-foreground-subtle",
  in_progress: "text-foreground",
  completed: "text-foreground-subtlest line-through",
};

// TodoPanel 在 !plan || plan.length === 0 时返回 null；completedCount 用 plan.filter(step => step.status === "completed").length，与 plan.length 相等即 isAllCompleted 并提前隐藏；visiblePlan 只留未完成项，activeStep 按 in_progress → 非 completed → 最后一项三级顺序推导。
export function TodoPanel({
  plan,
  isStreaming,
}: {
  plan: ZCodePlanStep[] | null;
  isStreaming: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [isOpen, setIsOpen] = useState(false);

  if (!plan || plan.length === 0) {
    return null;
  }

  const completedCount = plan.filter(
    (step) => step.status === "completed",
  ).length;
  const isAllCompleted = completedCount === plan.length;
  // Bugfix: provider 可能先把 todo 全部标成 completed，再稍后才推 task_complete 清空 store。
  // 这段间隙继续展示“已完成 todo”会让用户误以为还有待处理事项，所以全完成后直接隐藏面板。
  if (isAllCompleted) {
    return null;
  }

  // Bugfix: 展开态之前会把 completed 项继续画出来，只是加删除线；完成项越多面板越长。
  // 这里仅保留未完成项，让 todo 面板专注显示还需要关注的后续工作。
  const visiblePlan = plan.filter((step) => step.status !== "completed");
  const activeStep =
    plan.find((step) => step.status === "in_progress") ??
    plan.find((step) => step.status !== "completed") ??
    plan[plan.length - 1];
  // Bugfix: loading 视觉只在任务真正运行期出现。task 已完成/失败/被停止时，
  // 即便 plan 仍残留 in_progress 项，也不再转菊花或做渐变动画。
  const showLoadingState = isStreaming && !isAllCompleted;
  const todoStatusContentClasses = isStreaming
    ? todoStatusContentClassesStreaming
    : todoStatusContentClassesIdle;
  const toggleLabel = intl.formatMessage({ id: "todo.panel.toggle" });
  // toggleOpen 只执行 setIsOpen((current) => !current)，展开态是组件本地状态；PlanHeader 的标题按钮与右侧图标按钮共用它，图标按钮先 e.stopPropagation() 再调用；外部只能通过 Plan 的 onOpenChange 改变展开。
  const toggleOpen = () => setIsOpen((current) => !current);

  // PlanHeader 只负责布局，不承担点击展开：展开逻辑收敛到标题 button（aria-expanded={isOpen}）与右侧图标按钮，isOpen 时 !pb-1 收窄底部内边距，右侧动作区 shrink-0。
  return (
    <Plan
      className="gap-0 overflow-hidden rounded-none border-0 bg-popover py-0"
      open={isOpen}
      onOpenChange={setIsOpen}
      isStreaming={isStreaming}
    >
      {/* 修复原因：PlanHeader 负责撑满布局，不能再承担点击展开，否则空白区域也会误触。
          展开逻辑收敛到内容宽度按钮和右侧图标按钮，保留键盘与读屏状态。 */}
      <PlanHeader
        className={cn(
          "group flex items-center gap-3 px-4 !py-3",
          isOpen && "!pb-1",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center">
          <button
            type="button"
            aria-expanded={isOpen}
            className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-3 rounded-md p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
            onClick={toggleOpen}
          >
            {isOpen ? (
              <>
                <ListTodo className="size-4 shrink-0 text-foreground" />
                <PlanTitle className="min-w-0 truncate text-ui-base font-medium text-foreground">
                  {intl.formatMessage({ id: "todo.panel.title" })}
                </PlanTitle>
                <PlanDescription className="shrink-0 text-ui-base font-mono text-foreground-subtlest">
                  {`${completedCount}/${plan.length}`}
                </PlanDescription>
              </>
            ) : showLoadingState ? (
              <>
                <LoaderIcon className="size-4 shrink-0 animate-spin text-foreground" />
                <PlanTitle className="animated-gradient-text min-w-0 truncate text-ui-base font-medium">
                  {activeStep?.title ??
                    intl.formatMessage({ id: "todo.panel.currentTask" })}
                </PlanTitle>
              </>
            ) : (
              <>
                <ListTodo className="size-4 shrink-0 text-foreground" />
                <PlanTitle className="min-w-0 truncate text-ui-base font-medium text-foreground">
                  {activeStep?.title ??
                    intl.formatMessage({ id: "todo.panel.currentTask" })}
                </PlanTitle>
              </>
            )}
            {!isOpen ? (
              <PlanDescription className="shrink-0 text-ui-base font-mono text-foreground-subtle">
                {`${completedCount}/${plan.length}`}
              </PlanDescription>
            ) : null}
          </button>
        </div>
        <PlanAction className="shrink-0">
          <ControlHintTooltip
            title={intl.formatMessage({
              id: isOpen ? "chat.longRunning.collapse" : "chat.longRunning.expand",
            })}
          >
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-expanded={isOpen}
              aria-label={toggleLabel}
              onClick={(event) => {
                event.stopPropagation();
                toggleOpen();
              }}
            >
              <ChevronsUpDownIcon className="size-4" />
              <span className="sr-only">{toggleLabel}</span>
            </Button>
          </ControlHintTooltip>
        </PlanAction>
      </PlanHeader>
      <PlanContent className="p-1">
        <QueueList className="mt-0">
          {visiblePlan.map((step) => (
            <QueueItem
              key={step.id}
              className="gap-0 w-full rounded-xl px-3 py-2 hover:bg-hover/30"
            >
              <div className="flex min-w-0 items-center gap-3">
                <QueueItemIndicator
                  className={todoStatusIndicatorClasses[step.status]}
                  status={step.status}
                />
                <QueueItemContent
                  className={`min-w-0 line-clamp-none ${todoStatusContentClasses[step.status]}`}
                  completed={false}
                >
                  {step.title}
                </QueueItemContent>
              </div>
            </QueueItem>
          ))}
        </QueueList>
      </PlanContent>
    </Plan>
  );
}
