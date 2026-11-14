/* eslint-disable max-lines -- Side pane tab 状态集中维护 Browser/Git/CodeViewer/Treemapping/Whiteboard 的打开、复用、关闭和排序规则；拆分需要同步迁移现有内存恢复逻辑。 */
import {
  createUuid,
  type BrowserTabResidencyState,
  type BrowserViewRestoredTabShell,
} from "@zcode/shared";
import type { PluginUiSidePaneTab } from "@/plugin-ui/contract.js";
import { inferMediaPreview, isPptxPreviewPath, type CodeViewerSource } from "@/lib/codeViewer.js";
import { normalizeCodeViewerSource } from "@/lib/codeViewerSource.js";

// 侧栏 tab 的类型定义与全部纯函数操作（打开/复用/关闭/排序/恢复/归属与可见性）。
// 这里不持有 React 状态，也不发 IPC；调用方（useAppPanels）负责把结果提交到 state。
//
// 不变量（INV）：
// INV-01 tab 身份只由 id 承载；多段 id 必须经 encodeSidePaneTabIdPart 编码
//   （守住它的位置：各 create*Tab 的 id 数组）。冒号不编码会让不同字段拼接后撞 id。
// INV-02 归属（ownerTaskId / workspaceKey / remoteSessionId）在创建时冻结，补章只补缺不覆盖
//   （守住它的位置：stampSidePaneTabsOwnership）。覆盖会让后台 tab 被当前 UI 抢走。
// INV-03 可见性 = workspace 匹配 + 按 type 选 owner 字段比较（守住它的位置：
//   isSidePaneTabVisibleInScope）。显示与操作必须共用它，否则会出现看得见却关不掉。
// INV-04 browser / browser-use / bash-output 必须常驻挂载（守住它的位置：
//   shouldMountSidePaneContent）。卸载 webview 会丢页面状态与 CDP 连接。
// INV-05 workflow-* 系列 tab 刻意没有 GC（守住它的位置：各 openWorkflow* 的既有注释）。
//   不要按 run 淘汰 / 父会话改写去关闭它们，journal 仍完整可读。
// INV-06 冷恢复的激活顺序 lastSelectedAt > openedAt > tabId，且不改变 tab strip 顺序
//   （守住它的位置：restoreBrowserTabShells 尾部）。重排会让用户认不出自己的标签。
// INV-07 residencyGeneration 单调递增，旧 generation 事件必须丢弃（守住它的位置：
//   applyBrowserTabResidencyEvent）。乱序 IPC 会把 tab 打回旧状态。
// INV-08 visibility 事件只命中已存在的 shell，绝不创建（守住它的位置：
//   applyBrowserUseSidePaneVisibilityEvent）。迟到事件会造出无 main authority 的僵尸 tab。
// INV-09 patch / multi-file-diff 的 sourceKey 必须含内容摘要（守住它的位置：
//   getCodeViewerTabSourceKey）。只按 path 复用会让不同轮次的 diff 互相覆盖。
// INV-10 code-viewer 的 sourceKey 先按 workspace 作用域，再归一 pptx/media 的入口表示
//   （守住它的位置：getCodeViewerTabSourceKey）。入口类型不是文件身份。
// INV-11 closeSidePaneTab 返回 null 表示 tab 清空，收起由上层负责（守住它的位置：
//   useAppPanels.commitSidePaneState）；这里不制造 new-tab。
// INV-12 重开 browser tab 必须换新 id 并剥离 residency（在 useAppPanels 中执行，
//   restoreSidePaneTab 只做通用激活）。
// INV-13 按 URL 复用只激活已有 tab，不改字段（守住它的位置：
//   openOrActivateBrowserSidePaneByUrl）。重新取字节由上层另发导航请求。
// INV-14 actor tab 身份是 (workspace, parent, runId, siteId@ordinal)，不含 actorSessionId
//   （守住它的位置：createWorkflowActorSessionSidePaneTab）。会话可先缺席后补。
// INV-15 artifact tab 身份不含 version；复用时请求缺席即删除旧 version（守住它的位置：
//   openWorkflowArtifactSidePane）。否则 chip 再点一次仍停在旧版本。
// INV-16 workflow-run 原地替换必须先挡「新 id === 旧 id」的自替换（守住它的位置：
//   replaceWorkflowRunSidePane）。否则会关掉自己并留下裸 activeTabId。
// INV-17 展开补入口只补当前 scope 的 new-tab（守住它的位置：ensureSidePaneTab），
//   不改变其他对话的标签。
// INV-18 Office 模式的入口过滤不在此层（在 useAppPanels 的返回值与最近关闭菜单）。
//
// 阅读顺序：类型 → 挂载判定 → 归一化 → 创建器 → 可见性/归属 → 打开与复用 → 事件应用 →
// 关闭与排序。
export interface BrowserSidePaneTab {
  id: string;
  type: "browser";
  /** 打开 tab 时冻结的对话归属；null 表示草稿态。 */
  ownerTaskId?: string | null;
  /** 工作区隔离 key（workspaceIdentity || workspacePath）。 */
  workspaceKey?: string | null;
  remoteSessionId?: string | null;
  faviconUrl?: string | null;
  initialUrl?: string | null;
  /** 由 Agent 控制的页面触发的 popup；不应套用人类浏览器的持久化显示偏好。 */
  agentOpened?: boolean;
  openedAt?: number;
  title?: string | null;
  residency?: BrowserTabResidencyState;
  residencyGeneration?: number;
}

// 页面元数据只允许这两项：URL 与归属绝不能被元数据通道改写；
// 收窄成 Partial Pick 是为了让误传风险在编译期暴露。
export type BrowserSidePaneMetadata = Partial<Pick<BrowserSidePaneTab, "faviconUrl" | "title">>;

// 操作指示器持续 5s：足够跨越一次典型命令往返，又不会长时间残留误导用户；
// UI 侧按截止时间自行到期，不需要逐条事件清理。
export const BROWSER_USE_OPERATION_INDICATOR_DURATION_MS = 5_000;

// 站点权限设置 tab 的身份是 origin（同站点 + 同 workspace + 同对话只保留一个）；
// origin 必须原样保存，不做 URL 归一，否则 http/https 端口差异会被合并。
export interface BrowserPermissionsSidePaneTab {
  id: string;
  type: "browser-permissions";
  origin: string;
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

// Git tab 的 id 固定为 "git"：同一工作区只允许一个 Git 面板，重复打开即激活。
export interface GitSidePaneTab {
  id: "git";
  type: "git";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

// 文件管理器目标同时携带「显示用 workspaceName」与「访问用 identity/remoteSessionId」；
// identity 用于跨 workspace 判定，路径只用于本机访问，两者不可互相替代。
// temporaryExternalDirectory 标记工作区外的临时目录：它不参与跨 workspace 路由。
export interface FileManagerTarget {
  workspacePath: string;
  workspaceName?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  revealPath?: string;
  temporaryExternalDirectory?: boolean;
}

export interface FileManagerSidePaneTab {
  id: string;
  type: "file-manager";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  target: FileManagerTarget;
  source: CodeViewerSource | null;
}

// sourceKey 是复用键，null 表示该 source 无法稳定标识（每次打开都新建）；
// source 必须存归一化后的结构，否则重新打开同一文件会因 entry type 不同而分裂。
export interface CodeViewerSidePaneTab {
  id: string;
  type: "code-viewer";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  source: CodeViewerSource;
  sourceKey: string | null;
}

export type TreemappingSidePaneSource =
  | { kind: "current" }
  | { kind: "message"; messageId: string; turnIndex?: number };

// treemapping 类型保留但入口已下线；
// normalize 会在状态边界把历史 tab 过滤掉，因此正常情况下不会出现在 UI。
export interface TreemappingSidePaneTab {
  id: "treemapping";
  type: "treemapping";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  source?: TreemappingSidePaneSource;
}

// 白板 tab 只存 boardId 与标题，板内容由白板服务按 id 读取；
// 不要把画布快照塞进 tab，否则关闭重开会看到旧内容。
export interface WhiteboardSidePaneTab {
  id: string;
  type: "whiteboard";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  boardId: string;
  openedAt?: number;
  title: string;
}

// 轨迹 tab 按 taskId 唯一；title 仅展示用，可缺席。
export interface ModelTrajectorySidePaneTab {
  id: string;
  type: "model-trajectory";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  /** 目标 task/session id；model-io 按该 id 匹配。 */
  taskId: string;
  title?: string | null;
}

// 插件市场是 workspace 级单例页，id 固定，不携带选中插件等内层状态；
// PluginMarketSidePaneTab 的内层导航由页面自身维护，切走再回来重置是预期行为。
export interface PluginMarketSidePaneTab {
  id: "plugin-market";
  type: "plugin-market";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

// DeveloperToolsSidePaneTab 是单例页，作为调试入口不参与最近关闭恢复。
export interface DeveloperToolsSidePaneTab {
  id: "developer-tools";
  type: "developer-tools";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

// 终端 id 用 uuid：终端天然多实例，不能按 cwd 复用；
// remoteSessionId 决定 PTY 建在本地还是远端，创建后不可改。
export interface TerminalSidePaneTab {
  id: string;
  type: "terminal";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  title: string;
  cwd?: string;
  remoteSessionId?: string | null;
}

/** browser-use 受控浏览器视图（renderer `<webview>` + main CDP）。 */
// 受控浏览器 tab 的三层身份：id 是 renderer 壳，tabId 是 main 分配的 logical tab，
// browserId + browserGeneration 指向具体 browser 实例；三者必须一起校验才能防串写。
// residency 表示 guest 生命周期，suspended 时 unmount 但保留壳；
// browserUseResizeBaselineVersion 是模型布局命令的单调版本，用于重建 ResizeObserver 基线。
export interface BrowserUseSidePaneTab {
  id: string;
  type: "browser-use";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  remoteSessionId?: string | null;
  sessionId: string;
  /** main 分配的 opaque IAB tab identity，也是 webview attach key。 */
  tabId: string;
  browserId?: string;
  browserGeneration?: number;
  openedAt?: number;
  title?: string | null;
  faviconUrl?: string | null;
  residency?: BrowserTabResidencyState;
  residencyGeneration?: number;
  /** 最近一次 agent browser-use 操作的 UI 指示截止时间。 */
  browserUseOperationUntil?: number;
  /** 模型布局命令对应的单调版本；目标 view 据此重建 ResizeObserver 基线。 */
  browserUseResizeBaselineVersion?: number;
}

// 打开请求同时是 tab 的字段基座（BackgroundBashSidePaneTab extends 它）；
// rootSessionId 与 sessionId 必须都带：前者定可见性，后者定内容来源；
// workId 是「同一次后台作业」的唯一键，进入 id 后保证重复打开幂等。
export interface OpenBackgroundBashSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId: string;
  sessionId: string;
  workId: string;
  title: string;
}

// 后台 Bash 的 id 由 workspace + remote + root + session + workId 组成（见创建函数），
// 这样同一 work 重复点击幂等，同时不同 run 的同类输出不会合并且互相顶掉；
// ownerTaskId 固定为 rootSessionId：输出面板属于根会话，而不是触发的子会话。
export interface BackgroundBashSidePaneTab extends OpenBackgroundBashSideTabRequest {
  id: string;
  type: "bash-output";
  workspaceKey: string;
  ownerTaskId: string;
  openedAt?: number;
}

// 子智能体 tab 的 id 含 workspace/root/child 三段，保证跨根会话与同名子会话不撞；
// rootSessionId 缺失时由创建函数回落到 parentSessionId，二者语义必须区分。
export interface SubagentSessionSidePaneTab {
  id: string;
  type: "subagent-session";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}

// 目录页按 (workspace, root, parent) 定位，不携带任何子会话列表快照；
// 列表每次挂载从投影重读，避免恢复出过期名单。
export interface SubagentDirectorySidePaneTab {
  id: string;
  type: "subagent-directory";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId: string;
  parentSessionId: string;
}

// 框选副屏的编号 ordinal 只在 (workspace, parentSession) 内唯一，用于标题展示；
// 它不参与 id：同一 childSessionId 永远对应同一个 tab。
export interface SelectionSideChatPaneTab {
  id: string;
  type: "selection-side-chat";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  ordinal: number;
}

// 计划详情 tab 按 (workspace, parentSession, toolCallId) 唯一；
// markdown 是打开时的 fallback 正文，实时正文仍以父会话投影为准。
export interface PlanDetailSidePaneTab {
  id: string;
  type: "plan-detail";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  toolCallId: string;
  markdown: string;
  planFilePath?: string;
}

// markdown 是打开瞬间的 fallback，planFilePath 只用于定位与在编辑器中打开；
// 两者都不参与 tab id。
export interface OpenPlanDetailSideTabRequest {
  parentSessionId: string;
  toolCallId: string;
  markdown: string;
  planFilePath?: string;
}

/**
 * workflow run 的详情页 tab。
 *
 * 身份是 **run**（`runId`），不是发起它的工具调用：一次 CreateWorkflow 只启一个 run，
 * 但 run 才是引擎、journal 与 `cancelBackgroundWork {workId}` 三处共用的键
 * （`workId ≡ taskId ≡ runId`）。`toolCallId` 仍要带上——静态因果图在那条工具调用行的
 * display 里，详情页按它在父会话投影里找图。
 *
 * ## 这个 tab 刻意**没有 GC**，别加
 *
 * 看起来很自然的两条回收规则都是错的：
 *
 * - **run 被 `WORKFLOW_RUNS_LIMITS.maxRuns`（8 条）淘汰时不要关它。** 详情页的事件日志读的是
 *   **journal**，不是 `workflowRuns` 投影。被淘汰的 run 丢的只有实时叠加状态，它的事件日志
 *   仍然**完整**——那恰恰是用户会把这个 tab 留着的场景（回看一次已结束的 run 是怎么跑的）。
 *   自动关掉等于亲手销毁一次已完结 run 的唯一持久视图。淘汰只降级成详情页里那块
 *   「已不在实时跟踪范围内」的空态，措辞也必须诚实：丢的是实时状态，run 本身没有消失。
 * - **父会话 edit / retry 时不要关它。** run 身份不会因为对话被改写而失效，最多是那条工具
 *   调用行不在窗口里了——那同样只降级成"没有图可画"，不是"这个 tab 该消失"。
 *
 * 可见性已经按 `parentSessionId` 收窄（同 plan-detail），所以 tab 不会泄漏到别的对话里。
 * `syncSubagentSessionSidePaneTabs` 那套回收只作用于 subagent-session，不要把它扩过来。
 */
export interface WorkflowRunSidePaneTab {
  id: string;
  type: "workflow-run";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  /** 打开时冻结的展示名，仅作投影缺席（run 被淘汰 / 冷启动）时的标题兜底。 */
  workflowName?: string;
  /** 落点：展开这一站、列出全部、节头滚到顶。缺席即停在原处。 */
  focusPhaseId?: string;
}

// 请求与 tab 字段同构，额外只多一个 replaceRunId；
// toolCallId 用于静态因果图，runId 才是身份：一次工具调用只启一个 run，但 run 可以来自重试。
// 缺 toolCallId 时仍能打开详情，只是没有图可画。
export interface OpenWorkflowRunSideTabRequest {
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  workflowName?: string;
  /** 落点：详情页展开这一站、列出全部、滚到节头。缺席即停在原处。 */
  phaseId?: string;
  /**
   * 「配置」之后面板跟着工作流走：
   * 把显示这个 run 的 tab **原地**换成新 run 的 tab——同一个位置、沿用它的名字与归属。没有这样的
   * tab（已关掉）就什么都不做：面板不会为此重新打开。
   */
  replaceRunId?: string;
}

/**
 * 一条对话的 workflow run 目录 tab。
 *
 * 身份是**对话**（`parentSessionId`）：一条对话只有一份 run 目录，所以页脚行重复点击幂等地
 * 聚焦同一个 tab——与 `subagent-directory` 同构。
 *
 * 这个 tab 不带任何 run 数据：目录页自己按 `parentSessionId` 读一页 journal（run 目录的
 * 单一信源）。把摘要冻进 tab 会让「重启后打开一个恢复出来的 tab」显示
 * 一份过期名单，而它恰恰就是为重启后那一刻存在的。
 */
export interface WorkflowRunDirectorySidePaneTab {
  id: string;
  type: "workflow-directory";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
}

// 目录页请求只需 workspace + parent：目录按对话聚合，与具体 run 无关；
// workflowName 仅用于标题展示，命中已有 tab 时会刷新。
export interface OpenWorkflowRunDirectorySideTabRequest {
  parentSessionId: string;
}

/**
 * 一个 dwf actor 实例的 transcript tab。
 *
 * 身份是 **actor 会话**：一个实例一条真实持久会话，所以 `actorSessionId` 就是 tab 身份。
 * `runId` / `siteId` / `ordinal` 一起带上是为了标题、搜索与排查——它们是 journal 的键，
 * 而会话 id 是 run service 按 `(runId, actorRef)` 铸造出来的，不该被 renderer 反解。
 *
 * ## 为什么是**独立类型**，不是给 `subagent-session` 加一个变体标记
 *
 * `syncSubagentSessionSidePaneTabs` 会删掉 `childSessionId` 不在 `validChildSessionIds`
 * 里的 subagent tab，而 actor 会话**永远不在**那个集合里（它不是子智能体的子会话）。复用
 * 那个类型等于：父会话的 subagent 投影每更新一次，这个 tab 就被回收一次。修法只能是教那套
 * 回收认识变体标记，也就是同样的工作量，只是把不变式藏进了回收逻辑里。
 *
 * 另外两处也会打架：subagent tab 的可见性按 `rootSessionId` 收窄（actor tab 要按
 * `parentSessionId`，同 workflow-run），而 `lastActiveSubagentTabByRootRef` 按
 * `rootSessionId` 记忆 active tab——actor tab 没有、也不该有一个 root 会话。
 *
 * ## GC：同 `workflow-run`，**没有**，别加
 *
 * actor 会话在 run 结束后继续存在（这正是持久化落库换来的durable-audit）。run 被 8-run
 * 上限淘汰、父会话 edit/retry、run 结算——三者都不该关掉一份仍然可读的 transcript。
 * 可见性已按 `parentSessionId` 收窄，所以它也不会泄漏到别的对话里。
 */
export interface WorkflowActorSessionSidePaneTab {
  id: string;
  type: "workflow-actor-session";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  runId: string;
  /**
   * actor 会话 id：嵌套只读 SessionPane 读的那条会话。**可缺席**——从一枚还没启动的药丸开的
   * tab 打开时没有会话；面板按
   * 槽位在实时投影里找它，找到即自愈。身份不在这里，在 (runId, siteId, ordinal)。
   */
  actorSessionId?: string;
  /** actor 站点 id 与序号：与 runId 一起是 tab 的身份，从不参与命名。 */
  siteId: string;
  ordinal: number;
  /** 脚本里写下的名字（`agent("reviewer")`）；分析拿不到字面量时缺席，标题走本地化兜底。 */
  actorName?: string;
}

// actorSessionId 可缺席：药丸可能先于会话创建被点击；
// siteId 与 ordinal 才是身份（INV-14），缺失时退回未启动态的展示。
// phaseId 只决定打开后落在哪个阶段。
export interface OpenWorkflowActorSessionSideTabRequest {
  parentSessionId: string;
  runId: string;
  /** 打开时已知的会话 id；未启动的槽位缺席。 */
  actorSessionId?: string;
  siteId: string;
  ordinal: number;
  actorName?: string;
}

export interface OpenScopedWorkflowActorSessionSideTabRequest extends OpenWorkflowActorSessionSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/**
 * 一个 workflow run 的**脚本 transcript** tab：
 * 脚本里 `files.*` / `git.*` / `world.run` 的每一次调用回放成一张工具卡。
 *
 * 与 actor transcript 同一逻辑层级（都是「run 里某个参与者做过什么」），但工作区没有会话，
 * 所以它是自己的类型而不是 actor tab 的变体：面板不嵌 SessionPane，而是拿两条 journal 查询
 * 自己画卡片。身份是 **(workspace, 父会话, run)**——一个 run 一个 tab，从哪一站点开都是它；
 * `focusPhaseId` 只是落点（滚到那一站的第一张卡），每次打开都重新落。
 *
 * GC：同 `workflow-actor-session`，**没有**——journal 行在 run 结束后继续存在，这份回放正是
 * 为事后审计而存在的。可见性按 `parentSessionId` 收窄。
 */
export interface WorkflowWorkspaceSidePaneTab {
  id: string;
  type: "workflow-workspace";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  /** 发起该 run 的工具调用 id：静态图（阶段名、步标签）挂在那条行上，与 workflow-run tab 同一条路。 */
  toolCallId: string;
  runId: string;
  /** 打开时冻结的展示名，仅作投影缺席时的标题兜底。 */
  workflowName?: string;
  /** 落点：滚到这一站的第一张卡；还没到的站落到末尾。缺席即停在原处。 */
  focusPhaseId?: string;
}

// 脚本回放页按 runId 唯一，phaseId 只作为落点；
// toolCallId 同样用于图定位，不参与 id。
// title 与 workflowName 分工：前者是 tab 文案，后者是工作流名。
export interface OpenWorkflowWorkspaceSideTabRequest {
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  workflowName?: string;
  phaseId?: string;
}

export interface OpenScopedWorkflowWorkspaceSideTabRequest extends OpenWorkflowWorkspaceSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/**
 * 一个 dwf **产物**的全尺寸查看 tab。
 *
 * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出（一个文件 / 一段 markdown /
 * 一张 journal 投影出来的看板），**不是**引擎内部 `RunSettlement.artifact` 那个「脚本顶层
 * 返回值」。
 *
 * 身份是 **(run, 产物 id)**，不含版本：同一个产物反复发布是同一件东西的新版本，再点一次
 * 应当**聚焦已开的 tab 并翻到最新版**，而不是并排开出 v1 / v2 两个 tab。`version` 因此只是
 * 打开时的初始落点（通知 chip / 中枢 chip 都不带版本号，缺席即最新版），头部的版本步进器
 * 才是真正的版本导航。
 *
 * ## GC：同 `workflow-run`，**没有**，别加
 *
 * 产物的字节在发布时刻就拷进了 store（发布即钉住的约定），所以一个被 8-run 上限
 * 淘汰、甚至整条对话被 edit 重写的 run，它的产物仍然**完整可读**——那正是用户会把这个 tab
 * 留着的场景。可见性已按 `parentSessionId` 收窄，tab 不会泄漏到别的对话里。
 */
export interface WorkflowArtifactSidePaneTab {
  id: string;
  type: "workflow-artifact";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  runId: string;
  /** 产物 id（脚本里的编译期字面量，`[A-Za-z0-9_.-]` ≤ 64）。 */
  artifactId: string;
  /** 打开时的初始版本；缺席即最新版。**不进 tab 身份**——见类型上那段注释。 */
  version?: number;
  /** 打开时冻结的展示名，仅作元数据缺席（冷恢复 / 老 CLI）时的标题兜底。 */
  title?: string;
}

// 产物请求里的 contentType / sourcePath 只服务「html 直开浏览器」的裁决，不写入 tab；
// title 是元数据缺席时的标题兜底；
// version 只影响初始落点，重复点击不带版本即回到最新版。
export interface OpenWorkflowArtifactSideTabRequest {
  parentSessionId: string;
  runId: string;
  artifactId: string;
  version?: number;
  title?: string;
  /**
   * 最新版的 contentType（表面上的摘要带得到就带）。`useAppPanels.handleOpenWorkflowArtifact`
   * 据它决定 html 产物是直接开浏览器 tab 还是开产物 tab；缺席即一律开产物 tab。
   */
  contentType?: string;
  /**
   * 工作区相对的原路径。只有已经合并过 journal 的表面（run 侧板）带得到；缺席时由
   * `handleOpenWorkflowArtifact` 自己查 journal 补齐——摘要刻意不带它（状态帧体积）。
   */
  sourcePath?: string;
}

// Scoped 变体只补 workspace 三件套：path / identity / remoteSessionId；
// 调用方必须传真实 workspace，而不是从当前 UI 借值。
export interface OpenScopedWorkflowArtifactSideTabRequest extends OpenWorkflowArtifactSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenScopedWorkflowRunSideTabRequest extends OpenWorkflowRunSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenScopedWorkflowRunDirectorySideTabRequest extends OpenWorkflowRunDirectorySideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

// Scoped 变体只补 workspace 三件套；宿主调用时 workspacePath 必须来自真实 tab 上下文，
// identity 优先用于归属判定，不能退化成路径拼接。
export interface OpenScopedPlanDetailSideTabRequest extends OpenPlanDetailSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

// replacesChildSessionId 表示 active child 已确认不存在，宿主据此原子替换旧 tab；
// 它只在打开阶段生效，不进入 tab 字段，避免把一次性意图持久化。
export interface OpenSelectionSideChatRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  /** active child 已确定不存在时，由宿主原子替换对应旧 tab。 */
  replacesChildSessionId?: string;
}

// parentSessionId 与 rootSessionId 都必填：前者用于可见性，后者用于「按根记住上次 tab」；
// childSessionId 是内容键，workspace 三件套是归属键，二者不可合并。
export interface OpenSubagentSideTabRequest {
  rootSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}

export interface OpenSubagentDirectorySideTabRequest {
  rootSessionId?: string;
  parentSessionId: string;
}

export interface OpenScopedSubagentDirectorySideTabRequest extends OpenSubagentDirectorySideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

// validChildSessionIds 是父会话投影给出的权威集合；
// rootSessionId 与 parentSessionId 必须同时用于匹配，
// 只按 parent 会误删同一父会话下其他根的 tab（多窗口共享状态时会出现）。
export interface SyncSubagentSessionTabsRequest {
  rootSessionId: string;
  parentSessionId: string;
  validChildSessionIds: readonly string[];
}

export interface OpenScopedSubagentSideTabRequest extends OpenSubagentSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

// new-tab 没有内容字段，只作为启动器占位；
// 从它启动的第一个工具会原位替换它（见 useAppPanels 的 commitOpenedSidePaneState）。
export interface NewTabSidePaneTab {
  id: string;
  type: "new-tab";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

// 新增 tab 类型时必须同步三处，否则会出现「能打开但不可见/关不掉」：
// 1) isSidePaneTabVisibleInScope 的 type 分支；2) 最近关闭的过滤规则；3) 导出面的关闭入口。
// 联合类型本身不做穷尽检查，遗漏只会在运行期表现为空面板。
export type WorkspaceSidePaneTab =
  | FileManagerSidePaneTab
  | NewTabSidePaneTab
  | BackgroundBashSidePaneTab
  | BrowserSidePaneTab
  | BrowserPermissionsSidePaneTab
  | GitSidePaneTab
  | CodeViewerSidePaneTab
  | TreemappingSidePaneTab
  | WhiteboardSidePaneTab
  | ModelTrajectorySidePaneTab
  | PluginMarketSidePaneTab
  | DeveloperToolsSidePaneTab
  | TerminalSidePaneTab
  | BrowserUseSidePaneTab
  | SubagentSessionSidePaneTab
  | SubagentDirectorySidePaneTab
  | SelectionSideChatPaneTab
  | PlanDetailSidePaneTab
  | PluginUiSidePaneTab
  | WorkflowRunSidePaneTab
  | WorkflowRunDirectorySidePaneTab
  | WorkflowActorSessionSidePaneTab
  | WorkflowWorkspaceSidePaneTab
  | WorkflowArtifactSidePaneTab;

/**
 * Browser/browser-use 的页面与 CDP 生命周期依赖 `<webview>` 持续连接 DOM。
 * 面板折叠或切到其它对话时仍必须后台挂载，只有显式关闭 tab 才能销毁页面状态。
 */
// INV-04：面板折叠或切到其他对话时，只要还存在 browser/browser-use/bash-output，就必须后台挂载；
// webview 一旦卸载，页面状态、会话与 CDP 连接全部丢失，恢复只能重新导航。
// 只有显式关闭 tab（从状态里删除）才允许销毁内容。
export function shouldMountSidePaneContent(
  isVisible: boolean,
  tabs: readonly WorkspaceSidePaneTab[],
): boolean {
  return (
    isVisible ||
    tabs.some(
      (tab) => tab.type === "browser" || tab.type === "browser-use" || tab.type === "bash-output",
    )
  );
}

// suspended / suspend-pending 时只保留壳、不挂 guest；
// 其余状态（含 restoring）都必须挂载，否则恢复流程等不到 did-attach。
export function shouldMountBrowserTabGuest(
  tab: BrowserSidePaneTab | BrowserUseSidePaneTab,
): boolean {
  return tab.residency !== "suspended" && tab.residency !== "suspend-pending";
}

// tabs 顺序即标签条顺序；activeTabId 允许为空串（无激活）。
// 不要用 null 表示空面板——null 表示「该 workspace 从未有面板」。
export interface WorkspaceSidePaneState {
  tabs: WorkspaceSidePaneTab[];
  activeTabId: string;
}

// 状态边界统一迁移：过滤已下线的 treemapping，并给旧 selection-side-chat 回填 ordinal；
// 没有实际变化时返回原引用，调用方据此避免无意义 setState；
// 迁移只在这一处做，其他读取路径不应再各自兜底。
export function normalizeWorkspaceSidePaneState(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  if (!current) {
    return null;
  }

  // Treemapping 当前需要从侧边栏隐藏。旧版本可能已经把 treemapping tab
  // 写进了 workspace 级 side pane 记忆，这里在状态边界统一过滤，避免恢复后入口继续出现。
  // treemapping 已从侧边栏下线，但历史记忆里可能仍有；
  // 在状态边界统一过滤，避免恢复后入口继续出现。
  const filteredTabs = current.tabs.filter((tab) => tab.type !== "treemapping");
  if (filteredTabs.length === 0) {
    return null;
  }

  // 多开引入 `ordinal` 之前创建的辅助对话 tab（HMR/同窗口旧内存状态）没有该
  // 字段，直接参与 getNextSelectionSideChatOrdinal 会得到 NaN/undefined 并造成标题
  // 编号冲突。这里在状态边界按 parent 分组回填最小可用编号，保持既有编号不变。
  // 旧 tab 没有 ordinal，直接参与编号会导致 NaN 与标题冲突；
  // 这里按 parent 分组逐项回填最小可用 ordinal，并保持已存在的编号不变。
  let migratedOrdinal = false;
  const tabs = filteredTabs.map((tab, index, allTabs) => {
    if (tab.type !== "selection-side-chat" || Number.isInteger(tab.ordinal)) {
      return tab;
    }
    // allTabs 中本轮迭代已回填的 tab 被原位替换，天然带整数 ordinal 参与占用判定。
    // 占用集合按 (workspaceKey, parentSessionId) 分组；
    // 只看 parent 会让不同工作区的同名会话共享编号。
    const used = new Set(
      allTabs.flatMap((candidate) =>
        candidate.type === "selection-side-chat" &&
        candidate.workspaceKey === tab.workspaceKey &&
        candidate.parentSessionId === tab.parentSessionId &&
        Number.isInteger(candidate.ordinal)
          ? [candidate.ordinal]
          : [],
      ),
    );
    let ordinal = 1;
    while (used.has(ordinal)) ordinal += 1;
    migratedOrdinal = true;
    const migrated: SelectionSideChatPaneTab = { ...tab, ordinal };
    allTabs[index] = migrated;
    return migrated;
  });

  // activeTabId 为空串表示「无激活」，是合法状态；
  // 非空但已不存在时回落到最后一个 tab，保证内容区永远有指向。
  const activeTabId =
    current.activeTabId === "" || tabs.some((tab) => tab.id === current.activeTabId)
      ? current.activeTabId
      : tabs[tabs.length - 1]!.id;
  if (
    !migratedOrdinal &&
    tabs.length === current.tabs.length &&
    // 三重无变化判定后返回原引用：这是提交层判断「是否需要 setState」的依据。
    activeTabId === current.activeTabId
  ) {
    return current;
  }

  return {
    tabs,
    activeTabId,
  };
}

// 所有 human browser tab 的唯一创建路径；id 前缀固定为 browser:；
// 字段用条件展开而非写 undefined，避免序列化后出现空键污染记忆；
// remoteSessionId 在这里创建即冻结（见下方既有注释），是关闭授权能匹配的前提。
function createBrowserSidePaneTab(options?: {
  tabId?: string;
  initialUrl?: string | null;
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  remoteSessionId?: string | null;
  agentOpened?: boolean;
}): BrowserSidePaneTab {
  return {
    // 冷恢复时由 main 回传 tabId，必须沿用它，否则壳与 main 的 logical tab 对不上；
    // 新建才生成 uuid。
    id: options?.tabId ?? `browser:${createUuid()}`,
    type: "browser",
    ...(options?.ownerTaskId !== undefined ? { ownerTaskId: options.ownerTaskId } : {}),
    ...(options?.workspaceKey !== undefined ? { workspaceKey: options.workspaceKey } : {}),
    // human tab 过去从不写 remoteSessionId，而 stampSidePaneTabsOwnership 只补
    // ownerTaskId 未定义的 tab —— 凡是创建时就带 ownerTaskId 的（打开链接/终端 URL/popup/share）
    // 远程下该字段永久缺失。attach 侧 renderer 会用 workspaceRemoteSessionId 兜底冻结 main 的
    // owner，close 侧却按 tab 上的空值比对，scope 判失配后 tab 就再也关不掉。创建即冻结。
    ...(options?.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    faviconUrl: null,
    initialUrl: options?.initialUrl ?? null,
    ...(options?.agentOpened ? { agentOpened: true } : {}),
    openedAt: Date.now(),
    title: null,
  };
}

// 每次激活都会创建一个新对象（openedAt 刷新），但由于 id 固定，activate 会原位替换。
function createGitSidePaneTab(): GitSidePaneTab {
  return { id: "git", type: "git", openedAt: Date.now() };
}

function createTreemappingSidePaneTab(
  source: TreemappingSidePaneSource = { kind: "current" },
): TreemappingSidePaneTab {
  return {
    id: "treemapping",
    type: "treemapping",
    openedAt: Date.now(),
    source,
  };
}

// 轨迹 tab 的 id 只由 taskId 决定：同一任务永远一行，避免并排多份相同轨迹。
function createModelTrajectorySidePaneTab(options: {
  taskId: string;
  title?: string | null;
}): ModelTrajectorySidePaneTab {
  return {
    // 同一个 task 复用同一个 tab，避免重复打开多份相同轨迹。
    id: `model-trajectory:${options.taskId}`,
    type: "model-trajectory",
    openedAt: Date.now(),
    taskId: options.taskId,
    title: options.title ?? null,
  };
}

function createDeveloperToolsSidePaneTab(): DeveloperToolsSidePaneTab {
  return {
    id: "developer-tools",
    type: "developer-tools",
    openedAt: Date.now(),
  };
}

// 终端每个实例独立 id；标题的唯一化由 useAppPanels 在创建前完成。
// cwd / remoteSessionId 只接受非空值，空串不会写入。
function createTerminalSidePaneTab(options: {
  title: string;
  cwd?: string;
  remoteSessionId?: string | null;
}): TerminalSidePaneTab {
  return {
    id: `terminal:${createUuid()}`,
    type: "terminal",
    openedAt: Date.now(),
    title: options.title,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
  };
}

// INV-01：所有拼进 id 的变量段都必须经过它；
// 未编码的冒号会让 (a:b, c) 与 (a, b:c) 生成同一个 id。
// 该函数只做 URI 编码，不改变大小写或路径分隔符。
export function encodeSidePaneTabIdPart(value: string): string {
  return encodeURIComponent(value);
}

// id 顺序固定为 (workspace, root, child)，改动顺序会使已持久化的 tab 全部失效；
// rootSessionId 缺失时回落 parentSessionId，保证按根会话记忆可用的同时兼容旧调用。
// title 在此 trim：空标题由上层决定是否回退，不在这里编造。
export function createSubagentSessionSidePaneTab(options: {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}): SubagentSessionSidePaneTab {
  const rootSessionId = options.rootSessionId ?? options.parentSessionId;
  return {
    id: [
      "subagent-session",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(rootSessionId),
      encodeSidePaneTabIdPart(options.childSessionId),
    ].join(":"),
    type: "subagent-session",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    rootSessionId,
    parentSessionId: options.parentSessionId,
    childSessionId: options.childSessionId,
    subagentType: options.subagentType,
    title: options.title.trim(),
  };
}

// 目录 tab 按 (workspace, root, parent) 唯一：一条父会话只有一个子智能体目录。
export function createSubagentDirectorySidePaneTab(options: {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId?: string;
  parentSessionId: string;
}): SubagentDirectorySidePaneTab {
  const rootSessionId = options.rootSessionId ?? options.parentSessionId;
  return {
    id: [
      "subagent-directory",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(rootSessionId),
      encodeSidePaneTabIdPart(options.parentSessionId),
    ].join(":"),
    type: "subagent-directory",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    rootSessionId,
    parentSessionId: options.parentSessionId,
  };
}

// 框选副屏 id 按 (workspace, parent, child) 唯一；
// ordinal 只进字段不进 id，保证同一子会话重开时仍命中同一 tab。
export function createSelectionSideChatPaneTab(
  options: OpenSelectionSideChatRequest & {
    workspaceKey: string;
    ordinal: number;
  },
): SelectionSideChatPaneTab {
  return {
    id: [
      "selection-side-chat",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.childSessionId),
    ].join(":"),
    type: "selection-side-chat",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    childSessionId: options.childSessionId,
    ordinal: options.ordinal,
  };
}

// 计划详情 id 按 (workspace, parent, toolCallId) 唯一，同一工具调用重复点击幂等。
export function createPlanDetailSidePaneTab(
  options: OpenScopedPlanDetailSideTabRequest & { workspaceKey: string },
): PlanDetailSidePaneTab {
  return {
    id: [
      "plan-detail",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.toolCallId),
    ].join(":"),
    type: "plan-detail",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    toolCallId: options.toolCallId,
    markdown: options.markdown,
    ...(options.planFilePath ? { planFilePath: options.planFilePath } : {}),
  };
}

// run 详情 id 按 (workspace, parent, runId) 唯一；
// workflowName 与 focusPhaseId 只在有值时写入，缺席表示不落点。
function createWorkflowRunSidePaneTab(
  options: OpenScopedWorkflowRunSideTabRequest & { workspaceKey: string },
): WorkflowRunSidePaneTab {
  return {
    // 结构化 id：同一个 run 在同一个 workspace + 会话下永远是同一个 tab，重复点击幂等。
    id: [
      "workflow-run",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
    ].join(":"),
    type: "workflow-run",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    toolCallId: options.toolCallId,
    runId: options.runId,
    ...(options.workflowName ? { workflowName: options.workflowName } : {}),
    ...(options.phaseId ? { focusPhaseId: options.phaseId } : {}),
  };
}

// run 目录 id 按 (workspace, parent) 唯一：一条对话只有一份目录，重复点击只聚焦。
function createWorkflowRunDirectorySidePaneTab(
  options: OpenScopedWorkflowRunDirectorySideTabRequest & { workspaceKey: string },
): WorkflowRunDirectorySidePaneTab {
  return {
    // 结构化 id：一条对话只有一份 run 目录，所以页脚行重复点击幂等地聚焦同一个 tab。
    id: [
      "workflow-directory",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
    ].join(":"),
    type: "workflow-directory",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
  };
}

// INV-14：身份段用 siteId@ordinal，不用 actorSessionId；
// 这样从未启动的药丸与会话已启动的药丸会落到同一个 tab。
function createWorkflowActorSessionSidePaneTab(
  options: OpenScopedWorkflowActorSessionSideTabRequest & { workspaceKey: string },
): WorkflowActorSessionSidePaneTab {
  return {
    // 结构化 id：同一个槽位在同一个 workspace + 对话下永远是同一个 tab，重复点击幂等。
    // 身份是 (runId, siteId@ordinal) 而不是会话 id：tab 可以在会话存在之前就开（未启动的
    // 药丸），先后从无会话与有会话两端打开必须落到同一个 tab；runId 在 id 里，两个 run 的
    // 同名实例仍不撞。
    id: [
      "workflow-actor-session",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
      encodeSidePaneTabIdPart(`${options.siteId}@${options.ordinal}`),
    ].join(":"),
    type: "workflow-actor-session",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    runId: options.runId,
    ...(options.actorSessionId ? { actorSessionId: options.actorSessionId } : {}),
    siteId: options.siteId,
    ordinal: options.ordinal,
    ...(options.actorName ? { actorName: options.actorName } : {}),
  };
}

// 脚本 transcript 的 id 不含阶段：一个 run 一份回放，阶段只是落点。
function createWorkflowWorkspaceSidePaneTab(
  options: OpenScopedWorkflowWorkspaceSideTabRequest & { workspaceKey: string },
): WorkflowWorkspaceSidePaneTab {
  return {
    // 结构化 id：(workspace, 父会话, run)。阶段**不在** id 里——一个 run 一份脚本 transcript，
    // 从 plan 站点开还是从 verify 站点开都是同一个 tab，只是落点不同。
    id: [
      "workflow-workspace",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
    ].join(":"),
    type: "workflow-workspace",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    toolCallId: options.toolCallId,
    runId: options.runId,
    ...(options.workflowName ? { workflowName: options.workflowName } : {}),
    ...(options.phaseId ? { focusPhaseId: options.phaseId } : {}),
  };
}

// INV-15：产物 id 不含 version，v1/v2 是同一件东西的两个时刻；
// version 仅作为打开时的初始落点写入。
function createWorkflowArtifactSidePaneTab(
  options: OpenScopedWorkflowArtifactSideTabRequest & { workspaceKey: string },
): WorkflowArtifactSidePaneTab {
  return {
    // 结构化 id：**不含版本**。同一个产物的 v1 与 v2 是同一件东西的两个时刻，再次点击
    // （通知 chip / 中枢 chip / 侧板卡片）只该聚焦同一个 tab 并翻到新版，不该并排开两个。
    id: [
      "workflow-artifact",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
      encodeSidePaneTabIdPart(options.artifactId),
    ].join(":"),
    type: "workflow-artifact",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    runId: options.runId,
    artifactId: options.artifactId,
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.title ? { title: options.title } : {}),
  };
}

// 白板 tab 按 boardId 唯一：同一块板多入口打开只激活同一个视图。
function createWhiteboardSidePaneTab(options: {
  boardId: string;
  title: string;
}): WhiteboardSidePaneTab {
  return {
    id: `whiteboard:${options.boardId}`,
    type: "whiteboard",
    boardId: options.boardId,
    openedAt: Date.now(),
    title: options.title,
  };
}

// INV-09/10：复用键 = workspace 作用域 + 归一后的资源类型 + 资源标识；
// file 入口在 pptx/media 路径上要归一到 pptx/media，否则同一文件会被拆成两个 tab；
// patch 与 multi-file-diff 必须把内容摘要纳入 key，不同轮次的 diff 才可并存；
// 无法稳定标识的 source 返回 null，调用方退化为每次新建。
function getCodeViewerTabSourceKey(source: CodeViewerSource): string | null {
  const workspaceScope = source.workspaceIdentity?.trim()
    ? source.workspaceIdentity.trim()
    : (source.workspacePath ?? "");
  const scopedKeyPrefix = workspaceScope ? `${workspaceScope}:` : "";
  // 文件树把 PPTX 表示为通用 `file` source，引用反向打开则使用带导航意图的
  // `pptx` source。旧 key 直接包含 source.type，导致同一 workspace 路径被拆成两个 tab。
  // source type 只是入口表示，不是文件身份；这里只归一 PPTX，避免扩大其它预览类型的语义。
  const resourceType =
    source.type === "pptx" || (source.type === "file" && isPptxPreviewPath(source.path))
      ? "pptx"
      : source.type === "media" || (source.type === "file" && inferMediaPreview(source.path))
        ? "media"
        : source.type;

  if (
    source.type === "file" ||
    source.type === "code-review" ||
    source.type === "image" ||
    source.type === "media" ||
    source.type === "pdf" ||
    source.type === "pptx"
  ) {
    return `${scopedKeyPrefix}${resourceType}:${source.path}`;
  }

  if (source.type === "text" && source.path) {
    return `${scopedKeyPrefix}${source.type}:${source.path}`;
  }

  if (source.type === "patch") {
    // file diff 之前只按 path 复用 tab，导致同一个文件在不同轮次产生的不同 patch
    // 会互相覆盖，看起来像“diff 面板只能打开一个 tab”。这里把 patch 内容摘要纳入 key，
    // 让不同 diff 可以并排保留，同时同一份 diff 重复点击仍然复用已有 tab。
    return `${scopedKeyPrefix}patch:${source.path ?? source.title}:${hashCodeViewerContent(source.patch)}`;
  }

  if (source.type === "multi-file-diff") {
    return `${scopedKeyPrefix}multi-file-diff:${source.path ?? source.title}:${hashCodeViewerContent(`${source.beforeContent}\0${source.afterContent}`)}`;
  }

  return null;
}

// 31 乘法滚动哈希，仅为「区分内容」而非安全用途；
// 用 36 进制压缩长度；哈希碰撞会导致两个不同 diff 复用同一 tab，属于可接受退化。
function hashCodeViewerContent(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = (hash * 31 + content.charCodeAt(index)) | 0;
  }

  return Math.abs(hash).toString(36);
}

// 先归一化 source 再算 key，两步顺序不能反；
// sourceKey 为 null 时用 uuid，保证仍然可以打开；
function createCodeViewerSidePaneTab(source: CodeViewerSource): CodeViewerSidePaneTab {
  const normalizedSource = normalizeCodeViewerSource(source);
  const sourceKey = getCodeViewerTabSourceKey(normalizedSource);
  return {
    id: sourceKey ? `code-viewer:${sourceKey}` : `code-viewer:${createUuid()}`,
    type: "code-viewer",
    openedAt: Date.now(),
    source: normalizedSource,
    sourceKey,
  };
}

// 线性查找即可：单 workspace 的 tab 数量很小；
// 不要为它引入 Map 缓存，反而会与不可变更新脱节。
function findTabIndexById(tabs: WorkspaceSidePaneTab[], tabId: string): number {
  return tabs.findIndex((tab) => tab.id === tabId);
}

// 激活语义：按 id 命中则原位替换内容，否则追加到末尾；
// 原位替换保持用户拖拽后的顺序，追加则遵循「新开在最右」；
// 空状态时同时建立 tabs 与 activeTabId。
export function activateSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tab: WorkspaceSidePaneTab,
): WorkspaceSidePaneState {
  if (!current) {
    return {
      tabs: [tab],
      activeTabId: tab.id,
    };
  }

  const existingIndex = findTabIndexById(current.tabs, tab.id);
  if (existingIndex >= 0) {
    const nextTabs = [...current.tabs];
    nextTabs[existingIndex] = tab;
    return {
      tabs: nextTabs,
      activeTabId: tab.id,
    };
  }

  return {
    tabs: [...current.tabs, tab],
    activeTabId: tab.id,
  };
}

// 只按 activeTabId 查找，不校验可见性；可见性由 scope 层负责，避免两处规则漂移。
export function getActiveSidePaneTab(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneTab | null {
  if (!current) {
    return null;
  }

  // activeTabId 可能指向当前 scope 不可见的 tab（后台任务），此时仍返回它；
  // 可见性判断交给调用方，避免这里悄悄改激活项。
  return current.tabs.find((tab) => tab.id === current.activeTabId) ?? null;
}

/** 把草稿态的 null/undefined 归一，供侧栏按对话隔离。 */
// 草稿态用 __draft__ 哨兵参与比较；
// 哨兵只用于相等判断，禁止写进持久化存储。
export function sidePaneOwnerKey(taskId: string | null | undefined): string {
  return taskId ?? "__draft__";
}

// 可见性只看 workspace 与 owner 两个维度；remoteSession 差异由 tab 自身字段在打开时隔离。
export interface SidePaneVisibilityScope {
  workspaceKey: string | null;
  ownerTaskId: string | null;
}

// workspaceKey 为 null/undefined 的旧 tab 视为全局可见（兼容历史记忆）；
// 不要让新类型继承这个宽松规则：创建时就应写入 workspaceKey。
function sidePaneTabMatchesWorkspace(
  tab: WorkspaceSidePaneTab,
  activeWorkspaceKey: string | null,
): boolean {
  return tab.workspaceKey == null || tab.workspaceKey === activeWorkspaceKey;
}

/**
 * 新建 tab 在提交到共享侧栏状态时统一冻结工作区与对话归属。
 * browser-use 自带事件来源归属，因此已打标的 tab 绝不能被当前 UI scope 覆盖。
 */
// INV-02：只为缺字段的 tab 补归属，已打标的 tab 原样保留；
// ownerTaskId 与 workspaceKey 独立补齐：quick 入口可能只写了 owner；
// remoteSessionId 只补给 browser 系且从未有 owner 的 tab，避免覆盖 browser-use 的冻结值；
// 没有任何变化时返回原引用。
export function stampSidePaneTabsOwnership(
  state: WorkspaceSidePaneState | null,
  ownership: {
    ownerTaskId: string | null;
    workspaceKey: string | null;
    remoteSessionId?: string | null;
  },
): WorkspaceSidePaneState | null {
  if (!state) return state;
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.ownerTaskId !== undefined && tab.workspaceKey != null) return tab;
    changed = true;
    return {
      ...tab,
      // 快捷入口可能已写 owner 但未写 workspace；两者独立补齐，否则最近关闭会跨工作区泄漏。
      // 独立补齐是刻意的：两者都缺才用得着本次归属；
      // 合并成一个判断会让「只有 owner 的旧 tab」永远拿不到 workspaceKey，从而跨工作区泄漏。
      ownerTaskId: tab.ownerTaskId === undefined ? ownership.ownerTaskId : tab.ownerTaskId,
      workspaceKey: tab.workspaceKey ?? ownership.workspaceKey,
      ...(tab.ownerTaskId === undefined &&
      (tab.type === "browser" || tab.type === "browser-use") &&
      ownership.remoteSessionId
        ? { remoteSessionId: ownership.remoteSessionId }
        : {}),
    } as WorkspaceSidePaneTab;
  });
  return changed ? { ...state, tabs } : state;
}

/** 显示与操作必须共用归属判断；旧 parent-only 分支会把新类型误当成公共 tab。 */
// INV-03：先做 workspace 匹配，再按 type 选择归属字段；
// git/developer-tools/plugin-market/treemapping 是 workspace 级公共 tab；
// browser-use 用 sessionId，subagent/bash 用 rootSessionId，workflow/plan/selection 用 parentSessionId，
// 其余按 ownerTaskId（草稿哨兵归一）。新增类型必须在此显式分支。
export function isSidePaneTabVisibleInScope(
  tab: WorkspaceSidePaneTab,
  scope: SidePaneVisibilityScope,
): boolean {
  if (!sidePaneTabMatchesWorkspace(tab, scope.workspaceKey)) return false;
  switch (tab.type) {
    case "git":
    case "developer-tools":
    case "plugin-market":
    case "treemapping":
      return true;
    // browser-use 的 owner 字段是 sessionId（不是 ownerTaskId），二者在创建时被写成同值，
    // 但可见性只认 sessionId：它才是 main 侧事件携带的会话标识。
    case "browser-use":
      return tab.sessionId === scope.ownerTaskId;
    case "subagent-session":
    case "subagent-directory":
    case "bash-output":
      return tab.rootSessionId === scope.ownerTaskId;
    case "selection-side-chat":
    case "plan-detail":
    case "plugin-ui":
    case "workflow-run":
    case "workflow-directory":
    case "workflow-actor-session":
    case "workflow-workspace":
    case "workflow-artifact":
      return tab.parentSessionId === scope.ownerTaskId;
    case "browser":
    case "browser-permissions":
    case "file-manager":
    case "code-viewer":
    case "whiteboard":
    case "model-trajectory":
    case "new-tab":
    case "terminal":
      return sidePaneOwnerKey(tab.ownerTaskId) === sidePaneOwnerKey(scope.ownerTaskId);
  }
}

// 所有 UI 与命令都必须经它过滤，禁止在组件里另写 type 判断。
export function getVisibleSidePaneTabs(
  tabs: readonly WorkspaceSidePaneTab[],
  scope: SidePaneVisibilityScope,
): WorkspaceSidePaneTab[] {
  return tabs.filter((tab) => isSidePaneTabVisibleInScope(tab, scope));
}

// 优先级：调用方首选 id → 当前 active（若可见）→ 可见列表最后一项；
// 空 scope 返回 null，表示该对话没有可显示内容。
export function resolveActiveTabForOwner(
  state: WorkspaceSidePaneState | null,
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
): string | null {
  if (!state) return null;
  const visibleTabs = getVisibleSidePaneTabs(state.tabs, scope);
  if (visibleTabs.length === 0) return null;
  if (preferredTabId && visibleTabs.some((tab) => tab.id === preferredTabId)) {
    return preferredTabId;
  }
  if (visibleTabs.some((tab) => tab.id === state.activeTabId)) {
    return state.activeTabId;
  }
  return visibleTabs.at(-1)?.id ?? null;
}

/**
 * 对话 scope 切换时同时解析 active tab 与折叠态。
 *
 * 目标对话没有 preferredTabId 时不能沿用上一个对话的 collapsed 状态，也不能简单地
 * 用“有可见 tab 就展开”覆盖状态。否则用户在 A 主动收起后切到 B 再切回 A，仍会被 A 的可见 tab
 * 自动展开。现在由调用方传入当前对话的主动偏好；没有偏好时才沿用默认的“有 tab 展开、无 tab 收起”。
 */
// scope 切换的唯一结算点：同时决定 activeTabId 与折叠态；
// 草稿（owner 为 null）或无可见 tab 时强制收起，历史展开偏好不能凭空造出新标签；
// 其余情况尊重调用方传入的 owner 级偏好，默认展开。
export function resolveSidePaneScopeState(
  state: WorkspaceSidePaneState | null,
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
  collapsedPreference?: boolean,
): {
  sidePaneState: WorkspaceSidePaneState | null;
  isSidePaneCollapsed: boolean;
} {
  const activeTabId = resolveActiveTabForOwner(state, scope, preferredTabId);
  return {
    sidePaneState:
      state && state.activeTabId !== (activeTabId ?? "")
        ? { ...state, activeTabId: activeTabId ?? "" }
        : state,
    // 草稿重新进入时默认收起；空 scope 的历史展开偏好不能生成新标签页。
    isSidePaneCollapsed:
      scope.ownerTaskId === null || activeTabId === null ? true : (collapsedPreference ?? false),
  };
}

// 重开已关闭 tab 时只补 openedAt，不改 id 与归属；
// browser 的新 id / 剥离 residency 由调用方处理，这里保持通用。
export function restoreSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tab: WorkspaceSidePaneTab,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, {
    ...tab,
    openedAt: tab.openedAt ?? Date.now(),
  });
}

// 无 forceNew、无 tabId、无 initialUrl 时才尝试复用同 owner 的已有 browser tab；
// 带 tabId 表示要命中特定壳（恢复/导航），带 initialUrl 表示要新页面；
// 复用与新建都走 activateSidePaneTab，保证顺序语义一致。
export function activateBrowserSidePane(
  current: WorkspaceSidePaneState | null,
  options?: {
    tabId?: string;
    initialUrl?: string | null;
    forceNew?: boolean;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
    remoteSessionId?: string | null;
    agentOpened?: boolean;
  },
): WorkspaceSidePaneState {
  // 三个条件任意一个存在都必须新建：否则恢复路径会错误复用到别的 tab。
  if (!options?.forceNew && !options?.tabId && !options?.initialUrl) {
    const ownerKey = sidePaneOwnerKey(options?.ownerTaskId);
    // 复用时只比较 ownerKey，不比较 workspaceKey：
    // 同 owner 的 browser 只会属于一个 workspace，多比一次没有收益。
    // 若历史数据出现跨 workspace 同 owner，这里会优先命中更早的 tab。
    const existingBrowserTab = current?.tabs.find(
      (tab): tab is BrowserSidePaneTab =>
        tab.type === "browser" && sidePaneOwnerKey(tab.ownerTaskId) === ownerKey,
    );
    if (existingBrowserTab) {
      return activateSidePaneTab(current, existingBrowserTab);
    }
  }

  return activateSidePaneTab(current, createBrowserSidePaneTab(options));
}

/** 打开/复用站点权限设置标签：同站点 + 同工作区 + 同对话只保留一个标签。 */
// 同 origin + 同 workspace + 同对话只保留一个权限页；
// 比较 origin 用全等，不做规范化。
export function openBrowserPermissionsSidePane(
  current: WorkspaceSidePaneState | null,
  options: Pick<BrowserPermissionsSidePaneTab, "origin" | "ownerTaskId" | "workspaceKey">,
): WorkspaceSidePaneState {
  const existing = current?.tabs.find(
    (tab) =>
      tab.type === "browser-permissions" &&
      tab.origin === options.origin &&
      tab.workspaceKey === options.workspaceKey &&
      sidePaneOwnerKey(tab.ownerTaskId) === sidePaneOwnerKey(options.ownerTaskId),
  );
  return activateSidePaneTab(
    current,
    existing ?? {
      ...options,
      id: `browser-permissions:${createUuid()}`,
      type: "browser-permissions",
      openedAt: Date.now(),
    },
  );
}

// 强制新建的 browser 打开（恢复壳、显式新页），可选是否激活；
// activate=false 时保留原 activeTabId（可能为空串），用于后台挂载。
export function openBrowserSidePane(
  current: WorkspaceSidePaneState | null,
  options?: {
    tabId?: string;
    initialUrl?: string | null;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
    remoteSessionId?: string | null;
    activate?: boolean;
    agentOpened?: boolean;
  },
): WorkspaceSidePaneState {
  const next = activateBrowserSidePane(current, {
    ...options,
    forceNew: true,
  });
  if (options?.activate !== false) return next;
  return { ...next, activeTabId: current?.activeTabId ?? "" };
}

/**
 * 同一 workspace/owner 下认领同一个 URL 的 browser tab。
 *
 * 调用方（`useAppPanels`）需要**先**知道落点 tab 的 id 才能对它发导航请求，所以查找与打开
 * 拆成两步：这里定位，`openOrActivateBrowserSidePaneByUrl` 用同一个判据落点。两处共用它，
 * 不会出现「查的是 A、开的是 B」。
 */
// 按 (workspace, owner, initialUrl) 定位，供调用方先拿 tab id 再发导航；
// 与 openOrActivateBrowserSidePaneByUrl 共用判据，避免「查 A 开 B」。
export function findBrowserSidePaneTabByUrl(
  current: WorkspaceSidePaneState | null,
  options: {
    initialUrl: string;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
  },
): BrowserSidePaneTab | undefined {
  const ownerKey = sidePaneOwnerKey(options.ownerTaskId);
  return current?.tabs.find(
    (tab): tab is BrowserSidePaneTab =>
      tab.type === "browser" &&
      tab.initialUrl === options.initialUrl &&
      sidePaneOwnerKey(tab.ownerTaskId) === ownerKey &&
      sidePaneTabMatchesWorkspace(tab, options.workspaceKey ?? null),
  );
}

/**
 * URL 键复用：同一 workspace/session 的同一个 URL 只激活已有 tab。
 *
 * 两个用户：share handover 的分享链接，与 html 产物的直开。两者是同一句话——「带我去这个
 * 地址」，而不是「再开一个浏览器」。复用时**不**改 tab 的任何字段（`initialUrl` 就是键），
 * 要让 webview 重新取字节由调用方另发一次导航请求。
 */
// INV-13：命中即只激活，不改任何字段（initialUrl 就是键）；
// 需要重新取字节时由上层另发带新 requestId 的导航请求。
export function openOrActivateBrowserSidePaneByUrl(
  current: WorkspaceSidePaneState | null,
  options: {
    initialUrl: string;
    /** 新建时用的 tab id；缺席即现生成。命中已有 tab 时忽略。 */
    tabId?: string;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
    remoteSessionId?: string | null;
  },
): WorkspaceSidePaneState {
  const existing = findBrowserSidePaneTabByUrl(current, options);
  if (existing) return activateSidePaneTab(current, existing);
  return activateBrowserSidePane(current, {
    initialUrl: options.initialUrl,
    ...(options.tabId ? { tabId: options.tabId } : {}),
    ownerTaskId: options.ownerTaskId,
    workspaceKey: options.workspaceKey,
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
  });
}

/** 打开或更新一个受控 browser-use tab；ready 重放按 tabId 幂等。 */
// ready 重放按 tabId 幂等：已存在则原位更新，保留 openedAt 与运行态字段；
// residency / generation / 操作指示 / resize 基线都必须从旧 tab 继承；
// activate=false 时只挂壳不改激活项，current 为空则 activeTabId 置空串。
export function openBrowserUseSidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    sessionId: string;
    tabId: string;
    browserId?: string;
    browserGeneration?: number;
    remoteSessionId?: string;
    title?: string;
    activate?: boolean;
  },
): WorkspaceSidePaneState {
  // 壳 id 由 main 的 logical tabId 派生，保证 ready 重放天然幂等；
  // 不要加入 session 或 generation：它们会变，而 tab 应该是同一个；
  // generation 只用于事件校验，不用于身份。
  const id = `browser-use:${options.tabId}`;
  const existing = current?.tabs.find(
    (tab): tab is BrowserUseSidePaneTab => tab.type === "browser-use" && tab.id === id,
  );
  // 事件没带 remoteSessionId 时沿用已冻结值；
  // 不要改成 `?? null` 再写空：那会抹掉关闭授权所需的 scope。
  const remoteSessionId = options.remoteSessionId ?? existing?.remoteSessionId;
  const tab: BrowserUseSidePaneTab = {
    id,
    type: "browser-use",
    ownerTaskId: options.sessionId,
    workspaceKey: options.workspaceKey,
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: options.sessionId,
    tabId: options.tabId,
    ...(options.browserId ? { browserId: options.browserId } : {}),
    ...(options.browserGeneration !== undefined
      ? { browserGeneration: options.browserGeneration }
      : {}),
    openedAt: existing?.openedAt ?? Date.now(),
    ...((options.title ?? existing?.title)
      ? { title: options.title ?? existing?.title ?? null }
      : {}),
    ...(existing?.faviconUrl !== undefined ? { faviconUrl: existing.faviconUrl } : {}),
    ...(existing?.residency !== undefined ? { residency: existing.residency } : {}),
    ...(existing?.residencyGeneration !== undefined
      ? { residencyGeneration: existing.residencyGeneration }
      : {}),
    ...(existing?.browserUseOperationUntil !== undefined
      ? { browserUseOperationUntil: existing.browserUseOperationUntil }
      : {}),
    ...(existing?.browserUseResizeBaselineVersion !== undefined
      ? {
          browserUseResizeBaselineVersion: existing.browserUseResizeBaselineVersion,
        }
      : {}),
  };

  // 后台事件必须走非激活分支：原位替换或追加，且不动 activeTabId。
  if (options.activate !== false) {
    return activateSidePaneTab(current, tab);
  }
  if (!current) {
    return { tabs: [tab], activeTabId: "" };
  }
  const existingIndex = findTabIndexById(current.tabs, tab.id);
  if (existingIndex >= 0) {
    const tabs = [...current.tabs];
    tabs[existingIndex] = tab;
    return { ...current, tabs };
  }
  return { ...current, tabs: [...current.tabs, tab] };
}

// 事件收敛 scope：workspaceKey 必填，remoteSessionId 缺省按空串比较，
// ownerTaskId 为 null 表示草稿；三者必须与事件来源完全一致才允许抢焦点。
export interface BrowserUseSidePaneScope {
  workspaceKey: string;
  remoteSessionId?: string;
  ownerTaskId: string | null;
}

/** ready/show 事件只允许激活其 origin workspace + session，后台事件仅挂载 guest。 */
// ready/show 事件的收敛：只有 workspace + remoteSession + session 三元组都命中当前 scope 才应展开；
// 三元组未命中 current scope 时后台挂载 guest，不抢焦点。
export function applyBrowserUseSidePaneEvent(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId: string;
    tabId: string;
    browserId?: string;
    browserGeneration?: number;
  },
  activeScope: BrowserUseSidePaneScope,
): { state: WorkspaceSidePaneState; shouldReveal: boolean } {
  // 三元组全等才允许抢焦点：workspace、remoteSession（空串归一）、session；
  // 缺少任意一项判断都会让后台对话的 ready 事件把当前面板切走。
  const shouldReveal =
    options.workspaceKey === activeScope.workspaceKey &&
    (options.remoteSessionId ?? "") === (activeScope.remoteSessionId ?? "") &&
    options.sessionId === activeScope.ownerTaskId;
  return {
    state: openBrowserUseSidePane(current, {
      ...options,
      activate: shouldReveal,
    }),
    shouldReveal,
  };
}

/** visibility 只选择 ready 已创建的 shell；迟到事件不得重建已关闭 tab。 */
// INV-08：visibility 是选择信号，只能命中现存 shell；
// 匹配要求 workspace、remoteSession、session、browserId、browserGeneration 全部一致；
// 迟到事件若重建壳，会得到一个 main 侧不存在的 tab，后续关闭必然失败。
export function applyBrowserUseSidePaneVisibilityEvent(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId: string;
    tabId: string;
    browserId?: string;
    browserGeneration?: number;
  },
  activeScope: BrowserUseSidePaneScope,
): {
  state: WorkspaceSidePaneState | null;
  shouldReveal: boolean;
  didMatch: boolean;
} {
  const target = current?.tabs.find(
    (tab): tab is BrowserUseSidePaneTab =>
      tab.type === "browser-use" &&
      tab.tabId === options.tabId &&
      tab.workspaceKey === options.workspaceKey &&
      (tab.remoteSessionId ?? "") === (options.remoteSessionId ?? "") &&
      tab.sessionId === options.sessionId &&
      (options.browserId === undefined || tab.browserId === options.browserId) &&
      (options.browserGeneration === undefined ||
        tab.browserGeneration === options.browserGeneration),
  );
  // 找不到目标时原样返回 current（可能是 null），不创建任何东西。
  if (!target) {
    // 旧 visibility 路径复用了 ready 的 open helper。main 已关闭 tab 后，队列中
    // 迟到的 visible=true 会在 renderer 重建无 main authority 的僵尸 shell，之后点击关闭必然
    // 失败。visibility 是选择信号，只能命中现存且 scope/generation 完全一致的 shell。
    return { state: current, shouldReveal: false, didMatch: false };
  }

  const shouldReveal =
    options.workspaceKey === activeScope.workspaceKey &&
    (options.remoteSessionId ?? "") === (activeScope.remoteSessionId ?? "") &&
    options.sessionId === activeScope.ownerTaskId;
  return {
    state: shouldReveal ? setActiveSidePaneTab(current, target.id) : current,
    shouldReveal,
    didMatch: true,
  };
}

// INV-07：residency 事件按 generation 单调收敛，旧事件直接丢弃；
// 匹配同时校验 workspace / remoteSession / session（browser-use 用 sessionId，human 用 ownerTaskId）；
// 命中后只更新 residency 与 generation，以及事件携带的 browser 标识。
export function applyBrowserTabResidencyEvent(
  current: WorkspaceSidePaneState | null,
  event: {
    tabId: string;
    workspaceKey?: string;
    remoteSessionId?: string;
    sessionId?: string;
    browserId?: string;
    browserGeneration?: number;
    generation: number;
    residency: Extract<
      BrowserTabResidencyState,
      "live-visible" | "live-background" | "suspended" | "restoring"
    >;
  },
): WorkspaceSidePaneState | null {
  if (!current) return current;
  const index = current.tabs.findIndex(
    (tab) =>
      (tab.type === "browser" && tab.id === event.tabId) ||
      (tab.type === "browser-use" && tab.tabId === event.tabId),
  );
  if (index < 0) return current;
  const target = current.tabs[index] as BrowserSidePaneTab | BrowserUseSidePaneTab;
  if (event.workspaceKey !== undefined && target.workspaceKey !== event.workspaceKey)
    return current;
  if (
    Object.hasOwn(event, "remoteSessionId") &&
    (target.remoteSessionId ?? "") !== (event.remoteSessionId ?? "")
  ) {
    return current;
  }
  if (
    event.sessionId !== undefined &&
    (target.type === "browser-use"
      ? target.sessionId !== event.sessionId
      : (target.ownerTaskId ?? "unscoped") !== event.sessionId)
  ) {
    return current;
  }
  // 大于才丢弃；等于允许重放（幂等），小于才前进。
  if ((target.residencyGeneration ?? 0) > event.generation) return current;
  const tabs = [...current.tabs];
  tabs[index] = {
    ...target,
    ...(target.type === "browser-use" && event.browserId ? { browserId: event.browserId } : {}),
    ...(target.type === "browser-use" && event.browserGeneration !== undefined
      ? { browserGeneration: event.browserGeneration }
      : {}),
    residency: event.residency,
    residencyGeneration: event.generation,
  };
  return { ...current, tabs };
}

// 冷恢复把 main 的壳重新灌进状态：新壳一律 suspended，等首次激活再恢复；
// origin=agent 映射为 browser-use（id 加前缀），否则映射为 human browser；
// 已存在同 tabId 的壳时跳过，避免重启后重复行。
export function restoreBrowserTabShells(
  current: WorkspaceSidePaneState | null,
  shells: readonly BrowserViewRestoredTabShell[],
  scope?: {
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId: string;
  },
): WorkspaceSidePaneState {
  let next: WorkspaceSidePaneState = current ?? { tabs: [], activeTabId: "" };
  const hadActiveTabInScope = Boolean(
    scope &&
    current?.tabs.some(
      (tab) =>
        tab.id === current.activeTabId &&
        (tab.type === "browser" || tab.type === "browser-use") &&
        tab.workspaceKey === scope.workspaceKey &&
        (tab.remoteSessionId ?? "") === (scope.remoteSessionId ?? "") &&
        (tab.type === "browser-use"
          ? tab.sessionId === scope.sessionId
          : (tab.ownerTaskId ?? "unscoped") === scope.sessionId),
    ),
  );
  for (const shell of shells) {
    const existing = next.tabs.find(
      (tab) =>
        (tab.type === "browser" && tab.id === shell.tabId) ||
        (tab.type === "browser-use" && tab.tabId === shell.tabId),
    );
    if (existing) continue;
    const tab: BrowserSidePaneTab | BrowserUseSidePaneTab =
      shell.origin === "agent"
        ? {
            id: `browser-use:${shell.tabId}`,
            type: "browser-use",
            ownerTaskId: shell.sessionId,
            workspaceKey: shell.workspaceKey,
            ...(shell.remoteSessionId ? { remoteSessionId: shell.remoteSessionId } : {}),
            sessionId: shell.sessionId,
            tabId: shell.tabId,
            browserId: shell.browserId,
            browserGeneration: shell.browserGeneration,
            openedAt: shell.openedAt,
            title: shell.title,
            faviconUrl: shell.faviconUrl,
            residency: "suspended",
            residencyGeneration: 0,
          }
        : {
            id: shell.tabId,
            type: "browser",
            // Bug 原因：草稿态内存 owner 是 null，但 IPC/持久层编码为 "unscoped"；
            // 冷恢复必须对称解码，否则 tab 虽已恢复到状态中，却会被草稿 scope 永久隐藏。
            // 持久层把草稿 owner 编码为 "unscoped"，恢复必须对称解码为 null；
            // 否则草稿 scope 永远看不到这个 tab。
            ownerTaskId: shell.sessionId === "unscoped" ? null : shell.sessionId,
            workspaceKey: shell.workspaceKey,
            ...(shell.remoteSessionId ? { remoteSessionId: shell.remoteSessionId } : {}),
            initialUrl: shell.restoreUrl,
            title: shell.title,
            faviconUrl: shell.faviconUrl,
            openedAt: shell.openedAt,
            residency: "suspended",
            residencyGeneration: 0,
          };
    next = {
      tabs: [...next.tabs, tab],
      activeTabId: next.activeTabId || tab.id,
    };
  }
  // INV-06：仅当当前 scope 原本没有激活 tab 时才挑选恢复目标；
  // 排序优先级 lastSelectedAt > openedAt > tabId，且只改 activeTabId，不动 tabs 顺序；
  // 这保证标签条保持打开顺序，激活项符合用户最近使用。
  if (scope && !hadActiveTabInScope) {
    const preferred = shells
      .filter(
        (shell) =>
          shell.workspaceKey === scope.workspaceKey &&
          (shell.remoteSessionId ?? "") === (scope.remoteSessionId ?? "") &&
          shell.sessionId === scope.sessionId,
      )
      .sort(
        (left, right) =>
          (right.lastSelectedAt ?? Number.NEGATIVE_INFINITY) -
            (left.lastSelectedAt ?? Number.NEGATIVE_INFINITY) ||
          left.openedAt - right.openedAt ||
          left.tabId.localeCompare(right.tabId),
      )[0];
    if (preferred) {
      // Bug 原因：旧恢复直接激活 openedAt 第一条，持久化的 lastSelectedAt 完全未消费。
      // tab strip 仍按 openedAt 保持原顺序，只单独选择当前 scope 的最近使用项。
      next = {
        ...next,
        activeTabId:
          preferred.origin === "agent" ? `browser-use:${preferred.tabId}` : preferred.tabId,
      };
    }
  }
  return next;
}

// 文件管理器每次打开都是新实例（uuid）：不同目录需要并排比较。
export function openFileManagerSidePane(
  current: WorkspaceSidePaneState | null,
  target: FileManagerTarget,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, {
    id: `file-manager:${createUuid()}`,
    type: "file-manager",
    target,
    source: null,
    openedAt: Date.now(),
  });
}

// tab 内导航只更新目标实例的 source，不激活、不改 id 与归属；
// code-viewer 同时重算 sourceKey，保证后续复用判断正确。
export function navigateFileManagerSidePane(
  current: WorkspaceSidePaneState | null,
  tabId: string,
  source: CodeViewerSource,
): WorkspaceSidePaneState | null {
  if (!current) return current;
  const normalizedSource = normalizeCodeViewerSource(source);
  return {
    ...current,
    // 导航只更新目标实例，不激活其他 Tab，也不改变实例 id 和任务归属。
    tabs: current.tabs.map((tab) => {
      if (tab.id !== tabId) return tab;
      if (tab.type === "file-manager") return { ...tab, source: normalizedSource };
      if (tab.type === "code-viewer") {
        return {
          ...tab,
          source: normalizedSource,
          sourceKey: getCodeViewerTabSourceKey(normalizedSource),
        };
      }
      return tab;
    }),
  };
}

// 同一 sourceKey + 同 owner 已有 tab 时原位替换 source（刷新到最新内容），不新开；
// 没有命中但 id 已被一个「导航后换了路径」的实例占用时，必须换新 id，
// 否则会覆盖用户正在看的文件；sourceKey 为 null 时直接新建。
export function openCodeViewerSidePane(
  current: WorkspaceSidePaneState | null,
  source: CodeViewerSource,
  ownerTaskId?: string | null,
): WorkspaceSidePaneState {
  // 同一个文件/图片在消息里被重复点击时，不能把右侧面板整块替换，
  // 用户刚在别的 pane 里看的内容会直接丢掉。这里按稳定 sourceKey 复用已有 code viewer tab，
  // 既避免重复开一排同名 tab，也能在再次打开时刷新到最新 source。
  const nextTab = createCodeViewerSidePaneTab(source);
  if (!current || nextTab.sourceKey === null) {
    return activateSidePaneTab(current, nextTab);
  }

  const ownerKey = sidePaneOwnerKey(ownerTaskId);
  const matchedTab = current.tabs.find(
    (tab): tab is CodeViewerSidePaneTab =>
      tab.type === "code-viewer" &&
      tab.sourceKey === nextTab.sourceKey &&
      sidePaneOwnerKey(tab.ownerTaskId) === ownerKey,
  );
  // 文件导航后旧实例仍持有原 id；重新打开原路径时必须分配新 id，避免覆盖正在看的文件。
  // 这是「同一文件被导航走后又从原路径打开」的冲突，换 id 而不是覆盖。
  if (!matchedTab && current.tabs.some((tab) => tab.id === nextTab.id)) {
    nextTab.id = `code-viewer:${createUuid()}`;
  }
  return activateSidePaneTab(
    current,
    matchedTab ? { ...matchedTab, source: nextTab.source } : nextTab,
  );
}

/**
 * 一次性打开一组代码预览 Tab。
 *
 * 自动打开生成产物时不能逐张调用 openCodeViewerSidePane：逐张提交会让右侧
 * 面板经历多次中间状态，并且最后一张会意外成为 active。这里复用单文件
 * 的 sourceKey/owner 规则批量收口，最后按调用方指定的顺序激活一张 Tab。
 */
// 批量打开先做批内 sourceKey 去重，再逐个走单文件复用规则；
// 一次性返回终态，避免中间态让面板闪动或让最后一张意外成为 active；
// 最终按调用方 activeIndex（已夹紧）激活一张。
export function openCodeViewerSidePanes(
  current: WorkspaceSidePaneState | null,
  sources: readonly CodeViewerSource[],
  ownerTaskId?: string | null,
  activeIndex = 0,
): WorkspaceSidePaneState {
  if (sources.length === 0) {
    return current ?? { tabs: [], activeTabId: "" };
  }

  let next: WorkspaceSidePaneState | null = current;
  const openedTabIds: string[] = [];
  const seenSourceKeys = new Set<string>();

  for (const source of sources) {
    const normalizedSource = normalizeCodeViewerSource(source);
    const sourceKey = getCodeViewerTabSourceKey(normalizedSource);
    // sourceKey 是 workspace-scoped 的稳定身份；同一批次重复路径只打开一次。
    if (sourceKey !== null && seenSourceKeys.has(sourceKey)) continue;
    if (sourceKey !== null) seenSourceKeys.add(sourceKey);

    next = openCodeViewerSidePane(next, normalizedSource, ownerTaskId);
    const activeTab = getActiveSidePaneTab(next);
    if (activeTab?.type === "code-viewer") {
      openedTabIds.push(activeTab.id);
    }
  }

  if (!next || openedTabIds.length === 0) {
    return next ?? { tabs: [], activeTabId: "" };
  }

  // 索引越界必须夹紧到 [0, len-1]，调用方传入的索引可能来自旧列表长度。
  const safeIndex = Math.min(Math.max(activeIndex, 0), openedTabIds.length - 1);
  return {
    ...next,
    activeTabId: openedTabIds[safeIndex]!,
  };
}

// Git 是 workspace 级单例：激活即复用同 id tab。
export function activateGitSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createGitSidePaneTab());
}

export function activateTreemappingSidePane(
  current: WorkspaceSidePaneState | null,
  source?: TreemappingSidePaneSource,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createTreemappingSidePaneTab(source));
}

// 白板按 boardId 复用，重复打开只切激活项。
export function openWhiteboardSidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    boardId: string;
    title: string;
  },
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createWhiteboardSidePaneTab(options));
}

export function openModelTrajectorySidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    taskId: string;
    title?: string | null;
  },
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createModelTrajectorySidePaneTab(options));
}

export function activatePluginMarketSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, { id: "plugin-market", type: "plugin-market" });
}

export function activateDeveloperToolsSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createDeveloperToolsSidePaneTab());
}

// 终端创建不做复用；标题唯一化由调用方在打开前完成。
export function openTerminalSidePane(
  current: WorkspaceSidePaneState | null,
  options: { title: string; cwd?: string; remoteSessionId?: string | null },
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createTerminalSidePaneTab(options));
}

// 按结构化 id 幂等；命中时刷新 workspacePath、identity、remoteSession 等可变上下文，
// 但保留 openedAt；标题为空时保留旧标题，绝不回退到旧编号规则。
export function openSubagentSessionSidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    rootSessionId?: string;
    parentSessionId: string;
    childSessionId: string;
    subagentType: string;
    title: string;
  },
): WorkspaceSidePaneState {
  const nextTab = createSubagentSessionSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is SubagentSessionSidePaneTab =>
      tab.type === "subagent-session" && tab.id === nextTab.id,
  );
  const nextTitle = options.title.trim();
  return activateSidePaneTab(
    current,
    existing
      ? {
          ...existing,
          workspacePath: options.workspacePath,
          ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
          ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
          rootSessionId: options.rootSessionId ?? options.parentSessionId,
          parentSessionId: options.parentSessionId,
          subagentType: options.subagentType,
          // HMR 期间可能复用旧结构的内存 tab；新入口没有 title 时保留已知标题，
          // 但绝不再回退到旧的 type + ordinal 展示规则。
          // HMR/旧内存状态可能给出空标题；宁可保留已知标题，也不要用 type+ordinal 重新拼接。
          title: nextTitle || existing.title || "",
        }
      : nextTab,
  );
}

// 目录 tab 用「新对象覆盖旧对象」合并：它的字段全是上下文，没有需要保留的运行态。
export function openSubagentDirectorySidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    rootSessionId?: string;
    parentSessionId: string;
  },
): WorkspaceSidePaneState {
  const nextTab = createSubagentDirectorySidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is SubagentDirectorySidePaneTab =>
      tab.type === "subagent-directory" && tab.id === nextTab.id,
  );
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

// 回收只作用于 subagent-session，且必须 root + parent 同时匹配，防止误删其他对话的子会话；
// validChildSessionIds 来自父会话投影，是唯一权威；
// 移除后若 active 被删：优先落到同根目录 tab，否则落到被删位置的前一个，再退到末尾；
// 清空时返回 null，让上层决策是否收起。
export function syncSubagentSessionSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  options: SyncSubagentSessionTabsRequest,
): WorkspaceSidePaneState | null {
  if (!current) return null;
  const validChildSessionIds = new Set(options.validChildSessionIds);
  const removedTabs = current.tabs.filter(
    (tab) =>
      tab.type === "subagent-session" &&
      tab.rootSessionId === options.rootSessionId &&
      tab.parentSessionId === options.parentSessionId &&
      !validChildSessionIds.has(tab.childSessionId),
  );
  if (removedTabs.length === 0) return current;
  const removedIds = new Set(removedTabs.map((tab) => tab.id));
  const tabs = current.tabs.filter((tab) => !removedIds.has(tab.id));
  // 返回 null 而不是空状态对象：null 是「该 workspace 没有面板」的规范表示。
  if (tabs.length === 0) return null;
  if (!removedIds.has(current.activeTabId)) return { ...current, tabs };
  // active 被回收后优先落到同根的目录页：它是子会话列表，最接近用户原来的位置。
  const directory = tabs.find(
    (tab) => tab.type === "subagent-directory" && tab.rootSessionId === options.rootSessionId,
  );
  if (directory) return { tabs, activeTabId: directory.id };
  const removedIndex = current.tabs.findIndex((tab) => tab.id === current.activeTabId);
  // 落点取被删位置的前一个（夹紧到合法范围）；
  // 没有目录页时才用这个回退，最后再退到末尾。
  const previous = tabs[Math.max(0, Math.min(removedIndex - 1, tabs.length - 1))];
  return { tabs, activeTabId: previous?.id ?? tabs.at(-1)!.id };
}

// 同一 (workspace, parent, child) 复用并保留原 ordinal；
// 新 tab 的编号取当前父会话下最小空位，避免删除后编号前移造成标题跳动。
export function openSelectionSideChatPane(
  current: WorkspaceSidePaneState | null,
  options: OpenSelectionSideChatRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const existing = current?.tabs.find(
    (tab): tab is SelectionSideChatPaneTab =>
      tab.type === "selection-side-chat" &&
      tab.workspaceKey === options.workspaceKey &&
      tab.parentSessionId === options.parentSessionId &&
      tab.childSessionId === options.childSessionId,
  );
  const ordinal =
    existing?.ordinal ??
    getNextSelectionSideChatOrdinal(
      current?.tabs ?? [],
      options.workspaceKey,
      options.parentSessionId,
    );
  const nextTab = createSelectionSideChatPaneTab({ ...options, ordinal });
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

// 编号只在同 workspace + 同父会话内唯一；集合可能含 undefined（旧数据），由归一化提前修复。
function getNextSelectionSideChatOrdinal(
  tabs: readonly WorkspaceSidePaneTab[],
  workspaceKey: string,
  parentSessionId: string,
): number {
  const used = new Set(
    tabs.flatMap((tab) =>
      tab.type === "selection-side-chat" &&
      tab.workspaceKey === workspaceKey &&
      tab.parentSessionId === parentSessionId
        ? [tab.ordinal]
        : [],
    ),
  );
  let ordinal = 1;
  while (used.has(ordinal)) ordinal += 1;
  return ordinal;
}

// 只有 active 恰好是本 scope 的框选副屏时才返回；用于决定是否复用子会话。
export function getActiveSelectionSideChatTab(
  current: WorkspaceSidePaneState | null,
  scope: { workspaceKey: string; parentSessionId: string },
): SelectionSideChatPaneTab | null {
  const active = getActiveSidePaneTab(current);
  return active?.type === "selection-side-chat" &&
    active.workspaceKey === scope.workspaceKey &&
    active.parentSessionId === scope.parentSessionId
    ? active
    : null;
}

// 同一 toolCall 只保留一个 tab；命中时用新 markdown 刷新 fallback，
// 但详情组件仍以父会话投影的实时正文为权威。
export function openPlanDetailSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedPlanDetailSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createPlanDetailSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is PlanDetailSidePaneTab => tab.type === "plan-detail" && tab.id === nextTab.id,
  );
  // 同一个 toolCall 只保留一个 tab；再次点击用卡片当前正文刷新 fallback，
  // 详情组件的实时正文仍以父 conversation projection 为权威。
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

/**
 * 打开或复用一个 workflow run 详情 tab。
 *
 * 复用规则与 plan-detail 同构（结构化 id 幂等），刻意也**同样没有 GC**：事件日志读的是
 * journal，而 `workflowRuns` 投影只留最近 8 个 run，所以一个被淘汰的 run 仍有完整可读的
 * 事件日志——那正是用户会把这个 tab 留着的场景。投影缺席退化成详情页的空态，不关 tab。
 */
// 命中时落点每次重算：请求带 phaseId 就写入，不带就显式删除 focusPhaseId；
// openedAt 随每次打开刷新，面板据此在同一站再点一次也重新滚动。
export function openWorkflowRunSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowRunSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowRunSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowRunSidePaneTab => tab.type === "workflow-run" && tab.id === nextTab.id,
  );
  if (existing === undefined) return activateSidePaneTab(current, nextTab);
  // 落点每次都重算（与脚本 transcript tab 同一条规则）：请求带 phaseId 就落到它，不带就显式删键；
  // `openedAt` 随每次打开刷新，面板据此在同一站上再点一次也重新滚。
  const merged: WorkflowRunSidePaneTab = { ...existing, ...nextTab };
  if (nextTab.focusPhaseId === undefined) delete merged.focusPhaseId;
  return activateSidePaneTab(current, merged);
}

/**
 * 「配置」被接受后的原地替换：旧 run 的 tab 换成新 run 的 tab，位置、名字、归属照旧；它原来是活动
 * tab 才让新 tab 成为活动 tab。新 run 的 tab 已经开着时，关掉旧的、聚焦已有的那一个（不出两个）。
 * 旧 tab 不在（用户已关掉）即原样返回——替换不是打开；结果里的 run 就是被替换的那一个（就地生效的
 * 修订没有后继）时同理，这个 tab 已经是它了。
 */
// 「配置」后的原地替换：位置、名字、归属沿用旧 tab，只有 run 相关字段更新；
// 旧 tab 已关则原样返回——替换不是打开；
// 新 run 的 tab 已存在时删掉旧的并聚焦已有的，杜绝两个；
// INV-16：新 id 与旧 id 相同（就地修订）时必须提前返回。
export function replaceWorkflowRunSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowRunSideTabRequest & { workspaceKey: string; replaceRunId: string },
): WorkspaceSidePaneState | null {
  if (current === null) return current;
  const nextTab = createWorkflowRunSidePaneTab(options);
  const replaceRunId = options.replaceRunId;
  const index = current.tabs.findIndex(
    (tab) =>
      tab.type === "workflow-run" &&
      tab.workspaceKey === nextTab.workspaceKey &&
      tab.parentSessionId === nextTab.parentSessionId &&
      tab.runId === replaceRunId,
  );
  const previous = current.tabs[index];
  if (index < 0 || previous?.type !== "workflow-run") return current;
  // 就地生效的修订（只改并发上限、run 又在飞：docs/dynamic-workflow/concurrency.md）没有后继，
  // 结果里的 runId 就是被替换的这一个。tab 的 id 只由 runId 铸，所以不挡在这里的话，下面那支
  // 「新 tab 已经开着」会认出它自己、把这个 tab 关掉，只留一个指向已不存在 tab 的 activeTabId。
  // 否则下面的「新 tab 已存在」分支会认出自己并把当前 tab 删掉，留下指向空 id 的 activeTabId。
  if (nextTab.id === previous.id) return current;
  // 替换只有对「原本激活的旧 tab」才转移激活；
  // 否则用户当前正在看的其他 tab 会被替换动作抢走。
  const wasActive = current.activeTabId === previous.id;
  const existingIndex = findTabIndexById(current.tabs, nextTab.id);
  if (existingIndex >= 0) {
    const tabs = current.tabs.filter((_, tabIndex) => tabIndex !== index);
    return { tabs, activeTabId: wasActive ? nextTab.id : current.activeTabId };
  }
  const replaced: WorkflowRunSidePaneTab = {
    ...nextTab,
    ...(previous.ownerTaskId === undefined ? {} : { ownerTaskId: previous.ownerTaskId }),
    ...(nextTab.workflowName === undefined && previous.workflowName !== undefined
      ? { workflowName: previous.workflowName }
      : {}),
  };
  const tabs = [...current.tabs];
  tabs[index] = replaced;
  return { tabs, activeTabId: wasActive ? replaced.id : current.activeTabId };
}

/**
 * 打开或复用一条对话的 run 目录 tab。身份是对话，所以页脚行重复点击只是聚焦。
 *
 * GC 同样**没有**（与 workflow-run 同一条理由链）：目录页每次挂载自己重读一页 journal，
 * 所以一个被恢复出来的旧 tab 不会显示过期名单，也就没有该回收的东西。
 */
// 目录 tab 每次都合并最新字段，但 id 不变，因此重复点击只聚焦。
export function openWorkflowRunDirectorySidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowRunDirectorySideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowRunDirectorySidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowRunDirectorySidePaneTab =>
      tab.type === "workflow-directory" && tab.id === nextTab.id,
  );
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

/**
 * 打开或复用一个 actor transcript tab。
 *
 * 复用规则与 workflow-run 同构（结构化 id 幂等），GC 同样**没有**：actor 会话在 run 结束
 * 之后继续可读，那正是把它落成真实持久会话换来的东西。见类型上那段注释。
 *
 * 合并时新请求里缺席的键不覆盖旧值：先从未启动的药丸开（无会话 id）、后从已启动的药丸再开
 * （带会话 id）补上会话；反过来再开一次不带会话的请求也不会把已知的会话 id 抹掉。
 */
// 合并用 `...existing, ...nextTab`：请求里缺席的键不会覆盖旧值；
// 于是「先无会话后补会话」与「再开一次不带会话」都不会丢 actorSessionId。
export function openWorkflowActorSessionSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowActorSessionSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowActorSessionSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowActorSessionSidePaneTab =>
      tab.type === "workflow-actor-session" && tab.id === nextTab.id,
  );
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

/**
 * 打开或复用一个 run 的脚本 transcript tab。
 *
 * 落点**每次都重算**：再点一枚脚本药丸的意思是「带我去那一站」，所以请求带 phaseId 就落到
 * 它，不带就不落（显式删键，同 `openWorkflowArtifactSidePane` 对 version 的处理）。`openedAt`
 * 随每次打开刷新，面板据此在同一站上再点一次也重新滚动。
 */
// 落点每次重算：不带 phaseId 时显式删除 focusPhaseId，保证旧落点不残留。
export function openWorkflowWorkspaceSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowWorkspaceSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowWorkspaceSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowWorkspaceSidePaneTab =>
      tab.type === "workflow-workspace" && tab.id === nextTab.id,
  );
  if (existing === undefined) return activateSidePaneTab(current, nextTab);
  const merged: WorkflowWorkspaceSidePaneTab = { ...existing, ...nextTab };
  if (nextTab.focusPhaseId === undefined) delete merged.focusPhaseId;
  return activateSidePaneTab(current, merged);
}

/**
 * 打开或复用一个产物的全尺寸 tab。
 *
 * 复用时**不把旧 tab 的 version 保留下来**：再次点击一枚 chip 的意思是「让我看这个产物」，
 * 而 chip 从不带版本号，所以合并结果里 `version` 缺席即回到最新版。反过来，若请求显式带了
 * 版本（例如将来某处要跳到某一版），那一版才是落点。
 */
// INV-15：命中时显式删除旧 version，让「chip 不带版本」真的回到最新版；
// 请求显式带版本时该版本才是落点。
export function openWorkflowArtifactSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowArtifactSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowArtifactSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowArtifactSidePaneTab =>
      tab.type === "workflow-artifact" && tab.id === nextTab.id,
  );
  if (existing === undefined) return activateSidePaneTab(current, nextTab);
  // 合并时**丢掉旧 tab 上的 version**：`...nextTab` 里缺席的键不会覆盖旧值，而那正好是
  // 「chip 不带版本号 ⇒ 回到最新版」这条语义会被悄悄破坏的地方（旧 tab 停在 v1，再点一次
  // 仍然停在 v1）。显式删键，让缺席真的是缺席。
  const merged: WorkflowArtifactSidePaneTab = { ...existing, ...nextTab };
  // 条件展开合并不会覆盖已有键，必须显式删除才能表达「缺席」。
  if (nextTab.version === undefined) delete merged.version;
  return activateSidePaneTab(current, merged);
}

// scope 结算函数：无可见 tab 时把 activeTabId 置空（保留 tabs 供切回恢复）；
// 优先保留当前 active，其次 preferred，再其次最近一个 workflow/subagent/selection 类 tab；
// 最后才退到可见列表末项。
export function selectSidePaneTabsForScope(
  current: WorkspaceSidePaneState | null,
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
): WorkspaceSidePaneState | null {
  if (!current) return null;
  const visibleTabs = getVisibleSidePaneTabs(current.tabs, scope);
  if (visibleTabs.length === 0) {
    return current.activeTabId === "" ? current : { ...current, activeTabId: "" };
  }
  const preferred = preferredTabId
    ? visibleTabs.find((tab) => tab.id === preferredTabId)
    : undefined;
  const currentActive = visibleTabs.find((tab) => tab.id === current.activeTabId);
  // 优先级顺序是交互契约：宁可停在最近打开的深度面板，也不回到第一个列表页。
  const nextActive =
    currentActive ??
    preferred ??
    visibleTabs.findLast(
      (tab) =>
        tab.type === "subagent-session" ||
        tab.type === "subagent-directory" ||
        tab.type === "selection-side-chat" ||
        tab.type === "plan-detail" ||
        tab.type === "workflow-run" ||
        tab.type === "workflow-actor-session" ||
        tab.type === "workflow-workspace" ||
        tab.type === "workflow-artifact",
    ) ??
    visibleTabs.at(-1);
  return nextActive && nextActive.id !== current.activeTabId
    ? { ...current, activeTabId: nextActive.id }
    : current;
}

/** 关闭时只处理已选中的 id，避免异步 authority 返回后误关新打开的标签。 */
// 批量关闭先按 id 依次删除，再按 scope 重算 active；
// id 列表由调用方在异步授权前冻结，避免返回时误关新开的标签。
export function closeSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  tabIds: readonly string[],
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
): WorkspaceSidePaneState | null {
  const next = tabIds.reduce(closeSidePaneTab, current);
  return selectSidePaneTabsForScope(next, scope, preferredTabId);
}

export function closeSidePaneTabForScope(
  current: WorkspaceSidePaneState | null,
  tabId: string,
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
): WorkspaceSidePaneState | null {
  return closeSidePaneTabs(current, [tabId], scope, preferredTabId);
}

// 关闭末项返回 null；上层据此收起面板，这里不补建 new-tab；
// 关闭非 active 只移除；关闭 active 则落到原位置（或末尾）。
export function closeSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tabId: string,
): WorkspaceSidePaneState | null {
  if (!current) {
    return null;
  }

  // 找不到即返回原引用，关闭幂等；
  // 位置用于决定关闭当前项后落到左边还是末尾。
  const closingIndex = findTabIndexById(current.tabs, tabId);
  if (closingIndex < 0) {
    return current;
  }

  const nextTabs = current.tabs.filter((tab) => tab.id !== tabId);
  if (nextTabs.length === 0) {
    return null;
  }

  if (current.activeTabId !== tabId) {
    return {
      tabs: nextTabs,
      activeTabId: current.activeTabId,
    };
  }

  const fallbackIndex = Math.min(closingIndex, nextTabs.length - 1);
  return {
    tabs: nextTabs,
    activeTabId: nextTabs[fallbackIndex]!.id,
  };
}

// 保留被右键的 tab 并强制激活它，避免 activeTabId 指向已移除项。
export function closeOtherSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  tabId: string,
): WorkspaceSidePaneState | null {
  if (!current) {
    return null;
  }

  // 只有目标存在且数量大于 1 时才执行「关闭其他」；
  // 单个 tab 时原样返回，避免产生空状态。
  const targetTab = current.tabs.find((tab) => tab.id === tabId);
  if (!targetTab || current.tabs.length <= 1) {
    return current;
  }

  return {
    // 交互说明：右键“关闭其他标签”以当前被操作的 tab 为保留对象，
    // 即使它原本不是激活项，也要同步激活，避免内容区指向一个已被移除的 activeTabId。
    tabs: [targetTab],
    activeTabId: targetTab.id,
  };
}

// 全部关闭即返回 null，折叠由上层统一处理。
export function closeAllSidePaneTabs(): WorkspaceSidePaneState | null {
  return null;
}

// 只允许激活已存在的 id；不存在的请求原样返回，避免产生悬空 activeTabId。
export function setActiveSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tabId: string,
): WorkspaceSidePaneState | null {
  if (!current || !current.tabs.some((tab) => tab.id === tabId)) {
    return current;
  }

  return {
    ...current,
    activeTabId: tabId,
  };
}

// 元数据（title/favicon）只写 browser 系 tab；无命中返回原引用。
export function updateBrowserSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tabId: string,
  patch: BrowserSidePaneMetadata,
): WorkspaceSidePaneState | null {
  if (!current) {
    return current;
  }

  let didUpdate = false;
  const nextTabs = current.tabs.map((tab) => {
    if (tab.id !== tabId) {
      return tab;
    }
    if (tab.type === "browser" || tab.type === "browser-use") {
      didUpdate = true;
      return { ...tab, ...patch };
    }
    return tab;
  });

  return didUpdate
    ? {
        ...current,
        tabs: nextTabs,
      }
    : current;
}

/** 按 workspace/session/browser generation/tab 完整匹配运行态，避免 stale run 串写。 */
// 必须按 workspace + session + browserId + generation + tabId 全量匹配，
// 否则上一轮 browser 实例的延迟事件会写到新一代 tab 上；
// resetsResizeBaseline 时递增基线版本，供 view 重建 ResizeObserver。
export function markBrowserUseSidePaneTabOperation(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    sessionId: string;
    browserId: string;
    browserGeneration: number;
    tabId: string;
    operationUntil: number;
    resetsResizeBaseline?: boolean;
  },
): WorkspaceSidePaneState | null {
  if (!current) return current;
  let didUpdate = false;
  const tabs = current.tabs.map((tab) => {
    if (
      tab.type !== "browser-use" ||
      tab.workspaceKey !== options.workspaceKey ||
      tab.sessionId !== options.sessionId ||
      (tab.browserId !== undefined && tab.browserId !== options.browserId) ||
      (tab.browserGeneration !== undefined &&
        tab.browserGeneration !== options.browserGeneration) ||
      tab.tabId !== options.tabId
    ) {
      return tab;
    }
    didUpdate = true;
    return {
      ...tab,
      browserUseOperationUntil: options.operationUntil,
      ...(options.resetsResizeBaseline
        ? {
            browserUseResizeBaselineVersion: (tab.browserUseResizeBaselineVersion ?? 0) + 1,
          }
        : {}),
    };
  });
  return didUpdate ? { ...current, tabs } : current;
}

// 拖拽排序只动顺序，不动激活项；
// 先删除再按目标索引插入，索引已被 splice 修正，无需再调整。
export function reorderSidePaneTab(
  current: WorkspaceSidePaneState | null,
  activeTabId: string,
  overTabId: string,
): WorkspaceSidePaneState | null {
  if (!current || activeTabId === overTabId) {
    return current;
  }

  // 越界（-1 或超过长度）一律原样返回：调用方可能基于旧列表计算索引；
  // 排序是纯展示操作，宁可不生效，也不能把 tab 插到非法位置造成渲染崩溃。
  // 移动后仍保持 activeTabId 不变。
  const activeIndex = findTabIndexById(current.tabs, activeTabId);
  const overIndex = findTabIndexById(current.tabs, overTabId);
  if (activeIndex < 0 || overIndex < 0) {
    return current;
  }

  const nextTabs = [...current.tabs];
  // 先摘出再按目标索引插入；目标索引在摘除后可能左移，splice 已按新数组处理，
  // 因此不需要额外修正 overIndex。
  const [movedTab] = nextTabs.splice(activeIndex, 1);
  if (!movedTab) {
    return current;
  }

  nextTabs.splice(overIndex, 0, movedTab);
  return {
    ...current,
    tabs: nextTabs,
  };
}

// 当前激活的是本 owner 的 browser 时才关闭；否则打开/复用；
// 否则会被后台 tab 干扰，出现「点一下换页、再点一下才关」。
export function toggleBrowserSidePane(
  current: WorkspaceSidePaneState | null,
  ownerTaskId?: string | null,
  remoteSessionId?: string | null,
): WorkspaceSidePaneState | null {
  const ownerKey = sidePaneOwnerKey(ownerTaskId);
  const activeTab = getActiveSidePaneTab(current);
  if (activeTab?.type === "browser" && sidePaneOwnerKey(activeTab.ownerTaskId) === ownerKey) {
    return closeSidePaneTab(current, activeTab.id);
  }

  return activateBrowserSidePane(current, {
    ownerTaskId,
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
}

// Git 的 toggle 只认当前激活的 Git tab；后台 Git 不影响打开。
export function toggleGitSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  const activeTab = getActiveSidePaneTab(current);
  if (activeTab?.type === "git") {
    return closeSidePaneTab(current, activeTab.id);
  }

  return activateGitSidePane(current);
}

// 关闭代码查看器只处理当前激活项，避免误关后台文件。
export function closeCodeViewerSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  const activeTab = getActiveSidePaneTab(current);
  return activeTab?.type === "code-viewer" ? closeSidePaneTab(current, activeTab.id) : current;
}

export function closeGitSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  return closeSidePaneTab(current, "git");
}

// id 由 workspace + remote + root + session + workId 五段编码组成；
// 任一维度变化都产生新 tab，而同一 work 重复点击幂等；
// ownerTaskId 固定为 rootSessionId，可见性按根会话收敛。
export function openBackgroundBashSidePane(
  current: WorkspaceSidePaneState | null,
  target: OpenBackgroundBashSideTabRequest,
): WorkspaceSidePaneState {
  // 后台 Bash 的 workspace 键同样遵循 identity 优先规则（INV-01）；
  // remoteSessionId 为空串参与 id，保证本地与远程输出不合并。
  const workspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
  const id =
    "bash-output:" +
    [
      workspaceKey,
      target.remoteSessionId ?? "",
      target.rootSessionId,
      target.sessionId,
      target.workId,
    ]
      .map(encodeSidePaneTabIdPart)
      .join(":");
  const existing = current?.tabs.find((tab) => tab.id === id);
  return activateSidePaneTab(
    current,
    existing ?? {
      ...target,
      id,
      type: "bash-output",
      workspaceKey,
      ownerTaskId: target.rootSessionId,
      openedAt: Date.now(),
    },
  );
}

// new-tab 是启动器占位，id 用 uuid：允许多个入口同时存在。
export function activateNewTabSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, { id: createUuid(), type: "new-tab", openedAt: Date.now() });
}

/** 展开面板始终有真实标签；只为当前对话补入口，不改变其他对话的标签。 */
// INV-17：只有当前 scope 没有任何可见 tab 时才补一个 new-tab；
// 补建时写入 scope 归属，保证它只对当前对话可见；
// 已有内容时不干预，避免展开动作替换用户正在看的页面。
export function ensureSidePaneTab(
  current: WorkspaceSidePaneState | null,
  scope: SidePaneVisibilityScope,
): WorkspaceSidePaneState {
  if (current && getVisibleSidePaneTabs(current.tabs, scope).length > 0) return current;
  return activateSidePaneTab(current, {
    id: createUuid(),
    type: "new-tab",
    openedAt: Date.now(),
    ...scope,
  });
}
