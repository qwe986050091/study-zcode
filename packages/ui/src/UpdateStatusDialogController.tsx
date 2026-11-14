// INV-01 守住位置：displayVersion 为空时组件唯一出口返回 null；改错故障：放宽成只判 updateState 会让无版本帧也挂载弹窗，遮住入口。
// INV-02 守住位置：lastVisibleUpdateStatusViewModelSelection 仅在 displayVersion 非空时写入；改错故障：过渡帧覆盖快照会让回退链断裂，弹窗闪空。
// INV-03 守住位置：renderedUpdateStatusViewModel 只在动作进行中且实时模型缺版本时回退；改错故障：无条件回退会让首帧拿到 null 或旧版本模型。
// INV-04 守住位置：setUpdateActionInFlight 先写 ref 再写 state；改错故障：顺序颠倒会在同一帧第二次点击时读到旧锁，重复发 IPC。
// INV-05 守住位置：每个动作入口先判 updateActionInFlightRef.current；改错故障：只判 state 会因更新异步而漏掉连点，main 收到并发命令。
// INV-06 守住位置：下载与取消只锁按钮，阶段完全跟随 main 广播；改错故障：ACK 后自置下载中会闪出无意义的 0% 帧。
// INV-07 守住位置：每个动作的 catch 先清锁再抛出；改错故障：吞掉错误会让按钮永久 pending，全局错误处理也收不到原因。
// INV-08 守住位置：勾选自动下载且状态为 update-available 时复用同一下载入口；改错故障：另开下载路径会绕过互斥锁与缓存命中判断。
// INV-09 守住位置：skip 在 skippableVersion 为空时直接返回；改错故障：对空版本调用忽略接口会写入无效版本记录。
// INV-10 守住位置：重启确认在加锁之前完成，取消则原样返回；改错故障：先加锁再确认会让取消路径没有解锁点，按钮卡死。
// INV-11 守住位置：restart 分支不挂 1500ms 兜底定时器，只在状态离开 update-downloaded 时解锁；改错故障：加超时会在应用退出前误判失败，诱导重复点击。
// INV-12 守住位置：动作仍 pending 但 main 已广播离开 ready 的状态时释放锁；改错故障：只依赖 IPC 结果会在窗口生命周期后永久 pending。
// INV-13 守住位置：偏好订阅在 effect 清理中取消，异步回调先查 disposed；改错故障：卸载后写状态会告警，订阅叠加会重复刷新。
// INV-14 守住位置：releaseNotesCacheKey 由 locale 与 displayVersion 共同决定；改错故障：只按版本缓存会在切换语言后显示旧语言正文。
// INV-15 守住位置：日志缓存上限 8 条，超出只淘汰最早插入的键；改错故障：去掉上限会让长会话内存无界增长。
// INV-16 守住位置：下载阶段对外传 null 隐藏日志，缓存仍继续写入；改错故障：把隐藏做在写入之前会让下载完成后无内容可恢复。
// INV-17 守住位置：渲染期读缓存只做精确键匹配，不回退到任意条目；改错故障：宽松命中会把其他版本的日志显示在当前版本上。
// INV-18 守住位置：updateState 非 null 且无 displayVersion 时关闭弹窗；改错故障：把 null 也算作关闭条件会在初始化帧误关刚打开的弹窗。
//
// 模块职责：把 main 广播的更新状态投影成弹窗模型，并把用户动作转换为 IPlatformService 调用。
// 状态所有权：更新阶段与版本归 main，本组件只持有动作互斥锁、偏好镜像与日志缓存。
// 阅读顺序：先看 renderedUpdateStatusViewModel 的回退条件，再看四个 effect 的收口，最后看各动作 handler 的加锁与解锁。
import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { UpdateStatusDialog } from "@/UpdateStatusDialog.js";
import { formatUpdateReleaseDate, getLocalizedUpdateReleaseNotes } from "@/updateReleaseNotes.js";
import {
  deriveUpdateStatusViewModel,
  isUpdateActionCompleted,
  type UpdateActionInFlight,
  type UpdateStatusViewModel,
} from "@/updateStatusModel.js";

// 对外契约：受控弹窗，open 与 onOpenChange 由上层持有，组件内部不自行开关弹窗。
// platform 注入取代直接访问 window.zcode，桌面与 Web 的差异全部收敛在 IPlatformService 实现里。
// edgeToEdge 与 showOverlay 只影响外观，不参与可见性判断，改错会连带破坏桌面沉浸布局。
// 改错后果：在组件内打开弹窗，上层无法预测关闭时机，弹窗串行与焦点回收都会失效。
export function UpdateStatusDialogController({
  platform,
  version,
  updateState,
  open,
  onOpenChange,
  edgeToEdge = false,
  showOverlay = true,
}: {
  platform: IPlatformService;
  version: string | null;
  updateState: UpdateStatePayload | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  edgeToEdge?: boolean;
  showOverlay?: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const [autoDownloadAndInstallUpdates, setAutoDownloadAndInstallUpdates] = useState(false);
  const [updateActionInFlight, setUpdateActionInFlightState] = useState<UpdateActionInFlight>(null);
  // 互斥锁必须同时存在两份：ref 供同一事件循环内同步判重，state 供渲染层禁用按钮。
  // 只留 state 时，快速连点会在更新生效前穿透，main 侧收到重复 IPC。
  // 只留 ref 时，界面不会进入 pending，用户看不到按钮已锁，体验上像卡死。
  // setUpdateActionInFlight 先写 ref 再写 state，顺序反过来就失去同帧判重能力。
  // 改错后果：删掉任一副本都会让下载、取消、重启出现并发执行或重复提示。
  const updateActionInFlightRef = useRef<typeof updateActionInFlight>(null);
  const releaseNotesCacheRef = useRef(
    new Map<
      string,
      {
        releaseDateLabel: string | null;
        releaseNotes: { title: string; markdown: string };
      }
    >(),
  );
  const setUpdateActionInFlight = useCallback((nextAction: typeof updateActionInFlight) => {
    updateActionInFlightRef.current = nextAction;
    setUpdateActionInFlightState(nextAction);
  }, []);
  const updateStatusViewModel = deriveUpdateStatusViewModel({
    legacyReadyVersion: version,
    updateState,
  });
  const lastVisibleUpdateStatusViewModelSelection = useRef<UpdateStatusViewModel | null>(null);
  // 回退只在 `updateActionInFlight` 非空且实时模型缺 `displayVersion` 时生效。
  // 无命令进行时无条件使用实时模型，main 广播的失败或完成状态才能立即透出。
  // 快照只保存带版本的模型，来源更新见下方 effect 的提前返回守卫。
  // 改错后果：一直用快照会让进度冻在旧值；从不回退会让过渡帧卸载弹窗并丢焦点。
  const renderedUpdateStatusViewModel =
    updateStatusViewModel.displayVersion || updateActionInFlight === null
      ? updateStatusViewModel
      : (lastVisibleUpdateStatusViewModelSelection.current ?? updateStatusViewModel);
  const {
    dialogPhase,
    displayVersion,
    progressLabel,
    progressValue,
    releaseNotesPayload: updateReleaseNotesPayload,
    skippableVersion,
  } = renderedUpdateStatusViewModel;
  // 说明正文与发布日期分别本地化：正文按 locale 挑选，日期走独立 formatter，两者都允许为空。
  // 缓存键由 locale 与 displayVersion 组成；只按版本缓存，切语言后会命中旧语言正文。
  // 键为 null 表示当前没有可缓存版本，所有读写都要先判空，否则会写入空键条目。
  // 改错后果：把日期格式化塞进正文函数，缺 releaseDate 时整段说明会一起消失。
  const localizedUpdateReleaseNotes = getLocalizedUpdateReleaseNotes(
    updateReleaseNotesPayload,
    locale,
  );
  const formattedReleaseDate = formatUpdateReleaseDate(
    updateReleaseNotesPayload?.releaseDate,
    locale,
  );
  const releaseNotesCacheKey = displayVersion ? `${locale}:${displayVersion}` : null;

  useEffect(() => {
    if (!updateStatusViewModel.displayVersion) {
      return;
    }

    // 点击“下载更新”后，真实下载进度依赖 main 侧异步广播。
    // 中间若短暂收到 checking/idle 等不带版本的过渡状态，不能让入口 return null
    // 连带卸载已打开的弹窗；命令进行中复用上一帧可见模型，等进度态收口。
    // effect 守卫要求 displayVersion 非空才写快照，空版本过渡态直接提前返回。
    // 提前返回是核心不变量：把赋值提到守卫之前，checking 或 idle 帧会把快照冲成无版本模型。
    // 依赖只有 updateStatusViewModel，快照随每次模型变化刷新，不做节流或去重。
    // 改错后果：快照被冲掉后回退链失效，下载刚开始的一两帧弹窗会空掉或闪回入口。
    lastVisibleUpdateStatusViewModelSelection.current = updateStatusViewModel;
  }, [updateStatusViewModel]);

  useEffect(() => {
    // disposed 覆盖读取偏好与订阅回调两条异步路径，组件卸载后禁止回写 state。
    // 平台设置订阅可能不存在，可选调用后要用空函数兜底，但兜底函数仍必须参与清理。
    // 读取偏好失败时回落为关闭自动下载，不能把异常态显示成已开启。
    // 改错后果：漏掉 disposed 会在卸载后写状态；漏掉清理会让设置变更触发多份刷新。
    let disposed = false;

    const refreshAutoUpdatePreferences = () => {
      void platform
        .getAutoUpdatePreferences?.()
        .then((preferences) => {
          if (!disposed) {
            setAutoDownloadAndInstallUpdates(preferences.autoDownloadAndInstallUpdates);
          }
        })
        .catch(() => {
          if (!disposed) {
            setAutoDownloadAndInstallUpdates(false);
          }
        });
    };

    refreshAutoUpdatePreferences();
    const disposeSettingsChanged =
      platform.onSettingsChanged?.(refreshAutoUpdatePreferences) ?? (() => {});

    return () => {
      disposed = true;
      disposeSettingsChanged();
    };
  }, [platform]);

  useEffect(() => {
    if (!releaseNotesCacheKey || !localizedUpdateReleaseNotes) {
      return;
    }

    // 下载中会隐藏更新日志，但 electron-updater 的 update-downloaded
    // 事件在部分平台只稳定带 version。缓存当前版本的说明，下载完成后即使 ready
    // 状态缺少 releaseNotes，也能把刚才隐藏的内容恢复显示。
    releaseNotesCacheRef.current.set(releaseNotesCacheKey, {
      releaseDateLabel: formattedReleaseDate,
      releaseNotes: localizedUpdateReleaseNotes,
    });
    if (releaseNotesCacheRef.current.size > 8) {
      const oldestCacheKey = releaseNotesCacheRef.current.keys().next().value;
      if (oldestCacheKey) {
        releaseNotesCacheRef.current.delete(oldestCacheKey);
      }
    }
  }, [formattedReleaseDate, localizedUpdateReleaseNotes, releaseNotesCacheKey]);

  const cachedReleaseNotes = releaseNotesCacheKey
    ? releaseNotesCacheRef.current.get(releaseNotesCacheKey)
    : undefined;
  const restoredUpdateReleaseNotes =
    localizedUpdateReleaseNotes ?? cachedReleaseNotes?.releaseNotes ?? null;
  const restoredReleaseDate = formattedReleaseDate ?? cachedReleaseNotes?.releaseDateLabel ?? null;
  // 下载阶段对外传 null 隐藏日志，避免长正文挤压进度区；隐藏只影响展示，不影响缓存写入。
  // 恢复来源优先实时说明，其次命中的缓存；两者都缺才为 null，弹窗需自行处理空说明。
  // 缓存恢复专为下载完成事件只带 version 的平台准备，不能让缓存优先于实时值。
  // 改错后果：把缓存放在实时值前面，用户会看到旧内容或旧语言日志覆盖新正文。
  const visibleUpdateReleaseNotes =
    dialogPhase === "downloading" ? null : restoredUpdateReleaseNotes;
  const handleOpenReleaseNotesExternalUrl = useCallback(
    (url: string) => platform.openExternal(url),
    [platform],
  );
  // 所有动作入口先查 ref 再上锁；这里只锁按钮，不乐观切换下载阶段。
  // 命中本地缓存时 main 会直接广播下载完成，若在 ACK 后自置下载中会闪一帧 0%。
  // 失败路径先清锁再抛出，让上层与全局错误处理拿到原始错误对象。
  // 改错后果：吞掉错误会让按钮永久 pending；提前切阶段会让用户看到假进度。
  const handleDownloadUpdate = useCallback(async () => {
    if (updateActionInFlightRef.current) {
      return;
    }

    // 如果 electron-updater 命中本地已下载缓存，main 侧会直接广播
    // update-downloaded。renderer 不能在 IPC ACK 前后乐观切到“下载中”，否则会闪过
    // 一帧无意义的 0%/下载态；这里只锁按钮，真实阶段完全跟随 main 的状态广播。
    setUpdateActionInFlight("download");
    try {
      await platform.downloadUpdate();
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [platform, setUpdateActionInFlight]);
  const handleAutoDownloadAndInstallUpdatesChange = useCallback(
    async (enabled: boolean) => {
      setAutoDownloadAndInstallUpdates(enabled);
      await platform.setAutoDownloadAndInstallUpdates?.(enabled);
      if (enabled && updateState?.kind === "update-available") {
        // 功能原因：用户在“已发现更新”弹窗里勾选自动下载时，期望当前版本也进入自动流程。
        // 这里只触发同一个下载入口；真正是否下载、缓存命中和状态广播仍由 main 进程裁决。
        await handleDownloadUpdate();
      }
    },
    [handleDownloadUpdate, platform, updateState?.kind],
  );
  const handleCancelDownload = useCallback(async () => {
    if (updateActionInFlightRef.current) {
      return;
    }

    setUpdateActionInFlight("cancel");
    try {
      await platform.cancelUpdateDownload();
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [platform, setUpdateActionInFlight]);
  const handleSkipUpdate = useCallback(async () => {
    if (!skippableVersion || updateActionInFlightRef.current) {
      return;
    }
    setUpdateActionInFlight("skip");
    try {
      await platform.skipUpdateVersion(skippableVersion);
      onOpenChange(false);
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [onOpenChange, platform, setUpdateActionInFlight, skippableVersion]);
  const handleRestartUpdate = useCallback(async () => {
    if (updateActionInFlightRef.current) {
      return;
    }

    // 重启前先问桌面会话活动数，确认失败要原样返回；此刻尚未上锁，不需要解锁。
    // 确认弹窗用当前 displayVersion 作为标题参数，缺版本时传空串，不能省略参数对象。
    // 可选的活动查询缺失时按 0 处理，Web 环境不会因此被阻断重启。
    // 改错后果：把加锁提到确认之前，用户点取消后按钮会一直 pending，只能关窗恢复。
    const activity = await platform.getDesktopSessionActivity?.();
    const runningTaskCount = activity?.runningAgentSessionCount ?? 0;
    if (runningTaskCount > 0) {
      const confirmed = await requestConfirmation({
        title: intl.formatMessage(
          { id: "updateReady.confirm.title" },
          {
            version: displayVersion ?? "",
          },
        ),
        description: intl.formatMessage({
          id: "updateReady.confirm.description",
        }),
        confirmLabel: intl.formatMessage({ id: "updateReady.confirm.ok" }),
        cancelLabel: intl.formatMessage({ id: "updateReady.confirm.cancel" }),
      });
      if (!confirmed) {
        return;
      }
    }

    // 重启安装之前是 fire-and-forget，renderer 发完 IPC 就关闭弹窗。
    // dev/mock 下 updater 若没有接管安装，用户只会看到弹窗消失，误以为按钮没有响应。
    setUpdateActionInFlight("restart");
    try {
      await platform.quitAndInstallUpdate();
    } catch (error) {
      setUpdateActionInFlight(null);
      throw error;
    }
  }, [displayVersion, intl, platform, requestConfirmation, setUpdateActionInFlight]);

  useEffect(() => {
    if (!displayVersion && updateState !== null) {
      onOpenChange(false);
    }
  }, [displayVersion, onOpenChange, updateState]);

  useEffect(() => {
    if (!updateActionInFlight) {
      return;
    }

    if (isUpdateActionCompleted(updateActionInFlight, updateState)) {
      setUpdateActionInFlight(null);
      return;
    }

    // 退出准备和 Windows 安装器交接可能超过 5 秒；旧的统一 ACK 定时器会在
    // 应用真正退出前恢复“重启以更新”，让用户误判失败并重复点击。restart 成功路径保持
    // pending 直到应用退出，只有 IPC 明确失败时才由调用处 catch 恢复按钮。
    if (updateActionInFlight === "restart") {
      if (updateState !== null && updateState.kind !== "update-downloaded") {
        // main 会在退出准备失败时广播 error/idle。即使 IPC reject 因窗口
        // 生命周期丢失，状态已经离开 ready 也必须释放按钮，不能保留上一帧永久 pending。
        setUpdateActionInFlight(null);
      }
      return;
    }

    // 下载/取消 IPC 在 main 进程会立即 ACK，真实状态靠后续广播收口。
    // 连点时需要先锁住按钮；若广播丢失或 main 侧 no-op，也要短超时释放，避免 UI 自己卡住。
    // 只有下载、取消、跳过走 1500ms 兜底：这些 IPC 立即 ACK，真实结果靠广播收口。
    // 广播丢失或 main 侧空操作时定时器释放按钮，宁可让用户重试，也不让界面永久 pending。
    // 重启分支在到达这里之前已经返回，不能给重启加超时，否则会诱导重复点击安装。
    // 改错后果：把定时器挪到重启分支之前，退出准备稍慢就会恢复按钮并呈现假失败。
    const timeout = globalThis.setTimeout(() => {
      setUpdateActionInFlight(null);
    }, 1500);

    return () => {
      globalThis.clearTimeout(timeout);
    };
  }, [setUpdateActionInFlight, updateActionInFlight, updateState?.kind]);

  if (!displayVersion) return null;

  const releaseDateLabel = restoredReleaseDate
    ? intl.formatMessage({ id: "updateDialog.releaseDate" }, { date: restoredReleaseDate })
    : null;

  return (
    <UpdateStatusDialog
      autoDownloadAndInstallUpdates={autoDownloadAndInstallUpdates}
      displayVersion={displayVersion}
      edgeToEdge={edgeToEdge}
      intl={intl}
      isUpdateActionPending={updateActionInFlight !== null}
      localizedUpdateReleaseNotes={visibleUpdateReleaseNotes}
      onAutoDownloadAndInstallUpdatesChange={handleAutoDownloadAndInstallUpdatesChange}
      onCancelDownload={handleCancelDownload}
      onDownloadUpdate={handleDownloadUpdate}
      onOpenChange={onOpenChange}
      onOpenReleaseNotesExternalUrl={handleOpenReleaseNotesExternalUrl}
      onRestartUpdate={handleRestartUpdate}
      onSkipUpdate={handleSkipUpdate}
      open={open}
      phase={dialogPhase}
      progressLabel={progressLabel}
      progressValue={progressValue}
      releaseDateLabel={releaseDateLabel}
      showOverlay={showOverlay}
      skippableVersion={skippableVersion}
    />
  );
}
