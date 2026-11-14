/* eslint-disable max-lines -- 三类 V4 topic 的同构 connection ownership 生命周期集中在单一 facade。 */
// V4 connection-scoped service facade：每个 RPC attachment 独立持有 subscription
// ownership；base service 仍只转发 CLI 事实，不在 host/main/relay 复制业务状态。
import { Emitter, Event as RpcEvent, type Event, type IDisposable } from "@zcode/rpc";
import {
  V4_WIRE_PROTOCOL_VERSION,
  clientHelloSchema,
  clientSupportsWorkflowRunDeltas,
  conversationTopic,
  sessionsIndexTopic,
  workspaceConfigTopic,
  type ConversationTopicWireCandidate,
  type HelloMessage,
  type SessionsIndexTopicWireCandidate,
  type V4ConnectionFlowState,
  type WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  IZCodeAgentService,
  ZCodeAgentConversationResyncParams,
  ZCodeAgentConversationUnsubscribeParams,
  ZCodeAgentRuntimePolicy,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";

// 两种交付语义：desktop-continuous 允许原生对话框与本地终端，
// web-remote-replayable 只消费可恢复的对话事实，不具备本地副作用能力。
// 该字段是连接事实，不允许某次订阅自行挑选。
export type ZCodeAgentV4ClientMode = "desktop-continuous" | "web-remote-replayable";

// 可信连接上下文：connectionId 标识一条 RPC attachment，
// role 区分终端客户端与 relay 中继，workflowRunDeltas/historyFirst 是握手协商出的能力位。
// 它只在 host 内部 carrier 上流动，永远不从 UI 入参读取。
export interface ZCodeAgentV4ConnectionContext {
  connectionId: string;
  clientMode: ZCodeAgentV4ClientMode;
  role?: "terminal-client" | "trusted-host-relay";
  /**
   * 这条连接的 clientHello 声明了认得 `workflowRun.*` 键级增量。与 `clientMode` 同族：
   * 由本 facade 从握手事实写出，订阅入参里的同名字段一律被清掉——一个客户端认不认得增量
   * 是**连接**的事实，不是某一次订阅可以自选的口味。缺席 = 按旧消费者处理。
   */
  workflowRunDeltas?: boolean;
  historyFirst?: boolean;
}

// 用双下划线前缀的私有字段承载可信上下文：
// 名字足够刺眼，且 withTrustedConnection 会先无条件删除它再写入真值，
// 因此外部即使拼出同名键也会被覆盖。
const TRUSTED_CONNECTION_FIELD = "__zcodeTrustedV4Connection";
// [并发] 退订/重同步需要精确路由到某一条 downstream 连接：
// 只带 subscriptionId 在 relay 场景会命中上游同名订阅；
// 这个字段由 facade 写入 topic + 命名空间化 connectionId，供 base 精确匹配。
const TRUSTED_UNSUBSCRIBE_ROUTE_FIELD = "__zcodeTrustedV4UnsubscribeRoute";

type TrustedConnectionCarrier = {
  [TRUSTED_CONNECTION_FIELD]?: ZCodeAgentV4ConnectionContext;
};

export interface TrustedZCodeAgentV4UnsubscribeRoute {
  topic: string;
  connectionId: string;
}

type TrustedUnsubscribeRouteCarrier = {
  [TRUSTED_UNSUBSCRIBE_ROUTE_FIELD]?: TrustedZCodeAgentV4UnsubscribeRoute;
};

// 读取器对畸形输入一律返回 null，不做部分接受：
// TRUSTED_UNSUBSCRIBE_ROUTE_FIELD 缺失任何一段就直接返回 null，不退化成用半份身份去匹配订阅。
export function readTrustedZCodeAgentV4UnsubscribeRoute(
  value: unknown,
): TrustedZCodeAgentV4UnsubscribeRoute | null {
  if (typeof value !== "object" || value === null) return null;
  const route = (value as TrustedUnsubscribeRouteCarrier)[TRUSTED_UNSUBSCRIBE_ROUTE_FIELD];
// topic 与 connectionId 必须同时是字符串，缺一即视为没有可信路由。
  if (!route || typeof route.topic !== "string" || typeof route.connectionId !== "string") {
    return null;
  }
  return route;
}

/**
 * 该字段只在 host facade → base/remote service proxy 之间传递；facade 会覆盖所有
 * UI 入参中的同名字段，因此 renderer/mobile 不能伪造可信连接模式。
 */
// [失败路径] 读取即校验：connectionId 非空、clientMode 必须是两个已知值之一，
// 否则返回 null。未知 clientMode 不能让调用方按 desktop 处理，
// 那会把本地副作用能力错误地授予远端连接。
export function readTrustedZCodeAgentV4Connection(
  value: unknown,
): ZCodeAgentV4ConnectionContext | null {
  if (typeof value !== "object" || value === null) return null;
  const context = (value as TrustedConnectionCarrier)[TRUSTED_CONNECTION_FIELD];
  if (!context || typeof context.connectionId !== "string") return null;
  if (
// [权衡] 这里刻意写成白名单而不是黑名单：新增模式必须先在此登记，
// 否则会被当作旧消费者拒绝，避免新能力被默认打开。
    context.clientMode !== "desktop-continuous" &&
    context.clientMode !== "web-remote-replayable"
  ) {
    return null;
  }
  return {
    connectionId: context.connectionId,
    clientMode: context.clientMode,
    // 只认 true：缺席与 false 都是「旧消费者」，键在场与否是下游读端的判据。
// 只认严格 true：false 与缺席都会被归一成「没有该字段」，
// 下游用键在场与否判断，而不是读布尔值。
    ...(context.workflowRunDeltas === true ? { workflowRunDeltas: true } : {}),
    ...(context.historyFirst === true ? { historyFirst: true } : {}),
  };
}

// [事务] 先复制入参，再逐个删除所有可伪造字段，最后写入 host 真值。
// 删除清单覆盖 connectionId/clientMode/deliveryProfile/subscriberScope 与两个能力位，
// 漏掉任何一个，renderer 就能自行声明连接身份或增量编码。
function withTrustedConnection<T extends object>(
  value: T,
  context: ZCodeAgentV4ConnectionContext,
): T {
  const forwarded: Record<string, unknown> = {
    ...(value as unknown as Record<string, unknown>),
  };
  // 共享 service 暴露在多个 RPC port 上时，调用方曾能传 profile，且所有
  // port 共用 workspace fan-out。facade 必须先清掉所有可伪造字段，再写 host 真值。
  delete forwarded[TRUSTED_CONNECTION_FIELD];
  delete forwarded["connectionId"];
  delete forwarded["clientMode"];
  delete forwarded["deliveryProfile"];
// subscriberScope 决定 CLI 侧订阅替换粒度，由 host 按 attachment 生成；
// 允许调用方传入会让两个 UI 消费者互相顶掉订阅。
  delete forwarded["subscriberScope"];
  // 与 clientMode 同族的可信位：UI 面的 subscribe 不能自己挑增量编码。
  delete forwarded["workflowRunDeltas"];
  delete forwarded["historyFirst"];
  forwarded[TRUSTED_CONNECTION_FIELD] = context;
  return forwarded as T;
}

// 与 withTrustedConnection 同构：先删同名键再写入，
// 保证下游 facade 的 route 不会被上游残留值污染。
function withTrustedUnsubscribeRoute<T extends object>(
  value: T,
  route: TrustedZCodeAgentV4UnsubscribeRoute,
): T {
  const forwarded = {
    ...(value as unknown as Record<string, unknown>),
  };
  delete forwarded[TRUSTED_UNSUBSCRIBE_ROUTE_FIELD];
  forwarded[TRUSTED_UNSUBSCRIBE_ROUTE_FIELD] = route;
  return forwarded as T;
}

// workspaceIdentity 优先：同一路径在不同来源下需要区分时由 identity 表达；
// trim 后为空视同未提供，回落到路径。
function workspaceKey(target: ZCodeAgentWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function workspaceTarget(target: ZCodeAgentWorkspaceTarget): ZCodeAgentWorkspaceTarget {
  return {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  };
}

type SubscriptionKind = "conversation" | "sessions-index" | "workspace-config";

// [状态归属] 一条已确认订阅的全部路由事实：kind/topic/connectionId 三元组
// 决定帧归属与退订参数，ownershipKey 用于同 method+workspace+topic 的替换。
// subscriptionId 是 CLI 侧标识，只在 ACK 之后才存在。
interface OwnedSubscription {
  kind: SubscriptionKind;
  ownershipKey: string;
  subscriptionId: string;
  topic: string;
  connectionId: string;
  clientMode: ZCodeAgentV4ClientMode;
  target: ZCodeAgentWorkspaceTarget;
}

interface ConnectionFlowRoute {
  key: string;
  target: ZCodeAgentWorkspaceTarget;
  connection: ZCodeAgentV4ConnectionContext;
}

type RoutedTopicFrame =
  | ConversationTopicWireCandidate
  | SessionsIndexTopicWireCandidate
  | WorkspaceConfigTopicWireCandidate;

// ACK 之前的占位 owner：暂存早到的通知帧，并记录起始 runtime 代际。
// stagedBytes 与 overflowReason 让溢出成为显式失败而不是静默截断。
// invalidatedByRuntimeRestart 标记该占位已随旧 runtime 失效。
interface PendingOwnership {
  kind: SubscriptionKind;
  target: ZCodeAgentWorkspaceTarget;
  topic: string;
  frames: RoutedTopicFrame[];
  stagedBytes: number;
  overflowReason: string | null;
  runtimeGeneration: number;
  invalidatedByRuntimeRestart: boolean;
}

interface RoutedFrameEvent {
  emitter: Emitter<RoutedTopicFrame>;
  upstream: IDisposable;
}

// ACK 窗口只覆盖控制面竞态，不替代 subscriber buffer/resync。这里按帧数和
// JSON 字节双限额暂存，避免异常 peer 在 subscribe pending 期间无限占用 host 内存。
// 与 task-index 用同一组限额：条数挡海量小帧，字节挡单帧大载荷；
// 超限必须整批作废，不能只丢最旧帧。
const MAX_PENDING_OWNERSHIP_FRAMES = 1_024;
const MAX_PENDING_OWNERSHIP_BYTES = 32 * 1024 * 1024;
// downstream 连接 id 来自 relay 下游，属于跨进程输入：
// 限制长度避免超长 id 被拼进路由键后放大内存与日志。
const MAX_DOWNSTREAM_CONNECTION_ID_LENGTH = 256;

// 空串与超长 id 都在入口拒绝，错误码固定供上层映射。
// 这里不做字符白名单：id 是 opaque 路由键，长度与空白是唯一可判定的边界。
function assertConnectionId(connectionId: string): void {
  if (
    connectionId.trim().length === 0 ||
    connectionId.length > MAX_DOWNSTREAM_CONNECTION_ID_LENGTH
  ) {
    throw new Error("fault.connection.invalidConnectionId");
  }
}

// relay 场景把上下游 id 合成一个全局唯一键，
// 长度前缀消除分隔符歧义，保证不同组合不会拼出同一字符串。
function namespaceRelayConnectionId(
  upstreamConnectionId: string,
  downstreamConnectionId: string,
): string {
  // 长度前缀消除 `a/b + c` 与 `a + b/c` 这类分隔符碰撞；connectionId 只作
  // opaque route key，不需要业务层解析。
  return `relay:${upstreamConnectionId.length}:${upstreamConnectionId}${downstreamConnectionId.length}:${downstreamConnectionId}`;
}

// 用重编码长度近似线上体积：只服务背压阈值，不要求精确；
// 与 task-index 的计量方式保持一致，便于统一调参。
function frameBytes(frame: RoutedTopicFrame): number {
  return new TextEncoder().encode(JSON.stringify(frame)).byteLength;
}

// clientMode 到 deliveryProfile 的映射是协议契约的一部分：
// 两者不能各自扩展，否则握手里的能力声明与交付语义会互相矛盾。
function deliveryProfileFor(clientMode: ZCodeAgentV4ClientMode): HelloMessage["deliveryProfile"] {
  return clientMode === "desktop-continuous" ? "continuous" : "replayable";
}

// hello 声明本 Host 支持的能力集合；capabilities 是 .strict() 的，
// 老 Host 见到未知字段会握手失败，因此新增能力必须两端同步升级。
// serverTime 只作为时钟参考，不参与任何超时判定。
function createHello(context: ZCodeAgentV4ConnectionContext): HelloMessage {
  const continuous = context.clientMode === "desktop-continuous";
  return {
    kind: "hello",
    protocolVersion: V4_WIRE_PROTOCOL_VERSION,
    connectionId: context.connectionId,
    clientMode: context.clientMode,
    deliveryProfile: deliveryProfileFor(context.clientMode),
    serverTime: Date.now(),
    capabilities: {
// 原生对话框与本地终端只在 continuous（桌面）连接上声明：
// replayable 客户端没有本地副作用宿主，声明了也无法执行。
      nativeDialogs: continuous,
      localTerminal: continuous,
      binaryFrames: false,
      compression: "none",
      workspaceHookReview: true,
      independentPlanState: true,
      // 本 Host 会转发 `workflowRun.*` 键级增量；客户端见到它才能在 clientHello 里回声明
      // （那个 capabilities 是 .strict() 的，反过来会让老 Host 握不上手）。
// 本 Host 会转发键级增量，所以两边能力位都声明 true；
// 客户端必须回声明后才能收到增量编码，缺席按旧消费者处理。
      workflowRunDeltas: true,
      historyFirst: true,
    },
    auth: {},
  };
}

// 单个 attachment 的 facade 对外只有三项：可信 service、传输流控、释放。
// setTransportFlowState 只走 MessagePort/transport sideband，不是 UI RPC。
export interface ZCodeAgentConnectionScope {
  readonly service: IZCodeAgentService;
  /** MessagePort/transport sideband only；不是 UI-facing RPC。 */
  setTransportFlowState(state: V4ConnectionFlowState): Promise<void>;
  dispose(): Promise<void>;
}

/** 为单个 host/server RPC attachment 建立可信 V4 facade。 */
// 组装点：校验连接 id、初始化所有权表与握手状态，返回 Proxy 包装后的 service。
// 所有方法的可信字段都在这里注入，base service 只面对已净化的入参。
export function createZCodeAgentConnectionScope(
  base: IZCodeAgentService,
  context: ZCodeAgentV4ConnectionContext,
): ZCodeAgentConnectionScope {
  assertConnectionId(context.connectionId);
  const role = context.role ?? "terminal-client";
// 四张路由表各司其职：owned 是已确认订阅，routeKeyByOwnership 支撑替换，
// pendingByOwnership 存 ACK 前占位，routedFrameEvents 复用上游事件订阅。
// 任何一张表泄漏都会让帧投递到已释放的连接上。
  const owned = new Map<string, OwnedSubscription>();
  const routeKeyByOwnership = new Map<string, string>();
// 同一 ownershipKey 允许并存多个 pending：
// 同 topic 的两次 subscribe 在 ACK 前无法判断早到帧属于谁，只能都暂存。
  const pendingByOwnership = new Map<string, Set<PendingOwnership>>();
  const routedFrameEvents = new Map<string, RoutedFrameEvent>();
// [状态归属] 每个 workspace 的 runtime 代际：订阅占位创建时快照，
// ACK 回来后比对。它只增不减，unavailable 与 restarted 两条链路都推进同一份计数，
// 避免两种事件交替到达时出现代际回退。
  const runtimeGenerationByWorkspaceKey = new Map<string, number>();
  let disposed = false;
  // trusted relay 已在外层 transport（stdio / Node-only WS role header）完成身份
  // 选择；终端 UI 仍必须走 hello → clientHello。
// [权衡] trusted relay 已完成外层身份选择，跳过 hello/clientHello；
// 终端 UI 必须完整走握手，否则会拿到一个未协商能力的 facade。
// helloIssued 与 handshakeComplete 分开，是为了区分「没发 hello」与「发了没初始化」。
  let handshakeComplete = role === "trusted-host-relay";
  let helloIssued = role === "trusted-host-relay";
  let boundClientId: string | null = null;
  /** clientHello 里的增量声明；trusted relay 没有自己的 clientHello，只搬运下游的。 */
  let clientWorkflowRunDeltas = false;
  let clientHistoryFirst = false;
// 一条 attachment 只允许查询一个 workspace 的命令队列：
// 首次查询绑定，后续跨 workspace 直接拒绝，防止连接身份被复用。
  let commandQueryWorkspaceKey: string | null = null;
  let currentTransportFlowState: V4ConnectionFlowState = "drained";
  let flowClosed = false;
// [并发] 流控状态更新必须串行：SAT→DRN→closed 的顺序即语义，
// 并发下发会让上游看到 DRN 早于 SAT。单次失败不打断后续，
// 但该次调用仍会收到 rejection。
  let flowUpdateChain = Promise.resolve();
// 每个下游 route 最近一次成功下发的流控状态：既用于去重，
// 也用于 closed 之后清账。键里必须含 connectionId，
// 否则同一 workspace 的多个 relay 下游会互相覆盖状态。
  const forwardedFlowStateByRoute = new Map<string, V4ConnectionFlowState>();
  /** attachment 曾触及的 workspace route 留到 port dispose，保证无 subscription 也能 trusted closed。 */
// [资源] 记录 attachment 触及过的 route，即使订阅已全部退订也要保留到 dispose：
// 否则 relay 无法对这条连接补发 closed，上游会一直以为它还在传输。
  const attachmentFlowRoutes = new Map<string, ConnectionFlowRoute>();

// [并发] 计算本次调用要下发的可信连接：relay 用下游声明的身份 + 命名空间 id，
// 终端客户端用本 attachment 的 connectionId 与握手协商出的能力位。
// relay 自己不消费帧，所以增量位永远取自下游。
  const forwardedConnection = (params: unknown): ZCodeAgentV4ConnectionContext => {
    const downstream = readTrustedZCodeAgentV4Connection(params);
    if (role === "trusted-host-relay" && downstream) {
      assertConnectionId(downstream.connectionId);
      return {
        connectionId: namespaceRelayConnectionId(context.connectionId, downstream.connectionId),
        clientMode: downstream.clientMode,
        // 增量位属于**下游那一端**：relay 自己不消费帧，只把下游 clientHello 的声明带上去。
        ...(downstream.workflowRunDeltas === true ? { workflowRunDeltas: true } : {}),
        ...(downstream.historyFirst === true ? { historyFirst: true } : {}),
      };
    }
    return {
      connectionId: context.connectionId,
      clientMode: context.clientMode,
      ...(clientWorkflowRunDeltas ? { workflowRunDeltas: true } : {}),
      ...(clientHistoryFirst ? { historyFirst: true } : {}),
    };
  };

  const assertOpen = () => {
    if (disposed) throw new Error("fault.connection.closed");
  };
// 两级守卫：已释放优先于未握手，错误码不同，调用方可据此决定重连还是重试。
  const assertReady = () => {
    assertOpen();
    if (!handshakeComplete) throw new Error("fault.connection.handshakeRequired");
  };
// 四个键的职责不同：routeKey 唯一标识一条已确认订阅，ownershipKey 标识
// 「同 kind + workspace + topic」这一替换单元，routedEventKey 用于复用上游事件订阅，
// flowRouteKey 用于流控路由。用 \0 分隔避免 workspace 路径里的 / 造成歧义。
  const routeKey = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    topic: string,
    subscriptionId: string,
    connectionId: string,
  ) => `${kind}\0${workspaceKey(target)}\0${topic}\0${subscriptionId}\0${connectionId}`;
  const ownershipKey = (kind: SubscriptionKind, target: ZCodeAgentWorkspaceTarget, topic: string) =>
    `${kind}\0${workspaceKey(target)}\0${topic}`;
  const routedEventKey = (kind: SubscriptionKind, target: ZCodeAgentWorkspaceTarget) =>
    `${kind}\0${workspaceKey(target)}`;
  const flowRouteKey = (target: ZCodeAgentWorkspaceTarget, connectionId: string) =>
    `${workspaceKey(target)}\0${connectionId}`;
// 从订阅条目反推出流控路由：connectionId 取自条目而不是当前 attach，
// 这样 relay 的多下游连接能各自收到自己的 closed。
  const flowRouteForEntry = (entry: OwnedSubscription): ConnectionFlowRoute => ({
    key: flowRouteKey(entry.target, entry.connectionId),
    target: entry.target,
    connection: {
      connectionId: entry.connectionId,
      clientMode: entry.clientMode,
    } satisfies ZCodeAgentV4ConnectionContext,
  });
// 当前需要感知流控的路由集合 = 历史触及过的 route ∪ 当前所有订阅的 route；
// 前者保证订阅退光后仍能补发 closed，后者保证新订阅立即可见。
  const currentFlowRoutes = () => {
    const routes = new Map<string, ConnectionFlowRoute>(attachmentFlowRoutes);
    for (const entry of owned.values()) {
      const route = flowRouteForEntry(entry);
      routes.set(route.key, route);
    }
    return routes;
  };
// [并发] 幂等转发：同一 route 已处于目标状态就跳过，避免 SAT 边缘抖动时
// 反复下发同值。只有 RPC 成功后才记状态，失败保持在旧值以便重试。
  const forwardFlowRoute = async (
    route: ConnectionFlowRoute,
    state: V4ConnectionFlowState,
  ): Promise<void> => {
// 去重是必要的：上游按状态变化驱动暂停/恢复，重复的 SAT 会被当成新的高水位。
    if (forwardedFlowStateByRoute.get(route.key) === state) return;
    await base.setConnectionFlowStateV4(
      withTrustedConnection(
        {
          ...workspaceTarget(route.target),
          state,
        },
        route.connection,
      ),
    );
// 写在 await 之后：失败时保持旧状态，下一次调用仍会重发。
    forwardedFlowStateByRoute.set(route.key, state);
  };
// 把 transport 级状态扇出到所有已知 route。closed 是终态，
// 一旦进入就不再接受其它状态，避免关闭后又被 SAT 复活。
  const applyTransportFlowState = async (state: V4ConnectionFlowState): Promise<void> => {
// 终态单向：closed 之后的任何非 closed 状态都必须丢弃。
    if (flowClosed && state !== "closed") return;
    currentTransportFlowState = state;
    if (state === "closed") flowClosed = true;
    for (const route of currentFlowRoutes().values()) {
      await forwardFlowRoute(route, state);
    }
  };
// [并发] 串行队列：每次更新挂在上一次之后执行，保证 SAT→DRN→closed 的提交顺序。
// 队列本身吞掉错误以免阻断后续，但返回给调用方的 promise 仍保留 rejection。
  const enqueueTransportFlowState = (state: V4ConnectionFlowState): Promise<void> => {
    if (disposed || (flowClosed && state !== "closed")) return Promise.resolve();
    const update = flowUpdateChain.then(() => applyTransportFlowState(state));
    // 快速 SAT→DRN 与 close 必须保持提交顺序；单次 RPC 失败不能打断后续
    // close 清理，但调用方仍会收到该次 update 的 rejection。
// 只为队列续命而吞错，与返回给调用方的 update 是两条独立链路。
    flowUpdateChain = update.catch(() => {});
    return update;
  };
// 新订阅 ACK 时若 transport 已饱和，必须立刻补发一次 SAT：
// 高水位边缘事件早已过去，等下一次会让下游持续收帧而不暂停。
  const syncCurrentFlowForEntry = async (entry: OwnedSubscription): Promise<void> => {
    if (currentTransportFlowState !== "saturated") return;
    await forwardFlowRoute(flowRouteForEntry(entry), "saturated");
  };
// [并发] 退订后如果该 route 已无任何订阅，就向 base 补发 closed 并清账；
// 顺序必须是先 closed 再 unsubscribe，反序会让上游先忘掉 owner，closed 被拒后留下 paused 连接。
  const closeUnusedFlowRoute = async (entry: OwnedSubscription): Promise<void> => {
    const route = flowRouteForEntry(entry);
    if (currentFlowRoutes().has(route.key)) return;
    if (forwardedFlowStateByRoute.has(route.key)) {
      await forwardFlowRoute(route, "closed");
      forwardedFlowStateByRoute.delete(route.key);
    }
  };
// [事务] 登记新订阅时按 ownershipKey 顶替旧条目：同 method+workspace+topic 只保留最后一次，
// 这与 CLI 侧「同 connection 同 topic 新订阅替换旧订阅」的语义一致。
// 旧 key 必须从 owned 删除，否则会留下一个永远不会被退订的幽灵 owner。
  const remember = (subscriptionId: string, entry: OwnedSubscription): void => {
    const key = routeKey(entry.kind, entry.target, entry.topic, subscriptionId, entry.connectionId);
// 只删旧 key 不删旧 route 映射：映射即将被新 key 覆盖，无需单独清理。
    const previous = routeKeyByOwnership.get(entry.ownershipKey);
    if (previous) owned.delete(previous);
    routeKeyByOwnership.set(entry.ownershipKey, key);
    owned.set(key, entry);
  };
// 退订/重同步的解析入口：终端 UI 只传 subscriptionId，
// relay 额外带可信 route。匹配数不为 1 时一律返回 null，
// 宁可报 notOwned 也不猜一个可能属于别的连接的订阅。
  const findBySubscription = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    subscriptionId: string,
    expectedRoute: TrustedZCodeAgentV4UnsubscribeRoute | null,
  ): OwnedSubscription | null => {
    const expectedWorkspaceKey = workspaceKey(target);
    const matches = [...owned.values()].filter(
      (entry) =>
        entry.kind === kind &&
        entry.subscriptionId === subscriptionId &&
        workspaceKey(entry.target) === expectedWorkspaceKey &&
        (!expectedRoute ||
          (entry.topic === expectedRoute.topic &&
            entry.connectionId === expectedRoute.connectionId)),
    );
    // terminal UI 只传 subId；若它在同 method/workspace 内碰撞，宁可拒绝猜测。
    // trusted relay 则使用下游 facade 写入的 topic/connection 精确命中。
// [权衡] 歧义即拒绝：多命中说明同 workspace 内 id 碰撞，
// 任选一个都可能退订掉别的客户的订阅。
    return matches.length === 1 ? matches[0]! : null;
  };
// 帧归属判定必须同时匹配 kind、subscriptionId、topic 与 workspace：
// 少任何一维，relay 上下游同名订阅都会互相串帧。
  const ownsFrame = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    frame: { subscriptionId: string; topic: string },
  ) => {
    const expectedWorkspaceKey = workspaceKey(target);
    return [...owned.values()].some(
      (entry) =>
        entry.kind === kind &&
        entry.subscriptionId === frame.subscriptionId &&
        entry.topic === frame.topic &&
        workspaceKey(entry.target) === expectedWorkspaceKey,
    );
  };
// 只有 trusted relay 才读取下游 route；终端客户端传什么都不认，
// 防止 UI 通过伪造 route 影响匹配结果。
  const forwardedUnsubscribeRoute = (
    params: unknown,
  ): TrustedZCodeAgentV4UnsubscribeRoute | null => {
    if (role !== "trusted-host-relay") return null;
    const downstream = readTrustedZCodeAgentV4UnsubscribeRoute(params);
    if (!downstream) return null;
    assertConnectionId(downstream.connectionId);
    return {
      topic: downstream.topic,
      connectionId: namespaceRelayConnectionId(context.connectionId, downstream.connectionId),
    };
  };
// ACK 前先占位：捕获当前 runtime 代际，后续据它识别旧 runtime 的迟到 ACK。
// 同一 ownershipKey 允许多个占位并存，因为早到帧无法在 ACK 前区分归属。
  const beginPendingOwnership = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    topic: string,
  ): PendingOwnership => {
    const pending: PendingOwnership = {
      kind,
      target: workspaceTarget(target),
      topic,
      frames: [],
      stagedBytes: 0,
      overflowReason: null,
// 代际缺省为 0：尚未观察过任何 runtime 事件的 workspace 视为初代。
      runtimeGeneration: runtimeGenerationByWorkspaceKey.get(workspaceKey(target)) ?? 0,
      invalidatedByRuntimeRestart: false,
    };
    const key = ownershipKey(kind, target, topic);
    const group = pendingByOwnership.get(key) ?? new Set<PendingOwnership>();
    group.add(pending);
    pendingByOwnership.set(key, group);
    return pending;
  };
// 组内清空后删除整组键，避免空 Set 长期占位。
  const removePendingOwnership = (pending: PendingOwnership): void => {
    const key = ownershipKey(pending.kind, pending.target, pending.topic);
    const group = pendingByOwnership.get(key);
    group?.delete(pending);
    if (group?.size === 0) pendingByOwnership.delete(key);
  };
  const discardPendingOwnership = (pending: PendingOwnership): void => {
    removePendingOwnership(pending);
    pending.frames.length = 0;
    pending.stagedBytes = 0;
    pending.overflowReason = null;
  };
// [资源] stageFrame 在 overflowReason 非空或 invalidatedByRuntimeRestart 时直接返回，不再接收新帧，
// 已经溢出或失效的占位再收帧既不生效，也让 pending.stagedBytes 继续增长。
  const stageFrame = (pending: PendingOwnership, frame: RoutedTopicFrame): void => {
    if (pending.overflowReason || pending.invalidatedByRuntimeRestart) return;
    const bytes = frameBytes(frame);
    if (
// [失败路径] 溢出必须整批清空并显式失败：只丢最旧帧会让一个 logical frame
// 永久缺片，下游永远无法拼出完整状态且不会收到任何错误。
      pending.frames.length + 1 > MAX_PENDING_OWNERSHIP_FRAMES ||
      pending.stagedBytes + bytes > MAX_PENDING_OWNERSHIP_BYTES
    ) {
      // 旧 ACK staging 超限时 shift 最旧帧，会把一个
      // logical frame 变成永久缺片。溢出必须清空整批并显式失败。
      pending.frames.length = 0;
      pending.stagedBytes = 0;
// 记录原因而不是立即抛：ACK 到达时由 rememberAfterSubscribe 统一失败，
// 这样能保证先向 CLI 退订再报错，不留悬挂订阅。
      pending.overflowReason = "fault.subscription.initialFrameStagingOverflow";
      return;
    }
    pending.frames.push(frame);
    pending.stagedBytes += bytes;
  };
// 帧路由两条路：已有 owner 直接投递给该 attachment 的 emitter，
// 否则按 ownershipKey 找到所有暂存区并逐个 stage。
// 顺序即语义：CLI 通知可能早于 subscribe 应答到达，必须先暂存后回放。
  const routeIncomingFrame = (
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    frame: RoutedTopicFrame,
    emitter: Emitter<RoutedTopicFrame>,
  ): void => {
// 已确认订阅优先，保证回放阶段不会把同一帧再塞进暂存区。
    if (ownsFrame(kind, target, frame)) {
      emitter.fire(frame);
      return;
    }
    const group = pendingByOwnership.get(ownershipKey(kind, target, frame.topic));
    if (!group) return;
    for (const pending of group) stageFrame(pending, frame);
  };
// [资源] 每个 kind+workspace 只向上游订阅一次，再本地扇出：
// 每次调用都新建监听会在多 attachment 场景下重复订阅同一事件源。
// 首个订阅者创建时同时记录 upstream disposable，dispose 时统一释放。
  const routedEvent = <T extends RoutedTopicFrame>(
    kind: SubscriptionKind,
    target: ZCodeAgentWorkspaceTarget,
    source: Event<T>,
  ): Event<T> => {
    const key = routedEventKey(kind, target);
    let route = routedFrameEvents.get(key);
    if (!route) {
      const emitter = new Emitter<RoutedTopicFrame>();
      route = {
        emitter,
        upstream: source((frame) => routeIncomingFrame(kind, target, frame, emitter)),
      };
      routedFrameEvents.set(key, route);
    }
    return route.emitter.event as Event<T>;
  };
// 只摘本地账：不触碰 CLI 订阅，退订由 unsubscribeBase 单独负责；
// routeKeyByOwnership 仅在仍指向本条时才删除，避免误删已被顶替的新条目。
  const forget = (entry: OwnedSubscription): void => {
    const key = routeKey(
      entry.kind,
      entry.target,
      entry.topic,
      entry.subscriptionId,
      entry.connectionId,
    );
    owned.delete(key);
    if (routeKeyByOwnership.get(entry.ownershipKey) === key) {
      routeKeyByOwnership.delete(entry.ownershipKey);
    }
  };
// 三类 topic 的退订只差一个方法名，参数结构相同；
// 这里统一注入可信 route，让 base 能精确匹配到本 attachment 的订阅。
  const unsubscribeBase = (
    entry: OwnedSubscription,
    runtimePolicy?: ZCodeAgentRuntimePolicy,
  ): Promise<void> => {
    const params: ZCodeAgentConversationUnsubscribeParams = {
      ...entry.target,
      subscriptionId: entry.subscriptionId,
      ...(runtimePolicy ? { runtimePolicy } : {}),
    };
    const forwarded = withTrustedUnsubscribeRoute(params, {
      topic: entry.topic,
      connectionId: entry.connectionId,
    });
    switch (entry.kind) {
      case "conversation":
        return base.unsubscribeConversationV4(forwarded);
      case "sessions-index":
        return base.unsubscribeSessionsIndexV4(forwarded);
      case "workspace-config":
        return base.unsubscribeWorkspaceConfigV4(forwarded);
    }
  };
// [并发] 先 forget 再清流控：本地账立即失效，迟到帧不会再投递；
// finally 保证即使 closed 失败也一定发出 unsubscribe，不留下暂停连接。
  const unsubscribeOwnedEntry = async (
    entry: OwnedSubscription,
    runtimePolicy?: ZCodeAgentRuntimePolicy,
  ): Promise<void> => {
    forget(entry);
    try {
      // trusted relay 以 owned route 校验 flow control。最后一个 subscription
      // 必须先 closed 再 unsubscribe；反序会让上游先忘 owner，closed 被拒绝后留下 paused connection。
// 必须在退订之前执行，原因见 closeUnusedFlowRoute 的顺序约束。
      await closeUnusedFlowRoute(entry);
    } finally {
      await unsubscribeBase(entry, runtimePolicy);
    }
  };
  const resyncBase = (entry: OwnedSubscription, params: ZCodeAgentConversationResyncParams) => {
    const forwarded = withTrustedUnsubscribeRoute(params, {
      topic: entry.topic,
      connectionId: entry.connectionId,
    });
    switch (entry.kind) {
      case "conversation":
        return base.resyncConversationV4(forwarded);
      case "sessions-index":
        return base.resyncSessionsIndexV4(forwarded);
      case "workspace-config":
        return base.resyncWorkspaceConfigV4(forwarded);
    }
  };
// 重同步不新建 owner，只允许已登记订阅发起：
// 未持有的 subscriptionId 一律拒绝，避免借重同步探测他人订阅。
  const resyncOwned = (kind: SubscriptionKind, params: ZCodeAgentConversationResyncParams) => {
    assertReady();
    const entry = findBySubscription(
      kind,
      params,
      params.subscriptionId,
      forwardedUnsubscribeRoute(params),
    );
    if (!entry) return Promise.reject(new Error("fault.subscription.notOwned"));
    return resyncBase(entry, params);
  };
// [事务] ACK 后的五步收口，任何一步失败都要把已建立的 CLI 订阅退掉：
// 解析占位 → 校验 runtime 代际 → 校验关闭/溢出 → 登记 owner → 同步流控/回放早到帧。
// 顺序不可调换，否则会留下没有本地 owner 的 CLI 订阅。
  const rememberAfterSubscribe = async (
    subscriptionId: string,
    entry: Omit<OwnedSubscription, "subscriptionId">,
    pending: PendingOwnership,
  ): Promise<void> => {
    removePendingOwnership(pending);
    const complete = { ...entry, subscriptionId };
    if (
// [并发] 旧 runtime 的迟到 ACK 可能与新 runtime 复用同一 subId：
// 这里只丢本地占位，绝不能向新 runtime 反向退订同名订阅。
      pending.invalidatedByRuntimeRestart ||
      pending.runtimeGeneration !==
        (runtimeGenerationByWorkspaceKey.get(workspaceKey(entry.target)) ?? 0)
    ) {
      // 旧 runtime 的迟到 ACK 可能与新 runtime 复用同一 subId。
      // 这里只丢本地 owner，绝不能向新 runtime 反向 unsubscribe 同名 subscription。
      discardPendingOwnership(pending);
      throw new Error("fault.subscription.runtimeRestarted");
    }
    if (disposed) {
      // port close 与 subscribe ACK 可并发；迟到 ACK 不能在已关闭 facade
      // 重新登记 owner，必须立即反向 unsubscribe。
      discardPendingOwnership(pending);
      await unsubscribeBase(complete).catch(() => {});
      throw new Error("fault.connection.closed");
    }
// 溢出失败也要先退订：CLI 侧订阅已经建立，不退就会持续推送一个无人消费的 topic。
    if (pending.overflowReason) {
      const reason = pending.overflowReason;
      discardPendingOwnership(pending);
      await unsubscribeBase(complete).catch(() => {});
      throw new Error(reason);
    }
    remember(subscriptionId, complete);
    try {
      // 当前 transport 已 saturated 时，订阅 ACK 才让 trusted downstream route 成为事实；
      // 必须在此补发一次 SAT，不能等待下一个 high-water edge。
// [失败路径] 流控同步失败必须回滚刚登记的 owner 并退订：
// 否则下游以为连接是 drained，实际上 CLI 正在按饱和状态压帧。
      await syncCurrentFlowForEntry(complete);
    } catch (error) {
      forget(complete);
      await unsubscribeBase(complete).catch(() => {});
      throw error;
    }
    const route = routedFrameEvents.get(routedEventKey(entry.kind, entry.target));
    if (!route) return;
    // CLI notification 可能先于 RPC subscribe response 抵达 host。旧实现
    // 直到 await 返回才登记 owner，早帧会被永久丢弃；同 topic 双端 pending 时也不能
    // 猜 owner。ACK 后只释放 ACK subscriptionId 对应帧，保留原到达顺序。
// 只回放 ACK subscriptionId 匹配且已被本次 owner 接管的帧：
// 同 topic 双端 pending 时，另一条订阅的早到帧必须继续留在它的占位里，
// 不能因为先到的 ACK 被错投。
    for (const frame of pending.frames) {
      if (frame.subscriptionId === subscriptionId && ownsFrame(entry.kind, entry.target, frame)) {
        route.emitter.fire(frame);
      }
    }
    pending.frames.length = 0;
    pending.stagedBytes = 0;
  };

// [并发] runtime 失效时的统一清理：推进代际、摘本地 owner、清流控账、作废占位。
// 不向新 runtime 发任何退订——旧订阅在进程退出时已经消失，
// 向新进程发同名退订反而可能误伤同 id 的新订阅。
  const invalidateWorkspaceRuntime = (invalidatedWorkspaceKey: string, generation: number) => {
    runtimeGenerationByWorkspaceKey.set(invalidatedWorkspaceKey, generation);
    // runtime 内 subscription 已全部消失；本地 owner 直接 forget，不向新 runtime 清理。
    for (const entry of owned.values()) {
      if (workspaceKey(entry.target) === invalidatedWorkspaceKey) forget(entry);
    }
    for (const key of forwardedFlowStateByRoute.keys()) {
      if (key.startsWith(`${invalidatedWorkspaceKey}\0`)) {
        forwardedFlowStateByRoute.delete(key);
      }
    }
    const invalidatedPending = [...pendingByOwnership.values()]
      .flatMap((group) => [...group])
      .filter((pending) => workspaceKey(pending.target) === invalidatedWorkspaceKey);
    for (const pending of invalidatedPending) {
// [资源] 先标失效再摘组：旧 ACK 可能永不到达，
// 留在路由组里会让新 runtime 的每一帧都往这个死占位里堆。
// 对象仍被原 promise 的 continuation 持有，可据代际拒绝迟到 ACK。
      pending.invalidatedByRuntimeRestart = true;
      // 从 routing group 摘除，避免旧 ACK 永不到达时继续为新 runtime 每帧积压；
      // pending 对象仍由原 Promise continuation 持有，可据 generation 拒绝迟到 ACK。
      removePendingOwnership(pending);
      pending.frames.length = 0;
      pending.stagedBytes = 0;
    }
  };

// [权衡] 优先用 lifecycle 事件（available/unavailable），旧 base 才退回 restarted 事件；
// 仅监听 restart 时，runtime 退出但未重启会留下旧 owner，
// 后续 UI 清理会重建退订参数并走启动型 client，把已退出的进程重新拉起。
  const hasRuntimeLifecycle = Boolean(base.onAgentRuntimeLifecycle);
  const runtimeLifecycleDisposable = base.onAgentRuntimeLifecycle?.((event) => {
// available 不是旧 ownership 的失效边界：首次冷启动的 subscribe 先登记占位，
// 再一次启动发布 available(gen1)，最后才收到 ACK。
// 在这里推进代际会把当前 runtime 的合法 ACK 误判成重启。
    if (event.state === "available") {
      // 首次冷启动的 subscribe 会先登记 pending，再由同一次启动发布
      // available(gen1)，最后才收到 ACK。available 不是旧 ownership 的失效边界；
      // 若在这里推进 generation，会把当前 runtime 的合法 ACK 误判成 restart。
      // 真正的换代一定先发布 unavailable，由下方分支清理旧 owner/pending。
      return;
    }
    // attachment facade 若只监听 restart，runtime 退出但未重启时就会保留旧 owner，
    // 后续 UI cleanup 会重建 unsubscribe 参数并误走启动型 client；因此 unavailable 直接失效本地 owner。
// 只有 unavailable 才代表旧 owner 必须作废，并以事件里的代际为准推进。
    invalidateWorkspaceRuntime(event.workspaceKey, event.runtimeIdentity.generation);
  });
// 旧版 base 只有 restarted：本地自增一代再失效，
// 保证与 lifecycle 路径产生的代际语义一致。
  const runtimeRestartDisposable = hasRuntimeLifecycle
    ? undefined
    : base.onAgentRuntimeRestarted?.(({ workspaceKey: restarted }) => {
        const nextGeneration = (runtimeGenerationByWorkspaceKey.get(restarted) ?? 0) + 1;
        invalidateWorkspaceRuntime(restarted, nextGeneration);
      });

// [事务] 所有 V4 方法都在这里覆写，统一做三件事：守卫连接状态、
// 注入可信连接上下文、为订阅类方法建立/销毁 owner。
// 未覆写的方法由 Proxy 直接透传给 base，因此新增 V4 方法必须同步加在这里。
  const overrides: Partial<IZCodeAgentService> = {
// hello 记录「已发」但不代表已握手：未发 hello 就 initialize 会报 helloRequired。
    async helloConversationV4() {
      assertOpen();
      helloIssued = true;
      return createHello(context);
    },
// [事务] 握手是连接级一次性状态：clientId 一旦绑定不允许更换，
// 能力位只从 clientHello 读取并缓存，后续订阅不得自行覆盖。
// schema 解析失败直接抛出，不尝试容错降级。
    async initializeConversationV4(clientHello) {
      assertOpen();
      if (!helloIssued) throw new Error("fault.connection.helloRequired");
      const parsed = clientHelloSchema.parse(clientHello);
// 同一连接更换 clientId 说明底层会话被复用：拒绝比静默接受安全，
// 否则新客户端会继承旧客户端的订阅与命令归属。
      if (boundClientId !== null && boundClientId !== parsed.clientId) {
        throw new Error("fault.connection.clientChanged");
      }
      boundClientId = parsed.clientId;
      clientWorkflowRunDeltas = clientSupportsWorkflowRunDeltas(parsed);
// 能力位只认严格 true；缺席与 false 都按旧消费者处理。
      clientHistoryFirst = parsed.capabilities?.historyFirst === true;
      handshakeComplete = true;
    },
// [权衡] 流控只允许 trusted relay 调用：终端 UI 直接设置会绕过 transport 真实水位，
// 让下游误以为连接已饱和或已排空。
// 仅当该 connectionId 已在此 attachment 下触及过 route 时才转发。
    async setConnectionFlowStateV4(params) {
      assertOpen();
      if (role !== "trusted-host-relay") {
// 非 relay 一律禁止，错误码独立，便于区分「不允许」与「不可信」。
        throw new Error("fault.connection.flowControlForbidden");
      }
      const downstream = readTrustedZCodeAgentV4Connection(params);
      if (!downstream) throw new Error("fault.connection.flowControlUntrusted");
      const forwarded = forwardedConnection(params);
      const ownsRoute =
        attachmentFlowRoutes.has(flowRouteKey(params, forwarded.connectionId)) ||
        [...owned.values()].some(
          (entry) =>
            workspaceKey(entry.target) === workspaceKey(params) &&
            entry.connectionId === forwarded.connectionId,
        );
      if (!ownsRoute) throw new Error("fault.subscription.notOwned");
      await base.setConnectionFlowStateV4(withTrustedConnection(params, forwarded));
    },
// [事务] 终端客户端必须先握手且 envelope.clientId 与绑定值一致：
// 旧 facade 未覆盖该入口，未握手调用与伪造 clientId 都会直达 CLI；
// 静默覆盖又会破坏命令幂等归属，因此明确拒绝不一致。
// envelope 本身原样透传，可信上下文只走内部 carrier。
    async sendConversationCommandV4(params) {
      assertOpen();
      if (role === "terminal-client") {
        assertReady();
// 不一致即拒绝，不做自动修正。
        if (params.envelope.clientId !== boundClientId) {
          // 旧 facade 未覆盖 command 入口，未握手调用与伪造 clientId 都会
          // 直达 CLI；静默覆盖又会破坏 command 幂等归属，因此明确拒绝不一致。
          throw new Error("fault.command.clientMismatch");
        }
      }
      // command 过去只校验 envelope.clientId，却没有像订阅、附件一样注入
      // host 真值，导致 mobile 可伪造顶层 clientMode，且 relay 下游身份在 command 链路丢失。
      // envelope 仍原样透传；可信连接上下文只通过 host 内部 carrier 传给 base service。
      return base.sendConversationCommandV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
// 命令查询是唯一带 workspace 绑定的读接口：
// 一条 attachment 只能绑定一个 workspace，跨 workspace 直接拒绝。
// clock 探测例外，见下。
    async queryConversationCommandsV4(params) {
      assertReady();
      // 纯时钟探测不查询任何 command，不能抢占/改变业务查询的 workspace 绑定。
// params.clock 时直接走 base.queryConversationCommandsV4，跳过下面的 workspaceKey 绑定逻辑。
      if (params.clock)
        return base.queryConversationCommandsV4(
          withTrustedConnection(params, forwardedConnection(params)),
        );
      const requestedWorkspaceKey = workspaceKey(params);
// 首次查询绑定 workspace，后续不一致即报 foreignWorkspace。
      if (commandQueryWorkspaceKey !== null && commandQueryWorkspaceKey !== requestedWorkspaceKey) {
        throw new Error("fault.command.queryForeignWorkspace");
      }
      commandQueryWorkspaceKey = requestedWorkspaceKey;
      return base.queryConversationCommandsV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async backgroundBashOutputV4(params) {
      assertReady();
      return base.backgroundBashOutputV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async conversationRowsRangeV4(params) {
      assertReady();
      return base.conversationRowsRangeV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
// [资源] 附件 begin 会创建 staging 资源，因此需要额外的竞态处理：
// ACK 可能晚于 port close，此时必须先用同一可信身份 abort，再拒绝结果，
// 否则 CLI 会留下只能等 TTL 过期的半上传。
    async attachmentBeginV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const result = await base.attachmentBeginV4(withTrustedConnection(params, forwarded));
// 只有真正进入 staging 才登记 flow route；已直接完成的附件不需要路由。
      if (result.state === "staging") {
// 关闭已经发生：closed 状态错过这条 route，必须立刻 abort 释放 staging。
        if (disposed || flowClosed) {
          // begin ACK 可能晚于 port close。若此时再登记 route，closed 已经错过它，
          // CLI 会留下只能等 TTL 的半上传；先用同 trusted identity abort，再拒绝迟到结果。
          await base.attachmentAbortV4(withTrustedConnection(params, forwarded)).catch(() => {});
          throw new Error("fault.connection.closed");
        }
        const route: ConnectionFlowRoute = {
          key: flowRouteKey(params, forwarded.connectionId),
          target: workspaceTarget(params),
          connection: forwarded,
        };
        attachmentFlowRoutes.set(route.key, route);
        if (currentTransportFlowState === "saturated") {
          try {
            await forwardFlowRoute(route, "saturated");
          } catch (error) {
            attachmentFlowRoutes.delete(route.key);
            await base.attachmentAbortV4(withTrustedConnection(params, forwarded)).catch(() => {});
            throw error;
          }
        }
      }
      return result;
    },
    async attachmentReadV4(params) {
      assertReady();
      return base.attachmentReadV4(withTrustedConnection(params, forwardedConnection(params)));
    },
    async conversationAttachmentReadV4(params) {
      assertReady();
      return base.conversationAttachmentReadV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async conversationAttachmentStatV4(params) {
      assertReady();
      return base.conversationAttachmentStatV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async attachmentPreviewSourceV4(params) {
      assertReady();
      return base.attachmentPreviewSourceV4(
        withTrustedConnection(params, forwardedConnection(params)),
      );
    },
    async attachmentChunkV4(params) {
      assertReady();
      return base.attachmentChunkV4(withTrustedConnection(params, forwardedConnection(params)));
    },
    async attachmentCommitV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      return base.attachmentCommitV4(withTrustedConnection(params, forwarded));
    },
    async attachmentAbortV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      await base.attachmentAbortV4(withTrustedConnection(params, forwarded));
    },
// 三类订阅的唯一差异是 topic 与 ownershipKey 前缀，
// 流程固定为：建占位 → 调 base → ACK 后收口 → 失败清理占位。
    async subscribeConversationV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const topic = conversationTopic(params.sessionId);
      const pending = beginPendingOwnership("conversation", params, topic);
      try {
        const result = await base.subscribeConversationV4(withTrustedConnection(params, forwarded));
        await rememberAfterSubscribe(
          result.ack.subscriptionId,
          {
            kind: "conversation",
            ownershipKey: `conversation\0${workspaceKey(params)}\0${topic}\0${forwarded.connectionId}`,
            topic,
            connectionId: forwarded.connectionId,
            clientMode: forwarded.clientMode,
            target: workspaceTarget(params),
          },
          pending,
        );
        return result;
      } catch (error) {
        discardPendingOwnership(pending);
        throw error;
      }
    },
    async unsubscribeConversationV4(params) {
      const entry = findBySubscription(
        "conversation",
        params,
        params.subscriptionId,
        forwardedUnsubscribeRoute(params),
      );
      if (!entry) return;
      await unsubscribeOwnedEntry(entry, params.runtimePolicy);
    },
    async resyncConversationV4(params) {
      return resyncOwned("conversation", params);
    },
    onDynamicConversationFrame(params) {
      return routedEvent<ConversationTopicWireCandidate>(
        "conversation",
        params,
        base.onDynamicConversationFrame(params),
      );
    },
// 本地 TTFT 只对本地桌面连续连接有意义：
// 远端会话、带 workspaceIdentity 的路径与 replayable 客户端都返回 None。
    onDynamicLocalTtftFacts(params) {
      assertOpen();
      if (
        role !== "terminal-client" ||
        context.clientMode !== "desktop-continuous" ||
        params.workspaceIdentity?.trim() ||
        params.remoteSessionId
      )
        return RpcEvent.None;
      return base.onDynamicLocalTtftFacts(workspaceTarget(params));
    },
// 遥测 reporter 只能由可信 desktop 安装：即使 Web/mobile 能读权威对话态，
// 也不能借共享 workspace emitter 产生生产遥测。
// allow 的条件是 host attachment 为 desktop，或 relay 下游声明为 desktop。
    onDynamicConversationTelemetryFact(params) {
      assertOpen();
      // 可信 clientMode 来自 host attachment；Web/mobile/relay 即使能读权威对话态，
      // 也不能借共享 workspace emitter 安装生产 telemetry reporter。
      const downstream = readTrustedZCodeAgentV4Connection(params);
      const relayDesktopDownstream =
        role === "trusted-host-relay" && downstream?.clientMode === "desktop-continuous";
      if (
        context.clientMode !== "desktop-continuous" ||
        (role !== "terminal-client" && !relayDesktopDownstream)
      ) {
        return RpcEvent.None;
      }
      // renderer 的 workspace supervisor 会先于 V4 hello/initialize 挂载。
      // telemetry emitter 本身不发起协议请求，允许可信 desktop 提前监听，避免动态
      // Event 在 handshake 前抛错并让 host channel 退出；live fact 仍只会在 ingest 后产生。
      // 远程 workspace 还会经过 trusted host relay；这里沿用已有 trusted carrier 传递
      // 下游 clientMode/namespace connectionId，relay 自身没有可信下游时仍保持拒绝。
      return base.onDynamicConversationTelemetryFact(
        withTrustedConnection(workspaceTarget(params), forwardedConnection(params)),
      );
    },
// 插件 UI 页面创建只属于本地桌面：手机回放与 relay 都没有原生 guest 宿主。
    onDynamicPluginUiToolResult() {
      assertOpen();
      // 页面创建只属于本地桌面；手机回放和 relay 不拥有原生 guest。
      if (role !== "terminal-client" || context.clientMode !== "desktop-continuous")
        return RpcEvent.None;
      return base.onDynamicPluginUiToolResult();
    },
    onDynamicCuaPermissionObservation() {
      assertOpen();
      // 权限弹窗是本地桌面副作用；手机 replay attachment 只能消费可恢复对话事实。
      if (role !== "terminal-client" || context.clientMode !== "desktop-continuous") {
        return RpcEvent.None;
      }
      return base.onDynamicCuaPermissionObservation();
    },
// CLI 资源样本只供远端 Desktop Host relay 回传 main；
// renderer/mobile attachment 不消费，也不能进入 continuous/replayable 消息面。
    onDynamicProcessResourceSample() {
      assertOpen();
      // CLI 资源样本只供远端 Desktop Host relay 回传 main；renderer/mobile attachment
      // 不消费该事件，也不能把它引入 continuous/replayable 消息面。
      if (role !== "trusted-host-relay") {
        return RpcEvent.None;
      }
      return base.onDynamicProcessResourceSample();
    },
    onDynamicToolExecResource() {
      // 完成事实与会话交付无关，禁止进入 continuous/replayable attachment。
      if (disposed || role !== "trusted-host-relay") return RpcEvent.None;
      return base.onDynamicToolExecResource();
    },
    onDynamicMcpResourceSamples() {
      // 资源事实不属于会话流，桌面 continuous 与手机 replayable attachment 均不能订阅。
      if (disposed || role !== "trusted-host-relay") return RpcEvent.None;
      return base.onDynamicMcpResourceSamples();
    },
    onDynamicMcpTelemetry() {
      assertOpen();
      // MCP 遥测与 CLI 资源样本共用可信 Host relay 边界，不进入 renderer/mobile 会话链路。
      if (role !== "trusted-host-relay") {
        return RpcEvent.None;
      }
      return base.onDynamicMcpTelemetry();
    },
    async subscribeSessionsIndexV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const topic = sessionsIndexTopic(workspaceKey(params));
      const pending = beginPendingOwnership("sessions-index", params, topic);
      try {
        const result = await base.subscribeSessionsIndexV4(
          withTrustedConnection(params, forwarded),
        );
        await rememberAfterSubscribe(
          result.ack.subscriptionId,
          {
            kind: "sessions-index",
            ownershipKey: `sessions-index\0${topic}\0${forwarded.connectionId}`,
            topic,
            connectionId: forwarded.connectionId,
            clientMode: forwarded.clientMode,
            target: workspaceTarget(params),
          },
          pending,
        );
        return result;
      } catch (error) {
        discardPendingOwnership(pending);
        throw error;
      }
    },
    async unsubscribeSessionsIndexV4(params) {
      const entry = findBySubscription(
        "sessions-index",
        params,
        params.subscriptionId,
        forwardedUnsubscribeRoute(params),
      );
      if (!entry) return;
      await unsubscribeOwnedEntry(entry, params.runtimePolicy);
    },
    async resyncSessionsIndexV4(params) {
      return resyncOwned("sessions-index", params);
    },
    onDynamicSessionsIndexFrame(params) {
      return routedEvent<SessionsIndexTopicWireCandidate>(
        "sessions-index",
        params,
        base.onDynamicSessionsIndexFrame(params),
      );
    },
    async subscribeWorkspaceConfigV4(params) {
      assertReady();
      const forwarded = forwardedConnection(params);
      const topic = workspaceConfigTopic(workspaceKey(params));
      const pending = beginPendingOwnership("workspace-config", params, topic);
      try {
        const result = await base.subscribeWorkspaceConfigV4(
          withTrustedConnection(params, forwarded),
        );
        await rememberAfterSubscribe(
          result.ack.subscriptionId,
          {
            kind: "workspace-config",
            ownershipKey: `workspace-config\0${topic}\0${forwarded.connectionId}`,
            topic,
            connectionId: forwarded.connectionId,
            clientMode: forwarded.clientMode,
            target: workspaceTarget(params),
          },
          pending,
        );
        return result;
      } catch (error) {
        discardPendingOwnership(pending);
        throw error;
      }
    },
    async unsubscribeWorkspaceConfigV4(params) {
      const entry = findBySubscription(
        "workspace-config",
        params,
        params.subscriptionId,
        forwardedUnsubscribeRoute(params),
      );
      if (!entry) return;
      await unsubscribeOwnedEntry(entry, params.runtimePolicy);
    },
    async resyncWorkspaceConfigV4(params) {
      return resyncOwned("workspace-config", params);
    },
    onDynamicWorkspaceConfigFrame(params) {
      return routedEvent<WorkspaceConfigTopicWireCandidate>(
        "workspace-config",
        params,
        base.onDynamicWorkspaceConfigFrame(params),
      );
    },
  };

// [事务] Proxy 只覆盖 V4 覆写表，其余成员透传给 base 并重新绑定 this：
// 不绑定会让 base 的方法在解构调用时丢失实例上下文。
  const service = new Proxy(base, {
    get(target, property, receiver) {
      const override = Reflect.get(overrides, property, receiver);
      if (override !== undefined) return override;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    service,
    setTransportFlowState(state) {
      return enqueueTransportFlowState(state);
    },
// [资源] 释放顺序：先把 closed 排进流控队列 → 置 disposed 阻断新调用 →
// 清所有路由表与监听 → 最后并行退订仍持有的 CLI 订阅。
// closed 必须排在已入队的 SAT/DRN 之后，否则上游会看到乱序终态。
    async dispose() {
      if (disposed) return;
      // close 必须排在已入队 SAT/DRN 之后；即使控制 RPC 失败也继续 owned cleanup。
// 控制 RPC 失败不阻断本地清理：连接已经不可用，退订失败也只能尽力而为。
      await enqueueTransportFlowState("closed").catch(() => {});
      if (disposed) return;
      disposed = true;
      handshakeComplete = false;
      helloIssued = false;
      boundClientId = null;
      clientWorkflowRunDeltas = false;
      const entries = Array.from(owned.values());
      owned.clear();
      routeKeyByOwnership.clear();
      for (const group of pendingByOwnership.values()) {
        for (const pending of group) {
          pending.frames.length = 0;
          pending.stagedBytes = 0;
          pending.overflowReason = null;
        }
      }
      pendingByOwnership.clear();
      for (const route of routedFrameEvents.values()) {
        route.upstream.dispose();
        route.emitter.dispose();
      }
      routedFrameEvents.clear();
      runtimeLifecycleDisposable?.dispose();
      runtimeRestartDisposable?.dispose();
      runtimeGenerationByWorkspaceKey.clear();
      attachmentFlowRoutes.clear();
      forwardedFlowStateByRoute.clear();
// 用快照并行退订：owned 已清空，必须依赖 entries 而非当前表；
// allSettled 保证一条失败不影响其余订阅释放。
      await Promise.allSettled(entries.map((entry) => unsubscribeBase(entry)));
    },
  };
}

// Share RPC 复用同一内部 carrier 写入规则，不能复制一套连接身份拼装。
// [权衡] Share RPC 复用同一套 carrier 写入规则：
// 复制一份实现会在可信字段清单变化时产生两套行为，故只导出不改写。
export { withTrustedConnection as withTrustedZCodeAgentV4Connection };
