// 文件头：desktop/host 的 Source Server 连接状态机与自动恢复调度。
// 职责：物理连接代际管理、profile 归并、重试/离线探测、更新失效、显式断开与释放。
// 边界：成员关系持久化归 Directory/admitConnection；attachment 归 Registry；这里只管连接事实与代际。
//
// 不变量（INV）：
// INV-01 断言：onlineBySourceServerId 是“当前物理连接代际”的唯一定义。
// 守护：handleUnexpectedClose 先比对 online.connection === connection 再处理。
// 改错故障：旧代际迟到的 close 拆掉新连接，UI 反复闪烁。
// INV-02 断言：同一 Source 的所有 Profile 共用一条物理连接。
// 守护：connectOnce 命中 existing 时只 add profileId 并复用，不新建连接。
// 改错故障：同一设备开出多条物理连接，RPC 状态分叉。
// INV-03 断言：同一 profile 的并发 connect 只执行一次真实握手。
// 守护：connectFlights 登记与 connectForSource 的 existingFlight 早返回。
// 改错故障：重复安装/升级，成员关系被提交多次。
// INV-04 断言：finally 只删除“仍是自己”的 flight。
// 守护：connectForSource 中 get(profileId) === flight 判断。
// 改错故障：先结束的 flight 删掉后来者的登记，去重失效。
// INV-05 断言：显式断开必须在任何 await 之后仍然生效。
// 守护：connectOnce 的 throwIfAborted 在每个 await 后调用，finally 释放未发布连接。
// 改错故障：用户断开后连接仍被发布为 online。
// INV-06 断言：只在未取消时提交成员关系。
// 守护：commitMembership 的调用点位于 throwIfAborted 之后。
// 改错故障：已删除的 profile 被重新写回成员表。
// INV-07 断言：未发布的物理连接必须在 finally 中 dispose，且要屏蔽其 close。
// 守护：unpublishedConnection 与 ignoreConnectionClose。
// 改错故障：失败重试不断累积已关闭连接与订阅。
// INV-08 断言：握手期间连接关闭不得发布 online。
// 守护：closedBeforePublish 记录与后续 SourceServerHandshakeClosedError。
// 改错故障：把已关闭连接发布为 owner，直到下一次 RPC 才发现。
// INV-09 断言：自动恢复只认结构化 retryable/code，不看错误文案。
// 守护：readErrorRetryable 与 isAutomaticRecoveryUserActionCode。
// 改错故障：日志文案调整后恢复策略静默改变。
// INV-10 断言：终态失败必须截断自动恢复，不得再排 timer。
// 守护：stopAutomaticRecoveryForTerminalFailure 返回 true 时调用方直接 return。
// 改错故障：无限重试，耗尽 CPU 与远端连接配额。
// INV-11 断言：重试节奏固定为 2/4/8 秒，越界进入 2 分钟离线探测。
// 守护：ONLINE_RETRY_DELAYS_MS 与 scheduleOnlineRetry 的 delay===undefined 分支。
// 改错故障：恢复节奏与产品文档不符，或指数爆炸。
// INV-12 断言：同一 Source 只有一个待触发的 retry timer。
// 守护：scheduleOnlineRetry 先 clearTimeout 再 set。
// 改错故障：多个 timer 并发重连，重复握手。
// INV-13 断言：更新流程必须让旧代际先失效再释放。
// 守护：invalidateOnlineConnectionForUpdate 先 delete owner、发事件，再 dispose。
// 改错故障：Registry 仍持有旧 services，scoped RPC 命中已关闭 generation。
// INV-14 断言：更新期间 transport 断开不得恢复捕获的 online 快照。
// 守护：updateServerOnce catch 中 onlineBySourceServerId.has 的分支。
// 改错故障：产生“无连接、无 timer”的假在线状态。
// INV-15 断言：getFileTransfer 返回的闭包每次使用前校验代际 owner。
// 守护：assertCurrent 比较 onlineBySourceServerId.get 与闭包捕获的 online。
// 改错故障：旧 attachment 句柄悄悄使用新连接。
// INV-16 断言：disconnectSource 必须先捕获全部 profileId 再删索引。
// 守护：profileIds 集合在 reconnectInputs.delete 之前构建。
// 改错故障：意外断线先摘 owner 时漏发 offline，attachment 停在连接中。
// INV-17 断言：shutdown/dispose 先断连接再释放 emitter。
// 守护：dispose 中 disconnect 循环位于 emitter.dispose 之前。
// 改错故障：订阅者收不到最终 offline 事件。
// INV-18 断言：states 只能经 setState 写入，统一发布事件。
// 守护：setState 是唯一 set + fire 入口。
// 改错故障：绕过事件发布，UI 永远看到旧快照。
import { sourceServerRunningTasksSchema, type SourceServerRunningTask } from "@zcode/shared";
/**
 * ============================================================================
 * desktop/host/sourceServerConnectionManager.ts —— Source 连接状态机
 * ============================================================================
 *
 * 【定位】管理"一台 Source 的物理连接 + 自动恢复"：
 *   - connect：按 target 选择 transport adapter，安装/升级/兼容性检查；
 *   - 同一 Source 的多 Profile 归并到一条物理连接；
 *   - 断连后按 2/4/8 秒重试，再进入 2 分钟 offline probe；
 *   - 更新、profile 删除、终态失败都要停止自动恢复。
 *
 * 【状态语义】SourceServerConnectionState 是"设备级"状态，不是单条线路状态：
 *   一个 Profile 断开不等于 Source 离线；只有所有可用线路都失败才 offline。
 *
 * 【恢复纪律】
 *   - 自动恢复只认结构化错误码/retryable，不用错误文案分流；
 *   - 显式 disconnect 必须取消在途 connect flight，迟到成功只释放、不发布 online；
 *   - 恢复预算耗尽后必须进入明确终态，不能无限重试；
 *   - 删除当前 Profile 等价于断开整个 Source，剩余 Profile 只保留为手动线路。
 *
 * 【#18 相关口径（attachment / generation / dispose）】
 *   - onlineBySourceServerId 是「当前物理连接代际」的唯一定义：只有表中仍指向该 connection
 *     的 close 回调才会被当作真正的断线（handleUnexpectedClose 先比对 owner 再处理）；
 *   - 更新/删除/显式断开都必须先摘 owner，再 dispose connection 并 fire invalidated 事件，
 *     Registry 据此 fail-closed 并重建 attachment；迟到的成功 connect 只释放不发布；
 *   - getFileTransfer 返回的能力闭包在每次调用时校验 owner 身份，跨代际复用即抛错，
 *     对应 attachment 侧「旧代际句柄不得命中新连接」的约束。
 * ============================================================================
 */
/* eslint-disable max-lines -- Source 连接状态机、重试、更新和单连接归并必须共享同一代际状态。 */
import { SourceServerOperationLogs } from "./sourceServerOperationLogs.js";
import { Emitter, type Event } from "@zcode/rpc";
import type {
  ConnectionProfile,
  RemoteTarget,
  ServerRemoteInfo,
  CompatibilityManifest,
  SourceServerArtifactPolicy,
  SourceServerConnectionStateSnapshot,
} from "@zcode/shared";
import {
  SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
  SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
  REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE,
  ZCODE_COMPATIBILITY_MANIFEST,
  compareCompatibilityVersions,
  evaluateSourceServerCompatibility,
  isPublicZCodeErrorCode,
  normalizeRemoteConnectionError,
  stripRemoteTargetSecrets,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import {
  createSourceServerTransportAdapter,
  type ServerReleaseAsset,
  type SourceServerFileTransfer,
  type SourceServerTransportAdapter,
  type TransportContext,
} from "@zcode/server/source-server";
import {
  connectServerRemoteOverDuplex,
  type ServerRemoteConnection,
  type ServerRemoteDuplexConnectionOptions,
} from "./serverRemoteConnection.js";
import type { SourceServerDirectory } from "./sourceServerDirectory.js";
import { isSourceServerAutomaticRecoveryTerminalState } from "./sourceServerRecoveryPolicy.js";

export type {
  SourceServerConnectionState,
  SourceServerConnectionStateSnapshot,
} from "@zcode/shared";

// 一次成功连接的结果（交给 Registry 建 attachment 用）。
// reusedConnectionTarget 只在「复用已有物理连接」时出现，且是脱敏后的目标——不写入在线 owner，
// 避免二次复用把它当成新的连接身份。
// [契约] 一次成功连接的对外结果，Registry 据此建立 attachment。
// services 是活句柄，必须与同一代际的 owner 一起使用。
// 不要把 connection 暴露出去，释放权只在 manager 内。
export interface ManagedSourceServerConnection {
  /** 本次调用复用物理连接时的实际脱敏目标；不写入在线 owner。 */
  // [契约] 仅“复用已有物理连接”时出现，且是脱敏后的目标。
  // 它不写入在线 owner，避免二次复用把它当成新的连接身份。
  // 写入 owner 会让 stripRemoteTargetSecrets 的边界失效。
  reusedConnectionTarget?: RemoteTarget;
  sourceServerId: string;
  profileId: string;
  serverInfo: ServerRemoteInfo;
  services: IServiceAccessor;
}

// 连接失效通知：update 表示「更新流程主动让旧代际失效」（可随后重新连接）；
// profile-removed 是终态（recoverable=false），订阅方必须立即摘除该 Source 的全部附件。
// [契约] update 可恢复（随后会重连）；profile-removed 是终态。
// 订阅方收到 profile-removed 必须立即摘除该 Source 的全部附件。
// 新增 reason 时需同步 Registry 的 fail-closed 分支。
export type SourceServerConnectionInvalidatedEvent =
  | {
      sourceServerId: string;
      reason: "update";
    }
  | {
      sourceServerId: string;
      reason: "profile-removed";
      recoverable: false;
    };

// 需要用户确认安装的错误：retryable=false，自动恢复必须停止，由 UI 引导安装流程。
// [契约] 该错误对象上的 retryable=false 是 isRetryableError 的唯一依据，不靠 code 判断。
// code 使用 shared 常量，客户端按 code 分流而不是文案。
// 不要把它降级为普通 Error，否则会进入重试。
export class SourceServerInstallRequiredError extends Error {
  public readonly code = SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE;
  public readonly retryable = false;
  public constructor(public readonly profileId: string) {
    super("Source Server installation requires explicit user confirmation");
    this.name = "SourceServerInstallRequiredError";
  }
}

// 需要升级的错误：upgradeTarget 区分「桌面端」与「远端 Server」；development-archive
// 表示开发产物与当前源码不一致，必须更新而不能继续用它部署。
// [契约] upgradeTarget 区分“桌面端升级”与“远端 Server 升级”。
// development-archive 表示开发产物与源码不一致，必须更新。
// reason 缺省 compatibility，回调 UI 据此决定升级入口。
export class SourceServerUpgradeRequiredError extends Error {
  public readonly code = SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE;
  public readonly retryable = false;
  public constructor(
    public readonly profileId: string,
    public readonly upgradeTarget: "controller" | "server",
    public readonly currentVersion: string,
    public readonly minimumVersion: string,
    public readonly reason: "compatibility" | "development-archive" = "compatibility",
  ) {
    super(
      reason === "development-archive"
        ? `Source Server ${currentVersion} release archive differs from the current development build and must be updated`
        : upgradeTarget === "server"
          ? `Source Server ${currentVersion} must be upgraded to at least ${minimumVersion}`
          : `ZCode Desktop ${currentVersion} must be upgraded to at least ${minimumVersion}`,
    );
    this.name = "SourceServerUpgradeRequiredError";
  }
}

// 重装后远端身份变化，必须由用户确认才允许接管（pendingSourceServerId 是新身份）。
// retryable=false：未确认前自动重试只会反复撞同一错误。
// [契约] 重装后远端身份变化，必须用户确认才允许接管。
// pendingSourceServerId 是新身份，旧身份仍在 profile 上。
// retryable=false：未确认前重试只会反复撞同一错误。
export class SourceServerIdentityChangePendingError extends Error {
  public readonly code = SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE;
  public readonly retryable = false;
  public constructor(
    public readonly profileId: string,
    public readonly pendingSourceServerId: string,
  ) {
    super("Source Server identity changed after reinstall and requires confirmation");
    this.name = "SourceServerIdentityChangePendingError";
  }
}

// [契约] 用户显式断开的专用原因，code 固定 remote-connection-canceled。
// scheduleReconnect 见到 remote-connection-canceled 就不再排队，显式断开后不会被拉起。
// 不要复用它表达网络失败，否则重试被永久截断。
class SourceServerExplicitDisconnectError extends Error {
  public readonly code = "remote-connection-canceled";
  public constructor(public readonly sourceServerId: string) {
    super(`Source Server explicitly disconnected: ${sourceServerId}`);
    this.name = "SourceServerExplicitDisconnectError";
  }
}

// [契约] Profile 被删除的专用原因，携带 profileId。
// 与显式断开的区别：它只取消该 profile 的 flight。
// 消息仅用于日志，分流只看类型。
class SourceServerProfileRemovedError extends Error {
  public constructor(public readonly profileId: string) {
    super(`Connection Profile removed: ${profileId}`);
    this.name = "SourceServerProfileRemovedError";
  }
}

// [契约] 握手期间连接关闭，retryable=true。
// 抛出后由普通失败路径发布 failed，让自动恢复继续下一档。
// 不要把它当作终态，否则一次网络抖动会终止恢复。
class SourceServerHandshakeClosedError extends Error {
  public readonly retryable = true;
  public constructor(reason: string) {
    super(`Source Server connection closed during handshake: ${reason}`);
    this.name = "SourceServerHandshakeClosedError";
  }
}

// 连接管理器的依赖注入点：directory 只承担握手事实与「最近在线」持久化，
// admitConnection 负责成员关系（add/retain）并返回「握手提交回调」；连接管理器仅在
// 握手成功且未被取消时调用该回调，保证成员关系不会先于连接生效。
// resolveRelease/createAdapter/connectServer 可替换用于测试或特殊部署形态。
// [契约] 依赖注入点：directory 负责握手事实，admitConnection 负责成员关系。
// 连接管理器只在握手成功且未取消时调用 admit 返回的提交回调。
// createAdapter/connectServer/resolveRelease 可替换用于测试。
export interface SourceServerConnectionManagerOptions {
  /** 成员关系归持久化端口；连接管理器只负责 admission 和握手提交的时序。 */
  // [事务] 返回“握手提交回调”，成员关系不会先于连接生效。
  // intent=retain 用于启动静默重连，不新增成员。
  // confirmIdentityChange 为 true 才允许接管新身份。
  admitConnection?: (input: {
    profile: ConnectionProfile;
    intent: "add" | "retain";
    confirmIdentityChange: boolean;
  }) => Promise<(sourceServerId: string) => Promise<void>>;
  directory: {
    recordLastOnline?(sourceServerId: string, timestamp: number): Promise<void>;
    markSourceUninstalled?(profileId: string): Promise<void>;
    recordHandshake(
      profileId: string,
      handshake: Parameters<SourceServerDirectory["recordHandshake"]>[1],
      options?: Parameters<SourceServerDirectory["recordHandshake"]>[2],
    ): Promise<{
      identityChanged: boolean;
      effectiveProfile?: ConnectionProfile;
    }>;
  };
  createAdapter?: (kind: "ssh" | "wsl" | "docker") => SourceServerTransportAdapter;
  connectServer?: (options: ServerRemoteDuplexConnectionOptions) => Promise<ServerRemoteConnection>;
  now?: () => number;
  logWarn?: (message: string, error: Error) => void;
  onProjectChange?: (sourceServerId: string) => void;
  compatibilityManifest?: CompatibilityManifest;
  sourceServerArtifactPolicy?: SourceServerArtifactPolicy;
  resolveRelease?: (
    probe: Awaited<ReturnType<SourceServerTransportAdapter["probe"]>>,
    target: Exclude<RemoteTarget, { kind: "server" }>,
    options?: { metadataOnly?: boolean },
  ) => Promise<ServerReleaseAsset>;
}

// 一次 connect 的完整入参。membershipIntent="retain" 用于启动静默重连（不新增成员）；
// allowInstall/confirmIdentityChange 是用户显式授权的两个开关；onAuthenticatedUpgradeRequired
// 只在真正执行握手的 flight 上触发，join 同一 flight 的请求不会重复提交凭据。
// [契约] 一次 connect 的完整入参，含两个用户授权开关。
// allowInstall/confirmIdentityChange 缺少时一律按拒绝处理。
// onAuthenticatedUpgradeRequired 只在真正执行握手的 flight 上触发。
export interface ConnectSourceServerOptions {
  membershipIntent?: "add" | "retain";
  profile: ConnectionProfile;
  target: RemoteTarget;
  release?: ServerReleaseAsset;
  allowInstall?: boolean;
  confirmIdentityChange?: boolean;
  resolveRelease?: SourceServerConnectionManagerOptions["resolveRelease"];
  context?: TransportContext;
  onDiagnosticPhase?: (phase: string) => void;
  /** 仅实际执行探测/握手的 flight 在升级等待点调用，join 请求不得提交另一份凭据。 */
  onAuthenticatedUpgradeRequired?: () => Promise<void>;
}

// 启动重连的单条结果：只区分 online/failed，不抛出异常（批量重连必须一次跑完）；
// error 是给日志/诊断的原文，UI 展示口径由上层决定。
// [契约] 启动重连逐条结果，只区分 online/failed，不抛异常。
// 批量重连必须一次跑完，单条失败不影响其它候选。
// error 是日志/诊断原文，UI 展示口径由上层决定。
export interface StartupReconnectResult {
  profileId: string;
  status: "online" | "failed";
  error?: string;
}

// [契约] 在线 owner 记录物理连接、共享该连接的 profileIds 与项目订阅。
// profileIds 是 Set，保证同一 profile 只记一次。
// projectSubscription 必须在 dispose/失效时同步释放。
interface OnlineConnection extends ManagedSourceServerConnection {
  connection: ServerRemoteConnection;
  profileIds: Set<string>;
  projectSubscription?: { dispose(): void };
}

// [契约] 自动恢复所需的输入：profile、target、transport context。
// context 为 {}，不持有旧操作日志闭包。
// reconnectInputs.delete(sourceServerId) 即撤销恢复意图，后续 scheduleReconnect 无输入可用。
interface ReconnectInput {
  profile: ConnectionProfile;
  target: Exclude<RemoteTarget, { kind: "server" }>;
  context: TransportContext;
}

// [契约] 一次 connect 的共享 promise 与取消控制器。
// sourceServerId 可为空（首次连接尚不知道远端 id）。
// controller 同时中止 adapter 探测与安装。
interface ConnectFlight {
  promise: Promise<ManagedSourceServerConnection>;
  sourceServerId?: string;
  controller: AbortController;
}

// [契约] 在线重试三档固定延迟，长度同时作为 recoveryLimit 上报。
// 新增档位需同步 UI 的 recoveryAttempt/recoveryLimit 展示。
// 不要改成指数计算：ONLINE_RETRY_DELAYS_MS 的三档延迟是产品口径，指数退避会拉长恢复窗口。
const ONLINE_RETRY_DELAYS_MS = [2_000, 4_000, 8_000] as const;
// [契约] 预算耗尽后每 2 分钟探测一次，状态仍 retryable。
// 探测失败继续排下一次，终态/显式断开才停止。
// 调小它会显著增加远端探活压力。
const OFFLINE_PROBE_INTERVAL_MS = 2 * 60_000;

// [契约] 只从结构化字段读取 retryable，缺失返回 undefined。
// undefined 与 false 语义不同：前者不构成终态依据。
// 不要用 instanceof Error 判断，跨包错误可能来自不同 realm。
function readErrorRetryable(error: unknown): boolean | undefined {
  if (!error || typeof error !== "object" || !("retryable" in error)) {
    return undefined;
  }
  return typeof error.retryable === "boolean" ? error.retryable : undefined;
}

// [契约] isAutomaticRecoveryUserActionCode 认三个 code 由安装、升级、身份确认三类动作产生。
// 命中这三类 code 后 getRetryable 返回 false，恢复循环停在终态等用户操作。
// 新增用户动作码必须同步加进这个判断，否则 isRetryableError 放行、重试无限续排。
function isAutomaticRecoveryUserActionCode(code: unknown): boolean {
  return (
    code === SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE ||
    code === SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE ||
    code === SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE
  );
}

// [契约] 由双端 manifest 计算 updateAvailability/版本/升级目标。
// 不兼容优先于“有更新可用”，两者都缺时返回 none。
// upgradeTarget 的 controller/server 语义在更新可用时取反端点。
function buildCompatibilityState(
  controller: CompatibilityManifest,
  server: CompatibilityManifest,
): Pick<
  SourceServerConnectionStateSnapshot,
  "updateAvailability" | "currentVersion" | "availableVersion" | "minimumVersion" | "upgradeTarget"
> {
  const result = evaluateSourceServerCompatibility(controller, server);
  if (!result.compatible && result.upgradeTarget) {
    return {
      updateAvailability: "required",
      currentVersion: result.olderVersion,
      availableVersion: result.newerVersion,
      minimumVersion: result.requiredMinimumVersion,
      upgradeTarget: result.upgradeTarget,
    };
  }
  if (result.updateAvailable) {
    return {
      updateAvailability: "available",
      currentVersion: result.olderVersion,
      availableVersion: result.newerVersion,
      minimumVersion: result.requiredMinimumVersion,
      upgradeTarget: result.newerEndpoint === "controller" ? "server" : "controller",
    };
  }
  return {
    updateAvailability: "none",
    currentVersion: server.productVersion,
    availableVersion: server.productVersion,
    minimumVersion: result.requiredMinimumVersion,
  };
}

// [契约] 只挑兼容性字段，并保留 undefined 语义。
// 供 retrying/offline/updating 这类“不产生新兼容事实”的状态继承。
// 不要整体展开 snapshot，会把 state/error 一并带入。
function preserveCompatibilityState(
  snapshot: SourceServerConnectionStateSnapshot,
): Pick<
  SourceServerConnectionStateSnapshot,
  "updateAvailability" | "currentVersion" | "availableVersion" | "minimumVersion" | "upgradeTarget"
> {
  return {
    ...(snapshot.updateAvailability ? { updateAvailability: snapshot.updateAvailability } : {}),
    ...(snapshot.currentVersion ? { currentVersion: snapshot.currentVersion } : {}),
    ...(snapshot.availableVersion ? { availableVersion: snapshot.availableVersion } : {}),
    ...(snapshot.minimumVersion ? { minimumVersion: snapshot.minimumVersion } : {}),
    ...(snapshot.upgradeTarget ? { upgradeTarget: snapshot.upgradeTarget } : {}),
  };
}

// [并发] 计数信号量：活跃数达限则排队，释放时唤醒队首。
// 释放函数自身幂等，重复调用不会多减配额。
// 没有公平性保证之外的取消语义，排队者只能等待。
function createConcurrencyGate(limit: number): {
  acquire(): Promise<() => void>;
} {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    acquire: async () =>
      await new Promise<() => void>((resolve) => {
        const grant = () => {
          active += 1;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active -= 1;
            waiting.shift()?.();
          });
        };
        if (active < limit) grant();
        else waiting.push(grant);
      }),
  };
}

// 库内唯一的「Source 代际状态机」。所有可变状态都在实例上，不依赖模块级单例。
// 关键表：onlineBySourceServerId（当前代际 owner）、connectFlights（profile 级去重）、
// updateFlights（更新身份，独立于 connect 以便断开后仍可取消）、retry/offlineProbe 定时器。
// 不变量：states 只保存最新快照并统一经 setState 发布；任何直接写 states 的地方都违反事件契约。
// [契约] 库内唯一的 Source 代际状态机，所有可变状态都在实例上。
// 不依赖模块级单例，便于测试多实例隔离。
// 任何直接写 states 的代码都违反事件契约。
export class SourceServerConnectionManager {
  private readonly adapters = new Map<string, SourceServerTransportAdapter>();
  private readonly states = new Map<string, SourceServerConnectionStateSnapshot>();
  private readonly compatibilityByProfileId = new Map<
    string,
    ReturnType<typeof preserveCompatibilityState>
  >();
  // [并发] 当前代际 owner 表，写入点是 connectOnce 的发布段。
  // 先删除再 dispose 的顺序保证重复 close 幂等。
  // 不要缓存该表的 value 跨 await 使用。
  private readonly onlineBySourceServerId = new Map<string, OnlineConnection>();
  // [并发] profile 级 connect 去重表，键是 profileId。
  // 一个 flight 可能被多个调用方共享，取消由 controller 统一发起。
  // 删除时必须确认仍是自己的 flight（INV-04）。
  private readonly connectFlights = new Map<string, ConnectFlight>();
  private readonly stateEmitter = new Emitter<SourceServerConnectionStateSnapshot>();
  private readonly reconnectEmitter = new Emitter<ManagedSourceServerConnection>();
  private readonly connectionInvalidatedEmitter =
    new Emitter<SourceServerConnectionInvalidatedEvent>();
  // [契约] 恢复意图表：存在即表示该 Source 需要自动恢复。
  // reconnectInputs 在首次发布时 set，显式断开时 delete 同一 sourceServerId。
  // 也是“非在线→在线”判定重连事实的唯一依据。
  private readonly reconnectInputs = new Map<string, ReconnectInput>();
  private readonly profileIdsBySourceServerId = new Map<string, Set<string>>();
  // [资源] 在线重试定时器，每 Source 至多一个。
  // 排新 timer 前先 clear 旧 timer。
  // 清理必须同时从 Map 删除，否则 dispose 会重复 clear。
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // [资源] 离线探测定时器，与 retryTimers 分开存储。
  // 两者可能先后存在，clearRecoveryTimers 同时清理。
  // 只清一个会让探测与重试并发。
  private readonly offlineProbeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // [并发] 更新操作身份集合，独立于 connectFlights。
  // 断开后仍可取消在途更新，这是它与 connect 分开的原因。
  // 按对象身份删除，不能用 profileId 批量删。
  private readonly updateFlights = new Set<{
    profileId: string;
    sourceServerId?: string;
    controller: AbortController;
  }>();
  // [契约] 状态变更事件只由 setState 触发。
  // 订阅者收到的是不可变快照，修改它不会影响内部状态。
  // 不要在事件回调里同步调用会造成重入的 manager 方法。
  public readonly onDidChangeState: Event<SourceServerConnectionStateSnapshot> =
    this.stateEmitter.event;
  public readonly onDidReconnect: Event<ManagedSourceServerConnection> =
    this.reconnectEmitter.event;
  // [契约] 代际失效通知，订阅方据此 fail-closed 并重建 attachment。
  // 事件发出时旧连接可能尚未 dispose，但已从 owner 表摘除。
  // 同步订阅者若提交断开，调用方需再次检查取消信号。
  public readonly onDidInvalidateConnection: Event<SourceServerConnectionInvalidatedEvent> =
    this.connectionInvalidatedEmitter.event;
  private readonly createAdapter: NonNullable<
    SourceServerConnectionManagerOptions["createAdapter"]
  >;
  private readonly connectServer: NonNullable<
    SourceServerConnectionManagerOptions["connectServer"]
  >;
  private readonly now: () => number;
  private readonly compatibilityManifest: CompatibilityManifest;

  // [资源] 操作日志按 profile 维度记录 connect/update 过程。
  // 注入 now 以便测试控制时间。
  // dispose 时必须一并释放，避免日志流悬挂。
  private readonly operationLogs = new SourceServerOperationLogs(() => this.now());
  public readonly onDidAppendOperationLog = this.operationLogs.onDidAppend;
  // 读取最近操作日志（按 profile 解析到 source 维度）；不触发任何网络或状态变更。
  // [契约] 只读查询最近操作日志，不触发网络或状态变更。
  // 按 profileId 解析到 source 维度。
  // 返回值是副本，调用方修改不影响内部缓冲。
  public getRecentOperationLogs(profile: Pick<ConnectionProfile, "profileId" | "sourceServerId">) {
    return this.operationLogs.read(profile);
  }

  // [契约] 构造只做依赖默认值绑定，不发起连接。
  // options 被保存为 readonly 字段，运行期不可替换。
  // adapter 延迟创建，按 transport 缓存。
  public constructor(private readonly options: SourceServerConnectionManagerOptions) {
    this.createAdapter =
      options.createAdapter ?? ((kind) => createSourceServerTransportAdapter(kind));
    // [契约] 默认走 duplex 连接实现，测试可注入替身。
    // 替换点只在这里，调用方不要绕过字段直接 import 实现。
    // 注入实现必须遵守 ServerRemoteConnection 的 close/dispose 语义。
    this.connectServer = options.connectServer ?? connectServerRemoteOverDuplex;
    this.now = options.now ?? Date.now;
    this.compatibilityManifest = options.compatibilityManifest ?? ZCODE_COMPATIBILITY_MANIFEST;
  }

  // 对外连接入口（默认 membershipIntent="add"）。同 profile 的并发请求会 join 同一 flight，
  // 只有一个真实握手，避免重复安装/升级与重复提交成员关系。
  // [契约] 对外连接入口，默认 membershipIntent=add。
  // 同 profile 并发请求 join 同一 flight，只有一次真实握手。
  // 返回值可能是复用连接，调用方需容忍 reusedConnectionTarget。
  public async connect(
    options: ConnectSourceServerOptions,
  ): Promise<ManagedSourceServerConnection> {
    return await this.connectForSource(
      { ...options, membershipIntent: options.membershipIntent ?? "add" },
      options.profile.sourceServerId,
    );
  }

  // [契约] 把已有连接投影为本次结果，并附带脱敏目标。
  // reusedConnectionTarget 从 reconnectInputs 取，不在 owner 上写回。
  // 缺少恢复输入时省略该字段，属正常形态。
  private reusedConnection(
    connection: ManagedSourceServerConnection,
  ): ManagedSourceServerConnection {
    const target = this.reconnectInputs.get(connection.sourceServerId)?.target;
    return {
      sourceServerId: connection.sourceServerId,
      profileId: connection.profileId,
      serverInfo: connection.serverInfo,
      services: connection.services,
      ...(target ? { reusedConnectionTarget: stripRemoteTargetSecrets(target) } : {}),
    };
  }

  // profile 级 flight 去重 + 操作日志包装的基本单元：先登记 flight 再执行，finally 只删除
  // 「仍是自己」的条目（防止击穿到后来的 flight）；sourceServerId 存在时把 controller 与
  // 调用方 signal 合并，使外部取消同时中止 adapter 的探测/安装。
  // [事务] flight 去重的唯一实现：先查已有，再登记，finally 条件删除。
  // sourceServerId 存在时把 controller 与调用方 signal 合并。
  // recordOperation=false 用于更新后的重连，避免嵌套日志。
  private async connectForSource(
    options: ConnectSourceServerOptions,
    sourceServerId: string | undefined,
    recordOperation = true,
  ): Promise<ManagedSourceServerConnection> {
    // [并发] 命中已有 flight 直接等待其结果，不新建 controller。
    // 这里返回的是复用视图，不是新的 owner。
    // 不要在此重置 flight 的计时或状态。
    const existingFlight = this.connectFlights.get(options.profile.profileId);
    if (existingFlight) return this.reusedConnection(await existingFlight.promise);
    const controller = new AbortController();
    const flightOptions = sourceServerId
      ? {
          ...options,
          context: {
            ...options.context,
            signal: options.context?.signal
              ? AbortSignal.any([options.context.signal, controller.signal])
              : controller.signal,
          },
        }
      : options;
    let flight!: ConnectFlight;
    const connect = (context: TransportContext) =>
      this.connectOnce({ ...flightOptions, context }, controller.signal);
    const promise = (
      recordOperation
        ? this.operationLogs.run(
            "connect",
            options.profile,
            options.target,
            flightOptions.context,
            connect,
          )
        : connect(flightOptions.context ?? {})
    ).finally(() => {
      if (this.connectFlights.get(options.profile.profileId) === flight) {
        this.connectFlights.delete(options.profile.profileId);
      }
    });
    flight = {
      promise,
      ...(sourceServerId ? { sourceServerId } : {}),
      controller,
    };
    this.connectFlights.set(options.profile.profileId, flight);
    return await promise;
  }

  // 同步读取状态；未知 profile 返回 absent 而不是抛错，调用方无需先判断存在性。
  // [契约] 同步读取状态；未知 profile 返回 absent 而非抛错。
  // absent 快照带当前时间，便于 UI 排序。
  // 调用方无需先判断 profile 是否存在。
  public getStateByProfile(profileId: string): SourceServerConnectionStateSnapshot {
    return (
      this.states.get(profileId) ?? {
        profileId,
        state: "absent",
        updatedAt: this.now(),
      }
    );
  }

  // 全量状态快照（直接返回内存中的数组副本，不排序；顺序由调用方/UI 决定）。
  // [契约] 返回内存数组副本，不排序。
  // 顺序由调用方/UI 决定，不要在这里加业务排序。
  // 快照对象本身仍被内部持有，调用方不得修改。
  public listStates(): SourceServerConnectionStateSnapshot[] {
    return [...this.states.values()];
  }

  // 应用启动时的静默重连（membershipIntent="retain"，不新增成员）。
  // 输入：按「最近在线优先」排好的候选，maxConcurrency/timeoutMs 可选（单条超时默认 10s）。
  // 输出：逐条 online/failed，永不抛出；失败只记录诊断，不影响其它候选。
  // 副作用：真实建立连接、可能触发安装/升级；全部在后台限流执行。
  // 并发纪律：首个候选独占启动窗口，其余按全局 3 并发；docker 冷启动额外串行（见下方 Bug 注释）。
  // [事务] 启动静默重连：首个候选独占窗口，其余按全局并发。
  // 逐条 online/failed，永不抛出，失败只记诊断。
  // reconnectOnStartup 触发真实连接，可能连带安装或升级，一律走后台限流队列。
  public async reconnectOnStartup(
    candidates: Array<{
      profile: ConnectionProfile;
      target: Exclude<RemoteTarget, { kind: "server" }>;
    }>,
    options: { maxConcurrency?: number; timeoutMs?: number } = {},
  ): Promise<StartupReconnectResult[]> {
    if (candidates.length === 0) return [];
    const timeoutMs = options.timeoutMs ?? 10_000;
    // [并发] 全局并发下限为 1，默认 3。
    // maxConcurrency 传 0 或负数会被抬到 1，避免死锁。
    // 该闸门跨候选共享，单个候选失败不释放额外配额。
    const globalGate = createConcurrencyGate(Math.max(1, options.maxConcurrency ?? 3));
    // Bug 原因：多个 Docker Source 共用本机 Docker daemon、磁盘和 CPU。三条冷启动 probe
    // 同时校验大体积 release 时，单条手动连接只需约 4.6 秒，三条并发却会一起撞上 10 秒
    // 上限。Docker 冷启动在 transport 内串行，SSH 仍可占用其余全局槽位。
    // [并发] Docker 冷启动额外串行，避免共享 daemon 时互相拖慢。
    // SSH 候选不占用该闸门，仍可使用其余全局槽位。
    // 把该闸门放宽会让冷启动集体撞 10 秒超时。
    const dockerGate = createConcurrencyGate(1);
    // [事务] 单条候选：取两级闸门 → 连接与超时竞速 → finally 释放。
    // 超时通过 abortController 中止连接，并记录诊断阶段。
    // 任何异常都折叠成 failed 结果，不向上抛。
    const reconnectCandidate = async (
      candidate: (typeof candidates)[number],
    ): Promise<StartupReconnectResult> => {
      const releaseTransport =
        candidate.target.kind === "docker" ? await dockerGate.acquire() : undefined;
      const releaseGlobal = await globalGate.acquire();
      const abortController = new AbortController();
      const startedAt = Date.now();
      let diagnosticPhase = "queued";
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.connect({
            profile: candidate.profile,
            target: candidate.target,
            membershipIntent: "retain",
            context: { signal: abortController.signal },
            onDiagnosticPhase: (phase) => {
              diagnosticPhase = phase;
            },
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`Source Server startup reconnect timed out after ${timeoutMs}ms`));
              abortController.abort();
            }, timeoutMs);
          }),
        ]);
        return { profileId: candidate.profile.profileId, status: "online" };
      } catch (error) {
        if (error instanceof Error && error.message.includes("startup reconnect timed out")) {
          this.options.logWarn?.(
            `Source Server startup reconnect timeout diagnostic profile=${
              candidate.profile.profileId
            } transport=${candidate.target.kind} phase=${diagnosticPhase} elapsedMs=${Date.now() - startedAt}`,
            error,
          );
        }
        return {
          profileId: candidate.profile.profileId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (timer) clearTimeout(timer);
        releaseGlobal();
        releaseTransport?.();
      }
    };
    // 最近在线的 Source 对应用户最可能仍在使用的 workspace。首个候选独占启动窗口，
    // 避免和其余 Source 同时 probe/握手而在应用冷启动峰值中耗尽 10 秒预算；完成后其余
    // Source 再按全局 3 并发继续，不改变单 Source 超时和只尝试一次的合同。
    const [firstCandidate, ...remainingCandidates] = candidates;
    const firstResult = await reconnectCandidate(firstCandidate!);
    return [firstResult, ...(await Promise.all(remainingCandidates.map(reconnectCandidate)))];
  }

  // 读取当前物理连接；不存在返回 undefined。调用方必须把它当作「一次性代际句柄」，
  // 不要跨 await 缓存后在断线后继续使用。
  // [契约] 读取当前物理连接；不存在返回 undefined。
  // 调用方必须把它当一次性代际句柄，不要跨 await 缓存。
  // 断线后继续使用旧句柄属于调用方违约。
  public getOnlineConnection(sourceServerId: string): ManagedSourceServerConnection | undefined {
    return this.onlineBySourceServerId.get(sourceServerId);
  }

  // 提供文件传输能力（exec/upload），闭包绑定当前 online owner 与解析后的 target。
  // 失败语义：未在线或无恢复输入时抛错；每次操作前后都校验 owner 未变，旧代际闭包立即失效。
  // 副作用：不建立新连接，复用 adapter 已有的 ssh/wsl/docker 通道。
  // [失败路径] 未在线或无恢复输入时同步抛错。
  // 返回的闭包绑定当前 owner，每次操作前后都校验代际（INV-15）。
  // 不会建立新连接，只复用 adapter 已有通道。
  public getFileTransfer(sourceServerId: string): SourceServerFileTransfer {
    const online = this.onlineBySourceServerId.get(sourceServerId);
    const input = this.reconnectInputs.get(sourceServerId);
    if (!online || !input) throw new Error("Source Server file transfer is unavailable");
    const backend = this.getAdapter(input.profile.transport).createFileTransfer(input.target);
    // [资源] 代际校验闭包：owner 一变即抛错。
    // upload 在操作前后各校验一次，覆盖中途重连。
    // 不能省略操作后的校验，否则使用了跨代际线路而不自知。
    const assertCurrent = () => {
      // 暂存属于当前 attachment generation；旧能力不能在重连后悄悄使用新线路或重建连接。
      if (this.onlineBySourceServerId.get(sourceServerId) !== online) {
        throw new Error("Source Server file transfer generation is unavailable");
      }
    };
    return {
      exec: async (command) => {
        assertCurrent();
        return backend.exec(command);
      },
      upload: async (localPath, remotePath, options) => {
        assertCurrent();
        await backend.upload(localPath, remotePath, options);
        assertCurrent();
      },
    };
  }

  // 更新远端 Server（安装/升级）并重新握手；整个过程包在操作日志里，超时/取消由调用方 signal 控制。
  // 输出：更新后新代际的连接；不同于 connect，更新会先让旧代际失效（invalidated 事件）。
  // 失败语义：解析发行包失败、安装失败、重连失败都原样抛出；旧连接已失效时状态停在 updating。
  // [事务] 更新外层只做操作日志包装，超时/取消由调用方 signal 控制。
  // 更新会先让旧代际失效并发 invalidated 事件。
  // 解析/安装/重连失败都原样抛出，不吞错。
  public async updateServer(
    options: Parameters<SourceServerConnectionManager["updateServerOnce"]>[0],
  ): Promise<ManagedSourceServerConnection> {
    return this.operationLogs.run(
      "update",
      options.profile,
      options.target,
      options.context,
      (context) => this.updateServerOnce({ ...options, context }),
    );
  }

  // [事务] 更新流程：probe → 解析 release → installOrUpdate → 失效旧代际 → 重连。
  // 全程登记 updateFlights，便于断开时取消。
  // 每个 await 后 throwIfAborted，保证取消立即生效。
  private async updateServerOnce(options: {
    profile: ConnectionProfile;
    target: Exclude<RemoteTarget, { kind: "server" }>;
    force?: boolean;
    context?: TransportContext;
    release?: ServerReleaseAsset;
    resolveRelease?: SourceServerConnectionManagerOptions["resolveRelease"];
  }): Promise<ManagedSourceServerConnection> {
    const sourceServerId = options.profile.sourceServerId;
    const previousState = this.getStateByProfile(options.profile.profileId);
    const previousCompatibility = preserveCompatibilityState(previousState);
    const controller = new AbortController();
    const flight = { profileId: options.profile.profileId, sourceServerId, controller };
    const context: TransportContext = {
      ...options.context,
      signal: options.context?.signal
        ? AbortSignal.any([options.context.signal, controller.signal])
        : controller.signal,
    };
    // Bug 原因：更新不在 connectFlights 中，断开后安装的迟到结果仍能重新发布连接。
    // 按操作身份登记，尚未握手的 Profile 也可取消；取消时先摘 owner，旧更新不再压住新连接的恢复。
    // [并发] 更新身份时先写 reconnectInputs 再清 recoveryTimer，避免清表与调度交错。
    // 登记使尚未握手的 profile 也能被取消。
    // finally 中按对象身份删除，避免误删同 profile 的后续更新。
    this.updateFlights.add(flight);
    if (sourceServerId) {
      this.clearRecoveryTimers(sourceServerId);
    }
    this.setState(options.profile.profileId, {
      state: "updating",
      ...(sourceServerId ? { sourceServerId } : {}),
      ...previousCompatibility,
    });
    let runningTasks: SourceServerRunningTask[] | undefined;
    try {
      context.signal?.throwIfAborted();
      const adapter = this.getAdapter(options.profile.transport);
      // Bug 原因：已握手分支曾改走远端 `zcode update`，但正常安装链没有配置远端 release
      // manifest URL，生产更新必然失败。所有 Profile 都由 Desktop 解析同一 archive 并经 Adapter 应用。
      const probe = await adapter.probe(options.target, context);
      context.signal?.throwIfAborted();
      const releaseResolver = options.resolveRelease ?? this.options.resolveRelease;
      const release =
        options.release ?? (releaseResolver ? await releaseResolver(probe, options.target) : null);
      context.signal?.throwIfAborted();
      if (!release) throw new Error("Source Server update release is unavailable");
      await adapter.installOrUpdate(options.target, release, context, {
        force: options.force === true,
      });
      context.signal?.throwIfAborted();
      const online = sourceServerId ? this.onlineBySourceServerId.get(sourceServerId) : undefined;
      if (sourceServerId && online) {
        this.invalidateOnlineConnectionForUpdate(sourceServerId, online);
      }
      // 失效事件的同步订阅者也可能提交断开，不能在该终态后进入 bootstrapping。
      context.signal?.throwIfAborted();
      // 重连事件由 connectOnce 的发布点统一 fire，这里不再重复发布。
      return await this.connectForSource(
        {
          profile: options.profile,
          target: options.target,
          context,
        },
        sourceServerId,
        false,
      );
    } catch (error) {
      // 终态由断开/删除/释放操作发布；旧更新的成功或失败都不能写回捕获的旧状态。
      controller.signal.throwIfAborted();
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "source-server-update-running-tasks"
      ) {
        // 清单走只读控制命令，不扩展持久化 status 格式，旧远端不支持时保持未知。
        try {
          const result = await this.getAdapter(options.profile.transport).exec(
            options.target,
            ["running-tasks", "--json"],
            context,
          );
          if (result.exitCode === 0) {
            const parsed = sourceServerRunningTasksSchema.safeParse(
              JSON.parse(result.stdout.trim()),
            );
            if (parsed.success) runningTasks = parsed.data;
          }
        } catch {
          /* 清单不可用不能绕过 force=false 的运行任务守卫。 */
        }
      }
      // running-tasks 读取同样会让出执行权，断开可能发生在错误收尾期间。
      controller.signal.throwIfAborted();
      const normalized = normalizeRemoteConnectionError(error);
      const errorCode = isPublicZCodeErrorCode(normalized.code) ? normalized.code : undefined;
      const retryable =
        error && typeof error === "object" && "retryable" in error
          ? (error as { retryable?: unknown }).retryable
          : undefined;
      if (sourceServerId && !this.onlineBySourceServerId.has(sourceServerId)) {
        // 更新期间 transport 已断开时不能恢复捕获的 online 快照，否则会产生无连接、无 timer 的假在线。
        if (this.reconnectInputs.has(sourceServerId)) {
          if (!this.stopAutomaticRecoveryForTerminalFailure(sourceServerId, error)) {
            this.scheduleOnlineRetry(sourceServerId, 0);
          }
        } else {
          this.setState(options.profile.profileId, {
            state: "offline",
            sourceServerId,
            ...previousCompatibility,
            ...(runningTasks ? { runningTasks } : {}),
            ...(errorCode ? { errorCode } : {}),
            retryable: typeof retryable === "boolean" ? retryable : true,
            error: normalized.message,
          });
        }
      } else {
        this.setState(options.profile.profileId, {
          // 更新失败不是新的兼容性事实；真实连接仍在时恢复操作前状态。
          state: previousState.state === "absent" ? "failed" : previousState.state,
          ...(sourceServerId ? { sourceServerId } : {}),
          ...previousCompatibility,
          ...(runningTasks ? { runningTasks } : {}),
          ...(errorCode ? { errorCode } : {}),
          retryable: typeof retryable === "boolean" ? retryable : true,
          error: normalized.message,
        });
      }
      throw error;
    } finally {
      this.updateFlights.delete(flight);
    }
  }

  // 显式断开：等价于「用户要求停止这条 Source 的全部自动恢复」，见 disconnectSource。
  // [契约] 显式断开等价于“停止该 Source 的全部自动恢复”。
  // 委托 disconnectSource，不删除 profile 数据。
  // 调用后必须发布 offline 终态，attachment 才可收敛。
  public disconnect(sourceServerId: string): void {
    this.disconnectSource(sourceServerId);
  }

  // 删除一个 Profile：若它是当前线路 owner，等价于断开整个 Source；否则只清理该 profile
  // 的 flight/订阅/状态，并接回被取消更新遗留的恢复意图（见下方 Bug 注释）。
  // 副作用：abort 更新与连接 flight、发 profile-removed 失效事件、可能排一次 retry。
  // 失败语义：无异常路径；对未知 profile 幂等。
  // [事务] 删除 profile：若是当前线路 owner 则等价于断开整个 Source。
  // 非 owner 分支只清 flight/订阅/状态，并接回被取消更新的恢复意图。
  // 无异常路径，对未知 profile 幂等。
  public removeProfile(profileId: string): void {
    this.operationLogs.removeProfile(profileId);
    const canceledUpdateSources = new Set<string>();
    for (const flight of this.updateFlights) {
      if (flight.profileId !== profileId) continue;
      if (flight.sourceServerId) canceledUpdateSources.add(flight.sourceServerId);
      this.updateFlights.delete(flight);
      flight.controller.abort(new SourceServerProfileRemovedError(profileId));
    }
    const connectingSourceServerId = this.connectFlights.get(profileId)?.sourceServerId;
    const sourceOwnedOnlyByConnectingProfile =
      connectingSourceServerId &&
      !this.reconnectInputs.has(connectingSourceServerId) &&
      !this.onlineBySourceServerId.has(connectingSourceServerId)
        ? connectingSourceServerId
        : undefined;
    const currentSourceServerId =
      [...this.reconnectInputs].find(([, input]) => input.profile.profileId === profileId)?.[0] ??
      [...this.onlineBySourceServerId].find(([, online]) => online.profileId === profileId)?.[0] ??
      sourceOwnedOnlyByConnectingProfile;
    if (currentSourceServerId) {
      // Bug 原因：Directory 删除当前线路后，旧实现只删展示状态，恢复 owner、timer 和
      // 已解析的 secret 仍存活，断线后会继续使用已删除线路。删除当前线路等价于显式
      // 断开整个 Source；其他线路只能由用户后续手动选择，不能在这里静默接管。
      this.disconnectSource(currentSourceServerId, profileId);
      return;
    }

    const flight = this.connectFlights.get(profileId);
    if (flight) {
      this.connectFlights.delete(profileId);
      flight.controller.abort(new SourceServerProfileRemovedError(profileId));
    }
    for (const online of this.onlineBySourceServerId.values()) {
      online.profileIds.delete(profileId);
    }
    this.states.delete(profileId);
    this.compatibilityByProfileId.delete(profileId);
    for (const [sourceServerId, profileIds] of this.profileIdsBySourceServerId) {
      if (!profileIds.delete(profileId)) continue;
      if (profileIds.size === 0) this.profileIdsBySourceServerId.delete(sourceServerId);
    }
    // Bug 原因：非当前线路的更新可能已移除旧物理连接；取消后跳过更新收尾，原 owner
    // 会永久停在 updating。删除操作接回仍保留的恢复意图，不依赖已取消更新的迟到结果。
    for (const sourceServerId of canceledUpdateSources) {
      const input = this.reconnectInputs.get(sourceServerId);
      if (
        input &&
        !this.onlineBySourceServerId.has(sourceServerId) &&
        this.getStateByProfile(input.profile.profileId).state === "updating" &&
        ![...this.updateFlights].some((flight) => flight.sourceServerId === sourceServerId)
      )
        this.scheduleOnlineRetry(sourceServerId, 0);
    }
  }

  // 显式断开某 Source 的全部代际：先捕获该 Source 的所有 profileId（含在途 flight），
  // abort 所有 connect/update flight，清计时器与恢复索引，再 dispose 物理连接与项目订阅，
  // 最后统一发 offline 终态。removedProfileId 存在时额外发 profile-removed 失效事件。
  // 为什么先捕获再删索引：意外断线会先摘 owner，若先删索引再遍历就会漏掉 profile（见 Bug 注释）。
  // 不变量：迟到的 connect 成功被 abort 后只释放不发布；offline 终态一定会发出，
  // 因此上层 attachment 不会停在「连接中」。
  // [事务] 断开的完整顺序：捕获 profileIds → abort update/connect flight → 清 timer 与索引 → 发失效事件 → dispose → 发 offline。
  // 必须先捕获再删索引，否则意外断线后漏掉 profile（INV-16）。
  // removedProfileId 额外发 profile-removed 并删除其展示状态。
  private disconnectSource(sourceServerId: string, removedProfileId?: string): void {
    const online = this.onlineBySourceServerId.get(sourceServerId);
    const reconnectInput = this.reconnectInputs.get(sourceServerId);
    const profileIds = new Set(this.profileIdsBySourceServerId.get(sourceServerId) ?? []);
    for (const profileId of online?.profileIds ?? []) profileIds.add(profileId);
    if (reconnectInput) profileIds.add(reconnectInput.profile.profileId);
    for (const flight of this.updateFlights) {
      if (flight.sourceServerId !== sourceServerId) continue;
      this.updateFlights.delete(flight);
      flight.controller.abort(new SourceServerExplicitDisconnectError(sourceServerId));
      profileIds.add(flight.profileId);
    }

    // Bug 原因：意外断线会先摘除 online owner；显式断开若再用 online 是否存在判断生命周期，
    // 就只会清掉 timer 而永久遗留 retrying。必须在删除恢复索引前捕获 Source 的全部 Profile，
    // 中止仍在执行的 Source flight，并且无论当前是否还有物理连接都发布 offline 终态；否则
    // 已进入 bootstrapping 的迟到成功还会覆盖用户刚刚提交的 offline 意图。
    this.clearRecoveryTimers(sourceServerId);
    for (const [profileId, flight] of this.connectFlights) {
      if (flight.sourceServerId !== sourceServerId) continue;
      if (this.connectFlights.get(profileId) === flight) {
        this.connectFlights.delete(profileId);
      }
      flight.controller.abort(
        profileId === removedProfileId
          ? new SourceServerProfileRemovedError(profileId)
          : new SourceServerExplicitDisconnectError(sourceServerId),
      );
      profileIds.add(profileId);
    }
    if (removedProfileId) profileIds.delete(removedProfileId);
    this.reconnectInputs.delete(sourceServerId);
    this.profileIdsBySourceServerId.delete(sourceServerId);
    if (online) this.onlineBySourceServerId.delete(sourceServerId);
    if (removedProfileId) {
      this.connectionInvalidatedEmitter.fire({
        sourceServerId,
        reason: "profile-removed",
        recoverable: false,
      });
    }
    online?.projectSubscription?.dispose();
    online?.connection.dispose();
    for (const profileId of profileIds) {
      this.setState(profileId, { state: "offline", sourceServerId });
    }
    if (removedProfileId) {
      this.states.delete(removedProfileId);
      this.compatibilityByProfileId.delete(removedProfileId);
    }
  }

  // 进程/模块退出：abort 所有在途 flight、清所有计时器、断开所有持有恢复意图的 Source，
  // 再释放 adapter 与三个 emitter 与日志。顺序关键：先断连接再释放 emitter，保证订阅者
  // 仍能收到最终 offline 事件；dispose 后本实例不可复用。
  // [资源] 进程退出：abort 全部 flight、清全部 timer、断开持有恢复意图的 Source。
  // 顺序关键：先断连接再释放 emitter，订阅者仍能收到最终 offline。
  // dispose 后实例不可复用。
  public dispose(): void {
    const reason = Object.assign(new Error("Source Server manager disposed"), {
      code: "remote-connection-canceled",
    });
    for (const flight of this.updateFlights) flight.controller.abort(reason);
    this.updateFlights.clear();
    // 更新的重握手可能尚无 online owner，不能只遍历 online 表来回收在途连接。
    for (const flight of this.connectFlights.values()) flight.controller.abort(reason);
    this.connectFlights.clear();
    for (const sourceServerId of this.retryTimers.keys()) this.clearRecoveryTimers(sourceServerId);
    for (const sourceServerId of this.offlineProbeTimers.keys())
      this.clearRecoveryTimers(sourceServerId);
    // 离线恢复也持有连接意图；只清 online 会让被中止 flight 的迟到 catch 重新排重试。
    for (const sourceServerId of new Set([
      ...this.reconnectInputs.keys(),
      ...this.onlineBySourceServerId.keys(),
    ])) {
      this.disconnect(sourceServerId);
    }
    for (const adapter of this.adapters.values()) adapter.dispose?.();
    this.adapters.clear();
    this.stateEmitter.dispose();
    this.reconnectEmitter.dispose();
    this.connectionInvalidatedEmitter.dispose();
    this.operationLogs.dispose();
  }

  // 一次真实连接全过程（同一 profile 只会有一个 flight 进入这里）。
  // 流程：target/transport 一致性校验 -> probe -> 兼容性判定与安装/升级（需用户开关）-> 握手 ->
  //   提交成员关系（仅在未取消时）-> 发布 online owner 并 fire onDidReconnect。
  // 失败语义：任一步抛错都原样上抛；未发布的物理连接必须在 finally 中 dispose，
  //   已发布的 old owner 不会被这个失败路径摘除（只有 handleUnexpectedClose/显式断开会摘）。
  // 不变量：发布前必须再次检查取消信号；取消后即使握手成功也只释放不发布（显式断开纪律）。
  private async connectOnce(
    options: ConnectSourceServerOptions,
    explicitDisconnectSignal?: AbortSignal,
  ): Promise<ManagedSourceServerConnection> {
    const { profile, target } = options;
    if (target.kind === "server" || profile.transport !== target.kind) {
      throw new Error(
        `Connection Profile ${profile.profileId} transport does not match target ${target.kind}`,
      );
    }
    const signal = options.context?.signal;
    let unpublishedConnection: ServerRemoteConnection | undefined;
    const throwIfAborted = () => {
      explicitDisconnectSignal?.throwIfAborted();
      signal?.throwIfAborted();
    };
    throwIfAborted();
    let commitMembership: ((sourceServerId: string) => Promise<void>) | undefined;
    if (this.options.admitConnection) {
      try {
        commitMembership = await this.options.admitConnection({
          profile,
          intent: options.membershipIntent ?? "retain",
          confirmIdentityChange: options.confirmIdentityChange === true,
        });
      } catch (error) {
        // 线路已移除时，迟到 admission 错误不再有权重建 failed 展示行。
        throwIfAborted();
        this.setState(profile.profileId, {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
          retryable: false,
        });
        throw error;
      }
    }
    throwIfAborted();
    if (profile.sourceServerId) {
      const existing = this.onlineBySourceServerId.get(profile.sourceServerId);
      if (existing) {
        await commitMembership?.(profile.sourceServerId);
        // 复用也经过异步成员提交；这段等待可能已被用户断开，不能返回旧 socket。
        throwIfAborted();
        if (this.onlineBySourceServerId.get(profile.sourceServerId) !== existing)
          throw new Error("Source Server connection changed during admission");
        existing.profileIds.add(profile.profileId);
        this.rememberSourceProfiles(profile.sourceServerId, existing.profileIds);
        this.setState(profile.profileId, {
          state: "online",
          sourceServerId: profile.sourceServerId,
        });
        return this.reusedConnection(existing);
      }
    }
    this.setState(profile.profileId, { state: "bootstrapping" });
    const adapter = this.getAdapter(profile.transport);
    let targetTransportCancelled = false;
    const cancelTargetTransport = () => {
      if (targetTransportCancelled) return;
      targetTransportCancelled = true;
      adapter.cancel?.(target);
    };
    if (signal?.aborted || explicitDisconnectSignal?.aborted) {
      cancelTargetTransport();
      throwIfAborted();
    }
    signal?.addEventListener("abort", cancelTargetTransport, { once: true });
    explicitDisconnectSignal?.addEventListener("abort", cancelTargetTransport, { once: true });
    let ignoreConnectionClose = false;
    try {
      options.onDiagnosticPhase?.("probe");
      const shouldRefreshDevelopmentArtifact =
        this.options.sourceServerArtifactPolicy === "development-content-addressed" &&
        target.kind === "ssh";
      const probe = await adapter.probe(
        target,
        options.context ?? {},
        shouldRefreshDevelopmentArtifact ? { includeReleaseIdentity: true } : undefined,
      );
      throwIfAborted();
      if (probe.installed) {
        const installedVersion = probe.installedVersion?.trim() || "unknown";
        let compatibleInstalledVersion = false;
        try {
          compatibleInstalledVersion =
            compareCompatibilityVersions(
              installedVersion,
              this.compatibilityManifest.minCompatibleVersion,
            ) >= 0;
        } catch {
          // Bug 原因：pre-R3 或损坏安装可能返回空值/unknown。继续执行新版本 ensureDaemon
          // 只会在 ingress-token 合同处变成通用 failed，用户也失去升级入口。
          compatibleInstalledVersion = false;
        }
        if (!compatibleInstalledVersion) {
          this.setState(profile.profileId, {
            state: "needs-upgrade",
            updateAvailability: "required",
            currentVersion: installedVersion,
            availableVersion: this.compatibilityManifest.productVersion,
            minimumVersion: this.compatibilityManifest.minCompatibleVersion,
            upgradeTarget: "server",
            errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
            retryable: false,
          });
          throw new SourceServerUpgradeRequiredError(
            profile.profileId,
            "server",
            installedVersion,
            this.compatibilityManifest.minCompatibleVersion,
          );
        }
        if (
          shouldRefreshDevelopmentArtifact &&
          installedVersion === this.compatibilityManifest.productVersion
        ) {
          const releaseResolver = options.resolveRelease ?? this.options.resolveRelease;
          if (!releaseResolver) {
            throw new Error("Development Source Server release is unavailable");
          }
          const release = await releaseResolver(probe, target);
          throwIfAborted();
          if (
            release.version === installedVersion &&
            release.sha256.toLowerCase() !== probe.installedArchiveSha256?.toLowerCase()
          ) {
            // Bug 原因（R3A-B-06）：开发态同版本刷新过去在这里直接 installOrUpdate，绕开了
            // updateServer 的 updating 状态、操作日志和 force 守卫确认；远端有运行中任务时 guard
            // 只能表现为普通连接失败，UI 既没有“强制更新”入口也不会在任务结束后重试。
            // 开发态与生产态只在“是否需要更新”的判定上不同（SHA vs 版本兼容），判定之后必须
            // 走同一条 needs-upgrade → updateSource/updateServer 链路，连接流程本身不执行更新。
            this.setState(profile.profileId, {
              state: "needs-upgrade",
              updateAvailability: "required",
              currentVersion: installedVersion,
              availableVersion: release.version,
              minimumVersion: this.compatibilityManifest.minCompatibleVersion,
              upgradeTarget: "server",
              errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
              retryable: false,
            });
            throw new SourceServerUpgradeRequiredError(
              profile.profileId,
              "server",
              installedVersion,
              this.compatibilityManifest.minCompatibleVersion,
              "development-archive",
            );
          }
        }
      }
      if (!probe.installed) {
        if (profile.sourceServerId) {
          await this.options.directory.markSourceUninstalled?.(profile.profileId);
          throwIfAborted();
        }
        const releaseResolver = options.resolveRelease ?? this.options.resolveRelease;
        const release =
          options.release ??
          (options.allowInstall && releaseResolver
            ? await releaseResolver(probe, target)
            : undefined);
        throwIfAborted();
        if (!release) {
          // 预览是附加信息；CDN/缓存元数据不可用时仍保留安装等待点。实际安装解析继续严格失败。
          const previewRelease = releaseResolver
            ? await releaseResolver(probe, target, { metadataOnly: true }).catch(() => undefined)
            : undefined;
          throwIfAborted();
          this.setState(profile.profileId, {
            ...(previewRelease
              ? {
                  installPreview: {
                    version: previewRelease.version,
                    sizeBytes: previewRelease.sizeBytes,
                    ...(probe.installPath ? { installPath: probe.installPath } : {}),
                  },
                }
              : {}),
            state: "needs-install",
            ...(profile.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
            errorCode: SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
            retryable: false,
          });
          throw new SourceServerInstallRequiredError(profile.profileId);
        }
        await adapter.installOrUpdate(target, release, options.context ?? {});
        throwIfAborted();
      }
      options.onDiagnosticPhase?.("daemon");
      const ingress = await adapter.ensureDaemon(target, options.context ?? {}, {
        observedStatus: probe.daemonStatus,
      });
      throwIfAborted();
      let published: { sourceServerId: string; connection: ServerRemoteConnection } | undefined;
      let closedBeforePublish: string | undefined;
      options.onDiagnosticPhase?.("protocol-handshake");
      const connection = await this.connectServer({
        ingressToken: ingress.ingressToken,
        createConnection: async () =>
          await adapter.openChannel(target, ingress, options.context ?? {}),
        onClose: ({ reason }) => {
          if (ignoreConnectionClose) return;
          // Bug 原因（RV-P1-1）：close 事件过去只按 sourceServerId 路由，并用在线表是否存在做守卫。
          // 握手落盘（recordHandshake）期间连接关闭时，在线表要么为空（事件被丢弃，随后把已关闭的
          // 连接发布为 online），要么指向同一 Source 上另一条健康连接（sibling 的关闭会拆掉在线
          // owner 并清掉它的重试）。发布前只记录关闭事实，由发布点按连接失败收口；发布后才处理，
          // 且必须带上本连接身份，close 只作用于它所属的那条连接。
          if (!published) {
            closedBeforePublish = reason || "connection closed";
            return;
          }
          this.handleUnexpectedClose(published.sourceServerId, reason, published.connection);
        },
      });
      unpublishedConnection = connection;
      throwIfAborted();
      const compatibility = connection.serverInfo.compatibility;
      if (!compatibility) {
        this.setState(profile.profileId, {
          state: "needs-upgrade",
          updateAvailability: "required",
          currentVersion: connection.serverInfo.version,
          availableVersion: this.compatibilityManifest.productVersion,
          minimumVersion: this.compatibilityManifest.minCompatibleVersion,
          upgradeTarget: "server",
          errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
          retryable: false,
        });
        throw new SourceServerUpgradeRequiredError(
          profile.profileId,
          "server",
          connection.serverInfo.version,
          this.compatibilityManifest.minCompatibleVersion,
        );
      }
      const compatibilityResult = evaluateSourceServerCompatibility(
        this.compatibilityManifest,
        compatibility,
      );
      const compatibilityState = buildCompatibilityState(this.compatibilityManifest, compatibility);
      if (!compatibilityResult.compatible && compatibilityResult.upgradeTarget) {
        this.setState(profile.profileId, {
          state: "needs-upgrade",
          ...compatibilityState,
          errorCode: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
          retryable: false,
        });
        throw new SourceServerUpgradeRequiredError(
          profile.profileId,
          compatibilityResult.upgradeTarget,
          compatibilityResult.olderVersion,
          compatibilityResult.requiredMinimumVersion,
        );
      }
      const sourceServerId = connection.serverInfo.serverId;
      const connectedAt = this.now();
      options.onDiagnosticPhase?.("directory-record");
      const handshakeResult = await this.options.directory.recordHandshake(
        profile.profileId,
        {
          sourceServerId,
          osUser: connection.serverInfo.identity?.osUser,
          hostname: connection.serverInfo.identity?.hostname,
          version:
            connection.serverInfo.compatibility?.productVersion ?? connection.serverInfo.version,
          connectedAt,
          workspaces: connection.serverInfo.workspaces,
        },
        ...(options.confirmIdentityChange ? [{ confirmIdentityChange: true }] : []),
      );
      throwIfAborted();
      if (handshakeResult.identityChanged && options.confirmIdentityChange !== true) {
        this.setState(profile.profileId, {
          state: "identity-change-pending",
          sourceServerId: profile.sourceServerId,
          pendingSourceServerId: sourceServerId,
          errorCode: SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
          retryable: false,
        });
        throw new SourceServerIdentityChangePendingError(profile.profileId, sourceServerId);
      }
      const effectiveProfile = handshakeResult.effectiveProfile ?? profile;
      // 关闭发生于目录落盘时不能再提交成员；健康 sibling owner 可继续承接本次 admission。
      if (closedBeforePublish !== undefined && !this.onlineBySourceServerId.has(sourceServerId))
        throw new SourceServerHandshakeClosedError(closedBeforePublish);
      await commitMembership?.(sourceServerId);
      throwIfAborted();
      options.onDiagnosticPhase?.("publish-online");
      if (effectiveProfile.profileId !== profile.profileId) {
        this.setState(profile.profileId, {
          state: "offline",
          ...(profile.sourceServerId ? { sourceServerId: profile.sourceServerId } : {}),
        });
      }

      const existing = this.onlineBySourceServerId.get(sourceServerId);
      if (existing) {
        existing.profileIds.add(effectiveProfile.profileId);
        this.rememberSourceProfiles(sourceServerId, existing.profileIds);
        this.setState(effectiveProfile.profileId, {
          state: "online",
          sourceServerId,
          ...compatibilityState,
        });
        return this.reusedConnection(existing);
      }
      if (closedBeforePublish !== undefined) {
        // 握手期间连接已死：不能发布，按普通连接失败抛出，让手动连接显示可重试失败、
        // 自动恢复路径继续下一档重试。放在 sibling join 之后：owner 健康时 join 才是正确结果。
        throw new SourceServerHandshakeClosedError(closedBeforePublish);
      }
      const managed: OnlineConnection = {
        sourceServerId,
        profileId: effectiveProfile.profileId,
        serverInfo: connection.serverInfo,
        services: connection.services,
        connection,
        profileIds: new Set([effectiveProfile.profileId]),
      };
      if (this.options.onProjectChange) {
        managed.projectSubscription = connection.services.broadcastService.onMessage((event) => {
          // 换代/断开后迟到广播不能代表当前 Source；通知仅触发读取，不带项目数据。
          if (
            event.channel === "state:projects" &&
            this.onlineBySourceServerId.get(sourceServerId) === managed
          )
            this.options.onProjectChange?.(sourceServerId);
        });
      }
      // Bug 原因：onDidReconnect 过去只挂在 retry/probe timer 回调和 updateServer 上；
      // retrying/offline 期间由 connect()（connectProfile / confirmIdentityChange）手动连接成功，
      // Manager 会清掉待触发的 retry timer 并发布 online，却不发 reconnect。Host wrapper 只在
      // reconnect 时换 services，Registry entry 的 recoveryReady 因此无人 resolve，同 route 新
      // connect 永久等待。reconnectInputs 只在首次发布时写入、显式断开时删除，「再次发布同一
      // Source」就是唯一的重连事实源：无论谁触发的连接，非在线 -> 在线都在这里统一 fire。
      const isRepublish = this.reconnectInputs.has(sourceServerId);
      this.onlineBySourceServerId.set(sourceServerId, managed);
      published = { sourceServerId, connection };
      unpublishedConnection = undefined;
      this.rememberSourceProfiles(sourceServerId, managed.profileIds);
      this.clearRecoveryTimers(sourceServerId);
      this.reconnectInputs.set(sourceServerId, {
        profile: effectiveProfile,
        target,
        // 操作级 onLog 捕获本次日志及凭据；恢复不得持有旧闭包，下一次操作会重新建日志上下文。
        context: {},
      });
      this.setState(effectiveProfile.profileId, {
        state: "online",
        sourceServerId,
        ...compatibilityState,
      });
      if (isRepublish) this.reconnectEmitter.fire(managed);
      return managed;
    } catch (error) {
      if (
        error instanceof SourceServerUpgradeRequiredError &&
        !signal?.aborted &&
        !explicitDisconnectSignal?.aborted
      ) {
        await options.onAuthenticatedUpgradeRequired?.();
      }
      if (explicitDisconnectSignal?.aborted) {
        throw explicitDisconnectSignal.reason;
      }
      if (
        error instanceof SourceServerInstallRequiredError ||
        error instanceof SourceServerUpgradeRequiredError ||
        error instanceof SourceServerIdentityChangePendingError
      )
        throw error;
      const normalized = normalizeRemoteConnectionError(error);
      const errorCode = isPublicZCodeErrorCode(normalized.code) ? normalized.code : undefined;
      const retryable =
        error && typeof error === "object" && "retryable" in error
          ? (error as { retryable?: unknown }).retryable
          : undefined;
      this.setState(profile.profileId, {
        state: "failed",
        error: normalized.message,
        ...(errorCode ? { errorCode } : {}),
        ...(typeof retryable === "boolean" ? { retryable } : {}),
      });
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancelTargetTransport);
      explicitDisconnectSignal?.removeEventListener("abort", cancelTargetTransport);
      // Bug 原因：分支内释放遗漏了握手落盘拒绝和兼容版本解析异常，恢复重试会累积连接。
      // 握手、目录写入、身份确认、成员提交共用这一个未发布资源出口；在线表接管前始终由本次
      // 尝试持有连接，统一释放并忽略其关闭事件，避免影响后继 owner。
      if (unpublishedConnection) {
        ignoreConnectionClose = true;
        unpublishedConnection.dispose();
      }
    }
  }

  private getAdapter(kind: "ssh" | "wsl" | "docker"): SourceServerTransportAdapter {
    let adapter = this.adapters.get(kind);
    if (!adapter) {
      adapter = this.createAdapter(kind);
      this.adapters.set(kind, adapter);
    }
    return adapter;
  }

  // 意外断线处理：先确认 close 属于当前 online owner（旧代际的迟到 close 一律忽略），
  // 若同一 Source 有更新在途则转交 invalidateOnlineConnectionForUpdate（避免与更新竞争），
  // 否则摘 owner、dispose 连接与项目订阅、把该 Source 的 profile 全部置 retrying 并排首次重试。
  // 为什么先摘 owner 再 dispose：重复 close 回调会因 owner 已不存在而幂等返回。
  private handleUnexpectedClose(
    sourceServerId: string,
    reason: string,
    connection: ServerRemoteConnection,
  ): void {
    const online = this.onlineBySourceServerId.get(sourceServerId);
    // 只处理属于当前 online owner 的关闭；已被替换或从未发布的连接迟到的 close 不得拆掉后继者。
    if (!online || online.connection !== connection) return;
    if ([...this.updateFlights].some((flight) => flight.sourceServerId === sourceServerId)) {
      this.invalidateOnlineConnectionForUpdate(sourceServerId, online);
      return;
    }
    this.onlineBySourceServerId.delete(sourceServerId);
    // Bug 原因：意外断线后旧 RPC generation 只从在线表移除，却没有显式释放 protocol/socket；
    // 多次重连会让旧 generation 的 pending 状态依赖 GC。先摘 owner 再 dispose，重复 close 回调会
    // 因 online 表已无该 Source 而幂等返回。
    online.projectSubscription?.dispose();
    online.connection.dispose();
    for (const profileId of online.profileIds) {
      this.setState(profileId, {
        state: "retrying",
        sourceServerId,
        ...(reason ? { error: reason } : {}),
        recoveryAttempt: 1,
        recoveryLimit: ONLINE_RETRY_DELAYS_MS.length,
      });
    }
    this.scheduleOnlineRetry(sourceServerId, 0);
  }

  // 更新流程专用失效：先摘物理 owner、把 profile 置 updating、fire update 失效事件，
  // 再释放连接。顺序保证 Registry 在收到事件时仍能看到「旧代际已不可用」，从而 fail-closed
  // 并清掉指向旧 services 的 logical workspace（见下方 Bug 注释）。
  private invalidateOnlineConnectionForUpdate(
    sourceServerId: string,
    online: OnlineConnection,
  ): void {
    if (this.onlineBySourceServerId.get(sourceServerId) !== online) return;
    // Bug 原因：显式更新过去只替换 Manager 内的物理连接，没有先失效仍指向旧 services 的
    // logical workspace；更新成功后 UI 会看到 online，但 scoped RPC 仍命中已关闭 generation。
    // 先摘物理 owner 并发布一次 Source 级失效，再释放连接，Registry 才能 fail-closed 后换代。
    this.onlineBySourceServerId.delete(sourceServerId);
    for (const profileId of online.profileIds) {
      this.setState(profileId, { state: "updating", sourceServerId });
    }
    this.connectionInvalidatedEmitter.fire({
      sourceServerId,
      reason: "update",
    });
    online.projectSubscription?.dispose();
    online.connection.dispose();
  }

  // 自动重连调度：2s/4s/8s 三次；attempt 越界即进入离线探测。
  // 每次先清旧 timer 再设新 timer，保证同一 Source 只有一个待触发重试；
  // 终态失败与显式断开会被 stopAutomaticRecoveryForTerminalFailure / abort 截断，不再续排。
  private scheduleOnlineRetry(sourceServerId: string, attempt: number): void {
    const input = this.reconnectInputs.get(sourceServerId);
    const delay = ONLINE_RETRY_DELAYS_MS[attempt];
    if (!input || delay === undefined) {
      this.enterOfflineProbe(sourceServerId);
      return;
    }
    const existing = this.retryTimers.get(sourceServerId);
    if (existing) clearTimeout(existing);
    for (const profileId of this.profileIdsForSource(sourceServerId, input.profile.profileId)) {
      this.setState(profileId, {
        state: "retrying",
        sourceServerId,
        recoveryAttempt: attempt + 1,
        recoveryLimit: ONLINE_RETRY_DELAYS_MS.length,
      });
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(sourceServerId);
      void this.connectForSource(
        {
          profile: input.profile,
          target: input.target,
          context: input.context,
        },
        sourceServerId,
      ).catch((error) => {
        if (
          error instanceof SourceServerExplicitDisconnectError ||
          error instanceof SourceServerProfileRemovedError ||
          this.stopAutomaticRecoveryForTerminalFailure(sourceServerId, error)
        ) {
          return;
        }
        if (attempt + 1 < ONLINE_RETRY_DELAYS_MS.length) {
          this.scheduleOnlineRetry(sourceServerId, attempt + 1);
        } else {
          this.enterOfflineProbe(sourceServerId, error);
        }
      });
    }, delay);
    this.retryTimers.set(sourceServerId, timer);
  }

  // 恢复预算耗尽后的慢速探测：先发布 offline + recoveryBudgetExhausted（仍 retryable），
  // 再每 2 分钟尝试一次；探测失败继续安排下一次，终态/显式断开则彻底停止。
  // 错误码口径：优先透出可公开的远端 code，否则统一为 REMOTE_RECOVERY_BUDGET_EXHAUSTED。
  private enterOfflineProbe(sourceServerId: string, error?: unknown): void {
    const input = this.reconnectInputs.get(sourceServerId);
    if (!input) return;
    const normalized = error === undefined ? undefined : normalizeRemoteConnectionError(error);
    if (normalized) {
      // Bug 原因：预算耗尽后的最终 cause 只留在 state.error，而 UI 按合同不展示裸 Host
      // 原文，导致诊断信息无稳定出口。终态每轮只记一条 warn，不按探测心跳刷盘。
      this.options.logWarn?.(
        `[source-server] recovery budget exhausted source=${sourceServerId}`,
        error instanceof Error ? error : new Error(normalized.message),
      );
    }
    const errorCode =
      normalized?.code &&
      normalized.code !== "remote-connection-unknown" &&
      isPublicZCodeErrorCode(normalized.code)
        ? normalized.code
        : REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE;
    for (const profileId of this.profileIdsForSource(sourceServerId, input.profile.profileId)) {
      this.setState(profileId, {
        state: "offline",
        sourceServerId,
        recoveryAttempt: ONLINE_RETRY_DELAYS_MS.length,
        recoveryLimit: ONLINE_RETRY_DELAYS_MS.length,
        recoveryBudgetExhausted: true,
        retryable: true,
        ...(normalized ? { error: normalized.message } : {}),
        ...(errorCode ? { errorCode } : {}),
      });
    }
    const existing = this.offlineProbeTimers.get(sourceServerId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.offlineProbeTimers.delete(sourceServerId);
      void this.connectForSource(
        {
          profile: input.profile,
          target: input.target,
          context: input.context,
        },
        sourceServerId,
      ).catch((error) => {
        if (
          error instanceof SourceServerExplicitDisconnectError ||
          error instanceof SourceServerProfileRemovedError ||
          this.stopAutomaticRecoveryForTerminalFailure(sourceServerId, error)
        ) {
          return;
        }
        this.enterOfflineProbe(sourceServerId, error);
      });
    }, OFFLINE_PROBE_INTERVAL_MS);
    this.offlineProbeTimers.set(sourceServerId, timer);
  }

  // 判断本次失败是否必须停止自动恢复：retryable=false、三类用户动作码（安装/升级/身份确认）、
  // 或 owner 已进入自动恢复终态都算终态。返回 true 表示调用方不要再排后续 timer。
  // 终态落地口径：owner 置 failed（retryable=false），同 Source 的 sibling profile 置 offline，
  // 防止聚合状态继续显示「连接中」而 logical wrapper 收不到终态（见 Bug 注释）。
  private stopAutomaticRecoveryForTerminalFailure(sourceServerId: string, error: unknown): boolean {
    const input = this.reconnectInputs.get(sourceServerId);
    const ownerState = input ? this.states.get(input.profile.profileId) : undefined;
    const normalized = normalizeRemoteConnectionError(error);
    if (
      readErrorRetryable(error) !== false &&
      !isAutomaticRecoveryUserActionCode(normalized.code) &&
      !isSourceServerAutomaticRecoveryTerminalState(ownerState)
    ) {
      return false;
    }
    // Bug 原因：旧恢复调度只识别 UpgradeRequired，其他用户动作和 retryable:false
    // 会被下一次 retry/offline probe 覆盖。终态必须在创建后续 timer 前截断自动路径。
    this.clearRecoveryTimers(sourceServerId);
    if (input && !isSourceServerAutomaticRecoveryTerminalState(ownerState)) {
      this.setState(input.profile.profileId, {
        state: "failed",
        sourceServerId,
        ...this.compatibilityByProfileId.get(input.profile.profileId),
        error: normalized.message,
        ...(isPublicZCodeErrorCode(normalized.code) ? { errorCode: normalized.code } : {}),
        retryable: false,
      });
    }
    if (input) {
      for (const profileId of this.profileIdsForSource(sourceServerId, input.profile.profileId)) {
        if (profileId === input.profile.profileId) continue;
        // Bug 原因：Source 级恢复停止后，sibling Profile 若遗留 retrying，聚合状态仍会显示
        // 连接中且其 logical wrapper 不会收到终态。只有真实 owner 保留可操作 pending 状态。
        this.setState(profileId, {
          state: "offline",
          sourceServerId,
          error: normalized.message,
          ...(isPublicZCodeErrorCode(normalized.code) ? { errorCode: normalized.code } : {}),
          retryable: false,
        });
      }
    }
    return true;
  }

  private profileIdsForSource(sourceServerId: string, fallbackProfileId: string): string[] {
    const remembered = this.profileIdsBySourceServerId.get(sourceServerId);
    return remembered && remembered.size > 0 ? [...remembered] : [fallbackProfileId];
  }

  private rememberSourceProfiles(sourceServerId: string, profileIds: Iterable<string>): void {
    const remembered = this.profileIdsBySourceServerId.get(sourceServerId) ?? new Set<string>();
    for (const profileId of profileIds) remembered.add(profileId);
    this.profileIdsBySourceServerId.set(sourceServerId, remembered);
  }

  private clearRecoveryTimers(sourceServerId: string): void {
    const retryTimer = this.retryTimers.get(sourceServerId);
    if (retryTimer) clearTimeout(retryTimer);
    this.retryTimers.delete(sourceServerId);
    const probeTimer = this.offlineProbeTimers.get(sourceServerId);
    if (probeTimer) clearTimeout(probeTimer);
    this.offlineProbeTimers.delete(sourceServerId);
  }

  // 唯一的写状态入口：合并 patch + 继承版本兼容字段 + 记录 updatedAt，再发布事件。
  // 兼容字段只在 retrying/offline/updating 时继承（这些状态不产生新的兼容事实），避免 UI
  // 在状态跃迁时丢失当前/可用/最低版本；online/failed 的 patch 自带最新兼容事实。
  // 副作用：离开 online 时异步写回「最近在线时刻」（失败只 warn，不阻塞状态发布）。
  private setState(
    profileId: string,
    patch: Omit<SourceServerConnectionStateSnapshot, "profileId" | "updatedAt">,
  ): void {
    const previous = this.states.get(profileId);
    const inheritedCompatibility =
      patch.state === "retrying" || patch.state === "offline" || patch.state === "updating"
        ? (this.compatibilityByProfileId.get(profileId) ??
          (previous ? preserveCompatibilityState(previous) : {}))
        : {};
    const snapshot: SourceServerConnectionStateSnapshot = {
      profileId,
      // 恢复/离线/更新是连接生命周期状态，不会产生新的版本兼容事实；保留最后一次
      // Host 握手判定，避免 UI 在状态跃迁时丢失当前/可用/最低版本字段。
      ...inheritedCompatibility,
      ...patch,
      updatedAt: this.now(),
    };
    if (snapshot.currentVersion || snapshot.updateAvailability) {
      this.compatibilityByProfileId.set(profileId, preserveCompatibilityState(snapshot));
    }
    this.states.set(profileId, snapshot);
    if (previous?.state === "online" && snapshot.state !== "online" && previous.sourceServerId) {
      // 最近在线是最后在线时刻，不是握手开始时间；失败重试不能把离线设备伪装成刚在线。
      void this.options.directory
        .recordLastOnline?.(previous.sourceServerId, snapshot.updatedAt)
        .catch((error: unknown) =>
          this.options.logWarn?.(
            "Failed to persist Source Server last online time",
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
    }
    this.stateEmitter.fire(snapshot);
  }
}
