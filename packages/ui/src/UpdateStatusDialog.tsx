// 更新状态弹窗：把 main 进程广播的更新状态机渲染成一次可交互的下载/安装会话。
// 本组件完全受控：阶段、版本、进度、待执行动作全部来自 props，自身不持有更新状态。
// 两种承载形态复用同一棵 content 树：主窗口内的 Radix Dialog 与 edgeToEdge 独立窗口。
//
// INV-01 phase 只有 before-download/downloading/downloaded 三种取值，且互斥必居其一；守住位置：isBeforeDownload/isDownloading/isDownloaded 三个派生布尔；改错故障：分支落空后按钮组错位，用户在错误阶段看到不可用的操作。
// INV-02 关闭弹窗（稍后/ESC/遮罩）只收起 UI，绝不取消正在进行的下载；守住位置：所有把 onOpenChange 传 false 的调用点；改错故障：用户以为退出即中止，安装包仍在后台写入磁盘。
// INV-03 下载阶段不渲染「稍后」，避免给出「关闭即取消」的错误暗示；守住位置：showLaterButton；改错故障：用户点稍后后发现下载继续，失去对流程的信任。
// INV-04 isUpdateActionPending 为真时所有触发 IPC 的按钮与复选框同时禁用；守住位置：每个 Button 的 disabled 与 Checkbox 的 disabled；改错故障：连点产生重复 download/skip/restart 命令，按钮可能永久 pending。
// INV-05 禁用只是第一道闸，父级还用 in-flight ref 二次拦截重复命令；守住位置：控制器里的 handle 回调；改错故障：键盘回车或极短间隔事件穿透 disabled，导致命令双发。
// INV-06 skip 仅在 before-download 且有 skippableVersion 时出现；守住位置：showSkipVersion；改错故障：下载中提供「跳过」，语义矛盾且会与取消下载竞争。
// INV-07 skip 成功后由父级关闭弹窗，本组件不自行改 open；守住位置：onSkipUpdate 调用点与只读的 open prop；改错故障：本地态与父级分叉，弹窗关不掉或立刻重开。
// INV-08 重启、取消下载、下载并更新三个动作互斥渲染；守住位置：按钮区的嵌套三元；改错故障：同一位置出现两个主按钮，焦点顺序与点击目标都不可预测。
// INV-09 重启按钮只在 downloaded 阶段出现；守住位置：isDownloaded 分支；改错故障：安装包未就绪就退出安装，重启后版本不变。
// INV-10 标题 i18n id 必须与阶段同步，只用 readyTitle/downloadingTitle/availableTitle；守住位置：dialogTitleId；改错故障：下载中标题仍写「可更新」，用户误判流程没有开始。
// INV-11 标题模板里的版本号由哨兵占位符切分，缺占位符时降级为纯文本；守住位置：getDialogTitleParts 的 marker 与 index；改错故障：直接拼接会出现重复 v 或语序错乱。
// INV-12 版本号必须独占 nowrap 节点，折行只允许发生在前缀与后缀的边界；守住位置：titleClassName 与 titleContent；改错故障：长版本号被拆成两行，或与前后缀黏连。
// INV-13 进度区只在 downloading 阶段挂载，并通过 aria-live 播报；守住位置：isDownloading 条件与 section 的 aria-live；改错故障：阶段切走时进度无提示消失，读屏用户收不到完成信号。
// INV-14 progressValue 由上游 clamp 到 0 到 100，本组件不再二次求界；守住位置：Progress 的 value 传参；改错故障：出现两套边界规则，进度条宽度越界或在完成瞬间闪回。
// INV-15 自动下载偏好的写入是异步的，失败不得在本地静默吞掉；守住位置：onCheckedChange 里的 void 调用；改错故障：勾选状态与持久化值长期不一致。
// INV-16 edgeToEdge 且 open 为 false 时整棵树卸载，不做隐藏；守住位置：组件末尾的提前返回；改错故障：不可见节点继续占用焦点与计时器。
// INV-17 edgeToEdge 分支不使用 DialogContent 与 DialogTitle，避免叠加第二层遮罩和焦点陷阱；守住位置：手写容器与 h2；改错故障：独立窗口出现窗中窗，ESC 与拖拽区失效。
// INV-18 两种承载形态共用同一份 content 元素，行为必须完全一致；守住位置：content 常量与两处渲染；改错故障：只改一处导致主窗口与独立窗口行为分叉。
import { CalendarDays } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Progress } from "@/components/ui/progress.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { UpdateStatusDialogPhase } from "@/updateStatusModel.js";

// [资源] 图标地址交给打包器按 import.meta.url 解析，打包后换成最终资源 URL，代码里不出现绝对路径。
// 加载失败只是少一张装饰图，不阻塞任何更新动作，因此没有等待解码或占位逻辑。
const macosDockIconUrl = new URL("../../../public/icon_512@2x.png", import.meta.url).href;

type LocalizedUpdateReleaseNotes = {
  markdown: string;
  title: string;
};

// 受控展示层：不订阅 IPC、不发请求，所有副作用经 on* 回调上抛，两种窗口共用同一实现。
// [并发] pending 与 phase 来自不同广播帧，必须容忍「尚未开始下载但按钮已禁用」的中间组合。
// 渲染期只做派生布尔与文案查表，无随机、无时间依赖，StrictMode 双调用下输出一致。
export function UpdateStatusDialog({
  displayVersion,
  edgeToEdge = false,
  intl,
  isUpdateActionPending,
  autoDownloadAndInstallUpdates,
  onAutoDownloadAndInstallUpdatesChange,
  onCancelDownload,
  onDownloadUpdate,
  onOpenChange,
  onRestartUpdate,
  onSkipUpdate,
  open,
  phase,
  progressLabel,
  progressValue,
  releaseDateLabel,
  showOverlay = true,
  skippableVersion,
}: {
  displayVersion: string;
  edgeToEdge?: boolean;
  intl: IntlInstance;
  isUpdateActionPending: boolean;
  autoDownloadAndInstallUpdates: boolean;
  localizedUpdateReleaseNotes: LocalizedUpdateReleaseNotes | null;
  onAutoDownloadAndInstallUpdatesChange: (enabled: boolean) => Promise<void>;
  onCancelDownload: () => Promise<void>;
  onDownloadUpdate: () => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onOpenReleaseNotesExternalUrl: (url: string) => void;
  onRestartUpdate: () => Promise<void>;
  onSkipUpdate: () => Promise<void>;
  open: boolean;
  phase: UpdateStatusDialogPhase;
  progressLabel: string | null;
  progressValue: number;
  releaseDateLabel: string | null;
  showOverlay?: boolean;
  skippableVersion: string | null;
}) {
  // phase 是三值判别联合，三个布尔在同一帧求出，后续分支只读它们，不会出现半新半旧的视图。
  // 三者互斥且必居其一，因此没有「都不是」的第四态；新增阶段时必须同步这三行派生。
  // [失败路径] 上游传入未知字符串时三者全假并落到下载按钮分支，属于可见降级而不是抛错。
  const isBeforeDownload = phase === "before-download";
  // 下载中是唯一同时暴露「取消下载」与进度条的阶段，其他阶段不得渲染取消入口。
  const isDownloading = phase === "downloading";
  // 已下载态没有退路：只剩重启与稍后，下载按钮必须消失，否则会重入下载流程。
  // 该状态由 main 的 update-downloaded 广播驱动，组件不根据本地文件存在性猜测。
  const isDownloaded = phase === "downloaded";
  // 标题必须与阶段同步：完成后切到「已就绪」，否则用户会以为还要再等一次下载。
  // 嵌套三元按 downloaded、downloading、默认 的顺序求值，顺序颠倒会让下载中显示可用标题。
  // 三个 id 都是既有 i18n key，缺 key 在开发环境直接报错，不会渲染成空标题。
  const dialogTitleId = isDownloaded
    ? "updateDialog.readyTitle"
    : isDownloading
      ? "updateDialog.downloadingTitle"
      : "updateDialog.availableTitle";
  const titleParts = getDialogTitleParts({
    displayVersion,
    intl,
    titleId: dialogTitleId,
  });
  // 跳过的前提是「有版本可跳」且「尚未开始下载」，缺一都会给出无法兑现的操作。
  // Boolean 把空串也判为不可跳，防止上游用空版本号表示无版本时按钮仍然出现。
  // 下载中不提供跳过：跳过是「以后不再提醒」，与中止下载是两件事，不能合并。
  const showSkipVersion = isBeforeDownload && Boolean(skippableVersion);
  // 稍后只在非下载阶段出现，见 INV-03；它的行为等价于把弹窗收起来，而不是中止流程。
  // 因此在 pending 期间它仍会渲染，只是被禁用，用户不会看到按钮位置突然变化。
  const showLaterButton = !isDownloading;
  // min-w-0 不能省：标题在 flex 行内，缺了它长版本号会把容器撑出弹窗宽度，截断链失效。
  // flex-wrap 只允许在 gap 处折行，配合版本 span 的 nowrap 保证版本号不会被拆开。
  const titleClassName =
    "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-base font-medium leading-5 text-foreground";
  // 拆成三个 span 让版本号独占不换行节点，前后缀各自可折行，语序完全交给翻译。
  // 前缀或后缀为空时返回 null 而不是空 span，否则 flex gap 会在空节点旁多出一段间距。
  const titleContent = (
    <>
      {titleParts.prefix ? <span>{titleParts.prefix}</span> : null}
      {titleParts.hasVersion ? (
        <span className="whitespace-nowrap">{titleParts.versionText}</span>
      ) : null}
      {titleParts.suffix ? <span>{titleParts.suffix}</span> : null}
    </>
  );
  // 两套尺寸策略：普通对话框限制在视口内，独立窗口占满 dvh 与 dvw 并把窗口装饰交给 BrowserWindow。
  // [权衡] 用 calc 而不是固定 max-w，是给小屏系统按钮留边距，固定宽度会把底部按钮顶出屏幕。
  // overflow-hidden 与内部滚动区成对出现，外层一旦可滚动，拖拽区会和内容一起位移。
  const contentClassName = cn(
    "max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] overflow-hidden p-5 sm:max-w-lg",
    edgeToEdge && !isDownloading
      ? // 普通/下载完成状态没有中间内容，不能继续使用 minmax(0,1fr)。
        // 否则 footer 会占满剩余窗口高度，按钮被垂直居中后看起来像中间有大块空白。
        "grid-rows-[auto_auto]"
      : "grid-rows-[auto_minmax(0,1fr)_auto]",
    edgeToEdge
      ? // 独立更新窗口已经由 BrowserWindow 提供窗口边框和阴影。
        // 这里不能再保留页内 DialogContent 的边框、阴影和视口边距，否则会出现“窗中窗”。
        "grid h-dvh max-h-none w-dvw max-w-none gap-5 border-0 bg-popover/98 pt-10 text-ui-base/relaxed text-foreground shadow-none sm:max-w-none [app-region:drag]"
      : "gap-5",
  );
  // content 一次构造、两处复用，Radix 分支与独立窗口分支不可能出现按钮行为漂移。
  // 组件没有 hook，重渲染完全由 props 驱动，卸载即释放，没有需要清理的副作用。
  const content = (
    <>
      <DialogHeader className="gap-0">
        <div className="flex min-w-0 items-center gap-3 [app-region:no-drag]">
          <img
            src={macosDockIconUrl}
            alt=""
            aria-hidden="true"
            // [平台] pointer-events-none 与关闭 draggable 配合，避免在 app-region:drag 区域内拖图标触发原生图片拖放。
            // -ml-[5px] 抵消图标自带的透明内边距，让视觉左边缘与标题文字对齐。
            className="pointer-events-none -ml-[5px] size-12 shrink-0 select-none shadow-none drop-shadow-none"
            draggable={false}
          />
          <div className="min-w-0 flex-1 space-y-1.5">
            {edgeToEdge ? (
              <h2 className={titleClassName}>{titleContent}</h2>
            ) : (
              <DialogTitle className={titleClassName}>{titleContent}</DialogTitle>
            )}
            {releaseDateLabel ? (
              <div className="inline-flex max-w-full items-center gap-1 text-ui-xs font-normal leading-4 text-foreground-subtle">
                <CalendarDays className="size-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{releaseDateLabel}</span>
              </div>
            ) : null}
          </div>
        </div>
      </DialogHeader>

      {isDownloading ? (
        <div className="min-h-0 overflow-y-auto [app-region:no-drag]">
          <section className="space-y-2" aria-live="polite">
            <div className="flex items-center justify-between gap-3">
              <span className="text-ui-base font-medium leading-5 text-foreground">
                {intl.formatMessage({ id: "updateDialog.downloadProgress" })}
              </span>
              {progressLabel ? (
                <span className="font-mono text-ui-base leading-5 text-foreground">
                  {progressLabel}
                </span>
              ) : null}
            </div>
            <Progress
              // value 直接用上游 clamp 后的数值，此处不再二次求界，避免两套边界规则互相打架。
              // [失败路径] 上游漏检给出 NaN 时宽度退化为 0 而不是崩溃，兜底责任在 updateStatusModel。
              value={progressValue}
              className="zcode-update-charge-progress h-2 bg-primary/15 dark:bg-primary/20"
              indicatorClassName="bg-primary"
            />
          </section>
        </div>
      ) : null}

      <div className={cn("[app-region:no-drag]", isDownloading ? "-mt-2" : null)}>
        {isBeforeDownload ? (
          <label className="mb-4 flex min-w-0 items-center gap-2 text-ui-base leading-5 text-foreground">
            <Checkbox
              checked={autoDownloadAndInstallUpdates}
              // [并发] 待执行动作期间复选框同步禁用：此时写偏好会与正在进行的下载竞争同一个状态源。
              // 禁用只覆盖输入、不隐藏控件，用户仍能看到当前偏好值，不会误以为设置被重置。
              disabled={isUpdateActionPending}
              // checked 含 indeterminate 三态，只有显式 true 才写入偏好，避免把中间态当布尔真值。
              // [失败路径] 写入是异步的，这里用 void 表示不等结果；拒绝由平台层上报，不能在此静默吞掉。
              onCheckedChange={(checked) => {
                void onAutoDownloadAndInstallUpdatesChange(checked === true);
              }}
            />
            <span className="min-w-0">
              {intl.formatMessage({
                id: "updateDialog.autoDownloadAndInstall",
              })}
            </span>
          </label>
        ) : null}
        <DialogFooter
          className={cn(
            "p-0 [app-region:no-drag]",
            edgeToEdge
              ? // 独立更新窗口宽度只有 480px，小于 Tailwind 的 sm 断点。
                // 继续依赖 sm:flex-row 会退化成移动端竖排，导致底部按钮布局和原桌面弹窗不一致。
                cn(
                  "flex-row items-center gap-3",
                  showSkipVersion ? "justify-between" : "justify-end",
                )
              : showSkipVersion
                ? "sm:justify-between"
                : "sm:justify-end",
          )}
        >
          {showSkipVersion ? (
            <div
              className={cn(
                "flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row",
                edgeToEdge ? "w-auto flex-row" : null,
              )}
            >
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="h-9 self-start px-4"
                disabled={isUpdateActionPending}
                // [并发] 点击后父级立刻置 pending 并禁用按钮，本地不做乐观置灰，避免 IPC 失败后按钮永久不可用。
                // 成功后由父级关闭弹窗，本组件不回写 open，受控语义保持单向。
                onClick={() => void onSkipUpdate()}
              >
                {intl.formatMessage({ id: "updateDialog.skipVersion" })}
              </Button>
            </div>
          ) : null}
          <div
            className={cn(
              "flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row sm:justify-end",
              edgeToEdge ? "w-auto flex-row justify-end" : null,
            )}
          >
            {showLaterButton ? (
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="h-9 px-4"
                disabled={isUpdateActionPending}
                // [权衡] 「稍后」只收起 UI，不发送任何 IPC；已在进行的下载继续，重开时进度仍在。
                // 传 false 而不是切换，避免重复点击时把已关闭的弹窗重新打开。
                onClick={() => onOpenChange(false)}
              >
                {intl.formatMessage({ id: "updateDialog.later" })}
              </Button>
            ) : null}
            {isDownloaded ? (
              <Button
                type="button"
                size="lg"
                className="h-9 px-4"
                disabled={isUpdateActionPending}
                // [失败路径] 重启成功路径会一直 pending 到进程退出，此处不做超时恢复，否则用户会误判失败并重复点击。
                // 父级在重启前可能弹出未保存任务确认，取消时不会产生任何状态变化。
                onClick={() => void onRestartUpdate()}
              >
                {intl.formatMessage({ id: "updateDialog.restartToUpdate" })}
              </Button>
            ) : isDownloading ? (
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="h-9 px-4"
                disabled={isUpdateActionPending}
                // [并发] 取消与下载共用同一个 in-flight 标志，二者不会同时在途；按钮禁用是该不变量在 UI 侧的体现。
                // 取消只是请求 main 停止下载，已写入的临时文件由主进程回收，组件不关心清理细节。
                onClick={() => void onCancelDownload()}
              >
                {intl.formatMessage({ id: "updateDialog.cancelDownload" })}
              </Button>
            ) : (
              <Button
                type="button"
                size="lg"
                className="h-9 px-4"
                disabled={isUpdateActionPending}
                // 下载命令发出后阶段仍由 main 广播决定，组件不做乐观切换，避免闪过一帧无意义的 0% 进度。
                // [权衡] 命中本地缓存时 main 会直接广播已下载，因此这里不能假设下一步一定是 downloading。
                onClick={() => void onDownloadUpdate()}
              >
                {intl.formatMessage({ id: "updateDialog.downloadAndUpdate" })}
              </Button>
            )}
          </div>
        </DialogFooter>
      </div>
    </>
  );

  // [资源] 关闭时直接卸载而不是隐藏：独立窗口没有可恢复的宿主，隐藏只会让不可见节点继续占用焦点与计时器。
  // 返回 null 之前无需清理，本组件不持有订阅或计时器，生命周期全部在控制器里。
  // [可访问性] 卸载后焦点交还系统窗口管理器，由主进程决定是否恢复到上一焦点元素。
  // 该分支不渲染遮罩，窗体本身就是模态边界，再叠一层会与无边框窗口的阴影冲突。
  if (edgeToEdge) {
    if (!open) {
      return null;
    }
    return (
      <div
        role="dialog"
        // [可访问性] 手写 dialog 语义：没有 Radix 时必须自己给出 role 与 modal 标记，否则读屏不会理解为模态。
        // 该容器没有焦点陷阱，独立窗口本身即唯一窗口，再套陷阱会与拖拽区抢事件。
        aria-modal="true"
        aria-describedby={undefined}
        className={contentClassName}
      >
        {content}
      </div>
    );
  }

  return (
    // Radix 负责焦点陷阱、ESC 与遮罩点击，三条路径最终都汇到同一个 onOpenChange。
    // [失败路径] ESC 在下载阶段同样能关闭弹窗，下载留在后台继续，取消必须显式点「取消下载」。
    // 重开时 Radix 把焦点移回首个可聚焦元素，因此阶段切换不能依赖上一次的焦点位置。
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // 去掉标题下方可见描述后，显式关闭 aria-describedby，避免 Radix 在开发环境提示缺少 Description。
        aria-describedby={undefined}
        showOverlay={showOverlay}
        showCloseButton={false}
        className={contentClassName}
      >
        {content}
      </DialogContent>
    </Dialog>
  );
}

// 纯函数，只做字符串切分，不依赖 intl 的具体结果，两种窗口形态复用同一套标题逻辑。
// [权衡] 用哨兵占位符而不是三个独立 key：语序交给译者，代码不必知道版本号该放前还是放后。
// 入参 titleId 已由调用方选好，函数不再判断阶段，避免阶段逻辑散落在两个地方。
function getDialogTitleParts({
  displayVersion,
  intl,
  titleId,
}: {
  displayVersion: string;
  intl: IntlInstance;
  titleId: string;
}) {
  // 哨兵必须足够独特，下划线包围的形式不会出现在自然语言里，避免与真实文案碰撞。
  // 约定占位符只出现一次，重复出现时其余部分会被当作普通文本保留，而不是报错。
  // [失败路径] 某语言漏写占位符时 indexOf 返回 -1，走 hasVersion 为假的降级而非抛错。
  const marker = "__ZCODE_UPDATE_VERSION__";
  const text = intl.formatMessage({ id: titleId }, { version: marker });
  const index = text.indexOf(marker);
  const rawPrefix = index >= 0 ? text.slice(0, index) : "";
  // [平台] 有些语言把 v 写在占位符之前，需要把 v 从前缀里摘出来再与版本号拼接。
  // 摘出的 v 与 displayVersion 合成整体，保证版本 span nowrap 时 v 不会孤零零留在上一行。
  // 不处理大写 V：模板统一使用小写，出现大写按文案缺陷处理，不新增代码分支。
  const versionPrefix = rawPrefix.endsWith("v") ? "v" : "";
  const prefix = (versionPrefix ? rawPrefix.slice(0, -versionPrefix.length) : rawPrefix).trim();

  // 返回四个字段，调用方只读 hasVersion 决定是否渲染版本 span，其余字段都是纯文本。
  // prefix 已经 trim，避免占位符两侧的空格在 flex gap 之外再撑出一段空白。
  return {
    hasVersion: index >= 0,
    prefix,
    // 找不到占位符时整段文本进 suffix，hasVersion 为假，标题仍然完整显示。
    // 截取起点用 marker.length 而不是硬编码数字，改占位符时无需同步第二处常量。
    suffix: index >= 0 ? text.slice(index + marker.length).trim() : text.trim(),
    versionText: `${versionPrefix}${displayVersion}`,
  };
}
