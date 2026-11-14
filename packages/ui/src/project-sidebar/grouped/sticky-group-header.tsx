// INV-01 守住位置：组件只读 props，不持有分组或任务状态；改错故障：出现第二份真相，吸顶头与列表项不同步
// INV-02 守住位置：所有文案经 intl 解析，不硬编码中文；改错故障：切换语言后标题仍停留在旧语种
// INV-03 守住位置：系统分组绝不渲染解散入口；改错故障：用户解散 cron 或闲时组，定时任务失去归集目标
// INV-04 守住位置：改色只走 onUpdateGroupColor 回调；改错故障：本地改写 node.group.color，UI 与 store 分叉
// INV-05 守住位置：新建任务只走 onCreateTask 回调；改错故障：组件内自行发起会话，绕过统一创建流程
// INV-06 守住位置：右键菜单与 GroupItem 保持同构；改错故障：同一分组在两个入口的行为与项数不一致
// INV-07 守住位置：header 主区域点击只负责折叠切换；改错故障：点新建按钮或色点时连带折叠分组
// INV-08 守住位置：折叠态只来自 collapsed 属性，组件内不缓存；改错故障：滚动重挂后图标与实际展开态相反
// INV-09 守住位置：Enter 与 Space 等价于鼠标点击；改错故障：键盘用户无法折叠分组
// INV-10 守住位置：色点下拉的 modal 为 false；改错故障：打开选择器锁住侧栏滚动并吞掉右键
// INV-11 守住位置：下拉与子菜单内部点击必须阻断冒泡；改错故障：选颜色时同时触发折叠
// INV-12 守住位置：计数直接取 node.tasks.length；改错故障：组件自行过滤，计数与列表条数不符
// INV-13 守住位置：标题使用 truncate 且父级保留 min-w-0；改错故障：长标题撑破布局并挤掉操作按钮
// INV-14 守住位置：根节点携带 data-grouped-sticky-header 与分组 id；改错故障：吸顶测量与滚动定位失效
// INV-15 守住位置：折叠回调只传 groupId；改错故障：改成传整个 node，回调身份不稳定导致重复渲染
// INV-16 守住位置：tooltipsDisabled 为真时不再包提示层；改错故障：移动端或嵌套场景出现双层提示
// INV-17 守住位置：所有原生按钮显式声明 type="button"；改错故障：处于表单容器时触发隐式提交
// INV-18 守住位置：组件不直接取服务或访问 Repo；改错故障：破坏注入边界，Web 与 Desktop 行为分叉
//
// 模块职责：渲染分组吸顶头，聚合折叠、改色、新建任务与解散四个入口，是分组的展示投影
// 状态所有权：分组树、折叠集合、颜色均归父级与 store；本组件不写任何业务状态，只发回调
// 阅读顺序：先看 props 契约与系统分组判定，再看事件阻断，最后看两条菜单入口
import { SidebarNativeTooltip, ControlHintTooltip } from "@/ControlHintTooltip.js";
import type {
  ZCodeGroupedTaskViewNode,
  ZCodeTaskGroupColor,
} from "@/project-sidebar/grouped/types.js";

import { ChevronDownIcon, ChevronRightIcon, MessageCirclePlus } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { CRON_DEFAULT_GROUP_ID, OFF_PEAK_DEFAULT_GROUP_ID } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getTaskGroupDisplayTitle } from "@/project-sidebar/grouped/group-title.js";
import {
  TASK_GROUP_COLORS,
  TaskGroupColorDot,
  TaskGroupColorMark,
} from "@/project-sidebar/grouped/shared.js";

// 对外契约：仅接收 node 与 6 个回调，自身不读写 store，也不缓存任何分组状态
// 因此同一份 node 在任意时刻渲染出的标题、计数与折叠图标完全由父级决定
// 把状态收进组件会让吸顶头与列表项各持一份真相，滚动重挂后必然分叉
// 回调都携带 groupId，父级据此定位分组；组件不拼 id、也不做 id 兜底
// 改错信号：出现 useEffect 把 props 同步进本地 state，即已违反纯展示约定
type StickyGroupNode = Extract<ZCodeGroupedTaskViewNode, { type: "group" }>;

export function StickyGroupHeader({
  node,
  collapsed,
  tooltipsDisabled,
  onCreateTask,
  onToggleCollapsed,
  onUpdateGroupColor,
  onUngroupGroup,
}: {
  node: StickyGroupNode;
  collapsed: boolean;
  tooltipsDisabled?: boolean;
  onCreateTask: () => void;
  onToggleCollapsed: (groupId: string) => void;
  onUpdateGroupColor: (groupId: string, color: ZCodeTaskGroupColor) => void;
  onUngroupGroup: (groupId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const taskCount = node.tasks.length;
  // 系统分组（cron / 闲时）标题按语言环境本地化展示，与 GroupItem 保持一致。
  // 标题必须经 getTaskGroupDisplayTitle 解析，系统分组走 intl 文案，自定义分组回落用户命名
  // 两个文案 id 分别对应 cron 与闲时分组，缺一会让该分组标题退化成原始 id
  // 这里每次渲染重新解析，成本可忽略，换来的是切换语言后标题立即更新
  // 若改成模块顶层常量或一次性求值，语言切换与分组重命名都会失效
  // 不要在此处再补一层兜底文案，分组标题的回落逻辑只应存在一处
  const displayTitle = getTaskGroupDisplayTitle(node.group, {
    cron: intl.formatMessage({ id: "taskGroup.cronGroupName" }),
    offPeak: intl.formatMessage({ id: "offPeak.sidebar.groupTitle" }),
  });
  // sticky header 的右键菜单要和 GroupItem 一样裁剪系统分组的“解散”项，
  // 否则 cron/闲时组滚动吸顶时可被误解散。系统分组一律不提供解散入口。
  // 系统分组判定在渲染期完成，cron 与闲时两个 id 任一命中即视为系统分组
  // 该判定同时被下方右键菜单裁剪复用，是唯一来源，不要在两处各写一份比较
  // 系统分组不提供解除入口，因为解散后会丢失默认归集目标，定时任务无处落地
  // 新增系统分组只需在这里扩展 id 比较，菜单会自动跟随，无需改两处
  // 改错信号：解散项对系统分组生效，说明该分支被绕开
  const isSystemGroup =
    node.group.id === CRON_DEFAULT_GROUP_ID || node.group.id === OFF_PEAK_DEFAULT_GROUP_ID;
  const handleToggle = () => onToggleCollapsed(node.group.id);
  const handleGroupColorChange = (color: string) => {
    onUpdateGroupColor(node.group.id, color as ZCodeTaskGroupColor);
  };
  // 新建按钮是 header 内的独立交互点，必须吞掉冒泡，否则点击会先折叠分组再建任务
  // click、mousedown、pointerdown 与 touchstart 都要拦，桌面与移动端触发路径不同
  // 只拦 click 时部分触屏浏览器仍会先向父级派发 pointer 事件，导致折叠闪烁
  // 按钮保持 ghost 与 icon-sm 尺寸，与列表项内的同名按钮视觉一致
  // aria-label 与提示共用同一文案 id，读屏播报和悬浮提示不会说法不一
  const newTaskButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="size-6 shrink-0 text-foreground-subtle hover:bg-hover hover:text-foreground"
      aria-label={intl.formatMessage({ id: "taskGroup.newTask" })}
      onClick={(event) => {
        event.stopPropagation();
        onCreateTask();
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      <MessageCirclePlus aria-hidden="true" className="size-3.5" />
    </Button>
  );
  // tooltipsDisabled 为真时直接返回裸按钮，避免在已禁用提示的场景再包一层
  // 该开关由父级按容器类型传入，组件不自行判断是否移动端或是否嵌在弹层内
  // 两个分支返回的元素结构不同，但事件行为必须完全一致，否则会出现只在某一端复现的缺陷
  // 改错表现为同一个按钮叠出双层提示，或提示延迟到移出后才消失
  // 不要在这里补默认值，undefined 与 false 都表示启用提示，与调用方语义保持一致
  const newTaskAction = tooltipsDisabled ? (
    newTaskButton
  ) : (
    <ControlHintTooltip title={intl.formatMessage({ id: "taskGroup.newTask" })}>
      {newTaskButton}
    </ControlHintTooltip>
  );

  return (
    <div className="px-2 pb-1" data-grouped-sticky-header={node.group.id}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            // 整行是 role=button 的可点击区域，折叠语义通过 aria-expanded 暴露给读屏
            // tabIndex=0 让它进入 Tab 序列，因此必须自行处理 Enter 与 Space
            // 其他键直接早返回，避免拦截方向键等侧栏导航按键
            // Space 需要 preventDefault，否则页面会同时向下滚动一屏
            // 鼠标与键盘最终都调用同一个 handleToggle，不要为键盘另开一条折叠路径
            role="button"
            tabIndex={0}
            aria-expanded={!collapsed}
            className={cn(
              "flex h-8 items-center gap-1 rounded-lg border border-border bg-background pl-1.5 pr-1 text-ui-base text-foreground shadow-sm",
              "cursor-pointer transition-[border-color,box-shadow] hover:border-border-hover",
            )}
            onClick={handleToggle}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") {
                return;
              }
              event.preventDefault();
              handleToggle();
            }}
          >
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
                  aria-label={intl.formatMessage({ id: "taskGroup.color" })}
                  onClick={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  onTouchStart={(event) => event.stopPropagation()}
                >
                  <TaskGroupColorMark color={node.group.color} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-40 min-w-40"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <DropdownMenuLabel>
                  {intl.formatMessage({ id: "taskGroup.color" })}
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={node.group.color}
                  onValueChange={handleGroupColorChange}
                >
                  {TASK_GROUP_COLORS.map((color) => (
                    <DropdownMenuRadioItem key={color} value={color}>
                      <TaskGroupColorDot color={color} />
                      <span>{intl.formatMessage({ id: `taskGroup.color.${color}` })}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <SidebarNativeTooltip>
                <span
                  className="min-w-0 max-w-full truncate rounded-sm px-1 text-left text-foreground"
                  title={displayTitle}
                >
                  {displayTitle}
                </span>
              </SidebarNativeTooltip>
              {collapsed ? (
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-foreground-subtlest"
                />
              ) : (
                <ChevronDownIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-foreground-subtlest"
                />
              )}
            </div>
            <span className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-tag/50 px-1.5 py-0.5 text-ui-sm font-medium leading-none text-foreground-subtle">
              {taskCount}
            </span>
            {newTaskAction}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem onSelect={onCreateTask}>
            {intl.formatMessage({ id: "taskGroup.newTask" })}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              {intl.formatMessage({ id: "taskGroup.changeColor" })}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent
              className="w-40"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {TASK_GROUP_COLORS.map((color) => (
                <ContextMenuItem key={color} onSelect={() => handleGroupColorChange(color)}>
                  <TaskGroupColorDot color={color} />
                  <span>{intl.formatMessage({ id: `taskGroup.color.${color}` })}</span>
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          {isSystemGroup ? null : (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => onUngroupGroup(node.group.id)}>
                {intl.formatMessage({ id: "taskGroup.ungroup" })}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
