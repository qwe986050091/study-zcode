/* eslint-disable max-lines -- Controller source 聚合、路由、订阅与生命周期属于同一个 Host 边界。 */
// Window Host 的 Controller（任务/会话投影）聚合运行时。
//
// 职责：按「source scope」把本机 local 与各 remote 的 task/agent 服务聚合成一份 V4 投影，
// 对外通过 IWindowControllerService 暴露列表查询、任务写操作与增量帧；不持久化任何数据，
// 每次在线查询都从对应 source 的 tasks-index 重建。
//
// 代际口径（#18 相关）：
// - sourceRefreshGenerations 是每个 source 的刷新代际：refresh/replace 完成后必须校验代际未变，
//   否则丢弃本次结果（防止旧连接刷新覆盖新连接）；
// - pendingReplacementByNextSourceKey 记录「断线 source -> 仍可信的上一代 scope」，
//   replaceDisconnectedSource 成功后才真正移交投影，失败则整链丢弃（不遗留孤儿 owner）；
// - 每个 attachment 由 createAttachmentService 生成独立实例（attachmentDisposed 标志），
//   dispose 只释放本附件的订阅与 emitter，不影响共享 projection；重复 dispose 幂等。
// - 写操作前后都用 assertCurrentSource 校验「同一 taskService + 同一 scope」，禁止跨代际写入。
//
// 失败语义：source 离线/未注册的读取统一抛错；写已持久成功后的刷新失败只上报 onSourceError，
// 不把成功写操作伪装成失败；投影保持最后一次可信快照，由后续事件收敛。
// 副作用：订阅 Agent/task 事件、按需创建 sessions-index observer；不下载、不落盘。
// 做：按 source scope 聚合 local 与各 remote 的 task/agent 服务，产出可订阅的列表投影与写操作入口。
// 不做：不持久化任务、不下载、不落盘，也不承载 session 业务状态；写完只触发刷新。
// 依赖：IZCodeTaskService 与 IZCodeAgentService、共享 projection、sessions-index observer。
// 边界：所有跨代际写入必须 fail-closed；迟到刷新只能被代际丢弃，不能被静默提交。
//
// 不变量（INV）：
// INV-01 断言：sourceKey 必须由 kind、source 标识与 identity 或 path 组成 —— 守住它的位置：sourceKey —— 改错故障：不同 remote 会话或不同工作区被合并成同一 source，投影串数据。
// INV-02 断言：同一 sourceKey 只能有一个 taskService 作为投影 owner —— 守住它的位置：sourceTaskServices 与 sourceSnapshotTaskServices —— 改错故障：新旧连接交替写入，列表在两次刷新之间跳变。
// INV-03 断言：换 owner 必须走 replaceDisconnectedSource，不能直接覆盖 —— 守住它的位置：registerResolvedSource 的 owner 变更分支 —— 改错故障：旧连接的订阅泄漏成孤儿。
// INV-04 断言：刷新读取完成后、提交之前必须比对代际 —— 守住它的位置：refreshSource 的 generation 检查 —— 改错故障：旧连接迟到的快照覆盖新连接。
// INV-05 断言：同一 taskService 的在途刷新必须复用同一 promise —— 守住它的位置：sourceRefreshFlights —— 改错故障：并发查询重复打远端，投影乱序。
// INV-06 断言：force 为 false 时只有 owner 未变且已有快照才能提前返回 —— 守住它的位置：refreshSource 的短路判断 —— 改错故障：新绑定的 workspace 永远读不到列表。
// INV-07 断言：写操作前后都必须校验同一 taskService 与 scope —— 守住它的位置：executeMutation 与 assertCurrentSource —— 改错故障：重连后写入旧 source 或错误 identity。
// INV-08 断言：离线 source 的读取必须抛错，不能静默使用旧快照 —— 守住它的位置：readSourceTaskIndex 与 executeMutation —— 改错故障：用户以为操作成功，实际没有落库。
// INV-09 断言：写已持久成功后刷新失败只能上报 onSourceError —— 守住它的位置：各 mutation 之后的 refresh catch —— 改错故障：成功结果被报成失败，用户重复操作。
// INV-10 断言：断线必须保留最后一次可信投影并让代际加一 —— 守住它的位置：disconnectSource —— 改错故障：网络抖动清空列表，或旧刷新回填已断线数据。
// INV-11 断言：未读信号必须在列表刷新之前立即发出 —— 守住它的位置：unreadSignals.fire —— 改错故障：等待列表 IO 期间用户查看了任务，未读漏记。
// INV-12 断言：列表刷新途中到达的 workspace 事件不能被 single-flight 吞掉 —— 守住它的位置：先 await inFlight 再 refresh —— 改错故障：完成事件丢失，未读状态停在旧值。
// INV-13 断言：observer 只允许复用同一 agentService 实例 —— 守住它的位置：ensureSourceSessionObserver —— 改错故障：旧 runtime 的会话快照被当成新 runtime 的事实。
// INV-14 断言：observer 回调必须校验 observer 身份 —— 守住它的位置：onSessionsChange 的守卫 —— 改错故障：被替换的 observer 迟到回调覆盖新 overlay。
// INV-15 断言：attachment dispose 之后禁止任何迟到写回 —— 守住它的位置：attachmentDisposed —— 改错故障：已关闭窗口修改共享投影。
// INV-16 断言：attachment dispose 不得触碰共享 projection —— 守住它的位置：createAttachmentService 的 dispose —— 改错故障：关闭一个窗口导致其它窗口列表消失。
// INV-17 断言：resolveTaskAddress 的匹配数必须恰好为一 —— 守住它的位置：matches.length 判断 —— 改错故障：不确定的地址被写到错误 source。
// INV-18 断言：allowMissingTask 只允许在 source 身份完整验证后生效 —— 守住它的位置：resolveTaskAddress 的缺失分支 —— 改错故障：任意 taskId 都能构造地址并触发删除。
// INV-19 断言：removeSource 必须双向清理 pendingReplacement 链 —— 守住它的位置：removeSource 的两段循环 —— 改错故障：关闭 scope 后遗留上一代 history 的孤儿投影。
//
import { Emitter, Event } from "@zcode/rpc";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  ControllerSubscribeParams,
  WindowHostControllerTaskRow,
  WindowHostTaskAddress,
} from "@zcode/shared/zcode-protocol-v4";
import {
  matchesTaskListMembershipKind,
  windowHostTaskAddressSchema,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  IWindowControllerService,
  IZCodeAgentService,
  IZCodeTaskService,
  WindowHostControllerFrame,
  WindowHostControllerTaskListItem,
  WindowHostControllerTaskListResult,
  WindowHostTaskUnreadSignal,
  ZCodeTaskListQuery,
  ZCodeTaskListWorkspaceScope,
} from "@zcode/services";
import {
  createWindowHostControllerProjection,
  type WindowHostControllerMutation,
  type WindowHostControllerMutationResult,
  type WindowHostControllerSessionOverlay,
  type WindowHostControllerSourceScope,
} from "./windowHostControllerProjection.js";
import {
  createWindowHostSessionsIndexObserver,
  type WindowHostSessionsIndexObserver,
} from "./windowHostSessionsIndexObserver.js";

// 解析结果：scope 是投影键来源，taskService/agentService 可能缺失（离线或未绑定），
// sourceAvailability 单独表达可读性——不能只看 services 是否存在。
// [契约] scope 是投影键来源，taskService 与 agentService 可能缺失（离线或未绑定）。
// [契约] sourceAvailability 单独表达可读性，不能只看 services 是否存在。
// [失败路径] 把有对象当在线，会让断线 source 继续接受写入。
// [权衡] 类型里保留可选服务而不是直接抛错，便于调用方区分离线与未注册。
export interface ResolvedWindowHostControllerSource {
  scope: WindowHostControllerSourceScope;
  taskService?: IZCodeTaskService;
  agentService?: IZCodeAgentService;
  sourceAvailability: "online" | "offline";
}

// [契约] 三段式 key：kind、source 标识、identity 或 path，缺一段都会让不同来源相撞。
// [契约] 本地 source 固定写 local，remote 优先 sourceServerId，其次 remoteSessionId。
// [失败路径] 用 remoteSessionId 替代 sourceServerId 会让同一服务器的重连被视为新 source。
// [契约] identity 先 trim 再回退 path，与仓库统一的 workspace key 口径一致。
function sourceKey(scope: WindowHostControllerSourceScope): string {
  return `${scope.kind}\0${scope.kind === "remote" ? (scope.sourceServerId ?? scope.remoteSessionId) : "local"}\0${scope.workspaceIdentity?.trim() || scope.workspacePath}`;
}

// [契约] 任务唯一性由 identity 或 path 加 taskId 决定，不能用 taskId 单键。
// [失败路径] 忽略 identity 会让不同远端会话的同名 taskId 合并成一行。
// [权衡] 用 \0 分隔避免路径中可能出现的冒号等字符造成歧义。
function taskKey(task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">) {
  return `${task.workspaceIdentity?.trim() || task.workspacePath}\0${task.taskId}`;
}

// [契约] 一律以 source scope 覆盖任务自带的 workspace 字段，防止上游返回旧路径。
// [失败路径] identity 缺失时必须显式写 undefined，不能保留 meta 里的旧值。
// [权衡] 不复制其它字段，避免在投影层引入与持久事实不一致的派生字段。
function normalizeTaskMeta(
  meta: ZCodeTaskMeta,
  scope: WindowHostControllerSourceScope,
): ZCodeTaskMeta {
  return {
    ...meta,
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity
      ? { workspaceIdentity: scope.workspaceIdentity }
      : { workspaceIdentity: undefined }),
  };
}

// [契约] 排序稳定：时间倒序后用 taskId 升序兜底，避免同毫秒任务顺序抖动。
// [契约] sortBy 只允许 created 与 updated，未知值按 updated 处理。
// [失败路径] 缺少 taskId 兜底会让分页边界处的行重复或丢失。
function compareItems(
  left: WindowHostControllerTaskListItem,
  right: WindowHostControllerTaskListItem,
  sortBy: ZCodeTaskListQuery["sortBy"],
): number {
  const leftAt = sortBy === "created" ? left.createdAt : left.updatedAt;
  const rightAt = sortBy === "created" ? right.createdAt : right.updatedAt;
  return rightAt - leftAt || left.taskId.localeCompare(right.taskId);
}

// [契约] 地址到 RPC 参数的唯一转换点，可选 identity 只在存在时展开。
// [失败路径] 显式传 undefined 会让严格 schema 校验失败。
// [契约] 不在这里补 remote 信息：远端路由由 facade 负责。
function mutationParams(address: WindowHostTaskAddress) {
  return {
    taskId: address.taskId,
    workspacePath: address.workspacePath,
    ...(address.workspaceIdentity ? { workspaceIdentity: address.workspaceIdentity } : {}),
  };
}

// [契约] liveStatus 的优先级：等待交互、运行中、错误、完成、空闲。
// [契约] pendingInteraction 与 activity 都是可选投影，缺失时不要伪造空对象。
// [失败路径] 把 error 归为 idle 会让失败会话在列表里看起来正常。
// [权衡] 只投影展示所需字段，避免把完整 SessionSummary 复制进 Host 内存。
function sessionOverlay(
  summary: import("@zcode/shared/zcode-protocol-v4").SessionSummary,
): WindowHostControllerSessionOverlay {
  const liveStatus: WindowHostControllerSessionOverlay["liveStatus"] =
    summary.pendingInteraction ||
    (summary.pendingInteractionSummary &&
      summary.pendingInteractionSummary.permissionCount +
        summary.pendingInteractionSummary.userInputCount >
        0)
      ? "waiting"
      : summary.phase === "prewarming" || summary.phase === "running"
        ? "running"
        : summary.phase === "error"
          ? "error"
          : summary.phase === "completedSuccess" || summary.phase === "completedInterrupted"
            ? "completed"
            : "idle";
  return {
    taskId: summary.sessionId,
    liveStatus,
    title: summary.title,
    ...(summary.titleSource ? { titleSource: summary.titleSource } : {}),
    updatedAt: summary.lastActivityAt,
    ...(summary.pendingInteraction
      ? {
          pendingInteraction: {
            interactionId: summary.pendingInteraction.interactionId,
            kind: summary.pendingInteraction.kind,
            ...(summary.pendingInteraction.toolName
              ? { toolName: summary.pendingInteraction.toolName }
              : {}),
            ...(summary.pendingInteraction.autoResolution
              ? { autoResolution: summary.pendingInteraction.autoResolution }
              : {}),
          },
        }
      : {}),
    activity: {
      phase: summary.phase,
      lastActivityAt: summary.lastActivityAt,
      hasBackgroundWork: summary.hasBackgroundWork,
      ...(summary.pendingInteractionSummary
        ? { pendingInteractions: summary.pendingInteractionSummary }
        : {}),
      ...(summary.workflowActivity ? { workflowActivity: summary.workflowActivity } : {}),
    },
  };
}

// [契约] 仅用于没有 live overlay 的兜底：完成与错误，其余一律 idle。
// [失败路径] 把运行中映射成 idle 会让没有 observer 的远端任务看起来静止。
// [权衡] 宁可低估活跃状态，也不在列表里制造不存在的运行中。
function liveStatusFromMeta(meta: ZCodeTaskMeta): WindowHostControllerTaskRow["liveStatus"] {
  if (meta.status === "completed") return "completed";
  if (meta.status === "error") return "error";
  return "idle";
}

/**
 * WindowHostControllerRuntime 是 Local Host 内的聚合权威。它不持久化数据；每次在线查询都从
 * 对应 source 的 tasks-index 重建投影，断连时只冻结最后一次成功的内存快照。
 */
// 输入：createId（订阅/subscriptionId 生成）、resolveSource（scope -> 服务面）、onSourceError（刷新失败上报）。
// 输出：service（共享实例）+ createAttachmentService（按 attachment 隔离的实例）+ 生命周期方法。
// 副作用：维护多张按 sourceKey 索引的表；会订阅 task/agent 事件与 sessions-index。
// 不变量：同一 sourceKey 只有一个 taskService 作为投影 owner（sourceSnapshotTaskServices 记录），
//   换 owner 必须走 replaceDisconnectedSource，不能直接覆盖。
// 失败语义：刷新失败只影响该 source 的投影新鲜度，不会抛出到无关调用方。
// [契约] Runtime 是 Local Host 内的聚合权威，但不持久化任何数据。
// [契约] 每次在线查询都从对应 source 的 tasks-index 重建，断连时冻结最后一次快照。
// [副作用] 只订阅 Agent 与 task 事件、按需创建 sessions-index observer，不下载、不落盘。
// [失败路径] 刷新失败只影响该 source 的新鲜度，不向无关调用方抛出。
// [资源] 返回的 service 是共享实例，createAttachmentService 才按 attachment 隔离。
export function createWindowHostControllerRuntime(options: {
  createId: () => string;
  resolveSource: (scope: ZCodeTaskListWorkspaceScope) => ResolvedWindowHostControllerSource | null;
  onSourceError?: (
    scope: WindowHostControllerSourceScope,
    operation: "refresh" | "search",
    error: unknown,
  ) => void;
}) {
  const projection = createWindowHostControllerProjection({ createId: options.createId });
  const unreadSignals = new Emitter<WindowHostTaskUnreadSignal>();
  const registeredScopes = new Map<string, WindowHostControllerSourceScope>();
  const sourceAvailability = new Map<string, "online" | "offline">();
  const sourceTaskServices = new Map<string, IZCodeTaskService>();
  const sourceSnapshotTaskServices = new Map<string, IZCodeTaskService>();
  const sourceEventSubscriptions = new Map<string, { dispose(): void }>();
  const sourceRefreshFlights = new Map<
    string,
    { taskService: IZCodeTaskService; promise: Promise<void> }
  >();
  const sourceRefreshGenerations = new Map<string, number>();
  const sourceLiveOverlays = new Map<string, WindowHostControllerSessionOverlay[]>();
  const sourceSessionObservers = new Map<
    string,
    { agentService: IZCodeAgentService; observer: WindowHostSessionsIndexObserver }
  >();
  const pendingReplacementByNextSourceKey = new Map<string, WindowHostControllerSourceScope>();

  // 彻底注销一个 source：释放事件订阅与 observer，清空各表，并把 refresh 代际 +1，
  // 让所有在途刷新结果失效（这是「删除 source」与「换 owner」共用的清理原语）。
  // [契约] 这是删除 source 与换 owner 共用的清理原语，必须清空全部按 key 索引的表。
  // [并发] 代际加一是让在途刷新失效的唯一手段，不依赖 abort。
  // [资源] 先 dispose 订阅与 observer 再删表，避免回调过程中读到半清理状态。
  // [失败路径] 漏删 sourceRefreshFlights 会让下一次刷新复用旧 promise 并写回旧快照。
  function forgetRegisteredSource(scope: WindowHostControllerSourceScope): void {
    const key = sourceKey(scope);
    registeredScopes.delete(key);
    sourceAvailability.delete(key);
    sourceTaskServices.delete(key);
    sourceSnapshotTaskServices.delete(key);
    sourceEventSubscriptions.get(key)?.dispose();
    sourceEventSubscriptions.delete(key);
    sourceSessionObservers.get(key)?.observer.dispose();
    sourceSessionObservers.delete(key);
    sourceLiveOverlays.delete(key);
    sourceRefreshGenerations.set(key, (sourceRefreshGenerations.get(key) ?? 0) + 1);
    sourceRefreshFlights.delete(key);
  }

  // 保证某个 source 的 sessions-index observer 与当前 agentService 一致。
  // 复用条件严格是「同一 agentService 实例」：换实例即 dispose 旧 observer 并清空 live overlay，
  // 防止旧 runtime 的会话快照被当成新 runtime 的事实；离线时不新建，只复用现有（保持冻结）。
  // [契约] 离线时不新建 observer，只复用现有实例，保持最后一份 overlay 冻结。
  // [并发] 复用条件严格是同一 agentService 实例，实例不同即视为新一代 runtime。
  // [失败路径] 换实例时必须清空 live overlays，否则旧会话快照被当成新事实。
  // [资源] 旧 observer 必须先 dispose 再创建新的，避免两个观察者同时推送。
  // [契约] 没有 agentService 时清空 observer 与 overlay，并同步清掉投影。
  function ensureSourceSessionObserver(
    resolved: ResolvedWindowHostControllerSource,
  ): WindowHostSessionsIndexObserver | null {
    const key = sourceKey(resolved.scope);
    if (resolved.sourceAvailability !== "online") {
      return sourceSessionObservers.get(key)?.observer ?? null;
    }
    if (!resolved.agentService) {
      sourceSessionObservers.get(key)?.observer.dispose();
      sourceSessionObservers.delete(key);
      if (sourceLiveOverlays.delete(key)) {
        projection.replaceSourceSessionOverlays(resolved.scope, []);
      }
      return null;
    }
    // [并发] 复用判断只看实例身份，不做方法级比较：代理对象每次可能不同。
    // [失败路径] 这一步之后的 dispose 与 delete 必须成对，否则表里留下已销毁的 observer。
    // [契约] 返回的 observer 由调用方 start，本函数不启动。
    const current = sourceSessionObservers.get(key);
    if (current?.agentService === resolved.agentService) return current.observer;
    current?.observer.dispose();
    if (sourceLiveOverlays.delete(key)) {
      projection.replaceSourceSessionOverlays(resolved.scope, []);
    }
    let observer!: WindowHostSessionsIndexObserver;
    observer = createWindowHostSessionsIndexObserver({
      agentService: resolved.agentService,
      target: {
        workspacePath: resolved.scope.workspacePath,
        ...(resolved.scope.workspaceIdentity
          ? { workspaceIdentity: resolved.scope.workspaceIdentity }
          : {}),
      },
      // [并发] 先校验 observer 身份：被替换的旧观察者仍可能收到一次迟到回调。
      // [契约] 先写 live overlay 再替换投影，保证后续 refresh 能带上最新会话事实。
      // [失败路径] 反过来会让投影引用一份尚未登记的快照，重连时丢状态。
      onSessionsChange: (sessions) => {
        if (sourceSessionObservers.get(key)?.observer !== observer) return;
        const overlays = sessions.map(sessionOverlay);
        sourceLiveOverlays.set(key, overlays);
        projection.replaceSourceSessionOverlays(resolved.scope, overlays);
      },
      onError: (error) => options.onSourceError?.(resolved.scope, "refresh", error),
    });
    sourceSessionObservers.set(key, { agentService: resolved.agentService, observer });
    return observer;
  }

  // [契约] 只转发 workspace 维度，不携带 remote 信息：resolveSource 由 Host 绑定决定。
  // [失败路径] 传入过期 scope 会解析到新 source，因此调用方必须再用 sourceKey 比对。
  function resolveCurrentSource(
    scope: WindowHostControllerSourceScope,
  ): ResolvedWindowHostControllerSource | null {
    return options.resolveSource({
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    });
  }

  // 执行一次任务写操作：先解析当前 source 并校验在线，再经 projection.mutate 落到唯一持久 owner，
  // 成功后强制刷新投影（失败只上报 onSourceError，不改写已提交结果）。
  // 失败语义：source 失效/离线直接抛错，不排队、不重试。
  // [契约] 写操作必须先解析当前 source 并校验在线，再落到唯一持久 owner。
  // [失败路径] source 失效或离线直接抛错，不排队、不重试。
  // [并发] 每次写都重新解析，不能用注册时缓存的 taskService。
  // [契约] 写成功后强制刷新投影；刷新失败只上报，不改写已提交结果。
  // [权衡] delete-archived-batch 先校验 sourceKey：确认期间远端可能已替换。
  async function executeMutation(
    scope: WindowHostControllerSourceScope,
    address: WindowHostTaskAddress,
    mutation: WindowHostControllerMutation,
  ): Promise<WindowHostControllerMutationResult> {
    const current = resolveCurrentSource(scope);
    if (!current?.taskService || current.sourceAvailability !== "online") {
      throw new Error(
        scope.kind === "remote" ? "远程 source 当前离线，禁止列表写操作" : "本地 source 当前不可用",
      );
    }
    const service = current.taskService;
    const base = mutationParams(address);
    switch (mutation.kind) {
      case "rename":
        await service.renameTask({ ...base, title: mutation.title });
        break;
      case "pin":
        await service.setTaskPinned({ ...base, pinned: mutation.pinned });
        break;
      case "archive":
        if (mutation.archived) {
          await service.archiveTask(base);
        } else {
          await service.unarchiveTask(base);
        }
        break;
      case "delete":
        await service.deleteTask(base);
        break;
      case "delete-archived":
        return service.deleteArchivedTask(base);
      // [契约] 批次删除必须整批落在同一 source，不能跨代际混写。
      // [失败路径] sourceKey 不一致时抛错，宁可让用户重试也不写到新 identity。
      // [契约] 返回逐项结果，调用方据此展示部分失败。
      case "delete-archived-batch":
        // 确认期间远端 session 可能已替换；不能将旧地址的批次写入同 identity 的新 source。
        if (sourceKey(current.scope) !== sourceKey(scope)) {
          throw new Error("归档删除批次的 source 已替换");
        }
        return service.deleteArchivedTasks({
          workspacePath: base.workspacePath,
          workspaceIdentity: base.workspaceIdentity,
          taskIds: mutation.taskIds,
        });
      case "mark-read":
        return normalizeTaskMeta(
          await service.setTaskUnread({
            ...base,
            unread: false,
            ...(mutation.expectedUnreadAt != null
              ? { expectedUnreadAt: mutation.expectedUnreadAt }
              : {}),
          }),
          current.scope,
        );
      case "mark-unread":
        return normalizeTaskMeta(
          await service.setTaskUnread({ ...base, unread: true }),
          current.scope,
        );
      // [契约] open 与 resume 不落写操作，Controller 只负责验证唯一 source。
      // [失败路径] 在这里补写逻辑会绕过 facade 的会话路由，产生第二条写入路径。
      // [契约] 后续 conversation 行为由 scoped facade 负责，本层不感知协议。
      case "open":
      case "resume":
        // open/resume 的 Controller 职责是验证唯一 source；conversation 随后仍走 scoped facade。
        break;
      default: {
        const exhaustive: never = mutation;
        throw new Error(`未知 Controller mutation: ${String(exhaustive)}`);
      }
    }
  }

  // 登记 source 的在线服务面：只在 owner（taskService）变化时重建事件订阅，
  // 重复登记同一 taskService 是幂等的；离线则替换为断开投影。
  // [契约] 只有首次登记才注册投影，重复登记必须幂等。
  // [并发] 仅当 owner taskService 变化才重建事件订阅，避免重复订阅同一实例。
  // [失败路径] 离线时保留 scope 登记但断开投影，重连后走 replace 而非重新注册。
  // [契约] snapshot owner 与事件订阅 owner 分开维护：前者决定是否跳过刷新，后者决定事件来源。
  function registerResolvedSource(resolved: ResolvedWindowHostControllerSource): void {
    const key = sourceKey(resolved.scope);
    if (!registeredScopes.has(key)) {
      registeredScopes.set(key, resolved.scope);
      projection.registerSource({
        scope: resolved.scope,
        mutate: (address, mutation) => executeMutation(resolved.scope, address, mutation),
      });
    }
    const previousAvailability = sourceAvailability.get(key);
    sourceAvailability.set(key, resolved.sourceAvailability);
    if (
      resolved.taskService &&
      sourceSnapshotTaskServices.has(key) &&
      sourceSnapshotTaskServices.get(key) !== resolved.taskService
    ) {
      sourceSnapshotTaskServices.delete(key);
    }
    if (
      resolved.taskService &&
      resolved.sourceAvailability === "online" &&
      typeof resolved.taskService.onDynamicWorkspaceEvent === "function" &&
      sourceTaskServices.get(key) !== resolved.taskService
    ) {
      sourceEventSubscriptions.get(key)?.dispose();
      const taskService = resolved.taskService;
      // [并发] 事件回调必须同时校验表内 owner、在线状态与当前解析结果。
      // [失败路径] 只看表内 owner 会让已替换的 source 继续刷新旧投影。
      // [契约] 三处任一不一致都视为旧连接，直接丢弃事件。
      const isCurrentSource = () => {
        const current = resolveCurrentSource(resolved.scope);
        return (
          sourceTaskServices.get(key) === taskService &&
          sourceAvailability.get(key) === "online" &&
          current?.taskService === taskService &&
          current?.sourceAvailability === "online"
        );
      };
      sourceTaskServices.set(key, taskService);
      sourceEventSubscriptions.set(
        key,
        taskService.onDynamicWorkspaceEvent({
          workspacePath: resolved.scope.workspacePath,
          ...(resolved.scope.workspaceIdentity
            ? { workspaceIdentity: resolved.scope.workspaceIdentity }
            : {}),
        })((event) => {
          // Bug 根因：Controller 接管观察后只刷新列表，丢掉了 Host 的明确完成信号。
          // 沿现有 source 监听转发实时事实；旧连接、离线 source 和普通快照都不能制造未读。
          if (!isCurrentSource()) return;
          const signal: WindowHostTaskUnreadSignal | undefined =
            event.type === "workspace_task_list_changed" &&
            event.reason === "task_status_changed" &&
            event.unreadSignal === "background_terminal" &&
            event.taskMeta &&
            (event.taskMeta.status === "completed" || event.taskMeta.status === "error")
              ? {
                  address: {
                    taskId: event.taskId ?? event.taskMeta.taskId,
                    workspacePath: resolved.scope.workspacePath,
                    ...(resolved.scope.workspaceIdentity
                      ? { workspaceIdentity: resolved.scope.workspaceIdentity }
                      : {}),
                    ...(resolved.scope.kind === "remote"
                      ? {
                          ...(resolved.scope.sourceServerId
                            ? { sourceServerId: resolved.scope.sourceServerId }
                            : {}),
                          ...(resolved.scope.remoteSessionId
                            ? { remoteSessionId: resolved.scope.remoteSessionId }
                            : {}),
                        }
                      : {}),
                  },
                  updatedAt: event.taskMeta.updatedAt,
                  status: event.taskMeta.status,
                }
              : undefined;
          // Bug 根因：等列表 IO 后才通知会漏记期间的查看；立即交给窗口记录，行就绪由 mutation 验证。
          // [契约] 未读信号表达已收到的完成事实，必须先于列表 IO 发出。
          // [失败路径] 等刷新完成再通知会漏记期间的查看操作。
          // [契约] 只有 background_terminal 且状态为 completed 或 error 才产生未读。
          if (signal) unreadSignals.fire(signal);
          // workspace event 可能在列表首轮 refresh 读取途中到达；直接复用
          // single-flight 会把事件吞掉。先等在途读取结束，再把多个事件合并成下一轮 refresh。
          // [并发] 事件可能在首轮 refresh 读取途中到达，直接复用 single-flight 会把它吞掉。
          // [契约] 先等当前在途读取结束，再发起下一轮刷新，保证事件最终被观察到。
          // [失败路径] 在途读取失败不阻断后续刷新：完成信号已经成立。
          // [资源] await 之后必须重新校验 source，期间可能已经断线或被替换。
          const inFlight = sourceRefreshFlights.get(key)?.promise;
          void (async () => {
            await inFlight?.catch(() => {});
            if (!isCurrentSource()) return;
            const current = resolveCurrentSource(resolved.scope);
            if (current) {
              // 完成信号是已收到的事实，读取投影失败不能把它吞掉；写入仍由原 mutation 验证真实行。
              await refreshSource(current, true).catch((error) =>
                options.onSourceError?.(current.scope, "refresh", error),
              );
            }
          })().catch((error) => options.onSourceError?.(resolved.scope, "refresh", error));
        }),
      );
    }
    if (resolved.sourceAvailability === "offline" && previousAvailability === "online") {
      sourceSessionObservers.get(key)?.observer.dispose();
      sourceSessionObservers.delete(key);
      sourceSnapshotTaskServices.delete(key);
      projection.disconnectSource(resolved.scope);
    }
  }

  // 读取单个 source 的三类任务（active/pinned/archived）并按 taskKey 合并 membership。
  // 为什么合并：同一任务可能同时属于多个列表（例如 pinned 也是 active），需要一份带标记的并集，
  // 否则投影会出现重复行；后写覆盖前写即「更具体的 membership 优先」。
  // 失败语义：source 离线/无 taskService 直接抛错（调用方不得静默使用旧快照）。
  // [契约] 读取 active、pinned、archived 三个列表并按 taskKey 合并 membership。
  // [契约] 同一任务可能同时属于多个列表（pinned 也是 active），必须产出带标记的并集。
  // [失败路径] 后写覆盖前写是有意的更具体 membership 优先，不要改成取第一个。
  // [契约] source 离线或无 taskService 直接抛错，调用方不得静默使用旧快照。
  async function readSourceTaskIndex(resolved: ResolvedWindowHostControllerSource) {
    if (!resolved.taskService || resolved.sourceAvailability !== "online") {
      throw new Error("Controller source 当前不可读取");
    }
    const request = {
      workspacePath: resolved.scope.workspacePath,
      ...(resolved.scope.workspaceIdentity
        ? { workspaceIdentity: resolved.scope.workspaceIdentity }
        : {}),
    };
    // [并发] 三个列表由 Promise.all 并行读取，减少一次刷新对远端的往返次数。
    // [失败路径] 任一失败整体 reject，避免用半份 membership 覆盖可信投影。
    // [契约] 不使用 allSettled：部分成功会产生难以解释的列表缺行。
    const [active, pinned, archived] = await Promise.all([
      resolved.taskService.listTasks(request),
      resolved.taskService.listPinnedTasks(request),
      resolved.taskService.listArchivedTasks(request),
    ]);
    const membershipByTaskKey = new Map<
      string,
      {
        meta: ZCodeTaskMeta;
        membership: { pinned: boolean; archived: boolean; active: boolean };
      }
    >();
    for (const task of active) {
      const normalized = normalizeTaskMeta(task, resolved.scope);
      membershipByTaskKey.set(taskKey(normalized), {
        meta: normalized,
        membership: { pinned: false, archived: false, active: true },
      });
    }
    for (const task of pinned) {
      const normalized = normalizeTaskMeta(task, resolved.scope);
      membershipByTaskKey.set(taskKey(normalized), {
        meta: normalized,
        membership: { pinned: true, archived: false, active: true },
      });
    }
    for (const task of archived) {
      const normalized = normalizeTaskMeta(task, resolved.scope);
      membershipByTaskKey.set(taskKey(normalized), {
        meta: normalized,
        membership: { pinned: false, archived: true, active: false },
      });
    }
    return Array.from(membershipByTaskKey.values());
  }

  // 刷新一个 source 的投影（single-flight + 代际校验）。
  // force=false 时若 owner taskService 未变且已有快照则直接返回（避免每次查询都打远端）；
  // force=true 用于写后收敛与重连替换。相同 taskService 的在途刷新会复用同一 promise。
  // 不变量：读取完成后必须比对 sourceRefreshGenerations，代际变了就抛错丢弃结果；
  //   提交前调用 beforeCommit（供替换流程校验外部事务是否仍有效）。
  // [契约] single-flight 加代际校验是刷新正确性的两个支点，缺一不可。
  // [契约] force 为 false 时，owner 未变且已有快照直接返回，避免每次查询都打远端。
  // [契约] force 为 true 用于写后收敛与重连替换。
  // [并发] 相同 taskService 的在途刷新复用同一 promise，不同实例必须新建。
  // [失败路径] 代际变化或 beforeCommit 抛错都中止提交，旧投影保持不动。
  async function refreshSource(
    resolved: ResolvedWindowHostControllerSource,
    force = false,
    beforeCommit?: () => void,
  ): Promise<void> {
    registerResolvedSource(resolved);
    if (!resolved.taskService || resolved.sourceAvailability !== "online") {
      return;
    }
    const key = sourceKey(resolved.scope);
    await ensureSourceSessionObserver(resolved)?.start();
    if (!force && sourceSnapshotTaskServices.get(key) === resolved.taskService) return;
    const existing = sourceRefreshFlights.get(key);
    if (existing?.taskService === resolved.taskService) return existing.promise;
    // [并发] 每次刷新把 generation 加一，让更早的在途结果必然失效。
    // [契约] 代际只增不减，不能用时间戳替代：同毫秒刷新无法区分先后。
    // [失败路径] 忘记在读取后比对会让慢请求覆盖快请求。
    const generation = (sourceRefreshGenerations.get(key) ?? 0) + 1;
    sourceRefreshGenerations.set(key, generation);
    const promise = (async () => {
      const taskIndex = await readSourceTaskIndex(resolved);
      if (sourceRefreshGenerations.get(key) !== generation) {
        throw new Error("Controller source refresh generation 已失效");
      }
      // [契约] 提交前回调用于替换流程校验外部事务是否仍然有效。
      // [失败路径] 抛错即放弃本次提交，失败由 replaceDisconnectedSource 的 catch 处理。
      // [并发] 回调必须同步判断：异步判断期间代际可能再次变化。
      beforeCommit?.();
      // [契约] 只有替换流程会写入 pending，普通刷新取到 undefined。
      // [失败路径] 提交前读取一次、提交后删除，保证旧 scope 只在成功的快照中被移除。
      // [并发] 快照与移除在同一个同步块内完成，订阅方看到的是一个 delta 帧。
      const previousScope = pendingReplacementByNextSourceKey.get(key);
      projection.replaceSourceSnapshot({
        scope: resolved.scope,
        ...(previousScope ? { replacesScope: previousScope } : {}),
        taskIndex,
        // live facts 仅驻 Host 内存；observer 使用 existing-only，列表读取不会启动 Agent。
        sessionsIndex: sourceLiveOverlays.get(key) ?? [],
      });
      if (previousScope) {
        forgetRegisteredSource(previousScope);
        pendingReplacementByNextSourceKey.delete(key);
      }
      sourceAvailability.set(key, "online");
      sourceSnapshotTaskServices.set(key, resolved.taskService!);
    })();
    sourceRefreshFlights.set(key, { taskService: resolved.taskService, promise });
    try {
      await promise;
    } finally {
      if (sourceRefreshFlights.get(key)?.promise === promise) {
        sourceRefreshFlights.delete(key);
      }
    }
  }

  // 用新 source 替换「已断线但投影仍可信」的旧 scope（重连成功路径）。
  // 输入：previousScope（旧代际）、resolved（新代际）、transaction（canCommit/rollbackOnFailure）。
  // 语义：先把 newKey -> 旧 scope 记入 pendingReplacement，再强制刷新；刷新提交时才真正
  //   forgetRegisteredSource(旧 scope) 并清 pending，因此刷新失败时旧投影保持不动。
  // 失败语义：新 source 未 online 直接抛错；canCommit=false 视为事务失效；rollbackOnFailure 时
  //   丢弃新 scope 的 pending/订阅/投影，回到旧状态（对应 Registry 回滚 provisional session）。
  // [契约] 先把 newKey 到旧 scope 的映射写入 pending，再强制刷新。
  // [契约] 刷新提交时才 forget 旧 scope 并清 pending，失败时旧投影保持不动。
  // [失败路径] 新 source 未 online 直接抛错；canCommit 为 false 视为事务失效。
  // [契约] rollbackOnFailure 时丢弃新 scope 的 pending、订阅与投影，回到旧状态。
  // [并发] 连续重连失败时必须压缩 replacement 链，避免遗留孤儿投影。
  async function replaceDisconnectedSource(
    previousScope: WindowHostControllerSourceScope,
    resolved: ResolvedWindowHostControllerSource,
    transaction?: {
      canCommit?: () => boolean;
      rollbackOnFailure?: boolean;
    },
  ): Promise<void> {
    if (!resolved.taskService || resolved.sourceAvailability !== "online") {
      throw new Error("重连 source 尚未 online，不能替换离线投影");
    }
    registerResolvedSource(resolved);
    const previousKey = sourceKey(previousScope);
    const retainedPreviousScope =
      pendingReplacementByNextSourceKey.get(previousKey) ?? previousScope;
    if (sourceKey(retainedPreviousScope) !== previousKey) {
      // 连续重连都在首个 snapshot 前失败时，可信 rows 仍属于更早的一代 source。
      // 摘掉中间空 source，把 replacement 链压缩到最后可信 scope，避免成功后遗留孤儿投影。
      pendingReplacementByNextSourceKey.delete(previousKey);
      forgetRegisteredSource(previousScope);
      projection.removeSource(previousScope);
    }
    // [契约] 映射方向是新 source key 到仍可信的旧 scope，不要写反。
    // [失败路径] 覆盖已有值前必须先处理旧链，否则中间代际会被永久悬挂。
    // [并发] 该 Map 只在成功提交或回滚时删除，不能提前清空。
    pendingReplacementByNextSourceKey.set(sourceKey(resolved.scope), retainedPreviousScope);
    try {
      await refreshSource(resolved, true, () => {
        if (transaction?.canCommit?.() === false) {
          throw new Error("Controller source replacement generation 已失效");
        }
      });
    } catch (error) {
      // [失败路径] 回滚必须同时清 pending、释放新 scope 的订阅并丢弃投影。
      // [契约] 只更新 Registry 的回滚不清理 Controller，会留下孤儿 owner。
      // [并发] 删除前重新确认 pending 仍指向本次替换，避免回滚别人的事务。
      // [权衡] 回滚不尝试恢复旧 scope 的 observer：旧 scope 仍然冻结且可读。
      if (transaction?.rollbackOnFailure) {
        const key = sourceKey(resolved.scope);
        if (pendingReplacementByNextSourceKey.has(key)) {
          // Bug 原因：Registry 已回滚 provisional logical session 时，Controller 曾继续保留
          // 新 generation 的 pending source/订阅，下一轮又从旧 session 重试，最终泄漏孤儿 owner。
          pendingReplacementByNextSourceKey.delete(key);
          forgetRegisteredSource(resolved.scope);
          projection.discardSource(resolved.scope);
        }
      }
      throw error;
    }
  }

  // 把多个 workspace scope 解析为唯一 source 列表（按 sourceKey 去重）：
  // 同一 Source 上的多个 workspace 别名只刷新一次，避免重复拉取与重复投影。
  // [契约] 按 sourceKey 去重：同一 source 的多个 workspace 别名只刷新一次。
  // [失败路径] 解析失败的 scope 直接跳过，不影响其它可读 source。
  // [权衡] 去重后丢失同一 source 多别名的信息，但投影键本来就以 source 为准。
  function resolveQuerySources(
    scopes: ZCodeTaskListWorkspaceScope[],
  ): ResolvedWindowHostControllerSource[] {
    const resolved = new Map<string, ResolvedWindowHostControllerSource>();
    for (const scope of scopes) {
      const source = options.resolveSource(scope);
      if (!source) {
        continue;
      }
      resolved.set(sourceKey(source.scope), source);
    }
    return Array.from(resolved.values());
  }

  // 列表查询：解析并刷新全部相关 source，再按 query 过滤/排序/分页。
  // 输出：{ items, total, hasMore }；total 是过滤后的总数，limit 只影响 items。
  // 失败语义：逐个 source 的刷新错误只记 onSourceError，不阻断其它 source 的结果——
  //   一个 remote 的瞬时失败不能清空 local 或其它 remote 的可信投影。
  // [契约] 输出 items、total、hasMore；total 是过滤后的总数，limit 只影响 items。
  // [失败路径] 单个 source 刷新失败只上报 onSourceError，不阻断其它 source。
  // [契约] 一个 remote 的瞬时失败不能清空 local 或其它 remote 的可信投影。
  // [并发] 所有 source 的刷新并行执行，避免串行放大延迟。
  async function listTaskList(
    query: ZCodeTaskListQuery,
  ): Promise<WindowHostControllerTaskListResult> {
    const resolvedSources = resolveQuerySources(query.workspaceScopes);
    await Promise.all(
      resolvedSources.map(async (source) => {
        try {
          await refreshSource(source);
        } catch (error) {
          // 一个 remote source 的瞬时读取失败不能清空 local 或其他 remote 的可信投影。
          options.onSourceError?.(source.scope, "refresh", error);
        }
      }),
    );

    const search = query.search?.trim();
    let items: WindowHostControllerTaskListItem[];
    // [契约] 搜索走各 source 的 listTaskList，再由本层合并与排序。
    // [失败路径] 单个 source 搜索失败返回空数组，并上报 search 操作类型。
    // [契约] 搜索结果要合并投影中的 meta、liveStatus 与 activity，不能用远端旧字段覆盖。
    // [并发] limit 在合并后统一应用，不能下推给单个 source，否则总数不准。
    if (search) {
      const results = await Promise.all(
        resolvedSources
          .filter((source) => source.sourceAvailability === "online" && source.taskService != null)
          .map(async (source) => {
            try {
              const result = await source.taskService!.listTaskList({
                ...query,
                workspaceScopes: [
                  {
                    workspacePath: source.scope.workspacePath,
                    ...(source.scope.workspaceIdentity
                      ? { workspaceIdentity: source.scope.workspaceIdentity }
                      : {}),
                  },
                ],
                limit: undefined,
              });
              return result.items.map((item) => {
                const normalized = normalizeTaskMeta(item, source.scope);
                const projected = projection
                  .getTasks()
                  .find(
                    (row) =>
                      row.address.taskId === normalized.taskId &&
                      row.address.workspacePath === normalized.workspacePath &&
                      row.address.workspaceIdentity === normalized.workspaceIdentity &&
                      row.address.remoteSessionId ===
                        (source.scope.kind === "remote" ? source.scope.remoteSessionId : undefined),
                  );
                return {
                  ...(projected?.meta ?? normalized),
                  ...(source.scope.kind === "remote"
                    ? {
                        ...(source.scope.sourceServerId
                          ? { sourceServerId: source.scope.sourceServerId }
                          : {}),
                        ...(source.scope.serverDisplayName
                          ? { serverDisplayName: source.scope.serverDisplayName }
                          : {}),
                        remoteSessionId: source.scope.remoteSessionId,
                      }
                    : {}),
                  sourceAvailability: "online" as const,
                  liveStatus: projected?.liveStatus ?? liveStatusFromMeta(normalized),
                  ...(projected?.activity ? { activity: projected.activity } : {}),
                  ...(item.searchSnippets ? { searchSnippets: item.searchSnippets } : {}),
                };
              });
            } catch (error) {
              options.onSourceError?.(source.scope, "search", error);
              return [];
            }
          }),
      );
      items = results.flat();
    } else {
      // [契约] 非搜索路径直接从共享投影过滤，只保留本次查询涉及的 source。
      // [契约] pending 中保留的上一代 scope 也要加入，保证替换失败时仍展示可信旧行。
      // [失败路径] 漏加旧 scope 会让重连中的列表出现短暂空白。
      const selectedSources = new Set<string>();
      for (const source of resolvedSources) {
        const key = sourceKey(source.scope);
        selectedSources.add(key);
        const pendingPreviousScope = pendingReplacementByNextSourceKey.get(key);
        if (pendingPreviousScope) {
          // 新 source 的首个 snapshot 失败时继续展示上一代离线可信投影；只有成功的
          // replaceSourceSnapshot 才会在一个 delta frame 中移除旧 rows 并加入新 rows。
          selectedSources.add(sourceKey(pendingPreviousScope));
        }
      }
      items = projection
        .getTasks()
        .filter((row) => {
          const scope: WindowHostControllerSourceScope =
            row.address.sourceServerId || row.address.remoteSessionId
              ? {
                  kind: "remote",
                  ...(row.address.sourceServerId
                    ? { sourceServerId: row.address.sourceServerId }
                    : {}),
                  remoteSessionId: row.address.remoteSessionId,
                  workspacePath: row.address.workspacePath,
                  workspaceIdentity: row.address.workspaceIdentity!,
                }
              : {
                  kind: "local",
                  workspacePath: row.address.workspacePath,
                  ...(row.address.workspaceIdentity
                    ? { workspaceIdentity: row.address.workspaceIdentity }
                    : {}),
                };
          return (
            selectedSources.has(sourceKey(scope)) &&
            matchesTaskListMembershipKind(row.membership, query.kind)
          );
        })
        .map((row) => {
          const resolvedSource = resolvedSources.find((source) => {
            const addressKey = row.address.workspaceIdentity?.trim() || row.address.workspacePath;
            const scopeKeyValue =
              source.scope.workspaceIdentity?.trim() || source.scope.workspacePath;
            return (
              addressKey === scopeKeyValue &&
              (source.scope.kind !== "remote" ||
                (row.address.sourceServerId
                  ? source.scope.sourceServerId === row.address.sourceServerId
                  : source.scope.remoteSessionId === row.address.remoteSessionId))
            );
          });
          return {
            ...row.meta,
            ...(row.address.sourceServerId ? { sourceServerId: row.address.sourceServerId } : {}),
            ...(resolvedSource?.scope.kind === "remote" && resolvedSource.scope.serverDisplayName
              ? { serverDisplayName: resolvedSource.scope.serverDisplayName }
              : {}),
            ...(row.address.remoteSessionId
              ? { remoteSessionId: row.address.remoteSessionId }
              : {}),
            sourceAvailability: row.sourceAvailability,
            liveStatus: row.liveStatus,
            ...(row.activity ? { activity: row.activity } : {}),
            ...(row.searchSnippets ? { searchSnippets: row.searchSnippets } : {}),
          };
        });
    }
    items.sort((left, right) => compareItems(left, right, query.sortBy));
    const total = items.length;
    const visible = query.limit == null ? items : items.slice(0, query.limit);
    return { items: visible, total, hasMore: total > visible.length };
  }

  // 创建一个 attachment 级服务实例（#18 dispose 语义对象）。
  // ownsUnreadSignals=false 时只复用共享未读事件而不持有转发订阅（用于子附件）。
  // dispose：置 attachmentDisposed 阻止迟到写回，释放订阅/emitter，清空 subscription 表；
  //   不触碰共享 projection，因此一个附件关闭不影响其它窗口/附件的投影。
  // 不变量：所有写方法在 IO 前后都用 assertCurrentSource 复查同一 taskService 与 scope。
  // [契约] 每个 attachment 拥有独立 emitter 与订阅表，共享同一份 projection。
  // [契约] ownsUnreadSignals 为 false 时只复用未读事件，不持有转发订阅（用于子附件）。
  // [资源] dispose 只释放本附件的订阅与 emitter，不触碰共享投影。
  // [失败路径] dispose 后再写入会被 attachmentDisposed 拒绝，防止迟到写回。
  function createAttachmentService(
    ownsUnreadSignals = true,
  ): IWindowControllerService & { dispose(): void } {
    const frameEmitter = new Emitter<WindowHostControllerFrame>();
    const unreadEmitter = new Emitter<WindowHostTaskUnreadSignal>();
    const unreadSubscription = ownsUnreadSignals
      ? unreadSignals.event((signal) => unreadEmitter.fire(signal))
      : undefined;
    const subscriptions = new Map<string, { dispose(): void }>();
    let attachmentDisposed = false;
    return {
      listTaskList,
      // [契约] 地址先经 schema 解析，再按 address 的 workspace 维度解析 source。
      // [失败路径] 列表读取失败可以保留旧投影，但不能把它当成已知任务标记。
      // [契约] 这里直接读唯一持久 owner，不物化整表。
      // [并发] IO 前后各校验一次 source 与 attachment，见 assertCurrentSource。
      async getTaskMeta(params) {
        const address = windowHostTaskAddressSchema.parse(params.address);
        const resolved = options.resolveSource({
          workspacePath: address.workspacePath,
          ...(address.workspaceIdentity ? { workspaceIdentity: address.workspaceIdentity } : {}),
        });
        const taskService = resolved?.taskService;
        const assertCurrentSource = (current: ResolvedWindowHostControllerSource | null) => {
          if (
            attachmentDisposed ||
            !resolved ||
            !taskService ||
            !current ||
            current.sourceAvailability !== "online" ||
            current.taskService !== taskService ||
            current.scope.workspacePath !== address.workspacePath ||
            current.scope.workspaceIdentity !== address.workspaceIdentity ||
            sourceKey(current.scope) !== sourceKey(resolved.scope) ||
            (current.scope.kind === "remote" &&
              resolved.scope.kind === "remote" &&
              current.scope.remoteSessionId !== resolved.scope.remoteSessionId)
          )
            throw new Error("任务读取期间 source 已失效");
          const mismatched =
            current.scope.kind === "remote"
              ? (address.sourceServerId
                  ? address.sourceServerId !== current.scope.sourceServerId
                  : address.remoteSessionId !== current.scope.remoteSessionId) ||
                (address.remoteSessionId != null &&
                  address.remoteSessionId !== current.scope.remoteSessionId)
              : address.remoteSessionId != null || address.sourceServerId != null;
          if (mismatched) throw new Error("任务地址与 source 不匹配");
        };
        // [契约] 必须同时比对 attachment 状态、taskService 实例、workspace 与 sourceKey。
        // [失败路径] 只比 taskId 或路径会让重连后的同名任务被误认。
        // [契约] remote 还要比对 remoteSessionId，身份不同即视为 source 已失效。
        assertCurrentSource(resolved);
        // Bug 根因：列表读取失败可保留旧投影；把它当已读 marker 会漏清或误清。
        // 直接读唯一持久 owner，IO 前后复查同一服务与 attachment，不吞错、不物化整表。
        const result = await taskService!.getTaskMeta(mutationParams(address));
        assertCurrentSource(resolveCurrentSource(resolved!.scope));
        if (result && result.taskId !== address.taskId) throw new Error("任务读取返回地址不匹配");
        return result ? normalizeTaskMeta(result, resolved!.scope) : null;
      },
      // [契约] 空批次直接返回空结果，不触发任何 RPC 或刷新。
      // [失败路径] 返回结构必须带逐项目标结果，否则视为协议违约。
      // [契约] 刷新只在整批结束后执行一次，与 source 事件共享 single-flight。
      async deleteArchivedTasks({ address, taskIds }) {
        if (taskIds.length === 0) {
          return { deletedTaskIds: [], skippedTaskIds: [], failedTaskIds: [] };
        }
        const result = await projection.mutate(address, { kind: "delete-archived-batch", taskIds });
        if (!result || typeof result === "boolean" || !("deletedTaskIds" in result)) {
          throw new Error("归档删除批次未返回逐项目标结果");
        }
        const resolved = options.resolveSource({
          workspacePath: address.workspacePath,
          workspaceIdentity: address.workspaceIdentity,
        });
        if (resolved) {
          // 只在整批结束后收敛投影，与 source 的一次事件共享 single-flight；刷新失败不改写已提交结果。
          await refreshSource(resolved, true).catch((error) =>
            options.onSourceError?.(resolved.scope, "refresh", error),
          );
        }
        return result;
      },
      // [契约] 删除结果以严格 true 判定成功，避免把 undefined 当成功。
      // [失败路径] 删除已持久成功，列表刷新失败不能改报删除失败。
      // [契约] 刷新失败交由 onSourceError，后续事件仍会收敛投影。
      async deleteArchivedTask({ address }) {
        const deleted = await projection.mutate(address, { kind: "delete-archived" });
        const resolved = options.resolveSource({
          workspacePath: address.workspacePath,
          workspaceIdentity: address.workspaceIdentity,
        });
        if (resolved) {
          // 删除已经持久成功，列表重查失败不能改报删除失败；后续事件仍会刷新投影。
          await refreshSource(resolved, true).catch((error) =>
            options.onSourceError?.(resolved.scope, "refresh", error),
          );
        }
        return deleted === true;
      },
      // [契约] 写前先解析 source 并要求在线，再用唯一 owner 校验行存在。
      // [失败路径] 项目树可能包含未打开的 tab，不能依赖 UI 先查另一份列表。
      // [契约] 未读写入使用 CAS marker，不能让重查投影替换回包。
      // [并发] 写后刷新失败只上报，不把成功写操作伪装成可重试失败。
      async mutateTask({ address, mutation }) {
        const resolved = options.resolveSource({
          workspacePath: address.workspacePath,
          ...(address.workspaceIdentity ? { workspaceIdentity: address.workspaceIdentity } : {}),
        });
        // 项目树也包含未打开 tab 的任务；先从唯一 owner 读取行验证，不能依赖 UI 先查另一份列表。
        if (!resolved || resolved.sourceAvailability !== "online")
          throw new Error(
            resolved?.scope.kind === "remote"
              ? "远程 source 当前离线，禁止列表写操作"
              : "任务 source 当前不可用",
          );
        const taskService = resolved.taskService;
        const assertCurrentUnreadSource = () => {
          const current = resolveCurrentSource(resolved.scope);
          if (
            current?.taskService !== taskService ||
            current?.sourceAvailability !== "online" ||
            sourceAvailability.get(sourceKey(resolved.scope)) !== "online"
          ) {
            throw new Error("未读写入期间 source 已失效");
          }
        };
        await refreshSource(resolved);
        // 首次读取也会等待 IO；后置检查只能拒绝回包，挡不住 mutation 重解析后误写新 source。
        // [契约] 缓存命中不代表在途读取已结束，必须等旧快照收口。
        // [失败路径] 旧读取失败不否定已知任务的完成事实，真正缺行时才重新刷新。
        // [并发] 两次 assertCurrentUnreadSource 分别覆盖等待前与等待后。
        // [契约] 缺行时强制刷新成功后才允许写入，否则拒绝这次未读变更。
        if (mutation.kind === "mark-read" || mutation.kind === "mark-unread") {
          // 缓存命中不代表在途读取已结束；先等旧快照收口，缺行时再读，避免新任务被旧快照拒绝。
          // 旧读取失败不否定已知任务的完成事实，真正缺行的刷新仍须成功后才能写入。
          await sourceRefreshFlights.get(sourceKey(resolved.scope))?.promise.catch(() => {});
          assertCurrentUnreadSource();
          const known = projection
            .getTasks()
            .some(
              (row) =>
                row.address.taskId === address.taskId &&
                row.address.workspacePath === address.workspacePath &&
                row.address.workspaceIdentity === address.workspaceIdentity &&
                (address.sourceServerId
                  ? row.address.sourceServerId === address.sourceServerId
                  : row.address.remoteSessionId === address.remoteSessionId),
            );
          if (!known) {
            await refreshSource(resolved, true);
            assertCurrentUnreadSource();
          }
        }
        const mutationResult = await projection.mutate(
          address,
          mutation as WindowHostControllerMutation,
        );
        // 未读 CAS 必须使用本次写入分配的 marker；重查投影可能已包含后一次完成，不能替换回包。
        // [契约] 只有带 taskId 的 CAS 结果才进入这条分支，布尔结果走普通刷新。
        // [失败路径] 重查投影可能已包含后一次完成，不能替换回包中的 marker。
        // [并发] 写后与刷新后各校验一次 source，防止期间换 owner。
        // [契约] 返回 mutationResult 而不是重新构造，保证调用方拿到原始地址。
        if (mutationResult && typeof mutationResult !== "boolean" && "taskId" in mutationResult) {
          assertCurrentUnreadSource();
          // 写入已提交；读取失败只影响投影刷新，不把成功的写操作伪装成可重试失败。
          await refreshSource(resolved, true).catch((error) =>
            options.onSourceError?.(resolved.scope, "refresh", error),
          );
          assertCurrentUnreadSource();
          return mutationResult;
        }
        await refreshSource(resolved, true);
        return (
          projection
            .getTasks()
            .find(
              (row) =>
                row.address.taskId === address.taskId &&
                row.address.workspacePath === address.workspacePath &&
                row.address.workspaceIdentity === address.workspaceIdentity &&
                (address.sourceServerId
                  ? row.address.sourceServerId === address.sourceServerId
                  : row.address.remoteSessionId === address.remoteSessionId),
            )?.meta ?? null
        );
      },
      // [契约] 订阅归属本 attachment，dispose 时统一释放。
      // [失败路径] 不在这里校验 topic：投影层负责拒绝未知 topic 并给出 ack。
      // [资源] subscriptionId 由 projection 生成，本层只做登记。
      async subscribeControllerV4(params: ControllerSubscribeParams) {
        const subscription = projection.subscribe({
          topic: params.topic,
          onFrame: (frame) => frameEmitter.fire(frame),
        });
        subscriptions.set(subscription.subscriptionId, subscription);
        return { ack: subscription.ack };
      },
      async resyncControllerV4(params) {
        return { ack: projection.resync(params.subscriptionId) };
      },
      async unsubscribeControllerV4(params) {
        subscriptions.get(params.subscriptionId)?.dispose();
        subscriptions.delete(params.subscriptionId);
      },
      onDynamicControllerFrame() {
        return frameEmitter.event;
      },
      onDynamicTaskUnreadSignal() {
        return ownsUnreadSignals ? unreadEmitter.event : Event.None;
      },
      // [资源] 先置 attachmentDisposed，再释放订阅与 emitter，顺序决定迟到写入是否被拦住。
      // [契约] 不触碰共享 projection：一个附件关闭不影响其它窗口。
      // [失败路径] dispose 幂等，重复调用不会抛错。
      dispose() {
        attachmentDisposed = true;
        unreadSubscription?.dispose();
        unreadEmitter.dispose();
        for (const subscription of subscriptions.values()) {
          subscription.dispose();
        }
        subscriptions.clear();
        frameEmitter.dispose();
      },
    };
  }

  // [契约] 共享 service 与 attachment 工厂必须来自同一 runtime 闭包，保证投影一致。
  // [资源] 共享 service 由 runtime 的 dispose 统一释放。
  const service = createAttachmentService();
  return {
    service,
    createAttachmentService,
    replaceDisconnectedSource,
    // 把「任务 + workspace」解析为唯一 WindowHostTaskAddress，供列表 mutation 使用。
    // 输入：可选 attachmentScope（remote 时必须与 workspace/lifecycle 完全一致）；
    //   allowMissingTask 用于条件删除，允许目标已被其它客户端删除（返回按 source 身份构造的地址）。
    // 输出：投影中唯一匹配的地址；匹配数为 0（且不允许缺失）或多于 1 都抛错（不做猜测）。
    // 副作用：会先 refreshSource 物化投影（否则新绑定 workspace 首次写入会因缺行失败）。
    // 不变量：全程 fail-closed，remote source 的身份（sourceServerId/remoteSessionId）必须逐项一致。
    // [契约] 全程 fail-closed：remote 身份必须逐项一致，匹配数必须恰好为一。
    // [契约] 先 refreshSource 物化投影，否则新绑定 workspace 的首次写入会因缺行失败。
    // [失败路径] 匹配 0 且不允许缺失、或匹配多于 1，都抛错而不是猜测。
    // [契约] allowMissingTask 只用于条件删除，仍要求 source 身份完整验证。
    // [并发] 刷新前后各校验一次 attachment source，避免刷新期间被替换。
    async resolveTaskAddress(params: {
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      attachmentScope?: import("@zcode/shared").WindowHostAttachmentScope;
      allowMissingTask?: boolean;
    }): Promise<WindowHostTaskAddress> {
      const remoteAttachmentScope =
        params.attachmentScope?.kind === "remote" ? params.attachmentScope : undefined;
      if (remoteAttachmentScope) {
        if (
          remoteAttachmentScope.workspacePath !== params.workspacePath ||
          remoteAttachmentScope.workspaceIdentity !== params.workspaceIdentity
        ) {
          throw new Error("列表 mutation 与 remote attachment scope 不匹配");
        }
      }
      const resolved = options.resolveSource({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      });
      const assertAttachmentSource = (source: ResolvedWindowHostControllerSource | null) => {
        if (
          remoteAttachmentScope &&
          (!source ||
            source.scope.kind !== "remote" ||
            source.scope.remoteSessionId !== remoteAttachmentScope.remoteSessionId ||
            source.scope.workspacePath !== remoteAttachmentScope.workspacePath ||
            source.scope.workspaceIdentity !== remoteAttachmentScope.workspaceIdentity)
        ) {
          throw new Error("列表 mutation 与 remote attachment source 不匹配");
        }
      };
      assertAttachmentSource(resolved);
      if (resolved) {
        // remote attachment 曾直接返回 address，跳过 source refresh；新绑定的
        // workspace 尚未读取 Controller 列表时没有投影行，导致 unread/archive 等首次写入失败。
        // 这里只物化已按完整 remoteSessionId + identity 验证的 source，继续保持 fail-closed。
        await refreshSource(resolved);
        assertAttachmentSource(resolveCurrentSource(resolved.scope));
      }
      // 侧栏可先按稳定 Source 查询，之后才创建 attachment；投影行没有新 sessionId
      // 不代表任务缺失。先验证当前 attachment，再按同一 Source 匹配，旧地址路径仍精确匹配。
      const sourceServerId =
        resolved?.scope.kind === "remote" ? resolved.scope.sourceServerId : undefined;
      const matches = projection
        .getTasks()
        .filter(
          (row) =>
            row.address.taskId === params.taskId &&
            row.address.workspacePath === params.workspacePath &&
            row.address.workspaceIdentity === params.workspaceIdentity &&
            (!remoteAttachmentScope ||
              (sourceServerId
                ? row.address.sourceServerId === sourceServerId
                : row.address.remoteSessionId === remoteAttachmentScope.remoteSessionId)),
        );
      if (matches.length !== 1) {
        if (matches.length === 0 && params.allowMissingTask && resolved) {
          // 条件删除允许已被其它客户端删除的目标到 Repo 幂等跳过；source 身份仍须完整验证。
          return {
            taskId: params.taskId,
            workspacePath: resolved.scope.workspacePath,
            ...(resolved.scope.workspaceIdentity
              ? { workspaceIdentity: resolved.scope.workspaceIdentity }
              : {}),
            ...(resolved.scope.kind === "remote"
              ? { remoteSessionId: resolved.scope.remoteSessionId }
              : {}),
          };
        }
        throw new Error(
          `列表 mutation 无法解析唯一 source，taskId=${params.taskId}, matches=${matches.length}`,
        );
      }
      return matches[0]!.address;
    },
    // 断线：保留最后一次可信投影（断连不等于删除），清 observer、让在途刷新失效并 +1 代际。
    // 幂等：未注册或已 offline 的 source 直接返回。
    // source 转 offline 只影响可连接性，projection 与 membership 必须原样保留。
    // [并发] 代际加一与删除 in-flight 让在途刷新结果失效。
    // [资源] observer 必须 dispose 并清空，重连时重建。
    // [失败路径] 未注册或已 offline 直接返回，保证幂等。
    disconnectSource(scope: WindowHostControllerSourceScope): void {
      const key = sourceKey(scope);
      if (!registeredScopes.has(key) || sourceAvailability.get(key) === "offline") {
        return;
      }
      sourceAvailability.set(key, "offline");
      sourceRefreshGenerations.set(key, (sourceRefreshGenerations.get(key) ?? 0) + 1);
      sourceRefreshFlights.delete(key);
      sourceSessionObservers.get(key)?.observer.dispose();
      sourceSessionObservers.delete(key);
      sourceSnapshotTaskServices.delete(key);
      projection.disconnectSource(scope);
    },
    // 删除 source 的全部投影与登记：连同 pendingReplacement 链一起清理，
    // 避免关闭当前 scope 后仍遗留上一代 history scope 的孤儿投影。
    // 幂等：未注册直接返回。
    // [契约] 删除 source 的全部投影与登记，包括 pendingReplacement 链。
    // [并发] 先取出保留的上一代 scope，再 forget 当前 scope。
    // [失败路径] 必须双向清理：既删以本 key 为 next 的项，也删以本 key 为 previous 的项。
    // [契约] 若保留了上一代 history scope，必须连同其投影一起清理。
    // [失败路径] 漏清会留下无法再被任何 attachment 访问的孤儿投影。
    removeSource(scope: WindowHostControllerSourceScope): void {
      const key = sourceKey(scope);
      if (!registeredScopes.has(key)) {
        return;
      }
      const retainedPreviousScope = pendingReplacementByNextSourceKey.get(key);
      forgetRegisteredSource(scope);
      pendingReplacementByNextSourceKey.delete(key);
      for (const [nextKey, previousScope] of pendingReplacementByNextSourceKey) {
        if (sourceKey(previousScope) === key) {
          pendingReplacementByNextSourceKey.delete(nextKey);
        }
      }
      projection.removeSource(scope);
      if (retainedPreviousScope && sourceKey(retainedPreviousScope) !== key) {
        // 当前 logical session 在成功 resync 前仍借用上一代离线 rows；关闭当前 scope
        // 等同关闭这份 history scope，必须连同保留投影一起清理。
        forgetRegisteredSource(retainedPreviousScope);
        projection.removeSource(retainedPreviousScope);
      }
    },
    // 运行时释放：先释放共享 service，再释放未读 emitter，移除全部 source 投影后清空登记表。
    // 调用后本 runtime 不可复用；dispose 幂等（Emitter/Map.clear 均幂等）。
    dispose(): void {
      service.dispose();
      unreadSignals.dispose();
      for (const scope of registeredScopes.values()) {
        projection.removeSource(scope);
      }
      for (const subscription of sourceEventSubscriptions.values()) {
        subscription.dispose();
      }
      registeredScopes.clear();
      sourceAvailability.clear();
      sourceTaskServices.clear();
      sourceSnapshotTaskServices.clear();
      sourceEventSubscriptions.clear();
      sourceRefreshFlights.clear();
      sourceRefreshGenerations.clear();
      for (const entry of sourceSessionObservers.values()) entry.observer.dispose();
      sourceSessionObservers.clear();
      sourceLiveOverlays.clear();
      pendingReplacementByNextSourceKey.clear();
    },
  };
}
