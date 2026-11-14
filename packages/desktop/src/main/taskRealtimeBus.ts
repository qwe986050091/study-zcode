// ============================================================================
// taskRealtimeBus.ts — 主进程的 task 实时总线
//
// 位置：Desktop main 进程内的单例协调器。所有 Local Host（utility process）通过
// postMessage 上报事件，由本类决定「谁能收到、按什么序收到、丢了怎么补」。
// 它同时持有四类状态：host 注册表、task run lease、stream mirror 批次、跨 host 路由。
//
// 为什么必须集中在一处：owner 与 observer 的可见性、seq 连续性与 lease 归属
// 三者互相约束。分散到各 host 会立刻出现「两个 host 都以为自己是 owner」的分叉。
//
// INV 不变量表（每条注明守住它的位置）
// INV-01 同一 workspaceKey + taskId 只能有一个 run lease，且只有 ownerHostId 能发流。
//         守住：acquireLease 的 existing 判断 + handleStreamOpPublish 的 lease 校验。
// INV-02 lease 的 runId 必须匹配；runId 不同即视为陈旧写入，直接丢弃而非覆盖。
//         守住：releaseLease / handleStreamOpPublish / handleOwnerCommandRequest。
// INV-03 seq 单调且连续：opSeq 与 batchSeq 只增不减，且在 split 之后统一分配。
//         守住：flushBatch 中 splitLargeTextOps 先于 seq 赋值。
// INV-04 每批必须先 coalesce 再 split；反序会让合并后的超大 op 逃过切分。
//         守住：flushBatch 的 splitLargeTextOps(coalesceOps(...))。
// INV-05 投递范围由 host 的 workspaceKeys 决定，与 window 无关。
//         守住：deliverStreamBatch / deliverRealtimeEvent / deliverStreamBatchToHost。
// INV-06 事件去重以 eventId 为键，去重必须先于任何副作用（flush、投递）。
//         守住：handleRealtimePublish 首行 rememberEventId。
// INV-07 快照失效必须晚于同 run 的最后一批 mirror 投递。
//         守住：flushMatchingStreamBatchBeforeInvalidation 在 deliver 之前调用。
// INV-08 replay 只在首包 fromSeq 为 1 时可用；否则一律转 stream_mirror_gap 快照补齐。
//         守住：replayVisibleRunsToHost 的 replay[0]?.fromSeq !== 1 判断。
// INV-09 replay 有批次数与字节数双上限；任一超限即裁剪，不允许无界增长。
//         守住：rememberReplayBatch 的两个 while。
// INV-10 oversized batch 不得被丢弃，也不得扩散给 observer：owner 分片、observer 快照。
//         守住：deliverOversizedStreamBatchFallback。
// INV-11 terminal 事件之后 lease 与 batch 必须销毁，避免下一轮 run 复用旧 seq。
//         守住：handleStreamOpPublish 的 terminal 分支 + flushBatch 末尾。
// INV-12 host 注销的顺序：先摘监听器 → 再删表 → 再失败化挂起请求 → 最后释放 lease。
//         守住：unregisterHost 的语句顺序。
// INV-13 挂起的 owner 命令与会话消息必须在 host 退出时失败化，不能等超时。
//         守住：failPendingOwnerCommandsForHost / failPendingSessionMessagesForHost。
// INV-14 所有回包只发给发起方，且发起方身份取自路由表，不信任 payload 字段。
//         守住：handleOwnerCommandRequest 用 requester.hostId 覆盖 requesterHostId。
// INV-15 命令与消息的响应必须校验 ownerHostId / targetHostId 匹配，防伪造与串号。
//         守住：handleOwnerCommandResult 与 handleSessionMessageDeliverResult。
// INV-16 同 requestId 重发时先清旧 timer 再登记，保证一个请求只有一条终态回包。
//         守住：handleSessionMessageSendRequested 的 existing 分支。
// INV-17 permission_request 必须立即 flush：它是交互阻塞点，不能被 1s 合批延迟。
//         守住：isTerminalOrImmediateOp。
// INV-18 只有相邻、同 type、同 taskId、同 traceId 的文本 chunk 可以合并。
//         守住：canMergeTextChunk 的六个条件。
// INV-19 内存诊断只读 size，不得触发清理或副作用。
//         守住：collectMemoryDiagnostics。
// INV-20 timer 只能在 flush 时清除，且清除后必须置 null。
//         守住：flushBatch 与 handleStreamOpPublish 的 timer 赋值成对出现。
// ============================================================================
/* oxlint-disable eslint(max-lines) -- task realtime bus owns lease, stream batching, replay and command routing state in one main-process coordinator. */
// [并发] 所有投递最终都走 UtilityProcess.postMessage，载荷必须可结构化克隆：
// 不要把 Map / Set / class 实例塞进事件对象，否则主进程会直接抛 DataCloneError。
// [权衡] flush 的粒度是「一批」而不是「一个 op」：批内顺序由数组顺序保证，
// 跨批顺序由 seq 保证；任何在批内按 type 分组的重排都会破坏 seq 语义。
// [失败路径] 序列化或投递失败只能记录日志并继续投递其余 host，
// 不能让单个 host 的异常中断整轮 fan-out，否则一个渲染进程卡死会拖垮全部窗口。
// [资源] 诊断计数只读不重置：collectMemoryDiagnostics 会被周期性调用，
// 若顺带清理计数，趋势数据会在每次采样时归零。
// [并发] host 注册表与 lease 表只在主线程读写，因此不需要锁；
// 任何把写操作挪进 worker 或异步回调并发的改动，都必须重新证明这一点。
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  type TaskOwnerCommandDelivery,
  type TaskOwnerCommandRequest,
  type TaskOwnerCommandResult,
  type TaskRealtimeDeliveredEvent,
  type TaskRealtimeEvent,
  type TaskRealtimeHostDeliveryKind,
  type TaskRunLeaseAcquireRequest,
  type TaskRunLeaseResult,
  type TaskRunLeaseTarget,
  type TaskStreamMirrorBatchEvent,
  type TaskStreamMirrorOp,
  type TaskStreamMirrorPublishOp,
  type TaskStreamWatermark,
  formatZodError,
  HostMessageTypes,
  HostResponseTypes,
  hostResponseMessageSchema,
} from "@zcode/shared";
import { logger as defaultLogger } from "./logger.js";

// [权衡] 1s 合批：把高频 chunk 压成一批，代价是流式首字延迟最多 1s。
// 不能为了「更实时」调小到几十毫秒：每次 flush 都会对每个 host 做一次 postMessage 序列化，
// 长任务下 CPU 会被 JSON 拷贝吃掉。延迟只影响非终止事件，权限与终止事件走立即 flush。
//
// [资源] replay 双上限（60 批 / 512KB）与单批上限（512KB）是主进程堆的保护线；
// 文本 op 上限（128K 字符）保证 coalesce 之后单 op 不会独立撑爆 RPC。
// 四个数任一调大都要重估：owner 分片路径依赖单批上限才能收敛。
const STREAM_MIRROR_FLUSH_INTERVAL_MS = 1000;
const STREAM_MIRROR_MAX_REPLAY_BATCHES = 60;
const STREAM_MIRROR_MAX_REPLAY_BYTES = 512 * 1024;
const STREAM_MIRROR_MAX_BATCH_BYTES = 512 * 1024;
const STREAM_MIRROR_TEXT_OP_MAX_CHARS = 128 * 1024;
const OWNER_COMMAND_TIMEOUT_MS = 30_000;
const SESSION_MESSAGE_DELIVERY_TIMEOUT_MS = 30_000;

// 监听器签名保留 unknown：消息来源是不可信的子进程，解析必须发生在总线内（handleHostMessage），
// 不能在注册处做类型断言。
type HostMessageListener = (message: unknown) => void;
// exit 监听单独成类型：注销时必须按引用 off，因此监听器不能写成匿名内联函数。
// [并发] exit 回调可能晚于显式注销到达；unregisterHost 首行判空保证重复注销是幂等的。
// 不要在 exit 回调里直接做业务清理：它运行在 Electron 的事件栈上，
// 重活（flush、批量回包）会阻塞主进程的下一次 tick，必须先完成注册表摘除再交给后续步骤。
type HostExitListener = () => void;

// 一个 utility process 的注册记录。workspaceKeys 是投递可见性的唯一依据：
// host 看不到未声明 workspace 的任何事件，即使它在同一窗口。
// deliveryKind 只用于诊断与测试断言，不参与路由决策 —— 不要把它当成第二个可见性开关。
interface RegisteredRealtimeHost {
  hostId: string;
  windowId: number;
  child: ElectronUtilityProcess;
  workspaceKeys: Set<string>;
  deliveryKind: TaskRealtimeHostDeliveryKind;
  onMessage: HostMessageListener;
  onExit: HostExitListener;
}

// lease 是「这个 run 的流由谁负责」的唯一权威记录。
// [并发] ownerHostId 只能由 acquireLease 写入；其他任何地方都不得改写 owner，
// 否则会绕过 existing 判断，出现双 owner。
// acquiredAt 在重复获取时保留首次值（诊断用），updatedAt 每次刷新 —— 两者不能合并成一个时间戳。
interface TaskRunLease {
  key: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  runId: string;
  traceId: string;
  ownerClientId?: string;
  ownerDeviceLabel?: string;
  ownerHostId: string;
  acquiredAt: number;
  updatedAt: number;
}

// 一个 run 的流镜像缓冲。字段分成三组，混用会出错：
// 游标组（nextBatchSeq/nextOpSeq）只增；中途重置会让 observer 判定 seq 回退并禁用 mirror。
// 缓冲组语义必须区分：pendingOps 是「尚未投递」，replay 是「已投递、供后加入者补看」。
// 闸门组（timer/replayUnavailable/replayInitializedHostIds）：timer 单飞，unavailable 一旦置真不再回放。
// [资源] replay 的裁剪会丢掉首包，进而使 fromSeq 不再为 1，这是设计内的降级路径。
interface PendingStreamBatch {
  batchKey: string;
  workspaceKey: string;
  taskId: string;
  runId: string;
  traceId: string;
  ownerClientId?: string;
  ownerDeviceLabel?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  ownerHostId: string;
  nextBatchSeq: number;
  nextOpSeq: number;
  pendingOps: TaskStreamMirrorPublishOp[];
  replay: TaskStreamMirrorBatchEvent[];
  replayUnavailable: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  replayInitializedHostIds: Set<string>;
}

// 跨 host 命令的在途记录。timeout 必须与 Map 条目同生共死：
// 只删条目不清 timer，会在 30s 后向已完成的请求再发一条失败回包。
interface PendingOwnerCommandRoute {
  commandRequestId: string;
  requesterHostId: string;
  ownerHostId: string;
  createdAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

// 会话间消息的传输载荷。requestId 是端到端幂等键，messageId 是业务消息 id，
// 两者不能互换使用：重试复用 requestId，但可能生成新的 messageId。
interface SessionMessageRequest {
  content: string;
  createdAt: string;
  fromSessionId: string;
  messageId: string;
  requestId: string;
  toSessionId: string;
}

// 终态回包。sessionId 语义是「发起方 session」（失败时也要能定位到谁发起的），
// 不是目标 session —— 目标只出现在 error 文案里。
interface SessionMessageDeliveryResult {
  error?: string;
  messageId: string;
  requestId: string;
  sessionId: string;
  status: "success" | "failed";
}

// 双 host 记录：source 用于回包，target 用于校验响应来源。
// 两者都参与 host 退出清理，缺一个就会出现永远等不到的回包。
interface PendingSessionMessageDelivery {
  request: SessionMessageRequest;
  sourceHostId: string;
  targetHostId: string;
  timeout: ReturnType<typeof setTimeout>;
}

interface TaskRealtimeBusLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

// logger 与 seenEventLimit 只允许构造期注入：测试用较小的去重窗口，生产用默认 1000。
// 运行期修改窗口会让去重 Set 与顺序数组失配。
interface TaskRealtimeBusOptions {
  logger?: TaskRealtimeBusLogger;
  seenEventLimit?: number;
}

export class TaskRealtimeBus {
  private readonly logger: TaskRealtimeBusLogger;
  private readonly seenEventLimit: number;
  // hosts 是唯一的注册表：所有投递都从这里取目标，没有第二份 list。
  // 不要为了「快照遍历」另存数组 —— 注销后数组里会留下已退出的 child，
  // postMessage 到僵尸进程会静默失败，表现为「消息发了但没人收」。
  private readonly hosts = new Map<string, RegisteredRealtimeHost>();
  // 事件去重窗口：Set 负责 O(1) 判定，数组负责 FIFO 淘汰。
  // [资源] 两个结构必须同步增删；只从 Set 删会让数组无限增长，只从数组删会让 Set 永远命中。
  // 窗口按条数而非时间，因此突发事件下覆盖时长会收缩 —— 刻意选择，避免依赖系统时钟。
  private readonly seenEventIds = new Set<string>();
  private readonly seenEventOrder: string[] = [];
  // lease 表的键是 workspaceKey + taskId（不含 runId）：同一 task 换 run 是覆盖关系，
  // 而不是并存关系。跨 run 的并发流在协议层就不允许。
  private readonly leases = new Map<string, TaskRunLease>();
  // 批次表的键额外包含 runId：不同 run 的 seq 空间互相独立，混用会污染对端游标。
  // 条目在 terminal 时删除；未 terminal 但 host 退出的批次靠 lease 释放时的 flush 收尾。
  private readonly streamBatches = new Map<string, PendingStreamBatch>();
  // 在途命令表以 commandRequestId 为键。它只记录路由，不缓存结果内容：
  // 结果直接从 owner 回包转发给 requester，少一次拷贝。
  private readonly pendingOwnerCommands = new Map<string, PendingOwnerCommandRoute>();
  // sessionId 到 hostId 的单向索引。没有反向索引是有意的：
  // 反查只发生在 host 退出这类低频路径，遍历成本可接受；维护双向索引会引入两份真相。
  private readonly sessionRoutes = new Map<string, string>();
  // 会话消息在途表。键是 requestId 而不是 messageId：
  // 发起方可能用同一 requestId 重试，此时应替换旧记录而不是堆叠。
  private readonly pendingSessionMessageDeliveries = new Map<
    string,
    PendingSessionMessageDelivery
  >();

  // [并发] 构造函数不做任何副作用：不注册 host、不启动 timer。
  // 总线可能在 host 尚未就绪时创建，提前启动的定时器只会在空表上空转。
  constructor(options: TaskRealtimeBusOptions = {}) {
    this.logger = options.logger ?? defaultLogger;
    this.seenEventLimit = options.seenEventLimit ?? 1000;
  }

  // 注册（或重新注册）一个 host。重注册会先走完整注销流程：
  // 同一 hostId 换 child 进程时，旧 child 的监听器必须先摘掉，
  // 否则旧进程的迟到消息仍会被当作有效事件处理。
  // 注册完成后立即回放当前可见 run，保证新窗口与新 host 能补看进行中的任务。
  registerHost(params: {
    hostId: string;
    windowId: number;
    child: ElectronUtilityProcess;
    workspaceKeys: Iterable<string>;
    deliveryKind?: TaskRealtimeHostDeliveryKind;
  }): void {
    // 重注册不是「更新字段」而是「换一个进程」：直接覆盖会漏掉旧进程的 pending 清理与 lease 释放。
    const existing = this.hosts.get(params.hostId);
    if (existing) {
      this.unregisterHost(params.hostId);
    }

    const onMessage: HostMessageListener = (message) => {
      this.handleHostMessage(params.hostId, message);
    };
    const onExit: HostExitListener = () => {
      this.unregisterHost(params.hostId);
    };

    // [资源] message 用 on、exit 用 once：exit 只可能发生一次，重复触发会让注销逻辑重入；
    // 两个监听器都必须保存引用，注销时按引用 off，而不是 removeAllListeners。
    params.child.on("message", onMessage);
    params.child.once("exit", onExit);

    const workspaceKeys = new Set(params.workspaceKeys);
    const deliveryKind = params.deliveryKind ?? "desktop_window";
    this.hosts.set(params.hostId, {
      hostId: params.hostId,
      windowId: params.windowId,
      child: params.child,
      workspaceKeys,
      deliveryKind,
      onMessage,
      onExit,
    });

    this.logger.info("[task-realtime] registered host", {
      hostId: params.hostId,
      windowId: params.windowId,
      workspaceKeyCount: workspaceKeys.size,
      deliveryKind,
    });

    this.replayVisibleRunsToHost(params.hostId, workspaceKeys);
  }

  // [并发] 注销顺序不可交换：
  // 1) 先摘监听器，阻断后续消息进入；2) 再删注册表，使投递不再命中该 host；
  // 3) 失败化挂起的命令与会话消息；4) 最后释放 lease 并广播快照失效。
  // 如果先删注册表再摘监听器，中间窗口内的消息会以「未知 host」被丢弃且无人补发；
  // 如果先释放 lease，owner 侧的收尾可能还握着流，出现「已经没人要但还在发」的批次。
  unregisterHost(hostId: string): void {
    const registered = this.hosts.get(hostId);
    if (!registered) {
      return;
    }

    // off?. 是对测试替身的兼容：部分单测只注入带有 on 的最小对象。
    // 生产环境的 UtilityProcess 一定有 off，不允许改成 removeAllListeners。
    registered.child.off?.("message", registered.onMessage);
    registered.child.off?.("exit", registered.onExit);
    this.hosts.delete(hostId);
    this.failPendingOwnerCommandsForHost(hostId, "Owner command host exited.");
    this.unregisterSessionRoutesForHost(hostId);
    this.failPendingSessionMessagesForHost(hostId, "Session message host exited.");
    const releasedLeases = this.releaseLeasesForHost(hostId);
    // 只对「因 host 消失而被动释放」的 lease 发失效：主动 release 时流已正常收尾，不需要快照补齐。
    for (const lease of releasedLeases) {
      this.deliverSnapshotInvalidation(lease, hostId, "stream_mirror_owner_lost");
    }

    this.logger.info("[task-realtime] unregistered host", {
      hostId,
      windowId: registered.windowId,
    });
  }

  // 可见范围更新。只回放「新增」的 workspace：已可见的 host 早已收过 replay，
  // 重复回放会让它的 seq 游标倒退。
  // 先替换 set 再 replay：replay 内部会再查一次 host.workspaceKeys，
  // 顺序反了会对新 workspace 判定不可见而静默跳过。
  // [失败路径] 未知 host 只告警：此时 host 可能正在退出，抛错会打断调用方的无关流程。
  updateHostWorkspaceKeys(hostId: string, workspaceKeys: Iterable<string>): void {
    const registered = this.hosts.get(hostId);
    if (!registered) {
      this.logger.warn("[task-realtime] workspace update for unknown host", { hostId });
      return;
    }

    const previous = registered.workspaceKeys;
    const next = new Set(workspaceKeys);
    registered.workspaceKeys = next;
    this.logger.info("[task-realtime] updated host workspace scopes", {
      hostId,
      workspaceKeyCount: registered.workspaceKeys.size,
    });
    this.replayVisibleRunsToHost(
      hostId,
      [...next].filter((workspaceKey) => !previous.has(workspaceKey)),
    );
  }

  // getHostDeliveryKindForTest 仅供测试断言投递类型；生产代码不得据此分支。
  getHostDeliveryKindForTest(hostId: string): TaskRealtimeHostDeliveryKind | undefined {
    return this.hosts.get(hostId)?.deliveryKind;
  }

  // 子进程消息的唯一入口。三层校验缺一不可：
  // 1) schema 校验：越界字段一律 warn + 丢弃，不能 try/catch 后继续；
  // 2) origin 必须已注册：未注册 host 的消息没有可见范围，无法路由；
  // 3) switch 只处理显式列出的类型，未知类型静默忽略（版本错配时宁可不处理也不能抛）。
  private handleHostMessage(hostId: string, message: unknown): void {
    // 用 safeParse 而不是 parse：解析失败是常态（版本错配、脏消息），
    // safeParse 返回失败时必须只记日志并 return，一次异常不能带走整个总线。
    const parsed = hostResponseMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.logger.warn(
        "[task-realtime] invalid host response message:",
        formatZodError(parsed.error),
      );
      return;
    }

    // origin 取自注册表而不是消息内容：host 身份只能由进程句柄决定，payload 里的 hostId 不可信。
    const origin = this.hosts.get(hostId);
    if (!origin) {
      this.logger.warn("[task-realtime] publish from unknown host", { hostId });
      return;
    }

    switch (parsed.data.type) {
      case HostResponseTypes.TaskRealtimePublish:
        this.handleRealtimePublish(origin, parsed.data.event as TaskRealtimeEvent);
        break;
      case HostResponseTypes.TaskRunLeaseAcquire:
        this.handleLeaseAcquire(origin, parsed.data.request);
        break;
      case HostResponseTypes.TaskRunLeaseRelease:
        this.releaseLease(origin.hostId, parsed.data.target);
        break;
      case HostResponseTypes.TaskStreamOpPublish:
        this.handleStreamOpPublish(
          origin,
          parsed.data.target,
          parsed.data.op as TaskStreamMirrorPublishOp,
        );
        break;
      case HostResponseTypes.TaskOwnerCommandRequest:
        this.handleOwnerCommandRequest(origin, parsed.data.command);
        break;
      case HostResponseTypes.TaskOwnerCommandResult:
        this.handleOwnerCommandResult(origin, parsed.data.result);
        break;
      case HostResponseTypes.SessionMessageSendRequested:
        this.handleSessionMessageSendRequested(origin, parsed.data.request);
        break;
      case HostResponseTypes.SessionRouteAnnounce:
        this.rememberSessionRoute(origin, parsed.data.route);
        break;
      case HostResponseTypes.SessionMessageDeliverResult:
        this.handleSessionMessageDeliverResult(origin, parsed.data.result);
        break;
      default:
        break;
    }
  }

  // 后写覆盖：同一 session 在新 host 上重新打开后，旧路由必须让位。
  // 这里不做业务校验，因为 route 已在 handleHostMessage 过 schema；
  // 额外的校验会引入「注册成功但不可达」的静默状态。
  private rememberSessionRoute(
    origin: RegisteredRealtimeHost,
    route: {
      sessionId: string;
    },
  ): void {
    this.sessionRoutes.set(route.sessionId, origin.hostId);
  }

  // 普通实时事件的中转。去重必须在 flush 与投递之前：
  // 重复事件若先触发 flush，会把本可合并的批次提前切开，改变 seq 观测值。
  // originHostId 用总线自己的记录覆盖 payload 值，防止 host 冒充其他来源。
  // shouldDeliver 恒真：普通事件对同 workspace 的所有 host 广播，包括发送者自己（用于回声对账）。
  private handleRealtimePublish(origin: RegisteredRealtimeHost, event: TaskRealtimeEvent): void {
    // 重复事件直接返回，不做任何补偿：发送方负责在丢包场景重发，总线不承担 at-least-once 语义。
    if (!this.rememberEventId(event.eventId)) {
      return;
    }
    this.flushMatchingStreamBatchBeforeInvalidation(event);
    this.deliverRealtimeEvent({ ...event, originHostId: origin.hostId }, () => true);
  }

  // 获取结果通过原 child 回包，而不走广播：只有发起方关心是否拿到 lease。
  // 回包必须使用 TaskRunLeaseResult，与请求一一对应，除 requestId 外没有额外关联字段。
  private handleLeaseAcquire(
    origin: RegisteredRealtimeHost,
    request: TaskRunLeaseAcquireRequest,
  ): void {
    origin.child.postMessage({
      type: HostMessageTypes.TaskRunLeaseResult,
      result: this.acquireLease(origin.hostId, request),
    });
  }

  // [权衡] 用 NUL 拼接而不是 JSON.stringify：键在热路径上每批次都要算，
  // 字符串拼接比序列化快一个数量级；NUL 不可能出现在 workspaceKey/taskId 中，因此无歧义。
  private getLeaseKey(workspaceKey: string, taskId: string): string {
    return `${workspaceKey}\u0000${taskId}`;
  }

  // 批次键在 lease 键之上追加 runId：同一 task 的不同 run 必须拥有独立 seq 空间。
  private getBatchKey(workspaceKey: string, taskId: string, runId: string): string {
    return `${this.getLeaseKey(workspaceKey, taskId)}\u0000${runId}`;
  }

  // [并发] acquireLease 的租约获取是同步的（主进程单线程），不存在检查-写入竞态；
  // 真正的竞态在跨进程：两个 host 同时请求时，先到者写入，后到者被 existing 拒绝。
  // 同 host + 同 runId 重复获取是幂等的，会刷新 updatedAt 但保留 acquiredAt。
  // 同 host + 不同 runId 视为新 run，允许覆盖 —— 这是「同一 host 重启 run」的正常路径。
  private acquireLease(hostId: string, request: TaskRunLeaseAcquireRequest): TaskRunLeaseResult {
    const key = this.getLeaseKey(request.workspaceKey, request.taskId);
    const existing = this.leases.get(key);
    // 拒绝时回带 ownerHostId，让调用方知道该去找谁要快照；
    // 不暴露 traceId 等业务字段，避免把总线变成查询接口。
    if (existing && (existing.ownerHostId !== hostId || existing.runId !== request.runId)) {
      return {
        leaseRequestId: request.leaseRequestId,
        acquired: false,
        ownerHostId: existing.ownerHostId,
        reason: "owned_by_other_host",
      };
    }

    const now = Date.now();
    this.leases.set(key, {
      key,
      workspaceKey: request.workspaceKey,
      workspacePath: request.workspacePath,
      workspaceIdentity: request.workspaceIdentity,
      taskId: request.taskId,
      runId: request.runId,
      traceId: request.traceId,
      ownerClientId: request.ownerClientId,
      ownerDeviceLabel: request.ownerDeviceLabel,
      ownerHostId: hostId,
      acquiredAt: existing?.acquiredAt ?? now,
      updatedAt: now,
    });
    this.logger.info("[task-realtime] task run lease acquired", {
      hostId,
      workspaceKey: request.workspaceKey,
      taskId: request.taskId,
      runId: request.runId,
    });
    return { leaseRequestId: request.leaseRequestId, acquired: true, ownerHostId: hostId };
  }

  /** 内存诊断计数器；只读 size。 */
  // collectMemoryDiagnostics 只读三张核心表的大小，不能顺手清理、也不能打日志。
  // 接入内存采样时不要在采样回调里顺手清理 —— 采样的时序会污染诊断结论。
  collectMemoryDiagnostics(): Record<string, number> {
    return {
      streamBatches: this.streamBatches.size,
      leases: this.leases.size,
      sessionRoutes: this.sessionRoutes.size,
    };
  }

  // 主动释放。先 force flush 再删 lease：
  // 反序会让最后一批 pendingOps 失去 lease 归属，flush 时无法计算 batch 键而静默丢失。
  // owner 与 runId 双校验：陈旧 host 的重试释放不得影响新 owner 的租约。
  private releaseLease(hostId: string, target: TaskRunLeaseTarget): void {
    const key = this.getLeaseKey(target.workspaceKey, target.taskId);
    const existing = this.leases.get(key);
    if (!existing || existing.ownerHostId !== hostId || existing.runId !== target.runId) {
      return;
    }
    this.flushBatch(this.getBatchKey(target.workspaceKey, target.taskId, target.runId), true);
    this.leases.delete(key);
    this.logger.info("[task-realtime] task run lease released", {
      hostId,
      workspaceKey: target.workspaceKey,
      taskId: target.taskId,
      runId: target.runId,
    });
  }

  // host 级释放：返回被释放的 lease 列表，调用方据此广播失效。
  // 遍历时直接删除 Map 条目是安全的（Map 迭代器允许删除当前项）。
  private releaseLeasesForHost(hostId: string): TaskRunLease[] {
    const released: TaskRunLease[] = [];
    for (const [key, lease] of this.leases) {
      if (lease.ownerHostId !== hostId) {
        continue;
      }
      this.flushBatch(this.getBatchKey(lease.workspaceKey, lease.taskId, lease.runId), true);
      this.leases.delete(key);
      released.push(lease);
    }
    return released;
  }

  // 流片段的写入路径。三重校验（lease 存在、owner 匹配、runId 匹配）缺一不可：
  // 少 lease 判断等于允许任何 host 往任意 task 注入内容；
  // 少 runId 判断会把上一轮 run 的迟到 chunk 拼到新一轮的正文里。
  // [失败路径] 校验失败静默丢弃：调用方是 push 语义，没有可回报的请求 id，
  // 在此处抛错只会在主进程留下无人处理的异常。
  private handleStreamOpPublish(
    origin: RegisteredRealtimeHost,
    target: TaskRunLeaseTarget,
    op: TaskStreamMirrorPublishOp,
  ): void {
    // 这里不校验 traceId：trace 只是观测维度，流的归属只由 lease 决定。
    const lease = this.leases.get(this.getLeaseKey(target.workspaceKey, target.taskId));
    if (!lease || lease.ownerHostId !== origin.hostId || lease.runId !== target.runId) {
      return;
    }

    const batchKey = this.getBatchKey(target.workspaceKey, target.taskId, target.runId);
    const batch = this.getOrCreateBatch(batchKey, origin.hostId, target);
    batch.pendingOps.push(op);

    // 立即 flush 的两类 op：权限请求（阻塞交互）与终止事件（seq 收尾）。
    // 终止事件额外立即删 lease：不删的话，同 taskId 的下一个 run 会拿到同 key，
    // acquire 时被 existing 判定为「同 host 不同 run」而覆盖，看似正常，实则旧 batch 的 timer 仍在跑。
    if (this.isTerminalOrImmediateOp(op)) {
      this.flushBatch(batchKey, true);
      if (op.kind === "stream_event" && this.isTerminalEventType(op.event.type)) {
        this.leases.delete(this.getLeaseKey(target.workspaceKey, target.taskId));
      }
      return;
    }

    // timer 单飞：只有当前没有排定的 flush 才注册新的。
    // 每个 op 都注册会让 flush 次数与 chunk 数同阶，1s 合批完全失效。
    // 回调里先置 null 再 flush：flush 内部还会再判一次 timer，顺序反了会 clear 自己正在执行的句柄。
    if (!batch.timer) {
      batch.timer = setTimeout(() => {
        batch.timer = null;
        this.flushBatch(batchKey, false);
      }, STREAM_MIRROR_FLUSH_INTERVAL_MS);
    }
  }

  // 首次创建时 seq 从 1 开始：replay 的可用性判定依赖「首包 fromSeq === 1」，
  // 从 0 开始会让所有后加入 host 永远走快照补齐。
  private getOrCreateBatch(
    batchKey: string,
    ownerHostId: string,
    target: TaskRunLeaseTarget,
  ): PendingStreamBatch {
    let batch = this.streamBatches.get(batchKey);
    if (batch) {
      return batch;
    }
    batch = {
      batchKey,
      workspaceKey: target.workspaceKey,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      taskId: target.taskId,
      runId: target.runId,
      traceId: target.traceId,
      ownerClientId: target.ownerClientId,
      ownerDeviceLabel: target.ownerDeviceLabel,
      ownerHostId,
      nextBatchSeq: 1,
      nextOpSeq: 1,
      pendingOps: [],
      replay: [],
      replayUnavailable: false,
      timer: null,
      replayInitializedHostIds: new Set<string>(),
    };
    this.streamBatches.set(batchKey, batch);
    return batch;
  }

  // [事务] 快照型事件（消息已保存 / 状态变更）会触发消费端重新拉快照；
  // 拉快照之前必须把已缓冲的流片段投递出去，否则快照与流会出现「快照包含、流里缺失」的分叉。
  // 只对三类 reason 生效，且跳过 mirror batch 自身 —— 对 mirror 事件再调 flush 会递归。
  private flushMatchingStreamBatchBeforeInvalidation(event: TaskRealtimeEvent): void {
    if (
      event.type === "task_stream_mirror_batch" ||
      !("taskId" in event) ||
      !event.taskId ||
      (event.reason !== "user_message_saved" &&
        event.reason !== "assistant_message_saved" &&
        event.reason !== "task_status_changed")
    ) {
      return;
    }
    this.flushBatch(this.getBatchKey(event.workspaceKey, event.taskId, event.traceId), true);
  }

  // 批次出站。步骤顺序即协议顺序，不能重排：
  // 1) 空批直接返回；2) 清 timer；3) coalesce → split；4) 分配 seq；5) 组装事件；
  // 6) 体积超限走分片兜底；7) 记忆 replay；8) 按可见性投递；9) terminal 时销毁批次。
  // coalesce 与 split 的顺序见 INV-04；seq 必须在 split 之后分配，
  // 否则合并后的大 op 被切开时会复用同一个 seq，消费端会判定重复并丢弃后半段。
  private flushBatch(batchKey: string, force: boolean): void {
    const batch = this.streamBatches.get(batchKey);
    // [失败路径] 提前返回不报错：定时器可能在上一次 flush 后仍被触发一次，空批是常态。
    if (!batch || batch.pendingOps.length === 0) {
      return;
    }
    if (!force && batch.pendingOps.length === 0) {
      return;
    }
    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }

    // 先取走再处理：处理中途抛错时这一批会丢，但不会出现同一批 op 被分配两套 seq 的重复投递。
    const coalesced = this.splitLargeTextOps(this.coalesceOps(batch.pendingOps));
    batch.pendingOps = [];
    const ops: TaskStreamMirrorOp[] = coalesced.map((op) => ({
      ...op,
      seq: batch.nextOpSeq++,
    }));
    // eventId 形如 stream-workspace-task-run-batchSeq：
    // 它在总线内部不再去重（mirror 事件不经过 handleRealtimePublish），只作为消费端的幂等键，
    // 因此必须包含 batchSeq，不能只用 taskId。
    const event: TaskStreamMirrorBatchEvent = {
      type: "task_stream_mirror_batch",
      eventId: `stream-${batch.workspaceKey}-${batch.taskId}-${batch.runId}-${batch.nextBatchSeq}`,
      workspacePath: batch.workspacePath,
      workspaceIdentity: batch.workspaceIdentity,
      workspaceKey: batch.workspaceKey,
      traceId: batch.traceId,
      createdAt: Date.now(),
      taskId: batch.taskId,
      runId: batch.runId,
      ownerClientId: batch.ownerClientId,
      ownerDeviceLabel: batch.ownerDeviceLabel,
      batchSeq: batch.nextBatchSeq++,
      fromSeq: ops[0]?.seq ?? batch.nextOpSeq,
      toSeq: ops[ops.length - 1]?.seq ?? batch.nextOpSeq - 1,
      ops,
      terminal: ops.some(
        (op) => op.kind === "stream_event" && this.isTerminalEventType(op.event.type),
      ),
    };
    // 用序列化长度而不是 op 数做判据：真实成本在 postMessage 的 JSON 拷贝上，op 数不反映体积。
    if (JSON.stringify(event).length > STREAM_MIRROR_MAX_BATCH_BYTES) {
      // 单次 mirror batch 过大时，RPC/base64/JSON 会在链路上多次复制，导致 host 堆内存打满。
      // owner 仍依赖 mirror seq 流渲染主动发送端，所以这里对 owner 做小批次分片；observer
      // 不消费正文流，只收到 snapshot invalidation/remoteGenerating 状态。
      this.deliverOversizedStreamBatchFallback(batch, event);
      return;
    }
    this.rememberReplayBatch(batch, event);
    this.deliverStreamBatch(batch, event);

    // terminal 批次投递后立即销毁：批次里的 replay 不再有意义，下一个 run 会新建。
    // 注意这里只删 batch，不删 lease —— lease 已在终止分支删除或由调用方 release 收尾。
    if (event.terminal) {
      this.streamBatches.delete(batchKey);
    }
  }

  // [权衡] 超大批次的三方妥协：
  // owner 必须拿到连续的 mirror seq，否则 service 侧检测到缺口会直接禁用镜像；
  // observer 不消费正文流，只依赖快照，因此对它们发失效比发大包更便宜；
  // replay 必须标记为不可用并清空，后加入的 host 只能走快照补齐，避免大 payload 在主进程内存里留存。
  // 这里不调用 rememberReplayBatch：分片后再记忆会让 replay 首包 fromSeq 不为 1，反而制造无效回放。
  private deliverOversizedStreamBatchFallback(
    batch: PendingStreamBatch,
    event: TaskStreamMirrorBatchEvent,
  ): void {
    // 不能丢弃 owner 的 mirror seq。ZCode Agent 有 realtime port 时 owner direct stream 会被关闭，
    // 如果 oversized batch 只发 gap，service 会因为后续 seq 缺口禁用 mirror，桌面端就停到终态快照。
    // 这里只给 owner 发送连续小批次；observer 和 late subscriber 统一走快照补齐，避免大 payload 扩散。
    batch.replayUnavailable = true;
    batch.replay = [];
    for (const chunk of this.splitOversizedBatchForOwner(batch, event)) {
      this.deliverStreamBatchToHost(batch.ownerHostId, batch, chunk, "relay_owner");
    }
    this.deliverSnapshotInvalidation(
      this.batchToLeaseLike(batch),
      batch.ownerHostId,
      "stream_mirror_gap",
      undefined,
      { runId: event.runId, opSeq: event.toSeq },
    );
    if (event.terminal) {
      this.streamBatches.delete(batch.batchKey);
    }
  }

  // 把超限批次重新切成若干小批次，seq 仍取自 batch.nextBatchSeq。
  // [权衡] splitOversizedBatchForOwner 的体积判定必须用「候选批 + 本 op」的序列化长度，是近似值（每次拼接都要 JSON.stringify），
  // 但 512KB 量级下已足够；精确字节数要再走一次 JSON.stringify，额外编码开销与收益不成比例。
  // splitOversizedBatchForOwner 在单个 op 自身超限时不再切分（上游已按 128K 字符切过文本），仍单独成批。
  private splitOversizedBatchForOwner(
    batch: PendingStreamBatch,
    event: TaskStreamMirrorBatchEvent,
  ): TaskStreamMirrorBatchEvent[] {
    const chunks: TaskStreamMirrorBatchEvent[] = [];
    let pendingOps: TaskStreamMirrorOp[] = [];

    // 每个分片重新计算 terminal：原批次可能整体非终止，但分片内恰好包含终止事件。
    const createChunk = (
      ops: TaskStreamMirrorOp[],
      batchSeq: number,
    ): TaskStreamMirrorBatchEvent => ({
      ...event,
      eventId: `stream-${batch.workspaceKey}-${batch.taskId}-${batch.runId}-${batchSeq}`,
      batchSeq,
      fromSeq: ops[0]?.seq ?? event.fromSeq,
      toSeq: ops[ops.length - 1]?.seq ?? event.toSeq,
      ops,
      terminal: ops.some(
        (op) => op.kind === "stream_event" && this.isTerminalEventType(op.event.type),
      ),
    });

    const flushPending = () => {
      if (pendingOps.length === 0) {
        return;
      }
      chunks.push(createChunk(pendingOps, batch.nextBatchSeq++));
      pendingOps = [];
    };

    // 先判断再加入：candidate 只用于测体积，不入 pendingOps；
    // 直接 push 再判断会导致超限时把 op 留在了错误的批次里。
    for (const op of event.ops) {
      const candidate = [...pendingOps, op];
      const candidateChunk = createChunk(candidate, batch.nextBatchSeq);
      if (
        pendingOps.length > 0 &&
        JSON.stringify(candidateChunk).length > STREAM_MIRROR_MAX_BATCH_BYTES
      ) {
        flushPending();
      }
      pendingOps.push(op);
    }
    flushPending();
    return chunks;
  }

  // coalesceOps 只做两件事：相邻文本拼接、冗余状态事件后者覆盖前者。
  // 两类合并都不改变语义，但都会改变「消费端看到的 op 数」，
  // 因此不能把需要逐条展现的事件（权限、工具调用）纳入合并。
  private coalesceOps(ops: TaskStreamMirrorPublishOp[]): TaskStreamMirrorPublishOp[] {
    const coalesced: TaskStreamMirrorPublishOp[] = [];
    for (const op of ops) {
      const previous = coalesced[coalesced.length - 1];
      if (this.canMergeTextChunk(previous, op)) {
        const current = op as Extract<TaskStreamMirrorPublishOp, { kind: "stream_event" }> & {
          event: { content: string };
        };
        coalesced[coalesced.length - 1] = {
          kind: "stream_event",
          event: {
            ...previous.event,
            content: previous.event.content + current.event.content,
          },
        };
        continue;
      }
      if (
        // 冗余状态事件只能来自 usage_update / session_info_update / plan 这三种快照型事件，旧值无人消费，
        // isRedundantStateEvent 命中后用后者覆盖前者，可显著减少长任务的状态抖动流量。
        // 前提是 type 与 taskId 都相同：跨 task 覆盖会把 A 的用量写到 B 上。
        previous?.kind === "stream_event" &&
        op.kind === "stream_event" &&
        this.isRedundantStateEvent(op.event.type) &&
        previous.event.type === op.event.type &&
        previous.event.taskId === op.event.taskId
      ) {
        coalesced[coalesced.length - 1] = op;
        continue;
      }
      coalesced.push(op);
    }
    return coalesced;
  }

  // 文本 op 的二次切分。只对 agent_message_chunk / agent_thought_chunk 生效：
  // 其他事件带结构化字段，切片会破坏语义。
  // [资源] 切分保证单 op 不超过 128K 字符，与批次上限配合，使 owner 分片路径必然收敛。
  private splitLargeTextOps(ops: TaskStreamMirrorPublishOp[]): TaskStreamMirrorPublishOp[] {
    const splitOps: TaskStreamMirrorPublishOp[] = [];
    for (const op of ops) {
      if (
        op.kind !== "stream_event" ||
        (op.event.type !== "agent_message_chunk" && op.event.type !== "agent_thought_chunk") ||
        op.event.content.length <= STREAM_MIRROR_TEXT_OP_MAX_CHARS
      ) {
        splitOps.push(op);
        continue;
      }

      // 文本 chunk 可能被 coalesce 合成超大单 op；后续即使按 op 分 batch，
      // 单个 op 仍会超过 RPC 安全预算。这里先把文本切成连续小 op，再统一分配 seq。
      for (
        let offset = 0;
        offset < op.event.content.length;
        offset += STREAM_MIRROR_TEXT_OP_MAX_CHARS
      ) {
        splitOps.push({
          kind: "stream_event",
          event: {
            ...op.event,
            content: op.event.content.slice(offset, offset + STREAM_MIRROR_TEXT_OP_MAX_CHARS),
          },
        });
      }
    }
    return splitOps;
  }

  // 返回类型守卫：合并分支依赖 previous.event.content 为 string，
  // 所以这里同时校验两个 content 都是字符串，而不是只靠调用处断言。
  private canMergeTextChunk(
    previous: TaskStreamMirrorPublishOp | undefined,
    op: TaskStreamMirrorPublishOp,
  ): previous is Extract<TaskStreamMirrorPublishOp, { kind: "stream_event" }> & {
    event: {
      type: "agent_message_chunk" | "agent_thought_chunk";
      taskId: string;
      traceId: string;
      content: string;
    };
  } {
    return (
      previous?.kind === "stream_event" &&
      op.kind === "stream_event" &&
      (op.event.type === "agent_message_chunk" || op.event.type === "agent_thought_chunk") &&
      previous.event.type === op.event.type &&
      previous.event.taskId === op.event.taskId &&
      previous.event.traceId === op.event.traceId &&
      "content" in previous.event &&
      "content" in op.event &&
      typeof previous.event.content === "string" &&
      typeof op.event.content === "string"
    );
  }

  // 白名单而非前缀匹配：新增状态事件时必须显式加入，
  // 否则会被当作可丢弃事件覆盖，导致消费端丢失一次状态迁移。
  private isRedundantStateEvent(type: string): boolean {
    return type === "usage_update" || type === "session_info_update" || type === "plan";
  }

  // 终止事件集是 seq 收尾的唯一信号；增删都必须同步 flushBatch 与 lease 清理两处。
  private isTerminalEventType(type: string): boolean {
    return type === "task_complete" || type === "task_error";
  }

  // permission_request 走立即 flush：它会让 UI 进入等待态，1s 延迟在权限场景里可感知。
  private isTerminalOrImmediateOp(op: TaskStreamMirrorPublishOp): boolean {
    return (
      op.kind === "stream_event" &&
      (op.event.type === "permission_request" || this.isTerminalEventType(op.event.type))
    );
  }

  // 按 workspace 可见性广播。owner 与 observer 收同一份 seq 流，只有 deliveryPurpose 不同：
  // owner 允许把 mirror 当作唯一来源，observer 则可能被要求丢弃并回退快照。
  // 不要在这里给 owner 单独裁剪字段 —— 两边结构一旦分叉，跨端切换就会丢状态。
  private deliverStreamBatch(batch: PendingStreamBatch, event: TaskStreamMirrorBatchEvent): void {
    // 遍历期间不修改 hosts：投递失败（child 已退出）时也不在这里顺手注销，
    // 退出事件会走 unregisterHost 的完整清理路径，避免重入。
    for (const target of this.hosts.values()) {
      if (!target.workspaceKeys.has(batch.workspaceKey)) {
        continue;
      }
      target.child.postMessage({
        type: HostMessageTypes.TaskRealtimeDeliver,
        event: {
          ...event,
          originHostId: batch.ownerHostId,
          // owner 和 observer 以前消费两条不同事件源：owner 走不可重放 direct event，
          // observer 走 mirror batch。切换 task 或跨端 relay 时两边会因为事件丢失/乱序产生分叉。
          // 这里统一把 mirror batch 回投给 owner，让所有 renderer 都按同一条 seq 流更新 task store。
          deliveryPurpose: target.hostId === batch.ownerHostId ? "relay_owner" : "observer",
        } satisfies TaskRealtimeDeliveredEvent,
      });
    }
  }

  // 单目标投递，仅供 oversized 分片使用。仍校验 workspace 可见性：
  // 分片是 owner 专属路径，但 owner 换窗口后可见范围可能已收窄。
  private deliverStreamBatchToHost(
    hostId: string,
    batch: PendingStreamBatch,
    event: TaskStreamMirrorBatchEvent,
    deliveryPurpose: "relay_owner" | "observer",
  ): void {
    const target = this.hosts.get(hostId);
    if (!target?.workspaceKeys.has(batch.workspaceKey)) {
      return;
    }
    target.child.postMessage({
      type: HostMessageTypes.TaskRealtimeDeliver,
      event: {
        ...event,
        originHostId: batch.ownerHostId,
        deliveryPurpose,
      } satisfies TaskRealtimeDeliveredEvent,
    });
  }

  // 先 push 再裁剪：裁剪只保证上限，不保证保留最新；
  // 两个 while 的顺序是先按条数、再按字节，最终约束是「两者都不超」。
  // [资源] 裁剪会让 replay 首包的 fromSeq 不再是 1，后续 host 加入时自然退化为快照补齐，不需要额外标记。
  private rememberReplayBatch(batch: PendingStreamBatch, event: TaskStreamMirrorBatchEvent): void {
    // 无上限 replay 在长任务中会线性占用主进程内存。
    // 这里恢复批次数+字节数双阈值，超限后由 replayVisibleRunsToHost 触发 stream_mirror_gap 并走快照补齐。
    batch.replay.push(event);
    while (batch.replay.length > STREAM_MIRROR_MAX_REPLAY_BATCHES) {
      batch.replay.shift();
    }
    while (this.replayBytes(batch.replay) > STREAM_MIRROR_MAX_REPLAY_BYTES) {
      batch.replay.shift();
    }
  }

  // 每次 flush 都整体重算：批次数上限 60，线性成本远小于维护增量计数器的复杂度与出错面。
  private replayBytes(replay: TaskStreamMirrorBatchEvent[]): number {
    return replay.reduce((total, replayEvent) => total + JSON.stringify(replayEvent).length, 0);
  }

  // 新 host / 新 workspace 的回放入口。三个判定都指向同一个结论：能回放就回放，否则发失效。
  // replayKey 含 hostId：同一批次会分别对每个 host 记账，不能用一个全局标记。
  // replayInitializedHostIds 只增不减：同一 host 对同一 run 只回放一次，避免 workspace 抖动导致重复流。
  private replayVisibleRunsToHost(hostId: string, workspaceKeys: Iterable<string>): void {
    const host = this.hosts.get(hostId);
    if (!host) {
      return;
    }
    const visible = new Set(workspaceKeys);
    for (const batch of this.streamBatches.values()) {
      if (!visible.has(batch.workspaceKey)) {
        continue;
      }
      // 键的四段与投递身份一致；少一段就会把不同 run 的初始化状态合并，导致漏发或重发。
      const replayKey = `${hostId}\u0000${batch.workspaceKey}\u0000${batch.taskId}\u0000${batch.runId}`;
      if (batch.replayInitializedHostIds.has(replayKey)) {
        continue;
      }
      batch.replayInitializedHostIds.add(replayKey);
      // 三种不可回放情形合并处理：已标记不可用、从未缓冲、首包不是 1（被裁剪过）。
      // 发失效时带 watermark：让消费端知道本地流缺到哪个 opSeq，快照回来后可据此判断是否还需要补流。
      if (batch.replayUnavailable || batch.replay.length === 0 || batch.replay[0]?.fromSeq !== 1) {
        this.deliverSnapshotInvalidation(
          this.batchToLeaseLike(batch),
          batch.ownerHostId,
          "stream_mirror_gap",
          hostId,
          this.getReplaySnapshotWatermark(batch),
        );
        continue;
      }
      for (const event of batch.replay) {
        host.child.postMessage({
          type: HostMessageTypes.TaskRealtimeDeliver,
          event: { ...event, originHostId: batch.ownerHostId, deliveryPurpose: "observer" },
        });
      }
    }
  }

  // 把批次投影成 lease 形状，只为复用 deliverSnapshotInvalidation 的字段拼装。
  // acquiredAt / updatedAt 用当前时间填充，不参与任何判断 —— 不要拿它做租约比较。
  private batchToLeaseLike(batch: PendingStreamBatch): TaskRunLease {
    return {
      key: this.getLeaseKey(batch.workspaceKey, batch.taskId),
      workspaceKey: batch.workspaceKey,
      workspacePath: batch.workspacePath,
      workspaceIdentity: batch.workspaceIdentity,
      taskId: batch.taskId,
      runId: batch.runId,
      traceId: batch.traceId,
      ownerClientId: batch.ownerClientId,
      ownerDeviceLabel: batch.ownerDeviceLabel,
      ownerHostId: batch.ownerHostId,
      acquiredAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  // 快照失效广播。eventId 带 Date.now()，意味着它不参与去重（同一 run 可以多次失效）；
  // deliverSnapshotInvalidation 不参与去重是刻意的：失效是「请重新拉」的提示，重复一次只是多拉一次快照，漏一次则永远停在旧状态。
  // onlyHostId 与 originHostId 是两个相反方向：指定 host 时只发它；未指定时发给除 origin 之外的所有可见 host。
  private deliverSnapshotInvalidation(
    lease: TaskRunLease,
    originHostId: string,
    reason: "stream_mirror_owner_lost" | "stream_mirror_gap",
    onlyHostId?: string,
    streamWatermark?: TaskStreamWatermark,
  ): void {
    this.deliverRealtimeEvent(
      {
        type: "task_snapshot_invalidated",
        eventId: `${reason}-${lease.workspaceKey}-${lease.taskId}-${lease.runId}-${Date.now()}`,
        workspacePath: lease.workspacePath,
        workspaceIdentity: lease.workspaceIdentity,
        workspaceKey: lease.workspaceKey,
        reason,
        traceId: lease.traceId,
        createdAt: Date.now(),
        taskId: lease.taskId,
        ...(streamWatermark ? { streamWatermark } : {}),
        originHostId,
      },
      // 默认排除 origin：发起失效的 host 通常已经知道自己状态，重复通知只会触发多余的快照拉取。
      (target) => (onlyHostId ? target.hostId === onlyHostId : target.hostId !== originHostId),
    );
  }

  // 水位取「最后一条已回放批次的 toSeq」；没有可回放批次时退到 nextOpSeq-1（即已分配的最大 seq）。
  private getReplaySnapshotWatermark(batch: PendingStreamBatch): TaskStreamWatermark {
    return {
      runId: batch.runId,
      opSeq: batch.replay.at(-1)?.toSeq ?? Math.max(batch.nextOpSeq - 1, 0),
    };
  }

  // 通用广播：shouldDeliver 决定「谁」（请求方/排除方），workspaceKeys 决定「能不能」。
  // 两个条件是与关系，缺 workspace 判断会把事件泄漏到无关窗口。
  private deliverRealtimeEvent(
    delivered: TaskRealtimeDeliveredEvent,
    shouldDeliver: (target: RegisteredRealtimeHost) => boolean,
  ): void {
    for (const target of this.hosts.values()) {
      if (!shouldDeliver(target) || !target.workspaceKeys.has(delivered.workspaceKey)) {
        continue;
      }
      target.child.postMessage({
        type: HostMessageTypes.TaskRealtimeDeliver,
        event: delivered,
      });
    }
  }

  // 跨 host 命令路由。三个前置失败分支顺序固定：无 lease → 陈旧 run → owner 进程已退出。
  // 三者回包 code 必须区分：调用方据此决定「重试 / 放弃 / 重新获取租约」。
  // [失败路径] 任一失败必须在同步阶段回包，不登记 pending，避免超时路径与即时失败重复回包。
  // requesterHostId 由总线注入（INV-14）：payload 里的同名字段一律被覆盖。
  private handleOwnerCommandRequest(
    requester: RegisteredRealtimeHost,
    command: TaskOwnerCommandRequest,
  ): void {
    const lease = this.leases.get(this.getLeaseKey(command.workspaceKey, command.taskId));
    if (!lease) {
      this.postOwnerCommandResult(requester.hostId, {
        commandRequestId: command.commandRequestId,
        success: false,
        error: "No active task owner.",
        code: "NO_ACTIVE_TASK_OWNER",
      });
      return;
    }
    // runId 不匹配即陈旧：命令发出后 task 已重启，继续投递给旧 owner 会作用在新 run 上。
    if (lease.runId !== command.runId) {
      this.postOwnerCommandResult(requester.hostId, {
        commandRequestId: command.commandRequestId,
        success: false,
        error: "Stale task owner command.",
        code: "STALE_TASK_OWNER_COMMAND",
      });
      return;
    }
    const owner = this.hosts.get(lease.ownerHostId);
    if (!owner) {
      this.postOwnerCommandResult(requester.hostId, {
        commandRequestId: command.commandRequestId,
        success: false,
        error: "No active task owner.",
        code: "NO_ACTIVE_TASK_OWNER",
      });
      return;
    }

    // 超时兜底：owner 进程卡死或不回包时，必须在 30s 后释放 requester，否则 UI 永远转圈。
    // 回调先删 pending 再回包：回包路径可能同步触发重试，先删可防止旧 timer 的双重失败。
    const timeout = setTimeout(() => {
      this.pendingOwnerCommands.delete(command.commandRequestId);
      this.postOwnerCommandResult(requester.hostId, {
        commandRequestId: command.commandRequestId,
        success: false,
        error: "Owner command timed out.",
        code: "OWNER_COMMAND_FAILED",
      });
    }, OWNER_COMMAND_TIMEOUT_MS);
    this.pendingOwnerCommands.set(command.commandRequestId, {
      commandRequestId: command.commandRequestId,
      requesterHostId: requester.hostId,
      ownerHostId: owner.hostId,
      createdAt: Date.now(),
      timeout,
    });

    // 投递前把 requesterHostId 写入命令副本：owner 回包时只需原样带回，
    // owner 不必自己维护「这个命令是谁问的」，原样带回 requesterHostId 即可。
    owner.child.postMessage({
      type: HostMessageTypes.TaskOwnerCommandDeliver,
      command: { ...command, requesterHostId: requester.hostId } satisfies TaskOwnerCommandDelivery,
    });
  }

  // owner 的回包。ownerHostId 必须与记录一致：否则任何 host 都能凭 commandRequestId 伪造他人的命令结果。
  private handleOwnerCommandResult(
    owner: RegisteredRealtimeHost,
    result: TaskOwnerCommandResult,
  ): void {
    const pending = this.pendingOwnerCommands.get(result.commandRequestId);
    if (!pending || pending.ownerHostId !== owner.hostId) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingOwnerCommands.delete(result.commandRequestId);
    this.postOwnerCommandResult(pending.requesterHostId, result);
  }

  // 目标 host 已注销时静默丢弃：此时它已收到进程退出，再投递只会失败。
  private postOwnerCommandResult(hostId: string, result: TaskOwnerCommandResult): void {
    this.hosts.get(hostId)?.child.postMessage({
      type: HostMessageTypes.TaskOwnerCommandResult,
      result,
    });
  }

  // 会话间消息转发。两个失败分支都「回 failed 而不是抛」：
  // handleSessionMessageSendRequested 不抛错：调用方在另一个进程里等待结果，抛错等于让它等到 30s 超时。
  // 目标 host 不存在时顺手删路由：路由表因此不会积累指向已退出 host 的条目。
  // 同一 requestId 重发时替换旧记录（INV-16）：重置计时器，避免旧超时把重试判死。
  private handleSessionMessageSendRequested(
    source: RegisteredRealtimeHost,
    request: SessionMessageRequest,
  ): void {
    // 路由是弱一致的：host 注册时由 SessionRouteAnnounce 写入，退出时批量删除。
    // 查不到只说明「本进程不知道」，不能证明 session 不存在。
    const targetHostId = this.sessionRoutes.get(request.toSessionId);
    if (!targetHostId) {
      this.postSessionMessageDeliveryResult(source.hostId, {
        error: `target session not found: ${request.toSessionId}`,
        messageId: request.messageId,
        requestId: request.requestId,
        sessionId: request.fromSessionId,
        status: "failed",
      });
      return;
    }

    const target = this.hosts.get(targetHostId);
    if (!target) {
      this.sessionRoutes.delete(request.toSessionId);
      this.postSessionMessageDeliveryResult(source.hostId, {
        error: `target host not found for session: ${request.toSessionId}`,
        messageId: request.messageId,
        requestId: request.requestId,
        sessionId: request.fromSessionId,
        status: "failed",
      });
      return;
    }

    // 同一个 requestId 的旧 timer 必须清掉再重新登记。只覆盖 Map 条目不 clearTimeout，
    // 会让旧 timer 在 30s 后删掉新记录并向 source 报失败。
    const existing = this.pendingSessionMessageDeliveries.get(request.requestId);
    if (existing) {
      clearTimeout(existing.timeout);
      this.pendingSessionMessageDeliveries.delete(request.requestId);
    }

    const timeout = setTimeout(() => {
      this.pendingSessionMessageDeliveries.delete(request.requestId);
      this.postSessionMessageDeliveryResult(source.hostId, {
        error: "Session message delivery timed out.",
        messageId: request.messageId,
        requestId: request.requestId,
        sessionId: request.fromSessionId,
        status: "failed",
      });
    }, SESSION_MESSAGE_DELIVERY_TIMEOUT_MS);
    this.pendingSessionMessageDeliveries.set(request.requestId, {
      request,
      sourceHostId: source.hostId,
      targetHostId: target.hostId,
      timeout,
    });

    target.child.postMessage({
      type: HostMessageTypes.SessionMessageDeliver,
      request,
    });
  }

  // 只接受 target 自己回报的结果：targetHostId 校验同时挡住伪造与串号。
  // requestId 是唯一关联键，messageId 不作为键 —— 一次重试可能换 messageId。
  private handleSessionMessageDeliverResult(
    target: RegisteredRealtimeHost,
    result: SessionMessageDeliveryResult,
  ): void {
    const pending = this.pendingSessionMessageDeliveries.get(result.requestId);
    if (!pending || pending.targetHostId !== target.hostId) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingSessionMessageDeliveries.delete(result.requestId);
    this.postSessionMessageDeliveryResult(pending.sourceHostId, result);
  }

  // source 已退出时静默丢弃，与 owner 命令回包同策略。
  private postSessionMessageDeliveryResult(
    hostId: string,
    result: SessionMessageDeliveryResult,
  ): void {
    this.hosts.get(hostId)?.child.postMessage({
      type: HostMessageTypes.SessionMessageDeliveryResult,
      result,
    });
  }

  // 按 host 反查 session 路由。sessionRoutes 没有反向索引，这里必须全表扫描；
  // 频率等于 host 退出次数，可接受。
  private unregisterSessionRoutesForHost(hostId: string): void {
    for (const [sessionId, routeHostId] of this.sessionRoutes) {
      if (routeHostId === hostId) {
        this.sessionRoutes.delete(sessionId);
      }
    }
  }

  // host 退出时的在途消息清理。source 或 target 任一命中都要删记录（否则永久泄漏）；
  // 只有 source 还活着才需要回失败 —— source 已死时回包对象不存在。
  private failPendingSessionMessagesForHost(hostId: string, error: string): void {
    const pendingDeliveries = Array.from(this.pendingSessionMessageDeliveries);
    for (const [requestId, pending] of pendingDeliveries) {
      // 双端过滤：source 死了要让 target 侧知道不必再回，target 死了要让 source 立刻失败。
      if (pending.sourceHostId !== hostId && pending.targetHostId !== hostId) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pendingSessionMessageDeliveries.delete(requestId);
      if (pending.sourceHostId !== hostId) {
        this.postSessionMessageDeliveryResult(pending.sourceHostId, {
          error,
          messageId: pending.request.messageId,
          requestId,
          sessionId: pending.request.fromSessionId,
          status: "failed",
        });
      }
    }
  }

  // 与命令超时同构：先 clearTimeout 再删条目，最后只向仍存活的 requester 回失败。
  // error 文案由调用方给（进程退出 vs 超时），code 统一为 OWNER_COMMAND_FAILED。
  private failPendingOwnerCommandsForHost(hostId: string, error: string): void {
    const pendingCommands = Array.from(this.pendingOwnerCommands);
    for (const [commandRequestId, pending] of pendingCommands) {
      // owner 退出要让 requester 立刻失败，而不是等 30s；requester 退出则静默清理。
      if (pending.ownerHostId !== hostId && pending.requesterHostId !== hostId) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pendingOwnerCommands.delete(commandRequestId);
      if (pending.requesterHostId !== hostId) {
        this.postOwnerCommandResult(pending.requesterHostId, {
          commandRequestId,
          success: false,
          error,
          code: "OWNER_COMMAND_FAILED",
        });
      }
    }
  }

  // 去重窗口实现：命中返回 false，未命中登记并返回 true。
  // Set 与数组必须同步推进；淘汰是 FIFO 而不是 LRU ——
  // 事件 id 没有「再访问」语义，LRU 只会增加无谓的 Map 操作。
  private rememberEventId(eventId: string): boolean {
    if (this.seenEventIds.has(eventId)) {
      return false;
    }

    this.seenEventIds.add(eventId);
    this.seenEventOrder.push(eventId);

    // 按条数淘汰，窗口大小由 seenEventLimit 配置：测试用小值验证淘汰分支，生产用 1000。
    while (this.seenEventOrder.length > this.seenEventLimit) {
      const removed = this.seenEventOrder.shift();
      if (removed) {
        this.seenEventIds.delete(removed);
      }
    }

    return true;
  }
}
