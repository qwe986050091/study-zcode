// INV-01 两个 hook 面向不同来源：守住位置 两个导出；改错故障 编辑器误用全局快照，读不到目标 Environment。
// INV-02 全局版本用外部 store：守住位置 useSyncExternalStore；改错故障 自建轮询导致撕裂。
// INV-03 重载失败只记日志：守住位置 catch；改错故障 快照加载失败把设置页打成白屏。
// INV-04 service 版本按代际号丢弃旧回调：守住位置 generationRef；改错故障 旧 service 的响应写进新页面。
// INV-05 换代保留同 service 的 ready：守住位置 retainedReady；改错故障 每次 effect 重跑都闪一次 loading。
// INV-06 只允许当前 service 提交：守住位置 两处 service 比较；改错故障 旧 Environment 回写新编辑器。
// INV-07 revision 只增不减：守住位置 Math.max；改错故障 乱序事件把视图回退。
// INV-08 同 revision 不重复渲染：守住位置 等值判断；改错故障 事件与 mutation 响应各渲染一次。
// INV-09 失败只在无 ready 时展示：守住位置 hasReadyView；改错故障 已有数据被一个迟到错误覆盖。
// INV-10 自增即作废旧订阅：守住位置 effect 首行与清理；改错故障 双订阅并存。
// INV-11 清理退订再自增：守住位置 return 函数；改错故障 StrictMode 下重复回调。
// INV-12 reloadVersion 只触发 effect：守住位置 useReducer；改错故障 重试走另一条未同步路径。
// INV-13 service 不匹配时回 loading：守住位置 visibleState；改错故障 新 service 首帧显示旧数据。
// INV-14 commit 外部回调不返回值：守住位置 包装函数；改错故障 调用方误以为拿到提交结果。
//
// 模块职责：Provider 设置视图的全局快照订阅，以及按 ServiceProvider 隔离的编辑器读取。
// 阅读顺序：先看全局 hook，再看 service hook 的提交校验，最后看 effect 代际与清理。
import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";
import { logger } from "@/logger.js";
import {
  getProviderSettingsSnapshot,
  reloadProviderSettingsSnapshot,
  subscribeProviderSettingsSnapshot,
  type ProviderSettingsState,
} from "@/lib/providerSettingsSnapshot.js";

export interface ProviderSettingsRead {
  state: ProviderSettingsState;
  reload(): void;
}

export interface ProviderSettingsServiceRead extends ProviderSettingsRead {
  /** 提交 mutation 返回的权威 View；不依赖异步 onDidChange 事件才能收敛 UI。 */
  commit(view: ProviderSettingsView): void;
}

// 全局版本只订阅快照，不持有本地状态。
export function useProviderSettingsView(): ProviderSettingsRead {
  // 快照来源与订阅同源，避免竞态。
  const state = useSyncExternalStore(
    subscribeProviderSettingsSnapshot,
    getProviderSettingsSnapshot,
    getProviderSettingsSnapshot,
  );
  return {
    state,
    reload: useCallback(() => {
      // 重载失败只记日志。
      void reloadProviderSettingsSnapshot().catch((error) => {
        logger.warn("[ProviderSettings] 重试加载根 Environment 失败", { error });
      });
    }, []),
  };
}

interface OwnedProviderSettingsState {
  service: IProviderSettingsService;
  state: ProviderSettingsState;
}

/** Settings 编辑器按当前 ServiceProvider 读取目标 Environment，并显式暴露失败与重试。 */
// service 版本面向编辑器，需要显式失败与重试。
export function useProviderSettingsServiceView(
  service: IProviderSettingsService,
): ProviderSettingsServiceRead {
  // 版本号只用来触发 effect 重跑。
  const [reloadVersion, reload] = useReducer((value: number) => value + 1, 0);
  const [owned, setOwned] = useState<OwnedProviderSettingsState>({
    service,
    state: { status: "loading" },
  });
  const ownedRef = useRef(owned);
  ownedRef.current = owned;
  const serviceRef = useRef(service);
  serviceRef.current = service;
  const generationRef = useRef(0);
  const latestRevisionRef = useRef(-1);
  // service 换代时先回到 loading。
  const visibleState = owned.service === service ? owned.state : ({ status: "loading" } as const);

  const commitView = useCallback(
    (view: ProviderSettingsView): boolean => {
      // 远端 workspace attachment 换代时，旧 mutation 可能晚于新 Service 返回。
      // 只允许当前 Service 的最新 revision 提交，避免旧 Environment 回写新页面。
      // 旧 service 的 mutation 一律拒绝。
      if (serviceRef.current !== service || ownedRef.current.service !== service) {
        return false;
      }
      const current = ownedRef.current.state;
      const currentRevision = current.status === "ready" ? current.view.revision : -1;
      // revision 只增不减。
      const latestRevision = Math.max(currentRevision, latestRevisionRef.current);
      // 过期 revision 不得回写。
      if (view.revision < latestRevision) {
        return false;
      }
      // 同一 revision 的事件与 mutation response 表示同一份 Registry 事实，避免重复渲染。
      // 同 revision 的重复事件不重复渲染。
      if (view.revision === latestRevision && current.status === "ready") {
        return false;
      }
      latestRevisionRef.current = view.revision;
      setOwned({ service, state: { status: "ready", view } });
      return true;
    },
    [service],
  );

  useEffect(() => {
    // generationRef.current 自增即作废旧代回调，晚到的 commit 会被丢弃。
    generationRef.current += 1;
    const generation = generationRef.current;
    const previous = ownedRef.current;
    const retainedReady =
      previous.service === service && previous.state.status === "ready" ? previous.state : null;
    setOwned({ service, state: retainedReady ?? { status: "loading" } });
    latestRevisionRef.current = retainedReady?.view.revision ?? -1;
    let hasReadyView = retainedReady !== null;
    const commit = (view: ProviderSettingsView): void => {
      // generation !== generationRef.current 时直接 return，代际不符的回调丢弃。
      if (generation !== generationRef.current) return;
      if (commitView(view)) {
        hasReadyView = true;
      }
    };
    const subscription = service.onDidChange(commit);
    void service.getView().then(commit, (cause) => {
      if (generation !== generationRef.current) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      logger.warn("[ProviderSettings] 加载目标 Environment 失败", { error });
      // 已有 ready 时不覆盖为错误。
      if (!hasReadyView) setOwned({ service, state: { status: "error", error } });
    });
    return () => {
      generationRef.current += 1;
      subscription.dispose();
    };
  }, [commitView, reloadVersion, service]);

  return {
    state: visibleState,
    reload: useCallback(() => reload(), []),
    commit: useCallback(
      (view: ProviderSettingsView) => {
        commitView(view);
      },
      [commitView],
    ),
  };
}
