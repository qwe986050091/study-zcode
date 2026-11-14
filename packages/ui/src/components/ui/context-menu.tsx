// INV-01 每层菜单标注槽位：守住位置 槽位属性；改错故障 样式选择器找不到目标层。
// INV-02 外层菜单独立圆角：守住位置 外壳类名；改错故障 主菜单与子菜单圆角不一致。
// INV-03 菜单层级高于提示浮层：守住位置 层级类；改错故障 右键菜单被提示层盖住。
// INV-04 弹出方向决定滑入动画：守住位置 方向变体类；改错故障 任意方向都从同一侧滑入。
// INV-05 关闭态播放退出动画：守住位置 关闭变体类；改错故障 菜单瞬间消失没有过渡。
// INV-06 条目最小高度统一：守住位置 高度类；改错故障 有无图标时行高跳动。
// INV-07 缩进条目额外左距：守住位置 缩进属性；改错故障 图标列与文字错位。
// INV-08 危险条目使用语义色：守住位置 变体属性；改错故障 删除项与普通项无区别。
// INV-09 危险项高亮反转前景：守住位置 高亮变体类；改错故障 高亮时文字不可读。
// INV-10 禁用项不响应指针：守住位置 禁用类；改错故障 禁用命令仍可点击。
// INV-11 图标不拦截指针事件：守住位置 后代选择器；改错故障 点击图标不触发命令。
// INV-12 分隔线不撑开内边距：守住位置 负外边距；改错故障 菜单被分隔线拉高。
// INV-13 子菜单触发器带箭头：守住位置 尾部图标；改错故障 用户不知道还能展开。
// INV-14 子菜单宽度小于主菜单：守住位置 最小宽度类；改错故障 子菜单溢出屏幕。
// INV-15 外层类名由调用方追加：守住位置 合并函数；改错故障 自定义样式被覆盖。
// INV-16 其余属性原样透传：守住位置 展开属性；改错故障 无障碍属性丢失。
// INV-17 根与触发器保持原语语义：守住位置 直接转发；改错故障 键盘操作失效。
// INV-18 导出清单集中在一处：守住位置 文件末尾导出；改错故障 引用路径各不相同。
//
// 模块职责：为右键菜单提供统一的圆角、层级与条目样式。
// 状态所有权：无状态；展开与高亮全部交给底层菜单原语。
// 阅读顺序：先看外层内容，再看条目变体，最后看子菜单两件套。
import * as React from "react";
import { ContextMenu as ContextMenuPrimitive } from "radix-ui";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "../lib/utils.js";

function ContextMenu({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

// 圆角规范迁移：旧菜单沿用 xl/lg，统一为独立外壳 lg、内部选项 md；子菜单重新起算。
// 内容经 Portal 挂到最外层。
// ContextMenuContent 的外壳自带 rounded-lg，调用方无需再传圆角类。
// className 由 cn() 放在最后合并，调用方可以覆盖任意默认类。
function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        className={cn(
          // 右键菜单与 Dropdown 共用菜单语言，也必须高于仅提供说明的 tooltip。
          "z-[60] flex flex-col gap-0.5 min-w-44 origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-lg border border-popover-border bg-menu p-1 text-foreground shadow-md duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
}

// ContextMenuItem 用 min-h-7 固定条目高度，图标与文字不再抖动。
// inset 与 destructive 变体各自成组：缩进由 data-inset:pl-7.5 给出，危险态由 data-[variant=destructive] 类给出。
// data-disabled 时只关掉 pointer-events，文字仍以 foreground-subtlest 保持可读。
function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "group/context-menu-item relative flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-ui-base/relaxed text-foreground outline-hidden select-none data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-inset:pl-7.5 data-[variant=destructive]:text-destructive data-[variant=destructive]:data-[highlighted]:bg-destructive data-[variant=destructive]:data-[highlighted]:text-destructive-foreground data-disabled:pointer-events-none data-disabled:text-foreground-subtlest data-disabled:opacity-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-current data-[variant=destructive]:data-[highlighted]:*:[svg]:text-destructive-foreground",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function ContextMenuSub({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />;
}

// ContextMenuSubTrigger 末尾渲染 ChevronRightIcon，ml-auto 把它推到右侧。
// data-[state=open] 与 data-[highlighted] 共用 bg-menu-hover，展开后底色不会突变。
// children 先于 ChevronRightIcon 渲染，箭头因此始终贴在最右侧。
function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  inset?: boolean;
}) {
  return (
    <ContextMenuPrimitive.SubTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "group/context-menu-sub-trigger flex min-h-7 cursor-default items-center gap-2 rounded-md px-2 py-1 text-ui-base text-foreground outline-hidden select-none data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-inset:pl-7.5 data-[state=open]:bg-menu-hover data-[state=open]:text-foreground data-disabled:pointer-events-none data-disabled:text-foreground-subtlest data-disabled:opacity-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4 text-foreground-subtle group-data-[highlighted]/context-menu-sub-trigger:text-foreground-subtle" />
    </ContextMenuPrimitive.SubTrigger>
  );
}

// ContextMenuSubContent 用 min-w-32，比主菜单的 min-w-44 窄一档。
// duration-100 与 fade/zoom 类与 ContextMenuContent 一致，两级菜单动画因此不会错位。
// origin-(--radix-context-menu-content-transform-origin) 让缩放锚定在内容变换原点。
function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ContextMenuPrimitive.SubContent
      data-slot="context-menu-sub-content"
      className={cn(
        "z-[60] flex flex-col gap-0.5 min-w-32 origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-lg border border-popover-border bg-menu p-1 text-foreground shadow-md duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
        className,
      )}
      {...props}
    />
  );
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
};
