//
// 文件职责：Workspace 文件树面板，集中编排数据加载、虚拟列表、吸顶目录、搜索与入口操作。
// 职责边界：不拥有文件数据，也不直接读磁盘；数据来自 useWorkspaceFileTreeData 与搜索索引，
// 平台能力一律经 usePlatform / IPlatformService，组件只做组合与交互状态。
//
// 不变量（INV）：
// INV-01 断言：workspace 切换必须重置选中项、搜索词与 changedOnly。
//        位置：第一个 workspaceIdentity/workspacePath effect；故障：新 workspace 继承旧搜索，列表为空。
// INV-02 断言：git 状态不可用时强制关闭 changedOnly。
//        位置：第二个 useEffect 的 gitStatusAvailable 判断；故障：筛选开关保持开启但永远无结果。
// INV-03 断言：只有根目录未加载时错误才阻塞整棵树。
//        位置：getWorkspaceFileTreeBlockingRootError；故障：刷新失败把已缓存的旧树隐藏掉。
// INV-04 断言：非阻塞错误按消息去重，只提示一次。
//        位置：lastNonBlockingRootErrorRef；故障：每次重渲染都弹同一 toast。
// INV-05 断言：visibleRows 在搜索态只取 searchRows，在树态走 filterWorkspaceFileTreeRows。
//        位置：visibleRows 的 useMemo 分支；故障：搜索时混入旧树行或筛选失效。
// INV-06 断言：虚拟列表 count 必须等于 visibleRows.length。
//        位置：useVirtualizer 的 count；故障：滚动高度与行数不一致，出现空白或越界。
// INV-07 断言：底部渐隐只在有溢出且不在底部时出现。
//        位置：updateScrollMask 的 hasOverflow / isAtBottom；故障：到底后仍有遮罩或内容被裁切。
// INV-08 断言：滚动遮罩偏移通过原生 scroll 同步写 CSS 变量。
//        位置：updateScrollMask 的 setProperty；故障：拖滚动条时遮罩落后一帧。
// INV-09 断言：resize 重算必须 rAF 去抖并在清理时取消待执行帧。
//        位置：debouncedUpdate 与 cleanup；故障：卸载后仍调度回调。
// INV-10 断言：reveal 必须展开祖先目录并逐级加载，且受 disposed 守卫。
//        位置：reveal effect 的 directoryPathsToExpand / disposed；故障：卸载后继续加载，或子层未展开。
// INV-11 断言：待 reveal 路径只在对应行可见并滚动后清空。
//        位置：pendingActivePreviewRevealPathRef；故障：重复滚动或提前清空导致不再定位。
// INV-12 断言：搜索态点击目录必须先退出搜索，再逐级加载祖先。
//        位置：handleRevealSearchDirectory；故障：平铺结果无法回到树态，目标目录不展开。
// INV-13 断言：搜索态目录动作用 reveal，非搜索态用 toggle。
//        位置：handleDirectoryAction 的 hasFileSearchQuery 分支；故障：搜索点击只收起视觉节点。
// INV-14 断言：Git 标记为 deleted 的文件不得打开预览。
//        位置：handleOpenPreview 的 isWorkspaceFileTreeDeletedFile；故障：打开不存在的文件报错。
// INV-15 断言：键盘 Enter 打开预览，ArrowRight 展开，ArrowLeft 收起。
//        位置：handleRowKeyDown；故障：目录无法用键盘操作，或 Enter 误触发展开。
// INV-16 断言：远程树缺少 remoteTarget 时可用编辑器为空。
//        位置：availableEditors 的 isRemoteWorkspaceFileTree && !remoteTarget 分支；故障：远程环境列出本地编辑器。
// INV-17 断言：打开文件管理器失败必须 toast 并记录 warn 日志。
//        位置：handleOpenInFileManager 的 !result.success；故障：静默失败，用户重复点击。
// INV-18 断言：剪贴板不可用只记 warn，不弹错误。
//        位置：handleCopyPath 的 clipboard 能力判断；故障：无权限环境弹出误导性错误。
// INV-19 断言：根错误 / 加载 / 已加载三态派生只读，不在渲染期写状态。
//        位置：rootLoading / rootLoaded / blockingRootError；故障：渲染循环或状态抖动。
// INV-20 断言：组件不直接调用 window.zcode，平台差异全部走 platform。
//        位置：usePlatform 注入与所有 platform 调用；故障：Web 端运行时报未定义。
//
import { SidebarNativeTooltip, ControlHintTooltip } from "@/ControlHintTooltip.js";
/* eslint-disable max-lines -- WorkspaceFileTree 需要集中编排数据、虚拟列表、吸顶和入口操作状态。 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  ArrowLeft,
  Copy,
  Ellipsis,
  FolderOpen,
  GitCommitVertical,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  TID_WORKSPACE_FILE_TREE_PANEL,
  TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON,
} from "@zcode/shared/test-ids";
import {
  areWorkspaceFilePathsEqual,
  createCodeViewerSourceForWorkspaceFile,
  getWorkspaceFileGitStatus,
  getWorkspaceFileAncestorDirectories,
  getWorkspaceFileDirectoryChildDepth,
  filterWorkspaceFileTreeRows,
  isWorkspaceFileTreeDeletedFile,
  isWorkspaceFilePathInside,
  type WorkspaceFileGitStatus,
  type WorkspaceFileTreeRow,
} from "@/workspace-file-tree/model.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import { WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX } from "@/workspace-file-tree/constants.js";
import { getFileManagerLabel } from "@/workspace-file-tree/helpers.js";
import { useInstalledFileTreeEditors } from "@/workspace-file-tree/useInstalledFileTreeEditors.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import {
  resolveWorkspaceEditorSelection,
  resolveWorkspaceFileManagerEditor,
} from "@/lib/workspaceEditorSelection.js";
import { useWorkspaceFileTreeData } from "@/workspace-file-tree/useWorkspaceFileTreeData.js";
import { useWorkspaceFileTreeStickyFolders } from "@/workspace-file-tree/useWorkspaceFileTreeStickyFolders.js";
import {
  useWorkspaceFileSearchIndex,
  useWorkspaceFileSearchResults,
} from "@/workspace-file-tree/useWorkspaceFileSearchIndex.js";
import {
  WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY,
  WorkspaceFileTreeList,
} from "@/workspace-file-tree/WorkspaceFileTreeList.js";
import { WorkspaceFileTreeStickyFolders } from "@/workspace-file-tree/WorkspaceFileTreeStickyFolders.js";
import {
  createWorkspaceFileTreeRowsFromSearchEntries,
  getWorkspaceFileSearchDirectoryRevealPaths,
} from "@/workspace-file-tree/searchRows.js";
import type {
  WorkspaceFileTreeProps,
  WorkspaceFileTreeStickyFolderItem,
} from "@/workspace-file-tree/types.js";

// [契约] 目录加载深度统一委托给 model 的物理深度计算；
// compact 后的视觉深度不能用于加载，否则子节点会与父目录同级。
// [失败路径] 在组件内自行数路径段会与 compact offset 规则分叉。
// [权衡] 该包装函数对外暴露，便于测试直接断言深度。
export function getWorkspaceFileTreeDirectoryLoadDepth(
  workspacePath: string,
  directoryPath: string,
): number {
  return getWorkspaceFileDirectoryChildDepth(workspacePath, directoryPath);
}

// [契约] props 全部来自容器，组件不提供默认数据源；
// temporaryExternalDirectory 会关闭 workspace 特性，切换为只读浏览。
// [失败路径] 在组件内重新解析 workspace 身份会与容器口径不一致。
// [权衡] 入口操作（关闭、预览、浏览器）全部上抛，保持无路由依赖。
export function WorkspaceFileTree({
  workspacePath,
  workspaceName,
  workspaceIdentity,
  workspaceRemoteSessionId,
  revealPath,
  temporaryExternalDirectory = false,
  canOpenLocalFileManager = false,
  activePreviewPath,
  onClose,
  onOpenBrowserUrl,
  onOpenPreview,
}: WorkspaceFileTreeProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pendingActivePreviewRevealPathRef = useRef<string | null>(null);
  const pendingSearchDirectoryRevealPathRef = useRef<string | null>(null);
  // [契约] 选中项是 UI 局部状态，不代表文件系统事实；
  // workspace 切换时由 effect 重置为 null。
  // [失败路径] 把它提升到全局 store 会让多个面板互相抢选中。
  // [权衡] 选中只影响样式与键盘焦点，不触发 IO。
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // [契约] 搜索词是受控输入，空串表示树态；trim 后为空也按树态处理；
  // workspace 切换与目录 reveal 都会清空它。
  // [失败路径] 用非受控输入会让 reveal 后无法程序化退出搜索。
  // [权衡] 每次输入都触发过滤，数据量由索引层限制。
  const [fileSearchQuery, setFileSearchQuery] = useState("");
  // [契约] 仅显示变更文件是可选筛选，依赖 git 状态可用；
  // git 状态不可用时由 effect 强制关闭。
  // [失败路径] 允许在无 git 状态时开启会得到永远空列表。
  // [权衡] 该状态不持久化，切换 workspace 后恢复默认。
  const [showChangedOnly, setShowChangedOnly] = useState(false);
  // [契约] showScrollBottomMask 由 scrollTop / clientHeight 派生，不看业务数据；
  // 更新发生在原生 scroll/resize 回调中，避免重渲染延迟。
  // [失败路径] 在 render 里读取 scrollTop 会得到过期值。
  // [权衡] 只有布尔状态，具体渐变样式由 memo 生成。
  const [showScrollBottomMask, setShowScrollBottomMask] = useState(false);
  const [hasScrollableFileTree, setHasScrollableFileTree] = useState(false);
  // [契约] 列表 ref 回调同时负责写入初始遮罩偏移；
  // node 为 null（卸载）时只清引用，不访问 style。
  // [资源] 偏移用 CSS 变量表达，避免每帧 React 状态更新。
  // [失败路径] 在渲染期直接操作 DOM 会绕过 ref 生命周期。
  const handleListRef = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node;
    if (node) {
      node.style.setProperty(
        WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY,
        `${scrollRef.current?.scrollTop ?? 0}px`,
      );
    }
  }, []);
  // [契约] 数据 hook 接收路径、身份与远端会话，三者共同决定数据源；
  // enableWorkspaceFeatures 在临时外部目录下关闭，避免写操作。
  // [失败路径] 少传 identity 会让远程与本地同名目录共用缓存。
  // [权衡] 目录懒加载与刷新策略由 hook 内部统一，组件不干预。
  const treeData = useWorkspaceFileTreeData({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    enableWorkspaceFeatures: !temporaryExternalDirectory,
  });
  const { installedEditors } = useInstalledFileTreeEditors();
  // [契约] 只要存在远端会话或身份就视为远程树，即使当前连接断开；
  // 该判定决定编辑器列表与本地文件管理器入口是否可用。
  // [失败路径] 只看 remoteSessionId 会漏掉已断连但仍有身份的树。
  // [权衡] 身份存在即远程，避免断连时误开本地路径。
  const isRemoteWorkspaceFileTree = Boolean(workspaceRemoteSessionId || workspaceIdentity);
  const { remoteTarget } = useWorkspaceOpenInEditorTarget({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  });
  // [契约] 远程树且没有 remoteTarget 时直接返回空编辑器列表；
  // 否则按共享选择器解析已安装编辑器。
  // [失败路径] 远程环境回落到本地编辑器会打开错误机器上的路径。
  // [权衡] 依赖 remoteTarget 引用，hook 需保证其稳定。
  const availableEditors = useMemo(
    () =>
      isRemoteWorkspaceFileTree && !remoteTarget
        ? []
        : resolveWorkspaceEditorSelection({
            installedEditors,
            selectedEditorId: null,
            remoteTarget,
          }).availableEditors,
    [installedEditors, isRemoteWorkspaceFileTree, remoteTarget],
  );
  const wslFileManagerEditor = resolveWorkspaceFileManagerEditor(availableEditors, remoteTarget);
  // [契约] 可用条件：存在 WSL/远程文件管理器编辑器，或允许本地打开且非远程树；
  // canOpenInFileManager 取 wslFileManagerEditor 或本地可用且非远程树。
  // [失败路径] 远程树误用本地文件管理器会打开无意义路径。
  // [权衡] 该值同时控制菜单项 disabled 与 handler 早退。
  const canOpenInFileManager =
    Boolean(wslFileManagerEditor) || (canOpenLocalFileManager && !isRemoteWorkspaceFileTree);
  // [契约] 搜索态以 trim 后是否为空判定，纯空白等同树态；
  // 该布尔贯穿过滤、reveal 与空态文案。
  // [失败路径] 用 length > 0 会把一个空格当成有效搜索，索引被无谓启用。
  // [权衡] 多处复用同一派生值，避免各自 trim 产生分歧。
  const hasFileSearchQuery = fileSearchQuery.trim().length > 0;
  // [契约] 搜索索引只在有搜索词时启用，避免常驻扫描；
  // enabled 由 hasFileSearchQuery 驱动，关闭时不得保留旧结果。
  // [资源] 索引的加载与刷新由 hook 管理，组件只消费。
  // [失败路径] 无条件启用会在大型仓库上产生持续 IO。
  const searchIndex = useWorkspaceFileSearchIndex({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    enabled: hasFileSearchQuery,
  });
  const {
    entries: searchIndexEntries,
    error: searchIndexError,
    loaded: searchIndexLoaded,
    loading: searchIndexLoading,
    refresh: refreshSearchIndex,
  } = searchIndex;
  // [契约] 结果过滤是纯计算，输入为索引条目与查询词；
  // workspacePath 参与相对路径展示，不参与匹配规则。
  // [失败路径] 在组件内再做一次匹配会与索引层规则不一致。
  // [权衡] useWorkspaceFileSearchResults 每次输入重算，成本随 entries 线性增长。
  const searchEntries = useWorkspaceFileSearchResults({
    entries: searchIndexEntries,
    query: fileSearchQuery,
    workspacePath,
  });
  // [契约] 搜索条目到树行的转换是纯函数，只依赖 searchEntries；
  // 转换后的行必须与树态行共享同一 WorkspaceFileTreeRow 形状。
  // [失败路径] 在搜索行上补树态专属字段会让渲染分支判断失效。
  // [权衡] 转换与过滤分离，便于测试单独断言。
  const searchRows = useMemo(
    () => createWorkspaceFileTreeRowsFromSearchEntries(searchEntries),
    [searchEntries],
  );
  // [契约] 搜索态：可选按 git 状态过滤 searchRows；树态：走统一 filter；
  // 两个分支都必须返回同一类型，保证虚拟列表无差别消费。
  // [失败路径] 搜索态漏掉 changedOnly 会让筛选开关失效。
  // [权衡] 依赖数组包含全部输入，缺一项会产生陈旧列表。
  const visibleRows = useMemo(() => {
    if (hasFileSearchQuery) {
      return showChangedOnly
        ? searchRows.filter((row) => getWorkspaceFileGitStatus(treeData.gitStatusByPath, row.path))
        : searchRows;
    }
    return filterWorkspaceFileTreeRows({
      rows: treeData.rows,
      searchQuery: fileSearchQuery,
      changedOnly: showChangedOnly,
      statusByPath: treeData.gitStatusByPath,
    });
  }, [
    fileSearchQuery,
    hasFileSearchQuery,
    searchRows,
    showChangedOnly,
    treeData.gitStatusByPath,
    treeData.rows,
  ]);
  // [契约] 行高使用共享常量，overscan 固定 12 行用于平滑滚动；
  // 滚动容器由 ref 提供，首帧为 null 时虚拟器自行等待。
  // [失败路径] count 与 rows 不同步会渲染不存在的索引。
  // [权衡] 固定行高换取 O(1) 定位，行内容不得改变高度。
  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => WORKSPACE_FILE_TREE_VIRTUAL_ROW_HEIGHT_PX,
    overscan: 12,
  });

  // [契约] workspace 变化时重置全部视图状态，包含选中、搜索与筛选；
  // 只依赖 identity 与 path，不依赖派生值。
  // [失败路径] 依赖 rows 会在每次加载时清空用户选中。
  // [权衡] 该 effect 必须早于 reveal effect 执行，顺序由声明位置保证。
  useEffect(() => {
    setSelectedPath(null);
    setFileSearchQuery("");
    setShowChangedOnly(false);
  }, [workspaceIdentity, workspacePath]);

  // [契约] git 状态一旦不可用，立即关闭 changedOnly；
  // 反向不成立：状态恢复后不自动重新开启，尊重用户上次显式操作。
  // [失败路径] 自动恢复会让筛选在后台静默变化。
  // [权衡] effect 依赖 gitStatusAvailable，只在翻转时触发。
  useEffect(() => {
    if (!treeData.gitStatusAvailable) {
      setShowChangedOnly(false);
    }
  }, [treeData.gitStatusAvailable]);

  // [契约] 根加载态直接读取数据 hook 的路径集合，不在组件内另建标志；
  // 该值与 rootLoaded 可能同时为 true（后台刷新）。
  // [失败路径] 在组件内维护 loading 会与真实请求脱节。
  // [权衡] 集合查询是 O(1)，可在渲染期安全调用。
  const rootLoading = treeData.loadingDirectoryPaths.has(workspacePath);
  const rootLoaded = treeData.loadedDirectoryPaths.has(workspacePath);
  const rootError = treeData.errorByDirectory.get(workspacePath) ?? null;
  // [契约] 仅当根未加载时才把错误升级为阻塞错误；
  // 已加载时错误交给 toast 处理，旧树保持可见。
  // [失败路径] 无条件阻塞会让一次刷新失败清空整棵树。
  // [权衡] 阻塞判定抽成纯函数，便于单测覆盖。
  const blockingRootError = getWorkspaceFileTreeBlockingRootError({
    rootLoaded,
    rootError,
  });
  // [契约] 初始骨架只在「未加载且无阻塞错误」时显示；
  // 有错误时优先展示错误页，避免骨架与错误同时出现。
  // [失败路径] 只看 rootLoaded 会让错误页永远被骨架遮住。
  // [权衡] 搜索态另有 loading 组合，见 WorkspaceFileTreeList props。
  const showInitialLoading = !rootLoaded && !blockingRootError;
  const lastNonBlockingRootErrorRef = useRef<string | null>(null);
  // [契约] 根目录已有缓存时，刷新失败只提示，不进入阻塞错误页；
  // 提示按错误消息去重，成功或清空后重置记录。
  // [失败路径] 不去重会在每次重渲染时重复 toast。
  // [权衡] 静默失败会让用户以为刷新成功，因此保留一次性提示。
  useEffect(() => {
    if (!rootLoaded || !rootError) {
      lastNonBlockingRootErrorRef.current = null;
      return;
    }
    const errorMessage = rootError.message;
    if (lastNonBlockingRootErrorRef.current === errorMessage) {
      return;
    }
    lastNonBlockingRootErrorRef.current = errorMessage;
    // Bugfix: 根目录已有缓存时，刷新失败只能作为非阻塞提示；阻塞错误页会把保留的旧文件树隐藏掉。
    toast(`${intl.formatMessage({ id: "workspaceFileTree.readFailed" })}: ${errorMessage}`);
  }, [intl, rootError, rootLoaded]);
  // [契约] 状态到文案的映射必须覆盖全部 WorkspaceFileGitStatus 键；
  // 文案全部来自 intl，依赖语言变化重建。
  // [失败路径] 缺键会让未知状态显示 undefined。
  // [权衡] 用 Record 强制穷举，新增状态时编译期报错。
  const gitStatusLabelByStatus = useMemo<Record<WorkspaceFileGitStatus, string>>(
    () => ({
      added: intl.formatMessage({ id: "git.kind.added" }),
      deleted: intl.formatMessage({ id: "git.kind.deleted" }),
      ignored: intl.formatMessage({
        id: "workspaceFileTree.gitStatus.ignored",
      }),
      modified: intl.formatMessage({ id: "git.kind.modified" }),
      renamed: intl.formatMessage({ id: "git.kind.renamed" }),
      untracked: intl.formatMessage({ id: "git.section.untracked" }),
    }),
    [intl],
  );
  const fileManagerLabel = getFileManagerLabel(intl);
  // [契约] 右键菜单文案集中在此生成，子组件只消费字符串；
  // fileManagerLabel 由共享 helper 提供，不同平台文案不同。
  // [失败路径] 在子组件内联 formatMessage 会让菜单与面板语言不一致。
  // [权衡] 依赖 fileManagerLabel 与 intl，二者变化时整体重建。
  const fileContextMenuLabels = useMemo(
    () => ({
      addToChat: intl.formatMessage({ id: "workspaceFileTree.addToChat" }),
      copyAbsolutePath: intl.formatMessage({
        id: "fileActions.copyAbsolutePath",
      }),
      copyRelativePath: intl.formatMessage({
        id: "fileActions.copyRelativePath",
      }),
      open: intl.formatMessage({ id: "common.open" }),
      openInBrowser: intl.formatMessage({
        id: "workspaceFileTree.openInBrowser",
      }),
      openFailed: intl.formatMessage({ id: "workspaceFileTree.openFailed" }),
      openWith: intl.formatMessage({ id: "workspaceFileTree.openWith" }),
      reveal: fileManagerLabel,
    }),
    [fileManagerLabel, intl],
  );

  // [契约] 无遮罩时返回 undefined，避免写入空样式覆盖默认；
  // 有遮罩时同时设置 Webkit 前缀与标准属性，兼容不同内核。
  // [失败路径] 返回空对象会让滚动容器样式抖动。
  // [权衡] 渐变高度固定 32px，与行高解耦。
  const scrollMaskStyle = useMemo<CSSProperties | undefined>(() => {
    if (!showScrollBottomMask) {
      return undefined;
    }
    return {
      WebkitMaskImage:
        "linear-gradient(to bottom, black 0px, black calc(100% - 32px), transparent 100%)",
      maskImage: "linear-gradient(to bottom, black 0px, black calc(100% - 32px), transparent 100%)",
      WebkitMaskRepeat: "no-repeat",
      maskRepeat: "no-repeat",
      WebkitMaskSize: "100% 100%",
      maskSize: "100% 100%",
    };
  }, [showScrollBottomMask]);
  // [契约] 在遮罩样式上追加 overflowAnchor: none；
  // overflowAnchor: "none" 关闭锚定，防止插入行时视口跳动。
  // [失败路径] 保持锚定会在顶部加载更多时把视口拉走。
  // [权衡] 依赖整个 scrollMaskStyle，后者重建时同步重建。
  const scrollContainerStyle = useMemo<CSSProperties>(
    () => ({ ...scrollMaskStyle, overflowAnchor: "none" }),
    [scrollMaskStyle],
  );

  // [资源] reveal effect 展开祖先并逐级 await 加载，卸载时置 disposed；
  // pending 路径在滚动定位完成后才清空，避免中途重入。
  // [失败路径] 串行加载顺序颠倒会让父目录尚未加载就请求子目录。
  // [权衡] 逐级加载比并行稍慢，但保证 expand 状态与数据一致。
  useEffect(() => {
    // [契约] 显式 revealPath 优先于 activePreviewPath，二者都 trim；
    // 路径必须位于当前 workspace 内才处理。
    // [失败路径] 不校验包含关系会把外部路径加入展开集合。
    // [权衡] 显式 reveal 同时展开文件本身，active 预览只展开祖先。
    const previewPath = revealPath?.trim() || activePreviewPath?.trim();
    if (!previewPath || !isWorkspaceFilePathInside(workspacePath, previewPath)) {
      return;
    }
    let disposed = false;
    const ancestorDirectories = getWorkspaceFileAncestorDirectories(workspacePath, previewPath);
    const directoryPathsToExpand = revealPath?.trim()
      ? [...ancestorDirectories, previewPath]
      : ancestorDirectories;
    pendingActivePreviewRevealPathRef.current = previewPath;
    setSelectedPath(previewPath);
    treeData.setExpandedPaths((current) => {
      const next = new Set(current);
      for (const directoryPath of directoryPathsToExpand) {
        next.add(directoryPath);
      }
      return next;
    });
    void (async () => {
      for (const [index, directoryPath] of directoryPathsToExpand.entries()) {
        if (disposed) {
          return;
        }
        await treeData.loadDirectory(directoryPath, index + 1);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [
    activePreviewPath,
    revealPath,
    treeData.loadDirectory,
    treeData.setExpandedPaths,
    workspacePath,
  ]);

  useEffect(() => {
    const previewPath = revealPath?.trim() || activePreviewPath?.trim();
    if (!previewPath || visibleRows.length === 0) {
      return;
    }
    if (
      !isWorkspaceFilePathInside(workspacePath, previewPath) ||
      !pendingActivePreviewRevealPathRef.current ||
      !areWorkspaceFilePathsEqual(pendingActivePreviewRevealPathRef.current, previewPath)
    ) {
      return;
    }
    const activeRowIndex = visibleRows.findIndex((row) =>
      areWorkspaceFilePathsEqual(row.path, previewPath),
    );
    if (activeRowIndex >= 0) {
      rowVirtualizer.scrollToIndex(activeRowIndex, { align: "auto" });
      pendingActivePreviewRevealPathRef.current = null;
    }
  }, [activePreviewPath, revealPath, rowVirtualizer, visibleRows, workspacePath]);

  useEffect(() => {
    const revealDirectoryPath = pendingSearchDirectoryRevealPathRef.current;
    if (!revealDirectoryPath || visibleRows.length === 0 || hasFileSearchQuery) {
      return;
    }
    const revealRowIndex = visibleRows.findIndex((row) =>
      areWorkspaceFilePathsEqual(row.path, revealDirectoryPath),
    );
    if (revealRowIndex >= 0) {
      rowVirtualizer.scrollToIndex(revealRowIndex, { align: "center" });
      pendingSearchDirectoryRevealPathRef.current = null;
    }
  }, [hasFileSearchQuery, rowVirtualizer, visibleRows]);

  useEffect(() => {
    const scrollNode = scrollRef.current;
    if (!scrollNode) {
      return;
    }
    const contentNode = scrollNode.firstElementChild;
    const updateScrollMask = () => {
      // virtualizer 的 scrollOffset 需要经过 React 重渲染，拖拽滚动条时
      // mask 会落后一帧。原生 scroll 回调直接更新 CSS 变量，与浏览器滚动同步绘制。
      listRef.current?.style.setProperty(
        WORKSPACE_FILE_TREE_MASK_OFFSET_PROPERTY,
        `${scrollNode.scrollTop}px`,
      );
      const hasOverflow = scrollNode.scrollHeight > scrollNode.clientHeight + 1;
      const isAtBottom =
        scrollNode.scrollTop + scrollNode.clientHeight >= scrollNode.scrollHeight - 1;
      setHasScrollableFileTree(hasOverflow);
      setShowScrollBottomMask(hasOverflow && !isAtBottom);
    };

    // RAF-based debounce to coalesce resize events
    let rafId: number | null = null;
    let latestCallback = updateScrollMask;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestCallback();
      });
    };

    updateScrollMask();
    const resizeObserver = new ResizeObserver(() => {
      latestCallback = updateScrollMask;
      debouncedUpdate();
    });
    resizeObserver.observe(scrollNode);
    if (contentNode instanceof HTMLElement) {
      resizeObserver.observe(contentNode);
    }
    scrollNode.addEventListener("scroll", updateScrollMask, { passive: true });
    window.addEventListener("resize", debouncedUpdate);
    return () => {
      resizeObserver.disconnect();
      scrollNode.removeEventListener("scroll", updateScrollMask);
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [rootError, rootLoaded, rootLoading, visibleRows.length]);

  // [契约] handleRefresh 同时调 refreshLoadedDirectories 与 refreshSearchIndex；
  // 搜索态必须调 refreshSearchIndex，否则结果仍是旧快照。
  // [失败路径] 只刷目录会让已删除文件继续出现在搜索结果。
  // [权衡] 两个刷新都返回 Promise，这里不 await，保持点击即时响应。
  const handleRefresh = useCallback(() => {
    void treeData.refreshLoadedDirectories();
    if (hasFileSearchQuery) {
      refreshSearchIndex();
    }
  }, [hasFileSearchQuery, refreshSearchIndex, treeData]);
  // [契约] 旋转动画合并三个来源：根加载、目录刷新、索引加载；
  // 按钮 disabled 只绑定目录刷新，避免索引加载时无法手动刷新。
  // [失败路径] 用同一个布尔控制 disabled 会让搜索期间按钮长时间不可用。
  // [权衡] refreshInProgress 控制动画，disabled 只看目录刷新。
  const refreshInProgress =
    rootLoading || treeData.refreshingLoadedDirectories || searchIndexLoading;

  // [契约] 有 WSL/远程编辑器时走 openInEditor，否则走本地文件管理器；
  // 前者必须带 pathKind: directory 与 remoteTarget。
  // [失败路径] 远程目标缺少 remoteTarget 会打开本地同名路径。
  // [权衡] 失败统一 toast 并记录 warn，不区分具体错误码。
  const handleOpenInFileManager = useCallback(async () => {
    if (!canOpenInFileManager) {
      return;
    }
    // [契约] 二选一分支必须返回同形的 { success, error }；
    // openInEditor 与本地打开都返回 { success, error }，调用方不区分来源。
    // [失败路径] 两条分支返回形状不同会让失败判断失效。
    // [权衡] 使用三元而非 if/else，保持单一赋值点。
    const result = wslFileManagerEditor
      ? await platform.openInEditor(wslFileManagerEditor.id, workspacePath, {
          pathKind: "directory",
          remoteTarget,
          workspaceIdentity,
        })
      : await platform.openInFileManager(workspacePath);
    if (!result.success) {
      logger.warn("[WorkspaceFileTree] 打开 workspace 路径失败", {
        path: workspacePath,
        error: result.error ?? "unknown-error",
      });
      toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
    }
  }, [
    canOpenInFileManager,
    intl,
    platform,
    remoteTarget,
    workspaceIdentity,
    workspacePath,
    wslFileManagerEditor,
  ]);

  // [契约] 复制前先探测 navigator.clipboard.writeText 是否存在；
  // 成功记 info，失败记 warn，均不抛给 UI。
  // [失败路径] 直接 await 会在无权限环境抛出未捕获异常。
  // [权衡] 不弹 toast，避免复制这种轻操作打断用户。
  const handleCopyPath = useCallback(async () => {
    // [失败路径] 非浏览器环境或旧内核直接返回，只记录 clipboard-unavailable；
    // 不能回落到 execCommand，后者已废弃且行为不一致。
    // [契约] 该判断必须先于任何 DOM 访问。
    // [权衡] 静默失败换取跨环境稳定。
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      logger.warn("[WorkspaceFileTree] 复制 workspace 路径失败", {
        path: workspacePath,
        error: "clipboard-unavailable",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(workspacePath);
      logger.info("[WorkspaceFileTree] workspace 路径已复制", {
        path: workspacePath,
      });
    } catch (error) {
      logger.warn("[WorkspaceFileTree] 复制 workspace 路径失败", {
        path: workspacePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [workspacePath]);

  // [契约] 只有 directory 行可切换；文件行直接忽略；
  // 展开时把 compactedPaths 一并加入，收起时全部删除。
  // [失败路径] 只处理 row.path 会让压缩目录展开后仍显示为折叠。
  // [权衡] 状态更新使用函数式 set，避免并发点击丢更新。
  const handleToggleDirectory = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (row.type !== "directory") {
        return;
      }
      treeData.setExpandedPaths((current) => {
        const next = new Set(current);
        if (next.has(row.path)) {
          for (const path of row.compactedPaths ?? [row.path]) {
            next.delete(path);
          }
          return next;
        }
        next.add(row.path);
        return next;
      });
      if (!row.expanded) {
        // compact folders 的 row.depth 是压缩后的视觉深度，不能用于写入新加载节点。
        // 使用物理路径深度后，flatten 阶段再扣除 compact offset，子内容才不会与父目录同级。
        void treeData.loadDirectory(
          row.path,
          getWorkspaceFileTreeDirectoryLoadDepth(workspacePath, row.path),
        );
      }
    },
    [treeData, workspacePath],
  );
  // [契约] 搜索态点击目录：记录 pending、选中、展开祖先、清空搜索、逐级加载；
  // 顺序不可调换，必须先退出搜索再加载，目标行才会出现在树中。
  // [失败路径] 先加载后清搜索会让平铺结果与树态同时存在。
  // [权衡] 加载循环不 await 全部完成，UI 可先展示祖先。
  const handleRevealSearchDirectory = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (row.type !== "directory") {
        return;
      }
      const directoryPathsToExpand = getWorkspaceFileSearchDirectoryRevealPaths({
        workspacePath,
        directoryPath: row.path,
      });
      if (directoryPathsToExpand.length === 0) {
        return;
      }
      pendingSearchDirectoryRevealPathRef.current = row.path;
      setSelectedPath(row.path);
      treeData.setExpandedPaths((current) => {
        const next = new Set(current);
        for (const directoryPath of directoryPathsToExpand) {
          next.add(directoryPath);
        }
        return next;
      });
      // 搜索结果是 listWorkspaceFiles 的平铺索引，不受 expandedPaths 驱动。
      // 目录点击必须先回到树态，再逐级加载祖先目录，目标目录才会在懒加载树中可见并保持展开。
      setFileSearchQuery("");
      void (async () => {
        for (const directoryPath of directoryPathsToExpand) {
          await treeData.loadDirectory(
            directoryPath,
            getWorkspaceFileTreeDirectoryLoadDepth(workspacePath, directoryPath),
          );
        }
      })();
    },
    [treeData, workspacePath],
  );
  // [契约] 目录动作按搜索态分流：搜索态 reveal，树态 toggle；
  // 该函数是列表与吸顶组件共用的唯一目录入口。
  // [失败路径] 在搜索态调用 toggle 只会改一个不可见的展开集合。
  // [权衡] 分流在 handleDirectoryAction 内，子组件无需感知 hasFileSearchQuery。
  const handleDirectoryAction = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (hasFileSearchQuery) {
        handleRevealSearchDirectory(row);
        return;
      }
      handleToggleDirectory(row);
    },
    [handleRevealSearchDirectory, handleToggleDirectory, hasFileSearchQuery],
  );
  // [契约] 目录行转交目录动作，文件行才触发预览；
  // deleted 文件即使被外部入口调用也必须拦截。
  // [失败路径] 放行 deleted 文件会让预览器读取不存在的路径。
  // [权衡] 拦截放在父级而不是行组件，保证所有入口一致。
  const handleOpenPreview = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (row.type === "directory") {
        handleDirectoryAction(row);
        return;
      }
      if (
        isWorkspaceFileTreeDeletedFile(
          row,
          getWorkspaceFileGitStatus(treeData.gitStatusByPath, row.path),
        )
      ) {
        // 修复：deleted 文件行来自 Git 状态补全，不对应现存文件。
        // 即使未来有其它入口直接调用预览，也要在父级兜底阻止打开。
        return;
      }
      onOpenPreview?.(createCodeViewerSourceForWorkspaceFile(row.path));
    },
    [handleDirectoryAction, onOpenPreview, treeData.gitStatusByPath],
  );
  // [契约] Enter 打开预览；ArrowRight 仅在目录且未展开或搜索态时展开；
  // ArrowLeft 仅在目录且已展开时收起。
  // [失败路径] ArrowRight 无条件 toggle 会把已展开目录收起。
  // [权衡] 所有分支都 preventDefault，避免页面滚动。
  const handleRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>, row: WorkspaceFileTreeRow) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleOpenPreview(row);
        return;
      }
      if (event.key === "ArrowRight" && row.type === "directory") {
        event.preventDefault();
        if (!row.expanded || hasFileSearchQuery) {
          handleDirectoryAction(row);
        }
        return;
      }
      if (event.key === "ArrowLeft" && row.type === "directory" && row.expanded) {
        event.preventDefault();
        handleToggleDirectory(row);
      }
    },
    [handleDirectoryAction, handleOpenPreview, handleToggleDirectory, hasFileSearchQuery],
  );

  // [契约] 任一筛选生效即视为「有过滤」，用于空态文案选择；
  // 与 hasFileSearchQuery 不同，它包含 changedOnly。
  // [失败路径] 只用搜索词判断会在仅筛选变更时显示「目录为空」。
  // [权衡] 该值只影响文案，不影响数据分支。
  const hasActiveFileTreeFilter = fileSearchQuery.trim().length > 0 || showChangedOnly;
  // [契约] 虚拟项每次渲染重新读取，不能缓存到 state；
  // 滚动时虚拟器内部触发渲染，读取最新窗口。
  // [失败路径] 把结果存入 state 会造成滚动不同步。
  // [权衡] 读取是 O(window)，开销可忽略。
  const virtualItems = rowVirtualizer.getVirtualItems();
  const scrollOffset = rowVirtualizer.scrollOffset ?? 0;
  // [契约] 吸顶目录只在树态且可滚动时启用，搜索态关闭；
  // 输入包含虚拟项、滚动方向与偏移，输出按当前窗口计算。
  // [失败路径] 搜索态启用吸顶会把平铺结果误当成层级目录。
  // [权衡] 计算在渲染期完成，依赖虚拟器状态。
  const stickyFolderItems = useWorkspaceFileTreeStickyFolders({
    rows: visibleRows,
    virtualItems,
    scrollDirection: rowVirtualizer.scrollDirection,
    scrollOffset,
    enabled: hasScrollableFileTree && !hasFileSearchQuery,
  });
  // [契约] 点击吸顶目录只滚动到对应行，不展开也不选中；
  // align 固定 start，让目标目录出现在视口顶部。
  // [失败路径] 使用 center 会让目录上方的上下文不可见。
  // [权衡] 滚动由虚拟器负责，组件不直接操作 scrollTop。
  const handleRevealStickyFolderRow = useCallback(
    (item: WorkspaceFileTreeStickyFolderItem) =>
      rowVirtualizer.scrollToIndex(item.index, { align: "start" }),
    [rowVirtualizer],
  );
  // [契约] 标题优先级：显式 workspaceName、路径叶子、i18n 兜底；
  // 空串与纯空白都视为未提供。
  // [失败路径] 直接渲染 workspaceName 会让未命名 workspace 出现空白标题。
  // [权衡] 三层回退保证任何输入都有可读标题。
  const workspaceTitle =
    workspaceName?.trim() ||
    getPathLeaf(workspacePath) ||
    intl.formatMessage({ id: "workspaceFileTree.title" });
  // [契约] 编辑器状态对象一次性传给列表与吸顶组件，保证两处口径一致；
  // availableEditors 已在远程无目标时收敛为空。
  // [失败路径] 两处各自组装会让菜单项与右键行为不一致。
  // [权衡] 对象每次渲染重建，子组件按字段比较。
  const editorState = {
    canOpenLocalFileManager,
    installedEditors: availableEditors,
    isRemoteWorkspaceFileTree,
    remoteTarget,
  };

  return (
    <section
      className="flex h-full min-h-0 flex-col text-foreground"
      data-testid={TID_WORKSPACE_FILE_TREE_PANEL}
    >
      {onClose ? (
        <div className="px-2 pb-3 pt-3">
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className="w-full justify-start gap-2 rounded-xl px-2.5 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            onClick={onClose}
          >
            <ArrowLeft className="size-4 shrink-0" />
            <span className="min-w-0 truncate">
              {intl.formatMessage({ id: "workspaceFileTree.backToTasks" })}
            </span>
          </Button>
        </div>
      ) : (
        <div className="h-2 shrink-0" />
      )}
      <div className="flex shrink-0 items-center gap-1 px-2 pb-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtlest" />
          <Input
            type="text"
            size="default"
            value={fileSearchQuery}
            className="h-7 bg-transparent pl-7 pr-7 focus-visible:bg-input-focused"
            placeholder={intl.formatMessage({
              id: "workspaceFileTree.searchPlaceholder",
            })}
            aria-label={intl.formatMessage({
              id: "workspaceFileTree.searchLabel",
            })}
            onChange={(event) => setFileSearchQuery(event.currentTarget.value)}
          />
          {fileSearchQuery.length > 0 ? (
            <SidebarNativeTooltip>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="absolute right-1 top-1/2 -translate-y-1/2 text-foreground-subtlest hover:bg-surface-hover hover:text-foreground"
                aria-label={intl.formatMessage({
                  id: "workspaceFileTree.clearSearch",
                })}
                title={intl.formatMessage({
                  id: "workspaceFileTree.clearSearch",
                })}
                onClick={() => setFileSearchQuery("")}
              >
                <X className="size-3" />
              </Button>
            </SidebarNativeTooltip>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center px-2 pb-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <h3 className="min-w-0 truncate py-1 pr-0.5 pl-2.5 text-ui-base font-medium text-foreground-subtlest">
            {workspaceTitle}
          </h3>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarNativeTooltip>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                aria-label={intl.formatMessage({ id: "common.more" })}
                title={intl.formatMessage({ id: "common.more" })}
              >
                <Ellipsis className="size-3.5" />
              </Button>
            </SidebarNativeTooltip>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              disabled={!canOpenInFileManager}
              onSelect={() => void handleOpenInFileManager()}
            >
              <FolderOpen className="size-4" />
              {fileManagerLabel}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void handleCopyPath()}>
              <Copy className="size-4" />
              {intl.formatMessage({ id: "appHeader.copyPath" })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {treeData.gitStatusAvailable ? (
          <ControlHintTooltip
            title={intl.formatMessage({
              id: showChangedOnly
                ? "workspaceFileTree.showAllFiles"
                : "workspaceFileTree.showChangedFiles",
            })}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-pressed={showChangedOnly}
              aria-label={intl.formatMessage({
                id: showChangedOnly
                  ? "workspaceFileTree.showAllFiles"
                  : "workspaceFileTree.showChangedFiles",
              })}
              className={cn(
                "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                showChangedOnly && "bg-selected text-foreground",
              )}
              onClick={() => setShowChangedOnly((current) => !current)}
            >
              <GitCommitVertical className="size-3.5" />
            </Button>
          </ControlHintTooltip>
        ) : null}
        <ControlHintTooltip title={intl.formatMessage({ id: "workspaceFileTree.refresh" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid={TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON}
            className="text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            aria-label={intl.formatMessage({ id: "workspaceFileTree.refresh" })}
            disabled={treeData.refreshingLoadedDirectories}
            onClick={handleRefresh}
          >
            <RefreshCw className={cn("size-3.5", refreshInProgress && "animate-spin")} />
          </Button>
        </ControlHintTooltip>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          className="h-full min-h-0 overflow-auto px-1 px-2"
          style={scrollContainerStyle}
        >
          <WorkspaceFileTreeStickyFolders
            items={stickyFolderItems}
            selectedPath={selectedPath}
            gitStatusByPath={treeData.gitStatusByPath}
            ignoredPathSet={treeData.ignoredPathSet}
            gitStatusLabelByStatus={gitStatusLabelByStatus}
            contextMenuLabels={fileContextMenuLabels}
            editorState={editorState}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            onSelect={setSelectedPath}
            onToggleDirectory={handleToggleDirectory}
            onRevealRow={handleRevealStickyFolderRow}
            onOpenPreview={handleOpenPreview}
            onOpenBrowserUrl={onOpenBrowserUrl}
            onKeyDown={handleRowKeyDown}
          />
          <WorkspaceFileTreeList
            rootError={hasFileSearchQuery ? searchIndexError : blockingRootError}
            showInitialLoading={
              showInitialLoading || (hasFileSearchQuery && searchIndexLoading && !searchIndexLoaded)
            }
            rows={visibleRows}
            virtualItems={virtualItems}
            listRef={handleListRef}
            stickyFolderCount={stickyFolderItems.length}
            totalSize={rowVirtualizer.getTotalSize()}
            emptyTitle={intl.formatMessage({
              id: hasActiveFileTreeFilter
                ? "workspaceFileTree.noResults"
                : "workspaceFileTree.empty",
            })}
            workspaceTitle={workspaceTitle}
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            selectedPath={selectedPath}
            gitStatusByPath={treeData.gitStatusByPath}
            ignoredPathSet={treeData.ignoredPathSet}
            gitStatusLabelByStatus={gitStatusLabelByStatus}
            contextMenuLabels={fileContextMenuLabels}
            editorState={editorState}
            onSelect={setSelectedPath}
            onToggleDirectory={handleDirectoryAction}
            onOpenPreview={handleOpenPreview}
            onOpenBrowserUrl={onOpenBrowserUrl}
            onKeyDown={handleRowKeyDown}
          />
        </div>
      </div>
    </section>
  );
}

// [契约] 根已加载则永远返回 null，未加载才返回原错误；
// 该函数是纯函数，不读取任何外部状态。
// [失败路径] 改成只要有错误就返回会让刷新失败阻塞整棵树。
// [权衡] 抽出导出便于单测直接覆盖两种输入。
export function getWorkspaceFileTreeBlockingRootError({
  rootLoaded,
  rootError,
}: {
  rootLoaded: boolean;
  rootError: Error | null;
}) {
  return rootLoaded ? null : rootError;
}
