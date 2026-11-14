// ==========================================================================
// 职责边界（useRootWorkspaceActions.ts）
// 做：
//   - 编排 Root 级 workspace 动作：新建任务、选项目、打开文件夹、退出登录、设置页返回。
//   - 解析新任务落点（显式 targetWorkspace 或 workbench 焦点），并维护导航序号。
// 不做：
//   - 不拥有项目与会话事实：项目归属来自 projectService，草稿来自 composerDraftStore。
//   - 不直接渲染 UI，也不管 modal 可见性；错误只写 workspaceActionError。
//   - 不在 Web 远程模式创建本地草稿：该分支整体交给 openMobileProjectDraft。
// 依赖：
//   - zcodeSessionStore 的 activeTaskId 与 draftFocusVersion 是导航有效性判据。
//   - tabStore 的 activeTabId 决定新任务是否还落在原 tab 上。
//   - remoteProjectOpener 持有最近一版 openRemoteProjectWorkspace，避免闭包失稳。
// 边界：
//   - 所有 await 之后都必须重跑 isCurrent，禁止用超时或重试掩盖失效。
//   - 目录准备失败时不得 addTab，也不得写草稿。
//   - 退出登录的 telemetry 只调度不等待，不能阻塞登出链路。
//
// INV 不变量表（18 条；破坏任一条会造成任务落到错误工作区或门禁失效）：
// INV-01 断言：新任务落点的 identity 缺省一律归一化为 null —— 守住它的位置：resolveNewTaskTargetFromRequest —— 改错故障：null 与 undefined 混用，按 path 误配草稿
// INV-02 断言：请求显式带 targetWorkspace 时不再询问 workbench 焦点 —— 守住它的位置：resolveNewTaskTargetFromRequest 首个分支 —— 改错故障：已保存工作流被当前焦点劫持
// INV-03 断言：navigationSequence 每次新建任务自增，旧序号立即失效 —— 守住它的位置：startNewTaskFromActiveWorkspace 开头 —— 改错故障：连续快捷键触发两次，两个任务都提交
// INV-04 断言：isCurrent 必须同时校验序号、originTab 与 originWorkspace 的两个版本号 —— 守住它的位置：isCurrent 闭包 —— 改错故障：用户切走后任务仍落到旧 tab
// INV-05 断言：requestOptions 必须在第一次 await 之前捕获 —— 守住它的位置：函数体第一段 —— 改错故障：await 后读到已被改写的活动草稿
// INV-06 断言：grouped 视图下 taskGroupId 只从已提交结构或草稿 owner 读取 —— 守住它的位置：readProjectSidebarView 分支 —— 改错故障：新任务被塞进错误分组
// INV-07 断言：hasExplicitProject 与 newTaskTarget 互斥地决定项目来源 —— 守住它的位置：两者先后计算处 —— 改错故障：显式项目被焦点覆盖，跨项目发起失效
// INV-08 断言：从 workbench 焦点继承项目时必须能反解 hostId —— 守住它的位置：newTaskTarget.workspaceIdentity 分支 —— 改错故障：远程身份缺 hostId 时按本地创建，项目丢失
// INV-09 断言：远程身份解析不出 projectId 要抛 project.remote-project-required —— 守住它的位置：hasExplicitProject 分支末尾 —— 改错故障：远程任务落到无项目草稿
// INV-10 断言：Web 远程模式只能走 openMobileProjectDraft —— 守住它的位置：web-remote-replayable 分支 —— 改错故障：旧 Root 写交接后的草稿，双写冲突
// INV-11 断言：pendingDraft 只在无 projectId 且 hostId 为 local 时创建 —— 守住它的位置：pendingDraft 常量 —— 改错故障：有项目的任务被绑定到待发送草稿
// INV-12 断言：prepareSession 必须收到 draftId 与 reuseDraft，省略会另建目录 —— 守住它的位置：prepareSession 入参展开 —— 改错故障：待发送草稿丢失工作区身份
// INV-13 断言：远程分支必须同时具备 workspaceIdentity 与 opener —— 守住它的位置：hostId 非 local 分支 —— 改错故障：远程导航静默跳过，停留在旧会话
// INV-14 断言：addTab 只在本地分支执行，远程由 opener 负责 —— 守住它的位置：hostId 判断 —— 改错故障：远程任务在本地开出一个空 tab
// INV-15 断言：startDraftInWorkspace 必须在目录准备成功之后调用 —— 守住它的位置：addTab 之后 —— 改错故障：目录失败仍写草稿，草稿指向不存在路径
// INV-16 断言：startDraftInWorkspace 内先 deactivateActiveGroup 再 startDraft —— 守住它的位置：desktop-continuous 分支 —— 改错故障：旧分组仍激活，历史会话被重新显示
// INV-17 断言：remoteProjectOpener 只在 layout effect 中更新 —— 守住它的位置：无依赖的 useLayoutEffect —— 改错故障：动作引用每轮变化，新建入口失稳
// INV-18 断言：handleLogout 顺序固定为 telemetry、设置快照、登出、回写设置、清展示态 —— 守住它的位置：handleLogout 主体 —— 改错故障：登出后仍显示旧 Provider 状态
import { stageV4ComposerDraftAttachments } from "@/v4/composer/composerDraftWorkspaceTransfer.js";
import { readProjectSidebarView } from "@/project-sidebar/index.js";
/* eslint-disable max-lines -- Root workspace action hook 集中编排项目、远程和 conversation 入口；合并期保持动作边界完整，后续按领域拆分。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  DesktopCommandIds,
  remoteHostIdFromWorkspaceIdentity,
  type AppSettings,
  type IPlatformService,
  type UserInfo,
  type ZCodeTaskClientMode,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type {
  CreateTaskOptions,
  CreateTaskRequest,
  RemoteConnectionOpenPreference,
} from "@/app-shell/types.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { resolveLogoutProviderFamilyDomain } from "@/lib/providerFamilyDomainSettings.js";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";
import { parseWslUncWorkspacePath } from "@/lib/wslUncWorkspace.js";
import { logger } from "@/logger.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import {
  resolveComposerScope,
  ensurePendingTaskDraft,
  bindPendingTaskDraft,
  rememberComposerWorkspaceScope,
  readComposerWorkspaceScope,
} from "@/v4/composer/composerDraftStore.js";
import { openFolderFromWorkspaceEntry } from "@/root/openWorkspaceFolderEntry.js";
import { useConversationWorkspaceActions } from "@/root/useConversationWorkspaceActions.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { notifyTaskNavigationCommitted } from "@/store/zcodeSessionStoreNavigation.js";
import { type TabStore, type TabStoreState } from "@/store/tabStore.js";
import type { RootProps } from "@/root/types.js";
import {
  hadPersistedPaneLayoutAtModuleLoad,
  INITIAL_PANE_LAYOUT,
  usePaneLayoutStore,
} from "@/v4/paneLayoutStore.js";
import { resolveWorkbenchNewTaskTarget } from "@/conversation-workspace-target/workbenchTarget.js";
import type { WorkbenchNewTaskTarget } from "@/conversation-workspace-target/workbenchTarget.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
} from "@/v4/composer/composerDraftStore.js";

/** 新任务落点：identity 缺省一律归一化为 null，供只读校验、focus/addTab 统一消费。 */
export interface NewTaskTargetResolution {
  workspacePath: string;
  workspaceIdentity: string | null;
}

/**
 * 解析新任务落点：请求显式带 targetWorkspace 时（跨项目发起已保存工作流）直接采用它，不再询问 workbench 焦点；
 * 否则惰性回退到 resolveWorkbenchNewTaskTarget。identity 缺省归一化为 null。
 */
// [契约] 新任务落点解析是纯函数：要么用显式 targetWorkspace，要么惰性调用 fallback。
// fallback 必须是惰性的，提前求值会读取尚未稳定的 workbench 焦点。
// identity 缺省统一归一化为 null，调用方不再区分 undefined。
// 若忽略显式 targetWorkspace，跨项目发起的已保存工作流会被当前 workbench 焦点覆盖。
export function resolveNewTaskTargetFromRequest(
  request: CreateTaskRequest | undefined,
  resolveFallback: () => WorkbenchNewTaskTarget | null,
): NewTaskTargetResolution | null {
  // [契约] 字符串形式的 request 只代表 provider，没有 targetWorkspace 可读。
  // 用 typeof 判断而不是真值判断：空对象同样没有目标工作区。
  // 不要在这里解构 request：两种联合类型会立刻收窄失败。
  // 改错后果：字符串 provider 请求被误判为带目标，落点解析抛错。
  const targetWorkspace =
    typeof request === "string" || !request ? undefined : request.targetWorkspace;
  if (targetWorkspace) {
    return {
      workspacePath: targetWorkspace.workspacePath,
      workspaceIdentity: targetWorkspace.workspaceIdentity ?? null,
    };
  }
  // [契约] 只有显式目标缺失时才调用 fallback，且只调用一次。
  // 返回 null 表示当前没有可用焦点，调用方必须按失败处理。
  // 不要在 fallback 里兜底到 activeWorkspacePath：那会掩盖焦点丢失。
  // 改错后果：焦点缺失时静默落到当前路径，任务归属错误。
  const fallback = resolveFallback();
  if (!fallback) {
    return null;
  }
  return {
    workspacePath: fallback.workspacePath,
    workspaceIdentity: fallback.workspaceIdentity ?? null,
  };
}

// [契约] hook 入参全部由 Root 注入，内部不读全局单例服务。
// workbenchGroupClientMode 默认 desktop-continuous，Web 必须显式覆盖。
// 新增入参要同步 Root 调用点与依赖数组，不能只加形参。
// 改错后果：Web 远程链路误用桌面分组语义，历史会话被激活。
export function useRootWorkspaceActions({
  intl,
  platform,
  services,
  tabStoreApi,
  addTab,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  supportsSettings,
  allowOpenWorkspace,
  preferDirectoryBrowser,
  openDirectoryBrowser,
  refreshProviderState,
  updateAppSettings,
  setOAuthError,
  setUser,
  onProviderFamilyDomainClearedAfterLogout,
  userId,
  onOpenRemoteConnection,
  openRemoteProjectWorkspace,
  openMobileProjectDraft,
  workbenchGroupClientMode = "desktop-continuous",
}: {
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  platform: IPlatformService;
  services: IServiceAccessor;
  tabStoreApi: TabStore;
  addTab: TabStoreState["addTab"];
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  supportsSettings: boolean;
  allowOpenWorkspace: NonNullable<RootProps["allowOpenWorkspace"]>;
  preferDirectoryBrowser: boolean;
  openDirectoryBrowser?: () => void;
  refreshProviderState: () => Promise<void>;
  updateAppSettings: (patch: Partial<AppSettings>) => Promise<void>;
  setOAuthError: (error: string | null) => void;
  setUser: (user: UserInfo | null) => void;
  onProviderFamilyDomainClearedAfterLogout?: () => void;
  userId?: string;
  onOpenRemoteConnection?: (preference?: RemoteConnectionOpenPreference) => void;
  openRemoteProjectWorkspace?: (target: {
    hostId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    expectedMembershipId?: string;
    projectId: string | null;
    isCurrent?: () => boolean;
  }) => Promise<void>;
  openMobileProjectDraft?: (request: CreateTaskOptions) => Promise<void>;
  workbenchGroupClientMode?: ZCodeTaskClientMode;
}) {
  // [并发] 导航序号是全局单调计数器，用于作废旧的在途新建任务。
  // 它必须跨渲染保持，不能被 useState 替换，否则旧闭包仍读到旧值。
  // 任何新的导航入口都要先自增再捕获，顺序不能颠倒。
  // 改错后果：两次导航并发提交，先发起的覆盖后发起的会话。
  const navigationSequence = useRef(0);
  // [契约] workspaceActionError 只保留一条，setWorkspaceActionError 覆盖旧值，成功路径显式传 null 清空。
  // 它只是展示态，不能作为流程控制依据，也不能替代 throw。
  // 不要在 catch 里既 setError 又吞掉：调用方仍需要 onError 回调。
  // 改错后果：失败后错误条不消失，用户以为重试也失败了。
  const [workspaceActionError, setWorkspaceActionError] = useState<string | null>(null);
  // [契约] 确认弹窗是异步 Promise，false 表示用户取消，必须提前 return。
  // 同一个 hook 同时服务退出登录与 WSL 路径提示，文案由调用点决定。
  // requestConfirmation 是异步 Promise，resolve 前不得读取设置快照，账号可能已切换。
  // 改错后果：取消被当成确认，直接执行登出或远程连接。
  const requestConfirmation = useConfirmDialog();
  // Root 的远端装配依赖本 hook 返回的动作，函数引用每轮都会变化；它只用于点击执行，
  // 不应使整个新建入口失稳。与任务导航一致，读取最近已提交实现，并冻结本次操作的实现。
  // [契约] 用 ref 冻结 opener 的历史实现，读取时只取 current。
  // Root 每轮都会重建该函数，直接进依赖数组会让新建入口失去稳定性。
  // remoteProjectOpener 只在点击回调里读取，不进渲染路径，所以不需要触发重渲染。
  // 改错后果：新建回调每轮变化，下游 effect 反复重订阅。
  const remoteProjectOpener = useRef(openRemoteProjectWorkspace);
  // [资源] 无依赖的 layout effect 每轮把最新 opener 写进 ref，这是唯一写入点。
  // 必须在 layout 阶段写，保证同轮事件回调能读到最新实现。
  // 不要加依赖数组：加了之后只在特定渲染更新，会读到过期实现。
  // 改错后果：连接后打开远程项目仍用旧实现，导航参数缺失。
  useLayoutEffect(() => {
    remoteProjectOpener.current = openRemoteProjectWorkspace;
  });

  useEffect(() => {
    // [事务] 客户端模式必须在任何分组恢复逻辑之前写入 store。
    // 它决定后续 resetToPrimaryPane 与 deactivateActiveGroup 是否生效。
    // 不要在渲染期调用：这是 effect，且需要作用于全局 store。
    // 改错后果：模式切换后分组仍按旧语义恢复，历史会话被显示出来。
    useWorkbenchGroupStore.getState().configureClientMode(workbenchGroupClientMode);
    if (workbenchGroupClientMode === "desktop-continuous" && !isRendererReloadNavigation()) {
      // group/pane 是 renderer-local 持久化 UI 状态。app 冷启动如果直接
      // 激活它们，即使 activeTaskId=null 也会把历史 session 显示出来，违背启动草稿语义。
      // renderer reload 则保留恢复资格，用于输出中刷新续流。
      // [契约] 冷启动时若活动分组含未校验绑定，必须立即去激活。
      // renderer reload 保留恢复资格，其余启动场景一律按草稿语义处理。
      // 不要在这里判断 activeTaskId：分组恢复与任务是否存在无关。
      // 改错后果：冷启动直接展示历史 session，违背启动草稿语义。
      const workbenchState = useWorkbenchGroupStore.getState();
      const activeGroup = workbenchState.activeGroupId
        ? workbenchState.groups[workbenchState.activeGroupId]
        : null;
      const activeGroupWasRestored = Boolean(
        activeGroup &&
        [activeGroup.primaryBinding, ...Object.values(activeGroup.panes)].some(
          (binding) => binding.restoredUnvalidated,
        ),
      );
      if (activeGroupWasRestored) {
        workbenchState.deactivateActiveGroup();
      }
      if (hadPersistedPaneLayoutAtModuleLoad()) {
        usePaneLayoutStore.getState().resetToPrimaryPane();
      }
    }
  }, [workbenchGroupClientMode]);

  // [契约] 命名空间参与草稿 scope 计算，必须与读取方使用同一个值。
  // 它每轮稳定，不要把它拼进临时字符串或再次 normalize。
  // 所有 resolveComposerScope 调用都必须传它，漏传会落到默认命名空间。
  // 若 composerClientNamespace 与读取方不一致，草稿会写进别的命名空间，重开后读不到。
  const composerClientNamespace = useComposerClientNamespace();
  // [事务] 这是草稿落地的唯一入口：先解析项目与分组，再持久化，最后开启草稿。
  // 顺序不能调换：先 startDraft 再 persist 会让首帧读到旧草稿。
  // 它必须在目录准备成功后被调用，不能作为乐观前置动作。
  // 改错后果：草稿指向未准备完成的路径，发送时工作区不存在。
  const startDraftInWorkspace = useCallback(
    (workspacePath: string, workspaceIdentity?: string, options?: CreateTaskOptions) => {
      const projectId =
        options?.projectId !== undefined
          ? options.projectId
          : (readComposerWorkspaceScope(workspacePath, workspaceIdentity, composerClientNamespace)
              ?.projectId ?? null);
      // [契约] scope 由 projectId、identity、命名空间三者共同决定，缺一不可。
      // 后续所有读写都必须复用同一个 scope 对象，不能就地重算。
      // 不要在 scope 之外再传 projectId：两套身份会漂移。
      // 若在这里重算 scope 而不复用上方对象，草稿会落到别的 projectId 桶里。
      const scope = resolveComposerScope(projectId, workspaceIdentity, composerClientNamespace);
      // [契约] 先读旧草稿再决定是否覆盖，用于继承 taskGroupId 等组织意图。
      // 读取必须发生在 persist 之前，否则读到的是刚写入的内容。
      // 不要把 savedDraft 直接展开到最外层：text 必须由调用方显式决定。
      // 改错后果：显式传入的草稿文本被旧内容覆盖。
      const savedDraft = readV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        V4_DRAFT_SCOPE_ROOT,
        scope,
      );
      const taskGroupId =
        options?.taskGroupId !== undefined
          ? options.taskGroupId
          : (savedDraft?.taskGroupId ?? null);
      // [契约] 记住 scope 是后续跨页读取草稿的前置条件，必须在 persist 之前。
      // 它按 workspace 与 identity 建索引，不能用 scope 反推。
      // 不要把它放到条件分支里：任何落草稿路径都需要这条映射。
      // 若把 rememberComposerWorkspaceScope 放进条件分支，重进工作区将找不到这条草稿映射。
      rememberComposerWorkspaceScope(workspacePath, workspaceIdentity, scope);
      // [事务] 已有 draftId 时必须先绑定，后续 prepareSession 才能复用同一目录。
      // 绑定发生在 persist 与 startDraft 之前，顺序颠倒会生成第二份草稿。
      // 没有 draftId 时不能绑定空串，否则会污染待发送索引。
      // 改错后果：待发送草稿与新建任务分裂成两个工作区。
      if (options?.draftId) bindPendingTaskDraft(scope, options.draftId, workspacePath);
      persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        V4_DRAFT_SCOPE_ROOT,
        {
          text: "",
          ...(options?.initialComposerDraft?.draft ?? savedDraft),
          projectId,
          taskGroupId,
        },
        scope,
      );
      if (workbenchGroupClientMode === "desktop-continuous") {
        useWorkbenchGroupStore.getState().deactivateActiveGroup();
        usePaneLayoutStore.getState().resetToPrimaryPane();
      }
      useZCodeSessionStore
        .getState()
        .startDraft(workspacePath, options?.provider, workspaceIdentity, {
          projectId,
          taskGroupId,
        });
      // [事务] 初始草稿附件要等 startDraft 之后才 stage，依赖新的 draftFocusVersion。
      // stage 必须读取 store 的最新版本号，不能用函数入参里的旧值。
      // 不要在 persist 前 stage：版本号尚未递增，附件会挂到上一轮草稿。
      // 改错后果：附件出现在上一次草稿里，本次新建任务为空。
      if (options?.initialComposerDraft) {
        stageV4ComposerDraftAttachments(
          workspacePath,
          workspaceIdentity,
          useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
            .draftFocusVersion,
          options.initialComposerDraft,
        );
      }
      // 项目草稿只由接收目录的 Root 初始化；mention 的尾空格属于编辑内容。
      // [契约] 初始提示词与草稿是两条写入路径，前者允许保留尾空格。
      // 只有 trim 后非空才写入，避免空字符串覆盖已有草稿文本。
      // requestComposerTextInsert 必须在 persist 之后调用，保证编辑态一致。
      // 若去掉 initialPrompt.trim() 判断，空串会经 persistV4ComposerDraft 覆盖已有草稿文本。
      const initialPrompt = options?.initialPrompt;
      if (initialPrompt?.trim()) {
        const mention = options?.initialPromptMention;
        persistV4ComposerDraft(
          workspacePath,
          workspaceIdentity,
          V4_DRAFT_SCOPE_ROOT,
          {
            text: initialPrompt,
            projectId,
            taskGroupId,
            ...(mention ? { mention } : {}),
          },
          scope,
        );
        useZCodeSessionStore
          .getState()
          .requestComposerTextInsert(workspacePath, initialPrompt, workspaceIdentity, mention);
      }
    },
    [workbenchGroupClientMode, composerClientNamespace],
  );

  // [事务] 新任务主流程：捕获起点、解析分组与项目、准备目录、提交导航、落草稿。
  // 所有外部调用之间都要 isCurrent 检查，缺失任一处都可能写入过期目标。
  // 失败只写 workspaceActionError 并回调 onError，不清理当前会话。
  // 改错后果：目录准备失败却已切 tab，用户丢失当前会话上下文。
  const startNewTaskFromActiveWorkspace = useCallback(
    async (source: string, request?: CreateTaskRequest) => {
      // [契约] 每次执行都冻结当前 opener 实现，整条流程只使用这一份。
      // 必须在函数体最前面读取，await 之后再读可能拿到新实现。
      // 不要把它放进依赖数组：ref 的 current 变化不触发重渲染。
      // 改错后果：流程中途实现被替换，导航参数与校验不一致。
      const openRemoteProjectWorkspace = remoteProjectOpener.current;
      // [并发] 自增必须发生在捕获起点之前，任何后续导航都会作废本次。
      // 先自增再读 originTab，保证起点与序号属于同一时刻。
      // 不要用 sequence += 1 后读取：表达式求值顺序虽等价，但可读性更差。
      // 若不自增 navigationSequence.current，两次快速导航会共享序号，旧流程不会被 isCurrent 作废。
      const sequence = ++navigationSequence.current;
      // [契约] originTab 是导航起点快照，用户切 tab 后本次流程必须放弃。
      // 它必须与 originWorkspace 在同一同步段内读取，中间不能 await。
      // 不要用 activeWorkspacePath 代替：多 tab 同路径时无法区分。
      // 改错后果：切走后任务仍落回原 tab，用户被强行拉回。
      const originTab = tabStoreApi.getState().activeTabId;
      const originWorkspace = activeWorkspacePath
        ? useZCodeSessionStore
            .getState()
            .getWorkspaceState(activeWorkspacePath, activeWorkspaceIdentity ?? undefined)
        : null;
      const isCurrent = () =>
        (typeof request !== "object" || request.isCurrent?.() !== false) &&
        sequence === navigationSequence.current &&
        tabStoreApi.getState().activeTabId === originTab &&
        (!activeWorkspacePath ||
          (() => {
            const state = useZCodeSessionStore
              .getState()
              .getWorkspaceState(activeWorkspacePath, activeWorkspaceIdentity ?? undefined);
            return (
              state.activeTaskId === originWorkspace?.activeTaskId &&
              state.draftFocusVersion === originWorkspace?.draftFocusVersion
            );
          })());
      try {
        // 在第一次 await 前捕获活动任务/草稿；快捷键和侧栏新建共用同一组织意图。
        // [契约] 先归一化成对象再补字段，字符串 provider 不能直接挂属性。
        // 这里必须浅拷贝：后续会写入 taskGroupId，直接改入参会污染调用方对象。
        // 拷贝要发生在第一次 await 之前，保证组织意图取的是点击时快照。
        // 改错后果：调用方对象被就地修改，重试时带上上一次的分组。
        const requestOptions = typeof request === "string" ? { provider: request } : { ...request };
        if (
          requestOptions.taskGroupId === undefined &&
          requestOptions.projectId === undefined &&
          readProjectSidebarView() === "grouped" &&
          activeWorkspacePath
        ) {
          const taskId = originWorkspace?.activeTaskId;
          const draftGroupId = originWorkspace?.draftTaskGroupId;
          const structure = taskId ? await services.taskGroupService?.read() : undefined;
          if (!isCurrent()) return;
          requestOptions.taskGroupId = taskId
            ? (structure?.members.find(
                (member) =>
                  member.taskId === taskId &&
                  member.workspaceKey === (activeWorkspaceIdentity?.trim() || activeWorkspacePath),
              )?.groupId ?? null)
            : (draftGroupId ?? null);
        }
        // [契约] 归一化后立刻回写 request，后续所有分支只处理对象形态。
        // 回写必须在分组解析之前，否则后面仍按字符串分支判断。
        // 不要保留原始 request 引用：两条形态会让类型收窄反复失效。
        // 改错后果：后续分支用错形态，projectId 与 hostId 解析为空。
        request = requestOptions;
        let projectId =
          typeof request === "string"
            ? undefined
            : (request?.projectId ?? request?.targetWorkspace?.projectId);
        let hostId =
          typeof request === "string"
            ? undefined
            : (request?.hostId ?? request?.targetWorkspace?.hostId);
        // [契约] 只有显式 projectId 或 targetWorkspace.projectId 才算调用方指定项目。
        // 用 in 判断而非真值判断：projectId 为 null 也是一种显式意图。
        // 它必须与 newTaskTarget 互斥使用，不能同时生效。
        // 改错后果：跨项目发起被 workbench 焦点覆盖，落到当前项目。
        const hasExplicitProject =
          typeof request === "object" &&
          request !== null &&
          ("projectId" in request || Boolean(request.targetWorkspace?.projectId));
        // [契约] 惰性回调里才读 workbench 状态，避免无目标请求也触发焦点计算。
        // activeGroupId 的三次 getState 必须在同一次求值内完成，保持快照一致。
        // paneLayout 直接取 getState，不要在这里做深拷贝。
        // activeGroupId 的三次 getState 若不在同一次求值内完成，落点与分组会来自不同时刻。
        const newTaskTarget = resolveNewTaskTargetFromRequest(request, () =>
          resolveWorkbenchNewTaskTarget({
            activeWorkspacePath,
            activeWorkspaceIdentity,
            activeGroup: useWorkbenchGroupStore.getState().activeGroupId
              ? (useWorkbenchGroupStore.getState().groups[
                  useWorkbenchGroupStore.getState().activeGroupId!
                ] ?? null)
              : null,
            paneLayout: usePaneLayoutStore.getState(),
          }),
        );
        // [事务] 继承焦点项目时才需要反解 hostId 与 projectId，显式项目直接跳过。
        // 远程身份解析不出 hostId 必须抛错，不能降级成本地路径。
        // projectId 读取要按 workspace 完整身份查树，不能由 cwd 猜。
        // 改错后果：远程任务被当成本地创建，项目归属永久丢失。
        if (!hasExplicitProject && newTaskTarget) {
          // 原因：仅远程继承项目会让本地快捷键落入未归类。按任务完整身份读取归属，不能由 cwd 猜项目。
          if (newTaskTarget.workspaceIdentity) {
            hostId =
              remoteHostIdFromWorkspaceIdentity(newTaskTarget.workspaceIdentity) ?? undefined;
            if (!hostId) throw new Error("project.host-identity-required");
          }
          const workspace = useZCodeSessionStore
            .getState()
            .getWorkspaceState(
              newTaskTarget.workspacePath,
              newTaskTarget.workspaceIdentity ?? undefined,
            );
          const tree = workspace.activeTaskId
            ? await services.projectService?.readTree(hostId ? { hostId } : undefined)
            : undefined;
          if (workspace.activeTaskId && !tree) throw new Error("project.service-unavailable");
          projectId = workspace.activeTaskId
            ? (tree?.tasks.find(
                (task) =>
                  task.taskId === workspace.activeTaskId &&
                  (task.workspaceIdentity?.trim() || task.workspacePath) ===
                    (newTaskTarget.workspaceIdentity?.trim() || newTaskTarget.workspacePath),
              )?.projectId ?? undefined)
            : (workspace.draftProjectId ?? undefined);
          if (hostId && !projectId) throw new Error("project.remote-project-required");
        }
        if (!isCurrent()) return;
        if (workbenchGroupClientMode === "web-remote-replayable") {
          if (!openMobileProjectDraft) throw new Error("project.remote-navigation-unavailable");
          // 归属先在共享入口解析，目录仍只由 bridge owner 准备；旧 Root 不写交接后的草稿。
          await openMobileProjectDraft({
            ...requestOptions,
            ...(projectId ? { projectId } : {}),
            ...(hostId ? { hostId } : {}),
          });
          return;
        }
        // [失败路径] 服务缺失是硬失败，必须抛出而不是返回空目标。
        // 抛错发生在目录准备之前，此时还没有任何副作用可回滚。
        // 不要在 catch 里把它降级成草稿：无目录的草稿无法发送。
        // 改错后果：点击新建无任何反馈，或创建出不可用的空会话。
        if (!services.projectService) throw new Error("project.service-unavailable");
        const pendingDraft =
          !projectId && (!hostId || hostId === "local")
            ? ensurePendingTaskDraft(resolveComposerScope(null, undefined, composerClientNamespace))
            : null;
        // [事务] prepareSession 是目录准备的唯一来源，target 之后不可再被推导。
        // projectId 与 hostId 只在有值时展开，避免把 undefined 当成显式本地。
        // pendingDraft 必须同时带 draftId 与 reuseDraft，否则会另建目录。
        // 改错后果：待发送草稿的工作区身份丢失，附件无法落地。
        const target = await services.projectService.prepareSession({
          ...(projectId ? { projectId } : {}),
          ...(hostId ? { hostId } : {}),
          // 显式 local 与省略 Host 是同一入口，不能漏掉待发送身份而另建目录。
          ...(pendingDraft
            ? { draftId: pendingDraft.draftId, reuseDraft: Boolean(pendingDraft.workspacePath) }
            : {}),
        });
        if (!isCurrent()) return;
        if (hostId && hostId !== "local") {
          if (!target.workspaceIdentity || !openRemoteProjectWorkspace)
            throw new Error("project.remote-navigation-unavailable");
          await openRemoteProjectWorkspace({
            ...target,
            hostId,
            isCurrent,
            ...(typeof request === "object" && request.remoteProjectMembershipId
              ? { expectedMembershipId: request.remoteProjectMembershipId }
              : {}),
          });
        }
        // 目录准备成功才提交导航；失败保留当前会话和分屏。
        if (!hostId || hostId === "local")
          addTab(target.workspacePath, {
            workspacePurpose: target.projectId ? "project" : "conversation",
            ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
          });
        startDraftInWorkspace(target.workspacePath, target.workspaceIdentity, {
          ...(typeof request === "string" ? { provider: request } : request),
          ...(pendingDraft ? { draftId: pendingDraft.draftId } : {}),
          projectId: target.projectId,
        });
        if (typeof request === "object") request.onComplete?.();
        setWorkspaceActionError(null);
        logger.info(`[Root] ${source}`, {
          workspacePath: target.workspacePath,
          projectId: target.projectId,
        });
      } catch (error) {
        if (!isCurrent()) return;
        logger.error("[Root] 准备新任务失败", error);
        if (typeof request === "object") request.onError?.(error);
        setWorkspaceActionError(error instanceof Error ? error.message : String(error));
      }
    },
    [
      services.projectService,
      composerClientNamespace,
      activeWorkspacePath,
      activeWorkspaceIdentity,
      tabStoreApi,
      addTab,
      openMobileProjectDraft,
      workbenchGroupClientMode,
      startDraftInWorkspace,
    ],
  );

  const {
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
  } = useConversationWorkspaceActions({
    services,
    addTab,
    createTask: startNewTaskFromActiveWorkspace,
    setWorkspaceActionError,
  });

  // [事务] 登出顺序固定：查运行会话数、确认、调度 telemetry、快照设置、登出、回写、清理。
  // 设置快照必须在 oauthService.logout 之前读取，登出后可能拿不到账号上下文。
  // telemetry 只调度不 await，网络重试不能阻塞登出。
  // 若在 logout 之后才读设置或 await telemetry，会用登出后的空值回写且拖慢退出。
  const handleLogout = useCallback(async () => {
    let runningAgentSessionCount: number | null = null;
    try {
      const sessionActivity = await platform.getDesktopSessionActivity?.();
      runningAgentSessionCount =
        typeof sessionActivity?.runningAgentSessionCount === "number"
          ? sessionActivity.runningAgentSessionCount
          : null;
    } catch (error) {
      logger.warn("[Root] 查询桌面运行中会话数量失败，使用保守退出登录文案", { error });
    }

    const confirmed = await requestConfirmation({
      title: intl.formatMessage({ id: "logout.confirm.title" }),
      description:
        runningAgentSessionCount !== null && runningAgentSessionCount > 0
          ? intl.formatMessage(
              { id: "logout.confirm.descriptionWithRunningSessions" },
              { count: String(runningAgentSessionCount) },
            )
          : intl.formatMessage({ id: "logout.confirm.descriptionDefault" }),
      confirmLabel: intl.formatMessage({ id: "logout.confirm.ok" }),
      cancelLabel: intl.formatMessage({ id: "logout.confirm.cancel" }),
    });
    if (!confirmed) {
      return;
    }

    // Bug 原因：telemetry 是辅助链路；等待网络重试会延迟退出登录，甚至在旧的无超时实现里
    // 无限阻塞主流程。这里只调度事件，Main 侧负责有界重试与退出 drain。
    void reportAppTelemetryEvent(
      platform,
      {
        elementName: "app_user_logout",
        eventRegion: "app_profile",
        eventType: "ck",
        eventExtraDetail: {},
        userId,
      },
      "Root",
    );
    const settingsBeforeLogout = await services.settingService.get();
    const nextProviderFamilyDomain = resolveLogoutProviderFamilyDomain({
      currentDomain: settingsBeforeLogout.providerFamilyDomain,
    });
    await services.oauthService.logout();
    await updateAppSettings({
      providerFamilyDomain: (nextProviderFamilyDomain ?? "") as AppSettings["providerFamilyDomain"],
      providerFamilyDomainUpdatedAt: Date.now(),
      providerFamilyDomainMigrated: true,
    });
    if (!nextProviderFamilyDomain) {
      onProviderFamilyDomainClearedAfterLogout?.();
    }
    // ZAI/BigModel provider 已恢复为 App 登录镜像。
    // 派生 Coding/Start key 由 OAuth logout 的 host hook 统一清理，Root 只负责刷新展示态。
    setOAuthError(null);
    setUser(null);
    // 退出登录后刷新 Account Source 与 Registry，避免继续展示退出前的 Provider 状态。
    await refreshProviderState();
    // Coding Plan 官网 webview 使用独立持久 partition，App logout 必须同步清理。
    await platform.executeDesktopCommand(DesktopCommandIds.ClearCodingPlanWebviewStorage);
    await platform.executeDesktopCommand(DesktopCommandIds.RelaunchApp);
  }, [
    intl,
    requestConfirmation,
    refreshProviderState,
    onProviderFamilyDomainClearedAfterLogout,
    platform,
    services.oauthService,
    services.modelSelectionService,
    services.settingService,
    setOAuthError,
    setUser,
    updateAppSettings,
    userId,
  ]);

  // [事务] 选目录的顺序：WSL 提示、激活已开窗口、addTab、清活动任务并回草稿。
  // activated 为 true 时必须直接返回，不能重复 addTab。
  // 打开 workspace 是 workspace-only 意图，必须清掉 activeTaskId。
  // 改错后果：同一目录开出两个 tab，或直接续上上次会话。
  const handleSelectProject = useCallback(
    async (path: string) => {
      logger.info("[Root] handleSelectProject called with path:", path);
      try {
        const wslUncWorkspace = parseWslUncWorkspacePath(path);
        if (wslUncWorkspace && onOpenRemoteConnection) {
          const shouldOpenWslConnection = await requestConfirmation({
            title: intl.formatMessage({ id: "workspace.wslUncPrompt.title" }),
            description: intl.formatMessage(
              { id: "workspace.wslUncPrompt.description" },
              {
                path,
              },
            ),
            confirmLabel: intl.formatMessage({ id: "workspace.wslUncPrompt.openWsl" }),
            cancelLabel: intl.formatMessage({ id: "workspace.wslUncPrompt.continuePath" }),
          });
          if (shouldOpenWslConnection) {
            logger.info("[Root] 用户选择通过 WSL 远程连接打开 UNC 工作区", {
              distro: wslUncWorkspace.distro,
              path,
            });
            onOpenRemoteConnection({
              preferredKind: "wsl",
              preferredWslDistro: wslUncWorkspace.distro,
            });
            return;
          }
        }

        // 桌面端：检查是否已有其他窗口打开了该目录，如果是则激活该窗口对应 tab
        const result = await platform.activateOrSetWorkspace(path);
        if (result.activated) {
          logger.info("[Root] 目录已在其他窗口打开，已激活该窗口对应 tab，跳过重复打开");
          return;
        }

        // 新增 tab（如果已在本窗口打开则激活它）
        addTab(path);
        // 打开 workspace 是 workspace-only 意图，不是“继续上次会话”。
        // 即使命中已存在 tab，也必须清掉该 workspace 的 activeTaskId 并回到单 pane 草稿。
        startDraftInWorkspace(path);
        setWorkspaceActionError(null);
      } catch (err) {
        logger.error("[Root] handleSelectProject error:", err);
      }
    },
    [
      addTab,
      intl,
      onOpenRemoteConnection,
      platform,
      requestConfirmation,
      services.settingService,
      startDraftInWorkspace,
      supportsSettings,
    ],
  );

  const handleOpenWorkspace = useCallback(() => {
    if (!allowOpenWorkspace) {
      // Web 远程控制当前只保证“进入 desktop 已打开的 workspace”。
      // 之前这里继续放开“打开工作区”，用户会被带进打开工作区中间页，
      // 但后续的新工作区/新会话链路并没有在 Web 远程控制模式里补齐，看起来就像页面一直卡住。
      // 这里直接拦掉入口，避免把用户带进半支持状态。
      logger.info("[Root] 当前模式不支持打开其他工作区，已忽略请求");
      return;
    }
    setWorkspaceActionError(null);

    if (preferDirectoryBrowser) {
      void openFolderFromWorkspaceEntry({
        preferDirectoryBrowser,
        openDirectoryBrowser,
        selectDirectory: () => platform.selectDirectory(),
        onSelectProject: (path) => {
          void handleSelectProject(path);
        },
      });
      return;
    }

    // 打开工作区中间页作为“新标签页”会在启动空态、Cmd/Ctrl+O
    // 和菜单打开工作区时抢占整页。现在打开工作区只保留为动作：本地优先直接弹系统目录选择，
    // 不再进入中间页面；不支持系统目录选择的壳层由启动兜底负责创建默认 workspace。
    if (!supportsSettings) {
      void handleEnsureConversationWorkspace().catch((error) => {
        logger.error("[Root] 创建对话 workspace 失败", { error });
      });
      return;
    }

    void openFolderFromWorkspaceEntry({
      selectDirectory: () => platform.selectDirectory(),
      onSelectProject: (path) => {
        void handleSelectProject(path);
      },
    });
  }, [
    allowOpenWorkspace,
    handleEnsureConversationWorkspace,
    handleSelectProject,
    openDirectoryBrowser,
    platform,
    preferDirectoryBrowser,
    supportsSettings,
  ]);

  const handleOpenFolderFromWorkspaceMenu = useCallback(() => {
    if (!allowOpenWorkspace) {
      logger.info("[Root] 当前模式不支持从空态菜单打开文件夹，已忽略请求");
      return;
    }

    // 空态 workspace 菜单的 Open folder 需要复用根级打开工作区动作。
    // 因此这里调用同一个入口函数，只把 Root 里的 selectDirectory 与项目选择回调注入进去。
    if (preferDirectoryBrowser) {
      void openFolderFromWorkspaceEntry({
        preferDirectoryBrowser,
        openDirectoryBrowser,
        selectDirectory: () => platform.selectDirectory(),
        onSelectProject: (path) => {
          void handleSelectProject(path);
        },
      });
      return;
    }

    if (!supportsSettings) {
      void handleEnsureConversationWorkspace().catch((error) => {
        logger.error("[Root] 从空态菜单创建对话 workspace 失败", { error });
      });
      return;
    }

    void openFolderFromWorkspaceEntry({
      selectDirectory: () => platform.selectDirectory(),
      onSelectProject: (path) => {
        void handleSelectProject(path);
      },
    });
  }, [
    allowOpenWorkspace,
    handleEnsureConversationWorkspace,
    handleSelectProject,
    openDirectoryBrowser,
    platform,
    preferDirectoryBrowser,
    supportsSettings,
  ]);

  const handleCreateTask = useCallback(
    (request?: CreateTaskRequest) => {
      return startNewTaskFromActiveWorkspace("sidebar new task", request);
    },
    [startNewTaskFromActiveWorkspace],
  );

  const handleBackFromSettings = useCallback(() => {
    if (!activeWorkspacePath) {
      return;
    }

    // 设置页返回最近 workspace 时不能只按 path 激活。
    // 同一路径可能存在不同远端身份，丢掉 activeWorkspaceIdentity 会把远程工作区切到 path-only 桶。
    const activated = tabStoreApi
      .getState()
      .activateTabByPath(
        activeWorkspacePath,
        activeWorkspaceIdentity ? { workspaceIdentity: activeWorkspaceIdentity } : undefined,
      );
    const taskId = useZCodeSessionStore
      .getState()
      .getWorkspaceState(activeWorkspacePath, activeWorkspaceIdentity ?? undefined).activeTaskId;
    if (activated && taskId) {
      notifyTaskNavigationCommitted({
        workspacePath: activeWorkspacePath,
        workspaceIdentity: activeWorkspaceIdentity ?? undefined,
        taskId,
      });
    }
  }, [activeWorkspaceIdentity, activeWorkspacePath, tabStoreApi]);

  return {
    workspaceActionError,
    setWorkspaceActionError,
    startDraftInWorkspace,
    startNewTaskFromActiveWorkspace,
    handleLogout,
    handleSelectProject,
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
    handleOpenWorkspace,
    handleOpenFolderFromWorkspaceMenu,
    handleCreateTask,
    handleBackFromSettings,
  };
}
