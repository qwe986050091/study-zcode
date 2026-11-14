// INV-01 无版本不渲染：守住位置 展示版本判断；改错故障 空版本出现空按钮。
// INV-02 视图模型单一来源：守住位置 派生函数；改错故障 弹窗与按钮状态分叉。
// INV-03 日志缓存键含语言与版本：守住位置 模板拼接；改错故障 切换语言命中旧日志。
// INV-04 缓存上限八条：守住位置 容量判断；改错故障 长期运行内存持续增长。
// INV-05 淘汰取最旧键：守住位置 键迭代首项；改错故障 新条目立即被删。
// INV-06 实时日志优先于缓存：守住位置 空值合并顺序；改错故障 新日志被旧缓存覆盖。
// INV-07 下载中隐藏日志：守住位置 阶段判断；改错故障 进度区被日志挤占。
// INV-08 下载中按钮仍可点：守住位置 宽度条件；改错故障 用户无法进入窗口取消。
// INV-09 下载中改用旋转图标：守住位置 三元分支；改错故障 显示普通更新图标。
// INV-10 桌面优先开独立窗口：守住位置 能力判断；改错故障 网页弹窗与桌面窗口并存。
// INV-11 无窗口能力回退弹窗：守住位置 回退分支；改错故障 点击无任何反应。
// INV-12 弹窗开关归本组件：守住位置 局部开关；改错故障 外部无法关闭弹窗。
// INV-13 外部链接走平台能力：守住位置 打开外链回调；改错故障 直接跳转丢失鉴权。
// INV-14 响应式类名集中解析：守住位置 布局函数；改错故障 平台分支散落组件。
// INV-15 提示标题按阶段三选：守住位置 三元链；改错故障 下载中仍显示可用提示。
// INV-16 可访问名称与提示同源：守住位置 可访问名属性；改错故障 读屏与悬浮信息不一致。
// INV-17 下载态不复用展开规则：守住位置 旋转图标分支；改错故障 图标被隐藏。
// INV-18 本组件不写更新状态：守住位置 只读属性；改错故障 界面反向驱动更新机。
//
// `UpdateStatusButton` 组合顶部更新入口：`deriveUpdateStatusViewModel` 给状态，`tooltipTitle` 给提示，日志由 `releaseNotesCacheRef` 兜底，独立窗口与网页弹窗二选一。
// 状态所有权：弹窗开关与日志缓存为局部；更新状态由调用方传入。
// 阅读顺序：先看视图模型与缓存，再读按钮状态分支，最后看入口与弹窗挂载。
import type { IPlatformService, UpdateStatePayload } from "@zcode/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { UpdateStatusDialogController } from "@/UpdateStatusDialogController.js";
import { UpdateReleaseNotesTooltip } from "@/UpdateReleaseNotesTooltip.js";
import { ArrowDownToLine, LoaderCircle } from "lucide-react";
import { formatUpdateReleaseDate, getLocalizedUpdateReleaseNotes } from "@/updateReleaseNotes.js";
import { resolveUpdateButtonResponsiveClasses } from "@/updateStatusButtonLayout.js";
import { deriveUpdateStatusViewModel } from "@/updateStatusModel.js";

export function UpdateStatusButton({
  platform,
  version,
  updateState,
  isMacDesktop = false,
  isWindowsDesktop = false,
  className,
}: {
  platform: IPlatformService;
  version: string | null;
  updateState: UpdateStatePayload | null;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  className?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const [dialogOpen, setDialogOpen] = useState(false);
  // `releaseNotesCacheRef` 用 `locale:displayVersion` 作键缓存已本地化的日志；超过 8 条时删最早键；缓存不参与渲染判定。
  // 该缓存只在 `dialogPhase` 切换或弹窗外移后兜底展示，不写全局存储；组件卸载时随 ref 一起释放。
  const releaseNotesCacheRef = useRef(
    new Map<
      string,
      {
        releaseDateLabel: string | null;
        releaseNotes: { title: string; markdown: string };
      }
    >(),
  );
  const { expandWidthClass, hideIconClass, revealTextClass } = resolveUpdateButtonResponsiveClasses(
    { isMacDesktop, isWindowsDesktop },
  );
  const updateStatusViewModel = deriveUpdateStatusViewModel({
    legacyReadyVersion: version,
    updateState,
  });
  const {
    dialogPhase,
    displayVersion,
    progressLabel,
    releaseNotesPayload: updateReleaseNotesPayload,
  } = updateStatusViewModel;
  const localizedUpdateReleaseNotes = getLocalizedUpdateReleaseNotes(
    updateReleaseNotesPayload,
    locale,
  );
  const formattedReleaseDate = formatUpdateReleaseDate(
    updateReleaseNotesPayload?.releaseDate,
    locale,
  );
  const releaseNotesCacheKey = displayVersion ? `${locale}:${displayVersion}` : null;
  // 该 effect 在 `releaseNotesCacheKey` 或 `localizedUpdateReleaseNotes` 缺一即返回，避免把空日志写进缓存。
  // `formattedReleaseDate` 与日志一起入库，`size > 8` 时用 `Map.keys().next().value` 淘汰最旧键；写入不触发渲染，因此没有清理函数。
  useEffect(() => {
    if (!releaseNotesCacheKey || !localizedUpdateReleaseNotes) {
      return;
    }

    // 下载完成事件在部分平台只稳定带 version。入口 hover 继续缓存
    // 刚发现更新时的说明，确保弹窗外移后主入口行为仍和原来一致。
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
  // 用户开始下载后，弹窗主任务已经从“了解版本内容”切换到“观察下载进度”。
  // 继续展示更新日志会挤占进度区域，也会让主按钮 hover 和弹窗在下载中重复露出日志。
  const visibleUpdateReleaseNotes =
    dialogPhase === "downloading" ? null : restoredUpdateReleaseNotes;
  const handleOpenReleaseNotesExternalUrl = useCallback(
    (url: string) => platform.openExternal(url),
    [platform],
  );
  // `handleUpdateEntryClick` 优先调 `platform.openUpdateStatusWindow` 开独立窗口并直接返回，只有该方法缺失时才 `setDialogOpen(true)` 回落网页弹窗。
  // 回调依赖只有 `platform`，函数本身不发网络请求，版本数据全部来自上层传入的 `updateState`。
  const handleUpdateEntryClick = useCallback(() => {
    if (platform.openUpdateStatusWindow) {
      void platform.openUpdateStatusWindow();
      return;
    }

    setDialogOpen(true);
  }, [platform]);

  if (!displayVersion) return null;

  // 更新弹窗和按钮 hover 共用同一个更新日志标题，避免 feed 自带 releaseName 与正文标题重复。
  const releaseNotesTitle = intl.formatMessage(
    { id: "updateReady.releaseNotesTitle" },
    { version: displayVersion },
  );
  // `tooltipTitle` 三态取文案：`downloading` 优先 `progressLabel`（缺失时退回版本号），`downloaded` 用 `updateReady.tooltip`，其余用 `updateAvailable.tooltip`。
  // 所有分支都走 `intl.formatMessage` 并注入 `version` 或 `progress`，不在模板字符串里拼语言相关文案。
  const tooltipTitle =
    dialogPhase === "downloading"
      ? progressLabel
        ? intl.formatMessage(
            { id: "desktopMenu.help.downloadingUpdateProgress" },
            { progress: progressLabel },
          )
        : intl.formatMessage(
            { id: "desktopMenu.help.downloadingUpdateVersion" },
            { version: displayVersion },
          )
      : dialogPhase === "downloaded"
        ? intl.formatMessage({ id: "updateReady.tooltip" }, { version: displayVersion })
        : intl.formatMessage({ id: "updateAvailable.tooltip" }, { version: displayVersion });

  const readyButton = (
    <Button
      size={"xs"}
      variant={"secondary"}
      aria-label={tooltipTitle}
      onClick={handleUpdateEntryClick}
      className={cn(
        // 只把更新弹窗改成中性视觉，主页面更新入口要保留 success 色块，避免顶部状态提示变弱。
        // 自动下载不会主动打开更新窗口；下载态入口必须保持可点，用户才能进入窗口取消下载。
        // xs button 的固定 h-5 和展开态固定宽度只适配默认字号，UI 字号调大后会裁切文案。
        // 改用最小高度配合内容宽度，默认仍保持紧凑，较大字号则由文字自然撑开按钮。
        "h-auto min-h-5 gap-1 rounded-full py-0.5 font-medium leading-none text-ui-xs w-6 border-transparent bg-success text-success-foreground hover:bg-success/80 transition-all",
        dialogPhase !== "downloading" && expandWidthClass,
        className,
      )}
    >
      {dialogPhase === "downloading" ? (
        <LoaderCircle
          // 下载态本身要靠 spinner 表达 loading，不能复用普通更新图标的展开隐藏规则。
          className="size-3 shrink-0 animate-spin"
        />
      ) : (
        <ArrowDownToLine className={cn("size-3 shrink-0 inline", hideIconClass)} />
      )}
      {dialogPhase !== "downloading" ? (
        <span
          className={cn(
            "w-0 overflow-hidden absolute opacity-0 transition-all",
            ...revealTextClass,
          )}
        >
          {intl.formatMessage({ id: "updateReady.shortTitle" })}
        </span>
      ) : null}
    </Button>
  );

  const updateButton = visibleUpdateReleaseNotes ? (
    <UpdateReleaseNotesTooltip
      locale={locale}
      onOpenExternalUrl={handleOpenReleaseNotesExternalUrl}
      releaseDateLabel={restoredReleaseDate}
      releaseNotesMarkdown={visibleUpdateReleaseNotes.markdown}
      releaseNotesTitle={releaseNotesTitle}
    >
      {readyButton}
    </UpdateReleaseNotesTooltip>
  ) : (
    <ControlHintTooltip title={tooltipTitle} side="bottom">
      {readyButton}
    </ControlHintTooltip>
  );

  return (
    <>
      {updateButton}
      <UpdateStatusDialogController
        platform={platform}
        version={version}
        updateState={updateState}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  );
}
