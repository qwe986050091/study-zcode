// INV-01 纯新增 barrel：守住位置 文件头说明；改错故障 新旧入口同时被删，出现空窗。
// INV-02 只做 re-export：守住位置 全部 export 语句；改错故障 聚合文件里藏实现，难以定位。
// INV-03 传输层最先导出：守住位置 transport 组；改错故障 其余层引用到未导出的契约。
// INV-04 sessions-index 单独分组：守住位置 组注释；改错故障 读路径与写入路径混在一起。
// INV-05 持久行不属于本组：守住位置 注释中的 tasks-index；改错故障 调用方以为这里能拿到持久数据。
// INV-06 布局导出集中在 paneLayoutStore：守住位置 分屏组；改错故障 分屏动作分散到多个文件。
// INV-07 两套租约不混用：守住位置 两个 registry 组；改错故障 连接租约被当成索引租约释放。
// INV-08 类型与值成组导出：守住位置 每个 export 块；改错故障 调用方需要二次导入类型。
// INV-09 文件头标注里程碑：守住位置 前两行注释；改错故障 后续维护者不知道删除波次。
// INV-10 分组注释不写实现细节：守住位置 组标题；改错故障 注释随实现漂移。
// INV-11 新增导出要归组：守住位置 现有分组边界；改错故障 文件尾部无限堆积。
// INV-12 兼容期双入口并存：守住位置 与旧 store 的说明；改错故障 调用方误以为旧入口已移除。
// INV-13 barrel 无副作用：守住位置 只有 export；改错故障 引入即触发注册或请求。
// INV-14 交互弹窗宿主独立成行：守住位置 V4InteractionDialogs；改错故障 宿主被塞进会话面板。
//
// 模块职责：v4 UI 数据层的统一出口，按传输、投影、索引、布局与交互分组。
// 阅读顺序：先看文件头里程碑，再按组读 export，最后看待处理交互适配。
// UI 侧 v4 数据层（M3 m3-ui-core，docs/v4-refactor/06-ui）。
// 新旧入口并存，迁移完成后再删旧实现。
// 纯新增：与旧 store/zcodeSessionStore* 并存，删除发生在竖切可用后（11-deletion-plan 波次 1）。
export {
  conversationTopic,
  type ConversationTransport,
// 会话传输契约最先导出，其余层依赖它。
} from "@/v4/transport.js";
export {
  ConversationProjectionStore,
  type ConversationStoreState,
  type ConversationStoreStatus,
  type OptimisticCommand,
// 投影 store 与乐观命令一起导出。
} from "@/v4/conversationProjectionStore.js";
export {
  SessionDataLayer,
  type SessionDataLayerOptions,
  type SessionLease,
// 会话数据层与租约类型同组。
} from "@/v4/sessionDataLayer.js";
export {
  createAgentConversationTransport,
  type AgentConversationTransportTarget,
} from "@/v4/agentConversationTransport.js";
// 读路径单独分组，持久行不在这里。
// ── sessions-index 读路径（列表活性/detail 数据源；持久行来自 tasks-index）──
export {
  applySessionsIndexFrame,
  SessionsIndexStore,
  EMPTY_SESSIONS_INDEX_STATE,
  type SessionsIndexState,
  type SessionsIndexStoreStatus,
// 索引状态与归约函数一起导出。
} from "@/v4/sessionsIndexStore.js";
export {
  createAgentSessionsIndexTransport,
  type AgentSessionsIndexTransportTarget,
  type SessionsIndexTransport,
} from "@/v4/agentSessionsIndexTransport.js";
export {
  useSessionsIndex,
  type UseSessionsIndexResult,
} from "@/v4/useSessionsIndex.js";
export {
  LOCAL_SESSIONS_INDEX_ENDPOINT,
  acquireSessionsIndex,
  buildSessionsIndexEntryKey,
  releaseSessionsIndex,
  sessionsIndexRegistrySize,
  type SessionsIndexAgentService,
  type SessionsIndexScope,
// sessionsIndexRegistry 的租约注册表连同 LOCAL_SESSIONS_INDEX_ENDPOINT 一并导出。
} from "@/v4/sessionsIndexRegistry.js";
export {
  createCommandEnvelope,
  getV4ClientId,
  uuidv7,
} from "@/v4/commandFactory.js";
export {
  V4ConversationProvider,
  V4PaneConversationProvider,
  useV4Conversation,
  type V4ConversationContextValue,
  type V4PaneConversationProviderProps,
} from "@/v4/V4ConversationContext.js";
export { useConversationProjection } from "@/v4/useConversationProjection.js";
export { ConversationRowView } from "@/v4/ConversationRowView.js";
export { ConversationTimeline } from "@/v4/ConversationTimeline.js";
export { ConversationComposer } from "@/v4/ConversationComposer.js";
// 主会话面板连同 props 类型一起导出。
export { SessionPane, type SessionPaneProps } from "@/v4/SessionPane.js";
export { V4ChatPane, type V4ChatPaneProps } from "@/v4/V4ChatPane.js";
// 分屏布局与 workspace 工作台宿主归同一分组，导出顺序不参与运行时。
// ── 分屏二期：Layout/Focus 两层（二叉分割树）+ workspace 工作台宿主 ──
export {
  bindPaneSession,
  canAddPane,
  closePane,
  confirmRestoredPaneSession,
  countPanes,
  effectiveFocusedPaneId,
  focusPane,
  INITIAL_PANE_LAYOUT,
  leafPaneIds,
  MAX_WORKBENCH_PANES,
  openSessionInNewPane,
  paneWorkspaceKey,
  setSplitNodeRatio,
  splitPaneAt,
  usePaneLayoutStore,
  V4_LEGACY_SPLIT_PANE_ID,
  V4_PRIMARY_PANE_ID,
  type PaneBinding,
  type PaneLayoutNode,
  type PaneLayoutSnapshot,
  type PaneLayoutStore,
  type PaneWorkspaceScope,
  type SplitDirection,
// 分屏动作与类型集中自同一 store。
} from "@/v4/paneLayoutStore.js";
export {
  acquireWorkspaceConnection,
  buildWorkspaceConnectionKey,
  LOCAL_WORKSPACE_CONNECTION_ENDPOINT,
  WORKSPACE_CONNECTION_KEEP_WARM_MS,
  workspaceConnectionRegistrySize,
  type WorkspaceConnectionAgentService,
  type WorkspaceConnectionLease,
  type WorkspaceConnectionScope,
// 连接租约与索引租约是两个独立注册表。
} from "@/v4/workspaceConnectionRegistry.js";
export {
  V4WorkspaceChatArea,
  type V4WorkspaceChatAreaProps,
} from "@/v4/V4WorkspaceChatArea.js";
// V4InteractionDialogs 单独占一条 export，便于按需懒加载。
export { V4InteractionDialogs } from "@/v4/V4InteractionDialogs.js";
export {
  pendingPermissionToLegacyRequest,
  pendingUserInputToViewModel,
  type V4UserInputViewModel,
// 适配函数排在 export 列表末尾，与 pendingInteractionAdapter 的职责顺序一致。
} from "@/v4/pendingInteractionAdapter.js";
