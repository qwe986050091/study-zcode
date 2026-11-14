// ============================================================================
// sourceServerUpdateNotifications.ts — Source 服务器必需升级通知：快照投影 + 去重 + 单飞更新
// 口径：注释密度与不变量写法见 docs/annotation/DEEP-SPEC.md；本文件守住「不重复打扰 + 不重复更新」
// INV-01 通知 key 由 sourceServerId 与 availableVersion 组成。守住 getSourceServerUpdateNotificationKey；改错→版本升级后旧 key 继续去重，新版本不再提示
// INV-02 仅 needs-upgrade 且 updateAvailability 为 required 才提示。守住同函数首行；改错→可选更新也弹窗，打扰面扩大
// INV-03 四字段任一缺失即不提示。守住 key 生成前的字段校验；改错→生成无法执行的空动作按钮
// INV-04 向导已接管的档案不弹通知。守住 getEligibleNotificationKey；改错→先弹通知再进向导，出现重复操作
// INV-05 活跃 shown 与持久 seen 分离。守住 create 内的两个容器；改错→断线重连后重复提示或永久漏提示
// INV-06 状态离开 eligible 必须立即撤销旧提示。守住 refresh 的撤销循环；改错→旧按钮在超时前一直可点
// INV-07 点击更新前必须重拉快照复核。守住 handleUpdate 内 getSnapshot；改错→过期按钮再次发起更新
// INV-08 actionStarted 单飞，只允许发起一次更新。守住闭包首行；改错→连点导致并发两次更新
// INV-09 isActive 为 false 时不得展示或更新。守住每个异步回调入口；改错→组件卸载后仍弹 toast
// INV-10 仅 upgradeTarget 为 server 时提供立即更新按钮。守住 canUpdateServer；改错→控制器升级被误当设备升级
// INV-11 进度 toast 60 秒且必须被 dismiss。守住 then 与 catch 首行；改错→完成提示与进度条叠加
// INV-12 失败提示的详情跳转依赖 sourceServerId。守住 catch 内条件；改错→无设备 id 时挂出无效跳转
// INV-13 refresh 单飞并合并尾随请求。守住 refreshInFlight 与 refreshQueued；改错→状态风暴放大成 N 次快照读取
// INV-14 disposed 后不再刷新或展示。守住 refresh 首行与回调入口；改错→卸载后重建订阅造成泄漏
// INV-15 dispose 必须释放两个订阅并清空活跃表。守住 dispose；改错→控制器回收后事件仍在回调
// INV-16 eligible 以 key 去重，同 key 只展示一条。守住 eligible Map；改错→同一设备多状态重复弹窗
// INV-17 markSeen 只在展示成功后写入。守住 show 返回非空判断；改错→展示失败也永久去重
// INV-18 展示名回退链固定：设备 → 档案 → 传输地址 → 常量。守住 resolveSourceDisplayName；改错→文案出现空白或 undefined
// INV-19 强更确认取消即放弃，不提示完成。守住 confirmForce 与 then 的 next 判空；改错→取消后被当成成功
// INV-20 effect 依赖变化必须重建并释放旧控制器。守住 useEffect 清理函数；改错→双订阅导致重复提示
// ============================================================================
import { useCallback, useEffect, useRef } from "react";
import type { ISourceServerManagementService } from "@zcode/services";
import type { RemoteTarget, SourceServerManagementSnapshot } from "@zcode/shared";
import { dismissToast, toast, type ToastOptions } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { findSourceServerUpgradeProfileId } from "@/lib/remoteConnectionWizard.js";
import {
  getSourceServerForceUpdateDescription,
  runSourceServerUpdate,
} from "@/lib/sourceServerUpdateAction.js";
import {
  sourceServerUpdatePreferences,
  sourceServerUpdateKey,
} from "@/lib/sourceServerUpdatePreferences.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { logger } from "@/logger.js";

// 控制器只依赖注入的能力：偏好存储、管理服务、文案、toast、确认框与跳转回调，方便在测试里替换。
// isActive 用于判断宿主是否仍然挂载；卸载后所有异步回调都必须先过这一关再展示或更新。
// getConnectionTarget 返回当前连接向导选中的目标，用来在向导接管时抑制通知（见 INV-04）。
// onProgress 与 onDetails 只做导航副作用，不承载业务状态，控制器不关心路由实现。
interface NotificationControllerOptions {
  preferences?: Pick<typeof sourceServerUpdatePreferences, "hasSeen" | "markSeen">;
  management: ISourceServerManagementService;
  formatMessage: (id: string, values?: Record<string, string | number>) => string;
  showToast: (message: string, options?: ToastOptions) => unknown;
  dismissToast?: (id: unknown) => void;
  confirmForce?: (profileId: string) => Promise<boolean>;
  onDetails?: (sourceServerId: string) => void;
  onProgress?: (sourceServerId: string) => void;
  onError?: (error: unknown) => void;
  isActive?: () => boolean;
  getConnectionTarget?: () => RemoteTarget | null;
}

// 直接取管理快照里的状态元素类型，字段口径与 services 侧同源，不在 UI 另建一套镜像类型。
type SourceServerUpdateState = SourceServerManagementSnapshot["states"][number];

// 对外只暴露 refresh 与 dispose：状态订阅与去重都在内部，调用方不需要知道快照结构。
// refresh 可重复调用，内部会合并并发的刷新请求。
export interface SourceServerUpdateNotificationController {
  refresh(): void;
  dispose(): void;
}

// 展示名优先级：设备记录里的 displayName → 档案 displayName → 传输地址 → 常量兜底。
// 源服务器记录按 sourceServerId 匹配，缺失时退回档案维度，保证老数据也有可读名字。
// 这里只用于文案，不参与 key 计算；改名不会改变去重结果。
function resolveSourceDisplayName(
  snapshot: SourceServerManagementSnapshot,
  profileId: string,
  sourceServerId?: string,
): string {
  const server = sourceServerId
    ? snapshot.servers.find((candidate) => candidate.sourceServerId === sourceServerId)
    : undefined;
  if (server?.displayName) return server.displayName;
  const profile = snapshot.profiles.find((candidate) => candidate.profileId === profileId);
  return profile?.displayName ?? profile?.transport ?? "Source Server";
}

// 通知 key 由 sourceServerId 与 availableVersion 组成，版本一升级就自然产生新 key。
// 四个字段任一缺失都返回 null：没有目标版本或升级目标时，通知无法生成可执行动作。
// 只有 needs-upgrade 且 updateAvailability 为 required 才提示，可选更新不主动打扰。
function getSourceServerUpdateNotificationKey(state: SourceServerUpdateState): string | null {
  const updateRequired = state.state === "needs-upgrade" && state.updateAvailability === "required";
  if (
    !updateRequired ||
    !state.sourceServerId ||
    !state.currentVersion ||
    !state.availableVersion ||
    !state.upgradeTarget
  ) {
    return null;
  }
  return sourceServerUpdateKey(state.sourceServerId, state.availableVersion);
}

// 在 key 之外再叠加「向导是否已接管」的判断：向导选中的档案不弹通知。
// 抑制必须发生在 needs-upgrade 到达之前，否则用户会先看到通知再看到向导，形成重复操作。
// getConnectionTarget 为空表示没有进行中的向导，直接回落到版本 key。
function getEligibleNotificationKey(
  options: NotificationControllerOptions,
  snapshot: SourceServerManagementSnapshot,
  state: SourceServerUpdateState,
): string | null {
  const target = options.getConnectionTarget?.();
  // 向导在发起连接前接管目标；不能等 needs-upgrade 到达后再抑制，否则会先弹出重复操作。
  if (
    target &&
    target.kind !== "server" &&
    findSourceServerUpgradeProfileId(snapshot, target) === state.profileId
  )
    return null;
  return getSourceServerUpdateNotificationKey(state);
}

// 组装并展示单条通知；无法生成 key 时返回 null，调用方据此决定是否登记到活跃表。
// 本函数不写偏好存储，markSeen 由控制器在展示成功后统一执行，避免展示失败也永久去重。
// 返回的 id 只用于后续 dismiss，不参与去重判断。
export function showSourceServerUpdateNotification(
  options: NotificationControllerOptions & {
    snapshot: SourceServerManagementSnapshot;
    state: SourceServerUpdateState;
  },
): { id: unknown } | null {
  const key = getEligibleNotificationKey(options, options.snapshot, options.state);
  if (!key) return null;

  const state = options.state;
  const updateRequired = state.updateAvailability === "required";
  const source = resolveSourceDisplayName(options.snapshot, state.profileId, state.sourceServerId);
  // 只有升级目标为 server 才提供「立即更新」动作；controller 维度升级只提示不给按钮。
  // 按钮文案与后续分支都依赖这个判断，不要在两处各写一份条件。
  const canUpdateServer = state.upgradeTarget === "server";
  // 单飞位：toast 按钮可能被连点，重复进入会让同一设备并发发起两次更新。
  // 标记只在首次进入时置位，后续无论成功失败都不复位——通知展示期间只允许发起一次。
  let actionStarted = false;
  const handleUpdate = canUpdateServer
    ? () => {
        if (actionStarted || options.isActive?.() === false) return;
        actionStarted = true;
        let progressToastId: unknown;
        void (async () => {
          // Toast 是过去快照的投影。点击必须复核 Host 状态，不能让过期按钮再次发起更新。
          // [事务] toast 是过去快照的投影，点击时必须重新拉取快照复核，不能拿旧按钮直接执行。
          // 复核要求当前状态的 eligible key 与展示时一致；版本已变或已不需要升级就静默放弃。
          // isActive 也要再判一次：复核期间宿主可能已经卸载，此时任何 toast 都不该再出现。
          const snapshot = await options.management.getSnapshot();
          const current = snapshot.states.find(
            (candidate) => candidate.profileId === state.profileId,
          );
          if (
            options.isActive?.() === false ||
            !current ||
            getEligibleNotificationKey(options, snapshot, current) !== key
          )
            return null;
          // 主动更新后定位设备卡，让既有阶段与进度投影立即可见。
          if (state.sourceServerId) options.onProgress?.(state.sourceServerId);
          progressToastId = options.showToast(
            options.formatMessage("sourceServer.updateStartedToast", { source }),
            {
              durationMs: 60_000,
              position: "top-center",
              variant: "info",
              dismissible: true,
              dismissLabel: options.formatMessage("common.close"),
            },
          );
          // 真正的更新动作交给 lib 层：确认强更、选择目标与失败语义都在那里，这里只做编排。
          return await runSourceServerUpdate({
            management: options.management,
            profileId: state.profileId,
            confirmForce: () => options.confirmForce?.(state.profileId) ?? Promise.resolve(false),
          });
        })()
          // 成功路径先关掉进度 toast 再展示完成提示，避免两条 toast 同时挂在顶部中心。
          // next 为空表示用户取消了强更确认，这种情况不提示完成，也不提示失败。
          .then((next) => {
            options.dismissToast?.(progressToastId);
            if (!next || options.isActive?.() === false) return;
            options.showToast(
              options.formatMessage("sourceServer.updateCompletedToast", {
                source,
              }),
              {
                durationMs: 8_000,
                position: "top-center",
                variant: "source-server-update",
                dismissible: true,
                dismissLabel: options.formatMessage("common.close"),
              },
            );
          })
          // 失败提示带「详情」动作，跳转目标是具体设备卡；没有 sourceServerId 时不挂动作。
          // 先 dismiss 进度 toast 再弹失败 toast，顺序反了会让失败提示被随后关闭的进度条覆盖。
          // 错误始终上报给 onError，即使宿主已卸载也要让上层日志拿到原因。
          .catch((error) => {
            options.dismissToast?.(progressToastId);
            if (options.isActive?.() !== false) {
              options.showToast(
                options.formatMessage("sourceServer.updateFailedToast", {
                  source,
                }),
                {
                  durationMs: 10_000,
                  position: "top-center",
                  variant: "warning",
                  actionLabel: options.formatMessage("remote.action.details"),
                  onAction: () => {
                    if (state.sourceServerId) options.onDetails?.(state.sourceServerId);
                  },
                  dismissible: true,
                  dismissLabel: options.formatMessage("common.close"),
                },
              );
            }
            options.onError?.(error);
          });
      }
    : undefined;
  // 主通知的展示顺序在 handleUpdate 定义之后：按钮回调用的是闭包，不是提前求值。
  // 标题按「能否直接更新」与「是否必需」两维选择文案，两条分支互斥。
  const toastId = options.showToast(
    options.formatMessage(
      // 三选一的文案口径：必需升级、可选升级、控制器升级；不要在这里拼字符串。
      // current 与 available 用非空断言是安全的：能走到这里说明 key 已经通过四字段校验。
      canUpdateServer
        ? updateRequired
          ? "sourceServer.updateRequiredToast"
          : "sourceServer.updateAvailableToast"
        : "sourceServer.controllerUpdateAvailableToast",
      {
        source,
        current: state.currentVersion!,
        available: state.availableVersion!,
      },
    ),
    {
      durationMs: 8_000,
      position: "top-center",
      variant: "source-server-update",
      ...(handleUpdate
        ? {
            actionLabel: options.formatMessage("settings.source.updateNow"),
            onAction: handleUpdate,
          }
        : {}),
      dismissible: true,
      dismissLabel: options.formatMessage("common.close"),
    },
  );
  return { id: toastId };
}

// 控制器把「活跃展示」与「持久已读」分成两套状态，各自的生命周期不同。
// shown 只记录当前仍在屏幕上的 toast；preferences 记录永久去重，跨断线、重启仍然有效。
// 整个控制器只在 refresh 中读快照，其余路径不直接触发网络请求。
export function createSourceServerUpdateNotificationController(
  options: NotificationControllerOptions,
): SourceServerUpdateNotificationController {
  // 活跃 toast 随状态撤销；持久去重独立保留，不被断线、向导接管或重启清除。
  // key 到活跃 toast 的映射；同一 key 只会有一条，重复展示前必须查这张表。
  // dispose 与状态撤销都要遍历它来 dismiss，因此 entry 里必须保留可控的 id。
  const shown = new Map<string, { id: unknown }>();
  const preferences = options.preferences ?? sourceServerUpdatePreferences;
  let disposed = false;
  // [并发] 刷新单飞句柄：在途请求不重入，只把 queued 置位，结束后尾随再跑一次。
  // 这样高频状态事件不会放大成 N 次快照读取，也不会出现旧快照覆盖新快照。
  let refreshInFlight: Promise<void> | null = null;
  let refreshQueued = false;

  // refresh 是唯一入口：状态变化、目录变化、连接目标变化与手动调用都汇聚到这里。
  // disposed 后直接返回，保证卸载过程中的迟到事件不会重新建立订阅或展示。
  // 刷新失败只上报 onError，不改变已有活跃通知——网络抖动不应该让提示闪烁。
  const refresh = () => {
    if (disposed) return;
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }
    // 刷新链路固定为「读快照 → 计算 eligible → 撤销 → 新增」，顺序不能调换。
    // 中途若出现 queued 或 disposed，本轮结果直接丢弃，再做尾随刷新。
    refreshInFlight = options.management
      .getSnapshot()
      .then((snapshot) => {
        if (disposed || refreshQueued) return;
        // 以 eligible key 聚合当前应该展示的状态；同一 key 命中多条时后写覆盖，展示仍只有一条。
        // 这里只读快照，不做任何管理调用，避免读操作带出副作用。
        const eligible = new Map<string, SourceServerUpdateState>();
        for (const state of snapshot.states) {
          const key = getEligibleNotificationKey(options, snapshot, state);
          if (key) eligible.set(key, state);
        }
        // updating/已完成/移除/向导接管时，立即撤销旧提示；不能只跳过新提示、等旧按钮超时。
        // 状态从 eligible 中消失（开始更新、已完成、被移除、向导接管）时必须立刻撤销旧提示。
        // 只跳过新增而不撤销，会让旧按钮在超时前一直可点，用户会对着已经过期的状态重复操作。
        // dismiss 后同步删除 map entry，保证下一轮不会对同一个 id 再关一次。
        for (const [key, notification] of shown) {
          if (eligible.has(key)) continue;
          options.dismissToast?.(notification.id);
          shown.delete(key);
        }
        // 新增展示前先过两道去重：当前正在展示，或历史上已经看过该 key。
        // markSeen 只在 show 返回非空时写入：key 不可展示时不能提前占掉永久去重名额。
        // isActive 传入的是「未 disposed」的实时判断，回调触发时再复查一次。
        for (const [key, state] of eligible) {
          if (shown.has(key) || preferences.hasSeen(key)) continue;
          const notification = showSourceServerUpdateNotification({
            ...options,
            snapshot,
            state,
            isActive: () => !disposed,
          });
          if (notification) {
            shown.set(key, notification);
            preferences.markSeen(key);
          }
        }
      })
      .catch((error) => options.onError?.(error))
      // 无论刷新成功失败都要释放单飞句柄；queued 且未卸载时立刻补跑一轮。
      // 补跑放在 finally 而不是 then，失败后的排队请求同样需要被执行。
      .finally(() => {
        refreshInFlight = null;
        if (refreshQueued && !disposed) {
          refreshQueued = false;
          refresh();
        }
      });
  };

  // 同时订阅状态与目录：设备列表变化也会改变展示名与可升级性，不能只订阅状态。
  // 两个订阅都必须持有句柄，dispose 时逐一释放，避免控制器回收后事件仍在回调。
  const stateSubscription = options.management.onDidChangeState(refresh);
  const directorySubscription = options.management.onDidChangeDirectory?.(refresh);
  refresh();
  return {
    refresh,
    // dispose 先置位再释放订阅：置位之后任何迟到回调都会在入口处直接返回。
    // 随后 dismiss 所有活跃 toast 并清空 map，保证组件卸载后屏幕上不残留提示。
    // 持久已读不在这里清理，它是跨会话的去重数据，和本次挂载无关。
    dispose() {
      disposed = true;
      stateSubscription.dispose();
      directorySubscription?.dispose();
      for (const notification of shown.values()) options.dismissToast?.(notification.id);
      shown.clear();
    },
  };
}

// Hook 只负责把 React 侧能力注入控制器：管理服务、文案、toast、确认框与设置页跳转。
// enabled 或 management 缺失时不建控制器，直接返回空的回调函数。
// 返回的函数用于上报「当前连接目标」变化，供通知侧做向导接管抑制。
export function useSourceServerUpdateNotifications(options: {
  enabled: boolean;
  management?: ISourceServerManagementService;
}): (target: RemoteTarget | null) => void {
  const connectionTargetRef = useRef<RemoteTarget | null>(null);
  const controllerRef = useRef<SourceServerUpdateNotificationController | null>(null);
  // 连接目标存在 ref 里而不是 state：它只影响下一次 refresh 的判断，不需要触发重渲染。
  // 变化后主动 refresh 一次，让已经被向导接管的通知立刻撤销。
  const handleConnectionTargetChange = useCallback((target: RemoteTarget | null) => {
    connectionTargetRef.current = target;
    controllerRef.current?.refresh();
  }, []);
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  useEffect(() => {
    if (!options.enabled || !options.management) return undefined;
    const controller = createSourceServerUpdateNotificationController({
      management: options.management,
      getConnectionTarget: () => connectionTargetRef.current,
      formatMessage: (id, values) => intl.formatMessage({ id }, values),
      showToast: toast,
      dismissToast: (id) => {
        if (typeof id === "number") dismissToast(id);
      },
      onDetails: (sourceServerId) => {
        setPendingSettingsSectionIntent("remoteDevices", {
          sourceServerId,
          sourceServerDetails: true,
        });
        openSettingsTab();
      },
      onProgress: (sourceServerId) => {
        setPendingSettingsSectionIntent("remoteDevices", { sourceServerId });
        openSettingsTab();
      },
      // 强更确认走统一确认框，取消返回 false；控制器会把 false 当成用户放弃并静默结束。
      // 描述文案由 lib 层根据设备状态生成，确保与真实影响一致，而不是在 UI 硬编码。
      confirmForce: async (profileId) =>
        await confirmDialog({
          title: intl.formatMessage({
            id: "settings.source.forceUpdateTitle",
          }),
          description: await getSourceServerForceUpdateDescription(
            options.management!,
            profileId,
            (id) => intl.formatMessage({ id }),
          ),
          confirmLabel: intl.formatMessage({
            id: "settings.source.forceUpdate",
          }),
          confirmVariant: "destructive",
        }),
      onError: (error) =>
        logger.warn("[sourceServerUpdateNotifications] 读取 Source 版本状态失败", {
          error: error instanceof Error ? error.message : String(error),
        }),
    });
    controllerRef.current = controller;
    // 卸载时先清 ref 再 dispose：清 ref 让仍在途的回调拿不到控制器，dispose 负责收尾。
    // effect 依赖包含管理服务与文案函数；任一变化都会重建控制器，旧实例必须先释放订阅。
    return () => {
      controllerRef.current = null;
      controller.dispose();
    };
  }, [confirmDialog, intl, openSettingsTab, options.enabled, options.management]);
  return handleConnectionTargetChange;
}
