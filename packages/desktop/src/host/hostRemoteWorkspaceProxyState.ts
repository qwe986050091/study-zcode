// shared remote Host 代理层持有的 workspace 资源账本。
//
// 职责：保存 task meta、每个 workspace 的事件订阅、每个 task 的 ready 订阅，并提供按
// workspace 的清理入口；解决 WSL Host Pool 跨 workspace 复用时的引用累积。
// 输入输出：createHostRemoteWorkspaceProxyState 返回 remember/getTaskMeta、
// ensureWorkspaceSubscription、trackTaskReady、disposeTaskReadySubscription、clearWorkspace。
// ensureWorkspaceSubscription 返回 true 表示本次真正建立订阅（已存在返回 false）。
// 副作用：调用方传入的 subscribe 会被执行并持有其 IDisposable；clearWorkspace 会 dispose。
// 失败语义：不抛出；clearWorkspace 对不存在的 workspace 是 no-op；重复 trackTaskReady
// 会先释放旧订阅再登记新的，保证同一 task 只有一个 ready listener。
// 维护的不变量：订阅必须按 workspace 主动清理（dedicated Host 可整进程回收，Pool Host 不行）；
// trackTaskReady 处理「同步 replay」：若 subscribe 期间就触发 ready，则立即 dispose 不再登记。

import type { IDisposable } from "@zcode/rpc";
import { resolveWorkspaceKey } from "@zcode/shared";

export interface HostRemoteTaskMeta {
  taskId: string;
  traceId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface HostRemoteWorkspaceContext {
  workspacePath: string;
  workspaceIdentity?: string;
}

// 创建代理层 workspace 状态账本（闭包内三张 Map，无外部依赖）。
// 返回的每个方法都以 resolveWorkspaceKey(context) 归一化，调用方传 path 或 identity 都可。
// 失败语义：不抛出；重复登记 / 重复清理均幂等。
/**
 * 保存 shared remote Host 代理层持有的 workspace 资源。
 *
 * dedicated Host 会随 tab 退出，历史 task meta 和事件监听可由进程整体回收；
 * WSL Host Pool 会跨 workspace 复用，必须按 workspace 主动清理，否则引用会随 Host 寿命持续增长。
 */
export function createHostRemoteWorkspaceProxyState(): {
  rememberTaskMeta: (meta: HostRemoteTaskMeta) => void;
  getTaskMeta: (taskId: string) => HostRemoteTaskMeta | undefined;
  ensureWorkspaceSubscription: (
    context: HostRemoteWorkspaceContext,
    subscribe: () => IDisposable,
  ) => boolean;
  trackTaskReady: (
    taskId: string,
    context: HostRemoteWorkspaceContext,
    subscribe: (listener: () => void) => IDisposable,
    onReady: () => void,
  ) => void;
  disposeTaskReadySubscription: (taskId: string) => void;
  clearWorkspace: (context: HostRemoteWorkspaceContext) => void;
} {
  const taskMetaById = new Map<string, HostRemoteTaskMeta>();
  const workspaceSubscriptions = new Map<string, IDisposable>();
  const taskReadySubscriptions = new Map<
    string,
    { workspaceKey: string; disposable: IDisposable }
  >();

  // 释放某个 task 的 ready 订阅：先删表再 dispose，避免 dispose 抛错后表里残留死引用。
  // 不存在时直接返回（幂等）。
  function disposeTaskReadySubscription(taskId: string): void {
    const entry = taskReadySubscriptions.get(taskId);
    if (!entry) {
      return;
    }
    taskReadySubscriptions.delete(taskId);
    entry.disposable.dispose();
  }

  return {
    rememberTaskMeta(meta) {
      taskMetaById.set(meta.taskId, meta);
    },

    getTaskMeta(taskId) {
      return taskMetaById.get(taskId);
    },

    // 确保某 workspace 只建立一次订阅：已存在返回 false，不重复 subscribe。
    // 重复调用是常态（多个任务同 workspace），因此这里不是错误路径而是幂等入口。
    ensureWorkspaceSubscription(context, subscribe) {
      const workspaceKey = resolveWorkspaceKey(context);
      if (workspaceSubscriptions.has(workspaceKey)) {
        return false;
      }
      workspaceSubscriptions.set(workspaceKey, subscribe());
      return true;
    },

    // 登记 task ready 订阅，ready 时先自我清理再回调 onReady。
    // readyBeforeRegistration 处理同步 replay：subscribe 内部立刻触发 ready 时，不能在
    // 回调结束后又登记一份已失效的 listener，因此直接 dispose 并返回。
    // 替换语义：同 taskId 已有订阅时先释放旧的，保证不叠加监听。
    trackTaskReady(taskId, context, subscribe, onReady) {
      let readyBeforeRegistration = false;
      const disposable = subscribe(() => {
        readyBeforeRegistration = true;
        disposeTaskReadySubscription(taskId);
        onReady();
      });
      if (readyBeforeRegistration) {
        // 动态 RPC 事件通常不会同步 replay，但这里处理同步实现，避免 ready 已结束后又留下 listener。
        disposable.dispose();
        return;
      }
      disposeTaskReadySubscription(taskId);
      taskReadySubscriptions.set(taskId, {
        workspaceKey: resolveWorkspaceKey(context),
        disposable,
      });
    },

    disposeTaskReadySubscription,

    // workspace 关闭时全量清理：workspace 订阅、该 workspace 的 task meta 与 ready 订阅。
    // 三张表必须都清（meta 与 ready 都按 workspaceKey 二次匹配），否则 Pool Host 会持续增长。
    // 失败语义：单个 dispose 抛错会中断循环——调用方应保证订阅 dispose 自身不抛出。
    clearWorkspace(context) {
      const workspaceKey = resolveWorkspaceKey(context);
      workspaceSubscriptions.get(workspaceKey)?.dispose();
      workspaceSubscriptions.delete(workspaceKey);

      for (const [taskId, meta] of taskMetaById) {
        if (resolveWorkspaceKey(meta) === workspaceKey) {
          taskMetaById.delete(taskId);
        }
      }
      for (const [taskId, entry] of taskReadySubscriptions) {
        if (entry.workspaceKey === workspaceKey) {
          disposeTaskReadySubscription(taskId);
        }
      }
    },
  };
}
