/* eslint-disable max-lines -- workspace 的 task、自动化与插件市场共享浏览器式历史，集中处理才能保证前进/后退目标一致。 */
// INV-01 每个对外回调都必须由 useCallback 包裹，且依赖数组覆盖其读取的全部外部值；守住位置：handleSelectTask、handleOpenAutomations、handleOpenPluginStore、handleTaskNavBack、handleTaskNavForward 的依赖数组；改错故障：漏写依赖让回调持有上一轮 render 的 workspace 标识，点击任务时把未读清到另一个工作区
// INV-02 模型重启锁必须在选择、后退、前进三个入口各自判定，不能只依赖按钮禁用态；守住位置：handleSelectTask 开头与两个导航循环之前的 shouldBlockTaskSelectionDuringModelRestart 判断；改错故障：快捷键或程序化调用绕过禁用按钮，resumeTask 与 runtime 重建并发，任务被误判为恢复失败
// INV-03 选择任务必须先激活目标 tab、再读取 activeTab，顺序颠倒读到的是旧页签；守住位置：handleSelectTask 中 activateTabByPath 与随后的 tabStoreApi.getState 调用先后；改错故障：同路径多 remote tab 时未读被写到另一条连接，用户看到别的机器上的任务变已读
// INV-04 目标 workspace 匹配必须比较路径与 workspaceIdentity 组成的 key，不能只看路径；守住位置：handleSelectTask 的 activeWorkspaceTabMatchesTarget；改错故障：本地与远端同路径页签互相命中，remoteSessionId 取自错误的页签
// INV-05 remoteSessionId 只能来自匹配成功的 activeTab，匹配失败必须留空；守住位置：resolvedRemoteSessionId 的三元表达式；改错故障：未读清理发给错误的远端会话，另一台设备上的未读状态被抹掉
// INV-06 未读清理是 compare-and-clear：必须以行快照或 query cache 的 unreadAt 作为 expectedUnreadAt，不得无条件清零；守住位置：expectedUnreadAt 与 shouldClearUnread 的计算；改错故障：并发到达的新未读被本地清零覆盖，消息到了却不显示蓝点
// INV-07 乐观 overlay 必须与回滚严格配对，任何未发出写请求或写失败的分支都要写回 previousUnreadAt；守住位置：setTaskQueryCacheUnreadOverlay 与 rollbackTaskQueryCacheUnread 的两处调用；改错故障：失败后蓝点永久消失，用户漏看新消息直到重启应用
// INV-08 远程 workspace 拿不到 services 时必须放弃清理而不是回退 baseServices；守住位置：targetServices 的三元与随后的空值分支；改错故障：连接断开时把相同路径的另一个工作区未读清掉
// INV-09 清除未读成功后要 bumpTaskListMembershipVersion，失败路径除 bump 外还必须 markTaskQueryCacheScopesStale；守住位置：setTaskUnread 的 then 与 catch；改错故障：列表沿用旧 membership 快照，蓝点与服务端状态长期不一致
// INV-10 setActiveTaskId 必须是选择流程的最后一步，且排在未读事务之后；守住位置：handleSelectTask 末尾的 setActiveTaskId 与 onNavigateToTask 调用；改错故障：active task 提前切换触发投影恢复，随后未读回滚把刚打开的任务标成未读
// INV-11 导航历史条目是不可变值，回调只能 push、back、forward，不得就地改写数组；守住位置：taskNavPushAutomations、taskNavPushPluginStore、taskNavGoBack、taskNavGoForward 的调用点；改错故障：canGoBack 与栈内容脱节，按钮显示可用但点击无反应
// INV-12 入栈只发生在用户显式打开，历史回放不得再次入栈；守住位置：handleOpenAutomations 与两个导航回调的分工；改错故障：后退一次又被回放逻辑推回去，历史无限增长且前进后退在同一页打转
// INV-13 automationId 必须 trim 后为空即视为 undefined，入栈与回调共用同一个规范化结果；守住位置：normalizedAutomationId 的计算与两处消费；改错故障：空字符串条目与无 id 条目被当作两个目标，后退要多点一次才回到列表
// INV-14 历史条目分发顺序固定为 automations、plugin store、task，每类命中后立即 return；守住位置：两个导航循环内的 isAutomationsNavEntry 与 isPluginStoreNavEntry 分支；改错故障：plugin store 条目落进 task 分支，被当成已删除任务清理掉
// INV-15 不存在的目标必须先从历史移除、再继续同方向查找，不能终止循环；守住位置：两个循环末尾的 removeTaskFromNavHistory 与再次调用的 goBack 或 goForward；改错故障：删掉一个任务后后退键变成死键，用户卡在当前页无法返回
// INV-16 每次导航命令只取一次 taskMetaByEntityKey 快照，循环内复用；守住位置：两个回调里 useTaskQueryCacheStore.getState 的位置；改错故障：循环中重复读取让存在性判断前后不一致，同一条目被跳过又被命中
// INV-17 循环必须有终止保证：每次迭代要么 return，要么消费掉一个历史条目；守住位置：两个 while 循环的分支结构；改错故障：历史里堆积同类失效条目时点击长时间无响应甚至占满主线程
// INV-18 前进与后退的存在性判断必须使用同一套 taskNavigationTargetExists 与 getVisibleTaskMetas；守住位置：两个回调中重复的 exists 计算；改错故障：同一任务后退可见、前进不可见，导航方向语义不对称
// INV-19 canGoBack 与 canGoForward 只能从历史快照派生，模型重启锁只影响 canTaskNavBack 与 canTaskNavForward；守住位置：末尾四个派生常量的计算；改错故障：锁定期间把浏览历史本身判成不可用，解锁后按钮仍保持灰色
// INV-20 锁定态下被拦截的点击只提示、不修改历史，不得出栈；守住位置：两个导航回调开头的 toast 与 return；改错故障：拦截一次点击却消耗一个历史位置，用户解锁后少一次可回退目标
import { useCallback } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
  canGoBack as navCanGoBack,
  canGoForward as navCanGoForward,
  isAutomationsNavEntry,
  isPluginStoreNavEntry,
  type AutomationsNavigationTab,
} from "@/lib/taskNavigationHistory.js";
import { shouldBlockTaskSelectionDuringModelRestart } from "@/lib/taskSwitchGuard.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { getVisibleTaskMetas, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  markTaskQueryCacheScopesStale,
  reconcileTaskQueryCacheUnread,
  rollbackTaskQueryCacheUnread,
  setTaskQueryCacheUnreadOverlay,
  useTaskQueryCacheStore,
} from "@/store/taskQueryCacheStore.js";
import { taskNavigationTargetExists } from "@/lib/taskNavigationTarget.js";
import { getRemoteWorkspaceSession } from "@/store/remoteWorkspaceSessionStore.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { bumpTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";

export interface AutomationsNavigationTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  automationId?: string;
  automationTab?: AutomationsNavigationTab;
}

export function useWorkspaceTaskNavigation({
  intl,
  workspaceAbsPath,
  workspaceIdentity,
  activateTabByPath,
  onNavigateToTask,
  onNavigateToAutomations,
  onNavigateToPluginStore,
}: {
  intl: { formatMessage: (descriptor: { id: string }) => string };
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  onNavigateToTask?: () => void;
  onNavigateToAutomations?: (target: AutomationsNavigationTarget) => void;
  onNavigateToPluginStore?: (target: Omit<AutomationsNavigationTarget, "automationId">) => void;
}) {
  // 跨 workspace 选择会先同步切换 tab，但本次 React render 捕获的 ambient
  // services 仍可能属于旧 remote attachment。local 目标必须固定从 window base attachment
  // 发起，再由 Host Controller 路由，不能把本地路径送进旧 remote scope。
  // 固定取 base attachment 的服务，而不是当前激活页签的 ambient services
  // [权衡] 若改用 ambient services，跨 workspace 点击会把本地路径送进旧的 remote scope
  // [并发] baseServices 随 attachment 重建而变化，必须进入 handleSelectTask 依赖数组，否则闭包持有已销毁连接
  // tabStoreApi 是稳定句柄，但只能通过即时 getState 读取，缓存 tabs 会拿到上一帧数据
  // [失败路径] base attachment 未就绪时返回空实现，流程继续，只跳过未读持久化
  // 选择流程的后续分支共用这一份 baseServices，不允许中途重新解析出第二份
  // resolvedRemoteSessionId 命中时优先用远端 services，baseServices 仅作本地兜底
  // [资源] 该引用不承担连接生命周期，断开由 attachment 管理层负责，这里只做一次性读取
  const baseServices = useBaseWorkspaceServices();
  const tabStoreApi = useTabStoreApi();
  const setActiveTaskId = useZCodeSessionStore((s) => s.setActiveTaskId);
  const taskNavHistory = useZCodeSessionStore((s) => s.taskNavHistory);
  const taskNavPushAutomations = useZCodeSessionStore((s) => s.taskNavPushAutomations);
  const taskNavPushPluginStore = useZCodeSessionStore((s) => s.taskNavPushPluginStore);
  const taskNavGoBack = useZCodeSessionStore((s) => s.taskNavGoBack);
  const taskNavGoForward = useZCodeSessionStore((s) => s.taskNavGoForward);
  const removeTaskFromNavHistory = useZCodeSessionStore((s) => s.removeTaskFromNavHistory);

  const handleSelectTask = useCallback(
    (
      targetWorkspacePath: string,
      taskId: string,
      targetWorkspaceIdentityHint?: string,
      selectedRowUnreadAt?: number,
    ) => {
      const targetWorkspaceState = useZCodeSessionStore
        .getState()
        .getWorkspaceState(targetWorkspacePath, targetWorkspaceIdentityHint);
      if (
        shouldBlockTaskSelectionDuringModelRestart(
          targetWorkspaceState.modelSwitchPending,
          targetWorkspaceState.modelSwitchStage,
        )
      ) {
        // 模型供应商切换触发 runtime 重建时，当前 provider-workspace 的 task handle 会被短暂回收。
        // 若此时切到其他 task，会并发触发 resumeTask 与重建流程，容易把切换失败误判成任务恢复失败。
        // 这里在 task 切换入口统一拦截，等重建完成后再允许切换，避免 UI 进入 notReady/error 的假失败态。
        logger.info(
          `[App] 模型运行时重建中，忽略 task 切换 workspace=${targetWorkspacePath} taskId=${taskId} stage=${targetWorkspaceState.modelSwitchStage}`,
        );
        toast(intl.formatMessage({ id: "taskList.switchBlockedByModelRestart" }));
        return;
      }

      // 远程 workspace 的未读清理不能再只靠 workspacePath 反查 session。
      // 当同一窗口里存在相同路径的多个 remote tab 时，路径映射会命中旧 session，
      // 导致“点开这个任务”却把已读状态写到另一条远端连接上。
      // 这里先激活目标 tab，再从当前激活 tab 上读取更精确的 remoteSessionId。
      activateTabByPath(
        targetWorkspacePath,
        targetWorkspaceIdentityHint
          ? { workspaceIdentity: targetWorkspaceIdentityHint }
          : undefined,
      );
      const activeTab = tabStoreApi
        .getState()
        .tabs.find((tab) => tab.id === tabStoreApi.getState().activeTabId);
      // workspace key 由路径与 identity 共同构成，只比路径会在本地与远端同路径时误判
      // 比较对象是刚激活的 activeTab，因此这一步必须排在 activateTabByPath 之后
      // [失败路径] 激活失败时 activeWorkspaceTabMatchesTarget 为 false，宁可清空 remoteSessionId 也不猜
      // 命中的页签提供的 workspaceIdentity 优先于调用方 hint，页签才真正承载连接
      // [权衡] 不直接按 key 搜索页签：只有激活的那个 remoteSessionId 与用户当前所见一致
      // isWorkspaceTab 先滤掉非 workspace 页签，避免同名字段被误读成远端连接
      // [并发] 查找内两次 getState 可能跨一次页签切换，因此还要用 key 再复核一次
      // 这组判断只决定未读写到哪条连接，不阻断 task 切换本身
      const targetWorkspaceKey = buildTaskWorkspaceKey(
        targetWorkspacePath,
        targetWorkspaceIdentityHint,
      );
      const activeWorkspaceTabMatchesTarget = Boolean(
        activeTab &&
        isWorkspaceTab(activeTab) &&
        buildTaskWorkspaceKey(activeTab.workspacePath, activeTab.workspaceIdentity) ===
          targetWorkspaceKey,
      );
      const resolvedRemoteSessionId =
        activeTab && isWorkspaceTab(activeTab) && activeWorkspaceTabMatchesTarget
          ? activeTab.remoteSessionId
          : undefined;
      const targetWorkspaceIdentity =
        activeTab && isWorkspaceTab(activeTab) && activeWorkspaceTabMatchesTarget
          ? (activeTab.workspaceIdentity ?? targetWorkspaceIdentityHint)
          : targetWorkspaceIdentityHint;
      const targetTask = {
        taskId,
        workspacePath: targetWorkspacePath,
        ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
      };
      const taskEntityKey = buildTaskEntityKey(targetTask);
      const cachedTaskMeta = useTaskQueryCacheStore.getState().taskMetaByEntityKey[taskEntityKey];
      const previousUnreadAt = cachedTaskMeta?.unreadAt;
      // 「任务」时间线由 Window Controller 直接提供行数据，不会像项目列表一样
      // 把后台创建的 task 写入 query cache。点击事务若只查 cache，会把已显示蓝点的行误判为已读。
      // 被点击行是本次用户实际看到的快照，优先用它的 unreadAt 做 compare-and-clear；
      // 未传行快照的旧入口继续回退 query cache，保持兼容。
      const expectedUnreadAt =
        typeof selectedRowUnreadAt === "number" ? selectedRowUnreadAt : previousUnreadAt;
      const shouldClearUnread = typeof expectedUnreadAt === "number";
      const isRemoteWorkspace = Boolean(
        targetWorkspaceIdentity ||
        (activeTab &&
          isWorkspaceTab(activeTab) &&
          activeWorkspaceTabMatchesTarget &&
          (activeTab.remoteSessionId || activeTab.remoteTarget)),
      );

      if (shouldClearUnread) {
        // unread 之前只在 useTaskRestore 的 resumeTask 后持久化清除。
        // 当用户再次点击当前 task 时，不会重新走 restore，磁盘里的 unreadAt 就会残留，
        // 表现成“已经点开看过了，但重启 app 后又回到未读”。
        // 这里把显式选择 task 也视为已读入口，保证同一条 task 重复进入时也能清掉持久化未读状态。
        // v4 任务行已由 query cache 渲染，只更新旧 Zustand unread map
        // 不会让蓝点重渲染。先对精确 entity key 加字段级 overlay，服务端回包
        // 后再 reconcile；期间的旧 membership 刷新也不能把蓝点写回来。
        // 先写本地 overlay 再发请求，让蓝点在网络往返前消失，点击后没有可感延迟
        // overlay 只改精确 entity key，不按 workspace 批量清，否则同列表其他行一起变灰
        // [失败路径] 请求失败或没有可用 services 时用 rollbackTaskQueryCacheUnread 写回 previousUnreadAt
        // [事务] 回滚要恢复点击前的旧值而不是 undefined，否则会掩盖对方那边刚产生的新未读
        // 服务端回包后用 reconcileTaskQueryCacheUnread 以返回的 unreadAt 为准，采信服务端时间线
        // [权衡] 不做乐观清空也能工作，但用户会看到点击后蓝点残留到下次刷新，像没点中
        // 该 overlay 与旧 Zustand unread map 是两套状态，只改后者不会触发任务行重渲染
        setTaskQueryCacheUnreadOverlay(targetTask, undefined);
        const targetServices = resolvedRemoteSessionId
          ? (getRemoteWorkspaceSession(resolvedRemoteSessionId)?.services ?? null)
          : isRemoteWorkspace
            ? null
            : baseServices;
        if (!targetServices) {
          // 远程 workspace 断开时不能按相同 workspacePath 回退到
          // 其他 remote session 或本地 base services，否则会把另一个工作区的未读状态清掉。
          rollbackTaskQueryCacheUnread(targetTask, previousUnreadAt);
          logger.warn(
            `[App] 选择 task 时跳过未读持久化，远程 workspace 未连接 workspace=${targetWorkspacePath} taskId=${taskId}`,
          );
        } else {
          void targetServices.zcodeTaskService
            .setTaskUnread({
              ...targetTask,
              unread: false,
              expectedUnreadAt,
            })
            .then((meta) => {
              reconcileTaskQueryCacheUnread(targetTask, meta.unreadAt);
              bumpTaskListMembershipVersion();
            })
            .catch((error: unknown) => {
              rollbackTaskQueryCacheUnread(targetTask, previousUnreadAt);
              markTaskQueryCacheScopesStale([targetTask]);
              bumpTaskListMembershipVersion();
              logger.warn(
                `[App] 选择 task 时清除未读状态失败 workspace=${targetWorkspacePath} taskId=${taskId}:`,
                error instanceof Error ? error.message : String(error),
              );
            });
        }
      }

      // slashCommands 是 workspace identity 级目录，不是 task projection。
      // 选择已有 task 时先清空的话，随后却只有 conversation projection 恢复，
      // composer 读取的 workspace 目录永远得不到回填。这里保留同一 identity 桶；
      // 冷恢复确实为空时由 workspace catalog 水合独立补齐。
      // active task 切换放在未读事务之后，保证投影恢复读到的是本次点击的目标
      // 传解析后的 targetWorkspaceIdentity 而不是原始 hint，远端页签上的 identity 才是有效值
      // [事务] 这一行与随后的 onNavigateToTask 必须成对出现，缺提示会让 shell 停在旧视图
      // onNavigateToTask 是可选回调，测试与嵌入场景不传，但不能因此跳过 setActiveTaskId
      // 同 workspace 重复点击同一 task 仍会重走本函数，用于清持久化未读，不算重复导航
      // [权衡] 不在此处比对当前 activeTaskId 做短路：短路会跳过未读清理，回到看过仍显示未读
      // 切换本身不触碰历史栈，历史只由调用方的显式导航入栈
      setActiveTaskId(targetWorkspacePath, taskId, targetWorkspaceIdentity);
      onNavigateToTask?.();
    },
    [activateTabByPath, intl, onNavigateToTask, baseServices, tabStoreApi, setActiveTaskId],
  );

  const handleOpenAutomations = useCallback(
    (automationId?: string, automationTab?: AutomationsNavigationTab) => {
      const normalizedAutomationId = automationId?.trim() || undefined;
      // Automations 过去只切换 WorkspaceShellLayout 的本地视图，完全绕过
      // 浏览器式导航历史，导致顶部前进/后退无法返回或恢复该页面。这里把它作为
      // workspace 身份隔离的正式导航目标入栈；历史回放只消费条目，不会再次入栈。
      // 入栈与回调使用同一组规范化字段，两处取值必须一致
      // [事务] 先入栈再通知，若通知方同步回读，历史里已有本条记录
      // 回放路径只消费条目、不会再调用本函数，因此这里不需要防重入
      // workspaceAbsPath 与 workspaceIdentity 来自入参，代表当前页所属工作区，不随点击目标改变
      // [权衡] 不合并连续同类条目：两个 automations 是不同 automationId 的独立目标
      // 空 automationId 被收窄为 undefined，条目形状只有列表页与指定自动化两种
      // 这里不校验目标是否存在，automations 页由 shell 自行兜底
      taskNavPushAutomations(
        workspaceAbsPath,
        workspaceIdentity,
        normalizedAutomationId,
        automationTab,
      );
      onNavigateToAutomations?.({
        workspacePath: workspaceAbsPath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(normalizedAutomationId ? { automationId: normalizedAutomationId } : {}),
        ...(automationTab ? { automationTab } : {}),
      });
    },
    [onNavigateToAutomations, taskNavPushAutomations, workspaceAbsPath, workspaceIdentity],
  );

  const handleOpenPluginStore = useCallback(() => {
    taskNavPushPluginStore(workspaceAbsPath, workspaceIdentity);
    onNavigateToPluginStore?.({ workspacePath: workspaceAbsPath, workspaceIdentity });
  }, [onNavigateToPluginStore, taskNavPushPluginStore, workspaceAbsPath, workspaceIdentity]);

  const handleTaskNavBack = useCallback(() => {
    const currentWorkspaceState = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspaceAbsPath);
    if (
      shouldBlockTaskSelectionDuringModelRestart(
        currentWorkspaceState.modelSwitchPending,
        currentWorkspaceState.modelSwitchStage,
      )
    ) {
      logger.info(
        "[App] 模型运行时重建中，忽略任务后退导航 workspace=" +
          workspaceAbsPath +
          " stage=" +
          currentWorkspaceState.modelSwitchStage,
      );
      toast(intl.formatMessage({ id: "taskList.switchBlockedByModelRestart" }));
      return;
    }

    // 每取一次就消费一个历史位置，循环内只能再调 goBack 前移，不能回写栈
    // [失败路径] 失效任务先 removeTaskFromNavHistory 再继续，避免下次后退重复命中同一条
    // [并发] 循环期间历史可能被其他入口 push，这里按快照逐条消费，不回读 canGoBack
    // 存在性判断用可见任务与 meta 表的并集，任一命中即视为可恢复
    // 命中 automations 或 plugin store 后必须 return，不能继续把条目当 task 消费
    // 循环正常结束意味着历史已空，此时才提示 noMoreBack
    // [权衡] 不在入口一次性清洗全部失效条目：清洗会改动长度，canGoBack 会在命令中途跳变
    // handleSelectTask 内部会再判一次模型重启，循环里的调用因此是二重保险
    let entry = taskNavGoBack();
    // 性能修复：task meta 恢复/流式同步会高频刷新 query cache。
    // 历史导航只在命令执行时需要存在性快照，避免 hook 订阅整张 meta 表导致 shell 重渲染。
    const taskMetaByEntityKey = useTaskQueryCacheStore.getState().taskMetaByEntityKey;
    while (entry) {
      const currentEntry = entry;
      if (isAutomationsNavEntry(currentEntry)) {
        activateTabByPath(
          currentEntry.workspacePath,
          currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : undefined,
        );
        onNavigateToAutomations?.({
          workspacePath: currentEntry.workspacePath,
          ...(currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : {}),
          ...(currentEntry.automationId ? { automationId: currentEntry.automationId } : {}),
          ...(currentEntry.automationTab ? { automationTab: currentEntry.automationTab } : {}),
        });
        return;
      }
      if (isPluginStoreNavEntry(currentEntry)) {
        activateTabByPath(
          currentEntry.workspacePath,
          currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : undefined,
        );
        onNavigateToPluginStore?.(currentEntry);
        return;
      }
      const navWorkspaceState = useZCodeSessionStore
        .getState()
        .getWorkspaceState(currentEntry.workspacePath, currentEntry.workspaceIdentity);
      const exists = taskNavigationTargetExists({
        entry: currentEntry,
        visibleTasks: getVisibleTaskMetas(navWorkspaceState),
        taskMetaByEntityKey,
      });
      if (exists) {
        handleSelectTask(
          currentEntry.workspacePath,
          currentEntry.taskId,
          currentEntry.workspaceIdentity,
        );
        return;
      }

      // 目标 task 已被删除，从历史中清理并继续尝试
      removeTaskFromNavHistory(currentEntry.taskId);
      entry = taskNavGoBack();
    }

    toast(intl.formatMessage({ id: "taskNav.noMoreBack" }));
  }, [
    activateTabByPath,
    handleSelectTask,
    intl,
    onNavigateToAutomations,
    onNavigateToPluginStore,
    removeTaskFromNavHistory,
    taskNavGoBack,
    workspaceAbsPath,
  ]);

  const handleTaskNavForward = useCallback(() => {
    const currentWorkspaceState = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspaceAbsPath);
    if (
      shouldBlockTaskSelectionDuringModelRestart(
        currentWorkspaceState.modelSwitchPending,
        currentWorkspaceState.modelSwitchStage,
      )
    ) {
      logger.info(
        "[App] 模型运行时重建中，忽略任务前进导航 workspace=" +
          workspaceAbsPath +
          " stage=" +
          currentWorkspaceState.modelSwitchStage,
      );
      toast(intl.formatMessage({ id: "taskList.switchBlockedByModelRestart" }));
      return;
    }

    // 前进与后退共用一套条目分发与存在性判断，任何一侧的改动必须同步另一侧
    // 前进只消费 forward 栈，遇到失效条目同样移除后继续，不改变当前页
    // [事务] 命中目标后立即 return，剩余条目保留，保证一次点击只前进一步
    // [失败路径] forward 栈被清空时提示 noMoreForward，与后退的 noMoreBack 对称
    // 这里同样只取一次 cache 快照，避免循环中 task meta 刷新让判断偏离
    // [权衡] 不与后退共用一个循环函数：两者读取的栈操作不同，合并会把方向参数带进存在性判断
    // handleSelectTask 里仍会重新解析 workspace 身份，条目上的 identity 只作提示
    // 前进不重置后退栈，浏览器式语义由 store 内的双栈维护
    let entry = taskNavGoForward();
    // 性能修复：只在前进命令触发时读取最新 query cache，避免 task meta 小更新订阅整棵导航 hook。
    const taskMetaByEntityKey = useTaskQueryCacheStore.getState().taskMetaByEntityKey;
    while (entry) {
      const currentEntry = entry;
      if (isAutomationsNavEntry(currentEntry)) {
        activateTabByPath(
          currentEntry.workspacePath,
          currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : undefined,
        );
        onNavigateToAutomations?.({
          workspacePath: currentEntry.workspacePath,
          ...(currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : {}),
          ...(currentEntry.automationId ? { automationId: currentEntry.automationId } : {}),
          ...(currentEntry.automationTab ? { automationTab: currentEntry.automationTab } : {}),
        });
        return;
      }
      if (isPluginStoreNavEntry(currentEntry)) {
        activateTabByPath(
          currentEntry.workspacePath,
          currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : undefined,
        );
        onNavigateToPluginStore?.(currentEntry);
        return;
      }
      const navWorkspaceState = useZCodeSessionStore
        .getState()
        .getWorkspaceState(currentEntry.workspacePath, currentEntry.workspaceIdentity);
      const exists = taskNavigationTargetExists({
        entry: currentEntry,
        visibleTasks: getVisibleTaskMetas(navWorkspaceState),
        taskMetaByEntityKey,
      });
      if (exists) {
        handleSelectTask(
          currentEntry.workspacePath,
          currentEntry.taskId,
          currentEntry.workspaceIdentity,
        );
        return;
      }

      removeTaskFromNavHistory(currentEntry.taskId);
      entry = taskNavGoForward();
    }

    toast(intl.formatMessage({ id: "taskNav.noMoreForward" }));
  }, [
    activateTabByPath,
    handleSelectTask,
    intl,
    onNavigateToAutomations,
    onNavigateToPluginStore,
    removeTaskFromNavHistory,
    taskNavGoForward,
    workspaceAbsPath,
  ]);

  const canGoBack = navCanGoBack(taskNavHistory);
  const canGoForward = navCanGoForward(taskNavHistory);
  const currentWorkspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspaceAbsPath);
  // 四个可用性标志在 render 期从 store 快照同步计算，供工具栏一次性取用
  // [并发] getState 是快照读取、不订阅模型切换状态，切换完成后由上层重新 render 刷新
  // 重启锁只影响 canTaskNavBack 与 canTaskNavForward，不影响历史本身是否非空
  // [权衡] 不把锁并入 canGoBack：外部若用原始值做展示，会把历史误判为空
  // 两个派生标志与入口处的拦截判断同源，保证按钮禁用与按键拦截不会不一致
  // 锁定时按钮禁用即可，回调里仍保留判断以覆盖快捷键与程序化调用
  // 字段名要与返回对象一致，调用方按 canTaskNavBack 取用，不要混用 canGoBack
  const isTaskSwitchLockedByModelRestart = shouldBlockTaskSelectionDuringModelRestart(
    currentWorkspaceState.modelSwitchPending,
    currentWorkspaceState.modelSwitchStage,
  );
  const canTaskNavBack = canGoBack && !isTaskSwitchLockedByModelRestart;
  const canTaskNavForward = canGoForward && !isTaskSwitchLockedByModelRestart;

  return {
    handleSelectTask,
    handleOpenAutomations,
    handleOpenPluginStore,
    handleTaskNavBack,
    handleTaskNavForward,
    canGoBack,
    canGoForward,
    canTaskNavBack,
    canTaskNavForward,
  };
}
