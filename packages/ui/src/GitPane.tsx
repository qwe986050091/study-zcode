// GitPane.tsx —— Git 变更面板：来源切换、虚拟滚动列表、diff 懒加载与查找联动。
//
// 职责边界
//   做什么：渲染当前来源下的文件变更列表，按需拉取单个文件 diff，承载展开态与查找命中跳转。
//   不做什么：不计算 Git 摘要、不写持久化、不决定来源可用性，这些由 useGitRepository 与上游提供。
//   依赖谁：gitService 的 getDiff、useFileContextActions 的上下文动作、虚拟滚动与 GitPaneChangeCard。
//   被谁调用：侧边栏 Git 面板的容器组件，由它传入 gitState 与查找参数。
//   边界：面板只维护展示态（展开路径、diff 缓存、虚拟行），不改动仓库状态。
//
//
// INV-01 展开路径必须唯一：同一时刻只允许一个文件展开 —— 守住它的位置：expandedPath 状态 —— 改错故障：多个 diff 同时挂载，滚动高度与查找索引错乱
// INV-02 diff 缓存键必须包含来源 id 与路径：缺来源会串味 —— 守住它的位置：getDiffCacheKey 的全部调用点 —— 改错故障：切换来源后看到上一来源的 diff 内容
// INV-03 世代号必须在发起请求时快照：回调里比较的是快照 —— 守住它的位置：generation 常量与两处早退 —— 改错故障：旧工作区的响应覆盖新工作区的缓存
// INV-04 pending 标记必须在 finally 清除：不能只写在成功路径 —— 守住它的位置：请求链末尾的 finally —— 改错故障：失败一次后该文件永远不会再重试
// INV-05 已有 diff 或 pending 时必须早退：懒加载入口要保持幂等 —— 守住它的位置：loadDiffForChange 的前两个判断 —— 改错故障：反复展开同一文件发出重复请求
// INV-06 各 hook 的依赖数组不能删项：漏依赖会让闭包读到旧值 —— 守住它的位置：全部 useEffect 与 useCallback 的依赖 —— 改错故障：切换来源后仍按旧来源加载 diff
// INV-07 虚拟行定位必须用 top 偏移而不是 transform —— 守住它的位置：行内 style —— 改错故障：展开大 diff 后 sticky 文件名失效，标题不再置顶
// INV-08 虚拟行 key 必须带来源 id：不能只用路径 —— 守住它的位置：getItemKey —— 改错故障：来源切换后复用旧行状态，展开态落在错误文件上
// INV-09 展开项失效必须清空：列表里没有该路径时置 null —— 守住它的位置：currentChanges 校验 effect —— 改错故障：刷新后残留一条没有内容的展开行
// INV-10 查找预加载只在查询非空时执行 —— 守住它的位置：normalizedFileChangeFindQuery 判断 —— 改错故障：每次刷新都批量拉全部 diff，面板明显卡顿
// INV-11 命中跳转依赖导航请求号：同一条命中重复点击也要重新居中 —— 守住它的位置：scrollToIndex 的 effect 依赖 —— 改错故障：连续点下一次命中时列表不滚动
// INV-12 命中位于折叠文件时必须先展开再滚动 —— 守住它的位置：setExpandedPath 调用 —— 改错故障：列表滚到了目标行，但文件内容仍是收起的
// INV-13 匹配数上报必须跟随 total 变化 —— 守住它的位置：onFileChangeFindMatchCountChange effect —— 改错故障：查找框计数停滞，用户误以为没有结果
// INV-14 来源切换必须同时清空展开态 —— 守住它的位置：handleSelectSource —— 改错故障：新来源里同路径文件被误展开
// INV-15 last-turn 来源不懒加载 diff：数据已内联 —— 守住它的位置：sourceId 判断 —— 改错故障：对已内联的 diff 再发一次无效请求
// INV-16 失败要落成不可用 diff 而不是丢掉缓存项 —— 守住它的位置：catch 分支写入 unavailable —— 改错故障：失败文件被反复重试并持续闪烁 loading
// INV-17 绝对路径与相对路径必须先区分再拼接 —— 守住它的位置：resolveChangePath —— 改错故障：绝对路径被二次拼接成不存在的位置
// INV-18 删除文件的上下文动作必须带 deleted 标记 —— 守住它的位置：revealInFileManager 调用 —— 改错故障：在文件管理器里定位一个已不存在的条目并报错
//
// 维护提示
//   虚拟滚动与查找是同一份扁平数据的两个消费者，新增过滤时两边都要同步。
//   任何异步写入缓存的路径都要先过世代号校验，缺一个就会产生陈旧数据。
//   展开态是展示状态，不要为了记住位置而把它持久化到 store。
//   diff 体积可能很大，缓存只增不删是刻意选择，清理粒度是整个工作区。
//   日志留在 debug 级别，查找预加载会放大调用次数。
//   注释块位置与密度基线由 DEEP-SPEC 统一维护，改动时不要打乱既有块顺序。
/* eslint-disable max-lines -- GitPane 当前集中承载来源切换、diff 懒加载、展开状态和文件变更查找联动；后续拆分需按 Git 面板功能边界单独推进。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { GitChangeSourceId, GitDiffResult } from "@zcode/shared";
import { TID_GIT_PANE } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { FileTextIcon, RefreshCw } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { type GitPaneFileChange, type GitPaneRepositoryState } from "@/hooks/useGitRepository.js";
import { useServices } from "@/hooks/useServices.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { joinFilePath, isAbsoluteFilePath } from "@/lib/path.js";
import {
  getDiffCacheKey,
  getErrorMessage,
  getGitPaneDiffFindContent,
  getSourceMessageId,
} from "@/GitPane/helpers.js";
import { GitPaneChangeCard } from "@/GitPaneChangeCard.js";
import { getFileChangeFindState } from "@/GitPane/fileChangeFindSearch.js";
import { logger } from "@/logger.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";

interface GitDiffLoadState {
  loading: boolean;
  diff: GitDiffResult | null;
}

// [资源] 行高估值只用于虚拟滚动的初始布局，
// 真实高度由 measureElement 回填。
// 估值偏小会造成首屏滚动跳动，
// 偏大只是多渲染几行，因此宁可略大。
const GIT_PANE_CHANGE_ROW_ESTIMATE_PX = 32;
const GIT_PANE_CHANGE_ROW_OVERSCAN = 14;

export function GitPane({
  workspacePath,
  gitState,
  isDesktop,
  selectedSourceId,
  fileChangeFindActiveIndex,
  fileChangeFindNavigationRequestId,
  fileChangeFindQuery,
  onFileChangeFindMatchCountChange,
  onSelectSource,
  onClose: _onClose,
  onRefresh,
  onRevealFileInTree,
  workspaceIdentity,
  workspaceRemoteSessionId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  gitState: GitPaneRepositoryState;
  isDesktop?: boolean;
  selectedSourceId: GitChangeSourceId;
  fileChangeFindActiveIndex: number;
  fileChangeFindNavigationRequestId: number;
  fileChangeFindQuery: string;
  onFileChangeFindMatchCountChange: (count: number) => void;
  onSelectSource: (sourceId: GitChangeSourceId) => void;
  onClose: () => void;
  onRefresh: () => void;
  onRevealFileInTree?: (path: string) => void;
}) {
  const { gitService } = useServices();
  const { intl } = useZCodeIntl();
  const theme = useZCodeStore((state) => state.theme);
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);
  const workspaceOpenTarget = useWorkspaceOpenInEditorTarget({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  });
  const fileActions = useFileContextActions({
    canOpenLocalFileManager: Boolean(isDesktop),
    isRemoteWorkspace:
      Boolean(workspaceRemoteSessionId || workspaceIdentity?.trim()) ||
      workspaceOpenTarget.isRemoteWorkspace,
    remoteTarget: workspaceOpenTarget.remoteTarget,
    workspaceIdentity,
  });
  const resolvedTheme = resolveTheme(theme);
  // [契约] 展开路径是单一值而不是集合。
  // 同一时刻只允许一个 diff 挂载，
  // 这是滚动高度可控与查找索引正确的前提。
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  // diffStateByKey 用 getDiffCacheKey(sourceId, change.path) 组合键：只按 path 缓存会在来源切换后命中另一份 diff；缓存项写入后不单独删除，由 diffGenerationRef 在 revision 或 workspacePath 变化时整体重置。
  const [diffStateByKey, setDiffStateByKey] = useState<Record<string, GitDiffLoadState>>({});
  // diffGenerationRef 在 workspacePath/revision 变化时先自增再清缓存，loadDiffForChange 发出请求前快照 generation，回调里 diffGenerationRef.current !== generation 就丢弃结果，避免旧响应写回新工作区。
  const diffGenerationRef = useRef(0);
  const pendingDiffKeysRef = useRef(new Set<string>());
  const changeListScrollRef = useRef<HTMLDivElement | null>(null);

  // [契约] 默认来源只用于兜底。
  // sourceOptions 为空时这里会是 undefined，
  // 但上游保证至少有一项，因此不再补判空分支。
  const defaultSourceOption = gitState.sourceOptions[0]!;
  const currentSourceOption =
    gitState.sourceOptions.find((option) => option.id === selectedSourceId) ?? defaultSourceOption;
  // [契约] datasets 缺 currentSourceOption.id 时回落到 unstaged。
  // 这样 sourceOptions 切换的中间态不会渲染成空列表。
  // 回落只影响 currentDataset 展示，不改变 selectedSourceId。
  const currentDataset = gitState.datasets[currentSourceOption.id] ?? gitState.datasets.unstaged;
  // currentChanges 由 currentDataset.sections.flatMap((section) => section.changes) 得到：分区只影响分组展示，fileChangeFindTargets 与 changeRowVirtualizer 都只认这份扁平数组，避免两套顺序。
  const currentChanges = useMemo(
    () => currentDataset.sections.flatMap((section) => section.changes),
    [currentDataset],
  );
  const normalizedFileChangeFindQuery = fileChangeFindQuery.trim();

  // [契约] 空态优先级：来源特例、加载、错误、Git 不可用、非仓库、真正为空。
  // 顺序不能调换，否则加载中会先显示成空列表。
  // 依赖只放用到的字段，避免无关 store 变化重建文案。
  const emptyStateCopy = useMemo(() => {
    if (currentSourceOption.id === "last-turn") {
      return {
        title: intl.formatMessage({ id: "git.empty.lastTurnTitle" }),
        description: intl.formatMessage({
          id: "git.empty.lastTurnDescription",
        }),
      };
    }

    if (gitState.loading) {
      return {
        title: intl.formatMessage({ id: "common.loading" }),
        description: intl.formatMessage({ id: "git.loading.description" }),
      };
    }

    if (gitState.error) {
      return {
        title: intl.formatMessage({ id: "git.error.title" }),
        description: intl.formatMessage(
          { id: "git.error.description" },
          { message: gitState.error },
        ),
      };
    }

    if (!gitState.summary.isGitAvailable) {
      return {
        title: intl.formatMessage({ id: "git.empty.gitUnavailableTitle" }),
        description: intl.formatMessage({
          id: "git.empty.gitUnavailableDescription",
        }),
      };
    }

    if (!gitState.summary.isRepository) {
      return {
        title: intl.formatMessage({ id: "git.empty.notRepositoryTitle" }),
        description: intl.formatMessage({
          id: "git.empty.notRepositoryDescription",
        }),
      };
    }

    return {
      title: intl.formatMessage({ id: "git.empty.title" }),
      description: intl.formatMessage({ id: "git.empty.description" }),
    };
  }, [
    currentSourceOption.id,
    gitState.error,
    gitState.loading,
    gitState.summary.isGitAvailable,
    gitState.summary.isRepository,
    intl,
  ]);

  useEffect(() => {
    // [事务] 工作区或版本号变化时，先自增世代号再清缓存。
    // 顺序不能反：先清空会让进行中的响应通过世代校验写回旧数据。
    // pending 集合也要一起清空，
    // 否则新世代里的同名键会被旧的 pending 挡住。
    diffGenerationRef.current += 1;
    pendingDiffKeysRef.current.clear();
    setDiffStateByKey({});
  }, [gitState.revision, workspacePath]);

  useEffect(() => {
    // expandedPath 的 effect 用 currentChanges.some((change) => change.path === expandedPath) 校验：刷新或切来源后路径可能消失，不 setExpandedPath(null) 会留下一条没有 diff 内容的空行。
    if (!expandedPath) {
      return;
    }

    if (!currentChanges.some((change) => change.path === expandedPath)) {
      setExpandedPath(null);
    }
  }, [currentChanges, expandedPath]);

  // [契约] 懒加载入口是幂等的，重复调用会先命中早退分支。
  // 调用方不需要自己判重 loadDiffForChange，
  // 这也让查找预加载可以无脑遍历整份 currentChanges。
  const loadDiffForChange = useCallback(
    (change: GitPaneFileChange, sourceId: GitChangeSourceId) => {
      // [契约] last-turn 的 diff 已随数据内联，不再请求。
      // 该判断必须先于缓存判断，
      // 否则会给内联数据再建一份多余缓存。
      if (sourceId === "last-turn" || change.diff) {
        return;
      }

      // cacheKey 必须由 getDiffCacheKey(sourceId, change.path) 生成，不拼 workspacePath：工作区切换已由 diffGenerationRef 整体失效并清空 diffStateByKey，再拼路径会让同一文件在多工作区间无法复用缓存。
      const cacheKey = getDiffCacheKey(sourceId, change.path);
      if (pendingDiffKeysRef.current.has(cacheKey) || diffStateByKey[cacheKey]?.diff) {
        return;
      }

      pendingDiffKeysRef.current.add(cacheKey);
      setDiffStateByKey((current) => ({
        ...current,
        [cacheKey]: {
          loading: true,
          diff: current[cacheKey]?.diff ?? null,
        },
      }));

      // [并发] 请求前快照世代号。
      // 这个值在回调里是唯一可信的时效依据，
      // 不要在回调里改读 ref 的当前值。
      const generation = diffGenerationRef.current;
      void gitService
        .getDiff({
          workspacePath,
          path: change.path,
          sourceId,
        })
        // [失败路径] 成功回调先校验世代再写缓存。
        // 过期响应直接丢弃且不更新 loading，
        // 因为那次 loading 已被重置逻辑清掉。
        .then((diff) => {
          if (diffGenerationRef.current !== generation) {
            return;
          }

          // 大文件 diff 卡顿问题需要先确认“卡在拉取还是卡在渲染”。
          // 这里记录每次展开拿到的 diff 规模，便于从日志快速定位是否命中 fallback 条件。
          // 文件变更查找会批量预加载 diff；这类逐文件规模日志只适合开发排查。
          // 走 debug 可避免生产桌面日志被搜索行为刷大，同时保留定位大 diff 卡顿的线索。
          logger.debug("[GitPane] diff 已加载", {
            workspacePath,
            sourceId,
            path: change.path,
            availability: diff.availability,
            beforeChars: diff.beforeContent?.length ?? 0,
            afterChars: diff.afterContent?.length ?? 0,
          });

          setDiffStateByKey((current) => ({
            ...current,
            [cacheKey]: {
              loading: false,
              diff,
            },
          }));
        })
        // [失败路径] 失败也要写一条不可用的 diff。
        // 展开态会显示错误说明，
        // 同时避免同一文件被反复重试。
        .catch((error: unknown) => {
          if (diffGenerationRef.current !== generation) {
            return;
          }

          const message = getErrorMessage(error);
          logger.warn("[GitPane] 读取文件 diff 失败", {
            workspacePath,
            sourceId,
            path: change.path,
            error: message,
          });
          setDiffStateByKey((current) => ({
            ...current,
            [cacheKey]: {
              loading: false,
              diff: {
                path: change.path,
                availability: "unavailable",
                patch: null,
                beforeContent: null,
                afterContent: null,
                summary: message,
              },
            },
          }));
        })
        // [资源] pending 标记必须在 finally 清理。
        // 只写在成功路径会让失败文件永久停在待定状态，
        // 之后再也不会重新请求。
        .finally(() => {
          pendingDiffKeysRef.current.delete(cacheKey);
        });
    },
    [diffStateByKey, gitService, workspacePath],
  );

  useEffect(() => {
    if (!expandedPath) {
      return;
    }

    const expandedChange = currentChanges.find((change) => change.path === expandedPath);
    if (!expandedChange) {
      return;
    }

    // [契约] 展开变化后按当前来源重新取 diff。
    // 来源作为依赖是有意的，
    // 同一路径在不同来源下的内容不同。
    loadDiffForChange(expandedChange, currentDataset.id);
  }, [currentChanges, currentDataset.id, expandedPath, loadDiffForChange]);

  // [契约] 查找内容优先取内联 diff，其次取缓存。
  // 两者都没有时填 null，
  // 查找器会把该文件当作无内容而不是报错。
  const fileChangeFindTargets = useMemo(
    () =>
      currentChanges.map((change) => {
        const diffState =
          change.diff ??
          diffStateByKey[getDiffCacheKey(currentDataset.id, change.path)]?.diff ??
          null;
        return {
          path: change.path,
          content: getGitPaneDiffFindContent(diffState),
        };
      }),
    [currentChanges, currentDataset.id, diffStateByKey],
  );
  // fileChangeFindState 完全由 getFileChangeFindState(fileChangeFindTargets, fileChangeFindQuery, fileChangeFindActiveIndex) 计算：组件只传目标与查询，若在渲染期再过滤或排序，activeMatch 索引会和 fileChangeFindTargets 的顺序错位。
  const fileChangeFindState = useMemo(
    () =>
      getFileChangeFindState(fileChangeFindTargets, fileChangeFindQuery, fileChangeFindActiveIndex),
    [fileChangeFindActiveIndex, fileChangeFindQuery, fileChangeFindTargets],
  );
  const activeFileChangeFindMatch = fileChangeFindState.activeMatch;
  // [契约] 虚拟滚动 key 必须带来源 id。
  // 同一路径在不同来源下是不同行，
  // 缺来源会让展开态错误复用到另一个来源。
  const changeRowVirtualizer = useVirtualizer({
    count: currentChanges.length,
    getItemKey: (index) => {
      const change = currentChanges[index];
      return change ? `${currentDataset.id}:${change.path}` : `${currentDataset.id}:${index}`;
    },
    getScrollElement: () => changeListScrollRef.current,
    estimateSize: () => GIT_PANE_CHANGE_ROW_ESTIMATE_PX,
    overscan: GIT_PANE_CHANGE_ROW_OVERSCAN,
  });
  const virtualChangeRows = changeRowVirtualizer.getVirtualItems();

  useEffect(() => {
    // [契约] fileChangeFindState.total 变化后立即上报。
    // 上报函数来自 props，
    // 依赖里必须包含它，否则父级换回调后计数不再更新。
    onFileChangeFindMatchCountChange(fileChangeFindState.total);
  }, [fileChangeFindState.total, onFileChangeFindMatchCountChange]);

  useEffect(() => {
    // Review 面板打开时会把数百个未跟踪文件同步挂载，CDP trace 里 click
    // 事件因此出现 600ms+ long task。这里只挂载可视行；展开 diff 后高度变化时重测，
    // 避免后续虚拟行继续沿用折叠态高度。
    // changeRowVirtualizer.measure() 在 expandedPath 或 currentDataset.id 变化后必须调用：展开 diff 后行高变了，不重测会让后续虚拟行沿用折叠态高度，出现行重叠或大段空白。
    changeRowVirtualizer.measure();
  }, [changeRowVirtualizer, currentDataset.id, expandedPath]);

  useEffect(() => {
    // [权衡] 只有查询非空时才批量预加载。
    // 这是查找能命中折叠文件的代价，
    // 查询清空后不主动回收已加载的 diff。
    if (!normalizedFileChangeFindQuery) {
      return;
    }

    // 文件变更查找需要命中折叠文件里的内容。
    // diff 默认是展开时懒加载的，所以查找时先把当前来源的 diff 补齐，再用同一套 patch 数据计算全局命中。
    // [契约] 预加载遍历 currentChanges 整份扁平列表。
    // 懒加载入口自带去重，
    // 因此这里不需要再判 pending 或缓存。
    for (const change of currentChanges) {
      loadDiffForChange(change, currentDataset.id);
    }
  }, [currentChanges, currentDataset.id, loadDiffForChange, normalizedFileChangeFindQuery]);

  useEffect(() => {
    // [契约] activeFileChangeFindMatch 为空时不展开也不滚动。
    // 查询清空后命中会变成 null，
    // 此时必须保持用户当前的展开状态。
    if (!activeFileChangeFindMatch) {
      return;
    }

    const activeChange = currentChanges.find(
      (change) => change.path === activeFileChangeFindMatch.path,
    );
    if (!activeChange) {
      return;
    }

    if (expandedPath !== activeFileChangeFindMatch.path) {
      // 当前命中可能位于折叠文件内。
      // 先展开目标文件，再由文本高亮 hook 在真实 DOM 渲染后滚动到命中行。
      // [契约] 命中位于折叠文件时先展开。
      // 滚动交给文本高亮 hook 在真实 DOM 渲染后执行，
      // 这里提前滚动会落在未展开的高度上。
      setExpandedPath(activeFileChangeFindMatch.path);
    }
    loadDiffForChange(activeChange, currentDataset.id);
  }, [
    activeFileChangeFindMatch,
    currentChanges,
    currentDataset.id,
    expandedPath,
    fileChangeFindNavigationRequestId,
    loadDiffForChange,
  ]);

  useEffect(() => {
    if (!activeFileChangeFindMatch) {
      return;
    }

    const activeMatchIndex = currentChanges.findIndex(
      (change) => change.path === activeFileChangeFindMatch.path,
    );
    if (activeMatchIndex < 0) {
      return;
    }

    // [契约] 命中跳转以导航请求号 requestId 为唯一触发器。
    // 同一条命中重复点击时命中对象不变，
    // 只有请求号变化才能让 effect 再跑一次。
    changeRowVirtualizer.scrollToIndex(activeMatchIndex, { align: "center" });
  }, [
    activeFileChangeFindMatch,
    changeRowVirtualizer,
    currentChanges,
    fileChangeFindNavigationRequestId,
  ]);

  // handleSelectSource 先 onSelectSource(nextSourceId) 再 setExpandedPath(null)：顺序反过来时旧来源会先用新展开态重渲一次，短暂挂载一个不属于它的 diff。
  const handleSelectSource = (nextSourceId: string) => {
    logger.info(`[GitPane] 切换来源 workspace=${workspacePath} source=${nextSourceId}`);
    onSelectSource(nextSourceId as GitChangeSourceId);
    setExpandedPath(null);
  };

  // handleExpandChange 在 nextOpen 为 true 时调 loadDiffForChange(change, currentDataset.id)；收起只 setExpandedPath(null)，不删 diffStateByKey，再次展开可直接命中缓存。
  const handleExpandChange = (change: GitPaneFileChange, nextOpen: boolean) => {
    logger.info(
      `[GitPane] 切换文件展开 workspace=${workspacePath} source=${currentSourceOption.id} path=${change.path} expanded=${nextOpen}`,
    );
    setExpandedPath(nextOpen ? change.path : null);
    if (nextOpen) {
      loadDiffForChange(change, currentDataset.id);
    }
  };

  // resolveChangePath 用 isAbsoluteFilePath(change.path) 分流：绝对路径原样返回，只有相对路径才 joinFilePath(workspacePath, change.path)，否则会拼出不存在的位置。
  const resolveChangePath = useCallback(
    (change: GitPaneFileChange) =>
      isAbsoluteFilePath(change.path) ? change.path : joinFilePath(workspacePath, change.path),
    [workspacePath],
  );

  // handleCopyAbsolutePath 调 fileActions.copyAbsolutePath({ path: resolveChangePath(change) })，不直接用 navigator.clipboard：远程工作区需要由 useFileContextActions 决定复制的是本地路径还是远端路径。
  const handleCopyAbsolutePath = useCallback(
    (change: GitPaneFileChange) => {
      void fileActions.copyAbsolutePath({ path: resolveChangePath(change) });
    },
    [fileActions, resolveChangePath],
  );
  const handleCopyRelativePath = useCallback(
    (change: GitPaneFileChange) => {
      void fileActions.copyRelativePath({
        path: resolveChangePath(change),
        relativePath: getWorkspaceFileRelativePath(workspacePath, resolveChangePath(change)),
      });
    },
    [fileActions, resolveChangePath, workspacePath],
  );

  const handleRevealChangeInFileManager = useCallback(
    (change: GitPaneFileChange) => {
      void fileActions.revealInFileManager({
        path: resolveChangePath(change),
        deleted: change.kind === "deleted",
        kind: "file",
      });
    },
    [fileActions, resolveChangePath],
  );

  const handleRevealChangeInFileTree = useCallback(
    (change: GitPaneFileChange) => {
      onRevealFileInTree?.(resolveChangePath(change));
    },
    [onRevealFileInTree, resolveChangePath],
  );

  // [契约] 右键菜单文案随语言重新生成。
  // 依赖只有 intl，
  // 不能把配置或工作区塞进来，否则每次滚动都会重建。
  // 这层缓存与行虚拟化无关，不要合并到行组件的 memo 里。
  const contextMenuLabels = useMemo(
    () => ({
      copyAbsolutePath: intl.formatMessage({ id: "fileActions.copyAbsolutePath" }),
      copyRelativePath: intl.formatMessage({ id: "fileActions.copyRelativePath" }),
      revealInFileManager: intl.formatMessage({ id: "git.changeContext.revealInFileManager" }),
      revealInFileTree: intl.formatMessage({ id: "git.changeContext.revealInFileTree" }),
    }),
    [intl],
  );

  return (
    <section data-testid={TID_GIT_PANE} className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center justify-between gap-3 p-3">
        <Select value={currentSourceOption.id} onValueChange={handleSelectSource}>
          <SelectTrigger className="max-w-full" size="lg">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {gitState.sourceOptions.map((option) => (
              <SelectItem key={option.id} value={option.id} disabled={option.disabled}>
                {intl.formatMessage({ id: getSourceMessageId(option.id) })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="lg"
            disabled={gitState.loading}
            onClick={onRefresh}
          >
            <RefreshCw className={cn("size-3.5", gitState.loading && "animate-spin")} />
            {intl.formatMessage({ id: "git.action.refresh" })}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {currentChanges.length > 0 ? (
          <div ref={changeListScrollRef} className="h-full min-h-0 w-full overflow-auto">
            <div
              className="relative w-full min-w-0"
              style={{ height: `${changeRowVirtualizer.getTotalSize()}px` }}
            >
              {virtualChangeRows.map((virtualRow) => {
                const change = currentChanges[virtualRow.index];
                if (!change) {
                  return null;
                }

                const isExpanded = expandedPath === change.path;
                const diffCacheKey = getDiffCacheKey(currentDataset.id, change.path);
                const cachedDiffState = diffStateByKey[diffCacheKey];
                const diffState = change.diff ?? cachedDiffState?.diff ?? null;
                const isDiffLoading =
                  isExpanded && !change.diff && (!cachedDiffState || cachedDiffState.loading);

                return (
                  <div
                    key={virtualRow.key}
                    ref={changeRowVirtualizer.measureElement}
                    className="absolute left-0 w-full min-w-0"
                    data-git-pane-change-virtual-row
                    data-index={virtualRow.index}
                    // transform 定位会让行内 sticky 文件名失效，展开大 diff 后标题不再置顶。
                    // 改用 top 偏移保留虚拟滚动布局，同时让 sticky 继续以滚动容器为参照。
                    style={{ top: `${virtualRow.start}px` }}
                  >
                    <GitPaneChangeCard
                      change={change}
                      contextMenuLabels={contextMenuLabels}
                      diffState={diffState}
                      isDiffLoading={isDiffLoading}
                      isExpanded={isExpanded}
                      canRevealInFileManager={fileActions.canRevealInFileManager({
                        path: resolveChangePath(change),
                        deleted: change.kind === "deleted",
                      })}
                      codePreviewSettings={codePreviewSettings}
                      resolvedTheme={resolvedTheme}
                      onCopyAbsolutePath={handleCopyAbsolutePath}
                      onCopyRelativePath={handleCopyRelativePath}
                      onOpenChange={handleExpandChange}
                      onRevealInFileManager={handleRevealChangeInFileManager}
                      onRevealInFileTree={
                        onRevealFileInTree ? handleRevealChangeInFileTree : undefined
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <FileTextIcon className="size-8 text-foreground-subtlest" />
            <p className="mt-3 text-ui-base font-medium text-foreground">{emptyStateCopy.title}</p>
            <p className="mt-1 text-ui-base text-foreground-subtle">{emptyStateCopy.description}</p>
          </div>
        )}
      </div>
    </section>
  );
}
