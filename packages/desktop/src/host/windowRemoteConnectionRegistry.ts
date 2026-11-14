/**
 * ============================================================================
 * desktop/host/windowRemoteConnectionRegistry.ts —— 窗口级远程连接注册表
 * ============================================================================
 *
 * 【定位】Window Host 内所有远程连接的唯一状态机：
 *   - 物理连接（SSH/WSL/Docker/Server）按 target/profile 复用；
 *   - logical session 按 remoteSessionId 独立登记；
 *   - attachment 只持有"某个 clientMode 对某个 logical session 的订阅"。
 *
 * 【身份分层（不要合并）】
 *   - sourceServerId：握手后由 Source 声明的设备身份，canonical owner 的唯一键；
 *   - remoteSessionId：一次逻辑会话/workspace 绑定，Host 分配；
 *   - workspaceKey：`workspaceIdentity?.trim() || workspacePath`，用于隔离；
 *   - target/profile：连接线路，可被多个 logical session 复用。
 *
 * 【关键不变量】
 *   - 同一 Source 的多个 Profile 竞争握手时，只有 canonical owner 生效；
 *     失败方把 pending logical session 转交，不创建第二个 owner。
 *   - 断连保留最后可信投影并标 offline；所有 IO/mutation fail-closed，
 *     禁止回落本地。重连后由新 source snapshot 原子替换。
 *   - 迟到异步结果必须检查 generation/transitionEpoch，不能复活已关闭的连接。
 *   - 关闭 attachment 只释放该 attachment；connection 仍有 owner 时不销毁。
 *
 * 【为什么所有 transport 共用一个 registry】重连、更新、profile 删除与
 * 连接复用共享同一组代际状态；拆成多个状态机会产生"两个 owner 同时在线"。
 *
 * 【#18 落地：clientMode / seq(generation) / dispose】
 *   - attachment 只通过 resolveScopedServices/resolveScopedHandle 取服务面，scope 必须是
 *     kind="remote" 且 workspacePath/workspaceIdentity 与 logical session 完全一致；
 *     任何不匹配或非 online 都抛 WindowRemoteConnectionUnavailableError（fail-closed）；
 *   - 每次 bindWorkspaceContext 都会 session.generation += 1 并替换 workspaceKey，
 *     workspaceRuntimeByKey 按 generation 记账，旧 generation 只能通过 pendingRelease 收尾，
 *     不会命中新 workspace 的 runtime；
 *   - entry.transitionEpoch 用于识别「异步操作期间换代」（TransitionStaleError）；
 *   - dispose 分两层：disposeSession 只释放该 logical session（受 shouldKeepConnectionAlive
 *     与 wsl idle / ssh cache 策略约束），registry.dispose 才统一释放全部 entry；两者幂等。
 * ============================================================================
 */
// ============================================================================
// [b18 深注] 文件头：windowRemoteConnectionRegistry.ts —— 职责边界
//   只做「窗口内远程连接的身份与代际记账」：物理 transport handle、logical session
//   （remoteSessionId）、workspace runtime（workspaceKey + generation）三层状态收敛到一处。
//   不负责：协议编解码、产物下载与校验、UI 展示策略、进程调度。
//   对外只暴露 connect / cancelConnect / bindWorkspaceContext / resolveScoped* 等窄接口。
// ============================================================================
// 不变量（INV）表：断言 —— 守住它的位置 —— 改错后的故障
//   INV-01 同一 Source 只能有一个 canonical owner —— entriesBySourceServerId + promoteOrJoinSourceOwner —— 改错：两个 online owner 互相 dispose，会话随机掉线。
//   INV-02 竞争失败的 provisional entry 不得再发布 online —— promoteOrJoinSourceOwner 的转交分支 + removeEntryOwners —— 改错：同一 workspace 出现两条在线 session。
//   INV-03 entry 归属按对象身份判断而非 key 字符串 —— entriesByKey.get(key) === entry 的全量复核 —— 改错：迟到回调把已替换 entry 写回索引，旧 owner 复活。
//   INV-04 迟到异步结果必须过 generation / transitionEpoch 校验 —— isCurrentRecoveryReplacement 与 connect 的 await 后复核 —— 改错：已关闭连接被复活。
//   INV-05 断连后所有 IO 必须 fail-closed —— resolveScopedHandle 的 state 与 workspaceReadyState 校验 —— 改错：回落到旧 handle，向错误设备写文件。
//   INV-06 workspace 释放按 generation 记账 —— WorkspaceRuntimeState.generation 与 pendingReleaseGeneration —— 改错：释放新代际 runtime 或漏释放，远端残留进程。
//   INV-07 只有无其它 owner 时才推进 runtime generation —— prepareWorkspaceRuntime 的 hasOtherOwner 分支 —— 改错：共享 workspace 被重复 prepare，用户选择被覆盖。
//   INV-08 pending session 不得对外广播关闭 —— notifyEntrySessionsClosed 与 handleConnectionClosed 的 pendingSessionsByRequestId 过滤 —— 改错：Renderer 收到从未发布过的幽灵 id。
//   INV-09 closePhase=recovering 只能由显式 recoverable=true 进入 —— handleConnectionClosed 的 closePhase 赋值 —— 改错：不可恢复失败被当成可恢复，UI 永久转圈。
//   INV-10 recovery 等待者必须被 resolve 或 reject —— beginRecovery / failRecovery / completeRecovery 三处配对 —— 改错：connect 永久 await，请求无提示超时。
//   INV-11 disposed 必须先置位再 await 释放 —— disposeEntry 与 disposeSupersededEntryTransport —— 改错：重入重复 dispose，或迟到 then 分支复活连接。
//   INV-12 workspaceIdentity 只能有一处权威来源 —— applyStableWorkspaceIdentity —— 改错：session 同时持有 route 与 stable 身份，owner 去重不命中。
//   INV-13 workspaceKey 统一取 identity.trim() 或 path —— bindWorkspaceContext 与 setWorkspaceRunningTaskCount —— 改错：同一工作区被当作两个，任务计数错位。
//   INV-14 空闲释放只在 wsl 且无 session、无 running task 时进行 —— scheduleWslIdleDispose —— 改错：任务执行中被断链，命令中断且不可恢复。
//   INV-15 复用 entry 前必须清 idle 计时器 —— resolveEntry 与 cancelConnect 的 clearIdleTimer —— 改错：新会话建立后被空闲计时器立刻回收。
//   INV-16 ssh ready 连接是窗口级 cache —— cancelConnect / disposeSession 的 ssh 分支 —— 改错：关一个 tab 就断开整窗 SSH，其它会话全部掉线。
//   INV-17 docker/server 的 connecting entry 在最后一个 waiter 取消后必须出表 —— cancelConnect 的 docker/server 分支 —— 改错：下次 connect 复用无 waiter 的死 flight。
//   INV-18 workspace release 失败必须保留 rejecting promise —— startWorkspaceRelease 的 releaseInFlight —— 改错：下一代 acquire 踩过未完成清理。
//   INV-19 快照中的 target 必须脱敏 —— toSessionSnapshot 与 listConnections —— 改错：密码与 token 泄露到 Renderer 日志。
//   INV-20 findSessionForWorkspace 多解必须抛错 —— 该函数的歧义分支 —— 改错：随机挑一个 session，把请求发到错误 workspace。
//   INV-21 单点 replacement 失败不得阻断 sibling —— replaceDisconnectedSessions 的 hasReplacementError 分支 —— 改错：一个坏 workspace 让整台设备都无法恢复。
//   INV-22 commit 之后不可回滚 —— replaceDisconnectedSessions 的 commit 边界 —— 改错：已发布的 generation 被塞回 rollback，Renderer 引用悬空。
//   INV-23 订阅必须成对释放 —— subscribeEntryHandle 的 closeSubscription 与 reconnectSubscription —— 改错：每次重连泄漏一份 Manager 订阅，回调数量持续增长。
//   INV-24 registry.dispose 必须覆盖只在 sessions 中出现的 entry —— dispose 的 entries 并集 —— 改错：窗口关闭后仍有 transport 存活，进程无法退出。
/* eslint-disable max-lines -- 所有 transport 生命周期共享同一个 registry 状态机，必须原子演进。 */
import {
  buildSshRemoteHostKey,
  buildServerRemoteWorkspaceIdentity,
  stripRemoteTargetSecrets,
  type RemoteTarget,
  type SourceServerArtifactPolicy,
  type WorkspacePurpose,
  type WindowHostAttachmentScope,
  type WindowHostRemoteWorkspaceDescriptor,
// [契约] shared 只提供身份构造与脱敏纯函数；registry 不得从这里引入 transport 实现或连接器。
// 否则 host 层会形成对具体传输的隐式依赖，transport 替换必须改两处。
// 新增 import 时逐项确认无副作用（顶层不建连接、不读环境变量）。
} from "@zcode/shared";

// 连接建立时用到的本地产物来源（mock CDN / 远端 CDN / 缓存目录）与部署策略，
// 由 Registry 原样透传给 connect 回调；Registry 本身不下载、不校验产物。
// [契约] 产物目录（mock CDN / 远端 CDN / 缓存）原样透传给 connect 回调。
// registry 不下载、不校验、不缓存产物：把 CDN 策略复制一份会产生两套优先级规则。
// 字段全部可选，缺省时由 connect 实现自行决定，本层不做默认值填充。
export interface WindowRemoteAssetDirs {
  mockCdnDir?: string;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
  sourceServerArtifactPolicy?: SourceServerArtifactPolicy;
}

// 物理连接关闭事件（映射自 SourceServerConnectionManager 的恢复状态）：
// recoverable=true 表示 Registry 会先尝试原地恢复；reasonCode/retryable 供上层区分提示文案。
// [失败路径] recoverable 只认显式取值：首次 close 时只有 true 才进入 recovering，缺省按 terminal 处理。
// reasonCode / retryable 供上层区分提示文案，registry 不根据它们改变状态机。
// recoveryAttempt / recoveryLimit 用于进度去重与预算耗尽判定。
export interface WindowRemoteConnectionCloseEvent {
  exitCode: number | null;
  signal: string | null;
  error?: string;
  recoverable?: boolean;
  recoveryAttempt?: number;
  recoveryLimit?: number;
  recoveryBudgetExhausted?: boolean;
  reasonCode?: string;
  retryable?: boolean;
}

// 物理连接的对外句柄：services/capabilities 是 getter（重连后会切换到新连接），
// dispose 幂等；onDidClose/onDidReconnect 支持多次订阅，Registry 负责成对释放。
// [契约] services 与 capabilities 是 getter，重连后自动指向新连接。
// 调用方不得把返回值持久化到跨 generation 的字段，否则重连后会向旧连接发请求。
// dispose 必须幂等；onDidClose 与 onDidReconnect 支持多次订阅，由 registry 成对释放。
export interface WindowRemoteConnectionHandle<TServices, TCapabilities = never> {
  services: TServices;
  reusedConnectionTarget?: RemoteTarget;
  capabilities?: TCapabilities;
  dispose(): void | Promise<void>;
  onDidClose?(listener: (event: WindowRemoteConnectionCloseEvent) => void): {
    dispose(): void;
  };
  /** 同一 Source transport 自动重连完成；services/capabilities getter 已切到新连接。 */
  onDidReconnect?(listener: () => void): { dispose(): void };
}

// 发起连接的输入：target + remoteAssets 决定物理连接；signal 是取消凭据；
// existingSourceServerId 用于「已知设备」的快速路径；membershipIntent="retain" 用于静默重连。
// [权衡] existingSourceServerId 是已知设备的快速路径，可与握手并行省一次探测。
// 握手得到的身份与之不符时 createEntry 必须 dispose 并抛 unavailable，不能降级为新建连接。
// membershipIntent=retain 表示静默重连，不改变 Source 的成员归属。
export interface WindowRemoteConnectionConnectRequest {
  membershipIntent?: "add" | "retain";
  existingSourceServerId?: string;
  target: RemoteTarget;
  remoteAssets: WindowRemoteAssetDirs;
  signal: AbortSignal;
  confirmSourceServerInstall?: boolean;
}

// 连接/会话状态：connecting -> online -> closing -> disconnected，失败为 failed。
// closing 表示「已发起释放但尚未完成」，用于阻止同 key 的复用。
// [契约] `closing` 期间同 key 的新建会被拒绝，直到状态落到 `disconnected`。
// 不能与 disconnected 合并：disconnected 可能仍持有 handle 并等待恢复。
// failed 是握手失败终态，不出现在可复用集合中。
export type WindowRemoteConnectionState =
  | "connecting"
  | "online"
  | "closing"
  | "failed"
  | "disconnected";

// logical session 的对外快照：target 已脱敏（不含密码/口令），generation 是该 session 的
// 代际序号（workspace 换绑时自增），sourceAvailability 与 state 分开表达「设备在线」与
// 「本会话可用」两件事（设备在线但会话失败时仍为 offline）。
// [契约] 快照是只读投影，修改它不影响内部状态。
// sourceAvailability 与 state 分开表达「设备在线」与「本会话可用」：设备在线但会话失败时仍为 offline。
// target 必须已脱敏，由 toSessionSnapshot 统一处理。
export interface WindowRemoteLogicalSessionSnapshot {
  sourceServerId?: string;
  remoteSessionId: string;
  requestId: string;
  target: RemoteTarget;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
  generation: number;
  state: WindowRemoteConnectionState;
  sourceAvailability: "online" | "offline";
}

// 取消连接的统一错误（code 公开，retryable 语义由上层处理）；cancelConnect/dispose 都会触发。
// [失败路径] code 固定为 remote-connection-canceled，上层按 code 判定取消。
// 不要解析 message 做分支：文案会随国际化变化。
// cancelConnect 与 disposeEntry 都复用本错误，保证取消语义唯一。
export class WindowRemoteConnectCancelledError extends Error {
  public readonly code = "remote-connection-canceled";
  constructor() {
    super("远程连接已取消");
    this.name = "WindowRemoteConnectCancelledError";
  }
}

// attachment scope 无法解析到可用连接时抛出的 fail-closed 错误：
// session 不存在、workspace 不匹配、设备离线、workspace 未 ready 或 handle 缺失都走这里。
// [失败路径] 本文件唯一的 fail-closed 出口：session 缺失、身份不匹配、离线、未 ready 都走这里。
// 任何新增的「回退到最近一次已知连接」分支都会破坏该契约。
// 远端 workspace 不可用时宁可报错，也不能把 IO 落到本地路径。
// 调用方据此展示「连接已断开」，不重试同一 scope。
export class WindowRemoteConnectionUnavailableError extends Error {
  constructor(remoteSessionId: string) {
    super(`远程连接当前不可用，remoteSessionId=${remoteSessionId}`);
    this.name = "WindowRemoteConnectionUnavailableError";
  }
}

// [资源] 字段分三组：transport（abortController / handle / 两个订阅）、恢复（closePhase / recoveryReady / recoveryReplacements / transitionEpoch）、workspace（workspaceKeys / runningTaskCountByWorkspaceKey / workspaceRuntimeByKey）。
// 新增字段必须落在对应组内，禁止跨组共享可变状态。
// recoveryReplacements 只保存「本轮 flight 内」的 previous/current 对，flight 结束必须清空。
interface ConnectionEntry<TServices, TCapabilities> {
  key: string;
  sourceServerId?: string;
  target: RemoteTarget;
  state: WindowRemoteConnectionState;
  abortController: AbortController;
  sessions: Set<string>;
  ready: Promise<WindowRemoteConnectionHandle<TServices, TCapabilities>>;
  handle?: WindowRemoteConnectionHandle<TServices, TCapabilities>;
  closeSubscription?: { dispose(): void };
  reconnectSubscription?: { dispose(): void };
  reconnectFlight?: Promise<void>;
  replacementRetryTimer?: ReturnType<typeof setTimeout>;
  recoveryReplacements?: Array<{
    previous: LogicalSession<TServices, TCapabilities>;
    current: LogicalSession<TServices, TCapabilities>;
  }>;
  closePhase: "none" | "recovering" | "terminal";
  lastRecoveryAttemptNotified?: number;
  recoveryReady?: Promise<void>;
  recoveryFailure?: Error;
  resolveRecovery?: () => void;
  rejectRecovery?: (error: Error) => void;
  disposePromise?: Promise<void>;
  disposed: boolean;
  transitionEpoch: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleReason: string;
  workspaceKeys: Set<string>;
  runningTaskCountByWorkspaceKey: Map<string, number>;
  workspaceRuntimeByKey: Map<string, WorkspaceRuntimeState>;
}

// [并发] 仅内部信号：表示异步期间 entry 已换代或被替换。
// catch 中必须与真实业务错误分开处理，不能直接上抛给 UI。
// 出现该错误说明本轮应整体放弃，由 owner 侧重新发起恢复。
class WindowRemoteConnectionTransitionStaleError extends Error {
  public constructor() {
    super("远程连接状态已在异步操作期间换代");
    this.name = "WindowRemoteConnectionTransitionStaleError";
  }
}

// [契约] workspacePath 供远端文件操作与命令 cwd；workspaceIdentity 供身份隔离。
// 两者不可互换：只用 path 会在软链或挂载点不同的设备间串号。
// 该结构随 releaseWorkspace 原样传给上层，字段变更需同步上层实现。
interface RemoteWorkspaceContext {
  workspacePath: string;
  workspaceIdentity?: string;
}

// [并发] generation 单调递增，且只在没有其它 owner 时推进。
// pendingReleaseGeneration 记录因 running task 而暂缓的释放意图，任务归零后据此补做释放。
// releaseInFlight 是当代释放的 promise，新代际 acquire 必须先等它完成。
// context 与 generation 绑定，换代时必须整体替换而不是就地改字段。
interface WorkspaceRuntimeState {
  context: RemoteWorkspaceContext;
  generation: number;
  pendingReleaseGeneration?: number;
  releaseInFlight?: Promise<void>;
}

// [契约] entry 指向当前物理连接 owner，可被 assignSessionToSourceOwner 改写。
// workspaceGeneration 与 entry.workspaceRuntimeByKey 中的 generation 对应，用于识别旧快照。
// cancellation 是永不 resolve 的 promise，只用于 Promise.race 抢占。
// workspaceReady / workspaceReadyState 必须成对更新，否则 resolveScopedHandle 会误判可用。
interface LogicalSession<TServices, TCapabilities> {
  sourceServerId?: string;
  remoteSessionId: string;
  requestId: string;
  target: RemoteTarget;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
  legacyWorkspaceIdentity?: string;
  generation: number;
  state: WindowRemoteConnectionState;
  sourceAvailability: "online" | "offline";
  entry: ConnectionEntry<TServices, TCapabilities>;
  workspaceKey?: string;
  workspaceGeneration?: number;
  workspaceReady: Promise<void>;
  workspaceReadyState: "pending" | "ready" | "failed";
  cancelled: boolean;
  rejectCancellation: (error: WindowRemoteConnectCancelledError) => void;
  cancellation: Promise<never>;
}

// [契约] 空 distro 或 user 统一归一为 <default>。
// 同一发行版的不同写法必须得到同一 connection key，否则会在同一条 wsl 上开两条连接。
// 不要在此做大小写折叠：wsl 用户区分大小写，折叠会让两个用户共用连接。
function normalizeWslSegment(value: string | undefined): string {
  return value?.trim() || "<default>";
}

// [契约] ws 归一为 http、wss 归一为 https，去掉 search 与 hash，并剥掉 /ws 与 /ws/host 后缀。
// 目的是让「同一台 Server 的多种 URL 写法」命中同一 connection key。
// 解析失败退回字符串裁剪，绝不抛错：key 构造不能因为脏数据中断连接流程。
// `normalizeServerConnectionUrl` 只做字符串归一，不做鉴权或连通性探测。
function normalizeServerConnectionUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    url.search = "";
    url.hash = "";
    const path = url.pathname.replace(/\/+$/u, "");
    url.pathname = path.endsWith("/ws/host")
      ? path.slice(0, -"/ws/host".length) || "/"
      : path.endsWith("/ws")
        ? path.slice(0, -"/ws".length) || "/"
        : path || "/";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return value.trim().replace(/\/+$/u, "");
  }
}

// [契约] key 只描述物理线路：ssh 用 hostKey、wsl 用 distro+user、docker 用容器、server 用 id 或归一 URL。
// 禁止把 remoteSessionId 或 workspaceKey 混入 key：那会让每个会话都新建一条物理连接。
// wsl 用 NUL 字符分隔 distro 与 user，避免组合歧义。
// 新增 transport kind 必须在此补分支，否则会落到 undefined 并共享错误 key。
function buildConnectionKey(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${buildSshRemoteHostKey(target)}`;
    case "wsl":
      return `wsl:${normalizeWslSegment(target.distro)}\0${normalizeWslSegment(target.user)}`;
    case "docker":
      return `docker:${target.container.trim()}`;
    case "server":
      return `server:${target.serverId?.trim() || normalizeServerConnectionUrl(target.url)}`;
  }
}

// [契约] stripRemoteTargetSecrets 必须在这里统一调用，不能依赖调用方自觉。
// 可选字段用条件展开，避免出现 undefined 键影响深比较。
// 新增返回字段时同步检查是否含凭据或内部地址。
function toSessionSnapshot<TServices, TCapabilities>(
  session: LogicalSession<TServices, TCapabilities>,
): WindowRemoteLogicalSessionSnapshot {
  return {
    ...(session.sourceServerId ? { sourceServerId: session.sourceServerId } : {}),
    remoteSessionId: session.remoteSessionId,
    requestId: session.requestId,
    target: stripRemoteTargetSecrets(session.target),
    ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}),
    ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
    ...(session.workspacePurpose ? { workspacePurpose: session.workspacePurpose } : {}),
    generation: session.generation,
    state: session.state,
    sourceAvailability: session.sourceAvailability,
  };
}

// 创建窗口级远程连接注册表（进程/窗口内唯一）。
//
// 输入：connect 是真正的物理连接工厂；createId 生成 remoteSessionId；onConnectionChanged 在
//   连接增删/换代时通知上层重算；onSessionClosed 上报会话级关闭；releaseWorkspace 用于释放
//   远端 workspace runtime；resolveSourceServerId/shouldKeepConnectionAlive 决定 Source 级
//   连接归属与复用；prepareWorkspaceIdentity 负责 stable identity 的上游写入。
// 输出：连接/会话的命令与查询 API（connect/cancelConnect/bindWorkspaceContext/resolveScoped*）。
// 副作用：建立/释放物理连接，维护 entriesByKey/entriesBySourceServerId/sessionsById 三张表。
// 失败语义：不可用一律抛 WindowRemoteConnectionUnavailableError 或取消错误；不静默降级。
// 不变量：按对象身份（而不是 key 字符串）判断 owner 是否仍是当前代际；所有迟到异步结果
//   必须用 transitionEpoch/generation 校验后才允许写回。
// [契约] 每次调用产生独立实例；「窗口内唯一」由调用方保证，本函数不做跨实例互斥。
// 必填回调只有 connect 与 createId，其余为可选策略钩子。
// options 在实例生命周期内视为不可变，禁止在实现中回读写回 options。
// 返回值是闭包对象，测试可安全创建多份互不干扰的注册表。
export function createWindowRemoteConnectionRegistry<TServices, TCapabilities = never>(options: {
  connect: (
    request: WindowRemoteConnectionConnectRequest,
  ) => Promise<WindowRemoteConnectionHandle<TServices, TCapabilities>>;
  createId: () => string;
  onConnectionChanged?: () => void;
  onSessionClosed?: (event: WindowRemoteConnectionCloseEvent & { remoteSessionId: string }) => void;
  onSessionReconnected?: (event: {
    previous: WindowRemoteLogicalSessionSnapshot;
    current: WindowRemoteLogicalSessionSnapshot;
    services: TServices;
    isCurrent: () => boolean;
    commit: () => boolean;
  }) => void | Promise<void>;
  onSessionReconnectError?: (error: unknown) => void;
  releaseWorkspace?: (services: TServices, context: RemoteWorkspaceContext) => Promise<void>;
  onWorkspaceReleaseError?: (context: RemoteWorkspaceContext, error: unknown) => void;
  resolveSourceServerId?: (
    handle: WindowRemoteConnectionHandle<TServices, TCapabilities>,
  ) => string | undefined;
  shouldKeepConnectionAlive?: (
    handle: WindowRemoteConnectionHandle<TServices, TCapabilities>,
  ) => boolean;
  prepareWorkspaceIdentity?: (
    handle: WindowRemoteConnectionHandle<TServices, TCapabilities>,
    input: {
      sourceServerId: string;
      workspacePath: string;
      stableWorkspaceIdentity: string;
      legacyRouteHint?: string;
      signal?: AbortSignal;
    },
  ) => Promise<void>;
  wslIdleTtlMs?: number;
  logicalReplacementRetryDelaysMs?: readonly number[];
}) {
  // [并发] 五张表职责：entriesByKey 路由复用、entriesBySourceServerId 表示 canonical owner、sessionsById 是权威会话表、pendingSessionsByRequestId 做 requestId 幂等，其余状态挂在 entry 内。
  // 写入口只允许 removeEntryOwners 与显式 owner 赋值；任何新增 set 都要先确认不会产生第二个 owner。
  // 别名（多条 route key）可以指向同一 entry，因此按 key 删除必须复核 owner 身份。
  // 这四张表都不做持久化，进程重启即清空。
  const entriesByKey = new Map<string, ConnectionEntry<TServices, TCapabilities>>();
  const entriesBySourceServerId = new Map<string, ConnectionEntry<TServices, TCapabilities>>();
  const sessionsById = new Map<string, LogicalSession<TServices, TCapabilities>>();
  const pendingSessionsByRequestId = new Map<string, LogicalSession<TServices, TCapabilities>>();
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  const wslIdleTtlMs = options.wslIdleTtlMs ?? 60_000;
  const logicalReplacementRetryDelaysMs =
    options.logicalReplacementRetryDelaysMs ?? ([500, 1_000, 2_000] as const);

  // [契约] 只询问 shouldKeepConnectionAlive 回调，不看 sessions 数量。
  // handle 缺失时直接返回 false，避免在握手完成前误判保活而漏释放。
  // 该判断决定「释放 wrapper」还是「释放物理连接」，改变它会直接影响 SSH 池的复用率。
  function shouldKeepConnectionAlive(entry: ConnectionEntry<TServices, TCapabilities>): boolean {
    return Boolean(entry.handle && options.shouldKeepConnectionAlive?.(entry.handle));
  }

  // [并发] 必须按对象身份删除：别名 key 可能已指向继任 owner，按 key 删会误删新连接。
  // entriesBySourceServerId 同样要复核 get 结果等于本 entry 才删。
  // 该函数只清索引，不动 handle 与订阅，调用方仍需负责释放 transport。
  function removeEntryOwners(entry: ConnectionEntry<TServices, TCapabilities>): void {
    for (const [key, owner] of entriesByKey) {
      if (owner === entry) entriesByKey.delete(key);
    }
    if (entry.sourceServerId && entriesBySourceServerId.get(entry.sourceServerId) === entry) {
      entriesBySourceServerId.delete(entry.sourceServerId);
    }
  }

  // [失败路径] 允许 disconnected 但 closePhase=recovering 且仍保活的 entry 继续当 owner。
  // 否则新握手会抢走正在恢复的连接，导致旧 wrapper 的恢复 flight 无处落地。
  // 已 disposed 或已 abort 的 entry 一律不可拥有 Source，必须让位给新 entry。
  // 这里的判定与 resolveEntry 的复用条件语义不同，不要合并成一个函数。
  function canOwnManagedSource(entry: ConnectionEntry<TServices, TCapabilities>): boolean {
    return (
      !entry.disposed &&
      !entry.abortController.signal.aborted &&
      (entry.state === "connecting" ||
        entry.state === "online" ||
        (entry.state === "disconnected" &&
          entry.closePhase === "recovering" &&
          shouldKeepConnectionAlive(entry)))
    );
  }

  // [契约] 转交时同步改写 target、state、sourceAvailability。
  // 只改 entry 不改这三个字段，会让 session 与 owner 状态分叉，resolveScopedHandle 随后拒绝服务。
  // 转交后仍要由调用方把 session 加入 owner.sessions，本函数不做集合操作。
  function assignSessionToSourceOwner(
    session: LogicalSession<TServices, TCapabilities>,
    owner: ConnectionEntry<TServices, TCapabilities>,
    sourceServerId: string,
  ): void {
    session.entry = owner;
    session.target = owner.target;
    session.state = owner.state === "online" ? "online" : owner.state;
    session.sourceAvailability = owner.state === "online" ? "online" : "offline";
    applyStableWorkspaceIdentity(session, sourceServerId);
  }

  /**
   * Source 身份已知后，logical session 的 workspace identity/workspaceKey 只允许是
   * `remote:server:<sourceServerId>:<path>`；调用方传入的 route identity 只保留为 legacyRouteHint。
   * 握手上线、Source owner 转交、在线 entry 直接 join 三条路径必须共用这一处规则。
   */
  // 握手拿到 canonical sourceServerId 后，session 的 workspaceIdentity/workspaceKey 必须统一
  // 改写为 remote:server:<id>:<path>；原 route identity 只留作 legacyRouteHint。
  // 三条路径（握手上线 / owner 转交 / 在线 join）共用本函数，保证身份只有一处来源。
  // [契约] 唯一身份改写点：统一产出 remote:server:<sourceServerId>:<path>。
  // legacyWorkspaceIdentity 用 ??= 只记录首次原值，重复调用不会覆盖真实旧身份。
  // 三条路径（握手上线、owner 转交、在线 join）必须共用，禁止就地拼字符串。
  // workspaceKey 同步改写为 identity，保证后续按 key 去重命中同一条目。
  function applyStableWorkspaceIdentity(
    session: LogicalSession<TServices, TCapabilities>,
    sourceServerId: string,
  ): void {
    session.sourceServerId = sourceServerId;
    if (!session.workspacePath) return;
    session.legacyWorkspaceIdentity ??= session.workspaceIdentity;
    session.workspaceIdentity = buildServerRemoteWorkspaceIdentity({
      serverId: sourceServerId,
      workspacePath: session.workspacePath,
    });
    session.workspaceKey = session.workspaceIdentity;
    session.entry.workspaceKeys.add(session.workspaceIdentity);
  }

  // [资源] 覆盖前必须先 dispose 旧订阅（takeOverRecoveringSourceOwner 已保证该前提）。
  // 否则同一 entry 会挂两份 Manager 回调，一次 close 触发两次状态推进。
  // onDidClose 与 onDidReconnect 都可能缺失，缺失时不应创建假订阅。
  // 订阅句柄只在 entry 上保存一份，不做数组累积。
  function subscribeEntryHandle(
    entry: ConnectionEntry<TServices, TCapabilities>,
    handle: WindowRemoteConnectionHandle<TServices, TCapabilities>,
  ): void {
    entry.handle = handle;
    entry.closeSubscription = handle.onDidClose?.((event) => {
      handleConnectionClosed(entry, event);
    });
    entry.reconnectSubscription = handle.onDidReconnect?.(() => {
      handleConnectionReconnected(entry);
    });
  }

  // [并发] 顺序不可换：摘旧订阅与 retry timer → 改 owner.target 并订阅新 handle → 转交 session → 摘 provisional 索引 → dispose 旧 transport。
  // 反序会出现「事件已到但订阅已换」的丢事件窗口，或短时间双 owner。
  // 转交中把 session.state 置 connecting，避免被 replaceDisconnectedSessions 当成上一代 owner 再换代。
  async function takeOverRecoveringSourceOwner(
    provisional: ConnectionEntry<TServices, TCapabilities>,
    owner: ConnectionEntry<TServices, TCapabilities>,
    handle: WindowRemoteConnectionHandle<TServices, TCapabilities>,
    sourceServerId: string,
  ): Promise<void> {
    const previousHandle = owner.handle;
    owner.closeSubscription?.dispose();
    owner.closeSubscription = undefined;
    owner.reconnectSubscription?.dispose();
    owner.reconnectSubscription = undefined;
    if (owner.replacementRetryTimer) {
      clearTimeout(owner.replacementRetryTimer);
      owner.replacementRetryTimer = undefined;
    }
    owner.target = provisional.target;
    subscribeEntryHandle(owner, handle);

    for (const remoteSessionId of Array.from(provisional.sessions)) {
      const session = sessionsById.get(remoteSessionId);
      if (!session || session.entry !== provisional) continue;
      provisional.sessions.delete(remoteSessionId);
      owner.sessions.add(remoteSessionId);
      assignSessionToSourceOwner(session, owner, sourceServerId);
      // 当前 request 只是 recovery waiter，不能被 replaceDisconnectedSessions 当成上一代
      // logical owner 再换代一次；恢复完成后它会 join 真正的 replacement session。
      session.state = "connecting";
    }
    removeEntryOwners(provisional);
    entriesByKey.set(provisional.key, owner);
    provisional.handle = undefined;
    await disposeSupersededEntryTransport(provisional);
    await Promise.resolve(previousHandle?.dispose());
    handleConnectionReconnected(owner);
  }

  // 握手后决定「谁是该 Source 的 canonical owner」：无 owner 或旧 owner 已不可用时直接接管；
  // 若旧 owner 正处于 recovering 且没有换代 flight，则由新 handle 直接接管旧 entry；
  // 否则把本 entry 的 session 全部转交给既有 owner，并释放本 entry 的 transport。
  // 不变量：竞争失败的 provisional entry 绝不能成为第二个 online owner（见下方 Bug 注释）。
  // [并发] 三个分支的优先级固定：无 owner 或旧 owner 失效则直接成为 owner；旧 owner 在 recovering 且无 flight 则接管；否则转交并释放本 entry。
  // 失败方无论如何都要 removeEntryOwners，否则索引里残留第二个 owner。
  // 转交时必须逐个校验 session.entry === entry，避免把已转走的会话重复搬移。
  // 本函数返回 canonical owner，调用方据此决定是否继续发布 online。
  async function promoteOrJoinSourceOwner(
    entry: ConnectionEntry<TServices, TCapabilities>,
    handle: WindowRemoteConnectionHandle<TServices, TCapabilities>,
    sourceServerId: string,
  ): Promise<ConnectionEntry<TServices, TCapabilities>> {
    entry.sourceServerId = sourceServerId;
    const existing = entriesBySourceServerId.get(sourceServerId);
    if (!existing || existing === entry || !canOwnManagedSource(existing)) {
      entriesBySourceServerId.set(sourceServerId, entry);
      return entry;
    }

    if (
      existing.state === "disconnected" &&
      existing.closePhase === "recovering" &&
      !existing.reconnectFlight
    ) {
      // 不同 Profile 的手动连接已经拿到同一 Source 的新 handle，而旧 wrapper 尚未收到
      // reconnect（Manager 在发布点统一 fire，通常旧 wrapper 会先换代并把 entry 置回 online；
      // 只有它仍停在 recovering 且没有换代 flight 时才由新 handle 直接接管，避免 join 挂起）。
      await takeOverRecoveringSourceOwner(entry, existing, handle, sourceServerId);
      return existing;
    }

    // Bug 根因：route entry 在握手后曾直接成为 online owner，导致同一 Source 的多个
    // Profile 各自持有 logical wrapper。握手得到稳定身份后，竞争失败的 provisional
    // entry 必须在发布 online 前把 waiter/session 转交给 canonical Source entry。
    for (const remoteSessionId of Array.from(entry.sessions)) {
      const session = sessionsById.get(remoteSessionId);
      if (!session || session.entry !== entry) continue;
      entry.sessions.delete(remoteSessionId);
      existing.sessions.add(remoteSessionId);
      assignSessionToSourceOwner(session, existing, sourceServerId);
    }
    removeEntryOwners(entry);
    entriesByKey.set(entry.key, existing);
    await disposeSupersededEntryTransport(entry);
    return existing;
  }

  // [资源] 复用、新建、running task 出现、取消逻辑连接前都必须清。
  // 漏清会让空闲计时器回收刚复活的 wsl 会话，表现为「连上立刻断」。
  // 计时器句柄必须置 undefined，否则 clearTimeout 会被误判为仍有待执行任务。
  function clearIdleTimer(entry: ConnectionEntry<TServices, TCapabilities>): void {
    if (!entry.idleTimer) {
      return;
    }
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  // [资源] 只统计 runningTaskCountByWorkspaceKey 中大于 0 的项。
  // 计数归零必须走 setWorkspaceRunningTaskCount 的 else 分支，才会重新排 idle。
  // 这里不看 session 数：有 session 无任务的 wsl 仍允许空闲释放。
  function hasRunningTasks(entry: ConnectionEntry<TServices, TCapabilities>): boolean {
    return Array.from(entry.runningTaskCountByWorkspaceKey.values()).some((count) => count > 0);
  }

  // [并发] 幂等：已有 recoveryReady 直接返回，避免覆盖仍在等待的 resolve/reject。
  // 创建后立即预挂 catch，保证无 waiter 时终态拒绝不会变成 unhandled rejection。
  // recoveryFailure 在入口清空，防止上一轮失败污染本次等待。
  // resolveRecovery / rejectRecovery 由 completeRecovery 与 failRecovery 配对消费。
  function beginRecovery(entry: ConnectionEntry<TServices, TCapabilities>): void {
    if (entry.recoveryReady) return;
    entry.recoveryFailure = undefined;
    entry.recoveryReady = new Promise<void>((resolve, reject) => {
      entry.resolveRecovery = resolve;
      entry.rejectRecovery = reject;
    });
    // 无手动 waiter 时终态拒绝也不得变成 unhandled rejection。
    void entry.recoveryReady.catch(() => undefined);
  }

  // [并发] 只在 replacement flight 成功后调用；失败路径必须走 failRecovery。
  // 复位 closePhase 与 lastRecoveryAttemptNotified，否则下一轮 attempt 去重会失效。
  // 清空全部 recovery 字段，保证 entry 回到可复用的干净状态。
  function completeRecovery(entry: ConnectionEntry<TServices, TCapabilities>): void {
    entry.resolveRecovery?.();
    entry.recoveryReady = undefined;
    entry.resolveRecovery = undefined;
    entry.rejectRecovery = undefined;
    entry.closePhase = "none";
    entry.lastRecoveryAttemptNotified = undefined;
    entry.recoveryFailure = undefined;
  }

  // [契约] 跳过 pending session：它尚未对外发布，广播会让 Renderer 持有无法再解析的 id。
  // 跳过条件用对象身份比较（pendingSessionsByRequestId.get === session），不能用状态推断。
  // 遍历 entry.sessions 的副本语义由调用方保证，函数内不修改集合。
  // 该函数只做通知，不改变任何状态，可安全重复调用。
  function notifyEntrySessionsClosed(
    entry: ConnectionEntry<TServices, TCapabilities>,
    event: WindowRemoteConnectionCloseEvent,
  ): void {
    for (const remoteSessionId of entry.sessions) {
      const session = sessionsById.get(remoteSessionId);
      if (!session || pendingSessionsByRequestId.get(session.requestId) === session) continue;
      options.onSessionClosed?.({ remoteSessionId, ...event });
    }
  }

  // [并发] reject 后必须清空 resolve/reject 句柄，避免悬挂引用。
  // 但要保留 recoveryFailure，供 connect 在 await 之后复查并抛出真实原因。
  // 重复调用是安全的：没有等待者时只覆盖 recoveryFailure。
  function failRecovery(entry: ConnectionEntry<TServices, TCapabilities>, error: Error): void {
    entry.recoveryFailure = error;
    entry.rejectRecovery?.(error);
    entry.recoveryReady = undefined;
    entry.resolveRecovery = undefined;
    entry.rejectRecovery = undefined;
  }

  // [失败路径] 把 reasonCode、retryable、recoveryAttempt、recoveryLimit 挂到 Error 上。
  // 上层提示不得依赖 message 文本，必须读这些结构化字段。
  // message 只作兜底人类可读文案，event.error 优先。
  // 该函数不改变状态机，只构造错误对象。
  function createRecoveryFailure(
    entry: ConnectionEntry<TServices, TCapabilities>,
    event: WindowRemoteConnectionCloseEvent,
  ): Error {
    const error = new Error(event.error || `Remote connection recovery exhausted: ${entry.key}`);
    if (event.reasonCode) Object.assign(error, { code: event.reasonCode });
    if (event.retryable !== undefined) Object.assign(error, { retryable: event.retryable });
    if (event.recoveryAttempt !== undefined) {
      Object.assign(error, { recoveryAttempt: event.recoveryAttempt });
    }
    if (event.recoveryLimit !== undefined) {
      Object.assign(error, { recoveryLimit: event.recoveryLimit });
    }
    return error;
  }

  // [事务] 逆序恢复：先从 sessionsById 与 entry.sessions 摘掉 current，再把 previous 复位为 disconnected/offline 并重新入表。
  // 漏掉任一步都会留下两份同 workspace 的 session，findSessionForWorkspace 立刻变多解。
  // 必须先清 entry.recoveryReplacements，防止回滚过程中被重入。
  function rollbackRecoveryReplacements(entry: ConnectionEntry<TServices, TCapabilities>): void {
    const replacements = entry.recoveryReplacements;
    if (!replacements) return;
    entry.recoveryReplacements = undefined;
    for (const { previous, current } of replacements) {
      if (sessionsById.get(current.remoteSessionId) === current) {
        sessionsById.delete(current.remoteSessionId);
      }
      entry.sessions.delete(current.remoteSessionId);
      previous.state = "disconnected";
      previous.sourceAvailability = "offline";
      sessionsById.set(previous.remoteSessionId, previous);
      entry.sessions.add(previous.remoteSessionId);
    }
  }

  // [契约] 过滤 pending session：它们的生命周期由 connect 自己负责，不能进入 replacement。
  // 只返回 state=disconnected 的会话，connecting 不参与本轮。
  // 返回新数组，调用方可以边遍历边改表。
  function listDisconnectedSessions(
    entry: ConnectionEntry<TServices, TCapabilities>,
  ): LogicalSession<TServices, TCapabilities>[] {
    return [...entry.sessions]
      .map((remoteSessionId) => sessionsById.get(remoteSessionId))
      .filter(
        (session): session is LogicalSession<TServices, TCapabilities> =>
          Boolean(session) &&
          session?.state === "disconnected" &&
          pendingSessionsByRequestId.get(session.requestId) !== session,
      );
  }

  // [并发] 六个条件缺一不可：未 disposed、仍是 key owner、epoch 未变、entry 仍 online、current 仍在表、recoveryReplacements 命中。
  // 只比 remoteSessionId 会复活已被回滚或换代的 session。
  // 该判定同时用于 commit 前与 commit 后复核，两处必须一致。
  // 任何放宽都会让已失效的 replacement 通过 isCurrent 校验。
  function isCurrentRecoveryReplacement(
    entry: ConnectionEntry<TServices, TCapabilities>,
    current: LogicalSession<TServices, TCapabilities>,
    transitionEpoch: number,
  ): boolean {
    return (
      !entry.disposed &&
      entriesByKey.get(entry.key) === entry &&
      entry.transitionEpoch === transitionEpoch &&
      entry.state === "online" &&
      sessionsById.get(current.remoteSessionId) === current &&
      entry.recoveryReplacements?.some((replacement) => replacement.current === current) === true
    );
  }

  // [契约] 四个条件：未取消、属于该 entry、workspaceKey 相同、仍在全局表。
  // 放宽任一条件都会让释放逻辑误判「无人持有」，提前销毁他人 workspace。
  // 该函数是 hasOtherWorkspaceOwner 与 startWorkspaceRelease 的共同判定口径。
  // 不要在这里比较 workspacePath：key 已经包含 identity 语义。
  function sessionOwnsWorkspace(
    session: LogicalSession<TServices, TCapabilities>,
    entry: ConnectionEntry<TServices, TCapabilities>,
    workspaceKey: string,
  ): boolean {
    return (
      !session.cancelled &&
      session.entry === entry &&
      session.workspaceKey === workspaceKey &&
      sessionsById.get(session.remoteSessionId) === session
    );
  }

  // [并发] 必须排除自身 remoteSessionId，否则永远返回 true，释放被永久推迟到窗口关闭。
  // 遍历 sessionsById 而非 entry.sessions，以覆盖同 Source 不同 entry 的会话。
  // 只返回布尔值，不做释放决策。
  function hasOtherWorkspaceOwner(
    entry: ConnectionEntry<TServices, TCapabilities>,
    workspaceKey: string,
    excludedRemoteSessionId: string,
  ): boolean {
    return Array.from(sessionsById.values()).some(
      (candidate) =>
        candidate.remoteSessionId !== excludedRemoteSessionId &&
        sessionOwnsWorkspace(candidate, entry, workspaceKey),
    );
  }

  // workspace 释放的记账入口：登记 pendingRelease（按 generation），确认当前没有其它 session
  // 仍持有同一 workspaceKey 后才真正调用 releaseWorkspace；迟到的释放不会影响新代际。
  // 不变量：pendingRelease 只会增删自身 generation 的条目，不误删后来者的释放意图。
  // [资源] 六个前置条件：wsl、generation 匹配、无 in-flight、有 handle、online、存在 releaseWorkspace 回调。
  // releaseInFlight 用于同代际去重，新代际 acquire 会先 await 它。
  // release 失败同时抛给等待者并回调 onWorkspaceReleaseError，保证 fail-closed。
  // finally 中必须在「generation 未变、无 pendingRelease、无 owner」三条件下才删除 runtime。
  function startWorkspaceRelease(
    entry: ConnectionEntry<TServices, TCapabilities>,
    workspaceKey: string,
    state: WorkspaceRuntimeState,
    generation: number,
  ): Promise<void> | undefined {
    if (
      entry.target.kind !== "wsl" ||
      state.generation !== generation ||
      state.releaseInFlight ||
      !entry.handle ||
      entry.state !== "online" ||
      !options.releaseWorkspace
    ) {
      return state.releaseInFlight;
    }
    state.pendingReleaseGeneration = undefined;
    const release = options
      .releaseWorkspace(entry.handle.services, state.context)
      .catch((error) => {
        options.onWorkspaceReleaseError?.(state.context, error);
        throw error;
      })
      .finally(() => {
        if (state.releaseInFlight === release) {
          state.releaseInFlight = undefined;
        }
        if (
          state.generation === generation &&
          !state.pendingReleaseGeneration &&
          !Array.from(sessionsById.values()).some((candidate) =>
            sessionOwnsWorkspace(candidate, entry, workspaceKey),
          )
        ) {
          entry.workspaceRuntimeByKey.delete(workspaceKey);
        }
      });
    // release 由 dispose/running-task 事件触发；失败由结构化回调记录，同时保留 rejecting
    // Promise 给同 workspace 的下一代 acquire，使其 fail-closed 而不是踩过未完成清理。
    void release.catch(() => undefined);
    state.releaseInFlight = release;
    return release;
  }

  // [失败路径] 非 wsl、仍需保活、缺少 key 或 generation 时直接返回 undefined。
  // 有 running task 时只写 pendingReleaseGeneration，不启动释放，等计数归零补做。
  // generation 不匹配说明调用方持有旧快照，必须静默丢弃，不能释放当前 runtime。
  // 存在其它 workspace owner 时同样跳过：workspace 仍在使用。
  function requestWorkspaceRelease(params: {
    entry: ConnectionEntry<TServices, TCapabilities>;
    remoteSessionId: string;
    workspaceKey?: string;
    workspaceGeneration?: number;
  }): Promise<void> | undefined {
    const { entry, workspaceKey, workspaceGeneration } = params;
    if (
      entry.target.kind !== "wsl" ||
      shouldKeepConnectionAlive(entry) ||
      !workspaceKey ||
      !workspaceGeneration
    ) {
      return undefined;
    }
    if (hasOtherWorkspaceOwner(entry, workspaceKey, params.remoteSessionId)) {
      return undefined;
    }
    const state = entry.workspaceRuntimeByKey.get(workspaceKey);
    if (!state || state.generation !== workspaceGeneration) {
      return undefined;
    }
    if ((entry.runningTaskCountByWorkspaceKey.get(workspaceKey) ?? 0) > 0) {
      state.pendingReleaseGeneration = workspaceGeneration;
      return undefined;
    }
    return startWorkspaceRelease(entry, workspaceKey, state, workspaceGeneration);
  }

  // [失败路径] 统一 name=AbortError，调用方按 name 判定取消。
  // 不要复用 WindowRemoteConnectCancelledError：两者语义不同，一个是调用方放弃，一个是 workspace 换代。
  // message 固定，便于日志聚合。
  function abortError(): Error {
    return Object.assign(new Error("Remote workspace bind was aborted"), {
      name: "AbortError",
    });
  }

  // [资源] abort 监听必须在 finally 中移除，长连接上反复 bind 会累积 listener 并阻止 GC。
  // 已 abort 的 signal 要在挂监听前直接抛错，避免 race 的微任务顺序问题。
  // Promise.race 不会取消底层 operation：调用方仍需自行 abort 内部请求。
  // signal 缺省时直接 await，不引入额外微任务。
  async function waitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return await operation;
    if (signal.aborted) throw abortError();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  // 为 workspace 准备远端 runtime（project 绑定、用户选择、会话目录等）。
  // 键为 workspaceKey（含 generation），因此换代后一定是新的 runtime，不与旧代际共享可变状态。
  // 失败语义：prepare 失败直接上抛，调用方（bindWorkspaceContext）负责把 session 置 failed。
  // [事务] 步骤固定：identity prepare → 非 wsl 短路 → 取或建 runtime → 仅在无其它 owner 时 generation+1 → 等待旧 releaseInFlight → 复核身份后置 ready。
  // owner 已存在时不得推进 generation，否则共享 workspace 的 project 绑定会被重复执行。
  // 失败必须把 workspaceReadyState 置 failed，让 resolveScopedHandle 继续 fail-closed。
  // identity 准备失败只影响本 session，不得 abort 同 Source 的物理连接。
  // 复核阶段要同时检查 session 仍在表、未取消、runtime generation 未变。
  function prepareWorkspaceRuntime(
    session: LogicalSession<TServices, TCapabilities>,
    signal?: AbortSignal,
  ): Promise<void> {
    const expectedSessionGeneration = session.generation;
    const identityPreparation =
      session.entry.handle &&
      session.sourceServerId &&
      session.workspacePath &&
      session.workspaceIdentity &&
      options.prepareWorkspaceIdentity
        ? options.prepareWorkspaceIdentity(session.entry.handle, {
            sourceServerId: session.sourceServerId,
            workspacePath: session.workspacePath,
            stableWorkspaceIdentity: session.workspaceIdentity,
            ...(session.legacyWorkspaceIdentity
              ? { legacyRouteHint: session.legacyWorkspaceIdentity }
              : {}),
            ...(signal ? { signal } : {}),
          })
        : null;
    const identityReady = waitWithAbort(identityPreparation ?? Promise.resolve(), signal);
    if (session.entry.target.kind !== "wsl" || !session.workspacePath || !session.workspaceKey) {
      if (!identityPreparation) {
        session.workspaceReadyState = "ready";
        session.workspaceReady = Promise.resolve();
        return session.workspaceReady;
      }
      session.workspaceReadyState = "pending";
      session.workspaceReady = identityReady.then(
        () => {
          if (session.generation !== expectedSessionGeneration) throw abortError();
          session.workspaceReadyState = "ready";
        },
        (error) => {
          if (session.generation === expectedSessionGeneration) {
            session.workspaceReadyState = "failed";
          }
          throw error;
        },
      );
      return session.workspaceReady;
    }
    const workspaceKey = session.workspaceKey;
    const entry = session.entry;
    const existing = entry.workspaceRuntimeByKey.get(workspaceKey);
    const hasOtherOwner = hasOtherWorkspaceOwner(entry, workspaceKey, session.remoteSessionId);
    const state =
      existing ??
      ({
        context: {
          workspacePath: session.workspacePath,
          ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
        },
        generation: 0,
      } satisfies WorkspaceRuntimeState);
    entry.workspaceRuntimeByKey.set(workspaceKey, state);
    state.context = {
      workspacePath: session.workspacePath,
      ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
    };
    if (!hasOtherOwner) {
      state.generation += 1;
      // 上一代 release 仍因 running task 等待时，新 logical owner 已重新持有
      // workspace；尚未开始的旧 release 必须失效，不能在 task 归零后误清新 runtime。
    }
    state.pendingReleaseGeneration = undefined;
    session.workspaceGeneration = state.generation;
    session.workspaceReadyState = "pending";
    const releaseToWait = state.releaseInFlight;
    const ready = Promise.all([identityReady, releaseToWait ?? Promise.resolve()])
      .then(() => {
        if (
          sessionsById.get(session.remoteSessionId) !== session ||
          session.cancelled ||
          entry.workspaceRuntimeByKey.get(workspaceKey)?.generation !== session.workspaceGeneration
        ) {
          throw new WindowRemoteConnectCancelledError();
        }
        session.workspaceReadyState = "ready";
      })
      .catch((error) => {
        session.workspaceReadyState = "failed";
        throw error;
      });
    session.workspaceReady = ready;
    return ready;
  }

  // [资源] 只在 wsl、未 disposed、无 session、无 running task 时排计时器。
  // 回调内再次复核 owner 身份与空闲条件，防止延迟期间被复用。
  // 每次调用先清旧计时器，保证同一 entry 只有一个待触发的空闲释放。
  // 释放走 disposeEntry，复用同一条幂等路径。
  function scheduleWslIdleDispose(
    entry: ConnectionEntry<TServices, TCapabilities>,
    reason: string,
  ): void {
    clearIdleTimer(entry);
    entry.idleReason = reason;
    if (
      entry.target.kind !== "wsl" ||
      entry.disposed ||
      entry.sessions.size > 0 ||
      hasRunningTasks(entry)
    ) {
      return;
    }
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (
        entriesByKey.get(entry.key) !== entry ||
        entry.disposed ||
        entry.sessions.size > 0 ||
        hasRunningTasks(entry)
      ) {
        return;
      }
      void disposeEntry(entry);
    }, wslIdleTtlMs);
  }

  // 释放 entry 的全部资源：标记 disposed（后续 then 分支据此只释放不发布）、清 idle timer、
  // 释放所有 workspace runtime、释放 handle 订阅与 transport，最后从两张索引表移除。
  // 顺序：先置 disposed 再 await 释放，保证重入调用与迟到的异步回调都能看到终态。
  // [资源] disposePromise 做幂等，重入直接返回同一 promise。
  // 先置 disposed、closing，abort 信号并摘订阅，最后才 await handle.dispose。
  // 顺序不能颠倒：先 await 再置位会让迟到回调看到仍可用的 entry。
  // dispose 前必须 failRecovery，否则等待重连的 connect 永久悬挂。
  async function disposeEntry(entry: ConnectionEntry<TServices, TCapabilities>): Promise<void> {
    if (entry.disposePromise) {
      return entry.disposePromise;
    }
    entry.disposed = true;
    clearIdleTimer(entry);
    if (entry.replacementRetryTimer) clearTimeout(entry.replacementRetryTimer);
    entry.replacementRetryTimer = undefined;
    failRecovery(entry, new WindowRemoteConnectCancelledError());
    entry.state = "closing";
    entry.abortController.abort();
    entry.closeSubscription?.dispose();
    entry.closeSubscription = undefined;
    entry.reconnectSubscription?.dispose();
    entry.reconnectSubscription = undefined;
    removeEntryOwners(entry);
    options.onConnectionChanged?.();
    entry.disposePromise = Promise.resolve(entry.handle?.dispose()).then(() => undefined);
    return entry.disposePromise;
  }

  // [资源] 只回收 wrapper 与 Manager 订阅，不断开物理 Source（物理连接归 Manager 持有）。
  // 先把已不可路由的 disconnected session 摘掉，否则每轮手动重连都会累积一代离线 session。
  // pending session 必须保留：它仍可能被 connect 的 then 分支使用。
  // abort 只能取消 transport，不能结束 connect 对 recoveryReady 的等待，因此要主动 failRecovery。
  async function disposeSupersededEntryTransport(
    entry: ConnectionEntry<TServices, TCapabilities>,
  ): Promise<void> {
    if (entry.disposePromise) return entry.disposePromise;
    // Bug 原因：自动恢复的旧 entry 在手动重连抢占 connection key 后只是 return，
    // 旧 handle 上的 Manager state/reconnect 订阅永不释放。这里只回收失去 owner 的 transport
    // wrapper。旧 logical session 已经不可路由，必须在新 owner 接管时同步退休；否则每轮
    // 手动重连都会累积一份 disconnected session，下一次断开后 workspace scope 变成多解。
    for (const remoteSessionId of entry.sessions) {
      const session = sessionsById.get(remoteSessionId);
      if (
        !session ||
        session.entry !== entry ||
        session.state !== "disconnected" ||
        pendingSessionsByRequestId.get(session.requestId) === session
      ) {
        continue;
      }
      sessionsById.delete(remoteSessionId);
      entry.sessions.delete(remoteSessionId);
    }
    entry.disposed = true;
    clearIdleTimer(entry);
    if (entry.replacementRetryTimer) clearTimeout(entry.replacementRetryTimer);
    entry.replacementRetryTimer = undefined;
    // Bug 原因：abort 只取消 transport，不能结束 connect 对 recoveryReady 的等待。
    // 旧 entry 被抢占后不再收到恢复事件，必须在释放订阅前主动拒绝其等待者。
    failRecovery(entry, new WindowRemoteConnectCancelledError());
    entry.abortController.abort();
    entry.closeSubscription?.dispose();
    entry.closeSubscription = undefined;
    entry.reconnectSubscription?.dispose();
    entry.reconnectSubscription = undefined;
    entry.disposePromise = Promise.resolve(entry.handle?.dispose()).then(() => undefined);
    return entry.disposePromise;
  }

  // 物理连接关闭的统一处理：按 recoverable 分两路——可恢复则 beginRecovery + 代换 session，
  // 不可恢复则直接把该 entry 的 session 全部置 disconnected/failed 并通知上层。
  // 幂等/防重：closePhase 与对象身份判定保证同一次关闭不会重复触发替换（重复 close 直接忽略）。
  // [并发] 入口先撤销 replacementRetryTimer：断开后旧逻辑重试会冒充重连把 entry 标回 online。
  // 已 closing 或 disposed 的 entry 直接忽略，保证同一次关闭不重复推进。
  // disconnected 分支只按 recoveryAttempt 去重后重播进度，不退化为 terminal。
  // 首次关闭才 transitionEpoch += 1，并据 recoverable 显式值落 closePhase。
  // terminal 到达时先 rollback 已发布的 replacement，再拒绝 recovery flight。
  function handleConnectionClosed(
    entry: ConnectionEntry<TServices, TCapabilities>,
    event: WindowRemoteConnectionCloseEvent,
  ): void {
    // Bug 原因：逻辑替换重试曾跨物理断线存活，定时器会冒充重连把 entry 标回 online，
    // 耗尽预算后还会提前放行 recovery waiter。close 必须撤销旧 transport 的逻辑重试。
    if (entry.replacementRetryTimer) clearTimeout(entry.replacementRetryTimer);
    entry.replacementRetryTimer = undefined;
    if (entry.disposed || entry.state === "closing") return;
    if (entry.state === "disconnected") {
      if (entry.closePhase === "recovering" && event.recoverable !== false) {
        if (
          event.recoveryAttempt !== undefined &&
          event.recoveryAttempt !== entry.lastRecoveryAttemptNotified
        ) {
          // Bug 原因：Manager 会发布 1/3、2/3、3/3，但 registry 曾把 disconnected 后的
          // recoverable close 全部丢弃，Renderer 永远停在首轮。只按 attempt 去重并继续投影。
          entry.lastRecoveryAttemptNotified = event.recoveryAttempt;
          notifyEntrySessionsClosed(entry, event);
        }
        return;
      }
      if (entry.closePhase !== "recovering" || event.recoverable !== false) return;
      entry.transitionEpoch += 1;
      entry.closePhase = "terminal";
      failRecovery(entry, createRecoveryFailure(entry, event));
      notifyEntrySessionsClosed(entry, event);
      return;
    }
    entry.transitionEpoch += 1;
    const hadRecoveryReplacement = Boolean(entry.recoveryReplacements?.length);
    if (hadRecoveryReplacement) {
      rollbackRecoveryReplacements(entry);
    }
    if (
      (entry.state === "connecting" || hadRecoveryReplacement || Boolean(entry.recoveryReady)) &&
      event.recoverable === false
    ) {
      // Bug 原因：恢复换代已经先发布了 provisional session id，终态 close 若直接沿用它，
      // Renderer 会收到一个从未完成连接的幽灵 id；同时 recoveryReady 无人 reject，join 永久等待。
      // 终态到达时先恢复上一代 logical session，再拒绝 recovery flight 并广播真实离线 owner。
      failRecovery(entry, createRecoveryFailure(entry, event));
    }
    entry.state = "disconnected";
    options.onConnectionChanged?.();
    entry.closePhase = event.recoverable === true ? "recovering" : "terminal";
    entry.lastRecoveryAttemptNotified = event.recoveryAttempt;
    if (entry.closePhase === "recovering") beginRecovery(entry);
    clearIdleTimer(entry);
    if (!shouldKeepConnectionAlive(entry) && entriesByKey.get(entry.key) === entry) {
      entriesByKey.delete(entry.key);
    }
    for (const remoteSessionId of entry.sessions) {
      const session = sessionsById.get(remoteSessionId);
      if (!session || pendingSessionsByRequestId.get(session.requestId) === session) continue;
      session.state = "disconnected";
      session.sourceAvailability = "offline";
      options.onSessionClosed?.({ remoteSessionId, ...event });
    }
  }

  // 恢复期间用同一 Source 的新 entry 替换旧 entry 的 session：逐个绑定到新 handle 的 workspace
  // runtime，并把旧 workspaceRuntime 置 pendingRelease。
  // 失败回滚：任一 session 绑定失败就 rollbackRecoveryReplacements，恢复整体维持旧状态，
  // 由 scheduleLogicalReplacementRetry 决定下一次重试（不会留下「一半新一半旧」的会话集）。
  // [事务] 每个 session 独立事务：记录 previous 与 current，prepare 后过 isCurrentRecoveryReplacement 才 commit。
  // commit 是不可逆边界，之后的异常只能上报，不得回滚已发布的 generation。
  // 单个 workspace 失败只回滚自身并继续 sibling，最后再抛第一个错误。
  // stale、disposed、entry 换代必须整轮上抛，终止后续替换。
  // entry.state 先置 online，表示物理 Source 已恢复；单点失败不得改回 disconnected。
  async function replaceDisconnectedSessions(
    entry: ConnectionEntry<TServices, TCapabilities>,
  ): Promise<void> {
    if (
      entry.disposed ||
      !entry.handle ||
      (entry.state !== "disconnected" && entry.state !== "online")
    )
      return;
    const transitionEpoch = entry.transitionEpoch;
    // 物理 Source 已经恢复；logical replacement 的失败只属于对应 workspace，不能把
    // 已提交 sibling 的共享 transport 再标回 disconnected。
    entry.state = "online";
    entriesByKey.set(entry.key, entry);
    const disconnectedSessions = listDisconnectedSessions(entry);
    let firstReplacementError: unknown;
    let hasReplacementError = false;
    for (const previous of disconnectedSessions) {
      if (
        entry.disposed ||
        entriesByKey.get(entry.key) !== entry ||
        entry.transitionEpoch !== transitionEpoch ||
        entry.state !== "online"
      ) {
        throw new WindowRemoteConnectionTransitionStaleError();
      }
      if (
        sessionsById.get(previous.remoteSessionId) !== previous ||
        previous.state !== "disconnected"
      ) {
        continue;
      }
      const current: LogicalSession<TServices, TCapabilities> = {
        ...previous,
        remoteSessionId: options.createId(),
        target: entry.target,
        generation: previous.generation + 1,
        state: "connecting",
        sourceAvailability: "offline",
        sourceServerId: options.resolveSourceServerId?.(entry.handle) ?? previous.sourceServerId,
        workspaceReady: Promise.resolve(),
        workspaceReadyState: "pending",
        cancelled: false,
        rejectCancellation: () => undefined,
        cancellation: new Promise<never>(() => undefined),
      };
      entry.recoveryReplacements = [{ previous, current }];
      entry.sessions.delete(previous.remoteSessionId);
      sessionsById.delete(previous.remoteSessionId);
      sessionsById.set(current.remoteSessionId, current);
      entry.sessions.add(current.remoteSessionId);
      try {
        await prepareWorkspaceRuntime(current);
        if (!isCurrentRecoveryReplacement(entry, current, transitionEpoch)) {
          throw new WindowRemoteConnectionTransitionStaleError();
        }
        const commit = (): boolean => {
          if (!isCurrentRecoveryReplacement(entry, current, transitionEpoch)) {
            return false;
          }
          current.state = "online";
          current.sourceAvailability = "online";
          // 当前 workspace 的外部 owner 已提交；后续 sibling 失败不得再回滚本 generation。
          entry.recoveryReplacements = undefined;
          return true;
        };
        if (options.onSessionReconnected) {
          await options.onSessionReconnected({
            previous: toSessionSnapshot(previous),
            current: toSessionSnapshot(current),
            services: entry.handle.services,
            isCurrent: () => isCurrentRecoveryReplacement(entry, current, transitionEpoch),
            commit,
          });
        } else {
          commit();
        }
        if (
          sessionsById.get(current.remoteSessionId) !== current ||
          current.state !== "online" ||
          current.sourceAvailability !== "online" ||
          entry.recoveryReplacements !== undefined
        ) {
          throw new WindowRemoteConnectionTransitionStaleError();
        }
      } catch (error) {
        rollbackRecoveryReplacements(entry);
        if (
          sessionsById.get(current.remoteSessionId) === current &&
          current.state === "online" &&
          current.sourceAvailability === "online" &&
          entry.recoveryReplacements === undefined
        ) {
          // commit 是不可逆边界；提交后的旁路日志/通知异常只能上报，不能把已经对外发布的
          // generation 再塞回 rollback 路径。
          options.onSessionReconnectError?.(error);
          continue;
        }
        if (
          error instanceof WindowRemoteConnectionTransitionStaleError ||
          entry.disposed ||
          entriesByKey.get(entry.key) !== entry ||
          entry.transitionEpoch !== transitionEpoch ||
          entry.state !== "online"
        ) {
          throw new WindowRemoteConnectionTransitionStaleError();
        }
        // 单个 workspace 的 replacement 失败不能阻断同一 Source 上后续 sibling；继续提交
        // 其余 workspace，最后只为仍 disconnected 的 owner 安排下一轮 retry。
        if (!hasReplacementError) firstReplacementError = error;
        hasReplacementError = true;
      }
    }
    if (hasReplacementError) throw firstReplacementError;
    completeRecovery(entry);
  }

  // [失败路径] 预算耗尽只对仍离线的 session 广播不可恢复，然后 completeRecovery，不污染在线 Source entry。
  // 定时器回调必须校验 state 与 transitionEpoch，避免迟到回调摘掉新 epoch 的 timer。
  // 重试前先清旧 timer，保证同一 entry 至多一个待执行重试。
  // entry 已在线且无离线 session 时直接返回，不做无意义调度。
  function scheduleLogicalReplacementRetry(
    entry: ConnectionEntry<TServices, TCapabilities>,
    attempt: number,
    error: unknown,
  ): void {
    const delay = logicalReplacementRetryDelaysMs[attempt];
    if (entry.disposed || entry.state !== "online" || listDisconnectedSessions(entry).length === 0)
      return;
    if (delay === undefined) {
      const terminalError = error instanceof Error ? error : new Error(String(error));
      for (const session of listDisconnectedSessions(entry)) {
        options.onSessionClosed?.({
          remoteSessionId: session.remoteSessionId,
          exitCode: null,
          signal: null,
          recoverable: false,
          error: terminalError.message,
          ...("code" in terminalError && typeof terminalError.code === "string"
            ? { reasonCode: terminalError.code }
            : {}),
          ...("retryable" in terminalError && typeof terminalError.retryable === "boolean"
            ? { retryable: terminalError.retryable }
            : {}),
        });
      }
      // logical replacement 预算耗尽不能污染仍在线的 Source entry；等待中的手动 join
      // 继续使用已恢复 transport，并由自身 workspace admission 决定结果。
      completeRecovery(entry);
      return;
    }
    if (entry.replacementRetryTimer) clearTimeout(entry.replacementRetryTimer);
    const retryEpoch = entry.transitionEpoch;
    entry.replacementRetryTimer = setTimeout(() => {
      // 迟到回调只属于安排时仍在线的 transport；先校验，避免摘掉新 epoch 的 timer。
      if (entry.state !== "online" || entry.transitionEpoch !== retryEpoch) return;
      entry.replacementRetryTimer = undefined;
      handleConnectionReconnected(entry, attempt + 1);
    }, delay);
  }

  // [并发] reconnectFlight 去重：同一时刻只允许一轮替换在跑。
  // connection key 已有新 owner 时旧 flight 必须失效，只回收 transport，不写回索引。
  // terminal 之后到达的新连接会把 closePhase 拉回 recovering 并重建屏障。
  // replace 失败时若仍有离线 session 则安排重试，stale 不重试。
  function handleConnectionReconnected(
    entry: ConnectionEntry<TServices, TCapabilities>,
    attempt = 0,
  ): void {
    if (
      entry.reconnectFlight ||
      entry.disposed ||
      (entry.state !== "disconnected" && entry.state !== "online")
    )
      return;
    const currentOwner = entriesByKey.get(entry.key);
    if (currentOwner && currentOwner !== entry) {
      // Bug 原因：自动 retry 与用户手动重连可能共享 Manager 的新 connection。迟到的旧 entry
      // 曾无条件 set 回 connection key，制造两个 online logical session 并互相 dispose。
      // connection key 已有新 owner 时，旧恢复 flight 必须失效，交给 Host 清理离线 session。
      void disposeSupersededEntryTransport(entry);
      return;
    }
    if (entry.closePhase === "terminal") {
      // 新物理连接到达后，旧终态失败不能污染新线路的 join；挂回完成前用新屏障等待。
      entry.closePhase = "recovering";
      beginRecovery(entry);
    }
    let shouldRetry = false;
    let retryError: unknown;
    const flight = replaceDisconnectedSessions(entry)
      .catch((error) => {
        options.onSessionReconnectError?.(error);
        shouldRetry =
          !(error instanceof WindowRemoteConnectionTransitionStaleError) &&
          listDisconnectedSessions(entry).length > 0;
        retryError = error;
      })
      .finally(() => {
        if (entry.reconnectFlight === flight) entry.reconnectFlight = undefined;
        if (shouldRetry) scheduleLogicalReplacementRetry(entry, attempt, retryError);
      });
    entry.reconnectFlight = flight;
  }

  // 建立 entry 并立即发起物理连接：entry 先入表（connecting），成功后按 owner 归属决定
  // 「成为 owner / 加入既有 owner / 释放」，失败则把本 entry 的全部 session 置 failed 并清除。
  // 关键时序：entry.disposed 与 sessions.size===0 都要在 then 中复查——底层握手可能无法中断，
  // 迟到的成功结果必须立即释放而不是复活连接（见下方修复注释）。
  // [并发] entry 先入表再发起连接，保证并发 connect 复用同一 flight。
  // then 中三条早退：已 disposed、无 session 且不保活、sourceServerId 与快速路径不符；每条都要释放迟到 handle。
  // 握手可能不可中断，迟到的成功结果绝不能复活已有 entry。
  // catch 中把 session 置 failed、清空集合并抛原始错误。
  // reusedConnectionTarget 在发布 online 前回填，保证上层看到真实复用目标。
  function createEntry(params: {
    key: string;
    membershipIntent?: "add" | "retain";
    existingSourceServerId?: string;
    target: RemoteTarget;
    remoteAssets: WindowRemoteAssetDirs;
    confirmSourceServerInstall?: boolean;
  }): ConnectionEntry<TServices, TCapabilities> {
    const abortController = new AbortController();
    const entry: ConnectionEntry<TServices, TCapabilities> = {
      key: params.key,
      target: params.target,
      state: "connecting" as const,
      abortController,
      sessions: new Set<string>(),
      ready: Promise.resolve(undefined as never),
      disposed: false,
      transitionEpoch: 0,
      closePhase: "none",
      idleReason: "wsl-host-idle",
      workspaceKeys: new Set(),
      runningTaskCountByWorkspaceKey: new Map(),
      workspaceRuntimeByKey: new Map(),
    };
    entry.ready = options
      .connect({
        target: params.target,
        membershipIntent: params.membershipIntent,
        existingSourceServerId: params.existingSourceServerId,
        remoteAssets: params.remoteAssets,
        signal: abortController.signal,
        ...(params.confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
      })
      .then(async (handle) => {
        // 关闭可能早于不可中断的握手返回；disposePromise 已完成时仍必须释放迟到的 socket。
        if (entry.disposed) {
          await handle.dispose();
          return handle;
        }
        entry.handle = handle;
        if (entry.disposed || (entry.sessions.size === 0 && !shouldKeepConnectionAlive(entry))) {
          // 修复原因：底层 SSH/WSL connector 可能无法中断认证或部署。
          // 最后一个 logical owner 取消后，迟到的成功结果必须立即释放，不能复活旧连接。
          await disposeEntry(entry);
          return handle;
        }
        const sourceServerId = options.resolveSourceServerId?.(handle);
        if (params.existingSourceServerId && sourceServerId !== params.existingSourceServerId) {
          await disposeEntry(entry);
          throw new WindowRemoteConnectionUnavailableError(params.existingSourceServerId);
        }
        const sourceOwner = sourceServerId
          ? await promoteOrJoinSourceOwner(entry, handle, sourceServerId)
          : entry;
        if (sourceOwner !== entry) return handle;
        entry.target = handle.reusedConnectionTarget ?? entry.target;
        entry.state = "online";
        subscribeEntryHandle(entry, handle);
        options.onConnectionChanged?.();
        for (const remoteSessionId of entry.sessions) {
          const session = sessionsById.get(remoteSessionId);
          if (!session || session.cancelled) {
            continue;
          }
          session.target = entry.target;
          session.state = "online";
          session.sourceAvailability = "online";
          if (sourceServerId) {
            applyStableWorkspaceIdentity(session, sourceServerId);
          }
        }
        return handle;
      })
      .catch((error) => {
        entry.state = "failed";
        removeEntryOwners(entry);
        options.onConnectionChanged?.();
        for (const remoteSessionId of Array.from(entry.sessions)) {
          const session = sessionsById.get(remoteSessionId);
          if (!session) {
            continue;
          }
          session.state = "failed";
          session.sourceAvailability = "offline";
          sessionsById.delete(remoteSessionId);
          pendingSessionsByRequestId.delete(session.requestId);
        }
        entry.sessions.clear();
        throw error;
      });
    entriesByKey.set(entry.key, entry);
    options.onConnectionChanged?.();
    return entry;
  }

  // 按 key 复用或新建 entry：只有 online/connecting 或「正在 recovering 且允许保活」的
  // disconnected entry 可复用；terminal entry 会被新 entry 顶掉并异步释放旧 wrapper。
  // 复用前必须 clearIdleTimer，否则 wsl 空闲计时器会在新会话建立后误释放连接。
  // [权衡] 仅 online/connecting 或 recovering 且保活的 disconnected 可复用；terminal entry 会被新 entry 顶掉。
  // 复用前必须 clearIdleTimer，否则新建会话后会被空闲计时器回收。
  // 顶掉后异步 disposeSupersededEntryTransport，避免 Manager 订阅泄漏一代。
  // 这里不复核 workspace 身份：连接复用只按物理线路 key。
  function resolveEntry(params: {
    key: string;
    membershipIntent?: "add" | "retain";
    existingSourceServerId?: string;
    target: RemoteTarget;
    remoteAssets: WindowRemoteAssetDirs;
    confirmSourceServerInstall?: boolean;
  }): ConnectionEntry<TServices, TCapabilities> {
    const existing = entriesByKey.get(params.key);
    if (
      existing &&
      !existing.disposed &&
      !existing.abortController.signal.aborted &&
      (existing.state !== "disconnected" ||
        (existing.closePhase === "recovering" && shouldKeepConnectionAlive(existing)))
    ) {
      clearIdleTimer(existing);
      return existing;
    }
    const created = createEntry(params);
    if (existing && existing !== created) {
      // Bug 原因：terminal entry 被新 owner 覆盖后仍保留 Manager close/reconnect 订阅，
      // 每次手动重连都会泄漏一代 wrapper。物理 Source 仍由 Manager 持有，只回收 wrapper。
      void disposeSupersededEntryTransport(existing);
    }
    return created;
  }

  // 对外连接入口：创建/复用 entry，登记 logical session，等待 entry.ready，再绑定 workspace 上下文。
  // 输入：requestId（session 级幂等键，重复即抛错）、target/remoteAssets、可选 workspace 上下文、
  //   以及 admission（host capability 层已建好的连接，用于跳过自建 entry）。
  // 输出：WindowHostRemoteWorkspaceDescriptor（含 sessionId、generation、workspace identity）。
  // 副作用：建立物理连接、发 onConnectionChanged、可能写 workspace history（prepareWorkspaceIdentity）。
  // 失败语义：参数冲突、握手失败、workspace 校验失败都抛错；失败时清理 pending session 与 entry。
  // 不变量：await 之后所有写回都要重新确认 session 仍存在且未被取消（cancelled 标记）。
  // [事务] requestId 幂等：重复直接抛错，调用方需自行换 id。
  // admission 路径跳过自建 entry，但要求 handle.services 与传入 services 完全一致。
  // await 之后必须复核六项：未取消、仍在表、entry 未 disposed、仍为 key owner、epoch 未变、在线。
  // finally 中 abort preparation 信号并清 pending 表，保证迟到 stat 不会进入身份绑定。
  async function connect(
    params: {
      requestId: string;
      target: RemoteTarget;
      remoteAssets: WindowRemoteAssetDirs;
      workspacePath?: string;
      workspaceIdentity?: string;
      workspacePurpose?: WorkspacePurpose;
      confirmSourceServerInstall?: boolean;
    },
    admission?: {
      entry: ConnectionEntry<TServices, TCapabilities>;
      services: TServices;
      assertCurrent(): Promise<void>;
    },
  ): Promise<WindowHostRemoteWorkspaceDescriptor> {
    if (disposed) {
      throw new Error("窗口 Host 的远程连接 registry 已释放");
    }
    if (pendingSessionsByRequestId.has(params.requestId)) {
      throw new Error(`远程连接 requestId 重复，requestId=${params.requestId}`);
    }

    const remoteSessionId = options.createId();
    const key = buildConnectionKey(params.target);
    const previousEntry = entriesByKey.get(key);
    const initialEntry =
      admission?.entry ??
      resolveEntry({
        key,
        target: params.target,
        remoteAssets: params.remoteAssets,
        ...(params.confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
      });
    let reusedConnectionTarget =
      initialEntry.state === "online" ? stripRemoteTargetSecrets(initialEntry.target) : undefined;
    let rejectCancellation!: (error: WindowRemoteConnectCancelledError) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const sourceServerId = initialEntry.handle
      ? options.resolveSourceServerId?.(initialEntry.handle)
      : undefined;
    // 复用已在线的 Host 时不会再触发握手回调，仍须先绑定稳定 workspace 身份。
    const workspaceIdentity =
      sourceServerId && params.workspacePath
        ? buildServerRemoteWorkspaceIdentity({
            serverId: sourceServerId,
            workspacePath: params.workspacePath,
          })
        : params.workspaceIdentity;
    const session: LogicalSession<TServices, TCapabilities> = {
      ...(sourceServerId ? { sourceServerId } : {}),
      remoteSessionId,
      requestId: params.requestId,
      target: initialEntry.target,
      ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(params.workspacePurpose ? { workspacePurpose: params.workspacePurpose } : {}),
      ...(params.workspaceIdentity ? { legacyWorkspaceIdentity: params.workspaceIdentity } : {}),
      generation: 1,
      state: initialEntry.state === "online" ? "online" : "connecting",
      sourceAvailability: initialEntry.state === "online" ? "online" : "offline",
      entry: initialEntry,
      workspaceReady: Promise.resolve(),
      workspaceReadyState: "pending",
      cancelled: false,
      rejectCancellation,
      cancellation,
    };
    initialEntry.sessions.add(remoteSessionId);
    if (sourceServerId) {
      // Bug 原因：entry 已在线时 connect 能直接拿到 sourceServerId，却没有像握手上线、Source owner
      // 转交和 bindWorkspaceContext 那样把 identity 归一成 remote:server:*。Renderer 对未换代的
      // legacy 条目手动重连、或 Host 为无 context 的 connect 补 route identity 时，owner 去重按原值
      // 比对必然不命中，会为同一 workspace 发布第二个 online logical session，并把 legacy identity
      // 当权威值返回；随后 bind 把它改写成 stable，两条 session 同 key，findSessionForWorkspace 多解。
      applyStableWorkspaceIdentity(session, sourceServerId);
    }
    if (!session.workspaceKey) {
      const initialWorkspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
      if (initialWorkspaceKey) {
        initialEntry.workspaceKeys.add(initialWorkspaceKey);
        session.workspaceKey = initialWorkspaceKey;
      }
    }
    sessionsById.set(remoteSessionId, session);
    pendingSessionsByRequestId.set(params.requestId, session);
    const preparationController = new AbortController();

    try {
      const initialTransitionEpoch = initialEntry.transitionEpoch;
      const readyHandle = await Promise.race([initialEntry.ready, cancellation]);
      reusedConnectionTarget ??= readyHandle.reusedConnectionTarget;
      // 加入别人的 connecting entry 也没有使用本次凭据；以最终 owner 的实际目标投影结果。
      if (previousEntry === initialEntry) {
        reusedConnectionTarget = stripRemoteTargetSecrets(session.entry.target);
      }
      const entry = session.entry;
      const transitionEpoch =
        entry === initialEntry ? initialTransitionEpoch : entry.transitionEpoch;
      if (entry.recoveryFailure) throw entry.recoveryFailure;
      if (entry.recoveryReady) {
        await Promise.race([entry.recoveryReady, cancellation]);
      }
      if (entry.recoveryFailure) throw entry.recoveryFailure;
      await Promise.race([
        prepareWorkspaceRuntime(session, preparationController.signal),
        cancellation,
      ]);
      if (admission) await Promise.race([admission.assertCurrent(), cancellation]);
      if (
        session.cancelled ||
        sessionsById.get(remoteSessionId) !== session ||
        entry.disposed ||
        entriesByKey.get(entry.key) !== entry ||
        entry.transitionEpoch !== transitionEpoch ||
        entry.state !== "online" ||
        (admission && entry.handle?.services !== admission.services)
      ) {
        if (!session.cancelled && sessionsById.get(remoteSessionId) === session) {
          throw new WindowRemoteConnectionUnavailableError(remoteSessionId);
        }
        throw new WindowRemoteConnectCancelledError();
      }
      const existingWorkspaceOwner =
        session.workspaceKey && session.workspacePath && session.workspaceIdentity
          ? Array.from(sessionsById.values()).find(
              (candidate) =>
                candidate !== session &&
                // Bug 根因：Manager 已按 sourceServerId 复用物理连接，但 Registry 曾只在
                // 同 route entry 内查找 workspace owner。不同 Profile 握手到同一 Source 后
                // 必须按稳定 Source 身份收敛；未识别 Source 仍只允许同 entry 复用。
                (candidate.entry === entry ||
                  (session.sourceServerId !== undefined &&
                    candidate.sourceServerId === session.sourceServerId)) &&
                candidate.workspaceKey === session.workspaceKey &&
                candidate.workspacePath === session.workspacePath &&
                candidate.workspaceIdentity === session.workspaceIdentity &&
                candidate.state === "online" &&
                candidate.sourceAvailability === "online" &&
                // Bug 原因：entry online 会先把 logical session 标成 online，但 workspace identity
                // preparation 可能仍在运行。join 只能复用已经可安全暴露 scoped services 的 owner。
                candidate.workspaceReadyState === "ready",
            )
          : undefined;
      if (existingWorkspaceOwner) {
        // Bug 原因：recovery replacement 与 Bot/手动 join 曾各创建一个 online logical
        // session。workspace owner 已恢复时，join caller 复用唯一 owner，不发布第二份 session。
        sessionsById.delete(remoteSessionId);
        entry.sessions.delete(remoteSessionId);
        if (existingWorkspaceOwner.entry !== entry && entry.sessions.size === 0) {
          // 不同 Profile 创建的 provisional wrapper 已失去最后一个 logical owner；只回收
          // wrapper/Manager 订阅，handle.dispose 不会断开 Manager 持有的物理 Source connection。
          await disposeEntry(entry);
        }
        return {
          ...(existingWorkspaceOwner.sourceServerId
            ? { sourceServerId: existingWorkspaceOwner.sourceServerId }
            : {}),
          ...(reusedConnectionTarget ? { reusedConnectionTarget } : {}),
          remoteSessionId: existingWorkspaceOwner.remoteSessionId,
          target: stripRemoteTargetSecrets(existingWorkspaceOwner.target),
          workspacePath: existingWorkspaceOwner.workspacePath,
          workspaceIdentity: existingWorkspaceOwner.workspaceIdentity,
          ...(existingWorkspaceOwner.workspacePurpose
            ? { workspacePurpose: existingWorkspaceOwner.workspacePurpose }
            : {}),
          generation: existingWorkspaceOwner.generation,
        };
      }
      session.state = "online";
      session.sourceAvailability = "online";
      return {
        ...(reusedConnectionTarget ? { reusedConnectionTarget } : {}),
        ...(session.sourceServerId ? { sourceServerId: session.sourceServerId } : {}),
        remoteSessionId,
        target: stripRemoteTargetSecrets(session.target),
        ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}),
        ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
        ...(session.workspacePurpose ? { workspacePurpose: session.workspacePurpose } : {}),
        generation: session.generation,
      };
    } catch (error) {
      const entry = session.entry;
      if (sessionsById.get(remoteSessionId) === session) {
        sessionsById.delete(remoteSessionId);
        entry.sessions.delete(remoteSessionId);
        session.state = "failed";
        session.sourceAvailability = "offline";
        if (
          entry.sessions.size === 0 &&
          !shouldKeepConnectionAlive(entry) &&
          (entry.target.kind === "docker" || entry.target.kind === "server")
        ) {
          await disposeEntry(entry);
        }
      }
      throw error;
    } finally {
      // logical caller 取消或已结束后，迟到的远端 stat 不得再进入身份绑定；信号只属于
      // 这次 preparation，不能 abort 同 Source 其他工作区共用的物理连接。
      preparationController.abort();
      if (pendingSessionsByRequestId.get(params.requestId) === session) {
        pendingSessionsByRequestId.delete(params.requestId);
      }
    }
  }

  // 取消一次尚未完成的连接：把对应 session 标记 cancelled、从 pending 表摘除并把 state 置
  // disconnected，最后才 abort entry（若 entry 已无其它 session 才真正断物理连接）。
  // 为什么先标 cancelled：握手的 then 分支会据此跳过写回，避免取消后连接状态被覆盖成 online。
  // [失败路径] 先标 cancelled 再摘表、再 rejectCancellation，握手 then 分支据此跳过写回。
  // 之后按 target.kind 分派：ssh connecting 出表并 abort、docker/server 只出表。
  // 保活 Source 只释放 wrapper；wsl online 排 idle；ssh online 只清计时器。
  // 出表必须复核 entriesByKey.get(key) === entry，不能误删新连接。
  function cancelConnect(requestId: string): void {
    const session = pendingSessionsByRequestId.get(requestId);
    if (!session || session.cancelled) {
      return;
    }
    session.cancelled = true;
    pendingSessionsByRequestId.delete(requestId);
    sessionsById.delete(session.remoteSessionId);
    session.entry.sessions.delete(session.remoteSessionId);
    const workspaceRelease = requestWorkspaceRelease({
      entry: session.entry,
      remoteSessionId: session.remoteSessionId,
      workspaceKey: session.workspaceKey,
      workspaceGeneration: session.workspaceGeneration,
    });
    void workspaceRelease?.catch(() => undefined);
    session.rejectCancellation(new WindowRemoteConnectCancelledError());
    if (session.entry.sessions.size === 0) {
      if (session.entry.target.kind === "ssh" && session.entry.state === "connecting") {
        // Bug 根因：最后一个 waiter 取消后，旧 entry 仍以 connecting 留在复用表；立即重连会
        // 继续等待已经 aborted 的 readiness，并沿用上一次凭据。先按对象身份退休旧 entry，
        // 再触发底层取消；迟到的旧 completion 不能删除或复活同 key 的新连接。
        if (entriesByKey.get(session.entry.key) === session.entry) {
          entriesByKey.delete(session.entry.key);
        }
        session.entry.state = "closing";
        session.entry.abortController.abort();
      } else if (
        (session.entry.target.kind === "docker" || session.entry.target.kind === "server") &&
        session.entry.state === "connecting"
      ) {
        // Bug 根因：Docker/Server 的 pending transport 不可被 logical cancel 中断，但也不能继续
        // 占用 connection key，否则下一次 dedicated connect 会错误复用已经没有 waiter 的旧 flight。
        if (entriesByKey.get(session.entry.key) === session.entry) {
          entriesByKey.delete(session.entry.key);
        }
      } else if (shouldKeepConnectionAlive(session.entry)) {
        // Managed Source 的物理连接归 Manager；registry handle 只持有 logical wrapper/订阅。
        void disposeEntry(session.entry);
      } else if (session.entry.target.kind === "wsl" && session.entry.state === "online") {
        scheduleWslIdleDispose(session.entry, "cancelled-logical-connect");
      } else if (session.entry.target.kind === "ssh" && session.entry.state === "online") {
        // ready SSH connection 是窗口 cache；取消一次 logical attach 不应把后续 workspace 的
        // 复用连接一并销毁，真实窗口 Host shutdown 时统一释放。
        clearIdleTimer(session.entry);
      } else if (session.entry.handle) {
        void disposeEntry(session.entry);
      }
    }
  }

  // 绑定 logical session 的 workspace 上下文（连接建立后再调用）。
  // 每次绑定的实质是「换代」：generation += 1、workspaceKey 重算，旧 workspaceRuntime 转入
  // pendingRelease 并在确认无其他 owner 后异步释放；workspace 未变时直接复用现有 runtime。
  // 输出：descriptor（含 generation）；调用方应把 generation 视为该 attachment 的冻结快照。
  // 失败语义：session 不存在/未在线、workspace 与 source 不匹配都抛 unavailable 错误。
  // 副作用：可能创建远端 workspace runtime、写 strict workspace history、发连接变更通知。
  // [事务] 每次绑定即换代：generation += 1，workspaceKey 用改写后的 identity 重算。
  // 旧 generation 只经 pendingRelease 收尾，不会被就地复用。
  // 失败时必须逐字段回滚（含 workspaceReady 与 readyState），否则 session 处于半换代状态。
  // 回滚后再按旧 ownership 请求释放，保证不遗留远端 runtime。
  // workspaceKey 必须取改写后的值：取原参数会让 session 同时持有两个身份源。
  function bindWorkspaceContext(params: {
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspacePurpose?: WorkspacePurpose;
    legacyWorkspaceIdentity?: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const session = sessionsById.get(params.remoteSessionId);
    if (!session) {
      throw new Error(`未找到远程 logical session，remoteSessionId=${params.remoteSessionId}`);
    }
    const previousOwnership = {
      entry: session.entry,
      remoteSessionId: session.remoteSessionId,
      workspaceKey: session.workspaceKey,
      workspaceGeneration: session.workspaceGeneration,
    };
    const previousSession = {
      workspacePath: session.workspacePath,
      legacyWorkspaceIdentity: session.legacyWorkspaceIdentity,
      workspaceIdentity: session.workspaceIdentity,
      workspacePurpose: session.workspacePurpose,
      generation: session.generation,
      workspaceKey: session.workspaceKey,
      workspaceGeneration: session.workspaceGeneration,
      workspaceReady: session.workspaceReady,
      workspaceReadyState: session.workspaceReadyState,
    };
    session.workspacePath = params.workspacePath;
    session.legacyWorkspaceIdentity = params.legacyWorkspaceIdentity ?? params.workspaceIdentity;
    session.workspaceIdentity = session.sourceServerId
      ? buildServerRemoteWorkspaceIdentity({
          serverId: session.sourceServerId,
          workspacePath: params.workspacePath,
        })
      : params.workspaceIdentity;
    session.workspacePurpose = params.workspacePurpose ?? session.workspacePurpose;
    session.generation += 1;
    // Bug 原因：managed Source 会把 params 中的 route identity 换成 stable identity，
    // workspaceKey 若仍从原参数取值，session 就会同时持有两个身份源。
    session.workspaceKey = session.workspaceIdentity.trim() || params.workspacePath;
    session.entry.workspaceKeys.add(session.workspaceKey);
    const nextWorkspaceKey = session.workspaceKey;
    const ready = prepareWorkspaceRuntime(session, params.signal);
    return ready.then(
      () => {
        if (previousOwnership.workspaceKey !== nextWorkspaceKey) {
          const release = requestWorkspaceRelease(previousOwnership);
          void release?.catch(() => undefined);
        }
      },
      (error) => {
        const failedOwnership = {
          entry: session.entry,
          remoteSessionId: session.remoteSessionId,
          workspaceKey: nextWorkspaceKey,
          workspaceGeneration: session.workspaceGeneration,
        };
        session.workspacePath = previousSession.workspacePath;
        session.legacyWorkspaceIdentity = previousSession.legacyWorkspaceIdentity;
        session.workspaceIdentity = previousSession.workspaceIdentity;
        session.workspacePurpose = previousSession.workspacePurpose;
        session.generation = previousSession.generation;
        session.workspaceKey = previousSession.workspaceKey;
        session.workspaceGeneration = previousSession.workspaceGeneration;
        session.workspaceReady = previousSession.workspaceReady;
        session.workspaceReadyState = previousSession.workspaceReadyState;
        if (
          nextWorkspaceKey &&
          !Array.from(sessionsById.values()).some(
            (candidate) => candidate !== session && candidate.workspaceKey === nextWorkspaceKey,
          )
        ) {
          session.entry.workspaceKeys.delete(nextWorkspaceKey);
        }
        const release = requestWorkspaceRelease(failedOwnership);
        void release?.catch(() => undefined);
        throw error;
      },
    );
  }

  // attachment 层唯一取服务面的入口（#18 fail-closed）：scope 必须 remote、session 必须存在、
  // 且 workspacePath/workspaceIdentity 与 logical session 完全一致；handle 缺失或 workspace
  // 未 ready 都抛 WindowRemoteConnectionUnavailableError，绝不回退到「最近一次已知连接」。
  // 返回的 handle 是「当前代际」的句柄，调用方不得跨 generation 缓存。
  // [契约] 校验链：scope.kind=remote → session 存在 → workspacePath 与 workspaceIdentity 完全一致 → state/sourceAvailability/workspaceReadyState → handle 存在。
  // 返回的是当代 handle，调用方不得跨 generation 缓存。
  // 绝不在失败时回退到「最近一次已知连接」。
  function resolveScopedHandle(
    scope: WindowHostAttachmentScope,
  ): WindowRemoteConnectionHandle<TServices, TCapabilities> {
    if (scope.kind !== "remote") {
      throw new Error("远程连接 registry 不能解析 local attachment scope");
    }
    const session = sessionsById.get(scope.remoteSessionId);
    if (!session) {
      throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
    }
    if (
      session.workspacePath !== scope.workspacePath ||
      session.workspaceIdentity !== scope.workspaceIdentity
    ) {
      throw new Error(
        `远程 attachment scope 与 logical session 不匹配，remoteSessionId=${scope.remoteSessionId}`,
      );
    }
    if (
      session.state !== "online" ||
      session.sourceAvailability !== "online" ||
      session.workspaceReadyState !== "ready" ||
      !session.entry.handle
    ) {
      throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
    }
    return session.entry.handle;
  }

  // [契约] 每次调用都重新解析，不缓存 services；缓存会绕过 fail-closed 校验。
  function resolveScopedServices(scope: WindowHostAttachmentScope): TServices {
    return resolveScopedHandle(scope).services;
  }

  // [契约] 与 services 同源，必须复用 resolveScopedHandle，不可各自查表。
  function resolveScopedCapabilities(scope: WindowHostAttachmentScope): TCapabilities | undefined {
    return resolveScopedHandle(scope).capabilities;
  }

  // 释放一个 logical session：置 disconnected、摘 pending、清 workspace 归属，并按
  // shouldKeepConnectionAlive 决定是否断物理连接（wsl idle / ssh 缓存会保活）。
  // 幂等：未知 session 直接返回；重复调用不会重复释放 runtime。
  // 副作用：可能 await workspaceRelease 与 entry 释放，完成后发 onConnectionChanged。
  // [资源] 未知 session 直接返回，保证幂等；先摘三张表再决定 transport 去留。
  // 保活 Source 只释放 wrapper，不断开 Manager 的物理连接。
  // wsl online 排 idle，ssh online 保留窗口级缓存。
  // 其余情况立即 disposeEntry。
  // workspace 释放要在 transport 决策后 await，避免提前销毁 runtime。
  async function disposeSession(remoteSessionId: string): Promise<void> {
    const session = sessionsById.get(remoteSessionId);
    if (!session) {
      return;
    }
    sessionsById.delete(remoteSessionId);
    pendingSessionsByRequestId.delete(session.requestId);
    session.entry.sessions.delete(remoteSessionId);
    const workspaceRelease = requestWorkspaceRelease({
      entry: session.entry,
      remoteSessionId,
      workspaceKey: session.workspaceKey,
      workspaceGeneration: session.workspaceGeneration,
    });
    if (session.entry.sessions.size === 0) {
      if (shouldKeepConnectionAlive(session.entry)) {
        // Bug 原因：把“物理 Source 常驻”误当成“logical wrapper 常驻”，关最后 tab
        // 后 close/reconnect 订阅会永久残留。handle.dispose 不会断开 Manager 物理连接。
        await disposeEntry(session.entry);
      } else if (session.entry.target.kind === "wsl" && session.entry.state === "online") {
        scheduleWslIdleDispose(session.entry, "last-logical-session-disposed");
      } else if (session.entry.target.kind === "ssh" && session.entry.state === "online") {
        // R1 只迁移 SSH pool 的 owner：ready connection 继续保持 window-scoped cache，
        // logical session 清空不等于连接退出；真实窗口 Host shutdown 时统一释放。
        clearIdleTimer(session.entry);
      } else {
        await disposeEntry(session.entry);
      }
    }
    await workspaceRelease?.catch(() => undefined);
  }

  // [契约] 只返回 online 且未 disposed 的 handle；connecting 与 closing 一律视为不可用。
  // 调用方拿到 handle 后仍需确认 services 可用，本函数不做 capabilities 校验。
  // 该函数同时用于 capability 快速路径与内部查询。
  function getOnlineSource(sourceServerId: string) {
    const entry = entriesBySourceServerId.get(sourceServerId);
    return entry && !entry.disposed && entry.state === "online" ? entry.handle : undefined;
  }

  return {
    // 以 Source 为单位取得在线连接（host capability 路径）：已知 sourceServerId 且已在线时直接复用，
    // 否则按 target 复用/新建 entry 并等待握手，最后以 owner 身份返回。
    // 失败语义：owner 不存在/已释放/非 online 都抛 unavailable；不会返回 connecting 状态的句柄。
    // [契约] capability 路径：已知 sourceServerId 且在线则直接复用，不新建 entry。
    // 否则走 resolveEntry 并等待 ready，再由 entriesBySourceServerId 取 canonical owner。
    // 握手后必须重查 owner：provisional entry 可能已把所有权转交出去。
    // owner 缺失、已释放、非 online 或 handle 缺失都抛 unavailable。
    async connectSource(params: {
      target: RemoteTarget;
      remoteAssets: WindowRemoteAssetDirs;
      membershipIntent?: "add" | "retain";
      existingSourceServerId?: string;
    }) {
      if (disposed) throw new WindowRemoteConnectCancelledError();
      if (params.existingSourceServerId) {
        const current = getOnlineSource(params.existingSourceServerId);
        if (current) return { sourceServerId: params.existingSourceServerId, handle: current };
      }
      const entry = resolveEntry({ ...params, key: buildConnectionKey(params.target) });
      await entry.ready;
      const owner = entry.sourceServerId
        ? entriesBySourceServerId.get(entry.sourceServerId)
        : entry;
      if (
        !owner ||
        owner.disposed ||
        owner.state !== "online" ||
        !owner.sourceServerId ||
        !owner.handle
      )
        throw new WindowRemoteConnectionUnavailableError("host-connection");
      return { sourceServerId: owner.sourceServerId, handle: owner.handle };
    },
    getOnlineSource,
    // 只读连接列表：target 已脱敏，按 entry 去重（多条 route alias 只出现一次）。
    // [契约] 按 entry 去重：同一物理连接的多条 alias 只出现一次。
    // target 必须脱敏后再返回。
    // 只读投影，不触发任何连接动作。
    listConnections() {
      return Array.from(new Set(entriesByKey.values()), (entry) => ({
        sourceServerId: entry.sourceServerId,
        target: stripRemoteTargetSecrets(entry.target),
        state: entry.state,
      }));
    },
    // [契约] 对外只暴露单参数签名，admission 是内部路径，不进入公开类型。
    // 该包装保证调用方无法传入自建 admission entry。
    // 如需暴露 admission 语义，应新增显式方法而不是放宽此处参数。
    connect: (params: Parameters<typeof connect>[0]) => connect(params),
    // 在既有的在线 Source 上打开 workspace（手机项目导航路径）。
    // 与 connect 的区别：不新建/复用 entry，不触发连接器，也不等待后台恢复；只看当前 online 句柄，
    // 这样手机侧打开项目不会意外改变 Source 的连接预算或触发安装。
    // [契约] 手机项目导航专用：只看 online 句柄，不新建或复用 entry。
    // 因此不能走 resolveEntry，否则会改变 Source 的连接预算与恢复行为。
    // 不触发连接器与安装，避免手机侧打开项目时产生副作用。
    // entry 不存在或非 online 直接抛 unavailable。
    async openWorkspaceOnSource(params: {
      requestId: string;
      sourceServerId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      workspacePurpose?: WorkspacePurpose;
      assertCurrent(): Promise<void>;
    }): Promise<WindowHostRemoteWorkspaceDescriptor> {
      const entry = entriesBySourceServerId.get(params.sourceServerId);
      // 手机项目导航只取得已在线连接，不走 resolveEntry/connector，也不等待后台恢复。
      if (!entry || entry.disposed || entry.state !== "online" || !entry.handle)
        throw new WindowRemoteConnectionUnavailableError(params.sourceServerId);
      return connect(
        { ...params, target: entry.target, remoteAssets: {} },
        {
          entry,
          services: entry.handle.services,
          assertCurrent: params.assertCurrent,
        },
      );
    },
    cancelConnect,
    bindWorkspaceContext,
    resolveScopedServices,
    resolveScopedCapabilities,
    // 单会话快照（不存在返回 null，不抛错，供 UI 轮询/查询使用）。
    // [契约] 查不到返回 null 而不是抛错，供 UI 轮询使用。
    // 快照经脱敏后返回，调用方不得据此修改内部状态。
    // 不等待 workspace ready，快照中的 state 可能领先于真实可用性。
    getSession(remoteSessionId: string): WindowRemoteLogicalSessionSnapshot | null {
      const session = sessionsById.get(remoteSessionId);
      return session ? toSessionSnapshot(session) : null;
    },
    // 全量 logical session 快照（顺序为插入顺序，不做排序）。
    // [契约] 顺序为 Map 插入顺序，不做排序；需要稳定顺序的调用方自行排序。
    // 包含 pending session，调用方需结合 requestId 判断是否为未发布会话。
    // 只读投影，元素为值拷贝。
    listSessions(): WindowRemoteLogicalSessionSnapshot[] {
      return Array.from(sessionsById.values(), toSessionSnapshot);
    },
    /**
     * 已就绪、未释放的连接（按连接去重，同一 SSH 连接上的多个 logical session 只出现一次）。
     * 供窗口级事实广播给每个远程 Host，例如动态工作流的用户选择（launch.md「The user's choice」）。
     */
    // [契约] 只列 handle 存在且未 disposed 的 entry，按连接去重。
    // services 是活引用，不得跨重连持有。
    // 用于窗口级事实广播，例如动态工作流的用户选择。
    // 不校验 workspace ready，调用方需自行确认目标 workspace 已绑定。
    listReadyConnections(): Array<{ target: RemoteTarget; services: TServices }> {
      return Array.from(entriesByKey.values()).flatMap((entry) =>
        entry.handle && !entry.disposed
          ? [{ target: entry.target, services: entry.handle.services }]
          : [],
      );
    },
    // 按 workspace identity 反查唯一 session；多义即抛错（不做「猜一个」）。
    // 口径：优先 online 匹配；online 唯一时直接返回；否则若候选本身多于一个也视为歧义。
    // [契约] 优先 online 匹配；online 唯一直接返回；否则候选多于一个即抛歧义错误。
    // 禁止「猜一个」：错配会把请求发到另一个用户的 workspace。
    // 匹配条件同时比较 workspacePath 与 workspaceIdentity，缺一不可。
    // 多解说明状态机已出现重复 owner，应作为缺陷上报而不是静默容错。
    findSessionForWorkspace(params: {
      workspacePath: string;
      workspaceIdentity?: string;
    }): WindowRemoteLogicalSessionSnapshot | null {
      const matches = Array.from(sessionsById.values()).filter(
        (session) =>
          session.workspacePath === params.workspacePath &&
          session.workspaceIdentity === params.workspaceIdentity,
      );
      const onlineMatches = matches.filter(
        (session) => session.state === "online" && session.sourceAvailability === "online",
      );
      if (onlineMatches.length > 1 || (onlineMatches.length === 0 && matches.length > 1)) {
        throw new Error(
          `远程 workspace scope 匹配到多个 logical session，workspacePath=${params.workspacePath}`,
        );
      }
      const match = onlineMatches[0] ?? matches[0];
      return match ? toSessionSnapshot(match) : null;
    },
    // 调试/健康检查用的计数：connectionCount 按 entry 去重，logicalSessionCount 为会话总数。
    // [契约] connectionCount 按 entry 去重，logicalSessionCount 为全局会话数。
    // 仅用于健康检查与调试，不得用于业务判定。
    // 含 pending session，因此计数会略大于已发布会话。
    getStats(): { connectionCount: number; logicalSessionCount: number } {
      return {
        connectionCount: new Set(entriesByKey.values()).size,
        logicalSessionCount: sessionsById.size,
      };
    },
    // 更新 workspace 的运行中任务数（仅 wsl 需要）：>0 阻止空闲释放，归零后按策略排 idle dispose。
    // 同一 Source entry 可能有多条 alias，用 Set 去重保证副作用只执行一次。
    // [资源] workspaceKey 用 identity.trim() 或 path 计算，与 bindWorkspaceContext 同口径。
    // 同一 entry 可能有多条 alias，用 Set 去重保证副作用只执行一次。
    // 计数大于 0 时清 idle 计时器，防止任务执行中被回收。
    // 归零时若存在 pendingReleaseGeneration 立即补做释放，否则重排 wsl idle。
    setWorkspaceRunningTaskCount(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      runningTaskCount: number;
    }): void {
      const workspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
      // 同一 Source entry 可能被多条 route alias 引用；workspace 生命周期副作用只执行一次。
      for (const entry of new Set(entriesByKey.values())) {
        if (entry.target.kind !== "wsl" || !entry.workspaceKeys.has(workspaceKey)) {
          continue;
        }
        if (params.runningTaskCount > 0) {
          entry.runningTaskCountByWorkspaceKey.set(workspaceKey, params.runningTaskCount);
          clearIdleTimer(entry);
        } else {
          entry.runningTaskCountByWorkspaceKey.delete(workspaceKey);
          const state = entry.workspaceRuntimeByKey.get(workspaceKey);
          if (state?.pendingReleaseGeneration) {
            void startWorkspaceRelease(
              entry,
              workspaceKey,
              state,
              state.pendingReleaseGeneration,
            )?.catch(() => undefined);
          }
          scheduleWslIdleDispose(entry, entry.idleReason);
        }
      }
    },
    // attachment 建立前等待 workspace 就绪：只等待 session.workspaceReady，再走 fail-closed 的
    // resolveScopedServices。scope 非 remote / session 不存在都直接抛错。
    // [契约] 只等待 workspaceReady，不等待恢复 flight。
    // 等待结束后仍必须走 resolveScopedServices 的 fail-closed 校验。
    // scope 非 remote 抛契约错误，session 缺失抛 unavailable。
    // `waitForScopedServices` 可能永不返回：调用方必须自行加超时。
    async waitForScopedServices(scope: WindowHostAttachmentScope): Promise<TServices> {
      if (scope.kind !== "remote") {
        throw new Error("远程连接 registry 不能解析 local attachment scope");
      }
      const session = sessionsById.get(scope.remoteSessionId);
      if (!session) {
        throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
      }
      await session.workspaceReady;
      return resolveScopedServices(scope);
    },
    disposeSession,
    // registry 级释放：先置 disposed 并取消全部 pending 连接，再对所有 entry（含仅存在于
    // sessions 中的 entry）并行 disposeEntry；disposePromise 保证并发/重复调用共享同一结果。
    // [契约] 先置 disposed 并取消全部 pending，再对 entriesByKey 与 sessionsById 的并集并行 disposeEntry。
    // 并集不能省：只在 sessions 中出现的 entry 不会被 entriesByKey 覆盖。
    // disposePromise 保证并发与重复调用共享同一结果。
    // 清表顺序为 sessions 先于 entries 释放，避免释放过程中回调重新入表。
    async dispose(): Promise<void> {
      if (disposePromise) {
        return disposePromise;
      }
      disposed = true;
      for (const requestId of Array.from(pendingSessionsByRequestId.keys())) {
        cancelConnect(requestId);
      }
      const entries = new Set(Array.from(sessionsById.values(), (session) => session.entry));
      for (const entry of entriesByKey.values()) {
        entries.add(entry);
      }
      sessionsById.clear();
      pendingSessionsByRequestId.clear();
      disposePromise = Promise.all(Array.from(entries, disposeEntry)).then(() => undefined);
      return disposePromise;
    },
  };
}
