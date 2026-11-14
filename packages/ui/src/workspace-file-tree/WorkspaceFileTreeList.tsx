// INV-01 遮罩偏移：守住位置 CSS 变量与内联样式；改错故障：吸顶文件夹下方露出列表原行。
// INV-02 行高一致：守住位置 遮罩高度与虚拟行高常量；改错故障：遮罩高度与实际行高不符，顶部留缝。
// INV-03 零吸顶早退：守住位置 吸顶数为零的分支；改错故障：无吸顶时仍生成遮罩，列表顶部被裁。
// INV-04 布局不变：守住位置 遮罩只做视觉隐藏；改错故障：为遮罩改动高度导致滚动范围变化。
// INV-05 键稳定：守住位置 行视图的键；改错故障：展开目录时行组件错位复用。
// INV-06 选中比较：守住位置 路径比较函数；改错故障：大小写或分隔符差异导致选中高亮丢失。
// INV-07 状态回退：守住位置 Git 状态的空值合并；改错故障：忽略文件显示成干净。
// INV-08 目录状态：守住位置 目录类型判断；改错故障：文件行拿到目录聚合状态。
// INV-09 虚拟项守卫：守住位置 下标越界判断；改错故障：裁剪过程中读到空值抛错。
// INV-10 空态优先：守住位置 错误、加载、空列表的先后顺序；改错故障：加载中同时显示空态。
// INV-11 根错误：守住位置 根错误分支；改错故障：读盘失败被当作空目录。
// INV-12 可访问性：守住位置 树角色与标签；改错故障：读屏无法识别文件树。
// INV-13 属性透传：守住位置 行视图的属性集合；改错故障：编辑器能力丢失，右键菜单不可用。
// INV-14 远程标识：守住位置 远程目标与工作区身份传参；改错故障：远程路径被当作本地文件打开。
// INV-15 外部链接：守住位置 打开浏览器回调；改错故障：预览里的链接无法打开。
// INV-16 键盘委托：守住位置 键盘事件回调；改错故障：方向键与回车在行间失效。
// INV-17 样式合并：守住位置 列表样式的展开顺序；改错故障：遮罩样式覆盖高度。
// INV-18 纯渲染：守住位置 组件内无副作用；改错故障：渲染期触发滚动同步。
//
// 模块职责：渲染工作区文件树的虚拟列表，含吸顶遮罩、Git 状态与编辑器能力透传。
// 状态所有权：行数据、选中与虚拟项均由上层传入；本组件只做条件分支与行渲染。
// 阅读顺序：遮罩样式 → 列表组件 → 空态分支 → 行渲染 → 虚拟项映射。
import type { CSSProperties, KeyboardEvent, RefCallback } from "react";
import type { VirtualItem } from "@tanstack/react-virtual";
import { AlertCircle, Files, LoaderCircle } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  areWorkspaceFilePathsEqual,
  getWorkspaceDirectoryGitStatuses,
  getWorkspaceFileGitStatus,
  isWorkspaceFileGitIgnored,
  type WorkspaceFileGitStatus,
  type WorkspaceFileTreeRow,
} from "@/workspace-file-tree/model.js";
import { WorkspaceFileTreeNotice } from "@/workspace-file-tree/WorkspaceFileTreeNotice.js";
import { WorkspaceFileTreeRowView } from "@/workspace-file-tree/WorkspaceFileTreeRowView.js";
import { WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX } from "@/workspace-file-tree/constants.js";
import type {
  WorkspaceFileGitStatusLabels,
  WorkspaceFileTreeContextMenuLabels,
  WorkspaceFileTreeEditorState,
} from "@/workspace-file-tree/types.js";

// 遮罩偏移变量：由原生滚动事件写入，样式只读不回写，保证布局与滚动范围不变。
// 变量名与读取处必须一致，改名时两侧同改，否则遮罩停在初始位置。
//
export const WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY =
  "--workspace-file-tree-mask-offset";

// 遮罩只隐藏视口顶部与吸顶等高的区域，mask-image 的其余部分保持可见。
// 遮罩尺寸扣掉偏移量，偏移越大可见区域越小，与滚动位置同步。
// 返回空值表示不需要遮罩，列表样式里靠展开空值自然跳过。
//
export function getWorkspaceFileTreeListMaskStyle({
  stickyFolderCount,
}: {
  stickyFolderCount: number;
}): CSSProperties | undefined {
  // 零吸顶直接退出：没有吸顶行时任何遮罩都会误裁列表首行。
  // 该判断是遮罩存在性的唯一开关，不要在下游再补条件。
  //
  if (stickyFolderCount === 0) {
    return undefined;
  }
  const hiddenHeight =
    stickyFolderCount * WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX;
  // 修复原因：sticky 与虚拟列表是滚动容器内的兄弟节点，列表原行仍会从 sticky 下方经过。
  // 遮罩通过原生 scroll 事件同步 CSS 变量，只隐藏视口顶部的吸顶高度，不改变列表布局和滚动范围。
  const maskImage = `linear-gradient(to bottom, transparent 0 ${hiddenHeight}px, black ${hiddenHeight}px)`;
  const maskPosition = `0 var(${WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY})`;
  const maskSize = `100% calc(100% - var(${WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY}))`;
  return {
    WebkitMaskImage: maskImage,
    maskImage,
    WebkitMaskPosition: maskPosition,
    maskPosition,
    WebkitMaskSize: maskSize,
    maskSize,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
  };
}

// 列表组件：负责三种非列表态与正常虚拟列表的分支，行细节交给行视图。
// 入参分成三组：数据（行、虚拟项、Git 映射）、能力（编辑器、远程目标）、回调。
// 选中比较必须走 normalizePath 归一后再比，不能直接用字符串相等。
// 行键取完整路径，目录展开导致行序变化时仍能命中同一 key。
// virtualItems 可能含越界下标，映射时必须逐项判空再取 rows[index]。
//
export function WorkspaceFileTreeList({
  rootError,
  showInitialLoading,
  rows,
  virtualItems,
  listRef,
  stickyFolderCount,
  totalSize,
  emptyTitle,
  workspaceTitle,
  workspacePath,
  workspaceIdentity,
  selectedPath,
  gitStatusByPath,
  ignoredPathSet,
  gitStatusLabelByStatus,
  contextMenuLabels,
  editorState,
  onSelect,
  onToggleDirectory,
  onOpenPreview,
  onOpenBrowserUrl,
  onKeyDown,
}: {
  rootError: Error | null;
  showInitialLoading: boolean;
  rows: WorkspaceFileTreeRow[];
  virtualItems: VirtualItem[];
  listRef: RefCallback<HTMLDivElement>;
  stickyFolderCount: number;
  totalSize: number;
  emptyTitle: string;
  workspaceTitle: string;
  workspacePath: string;
  workspaceIdentity?: string;
  selectedPath: string | null;
  gitStatusByPath: Map<string, WorkspaceFileGitStatus>;
  ignoredPathSet: Set<string>;
  gitStatusLabelByStatus: WorkspaceFileGitStatusLabels;
  contextMenuLabels: WorkspaceFileTreeContextMenuLabels;
  editorState: WorkspaceFileTreeEditorState;
  onSelect: (path: string) => void;
  onToggleDirectory: (row: WorkspaceFileTreeRow) => void;
  onOpenPreview: (row: WorkspaceFileTreeRow) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onKeyDown: (
    event: KeyboardEvent<HTMLDivElement>,
    row: WorkspaceFileTreeRow,
  ) => void;
}) {
  // 文案只在本层取一次，行视图与通知组件都通过属性接收，避免各自重复初始化国际化。
  // rootError、showInitialLoading 与空列表三种分支共用 WorkspaceFileTreeNotice 的图标与标题结构。
  //
  const { intl } = useZCodeIntl();
  if (rootError) {
    return (
      <WorkspaceFileTreeNotice
        icon={<AlertCircle className="size-4" />}
        title={intl.formatMessage({ id: "workspaceFileTree.readFailed" })}
        description={rootError.message}
      />
    );
  }
  // 加载态先于空态判断：初次加载时行数也为零，顺序反了会闪一帧空提示。
  // 根错误优先级最高，读盘失败时必须给出错误而不是空目录。
  //
  if (showInitialLoading) {
    return (
      <WorkspaceFileTreeNotice
        icon={<LoaderCircle className="size-4 animate-spin" />}
        title={intl.formatMessage({ id: "common.loading" })}
      />
    );
  }
  if (rows.length === 0) {
    return (
      <WorkspaceFileTreeNotice
        icon={<Files className="size-4" />}
        title={emptyTitle}
      />
    );
  }
  // 行渲染：把选中、Git 状态、目录聚合状态与编辑器能力一次性算好再交给行视图。
  // 文件行不给目录状态，忽略文件在没有任何状态时回退为忽略标记。
  // 样式只包含高度与位移，视觉细节留在行视图内部。
  //
  const renderRow = (row: WorkspaceFileTreeRow, style: CSSProperties) => (
    <WorkspaceFileTreeRowView
      key={row.path}
      row={row}
      selected={
        selectedPath !== null &&
        areWorkspaceFilePathsEqual(selectedPath, row.path)
      }
      gitStatus={
        getWorkspaceFileGitStatus(gitStatusByPath, row.path) ??
        (isWorkspaceFileGitIgnored(ignoredPathSet, row.path) ? "ignored" : null)
      }
      directoryGitStatuses={
        row.type === "directory"
          ? getWorkspaceDirectoryGitStatuses(gitStatusByPath, row.path)
          : []
      }
      gitStatusLabelByStatus={gitStatusLabelByStatus}
      contextMenuLabels={contextMenuLabels}
      canOpenLocalFileManager={editorState.canOpenLocalFileManager}
      installedEditors={editorState.installedEditors}
      isRemoteWorkspaceFileTree={editorState.isRemoteWorkspaceFileTree}
      remoteTarget={editorState.remoteTarget}
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      style={style}
      onSelect={onSelect}
      onToggleDirectory={onToggleDirectory}
      onOpenPreview={onOpenPreview}
      onOpenBrowserUrl={onOpenBrowserUrl}
      onKeyDown={onKeyDown}
    />
  );
  // 列表样式：高度取虚拟化总尺寸，保证滚动条长度与内容一致。
  // 高度必须用总尺寸而不是行数乘行高，分组行会让两者不等。
  // 遮罩偏移变量先写初值再展开遮罩样式，展开顺序决定谁覆盖谁。
  //
  const listStyle: CSSProperties &
    Record<typeof WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY, string> = {
    [WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY]: "0px",
    height: `${totalSize}px`,
    ...getWorkspaceFileTreeListMaskStyle({ stickyFolderCount }),
  };
  return (
    <div
      ref={listRef}
      className="relative w-full"
      style={listStyle}
      role="tree"
      aria-label={workspaceTitle}
    >
      {virtualItems.map((virtualItem) => {
        const row = rows[virtualItem.index];
        if (!row) {
          return null;
        }
        return renderRow(row, {
          height: `${virtualItem.size}px`,
          transform: `translateY(${virtualItem.start}px)`,
        });
      })}
    </div>
  );
}
