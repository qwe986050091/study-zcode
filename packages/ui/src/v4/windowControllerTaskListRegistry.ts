// INV-01 每个 controller 引用只允许一份注册表实例；守住位置：registries 这个 WeakMap 与 getWindowControllerTaskListRegistry 内的 existing 早返回；改错故障：每个列表 hook 各建一份观察器，同一 proxy 上重复订阅 Controller，帧处理与缓存成倍增长。
// INV-02 [并发] 启停必须由 started 与 generation 双检守护；守住位置：start 与 stop 对 started 的读写，以及帧回调、订阅回执里的 generation !== startGeneration 判断；改错故障：销毁后残留闭包继续写 revision 与 taskRows，旧会话数据污染新渲染。
// INV-03 [资源] 观察者生命周期按订阅者引用计数收口；守住位置：subscribe 返回的释放函数里 listeners.size === 0 才调用 stop；改错故障：还有订阅者时停表，列表永久停在旧快照且不再响应帧。
// INV-04 [资源] 停止顺序必须是先断帧通道、再清内存态、最后退订；守住位置：stop 内先置 started、自增 generation，再释放帧通道与清空游标、查询缓存、任务行，最后用 subscriptionIds 快照逐个退订；改错故障：先清 id 集合导致退订列表为空，Host 侧订阅泄漏。
// INV-05 [失败路径] 订阅回执必须在 generation 校验失败时主动退订；守住位置：start 内 Promise.all 回调中 await 之后的 !started 与 generation 比对分支；改错故障：窗口已销毁而 Host 仍向该订阅推帧，重连后出现重复 delta。
// INV-06 [失败路径] 订阅失败只降级为告警，不得让 start 抛出；守住位置：Promise.all 末尾的 catch 分支只写 warn；改错故障：单个 topic 订阅失败把异常抛进订阅副作用，整个列表 hook 崩溃。
// INV-07 [并发] 缺口检测必须早于游标推进；守住位置：帧回调里 isWindowHostControllerFrameGap 命中后先发强制快照请求再 return 的分支；改错故障：先写游标再补快照，丢失区间被当作已消费，列表永久缺项。
// INV-08 [失败路径] 缺口重同步失败不得伪装成游标已纠正；守住位置：重同步调用后的链式 catch 只写 warn 且不更新 cursors；改错故障：重同步失败却已推进游标，后续帧被当成连续，缺口无法再被发现。
// INV-09 [事务] 游标推进必须先于 topic 分派；守住位置：帧回调中写 cursors 的那行位于 WORKSPACES 分支与任务分支之前；改错故障：任务分支抛错时游标未更新，下一帧被判重复或缺口，触发多余全量快照。
// INV-10 [契约] 工作区 topic 帧不携带任务行，只做失效广播；守住位置：CONTROLLER_WORKSPACES_TOPIC 分支里两个 revision 自增后立即 return；改错故障：把它当任务帧解析增量，运行期抛类型错误或清空 taskRows。
// INV-11 [事务] 任务快照是权威全量替换；守住位置：payload.kind === "snapshot" 分支先清 taskRows、逐行写入、最后清空 queryCache；改错故障：旧行残留或旧 promise 复活，列表出现已删除任务。
// INV-12 [事务] 增量帧必须按行事实精确判定目录失效；守住位置：delta 循环里对变更前后行做 directoryFacts 比较，并显式覆盖 previous 或 next 缺失；改错故障：每次 live 更新都抬升目录版本，目录面板无意义重查。
// INV-13 [契约] 目录事实的 meta 裁剪只在存在 live activity 时生效；守住位置：directoryFacts 内 row.activity 三元分支过滤 updatedAt、status、pendingInteraction；改错故障：活动时间每次心跳都进入目录事实，目录版本随心跳抖动。
// INV-14 [事务] 来源版本只在 sourceAvailability 变化时自增；守住位置：delta 循环里 previous.sourceAvailability !== next.sourceAvailability 的判断；改错故障：来源重连未升级版本，连接前缓存跨代继续复用。
// INV-15 [并发] 查询缓存失效要按 membership 精确判定；守住位置：delta 循环中遍历 queryCache 时对 previous、next 与 matchesTaskListMembershipKind 的三重条件；改错故障：全量清空让每个 delta 触发多条 Host RPC，或漏删让 timeline 残留陈旧项。
// INV-16 [契约] 工作区归属比较必须走统一身份键；守住位置：queryContainsWorkspace 里 workspaceIdentity?.trim() || workspacePath 的取值与 scope 同构比较；改错故障：远程会话仅按路径匹配，跨 workspace 的失效判定失灵。
// INV-17 [并发] 通知必须按调度周期合并且先复位标志；守住位置：notifyOnce 内 notificationScheduled 的读写顺序与 queueMicrotask 中的 started 检查；改错故障：一帧多次通知触发多轮 render，或标志复位过晚吞掉后续通知。
// INV-18 [失败路径] 列表缓存以版本键复用同一 promise，失败时按 entry 身份删除；守住位置：list 内 versionKey 比较、写入 queryCache 与 catch 中 entry 同一性判断；改错故障：旧请求的失败回调删掉新请求缓存，导致重复 RPC 或返回过期结果。
//
// 模块职责：把单个 Controller proxy 的 v4 帧流收敛成一份共享观察器，维护任务行镜像、三个版本号与按查询键缓存的列表 promise。
// 状态所有权：listeners、cursors、subscriptionIds、queryCache、taskRows、revision 与 directoryRevision 与 sourceRevision、started 与 generation 全部封闭在 getWindowControllerTaskListRegistry 的闭包里，外部只拿到接口。
// 阅读顺序：先看接口与版本对象，再看事实归一化函数，然后看 notifyOnce 与 start、stop 的启停竞态，最后看帧回调里的快照、增量与失效判定，末尾是 list 缓存。
import type {
  IWindowControllerService,
  WindowHostControllerFrame,
  WindowHostControllerTaskListResult,
  ZCodeTaskListQuery,
} from "@zcode/services";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  CONTROLLER_WORKSPACES_TOPIC,
  isWindowHostControllerFrameGap,
  matchesTaskListMembershipKind,
  type WindowHostControllerCursor,
  type WindowHostControllerTaskFrame,
  type WindowHostControllerTaskRow,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";

// [契约] subscribe 返回释放函数，注册与注销成对出现，调用方必须显式释放，否则观察器常驻。
// [契约] 三个 revision 分工固定：revision 面向组件重渲染，directoryRevision 面向目录派生，sourceRevision 面向来源换代。
// [契约] readActivities 只做投影，返回在线且有活动的行，不暴露 taskRows 本体。
// [契约] list 返回 promise，相同版本键的重复调用共享同一次请求。
// [契约] list 的版本对象里 controllerRevision 只做外部记账，不进入缓存键。
// [权衡] workspaceSourceGenerationSignature 与 manualRefreshSerial 可选，缺省表示仅按协议签名判定是否复用。
export interface WindowControllerTaskListRegistry {
  subscribe(listener: () => void): () => void;
  getRevision(): number;
  getDirectoryRevision(): number;
  getSourceRevision(): number;
  readActivities(): Array<{
    address: WindowHostControllerTaskRow["address"];
    activity: NonNullable<WindowHostControllerTaskRow["activity"]>;
  }>;
  list(
    queryKey: string,
    version: WindowControllerTaskListVersion,
    query: ZCodeTaskListQuery,
  ): Promise<WindowHostControllerTaskListResult>;
}

export interface WindowControllerTaskListVersion {
  controllerRevision: number;
  taskListVersionSignature: string;
  /** 只用于让连接前缓存随 remote session 换代失效，不参与 workspace identity。 */
  workspaceSourceGenerationSignature?: string;
  manualRefreshSerial?: number;
}

// [状态所有权] 注册表以 controller 引用为键，WeakMap 保证 controller 被回收时观察器一起消失。
// [契约] getWindowControllerTaskListRegistry 先查再建，后建者永不覆盖已有实例。
// [契约] 注册表内不存放业务任务数据，任务行只存在于闭包 taskRows，随 stop 清空。
// [权衡] 不用普通 Map 是为了避免长生命周期缓存把已销毁连接及其任务行钉在内存里。
// [契约] 同一 controller 上的多个列表 hook 共享 revision，订阅成本与 hook 数量无关。
const registries = new WeakMap<object, WindowControllerTaskListRegistry>();

// [契约] 目录事实由地址、成员关系、来源可用性与裁剪后的 meta 四段组成，顺序固定。
// [事务] 存在 live activity 时剔除 updatedAt、status、pendingInteraction，避免活动心跳污染目录版本。
// [契约] 没有 activity 时直接使用完整 meta，保证持久事实变更仍能触发目录刷新。
// [权衡] 裁剪只针对活动行，等于承认活动摘要与目录事实共用 meta 字段。
// [并发] 比较依赖稳定序列化，meta 键序变化也会被当成目录变化，调用方不得重排 meta。
// [失败路径] 首次接入或撤销 live 的前后状态分别落入两条分支，这里是边界被刷新的位置。
function directoryFacts(row: WindowHostControllerTaskRow): string {
  // 活动的时间、状态与阻塞摘要也会覆盖 meta，不能把这些变化误判为目录失效。
  // 没有 live activity 时仍保留完整持久事实；首次接入或撤销 live 的边界也会刷新。
  const facts = row.activity
    ? Object.fromEntries(
        Object.entries(row.meta).filter(
          ([key]) => key !== "updatedAt" && key !== "status" && key !== "pendingInteraction",
        ),
      )
    : row.meta;
  return JSON.stringify([row.address, row.membership, row.sourceAvailability, facts]);
}

// [契约] 行键由 remoteSessionId、工作区身份、taskId 三元组序列化得到，顺序固定。
// [契约] remoteSessionId 缺省时填 local，本地与远程的同名 taskId 因此不会互相覆盖。
// [契约] 工作区段使用 workspaceIdentity?.trim() || workspacePath，与全局身份键规则一致。
// [权衡] 三元组不含 membership，成员关系变化只更新同一行，不产生新键。
// [失败路径] 键构造若漏掉 remoteSessionId，两个远端会话的同名任务会互相顶掉。
function taskAddressKey(address: WindowHostControllerTaskRow["address"]): string {
  return JSON.stringify([
    address.remoteSessionId ?? "local",
    address.workspaceIdentity?.trim() || address.workspacePath,
    address.taskId,
  ]);
}

function queryContainsWorkspace(
  query: ZCodeTaskListQuery,
  address: WindowHostControllerTaskRow["address"],
): boolean {
  const workspaceKey = address.workspaceIdentity?.trim() || address.workspacePath;
  return query.workspaceScopes.some(
    (scope) => (scope.workspaceIdentity?.trim() || scope.workspacePath) === workspaceKey,
  );
}

// [契约] 缓存键只含任务列表签名、来源换代签名与手动刷新序号，controllerRevision 被刻意排除。
// [权衡] 把全局 controllerRevision 放进键里，一个 timeline live delta 就会让 pinned 与 archived 全部 miss。
// [并发] 排除后由帧回调按 delta 的 scope 与 membership 精确失效，避免每帧多轮 Host RPC。
// [契约] manualRefreshSerial 保留强制刷新语义，手动刷新必然换键。
// [契约] workspaceSourceGenerationSignature 只用于让连接前缓存随 remote session 换代失效，不参与 workspace identity。
// [失败路径] 若把时间戳等易变值塞进键，缓存几乎永不命中，列表退化为每次渲染一次 RPC。
function cacheVersionKey(version: WindowControllerTaskListVersion): string {
  // Controller frame 只负责触发 hook 重读；具体 query 是否失效由 delta scope/membership 决定。
  // 若把全局 controllerRevision 放进缓存 key，一个 timeline live delta 仍会让 pinned/archived
  // 全部 miss，重新制造每个 frame 多轮 Host RPC。legacy/manual 版本继续保留强制刷新语义。
  return JSON.stringify({
    taskListVersionSignature: version.taskListVersionSignature,
    workspaceSourceGenerationSignature: version.workspaceSourceGenerationSignature,
    manualRefreshSerial: version.manualRefreshSerial,
  });
}

/** 一个 Controller proxy 对应一个共享观察器；所有列表 hook 只消费其 revision。 */
export function getWindowControllerTaskListRegistry(
  controller: IWindowControllerService,
): WindowControllerTaskListRegistry {
  const key = controller as object;
  const existing = registries.get(key);
  if (existing) return existing;

  const listeners = new Set<() => void>();
  const cursors = new Map<string, WindowHostControllerCursor>();
  const subscriptionIds = new Set<string>();
  const queryCache = new Map<
    string,
    {
      versionKey: string;
      promise: Promise<WindowHostControllerTaskListResult>;
      query: ZCodeTaskListQuery;
    }
  >();
  const taskRows = new Map<string, WindowHostControllerTaskRow>();
  let revision = 0;
  let directoryRevision = 0;
  let sourceRevision = 0;
  let started = false;
  let generation = 0;
  let notificationScheduled = false;
  let frameDisposable: { dispose(): void } | null = null;

  // [并发] 同一调度周期内的连续帧合并为一次通知，由 notificationScheduled 做闸门。
  // [事务] 微任务里先复位标志再自增 revision 并遍历监听者，保证通知期间新到的帧能重新排队。
  // [契约] revision 只在合并后的通知里自增一次，读取者拿到的是已提交的观测值。
  // [失败路径] 未启动时微任务直接返回，避免 stop 之后仍向空监听集合广播。
  // [权衡] 监听者遍历没有逐项隔离，某个监听者抛错会中断本轮后续监听者并把异常抛进微任务。
  // [契约] 通知只代表有变化，不携带具体差异，订阅方各自读取需要的 revision。
  const notifyOnce = (): void => {
    if (notificationScheduled) return;
    notificationScheduled = true;
    queueMicrotask(() => {
      notificationScheduled = false;
      if (!started) return;
      revision += 1;
      for (const listener of listeners) listener();
    });
  };

  // [资源] 先置 started 为 false 并自增 generation，让所有在途帧与订阅回执立即失效。
  // [资源] 随后释放帧通道、清空游标、查询缓存与任务行，避免旧数据被下一次启动复用。
  // [事务] 退订前先把 subscriptionIds 拷成数组，再清空集合，防止遍历中修改集合。
  // [失败路径] 退订请求失败被就地吞掉，只保证本地状态已清，不阻塞停机。
  // [契约] stop 对未启动的注册表是幂等的，重复释放不会重复退订。
  const stop = (): void => {
    if (!started) return;
    started = false;
    generation += 1;
    frameDisposable?.dispose();
    frameDisposable = null;
    cursors.clear();
    queryCache.clear();
    taskRows.clear();
    const ids = Array.from(subscriptionIds);
    subscriptionIds.clear();
    for (const subscriptionId of ids) {
      void controller.unsubscribeControllerV4({ subscriptionId }).catch(() => {});
    }
  };

  // [并发] started 早返回保证首次订阅者才真正建立通道，其余订阅者只挂监听。
  // [契约] startGeneration 捕获当前代号，帧回调与订阅回执都用它与实时 generation 比对。
  // [并发] 帧回调先做缺口判定，命中时发强制快照请求并直接返回，不推进游标。
  // [契约] 工作区 topic 走失效广播分支，任务 topic 才进入快照或增量处理。
  // [资源] 两个 topic 通过 Promise.all 并发订阅，任一失败由尾部 catch 统一降级为告警。
  // [失败路径] 订阅回执晚于停机时按回执里的 subscriptionId 补一次退订，防止 Host 侧悬挂。
  const start = (): void => {
    if (started) return;
    started = true;
    const startGeneration = ++generation;
    frameDisposable = controller.onDynamicControllerFrame()((frame: WindowHostControllerFrame) => {
      if (!started || generation !== startGeneration) return;
      const cursor = cursors.get(frame.subscriptionId);
      if (
        cursor &&
        frame.payload.kind !== "snapshot" &&
        isWindowHostControllerFrameGap(cursor, frame)
      ) {
        void controller
          .resyncControllerV4({
            subscriptionId: frame.subscriptionId,
            base: { logEpoch: cursor.logEpoch, seq: cursor.seq },
            forceSnapshot: true,
          })
          .catch((error) =>
            logger.warn("[windowControllerTaskListRegistry] Controller gap resync 失败", error),
          );
        return;
      }
      cursors.set(frame.subscriptionId, {
        subscriptionId: frame.subscriptionId,
        logEpoch: frame.logEpoch,
        seq: frame.toSeq,
      });
      if (frame.topic === CONTROLLER_WORKSPACES_TOPIC) {
        // Source 换代需要重新建立观察，即使 scope 和可见任务集合没有变化。
        sourceRevision += 1;
        directoryRevision += 1;
        notifyOnce();
        return;
      }
      const taskFrame = frame as WindowHostControllerTaskFrame;
      if (taskFrame.payload.kind === "snapshot") {
        directoryRevision += 1;
        sourceRevision += 1;
        taskRows.clear();
        for (const row of taskFrame.payload.snapshot.tasks) {
          taskRows.set(taskAddressKey(row.address), row);
        }
        queryCache.clear();
      } else {
        for (const delta of taskFrame.payload.deltas) {
          const address = delta.op === "task.upserted" ? delta.task.address : delta.address;
          const key = taskAddressKey(address);
          const previous = taskRows.get(key);
          const next = delta.op === "task.upserted" ? delta.task : undefined;
          if (!previous || !next || directoryFacts(previous) !== directoryFacts(next)) {
            directoryRevision += 1;
          }
          if (previous && next && previous.sourceAvailability !== next.sourceAvailability) {
            sourceRevision += 1;
          }
          if (next) taskRows.set(key, next);
          else taskRows.delete(key);

          for (const [queryKey, cached] of queryCache) {
            const touchesWorkspace = queryContainsWorkspace(cached.query, address);
            if (!touchesWorkspace) continue;
            // 以前任意 task delta 都 clear 全部 query。只有明确掌握旧 row 时，
            // 才按变更前后 membership 精确失效；缺少旧 row 时无法排除它曾属于其他 kind，
            // 因此对当前 workspace 保守失效，避免 timeline/active 留下陈旧项。
            if (
              !previous ||
              matchesTaskListMembershipKind(previous.membership, cached.query.kind) ||
              (next && matchesTaskListMembershipKind(next.membership, cached.query.kind))
            ) {
              queryCache.delete(queryKey);
            }
          }
        }
      }
      // 同一 JavaScript 调度周期内的连续 task frame 合并成一个 renderer revision。
      notifyOnce();
    });
    void Promise.all(
      [CONTROLLER_WORKSPACES_TOPIC, CONTROLLER_TASKS_INDEX_TOPIC].map(async (topic) => {
        const result = await controller.subscribeControllerV4({
          topic,
          visibility: "foreground",
        });
        if (!started || generation !== startGeneration) {
          await controller.unsubscribeControllerV4({
            subscriptionId: result.ack.subscriptionId,
          });
          return;
        }
        subscriptionIds.add(result.ack.subscriptionId);
      }),
    ).catch((error) =>
      logger.warn("[windowControllerTaskListRegistry] Controller subscribe 失败", error),
    );
  };

  const registry: WindowControllerTaskListRegistry = {
    subscribe(listener) {
      listeners.add(listener);
      start();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    getRevision() {
      return revision;
    },
    getDirectoryRevision() {
      return directoryRevision;
    },
    getSourceRevision() {
      return sourceRevision;
    },
    readActivities() {
      return Array.from(taskRows.values()).flatMap((row) =>
        row.sourceAvailability === "online" && row.activity
          ? [{ address: row.address, activity: row.activity }]
          : [],
      );
    },
    list(queryKey, version, query) {
      const versionKey = cacheVersionKey(version);
      const cached = queryCache.get(queryKey);
      if (cached?.versionKey === versionKey) return cached.promise;
      const promise = controller.listTaskList(query);
      const entry = { versionKey, promise, query };
      queryCache.set(queryKey, entry);
      void promise.catch(() => {
        if (queryCache.get(queryKey) === entry) queryCache.delete(queryKey);
      });
      return promise;
    },
  };
  registries.set(key, registry);
  return registry;
}
