// WorkspaceFileTreeRowView：文件树单行的视图层，把行数据、Git 状态与回调投影成一行可交互 DOM
// 只负责渲染与把用户动作转成回调；树的装载、展开状态、Git 聚合与真实打开逻辑都在上层与 model/platform 边界
// 这里不持有持久状态，也不自行拼接路径或 URI——任何跨进程格式都由共享工具与 main 侧生成
//
// INV-01 断言：deleted 虚拟文件不得触发预览或外部打开 —— 守住它的位置：isDeletedFile 在 handleRowClick/handleOpenPrimary/handleOpenInEditor 的早退 —— 改错故障：点击 Git deleted 行会读取已消失的路径，弹出文件不存在并刷出主进程读文件错误
// INV-02 断言：目录单击只切换展开，不打开预览 —— 守住它的位置：handleRowClick 的 isDirectory 分支 —— 改错故障：点目录会同时展开并尝试预览，目录被当成文件读取而失败
// INV-03 断言：双击的第二下不得重复行主动作 —— 守住它的位置：handleRowClick 的 event.detail 大于 1 早退 —— 改错故障：双击文件触发两次预览，标签页或窗口重复出现
// INV-04 断言：上下文菜单首项复用行主动作语义 —— 守住它的位置：handleOpenPrimary 与 contextMenuLabels.open 的组合 —— 改错故障：首项显示成在 Finder 中打开，行为却是预览，用户点错
// INV-05 断言：打开方式必须透传 remoteTarget 与 workspaceIdentity —— 守住它的位置：handleOpenInEditor 传给 platform.openInEditor 的参数 —— 改错故障：远程工作区按本机 Linux 路径打开，文件不存在或打开错误仓库
// INV-06 断言：打开失败要同时写日志与 toast —— 守住它的位置：handleOpenInEditor 的 result.success 之后分支 —— 改错故障：静默失败，用户点击无反应且没有日志可查
// INV-07 断言：目录展开加载中不展示聚合 Git 圆点 —— 守住它的位置：shouldShowDirectoryGitDots 的 row.loading 判断 —— 改错故障：spinner 与状态点并存，加载态与 Git 态语义混淆
// INV-08 断言：单文件状态与目录聚合状态是两套展示 —— 守住它的位置：gitStatusText 与 shouldShowDirectoryGitDots 的互斥 —— 改错故障：目录行同时渲染字符标记和圆点，或文件行渲染聚合圆点
// INV-09 断言：拖拽 payload 字段与 relativePath 同源 —— 守住它的位置：workspaceFilePayload 构造处 —— 改错故障：拖进聊天的相对路径与实际工作区不符，引用指向错误文件
// INV-10 断言：拖拽必须同时写自定义 MIME 与 text/plain —— 守住它的位置：onDragStart 的两次 setData —— 改错故障：跨区域拖入拿不到 payload，回退成裸文本或直接拒收
// INV-11 断言：拖拽开始与结束必须成对同步拖拽态 —— 守住它的位置：setIsDragging 与 dispatchWorkspaceFileDragState 的两处调用 —— 改错故障：拖拽被取消后树仍高亮，引导线持续隐藏
// INV-12 断言：deleted 行不可拖拽 —— 守住它的位置：draggable 属性与 onDragStart 的早退 —— 改错故障：拖出虚拟文件会生成指向不存在路径的 drop 目标
// INV-13 断言：层级引导线只在非拖拽时渲染 —— 守住它的位置：rowElement 中的 hierarchyGuideStyle 与 isDragging 合取 —— 改错故障：拖拽中引导线跟随重绘，行内容抖动
// INV-14 断言：WSL 资源管理器必须复用打开编辑器通道 —— 守住它的位置：handleRevealInFileManager 的 wslFileManagerEditor 分支与 canRevealInFileManager —— 改错故障：WSL 路径交给本机文件管理器直接失败，或菜单项被误禁用
// INV-15 断言：浏览器打开仅限本地 HTML 且存在回调 —— 守住它的位置：canOpenInBrowser 的四项合取 —— 改错故障：远程工作区点浏览器打开会得到本机访问不到的地址
// INV-16 断言：删除态行一律禁用外部打开能力 —— 守住它的位置：canOpenPrimary 与打开方式子菜单的 disabled —— 改错故障：虚拟行仍可打开编辑器，报路径不存在
// INV-17 断言：复制路径走 fileActions，不自行拼字符串 —— 守住它的位置：handleCopyAbsolutePath 与 handleCopyRelativePath —— 改错故障：Windows 反斜杠与远程前缀不一致，粘贴后路径不可用
// INV-18 断言：根容器定位方式由 layout 决定 —— 守住它的位置：最外层 div 的 layout 判断与 style 合并 —— 改错故障：改成 static 后虚拟列表行全部堆在顶部，行高与滚动错位
import { SidebarNativeTooltip, ControlHintTooltip } from "@/ControlHintTooltip.js";
/* eslint-disable max-lines -- 文件树行集中维护拖拽、打开方式、Git 状态与上下文菜单交互。 */
import type { EditorInfo, OpenInEditorRemoteTarget } from "@zcode/shared";
import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import { AlertCircle, ChevronRight, LoaderCircle } from "lucide-react";
import { TID_WORKSPACE_FILE_TREE_ROW, testId } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { logger } from "@/logger.js";
import { resolveWorkspaceFileManagerEditor } from "@/lib/workspaceEditorSelection.js";
import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import {
  dispatchWorkspaceFileAddToChat,
  dispatchWorkspaceFileDragState,
  serializeWorkspaceFileDragPayload,
  WORKSPACE_FILE_DRAG_MIME,
} from "@/lib/workspaceFileDrag.js";
import {
  getWorkspaceFileRelativePath,
  isWorkspaceFileTreeDeletedFile,
  type WorkspaceFileGitStatus,
  type WorkspaceFileTreeRow,
} from "@/workspace-file-tree/model.js";
import {
  getWorkspaceFileGitStatusDotClassName,
  getWorkspaceFileGitStatusIndicator,
  getWorkspaceFileGitStatusIndicatorClassName,
  getWorkspaceFileGitStatusTextClassName,
  getWorkspaceFileTreeRowDisplayGitStatus,
} from "@/workspace-file-tree/statusStyles.js";
import type {
  WorkspaceFileGitStatusLabels,
  WorkspaceFileTreeContextMenuLabels,
} from "@/workspace-file-tree/types.js";
import {
  createWorkspaceFileTreeHtmlBrowserUrl,
  isWorkspaceFileTreeHtmlFile,
} from "@/workspace-file-tree/helpers.js";
import { getWorkspaceFileTreeHierarchyGuideStyle } from "@/workspace-file-tree/hierarchyGuides.js";
import { useWorkspaceFileTreeRowDragState } from "@/workspace-file-tree/useWorkspaceFileTreeRowDragState.js";
import { WorkspaceFileTreeRowName } from "@/workspace-file-tree/WorkspaceFileTreeRowName.js";

export function WorkspaceFileTreeRowView({
  layout = "absolute",
  row,
  selected,
  gitStatus,
  directoryGitStatuses,
  gitStatusLabelByStatus,
  contextMenuLabels,
  canOpenLocalFileManager,
  installedEditors,
  isRemoteWorkspaceFileTree,
  remoteTarget,
  workspacePath,
  workspaceIdentity,
  style,
  onSelect,
  onToggleDirectory,
  onOpenPreview,
  onOpenBrowserUrl,
  onKeyDown,
}: {
  layout?: "absolute" | "static";
  row: WorkspaceFileTreeRow;
  selected: boolean;
  gitStatus: WorkspaceFileGitStatus | null;
  directoryGitStatuses: WorkspaceFileGitStatus[];
  gitStatusLabelByStatus: WorkspaceFileGitStatusLabels;
  contextMenuLabels: WorkspaceFileTreeContextMenuLabels;
  canOpenLocalFileManager: boolean;
  installedEditors: EditorInfo[];
  isRemoteWorkspaceFileTree: boolean;
  remoteTarget?: OpenInEditorRemoteTarget;
  workspacePath: string;
  workspaceIdentity?: string;
  style: CSSProperties;
  onSelect: (path: string) => void;
  onToggleDirectory: (row: WorkspaceFileTreeRow) => void;
  onOpenPreview: (row: WorkspaceFileTreeRow) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: WorkspaceFileTreeRow) => void;
}) {
  // [契约] 平台能力只从 usePlatform 取，组件不碰 window.zcode，Web 端才有替身实现
  // 下面几个 hook 必须在组件顶层按固定顺序调用，不能塞进条件分支
  // 否则行节点被回收复用时 hook 数量变化，React 会直接抛渲染错误
  const platform = usePlatform();
  const { isDragging, setIsDragging } = useWorkspaceFileTreeRowDragState();
  // [契约] 复制绝对路径、复制相对路径与在文件管理器中显示都由这个 hook 统一实现
  // 失败文案从 contextMenuLabels 注入而不是在 hook 内写死，保证跟随当前语言包
  // isRemoteWorkspace 只影响本机文件管理器的可用性，不影响复制路径的结果
  const fileActions = useFileContextActions({
    canOpenLocalFileManager,
    isRemoteWorkspace: isRemoteWorkspaceFileTree,
    openFailedMessage: contextMenuLabels.openFailed,
  });
  // relativePath 同时用于 title 提示、拖拽 payload 与 mention 文案，三处必须同源
  // 不要改成 row.path，也不要在这里自行截断 workspacePath 前缀
  // 远程工作区里 workspacePath 可能是 URI 形式，只有这个工具函数知道如何对齐
  // 一旦不一致，拖进聊天的引用会指向工作区外的路径
  const relativePath = getWorkspaceFileRelativePath(workspacePath, row.path);
  const isDirectory = row.type === "directory";
  // [失败路径] deleted 行是 Git 状态补出来的虚拟条目，磁盘上并没有这个文件
  // 后续所有打开、预览、拖拽、在文件管理器中显示的入口都要先看这个标记
  // 只在某一个入口加判断不够：鼠标、键盘、菜单、拖拽是四条独立路径
  // 漏一条就会出现找不到文件的 toast 或主进程读文件异常
  const isDeletedFile = isWorkspaceFileTreeDeletedFile(row, gitStatus);
  // [权衡] WSL 场景没有真正的本机文件管理器，只能借编辑器通道打开资源管理器
  // 因此不能用 isRemoteWorkspaceFileTree 简单判断是否禁用显示
  // 解析结果为空才说明当前环境没有可用的 WSL 入口
  // 真正生成 URI 的位置在 main 的平台边界，组件越界会拿到错误格式
  const wslFileManagerEditor = resolveWorkspaceFileManagerEditor(installedEditors, remoteTarget);
  // depth 通过 CSS 变量下发，padding 与层级引导线读的是同一个值
  // 不要在 JSX 里再算一次缩进像素，否则换行复用时会与引导线错位
  // style 由上层传入，虚拟列表靠它做纵向定位，这里只做浅合并
  const rowStyle = {
    ...style,
    "--workspace-file-tree-depth": row.depth,
  } as CSSProperties;
  const hierarchyGuideStyle = getWorkspaceFileTreeHierarchyGuideStyle(row.depth);
  const fileIconSrc = isDirectory ? null : resolveFileDisplayDescriptor(row.path).fileIconSrc;
  // 单文件状态与目录聚合状态是两套展示：文件用字符标记，目录用圆点
  // 标签为空说明状态映射缺项，此时整块不渲染好过渲染空提示
  // 不要在 JSX 里对 gitStatus 再做一次判空，两处判断会让口径慢慢漂移
  const gitStatusLabel = gitStatus ? gitStatusLabelByStatus[gitStatus] : null;
  const gitStatusText = gitStatus ? getWorkspaceFileGitStatusIndicator(gitStatus) : null;
  const gitStatusIndicatorClassName = gitStatus
    ? getWorkspaceFileGitStatusIndicatorClassName(gitStatus)
    : null;
  // 目录行自身的 Git 状态往往为空，展示态需要从子项聚合得出
  // 聚合结果只用于文字颜色，不参与字符标记与圆点结构
  // 把聚合结果直接写回 gitStatus 会让目录被当成有变更的文件
  const rowDisplayStatus = getWorkspaceFileTreeRowDisplayGitStatus({
    gitStatus,
    directoryGitStatuses,
  });
  const rowStatusTextClassName = getWorkspaceFileGitStatusTextClassName(rowDisplayStatus);
  // 目录展开加载时右侧已经有 loading spinner，继续显示 Git 小圆点会让状态含义混在一起。
  // 加载期间隐藏目录聚合状态点，等目录加载完成后再展示真实 Git 状态。
  // [权衡] 目录加载中右侧已有 spinner，再叠一个圆点会让两种状态互相干扰
  // 判断必须包含 row.loading，不能只看 directoryGitStatuses 是否为空
  // 否则展开一个含变更子项的目录时，加载瞬间会闪出圆点再消失
  const shouldShowDirectoryGitDots = !row.loading && directoryGitStatuses.length > 0;
  // [契约] 拖拽、加入聊天、复制路径共用这一个 payload 结构
  // 行类型收敛成 file 与 directory 两个字面量，上层靠它区分图标与打开方式
  // workspaceIdentity 只在存在时展开，空值不能写成空字符串字段
  // 身份缺失时上层用 workspacePath 兜底做去重与绑定
  const workspaceFilePayload = {
    type: row.type === "directory" ? ("directory" as const) : ("file" as const),
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    path: row.path,
    relativePath,
    name: row.name,
  };

  // 单击语义被有意统一：目录展开、文件预览，都不需要双击
  // 如果改回单击只选中、双击才打开，目录展开会多一次点击
  // 选中先于动作执行，保证键盘与屏幕阅读器拿到的是当前行
  // 不要把 onSelect 挪进各分支，否则 deleted 行会失去选中能力
  const handleRowClick = (event: MouseEvent<HTMLDivElement>) => {
    onSelect(row.path);
    // 双击的第二下已经由第一次点击完成打开，这里必须早退
    // 否则一次双击会触发两次预览，标签页或窗口重复出现
    // detail 在触摸与部分 WebView 上可能恒为 1，不要依赖它做去抖
    if (event.detail > 1) {
      return;
    }
    if (isDirectory) {
      onToggleDirectory(row);
      return;
    }
    // [失败路径] deleted 行点击走到这里时只保留选中，然后直接返回
    // 继续往下会调用预览，主进程读文件必然失败并弹错误提示
    // 键盘 Enter 是另一条路径，在 onKeyDown 里单独拦一次
    if (isDeletedFile) {
      // 修复：Git deleted 行是从状态里补出来的虚拟文件，真实文件已不存在。
      // 点击时只保留选中能力，避免继续打开预览导致文件读取失败。
      return;
    }
    // 文件树单击文件之前只更新选中态，必须双击才打开预览。
    // 这里让文件和目录都保持“单击执行主要动作”：目录展开，文件预览。
    onOpenPreview(row);
  };
  const handleCopyAbsolutePath = async () => {
    await fileActions.copyAbsolutePath({ path: row.path });
  };
  const handleCopyRelativePath = async () => {
    await fileActions.copyRelativePath({ path: row.path, relativePath });
  };
  // 上下文菜单第一项复用行主动作，而不是固定的打开方式
  // 此前这里复用了默认外部应用文案，资源管理器置顶时会显示成在 Finder 中打开
  // 所以文案与行为必须一起改：文件打开预览，目录走展开与收起
  // 单独改文案或单独改行为都会让菜单项名不副实
  const handleOpenPrimary = () => {
    if (isDeletedFile) {
      return;
    }
    if (isDirectory) {
      onToggleDirectory(row);
      return;
    }
    onOpenPreview(row);
  };
  // [契约] 远程文件树不再整项禁用第三方打开，调用需要带全上下文
  // pathKind 决定 main 侧生成文件 URI 还是目录 URI，漏传会打开父级目录
  // remoteTarget 已脱敏，只用于挑选目标主机，不要在此解码或拼接
  // workspaceIdentity 用于跨窗口与远程会话关联，缺失时 main 侧按路径兜底
  const handleOpenInEditor = async (editor: EditorInfo) => {
    if (isDeletedFile) {
      return;
    }
    // 远程文件树以前整项禁用第三方打开，且调用只传 Linux path；
    // 这里把已脱敏 remoteTarget 与文件/目录类型交给 main，由唯一平台边界生成正确 URI。
    const result = await platform.openInEditor(editor.id, row.path, {
      pathKind: isDirectory ? "directory" : "file",
      remoteTarget,
      workspaceIdentity,
    });
    // [失败路径] 成功分支直接返回，失败必须同时落日志与提示
    // 日志里带 editorId 与 path，error 缺省补成 unknown-error，便于按行排查
    // 只弹 toast 不写日志会让远程打开失败无法归因
    // 只写日志不弹 toast 则用户以为点击没生效，会反复重试
    if (result.success) {
      return;
    }
    logger.warn("[WorkspaceFileTree] 打开文件树条目失败", {
      editorId: editor.id,
      path: row.path,
      error: result.error ?? "unknown-error",
    });
    toast(contextMenuLabels.openFailed);
  };
  const handleOpenInBrowser = () => {
    const url = createWorkspaceFileTreeHtmlBrowserUrl(row);
    if (!url) {
      return;
    }

    onOpenBrowserUrl?.(url);
  };
  // [权衡] 普通远程路径不能交给本机文件管理器，但 WSL Explorer 能在 main 边界转成 UNC
  // 因此有 WSL 入口时走 handleOpenInEditor，与打开方式共享同一条执行路径
  // 没有 WSL 入口才回落到 fileActions，由它判断当前平台是否允许
  // 两条路不要各写一份可用性判断，否则菜单项状态与实际行为会分叉
  const handleRevealInFileManager = async () => {
    if (wslFileManagerEditor) {
      await handleOpenInEditor(wslFileManagerEditor);
      return;
    }
    await fileActions.revealInFileManager({
      path: row.path,
      deleted: isDeletedFile,
      kind: isDirectory ? "directory" : "file",
    });
  };
  // 行元素被原生 tooltip 包裹，同时兼任右键菜单的 trigger
  // draggable 只在非 deleted 行开启，避免拖出指向不存在路径的目标
  // 这里只构造一次 DOM 树，ContextMenuTrigger 用 asChild 复用同一节点
  // 若外面再包一层 div，右键菜单的定位锚点会偏移到外层
  const rowElement = (
    <SidebarNativeTooltip>
      <div
        role="treeitem"
        data-testid={testId(TID_WORKSPACE_FILE_TREE_ROW, row.path)}
        aria-expanded={isDirectory ? row.expanded : undefined}
        tabIndex={0}
        draggable={!isDeletedFile}
        className={cn(
          "group/file-tree-row relative flex h-7 w-full min-w-0 items-center gap-1.5 rounded-lg border pr-2 py-1 text-left text-ui-base text-foreground outline-none transition-[background-color,border-color,box-shadow]",
          isDeletedFile ? "cursor-default" : "cursor-pointer",
          "pl-[calc(var(--workspace-file-tree-depth)*0.75rem+0.5rem)]",
          selected
            ? "border-input-border-focused bg-transparent hover:bg-surface-hover"
            : "border-transparent hover:bg-surface-hover",
          "focus-visible:border-border-hover",
        )}
        title={relativePath}
        onClick={handleRowClick}
        onContextMenu={() => onSelect(row.path)}
        onKeyDown={(event) => {
          // [失败路径] 键盘 Enter 与鼠标点击走的是两条独立路径
          // Enter 有可能被行内其他元素当默认动作触发，先 preventDefault 再只做选中
          // 这里返回后不再调用 onKeyDown，避免上层再次触发打开
          // 删掉这段会让 deleted 行仅通过键盘就能打开已删除的文件
          if (isDeletedFile && event.key === "Enter") {
            // 修复：键盘 Enter 和鼠标点击走的是两条路径；deleted 虚拟文件同样不能打开预览。
            event.preventDefault();
            onSelect(row.path);
            return;
          }
          onKeyDown(event, row);
        }}
        onDragStart={(event) => {
          if (isDeletedFile) {
            event.preventDefault();
            return;
          }
          // [契约] 一次拖拽要写两种格式：自定义 MIME 给树内与输入框，text/plain 给外部应用
          // text/plain 用 mention 语法，直接粘进编辑器就能得到文件引用
          // effectAllowed 设成 copy，防止拖拽被当成移动而清空源
          // 漏写 text/plain 时外部应用只能拿到空内容，漏写 MIME 时树内拖放会静默失败
          event.dataTransfer.effectAllowed = "copy";
          event.dataTransfer.setData(
            WORKSPACE_FILE_DRAG_MIME,
            serializeWorkspaceFileDragPayload(workspaceFilePayload),
          );
          event.dataTransfer.setData(
            "text/plain",
            buildFileMentionMarkdown(relativePath, row.name, row.type),
          );
          // [并发] 行内状态与进程级拖拽态要成对置位与复位
          // onDragEnd 必须两条都复位，拖拽被 Esc 或拖出窗口中断时同样会触发
          // 只改其中一处会让图标悬停样式与全局拖拽遮罩不同步
          setIsDragging(true);
          dispatchWorkspaceFileDragState(true);
        }}
        onDragEnd={() => {
          setIsDragging(false);
          dispatchWorkspaceFileDragState(false);
        }}
      >
        {/* 引导线上下各延伸 1px；12px 层级步进让最后一条线与当前层级图标之间稳定保留 4px。 */}
        {hierarchyGuideStyle && !isDragging ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -inset-y-px left-2.5"
            data-workspace-file-tree-hierarchy-guides={row.depth}
            style={hierarchyGuideStyle}
          />
        ) : null}
        {isDirectory ? (
          <span className="flex size-4 shrink-0 items-center justify-center text-foreground-subtle">
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-3 text-foreground-subtlest transition-transform",
                row.expanded && "rotate-90",
              )}
            />
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {fileIconSrc ? <FileDisplayIcon src={fileIconSrc} className="shrink-0 size-4" /> : null}
          <WorkspaceFileTreeRowName
            name={row.name}
            className={cn("min-w-0 flex-1 truncate", rowStatusTextClassName)}
            slashClassName="mx-1 text-foreground-subtlest"
          />
        </span>
        {gitStatusText && gitStatusLabel ? (
          <ControlHintTooltip
            title={gitStatusLabel}
            side="right"
            align="center"
            sideOffset={4}
            triggerClassName="ml-auto"
          >
            <span
              className={cn(
                "inline-flex shrink-0 justify-center font-mono text-ui-base font-bold leading-none",
                gitStatusIndicatorClassName,
              )}
              aria-label={gitStatusLabel}
            >
              {gitStatusText}
            </span>
          </ControlHintTooltip>
        ) : null}
        {shouldShowDirectoryGitDots ? (
          <ControlHintTooltip
            title={directoryGitStatuses.map((status) => gitStatusLabelByStatus[status]).join(", ")}
            side="right"
            align="center"
            sideOffset={4}
            triggerClassName="ml-1"
          >
            <span className="flex shrink-0 items-center" aria-label="●">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  getWorkspaceFileGitStatusDotClassName(directoryGitStatuses[0]),
                )}
              />
            </span>
          </ControlHintTooltip>
        ) : null}
        {row.loading ? (
          <LoaderCircle className="ml-2 size-3 shrink-0 animate-spin text-foreground-subtlest" />
        ) : row.error ? (
          <AlertCircle className="ml-2 size-3 shrink-0 text-warning" />
        ) : null}
      </div>
    </SidebarNativeTooltip>
  );
  // 普通远程路径不能交给本机文件管理器，但 WSL Explorer 会在 main 边界
  // 转成 UNC；因此它和“打开方式 → 资源管理器”必须共享相同的可用性与执行路径。
  // 可用性在这里合成，菜单项的 disabled 与点击后的执行分支共用同一判断
  // deleted 行对两条路径都不可用，即使存在 WSL 入口也不能显示
  // 把判断散进 JSX 会复现看起来可点但点了没反应的菜单项
  const canRevealInFileManager =
    (!isDeletedFile && Boolean(wslFileManagerEditor)) ||
    fileActions.canRevealInFileManager({
      path: row.path,
      deleted: isDeletedFile,
    });
  const canOpenPrimary = !isDeletedFile;
  // 浏览器打开只对本地 HTML 文件成立，且必须真的有回调
  // 远程工作区一律禁用，否则会得到一个本机访问不到的地址
  // isWorkspaceFileTreeHtmlFile 按扩展名判断，不要在这里再写一份后缀列表
  // 回调缺失时保留菜单项会点出无反应，所以也纳入合取条件
  const canOpenInBrowser =
    !isDeletedFile &&
    !isRemoteWorkspaceFileTree &&
    Boolean(onOpenBrowserUrl) &&
    isWorkspaceFileTreeHtmlFile(row);

  // [权衡] absolute 模式让行脱离文档流，配合虚拟列表的 transform 定位
  // 改成 static 后所有行会堆在容器顶部，滚动与行高全部错位
  // 包装层只负责定位与横向内边距，交互全部落在内层 rowElement
  return (
    <div
      className={cn(layout === "absolute" ? "absolute left-0 top-0 w-full px-1" : "w-full")}
      style={rowStyle}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>{rowElement}</ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem disabled={!canOpenPrimary} onSelect={handleOpenPrimary}>
            {/* 修复：第一项之前复用了默认外部应用文案，Finder/Explorer 置顶后会显示成“在 Finder 中打开”。
                这里改为复用行主动作：文件打开预览，目录走当前行的展开/收起逻辑。 */}
            {contextMenuLabels.open}
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={isDeletedFile || installedEditors.length === 0}>
              {contextMenuLabels.openWith}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-44">
              {installedEditors.map((editor) => (
                <ContextMenuItem key={editor.id} onSelect={() => void handleOpenInEditor(editor)}>
                  {editor.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          {canOpenInBrowser ? (
            <ContextMenuItem onSelect={handleOpenInBrowser}>
              {contextMenuLabels.openInBrowser}
            </ContextMenuItem>
          ) : null}
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!canRevealInFileManager}
            onSelect={() => void handleRevealInFileManager()}
          >
            {contextMenuLabels.reveal}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void handleCopyAbsolutePath()}>
            {contextMenuLabels.copyAbsolutePath}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void handleCopyRelativePath()}>
            {contextMenuLabels.copyRelativePath}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => dispatchWorkspaceFileAddToChat(workspaceFilePayload)}>
            {contextMenuLabels.addToChat}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
