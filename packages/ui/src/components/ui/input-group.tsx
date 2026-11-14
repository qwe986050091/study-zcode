// INV-01 输入组容器角色固定：守住位置 分组角色；改错故障 读屏不再聚合子控件。
// INV-02 数据槽标记固定：守住位置 槽属性；改错故障 样式选择器失效。
// INV-03 焦点环由子控件触发：守住位置 焦点可见变体；改错故障 聚焦时无外环。
// INV-04 非法态由子控件传染：守住位置 非法值变体；改错故障 错误边框不显示。
// INV-05 块级对齐改纵向布局：守住位置 块级变体；改错故障 文本域与按钮错行。
// INV-06 文本域自动撑高：守住位置 文本域变体；改错故障 多行输入被裁切。
// INV-07 附加区默认内联起始：守住位置 默认变体；改错故障 图标落到右侧。
// INV-08 附加区点击聚焦输入：守住位置 点击处理器；改错故障 点击空白无响应。
// INV-09 点击按钮不抢焦点：守住位置 最近按钮判断；改错故障 点击按钮后焦点跳走。
// INV-10 禁用态整体降透明：守住位置 组禁用变体；改错故障 禁用后仍显示可用。
// INV-11 按钮尺寸四档：守住位置 尺寸变体；改错故障 图标按钮撑破行高。
// INV-12 按钮默认幽灵样式：守住位置 默认变体；改错故障 内嵌按钮过于抢眼。
// INV-13 按钮不重复接收尺寸：守住位置 类型排除尺寸；改错故障 双尺寸来源冲突。
// INV-14 输入控件去边框与外环：守住位置 类名覆盖；改错故障 组内出现双层边框。
// INV-15 文本域去缩放：守住位置 缩放类；改错故障 用户拖动破坏布局。
// INV-16 文本域与输入共享数据槽：守住位置 同一槽属性；改错故障 两种控件样式分叉。
// INV-17 组件全部具名导出：守住位置 末尾导出表；改错故障 调用方导入路径不统一。
// INV-18 本文件不持有状态：守住位置 纯展示组件；改错故障 组件间共享脏状态。
//
// `input-group.tsx` 只导出无状态的样式封装：`InputGroup`、`InputGroupAddon`、`InputGroupButton`、`InputGroupText`、`InputGroupInput` 与 `InputGroupTextarea`，禁用与非法态都由属性传入。
// 状态所有权：无状态；禁用与非法态由子控件或属性传入。
// 阅读顺序：先看容器与变体表，再读附加区点击，最后看按钮与输入控件。
"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.js";
import { Button } from "./button.js";
import { Input, type InputProps } from "./input.js";
import { Textarea } from "./textarea.js";

// `InputGroup` 只做布局与边框：`data-slot=input-group` 供 `has-data-[slot=input-group-control]` 一类选择器定位，`role=group` 只声明语义分组。
// `cn()` 先拼基础类再合并外部 `className`，其余 `...props` 原样透传；组件不接管焦点，焦点态由内部控件的 focus-visible 触发。
function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        "group/input-group relative flex h-7 w-full min-w-0 items-center rounded-md border border-input bg-input/20 transition-colors outline-none in-data-[slot=combobox-content]:focus-within:border-inherit in-data-[slot=combobox-content]:focus-within:ring-0 has-data-[align=block-end]:rounded-md has-data-[align=block-start]:rounded-md has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot=input-group-control]:focus-visible]:ring-2 has-[[data-slot=input-group-control]:focus-visible]:ring-ring/30 has-[[data-slot][aria-invalid=true]]:border-destructive has-[[data-slot][aria-invalid=true]]:ring-2 has-[[data-slot][aria-invalid=true]]:ring-destructive/20 has-[textarea]:rounded-md has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col has-[>textarea]:h-auto dark:bg-input/30 dark:has-[[data-slot][aria-invalid=true]]:ring-destructive/40 has-[>[data-align=block-end]]:[&>input]:pt-3 has-[>[data-align=block-start]]:[&>input]:pb-3 has-[>[data-align=inline-end]]:[&>input]:pr-1.5 has-[>[data-align=inline-start]]:[&>input]:pl-1.5",
        className,
      )}
      {...props}
    />
  );
}

// `inputGroupAddonVariants` 的 `align` 四档决定 `order-first`/`order-last` 与整行还是内联，`defaultVariants` 固定 `inline-start`。
// `group-data-[disabled=true]/input-group:opacity-50` 让附加区随整组置灰；键帽与图标尺寸写成子选择器兜底，调用方无需再传。
const inputGroupAddonVariants = cva(
  "flex h-auto cursor-text items-center justify-center gap-1 py-2 text-ui-base/relaxed font-medium text-muted-foreground select-none group-data-[disabled=true]/input-group:opacity-50 **:data-[slot=kbd]:rounded-[calc(var(--radius-sm)-2px)] **:data-[slot=kbd]:bg-muted-foreground/10 **:data-[slot=kbd]:px-1 **:data-[slot=kbd]:text-ui-xs [&>svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      align: {
        "inline-start": "order-first pl-2 has-[>button]:ml-[-0.275rem] has-[>kbd]:ml-[-0.275rem]",
        "inline-end": "order-last pr-2 has-[>button]:mr-[-0.275rem] has-[>kbd]:mr-[-0.275rem]",
        "block-start":
          "order-first w-full justify-start px-2 pt-2 group-has-[>input]/input-group:pt-2 [.border-b]:pb-2",
        "block-end":
          "order-last w-full justify-start px-2 pb-2 group-has-[>input]/input-group:pb-2 [.border-t]:pt-2",
      },
    },
    defaultVariants: {
      align: "inline-start",
    },
  },
);

// `InputGroupAddon` 把 `align` 写进 `data-align`，供父级 `has-[>[data-align=...]]` 选择器匹配；类名由变体表与外部 `className` 合并。
// `onClick` 先判 `closest(button)` 并返回，点按钮不抢焦点；其余区域调用 `parentElement.querySelector(input)?.focus()` 聚焦输入。
function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) {
          return;
        }
        e.currentTarget.parentElement?.querySelector("input")?.focus();
      }}
      {...props}
    />
  );
}

// `inputGroupButtonVariants` 的 `size` 四档覆盖图标场景：`xs`/`sm` 留给带文字按钮，`icon-xs`/`icon-sm` 固定方形并清掉内边距。
// `shadow-none` 统一去掉按钮阴影，避免与输入组容器边框叠成双层描边；尺寸只在这里定义，调用方不再覆盖。
const inputGroupButtonVariants = cva(
  "flex items-center gap-2 rounded-md text-ui-base/relaxed shadow-none",
  {
    variants: {
      size: {
        xs: "h-5 gap-1 rounded-[calc(var(--radius-sm)-2px)] px-1 [&>svg:not([class*='size-'])]:size-3",
        sm: "gap-1",
        "icon-xs": "size-6 p-0 has-[>svg]:p-0",
        "icon-sm": "size-7 p-0 has-[>svg]:p-0",
      },
    },
    defaultVariants: {
      size: "xs",
    },
  },
);

function InputGroupButton({
  className,
  type = "button",
  variant = "ghost",
  size = "xs",
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size"> &
  VariantProps<typeof inputGroupButtonVariants>) {
  return (
    <Button
      type={type}
      data-size={size}
      variant={variant}
      className={cn(inputGroupButtonVariants({ size }), className)}
      {...props}
    />
  );
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "flex items-center gap-2 text-ui-base/relaxed text-muted-foreground [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: InputProps) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        "flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupTextarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <Textarea
      data-slot="input-group-control"
      className={cn(
        "flex-1 resize-none rounded-none border-0 bg-transparent py-2 shadow-none ring-0 focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
};
