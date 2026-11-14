import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import {
  openFileManagerSidePane,
  navigateFileManagerSidePane,
  type FileManagerTarget,
} from "@/lib/workspaceSidePane.js";
/* eslint-disable max-lines */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createUuid } from "@zcode/shared";
import type { EmbeddedBrowserOpenUrlRequest, IPlatformService } from "@zcode/shared";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
// 保活：side pane terminal 跨 workspace 会话上移到模块级 registry。
// 关闭 terminal tab 时必须显式 release，杀掉 PTY，避免常驻 registry 造成孤儿进程。
import { sidePaneTerminalSessionRegistry } from "@/terminal/sidePaneTerminalSessionRegistry.js";
import {
  buildTaskSidePaneMemoryKey,
  getSidePaneCollapsedPreference,
  readTaskSidePaneMemoryState,
  saveTaskSidePaneCollapsedPreference,
  saveTaskSidePaneMemoryState,
} from "@/lib/taskSidePaneMemory.js";
import {
  ensureSidePaneTab,
  closeSidePaneTab,
  closeSidePaneTabForScope,
  closeSidePaneTabs,
  isSidePaneTabVisibleInScope,
  closeGitSidePane,
  closeCodeViewerSidePane,
  openWhiteboardSidePane,
  openModelTrajectorySidePane,
  openTerminalSidePane,
  openSubagentSessionSidePane,
  openSubagentDirectorySidePane,
  openSelectionSideChatPane,
  openPlanDetailSidePane,
  openWorkflowRunSidePane,
  replaceWorkflowRunSidePane,
  openWorkflowRunDirectorySidePane,
  openWorkflowActorSessionSidePane,
  openWorkflowWorkspaceSidePane,
  openWorkflowArtifactSidePane,
  activateDeveloperToolsSidePane,
  activatePluginMarketSidePane,
  activateNewTabSidePane,
  openBrowserSidePane,
  openBrowserPermissionsSidePane,
  openOrActivateBrowserSidePaneByUrl,
  findBrowserSidePaneTabByUrl,
  applyBrowserUseSidePaneEvent,
  applyBrowserUseSidePaneVisibilityEvent,
  applyBrowserTabResidencyEvent,
  BROWSER_USE_OPERATION_INDICATOR_DURATION_MS,
  openCodeViewerSidePane,
  openCodeViewerSidePanes,
  activateGitSidePane,
  getActiveSidePaneTab,
  getVisibleSidePaneTabs,
  sidePaneOwnerKey,
  markBrowserUseSidePaneTabOperation,
  reorderSidePaneTab,
  resolveSidePaneScopeState,
  restoreSidePaneTab,
  setActiveSidePaneTab,
  syncSubagentSessionSidePaneTabs,
  toggleBrowserSidePane,
  toggleGitSidePane,
  updateBrowserSidePaneTab,
  stampSidePaneTabsOwnership,
  type BrowserSidePaneMetadata,
  type TreemappingSidePaneTab,
  type OpenScopedSubagentSideTabRequest,
  type OpenBackgroundBashSideTabRequest,
  openBackgroundBashSidePane,
  type OpenScopedSubagentDirectorySideTabRequest,
  type OpenSelectionSideChatRequest,
  type OpenScopedPlanDetailSideTabRequest,
  type OpenScopedWorkflowRunSideTabRequest,
  type OpenScopedWorkflowRunDirectorySideTabRequest,
  type OpenScopedWorkflowActorSessionSideTabRequest,
  type OpenScopedWorkflowArtifactSideTabRequest,
  type OpenScopedWorkflowWorkspaceSideTabRequest,
  type WorkspaceSidePaneState,
  type WorkspaceSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { openPluginUiSidePane } from "@/plugin-ui/index.js";
import type { OpenPluginUiSideTabRequest } from "@/plugin-ui/contract.js";
import { logger } from "@/logger.js";
import { getPathLeaf, joinFilePath, toFileUrl } from "@/lib/path.js";
import { shouldOpenWorkflowArtifactInBrowser } from "@/lib/workflowArtifactOpen.js";
import { useWhiteboardStore } from "@/store/whiteboardStore.js";
import { useModelTrajectoryOpenBridge } from "@/hooks/useModelTrajectoryOpenBridge.js";
import { useServices } from "@/hooks/useServices.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { clearSelectionSideChat } from "@/lib/selectionSideChatRuntime.js";
import { clearConversationSelectionReferenceScope } from "@/lib/conversationSelectionReference.js";
import { subscribeTaskLifecycle } from "@/lib/taskLifecycleEvents.js";

// 右侧面板（side pane）的唯一状态所有者与全部写入口。
// 负责：面板 tab 集合、折叠偏好、按 workspace/task 的隔离与记忆、Browser/终端/子智能体
// 等所有打开关闭动作，以及 main 侧 Browser View 事件的收敛。
//
// 不变量（INV）：
// INV-01 workspace 身份键统一为 workspaceIdentity?.trim() || workspaceAbsPath
//   （守住它的位置：activeWorkspaceKey）。只按路径匹配会让远程与本地同路径串桶。
// INV-02 sidePaneMemoryKey 不再按 task 切分：同一 workspace 内切任务不换记忆桶
//   （守住它的位置：sidePaneMemoryKey 的 useMemo 依赖）。按 task 切会让面板随切任务整体消失。
// INV-03 所有面板写入口必须经 commitSidePaneState：先写 canonical ref 再 setState
//   （守住它的位置：commitSidePaneState）。否则 BrowserView IPC 与普通交互同批到达时互相覆盖。
// INV-04 关闭最后一个可见 tab 必须收敛为收起态，且不得在该路径补建 new-tab
//   （守住它的位置：commitSidePaneState 内的 empty 检查）。补建会让 Cmd/Ctrl+W 永远关不完。
// INV-05 Browser View 的四类事件订阅不能以 isWorkspaceVisible 为条件（守住它的位置：
//   订阅 effect 的 guard）。设置页覆盖时取消订阅会丢 ready，waitForGuest 超时后 tab 被删。
// INV-06 迟到事件只后台挂载，不抢焦点：isCurrentOwner 由 workspace + remoteSession + session
//   三元组判定（守住它的位置：handleOpenBrowserUrl）。只比 session 会把事件接到别的对话。
// INV-07 browser tab 的 remoteSessionId 必须在创建时冻结，不借用当前 UI 值
//   （守住它的位置：openBrowserSidePane 的两条路径）。借来的值会在切换 workspace 后 scope 失配。
// INV-08 关闭 browser tab 必须先取得 main authority，失败时保留 UI 壳（守住它的位置：
//   closeBrowserTabsWithAuthority）。只删壳会让重启后 tab 复活。
// INV-09 human tab 的 remoteSessionId 可兜底到 workspaceRemoteSessionId，browser-use 不兜底
//   （守住它的位置：激活/关闭两处 scopedRemoteSessionId）。两侧必须同源，否则 scope 失配。
// INV-10 跨 workspace 关闭必须写回点击时冻结的 scope，而不是完成时的 scope
//   （守住它的位置：closeSelectedSidePaneTabs 的 scope 变量）。写错桶会丢掉原 workspace 的关闭结果。
// INV-11 最近关闭列表上限 8，selection-side-chat / browser-use / new-tab 不入列
//   （守住它的位置：rememberClosedSidePaneTabs）。不可恢复的 tab 进列表会点出幽灵入口。
// INV-12 重新打开 browser tab 必须换新 id 并剥离 residency 字段（守住它的位置：
//   handleReopenClosedSidePaneTab）。复用旧 id 会与 main 侧已删除的 logical tab 冲突。
// INV-13 关闭 terminal tab 必须 release 模块级 registry，否则 PTY 变孤儿进程
//   （守住它的位置：closeSelectedSidePaneTabs 内的 release）。
// INV-14 父任务结束时清理其 selection-side-chat 子会话（守住它的位置：
//   subscribeTaskLifecycle 的 effect）。不清理会把子会话 runtime 永久挂在 Host 上。
// INV-15 用户主动展开必须同时写折叠偏好（守住它的位置：revealSidePaneForCurrentOwner）；
//   只置 state 会在重启后回到收起态，用户会认为展开没生效。
// INV-16 Office 模式只隐藏新建入口与最近关闭中的 terminal/git，不过滤已打开面板
//   （守住它的位置：return 处注释与 recentClosedSidePaneTabs）。过滤已打开面板会让它们凭空消失。
// INV-17 平台事件订阅由 effect 返回的 disposer 注销，handler 必须 memo（守住它的位置：
//   各 onBrowserView* effect 的依赖）。每次重订阅窗口内的事件会进黑洞。
// INV-18 openFileUrlInBrowserSidePane 恒激活，且 ownerTaskId 由调用方冻结
//   （守住它的位置：该函数）。盖章当前 owner 会让产物 tab 在切换落定后不可见。
//
// 阅读顺序：参数与记忆桶 → canonical ref 与提交原语 → scope 恢复 → 打开类动作（按面板类型）→
// Browser View 订阅 → 关闭/重开 → 导出面。
//
// 注意：本文件既有注释是修复记录，保留原样；新增注释只解释「为什么不能改」。
export interface BrowserNavigationRequest {
  id: string;
  targetTabId: string;
  url: string;
}

// 区分「Agent 弹出的窗口」与「人类新开的外链 tab」：
// human webview 的 owner 是 unclaimed-iab，legacy-iab 与 iab:<uuid> 都属于 Agent 控制上下文；
// sourceTabId 用于排除普通外链/终端链接，三者同时成立才算模型 popup。
function isAgentOpenedBrowserPopup(payload: EmbeddedBrowserOpenUrlRequest): boolean {
  // human webview 的 owner 使用 unclaimed-iab；legacy-iab 与 iab:<uuid> 都是 Agent
  // 控制上下文。sourceTabId 还可避免把普通外链/终端链接误判为模型 popup。
  return Boolean(payload.sourceTabId && payload.browserId && payload.browserId !== "unclaimed-iab");
}

export interface RecentClosedSidePaneTab {
  tab: WorkspaceSidePaneTab;
  closedAt: number;
}

// 上限固定为 8，避免最近关闭列表随会话无限增长；
// 调大会让「重新打开」菜单越过视口，用户反而找不到。
const RECENT_CLOSED_SIDE_PANE_TAB_LIMIT = 8;

// 终端标题按「目录名 + 递增序号」生成，重名时从 2 开始找空位；
// 只比较 terminal 类型，避免与 browser 等 tab 的标题互相挤占；
// 该函数不做上限保护，调用方必须保证 tab 数量有限。
function createTerminalSidePaneTitle(
  current: WorkspaceSidePaneState | null,
  workspaceAbsPath: string,
): string {
  const baseTitle = getPathLeaf(workspaceAbsPath) || "Terminal";
  const usedTitles = new Set(
    current?.tabs
      .filter((tab) => tab.type === "terminal")
      .map((tab) => tab.title.trim())
      .filter(Boolean) ?? [],
  );

  // 首选直接使用目录名；只有冲突时才追加序号，保持常见情况标题干净。
  if (!usedTitles.has(baseTitle)) {
    return baseTitle;
  }

  for (let index = 2; ; index += 1) {
    const candidate = `${baseTitle} ${index}`;
    if (!usedTitles.has(candidate)) {
      return candidate;
    }
  }
}

export function useAppPanels(options: {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string | null;
  activeTaskId: string | null;
  /** 草稿态与正式任务共用稳定 id，作为侧栏对话隔离边界。 */
  sidePaneOwnerId: string | null;
  isDesktop?: boolean;
  /**
   * 展示语义：视图当前是否呈现给用户（设置页覆盖时为 false）。
   * 本 hook 刻意不消费它——Browser View 事件是 main 侧权威转发，订阅不能受可见性影响，
   * 详见下方订阅 effect 的时序约束注释。
   * 入参保留的唯一理由是回归护栏：useAppPanelsBrowserViewLifecycle 的四条用例靠传 false 表达
   * “设置页覆盖中”，一旦有人把可见性重新写回订阅条件，这些用例会立即失败。删掉入参，
   * 那层保护也就跟着消失了。
   */
  isWorkspaceVisible?: boolean;
  supportsEmbeddedBrowser?: boolean;
  defaultWhiteboardNamePrefix: string;
  platform?: Pick<
    IPlatformService,
    | "onOpenBrowserUrl"
    | "onBrowserViewReady"
    | "onBrowserViewOperation"
    | "onBrowserViewVisibility"
    | "onBrowserViewCloseTab"
    | "onBrowserViewSuspend"
    | "onBrowserViewRestore"
    | "browserViewCloseTab"
    | "browserViewEnsureResident"
  >;
}) {
  const {
    workspaceAbsPath,
    workspaceIdentity,
    workspaceRemoteSessionId,
    activeTaskId,
    sidePaneOwnerId,
    isDesktop,
    supportsEmbeddedBrowser: explicitSupportsEmbeddedBrowser,
    defaultWhiteboardNamePrefix,
    platform,
  } = options;
  // 能力判定优先取宿主显式值；未声明时按「桌面才有内嵌浏览器」推断。
  // Web 端显式 false 必须尊重，否则会渲染一个无法创建 guest 的面板。
  const supportsEmbeddedBrowser = explicitSupportsEmbeddedBrowser ?? Boolean(isDesktop);
  // INV-01：身份键只在这里计算一次，全 hook 复用；
  // 后续所有 scope、记忆桶、事件路由都必须用它，不能各自拼路径。
  // [失败路径] 混用路径会让同一远程 workspace 出现两个记忆桶。
  const activeWorkspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  // 服务只能经 useServices 获取（依赖注入），禁止直接 import 实现或走 window.zcode；
  // 本 hook 只用两个能力：产物出处查询与关闭子会话。
  // 新增调用时先确认所在环境（桌面/Web/远程）都实现了该服务。
  const { zcodeAgentService, zcodeSessionService } = useServices();
  // Office 模式是「入口可见性」开关，不是权限开关；
  // 它只阻止新建 terminal/git，并过滤最近关闭菜单。
  // 不要用它替代 isolate 的只读判定。
  const isOfficeMode = useIsOfficeMode();
  // INV-02：记忆键按 workspace 而非 task 划分，切换任务时面板保持不动；
  // 依赖里刻意不含 activeTaskId 之外的 task 级字段，避免流式更新导致重算。
  // 该 key 同时被 buildTaskSidePaneMemoryKey 用于本地与远程的统一存储。
  const sidePaneMemoryKey = useMemo(
    () =>
      buildTaskSidePaneMemoryKey({
        workspacePath: workspaceAbsPath,
        workspaceIdentity,
        taskId: activeTaskId,
      }),
    [activeTaskId, workspaceAbsPath, workspaceIdentity],
  );
  // 首帧同步读取记忆，保证挂载时不会先闪一个空面板再恢复；
  // 后续 key 变化由下面的 effect 负责换桶并落盘旧桶。
  const initialSidePaneMemoryState = readTaskSidePaneMemoryState(sidePaneMemoryKey);

  // 修复说明：之前终端区域被固定写死在 <main> 底部，页面一进入就会直接挂载 Terminal，
  // 不仅默认占用高度，还会立刻创建终端会话。这里改成显式开关，默认关闭，
  // 只有用户主动点击后才渲染 Terminal，这样就不会出现"terminal 不用默认打开"的问题。
  // 底部终端默认关闭：进入工作区不应立刻创建 PTY 会话并占用主区域高度。
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  // 修复说明：右侧共享面板（browser / code-viewer）需要默认关闭。
  // 否则一进工作区就会先占住主会话空间，和"只在用户主动查看时再展开"的预期相反。
  // side pane 的权威状态；null 表示当前 workspace 从未打开过面板。
  // 所有写入必须经 commitSidePaneState，直接 set 会与 canonical ref 脱节。
  const [sidePaneState, setSidePaneState] = useState<WorkspaceSidePaneState | null>(
    initialSidePaneMemoryState.sidePaneState,
  );
  // 折叠态单独存放：与 tab 集合不同，它可以在没有 tab 时依然有值；
  // 初始值优先取按 owner 的偏好，其次取桶级偏好。
  // 写入口只有 setSidePaneCollapsed 包装，禁止直接调用 setter。
  const [isSidePaneCollapsed, setIsSidePaneCollapsedState] = useState(
    getSidePaneCollapsedPreference(initialSidePaneMemoryState, sidePaneOwnerId) ??
      initialSidePaneMemoryState.isSidePaneCollapsed,
  );
  // 交互说明：侧栏显隐按钮放在 App 外层，而不是 Sidebar 内部。
  // 这样即使侧栏被隐藏，入口也仍然留在左上角，不会出现"收起后没有地方再展开"的问题；
  // 同时这里统一处理 macOS 红绿灯安全区，避免按钮和系统窗口控件重叠。
  // 左侧栏显隐是纯 UI 状态，不持久化：每次启动都从可见开始。
  const [isSidebarVisible, setIsSidebarVisible] = useState(true);
  // 把「导航到某个 URL」作为一次性请求下发，而不是改 tab 的 initialUrl；
  // webview 用 requestId 去重，避免同 URL 重复导航被吞。
  // 消费完成后由 handleBrowserNavigationRequestHandled 按 id 清空。
  const [browserNavigationRequest, setBrowserNavigationRequest] =
    useState<BrowserNavigationRequest | null>(null);
  // 保存所有 workspace 的最近关闭记录，展示时再按当前 scope 过滤；
  // 只存当前 workspace 会让切回来之后无法重开。
  const [allRecentClosedSidePaneTabs, setAllRecentClosedSidePaneTabs] = useState<
    RecentClosedSidePaneTab[]
  >([]);
  // 按 rootSessionId 记住子智能体上次激活的 tab，用于 scope 恢复；
  // 存 tab 对象会随关闭失效，存 id 才能校验后再恢复。
  // 该 map 只增不删，规模受会话数限制。
  const lastActiveSubagentTabByRootRef = useRef<Map<string, string>>(new Map());
  // owner 在渲染期同步到 ref，供同步块中的事件回调读取最新值；
  // [并发] 用 state 会让同一事件循环内先到的 IPC 读到旧 owner。
  // 所有异步完成回调都必须通过 ref 取 owner，而不是闭包变量。
  const sidePaneOwnerIdRef = useRef(sidePaneOwnerId);
  sidePaneOwnerIdRef.current = sidePaneOwnerId;
  // workspace key 同样在渲染期同步到 ref；
  // 异步关闭/重开流程需要判断「完成时是否已切走」，只能靠 ref。
  const activeWorkspaceKeyRef = useRef(activeWorkspaceKey);
  activeWorkspaceKeyRef.current = activeWorkspaceKey;
  // 按 workspace::owner 记住上次激活的 tab，scope 恢复时优先用它；
  // recentlyClosed 保存完整内容，而这里只记 appId，不保留渲染内容。
  const activeTabByOwnerRef = useRef<Map<string, string>>(new Map());
  const activeSidePaneMemoryKeyRef = useRef<string | null>(sidePaneMemoryKey);
  // canonical 快照：state 与折叠态同源，供同步写入口与事件回调读取；
  // [并发] React 提交前 setState 不会更新闭包，所有判断必须以这份 ref 为准。
  // 每次写入都必须同时更新 ref 与 state，两个字段不能分开改。
  const latestSidePaneMemoryRef = useRef({
    sidePaneState,
    isSidePaneCollapsed,
  });
  latestSidePaneMemoryRef.current = {
    sidePaneState,
    isSidePaneCollapsed,
  };

  // 折叠态参与同一批事件的后续决策，统一同步 ref，避免 React 提交前读到旧值。
  // 折叠态的唯一写入口：先算下一值、先写 ref、再 setState；
  // 支持函数式更新以保证同一批事件里的连续 toggle 能叠加；
  // 直接调用原生 setter 会让紧随其后的 commit 读到旧折叠态。
  const setIsSidePaneCollapsed = useCallback((value: boolean | ((current: boolean) => boolean)) => {
    const next =
      typeof value === "function"
        ? value(latestSidePaneMemoryRef.current.isSidePaneCollapsed)
        : value;
    latestSidePaneMemoryRef.current.isSidePaneCollapsed = next;
    setIsSidePaneCollapsedState(next);
  }, []);

  // scope 是「当前 workspace + 当前 owner」的稳定投影，全部来自 ref；
  // 用 useCallback 空依赖保证事件回调里拿到的永远是最新 scope。
  // 不要把它扩成含 remoteSessionId 的对象：scope 只做可见性收窄。
  const currentSidePaneScope = useCallback(
    () => ({
      workspaceKey: activeWorkspaceKeyRef.current,
      ownerTaskId: sidePaneOwnerIdRef.current,
    }),
    [],
  );

  // INV-15：展开面板的同时把偏好写到当前 owner 名下；
  // 只 setState 会在下次进入该 workspace 时恢复成收起。
  // 写入的是「当前」owner，产物等特殊路径需要自己冻结 owner，不能复用它盖章。
  const revealSidePaneForCurrentOwner = useCallback(() => {
    setIsSidePaneCollapsed(false);
    saveTaskSidePaneCollapsedPreference(
      activeSidePaneMemoryKeyRef.current,
      sidePaneOwnerIdRef.current,
      false,
    );
  }, []);

  // INV-03：所有面板写入的唯一提交原语。顺序固定为：算下一值 → 收敛折叠态 → 写 ref → setState。
  // INV-04：可见 tab 归零时强制收起，但绝不在这里补建 new-tab。
  // [并发] 普通交互与 BrowserView IPC 可能同批到达，先写 ref 才能按接收顺序合并。
  // 返回 next 供调用方读取新状态，不要在外部再用 state 变量推算。
  const commitSidePaneState = useCallback(
    (updater: (current: WorkspaceSidePaneState | null) => WorkspaceSidePaneState | null) => {
      const next = updater(latestSidePaneMemoryRef.current.sidePaneState);
      // 关闭末标签必须收敛到收起态；在此补建入口会让 Cmd/Ctrl+W 永远关闭不完。
      // 仅显式展开空面板时创建 new-tab，后台关闭也不能重新展开面板。
      // visibility 按当前 scope 计算，其他任务的后台 tab 不算「有内容」；
      // 否则后台 tab 会让当前空面板保持展开，Cmd/Ctrl+W 也关不干净。
      if (getVisibleSidePaneTabs(next?.tabs ?? [], currentSidePaneScope()).length === 0) {
        setIsSidePaneCollapsed(true);
      }
      // 普通侧栏交互和 BrowserView IPC 可在同一 React batch 内相邻到达。
      // 若只有 BrowserView 更新同步 ref，后到的具体值会覆盖尚未提交的打开、激活或排序更新。
      // 所有侧栏写入口统一先提交 canonical ref，保证交互与 lifecycle 严格按接收顺序合并。
      latestSidePaneMemoryRef.current = {
        ...latestSidePaneMemoryRef.current,
        sidePaneState: next,
      };
      setSidePaneState(next);
      return next;
    },
    [currentSidePaneScope],
  );

  // 打开类动作的提交原语：先盖章归属，再处理「new-tab 被内容替换」的占位逻辑；
  // 归属章包括 ownerTaskId / workspaceKey / remoteSessionId，三者必须同时写。
  // 只在打开路径使用；关闭路径必须走 commitSidePaneState，避免盖章复活旧 tab。
  const commitOpenedSidePaneState = useCallback(
    (updater: (current: WorkspaceSidePaneState | null) => WorkspaceSidePaneState | null) => {
      commitSidePaneState((current) => {
        const next = stampSidePaneTabsOwnership(updater(current), {
          ownerTaskId: sidePaneOwnerIdRef.current,
          workspaceKey: activeWorkspaceKeyRef.current,
          remoteSessionId: workspaceRemoteSessionId ?? null,
        });
        const launcher = getActiveSidePaneTab(current);
        const opened = getActiveSidePaneTab(next);
        const scope = currentSidePaneScope();
        // 新标签页被内容替换，保留原位置；后台或其他对话的打开事件不能消费当前入口。
        // 插件市场保留返回入口，不属于在新标签页内启动的工具。
        if (
          !next ||
          // 只有「从 new-tab 启动器打开的、同 scope 的、非插件市场的」tab 才替换启动器；
          // 后台或其他对话的打开事件不能消费当前入口，否则用户当前页会被悄然替换。
          // 插件市场保留返回入口，它不是新标签页里启动的工具。
          launcher?.type !== "new-tab" ||
          !opened ||
          opened.type === "new-tab" ||
          opened.type === "plugin-market" ||
          !isSidePaneTabVisibleInScope(launcher, scope) ||
          !isSidePaneTabVisibleInScope(opened, scope)
        )
          return next;
        // 目标 tab 已存在时只删启动器；不存在时用 flatMap 把它插到启动器原位；
        // 保留原位置是用户预期（从第 3 个标签启动的新工具不该跳到末尾）。
        const alreadyOpen = current?.tabs.some((tab) => tab.id === opened.id);
        return {
          ...next,
          tabs: alreadyOpen
            ? next.tabs.filter((tab) => tab.id !== launcher.id)
            : next.tabs.flatMap((tab) =>
                tab.id === launcher.id ? [opened] : tab.id === opened.id ? [] : [tab],
              ),
        };
      });
    },
    [commitSidePaneState, currentSidePaneScope, workspaceRemoteSessionId],
  );

  useEffect(() => {
    // workspace 切换时先落盘旧桶，再恢复新桶；
    // 顺序反转会把新 workspace 的状态写进旧 key。
    // 同一 key 内切任务直接返回，面板不重建。
    const previousKey = activeSidePaneMemoryKeyRef.current;
    // key 未变说明只是同 workspace 内刷新，无需换桶；
    // 这里提前 return 也避免了每次渲染都写一次存储。
    if (previousKey === sidePaneMemoryKey) {
      return;
    }

    // side pane 原来是 workspace 组件内的瞬时状态，跨 workspace 切换会被新渲染覆盖。
    // 这里在 key 变更前先把旧 workspace 的 tabs/折叠态写入内存，再恢复新 workspace，避免不同 workspace 串状态。
    // 同一 workspace 内切换 task 不应该影响 side pane，所以 key 已经不再按 task 维度切分。
    // 落盘必须用 canonical ref，而不是渲染闭包里的 state；
    // 闭包值可能落后于刚发生的 IPC 更新，写入会回退用户操作。
    saveTaskSidePaneMemoryState(previousKey, latestSidePaneMemoryRef.current);
    const restored = readTaskSidePaneMemoryState(sidePaneMemoryKey);
    activeSidePaneMemoryKeyRef.current = sidePaneMemoryKey;
    const collapsed =
      getSidePaneCollapsedPreference(restored, sidePaneOwnerIdRef.current) ??
      restored.isSidePaneCollapsed;
    setIsSidePaneCollapsed(collapsed);
    commitSidePaneState(() => restored.sidePaneState);
  // 依赖刻意只有 key：owner 变化不触发换桶；
  // 把 owner 加进来会在切换任务时把面板整体恢复成默认。
  }, [commitSidePaneState, sidePaneMemoryKey]);

  useEffect(() => {
    return () => {
      // 卸载时把当前桶落盘，保证刷新/关闭窗口后仍能恢复；
      // [资源] 这里只写存储，不触碰 PTY；PTY 的释放由终端 registry 自己负责。
      saveTaskSidePaneMemoryState(
        activeSidePaneMemoryKeyRef.current,
        latestSidePaneMemoryRef.current,
      );
    };
  }, []);

  useEffect(() => {
    commitSidePaneState((current) => {
      const scopeKey = `${activeWorkspaceKey}::${sidePaneOwnerId ?? "__draft__"}`;
      // 恢复优先级：当前 owner 上次激活的 tab → 根会话记住的子智能体 tab；
      // 两者都失效时交给 resolveSidePaneScopeState 自行选择默认激活项。
      // 不要退回「第一个 tab」，那会让用户每次切入都跳回最左侧。
      const preferredTabId =
        activeTabByOwnerRef.current.get(scopeKey) ??
        (activeTaskId ? lastActiveSubagentTabByRootRef.current.get(activeTaskId) : undefined);
      // 折叠偏好按 owner 读取最新存储值，而不是使用闭包里的旧 state；
      // owner 维度优先于桶维度，draft 与正式任务可以有不同偏好。
      const collapsedPreference = getSidePaneCollapsedPreference(
        readTaskSidePaneMemoryState(activeSidePaneMemoryKeyRef.current),
        sidePaneOwnerId,
      );
      // scope 恢复是纯函数：输入当前状态、scope、首选 tab、折叠偏好，输出新状态与折叠态；
      // 它同时决定哪些 tab 对当前 owner 可见，因此不能改成在 JSX 层过滤。
      // 日志只记 id 与计数，不打印 URL/路径，避免泄漏到生产日志。
      const resolved = resolveSidePaneScopeState(
        current,
        { workspaceKey: activeWorkspaceKey, ownerTaskId: sidePaneOwnerId },
        preferredTabId,
        collapsedPreference,
      );
      setIsSidePaneCollapsed(resolved.isSidePaneCollapsed);
      logger.debug("[App] 同步对话右侧面板 scope", {
        activeTabId: resolved.sidePaneState?.activeTabId ?? null,
        activeTaskId,
        isSidePaneCollapsed: resolved.isSidePaneCollapsed,
        ownerTaskId: sidePaneOwnerId,
        preferredTabId: preferredTabId ?? null,
        workspaceKey: activeWorkspaceKey,
      });
      return resolved.sidePaneState;
    });
  }, [activeTaskId, activeWorkspaceKey, commitSidePaneState, sidePaneOwnerId]);

  // 跨 workspace 打开目录通过 tabStore 的 pending 目标传递；
  // 用可选 store 是兼容没有 TabStoreProvider 的宿主（如独立预览）。
  // pending 只能被目标 workspace 消费一次。
  const pendingFileManagerTarget = useOptionalTabStore((state) => state.pendingFileManagerTarget);
  const requestFileManager = useOptionalTabStore((state) => state.requestFileManager);
  const consumeFileManager = useOptionalTabStore((state) => state.consumeFileManager);
  // 目标属于其他 workspace 时只登记 pending，等本 hook 换桶后再生效；
  // 临时外部目录不做 workspace 匹配，直接按当前面板打开。
  // 同一 workspace 则立即展开并打开/复用 FileManager tab。
  const handleOpenFileManager = useCallback(
    (target?: FileManagerTarget) => {
      if (
        // 跨 workspace 判定必须用 identity 优先的 key 比较，不能只比路径；
        // 临时外部目录例外：它没有 workspace 归属，天然属于当前上下文。
        // 命中跨 workspace 后必须 return，避免同时在本 workspace 打开一份。
        target &&
        !target.temporaryExternalDirectory &&
        (target.workspaceIdentity?.trim() || target.workspacePath) !== activeWorkspaceKeyRef.current
      ) {
        // 登记后立即返回，真正的打开由 pending effect 在目标 workspace 触发。
        requestFileManager(target);
        return;
      }
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) =>
        openFileManagerSidePane(
          current,
          target ?? {
            workspacePath: workspaceAbsPath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
          },
        ),
      );
    },
    [
      requestFileManager,
      commitOpenedSidePaneState,
      revealSidePaneForCurrentOwner,
      workspaceAbsPath,
      workspaceIdentity,
      workspaceRemoteSessionId,
    ],
  );

  useEffect(() => {
    if (!pendingFileManagerTarget) return;
    const targetKey =
      pendingFileManagerTarget.workspaceIdentity?.trim() || pendingFileManagerTarget.workspacePath;
    if (targetKey !== activeWorkspaceKey) return;
    // 必须在本 hook 恢复目标 workspace 的 pane memory 和 owner 之后消费，不能由子 Shell effect 抢先写入旧桶。
    // 领取失败说明已被其他窗口/实例消费，这里必须放弃；
    // 否则两个窗口会各开一个 FileManager tab。
    // 领取成功后才调用打开，保证「一次 pending 一次打开」。
    if (!consumeFileManager(pendingFileManagerTarget)) return;
    logger.debug("[FileManager] 在目标工作区打开目录", {
      workspaceKey: targetKey,
      ownerTaskId: sidePaneOwnerIdRef.current,
    });
    handleOpenFileManager(pendingFileManagerTarget);
  }, [pendingFileManagerTarget, activeWorkspaceKey, consumeFileManager, handleOpenFileManager]);

  // tab 内导航只改该 tab 的 source，不改变激活项，也不展开面板。
  const handleNavigateFileManager = useCallback(
    (tabId: string, source: CodeViewerSource) => {
      commitSidePaneState((current) => navigateFileManagerSidePane(current, tabId, source));
    },
    [commitSidePaneState],
  );

  // 代码查看器按 source.path 去重复用；打开前先展开，避免渲染在隐藏容器里；
  // 日志里的 path 只用于排障，缺失时记 none，不要拼接完整绝对路径。
  const handleOpenCodeViewer = useCallback(
    (source: CodeViewerSource) => {
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openCodeViewerSidePane(current, source, sidePaneOwnerIdRef.current);
        const activeTab = getActiveSidePaneTab(next);
        const activePath =
          activeTab?.type === "code-viewer" ? (activeTab.source.path ?? "none") : "none";
        logger.info(
          `[App] 切换右侧面板 mode=code-viewer workspace=${workspaceAbsPath} title=${source.title} path=${activePath} tabs=${next.tabs.length}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath],
  );

  // 批量打开从索引 0 开始铺开，空数组直接返回；
  // 一次性提交避免多个 setState 造成中间态闪动。
  const handleOpenCodeViewers = useCallback(
    (sources: readonly CodeViewerSource[]) => {
      if (sources.length === 0) return;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openCodeViewerSidePanes(current, sources, sidePaneOwnerIdRef.current, 0);
        logger.info(
          `[App] 批量打开右侧预览 workspace=${workspaceAbsPath} sources=${sources.length} tabs=${next.tabs.length}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath],
  );

  // Browser 打开请求的统一入口：既服务对话框外链，也服务 main 转发的 webview popup；
  // INV-06：isCurrentOwner 用 workspace + remoteSession + session 三元组判定，迟到事件只后台挂载。
  // INV-07：owner 与 remoteSessionId 在创建时冻结，不从当前 UI 借用。
  const handleOpenBrowserUrl = useCallback(
    (request: string | EmbeddedBrowserOpenUrlRequest) => {
      const payload: EmbeddedBrowserOpenUrlRequest =
        typeof request === "string" ? { url: request, disposition: "foreground-tab" } : request;
      const sourceWorkspaceKey = payload.workspaceKey ?? activeWorkspaceKeyRef.current;
      const sourceSessionId = payload.sessionId ?? sidePaneOwnerIdRef.current;
      const sourceRemoteSessionId =
        payload.remoteSessionId ?? workspaceRemoteSessionId ?? undefined;
      const isCurrentOwner =
        sourceWorkspaceKey === activeWorkspaceKeyRef.current &&
        (sourceRemoteSessionId ?? "") === (workspaceRemoteSessionId ?? "") &&
        sourceSessionId === sidePaneOwnerIdRef.current;
      if (!supportsEmbeddedBrowser) {
        // Web 端没有内置浏览器面板，这里退回浏览器新标签，至少保证外链是可访问的。
        // 不具备内嵌浏览器时退回系统浏览器新标签，至少保证外链可达；
        // noopener,noreferrer 必须保留，防止被打开的页面拿到 window.opener。
        window.open(payload.url, "_blank", "noopener,noreferrer");
        return;
      }

      // 交互说明：消息区只负责抛出"打开这个 URL"的意图，
      // 真正的 webview 导航、地址校验和面板显隐仍统一收口在浏览器面板一侧处理。
      // 分享链接按 URL 复用已有 tab，而不是每次新建；
      // 正则只匹配单段 share 路径，避免把普通页面误判为可复用分享页。
      const isShareUrl = /^https?:\/\/[^/]+\/(?:cn\/)?share\/[^/]+$/u.test(payload.url);
      const targetTabId = `browser:${createUuid()}`;
      // Agent 控制的 guest 触发 popup 时，新的页面仍属于模型操作链路；不能把它
      // 当作人类新开的 Browser tab，继承 setting.json 中保存的自由尺寸/缩放偏好。
      // Agent popup 继承 Agent 会话的尺寸/缩放偏好，不套用人类自由窗口设置；
      // 误判会让人工打开的 tab 带上模型控制态，后续自动化会接管它。
      const agentOpened = isAgentOpenedBrowserPopup(payload);
      // webview popup 事件原来只携带 URL，迟到的对话 1 事件会被当前对话 2
      // 的 owner 接管。保留来源 scope，并且只有来源仍是当前 owner 时才抢焦点。
      // 只有来源仍是当前 owner 时才发导航请求抢焦点；
      // sourceTabId 缺失的迟到 popup 即使 URL 相同也不会打断当前页。
      // 分享 URL 走复用路径，不需要额外导航请求。
      if (!isShareUrl && isCurrentOwner) {
        setBrowserNavigationRequest({
          id: createUuid(),
          targetTabId,
          url: payload.url,
        });
      }
      // 后台挂载不展开面板，也不写折叠偏好；这是「迟到事件不打扰用户」的落点。
      if (isCurrentOwner) revealSidePaneForCurrentOwner();
      logger.info(
        `[App] ${isCurrentOwner ? "切换" : "后台挂载"}右侧面板 mode=browser workspace=${sourceWorkspaceKey} sessionId=${sourceSessionId} url=${payload.url}`,
      );
      commitOpenedSidePaneState((current) =>
        isShareUrl
          ? openOrActivateBrowserSidePaneByUrl(current, {
              initialUrl: payload.url,
              ownerTaskId: sourceSessionId,
              workspaceKey: sourceWorkspaceKey,
              ...(sourceRemoteSessionId ? { remoteSessionId: sourceRemoteSessionId } : {}),
            })
          : openBrowserSidePane(current, {
              tabId: targetTabId,
              initialUrl: payload.url,
              ownerTaskId: sourceSessionId,
              workspaceKey: sourceWorkspaceKey,
              // 这两条路径已有 owner，remoteSessionId 不从当前 UI 借用；必须在创建时冻结。
              ...(sourceRemoteSessionId ? { remoteSessionId: sourceRemoteSessionId } : {}),
              activate: isCurrentOwner,
              agentOpened,
            }),
      );
    },
    [
      commitOpenedSidePaneState,
      revealSidePaneForCurrentOwner,
      supportsEmbeddedBrowser,
      workspaceAbsPath,
      workspaceRemoteSessionId,
    ],
  );

  // browser 开关是 toggle 语义：当前激活的是本 owner 的 browser tab 时只关闭，不展开；
  // 其他情形在 openApp 之后统一调 setIsPanelOpen(true) 展开面板。
  // 能力不支持时只记 info 并返回，不创建任何 UI。
  const handleToggleBrowser = useCallback(() => {
    if (!supportsEmbeddedBrowser) {
      // 能力边界：Web/mobile 当前不支持 Electron webview，不创建 Browser side pane。
      logger.info(`[App] 当前壳层不支持内嵌浏览器，忽略切换请求 workspace=${workspaceAbsPath}`);
      return;
    }

    commitOpenedSidePaneState((current) => {
      const activeTab = getActiveSidePaneTab(current);
      // 用 owner key 归一化比较，draft 与正式任务共享 owner 时也能正确判定；
      // 直接比 ownerTaskId 会在 draft 的 null 与 __draft__ 表示之间失配。
      const closingActiveBrowser =
        activeTab?.type === "browser" &&
        sidePaneOwnerKey(activeTab.ownerTaskId) === sidePaneOwnerKey(sidePaneOwnerIdRef.current);
      const next = toggleBrowserSidePane(
        current,
        sidePaneOwnerIdRef.current,
        workspaceRemoteSessionId,
      );
      if (!closingActiveBrowser) {
        revealSidePaneForCurrentOwner();
      }
      const nextActiveTab = getActiveSidePaneTab(next);
      logger.info(
        `[App] 切换右侧面板 mode=${nextActiveTab?.type ?? "none"} workspace=${workspaceAbsPath} tabs=${next?.tabs.length ?? 0}`,
      );
      return next;
    });
  }, [
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    supportsEmbeddedBrowser,
    workspaceAbsPath,
    workspaceRemoteSessionId,
  ]);

  // 「新建浏览器 tab」与 toggle 不同：总是新建并展开，不关闭现有 tab。
  const handleOpenBrowserTab = useCallback(() => {
    if (!supportsEmbeddedBrowser) {
      // 能力边界：Web/mobile 当前不支持 Electron webview，不创建 Browser side pane。
      logger.info(`[App] 当前壳层不支持内嵌浏览器，忽略新建请求 workspace=${workspaceAbsPath}`);
      return;
    }

    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const next = openBrowserSidePane(current);
      const activeTab = getActiveSidePaneTab(next);
      logger.info(
        `[App] 新建右侧浏览器 tab=${activeTab?.id ?? "none"} workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    supportsEmbeddedBrowser,
    workspaceAbsPath,
  ]);

  // 权限设置面板挂在 browser 权限入口下，origin 是唯一必填上下文；
  // 不支持内嵌浏览器时静默返回，避免 Web 端出现空面板。
  const handleOpenBrowserPermissionSettings = useCallback(
    (origin: string) => {
      if (!supportsEmbeddedBrowser) return;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) =>
        openBrowserPermissionsSidePane(current, {
          origin,
          ownerTaskId: sidePaneOwnerIdRef.current,
          workspaceKey: activeWorkspaceKeyRef.current,
        }),
      );
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, supportsEmbeddedBrowser],
  );

  // 下面这组 Browser View 事件都是 main 侧的权威转发，
  // 不能用 isWorkspaceVisible（= !isSettingsTabActive）当订阅门槛。设置页是覆盖层，App 不
  // 卸载但该标志会变 false，effect cleanup 取消订阅后 main 发出的事件直接进黑洞：ready 丢了会让
  // waitForGuest 10 秒超时并把 tab closeTabDurably 删掉，用户退出设置页就看到侧边栏空空如也。
  // 可见性只表达“现在给不给用户看”，不能决定“要不要接收权威事件”；是否抢焦点仍由 shouldReveal
  // 的 scope 匹配决定，因此这里不再依赖 isWorkspaceVisible。
  useEffect(() => {
    // INV-05：这里的 guard 只判断「宿主能不能收事件」，绝不能加 isWorkspaceVisible；
    // 设置页覆盖期间 App 不卸载，但可见性为 false，取消订阅会丢 ready 事件，
    // 随后 waitForGuest 超时并把 tab 持久删除，用户退出设置页只看到空侧栏。
    if (!supportsEmbeddedBrowser || !isDesktop || !platform?.onOpenBrowserUrl) {
      return;
    }

    // main 已完成 URL 校验与 popup 拦截，renderer 只负责落到右侧 Browser tab；
    // 不要再在这里做一次策略判断，否则两层规则会漂移。
    return platform.onOpenBrowserUrl((request) => {
      // webview 内 target=_blank/window.open 原来要么被 popup 策略吞掉，
      // 要么交给 Electron 默认创建 BrowserWindow。main 进程已拦截并校验 URL，
      // renderer 这里只把受控请求落到当前可见 workspace 的右侧 Browser tab。
      logger.info(
        `[App] webview 请求打开右侧浏览器 tab workspace=${workspaceAbsPath} url=${request.url} disposition=${request.disposition}`,
      );
      handleOpenBrowserUrl(request);
    });
  }, [handleOpenBrowserUrl, isDesktop, platform, supportsEmbeddedBrowser, workspaceAbsPath]);

  // Browser Use 事件携带创建时冻结的 workspace/session，迟到事件只后台挂载，不能抢当前对话焦点。
  // ready 事件携带创建时冻结的 workspace/session，应用后由 shouldReveal 决定是否抢焦点；
  // 读取状态必须用 canonical ref，不能用渲染闭包里的 sidePaneState。
  const handleBrowserViewReady = useCallback(
    (
      payload: Parameters<NonNullable<IPlatformService["onBrowserViewReady"]>>[0] extends (
        value: infer Payload,
      ) => void
        ? Payload
        : never,
    ) => {
      if (!isDesktop) return;
      const activeScope = {
        workspaceKey: activeWorkspaceKeyRef.current,
        remoteSessionId: workspaceRemoteSessionId ?? undefined,
        ownerTaskId: sidePaneOwnerIdRef.current,
      };
      // 事件应用是纯函数，返回新状态与「是否应展开」；
      // 先 commit 再 reveal，保证展开时 tab 已进入可见集合。
      // late 事件只后台挂载，不改变当前激活项。
      const result = applyBrowserUseSidePaneEvent(
        latestSidePaneMemoryRef.current.sidePaneState,
        payload,
        activeScope,
      );
      // 这里用常量 updater 覆盖写入：结果已基于 ref 计算，不能再对 current 二次应用；
      // 对 current 重新应用会让同一事件在批处理中被合并两次。
      commitSidePaneState(() => result.state);
      if (result.shouldReveal) revealSidePaneForCurrentOwner();
      logger.info(
        `[App] ${result.shouldReveal ? "展开并激活" : "后台挂载"} browser-use tab workspace=${payload.workspaceKey} sessionId=${payload.sessionId} tabId=${payload.tabId}`,
      );
    },
    [commitSidePaneState, isDesktop, revealSidePaneForCurrentOwner, workspaceRemoteSessionId],
  );

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewReady) return;
    return platform.onBrowserViewReady(handleBrowserViewReady);
  }, [handleBrowserViewReady, isDesktop, platform]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewOperation) return;
    return platform.onBrowserViewOperation((payload) => {
      // 操作指示器用绝对截止时间，而不是多次 setTimeout；
      // 高频 browser command 只更新时间戳，UI 自行到期消失。
      // 该 payload 不落 info 日志，避免与消息流同量级刷盘。
      const operationUntil = Date.now() + BROWSER_USE_OPERATION_INDICATOR_DURATION_MS;
      commitSidePaneState((current) =>
        markBrowserUseSidePaneTabOperation(current, {
          ...payload,
          operationUntil,
        }),
      );
      // browser command 与消息流同数量级，生产环境不得落 info 日志。
      logger.debug("[App] browser-use operation", {
        operationUntil,
        sessionId: payload.sessionId,
        tabId: payload.tabId,
        workspaceKey: payload.workspaceKey,
      });
    });
  }, [commitSidePaneState, isDesktop, platform]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewVisibility) return;
    return platform.onBrowserViewVisibility((payload) => {
      // visible=true 才按 tab 定位并记录「该 owner 上次激活的 browser-use tab」；
      // visible=false 只在匹配当前激活项时收起面板，不影响其他 tab。
      if (payload.visible && payload.tabId) {
        const result = applyBrowserUseSidePaneVisibilityEvent(
          latestSidePaneMemoryRef.current.sidePaneState,
          { ...payload, tabId: payload.tabId },
          {
            workspaceKey: activeWorkspaceKeyRef.current,
            remoteSessionId: workspaceRemoteSessionId ?? undefined,
            ownerTaskId: sidePaneOwnerIdRef.current,
          },
        );
        if (result.didMatch) {
          activeTabByOwnerRef.current.set(
            `${payload.workspaceKey}::${payload.sessionId}`,
            `browser-use:${payload.tabId}`,
          );
        } else {
          // visibility 与 browser command 同数量级，忽略迟到事件只记开发日志，避免生产刷盘。
          logger.debug("[App] 忽略无现存 shell 的 browser-use visibility", {
            sessionId: payload.sessionId,
            tabId: payload.tabId,
            workspaceKey: payload.workspaceKey,
          });
        }
        commitSidePaneState(() => result.state);
        if (result.shouldReveal) revealSidePaneForCurrentOwner();
        return;
      }

      const active = getActiveSidePaneTab(latestSidePaneMemoryRef.current.sidePaneState);
      if (
        active?.type === "browser-use" &&
        active.workspaceKey === payload.workspaceKey &&
        (active.remoteSessionId ?? "") === (payload.remoteSessionId ?? "") &&
        active.sessionId === payload.sessionId &&
        active.browserId === payload.browserId &&
        active.browserGeneration === payload.browserGeneration &&
        (payload.tabId === undefined || active.tabId === payload.tabId)
      ) {
        // 仅当隐藏的正是当前激活的 browser-use tab 时才收起；
        // 无条件收起会让后台 tab 的可见性事件把用户正在看的面板关掉。
        setIsSidePaneCollapsed(true);
      }
    });
  }, [
    commitSidePaneState,
    isDesktop,
    platform,
    revealSidePaneForCurrentOwner,
    workspaceRemoteSessionId,
  ]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewCloseTab) return;
    return platform.onBrowserViewCloseTab((payload) => {
      // 同时匹配 browser-use 的 logical tabId 与 human browser 的内部 id；
      // 两种 tab 的标识口径不同，缺一分支就会留下关不掉的幽灵 tab。
      const findTargetId = (state: WorkspaceSidePaneState | null) =>
        state?.tabs.find(
          (tab) =>
            (tab.type === "browser-use" && tab.tabId === payload.tabId) ||
            (tab.type === "browser" && tab.id === payload.tabId),
        )?.id ?? null;

      // side pane 状态按 workspace 分开存放，只在「当前活跃 workspace」里查找目标 tab 会漏。
      // Agent 关闭 tab 时用户可能已经切到别的 workspace，通知就被静默丢弃，原 workspace 的持久化状态
      // 仍留着这个 tab —— 切回来后它对应的 main 侧 logical tab 早已不存在，点 × 也关不掉，成为幽灵 tab。
      // 通知带上 owner scope 后，这里按 workspaceKey 路由到对应 workspace 的 memory 直接删除。
      // 只用 workspaceKey 做路由、不再按 session 过滤：main 已判定该 tab 关闭，renderer 侧的壳
      // 无论属于哪个 task 都应当收敛；tabId 本身全局唯一，不存在跨 workspace 误删。
      const targetWorkspaceKey = payload.workspaceKey;
      // Agent 关闭发生在其他 workspace 时，直接改写那个 workspace 的记忆桶并返回；
      // 不能只查当前 active 桶，否则原 workspace 会留下 main 侧已不存在的 tab。
      // 路由只用 workspaceKey，不再按 session 过滤：main 已判定关闭，所有 task 的壳都应收敛。
      if (targetWorkspaceKey && targetWorkspaceKey !== activeSidePaneMemoryKeyRef.current) {
        const stored = readTaskSidePaneMemoryState(targetWorkspaceKey);
        const targetId = findTargetId(stored.sidePaneState);
        if (!targetId) return;
        const nextState = closeSidePaneTab(stored.sidePaneState, targetId);
        saveTaskSidePaneMemoryState(targetWorkspaceKey, {
          sidePaneState: nextState,
          isSidePaneCollapsed: stored.isSidePaneCollapsed,
        });
        return;
      }

      commitSidePaneState((current) => {
        const targetId = findTargetId(current);
        if (!targetId) return current;
        return closeSidePaneTabForScope(current, targetId, currentSidePaneScope());
      });
    });
  }, [commitSidePaneState, currentSidePaneScope, isDesktop, platform]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewSuspend) return;
    return platform.onBrowserViewSuspend((payload) => {
      commitSidePaneState((current) => {
        const target = current?.tabs.find(
          (tab) =>
            ((tab.type === "browser-use" && tab.tabId === payload.tabId) ||
              (tab.type === "browser" && tab.id === payload.tabId)) &&
            tab.workspaceKey === payload.workspaceKey &&
            (tab.remoteSessionId ?? "") === (payload.remoteSessionId ?? "") &&
            (tab.type === "browser-use"
              ? tab.sessionId === payload.sessionId
              : (tab.ownerTaskId ?? "unscoped") === payload.sessionId),
        );
        if (!target) return current;
        return applyBrowserTabResidencyEvent(current, payload);
      });
    });
  }, [commitSidePaneState, isDesktop, platform]);

  useEffect(() => {
    if (!isDesktop || !platform?.onBrowserViewRestore) return;
    return platform.onBrowserViewRestore((payload) => {
      commitSidePaneState((current) => applyBrowserTabResidencyEvent(current, payload));
    });
  }, [commitSidePaneState, isDesktop, platform]);

  // Git 开关在 Office 模式下不新建，但允许关闭已存在的 Git tab；
  // 关闭当前 Git tab 时不展开面板，避免「关了又弹出来」。
  const handleToggleGit = useCallback(() => {
    commitOpenedSidePaneState((current) => {
      if (isOfficeMode && !current?.tabs.some((tab) => tab.type === "git")) return current;
      // 判定必须看「当前激活项」，而不是「是否存在 git tab」；
      // 否则在 Git 后台时点切换会误判为关闭并跳过展开。
      const closingActiveGit = getActiveSidePaneTab(current)?.type === "git";
      const next = toggleGitSidePane(current);
      if (!closingActiveGit) {
        revealSidePaneForCurrentOwner();
      }
      const activeTab = getActiveSidePaneTab(next);
      logger.info(
        `[App] 切换右侧面板 mode=${activeTab?.type ?? "none"} workspace=${workspaceAbsPath} tabs=${next?.tabs.length ?? 0}`,
      );
      return next;
    });
  }, [isOfficeMode, commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath]);

  // 打开（而非切换）Git 用于文件变更查找：已在 Git tab 时不能把它关掉；
  // 因此这里用 activateGitSidePane 并强制展开。
  const handleOpenGit = useCallback(() => {
    commitOpenedSidePaneState((current) => {
      if (isOfficeMode && !current?.tabs.some((tab) => tab.type === "git")) return current;
      const next = activateGitSidePane(current);
      // 文件变更查找只需要“确保 Git 面板打开”，不能复用 toggle。
      // 如果当前已经在 Git tab 上，toggle 会把它关掉，导致切到文件变更范围反而看不到内容。
      revealSidePaneForCurrentOwner();
      logger.info(
        `[App] 打开右侧面板 mode=git workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [isOfficeMode, commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath]);

  // Treemapping 已从侧边栏隐藏，但保留回调形状兼容旧消息链路；
  // 这里只记日志不建 tab，防止 header 或旧入口绕过菜单隐藏。
  const handleOpenTreemapping = useCallback(
    (source?: TreemappingSidePaneTab["source"]) => {
      // Treemapping 功能当前需要从侧边栏隐藏。保留回调形状给消息链路兼容，
      // 但不再创建 side pane tab，避免 header 或旧入口绕过菜单隐藏。
      logger.debug(
        `[App] 已隐藏 treemapping 侧边栏入口 workspace=${workspaceAbsPath} source=${source?.kind ?? "current"}`,
      );
    },
    [workspaceAbsPath],
  );

  // 白板先建 board 再开 tab：board 是持久实体，tab 只是视图；
  // 先开 tab 后建 board 会出现短暂的空白板引用。
  // 创建时带上 workspaceIdentity，保证远程与本地同名目录不共板。
  const handleOpenWhiteboard = useCallback(() => {
    const board = useWhiteboardStore.getState().createBoard({
      defaultNamePrefix: defaultWhiteboardNamePrefix,
      workspaceIdentity,
      workspacePath: workspaceAbsPath,
    });
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const next = openWhiteboardSidePane(current, {
        boardId: board.id,
        title: board.name,
      });
      logger.info(
        `[App] 打开右侧面板 mode=whiteboard workspace=${workspaceAbsPath} board=${board.id} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [
    commitOpenedSidePaneState,
    defaultWhiteboardNamePrefix,
    revealSidePaneForCurrentOwner,
    workspaceAbsPath,
    workspaceIdentity,
  ]);

  // new-tab 是启动器而非内容页；后续从它启动的工具会原位替换它。
  const handleOpenNewSidePaneTab = useCallback(() => {
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState(activateNewTabSidePane);
  }, [commitOpenedSidePaneState, revealSidePaneForCurrentOwner]);

  // 插件市场保留返回入口，commitOpenedSidePaneState 不会把它当作可替换的启动器。
  const handleOpenPluginMarket = useCallback(() => {
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState(activatePluginMarketSidePane);
  }, [commitOpenedSidePaneState, revealSidePaneForCurrentOwner]);

  // 开发者工具是单例内容页，重复打开只激活，不叠加 tab。
  const handleOpenDeveloperTools = useCallback(() => {
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const next = activateDeveloperToolsSidePane(current);
      logger.info(
        `[App] 打开右侧面板 mode=developer-tools workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath]);

  // 新建终端 tab 时标题去重基于当前状态，不能用 ref 快照替代；
  // Office 模式直接返回，连 cwd 都不解析。
  // remoteSessionId 透传给 PTY 创建，缺失时按本地终端处理。
  const handleOpenTerminalTab = useCallback(() => {
    if (isOfficeMode) return;
    revealSidePaneForCurrentOwner();
    commitOpenedSidePaneState((current) => {
      const title = createTerminalSidePaneTitle(current, workspaceAbsPath);
      const next = openTerminalSidePane(current, {
        title,
        cwd: workspaceAbsPath,
        remoteSessionId: workspaceRemoteSessionId,
      });
      logger.info(
        `[App] 新建右侧终端 tab=${title} workspace=${workspaceAbsPath} tabs=${next.tabs.length}`,
      );
      return next;
    });
  }, [
    isOfficeMode,
    commitOpenedSidePaneState,
    revealSidePaneForCurrentOwner,
    workspaceAbsPath,
    workspaceRemoteSessionId,
  ]);

  // 模型轨迹必须有 taskId，空值直接返回，避免打开一个无法加载的空面板；
  // 该入口由 useModelTrajectoryOpenBridge 按 workspaceKey 触发。
  const handleOpenModelTrajectory = useCallback(
    (params: { taskId: string; title?: string | null }) => {
      if (!params.taskId) {
        return;
      }
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openModelTrajectorySidePane(current, params);
        logger.info(
          `[App] 打开右侧面板 mode=model-trajectory workspace=${workspaceAbsPath} taskId=${params.taskId} tabs=${next.tabs.length}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner, workspaceAbsPath],
  );

  // 后台 Bash 面板按 request 内的会话标识复用，不在这里补齐 scope。
  const handleOpenBackgroundBash = useCallback(
    (request: OpenBackgroundBashSideTabRequest) => {
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => openBackgroundBashSidePane(current, request));
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  // 子智能体 tab 的 workspaceKey 取请求内的 identity 优先值，而不是当前 UI 的 key；
  // rootSessionId 缺失时回落到 parentSessionId，保证「按根会话记住上次 tab」可用。
  // scope 字段按存在性展开，不写 undefined，避免序列化后出现空键。
  const handleOpenSubagentSession = useCallback(
    (request: OpenScopedSubagentSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      const rootSessionId = request.rootSessionId ?? request.parentSessionId;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openSubagentSessionSidePane(current, {
          workspaceKey,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
          rootSessionId,
          parentSessionId: request.parentSessionId,
          childSessionId: request.childSessionId,
          subagentType: request.subagentType,
          title: request.title,
        });
        lastActiveSubagentTabByRootRef.current.set(rootSessionId, next.activeTabId);
        logger.debug(
          `[App] 打开子智能体右侧 tab parent=${request.parentSessionId} child=${request.childSessionId} workspace=${workspaceKey}`,
        );
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  // 目录页与子会话页共享 rootSessionId 记录，保证返回时定位到同一入口。
  const handleOpenSubagentDirectory = useCallback(
    (request: OpenScopedSubagentDirectorySideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      const rootSessionId = request.rootSessionId ?? request.parentSessionId;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const next = openSubagentDirectorySidePane(current, {
          workspaceKey,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
          rootSessionId,
          parentSessionId: request.parentSessionId,
        });
        lastActiveSubagentTabByRootRef.current.set(rootSessionId, next.activeTabId);
        return next;
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  // 投影清理走 commitSidePaneState：失效 tab 不进最近关闭列表，也不触发展开。
  const handleSyncSubagentSessionTabs = useCallback(
    (request: import("@/lib/workspaceSidePane.js").SyncSubagentSessionTabsRequest) => {
      // 分支 edit/retry 的失效 tab 属于投影清理，不进入“最近关闭”。
      commitSidePaneState((current) => syncSubagentSessionSidePaneTabs(current, request));
    },
    [commitSidePaneState],
  );

  // replace 语义：同一父会话下被替换的子会话必须先关闭，再打开新 tab；
  // 不先关会留下两个指向同一 childSessionId 的 tab，且旧的 runtime 不会释放。
  // workspaceKey 以请求内 identity 优先，保证跨 workspace 框选不串桶。
  const handleOpenSelectionSideChat = useCallback(
    (request: OpenSelectionSideChatRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) => {
        const staleTab = request.replacesChildSessionId
          ? current?.tabs.find(
              (tab) =>
                tab.type === "selection-side-chat" &&
                tab.workspaceKey === workspaceKey &&
                tab.parentSessionId === request.parentSessionId &&
                tab.childSessionId === request.replacesChildSessionId,
            )
          : undefined;
        const withoutStale = staleTab ? closeSidePaneTab(current, staleTab.id) : current;
        return openSelectionSideChatPane(withoutStale, {
          ...request,
          workspaceKey,
        });
      });
      logger.debug("[App] 打开框选副屏会话", {
        childSessionId: request.childSessionId,
        parentSessionId: request.parentSessionId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  // 计划详情按 toolCallId 去重，同一工具调用重复点击只激活。
  const handleOpenPlanDetail = useCallback(
    (request: OpenScopedPlanDetailSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) =>
        openPlanDetailSidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] 打开计划详情右侧 tab", {
        parentSessionId: request.parentSessionId,
        toolCallId: request.toolCallId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  // 插件 UI tab 由插件 id + 工具调用定位，打开前必须已完成 scope 归一。
  const handleOpenPluginUi = useCallback(
    (request: OpenPluginUiSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      revealSidePaneForCurrentOwner();
      commitOpenedSidePaneState((current) =>
        openPluginUiSidePane(current, { ...request, workspaceKey }),
      );
      logger.debug("[App] 打开插件 UI 右侧 tab", {
        parentSessionId: request.parentSessionId,
        toolCallId: request.toolCallId,
        pluginId: request.pluginId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState, revealSidePaneForCurrentOwner],
  );

  // 配置后的原地替换不算一次新打开：侧栏保持原折叠态；
  // 首次打开才展开，避免用户收起后被配置动作重新拉开。
  const handleOpenWorkflowRun = useCallback(
    (request: OpenScopedWorkflowRunSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      // 「配置」之后的原地替换不是一次打开：收起的侧栏保持收起。
      const replaceRunId = request.replaceRunId;
      // 这里用 setSidePaneCollapsed 而不是 revealSidePaneForCurrentOwner：
      // 工作流打开是系统动作，不应覆盖用户按 owner 记录的折叠偏好。
      // replace 路径必须完全不动折叠态。
      if (replaceRunId === undefined) setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        replaceRunId === undefined
          ? openWorkflowRunSidePane(current, { ...request, workspaceKey })
          : replaceWorkflowRunSidePane(current, { ...request, workspaceKey, replaceRunId }),
      );
      logger.debug("[App] 打开工作流运行详情右侧 tab", {
        parentSessionId: request.parentSessionId,
        runId: request.runId,
        toolCallId: request.toolCallId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  // 目录页属于用户主动导航，直接展开且不写偏好。
  const handleOpenWorkflowRunDirectory = useCallback(
    (request: OpenScopedWorkflowRunDirectorySideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowRunDirectorySidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] 打开工作流运行目录右侧 tab", {
        parentSessionId: request.parentSessionId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  // actor 会话页同样直接展开；它是运行详情下钻，不改变 owner 偏好。
  const handleOpenWorkflowActorSession = useCallback(
    (request: OpenScopedWorkflowActorSessionSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowActorSessionSidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] 打开工作流 actor 会话右侧 tab", {
        actorSessionId: request.actorSessionId,
        parentSessionId: request.parentSessionId,
        runId: request.runId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  // 工作流工作区页按 phaseId + runId 定位，展开行为与其他工作流页一致。
  const handleOpenWorkflowWorkspace = useCallback(
    (request: OpenScopedWorkflowWorkspaceSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openWorkflowWorkspaceSidePane(current, {
          ...request,
          workspaceKey,
        }),
      );
      logger.debug("[App] 打开工作流工作区右侧 tab", {
        parentSessionId: request.parentSessionId,
        phaseId: request.phaseId,
        runId: request.runId,
        workspaceKey,
      });
    },
    [commitOpenedSidePaneState],
  );

  /**
   * 按 URL 复用的 browser tab（html 产物直开的落点）。
   *
   * 与 `handleOpenBrowserUrl` 有三条区别：
   * ① 落点按 URL 认领而不是每次新开；② 命中已有 tab 时**仍然**发一次导航请求 —— webview
   * 停在旧字节上，`initialUrl` 又没变，挂载时那次导航不会再跑
   * （UnifiedBrowserView 的 `lastAppliedInitialUrlRef` 按 URL 去重），v2 就永远显示不出来；
   * ③ 归属由调用方给定，且**恒激活**——这条路径只由用户点击产物触发，没有
   * `isCurrentOwner` 那种后台挂载的情形（详见下面 ownerTaskId 处的注释）。
   */
  // INV-18：按 URL 复用 browser tab，但命中后仍然下发一次导航请求；
  // webview 的 lastAppliedInitialUrlRef 会按 URL 去重，不发请求就永远显示旧字节。
  // 归属由调用方给定并恒激活；这条路径只由用户点击产物触发，没有后台挂载。
  const openFileUrlInBrowserSidePane = useCallback(
    (params: { url: string; ownerTaskId: string; workspaceKey: string }) => {
      const state = latestSidePaneMemoryRef.current.sidePaneState;
      const existing = findBrowserSidePaneTabByUrl(state, {
        initialUrl: params.url,
        ownerTaskId: params.ownerTaskId,
        workspaceKey: params.workspaceKey,
      });
      const targetTabId = existing?.id ?? `browser:${createUuid()}`;
      // 即使 tab 是复用的，也必须发新 requestId；
      // 复用旧 id 会被 webview 的幂等判断吞掉。
      setBrowserNavigationRequest({ id: createUuid(), targetTabId, url: params.url });
      // 与产物 tab 一样只置当前折叠态，不落盘偏好：归属写的是 params.ownerTaskId，
      // 而 revealSidePaneForCurrentOwner 会把 false 记在**当前** owner 名下——中枢那条
      // 路径上两者还不是同一个人。
      setIsSidePaneCollapsed(false);
      commitOpenedSidePaneState((current) =>
        openOrActivateBrowserSidePaneByUrl(current, {
          initialUrl: params.url,
          tabId: targetTabId,
          // 归属显式冻结，不靠 stampSidePaneTabsOwnership 盖当前 owner：中枢的产物 chip
          // 先 handleSelectTaskInChat 再 handleOpenWorkflowArtifact，同一个同步块里
          // sidePaneOwnerIdRef 还停在上一条会话上。browser tab 的可见性按 ownerTaskId 收窄
          // （isSidePaneTabVisibleInScope 的默认分支），盖错了这个 tab 切换落定后就再也看不见。
          // 产物 tab 不怕这一手，是因为它按 parentSessionId 收窄。
          ownerTaskId: params.ownerTaskId,
          workspaceKey: params.workspaceKey,
        }),
      );
      return targetTabId;
    },
    [commitOpenedSidePaneState],
  );

  /**
   * 产物点击的**唯一**落点裁决处：html 且开得起内嵌浏览器就直接开页面，其余一律开产物 tab。
   *
   * 直开缺的那一段是 `sourcePath`：run 侧板带得到（它已经合过 journal），药丸摘要刻意不带
   * （状态帧体积，见 `workflowRunArtifactSummarySchema`）。缺席时这里补查一次 journal。
   * 查询失败、老 CLI 没有这条查询、产物根本没有出处，全部退回产物 tab —— 点击绝不落空。
   */
  // 产物点击的唯一落点裁决：html 且开得起内嵌浏览器 → 页面，其余 → 产物 tab；
  // 查询出处失败、老 CLI 无接口、无 sourcePath 全部退回产物 tab，点击绝不落空。
  // sourcePath 是工作区相对路径，拼 workspacePath 后才是本机真实位置。
  const handleOpenWorkflowArtifact = useCallback(
    (request: OpenScopedWorkflowArtifactSideTabRequest) => {
      const workspaceKey = request.workspaceIdentity?.trim() || request.workspacePath;
      // 退回产物 tab 时同样展开面板；这是用户主动点击，不属于系统后台动作。
      const openArtifactTab = () => {
        setIsSidePaneCollapsed(false);
        commitOpenedSidePaneState((current) =>
          openWorkflowArtifactSidePane(current, {
            ...request,
            workspaceKey,
          }),
        );
        logger.debug("[App] 打开工作流产物右侧 tab", {
          artifactId: request.artifactId,
          parentSessionId: request.parentSessionId,
          runId: request.runId,
          workspaceKey,
        });
      };

      if (
        !shouldOpenWorkflowArtifactInBrowser({
          contentType: request.contentType,
          supportsEmbeddedBrowser,
          workspaceIdentity: request.workspaceIdentity,
          remoteSessionId: request.remoteSessionId,
        })
      ) {
        openArtifactTab();
        return;
      }

      // ownerTaskId 用 parentSessionId：产物属于该会话，而不是当前 UI owner；
      // 冻结错 owner 会让 tab 在切换落定后不可见。
      // URL 必须经 toFileUrl，手拼 file:// 会在 Windows 盘符与空格上出错。
      const openInBrowser = (sourcePath: string) => {
        // 工作区相对的 sourcePath 拼上 workspacePath 才是本机真实位置；与产物卡上
        // 「在浏览器中打开」走同一条路径（WorkflowArtifactSidePane 的 localSourcePath）。
        const url = toFileUrl(joinFilePath(request.workspacePath, sourcePath));
        const tabId = openFileUrlInBrowserSidePane({
          url,
          ownerTaskId: request.parentSessionId,
          workspaceKey,
        });
        logger.debug("[App] html 产物直接打开浏览器 tab", {
          artifactId: request.artifactId,
          parentSessionId: request.parentSessionId,
          runId: request.runId,
          tabId,
          workspaceKey,
        });
      };

      const knownSourcePath = request.sourcePath?.trim();
      if (knownSourcePath) {
        openInBrowser(knownSourcePath);
        return;
      }

      // 异步补查用 void 显式忽略 Promise，异常全部在内部捕获；
      // 两个失败分支都走 openArtifactTab，保证不会出现「点了没反应」。
      // 该请求只对本地 workspace 发起（判定阶段已排除远程）。
      void (async () => {
        try {
          // 判据已经保证是本地 workspace（无 workspaceIdentity / remoteSessionId），
          // 这里只带 workspacePath。
          const result = await zcodeAgentService.conversationWorkflowRunArtifactsV4({
            workspacePath: request.workspacePath,
            sessionId: request.parentSessionId,
            runId: request.runId,
          });
          const sourcePath = result.artifacts
            .find((artifact) => artifact.id === request.artifactId)
            ?.sourcePath?.trim();
          // 没有工作区出处时退回产物 tab，不构造一个空 URL。
          if (!sourcePath) {
            logger.debug("[App] html 产物没有工作区出处，退回产物 tab", {
              artifactId: request.artifactId,
              runId: request.runId,
            });
            openArtifactTab();
            return;
          }
          openInBrowser(sourcePath);
        } catch (error) {
          // 查询失败按可恢复处理：warn 后仍打开产物 tab；
          // 不要把异常抛到点击链路，否则会中断整条消息交互。
          logger.warn("[App] 查产物出处失败，退回产物 tab", {
            artifactId: request.artifactId,
            error: error instanceof Error ? error.message : String(error),
            runId: request.runId,
          });
          openArtifactTab();
        }
      })();
    },
    [
      commitOpenedSidePaneState,
      openFileUrlInBrowserSidePane,
      supportsEmbeddedBrowser,
      zcodeAgentService,
    ],
  );

  // 关闭框选副屏要同时清理三处：本地选择状态、引用作用域、远端 session；
  // 少清任何一处都会让后续框选复用到一个已关闭的会话。
  // sessionNotFound 视为已关闭，不记 warn，避免重连期刷日志。
  const closeSelectionSideChatRuntime = useCallback(
    (tab: Extract<WorkspaceSidePaneTab, { type: "selection-side-chat" }>) => {
      clearSelectionSideChat(tab.childSessionId);
      clearConversationSelectionReferenceScope(tab.childSessionId, tab.workspaceKey);
      void zcodeSessionService
        .closeSession({
          workspacePath: tab.workspacePath,
          ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
          sessionId: tab.childSessionId,
        })
        .catch((error) => {
          // 错误用字符串包含判断是既有协议约定，改成错误码需要同时改 CLI。
          if (String(error).includes("sessionNotFound")) return;
          logger.warn("[App] 关闭框选副屏 runtime 失败", {
            childSessionId: tab.childSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [zcodeSessionService],
  );

  useEffect(() => {
    const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
    // INV-14：父任务结束事件只处理本 workspace，再清理其框选副屏；
    // 先清理 runtime 再移除 tab，保证没有 tab 指向已销毁会话。
    // 该订阅在 workspace 变化时重建，事件按 identity 键过滤。
    return subscribeTaskLifecycle((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      clearConversationSelectionReferenceScope(event.taskId, event.workspaceKey);
      // 只收集 parentSessionId 命中的 selection-side-chat tab；
      // 其他类型的子会话不随父任务结束，避免误杀用户仍在看的页面。
      const closingTabs =
        latestSidePaneMemoryRef.current.sidePaneState?.tabs.filter(
          (tab): tab is Extract<WorkspaceSidePaneTab, { type: "selection-side-chat" }> =>
            tab.type === "selection-side-chat" && tab.parentSessionId === event.taskId,
        ) ?? [];
      if (closingTabs.length === 0) return;

      for (const tab of closingTabs) closeSelectionSideChatRuntime(tab);
      const closingIds = new Set(closingTabs.map((tab) => tab.id));
      commitSidePaneState((current) => {
        if (!current) return current;
        let next: WorkspaceSidePaneState | null = current;
        for (const tabId of closingIds) {
          next = closeSidePaneTabForScope(next, tabId, currentSidePaneScope());
        }
        return next;
      });
      logger.info("[App] 父任务结束，清理框选副屏会话", {
        event: event.type,
        parentSessionId: event.taskId,
        workspaceKey,
      });
    });
  }, [
    currentSidePaneScope,
    closeSelectionSideChatRuntime,
    commitSidePaneState,
    workspaceAbsPath,
    workspaceIdentity,
  ]);

  // 订阅“打开模型调用轨迹”请求：菜单深处通过单例 store 发起，这里按 workspaceKey 匹配后消费。
  // 请求本身不带 scope，由 useModelTrajectoryOpenBridge 按传入的 key 过滤，
  // key 用 identity 优先值，与面板 scope 同源。
  useModelTrajectoryOpenBridge(
    workspaceIdentity?.trim() || workspaceAbsPath,
    handleOpenModelTrajectory,
  );

  // 底部终端切换在 Office 模式下只允许关闭，不允许打开；
  // 用函数式更新保证连续快捷键不会读到旧值。
  const handleToggleTerminal = useCallback(() => {
    setIsTerminalOpen((open) => {
      if (isOfficeMode && !open) return open;
      const nextOpen = !open;
      logger.info("[App] 切换底部终端面板", {
        open: nextOpen,
        workspace: workspaceAbsPath,
      });
      return nextOpen;
    });
  }, [isOfficeMode, workspaceAbsPath]);

  // 左侧栏显隐是纯本地 UI，不影响面板记忆与 scope。
  const handleToggleSidebar = useCallback(() => {
    setIsSidebarVisible((visible) => !visible);
  }, []);

  // 用户点击展开/收起时必须同时写偏好，否则重启后状态回退；
  // 展开时在同一次交互内补建 new-tab，避免先渲染特殊空态再被 effect 纠正。
  // 读取当前折叠态用 canonical ref，不能用渲染闭包。
  const handleToggleSidePaneCollapse = useCallback(() => {
    const nextCollapsed = !latestSidePaneMemoryRef.current.isSidePaneCollapsed;
    setIsSidePaneCollapsed(nextCollapsed);
    saveTaskSidePaneCollapsedPreference(
      activeSidePaneMemoryKeyRef.current,
      sidePaneOwnerIdRef.current,
      nextCollapsed,
    );
    // 与显隐在同一交互内提交，避免先显示特殊空态再由 effect 补建标签。
    // 只在展开时补建启动器；收起时补建会立刻产生一个可见 tab，导致面板关不掉。
    if (!nextCollapsed)
      commitSidePaneState((current) => ensureSidePaneTab(current, currentSidePaneScope()));
    logger.info(
      `[App] ${nextCollapsed ? "收起" : "展开"}右侧面板 workspace=${workspaceAbsPath} tabs=${latestSidePaneMemoryRef.current.sidePaneState?.tabs.length ?? 0}`,
    );
  }, [commitSidePaneState, currentSidePaneScope, setIsSidePaneCollapsed, workspaceAbsPath]);

  // 关闭代码查看器只移除该类型 tab，不影响同 scope 的其他面板。
  const handleCloseCodeViewer = useCallback(() => {
    logger.info(`[App] 关闭右侧面板 mode=code-viewer workspace=${workspaceAbsPath}`);
    commitSidePaneState((current) => {
      const next = closeCodeViewerSidePane(current);
      return next;
    });
  }, [commitSidePaneState, currentSidePaneScope, setIsSidePaneCollapsed, workspaceAbsPath]);

  // 关闭 Git 面板同理；若 Git 是最后一个可见 tab，commit 会自动收起。
  const handleCloseGit = useCallback(() => {
    logger.info(`[App] 关闭右侧面板 mode=git workspace=${workspaceAbsPath}`);
    commitSidePaneState((current) => {
      const next = closeGitSidePane(current);
      return next;
    });
  }, [commitSidePaneState, currentSidePaneScope, setIsSidePaneCollapsed, workspaceAbsPath]);

  // 激活 suspended 的 browser tab 前先请求 main 恢复常驻，再切激活项；
  // INV-09：human tab 兜底 workspaceRemoteSessionId，browser-use 不兜底，两侧必须同源。
  // 恢复失败只记 warn，仍允许切换到该 tab（UI 会显示恢复失败态）。
  const handleActivateSidePaneTab = useCallback(
    (tabId: string) => {
      const tab = latestSidePaneMemoryRef.current.sidePaneState?.tabs.find(
        (candidate) => candidate.id === tabId,
      );
      if (
        (tab?.type === "browser" || tab?.type === "browser-use") &&
        tab.residency === "suspended"
      ) {
        // browser-use 的 main 侧标识是 tabId，human tab 用内部 id；
        // 混用会让 main 找不到目标并拒绝恢复。
        const logicalTabId = tab.type === "browser-use" ? tab.tabId : tab.id;
        // human tab 的 attach 侧用 `tab.remoteSessionId ?? workspaceRemoteSessionId` 兜底冻结 owner，
        // 这里必须同源，否则创建时没冻结该字段的存量 tab 会 scope 失配、点开永远恢复不了。
        // browser-use 的 attach 侧没有这层兜底，跟着加反而会造成反向失配，故按类型区分。
        // INV-09 的落点之一：browser-use 只用自己的冻结值，human tab 才兜底当前 workspace 值；
        // 给 browser-use 加兜底反而会造成反向 scope 失配。
        // 改动这里必须同步 closeBrowserTabsWithAuthority 内的同名计算。
        const scopedRemoteSessionId =
          tab.type === "browser-use"
            ? tab.remoteSessionId
            : (tab.remoteSessionId ?? workspaceRemoteSessionId);
        void platform
          ?.browserViewEnsureResident?.({
            tabId: logicalTabId,
            workspaceKey: tab.workspaceKey ?? activeWorkspaceKeyRef.current,
            ...(scopedRemoteSessionId ? { remoteSessionId: scopedRemoteSessionId } : {}),
            sessionId: tab.type === "browser-use" ? tab.sessionId : (tab.ownerTaskId ?? "unscoped"),
          })
          .catch((error) => {
            logger.warn("[App] 激活 suspended Browser tab 失败", {
              error: error instanceof Error ? error.message : String(error),
              tabId: logicalTabId,
            });
          });
      }
      commitSidePaneState((current) => {
        const target = current?.tabs.find((candidate) => candidate.id === tabId);
        if (target?.type === "subagent-session" || target?.type === "subagent-directory") {
          lastActiveSubagentTabByRootRef.current.set(target.rootSessionId, target.id);
        }
        return setActiveSidePaneTab(current, tabId);
      });
    },
    [commitSidePaneState, platform, workspaceRemoteSessionId],
  );

  // 排序只改 tabs 顺序，不改变激活项与折叠态。
  const handleReorderSidePaneTab = useCallback(
    (activeTabId: string, overTabId: string) => {
      commitSidePaneState((current) => reorderSidePaneTab(current, activeTabId, overTabId));
    },
    [commitSidePaneState],
  );

  // INV-11：不可恢复的 tab（框选副屏、browser-use、new-tab）不进入最近关闭；
  // 同一批关闭按时间倒序合并，并对已有同 id 项去重后截断到上限。
  // 记录只保存 tab 快照，不保存任何 runtime 句柄。
  const rememberClosedSidePaneTabs = useCallback((tabs: WorkspaceSidePaneTab[]) => {
    const restorableTabs = tabs.filter(
      (tab) =>
        tab.type !== "selection-side-chat" && tab.type !== "browser-use" && tab.type !== "new-tab",
    );
    if (restorableTabs.length === 0) {
      return;
    }

    const closedAt = Date.now();
    setAllRecentClosedSidePaneTabs((current) => {
      const closingIds = new Set(restorableTabs.map((tab) => tab.id));
      return [
        ...restorableTabs.map((tab) => ({ tab, closedAt })),
        ...current.filter((item) => !closingIds.has(item.tab.id)),
      ].slice(0, RECENT_CLOSED_SIDE_PANE_TAB_LIMIT);
    });
  }, []);

  // INV-08：D 桌面端必须先由 main 删除 logical tab 与恢复快照，renderer 才移除 UI 壳；
  // bridge 缺失时返回 false，调用方放弃关闭，避免重启后 tab 复活。
  // Web 端没有 guest authority，保持本地关闭语义并直接返回 true。
  const closeBrowserTabsWithAuthority = useCallback(
    async (tabs: readonly WorkspaceSidePaneTab[]): Promise<boolean> => {
      const browserTabs = tabs.filter(
        (tab) => tab.type === "browser" || tab.type === "browser-use",
      );
      if (browserTabs.length === 0) return true;
      // 能力缺失分两种：桌面必须失败关闭（返回 false），Web 允许本地关闭；
      // 用 isDesktop 而不是 supportsEmbeddedBrowser 判定，因为 Web 也可能显式关闭了内嵌浏览器。
      if (!platform?.browserViewCloseTab) {
        // Desktop 必须由 main 先删除 logical tab/recovery snapshot；bridge 缺失时不能只删 UI 壳，
        // 否则重启后已关闭 tab 会复活。Web 端没有 guest authority，保持原本的本地关闭语义。
        if (isDesktop) {
          logger.warn("[App] 关闭 Browser tab 时缺少 main authority");
          return false;
        }
        return true;
      }
      try {
        await Promise.all(
          browserTabs.map((tab) => {
            // 与 attach 侧同源：human tab 兜底到 workspaceRemoteSessionId，browser-use 不兜底。
            // 不同源就会 scope 失配 → main 拒绝授权 → UI 壳永不移除 → tab 关不掉。
            const scopedRemoteSessionId =
              tab.type === "browser-use"
                ? tab.remoteSessionId
                : (tab.remoteSessionId ?? workspaceRemoteSessionId);
            // 关闭请求里的 scope 必须与 attach 侧完全同源，否则 main 拒绝授权，UI 壳永不移除；
            // sessionId 同样按 tab 类型取值，browser-use 用会话 id，human tab 用 owner。
            return platform.browserViewCloseTab!({
              tabId: tab.type === "browser-use" ? tab.tabId : tab.id,
              workspaceKey: tab.workspaceKey ?? activeWorkspaceKeyRef.current,
              ...(scopedRemoteSessionId ? { remoteSessionId: scopedRemoteSessionId } : {}),
              sessionId:
                tab.type === "browser-use" ? tab.sessionId : (tab.ownerTaskId ?? "unscoped"),
            });
          }),
        );
        return true;
      } catch (error) {
        logger.warn("[App] 关闭 Browser tab 的 main authority 失败", {
          error: error instanceof Error ? error.message : String(error),
          tabIds: browserTabs.map((tab) => (tab.type === "browser-use" ? tab.tabId : tab.id)),
        });
        return false;
      }
    },
    [isDesktop, platform, workspaceRemoteSessionId],
  );

  // INV-10：点击瞬间冻结 scope，main 确认期间即使用户切走也写回原 workspace 的桶；
  // 关闭前先取得 browser authority，失败则整体放弃（不清 UI、不记最近关闭）。
  // 成功的 tab 才有资格释放 runtime 与进入最近关闭。
  const closeSelectedSidePaneTabs = useCallback(
    async (closingTabs: WorkspaceSidePaneTab[], preferredTabId?: string) => {
      if (closingTabs.length === 0) return;
      const scope = currentSidePaneScope();
      // authority 失败时不能「先关一半」：browser tab 与 terminal tab 可能混在同一批；
      // 整体放弃可保证 UI 与 main 侧状态一致。
      if (!(await closeBrowserTabsWithAuthority(closingTabs))) return;
      for (const tab of closingTabs) {
        if (tab.type === "selection-side-chat") closeSelectionSideChatRuntime(tab);
        // INV-13：terminal tab 关闭必须 release 模块级 registry；
        // registry 持有 PTY，只移除 UI tab 会留下孤儿进程常驻。
        // release 是幂等的，重复关闭不会抛错。
        if (tab.type === "terminal") sidePaneTerminalSessionRegistry.release(tab.id);
      }
      rememberClosedSidePaneTabs(closingTabs);
      const closingIds = closingTabs.map((tab) => tab.id);
      // Bug 原因：main 确认关闭期间可能切换对话/工作区或新建 tab。归属与关闭目标在点击时
      // 冻结，完成后写回原 registry；当前可见范围与活动标签则按完成时的 scope 解析。
      // 完成时已切走：读目标桶、改写、再落盘，不触碰当前 UI；
      // 若误走 live 提交，会把别的 workspace 的关闭结果写进当前面板。
      // preferredTabId 只在 owner 未变时生效，避免把旧任务的首选项带到新任务。
      if (scope.workspaceKey !== activeWorkspaceKeyRef.current) {
        const stored = readTaskSidePaneMemoryState(scope.workspaceKey);
        const next = closeSidePaneTabs(stored.sidePaneState, closingIds, scope, preferredTabId);
        saveTaskSidePaneMemoryState(scope.workspaceKey, {
          sidePaneState: next,
          isSidePaneCollapsed: stored.isSidePaneCollapsed,
        });
      } else {
        const liveScope = currentSidePaneScope();
        commitSidePaneState((current) =>
          closeSidePaneTabs(
            current,
            closingIds,
            liveScope,
            liveScope.ownerTaskId === scope.ownerTaskId
              ? (preferredTabId ??
                  (liveScope.ownerTaskId
                    ? lastActiveSubagentTabByRootRef.current.get(liveScope.ownerTaskId)
                    : null))
              : undefined,
          ),
        );
      }
      logger.info("[App] 关闭右侧面板标签", { tabIds: closingIds, ...scope });
    },
    [
      closeBrowserTabsWithAuthority,
      closeSelectionSideChatRuntime,
      commitSidePaneState,
      currentSidePaneScope,
      rememberClosedSidePaneTabs,
    ],
  );

  // 批量关闭的输入永远是「当前 scope 可见的 tab」，后台 tab 不参与；
  // 这保证 Cmd/Ctrl+W 不会误关其他任务的页面。
  const visibleSidePaneTabs = useCallback(
    () =>
      getVisibleSidePaneTabs(
        latestSidePaneMemoryRef.current.sidePaneState?.tabs ?? [],
        currentSidePaneScope(),
      ),
    [currentSidePaneScope],
  );

  // 关闭单个 tab 不指定 preferredTabId，激活项由关闭原语按可见列表回退。
  const handleCloseSidePaneTab = useCallback(
    (tabId: string) => {
      void closeSelectedSidePaneTabs(visibleSidePaneTabs().filter((tab) => tab.id === tabId));
    },
    [closeSelectedSidePaneTabs, visibleSidePaneTabs],
  );

  // 「关闭其他」要求目标 tab 当前可见，否则整体忽略；
  // preferredTabId 传目标 tab，保证关闭后仍停在用户右键的那一项。
  const handleCloseOtherSidePaneTabs = useCallback(
    (tabId: string) => {
      const tabs = visibleSidePaneTabs();
      if (!tabs.some((tab) => tab.id === tabId)) return;
      void closeSelectedSidePaneTabs(
        tabs.filter((tab) => tab.id !== tabId),
        tabId,
      );
    },
    [closeSelectedSidePaneTabs, visibleSidePaneTabs],
  );

  // 「全部关闭」只针对当前 scope；关闭末项后由 commit 自动收起面板。
  const handleCloseAllSidePaneTabs = useCallback(() => {
    void closeSelectedSidePaneTabs(visibleSidePaneTabs());
  }, [closeSelectedSidePaneTabs, visibleSidePaneTabs]);

  // 重开前校验 scope 与 Office 模式，不可见或已禁用的项直接忽略；
  // 重开前先展开面板，否则状态恢复了但用户看到折叠态，以为点击无效。
  const handleReopenClosedSidePaneTab = useCallback(
    (tabId: string) => {
      const item = allRecentClosedSidePaneTabs.find((entry) => entry.tab.id === tabId);
      if (
        !item ||
        !isSidePaneTabVisibleInScope(item.tab, currentSidePaneScope()) ||
        (isOfficeMode && (item.tab.type === "terminal" || item.tab.type === "git"))
      )
        return;

      // 交互说明：最近关闭列表里的 tab 被点回打开时，需要同步展开右侧面板。
      // 否则 tab 状态已经恢复，但用户看到的还是折叠态，会误以为点击没有生效。
      revealSidePaneForCurrentOwner();
      commitSidePaneState((sidePaneCurrent) => {
        // INV-12：browser tab 重开必须剥离 residency/residencyGeneration 并换新 id；
        // 旧 id 对应 main 已删除的 logical tab，直接复用会被恢复逻辑拒绝。
        // 其他类型 tab 保留原 id 与内容快照。
        let restoredTab = item.tab;
        if (item.tab.type === "browser") {
          const {
            residency: _residency,
            residencyGeneration: _residencyGeneration,
            ...browserTab
          } = item.tab;
          restoredTab = { ...browserTab, id: `browser:${createUuid()}` };
        }
        const next = restoreSidePaneTab(sidePaneCurrent, restoredTab);
        if (restoredTab.type === "subagent-session" || restoredTab.type === "subagent-directory") {
          lastActiveSubagentTabByRootRef.current.set(restoredTab.rootSessionId, restoredTab.id);
        }
        return next;
      });
      setAllRecentClosedSidePaneTabs((current) =>
        current.filter((entry) => entry.tab.id !== tabId),
      );
      logger.info(`[App] 重新打开最近关闭右侧面板 tab=${tabId} workspace=${workspaceAbsPath}`);
    },
    [
      isOfficeMode,
      allRecentClosedSidePaneTabs,
      currentSidePaneScope,
      commitSidePaneState,
      revealSidePaneForCurrentOwner,
      workspaceAbsPath,
    ],
  );

  // 按 id 对账清空，迟到的完成回调不会清掉新一次导航请求；
  // 用内容比较会吞掉「同一 URL 连续两次」的第二条。
  const handleBrowserNavigationRequestHandled = useCallback((requestId: string) => {
    setBrowserNavigationRequest((current) => (current?.id === requestId ? null : current));
  }, []);

  // title/favicon 必须按 tab id 写回；
  // 只存一份全局元数据会让后加载的页面覆盖其他 tab 标题。
  const handleBrowserPageMetadataChange = useCallback(
    (tabId: string, metadata: BrowserSidePaneMetadata) => {
      // 交互说明：Browser 的 title/favicon 来自 webview 事件，必须按 tab id 写回。
      // 多 Browser tab 共存时如果只存一份全局元数据，会导致后加载的页面覆盖其他 tab 标题。
      commitSidePaneState((current) => updateBrowserSidePaneTab(current, tabId, metadata));
    },
    [commitSidePaneState],
  );

  // 展示层过滤：当前 workspace + 当前 owner 可见，且 Office 模式下排除 terminal/git；
  // 菜单展示由 hideArchived 过滤，底层记录不变，切回普通模式后条目仍在。
  // 依赖只列过滤所需的字段，避免流式更新导致菜单重算。
  const recentClosedSidePaneTabs = useMemo(
    () =>
      allRecentClosedSidePaneTabs.filter(
        (item) =>
          isSidePaneTabVisibleInScope(item.tab, {
            workspaceKey: activeWorkspaceKey,
            ownerTaskId: sidePaneOwnerId,
          }) &&
          (!isOfficeMode || (item.tab.type !== "terminal" && item.tab.type !== "git")),
      ),
    [activeWorkspaceKey, sidePaneOwnerId, allRecentClosedSidePaneTabs, isOfficeMode],
  );

  return {
    // 办公模式只隐藏新建入口；过滤面板状态会让已打开的终端和审查在切换时消失。
    // INV-16：返回值暴露全部已打开状态，Office 模式只隐藏新建入口；
    // 在这里过滤会让已打开的终端/审查在模式切换后凭空消失。
    isTerminalOpen,
    setIsTerminalOpen,
    sidePaneState,
    recentClosedSidePaneTabs,
    isSidePaneCollapsed,
    setIsSidePaneCollapsed,
    isSidebarVisible,
    browserNavigationRequest,
    setBrowserNavigationRequest,
    handleOpenFileManager,
    handleNavigateFileManager,
    // 回调
    handleOpenCodeViewer,
    handleOpenCodeViewers,
    handleOpenBrowserUrl,
    handleToggleBrowser,
    handleOpenBrowserTab,
    handleOpenBrowserPermissionSettings,
    handleToggleGit,
    handleOpenGit,
    handleOpenTreemapping,
    handleOpenWhiteboard,
    handleOpenDeveloperTools,
    handleOpenPluginMarket,
    handleOpenNewSidePaneTab,
    handleOpenTerminalTab,
    handleOpenModelTrajectory,
    handleOpenSubagentSession,
    handleOpenBackgroundBash,
    handleOpenSubagentDirectory,
    handleSyncSubagentSessionTabs,
    handleOpenSelectionSideChat,
    handleOpenPlanDetail,
    handleOpenPluginUi,
    handleOpenWorkflowRun,
    handleOpenWorkflowRunDirectory,
    handleOpenWorkflowActorSession,
    handleOpenWorkflowWorkspace,
    // 导出面保持扁平：调用方（App/Shell）只绑定 handler，不读取内部 ref；
    // 新增面板类型时必须同时补充 open/close/restore 三个入口，否则会出现只能开不能关的孤岛。
    handleOpenWorkflowArtifact,
    handleToggleTerminal,
    handleToggleSidebar,
    handleToggleSidePaneCollapse,
    handleCloseCodeViewer,
    handleCloseGit,
    handleActivateSidePaneTab,
    handleReorderSidePaneTab,
    handleCloseSidePaneTab,
    handleCloseOtherSidePaneTabs,
    // 关闭类导出统一为无返回值（内部 void promise），调用方不需要 await；
    // 需要感知失败（如 authority 缺失）的路径请用日志而不是返回值，因为 UI 不阻塞。
    handleCloseAllSidePaneTabs,
    // 重开入口必须与关闭入口成对导出，供菜单与 Cmd/Ctrl+Shift+T 复用；
    // 重开内部已完成 scope 校验，调用方不需要再过滤。
    // 它不会跨 workspace 恢复：列表按当前 scope 展示。
    handleReopenClosedSidePaneTab,
    // 这是 webview 与面板之间的完成握手：按 requestId 清空，迟到回调不会误清新请求；
    // 调用方必须在导航真正生效后调用，提前清空会导致同一请求被重复消费。
    // 该导出只服务于 Browser 面板，不要复用到其他 tab 类型。
    handleBrowserNavigationRequestHandled,
    handleBrowserPageMetadataChange,
  };
}
