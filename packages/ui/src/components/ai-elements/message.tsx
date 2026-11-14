// ============================================================================================
// L1 深度注释：消息正文渲染层（packages/ui/src/components/ai-elements/message.tsx）
// 责任边界：把一条消息的正文（markdown 字符串或 ReactNode）投影成气泡、文件链接、外链、
// 代码块与降级纯文本；不拉取数据、不持有会话事实、不决定消息是否应该出现。
// 读法：先看 INV 表，再看 MessageResponse（唯一有状态的复杂组件），最后看预处理管线。
// ============================================================================================
// INV-1: role 只决定视觉归属（is-user / is-assistant），绝不参与内容类型分支 —— 破坏后果：assistant 的工具/附件块会被错误当成正文渲染。
// INV-2: 正文只有一条来源：children 经 extractCodeText 拍平成 markdown 字符串，其后所有投影都基于这份字符串 —— 破坏后果：两处各读一次 children，流式期间会渲染出互相矛盾的两份正文。
// INV-3: 管线顺序固定为 citation 投影 → 连续图片块归一 → 单美元公式归一 → artifact 图片重写，不可交换 —— 破坏后果：公式归一先跑会把 citation 生成的符号当数学文本二次转义。
// INV-4: 单美元公式归一必须跳过 fenced code 与 inline code —— 破坏后果：代码里的 $HOME、shell 变量会被塞进反斜杠，渲染出的代码与真实代码不一致。
// INV-5: 归一化只“转义当前 $”，从不删除字符 —— 破坏后果：一旦删字符，citation 偏移与 boundaryResetKey 的 markdownLength 都会错位。
// INV-6: $5-$10 这类紧凑价格区间的第二个 $ 不得被当成公式闭合符 —— 破坏后果：金额被渲染成公式，读者看到的是倾斜的乱码。
// INV-7: singleTilde 必须在 remark-gfm 与 CJK 删除线扩展两处同时关闭 —— 破坏后果：任一处漏关，~text~ 会被渲染成删除线而不是原文。
// INV-8: 一旦显式传 remarkPlugins，就必须把默认插件一起传入 —— 破坏后果：表格、任务列表等 GFM 能力整体退化成普通段落。
// INV-9: windowsFileLinkEscapeRemarkPlugin 无条件启用，不挂 renderZCodeFileCitations 开关 —— 破坏后果：关掉 citation 的文件里，Windows 路径链接静默失效。
// INV-10: 文件链接改写 rehype 插件必须排在 harden 之前 —— 破坏后果：harden 先把 file:// 与裸文件名标成 blocked，自定义链接渲染器再也拿不到原始 href。
// INV-11: 改写只针对“能落到工作区内的相对/裸文件名”；越界路径在改写前用词法校验拦下 —— 破坏后果：URL 归一吞掉 .. 后，点击层无法还原用户的逃逸意图。
// INV-12: Windows 盘符路径临时补 / 前缀只为过安全层，打开前必须还原 —— 破坏后果：补出来的 /C:/... 被当成绝对路径打开，文件永远找不到。
// INV-13: streaming 模式只给真实流式输出用，终态内容固定 static —— 破坏后果：已完成的长消息进入 Streamdown 的更新循环，生产上触发 React #185。
// INV-14: streaming/static 不是 React key 的组成部分 —— 破坏后果：流式状态抖动会卸载整棵 markdown 子树，正文重新触发淡入。
// INV-15: renderKey 必须覆盖所有只存在于渲染器闭包里的输入（theme、session、attachment reader）—— 破坏后果：值变了但 key 没变，已挂载的代码块/图片不会重建。
// INV-16: attachmentReaderEpoch 用 WeakMap 按函数身份分配，同一 reader 恒定、换 reader 递增 —— 破坏后果：每次渲染都算新 epoch，markdown 子树逐帧重挂载。
// INV-17: 错误边界的 resetKey 在 streaming 下不含 markdown 哈希，终态才含 —— 破坏后果：流式每帧变 key，边界状态与子树一起反复重建。
// INV-18: 单条 markdown 渲染异常必须降级为纯文本，不能冒泡 —— 破坏后果：一条坏消息把整个会话区打成白屏。
// INV-19: 降级不可自愈，只有 resetKey 变化才清除错误 —— 破坏后果：同一份坏 markdown 无限重试，渲染次数翻倍。
// INV-20: 代码块与行内代码按 data-block 存在性区分，不靠 language- 类名 —— 破坏后果：无语言标注的围栏被当成行内代码，整段代码挤进一行。
// INV-21: 代码语言缺省为 text —— 破坏后果：缺省成空串会让 highlighter 抛错，代码块退化成空白。
// INV-22: 流式期间关闭语法高亮与 mermaid —— 破坏后果：异步 highlighter 与消息流更新叠加，再次触发 React #185。
// INV-23: forceCodeWrap 是办公模式的硬覆盖，且必须同时隐藏换行开关 —— 破坏后果：用户能在正式回答里把已锁定的换行改回去。
// INV-24: 判断文件类型只能靠点击时的 stat，渲染期禁止猜 —— 破坏后果：无扩展名文件（env、hosts）被误判成目录。
// INV-25: 目录图标只认显式尾随斜杠 —— 破坏后果：config、Makefile 这类文件被画成文件夹图标。
// INV-26: 缺失 workspace file service 时必须拒绝打开 —— 破坏后果：绕过 stat 直接调本机应用，可能打开 workspace 外的路径。
// INV-27: 编辑器列表懒加载且单飞（editorsLoaded / loadingEditors）—— 破坏后果：每次右键菜单打开都重新枚举一遍本机应用。
// INV-28: 外链只放行可解析的 http/https，其它协议保持不可点击 —— 破坏后果：javascript:、file: 这类 href 变成可执行入口。
// INV-29: 左键默认目标与右键“强制目标”互不覆盖；meta/ctrl 强制走系统浏览器 —— 破坏后果：菜单里两个方向相反的项都跳同一个目标。
// INV-30: 缺少 Desktop platform 时退回调用方的安全 handler —— 破坏后果：为了少一个依赖把整棵 markdown 降级成纯文本。
// INV-31: memo 比较函数必须覆盖全部 props，一项都不能漏 —— 破坏后果：漏掉的 prop 变化时组件不刷新，界面与状态静默不一致。
// INV-32: 复制文本必须是“将要展示的正文”，且去掉围栏尾部空行 —— 破坏后果：复制出的代码比屏幕上的多一个空行。
// INV-33: 正文不解析原始 HTML（不挂 rehype-raw）—— 破坏后果：模型输出里的 script/onerror 进入 DOM。
// INV-34: 只读主题/设置必须引用稳定，默认值必须是模块级常量 —— 破坏后果：内联默认对象每次渲染都换引用，memo 全体失效。
/*
 * Derived from vercel/ai-elements (packages/elements/src/message.tsx).
 * Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
 * Modified by ZCode: local integration, formatting and adaptations.
 * See THIRD-PARTY-NOTICES.md in the repository root for license and provenance.
 */
"use client";

import { Button } from "../ui/button.js";
import { ButtonGroup, ButtonGroupText } from "../ui/button-group.js";
import { cn } from "../lib/utils.js";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { EditorInfo, FileStat, OpenInEditorOptions } from "@zcode/shared";
import type { UIMessage } from "ai";
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough";
import type {
  ComponentProps,
  ErrorInfo,
  HTMLAttributes,
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode,
} from "react";
import {
  Component,
  createContext,
  forwardRef,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { BundledTheme } from "shiki";
import { defaultRehypePlugins, defaultRemarkPlugins, Streamdown } from "streamdown";
import type { Pluggable, PluggableList } from "unified";
import { CodeBlock, CodeBlockHeader } from "@/components/ai-elements/code-block.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { MarkdownBlockquote } from "@/components/ai-elements/markdown-blockquote.js";
import {
  MarkdownListItem,
  MarkdownOrderedList,
  MarkdownUnorderedList,
} from "@/components/ai-elements/markdown-list.js";
import {
  MarkdownTable,
  MarkdownTableBody,
  MarkdownTableCell,
  MarkdownTableHead,
  MarkdownTableHeader,
  MarkdownTableRow,
} from "@/components/ai-elements/markdown-table.js";
import {
  MarkdownImage,
  MarkdownImageParagraph,
  normalizeConsecutiveMarkdownImageBlocks,
  type MarkdownImageProps,
} from "@/components/ai-elements/markdown-image.js";
import { STREAMDOWN_CONTROLS } from "@/components/ai-elements/streamdown-controls.js";
import { resolveMessageLinkOpenTarget } from "@/embeddedBrowserHelpers.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { persistLastSelectedEditorId, readLastSelectedEditorId } from "@/lib/editorPreference.js";
import {
  FileDisplayIcon,
  FOLDER_FILE_ICON_SRC,
  resolveFileDisplayDescriptor,
} from "@/lib/fileDisplay.js";
import {
  normalizeWorkspaceRelativeFilePath,
  parseMarkdownFileLinkTarget,
  resolveMarkdownFileLink,
} from "@/lib/markdownFileLink.js";
import { stripBalancedAssistantPathQuotes } from "@/lib/assistantPathQuotes.js";
import { getPathLeaf } from "@/lib/path.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";
import { resolveWorkspaceEditorSelection } from "@/lib/workspaceEditorSelection.js";
import { sortInstalledEditorsForFileTree } from "@/workspace-file-tree/helpers.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useOptionalPlatform, usePlatform } from "@/hooks/usePlatform.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { Theme } from "@/useTheme.js";
import { createZCodeFileCitationRemarkPlugin } from "@/lib/zcodeFileCitationRemarkPlugin.js";
import { windowsFileLinkEscapeRemarkPlugin } from "@/lib/windowsFileLinkEscapeRemarkPlugin.js";
import { projectZCodeFileCitations } from "@/lib/zcodeFileCitation.js";
import { rewriteMarkdownArtifactImageSources } from "@zcode/shared";

// [权衡] 归属只写进 class 而不是拆成两个组件：拆分会把 role 变成结构差异，
// 上层任何一次 role 归一化（例如 system→assistant）都要同步改结构；用 class 则
// 只影响视觉，DOM 结构对所有角色一致，虚拟列表也不必按 role 重建节点。
export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className,
    )}
    {...props}
  />
);

// [权衡] 气泡宽度取 w-fit + max-w-full 而不是固定宽度：短消息不该撑满整行，
// 长内容又必须能在窄屏收缩。min-w-0 是必需的：flex 子项默认 min-width:auto，
// 缺了它代码块会把气泡顶出容器，横向滚动条跑到整个会话区上。
export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-ui-base",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

// [失败路径] 这里不渲染任何按钮，只为工具栏提供统一间距；children 为空时会留下
// 一条带 min 高度的空行，因此是否渲染必须由上层按正文/动作存在性自行门控。
export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

// [权衡] tooltip 与 label 是两个字段：label 是读屏可见的语义名称，tooltip 是鼠标
// 提示文案，二者常写成同一句话，但纯图标按钮必须有 sr-only 文本，否则 Tab 聚焦后
// 没有任何可读名称。没有 tooltip 时直接返回按钮，不为空提示多挂一层 Tooltip Provider。
export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <ControlHintTooltip title={tooltip} side="bottom">
        {button}
      </ControlHintTooltip>
    );
  }

  return button;
};

// [事务] currentBranch 是唯一选中态，branches 只是子节点的影子副本：二者可能在
// children 变化的同一帧内不一致（选中索引停留在旧范围）。因此渲染层必须容忍越界索引，
// 由翻页逻辑把它拉回合法区间，而不是在 setBranches 里做 clamp —— 在 effect 里改索引
// 会与用户点击竞争，出现“点一下跳两格”。
interface MessageBranchContextType {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(null);

// [失败路径] 这里必须抛错而不是返回空实现：分支组件脱离 Provider 后会静默失去
// 翻页能力，症状是“点了没反应”，比一条带栈的异常更难定位。
const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error("MessageBranch components must be used within MessageBranch");
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch);
      onBranchChange?.(newBranch);
    },
    [onBranchChange],
  );

  // [权衡] 到边界后回绕而不是禁用：分支通常只有 2~3 个，禁用会让用户以为没有其它分支。
  // 回绕长度取 branches.length 而不是 children.length：setBranches 是异步的，同一帧内
  // branches 可能还是上一批子节点，用 children 长度会在切换瞬间跳到错误分支。
  const goToPrevious = useCallback(() => {
    const newBranch = currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const goToNext = useCallback(() => {
    const newBranch = currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  // [权衡] contextValue 用 useMemo 包住：Provider 的 value 换引用会让所有消费者
  // 重新渲染，分支多时一次翻页会连带整棵分支树；这里只依赖真正会变的三项。
  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious],
  );

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div className={cn("grid w-full gap-2 [&>div]:pb-0", className)} {...props} />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({ children, ...props }: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = useMemo(
    () => (Array.isArray(children) ? children : [children]),
    [children],
  );

  // [失败路径] 只在长度变化时回写 branches：父级每次渲染重建 JSX 数组时引用必变，
  // 若无条件 set，effect → setState → 重渲染 会变成稳定的渲染循环。
  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  // [资源] 非当前分支用 hidden 而不是不渲染：卸载会让分支内的图片、代码高亮反复重建，
  // 也会丢失内部滚动位置；hidden 只影响布局与可访问性，保留子树状态。
  // key 取 branch.key，因此调用方必须给每个分支稳定 key，否则翻页会错位复用 DOM。
  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden",
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

// [失败路径] 只有一个分支时整体返回 null：翻页器对单分支毫无信息量，
// 但内容与 Provider 仍保留，调用方不必判断“要不要多包一层”。
export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>;

export const MessageBranchSelector = ({ className, ...props }: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className={cn(
        "[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md",
        className,
      )}
      orientation="horizontal"
      {...props}
    />
  );
};

  // [失败路径] totalBranches 为 0（子节点尚未同步）时禁用两个箭头：此时
  // goToNext 会算出 -1，点击等于把索引写坏，下一帧渲染成空白。
export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({ children, ...props }: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({ children, ...props }: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
};

// [权衡] 页码按 1 基展示（currentBranch + 1）：这是唯一对用户可见的“第几条”，
// 内部索引保持 0 基，转换只发生在这一处，避免两种口径散落到状态层。
export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({ className, ...props }: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn("border-none bg-transparent text-muted-foreground shadow-none", className)}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

export type MessageResponseProps = {
  // [权衡] forceCodeWrap 走独立 prop 而不是改写 codePreviewSettings：设置属于用户偏好，
  // 必须原样保存；办公模式只是“本次渲染的有效值”。合并进设置会让用户下次打开普通会话时
  // 发现自己的换行偏好被偷偷改掉，且没有任何入口能改回来。
  /** 办公模式的正式回答固定换行，不覆盖用户保存的代码预览设置。 */
  forceCodeWrap?: boolean;
  className?: string;
  children?: ReactNode;
  dir?: "auto" | "ltr" | "rtl";
  streaming?: boolean;
  streamingAnimationKey?: string;
  workspacePath?: string;
  workspaceHomePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  sessionId?: string;
  // [资源] readAttachment 是异步读 blob 的入口，身份变化意味着权限/会话上下文换了；
  // 它只被 img 渲染器闭包捕获，因此必须经 renderKey 的 epoch 参与重挂载（见 INV-15）。
  readAttachment?: (params: {
    sessionId: string;
    ref: string;
  }) => Promise<{ bytes: Uint8Array; mediaType: string } | { url: string; mediaType: string }>;
  /**
   * 应用主题（store 耦合剥离）：决定代码块高亮取 light/dark 主题。
   * 由调用方从上层状态传入；默认 "system" 跟随操作系统，供待删旧调用点兜底。
   */
  theme?: Theme;
  /**
   * 代码预览设置（store 耦合剥离）：由调用方传入，需保持引用稳定。
   * 默认 DEFAULT_CODE_PREVIEW_SETTINGS。
   */
  codePreviewSettings?: CodePreviewSettings;
  // [权衡] 三个打开动作都做成可选回调而不是组件内部直连服务：MessageResponse 同时
  // 被聊天、预览、工具面板复用，各自的路由与权限不同；组件只负责把“用户点了什么”
  // 交出去，缺省时退化成不可点击，而不是擅自打开。
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenExternalUrl?: (url: string) => void;
  /** 仅 Assistant 正文开启：把完整 zcode-file-citation 投影为现有文件链接。 */
  renderZCodeFileCitations?: boolean;
};

export interface MessageFileLinkTarget {
  path: string;
  label: string;
  /** 仅用于显式尾随斜杠的目录展示提示；打开第三方应用前必须重新 stat。 */
  pathKind?: NonNullable<OpenInEditorOptions["pathKind"]>;
  relativePath?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

// [权衡] 只在模块级创建一次并复用：createMathPlugin 每次调用都新建 attacher，
// 放进组件体会让 plugins 数组每帧换引用，Streamdown 的 memo 边界直接失效，
// 流式期间每次 delta 都重新挂载整棵 markdown 子树。
// @streamdown/math 默认不解析 `$...$` 行内公式，导致客户消息里块级 `$$...$$`
// 能渲染而 `$c(\mathbf{r})$` 会原样显示；聊天消息需要兼容常见 Markdown/LaTeX 输出。
const messageMathPlugin = createMathPlugin({ singleDollarTextMath: true });

// [失败路径] 入参有三种合法形态：裸 attacher、[attacher, options] 元组、以及已带
// 选项的插件对象。直接解构会把裸函数当元组，得到 undefined 的 attacher 并在
// remark 阶段抛 TypeError；这里逐形态收口，保证返回的永远是合法 Pluggable。
function disableSingleTilde(plugin: Pluggable): Pluggable {
  if (!Array.isArray(plugin)) {
    return typeof plugin === "function" ? [plugin, { singleTilde: false }] : plugin;
  }

  // [权衡] 已有 options 必须浅合并而不是整体覆盖：调用方可能还设了其它 remark 选项，
  // 覆盖会把它们静默丢掉，症状是某些表格/脚注能力莫名消失且没有任何报错。
  const [attacher, existingOptions] = plugin;
  return [
    attacher,
    {
      ...(typeof existingOptions === "object" && existingOptions !== null ? existingOptions : {}),
      singleTilde: false,
    },
  ];
}

// [权衡] 按 attacher 函数身份精确匹配删除线插件再改写，而不是按下标：@streamdown/cjk
// 增删插件时下标会整体偏移，错改到别的插件没有任何编译期或运行期提示，只会表现为
// 某种 markdown 语法突然变样。
const messageCjkRemarkPluginsAfter = cjk.remarkPluginsAfter.map((plugin) => {
  const attacher = Array.isArray(plugin) ? plugin[0] : plugin;
  return attacher === remarkCjkFriendlyGfmStrikethrough ? disableSingleTilde(plugin) : plugin;
});
// [事务] remarkPluginsBefore 与 remarkPluginsAfter 必须重组成同一份数组再交给
// Streamdown：上游把“前/后”当两段独立注入，但插件数组的顺序就是解析顺序，
// 保留原顺序等价于把两段拼起来，任何重排都会让 CJK 标点规则晚于 GFM 生效。
const messageCjkPlugin: typeof cjk = {
  ...cjk,
  remarkPlugins: [...cjk.remarkPluginsBefore, ...messageCjkRemarkPluginsAfter],
  remarkPluginsAfter: messageCjkRemarkPluginsAfter,
};
// [权衡] linkSafety 显式关闭：这里所有链接都由自定义 a 渲染器接管（文件链接 / 外链 /
// 不可点击 span），再叠一层 Streamdown 的内置确认会让同一次点击问两遍。
const streamdownPlugins = { cjk: messageCjkPlugin, code, math: messageMathPlugin, mermaid };
const messageLinkSafety = { enabled: false } as const;
// `decoration-dashed` 会把原有的细圆点下划线绘制成短线段；这里只改变下划线的
// 出现时机，继续使用 `dotted` 保留原视觉形态。
const messageLinkClassName =
  "wrap-anywhere text-ui-base font-medium text-icon-blue no-underline decoration-dotted underline-offset-4 hover:underline";
// `items-center` 让 inline-flex 使用浏览器合成的基线，固定 top 偏移又会随平台字体产生漂移。
// 改为由文字子项提供真实 baseline；图标只在链接自身行盒内居中，桌面和移动 Web 共用同一语义。
const messageFileLinkClassName =
  "inline-flex max-w-full items-baseline gap-1 align-baseline text-icon-blue text-ui-base no-underline decoration-dotted underline-offset-4 hover:underline";
// Markdown 之前继承紧凑 UI 字号，正文、标题、链接和表格缺少独立的阅读层级。
// 这里显式定义字号层级，并让标题跟随 UI 字号 Token 缩放，确保聊天、预览和工具面板复用 MessageResponse 时保持一致。
const messageMarkdownHeadingClassNames = {
  h1: "mt-6 mb-4 text-ui-xl font-semibold",
  h2: "mt-6 mb-4 text-ui-lg font-semibold",
  h3: "mt-6 mb-4 text-ui-base font-semibold",
  h4: "mt-6 mb-4 text-ui-base font-semibold",
  h5: "mt-6 mb-4 text-ui-base font-medium",
  h6: "mt-6 mb-4 text-ui-base font-normal",
} as const;
// [权衡] 这一组常量全部提到模块级：正则字面量在模块求值时编译一次，
// 放进渲染路径会在流式的每次 delta 上重复构造 RegExp，长会话下是稳定的 GC 压力。
// 同时它们被多个纯函数共享（fence 判定、公式判定、价格区间判定），内联会逼出重复副本。
const languageClassNamePattern = /(?:^|\s)language-([^\s]+)/;
const fileUrlProtocolPattern = /^file:\/\//i;
const windowsDriveAbsolutePathPattern = /^[a-zA-Z]:[\\/]/;
// [失败路径] 无扩展名的常见文件名单独列出：hasFileExtension 只看“点号后的后缀”，
// 这些名字在词法上没有扩展名，却必须被当成文件处理；漏一个就会退化成不可点击的纯文本。
const knownExtensionlessFileNames = new Set([
  "dockerfile",
  "gemfile",
  "license",
  "makefile",
  "readme",
]);
// [权衡] fence 允许 0~3 个前导空格并接受反引号与波浪号两种标记：CommonMark 就是这么
// 定义的。收紧成“必须顶格”会让缩进在列表里的代码围栏失效，代码块退化成段落。
const markdownFencePattern = /^(?: {0,3})(`{3,}|~{3,})/;
// [权衡] 数学特征优先用“出现 LaTeX 专有符号”而不是“长得像数学”：后者必然误伤
// 普通文本（金额、路径、下划线标识符）。这份字符集只收录几乎不会出现在中文正文里的
// 运算符与希腊字母，宁可漏判成普通文本，也不要误判出公式。
const likelyMathSyntaxPattern = /[\\{}^_=+\-*/<>|()[\]∇∂∫∑√∞≈≠≤≥±×÷πΠα-ωΑ-Ω]/u;
const texCommandPattern = /\\[A-Za-z]+/;
// [失败路径] 单个字母/数字必须排除：`$5` 与 `$a` 在自然语言里极常见，
// 只允许 2~3 字符的短标识符与纯数字，降低把货币与占位符当公式的概率。
const simpleMathIdentifierPattern = /^(?:[A-Za-z]|[a-z][A-Za-z0-9]{1,2}|\d+(?:\.\d+)?)$/;
// [失败路径] 价格区间识别依赖两侧条件同时成立：`$5-` 必须以运算符结尾，
// 闭合 `$` 之后必须紧跟数字。少任何一侧都会把正常金额吞成公式。
const compactCurrencyRangePrefixPattern = /^(?:\d[\d,]*(?:\.\d+)?|\.\d+)[+\-*/]$/;
const compactCurrencyAmountStartPattern = /^(?:\d|\.\d)/;

type MarkdownCodeProps = ComponentProps<"code"> & {
  node?: unknown;
  "data-block"?: unknown;
};
type MarkdownHeadingProps = ComponentProps<"h1"> & {
  node?: unknown;
};
type MarkdownStrongProps = ComponentProps<"strong"> & {
  node?: unknown;
};
type MessageStreamdownMode = "static" | "streaming";
type HastElementNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastElementNode[];
};
type MessageResponseBoundaryScope = {
  markdownLength: number;
  mode: MessageStreamdownMode;
  renderStreaming: boolean;
};

interface MessageResponseMarkdownBoundaryProps {
  children: ReactNode;
  className?: string;
  fallbackText: string;
  resetKey: string;
  scope: MessageResponseBoundaryScope;
}

interface MessageResponseMarkdownBoundaryState {
  error: Error | null;
}

// [权衡] 用 FNV-1a 32 位哈希而不是内容全量比较：这里只回答“内容是否变了”，
// 不做安全校验。碰撞的代价是该重挂载的边界被复用一次（继续显示旧内容一帧），
// 不会造成数据损坏；而全量字符串比较会在每条流式 delta 上 O(n) 扫全文。
function hashMarkdownCacheKey(markdown: string): string {
  let hash = 2166136261;
  for (let index = 0; index < markdown.length; index += 1) {
    hash ^= markdown.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  // [失败路径] 前缀带上长度是廉价保险：哈希碰撞时长度几乎必然不同，
  // 相当于用两个独立维度共同判定“内容变了”，比单看 32 位哈希可靠得多。
  return `${markdown.length}:${hash >>> 0}`;
}

// [失败路径] React 允许抛出任意值，但 logger 与错误边界状态都需要 Error：
// 字符串被原样包装，其余（对象、undefined）统一成固定文案，避免出现 "undefined" 日志。
function normalizeMarkdownRenderError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(typeof error === "string" ? error : "Unknown markdown render error");
}

// [权衡] 返回结构体而不是布尔：调用方还要比较长度来决定围栏是否闭合，
// 只给 true/false 会迫使调用方二次解析同一行。marker 与 length 都取自同一段
// 捕获组，保证“标记字符 + 长度”天然一致。
function getMarkdownFence(line: string): { marker: string; length: number } | null {
  const match = markdownFencePattern.exec(line);

  if (!match) {
    return null;
  }

  const sequence = match[1] ?? "";
  return {
    marker: sequence[0] ?? "",
    length: sequence.length,
  };
}

// [失败路径] 必须数“连续反斜杠的奇偶”而不是只看前一个字符：`\\$` 里的美元是
// 被转义的文本，`\$` 才是转义符本身；只看一位会把两者判成同一种情况，导致
// 已经转义的美元被重复转义成 `\\$`，用户看到多余的反斜杠。
function isEscapedMarkdownCharacter(text: string, index: number): boolean {
  let slashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    slashCount++;
  }

  return slashCount % 2 === 1;
}

// [事务] 判定一个 `$` 是否是“单美元定界符”要同时满足四个条件：自身是美元、
// 左右都不是美元（排除 `$$` 块级公式）、未被转义。少任何一条都会把块级公式
// 拆成两个行内定界符，或把已转义美元再转义一次。
function isSingleDollarDelimiter(text: string, index: number): boolean {
  return (
    text[index] === "$" &&
    text[index - 1] !== "$" &&
    text[index + 1] !== "$" &&
    !isEscapedMarkdownCharacter(text, index)
  );
}

// [失败路径] 找不到闭合符返回 -1 而不是抛错：正文里出现孤立 `$`（价格、变量名）
// 是常态，调用方据此把该字符原样输出；抛错会让一条普通消息整条降级成纯文本。
function findClosingSingleDollarDelimiter(text: string, startIndex: number): number {
  for (let index = startIndex; index < text.length; index++) {
    if (isSingleDollarDelimiter(text, index)) {
      return index;
    }
  }

  return -1;
}

// [权衡] 三道门依次放宽：先排除空串/带首尾空白/跨行（这些是自然语言片段），
// 再看是否含 LaTeX 专有符号，最后才允许“无空白的短标识符”。
// 顺序不能反：先放行短标识符会让 `$5 ... $10` 这种跨句配对成功，把整段吞成公式。
function isLikelySingleDollarMath(content: string): boolean {
  if (!content || content !== content.trim() || /[\r\n]/.test(content)) {
    return false;
  }

  if (texCommandPattern.test(content) || likelyMathSyntaxPattern.test(content)) {
    return true;
  }

  if (!/\s/.test(content) && simpleMathIdentifierPattern.test(content)) {
    return true;
  }

  return false;
}

// [失败路径] 两个条件必须同时满足才算价格区间：形如数字+运算符，且闭合 `$` 后
// 紧跟数字。只看前者会把 `$10 and $20` 这类正常英文误判；只看后者会命中 `$x$1`。
// 命中时调用方只转义当前 `$`，整段继续按文本渲染，金额符号得以保留。
function isLikelyCompactCurrencyRangeText(
  text: string,
  closingIndex: number,
  content: string,
): boolean {
  if (!compactCurrencyRangePrefixPattern.test(content)) {
    return false;
  }

  return compactCurrencyAmountStartPattern.test(text.slice(closingIndex + 1));
}

// [事务] 这是整条公式归一化的核心循环，必须逐字符推进且只做“插入反斜杠”：
// 命中公式时把整段 `$...$` 原样搬到输出并跳过（index = closingIndex），
// 未命中时把当前 `$` 转义成 `\$` 再继续扫描。若改成“删除美元后重排”，
// citation 的字符偏移会整体失效（见 INV-5）。
function normalizeSingleDollarMathInText(text: string): string {
  if (!text.includes("$")) {
    return text;
  }

  let output = "";

  for (let index = 0; index < text.length; index++) {
    if (!isSingleDollarDelimiter(text, index)) {
      output += text[index];
      continue;
    }

    const closingIndex = findClosingSingleDollarDelimiter(text, index + 1);

    if (closingIndex === -1) {
      output += text[index];
      continue;
    }

    const content = text.slice(index + 1, closingIndex);

    if (isLikelyCompactCurrencyRangeText(text, closingIndex, content)) {
      // [失败路径] 只转义这一个 `$` 而不是整段：整段转义会让后续合法的行内公式
      // 也失去定界符，用户在同一行里既看不到金额也看不到公式。
      // `$5-$10` 这类紧凑价格区间的第二个 `$` 会被误当成公式闭合符。
      // 只转义当前 `$`，让整段继续按普通文本渲染并保留美元符号。
      output += "\\$";
      continue;
    }

    if (isLikelySingleDollarMath(content)) {
      output += text.slice(index, closingIndex + 1);
      index = closingIndex;
      continue;
    }

    // 开启 singleDollarTextMath 后，`$5 ... $10` / `$HOME ... $PATH`
    // 这类普通文本会被误当成公式。只转义当前 `$`，让后续 `$` 继续按原文本扫描。
    output += "\\$";
  }

  return output;
}

// [事务] 必须先把行内代码整段“跳过”再处理文本片段：否则 `\`code\`` 里的美元
// 会被当成公式定界符，导致代码内容被反斜杠污染。这里按连续反引号长度匹配闭合符，
// 因为 Markdown 规定 `` ` `` 与 ``` `` ``` 是不同定界符，长度不等就不能闭合。
function normalizeSingleDollarMathOutsideInlineCode(line: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < line.length) {
    const codeStart = line.indexOf("`", cursor);

    if (codeStart === -1) {
      output += normalizeSingleDollarMathInText(line.slice(cursor));
      break;
    }

    output += normalizeSingleDollarMathInText(line.slice(cursor, codeStart));

    let codeFenceEnd = codeStart + 1;
    while (line[codeFenceEnd] === "`") {
      codeFenceEnd++;
    }

    const codeMarker = line.slice(codeStart, codeFenceEnd);
    const codeEnd = line.indexOf(codeMarker, codeFenceEnd);

    // [失败路径] 闭合符缺失时必须整段原样输出：把剩余的每个 `$` 都转义会让
    // 一份被截断的流式消息在补齐前显示满屏反斜杠，补齐后又要整段跳动。
    if (codeEnd === -1) {
      output += normalizeSingleDollarMathInText(line.slice(codeStart));
      break;
    }

    output += line.slice(codeStart, codeEnd + codeMarker.length);
    cursor = codeEnd + codeMarker.length;
  }

  return output;
}

// [事务] 按行扫描并维护 activeFence：围栏内的行一律原样输出，绝不做公式归一；
// 只有“同字符且长度不短于开启标记”的围栏行才能闭合。这条规则保证代码块内的
// `$var`、`${}` 不被改写，同时不会因为代码里出现更短的 `~~~` 而提前闭合。
function normalizeMessageSingleDollarMath(markdown: string): string {
  if (!markdown.includes("$")) {
    return markdown;
  }

  let output = "";
  let cursor = 0;
  let activeFence: { marker: string; length: number } | null = null;

  while (cursor < markdown.length) {
    const newlineIndex = markdown.indexOf("\n", cursor);
    const lineEnd = newlineIndex === -1 ? markdown.length : newlineIndex;
    const line = markdown.slice(cursor, lineEnd);
    const newline = newlineIndex === -1 ? "" : "\n";
    const fence = getMarkdownFence(line);

    if (activeFence) {
      // [失败路径] 围栏内连换行都要原样保留：这里用 line + newline 而不是重排，
      // 一旦吞掉尾随换行，代码块的行号与复制结果都会与原文差一。
      output += line + newline;

      if (fence && fence.marker === activeFence.marker && fence.length >= activeFence.length) {
        activeFence = null;
      }
    } else {
      output += normalizeSingleDollarMathOutsideInlineCode(line) + newline;

      if (fence) {
        activeFence = fence;
      }
    }

    cursor = lineEnd + newline.length;
  }

  return output;
}

// [失败路径] 生产包里用户命中过 React #185，堆栈落在 MessageResponse -> Streamdown：
// 只要把“已完成的长消息”也送进 streaming 模式，Streamdown 内部的 block 状态机
// 就会在某些历史 markdown 上反复同步。因此这里是一个单向收口——终态一律 static，
// 不提供“为了分块缓存而放宽”的开关，避免优化再次把这个回归引回来。
export function resolveMessageStreamdownMode(renderStreaming: boolean): MessageStreamdownMode {
  // 生产包里有用户命中 React #185，堆栈落在 MessageResponse -> Streamdown。
  // 之前完成态长消息也会为了分块缓存走 streaming mode，Streamdown 内部 block state
  // 在某些历史 markdown 上会反复同步状态。现在只有真实流式输出进入 streaming，
  // 历史/完成态内容固定走 static，避免重新挂载时再次参与更新循环。
  return renderStreaming ? "streaming" : "static";
}

class MessageResponseMarkdownBoundary extends Component<
  MessageResponseMarkdownBoundaryProps,
  MessageResponseMarkdownBoundaryState
> {
  state: MessageResponseMarkdownBoundaryState = { error: null };

  // [失败路径] getDerivedStateFromError 必须是静态方法，React 在渲染失败后
  // 用它同步换代，拿不到实例；写成实例方法会在没有 this 的情况下抛二次错误。
  static getDerivedStateFromError(error: unknown): MessageResponseMarkdownBoundaryState {
    return { error: normalizeMarkdownRenderError(error) };
  }

  // [失败路径] 这里只做观测，不做恢复：日志里必须带上 markdownLength 与 mode，
  // 否则线上只能看到“某条消息炸了”，无法判断是流式还是终态、是超长还是特定语法。
  override componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    const normalizedError = normalizeMarkdownRenderError(error);
    logger.warn("[MessageResponse] markdown 渲染失败，已降级为纯文本", {
      errorName: normalizedError.name,
      errorMessage: normalizedError.message,
      componentStack: errorInfo.componentStack,
      markdownLength: this.props.scope.markdownLength,
      mode: this.props.scope.mode,
      renderStreaming: this.props.scope.renderStreaming,
    });
  }

  // [事务] 只有 resetKey 变化才允许清除错误：这是“同一份坏内容不无限重试”的唯一闸门。
  // 恢复必须放在 didUpdate 而不是 render，因为 setState 在 render 期间是非法调用；
  // 同时 resetKey 变化意味着内容/模式变了，重试才是有意义的新尝试。
  override componentDidUpdate(previousProps: MessageResponseMarkdownBoundaryProps) {
    if (this.state.error && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override render() {
    // [失败路径] 降级输出用 whitespace-pre-wrap 的父容器承载原始 markdown：
    // 这里不能再走 Streamdown，否则同一个错误会立刻重演一次，形成错误循环。
    if (this.state.error) {
      return (
        <div className={this.props.className}>
          {/* 单条 markdown 渲染异常时降级为纯文本，避免错误继续冒泡到会话区边界。*/}
          {this.props.fallbackText}
        </div>
      );
    }

    return this.props.children;
  }
}

// [权衡] 这里刻意输出“带行号后缀的 path 字符串”而不是 URL：harden 之后 href 会
// 变成不可逆的编码形态，点击层只能靠这段字符串反解行列号；一旦改成 URL 查询参数，
// Streamdown/harden 的归一化会把 `:12:3` 吃掉，跳转精度就丢了。
function formatMarkdownFileLinkTargetHref(href: string): string {
  const parsedTarget = parseMarkdownFileLinkTarget(href);
  // Windows 盘符的 `C:` 会被 rehype-harden 当成未知 URI scheme，
  // 在自定义文件链接 renderer 运行前直接替换成 `[blocked]`。临时补成 `/C:/...`
  // 让安全层按普通 path 放行；resolveMarkdownFileLink 会在 Windows Host 上对称还原。
  // [失败路径] 分支顺序不能调换：盘符判定必须在协议判定之前，因为 `C:/x` 既不以
  // `file://` 开头也不是相对路径，落到最后的 `./` 分支会变成 `./C:/x`；
  // 而带 scheme 的绝对 URL 又必须排在相对路径之前，否则会被当成工作区相对文件。
  const path = windowsDriveAbsolutePathPattern.test(parsedTarget.path)
    ? `/${parsedTarget.path.replaceAll("\\", "/")}`
    : fileUrlProtocolPattern.test(href)
      ? parsedTarget.path
      : parsedTarget.path.startsWith("./") ||
          parsedTarget.path.startsWith("/") ||
          parsedTarget.path.startsWith("#") ||
          parsedTarget.path.startsWith("../") ||
          /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(parsedTarget.path)
        ? parsedTarget.path
        : `./${parsedTarget.path}`;
  // [事务] 行号/列号是逐级可选的：只有行号时输出 `path:12`，有列号才补 `:3`。
  // 多输出一个冒号在 Windows 上会与盘符冲突，点击层解析时可能把 `3` 当盘符。
  if (parsedTarget.lineNumber === null) {
    return path;
  }

  if (parsedTarget.columnNumber === null) {
    return `${path}:${parsedTarget.lineNumber}`;
  }

  return `${path}:${parsedTarget.lineNumber}:${parsedTarget.columnNumber}`;
}

// [失败路径] 判据是“改写之后还能被打开”而不是“看起来像文件”：先让
// resolveMarkdownFileLink 认领（它掌握 workspace/home 语义），再对裸相对路径
// 做词法校验。若直接按后缀判断，`../../etc/passwd` 也会被改写成可点击链接，
// 等于把越界意图包装成了正常功能。
function shouldRewriteMarkdownFileLinkHref(href: string): boolean {
  if (resolveMarkdownFileLink(undefined, href)) {
    return true;
  }

  // [权衡] 条件是一条链式“与”：任一前缀不满足即整体退化为不可改写（返回 false），
  // 宁可让链接保持不可点击，也不要把 `#anchor`、绝对路径、带 scheme 的 URL 拉进
  // 工作区文件语义里。链式短路同时保证了下面的词法校验只在必要时才执行。
  const parsedTarget = parseMarkdownFileLinkTarget(href);
  return (
    Boolean(parsedTarget.path) &&
    !parsedTarget.path.startsWith("/") &&
    !parsedTarget.path.startsWith("#") &&
    !parsedTarget.path.startsWith("../") &&
    !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(parsedTarget.path) &&
    // 越界路径若先经过 rehype rewrite/harden，`..` 可能被 URL 归一后丢失，
    // 点击层就无法还原原始逃逸意图；必须在改写前复用相对路径词法边界校验。
    normalizeWorkspaceRelativeFilePath(parsedTarget.path) !== null &&
    // `[README.md](README.md)` 这类裸文件名链接以前不会在 harden 前改写，
    // Streamdown 会把它当成不安全链接渲染成 `[blocked]`。有扩展名的裸路径按工作区文件处理，
    // 先规整成 `./README.md`，再交给统一的文件链接打开逻辑解析。
    (parsedTarget.path.includes("/") ||
      parsedTarget.path.includes("\\") ||
      hasFileExtension(getPathLeaf(parsedTarget.path)))
  );
}

// [事务] 这是一个“访问整棵 hast 树”的插件，必须在 harden 之前运行（见 INV-10）。
// 递归只走 children，不修改节点结构，只在原地替换 href/src，因此不需要重新
// 生成 position，也不会影响后续插件的 source map 语义。
function rewriteLocalFileMarkdownTargetsRehypePlugin() {
  return (tree: HastElementNode) => {
    const visitNode = (node: HastElementNode) => {
      // [失败路径] 只在“确实存在该属性且通过改写判定”时才写回：hast 里 a/img 之外
      // 的元素没有目标属性，直接赋值会造出 undefined 语义的 href；而函数组件/reference
      // 节点可能没有 properties，可选链是必需的。
      const targetProperty = node.tagName === "a" ? "href" : node.tagName === "img" ? "src" : null;
      if (
        node.type === "element" &&
        targetProperty &&
        typeof node.properties?.[targetProperty] === "string" &&
        shouldRewriteMarkdownFileLinkHref(node.properties[targetProperty])
      ) {
        // markdown 图片和链接一样会先经过 rehype-harden。`file://` 会被安全层硬拦，
        // 裸文件名又会被当成未知 URL；这里在 harden 前统一规整成本地路径/相对路径。
        node.properties[targetProperty] = formatMarkdownFileLinkTargetHref(
          node.properties[targetProperty],
        );
      }

      node.children?.forEach(visitNode);
    };

    visitNode(tree);
  };
}

// [事务] 顺序即语义：本地改写插件必须排在所有默认 rehype 插件之前，因为默认集合里
// 含 harden。数组展开保持上游顺序不变，只把自己插到最前面，避免影响其它默认行为。
const messageRehypePlugins: PluggableList = [
  rewriteLocalFileMarkdownTargetsRehypePlugin,
  ...Object.values(defaultRehypePlugins),
];

// [失败路径] 只对 gfm 这一项改名（其它插件原样返回）：默认插件表是按名字索引的
// 对象，整体 map 后仍要保序；若在这里过滤掉 gfm，表格与任务列表会一起消失。
const messageDefaultRemarkPlugins: PluggableList = Object.entries(defaultRemarkPlugins).map(
  ([name, plugin]) => {
    if (name !== "gfm") {
      return plugin;
    }

    // remark-gfm 与 Streamdown CJK 删除线扩展都默认开启 singleTilde，
    // 后者还会覆盖前者的解析结果；两处必须同时关闭，才能让 `~text~` 按 GFM 规范保留原文。
    return disableSingleTilde(plugin);
  },
);

// [权衡] 主题解析只做“用户选择 → shiki 主题名”的映射，不在这里读 store：
// 组件本身要保持可在非 React 环境调用，主题值由调用方注入；未知主题回退浅色，
// 避免 shiki 拿到不支持的名字后整块代码渲染成白底白字。
function resolveMessageCodeTheme(
  theme: Theme,
  codePreviewSettings: { lightTheme: BundledTheme; darkTheme: BundledTheme },
): BundledTheme {
  // [失败路径] system 主题在 SSR 阶段拿不到 matchMedia，必须显式判 window：
// 直接读会抛 ReferenceError，而错误边界会因此把整条消息降级成纯文本，
// 表现为“服务端首屏全部退化为文本”。
  if (theme === "system" && typeof window !== "undefined") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? codePreviewSettings.darkTheme
      : codePreviewSettings.lightTheme;
  }

  return theme === "dark" || theme === "zai-dark"
    ? codePreviewSettings.darkTheme
    : codePreviewSettings.lightTheme;
}

// [事务] renderKey 是本文件最容易被改错的一处：它必须覆盖“渲染器闭包里读到、
// 但 React 无法通过 props 传下去”的全部输入。漏一项的后果不是报错，而是
// 已挂载的代码块/图片继续用旧闭包渲染——表现是切换主题或换会话后内容不更新。
export function buildMessageStreamdownRenderKey(params: {
  attachmentReaderEpoch?: number;
  codeBlockTheme: BundledTheme;
  fontSizePx: number;
  renderZCodeFileCitations?: boolean;
  sessionId?: string;
  workspacePath?: string;
  workspaceHomePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  wrapLongLines: boolean;
}): string {
  // streaming/static 只是解析模式，不应参与 React key；否则流式状态抖动会卸载
  // 整棵 markdown 子树，让已显示的正文重新触发淡入动画。
  return [
    params.sessionId ?? "",
    params.attachmentReaderEpoch ?? 0,
    params.codeBlockTheme,
    params.fontSizePx,
    params.wrapLongLines ? "wrap" : "scroll",
    params.renderZCodeFileCitations ? "citations" : "plain",
    params.workspacePath ?? "",
    params.workspaceHomePath ?? "",
    params.workspaceIdentity ?? "",
    params.workspaceRemoteSessionId ?? "",
  ].join(":");
}

// [失败路径] attachment reader 用 WeakMap 分配“代”：reader 函数每次渲染几乎都会
// 重建引用（内联闭包），若直接把函数拼进 key，等于每帧换 key，markdown 子树会
// 逐帧卸载重建。WeakMap 按函数身份取值保证同一 reader 恒定，且不会阻止 GC。
const attachmentReaderEpochs = new WeakMap<
  NonNullable<MessageResponseProps["readAttachment"]>,
  number
>();
// [资源] 计数器单调递增且从 1 开始：0 留给“没有 reader”的缺省，这样 epoch 本身
// 就能当 truthy 用；不回绕，单个会话的 reader 实例数量远小于安全整数上限。
let nextAttachmentReaderEpoch = 1;

// [事务] 命中已登记的 reader 必须原样返回旧 epoch：这里没有“清理”路径，
// WeakMap 随 reader 一起被 GC，因此不存在编号泄漏；反过来若每次调用都重新分配，
// key 每帧都在变，memo 与 ErrorBoundary 的 resetKey 都会失效。
function getAttachmentReaderEpoch(readAttachment: MessageResponseProps["readAttachment"]): number {
  if (!readAttachment) return 0;
  const existing = attachmentReaderEpochs.get(readAttachment);
  if (existing !== undefined) return existing;
  const epoch = nextAttachmentReaderEpoch++;
  attachmentReaderEpochs.set(readAttachment, epoch);
  return epoch;
}

// [失败路径] 缺省返回 "text" 而不是空串：shiki 的 languages 里没有空键，
// 传空串会在高亮阶段抛错，错误边界再把整条消息降级成纯文本（见 INV-21）。
function getCodeLanguage(className?: string): string {
  return className?.match(languageClassNamePattern)?.[1] ?? "text";
}

// [事务] 这是全文件唯一的“ReactNode → 字符串”拍平点（INV-2）：字符串/数字直接取，
// 数组递归拼接，元素取其 props.children，其它一律空串。必须递归而不是只处理一层，
// 因为 synced 出来的 children 常常是 [文本, <span>, 文本] 的嵌套数组。
function extractCodeText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }

  if (Array.isArray(children)) {
    return children.map(extractCodeText).join("");
  }

  if (isValidElement<{ children?: ReactNode }>(children)) {
    return extractCodeText(children.props.children);
  }

  // [失败路径] 非字符串非元素（null、布尔、函数）必须落到空串而不是抛错：
  // 条件渲染的 {cond && "x"} 在 cond 为假时产出 false，直接 String() 会得到
  // 字面量 "false" 写进代码块，用户看到多出来的四个字母。
  return "";
}

// [权衡] 链接文案单独 trim：文件链接的 label 用来解析路径，首尾空白会被
// 误当成文件名的一部分（`a.txt ` 与 `a.txt` 是两个不同的路径）。
function extractLinkLabelText(children: ReactNode): string {
  return extractCodeText(children).trim();
}

// [失败路径] 只认“点号后还有非分隔符字符”：`./foo` 里的 `.` 是路径前缀不是扩展名，
// `a.` 结尾也没有扩展名。放松成“包含点号”会把整个相对路径当成文件名，
// 进而让 hasFileExtension 在目录判断上给出错误答案。
function hasFileExtension(pathLeaf: string): boolean {
  return /\.[^./\\]+$/.test(pathLeaf);
}

// [权衡] 只把“显式尾随斜杠”当作目录提示（INV-25）：这是唯一在文本层面可信的信号。
// 返回 undefined 而不是 "file"，因为“未知”与“确定是文件”语义不同：前者点击时
// 仍要 stat 才能决定打开方式，后者可以直接跳转。
function isExplicitDirectoryMarkdownLink(path: string, href: string): boolean {
  const trimmedHref = href.trim();
  return /[\\/]$/.test(trimmedHref) || /[\\/]$/.test(path);
}

// [事务] 这个函数只做纯数据组装，不做 IO：pathKind 可能为 undefined，
// relativePath 在缺少 workspacePath 时回退到 label（终端里常见的裸文件名）。
// 打开动作一律延后到 openMessageFileLinkInEditor，保证渲染期零副作用。
export function buildMessageFileLinkTarget(input: {
  href: string;
  label: string;
  path: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}): MessageFileLinkTarget {
  // 文件名是否带扩展名不能代表文件系统类型；env、hosts、config 等无扩展名文件
  // 过去会被误判为目录。这里只保留显式尾随斜杠作为图标提示，打开方式必须再 stat。
  const pathKind = isExplicitDirectoryMarkdownLink(input.path, input.href)
    ? ("directory" as const)
    : undefined;
  return {
    path: input.path,
    label: input.label,
    pathKind,
    relativePath: input.workspacePath
      ? getWorkspaceFileRelativePath(input.workspacePath, input.path)
      : input.label,
    workspacePath: input.workspacePath,
    workspaceIdentity: input.workspaceIdentity,
    workspaceRemoteSessionId: input.workspaceRemoteSessionId,
  };
}

// [失败路径] stat 必须发生在 openInEditor 之前，且异常向上抛：这是唯一的
// “名称不可信”兜底（INV-24、INV-26）。若先打开再校验，本机应用已经被拉起，
// 用户可能在看一个不存在的路径；而把异常吞掉会让点击表现为“无反应”。
export async function openMessageFileLinkInEditor({
  editorId,
  fileLink,
  openInEditor,
  remoteTarget,
  statFile,
}: {
  editorId: string;
  fileLink: MessageFileLinkTarget;
  openInEditor: (
    editorId: string,
    path: string,
    options: OpenInEditorOptions,
  ) => Promise<{ success: boolean; error?: string }>;
  remoteTarget?: OpenInEditorOptions["remoteTarget"];
  statFile: (params: { path: string }) => Promise<Pick<FileStat, "type">>;
}) {
  // Markdown 渲染层无法从名称可靠判断文件/目录。这里在动作发生时通过
  // 当前 workspace scope 的 file service 取真实类型，stat 失败时不会调用本机应用。
  const fileStat = await statFile({ path: fileLink.path });
  return openInEditor(editorId, fileLink.path, {
    pathKind: fileStat.type,
    remoteTarget,
    workspaceIdentity: fileLink.workspaceIdentity,
  });
}

// [权衡] 复制文本去掉尾部空行（INV-32）：围栏代码在 toText 里通常带一个尾换行，
// 粘贴到编辑器会多出空行；只删尾部、不 trim 首部，因为缩进是代码语义的一部分。
function trimCodeFenceTrailingNewlines(codeText: string): string {
  return codeText.replace(/\n+$/, "");
}

// [失败路径] try/catch 是安全边界而不是防御式编程：new URL 对 `foo.md`、
// `#anchor`、`//host/x` 都会抛错，而这三种在 markdown 里极常见。
// 抛错时必须返回 false（不可点击），绝不能抛出去——一次异常会触发整条消息降级。
function isExternalWebHref(href: string): boolean {
  try {
    const protocol = new URL(href).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// [权衡] 用 button 而不是 a：外链要通过 Desktop 的 shell 打开，必须能被键盘
// 聚焦并响应 Enter（button 自带），同时避免默认的浏览器导航与中间键行为；
// 代价是语义上不再是一个“链接”，因此 aria 属性需要在这里补齐。
interface MessageExternalLinkProps extends ComponentProps<"button"> {
  href: string;
  onOpenExternalUrl: (url: string) => void;
}

function MessageExternalLink({
  children,
  className,
  href,
  onClick,
  onOpenExternalUrl,
  ...props
}: MessageExternalLinkProps) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  // [事务] 目标选择是三层优先级：显式 forceExternal / forceInApp > 平台策略 >
  // 调用方 handler。三者顺序不能变，否则右键菜单里的“在应用内打开”会被平台
  // 白名单反向覆盖，两个菜单项表现成一样（见 INV-29）。
  const handleOpen = useCallback(
    (options: { forceExternal?: boolean; forceInApp?: boolean } = {}) => {
      // 交互语义：本机/私网白名单只决定左键单击的默认目标；右键菜单两项各自强制一个目标。
      // 菜单「打开」过去复用左键默认行为，公网链接（如飞书文档）两项都会跳系统浏览器。
      const target = resolveMessageLinkOpenTarget({ href, ...options });
      logger.debug("[MessageExternalLink] 打开 Markdown 外链", {
        forceExternal: Boolean(options.forceExternal),
        forceInApp: Boolean(options.forceInApp),
        href,
        target,
      });

      // [失败路径] 没有 platform 时必须退回调用方 handler，而不是静默丢弃：
      // Share/普通 Web 没有 Desktop PlatformProvider，直接 return 会让“点了没反应”；
      // 但也绝不能在这里降级整棵 markdown（INV-30），否则一条外链毁掉整个会话区。
      if (target === "app-browser" || !platform) {
        // Share/普通 Web 没有 Desktop PlatformProvider；仍交给调用方的安全 URL handler，
        // 避免 MessageResponse 因缺少宿主上下文整棵 Markdown 降级为纯文本。
        onOpenExternalUrl(href);
        return;
      }

      // [失败路径] platform.openExternal 是 fire-and-forget 的同步调用，返回的
      // Promise 若被丢弃可能产生未处理拒绝；这里不 await，因为打开外部程序
      // 的耗时不应阻塞 UI，但调用方必须保证它自身不会抛错。
      platform.openExternal(href);
    },
    [href, onOpenExternalUrl, platform],
  );
  // [事务] 先让调用方的 onClick 跑完再看 defaultPrevented：上层可能要用
  // preventDefault 取消这次打开（例如它在别处已经处理了链接），
  // 把默认行为放在前面会让“取消”变成无效承诺。
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) {
        return;
      }

      // [权衡] meta/ctrl 强制走系统浏览器是浏览器用户的肌肉记忆（Cmd+点击新标签），
      // 在桌面端保留同一手势可以避免“同一次点击在不同宿主里行为不同”；
      // Shift/Alt 故意不处理，留给未来的“下载/另存”语义。
      handleOpen({ forceExternal: event.metaKey || event.ctrlKey });
    },
    [handleOpen, onClick],
  );

  // [权衡] 右键菜单两个项必须各自强制一个目标：默认项复用左键策略，
  // 会让公网链接两项都跳系统浏览器（历史上正是这个 bug，见 INV-29）。
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            messageLinkClassName,
            "cursor-pointer bg-transparent p-0 text-left",
            className,
          )}
          title={href}
          {...props}
          // markdown 外链之前被统一降级成 span，用户看得到链接却点不开。
          // 这里仍阻断原生 a 标签跳转，但不再把所有 http/https 都默认送进内置浏览器。
          onClick={handleClick}
        >
          {children}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={() => handleOpen({ forceInApp: true })}>
          {intl.formatMessage({ id: "common.open" })}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => handleOpen({ forceExternal: true })}>
          <ExternalLinkIcon className="size-4" />
          <span>{intl.formatMessage({ id: "chat.previewCards.openExternal" })}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface MessageFileLinkButtonProps extends ComponentProps<"button"> {
  fileIconSrc: string;
  fileLink: MessageFileLinkTarget;
  onOpen: () => void;
}

// [权衡] 用 forwardRef 暴露 DOM ref：markdown 的 a 渲染器要把 ref 透传出去，
// 上游可能依赖它做滚动定位；函数组件不透传会让定位静默失效。
const MessageFileLinkButton = forwardRef<HTMLButtonElement, MessageFileLinkButtonProps>(
  function MessageFileLinkButton(
    { children, className, fileIconSrc, fileLink, onOpen, ...props },
    ref,
  ) {
    // [失败路径] title 用完整路径而不是 label：label 可能被截断成 `…/a.tex`，
    // 悬停时必须给出可核对的全路径，否则用户无法判断要点的是哪个同名文件。
    return (
      <button
        ref={ref}
        type="button"
        className={cn(messageFileLinkClassName, "cursor-pointer", className)}
        title={fileLink.path}
        onClick={onOpen}
        {...props}
      >
        <FileDisplayIcon src={fileIconSrc} size={16} className="ml-0.5 shrink-0 self-center" />
        <span className="min-w-0 self-baseline truncate">{children}</span>
      </button>
    );
  },
);

interface MessageFileLinkProps {
  className?: string;
  fileIconSrc: string;
  fileLink: MessageFileLinkTarget;
  onOpen: () => void;
}

// [资源] 编辑器列表与“已加载/加载中”两个布尔一起构成懒加载状态机：
// 它们必须同生共死，任一被单独重置都会让右键菜单在“空列表”和“永远转圈”之间抖动。
function MessageFileLink({ className, fileIconSrc, fileLink, onOpen }: MessageFileLinkProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const services = useOptionalServices();
  const fileActions = useFileContextActions();
  const openInEditorContext = useWorkspaceOpenInEditorTarget({
    workspacePath: fileLink.workspacePath,
    workspaceIdentity: fileLink.workspaceIdentity,
    workspaceRemoteSessionId: fileLink.workspaceRemoteSessionId,
  });
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [editorsLoaded, setEditorsLoaded] = useState(false);
  const [loadingEditors, setLoadingEditors] = useState(false);
  // [失败路径] 远程工作区但拿不到 remoteTarget 时返回空列表：此时“在本机编辑器打开”
  // 是错误语义（文件在远端），宁可让菜单为空也不能把远端路径交给本机应用。
  const sortedEditors = useMemo(
    () =>
      openInEditorContext.isRemoteWorkspace && !openInEditorContext.remoteTarget
        ? []
        : resolveWorkspaceEditorSelection({
            installedEditors: editors,
            selectedEditorId: null,
            remoteTarget: openInEditorContext.remoteTarget,
          }).availableEditors,
    [editors, openInEditorContext],
  );
  // [权衡] 每次渲染都读一次持久化的“上次选择”：这份值是 localStorage 级别的
  // 跨组件状态，没有订阅机制；读起来便宜，且保证用户刚在别处切换过编辑器后
  // 这个菜单立刻跟上，而不是等下一次手动刷新。
  const selectedEditor = useMemo(() => {
    const selectedEditorId = readLastSelectedEditorId();
    return (
      sortedEditors.find((editor) => editor.id === selectedEditorId) ?? sortedEditors[0] ?? null
    );
  }, [sortedEditors]);

  // [资源] 双闸门（editorsLoaded || loadingEditors）是单飞的关键：右键菜单的
  // onOpenChange 可能连续触发多次，只判一个会让两次请求并发，后返回的旧列表
  // 覆盖新列表；先置 loading 再 await 才能保证同一时刻只有一次枚举。
  const loadEditors = useCallback(async () => {
    if (editorsLoaded || loadingEditors) {
      return;
    }

    setLoadingEditors(true);
    try {
      const installedEditors = await platform.getInstalledEditors();
      setEditors(installedEditors);
      setEditorsLoaded(true);
    } catch (error) {
      // [失败路径] 失败时故意不置 editorsLoaded：菜单下次打开会重试，
      // 而不是把“本机没装任何编辑器”这个错误结论永久缓存下来。
      logger.warn("[MessageResponse] 获取 markdown 链接打开方式失败", {
        path: fileLink.path,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // [资源] finally 里必须解除 loading：try/catch 任一路径遗漏都会让
      // loadingEditors 永久为真，菜单从此再也加载不出编辑器（只能重启）。
      setLoadingEditors(false);
    }
  }, [editorsLoaded, fileLink.path, loadingEditors, platform]);

  const handleOpenInEditor = (editor: EditorInfo) => {
    // [失败路径] 没有 fileService 直接放弃（fail closed，INV-26）：缺少它就无法
    // stat，也就无法区分文件与目录；此时打开只会把目录塞给编辑器。
    // 记录为 warn 而不是抛错，因为这是环境缺能力，不是用户操作错误。
    if (!services) {
      logger.warn("[MessageResponse] 无法确认 markdown 链接文件类型", {
        editorId: editor.id,
        path: fileLink.path,
        error: "workspace-file-service-unavailable",
      });
      return;
    }

    // [事务] 先持久化选择再发起打开：持久化是纯本地写，不会失败；而打开是
    // 跨进程动作，可能被系统拒绝。顺序反过来会让“打开失败”连带上一次选择丢失，
    // 用户下次重试时又回到默认编辑器。
    persistLastSelectedEditorId(editor.id);
    void openMessageFileLinkInEditor({
      editorId: editor.id,
      fileLink,
      openInEditor: (editorId, path, options) => platform.openInEditor(editorId, path, options),
      remoteTarget: openInEditorContext.remoteTarget,
      statFile: (params) => services.fileService.stat(params),
    })
      .then((result) => {
        if (result.success) {
          return;
        }

        logger.warn("[MessageResponse] 第三方 App 打开 markdown 文件链接失败", {
          editorId: editor.id,
          path: fileLink.path,
          error: result.error ?? "unknown-error",
        });
      })
      .catch((error) => {
        // [失败路径] stat 失败与“打开失败”必须分开记录：前者说明路径/权限有问题，
        // 后者说明本机应用拒绝。catch 分支是必需的——若只处理 result.success，
        // stat 抛出的异常会变成未处理拒绝，点击看上去毫无反应且没有日志。
        logger.warn("[MessageResponse] 无法确认 markdown 链接文件类型", {
          editorId: editor.id,
          path: fileLink.path,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  return (
    <ContextMenu onOpenChange={(open) => open && void loadEditors()}>
      <ContextMenuTrigger asChild>
        <MessageFileLinkButton
          className={className}
          fileIconSrc={fileIconSrc}
          fileLink={fileLink}
          onOpen={onOpen}
        >
          {fileLink.label}
        </MessageFileLinkButton>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={onOpen}>
          {intl.formatMessage({ id: "common.open" })}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {selectedEditor ? (
          sortedEditors.map((editor) => (
            <ContextMenuItem key={editor.id} onSelect={() => handleOpenInEditor(editor)}>
              <img src={editor.iconDataUrl} alt={editor.name} className="size-4 shrink-0" />
              <span>{editor.name}</span>
            </ContextMenuItem>
          ))
        ) : (
          <ContextMenuItem disabled>
            {intl.formatMessage({
              id: loadingEditors ? "common.loading" : "chat.previewCards.noOpenApps",
            })}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => void fileActions.copyAbsolutePath({ path: fileLink.path })}
        >
          <CopyIcon className="size-4" />
          {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            void fileActions.copyRelativePath({
              path: fileLink.path,
              relativePath: fileLink.relativePath ?? fileLink.label,
            })
          }
        >
          <CopyIcon className="size-4" />
          {intl.formatMessage({ id: "fileActions.copyRelativePath" })}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// [权衡] 标题组件按级别分派到六个真实标签，而不是“统一 div + 字号类”：
// 读屏与文档大纲依赖真实的 h1~h6；代价是要写六条分支，但换来的是可访问性语义。
// node 被显式丢弃（_node），避免把 hast 节点展开到 DOM 属性上。
function MessageMarkdownHeading({
  className,
  headingLevel,
  node: _node,
  ...props
}: MarkdownHeadingProps & {
  headingLevel: keyof typeof messageMarkdownHeadingClassNames;
}) {
  const headingClassName = cn(messageMarkdownHeadingClassNames[headingLevel], className);
  // [事务] data-streamdown 必须跟着级别走：Streamdown 的流式 diff 靠这个属性
  // 定位块边界，写死成常量会让 h1 与 h2 在增量更新时被当成同一块，出现标题“串级”。
  const dataStreamdown = `heading-${headingLevel.slice(1)}`;

  if (headingLevel === "h1") {
    return <h1 className={headingClassName} data-streamdown={dataStreamdown} {...props} />;
  }

  if (headingLevel === "h2") {
    return <h2 className={headingClassName} data-streamdown={dataStreamdown} {...props} />;
  }

  if (headingLevel === "h3") {
    return <h3 className={headingClassName} data-streamdown={dataStreamdown} {...props} />;
  }

  if (headingLevel === "h4") {
    return <h4 className={headingClassName} data-streamdown={dataStreamdown} {...props} />;
  }

  if (headingLevel === "h5") {
    return <h5 className={headingClassName} data-streamdown={dataStreamdown} {...props} />;
  }

  return <h6 className={headingClassName} data-streamdown={dataStreamdown} {...props} />;
}

// [事务] 这个比较函数是整条消息的 memo 闸门（INV-31）：每一项都是“引用相等”判断，
// 因此所有回调与对象类 props 必须由调用方 memo 化，否则一次父级渲染就会让这里
// 全部判为不等、整棵 markdown 重算。漏项时不会报错，只会表现为界面不更新。
export const messageResponsePropsAreEqual = (
  prevProps: Readonly<MessageResponseProps>,
  nextProps: Readonly<MessageResponseProps>,
): boolean =>
  prevProps.children === nextProps.children &&
  // [失败路径] forceCodeWrap 必须单列：它不参与 codePreviewSettings，
  // 漏掉后办公模式的换行锁定会在下一次父级渲染时静默失效。
  prevProps.forceCodeWrap === nextProps.forceCodeWrap &&
  nextProps.streaming === prevProps.streaming &&
  nextProps.streamingAnimationKey === prevProps.streamingAnimationKey &&
  nextProps.workspacePath === prevProps.workspacePath &&
  nextProps.workspaceHomePath === prevProps.workspaceHomePath &&
  nextProps.workspaceIdentity === prevProps.workspaceIdentity &&
  nextProps.workspaceRemoteSessionId === prevProps.workspaceRemoteSessionId &&
  nextProps.sessionId === prevProps.sessionId &&
  nextProps.readAttachment === prevProps.readAttachment &&
  // [失败路径] 三个 onOpen* 回调也要比较：它们被渲染器闭包捕获，回调变了
  // 但 memo 放过，就会出现“新逻辑点了没生效”，且极难通过读代码发现。
  nextProps.renderZCodeFileCitations === prevProps.renderZCodeFileCitations &&
  nextProps.theme === prevProps.theme &&
  nextProps.codePreviewSettings === prevProps.codePreviewSettings &&
  nextProps.onOpenCodeViewer === prevProps.onOpenCodeViewer &&
  nextProps.onOpenFileLink === prevProps.onOpenFileLink &&
  nextProps.onOpenExternalUrl === prevProps.onOpenExternalUrl;

export const MessageResponse = memo(
  ({
    className,
    streaming = false,
    forceCodeWrap = false,
    onOpenCodeViewer,
    onOpenFileLink,
    onOpenExternalUrl,
    renderZCodeFileCitations = false,
    workspacePath,
    workspaceHomePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    sessionId,
    readAttachment,
    theme = "system",
    codePreviewSettings = DEFAULT_CODE_PREVIEW_SETTINGS,
    children,
  }: MessageResponseProps) => {
    // [权衡] 默认值全部写成模块级常量或字面量：`theme = "system"` 与
    // `codePreviewSettings = DEFAULT_CODE_PREVIEW_SETTINGS` 都是稳定引用，
    // 若在这里写 `{}` 之类内联默认值，memo 比较会永远判不等（INV-34）。
    // [事务] wrapLongLines 是“用户设置 OR 办公硬覆盖”，单向不可逆：
    // 硬覆盖只能打开换行，不能把用户已开的换行关掉，因此用 || 而不是覆盖赋值。
    const wrapLongLines = forceCodeWrap || codePreviewSettings.wrapLongLines;
    // [事务] 拍平与后续所有投影都挂在 children 上：children 是唯一的正文来源
    // （INV-2）。这里用 useMemo 而不是直接算，是因为流式期间 children 每帧都变，
    // 而非流式消息重渲染时（例如主题切换）必须命中缓存、不重复遍历子树。
    const rawMarkdown = useMemo(() => extractCodeText(children), [children]);
    const renderStreaming = streaming;
    // [事务] citation 投影放在管线最前（INV-3）：它把 [file](...) 变成可见文本，
    // 之后的图片归一与公式归一都只应看到“投影后的正文”，否则 citation 生成的
    // 下划线/方括号会被公式规则二次转义。
    const projectedCitationMarkdown = useMemo(
      () =>
        renderZCodeFileCitations
          ? projectZCodeFileCitations(rawMarkdown, { streaming: renderStreaming }).visibleText
          : rawMarkdown,
      [rawMarkdown, renderStreaming, renderZCodeFileCitations],
    );
    // [事务] 三步必须按“图片块归一并 → 公式归一 → artifact 图片重写”顺序执行：
    // 连续图片块要先合并成一行，才能让公式归一在同一行里整体扫描；artifact 重写
    // 放最后，因为它只看 img 的 src，不关心文本里的美元符号。
    const targetMarkdown = useMemo(
      () =>
        rewriteMarkdownArtifactImageSources(
          normalizeMessageSingleDollarMath(
            normalizeConsecutiveMarkdownImageBlocks(projectedCitationMarkdown),
          ),
        ),
      [projectedCitationMarkdown],
    );
    // [事务] 模式在这里一次性定死并向下传递（INV-13）：下游的 boundary、
    // Streamdown、代码渲染器都读同一个值，禁止再各自用 streaming 重算，
    // 否则“终态走 static”的收口会被某个分支绕过。
    const streamdownMode = resolveMessageStreamdownMode(renderStreaming);
    // [事务] 插件数组必须是稳定引用：它作为 props 传给 Streamdown，若每次渲染
    // 新建数组，Streamdown 内部会重建 processor，流式期间的增量解析全部作废。
    const messageRemarkPlugins = useMemo<PluggableList>(
      () => [
        // 显式传 remarkPlugins 会覆盖 Streamdown 默认插件；
        // citation 必须和默认 GFM 插件一起传入，否则表格会退化成普通段落。
        ...messageDefaultRemarkPlugins,
        // Windows 绝对路径链接里的 `\.` 会在 remark 解析期被当成标点转义吃掉
        // rehype 阶段已经看不到原文。这条还原必须无条件生效，不能挂在 citation 开关下。
        windowsFileLinkEscapeRemarkPlugin,
        ...(renderZCodeFileCitations && workspacePath
          ? [createZCodeFileCitationRemarkPlugin(workspacePath, workspaceHomePath)]
          : []),
      ],
      [renderZCodeFileCitations, workspaceHomePath, workspacePath],
    );
    // [权衡] 第一行与最后一行去掉外边距：消息气泡内部不应出现“顶部空白”，
    // 否则同一条消息与上一条会视觉粘连或突然裂开；用子选择器而不是给每个块加类，
    // 因为正文块由 markdown 渲染器动态产生。
    const responseClassName = cn(
      "size-full text-ui-base leading-[1.75] tracking-wide [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
      className,
    );
    // [失败路径] 降级态必须复用同一套排版类再叠加 pre-wrap：如果单独写一套，
    // 错误恢复后的文本宽度/行高会与正常渲染不同，用户会看到一次明显的“排版跳动”。
    const fallbackClassName = cn(responseClassName, "whitespace-pre-wrap break-words");
    // [事务] resetKey 的两条分支刻意不对称（INV-17）：流式期间只用模式常量，
    // 因为每帧正文都在变；终态才把内容哈希拼进去，用来在“用户重发/编辑”后
    // 给错误边界一次新的重试机会。写反会导致流式每帧重置错误边界。
    const boundaryResetKey = useMemo(
      () =>
        renderStreaming
          ? `streaming:${streamdownMode}`
          : `${streamdownMode}:${renderZCodeFileCitations ? "citations" : "plain"}:${hashMarkdownCacheKey(targetMarkdown)}`,
      [renderStreaming, renderZCodeFileCitations, streamdownMode, targetMarkdown],
    );
    // [权衡] scope 只带“诊断用元数据”，不带正文：它被传给错误边界仅用于打日志，
    // 若把 targetMarkdown 也放进来，每次渲染都会新建一个大对象并参与依赖比较。
    const boundaryScope = useMemo<MessageResponseBoundaryScope>(
      () => ({
        markdownLength: targetMarkdown.length,
        mode: streamdownMode,
        renderStreaming,
      }),
      [renderStreaming, streamdownMode, targetMarkdown.length],
    );
    // [事务] 主题与 shiki 主题对必须分开缓存：前者是“单个生效主题”，供代码块
    // 高亮使用；后者是 [亮, 暗] 二元组，供 shiki 的双主题 class 策略使用。
    // 合成一个对象会让 Streamdown 侧无法区分“只是模式变了”与“主题集合变了”。
    const codeBlockTheme = useMemo(
      () => resolveMessageCodeTheme(theme, codePreviewSettings),
      [codePreviewSettings, theme],
    );
    // [事务] 依赖数组必须精确到 path 而不是整个 codePreviewSettings 对象：
    // 上层每次渲染都可能新建该对象，用对象作依赖会让这个 memo 每帧失效，
    // 进而让 streamdownRenderKey 每帧变化、markdown 子树被反复重挂载。
    const shikiTheme = useMemo(
      () =>
        [codePreviewSettings.lightTheme, codePreviewSettings.darkTheme] as [
          BundledTheme,
          BundledTheme,
        ],
      [codePreviewSettings.lightTheme, codePreviewSettings.darkTheme],
    );
    // [事务] 末尾追加 ":wrap-locked" 是必需的双重保险：wrapLongLines 可能因为
    // 用户设置本来就是 true，此时 forceCodeWrap 从 false 变 true 不会改变前者，
    // 若不额外加后缀，已挂载的代码块收不到“已被锁死”的信号，换行按钮仍会显示。
    const streamdownRenderKey = useMemo(() => {
      return (
        buildMessageStreamdownRenderKey({
          attachmentReaderEpoch: getAttachmentReaderEpoch(readAttachment),
          codeBlockTheme,
          fontSizePx: codePreviewSettings.fontSizePx,
          renderZCodeFileCitations,
          sessionId,
          workspacePath,
          workspaceHomePath,
          workspaceIdentity,
          workspaceRemoteSessionId,
          wrapLongLines,
        }) + (forceCodeWrap ? ":wrap-locked" : "")
      );
    }, [
      codeBlockTheme,
      codePreviewSettings.fontSizePx,
      wrapLongLines,
      forceCodeWrap,
      renderZCodeFileCitations,
      readAttachment,
      sessionId,
      workspaceHomePath,
      workspacePath,
      workspaceIdentity,
      workspaceRemoteSessionId,
    ]);
    // [事务] 渲染器映射本身也是 memo 的：这份对象被 Streamdown 用于逐节点渲染，
    // 每次新建会让其内部缓存全部失效；依赖里列出所有被闭包捕获的 props，
    // 少一个就会出现“闭包读到旧值”的经典问题（见 INV-15）。
    const messageComponents = useMemo(
      () => ({
        a: ({
          children,
          className: linkClassName,
          href,
          node: _node,
        }: ComponentProps<"a"> & { node?: unknown }) => {
          const resolvedHref =
            typeof href === "string" ? stripBalancedAssistantPathQuotes(href) : "";
          const fileLink = resolveMarkdownFileLink(workspacePath, resolvedHref, {
            homePath: workspaceHomePath,
          });

          // [失败路径] 两个条件缺一不可：既要能解析出工作区文件，又必须至少有一个
          // 打开通道（onOpenFileLink 或 onOpenCodeViewer）。只判前者会渲染出一个
          // “点了没反应”的按钮；只判后者则会把所有链接都当成文件。
          if (fileLink && (onOpenFileLink || onOpenCodeViewer)) {
            const descriptor = resolveFileDisplayDescriptor(fileLink.path);
            const fileName = descriptor.fileName || getPathLeaf(fileLink.path);
            // [权衡] label 优先取链接自身的文本，缺省回退到文件名：markdown 里
            // `[查看配置](.env)` 的可见文本才是用户预期，而 `[](a.ts)` 这种空 label
            // 必须补出文件名，否则按钮上只剩一个图标、无法辨认。
            const labelText = extractLinkLabelText(children) || fileName;
            const fileLinkTarget = buildMessageFileLinkTarget({
              href: resolvedHref,
              path: fileLink.path,
              label: labelText,
              workspacePath,
              workspaceIdentity,
              workspaceRemoteSessionId,
            });
            const fileIconSrc =
              fileLinkTarget.pathKind === "directory"
                ? FOLDER_FILE_ICON_SRC
                : descriptor.fileIconSrc;
            return (
              <MessageFileLink
                className={linkClassName}
                fileIconSrc={fileIconSrc}
                fileLink={fileLinkTarget}
                onOpen={() => {
                  // [事务] onOpenFileLink 优先且独占：一旦提供，就不应再回落到
                  // 内置代码查看器，否则同一路径可能被两个宿主各开一次窗口。
                  if (onOpenFileLink) {
                    onOpenFileLink(fileLinkTarget);
                    return;
                  }
                  onOpenCodeViewer?.({
                    type: "file",
                    title: getPathLeaf(fileLink.path),
                    path: fileLink.path,
                    workspacePath,
                    workspaceIdentity,
                    workspaceRemoteSessionId,
                  });
                }}
              />
            );
          }

          if (isExternalWebHref(resolvedHref) && onOpenExternalUrl) {
            return (
              <MessageExternalLink
                className={linkClassName}
                href={resolvedHref}
                onOpenExternalUrl={onOpenExternalUrl}
              >
                {children}
              </MessageExternalLink>
            );
          }

          // [失败路径] 最后一个分支必须是不可点击的 span：无法打开或不安全的链接
          // 需要保留可见文本（用户仍要读到 URL），但绝不能渲染成 a/button，
          // 否则等于给 file://、javascript: 之类的 href 提供了一个入口（INV-28）。
          return (
            <span
              className={cn(messageLinkClassName, linkClassName)}
              title={resolvedHref || undefined}
            >
              {children}
            </span>
          );
        },
        // [资源] img 渲染器把 readAttachment 原样透传：图片可能是附件（非公网 URL），
        // 只能经当前会话的 reader 读成 blob；这也是它必须进 renderKey 的原因（INV-15）。
        img: (imageProps: MarkdownImageProps) => (
          <MarkdownImage
            {...imageProps}
            workspacePath={workspacePath}
            workspaceHomePath={workspaceHomePath}
            sessionId={sessionId}
            readAttachment={readAttachment}
          />
        ),
        // [权衡] p 被换成 MarkdownImageParagraph：连续图片块需要被包成网格容器，
        // 否则每张图各占一段、间距忽大忽小；普通段落行为由该组件内部保持。
        p: MarkdownImageParagraph,
        h1: (headingProps: MarkdownHeadingProps) => (
          <MessageMarkdownHeading {...headingProps} headingLevel="h1" />
        ),
        h2: (headingProps: MarkdownHeadingProps) => (
          <MessageMarkdownHeading {...headingProps} headingLevel="h2" />
        ),
        h3: (headingProps: MarkdownHeadingProps) => (
          <MessageMarkdownHeading {...headingProps} headingLevel="h3" />
        ),
        h4: (headingProps: MarkdownHeadingProps) => (
          <MessageMarkdownHeading {...headingProps} headingLevel="h4" />
        ),
        h5: (headingProps: MarkdownHeadingProps) => (
          <MessageMarkdownHeading {...headingProps} headingLevel="h5" />
        ),
        h6: (headingProps: MarkdownHeadingProps) => (
          <MessageMarkdownHeading {...headingProps} headingLevel="h6" />
        ),
        strong: ({
          className: strongClassName,
          node: _node,
          ...strongProps
        }: MarkdownStrongProps) => (
          <strong className={cn("font-medium", strongClassName)} {...strongProps} />
        ),
        // [事务] 行内与块级代码的判定只看 data-block 是否存在于剩余 props（INV-20）：
        // Streamdown 只在块级 code 上注入该属性，语言类名对它不可靠（无语言时没有类名）。
        // 判定写在解构之后，因为 data-block 必须从 codeProps 里透传给块级分支。
        code: ({
          children,
          className: codeClassName,
          node: _node,
          ...codeProps
        }: MarkdownCodeProps) => {
          const isBlockCode = "data-block" in codeProps;

          if (!isBlockCode) {
            // [权衡] 行内代码不包 CodeBlock：它没有语言、没有复制按钮，也不需要
            // 异步高亮；走轻量标签可以避免每个 `code` 都挂一份高亮器与工具栏。
            return (
              <code
                className={cn(
                  "rounded-md bg-markdown-inline-code/50 mx-0.5 px-1.5 py-0.5 font-mono text-ui-sm",
                  codeClassName,
                )}
                {...codeProps}
              >
                {children}
              </code>
            );
          }

          // [事务] 代码文本必须先拍平再裁剪尾部换行：children 是嵌套 ReactNode，
          // 且围栏末尾天然多一个换行；顺序反了（先 trim 再拍平）无法覆盖嵌套节点。
          const codeText = trimCodeFenceTrailingNewlines(extractCodeText(children));
          const language = getCodeLanguage(codeClassName);

          return (
            <CodeBlock
              className="my-4 border border-border bg-card"
              code={codeText}
              // 流式消息里的代码围栏会被 Streamdown 反复拆分/重挂载。
              // 高亮等消息完成后再启动，避免 async highlighter 和消息流更新叠加触发 React #185。
              enableSyntaxHighlighting={!renderStreaming}
              fontSizePx={codePreviewSettings.fontSizePx}
              language={language}
              renderMermaid={!renderStreaming}
              theme={codeBlockTheme}
              appTheme={theme}
              wrapLongLines={wrapLongLines}
            >
              <CodeBlockHeader
                className="pl-3 pr-2 pt-2"
                language={language}
                // [失败路径] showWrapButton 必须与 forceCodeWrap 相反（INV-23）：
                // 办公模式锁死换行后，按钮仍然存在会让用户点一下“取消换行”，
                // 而实际渲染已由 forceCodeWrap 强制，表现为按钮失灵。
                showWrapButton={!forceCodeWrap}
              />
            </CodeBlock>
          );
        },
        blockquote: MarkdownBlockquote,
        li: MarkdownListItem,
        ol: MarkdownOrderedList,
        table: MarkdownTable,
        tbody: MarkdownTableBody,
        td: MarkdownTableCell,
        th: MarkdownTableHead,
        thead: MarkdownTableHeader,
        tr: MarkdownTableRow,
        ul: MarkdownUnorderedList,
      }),
      // [失败路径] 这份依赖数组必须与上面渲染器实际读取的 props 一一对应：
      // 少一项 → 闭包捕获旧值（主题/会话切换后内容不更新）；多一项无关值 →
      // memo 失效，长列表里的每条消息都会重建整棵组件映射。
      [
        codeBlockTheme,
        codePreviewSettings.fontSizePx,
        wrapLongLines,
        forceCodeWrap,
        onOpenFileLink,
        onOpenCodeViewer,
        onOpenExternalUrl,
        readAttachment,
        renderStreaming,
        sessionId,
        theme,
        workspaceHomePath,
        workspacePath,
        workspaceIdentity,
        workspaceRemoteSessionId,
      ],
    );

    // [权衡] 整棵 markdown 由错误边界包住，而不是在渲染器里逐块 try/catch：
    // 逐块捕获会把失败成本摊到每条消息的每个节点上，而真正的失败通常来自
    // processor 级异常。边界在这里只需付一次成本（INV-18）。
    return (
      <MessageResponseMarkdownBoundary
        className={fallbackClassName}
        fallbackText={targetMarkdown}
        resetKey={boundaryResetKey}
        scope={boundaryScope}
      >
        <Streamdown
          key={streamdownRenderKey}
          className={responseClassName}
          // Streamdown 自身是 memo，比较函数不看 components。app light/dark 切换时
          // codeBlockTheme 只存在于自定义 code renderer 闭包里，若不改 key，当前 task 已挂载的
          // markdown 代码块不会重新执行 renderer；切换 task 触发重建后才会恢复正确主题。
          // Artifact reader/session 同样只存在于 img renderer 闭包里。权限上下文变化时必须重挂载
          // markdown 子树，释放旧 blob URL，并确保后续读取只使用当前会话的 reader。
          // 已结束消息之前也一直走 streaming mode，会触发 remend 对正文做“未闭合 markdown 补全”。
          // 遇到 `./src/**/*` 这类代码片段时，remend 会误判成未闭合粗体并在末尾补出 `**`。
          // 性能优化曾让长历史消息也启用 block streaming 模式复用分块缓存；虚拟滚动/懒渲染会
          // 频繁重挂载历史消息，生产上遇到部分 markdown 会在 Streamdown 内部触发 React #185。
          // 这里重新收敛为：只有真实流式输出走 streaming 解析，完成态一律 static。
          mode={streamdownMode}
          components={messageComponents}
          parseIncompleteMarkdown={streaming}
          // Streamdown 内置 code renderer 的 highlighted-body 会在代码高亮结果和 raw fallback
          // 之间反复 setState，部分历史消息恢复时会触发 React #185。这里保留 markdown 解析能力，
          // 但代码块改走本项目自己的稳定 CodeBlock 渲染器。
          // 说明：这里继续关掉 Streamdown 默认链接行为，统一改由上面的自定义 a 渲染器接管。
          // 这样工作区文件链接和 http/https 外链都能走我们自己的安全分流，其它协议仍保持不可点击。
          linkSafety={messageLinkSafety}
          plugins={streamdownPlugins}
          controls={STREAMDOWN_CONTROLS}
          // Streamdown 的 harden 插件会在自定义 a renderer 之前把 file:// 标成 [blocked]。
          // 这里先把 file URI 规整成本地路径 href，让后续 resolveMarkdownFileLink 统一走预览/文件树打开逻辑。
          rehypePlugins={messageRehypePlugins}
          remarkPlugins={messageRemarkPlugins}
          shikiTheme={shikiTheme}
          // markdown 正文流式淡入会在重渲染时让历史文本整段重新闪烁。
          // 这里保留 streaming 解析模式，但彻底关闭 Streamdown/正文 rehype 动画。
          animated={false}
          isAnimating={false}
        >
          {targetMarkdown}
        </Streamdown>
      </MessageResponseMarkdownBoundary>
    );
  },
  messageResponsePropsAreEqual,
);

MessageResponse.displayName = "MessageResponse";

export type MessageToolbarProps = ComponentProps<"div">;

// [权衡] 工具栏固定 justify-between + mt-4：动作按钮在左、状态在右是消息区的
// 既有约定；把它做成组件是为了让各调用方的工具栏间距一致，而不是各自拼 className。
export const MessageToolbar = ({ className, children, ...props }: MessageToolbarProps) => (
  <div className={cn("mt-4 flex w-full items-center justify-between gap-4", className)} {...props}>
    {children}
  </div>
);
