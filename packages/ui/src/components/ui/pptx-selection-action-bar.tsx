// INV-01 操作条锚定真实布局：守住位置 锚点元素；改错故障 缩放后按钮位置漂移。
// INV-02 内容经 Portal 渲染：守住位置 弹层包裹；改错故障 按钮被页面溢出裁切。
// INV-03 按钮尺寸不随缩放：守住位置 独立浮层；改错故障 幻灯片缩小按钮也变小。
// INV-04 视口宽度限制最大宽：守住位置 宽度上限；改错故障 窄屏下操作条溢出。
// INV-05 编辑态与默认态宽度不同：守住位置 条件类名；改错故障 评论框被压成一行。
// INV-06 退出编辑清空草稿：守住位置 效果依赖；改错故障 下次打开残留上次评论。
// INV-07 组合输入中不拦截退出：守住位置 组合判定；改错故障 中文输入取消候选时关闭评论。
// INV-08 组合状态同时读本地标记：守住位置 双源判断；改错故障 平台事件时序导致误退出。
// INV-09 拦截键先阻止默认行为：守住位置 处理首行；改错故障 Esc 同时关闭两层。
// INV-10 编辑态退出只丢弃草稿：守住位置 分支顺序；改错故障 取消评论连带退出选择。
// INV-11 非编辑态退出选择：守住位置 末尾分支；改错故障 Esc 无法离开选择模式。
// INV-12 关闭后不抢回焦点：守住位置 关闭焦点回调；改错故障 焦点跳回幻灯片起点。
// INV-13 工具条语义与标签：守住位置 角色与标签属性；改错故障 读屏软件读不出操作条。
// INV-14 提交按钮随禁用态失效：守住位置 禁用属性；改错故障 未选中时也能提交。
// INV-15 输入框高度固定三行：守住位置 行数属性；改错故障 评论区高度随内容跳动。
// INV-16 按下先阻止默认：守住位置 鼠标按下处理；改错故障 点击按钮清空文本选择。
// INV-17 碰撞边界由调用方注入：守住位置 边界属性；改错故障 操作条跑到可视区外。
// INV-18 位置更新采用始终策略：守住位置 更新策略属性；改错故障 滚动后操作条滞后。
//
// 模块职责：为 PPTX 元素选择提供 AI 编辑与评论两条操作路径。
// 状态所有权：本地只持有评论草稿与组合输入标记。
// 阅读顺序：先看接口与草稿效果，再看浮层骨架，最后看 Esc 分支。
"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent } from "@/components/ui/popover.js";
import { Textarea } from "@/components/ui/textarea.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";

interface PptxSelectionActionBarProps {
  children: ReactNode;
  open: boolean;
  boundary: HTMLElement | null;
  label: string;
  commentPlaceholder: string;
  cancelLabel: string;
  addToConversationLabel: string;
  editing: boolean;
  disabled: boolean;
  onAiEdit: () => void;
  onCancelAiEdit: () => void;
  onAddToConversation: (comment: string) => void;
  onExitSelection: () => void;
}

/**
 * PPTX 元素选择的应用层操作条。
 *
 * 锚点仍位于幻灯片 transform 容器内，内容通过 Popover Portal 渲染；这样既能读取
 * 缩放后的真实 DOMRect，又不会让按钮尺寸随幻灯片缩放或被页面 overflow 裁切。
 */
// PptxSelectionActionBar 不持有选择状态，选中集合由调用方经 children 传入。
// comment 草稿只在 editing 为真期间存在。
// compositionActiveRef 用 useRef 保存组合输入标记。
export function PptxSelectionActionBar({
  children,
  open,
  boundary,
  label,
  commentPlaceholder,
  cancelLabel,
  addToConversationLabel,
  editing,
  disabled,
  onAiEdit,
  onCancelAiEdit,
  onAddToConversation,
  onExitSelection,
}: PptxSelectionActionBarProps) {
  const [comment, setComment] = useState("");
  const compositionActiveRef = useRef(false);

  // editing 转假时 setComment("") 清空草稿。
  // 同一 effect 里把 compositionActiveRef.current 复位为 false。
  // useEffect 的依赖数组只有 editing 一项。
  useEffect(() => {
    if (!editing) {
      setComment("");
      compositionActiveRef.current = false;
    }
  }, [editing]);

  // Popover 的 modal 固定为 false，避免抢焦点。
  // 锚点在幻灯片内，PopoverContent 经 Portal 渲染因而独立于幻灯片缩放。
  // role="toolbar" 与 aria-label 把工具栏语义交给读屏软件。
  return (
    <Popover open={open} modal={false}>
      {children}
      <PopoverContent
        role="toolbar"
        aria-label={label}
        side="top"
        align="center"
        sideOffset={8}
        collisionBoundary={boundary}
        collisionPadding={8}
        sticky="partial"
        hideWhenDetached
        updatePositionStrategy="always"
        className={
          editing
            ? "w-80 max-w-[calc(100vw-1rem)] gap-0 border-popover-border p-1"
            : "w-auto max-w-[calc(100vw-1rem)] gap-0 border-popover-border p-1"
        }
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          // 编辑态下 Esc 只丢弃本次草稿。
          // 组合输入判定先于取消。
          // 非编辑态走 onExitSelection 回调退出选择。
          if (editing) {
            if (
              isImeComposingKeyEvent({
                compositionActive: compositionActiveRef.current,
                isComposing: event.isComposing,
              })
            ) {
              // 中文/日文输入法下 Esc 是取消候选词，不是放弃评论。
              // 同时读取本地 composition 状态，避免平台事件时序让 isComposing 提前变 false。
              return;
            }
            // Esc 与“取消”同义：只丢弃本次评论草稿并回到 AI 编辑条，不连带退出元素选择。
            onCancelAiEdit();
            return;
          }
          onExitSelection();
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {editing ? (
          <div className="flex flex-col gap-2 p-1">
            <Textarea
              autoFocus
              aria-label={commentPlaceholder}
              placeholder={commentPlaceholder}
              value={comment}
              disabled={disabled}
              rows={3}
              className="min-h-16 resize-none border-input-border bg-input text-mobile-input-safe placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0 md:text-ui-base"
              onChange={(event) => setComment(event.target.value)}
              onCompositionStart={() => {
                compositionActiveRef.current = true;
              }}
              onCompositionEnd={() => {
                compositionActiveRef.current = false;
              }}
            />
            <div className="flex items-center justify-end gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={onCancelAiEdit}
              >
                {cancelLabel}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={disabled}
                onClick={() => onAddToConversation(comment)}
              >
                {addToConversationLabel}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            size="lg"
            variant="ghost"
            aria-label={label}
            disabled={disabled}
            className="w-full justify-start rounded-lg px-2"
            onMouseDown={(event) => {
              // 原因：按钮获得鼠标焦点前浏览器可能清空 PPTX 文本 Selection；阻止默认 mousedown 仍保留 click/键盘激活。
              event.preventDefault();
            }}
            onClick={onAiEdit}
          >
            <SparklesIcon className="size-4" />
            {label}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
