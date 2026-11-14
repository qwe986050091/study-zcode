// INV-01 刷新延迟一分钟：守住位置 常量；改错故障 批量写文件触发风暴。
// INV-02 延迟内重复事件合并：守住位置 清理旧定时器；改错故障 多次刷新。
// INV-03 回调走引用：守住位置 引用赋值；改错故障 旧闭包读到过期工作区。
// INV-04 工作区键优先身份：守住位置 空值回退；改错故障 同路径不同身份串台。
// INV-05 不可监听时清空路径：守住位置 条件构造；改错故障 仍在旧工作区监听。
// INV-06 路径签名按内容比较：守住位置 序列化；改错故障 引用变化重建监听。
// INV-07 签名依赖显式列出：守住位置 依赖数组；改错故障 摘要更新不重算。
// INV-08 平台信息按服务身份归属：守住位置 服务相等判断；改错故障 旧平台泄漏。
// INV-09 平台读取失败静默：守住位置 捕获；改错故障 弹错误提示。
// INV-10 仅仓库可用才监听：守住位置 三条件；改错故障 非仓库也建监听。
// INV-11 注册前判取消：守住位置 取消标志；改错故障 卸载后仍注册。
// INV-12 取消时立即退订：守住位置 分支；改错故障 监听泄漏。
// INV-13 监听失败只告警：守住位置 捕获分支；改错故障 自动刷新拖垮手动链路。
// INV-14 清理先停定时器：守住位置 顺序；改错故障 卸载后仍刷新。
// INV-15 清理逐个退订：守住位置 遍历；改错故障 残留订阅。
// INV-16 退订失败告警：守住位置 捕获；改错故障 静默泄漏。
// INV-17 事件路径只用于日志：守住位置 参数；改错故障 误按文件过滤。
// INV-18 钩子无返回值：守住位置 签名；改错故障 调用方误以为可控。
//
// 模块职责：监听 Git 工作区变化并延迟触发状态刷新。
// 状态所有权：Git 摘要归上层，本钩子只持监听注册与定时器。
// 阅读顺序：先看监听路径构造，再看刷新调度，最后看清理。
import { useEffect, useMemo, useRef, useState } from "react";
import type { IDisposable } from "@zcode/rpc";
import type { GitRepositorySummary } from "@zcode/shared";
import {
  buildGitAutoRefreshWatchPaths,
  parseGitAutoRefreshWatchPaths,
  shouldEnableGitAutoRefreshForWorkspace,
  stringifyGitAutoRefreshWatchPaths,
} from "@/lib/gitAutoRefresh.js";
import { logger } from "@/logger.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

// agent 批量写文件时，150ms watcher 防抖 + 350ms Git 防抖仍会把长批次拆成多轮
// `git status`。这里把 Git 自动刷新延后到 1 分钟，降低大工作区里的重复 Git I/O。
const GIT_AUTO_REFRESH_DEBOUNCE_MS = 60_000;

interface GitWatcherRegistration {
  subscription: IDisposable;
  unwatch: () => Promise<void>;
}

// useWorkspaceServices 按 workspacePath 与 remoteSessionId 解析服务，远程工作区拿到的是远端 Host。
// onRefreshGit 存进 refreshRef，监听回调始终调用最新引用而非闭包快照。
// currentWorkspaceKey 取 workspaceIdentity 去空后的值，为空才回退 workspacePath。
// canWatchCurrentWorkspace 由 shouldEnableGitAutoRefreshForWorkspace 判定，条件不全即不注册监听。
// 钩子不返回值，调用方只依赖副作用。
export function useGitAutoRefresh({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  gitSummary,
  gitSummaryWorkspaceKey,
  enabled,
  onRefreshGit,
}: {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  gitSummary: GitRepositorySummary;
  gitSummaryWorkspaceKey: string;
  enabled: boolean;
  onRefreshGit: () => void;
}) {
  const workspaceServices = useWorkspaceServices(workspacePath, remoteSessionId, workspaceIdentity);
  const { fileWatcherService, systemService } = workspaceServices;
  const refreshRef = useRef(onRefreshGit);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentWorkspaceKey = workspaceIdentity?.trim() || workspacePath;
  const canWatchCurrentWorkspace = shouldEnableGitAutoRefreshForWorkspace({
    enabled,
    currentWorkspaceKey,
    summaryWorkspaceKey: gitSummaryWorkspaceKey,
  });
  const [workspacePlatformState, setWorkspacePlatformState] = useState<{
    service: typeof systemService;
    platform: string;
  } | null>(null);
  // workspaceScopedServices 在远程 workspace 下指向远端 Host，因此这里获取的是
  // WSL/SSH/Docker 的真实运行平台，而不是桌面应用本身的平台。service identity
  // 参与状态匹配，避免 Windows workspace 的旧 platform 泄漏到刚切换的 Linux workspace。
  const workspacePlatform =
    workspacePlatformState?.service === systemService ? workspacePlatformState.platform : null;
  useEffect(() => {
    if (!canWatchCurrentWorkspace || !gitSummary.isGitAvailable || !gitSummary.isRepository) {
      return;
    }

    let cancelled = false;
    void systemService
      .info()
      .then((info) => {
        if (!cancelled) {
          setWorkspacePlatformState({ service: systemService, platform: info.platform });
        }
      })
      .catch(() => {
        // 平台信息不可用时由路径构造器采用 metadata-only 保守策略；手动刷新链路不受影响。
      });

    return () => {
      cancelled = true;
    };
  }, [canWatchCurrentWorkspace, gitSummary.isGitAvailable, gitSummary.isRepository, systemService]);
  // 不可监听时把空数组交给 stringifyGitAutoRefreshWatchPaths，签名退化为空列表。
  // workspacePlatform 为 null 时 buildGitAutoRefreshWatchPaths 走 metadata-only 保守策略。
  // 依赖数组逐个列出 gitSummary 的字段，不写整个对象。
  // watchPathSignature 只在内容变化时改变，同内容不同引用得到同一字符串。
  // 签名稳定使下游 useMemo 不重算，避免重建 fileWatcherService 监听。
  const watchPathSignature = useMemo(
    () =>
      stringifyGitAutoRefreshWatchPaths(
        canWatchCurrentWorkspace
          ? buildGitAutoRefreshWatchPaths(
              gitSummary,
              workspacePlatform ? { platform: workspacePlatform } : null,
            )
          : [],
      ),
    [
      canWatchCurrentWorkspace,
      gitSummary.isGitAvailable,
      gitSummary.isRepository,
      gitSummary.repoRoot,
      gitSummary.workspacePath,
      gitSummary.autoRefreshWatchPaths,
      workspacePlatform,
    ],
  );
  // watchPaths 由 parseGitAutoRefreshWatchPaths 从签名反序列化，不重新读 gitSummary。
  // 解析结果包在 useMemo 里，签名不变就复用同一数组引用。
  // 只有 watchPathSignature 变化才重算，平台切换会走到这里。
  // 该数组供下面的 fileWatcherService.watch 循环注册使用。
  const watchPaths = useMemo(
    () => parseGitAutoRefreshWatchPaths(watchPathSignature),
    [watchPathSignature],
  );

  refreshRef.current = onRefreshGit;

  useEffect(() => {
    let cancelled = false;
    const registrations: GitWatcherRegistration[] = [];

    // scheduleRefresh 先 clearTimeout 旧的 debounceTimerRef，合并批量写文件的事件。
    // 新定时器统一用 GIT_AUTO_REFRESH_DEBOUNCE_MS 延迟，默认一分钟。
    // 到点先把 debounceTimerRef 置空，再执行刷新逻辑。
    // logger.debug 记下 workspacePath 与 path 后才调 refreshRef.current。
    const scheduleRefresh = (path: string) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        logger.debug("[GitAutoRefresh] Git 状态变更，刷新仓库状态", {
          workspacePath,
          path,
        });
        refreshRef.current();
      }, GIT_AUTO_REFRESH_DEBOUNCE_MS);
    };

    // Git summary 每次刷新都会带回新的 autoRefreshWatchPaths 数组引用。
    // 监听路径内容没变时不能重建 watcher，否则 agent 批量写文件会出现 unwatch/watch 风暴。
    for (const watchPath of watchPaths) {
      void fileWatcherService
        .watch({
          path: watchPath.path,
          recursive: watchPath.recursive,
        })
        .then(({ id }) => {
          if (cancelled) {
            void fileWatcherService.unwatch({ id });
            return;
          }

          const subscription = fileWatcherService.onDynamicChange(id)((event) => {
            scheduleRefresh(event.dirPath);
          });
          registrations.push({
            subscription,
            unwatch: () => fileWatcherService.unwatch({ id }),
          });
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }
          // Git 实时刷新只是加速 UI 状态同步；监听失败时保留原有手动刷新和操作后刷新链路。
          logger.warn("[GitAutoRefresh] 监听 Git 工作区失败", {
            workspacePath,
            path: watchPath.path,
            recursive: watchPath.recursive,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    return () => {
      cancelled = true;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      for (const registration of registrations) {
        registration.subscription.dispose();
        void registration.unwatch().catch((error) => {
          logger.warn("[GitAutoRefresh] 停止监听 Git 工作区失败", {
            workspacePath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    };
  }, [fileWatcherService, watchPaths, workspacePath]);
}
