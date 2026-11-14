// INV-01 只锁横向轴：守住位置 拖拽修饰器；改错故障 侧栏被拖出横向滚动。
// INV-02 修饰器引用稳定：守住位置 模块级常量；改错故障 每帧重建拖拽配置。
// INV-03 顺序由偏好决定：守住位置 分区顺序数组；改错故障 拖拽结果不持久。
// INV-04 拖拽结束才落盘：守住位置 结束回调；改错故障 拖动过程反复写存储。
// INV-05 相同目标不重排：守住位置 标识相等判断；改错故障 点击分区触发无意义写入。
// INV-06 分区标识即业务键：守住位置 排序标识；改错故障 项目与任务互换内容。
// INV-07 折叠态分开存：守住位置 两个布尔字段；改错故障 展开项目把任务也展开。
// INV-08 偏好只读一次：守住位置 惰性初值；改错故障 外部更新覆盖用户拖拽结果。
// INV-09 写入与状态同源：守住位置 更新函数；改错故障 内存与磁盘顺序不一致。
// INV-10 指针激活需位移：守住位置 六像素阈值；改错故障 点击被误判成拖动。
// INV-11 键盘排序保留：守住位置 键盘传感器；改错故障 只能用鼠标调整顺序。
// INV-12 单列网格防撑宽：守住位置 列模板；改错故障 长标题把整列顶出横向滚动。
// INV-13 分页按钮稳定居中：守住位置 单列布局；改错故障 列表抖动导致按钮左右跳。
// INV-14 标题全部走国际化：守住位置 消息标识；改错故障 英文硬编码进侧栏。
// INV-15 展开全部受权限控制：守住位置 禁用条件；改错故障 无项目时仍可点击。
// INV-16 动作按钮随分区切换：守住位置 三元分支；改错故障 任务分区出现新建项目。
// INV-17 分区内容由宿主提供：守住位置 子节点透传；改错故障 组件自行拉取数据。
// INV-18 重排不重建子树：守住位置 key 绑定；改错故障 顺序变化导致焦点丢失。
//
// 模块职责：侧栏「项目 / 任务」分区的排序、折叠与动作按钮编排。
// 状态所有权：顺序与折叠偏好存本地；项目与任务数据由宿主注入。
// 阅读顺序：先看拖拽修饰器与偏好读写，再读渲染分支，最后看动作按钮。
import { useState, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Plus, MessageCirclePlus, ListChevronsDownUp, ListChevronsUpDown } from "lucide-react";
import { WorkspacePurposeSection } from "@/WorkspaceSidebar/WorkspacePurposeSection.js";
import {
  readSidebarPurposeSectionPreferences,
  persistSidebarPurposeSectionPreferences,
  reorderSidebarPurposeSections,
} from "@/lib/sidebarPurposeSectionPreferences.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// 原因：横向拖动会撑宽 overflow-y:auto 的侧栏并触发水平自动滚动；在碰撞计算前固定纵轴。
// collisionDetection 之前把 transform.x 清零，避免横向位移撑宽侧栏。
// transform.y 保持原值，纵向拖动不受这条 modifier 影响。
// sectionDragModifiers 放在模块级，不随组件渲染重建。
// 模块级常量在渲染期间不重新创建，引用稳定。
// modifier 只读 transform，不读取任何组件状态。
// 返回新对象 { ...transform, x: 0 }，原数组本身不被修改。
const sectionDragModifiers: Modifier[] = [({ transform }) => ({ ...transform, x: 0 })];

/** 折叠和分区顺序继续使用旧偏好；项目/任务数据始终由 Host 提供。 */
// projects 与 tasks 由 Host 渲染后传入，组件不自行取数。
// 组件不订阅 project 区块数据，更新由父级重渲染驱动。
// 分区顺序来自 readSidebarPurposeSectionPreferences 读出的偏好。
// 每个分区有独立的 sortable id，折叠状态各自保存。
// 标题统一走 project.* 命名空间，由 intl.formatMessage 解析。
// onAdd 与 onCreate 按分区类型二选一，不两个都给。
export function PurposeSections({
  projects,
  tasks,
  onAdd,
  onCreate,
  hasExpandedProjects,
  canToggleProjects,
  onToggleProjects,
}: {
  projects: ReactNode;
  tasks: ReactNode;
  onAdd(): void;
  onCreate(): void;
  hasExpandedProjects: boolean;
  canToggleProjects: boolean;
  onToggleProjects(): void;
}) {
  const { intl } = useZCodeIntl();
  const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
  // preferences 的初值只读一次，不会随后续写入回灌。
  // update() 同时 setPreferences 与 persistSidebarPurposeSectionPreferences。
  // onDragEnd 的结果按 index 换算成新的分区顺序。
  // 每个分区的 collapsed 状态独立保存，互不影响。
  // 偏好结构变化只改 SidebarPurposeSectionPreferences 类型，读写两端共用。
  const [preferences, setPreferences] = useState(readSidebarPurposeSectionPreferences);
  const update = (next: typeof preferences) => {
    setPreferences(next);
    persistSidebarPurposeSectionPreferences(next);
  };
  // pointerSensor 的 activationConstraint.distance 设为 6px，位移不足 6px 不接管拖拽。
  // 键盘排序走 @dnd-kit 的 sortableKeyboardCoordinates，不自己算落点。
  // sensors 由 useSensors 在首次渲染建一次，之后复用同一实例。
  // useSensors 没有依赖数组，preferences 变化不会重建传感器。
  // PointerSensor 的 distance 约束对触摸与鼠标同一套逻辑，不按输入类型分叉。
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={sectionDragModifiers}
      onDragEnd={({ active, over }) => {
        if (over && active.id !== over.id)
          update({
            ...preferences,
            sectionOrder: reorderSidebarPurposeSections(
              preferences.sectionOrder,
              String(active.id),
              String(over.id),
            ),
          });
      }}
    >
      <SortableContext items={preferences.sectionOrder} strategy={verticalListSortingStrategy}>
        {/* 原因：auto 列被长标题的滚动副本撑宽，溢出检测反复增删副本导致整列闪动；
            单列使用 minmax(0, 1fr)，只由侧栏决定宽度，分页按钮才能稳定居中。 */}
        <div className="grid grid-cols-1 gap-3" data-purpose-section-list="true">
          {preferences.sectionOrder.map((id) => {
            const isProject = id === "projects";
            const title = msg(isProject ? "projects" : "tasks");
            const section = (
              <WorkspacePurposeSection
                sortableId={id}
                title={title}
                dragHandleLabel={intl.formatMessage(
                  { id: "workspaceSidebar.reorderSection" },
                  { section: title },
                )}
                testId={isProject ? "project-section" : "conversation-section"}
                open={isProject ? preferences.projectsExpanded : preferences.conversationsExpanded}
                onOpenChange={(open) =>
                  update({
                    ...preferences,
                    [isProject ? "projectsExpanded" : "conversationsExpanded"]: open,
                  })
                }
                action={
                  <>
                    {isProject && (
                      <ControlHintTooltip
                        title={msg(hasExpandedProjects ? "collapseAll" : "expandAll")}
                      >
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-foreground-subtle hover:text-foreground"
                          data-testid="virtual-project-toggle-all"
                          aria-label={msg(hasExpandedProjects ? "collapseAll" : "expandAll")}
                          disabled={!canToggleProjects}
                          onClick={onToggleProjects}
                        >
                          {hasExpandedProjects ? (
                            <ListChevronsDownUp className="size-3.5" />
                          ) : (
                            <ListChevronsUpDown className="size-3.5" />
                          )}
                        </Button>
                      </ControlHintTooltip>
                    )}
                    <ControlHintTooltip title={msg(isProject ? "new" : "createTask")}>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-foreground-subtle hover:text-foreground"
                        data-testid={isProject ? "virtual-project-add" : "virtual-project-new-task"}
                        aria-label={msg(isProject ? "new" : "createTask")}
                        onClick={isProject ? onAdd : onCreate}
                      >
                        {isProject ? (
                          <Plus className="size-3.5" />
                        ) : (
                          <MessageCirclePlus className="size-3.5" />
                        )}
                      </Button>
                    </ControlHintTooltip>
                  </>
                }
              >
                {isProject ? projects : tasks}
              </WorkspacePurposeSection>
            );
            return <div key={id}>{section}</div>;
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}
