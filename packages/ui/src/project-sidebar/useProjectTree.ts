// 项目侧栏树聚合 hook：把窗口目录、远端主机目录、任务行与活动信号聚合成可渲染的一棵树。
// 职责：编排「读快照 → 接受快照 → 提交 UI 与首发回调 → 叠加活动投影」，只做时序与一致性问题。
// 不负责：树的排序与去重（view.ts）、归档写盘（项目服务）、未读计数（useProjectUnreadSignals）。
// 核心约束：本 hook 持有的是事实快照投影，任何跨窗口/跨 Source 的写入都必须整组取自同一目录服务。
//
// INV-01 断言：侧栏读写的项目服务与远端服务必须整组取自窗口目录服务，不得与本窗口服务混用 —— 守住它的位置：directoryServices 的赋值 —— 改错故障：远端主机项目出现在本地侧栏且写操作打到错误 Source
// INV-02 断言：所有异步读取结果只有在 serial.current 未变时才允许落盘到 state —— 守住它的位置：readOnce 的 request 比较与 finally —— 改错故障：旧快照覆盖新快照，归档或删除后的项目短暂复活
// INV-03 断言：同一时刻最多只有一个读取 flight，刷新请求只置 dirty 不得再起并发读 —— 守住它的位置：refresh 的 flight/dirty —— 改错故障：连续事件触发读取风暴并让列表长时间停在空态
// INV-04 断言：accepted 快照只在 service 与 remoteService 均未换代时才用于前后比对 —— 守住它的位置：readOnce 中 previous 的可用性判断 —— 改错故障：切换远端主机后误判归档转换，清掉其他主机的任务详情
// INV-05 断言：自动归档清理只认已接受快照中 archived 由 false 变 true 的显式转换 —— 守住它的位置：任务归档判断分支 —— 改错故障：首次加载的已归档任务或迟到响应被当作归档事件，误删用户正在看的详情
// INV-06 断言：任务身份 key 必须为 workspaceIdentity 去空白优先、否则回退 workspacePath —— 守住它的位置：归档比较前的 key 构造 —— 改错故障：同一远程 workspace 被拆成两条记录，归档清理漏项
// INV-07 断言：组织 RPC 不得进入共享读取屏障，必须在真实行确认后独立提交 —— 守住它的位置：ready 之后的 organize 调用 —— 改错故障：一个无回包的组织请求卡死整棵目录与全部首发
// INV-08 断言：pendingCommits 中的意图必须被 commit 或 finish 恰好消费一次 —— 守住它的位置：commit/finish 与卸载清理 —— 改错故障：等待首发的调用方永久挂起，新建任务无回调
// INV-09 断言：导航取消只释放 UI 等待，已 accepted 的 placement 组织意图要保留 —— 守住它的位置：cancel 是否删除 pending —— 改错故障：用户快速切换后新建任务落在错误分组或丢失自动组织
// INV-10 断言：连接与入口的发布必须做完整内容等价比较，不得在 memo 中丢掉字段 —— 守住它的位置：availability/directory 的 set 回调 —— 改错故障：连接状态变化不刷新，侧栏显示过期的离线或在线标记
// INV-11 断言：目录与详情同帧提交只能通过 flushSync 在存在待提交首发时触发 —— 守住它的位置：ready.length 分支 —— 改错故障：首发详情绑定落在目录之后，出现行闪现或详情错位
// INV-12 断言：读取失败必须先把错误写入 state 再对所有 pending 结算 —— 守住它的位置：readOnce 的 catch —— 改错故障：错误被吞掉，新建任务按钮永远转圈
// INV-13 断言：卸载时必须自增 serial 让在途响应失效并清空 flight —— 守住它的位置：卸载副作用 —— 改错故障：已卸载组件收到 setState，产生告警与内存泄漏
// INV-14 断言：scopes 去重以 identity 优先、路径兜底，且远端根需构造 host 前缀 identity —— 守住它的位置：scopes 的 byKey 写入 —— 改错故障：本地与远程同名路径合并，观察订阅到错误 Source
// INV-15 断言：活动观察只随 scope 与 Source 换代重注册，不能随活动 revision 反复注册 —— 守住它的位置：observeSources 依赖 —— 改错故障：每次活动更新都重读目录，RPC 与 CPU 放大
// INV-16 断言：对外 refresh 必须同时重读目录与重注册观察 —— 守住它的位置：refreshDirectory —— 改错故障：焦点回归后目录恢复但活动不再更新
// INV-17 断言：displayedTree 是叠加活动后的投影，事实树 tree 不得被活动覆盖 —— 守住它的位置：applyProjectTaskActivities 的入参 —— 改错故障：活动把归档或缺失任务重新插回列表
// INV-18 断言：返回对象的引用只在依赖变化时更换，tree 与 displayedTree 必须分字段暴露 —— 守住它的位置：返回 useMemo 的依赖数组 —— 改错故障：上层每次渲染都重算，列表整片重挂载并丢滚动位置
//
// 数据流：readProjectSidebarTree 产出快照，经 accepted 比对后提交 tree/directory/availability，再叠加行活动得到投影。
// 两个 revision：Controller 的活动 revision 驱动活动重算，目录与 Source revision 只驱动重读与观察换代。
// 改这个文件时优先确认三件事：serial 是否对齐、pending 是否被消费、发布是否真的换了引用。
//
import { flushSync } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  ProjectTree,
  ProjectTaskRef,
  ProjectAvailability,
  RemoteProjectDirectory,
} from "@/project-sidebar/contract.js";
import { readProjectSidebarTree } from "@/project-sidebar/project-tree-reader.js";
import { stabilizeProjectTree, applyProjectTaskActivities } from "@/project-sidebar/view.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useWorkspaceSessionsIndexItems } from "@/v4/useWorkspaceSessionsIndexItems.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { getWindowControllerTaskListRegistry } from "@/v4/windowControllerTaskListRegistry.js";
import { buildRemoteHostWorkspaceIdentity } from "@/project-sidebar/contract.js";
import { logger } from "@/logger.js";
import { useProjectUnreadSignals } from "@/project-sidebar/useProjectUnreadSignals.js";
import { areStabilizedValuesEquivalent } from "@/v4/taskListItemStabilization.js";

const subscribeToNothing = () => () => {};
const zeroRevision = () => 0;
// 空树常量在整个 hook 生命周期内复用同一引用，初始化 state 与 lastDisplay 都指向它。
// 不要为「干净起始」新建字面量：引用变化会让依赖 tree 的 memo 全部失效，首帧多一次整树重算。
// 该对象只读，任何分支都不应就地修改 projects 与 tasks 数组。
const EMPTY: ProjectTree = { projects: [], tasks: [] };
// [契约] 唯一入口：侧栏树的所有外部调用方都从这里拿 tree、factTree、directory 与 availability。
// isDesktop 只影响未读信号的取数口径，不改变树本身的读取或提交路径。
// 不要在这里做服务就近获取：服务统一由 useBaseWorkspaceServices 注入，换 Provider 顺序会串进程。
// hook 内同时持有 React state 与外部 store 订阅，任何新增副作用都要考虑两者提交帧不一致。
export function useProjectTree(isDesktop = false) {
  const services = useBaseWorkspaceServices();
  // 远端 bridge 的 base 服务属于 Source；侧栏读写与失效流必须整组来自窗口目录。
  // [契约] `windowProjectDirectory` 在远端 bridge 下属于 Source 侧，侧栏读写与失效流必须整组取自窗口目录。
  // 窗口目录服务缺失时才回退到窗口自身服务，该分支只应出现在纯本地或旧宿主。
  // 若把项目服务与远端服务分别取自不同来源，远端项目会以本地身份入库。
  // 回退并不等价：本地服务没有远端目录能力，远端项目在回退路径下会整体缺失而不是报错。
  const directoryServices = services.windowProjectDirectory ?? services;
  const service = directoryServices.projectService;
  const remoteService = directoryServices.remoteProjectService;
  const projectChanges = services.windowProjectDirectory?.changesService;
  const controller = services.windowControllerService;
  const registry = useMemo(
    () => (controller ? getWindowControllerTaskListRegistry(controller) : null),
    [controller],
  );
  // [并发] 只订阅 Controller 的活动 revision，用于驱动 displayedTree 重算。
  // 目录与 Source 的换代不进入该订阅，它们各自用 getDirectoryRevision 与 getSourceRevision 直接取值。
  // 把目录换代并进这个订阅会让每次归档或连接变化都触发一次活动重算，纯属放大开销。
  // registry 为 null（非 Controller 宿主）时退化为空订阅与常量 0，不要在这里抛错。
  const revision = useSyncExternalStore(
    registry?.subscribe ?? subscribeToNothing,
    registry?.getRevision ?? zeroRevision,
    registry?.getRevision ?? zeroRevision,
  );
  const directoryRevision = registry?.getDirectoryRevision() ?? 0;
  const sourceRevision = registry?.getSourceRevision() ?? 0;
  const tabs = useTabStore((state) => state.tabs);
  const version = useZCodeSessionStore((state) =>
    Object.values(state.workspaces).reduce((n, workspace) => n + workspace.taskListVersion, 0),
  );
  const [tree, setTree] = useState<ProjectTree>(EMPTY);
  const [availability, setAvailability] = useState<ReadonlyMap<string, ProjectAvailability>>(
    new Map(),
  );
  const [directory, setDirectory] = useState<RemoteProjectDirectory>({ hosts: [], entries: [] });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // [并发] serial 是单调递增的请求代号，发起读取时取值、返回时比对，用最新值丢弃过期结果。
  // 卸载与重挂载都会自增它，因此不要把它当作「第几次读取」的统计量使用。
  // 比较必须用相等而不是大于：自增只发生在作废时，相等才代表这一轮仍然有效。
  const serial = useRef(0);
  // [并发] 把「是否在飞」与「期间是否又有变化」收敛成两个字段，flight 为 null 表示空闲。
  // 依赖只取两个服务：服务换代意味着上一轮结果已无意义，必须重置这一份合并状态。
  // 不要把它换成 ref：dirty 与 flight 需要参与 useCallback 依赖，才能让调用方拿到同一套合并逻辑。
  // 读取循环结束后必须把 flight 置回 null，否则后续刷新永远只返回已完成的旧 Promise。
  const reads = useMemo(
    () => ({ flight: null as Promise<void> | null, dirty: false }),
    [service, remoteService],
  );
  // [事务] 记录「已发起写入但真实行尚未出现」的首发意图，等树里出现对应行再提交。
  // 每个 pending 必须被 commit 或 finish 恰好消费一次，finish 负责从集合中摘除并结算 Promise。
  // 这个集合不参与渲染，只用于跨异步阶段对齐；放进 state 会引入额外提交帧并打乱同帧提交时机。
  // 命中判断在 readOnce 里按 target 做身份比对，不在这里做去重。
  const pendingCommits = useRef(
    new Set<{
      target: ProjectTaskRef;
      commit(): void;
      organize?(): Promise<void>;
      finish(error?: unknown): void;
    }>(),
  );
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const accepted = useRef<{
    service: typeof service;
    remote: typeof remoteService;
    tree: ProjectTree;
  } | null>(null);
  // 读取一次完整快照：目录、可用性与远端入口，读取期间不持有任何 React 提交。
  // 只有在 request 仍等于 serial.current 时才运行接受逻辑，过期响应直接丢弃且不改 loading。
  // 第一段只做诊断日志：主目录状态变化是排查远端掉线的高价值证据，不要因为看似无副作用删掉。
  // 第二段才更新 accepted 并做归档清理，顺序不能颠倒，否则比较基准会变成刚读到的自己。
  const readOnce = useCallback(async () => {
    const request = serial.current;
    try {
      // [失败路径] 服务缺失时抛错而不是返回空树：空树会让侧栏显示「无项目」，掩盖注入失败。
      // 这个错误会被外层 catch 转成 error state 并结算全部 pending，不要在这里吞掉或改写错误码。
      // 错误码字符串是上层识别注入问题的唯一线索，改动会破坏既有排查路径。
      if (!service) throw new Error("project.service-unavailable");
      const result = await readProjectSidebarTree({
        projectService: service,
        remoteProjectService: remoteService,
      });
      if (request === serial.current) {
        // [权衡] previous 为空是首次读取，此时没有可比基准，归档清理与首发匹配都应跳过比较。
        // 仅当服务未变时才使用 previous，切换服务后旧快照的行身份不可信。
        // 不要用 tree state 代替它：state 可能已被活动投影或稳定化改写过。
        const previous = accepted.current;
        if (previous?.service === service) {
          for (const project of result.tree.projects) {
            const before = previous.tree.projects.find(
              (item) => item.id === project.id && item.hostId === project.hostId,
            );
            if (before && before.primaryRootStatus !== project.primaryRootStatus) {
              logger.debug("[project-sidebar] 项目主目录状态变化", {
                projectId: project.id,
                hostId: project.hostId,
                previous: before.primaryRootStatus,
                current: project.primaryRootStatus,
              });
            }
          }
        }
        accepted.current = { service, remote: remoteService, tree: result.tree };
        // Bugfix: 自动归档只改 Host archived，未执行手动归档的 UI 清理，导致列表消失而详情残留。
        // 只处理已接受快照中的明确状态转换；首次已归档、离线缺行与迟到响应都不是归档事件。
        if (previous?.service === service && previous.remote === remoteService) {
          const key = (task: ProjectTree["tasks"][number]) =>
            JSON.stringify([
              task.hostId,
              task.workspaceIdentity?.trim() || task.workspacePath,
              task.taskId,
            ]);
          const before = new Map(previous.tree.tasks.map((task) => [key(task), task]));
          for (const task of result.tree.tasks) {
            // [事务] 自动归档只改 Host 的 archived 字段，不会触发手动归档的 UI 清理，这里补上详情移除。
            // 条件必须同时满足当前已归档与上一份快照明确为未归档，才是一次真实的状态转换。
            // 首次加载即为归档、离线缺行、迟到响应都不满足条件，按「不是归档事件」处理。
            // 清理用 identity 优先 key 定位，避免同一远程 workspace 的不同展示路径被当成两条任务。
            if (task.archived && before.get(key(task))?.archived === false) {
              logger.info("[project-sidebar] 归档后清理任务展示", {
                taskId: task.taskId,
                workspacePath: task.workspacePath,
                workspaceIdentity: task.workspaceIdentity,
              });
              removeTaskState(task.workspacePath, task.taskId, task.workspaceIdentity);
            }
          }
        }
        // [事务] 真实行确认：树中已存在与 target 同任务号且同身份 key 的行，首发才算落地。
        // 只比对任务号与身份，不比状态：行可能已经是运行中或归档后的形态，仍然算确认。
        // 这里不删除 pending，删除交给提交阶段里的 finish，保证提交与结算成对出现。
        // 过滤结果用于两处：组织动作的独立提交与同帧提交，两处共用同一份快照。
        const ready = [...pendingCommits.current].filter(({ target }) =>
          result.tree.tasks.some(
            (task) =>
              task.taskId === target.taskId &&
              (task.workspaceIdentity?.trim() || task.workspacePath) ===
                (target.workspaceIdentity?.trim() || target.workspacePath),
          ),
        );
        // 根因：把组织 RPC 放进共享读取屏障后，一个无回包请求会卡住整棵目录和所有首发。
        // 真实行确认后独立提交组织动作；目录发布、详情提升和导航取消都不等待它。
        for (const pending of ready) {
          if (pending.organize)
            void Promise.resolve()
              .then(pending.organize)
              .catch((cause) => logger.error("[project-sidebar] 首发组织提交失败", cause));
        }
        // [事务] 提交阶段先发布三个 state 再结算 pending，保证回调执行时 UI 已能读到真实行。
        // 树走 stabilizeProjectTree 复用等价分支，避免每次读取都整树重渲染。
        // 连接与入口走完整内容比较后决定是否换引用：连接状态变化必须发布，被 memo 忽略就会出现过期标记。
        // pending 的 commit 抛错时先 finish 再重新抛出，让调用方拿到失败而不是静默挂起。
        const commit = () => {
          setTree((previous) => stabilizeProjectTree(previous, result.tree));
          // 树已复用等价引用，但连接/入口每次 RPC 都是新对象，仍会广播整棵目录。
          // 在接收边界比较完整内容；连接变化与入口移除仍发布，不在组件 memo 中忽略字段。
          setAvailability((previous) =>
            previous.size === result.availability.size &&
            [...result.availability].every(([key, value]) =>
              areStabilizedValuesEquivalent(previous.get(key), value),
            )
              ? previous
              : result.availability,
          );
          setDirectory((previous) =>
            areStabilizedValuesEquivalent(previous, result.directory) ? previous : result.directory,
          );
          setError(null);
          for (const pending of ready) {
            try {
              pending.commit();
              logger.info("[project-sidebar] 首发目录与详情提交", pending.target);
              pending.finish();
            } catch (cause) {
              pending.finish(cause);
              throw cause;
            }
          }
        };
        // Bug 根因：目录是 React state，详情绑定是外部 store；首发只靠事件先后不能
        // 保证同一可见帧。真实行到达后在这里一起提交，沿用原首发回调。
        // [并发] 存在待提交首发时才用 flushSync 强制同步提交，把目录与详情绑定压进同一可见帧。
        // 无待提交时走普通提交，避免不必要地打断 React 的批量更新。
        // 不要无条件同步提交：高频刷新下会退化为逐条同步渲染，侧栏明显掉帧。
        if (ready.length) flushSync(commit);
        else commit();
      }
    } catch (cause) {
      if (request === serial.current) {
        setError(String(cause));
        for (const pending of pendingCommits.current) pending.finish(cause);
        logger.error("[project-sidebar] 读取项目树失败", cause);
      }
    } finally {
      if (request === serial.current) setLoading(false);
    }
  }, [service, remoteService, removeTaskState]);
  // [并发] 刷新是合并式的：已有 flight 时只置 dirty 并复用同一个 Promise，不再另起读取。
  // 循环条件带 generation 比较，服务换代后旧循环立即退出，不会把新代结果写进旧代。
  // dirty 在每轮开始时清零，因此循环期间的新变化一定能让下一轮继续执行。
  // 不要改成每次变化都废弃当前读取：连续事件会不断作废，列表长期停在空态。
  const refresh = useCallback(() => {
    reads.dirty = true;
    if (reads.flight) return reads.flight;
    const generation = serial.current;
    const flight = (async () => {
      // 事实变化只标记下一次读取，不能反复废弃当前结果，否则连续变化会饿死列表。
      while (reads.dirty && generation === serial.current) {
        reads.dirty = false;
        await readOnce();
      }
    })().finally(() => {
      if (reads.flight === flight) reads.flight = null;
    });
    reads.flight = flight;
    return flight;
  }, [readOnce, reads]);
  const commitCreatedTask = useCallback(
    (
      target: ProjectTaskRef,
      commit: () => void,
      signal?: AbortSignal,
      organize?: () => Promise<void>,
    ) => {
      if (signal?.aborted && !organize) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const complete = (error?: unknown) => {
          signal?.removeEventListener("abort", cancel);
          if (error) reject(error);
          else resolve();
        };
        // [事务] 导航中止只结束 UI 等待，不结算为成功也不报错，调用方据此释放按钮状态。
        // 已 accepted 的组织意图要保留在 pendingCommits 里，等真实行到达后照常提交。
        // 若在取消时一并删除 pending，快速切换导航就会丢掉首发任务的分组落位。
        // 没有组织动作的 pending 在取消时可以直接摘除，因为没有后续提交需要等它。
        const cancel = () => {
          // 导航取消立即结束 UI 等待；尚未确认的组织意图保留到真实行到达，不丢掉已 accepted 的 placement。
          if (!organize) pendingCommits.current.delete(pending);
          complete();
        };
        const pending = {
          target,
          organize,
          commit: () => {
            if (!signal?.aborted) commit();
          },
          finish(error?: unknown) {
            pendingCommits.current.delete(pending);
            complete(error);
          },
        };
        pendingCommits.current.add(pending);
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
        void refresh();
      });
    },
    [refresh],
  );
  // [资源] 卸载时自增 serial，让所有在途读取返回后判定为过期，不再写 state。
  // flight 必须显式清空，否则重挂载后刷新会拿到上一实例已完成的 Promise。
  // 剩余 pending 统一 finish 结算，避免等待首发的组件在卸载链路里永久挂起。
  useEffect(
    () => () => {
      serial.current++;
      reads.flight = null;
      for (const pending of pendingCommits.current) pending.finish();
    },
    [reads],
  );
  useEffect(() => {
    void refresh();
  }, [refresh, version, tabs, directoryRevision]);
  const scopes = useMemo(() => {
    const byKey = new Map<string, { workspacePath: string; workspaceIdentity?: string }>();
    for (const task of tree.tasks) byKey.set(task.workspaceIdentity || task.workspacePath, task);
    for (const project of tree.projects)
      for (const root of project.roots) {
        const identity =
          registry && project.hostId !== "local"
            ? buildRemoteHostWorkspaceIdentity(project.hostId, root.rootPath)
            : undefined;
        byKey.set(identity || root.rootPath, {
          workspacePath: root.rootPath,
          ...(identity ? { workspaceIdentity: identity } : {}),
        });
      }
    for (const tab of tabs)
      if (isWorkspaceTab(tab) && !tab.workspaceIdentity && !tab.remoteSessionId)
        byKey.set(tab.workspacePath, { workspacePath: tab.workspacePath });
    return [...byKey.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, { workspacePath, workspaceIdentity }]) => ({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      }));
  }, [tree, tabs, registry]);
  const scopeKey = JSON.stringify(scopes);
  useProjectUnreadSignals(scopes, refresh, isDesktop);
  const sourceVersion = JSON.stringify(
    directory.hosts.map((host) => [host.id, host.membershipId, host.connectionStatus]).sort(),
  );
  // [并发] 活动观察随 scope 与 Source 换代重注册，不随活动 revision 反复注册。
  // 返回行不进入项目树，只用于确认订阅生效，因此结果被刻意丢弃。
  // 签名里同时带 Controller revision 与 Source 代次，任一换代都要求重新注册。
  // 注册失败只 warn 不抛错：显式刷新仍能重试，不能因为订阅失败让整棵目录不可用。
  const observeSources = useCallback(async () => {
    if (!registry || !scopes.length) return;
    // 原来活动 revision 反复注册观察并重读目录；观察只随 scope/Source 换代。
    // 返回行不进入项目树，显式刷新仍能重试失败的注册。
    await registry
      .list(
        "project-sidebar-activity",
        {
          controllerRevision: sourceRevision,
          taskListVersionSignature: scopeKey,
          workspaceSourceGenerationSignature: `${sourceRevision}:${sourceVersion}`,
        },
        {
          kind: "timeline",
          workspaceScopes: JSON.parse(scopeKey),
          sortBy: "updated",
          limit: 0,
        },
      )
      .catch((cause) => logger.warn("[project-sidebar] Controller 活动订阅失败", cause));
  }, [registry, scopeKey, sourceRevision, sourceVersion]);
  useEffect(() => {
    void observeSources();
  }, [observeSources]);
  const refreshDirectory = useCallback(async () => {
    await Promise.all([refresh(), observeSources()]);
  }, [refresh, observeSources]);
  useEffect(() => {
    // Finder/终端移走或恢复目录不会产生项目写事件；回到窗口时重新检查并恢复观察。
    const onFocus = () => void refreshDirectory();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshDirectory]);
  useEffect(() => {
    const subscriptions = (registry ? [] : scopes).map((scope) =>
      services.zcodeTaskService.onDynamicWorkspaceEvent(scope)((event) => {
        if (event.type === "workspace_task_list_changed") void refresh();
      }),
    );
    const broadcast = projectChanges
      ? projectChanges.onDidChange(() => void refresh())
      : services.broadcastService.onMessage((event) => {
          if (event.channel === "state:projects") void refresh();
        });
    return () => {
      subscriptions.forEach((subscription) => subscription.dispose());
      broadcast.dispose();
    };
  }, [scopeKey, services, projectChanges, refresh, registry]);
  const activity = useWorkspaceSessionsIndexItems(registry ? [] : scopes);
  const lastDisplay = useRef<ProjectTree>(EMPTY);
  // [权衡] 在事实树上叠加行活动得到投影，投影结果不回流到任何 state 或服务。
  // 活动来源分两条：Controller 注册表读取，或会话索引 hook 的逐行活动。
  // lastDisplay 用 stabilizeProjectTree 做引用稳定，否则活动每次变化都会重挂整棵列表。
  // 依赖里带 revision 是刻意的：注册表的活动表是可变外部存储，只能靠 revision 触发重算。
  const displayedTree = useMemo(() => {
    const activities = registry
      ? registry.readActivities()
      : activity.items.flatMap((task) => {
          const live = getTaskListRowActivity(task);
          return live
            ? [
                {
                  address: {
                    taskId: task.taskId,
                    workspacePath: task.workspacePath,
                    workspaceIdentity: task.workspaceIdentity,
                  },
                  activity: live,
                },
              ]
            : [];
        });
    const next = applyProjectTaskActivities(tree, activities);
    lastDisplay.current = stabilizeProjectTree(lastDisplay.current, next);
    return lastDisplay.current;
  }, [tree, activity.items, registry, revision]);
  return useMemo(
    () => ({
      tree: displayedTree,
      factTree: tree,
      directory,
      availability,
      service,
      remoteService,
      refresh: refreshDirectory,
      commitCreatedTask,
      error,
      loading,
    }),
    [
      displayedTree,
      tree,
      directory,
      availability,
      service,
      remoteService,
      refreshDirectory,
      commitCreatedTask,
      error,
      loading,
    ],
  );
}
