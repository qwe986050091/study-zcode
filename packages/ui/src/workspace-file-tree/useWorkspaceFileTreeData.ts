/* eslint-disable max-lines -- 文件树数据 hook 需要集中维护目录加载、watcher 刷新和 Git 状态竞态。 */
// 职责边界（useWorkspaceFileTreeData）
// 做：维护 workspace 文件树的目录 children、展开态、加载态、错误态与 Git 状态投影。
// 做：串行化目录加载与 watcher 刷新，用代际号与请求序号丢弃过期快照。
// 不做：不做行布局与渲染（交给 useWorkspaceFileTreeRows），不持有 watcher 连接本身。
// 不做：不直接调用 window.zcode 或具体服务实现，只用 useWorkspaceServices 注入的 service。
// 依赖：fileService.readdir、fileWatcherService、gitService 与 workspace-file-tree/model 纯函数。
// 边界：任何异步结果写回 state 之前，必须先过 generation 与 requestVersion 双重校验。
//
// INV 不变量表（19 条；每条都是「看起来该改、其实不能改」的约束）
// INV-01 断言：workspaceGeneration 在切换 workspace 与卸载时都要自增 —— 守住它的位置：reset effect 与 cleanup —— 改错故障：旧 workspace 的迟到 readdir 覆盖新树
// INV-02 断言：异步写回前必须同时校验 generation 与 requestVersion —— 守住它的位置：isCurrentDirectoryRequest —— 改错故障：旧快照覆盖新 children
// INV-03 断言：目录请求序号按目录独立递增，裁剪时不能删除 —— 守住它的位置：pruneDirectorySubtree —— 改错故障：同路径重建复用旧序号，删除前的旧请求重新生效
// INV-04 断言：loading/loaded 的 ref 与 state 必须成对更新 —— 守住它的位置：setDirectoryLoading 与 setDirectoryLoaded —— 改错故障：回调读到旧集合，重复发起同一目录请求
// INV-05 断言：只有 force 才绕过 loading/loaded 短路 —— 守住它的位置：loadDirectory 前置判断 —— 改错故障：watcher 刷新被短路，文件变更看不到
// INV-06 断言：silent 只影响 loading 展示，不影响 loaded 与版本 —— 守住它的位置：loadDirectory —— 改错故障：静默刷新后目录被当成未加载
// INV-07 断言：ignored 结果晚到不得清除其他目录的标记 —— 守住它的位置：gitIgnored 的 then —— 改错故障：并发目录互相删除 ignored 结果
// INV-08 断言：自动展平只沿普通单子目录递归 —— 守住它的位置：entries.length 为 1 且 isAutoFlattenable —— 改错故障：软链接目录循环递归直到爆栈
// INV-09 断言：Git 状态读取失败必须清空可用标志 —— 守住它的位置：loadGitStatus 的 catch —— 改错故障：用户在过期状态下继续筛选文件树
// INV-10 断言：Git 状态请求序号单调递增，失败路径也要推进 —— 守住它的位置：requestVersion 比较 —— 改错故障：旧响应覆盖新结果
// INV-11 断言：只有 watcher 刷新失败才能裁 subtree —— 守住它的位置：refreshDirectoryFromWatcher —— 改错故障：手动刷新 readdir 失败也裁树，目录被误删
// INV-12 断言：手动刷新失败必须 invalidate 该目录请求 —— 守住它的位置：refreshDirectoryManually 的 catch —— 改错故障：超时后旧请求仍能写回
// INV-13 断言：手动刷新不得复用 watcher 的裁剪逻辑 —— 守住它的位置：同上的注释处 —— 改错故障：网络抖动清空整棵旧树
// INV-14 断言：refreshBatchVersion 只由 cancelRefreshBatch 与新一轮刷新推进 —— 守住它的位置：cancelRefreshBatch —— 改错故障：旧批次继续跑并写 state
// INV-15 断言：worker 每轮都要重查 generation 与 batch version —— 守住它的位置：runWorker 的 while —— 改错故障：切换 workspace 后继续读旧目录
// INV-16 断言：refreshLoadedDirectories 必须防重入 —— 守住它的位置：refreshingLoadedDirectoriesRef —— 改错故障：多次点击产生并发刷新
// INV-17 断言：finally 里的复位必须带版本校验 —— 守住它的位置：refreshLoadedDirectories 的 finally —— 改错故障：旧批次复位新批次的 loading 标志
// INV-18 断言：watcher 事件必须按目录去重并 debounce —— 守住它的位置：enqueueWatchRefresh —— 改错故障：一次保存触发 N 次重复刷新
// INV-19 断言：超过阈值时退化为根目录加展开目录刷新 —— 守住它的位置：flushWatchRefreshQueue —— 改错故障：大仓库全量刷新卡死
// INV-20 断言：rows 只由 useWorkspaceFileTreeRows 从状态派生，hook 内不缓存行数组 —— 守住它的位置：rows 调用处 —— 改错故障：两份投影不一致，展开与选中状态错位
//
// 维护约定：新增异步入口先接 generation，再接 requestVersion，两级都要校验，不能只校验一级。
// 维护约定：ref 与 state 成对维护时先写 ref 再 setState，异步回调里读 ref 才不会拿到旧值。
// 维护约定：不要为提高命中率删掉 stale 判定，它防的是旧快照覆盖新树。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import {
  WORKSPACE_FILE_TREE_WATCH_BULK_REFRESH_THRESHOLD,
  WORKSPACE_FILE_TREE_WATCH_DEBOUNCE_MS,
  WORKSPACE_FILE_TREE_WATCH_REFRESH_CONCURRENCY,
  WORKSPACE_FILE_TREE_REFRESH_DIRECTORY_TIMEOUT_MS,
  WORKSPACE_FILE_TREE_REFRESH_GIT_TIMEOUT_MS,
} from "@/workspace-file-tree/constants.js";
import { replaceSetValue, toError } from "@/workspace-file-tree/helpers.js";
import {
  buildWorkspaceFileIgnoredPathSet,
  getWorkspaceFileDirectoryChildDepth,
  getWorkspaceFileParentDirectory,
  isWorkspaceFileTreeAutoFlattenableDirectory,
  isWorkspaceFilePathInside,
  type WorkspaceFileGitStatus,
  type WorkspaceFileTreeNode,
} from "@/workspace-file-tree/model.js";
import { loadWorkspaceFileTreeGitStatus } from "@/workspace-file-tree/gitStatus.js";
import { useWorkspaceFileTreeWatchers } from "@/workspace-file-tree/useWorkspaceFileTreeWatchers.js";
import { getWorkspaceFileTreeRefreshDirectoryPaths } from "@/workspace-file-tree/refreshDirectories.js";
import { useWorkspaceFileTreeRows } from "@/workspace-file-tree/useWorkspaceFileTreeRows.js";

// [契约] 三态是调用方的判定依据：loaded 表示本次结果已写入，stale 表示被更新的请求取代，failed 才是真失败。
// [失败路径] 不能把 stale 合并进 failed，watcher 会把 stale 当成目录消失并裁掉整棵子树。
// [权衡] stale 不写 error 也不清 loading，由更新的那个请求负责收尾。
// [契约] 新增返回值前先确认所有调用点都能区分「被取代」与「失败」。
// [事务] 三态的判定只在 loadDirectory 的出口产生，调用方不得自行推断。
type WorkspaceFileTreeDirectoryLoadResult = "loaded" | "stale" | "failed";

function createWorkspaceFileTreeTimeoutError(label: string, timeoutMs: number) {
  return new Error(`${label} timed out after ${timeoutMs}ms`);
}

// [资源] Promise.race 的超时分支只负责 reject，不会取消底层 readdir。
// [失败路径] 底层请求仍会在后台完成，因此必须靠请求序号丢弃它的结果。
// [事务] finally 里清 timer，成功路径也不能漏，否则事件循环被拖住。
// [权衡] 故意不做 AbortController：fileService 接口没有取消语义。
// [并发] 超时与成功可能同 tick 竞争，先到者决定结果，这是可接受的。
async function withWorkspaceFileTreeTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(createWorkspaceFileTreeTimeoutError(label, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

// [契约] 参数里的 workspaceIdentity 用于服务解析，workspacePath 用于文件操作，二者不能互相替代。
// [依赖] enableWorkspaceFeatures 关闭时仍要能读目录，只是不查 Git ignored 与状态。
// [契约] hook 只返回状态与动作，不暴露内部 ref，避免调用方绕过版本校验。
export function useWorkspaceFileTreeData({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  enableWorkspaceFeatures = true,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  enableWorkspaceFeatures?: boolean;
}) {
  const { fileService, fileWatcherService, gitService } = useWorkspaceServices(
    workspacePath,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  // [并发] generation 是跨 workspace 的第一道闸：切换或卸载都自增，旧请求立即失效。
  // [事务] 自增必须发生在清空 state 之前，否则中间窗口期的写回会被当成有效。
  // [契约] 不能用 state 保存 generation，回调里读到的会是上一次渲染的值。
  // [失败路径] 只比较路径而不比较 generation，同一路径重新打开会复用旧结果。
  const workspaceGenerationRef = useRef(0);
  const requestVersionRef = useRef(0);
  // [并发] 目录级序号解决同一目录的并发读写：最后一次发起的请求才有写回权。
  // [失败路径] 裁剪子树时只能递增不能 delete，否则重建目录会复用旧序号。
  // [权衡] 用 Map 而不是全局计数器：不同目录的请求互不干扰。
  const directoryRequestVersionRef = useRef<Map<string, number>>(new Map());
  const gitStatusRequestVersionRef = useRef(0);
  const refreshBatchVersionRef = useRef(0);
  const pendingWatchRefreshPathsRef = useRef<Set<string>>(new Set());
  const watchRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingDirectoryPathsRef = useRef<Set<string>>(new Set());
  const loadedDirectoryPathsRef = useRef<Set<string>>(new Set());
  const [childrenByDirectory, setChildrenByDirectory] = useState<
    Map<string, WorkspaceFileTreeNode[]>
  >(new Map());
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadedDirectoryPaths, setLoadedDirectoryPaths] = useState<Set<string>>(new Set());
  const [loadingDirectoryPaths, setLoadingDirectoryPaths] = useState<Set<string>>(new Set());
  const [errorByDirectory, setErrorByDirectory] = useState<Map<string, Error>>(new Map());
  const [gitStatusByPath, setGitStatusByPath] = useState<Map<string, WorkspaceFileGitStatus>>(
    new Map(),
  );
  const [gitStatusAvailable, setGitStatusAvailable] = useState(false);
  const [ignoredPathSet, setIgnoredPathSet] = useState<Set<string>>(new Set());
  const [refreshingLoadedDirectories, setRefreshingLoadedDirectories] = useState(false);
  // [并发] 防重入标志必须在 setState 之前同步置位，否则两次点击都可能通过检查。
  // [契约] ref 与 state 同时维护：ref 给回调判断，state 给 UI 显示。
  // [失败路径] 只在 finally 复位而不校验版本，会让旧批次把新批次的状态清掉。
  const refreshingLoadedDirectoriesRef = useRef(false);

  // [契约] 两个镜像 effect 只把 state 同步进 ref，不做任何副作用。
  // [事务] 顺序不能反：ref 是「最新值」的唯一来源，state 只是渲染投影。
  // [失败路径] 删掉镜像 effect 后，新建的 callback 会闭包到首次渲染的空集合。
  // [权衡] 用 effect 同步而不是在 setState 时手写两份，避免遗漏某条写入路径。
  useEffect(() => {
    loadingDirectoryPathsRef.current = loadingDirectoryPaths;
  }, [loadingDirectoryPaths]);

  useEffect(() => {
    loadedDirectoryPathsRef.current = loadedDirectoryPaths;
  }, [loadedDirectoryPaths]);

  // [契约] 先写 ref 再 setState：同一 tick 内的后续判断要看到新集合。
  // [失败路径] 只改一处会让 loading 显示与短路判断不一致，导致重复请求。
  // [事务] replaceSetValue 返回新集合，不能原地修改，React 依赖引用比较。
  // [权衡] 这里不做去重判断：调用方已保证语义，重复 set 是幂等的。
  const setDirectoryLoading = useCallback((path: string, loading: boolean) => {
    const next = replaceSetValue(loadingDirectoryPathsRef.current, path, loading);
    loadingDirectoryPathsRef.current = next;
    setLoadingDirectoryPaths(next);
  }, []);

  const setDirectoryLoaded = useCallback((path: string, loaded: boolean) => {
    const next = replaceSetValue(loadedDirectoryPathsRef.current, path, loaded);
    loadedDirectoryPathsRef.current = next;
    setLoadedDirectoryPaths(next);
  }, []);

  // [契约] 只递增目标目录的序号，不影响兄弟目录。
  // [失败路径] pruneDirectorySubtree 依赖它让旧请求失效，删掉会让已删除目录的结果复活。
  // [并发] 递增是同步操作，不能在 await 之后补做。
  const invalidateDirectoryRequest = useCallback((directoryPath: string) => {
    directoryRequestVersionRef.current.set(
      directoryPath,
      (directoryRequestVersionRef.current.get(directoryPath) ?? 0) + 1,
    );
  }, []);

  const cancelRefreshBatch = useCallback(() => {
    refreshBatchVersionRef.current += 1;
  }, []);

  // [事务] 顺序是先 invalidate 全部子路径，再清 children、expanded、error。
  // [失败路径] 先清 state 会让在途请求在新 state 上写回，删除的目录重新出现。
  // [契约] 四个集合都要裁：只裁 children 会留下悬空的展开态与错误态。
  // [资源] 裁剪用 isWorkspaceFilePathInside 判断，不能用字符串 startsWith 前缀。
  const pruneDirectorySubtree = useCallback(
    (directoryPath: string) => {
      for (const path of directoryRequestVersionRef.current.keys()) {
        if (isWorkspaceFilePathInside(directoryPath, path)) {
          // 目录被裁剪时不能删除请求序号，否则同路径重建会复用旧序号，让删除前的旧请求重新生效。
          invalidateDirectoryRequest(path);
        }
      }
      setChildrenByDirectory((current) => {
        const next = new Map(current);
        for (const path of current.keys()) {
          if (isWorkspaceFilePathInside(directoryPath, path)) {
            next.delete(path);
          }
        }
        return next;
      });
      setExpandedPaths((current) => {
        const next = new Set(
          [...current].filter((path) => !isWorkspaceFilePathInside(directoryPath, path)),
        );
        return next;
      });
      setErrorByDirectory((current) => {
        const next = new Map(current);
        for (const path of current.keys()) {
          if (isWorkspaceFilePathInside(directoryPath, path)) {
            next.delete(path);
          }
        }
        return next;
      });

      const nextLoaded = new Set(
        [...loadedDirectoryPathsRef.current].filter(
          (path) => !isWorkspaceFilePathInside(directoryPath, path),
        ),
      );
      loadedDirectoryPathsRef.current = nextLoaded;
      setLoadedDirectoryPaths(nextLoaded);

      const nextLoading = new Set(
        [...loadingDirectoryPathsRef.current].filter(
          (path) => !isWorkspaceFilePathInside(directoryPath, path),
        ),
      );
      loadingDirectoryPathsRef.current = nextLoading;
      setLoadingDirectoryPaths(nextLoading);
    },
    [invalidateDirectoryRequest],
  );

  // [契约] 目录加载的唯一入口：readdir、ignored、children、loaded 都在这里收尾。
  // [事务] 进入函数的第一件事是校验 generation，然后才是短路判断。
  // [失败路径] 短路必须在版本校验之后，否则切换 workspace 会直接返回 loaded。
  // [资源] 返回三态而不是抛错：调用方按 loaded/stale/failed 决定后续动作。
  const loadDirectory = useCallback(
    async (
      directoryPath: string,
      childDepth: number,
      options?: {
        force?: boolean;
        silent?: boolean;
        workspaceGeneration?: number;
      },
    ): Promise<WorkspaceFileTreeDirectoryLoadResult> => {
      // [契约] force 跳过 loading/loaded 短路，供手动刷新与 watcher 使用。
      // [失败路径] 把 force 当成「忽略版本」会让旧请求覆盖新树，二者完全无关。
      // [权衡] silent 与 force 正交：前者控制展示，后者控制是否复用缓存。
      const force = options?.force ?? false;
      const silent = options?.silent ?? false;
      const expectedWorkspaceGeneration =
        options?.workspaceGeneration ?? workspaceGenerationRef.current;
      if (workspaceGenerationRef.current !== expectedWorkspaceGeneration) {
        return "stale";
      }
      if (
        !force &&
        (loadingDirectoryPathsRef.current.has(directoryPath) ||
          loadedDirectoryPathsRef.current.has(directoryPath))
      ) {
        return "loaded";
      }

      // [并发] 快照 requestVersion 而不是每次现读：等待期间的变化都视为本请求过期。
      // [契约] 同一个请求的后续所有校验都用这个局部快照。
      // [失败路径] 写成 requestVersionRef.current 会永远相等，校验形同虚设。
      // [事务] 序号在 readdir 之前取，保证等待期间发生的重载一定能被感知。
      const requestVersion = requestVersionRef.current;
      // 手动刷新和 watcher 可能并发读取同一目录，目录级序号避免旧快照晚返回后覆盖新文件树。
      const directoryRequestVersion =
        (directoryRequestVersionRef.current.get(directoryPath) ?? 0) + 1;
      directoryRequestVersionRef.current.set(directoryPath, directoryRequestVersion);
      // [契约] 三个条件必须同时成立：workspace、整树版本、目录序号。
      // [并发] 定义成闭包而非布尔值，因为它在 await 之后才被调用。
      // [失败路径] 拆开只校验其中两项，都会放过一类过期快照。
      // [权衡] 不做 deep equal：只比较版本号，成本恒定。
      const isCurrentDirectoryRequest = () =>
        workspaceGenerationRef.current === expectedWorkspaceGeneration &&
        requestVersionRef.current === requestVersion &&
        directoryRequestVersionRef.current.get(directoryPath) === directoryRequestVersion;
      if (!silent) {
        setDirectoryLoading(directoryPath, true);
      }
      setErrorByDirectory((current) => {
        const next = new Map(current);
        next.delete(directoryPath);
        return next;
      });

      try {
        // [契约] includeHidden 恒为 true：隐藏文件由上层过滤，树本身不丢数据。
        // [失败路径] 这里用目录路径而不是 workspace 路径，远程模式下两者语义不同。
        // [并发] await 之后必须立刻校验版本，越早丢弃越省后续计算。
        // [权衡] 不在这里排序：顺序由 rows 层按名称与类型统一决定。
        const entries = await fileService.readdir({
          path: directoryPath,
          includeHidden: true,
        });
        if (!isCurrentDirectoryRequest()) {
          return "stale";
        }

        // [契约] Git ignored 查询是旁路：不 await，失败也不影响目录加载结果。
        // [失败路径] await 它会把手动刷新拖到 Git 超时，目录树迟迟不更新。
        // [权衡] 选中用 void 启动而不是并行 Promise.all，胜负互不阻塞。
        // [事务] ignored 结果只做增量合并，不整体替换，避免覆盖其它目录的结论。
        if (enableWorkspaceFeatures) {
          // [契约] 查询的 paths 必须来自本次 readdir 的 entries，不能用旧快照。
          // [失败路径] then 里必须再校验目录请求版本，晚到的 ignored 只能丢弃。
          // [资源] catch 只 warn：ignored 是增强信息，缺失不应阻断文件树。
          void gitService
            .getIgnoredPaths({
              workspacePath,
              paths: entries.map((entry) => entry.path),
            })
            .then((ignoredPaths) => {
              if (!isCurrentDirectoryRequest()) {
                return;
              }
              const ignoredPathKeys = buildWorkspaceFileIgnoredPathSet(ignoredPaths);
              setIgnoredPathSet((current) => {
                const next = new Set(current);
                for (const path of entries.map((entry) => entry.path)) {
                  next.delete(path.replace(/\\/g, "/").replace(/\/+$/, ""));
                }
                for (const path of ignoredPathKeys) {
                  next.add(path);
                }
                return next;
              });
            })
            .catch((error) => {
              const nextError = toError(error);
              logger.warn("[WorkspaceFileTree] 读取 Git ignored 状态失败", {
                workspacePath,
                path: directoryPath,
                error: nextError.message,
              });
            });
        }

        // [契约] children 只按目录 key 覆盖，不重建整张表。
        // [事务] 在同一处同时构造节点，depth 必须用调用方传入的 childDepth。
        // [失败路径] isSymbolicLink 要用 === true 归一，undefined 不能被当成有效值透出。
        // [并发] 函数式 setState 保证读到最新 Map，不能用闭包里的旧引用。
        setChildrenByDirectory((current) => {
          const next = new Map(current);
          next.set(
            directoryPath,
            entries.map((entry) => ({
              path: entry.path,
              name: entry.name,
              type: entry.type,
              isSymbolicLink: entry.isSymbolicLink === true,
              depth: childDepth,
            })),
          );
          return next;
        });
        setDirectoryLoaded(directoryPath, true);

        // [契约] 只有恰好一个可展平子目录时才继续预加载，多于一个就停。
        // [失败路径] 去掉 isAutoFlattenable 会把软链接目录也递归进去，形成环。
        // [事务] 预加载传 silent 与原 generation，失败不能清父目录的 loaded。
        // [资源] 不 await 这个递归：展平链再长也不能阻塞父目录返回。
        if (entries.length === 1 && isWorkspaceFileTreeAutoFlattenableDirectory(entries[0])) {
          // 修复：flatten empty directories 只沿普通单子目录链预加载，避免软链接目录循环递归。
          void loadDirectory(entries[0].path, childDepth + 1, {
            silent: true,
            workspaceGeneration: expectedWorkspaceGeneration,
          });
        }
        // [契约] 只有 children 与 loaded 都写入后才返回 loaded。
        // [失败路径] 提前 return 会让调用方以为可交互，实际目录还空。
        // [事务] 返回值是父目录判断是否继续预加载的依据，不能随意改。
        return "loaded";
      } catch (error) {
        if (!isCurrentDirectoryRequest()) {
          return "stale";
        }
        const nextError = toError(error);
        logger.warn("[WorkspaceFileTree] 读取目录失败", {
          path: directoryPath,
          error: nextError.message,
        });
        setErrorByDirectory((current) => {
          const next = new Map(current);
          next.set(directoryPath, nextError);
          return next;
        });
        return "failed";
      } finally {
        if (isCurrentDirectoryRequest()) {
          setDirectoryLoading(directoryPath, false);
        }
      }
    },
    [
      enableWorkspaceFeatures,
      fileService,
      gitService,
      setDirectoryLoaded,
      setDirectoryLoading,
      workspacePath,
    ],
  );

  // [契约] Git 状态是整树一份快照，不按目录增量更新。
  // [并发] 请求序号与 workspace generation 都要校验，缺一不可。
  // [失败路径] catch 里也要校验版本，否则旧失败会清空新结果。
  // [权衡] 超时外置：调用方决定是否加 timeout，函数本身不内建。
  const loadGitStatus = useCallback(
    async (options?: { workspaceGeneration?: number }) => {
      const workspaceGeneration = options?.workspaceGeneration ?? workspaceGenerationRef.current;
      if (workspaceGenerationRef.current !== workspaceGeneration) {
        return;
      }
      // [契约] 功能关闭时要主动清空 Git 状态，不能保留上一次的结果。
      // [失败路径] 直接 return 会让切换项目后仍显示旧仓库的变更标记。
      // [事务] 清空必须成对：可用标志与路径映射同时复位。
      // [并发] 这里的清空不受版本保护，因为它只依赖参数而非异步结果。
      if (!enableWorkspaceFeatures) {
        setGitStatusByPath(new Map());
        setGitStatusAvailable(false);
        return;
      }
      // [事务] 先自增再发请求，保证并发时后发起者序号更大。
      // [失败路径] 用旧值直接发请求，两个响应会互相覆盖。
      // [契约] `gitStatusRequestVersionRef` 的写入与读取都在这一处，外部不得直接操作。
      // [并发] 自增是同步的，中间不能 await。
      const requestVersion = gitStatusRequestVersionRef.current + 1;
      gitStatusRequestVersionRef.current = requestVersion;
      try {
        const gitStatus = await loadWorkspaceFileTreeGitStatus({
          gitService,
          workspacePath,
        });
        if (
          gitStatusRequestVersionRef.current !== requestVersion ||
          workspaceGenerationRef.current !== workspaceGeneration
        ) {
          return;
        }
        // [契约] available 与 statusByPath 必须同时写，不能只更新其一。
        // [失败路径] 只写映射不写标志会让筛选入口在 Git 不可用时仍然显示。
        // [事务] 两行之间不能插入 await，否则会渲染出中间态。
        setGitStatusAvailable(gitStatus.available);
        setGitStatusByPath(gitStatus.statusByPath);
      } catch (error) {
        if (
          gitStatusRequestVersionRef.current !== requestVersion ||
          workspaceGenerationRef.current !== workspaceGeneration
        ) {
          return;
        }
        const nextError = toError(error);
        logger.warn("[WorkspaceFileTree] 读取 Git 状态失败", {
          workspacePath,
          error: nextError.message,
        });
        // 修复：Git 状态读取异常时不能保留旧的变更过滤入口，否则用户会在过期状态下继续筛选文件树。
        setGitStatusAvailable(false);
        setGitStatusByPath(new Map());
      }
    },
    [enableWorkspaceFeatures, gitService, workspacePath],
  );

  // [契约] watcher 刷新只处理已监听目录，路径必须在 workspace 内。
  // [失败路径] 越界路径必须直接丢弃，不能让 watcher 事件驱动任意读取。
  // [事务] 刷新成功（loaded 或 stale）时一律不裁树。
  // [并发] 裁剪前要再校验 generation，等待期间可能已切换 workspace。
  const refreshDirectoryFromWatcher = useCallback(
    async (directoryPath: string, workspaceGeneration: number) => {
      if (workspaceGenerationRef.current !== workspaceGeneration) {
        return;
      }
      if (!isWorkspaceFilePathInside(workspacePath, directoryPath)) {
        return;
      }
      // [契约] 用 force 加 silent：绕过缓存但不打扰用户。
      // [失败路径] 不传 force 会被 loaded 短路，watcher 事件等于没发生。
      // [事务] 返回 stale 表示有更新的请求在跑，父目录也不能再动。
      // [并发] workspaceGeneration 必须透传，否则内部会拿当前值比较而误判。
      const refreshed = await loadDirectory(
        directoryPath,
        getWorkspaceFileDirectoryChildDepth(workspacePath, directoryPath),
        { force: true, silent: true, workspaceGeneration },
      );
      if (refreshed === "loaded" || refreshed === "stale") {
        return;
      }
      if (workspaceGenerationRef.current !== workspaceGeneration) {
        return;
      }
      // 被监听目录被删除或重命名时先裁掉旧 subtree，再刷新父目录。
      // [事务] 只有 failed 才走到这里：目录被删或改名时先裁旧子树。
      // [失败路径] 顺序必须是先裁子树再刷父目录，反了父目录会重新读到旧 children。
      // [契约] 父目录不存在时到此为止，根目录不做特殊处理。
      pruneDirectorySubtree(directoryPath);
      const parentDirectoryPath = getWorkspaceFileParentDirectory(workspacePath, directoryPath);
      if (parentDirectoryPath) {
        await loadDirectory(
          parentDirectoryPath,
          getWorkspaceFileDirectoryChildDepth(workspacePath, parentDirectoryPath),
          { force: true, silent: true, workspaceGeneration },
        );
      }
    },
    [loadDirectory, pruneDirectorySubtree, workspacePath],
  );

  // [契约] 手动刷新只重读目录并记错误，绝不裁子树。
  // [失败路径] 复用 watcher 的裁剪逻辑会把网络抖动当成目录删除，清空旧树。
  // [事务] 失败时先 invalidate 再写 error，防止在途旧请求把错误覆盖掉。
  // [资源] 每次调用都套超时，避免远程断连时按钮永久转圈。
  const refreshDirectoryManually = useCallback(
    async (directoryPath: string, workspaceGeneration: number) => {
      if (workspaceGenerationRef.current !== workspaceGeneration) {
        return;
      }
      if (!isWorkspaceFilePathInside(workspacePath, directoryPath)) {
        return;
      }
      // 手动刷新里的 readdir 失败通常是远程断连、权限或临时 I/O 错误；
      // 失败不等价于目录被删除，不能复用 watcher 的 subtree 裁剪逻辑，否则会清空旧树和错误状态。
      try {
        await withWorkspaceFileTreeTimeout(
          loadDirectory(
            directoryPath,
            getWorkspaceFileDirectoryChildDepth(workspacePath, directoryPath),
            { force: true, silent: true, workspaceGeneration },
          ),
          WORKSPACE_FILE_TREE_REFRESH_DIRECTORY_TIMEOUT_MS,
          `workspace file tree refresh ${directoryPath}`,
        );
      } catch (error) {
        if (workspaceGenerationRef.current !== workspaceGeneration) {
          return;
        }
        invalidateDirectoryRequest(directoryPath);
        const nextError = toError(error);
        logger.warn("[WorkspaceFileTree] 手动刷新目录超时或失败", {
          path: directoryPath,
          error: nextError.message,
        });
        setErrorByDirectory((current) => {
          const next = new Map(current);
          next.set(directoryPath, nextError);
          return next;
        });
      }
    },
    [invalidateDirectoryRequest, loadDirectory, workspacePath],
  );

  // [契约] 并发刷新只做调度，不持有任何 state。
  // [并发] 队列先去重，避免同一目录在一轮里被刷新多次。
  // [失败路径] 用 allSettled 而不是 all：单个目录失败不能中断其余目录。
  // [事务] 批次号与 generation 在每个 worker 循环里都要重查。
  const refreshDirectoryPaths = useCallback(
    async (
      directoryPaths: string[],
      workspaceGeneration: number,
      refreshBatchVersion: number,
      refreshDirectory: (directoryPath: string, workspaceGeneration: number) => Promise<void>,
    ) => {
      const queue = [...new Set(directoryPaths)];
      const workerCount = Math.min(WORKSPACE_FILE_TREE_WATCH_REFRESH_CONCURRENCY, queue.length);
      // [并发] while 条件每轮重查 generation 与批次号，这是中断旧批次的唯一位置。
      // [失败路径] 把条件提到循环外会让切换 workspace 后继续读旧目录。
      // [契约] shift 返回 undefined 时静默跳过，队列可能被其它 worker 取空。
      // [事务] 单个目录失败由 refreshDirectory 内部消化，worker 继续消费。
      const runWorker = async () => {
        while (
          queue.length > 0 &&
          workspaceGenerationRef.current === workspaceGeneration &&
          refreshBatchVersionRef.current === refreshBatchVersion
        ) {
          const directoryPath = queue.shift();
          if (directoryPath) {
            await refreshDirectory(directoryPath, workspaceGeneration);
          }
        }
      };

      // [并发] workerCount 取并发上限与队列长度的较小值，队列为空时不启动 worker。
      // [失败路径] 用 all 会让第一个 reject 提前返回，其它目录仍在后台写 state。
      // [契约] worker 永远不 reject：错误已在 refreshDirectory 内部处理。
      await Promise.allSettled(Array.from({ length: workerCount }, runWorker));
    },
    [],
  );

  // [契约] 手动刷新入口：只刷已加载或已展开目录，不做全仓递归扫描。
  // [事务] 批次号先自增再置标志，保证旧批次立刻失效。
  // [失败路径] 防重入检查必须在自增之前，否则并发点击会各自生成新批次。
  // [权衡] 刷新范围由 getWorkspaceFileTreeRefreshDirectoryPaths 决定，不在这里展开。
  const refreshLoadedDirectories = useCallback(async () => {
    if (refreshingLoadedDirectoriesRef.current) {
      return;
    }
    const workspaceGeneration = workspaceGenerationRef.current;
    const refreshBatchVersion = refreshBatchVersionRef.current + 1;
    refreshBatchVersionRef.current = refreshBatchVersion;
    refreshingLoadedDirectoriesRef.current = true;
    setRefreshingLoadedDirectories(true);
    const directoryPaths = getWorkspaceFileTreeRefreshDirectoryPaths({
      workspacePath,
      expandedPaths,
      loadedDirectoryPaths: loadedDirectoryPathsRef.current,
    });
    // 手动刷新文件树过去只重读 workspace 根目录，已加载子目录仍沿用旧 children 缓存；
    // AI 重命名/新增文件发生在这些子目录时，旧路径会继续显示，新文件也不会出现。
    // 这里刷新所有已加载或已展开目录，不做全仓递归扫描，避免大仓库刷新成本失控。
    try {
      await refreshDirectoryPaths(
        directoryPaths,
        workspaceGeneration,
        refreshBatchVersion,
        refreshDirectoryManually,
      );
      // 用户可能在手动刷新旧 workspace 期间切换 workspace；
      // 旧刷新完成后不能再用旧 gitService 覆盖新 workspace 的 Git 状态。
      if (
        workspaceGenerationRef.current === workspaceGeneration &&
        refreshBatchVersionRef.current === refreshBatchVersion
      ) {
        try {
          await withWorkspaceFileTreeTimeout(
            loadGitStatus({ workspaceGeneration }),
            WORKSPACE_FILE_TREE_REFRESH_GIT_TIMEOUT_MS,
            "workspace file tree git refresh",
          );
        } catch (error) {
          if (
            workspaceGenerationRef.current === workspaceGeneration &&
            refreshBatchVersionRef.current === refreshBatchVersion
          ) {
            gitStatusRequestVersionRef.current += 1;
            const nextError = toError(error);
            logger.warn("[WorkspaceFileTree] 手动刷新 Git 状态超时或失败", {
              workspacePath,
              error: nextError.message,
            });
          }
        }
      }
    } finally {
      if (
        workspaceGenerationRef.current === workspaceGeneration &&
        refreshBatchVersionRef.current === refreshBatchVersion
      ) {
        refreshingLoadedDirectoriesRef.current = false;
        setRefreshingLoadedDirectories(false);
      }
    }
  }, [
    expandedPaths,
    loadGitStatus,
    refreshDirectoryManually,
    refreshDirectoryPaths,
    workspacePath,
  ]);

  // [事务] 先取出并清空积压集合，再开始刷新，防止处理期间的事件被丢弃。
  // [契约] 批次号在这里快照，后续 finally 用它判断是否还属于本轮。
  // [失败路径] 不校验批次直接 loadGitStatus，会把旧 workspace 的 Git 状态写进新树。
  // [并发] 这里的刷新失败不影响手动刷新，两条链路互相独立。
  const flushWatchRefreshQueue = useCallback(() => {
    const changedDirectoryPaths = [...pendingWatchRefreshPathsRef.current];
    pendingWatchRefreshPathsRef.current = new Set();
    if (changedDirectoryPaths.length === 0) {
      return;
    }
    const refreshPaths =
      changedDirectoryPaths.length > WORKSPACE_FILE_TREE_WATCH_BULK_REFRESH_THRESHOLD
        ? [workspacePath, ...expandedPaths]
        : changedDirectoryPaths;
    const workspaceGeneration = workspaceGenerationRef.current;
    const refreshBatchVersion = refreshBatchVersionRef.current;
    void refreshDirectoryPaths(
      refreshPaths,
      workspaceGeneration,
      refreshBatchVersion,
      refreshDirectoryFromWatcher,
    ).finally(() => {
      if (
        workspaceGenerationRef.current === workspaceGeneration &&
        refreshBatchVersionRef.current === refreshBatchVersion
      ) {
        void loadGitStatus({ workspaceGeneration });
      }
    });
  }, [
    expandedPaths,
    loadGitStatus,
    refreshDirectoryFromWatcher,
    refreshDirectoryPaths,
    workspacePath,
  ]);

  // [契约] 先做路径越界判断，非本 workspace 的事件直接丢弃。
  // [并发] 每次入队都重置 timer：这是 debounce 而不是节流。
  // [失败路径] 入队必须用 ref，若用 state 会在同一批事件里互相覆盖。
  // [事务] timer 触发时先把 ref 置空再 flush，避免 flush 内部的 await 影响下一次调度。
  const enqueueWatchRefresh = useCallback(
    (directoryPath: string) => {
      if (!isWorkspaceFilePathInside(workspacePath, directoryPath)) {
        return;
      }
      // [契约] 同一目录多次事件只保留一条，Set 保证幂等。
      // [失败路径] 不要在这里同时清 timer 并立即 flush，会退化成无 debounce。
      // [事务] 顺序是入队、清旧 timer、起新 timer，三步不能拆开。
      pendingWatchRefreshPathsRef.current.add(directoryPath);
      if (watchRefreshTimerRef.current) {
        clearTimeout(watchRefreshTimerRef.current);
      }
      watchRefreshTimerRef.current = setTimeout(() => {
        watchRefreshTimerRef.current = null;
        flushWatchRefreshQueue();
      }, WORKSPACE_FILE_TREE_WATCH_DEBOUNCE_MS);
    },
    [flushWatchRefreshQueue, workspacePath],
  );

  useEffect(() => {
    // [事务] 切换 workspace 时：先自增 generation，再自增 requestVersion。
    // [契约] 两次自增顺序不能反：generation 是外层条件，先立即可封住所有在途请求。
    // [失败路径] 只清 state 不推进版本，旧请求会在清空后把数据写回来。
    // [资源] 所有 ref 集合都要在此重置为全新实例，不能原地 clear 复用。
    workspaceGenerationRef.current += 1;
    const workspaceGeneration = workspaceGenerationRef.current;
    requestVersionRef.current += 1;
    cancelRefreshBatch();
    directoryRequestVersionRef.current = new Map();
    loadingDirectoryPathsRef.current = new Set();
    loadedDirectoryPathsRef.current = new Set();
    setChildrenByDirectory(new Map());
    setExpandedPaths(new Set());
    setLoadedDirectoryPaths(new Set());
    setLoadingDirectoryPaths(new Set());
    setErrorByDirectory(new Map());
    setGitStatusByPath(new Map());
    setGitStatusAvailable(false);
    setIgnoredPathSet(new Set());
    refreshingLoadedDirectoriesRef.current = false;
    setRefreshingLoadedDirectories(false);
    pendingWatchRefreshPathsRef.current = new Set();
    if (watchRefreshTimerRef.current) {
      clearTimeout(watchRefreshTimerRef.current);
      watchRefreshTimerRef.current = null;
    }
    // [契约] 初始加载根目录用 force，绕过短路，因为此时 loaded 集合已清空。
    // [事务] 必须传入本次 generation，不能让它读 ref：中间可能又被切换。
    // [失败路径] 不 await 但也不 catch，错误由 loadDirectory 内部写成目录错误态。
    // [并发] 根目录加载与 Git 状态加载并行发起，互不阻塞。
    void loadDirectory(workspacePath, 0, {
      force: true,
      workspaceGeneration,
    });
    void loadGitStatus({ workspaceGeneration });
    return () => {
      // 原因：卸载只释放 watcher 仍会留下排队刷新和迟到请求，关闭后不能继续读取旧工作区。
      workspaceGenerationRef.current += 1;
      requestVersionRef.current += 1;
      gitStatusRequestVersionRef.current += 1;
      cancelRefreshBatch();
      pendingWatchRefreshPathsRef.current.clear();
      if (watchRefreshTimerRef.current) {
        clearTimeout(watchRefreshTimerRef.current);
        watchRefreshTimerRef.current = null;
      }
    };
  }, [cancelRefreshBatch, loadDirectory, loadGitStatus, workspaceIdentity, workspacePath]);

  const rows = useWorkspaceFileTreeRows({
    workspacePath,
    childrenByDirectory,
    expandedPaths,
    loadedDirectoryPaths,
    loadingDirectoryPaths,
    errorByDirectory,
    gitStatusByPath,
  });

  // [契约] 监听范围是根目录加展开目录，与刷新范围同源。
  // [失败路径] 用 loaded 集合代替 expanded 会监听过多目录，触发大量无效刷新。
  // [权衡] Set 每次重建，依赖只有两个值，成本可接受。
  // [契约] 功能关闭时监听集合为空，交给下游 hook 处理，不在这里提前 return。
  const watchedDirectoryPaths = useMemo(
    () => new Set([workspacePath, ...expandedPaths]),
    [expandedPaths, workspacePath],
  );
  const effectiveWatchedDirectoryPaths = useMemo(
    () => (enableWorkspaceFeatures ? watchedDirectoryPaths : new Set<string>()),
    [enableWorkspaceFeatures, watchedDirectoryPaths],
  );

  // [契约] 监听 hook 只上报变更目录，刷新策略完全由本 hook 决定。
  // [失败路径] 不要在这里再包 debounce：enqueueWatchRefresh 已经做了。
  // [资源] 传空集合即停止监听，这是关闭功能时释放 watcher 的方式。
  // [依赖] fileWatcherService 由 useWorkspaceServices 注入，随 workspace 变化替换。
  useWorkspaceFileTreeWatchers({
    fileWatcherService,
    watchedDirectoryPaths: effectiveWatchedDirectoryPaths,
    onDirectoryChange: enqueueWatchRefresh,
  });

  return {
    rows,
    setExpandedPaths,
    loadedDirectoryPaths,
    loadingDirectoryPaths,
    errorByDirectory,
    gitStatusByPath,
    gitStatusAvailable,
    ignoredPathSet,
    refreshingLoadedDirectories,
    loadDirectory,
    loadGitStatus,
    refreshLoadedDirectories,
    setLoadedDirectoryPaths,
    loadedDirectoryPathsRef,
  };
}
