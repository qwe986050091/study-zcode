// INV-01 监听代际标识服务更替：守住位置 代数自增；改错故障 旧服务回调写入新表。
// INV-02 服务更换先释放全部监听：守住位置 循环释放；改错故障 旧监听泄漏到卸载。
// INV-03 已不在列表的目录立即释放：守住位置 差集遍历；改错故障 关闭的目录仍在监听。
// INV-04 在表或在途的目录跳过：守住位置 双重判断；改错故障 同一目录重复注册。
// INV-05 在途目录先登记再请求：守住位置 集合添加；改错故障 快速重渲染触发重复监听。
// INV-06 回调前验代际：守住位置 代数比较；改错故障 过期监听覆盖当前注册。
// INV-07 回调前验目录仍在列表：守住位置 集合判断；改错故障 已移除目录重新挂上。
// INV-08 过期结果立即退订：守住位置 早退退订；改错故障 后台残留无人释放的监听。
// INV-09 注册表记录退订函数：守住位置 闭包字段；改错故障 释放时拿不到标识。
// INV-10 失败分支清理在途标记：守住位置 首行删除；改错故障 失败的目录永远不再重试。
// INV-11 失败只告警不抛出：守住位置 捕获分支；改错故障 一个目录失败拖垮整棵树。
// INV-12 释放时先退订再等待：守住位置 语句顺序；改错故障 事件在退订前继续送达。
// INV-13 退订失败仅记录日志：守住位置 捕获分支；改错故障 卸载过程抛出未处理拒绝。
// INV-14 卸载时作废全部代际：守住位置 代数自增；改错故障 卸载后回调仍写状态。
// INV-15 卸载时清空两张表：守住位置 重新赋值；改错故障 下次挂载复用旧注册。
// INV-16 监听目录引用随渲染更新：守住位置 引用赋值；改错故障 回调读到旧目录集合。
// INV-17 效果依赖覆盖全部入参：守住位置 依赖数组；改错故障 换目录后监听不更新。
// INV-18 首轮效果不返回清理函数：守住位置 显式返回；改错故障 React 误当清理函数调用。
//
// 模块职责：把工作区目录集合同步成文件监听注册表。
// 状态所有权：注册表、在途表与代际全部保存在引用里。
// 阅读顺序：先看三张引用表，再看同步主体，最后看卸载清理。
import { useEffect, useRef } from "react";
import type { IFileWatcherService } from "@zcode/services";
import { logger } from "@/logger.js";
import type { WorkspaceFileTreeWatcherRegistration } from "@/workspace-file-tree/types.js";

// watcherRegistrationsRef 与 pendingWatcherDirectoryPathsRef 都以 ref 持有，跨渲染保持同一份表。
// fileWatcherService 实例变化时整表重建：先释放旧监听，再按新服务重新订阅。
// onDirectoryChange 与 watchedDirectoryPaths 由调用方提供，hook 不自持目录集合真值。
export function useWorkspaceFileTreeWatchers({
  fileWatcherService,
  watchedDirectoryPaths,
  onDirectoryChange,
}: {
  fileWatcherService: IFileWatcherService;
  watchedDirectoryPaths: Set<string>;
  onDirectoryChange: (path: string) => void;
}) {
  const fileWatcherServiceRef = useRef(fileWatcherService);
  const watcherGenerationRef = useRef(0);
  const watchedDirectoryPathsRef = useRef<Set<string>>(new Set());
  const watcherRegistrationsRef = useRef<Map<string, WorkspaceFileTreeWatcherRegistration>>(
    new Map(),
  );
  const pendingWatcherDirectoryPathsRef = useRef<Set<string>>(new Set());

  // effect 入口先释放全部旧监听，服务更换后不留下指向已销毁实例的订阅。
  // 已移出 watchedDirectoryPaths 的目录立即 releaseWatcherRegistration 释放。
  // 已登记在 watcherRegistrationsRef 或 pendingWatcherDirectoryPathsRef 中的目录跳过，避免重复订阅。
  useEffect(() => {
    const releaseWatcherRegistration = (
      directoryPath: string,
      registration: WorkspaceFileTreeWatcherRegistration,
    ) => {
      registration.subscription.dispose();
      void registration.unwatch().catch((error) => {
        logger.warn("[WorkspaceFileTree] 停止监听目录失败", {
          path: directoryPath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };

    // 服务实例变化时 watcherGenerationRef 自增，旧代际的回调据此作废。
    // 换代时同时清空 watcherRegistrationsRef 与 pendingWatcherDirectoryPathsRef 两张表。
    // 新服务写入 fileWatcherServiceRef，供后续代际判断比对。
    if (fileWatcherServiceRef.current !== fileWatcherService) {
      watcherGenerationRef.current += 1;
      for (const [directoryPath, registration] of watcherRegistrationsRef.current) {
        releaseWatcherRegistration(directoryPath, registration);
      }
      watcherRegistrationsRef.current = new Map();
      pendingWatcherDirectoryPathsRef.current = new Set();
      fileWatcherServiceRef.current = fileWatcherService;
    }

    watchedDirectoryPathsRef.current = watchedDirectoryPaths;

    for (const [directoryPath, registration] of watcherRegistrationsRef.current) {
      if (!watchedDirectoryPaths.has(directoryPath)) {
        watcherRegistrationsRef.current.delete(directoryPath);
        releaseWatcherRegistration(directoryPath, registration);
      }
    }

    for (const directoryPath of watchedDirectoryPaths) {
      if (
        watcherRegistrationsRef.current.has(directoryPath) ||
        pendingWatcherDirectoryPathsRef.current.has(directoryPath)
      ) {
        continue;
      }

      pendingWatcherDirectoryPathsRef.current.add(directoryPath);
      const watcherGeneration = watcherGenerationRef.current;
      void fileWatcherService
        .watch({ path: directoryPath })
        .then(({ id }) => {
          pendingWatcherDirectoryPathsRef.current.delete(directoryPath);
          if (
            watcherGeneration !== watcherGenerationRef.current ||
            !watchedDirectoryPathsRef.current.has(directoryPath)
          ) {
            void fileWatcherService.unwatch({ id });
            return;
          }

          const subscription = fileWatcherService.onDynamicChange(id)((event) => {
            onDirectoryChange(event.dirPath);
          });
          watcherRegistrationsRef.current.set(directoryPath, {
            id,
            subscription,
            unwatch: () => fileWatcherService.unwatch({ id }),
          });
        })
        .catch((error) => {
          pendingWatcherDirectoryPathsRef.current.delete(directoryPath);
          logger.warn("[WorkspaceFileTree] 监听目录失败", {
            path: directoryPath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    return undefined;
  }, [fileWatcherService, onDirectoryChange, watchedDirectoryPaths]);

  // 卸载清理先自增 watcherGenerationRef，使在途回调不再落地。
  // 随后重置 pendingWatcherDirectoryPathsRef 与注册表两张 ref，逐个 dispose 已登记订阅。
  // unwatch 失败由 catch 记 logger.warn，不阻断剩余目录的释放。
  useEffect(
    () => () => {
      watcherGenerationRef.current += 1;
      pendingWatcherDirectoryPathsRef.current = new Set();
      for (const [directoryPath, registration] of watcherRegistrationsRef.current) {
        registration.subscription.dispose();
        void registration.unwatch().catch((error) => {
          logger.warn("[WorkspaceFileTree] 停止监听目录失败", {
            path: directoryPath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      watcherRegistrationsRef.current = new Map();
      watchedDirectoryPathsRef.current = new Set();
    },
    [],
  );
}
