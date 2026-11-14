// INV-01 恢复与持久化是两个开关：守住位置 restoreSession 与 persistSession；改错故障 新窗口覆盖主窗口会话。
// INV-02 持久化默认跟随恢复：守住位置 默认参数；改错故障 只恢复不写回。
// INV-03 完成态绑定服务与开关：守住位置 生命周期比较；改错故障 换服务后误判已完成。
// INV-04 恢复中标志驱动外层 loading：守住位置 isRestoring；改错故障 启动闪一下打开项目页。
// INV-05 首次恢复未完成不写回：守住位置 initialRestoreFullyCompletedRef；改错故障 半份快照落盘。
// INV-06 门禁关闭时跳过写回：守住位置 canPersist；改错故障 远程断连覆盖设置。
// INV-07 恢复失败必须 fail-closed：守住位置 捕获分支；改错故障 空 tabs 被当成真实状态。
// INV-08 恢复失败仍结束 loading：守住位置 completed 置真；改错故障 界面永久转圈。
// INV-09 写回带防抖：守住位置 DEBOUNCE_MS；改错故障 每次 store 事件都写盘。
// INV-10 连续变化重置定时器：守住位置 clearTimeout；改错故障 旧快照后写覆盖新快照。
// INV-11 写前读取同一设置快照：守住位置 get 与 update 串联；改错故障 冻结身份被改写。
// INV-12 补丁可由调用方覆盖：守住位置 buildPersistPatch；改错故障 远程会话无法定制写回。
// INV-13 默认补丁只写本地工作区：守住位置 身份与远端判断；改错故障 远端路径被当最近项目。
// INV-14 次级窗口不写回：守住位置 persistSession 判断；改错故障 恢复到最后关闭的窗口。
// INV-15 延迟恢复优先空闲回调：守住位置 scheduleDeferredRestore；改错故障 启动阶段抢占主线程。
// INV-16 延迟恢复可取消：守住位置 返回的取消函数；改错故障 卸载后仍补标签页。
// INV-17 恢复异常只记日志：守住位置 catch；改错故障 启动被未处理拒绝打断。
// INV-18 卸载时退订并清定时器：守住位置 两个 effect 的清理；改错故障 泄漏订阅与写回。
//
// 模块职责：标签页会话的恢复、持久化与写回门禁接线。
// 状态所有权：恢复生命周期为 hook 局部状态；标签页数据归 tab store。
// 阅读顺序：先看门禁与调度，再读恢复 effect，最后看持久化 effect。
/**
 * useTabPersistence —— 标签页持久化
 *
 * - mount 时从 settingService 恢复上次打开的标签页
 * - 订阅 tab store 变化，debounce 写回 settingService
 */
import { useEffect, useRef } from "react";
import { useState } from "react";
import type { AppSettings } from "@zcode/shared";
import type { ISettingService } from "@zcode/services";
import { readPersistedWorkspaceSessionEntries } from "@/lib/remoteWorkspaceHistory.js";
import { useTabStoreApi } from "../store/TabStoreProvider.js";
import { isWorkspaceTab, type TabStoreState } from "../store/tabStore.js";
import { logger } from "../logger.js";

const DEBOUNCE_MS = 300;

export interface TabPersistenceRestoreLifecycle {
  settingService?: ISettingService;
  restoreSession: boolean;
  completed: boolean;
  fullyCompleted: boolean;
}

/**
 * 活动目录选择的写回门禁。
 *
 * 这个对象由 Root 在本地窗口内共享给远程 session 流程：恢复未完成或失败时，
 * 远程连接状态变化只能更新内存，不能把半份 tab 快照写回全局 settings。
 */
export interface WorkspacePersistenceGate {
  canPersist: boolean;
  restoreFailed: boolean;
  onCanPersist?: () => void | Promise<void>;
}

// persistenceGate 缺省时直接返回：调用方没装门禁，就不在这里临时造一个
// gate.canPersist 直接取 persistSession 不另存副本，避免两个开关互相打脸
// 从关闭翻到打开时才调 onCanPersist 一次，重复 open 不重复回调
// onCanPersist 允许返回 Promise，这里不 await：开闸不该被回调的耗时阻塞
// gate 对象由调用方共享，本函数不得替换引用，否则外部拿到的还是旧闸
// 本函数只动 gate，不碰 restoreFailed 等恢复状态，恢复失败由调用方另行处理
function openWorkspacePersistenceGate(
  persistenceGate: WorkspacePersistenceGate | undefined,
  persistSession: boolean,
): void {
  if (!persistenceGate) return;
  persistenceGate.canPersist = Boolean(persistSession);
  if (persistenceGate.canPersist) {
    void persistenceGate.onCanPersist?.();
  }
}

export interface TabPersistenceRestoreResult {
  /** 恢复期间识别出的 app-owned 路径，不得回填为最近项目。 */
  excludedRecentProjectPaths?: readonly string[];
  /** active workspace 已恢复后，在首帧后的 idle period 补齐 inactive workspace。 */
  deferredRestore?: () => void;
}

// 优先用 requestIdleCallback，把恢复挪出首帧，避免打开工作区时卡一下
// 空闲回调带 1_000 ms 超时：浏览器一直忙也必须在一秒内执行
// 环境没有 requestIdleCallback 时退回 setTimeout 0，行为退化为下一轮任务
// 两条分支都返回同一个取消函数形状，调用方不需要判分支
// cancel 只取消尚未执行的回调，已经跑起来的恢复不再中断
// 整个调度不抛异常：恢复延迟属于体验优化，失败不该阻断挂载
function scheduleDeferredRestore(callback: () => void): () => void {
  if (typeof globalThis.requestIdleCallback === "function") {
    const idleCallbackId = globalThis.requestIdleCallback(() => callback(), {
      timeout: 1_000,
    });
    return () => globalThis.cancelIdleCallback(idleCallbackId);
  }

  const timer = globalThis.setTimeout(callback, 0);
  return () => globalThis.clearTimeout(timer);
}

export function hasCompletedTabPersistenceInitialRestore({
  settingService,
  restoreSession,
  restoreLifecycle,
}: {
  settingService?: ISettingService;
  restoreSession: boolean;
  restoreLifecycle: TabPersistenceRestoreLifecycle;
}): boolean {
  const shouldRestoreSession = Boolean(settingService && restoreSession);
  return (
    !shouldRestoreSession ||
    (restoreLifecycle.settingService === settingService &&
      restoreLifecycle.restoreSession === restoreSession &&
      restoreLifecycle.completed)
  );
}

function buildDefaultPersistPatch(state: TabStoreState): Partial<AppSettings> {
  const tab = state.tabs
    .filter(isWorkspaceTab)
    .find(
      (candidate) =>
        (candidate.workspaceIdentity?.trim() || candidate.workspacePath) ===
        (state.activeWorkspaceIdentity?.trim() || state.activeWorkspacePath),
    );
  if (tab?.workspaceIdentity || tab?.remoteSessionId) return {};
  return {
    lastActiveWorkspace: tab
      ? {
          kind: "local",
          workspacePath: tab.workspacePath,
          ...(tab.workspacePurpose ? { workspacePurpose: tab.workspacePurpose } : {}),
        }
      : null,
  };
}

// restoreEnabled 缺省为 true，没传就当用户要恢复上次的标签页
// persistSession 缺省跟随 restoreEnabled：不恢复就没有必要写回
// restoreCompleted 由 settingService 与 restoreEnabled 共同决定，缺服务视为已完成
// 恢复中标志驱动外层 loading。
// 门禁在恢复失败时保持关闭。
// 返回三个只读状态。
export function useTabPersistence({
  settingService,
  restoreSession = true,
  persistSession = restoreSession,
  persistenceGate,
  restorePersistedSession,
  buildPersistPatch,
}: {
  settingService?: ISettingService;
  /** 是否恢复上次会话，首个窗口 true，新窗口 false */
  restoreSession?: boolean;
  /** 是否把当前窗口会话写回全局设置，首个窗口 true，新窗口 false */
  persistSession?: boolean;
  /** 与远程 session 流程共享的活动目录写回门禁。 */
  persistenceGate?: WorkspacePersistenceGate;
  /** 自定义恢复流程；不传则回退到原来的本地 tab 恢复逻辑 */
  restorePersistedSession?: (
    settings: AppSettings,
  ) => Promise<TabPersistenceRestoreResult | void> | TabPersistenceRestoreResult | void;
  /** 自定义持久化补丁；不传则只写回本地 workspace 会话 */
  buildPersistPatch?: (state: TabStoreState, settings: AppSettings) => Partial<AppSettings>;
}) {
  const store = useTabStoreApi();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldRestoreSession = Boolean(settingService && restoreSession);
  const initialRestoreFullyCompletedRef = useRef(!shouldRestoreSession);
  const [restoreLifecycle, setRestoreLifecycle] = useState<TabPersistenceRestoreLifecycle>(() => ({
    settingService,
    restoreSession,
    completed: !shouldRestoreSession,
    fullyCompleted: !shouldRestoreSession,
  }));
  // provider/OAuth gate 从 false 切到 true 的同一轮 render 里，
  // 恢复会话 effect 还没来得及把 isRestoring 设为 true。这里把完成态绑定到
  // 当前 settingService + restoreSession，避免 initialWorkspacePath 抢在 restoreTabs 前 addTab。
  const hasCompletedInitialRestore = hasCompletedTabPersistenceInitialRestore({
    settingService,
    restoreSession,
    restoreLifecycle,
  });
  const hasCompletedFullRestore =
    !shouldRestoreSession ||
    (restoreLifecycle.settingService === settingService &&
      restoreLifecycle.restoreSession === restoreSession &&
      restoreLifecycle.fullyCompleted);
  const isRestoring = shouldRestoreSession && !hasCompletedInitialRestore;

  // 恢复会话
  useEffect(() => {
    if (!settingService || !restoreSession) {
      initialRestoreFullyCompletedRef.current = true;
      openWorkspacePersistenceGate(persistenceGate, persistSession);
      setRestoreLifecycle({
        settingService,
        restoreSession,
        completed: true,
        fullyCompleted: true,
      });
      return;
    }

    let cancelled = false;
    let cancelDeferredRestore: (() => void) | null = null;
    initialRestoreFullyCompletedRef.current = false;
    if (persistenceGate) {
      persistenceGate.canPersist = false;
      persistenceGate.restoreFailed = false;
    }
    // Bugfix: Root 首屏会先按 tab store 的默认空状态渲染打开工作区中间页，
    // 随后这里再异步恢复 lastWorkspaceSession，导致主界面启动时闪一下“打开项目”。
    // 这里显式暴露恢复中的状态，让外层在会话检查完成前持续显示 loading，
    // 避免把“默认空态”误展示给用户。
    setRestoreLifecycle({
      settingService,
      restoreSession,
      completed: false,
      fullyCompleted: false,
    });

    settingService
      .get()
      .then(async (settings) => {
        let restoreResult: TabPersistenceRestoreResult | void = undefined;
        if (restorePersistedSession) {
          restoreResult = await restorePersistedSession(settings);
        } else {
          const tabs = readPersistedWorkspaceSessionEntries(settings).flatMap((entry) =>
            entry.kind === "local"
              ? [
                  entry.workspacePurpose
                    ? {
                        workspacePath: entry.workspacePath,
                        workspacePurpose: entry.workspacePurpose,
                      }
                    : entry.workspacePath,
                ]
              : [],
          );
          const activeIndex = settings.lastActiveTabIndex ?? 0;
          if (tabs.length > 0) {
            logger.info("[useTabPersistence] 恢复标签页:", tabs);
            store.getState().restoreTabs(tabs, activeIndex);
          }
        }

        if (!cancelled) {
          const deferredRestore = restoreResult?.deferredRestore;
          setRestoreLifecycle({
            settingService,
            restoreSession,
            completed: true,
            fullyCompleted: !deferredRestore,
          });
          if (deferredRestore) {
            cancelDeferredRestore = scheduleDeferredRestore(() => {
              if (cancelled) {
                return;
              }
              // active-only 是启动瞬态，不能提前持久化；补齐合并产生的 store event
              // 才是首个允许写回的完整 session snapshot。
              initialRestoreFullyCompletedRef.current = true;
              openWorkspacePersistenceGate(persistenceGate, persistSession);
              try {
                deferredRestore();
              } catch (error) {
                logger.error("[useTabPersistence] 补齐 inactive workspace 失败:", error);
              } finally {
                if (!cancelled) {
                  setRestoreLifecycle({
                    settingService,
                    restoreSession,
                    completed: true,
                    fullyCompleted: true,
                  });
                }
              }
            });
          } else {
            initialRestoreFullyCompletedRef.current = true;
            openWorkspacePersistenceGate(persistenceGate, persistSession);
          }
        }
      })
      .catch((err) => {
        logger.error("[useTabPersistence] 恢复标签页失败:", err);
        if (!cancelled) {
          // 恢复失败时必须 fail-closed；当前 renderer 的 tabs 不是磁盘快照的完整替代品。
          // 只停止 loading，不允许后续远程断连/关闭事件覆盖 setting.json。
          initialRestoreFullyCompletedRef.current = false;
          if (persistenceGate) {
            persistenceGate.canPersist = false;
            persistenceGate.restoreFailed = true;
          }
          setRestoreLifecycle({
            settingService,
            restoreSession,
            completed: true,
            fullyCompleted: true,
          });
        }
      });

    return () => {
      cancelled = true;
      cancelDeferredRestore?.();
    };
  }, [
    persistSession,
    persistenceGate,
    restorePersistedSession,
    settingService,
    restoreSession,
    store,
  ]);

  // 持久化：订阅 store 变化，debounce 写入
  useEffect(() => {
    if (!settingService || !persistSession) return;

    // initialRestoreFullyCompletedRef 为假时不写回，否则空 store 会盖掉磁盘上的旧标签
    // gate.canPersist 为假时整个订阅跳过，工作区不可写时不做任何 IO
    // 每次 store 变化都清掉上一个 timer，连续操作只落一次盘
    // 写回前用 getSettingSnapshot 读同一份快照，避免拿订阅时刻的旧值覆盖新值
    // updateSettings 的 patch 允许调用方覆盖字段，这里只补 openTabs 相关键
    // 清理函数里 unsubscribe 并 clearTimeout，防止卸载后仍有写回
    const unsubscribe = store.subscribe((state) => {
      if (!initialRestoreFullyCompletedRef.current) {
        return;
      }
      if (persistenceGate && !persistenceGate.canPersist) {
        return;
      }
      if (timerRef.current) clearTimeout(timerRef.current);

      timerRef.current = setTimeout(() => {
        // 新开的次级窗口如果也把自己的标签页写回全局设置，
        // 会把主窗口真正想恢复的会话覆盖掉，导致下次启动恢复到错误窗口。
        // 这里把“是否持久化会话”独立成开关，只让首个本地窗口负责写回。
        // Bug 原因：remote legacy identity 的单一来源在最新 AppSettings；旧写入者只拿 tab
        // state，默认空 history 会把冻结 identity 改写成当前线路。写前读取同一 settings 快照。
        settingService
          .get()
          .then((settings) =>
            settingService.update(
              buildPersistPatch
                ? buildPersistPatch(state, settings)
                : buildDefaultPersistPatch(state),
            ),
          )
          .catch((err) => {
            logger.error("[useTabPersistence] 持久化失败:", err);
          });
      }, DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [buildPersistPatch, persistSession, persistenceGate, store, settingService]);

  return { isRestoring, hasCompletedInitialRestore, hasCompletedFullRestore };
}
