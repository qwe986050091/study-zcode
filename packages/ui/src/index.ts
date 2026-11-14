// INV-01 导出是唯一跨包契约：守住位置 桶文件；改错故障 使用方深链内部路径。
// INV-02 类型与值分开导出：守住位置 类型导出语句；改错故障 类型被当成运行时值打包。
// INV-03 同模块导出合并：守住位置 分组导出；改错故障 同一文件多条语句漂移。
// INV-04 应用骨架与根组件各自独立：守住位置 两条导出；改错故障 根组件被包进骨架。
// INV-05 错误边界同时导出变体类型：守住位置 类型导出；改错故障 使用方无法标注变体。
// INV-06 窗口框架只导出一个入口：守住位置 单条导出；改错故障 出现两个同名框架。
// INV-07 功能开关提供方成对导出：守住位置 提供方与 hook 同组；改错故障 使用方拿不到读取函数。
// INV-08 远程控制分两条路径：守住位置 对话框与状态设置分离；改错故障 状态类型与实现错配。
// INV-09 图布局与图组件成对：守住位置 相邻导出；改错故障 布局算法无法被独立测试。
// INV-10 布局类型覆盖全部产物：守住位置 类型清单；改错故障 使用方只能写宽松类型。
// INV-11 连接对话框与终端互不依赖：守住位置 各自导出；改错故障 引入终端即加载连接逻辑。
// INV-12 测试动作只在开发构建消费：守住位置 导出名称；改错故障 生产包体混入测试接口。
// INV-13 主题 hook 与类型同源：守住位置 相邻导出；改错故障 类型与返回值不一致。
// INV-14 状态容器暴露读取钩子：守住位置 提供方与 hook 同组；改错故障 组件绕过容器直取全局。
// INV-15 远程工作区绑定成组导出：守住位置 六项同组；改错故障 注册与解绑不对称。
// INV-16 服务注册分源设置与基础：守住位置 两组导出；改错故障 覆盖同一注册表。
// INV-17 国际化入口单一：守住位置 提供方与切换器同组；改错故障 两套实例并存。
// INV-18 工具函数按领域分段：守住位置 段间空行；改错故障 文件展示与遥测混杂难寻。
//
// 模块职责：UI 包唯一的公共出口，集中声明跨包可用的组件、hook 与工具。
// 状态所有权：无；本文件只重导出，不创建实例也不执行副作用。
// 阅读顺序：顶部是应用骨架，中部是状态与服务，尾部是工具与遥测。
export { App } from "./App.js";
export { AppErrorBoundary, ScopedErrorBoundary } from "./ErrorBoundary.js";
export type { ScopedErrorBoundaryVariant } from "./ErrorBoundary.js";
// 本文件是 UI 包唯一的跨包出口，使用方只从这里导入。
// Button 与 buttonVariants 成对导出，组件和样式变体共用同一来源。
// 同一模块的多项导出合并进一个 export 块，减少重复语句。
// 类型统一走 export type，编译后会被擦除，不进入运行时包体。
// 包内路径不对外承诺，源码里的深链会在重构时断裂。
export { Button, buttonVariants } from "./components/ui/button.js";
export { DesktopWindowFrame } from "./DesktopWindowFrame.js";
export { WebRemoteControlDialog } from "@/web-remote-control/index.js";
export {
  WebRemoteControlFeatureProvider,
  useWebRemoteControlFeatureEnabled,
} from "./WebRemoteControlFeatureProvider.js";
export {
  AssistantCodeCommentFeatureProvider,
  useAssistantCodeCommentFeatureEnabled,
} from "./AssistantCodeCommentFeatureProvider.js";
// Root 与 UpdateStatusWindowRoot 是两个独立窗口入口，互不内嵌。
// StoreProvider 与 useZCodeStore 成组导出，读取不绕过容器。
// DesktopWindowFrame 与 UpdateStatusWindowRoot 分属两套窗口形态。
// registerRemoteWorkspaceSession 与 unregisterRemoteWorkspaceSession 成对导出，注册与解绑对称。
// 主题 hook 与类型同源。
export { Root } from "./Root.js";
export { UpdateStatusWindowRoot } from "./UpdateStatusWindowRoot.js";
export type { WebRemoteControlTerminalTransportState } from "./root/types.js";
export { setWebRemoteControlTerminalTransportState } from "./webRemoteControlTerminalTransportState.js";
export { ConfirmDialogHost } from "./ConfirmDialog.js";
export { Terminal } from "./Terminal.js";
export { GitGraphPane } from "./git-graph/GitGraphPane.js";
export { layoutGitGraph } from "./git-graph/layout.js";
export type {
  GitGraphCommit,
  GitGraphLayout,
  GitGraphLayoutEdge,
  GitGraphLayoutOptions,
  GitGraphLayoutRow,
  GitGraphRef,
  GitGraphRefKind,
} from "./git-graph/layout.js";
export { SSHDialog, RemoteConnectionDialog } from "./SSHDialog.js";
export { useTheme } from "./useTheme.js";
export type { Theme } from "./useTheme.js";
export { useTestActions } from "./test-actions.js";
export type { TestActions } from "./test-actions.js";
export { StoreProvider, useZCodeStore } from "./store/StoreProvider.js";
export type { ZCodeState } from "./store/index.js";
export {
  bindRemoteWorkspacePath,
  getRemoteWorkspaceSession,
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  unbindRemoteWorkspacePath,
  unregisterRemoteWorkspaceSession,
  useRemoteWorkspaceSessionStore,
} from "./store/remoteWorkspaceSessionStore.js";
export {
  REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE,
  createRemoteWorkspaceDisconnectedError,
} from "./lib/remoteWorkspaceServiceError.js";
export {
  getSourceSettingsServices,
  registerSourceSettingsServices,
  useSourceSettingsServices,
} from "./store/sourceSettingsServiceStore.js";

// Hooks —— 统一的服务和平台操作访问层
export {
  ServiceProvider,
  useServices,
  useWorkspaceServices,
  PlatformProvider,
  usePlatform,
  useSelectDirectory,
  useConnectRemote,
  useReaddir,
  useSystemInfo,
  useIntranetProbe,
  useTerminal,
  useSettings,
  useRecentProjects,
  useConfirmDialog,
  useCredentials,
  useAuthToken,
  useGitRepository,
  useGitActions,
} from "./hooks/index.js";

// 国际化入口给出 ZCodeIntlProvider、useZCodeIntl 与 LocaleSwitcher 三个符号。
// 资源管理应用 ResourceManagerApp 与标签类型 ResourceManagerTab 一并对外导出。
// fileDisplay.js 的 FileDisplayInline 等工具与 FileDisplayDescriptor 类型对外。
// 遥测与字号工具集中在同一段，export 顺序与源文件一致。
export { ZCodeIntlProvider, useZCodeIntl, LocaleSwitcher } from "./i18n/index.js";
export { ResourceManagerApp } from "./resource-manager/ResourceManagerApp.js";
export type {
  ResourceManagerAppProps,
  ResourceManagerTab,
} from "./resource-manager/ResourceManagerApp.js";
export type { IntlInstance } from "./i18n/index.js";
export {
  FileDisplayInline,
  createFileDisplayDom,
  getFileDisplayPath,
  resolveFileDisplayDescriptor,
  setDefaultFileDisplayBasePath,
} from "./lib/fileDisplay.js";
export type { FileDisplayDescriptor, FileDisplayOptions } from "./lib/fileDisplay.js";
export { playTaskNotificationSound } from "./lib/taskNotificationSound.js";
export { installDocumentHiddenMotionPause } from "./lib/documentHiddenMotionPause.js";
export {
  applyUiFontSizePx,
  loadUiFontSizePx,
  subscribeToUiFontSizeStorageChanges,
} from "./lib/uiFontSize.js";
export { reportUiLaunchToInput } from "./lib/uiPerfArmsTelemetry.js";
export {
  RendererUserActionTelemetry,
  runUserAction,
  runUserActionAsync,
  setUserActionTelemetry,
  startUserAction,
} from "./lib/userActionTelemetry.js";
export {
  CORE_USER_ACTION_FEATURES,
  SETTINGS_USER_ACTION_FEATURES,
  USER_ACTION_CATALOG,
} from "./lib/userActionTraceCatalog.js";
export { setReactErrorArmsReporter } from "./lib/reactErrorArmsTelemetry.js";
export { recordArmsCustomEventForE2E } from "./lib/armsCustomEventObservability.js";
export { generateMobileDeviceFingerprint, setStreamClientId } from "./lib/streamClientId.js";
export { GlobalDatabaseStartupLoading } from "./root/GlobalDatabaseStartupLoading.js";

export { LocalTtftObserver, setLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";
export { ensurePendingTaskDraft } from "@/v4/composer/composerDraftStore.js";
