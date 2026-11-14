// 职责边界（dropdown-menu）
// 做：把 Radix 各部件包成带 data-slot、默认值与类名基线的展示壳。
// 做：用一份 className 基线覆盖外壳与条目的圆角、间距、阴影、层级、禁用态与高亮态，不各写一处。
// 不做：不实现开合、焦点陷阱、键盘导航与点击外部关闭，全部交给 Radix。
// 依赖：radix-ui 的 DropdownMenu 原语、lucide 图标、components/lib/utils 的 cn。
// 边界：只透传 props 与合并类名，加逻辑前先确认 Radix 没有等价能力。
//
// INV 不变量表（20 条；每条都是「看起来能改、其实不该动」的约束）
// INV-01 断言：open 的所有权只在调用方或 Radix 内部，本层不留第二份 —— 守住位置：DropdownMenu 的透传 —— 改错故障：受控菜单点选后不关闭，开合状态打架
// INV-02 断言：Content 必须包在 Portal 里 —— 守住位置：DropdownMenuContent 的返回结构 —— 改错故障：侧栏或窗口边缘的菜单被 overflow 裁掉
// INV-03 断言：align 默认 start、sideOffset 默认 2 是本仓约定，Radix 原生是 center 与 0 —— 守住位置：形参解构 —— 改错故障：菜单与触发器错位或紧贴触发器
// INV-04 断言：默认值只能写在解构处，不能在 JSX 里再兜底 —— 守住位置：Content 的属性顺序 —— 改错故障：调用方显式传 0 偏移被默认值反覆盖
// INV-05 断言：类名一律先基线后调用方 —— 守住位置：每个 className 的合并顺序 —— 改错故障：调用方无法用 p-0 或 w-72 覆盖基线样式
// INV-06 断言：宽度不绑触发器宽度变量，只留 min-w-32 与可用宽度上限 —— 守住位置：Content 基础类 —— 改错故障：图标触发器把菜单压到 128px，长文案折行
// INV-07 断言：高度上限用 available-height，且关闭态切 overflow-hidden —— 守住位置：Content 的 max-h 与 data-[state=closed] —— 改错故障：菜单超出视口，关闭动画闪出滚动条
// INV-08 断言：菜单层固定 z-[60] —— 守住位置：Content 与 SubContent 的首个类 —— 改错故障：菜单被 tooltip 或 popover 压在下面
// INV-09 断言：阴影三处都带 important —— 守住位置：基础、focus、focus-visible 的 shadow 声明 —— 改错故障：打开首帧阴影被全局 focus reset 抹掉而闪烁
// INV-10 断言：圆角分两层，外壳 lg、条目 md，子菜单重新起算 —— 守住位置：Content、Item、SubContent —— 改错故障：内外圆角互相打架，与设计规范不符
// INV-11 断言：Trigger 只透传，不注入 type 也不额外包裹 —— 守住位置：DropdownMenuTrigger —— 改错故障：asChild 失效，焦点与 aria-expanded 落到外层节点
// INV-12 断言：禁用只认 Radix 的 data-disabled，键盘导航自动跳过 —— 守住位置：Item、CheckboxItem、RadioItem —— 改错故障：禁用项仍能被上下键选中并回车触发
// INV-13 断言：禁用外观显式写 opacity-100 与最浅前景色 —— 守住位置：data-disabled 组合类 —— 改错故障：若换回半透明禁用惯例，最浅前景色再降透明度会几乎不可读
// INV-14 断言：data-[highlighted] 是鼠标与键盘共用的唯一高亮态 —— 守住位置：所有条目类 —— 改错故障：再写 hover 变体会让两个条目同时高亮
// INV-15 断言：destructive 高亮必须同改底色与前景，图标跟随文字色 —— 守住位置：Item 的 variant 链 —— 改错故障：红底黑字，图标与文字不同色
// INV-16 断言：图标默认 size-4，且不覆盖调用方已给尺寸 —— 守住位置：svg 排除 size- 前缀的选择器 —— 改错故障：自定义图标被强制缩放，或 pointer-events 吃掉点击
// INV-17 断言：勾选指示器绝对定位，并在右侧预留空间 —— 守住位置：indicator 的 span 与 pr-8 —— 改错故障：勾出现时文字位移，长文案与勾重叠
// INV-18 断言：inset 只加左侧内边距，让无图标条目与有图标条目的文字同列 —— 守住位置：data-inset 的 pl 声明 —— 改错故障：两类条目文字明显错位
// INV-19 断言：Shortcut 颜色靠父条目的命名组切换 —— 守住位置：group-data-[highlighted] 选择器 —— 改错故障：条目高亮时快捷键提示仍然发灰
// INV-20 断言：SubTrigger 的 open 与 highlighted 同色，指示器用空值合并回退 —— 守住位置：indicator 分支 —— 改错故障：子菜单展开时父项掉色，或自定义指示器被默认箭头顶掉
//
// 总述：收益都在类名与默认值上，逻辑一律交给 Radix，不在本层补状态。
// 总述：新增部件保持同一形状，data-slot、逐字透传 props、className 交给 cn。
// 总述：改类名前先确认它守的是哪条 INV，宽度、层级、阴影三处都踩过坑。
//
import * as React from "react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { CheckIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "../lib/utils.js";

// [状态] open 归调用方：受控传 open 与 onOpenChange，不受控靠 defaultOpen，本层不留副本。
// [权衡] 不支持受控与非受控中途互换，那会让 Radix 丢弃内部状态，菜单突然弹回。
function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

// [层级] 默认挂到 body，脱离父级 overflow 与 transform 的层叠上下文。
// [失败路径] 自行传 container 会换掉层级参考系，z-[60] 只在 body 顶层成立。
function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

// [契约] 只做透传，aria-haspopup 与 aria-expanded 由 Radix 写在合成后的元素上。
// [焦点] 与 Button 走 asChild 合成单一元素，外面不要再包 Tooltip，否则关闭后焦点回不到按钮。
// [失败路径] 自行注入 type 会覆盖调用方的提交语义，这里不做任何属性补丁。
function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

// 圆角规范迁移：旧菜单沿用 xl/lg，统一为独立外壳 lg、内部选项 md；子菜单重新起算。
// [默认值] sideOffset 默认 2、align 默认 start 都在形参解构处给，Radix 原生是 0 与 center。
// [契约] 显式传 0 偏移必须生效，所以 JSX 里不能再写兜底默认。
// [样式] className 由 cn 合并到基线之后，调用方的 p-0、w-72 才能压掉 p-1 与 min-w-32。
function DropdownMenuContent({
  className,
  align = "start",
  sideOffset = 2,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        align={align}
        className={cn(
          // 共享菜单栈需要行距，且与 tooltip 同层时不能被辅助提示覆盖。
          // 菜单刚打开时根节点持有焦点；全局 focus reset 会清除普通 shadow-md，
          // 因此用 important focus 声明保证阴影从首帧到 item hover 始终一致。
          // 宽度不能用 w-(...) 绑定触发器宽度变量 --radix-dropdown-menu-trigger-width：图标按钮触发器只有
          // ~28px，实际宽度被 min-w-32 卡死在 128px，「恢复 User 默认」等较长菜单项被迫折行，
          // 全仓 40+ 处调用因此各自传 w-*/min-w-* 兜底。菜单不是 Select，宽度应按内容撑开
          // （Radix popper 外层是 min-width:max-content），只保留 min-w-32 下限，并用可用宽度
          // 变量做上限，窄屏 Web 端长文案才回退折行而不是撑出视口。
          "z-[60] flex flex-col gap-0.5 max-h-(--radix-dropdown-menu-content-available-height) max-w-(--radix-dropdown-menu-content-available-width) min-w-32 origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border border-popover-border bg-menu p-1 text-foreground !shadow-md focus:!shadow-md focus-visible:!shadow-md duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:overflow-hidden data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

// [布局] flex-col 加 gap-0.5，与外层同节距，组合后不会出现双倍行距。
// [契约] 组不画分隔线，需要视觉断点仍要显式放 Separator。
function DropdownMenuGroup({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return (
    <DropdownMenuPrimitive.Group
      data-slot="dropdown-menu-group"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    />
  );
}

// [状态] 禁用只认 Radix 的 data-disabled，菜单不把它放进 tab 序列，上下键自动跳过。
// [失败路径] 只写 aria-disabled 而不传 disabled，Radix 不置 data-disabled，样式落空且仍可点击。
// [高亮] data-[highlighted] 已覆盖鼠标与键盘，不要再加 hover 变体，否则两项同时亮。
function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "group/dropdown-menu-item relative flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-ui-base/relaxed text-foreground outline-hidden select-none data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-inset:pl-7.5 data-[variant=destructive]:text-destructive data-[variant=destructive]:data-[highlighted]:bg-destructive data-[variant=destructive]:data-[highlighted]:text-destructive-foreground data-disabled:pointer-events-none data-disabled:text-foreground-subtlest data-disabled:opacity-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-current data-[variant=destructive]:data-[highlighted]:*:[svg]:text-destructive-foreground",
        className,
      )}
      {...props}
    />
  );
}

// [受控] checked 直接透传，勾选态由调用方数据决定，本层不缓存也不翻转。
// [布局] 指示器是绝对定位 span，右侧 pr-8 预留位置，勾出现时文字不位移。
// [权衡] 未勾选时 ItemIndicator 不渲染，但占位 span 常在，宽度与对齐保持稳定。
function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "relative flex min-h-7 cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-ui-base text-foreground outline-hidden select-none data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-inset:pl-7.5 data-disabled:pointer-events-none data-disabled:text-foreground-subtlest data-disabled:opacity-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4 text-foreground-subtle" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

// [布局] 与 Group 同款 flex-col 加 gap-0.5，单选项之间不再插分隔线。
// [契约] value 与 onValueChange 原样透传，互斥由 Radix 维护，本层不去重。
function DropdownMenuRadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return (
    <DropdownMenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      className={cn("flex flex-col gap-0.5", className)}
      {...props}
    />
  );
}

// [布局] 与 CheckboxItem 共用内边距与指示器结构，两种选中项必须长得一样。
// [状态] 选中由所属 RadioGroup 的 value 决定，条目自身不持有 checked。
function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        "relative flex min-h-7 cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-ui-base text-foreground outline-hidden select-none data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-inset:pl-7.5 data-disabled:pointer-events-none data-disabled:text-foreground-subtlest data-disabled:opacity-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4 text-foreground-subtle" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

// [语义] DropdownMenuLabel 只是视觉分组标题：不进键盘序列，也不充当条目的可访问名称。
// [样式] font-medium 加最浅前景色，比条目弱一档，inset 时与条目同列对齐。
function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-2 py-1.5 text-ui-base font-medium text-foreground-subtlest data-inset:pl-7.5",
        className,
      )}
      {...props}
    />
  );
}

// [布局] 负向水平外边距抵消外层 p-1，分隔线才贴满整条菜单宽度。
// [约束] 用 h-px 而不是边框，否则与外层边框叠成双线。
function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

// [布局] ml-auto 把快捷键推到最右，父条目已是 flex 容器，不需要额外包裹。
// [状态] 颜色靠父条目的命名组跟随高亮，自己不能持有高亮态。
function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ml-auto text-ui-xs tracking-widest text-foreground-subtlest group-data-[highlighted]/dropdown-menu-item:text-foreground-subtle",
        className,
      )}
      {...props}
    />
  );
}

// [状态] 子菜单开合归 Radix，父菜单关闭时一并收起，不跨次留存。
// [契约] Sub 只提供定位与状态上下文，不渲染 DOM 节点，挂在它上面的 data-slot 与 className 都不会落到元素上。
function DropdownMenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

// [状态] state 为 open 与 highlighted 同色，右移展开后父项保持高亮，视觉不跳。
// [契约] indicator 用空值合并回退，只有 null 与 undefined 才换成默认箭头。
// [布局] 默认箭头 ml-auto 加 size-4，颜色靠子 trigger 自己的命名组跟随高亮。
function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  indicator,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean;
  indicator?: React.ReactNode;
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "group/dropdown-menu-sub-trigger flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-ui-base text-foreground outline-hidden select-none data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-inset:pl-7.5 data-[state=open]:bg-menu-hover data-[state=open]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      {indicator ?? (
        <ChevronRightIcon className="ml-auto size-4 text-foreground-subtle group-data-[highlighted]/dropdown-menu-sub-trigger:text-foreground-subtle" />
      )}
    </DropdownMenuPrimitive.SubTrigger>
  );
}

// [层级] 子菜单渲染在父 Content 的 portal 内，z-[60] 与父层持平，靠 DOM 顺序压在上面。
// [差异] 不像父 Content 那样设高度上限与纵向滚动，子菜单超过视口高度时不滚动。
function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        "z-[60] flex flex-col gap-0.5 min-w-32 origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-lg border border-popover-border bg-menu p-1 text-foreground !shadow-md focus:!shadow-md focus-visible:!shadow-md duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
        className,
      )}
      {...props}
    />
  );
}

// [契约] 导出全是同形状薄封装，新增部件沿用 data-slot、透传 props、cn 合并。
// [失败路径] 外层已由 Content 自带 Portal，单独导出 Portal 只为手动接管容器。
export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
