// 文件监听服务：基于 node:fs.watch 提供按目录的变更订阅，
// 向上层投递「目录级 + 可选单文件精确路径」的 FileWatchEvent。
// fs.watch 在各平台会合并、丢失或乱序投递事件，批量操作（git checkout、
// 批量保存）还会产生大量重复通知，因此这里用「防抖窗口 + 路径集合」
// 把一批事件压缩成一次刷新信号，调用方须按「该目录可能已变化」理解。
import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { Emitter, Event, type Event as RpcEvent } from "@zcode/rpc";
import type { FileWatchEvent } from "@zcode/shared";
import {
  createServiceLogger,
  type ServiceLogger,
} from "#src/logger/serviceLogger.js";
import type { IFileWatcherService } from "./fileWatcher.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

/** 防抖时间（ms）——批量文件变更（如 git checkout）时避免频繁刷新 */
const DEBOUNCE_MS = 150;

// 每个 watch() 对应一个独立实例，防抖计时器与路径集合都挂在实例上，
// 不同目录之间互不干扰。
// watchers Map 是唯一所有者：事件回调、cleanup、onDynamicChange 均按 id 查表，
// 因此 cleanup 之后迟到的回调查不到实例即被丢弃，清理因此是幂等的。
interface WatcherInstance {
  path: string;
  watcher: FSWatcher;
  changeEmitter: Emitter<FileWatchEvent>;
  /** 防抖定时器 */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** 同一防抖窗口只含一个明确路径时才透传，避免过滤掉同批次里的目标文件事件 */
  pendingChangedPaths: Set<string>;
  hasUnknownChangedPath: boolean;
}

// 归一化 fs.watch 提供的 fileName：Windows 上可能是 Buffer，
// 也可能为空串（部分平台/递归模式不提供文件名）。
// 返回基于 dirPath 的绝对路径，便于上层与自身基准做精确匹配；
// null 与空串都返回 undefined，由调用方退化为目录级变更语义。
export function resolveFileWatchChangedPath(
  watchedDirectoryPath: string,
  fileName: string | Buffer | null,
): string | undefined {
  if (fileName === null) {
    return undefined;
  }
  const normalizedFileName = fileName.toString().trim();
  return normalizedFileName ? resolve(watchedDirectoryPath, normalizedFileName) : undefined;
}

// 工厂而非 class：watchers、自增 id、诊断提供器都封装在闭包内，
// 每个实例互相独立，便于测试注入 logger 而不共享全局状态。
// 对外方法统一为 async 契约，其中建立监听失败会抛出中文错误信息。
export function createFileWatcherService(options?: {
  logger?: ServiceLogger;
}): IFileWatcherService {
  const log = options?.logger ?? createServiceLogger("file-watcher");
  const watchers = new Map<string, WatcherInstance>();
  let nextId = 0;
  // 内存诊断计数器：客户端断连不回收 watcher 时
  // 这里会只增不减。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("fileWatcher", () => ({
    open: watchers.size,
  }));

  // 统一清理入口：先取消防抖计时器，再关闭 watcher 并销毁 emitter，
  // 保证清理之后不再有新事件，也避免计时器在 close 之后回调造成重复 fire。
  // 清理由 error 回调、unwatch、disposeAll 共享，因此必须幂等且不抛错。
  function cleanup(id: string): void {
    const w = watchers.get(id);
    if (!w) return;
    if (w.debounceTimer) clearTimeout(w.debounceTimer);
    w.watcher.close();
    w.changeEmitter.dispose();
    watchers.delete(id);
  }

  return {
    // 注册流程：先建立 fs.watch，成功后才写入 watchers；失败时仅销毁 emitter，
    // 不留下悬挂实例，调用方也拿不到 id（异常向上抛，由 RPC 层转成错误响应）。
    // 回调内按 id 反查实例而非闭包直接持有，是为了让 cleanup 之后迟到的事件失效——
    // 平台实现可能在 close 之后仍投递最后一次通知。
    async watch(params: { path: string; recursive?: boolean }): Promise<{ id: string }> {
      const id = String(nextId++);
      const changeEmitter = new Emitter<FileWatchEvent>();
      const recursive = params.recursive ?? false;

      let fsWatcher: FSWatcher;
      try {
        // 默认非递归监视单个目录；Git 状态这类工作区级信号会显式打开 recursive。
        fsWatcher = watch(params.path, { recursive }, (_eventType, fileName) => {
          const instance = watchers.get(id);
          if (!instance) return;

          const changedPath = resolveFileWatchChangedPath(instance.path, fileName);
          if (changedPath) {
            instance.pendingChangedPaths.add(changedPath);
          } else {
            instance.hasUnknownChangedPath = true;
          }

          // 每个事件都重置计时窗口：窗口内的变更合并为一次 fire，
          // 最后一个事件之后静默 DEBOUNCE_MS 才通知，避免中途刷新读到半完成的批量操作。
          // 计时器挂在实例上（而非局部变量），确保 cleanup 能取消尚未触发的通知。
          // 防抖：连续变更只触发一次刷新
          if (instance.debounceTimer) clearTimeout(instance.debounceTimer);
          instance.debounceTimer = setTimeout(() => {
            instance.debounceTimer = null;
            const onlyChangedPath =
              !instance.hasUnknownChangedPath && instance.pendingChangedPaths.size === 1
                ? instance.pendingChangedPaths.values().next().value
                : undefined;
            instance.pendingChangedPaths.clear();
            instance.hasUnknownChangedPath = false;
            instance.changeEmitter.fire({
              dirPath: instance.path,
              ...(onlyChangedPath ? { changedPath: onlyChangedPath } : {}),
            });
          }, DEBOUNCE_MS);
        });
      } catch (error) {
        changeEmitter.dispose();
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`无法监视目录 '${params.path}': ${message}`);
      }

      // 监视目录被删除/重命名时，发送最终事件并清理
      // error 事件通常意味着底层句柄已失效（目录删除、重命名、监听配额耗尽），
      // 此后不会再有有效事件，因此先补发一次目录级事件让上层刷新，
      // 再立即清理实例；清理后 onDynamicChange 会退化为 Event.None。
      fsWatcher.on("error", (error) => {
        const instance = watchers.get(id);
        if (instance) {
          log.warn(undefined, "文件监听器异常，清理 watcher", {
            id,
            path: instance.path,
            error: error instanceof Error ? error.message : String(error),
          });
          instance.changeEmitter.fire({ dirPath: instance.path });
          cleanup(id);
        }
      });

      watchers.set(id, {
        path: params.path,
        watcher: fsWatcher,
        changeEmitter,
        debounceTimer: null,
        pendingChangedPaths: new Set(),
        hasUnknownChangedPath: false,
      });

      return { id };
    },

    async unwatch(params: { id: string }): Promise<void> {
      cleanup(params.id);
    },

    disposeAll(): void {
      memoryDiagnostics.dispose();
      const ids = Array.from(watchers.keys());
      for (const id of ids) {
        cleanup(id);
      }
    },

    onDynamicChange(id: string): RpcEvent<FileWatchEvent> {
      const watcher = watchers.get(id);
      if (!watcher) {
        // watch() 成功返回后，renderer 订阅 onDynamicChange 前，底层 fs.watch
        // 仍可能因目录删除/重命名/平台 watcher 错误触发 cleanup。stale watcher id
        // 是可恢复状态，不能 throw 到 RPC 事件订阅链路导致 host 进程退出。
        log.warn(undefined, "忽略已失效的文件监听订阅", { id });
        return Event.None;
      }
      return watcher.changeEmitter.event;
    },
  };
}
