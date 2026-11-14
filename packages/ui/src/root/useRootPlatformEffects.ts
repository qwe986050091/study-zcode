/* oxlint-disable eslint(max-lines) -- 平台事件和分享导入共用同一生命周期。 */
// useRootPlatformEffects —— Root 层平台副作用的唯一汇聚点：启动引导、平台事件注册、分享导入事务、窗口标签同步与 Web 快捷键兜底。
// 职责边界：本文件只把 IPlatformService 的事件翻译成 Root 动作；tab 与任务事实归 tabStore / sessionStore，草稿归 composerDraftStore，导入事务状态只在本文件内自洽。
//
// 不变量表（改动前逐条对照；每条都对应真机多窗口、手机远控或严格模式双挂载下的可复现故障）：
// INV-01 断言：启动引导只执行一次且必须先于任何 tab 激活 —— 守住它的位置：didBootstrapInitialWorkspaceRef 的置位写在所有 addTab 之前 —— 改错故障：置位晚于 addTab，严格模式双挂载会插入两个初始 tab。
// INV-02 断言：canBootstrapInitialWorkspace 为假时整个引导直接早退，且不消耗一次性资格 —— 守住它的位置：effect 首行闸门 —— 改错故障：OAuth 恢复期先激活主界面，随后被登录页覆盖，出现闪屏。
// INV-03 断言：引导依赖的每个入参都必须出现在依赖数组里 —— 守住它的位置：首个 effect 的依赖列表 —— 改错故障：换工作区后不重新引导，界面停在旧入口。
// INV-04 断言：平台事件注册与 dispose 必须一一配对，且清理函数逐个调用 —— 守住它的位置：第二个 effect 的返回清理块 —— 改错故障：多窗口切换后同一事件触发多次，打开重复标签。
// INV-05 断言：可选平台通道缺失时必须退化为无副作用的空函数 —— 守住它的位置：onOpenWorkspacePath / onShareImport / onUpdateCheckResult 的三元兜底 —— 改错故障：Web 端直接抛类型错误，整个 Root 白屏。
// INV-06 断言：事件回调只读取本次渲染的 props 快照，不越过依赖数组偷懒 —— 守住它的位置：第二个 effect 的依赖数组 —— 改错故障：回调读到过期的 activeWorkspacePath，分享导入落到旧工作区。
// INV-07 断言：分享导入同一时刻只允许一个活动事务 —— 守住它的位置：pendingShareImportRef 与 activeShareImportRef 的双闸门 —— 改错故障：并发导入互相覆盖操作号，进度条与结果错配。
// INV-08 断言：重复的分享深链必须按内容判等后丢弃 —— 守住它的位置：isShareImportIntentSame 前置判断 —— 改错故障：系统重复投递深链时弹两次导入、写两条会话。
// INV-09 断言：导入进度回调节流只能放宽同一阶段，complete 必须直接吞掉 —— 守住它的位置：进度订阅回调里的时间闸门 —— 改错故障：完成提示与成功提示连闪两条，用户以为导入了两份。
// INV-10 断言：导入事务的收口只发生在 finally —— 守住它的位置：finally 里同时释放进度订阅、清空活动意图并自增版本号 —— 改错故障：任一路径提前返回都会让后续深链永久被闸门挡住。
// INV-11 断言：重试必须把意图状态改回 received 并触发新一轮 effect —— 守住它的位置：失败分支内的重试动作 —— 改错故障：重试无响应，或复用已释放的操作号打到已关闭的事务。
// INV-12 断言：同步给主进程的窗口标签只包含本地且无远程身份的 workspace —— 守住它的位置：窗口标签同步前的两段过滤 —— 改错故障：远程占位标签被当成本地路径同步，窗口列表出现幽灵条目。
// INV-13 断言：窗口标签同步必须等全量恢复完成 —— 守住它的位置：shouldPublishCompleteWorkspaceSnapshot 闸门 —— 改错故障：恢复中途发布半份快照，主进程窗口列表反复抖动。
// INV-14 断言：Web 快捷键监听只在非桌面端注册，且录制态必须短路 —— 守住它的位置：effect 的 isDesktop 早退与 isShortcutRecordingActive 判断 —— 改错故障：录制快捷键时按下 Cmd/Ctrl+N 真的新建了任务。
// INV-15 断言：原生菜单语言同步的迟到失败必须被卸载标志挡住 —— 守住它的位置：setApplicationLocale 的失败回调 —— 改错故障：切换语言后旧请求报错覆盖新日志，且无法区分真实失败。
// INV-16 断言：活动会话同步用 ref 去重并以退订函数作为清理 —— 守住它的位置：lastSyncedSessionIdRef 与 subscribe 返回值 —— 改错故障：每次 store 变更都向主进程推同一会话，或多层订阅泄漏。
import { getConversationShareErrorDetails } from "@/lib/conversationShareError.js";
import { useEffect, useRef, useState } from "react";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { CreateTaskOptions } from "@/app-shell/types.js";
import type { IPlatformService, ZCodeTaskClientMode } from "@zcode/shared";
import { readV4ComposerDraft, V4_DRAFT_SCOPE_ROOT } from "@/v4/composer/composerDraftStore.js";
import { readComposerWorkspaceScope } from "@/v4/composer/composerDraftStore.js";
import { useComposerClientNamespace } from "@/hooks/useServices.js";
import { isWorkspaceTab, type TabStoreState, type WindowTabState } from "@/store/tabStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { logger } from "@/logger.js";
import { resolveImportedComposerConfig } from "@/v4/composer/newTaskDraft.js";
import { dismissToast, toast, updateToast } from "@/components/ui/toast.js";
import { matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import { isShortcutRecordingActive } from "@/shortcuts/bindings.js";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";
import {
  useWebRemoteControlWorkspaceSync,
  shouldPublishCompleteWorkspaceSnapshot,
} from "@/root/rootPlatformWorkspaceSync.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
  createShareImportIntent,
  isShareImportIntentSame,
  resolveShareImportFailurePresentation,
  type ShareImportIntent,
} from "@/root/shareImportIntent.js";

export function useRootPlatformEffects({
  initialWorkspaceAbsPath,
  initialWorkspaceIdentity,
  initialWorkspacePurpose,
  initialTaskId,
  initialTaskDraft,
  clientMode = "desktop-continuous",
  canBootstrapInitialWorkspace = true,
  addTab,
  setIsBootstrappingInitialWorkspace,
  platform,
  activateTabByPath,
  startDraftInWorkspace,
  startNewTaskFromActiveWorkspace,
  openWorkspace,
  openWorkspacePath,
  setWorkspaceActionError,
  allowOpenWorkspace = true,
  isDesktop,
  locale,
  tabs,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  reconnectingRemoteWorkspaceKeys = [],
  remoteWorkspaceErrorByWorkspaceKey = {},
  webRemoteControlFeatureEnabled = false,
  hasCompletedFullTabRestore = true,
  intl,
  isRestoringOAuthSession,
}: {
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  initialWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose;
  initialTaskId?: string;
  initialTaskDraft?: CreateTaskOptions;
  clientMode?: ZCodeTaskClientMode;
  canBootstrapInitialWorkspace?: boolean;
  addTab: (
    workspacePath: string,
    options?: {
      workspaceIdentity?: string;
      workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
    },
  ) => void;
  setIsBootstrappingInitialWorkspace: (value: boolean) => void;
  platform: IPlatformService;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  startDraftInWorkspace: (
    workspacePath: string,
    workspaceIdentity?: string,
    options?: CreateTaskOptions,
  ) => void;
  startNewTaskFromActiveWorkspace: (source: string) => void;
  openWorkspace: () => void;
  openWorkspacePath: (workspacePath: string) => void;
  setWorkspaceActionError: (message: string | null) => void;
  allowOpenWorkspace?: boolean;
  isDesktop?: boolean;
  locale: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["locale"];
  tabs: WindowTabState[];
  activeWorkspacePath?: string | null;
  activeWorkspaceIdentity?: string | null;
  reconnectingRemoteWorkspaceKeys?: string[];
  remoteWorkspaceErrorByWorkspaceKey?: Record<string, string>;
  webRemoteControlFeatureEnabled?: boolean;
  hasCompletedFullTabRestore?: boolean;
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  isRestoringOAuthSession: boolean;
}) {
  const didBootstrapInitialWorkspaceRef = useRef(false);
  const baseServices = useOptionalBaseWorkspaceServices();
  const pendingShareImportRef = useRef<ShareImportIntent | null>(null);
  const [shareImportRevision, setShareImportRevision] = useState(0);
  const composerClientNamespace = useComposerClientNamespace();
  const activeShareImportRef = useRef<ShareImportIntent | null>(null);
  const importOperationRef = useRef<string | null>(null);
  const lastImportProgressToastRef = useRef<{ phase: string; at: number } | null>(null);
  const importToastIdRef = useRef<number | null>(null);

  useEffect(() => {
    // [契约] 引导 effect 是整个 Root 的入口时序所有者：登录态判定、初始工作区落 tab、草稿与任务接续，三步顺序不可交换。
    // [并发] 严格模式会挂载两次，这里靠 ref 而非 state 做一次性闸门，因为 state 在同一轮提交里尚不可见。
    // [失败路径] 缺 canBootstrapInitialWorkspace 时整体跳过，且不消耗一次性资格，等下一次真正的启动条件成立。
    // [权衡] 引导与事件注册拆成两个 effect，是为了让事件注册能在 tabs 变化时重挂，而不重跑引导。
    // 启动时必须先判断 OAuth 本地会话，再恢复历史/初始 workspace。
    // 如果这里抢先 addTab，未登录用户会先看到主界面，之后才被登录页覆盖。
    if (!canBootstrapInitialWorkspace || didBootstrapInitialWorkspaceRef.current) {
      return;
    }

    // [契约] 置位必须发生在任何 addTab 之前：它是本 effect 的幂等凭据，也是后续渲染不再重复引导的依据。
    // [并发] 同一轮里两次挂载都能读到 ref 的旧值，所以先置位再动作；晚置位等于放弃幂等。
    // [失败路径] addTab 抛错时 ref 已置位，代价是不再重试，这是刻意取舍，避免错误循环放大。
    didBootstrapInitialWorkspaceRef.current = true;
    // [契约] 只有宿主注入的初始路径才走这段直达逻辑；没有路径说明是纯空启动，交给首屏默认入口。
    // [资源] 这里不申请任何订阅，因此不需要清理，但每个分支都必须保证不遗留中间态。
    // [权衡] 直达工作区会跳过打开工作区中间页，代价是首屏渲染被推迟到首个 tab 准备好之后。
    // [失败路径] 身份与用途都是可选项，构造参数对象时不能写成显式 undefined 去覆盖已有字段。
    if (initialWorkspaceAbsPath) {
      const savedScope = readComposerWorkspaceScope(
        initialWorkspaceAbsPath,
        initialWorkspaceIdentity,
        composerClientNamespace,
      );
      // 手机重建 Root 时 bridge 只有地址；项目意图随已有浏览器草稿恢复，先于 prewarm。
      const savedDraft =
        clientMode === "web-remote-replayable" && !initialTaskId && !initialTaskDraft
          ? readV4ComposerDraft(
              initialWorkspaceAbsPath,
              initialWorkspaceIdentity,
              V4_DRAFT_SCOPE_ROOT,
              savedScope,
            )
          : null;
      // [契约] 草稿意图的优先级固定为：显式任务草稿、已存范围、已存草稿的项目号，降级顺序不可调换。
      // [权衡] 手机重建只能拿到地址，靠已存草稿恢复意图；桌面冷启动依赖宿主注入，两条路互不兜底。
      // [并发] 读取草稿是同步的本地快照，不发起网络请求，因此可以在引导阶段安全执行。
      // [失败路径] 三级来源都为空时意图为 undefined，后续分支必须能接住，不能把空对象当有效意图。
      const draftIntent =
        initialTaskDraft ??
        (savedScope
          ? { projectId: savedScope.projectId, taskGroupId: savedDraft?.taskGroupId }
          : undefined) ??
        (savedDraft?.projectId !== undefined
          ? { projectId: savedDraft.projectId, taskGroupId: savedDraft.taskGroupId }
          : undefined);
      // [契约] addTab 是启动期唯一允许创建初始 tab 的位置，去重由 tabStore 负责，这里不重复判断。
      // [权衡] 身份与用途仅在真的存在时才进参数对象，避免用 undefined 覆盖 store 里的既有字段。
      // [失败路径] 重复调用会因 ref 闸门被挡住；若闸门失效，表现为首屏出现两个同路径标签。
      addTab(
        initialWorkspaceAbsPath,
        initialWorkspaceIdentity || initialWorkspacePurpose
          ? {
              ...(initialWorkspaceIdentity ? { workspaceIdentity: initialWorkspaceIdentity } : {}),
              ...(initialWorkspacePurpose ? { workspacePurpose: initialWorkspacePurpose } : {}),
            }
          : undefined,
      );
      // [契约] 显式任务号优先：宿主点了某条通知就必须落到那条会话，草稿逻辑完全让位。
      // [失败路径] 没有任务号且非渲染进程重载时强制进草稿，防止本地记忆抢回历史会话。
      // [并发] 渲染进程重载要保留当前会话的续流资格，所以这条分支必须显式排除重载导航。
      // [权衡] 判据集中在 isRendererReloadNavigation，而不是散落的标志位，便于一处收口。
      if (initialTaskId) {
        useZCodeSessionStore
          .getState()
          .setActiveTaskId(initialWorkspaceAbsPath, initialTaskId, initialWorkspaceIdentity);
      } else if (draftIntent || !isRendererReloadNavigation()) {
        // 修复原因：main 注入 initial workspace 只表达工作区入口；没有显式 taskId
        // 的 app 冷启动必须进入草稿，不能让 renderer-local last-session/group/pane
        // 抢回历史会话；同一 renderer reload 则保留当前 session 续流资格。
        startDraftInWorkspace(initialWorkspaceAbsPath, initialWorkspaceIdentity, draftIntent);
      }
    }
    // Dock 最近项目会通过 initialWorkspaceAbsPath 直达工作区。
    // 如果这里仍然等首屏先按默认空 tab 渲染一次，窗口会先闪出打开工作区中间页，
    // 再异步补上目标 workspace，视觉上像是“打开错页再跳转”。
    // 这里把初始工作区注入也纳入启动保护期，等首个 tab 准备好后再渲染正式内容。
    // [契约] 启动保护期在此结束：此后 Root 才允许渲染正式内容，中间页不会再闪一次。
    // [资源] 这个标志来自父组件，本 hook 只负责在引导收尾时释放，不负责初始值。
    // [并发] 释放必须放在所有分支之后，提前释放会让首个 tab 还没就绪就露出空壳。
    // [失败路径] 若中途抛错则保护期一直挂着，表现为白屏而非错页，便于定位到具体引导步骤。
    setIsBootstrappingInitialWorkspace(false);
  }, [
    addTab,
    canBootstrapInitialWorkspace,
    initialTaskId,
    initialTaskDraft,
    composerClientNamespace,
    clientMode,
    initialWorkspaceAbsPath,
    initialWorkspaceIdentity,
    initialWorkspacePurpose,
    setIsBootstrappingInitialWorkspace,
    startDraftInWorkspace,
  ]);

  useEffect(() => {
    // [契约] 平台事件在这里一次性注册，回调只做转发：真正的 tab 与任务判定都在 Root 传入的动作里。
    // [资源] 每个注册都立刻拿到释放函数，并在同一个清理块里逐一调用，注册与释放必须成对出现。
    // [并发] 依赖数组变化会重挂整组监听，因此回调里不得持有跨渲染的可变闭包。
    // [失败路径] 某个通道缺失时用空函数占位，保证清理块结构统一，不必逐项判空。
    const disposeFocusTab = platform.onFocusTab((path: string) => {
      logger.info("[Root] onFocusTab:", path);
      if (activateTabByPath(path)) {
        // 系统 workspace focus 是 workspace-only 导航；任务通知另有
        // 显式 taskId 路径，不能在这里隐式恢复这个 workspace 上次选中的 session。
        startDraftInWorkspace(path);
      }
    });
    // [契约] 新建标签语义收敛为打开工作区，不再直达中间页，由 Root 决定目录或默认工作区。
    // [失败路径] 先清空错误提示再发起动作，避免上一次失败的横幅盖住本次操作结果。
    // [权衡] 日志写在动作之前，是为了动作抛错时仍留下触发痕迹。
    const disposeNewTab = platform.onNewTab(() => {
      logger.info("[Root] onNewTab");
      setWorkspaceActionError(null);
      // 新标签过去会打开工作区中间页，导致启动/快捷键都可能进入中间页。
      // 现在新标签语义收敛为“打开工作区”动作，由 Root 决定目录选择或默认 workspace 兜底。
      openWorkspace();
    });
    const disposeNewTask = platform.onNewTask(() => {
      startNewTaskFromActiveWorkspace("onNewTask");
    });
    const disposeOpenWorkspace = platform.onOpenWorkspace(() => {
      logger.info("[Root] onOpenWorkspace");
      openWorkspace();
    });
    // [契约] 深链打开文件夹等价于输入框上方的打开目录动作，必须复用同一条打开路径。
    // [失败路径] 当前模式不允许打开时直接忽略并记日志，不能弹错，也不能静默改走附件。
    // [权衡] 复用打开动作的额外成本是一次 tab 去重查找，换来 recentProjects 与跨窗口激活保持一致。
    const disposeOpenWorkspacePath = platform.onOpenWorkspacePath
      ? platform.onOpenWorkspacePath((path: string) => {
          if (!allowOpenWorkspace) {
            logger.info("[Root] 当前模式不支持通过 deep link 打开文件夹，已忽略请求");
            return;
          }

          logger.info("[Root] onOpenWorkspacePath:", path);
          // 系统服务 deep link 对应输入框上方 Open folder 语义。
          // 这里复用 handleSelectProject，而不是把路径作为聊天附件，才能保留 tab 去重、
          // 跨窗口激活和 recentProjects 更新这些手动打开文件夹的既有行为。
          openWorkspacePath(path);
        })
      : () => {};
    // [契约] 深链先与在途意图比对，内容相同即视为系统重复投递，直接丢弃。
    // [并发] 同时查待执行与活动两个 ref：只看一个会漏掉正在执行时的重投。
    // [失败路径] 不在这里解析或写库，只登记意图并自增版本号，真正的导入交给下一个 effect 串行执行。
    // [权衡] 目标工作区在收到深链的瞬间冻结，换来用户随后切换 tab 也不会改变落点。
    const disposeShareImport = platform.onShareImport
      ? platform.onShareImport((payload) => {
          const current = pendingShareImportRef.current ?? activeShareImportRef.current;
          if (current && isShareImportIntentSame(current, payload)) {
            logger.info("[Root] 忽略重复的 share import deep link", {
              shareCodeLength: payload.shareCode.length,
            });
            return;
          }
          const activeTab = tabs.find(
            (tab): tab is Extract<WindowTabState, { kind: "workspace" }> =>
              tab.kind === "workspace" &&
              tab.workspacePath === activeWorkspacePath &&
              (activeWorkspaceIdentity
                ? tab.workspaceIdentity === activeWorkspaceIdentity
                : !tab.workspaceIdentity),
          );
          pendingShareImportRef.current = createShareImportIntent(payload.shareCode, undefined, {
            ...(activeWorkspacePath ? { targetWorkspacePath: activeWorkspacePath } : {}),
            ...(activeWorkspaceIdentity
              ? { targetWorkspaceIdentity: activeWorkspaceIdentity }
              : {}),
            targetWorkspaceKind:
              activeTab?.remoteSessionId || activeTab?.remoteTarget ? "remote" : "local",
          });
          setShareImportRevision((revision) => revision + 1);
          logger.info("[Root] 收到 share import deep link", {
            shareCodeLength: payload.shareCode.length,
          });
        })
      : () => {};
    // [契约] 通知点击从全局 workspace store 反查任务归属，不信任通知自带的路径。
    // [并发] 反查结果必须带任务元数据里的工作区身份，否则远端任务会落进仅按路径的桶。
    // [失败路径] 全部 workspace 都找不到时只记警告并放弃，绝不猜测一个默认工作区。
    // [权衡] 遍历是同步的本地缓存扫描，任务量再大也只是一次线性开销，可以接受。
    const disposeNotificationClick = platform.onTaskNotificationClick((taskId: string) => {
      logger.info("[Root] onTaskNotificationClick:", taskId);
      // 遍历所有 workspace 找到 taskId 所属的 workspace，然后激活对应 tab 并切换任务
      const workspaces = useZCodeSessionStore.getState().workspaces;
      for (const [workspacePath, workspaceState] of Object.entries(workspaces)) {
        const taskMeta = workspaceState.taskListCache?.find((task) => task.taskId === taskId);
        const hasTask = workspaceState.activeTaskId === taskId || Boolean(taskMeta);
        if (hasTask) {
          const targetWorkspacePath = taskMeta?.workspacePath ?? workspacePath;
          const targetWorkspaceIdentity = taskMeta?.workspaceIdentity;
          // 通知点击会从全局 workspace store 反查 task。
          // 远端任务必须用 task meta 自带的 workspaceIdentity 激活和选中，否则会落到 path-only 桶。
          activateTabByPath(
            targetWorkspacePath,
            targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : undefined,
          );
          useZCodeSessionStore
            .getState()
            .setActiveTaskId(targetWorkspacePath, taskId, targetWorkspaceIdentity);
          return;
        }
      }
      logger.warn("[Root] onTaskNotificationClick: task not found in any workspace:", taskId);
    });
    // [契约] 更新检查的每个结果都映射到一条提示文案，分支必须穷尽，不留静默路径。
    // [失败路径] 错误分支只展示可读信息，原始堆栈留在主进程日志里，不进界面。
    // [权衡] 文案全部走国际化键，因此这里只做分支选择，不做任何字符串拼接。
    const disposeUpdateCheckResult = platform.onUpdateCheckResult
      ? platform.onUpdateCheckResult((payload) => {
          logger.info("[Root] onUpdateCheckResult:", payload.kind);
          switch (payload.kind) {
            case "up-to-date":
              toast(
                intl.formatMessage(
                  { id: "update.toast.upToDate" },
                  { version: payload.currentVersion },
                ),
              );
              return;
            case "downloading":
              toast(
                intl.formatMessage(
                  { id: "update.toast.downloading" },
                  { version: payload.version },
                ),
              );
              return;
            case "available":
              toast(
                intl.formatMessage({ id: "update.toast.available" }, { version: payload.version }),
              );
              return;
            case "already-downloading":
              toast(
                intl.formatMessage(
                  { id: "update.toast.alreadyDownloading" },
                  { progress: payload.progress },
                ),
              );
              return;
            case "ready":
              toast(intl.formatMessage({ id: "update.toast.ready" }, { version: payload.version }));
              return;
            case "dev-skipped":
              toast(intl.formatMessage({ id: "update.toast.devSkipped" }));
              return;
            case "error":
              toast(intl.formatMessage({ id: "update.toast.error" }, { error: payload.message }));
              return;
          }
        })
      : () => {};
    return () => {
      // [资源] 清理块按注册顺序逐一释放，任何新增通道都必须在这里补一行，否则就是泄漏。
      // [契约] 释放函数必须可重复调用：重挂时旧的被调用一次，卸载时再调用一次。
      // [并发] 清理期间不得再触发状态写入，否则会在已卸载的树上引发告警。
      // [失败路径] 单个释放抛错会中断后面的释放，因此释放实现必须自己吞掉异常。
      disposeFocusTab();
      disposeNewTab();
      disposeNewTask();
      disposeOpenWorkspace();
      disposeOpenWorkspacePath();
      disposeShareImport();
      disposeNotificationClick();
      disposeUpdateCheckResult();
    };
  }, [activeWorkspaceIdentity, activeWorkspacePath, platform, tabs]);

  useEffect(() => {
    // [契约] 导入 effect 以版本号为触发器：每次深链或事务收口都自增，从而在这里重新取一次意图。
    // [并发] 三个闸门同时成立才放行：有意图、有基础服务、且当前没有活动事务或进行中的操作。
    // [失败路径] OAuth 恢复期直接早退且不清空意图，等恢复完成后的下一轮再执行。
    // [权衡] 登录态不在这里分叉：公开分享的可用性由服务端决定，前端多加一层判断只会造成两套行为。
    const pending = pendingShareImportRef.current;
    if (!pending || !baseServices || activeShareImportRef.current || importOperationRef.current) {
      return;
    }
    if (isRestoringOAuthSession) {
      return;
    }

    // 分享页 Deep Link 不应在 Root 层按登录态分叉；未登录与已登录都
    // 走同一份 continuation/import 流程。公开可导入分享由接口自身决定是否可用。
    // [契约] 取走意图的顺序固定：先从待执行槽摘下，再放进活动槽，中间不能有异步等待。
    // [并发] 两个槽位同时有效就说明有并发事务，此时宁可放弃本次，也不能覆盖活动事务。
    // [失败路径] 状态先置为导入中再发请求，保证任何早退路径都不会留下待执行状态的残留。
    // [资源] 旧的进度提示在这里先撤掉，避免新事务的下载进度接在旧文案后面。
    pending.status = "importing";
    pendingShareImportRef.current = null;
    activeShareImportRef.current = pending;
    // [契约] 事务开始前必须清掉上一条导入提示，否则新进度会更新到已过期的那条弹窗上。
    // [资源] 句柄清空后由后续提示重新分配，这里不能保留旧编号做复用。
    // [失败路径] 撤下提示失败不影响导入本身，事务继续推进。
    if (importToastIdRef.current !== null) {
      dismissToast(importToastIdRef.current);
      importToastIdRef.current = null;
    }
    // [契约] 操作号是本次事务的唯一身份，进度订阅与结果回写都靠它关联。
    // [权衡] 优先用随机标识，环境缺失时退到时间戳，保证永不返回空串。
    // [失败路径] 同一操作号在事务结束前不得复用，否则进度事件会串到下一轮。
    const operationId = `share-import-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
    importOperationRef.current = operationId;
    lastImportProgressToastRef.current = null;
    // [契约] 进度订阅必须绑定本次操作号，不能订阅全局频道后再自行过滤。
    // [资源] 订阅句柄在收口处统一释放，中途任何异常都不能跳过这一步。
    // [失败路径] 订阅建立失败时事务已经进入活动态，必须仍走收口路径把状态复位。
    const progressEvent =
      baseServices.conversationShareService.onDynamicImportProgress(operationId);
    // [契约] 回调只做提示投影：节流、文案选择、复用同一条弹窗，不写任何业务状态。
    // [并发] 标记位按阶段与时间窗双重判断，同一阶段的重复事件在窗口内直接丢弃。
    // [失败路径] 完成阶段被主动吞掉，终态由后续结果链路统一替换，避免连闪两条。
    // [权衡] 八百毫秒的窗口是体验取舍：再小会闪烁，再大会让进度看起来卡住。
    const disposeProgress = progressEvent((progress) => {
      // [契约] 时间取在回调内部而不是外部闭包，保证节流判断用的是事件到达时刻。
      // [并发] 上一次记录只在真正展示提示后才更新，被丢弃的事件不得刷新时间窗。
      // [失败路径] 记录为空说明是本轮首个事件，必须直接放行。
      const now = Date.now();
      const last = lastImportProgressToastRef.current;
      if (
        last &&
        last.phase === progress.phase &&
        now - last.at < 800 &&
        progress.phase !== "complete"
      ) {
        return;
      }
      // complete 只表示导入事务已经收口；成功结果会在下方统一替换进度提示，避免短暂闪过
      // “导入完成”后又紧接着出现“已从分享导入”的两条成功 Toast。
      if (progress.phase === "complete") {
        return;
      }
      lastImportProgressToastRef.current = { phase: progress.phase, at: now };
      const label =
        progress.phase === "downloading"
          ? intl.formatMessage(
              { id: "conversationShare.import.downloading" },
              { completed: progress.completedArtifacts, total: progress.totalArtifacts },
            )
          : progress.phase === "installing"
            ? intl.formatMessage({ id: "conversationShare.import.installing" })
            : intl.formatMessage({ id: "conversationShare.import.committing" });
      if (importToastIdRef.current === null) {
        importToastIdRef.current = toast(label, { durationMs: 0, variant: "info" });
      } else {
        updateToast(importToastIdRef.current, {
          message: label,
          durationMs: 0,
          variant: "info",
          actionLabel: undefined,
          onAction: undefined,
          dismissible: false,
        });
      }
    });

    // [契约] 请求体只带意图里冻结的字段，不再回读当前 tab 状态，防止中途切换改变落点。
    // [资源] 用 void 标记有意丢弃的 promise：拒绝路径已由失败分支完整接住。
    // [并发] 本轮不再做登录态分叉，服务端会根据分享码自身的可见性决定是否允许导入。
    // [失败路径] 请求发起前已完成全部本地状态切换，因此发起即抛错也会被同一条失败分支收口。
    void baseServices.conversationShareService
      .importShare(
        {
          shareCode: pending.shareCode,
          clientRequestId: pending.clientRequestId,
          ...(pending.targetWorkspacePath
            ? { targetWorkspacePath: pending.targetWorkspacePath }
            : {}),
          ...(pending.targetWorkspaceIdentity
            ? { targetWorkspaceIdentity: pending.targetWorkspaceIdentity }
            : {}),
          ...(pending.targetWorkspaceKind
            ? { targetWorkspaceKind: pending.targetWorkspaceKind }
            : {}),
          locale,
        },
        operationId,
      )
      // [契约] 成功分支的顺序固定：先准备草稿配置，再激活目标 tab，最后才写会话选中项。
      // [失败路径] 目标 tab 激活失败时补建一个会话用途的标签，保证结果一定可见。
      // [并发] 打开可能复用已有会话，因此额外发一次定位请求，让目标面板滚到分享内容。
      // [权衡] 回退落点必须显式告知用户落在哪，提示时长比普通成功提示更长。
      .then((result) => {
        pending.status = "complete";
        // 先准备实际落地工作区的独立草稿，再激活；复用导入不覆盖会话选择。
        const composerConfig = resolveImportedComposerConfig(result, composerClientNamespace);
        const activated = activateTabByPath(
          result.workspacePath,
          result.workspaceIdentity ? { workspaceIdentity: result.workspaceIdentity } : undefined,
        );
        if (!activated) {
          addTab(result.workspacePath, {
            ...(result.workspaceIdentity ? { workspaceIdentity: result.workspaceIdentity } : {}),
            workspacePurpose: "conversation",
          });
        }
        const sessionStore = useZCodeSessionStore.getState();
        sessionStore.setActiveTaskId(
          result.workspacePath,
          result.sessionId,
          result.workspaceIdentity,
          composerConfig,
        );
        // 导入可能复用当前已打开的 session；仅 setActiveTaskId 不会产生可观察的切换。
        // 每次成功都显式发出一次定位请求，目标 pane 准备好分享内容后再消费。
        sessionStore.requestTimelineBottom(
          result.workspacePath,
          result.sessionId,
          result.workspaceIdentity,
        );
        // 回退过的导入会落在与用户当前所看不同的 workspace，必须讲清落在哪、为何回退，
        // 否则用户只会看到会话“跑到别处去了”。
        const resultMessage = result.fallbackReason
          ? intl.formatMessage(
              {
                id:
                  result.fallbackReason === "remote_workspace"
                    ? "conversationShare.import.fallbackRemoteWorkspace"
                    : "conversationShare.import.fallbackDefaultWorkspace",
              },
              { title: result.title, workspacePath: result.workspacePath },
            )
          : intl.formatMessage({ id: "conversationShare.import.source" }, { title: result.title });
        const resultToastOptions = {
          durationMs: result.fallbackReason ? 7000 : 3000,
          variant: result.fallbackReason ? ("info" as const) : ("default" as const),
          actionLabel: undefined,
          onAction: undefined,
          dismissible: false,
        };
        if (importToastIdRef.current === null) {
          importToastIdRef.current = toast(resultMessage, resultToastOptions);
        } else {
          updateToast(importToastIdRef.current, { message: resultMessage, ...resultToastOptions });
        }
      })
      // [契约] 失败分支先把意图状态改为失败，再解析错误，保证重试前状态一致。
      // [失败路径] 错误对象按字段逐层防御读取，非预期结构也不能让提示链路中断。
      // [资源] 诊断信息只记关键标识，不落分享码原文与用户数据。
      // [权衡] 只有可重试的失败才挂重试动作，不可重试的只给说明，避免无效点击。
      .catch((error) => {
        pending.status = "failed";
        const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
        const kind = typeof record.kind === "string" ? record.kind : "unknown";
        const reasonCode = typeof record.reasonCode === "string" ? record.reasonCode : undefined;
        const firstIssue = Array.isArray(record.issues) ? record.issues[0] : undefined;
        const firstIssueRecord =
          firstIssue && typeof firstIssue === "object" && !Array.isArray(firstIssue)
            ? (firstIssue as Record<string, unknown>)
            : undefined;
        const artifactDisplayName =
          typeof firstIssueRecord?.artifactDisplayName === "string"
            ? firstIssueRecord.artifactDisplayName
            : undefined;
        const diagnostics = getConversationShareErrorDetails(error);
        logger.warn("[Root] share import failed", {
          status: diagnostics.status,
          code: diagnostics.code,
          requestId: diagnostics.requestId,
          operationId,
          clientRequestId: pending.clientRequestId,
          kind,
          ...(reasonCode ? { reasonCode } : {}),
          ...(typeof record.issueCount === "number" ? { issueCount: record.issueCount } : {}),
        });
        const failurePresentation = resolveShareImportFailurePresentation(kind);
        const retryImport = () => {
          pending.status = "received";
          pendingShareImportRef.current = pending;
          setShareImportRevision((revision) => revision + 1);
        };
        const detailedMessageId =
          artifactDisplayName && kind === "invalid_contract"
            ? "conversationShare.import.integrityFailedWithArtifact"
            : artifactDisplayName && kind === "network"
              ? "conversationShare.import.failedWithArtifact"
              : failurePresentation.messageId;
        const failureMessage = intl.formatMessage(
          { id: detailedMessageId },
          artifactDisplayName ? { artifactDisplayName } : undefined,
        );
        const failureToastOptions = {
          durationMs: 7000,
          ...(failurePresentation.retryable
            ? {
                actionLabel: intl.formatMessage({ id: "conversationShare.import.retry" }),
                onAction: retryImport,
              }
            : {}),
          dismissible: true,
          variant: "default" as const,
        };
        if (importToastIdRef.current === null) {
          importToastIdRef.current = toast(failureMessage, failureToastOptions);
        } else {
          updateToast(importToastIdRef.current, {
            message: failureMessage,
            ...failureToastOptions,
          });
        }
      })
      // [契约] 收口只在 `finally` 发生：退订并清空 `activeIntent` 与操作号，最后自增版本号唤醒下一轮。
      // [资源] 释放顺序不能调整：先断订阅再清槽位，否则末条进度事件会写进已结束的事务。
      // [并发] 版本号自增是最后一个动作，保证下一轮读到的是全部清理完成后的快照。
      // [失败路径] 即使成功与失败分支都抛错，这里仍会执行，这是事务不悬挂的唯一保证。
      .finally(() => {
        disposeProgress.dispose();
        activeShareImportRef.current = null;
        importOperationRef.current = null;
        setShareImportRevision((revision) => revision + 1);
      });
  }, [
    activateTabByPath,
    addTab,
    baseServices,
    intl,
    isRestoringOAuthSession,
    locale,
    shareImportRevision,
    composerClientNamespace,
  ]);

  useEffect(() => {
    // [契约] 窗口标签同步只对桌面端、且全量恢复完成后生效，两个条件缺一不可。
    // [失败路径] 恢复未完成时直接跳过，宁可让主进程暂时保留旧列表，也不发布半份快照。
    // [并发] tabs 每次变化都会触发一次同步，主进程侧是幂等覆盖，不需要额外去抖。
    // [权衡] 过滤放在渲染后的 effect 里而不是选择器里，避免订阅层承担业务过滤。
    if (!isDesktop || !shouldPublishCompleteWorkspaceSnapshot(hasCompletedFullTabRestore)) {
      return;
    }

    const paths = tabs
      .filter(isWorkspaceTab)
      // 启动期远程 workspace 现在会先以“断开占位 tab”恢复，
      // 这些 tab 没有 remoteSessionId，但本质仍是远程会话，不能当成本地路径同步给主进程窗口列表。
      // 这里改成按完整远程身份字段过滤，避免把远程路径误同步到本地窗口标签。
      .filter((tab) => !tab.remoteSessionId && !tab.workspaceIdentity && !tab.remoteTarget)
      .map((tab) => tab.workspacePath);
    // [契约] 只有本地、且无远程身份的 workspace 才能进主进程窗口列表。
    // [失败路径] 启动期远程断连占位标签没有会话号但有身份，必须按身份字段整体排除。
    // [权衡] 用完整远程身份过滤而不是只查会话号，代价是多两次字段判断，换来远程路径不串成本地。
    platform.syncWindowTabs(paths);
  }, [hasCompletedFullTabRestore, isDesktop, platform, tabs]);

  // [契约] 远控工作区同步整体下沉到独立 hook，这里只负责把当前快照传进去。
  // [并发] 传入的是每次渲染的最新值，由 hook 内部决定何时发布，本文件不缓存。
  // [失败路径] 功能开关与恢复完成标志一并传入，关闭时不注册任何监听。
  useWebRemoteControlWorkspaceSync({
    platform,
    tabs,
    isDesktop: Boolean(isDesktop),
    featureEnabled: webRemoteControlFeatureEnabled,
    hasCompletedFullTabRestore,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
  });

  useEffect(() => {
    // [契约] Web 端没有宿主菜单，因此在这里补一层键盘兜底，桌面端必须完全跳过。
    // [资源] 监听以捕获阶段注册，并在清理时用同样的捕获标志移除，两侧标志必须一致。
    // [并发] 依赖变化会重挂监听，回调里只读本次渲染的动作引用，不做缓存。
    // [失败路径] 早退放在注册之前，桌面端连监听函数都不会创建。
    if (isDesktop) {
      return;
    }

    // [契约] 录制态键盘归录制器独占，这里必须先短路再判断快捷键。
    // [失败路径] 本监听与录制监听同处捕获阶段且注册更早，不短路会让录制中的按键真实生效。
    // [权衡] 只识别新建任务与打开工作区两个动作，其余按键一律放行，避免与输入框竞争。
    // [并发] 事件对象只在本次调用内使用，不保存到任何外部变量。
    function handleWindowKeydown(event: KeyboardEvent) {
      // 录制态键盘归录制器独占。本监听先于录制监听注册（同 capture 阶段），
      // 不短路的话录制期按 Cmd/Ctrl+N、O 预览会真实触发新建任务/打开工作区。
      if (isShortcutRecordingActive()) {
        return;
      }
      const isNewTaskShortcut = matchesPrimaryShortcut(event, "n");
      const isOpenWorkspaceShortcut = matchesPrimaryShortcut(event, "o");

      if (!isNewTaskShortcut && !isOpenWorkspaceShortcut) {
        return;
      }

      // Web 端没有宿主菜单，补一层 best-effort 键盘监听，按平台主修饰键落到同一套根级动作。
      // 耦合说明：这里固定使用默认键位（Ctrl/Cmd+N、+O），与「menu 通道命令在 Web 端不可配置」
      // （设置页置灰）配套——若未来放开 Web 端 menu 通道改键，
      // 此处必须改为读快捷键生效表，否则用户改键后 Web 行为会分裂。
      event.preventDefault();
      if (isOpenWorkspaceShortcut) {
        openWorkspace();
        return;
      }

      startNewTaskFromActiveWorkspace("web CmdOrCtrl+N");
    }

    // [契约] 命中后先阻止默认行为再执行动作，顺序反了浏览器会先处理默认快捷键。
    // [失败路径] 打开工作区命中即返回，不会顺带触发新建任务。
    // [权衡] 键位固定在默认值，与设置页禁用 Web 改键的规则配套；放开改键时必须改读生效表。
    window.addEventListener("keydown", handleWindowKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeydown, true);
    };
  }, [isDesktop, openWorkspace, startNewTaskFromActiveWorkspace]);

  useEffect(() => {
    if (!isDesktop) {
      return;
    }

    // [契约] 语言同步只在桌面端执行，Web 端菜单由页面本身渲染，不需要通知主进程。
    // [并发] 每次语言变化都会重挂，卸载标志用于识别上一轮已失效的迟到回调。
    // [失败路径] 同步失败只记日志，不阻塞界面，也不回滚用户选择的语言。
    // [权衡] 不等待同步结果：菜单重建是尽力而为，等它会拖慢每次语言切换。
    let disposed = false;

    // 原生菜单文案之前在 main 进程里写死，renderer 切换 locale 只会更新 React 标题栏菜单。
    // 结果就是桌面端会同时出现两套语言，Help 里的反馈/导出日志也无法跟随当前语言切换。
    // 这里把当前 locale 主动同步给 main，让原生菜单和标题栏菜单都从同一份语言状态重建。
    // [契约] 当前语言是唯一事实来源，主进程菜单从这里重建，不在主进程维护第二份。
    // [失败路径] 请求在卸载后才失败时不记日志，避免切换语言时出现无意义的旧错误。
    // [资源] `setApplicationLocale` 不持有订阅，无需额外释放；仅靠 `disposed` 判有效性。
    platform.setApplicationLocale(locale).catch((error) => {
      if (disposed) {
        return;
      }
      logger.error("[Root] 同步应用菜单语言失败", { locale, error });
    });

    return () => {
      disposed = true;
    };
  }, [isDesktop, locale, platform]);

  const activeTabId = useTabStore((state: TabStoreState) => state.activeTabId);
  const activeTabCandidate = useTabStore((state: TabStoreState) =>
    state.tabs.find((tab: WindowTabState) => tab.id === state.activeTabId),
  );
  const activeTab =
    activeTabCandidate && isWorkspaceTab(activeTabCandidate) ? activeTabCandidate : undefined;
  // [契约] 活动会话同步以 ref 去重：值不变就不通知主进程，避免高频重复推送。
  // [资源] 订阅返回值就是清理函数，直接作为 effect 的清理出口，不再包一层。
  // [失败路径] 无活动工作区时推送空值，确保主进程不会保留已关闭工作区的旧会话。
  const lastSyncedSessionIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!isDesktop) return;
    const workspacePath = activeTab?.workspacePath;
    const workspaceIdentity = activeTab?.workspaceIdentity;
    const syncActiveSession = (): void => {
      const nextSessionId = workspacePath
        ? (useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
            .activeTaskId ?? null)
        : null;
      if (nextSessionId === lastSyncedSessionIdRef.current) return;
      lastSyncedSessionIdRef.current = nextSessionId;
      platform.syncActiveTaskSession(nextSessionId);
    };
    syncActiveSession();
    return useZCodeSessionStore.subscribe(syncActiveSession);
  }, [activeTab, activeTabId, isDesktop, platform]);
}
