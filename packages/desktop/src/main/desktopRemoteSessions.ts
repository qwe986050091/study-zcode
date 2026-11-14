import { sanitizeRemoteConnectionLog, remoteConnectionFailureLogLevel } from "@zcode/shared";
/* eslint-disable max-lines -- Main 的完整薄转发契约集中维护请求与端口关联。 */
import { randomUUID } from "node:crypto";
import { BrowserWindow, MessageChannelMain } from "electron";
import type { MessagePortMain, UtilityProcess as ElectronUtilityProcess } from "electron";
import {
  buildRemoteWorkspaceIdentity,
  buildRemoteEnvironmentKey,
  buildSshRemoteHostKey,
  buildServerRemoteWorkspaceIdentity,
  HostMessageTypes,
  HostResponseTypes,
  hostResponseMessageSchema,
  InternalChannels,
  PlatformChannels,
  REMOTE_BIND_CANCELED_ERROR_CODE,
  resolveWorkspaceKey,
  scopedServicePortPayloadSchema,
  type BindRemoteWorkspaceSessionContextResult,
  type RemoteTarget,
  type ProviderProvisioningTrigger,
  type WindowHostRemoteWorkspaceDescriptor,
  type WorkspacePurpose,
  type WebRemoteControlFailure,
  type HostPreparedProjectWorkspace,
  type HostProjectWorkspaceNavigationInput,
} from "@zcode/shared";
import type {
  RemoteConnectionStats,
  RemoteDisconnectReason,
  RemoteGaugeTransition,
} from "./desktopRemoteUsageArmsTelemetry.js";
import type { RemoteAssetDirs } from "./desktopRuntimeEnv.js";
import { ProviderProvisioningEnvironmentCoordinator } from "./providerProvisioningEnvironmentCoordinator.js";

// ============================================================================
// desktopRemoteSessions —— 远程 workspace 会话注册表（Main 进程，L1 深度注释）
// 本模块是 Main 侧唯一登记处：Host 负责真实连接，Main 只保留 sessionId -> route 的薄映射，端口转发、窗口归属校验、生命周期回收与遥测都必须查这张表。
// 事件全部来自 window Host 的 IPC，必须按 (webContentsId, requestId) 精确归属；
// 下方 INV 表给出跨函数不变量，正文以 INV-k 引用。
//
// INV-1: routesBySessionId 是 Main 侧唯一权威注册表，键为 Host logical remoteSessionId ——
//        破坏后果：同一会话出现两份 route，端口与关闭事件各投一半，用户看到"已连接但打不开"。
// INV-2: route.webContentsId 是所有权边界，所有 Host 事件必须校验 —— 破坏后果：窗口 A 的
//        Host 消息改写窗口 B 的 route，attachment 被投递到错误 renderer。
// INV-3: attachmentState 单向 attachable→closed，closed 不可复活 —— 破坏后果：复用已关闭
//        route 会 attach 到 Host 已释放的 scope，端口立即失效且无法自愈。
// INV-4: pendingRendererAttachment 是单槽，新候选必须先 supersede 旧候选 —— 破坏后果：
//        旧候选的 timeout 到期会回收刚提升的健康 attachment。
// INV-5: confirmRendererAttachmentReady 必须同时匹配 sessionId+attachmentId+webContentsId ——
//        破坏后果：迟到 ACK 提升过期候选，真实 port 成为无人关闭的孤儿。
// INV-6: handleConnected 必须精确匹配 (webContentsId, requestId) 的 pending —— 破坏后果：
//        无主连接不会被 resolve，Host 侧 session 永久泄漏直到进程退出。
// INV-7: 同 sessionId 的并发 connect 只能等待同一 route ready，不得覆盖注册表 —— 破坏后果：
//        旧 candidate 的 ACK 被判 stale，遗留 timer 最终回收健康 attachment。
// INV-8: mobileOnly 路由在桌面 join 前不建 renderer attachment，提升时重置 connectFinalized ——
//        破坏后果：手机 scope 被当作桌面连接上报，统计与 tab 行为同时出错。
// INV-9: 同一 attachment 代际内 connectFinalized 只允许 false→true 一次 —— 破坏后果：重复上报 connected，
// connectFinalized 再次置真会重复上报 connected，使远端统计翻倍且断连时长计算失真。
// INV-10: 建连失败必须三件事同做：dispose registration、删 route、通知 Host dispose ——
//         破坏后果：留下半注册 route，后续同 sessionId 的 join 命中不可用对象。
// INV-11: providerProvisioningDispose 与 route 同生命周期 —— 破坏后果：Environment lane
//         持有已释放 session 的回调，重连后配置被下发到旧 session。
// INV-12: 重连换代必须先删旧键再写新键 —— 破坏后果：两个 sessionId 指向同一 route，
//         旧键的 closed 事件会把新会话标成 closed。
// INV-13: workspaceContextBindFlightsBySessionId 以 sessionId 去重，contextKey 不同必须拒绝 ——
//         破坏后果：同一会话并发绑定两个 workspace，generation 互相覆盖。
// INV-14: bind 期间不更新 descriptor，ACK 后才写 generation+1 —— 破坏后果：attach 使用旧
//         generation，Host 拒绝新 scope 且 renderer 永久 pending。
// INV-15: 所有 pending Map 在 Host exit/窗口关闭/应用退出时必须 reject 并 delete ——
//         破坏后果：Promise 永久挂起，renderer 按钮永远转圈且无法重试。
// INV-16: Host exit 清理必须按 child 身份过滤 —— 破坏后果：窗口重建后同名 key 的新 pending
//         被旧 Host 的 exit 事件误杀。
// INV-17: 事件转发顺序固定为 日志/状态 → resolve，不得先 resolve —— 破坏后果：renderer
//         先收到成功再收到失败日志，UI 先跳成功态再回滚。
// INV-18: detachServicePort 与 closeMessagePort 必须幂等并吞掉异常 —— 破坏后果：Host 已退出
//         时清理抛错，中断后续 route 回收。
// INV-19: attachRemoteWorkspaceSessionHost 是不经 pending 的同步旁路，必须全量校验 ——
//         破坏后果：web-remote 拿到不属于本窗口的 port 或已离线的会话。
// INV-20: appShutdownStarted 一旦置位不可回退 —— 破坏后果：退出中新建 Host session，
//         未释放的子进程拖住进程退出。
//
// 标记说明（必须与 INV 编号配合阅读）：[并发] 竞态/去重；[事务] 要么全做要么全不做；[资源] 句柄/端口释放；[失败路径] 失败后的状态收敛；[权衡] 有意为之的取舍。
interface RemoteWorkspaceSessionContext {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

// 连接上下文只带"用户想打开哪个 workspace"，不带 sessionId：
// sessionId 由 Host 在连接成功时下发，Main 不能预先假定，否则 join 复用逻辑会错配。
interface RemoteWorkspaceConnectContext {
  workspacePath?: string;
  workspaceIdentity?: string;
  confirmSourceServerInstall?: boolean;
}

// 一次 connect 的等待槽：resolve/reject 必须由 Host 的 connected/failed 事件消费，
// 其余任何路径（窗口关闭、Host 退出）只能 reject，不能静默丢弃。
// win 持有强引用是有意的：连接 pending 期间窗口不能被 GC，否则日志与回执无处投递。
interface PendingConnect {
  requestId: string;
  webContentsId: number;
  win: BrowserWindow;
  remoteUsageTelemetryEligible: boolean;
  resolve: (sessionId: string) => void;
  onConnected?: (descriptor: WindowHostRemoteWorkspaceDescriptor) => void;
  reject: (error: Error) => void;
}

// bind 的等待槽额外持有 timeout 句柄：超时后必须主动发 Cancel，
// 否则 Host 会继续推进绑定，Main 却在本地已 reject，两侧 generation 永久分叉。
interface PendingWorkspaceBind {
  resolve: (previousWorkspaceIdentity?: string) => void;
  reject: (error: Error & { code?: string; retryable?: boolean }) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// contextKey 记录"这次飞行绑定的是哪个 workspace"：并发调用只有 key 完全一致
// 才能共享 Promise，否则必须拒绝，避免两次 bind 互相推进 generation。
interface WorkspaceContextBindFlight {
  contextKey: string;
  promise: Promise<BindRemoteWorkspaceSessionContextResult>;
}

// RemoteAttachmentRoute 只描述"Main 侧需要的事实"：谁拥有、是否可 attach、当前 attachment 是谁，字段增减必须同步这三个判断。
// abstract 的 connectedAtMonotonicMs 用单调时钟而非墙钟，避免系统时间被调整后统计出负的连接时长。
// connectFinalized 是遥测去重键，不是 UI 状态：UI 以 rendererAttachmentId 为准确认可用。
// remoteUsageTelemetryEligible 只在真实用户连接时为 true，Source 自动恢复等内部路径不计数。
// pendingRendererAttachment 与 rendererAttachmentId 互斥：前者等待 ACK，后者已可用。
interface RemoteAttachmentRoute {
  /** 手机创建的目录 scope 不自动建立桌面 tab；桌面显式 join 后才提升。 */
  mobileOnly?: boolean;
  providerProvisioningReady?: Promise<void>;
  webContentsId: number;
  // Main 只保留端口转发所需的 request/session 关联和脱敏 descriptor；连接/任务事实归 Host。
  descriptor: WindowHostRemoteWorkspaceDescriptor;
  rendererAttachmentId?: string;
  pendingRendererAttachment?: {
    attachmentId: string;
    previousAttachmentId?: string;
    reason: string;
    ready: () => Promise<void>;
    timeout: NodeJS.Timeout;
    resolve: () => void;
    reject: (error: Error) => void;
  };
  attachmentState: "attachable" | "closed";
  connectedAtMonotonicMs: number;
  connectFinalized: boolean;
  remoteUsageTelemetryEligible: boolean;
  providerProvisioningDispose?: () => void;
}

// 每次 Provider Provisioning 执行都单独记账：Host 只回 requestId，
// 必须靠这张表把结果对回发起它的 child 与 trigger，
// 否则同一 Environment 的并发执行会互相 wake 错误的 Promise。
interface PendingProviderProvisioningExecution {
  readonly child: ElectronUtilityProcess;
  readonly trigger: ProviderProvisioningTrigger;
  readonly startedAtMonotonicMs: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

// [权衡] server 目标用 URL 归一化比较，而不是字符串全等：同一台远端服务器可能
// 以 ws:// 与 http://、带/不带尾斜杠、带/不带 /ws 后缀等形式出现，全等比较会把它判成不同目标，导致重复建连与注册表冲突。
function normalizeServerRemoteUrlForComparison(url: string): string {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol === "ws:") parsed.protocol = "http:";
    if (parsed.protocol === "wss:") parsed.protocol = "https:";
    parsed.hash = "";
    parsed.search = "";
    const normalizedPath = parsed.pathname.replace(/\/+$/g, "");
    parsed.pathname = normalizedPath.endsWith("/ws")
      ? normalizedPath.slice(0, -"/ws".length) || "/"
      : normalizedPath || "/";
    return parsed.toString().replace(/\/$/g, "");
  } catch {
    return url.trim().replace(/\/+$/g, "");
  }
}

// [事务] 目标相等性是"能否复用 session"的唯一判据：比较必须覆盖所有会影响
// 连接结果的字段。漏掉 port 会把 22 与 2222 当成同一目标；漏掉 privateKeyPath
// 会让两个不同凭据的连接互相复用，最终用错身份登录。
function isSameRemoteTarget(left: RemoteTarget, right: RemoteTarget): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "ssh":
      return (
        right.kind === "ssh" &&
        left.host.trim().toLowerCase() === right.host.trim().toLowerCase() &&
        (left.port ?? 22) === (right.port ?? 22) &&
        left.username.trim() === right.username.trim() &&
        (left.privateKeyPath ?? "") === (right.privateKeyPath ?? "")
      );
    case "wsl":
      return (
        right.kind === "wsl" &&
        (left.distro?.trim() || "default") === (right.distro?.trim() || "default") &&
        (left.user?.trim() ?? "") === (right.user?.trim() ?? "")
      );
    case "docker":
      return right.kind === "docker" && left.container === right.container;
    case "server":
      return (
        right.kind === "server" &&
        normalizeServerRemoteUrlForComparison(left.url) ===
          normalizeServerRemoteUrlForComparison(right.url)
      );
  }
}

// 遥测 key 必须与 isSameRemoteTarget 的等价关系一致：若两处判等口径不同，
// activeTargetCount 会把同一台机器算成两个目标，或用同一 key 合并两个真实目标。
function buildRemoteTargetTelemetryKey(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${buildSshRemoteHostKey(target)}`;
    case "wsl":
      return `wsl:${target.distro?.trim() || "default"}\0${target.user?.trim() ?? ""}`;
    case "docker":
      return `docker:${target.container}`;
    case "server":
      return `server:${normalizeServerRemoteUrlForComparison(target.url)}`;
  }
}

// [资源] close 在端口已被对端关闭、或 transfer 后已不可用时仍可能抛错；
// 这里吞掉异常是因为调用点都在清理路径上，一次 close 失败不应中断
// 后续 attachment/route 的回收。
function closeMessagePort(port: MessagePortMain | undefined): void {
  if (!port) return;
  try {
    port.close();
  } catch {
    // MessagePort 关闭失败不影响 Host 内 attachment 的 close/dispose 幂等收口。
  }
}

// 工厂而不是单例：每个 Main 生命周期创建一个 manager，闭包内的 Map 即注册表；
// 依赖全部由参数注入，便于测试替换时钟、消息通道与 Host 进程表。
// windowHostProcessMap 按 webContentsId 索引：窗口重建后旧 child 会被替换，
// 因此任何需要"当前 Host"的路径都必须现查，不能缓存 child 引用。
export function createRemoteWorkspaceSessionManager(options: {
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  windowHostProcessMap: Map<number, ElectronUtilityProcess>;
  resolveRemoteAssetDirs: () => RemoteAssetDirs;
  resolveWslTarget?: (
    target: Extract<RemoteTarget, { kind: "wsl" }>,
  ) => Promise<Extract<RemoteTarget, { kind: "wsl" }>>;
  createMessageChannel?: () => {
    port1: MessagePortMain;
    port2: MessagePortMain;
  };
  rendererAttachmentReadyTimeoutMs?: number;
  workspaceBindReadyTimeoutMs?: number;
  reportRemoteConnectionStateChanged?: (params: {
    rendererId: number;
    remoteKind: RemoteTarget["kind"];
    transition: Exclude<RemoteGaugeTransition, "none">;
  }) => void;
  reportRemoteDisconnect?: (params: {
    rendererId: number;
    remoteKind: RemoteTarget["kind"];
    disconnectReason: RemoteDisconnectReason;
    durationMs: number;
  }) => void;
  monotonicNowMs?: () => number;
  webRemoteControlManagerRef: {
    current: {
      failRemoteSession(sessionId: string, reason: string, failure: WebRemoteControlFailure): void;
      replaceRemoteSession?(event: {
        previousSessionId: string;
        sessionId: string;
        workspacePath: string;
        workspaceIdentity: string;
      }): Promise<void>;
    } | null;
  };
  providerProvisioningCoordinator?: ProviderProvisioningEnvironmentCoordinator;
}) {
  // key 是 webContentsId + requestId：requestId 由 renderer 生成并可能重复使用，
  // 只按 requestId 索引会让两个窗口的并发连接互相覆盖，回执投错窗口。
  const pendingByRequestKey = new Map<string, PendingConnect>();
  // 项目导航与远程连接分开记账：两者的失败语义不同（导航可安全重试，
  // 连接可能已在 Host 侧建立），混用会让取消逻辑误伤另一类请求。
  const pendingProjectNavigations = new Map<
    string,
    {
      child: ElectronUtilityProcess;
      win: BrowserWindow;
      requestId: string;
      resolve(value: HostPreparedProjectWorkspace): void;
      reject(error: Error): void;
    }
  >();
  // bind 的 key 同样带 webContentsId：sessionId 全局唯一，但 requestId 不是，只按 requestId 会让不同窗口的 bind ACK 互相消费。
  const pendingWorkspaceBindsByRequestKey = new Map<string, PendingWorkspaceBind>();
  // 飞行绑定表按 sessionId 索引而不是 context：同一会话同一时刻只允许一次
  // descriptor 迁移，用 contextKey 做二次校验而不是主键。
  const workspaceContextBindFlightsBySessionId = new Map<string, WorkspaceContextBindFlight>();
  // 注册表本身不持久化：进程重启后所有 host session 都已消失，
  // 任何残留都会被后续 join 当作"已有 route"而拒绝新连接。
  const routesBySessionId = new Map<string, RemoteAttachmentRoute>();
  // WeakSet 记录已挂过监听器的 child：窗口重建会创建新 child，
  // 用 WeakSet 而不是 Set 可以让旧 child 随引用消失自动释放，不会泄漏进程对象。
  const listenedHosts = new WeakSet<ElectronUtilityProcess>();
  const workspaceBindReadyTimeoutMs = options.workspaceBindReadyTimeoutMs ?? 30_000;
  const pendingProviderProvisioningExecutions = new Map<
    string,
    PendingProviderProvisioningExecution
  >();
  const providerProvisioningCoordinator =
    options.providerProvisioningCoordinator ?? new ProviderProvisioningEnvironmentCoordinator();
  let appShutdownStarted = false;
  const monotonicNowMs = options.monotonicNowMs ?? (() => performance.now());

  // key 必须同时编码窗口与请求：requestId 由 renderer 生成，跨窗口没有唯一性保证，
  // 只用 requestId 会让两个窗口的并发连接命中同一个 pending。
  // 分隔符用 \0 而不是 ":"：requestId 可能包含任意可打印字符，
  // 用冒号会出现 (1,"2:3") 与 (1:2,"3") 拼接后相同的碰撞。
  function requestKey(webContentsId: number, requestId: string): string {
    return `${webContentsId}\0${requestId}`;
  }

  // 任何"当前 Host"都必须现查：窗口 reload 会重建 utility process，
  // 缓存的 child 可能已经 exit，往它 postMessage 会抛错或静默丢失。
  // pid == null 视为不可用：Electron 在 child 退出后仍保留对象，只靠引用无法判断存活。
  // 首次取用时才挂监听器，保证监听器的 webContentsId 与当前窗口一致，
  // 避免旧窗口的 Host 事件被新窗口消费。
  // 查不到时抛错而不是返回 undefined：调用方都在"必须能发消息"的路径上，
  // 静默降级会让上层误以为连接成功。
  function getWindowHost(win: BrowserWindow): ElectronUtilityProcess {
    const child = options.windowHostProcessMap.get(win.webContents.id);
    if (!child || child.pid == null) {
      throw new Error(`未找到窗口 Local Host，windowId=${win.webContents.id}`);
    }
    ensureHostListener(child, win.webContents.id);
    return child;
  }

  // 允许注入是为了测试与 web-remote 复用同一条通道工厂；
  // 生产环境没有注入时退回 Electron 原生 MessageChannelMain，
  // 保证 port 能跨进程 transfer。
  function createMessageChannel() {
    return options.createMessageChannel?.() ?? new MessageChannelMain();
  }

  // emitConnectionLog 是"旁路"，不允许影响主流程：所有发送都必须经过 destroyed 检查，
  // 窗口在检查与 send 之间仍可能关闭，因此调用方不应依赖它一定送达。
  // message 统一过 sanitizeRemoteConnectionLog：Host 输出可能包含远端路径、
  // 凭据片段或控制字符，直接进 renderer 既会污染日志 UI 也可能泄露信息。
  // timestamp 固定为紧凑时钟：这是 renderer 日志列的展示契约，
  // 改成 ISO 会挤压 flex 布局并换行（见下方 Bugfix 注释）。
  function emitConnectionLog(
    win: BrowserWindow,
    payload: {
      requestId?: string;
      sessionId?: string;
      level: "info" | "warn" | "error";
      message: string;
    },
  ): void {
    // 这里提前返回而不是发送空日志：把"窗口已关"表达成一条错误，
    // 会让连接日志在窗口销毁瞬间多出一条无意义记录。
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(PlatformChannels.RemoteConnectionLog, {
      label: `window-host-${win.webContents.id}`,
      requestId: payload.requestId,
      sessionId: payload.sessionId,
      level: payload.level,
      source: "window-host-controller",
      message: sanitizeRemoteConnectionLog(payload.message),
      // Bugfix: R1 改造曾把完整 ISO 时间直接交给连接日志 UI，长时间戳会挤压 flex 日志列并换行。
      // 这里恢复既有的紧凑时钟展示契约，Host 的 requestId 路由和原始日志内容保持不变。
      timestamp: new Date().toLocaleTimeString(undefined, {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
    });
  }

  // [资源] Detach 是"通知 Host 丢弃这个 attachment"，不是关闭 port 本身：
  // port 的关闭由 closeMessagePort 负责，两者失败互不阻塞。
  // 吞异常的理由：调用点几乎都在清理/换代路径上，Host 已退出时 postMessage
  // 必然失败，若向上抛会中断 route 回收，留下注册表里的僵尸条目。
  // reason 只进日志：它用于区分 superseded/ready-timeout/delivery-failed 等场景，
  // 不参与 Host 侧决策，避免把 Main 的内部状态变成协议。
  function detachServicePort(
    child: ElectronUtilityProcess,
    attachmentId: string,
    reason: string,
  ): void {
    try {
      child.postMessage({
        type: HostMessageTypes.DetachServicePort,
        attachmentId,
      });
    } catch (error) {
      // 候选 port 的回收属于幂等清理，不能因 Host 已退出导致 ready promise 再次悬空。
      options.logger.warn("[window-host-remote] detach renderer attachment failed", {
        attachmentId,
        reason,
        error,
      });
    }
  }

  // 这是 renderer 拿到 scoped port 的唯一入口：成功返回时只代表"port 已投递"，
  // 不代表 renderer 已注册——后者由 confirmRendererAttachmentReady 确认。
  // 因此调用方必须等待 confirm 才能认为 attachment 可用，
  // 否则会在 renderer 尚未持有 port 时就把 route 标记为已连接。
  async function attachRendererPort(
    win: BrowserWindow,
    route: RemoteAttachmentRoute,
    reason: string,
  ): Promise<void> {
    // 窗口销毁后仍可能收到迟到的 Host 消息，这里主动抛错让上层走失败收敛，
    // 而不是创建一对永远没有接收方的 port。
    // 抛错而不是 return：调用方依赖 Promise reject 清理 route，
    // 静默返回会让"已连接"的回执发往一个不存在的窗口。
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error("窗口已关闭，无法 attachment 远程 workspace");
    }
    // 双重校验：注册表里仍是同一个 route 对象（防止重连换代后旧 route 被 attach），
    // 且状态仍为 attachable（防止 closed route 被复用）。
    // 只比较 sessionId 不够——重连可能产生新对象但复用同一 id。
    // 这里故意抛错而不是返回 false：调用方都在 Promise 链上，
    // 失败必须冒泡到统一的 route 回收逻辑。
    if (
      routesBySessionId.get(route.descriptor.remoteSessionId) !== route ||
      route.attachmentState !== "attachable"
    )
      throw new Error("远程 workspace scope 已失效，不能创建 attachment");
    const child = getWindowHost(win);
    const descriptor = route.descriptor;
    if (!descriptor.workspacePath || !descriptor.workspaceIdentity) {
      throw new Error(
        `远程 descriptor 缺少 workspace scope，sessionId=${descriptor.remoteSessionId}`,
      );
    }
    // attachmentId 每次 attach 都新生成，不复用 route.rendererAttachmentId：
    // Host 用 attachmentId 区分代际，复用会让旧 port 的迟到消息命中新 attachment。
    // 新的 attachmentId 也便于日志把一次换代的所有事件串起来。
    const attachmentId = randomUUID();
    const rendererPayload = scopedServicePortPayloadSchema.parse({
      attachmentId,
      sessionId: descriptor.remoteSessionId,
      target: descriptor.target,
      ...(descriptor.sourceServerId ? { sourceServerId: descriptor.sourceServerId } : {}),
      workspacePath: descriptor.workspacePath,
      workspaceIdentity: descriptor.workspaceIdentity,
      ...(descriptor.workspacePurpose ? { workspacePurpose: descriptor.workspacePurpose } : {}),
    });
    const { port1, port2 } = createMessageChannel();
    const previousAttachmentId = route.rendererAttachmentId;
    const superseded = route.pendingRendererAttachment;
    // [并发] 单槽被新候选占据时，旧候选必须被显式 reject 并通知 Host detach：
    // 否则它的 timeout 到期会按 attachmentId 命中并回收这个新候选。
    // 先清 route.pendingRendererAttachment 再 detach：detach 是同步 postMessage，
    // 若 Host 立刻回消息，看到旧槽仍在会误判为仍待确认。
    // reject 旧 Promise 而不是让它悬空：发起方可能在 await 它做后续 UI 更新。
    if (superseded) {
      clearTimeout(superseded.timeout);
      route.pendingRendererAttachment = undefined;
      detachServicePort(child, superseded.attachmentId, "superseded");
      superseded.reject(
        new Error(`renderer attachment 已被后续换代替代，sessionId=${descriptor.remoteSessionId}`),
      );
    }

    // 用 Promise 包住"投递 + 等待 ACK"：调用方只关心最终是否可用，
    // 不关心中间经历了 supersede 还是超时。
    // resolve/reject 只由三条路径消费：confirm、timeout、delivery catch，
    // 每条路径都会先清 pendingRendererAttachment，保证单次消费。
    const ready = new Promise<void>((resolve, reject) => {
      // [失败路径] 超时回调必须校验 attachmentId 仍是当前候选：期间可能已被
      // confirm 提升或被新候选 supersede，盲目 reject 会杀掉健康 attachment。
      // 校验通过后会按"清理三件套"处理：清槽、通知 Host detach、reject 等待方。
      // 不 close port 是有意的：port 已 transfer 给 renderer，Main 侧句柄
      // 在投递时就已失去所有权，强行 close 会影响 renderer。
      const timeout = setTimeout(() => {
        const pending = route.pendingRendererAttachment;
        if (!pending || pending.attachmentId !== attachmentId) return;
        route.pendingRendererAttachment = undefined;
        detachServicePort(child, attachmentId, "ready-timeout");
        const error = new Error(
          `renderer attachment ready 超时，sessionId=${descriptor.remoteSessionId}`,
        );
        options.logger.warn("[window-host-remote] renderer attachment ready timeout", {
          sessionId: descriptor.remoteSessionId,
          attachmentId,
          reason,
        });
        reject(error);
      }, options.rendererAttachmentReadyTimeoutMs ?? 15_000);
      // [资源] unref 让 pending 定时器不阻止进程退出：正常路径会 clearTimeout，
      // 但异常路径可能遗留，unref 是兜底。
      // 这不会让定时器失效，只是不参与事件循环保活。
      timeout.unref?.();
      route.pendingRendererAttachment = {
        attachmentId,
        previousAttachmentId,
        reason,
        ready: () => ready,
        timeout,
        resolve,
        reject,
      };

      // [事务] 两次投递必须都成功：Host 侧 AttachServicePort 与 renderer 侧
      // ScopedServicePort 是一对，任意一侧失败都会留下无主的另一半。
      // 先投 Host 再投 renderer：Host 需先建立 attachment 才能接受 renderer
      // 的首条消息，顺序反了会出现"port 已到但 Host 不认这个 attachment"。
      try {
        child.postMessage(
          {
            type: HostMessageTypes.AttachServicePort,
            requestId: randomUUID(),
            attachmentId,
            clientMode: "desktop-continuous",
            scope: {
              kind: "remote",
              ...(descriptor.sourceServerId ? { sourceServerId: descriptor.sourceServerId } : {}),
              remoteSessionId: descriptor.remoteSessionId,
              workspacePath: descriptor.workspacePath,
              workspaceIdentity: descriptor.workspaceIdentity,
            },
          },
          [port2],
        );
        win.webContents.postMessage(InternalChannels.ScopedServicePort, rendererPayload, [port1]);
      } catch (error) {
        // [资源] 投递失败必须把这一代彻底撤回：清定时器、清槽、通知 Host detach、
        // 关闭两个本地 port。少任何一步都会留下"看起来在等 ACK"的假象。
        // 两个 port 都要关：transfer 可能已经成功一半（Host 收到、renderer 失败）。
        clearTimeout(timeout);
        route.pendingRendererAttachment = undefined;
        detachServicePort(child, attachmentId, "delivery-failed");
        closeMessagePort(port1);
        closeMessagePort(port2);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return ready;
  }

  // 这是"等待 attachment 可用"的统一读取口：pending 优先于已确认 id，
  // 因为新版候选正在投递时，旧 id 虽然存在但即将被 supersede，等待新候选更符合调用方预期。
  // 两者都没有时 reject 而不是返回 resolved：调用方要立刻知道"现在没有可用 port"，
  // 否则会往一个不存在的 attachment 发消息，错误被掩盖到更晚的层。
  function waitForRendererAttachmentReady(route: RemoteAttachmentRoute): Promise<void> {
    if (route.pendingRendererAttachment) {
      return route.pendingRendererAttachment.ready();
    }
    if (route.rendererAttachmentId) {
      return Promise.resolve();
    }
    return Promise.reject(
      new Error(
        `远程 workspace route 尚无可用 renderer attachment，sessionId=${route.descriptor.remoteSessionId}`,
      ),
    );
  }

  // key 同时编码 workspaceIdentity 与 purpose：同一远端目录在不同用途下
  // 可能是两个独立 scope（例如源码目录与 worktree），只按路径比较会把它们合并。
  // 用 \0 分隔避免 identity 中本就含有分隔符导致的碰撞。
  function buildWorkspaceContextBindKey(params: {
    workspaceIdentity: string;
    workspacePurpose?: WorkspacePurpose;
  }): string {
    return `${params.workspaceIdentity}\0${params.workspacePurpose ?? ""}`;
  }

  // [并发] join 复用路径不能直接等 rendererAttachmentId：如果当前有一次 bind
  // 正在换 workspace，旧 attachment 即将失效，等它等于立刻踩空。
  // 因此优先等同一个 contextKey 的 bind flight，其次才退回 attachment ready。
  // contextKey 不同说明两个调用方要的是不同 workspace，不能共享 Promise，
  // 否则后来者会拿到前者绑定的目录。
  function waitForJoinedRouteReady(
    route: RemoteAttachmentRoute,
    descriptor: WindowHostRemoteWorkspaceDescriptor,
  ): Promise<void> {
    const bindFlight = workspaceContextBindFlightsBySessionId.get(descriptor.remoteSessionId);
    if (
      bindFlight &&
      descriptor.workspaceIdentity &&
      bindFlight.contextKey ===
        buildWorkspaceContextBindKey({
          workspaceIdentity: descriptor.workspaceIdentity,
          workspacePurpose: descriptor.workspacePurpose,
        })
    ) {
      return bindFlight.promise.then(() => undefined);
    }
    return waitForRendererAttachmentReady(route);
  }

  // renderer 的 ACK 是"port 真正可用"的唯一信号，因此这里承担 route 的代际提交：
  // 提交由它完成：提升 rendererAttachmentId、清理上一代 port、去重上报 connected、resolve 等待方。
  // 任何一步提前（例如投递成功就标记可用）都会让上层在 renderer 尚未注册时发消息。
  // 任何一步遗漏（例如忘记 detach 上一代）都会让 Host 保留一个永远不会关闭的端口。
  function confirmRendererAttachmentReady(
    webContentsId: number,
    payload: { sessionId: string; attachmentId: string },
  ): void {
    const route = routesBySessionId.get(payload.sessionId);
    const pending = route?.pendingRendererAttachment;
    // [并发] 四重校验缺一不可，任一不满足都会 return：route 存在、窗口匹配、存在待确认候选、attachmentId 匹配。
    // 少了窗口校验，窗口 A 的 ACK 能提升窗口 B 的候选；
    // 少了 attachmentId 校验，上一代迟到的 ACK 会把新候选直接标记为可用。
    if (
      !route ||
      route.webContentsId !== webContentsId ||
      !pending ||
      pending.attachmentId !== payload.attachmentId
    ) {
      options.logger.warn("[window-host-remote] ignore stale renderer attachment ready", {
        webContentsId,
        sessionId: payload.sessionId,
        attachmentId: payload.attachmentId,
      });
      return;
    }

    clearTimeout(pending.timeout);
    route.pendingRendererAttachment = undefined;
    const child = options.windowHostProcessMap.get(route.webContentsId);
    if (!child || child.pid == null) {
      pending.reject(new Error(`窗口 Local Host 已退出，sessionId=${payload.sessionId}`));
      return;
    }
    // 先提升新 id，再处理旧 id：新 id 一旦写入，后续事件就能命中这一代；
    // 旧 id 的 detach 即使失败也不会阻塞新 attachment 使用。
    // previousAttachmentId 只在这一刻有用，之后无需保留，否则会误清理更早的代际。
    route.rendererAttachmentId = pending.attachmentId;
    if (pending.previousAttachmentId) {
      // Host generation bind 会 fail-closed 立即失效 A；Main 仍需等 renderer 注册 B
      // 后再提升 route 并做幂等清理。reload 复挂没有 generation 换代，也因此不会提前拆掉可用旧 port。
      detachServicePort(child, pending.previousAttachmentId, "candidate-promoted");
    }
    options.logger.info(
      `[window-host-remote] renderer attachment ready, sessionId=${payload.sessionId}, reason=${pending.reason}`,
    );
    // [事务] connected 只上报一次：这里同时改标记与上报，避免"先上报后改标记"
    // 期间被重入导致双报。telemetryEligible 为 false 的内部恢复路径只置标记不计数，
    // 但仍要标记，否则后续桌面 join 会重复上报。
    if (!route.connectFinalized) {
      route.connectFinalized = true;
      if (route.remoteUsageTelemetryEligible) {
        reportRemoteRouteConnected(route);
      }
    }
    pending.resolve();
  }

  // [失败路径] 遥测上报是旁路：reporter 抛错只记录 warn，绝不能让它的异常
  // 冒泡到 confirm 路径，否则一次统计失败会把已建立的 attachment 标记为失败。
  function reportRemoteRouteConnected(route: RemoteAttachmentRoute): void {
    try {
      options.reportRemoteConnectionStateChanged?.({
        rendererId: route.webContentsId,
        remoteKind: route.descriptor.target.kind,
        transition: "connected",
      });
    } catch (error) {
      options.logger.warn("[remote-usage-arms] connected reporter failed", {
        error,
      });
    }
  }

  // handleConnected 是连接成功的唯一提交点，三条互斥分支都由它分派：无 pending、已有 route（join 复用）、新建 route。
  // 三条分支都必须消费 pending：resolve 或 reject，不能留下悬空 Promise。
  // [事务] 新建分支的顺序是"先写注册表、再登记 provisioning、最后 attach"：
  // 任何一步失败都要按 INV-10 三件事一起回滚。
  function handleConnected(
    child: ElectronUtilityProcess,
    webContentsId: number,
    requestId: string,
    descriptor: WindowHostRemoteWorkspaceDescriptor,
  ): void {
    const key = requestKey(webContentsId, requestId);
    // [失败路径] 没有 pending 说明这次连接不是 Main 发起的（例如 Host 主动 join
    // 了另一个窗口的会话，或 ACK 在窗口关闭后才到达）。此时必须让 Host 释放该 session，
    // 否则它会一直占用远端连接与本地 scope，直到整个 Host 退出。
    const pending = pendingByRequestKey.get(key);
    if (!pending) {
      child.postMessage({
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        requestId: randomUUID(),
        remoteSessionId: descriptor.remoteSessionId,
      });
      return;
    }
    pendingByRequestKey.delete(key);
    // 拿到 pending 后立刻删除：同一个 requestId 只允许被消费一次，
    // 否则 Host 重发 connected 会让第二个 pending 被错误 resolve。
    // existingRoute 代表 Host 复用了 logical sessionId，必须逐字段验证归属。
    const existingRoute = routesBySessionId.get(descriptor.remoteSessionId);
    if (existingRoute) {
      if (
        existingRoute.webContentsId !== webContentsId ||
        existingRoute.attachmentState !== "attachable" ||
        !isSameRemoteTarget(existingRoute.descriptor.target, descriptor.target)
      ) {
        // Bug 原因：Host join 合法复用 logical sessionId；只有同窗口、同 target 才能共享
        // Main route。冲突时拒绝新请求，但不能 dispose 仍被旧 owner 使用的 session。
        // [事务] 冲突时只拒绝新请求，绝不 dispose 既有 session：
        // 旧 owner 可能正在使用它，Main 无权替它关闭。让新连接失败并提示用户
        // 是唯一安全的选择；Host 侧会因 pending reject 而未真正建连。
        pending.reject(
          new Error(
            `远程 workspace join 与已有 route 不匹配，sessionId=${descriptor.remoteSessionId}`,
          ),
        );
        return;
      }
      // [事务] 手机 scope 提升为桌面 scope 是一次"重新提交"：
      // 手机侧从未有过 renderer attachment，若不重置 connectFinalized，
      // 后续同样不会上报 connected，桌面端会一直显示未连接。
      // telemetryEligible 用或运算合并：任一路径是真实用户连接就应该计数。
      if (existingRoute.mobileOnly) {
        existingRoute.mobileOnly = false;
        // 手机 scope 没有 renderer ready；桌面采用时重新走唯一的连接提交点。
        existingRoute.connectFinalized = false;
        existingRoute.remoteUsageTelemetryEligible ||= pending.remoteUsageTelemetryEligible;
        void (existingRoute.providerProvisioningReady ?? Promise.resolve())
          .then(() => attachRendererPort(pending.win, existingRoute, "desktop-join"))
          .then(
            () => pending.resolve(descriptor.remoteSessionId),
            (error: unknown) =>
              pending.reject(error instanceof Error ? error : new Error(String(error))),
          );
        return;
      }
      // Bug 原因：显式 conversation bind 与 Source 自动恢复可能 join 到同一个 Host
      // logical session。过去这里覆盖 routesBySessionId，旧 candidate 的 ready ACK 会被
      // 判 stale，遗留 timer 最终又回收健康 attachment。重复 connect 只等待唯一 route ready。
      // [并发] 复用路径不推进任何 attach，只等 route 变可用：
      // 若这里再 attach 一次，会和正在进行的候选形成双候选，旧 ACK 被判 stale。
      // 遥测资格在等待前就合并，保证"等待期间 route 刚好 ready"也不会漏报。
      // onConnected 必须在 resolve 前调用：调用方依赖它在 Promise 完成前完成登记。
      const promoteTelemetryEligibility =
        !existingRoute.remoteUsageTelemetryEligible && pending.remoteUsageTelemetryEligible;
      existingRoute.remoteUsageTelemetryEligible ||= pending.remoteUsageTelemetryEligible;
      if (promoteTelemetryEligibility && existingRoute.connectFinalized) {
        reportRemoteRouteConnected(existingRoute);
      }
      void waitForJoinedRouteReady(existingRoute, descriptor).then(
        () => {
          pending.onConnected?.(descriptor);
          pending.resolve(descriptor.remoteSessionId);
        },
        (error: unknown) =>
          pending.reject(error instanceof Error ? error : new Error(String(error))),
      );
      return;
    }
    const route: RemoteAttachmentRoute = {
      webContentsId,
      descriptor,
      attachmentState: "attachable",
      connectedAtMonotonicMs: monotonicNowMs(),
      connectFinalized: false,
      remoteUsageTelemetryEligible: pending.remoteUsageTelemetryEligible,
    };
    // 写注册表必须在 attach 之前：attach 的失败回滚按 sessionId 删除，
    // 如果此时表里还没有 route，rollback 就删不掉随后写入的对象。
    // 写表也是"该 sessionId 已被占用"的声明，后续 join 会按 INV-7 走复用分支。
    routesBySessionId.set(descriptor.remoteSessionId, route);
    const environmentKey = buildRemoteEnvironmentKey(descriptor.target);
    const registration = providerProvisioningCoordinator.register(
      environmentKey,
      descriptor.remoteSessionId,
      (trigger) =>
        executeProviderProvisioning(child, descriptor.remoteSessionId, environmentKey, trigger),
    );
    route.providerProvisioningDispose = registration.dispose;
    // [并发] 首连发布屏障：必须等 initialSync 完成再 attach，
    // 否则 renderer 会在 provider 配置尚未下发时就开始请求远端，
    // 这会让 renderer 看到"能连上但模型/环境不可用"的短窗口。
    // 屏障失败走 catch 的全量回滚，不会把半配置的 route 暴露给 renderer。
    void registration.initialSync
      .then(() => attachRendererPort(pending.win, route, "connect"))
      .then(() => {
        emitConnectionLog(pending.win, {
          requestId,
          sessionId: descriptor.remoteSessionId,
          level: "info",
          message: `远程 ${descriptor.target.kind} workspace 已连接`,
        });
        pending.onConnected?.(descriptor);
        pending.resolve(descriptor.remoteSessionId);
      })
      .catch((error: unknown) => {
        route.providerProvisioningDispose?.();
        routesBySessionId.delete(descriptor.remoteSessionId);
        child.postMessage({
          type: HostMessageTypes.DisposeRemoteWorkspaceSession,
          requestId: randomUUID(),
          remoteSessionId: descriptor.remoteSessionId,
        });
        emitConnectionLog(pending.win, {
          requestId,
          sessionId: descriptor.remoteSessionId,
          level: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
  }

  // Source 自动重连：Host 复用了旧连接但换了 logical sessionId。
  // [事务] 换代必须"先删旧键、再改 descriptor、最后写新键"：
  // 任何中间态被并发事件读到，都会出现两个 sessionId 指向同一 route 的分裂。
  // 重连失败的回滚只能删新键并 dispose，不能恢复旧键——旧 sessionId 在 Host 侧已失效。
  function handleReconnected(
    child: ElectronUtilityProcess,
    webContentsId: number,
    previousRemoteSessionId: string,
    descriptor: WindowHostRemoteWorkspaceDescriptor,
  ): void {
    const route = routesBySessionId.get(previousRemoteSessionId);
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === webContentsId,
    );
    // [失败路径] 找不到 route、窗口不匹配、窗口已销毁，三者都只能让 Host 释放新 session：
    // Main 没有可继承的 attachment 上下文，继续保留只会制造一个无人持有的会话。
    // 不在这里触发窗口级清理：其他 route 可能仍然健康。
    if (!route || route.webContentsId !== webContentsId || !win) {
      child.postMessage({
        type: HostMessageTypes.DisposeRemoteWorkspaceSession,
        requestId: randomUUID(),
        remoteSessionId: descriptor.remoteSessionId,
      });
      return;
    }
    // [事务] 顺序是硬约束：先删旧键，避免旧 sessionId 的迟到事件命中；
    // 再改 descriptor 与状态；最后写新键。中间不能有 await，
    // 否则并发的 closed/connect 会看到"新旧都不存在"或"两者都存在"。
    routesBySessionId.delete(previousRemoteSessionId);
    route.descriptor = descriptor;
    route.attachmentState = "attachable";
    routesBySessionId.set(descriptor.remoteSessionId, route);
    // [资源] 先摘旧登记再登记新 session：lane 的 execute 闭包捕获旧 sessionId，
    // 不重登记则重连后的配置全部发往 Host 已释放的 session。
    // 这里同步执行、不等待 initialSync，保证新登记在 attach 前就位。
    // Bug 原因：Provisioning lane 以 remoteSessionId 登记，execute 闭包也绑定旧 sessionId；
    // Source 重连换代后若不重新登记，后续下发都会命中 Host 已失效的旧 session，远端再也收不到配置。
    // 先摘掉旧登记再登记新 session，让 lane 按 Environment 重新上线整份重下发（离线期间的本机
    // 配置变更由此补齐）；重连不是首连发布屏障，失败只记录 warning，不拆除已恢复的 Workspace。
    route.providerProvisioningDispose?.();
    const environmentKey = buildRemoteEnvironmentKey(descriptor.target);
    const registration = providerProvisioningCoordinator.register(
      environmentKey,
      descriptor.remoteSessionId,
      (trigger) =>
        executeProviderProvisioning(child, descriptor.remoteSessionId, environmentKey, trigger),
    );
    route.providerProvisioningDispose = registration.dispose;
    // [失败路径] 重连后的 initialSync 只做"尽力补齐"：失败说明本次配置重放没成功，
    // 但 Workspace 本身已恢复可用，拆掉它代价更大。
    // 记录 environmentKey 与前后 sessionId，便于判断是 lane 未上线还是 Host 拒绝。
    registration.initialSync.catch((error: unknown) => {
      options.logger.warn(
        "[provider-provisioning] Environment resync after reconnect did not apply",
        {
          environmentKey,
          previousRemoteSessionId,
          remoteSessionId: descriptor.remoteSessionId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    });
    // [并发] 手机 route 不等待桌面 attach：两者是不同传输通道，
    // 手机恢复是 replayable 的旁路，把它的失败耦合进主链会 dispose 已就绪的桌面 session。
    // 因此 mobileOnly 分支直接 resolve，桌面分支才 attach。
    void (
      route.mobileOnly
        ? Promise.resolve()
        : attachRendererPort(win, route, "source-server-reconnected")
    )
      .then(() => {
        if (!descriptor.workspacePath || !descriptor.workspaceIdentity) return;
        // Bug 原因：手机 bridge 换代曾被 await 在 Desktop 关键路径上，手机 attachment
        // 失败会落入外层 catch 并 dispose 已就绪的 Desktop session。Desktop continuous
        // 先完成换代；手机 replayable 恢复是隔离的旁路，失败只降级手机。
        // 先通知 renderer 换代（previousSessionId 让前端把旧 tab 映射到新 id），
        // 再写连接日志：反序会让用户先看到"已重连"却仍持有旧 id 的短窗口。
        // mobileOnly 不发这个事件：手机端没有 desktop renderer 的 session 映射。
        if (!route.mobileOnly)
          win.webContents.send(PlatformChannels.RemoteSessionReconnected, {
            previousSessionId: previousRemoteSessionId,
            sessionId: descriptor.remoteSessionId,
            workspacePath: descriptor.workspacePath,
            workspaceIdentity: descriptor.workspaceIdentity,
          });
        emitConnectionLog(win, {
          sessionId: descriptor.remoteSessionId,
          level: "info",
          message: `远程 ${descriptor.target.kind} workspace 已自动重连`,
        });
        void options.webRemoteControlManagerRef.current
          ?.replaceRemoteSession?.({
            previousSessionId: previousRemoteSessionId,
            sessionId: descriptor.remoteSessionId,
            workspacePath: descriptor.workspacePath,
            workspaceIdentity: descriptor.workspaceIdentity,
          })
          .catch((error: unknown) => {
            options.logger.warn("[window-host-remote] mobile bridge recovery failed", {
              previousRemoteSessionId,
              remoteSessionId: descriptor.remoteSessionId,
              error,
            });
          });
      })
      .catch((error: unknown) => {
        route.providerProvisioningDispose?.();
        routesBySessionId.delete(descriptor.remoteSessionId);
        child.postMessage({
          type: HostMessageTypes.DisposeRemoteWorkspaceSession,
          requestId: randomUUID(),
          remoteSessionId: descriptor.remoteSessionId,
        });
        options.logger.warn("[window-host-remote] Source reconnect attachment failed", {
          previousRemoteSessionId,
          remoteSessionId: descriptor.remoteSessionId,
          error,
        });
      });
  }

  // Provider 配置执行的单一出口：lane 的 trigger 与首连/重连的 initialSync 都走这里。
  // [并发] 每个 requestId 单独记账并保存 child：Host 重发结果时按 requestId 精确命中，
  // 不能按 environmentKey 合并，否则同环境的两次执行会互相 resolve。
  // 返回的 Promise 只由 execution-result 或 Host exit 消费。
  function executeProviderProvisioning(
    child: ElectronUtilityProcess,
    remoteSessionId: string,
    environmentKey: string,
    trigger: ProviderProvisioningTrigger,
  ): Promise<void> {
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      pendingProviderProvisioningExecutions.set(requestId, {
        child,
        trigger,
        startedAtMonotonicMs: monotonicNowMs(),
        resolve,
        reject,
      });
      try {
        child.postMessage({
          type: HostMessageTypes.ProviderProvisioningExecute,
          requestId,
          environmentKey,
          remoteSessionId,
          trigger,
        });
      } catch (error) {
        pendingProviderProvisioningExecutions.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  // route 的"关闭附件"与"从注册表移除"是两件事，本函数只做前者：
  // 先清 pending 候选，再清已确认 id，顺序保证等待方拿到 reject 时
  // 不会再被一个刚落地的 ACK 提升出一个新 attachment。
  // 两个 detach 都幂等，重复调用不会产生额外副作用。
  function detachRouteAttachments(
    route: RemoteAttachmentRoute,
    reason: string,
    error: Error,
  ): void {
    const child = options.windowHostProcessMap.get(route.webContentsId);
    if (route.pendingRendererAttachment) {
      const pending = route.pendingRendererAttachment;
      clearTimeout(pending.timeout);
      route.pendingRendererAttachment = undefined;
      if (child) detachServicePort(child, pending.attachmentId, reason);
      pending.reject(error);
    }
    if (route.rendererAttachmentId) {
      if (child) detachServicePort(child, route.rendererAttachmentId, reason);
      route.rendererAttachmentId = undefined;
    }
  }

  // [事务] 把 route 从 active 变为 closed 的唯一入口：必须同时满足
  // 五件事由它一起完成：状态迁移、detach、删除注册表、统计上报、通知 renderer。
  // 先标记 closed 再清理：任何并发 attach/confirm 在第一行就会被状态校验挡住，
  // 不会在清理过程中重建 attachment。
  // wasActive 用于避免对已 closed 的 route 重复上报断连。
  function retireActiveRoute(
    route: RemoteAttachmentRoute,
    reason: RemoteDisconnectReason,
    mutate: () => void,
  ): void {
    const wasActive =
      route.remoteUsageTelemetryEligible &&
      route.attachmentState === "attachable" &&
      route.connectFinalized;
    mutate();
    if (!wasActive) return;

    const common = {
      rendererId: route.webContentsId,
      remoteKind: route.descriptor.target.kind,
    };
    try {
      options.reportRemoteConnectionStateChanged?.({
        ...common,
        transition: reason,
      });
    } catch (error) {
      // telemetry 是连接生命周期的旁路，不能因 reporter 异常回滚 route 退出状态。
      options.logger.warn("[remote-usage-arms] disconnect gauge reporter failed", { error });
    }
    try {
      options.reportRemoteDisconnect?.({
        ...common,
        disconnectReason: reason,
        durationMs: Math.max(0, Math.round(monotonicNowMs() - route.connectedAtMonotonicMs)),
      });
    } catch (error) {
      options.logger.warn("[remote-usage-arms] disconnect reporter failed", {
        error,
      });
    }
  }

  // Host 侧连接关闭的唯一入口：区分"可自动恢复"与"彻底关闭"两条路径。
  // recoverable=true 时保留 route（Host 之后可能发 reconnected），只做附件降级；
  // 否则走 retireActiveRoute 完成不可逆回收。
  // 两条路径都必须把 reason 透传给 renderer：UI 需要区分网络抖动还是用户主动断开。
  function handleClosed(
    webContentsId: number,
    event: {
      remoteSessionId: string;
      reason: "connection-closed" | "disposed" | "connect-cancelled";
      exitCode?: number | null;
      signal?: string | null;
      error?: string;
      recoverable?: boolean;
      recoveryAttempt?: number;
      recoveryLimit?: number;
      recoveryBudgetExhausted?: boolean;
      reasonCode?: string;
      retryable?: boolean;
    },
  ): void {
    const route = routesBySessionId.get(event.remoteSessionId);
    if (!route || route.webContentsId !== webContentsId) return;
    if (event.reason !== "connection-closed") {
      route.providerProvisioningDispose?.();
      retireActiveRoute(route, "disposed", () => {
        routesBySessionId.delete(event.remoteSessionId);
      });
      detachRouteAttachments(
        route,
        "session-released",
        new Error(`远程 workspace 已释放，sessionId=${event.remoteSessionId}`),
      );
      return;
    }
    retireActiveRoute(route, "connection-closed", () => {
      route.attachmentState = "closed";
    });
    route.providerProvisioningDispose?.();
    // 连接断开只把 route 标成 closed，已暴露的 desktop attachment 仍留在窗口 Host；
    // sessionId 换代后 Main 又会删除 route，导致旧 ChannelServer 永久失去回收入口。
    detachRouteAttachments(
      route,
      "session-connection-closed",
      new Error(`远程 workspace 已关闭，sessionId=${event.remoteSessionId}`),
    );
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === webContentsId,
    );
    if (event.recoverable !== true) {
      options.webRemoteControlManagerRef.current?.failRemoteSession(
        event.remoteSessionId,
        "window-host:connection-offline",
        {
          reason: "workspace-closed",
          message: "远程工作区连接已结束，请在桌面端重新连接。",
        },
      );
    }
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(PlatformChannels.RemoteSessionClosed, {
        sessionId: event.remoteSessionId,
        reason: "host-exit" as const,
        exitCode: event.exitCode ?? null,
        signal: event.signal ?? null,
        ...(event.error ? { error: event.error } : {}),
        ...(event.recoverable !== undefined ? { recoverable: event.recoverable } : {}),
        ...(event.recoveryAttempt ? { recoveryAttempt: event.recoveryAttempt } : {}),
        ...(event.recoveryLimit ? { recoveryLimit: event.recoveryLimit } : {}),
        ...(event.recoveryBudgetExhausted !== undefined
          ? { recoveryBudgetExhausted: event.recoveryBudgetExhausted }
          : {}),
        ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
        ...(event.retryable !== undefined ? { retryable: event.retryable } : {}),
      });
      emitConnectionLog(win, {
        sessionId: event.remoteSessionId,
        level: "warn",
        message: event.error || "远程 workspace 连接已断开",
      });
    }
  }

  // "项目导航"专用：Host 预先准备好 workspace 后，Main 才创建一个 mobileOnly route。
  // 这类 mobileOnly route 没有 renderer port，只会作为后续桌面 join 的占位，
  // 因此不能插入 pending、也不能触发 attach。
  // 已存在同 sessionId 的 route 时复用并返回，保证重复导航不会产生两条记录。
  function acceptPreparedProjectWorkspace(
    child: ElectronUtilityProcess,
    webContentsId: number,
    requestId: string,
    result: { ok: true; value: HostPreparedProjectWorkspace } | { ok: false; error: string },
  ): void {
    const key = requestKey(webContentsId, requestId);
    const pending = pendingProjectNavigations.get(key);
    if (!pending || pending.child !== child) return;
    if (!result.ok) {
      pendingProjectNavigations.delete(key);
      pending.reject(new Error(result.error));
      return;
    }
    const descriptor = result.value.remote;
    if (!descriptor) {
      pendingProjectNavigations.delete(key);
      pending.resolve(result.value);
      return;
    }
    const resolveWhenReady = (route: RemoteAttachmentRoute, ownsRegistration: boolean) => {
      void (route.providerProvisioningReady ?? Promise.resolve()).then(
        () => {
          // 每个 join 都必须等同一屏障，并保留自己的取消资格到成功提交。
          if (pendingProjectNavigations.get(key) !== pending) return;
          pendingProjectNavigations.delete(key);
          if (
            routesBySessionId.get(descriptor.remoteSessionId) !== route ||
            route.attachmentState !== "attachable"
          )
            pending.reject(new Error("项目导航 scope 已失效"));
          else pending.resolve(result.value);
        },
        (error: unknown) => {
          if (pendingProjectNavigations.get(key) === pending) pendingProjectNavigations.delete(key);
          if (
            ownsRegistration &&
            routesBySessionId.get(descriptor.remoteSessionId) === route &&
            route.mobileOnly
          ) {
            routesBySessionId.delete(descriptor.remoteSessionId);
            route.providerProvisioningDispose?.();
            child.postMessage({
              type: HostMessageTypes.DisposeRemoteWorkspaceSession,
              requestId: randomUUID(),
              remoteSessionId: descriptor.remoteSessionId,
            });
          }
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    };
    const existing = routesBySessionId.get(descriptor.remoteSessionId);
    if (existing) {
      if (
        existing.webContentsId !== webContentsId ||
        existing.attachmentState !== "attachable" ||
        existing.descriptor.workspaceIdentity !== descriptor.workspaceIdentity ||
        existing.descriptor.workspacePath !== descriptor.workspacePath
      ) {
        pendingProjectNavigations.delete(key);
        pending.reject(new Error("Project navigation scope conflicts with existing route"));
      } else resolveWhenReady(existing, false);
      return;
    }
    const route: RemoteAttachmentRoute = {
      webContentsId,
      descriptor,
      mobileOnly: true,
      attachmentState: "attachable",
      connectedAtMonotonicMs: monotonicNowMs(),
      connectFinalized: true,
      remoteUsageTelemetryEligible: false,
    };
    routesBySessionId.set(descriptor.remoteSessionId, route);
    const environmentKey = buildRemoteEnvironmentKey(descriptor.target);
    const registration = providerProvisioningCoordinator.register(
      environmentKey,
      descriptor.remoteSessionId,
      (trigger) =>
        executeProviderProvisioning(child, descriptor.remoteSessionId, environmentKey, trigger),
    );
    route.providerProvisioningDispose = registration.dispose;
    route.providerProvisioningReady = registration.initialSync;
    resolveWhenReady(route, true);
  }

  // 每个 Host child 只挂一次监听：窗口 reload 会复用同一 child 时避免重复消费消息
  // （重复监听会让一条 connected 触发两次 handleConnected，第二个 pending 早已删除，
  // 于是误走"无 pending → dispose"分支，把刚建立的会话销毁）。
  // WeakSet 的键是 child 本身，child 被替换后旧记录随 GC 消失。
  // webContentsId 在挂载时固定，后续所有事件都按它做归属校验。
  function ensureHostListener(child: ElectronUtilityProcess, webContentsId: number): void {
    if (listenedHosts.has(child)) return;
    listenedHosts.add(child);
    // [并发] 消息分发是纯同步的：每个分支只做状态迁移或 Promise 消费，
    // 不在这里 await。异步工作全部交给各自的 Promise 链，
    // 保证同一 child 的事件按到达顺序被处理，不会交错。
    // 解析失败只告警：Host 可能升级后新增消息类型，Main 必须能容忍未知负载。
    child.on("message", (message: unknown) => {
      const parsed = hostResponseMessageSchema.safeParse(message);
      if (!parsed.success) return;
        // prepared 事件是导航 pending 的唯一消费者：先取再删，
      // 保证重复事件不会让第二个 pending 被错误 resolve。
      // mobileOnly 从这里开始成立：项目导航准备出的 workspace 没有桌面 port。
      if (parsed.data.type === HostResponseTypes.ProjectWorkspacePrepared) {
        acceptPreparedProjectWorkspace(
          child,
          webContentsId,
          parsed.data.requestId,
          parsed.data.result,
        );
        return;
      }
        // 连接日志是纯转发：即使没有 pending/route 也要投递，
      // 因为用户可能正看着"正在连接"的日志面板，此时正是最需要 emitConnectionLog 反馈的阶段。
      // 只校验窗口归属，不校验 session 是否存在。
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceConnectionLog) {
        const pending = pendingByRequestKey.get(requestKey(webContentsId, parsed.data.requestId));
        if (!pending) return;
        // 多个远程连接共享 window Host，不能再从进程 label/stdout 猜日志归属；
        // Host 已带上连接 requestId，Main 只向对应发起窗口做薄转发。
        emitConnectionLog(pending.win, {
          requestId: parsed.data.requestId,
          level: parsed.data.level,
          message: parsed.data.message,
        });
        return;
      }
        // Provider 源变更通知只更新 lane 的配置快照，不触发立即执行：
      // 执行时机由 environment-online 或用户操作决定，这里抢先执行会在
      // 窗口未就绪时发请求并失败。
      if (parsed.data.type === HostResponseTypes.ProviderProvisioningSourceChanged) {
        void providerProvisioningCoordinator.requestAll(parsed.data.trigger);
        return;
      }
        // [事务] 执行结果必须精确命中 requestId 并立即删除：
      // 同一 requestId 若被消费两次，第二次会 resolve 一个已 settled 的 Promise（静默无效），
      // 但会让调用方误以为 Host 重复确认。
      // 找不到时只告警：可能是超时后 Host 才回，属于正常迟到。
      if (parsed.data.type === HostResponseTypes.ProviderProvisioningExecutionResult) {
        const pending = pendingProviderProvisioningExecutions.get(parsed.data.requestId);
        // 按 child 身份与 requestId 双重校验：requestId 只在单个 Host 内唯一，
        // 窗口重建后新 Host 可能复用同一个 id，仅按 id 会消费错窗口的执行结果。
        // 找不到时静默返回：超时路径已经 reject 过，这里只是迟到回包。
        if (!pending || pending.child !== child) return;
        pendingProviderProvisioningExecutions.delete(parsed.data.requestId);
        const logContext = {
          environmentKey: parsed.data.environmentKey,
          trigger: pending.trigger,
          status: parsed.data.status,
          durationMs: Math.max(0, monotonicNowMs() - pending.startedAtMonotonicMs),
        };
        if (parsed.data.status !== "applied" && parsed.data.status !== "already-applied") {
          const errorCode =
            parsed.data.errorCode ??
            (parsed.data.status === "unsupported"
              ? "capability-unavailable"
              : "target-apply-failed");
          // 首次失败以前在 warning 前返回，连接面板也只剩开始日志，无法区分本地与远端故障。
          // 仅记录经过 schema 校验的阶段码；远端 error 自由文本仍不进入日志或反馈。
          options.logger.warn("[provider-provisioning] Environment sync did not apply", {
            ...logContext,
            errorCode,
          });
          if (pending.trigger === "environment-online") {
            pending.reject(
              new Error(`Provider Provisioning 首次同步失败 (${parsed.data.status}; ${errorCode})`),
            );
            return;
          }
        } else {
          options.logger.info("[provider-provisioning] Environment sync completed", logContext);
        }
        pending.resolve();
        return;
      }
      // connected 的 requestId 是 pending 的唯一消费键：Host 可能同时为多个窗口
      // 建立同名 session，只有 (webContentsId, requestId) 才能唯一定位发起方，不能只按 session 匹配。
      // 这个分支不做任何 await 之外的等待，所有异步后续都在 handleConnected 内部。
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceConnected) {
        handleConnected(child, webContentsId, parsed.data.requestId, parsed.data.descriptor);
        return;
      }
      // bind 的成功/失败共用一个 pending 槽：先按 requestId 命中再判断类型，
      // 避免 success 分支提前 return 让失败分支永远收不到结果。
      // 命中后立即删除，保证迟到消息不会二次消费。
      if (
        parsed.data.type === HostResponseTypes.RemoteWorkspaceContextBound ||
        parsed.data.type === HostResponseTypes.RemoteWorkspaceContextBindFailed
      ) {
        const key = requestKey(webContentsId, parsed.data.requestId);
        const pending = pendingWorkspaceBindsByRequestKey.get(key);
        if (!pending) return;
        pendingWorkspaceBindsByRequestKey.delete(key);
        clearTimeout(pending.timeout);
        if (parsed.data.type === HostResponseTypes.RemoteWorkspaceContextBound) {
          pending.resolve(parsed.data.previousWorkspaceIdentity);
        } else {
          const error = new Error(parsed.data.error) as Error & {
            code?: string;
            retryable?: boolean;
          };
          if (parsed.data.reasonCode) error.code = parsed.data.reasonCode;
          if (parsed.data.retryable !== undefined) error.retryable = parsed.data.retryable;
          pending.reject(error);
        }
        return;
      }
      // 重连事件不带 requestId：它对应的是"已有 route 被 Host 换了 sessionId"，
      // 归属按 webContentsId 判定，sessionId 由事件负载给出。
      // 若 route 已不存在，只能让 Host 释放新 session（见 handleReconnected 的失败分支）。
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceReconnected) {
        handleReconnected(
          child,
          webContentsId,
          parsed.data.previousRemoteSessionId,
          parsed.data.descriptor,
        );
        return;
      }
      // [失败路径] 连接失败的 requestId 可能已经不在表里（窗口先关了）：
      // 此时仍需把错误上报给 renderer 的连接状态，否则 UI 会停在"连接中"。
      // 因此失败分支不依赖 pending 是否存在，做的是"尽力通知 + 清理"。
      // 若 pending 存在，reject 之后再删除，保证发起方拿到原始错误消息。
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceConnectFailed) {
        const key = requestKey(webContentsId, parsed.data.requestId);
        const pending = pendingByRequestKey.get(key);
        if (!pending) return;
        pendingByRequestKey.delete(key);
        emitConnectionLog(pending.win, {
          requestId: parsed.data.requestId,
          level: remoteConnectionFailureLogLevel(parsed.data.reasonCode ?? ""),
          message: sanitizeRemoteConnectionLog(parsed.data.error),
        });
        const error = new Error(parsed.data.error) as Error & {
          code?: string;
          retryable?: boolean;
          profileId?: string;
          resolvedWslTarget?: Required<Extract<RemoteTarget, { kind: "wsl" }>>;
        };
        if (parsed.data.reasonCode) error.code = parsed.data.reasonCode;
        if (parsed.data.retryable !== undefined) error.retryable = parsed.data.retryable;
        if (parsed.data.profileId) error.profileId = parsed.data.profileId;
        if (parsed.data.resolvedWslTarget) error.resolvedWslTarget = parsed.data.resolvedWslTarget;
        pending.reject(error);
        return;
      }
      // closed 的 recoverable 字段决定走"保留 route"还是"彻底回收"：
      // 不能只按 reason 推断，因为 reason 是给人看的文案，可恢复性是协议字段。
      // 该分支同样不依赖 pending：关闭可能发生在连接成功很久之后。
      if (parsed.data.type === HostResponseTypes.RemoteWorkspaceClosed) {
        handleClosed(webContentsId, parsed.data);
      }
    });
    // [失败路径] Host 退出是"整窗失效"事件：必须把一个窗口下的所有 pending
    // 全部 reject 并清空，否则 renderer 的按钮会永久 pending。
    // 清理按 child 身份过滤（INV-16）：窗口重建后新 Host 的 pending 不能被旧 child 的 exit 杀掉。
    // route 的回收交给各 route 的 closed 事件或窗口级 dispose，这里只做 pending 兜底。
    child.once("exit", () => {
      const error = new Error("窗口 Local Host 已退出");
      for (const [key, pending] of pendingProjectNavigations) {
        if (pending.child !== child) continue;
        pendingProjectNavigations.delete(key);
        pending.reject(error);
      }

      for (const [requestId, pendingExecution] of pendingProviderProvisioningExecutions) {
        if (pendingExecution.child !== child) continue;
        pendingProviderProvisioningExecutions.delete(requestId);
        pendingExecution.reject(error);
      }
      for (const [key, pending] of Array.from(pendingByRequestKey)) {
        if (pending.webContentsId === webContentsId) {
          pendingByRequestKey.delete(key);
          pending.reject(error);
        }
      }
      for (const [key, pending] of Array.from(pendingWorkspaceBindsByRequestKey)) {
        if (!key.startsWith(`${webContentsId}\0`)) continue;
        pendingWorkspaceBindsByRequestKey.delete(key);
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      // [失败路径] 退出时逐一标记 closed 而不是直接清表：
      // closed 状态会挡住并发 attach/confirm，避免清理过程中又建立新 attachment。
      // Array.from 是必要的：删除 Map 项会让直接遍历的迭代器跳过后续元素。
      for (const [sessionId, route] of Array.from(routesBySessionId)) {
        if (route.webContentsId !== webContentsId) continue;
        route.providerProvisioningDispose?.();
        retireActiveRoute(route, "host-exit", () => {
          routesBySessionId.delete(sessionId);
        });
        if (route.pendingRendererAttachment) {
          clearTimeout(route.pendingRendererAttachment.timeout);
          route.pendingRendererAttachment.reject(error);
        }
      }
    });
  }

  // 建连的唯一发起口：先做退出/窗口/重复请求三道守卫，再登记 pending 并发消息。
  // [事务] pending 必须在 postMessage 之前写入：Host 可能在同一个 tick 内回 connected，
  // 顺序反了 handleConnected 会因找不到 pending 而把刚建的会话 dispose。
  // 目标解析（resolveRemoteTarget）可能失败，失败时不得登记任何状态。
  async function createRemoteWorkspaceSession(
    win: BrowserWindow,
    target: RemoteTarget,
    requestId?: string,
    context?: RemoteWorkspaceConnectContext,
    lifecycle?: {
      remoteUsageTelemetryEligible?: boolean;
      onConnected?: (descriptor: WindowHostRemoteWorkspaceDescriptor) => void;
    },
  ): Promise<string> {
    if (appShutdownStarted) {
      throw new Error("应用正在退出，无法创建远程工作区连接");
    }
    const child = getWindowHost(win);
    const resolvedTarget =
      target.kind === "wsl" && options.resolveWslTarget
        ? await options.resolveWslTarget(target)
        : target;
    if (appShutdownStarted) {
      // [事务] 退出屏障与窗口存活两道门必须同时成立才允许建连：
      // 退出中再建 Host session 会在清理循环之后落地，成为无法回收的子连接。
      // 这里选择抛错而不是 resolve 空值：调用方需要把失败回执给 UI。
      // WSL identity 解析跨 await，期间退出屏障可能已清空 Main 请求关联并开始回收 Host。
      // 恢复后必须重新验证生命周期，禁止在 shutdown barrier 之后注册迟到请求。
      throw new Error("应用正在退出，无法创建远程工作区连接");
    }
    // [失败路径] 窗口在目标解析期间被关闭：此时不能再登记 pending，
    // 否则 connected 永远等不到窗口，只能靠 Host exit 兜底。
    // 抛错让调用方（IPC）立即得到失败，而不是一个永不 resolve 的 Promise。
    if (win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new Error("窗口已关闭，无法创建远程工作区连接");
    }
    // requestId 缺省时由 Main 生成：这条路径供内部调用方使用，
    // 它们不需要回执，但仍需要一个唯一键来关联 Host 的 connected/failed 事件。
    const resolvedRequestId = requestId ?? randomUUID();
    const key = requestKey(win.webContents.id, resolvedRequestId);
    // [并发] 重复 requestId 直接失败而不是复用旧 Promise：
    // renderer 复用 id 说明它自己已经丢失了上一次请求的上下文，
    // 复用会让两次不同的连接意图共享一个回执，最终谁都不确定连的是哪台机器。
    // 该检查与写入之间没有 await，因此是原子的。
    if (pendingByRequestKey.has(key)) {
      throw new Error(`远程连接 requestId 重复，requestId=${resolvedRequestId}`);
    }
    emitConnectionLog(win, {
      requestId: resolvedRequestId,
      level: "info",
      // 日志放在发起前：连接失败时用户仍能看到"尝试连接哪个目标"，
      // 否则错误消息只有失败原因，没有上下文。
      // level=info 而不是 debug：连接是低频高价值事件，默认要可见。
      message: `正在通过窗口 Host 连接 ${resolvedTarget.kind} workspace`,
    });
    // [并发] pending 记录与 Promise 构造必须在同一同步块内完成：
    // 中间插入任何 await 都会让第二次同 key 请求看到"还没有 pending"，
    // 从而创建第二个连接，最终两个 ACK 只有一个能命中。
    return new Promise<string>((resolve, reject) => {
      pendingByRequestKey.set(key, {
        requestId: resolvedRequestId,
        webContentsId: win.webContents.id,
        win,
        remoteUsageTelemetryEligible: lifecycle?.remoteUsageTelemetryEligible ?? false,
        onConnected: lifecycle?.onConnected,
        resolve,
        reject,
      });
      child.postMessage({
        type: HostMessageTypes.ConnectRemoteWorkspace,
        requestId: resolvedRequestId,
        target: resolvedTarget,
        remoteAssets: options.resolveRemoteAssetDirs(),
        ...(context?.workspacePath ? { workspacePath: context.workspacePath } : {}),
        ...(context?.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
        ...(context?.confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
      });
    });
  }

  // workspace 换绑入口：先确保 route 可用，再用 sessionId 做飞行去重。
  // [并发] 同一 sessionId 的并发 bind 只有 contextKey 完全一致才能共享 Promise；
  // 不一致必须失败，否则后一次 bind 会覆盖前一次的 generation，
  // 导致先返回的 ACK 把旧 workspace 当成新 workspace 的绑定结果。
  // 绑定期间不修改 descriptor，ACK 后再更新并重新 attach（INV-14）。
  async function bindRemoteWorkspaceSessionContext(
    sessionId: string,
    context: RemoteWorkspaceSessionContext,
    expectedWebContentsId?: number,
  ): Promise<BindRemoteWorkspaceSessionContextResult> {
    const route = routesBySessionId.get(sessionId);
    if (!route) {
      throw new Error(`未找到远程 workspace session，sessionId=${sessionId}`);
    }
    if (expectedWebContentsId != null && route.webContentsId !== expectedWebContentsId) {
      throw new Error(`远程 workspace session 不属于当前窗口，sessionId=${sessionId}`);
    }
    const requestedWorkspaceIdentity =
      context.workspaceIdentity?.trim() ||
      buildRemoteWorkspaceIdentity(context.workspacePath, route.descriptor.target);
    const workspaceIdentity = route.descriptor.sourceServerId
      ? buildServerRemoteWorkspaceIdentity({
          serverId: route.descriptor.sourceServerId,
          workspacePath: context.workspacePath,
        })
      : requestedWorkspaceIdentity;
    const contextKey = buildWorkspaceContextBindKey({
      workspaceIdentity,
      workspacePurpose: context.workspacePurpose,
    });
    // [并发] 飞行表按 sessionId 而非 contextKey 索引：同一会话同一时刻
    // 只允许一次 descriptor 迁移，contextKey 只用于判断"后来者要的是不是同一件事"。
    // 命中但 key 不同时必须拒绝而不是排队：排队会让两次换绑串行，用户看到目录闪回。
    const existingFlight = workspaceContextBindFlightsBySessionId.get(sessionId);
    if (existingFlight) {
      if (existingFlight.contextKey !== contextKey) {
        throw new Error(`远程 workspace session 正在绑定其它 context，sessionId=${sessionId}`);
      }
      return await existingFlight.promise;
    }
    const requestedWorkspacePurpose = context.workspacePurpose ?? route.descriptor.workspacePurpose;
    if (
      route.descriptor.workspacePath === context.workspacePath &&
      route.descriptor.workspaceIdentity === workspaceIdentity &&
      (route.descriptor.workspacePurpose ?? "project") === (requestedWorkspacePurpose ?? "project")
    ) {
      // Bug 原因：join caller 在首个 bind 完成后会再次提交同一 context。重复换代
      // attachment 会让并行初始化使用的 services 失效；已绑定 context 只等待当前 candidate ready。
      await waitForRendererAttachmentReady(route);
      return createBoundRemoteWorkspaceContextResult(route);
    }
    // 先写飞行表再执行：执行体内部可能同步触发 await，
    // 期间若有第二个调用进来，必须能看到这条飞行记录并复用同一个 Promise。
    // Promise 的 finally 负责清表，而且只会清"仍是自己"的那条，避免误删后来者。
    const promise = performRemoteWorkspaceSessionContextBind({
      route,
      sessionId,
      context,
      requestedWorkspaceIdentity,
      workspaceIdentity,
    });
    workspaceContextBindFlightsBySessionId.set(sessionId, {
      contextKey,
      promise,
    });
    try {
      return await promise;
    } finally {
        // 只清仍指向本次 promise 的记录：期间可能有新飞行接管，
      // 无条件 delete 会把新记录删掉，后续并发 bind 就会绕过去重。
      // 清理放在 finally 保证成功/失败/取消都会释放槽位。
      const current = workspaceContextBindFlightsBySessionId.get(sessionId);
      if (current?.promise === promise) {
        workspaceContextBindFlightsBySessionId.delete(sessionId);
      }
    }
  }

  // performRemoteWorkspaceSessionContextBind 是真正的 bind 往返，由它登记 pending、发消息、等 context-bound 或超时。
  // [事务] 成功路径必须"先写 descriptor 再 attach"：attach 会读取 descriptor 生成
  // scoped payload，顺序反了会把旧 workspace 路径发给 renderer。
  // 超时必须同时发 Cancel 并清 pending，避免 Host 继续绑定而 Main 已放弃。
  async function performRemoteWorkspaceSessionContextBind(params: {
    route: RemoteAttachmentRoute;
    sessionId: string;
    context: RemoteWorkspaceSessionContext;
    requestedWorkspaceIdentity: string;
    workspaceIdentity: string;
  }): Promise<BindRemoteWorkspaceSessionContextResult> {
    const { route, sessionId, context, requestedWorkspaceIdentity, workspaceIdentity } = params;
    const child = options.windowHostProcessMap.get(route.webContentsId);
    const win = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.webContents.id === route.webContentsId,
    );
    if (!child || !win) {
      throw new Error(`未找到远程 workspace 所属窗口 Host，sessionId=${sessionId}`);
    }
    const requestId = randomUUID();
    const bindRequestKey = requestKey(route.webContentsId, requestId);
    const bindReady = new Promise<string | undefined>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = pendingWorkspaceBindsByRequestKey.get(bindRequestKey);
        if (!pending) return;
        pendingWorkspaceBindsByRequestKey.delete(bindRequestKey);
        child.postMessage({
          type: HostMessageTypes.CancelRemoteWorkspaceBind,
          requestId,
          remoteSessionId: sessionId,
        });
        pending.reject(
          Object.assign(
            new Error(
              `workspace bind ACK 超时，sessionId=${sessionId}, timeoutMs=${workspaceBindReadyTimeoutMs}`,
            ),
            {
              // Bug 原因：超时会主动发 CancelRemoteWorkspaceBind，但本地先拒绝了无 code 的
              // Error，Renderer 永远走不到已登记的 bindCanceled i18n 分支。
              code: REMOTE_BIND_CANCELED_ERROR_CODE,
              retryable: true,
            },
          ),
        );
      }, workspaceBindReadyTimeoutMs);
      pendingWorkspaceBindsByRequestKey.set(bindRequestKey, {
        resolve,
        reject,
        timeout,
      });
    });
    child.postMessage({
      type: HostMessageTypes.BindRemoteWorkspaceContext,
      requestId,
      remoteSessionId: sessionId,
      workspacePath: context.workspacePath,
      workspaceIdentity,
      ...(context.workspacePurpose ? { workspacePurpose: context.workspacePurpose } : {}),
      ...(requestedWorkspaceIdentity !== workspaceIdentity
        ? { legacyRouteHint: requestedWorkspaceIdentity }
        : {}),
    });
    let previousWorkspaceIdentity: string | undefined;
    try {
      previousWorkspaceIdentity = await bindReady;
    } catch (error) {
      const pending = pendingWorkspaceBindsByRequestKey.get(bindRequestKey);
      if (pending) clearTimeout(pending.timeout);
      pendingWorkspaceBindsByRequestKey.delete(bindRequestKey);
      throw error;
    }
    // generation+1 只在这里写：Host 在 context-bound 回包里给出的 generation
    // 才是权威值，Main 自增只是保持单调，不能作为比较依据。
    // descriptor 其它字段保持原值，避免用请求参数覆盖 Host 确认过的目标信息。
    route.descriptor = {
      ...route.descriptor,
      workspacePath: context.workspacePath,
      workspaceIdentity,
      ...(context.workspacePurpose ? { workspacePurpose: context.workspacePurpose } : {}),
      generation: route.descriptor.generation + 1,
    };
    // 同一 parentPort 上 Bind 先于 Attach 处理；IPC 只在 renderer 注册新 port 后返回。
    // [事务] 换绑成功后必须重新 attach：descriptor 变了，旧 port 的 scoped 元数据
    // 仍指向旧 workspace，继续使用会让远端文件操作落到错误目录。
    // 先写 descriptor 再 attach：attach 读取 descriptor 构造 payload，顺序不可反。
    // attach 失败会让整个 bind Promise reject，由调用方决定是否回退工作区。
    await attachRendererPort(win, route, "workspace-context-bound");
    return createBoundRemoteWorkspaceContextResult(route, previousWorkspaceIdentity);
  }

  // 返回值故意同时带 result 与 context：调用方（IPC 层）需要把"绑定后的 workspace
  // 身份"同步给 renderer，而 result 里的 generation 是 Host 侧比较用的内部值。
  // 不在这里触发 renderer 事件：bind 是查询式操作，UI 状态由调用方决定何时更新。
  function createBoundRemoteWorkspaceContextResult(
    route: RemoteAttachmentRoute,
    previousWorkspaceIdentity?: string,
  ): BindRemoteWorkspaceSessionContextResult {
    return {
      ...(route.descriptor.sourceServerId
        ? { sourceServerId: route.descriptor.sourceServerId }
        : {}),
      remoteSessionId: route.descriptor.remoteSessionId,
      workspacePath: route.descriptor.workspacePath!,
      workspaceIdentity: route.descriptor.workspaceIdentity!,
      ...(route.descriptor.workspacePurpose
        ? { workspacePurpose: route.descriptor.workspacePurpose }
        : {}),
      ...(previousWorkspaceIdentity ? { previousWorkspaceIdentity } : {}),
    };
  }

  // 窗口恢复（reload/唤醒）后重挂所有 route：逐个 attach 是必要的，
  // 因为 port 已随旧 renderer 销毁，Main 侧只剩 closed 的 transfer 结果。
  // 单个 route 失败不影响其他 route；失败只记录日志，窗口级状态由各自的 closed 事件收口。
  // 遍历 snapshot 而不是实时集合：attach 过程中可能新增/删除 route，直接遍历 Map 会漏项。
  function reattachRemoteWorkspaceSessionsForWindow(win: BrowserWindow, reason: string): void {
    for (const route of routesBySessionId.values()) {
      if (
        !route.mobileOnly &&
        route.webContentsId === win.webContents.id &&
        route.attachmentState === "attachable"
      ) {
            // 单个 route 的 attach 失败不向上抛：窗口恢复时要尽量救回其它 route，
        // 一个坏会话不应让整窗重新加载后全部不可用。
        // 失败日志带上 reason，便于区分是窗口已关还是 Host 已退出。
        void attachRendererPort(win, route, reason).catch((error: unknown) => {
          options.logger.warn("[window-host-remote] renderer reattach failed", {
            sessionId: route.descriptor.remoteSessionId,
            reason,
            error,
          });
        });
      }
    }
  }

  // getRemoteConnectionStats 只做只读快照，不会做任何状态迁移：调用方是遥测定时器，
  // 若这里顺手清理 pending，会与正常流程的清理竞争。
  // activeTargetCount 按 target 去重而不是按 session：同一台机器上的两个 workspace 只算一个目标。
  // 计数口径必须与 isSameRemoteTarget 一致，否则报表与用户实际感知会对不上。
  function getRemoteConnectionStats(): RemoteConnectionStats {
    const activeRoutes = Array.from(routesBySessionId.values()).filter(
      (route) =>
        route.remoteUsageTelemetryEligible &&
        route.attachmentState === "attachable" &&
        route.connectFinalized,
    );
    return {
      activeSessionCount: activeRoutes.length,
      activeTargetCount: new Set(
        activeRoutes.map((route) => buildRemoteTargetTelemetryKey(route.descriptor.target)),
      ).size,
    };
  }

  // 用户主动关闭 workspace 的入口：先 retire（含 detach 与通知 renderer），
  // 再向 Host 发 dispose。顺序不能反——Host 的 dispose 可能同步触发 closed 事件，
  // 那时 route 若还在 active，会走"可恢复"分支而不是用户预期的彻底关闭。
  // 找不到 route 时静默返回：重复关闭是幂等的，不应向 renderer 报错。
  function disposeRemoteWorkspaceSession(sessionId: string, _reason?: string): void {
    const route = routesBySessionId.get(sessionId);
    if (!route) return;
    retireActiveRoute(route, "disposed", () => {
      routesBySessionId.delete(sessionId);
    });
    route.providerProvisioningDispose?.();
    const child = options.windowHostProcessMap.get(route.webContentsId);
    if (route.pendingRendererAttachment) {
      const pending = route.pendingRendererAttachment;
      clearTimeout(pending.timeout);
      route.pendingRendererAttachment = undefined;
      if (child) detachServicePort(child, pending.attachmentId, "session-disposed");
      pending.reject(new Error(`远程 workspace session 已释放，sessionId=${sessionId}`));
    }
    if (!child) return;
    if (route.rendererAttachmentId) {
      child.postMessage({
        type: HostMessageTypes.DetachServicePort,
        attachmentId: route.rendererAttachmentId,
      });
    }
    child.postMessage({
      type: HostMessageTypes.DisposeRemoteWorkspaceSession,
      requestId: randomUUID(),
      remoteSessionId: sessionId,
    });
  }

  // 窗口关闭/销毁时的兜底清理：该窗口拥有的所有 route 都必须回收，
  // 否则 Host child 已退出但注册表仍保留条目，后续同 sessionId join 会命中死 route。
  // 按 webContentsId 过滤而不是按 win 引用：窗口对象可能已被销毁，id 仍然稳定。
  // 先 snapshot 再遍历，dispose 过程会修改 Map。
  function disposeRemoteWorkspaceSessionsForWindow(webContentsId: number): void {
    for (const [key, pending] of pendingProjectNavigations) {
      if (pending.win.webContents.id !== webContentsId) continue;
      pendingProjectNavigations.delete(key);
      pending.reject(new Error("窗口已关闭，项目导航已取消"));
    }

    for (const [sessionId, route] of Array.from(routesBySessionId)) {
      if (route.webContentsId !== webContentsId) continue;
      retireActiveRoute(route, "window-closed", () => {
        routesBySessionId.delete(sessionId);
      });
      route.providerProvisioningDispose?.();
      if (route.pendingRendererAttachment) {
        clearTimeout(route.pendingRendererAttachment.timeout);
        route.pendingRendererAttachment.reject(new Error("窗口已关闭，attachment 已取消"));
      }
    }
    for (const [key, pending] of Array.from(pendingByRequestKey)) {
      if (pending.webContentsId !== webContentsId) continue;
      pendingByRequestKey.delete(key);
      pending.reject(new Error("窗口已关闭，远程连接已取消"));
    }
    for (const [key, pending] of Array.from(pendingWorkspaceBindsByRequestKey)) {
      if (!key.startsWith(`${webContentsId}\0`)) continue;
      pendingWorkspaceBindsByRequestKey.delete(key);
      clearTimeout(pending.timeout);
      pending.reject(new Error("窗口已关闭，workspace bind 已取消"));
    }
  }

  // [失败路径] 取消"尚未完成"的请求，而不是取消已建立会话：
  // 前者只需 reject 并从 Map 删除，后者必须走完整的 Host dispose。
  // 这里遍历所有 pending 而不是按 requestId 索引，因为窗口关闭时拿不到原始 requestId，
  // 只能按 webContentsId 归属过滤（INV-16 的同一思路）。
  function cancelPendingRemoteWorkspaceSessionsForWindow(
    webContentsId: number,
    _reason: string,
    requestId?: string,
  ): void {
    const child = options.windowHostProcessMap.get(webContentsId);
    if (!child) return;
    for (const [key, pending] of pendingProjectNavigations) {
      if (
        pending.win.webContents.id !== webContentsId ||
        (requestId && pending.requestId !== requestId)
      )
        continue;
      pendingProjectNavigations.delete(key);
      child.postMessage({
        type: HostMessageTypes.CancelRemoteWorkspaceConnect,
        requestId: pending.requestId,
      });
      pending.reject(new Error("项目导航已取消"));
    }
    for (const pending of pendingByRequestKey.values()) {
      if (
        pending.webContentsId === webContentsId &&
        (!requestId || pending.requestId === requestId)
      ) {
        child.postMessage({
          type: HostMessageTypes.CancelRemoteWorkspaceConnect,
          requestId: pending.requestId,
        });
      }
    }
  }

  // 供"打开前先问一句"的调用方使用：只判断是否已有会话，不建连、不加锁。
  // [权衡] 用 isSameRemoteTarget 做线性扫描而不是维护反向索引：
  // 会话数量是个位数，索引的维护成本与一致性风险都更高。
  // 返回 true 不代表端口可用，调用方仍需走 connect 才能拿到 sessionId。
  function hasRemoteWorkspaceSessionForTarget(
    win: BrowserWindow,
    target: RemoteTarget,
    context?: RemoteWorkspaceSessionContext,
  ): boolean {
    const workspaceKey = context ? resolveWorkspaceKey(context) : undefined;
    return Array.from(routesBySessionId.values()).some(
      (route) =>
        route.webContentsId === win.webContents.id &&
        route.attachmentState === "attachable" &&
        isSameRemoteTarget(route.descriptor.target, target) &&
        (!workspaceKey ||
          resolveWorkspaceKey({
            workspacePath: route.descriptor.workspacePath ?? "",
            workspaceIdentity: route.descriptor.workspaceIdentity,
          }) === workspaceKey),
    );
  }

  // [并发] web-remote 专用的同步旁路：不经过 pending，直接复用现有 route 的
  // attachment 或触发一次 attach。因为同步返回，所有校验必须在函数体内做完，
  // 不能留给后续事件——调用方拿到返回值后就会立刻 transfer port。
  // 校验覆盖：route 存在、状态 attachable、窗口归属、descriptor 与请求参数一致。
  // 任何一项不满足都抛错，让 web-remote 走普通 connect 流程。
  function attachRemoteWorkspaceSessionHost(params: {
    windowId: number;
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspaceKey: string;
    clientMode: "web-remote-replayable";
  }): {
    process: ElectronUtilityProcess;
    port: MessagePortMain;
    remoteKind: RemoteTarget["kind"];
  } {
    // 先按 sessionId 精确查找，再做后续校验：sessionId 是 Host 下发的逻辑 id，
    // 比 workspacePath 更稳定，用它作为第一道匹配可以避免路径归一化差异带来的误判。
    // 查不到直接抛错，让 web-remote 回退到普通 connect。
    const route = routesBySessionId.get(params.remoteSessionId);
    if (!route) {
      // 带上稳定的 code 而不是只给人类可读消息：web-remote 需要据此决定
      // 是提示用户重新连接（MISSING），还是仅展示离线（OFFLINE）。
      // route 不存在时不能尝试"顺手新建"——那会绕过 create 的窗口与去重守卫。
      throw Object.assign(
        new Error(`未找到远程 workspace session，sessionId=${params.remoteSessionId}`),
        {
          code: "REMOTE_SESSION_MISSING" as const,
        },
      );
    }
    // closed 状态必须在这里拒绝：closed route 的 port 已被 Host 丢弃，
    // 再 attach 会得到一个"投递成功但永远无响应"的端口。
    // 不复用"关闭后重新打开"的语义：那属于新建连接，必须走 create 流程重新拿 sessionId。
    if (route.attachmentState !== "attachable") {
      throw Object.assign(new Error("远程 workspace source 当前离线"), {
        code: "REMOTE_SESSION_OFFLINE" as const,
      });
    }
    // windowId 来自 web-remote 请求，可能对应一个已销毁的窗口：
    // fromId 返回的引用不代表 webContents 仍存活，下面还要再比对 route.webContentsId。
    const win = BrowserWindow.fromId(params.windowId);
    // 窗口归属与存活双重校验：web-remote 可能用一个已 reload 的 windowId 来请求，
    // 此时 route 仍指向旧 webContents，port 必须拒绝投递而不是发给新窗口。
    if (!win || win.webContents.id !== route.webContentsId) {
      // 归属校验失败比"不存在"更危险：说明调用方持有的是别人的 sessionId。
      // 用独立 code 让上层可以记录一次越权尝试，而不是当成普通离线。
      // 这里不返回 route 的任何信息，避免泄露其它窗口的 workspace 路径。
      throw Object.assign(new Error("远程 workspace session 不属于当前窗口"), {
        code: "REMOTE_SESSION_WINDOW_MISMATCH" as const,
      });
    }
    const descriptor = route.descriptor;
    if (
      descriptor.workspacePath !== params.workspacePath ||
      descriptor.workspaceIdentity !== params.workspaceIdentity ||
      params.workspaceKey !== params.workspaceIdentity
    ) {
      throw Object.assign(new Error("远程 workspaceKey 与 logical session 不匹配。"), {
        code: "REMOTE_WORKSPACE_IDENTITY_MISMATCH" as const,
      });
    }
    const process = getWindowHost(win);
    const { port1, port2 } = createMessageChannel();
    process.postMessage(
      {
        type: HostMessageTypes.AttachServicePort,
        requestId: randomUUID(),
        attachmentId: randomUUID(),
        clientMode: params.clientMode,
        scope: {
          kind: "remote",
          remoteSessionId: params.remoteSessionId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        },
      },
      [port2],
    );
    return { process, port: port1, remoteKind: descriptor.target.kind };
  }

  // 项目导航不是连接：Host 先准备 workspace，Main 只登记一个 mobileOnly 占位 route，
  // 并把 Promise 挂到 pendingProjectNavigations，等 ProjectWorkspacePrepared 消费。
  // 超时与窗口关闭都必须 reject 并删除：否则 pending 会随导航次数累积。
  // 这里不设 sessionId，因为 Host 在 prepared 事件里才会给出。
  function prepareProjectWorkspace(
    win: BrowserWindow,
    request: HostProjectWorkspaceNavigationInput,
    requestId: string = randomUUID(),
  ): Promise<HostPreparedProjectWorkspace> {
    // [事务] 退出屏障与窗口存活必须是同一道门：先判 appShutdownStarted 再判窗口，
    // 反过来的话窗口销毁路径会先返回"窗口已关闭"，掩盖"应用正在退出"这一根因。
    // 两者都成立时仍然抛错，绝不静默 resolve 一个空结果。
    if (appShutdownStarted || win.isDestroyed() || win.webContents.isDestroyed())
      return Promise.reject(new Error("窗口已关闭，项目导航已取消"));
    const child = getWindowHost(win);
    const key = requestKey(win.webContents.id, requestId);
    if (pendingProjectNavigations.has(key))
      return Promise.reject(new Error("项目导航 requestId 重复"));
    return new Promise((resolve, reject) => {
      pendingProjectNavigations.set(key, { child, win, requestId, resolve, reject });
      try {
        child.postMessage({
          type: HostMessageTypes.PrepareProjectWorkspace,
          requestId,
          ...request,
          clientMode: "web-remote-replayable",
        });
      } catch (error) {
        pendingProjectNavigations.delete(key);
        reject(error);
      }
    });
  }

  return {
    prepareProjectWorkspace,
    createRemoteWorkspaceSession,
    attachRemoteWorkspaceSessionHost,
    bindRemoteWorkspaceSessionContext,
    confirmRendererAttachmentReady,
    reattachRemoteWorkspaceSessionsForWindow,
    hasRemoteWorkspaceSessionForTarget,
    // 统计方法放在 dispose 之前不是随意的：调用方通常在"断开后调用一次统计"，
    // 保持它们在契约里的顺序可以降低 review 时的阅读成本。
    // getRemoteConnectionStats 只读，dispose 系列有副作用，混排会让人误以为统计会清理。
    getRemoteConnectionStats,
    disposeRemoteWorkspaceSession,
    disposeRemoteWorkspaceSessionsForWindow,
    disposeAllAndWaitForAppShutdown: async (_reason: string) => {
      // [并发] 屏障置位必须在第一轮清理之前：置位后所有新请求都会立即失败，
      // 保证下面遍历到的集合是"最终集合"，不会在清理途中又冒出新的 pending/route。
      // 置位后不可回退：即使后续清理失败，应用也已在退出流程中。
      appShutdownStarted = true;
      const error = new Error("应用正在退出，远程连接已取消");
      for (const pending of pendingProjectNavigations.values()) pending.reject(error);
      pendingProjectNavigations.clear();
      for (const pending of pendingByRequestKey.values()) pending.reject(error);
      pendingByRequestKey.clear();
      for (const pending of pendingWorkspaceBindsByRequestKey.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      pendingWorkspaceBindsByRequestKey.clear();
      for (const [sessionId, route] of Array.from(routesBySessionId)) {
        retireActiveRoute(route, "app-shutdown", () => {
          routesBySessionId.delete(sessionId);
        });
        route.providerProvisioningDispose?.();
        if (!route.pendingRendererAttachment) continue;
        clearTimeout(route.pendingRendererAttachment.timeout);
        route.pendingRendererAttachment.reject(error);
      }
      // 清表放在最后：前面的 route 回收依赖注册表里的对象，
      // 提前 clear 会让 retire 找不到自己而跳过统计与 renderer 通知。
      routesBySessionId.clear();
    },
    cancelPendingRemoteWorkspaceSessionsForWindow,
    // 任务数变化只触发遥测刷新，不做连接回收：
    // 远端任务全部结束不代表用户想关闭 workspace。
    // 该回调必须同步返回，遥测侧不应在状态迁移路径上 await。
    handleWorkspaceRunningTaskCountChanged: () => {
      // Running-task 事实现在由窗口 Host registry/ControllerProjection 持有；Main 不再维护 WSL pool。
    },
  };
}
