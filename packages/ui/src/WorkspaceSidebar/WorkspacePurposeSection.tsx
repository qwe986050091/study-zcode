// INV-01 落点蓝线由排序状态派生：守住位置 三元链；改错故障 拖动时看不到落点。
// INV-02 正在拖动的项不画蓝线：守住位置 拖动判断；改错故障 自己身上出现落点。
// INV-03 落点方向看索引关系：守住位置 索引比较；改错故障 蓝线永远在上方。
// INV-04 蓝线层级高于拖动项：守住位置 层级数值；改错故障 蓝线被拖动项遮住。
// INV-05 拖动项半透明：守住位置 透明度值；改错故障 拖动时看不出正在移动。
// INV-06 缩放只取位移：守住位置 变换参数；改错故障 拖动项被拉伸变形。
// INV-07 分区整块可作拖动节点：守住位置 节点引用；改错故障 只有把手能拖。
// INV-08 把手承载拖拽语义：守住位置 属性与监听；改错故障 键盘无法移动分区。
// INV-09 拖拽把手带无障碍说明：守住位置 说明属性；改错故障 读屏不知道这是把手。
// INV-10 折叠开关由调用方持有：守住位置 受控属性；改错故障 分区自行展开。
// INV-11 展开与收起图标不同：守住位置 条件渲染；改错故障 箭头方向与实际状态不符。
// INV-12 图标对读屏隐藏：守住位置 隐藏属性；改错故障 标题后重复朗读箭头。
// INV-13 操作区悬停才显示：守住位置 透明度类；改错故障 每个分区都常驻按钮。
// INV-14 触屏设备常显操作区：守住位置 媒体查询类；改错故障 手机上没有悬停入口。
// INV-15 操作区展开时也常显：守住位置 状态选择器；改错故障 展开后按钮又消失。
// INV-16 嵌套分区额外缩进：守住位置 类名合并；改错故障 子分区与父分区齐平。
// INV-17 分区以标题作无障碍名：守住位置 标签属性；改错故障 读屏只念分组。
// INV-18 分区带测试标识：守住位置 数据属性；改错故障 端到端测试无法定位分区。
//
// 模块职责：工作区侧栏里可折叠、可排序的分区外壳。
// 状态所有权：折叠开关由调用方持有，排序状态来自排序 hook。
// 阅读顺序：先看排序派生，再看行内样式，最后看分区骨架。
import type { CSSProperties, ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";

// 整个 section 作为 useSortable 的拖动节点，setNodeRef 挂在根元素。
// open 与 onOpenChange 完全受控，组件不保存折叠状态。
// inset 参数决定是否额外缩进，表达嵌套层级。
export function WorkspacePurposeSection({
  title,
  open,
  onOpenChange,
  action,
  children,
  testId,
  sortableId,
  dragHandleLabel,
  inset = false,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: ReactNode;
  children: ReactNode;
  testId: string;
  sortableId: string;
  dragHandleLabel: string;
  inset?: boolean;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    active,
    activeIndex,
    index,
    isOver,
  } = useSortable({ id: sortableId });
  // 原因：分区原来只有位移动画，无法判断落点；与项目行一样从同一排序状态派生蓝线。
  // dropPosition 仅在 isOver 且非 isDragging 时计算落点。
  // 方向由 activeIndex 与 index 的先后决定：前者大则 before。
  // 落点项 zIndex 取 20，高于拖动项的 10，保证蓝线压在上层。
  const dropPosition =
    isOver && active && !isDragging && activeIndex >= 0
      ? activeIndex > index
        ? "before"
        : "after"
      : null;
  // CSS.Transform.toString() 把 scaleX/scaleY 置 1，变换只保留位移。
  // isDragging 时 opacity 取 0.85，拖动项半透明。
  // dropPosition 非空时 zIndex 取 20，抬高落点项层级。
  // 既非拖动也非落点时 zIndex 为 undefined，不写层级。
  const style: CSSProperties = {
    transform: transform
      ? CSS.Transform.toString({ ...transform, scaleX: 1, scaleY: 1 })
      : undefined,
    transition,
    zIndex: dropPosition ? 20 : isDragging ? 10 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  // 蓝线按 dropPosition 落在 before/after 侧对齐。
  // 操作区默认隐藏，hover 时才显示。
  // 触屏设备与展开态下操作区常显，不依赖 hover。
  // inset 为 true 的嵌套分区额外缩进。
  return (
    <section
      ref={setNodeRef}
      style={style}
      data-testid={testId}
      data-source-hierarchy-children={inset ? "true" : undefined}
      aria-label={title}
      className={cn("group/purpose-section relative min-w-0", inset && "ml-6 mr-1")}
    >
      {dropPosition && (
        <div
          aria-hidden="true"
          data-testid="purpose-section-drop-indicator"
          data-drop-position={dropPosition}
          className={`pointer-events-none absolute left-5 right-2 z-20 h-0.5 bg-icon-blue ${dropPosition === "before" ? "top-0 -translate-y-1/2" : "bottom-0 translate-y-1/2"}`}
        >
          <span className="absolute -left-1 top-1/2 size-2 -translate-y-1/2 rounded-full border-2 border-icon-blue bg-sidebar" />
        </div>
      )}
      <Collapsible open={open} onOpenChange={onOpenChange}>
        {/* 原因：右侧 margin 与 action padding 叠加，多出 10px；与项目行统一保留 4px。 */}
        <div className="ml-2 mr-1 flex h-7 min-w-0 items-center">
          <CollapsibleTrigger asChild>
            {/* purpose 分组标题之前使用 13px，比同级“已置顶”更小。
                这里统一为 section title 的 text-ui-base，避免可折叠能力改变标题层级。 */}
            <button
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              type="button"
              aria-description={dragHandleLabel}
              data-purpose-section-drag-trigger={sortableId}
              className="flex h-7 min-w-0 flex-1 touch-none items-center gap-1 px-2.5 text-left text-ui-base font-medium text-foreground-subtlest outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              <span className="min-w-0 truncate">{title}</span>
              {open ? (
                <ChevronDown
                  aria-hidden="true"
                  data-purpose-section-chevron="expanded"
                  className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/purpose-section:opacity-100 group-focus-within/purpose-section:opacity-100 [@media(hover:none)]:opacity-100"
                />
              ) : (
                <ChevronRight
                  aria-hidden="true"
                  data-purpose-section-chevron="collapsed"
                  className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/purpose-section:opacity-100 group-focus-within/purpose-section:opacity-100 [@media(hover:none)]:opacity-100"
                />
              )}
            </button>
          </CollapsibleTrigger>
          <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/purpose-section:opacity-100 group-focus-within/purpose-section:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-100">
            {action}
          </div>
        </div>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Collapsible>
    </section>
  );
}
