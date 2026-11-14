// 全局工作流组的状态与动作。抽成 hook 让组件文件守住
// max-lines 400；载体是 `useServices().zcodeAgentService`，RPC 一律带 `{ scope: "global" }`。
// INV-01 请求代际由 refreshSeq 单调推进，同一个值只允许触发一次重拉；守住位置：lastRefreshSeq 的早返回；改错故障：父层每次重渲染都重复拉取，列表在旧缓存与新结果之间闪烁并吞掉用户刚做的改动。
// INV-02 refresh 的函数身份只能随 agentService 与 load 变化，options 不得进入依赖；守住位置：refresh 的 useCallback 依赖数组；改错故障：身份每帧变化让挂载 effect 反复执行，形成拉取与重渲染的自激循环。
// INV-03 首帧加载只由 [refresh] 的那条 effect 发起，不得再补一条空依赖 effect；守住位置：挂载时的 refresh 调用；改错故障：两条 effect 同时触发，RPC 翻倍且与目录监听回调互相覆盖。
// INV-04 loaded 为 false 时 count 必须报 0 且 empty 必须为 false，未加载不得自称空分组；守住位置：count 与 empty 的取值表达式；改错故障：首帧闪出「暂无工作流」并弹出创建引导，用户以为数据丢了。
// INV-05 empty 只在 loaded 且 entries 与 invalid 同时为空时成立；守住位置：empty 的三项与判断；改错故障：只剩非法文件的目录被当成空目录，界面引导新建同名工作流，覆盖尚可人工修复的文件。
// INV-06 onStateChange 上报的三元组必须取自同一次渲染快照；守住位置：上报 effect 的入参对象；改错故障：父层 tab 徽标显示 3 条而列表只有 2 条，用户反复刷新仍对不上。
// INV-07 上报 effect 的依赖必须覆盖 count、empty、state.loaded 与 onStateChange；守住位置：该 effect 的依赖数组；改错故障：漏掉回调时父层永远收不到 loaded 翻转，加载骨架屏不消失。
// INV-08 卸载后唯一允许的异步写入是时间戳 state 的更新，不得在 then 里追加弹窗或忙名复位；守住位置：refresh 的 await 之后；改错故障：组件已卸载仍改 launchEntry，重新打开弹窗时带着上次的陈旧条目。
// INV-09 本地项目派生的 resolveRunProject 与 actionTarget 必须走 useMemo 且依赖完整；守住位置：两处 useMemo 的依赖数组；改错故障：每帧返回新对象使子组件 memo 全失效，长列表滚动掉帧。
// INV-10 actionTarget 为空时修改与新建入口必须整体早返回，不得回落到默认项目；守住位置：handleRevise 与 handleCreateViaChat 的首个判断；改错故障：改稿落到错误工作区，用户在原文件里找不到任何变化。
// INV-11 launch 必须要求显式 target，缺省立即返回；守住位置：launch 的首个判断；改错故障：没有「运行于」目标也发起 RPC，后端按空路径解析到用户主目录。
// INV-12 运行弹窗的 pending 与 error 互斥，pending 期间不得呈现旧错误；守住位置：launcher 返回值的透传；改错故障：重试时错误文案与进度同时出现，用户以为第二次也失败了。
// INV-13 打开运行弹窗前必须清掉上一次的错误；守住位置：handleRun 的首行；改错故障：换一条工作流仍显示上一条的失败原因，用户误判为同一条反复失败。
// INV-14 全局档的删除与移动 RPC 必须显式带 scope 为 global；守住位置：deleteSavedWorkflow 与 moveSavedWorkflow 的入参；改错故障：省略后请求落到项目档，用户以为删掉全局条目，实际删掉同名项目副本。
// INV-15 删除成功且当前详情正是该条目时必须回退列表；守住位置：handleDelete 的 mode 判断；改错故障：详情页停留在已删除条目上，再点任意操作都报找不到文件。
// INV-16 删除与移动的刷新必须在 finally 里以 bypassCache 执行，忙名复位同样在 finally；守住位置：两个处理函数的 finally 分支；改错故障：失败路径不刷新让列表保留已消失的条目，忙名不复位则按钮永久转圈。
// INV-17 busyName 只由删除与移动写入，且同一时刻只服务于一个条目；守住位置：handleDelete 与 handleMoveSubmit 的赋值；改错故障：并发两次删除时后一次复位提前解开前一行的 spinner，用户重复点击造成二次删除。
// INV-18 复制路径失败只记录日志，不得抛错也不得弹出失败提示；守住位置：handleCopyPath 的 catch；改错故障：剪贴板被拒时异常冒到事件处理之外，整块设置页渲染中断。
// INV-19 运行与产物的反查只认 run.cwd，反查不到时两个入口同时关闭；守住位置：resolveRunTarget 与 openers 的接线；改错故障：回落到当前项目会把实例开在发起它的项目之外，产物写进错误的仓库。
// INV-20 目录监听必须复用同一个 refresh 身份才能重挂，且只在 refresh 变化时重建；守住位置：useSavedWorkflowsDirectoryWatch 的入参；改错故障：传入内联函数会让 watcher 每帧重建，句柄泄漏并漏掉期间的写盘事件。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeSavedWorkflowEntry, ZCodeSavedWorkflowRun } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import { useSavedWorkflowsDirectoryWatch } from "@/settings/saved-workflows/useSavedWorkflowsDirectoryWatch.js";
import {
  buildSavedWorkflowCreatePrompt,
  buildSavedWorkflowRevisePrompt,
} from "@/settings/saved-workflows/savedWorkflowLaunchPrompt.js";
import {
  useSavedWorkflowLauncher,
  type SavedWorkflowLaunchTarget,
} from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";
import { lastRunByWorkflowName } from "@/settings/saved-workflows/savedWorkflowRunHistory.js";
import {
  GLOBAL_SAVED_WORKFLOW_TARGET,
  buildGlobalRunProjectResolver,
  findProjectByCwd,
  resolveGlobalActionTarget,
} from "@/settings/saved-workflows/globalWorkflowGroupHelpers.js";
import type { SavedWorkflowGroupMode } from "@/settings/saved-workflows/SavedWorkflowProjectGroup.js";
import { useSavedWorkflowRunOpeners } from "@/settings/saved-workflows/useSavedWorkflowRunOpeners.js";
import type {
  SavedWorkflowProjectTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/savedWorkflowContract.js";
import { selectSavedWorkflowState, useSavedWorkflowStore } from "@/store/savedWorkflowStore.js";

interface UseSavedWorkflowGlobalGroupParams {
  refreshSeq: number;
  mode: SavedWorkflowGroupMode;
  onStateChange: (key: "global", state: { loaded: boolean; empty: boolean; count: number }) => void;
  onOpenDetail: (name: string) => void;
  onBack: () => void;
  /** 「运行」= GUI 直接启动：accepted 后切到新会话。 */
  onNavigateToLaunchedRun?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
  onCreateViaChat?: (prompt: string, target: SavedWorkflowProjectTarget) => void;
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  /** 产物 chip → `workflow-artifact` tab。 */
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
  localProjects: readonly AutomationWorkspaceOption[];
  activeProjectKey: string | null;
  onMoved: () => void;
}

export function useSavedWorkflowGlobalGroup({
  refreshSeq,
  mode,
  onStateChange,
  onOpenDetail,
  onBack,
  onNavigateToLaunchedRun,
  onCreateViaChat,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  localProjects,
  activeProjectKey,
  onMoved,
}: UseSavedWorkflowGlobalGroupParams) {
  const { intl, locale } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const { zcodeAgentService: agentService, fileWatcherService } = useServices();

  // 订阅收敛到 selectSavedWorkflowState 这一次选择：返回对象由 store 侧按引用复用，
  // 若在组件里另拼新对象，zustand 的相等判断会每帧失败，导致无限重渲染。
  // [并发] 目录监听回调与 refreshSeq 触发的拉取都会写同一个全局槽位，选择器只读快照，
  // 因此组件看到的一定是某次完整写入后的状态，不会读到半更新的 entries。
  // loaded、entries、invalid、dir、runs 五个字段必须来自同一次快照，
  // 分开订阅会让列表已换新而 lastRuns 仍是上一轮，最近运行时间显示串行。
  // [权衡] 不做本地镜像 state，避免出现两份真相；代价是每次 store 变更都要重跑选择器。
  const state = useSavedWorkflowStore((store) =>
    selectSavedWorkflowState(store, GLOBAL_SAVED_WORKFLOW_TARGET),
  );
  const load = useSavedWorkflowStore((store) => store.load);
  const [launchEntry, setLaunchEntry] = useState<ZCodeSavedWorkflowEntry | null>(null);
  const [moveEntry, setMoveEntry] = useState<ZCodeSavedWorkflowEntry | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // [权衡] options 作为参数而不是依赖：把 bypassCache 拉进依赖会让每次调用生成新身份，
  // 挂载 effect 与目录监听会跟着重挂，watcher 重建期间丢事件。
  // 依赖只保留 agentService 与 load，两者在应用生命周期内稳定，
  // 因此 refresh 身份稳定，effect 的 [refresh] 实际等价于只跑一次。
  // setNow 排在 load 之后：时间戳代表这份快照的获取时刻，
  // 先写时间戳会让「刚刚刷新」的文案早于真实数据，用户看到旧列表配新时间。
  // [失败路径] load 抛错时 setNow 不执行，时间戳停在上一份成功快照，界面不会谎报新鲜度。
  const refresh = useCallback(
    async (options: { bypassCache?: boolean } = {}) => {
      await load(GLOBAL_SAVED_WORKFLOW_TARGET, agentService, options);
      setNow(Date.now());
    },
    [agentService, load],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // [并发] 用 ref 记住已消费的代际，而不是 state：写 ref 不触发渲染，
  // 否则「记录代际」本身会把 effect 再排一轮，形成额外的一次拉取。
  // 早返回保证同一代际只消费一次，StrictMode 的双次挂载也只拉一次。
  // 顺序必须是先比对、再写 ref、最后发请求：先写后比对会把本次变化吞掉。
  // 请求不带取消：更晚的代际不会中断在途请求，旧响应晚到会覆盖新结果。
  // [失败路径] bypassCache 只影响缓存，不改变代际语义；失败后仍要等下一次序号前进才能重试。
  // [权衡] 彻底避免需要给 load 传取消信号并在 cleanup 里终止，
  // 这里接受最后一次写入者获胜，代价是极端时序下多一次列表闪烁。
  const lastRefreshSeq = useRef(refreshSeq);
  useEffect(() => {
    if (lastRefreshSeq.current === refreshSeq) return;
    lastRefreshSeq.current = refreshSeq;
    void refresh({ bypassCache: true });
  }, [refresh, refreshSeq]);

  // 目录监听：list 回的绝对目录（`~/.zcode/workflows`）本机可直接 watch。
  useSavedWorkflowsDirectoryWatch({
    fileWatcherService,
    directory: state.dir,
    enabled: true,
    refresh,
  });

  // 三态语义：未加载、已加载但为空、已加载且有内容，父层只认这一份判定。
  // empty 把 invalid 也算进来：只剩损坏文件的目录不是空目录，
  // 否则界面会引导用户新建同名工作流，把还能人工修复的文件覆盖掉。
  // count 只数 entries，不含 invalid：徽标语义是「可运行的工作流数量」。
  // 未 loaded 时 count 归零而不是沿用上一次的值，
  // 避免切换 scope 时先显示上一个分组的条数再跳变。
  // [权衡] 不把 invalid 计入 count，是为了让计数与列表可视条数保持一致。
  const empty = state.loaded && state.entries.length === 0 && state.invalid.length === 0;
  const count = state.loaded ? state.entries.length : 0;
  useEffect(() => {
    onStateChange("global", { loaded: state.loaded, empty, count });
  }, [count, empty, onStateChange, state.loaded]);

  // 最近运行表按工作流名归并，供卡片直接取用；上游 runs 是数组，逐条扫是 O(n)。
  // useMemo 只在 runs 换引用时重算：store 每次写入都产生新数组，
  // 因此这里实际是「每次 run 变化重算一次」，而不是每帧重算。
  // resolveRunProject 把本地项目列表预先编译成 cwd 到项目的映射，
  // 卡片渲染时不再线性查找，列表滚动时才不会随项目数增长而线性变慢。
  // [权衡] 两个 memo 分开而不是合成一个对象，避免 runs 变化连带重建项目映射。
  const lastRuns = useMemo(() => lastRunByWorkflowName(state.runs), [state.runs]);
  const resolveRunProject = useMemo(
    () => buildGlobalRunProjectResolver(localProjects),
    [localProjects],
  );
  const actionTarget = useMemo(
    () => resolveGlobalActionTarget(localProjects, activeProjectKey),
    [activeProjectKey, localProjects],
  );

  // GUI 直接启动器：全局档载体 = 本机 base agent service，目标 = 「运行于」选中的本地项目。
  // launcher 持有本次运行的在途状态与错误，是弹窗的唯一真相，
  // 本 hook 不再另存一份 pending 或 error，避免两处状态互相追不上。
  // [失败路径] pending 与 error 由 launcher 内部互斥维护，新一轮开始时先清错，
  // 因此弹窗不会同时显示转圈和上次的失败原因。
  // [资源] launcher 的清理随组件卸载进行，本文件不得把它提升到模块级单例，
  // 否则关掉设置页后仍有一个在途启动器在写已卸载的 UI。
  const launcher = useSavedWorkflowLauncher({
    agentService,
    onNavigate: onNavigateToLaunchedRun,
  });

  // 全局档一律弹窗——即使无实参，也需要「运行于」选择器。
  const handleRun = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => {
      launcher.clearError();
      setLaunchEntry(entry);
    },
    [launcher],
  );
  // 目标必须先由用户在「运行于」里选中：没有 target 就不发请求，
  // 因为全局条目本身不知道应落在哪个工作区。
  // 入参只传 name、scope 与 args；路径由 target 提供，不由条目自带路径推断。
  // workspaceIdentity 用条件展开而不是写 undefined：后端按字段存在与否分流，
  // 显式传 undefined 可能被序列化成字符串 undefined 而让后端校验失败。
  // [失败路径] 仅 ok 时关闭弹窗；失败保留实参让用户改完重试，
  // 错误由 launcher 透出行内展示，不需要额外的 toast 抢焦点。
  const launch = useCallback(
    async (
      entry: ZCodeSavedWorkflowEntry,
      args: Record<string, unknown>,
      target?: AutomationWorkspaceOption,
    ) => {
      if (!target) return;
      const result = await launcher.launch(
        {
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
        },
        { name: entry.name, scope: "global", args },
      );
      // 成功：launcher 已切到新会话，关掉实参窗；失败留窗 + 行内错误（launcher.error）。
      if (result.ok) setLaunchEntry(null);
    },
    [launcher],
  );
  const handleRevise = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => {
      if (!actionTarget) return;
      onCreateViaChat?.(
        buildSavedWorkflowRevisePrompt({
          name: entry.name,
          path: entry.path,
          locale,
          scope: "global",
        }),
        actionTarget,
      );
    },
    [actionTarget, locale, onCreateViaChat],
  );
  const handleCreateViaChat = useCallback(() => {
    if (!actionTarget) return;
    onCreateViaChat?.(buildSavedWorkflowCreatePrompt(locale, "global"), actionTarget);
  }, [actionTarget, locale, onCreateViaChat]);
  const handleCopyPath = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => {
      void navigator.clipboard
        ?.writeText(entry.path)
        .then(() => toast(intl.formatMessage({ id: "workflows.hub.copied" })))
        .catch((error: unknown) => {
          logger.warn("[SavedWorkflows] 复制路径失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [intl],
  );
  // [事务] 删除是确认、RPC、刷新三步，任何一步失败都不能让界面假装已完成：
  // 确认被取消时直接返回，不写 busyName，也不刷新。
  // 成功与失败都要在 finally 里 bypassCache 重拉，
  // 因为服务端可能已部分落盘，缓存里的条目不能作为真相。
  // 忙名在 finally 复位而不是成功分支，否则异常会让该行永久显示进行中。
  // 若当前正停在这条目的详情，删除后必须回退，否则详情页指向不存在的文件。
  const handleDelete = useCallback(
    async (entry: ZCodeSavedWorkflowEntry) => {
      const confirmed = await requestConfirmation({
        title: intl.formatMessage({ id: "workflows.hub.delete.title" }, { name: entry.name }),
        description: intl.formatMessage(
          { id: "workflows.hub.delete.description" },
          { path: entry.path },
        ),
        confirmLabel: intl.formatMessage({ id: "workflows.hub.delete.confirm" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      setBusyName(entry.name);
      try {
        const result = await agentService.deleteSavedWorkflow({
          scope: "global",
          name: entry.name,
        });
        if (!result.ok) {
          toast(
            intl.formatMessage(
              { id: "workflows.hub.deleteFailed" },
              { reason: intl.formatMessage({ id: `workflows.hub.reason.${result.reason}` }) },
            ),
          );
          return;
        }
        toast(intl.formatMessage({ id: "workflows.hub.deleted" }, { name: entry.name }));
        if (mode.kind === "detail" && mode.name === entry.name) onBack();
      } catch (error) {
        toast(
          intl.formatMessage(
            { id: "workflows.hub.deleteFailed" },
            { reason: error instanceof Error ? error.message : String(error) },
          ),
        );
      } finally {
        setBusyName(null);
        void refresh({ bypassCache: true });
      }
    },
    [agentService, intl, mode, onBack, refresh, requestConfirmation],
  );
  const handleCardDelete = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => void handleDelete(entry),
    [handleDelete],
  );
  const handleCardMove = useCallback((entry: ZCodeSavedWorkflowEntry) => setMoveEntry(entry), []);
  const handleOpen = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => onOpenDetail(entry.name),
    [onOpenDetail],
  );
  // 全局档的目标项目按 `run.cwd` 反查已打开项目；没打开就两个入口都关掉
  // （实例必须开在发起它的项目）。门与实参构造与项目档共用（产物不需要 toolCallId）。
  // [失败路径] run.cwd 反查之前打开过的项目，查不到就返回 null，
  // 门控在 openers 内部把 null 转成两个入口都禁用，绝不回落到当前项目。
  // 实例必须开在发起它的项目里：产物相对路径与工作区绑定，
  // 回落到当前项目会把产物写进另一个仓库，用户在原仓库找不到文件。
  // 依赖只有 localProjects：run 是入参，不进依赖，避免每次卡片渲染换身份。
  // [权衡] 反查失败不弹提示，仅禁用入口，避免历史列表里堆满无法打开的告警。
  const resolveRunTarget = useCallback(
    (run: ZCodeSavedWorkflowRun) => findProjectByCwd(localProjects, run.cwd) ?? null,
    [localProjects],
  );
  const { handleOpenArtifact, handleOpenRun } = useSavedWorkflowRunOpeners({
    resolveTarget: resolveRunTarget,
    ...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun }),
    ...(onOpenWorkflowArtifact === undefined ? {} : { onOpenWorkflowArtifact }),
  });

  // 异步开始前把 moveEntry 固定到局部 entry：等待期间用户可能关掉弹窗或换一条，
  // 后续成功与失败分支都只看这份快照，避免把结果写到另一条上。
  // [事务] 成功后依次提示、关弹窗、必要时回退详情、通知父层重载，顺序不能省：
  // 少了 onMoved，源分组仍列着已搬走的条目，用户以为移动失败又点一次。
  // target_exists 与其它失败分开提示：前者是目标已有同名文件，
  // 用户要做的是改名而不是盲目重试；失败一律留在弹窗里可改目标。
  const handleMoveSubmit = useCallback(
    async (target: AutomationWorkspaceOption) => {
      const entry = moveEntry;
      if (!entry) return;
      setBusyName(entry.name);
      try {
        const result = await agentService.moveSavedWorkflow({
          workspacePath: target.workspacePath,
          ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
          name: entry.name,
        });
        if (result.ok) {
          toast(
            intl.formatMessage(
              { id: "workflows.hub.move.toast.project" },
              { project: target.label },
            ),
          );
          setMoveEntry(null);
          if (mode.kind === "detail" && mode.name === entry.name) onBack();
          onMoved();
          return;
        }
        toast(
          intl.formatMessage(
            {
              id:
                result.reason === "target_exists"
                  ? "workflows.hub.move.targetExists"
                  : "workflows.hub.move.failed",
            },
            { reason: result.reason },
          ),
        );
      } catch (error) {
        toast(
          intl.formatMessage(
            { id: "workflows.hub.move.failed" },
            { reason: error instanceof Error ? error.message : String(error) },
          ),
        );
      } finally {
        setBusyName(null);
      }
    },
    [agentService, intl, mode, moveEntry, onBack, onMoved],
  );

  return {
    agentService,
    state,
    now,
    busyName,
    launchEntry,
    launchPending: launcher.pending,
    launchError: launcher.error,
    moveEntry,
    actionTarget,
    lastRuns,
    resolveRunProject,
    refresh,
    setLaunchEntry,
    setMoveEntry,
    handleRun,
    launch,
    handleRevise,
    handleCreateViaChat,
    handleCopyPath,
    handleDelete,
    handleCardDelete,
    handleCardMove,
    handleOpen,
    handleOpenRun,
    handleOpenArtifact,
    handleMoveSubmit,
  };
}
