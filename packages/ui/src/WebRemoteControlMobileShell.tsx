// INV-01 历史态判据唯一落在 isWebRemoteControlMobileChatHistoryState，先收窄 unknown 再比对 zcodeMobilePage；放宽成任意真值会让非聊天历史被当成聊天页，返回键失去回退目标。
// INV-02 [失败路径] pushWebRemoteControlMobileChatHistory 先挡 typeof window；删掉这道闸，服务端渲染或预渲染阶段会直接抛错并白屏。
// INV-03 入栈判重留在 pushWebRemoteControlMobileChatHistory 开头；去掉后每次进入聊天页都压一条记录，返回键要按多次才回到首页。
// INV-04 刷新恢复只在 resolveInitialWebRemoteControlMobilePage 里读 history 兜底；删掉该分支会让手机聊天页刷新后回到任务首页。
// INV-05 [权衡] 初始页优先级固定为 显式意图、history 兜底、home 保底；调换顺序会让深链进入时被残留 history 覆盖。
// INV-06 页面事实源只有 currentPage 与 setCurrentPage 一处；在组件外或局部变量另存一份，视图与浏览器历史会立刻分叉。
// INV-07 [资源] popstate 监听在 Effect 内注册并在清理函数移除同一引用；漏掉解绑会在视口切换后累积监听并重复改写 currentPage。
// INV-08 [并发] popstate 回调只用事件自带的 state 重新投影；改成叠加闭包里的旧 currentPage 会导致前进后退与视图不同步。
// INV-09 意图消费 Effect 仅在 initialNavigationIntent 变化时向 chat 投影；把断点恢复也写回会重放旧意图，把已返回 Home 的用户拉回聊天页。
// INV-10 补写历史的 Effect 只在移动视口且页面为 chat 时触发；依赖漏掉 isMobileViewport 会让桌面切到手机时缺一次入栈。
// INV-11 [事务] navigateToChat 先置页面再写历史，行序不可颠倒；反过来会让 popstate 先到并把刚设置的 chat 改回 home。
// INV-12 navigateHome 命中 chat 历史时走浏览器后退，让历史栈与视图同源；绕过它会留下可前进的幽灵记录。
// INV-13 WebRemoteControlTaskViewReporter 的 enabled 是四重合取：任务视图开关、桌面恒真、移动端限聊天页、非 inert 且非切换中。
// INV-14 改错上条条件会让被抽屉遮住或正在切换的页面继续上报选中态，污染任务视图的当前任务。
// INV-15 [权衡] 非移动视口直接透传 children，本外壳不持有桌面布局；删掉这条逃生分支会把手机壳塞进桌面分栏。
// INV-16 shouldInertChatSurface 仅在存在 sidePaneContent 且抽屉打开时为真；改成恒真会让聊天区永久不可交互。
// INV-17 [失败路径] 被覆盖的聊天表面同时给 inert 与 aria-hidden，抽屉才是唯一交互区；只做视觉遮挡会让隐藏控件仍被命中。
// INV-18 [资源] chatOverlay 必须留在 inert 主区之外、由独立浮层承载；塞进主区会让查找框随聊天区一起失焦，重连提示也只读归一后的 terminalTransportState。
//
// 模块职责：手机远控外壳，负责页面切换、历史记录恢复、侧栏抽屉与聊天浮层的层级编排，以及重连与切换中的状态提示；桌面形态不介入。
// 状态所有权：页面与切换中标志为本地 useState，终端传输态由 useWebRemoteControlTerminalTransportState 归一，任务上报开关完全由 props 推导，外壳不写业务状态。
// 阅读顺序：先看三个历史辅助函数，再看组件状态与两个导航回调，然后依次读三条 Effect 与渲染分支。
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, LoaderIcon } from "lucide-react";
import { type WebRemoteControlMobileNavigationIntent } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { WebRemoteControlThemeMenu } from "@/WebRemoteControlThemeMenu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WebRemoteControlTaskViewReporter } from "@/web-remote-control/index.js";
import type { WebRemoteControlTerminalTransportState } from "@/root/types.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";
import { useWebRemoteControlTerminalTransportState } from "@/webRemoteControlTerminalTransportState.js";

type WebRemoteControlMobilePage = "home" | "chat";

interface WebRemoteControlMobileHistoryState {
  zcodeMobilePage?: WebRemoteControlMobilePage;
}

// 历史态识别、入栈与初始页解析三件套，共同保证手机远控页面在刷新与前进后退下可复原。
//
// isWebRemoteControlMobileChatHistoryState 是唯一判据，先把 unknown 收窄成对象再比对 zcodeMobilePage。
// 调用方只取布尔结论，不直接摸 history 结构，避免同一判定散落到多处。
//
// pushWebRemoteControlMobileChatHistory 负责写入 chat 标记，先挡服务端渲染，再做幂等判重。
// 写入键名与判据必须成对演进，只改一侧会让历史态永久失效。
//
// resolveInitialWebRemoteControlMobilePage 决定首帧页面，顺序为显式意图、history 兜底、home 保底。
// 它只在 useState 惰性初始化时跑一次，运行期导航不经过此处。
export function isWebRemoteControlMobileChatHistoryState(
  state: unknown,
): state is WebRemoteControlMobileHistoryState {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as WebRemoteControlMobileHistoryState).zcodeMobilePage === "chat"
  );
}

function pushWebRemoteControlMobileChatHistory() {
  if (typeof window === "undefined") {
    return;
  }

  if (isWebRemoteControlMobileChatHistoryState(window.history.state)) {
    return;
  }

  window.history.pushState({ zcodeMobilePage: "chat" }, "");
}

function resolveInitialWebRemoteControlMobilePage(
  initialNavigationIntent?: WebRemoteControlMobileNavigationIntent,
): WebRemoteControlMobilePage {
  if (initialNavigationIntent === "chat") {
    return "chat";
  }

  // Bugfix: 手机端在聊天页刷新时，React 内存状态会丢失，但浏览器会保留当前 history.state。
  // 这里复用点击进入聊天页时写入的 history state，避免刷新后只恢复 task 选中态却回到任务首页。
  if (
    typeof window !== "undefined" &&
    isWebRemoteControlMobileChatHistoryState(window.history.state)
  ) {
    return "chat";
  }

  return "home";
}

export function WebRemoteControlMobileShell({
  children,
  isMobileViewport = true,
  activeTaskId,
  activeWorkspaceIdentity,
  activeWorkspacePath,
  taskViewEnabled = true,
  chatContent,
  chatOverlay,
  initialNavigationIntent,
  isSidePaneOpen = false,
  onCloseSidePane,
  renderTaskHome,
  renderChatHeader,
  sidePaneContent,
  switcher,
  webRemoteControlTerminalTransportState,
}: {
  children?: ReactNode;
  isMobileViewport?: boolean;
  switcher: WebRemoteControlWorkspaceSwitcherApi;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  taskViewEnabled?: boolean;
  initialNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  isSidePaneOpen?: boolean;
  onCloseSidePane?: () => void;
  renderTaskHome: (options: {
    navigateToChat(): void;
    setSwitching(switching: boolean): void;
  }) => ReactNode;
  renderChatHeader: (options: { onBackHome: () => void }) => ReactNode;
  chatContent: ReactNode;
  chatOverlay?: ReactNode;
  sidePaneContent?: ReactNode;
  webRemoteControlTerminalTransportState?: WebRemoteControlTerminalTransportState;
}) {
  // 以下四类状态在此汇合：国际化句柄、当前页面、切工作区遮罩、终端传输态投影。
  //
  // currentPage 用惰性初始化，只在此处读一次初始意图与 history，后续变化全部由 setCurrentPage 驱动。
  // switchingWorkspace 由子渲染器通过 setSwitching 上交，外壳只负责遮罩与屏蔽上报，不参与切换细节。
  //
  // terminalTransportState 走 useWebRemoteControlTerminalTransportState 归一，允许宿主注入以便测试与复用。
  // [契约] 宿主传入的传输态优先于全局投影；两条来源在 `useWebRemoteControlTerminalTransportState` 内归一，外壳不再二次加工。
  //
  // shouldInertChatSurface 把 侧栏内容存在 与 抽屉打开 合取，作为 inert 与上报屏蔽的唯一开关。
  const { intl } = useZCodeIntl();
  const [currentPage, setCurrentPage] = useState<WebRemoteControlMobilePage>(() =>
    resolveInitialWebRemoteControlMobilePage(initialNavigationIntent),
  );
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const terminalTransportState = useWebRemoteControlTerminalTransportState(
    webRemoteControlTerminalTransportState,
  );
  const shouldInertChatSurface = Boolean(sidePaneContent) && isSidePaneOpen;

  // 两个导航回调是页面状态的唯一写入口，故依赖数组留空以保持函数引用稳定。
  //
  // navigateToChat 先切换页面再写历史，顺序固定：先有视图，再有可回退条目。
  // 回调交给 renderTaskHome 使用，任务卡与列表项共用，禁止各处自行改页。
  //
  // navigateHome 优先走浏览器后退，让历史栈与视图保持同源。
  // 仅在缺少 chat 历史标记时才本地置为 home，用于深链直达这类无历史场景。
  // 两条分支互斥，避免既退栈又改页，造成历史长度与视图不一致。
  const navigateToChat = useCallback(() => {
    setCurrentPage("chat");
    pushWebRemoteControlMobileChatHistory();
  }, []);

  const navigateHome = useCallback(() => {
    if (
      typeof window !== "undefined" &&
      isWebRemoteControlMobileChatHistoryState(window.history.state)
    ) {
      window.history.back();
      return;
    }

    setCurrentPage("home");
  }, []);

  useEffect(() => {
    // [并发] 意图 Effect 只在 initialNavigationIntent 变化时执行，向 chat 投影一次。
    // 断点恢复不重放旧意图，否则用户手动退回 Home 后会被立刻拉回聊天页。
    // 该 Effect 不回写历史，写历史统一交给按 currentPage 触发的那条。
    // 若为省事改成监听当前页面再反推意图，会形成自激循环。
    // 初始意图只随导航变化消费；断点恢复不能重放旧 chat 意图，覆盖用户已经返回的 Home。
    if (initialNavigationIntent === "chat") setCurrentPage("chat");
  }, [initialNavigationIntent]);

  useEffect(() => {
    // [事务] 页面已是 chat 且处于移动视口时补写历史，保证刷新后仍能回到聊天页。
    // 该 Effect 只补标记不改页面，幂等由 pushWebRemoteControlMobileChatHistory 内部判重兜住。
    // 去掉依赖里的 isMobileViewport 会让桌面切到手机视口时漏掉这次入栈。
    if (isMobileViewport && currentPage === "chat") pushWebRemoteControlMobileChatHistory();
  }, [isMobileViewport, currentPage]);

  useEffect(() => {
    // [资源] popstate 订阅按视口挂载，非移动视口或无 window 时直接返回，不注册任何监听。
    // 回调只依据事件自带的 state 重新投影页面，不读闭包中的旧 currentPage。
    // 清理函数必须移除同一引用，否则视口来回切换会累积监听。
    // [并发] 首次挂载不主动投影，避免与意图 Effect 抢写同一状态。
    // [事件] `popstate` 是前进与后退的唯一入口，浏览器手势与按钮都经 `handlePopState` 重投影 `currentPage`。
    if (!isMobileViewport || typeof window === "undefined") {
      return;
    }

    const handlePopState = (event: PopStateEvent) => {
      const nextPage = isWebRemoteControlMobileChatHistoryState(event.state) ? "chat" : "home";
      setCurrentPage(nextPage);
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [isMobileViewport]);

  // Bugfix: 移动端聊天/侧栏都是 flex 子树，默认 min-width:auto 会按长消息的
  // min-content 宽度撑开抽屉；窄屏随后从左侧裁掉正文。沿整条宽度链显式允许收缩，
  // 让 subagent 输出、进程面板和正文在抽屉内换行。
  return (
    <>
      <WebRemoteControlTaskViewReporter
        enabled={
          taskViewEnabled &&
          (!isMobileViewport ||
            (currentPage === "chat" && !shouldInertChatSurface && !switchingWorkspace))
        }
        activeTaskId={activeTaskId}
        workspacePath={activeWorkspacePath}
        workspaceIdentity={activeWorkspaceIdentity}
        switcher={switcher}
      />
      {isMobileViewport ? (
        <div className="relative flex h-full min-h-0 min-w-0 flex-col bg-background">
          {currentPage === "home" ? (
            <section className="flex h-full min-h-0 min-w-0 flex-col" data-mobile-page="home">
              {renderTaskHome({ navigateToChat, setSwitching: setSwitchingWorkspace })}
            </section>
          ) : (
            <section
              className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground"
              data-mobile-page="chat"
            >
              <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-header px-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={intl.formatMessage({
                    id: "webRemoteControl.mobileShell.backHome",
                  })}
                  onClick={navigateHome}
                >
                  <ArrowLeft className="size-4" />
                </Button>
                <span className="min-w-0 flex-1 truncate text-ui-base font-medium">
                  {intl.formatMessage({ id: "webRemoteControl.mobileShell.chatTitle" })}
                </span>
                <WebRemoteControlThemeMenu />
              </div>
              {renderChatHeader({ onBackHome: navigateHome })}
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <main
                  className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                  aria-hidden={shouldInertChatSurface ? true : undefined}
                  data-mobile-chat-surface={shouldInertChatSurface ? "inert" : undefined}
                  inert={shouldInertChatSurface ? true : undefined}
                >
                  {/* Bugfix: 手机侧栏打开时底部 composer 会被抽屉覆盖。
                  如果聊天区仍留在交互树里，模型选择等控件会被遮挡但仍可被浏览器命中，
                  造成“按钮不可点”的误导。这里把被覆盖的聊天表面设为 inert，
                  让右侧抽屉成为唯一可交互区域。 */}
                  {chatContent}
                </main>
                {sidePaneContent ? (
                  <div
                    className={[
                      "absolute inset-0 z-30 transition-opacity duration-200 ease-out",
                      isSidePaneOpen ? "opacity-100" : "pointer-events-none opacity-0",
                    ].join(" ")}
                    aria-hidden={!isSidePaneOpen}
                    data-mobile-side-pane-overlay="true"
                  >
                    <button
                      type="button"
                      className="absolute inset-0 bg-background/60 backdrop-blur-[1px]"
                      aria-label={intl.formatMessage({ id: "sidePane.collapse" })}
                      onClick={onCloseSidePane}
                    />
                    <div
                      className={[
                        "absolute top-0 right-0 h-full w-[min(88vw,28rem)] max-w-full border-l border-border bg-background shadow-2xl transition-transform duration-200 ease-out",
                        isSidePaneOpen ? "translate-x-0" : "translate-x-full",
                      ].join(" ")}
                    >
                      {/* Bugfix: 手机远控之前把 side pane 作为底部纵向面板渲染，
                      会挤压聊天区且不像桌面右侧栏。这里改成右侧覆盖抽屉，
                      只覆盖手机聊天区，不改变桌面端分栏布局。 */}
                      {sidePaneContent}
                    </div>
                  </div>
                ) : null}
                {chatOverlay ? (
                  <div
                    className="pointer-events-none absolute inset-0 z-40"
                    data-mobile-chat-overlay="true"
                  >
                    {/* Bugfix: 查找框属于聊天视觉区域，但不能成为 inert 聊天表面的后代。
                    独立 overlay 保留抽屉隔离，同时让文件变更查找仍可聚焦、切换和关闭。 */}
                    <div className="pointer-events-auto">{chatOverlay}</div>
                  </div>
                ) : null}
              </div>
            </section>
          )}

          {switchingWorkspace ? (
            <div
              className="absolute inset-0 z-40 flex items-center justify-center bg-background/72 backdrop-blur-[1px]"
              aria-live="polite"
              aria-busy="true"
            >
              <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle shadow-sm">
                <LoaderIcon className="size-4 animate-spin" />
                {intl.formatMessage({ id: "common.loading" })}
              </div>
            </div>
          ) : null}
          {terminalTransportState === "reconnecting" ? (
            <div
              className="pointer-events-none absolute top-3 left-1/2 z-50 flex -translate-x-1/2 justify-center px-3"
              aria-live="polite"
              aria-busy="true"
              data-web-remote-control-reconnect-notice="true"
            >
              <div className="flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-lg border border-border bg-toast px-3 py-2 text-ui-base text-foreground shadow-lg">
                <LoaderIcon className="size-4 shrink-0 animate-spin text-foreground-subtle" />
                <span className="min-w-0 whitespace-nowrap">
                  {intl.formatMessage({ id: "webRemoteControl.mobileShell.reconnecting" })}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        children
      )}
    </>
  );
}
