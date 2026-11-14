// INV-01 头行只读展示：守住位置 props.entry 的用法；改错故障 头行自己拉数据，与详情页状态不一致。
// INV-02 运行要同时满足不忙且有条目：守住位置 disabled 的或运算；改错故障 条目缺失时仍可点运行。
// INV-03 菜单只受忙碌约束：守住位置 ⋯ 按钮的 disabled；改错故障 运行中连复制路径都被锁住。
// INV-04 归属是标签不是链接：守住位置 面包屑改两级后的说明；改错故障 出现一个点不动的假链接。
// INV-05 归属小标与组头同款样式：守住位置 边框与弱化字色；改错故障 用户把它当成可点控件。
// INV-06 空说明不渲染段落：守住位置 description 三元；改错故障 空段落占掉一行高度。
// INV-07 作用域动作仅在传入时出现：守住位置 onMove 三元；改错故障 项目档出现无法执行的菜单项。
// INV-08 移动与提升按作用域换文案：守住位置 entry.scope 判断；改错故障 全局档显示「移到项目」。
// INV-09 删除项常驻且用危险色：守住位置 text-destructive；改错故障 破坏性动作与普通项难以区分。
// INV-10 菜单项测试 id 带工作流名：守住位置 testId 第二参；改错故障 同名工作流无法逐条定位。
// INV-11 装饰图标全部隐藏：守住位置 三处 aria-hidden；改错故障 读屏把图标名重复念出。
// INV-12 标题是详情页唯一 h1：守住位置 h1 标签；改错故障 页面出现多个一级标题。
// INV-13 长名称可截断：守住位置 内层 min-w-0；改错故障 超长名称把操作区挤出视口。
// INV-14 组件从详情页拆出：守住位置 文件级 JSDoc；改错故障 详情页超过 400 行上限。
//
// 模块职责：已保存工作流详情页的头行，含标题、归属小标、说明与运行、菜单动作。
// 阅读顺序：先看左侧标题与归属，再看运行按钮，最后看 ⋯ 菜单的作用域与删除项。
import {
  TID_WORKFLOW_DETAIL_MENU,
  TID_WORKFLOW_DETAIL_PROJECT,
  TID_WORKFLOW_DETAIL_RUN,
  TID_WORKFLOW_ACTION_DELETE,
  TID_WORKFLOW_ACTION_MOVE,
  type ZCodeSavedWorkflowEntry,
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
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  AutomationMoreHorizontalIcon,
  AutomationRunNowIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";

interface SavedWorkflowDetailHeaderProps {
  name: string;
  /** 标题旁的归属小标：项目名，全局档为「全局」。 */
  projectLabel: string;
  description: string;
  entry: ZCodeSavedWorkflowEntry | undefined;
  busy: boolean;
  onRun: () => void;
  onRevise: () => void;
  onCopyPath: () => void;
  /** 作用域动作：项目档「提升为全局」（AI 概括）/ 全局档「移到项目…」；仅在传入时出现。 */
  onMove?: () => void;
  onDelete: () => void;
}

/**
 * 详情页头行：标题 + 归属小标 + 说明 + 右上「运行」与 ⋯ 菜单。从详情页拆出以守住 max-lines（≤400）。
 */
// 头行只消费 props，不自己取数。
export function SavedWorkflowDetailHeader({
  name,
  projectLabel,
  description,
  entry,
  busy,
  onRun,
  onRevise,
  onCopyPath,
  onMove,
  onDelete,
}: SavedWorkflowDetailHeaderProps) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        {/* Bugfix：项目归属原先是面包屑的中间一级（自动化 › 项目 › 名字）。但项目只是列表里的一组，
            不是一页，那一级没有去处，只能做成点不动的文字，颜色却和能点的那级一样，看着像坏掉的
            链接。面包屑改回两级，归属挪到这里，写成一眼看得出不是控件的小标（与列表组头的
            「当前」小标同一套样式）。 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h1 className="min-w-0 text-ui-xl font-semibold text-foreground">{name}</h1>
          <span
            // 归属小标有独立测试 id，便于断言作用域。
            data-testid={TID_WORKFLOW_DETAIL_PROJECT}
            className="max-w-60 truncate rounded-sm border border-border px-1.5 text-ui-xs leading-4 text-foreground-subtlest"
          >
            {projectLabel}
          </span>
        </div>
        {description ? <p className="text-ui-base text-foreground-subtle">{description}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          size="lg"
          data-icon="inline-start"
          data-testid={TID_WORKFLOW_DETAIL_RUN}
          // `busy` 为真或条目缺失时，运行按钮禁用。
          disabled={busy || !entry}
          onClick={onRun}
        >
          <AutomationRunNowIcon className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "workflows.hub.detail.run" })}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-lg"
              aria-label={intl.formatMessage({ id: "workflows.hub.card.menu" })}
              data-testid={TID_WORKFLOW_DETAIL_MENU}
              // 菜单只受 `busy` 约束，浏览类动作不受影响。
              disabled={busy}
            >
              <AutomationMoreHorizontalIcon className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onRevise}>
              {intl.formatMessage({ id: "workflows.hub.card.revise" })}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onCopyPath}>
              {intl.formatMessage({ id: "workflows.hub.card.copyPath" })}
            </DropdownMenuItem>
            {onMove ? (
              <DropdownMenuItem
                data-testid={testId(TID_WORKFLOW_ACTION_MOVE, name)}
                onSelect={onMove}
              >
                {intl.formatMessage({
                  id:
                    // 文案按当前作用域切换。
                    entry?.scope === "global"
                      ? "workflows.hub.card.moveToProject"
                      : "workflows.hub.card.promoteToGlobal",
                })}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              // 测试 id 带工作流名 `workflowName`，用例可定位到具体条目。
              data-testid={testId(TID_WORKFLOW_ACTION_DELETE, name)}
              // 删除是破坏性动作，全程使用危险色。
              className="text-destructive focus:text-destructive"
              onSelect={onDelete}
            >
              <AutomationTrashIcon />
              {intl.formatMessage({ id: "workflows.hub.card.delete" })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
