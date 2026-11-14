// 【模块】Windows 自绘标题栏右侧的折叠菜单入口：承载窗口级命令、帮助入口与调试开关，只负责触发与展示。
// 【边界】所有平台读写经 usePlatform 暴露的通道，组件不直接访问 window.zcode，也不持有任何业务事实。
// 【契约】外部只有 readOnlyReason、两项能力开关与 triggerPresentation 可影响渲染，其余显隐均由探测结果推导。
// 【权衡】命令派发与状态同步都走即发即忘，用一次额外回拉换取菜单关闭的即时手感。
// INV-01 【不变量】自动更新入口的显隐只由 shouldShowDesktopUpdateEntry 决定，平台能力缺失不改变菜单结构；守住位置：该常量的赋值与全部条件渲染点；改错故障：Web 端出现点击无效的检查更新项，用户误以为更新通道损坏。
// INV-02 【失败路径】同步更新状态异常只记 warn 并保留上一份 payload；守住位置：syncUpdateState 的 catch 分支；改错故障：一次通道抖动把标签清回初始态，用户误以为更新已被取消。
// INV-03 【生命周期】更新状态监听的退订函数由发起订阅的同一个 effect 返回，重跑或卸载都会释放；守住位置：首个 useEffect 的返回值；改错故障：窗口反复打开后监听叠加，进度刷新次数随窗口数线性增长。
// INV-04 【并发】首个 effect 内先发起拉取再挂监听，晚到的拉取结果会覆盖订阅前的状态；守住位置：首个 useEffect 的调用顺序；改错故障：下载起点进度被旧快照回写，进度条短暂倒退。
// INV-05 【设计权衡】订阅缺失时以空回调兜底，避免清理阶段调用空值；守住位置：首个 useEffect 的三元返回；改错故障：卸载阶段拿到空值，关窗时报错并残留菜单层级。
// INV-06 【并发】社区入口探测用闭包取消标记丢弃迟到结果；守住位置：第二个 useEffect 的成功与失败回调；改错故障：快速切换语言后旧结果回写，社区项按已切走的平台闪现。
// INV-07 【生命周期】语言变化触发整轮重新探测并重建取消标记，旧轮次结果全部作废；守住位置：第二个 useEffect 的依赖数组；改错故障：切换语言后社区入口长期缺失或长期残留。
// INV-08 【失败路径】canOpenCommunity 拒绝时收敛为隐藏，不让异常进入渲染树；守住位置：第二个 useEffect 的失败回调；改错故障：探测失败冒泡触发错误边界，整条标题栏菜单消失。
// INV-09 【不变量】stdio tap 的 enabled 与 visible 始终同源写入，不会一新一旧；守住位置：syncStdioTapDevState 与 handleToggleStdioTapDevProxy；改错故障：勾选框与真实代理状态相反，用户以为已关闭却仍在抓包。
// INV-10 【失败路径】stdio tap 读取失败回落到关闭且隐藏，避免留下无法关闭的开关；守住位置：syncStdioTapDevState 的 catch 分支；改错故障：能力缺失时仍显示已启用的调试开关，用户无从关闭。
// INV-11 【不变量】只读态由 readOnlyReason 单一来源派生，新建任务与在文件管理器中打开同受其约束；守住位置：两个 DropdownMenuItem 的 disabled 与 onSelect 守卫；改错故障：只读工作区仍能新建任务，提交后才收到莫名失败。
// INV-12 【失败路径】在文件管理器中打开失败以 toast 告知且不改菜单状态；守住位置：handleOpenWorkspaceInFileManager 的结果判断；改错故障：路径失效时点击毫无反应，用户反复开合菜单找原因。
// INV-13 【不变量】菜单项命令统一经 executeDesktopCommand 派发，命令标识只取自 DesktopCommandIds 常量；守住位置：handleExecuteDesktopCommand 的入参类型与全部调用点；改错故障：手写字符串漂移出真实命令名，点击静默无效。
// INV-14 【设计权衡】检查更新命令完成后主动回拉状态，不依赖下一次打开菜单；守住位置：handleExecuteDesktopCommand 的 CheckForUpdates 分支；改错故障：重开菜单仍是静态的检查更新文案，用户以为点击未生效。
// INV-15 【并发】命令派发以即发即忘包装，不阻塞菜单关闭动画；守住位置：两个命令处理函数内部的异步包裹；改错故障：命令挂起时菜单卡在半开，标题栏区域短暂无响应。
// INV-16 【不变量】状态刷新只发生在菜单打开方向，关闭方向不发起任何平台请求；守住位置：DropdownMenu 的 onOpenChange；改错故障：每次关菜单也打一轮往返，频繁开合造成无谓 IPC 流量。
// INV-17 【生命周期】浮层内容随关闭卸载，勾选态不保留本地副本，取值来自最近一次同步；守住位置：DropdownMenuContent 内的受控取值；改错故障：关闭后改配置再打开仍显示旧勾选，用户重复切换。
// INV-18 【设计权衡】底部关闭项固定渲染，不随平台能力与只读态变化；守住位置：菜单末尾的 CloseWindow 条目；改错故障：能力探测失败时连关闭窗口都不可用，用户只能退回系统按钮。
import { DesktopCommandIds } from "@zcode/shared";
import type { UpdateStatePayload } from "@zcode/shared";
import { useCallback, useEffect, useState } from "react";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { createHelpMenuActionHandlers } from "@/lib/helpMenuActions.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";
import { ChevronDownIcon } from "lucide-react";

import {
  shouldShowDesktopUpdateEntry,
  getUpdateMenuLabelId,
  getUpdateMenuLabelValues,
} from "@/lib/desktopUpdateMenu.js";
export { shouldShowDesktopUpdateEntry } from "@/lib/desktopUpdateMenu.js";

// 【设计权衡】负偏移只服务 caption 右侧这一颗菜单，用于抵消原生窗口按钮在不同 DPI 与主题下的取整误差。
// 【失败路径】偏移取正会让浮层压住最小化按钮，取过负则会盖住触发器自身的悬停区。
// 【不变量】该数值集中在此常量，浮层定位处不再出现第二份魔法数字。
// 【边界】此值只参与水平定位，垂直间距由 sideOffset 单独承担，两者互不覆盖。
const WINDOWS_CAPTION_MENU_ALIGN_OFFSET = -12;

// 【不变量】组件是无状态入口，业务事实全部来自 props 与平台探测，同一组输入渲染同一菜单结构。
// 【契约】triggerPresentation 只影响按钮边框样式，不改变菜单内容与命令集合。
// 【设计权衡】只读态与各项能力开关并存，任一项关闭只收敛对应条目而非整份菜单。
// 【边界】onToggleTerminal 与 onToggleBrowser 仍留在签名中并以未使用前缀标注，避免调用方被迫改动。
export function WindowsCaptionMenuButton({
  readOnlyReason,
  workspaceAbsPath,
  onCreateTask,
  onOpenWorkspace,
  allowOpenWorkspace = true,
  allowOpenInFileManager = true,
  onToggleTerminal: _onToggleTerminal,
  onToggleBrowser: _onToggleBrowser,
  triggerPresentation = "header",
  useWindowsCaptionSpacing = false,
}: {
  readOnlyReason?: string;
  workspaceAbsPath: string;
  onCreateTask: () => void;
  onOpenWorkspace: () => void;
  allowOpenWorkspace?: boolean;
  allowOpenInFileManager?: boolean;
  onToggleTerminal: () => void;
  onToggleBrowser: () => void;
  triggerPresentation?: "header" | "header-borderless";
  useWindowsCaptionSpacing?: boolean;
}) {
  // 【不变量】平台能力只经 usePlatform 取得，桌面与 Web 共用同一组件而不在内部判断全局对象。
  // 【契约】新建与打开工作区的标签都来自 `useShortcutCommandLabel`；键位改绑后菜单文案同步变化，无需另存文案表。
  // 【失败路径】平台未实现可选能力时对应探测函数为空，菜单自动降级而不抛错。
  // 【设计权衡】帮助菜单处理器每次渲染重建，换取与最新文案和反馈通道的一致性。
  const platform = usePlatform();
  const { intl, locale } = useZCodeIntl();
  const newTaskShortcutLabel = useShortcutCommandLabel("newTask");
  const openWorkspaceShortcutLabel = useShortcutCommandLabel("openWorkspace");
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const openFeatureRequest = useFeedbackStore((state) => state.openFeatureRequest);
  const helpMenuActions = createHelpMenuActionHandlers({
    platform,
    intl,
    openSubmit: openFeedbackSubmit,
  });
  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null);
  const [stdioTapDevState, setStdioTapDevState] = useState({
    enabled: false,
    visible: false,
  });
  const [showCommunityMenuItem, setShowCommunityMenuItem] = useState(false);
  const showDesktopUpdateEntry = shouldShowDesktopUpdateEntry();

  // 【不变量】仅当平台提供 getUpdateState 才发起拉取，能力缺失时立即返回且不改状态。
  // 【失败路径】拉取异常只记 warn 并保留上一层 payload，菜单标签不回落到初始文案。
  // 【并发】并发调用不互相取消，最后写入者获胜，界面只关心最终快照。
  // 【生命周期】回调依赖仅 platform，平台对象不变则不重建，effect 不会反复重订阅。
  const syncUpdateState = useCallback(async () => {
    if (!platform.getUpdateState) {
      return;
    }

    try {
      const payload = await platform.getUpdateState();
      setUpdateState(payload);
    } catch (error) {
      logger.warn("[WindowsCaptionMenuButton] 同步自动更新状态失败", { error });
    }
  }, [platform]);

  // 【不变量】能力缺失与读取失败两支收敛到同一终态，均为关闭且隐藏。
  // 【失败路径】异常时先记 warn 再写回退值，避免菜单停在上一次的可见状态。
  // 【边界】该状态同时决定调试分组的显隐与勾选，两者取自同一个对象不会错位。
  const syncStdioTapDevState = useCallback(async () => {
    if (!platform.getZCodeStdioTapDevState) {
      setStdioTapDevState({ enabled: false, visible: false });
      return;
    }

    try {
      const state = await platform.getZCodeStdioTapDevState();
      setStdioTapDevState({ enabled: state.enabled, visible: state.visible });
    } catch (error) {
      logger.warn("[WindowsCaptionMenuButton] 同步 stdio tap 状态失败", { error });
      setStdioTapDevState({ enabled: false, visible: false });
    }
  }, [platform]);

  // 【不变量】挂载即拉一次更新与 stdio tap 状态，不等待用户打开菜单。
  // 【生命周期】返回的退订函数与订阅同源，effect 重跑或卸载都会释放上一条监听。
  // 【并发】先拉取后订阅，期间到达的推送由订阅回调覆盖，最终态不会缺失。
  // 【失败路径】平台不提供状态变更事件时返回空清理函数，卸载阶段仍可安全调用。
  useEffect(() => {
    if (showDesktopUpdateEntry) {
      void syncUpdateState();
    }
    void syncStdioTapDevState();
    return showDesktopUpdateEntry
      ? (platform.onUpdateStateChanged?.((payload) => {
          setUpdateState(payload);
        }) ?? (() => {}))
      : undefined;
  }, [platform, showDesktopUpdateEntry, syncStdioTapDevState, syncUpdateState]);

  useEffect(() => {
    // 【并发】取消标记随 effect 实例创建，语言或平台变化后旧轮次回调全部失效。
    // 【生命周期】清理阶段只翻转标记而不取消 Promise，迟到的结果由回调自行丢弃。
    // 【失败路径】缺少该标记时旧响应会覆盖新结果，社区入口按上一次语言闪现。
    let isCancelled = false;

    void platform.canOpenCommunity(locale).then(
      (visible) => {
        if (!isCancelled) {
          setShowCommunityMenuItem(visible);
        }
      },
      () => {
        if (!isCancelled) {
          setShowCommunityMenuItem(false);
        }
      },
    );

    return () => {
      isCancelled = true;
    };
  }, [locale, platform]);

  // 【不变量】只读态下直接返回，不发出任何平台调用。
  // 【失败路径】平台返回失败时以 toast 告知，菜单状态不变，用户可原样重试。
  // 【边界】路径取自 workspaceAbsPath，组件内不拼接也不规范化该值。
  const handleOpenWorkspaceInFileManager = async () => {
    if (readOnlyReason) {
      return;
    }
    const result = await platform.openInFileManager(workspaceAbsPath);
    if (!result.success) {
      toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
    }
  };

  // 【不变量】命令标识类型收敛为 DesktopCommandIds 的值联合，调用点无法传入任意字符串。
  // 【设计权衡】检查更新完成后额外回拉状态，用一次往返换取标签立即反映真实检查结果。
  // 【并发】命令与回拉串行执行，回拉必然落后于命令完成，不会读到命令前的旧快照。
  // 【失败路径】命令抛错时回拉被跳过，菜单保持旧标签，用户再开一次菜单即可重新同步。
  const handleExecuteDesktopCommand = (
    command: (typeof DesktopCommandIds)[keyof typeof DesktopCommandIds],
  ) => {
    void (async () => {
      await platform.executeDesktopCommand(command);
      if (command === DesktopCommandIds.CheckForUpdates) {
        // Bugfix: 这个 Windows 合并菜单才是截图里的入口。
        // 点击后菜单会关闭，重新打开前主动拉取 main 中的 updater 状态，避免一直显示静态“检查更新”。
        await syncUpdateState();
      }
    })();
  };

  const handleToggleStdioTapDevProxy = () => {
    void (async () => {
      await platform.executeDesktopCommand(DesktopCommandIds.ToggleZCodeStdioTapDevProxy);
      await syncStdioTapDevState();
    })();
  };

  return (
    // 【不变量】只在打开方向刷新状态，关闭方向不发任何平台请求。
    // 【生命周期】勾选态只存在于 `DropdownMenu` 子树；关闭即卸载，重新打开由 `syncStdioTapDevState` 拉新快照而不留副本。
    // 【设计权衡】刷新挂在开合回调而非某个条目上，任何打开路径都能拿到最新快照。
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          if (showDesktopUpdateEntry) {
            void syncUpdateState();
          }
          void syncStdioTapDevState();
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          className={cn(
            "text-foreground-subtle hover:text-foreground [app-region:no-drag]",
            useWindowsCaptionSpacing
              ? WINDOWS_CAPTION_CONTROL_CLASS
              : "h-full w-[45px] rounded-none",
            "border-0 hover:bg-hover",
            triggerPresentation === "header" && "border-l border-border/50",
          )}
          aria-label={intl.formatMessage({ id: "titleBar.windowMenu" })}
        >
          <ChevronDownIcon className="size-5 text-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        // Bugfix: Windows titleBarOverlay 的原生窗口按钮宽度会受 DPI / 系统主题 / Electron 取整影响，
        // 菜单右对齐到 45px 自绘入口时，浮层边缘可能压到最小化按钮下方；轻微左移只影响这颗 caption 菜单。
        alignOffset={WINDOWS_CAPTION_MENU_ALIGN_OFFSET}
        side="bottom"
        sideOffset={8}
        className="w-72 border border-popover-border bg-menu p-2"
      >
        <DropdownMenuItem
          disabled={Boolean(readOnlyReason)}
          // 【不变量】只读原因同时挂到 disabled 与 title，禁用条目仍能解释为何不可点。
          // 【失败路径】只置禁用不给原因时，悬停没有任何说明，用户只能去别处猜。
          // 【边界】readOnlyReason 为空表示可写，布尔化后才交给 disabled，避免空串被当成真值。
          title={readOnlyReason}
          onSelect={() => {
            if (!readOnlyReason) {
              onCreateTask();
            }
          }}
        >
          {intl.formatMessage({ id: "titleBar.menu.file.newTask" })}
          <DropdownMenuShortcut>{newTaskShortcutLabel}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {allowOpenWorkspace ? (
          <DropdownMenuItem onSelect={onOpenWorkspace}>
            {intl.formatMessage({ id: "workspace.openWorkspace" })}
            <DropdownMenuShortcut>{openWorkspaceShortcutLabel}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ) : null}
        {allowOpenInFileManager ? (
          <DropdownMenuItem
            disabled={Boolean(readOnlyReason)}
            title={readOnlyReason}
            onSelect={handleOpenWorkspaceInFileManager}
          >
            {intl.formatMessage({ id: "appHeader.openInFileExplorer" })}
          </DropdownMenuItem>
        ) : null}

        <DropdownMenuSeparator />

        {/* <DropdownMenuItem onSelect={onToggleTerminal}>
          {intl.formatMessage({ id: "terminal.toggle" })}
          <DropdownMenuShortcut>{formatCommandShortcutLabel("J")}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onToggleBrowser}>
          {intl.formatMessage({ id: "browser.toggle" })}
        </DropdownMenuItem>

        <DropdownMenuSeparator /> */}

        <DropdownMenuItem onSelect={() => handleExecuteDesktopCommand(DesktopCommandIds.ShowAbout)}>
          {intl.formatMessage({ id: "titleBar.menu.help.about" })}
        </DropdownMenuItem>
        {showDesktopUpdateEntry ? (
          <DropdownMenuItem
            disabled={updateState?.enabled === false}
            onSelect={() => handleExecuteDesktopCommand(DesktopCommandIds.CheckForUpdates)}
          >
            {intl.formatMessage(
              { id: getUpdateMenuLabelId(updateState) },
              getUpdateMenuLabelValues(updateState),
            )}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={() => handleExecuteDesktopCommand(DesktopCommandIds.OpenResourceManager)}
        >
          {intl.formatMessage({ id: "titleBar.menu.help.resourceManager" })}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={helpMenuActions.openIssueReport}>
          {intl.formatMessage({ id: "titleBar.menu.help.feedback" })}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={openFeatureRequest}>
          {intl.formatMessage({ id: "workspaceHeader.help.productRequest" })}
        </DropdownMenuItem>
        {showCommunityMenuItem ? (
          <DropdownMenuItem
            onSelect={() => handleExecuteDesktopCommand(DesktopCommandIds.OpenCommunity)}
          >
            {intl.formatMessage({ id: "sidebar.menu.community" })}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={helpMenuActions.openProductDocs}>
          {intl.formatMessage({ id: "workspaceHeader.help.docs" })}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={helpMenuActions.exportLogs}>
          {intl.formatMessage({ id: "titleBar.menu.help.exportLogs" })}
        </DropdownMenuItem>
        {stdioTapDevState.visible ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={stdioTapDevState.enabled}
              onCheckedChange={handleToggleStdioTapDevProxy}
            >
              {intl.formatMessage({ id: "titleBar.menu.help.toggleZCodeStdioTap" })}
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem
              onSelect={() => handleExecuteDesktopCommand(DesktopCommandIds.ToggleDevTools)}
            >
              {intl.formatMessage({ id: "titleBar.menu.help.toggleDevTools" })}
            </DropdownMenuItem>
          </>
        ) : null}
        {/* Bugfix: 批量会话压测下线后，Windows 自绘标题栏菜单不能再暴露旧开关。 */}

        <DropdownMenuSeparator />

        <DropdownMenuItem
          // 【不变量】关闭项固定存在于菜单末尾，与平台能力、只读态均无关。
          // 【失败路径】命令派发失败时窗口不关闭，用户仍保有菜单可再次尝试。
          // 【设计权衡】关闭经桌面命令而非直接操作窗口，保持渲染进程与主进程的职责边界。
          onSelect={() => handleExecuteDesktopCommand(DesktopCommandIds.CloseWindow)}
        >
          {intl.formatMessage({ id: "titleBar.menu.file.closeWindow" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
