// INV-01 分组键：守住位置 分组卡片的项目与主机数据属性；改错故障：自动化与操作回填找不到分组。
// INV-02 收起不挂载：守住位置 展开条件；改错故障：收起状态仍构造上千行，样式重算卡顿。
// INV-03 增量展开：守住位置 分页上限与每次增量；改错故障：一次渲染全部任务，首帧卡死。
// INV-04 日期来源：守住位置 排序模式对应的字段；改错故障：按创建时间排序却显示更新时间。
// INV-05 操作委托：守住位置 回调签名；改错故障：批量卸载或删除只作用于一行。
// INV-06 禁用一致：守住位置 禁用标志透传；改错故障：操作进行中仍可重复触发。
// INV-07 键稳定：守住位置 任务键生成函数；改错故障：删除一行后其余行状态错位。
// INV-08 文案前缀：守住位置 归档文案拼接；改错故障：提示串到其它模块的键。
// INV-09 计数来源：守住位置 分组任务长度；改错故障：计数与列表实际条数不一致。
// INV-10 展开状态：守住位置 受控折叠；改错故障：外部重置后卡片仍保持展开。
// INV-11 菜单模态：守住位置 下拉的非模态设置；改错故障：菜单关闭时抢走焦点。
// INV-12 危险项样式：守住位置 删除项的破坏性变体；改错故障：删除与卸载视觉无法区分。
// INV-13 时间元素：守住位置 机器可读时间属性；改错故障：读屏或导出拿到本地化文本。
// INV-14 截断标题：守住位置 标题属性；改错故障：长标题无法查看全文。
// INV-15 丢弃确认：守住位置 批量删除的调用；改错故障：误点即删且无撤销入口。
// INV-16 图标语义：守住位置 图标隐藏标记；改错故障：读屏重复朗读装饰图标。
// INV-17 分组标题：守住位置 标题截断容器；改错故障：长项目名撑破侧栏宽度。
// INV-18 纯展示：守住位置 组件内不发起请求；改错故障：渲染期触发归档操作。
//
// 模块职责：渲染单个归档分组的折叠卡片，含计数、批量菜单与增量展开的任务行。
// 状态所有权：展开状态与分页上限归组件；任务数据与操作回调由上层传入。
// 阅读顺序：属性 → 语言与日期 → 状态 → 头部与菜单 → 展开内容 → 更多按钮。
import { useState } from "react";
import { ChevronRight, Ellipsis, Folder, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  archiveTaskKey,
  type ArchiveSort,
  type ArchiveGroup,
} from "@/project-sidebar/archive-view.js";
import type { ArchiveOperation } from "@/project-sidebar/useArchiveManagement.js";
import type { ProjectTask } from "@/project-sidebar/contract.js";

// 分组卡片：头部是折叠开关、计数与批量菜单，展开后按上限渲染任务行。
// 批量操作直接接收本组全部任务，单行操作传入只含一行的数组。
// 禁用标志同时约束菜单按钮与行内按钮，批量进行中不能再点。
// 任务是惰性挂载的：收起时不构造行内容，避免上千行放大全局样式重算。
//
export function ArchiveGroupCard({
  group,
  name,
  sort,
  disabled,
  onAction,
}: {
  group: ArchiveGroup;
  name: string;
  sort: ArchiveSort;
  disabled: boolean;
  onAction: (rows: ProjectTask[], operation: ArchiveOperation) => Promise<void>;
}) {
  const { intl, locale } = useZCodeIntl();
  // 日期格式：按当前语言与固定字段组合生成，只用于任务行的可读时间。
  // `dateFormat` 在渲染函数内创建，语言切换后随重渲染得到新实例。
  //
  const dateFormat = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const msg = (id: string) => intl.formatMessage({ id: `archives.${id}` });
  // 分页上限：初始 50 条，点更多每次加 50，只增不减。
  // 收起状态归组件所有，重新展开时保留上次的展开量。
  //
  const [limit, setLimit] = useState(50);
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section
        // 分组标识：项目标识为空时仍保留空串，主机标识区分同名项目。
        // 两个数据属性是外部定位分组的唯一入口，改名会破坏自动化。
        //
        data-testid="archive-group"
        data-project-id={group.projectId ?? ""}
        data-host-id={group.hostId}
        className="min-w-0"
      >
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="min-w-0 flex-1">
            <CollapsibleTrigger asChild>
              <Button
                data-testid="archive-group-toggle"
                variant="ghost"
                className="w-full min-w-0 justify-start gap-2 px-0 font-medium hover:bg-transparent focus-visible:bg-hover aria-expanded:bg-transparent"
              >
                <Folder aria-hidden="true" className="size-4 text-foreground-subtle" />
                <span className="min-w-0 truncate" title={name}>
                  {name}
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 text-foreground-subtle transition-transform group-data-[state=open]/button:rotate-90"
                />
              </Button>
            </CollapsibleTrigger>
          </h3>
          <span className="shrink-0 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "archives.count" }, { count: group.tasks.length })}
          </span>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                data-testid="archive-group-menu"
                size="icon-sm"
                variant="ghost"
                disabled={disabled}
                aria-label={intl.formatMessage({ id: "archives.groupActions" }, { name })}
              >
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                data-testid="archive-group-unarchive"
                // 批量卸载：回调返回承诺，这里显式丢弃，避免未处理的拒绝冒泡。
                // `onAction` 被卸载与删除共用，差别只在操作类型字符串。
                // 删除项使用破坏性样式，与卸载形成视觉区分。
                //
                onSelect={() => void onAction(group.tasks, "unarchive")}
              >
                {msg("unarchiveAll")}
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="archive-group-delete"
                variant="destructive"
                onSelect={() => void onAction(group.tasks, "delete")}
              >
                {msg("deleteAll")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <CollapsibleContent className="data-[state=open]:pt-3">
          {/* 每组 50 条仍会累积上千行，放大 Select 全局样式重算；收起时不构造或挂载行内容。 */}
          {open ? (
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface px-4">
              {group.tasks.slice(0, limit).map((task) => (
                <div
                  key={archiveTaskKey(task)}
                  data-testid="archive-task"
                  data-task-id={task.taskId}
                  className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-3 sm:flex-nowrap"
                >
                  <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                    <p className="truncate text-ui-base font-medium" title={task.title}>
                      {task.title}
                    </p>
                    <time
                      dateTime={new Date(
                        sort === "created" ? task.createdAt : task.updatedAt,
                      ).toISOString()}
                      className="text-ui-sm text-foreground-subtle"
                    >
                      {dateFormat.format(sort === "created" ? task.createdAt : task.updatedAt)}
                    </time>
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    <Button
                      data-testid="archive-delete"
                      size="icon-sm"
                      variant="ghost"
                      disabled={disabled}
                      aria-label={intl.formatMessage(
                        { id: "archives.deleteTask" },
                        { title: task.title },
                      )}
                      onClick={() => void onAction([task], "delete")}
                    >
                      <Trash2 className="size-4 text-foreground-subtle" />
                    </Button>
                    <Button
                      data-testid="archive-unarchive"
                      variant="secondary"
                      disabled={disabled}
                      onClick={() => void onAction([task], "unarchive")}
                    >
                      {msg("unarchive")}
                    </Button>
                  </div>
                </div>
              ))}
              {group.tasks.length > limit ? (
                <Button
                  data-testid="archive-show-more"
                  variant="ghost"
                  className="my-2 w-full"
                  // 增量固定为 50，与初始上限保持一致，避免两处常量漂移。
                  // 函数式更新保证快速连点也不会丢增量。
                  //
                  onClick={() => setLimit((n) => n + 50)}
                >
                  {msg("showMore")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
