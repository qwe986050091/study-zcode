/* eslint-disable max-lines -- 投影状态、V4 帧与离线替换属于同一个一致性边界。 */
// Window Controller 投影：把各 source（窗口本地 workspace / 远端会话）的 task index 与会话
// overlay 合成统一的只读任务列表，并以「日志纪元 + 单调序号」的 V4 帧增量推给订阅者。
//
// 职责边界：
// - 只做投影与分发，不持有持久状态；写操作统一委托给各 source 的 mutate 回调；
// - 每个 topic（tasks-index / workspaces）独立维护 logEpoch 与 seq，订阅者按 (logEpoch, seq)
//   判定自己是否掉队，掉队时走 resync 拿全量快照；
// - 远端重连会更换 remoteSessionId，本文件用「同一次 delta 帧内完成旧 source 摘除 + 新 source
//   写入」的方式保证消费者看不到中间空投影。
//
// 大纲不变量 #18 相关（attachment/连接代际与投影连续性）：
// - remote scope 必须携带 workspaceIdentity，且必须能定位到 identity（sourceServerId 或
//   remoteSessionId），否则注册即失败，避免同一路径的本地/远端任务被当成同一份数据；
// - 离线 source 只降级为 sourceAvailability=offline 并发 upsert，不直接删除投影，保证手机
//   断线重放时仍能看到最后已知状态；
// - discardSource 与 removeSource 语义分离：provisional（尚未发布过快照）的撤销不得向订阅者
//   伪造 workspace.removed。

// 实现层契约补充（与上方模块说明共同构成完整口径）：
//
// 本文件是 window 级 Host 的投影唯一写入口：source 注册/替换/断开/移除、投影读取、
// 写操作路由、订阅与重订阅全部收敛在 createWindowHostControllerProjection 返回的对象上。
// 投影层不缓存帧，每次读取都从当前 source 状态现算，避免缓存与 seq 脱钩。
// 不负责：持久化 task index（由调用方整体交入）、runtime 进程生命周期、订阅者的重试与
// 背压策略，以及 workspace 身份格式构造（复用 shared 协议工具，不在此处手拼）。
// 全部可变状态都挂在闭包内的 sources / subscribers / topicStates 上，不导出也不落盘；
// 进程重启后投影从空开始，「恢复上次列表」必须由调用方重新灌入完整快照。
//
// INV-01 断言：remote scope 的 sourceKey 必须含 sourceServerId 或 remoteSessionId —— 守住它的位置：sourceKey() —— 改错故障：同路径不同连接代际被合并成一份投影，重连后任务列表互相覆盖。
// INV-02 断言：remote scope 的 workspaceIdentity 必须非空且能定位到身份 —— 守住它的位置：registerSource() 前置校验 —— 改错故障：本地与远端同路径任务被当成同一批数据，写操作落到错误 source。
// INV-03 断言：注册已存在的 source 只替换 mutate 句柄 —— 守住它的位置：registerSource() 的 existing 分支 —— 改错故障：短暂重连把界面列表清空一瞬间。
// INV-04 断言：旧 source 摘除与新 source 写入在同一批 delta 内发布 —— 守住它的位置：replaceSourceSnapshot() 的 replacedSource 分支 —— 改错故障：消费者看到中间空投影，手机端闪空白。
// INV-05 断言：只有非空 delta 才推进 seq —— 守住它的位置：两个 publish 函数的空数组早退 —— 改错故障：空帧吃掉序号，订阅者按区间判定掉队时出现无法解释的缺口。
// INV-06 断言：每次发布固定 fromSeq 取旧值、toSeq 取旧值加一 —— 守住它的位置：两个 publish 函数的取值顺序 —— 改错故障：区间不连续，订阅者误判漏帧并触发 resync 风暴。
// INV-07 断言：tasks 与 workspaces 两个 topic 的 seq 独立计数 —— 守住它的位置：topicStates 的两条记录 —— 改错故障：一个主题的发布推进另一个主题的序号，跨主题对账失败。
// INV-08 断言：快照帧恒为 fromSeq 等于 0 —— 守住它的位置：snapshotFrame() —— 改错故障：消费者把全量基线当增量合并，出现重复或错序行。
// INV-09 断言：订阅先登记 subscriber 再同步回放快照 —— 守住它的位置：subscribe() 的 set 与 onFrame 顺序 —— 改错故障：登记窗口内的发布被吞，订阅者永久少一批任务。
// INV-10 断言：disconnectSource 只降级 availability，不删 rows —— 守住它的位置：disconnectSource() —— 改错故障：断线重放时手机端看到空列表而不是最后已知状态。
// INV-11 断言：discardSource 不得发出任何帧 —— 守住它的位置：discardSource() —— 改错故障：provisional 撤销被当成真实移除，订阅者删掉仍在展示的离线 source。
// INV-12 断言：removeSource 遇到未注册 source 静默返回 —— 守住它的位置：removeSource() 的未命中分支 —— 改错故障：重复清理抛错打断上层拆除流程。
// INV-13 断言：delete-archived 两个变体不校验单任务存在 —— 守住它的位置：mutate() 的存在性短路 —— 改错故障：批量清理在任务已归档时恒失败。
// INV-14 断言：离线 source 一律拒绝写操作 —— 守住它的位置：mutate() 的 sourceAvailability 校验 —— 改错故障：写请求发往已断连接，被吞或重复提交。
// INV-15 断言：custom overlay 标题优先于持久 titleOverridden —— 守住它的位置：buildSourceRows() 的 shouldUseOverlayTitle —— 改错故障：用户自定义标题被旧持久标题回滚。
// INV-16 断言：overlay 缺失时 liveStatus 必须回落 —— 守住它的位置：buildSourceRows() 的 liveStatus 取值 —— 改错故障：上次进程残留的 running 被当作当前运行展示。
import { isDeepStrictEqual } from "node:util";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { ZCodeArchivedTaskDeletionResult } from "@zcode/services";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  CONTROLLER_WORKSPACES_TOPIC,
  type ControllerSubscribeResult,
  type WindowHostControllerTaskDelta,
  type WindowHostControllerTaskFrame,
  type WindowHostControllerTaskRow,
  type WindowHostControllerTopic,
  type WindowHostControllerWorkspaceDelta,
  type WindowHostControllerWorkspaceFact,
  type WindowHostControllerWorkspaceFrame,
  type WindowHostTaskAddress,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * source 的身份描述：决定投影按哪个 key 归档，以及写操作路由到哪个 source。
 * - local：只按 workspaceIdentity||workspacePath 区分；
 * - remote：额外可用 sourceServerId / remoteSessionId 区分不同连接代际；workspaceIdentity
 *   为必填，保证跨连接的同一路径不会被误合并。
 */
export type WindowHostControllerSourceScope =
  | {
      kind: "local";
      workspacePath: string;
      workspaceIdentity?: string;
    }
  | {
      kind: "remote";
      sourceServerId?: string;
      serverDisplayName?: string;
      remoteSessionId?: string;
      workspacePath: string;
      workspaceIdentity: string;
    };

/** task index 的一条成员记录：meta 来自持久层，membership 描述 pin/archive/active 归属。 */
export interface WindowHostControllerTaskMembership {
  meta: ZCodeTaskMeta;
  membership: {
    pinned: boolean;
    archived: boolean;
    active: boolean;
  };
  searchSnippets?: string[];
}

/**
 * 会话实时 overlay：来自当前 runtime 的易变事实（liveStatus、标题、交互等待、活动）。
 * 它只覆盖展示口径，不写回持久 meta；overlay 缺失时一律回落到 idle，避免把上次进程残留的
 * running 当作当前事实。
 */
export interface WindowHostControllerSessionOverlay {
  taskId: string;
  liveStatus: WindowHostControllerTaskRow["liveStatus"];
  title?: string;
  titleSource?: "default" | "generated" | "custom";
  updatedAt?: number;
  pendingInteraction?: ZCodeTaskMeta["pendingInteraction"];
  activity?: NonNullable<WindowHostControllerTaskRow["activity"]>;
}

/** 允许通过 Controller 触发的列表写操作；具体执行为 source.mutate，投影层只做校验与路由。 */
export type WindowHostControllerMutation =
  | { kind: "rename"; title: string }
  | { kind: "pin"; pinned: boolean }
  | { kind: "archive"; archived: boolean }
  | { kind: "delete" }
  | { kind: "delete-archived" }
  | { kind: "delete-archived-batch"; taskIds: string[] }
  | { kind: "mark-read"; expectedUnreadAt?: number }
  | { kind: "mark-unread" }
  | { kind: "open" }
  | { kind: "resume" };

/** mutate 的返回值原样透传：重命名/删除等返回具体结果，其余操作可为 void。 */
export type WindowHostControllerMutationResult =
  | void
  | boolean
  | ZCodeArchivedTaskDeletionResult
  | ZCodeTaskMeta;

interface ControllerSource {
  scope: WindowHostControllerSourceScope;
  sourceAvailability: "online" | "offline";
  connectionState: WindowHostControllerWorkspaceFact["connectionState"];
  memberships: Map<string, WindowHostControllerTaskMembership>;
  overlays: Map<string, WindowHostControllerSessionOverlay>;
  rows: Map<string, WindowHostControllerTaskRow>;
  mutate: (
    address: WindowHostTaskAddress,
    mutation: WindowHostControllerMutation,
  ) => Promise<WindowHostControllerMutationResult> | WindowHostControllerMutationResult;
}

interface ControllerSubscriber {
  topic: WindowHostControllerTopic;
  subscriptionId: string;
  onFrame: (frame: WindowHostControllerTaskFrame | WindowHostControllerWorkspaceFrame) => void;
}

interface TopicState {
  logEpoch: string;
  seq: number;
}

// [契约] scope 的身份键：workspaceIdentity 优先、workspacePath 兜底，与仓库全局口径一致。
// remote 还需拼上 sourceServerId（或退化为 remoteSessionId）才能区分同一 workspace 的
// 不同连接代际；少拼这一段会让重连后的新旧 source 落到同一个 Map 槽位。
// 改动前先确认调用方是否依赖「注册即覆盖」，否则重连会静默复用旧 source 的 rows。
function sourceKey(scope: WindowHostControllerSourceScope): string {
  const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
  return scope.kind === "remote"
    ? `remote\0${scope.sourceServerId ?? scope.remoteSessionId}\0${workspaceKey}`
    : `local\0${workspaceKey}`;
}

// [契约] 地址是写操作与行身份的共同载体：remote 分支必须带上连接代际字段，
// 且只在字段存在时展开，避免把 undefined 显式写进协议对象被对端当作非法值。
// 本地分支不携带 remoteSessionId，mutate() 依赖这一点区分本地与远端寻址。
// workspaceIdentity 同样按需展开，缺省时下游统一回落到 workspacePath。
function addressFor(scope: WindowHostControllerSourceScope, taskId: string): WindowHostTaskAddress {
  return {
    ...(scope.kind === "remote"
      ? {
          ...(scope.sourceServerId ? { sourceServerId: scope.sourceServerId } : {}),
          remoteSessionId: scope.remoteSessionId,
        }
      : {}),
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    taskId,
  };
}

// [契约] task 的全局唯一键，必须与 sourceKey 使用同一套身份优先级：
// 先连接身份、再 workspace 身份、最后 taskId。三者顺序颠倒会让同一任务在
// 旧行与新行比对时对不上，表现为每轮同步都全量 upsert。
function taskKey(address: WindowHostTaskAddress): string {
  return `${address.sourceServerId ?? address.remoteSessionId ?? "local"}\0${address.workspaceIdentity?.trim() || address.workspacePath}\0${address.taskId}`;
}

// [失败路径] overlay 缺席就说明当前没有可证明的 runtime 在跑；
// 此时只能把 completed / error 这类终态透传，其余（含持久层里的 running、
// 等待交互）一律回落到 idle。把持久 running 当成当前事实，是线上
// 「任务显示一直在跑但进程早已退出」的直接来源。
function defaultLiveStatus(meta: ZCodeTaskMeta): WindowHostControllerTaskRow["liveStatus"] {
  // live overlay 缺失表示当前没有可证明的 runtime；SQLite 里的 running/interaction
  // 可能来自上次进程退出，不能重新解释成当前运行或等待事实。
  switch (meta.status) {
    case "completed":
      return "completed";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

// [契约] activity 相位到持久状态的映射：prewarming 与 running 都算 running，
// 两种 completed 变体都算 completed，draft 显式返回 undefined 表示不覆盖持久状态。
// 不要把 draft 映射成 idle——draft 是尚未落库的草稿，覆盖会让列表状态在编辑中途跳变。
// 若新增相位，必须在这里显式列出，否则 switch 落空返回 undefined 会静默保留旧值。
function statusFromActivity(
  activity: NonNullable<WindowHostControllerSessionOverlay["activity"]>,
): ZCodeTaskMeta["status"] {
  switch (activity.phase) {
    case "prewarming":
    case "running":
      return "running";
    case "completedSuccess":
    case "completedInterrupted":
      return "completed";
    case "error":
      return "error";
    case "draft":
      return undefined;
  }
}

// [契约] 行的唯一构造点：持久 membership 打底，overlay 只覆盖展示字段。
// 标题优先级刻意做成三段：无 titleOverridden 时用 overlay 标题、titleSource 为
// custom 时强制覆盖并同步 titleOverridden、其余情况保留持久标题。
// activity 存在时由 statusFromActivity 反推 meta.status，保证列表状态与实时相位同源；
// 不要在这里顺手写回持久层，投影层到持久层的写入路径必须保持单向。
function buildSourceRows(source: ControllerSource): Map<string, WindowHostControllerTaskRow> {
  const rows = new Map<string, WindowHostControllerTaskRow>();
  for (const membership of source.memberships.values()) {
    const overlay = source.overlays.get(membership.meta.taskId);
    const shouldUseOverlayTitle =
      overlay?.title != null &&
      (membership.meta.titleOverridden !== true || overlay.titleSource === "custom");
    const meta = overlay
      ? {
          ...membership.meta,
          ...(shouldUseOverlayTitle ? { title: overlay.title } : {}),
          ...(overlay.titleSource === "custom" ? { titleOverridden: true } : {}),
          ...(overlay.updatedAt != null ? { updatedAt: overlay.updatedAt } : {}),
          ...(overlay.activity ? { status: statusFromActivity(overlay.activity) } : {}),
          pendingInteraction: overlay.pendingInteraction,
        }
      : membership.meta;
    const address = addressFor(source.scope, meta.taskId);
    rows.set(taskKey(address), {
      address,
      meta,
      membership: membership.membership,
      sourceAvailability: source.sourceAvailability,
      liveStatus: overlay?.liveStatus ?? defaultLiveStatus(meta),
      ...(overlay?.activity ? { activity: overlay.activity } : {}),
      ...(membership.searchSnippets ? { searchSnippets: membership.searchSnippets } : {}),
    });
  }
  return rows;
}

// [失败路径] 这里是 task index 与 source scope 的交叉校验：路径或身份任一不一致
// 都视为调用方传错数据并直接抛错，不做「尽力归并」。放宽成告警会让脏 membership
// 混进投影，后续按 taskKey 查找时永远命中不到写操作的 source。
// 报错里保留 taskId，便于定位是哪一条索引记录越界。
function validateMembershipScope(
  scope: WindowHostControllerSourceScope,
  membership: WindowHostControllerTaskMembership,
): void {
  if (
    membership.meta.workspacePath !== scope.workspacePath ||
    membership.meta.workspaceIdentity !== scope.workspaceIdentity
  ) {
    throw new Error(
      `task-index membership 与 source scope 不匹配，taskId=${membership.meta.taskId}`,
    );
  }
}

// [契约] workspace 事实只由 scope 与连接状态派生，是 workspaces topic 的唯一数据源；
// remote 分支按需展开 sourceServerId / serverDisplayName / remoteSessionId，
// 本地分支保持字段缺席而不是填 undefined，避免下游按「字段是否存在」判分支时误判。
function workspaceFact(source: ControllerSource): WindowHostControllerWorkspaceFact {
  return {
    ...(source.scope.kind === "remote"
      ? {
          ...(source.scope.sourceServerId ? { sourceServerId: source.scope.sourceServerId } : {}),
          ...(source.scope.serverDisplayName
            ? { serverDisplayName: source.scope.serverDisplayName }
            : {}),
          remoteSessionId: source.scope.remoteSessionId,
        }
      : {}),
    workspacePath: source.scope.workspacePath,
    ...(source.scope.workspaceIdentity
      ? { workspaceIdentity: source.scope.workspaceIdentity }
      : {}),
    sourceAvailability: source.sourceAvailability,
    connectionState: source.connectionState,
  };
}

/**
 * 创建 Window Controller 投影实例。
 *
 * 输入：createId 用于生成 subscriptionId 与各 topic 的 logEpoch。
 * 输出：source 注册/替换/断开/移除、投影读取、写操作路由、订阅/重订阅能力。
 * 副作用：注册与替换都会立即向当前订阅者推送帧；subscribe 会同步回放一次 snapshot。
 * 失败语义：scope 不合法、source 未注册或当前不可用时抛错；写操作不会落到离线 source。
 * 维护的不变量：
 * - 每个 topic 的 seq 单调递增，且每次发布固定取 fromSeq=旧值、toSeq=旧值+1；
 * - 一次 replaceSourceSnapshot 只产生一轮 task delta 与一轮 workspace delta，顺序固定；
 * - 订阅回放的 fromSeq 固定为 0，表示「这是全量基线」，订阅者据 logEpoch 判断是否要丢弃旧基线。
 */
export function createWindowHostControllerProjection(options: { createId: () => string }) {
  // [并发] sources 是投影的唯一注册表，键为 sourceKey；所有读写都在同步调用栈内完成，
  // 没有锁也没有队列，因此禁止在遍历 sources 的过程中 await 或回调外部代码，
  // 否则注册或移除会把正在遍历的迭代器改坏，出现漏发或多发。
  const sources = new Map<string, ControllerSource>();
  const subscribers = new Map<string, ControllerSubscriber>();
  // [并发] 两个 topic 的 logEpoch 在实例化时一次性生成，之后不再变；
  // seq 从 0 起单调递增，绝不在运行期重置——重置会让订阅者手里的旧纪元序号
  // 与新一轮序号重叠，把新帧误判为重复帧丢弃。重连只换 source，不换纪元。
  const topicStates: Record<WindowHostControllerTopic, TopicState> = {
    [CONTROLLER_TASKS_INDEX_TOPIC]: { logEpoch: options.createId(), seq: 0 },
    [CONTROLLER_WORKSPACES_TOPIC]: { logEpoch: options.createId(), seq: 0 },
  };

  function allRows(): WindowHostControllerTaskRow[] {
    return Array.from(sources.values())
      .flatMap((source) => Array.from(source.rows.values()))
      .sort(
        (left, right) =>
          right.meta.updatedAt - left.meta.updatedAt ||
          taskKey(left.address).localeCompare(taskKey(right.address)),
      );
  }

  function allWorkspaceFacts(): WindowHostControllerWorkspaceFact[] {
    return Array.from(sources.values(), workspaceFact).sort((left, right) => {
      const leftKey = `${left.sourceServerId ?? left.remoteSessionId ?? "local"}\0${left.workspaceIdentity ?? left.workspacePath}`;
      const rightKey = `${right.sourceServerId ?? right.remoteSessionId ?? "local"}\0${right.workspaceIdentity ?? right.workspacePath}`;
      return leftKey.localeCompare(rightKey);
    });
  }

  // 订阅瞬间的全量帧：fromSeq=0 表示基线，toSeq=当前已发布的最大序号；logEpoch 随帧携带，
  // 消费者据此丢弃上一个纪元的残留帧。
  function snapshotFrame(
    subscriber: ControllerSubscriber,
  ): WindowHostControllerTaskFrame | WindowHostControllerWorkspaceFrame {
    const state = topicStates[subscriber.topic];
    const common = {
      subscriptionId: subscriber.subscriptionId,
      logEpoch: state.logEpoch,
      fromSeq: 0,
      toSeq: state.seq,
      sentAt: Date.now(),
    };
    if (subscriber.topic === CONTROLLER_TASKS_INDEX_TOPIC) {
      return {
        ...common,
        topic: CONTROLLER_TASKS_INDEX_TOPIC,
        payload: {
          kind: "snapshot",
          snapshot: {
            protocolVersion: 1,
            logEpoch: state.logEpoch,
            tasks: allRows(),
          },
        },
      };
    }
    return {
      ...common,
      topic: CONTROLLER_WORKSPACES_TOPIC,
      payload: {
        kind: "snapshot",
        snapshot: {
          protocolVersion: 1,
          logEpoch: state.logEpoch,
          workspaces: allWorkspaceFacts(),
        },
      },
    };
  }

  // 发布 task delta：每次发布先把 seq 自增，再以 fromSeq=旧值 / toSeq=新值 广播。
  // 序号只在有实际 delta 时推进，空 delta 直接返回，避免制造无意义的帧。
  function publishTaskDeltas(deltas: WindowHostControllerTaskDelta[]): void {
    // [权衡] 空 delta 直接返回，不推进 seq 也不广播：序号只在有真实变化时前进，
    // 这样订阅者可以用 toSeq 连续性与本地视图长度做交叉校验。
    // 若改成「每次都发空帧保活」，掉队判定会失效，且手机端会收到大量无内容帧。
    if (deltas.length === 0) {
      return;
    }
    const state = topicStates[CONTROLLER_TASKS_INDEX_TOPIC];
    const fromSeq = state.seq;
    // [事务] 先取旧值再自增，两个动作之间不能插入任何 await 或回调，
    // 否则同一批 delta 的 fromSeq 与 toSeq 可能被其他发布交错，产生区间重叠。
    // 帧内的 logEpoch 也必须现取当前 state，不能在循环外提前快照。
    state.seq += 1;
    for (const subscriber of subscribers.values()) {
      if (subscriber.topic !== CONTROLLER_TASKS_INDEX_TOPIC) {
        continue;
      }
      subscriber.onFrame({
        topic: CONTROLLER_TASKS_INDEX_TOPIC,
        subscriptionId: subscriber.subscriptionId,
        logEpoch: state.logEpoch,
        fromSeq,
        toSeq: state.seq,
        sentAt: Date.now(),
        payload: { kind: "deltas", deltas },
      });
    }
  }

  // workspace 主题与 task 主题共享同一个序号推进规则，但各自独立计数，互不影响。
  function publishWorkspaceDeltas(deltas: WindowHostControllerWorkspaceDelta[]): void {
    if (deltas.length === 0) {
      return;
    }
    const state = topicStates[CONTROLLER_WORKSPACES_TOPIC];
    const fromSeq = state.seq;
    state.seq += 1;
    for (const subscriber of subscribers.values()) {
      if (subscriber.topic !== CONTROLLER_WORKSPACES_TOPIC) {
        continue;
      }
      subscriber.onFrame({
        topic: CONTROLLER_WORKSPACES_TOPIC,
        subscriptionId: subscriber.subscriptionId,
        logEpoch: state.logEpoch,
        fromSeq,
        toSeq: state.seq,
        sentAt: Date.now(),
        payload: { kind: "deltas", deltas },
      });
    }
  }

  // [失败路径] 查不到 source 一律抛错而不是返回空投影：调用方拿到静默空结果
  // 会继续走后续发布流程，把「source 已移除」伪装成「source 没有任务」。
  // 错误信息带上 workspacePath，便于区分本地与远端同名路径。
  function requireSource(scope: WindowHostControllerSourceScope): ControllerSource {
    const source = sources.get(sourceKey(scope));
    if (!source) {
      throw new Error(
        `没有与 scope 匹配的 Controller source，workspacePath=${scope.workspacePath}`,
      );
    }
    return source;
  }

  return {
    // 注册 source：已存在则只替换 mutate 句柄，保留既有投影，避免重连时清空列表。
    // [契约] 注册是幂等入口：同一 key 第二次注册只换 mutate 句柄，投影与离线状态原样保留，
    // 这样 transport 重建时不会清空列表。新注册的 source 一律先落成 offline 加 connecting，
    // 必须等 replaceSourceSnapshot 之后才变 online，禁止在注册时乐观标记可用。
    // 两条 remote 身份校验在写入 sources 之前完成，避免半成品 source 残留在 Map 里。
    registerSource(params: {
      scope: WindowHostControllerSourceScope;
      mutate: ControllerSource["mutate"];
    }): void {
      if (params.scope.kind === "remote" && !params.scope.workspaceIdentity.trim()) {
        throw new Error("远程 Controller source 必须携带 workspaceIdentity");
      }
      if (
        params.scope.kind === "remote" &&
        !params.scope.sourceServerId &&
        !params.scope.remoteSessionId
      )
        throw new Error("远程 Controller source 必须携带 Source 身份或 attachment");
      const key = sourceKey(params.scope);
      const existing = sources.get(key);
      if (existing) {
        // [权衡] 只替换回调、不重放快照：重连期间订阅者继续看到旧 rows，
        // 直到新的 replaceSourceSnapshot 带来一轮 upsert。若这里顺手清空 memberships，
        // 列表会出现先空后满的闪烁，且 seq 会凭空多出一批 removed 帧。
        existing.mutate = params.mutate;
        return;
      }
      sources.set(key, {
        scope: params.scope,
        sourceAvailability: "offline",
        connectionState: "connecting",
        memberships: new Map(),
        overlays: new Map(),
        rows: new Map(),
        mutate: params.mutate,
      });
    },

    // 用一份完整 task index + sessions index 替换 source 投影；replacesScope 用于远端重连：
    // 旧 source 会被摘除，其 rows 的 removed 与新 source 的 upsert 合并进同一帧。
    // [事务] 整个替换过程是同步的：摘旧 source、写入新 memberships 与 overlays、重算 rows、
    // 生成 task 与 workspace 两轮 delta，全部在同一个调用栈内完成，中途不 await。
    // 顺序上必须先删旧的 Map 条目再写新的，否则同 key 覆盖时 removed 与 upsert 会自相矛盾。
    replaceSourceSnapshot(params: {
      scope: WindowHostControllerSourceScope;
      taskIndex: WindowHostControllerTaskMembership[];
      sessionsIndex: WindowHostControllerSessionOverlay[];
      replacesScope?: WindowHostControllerSourceScope;
    }): void {
      const source = requireSource(params.scope);
      const previousWorkspaceFact = workspaceFact(source);
      const currentSourceKey = sourceKey(params.scope);
      const replacementCandidate = params.replacesScope
        ? sources.get(sourceKey(params.replacesScope))
        : undefined;
      const replacedSource =
        replacementCandidate && sourceKey(replacementCandidate.scope) !== currentSourceKey
          ? replacementCandidate
          : undefined;
      if (replacedSource) {
        // 重连的 remoteSessionId 会变化；先在内存里摘掉旧 source，再用一个 task delta frame
        // 同时发布 old removals + new upserts，消费者不会看到中间空投影。
        sources.delete(sourceKey(replacedSource.scope));
      }
      const previousRows = source.rows;
      const nextMemberships = new Map<string, WindowHostControllerTaskMembership>();
      for (const membership of params.taskIndex) {
        validateMembershipScope(params.scope, membership);
        const address = addressFor(params.scope, membership.meta.taskId);
        nextMemberships.set(taskKey(address), membership);
      }
      source.memberships = nextMemberships;
      source.overlays = new Map(params.sessionsIndex.map((overlay) => [overlay.taskId, overlay]));
      source.sourceAvailability = "online";
      const nextRows = buildSourceRows(source);
      source.rows = nextRows;
      source.connectionState = "online";

      const deltas: WindowHostControllerTaskDelta[] = [];
      for (const previous of replacedSource?.rows.values() ?? []) {
        deltas.push({ op: "task.removed", address: previous.address });
      }
      for (const [key, previous] of previousRows) {
        if (!nextRows.has(key)) {
          deltas.push({ op: "task.removed", address: previous.address });
        }
      }
      for (const task of nextRows.values()) {
        const previous = previousRows.get(taskKey(task.address));
        if (!previous || !isDeepStrictEqual(previous, task)) {
          deltas.push({ op: "task.upserted", task });
        }
      }
      publishTaskDeltas(deltas);
      const nextWorkspaceFact = workspaceFact(source);
      // [事务] workspace 帧的顺序固定为「先 removed 后 upserted」，且只在事实发生变化
      // 或确有被替换 source 时才发。顺序颠倒会让订阅者先看到新连接再看到旧连接消失，
      // 前端按 workspace 列表去重时可能保留已被替换的会话。
      const workspaceDeltas: WindowHostControllerWorkspaceDelta[] = [
        ...(replacedSource
          ? [
              {
                op: "workspace.removed" as const,
                ...(replacedSource.scope.kind === "remote"
                  ? {
                      ...(replacedSource.scope.sourceServerId
                        ? { sourceServerId: replacedSource.scope.sourceServerId }
                        : {}),
                      remoteSessionId: replacedSource.scope.remoteSessionId,
                    }
                  : {}),
                workspacePath: replacedSource.scope.workspacePath,
                ...(replacedSource.scope.workspaceIdentity
                  ? { workspaceIdentity: replacedSource.scope.workspaceIdentity }
                  : {}),
              },
            ]
          : []),
        ...(!isDeepStrictEqual(previousWorkspaceFact, nextWorkspaceFact) || replacedSource
          ? [{ op: "workspace.upserted" as const, workspace: nextWorkspaceFact }]
          : []),
      ];
      publishWorkspaceDeltas(workspaceDeltas);
    },

    // 只替换会话 overlay（runtime 状态变化的高频路径），membership 不变，因此只发 task upsert。
    replaceSourceSessionOverlays(
      scope: WindowHostControllerSourceScope,
      sessionsIndex: WindowHostControllerSessionOverlay[],
    ): void {
      const source = requireSource(scope);
      const previousRows = source.rows;
      source.overlays = new Map(sessionsIndex.map((overlay) => [overlay.taskId, overlay]));
      source.rows = buildSourceRows(source);
      const deltas: WindowHostControllerTaskDelta[] = [];
      for (const task of source.rows.values()) {
        const previous = previousRows.get(taskKey(task.address));
        if (!previous || !isDeepStrictEqual(previous, task)) {
          deltas.push({ op: "task.upserted", task });
        }
      }
      publishTaskDeltas(deltas);
    },

    // 连接断开：不删投影，只把 source 标记为 offline 并发 upsert，供手机侧继续展示最后状态。
    // [资源] 断线只做降级：source 留在 sources 里、rows 整体改写 sourceAvailability，
    // 然后按行发 upsert，最后补一条 workspace upsert 更新 connectionState。
    // 不要在这里 delete source 或发 workspace.removed——重连后第二次替换会找不到
    // 上一代 rows，从而无法算出增量，只能退化成全量重建。
    disconnectSource(scope: WindowHostControllerSourceScope): void {
      const source = requireSource(scope);
      source.sourceAvailability = "offline";
      source.connectionState = "disconnected";
      const deltas: WindowHostControllerTaskDelta[] = [];
      for (const [key, row] of source.rows) {
        const offlineRow = { ...row, sourceAvailability: "offline" as const };
        source.rows.set(key, offlineRow);
        deltas.push({ op: "task.upserted", task: offlineRow });
      }
      publishTaskDeltas(deltas);
      publishWorkspaceDeltas([{ op: "workspace.upserted", workspace: workspaceFact(source) }]);
    },

    // 彻底移除 source：先发该 source 全部 task.removed，再发 workspace.removed；未注册时静默。
    removeSource(scope: WindowHostControllerSourceScope): void {
      const key = sourceKey(scope);
      const source = sources.get(key);
      if (!source) {
        return;
      }
      sources.delete(key);
      publishTaskDeltas(
        Array.from(source.rows.values(), (task) => ({
          op: "task.removed" as const,
          address: task.address,
        })),
      );
      publishWorkspaceDeltas([
        {
          op: "workspace.removed",
          ...(scope.kind === "remote"
            ? {
                ...(scope.sourceServerId ? { sourceServerId: scope.sourceServerId } : {}),
                remoteSessionId: scope.remoteSessionId,
              }
            : {}),
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        },
      ]);
    },

    // provisional source 的撤销：只删内部注册，不发任何帧（见文件头 #18 说明）。
    discardSource(scope: WindowHostControllerSourceScope): void {
      // provisional source 尚未发布过 snapshot；CAS 失效时只应撤销内部注册，不能向订阅者
      // 伪造一次 workspace.removed，也不能触碰仍在展示的上一代离线 source。
      // [契约] provisional 撤销只删内部注册，不发 task 与 workspace 任何帧：
      // 它的快照从未发布过，订阅者侧没有对应投影，发 removed 等于凭空删别人的数据。
      // 同时不要顺手改 topicStates.seq——没有对外可见变化就不该消耗序号。
      sources.delete(sourceKey(scope));
    },

    // 写操作路由：先按地址找到唯一 source，再校验任务存在与 source 在线，最后交给 source.mutate。
    // delete-archived* 不要求单任务存在（批量清理的语义），因此单独放行存在性校验。
    getTasks: allRows,
    // [契约] 写路由三步：按地址定位唯一 source、校验任务存在（批量清理豁免）、校验在线。
    // 任一步失败都抛错而不返回 false，调用方需要区分「没找到」与「操作被拒绝」。
    // 返回值为 mutate 的原样透传，本层不解释、不二次包装。
    async mutate(
      address: WindowHostTaskAddress,
      mutation: WindowHostControllerMutation,
    ): Promise<WindowHostControllerMutationResult> {
      const source = Array.from(sources.values()).find((candidate) => {
        if (candidate.scope.workspacePath !== address.workspacePath) {
          return false;
        }
        if (candidate.scope.workspaceIdentity !== address.workspaceIdentity) {
          return false;
        }
        if (candidate.scope.kind === "remote") {
          return address.sourceServerId
            ? candidate.scope.sourceServerId === address.sourceServerId
            : candidate.scope.remoteSessionId === address.remoteSessionId;
        }
        return address.remoteSessionId == null;
      });
      if (
        !source ||
        (mutation.kind !== "delete-archived" &&
          mutation.kind !== "delete-archived-batch" &&
          !source.rows.has(taskKey(address)))
      ) {
        // [失败路径] delete-archived 系列按批量语义放行存在性校验：任务可能已从
        // memberships 消失但仍留在持久层的归档表中，此时要求行存在会直接拒绝。
        // 其余写操作必须命中当前投影行，避免对已移除任务执行改名或置顶造成幽灵写入。
        throw new Error("没有与任务地址匹配的 source");
      }
      if (source.sourceAvailability !== "online") {
        if (source.scope.kind === "remote") {
          throw new Error("远程 source 当前离线，禁止列表写操作");
        }
        throw new Error("本地 source 当前不可用");
      }
      return source.mutate(address, mutation);
    },

    // 订阅：先登记 subscriber 再同步回放 snapshot，保证登记前的并发发布不会丢失；
    // dispose 只移除订阅，不影响 source 与 topic 序号。
    // [并发] 登记 subscriber 与回放 snapshot 之间没有 await，因此不存在
    // 「登记后、回放前」的发布空洞；反过来先回放再登记则会丢掉这段窗口内的 delta。
    // ack 与返回值里的 ack 指向同一对象，是为了兼容新旧调用方各自的读取路径。
    subscribe(params: {
      topic: WindowHostControllerTopic;
      onFrame: ControllerSubscriber["onFrame"];
    }): ControllerSubscribeResult["ack"] & {
      ack: ControllerSubscribeResult["ack"];
      dispose(): void;
    } {
      const subscriptionId = options.createId();
      const subscriber: ControllerSubscriber = {
        topic: params.topic,
        subscriptionId,
        onFrame: params.onFrame,
      };
      subscribers.set(subscriptionId, subscriber);
      const state = topicStates[params.topic];
      const ack: ControllerSubscribeResult["ack"] = {
        subscriptionId,
        mode: "snapshot",
        logEpoch: state.logEpoch,
      };
      params.onFrame(snapshotFrame(subscriber));
      return {
        ...ack,
        ack,
        // [资源] 只摘订阅表，不动 source、不动 topic 序号：
        // 同一 topic 的其他订阅者仍要按现有 seq 继续收帧，
        // 若在这里重置 topicStates 会让还在线的订阅者集体掉队。
        dispose() {
          subscribers.delete(subscriptionId);
        },
      };
    },

    // 重订阅：订阅者判定掉队（漏帧/纪元变化）后重新拉全量；找不到订阅即抛错，不静默成功。
    // [失败路径] 找不到 subscriptionId 直接抛错，不静默返回一个假 ack：
    // 调用方据此判定需要重新订阅，静默成功会让它继续等待永远不会来的帧。
    // 重放内容来自当前全量快照，fromSeq 仍为 0，消费者必须按 logEpoch 决定是否丢弃旧基线。
    resync(subscriptionId: string): ControllerSubscribeResult["ack"] {
      const subscriber = subscribers.get(subscriptionId);
      if (!subscriber) {
        throw new Error(`未找到 Controller subscription，subscriptionId=${subscriptionId}`);
      }
      paramsOnFrameSafe(subscriber, snapshotFrame(subscriber));
      const state = topicStates[subscriber.topic];
      return { subscriptionId, mode: "snapshot", logEpoch: state.logEpoch };
    },
  };
}

function paramsOnFrameSafe(
  subscriber: ControllerSubscriber,
  frame: WindowHostControllerTaskFrame | WindowHostControllerWorkspaceFrame,
): void {
  subscriber.onFrame(frame);
}
