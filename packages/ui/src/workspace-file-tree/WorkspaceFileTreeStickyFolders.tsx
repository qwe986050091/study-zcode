// INV-01 空列表返回 null：守住位置 items.length 判断；改错故障 页面顶部多出一个空容器吃掉点击。
// INV-02 容器高度为零：守住位置 h-0 与 overflow-visible；改错故障 吸顶行把正文向下顶。
// INV-03 点击权限分两层：守住位置 外层 none 与内层 auto；改错故障 吸顶行永远点不开菜单。
// INV-04 行视图用静态布局：守住位置 layout="static"；改错故障 吸顶行参与虚拟滚动定位，出现重影。
// INV-05 选中判定先判空：守住位置 selectedPath !== null；改错故障 空串把第一个文件标成选中。
// INV-06 git 状态先查映射：守住位置 getWorkspaceFileGitStatus；改错故障 已跟踪文件被忽略集覆盖。
// INV-07 忽略状态只作兜底：守住位置 ?? 右侧三元；改错故障 忽略文件显示为已修改。
// INV-08 目录状态单独汇总：守住位置 getWorkspaceDirectoryGitStatuses；改错故障 目录行显示成文件状态。
// INV-09 展开后下一帧再揭示：守住位置 requestAnimationFrame；改错故障 滚动目标尚未挂载，揭示落空。
// INV-10 回调全部由父级注入：守住位置 props 解构；改错故障 组件自己发请求，测试无法注入。
// INV-11 key 用行路径：守住位置 key={row.path}；改错故障 同目录多行共享展开状态。
// INV-12 样式固定空对象：守住位置 style={{}}；改错故障 动态定位干扰静态布局。
// INV-13 编辑器状态整组透传：守住位置 editorState 三字段；改错故障 新增字段漏传，菜单少项。
// INV-14 本组件只显示与转发：守住位置 文件内无 effect；改错故障 吸顶层出现第二份数据源。
//
// 模块职责：工作区文件树的吸顶文件夹行，复用行视图并转发选择与切换事件。
// 阅读顺序：先看空列表早退与两层容器，再看行视图参数，最后看展开后的揭示时机。
import type { KeyboardEvent } from "react";
import type { WorkspaceFileGitStatus, WorkspaceFileTreeRow } from "@/workspace-file-tree/model.js";
import {
  areWorkspaceFilePathsEqual,
  getWorkspaceDirectoryGitStatuses,
  getWorkspaceFileGitStatus,
  isWorkspaceFileGitIgnored,
} from "@/workspace-file-tree/model.js";
import { WorkspaceFileTreeRowView } from "@/workspace-file-tree/WorkspaceFileTreeRowView.js";
import type {
  WorkspaceFileGitStatusLabels,
  WorkspaceFileTreeContextMenuLabels,
  WorkspaceFileTreeEditorState,
  WorkspaceFileTreeStickyFolderItem,
} from "@/workspace-file-tree/types.js";

export function WorkspaceFileTreeStickyFolders({
  items,
  selectedPath,
  gitStatusByPath,
  ignoredPathSet,
  gitStatusLabelByStatus,
  contextMenuLabels,
  editorState,
  workspacePath,
  workspaceIdentity,
  onSelect,
  onToggleDirectory,
  onRevealRow,
  onOpenPreview,
  onOpenBrowserUrl,
  onKeyDown,
}: {
  items: WorkspaceFileTreeStickyFolderItem[];
  selectedPath: string | null;
  gitStatusByPath: Map<string, WorkspaceFileGitStatus>;
  ignoredPathSet: Set<string>;
  gitStatusLabelByStatus: WorkspaceFileGitStatusLabels;
  contextMenuLabels: WorkspaceFileTreeContextMenuLabels;
  editorState: WorkspaceFileTreeEditorState;
  workspacePath: string;
  workspaceIdentity?: string;
  onSelect: (path: string) => void;
  onToggleDirectory: (row: WorkspaceFileTreeRow) => void;
  onRevealRow: (item: WorkspaceFileTreeStickyFolderItem) => void;
  onOpenPreview: (row: WorkspaceFileTreeRow) => void;
  onOpenBrowserUrl?: (url: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: WorkspaceFileTreeRow) => void;
}) {
  // items.length === 0 时直接返回 null，不渲染吸顶容器。
  if (items.length === 0) {
    return null;
  }

  return (
    // 高度为零，靠 overflow-visible 叠在上方。
    <div className="pointer-events-none sticky top-0 z-10 h-0 overflow-visible px-1">
      <div className="pointer-events-auto overflow-hidden rounded-lg">
        {items.map((item) => {
          // row 是唯一数据源，item 只提供揭示入口。
          const row = item.row;
          // 先调 onToggle 交给父级切换，再决定是否 reveal。
          const handleToggle = (nextRow: WorkspaceFileTreeRow) => {
            onToggleDirectory(nextRow);
            if (nextRow.expanded) {
              // 等下一帧再滚动，确保展开后的行已挂载。
              requestAnimationFrame(() => onRevealRow(item));
            }
          };
          return (
            <WorkspaceFileTreeRowView
              // 同一目录可能有多行，用路径作 key。
              key={row.path}
              // layout="static" 保持静态布局，不参与虚拟列表定位。
              layout="static"
              row={row}
              // 先判空再比较，避免空串命中。
              selected={selectedPath !== null && areWorkspaceFilePathsEqual(selectedPath, row.path)}
              gitStatus={
                // 先查显式状态，缺失时再看忽略集。
                getWorkspaceFileGitStatus(gitStatusByPath, row.path) ??
                // 忽略状态只作为兜底。
                (isWorkspaceFileGitIgnored(ignoredPathSet, row.path) ? "ignored" : null)
              }
              // 目录状态单独汇总，不能复用文件状态。
              directoryGitStatuses={getWorkspaceDirectoryGitStatuses(gitStatusByPath, row.path)}
              gitStatusLabelByStatus={gitStatusLabelByStatus}
              contextMenuLabels={contextMenuLabels}
              canOpenLocalFileManager={editorState.canOpenLocalFileManager}
              installedEditors={editorState.installedEditors}
              isRemoteWorkspaceFileTree={editorState.isRemoteWorkspaceFileTree}
              remoteTarget={editorState.remoteTarget}
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              // 静态布局固定空样式，避免动态定位。
              style={{}}
              onSelect={onSelect}
              onToggleDirectory={handleToggle}
              onOpenPreview={onOpenPreview}
              onOpenBrowserUrl={onOpenBrowserUrl}
              onKeyDown={onKeyDown}
            />
          );
        })}
      </div>
    </div>
  );
}
