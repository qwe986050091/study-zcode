// INV-01 路径比较前统一分隔符：守住位置 归一函数；改错故障 反斜杠导致漏判。
// INV-02 盘符与网络路径忽略大小写：守住位置 正则判断；改错故障 大小写差异误刷新。
// INV-03 无变更路径视为命中：守住位置 空值分支；改错故障 目录级事件被丢弃。
// INV-04 状态带文件与服务双标识：守住位置 快照字段；改错故障 换服务沿用旧就绪态。
// INV-05 路径变化先重置状态：守住位置 副作用开头；改错故障 切换文件仍显示旧预览。
// INV-06 无文件即不就绪：守住位置 空值早退；改错故障 空路径被当成可读。
// INV-07 无目录即视为就绪：守住位置 空值分支；改错故障 根路径永远等待。
// INV-08 注册失败仍就绪：守住位置 捕获分支；改错故障 监听不可用阻断预览。
// INV-09 注册竞态需回收：守住位置 已取消判断；改错故障 泄漏一个目录监听。
// INV-10 订阅只处理目标文件：守住位置 过滤函数；改错故障 同目录其他文件触发刷新。
// INV-11 刷新按代数自增：守住位置 计数更新；改错故障 依赖方无法感知新内容。
// INV-12 就绪态归属当前服务：守住位置 双重相等判断；改错故障 旧服务状态泄漏。
// INV-13 卸载先取消标记：守住位置 清理函数；改错故障 迟到的注册仍写状态。
// INV-14 卸载释放订阅：守住位置 销毁调用；改错故障 事件回调继续执行。
// INV-15 卸载停止监听：守住位置 调用点；改错故障 目录监听残留。
// INV-16 停止失败只告警：守住位置 捕获分支；改错故障 关闭页签抛错。
// INV-17 依赖只含文件与服务：守住位置 依赖数组；改错故障 每次渲染重建监听。
// INV-18 返回值永远完整：守住位置 末尾三元；改错故障 调用方读到未定义。
//
// 模块职责：PPTX 预览对源文件变化的监听与刷新代数。
// 状态所有权：快照归本 hook，监听与订阅生命周期绑定副作用。
// 阅读顺序：先看路径归一与事件判定，再看监听注册，最后看返回值隔离。
import { useEffect, useState } from "react";
import type { IDisposable } from "@zcode/rpc";
import type { IFileWatcherService } from "@zcode/services";
import type { FileWatchEvent } from "@zcode/shared";
import { logger } from "@/logger.js";
import { getContainingDirectoryPath } from "@/lib/path.js";

interface PptxFileWatchSnapshot {
  filePath: string | null;
  fileWatcherService: IFileWatcherService | null;
  ready: boolean;
  reloadGeneration: number;
}

// normalizeFileWatchPathForCompare 先对 path 做 trim。
// 反斜杠统一替换成斜杠，消除 Windows 分隔符差异。
// replace 去掉尾部一个或多个斜杠。
// 盘符与网络路径用 toLowerCase 转小写。
// 其余路径不做 toLowerCase，保持原样。
function normalizeFileWatchPathForCompare(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

// event.changedPath 为空即视为命中。
// 两侧路径都先经 normalizeFileWatchPathForCompare 归一。
// 归一后逐字相等才返回 true。
// 目录级 FileWatchEvent 不区分具体文件，按命中处理。
// 只比较 normalizeFileWatchPathForCompare 的结果，不读取文件内容。
export function shouldReloadPptxPreviewForWatchEvent(
  event: FileWatchEvent,
  filePath: string,
): boolean {
  if (!event.changedPath) {
    return true;
  }
  return (
    normalizeFileWatchPathForCompare(event.changedPath) ===
    normalizeFileWatchPathForCompare(filePath)
  );
}

// snapshot 带 filePath 与 fileWatcherService 双标识。
// filePath 变化时先 setSnapshot 重置 ready。
// filePath 为空时 ready 保持 false。
// getContainingDirectoryPath 返回空时直接标 ready。
// useEffect 依赖只有 filePath 与 fileWatcherService。
export function usePptxFileWatch({
  filePath,
  fileWatcherService,
}: {
  filePath: string | null;
  fileWatcherService: IFileWatcherService;
}): { ready: boolean; reloadGeneration: number } {
  const [snapshot, setSnapshot] = useState<PptxFileWatchSnapshot>({
    filePath: null,
    fileWatcherService: null,
    ready: false,
    reloadGeneration: 0,
  });

  useEffect(() => {
    let cancelled = false;
    let watcherId: string | null = null;
    let subscription: IDisposable | null = null;

    setSnapshot({
      filePath,
      fileWatcherService,
      ready: false,
      reloadGeneration: 0,
    });
    // watch 成功后把 id 记进 watcherId。
    // onDynamicChange 的事件按 shouldReloadPptxPreviewForWatchEvent 过滤。
    // 刷新只把 reloadGeneration 加一。
    // watch 失败时 catch 里仍把 ready 置为 true。
    // 取消后 unwatch 立即回收监听。
    if (!filePath) {
      return () => {
        cancelled = true;
      };
    }

    const directoryPath = getContainingDirectoryPath(filePath);
    if (!directoryPath) {
      setSnapshot({
        filePath,
        fileWatcherService,
        ready: true,
        reloadGeneration: 0,
      });
      return () => {
        cancelled = true;
      };
    }

    void fileWatcherService
      .watch({ path: directoryPath })
      .then(({ id }) => {
        if (cancelled) {
          void fileWatcherService.unwatch({ id });
          return;
        }
        watcherId = id;
        subscription = fileWatcherService.onDynamicChange(id)((event) => {
          if (!shouldReloadPptxPreviewForWatchEvent(event, filePath)) {
            return;
          }
          logger.debug("[PptxFileWatch] 源文件发生变化，刷新已打开预览", {
            path: filePath,
            changedPath: event.changedPath,
          });
          setSnapshot((current) =>
            current.filePath === filePath &&
            current.fileWatcherService === fileWatcherService
              ? {
                  ...current,
                  ready: true,
                  reloadGeneration: current.reloadGeneration + 1,
                }
              : current,
          );
        });
        setSnapshot((current) =>
          current.filePath === filePath &&
          current.fileWatcherService === fileWatcherService
            ? { ...current, ready: true }
            : current,
        );
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        // 文件监听只负责自动刷新；注册失败时仍允许首次读取和手动重新打开文件。
        logger.warn("[PptxFileWatch] 监听 PPTX 所在目录失败", {
          path: filePath,
          directoryPath,
          error: error instanceof Error ? error.message : String(error),
        });
        setSnapshot((current) =>
          current.filePath === filePath &&
          current.fileWatcherService === fileWatcherService
            ? { ...current, ready: true }
            : current,
        );
      });

    return () => {
      cancelled = true;
      subscription?.dispose();
      if (watcherId) {
        void fileWatcherService
          .unwatch({ id: watcherId })
          .catch((error: unknown) => {
            logger.warn("[PptxFileWatch] 停止监听 PPTX 所在目录失败", {
              path: filePath,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
    };
  }, [filePath, fileWatcherService]);

  // 远程重连或 Host 替换会在 source path 不变时切换 workspace service。
  // ready 必须属于当前 watcher service，不能在 effect 清理前复用旧 service 的订阅状态。
  return snapshot.filePath === filePath &&
    snapshot.fileWatcherService === fileWatcherService
    ? {
        ready: snapshot.ready,
        reloadGeneration: snapshot.reloadGeneration,
      }
    : { ready: false, reloadGeneration: 0 };
}
