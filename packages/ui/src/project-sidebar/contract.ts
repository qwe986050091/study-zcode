// INV-01 侧边栏三种视图固定：守住位置 ProjectSidebarView；改错故障 未知视图渲染空白。
// INV-02 设备行只带展示字段：守住位置 ProjectDevice；改错故障 组件直接依赖服务对象。
// INV-03 设备来源可缺省：守住位置 sourceServerId 可选；改错故障 远端设备被误判本地。
// INV-04 行操作可带图标：守住位置 ProjectRowAction.icon；改错故障 菜单项只剩文字。
// INV-05 行操作可标危险：守住位置 destructive；改错故障 删除与普通操作同色。
// INV-06 可用性只含展示态：守住位置 ProjectAvailability；改错故障 组件缓存服务内部状态。
// INV-07 升级入口不改变项目身份：守住位置 upgradeEntryId 注释；改错故障 升级后项目重复出现。
// INV-08 未解析状态单独标记：守住位置 unresolved；改错故障 远端项目被当成离线。
// INV-09 文件树目标带可选身份：守住位置 SidebarFileTreeTarget；改错故障 同路径跨远端串台。
// INV-10 外部目录请求可标记临时：守住位置 temporaryExternalDirectory；改错故障 临时目录被记忆。
// INV-11 打开请求带自增编号：守住位置 SidebarFileTreeOpenRequest.id；改错故障 连续请求被合并。
// INV-12 侧边栏属性只做导航：守住位置 ProjectSidebarProps 注释；改错故障 侧边栏持有组织状态。
// INV-13 选中任务带预期未读时间：守住位置 expectedUnreadAt；改错故障 未读角标反复回弹。
// INV-14 远端连接返回会话标识：守住位置 onConnectRemote 返回类型；改错故障 调用方无法定位会话。
// INV-15 远端项目选择可取消：守住位置 isCurrent 回调；改错故障 切换后旧请求仍然生效。
// INV-16 主题由外部注入：守住位置 theme 字段；改错故障 组件自行读取系统主题。
// INV-17 桌面平台标志集中传入：守住位置 三个平台字段；改错故障 组件直接探测运行平台。
// INV-18 本文件只声明类型与再导出：守住位置 无运行时实现；改错故障 出现循环依赖。
//
// 模块职责：项目侧边栏的公开类型契约与共享类型再导出。
// 状态所有权：无状态；只声明属性与回调形状。
// 阅读顺序：先看基础类型，再读文件树目标，最后看侧边栏属性。
import type { Locale, RemoteTarget, UserInfo } from "@zcode/shared";
import type { LucideIcon } from "lucide-react";
import type {
  AppProps,
  CreateTaskRequest,
  RemoteWorkspaceRecoveryStatus,
} from "@/app-shell/types.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { Theme } from "@/useTheme.js";
export { LEGACY_SINGLE_ROOT_PROJECT_PREFIX } from "@zcode/services";
export type { WebRemoteControlMobileTaskView, WebRemoteControlStatus } from "@zcode/shared";
// ProjectDevice 的 id 是设备选择键，列表项按它区分条目。
// label 只用于界面展示，不参与任何匹配。
// status 是已经本地化的展示字符串，不是枚举。
// sourceServerId 可缺省，本地设备不填来源服务。
// 该接口不承载连接状态，连接态由 workspace 侧维护。
// 新增字段一律标 optional，旧调用方不必同步补全。
export interface ProjectDevice {
  id: string;
  label: string;
  status: string;
  sourceServerId?: string;
}

export interface ProjectRowAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  run(): void;
  disabled?: boolean;
  destructive?: boolean;
}
export {
  buildRemoteHostWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
export type {
  WindowHostTaskAddress,
  WindowHostControllerTaskActivity,
} from "@zcode/shared/zcode-protocol-v4";
export type {
  TaskGroup,
  TaskGroupColor,
  TaskGroupStructure,
  GroupTaskRef,
  GroupNode,
  MoveGroupNode,
  ProjectTree,
  ProjectTask,
  ProjectTaskRef,
  VirtualProject,
  SaveProjectInput,
  IProjectService,
  IWindowControllerService,
  IZCodeTaskService,
  WindowHostControllerMutation,
  WindowHostControllerFrame,
  WindowHostTaskUnreadSignal,
  IRemoteProjectService,
  RemoteProjectDirectory,
  RemoteProjectEntry,
  RemoteProjectHost,
} from "@zcode/services";
// entryId 用于在可用性表里定位条目。
// upgradeEntryId 只在首次升级时替换旧排序键，不改变身份。
// online 与 unresolved 分成两个字段，未解析不算离线。
// 字段注释只解释语义，不参与 upgradeEntryId 的身份计算。
// entryId 缺省时按本地可用处理。
// ProjectAvailability 只供渲染判断，不写回任何状态。
export interface ProjectAvailability {
  entryId?: string;
  /** 仅首次升级入口用于替换旧排序键，不改变项目身份。 */
  upgradeEntryId?: string;
  online: boolean;
  unresolved?: boolean;
}
export type { Locale, Theme };
export type ProjectSidebarView = "projects" | "grouped" | "timeline";
// workspacePath 必填，是文件树的根。
// workspaceIdentity 与 workspaceRemoteSessionId 可选，远端工作区才带。
// revealPath 可指定树打开后要定位的路径。
// temporaryExternalDirectory 标记临时外部目录，不进入持久列表。
// SidebarFileTreeTarget 不含打开状态，展开与选中由上层维护。
export interface SidebarFileTreeTarget {
  workspacePath: string;
  workspaceName: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  revealPath?: string;
  temporaryExternalDirectory?: boolean;
}
export interface SidebarFileTreeOpenRequest {
  id: number;
  target: SidebarFileTreeTarget;
}
/** 项目、时间线共用同一 Host 行集合；回调只负责现有导航，不维护组织状态。 */
// ProjectSidebarProps 的属性只做导航与展示，不保存组织状态。
// 组织状态留在服务层。
// 回调可返回 Promise。
// 平台能力由布尔传入。
// 新增可选属性不破坏现有调用方。
export interface ProjectSidebarProps {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  activePreviewPath?: string | null;
  onOpenFileManager?: (target: SidebarFileTreeTarget) => void;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
    targetRemoteSessionId?: string,
    expectedUnreadAt?: number,
  ) => void;
  onStartDraftInWorkspace: (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenBrowserUrl?: (url: string) => void;
  fileTreeOpenRequest?: SidebarFileTreeOpenRequest | null;
  onCreateTask: (request?: CreateTaskRequest) => void;
  onCreateConversationTask: () => void;
  onCreateConversationTaskOnSource?: (sourceServerId: string) => void;
  onOpenFolderFromWorkspaceMenu: () => void;
  onOpenRemoteWorkspace?: AppProps["onOpenRemoteWorkspace"];
  webRemoteControlWorkspaceSwitcher?: import("@/root/types.js").WebRemoteControlWorkspaceSwitcherApi;
  theme: Theme;
  onConnectRemote: (
    options: RemoteTarget,
    requestId?: string,
    context?: { confirmSourceServerInstall?: boolean },
    feedback?: import("@/app-shell/types.js").RemoteConnectionFeedbackOptions,
  ) => Promise<string>;
  onSelectRemoteProject: (
    sessionId: string,
    path: string,
    localWorkspacePath?: string,
    preparedWorkspaceIdentity?: string,
    isCurrent?: () => boolean | Promise<boolean>,
  ) => Promise<void>;
  onCancelRemoteProject: (sessionId: string) => Promise<void>;
  onReconnectRemoteWorkspace: (workspaceKey: string) => Promise<void>;
  onLogout?: () => void;
  onLogin?: () => void;
  user?: UserInfo | null;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceRecoveryByWorkspaceKey?: Record<string, RemoteWorkspaceRecoveryStatus>;
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;
  isDesktop?: boolean;
  isWebRemoteControl?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isSidebarVisible?: boolean;
  onToggleSidebar?: () => void;
  toggleSidebarShortcutLabel?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  goBackShortcutLabel?: string;
  goForwardShortcutLabel?: string;
  onOpenCommandCenter: () => void;
  onOpenRepoWiki?: () => void;
  repoWikiActive?: boolean;
  onOpenAutomations?: () => void;
  onOpenPluginStore?: () => void;
  automationsActive?: boolean;
  pluginStoreActive?: boolean;
  onFileTreeOpenChange?: (open: boolean) => void;
  onWebRemoteTaskOpen?: (options: { crossWorkspace: boolean }) => void;
  onWebRemoteTaskSwitchingChange?: (switching: boolean) => void;
}
