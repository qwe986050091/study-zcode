// INV-01 输入是期望集合：守住位置 reconcile 的 desired；改错故障 每次渲染全量重建订阅。
// INV-02 key 由 endpoint 与 workspaceKey 组成：守住位置 buildSessionsIndexEntryKey；改错故障 跨端点的同名项目互相覆盖。
// INV-03 等价判断逐字段比较：守住位置 isSameBinding；改错故障 引用变化导致无意义重订阅。
// INV-04 远程换代先 acquire 再 release：守住位置 注释与执行顺序；改错故障 registry 关闭旧 store，投影中断。
// INV-05 同 store 复用旧订阅：守住位置 sameStore 分支；改错故障 consumer listener 被重复注册。
// INV-06 不同 store 先 dispose 旧条目：守住位置 else 分支；改错故障 旧订阅泄漏。
// INV-07 删除项统一 dispose：守住位置 第二段释放；改错故障 只从 map 删除不还租约。
// INV-08 新增项 acquire 并订阅：守住位置 第二段循环；改错故障 新项目永远没有快照。
// INV-09 有变化只通知一次：守住位置 末尾 onStoreChange；改错故障 每个条目各触发一次渲染。
// INV-10 无变化只记 debug：守住位置 else 分支；改错故障 空转也触发渲染。
// INV-11 dispose 清空全部条目：守住位置 公开 dispose；改错故障 hooks 卸载后仍持有租约。
// INV-12 日志键缺省用 __base__：守住位置 scopeLogKey；改错故障 本地与远程日志无法区分。
// INV-13 类内不持有 React 状态：守住位置 只有 active map；改错故障 订阅逻辑与渲染耦合。
// INV-14 释放必须配对：守住位置 disposeEntry；改错故障 退订与还租约只做一半。
//
// 模块职责：按 endpoint 与 workspaceKey 维护 sessions-index 订阅集合，只对差异做副作用。
// 阅读顺序：先看 key 与等价判断，再看 reconcile 两段循环，最后看查询、销毁与日志。
import {
  LOCAL_SESSIONS_INDEX_ENDPOINT,
  acquireSessionsIndex,
  buildSessionsIndexEntryKey,
  releaseSessionsIndex,
  type SessionsIndexAgentService,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import type { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";
import { logger } from "@/logger.js";

export interface WorkspaceSessionsIndexBinding {
  scope: SessionsIndexScope;
  agentService: SessionsIndexAgentService;
}

interface ActiveWorkspaceSessionsIndexEntry extends WorkspaceSessionsIndexBinding {
  store: SessionsIndexStore;
  unsubscribeStore: () => void;
}

// 日志键只用于诊断，不参与 map 定位。
function scopeLogKey(scope: SessionsIndexScope): string {
  return `${scope.endpointKey ?? "__base__"}:${scope.workspaceKey}`;
}

// 等价判断逐字段比较，不看对象引用。
function isSameBinding(
  current: ActiveWorkspaceSessionsIndexEntry,
  next: WorkspaceSessionsIndexBinding,
): boolean {
  return (
    current.agentService === next.agentService &&
    current.scope.workspaceKey === next.scope.workspaceKey &&
    current.scope.workspacePath === next.scope.workspacePath &&
    current.scope.workspaceIdentity === next.scope.workspaceIdentity &&
    current.scope.endpointKey === next.scope.endpointKey
  );
}

/**
 * 按 endpoint + workspaceKey 持有 sessions-index 订阅。
 *
 * 旧 hook 把整个 scopes 数组放进一个带 cleanup 的 effect；删除一个 workspace 时，
 * React 会先释放全部 sibling 订阅，再重新 acquire 剩余项，导致已有 snapshot/水位被空状态替换。
 * 这里把 scope 数组解释成 desired set，只对真正新增、删除或 endpoint 换代的 key 做副作用。
 */
export class WorkspaceSessionsIndexSubscriptionSet {
  // 活动条目按 entry key 索引。
  private readonly active = new Map<string, ActiveWorkspaceSessionsIndexEntry>();

  constructor(private readonly onStoreChange: () => void) {}

  // 输入被解释成期望集合，而非全量重建指令。
  reconcile(bindings: readonly WorkspaceSessionsIndexBinding[]): boolean {
    const desired = new Map<string, WorkspaceSessionsIndexBinding>();
    for (const binding of bindings) {
      // 同一 key 后写覆盖前写，顺序稳定。
      desired.set(buildSessionsIndexEntryKey(binding.scope), binding);
    }

    let changed = false;
    const releasedScopeKeys: string[] = [];
    const acquiredScopeKeys: string[] = [];
    for (const [entryKey, current] of this.active) {
      const next = desired.get(entryKey);
      // 绑定完全相同时直接跳过，不重复 `subscribe`。
      if (next && isSameBinding(current, next)) {
        continue;
      }
      if (
        next &&
        current.agentService !== next.agentService &&
        (current.scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT) !==
          LOCAL_SESSIONS_INDEX_ENDPOINT
      ) {
        // 远程 service 换代若先 release 唯一 lease，registry 会立即关闭旧 store，
        // 随后的 acquire 只能从空 store 重建。先 acquire 让 registry 在旧 entry 仍存活时
        // 原地 rebind transport，再释放旧 lease，投影和 consumer listener 均不中断。
        // 换代时先 acquire，避免 registry 关掉旧 store。
        const store = acquireSessionsIndex(next.scope, next.agentService);
        // 同一个 store 就复用旧订阅，不断开投影。
        const sameStore = store === current.store;
        const unsubscribeStore = sameStore
          ? current.unsubscribeStore
          : store.subscribe(this.onStoreChange);
        // 同 store 只需释放旧租约。
        if (sameStore) {
          releaseSessionsIndex(current.scope, current.store);
        } else {
          this.disposeEntry(current);
        }
        this.active.set(entryKey, {
          ...next,
          store,
          unsubscribeStore,
        });
        releasedScopeKeys.push(scopeLogKey(current.scope));
        acquiredScopeKeys.push(scopeLogKey(next.scope));
        changed = true;
        continue;
      }
      // 其余情况由 `releaseBinding` 整条释放并移除。
      releasedScopeKeys.push(scopeLogKey(current.scope));
      this.disposeEntry(current);
      this.active.delete(entryKey);
      changed = true;
    }

    for (const [entryKey, binding] of desired) {
      if (this.active.has(entryKey)) {
        continue;
      }
      // 新增项单独 acquire 并订阅。
      const store = acquireSessionsIndex(binding.scope, binding.agentService);
      acquiredScopeKeys.push(scopeLogKey(binding.scope));
      this.active.set(entryKey, {
        ...binding,
        store,
        unsubscribeStore: store.subscribe(this.onStoreChange),
      });
      changed = true;
    }

    if (changed) {
      logger.info("[v4-sessions-index] workspace subscription set reconciled", {
        acquiredScopeKeys,
        releasedScopeKeys,
        activeCount: this.active.size,
      });
      // 有变化时统一通知一次，`notify` 只发一帧。
      this.onStoreChange();
    } else {
      logger.debug("[v4-sessions-index] workspace subscription set unchanged", {
        activeCount: this.active.size,
      });
    }
    return changed;
  }

  getStore(
    scope: Pick<SessionsIndexScope, "workspaceKey" | "endpointKey">,
  ): SessionsIndexStore | undefined {
    return this.active.get(buildSessionsIndexEntryKey(scope))?.store;
  }

  size(): number {
    return this.active.size;
  }

  /** hook 真正卸载（含 StrictMode cleanup）时统一释放；后续 reconcile 仍可重新建立。 */
  dispose(): void {
    if (this.active.size > 0) {
      logger.info("[v4-sessions-index] workspace subscription set disposed", {
        releasedScopeKeys: [...this.active.values()].map((entry) => scopeLogKey(entry.scope)),
      });
    }
    for (const entry of this.active.values()) {
      this.disposeEntry(entry);
    }
    this.active.clear();
  }

  private disposeEntry(entry: ActiveWorkspaceSessionsIndexEntry): void {
    // 释放顺序：先退订，再还租约。
    entry.unsubscribeStore();
    releaseSessionsIndex(entry.scope, entry.store);
  }
}
