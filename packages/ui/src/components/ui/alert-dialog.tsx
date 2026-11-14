// INV-01 根组件透传属性：守住位置 展开语法；改错故障 调用方受控状态失效。
// INV-02 触发器保留插槽标记：守住位置 数据属性；改错故障 样式选择器失配。
// INV-03 传送门独立导出：守住位置 组件拆分；改错故障 无法自定义挂载位置。
// INV-04 遮罩覆盖完整窗口：守住位置 固定定位；改错故障 顶部残留亮条。
// INV-05 遮罩动画随状态：守住位置 数据状态类；改错故障 关闭时无过渡。
// INV-06 内容自带传送门：守住位置 嵌套结构；改错故障 弹窗被父级裁剪。
// INV-07 内容居中且限宽：守住位置 定位与最大宽；改错故障 小屏溢出。
// INV-08 内容圆角无边框：守住位置 样式类；改错故障 出现双边框。
// INV-09 头部左对齐纵向排列：守住位置 布局类；改错故障 标题与描述挤在一行。
// INV-10 底部小屏倒序：守住位置 响应式类；改错故障 主操作落在难触位置。
// INV-11 标题语义独立：守住位置 原语标题；改错故障 读屏读不到标题。
// INV-12 描述保留换行：守住位置 空白规则；改错故障 多段文案挤成一段。
// INV-13 确认按钮复用按钮变体：守住位置 变体组合；改错故障 确认键样式与全站不一致。
// INV-14 取消按钮默认描边：守住位置 空值回退；改错故障 取消键与确认键同权重。
// INV-15 样式可被调用方覆盖：守住位置 合并顺序；改错故障 外部类名被内置类覆盖。
// INV-16 插槽标记统一前缀：守住位置 数据属性命名；改错故障 测试选择器冲突。
// INV-17 组件全部具名导出：守住位置 导出块；改错故障 引用路径不稳定。
// INV-18 不引入额外状态：守住位置 纯包装；改错故障 与弹窗库状态双写。
//
// 模块职责：确认式弹窗的无状态样式与语义包装。
// 状态所有权：开关与焦点全部交给底层弹窗原语。
// 阅读顺序：先看遮罩与内容，再看头部与底部，最后看按钮与导出。
import * as React from "react";
import type { VariantProps } from "class-variance-authority";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import { cn } from "../lib/utils.js";
import { buttonVariants } from "./button.js";

// 根组件把 props 全量交给 AlertDialogPrimitive.Root，受控开关仍由调用方持有。
// 本包装不维护内部 state，打开状态只由 Radix 原语保存。
// 保留 data-slot="alert-dialog" 标记，供样式与测试选择器定位。
// 受控与否取决于调用方是否传 open，包装层不做判断。
// 只叠加 className 与语义，不改变原语的交互行为。
function AlertDialog({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

// 遮罩用 fixed inset-0 铺满视口，覆盖 Linux 旧标题栏留下的顶部亮条。
// 背景取 bg-black/60 并叠加 backdrop-blur，弹窗下层仍隐约可见。
// 开合过渡由 data-open 与 data-closed 驱动，淡入淡出各 100ms。
// className 放在 cn() 末尾合并，调用方可覆盖内置样式。
// isolate 与 z-50 建立独立层叠上下文，避免被父级 overflow 裁剪。
function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        // Linux 旧标题栏避让会留下未遮罩的顶部亮条；确认弹窗也应覆盖完整窗口。
        "fixed inset-0 isolate z-50 bg-black/60 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

// 内容自带 AlertDialogPortal 与 AlertDialogOverlay，调用方无需再包一层。
// 用 top-1/2 left-1/2 加负向 translate 居中，max-w-md 限制桌面宽度。
// 小屏用 max-w-[calc(100%-2rem)] 留出边距，避免贴边溢出。
// data-open 状态播放 zoom-in-95 缩放，与遮罩淡入同步。
// data-closed 动画结束后由原语卸载，不在关闭瞬间闪白。
function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-5 rounded-2xl border-none bg-popover/98 p-5 text-ui-base/relaxed text-foreground ring-border shadow-2xl duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 sm:max-w-md",
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn("flex flex-col gap-2 text-left", className)}
      {...props}
    />
  );
}

// 默认 flex-col-reverse 让主操作在小屏落在靠上位置。
// sm:flex-row 与 sm:justify-end 在宽屏改为右对齐横排。
// 主操作排在 flex 行的最右，符合确认弹窗的阅读落点。
// gap-2 与 header 的间距保持一致，按钮区不另行加大留白。
function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("text-ui-lg font-semibold text-foreground", className)}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn(
        "whitespace-pre-line pt-0.5 text-ui-base leading-6 text-foreground-subtle",
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogAction({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> & VariantProps<typeof buttonVariants>) {
  return (
    <AlertDialogPrimitive.Action
      data-slot="alert-dialog-action"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

function AlertDialogCancel({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel> & VariantProps<typeof buttonVariants>) {
  return (
    <AlertDialogPrimitive.Cancel
      data-slot="alert-dialog-cancel"
      className={cn(buttonVariants({ variant: variant ?? "outline", size }), className)}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
