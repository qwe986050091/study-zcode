// INV-01 缓存键按服务隔离：守住位置 弱映射；改错故障 远端与本地设置互相覆盖。
// INV-02 显式键优先：守住位置 裁剪判断；改错故障 调用方无法指定共享范围。
// INV-03 缺服务给固定键：守住位置 空值分支；改错故障 测试环境同步抛错。
// INV-04 默认键只分配一次：守住位置 弱映射查存；改错故障 每次渲染换键重复请求。
// INV-05 刷新去重：守住位置 在飞映射；改错故障 并发挂载发起多次读取。
// INV-06 刷新先置加载态：守住位置 写快照；改错故障 界面没有加载提示。
// INV-07 失败保留旧设置：守住位置 错误分支；改错故障 一次失败清空整页。
// INV-08 结束后清理在飞记录：守住位置 收尾；改错故障 后续刷新复用旧结果。
// INV-09 快照变更广播给订阅者：守住位置 遍历监听；改错故障 组件不重渲染。
// INV-10 卸载移除监听：守住位置 清理函数；改错故障 已卸载组件继续写状态。
// INV-11 监听集合空则删除：守住位置 长度判断；改错故障 键集合无限增长。
// INV-12 挂载后主动刷新：守住位置 副作用；改错故障 首次进入显示空设置。
// INV-13 平台变更触发刷新：守住位置 订阅；改错故障 系统设置变化不生效。
// INV-14 条件更新失败重读：守住位置 捕获分支；改错故障 重试仍带旧预期。
// INV-15 更新成功后同步平台：守住位置 同步调用；改错故障 原生菜单不同步。
// INV-16 偏好项跨进程同步：守住位置 并行调用；改错故障 只有一处生效。
// INV-17 广播在同步之后：守住位置 调用顺序；改错故障 其他窗口读到旧值。
// INV-18 同步失败向上抛：守住位置 汇总结果；改错故障 用户以为已保存。
//
// 模块职责：应用设置的共享快照缓存、刷新去重与跨进程同步。
// 状态所有权：快照按缓存键存在模块级映射，组件只订阅不持有权威数据。
// 阅读顺序：先看缓存键与快照广播，再看 hook 的订阅，最后看更新与同步。
/**
 * useSettingService —— 设置服务 hooks
 */
import { useState, useEffect, useCallback } from "react";
import { APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL, type AppSettings } from "@zcode/shared";
import type { IServiceAccessor, ISettingService } from "@zcode/services";
import { useServices } from "./useServices.js";
import { usePlatform } from "./usePlatform.js";

type SettingsSnapshot = {
  settings: AppSettings | null;
  loading: boolean;
  error: unknown | null;
};

const INITIAL_SETTINGS_SNAPSHOT: SettingsSnapshot = {
  settings: null,
  loading: true,
  error: null,
};
const snapshots = new Map<string, SettingsSnapshot>();
const inflightRefreshes = new Map<string, Promise<void>>();
const listenersByKey = new Map<string, Set<(snapshot: SettingsSnapshot) => void>>();
const defaultCacheKeyByServices = new WeakMap<object, string>();
let nextDefaultCacheKey = 0;

// resolveSettingsCacheKey 先对 explicitCacheKey 做 trim。
// settingService 缺省时返回 "settings-services:missing"。
// defaultCacheKeyByServices 命中时直接复用旧键。
// 新建键用 ++nextDefaultCacheKey 自增计数。
// WeakMap 随 settingService 回收，不阻止 GC。
function resolveSettingsCacheKey(
  explicitCacheKey: string | undefined,
  settingService: object | undefined,
): string {
  const explicit = explicitCacheKey?.trim();
  if (explicit) return explicit;

  // 测试/SSR 的最小 ServiceAccessor 可能暂时没有 settingService；不要把 undefined
  // 作为 WeakMap key 抛出同步异常，真实 Host 服务就绪后仍会使用按服务隔离的缓存键。
  if (!settingService) return "settings-services:missing";

  const existing = defaultCacheKeyByServices.get(settingService);
  if (existing) return existing;

  // Bug 原因：默认 cacheKey 曾固定为 "local"。远端 workspace 的 SessionPane 与
  // Controller SettingsPage 同时挂载时会互相覆盖同一快照，使 Source 选择器消失，
  // 也可能把本机运行偏好投影到远端。缓存必须跟服务 accessor 的权威边界一致。
  const created = `settings-services:${++nextDefaultCacheKey}`;
  defaultCacheKeyByServices.set(settingService, created);
  return created;
}

function getSettingsSnapshot(cacheKey: string): SettingsSnapshot {
  return snapshots.get(cacheKey) ?? INITIAL_SETTINGS_SNAPSHOT;
}

function setSettingsSnapshot(cacheKey: string, snapshot: SettingsSnapshot): void {
  snapshots.set(cacheKey, snapshot);
  for (const listener of listenersByKey.get(cacheKey) ?? []) {
    listener(snapshot);
  }
}

// refreshSharedSettings 遇到 inflight 请求直接复用。
// 刷新前先把 loading 置 true。
// getSettings 成功后整体替换 settings。
// 失败时保留旧 settings，只写 error。
// finally 里删除 inflightRefreshes 记录。
async function refreshSharedSettings(cacheKey: string, getSettings: () => Promise<AppSettings>) {
  const inflight = inflightRefreshes.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  setSettingsSnapshot(cacheKey, {
    ...getSettingsSnapshot(cacheKey),
    loading: true,
    error: null,
  });

  const refreshPromise = (async () => {
    try {
      const result = await getSettings();
      setSettingsSnapshot(cacheKey, {
        settings: result,
        loading: false,
        error: null,
      });
    } catch (error) {
      setSettingsSnapshot(cacheKey, {
        // 修复原因：设置读取失败时保留旧快照，避免一次刷新错误把已可用的设置页降级为空状态。
        settings: getSettingsSnapshot(cacheKey).settings,
        loading: false,
        error,
      });
    }
  })().finally(() => {
    inflightRefreshes.delete(cacheKey);
  });
  inflightRefreshes.set(cacheKey, refreshPromise);

  return refreshPromise;
}

export async function updateSettingsAndRefreshSnapshot(params: {
  settingService: Pick<ISettingService, "get" | "update">;
  patch: Partial<AppSettings>;
}): Promise<void> {
  const cacheKey = resolveSettingsCacheKey(undefined, params.settingService);
  await params.settingService.update(params.patch);
  await refreshSharedSettings(cacheKey, () => params.settingService.get());
}

/** 获取和更新应用设置 */
// settingService 可由 options.services 覆盖。
// cacheKey 在渲染期由 resolveSettingsCacheKey 解析。
// 初值取 getSettingsSnapshot 的共享快照。
// 挂载时登记 listener 并 refresh。
// 卸载时从 listenersByKey 撤销登记。
export function useSettings(options: { cacheKey?: string; services?: IServiceAccessor } = {}) {
  const contextualServices = useServices();
  // Bug 原因：SettingsPage 可在远端 workspace 的 ServiceProvider 下渲染；若继续隐式取当前
  // context，“记住 Source 选择”会写入远端 setting，Controller 本地快照随后把选择重置为本机。
  const settingsServices = options.services ?? contextualServices;
  const { botsService, broadcastService, settingService, zcodeAgentService } = settingsServices;
  const platform = usePlatform();
  const cacheKey = resolveSettingsCacheKey(options.cacheKey, settingService);
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>(() => getSettingsSnapshot(cacheKey));

  const refresh = useCallback(async () => {
    await refreshSharedSettings(cacheKey, () => settingService.get());
  }, [cacheKey, settingService]);

  useEffect(() => {
    const listener = (nextSnapshot: SettingsSnapshot) => {
      setSnapshot(nextSnapshot);
    };

    const listeners = listenersByKey.get(cacheKey) ?? new Set();
    listeners.add(listener);
    listenersByKey.set(cacheKey, listeners);
    setSnapshot(getSettingsSnapshot(cacheKey));
    void refresh();

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) listenersByKey.delete(cacheKey);
    };
  }, [cacheKey, refresh]);

  useEffect(() => {
    return (
      platform.onSettingsChanged?.(() => {
        void refresh();
      }) ?? (() => {})
    );
  }, [platform, refresh]);

  // expectedAccountSettings 存在时就带 CAS 条件更新。
  // 失败后先 get 重读事实再决定是否回滚。
  // 成功后调用 platform.syncAppSettings 同步。
  // 偏好项用 Promise.allSettled 并行同步两个服务。
  // 广播 appRuntimePreferences 之后再抛 syncError。
  const update = useCallback(
    async (
      patch: Partial<AppSettings>,
      expectedAccountSettings?: Parameters<ISettingService["update"]>[1],
    ) => {
      try {
        if (expectedAccountSettings) await settingService.update(patch, expectedAccountSettings);
        else await settingService.update(patch);
      } catch (error) {
        // 原因：CAS 失败后页面仍持有旧快照；重读事实后报告失败，下一次用户重试才有新预期。
        if (expectedAccountSettings) await refresh();
        throw error;
      }
      platform.syncAppSettings?.(patch);
      await refresh();
      if (
        typeof patch.askUserQuestionAutoResolutionEnabled === "boolean" ||
        typeof patch.modelIoFullRetentionEnabled === "boolean"
      ) {
        const currentSettings = getSettingsSnapshot(cacheKey).settings;
        const preferences = {
          askUserQuestionAutoResolutionEnabled:
            patch.askUserQuestionAutoResolutionEnabled ??
            currentSettings?.askUserQuestionAutoResolutionEnabled !== false,
          modelIoFullRetentionEnabled:
            patch.modelIoFullRetentionEnabled ??
            currentSettings?.modelIoFullRetentionEnabled === true,
        };
        const syncResults = await Promise.allSettled([
          zcodeAgentService.syncAppRuntimePreferences(preferences),
          botsService.syncAppRuntimePreferences(preferences),
        ]);
        const syncError = syncResults.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        )?.reason;
        await broadcastService.send({
          channel: APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
          payload: preferences,
        });
        if (syncError) {
          throw syncError;
        }
      }
    },
    [botsService, broadcastService, cacheKey, settingService, zcodeAgentService, platform, refresh],
  );

  return {
    settings: snapshot.settings,
    loading: snapshot.loading,
    error: snapshot.error,
    update,
    refresh,
  };
}

/** 最近项目列表的便捷 hook */
export function useRecentProjects() {
  const { settings, loading, update } = useSettings();
  return {
    recentProjects: settings?.recentProjects ?? [],
    loading,
    addProject: async (path: string) => {
      const current = settings?.recentProjects ?? [];
      const updated = [path, ...current.filter((p) => p !== path)].slice(0, 10);
      await update({ recentProjects: updated });
    },
  };
}
