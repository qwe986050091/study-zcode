// INV-01 无采集能力即降级：守住位置 能力探测早返回；改错故障 点击截图直接抛错。
// INV-02 媒体流必须释放：守住位置 finally 内 track.stop；改错故障 录屏指示灯常亮。
// INV-03 视频元素复位：守住位置 pause 与 srcObject = null；改错故障 旧流被下一帧复用。
// INV-04 尺寸为 0 视为失败：守住位置 width/height 判断；改错故障 产出空白 PNG。
// INV-05 2D 上下文缺失即放弃：守住位置 getContext 判空；改错故障 空指针中断附件流程。
// INV-06 截图必须是 File：守住位置 File 构造；改错故障 附件管线拒绝非 File 项。
// INV-07 文件名带时间戳：守住位置 ISO 字符替换；改错故障 多次截图重名互相覆盖。
// INV-08 用户取消不报错：守住位置 NotAllowedError 与 AbortError 分支；改错故障 取消选择弹错误提示。
// INV-09 先调用外部 onSelect：守住位置 onSelect?.() 在前；改错故障 外部禁用逻辑被跳过。
// INV-10 已 preventDefault 即放弃：守住位置 defaultPrevented 判断；改错故障 禁用后仍弹窗。
// INV-11 附件走统一入口：守住位置 attachments.add；改错故障 绕开容量与类型校验。
// INV-12 菜单项透传 props：守住位置 {...props}；改错故障 外部 aria 与事件丢失。
// INV-13 触发器有默认图标：守住位置 children ?? PlusIcon；改错故障 空触发器没有点击区域。
// INV-14 菜单默认左对齐：守住位置 align="start"；改错故障 靠近右边界时内容溢出视口。
//
// 模块职责：输入框附件菜单的动作项与菜单包装，含屏幕截图采集。
// 阅读顺序：先看 captureScreenshot 的资源释放，再看两个动作项，最后看菜单包装的透传。
/*
 * Derived from vercel/ai-elements (packages/elements/src/prompt-input.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: split components and adapt local imports and behavior.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.js";
import { cn } from "../lib/utils.js";
import { ImageIcon, Monitor, PlusIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback } from "react";
import { usePromptInputAttachments } from "./prompt-input.js";
import { PromptInputButton } from "./prompt-input-buttons.js";
import type { PromptInputButtonProps } from "./prompt-input-buttons.js";

// ============================================================================
// Helpers
// ============================================================================

// 采集失败返回 null 而不抛错，调用方据空值静默跳过。
const captureScreenshot = async (): Promise<File | null> => {
  // 先探测能力，SSR 与旧浏览器都走降级。
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
    return null;
  }

  let stream: MediaStream | null = null;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;

  try {
    // 只请求画面，不申请音频权限。
    stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: true,
    });

    video.srcObject = stream;

    // Video element uses callback-based API, wrapping in Promise is necessary
    // oxlint-disable-next-line eslint-plugin-promise(avoid-new)
    // 元数据加载是回调式 API，这里桥接成 Promise。
    await new Promise<void>((resolve, reject) => {
      // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
      video.onloadedmetadata = () => resolve();
      // oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
      video.onerror = () => reject(new Error("Failed to load screen stream"));
    });

    await video.play();

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) {
      return null;
    }

    // 用 canvas 抓取当前帧再转成图片。
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }

    context.drawImage(video, 0, 0, width, height);
    // canvas.toBlob uses callback-based API, wrapping in Promise is necessary
    // oxlint-disable-next-line eslint-plugin-promise(avoid-new)
    // toBlob 同样是回调式，失败时给 null。
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/png");
    });
    if (!blob) {
      return null;
    }

    const timestamp = new Date()
      .toISOString()
      .replaceAll(/[:.]/g, "-")
      .replace("T", "_")
      .replace("Z", "");

    // 包装成 File 才能进入附件管线。
    return new File([blob], `screenshot-${timestamp}.png`, {
      lastModified: Date.now(),
      type: "image/png",
    });
  } finally {
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
    video.pause();
    video.srcObject = null;
  }
};

// ============================================================================
// Attachment / Screenshot Actions
// ============================================================================

export type PromptInputActionAddAttachmentsProps = ComponentProps<typeof DropdownMenuItem> & {
  label?: string;
};

// 附件入口直接调用上下文打开文件对话框。
export const PromptInputActionAddAttachments = ({
  label = "Add photos or files",
  ...props
}: PromptInputActionAddAttachmentsProps) => {
  const attachments = usePromptInputAttachments();

  const handleSelect = useCallback(
    (e: Event) => {
      e.preventDefault();
      // 打开文件对话框由 usePromptInputAttachments 的 openFileDialog 统一实现，本组件不持有选择逻辑。
      attachments.openFileDialog();
    },
    [attachments],
  );

  return (
    <DropdownMenuItem {...props} onSelect={handleSelect}>
      <ImageIcon className="mr-2 size-4" /> {label}
    </DropdownMenuItem>
  );
};

export type PromptInputActionAddScreenshotProps = ComponentProps<typeof DropdownMenuItem> & {
  label?: string;
};

// 截图入口先调 onSelect 让外部拦截，未 preventDefault 才继续 captureScreenshot。
export const PromptInputActionAddScreenshot = ({
  label = "Take screenshot",
  onSelect,
  ...props
}: PromptInputActionAddScreenshotProps) => {
  const attachments = usePromptInputAttachments();

  const handleSelect = useCallback(
    async (event: Event) => {
      onSelect?.(event);
      if (event.defaultPrevented) {
        return;
      }

      try {
        // captureScreenshot 返回空表示用户取消或能力不足，此时不调用 attachments.add。
        const screenshot = await captureScreenshot();
        if (screenshot) {
          attachments.add([screenshot]);
        }
      } catch (error) {
        if (
          // 只吞用户取消类错误，其余继续抛出。
          error instanceof DOMException &&
          (error.name === "NotAllowedError" || error.name === "AbortError")
        ) {
          return;
        }
        throw error;
      }
    },
    [onSelect, attachments],
  );

  return (
    <DropdownMenuItem {...props} onSelect={handleSelect}>
      <Monitor className="mr-2 size-4" />
      {label}
    </DropdownMenuItem>
  );
};

// ============================================================================
// Action Menu Wrappers
// ============================================================================

export type PromptInputActionMenuProps = ComponentProps<typeof DropdownMenu>;
export const PromptInputActionMenu = (props: PromptInputActionMenuProps) => (
  <DropdownMenu {...props} />
);

export type PromptInputActionMenuTriggerProps = PromptInputButtonProps;

// 未传 children 时触发器用 PlusIcon 占位，保持至少 1 行可点击面积。
export const PromptInputActionMenuTrigger = ({
  className,
  children,
  ...props
}: PromptInputActionMenuTriggerProps) => (
  <DropdownMenuTrigger asChild>
    <PromptInputButton className={className} {...props}>
      {children ?? <PlusIcon className="size-4" />}
    </PromptInputButton>
  </DropdownMenuTrigger>
);

export type PromptInputActionMenuContentProps = ComponentProps<typeof DropdownMenuContent>;
export const PromptInputActionMenuContent = ({
  className,
  ...props
}: PromptInputActionMenuContentProps) => (
  <DropdownMenuContent align="start" className={cn(className)} {...props} />
);

export type PromptInputActionMenuItemProps = ComponentProps<typeof DropdownMenuItem>;
export const PromptInputActionMenuItem = ({
  className,
  ...props
}: PromptInputActionMenuItemProps) => <DropdownMenuItem className={cn(className)} {...props} />;
