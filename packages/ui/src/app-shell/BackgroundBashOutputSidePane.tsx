// INV-01 仅可见时自动贴底：守住位置 布局副作用；改错故障 后台页抢滚动。
// INV-02 跟随态才滚到底：守住位置 条件；改错故障 用户上翻被强行拉回。
// INV-03 记录上次滚动位置：守住位置 引用；改错故障 无法判断上翻。
// INV-04 上翻即暂停跟随：守住位置 比较；改错故障 新输出持续抢滚动。
// INV-05 回到底部恢复跟随：守住位置 距离判断；改错故障 悬浮箭头常驻。
// INV-06 底部阈值留余量：守住位置 八像素；改错故障 差一像素不恢复。
// INV-07 手动滚到底也恢复：守住位置 暂停分支；改错故障 到底后仍暂停。
// INV-08 不可见不处理滚动：守住位置 早退；改错故障 隐藏页写入跟随状态。
// INV-09 错误优先展示：守住位置 错误分支；改错故障 错误被状态栏淹没。
// INV-10 错误可重试：守住位置 刷新回调；改错故障 只能重开面板。
// INV-11 运行中显示旋转图标：守住位置 状态判断；改错故障 无进行中反馈。
// INV-12 完整文件入口带回工作区：守住位置 参数展开；改错故障 打开到错误工作区。
// INV-13 文件名取末段：守住位置 分隔符切分；改错故障 标题显示整条路径。
// INV-14 空输出给空态文案：守住位置 双条件；改错故障 空白区域。
// INV-15 输出保留换行：守住位置 空白规则；改错故障 命令行挤成一段。
// INV-16 悬浮箭头有可访问名：守住位置 标签属性；改错故障 读屏只念图标。
// INV-17 状态与跟随写入数据属性：守住位置 数据属性；改错故障 测试无法断言。
// INV-18 组件记忆化：守住位置 外层包装；改错故障 父级渲染带动整块重排。
//
// 模块职责：后台 bash 输出的侧栏面板与跟随滚动。
// 状态所有权：输出与跟随态归专用钩子，组件只管视口。
// 阅读顺序：先看布局副作用，再看滚动处理，最后看渲染分支。
import { memo, useLayoutEffect, useRef } from "react";
import { ArrowDownIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBackgroundBashOutput } from "@/hooks/useBackgroundBashOutput.js";
import { logger } from "@/logger.js";
import type { BackgroundBashSidePaneTab } from "@/lib/workspaceSidePane.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";

// 输出由 useBackgroundBashOutput 读取，面板只解构 latest / display / following。
// visible 传给 useBackgroundBashOutput，隐藏页不建立订阅也不轮询 tail。
// data-status 与 data-following 写入状态与跟随态，供 E2E 断言而不读内部 ref。
// 外层用 memo 包裹 BackgroundBashOutputSidePane，父级渲染不带动整块重排。
// 面板本身不改数据，滚动副作用只写 scrollTop 与 previousTop。
export const BackgroundBashOutputSidePane = memo(function BackgroundBashOutputSidePane({
  tab,
  visible,
  onOpenCodeViewer,
}: {
  tab: BackgroundBashSidePaneTab;
  visible: boolean;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
}) {
  const { intl } = useZCodeIntl();
  const preview = useBackgroundBashOutput(tab, visible);
  const { latest, display, following } = preview;
  const scroll = useRef<HTMLDivElement>(null);
  const previousTop = useRef(0);
  // useLayoutEffect 在 !visible 时提前返回，隐藏页不抢滚动位置。
  // 约束是 !following 不贴底，用户上翻后新输出不拉回视口。
  // following 为真时把 scrollTop 设为 scrollHeight，新输出始终贴底。
  // 贴底后同步 previousTop.current，供 onScroll 判断滚动方向。
  // 依赖数组含 display?.output，只有输出变化才重跑该副作用。
  useLayoutEffect(() => {
    if (!visible || !following || !scroll.current) return;
    scroll.current.scrollTop = scroll.current.scrollHeight;
    previousTop.current = scroll.current.scrollTop;
  }, [visible, following, display?.output]);

  return (
    <section
      data-testid="background-bash-details"
      data-work-id={tab.workId}
      data-status={latest?.status ?? "loading"}
      data-following={following}
      className="flex h-full min-h-0 min-w-0 flex-col bg-panel text-ui-base text-foreground-subtle"
    >
      {preview.error ? (
        <div role="alert" className="flex shrink-0 items-center gap-2 px-4 py-2 text-danger">
          <span>{intl.formatMessage({ id: `bashOutput.error.${preview.error}` })}</span>
          <Button variant="ghost" size="sm" onClick={preview.refresh}>
            {intl.formatMessage({ id: "bashOutput.retry" })}
          </Button>
        </div>
      ) : null}
      <div
        data-testid="background-bash-statusbar"
        className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pt-3 text-ui-sm"
      >
        {latest?.status === "running" ? (
          <span
            role="status"
            data-testid="background-bash-running"
            className="flex shrink-0 items-center gap-2"
          >
            <LoaderCircleIcon className="size-3 animate-spin" />
            {intl.formatMessage({ id: "bashOutput.status.running" })}
          </span>
        ) : null}
        {latest && onOpenCodeViewer ? (
          <Button
            variant="link"
            size="xs"
            className="ml-auto h-auto px-0 text-ui-sm text-foreground-subtle"
            title={latest.outputPath}
            data-testid="background-bash-file"
            onClick={() =>
              onOpenCodeViewer({
                type: "file",
                path: latest.outputPath,
                title: latest.outputPath.split(/[\\/]/).pop() ?? latest.outputPath,
                workspacePath: tab.workspacePath,
                workspaceIdentity: tab.workspaceIdentity,
                workspaceRemoteSessionId: tab.remoteSessionId,
              })
            }
          >
            {intl.formatMessage({ id: "bashOutput.fullFile" })}
          </Button>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1">
        <ScrollFadeViewport
          ref={scroll}
          data-testid="background-bash-scroll"
          className="h-full overflow-auto px-4 py-3"
          tabIndex={0}
          // onScroll 判断 following 且 scrollTop 回退且未到底，立即调用 preview.pause()。
          // !following 且 atBottom 时调用 preview.resume()，手动滚到底也能恢复跟随。
          // 每次滚动结束写 previousTop.current，供下一次方向比较。
          // 事件开头按 visible 早退，隐藏面板不写跟随状态。
          onScroll={(event) => {
            if (!visible) return;
            const el = event.currentTarget;
            // atBottom 用 scrollHeight 减 scrollTop 再减 clientHeight，差值不超过 8 像素即算到底。
            // 8 像素容差配合 clientHeight 取整，避免差一像素不恢复跟随。
            // 只有 atBottom 为真才允许走 preview.resume()，否则悬浮箭头常驻。
            // 三个尺寸都读自 event.currentTarget，不缓存旧元素。
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
            if (following && el.scrollTop < previousTop.current && !atBottom) {
              preview.pause();
              logger.debug("Background Bash output following changed", {
                workId: tab.workId,
                following: false,
              });
            } else if (!following && atBottom) {
              // 手动滚到底部也要恢复查询跟随，否则已到底时悬浮箭头仍会常驻。
              preview.resume();
              logger.debug("Background Bash output following changed", {
                workId: tab.workId,
                following: true,
              });
            }
            previousTop.current = el.scrollTop;
          }}
        >
          <pre
            data-testid="background-bash-output"
            className="whitespace-pre-wrap break-words font-mono text-ui-base leading-5"
          >
            {display?.output || (display ? intl.formatMessage({ id: "bashOutput.empty" }) : "")}
          </pre>
        </ScrollFadeViewport>
        {!following ? (
          <Button
            variant="outline"
            size="icon"
            type="button"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-card shadow-sm hover:bg-card-selected"
            data-testid="background-bash-resume"
            aria-label={intl.formatMessage({ id: "chat.scrollToBottom" })}
            title={intl.formatMessage({ id: "chat.scrollToBottom" })}
            onClick={preview.resume}
          >
            <ArrowDownIcon className="size-4" />
          </Button>
        ) : null}
      </div>
    </section>
  );
});
