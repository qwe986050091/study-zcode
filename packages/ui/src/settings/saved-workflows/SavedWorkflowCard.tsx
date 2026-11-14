// INV-01 [事务] 参数芯片上限只由模块顶层 MAX_ARG_CHIPS 决定，visibleArgs 取 argNames 的前 N 项、hiddenArgCount 由总数减可见数得出；两处若用不同上限，卡片会显示 3 个芯片却报错误的剩余数。
// INV-02 [权衡] 超过上限的参数名折叠成 +N 徽标，位置在 hiddenArgCount > 0 的三元分支；删掉它后长参数工作流会把底栏撑破并挤掉右侧上次运行徽标。
// INV-03 [事务] argNames 由 Object.keys 取 entry.args 的键序，不排序也不去重，位置在 SavedWorkflowCard 组件体首行；改成排序会让芯片顺序与工作流源文件的声明顺序脱钩。
// INV-04 [失败路径] entry.args 是可选字段，空值兜底只能在 Object.keys 的入参处用 ?? {} 完成；删掉兜底后无参数工作流首次渲染即抛错，整张卡片从列表消失。
// INV-05 [事务] 徽标种类只由 savedWorkflowRunBadgeKind 依据 run 的 status 归一，位置在 SavedWorkflowLastRunBadge 首个语句；另建一套按状态字面量的分支会与该 helper 的四态口径分叉。
// INV-06 [并发] 状态 switch 位于 never 早返回之后，只覆盖 completed、errored、running、stopped，icon 与 className 是声明未初始化的 let；新增状态而不补 case，穷尽检查会失败。
// INV-07 [失败路径] 早返回条件是 kind === "never" 或 run 为空，位置在 SavedWorkflowLastRunBadge 的 if；它同时承担对 run.updatedAt 的空值保护，删掉 !run 会让未加载态在取时间戳时崩溃。
// INV-08 [事务] 相对时间基准 now 由父级以 prop 传入、本组件不持有时钟，位置在 formatRelativeToNow 的第二个实参；改为组件内取当前时间会让徽标在两次外部重渲染之间冻结。
// INV-09 [权衡] 时间取 run.updatedAt 而非 createdAt，位置在 formatRelativeToNow 首参；换成创建时间后，运行中的徽标会一直显示工作流创建于多久前，与最近一次执行脱节。
// INV-10 [失败路径] 可见文案由徽标文案、固定分隔符与相对时间拼成，位置在 label 的模板字符串；拆成分段 JSX 会让 title 与可见文本不同源，悬停提示与卡面出现两种格式。
// INV-11 [事务] data-workflow-last-run 在 never 分支写死 never、正常分支写 kind，两处必须同源；只改一处会让空态断言的属性值与真实文案对不上。
// INV-12 [并发] 整卡用 role="button" 加 tabIndex 承担点击与焦点，位置在根 div 的属性区；删掉 tabIndex 后键盘用户无法聚焦，回车打开详情的分支永远走不到。
// INV-13 [失败路径] 根节点 onKeyDown 只认 Enter 与空格，且必须先 preventDefault 再调 onOpen；去掉 preventDefault 后空格会同时滚动列表，卡片打开了但视口已跳走。
// INV-14 [并发] 右上动作层用 onClick 与 onKeyDown 双 stopPropagation 与整卡点击分层，位置在动作容器 div；只留 onClick 时回车触发运行会冒泡成打开详情，一次操作产生两条导航。
// INV-15 [事务] 运行按钮的 disabled 只取 busy，busy 在参数解构处默认 false；删掉默认值后未传该 prop 的调用点拿到 undefined，空闲态也呈禁用外观且点击无效。
// INV-16 [失败路径] 菜单触发器按钮的 disabled 也取 busy，这是唯一拦住下拉项的闸门；删除与移动等条目自身没有 disabled，放开触发器即意味着运行中仍可发起删除或跨作用域移动。
// INV-17 [事务] 作用域动作项仅在 onMove 存在时渲染，文案按 entry.scope === "global" 走 moveToProject、否则 promoteToGlobal，位置在该条目的 id 三元；两个分支写反会出自我指涉菜单项。
// INV-18 [失败路径] 删除项只把 entry 交给 onDelete，卡片内没有二次确认，确认对话框归宿主；宿主侧若去掉确认，菜单里的删除会退化成一次点击即生效且不可撤销。
//
// 模块职责：已保存工作流的单卡投影，负责名称与两行说明、上次运行徽标、实参名芯片，以及运行/打开/修改/复制路径/移动/删除六个动作的上抛。
// 状态所有权：卡片是纯展示组件，无本地状态；busy 与 lastRun 由父级注入，回调由宿主持有，删除确认与一切副作用都不在本文件。
// 阅读顺序：先看 MAX_ARG_CHIPS 与 SavedWorkflowLastRunBadge 的徽标分支，再看组件体的芯片与底栏投影，最后看右上动作层、下拉菜单与作用域/删除分支。
import { memo, type ReactNode } from "react";
import { Ban, CircleCheck, Loader2, TriangleAlert } from "lucide-react";
import {
  TID_WORKFLOW_CARD,
  TID_WORKFLOW_CARD_MENU,
  TID_WORKFLOW_CARD_RUN,
  TID_WORKFLOW_ACTION_DELETE,
  TID_WORKFLOW_ACTION_MOVE,
  type ZCodeSavedWorkflowEntry,
  type ZCodeSavedWorkflowRun,
} from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  AutomationMoreHorizontalIcon,
  AutomationRunNowIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";
import { formatRelativeToNow } from "@/settings/automationFormat.js";
import { savedWorkflowRunBadgeKind } from "@/settings/saved-workflows/savedWorkflowRunHistory.js";

// 参数芯片的上限只由这个模块级常量决定，visibleArgs 取 argNames 的前 N 项、hiddenArgCount 由总数减可见数得出。
// [权衡] 上限取 3 是为了让底栏 h-6 单行容下徽标与芯片；调大后长参数工作流会撑高 132px 网格行，同排卡片高低不齐。
// 截断与计数必须基于同一份键名列表；先截断再取长度会让 hiddenArgCount 恒为 0，+N 徽标永不出现。
// 芯片的 key 用参数名而非下标，位置在 visibleArgs 的 map 返回值里；改成下标后同名参数复用错节点，文本会串行。
// 参数名是纯展示的等宽小字，不加省略也不挂浮层；完整参数列表应由详情页承担，避免卡面出现二级交互。
//
// [权衡] 参数标签只展示前三个，是为了让卡片高度稳定；调大这个值会让长参数列表把卡片撑开。
// [失败路径] entry.args 缺失时按空对象处理，卡片仍渲染运行按钮，只是没有参数标签可展开。
const MAX_ARG_CHIPS = 3;

/** 卡片「上次运行」徽标：四态 + 尚未运行。沿用定时任务卡的徽标形状（rounded-lg，20px 图标槽）。 */
export function SavedWorkflowLastRunBadge({
  run,
  now,
}: {
  run: ZCodeSavedWorkflowRun | undefined;
  now: number;
}) {
  const { intl } = useZCodeIntl();
  // 徽标的四态加尚未运行，统一由 savedWorkflowRunBadgeKind 依据 run 的 status 归一，本组件不再做第二套状态判断。
  // [事务] 归一结果同时驱动 data-workflow-last-run、图标、配色与文案 key，四处取同一个 kind；任一处改成独立判断都会让颜色与文字对不上。
  // run 可能为 undefined，因此归一入参写成 run?.status，并由下一行早返回兜住空态；把可选链改成直接取字段会在无运行记录时抛错。
  // completed 走 success 底色加 rounded-lg，errored 只给 destructive 文本色，running 用 warning 活动色，stopped 用弱化前景色，这是与定时任务卡对齐的既定口径。
  // [权衡] errored 与 stopped 都不铺底色，只靠图标语义区分；给两者补底色会让失败和中止看起来像成功态。
  //
  const kind = savedWorkflowRunBadgeKind(run?.status);
  // 早返回承担两件事：把 never 态直接渲染成纯文本，以及在进入下方逻辑前收敛 run 的非空类型。
  // [失败路径] 条件里的 !run 不能删：后续取更新时间的表达式没有任何二次判空，去掉后未加载态会变成运行时崩溃而不是降级展示。
  // never 分支的输出带 data-workflow-last-run 的 never 值，与正常分支的 kind 共用同一属性名；只改一侧会让测试断言落空。
  // 尚无运行记录时不渲染图标槽，只留一行弱化文案；补图标会让空态看起来像某种失败结果，误导用户去排查。
  // [事务] 早返回必须排在时间与文案计算之前；挪到其后会让未运行卡片先算一次相对时间再丢弃，且取时间戳时已越过空值保护。
  //
  if (kind === "never" || !run) {
    return (
      <span className="text-ui-base text-foreground-subtlest" data-workflow-last-run="never">
        {intl.formatMessage({ id: "workflows.hub.lastRun.never" })}
      </span>
    );
  }
  // `updatedAt` 而非 `createdAt`：徽标回答的是工作流上次跑了多久以前。
  // [事务] 时间基准 now 由父级注入，本组件不建定时器；这样同屏多张卡片共用一个基准，不会出现互相矛盾的几秒前。
  // 可见文案由徽标文案、固定分隔符与相对时间拼成，位置在下一行的模板字符串；分隔符改成逗号或删掉后，悬停提示与卡面会走两套格式。
  // 文案 key 按 kind 拼成 workflows.hub.lastRun 加后缀，依赖归一结果与资源文件的 key 一一对应；新增 kind 而漏配资源会直接显示裸 key。
  // [失败路径] 资源缺失不会抛错，只会把原始 key 渲染出来；因此改 kind 命名时必须同步多语言资源，否则问题只在界面文字上暴露。
  //
  const when = formatRelativeToNow(run.updatedAt, now, intl);
  const label = `${intl.formatMessage({ id: `workflows.hub.lastRun.${kind}` })} · ${when}`;
  let icon: ReactNode;
  let className: string;
  switch (kind) {
    case "completed":
      icon = <CircleCheck className="size-4" strokeWidth={1.33} aria-hidden="true" />;
      className = "rounded-lg bg-success/10 text-success";
      break;
    case "errored":
      icon = <TriangleAlert className="size-4" strokeWidth={1.33} aria-hidden="true" />;
      className = "text-destructive";
      break;
    case "running":
      // running 用活动色 warning（与实例详情页状态头同源）。
      icon = <Loader2 className="size-4 animate-spin" strokeWidth={1.33} aria-hidden="true" />;
      className = "rounded-lg bg-warning/10 text-warning";
      break;
    case "stopped":
      icon = <Ban className="size-4" strokeWidth={1.33} aria-hidden="true" />;
      className = "text-foreground-subtle";
      break;
  }
  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-0.5 py-0.5 pl-1 pr-2 text-ui-base font-normal",
        className,
      )}
      data-workflow-last-run={kind}
      title={label}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

interface SavedWorkflowCardProps {
  entry: ZCodeSavedWorkflowEntry;
  lastRun: ZCodeSavedWorkflowRun | undefined;
  now: number;
  busy?: boolean;
  onOpen: (entry: ZCodeSavedWorkflowEntry) => void;
  onRun: (entry: ZCodeSavedWorkflowEntry) => void;
  onRevise: (entry: ZCodeSavedWorkflowEntry) => void;
  onCopyPath: (entry: ZCodeSavedWorkflowEntry) => void;
  /** 作用域动作：项目档「提升为全局」（AI 概括）/ 全局档「移到项目…」；仅在传入时出现。 */
  onMove?: (entry: ZCodeSavedWorkflowEntry) => void;
  onDelete: (entry: ZCodeSavedWorkflowEntry) => void;
}

/**
 * 与定时任务卡同一张网格（132px 行、rounded-xl、p-3）：标题行 = 名字 + 右上「运行」与 ⋯；
 * 两行说明；底栏左 = 上次运行徽标、右 = 实参名芯片（最多 3 个 + `+N`）。整卡可点进详情。
 */
export const SavedWorkflowCard = memo(function SavedWorkflowCard({
  entry,
  lastRun,
  now,
  busy = false,
  onOpen,
  onRun,
  onRevise,
  onCopyPath,
  onMove,
  onDelete,
}: SavedWorkflowCardProps) {
  const { intl } = useZCodeIntl();
  // entry.args 在数据形状里是可选的，键名列表在组件体首行用空对象兜底，这是唯一的空值关口。
  // [失败路径] 把兜底删掉或挪进 JSX，无参数工作流会在首次渲染时对 undefined 取键并抛错，整张卡片从网格里消失。
  // 键序沿用对象自身的声明顺序，不做排序；芯片是给用户按定义顺序核对的，排序会打乱它与工作流源文件的对应关系。
  // [事务] 这份列表同时供底栏可见性判断、截断与剩余计数使用，必须只算一次；在 JSX 里重复取键会在 props 更新时出现长度与列表不同步。
  // 底栏只在列表非空时渲染芯片容器，位置在长度判零的三元；去掉判断会留下一个带间距的空 flex 容器，把徽标挤偏。
  //
  const argNames = Object.keys(entry.args ?? {});
  const visibleArgs = argNames.slice(0, MAX_ARG_CHIPS);
  const hiddenArgCount = argNames.length - visibleArgs.length;
  const runLabel = intl.formatMessage({ id: "workflows.hub.card.run" });
  const menuLabel = intl.formatMessage({ id: "workflows.hub.card.menu" });

  return (
    <div
      data-testid={testId(TID_WORKFLOW_CARD, entry.name)}
      data-workflow-name={entry.name}
      role="button"
      tabIndex={0}
      // 整卡是可点击区域：根 div 用 button 角色加 tabIndex 声明语义，点击只把 entry 原样上抛，卡片自身不导航。
      // [并发] 键盘等价路径在相邻的 onKeyDown 里，只认 Enter 与空格；加其他按键或在别处补点击，都会与整卡点击重复触发。
      // 点击与键盘都直接透传 entry，不在这里取 id 或拼路径；一旦卡片内先改写参数，宿主拿到的就是被加工过的对象。
      // [失败路径] 子节点有自己的交互时必须在动作容器上阻断冒泡，根节点不做 target 判断；在根节点加判断会让芯片区点击失效。
      // 高亮与焦点环由根节点的 hover 与 focus-visible 类承担，语义已经由角色和 tabIndex 提供，不必再包一层真实按钮。
      //
      onClick={() => onOpen(entry)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(entry);
        }
      }}
      className="group relative flex h-full min-h-0 cursor-pointer gap-3 overflow-hidden rounded-xl border border-card-border bg-background p-3 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
    >
      <div className="flex h-full min-w-0 flex-1 flex-col gap-3">
        <span className="block truncate pr-28 text-ui-base font-medium leading-5 text-foreground">
          {entry.name}
        </span>
        <p className="text-wrap-phrase line-clamp-2 h-10 text-ui-base font-normal leading-5 text-foreground-subtle">
          {entry.description}
        </p>
        <div className="mt-auto flex h-6 min-w-0 items-center gap-2 text-ui-base leading-5">
          <div className="flex min-w-0 flex-1 items-center">
            <SavedWorkflowLastRunBadge run={lastRun} now={now} />
          </div>
          {argNames.length === 0 ? null : (
            <div className="flex shrink-0 items-center gap-1" data-workflow-args="true">
              {visibleArgs.map((argName) => (
                <span
                  key={argName}
                  className="rounded-xs border border-border px-1.5 py-0.5 font-mono text-ui-xs leading-none text-foreground-subtlest"
                >
                  {argName}
                </span>
              ))}
              {hiddenArgCount > 0 ? (
                <span className="font-mono text-ui-xs leading-none text-foreground-subtlest">
                  {intl.formatMessage(
                    { id: "workflows.hub.card.argsMore" },
                    { count: String(hiddenArgCount) },
                  )}
                </span>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {/* 卡面动作与整卡点击分层：按钮 stopPropagation，键盘上也不会把 Enter 冒泡成「打开详情」。 */}
      <div
        className="absolute right-3 top-3 flex items-center gap-1"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-icon="inline-start"
          data-testid={testId(TID_WORKFLOW_CARD_RUN, entry.name)}
          disabled={busy}
          onClick={() => onRun(entry)}
        >
          <AutomationRunNowIcon className="size-3" aria-hidden="true" />
          {runLabel}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={menuLabel}
              data-testid={testId(TID_WORKFLOW_CARD_MENU, entry.name)}
              disabled={busy}
            >
              <AutomationMoreHorizontalIcon className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onOpen(entry)}>
              {intl.formatMessage({ id: "workflows.hub.card.open" })}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onRevise(entry)}>
              {intl.formatMessage({ id: "workflows.hub.card.revise" })}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onCopyPath(entry)}>
              {intl.formatMessage({ id: "workflows.hub.card.copyPath" })}
            </DropdownMenuItem>
            {onMove ? (
              <DropdownMenuItem
                data-testid={testId(TID_WORKFLOW_ACTION_MOVE, entry.name)}
                onSelect={() => onMove(entry)}
              >
                {intl.formatMessage({
                  id:
                    entry.scope === "global"
                      ? "workflows.hub.card.moveToProject"
                      : "workflows.hub.card.promoteToGlobal",
                })}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid={testId(TID_WORKFLOW_ACTION_DELETE, entry.name)}
              className="text-destructive focus:text-destructive"
              onSelect={() => onDelete(entry)}
            >
              <AutomationTrashIcon />
              {intl.formatMessage({ id: "workflows.hub.card.delete" })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
});
