// INV-01 版本显示有优先级：守住位置 ready 到 progress 到 available 的空值链；改错故障 下载中显示旧版本。
// INV-02 下载态缺版本用占位符：守住位置 "…" 分支；改错故障 某一帧缺版本让弹窗卸载。
// INV-03 阶段与版本同源：守住位置 dialogPhase 三元；改错故障 显示已下载但仍处于下载阶段。
// INV-04 legacy ready 仅在新状态缺位时兜底：守住位置 updateState === null；改错故障 旧缓存盖掉新状态。
// INV-05 有新状态就不再显示重启：守住位置 resolveReadyVersion 末尾；改错故障 checking 时仍提示重启。
// INV-06 跳过只对两种状态开放：守住位置 skippableVersion 判定；改错故障 已下载版本还能跳过。
// INV-07 通道只在三种状态暴露：守住位置 updateChannel 判定；改错故障 未知状态带出过期通道。
// INV-08 进度值钳制到 0~100：守住位置 Math.max/min；改错故障 异常进度把进度条撑破。
// INV-09 非有限进度归零：守住位置 Number.isFinite；改错故障 NaN 进入样式计算。
// INV-10 进度文案需字节齐全：守住位置 四个类型与范围检查；改错故障 显示 NaNMB / 0MB。
// INV-11 缺总大小时不显示百分比：守住位置 末尾 return null；改错故障 新旧口径混在同一条文案里。
// INV-12 下载完成需看到进度或完成态：守住位置 action 与 kind 的与运算；改错故障 过渡态提前释放按钮锁。
// INV-13 取消完成要求离开下载态：守住位置 cancel 分支；改错故障 取消失败也解锁。
// INV-14 跳过完成要求离开可更新与下载态：守住位置 skip 的双不等；改错故障 仍在可更新时解锁。
//
// 模块职责：把主进程更新状态推导成弹窗视图模型，并判定动作是否完成。
// 阅读顺序：先看两个类型与推导函数，再看动作完成判定，最后看进度、发布说明与格式化。
import type {
  ElectronReleaseChannel,
  PostUpdateReleaseNotesPayload,
  UpdateStatePayload,
} from "@zcode/shared";

export type UpdateStatusDialogPhase =
  | "before-download"
  | "downloading"
  | "downloaded";

export type UpdateActionInFlight =
  | "download"
  | "cancel"
  | "skip"
  | "restart"
  | null;

export type UpdateStatusViewModel = {
  dialogPhase: UpdateStatusDialogPhase;
  displayVersion: string | null;
  progressLabel: string | null;
  progressValue: number;
  releaseNotesPayload: PostUpdateReleaseNotesPayload | undefined;
  skippableVersion: string | null;
  updateChannel: ElectronReleaseChannel | undefined;
};

// 视图模型一次推导完，组件不再自行分支。
export function deriveUpdateStatusViewModel({
  legacyReadyVersion,
  updateState,
}: {
  legacyReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
}): UpdateStatusViewModel {
  const isDownloadingUpdate = updateState?.kind === "download-progress";
  const readyVersion = resolveReadyVersion({ legacyReadyVersion, updateState });
  const progressVersion = isDownloadingUpdate ? updateState.version : null;
  const availableVersion =
    updateState?.kind === "update-available" ? updateState.version : null;
  // displayVersion 由三档依次回退：readyVersion、progressVersion、availableVersion，取第一个非空值。
  const displayVersion =
    readyVersion ??
    progressVersion ??
    availableVersion ??
    // download-progress.version 是协议可选字段。下载态必须按 kind 保持 UI，
    // 否则某一帧缺少版本号会让入口卸载并关闭已打开弹窗。
    // 下载态缺版本用占位符，避免弹窗卸载。
    (isDownloadingUpdate ? "…" : null);

  return {
    // dialogPhase 与 displayVersion 同源，都由 readyVersion 与 isDownloadingUpdate 推导。
    dialogPhase: readyVersion
      ? "downloaded"
      : isDownloadingUpdate
        ? "downloading"
        : "before-download",
    displayVersion,
    progressLabel: getUpdateDownloadProgressLabel(updateState),
    progressValue: getUpdateDownloadProgressValue(updateState),
    releaseNotesPayload: getUpdateReleaseNotesPayload(updateState),
    skippableVersion:
      updateState?.kind === "update-available" ||
      updateState?.kind === "download-progress"
        ? (updateState.version ?? null)
        : null,
    updateChannel:
      updateState?.kind === "update-available" ||
      updateState?.kind === "download-progress" ||
      updateState?.kind === "update-downloaded"
        ? updateState.channel
        : undefined,
  };
}

// isUpdateActionCompleted 集中判定动作锁释放，download 与 cancel 各有独立条件。
export function isUpdateActionCompleted(
  action: UpdateActionInFlight,
  updateState: UpdateStatePayload | null,
) {
  return (
    // 点击下载后 main 侧可能先广播 checking/idle 等过渡态。
    // 这些状态不代表下载已经进入可观察阶段，不能释放按钮锁并触发弹窗卸载；
    // 只有真正进入下载进度或下载完成，才算下载命令完成。
    // download 只有在 kind 为 download-progress 或 update-downloaded 时才算完成。
    (action === "download" &&
      (updateState?.kind === "download-progress" ||
        updateState?.kind === "update-downloaded")) ||
    // 离开下载态才算取消完成。
    (action === "cancel" && updateState?.kind !== "download-progress") ||
    (action === "skip" &&
      updateState?.kind !== "update-available" &&
      updateState?.kind !== "download-progress")
  );
}

export function getUpdateDownloadProgressLabel(
  updateState: UpdateStatePayload | null,
) {
  // 非下载态没有进度文案。
  if (updateState?.kind !== "download-progress") {
    return null;
  }

  const { totalBytes, transferredBytes } = updateState;
  if (
    // 字节数必须有限且非负才展示。
    typeof transferredBytes === "number" &&
    Number.isFinite(transferredBytes) &&
    transferredBytes >= 0 &&
    typeof totalBytes === "number" &&
    Number.isFinite(totalBytes) &&
    totalBytes > 0
  ) {
    return `${formatMegabytes(transferredBytes)} / ${formatMegabytes(totalBytes)}`;
  }

  // 下载进度文案已经改为展示已下载/总大小。只有百分比时继续显示
  // “0% / 42%” 会和新的大小口径冲突，且启动下载的临时态会残留一个 0%。
  return null;
}

function resolveReadyVersion({
  legacyReadyVersion,
  updateState,
}: {
  legacyReadyVersion: string | null;
  updateState: UpdateStatePayload | null;
}) {
  if (updateState?.kind === "update-downloaded") {
    return updateState.version;
  }

  // legacy UpdateReady 只是一份“曾经 ready”的缓存。
  // 一旦新的 UpdateState 已明确同步到 renderer，idle/checking/error 都应以新状态为准，
  // 不能继续用旧 version 撑出“重启以更新”按钮。
  // 旧缓存只在新状态完全缺位时兜底。
  return updateState === null ? legacyReadyVersion : null;
}

function getUpdateDownloadProgressValue(updateState: UpdateStatePayload | null) {
  const rawProgressValue =
    updateState?.kind === "download-progress"
      ? Number(updateState.progress)
      : 0;
  // 进度值钳制到 0~100。
  return Number.isFinite(rawProgressValue)
    ? Math.max(0, Math.min(100, rawProgressValue))
    : 0;
}

function getUpdateReleaseNotesPayload(updateState: UpdateStatePayload | null) {
  // 发布说明只随三种状态透传。
  return updateState?.kind === "update-available" ||
    updateState?.kind === "download-progress" ||
    updateState?.kind === "update-downloaded"
    ? updateState.releaseNotes
    : undefined;
}

// 统一按 MB 保留一位小数。
function formatMegabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
