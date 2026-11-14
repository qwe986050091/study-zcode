// INV-01 工作区壳层常驻挂载：守住位置 壳层外层容器；改错故障 关闭设置时整树重挂载。
// INV-02 设置页以覆盖层出现：守住位置 条件渲染的设置层；改错故障 主界面被整体替换。
// INV-03 切层用透明度不拆树：守住位置 透明类名分支；改错故障 侧边栏可见性闪烁。
// INV-04 保留布局占位：守住位置 pointer-events-none；改错故障 菜单锚点丢失定位。
// INV-05 不用隐藏类收起底层：守住位置 类名与注释；改错故障 quickpick 继承 display none。
// INV-06 设置期间标记 inert：守住位置 inert 属性；改错故障 底层卡片抢走表单焦点。
// INV-07 设置期禁用遥测前台：守住位置 foregroundEnabled；改错故障 设置页仍计前台活跃。
// INV-08 工作区键优先身份：守住位置 workspaceKey 三元；改错故障 同路径跨远端不重置边界。
// INV-09 边界重置键含设置状态：守住位置 设置层 resetKeys；改错故障 设置层报错后无法恢复。
// INV-10 App 实例稳定化：守住位置 memo 包裹；改错故障 每次渲染重建子树。
// INV-11 工作区服务由上层注入：守住位置 ServiceProvider；改错故障 组件自建第二份服务。
// INV-12 设置层单独错误边界：守住位置 第二个 ScopedErrorBoundary；改错故障 设置崩溃带崩主界面。
// INV-13 回流设置时同步记录：守住位置 可见性日志 effect；改错故障 无法定位切层抖动。
// INV-14 注销与登录透传：守住位置 两个账号回调；改错故障 设置页无法切换账号。
// INV-15 活跃路径存在才可返回：守住位置 onBack 三元；改错故障 无工作区时返回空白页。
// INV-16 窗口控制内边距透传：守住位置 右侧内边距属性；改错故障 标题栏与按钮重叠。
// INV-17 桌面能力以布尔下传：守住位置 三个平台字段；改错故障 分支行为不一致。
// INV-18 本组件不持有业务状态：守住位置 仅一个日志 effect；改错故障 工作区状态出现第二份。
//
// 模块职责：ProjectDirectoryProvider + App 壳层 + WorkspaceSettingsLayer 覆盖层的组合根。
// 状态所有权：无业务状态；工作区状态归 App 与各 store。
// 阅读顺序：先看属性入口，再读壳层挂载策略，最后看设置层覆盖。
import { memo, useEffect } from "react";
import { ProjectDirectoryProvider } from "@/project-sidebar/index.js";
import { App } from "@/App.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { WorkspaceSettingsLayer } from "@/root/WorkspaceSettingsLayer.js";
import type { AppProps } from "@/app-shell/types.js";
import type { RootProps } from "@/root/types.js";
import type { IFeedbackService, IServiceAccessor } from "@zcode/services";
import { ConversationTelemetryWorkspaceAttachment } from "@/v4/telemetry/ConversationTelemetryAttachment.js";

// StableWorkspaceApp = memo(App)（INV-10）：父组件切设置层时 App 实例不变，聊天区与终端不会卸载重建；
// 去掉 memo 会让每次渲染重建整棵子树，表现为列表闪烁与 mount 尖峰。模块加载时求值一次，不持有状态。
const StableWorkspaceApp = memo(App);

// RootWorkspaceContentProps 只描述形状，服务与账号回调全部由 App/Root 注入，不在此处构造。
// 远端字段 workspaceIdentity / workspaceRemoteSessionId / handleOpenRemoteWorkspace 可缺省；
// 新增 props 必须保持可选，否则所有调用方都要同步改签名。
interface RootWorkspaceContentProps {
  workspaceScopedServices: IServiceAccessor;
  baseFeedbackService: IFeedbackService;
  workspaceShellPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activeWorkspacePath: string | null;
  isSettingsTabActive: boolean;
  handleConnectRemote: AppProps["onConnectRemote"];
  handleSelectRemoteProject: AppProps["onSelectRemoteProject"];
  handleCancelRemoteProject: AppProps["onCancelRemoteProject"];
  handleReconnectRemoteWorkspace: AppProps["onReconnectRemoteWorkspace"];
  handleCreateTask: AppProps["onCreateTask"];
  handleCreateConversationTask: NonNullable<AppProps["onCreateConversationTask"]>;
  handleResolveConversationWorkspace: NonNullable<AppProps["onResolveConversationWorkspace"]>;
  handleOpenWorkspace: AppProps["onOpenWorkspace"];
  handleOpenFolderFromWorkspaceMenu: AppProps["onOpenFolderFromWorkspaceMenu"];
  handleOpenRemoteWorkspace?: AppProps["onOpenRemoteWorkspace"];
  remoteConnectionInProgress?: AppProps["remoteConnectionInProgress"];
  remoteWorkspaceSessions: NonNullable<AppProps["remoteWorkspaceSessions"]>;
  allowRemoteWorkspace: NonNullable<RootProps["allowRemoteWorkspace"]>;
  handleBackFromSettings: () => void;
  handleLogout?: () => void;
  onLogin?: () => void;
  user: AppProps["user"];
  reconnectingRemoteWorkspaceKeys: AppProps["reconnectingRemoteWorkspaceKeys"];
  remoteWorkspaceRecoveryByWorkspaceKey: AppProps["remoteWorkspaceRecoveryByWorkspaceKey"];
  remoteWorkspaceErrorByWorkspaceKey: AppProps["remoteWorkspaceErrorByWorkspaceKey"];

  remoteConnectionLogs?: AppProps["remoteConnectionLogs"];
  allowOpenWorkspace: NonNullable<RootProps["allowOpenWorkspace"]>;
  webRemoteControlWorkspaceSwitcher?: RootProps["webRemoteControlWorkspaceSwitcher"];
  initialSidebarFileTreeOpen?: boolean;
  initialWebRemoteControlMobileNavigationIntent?: RootProps["initialWebRemoteControlMobileNavigationIntent"];
  webRemoteControlTerminalTransportState?: RootProps["webRemoteControlTerminalTransportState"];
  isDesktop?: RootProps["isDesktop"];
  isMacDesktop?: RootProps["isMacDesktop"];
  isWindowsDesktop?: RootProps["isWindowsDesktop"];
  supportsEmbeddedBrowser: NonNullable<RootProps["supportsEmbeddedBrowser"]>;
  windowsWindowControlsRightPaddingPx?: number;
}

// RootWorkspaceContent 解构全部 props 后原样下传；服务来自 ServiceProvider（INV-11），不在这里新建第二份。
// 返回层级固定：ProjectDirectoryProvider → 壳层 div → ServiceProvider → ScopedErrorBoundary → StableWorkspaceApp，
// 设置页与壳层并列覆盖（INV-02）；把设置页改成替换主界面会让关闭设置时整树重挂载。
export function RootWorkspaceContent({
  workspaceScopedServices,
  baseFeedbackService,
  workspaceShellPath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  activeWorkspacePath,
  isSettingsTabActive,
  handleConnectRemote,
  handleSelectRemoteProject,
  handleCancelRemoteProject,
  handleReconnectRemoteWorkspace,
  handleCreateTask,
  handleCreateConversationTask,
  handleResolveConversationWorkspace,
  handleOpenWorkspace,
  handleOpenFolderFromWorkspaceMenu,
  handleOpenRemoteWorkspace,
  remoteConnectionInProgress,
  remoteWorkspaceSessions,
  allowRemoteWorkspace,
  handleBackFromSettings,
  handleLogout,
  onLogin,
  user,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceRecoveryByWorkspaceKey,
  remoteWorkspaceErrorByWorkspaceKey,

  remoteConnectionLogs,
  allowOpenWorkspace,
  webRemoteControlWorkspaceSwitcher,
  initialSidebarFileTreeOpen,
  initialWebRemoteControlMobileNavigationIntent,
  webRemoteControlTerminalTransportState,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  supportsEmbeddedBrowser,
  windowsWindowControlsRightPaddingPx,
}: RootWorkspaceContentProps) {
  // workspaceKey = workspaceIdentity?.trim() || workspaceShellPath（INV-08），只用于 ScopedErrorBoundary 的 resetKeys：
  // 远程会话切换会改变该值并重置错误边界；漏掉 workspaceIdentity 会让同路径跨远端共用同一个边界。
  // workspaceKey 不参与任何状态归属，每次渲染按 workspaceIdentity/workspaceShellPath 重算。
  const workspaceKey = workspaceIdentity?.trim() || workspaceShellPath;

  // 切到设置页时记录一次可见性（INV-13）。
  // 日志带 workspaceShellPath 字段。
  // 该 effect 无业务副作用。
  useEffect(() => {
    // 记录一次设置层可见性供定位切层抖动（INV-13）：字段为 isSettingsTabActive / workspaceShellPath /
    // workspaceHiddenByLayout 恒 false 占位，走统一 logger 且不阻塞首次渲染。
    logger.info("[RootWorkspaceContent] settings layer visibility changed", {
      isSettingsTabActive,
      workspaceShellPath,
      workspaceHiddenByLayout: false,
    });
  // 依赖只含 isSettingsTabActive 与 workspaceShellPath：补入身份字段会在每次远端切换多打日志，
  // 省略依赖则切层不再记录；effect 无返回值，清理交给框架。
  }, [isSettingsTabActive, workspaceShellPath]);

  // 壳层常驻挂载（INV-01）：设置期用 opacity-0 + pointer-events-none 保布局与菜单锚点（INV-03/04）；
  // inert 挡底层交互（INV-06），foregroundEnabled={!isSettingsTabActive} 关前台遥测（INV-07）。
  // 改用 hidden 会让 quickpick 继承 display:none（INV-05）；两个 ScopedErrorBoundary 分别按 workspaceKey 重置（INV-09/12）。
  return (
    <ProjectDirectoryProvider isDesktop={isDesktop}>
      <div
        className={isSettingsTabActive ? "h-full opacity-0 pointer-events-none" : "h-full"}
        aria-hidden={isSettingsTabActive}
        data-root-workspace-surface={isSettingsTabActive ? "inert" : "interactive"}
        inert={isSettingsTabActive ? true : undefined}
      >
        {/* Bugfix: 设置页之前通过条件分支直接替换整个 App，关闭设置时会把主界面整棵树卸载再重建，
            聊天区、终端等本地 UI 状态都会被当成一次“重新进入 workspace”。
            这里改成让 workspace 壳层常驻挂载，只把设置页覆盖到上面。
            之前再额外按 workspacePath 改 key，会让跨工作区切 task 时把侧边栏和任务列表整棵卸载重建，
            用户看到的就是列表闪烁、日志里大量 mount/unmount。
            现在保持 App 实例连续，只在内部按需同步 workspace 相关局部状态，关闭设置和切换工作区都不会再触发整树重挂载。
            另外这里不能在切到设置页时直接用 hidden 把底层 workspace 壳层 display:none。
            侧边栏设置入口本身挂着 Radix DropdownMenu，菜单关闭动画仍在跑时如果锚点节点突然退出布局，
            Floating UI 会短暂失去定位参考，表现成菜单内容先闪到左上角再消失。
            之前这里用 invisible，虽然也能保留几何信息，但部分平台在整棵 workspace 壳层切成 visibility:hidden
            的那一帧会把 sidebar 视为一次突兀的可见性切换，切到 settings 时容易感觉“左侧闪一下”。
            这里改成 opacity-0 + pointer-events-none：仍然保留布局和菜单锚点，避免 DropdownMenu 丢参考点，
            同时把切层从“可见/不可见硬切”改成稳定的透明覆盖，减少 sidebar 闪烁。
            修复原因：这里如果误用 hidden，workspace 子树虽然还挂载，但 quickpick 弹层也会继承 display:none，
            用户在设置页按 Cmd/Ctrl+K 时状态已打开却完全不可见，所以必须保持布局占位只关闭交互。
            修复原因：只用 opacity 和 pointer-events 仍会让底层权限/AskUserQuestion 卡片的 autofocus
            抢走设置表单焦点；设置页覆盖期间必须把整棵 workspace 标为 inert，等用户显式返回后再恢复交互。 */}
        <ConversationTelemetryWorkspaceAttachment
          enabled={isDesktop === true}
          foregroundEnabled={!isSettingsTabActive}
          services={workspaceScopedServices}
          workspacePath={workspaceShellPath}
          workspaceIdentity={workspaceIdentity}
          remoteSessionId={workspaceRemoteSessionId}
        >
          <ServiceProvider services={workspaceScopedServices}>
            <ScopedErrorBoundary
              scope="workspace-app"
              resetKeys={[workspaceKey]}
              variant="panel"
              className="h-full"
            >
              <StableWorkspaceApp
                services={workspaceScopedServices}
                baseFeedbackService={baseFeedbackService}
                onConnectRemote={handleConnectRemote}
                onSelectRemoteProject={handleSelectRemoteProject}
                onCancelRemoteProject={handleCancelRemoteProject}
                onReconnectRemoteWorkspace={handleReconnectRemoteWorkspace}
                onLogout={handleLogout}
                onLogin={onLogin}
                user={user}
                reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
                remoteWorkspaceRecoveryByWorkspaceKey={remoteWorkspaceRecoveryByWorkspaceKey}
                remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
                remoteConnectionLogs={remoteConnectionLogs}
                workspaceAbsPath={workspaceShellPath}
                workspaceRemoteSessionId={workspaceRemoteSessionId}
                workspaceIdentity={workspaceIdentity}
                onCreateTask={handleCreateTask}
                onCreateConversationTask={handleCreateConversationTask}
                onResolveConversationWorkspace={handleResolveConversationWorkspace}
                onOpenWorkspace={handleOpenWorkspace}
                onOpenFolderFromWorkspaceMenu={handleOpenFolderFromWorkspaceMenu}
                onOpenRemoteWorkspace={handleOpenRemoteWorkspace}
                remoteConnectionInProgress={remoteConnectionInProgress}
                onReturnToWorkspace={handleBackFromSettings}
                allowOpenWorkspace={allowOpenWorkspace}
                webRemoteControlWorkspaceSwitcher={webRemoteControlWorkspaceSwitcher}
                initialSidebarFileTreeOpen={initialSidebarFileTreeOpen}
                initialWebRemoteControlMobileNavigationIntent={
                  initialWebRemoteControlMobileNavigationIntent
                }
                webRemoteControlTerminalTransportState={webRemoteControlTerminalTransportState}
                allowRemoteWorkspace={allowRemoteWorkspace}
                remoteWorkspaceSessions={remoteWorkspaceSessions}
                isWorkspaceVisible={!isSettingsTabActive}
                isDesktop={isDesktop}
                isMacDesktop={isMacDesktop}
                isWindowsDesktop={isWindowsDesktop}
                supportsEmbeddedBrowser={supportsEmbeddedBrowser}
              />
            </ScopedErrorBoundary>
          </ServiceProvider>
        </ConversationTelemetryWorkspaceAttachment>
      </div>

      {isSettingsTabActive ? (
        <ScopedErrorBoundary
          scope="workspace-settings-layer"
          resetKeys={[workspaceKey, isSettingsTabActive]}
          variant="panel"
          className="absolute inset-0 z-10"
        >
          <WorkspaceSettingsLayer
            workspaceScopedServices={workspaceScopedServices}
            isDesktop={isDesktop}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
            captionWorkspacePath={activeWorkspacePath}
            onBack={activeWorkspacePath ? handleBackFromSettings : undefined}
            onCreateTask={handleCreateTask}
            onOpenWorkspace={handleOpenWorkspace}
            onOpenRemoteWorkspace={handleOpenRemoteWorkspace}
            allowOpenWorkspace={allowOpenWorkspace}
            onLogin={onLogin}
            onLogout={handleLogout}
            user={user}
          />
        </ScopedErrorBoundary>
      ) : null}
    </ProjectDirectoryProvider>
  );
}
