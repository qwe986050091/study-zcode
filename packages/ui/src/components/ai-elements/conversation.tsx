// INV-01 组件族全部薄封装滚动库：守住位置 四个导出组件的 JSX；改错故障 自研滚动会让吸底行为偏离上游。
// INV-02 初始与 resize 都立即滚动：守住位置 initial 与 resize 两个 instant；改错故障 切任务时出现缓动追底。
// INV-03 立即滚动是为避免恢复历史叠两层动画：守住位置 该处属性取值；改错故障 体感卡顿回归。
// INV-04 消息区占满剩余高度：守住位置 flex-1 与 overflow-y-hidden；改错故障 长对话把输入框挤出视口。
// INV-05 停止按需隐藏：守住位置 非底部条件；改错故障 已在底部时仍显示回到底部按钮。
// INV-06 回底同样用立即滚动：守住位置 scrollToBottom 的 instant 参数；改错故障 与 INV-02 不一致。
// INV-07 空态允许完全覆盖：守住位置 children 的空值合并；改错故障 自定义空态与默认文案同时出现。
// INV-08 下载内容按 parts 拼文本：守住位置 文本类型过滤；改错故障 工具调用片段混进导出文本。
// INV-09 导出格式可由调用方替换：守住位置 formatMessage 默认参数；改错故障 无法定制为其它格式。
// INV-10 默认格式带角色前缀：守住位置 roleLabel 拼接；改错故障 导出内容分不清谁说的。
// INV-11 URL 必须回收：守住位置 revokeObjectURL；改错故障 每次下载泄漏一个 blob。
// INV-12 临时链接用完即移除：守住位置 link.remove()；改错故障 DOM 残留增加。
// INV-13 深层导入带 .js 后缀：守住位置 相对导入；改错故障 NodeNext 下解析失败。
// INV-14 文件头保留上游许可：守住位置 首段块注释；改错故障 违反 Apache-2.0 归属要求。
//
// 模块职责：会话消息区的滚动容器、空态、回到底部与导出按钮。
// 阅读顺序：先看 Conversation 的滚动策略，再看空态与回底按钮，最后看导出与 markdown 拼装。
/*
 * Derived from vercel/ai-elements (packages/elements/src/conversation.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

// 这些 ai-elements 组件本身就位于 @zcode/ui 包内部；如果继续写 @zcode/ui/... 自引用，
// TypeScript 在 NodeNext 下会先套用 package.json 的 exports，而当前并没有导出这些深层源码路径。
// 这里统一改成带 .js 后缀的相对导入，让源码、声明产物和消费方都按同一套 ESM 规则解析。
import { Button } from "../ui/button.js";
import { cn } from "../lib/utils.js";
import type { UIMessage } from "ai";
import { ArrowDownIcon, DownloadIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  // 滚动容器由上游库负责，本组件只改默认参数。
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    // 切任务时消息区会整段替换，之前 smooth 初始滚动和 resize 动画会把
    // “恢复历史消息 -> 自动吸底”做成一整段缓动，用户体感像侧边栏切过去后还在慢慢追底部。
    // 这里统一改成立即滚动，任务切换和流式渲染就不会再叠两层动画拖慢界面。
    initial="instant"
    resize="instant"
    // 语义上标成日志区，读屏可播报新消息。
    role="log"
    {...props}
  />
);

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

// `ConversationContent` 不参与滚动策略，只负责宽度与内边距。
export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content className={cn("w-full shrink-0 px-4", className)} {...props} />
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

// 空态文案有默认值，调用方可整体替换。
export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className,
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-ui-base">{title}</h3>
          {description && <p className="text-muted-foreground text-ui-base">{description}</p>}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  // 只有处于非底部时才需要回底入口。
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  // 回调保持稳定，避免按钮每次渲染重建。
  const handleScrollToBottom = useCallback(() => {
    void scrollToBottom("instant");
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted",
          className,
        )}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
};

// 只取文本片段，忽略工具与推理等非正文内容。
const getMessageText = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

export type ConversationDownloadProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
  messages: UIMessage[];
  filename?: string;
  formatMessage?: (message: UIMessage, index: number) => string;
};

// 角色首字母大写，形成 markdown 粗体前缀。
const defaultFormatMessage = (message: UIMessage): string => {
  const roleLabel = message.role.charAt(0).toUpperCase() + message.role.slice(1);
  return `**${roleLabel}:** ${getMessageText(message)}`;
};

// 消息之间用空行分隔，符合 markdown 段落语义。
export const messagesToMarkdown = (
  messages: UIMessage[],
  formatMessage: (message: UIMessage, index: number) => string = defaultFormatMessage,
): string => messages.map((msg, i) => formatMessage(msg, i)).join("\n\n");

export const ConversationDownload = ({
  messages,
  filename = "conversation.md",
  formatMessage = defaultFormatMessage,
  className,
  children,
  ...props
}: ConversationDownloadProps) => {
  const handleDownload = useCallback(() => {
    const markdown = messagesToMarkdown(messages, formatMessage);
    // MIME 明确为 markdown，浏览器下载后可直接预览。
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    // 回收放在移除链接之后，保证下载已开始。
    URL.revokeObjectURL(url);
  }, [messages, filename, formatMessage]);

  return (
    <Button
      className={cn(
        "absolute top-4 right-4 rounded-full dark:bg-background dark:hover:bg-muted",
        className,
      )}
      onClick={handleDownload}
      size="icon"
      type="button"
      variant="outline"
      {...props}
    >
      {children ?? <DownloadIcon className="size-4" />}
    </Button>
  );
};
