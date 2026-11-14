// INV-01 关闭文案走国际化：守住位置 辅助组件；改错故障 硬编码英文。
// INV-02 根组件透传属性：守住位置 展开语法；改错故障 受控状态失效。
// INV-03 触发器与传送门独立导出：守住位置 组件拆分；改错故障 无法自定义挂载点。
// INV-04 遮罩覆盖完整视口：守住位置 固定定位；改错故障 顶部残留亮条。
// INV-05 遮罩不拦截自绘窗控：守住位置 说明注释；改错故障 标题栏按钮失效。
// INV-06 内容默认带遮罩：守住位置 默认值；改错故障 调用方忘了传就没有背景。
// INV-07 内容可关遮罩：守住位置 条件渲染；改错故障 无法做无遮罩弹层。
// INV-08 内容落在无拖拽区：守住位置 应用区域属性；改错故障 关闭键被窗口拖拽吞掉。
// INV-09 内容居中限宽：守住位置 定位类；改错故障 小屏溢出。
// INV-10 关闭键可隐藏：守住位置 默认布尔；改错故障 纯信息弹窗多一个叉。
// INV-11 关闭键语义名走国际化：守住位置 隐藏文本；改错故障 读屏只念图标。
// INV-12 头部纵向排列：守住位置 布局类；改错故障 标题与描述挤行。
// INV-13 底部小屏倒序：守住位置 响应式类；改错故障 主操作难触。
// INV-14 底部关闭键默认不显示：守住位置 默认值；改错故障 每个弹窗多一个取消。
// INV-15 标题与描述语义独立：守住位置 原语组件；改错故障 读屏无标题。
// INV-16 描述保留下划线链接：守住位置 选择器；改错故障 链接不可辨。
// INV-17 样式类名最后合并：守住位置 合并顺序；改错故障 外部覆盖失效。
// INV-18 仅具名导出：守住位置 导出块；改错故障 引用路径不稳定。
//
// 模块职责：通用弹窗的无状态样式与语义包装。
// 状态所有权：开关与焦点全部交给底层弹窗原语。
// 阅读顺序：先看关闭文案，再看内容与遮罩，最后看头部与底部。
import * as React from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Dialog as DialogPrimitive } from "radix-ui";

import { cn } from "../lib/utils.js";
import { Button } from "./button.js";
import { XIcon } from "lucide-react";

// 关闭文案统一取 common.close，不在组件内硬编码语言。
// 通过 useZCodeIntl 读上下文，语言切换后随 Provider 重渲染。
// 同一文案供 sr-only 隐藏文本与取消键复用。
// 组件不接收 props，调用方无法覆盖文案来源。
// 每次渲染重新调用 formatMessage，不做跨语言缓存。
function DialogCloseText() {
  const { intl } = useZCodeIntl();
  return intl.formatMessage({ id: "common.close" });
}

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        // Linux 旧标题栏避让让模态遮罩从 48px 以下开始，窗口顶部仍保持高亮且 tooltip 可见。
        // renderer 自绘窗控位于同一窗口，模态态应与其它平台一致覆盖完整视口。
        "fixed inset-0 isolate z-50 bg-black/60 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

// 圆角规范迁移：默认外壳统一 2xl，三个截图/附件预览入口显式保留 xl，内容层级独立计算。
// showOverlay 默认 true，普通弹窗无需显式传遮罩。
// 传 showOverlay={false} 时跳过 DialogOverlay，用于无背景弹层。
// 内容加 [app-region:no-drag] 标记，关闭键不被标题栏拖拽吞掉。
// showCloseButton 默认 true，纯展示弹窗可关掉右上角叉。
// className 在 cn() 末位合并，调用方样式最后生效。
function DialogContent({
  className,
  children,
  showCloseButton = true,
  showOverlay = true,
  overlayClassName,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  showOverlay?: boolean;
  overlayClassName?: string;
}) {
  return (
    <DialogPortal>
      {showOverlay ? <DialogOverlay className={overlayClassName} /> : null}
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          // Electron 自绘标题栏下，弹窗可能会落进窗口顶部的 drag 区域。
          // 如果不把弹窗内容整体标成 no-drag，右上角关闭按钮这类交互会被窗口拖拽命中吞掉。
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-2xl border border-popover-border bg-popover p-4 text-ui-base/relaxed text-foreground shadow-md duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 [app-region:no-drag]",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              type="button"
              variant="ghost"
              className="absolute top-4 right-4 z-20 hover:bg-surface-hover [app-region:no-drag]"
              size="icon-sm"
            >
              <XIcon />
              <span className="sr-only">
                <DialogCloseText />
              </span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="dialog-header" className={cn("flex flex-col gap-1", className)} {...props} />
  );
}

// 小屏 flex-col-reverse 让确认键落在上方，拇指更容易触到。
// sm:flex-row 加 sm:justify-end 让宽屏按钮组右对齐。
// showCloseButton 为 true 时追加一个描边取消键。
// 该按钮默认 false，避免每个弹窗底部多一个取消。
// children 原样渲染在按钮之前，顺序由调用方决定。
function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">
            <DialogCloseText />
          </Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

// 标题直接用 DialogPrimitive.Title，语义与焦点管理交给原语。
// 保留 data-slot="dialog-title" 供选择器定位。
// text-ui-base 与 font-medium 统一全站弹窗标题字级。
// className 在 cn() 末尾合并，可覆盖字号与颜色。
function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-ui-base font-medium text-foreground", className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-ui-base/relaxed text-foreground-subtle *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
