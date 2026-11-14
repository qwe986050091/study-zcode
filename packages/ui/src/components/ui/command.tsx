// INV-01 原语透传：守住位置 每个组件末尾的 props 展开；改错故障：cmdk 自带属性被本地实现吞掉。
// INV-02 样式可叠加：守住位置 className 与 cn 的合并顺序；改错故障：调用方覆盖样式失效。
// INV-03 插槽标识：守住位置 每个原语的 data-slot；改错故障：外部样式与测试选择器失配。
// INV-04 键盘循环默认关闭：守住位置 Command 的 loop 默认值；改错故障：过滤后上下键在首尾回绕，用户以为列表没变。
// INV-05 对话框可访问名：守住位置 sr-only 标题与描述；改错故障：读屏只念到「对话框」。
// INV-06 输入框外壳：守住位置 command-input-wrapper 的边框；改错故障：搜索区与列表之间缺少分隔。
// INV-07 输入透明背景：守住位置 InputGroup 的边框与背景覆盖；改错故障：输入框出现双层边框。
// INV-08 列表内滚：守住位置 最大高度与纵向滚动；改错故障：命令面板撑出屏幕。
// INV-09 空态居中：守住位置 CommandEmpty 的对齐类；改错故障：无结果提示贴左难以发现。
// INV-10 分组标题统一：守住位置 组标题的任意变体选择器；改错故障：各分组标题字号颜色不一致。
// INV-11 分隔线满宽：守住位置 负外边距；改错故障：分隔线两端留白。
// INV-12 选中态同源：守住位置 hover 与 data-selected 的背景色；改错故障：键盘选中与鼠标悬停看起来是两种状态。
// INV-13 禁用不可点：守住位置 disabled 的 pointer-events；改错故障：禁用项仍可被点击触发命令。
// INV-14 图标尺寸：守住位置 svg 的默认尺寸规则；改错故障：图标大小随父级字号漂移。
// INV-15 勾选互斥：守住位置 勾选图标的 hidden 条件；改错故障：有快捷键与已选中同时出现两处标记。
// INV-16 快捷键文字跟随：守住位置 group-data-selected 变色；改错故障：深色选中行上快捷键不可读。
// INV-17 导出收口：守住位置 文件末尾导出列表；改错故障：新增原语忘记导出，调用方另起实现。
// INV-18 无业务状态：守住位置 本文件全部组件；改错故障：命令面板混入业务查询逻辑。
//
// 模块职责：对 cmdk 命令面板原语做统一样式封装，并提供对话框与快捷键展示的组合件。
// 状态所有权：无状态；展开、选中与过滤全部由 cmdk 原语与调用方持有。
// 阅读顺序：容器 → 对话框 → 输入 → 列表与空态 → 分组与分隔 → 选项与快捷键。
import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";

import { cn } from "../lib/utils.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog.js";
import { InputGroup, InputGroupAddon } from "./input-group.js";
import { SearchIcon, CheckIcon } from "lucide-react";

// 容器默认不做键盘循环，避免过滤后上下键在首尾回绕造成误判。
// 背景与圆角在 CommandPrimitive 上统一，调用方只需追加 className 布局类。
//
function Command({
  className,
  loop = false,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      loop={loop}
      className={cn(
        "flex size-full flex-col overflow-hidden rounded-xl bg-popover p-1 text-popover-foreground",
        className,
      )}
      {...props}
    />
  );
}

// 对话框标题与描述仅给 DialogHeader 的读屏使用，视觉上由输入框承担提示。
// 内容区去内边距，CommandPrimitive 自己控制列表留白。
// 关闭按钮默认隐藏，避免与 Esc 关闭重复。
//
function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = false,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn("top-1/3 translate-y-0 overflow-hidden p-0", className)}
        showCloseButton={showCloseButton}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

// 外壳负责下边框与内边距，输入组本身透明化，避免嵌套卡片感。
// SearchIcon 放在 InputGroupAddon 附加位，不占用输入光标区域。
// CommandPrimitive.Input 禁用时不接收焦点，样式同时降 opacity。
//
function CommandInput({
  className,
  inputGroupClassName,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  inputGroupClassName?: string;
}) {
  return (
    <div data-slot="command-input-wrapper" className="p-1 border-b border-border">
      <InputGroup
        className={cn(
          "h-8 border-0 !bg-transparent hover:border-input-border-hover",
          inputGroupClassName,
        )}
      >
        <CommandPrimitive.Input
          data-slot="command-input"
          className={cn(
            "w-full text-ui-base/relaxed text-foreground outline-hidden placeholder:text-foreground-subtlest disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          {...props}
        />
        <InputGroupAddon>
          <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

// 列表限高并纵向滚动，横向溢出裁掉，避免长命令名撑破面板。
// scrollbar-hide 隐藏滚动条保持视觉干净，滚轮与键盘仍可操作。
// 滚动内边距按选项补齐，避免首尾项贴边。
//
function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "scrollbar-hide max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto outline-none",
        className,
      )}
      {...props}
    />
  );
}

// 空态只做居中与垂直留白，文案由调用方通过子节点提供。
// 空态出现与否由 cmdk 根据过滤结果决定，这里不重复判断。
//
function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("py-6 text-center text-ui-base/relaxed", className)}
      {...props}
    />
  );
}

// 分组标题用任意变体选择器统一字号、字重与颜色，避免各页各写一套。
// CommandPrimitive.Group 自身裁掉溢出，标题与选项共用同一内边距基线。
// 分组不控制显隐，过滤后为空的组由 cmdk 自行隐藏。
//
function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-1 text-foreground **:[[cmdk-group-heading]]:px-2.5 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-ui-base **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-foreground-subtle",
        className,
      )}
      {...props}
    />
  );
}

// CommandPrimitive.Separator 用负外边距抵消容器内边距，视觉上通栏。
// 高度固定一像素，颜色走半透明边框色以适配深浅主题。
//
function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 my-1 h-px bg-border/50", className)}
      {...props}
    />
  );
}

// 选项最小高度保证触达面积，图标统一禁止指针事件避免抢焦点。
// 勾选标记仅在无快捷键且已选中时出现，两者互斥不叠加。
//
function CommandItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        // cmdk 键盘上下键只会切换 data-selected，之前没有同步背景色，
        // 导致键盘选中态和鼠标 hover 态看起来不是同一个状态。这里让两者共用 menu-hover。
        "group/command-item relative flex min-h-7 cursor-default items-center gap-2 rounded-lg px-2.5 py-1.5 text-ui-base/relaxed outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 hover:bg-menu-hover data-selected:bg-menu-hover data-selected:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 data-selected:*:[svg]:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <CheckIcon className="size-4 ml-auto !text-foreground-subtle hidden group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:inline-block" />
    </CommandPrimitive.Item>
  );
}

// 快捷键靠右并跟随选项选中态变色，保证高亮行内仍可读。
// 字号与字距在 CommandShortcut 上统一，调用方只传内容不传排版。
//
function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-ui-xs tracking-widest text-foreground-subtlest group-data-selected/command-item:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
