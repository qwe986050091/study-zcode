// INV-01 状态解析 status ?? (completed ? "completed" : "pending") 守住位置：必须早于图标查表与样式查表；改错故障：显式传入 pending 被 completed=true 覆盖，图标与文案自相矛盾。
// INV-02 queueItemIndicatorIconMap 与 queueItemIndicatorClassMap 的键必须覆盖 QueueItemStatus 全部三值 守住位置：两表紧跟状态联合类型定义；改错故障：新增状态只补一张表，查表得到 undefined 导致渲染崩溃或样式丢失。
// INV-03 satisfies Record<QueueItemStatus, typeof CircleIcon> 仅编译期校验，不改变运行时类型 守住位置：必须写在映射对象字面量末尾；改错故障：换成 as 断言会静默放过漏键，漏项推迟到运行时才暴露。
// INV-04 animate-spin 只允许挂在 in_progress 图标 守住位置：IndicatorIcon 的 className 三元分支；改错故障：旋转落到 pending 或 completed，静止项持续重绘并误导当前进度。
// INV-05 QueueItem 的 {...props} 必须展开在 className 之后 守住位置：li 的属性顺序；改错故障：顺序颠倒后调用方传入的 className 无法整体覆盖 cn 合并结果。
// INV-06 QueueItemContent 的 line-clamp-1 与 break-words 必须成对 守住位置：span 的类名首位；改错故障：去掉 break-words 后超长无空格串撑破单行截断并溢出容器。
// INV-07 completed 判定在 Content 与 Description 两处都必须同时给删除线与降透明度 守住位置：各自类名三元表达式；改错故障：只改颜色不改删除线，完成态与禁用态在视觉上无法区分。
// INV-08 QueueItemAction 的 opacity-0 依赖祖先的 group 类 守住位置：QueueItem 根 li 类名首项；改错故障：删掉 group 后操作按钮在任何交互下都不可见，等于功能消失。
// INV-09 QueueItemImage 的 width/height 默认值必须排在 {...props} 之前 守住位置：img 属性书写顺序；改错故障：顺序颠倒会让默认 32 覆盖调用方显式给出的尺寸。
// INV-10 QueueItemImage 的 alt 固定为空串，表示装饰性图片 守住位置：img 的第一个属性；改错故障：改成从 props 透传必填 alt 会让无描述附件缺失可访问名称。
// INV-11 QueueItemFile 的 max-w-[100px] truncate 只作用于内层文本 span 守住位置：与回形针图标的并列层级；改错故障：截断上移到外层会把图标一起吞掉，附件类型不可辨。
// INV-12 QueueList 固定为 ScrollArea → div.max-h-40 → ul 三层 守住位置：高度约束只能落在中间 div；改错故障：ul 直挂 ScrollArea 时列表无上界，长队列把整页顶出视口。
// INV-13 QueueSection 的 defaultOpen 必须声明在 {...props} 之前且默认 true 守住位置：Collapsible 属性书写顺序；改错故障：顺序颠倒后默认值覆盖调用方显式传入的 defaultOpen。
// INV-14 QueueSectionTrigger 的 asChild 必须包住原生 button 而不是额外节点 守住位置：CollapsibleTrigger 的唯一子元素；改错故障：去掉 asChild 多出一层 DOM，group 与 aria 状态挂载点错位。
// INV-15 触发器必须显式 type="button" 且写在 {...props} 之前 守住位置：button 属性尾部；改错故障：置于表单内时默认 submit，点击折叠会提交整个表单。
// INV-16 ChevronDownIcon 的旋转依赖 group-data-[state=closed] 与祖先 group 两个条件 守住位置：icon 的 className；改错故障：任一条件缺失，折叠后箭头不转向且无状态反馈。
// INV-17 QueueSectionLabel 的 count 可选，缺省时不得补 0 守住位置：{count} 与 {label} 的相邻文本节点；改错故障：补默认值 0 会在未知数量时显示误导性计数。
// INV-18 Queue 根容器只承担布局与视觉外壳，不持有展开或选中状态 守住位置：Queue 仅透传 className 与 props；改错故障：在根上收拢 Section 展开态会让所有分组共享同一开关。
//
// 模块职责：提供聊天队列的展示原子组件——条目、状态指示、内容与描述、操作、附件、可折叠分组与列表容器，全部为无状态展示层。
// 状态所有权：展开态归 Collapsible 内部，进行中动画由 status 派生，本文件不持有任何状态值与副作用。
// 阅读顺序：先读状态类型与两张映射表，再读 QueueItemIndicator 的解析优先级，最后按 Queue、QueueSection、QueueList 自上而下看组合。
/*
 * Derived from vercel/ai-elements (packages/elements/src/queue.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import { Button } from "../ui/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible.js";
import { ScrollArea } from "../ui/scroll-area.js";
import { cn } from "../lib/utils.js";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleIcon,
  LoaderIcon,
  PaperclipIcon,
} from "lucide-react";
import type { ComponentProps } from "react";

// parts 以 type 作为判别字段，text/url/filename/mediaType 全为可选，渲染方必须按 type 分派后再取字段。
// 新增 part 种类时只能在语义上扩展，不得给既有字段赋予新含义，否则历史消息会渲染成错误形态。
// 缺失字段时回退到空串而不是抛错：队列允许部分损坏的 part 继续展示。
export interface QueueMessagePart {
  type: string;
  text?: string;
  url?: string;
  filename?: string;
  mediaType?: string;
}

// id 是列表渲染的稳定键，必须由上游消息源提供且在一次会话内保持不变。
// parts 顺序即渲染顺序，本层不做重排，交换顺序会直接改变附件与文本的呈现次序。
// 空 parts 的消息仍应渲染条目骨架，用于占位尚未到达的流式内容。
export interface QueueMessage {
  id: string;
  parts: QueueMessagePart[];
}

// status 可选，缺省时由消费组件退化为 pending，因此新增待办不必显式写入初始状态。
// title 必填且用于单行截断展示，长度不受约束，超长文本由样式裁剪而非数据层收敛。
// id 与 QueueMessage 的 id 属于不同命名空间，同一队列内混用会破坏键唯一性。
export interface QueueTodo {
  id: string;
  title: string;
  description?: string;
  status?: QueueItemStatus;
}

export type QueueItemStatus = "pending" | "in_progress" | "completed";

export type QueueItemProps = ComponentProps<"li">;

export const QueueItem = ({ className, ...props }: QueueItemProps) => (
  <li
    className={cn(
      "group flex flex-col gap-1 rounded-md px-3 py-1 text-ui-base transition-colors hover:bg-muted",
      className,
    )}
    {...props}
  />
);

export type QueueItemIndicatorProps = ComponentProps<"span"> & {
  status?: QueueItemStatus;
  completed?: boolean;
};

// 三张键与 QueueItemStatus 的三值严格对齐，新增状态必须同时补齐图标表与样式表。
// 图标组件本身不带尺寸，尺寸由调用处 className 统一给出，避免两处各写一份。
// 映射是模块级常量，不在渲染期重建，保证同一状态取到的图标引用稳定。
const queueItemIndicatorIconMap = {
  pending: CircleIcon,
  in_progress: LoaderIcon,
  completed: CheckCircle2Icon,
} satisfies Record<QueueItemStatus, typeof CircleIcon>;

const queueItemIndicatorClassMap: Record<QueueItemStatus, string> = {
  pending: "text-muted-foreground/70",
  in_progress: "text-blue-500",
  completed: "text-green-500",
};

// status 优先于 completed：显式状态一旦给出，旧布尔入参不再参与判定，保证迁移期两种写法不互相污染。
// 解析结果先落到 resolvedStatus 再查表，任何分支都不得跳过这一步直接读入参。
// 图标与颜色共用同一个 resolvedStatus，防止图标显示完成而颜色仍是进行中。
// span 追加 mt-0.5 与 shrink-0，保证在 flex 行内不被压缩且与首行文本视觉对齐。
export const QueueItemIndicator = ({
  status,
  completed = false,
  className,
  ...props
}: QueueItemIndicatorProps) => {
  const resolvedStatus = status ?? (completed ? "completed" : "pending");
  const IndicatorIcon = queueItemIndicatorIconMap[resolvedStatus];

  return (
    <span
      className={cn(
        "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center",
        queueItemIndicatorClassMap[resolvedStatus],
        className,
      )}
      {...props}
    >
      {/* 原来只靠圆点颜色区分状态，计划里“进行中”和“未开始”很难一眼看出来；改成图标后再让进行中旋转，状态识别更直接。*/}
      <IndicatorIcon
        className={cn("size-4", resolvedStatus === "in_progress" ? "animate-spin" : undefined)}
      />
    </span>
  );
};

export type QueueItemContentProps = ComponentProps<"span"> & {
  completed?: boolean;
};

// completed 只影响文本装饰，不改变可点击性，条目是否可操作由外层决定。
// line-clamp-1 与 grow 同时存在：内容占满剩余宽度，超出一行即省略。
// className 作为 cn 的最后一参，调用方定制可覆盖默认字色但保留截断。
export const QueueItemContent = ({
  completed = false,
  className,
  ...props
}: QueueItemContentProps) => (
  <span
    className={cn(
      "line-clamp-1 grow break-words",
      completed ? "text-muted-foreground/50 line-through" : "text-muted-foreground",
      className,
    )}
    {...props}
  />
);

export type QueueItemDescriptionProps = ComponentProps<"div"> & {
  completed?: boolean;
};

export const QueueItemDescription = ({
  completed = false,
  className,
  ...props
}: QueueItemDescriptionProps) => (
  <div
    className={cn(
      "ml-6 text-ui-base",
      completed ? "text-muted-foreground/40 line-through" : "text-muted-foreground",
      className,
    )}
    {...props}
  />
);

export type QueueItemActionsProps = ComponentProps<"div">;

export const QueueItemActions = ({ className, ...props }: QueueItemActionsProps) => (
  <div className={cn("flex gap-1", className)} {...props} />
);

export type QueueItemActionProps = Omit<ComponentProps<typeof Button>, "variant" | "size">;

export const QueueItemAction = ({ className, ...props }: QueueItemActionProps) => (
  <Button
    className={cn(
      "size-auto rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted-foreground/10 hover:text-foreground group-hover:opacity-100",
      className,
    )}
    size="icon"
    type="button"
    variant="ghost"
    {...props}
  />
);

export type QueueItemAttachmentProps = ComponentProps<"div">;

export const QueueItemAttachment = ({ className, ...props }: QueueItemAttachmentProps) => (
  <div className={cn("mt-1 flex flex-wrap gap-2", className)} {...props} />
);

export type QueueItemImageProps = ComponentProps<"img">;

export const QueueItemImage = ({ className, ...props }: QueueItemImageProps) => (
  <img
    alt=""
    className={cn("h-8 w-8 rounded border object-cover", className)}
    height={32}
    width={32}
    {...props}
  />
);

export type QueueItemFileProps = ComponentProps<"span">;

// 外层 span 承担边框与底色，内层 span 单独承载截断，两层职责不可合并。
// 回形针图标尺寸固定 12，跟随文本基线，不随附件名长度变化。
// children 被限制在 100px 内，长文件名只显示前缀，完整名称需由额外属性补充。
export const QueueItemFile = ({ children, className, ...props }: QueueItemFileProps) => (
  <span
    className={cn(
      "flex items-center gap-1 rounded border bg-muted px-2 py-1 text-ui-base",
      className,
    )}
    {...props}
  >
    <PaperclipIcon size={12} />
    <span className="max-w-[100px] truncate">{children}</span>
  </span>
);

export type QueueListProps = ComponentProps<typeof ScrollArea>;

// 高度约束落在中间 div 的 max-h-40，滚动由外层 ScrollArea 提供，二者缺一不可。
// ul 必须存在以保持列表语义，children 通常是 QueueItem 的集合。
// className 透传给 ScrollArea 而非内层 div，调用方调整的是滚动容器本身。
export const QueueList = ({ children, className, ...props }: QueueListProps) => (
  <ScrollArea className={cn("", className)} {...props}>
    <div className="max-h-40">
      <ul>{children}</ul>
    </div>
  </ScrollArea>
);

// QueueSection - collapsible section container
export type QueueSectionProps = ComponentProps<typeof Collapsible>;

// 默认展开，队列分组首次出现即可见，收起是用户显式动作而非初始态。
// 展开状态完全由 Collapsible 内部管理，本组件不接收受控 open，避免出现两份真值。
// defaultOpen 写在展开之前，调用方仍可用同名属性覆盖默认行为。
export const QueueSection = ({ className, defaultOpen = true, ...props }: QueueSectionProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
);

// QueueSectionTrigger - section header/trigger
export type QueueSectionTriggerProps = ComponentProps<"button">;

// asChild 让 CollapsibleTrigger 把展开状态与点击行为注入真实 button，不额外产生包裹节点。
// 按钮类型固定为 button，避免嵌套在表单中时点击头部触发提交。
// button 铺满整行并使用 text-left，保证长标题不居中且点击热区覆盖整个分组头。
export const QueueSectionTrigger = ({
  children,
  className,
  ...props
}: QueueSectionTriggerProps) => (
  <CollapsibleTrigger asChild>
    <button
      className={cn(
        "group flex w-full items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-left font-medium text-muted-foreground text-ui-base transition-colors hover:bg-muted",
        className,
      )}
      type="button"
      {...props}
    >
      {children}
    </button>
  </CollapsibleTrigger>
);

// QueueSectionLabel - label content with icon and count
export type QueueSectionLabelProps = ComponentProps<"span"> & {
  count?: number;
  label: string;
  icon?: React.ReactNode;
};

// count 与 label 拼接为同一文本流，中间固定一个空格，数量缺省时该位置为空。
// 箭头旋转由祖先的 data-state 驱动，group 类必须出现在触发器上层，否则选择器不生效。
// icon 作为可选插槽位于箭头与文案之间，传空时不留占位空隙。
// 箭头尺寸与 icon 同为 size-4，视觉重量一致，避免标签行出现高低不齐。
export const QueueSectionLabel = ({
  count,
  label,
  icon,
  className,
  ...props
}: QueueSectionLabelProps) => (
  <span className={cn("flex items-center gap-2", className)} {...props}>
    <ChevronDownIcon className="size-4 transition-transform group-data-[state=closed]:-rotate-90" />
    {icon}
    <span>
      {count} {label}
    </span>
  </span>
);

// QueueSectionContent - collapsible content area
export type QueueSectionContentProps = ComponentProps<typeof CollapsibleContent>;

export const QueueSectionContent = ({ className, ...props }: QueueSectionContentProps) => (
  <CollapsibleContent className={cn(className)} {...props} />
);

export type QueueProps = ComponentProps<"div">;

// 根容器只提供圆角描边与纵向间距，不含列表或折叠逻辑，组合关系由调用方决定。
// `Queue` 根容器用 `pt-2 pb-2` 小于 `px-3`：分组标题自带行高，贴边后不会显得拥挤。
// className 透传到最后，调用方可整体替换主题背景但不影响内部布局。
export const Queue = ({ className, ...props }: QueueProps) => (
  <div
    className={cn(
      "flex flex-col gap-2 rounded-xl border border-border bg-background px-3 pt-2 pb-2 shadow-xs",
      className,
    )}
    {...props}
  />
);
