// INV-01 [权衡] 首行指令必须留在文件第一行且之上再无内容；守住位置：文件首行的 "use client" 与下方全部组件；改错故障：RSC 构建把它当服务端模块，Portal 与事件处理器在渲染期直接报错。
// INV-02 [契约] Radix 入口以 Select 别名整包导入；守住位置：from "radix-ui" 的解构与全文 SelectPrimitive 前缀；改错故障：换成默认导入或命名空间后类型与包装名分叉，二次封装处引用失效。
// INV-03 [契约] 每个包装都必须自带 data-slot 常量；守住位置：Root、Group、Value、Trigger、Content、Label、Item、Separator 与两个滚动按钮；改错故障：按 data-slot 写的全局选择器失配，下拉退化成无边框无内距的裸元素。
// INV-04 [权衡] 触发器只过渡颜色，禁止 transition-all；守住位置：selectTriggerVariants 基础串里的 transition-colors 与上方中文注释；改错故障：大会话 resize 时批量重排被动画化，控件抖动并拖慢滚动。
// INV-05 [契约] variant 默认 input、size 默认 default 必须在两处同值；守住位置：defaultVariants 与 SelectTrigger 的形参默认值；改错故障：两处漂移后无参调用与显式传值渲染出不同高度。
// INV-06 [事务] cva 只产出 class 串，不携带任何运行时状态；守住位置：六档 variant 与四档 size 的取值表；改错故障：把打开态或选中态写进变体，data-state 与真实外观从此不一致。
// INV-07 [契约] data-variant 与 data-size 是外部样式和测试的稳定钩子；守住位置：SelectTrigger 上两个 data-* 属性与 data-slot；改错故障：属性选择器定制与快照断言同时落空，只能靠类名猜样式。
// INV-08 [资源] 触发器图标只能经 Icon asChild 注入；守住位置：indicator 回落到 ChevronDownIcon 的那个分支；改错故障：多包一层元素破坏 asChild 单子节点约束，图标尺寸规则失效并出现重复箭头。
// INV-09 [失败路径] 长文本靠 select-value 的 data-slot 做单行裁剪；守住位置：基础串里 *:data-[slot=select-value]:line-clamp-1 三个派生规则；改错故障：长选项撑破 w-fit，工具栏整体换行。
// INV-10 [资源] 菜单层级固定为 z-[60]，必须压过 z-50 的提示浮层；守住位置：SelectContent 类串首段的 z-[60] 与相邻中文注释；改错故障：tooltip 盖住选项，item-aligned 模式下无法点选。
// INV-11 [事务] item-aligned 与 popper 共用同一外壳，只靠布尔派生样式；守住位置：data-align-trigger 取 position 比较值；改错故障：把布尔换成字符串后 animate-none 分支失效，贴触发器时位移动画打架。
// INV-12 [资源] popper 模式下 Viewport 只对齐宽度，绝不锁高度；守住位置：data-[position=popper] 的 w-full 与 min-w 两条规则；改错故障：菜单可视区被压成一行，其余选项滚不到也点不到。
// INV-13 [顺序] 上下滚动按钮必须夹在 Viewport 前后两侧；守住位置：Content 子节点中 ScrollUpButton、Viewport、ScrollDownButton 的三段顺序；改错故障：Radix 找不到滚动锚点，边缘按钮点击无反应。
// INV-14 [资源] 菜单必须走 Portal，且外壳保留 no-drag 区域声明；守住位置：SelectPrimitive.Portal 包裹与类串末段 [app-region:no-drag]；改错故障：被父级 overflow 裁切，桌面端点击还会被窗口拖拽区吞掉。
// INV-15 [事务] SelectItem 右侧只有一个绝对定位槽位，trailing 与对勾共用；守住位置：两个 right-2 的 span 及其 pointer-events 设定；改错故障：trailing 挡住对勾或吞掉点击，选中态与快捷键提示互相覆盖。
// INV-16 [契约] 普通选项的 children 只能进 ItemText；守住位置：SelectItem 内 ItemText 的唯一包裹点；改错故障：把说明塞进 ItemText 后整段回显到触发器，控件被撑高。
// INV-17 [契约] 富选项只有 title 进 ItemText，其余三个槽位留在外层；守住位置：SelectRichItem 中 ItemText 只包 title 的那一行；改错故障：触发器显示「默认」标记或第二行说明，版式错乱。
// INV-18 [权衡] 富选项复用 select-item 的 data-slot 并对齐对勾坐标；守住位置：SelectRichItem 的 data-slot 与 top-2.5 right-2 的 span；改错故障：两种选项无法共用样式，混排时对勾上下跳动。
//
// 模块职责：Select 组件族的 Radix 包装层，统一 data-slot 契约、cva 外观变体、Portal 定位与选项内文分流。
// 状态所有权：选中值、打开态、高亮项都由 Radix Root 持有；本文件只透传 props 并补齐样式与结构。
// 阅读顺序：先看 selectTriggerVariants 与 SelectTrigger，再看 SelectContent 的定位分支，最后看两种 Item 的文本分流。
"use client";

import * as React from "react";
import { Select as SelectPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.js";
import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from "lucide-react";

// resize 大会话时 Select trigger 跟随基础控件批量重排，
// transition-all 会把布局/滚动条相关属性也动画化；这里限定为颜色过渡。
// [契约] 六档 variant 只负责颜色与边框，高度一律交给 size 维度，混写会让同一控件出现两套尺寸语义。
// [契约] input 是默认外观，default 反而承载实心主按钮样式，命名与直觉相反，调用方须显式区分。
// [失败路径] aria-expanded 打开态反馈只给 outline、secondary、ghost、destructive，input 走 focus-visible 分支。
// [并发] 打开态样式由 Radix 写入的 data-state 派生，变体表本身不保存任何运行时状态。
// [资源] size 四档从 h-5 到 h-8，图标尺寸随档位收紧，新增档位必须同时补 svg 尺寸规则。
// [权衡] 触发器内的文本裁剪靠 *:data-[slot=select-value] 派生，不加包裹层，少一层 DOM 换一套规则。
// [契约] cn 在调用处合并，className 始终排在变体之后，调用方覆盖默认样式无需提高优先级。
const selectTriggerVariants = cva(
  "flex w-fit items-center justify-between gap-1.5 border whitespace-nowrap transition-colors outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 data-placeholder:text-foreground-subtlest *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        input:
          "border-input-border bg-input text-foreground hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0",
        default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-transparent text-foreground hover:bg-input/50 hover:text-foreground aria-expanded:bg-selected aria-expanded:text-foreground",
        secondary:
          "border-transparent bg-secondary text-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-foreground",
        ghost:
          "border-transparent bg-transparent text-foreground hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 aria-expanded:bg-destructive aria-expanded:text-destructive-foreground",
      },
      size: {
        xs: "h-5 rounded-sm pl-2 pr-1 text-ui-base [&_svg:not([class*='size-'])]:size-2.5",
        sm: "h-6 rounded-md pl-2 pr-1 text-ui-base/relaxed [&_svg:not([class*='size-'])]:size-3",
        default:
          "h-7 rounded-md pl-2 pr-1 text-ui-base/relaxed [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-8 rounded-lg pl-3 pr-2 text-ui-base [&_svg:not([class*='size-'])]:size-4",
      },
    },
    defaultVariants: {
      variant: "input",
      size: "default",
    },
  },
);

// [契约] Root、Group、Value 三个包装只补 data-slot 再原样透传，不新增受控状态。
// [状态] 选中值与打开态都由 Root 持有，受控与否完全取决于调用方是否传 value。
// [事务] 占位文案依赖 Radix 判定的 data-placeholder，无选中值时触发器才显示提示文字。
// [资源] Group 的 p-1 与 gap-0.5 会叠加 Content 的内边距，双层留白会让选项列表显得松散。
// [契约] Group 先把默认间距串与外部 className 合并再展开其余 props，避免整串样式被替换。
// [失败路径] 把 Group 换成普通 div，Label 关联与键盘分组跳转会同时失效。
// 包装保持单行表达式：分支推给调用方后，`Select` 不会在内部替调用方猜测受控或非受控。
function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectGroup({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("flex flex-col gap-0.5 scroll-my-1 p-1", className)}
      {...props}
    />
  );
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

// [契约] variant 与 size 在形参上给默认值，与 defaultVariants 保持同源语义。
// [契约] data-variant 与 data-size 是外部样式与测试的稳定钩子，不随 className 变化。
// [资源] indicator 是可选插槽，默认回落到 ChevronDownIcon，尺寸统一由 [&_svg] 规则约束。
// [失败路径] Icon 必须保持 asChild，多包一层元素会让 Radix 期望的单子节点失效，箭头丢失。
// [事务] children 先于图标渲染，w-fit 让触发器宽度由内容决定而不撑满父容器。
// [契约] disabled 与 aria-invalid 的外观全部在基础串里声明，调用方不重复声明。
// [权衡] 触发器本身不接管指针事件，只把 svg 设为 pointer-events-none，避免点击落在图标上。
function SelectTrigger({
  className,
  variant = "input",
  size = "default",
  children,
  indicator,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> &
  VariantProps<typeof selectTriggerVariants> & {
    indicator?: React.ReactNode;
  }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-variant={variant}
      data-size={size}
      className={cn(selectTriggerVariants({ variant, size }), className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        {indicator ?? (
          <ChevronDownIcon className="pointer-events-none size-3.5 text-foreground-subtle" />
        )}
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

// 圆角规范迁移：旧菜单沿用 xl/lg，统一为独立外壳 lg、内部选项 md；子菜单重新起算。
// [契约] position 默认 item-aligned、align 默认 center，两者直接交给 Radix，不做二次换算。
// [资源] Portal 是硬要求，菜单必须脱离父级 overflow 与层叠上下文，否则会被裁切。
// [事务] data-align-trigger 由 position 求值，驱动 animate-none，防止贴触发器时位移动画重复。
// [资源] 高度上限取自 Radix 的可用高度变量，min-w-32 只兜底，宽度仍由选项内容撑开。
// [失败路径] z-[60] 是对 z-50 提示浮层的显式让位，调低后选项会被 tooltip 盖住。
// [资源] Viewport 的 popper 分支只对齐宽度，高度交给 Content 的 max-height，锁高会压成一行。
// [顺序] 上下滚动按钮分列 Viewport 两侧，Radix 依赖它们挂载以驱动滚动与键盘提示。
function SelectContent({
  className,
  children,
  position = "item-aligned",
  align = "center",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        data-align-trigger={position === "item-aligned"}
        className={cn(
          // 可操作的 Select 必须高于 z-50 tooltip，避免提示遮住选项。
          "relative z-[60] max-h-(--radix-select-content-available-height) min-w-32 origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border border-popover-border bg-menu p-1 text-foreground shadow-md duration-100 data-[align-trigger=true]:animate-none data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 [app-region:no-drag]",
          className,
        )}
        position={position}
        align={align}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          data-position={position}
          className={cn(
            // popper 模式下如果把 viewport 高度锁成 trigger 高度，
            // 会导致菜单可视区域被压成一行，无法完整展开选项。
            // 这里仅保留宽度对齐，交给内容容器的 max-height 控制可视高度。
            // Select 选项过去紧贴排列；在真正承载选项的 viewport 统一保留 2px。
            "flex flex-col gap-0.5 data-[position=popper]:w-full data-[position=popper]:min-w-(--radix-select-trigger-width)",
            position === "popper" && "",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("px-2 py-1.5 text-ui-base text-foreground-subtlest", className)}
      {...props}
    />
  );
}

type SelectItemProps = React.ComponentProps<typeof SelectPrimitive.Item> & {
  trailing?: React.ReactNode;
};

// [事务] forwardRef 把 Radix 聚焦的节点原样交回，包一层 div 会让高亮与滚动定位错位。
// [契约] trailing 是显式可选插槽，仅在其存在时渲染，右侧留给快捷键或徽标。
// [资源] trailing 的 span 用 pointer-events-auto，对勾的 span 用 pointer-events-none，两类点击互不干扰。
// [失败路径] 对勾只在 ItemIndicator 内渲染，选中判定交给 Radix，手写条件会与键盘选择不同步。
// [契约] children 只走 ItemText，这一段同时是触发器回显内容的唯一来源。
// [契约] min-h-7 与 px-2 py-1 定义单行基线，data-[highlighted] 只改底色不改尺寸。
// [权衡] 禁用态保留 opacity-100 而改文字色，以便与整行变淡的禁用按钮区分。
const SelectItem = React.forwardRef<React.ElementRef<typeof SelectPrimitive.Item>, SelectItemProps>(
  ({ className, children, trailing, ...props }, ref) => {
    return (
      <SelectPrimitive.Item
        ref={ref}
        data-slot="select-item"
        className={cn(
          "relative flex min-h-7 w-full cursor-default items-center gap-2 rounded-md px-2 py-1 text-ui-base/relaxed text-foreground outline-hidden select-none data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-disabled:pointer-events-none data-disabled:text-foreground-subtlest data-disabled:opacity-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
          className,
        )}
        {...props}
      >
        {trailing ? (
          <span className="pointer-events-auto absolute right-2 flex items-center justify-center">
            {trailing}
          </span>
        ) : null}
        <span className="pointer-events-none absolute right-2 flex items-center justify-center">
          <SelectPrimitive.ItemIndicator>
            <CheckIcon className="pointer-events-none size-4 text-foreground-subtle" />
          </SelectPrimitive.ItemIndicator>
        </span>
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      </SelectPrimitive.Item>
    );
  },
);

SelectItem.displayName = "SelectItem";

type SelectRichItemProps = Omit<React.ComponentProps<typeof SelectPrimitive.Item>, "children"> & {
  /** 左侧 16–18px 图标。 */
  icon?: React.ReactNode;
  /** 进入 ItemText：触发器（SelectValue）只显示这一段。 */
  title: React.ReactNode;
  /** 标题同一行的标记（例如「默认」），不进触发器。 */
  titleAdornment?: React.ReactNode;
  /** 标题下一行的说明，不进触发器。 */
  description?: React.ReactNode;
};

/**
 * 两行选项：图标 + 标题 + 说明，选中态用尾部对勾（与输入框权限模式菜单同一版式）。
 * 用于选项需要解释后果的设置；列表宜配 `position="popper"`，避免 item-aligned 盖住行标签。
 */
// [契约] 富选项省略 children，只暴露 icon、title、titleAdornment、description 四个语义槽位。
// [契约] ItemText 只包 title，同行标记与下一行说明留在外层，触发器因此只显示标题。
// [资源] 图标槽固定 size-4.5 并用 mt-0.5 对齐首行，标题行 min-w-0 防止长文本溢出。
// [契约] 富选项复用 select-item 的 data-slot，混排时才能共用选择器与主题样式。
// [资源] 对勾的 top-2.5 right-2 对应两行版式，改成 top-2 会在缺说明行时视觉偏下。
// [契约] Separator 与两个滚动按钮各自持有 data-slot，只做底色与 1px 分隔，不承载交互。
// [事务] 导出同时暴露包装组件与 selectTriggerVariants，外部自定义触发器须复用同一变体来源。
const SelectRichItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  SelectRichItemProps
>(({ className, icon, title, titleAdornment, description, ...props }, ref) => {
  return (
    <SelectPrimitive.Item
      ref={ref}
      data-slot="select-item"
      className={cn(
        "relative flex min-h-13 w-full cursor-default items-start gap-3 rounded-md py-2 pr-8 pl-2 text-ui-base text-foreground outline-hidden select-none data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-disabled:pointer-events-none data-disabled:text-foreground-subtlest [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {icon ? (
        <span className="mt-0.5 flex size-4.5 items-center justify-center">{icon}</span>
      ) : null}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <SelectPrimitive.ItemText>{title}</SelectPrimitive.ItemText>
          {titleAdornment}
        </span>
        {description ? (
          <span className="text-ui-sm text-foreground-subtle">{description}</span>
        ) : null}
      </span>
      <span className="pointer-events-none absolute top-2.5 right-2 flex items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="pointer-events-none size-4 text-foreground-subtle" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
});

SelectRichItem.displayName = "SelectRichItem";

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        "z-10 flex cursor-default items-center justify-center bg-menu py-1 text-foreground-subtle [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      <ChevronUpIcon />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        "z-10 flex cursor-default items-center justify-center bg-menu py-1 text-foreground-subtle [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      <ChevronDownIcon />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectRichItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  selectTriggerVariants,
};
