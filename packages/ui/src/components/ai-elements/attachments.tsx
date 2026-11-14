/*
 * Derived from vercel/ai-elements (packages/elements/src/attachments.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

// 会话输入区的附件展示层：把 AttachmentData 投影成 grid/inline/list 三种形态的 UI。
// 只负责分类、图标或缩略图、标签文案、删除按钮与 hover 卡片的编排；不负责上传、
// 拖拽解析、objectUrl 的创建与回收，也不负责点击后预览 Dialog 的内容，这些由调用方持有。
//
// INV-01 断言：source-document 先于 mediaType 判定，一律归类为 source —— 守住它的位置：getMediaCategory 首分支 —— 改错故障：来源文档按 image/* 走缩略图分支却没有 url，渲染成空白格子。
// INV-02 断言：mediaType 缺失时先取空串再判前缀 —— 守住它的位置：getMediaCategory 的 mediaType 取值 —— 改错故障：无 mediaType 的附件抛 TypeError，整条消息列表白屏。
// INV-03 断言：application/* 与 text/* 都归为 document —— 守住它的位置：getMediaCategory 末尾前缀分支 —— 改错故障：pdf、txt 附件退化成回形针 unknown 图标，用户无法区分文件类型。
// INV-04 断言：标签优先级 displayName 高于 source 标题高于文件名高于分类兜底 —— 守住它的位置：getAttachmentLabel —— 改错故障：重命名后的附件在 chip 上仍显示旧名，或图片标签变成空串。
// INV-05 断言：图片缩略图只在判别为 file 且有 url 时渲染 —— 守住它的位置：AttachmentPreview 首个分支 —— 改错故障：SourceDocumentUIPart 无 url 却进入 img，出现破图并触发异常请求。
// INV-06 断言：inline 变体的 video 必须退回类型图标，不内嵌播放器 —— 守住它的位置：AttachmentPreview 的 video+inline 分支 —— 改错故障：composer 的 objectUrl 被回收后 chip 里留下永久静止的黑框。
// INV-07 断言：grid/list 的 video 预览必须 muted、playsInline 且 aria-hidden —— 守住它的位置：video 元素属性 —— 改错故障：上传附件时自动出声、移动端被强制全屏，读屏还会把静音预览当独立媒体朗读。
// INV-08 断言：删除按钮的 click 必须先 stopPropagation 再调用 onRemove —— 守住它的位置：AttachmentRemove 的 handleClick —— 改错故障：点删除同时触发父级 onOpen，删除动作顺带打开预览 Dialog。
// INV-09 断言：消费者在 onClick 里 preventDefault 后不得再执行默认打开或删除 —— 守住它的位置：handleClick 的 defaultPrevented 早退 —— 改错故障：业务侧拦截失效，附件仍被打开或删除。
// INV-10 断言：Space 键触发展开时必须 preventDefault —— 守住它的位置：Attachment.handleKeyDown —— 改错故障：空格同时滚动页面，列表在展开预览的瞬间跳位。
// INV-11 断言：AttachmentRemove 的所有 hook 调用必须早于 onRemove 缺失的 null 早退 —— 守住它的位置：AttachmentRemove 函数体顺序 —— 改错故障：同一附件先有 onRemove 后被移除，hook 数量变化导致整块区域崩溃。
// INV-12 断言：附件根节点的 role 与 tabIndex 只在可打开时注入 —— 守住它的位置：Attachment 的 isOpenable —— 改错故障：纯展示附件被 Tab 键捕获并朗读为按钮，键盘用户陷入无法激活的空控件。
//
// 三种变体的边界：grid 为等比缩略图方块，inline 为单行 chip（可带渐变删除区），
// 列表变体为整行卡片；变体由最近一层 Attachments 下发，单个 Attachment 可局部覆盖，
// 二者同时成立才生效。
import { Button } from "../ui/button.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card.js";
import { cn } from "../lib/utils.js";
import type { FileUIPart, SourceDocumentUIPart } from "ai";
import {
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  Music2Icon,
  PaperclipIcon,
  PlayIcon,
  VideoIcon,
  XIcon,
} from "lucide-react";
import type {
  ComponentProps,
  HTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { createContext, useCallback, useContext, useMemo } from "react";

// ============================================================================
// Types
// ============================================================================

// 联合类型的判别字段是 type：file 走 mediaType 分类，source-document 直接归 source。
// sourceKind 只是来源标记，不参与归类；新增成员时必须同步 mediaCategoryIcons 与
// getMediaCategory，否则新分类会静默落到 unknown 的回形针图标。
export type AttachmentData =
  | (FileUIPart & {
      id: string;
      description?: string;
      displayName?: string;
      sourceKind?: "clipboard-text";
    })
  | (SourceDocumentUIPart & {
      id: string;
      description?: string;
      displayName?: string;
      sourceKind?: "clipboard-text";
    });

// 分类集合是封闭枚举，被 mediaCategoryIcons 的 Record 类型穷尽检查；
// 新增成员会立刻在图标表报缺项，不要用 string 放宽此类型。
export type AttachmentMediaCategory =
  | "image"
  | "video"
  | "audio"
  | "document"
  | "source"
  | "unknown";

// 缩略图墙用 grid、输入框 chip 用 inline、整行清单用 list；
// 三个变体在布局与预览策略上分叉，不能靠缺省值混用。
export type AttachmentVariant = "grid" | "inline" | "list";

// [契约] 分类到图标的唯一映射，Record 保证每个分类都有值；不要在这里写尺寸类，
// 尺寸由调用处 iconSize 决定，写死会让 inline 的 size-3 无法覆盖。
const mediaCategoryIcons: Record<AttachmentMediaCategory, typeof ImageIcon> = {
  audio: Music2Icon,
  document: FileTextIcon,
  image: ImageIcon,
  source: GlobeIcon,
  unknown: PaperclipIcon,
  video: VideoIcon,
};

// ============================================================================
// Utility Functions
// ============================================================================

// [契约] 判定顺序即语义：先看 source-document，再看 mediaType 前缀。
// 若把 source-document 挪到前缀判断之后，带 image/* 的来源文档会被当成图片，
// 而它没有 url 可渲染，缩略图位置只剩一片空白。
export const getMediaCategory = (data: AttachmentData): AttachmentMediaCategory => {
  if (data.type === "source-document") {
    return "source";
  }

  const mediaType = data.mediaType ?? "";

  if (mediaType.startsWith("image/")) {
    return "image";
  }
  if (mediaType.startsWith("video/")) {
    return "video";
  }
  if (mediaType.startsWith("audio/")) {
    return "audio";
  }
  if (mediaType.startsWith("application/") || mediaType.startsWith("text/")) {
    return "document";
  }

  return "unknown";
};

// 展示名优先级被 UI 直接信任：displayName 覆盖一切，其次是 source 的标题，
// 最后才回退文件名。不要在这条链中间插入 trim 或默认值，
// 空串会被当作有效名称，让 chip 变成只有图标的空标签。
export const getAttachmentLabel = (data: AttachmentData): string => {
  if (data.displayName) {
    return data.displayName;
  }

  if (data.type === "source-document") {
    return data.title || data.filename || "Source";
  }

  const category = getMediaCategory(data);
  return data.filename || (category === "image" ? "Image" : "Attachment");
};

// [权衡] 缩略图用原生 img 而非框架图片组件：这里只有 blob 与 data URL，
// 没有远端优化收益；96 与 20 两个尺寸只为 grid 与 chip 各取一次采样。
const renderAttachmentImage = (url: string, filename: string | undefined, isGrid: boolean) =>
  isGrid ? (
    <img
      alt={filename || "Image"}
      className="size-full object-cover"
      height={96}
      src={url}
      width={96}
    />
  ) : (
    <img
      alt={filename || "Image"}
      className="size-full rounded object-cover"
      height={20}
      src={url}
      width={20}
    />
  );

// ============================================================================
// Contexts
// ============================================================================

interface AttachmentsContextValue {
  variant: AttachmentVariant;
}

// Attachments 下发的变体上下文。缺失时由 useAttachmentsContext 兜底为 grid，
// 因为容器可能被脱离列表单独渲染；这与 Attachment 上下文的严格抛错相反，
// 不要统一成同一种行为，那会让孤立使用的 Attachments 直接崩溃。
const AttachmentsContext = createContext<AttachmentsContextValue | null>(null);

interface AttachmentContextValue {
  data: AttachmentData;
  mediaCategory: AttachmentMediaCategory;
  onRemove?: () => void;
  variant: AttachmentVariant;
}

const AttachmentContext = createContext<AttachmentContextValue | null>(null);

// ============================================================================
// Hooks
// ============================================================================

// [契约] 这里返回兜底对象而非抛错，调用方可在任意位置安全读取变体；
// 兜底值必须保持 grid，与 Attachments 的默认变体一致。
export const useAttachmentsContext = () =>
  useContext(AttachmentsContext) ?? { variant: "grid" as const };

// Attachment 的子组件离开 Attachment 就没有数据可渲染，这里选择抛错把误用暴露在开发期；
// 错误文案是使用方的断言依据，不要改成静默兜底，
// 否则 AttachmentInfo 会拿着 undefined 的 data 走进 getAttachmentLabel 并崩溃。
export const useAttachmentContext = () => {
  const ctx = useContext(AttachmentContext);
  if (!ctx) {
    throw new Error("Attachment components must be used within <Attachment>");
  }
  return ctx;
};

// ============================================================================
// Attachments - Container
// ============================================================================

// 容器透传 div 的全部属性，variant 只决定布局方向；
// `AttachmentsProps` 只透传 div 属性与 `variant`；滚动与虚拟化由上层列表负责。
export type AttachmentsProps = HTMLAttributes<HTMLDivElement> & {
  variant?: AttachmentVariant;
};

export const Attachments = ({
  variant = "grid",
  className,
  children,
  ...props
}: AttachmentsProps) => {
  // [权衡] 依赖只有 variant，变体不变时对象引用保持稳定；
  // 若改成每次渲染新建对象，任意父级重渲染都会让全部附件重绘。
  const contextValue = useMemo(() => ({ variant }), [variant]);

  return (
    <AttachmentsContext.Provider value={contextValue}>
      <div
        className={cn(
          "flex items-start",
          variant === "list" ? "flex-col gap-2" : "flex-wrap gap-2",
          variant === "grid" && "ml-auto w-fit",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </AttachmentsContext.Provider>
  );
};

// ============================================================================
// Attachment - Item
// ============================================================================

// onRemove 缺失会让删除按钮整体返回 null，onOpen 缺失则关闭全部可打开交互；
// 两个回调都可选，组件必须在都缺席时退化为纯展示。
export type AttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: AttachmentData;
  variant?: AttachmentVariant;
  onRemove?: () => void;
  onOpen?: () => void;
  openLabel?: string;
};

export const Attachment = ({
  data,
  variant: variantOverride,
  onRemove,
  onOpen,
  openLabel,
  className,
  children,
  onClick,
  onKeyDown,
  role,
  tabIndex,
  "aria-label": ariaLabel,
  ...props
}: AttachmentProps) => {
  const { variant: contextVariant } = useAttachmentsContext();
  const variant = variantOverride ?? contextVariant;
  const mediaCategory = getMediaCategory(data);
  // 可打开性由 onOpen 是否存在单点决定：下面的 role、tabIndex、cursor 与键盘处理
  // 全部从它派生。新增交互入口时必须继续引用这个布尔值，而不是各自判断 onOpen，
  // 否则会出现可聚焦却无角色、或声明成按钮却点不开的半开状态。
  const isOpenable = Boolean(onOpen);

  // [权衡] data 以引用参与依赖：调用方每次渲染新建 data 时子组件都会重渲染，
  // 这是有意保留的简单契约；不要在内部做深比较缓存，
  // 那会让重命名、替换文件等数据更新被旧引用吞掉。
  const contextValue = useMemo<AttachmentContextValue>(
    () => ({ data, mediaCategory, onRemove, variant }),
    [data, mediaCategory, onRemove, variant],
  );

  // 上传后的图片附件之前只是普通 div，没有打开预览的交互入口。
  // 这里把可打开附件统一补成 click + Enter/Space，既修复鼠标点击，也保留键盘可访问性。
  // [契约] 先执行外部 onClick，再检查 defaultPrevented，消费者借此否决打开；
  // 顺序不能反，否则业务侧拦截永远慢一步。
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) {
        return;
      }
      onOpen?.();
    },
    [onClick, onOpen],
  );

  // 只处理 Enter 与 Space，且必须先判断 onOpen 是否为空；
  // Space 不 preventDefault 会同时滚动页面，Enter 则会重复触发原生点击，
  // 这两条是键盘可访问性的最小要求，不要为简化合并成一个分支。
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || !onOpen) {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onOpen();
      }
    },
    [onKeyDown, onOpen],
  );

  return (
    <AttachmentContext.Provider value={contextValue}>
      <div
        aria-label={ariaLabel ?? openLabel}
        className={cn(
          "group relative",
          variant === "grid" && "size-24 overflow-hidden rounded-lg",
          variant === "inline" && [
            "flex h-8 select-none items-center gap-0.5",
            "overflow-hidden rounded-md border border-border p-1 pr-2.5",
            "font-medium text-ui-base transition-all",
            "bg-background",
            "[--attachment-bg:var(--color-background)]",
          ],
          variant === "list" && [
            "flex w-full items-center gap-3 rounded-lg border p-3",
            "hover:bg-accent/50",
          ],
          isOpenable && [
            "cursor-pointer hover:border-border-hover hover:text-accent-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          ],
          !isOpenable && "cursor-default",
          className,
        )}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        role={role ?? (isOpenable ? "button" : undefined)}
        tabIndex={tabIndex ?? (isOpenable ? 0 : undefined)}
        {...props}
      >
        {children}
      </div>
    </AttachmentContext.Provider>
  );
};

// ============================================================================
// AttachmentPreview - Media preview
// ============================================================================

// fallbackIcon 供业务方按扩展名定制占位图标，它优先于分类图标表，
// 但不影响图片与视频分支。
export type AttachmentPreviewProps = HTMLAttributes<HTMLDivElement> & {
  fallbackIcon?: ReactNode;
};

export const AttachmentPreview = ({
  fallbackIcon,
  className,
  ...props
}: AttachmentPreviewProps) => {
  const { data, mediaCategory, variant } = useAttachmentContext();

  // chip 内的图标比卡片小一档，尺寸同时作用于容器与 SVG；
  // 改这里要同步检查 inline 的 h-8 行高，否则图标会撑破圆角边框。
  const iconSize = variant === "inline" ? "size-3" : "size-4";

  const renderIcon = (Icon: typeof ImageIcon) => (
    <Icon className={cn(iconSize, "text-muted-foreground")} />
  );

  const renderContent = () => {
    // [失败路径] 三个条件缺一不可：分类为 image、判别为 file、url 非空。
    // 来源文档归类为 source 不会到这里；少了 url 判断，img 会以空 src 命中当前页面，
    // 控制台出现反复的异常请求且缩略图永久空白。
    if (mediaCategory === "image" && data.type === "file" && data.url) {
      return renderAttachmentImage(data.url, data.filename, variant === "grid");
    }

    // [失败路径] 这段必须排在下面完整 video 分支之前：inline 先拦截，chip 只显示图标；
    // 一旦走完整 video，objectUrl 在提交后回收，chip 会留下永远加载失败的黑色静帧。
    // Composer 的 video objectUrl 曾让 inline chip 嵌入一个静音播放器，
    // 从而丢失文件类型图标；完整视频预览由点击后的共享 Dialog 负责。
    if (mediaCategory === "video" && variant === "inline") {
      return renderIcon(mediaCategoryIcons.video);
    }

    // 只有 grid 与 list 才内嵌 video：muted 阻止上传时自动出声，playsInline 避免移动端强制全屏，
    // preload=metadata 只取首帧；aria-hidden 让读屏跳过，播放入口是点击后的共享 Dialog。
    if (mediaCategory === "video" && data.type === "file" && data.url) {
      return (
        <video
          aria-hidden="true"
          className="size-full object-cover"
          muted
          playsInline
          preload="metadata"
          src={data.url}
        />
      );
    }

    // 兜底：Record 约束下分类图标必有值，这里无需判空；
    // fallbackIcon 优先，供业务覆盖未知类型外观，但不要用它替换图片分支。
    const Icon = mediaCategoryIcons[mediaCategory];
    return fallbackIcon ?? renderIcon(Icon);
  };

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden",
        variant === "grid" && "size-full bg-muted",
        variant === "inline" && "size-5 rounded bg-background",
        variant === "list" && "size-12 rounded bg-muted",
        className,
      )}
      {...props}
    >
      {renderContent()}
      {mediaCategory === "video" && variant === "grid" ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 m-auto flex size-7 items-center justify-center rounded-full bg-black/55 text-white shadow-sm backdrop-blur-sm"
          data-attachment-video-play-overlay="true"
        >
          <PlayIcon className="size-4 translate-x-px fill-current" />
        </span>
      ) : null}
    </div>
  );
};

// ============================================================================
// AttachmentInfo - Name and type display
// ============================================================================

// showMediaType 只在有空间的变体里显示 MIME，默认关闭；
// `showMediaType` 只决定是否显示 MIME 文本，不参与分类判断。
export type AttachmentInfoProps = HTMLAttributes<HTMLDivElement> & {
  showMediaType?: boolean;
};

export const AttachmentInfo = ({
  showMediaType = false,
  className,
  ...props
}: AttachmentInfoProps) => {
  const { data, variant } = useAttachmentContext();
  const label = getAttachmentLabel(data);
  const description = data.description;

  // [契约] grid 只显示画面，名称与描述交给 hover 卡片；
  // 这里若返回内容，缩略图会被文字挤出 24×24 的方块。
  if (variant === "grid") {
    return null;
  }

  // inline 有描述时压成一行「名称 · 描述」，内层 span 是截断边界；
  // 去掉它，truncate 会作用到外层，描述换行后 chip 高度溢出。
  if (variant === "inline" && description) {
    return (
      <div className={cn("min-w-0 flex-1", className)} {...props}>
        <span className="block truncate">
          {label}
          <span className="text-foreground-subtle"> · {description}</span>
        </span>
      </div>
    );
  }

  return (
    <div className={cn("min-w-0 flex-1", className)} {...props}>
      <span className="block truncate">{label}</span>
      {description ? (
        <span className="block truncate text-muted-foreground text-ui-base">{description}</span>
      ) : null}
      {showMediaType && data.mediaType && (
        <span className="block truncate text-muted-foreground text-ui-base">{data.mediaType}</span>
      )}
    </div>
  );
};

// ============================================================================
// AttachmentRemove - Remove button
// ============================================================================

// placement=corner 表示按钮不占布局、用绝对定位压角，default 由变体自选位置；
// label 同时用作 aria-label 与屏读文本，必须与图标语义一致。
export type AttachmentRemoveProps = ComponentProps<typeof Button> & {
  alwaysVisible?: boolean;
  label?: string;
  placement?: "default" | "corner";
};

export const AttachmentRemove = ({
  alwaysVisible = false,
  label = "Remove",
  placement = "default",
  className,
  children,
  onClick,
  onPointerDown,
  ...props
}: AttachmentRemoveProps) => {
  const { onRemove, variant } = useAttachmentContext();

  // [契约] 删除的三步顺序是语义核心：先 stopPropagation 切断冒泡到附件根节点，
  // 再给业务 onClick 一次否决机会，最后 preventDefault 并执行 onRemove。
  // 把 stopPropagation 挪后，点删除会同时触发根节点 onOpen；
  // 把 preventDefault 挪到 onClick 之前，业务侧就无法用 defaultPrevented 拦截删除。
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onClick?.(event);
      if (event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      onRemove?.();
    },
    [onClick, onRemove],
  );

  // 指针按下同样要隔离，否则根节点会把手势当成点击起始，
  // 拖拽或长按过程中就提前打开预览。
  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onPointerDown?.(event);
    },
    [onPointerDown],
  );

  // [失败路径] 早退必须放在两个 useCallback 之后：hook 数量在任何 props 组合下都要一致，
  // 附件被移除后 onRemove 变成 undefined，若在 hook 之前返回，
  // 会因少调用 hook 抛「Rendered fewer hooks」并让整块区域崩溃。
  if (!onRemove) {
    return null;
  }

  // [权衡] inline 删除区用外层 pointer-events-none 加按钮 pointer-events-auto 两层包裹：
  // 外层占位防抖动，内层才接收点击；只留一层会让 chip 右侧整块吞掉点击。
  if (variant === "inline" && placement === "default") {
    return (
      <span
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 z-10 flex items-center transition-opacity duration-150 ease-out",
          alwaysVisible
            ? "opacity-100"
            : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
        )}
      >
        <span className="h-full w-2 bg-gradient-to-r from-transparent to-[var(--attachment-bg)] transition-colors" />
        <span className="pointer-events-auto flex h-full w-6 items-center justify-center bg-[var(--attachment-bg)] transition-colors">
          <Button
            aria-label={label}
            className={cn("rounded-md", "[&>svg]:size-3", className)}
            onClick={handleClick}
            onPointerDown={handlePointerDown}
            size="icon-xs"
            type="button"
            variant="ghost"
            {...props}
          >
            {children ?? <XIcon />}
            <span className="sr-only">{label}</span>
          </Button>
        </span>
      </span>
    );
  }

  return (
    <Button
      aria-label={label}
      className={cn(
        variant === "grid" && [
          "absolute top-2 right-2 size-6 rounded-full p-0",
          "bg-background/80 backdrop-blur-sm",
          "opacity-0 transition-opacity group-hover:opacity-100",
          "hover:bg-background",
          "[&>svg]:size-3",
        ],
        variant === "list" && ["size-8 shrink-0 rounded p-0", "[&>svg]:size-4"],
        className,
      )}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <XIcon />}
      <span className="sr-only">{label}</span>
    </Button>
  );
};

// ============================================================================
// AttachmentHoverCard - Hover preview
// ============================================================================

// 附件预览默认零延迟，悬停即出；这里只把延迟提到外层 API，不改底层行为。
// 调用方传入的延迟原样透传，不要在此叠加常量。
export type AttachmentHoverCardProps = ComponentProps<typeof HoverCard>;

export const AttachmentHoverCard = ({
  openDelay = 0,
  closeDelay = 0,
  ...props
}: AttachmentHoverCardProps) => (
  <HoverCard closeDelay={closeDelay} openDelay={openDelay} {...props} />
);

export type AttachmentHoverCardTriggerProps = ComponentProps<typeof HoverCardTrigger>;

export const AttachmentHoverCardTrigger = (props: AttachmentHoverCardTriggerProps) => (
  <HoverCardTrigger {...props} />
);

// 内容宽度由内容决定，调用方的 className 后置覆盖，便于按附件类型定制预览尺寸。
// 默认对齐 start，避免预览卡在窄屏被挤出视口。
export type AttachmentHoverCardContentProps = ComponentProps<typeof HoverCardContent>;

export const AttachmentHoverCardContent = ({
  align = "start",
  className,
  ...props
}: AttachmentHoverCardContentProps) => (
  <HoverCardContent align={align} className={cn("w-auto p-2", className)} {...props} />
);

// ============================================================================
// AttachmentEmpty - Empty state
// ============================================================================

// `AttachmentEmpty` 只做居中占位：加载态与错误态由调用方自己渲染。
// 调用方传 children 即可覆盖默认文案。
export type AttachmentEmptyProps = HTMLAttributes<HTMLDivElement>;

export const AttachmentEmpty = ({ className, children, ...props }: AttachmentEmptyProps) => (
  <div
    className={cn(
      "flex items-center justify-center p-4 text-muted-foreground text-ui-base",
      className,
    )}
    {...props}
  >
    {children ?? "No attachments"}
  </div>
);
