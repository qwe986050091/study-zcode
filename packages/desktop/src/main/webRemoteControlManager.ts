// 本文件是 Desktop Main 侧“手机远控”的唯一编排者：负责设备注册/配对/鉴权/心跳的
// transport 生命周期，以及把手机 app payload 路由到窗口级 workspace bridge。
// 它不持有会话业务状态（任务队列、快照、消息），只持有“连接事实 + attachment 句柄”。
//
// INV-01：一个 windowId 至多一个 WindowControlRuntime；runtimes 是唯一事实源，
//         任何异步回调写状态前都必须用 runtimes.get(windowId) === runtime 做身份校验
//         （守住它的位置：mapTransportState / buildWorkspaceBridge / onPayload 回调）。
// INV-02：currentBridge 表示“已经就绪、可转发”的 bridge 资源；bridgeOpen 表示
//         “正在 admission、可能失败”的请求。两者不可合并：合并后重试会复用半个连接
//         （守住它的位置：createWorkspaceBridge / buildWorkspaceBridge / disposeRuntimeBridgeResources）。
// INV-03：bridge-ready 必须先进入普通 app transport，之后才允许 relayProtocol 开闸放行
//         排队 raw frame；顺序颠倒会让手机 assembler 先收到帧、后收到桥接身份
//         （守住它的位置：respondToWorkspaceBridgeOpen 的 readyAnnounced 赋值处）。
// INV-04：raw RPC 的重放所有权只属于 relayProtocol；Main 不把 rpc-frame 塞进
//         pendingOutboundPayloads，否则同一帧会被“buffer 重发 + adapter 重放”发送两次
//         （守住它的位置：buildWorkspaceBridge 的 sendFrame 与 onDegraded 接线）。
// INV-05：degraded 是单向闩锁（只置 true、永不复位）；同一 bridgeSessionId +
//         bridgeGeneration 不得重建，手机必须换新身份重新 open
//         （守住它的位置：degradeBridgeAfterRawFault / replaceRemoteSession）。
// INV-06：bridge 身份 = bridgeSessionId + bridgeGeneration + recoveryId；其中
//         bridgeSessionId + bridgeGeneration 相同但 intentKey 不同时必须拒绝
//         （守住它的位置：createWorkspaceBridge 的 intentKey 比较）。
// INV-07：手机侧 fault 只释放“手机短生命周期 attachment”，不得释放物理 Host/Agent；
//         反过来会把用户正在桌面上使用的会话一起踢掉
//         （守住它的位置：degradeBridgeAfterRawFault 的 disposeRuntimeBridgeResources 调用）。
// INV-08：远程 workspace 必须同时具备 workspaceIdentity 与 remoteSessionId 才可 bridge；
//         仅有路径匹配会把“已断开的 SSH 项目”误当成可打开目标
//         （守住它的位置：isBridgeableRemoteTarget）。
// INV-09：workspace 身份键统一走 resolveWebRemoteControlWorkspaceKey（identity 优先、
//         path 兜底）；本地手写 key 会在远程切换后产生两个不同 key
//         （守住它的位置：全部 availableWorkspaces 去重与 persistedContext 比对）。
// INV-10：启动授权票据一次性：consume 即 delete，TTL 30s，且必须同时匹配
//         windowId / workspaceKey / remoteSessionId，否则拒绝
//         （守住它的位置：authorizeStart / consumeStartAuthorization）。
// INV-11：设备 SID 的 load/register/save 通过 registrationQueue 串行化；
//         并发首启若各自 register，会互相覆盖持久化 SID 并留下孤儿设备
//         （守住它的位置：start 内 register 闭包对 registrationQueue 的复用）。
// INV-12：auth-required 是门禁终态：只有登录状态变化通知或新的 start 能解除，
//         workspace 列表同步不得重试失效 JWT
//         （守住它的位置：authRequiredWindows + restorePreviouslyEnabled 前置判断）。
// INV-13：lifecycleRevision 与 authNotificationRevision 用于丢弃过期异步结果；
//         没有代际校验的 await 之后写状态会把“已登出/已换号”的旧结果写回
//         （守住它的位置：readAuthContext 循环 / notifyAuthStateChanged / restorePreviouslyEnabled）。
// INV-14：手机 mobileTaskView 必须同时满足 paired 状态、当前 epoch 与 seq 严格递增，
//         且地址与当前 bridge 完全一致的更新；其余一律丢弃，防止旧回包覆盖新状态
//         （守住它的位置：applyMobileTaskViewUpdate 的早退条件）。
// INV-15：3s 断线宽限只影响 status 展示，不改变 pairing/transport 事实；
//         宽限期内不得清空 transportState，也不得把它当成已断开
//         （守住它的位置：scheduleMobileDisconnectGrace 与其调用点）。
// INV-16：pendingOutboundPayloads 有界（50）且带超时丢弃；它只服务 relay suspect
//         窗口内的响应/RPC 帧，不能承担“可靠队列”职责
//         （守住它的位置：bufferOutboundPayload / schedulePendingOutboundPayloadTimeout）。
// INV-17：pendingBridgeInvalidation 是 latch，unavailable 保留、sent 之后不能清除，
//         直到手机用新 bridge identity 发起 open 才清除
//         （守住它的位置：sendPendingBridgeInvalidation / buildWorkspaceBridge 的清除点）。
// INV-18：关闭顺序固定为 abort lifecycle → 取消 bridgeOpen → 释放 bridge 资源 →
//         清定时器 → dispose transport → 通知附件归属方；换序会让回调看到半关闭状态
//         （守住它的位置：stopWindowRuntime / preserveWindowRuntimeFailure）。
// INV-19：preserveWindowRuntimeFailure 对“同 reason 的 error”幂等，避免 relay 抖动
//         反复广播 app-error 并反复销毁 transport
//         （守住它的位置：函数首行的 status/failure 比较）。
// INV-20：本文件的 telemetry 是纯旁路：任何抛错都必须被吞掉，且不得改变配对结果
//         （守住它的位置：reportRemoteUsageEvent 的 try/catch）。
import type { RendererTelemetryEventPayload } from "@zcode/shared";
/* eslint-disable max-lines -- Web 远程控制 manager 承担外部 relay app payload 路由与 workspace bridge 编排。 */
import type { MessagePortMain, UtilityProcess as ElectronUtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { MessagePortProtocol, type MessagePortLike, type MessagePortPayload } from "@zcode/rpc";
import {
  createAcknowledgedWebRemoteControlRelayProtocol,
  type AcknowledgedWebRemoteControlRelayProtocolAdapter,
  type WebRemoteControlPayloadSendResult,
} from "@zcode/client";
import {
  buildWebRemoteControlExternalQrUrl,
  buildWebRemoteControlBridgeResultTelemetry,
  buildWebRemoteControlPairResultTelemetry,
  classifyRemoteUsageError,
  parseRemoteWorkspaceIdentity,
  WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS,
  type ZCodeEndpointUrls,
  type HostPreparedProjectWorkspace,
  type HostProjectWorkspaceNavigationInput,
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlAppPayload,
  type WebRemoteControlAuthStateChange,
  type WebRemoteControlContext,
  type WebRemoteControlExternalWorkspaceBridge,
  type WebRemoteControlFailure,
  type WebRemoteControlFailureReason,
  type WebRemoteControlMobileDeviceInfo,
  type WebRemoteControlMobileViewState,
  type WebRemoteControlMobileTaskViewUpdatePayload,
  type WebRemoteControlPlatformMethod,
  type WebRemoteControlPlatformMethodArgsMap,
  type WebRemoteControlPlatformMethodResultMap,
  type WebRemoteControlPlatformRequestPayload,
  type WebRemoteControlPlatformResponsePayload,
  type WebRemoteControlRpcTransportPayload,
  type WebRemoteControlStartResult,
  type WebRemoteControlStatus,
  type WebRemoteControlWindowBootstrapResult,
  type WebRemoteControlWorkspaceBridgeOpenPayload,
  type WebRemoteControlWorkspaceListResult,
  type WebRemoteControlWorkspaceTarget,
  type RemoteUsageRemoteKind,
  type TelemetryEventPayload,
  measureWebRemoteControlRpcRelayEnvelopeBytes,
} from "@zcode/shared";
import { WebRemoteControlV2ConnectionError } from "@zcode/shared/web-remote-relay";
import {
  WebRemoteControlDeviceTransport,
  type WebRemoteControlDeviceTransportOptions,
  type WebRemoteControlDeviceTransportState,
  createWebRemoteControlV2Http,
  type WebRemoteControlLogin,
} from "#src/main/web-remote-relay/index.js";
import type { WebRemoteControlDeviceStorage } from "#src/main/web-remote-relay/index.js";

import type { WebRemoteControlFeatureGate } from "./webRemoteControlFeatureGate.js";

// attachment 句柄是 Main 与 Host 之间的唯一凭据：entryId 标识 Host 入口，attachmentId
// 标识“这个窗口这次桥接”的租约。两者必须成对释放，只放其中一个会留下 scoped subscription。
interface WebRemoteControlHostAttachmentHandle {
  entryId: string;
  attachmentId: string;
  process: ElectronUtilityProcess;
  // port 是 Host 侧 MessagePort 的 Main 端；它随 attachment 一起失效，不能跨 bridge 复用。
  port: MessagePortMain;
  // remoteKind 只用于 telemetry 维度，不参与路由；缺失时由 workspaceIdentity 反推。
  remoteKind?: RemoteUsageRemoteKind;
}

// 这是“已建立”的 bridge 事实。字段分三组：
//   身份组（bridgeSessionId / bridgeGeneration / recoveryId）—— 由手机发起、Main 只校验；
//   资源组（hostProtocol / relayProtocol / disposeBridge / attachmentId）—— 成对创建、成对释放；
//   门禁组（readyAnnounced / degraded）—— 控制 raw frame 能否出站。
interface WorkspaceBridgeRuntime {
  // 身份三元组：手机每次重建都会换新值；Main 不用它做去重以外的任何推断。
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  hostEntryId: string;
  attachmentId: string;
  kind: "local" | "remote";
  // workspaceKey 是 identity 优先的隔离键；workspacePath 只用于执行与展示。
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  hostProtocol?: MessagePortProtocol;
  relayProtocol?: AcknowledgedWebRemoteControlRelayProtocolAdapter;
  // disposeBridge 只解除协议事件订阅，不释放 attachment；后者由 disposeRuntimeBridgeResources 负责。
  disposeBridge?: () => void;
  // readyAnnounced 为 false 时 sendFrame 直接返回 false，帧留在 adapter 队列里。
  readyAnnounced: boolean;
  // degraded 一旦为 true 就禁止继续转发；同一身份不可重建（INV-05）。
  degraded: boolean;
}

// transport 的最小接口：真实实现是 WebRemoteControlDeviceTransport，测试可注入替身。
// sendPayloadResult 是可选增强——只有它能区分 “unavailable” 与 “oversize”，
// 而这两种结果的处置完全不同（缓冲重试 vs 永久丢弃），所以下游必须优先调用它。
interface WebRemoteControlDeviceTransportLike {
  start(): void;
  sendPayload(payload: WebRemoteControlAppPayload): boolean;
  sendPayloadResult?(payload: WebRemoteControlAppPayload): WebRemoteControlPayloadSendResult;
  measurePayloadBytes?(payload: WebRemoteControlAppPayload): number;
  dispose(): void;
}

interface WebRemoteControlStartupRestoreContext {
  workspacePath: string;
  workspaceIdentity?: string;
  initialTaskId?: string;
}

export interface WebRemoteControlStartAuthorization {
  // token 是随机不可猜的凭据，调用方只能从 authorizeStart 拿到，不能自行构造。
  token: string;
  // expiresAt 是绝对时间戳；过期票据即使仍留在 Map 里也必须拒绝（见 consumeStartAuthorization）。
  expiresAt: number;
  windowId: number;
  // workspaceKey / remoteSessionId 把票据钉死在“这次 dispatch 的目标”上。
  workspaceKey: string;
  remoteSessionId?: string;
}

// 30s 覆盖“渲染进程取票据 → 用户确认 → 主进程执行”的整段交互；过短会在慢机器上误判过期，过长会让旧票据在 workspace 切换后仍可被消费。
const WEB_REMOTE_CONTROL_START_AUTHORIZATION_TTL_MS = 30_000;

// 每个窗口一条 lifecycle：controller 用于取消所有在途 await，identity 记录“启动时使用的账号 + 端点”，登录变化时会据此精确找出需要强制下线的窗口。
interface WindowControlLifecycle {
  controller: AbortController;
  identity?: { userId: string; endpointOrigin: string };
}

// 一个窗口的远控运行态。这里只放“连接事实”和“手机观察到的展示状态”，不放任务/消息：那些由 Host attachment 另一侧管理，Main 侧持有会形成第二事实源。
interface WindowControlRuntime {
  windowId: number;
  // 启动时（或最近一次切换）的窗口目标；status 接口永远返回这一组，不跟随手机导航漂移（INV-14 的配套约定）。
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  theme?: WebRemoteControlContext["theme"];
  // status 是给桌面弹层看的归一化状态；transportState 是 relay 原始状态，两者不能互相推导。
  status: WebRemoteControlStatus["status"];
  error?: string;
  failure?: WebRemoteControlFailure;
  deviceSid: string;
  deviceMid: string;
  connectUrl: string;
  qrUrl: string;
  transport: WebRemoteControlDeviceTransportLike;
  mobileConnected: boolean;
  // hasEverPaired 决定 telemetry 的 pairKind（initial 还是 reconnect），只在 paired 时推进。
  hasEverPaired: boolean;
  // 用于抑制 same-socket 心跳 ACK 反复补发 degraded latch（见 onSendReady）。
  hasObservedSendReadyForPairing: boolean;
  transportState?: WebRemoteControlDeviceTransportState;
  mobileViewState?: WebRemoteControlMobileViewState;
  mobileTaskView?: NonNullable<WebRemoteControlStatus["mobileTaskView"]>;
  // epoch + seq 是手机侧“本次配对内的查看递增序号”防线，断线即作废。
  mobileTaskViewEpoch?: string;
  mobileTaskViewSeq?: number;
  mobileDeviceInfo?: WebRemoteControlMobileDeviceInfo;
  // 已就绪的 bridge（可能为 undefined）；与 bridgeOpen 的区别见 INV-02。
  currentBridge?: WorkspaceBridgeRuntime;
  // 正在进行中的 open。promise 是复用的关键：同一身份重试直接拿同一个 Promise，
  // 避免手机重试把 Host attach 做两遍。
  bridgeOpen?: {
    bridgeSessionId: string;
    bridgeGeneration?: number;
    intentKey: string;
    hostRequestId: string;
    preparingProject: boolean;
    promise: Promise<WebRemoteControlExternalWorkspaceBridge>;
  };
  // degraded 通知的 latch：见 INV-17，必须跨 paired 抖动保留。
  pendingBridgeInvalidation?: Extract<
    WebRemoteControlAppPayload,
    { zcode_type: "bridge-degraded" }
  >;
  // relay suspect 窗口的临时缓冲：有界、超时丢弃，绝不平移到“可靠队列”。
  pendingOutboundPayloads: WebRemoteControlAppPayload[];
  pendingOutboundPayloadTimer?: ReturnType<typeof setTimeout>;
  // 断线宽限定时器：存在即表示“正在宽限”，重复调度必须幂等。
  mobileDisconnectGraceTimer?: ReturnType<typeof setTimeout>;
}

// 所有外部能力都通过依赖注入提供：Main 只编排顺序，不直接摸窗口、Host 或登录态。
// 这样测试可以注入假的 attachWorkspaceHost，验证“失败时 attachment 一定被释放”。
interface WebRemoteControlManagerDependencies {
  // 端点解析是可选覆盖：Web 版由服务端下发，Desktop 用内置地址兜底。
  getEndpointUrls?: () => Promise<ZCodeEndpointUrls> | ZCodeEndpointUrls;
  relayWsUrl: string;
  mobileRemoteControlUrl: string;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  // getLogin 每次调用都应返回最新登录态；Main 不做缓存，否则换号后仍用旧 JWT。
  getLogin(): Promise<WebRemoteControlLogin | undefined>;
  deviceStorage: WebRemoteControlDeviceStorage;
  // 启动恢复设置的读写；save 失败必须让本次启动失败（否则下次无法自动恢复）。
  startupRestoreStorageProvider: {
    load(): Promise<WebRemoteControlStartupRestoreContext | undefined>;
    save(context: WebRemoteControlStartupRestoreContext): Promise<void>;
    clear(): Promise<void>;
  };
  featureGate: WebRemoteControlFeatureGate;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  // relayMessageLogger 只记录原始 relay 帧摘要，不参与协议判定。
  relayMessageLogger?: {
    info: (...args: unknown[]) => void;
  };
  // 平台方法表由窗口侧注入；方法名即契约，未知 method 会在运行时抛错并被转成 platform-response 失败。
  platformHandlers: {
    [K in WebRemoteControlPlatformMethod]: (
      args: WebRemoteControlPlatformMethodArgsMap[K],
    ) => Promise<WebRemoteControlPlatformMethodResultMap[K]>;
  };
  reconnectWorkspace: (windowId: number, workspaceKey: string) => Promise<void>;
  // 项目导航准备：可取消。取消靠 requestId 关联，不靠 AbortSignal，因为真正的准备发生在 Host 侧、跨进程无法传 signal。
  prepareProjectWorkspace?: (
    windowId: number,
    project: HostProjectWorkspaceNavigationInput,
    requestId: string,
  ) => Promise<HostPreparedProjectWorkspace>;
  cancelProjectPreparation?: (windowId: number, requestId: string) => void;
  reportRemoteUsageEvent?: (windowId: number, event: TelemetryEventPayload) => void;
  reportRendererTelemetryEvent?: (event: RendererTelemetryEventPayload) => void;
  onStatusChanged?: (windowId: number, status: WebRemoteControlStatus) => void;
  // attach/release 必须成对：attach 返回的 attachmentId 是 release 的唯一入参，
  // 因此任何 throw 分支都要先释放再抛（见 buildWorkspaceBridge 的 catch）。
  attachWorkspaceHost: (
    windowId: number,
    context: WebRemoteControlContext & { kind: "local" | "remote" },
  ) => Promise<WebRemoteControlHostAttachmentHandle>;
  releaseWorkspaceHostAttachment: (attachmentId: string) => void;
  disposeWorkspaceHostAttachmentsForWindow: (windowId: number, reason: string) => void;
  disposeWorkspaceHostAttachmentsForRemoteSession: (
    remoteSessionId: string,
    reason: string,
  ) => void;
  // 允许测试替换 transport；生产走 WebRemoteControlDeviceTransport。
  createDeviceTransport?: (
    options: WebRemoteControlDeviceTransportOptions,
  ) => WebRemoteControlDeviceTransportLike;
}

// Bugfix: 外部 relay 首次鉴权会受边缘层冷启动和网络抖动影响，实测可能略超 15s。
// 这里等待到 30s，避免在 device 已经快进入 waiting_terminal 时过早销毁可用连接。
const EXTERNAL_RELAY_QR_READY_TIMEOUT_MS = 30_000;
const MOBILE_DISCONNECT_STATUS_GRACE_MS = 3_000;

// 失败对象是“可上报给手机”的结构：reason 是封闭枚举，message 是可读补充。
// 之所以不直接抛 Error，是因为 reason 要跨越 transport 边界被 Web 侧分类处理。
function createFailure(
  reason: WebRemoteControlFailureReason,
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}

// Host 侧错误只带 code 字符串，不带类型；这里做一次窄化，拿不到 code 就返回 undefined，让调用方落到 default 分支而不是误判。
function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

// 把 Host 内部错误码收敛成手机可理解的失败原因。
// [权衡] 不把原始 code 透传给手机：code 属于内部契约，改动会破坏移动端兼容；
// 这里做一层稳定映射，新增 code 时只在 default 里退化，不会让手机崩溃。
function mapWorkspaceBridgeFailureReason(error: unknown): WebRemoteControlFailureReason {
  switch (getErrorCode(error)) {
    case "DESKTOP_HOST_MISSING":
      return "desktop-disconnected";
    case "REMOTE_SESSION_MISSING":
    case "REMOTE_SESSION_WINDOW_MISMATCH":
      return "workspace-closed";
    case "REMOTE_WORKSPACE_IDENTITY_MISSING":
    case "REMOTE_WORKSPACE_IDENTITY_MISMATCH":
      return "unsupported-action";
    default:
      return "unexpected-error";
  }
}

// Electron 的 MessagePortMain 用 on/off，MessagePortProtocol 期望 DOM 风格接口。
// 这层适配不复制消息、不加缓冲：port 的背压语义必须原样透传，否则 Host 侧流控失效。
function wrapElectronPort(port: MessagePortMain): MessagePortLike {
  return {
    addEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.on("message", listener);
    },
    removeEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.off("message", listener);
    },
    postMessage(data: MessagePortPayload) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}

// 展示名只取最后一段路径；空路径（Windows 根盘）回退原值，避免 label 变成空串。
function getPathLabel(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? workspacePath;
}

// 能否 bridge 的唯一判据：本地目标恒可；远程目标必须“身份 + 会话”齐全。
// [失败路径] 只查路径存在性会把已断开的 SSH 项目放进列表并允许点开，
// 结果是手机端进入一个永远连不上的会话；这里提前挡住，错误在 open 时以 workspace-closed 上报。
function isBridgeableRemoteTarget(target: WebRemoteControlWorkspaceTarget): boolean {
  return target.kind !== "remote" || Boolean(target.workspaceIdentity && target.remoteSessionId);
}

// 内部运行时 → 对外 bridge 描述。远程分支缺字段时抛错而不是静默降级：
// 手机侧靠 kind 决定后续 RPC 需要带哪些身份，猜错会让所有请求落到错误 workspace。
function toExternalBridge(
  runtime: WorkspaceBridgeRuntime,
): WebRemoteControlExternalWorkspaceBridge {
  const base = {
    bridgeSessionId: runtime.bridgeSessionId,
    ...(runtime.bridgeGeneration !== undefined
      ? { bridgeGeneration: runtime.bridgeGeneration }
      : {}),
    ...(runtime.recoveryId ? { recoveryId: runtime.recoveryId } : {}),
    workspaceKey: runtime.workspaceKey,
    workspacePath: runtime.workspacePath,
    initialTaskId: runtime.initialTaskId,
  };

  if (runtime.kind === "remote") {
    if (!runtime.workspaceIdentity || !runtime.remoteSessionId) {
      throw new Error("远程 workspace bridge 缺少 workspaceIdentity 或 remoteSessionId。");
    }
    return {
      ...base,
      kind: "remote",
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
      capabilities: { windowProjectDirectory: true },
    };
  }

  return {
    ...base,
    kind: "local",
  };
}

// 工厂函数：每个 window 的远控都在闭包里独立演进，跨窗口共享的只有
// registrationQueue（设备注册串行化）与两个代际计数器。
// 之所以不用 class：这些状态没有对外暴露的语义，闭包能把“谁能改”限制在本函数内。
export function createWebRemoteControlManager(dependencies: WebRemoteControlManagerDependencies) {
  // windowId → 运行态。这是唯一事实源，所有回调都要先确认自己仍指向表里的这个对象（INV-01）。
  const runtimes = new Map<number, WindowControlRuntime>();
  // 身份绑定与取消令牌覆盖首次启动到连接释放的整个生命周期，不缓存 JWT。
  const windowLifecycles = new Map<number, WindowControlLifecycle>();
  // 401/登出后的窗口集合是“门禁”而不是“状态缓存”，必须与 runtimes 分离，这样即使 transport 已销毁，getStatus 仍能稳定返回 auth-required。
  const authRequiredWindows = new Set<number>();
  // 设备 SID 的读改写到 relay 的注册是有副作用的：必须全局串行，否则多窗口首启互相覆盖。
  let registrationQueue: Promise<unknown> = Promise.resolve();
  // 启动授权票据：token → 票据。清除时机见 INV-10，绝不跨 dispatch 复用。
  const startAuthorizations = new Map<string, WebRemoteControlStartAuthorization>();
  // 每个窗口可切换的 workspace 快照；由渲染进程同步进来，Main 不主动推断。
  const availableWorkspacesByWindowId = new Map<number, WebRemoteControlWorkspaceTarget[]>();

  // telemetry 包装：任何异常都吞掉并降级成 warn。
  // [权衡] 不把错误抛给调用方看似“掩盖问题”，但埋点失败若中断配对，
  // 用户会得到一个无法连接的功能，而实际上链路是好的。
  function reportRemoteUsageEvent(windowId: number, event: TelemetryEventPayload): void {
    try {
      dependencies.reportRemoteUsageEvent?.(windowId, event);
    } catch (error) {
      // 埋点是旁路能力，任何异常都不能改变远控配对和 bridge 的业务结果。
      dependencies.logger.warn("[web-remote-control] remote usage telemetry failed", {
        elementName: event.elementName,
        error,
      });
    }
  }

  // 远程 kind 优先取“实际 attach 到的 Host”回报的值：它是运行时真相；
  // 只有拿不到时才回退解析 workspaceIdentity（历史数据可能缺 kind 前缀）。
  function resolveRemoteKind(
    target: WebRemoteControlWorkspaceTarget,
    acquired?: WebRemoteControlHostAttachmentHandle,
  ): RemoteUsageRemoteKind | undefined {
    if (target.kind !== "remote") {
      return undefined;
    }
    return (
      acquired?.remoteKind ??
      (target.workspaceIdentity
        ? parseRemoteWorkspaceIdentity(target.workspaceIdentity)?.kind
        : undefined)
    );
  }

  // 从运行时反推“本地还是远程”：只要出现 identity 或 remoteSessionId 就按远程计。
  // [权衡] 只看 remoteSessionId 会漏掉“SSH 会话已断开但 identity 仍在”的窗口，
  // 导致 telemetry 把远程操作记成本地；两者取或是有意放宽。
  function resolveRuntimeWorkspaceDimensions(runtime: WindowControlRuntime): {
    workspaceKind: "local" | "remote";
    remoteKind?: RemoteUsageRemoteKind;
  } {
    const remoteKind = runtime.workspaceIdentity
      ? parseRemoteWorkspaceIdentity(runtime.workspaceIdentity)?.kind
      : undefined;
    return {
      workspaceKind:
        runtime.workspaceIdentity?.trim() || runtime.remoteSessionId ? "remote" : "local",
      remoteKind,
    };
  }
  // 上一次推给手机的 workspace 列表签名：用于去重，避免每次 sync 都发一份相同快照。
  const pushedWorkspaceListSignaturesByWindowId = new Map<number, string>();
  // “本次进程生命周期内是否已认领过自动恢复”：只允许一个窗口恢复上次开启的远控，否则重启应用会同时拉起多个手机远控会话。
  let startupRestoreClaimed = false;
  // 生命周期代际：stop/dispose/登出都会自增，用来让“读盘/取登录态”这类慢异步作废。
  let lifecycleRevision = 0;
  // 登录通知代际：只用于 notifyAuthStateChanged 内部，防止两次通知交错时旧结果覆盖新结果。
  let authNotificationRevision = 0;

  // transport 构造只有这一处入口，测试替换走依赖注入；调用方不关心具体实现。
  function createTransport(options: WebRemoteControlDeviceTransportOptions) {
    return dependencies.createDeviceTransport
      ? dependencies.createDeviceTransport(options)
      : new WebRemoteControlDeviceTransport(options);
  }

  // 清票据必须遍历：token 是随机 UUID，不能由 windowId 反查，只能线性扫描。
  // 票据数量受“每个窗口一条 + TTL 30s”约束，实际规模是个位数。
  function clearStartAuthorizationsForWindow(windowId: number): void {
    for (const [token, authorization] of startAuthorizations) {
      if (authorization.windowId === windowId) {
        startAuthorizations.delete(token);
      }
    }
  }

  // 签发一次性票据。同一窗口先清空旧票据：渲染进程可能连续 dispatch 两次（切换 workspace 再启动），保留旧票据就等于允许“用旧目标启动新连接”。
  function authorizeStart(
    windowId: number,
    context: WebRemoteControlContext,
  ): WebRemoteControlStartAuthorization {
    const now = Date.now();
    // 同一窗口只保留最近一次 IPC dispatch 对应的内部票据，避免旧请求与新 workspace 上下文并存。
    clearStartAuthorizationsForWindow(windowId);
    // 顺带做过期清理：票据只在本 Map 里存活，没有别的 GC 时机。
    for (const [token, authorization] of startAuthorizations) {
      if (authorization.expiresAt <= now) {
        startAuthorizations.delete(token);
      }
    }

    const authorization: WebRemoteControlStartAuthorization = {
      token: randomUUID(),
      expiresAt: now + WEB_REMOTE_CONTROL_START_AUTHORIZATION_TTL_MS,
      windowId,
      workspaceKey: resolveWebRemoteControlWorkspaceKey(context),
      ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
    };
    startAuthorizations.set(authorization.token, authorization);
    return authorization;
  }

  // 消费票据的判定顺序是有意的：先 delete（保证一次性），再依次校验
  // 存在性 → 过期 → 目标一致。任何一步失败都抛错，且票据已被销毁，不能重试。
  // [失败路径] 若先校验后删除，两次并发 start 可能同时通过校验，导致同一 win 启动两个 transport。
  function consumeStartAuthorization(
    windowId: number,
    context: WebRemoteControlContext,
    authorization: WebRemoteControlStartAuthorization,
  ): void {
    const stored = startAuthorizations.get(authorization.token);
    startAuthorizations.delete(authorization.token);
    if (!stored || stored !== authorization) {
      throw new Error("Web remote control authorization is invalid or already used");
    }
    if (stored.expiresAt <= Date.now()) {
      throw new Error("Web remote control authorization expired");
    }
    // 目标三元组必须整体相等：workplaceKey 用统一解析函数算，避免调用方传入不同格式。
    if (
      stored.windowId !== windowId ||
      stored.workspaceKey !== resolveWebRemoteControlWorkspaceKey(context) ||
      stored.remoteSessionId !== context.remoteSessionId
    ) {
      throw new Error("Web remote control authorization target mismatch");
    }
  }

  // 释放 bridge 资源。顺序不可交换：
  //   1) 先解除协议订阅（disposeBridge），否则后续 close 触发的回调会再次进入这里；
  //   2) 再 dispose relay adapter，终止未 ACK 的重放计时；
  //   3) 然后断开 hostProtocol，最后归还 attachment。
  // [资源] attachment 必须最后释放：它可能触发 Host 侧清理，若之前协议仍存活，
  // Host 的收尾消息会打到已释放的端口上。
  function disposeRuntimeBridgeResources(runtime: WindowControlRuntime): void {
    clearMobileTaskView(runtime);
    const bridge = runtime.currentBridge;
    if (!bridge) {
      return;
    }

    bridge.disposeBridge?.();
    bridge.disposeBridge = undefined;
    bridge.relayProtocol?.dispose();
    bridge.relayProtocol = undefined;
    try {
      bridge.hostProtocol?.disconnect();
    } catch {
      // MessagePortProtocol 已经关闭时 dispose 失败不影响主流程。
    }
    if (bridge.attachmentId) {
      dependencies.releaseWorkspaceHostAttachment(bridge.attachmentId);
    }

    // 置空是“已释放”的唯一标记：异步回调通过它判断自己是否还持有有效资源。
    runtime.currentBridge = undefined;
  }

  // 双重身份校验：窗口级 runtime 必须仍是表里的那一个，且 currentBridge 必须仍是这个对象。
  // 只校验前者会漏掉“同窗口内 bridge 已被替换”的情况，旧回调会把新 bridge 当成自己的。
  function isCurrentBridgeRuntime(
    runtime: WindowControlRuntime,
    bridge: WorkspaceBridgeRuntime,
  ): boolean {
    return runtimes.get(runtime.windowId) === runtime && runtime.currentBridge === bridge;
  }

  // raw 链路自检失败时的降级入口。要点：
  //   - 幂等：同一 bridge 重复 fault 只处理一次（degraded 已是 true 就返回）；
  //   - 只发“非终态”的 bridge-degraded，让 Web 用自己的恢复流程换新身份重建；
  //   - 释放 attachment 但不碰物理 Host：手机短租约与桌面会话是两条生命周期（INV-07）。
  // [失败路径] 如果这里直接发 bridge-error 终态，Web 会停止自动恢复，用户必须手动重开页面。
  function degradeBridgeAfterRawFault(
    runtime: WindowControlRuntime,
    bridge: WorkspaceBridgeRuntime,
    reasonCode: string,
  ): void {
    if (!isCurrentBridgeRuntime(runtime, bridge) || bridge.degraded) return;
    bridge.degraded = true;
    // reasonCode 只进安全日志：它包含 checksum/oversize/future ACK 等内部细节，不对外暴露。
    dependencies.logger.warn("[web-remote-control] raw relay bridge degraded", {
      windowId: runtime.windowId,
      session: runtime.deviceSid,
      bridgeSessionId: bridge.bridgeSessionId,
      bridgeGeneration: bridge.bridgeGeneration,
      recoveryId: bridge.recoveryId,
      reasonCode,
    });
    runtime.pendingBridgeInvalidation = {
      zcode_type: "bridge-degraded",
      bridgeSessionId: bridge.bridgeSessionId,
      ...(bridge.bridgeGeneration === undefined
        ? {}
        : { bridgeGeneration: bridge.bridgeGeneration }),
      ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
      // Bugfix：checksum/oversize/future ACK 等 fault 不能伪装成 frame gap；
      // app control 只传通用恢复原因，typed reasonCode 留在上面的安全日志。
      reason: "rpc-transport-fault",
    };
    // Bug 原因：degraded 后 raw 两端都已禁止继续转发，保留旧 attachment 只会泄漏
    // scoped subscription。物理 Host/Agent 不受影响，只释放手机短生命周期 attachment。
    disposeRuntimeBridgeResources(runtime);
    sendPendingBridgeInvalidation(runtime);
  }

  // 清除定时器必须同时把字段置空：字段既是句柄也是“是否存在待处理任务”的标志位，
  // 只 clearTimeout 不置空会让后续调度判断“已有定时器”而永远不再调度。
  function clearPendingOutboundPayloadTimer(runtime: WindowControlRuntime): void {
    if (!runtime.pendingOutboundPayloadTimer) {
      return;
    }
    clearTimeout(runtime.pendingOutboundPayloadTimer);
    runtime.pendingOutboundPayloadTimer = undefined;
  }

  // 宽限定时器同理，必须置空在回调首行：回调一旦开始执行，本次宽限就已结束。
  function clearMobileDisconnectGraceTimer(runtime: WindowControlRuntime): void {
    if (!runtime.mobileDisconnectGraceTimer) {
      return;
    }
    clearTimeout(runtime.mobileDisconnectGraceTimer);
    runtime.mobileDisconnectGraceTimer = undefined;
  }

  // 状态快照必须是纯函数结果：不读定时器、不读 transport 内部状态，只按字段拼装。
  // 这样任何调用点的 emit 都是幂等快照，UI 不会因为“读到中间态”抖动。
  function buildRuntimeStatus(runtime: WindowControlRuntime): WebRemoteControlStatus {
    // 使用 statusTarget（启动目标）而不是 currentBridge：见 getRuntimeStatusTarget 的说明。
    const target = getRuntimeStatusTarget(runtime);
    return {
      status: runtime.status,
      sessionId: runtime.deviceSid,
      windowControlSessionId: runtime.deviceSid,
      mobileConnected: runtime.mobileConnected,
      mobileViewState: runtime.mobileViewState,
      // null 与 undefined 的差异会被结构化克隆保留：UI 用 null 区分“已确认无视图”。
      mobileTaskView: runtime.mobileTaskView ?? null,
      mobileDeviceInfo: runtime.mobileDeviceInfo,
      qrUrl: runtime.qrUrl,
      connectUrl: runtime.connectUrl,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      // initialTaskId 以当前 bridge 为准：手机可能已经从首页导航到某个任务。
      initialTaskId: runtime.currentBridge?.initialTaskId ?? runtime.initialTaskId,
      error: runtime.error,
      failure: runtime.failure,
    };
  }

  // 状态广播永不抛错：onStatusChanged 是窗口侧注入的回调，它失败不应影响连接状态机。
  function emitRuntimeStatus(runtime: WindowControlRuntime): void {
    dependencies.onStatusChanged?.(runtime.windowId, buildRuntimeStatus(runtime));
  }

  // 清空手机任务视图时必须立刻 emit：视图消失是用户可见的变化，
  // 若等下一次状态推送，手机端会继续展示一个已经失效的任务地址。
  function clearMobileTaskView(runtime: WindowControlRuntime): void {
    if (!runtime.mobileTaskView) return;
    runtime.mobileTaskView = undefined;
    emitRuntimeStatus(runtime);
  }

  // 请求手机回报当前查看位置：只有 paired 且 epoch 存在时才发，
  // 否则请求会被手机侧当作旧代际丢弃，白白产生一次往返。
  function requestMobileTaskView(runtime: WindowControlRuntime): void {
    if (runtime.transportState !== "paired" || !runtime.mobileTaskViewEpoch) return;
    sendAppPayload(runtime, {
      zcode_type: "mobile-task-view-request",
      epoch: runtime.mobileTaskViewEpoch,
    });
  }

  // 停止远控后统一广播 idle：这里不带 workspace 信息，避免 UI 复用旧目标做“重开”操作。
  function emitIdleStatus(windowId: number): void {
    dependencies.onStatusChanged?.(windowId, { status: "idle" });
  }

  // 3s 宽限：把“relay 抖动”与“真的断开”区分开。
  // [权衡] 不立即把 mobileConnected 置 false，是因为 relay 重连通常 1~2s 内完成；
  // 若立刻广播断开，手机端 UI 会闪一次“已断开”，而用户实际什么都没感觉到。
  // 定时器回调里必须重新校验 runtime 身份：宽限期间窗口可能已被关闭或重启。
  function scheduleMobileDisconnectGrace(runtime: WindowControlRuntime): void {
    if (runtime.mobileDisconnectGraceTimer) {
      return;
    }
    runtime.mobileDisconnectGraceTimer = setTimeout(() => {
      runtime.mobileDisconnectGraceTimer = undefined;
      if (runtimes.get(runtime.windowId) !== runtime || runtime.status === "error") {
        return;
      }
      runtime.status = "running";
      runtime.mobileConnected = false;
      emitRuntimeStatus(runtime);
    }, MOBILE_DISCONNECT_STATUS_GRACE_MS);
  }

  // 缓冲超时意味着这批响应/RPC 帧已失去时效（手机端请求多半已超时），
  // 直接整批丢弃并记 warn，比无限堆积更可控。
  function schedulePendingOutboundPayloadTimeout(runtime: WindowControlRuntime): void {
    if (runtime.pendingOutboundPayloadTimer || runtime.pendingOutboundPayloads.length === 0) {
      return;
    }
    runtime.pendingOutboundPayloadTimer = setTimeout(() => {
      runtime.pendingOutboundPayloadTimer = undefined;
      const droppedCount = runtime.pendingOutboundPayloads.splice(0).length;
      dependencies.logger.warn("[web-remote-control] dropped buffered outbound payloads", {
        windowId: runtime.windowId,
        session: runtime.deviceSid,
        droppedCount,
      });
    }, WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS);
  }

  // 统一发送入口：优先用能区分 oversize/unavailable 的 sendPayloadResult；
  // 旧实现只有布尔返回值，此时把 false 一律当 unavailable（保守：宁可重试也不误丢）。
  function sendPayloadToTransport(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): WebRemoteControlPayloadSendResult {
    // 有精确 API 就用精确 API：只有它知道 payload 是否超限（oversize 不该重试）。
    if (runtime.transport.sendPayloadResult) {
      return runtime.transport.sendPayloadResult(payload);
    }
    // 退化路径无法测字节，因此 bytes 填 0；调用方不得把 0 当成“空帧”的判据。
    return runtime.transport.sendPayload(payload)
      ? { kind: "sent", bytes: 0 }
      : { kind: "unavailable" };
  }

  // 补发 degraded 通知。注意这里只处理“发送结果”，不根据 sent 清 latch（INV-17）：
  // 发送成功只表示进了 relay，不代表手机已经消费并换了新身份。
  function sendPendingBridgeInvalidation(runtime: WindowControlRuntime): void {
    const payload = runtime.pendingBridgeInvalidation;
    if (!payload) return;
    const result = sendPayloadToTransport(runtime, payload);
    // oversize 属于代码/协议错误：固定大小的 invalidation 不该超限，这里用 error 级别暴露。
    if (result.kind === "oversize") {
      dependencies.logger.error("[web-remote-control] bridge invalidation is oversized", {
        bridgeSessionId: payload.bridgeSessionId,
        bytes: result.bytes,
        maxBytes: result.maxBytes,
      });
    }
    // unavailable 时保持 latch；sent 后也保留，直到手机用新 bridge identity 发起 open。
  }

  // 入缓冲。达到上限时整批清空而不是丢最旧的一条：
  // [权衡] 这批 payload 之间有先后语义（例如 bootstrap-response 之后紧跟 workspace-list），
  // 只丢头部会让剩余帧建立在缺失的前置上，整批丢弃至少保证手机看到的是一段“空白”而非错序。
  function bufferOutboundPayload(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): void {
    if (runtime.pendingOutboundPayloads.length >= 50) {
      const droppedCount = runtime.pendingOutboundPayloads.length + 1;
      runtime.pendingOutboundPayloads.length = 0;
      clearPendingOutboundPayloadTimer(runtime);
      dependencies.logger.warn("[web-remote-control] dropped overflowing outbound payloads", {
        windowId: runtime.windowId,
        session: runtime.deviceSid,
        droppedCount,
      });
      return;
    }
    runtime.pendingOutboundPayloads.push(payload);
    schedulePendingOutboundPayloadTimeout(runtime);
  }

  // 逐条 flush，遇到 unavailable 立刻停下并重排超时：保持 FIFO，
  // 后面的帧不能越过前面未发出的帧，否则手机侧会看到乱序的响应。
  // oversize 是永久失败，记 warn 后 shift 丢弃，避免同一个超大帧无限占用队头（INV-16）。
  function flushPendingOutboundPayloads(runtime: WindowControlRuntime): void {
    while (runtime.pendingOutboundPayloads.length > 0) {
      const payload = runtime.pendingOutboundPayloads[0];
      if (!payload) {
        break;
      }
      const result = sendPayloadToTransport(runtime, payload);
      if (result.kind === "unavailable") {
        schedulePendingOutboundPayloadTimeout(runtime);
        return;
      }
      if (result.kind === "oversize") {
        // Bugfix：永久 oversize 不能伪装成临时不可发送后反复进入 50 项 buffer。
        dependencies.logger.warn("[web-remote-control] dropped oversize app payload", {
          zcodeType: payload.zcode_type,
          bytes: result.bytes,
          maxBytes: result.maxBytes,
        });
      }
      runtime.pendingOutboundPayloads.shift();
    }
    clearPendingOutboundPayloadTimer(runtime);
  }

  // 所有出站 app payload 的唯一出口。三条分支对应三种发送结果：
  //   sent → 直接结束；oversize → 永久失败，只记日志；unavailable → 进入有界缓冲。
  // [失败路径] 若 unavailable 时静默返回，desktop 对手机请求的响应会凭空消失，
  // 手机只能等到超时，且无法区分“桌面没处理”与“relay 暂时不可用”。
  function sendAppPayload(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlAppPayload,
  ): void {
    // 队列非空时先入队再 flush：新帧必须排在既有帧之后，不能插队。
    if (runtime.pendingOutboundPayloads.length > 0) {
      bufferOutboundPayload(runtime, payload);
      flushPendingOutboundPayloads(runtime);
      return;
    }
    const result = sendPayloadToTransport(runtime, payload);
    if (result.kind === "sent") {
      return;
    }
    if (result.kind === "oversize") {
      dependencies.logger.warn("[web-remote-control] rejected oversize app payload", {
        zcodeType: payload.zcode_type,
        bytes: result.bytes,
        maxBytes: result.maxBytes,
      });
      return;
    }
    // Bugfix: relay suspect 窗口内 sendPayload 会返回 false。
    // desktop 发出的响应/RPC 帧不能静默丢弃，先短暂缓冲，等 paired 恢复后再 flush。
    bufferOutboundPayload(runtime, payload);
  }

  // 把 runtime 收束到 error 终态。这里集中做“一次性的收尾”，因此顺序与 stop 类似：
  // 先尽量把错误告知手机（sendAppPayload），再取消在途 open，最后资源与定时器。
  // 幂等条件只看 reason：同样的故障重复到达（例如 relay 连续发两次 kicked）不再重复广播。
  // [资源] transport.dispose 之后不得再调用 sendAppPayload，否则会写入一个已销毁的 socket。
  function preserveWindowRuntimeFailure(
    windowId: number,
    runtime: WindowControlRuntime,
    reason: string,
    failure: WebRemoteControlFailure,
  ): void {
    if (runtime.status === "error" && runtime.failure?.reason === failure.reason) {
      return;
    }

    // 先发 app-error：此时 transport 仍可用，手机能立刻知道原因并停止重试。
    sendAppPayload(runtime, {
      zcode_type: "app-error",
      reason: failure.reason,
      error: failure.message ?? failure.reason,
    });
    cancelBridgeOpen(runtime);
    disposeRuntimeBridgeResources(runtime);
    clearPendingOutboundPayloadTimer(runtime);
    clearMobileDisconnectGraceTimer(runtime);
    runtime.pendingOutboundPayloads.length = 0;
    runtime.transport.dispose();
    runtime.status = "error";
    runtime.mobileConnected = false;
    runtime.error = failure.message;
    runtime.failure = failure;
    // 写回 Map：调用方可能传入一个已经被删除的 runtime 副本，写回保证 getStatus 能看到 error。
    runtimes.set(windowId, runtime);
    dependencies.logger.warn(
      `[web-remote-control] runtime closed window=${windowId} session=${runtime.deviceSid} reason=${reason} failure=${failure.reason} message=${failure.message ?? "<none>"}`,
    );
    emitRuntimeStatus(runtime);
  }

  // 主动停止一个窗口的远控。第一步永远是 abort lifecycle：
  // 它让所有挂起的 register/http/attach 立刻失败，避免后续 await 再把 runtime 写回来。
  // 之后才从 runtimes 删除，这样错误回调即使晚到也会因身份校验失败而退出（INV-01）。
  // [资源] disposeWorkspaceHostAttachmentsForWindow 放在 transport.dispose 之后：
  // 先切断对外通道，再回收 Host 侧租约，避免收尾消息发到已销毁的 socket。
  async function stopWindowRuntime(windowId: number, reason: string): Promise<void> {
    windowLifecycles.get(windowId)?.controller.abort();
    windowLifecycles.delete(windowId);
    const runtime = runtimes.get(windowId);
    if (!runtime) {
      return;
    }

    // 尽力通知手机“桌面已断开”，失败也无所谓——此时连接本来就要关了。
    sendAppPayload(runtime, {
      zcode_type: "app-error",
      reason: "desktop-disconnected",
      error: "Desktop disconnected this Web remote control session.",
    });
    runtimes.delete(windowId);
    pushedWorkspaceListSignaturesByWindowId.delete(windowId);
    cancelBridgeOpen(runtime);
    disposeRuntimeBridgeResources(runtime);
    clearPendingOutboundPayloadTimer(runtime);
    clearMobileDisconnectGraceTimer(runtime);
    runtime.pendingOutboundPayloads.length = 0;
    runtime.transport.dispose();
    dependencies.disposeWorkspaceHostAttachmentsForWindow(windowId, reason);

    dependencies.logger.info(
      `[web-remote-control] stopped window=${windowId} session=${runtime.deviceSid} reason=${reason}`,
    );
    emitIdleStatus(windowId);
  }

  // 401 / JWT 失效后的统一入口：先停连接（异步但不等待其完成），再打门禁标记。
  // startupRestoreClaimed 复位是有意的：用户重新登录后应允许再次自动恢复上次的远控设置。
  function requireAuthentication(windowId: number): void {
    void stopWindowRuntime(windowId, "auth-required");
    authRequiredWindows.add(windowId);
    startupRestoreClaimed = false;
    dependencies.onStatusChanged?.(windowId, { status: "auth-required" });
  }

  // “手机当前实际在看的目标”：优先 currentBridge（手机可能已切到别的 workspace），
  // 没有 bridge 时才用窗口启动目标。它与 getRuntimeStatusTarget 的用途不同，切勿复用（见下）。
  function getRuntimeWorkspaceTarget(
    runtime: WindowControlRuntime,
  ): WebRemoteControlWorkspaceTarget {
    const bridge = runtime.currentBridge;
    if (bridge) {
      return {
        workspacePath: bridge.workspacePath,
        workspaceIdentity: bridge.workspaceIdentity,
        remoteSessionId: bridge.remoteSessionId,
        label: getPathLabel(bridge.workspacePath),
        kind: bridge.kind,
      };
    }

    return {
      workspacePath: runtime.workspacePath,
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
      label: getPathLabel(runtime.workspacePath),
      kind: runtime.remoteSessionId || runtime.workspaceIdentity ? "remote" : "local",
    };
  }

  // 手机导航会让 currentBridge 漂移到别的 workspace，而桌面弹层只认“启动这个远控会话时”的目标。
  // [权衡] 两个函数看似重复，但语义相反：合并会让弹层误判“不是同一会话”并重启远控，
  // 进而把手机端踢成离线——这是曾经发生过的线上 bug，不要为了去重再合并。
  function getRuntimeStatusTarget(runtime: WindowControlRuntime): WebRemoteControlWorkspaceTarget {
    // Bugfix: 手机端可以在同一个远控会话里切到窗口内的其他 workspace。
    // 之前 getStatus() 复用了当前 bridge 目标，导致桌面弹层按启动 workspace 轮询时误判为“不是同一会话”，
    // 再次打开弹层会重启远控并把手机端踢成离线。状态接口保持窗口远控会话的原始目标，
    // 手机当前 workspace 仍通过 mobileViewState / workspace list 表达。
    return {
      workspacePath: runtime.workspacePath,
      workspaceIdentity: runtime.workspaceIdentity,
      remoteSessionId: runtime.remoteSessionId,
      label: getPathLabel(runtime.workspacePath),
      kind: runtime.remoteSessionId || runtime.workspaceIdentity ? "remote" : "local",
    };
  }

  // 手机端可见的 workspace 列表 = 渲染进程同步来的全量 + 当前 bridge 目标（若未包含）。
  // 去重用 workspaceKey，因此同一物理目录在本地/远程两种身份下会得到两个条目，这是刻意的。
  // [权衡] 允许列出未连接的 SSH 项目（disconnected 卡片），与桌面端保持一致；
  // 真正打开时 buildWorkspaceBridge 还会再校验 remoteSessionId，不会误连。
  function getAvailableWorkspaces(
    runtime: WindowControlRuntime,
  ): WebRemoteControlWorkspaceTarget[] {
    const workspaceByKey = new Map<string, WebRemoteControlWorkspaceTarget>();

    for (const workspace of availableWorkspacesByWindowId.get(runtime.windowId) ?? []) {
      // Bugfix: 手机端 workspace 列表需要和桌面端一致展示已断开的 SSH 项目。
      // 这里仅保留列表项；真正创建 bridge 时仍会校验 remoteSessionId，避免未连接项目被直接打开聊天。
      workspaceByKey.set(resolveWebRemoteControlWorkspaceKey(workspace), workspace);
    }

    const currentTarget = getRuntimeWorkspaceTarget(runtime);
    if (isBridgeableRemoteTarget(currentTarget)) {
      const currentKey = resolveWebRemoteControlWorkspaceKey(currentTarget);
      if (!workspaceByKey.has(currentKey)) {
        workspaceByKey.set(currentKey, currentTarget);
      }
    }

    return [...workspaceByKey.values()];
  }

  // 启动时带 initialTaskId 才生成初始视图，且目标必须可 bridge：
  // 否则手机会打开一个“指向已失效远程会话”的任务详情。
  function getRuntimeInitialViewState(
    runtime: WindowControlRuntime,
  ): WebRemoteControlMobileViewState | undefined {
    const activeTarget = getRuntimeWorkspaceTarget(runtime);
    if (!runtime.initialTaskId || !isBridgeableRemoteTarget(activeTarget)) {
      return undefined;
    }

    return {
      activeWorkspaceKey: resolveWebRemoteControlWorkspaceKey(activeTarget),
      activeTaskId: runtime.initialTaskId,
      updatedAt: Date.now(),
    };
  }

  // bootstrap 只带“连接会话 + 列表 + 视图”，不带任何任务内容：
  // 手机随后通过 bridge 的 RPC 通道按需拉取，避免握手阶段传输大对象。
  function buildBootstrapResult(
    runtime: WindowControlRuntime,
  ): WebRemoteControlWindowBootstrapResult {
    return {
      windowControlSessionId: runtime.deviceSid,
      desktopAppVersion: dependencies.appVersion,
      workspaces: getAvailableWorkspaces(runtime),
      initialViewState: getRuntimeInitialViewState(runtime),
      mobileViewState: runtime.mobileViewState,
      mobileTaskViewEpoch: runtime.mobileTaskViewEpoch,
    };
  }

  // activeWorkspaceKey 的优先级：手机最近上报的视图 > 启动时的初始视图 > 当前目标；用“手机上报优先”是为了在重连后保持用户离开时的位置，而不是被拉回窗口启动目标。
  function buildWorkspaceListResult(
    runtime: WindowControlRuntime,
  ): WebRemoteControlWorkspaceListResult {
    const activeTarget = getRuntimeWorkspaceTarget(runtime);
    const initialViewState = getRuntimeInitialViewState(runtime);
    // 注意：activeWorkspaceKey 直接采用手机上报值，未在 workspaces 中校验存在性；项目移除后该悬空 key 会继续计入列表签名并持续推送（D-10-1，待修）。
    return {
      workspaces: getAvailableWorkspaces(runtime),
      activeWorkspaceKey:
        runtime.mobileViewState?.activeWorkspaceKey ??
        initialViewState?.activeWorkspaceKey ??
        resolveWebRemoteControlWorkspaceKey(activeTarget),
      activeTaskId:
        runtime.mobileViewState?.activeTaskId ??
        runtime.currentBridge?.initialTaskId ??
        initialViewState?.activeTaskId,
    };
  }

  // 列表签名用于“只在真正变化时才推送”。签名必须包含所有手机可见字段：
  //   - connectionState：决定卡片是绿色还是灰色；
  //   - lastConnectionError：同一 disconnected 状态下错误原因也会变，手机直接展示它；
  //   - remoteSessionId：远程会话换了之后，用户点开的行为不同。
  // [权衡] 用 JSON.stringify 的 tuple 数组而不是分隔符字符串：用户可见文案里可能包含分隔符，
  // 拼字符串会让两个不同快照得到相同签名，从而漏推一次更新。
  function buildWorkspaceListPushSignature(result: WebRemoteControlWorkspaceListResult): string {
    const workspaceSignatureEntries = result.workspaces
      .map((workspace) => {
        const workspaceKey = resolveWebRemoteControlWorkspaceKey(workspace);
        return JSON.stringify([
          workspaceKey,
          workspace.kind,
          workspace.connectionState ?? "connected",
          workspace.remoteSessionId ?? "",
          // Bugfix：连接状态不只包含枚举值；同一 disconnected 状态下错误原因也会变化，
          // 手机 workspace card 直接展示 lastConnectionError，必须触发新快照。
          workspace.lastConnectionError ?? "",
        ]);
      })
      .sort();

    // Bugfix：title / connection error 是任意用户可见字符串，不能再用控制字符拼接 tuple；
    // 否则字段值本身包含分隔符时不同快照可能得到相同签名。JSON tuple 保持字段边界且仍忽略数组顺序。
    return JSON.stringify(workspaceSignatureEntries);
  }

  // pushWorkspaceListUpdated 的推送去重：签名相同就完全不发。这里不做“节流”，因为签名比较本身很便宜，而漏推一次的代价是手机列表长期显示过期状态。
  function pushWorkspaceListUpdated(runtime: WindowControlRuntime): void {
    const result = buildWorkspaceListResult(runtime);
    const signature = buildWorkspaceListPushSignature(result);
    if (pushedWorkspaceListSignaturesByWindowId.get(runtime.windowId) === signature) {
      return;
    }

    pushedWorkspaceListSignaturesByWindowId.set(runtime.windowId, signature);
    sendAppPayload(runtime, {
      zcode_type: "workspace-list-updated",
      result,
    });
  }

  // 平台请求（例如打开文件、系统通知）必须在 Main 侧执行，结果统一包成 platform-response。
  // [失败路径] 不把异常抛出去：requestId 必须在任何情况下都有回包，
  // 否则手机端的这次调用永远挂起，后续同类操作也会被 UI 锁住。
  async function respondToPlatformRequest(
    runtime: WindowControlRuntime,
    request: WebRemoteControlPlatformRequestPayload,
  ): Promise<void> {
    let response: WebRemoteControlPlatformResponsePayload;

    try {
      // args 的类型由 method 决定，这里用 never 收敛泛型；真正的校验在 handler 内部。
      const result = await dependencies.platformHandlers[request.method](request.args as never);
      response = {
        zcode_type: "platform-response",
        requestId: request.requestId,
        method: request.method,
        success: true,
        result,
      } as WebRemoteControlPlatformResponsePayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.warn(
        `[web-remote-control] platform request failed window=${runtime.windowId} session=${runtime.deviceSid} method=${request.method} error=${message}`,
      );
      response = {
        zcode_type: "platform-response",
        requestId: request.requestId,
        method: request.method,
        success: false,
        error: message,
      };
    }

    sendAppPayload(runtime, response);
  }

  // 取消正在进行的 open：先摘掉 bridgeOpen（让 promise 的后续校验失败），
  // 再通知 Host 侧停止准备。顺序反过来会让 Host 先返回、而 Main 仍认为这是当前请求。
  function cancelBridgeOpen(runtime: WindowControlRuntime): void {
    const pending = runtime.bridgeOpen;
    runtime.bridgeOpen = undefined;
    if (pending?.preparingProject)
      dependencies.cancelProjectPreparation?.(runtime.windowId, pending.hostRequestId);
  }

  // open 的 admission 层。三件事：
  //   1) intentKey 把“同一 bridge 身份只能对应同一导航意图”钉死（INV-06）；
  //   2) 同身份同意图的重试直接复用已有 Promise，避免 Host attach 做两遍；
  //   3) 新导航立即取消旧 open，让旧异步结果在后续校验中被识别为 superseded。
  // [失败路径] 身份相同但意图不同必须 reject 而不是覆盖：手机是在复用旧 bridge 发新请求，
  // 说明它的本地状态已错乱，继续执行会得到“bridge 指向 A、UI 展示 B”的错位。
  function createWorkspaceBridge(
    runtime: WindowControlRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
  ): Promise<WebRemoteControlExternalWorkspaceBridge> {
    const intentKey = JSON.stringify([
      request.workspaceKey,
      request.taskId ?? null,
      request.project?.projectId,
      request.project?.hostId,
      request.project?.draftId,
      request.taskHostId,
      request.fileTreeTaskId,
    ]);
    const previous = runtime.bridgeOpen;
    if (
      previous?.bridgeSessionId === request.bridgeSessionId &&
      previous.bridgeGeneration === request.bridgeGeneration
    ) {
      if (previous.intentKey !== intentKey)
        return Promise.reject(new Error("Workspace bridge identity cannot change intent."));
      if (
        runtime.currentBridge?.degraded ||
        (runtime.pendingBridgeInvalidation?.bridgeSessionId === request.bridgeSessionId &&
          runtime.pendingBridgeInvalidation.bridgeGeneration === request.bridgeGeneration)
      )
        return Promise.reject(new Error("Degraded workspace bridge requires a new identity."));
      return previous.promise;
    }
    cancelBridgeOpen(runtime);
    // 同一 transport identity 的重试复用整次 admission；新导航立即使旧异步结果失效。
    const pending: NonNullable<WindowControlRuntime["bridgeOpen"]> = {
      bridgeSessionId: request.bridgeSessionId,
      bridgeGeneration: request.bridgeGeneration,
      intentKey,
      hostRequestId: randomUUID(),
      preparingProject: Boolean(request.project || request.taskHostId),
      promise: undefined as never,
    };
    runtime.bridgeOpen = pending;
    pending.promise = buildWorkspaceBridge(runtime, request, pending);
    return pending.promise;
  }

  // 真正的建桥流程。可分成四段：
  //   A. 解析目标（本地列表查找 或 Host 侧 prepareProjectWorkspace）；
  //   B. 校验“这个请求仍是当前请求”（superseded / degraded / 目标可 bridge）；
  //   C. attach Host 并接线双向协议；
  //   D. 宣告 ready 或按失败清理。
  // 每一段之间都有 await，因此每次回来都必须重新校验身份——这是本函数最容易被改坏的地方。
  async function buildWorkspaceBridge(
    runtime: WindowControlRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
    pending: NonNullable<WindowControlRuntime["bridgeOpen"]>,
  ): Promise<WebRemoteControlExternalWorkspaceBridge> {
    let target: WebRemoteControlWorkspaceTarget | undefined;
    // 两种导航意图互斥：
    //   - project：打开/新建项目（带 projectId/hostId/draftId）；
    //   - task：从文件树打开某个任务，必须同时有 taskHostId 才能定位 Host。
    // 两者都缺失时退化为“在已知列表里按 workspaceKey 找”，不再触发 Host 侧准备。
    const intent: HostProjectWorkspaceNavigationInput | undefined =
      request.project ??
      ((request.fileTreeTaskId || request.taskId) && request.taskHostId
        ? {
            hostId: request.taskHostId,
            task: {
              taskId: (request.fileTreeTaskId ?? request.taskId)!,
              workspaceKey: request.workspaceKey,
            },
          }
        : undefined);
    if (intent) {
      // 同时指定 project 与 taskId 是自相矛盾的意图；没有 prepareProjectWorkspace 依赖时也无法执行。
      if ((request.project && request.taskId) || !dependencies.prepareProjectWorkspace)
        throw new Error("Project navigation is unavailable.");
      try {
        // 准备过程在 Host 侧可能耗时（要起进程/连远端），因此用 pending.hostRequestId 关联以便取消。
        const prepared = await dependencies.prepareProjectWorkspace(
          runtime.windowId,
          intent,
          pending.hostRequestId,
        );
        target = {
          workspacePath: prepared.workspacePath,
          workspaceIdentity: prepared.workspaceIdentity,
          remoteSessionId: prepared.remote?.remoteSessionId,
          kind: prepared.remote ? "remote" : "local",
          label: prepared.workspacePath,
          ...(prepared.remote ? { connectionState: "connected" as const } : {}),
        };
      } finally {
        // 无论成功失败都要复位 preparingProject：它决定 cancelBridgeOpen 是否需要通知 Host，
        // 一直为 true 会让后续取消调用打到一个已完成的 requestId 上。
        pending.preparingProject = false;
      }
    } else {
      // 本地路径：只在已知列表里找，不隐式创建目标（避免手机凭 workspaceKey 打开任意目录）。
      target = getAvailableWorkspaces(runtime).find(
        (workspace) => resolveWebRemoteControlWorkspaceKey(workspace) === request.workspaceKey,
      );
    }
    // 第一个 await 归来做双重校验：窗口可能已销毁，或手机已发出新的 open 取代本次请求。
    if (runtimes.get(runtime.windowId) !== runtime || runtime.bridgeOpen !== pending)
      throw new Error("Workspace bridge request was superseded.");
    if (!target) {
      throw new Error("目标工作区不在当前桌面窗口中，无法创建 Web 远程控制 bridge。");
    }
    if (!isBridgeableRemoteTarget(target)) {
      throw new Error("目标远程工作区尚未连接，无法创建 bridge，请先重连。");
    }
    const targetWorkspaceKey = resolveWebRemoteControlWorkspaceKey(target);

    // 第二个 await（如果有）之后再做一次 degraded 校验：期间 relay 可能已判定链路失效。
    // 注意这里比较的是“请求带来的身份”与“已投递的 invalidation 身份”，
    // 相等说明手机仍在复用被废弃的 bridge，必须拒绝（INV-05）。
    const invalidation = runtime.pendingBridgeInvalidation;
    if (
      invalidation?.bridgeSessionId === request.bridgeSessionId &&
      invalidation.bridgeGeneration === request.bridgeGeneration
    ) {
      throw new Error("Degraded workspace bridge must be rebuilt with a new transport identity.");
    }
    // 收到新 identity 的 open 已证明手机消费了 invalidation；后续失败由显式 bridge-error
    // 和 Web 侧有界 retry 收口，不再重复旧 generation 的 degraded 通知。
    runtime.pendingBridgeInvalidation = undefined;

    // 换桥前先释放旧 bridge：同一窗口永远只允许一个物理 attachment 在途（INV-02）。
    // 状态先切 connecting 再 attach，UI 才能解释“这段时间的空白”。
    disposeRuntimeBridgeResources(runtime);
    runtime.status = "connecting";
    runtime.error = undefined;
    runtime.failure = undefined;
    emitRuntimeStatus(runtime);

    // 先占位再 await attach：所有回调都通过 runtime.currentBridge 找到它，
    // 提前挂上可以让 attach 期间的竞态（window 关闭）通过 isCurrentBridgeRuntime 识别出来。
    const bridgeRuntime: WorkspaceBridgeRuntime = {
      bridgeSessionId: request.bridgeSessionId,
      bridgeGeneration: request.bridgeGeneration,
      recoveryId: request.recoveryId,
      hostEntryId: "",
      attachmentId: "",
      kind: target.kind,
      workspaceKey: targetWorkspaceKey,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      remoteSessionId: target.remoteSessionId,
      initialTaskId: request.taskId,
      readyAnnounced: false,
      degraded: false,
    };
    runtime.currentBridge = bridgeRuntime;

    dependencies.logger.info(
      `[web-remote-control] attaching workspace bridge window=${runtime.windowId} session=${runtime.deviceSid} bridgeSession=${request.bridgeSessionId} workspace=${target.workspacePath}`,
    );

    let acquired: WebRemoteControlHostAttachmentHandle | undefined;
    try {
      // attach 是本函数最后一个可能长时间挂起的 await；它返回的 port 才是真正的数据面。
      acquired = await dependencies.attachWorkspaceHost(runtime.windowId, {
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        remoteSessionId: target.remoteSessionId,
        initialTaskId: request.taskId,
        kind: target.kind,
      });
      // attach 期间请求可能被取代：此时必须立刻归还刚拿到的 attachment，否则租约会泄漏。
      // 置 acquired = undefined 是为了让 catch 分支不要重复释放。
      if (!isCurrentBridgeRuntime(runtime, bridgeRuntime) || runtime.bridgeOpen !== pending) {
        dependencies.releaseWorkspaceHostAttachment(acquired.attachmentId);
        acquired = undefined;
        throw new Error("Workspace bridge request was superseded.");
      }
      // 两条协议各管一段：
      //   hostProtocol：Main ↔ Host 的 MessagePort（流控靠 saturated/drained）；
      //   relayProtocol：Main ↔ 手机的 acknowledged 帧，重放、checksum、seq 必须都在这里处理。
      // 两者串联成纯管道，Main 不解析帧内容。
      const hostProtocol = new MessagePortProtocol(wrapElectronPort(acquired.port));
      const relayProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
        bridgeSessionId: bridgeRuntime.bridgeSessionId,
        bridgeGeneration: bridgeRuntime.bridgeGeneration,
        recoveryId: bridgeRuntime.recoveryId,
        // 字节口径必须与手机端一致：优先用 transport 实际编码后的长度，
        // 退化为协议层估算。两者不一致会让手机按更小的上限拒绝帧。
        measureFrameBytes: (frame) =>
          runtime.transport.measurePayloadBytes?.(frame) ??
          measureWebRemoteControlRpcRelayEnvelopeBytes(frame),
        sendFrame: (payload) => {
          // 未宣告 ready 或已 degraded 时返回 false，让 adapter 把帧留在队列（INV-03）。
          if (!bridgeRuntime.readyAnnounced || bridgeRuntime.degraded) return false;
          const result = sendPayloadToTransport(runtime, payload);
          // oversize 必须抛出：adapter 需要据此触发降级，而不是无休止重试同一个超大帧。
          if (result.kind === "oversize") {
            throw new Error("remote.rpcFrame.envelopeTooLarge");
          }
          return result.kind === "sent";
        },
      });

      // Bugfix：raw adapter 是唯一 replay owner；main 不再把 rpc-frame 放进普通 50 项 buffer。
      // Host → 手机方向直接交给 adapter，由它负责编号、checksum 与未 ACK 重放（INV-04）。
      const disposeHostToRelay = hostProtocol.onMessage((buffer) => {
        relayProtocol.protocol.send(buffer);
      });
      // 手机 → Host 方向不需要重放：手机侧有自己的 send queue，Main 只是透明转发。
      const disposeRelayToHost = relayProtocol.protocol.onMessage((buffer) => {
        hostProtocol.send(buffer);
      });
      // 降级回调只处理“当前仍是这个 bridge”的情况，避免旧适配器把新 bridge 打上 degraded。
      const disposeDegraded = relayProtocol.onDegraded((fault) => {
        degradeBridgeAfterRawFault(runtime, bridgeRuntime, fault.reasonCode);
      });
      // 流控是单向的：手机侧饱和时告诉 Host 暂停产出；排空后恢复。
      // 这两个 handler 都显式排除 degraded，因为降级后 hostProtocol 可能已断开。
      const disposeSaturated = relayProtocol.onSaturated(() => {
        if (!isCurrentBridgeRuntime(runtime, bridgeRuntime) || bridgeRuntime.degraded) return;
        hostProtocol.sendFlowState("saturated");
      });
      const disposeDrained = relayProtocol.onDrained(() => {
        if (!isCurrentBridgeRuntime(runtime, bridgeRuntime) || bridgeRuntime.degraded) return;
        hostProtocol.sendFlowState("drained");
      });

      // 全部接线成功后才把资源写进 bridgeRuntime：在此之前任何一次抛错，
      // disposeRuntimeBridgeResources 看到的都是一个“空资源”对象，不会重复释放。
      bridgeRuntime.hostEntryId = acquired.entryId;
      bridgeRuntime.attachmentId = acquired.attachmentId;
      bridgeRuntime.hostProtocol = hostProtocol;
      bridgeRuntime.relayProtocol = relayProtocol;
      // 这里的 disposeBridge 只解订阅；协议与 attachment 的释放顺序由 disposeRuntimeBridgeResources 统一掌握。
      bridgeRuntime.disposeBridge = () => {
        disposeHostToRelay.dispose();
        disposeRelayToHost.dispose();
        disposeDegraded.dispose();
        disposeSaturated.dispose();
        disposeDrained.dispose();
      };
      // 到这一步才置 active：手机在收到 bridge-ready 之前不会发 RPC，因此这里的时序不敏感。
      runtime.status = "active";
      runtime.error = undefined;
      runtime.failure = undefined;
      emitRuntimeStatus(runtime);

      dependencies.logger.info(
        `[web-remote-control] workspace bridge active window=${runtime.windowId} session=${runtime.deviceSid} bridgeSession=${request.bridgeSessionId}`,
      );
      reportRemoteUsageEvent(
        runtime.windowId,
        buildWebRemoteControlBridgeResultTelemetry({
          result: "success",
          workspaceKind: target.kind,
          remoteKind: resolveRemoteKind(target, acquired),
          entryKind: request.taskId ? "task" : "home",
        }),
      );

      return toExternalBridge(bridgeRuntime);
    } catch (error) {
      // 失败也要记 telemetry：手机侧只能看到 bridge-error，排障依赖这里的分类结果。
      reportRemoteUsageEvent(
        runtime.windowId,
        buildWebRemoteControlBridgeResultTelemetry({
          result: "failure",
          workspaceKind: target.kind,
          remoteKind: resolveRemoteKind(target, acquired),
          entryKind: request.taskId ? "task" : "home",
          errorCategory: classifyRemoteUsageError(error),
        }),
      );
      // 尚未登记到 bridgeRuntime 的 attachment 由这里单独释放；
      // 已登记的则由下面的 disposeRuntimeBridgeResources 统一释放，两条路径互斥。
      if (acquired) {
        dependencies.releaseWorkspaceHostAttachment(acquired.attachmentId);
      }
      // 只有“仍是当前 bridge”才回退状态：被取代的请求不能把新 bridge 的状态改回 running。
      if (isCurrentBridgeRuntime(runtime, bridgeRuntime)) {
        disposeRuntimeBridgeResources(runtime);
        runtime.status = runtime.mobileConnected ? "active" : "running";
        emitRuntimeStatus(runtime);
      }
      throw error;
    }
  }

  // open 的响应层：先发送 bridge-ready，再放开 raw 帧。
  // 顺序是本文件最重要的时序约束之一（INV-03）：
  // [失败路径] 若先 flush 再发 ready，手机会收到“不认识 bridgeSessionId 的帧”而丢弃，表现为首屏长时间空白，且日志里看不到任何错误。
  async function respondToWorkspaceBridgeOpen(
    runtime: WindowControlRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
  ): Promise<void> {
    try {
      const bridge = await createWorkspaceBridge(runtime, request);
      // bridge-ready 走普通 app transport（此时 readyAnnounced 仍是 false，raw 帧仍被扣住）。
      sendAppPayload(runtime, {
        zcode_type: "workspace-bridge-ready",
        requestId: request.requestId,
        bridgeSessionId: request.bridgeSessionId,
        ...(request.bridgeGeneration !== undefined
          ? { bridgeGeneration: request.bridgeGeneration }
          : {}),
        ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
        bridge,
      });
      // 只有“当前 bridge 身份与请求一致”时才开闸：期间手机可能已发起新 open。
      const currentBridge = runtime.currentBridge;
      if (
        currentBridge?.bridgeSessionId === request.bridgeSessionId &&
        currentBridge.bridgeGeneration === request.bridgeGeneration
      ) {
        // bridge-ready 必须先进入 ordinary app transport，才允许 queued raw frames 开闸。
        currentBridge.readyAnnounced = true;
        currentBridge.relayProtocol?.flushPendingFrames();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.warn(
        `[web-remote-control] workspace bridge failed window=${runtime.windowId} session=${runtime.deviceSid} workspaceKey=${request.workspaceKey} error=${message}`,
      );
      // 失败必须回 bridge-error 且带上原 requestId：手机靠它把 pending UI 收敛到错误态，
      // 否则 open 的 Promise 永远 pending，用户会看到一个不会结束的加载动画。
      sendAppPayload(runtime, {
        zcode_type: "workspace-bridge-error",
        requestId: request.requestId,
        bridgeSessionId: request.bridgeSessionId,
        ...(request.bridgeGeneration !== undefined
          ? { bridgeGeneration: request.bridgeGeneration }
          : {}),
        ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
        reason: mapWorkspaceBridgeFailureReason(error),
        error: message,
      });
    }
  }

  // 手机请求重连某个 workspace：Main 只转交给窗口侧，不自己维护 SSH 会话。
  // 成功/失败都回 response（而不是只回成功），让手机能区分“还在重连”与“重连失败”。
  async function respondToWorkspaceReconnectRequest(
    runtime: WindowControlRuntime,
    request: Extract<WebRemoteControlAppPayload, { zcode_type: "workspace-reconnect-request" }>,
  ): Promise<void> {
    try {
      await dependencies.reconnectWorkspace(runtime.windowId, request.workspaceKey);
      // 重连成功不等待 bridge 重建：手机应收到“已连上”后自行发起 workspace-bridge-open。
      sendAppPayload(runtime, {
        zcode_type: "workspace-reconnect-response",
        requestId: request.requestId,
        workspaceKey: request.workspaceKey,
        success: true,
      });
    } catch (error) {
      // 失败原因原样带回（窗口侧会给出可读文案），手机据此展示“重连失败”并提供重试。
      // 注意这里不触发 preserveWindowRuntimeFailure：重连失败不等于远控链路故障。
      sendAppPayload(runtime, {
        zcode_type: "workspace-reconnect-response",
        requestId: request.requestId,
        workspaceKey: request.workspaceKey,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 视图状态只是“手机看到哪里”的提示，不触发任何副作用；deviceInfo 用于在弹层里展示机型，
  // 缺失时保留上一次已知值，避免手机端某些路径不带 deviceInfo 时把信息清空。
  function applyMobileViewStateUpdate(
    runtime: WindowControlRuntime,
    viewState: WebRemoteControlMobileViewState,
    deviceInfo?: WebRemoteControlMobileDeviceInfo,
  ): void {
    runtime.mobileViewState = viewState;
    if (deviceInfo) {
      runtime.mobileDeviceInfo = deviceInfo;
    }
  }

  // applyMobileTaskViewUpdate 是手机“当前任务视图”的上报处理，也是本文件过滤条件最多的函数。
  // 五个条件缺一不可，任何一个放宽都会引入“旧视图覆盖新状态”的故障：
  //   paired：非配对态下 transport 不保证顺序；
  //   epoch：配对代际，重连后旧页面不得继续写入；
  //   seq：单调递增，防止乱序到达的旧包回滚视图；
  //   readyAnnounced && !degraded：bridge 不可用时视图无意义；
  //   地址一致：workspacePath 与 workspaceKey 必须都等于 bridge 目标。
  function applyMobileTaskViewUpdate(
    runtime: WindowControlRuntime,
    payload: WebRemoteControlMobileTaskViewUpdatePayload,
  ): void {
    const bridge = runtime.currentBridge;
    const view = payload.view;
    // 导航缓存、断线宽限和旧 bridge 回包都不能证明当前查看；只接收本代配对的完整地址。
    if (
      runtime.transportState !== "paired" ||
      payload.epoch !== runtime.mobileTaskViewEpoch ||
      payload.seq <= (runtime.mobileTaskViewSeq ?? -1) ||
      !bridge?.readyAnnounced ||
      bridge.degraded ||
      payload.bridgeSessionId !== bridge.bridgeSessionId ||
      payload.bridgeGeneration !== bridge.bridgeGeneration ||
      (view &&
        (view.workspacePath !== bridge.workspacePath ||
          resolveWebRemoteControlWorkspaceKey(view) !== bridge.workspaceKey))
    )
      return;
    runtime.mobileTaskViewSeq = payload.seq;
    // legacy 身份不能反查 Source；读与 CAS 必须携带所属 bridge 的可信 session，不能接受 Web 自报。
    // 远程 bridge 的 remoteSessionId 由 Main 决定，手机只能声明“哪个任务”，不能声明“哪个会话”。
    const trustedView = view
      ? {
          ...view,
          ...(bridge.kind === "remote" ? { remoteSessionId: bridge.remoteSessionId } : {}),
        }
      : undefined;
    // 值相同就不 emit：手机在滚动时可能高频上报同一个位置，去重能避免状态广播风暴。
    const previous = runtime.mobileTaskView;
    if (
      previous?.taskId === trustedView?.taskId &&
      previous?.workspacePath === trustedView?.workspacePath &&
      previous?.workspaceIdentity === trustedView?.workspaceIdentity &&
      previous?.remoteSessionId === trustedView?.remoteSessionId
    )
      return;
    runtime.mobileTaskView = trustedView;
    emitRuntimeStatus(runtime);
  }

  // rpc-frame 与 rpc-frame-ack 都先交给 raw 通道判定：ack 也必须经过 adapter 才能推进
  // 未 ACK 窗口；若在 Main 里直接忽略 ack，重放会永远重复。
  function routeRpcTransportPayload(
    runtime: WindowControlRuntime,
    frame: WebRemoteControlRpcTransportPayload,
  ): void {
    // 返回值刻意忽略：认领失败等同于“不是本代际的帧”，无需额外处理。
    routeRawTransportCandidate(runtime, frame);
  }

  // 返回 boolean 表示“adapter 是否认领了这个 payload”。
  // 未认领的帧（格式不匹配/非本 bridge 代际）会被上层静默忽略，避免误触发降级。
  function routeRawTransportCandidate(runtime: WindowControlRuntime, payload: unknown): boolean {
    const bridge = runtime.currentBridge;
    if (!bridge || bridge.degraded) return false;
    // acceptPayload 内部会按 bridge 身份过滤帧；未认领时返回 false 而非抛错，这是版本偏斜（手机发了更高版本的帧类型）的正常表现。
    return bridge.relayProtocol?.acceptPayload(payload) ?? false;
  }

  // 手机诊断日志只做转写，不做聚合或限流；限流交给 logger 自身，因为这里的字段是排障时唯一能区分“手机端网络问题”和“桌面 relay 问题”的证据。
  // 注意 level 是手机给的字符串，这里不映射成 logger 的级别：
  // [权衡] 映射会丢掉手机端的原始级别语义，排障时反而更难对齐两侧时间线。
  function logMobileDiagnostic(
    runtime: WindowControlRuntime,
    payload: Extract<WebRemoteControlAppPayload, { zcode_type: "mobile-diagnostic" }>,
  ): void {
    dependencies.logger.info("[web-remote-control] mobile diagnostic", {
      window: runtime.windowId,
      session: runtime.deviceSid,
      event: payload.event,
      state: payload.state,
      previousState: payload.previousState,
      pairStatus: payload.pairStatus,
      closeCode: payload.closeCode,
      closeReason: payload.closeReason,
      wasClean: payload.wasClean,
      wasPaired: payload.wasPaired,
      failureReason: payload.failureReason,
      failureMessage: payload.failureMessage,
      visibilityState: payload.visibilityState,
      online: payload.online,
      hiddenDurationMs: payload.hiddenDurationMs,
      timestamp: payload.timestamp,
    });
  }

  // 手机 app payload 的总路由。分支的设计原则：
  //   - 请求类（bootstrap / workspace-list / platform / bridge-open / reconnect）都有 requestId，
  //     必须回包；其中耗时的走 void 异步，不阻塞后续帧；
  //   - 状态类（view-state / task-view）同步处理，无回包；
  //   - raw 帧交给 adapter，Main 不解析；
  //   - 未知类型落到 default 静默丢弃：旧版 Main 收到新版手机的新消息时不应报错，
  //     否则一次协议升级就会让旧桌面端把手机端整条连接打成错误。
  function routePayload(runtime: WindowControlRuntime, payload: WebRemoteControlAppPayload): void {
    switch (payload.zcode_type) {
      // bootstrap 与 workspace-list 都是“有 requestId 的查询”，必须立即回包；
      // 它们只读 runtime 快照，不触发任何 await，因此可以同步处理。
      case "bootstrap-request":
        sendAppPayload(runtime, {
          zcode_type: "bootstrap-response",
          requestId: payload.requestId,
          success: true,
          result: buildBootstrapResult(runtime),
        });
        break;
      case "workspace-list-request":
        sendAppPayload(runtime, {
          zcode_type: "workspace-list-response",
          requestId: payload.requestId,
          success: true,
          result: buildWorkspaceListResult(runtime),
        });
        break;
      // 平台请求必须异步：handler 可能打开系统对话框，同步等待会阻塞 relay 的读循环。
      case "platform-request":
        void respondToPlatformRequest(runtime, payload);
        break;
      // 视图上报是纯状态写入，同步处理可保证“上报顺序 = 应用顺序”。
      case "mobile-view-state-update":
        applyMobileViewStateUpdate(runtime, payload.viewState, payload.deviceInfo);
        break;
      case "mobile-task-view-update":
        applyMobileTaskViewUpdate(runtime, payload);
        break;
      // 建桥包含跨进程 await，不能阻塞后续帧（尤其不能挡住 rpc-frame-ack）。
      case "workspace-bridge-open":
        void respondToWorkspaceBridgeOpen(runtime, payload);
        break;
      case "workspace-reconnect-request":
        void respondToWorkspaceReconnectRequest(runtime, payload);
        break;
      // raw 帧必须先于状态机处理，否则重放窗口会被延后。
      case "rpc-frame":
      case "rpc-frame-ack":
        routeRpcTransportPayload(runtime, payload);
        break;
      case "telemetry-report":
        // 手机已在创建边界构造事件；Main 只转发，不维护会话事实或干预 replayable 链路。
        // [权衡] 不做二次校验：事件字段属于移动端契约，Main 重写会让两端口径不一致。
        dependencies.reportRendererTelemetryEvent?.(payload.event);
        break;
      case "mobile-diagnostic":
        logMobileDiagnostic(runtime, payload);
        break;
      // default 不记 warn：未知 zcode_type 是正常的版本偏斜，不是错误。
      default:
        break;
    }
  }

  // relay 状态机 → 业务状态机的唯一映射点。这里刻意做成“一个入口 + 顺序判断”：
  // 每个 relay 状态只处理一次显式转换，且都带 previousTransportState 守卫，因为 transport 可能在状态不变时重复回调（心跳、重连确认）。
  // 状态语义：
  //   connecting/authenticating → 未配对过则 starting；曾配对则宽限保持 active；
  //   waiting_terminal           → 等待手机扫码/确认，未配对时 running；
  //   paired                     → active 并 flush 缓冲；
  //   kicked/error               → 终态或错误。
  function mapTransportState(
    runtime: WindowControlRuntime,
    state: WebRemoteControlDeviceTransportState,
  ): void {
    const previousTransportState = runtime.transportState;
    runtime.transportState = state;
    // 瞬时查看不能沿用连接弹窗的断线宽限；恢复必须由新 epoch 下的可见页面重新声明。
    // 只要离开 paired 就作废 epoch/seq：手机重连后会拿到新 epoch，旧页面无法再写入。
    if (state !== "paired") {
      runtime.mobileTaskViewEpoch = undefined;
      runtime.mobileTaskViewSeq = undefined;
      clearMobileTaskView(runtime);
    } else if (previousTransportState !== "paired") {
      // 新一次配对：-1 表示“还没有任何 seq”，因此第一条 seq=0 也能通过严格递增判断。
      runtime.mobileTaskViewEpoch = randomUUID();
      runtime.mobileTaskViewSeq = -1;
    }
    // send-ready 的“首次”判定只在同一配对内有效，离开 paired 必须复位。
    if (state !== "paired") {
      runtime.hasObservedSendReadyForPairing = false;
    }
    // waiting/paired 是可达状态，之前记录的失败已经不再成立，清掉避免 UI 一直显示红条。
    if (state === "waiting_terminal" || state === "paired") {
      runtime.error = undefined;
      runtime.failure = undefined;
    }
    // connecting/authenticating：relay 层正在（重新）建链。
    // 若已经配对过，这多半是 socket 抖动，保持 active 并启动 3s 宽限（INV-15）。
    if (state === "connecting" || state === "authenticating") {
      if (runtime.mobileConnected) {
        // Bugfix: 已配对会话的 relay 短抖会先经历 connecting/authenticating。
        // 旧逻辑把 dialog 立刻切成“启动中”，用户会误以为远控重新启动；这里在宽限期内保持 active。
        runtime.status = "active";
        scheduleMobileDisconnectGrace(runtime);
        emitRuntimeStatus(runtime);
        return;
      }
      runtime.status = "starting";
      emitRuntimeStatus(runtime);
      return;
    }
    if (state === "waiting_terminal") {
      // 已配对后又回到 waiting：同样是抖动，先宽限；超时仍未 paired 才降级为 running。
      if (runtime.mobileConnected) {
        // Bugfix: 已配对会话恢复时 relay 可能短暂回 waiting。
        // 旧逻辑会把 dialog 从 active 拉回“等待手机匹配”；这里先防抖，超时仍未 paired 再降级。
        runtime.status = "active";
        scheduleMobileDisconnectGrace(runtime);
        emitRuntimeStatus(runtime);
        return;
      }
      runtime.status = "running";
      runtime.mobileConnected = false;
      emitRuntimeStatus(runtime);
      return;
    }
    if (state === "paired") {
      // pair telemetry 只在“状态真正从非 paired 切到 paired”时上报一次，
      // 否则每次心跳都会重复计数，指标会虚高。
      if (previousTransportState !== "paired") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        reportRemoteUsageEvent(
          runtime.windowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "success",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
          }),
        );
      }
      runtime.hasEverPaired = true;
      clearMobileDisconnectGraceTimer(runtime);
      runtime.status = "active";
      runtime.mobileConnected = true;
      emitRuntimeStatus(runtime);
      // Bugfix: 普通断线重连重新 paired 时 transport 不一定触发 onSendReady。
      // 这里在状态恢复为可发送后主动 flush，避免重连窗口内缓冲的响应/RPC 帧超时丢弃。
      flushPendingOutboundPayloads(runtime);
      // 重连后立刻补发 degraded latch：手机可能错过了上一次发送（relay 抖动时丢弃）。
      sendPendingBridgeInvalidation(runtime);
      // 新配对需要调用 requestMobileTaskView 重新对齐手机当前视图；同一次配对内不重复请求。
      if (previousTransportState !== "paired") requestMobileTaskView(runtime);
      return;
    }
    if (state === "kicked") {
      // 同 reason 的重复 kicked 不再重复上报（ISSUE: preserveWindowRuntimeFailure 幂等）。
      if (previousTransportState !== "kicked") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        reportRemoteUsageEvent(
          runtime.windowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "failure",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
            errorCategory: "relay",
          }),
        );
      }
      // kicked 是终态：视为会话冲突，不能自动重试，否则两个手机端会互相踢。
      preserveWindowRuntimeFailure(
        runtime.windowId,
        runtime,
        "external-relay-kicked",
        createFailure("session-conflict", "Web remote control connection was kicked by relay."),
      );
      return;
    }
    if (state === "error") {
      // error 只改 status，不销毁 transport：transport 内部有退避重连，是否需要彻底失败由 onError 回调决定，这里只负责把 UI 切到错误态。
      if (previousTransportState !== "error") {
        const workspaceDimensions = resolveRuntimeWorkspaceDimensions(runtime);
        reportRemoteUsageEvent(
          runtime.windowId,
          buildWebRemoteControlPairResultTelemetry({
            result: "failure",
            pairKind: runtime.hasEverPaired ? "reconnect" : "initial",
            ...workspaceDimensions,
            errorCategory: "relay",
          }),
        );
      }
      runtime.status = "error";
      emitRuntimeStatus(runtime);
    }
  }

  // 二维码 URL 是纯派生数据：deviceSid 变化时必须整条重算（onStateChange 里已这样做）。
  function createQrUrl(deviceSid: string, mobileRemoteControlUrl: string): string {
    return buildWebRemoteControlExternalQrUrl({
      baseUrl: mobileRemoteControlUrl,
      deviceSid,
      deviceMid: dependencies.deviceMid,
      deviceName: dependencies.deviceName,
      appVersion: dependencies.appVersion,
    });
  }

  return {
    // 两段式启动：authorizeStart 先发一次性票据，startAuthorized 再校验并启动。
    // [权衡] 这层间接看似多余，但 IPC 调用方（渲染进程）不能被信任直接指定 windowId：
    // 票据把“谁提出的请求”与“要操作哪个窗口”绑定（windowId），避免越权启动别人的远控。
    authorizeStart,
    async startAuthorized(
      windowId: number,
      context: WebRemoteControlContext,
      authorization: WebRemoteControlStartAuthorization,
    ): Promise<WebRemoteControlStartResult> {
      consumeStartAuthorization(windowId, context, authorization);
      // 用 this.start 而不是闭包引用：对外约定这两个方法可被测试替换/包装。
      return this.start(windowId, context);
    },
    // 启动流程很长，按“先创建可取消的 lifecycle，再准备身份，最后等 transport ready”组织。
    // 任何 await 之后都必须 assertActive()：controller.abort 后继续执行会写出僵尸 runtime。
    async start(
      windowId: number,
      context: WebRemoteControlContext,
    ): Promise<WebRemoteControlStartResult> {
      // 启动即作废同窗口所有旧票据与旧连接（重启语义），featureGate 关闭时直接抛错。
      clearStartAuthorizationsForWindow(windowId);
      dependencies.featureGate.assertEnabled();
      // 只要有人显式 start，就不再让 restore 流程抢占这个窗口。
      startupRestoreClaimed = true;
      // stop 是异步的，但不 await 也能安全继续：它内部先 abort 再清理，
      // 新 transport 与旧 transport 通过 deviceSid/runtime 身份隔离，不会互相污染。
      const stopped = stopWindowRuntime(windowId, "restart");
      const controller = new AbortController();
      const lifecycle: WindowControlLifecycle = { controller };
      windowLifecycles.set(windowId, lifecycle);
      const signal = controller.signal;
      const assertActive = () => signal.throwIfAborted();
      try {
        await stopped;
        // 读取登录态与端点时必须防“读到一半换号”：循环到 revision 未变为止。
        // [并发] 这里没有锁，靠 authNotificationRevision 乐观重试；
        // 因为读操作本身幂等，多读一次没有副作用，比加锁简单且不会阻塞登录通知。
        const readAuthContext = async () => {
          for (;;) {
            const revision = authNotificationRevision;
            const endpointUrls = await dependencies.getEndpointUrls?.();
            const login = await dependencies.getLogin();
            assertActive();
            // 首次读取尚未绑定身份时也可能发生换号，不能把旧读取绑定到新登录之后。
            if (revision === authNotificationRevision) return { endpointUrls, login };
          }
        };
        const { endpointUrls, login } = await readAuthContext();
        // 端点优先用服务端下发值，缺失时回退构造参数；两者都按 origin 归一到同一口径。
        const relayWsUrl = endpointUrls?.relayWsUrl ?? dependencies.relayWsUrl;
        const mobileRemoteControlUrl =
          endpointUrls?.remoteUrl ?? dependencies.mobileRemoteControlUrl;
        const endpointOrigin = new URL(endpointUrls?.origin ?? mobileRemoteControlUrl).origin;
        assertActive();
        // 未登录不是“错误”而是“需要授权”：打门禁标记后再抛，让 UI 展示登录引导而不是失败重试。
        if (!login?.jwt || !login.userId) {
          requireAuthentication(windowId);
          throw new WebRemoteControlV2ConnectionError("auth-required");
        }
        // 记录本次连接使用的身份，供 notifyAuthStateChanged 精确找出需要下线的窗口。
        lifecycle.identity = { userId: login.userId, endpointOrigin };
        // 成功拿到登录态即解除该窗口的门禁：后续 workspace 同步才有意义。
        authRequiredWindows.delete(windowId);
        // 清理旧版（V1）遗留的设备标识，避免同一设备在 relay 上出现两条注册记录。
        await dependencies.deviceStorage.clearLegacy();
        assertActive();
        const http = createWebRemoteControlV2Http(endpointOrigin);
        // 每次需要 JWT 时都重新取：长连接可能存活数小时，中途换号必须立刻失效。
        const currentLogin = async () => {
          const current = await dependencies.getLogin();
          const endpoint = await dependencies.getEndpointUrls?.();
          assertActive();
          if (
            !current?.jwt ||
            current.userId !== login.userId ||
            (endpoint && endpoint.origin !== endpointOrigin)
          ) {
            throw new WebRemoteControlV2ConnectionError("auth-required");
          }
          return current;
        };
        // 设备注册闭包：load → (必要时 delete 旧设备) → register → save。
        // 整段挂到 registrationQueue 上串行执行（INV-11），失败时 queue 只吞掉错误不中断后续。
        const register = (force: boolean, transportSignal: AbortSignal) => {
          // 两个取消来源取并集：用户关闭远控（signal）或 transport 自身重连放弃（transportSignal）。
          const registrationSignal = AbortSignal.any([signal, transportSignal]);
          // 同一 manager 串行读取/更新身份，避免多窗口首次启动各自覆盖持久化 SID。
          const operation = registrationQueue.then(async () => {
            const current = await currentLogin();
            const stored = await dependencies.deviceStorage.load();
            registrationSignal.throwIfAborted();
            // 身份未变且不强制时直接复用：这是正常路径，避免每次启动都换设备 SID。
            if (
              !force &&
              stored?.userId === current.userId &&
              stored.endpointOrigin === endpointOrigin
            )
              return stored.deviceSid;
            // 同端点但身份变了：先撤销旧 SID，防止 relay 侧残留一条永远不会再连的会话。
            if (stored?.endpointOrigin === endpointOrigin) {
              try {
                await http.delete(stored.deviceSid, current.jwt, registrationSignal);
              } catch {
                dependencies.logger.warn("[web-remote-control] V2 old device cleanup failed");
              }
            }
            registrationSignal.throwIfAborted();
            const deviceSid = await http.register(
              dependencies.deviceMid,
              current.jwt,
              registrationSignal,
            );
            // register 期间可能换号：再校验一次才允许把新 SID 落盘。
            await currentLogin();
            registrationSignal.throwIfAborted();
            try {
              await dependencies.deviceStorage.save({
                deviceSid,
                userId: current.userId,
                endpointOrigin,
              });
            } catch (error) {
              // 保存失败不是网络故障；裸错误会让 transport 每次退避都注册新 SID，留下孤儿设备。
              // 新 SID 尚未建连，先尽力撤销远端注册，再以不可重试错误结束本次启动。
              dependencies.logger.error(
                "[web-remote-control] V2 device identity persistence failed",
                error,
              );
              try {
                await http.delete(deviceSid, current.jwt, registrationSignal);
              } catch {
                dependencies.logger.warn("[web-remote-control] V2 new device cleanup failed");
              }
              throw new WebRemoteControlV2ConnectionError("relay-unavailable");
            }
            registrationSignal.throwIfAborted();
            dependencies.logger.info("[web-remote-control] V2 device registered");
            return deviceSid;
          });
          registrationQueue = operation.catch(() => {});
          return operation;
        };
        let deviceSid = "";
        let runtime: WindowControlRuntime;
        // readyPromise 的“已结算”标记：timeout / abort / persist 失败可能同时发生，
        // 只允许第一个结果生效，否则 Promise 会被多次 resolve/reject（后者被忽略但会泄漏监听）。
        let readySettled = false;
        // 启动恢复设置的写盘只做一次（persistEnabled ??=），但允许超时后仍在后台完成：用户看到的是“启动成功”，下次重启仍应恢复远控。
        let persistEnabled: Promise<void> | undefined;
        const readyPromise = new Promise<void>((resolve, reject) => {
          // finish 同时清理 abort 监听与超时，避免成功路径上留下悬挂的定时器。
          const finish = (error?: Error) => {
            if (readySettled) return;
            readySettled = true;
            clearTimeout(timeout);
            signal.removeEventListener("abort", aborted);
            if (error) reject(error);
            else resolve();
          };
          const aborted = () => finish(new Error("Web remote control start cancelled"));
          signal.addEventListener("abort", aborted, { once: true });
          // 30s 是 relay 首连的上限（exactly-once 语义：超时后 transport 仍可能在后台恢复，
          // 但调用方已经拿到失败结果，因此必须保证 finished 之后的状态不会被当成成功）。
          const timeout = setTimeout(
            () =>
              finish(
                new Error("External relay device did not reach QR-ready state before timeout."),
              ),
            EXTERNAL_RELAY_QR_READY_TIMEOUT_MS,
          );
          const transport = createTransport({
            relayWsUrl,
            deviceMid: dependencies.deviceMid,
            meta: {
              platform: process.platform,
              version: dependencies.appVersion,
              name: dependencies.deviceName,
            },
            // token 每次过期都由 transport 回调重取；这里再确认一次登录态，
            // 防止“JWT 已换号但 transport 仍持有旧连接”继续跑。
            getToken: async (transportSignal) => {
              const current = await currentLogin();
              const token = await http.token(
                current.jwt,
                AbortSignal.any([signal, transportSignal]),
              );
              await currentLogin();
              dependencies.logger.info("[web-remote-control] V2 device token acquired");
              return token;
            },
            // deviceSid 可能因“清理旧设备/换号”而变：resolveDeviceSid 每次都要把结果
            // 写回 runtime 并清空二维码，否则手机扫到的是上一个 SID 的旧码。
            resolveDeviceSid: async (transportSignal, forceRegistration) => {
              deviceSid = await register(forceRegistration, transportSignal);
              if (runtimes.get(windowId) === runtime) {
                runtime.deviceSid = deviceSid;
                runtime.qrUrl = runtime.connectUrl = "";
              }
              return deviceSid;
            },
            logger: dependencies.logger,
            // 状态变化的市场：先按身份过滤（旧 transport 一律丢弃），再更新二维码与业务状态。
            onStateChange: (state) => {
              if (runtimes.get(windowId) !== runtime) return;
              // 二维码只在等待/已配对时有效；提前生成会让手机扫到一个尚未注册的 SID。
              if (state === "waiting_terminal" || state === "paired") {
                runtime.qrUrl = runtime.connectUrl = createQrUrl(deviceSid, mobileRemoteControlUrl);
              }
              mapTransportState(runtime, state);
              if (state === "waiting_terminal" || state === "paired") {
                // 首个调用超时不撤销后台恢复；首次真正 ready 时仍须保存启用意图。
                // 写盘失败要显式停掉本次远控：否则用户以为“已开启”，重启后却什么都不会恢复。
                persistEnabled ??= dependencies.startupRestoreStorageProvider.save({
                  workspacePath: context.workspacePath,
                  workspaceIdentity: context.workspaceIdentity,
                  initialTaskId: context.initialTaskId,
                });
                void persistEnabled.then(
                  () => finish(),
                  (error: unknown) => {
                    finish(error instanceof Error ? error : new Error(String(error)));
                    if (runtimes.get(windowId) === runtime)
                      void stopWindowRuntime(windowId, "startup-restore-persist-failed");
                  },
                );
              }
              // kicked 是终态：让 start 的调用方直接拿到 session-conflict，而不是等超时。
              if (state === "kicked") finish(new Error("session-conflict"));
            },
            // 所有入站 app payload 都从这里进；runtime 是闭包变量，回调触发时它一定已初始化。
            onPayload: (payload) => routePayload(runtime, payload),
            onRawTransportPayload: (payload) => routeRawTransportCandidate(runtime, payload),
            // 原始通道故障直接交给当前 bridge 的 adapter 处理；没有 bridge 时自然丢弃。
            onRawTransportFault: (reasonCode) =>
              runtime.currentBridge?.relayProtocol?.markDegraded(reasonCode),
            onSendReady: (event) => {
              // 先 flush 普通 payload，再处理 raw 重放：保证 ack/响应不被 raw 帧饿死。
              flushPendingOutboundPayloads(runtime);
              const isFirstSendReadyForPairing = !runtime.hasObservedSendReadyForPairing;
              runtime.hasObservedSendReadyForPairing = true;
              // same-socket 心跳 ACK 每约 10s 触发一次 send-ready；只有“重连”或“本次配对首次”
              // 才补发 latch 与视图请求，否则手机端会被反复要求重建同一 generation。
              if (event.kind === "reconnected-socket" || isFirstSendReadyForPairing) {
                // Bug 原因：same-socket 心跳 ACK 每约 10 秒都会触发 send-ready；若每次都补发
                // degraded latch，Web 会反复重建同一恢复 generation，破坏 1s/2s/5s 有界退避。
                sendPendingBridgeInvalidation(runtime);
                requestMobileTaskView(runtime);
              }
              const relayProtocol = runtime.currentBridge?.relayProtocol;
              // 同 bridge 未 ACK 批次仍由 adapter 独占；重连后重放，不刷新 queued age。
              if (relayProtocol && !relayProtocol.isDegraded())
                relayProtocol.replayUnacknowledged();
            },
            onError: (error) => {
              // 身份校验：旧 transport 的错误不能改写新 runtime。
              if (runtimes.get(windowId) !== runtime) return;
              // 只有 V2 明确分类的错误才沿用 reason，其余必须一律视为 relay 不可用，避免把 DNS/证书等底层错误直接透给用户。
              const failure = createFailure(
                error instanceof WebRemoteControlV2ConnectionError
                  ? error.reason
                  : "relay-unavailable",
                error.message,
              );
              finish(error);
              // auth-required 走门禁路径（保留 runtime 供 UI 显示登录引导），其余进错误终态。
              if (failure.reason === "auth-required") requireAuthentication(windowId);
              else preserveWindowRuntimeFailure(windowId, runtime, "v2-auth-failed", failure);
            },
          });
          // runtime 必须在 transport.start() 之前登记：transport 可能同步回调 onStateChange。
          runtime = {
            windowId,
            workspacePath: context.workspacePath,
            workspaceIdentity: context.workspaceIdentity,
            remoteSessionId: context.remoteSessionId,
            initialTaskId: context.initialTaskId,
            theme: context.theme,
            // 初始状态固定为 starting；真正的 running/active 由 mapTransportState 决定。
            status: "starting",
            deviceSid,
            deviceMid: dependencies.deviceMid,
            connectUrl: "",
            qrUrl: "",
            transport,
            mobileConnected: false,
            hasEverPaired: false,
            hasObservedSendReadyForPairing: false,
            pendingOutboundPayloads: [],
          };
          runtimes.set(windowId, runtime);
          emitRuntimeStatus(runtime);
          // start 之后 transport 会异步推进状态；这里不 await，ready 由 readyPromise 表达。
          transport.start();
        });
        await readyPromise;
        assertActive();
        // 返回值里的 status 只区分 active/running：其余中间态对调用方没有意义。
        return {
          status: runtime!.status === "active" ? "active" : "running",
          sessionId: deviceSid,
          windowControlSessionId: deviceSid,
          qrUrl: runtime!.qrUrl,
          connectUrl: runtime!.connectUrl,
          workspacePath: context.workspacePath,
          workspaceIdentity: context.workspaceIdentity,
          remoteSessionId: context.remoteSessionId,
          initialTaskId: context.initialTaskId,
        };
      } catch (error) {
        // auth-required 在 start 内部有两种到达方式（提前检查 / transport 报错），这里会兜住第二种：统一打门禁，避免调用方只看到一条普通错误。
        if (
          !signal.aborted &&
          error instanceof WebRemoteControlV2ConnectionError &&
          error.reason === "auth-required"
        ) {
          requireAuthentication(windowId);
        }
        throw error;
      }
    },

    // 手动关闭：先把“自动恢复”关掉，再停连接。代际自增让所有在途异步立刻作废（包括正在等待用户扫码的 start）。
    async stop(windowId: number): Promise<void> {
      lifecycleRevision += 1;
      authNotificationRevision += 1;
      startupRestoreClaimed = true;
      // 手动停止也消耗本进程唯一一次自动恢复名额：后续新窗口调用 restorePreviouslyEnabled 会直接返回 false（D-10-2，待修）。
      authRequiredWindows.delete(windowId);
      clearStartAuthorizationsForWindow(windowId);
      // Bugfix: 清除自动恢复设置需要写磁盘，失败时不能阻止用户关闭当前远控连接。
      // 先释放 transport 和 attachment，再把持久化错误返回 UI，保证本次运行立即停止。
      await stopWindowRuntime(windowId, "manual-stop");
      await dependencies.startupRestoreStorageProvider.clear();
    },

    // suspend 用于窗口隐藏/系统休眠等被动场景：只停连接，不动自动恢复设置，
    // 这样下次 restorePreviouslyEnabled 还能把它拉起来。
    async suspend(windowId: number, reason: string): Promise<void> {
      clearStartAuthorizationsForWindow(windowId);
      await stopWindowRuntime(windowId, reason);
    },

    // 登录状态变化是唯一能解除 auth-required 的入口（INV-12）。
    // 两个方向的处理不对称：
    //   signed-in：可能需要换身份重连 + 恢复上次的远控；
    //   其它（登出）：必须“同步”先把所有窗口下线，再返回给调用方。
    async notifyAuthStateChanged(
      windowId: number,
      change: WebRemoteControlAuthStateChange,
    ): Promise<void> {
      const revision = ++authNotificationRevision;
      if (change.state === "signed-in") {
        const login = await dependencies.getLogin();
        const endpointUrls = await dependencies.getEndpointUrls?.();
        // 读登录态期间可能又发生一次通知：authNotificationRevision 不同就放弃，让新通知自己完成。
        if (revision !== authNotificationRevision) return;
        if (!login?.jwt || !login.userId) {
          requireAuthentication(windowId);
          return;
        }
        const endpointOrigin = new URL(endpointUrls?.origin ?? dependencies.mobileRemoteControlUrl)
          .origin;
        // 找出“身份与当前登录不一致”的窗口：它们必须强制下线，不能等下一次取 token，
        // 因为已认证的 socket 不会主动重新验证 JWT。
        const staleWindows = [...windowLifecycles].filter(
          ([, lifecycle]) =>
            lifecycle.identity &&
            (lifecycle.identity.userId !== login.userId ||
              lifecycle.identity.endpointOrigin !== endpointOrigin),
        );
        if (staleWindows.length > 0) {
          lifecycleRevision += 1;
          startupRestoreClaimed = false;
          // 先同步撤销所有旧代再等待；已认证 socket 不会重新验证 JWT，不能只等下一次取 token。
          await Promise.all(
            staleWindows.map(([id]) => {
              clearStartAuthorizationsForWindow(id);
              return stopWindowRuntime(id, "auth-identity-changed");
            }),
          );
          if (revision !== authNotificationRevision) return;
        }
        // 门禁窗口统一切回 idle：由 UI 决定是否自动重开，Main 不在登录回调里直接 start。
        for (const id of authRequiredWindows)
          dependencies.onStatusChanged?.(id, { status: "idle" });
        authRequiredWindows.clear();
        // 只恢复“一个”窗口的上次远控：多个窗口同时恢复会让手机端看到多个同名设备。
        for (const [candidateWindowId, contexts] of availableWorkspacesByWindowId) {
          if (await this.restorePreviouslyEnabled(candidateWindowId, contexts)) break;
          if (revision !== authNotificationRevision) return;
        }
        return;
      }
      // 登出分支：不能 await 任何慢操作（例如写盘），否则登出后连接还可能存活数秒。
      lifecycleRevision += 1;
      startupRestoreClaimed = false;
      // 窗口集合要把“只有 workspace 快照”的窗口也算进来：它们可能正等待恢复。
      const windowIds = new Set([
        windowId,
        ...availableWorkspacesByWindowId.keys(),
        ...runtimes.keys(),
        ...windowLifecycles.keys(),
      ]);
      // 先同步撤销所有窗口的启动/连接，再等待调用方；登出不能被慢 HTTP 写回复活。
      for (const id of windowIds) {
        clearStartAuthorizationsForWindow(id);
        requireAuthentication(id);
      }
    },

    // 自动恢复：把上次保存的 workspace 重新启动。返回 true 表示“本进程已完成恢复”，调用方据此停止遍历其它窗口（全局只恢复一个）。
    // 前置条件很多，任一不满足都静默返回 false——恢复失败不是用户可见错误。
    async restorePreviouslyEnabled(
      windowId: number,
      candidates: Array<WebRemoteControlContext & { label?: string }>,
    ): Promise<boolean> {
      // 修复原因：候选快照与 syncAvailableWorkspaces 共用同一份 WorkspaceTarget 表，label 是必填展示字段；
      // 生产调用方传入完整目标，只有仅携带 context 的调用需要回退到路径，不能写入缺 label 的列表项。
      availableWorkspacesByWindowId.set(
        windowId,
        candidates.map((candidate) => ({
          ...candidate,
          label: candidate.label ?? candidate.workspacePath,
          kind: candidate.workspaceIdentity || candidate.remoteSessionId ? "remote" : "local",
        })),
      );
      // 401/登出后只有登录通知能解除门禁，workspace 同步不能重试失效 JWT。
      if (startupRestoreClaimed || runtimes.has(windowId) || authRequiredWindows.has(windowId))
        return false;
      const revision = lifecycleRevision;
      // 读盘失败按“无恢复上下文”处理：自动恢复是增强能力，不能因此报错给用户。
      const persistedContext = await dependencies.startupRestoreStorageProvider
        .load()
        .catch((error) => {
          dependencies.logger.warn(
            "[web-remote-control] load startup restore context failed",
            error,
          );
          return undefined;
        });
      // 读盘期间可能发生 stop/登出/别的窗口抢先恢复：全部用代际与 claimed 标记识别。
      if (revision !== lifecycleRevision || startupRestoreClaimed || !persistedContext) {
        return false;
      }

      // 只按 workspaceKey 匹配：持久化里没有 label/kind，路径相等但身份不同的目标不能复用。
      const persistedWorkspaceKey = resolveWebRemoteControlWorkspaceKey(persistedContext);
      // 磁盘读取期间可能发生 tab 关闭或远端重连，只能消费最新完整快照。
      const currentContext = availableWorkspacesByWindowId
        .get(windowId)
        ?.find(
          (candidate) => resolveWebRemoteControlWorkspaceKey(candidate) === persistedWorkspaceKey,
        );
      // 远程目标缺 remoteSessionId 说明此刻不可连：跳过恢复，等用户下次手动开启。
      if (
        !currentContext ||
        (currentContext.kind === "remote" && !currentContext.remoteSessionId)
      ) {
        return false;
      }

      // 先抢占 claimed 再 start：start 内部是异步的，晚抢会让另一个窗口也通过上面的检查。
      startupRestoreClaimed = true;
      dependencies.logger.info(
        `[web-remote-control] restoring previous enabled state window=${windowId} workspace=${currentContext.workspacePath} remoteSession=${currentContext.remoteSessionId ?? "none"}`,
      );
      try {
        await this.start(windowId, {
          workspacePath: currentContext.workspacePath,
          workspaceIdentity: currentContext.workspaceIdentity,
          remoteSessionId: currentContext.remoteSessionId,
          initialTaskId: persistedContext.initialTaskId,
        });
        return true;
      } catch (error) {
        // 只有“代际未变”时才回滚 claimed：若期间用户手动操作过，claimed 的语义已由那次操作决定。
        if (revision === lifecycleRevision) startupRestoreClaimed = false;
        dependencies.logger.warn(
          "[web-remote-control] restore previous enabled state failed",
          error,
        );
        return false;
      }
    },

    // getStatus 是“纯查询 + 门禁”：featureGate 关闭 / 未登录 / 无 runtime 都要给出确定答案，
    // 让桌面弹层在任何时刻都能渲染，不需要 try/catch。
    getStatus(windowId: number): WebRemoteControlStatus {
      // featureGate 关闭时不返回 idle 而已：带上 failure 让 UI 解释“这个版本不支持”。
      if (!dependencies.featureGate.isEnabled()) {
        return {
          status: "idle",
          failure: createFailure(
            "unsupported-action",
            "Web remote control is disabled in this build.",
          ),
        };
      }

      // 门禁优先于 runtime：401 之后 runtime 可能已被清理，但 UI 仍应显示“请登录”。
      if (authRequiredWindows.has(windowId)) return { status: "auth-required" };
      const runtime = runtimes.get(windowId);
      if (!runtime) {
        return { status: "idle" };
      }

      return buildRuntimeStatus(runtime);
    },

    // 渲染进程同步 workspace 列表。即使本窗口没有 runtime 也要记录：
    // 后续 restorePreviouslyEnabled 依赖这份快照决定“保存的目标是否还存在”。
    syncAvailableWorkspaces(windowId: number, workspaces: WebRemoteControlWorkspaceTarget[]): void {
      availableWorkspacesByWindowId.set(windowId, workspaces);
      const runtime = runtimes.get(windowId);
      if (!runtime) {
        return;
      }
      // 只有连接中的窗口才需要即时推送；idle 窗口的列表变化会在下次 bootstrap 时体现。
      pushWorkspaceListUpdated(runtime);
    },

    // 远程会话被重连替换（同一逻辑项目换了物理 SSH session）时调用。
    // 关键约束：不能让手机继续用旧 bridge —— 旧适配器的 seq 已推进，新连接从 1 开始，
    // 手机 assembler 会把它当重复帧丢弃（下面注释里的真实 bug）。因此这里只做三件事：
    //   1) 三处引用（bridge / runtime / workspace 快照）全部换成新 sessionId；
    //   2) 把旧 bridge 标 degraded 并发 bridge-degraded；
    //   3) 让手机走它自己的恢复流程、用新 identity 重建（INV-05）。
    async replaceRemoteSession(event: {
      previousSessionId: string;
      sessionId: string;
      workspacePath: string;
      workspaceIdentity: string;
    }): Promise<void> {
      // 遍历所有窗口而不是只处理“发起者”：同一远程会话可能被多个窗口引用。
      for (const [windowId, runtime] of runtimes) {
        const bridge = runtime.currentBridge;
        // 三个字段都相等才算同一个目标：只看 sessionId 会误改同名会话下的其它项目。
        const bridgeMatches =
          bridge?.remoteSessionId === event.previousSessionId &&
          bridge.workspacePath === event.workspacePath &&
          bridge.workspaceIdentity === event.workspaceIdentity;
        const runtimeMatches = runtime.remoteSessionId === event.previousSessionId;
        const availableWorkspaces = availableWorkspacesByWindowId.get(windowId);
        if (availableWorkspaces) {
          // 快照里的目标也要就地换 sessionId：否则手机列表点开会拿旧 id 去 open。
          availableWorkspacesByWindowId.set(
            windowId,
            availableWorkspaces.map((workspace) =>
              workspace.remoteSessionId === event.previousSessionId &&
              workspace.workspacePath === event.workspacePath &&
              workspace.workspaceIdentity === event.workspaceIdentity
                ? { ...workspace, remoteSessionId: event.sessionId, connectionState: "connected" }
                : workspace,
            ),
          );
        }
        // runtime 级目标是“窗口启动目标”，它与 bridge 目标可能不同，所以单独更新。
        if (runtimeMatches) runtime.remoteSessionId = event.sessionId;
        // 没有匹配的 bridge：只需把列表变化推给手机，连接本身不受影响。
        if (!bridgeMatches || !bridge) {
          if (runtimeMatches || availableWorkspaces) pushWorkspaceListUpdated(runtime);
          continue;
        }

        // Bug 原因：过去 Main 复用相同 bridge identity 重建 acknowledged protocol，
        // 新协议的 seq 从 1 开始，手机 assembler 却仍等待 N+1，新帧会被当成旧 duplicate
        // 静默丢弃。这里只发非终态 degraded，由 Web 已有恢复流程以新 identity 主动重建。
        bridge.degraded = true;
        // latch 里带的是“旧身份”，手机凭它判断自己是否已经换过 generation（INV-06/17）。
        runtime.pendingBridgeInvalidation = {
          zcode_type: "bridge-degraded",
          bridgeSessionId: bridge.bridgeSessionId,
          ...(bridge.bridgeGeneration === undefined
            ? {}
            : { bridgeGeneration: bridge.bridgeGeneration }),
          ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
          reason: "source-session-replaced",
        };
        // 先释放再发：发消息要用 transport，而释放只动 bridge 资源，互不影响；
        // 但顺序反过来会让手机在收到通知的瞬间仍能往一个即将关闭的 bridge 发帧。
        disposeRuntimeBridgeResources(runtime);
        sendPendingBridgeInvalidation(runtime);
        pushWorkspaceListUpdated(runtime);
      }
    },

    // 窗口销毁：比 stop 多清两个 Map（workspace 快照与推送签名），
    // 否则同号窗口重新创建时会复用旧签名，导致首推被误判为“未变化”而丢弃。
    async disposeWindow(windowId: number): Promise<void> {
      lifecycleRevision += 1;
      authRequiredWindows.delete(windowId);
      clearStartAuthorizationsForWindow(windowId);
      await stopWindowRuntime(windowId, "window-disposed");
      availableWorkspacesByWindowId.delete(windowId);
      pushedWorkspaceListSignaturesByWindowId.delete(windowId);
    },

    // 远程会话断开（SSH 掉线、空闲退出等）时的降级处理。
    // 最重要的约束在下面那条 Bugfix 注释里：只降级“用到这个会话的 bridge”，
    // 绝不把窗口级设备 WS 判死，否则一个远端空闲退出会关掉整个远控入口。
    // 状态恢复也刻意跳过 error：401/kicked 是终态，workspace 生命周期无权复活它。
    failRemoteSession(
      remoteSessionId: string,
      reason: string,
      failure: WebRemoteControlFailure,
    ): void {
      for (const [windowId, runtime] of runtimes) {
        const bridge = runtime.currentBridge;
        const bridgeUsesRemoteSession = bridge?.remoteSessionId === remoteSessionId;
        const runtimeUsesRemoteSession = runtime.remoteSessionId === remoteSessionId;

        // 与本会话无关的窗口完全跳过：不能因为别的项目掉线就给它 emit 一次状态。
        if (!bridgeUsesRemoteSession && !runtimeUsesRemoteSession) {
          continue;
        }

        // Bugfix: 远程 workspace session 只是某个 workspace/bridge 的依赖，不能把它的断开升级成
        // 窗口级 Web 远控 device WS 失败；否则单个远端空闲退出会错误关闭电脑端全局远控入口。
        if (bridgeUsesRemoteSession) {
          // 只回收 bridge 资源（attachment 等），transport 与配对状态保持原样。
          disposeRuntimeBridgeResources(runtime);
          // requestId 用固定前缀而不是随机值：手机据此识别“这是会话失效而非某次 open 失败”。
          sendAppPayload(runtime, {
            zcode_type: "workspace-bridge-error",
            bridgeSessionId: bridge.bridgeSessionId,
            ...(bridge.bridgeGeneration !== undefined
              ? { bridgeGeneration: bridge.bridgeGeneration }
              : {}),
            ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
            requestId: `remote-session-closed:${remoteSessionId}`,
            reason: failure.reason,
            error: failure.message ?? failure.reason,
          });
        }
        // 清掉 runtime 级 sessionId：下次 open 必须重新提供一个已连接的会话，防止复用死引用。
        if (runtimeUsesRemoteSession) {
          runtime.remoteSessionId = undefined;
        }
        // workspace 生命周期不能复活因401或KICKED终止的设备连接。
        if (runtime.status !== "error") {
          runtime.status = runtime.mobileConnected ? "active" : "running";
          runtime.error = undefined;
          runtime.failure = undefined;
        }
        // 写回 Map 后再 emit：onStatusChanged 的消费者可能立刻回查 getStatus。
        runtimes.set(windowId, runtime);
        emitRuntimeStatus(runtime);
      }
      // 最后统一通知 Host 侧释放该远程会话下的所有 attachment（含无 bridge 的窗口）。
      dependencies.disposeWorkspaceHostAttachmentsForRemoteSession(remoteSessionId, reason);
    },
  };
}
