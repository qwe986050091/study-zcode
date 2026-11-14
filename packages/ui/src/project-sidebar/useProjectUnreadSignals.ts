// 模块职责：项目侧栏未读信号的唯一订阅与补记 hook，把窗口事件与任务事件收敛成「写未读」和「自动已读」两类命令。
// 状态所有权：未读事实归 task meta，本文件只保存接收水位、前台完成记录与串行队列，不另存第二份未读状态。
// INV-01 未读信号按「工作区身份 + taskId」复合键去重，身份键统一取 workspaceIdentity 去空白后回退 workspacePath；守住位置：taskKey 与 receive 内的 key 构造；改错故障：同名任务跨工作区互相覆盖，A 项目的角标点亮到 B 项目。
// INV-02 同一键只接受 updatedAt 更大、或 updatedAt 相同但 status 不同的信号，其余一律丢弃；守住位置：receive 的 previous 比较分支；改错故障：乱序回包把已读翻回未读，角标反复闪烁无法复位。
// INV-03 桌面或手机正在看同一任务时不写未读，只登记前台完成记录；守住位置：receive 的 isDesktopViewing 与 isRemoteViewing 分支；改错故障：用户眼皮底下的任务冒出蓝点，必须点走再点回才消失。
// INV-04 前台完成只在离开窗口时补记，离开指失焦、最小化或页面隐藏；守住位置：flushOnLeave 与 onVisibilityChange；改错故障：最小化后没有提醒，用户切回来才发现任务早已结束。
// INV-05 回到窗口必须先补写再清除，清除只消费已经写回的 marker；守住位置：flushThenClear 的 await 顺序；改错故障：清除时读不到 marker 而失效，蓝点永久卡在正打开的任务上。
// INV-06 补写成功才置 written，失败保持未写等下一个生命周期事件重试；守住位置：flushOnLeave 内的命令主体；改错故障：一次网络或服务失败就永久丢掉这条提醒。
// INV-07 自动清除必须带 expectedUnreadAt 走 CAS，marker 为空不得发 mark-read；守住位置：clearOnFocus 的守卫；改错故障：无条件已读抹掉别处新产生的未读，提醒被静默吞掉。
// INV-08 同一任务的补写与清除共用一条串行队列，不允许并发写；守住位置：enqueueForegroundCommand 与 foregroundQueuesRef；改错故障：迟到的旧补写落在清除之后，制造无法自动清除的未读。
// INV-09 队列、在途写与在途清除挂在组件级 ref 上，必须跨 effect 重跑存活；守住位置：三个 useRef 声明与 effect 依赖数组；改错故障：scope 变化重订阅时丢掉未完成命令，提醒静默消失。
// INV-10 队列尾只在仍等于当前 settled 时才删除，避免误删后继链；守住位置：settled 的 finally 分支；改错故障：先完成的旧链删掉新链，串行退化为并发。
// INV-11 在途清除用集合占坑，focus 与 visibilitychange 连发不重复 mark-read；守住位置：foregroundPendingClearsRef 的检查与收尾清理；改错故障：重复 CAS 失败刷 warn 并触发多余刷新。
// INV-12 已有在途补写时必须等待而不是跳过；守住位置：flushOnLeave 的 pendingWrite 分支；改错故障：跳过导致清除读不到 marker，随后的自动已读失效。
// INV-13 记录被新信号覆盖或清除后，迟到回包不得再驱动状态；守住位置：补写命令内的记录身份比较；改错故障：已清除的记录被写回未读，蓝点复活。
// INV-14 非查看路径入队写未读前，先删掉可能残留的前台完成记录；守住位置：receive 的 foregroundCompletions 删除分支；改错故障：同一次完成被补写两次，角标计数偏大。
// INV-15 首次查看状态未就绪时先阻塞写入，状态读取失败必须放行；守住位置：statusReady 与 initialStatus 的解析；改错故障：先写未读再立刻清除，或本地完成写永久挂起。
// INV-16 查看事实只认 Main 验证过的瞬时 mobileTaskView 与已提交的导航位置；守住位置：isRemoteViewing 与 isDesktopViewing；改错故障：缓存的 activeTaskId 让别的工作区同名任务被判为在面前。
// INV-17 远程查看匹配要求工作区身份一致，且双方都存在 session 时还要 session 相同；守住位置：isRemoteViewing 的三段比较；改错故障：同 taskId 的旧会话把当前会话的未读自动清掉。
// INV-18 订阅按 controller 与按 scope 二选一，并逐事件处理不依赖 React 合批；守住位置：subscriptions 构造与状态变更回调；改错故障：查看后立即离开的事实被合并掉，补记时机错位。
// INV-19 卸载后必须释放订阅、导航监听与 DOM 监听，迟到 Promise 不得刷新；守住位置：effect cleanup 与 disposed 守卫；改错故障：卸载后仍写库并刷新已销毁的列表。
// INV-20 接收水位与前台记录只按 key 覆盖，没有容量上限与定期裁剪；守住位置：received.current 的写入与失败回滚删除；改错故障：长时间开窗后键数量随任务数单调增长，内存缓慢上涨。
//
import { useEffect, useRef } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import type {
  ProjectTaskRef,
  WebRemoteControlStatus,
  WindowHostTaskUnreadSignal,
} from "@/project-sidebar/contract.js";
import { mutateProjectTask, readProjectTaskMeta } from "@/project-sidebar/task-mutation.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { onTaskNavigationCommitted } from "@/store/zcodeSessionStoreNavigation.js";
import { logger } from "@/logger.js";

/** 前台完成补记记录：written=已补写，marker=补写回包的未读版本（自动清除的 CAS 凭据）。 */
// [契约] 每条记录代表一次前台完成，target 是完整导航地址，written 表示未读是否已落库。
// [权衡] marker 存补写回包的 unreadAt，是后续自动已读的唯一凭据，不能由本地推算。
// [边界] 记录以 taskKey 为索引，同一任务在不同工作区各有一条，互不干扰。
interface ForegroundCompletionEntry {
  target: WindowHostTaskUnreadSignal["address"];
  written: boolean;
  marker?: number;
}
type ForegroundCompletionMap = Map<string, ForegroundCompletionEntry>;

/** 目录 Provider 是唯一消费者；只保存接收水位与在途命令，不另存一份未读状态。 */
// [契约] 入参 scopes 决定订阅哪些工作区事件，refresh 只做列表重载，observeRemoteViewing 决定是否接手机查看事实。
// [所有权] 本 hook 不返回任何未读状态，目录 Provider 是唯一消费者，避免出现第二份投影。
// [权衡] scopeKey 用 JSON 序列化参与依赖，只比较内容不比较数组引用，避免父组件重建数组导致反复重订阅。
// [资源] refresh 走 latestRefresh 引用，不进入依赖数组，否则每次渲染都会重建整条订阅链。
export function useProjectUnreadSignals(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
  refresh: () => Promise<void>,
  observeRemoteViewing = false,
) {
  const services = useBaseWorkspaceServices();
  const availablePlatform = useOptionalPlatform();
  const platform = observeRemoteViewing ? availablePlatform : null;
  const tabs = useTabStoreApi();
  const scopeKey = JSON.stringify(scopes);
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  // [并发] 这是跨 effect 存活的水位表，记录每个任务最后一次被接受的信号版本。
  // [去重] 版本单调推进，旧包与重复包直接丢弃，避免已读状态被回翻。
  // [资源] 只按 key 覆盖，没有容量上限与 LRU 裁剪，长期开窗下键数随任务数增长。
  // [失败路径] 只有写未读失败且水位仍是本条信号时才回滚删除，否则下次重试会被自己挡住。
  const received = useRef(new Map<string, { updatedAt: number; status: string }>());
  // useRef 而非 effect 内 Map：scopeKey 等依赖变化会让 effect 重跑，
  // 未补写/未清除的记录不能跟着闭包一起丢。
  const foregroundCompletionsRef = useRef<ForegroundCompletionMap>(new Map());
  // 同一任务的串行队列与在途标记必须跨 effect 存活：effect 重跑（scopeKey/services
  // 变化）后，旧实例未完成的 mark-unread 与新实例的重试/清除仍共用一条链，
  // 否则迟到的旧补写会在自动清除之后落库，重新制造无法自动清除的未读。
  // [并发] 每个任务一条 promise 链，补写与清除都接到链尾，天然串行。
  // [权衡] 放在组件级 ref 而非 effect 内 Map，scopeKey 变化重跑 effect 时旧实例的在途命令仍被新实例看见。
  // [失败路径] 链尾用 catch 吞掉错误后继续，单条命令失败不会堵死后续清除。
  // [故障] 若把队列放进 effect，旧补写会在新实例清除之后落库，重新制造清不掉的未读。
  const foregroundQueuesRef = useRef(new Map<string, Promise<void>>());
  // 在途补写按任务存 Promise：focus 早于补写回包到达时，flushThenClear 必须
  // 等待在途 Promise 落定后再做 marker CAS 清除，否则清除读不到 marker 而失效。
  // [时序] 按任务保存进行中的补写 Promise，focus 早于补写回包时用它对齐顺序。
  // [契约] flushThenClear 必须等这条 Promise 落定，才允许拿 marker 做 CAS 清除。
  // [资源] 命令结束即删除，包括成功与失败两条路径，避免悬挂引用。
  const foregroundPendingWritesRef = useRef(new Map<string, Promise<void>>());
  // [并发] focus 与 visibilitychange 可能连续触发，用集合占坑，避免对同一任务重复 mark-read。
  // [契约] 先占坑再入队，已被占坑的任务本轮直接跳过，等前一命令自己收尾。
  // [失败路径] 成功与失败都在收尾时移除占坑，失败留下的记录等下一次离开再重试。
  const foregroundPendingClearsRef = useRef(new Set<string>());
  const taskKey = (target: ProjectTaskRef) =>
    JSON.stringify([target.workspaceIdentity?.trim() || target.workspacePath, target.taskId]);
  // 队列挂在组件级 ref 上：跨 effect 串行；命令自身负责校验当前记录是否仍然有效。
  // [并发] 把命令接到该任务链尾再返回，调用方拿到的是本条命令而不是整条链。
  // [契约] 前一条失败不影响后一条，链条用 catch 转成已敲定状态继续。
  // [权衡] 返回 current 而非 settled，调用方才能感知本条命令的失败并记 warn。
  // [失败路径] 链尾只清理自己，若已被后继覆盖则保留，避免误删仍在排队的任务。
  const enqueueForegroundCommand = (
    target: ProjectTaskRef,
    command: () => Promise<void>,
  ) => {
    const key = taskKey(target);
    const previous = foregroundQueuesRef.current.get(key) ?? Promise.resolve();
    const current = previous.then(command);
    const settled = current
      .catch(() => {})
      .finally(() => {
        if (foregroundQueuesRef.current.get(key) === settled) {
          foregroundQueuesRef.current.delete(key);
        }
      });
    foregroundQueuesRef.current.set(key, settled);
    return current;
  };
  useEffect(() => {
    let disposed = false;
    // [状态] 登记本 effect 生命周期内已收到但尚未定论的信号，携带 viewed 与 started 两个事实位。
    // [契约] 手机查看事实与已提交导航都能把 viewed 置位，写未读回包后再补一次 CAS 已读。
    // [资源] finally 在同步收尾处删除登记，防止回包已处理完却仍挂着旧记录而漏掉新的查看命令。
    const pending = new Set<{
      target: WindowHostTaskUnreadSignal["address"];
      viewed: boolean;
      started: boolean;
    }>();
    const ports = {
      service: services.zcodeTaskService,
      controller: services.windowControllerService,
    };
    const foregroundCompletions = foregroundCompletionsRef.current;
    // 方案 A：前台完成不立即写未读，只记录；离开窗口（失焦/最小化/页面隐藏）时补写
    // 未读让角标/蓝点亮起，用户回到窗口且该任务仍在面前时按写回的精确 marker 自动
    // 清除——不允许「蓝点卡在正打开的任务上，必须点走再点回」。聚焦期间永不补记。
    // spec: docs/ui/task-unread-state.md 被动标记未读「前台完成的离开补记」。
    // 补写/清除的串行队列与在途标记挂在组件级 ref 上（跨 effect 共享）：effect 重跑
    // 后旧实例未完成的命令由新实例按共享记录继续，不会静默跳过或重复写入。
    // [时序] 离开窗口时遍历前台记录，只处理尚未补写的，已写的跳过。
    // [并发] 已有在途补写的任务改为等待其 Promise，而不是再发一次。
    // [契约] 全部命令并发入队但按任务串行，返回 Promise.all 供调用方等待。
    // [失败路径] 单条失败只记 warn 并触发刷新，不影响其余任务的补写。
    const flushOnLeave = () => {
      const writes: Array<Promise<void>> = [];
      for (const [key, entry] of foregroundCompletions) {
        if (entry.written) continue;
        // 已有在途补写：等待它完成（而不是跳过）。跳过会让紧随其后的
        // 自动清除读不到 marker，未读会永久卡在正打开的任务上。
        const pendingWrite = foregroundPendingWritesRef.current.get(key);
        if (pendingWrite) {
          writes.push(pendingWrite);
          continue;
        }
        const command = enqueueForegroundCommand(entry.target, async () => {
          // 记录已被新信号覆盖/清除时，迟到回包不再驱动状态。
          if (foregroundCompletionsRef.current.get(key) !== entry) return;
          const meta = await mutateProjectTask(
            ports,
            entry.target,
            { kind: "mark-unread" },
            entry.target.remoteSessionId,
          );
          // 写成功才置 written；失败保持 false，下个生命周期事件重试，不丢提醒。
          entry.written = true;
          if (meta?.unreadAt != null) entry.marker = meta.unreadAt;
        })
          .then(async () => {
            foregroundPendingWritesRef.current.delete(key);
            if (!disposed) await latestRefresh.current();
          })
          .catch((error: unknown) => {
            foregroundPendingWritesRef.current.delete(key);
            if (!disposed) {
              logger.warn("[project-sidebar] 前台完成补记未读写入失败", {
                ...entry.target,
                error,
              });
              void latestRefresh.current();
            }
          });
        foregroundPendingWritesRef.current.set(key, command);
        writes.push(command);
      }
      return Promise.all(writes);
    };
    // [时序] 回到窗口时只清「已补写且 marker 已就位」的记录，从未离开过的保持原样。
    // [契约] 任务必须仍被桌面或手机看着才清，否则等下一条信号决定。
    // [并发] 在途清除占坑后跳过重复触发，避免同一任务两次 CAS。
    // [失败路径] CAS 成功才删记录，失败保留等下一次离开重试。
    const clearOnFocus = () => {
      for (const [key, entry] of [...foregroundCompletions]) {
        // 只清「已补写且用户回到窗口时任务仍在面前」的记录；
        // 未补写的（还没离开过）保持记录，等真正的离开事件。
        if (!entry.written || entry.marker == null) continue;
        // focus 与 visibilitychange-visible 可能连发：在途清除去重，避免重复 mark-read。
        if (foregroundPendingClearsRef.current.has(key)) continue;
        if (!(isDesktopViewing(entry.target) || isRemoteViewing(entry.target))) continue;
        foregroundPendingClearsRef.current.add(key);
        // mark-read 排在同一任务队列里补写之后执行：此时补写回包已到、marker 已就位。
        // marker 仍为空说明补写失败（保留记录等下次离开重试）；CAS 成功才移除记录。
        // effect 重跑不中断本命令；迟到回包以「记录仍在」为准，不在清除前静默丢弃。
        void enqueueForegroundCommand(entry.target, async () => {
          if (entry.marker == null) return;
          await mutateProjectTask(
            ports,
            entry.target,
            { kind: "mark-read", expectedUnreadAt: entry.marker },
            entry.target.remoteSessionId,
          );
          if (foregroundCompletionsRef.current.get(key) === entry) {
            foregroundCompletionsRef.current.delete(key);
          }
        })
          .then(async () => {
            foregroundPendingClearsRef.current.delete(key);
            if (!disposed) await latestRefresh.current();
          })
          .catch((error: unknown) => {
            foregroundPendingClearsRef.current.delete(key);
            if (!disposed) {
              logger.warn("[project-sidebar] 前台完成自动已读失败", { ...entry.target, error });
              void latestRefresh.current();
            }
          });
      }
    };
    let remoteView: WebRemoteControlStatus["mobileTaskView"];
    let statusEventSeen = false;
    let statusReady = !platform;
    let releaseStatus!: () => void;
    const initialStatus = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    if (statusReady) releaseStatus();
    const isRemoteViewing = (target: WindowHostTaskUnreadSignal["address"]) =>
      remoteView?.taskId === target.taskId &&
      (remoteView.workspaceIdentity?.trim() || remoteView.workspacePath) ===
        (target.workspaceIdentity?.trim() || target.workspacePath) &&
      (!remoteView.remoteSessionId ||
        !target.remoteSessionId ||
        remoteView.remoteSessionId === target.remoteSessionId);
    const acceptStatus = (status: WebRemoteControlStatus) => {
      if (disposed) return;
      // 只消费 Main 验证后的瞬时查看事实；最后导航位置与连接状态宽限都不能代替它。
      const previousViewKey = remoteView
        ? JSON.stringify([taskKey(remoteView), remoteView.remoteSessionId])
        : null;
      remoteView = status.mobileTaskView;
      statusReady = true;
      releaseStatus();
      let pendingWrite = false;
      for (const operation of pending)
        if (isRemoteViewing(operation.target)) {
          operation.viewed = true;
          pendingWrite ||= operation.started;
        }
      if (
        !remoteView ||
        previousViewKey === JSON.stringify([taskKey(remoteView), remoteView.remoteSessionId]) ||
        pendingWrite
      )
        return;
      const target = remoteView;
      // 已有在途写时沿用其精确回包CAS；写入已结束的新查看才读取权威marker。
      // 后续完成命令排在此次读取和CAS之后，不能读到离开后产生的新marker。
      void enqueueForegroundCommand(target, async () => {
        const meta = await readProjectTaskMeta(ports, target, target.remoteSessionId);
        if (disposed || meta?.unreadAt == null) return;
        await mutateProjectTask(
          ports,
          target,
          { kind: "mark-read", expectedUnreadAt: meta.unreadAt },
          target.remoteSessionId,
        );
      })
        .then(() => {
          if (!disposed) return latestRefresh.current();
        })
        .catch((error) => {
          if (!disposed) {
            logger.warn("[project-sidebar] 查看任务已读写入失败", { ...target, error });
            void latestRefresh.current();
          }
        });
    };
    // 必须逐事件处理；React state 合批会丢失“查看后立即离开”的事实。
    // [边界] 订阅是可选能力，Web 端没有远控通道时为 undefined，整段查看逻辑走降级。
    // [时序] 先登记订阅再拉初始状态，用 statusEventSeen 保证事件优先、初始读取不覆盖新事实。
    // [资源] 卸载时统一释放，避免远控状态回调在销毁后继续写库。
    const unsubscribeStatus = platform?.onWebRemoteControlStatusChanged?.((status) => {
      statusEventSeen = true;
      acceptStatus(status);
    });
    if (platform)
      void platform
        .getWebRemoteControlStatus()
        .then((status) => {
          if (!statusEventSeen) acceptStatus(status);
        })
        .catch((error) => {
          if (disposed || statusEventSeen) return;
          // 状态不可读时不猜测“已经看过”，也不让本地完成写永久等待；新有效查看仍会通过精确 CAS 收敛。
          statusReady = true;
          releaseStatus();
          logger.warn("[project-sidebar] 查看状态初始读取失败", error);
        });
    const isDesktopViewing = (target: ProjectTaskRef) => {
      const tabState = tabs.getState();
      const tab = tabState.tabs.find((item) => item.id === tabState.activeTabId);
      const key = target.workspaceIdentity?.trim() || target.workspacePath;
      const state = useZCodeSessionStore.getState();
      const route = state.taskNavHistory.entries[state.taskNavHistory.cursor];
      // 前台完成只认完整导航地址；缓存 activeTaskId 或其它工作区的同名任务不代表当前页面。
      return Boolean(
        route?.kind === "task" &&
        route.taskId === target.taskId &&
        (route.workspaceIdentity?.trim() || route.workspacePath) === key &&
        tab &&
        isWorkspaceTab(tab) &&
        (tab.workspaceIdentity?.trim() || tab.workspacePath) === key &&
        state.getWorkspaceState(target.workspacePath, target.workspaceIdentity).activeTaskId ===
          target.taskId,
      );
    };
    // 跨工作区先激活 tab 会暴露缓存任务，草稿也可能保留旧历史；只消费选择提交的完整目标。
    const onVisibilityChange = () => {
      // 最小化/遮挡 = 离开（补写）；恢复可见 = 回来（先重试补写，再自动清除在面前的）。
      if (document.hidden) flushOnLeave();
      else flushThenClear();
    };
    // [时序] 先等补写全部落定，再执行清除，顺序反了清除就读不到 marker。
    // [契约] 这个顺序保证清除只消费本次补写写回的版本，不会误清其他来源的未读。
    // [并发] flushOnLeave 内部已按任务串行，合并等待不会放大写入。
    const flushThenClear = async () => {
      // 回到窗口/恢复可见：先等补写落定（source 恢复后补上提醒），
      // 再对已补写且仍在面前的任务做自动清除。顺序保证清除只消费已写 marker。
      await flushOnLeave();
      clearOnFocus();
    };
    window.addEventListener("blur", flushOnLeave);
    window.addEventListener("focus", flushThenClear);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const navigation = onTaskNavigationCommitted((target) => {
      for (const operation of pending) {
        if (
          operation.target.taskId === target.taskId &&
          (operation.target.workspaceIdentity?.trim() || operation.target.workspacePath) ===
            (target.workspaceIdentity?.trim() || target.workspacePath) &&
          isDesktopViewing(target)
        )
          operation.viewed = true;
      }
    });
    // [去重] 先按复合键查水位，旧版本或完全重复的信号直接返回。
    // [分支] 正在看的任务转为前台完成记录，页面已隐藏时立刻补写。
    // [分支] 非查看路径清掉残留前台记录，再入队写成普通未读。
    // [失败路径] 未敲定落库前失败才回滚水位，保证同一条信号能重试。
    const receive = (signal: WindowHostTaskUnreadSignal) => {
      if (disposed) return;
      const target = signal.address;
      const key = JSON.stringify([
        target.workspaceIdentity?.trim() || target.workspacePath,
        target.taskId,
      ]);
      const previous = received.current.get(key);
      if (
        previous &&
        (previous.updatedAt > signal.updatedAt ||
          (previous.updatedAt === signal.updatedAt && previous.status === signal.status))
      )
        return;
      received.current.set(key, signal);
      if (isDesktopViewing(target) || isRemoteViewing(target)) {
        // 信号到达时页面已隐藏（最小化），不会再有 blur 事件，直接补写。
        foregroundCompletions.set(taskKey(target), { target, written: false });
        if (document.hidden) flushOnLeave();
        return;
      }
      // 非查看路径本来就要写未读，顺带清掉可能残留的前台完成记录，避免重复补写。
      foregroundCompletions.delete(taskKey(target));
      const operation = { target, viewed: false, started: false };
      pending.add(operation);
      let committed = false;
      void enqueueForegroundCommand(target, async () => {
        try {
          if (!statusReady) await initialStatus;
          if (disposed || operation.viewed || isDesktopViewing(target) || isRemoteViewing(target))
            return;
          operation.started = true;
          const meta = await mutateProjectTask(
            ports,
            target,
            { kind: "mark-unread" },
            target.remoteSessionId,
          );
          committed = true;
          if (disposed) return;
          if (operation.viewed && meta?.unreadAt != null)
            await mutateProjectTask(
              ports,
              target,
              { kind: "mark-read", expectedUnreadAt: meta.unreadAt },
              target.remoteSessionId,
            );
        } finally {
          // JS同步结束处移除，防止回包处理已完成但pending尚存时丢掉新的查看命令。
          pending.delete(operation);
        }
      })
        .then(async () => {
          if (!disposed) await latestRefresh.current();
        })
        .catch((error: unknown) => {
          if (disposed) return;
          if (!committed && received.current.get(key) === signal) received.current.delete(key);
          logger.warn("[project-sidebar] 后台完成未读写入失败", { ...target, error });
          void latestRefresh.current();
        })
        .finally(() => pending.delete(operation));
    };
    const subscriptions = services.windowControllerService
      ? [services.windowControllerService.onDynamicTaskUnreadSignal()(receive)]
      : scopes.map((scope) =>
          services.zcodeTaskService.onDynamicWorkspaceEvent(scope)((event) => {
            if (
              event.type !== "workspace_task_list_changed" ||
              event.reason !== "task_status_changed" ||
              event.unreadSignal !== "background_terminal" ||
              !event.taskMeta ||
              (event.taskMeta.status !== "completed" && event.taskMeta.status !== "error")
            )
              return;
            receive({
              address: {
                taskId: event.taskId ?? event.taskMeta.taskId,
                workspacePath: event.workspacePath,
                ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
              },
              updatedAt: event.taskMeta.updatedAt,
              status: event.taskMeta.status,
            });
          }),
        );
    return () => {
      disposed = true;
      subscriptions.forEach((subscription) => subscription.dispose());
      navigation.dispose();
      unsubscribeStatus?.();
      window.removeEventListener("blur", flushOnLeave);
      window.removeEventListener("focus", flushThenClear);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      releaseStatus();
    };
  }, [services, tabs, platform, services.windowControllerService ? "controller" : scopeKey]);
}
