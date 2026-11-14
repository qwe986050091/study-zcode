// INV-01 重排只走数组移动：守住位置 纯函数；改错故障 调用方收到被改写的原数组。
// INV-02 未知标识原样返回：守住位置 索引判断；改错故障 非法拖拽清空列表。
// INV-03 同位置不移动：守住位置 相等判断；改错故障 无意义更新触发保存。
// INV-04 交互控件不启动拖拽：守住位置 选择器；改错故障 点按钮变成拖动。
// INV-05 弹窗内容不启动拖拽：守住位置 选择器扩展；改错故障 弹窗内滑动拖走模型行。
// INV-06 拖动行透明边框占位：守住位置 类名分支；改错故障 行高抖动。
// INV-07 拖动中浮起：守住位置 条件类名；改错故障 被拖行压在邻居下。
// INV-08 末行无分隔线：守住位置 末行判断；改错故障 列表底部多一条线。
// INV-09 拖拽标签走国际化：守住位置 文案读取；改错故障 出现硬编码英文。
// INV-10 键盘排序复用同一隔离：守住位置 键盘分支；改错故障 输入框空格被拖拽吞掉。
// INV-11 拖拽激活需位移阈值：守住位置 传感器配置；改错故障 轻点即进入拖拽。
// INV-12 指针与键盘双传感器：守住位置 传感器数组；改错故障 无鼠标用户无法排序。
// INV-13 可排序集合可裁剪：守住位置 集合判断；改错故障 固定行被拖动。
// INV-14 不可排序行仍渲染：守住位置 三元分支；改错故障 固定行从列表消失。
// INV-15 无回调时纯展示：守住位置 早退；改错故障 只读列表也挂拖拽上下文。
// INV-16 拖拽结束无目标即忽略：守住位置 空值判断；改错故障 列表被重排成空序。
// INV-17 排序上下文只含可排序项：守住位置 标识展开；改错故障 拖拽命中不可排序行。
// INV-18 列表标识保持稳定：守住位置 行键；改错故障 重排后组件状态错位。
//
// 模块职责：模型 Provider 的模型顺序拖拽列表与纯函数重排。
// 状态所有权：拖拽过程归排序库，最终顺序由调用方回调落库。
// 阅读顺序：先看重排纯函数，再看拖拽目标隔离，最后看列表装配。
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// activeIndex 或 overIndex 为负时原样返回 [...modelIds]，非法拖拽不清空列表。
// activeIndex === overIndex 时同样早退，同位置不产生新数组。
// 先复制 params.modelIds 再交给 arrayMove，不改调用方数组。
// 返回全新数组，调用方可直接比较引用判断变化。
// resolveReorderedModelIds 是纯函数，无副作用也不写外部状态。
export function resolveReorderedModelIds(params: {
  activeModelId: string;
  overModelId: string;
  modelIds: readonly string[];
}): string[] {
  const activeIndex = params.modelIds.indexOf(params.activeModelId);
  const overIndex = params.modelIds.indexOf(params.overModelId);
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) {
    return [...params.modelIds];
  }
  return arrayMove([...params.modelIds], activeIndex, overIndex);
}

// ModelRowPointerSensor 重写 activators，指针按下先判目标。
// isInteractiveModelDragTarget 为真时不激活拖拽。
// activators 是静态字段，键盘传感器可复用同一判据。
// handler 只返回布尔值，不调用 preventDefault 吞掉输入。
// 位移阈值交给 useSensor 的 activationConstraint，不写在这里。
class ModelRowPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent }: ReactPointerEvent) =>
        !isInteractiveModelDragTarget(nativeEvent.target),
    },
  ];
}

// target 不是 Element 时直接返回 false。
// target.closest 的选择器覆盖 button 与 input 等交互控件。
// contenteditable 选择器排除可编辑区域，输入法不被打断。
// data-no-model-drag 是显式标记，优先级高于普通行。
// data-slot=dialog-content 让弹窗内容不参与拖拽。
export function isInteractiveModelDragTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      "button, input, textarea, select, a, [contenteditable]:not([contenteditable=false]), [data-no-model-drag], [data-slot=dialog-content], [data-slot=dialog-overlay]",
    ) !== null
  );
}

export function resolveSortableProviderModelRowClassName({
  isDragging,
  isLast,
}: {
  isDragging: boolean;
  isLast: boolean;
}): string {
  // 拖动状态沿用了普通行的可见底部分隔线，浮起后看起来像带下划线。
  // 透明边框保留既有的 1px 占位，避免切换拖动状态时行高抖动。
  const dividerClassName = isDragging
    ? "border-b border-transparent"
    : isLast
      ? "border-b-0"
      : "border-b border-input-border";
  return `min-w-0 cursor-grab touch-pan-y select-none active:cursor-grabbing ${dividerClassName} ${isDragging ? "relative z-10 bg-card shadow-md" : ""}`;
}

// SortableProviderModelRow 的 key 与 useSortable 的 id 都取 modelId。
// dragLabel 走 intl.formatMessage，不硬编码英文。
// onKeyDown 先过 isInteractiveModelDragTarget，再转给 listeners。
// transform 与 transition 来自 useSortable，本组件不自己算。
// isDragging 时叠加 relative z-10 与 shadow-md，被拖行浮在邻居之上。
// isLast 为真时类名为 border-b-0，列表底部不画分隔线。
function SortableProviderModelRow({
  modelId,
  children,
  isLast,
}: {
  modelId: string;
  children: ReactNode;
  isLast: boolean;
}) {
  const { intl } = useZCodeIntl();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: modelId,
  });
  const dragLabel = intl.formatMessage({
    id: "settings.modelProvider.reorderModel",
  });
  return (
    <div
      ref={setNodeRef}
      data-model-provider-model-id={modelId}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={resolveSortableProviderModelRowClassName({ isDragging, isLast })}
      aria-label={dragLabel}
      title={dragLabel}
      {...attributes}
      {...listeners}
      onKeyDown={(event) => {
        // Portal 弹窗的空格会冒泡到模型行，启动键盘排序并抢先写入版本。
        // 复用指针的交互目标隔离；不阻止输入默认行为，行自身仍交给原键盘传感器。
        if (!isInteractiveModelDragTarget(event.target)) listeners?.onKeyDown?.(event);
      }}
    >
      {/* Bug 原因：useSortable 会给本行添加 role=button。旧传感器把最近的
          [role=button] 当成交互控件，导致从模型名称或空白处永远无法启动拖拽。 */}
      {children}
    </div>
  );
}

export function SortableProviderModelList({
  modelIds,
  sortableModelIds,
  onReorder,
  renderModel,
}: {
  modelIds: readonly string[];
  sortableModelIds?: readonly string[];
  onReorder?: (modelIds: string[]) => void;
  renderModel: (modelId: string, index: number) => ReactNode;
}) {
  const sensors = useSensors(
    useSensor(ModelRowPointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const sortableIds = sortableModelIds ?? modelIds;
  const sortableSet = new Set(sortableIds);
  const content = modelIds.map((modelId, index) => {
    const row = renderModel(modelId, index);
    const isLast = index === modelIds.length - 1;
    return onReorder && sortableSet.has(modelId) ? (
      <SortableProviderModelRow key={modelId} modelId={modelId} isLast={isLast}>
        {row}
      </SortableProviderModelRow>
    ) : (
      <div key={modelId} className={isLast ? "border-b-0" : "border-b border-input-border"}>
        {row}
      </div>
    );
  });
  if (!onReorder) return content;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={(event: DragEndEvent) => {
        if (!event.over) return;
        onReorder(
          resolveReorderedModelIds({
            activeModelId: String(event.active.id),
            overModelId: String(event.over.id),
            modelIds,
          }),
        );
      }}
    >
      <SortableContext items={[...sortableIds]} strategy={verticalListSortingStrategy}>
        {content}
      </SortableContext>
    </DndContext>
  );
}
