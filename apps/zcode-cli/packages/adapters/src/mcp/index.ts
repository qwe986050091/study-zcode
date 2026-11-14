/* ============================================================
 * MCP 适配器主实现（adapters/src/mcp/index.ts）
 *
 * 定位：适配器层唯一实现 McpPort 的类，负责 stdio/HTTP/SSE 三种 transport 的连接生命周期、
 * 工具/资源/订阅、OAuth Phase 2→Phase 1 编排、官方鉴权注入、遥测与进程树回收。
 * 输入：CreateMcpAdapterOptions（client 身份、网络策略、凭据 store、 elicitation/通知端口、
 * 官方鉴权依赖）与每次 connect/call 的 options。
 * 输出：McpPort（连接、状态、工具、资源、订阅、应用连接失效通知、关闭）。
 * 副作用：spawn 子进程/HTTP 连接、localhost OAuth 回调、网络请求、凭据落盘、定时器、日志。
 * 失败语义：连接失败写入 failed 状态并返回而非 reject（供设置页展示）；工具调用失败冒泡；
 * OAuth 编排异常收敛为 outcome；关闭全程 best-effort。
 * 不变量：每个 server 有单调 generation，异步结果回写前必须 isCurrentConnection 校验，
 * 迟到结果一律丢弃；connecting promise 归 record 生命周期所有，caller 只用 deadline 限制
 * 自己的等待；http+official 的结果才可被信任（stdio 结果可伪造）；日志绝不含 header 值/
 * token/参数值，stderr 落日志前必须脱敏。
 * ============================================================ */

// MCP 适配器主实现：唯一实现 McpPort 的类，覆盖 stdio/HTTP/SSE 三种 transport
// 的连接生命周期、工具与资源、订阅、OAuth 编排、遥测与 stdio 进程树回收
// 状态唯一源是 records，所有异步回写先过 generation fencing，迟到结果一律丢弃
// 失败收敛为 failed 状态而不 reject，关闭路径全程 best-effort
// INV-01 每个 server 的 generation 单调递增且只由 nextConnectionGeneration 分配；守住位置：nextConnectionGeneration 与 isCurrentConnection；改错故障：已换代连接的结果覆盖新连接，工具发往错误 server 且设置页状态错乱
// INV-02 record 是单 server 唯一状态源，config 必须与 generation 成对回写；守住位置：openServerConnection 与 failConnection 的 records.set；改错故障：新旧配置的 snapshot 交错，UI 展示的传输方式与实际连接不符
// INV-03 connecting promise 归 record 生命周期所有，caller 只按自己的 deadline 等待；守住位置：waitForSharedConnection 与 resolveConnectedRecord；改错故障：一个 caller 超时关掉他人共用的 OAuth 回调监听，多人同时授权一起失败
// INV-04 主动关闭与重连前必须先递增 generation 再拆连接；守住位置：disconnectServer、close、connectServer；改错故障：在途任务回写已关闭的 record，重连后立刻又被旧结果置为 failed
// INV-05 工具缓存以 toolsStale 标记失效，list_changed 只置位不在通知处理器里重拉；守住位置：installNotificationHandlers 与 listTools；改错故障：通知风暴被放大成请求风暴，回合内工具表漂移
// INV-06 工具列表刷新失败只 warn 并保留旧表；守住位置：listTools 的 catch 分支；改错故障：一次瞬时失败让整轮对话失去全部工具
// INV-07 Official 信任标记只在 http 形态置位；守住位置：openServerConnection 调用 normalizeMcpToolDescriptor 处；改错故障：stdio 插件伪造 quota_exceeded，用户看到误导性的额度用完提示
// INV-08 官方鉴权与 MCP OAuth 互斥，判定必须排在所有 OAuth 分支之前；守住位置：resolveAuthorizationCodeOAuthConfig 与 createOAuthClientProvider；改错故障：401 误转成 MCP 授权 UI，而该失败本应由 ZCode 登录与套餐解决
// INV-09 资源订阅登记表是本 adapter 唯一 owner，按 server、uri、subscriber 三键计数；守住位置：subscribeResource 与 unsubscribeResource；改错故障：共享连接上重复订阅或提前退订，会话收不到资源更新
// INV-10 登记表只能反映 server 已确认的订阅；守住位置：subscribeResource 的 catch 回滚；改错故障：server 未确认的订阅留在表里，重连重放时对不存在的 uri 反复失败
// INV-11 关闭路径先摘 onclose 再关 client；守住位置：closeClientAndTransport；改错故障：正常回收被记成意外断连，设置页闪出误导性崩溃提示
// INV-12 stdio 进程必须按进程树回收，SDK close 只保证直接子进程退出；守住位置：closeClientAndTransport 与 terminateStdioProcessTree；改错故障：npx wrapper 与 watchdog 残留，反复重连后堆积孤儿进程
// INV-13 stdio stderr 落日志前必须脱敏并截断到上限；守住位置：attachStdioLogging 与 sanitizeMcpStdioStderr；改错故障：token 或密码写进生产日志，不可撤销
// INV-14 日志绝不含 header 值、token 与工具参数值；守住位置：resolveOfficialStdioAuthMeta 与 callToolOnClientInner；改错故障：用户输入与凭据进入日志留存周期
// INV-15 serverRequestId 按 span 存取且即取即删，不做取最近一条的兜底；守住位置：rememberServerResponse 与 takeServerRequestId；改错故障：上一次调用的 id 被贴到这一次的失败上，服务端排查被误导
// INV-16 Phase 2 授权事务寿命 300 秒，与 caller 等待预算解耦；守住位置：runInteractiveOAuthAuthorization 与 waitForSharedConnection；改错故障：15 秒硬关让真人来不及在浏览器完成授权
// INV-17 运行期 OAuth 恢复单飞且不得 abort 共享事务；守住位置：ensureToolCallAuthorizationRecovery；改错故障：并发调用各自起授权，callback listener 被互相关闭
// INV-18 failConnection 是唯一失败收口且必须是 total；守住位置：openServerConnection、runToolCallAuthorizationRecovery、runInteractiveOAuthAuthorization；改错故障：connecting 变成 rejected，connectConfiguredServers 整批失败
// INV-19 主动退订失败不得回滚登记表；守住位置：unsubscribeOnServer；改错故障：登记表与 server 状态反向漂移，退订后仍然收到通知
import {
  Client,
  ClientCredentialsProvider,
  computeScopeUnion,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnsupportedProtocolVersionError,
  type AuthProvider,
  type OAuthClientProvider,
  type VersionNegotiationMode,
  type VersionNegotiationOptions,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type {
  Logger,
  McpCallToolOptions,
  McpCallToolRequest,
  McpConnectionSnapshot,
  McpConnectOptions,
  McpContentBlock,
  McpElicitationPort,
  McpElicitationTrace,
  McpListResourcesRequest,
  McpListResourcesResult,
  McpListResourceTemplatesResult,
  McpNotificationPort,
  McpOAuthConfig,
  McpPort,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpResourceSubscriptionRequest,
  McpServerConfig,
  McpServerStatus,
  McpToolCallResult,
  McpToolDescriptor,
  OfficialMcpAuthFailureReason,
  OfficialMcpAuthHeadersPort,
  OfficialMcpTrustedOriginRegistry,
} from "@zcode/contracts";
import {
  McpResourceSubscribeUnsupportedError,
  ZCODE_MCP_SERVER_REQUEST_ID_META_KEY,
} from "@zcode/contracts";
import {
  OFFICIAL_MCP_AUTH_META_KEY,
  ZCODE_OFFICIAL_MCP_AUTH_TYPE,
  type McpServerFailureKind,
  type OfficialMcpAuthFailureKind,
} from "@zcode/shared";
import { buildMcpAppsClientCapabilities } from "@zcode/shared/mcp-apps";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "../auth/shared-credentials.js";
import { normalizeMcpToolDescriptor } from "./descriptor.js";
import {
  buildMcpStdioEnv,
  createMcpTransportFetch,
  type NetworkEgressEnvPolicy,
} from "./network.js";
import { loadCredentialPair } from "./oauth-credentials.js";
import {
  classifyInteractiveAuthorizationTrigger,
  type InteractiveAuthorizationTrigger,
} from "./oauth-errors.js";
import {
  MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS,
  runMcpInteractiveAuthorization,
  type McpInteractiveAuthorizationOutcome,
} from "./oauth-interactive.js";
import { createMcpOAuthTokenProvider } from "./oauth-provider.js";
import {
  createCredentialKeyPrefix,
  type McpOAuthAuthorizationContext,
  type McpOAuthRuntimeOptions,
} from "./oauth.js";
import {
  createOfficialMcpAuthFetch,
  OfficialMcpAuthError,
  type OfficialMcpServerResponseInfo,
} from "./official-auth.js";
import {
  createMcpConnectionPool,
  type McpConnectionContext,
  type McpConnectionPool,
} from "./pool.js";
import { terminateMcpStdioProcessTree } from "./process-tree.js";
import { McpResourceSubscriptionRegistry } from "./resource-subscriptions.js";
import { ProcessTreeStdioClientTransport } from "./stdio-transport.js";
import type { McpTelemetryTracker } from "./telemetry.js";
import {
  createMcpDeadline,
  McpTimeoutError,
  remainingMcpDeadlineMs,
  waitWithinMcpDeadline,
  withTimeout,
  type McpDeadline,
} from "./timeout.js";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
// 存活探测只允许占用很短的时间：它挂在设置页刷新的同步路径上，超时即判死并触发重连。
// [权衡] 存活探测上限 5 秒：它挂在设置页刷新链路上，宁可误判为断连也不能拖住整页
// [失败路径] 探测超时把状态写成 disconnected，代价是可能打断一个只是慢的 server，由下一次调用重连补回
const MCP_PING_TIMEOUT_MS = 5_000;
const MAX_MCP_VERSION_PROBE_TIMEOUT_MS = 5_000;
const MCP_STDIO_STDERR_LOG_MAX_CHARS = 4_000;
/**
 * span → request id 的暂存条数上限。正常情况下每条都会在同一次 tool call 结束时被取走，
 * 留下的只有无人认领的（如连接期请求），几十条足够，纯为防止长会话下无界增长。
 */
// [资源] span 到 requestId 的暂存表必须有界，正常条目在单次工具调用结束时即被取走
// [资源] 无人认领的条目只靠挤出淘汰，64 条足以覆盖连接期请求而不让长会话无界增长
const MAX_TRACKED_SERVER_REQUEST_IDS = 64;

/**
 * 适配器构造参数。
 * clientName/clientVersion：MCP initialize 中声明的客户端身份；
 * connectionContext：来自连接池的隔离上下文（缺省独立 adapter）；
 * env/network：子进程环境与代理/CA 策略；
 * telemetry：可选旁路；mcpOAuth：授权回调/凭据 store 等宿主注入；
 * officialMcpAuth：官方 MCP 鉴权依赖，trustedOrigins 缺失时 fail closed。
 */
// [权衡] 依赖全部从构造参数注入，适配器自身不读环境与全局单例，多 workspace 可并行
// [失败路径] officialMcpAuth 或 trustedOrigins 缺失时 fail closed，绝不退化为匿名直发
// [事务] connectionContext 决定连接池归属与遥测关联，缺省时该 adapter 独立拥有全部 server
export interface CreateMcpAdapterOptions {
  clientName?: string;
  clientVersion?: string;
  connectionContext?: McpConnectionContext;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  telemetry?: McpTelemetryTracker;
  mcpOAuth?: McpOAuthRuntimeOptions;
  network?: NetworkEgressEnvPolicy;
  /**
   * 官方 Server MCP 鉴权依赖。trustedOrigins 缺失时仍 fail closed；authHeadersPort
   * 可缺省，此时各请求匿名降级并交给服务端做权威判定。
   */
  officialMcpAuth?: {
    authHeadersPort?: OfficialMcpAuthHeadersPort;
    trustedOrigins: OfficialMcpTrustedOriginRegistry;
    /**
     * 当前 ZCode API origin。stdio 形态没有 `url` 可供校验，targetOrigin 只能由宿主给出
     * ——插件因此无法把身份头导向别的 origin。
     * 与 trustedOrigins 的 `resolveZCodeApiOrigin` 必须同源，否则两侧判定会分叉。
     */
    resolveZCodeApiOrigin?: () => string;
    workspaceIdentity?: string;
  };
  workingDirectory?: string;
  /** 有此端口才向 server 宣告 elicitation 能力；缺省时 server 的 elicitation/create 收到 method not found。 */
  elicitation?: McpElicitationPort;
  /** server → client 通知（资源更新 / 列表变化 / 工具列表变化 / 日志）的出口；缺省只记 debug。 */
  notifications?: McpNotificationPort;
}

type McpClient = Client;
type McpTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
type AuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

/**
 * stdio 官方 MCP 的身份头载荷，随每条出站协议消息的 `_meta` 下发。
 *
 * 失败也下发（`ok: false` + 枚举 reason）；stdio 插件拿不到头时不会去打官方端点。HTTP 路径则
 * 由 adapter 发起无身份的 tools/call，让 ZCode server 返回权威结构化错误。把 reason 交给 stdio
 * 插件才能让它把"未登录"与"无 Coding Plan
 * 套餐"如实呈现给用户，而不是静默降级成一句莫名其妙的失败。
 */
/**
 * stdio 官方 MCP 的逐请求身份载荷。
 * ok:true 时 headers 完整下发；ok:false 时 reason 必须如实透传，让插件区分
 * “宿主不支持/未登录/无套餐”而不是静默降级。任何情况下都不缓存该载荷。
 */
type OfficialMcpAuthMetaPayload =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

/** 订阅的 server → client 通知方法名（MCP 规范）。 */
/** 工具列表变更通知方法名（server → client）。 */
export const MCP_NOTIFICATION_TOOLS_LIST_CHANGED = "notifications/tools/list_changed";
/** 资源内容更新通知方法名（携带 uri）。 */
export const MCP_NOTIFICATION_RESOURCES_UPDATED = "notifications/resources/updated";
/** 资源列表变更通知方法名。 */
export const MCP_NOTIFICATION_RESOURCES_LIST_CHANGED = "notifications/resources/list_changed";
/** 服务端日志消息通知方法名（转发为 ZCode 日志，不进入工具结果）。 */
export const MCP_NOTIFICATION_MESSAGE = "notifications/message";

/**
 * 单 server 的运行时记录（adapter 内部唯一状态源）。
 * config：当前配置快照（与 generation 配对，旧任务回写时必须校验）；
 * status：对外状态快照；tools：最近一次成功列出的工具；
 * connecting：共享连接/恢复 promise，caller 只能等待不能取消；
 * toolsStale：收到 list_changed 后置位；transport/abortController 为回收句柄。
 */
// [事务] record 是单 server 唯一状态源，config 与 generation 成对出现，回写前必须比对
// [并发] connecting 让多个 caller 共享同一次连接或 OAuth 恢复，caller 只能等待不能取消
// [资源] abortController 与 transport 是回收句柄，只在 closeRecord 与 failConnection 内释放
interface McpServerRecord {
  client?: McpClient;
  abortController?: AbortController;
  connecting?: Promise<McpServerStatus>;
  config: McpServerConfig;
  status: McpServerStatus;
  tools: McpToolDescriptor[];
  /** 收到 tools/list_changed 后置位，下一次 listTools 重拉。 */
  toolsStale?: boolean;
  transport?: McpTransport;
}

/** resources/list 项：只透传标准字段（含 _meta），丢掉 SDK 附加的运行时字段。 */
/**
 * 读取 resources/list 项的标准字段。includeUri=false 用于模板（uriTemplate 另行拼接）；
 * 缺字段即省略而不是填 undefined；_meta 仅在纯对象时透传。无副作用、不抛错。
 */
// [权衡] 只透传标准字段与 _meta，丢掉 SDK 附带的运行时字段，契约不随 SDK 版本漂移
// [失败路径] 缺字段一律省略而不是填 undefined，调用方拿到的是可直接序列化的干净对象
function pickResourceDescriptor(
  resource: unknown,
  includeUri = true,
): {
  uri?: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
} {
  const item = isRecord(resource) ? resource : {};
  return {
    ...(includeUri ? { uri: typeof item.uri === "string" ? item.uri : "" } : {}),
    ...(typeof item.name === "string" ? { name: item.name } : {}),
    ...(typeof item.title === "string" ? { title: item.title } : {}),
    ...(typeof item.description === "string" ? { description: item.description } : {}),
    ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
    ...(isRecord(item._meta) ? { _meta: item._meta } : {}),
  };
}

/** 构造单连接 adapter；options 缺省即最小配置（无网络策略、无遥测、无端口）。 */
// [事务] 工厂不缓存实例，每次调用得到独立的 records 与订阅登记表，测试之间互不干扰
// [资源] 每个实例持有自己的 stdio 子进程与 HTTP 连接，close 时由该实例统一回收
export function createMcpAdapter(options: CreateMcpAdapterOptions = {}): McpPort {
  return new NodeMcpAdapter(options);
}

/**
 * 构造带共享连接池的 McpPort 工厂。
 * 工厂把连接池传入的 connectionContext/workingDirectory 合并进每个 adapter，
 * 其余选项（网络、OAuth、遥测、端口）在池内所有 connection 间共享。
 */
export function createMcpAdapterConnectionPool(
  options: CreateMcpAdapterOptions = {},
): McpConnectionPool {
  return createMcpConnectionPool({
    logger: options.logger,
    telemetry: options.telemetry,
    createAdapter: ({ connectionContext, workingDirectory }) =>
      createMcpAdapter({
        ...options,
        connectionContext,
        workingDirectory: workingDirectory ?? options.workingDirectory,
      }),
  });
}

export {
  createMcpConnectionPool,
  type McpConnectionPool,
  type McpConnectionPoolOptions,
} from "./pool.js";
export {
  createMcpTelemetryTracker,
  resolvePluginName,
  type McpTelemetryTracker,
  type McpTrackedProcess,
} from "./telemetry.js";

/** elicitation 模式白名单（MCP form 与 兼容别名）。 */
const SUPPORTED_ELICITATION_MODES = new Set(["form", "openai/form", "openaiForm"]);
/** elicitation 模式白名单：缺省（undefined）视为 form；其它未知模式一律 decline。 */
function isSupportedElicitationMode(mode: unknown): boolean {
  return mode === undefined || (typeof mode === "string" && SUPPORTED_ELICITATION_MODES.has(mode));
}

/**
 * 单连接 MCP 适配器。
 *
 * 所有 server 状态在 records（name → record），所有异步任务都用 generation fencing；
 * credentialStore 惰性创建（同一 adapter 内多个 server 共享一个 shared store）；
 * 资源订阅登记表为本 adapter 唯一 owner，连接重连后会按表重放。
 * 生命周期：connectConfiguredServers/connectServer → 使用 → close（幂等、只回收一次）。
 */
// [事务] 全部 server 状态集中在 records，构造后不从外部写入，保证单一写入口
// [资源] credentialStore 惰性创建并在实例内复用，多个 server 共享同一份磁盘凭据
// [并发] appConnectionListeners 按 serverName 分组，换代时同步通知持有旧连接的 UI
class NodeMcpAdapter implements McpPort {
  private readonly adapterInstanceId = randomUUID();
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly connectionContext?: McpConnectionContext;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly logger?: Logger;
  private readonly mcpOAuth?: McpOAuthRuntimeOptions;
  private readonly network?: NetworkEgressEnvPolicy;
  private readonly officialMcpAuth?: CreateMcpAdapterOptions["officialMcpAuth"];
  private readonly telemetry?: McpTelemetryTracker;
  private readonly connectionGenerations = new Map<string, number>();
  private credentialStore?: SharedZCodeCredentialStore;
  /**
   * 官方鉴权失败分类的暂存槽。不能从 error 对象读——SDK 的 version
   * negotiation 会把 OfficialMcpAuthError 重新包装成普通 Error，instanceof 失效；
   * 也不允许按错误文本反解。因此在抛出点写入，failConnection 取用后立即清除。
   */
  private readonly lastOfficialAuthKind = new Map<string, OfficialMcpAuthFailureKind>();
  /**
   * span → 服务端 request id。只有官方 MCP 会写入（唯一能看到响应头的地方是 auth fetch
   * wrapper），供 in-band 失败（HTTP 200 + `isError`）把 id 带回 tool result。
   *
   * 用 span 而不是 traceId 作键：traceId 覆盖整个顶层 session，同一 session 的多次调用
   * 共用它，关联会串号；span 是一次 tool call 的粒度。
   *
   * 有界并即取即删：拿不到匹配的 span（如 initialize / tools/list，它们没有 `_meta`）
   * 就让条目自然被挤出，绝不"取最近一次"兜底——那会把上一次调用的 id 贴到这一次的失败上。
   */
  private readonly serverRequestIdBySpan = new Map<string, string>();
  private readonly connectionDiagnosticByServer = new Map<
    string,
    Pick<McpServerStatus, "failureKind" | "serverRequestId">
  >();
  private readonly records = new Map<string, McpServerRecord>();
  private readonly workingDirectory?: string;
  private readonly elicitation?: McpElicitationPort;
  private readonly notifications?: McpNotificationPort;
  /** 资源订阅登记表 serverName → uri → subscriberKey；唯一 owner，连接层计数。 */
  private readonly resourceSubscriptions = new McpResourceSubscriptionRegistry();
  /** tools/list_changed 累计次数，runtime 按此判断是否需要重注册。 */
  private toolListRevisionCounter = 0;
  /** 每个 server 当前正在执行的工具调用 trace；elicitation 借此归属到会话 / 工具行。 */
  private readonly activeCallTraces = new Map<string, McpElicitationTrace>();

  constructor(options: CreateMcpAdapterOptions) {
    this.clientName = options.clientName ?? "zcode";
    this.clientVersion = options.clientVersion ?? "0.0.0";
    this.connectionContext = options.connectionContext;
    this.env = options.env;
    this.logger = options.logger?.child({
      ...this.connectionContext,
      module: "adapters.mcp",
    });
    this.mcpOAuth = options.mcpOAuth;
    this.network = options.network;
    this.officialMcpAuth = options.officialMcpAuth;
    this.telemetry = options.telemetry;
    this.workingDirectory = options.workingDirectory;
    this.elicitation = options.elicitation;
    this.notifications = options.notifications;
  }

  /**
   * 全量收敛：先断开不再配置的 server，再逐个连接（相同配置且正在 OAuth 等待的任务复用）。
   * 最后汇总 statuses/tools 并记录耗时与状态分布。
   * 失败语义：单个连接失败不会 reject（状态为 failed）；但 Promise.all 中真正的异常仍会冒泡。
   */
  // [事务] 全量收敛分两步：先断开已不在配置里的 server，再并发连接，旧连接不会继续占端口
  // [并发] 同配置且正在 OAuth 等待的 record 直接复用 connecting，重连会让浏览器里已打开的授权页失效
  // [失败路径] 单个连接失败只落 failed 状态，不 reject 整批；真正的异常仍冒泡给调用方
  async connectConfiguredServers(
    servers: Record<string, McpServerConfig>,
    options: McpConnectOptions = {},
  ): Promise<McpConnectionSnapshot> {
    const startedAt = Date.now();
    const serverNames = Object.keys(servers);
    this.logger?.info("MCP configured servers connection started", {
      event: "mcp.configured_servers.connect.started",
      serverCount: serverNames.length,
      serverNames,
      status: "started",
    });
    const configuredNames = new Set(Object.keys(servers));
    await Promise.all(
      Array.from(this.records.keys())
        .filter((name) => !configuredNames.has(name))
        .map((name) => this.disconnectServer(name)),
    );

    await Promise.all(
      Object.entries(servers).map(([name, config]) => {
        const record = this.records.get(name);
        if (
          record?.connecting &&
          record.status.status === "connecting" &&
          record.status.authorization &&
          isDeepStrictEqual(record.config, config)
        ) {
          // 相同配置的全量收敛可能与 OAuth callback 等待重叠；重新 connect
          // 会关闭原 session，使浏览器中已打开的授权 URL、PKCE/state 和 callback 一并失效。
          // 连接生命周期可以共享，但 Session 的 15 秒等待预算和 AbortSignal 不能继承设置页的 5 分钟预算。
          return this.waitForSharedConnection(name, record, options);
        }
        return this.connectServer(name, config, options);
      }),
    );

    const statuses = await this.status();
    const tools = await this.listTools();
    const statusCounts = Object.values(statuses).reduce<Record<string, number>>(
      (counts, status) => {
        counts[status.status] = (counts[status.status] ?? 0) + 1;
        return counts;
      },
      {},
    );
    this.logger?.info("MCP configured servers connection completed", {
      durationMs: Date.now() - startedAt,
      event: "mcp.configured_servers.connect.completed",
      serverCount: serverNames.length,
      status: "completed",
      statusCounts,
      toolCount: tools.length,
    });
    return {
      statuses,
      tools,
    };
  }

  /**
   * 连接单个 server。
   *
   * 分配新 generation、清理旧诊断、关闭旧 record；disabled 直接返回 disabled 状态（不建连接）。
   * 外部 signal 通过桥接 AbortController 传入底层；connecting promise 写入 record 后，
   * 调用方只按自己的预算等待共享任务（不取消共享任务本身）。
   * 返回连接后（或等待预算耗尽时）的状态快照，失败由 openServerConnection 转为 failed 状态。
   */
  // [事务] 先分配 generation 再 closeRecord，在途旧任务的结果因 generation 过期被丢弃
  // [并发] record 挂进 records 之后才可能被其它 caller 复用，connecting 的写入时机必须先于等待
  // [权衡] oauthAuthorizationTimeoutMs 只约束本 caller 的等待，连接与 300 秒授权事务在后台继续
  async connectServer(
    name: string,
    config: McpServerConfig,
    options: McpConnectOptions = {},
  ): Promise<McpServerStatus> {
    const startedAt = Date.now();
    const timeoutMs = config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    const generation = this.nextConnectionGeneration(name);
    this.lastOfficialAuthKind.delete(name);
    this.connectionDiagnosticByServer.delete(name);
    this.logger?.info("MCP server connection started", {
      event: "mcp.server.connect.started",
      mcpServerName: name,
      status: "started",
      timeoutMs,
      transport: config.type,
    });
    await this.closeRecord(name);

    if (config.enabled === false) {
      const status = this.createStatus(config, "disabled");
      this.records.set(name, { config, status, tools: [] });
      this.logger?.info("MCP server connection skipped", {
        durationMs: Date.now() - startedAt,
        event: "mcp.server.connect.skipped",
        mcpServerName: name,
        status: "completed",
        transport: config.type,
      });
      return status;
    }

    const abortController = new AbortController();
    const abortExternal = () => {
      abortController.abort(
        options.signal?.reason instanceof Error ? options.signal.reason : undefined,
      );
    };
    if (options.signal?.aborted) {
      abortExternal();
    } else {
      options.signal?.addEventListener("abort", abortExternal, { once: true });
    }

    const connectingStatus = this.createStatus(config, "connecting");
    const record: McpServerRecord = {
      abortController,
      config,
      status: connectingStatus,
      tools: [],
    };
    this.records.set(name, record);
    const connecting = this.openServerConnection({
      config,
      generation,
      name,
      oauthAuthorizationTimeoutMs: options.oauthAuthorizationTimeoutMs,
      signal: abortController.signal,
      timeoutMs,
      workingDirectory: options.workingDirectory,
    }).finally(() => {
      options.signal?.removeEventListener("abort", abortExternal);
    });
    record.connecting = connecting;
    // 过去 `oauthAuthorizationTimeoutMs`（session 的 15 秒）被当成 OAuth 事务寿命，
    // 15 秒后连同 callback listener 一起关掉，真人根本来不及在浏览器里完成授权（现场证据：
    // 一次成功授权耗时约 74 秒）。现在它只作为**本 caller 的等待预算**：到点返回当时的
    // snapshot（含授权 URL），后台连接与 300 秒授权事务继续存活。
    return await this.waitForSharedConnection(name, record, options);
  }

  /**
   * 主动断开：递增 generation 使所有在途结果作废，关闭 client/transport，
   * 再把 record 重置为 disconnected（保留 config，便于后续重连）。
   * 不存在的 server 返回 undefined；副作用为杀进程/关连接，失败在 close 内吞掉。
   */
  // [事务] 递增 generation 使在途结果作废，保留 config 以便后续按原配置重连
  // [资源] 关闭 client 与 transport 并回收 stdio 进程树，失败只在关闭路径内降级为日志
  async disconnectServer(name: string): Promise<McpServerStatus | undefined> {
    const record = this.records.get(name);
    if (!record) return undefined;

    this.nextConnectionGeneration(name);
    await this.closeRecord(name);
    const status = this.createStatus(record.config, "disconnected");
    this.records.set(name, {
      config: record.config,
      status,
      tools: [],
    });
    return status;
  }

  /** 所有 server 的状态快照（浅拷贝引用，调用方不应修改）；无副作用。 */
  async status(): Promise<Record<string, McpServerStatus>> {
    return Object.fromEntries(
      Array.from(this.records.entries()).map(([name, record]) => [name, record.status]),
    );
  }

  // HTTP/SSE MCP 服务被停掉时不会派发 onclose（没有常驻流可断），record 会长期停在
  // connected；设置页刷新读到的就是这份"无声死亡"的旧快照，看起来像刷新按钮没生效。
  // ping 是 MCP 基础协议方法，用它把 transport 存活性显式化。
  /**
   * 存活探测：未连接返回 false；超时取 min(给定值, server timeout)。
   * 对端返回 JSON-RPC 错误算“活着”；真正的超时/断连才把状态置 disconnected。
   * generation 校验保证迟到的探测结果不会改写新连接的状态。
   */
  // [失败路径] 对端回 JSON-RPC 错误说明连接活着，不能据此拆连接，只有超时与断连才置 disconnected
  // [并发] 探测前后比对 generation，迟到的探测结果不会改写新连接的状态
  async pingServer(name: string, options: { timeoutMs?: number } = {}): Promise<boolean> {
    const record = this.records.get(name);
    if (!record?.client || record.status.status !== "connected") {
      return false;
    }
    const timeoutMs = Math.min(
      options.timeoutMs ?? MCP_PING_TIMEOUT_MS,
      record.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    );
    const generation = this.connectionGenerations.get(name) ?? 0;
    try {
      await record.client.ping({ timeout: timeoutMs });
      return true;
    } catch (error) {
      // server 回了 JSON-RPC 错误（例如未实现 ping）说明连接本身是活的，不能据此拆连接。
      if (isPeerAnsweredError(error)) {
        return true;
      }
      if (!this.isCurrentConnection(name, generation)) return false;
      const current = this.records.get(name);
      if (current && current.client === record.client) {
        current.status = this.createStatus(current.config, "disconnected", {
          error: "MCP server did not answer ping",
          failureKind: "unexpected_disconnect",
        });
      }
      this.logger?.warn("MCP server ping failed", {
        ...this.connectionContext,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.server.ping.failed",
        mcpServerName: name,
        status: "failed",
        transport: record.config.type,
      });
      return false;
    }
  }

  /** 工具表修订号：list_changed 递增；纯内存读取。 */
  toolListRevision(): number {
    return this.toolListRevisionCounter;
  }

  /**
   * 返回全部工具。
   * 先对 toolsStale 的已连接 server 重新 listTools（失败只 warn、保留旧表），
   * 再汇总；工具描述符在此完成命名空间归一化（official 信任标记仅 http 生效）。
   */
  // [并发] toolsStale 只在 list_changed 时置位，下一次读取统一重拉，通知风暴不会放大成请求风暴
  // [失败路径] 刷新失败只 warn 并保留旧工具表，短暂陈旧优于整轮对话失去工具
  // [权衡] 只在 caller 回合开始前刷新，保证回合内工具表稳定，模型看到的是同一份工具集
  async listTools(): Promise<McpToolDescriptor[]> {
    // 收到 notifications/tools/list_changed 的 server 在下一次 listTools 时重新拉取
    // （runtime 只在回合开始前调用，回合内工具表不变）。
    for (const [name, record] of this.records) {
      if (!record.toolsStale || !record.client || record.status.status !== "connected") continue;
      try {
        const listed = await record.client.listTools();
        record.tools = listed.tools.map((tool) =>
          normalizeMcpToolDescriptor(
            name,
            tool,
            record.config.timeoutMs,
            record.config.type === "http" &&
              record.config.auth?.type === ZCODE_OFFICIAL_MCP_AUTH_TYPE,
          ),
        );
        record.status = { ...record.status, toolCount: record.tools.length };
        record.toolsStale = false;
        this.logger?.info("MCP tool list refreshed after list_changed", {
          event: "mcp.tools.refreshed",
          mcpServerName: name,
          toolCount: record.tools.length,
        });
      } catch (error) {
        this.logger?.warn("MCP tool list refresh failed", {
          event: "mcp.tools.refresh_failed",
          mcpServerName: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return Array.from(this.records.values()).flatMap((record) => record.tools);
  }

  /** `resources/list`，分页游标透传。 */
  /** 资源列表：连接等待 + 分页游标透传；游标缺失时不传空对象以外的字段。 */
  // [失败路径] 连接等待与请求共用同一 deadline，超时文案带操作名与 server 名便于定位
  // [资源] 分页游标原样透传且不缓存结果，server 侧变化能立刻被读到
  async listResources(
    request: McpListResourcesRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpListResourcesResult> {
    const { record, deadline, timeoutMessage } = await this.resolveForResourceRequest(
      request.serverName,
      "resources/list",
      options,
    );
    const result = await record.client.listResources(
      request.cursor ? { cursor: request.cursor } : {},
      { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
    );
    return {
      resources: (result.resources ?? []).map((resource) => {
        const { uri, ...rest } = pickResourceDescriptor(resource);
        return { uri: uri ?? "", ...rest };
      }),
      ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
    };
  }

  /** 资源模板列表：uriTemplate 原样保留，其余标准字段走 pickResourceDescriptor。 */
  async listResourceTemplates(
    request: McpListResourcesRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpListResourceTemplatesResult> {
    const { record, deadline, timeoutMessage } = await this.resolveForResourceRequest(
      request.serverName,
      "resources/templates/list",
      options,
    );
    const result = await record.client.listResourceTemplates(
      request.cursor ? { cursor: request.cursor } : {},
      { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
    );
    return {
      resourceTemplates: (result.resourceTemplates ?? []).map((template) => {
        const item = template as Record<string, unknown>;
        return {
          uriTemplate: typeof item.uriTemplate === "string" ? item.uriTemplate : "",
          ...pickResourceDescriptor(item, false),
        };
      }),
      ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
    };
  }

  /**
   * 按 (serverName, uri) 计数的订阅。同一连接被多个 session 共享时只向 server 订阅一次；
   * server 没声明 resources.subscribe 能力 → McpResourceSubscribeUnsupportedError。
   */
  /**
   * 订阅资源：先校验 server 能力，再登记计数；仅 0→1 时向 server 发 subscribe。
   * 失败时回滚登记，保证“登记表只反映 server 已确认的订阅”。重复订阅幂等成功。
   */
  // [事务] 先登记计数再向 server 订阅，仅 0 到 1 才真正发请求，多 session 共享连接只订阅一次
  // [失败路径] subscribe 失败必须回滚登记，否则登记表会记录一个 server 从未确认的订阅
  // [并发] 重复订阅幂等成功，不重复向 server 发请求
  async subscribeResource(
    request: McpResourceSubscriptionRequest,
    options: McpCallToolOptions = {},
  ): Promise<void> {
    const { record, deadline, timeoutMessage } = await this.resolveForResourceRequest(
      request.serverName,
      "resources/subscribe",
      options,
    );
    if (!record.client.getServerCapabilities()?.resources?.subscribe) {
      throw new McpResourceSubscribeUnsupportedError(request.serverName);
    }
    const { first } = this.resourceSubscriptions.add(
      request.serverName,
      request.uri,
      request.subscriberKey,
    );
    if (!first) return;
    try {
      await record.client.subscribeResource(
        { uri: request.uri },
        { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
      );
    } catch (error) {
      this.resourceSubscriptions.remove(request.serverName, request.uri, request.subscriberKey);
      throw error;
    }
    this.logger?.info("MCP resource subscribed", {
      event: "mcp.resource.subscribe",
      mcpServerName: request.serverName,
      uri: request.uri,
      status: "completed",
    });
  }

  /**
   * 退订资源：未登记或仍有其它订阅者时仅内部计数；1→0 才向 server 发 unsubscribe。
   * server 退订失败由 unsubscribeOnServer 吞掉并记日志（登记表已清，通知会被丢弃）。
   */
  // [事务] 仅从 1 到 0 才向 server 退订，其它订阅者仍在时只做内部计数
  // [失败路径] 退订失败被吞掉并记日志，登记表已清，server 多发的通知因无订阅者被丢弃
  async unsubscribeResource(
    request: McpResourceSubscriptionRequest,
    options: McpCallToolOptions = {},
  ): Promise<void> {
    const removed = this.resourceSubscriptions.remove(
      request.serverName,
      request.uri,
      request.subscriberKey,
    );
    if (!removed?.last) return;
    await this.unsubscribeOnServer(request.serverName, request.uri, options);
  }

  /**
   * 按 subscriber 前缀批量退订（会话关闭）。
   * 返回实际向 server 退订的 (server, uri) 数量；单条失败不影响其余。
   */
  async unsubscribeResourcesBySubscriber(subscriberKeyPrefix: string): Promise<number> {
    const released = this.resourceSubscriptions.removeByPrefix(subscriberKeyPrefix);
    for (const { serverName, uri } of released) {
      await this.unsubscribeOnServer(serverName, uri, {});
    }
    return released.length;
  }

  /** 登记表快照（测试 / 诊断）：serverName → uri → 订阅者数。 */
  resourceSubscriptionCounts(): Record<string, Record<string, number>> {
    return this.resourceSubscriptions.counts();
  }

  private async unsubscribeOnServer(
    serverName: string,
    uri: string,
    options: McpCallToolOptions,
  ): Promise<void> {
    const record = this.records.get(serverName);
    if (!record?.client || record.status.status !== "connected") return;
    try {
      await record.client.unsubscribeResource({ uri }, { signal: options.signal });
      this.logger?.info("MCP resource unsubscribed", {
        event: "mcp.resource.unsubscribe",
        mcpServerName: serverName,
        uri,
        status: "completed",
      });
    } catch (error) {
      // 退订失败只记日志：登记表已清，server 多发的通知因没有订阅者会被丢弃。
      this.logger?.warn("MCP resource unsubscribe failed", {
        event: "mcp.resource.unsubscribe",
        mcpServerName: serverName,
        uri,
        error: error instanceof Error ? error.message : String(error),
        status: "failed",
      });
    }
  }

  /** 断连重连后按登记表重放 subscribe（A3）；单条失败不影响其它。 */
  // [事务] 重连后按登记表重放订阅，宿主会话的资源订阅在断线后自动恢复
  // [失败路径] 单条重放失败不影响其它 uri，server 未声明 subscribe 能力时整段跳过
  private async replayResourceSubscriptions(serverName: string, client: McpClient): Promise<void> {
    const uris = this.resourceSubscriptions.uris(serverName);
    if (uris.length === 0) return;
    if (!client.getServerCapabilities()?.resources?.subscribe) return;
    for (const uri of uris) {
      try {
        await client.subscribeResource({ uri });
      } catch (error) {
        this.logger?.warn("MCP resource subscription replay failed", {
          event: "mcp.resource.subscribe",
          mcpServerName: serverName,
          uri,
          error: error instanceof Error ? error.message : String(error),
          status: "failed",
        });
      }
    }
    this.logger?.info("MCP resource subscriptions replayed after reconnect", {
      event: "mcp.resource.subscribe.replayed",
      mcpServerName: serverName,
      uriCount: uris.length,
    });
  }

  private async resolveForResourceRequest(
    serverName: string,
    operation: string,
    options: McpCallToolOptions,
  ): Promise<{
    record: McpServerRecord & { client: McpClient };
    deadline: McpDeadline;
    timeoutMessage: string;
  }> {
    const timeoutMs =
      options.timeoutMs ?? this.records.get(serverName)?.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    const deadline = createMcpDeadline(timeoutMs);
    const timeoutMessage = `MCP ${operation} ${serverName} timed out after ${timeoutMs}ms`;
    const record = await this.resolveConnectedRecord(
      serverName,
      deadline,
      timeoutMessage,
      options.signal,
    );
    return { record, deadline, timeoutMessage };
  }

  /**
   * server 主动通知。订阅类通知附上当前登记的 subscriberKey（宿主据此按会话拆分）；
   * tools/list_changed 只标记 stale，下一次 listTools 再拉；没有端口时 SDK 默认丢弃。
   */
  // [并发] list_changed 只置 stale 并递增修订号，重拉交给下一次 listTools，通知处理器不发网络请求
  // [失败路径] 宿主未提供 notification 端口时通知被丢弃，不能因此让连接失败
  // [事务] resourceUpdated 附带当前登记的 subscriberKey，宿主据此把通知路由到对应会话
  private installNotificationHandlers(client: McpClient, serverName: string): void {
    const setNotificationHandler = (client as unknown as { setNotificationHandler?: unknown })
      .setNotificationHandler;
    if (typeof setNotificationHandler !== "function") return;
    // SDK 2.x：第一个参数是通知方法名（spec 方法直接用字符串），schema 是可选的第二个参数。
    const typed = client as unknown as {
      setNotificationHandler(method: string, handler: (notification: unknown) => void): void;
    };
    typed.setNotificationHandler(MCP_NOTIFICATION_TOOLS_LIST_CHANGED, () => {
      const record = this.records.get(serverName);
      if (record) record.toolsStale = true;
      this.toolListRevisionCounter += 1;
      this.notifications?.onNotification({ kind: "toolListChanged", serverName });
    });
    typed.setNotificationHandler(MCP_NOTIFICATION_RESOURCES_UPDATED, (notification) => {
      const uri = (notification as { params?: { uri?: unknown } }).params?.uri;
      if (typeof uri !== "string") return;
      this.notifications?.onNotification({
        kind: "resourceUpdated",
        serverName,
        uri,
        subscribers: this.resourceSubscriptions.subscribers(serverName, uri),
      });
    });
    typed.setNotificationHandler(MCP_NOTIFICATION_RESOURCES_LIST_CHANGED, () => {
      this.notifications?.onNotification({
        kind: "resourceListChanged",
        serverName,
        subscribers: this.resourceSubscriptions.allSubscribers(serverName),
      });
    });
    typed.setNotificationHandler(MCP_NOTIFICATION_MESSAGE, (notification) => {
      const params = (notification as { params?: Record<string, unknown> }).params ?? {};
      this.notifications?.onNotification({
        kind: "loggingMessage",
        serverName,
        level: typeof params.level === "string" ? params.level : "info",
        ...(typeof params.logger === "string" ? { logger: params.logger } : {}),
        data: params.data,
      });
    });
  }

  /**
   * 工具调用主入口。
   *
   * appConnection 路径：校验 identity/generation 后才允许调用（防止 UI 使用已换代的连接），
   * 失败直接冒泡不做 OAuth 恢复。
   * 普通路径：等连接（含断连重连一次）→ 调工具；认证类错误在运行期走 Phase2→Phase1 恢复；
   * 仅对确定的 "Not connected" 竞态重连并重试一次，其余错误原样抛出。
   */
  // [并发] appConnection 路径先校验 identity 与 generation，防止 UI 拿旧连接发起调用
  // [失败路径] 只对确定的 Not connected 竞态重连并重试一次，其它错误原样冒泡不掩盖真实原因
  // [事务] 认证类错误在运行期走 Phase 2 到 Phase 1 恢复，与建连期共用同一套编排
  async callTool(
    request: McpCallToolRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpToolCallResult> {
    const timeoutMs =
      options.timeoutMs ??
      this.records.get(request.serverName)?.config.timeoutMs ??
      DEFAULT_MCP_TIMEOUT_MS;
    const deadline = createMcpDeadline(timeoutMs);
    const timeoutMessage = `MCP tool ${request.serverName}/${request.toolName} timed out after ${timeoutMs}ms`;
    let record: McpServerRecord & { client: McpClient };
    if (options.appConnection) {
      const snapshot = this.appConnectionSnapshot(request.serverName);
      const current = this.records.get(request.serverName);
      if (
        !snapshot ||
        snapshot.identity !== options.appConnection.identity ||
        snapshot.generation !== options.appConnection.generation ||
        !current?.client
      )
        throw new Error("MCP App connection changed");
      options.signal?.throwIfAborted();
      record = current as McpServerRecord & { client: McpClient };
    } else {
      record = await this.resolveConnectedRecord(
        request.serverName,
        deadline,
        timeoutMessage,
        options.signal,
      );
    }

    try {
      return await this.callToolOnClient(
        record.client,
        request,
        remainingMcpDeadlineMs(deadline, timeoutMessage),
        options.signal,
        options.onProgress,
      );
    } catch (error) {
      if (options.appConnection) throw error;
      // 连接建立后 token 过期、被撤销或 scope 不足时，
      // 过去这些认证错误原样冒泡，用户看到裸错误且永远不会自愈——OAuth 自愈只存在于
      // startup connect 路径。现在运行期与建连期共用同一套 Phase 2 → Phase 1 编排。
      const trigger = classifyInteractiveAuthorizationTrigger(error);
      if (trigger && record.config.type !== "stdio") {
        return await this.recoverToolCallAuthorization({
          error,
          record,
          request,
          deadline,
          timeoutMessage,
          trigger,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onProgress ? { onProgress: options.onProgress } : {}),
        });
      }
      // 防 onclose 尚未派发的竞态：SDK 在 transport 已断时抛裸 "Not connected"。
      // 只对这一种确定的断连错误重连重试一次，其余错误原样冒泡。
      if (!(error instanceof Error) || error.message !== "Not connected") throw error;
      try {
        await waitWithinMcpDeadline(
          this.reconnectForCall(request.serverName, record.config),
          deadline,
          timeoutMessage,
          options.signal,
        );
      } catch (reconnectError) {
        this.logger?.warn("MCP server reconnect failed", {
          error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
          event: "mcp.server.reconnect.failed",
          mcpServerName: request.serverName,
          status: "failed",
        });
        throw error;
      }
      const revived = this.records.get(request.serverName);
      if (!revived?.client || revived.status.status !== "connected") throw error;
      return await this.callToolOnClient(
        revived.client,
        request,
        remainingMcpDeadlineMs(deadline, timeoutMessage),
        options.signal,
        options.onProgress,
      );
    }
  }

  /**
   * 插件 UI 的 `ui://` 资源读取。与 callTool 共用连接等待 / 断连重连骨架（resolveConnectedRecord），
   * 保证走同一条连接与 OAuth 恢复路径；不做 tool 级 OAuth 二次恢复——资源读取失败直接冒泡，
   * 由 UI 回退到普通卡片。
   */
  /** 读取资源：内容块只透传标准字段；uri 缺失时回退为请求 uri。 */
  async readResource(
    request: McpReadResourceRequest,
    options: McpCallToolOptions = {},
  ): Promise<McpReadResourceResult> {
    const timeoutMs =
      options.timeoutMs ??
      this.records.get(request.serverName)?.config.timeoutMs ??
      DEFAULT_MCP_TIMEOUT_MS;
    const deadline = createMcpDeadline(timeoutMs);
    const timeoutMessage = `MCP resource ${request.serverName} ${request.uri} timed out after ${timeoutMs}ms`;
    const record = await this.resolveConnectedRecord(
      request.serverName,
      deadline,
      timeoutMessage,
      options.signal,
    );
    const result = await record.client.readResource(
      { uri: request.uri },
      { signal: options.signal, timeout: remainingMcpDeadlineMs(deadline, timeoutMessage) },
    );
    return {
      contents: (result.contents ?? []).map((content) => {
        const item = content as Record<string, unknown>;
        return {
          uri: typeof item.uri === "string" ? item.uri : request.uri,
          ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
          ...(typeof item.text === "string" ? { text: item.text } : {}),
          ...(typeof item.blob === "string" ? { blob: item.blob } : {}),
          ...(isRecord(item._meta) ? { _meta: item._meta } : {}),
        };
      }),
    };
  }

  /**
   * callTool / readResource 共用：等待共享 connecting 任务、对已断连 record 重连一次、
   * 返回处于 connected 的 record。抽出来是为了让资源读取与工具调用走完全相同的恢复路径。
   */
  // [并发] 只等待共享 connecting 而不 abort 它，自己的超时不会关掉别人共用的 callback 监听
  // [失败路径] 已断连的 record 在调用前重连一次，工具恢复可用但进程内状态无法恢复
  private async resolveConnectedRecord(
    serverName: string,
    deadline: McpDeadline,
    timeoutMessage: string,
    signal: AbortSignal | undefined,
  ): Promise<McpServerRecord & { client: McpClient }> {
    const pending = this.records.get(serverName)?.connecting;
    if (pending) {
      // 修复原因：connecting 是 adapter 持有的共享连接/OAuth 恢复任务。过去这里裸 await，
      // tool caller 的 timeout/abort 完全失效；但直接 abort 底层任务又会关闭其他 caller 共用的
      // callback listener。这里只限制当前 waiter，共享任务继续由 record 生命周期持有。
      await waitWithinMcpDeadline(pending, deadline, timeoutMessage, signal);
    }

    // Bugfix：stdio MCP 子进程死亡后（如 node_repl 被异步错误击穿），此前没有任何恢复路径：
    // 连接只在 session 创建时建立一次，session resume 也不重建，该会话的工具从此永远失败。
    // 这里在调用前对已断连的 record 重连一次；server 进程内状态（如 REPL 变量）不可恢复，
    // 但工具本身恢复可用。
    const disconnected = this.records.get(serverName);
    if (disconnected && disconnected.status.status === "disconnected") {
      await waitWithinMcpDeadline(
        this.reconnectForCall(serverName, disconnected.config),
        deadline,
        timeoutMessage,
        signal,
      );
    }

    const record = this.records.get(serverName);
    if (!record?.client || record.status.status !== "connected") {
      throw new Error(`MCP server is not connected: ${serverName}`);
    }
    return record as McpServerRecord & { client: McpClient };
  }

  /** 连接期诊断按 server 保存；tool call request id 继续按 span 隔离。 */
  /**
   * 记录官方 MCP 响应诊断。
   * 无 span 且非 tools/call 的连接期响应 → 只存“连接级”failureKind/requestId（下一次 failConnection 消费）；
   * 有 span 的 tools/call 响应 → 按 span 暂存 requestId，超过 64 条挤出最旧（防止长会话无界增长）。
   */
  // [事务] 连接期无 span 的响应只作为一次性诊断，被 failConnection 取用后立即清除
  // [资源] 有 span 的响应按 span 暂存 requestId，后写覆盖，401 重试留下的是最终那次
  private rememberServerResponse(
    serverName: string,
    response: OfficialMcpServerResponseInfo,
  ): void {
    if (
      !response.spanId &&
      response.rpcMethod !== "tools/call" &&
      this.records.get(serverName)?.status.status === "connecting"
    ) {
      if (response.failureKind) {
        this.connectionDiagnosticByServer.set(serverName, {
          failureKind: response.failureKind,
          ...(response.serverRequestId ? { serverRequestId: response.serverRequestId } : {}),
        });
      }
      return;
    }
    if (!response.spanId) return;
    if (!response.serverRequestId) return;
    // 401 重试会对同一 span 产生两条响应，后写覆盖——留下的是最终那次，正是要报的那个。
    this.serverRequestIdBySpan.set(response.spanId, response.serverRequestId);
    while (this.serverRequestIdBySpan.size > MAX_TRACKED_SERVER_REQUEST_IDS) {
      const oldest = this.serverRequestIdBySpan.keys().next();
      if (oldest.done) break;
      this.serverRequestIdBySpan.delete(oldest.value);
    }
  }

  /** 取出并清除该 span 的 request id。取不到返回 undefined，不做任何兜底猜测。 */
  /** 取走并删除 span 对应 requestId；无 span 或未命中返回 undefined，绝不做“取最近一条”兜底。 */
  private takeServerRequestId(spanId: string | undefined): string | undefined {
    if (!spanId) return undefined;
    const requestId = this.serverRequestIdBySpan.get(spanId);
    if (requestId !== undefined) this.serverRequestIdBySpan.delete(spanId);
    return requestId;
  }

  /**
   * 解析 stdio 官方 MCP 本次出站协议消息的身份头。
   * 返回 undefined 表示"不是官方 stdio server"——此时 `_meta` 里绝不能出现该键，否则等于把
   * 身份头广播给任意第三方插件。
   */
  /**
   * 解析 stdio 官方 MCP 的逐请求身份头（非官方 stdio 返回 undefined，绝不注入该 _meta 键）。
   *
   * 依赖缺失 / origin 解析或 isTrusted 抛错 / 不受信 / auth port 返回 ok:false 一律转成
   * {ok:false, reason} 下发给插件（reason 是跨层契约）。成功时只记录 header 名与套餐类型，
   * 不记录 header 值；该失败不写 lastOfficialAuthKind（避免污染断连分类）。
   */
  // [失败路径] 依赖缺失、origin 解析抛错、origin 不受信、port 返回失败都转成 ok false 与稳定 reason
  // [事务] 该失败不写 lastOfficialAuthKind，避免身份头缺失被误记成后续断连的原因
  // [权衡] 非官方 stdio 返回 undefined，保证 _meta 里绝不出现身份键，身份头不会广播给第三方插件
  private async resolveOfficialStdioAuthMeta(
    serverName: string,
    config: McpServerConfig,
    signal: AbortSignal | undefined,
  ): Promise<OfficialMcpAuthMetaPayload | undefined> {
    if (config.type !== "stdio" || !isOfficialAuthConfig(config) || !config.official) {
      return undefined;
    }
    const official = config.official;
    const authHeadersPort = this.officialMcpAuth?.authHeadersPort;
    const trustedOrigins = this.officialMcpAuth?.trustedOrigins;
    const resolveZCodeApiOrigin = this.officialMcpAuth?.resolveZCodeApiOrigin;
    const logBase = {
      event: "mcp.official_auth.stdio_meta",
      mcpKey: official.mcpKey,
      mcpServerName: serverName,
      module: "adapters.mcp",
    };
    const fail = (reason: OfficialMcpAuthFailureReason): OfficialMcpAuthMetaPayload => {
      // 刻意不写 lastOfficialAuthKind：那个 map 只被 failConnection 读取，用来给**连接失败**
      // 打分类标签。stdio 的身份头缺失不会让连接失败，写进去会一直留着，等到该 server 之后
      // 因为别的原因（子进程死掉等）真正断连时被当成断连原因记进日志，属误导。
      // 本路径的可观测性由下面这条自己的 event + 下发给插件的 reason 承担。
      this.logger?.warn("Official MCP stdio auth headers unavailable", {
        ...logBase,
        reason,
        status: "failed",
      });
      return { ok: false, reason };
    };

    // standalone CLI 没有 host auth port。不静默省略该键：插件区分不了"宿主不支持"与
    // "宿主支持但我没登录"，只有显式 reason 才能给出正确的用户提示。
    if (!authHeadersPort || !trustedOrigins || !resolveZCodeApiOrigin) {
      return fail("official_auth_unavailable");
    }

    // stdio 没有 url，origin 由宿主给出而非插件声明。isTrusted 在此退化为恒真断言，但仍要调用：
    // 它同时校验 https、拒绝带 username/password 的 URL，并让 dev loopback 开关继续生效。
    //
    // 这两步原来裸调用。origin 解析依赖 settings / 运行时环境，isTrusted 是
    // 注入的实现，两者都可能抛。异常裸冒泡会绕过整个失败分类：插件收不到 `{ok:false, reason}`，
    // 而 reason 是跨 adapter / host / UI 的契约（决定提示文案与是否重试）。因此统一映射为
    // official_auth_unavailable——宿主侧解析不出可信 origin，对插件而言就是"官方鉴权不可用"。
    // 错误文本只进日志，绝不参与流程判断。
    let targetOrigin: string;
    let trust: Awaited<ReturnType<OfficialMcpTrustedOriginRegistry["isTrusted"]>>;
    try {
      targetOrigin = resolveZCodeApiOrigin();
      trust = await trustedOrigins.isTrusted({
        mcpKey: official.mcpKey,
        origin: targetOrigin,
        pluginId: official.pluginId,
      });
    } catch (error) {
      this.logger?.warn("Official MCP stdio origin resolution failed", {
        ...logBase,
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : "unknown",
        pluginId: official.pluginId,
      });
      return fail("official_auth_unavailable");
    }
    if (!trust.trusted) {
      this.logger?.warn("Official MCP stdio origin is not trusted", {
        ...logBase,
        detail: trust.detail ?? "unknown",
        pluginId: official.pluginId,
        targetOrigin,
      });
      return fail("official_mcp_origin_untrusted");
    }

    const resolved = await authHeadersPort.resolveHeaders({
      mcpKey: official.mcpKey,
      pluginId: official.pluginId,
      targetOrigin,
      ...(this.officialMcpAuth?.workspaceIdentity
        ? { workspaceIdentity: this.officialMcpAuth.workspaceIdentity }
        : {}),
      ...(this.workingDirectory ? { workspacePath: this.workingDirectory } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!resolved.ok) return fail(resolved.reason);

    // 只记 header 名与套餐维度，绝不记 header 值——日志留存周期不受控。
    this.logger?.debug("Official MCP stdio auth headers attached", {
      ...logBase,
      identityHeaderNames: Object.keys(resolved.headers)
        .map((name) => name.toLowerCase())
        .sort(),
      ...(resolved.headers["Bigmodel-Target-Type"]
        ? { identityTargetType: resolved.headers["Bigmodel-Target-Type"] }
        : {}),
      status: "completed",
    });
    return { ok: true, headers: resolved.headers };
  }

  /** server 主动 elicitation/create：归属到该 server 当前工具调用的会话，交给宿主提问端口。 */
  /**
   * 安装 elicitation/create 处理器：仅支持 form（含兼容别名），其它模式 decline。
   * 请求归属到该 server 当前工具调用的 activeCallTrace；accept 时 content 缺省为 {}。
   */
  private installElicitationHandler(client: McpClient, serverName: string): void {
    const port = this.elicitation;
    const setRequestHandler = (client as unknown as { setRequestHandler?: unknown })
      .setRequestHandler;
    if (!port || typeof setRequestHandler !== "function") return;
    (
      client as unknown as {
        setRequestHandler(
          method: "elicitation/create",
          handler: (request: {
            params: { message: string; requestedSchema?: unknown };
          }) => Promise<unknown>,
        ): void;
      }
    ).setRequestHandler("elicitation/create", async (request) => {
      // 接受缺省 / "form" / 兼容接口的 "openai/form" / "openaiForm"；url 等其它模式 decline。
      const mode = (request.params as { mode?: unknown }).mode;
      if (!isSupportedElicitationMode(mode)) {
        this.logger?.warn("MCP elicitation mode not supported, declining", {
          event: "mcp.elicitation.unsupported_mode",
          mcpServerName: serverName,
          mode: String(mode),
        });
        return { action: "decline" };
      }
      const trace = this.activeCallTraces.get(serverName);
      const result = await port.requestElicitation({
        serverName,
        message: request.params.message,
        requestedSchema: request.params.requestedSchema,
        ...(trace ? { trace } : {}),
      });
      return result.action === "accept"
        ? { action: "accept", content: result.content ?? {} }
        : { action: result.action };
    });
  }

  /** 调用期间登记 trace，server 在这段时间发起的 elicitation 才能归属到会话 / 工具行。 */
  /**
   * 带 trace 归属的工具调用包装：调用期间登记 activeCallTraces，finally 必删。
   * 只有登记期间 server 发起的 elicitation 才会带 trace。
   */
  // [并发] 调用期间登记 activeCallTraces，finally 必删，server 发起的 elicitation 才归属到正确会话
  // [资源] 登记以 serverName 为键只占一槽，同 server 并发调用由后进者持有 trace
  private async callToolOnClient(
    client: McpClient,
    request: McpCallToolRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onProgress?: McpCallToolOptions["onProgress"],
  ): Promise<McpToolCallResult> {
    this.activeCallTraces.set(request.serverName, {
      ...(request.trace?.sessionId ? { sessionId: String(request.trace.sessionId) } : {}),
      ...(request.trace?.turnId ? { turnId: String(request.trace.turnId) } : {}),
      ...(request.trace?.traceId ? { traceId: String(request.trace.traceId) } : {}),
    });
    try {
      return await this.callToolOnClientInner(client, request, timeoutMs, signal, onProgress);
    } finally {
      this.activeCallTraces.delete(request.serverName);
    }
  }

  /**
   * 真正执行 client.callTool 并记录脱敏日志。
   *
   * 日志只记参数 key、耗时、预算、是否 isError；onProgress 会重置超时（长任务持续上报不被
   * timeoutMs 打断）。失败时区分 timedOut/budgetExhausted，并把 serverRequestId 附加到失败
   * result._meta（成功路径不附加）；异常原样重抛。
   */
  // [失败路径] 失败时区分超时与预算耗尽，耗时贴近预算说明本地掐断，远小于预算说明对端断连
  // [事务] serverRequestId 只在失败结果里附加，成功路径不写 _meta，避免噪声与服务端已有键冲突
  // [权衡] 进度通知重置超时，持续上报的长任务不被 timeoutMs 打断，总时长由工具级预算约束
  private async callToolOnClientInner(
    client: McpClient,
    request: McpCallToolRequest,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onProgress?: McpCallToolOptions["onProgress"],
  ): Promise<McpToolCallResult> {
    // 工具调用此前完全无日志：超时时既看不到预算是多少，也无法区分"服务端慢"与
    // "客户端预算太小"。这里记录预算与耗时，但只记参数的 key（值可能是用户输入）。
    const logBase = {
      event: "mcp.tool.call",
      mcpServerName: request.serverName,
      mcpToolName: request.toolName,
      module: "adapters.mcp",
      timeoutMs,
    };
    const argumentKeys = Object.keys(request.arguments ?? {}).sort();
    this.logger?.debug("MCP tool call started", {
      ...logBase,
      argumentKeys,
      status: "started",
    });

    const startedAt = Date.now();
    try {
      const result = await client.callTool(
        {
          name: request.toolName,
          arguments: request.arguments ?? {},
          ...(request.trace || request.runtimeScope || request.workspaceKey || request.workspacePath
            ? { _meta: mcpRequestMeta(request) }
            : {}),
        },
        {
          signal,
          timeout: timeoutMs,
          // 进度通知重置超时（A8）：长任务只要持续上报就不会被 timeoutMs 打断；总时长由工具级 _meta.timeoutMs 约束。
          resetTimeoutOnProgress: true,
          ...(onProgress
            ? {
                onprogress: (notification: {
                  progress: number;
                  total?: number;
                  message?: string;
                }) =>
                  onProgress({
                    progress: notification.progress,
                    ...(notification.total !== undefined ? { total: notification.total } : {}),
                    ...(notification.message !== undefined
                      ? { message: notification.message }
                      : {}),
                  }),
              }
            : {}),
        },
      );

      const durationMs = Date.now() - startedAt;
      const isError = typeof result.isError === "boolean" ? result.isError : false;
      // 官方 MCP 的 in-band 失败（配额耗尽、无套餐）是 HTTP 200 + isError，wrapper 那条
      // 非 2xx warn 覆盖不到；request id 也只有 wrapper 能看到，所以在这里按 span 取回。
      const serverRequestId = this.takeServerRequestId(request.trace?.spanId);
      const outcome = {
        ...logBase,
        contentBlocks: Array.isArray(result.content) ? result.content.length : 0,
        durationMs,
        hasStructuredContent: result.structuredContent !== undefined,
        // 业务级失败（isError）与传输级失败不同，必须能分开统计。
        isError,
        ...(serverRequestId ? { serverRequestId } : {}),
      };
      if (isError) {
        // 之前 in-band 失败只有这条 debug，而生产 logger 最低级别是 Info——等于配额耗尽
        // 这类失败在生产日志里完全不可见。
        this.logger?.warn("MCP tool returned an error", { ...outcome, status: "failed" });
      } else {
        this.logger?.debug("MCP tool call completed", { ...outcome, status: "completed" });
      }

      const meta = isRecord(result._meta) ? result._meta : undefined;
      return {
        content: Array.isArray(result.content)
          ? (result.content as McpContentBlock[])
          : [{ type: "text", text: "" }],
        structuredContent: result.structuredContent,
        isError: typeof result.isError === "boolean" ? result.isError : undefined,
        // 只在失败时附加：成功路径上它是纯噪声。服务端已给的键一律不覆盖。
        _meta:
          isError && serverRequestId
            ? { ...meta, [ZCODE_MCP_SERVER_REQUEST_ID_META_KEY]: serverRequestId }
            : meta,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      // 判定是否为超时：SDK 超时会抛 MCP error code -32001 (RequestTimeout)，
      // 底层 fetch abort 抛 AbortError。两者都要能一眼认出，否则只能看到裸 message。
      const timedOut =
        /timed?\s*out|timeout/i.test(message) ||
        (error instanceof Error && error.name === "AbortError");
      // 传输级失败也带上：4xx/5xx 时 SDK 抛出的 message 里没有 request id。
      const serverRequestId = this.takeServerRequestId(request.trace?.spanId);
      this.logger?.warn("MCP tool call failed", {
        ...logBase,
        argumentKeys,
        durationMs,
        error: message,
        ...(serverRequestId ? { serverRequestId } : {}),
        errorName: error instanceof Error ? error.name : "unknown",
        status: "failed",
        timedOut,
        // 耗时贴着预算 ⇒ 是我们掐断的；远小于预算 ⇒ 是对端或网络断的。
        ...(timedOut ? { budgetExhausted: durationMs >= timeoutMs * 0.9 } : {}),
      });
      throw error;
    }
  }

  /** 断连后重连：等价 connectServer(name, config)，会分配新 generation 并替换 record。 */
  // [事务] 重连等价于按原配置再连一次，会分配新 generation 并整体替换 record
  // [失败路径] 重连失败由上游保留首次错误，调用方看到的是原始原因而不是重连噪声
  private async reconnectForCall(name: string, config: McpServerConfig): Promise<void> {
    this.logger?.warn("MCP server reconnecting after lost connection", {
      event: "mcp.server.reconnect.started",
      mcpServerName: name,
      status: "started",
      transport: config.type,
    });
    await this.connectServer(name, config);
  }

  /**
   * 运行期认证恢复：Phase 2 交互授权 → Phase 1 重连 → 原 tool call 最多安全重试一次。
   *
   * 与建连期共用 `runInteractiveOAuthAuthorization`，因此单飞、fencing、caller 预算语义完全一致。
   */
  /**
   * 运行期认证恢复的协调者：等共享 recovery（受本 caller deadline 约束），
   * 恢复后再次校验 connected 才重试原工具调用；否则抛原始错误。
   * 不直接 abort 共享事务，避免关闭其他 caller 共用的 callback listener。
   */
  private async recoverToolCallAuthorization(input: {
    deadline: McpDeadline;
    error: unknown;
    record: McpServerRecord;
    request: McpCallToolRequest;
    signal?: AbortSignal;
    onProgress?: McpCallToolOptions["onProgress"];
    timeoutMessage: string;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpToolCallResult> {
    const { record, request } = input;
    const config = record.config;
    if (config.type === "stdio") throw input.error;
    const oauthConfig = resolveAuthorizationCodeOAuthConfig(config);
    if (!oauthConfig) throw input.error;

    this.logger?.warn("MCP tool call requires OAuth authorization", {
      event: "mcp.oauth.tool_call.authorization_required",
      mcpServerName: request.serverName,
      oauthTriggerReason: input.trigger.reason,
      status: "started",
      toolName: request.toolName,
    });

    const recovery = this.ensureToolCallAuthorizationRecovery({
      config,
      name: request.serverName,
      oauthConfig,
      record,
      trigger: input.trigger,
    });
    const recoveredStatus = await waitWithinMcpDeadline(
      recovery,
      input.deadline,
      input.timeoutMessage,
      input.signal,
    );
    if (recoveredStatus.status !== "connected") {
      throw input.error;
    }

    const revived = this.records.get(request.serverName);
    if (!revived?.client || revived.status.status !== "connected") throw input.error;
    return await this.callToolOnClient(
      revived.client,
      request,
      remainingMcpDeadlineMs(input.deadline, input.timeoutMessage),
      input.signal,
      input.onProgress,
    );
  }

  /**
   * 创建或复用运行期 OAuth 恢复。完整的 Phase 2 → Phase 1 由 adapter-owned record 持有；
   * tool caller 只能等待，不能用自己的 AbortSignal 终止共享事务。
   */
  /**
   * 获取或创建运行期 OAuth 恢复任务（单飞）。
   *
   * 已有同配置 connecting 则复用；否则分配新 generation 并创建 recoveryRecord，
   * 保留原 tools（避免恢复期工具从工具池消失），用独立 AbortController 拥有事务。
   * 返回共享 promise；caller 只等待不取消。
   */
  // [并发] 同配置已有 connecting 则复用，同一 server 同时只有一条授权事务
  // [事务] 恢复期保留原 tools，避免工具在授权过程中从工具池消失导致 UI 误判
  // [资源] 独立 AbortController 拥有事务，caller 取消不会关闭共享的 callback 监听
  private ensureToolCallAuthorizationRecovery(input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    record: McpServerRecord;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpServerStatus> {
    const current = this.records.get(input.name);
    if (
      current?.connecting &&
      current.status.status === "connecting" &&
      isDeepStrictEqual(current.config, input.config)
    ) {
      return current.connecting;
    }

    const generation = this.nextConnectionGeneration(input.name);
    const abortController = new AbortController();
    const recoveryRecord: McpServerRecord = {
      abortController,
      config: input.config,
      status: this.createStatus(input.config, "connecting", {
        toolCount: input.record.tools.length,
      }),
      // 运行期工具已经向 core 广告；恢复期间保留 descriptor，避免设置页/借用端口误判工具消失。
      tools: input.record.tools,
    };
    this.records.set(input.name, recoveryRecord);
    const connecting = this.runToolCallAuthorizationRecovery({
      abortController,
      config: input.config,
      generation,
      name: input.name,
      oauthConfig: input.oauthConfig,
      previousClient: input.record.client,
      previousTransport: input.record.transport,
      trigger: input.trigger,
    });
    recoveryRecord.connecting = connecting;
    return connecting;
  }

  /**
   * 运行期恢复实现：先退休旧 client/transport（不能走 connectServer，否则会 abort 自己），
   * 再跑 Phase 2；authorized/already 后重新 openServerConnection（oauthAuthorizationAttempted=true
   * 防止二次授权循环）；pending/failed 收敛为 failed 状态。
   * 整个编排是 total 的：任何异常都经 failConnection 落成 failed record，不留 rejected connecting。
   */
  private async runToolCallAuthorizationRecovery(input: {
    abortController: AbortController;
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    previousClient?: McpClient;
    previousTransport?: McpTransport;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpServerStatus> {
    const startedAt = Date.now();
    try {
      // 原 transport 的握手与 token 已失效，必须由共享 owner 统一退休；不能调用 connectServer，
      // 否则 closeRecord 会 abort recoveryRecord 自己的 controller，形成自取消。
      await this.closeClientAndTransport(input.name, input.previousClient, input.previousTransport);
      const outcome = await this.runInteractiveOAuthAuthorization({
        config: input.config,
        generation: input.generation,
        name: input.name,
        oauthConfig: input.oauthConfig,
        serverUrl: input.config.url,
        signal: input.abortController.signal,
        trigger: input.trigger,
      });
      if (outcome.status === "authorized" || outcome.status === "already-authorized") {
        return await this.openServerConnection({
          config: input.config,
          generation: input.generation,
          name: input.name,
          oauthAuthorizationAttempted: true,
          signal: input.abortController.signal,
          timeoutMs: input.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
        });
      }
      return await this.failConnection({
        config: input.config,
        error:
          outcome.status === "pending"
            ? new Error(
                `MCP server ${input.name} OAuth authorization is still in progress; complete it in the browser and reconnect`,
              )
            : outcome.error,
        failureKind: "oauth_authorization_failed",
        generation: input.generation,
        name: input.name,
        startedAt,
      });
    } catch (error) {
      // 防御边界：共享 recovery promise 必须是 total operation。任何未来新增的编排异常也只能
      // 收敛为 failed record，不能留下 rejected connecting promise 污染后续 snapshot。
      return await this.failConnection({
        config: input.config,
        error,
        failureKind: "oauth_authorization_failed",
        generation: input.generation,
        name: input.name,
        startedAt,
      });
    }
  }

  /**
   * 关闭适配器：先对每个 server 递增 generation（作废在途任务），再并发 closeRecord。
   * 最后清空 records 与连接诊断；不清理 subscription 登记表（adapter 即将被丢弃）。
   * 副作用：终止进程树、关连接；失败在 closeClientAndTransport 内吞掉。幂等。
   */
  // [事务] 先对所有 server 递增 generation 作废在途任务，再并发 closeRecord，最后清空 records
  // [资源] 订阅登记表不清理，adapter 即将被丢弃，逐条退订只会拖慢关闭
  // [失败路径] 关闭全程 best-effort，单条关闭异常不阻止其余 server 回收
  async close(): Promise<void> {
    const startedAt = Date.now();
    const serverCount = this.records.size;
    for (const name of this.records.keys()) {
      this.nextConnectionGeneration(name);
    }
    await Promise.all(Array.from(this.records.keys()).map((name) => this.closeRecord(name)));
    this.records.clear();
    this.connectionDiagnosticByServer.clear();
    this.logger?.info("MCP adapter closed", {
      durationMs: Date.now() - startedAt,
      event: "mcp.adapter.closed",
      serverCount,
      status: "completed",
    });
  }

  /**
   * 按 caller 预算等待共享连接。
   *
   * 无预算无 signal 时直接返回 connecting（完全共享）；否则与“超时/abort 时读取当前状态”
   * 两个 promise 竞速，先到者胜，finally 清理 timer 与 abort 监听。
   * 关键语义：到点返回 snapshot（可能带 authorization URL），后台连接继续存活。
   */
  private waitForSharedConnection(
    name: string,
    record: McpServerRecord,
    options: McpConnectOptions,
  ): Promise<McpServerStatus> {
    const connecting = record.connecting;
    if (!connecting) return Promise.resolve(record.status);
    if (options.oauthAuthorizationTimeoutMs === undefined && !options.signal) {
      return connecting;
    }

    let abortHandler: (() => void) | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const currentStatus = () => this.records.get(name)?.status ?? record.status;
    const waiters: Promise<McpServerStatus>[] = [connecting];

    const timeoutMs = options.oauthAuthorizationTimeoutMs;
    if (timeoutMs !== undefined) {
      waiters.push(
        new Promise((resolvePromise) => {
          timeoutId = setTimeout(() => resolvePromise(currentStatus()), timeoutMs);
        }),
      );
    }
    if (options.signal) {
      waiters.push(
        new Promise((resolvePromise) => {
          if (options.signal?.aborted) {
            resolvePromise(currentStatus());
            return;
          }
          abortHandler = () => resolvePromise(currentStatus());
          options.signal?.addEventListener("abort", abortHandler, {
            once: true,
          });
        }),
      );
    }

    return Promise.race(waiters).finally(() => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
    });
  }

  /**
   * 建立一条新连接（stdio/HTTP/SSE），并完成 initialize + tools/list。
   *
   * 起手默认 failureKind：stdio→process_start_failed，其余 network_unreachable，后续按阶段更新。
   * 成功路径：装 elicitation/通知处理器 → connect → listTools → generation 校验 → 写 record →
   * 重放订阅 → 挂 onclose（意外断连置 disconnected 并上报 crash）→ 记录连接摘要日志。
   * 失败路径：认证错误交 Phase 2（成功后递归重连一次，oauthAuthorizationAttempted 防循环）；
   * 版本协商错误细分 protocol_negotiation_failed；其余交 failConnection。
   * 副作用：创建 transport、spawn/网络、定时器超时、遥测、日志；不向 caller 抛连接错误。
   */
  // [事务] 起手按 transport 给默认 failureKind 并随阶段覆盖，失败分类始终有值
  // [失败路径] 认证错误交 Phase 2 后递归重连一次，oauthAuthorizationAttempted 防止二次授权循环
  // [资源] 连接成功后挂 onclose，意外断连显式置 disconnected，主动关闭前先摘掉该回调
  private async openServerConnection(input: {
    config: McpServerConfig;
    generation: number;
    name: string;
    oauthAuthorizationTimeoutMs?: number;
    signal: AbortSignal;
    timeoutMs: number;
    workingDirectory?: string;
    oauthAuthorizationAttempted?: boolean;
  }): Promise<McpServerStatus> {
    const {
      config,
      generation,
      name,
      oauthAuthorizationAttempted = false,
      oauthAuthorizationTimeoutMs,
      signal,
      timeoutMs,
      workingDirectory,
    } = input;
    const startedAt = Date.now();
    let client: McpClient | undefined;
    let connectDurationMs: number | undefined;
    let getRecentStderr: (() => string | undefined) | undefined;
    let listToolsDurationMs: number | undefined;
    let transport: McpTransport | undefined;
    let failureKind: McpServerFailureKind =
      config.type === "stdio" ? "process_start_failed" : "network_unreachable";

    try {
      const transportBundle = await this.createTransport(
        config,
        name,
        generation,
        oauthAuthorizationTimeoutMs,
        workingDirectory,
        signal,
      );
      transport = transportBundle.transport;
      getRecentStderr = this.attachStdioLogging(name, transport);
      client = new Client(
        {
          name: this.clientName,
          version: this.clientVersion,
        },
        {
          versionNegotiation: resolveVersionNegotiation(config, timeoutMs),
          capabilities: {
            // MCP Apps 规范：宿主经 `extensions["io.modelcontextprotocol/ui"]` 宣告能渲染的 UI mimeType，
            // 官方 SDK 的 server 据此决定是否下发 ui 资源（getUiCapability）。
            ...buildMcpAppsClientCapabilities(),
            // 只宣告 form 模式（url 模式不做）；server 据此选择 elicitation 形态。
            ...(this.elicitation ? { elicitation: { form: {} } } : {}),
          },
        },
      );
      this.installElicitationHandler(client, name);
      this.installNotificationHandlers(client, name);
      this.updateCurrentRecord(name, generation, {
        client,
        transport,
      });

      const connectStartedAt = Date.now();
      await withTimeout(
        client.connect(transport),
        timeoutMs,
        `MCP server ${name} connection timed out after ${timeoutMs}ms`,
        signal,
      );
      connectDurationMs = Date.now() - connectStartedAt;

      failureKind = "tool_list_failed";
      const listToolsStartedAt = Date.now();
      const listed = await withTimeout(
        client.listTools(),
        timeoutMs,
        `MCP server ${name} tool listing timed out after ${timeoutMs}ms`,
        signal,
      );
      listToolsDurationMs = Date.now() - listToolsStartedAt;
      const tools = listed.tools.map((tool) =>
        normalizeMcpToolDescriptor(
          name,
          tool,
          config.timeoutMs,
          // 只有 http 形态置位。这个标记的用途是**信任结果里的结构化标识**
          // （额度耗尽 / 无套餐），因此判据必须是"结果由谁产出"：
          //   - http：结果来自 ZCode 后端。fetch wrapper 对每次请求校验 origin；登录态只在
          //     tools/call 解析，缺失时由同一可信后端返回结构化 coding_plan_required；
          //   - stdio：结果由插件进程自己产出，可以任意伪造 `{"error_code":"quota_exceeded"}`，
          //     从而在用户输入框上方弹出"额度用完 / 请开通 Coding Plan"的误导提示。
          // 原判据是 `type !== "sse"`，把 stdio 一起放了进来，等于这道门槛在 stdio 上为零。
          // 注意这不是在挡凭证外泄（那由 origin 校验负责），而是在挡**结果伪造**。
          config.type === "http" && config.auth?.type === ZCODE_OFFICIAL_MCP_AUTH_TYPE,
          config.alwaysLoad,
        ),
      );
      const negotiatedProtocolEra = client.getProtocolEra();
      const negotiatedProtocolVersion = client.getNegotiatedProtocolVersion();
      const status = this.createStatus(config, "connected", {
        protocolEra: negotiatedProtocolEra,
        toolCount: tools.length,
      });
      if (!this.isCurrentConnection(name, generation)) {
        await this.closeClientAndTransport(name, client, transport);
        return this.records.get(name)?.status ?? status;
      }
      this.connectionDiagnosticByServer.delete(name);
      this.records.set(name, {
        client,
        config,
        status,
        tools,
        transport,
      });
      // A3：重连（同一 adapter 实例）后按登记表重放订阅；首次连接登记表为空，直接跳过。
      await this.replayResourceSubscriptions(name, client);
      const mcpTransportPid = getStdioTransportPid(transport);
      const mcpProcessIdentity =
        mcpTransportPid != null && this.connectionContext
          ? this.telemetry?.recordProcessStarted({
              connectionId: this.connectionContext.mcpConnectionId,
              pid: mcpTransportPid,
            })
          : undefined;
      // stdio MCP 子进程死亡（如 node_repl 被 REPL cell 的异步错误击穿）不能完全
      // 静默——不记日志、状态停留在 connected，后续调用只会抛裸的 "Not connected"。
      // 挂 onclose 把意外断连显式化；主动关闭路径会先清掉 onclose（见 closeClientAndTransport）。
      client.onclose = () => {
        if (!this.isCurrentConnection(name, generation)) return;
        const current = this.records.get(name);
        if (!current || current.client !== client) return;
        this.nextConnectionGeneration(name);
        const recentStderr = getRecentStderr?.();
        const processExit = getStdioTransportExitInfo(transport);
        current.status = this.createStatus(current.config, "disconnected", {
          error: "MCP server connection closed unexpectedly",
          failureKind: "unexpected_disconnect",
        });
        this.logger?.warn("MCP server connection lost", {
          ...this.connectionContext,
          event: "mcp.server.connection_lost",
          mcpServerName: name,
          ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
          ...(mcpProcessIdentity ?? {}),
          ...(processExit
            ? { exitCode: processExit.exitCode, signal: processExit.signal ?? undefined }
            : {}),
          status: "failed",
          transport: current.config.type,
          ...(recentStderr ? { stderr: recentStderr } : {}),
        });
        if (
          current.config.type === "stdio" &&
          this.connectionContext &&
          (processExit || !isStdioTransportProcessAlive(transport))
        ) {
          this.telemetry?.recordProcessCrashed({
            connectionId: this.connectionContext.mcpConnectionId,
            exitCode: processExit?.exitCode ?? null,
            signal: processExit?.signal ?? null,
          });
        }
      };
      // 此前连接日志只记录 transport，auto 协商后无法判断实际走 modern 还是 legacy。
      // 同时记录配置策略和 SDK 握手结果，避免把 `auto` 误当成最终协议版本。
      // 连接池上下文和 stdio transport PID 过去未进入同一事件，无法关联 session、
      // workspace、协议版本和真实子进程；stdio PID 只代表最终会话 transport，不代表 probe child。
      this.logger?.info("MCP server connected", {
        ...this.connectionContext,
        connectDurationMs,
        durationMs: Date.now() - startedAt,
        event: "mcp.server.connected",
        listToolsDurationMs,
        mcpClientName: this.clientName,
        mcpClientVersion: this.clientVersion,
        mcpProtocolEra: negotiatedProtocolEra ?? "unknown",
        mcpProtocolVersion: negotiatedProtocolVersion ?? "unknown",
        mcpServerName: name,
        ...(mcpProcessIdentity ?? {}),
        ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
        mcpVersionNegotiationMode: formatVersionNegotiationMode(config),
        status: "completed",
        toolCount: tools.length,
        transport: config.type,
      });
      return status;
    } catch (error) {
      // 过去这里等的是旧 provider 自己开的 listener，且用 session 的 15 秒预算做
      // 硬关闭——15 秒是 caller 的等待预算，不是授权事务的寿命。现在按错误类型判定是否需要
      // 交互授权，并把授权交给 Phase 2 独立事务（独立锁、fresh DCR、300 秒事务 TTL）。
      const trigger = oauthAuthorizationAttempted
        ? undefined
        : classifyInteractiveAuthorizationTrigger(error);
      const authorizationCodeOAuthConfig =
        trigger && config.type !== "stdio"
          ? resolveAuthorizationCodeOAuthConfig(config)
          : undefined;
      if (trigger && authorizationCodeOAuthConfig && config.type !== "stdio") {
        // negotiation 失败时 SDK 已关闭 transport，不可复用；Phase 2 也不需要 transport。
        await this.closeClientAndTransport(name, client, transport);
        const outcome = await this.runInteractiveOAuthAuthorization({
          config,
          generation,
          name,
          oauthConfig: authorizationCodeOAuthConfig,
          serverUrl: config.url,
          signal,
          trigger,
        });
        if (outcome.status === "authorized" || outcome.status === "already-authorized") {
          return await this.openServerConnection({
            ...input,
            oauthAuthorizationAttempted: true,
          });
        }
        // client/transport 已在进入 Phase 2 前关闭，这里不再传入；failureKind 沿用
        // 诊断分类，让设置页把"授权没完成"与网络/进程类失败区分开。
        return this.failConnection({
          config,
          connectDurationMs,
          error:
            outcome.status === "pending"
              ? new Error(
                  `MCP server ${name} OAuth authorization is still in progress; complete it in the browser and reconnect`,
                )
              : outcome.error,
          failureKind: "oauth_authorization_failed",
          generation,
          getRecentStderr,
          listToolsDurationMs,
          name,
          startedAt,
        });
      }
      // `protocol_negotiation_failed` 枚举与 UI 文案在 shared/i18n 里早已存在，但 adapter
      // 侧一直没有产出方——auto/pin 模式下 SDK 的 server/discover probe 硬失败（典型：飞书项目
      // MCP 对未知方法回 HTTP 200 + id:null 的非标 JSON-RPC error，body 过不了
      // JSONRPCMessageSchema）会一路落到默认 failureKind "network_unreachable"，设置页因此
      // 显示误导性的"网络不可达"。这里按结构化错误类型（SdkErrorCode / isInstance）识别 SDK
      // 协商失败并产出正确分类，不依赖错误文本；withTimeout 不包装错误（timeout.ts 只透传
      // reject），cause 链仅作防御性兜底。
      const negotiationFailureKind = isProtocolNegotiationFailure(error)
        ? ("protocol_negotiation_failed" as const)
        : undefined;
      return this.failConnection({
        client,
        config,
        connectDurationMs,
        error,
        generation,
        getRecentStderr,
        listToolsDurationMs,
        name,
        startedAt,
        transport,
        failureKind: negotiationFailureKind ?? failureKind,
      });
    }
  }

  /**
   * Phase 2：交互授权。
   *
   * 授权事务的寿命是 300 秒，与 caller 的等待预算（session 15 秒）无关；caller 侧的收口发生在
   * `connectServer` / `waitForSharedConnection`，本方法不感知 caller 预算。
   */
  /**
   * Phase 2 交互授权。
   *
   * 事务寿命 300 秒（MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS），与 caller 预算无关。
   * step-up 时按 config ∪ 现 token scope ∪ challenge 求并集，避免“授权乒乓”；
   * insufficient_scope 强制重新授权（refresh 无法扩权）。
   * 任何编排异常都收敛为 {status:"failed", error}，不让 connecting 变成 rejected。
   */
  // [事务] 事务寿命固定 300 秒，与 caller 的等待预算解耦，真人来得及在浏览器完成授权
  // [失败路径] 任何编排异常收敛为 failed outcome，connecting 不会变成 rejected 污染后续快照
  // [权衡] step-up 时按配置、现 token 与 challenge 求 scope 并集，避免重授权乒乓
  private async runInteractiveOAuthAuthorization(input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    serverUrl: string;
    signal: AbortSignal;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpInteractiveAuthorizationOutcome> {
    try {
      const oauthOptions = this.createAuthorizationCodeOAuthOptions(
        input.config,
        input.name,
        input.generation,
      );
      const credentialStore = oauthOptions?.credentialStore ?? createSharedZCodeCredentialStore();
      const keyPrefix = createCredentialKeyPrefix(input.name, input.serverUrl, input.oauthConfig);
      // 403 step-up 的最终 scope 必须是 config ∪ token.scope ∪ challenge
      // 的并集。只带 challenge scope 重新授权时，授权服务器可能按新请求收回先前授予的 scope，
      // 下一个请求换个 challenge 又 403，形成重授权乒乓。token response 的 scope 允许缺失
      // （RFC 6749 §3.3），所以配置里声明过的 scope 必须显式并入，不能只看 token 回显。
      let requestedScope: string | undefined = input.oauthConfig.scope;
      if (input.trigger.requiredScope) {
        const currentPair = await loadCredentialPair(credentialStore, keyPrefix);
        requestedScope = computeScopeUnion(
          input.oauthConfig.scope,
          currentPair?.tokens?.scope,
          input.trigger.requiredScope,
        );
      }
      return await runMcpInteractiveAuthorization({
        adapterInstanceId: this.adapterInstanceId,
        config: input.oauthConfig,
        credentialStore,
        fetchFn: createMcpTransportFetch({ env: this.env, network: this.network }),
        // 403 step-up：requiredScope 是当前 token scope 的严格超集时 refresh 无法扩权
        // （RFC 6749 §6），必须强制重新授权，否则新 scope 会被静默丢弃并再次 403。
        ...(input.trigger.reason === "insufficient_scope" ? { forceReauthorization: true } : {}),
        keyPrefix,
        logger: this.logger,
        ...(oauthOptions?.onAuthorizationRequired
          ? { onAuthorizationRequired: oauthOptions.onAuthorizationRequired }
          : {}),
        ...(oauthOptions?.openAuthorizationUrl
          ? { openAuthorizationUrl: oauthOptions.openAuthorizationUrl }
          : {}),
        ...(requestedScope ? { requestedScope } : {}),
        ...(input.trigger.resourceMetadataUrl
          ? { resourceMetadataUrl: new URL(input.trigger.resourceMetadataUrl) }
          : {}),
        serverName: input.name,
        serverUrl: input.serverUrl,
        signal: input.signal,
        transactionTtlMs: MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS,
      });
    } catch (error) {
      // 本方法的返回类型已经把编排失败建模为 outcome。过去 credential load、
      // authz lease 或 follower callback 的异常会裸 reject，绕过 failConnection，留下
      // status=connecting + rejected record.connecting，并让 connectConfiguredServers 整批失败。
      this.logger?.warn("MCP OAuth authorization orchestration failed", {
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : "unknown",
        event: "mcp.oauth.authorization.orchestration_failed",
        mcpServerName: input.name,
        status: "failed",
      });
      return { status: "failed", error };
    }
  }

  /**
   * 统一失败收口：决定 failureKind、拼装带 requestId 的错误文案、关闭 client/transport，
   * generation 校验通过后写 failed record 并记录脱敏日志（含 stderr 尾部、pid）。
   * 优先级：official origin 不受信 > 连接期响应诊断 > 超时 > 调用方给定 > connection_failed。
   * 返回 failed 状态；关闭失败不会改变该结论。
   */
  // [失败路径] 分类优先级固定：官方 origin 不受信、连接期响应诊断、超时、caller 给定、connection_failed
  // [事务] 先关 client 与 transport 再校验 generation，过期任务不覆盖新 record
  // [资源] lastOfficialAuthKind 与连接期诊断取出即删，残留不会污染下一次失败归因
  private async failConnection(input: {
    client?: McpClient;
    config: McpServerConfig;
    connectDurationMs?: number;
    error: unknown;
    failureKind?: McpServerFailureKind;
    generation: number;
    getRecentStderr?: () => string | undefined;
    listToolsDurationMs?: number;
    name: string;
    startedAt: number;
    transport?: McpTransport;
  }): Promise<McpServerStatus> {
    const {
      client,
      config,
      connectDurationMs,
      error,
      failureKind: fallbackFailureKind,
      generation,
      getRecentStderr,
      listToolsDurationMs,
      name,
      startedAt,
      transport,
    } = input;
    const message = error instanceof Error ? error.message : String(error);
    // 官方 MCP 鉴权失败的稳定分类必须落进日志：failConnection 原先只记
    // error.message，而多数分类并不出现在 message 文本里（只有 auth-port 那条带上了），
    // 导致 official_mcp_origin_untrusted / official_auth_rejected 等在生产日志里 grep 不到。
    const officialAuthKind =
      (error instanceof OfficialMcpAuthError ? error.kind : undefined) ??
      this.lastOfficialAuthKind.get(name);
    this.lastOfficialAuthKind.delete(name);
    const responseDiagnostic = this.connectionDiagnosticByServer.get(name);
    this.connectionDiagnosticByServer.delete(name);
    const failureKind =
      (officialAuthKind === "official_mcp_origin_untrusted"
        ? "official_origin_untrusted"
        : undefined) ??
      responseDiagnostic?.failureKind ??
      (error instanceof McpTimeoutError && fallbackFailureKind !== "tool_list_failed"
        ? "connection_timeout"
        : undefined) ??
      fallbackFailureKind ??
      "connection_failed";
    const displayMessage = responseDiagnostic?.serverRequestId
      ? `${message} - ${responseDiagnostic.serverRequestId}`
      : message;
    const status = this.createStatus(config, "failed", {
      error: displayMessage,
      failureKind,
      ...(responseDiagnostic?.serverRequestId
        ? { serverRequestId: responseDiagnostic.serverRequestId }
        : {}),
    });
    const recentStderr = getRecentStderr?.();
    const mcpTransportPid = getStdioTransportPid(transport);
    await this.closeClientAndTransport(name, client, transport);
    if (!this.isCurrentConnection(name, generation)) {
      return this.records.get(name)?.status ?? status;
    }
    this.records.set(name, { config, status, tools: [] });
    this.logger?.warn("MCP server connection failed", {
      ...this.connectionContext,
      connectDurationMs,
      durationMs: Date.now() - startedAt,
      error: displayMessage,
      event: "mcp.server.failed",
      listToolsDurationMs,
      mcpServerName: name,
      ...(officialAuthKind ? { officialAuthKind } : {}),
      ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
      status: "failed",
      ...(recentStderr ? { stderr: recentStderr } : {}),
      transport: config.type,
    });
    return status;
  }

  /**
   * 按 config.type 构造 transport。
   *
   * stdio：ProcessTreeStdioClientTransport，cwd 相对 workingDirectory 解析，env 由宿主环境 +
   * 网络策略 + config.env 组成；官方 stdio 额外注入逐请求 requestMetaProvider。
   * http：StreamableHTTPClientTransport，官方鉴权时 fetch 换成 createOfficialAuthFetch 且
   * authProvider 为 undefined；sse：仅 SSE transport（老协议）。
   * 副作用：仅构造对象，不启动连接；env 合并顺序保证 config.env 覆盖宿主默认值。
   */
  // [资源] stdio 用自研 transport 以便按进程树回收，npx wrapper 拉起的子进程也不会残留
  // [事务] env 合并顺序为宿主环境、网络策略、config.env，后者覆盖前者
  // [权衡] 官方鉴权路径不注入 authProvider，401 不会误转成 MCP 授权流程
  private async createTransport(
    config: McpServerConfig,
    serverName: string,
    generation: number,
    _oauthAuthorizationTimeoutMs?: number,
    workingDirectory?: string,
    signal?: AbortSignal,
  ): Promise<{ transport: McpTransport }> {
    if (config.type === "stdio") {
      return {
        transport: new ProcessTreeStdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd
            ? resolve(workingDirectory ?? this.workingDirectory ?? process.cwd(), config.cwd)
            : (workingDirectory ?? this.workingDirectory),
          env: {
            ...buildMcpStdioEnv({ env: this.env, network: this.network }),
            ...config.env,
          },
          stderr: "pipe",
          ...(isOfficialAuthConfig(config) && config.official
            ? {
                requestMetaProvider: async () => {
                  const authMeta = await this.resolveOfficialStdioAuthMeta(
                    serverName,
                    config,
                    signal,
                  );
                  return authMeta ? { [OFFICIAL_MCP_AUTH_META_KEY]: authMeta } : undefined;
                },
              }
            : {}),
        }),
      };
    }

    const fetch = createMcpTransportFetch({
      env: this.env,
      network: this.network,
    });
    if (config.type === "http") {
      const officialAuthFetch = this.createOfficialAuthFetch(config, serverName, generation);
      return {
        transport: new StreamableHTTPClientTransport(new URL(config.url), {
          // 官方鉴权路径下 authProvider 必为 undefined：不落 OAuth 凭据、
          // 不起 localhost 回调 server、401/403 不转授权流程。
          authProvider: this.createOAuthClientProvider(serverName, config),
          fetch: officialAuthFetch ?? fetch,
          requestInit: config.headers ? { headers: config.headers } : undefined,
        }),
      };
    }

    return {
      transport: new SSEClientTransport(new URL(config.url), {
        authProvider: this.createOAuthClientProvider(serverName, config),
        fetch,
        requestInit: config.headers ? { headers: config.headers } : undefined,
      }),
    };
  }

  /**
   * 官方鉴权 MCP 的动态 fetch。返回 undefined 表示走普通 MCP 路径。
   *
   * trusted origin 依赖缺失时直接 fail closed。auth port 可以缺失：wrapper 仍校验 origin，
   * 各请求匿名降级并由服务端做权威判定。
   */
  /**
   * official HTTP MCP 的动态 fetch；非官方/非 http 返回 undefined（走普通路径）。
   * trustedOrigins 缺失时返回“永远抛 official_auth_unavailable”的 fail-closed fetch。
   * 回传：鉴权失败类别写入 lastOfficialAuthKind；响应诊断仅在 generation 仍当前时记录。
   */
  private createOfficialAuthFetch(
    config: McpServerConfig,
    serverName: string,
    generation: number,
  ): typeof globalThis.fetch | undefined {
    if (!isOfficialAuthConfig(config) || config.type !== "http" || !config.official) {
      return undefined;
    }
    const official = config.official;
    const authHeadersPort = this.officialMcpAuth?.authHeadersPort;
    const trustedOrigins = this.officialMcpAuth?.trustedOrigins;
    if (!trustedOrigins) {
      return (() => {
        throw new OfficialMcpAuthError(
          "official_auth_unavailable",
          `official MCP trusted origin registry is not available in this runtime: ${serverName}`,
        );
      }) as unknown as typeof globalThis.fetch;
    }
    return createOfficialMcpAuthFetch({
      baseFetch: createMcpTransportFetch({ env: this.env, network: this.network }),
      official,
      onAuthFailure: (kind) => this.lastOfficialAuthKind.set(serverName, kind),
      onServerResponse: (response) => {
        if (this.isCurrentConnection(serverName, generation)) {
          this.rememberServerResponse(serverName, response);
        }
      },
      serverName,
      trustedOrigins,
      url: config.url,
      ...(authHeadersPort ? { authHeadersPort } : {}),
      ...(this.logger ? { logger: this.logger } : {}),
      ...(this.officialMcpAuth?.workspaceIdentity
        ? { workspaceIdentity: this.officialMcpAuth.workspaceIdentity }
        : {}),
      ...(this.workingDirectory ? { workspacePath: this.workingDirectory } : {}),
    });
  }

  /**
   * 运行期 auth provider。
   *
   * 过去这里对任何没有 Authorization header 的 HTTP/SSE MCP
   * 都创建一个完整 OAuth session——而 session 在返回前就 `listen(0)` 起了一个 callback server，
   * 即使凭据完全有效、根本不需要授权。同时完整 `OAuthClientProvider` 会让 401 走 SDK 的
   * `auth()`，绕过我们的 refresh 单飞锁。
   *
   * 现在 authorization_code 一律使用纯 AuthProvider：被动连接零 listener、零 discovery、零 DCR，
   * 交互授权只在 Phase 2 事务里发生。
   */
  /**
   * 选择运行期 AuthProvider。
   *
   * stdio / 官方鉴权 → undefined（官方失败必须由 ZCode 登录/套餐解决，不能转 OAuth）；
   * authorization_code → 纯 token provider（零 listener/零 discovery/零 DCR，401 不绕过刷新锁）；
   * client_credentials → SDK ClientCredentialsProvider；其余 → undefined（匿名）。
   */
  private createOAuthClientProvider(
    serverName: string,
    config: McpServerConfig,
  ): AuthProvider | OAuthClientProvider | undefined {
    if (config.type === "stdio") return undefined;
    // 官方鉴权与 OAuth 互斥：官方 MCP 的失败只能由 ZCode 登录/套餐解决，
    // 交出任何 authProvider 都会让 401 误转成 MCP 授权流程。
    if (isOfficialAuthConfig(config)) return undefined;
    const authorizationCodeOAuthConfig = resolveAuthorizationCodeOAuthConfig(config);
    if (authorizationCodeOAuthConfig) {
      return createMcpOAuthTokenProvider({
        config: authorizationCodeOAuthConfig,
        credentialStore: this.resolveCredentialStore(),
        fetchFn: createMcpTransportFetch({ env: this.env, network: this.network }),
        keyPrefix: createCredentialKeyPrefix(serverName, config.url, authorizationCodeOAuthConfig),
        ...(this.logger ? { logger: this.logger } : {}),
        serverName,
        serverUrl: config.url,
      });
    }
    if (config.oauth?.type === "client_credentials") {
      return new ClientCredentialsProvider({
        clientId: config.oauth.clientId,
        clientName: config.oauth.clientName ?? `${this.clientName}-${serverName}`,
        clientSecret: config.oauth.clientSecret,
        scope: config.oauth.scope,
      });
    }
    return undefined;
  }

  /** 惰性解析共享凭据 store：宿主注入优先，否则创建共享实现；同一 adapter 内复用。 */
  private resolveCredentialStore(): SharedZCodeCredentialStore {
    this.credentialStore ??= this.mcpOAuth?.credentialStore ?? createSharedZCodeCredentialStore();
    return this.credentialStore;
  }

  /**
   * 组合 Phase 2 运行时选项：stdio 直接返回宿主选项；HTTP/SSE 额外包装授权回调，
   * 使 onAuthorizationRequired 先同步更新当前 record 的 authorization/connecting 状态，
   * 再转交宿主（设置页因此能看到授权 URL）。generation 校验保证只更新仍当前的连接。
   */
  private createAuthorizationCodeOAuthOptions(
    config: McpServerConfig,
    serverName: string,
    generation: number,
    oauthAuthorizationTimeoutMs?: number,
  ): McpOAuthRuntimeOptions | undefined {
    if (config.type === "stdio") return this.mcpOAuth;
    return {
      ...this.mcpOAuth,
      authorizationTimeoutMs: oauthAuthorizationTimeoutMs ?? this.mcpOAuth?.authorizationTimeoutMs,
      onAuthorizationRequired: async (context) => {
        this.updateCurrentRecordStatus(serverName, generation, {
          authorization: createOAuthAuthorizationStatus(context),
          status: "connecting",
        });
        await this.mcpOAuth?.onAuthorizationRequired?.(context);
      },
    };
  }

  /**
   * stdio 日志桥：仅 debug 级别挂 stderr 监听；按行缓冲、1440 字符上限、超过 4000 字符
   * 或 120 行重置；写入日志前脱敏 token/URL 凭据。connectionId 只保留短暂窗口。
   */
  private attachStdioLogging(name: string, transport: McpTransport): () => string | undefined {
    const stderrBuffer = createBoundedTextBuffer(MCP_STDIO_STDERR_LOG_MAX_CHARS);
    const stderr = (
      transport as {
        stderr?: { on(event: "data", handler: (chunk: Buffer) => void): void };
      }
    ).stderr;
    stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrBuffer.append(text);
      this.logger?.debug("MCP stdio stderr", {
        event: "mcp.stdio.stderr",
        mcpServerName: name,
        stderr: sanitizeMcpStdioStderr(text).slice(0, MCP_STDIO_STDERR_LOG_MAX_CHARS),
      });
    });
    return () => {
      const text = stderrBuffer.read();
      if (!text) return undefined;
      // 生产日志里单独的 Connection closed 无法定位 stdio MCP 子进程退出原因。
      // 只在失败事件附带尾部 stderr，并先脱敏，避免把凭据或高频输出写入生产日志。
      return sanitizeMcpStdioStderr(text).slice(-MCP_STDIO_STDERR_LOG_MAX_CHARS);
    };
  }

  /**
   * 关闭单条 record：若 record 仍是当前 generation 的对象，先替换为空壳（防止 close 期间
   * 又被写入旧状态），再关闭 client/transport。中途 new client 被并发替换时只关闭旧的，
   * 保留新连接。副作用：杀进程/关连接、日志；不抛错。
   */
  // [事务] 关闭前先 abort 该 record 的 controller，让在途任务尽早退出而不等超时
  // [并发] 只关闭当前 record 持有的 client 与 transport，已被并发替换的新连接不受影响
  private async closeRecord(name: string): Promise<void> {
    const record = this.records.get(name);
    if (!record) return;
    record.abortController?.abort(new Error(`MCP server ${name} connection closed`));
    if (!record.client && !record.transport) return;
    await this.closeClientAndTransport(name, record.client, record.transport);
  }

  /**
   * 关闭 client 与 transport：先 client.close（走正常 MCP 关闭），再终止进程树/transport；
   * 每步独立 try，失败只 warn，保证关闭路径不会中断后续步骤。
   */
  // [资源] 先摘 onclose 再关，正常回收不会被记成意外断连并触发误报崩溃
  // [资源] 先按进程树显式回收再走 SDK close，补上 SDK 只保证直接子进程退出的缺口
  // [失败路径] 每一步独立捕获且只 warn，关闭链不会因单步失败中断
  private async closeClientAndTransport(
    name: string,
    client?: McpClient,
    transport?: McpTransport,
  ): Promise<void> {
    const startedAt = Date.now();
    const mcpTransportPid = getStdioTransportPid(transport);
    // 主动关闭前先摘掉 connection_lost 监听，避免正常回收被误报为意外断连。
    if (client) client.onclose = undefined;
    // MCP SDK close 只保证直接 stdio 子进程退出，npx/npm wrapper 拉起的 MCP server
    // 或 chrome-devtools-mcp watchdog 可能残留；这里先按进程树显式回收，再走 SDK close 清理协议状态。
    await this.terminateStdioProcessTree(name, transport);

    try {
      await client?.close();
    } catch (error) {
      this.logger?.debug("MCP client close failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.client.close.failed",
        mcpServerName: name,
      });
    }

    try {
      await transport?.close();
    } catch (error) {
      this.logger?.debug("MCP transport close failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.transport.close.failed",
        mcpServerName: name,
      });
    }
    if (
      this.connectionContext &&
      transport instanceof ProcessTreeStdioClientTransport &&
      !transport.processAlive
    ) {
      this.telemetry?.recordProcessClosed({
        connectionId: this.connectionContext.mcpConnectionId,
      });
    }
    this.logger?.info("MCP server closed", {
      ...this.connectionContext,
      durationMs: Date.now() - startedAt,
      event: "mcp.server.closed",
      mcpServerName: name,
      ...(mcpTransportPid != null ? { mcpTransportPid } : {}),
      status: "completed",
    });
  }

  /** stdio 进程树回收：非 stdio/无 pid 直接返回；终止失败只 warn（兜底由 transport._dispose 完成）。 */
  private async terminateStdioProcessTree(name: string, transport?: McpTransport): Promise<void> {
    const pid = getStdioTransportPid(transport);
    if (pid == null) return;

    try {
      await terminateMcpStdioProcessTree(pid);
    } catch (error) {
      this.logger?.warn("MCP stdio process tree cleanup failed", {
        ...this.connectionContext,
        error: error instanceof Error ? error.message : String(error),
        event: "mcp.stdio.process_tree_cleanup.failed",
        mcpServerName: name,
        mcpTransportPid: pid,
        pid,
        status: "failed",
      });
    }
  }

  private readonly appConnectionListeners = new Map<string, Set<() => void>>();
  /**
   * 注册 app 连接失效监听；返回取消函数（幂等）。
   * 回调在 last listener 删除后清理 name 条目，避免长期空 Set。
   */
  onAppConnectionInvalidated(name: string, listener: () => void): () => void {
    const listeners = this.appConnectionListeners.get(name) ?? new Set();
    listeners.add(listener);
    this.appConnectionListeners.set(name, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.appConnectionListeners.delete(name);
    };
  }
  /**
   * 等待 app 连接：复用 record.connecting（不取消它），完成后校验 generation，
   * 已换代则返回 null（迟到结果丢弃）。无 record 直接 null。
   */
  async waitForAppConnection(
    name: string,
  ): Promise<{ identity: string; generation: number } | null> {
    const record = this.records.get(name);
    if (!record) return null;
    const generation = this.connectionGenerations.get(name) ?? 0;
    // 会话恢复先于 MCP 握手完成；复用已有连接任务，避免首次打开把 connecting 误判为失败。
    await record.connecting;
    return this.isCurrentConnection(name, generation) ? this.appConnectionSnapshot(name) : null;
  }

  /**
   * app 连接摘要：未 connected 返回 null；否则返回
   * identity=SHA256(platform + execPath + cwd + name + 规范化 config) 与当前 generation。
   * 配置键排序保证同一配置不同序列化顺序得到相同 identity；不输出任何凭据值。
   */
  // [事务] identity 由平台、可执行路径、工作目录、server 名与规范化配置共同决定
  // [并发] 配置键排序后哈希，序列化顺序差异不会让 UI 误判连接已换代
  // [资源] 只输出摘要，配置中的凭据既不进协议也不进日志
  appConnectionSnapshot(name: string): { identity: string; generation: number } | null {
    const record = this.records.get(name);
    if (!record?.client || record.status.status !== "connected") return null;
    // 只向宿主输出摘要；配置中的凭据不进入协议或日志。属性排序避免配置序列化次序造成换源。
    const canonical = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonical);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        );
      return value;
    };
    return {
      identity: createHash("sha256")
        .update(
          JSON.stringify([
            process.platform,
            process.execPath,
            this.workingDirectory ?? "",
            name,
            canonical(record.config),
          ]),
        )
        .digest("hex"),
      generation: this.connectionGenerations.get(name) ?? 0,
    };
  }

  /** 分配该 server 下一个单调 generation（仅递增，用于 fencing 所有异步回写）。 */
  private nextConnectionGeneration(name: string): number {
    const generation = (this.connectionGenerations.get(name) ?? 0) + 1;
    this.connectionGenerations.set(name, generation);
    // eslint-disable-next-line unicorn/no-useless-spread -- 回调可能增删监听器，本次通知必须固定接收者。
    for (const listener of [...(this.appConnectionListeners.get(name) ?? [])]) listener();
    return generation;
  }

  /**
   * falsing 校验：record 引用与 generation 都必须与任务开始时一致。
   * 任一不符说明 server 已被重连/替换/关闭，任务结果必须丢弃。
   */
  private isCurrentConnection(name: string, generation: number): boolean {
    return this.connectionGenerations.get(name) === generation;
  }

  /** 在当前 generation 上整体替换 record（不改 generation），供成功连接/状态推进使用。 */
  private updateCurrentRecord(
    name: string,
    generation: number,
    patch: Partial<Pick<McpServerRecord, "client" | "transport">>,
  ): void {
    if (!this.isCurrentConnection(name, generation)) return;
    const record = this.records.get(name);
    if (!record) return;
    Object.assign(record, patch);
  }

  /** 在当前 generation 上原地推进 status（保留同一 record 对象）；换代后静默忽略。 */
  private updateCurrentRecordStatus(
    name: string,
    generation: number,
    patch: Partial<McpServerStatus>,
  ): void {
    if (!this.isCurrentConnection(name, generation)) return;
    const record = this.records.get(name);
    if (!record) return;
    record.status = {
      ...record.status,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
  }

  /** 生成对外状态快照：深拷贝 tools 数组并冻结时间戳，防止调用方或后续变更串改历史状态。 */
  private createStatus(
    config: McpServerConfig,
    status: McpServerStatus["status"],
    extra: {
      authorization?: McpServerStatus["authorization"];
      error?: string;
      failureKind?: McpServerStatus["failureKind"];
      protocolEra?: McpServerStatus["protocolEra"];
      serverRequestId?: string;
      toolCount?: number;
    } = {},
  ): McpServerStatus {
    return {
      status,
      transport: config.type,
      toolCount: extra.toolCount ?? 0,
      updatedAt: new Date().toISOString(),
      authorization: extra.authorization,
      error: extra.error,
      failureKind: extra.failureKind,
      protocolEra: extra.protocolEra,
      serverRequestId: extra.serverRequestId,
    };
  }
}

/**
 * 生成 MCP 请求的扩展 _meta：把 trace / runtimeScope / workspace / 交付语义平铺，
 * 并镜像到 `com.zcode/request-context`。runtime_scope 必须由实际执行 runtime 显式传入，
 * 不能从 child session id 推断（node_repl browser bridge 以此回连）。缺字段即省略。
 * 返回新对象，无副作用。
 */
function mcpRequestMeta(request: McpCallToolRequest): Record<string, unknown> {
  // nodeRepl.requestMeta 暴露。ZCode 所有 MCP server 都可忽略这些扩展键；node_repl browser
  // bridge 则以它们作为回到当前 BrowserControlPort session 的唯一关联依据。runtime_scope
  // 不能从 child session id 猜测，必须由实际执行工具的 runtime 显式透传。
  const requestContext = {
    ...(request.trace ? { trace_id: request.trace.traceId } : {}),
    ...(request.trace?.spanId ? { span_id: request.trace.spanId } : {}),
    ...(request.trace?.parentSpanId ? { parent_span_id: request.trace.parentSpanId } : {}),
    ...(request.trace?.sessionId ? { session_id: request.trace.sessionId } : {}),
    ...(request.trace?.turnId ? { turn_id: request.trace.turnId } : {}),
    ...(request.runtimeScope ? { runtime_scope: request.runtimeScope } : {}),
    ...(request.workspacePath ? { workspace_path: request.workspacePath } : {}),
    ...(request.workspaceIdentity ? { workspace_identity: request.workspaceIdentity } : {}),
    ...(request.workspaceKey ? { workspace_key: request.workspaceKey } : {}),
    ...(request.remoteSessionId ? { remote_session_id: request.remoteSessionId } : {}),
    ...(request.clientMode ? { client_mode: request.clientMode } : {}),
    ...(request.deliveryKind ? { delivery_kind: request.deliveryKind } : {}),
    ...(request.turnId && !request.trace?.turnId ? { turn_id: request.turnId } : {}),
  };
  return {
    ...requestContext,
    "com.zcode/request-context": requestContext,
  };
}

/**
 * 决定版本协商模式：显式 pinned 版本 → {pin}；deprecated SSE 只承载 legacy；
 * 显式 legacy → legacy；其余 auto（probe 失败可回退 legacy）。
 * pin 不允许静默降级（否则会用错误协议与 server 对话）。
 */
// [权衡] 显式 pin 不允许静默降级，用错协议与 server 对话比连接失败更难排查
// [失败路径] SSE 只承载 legacy era，显式 modern pin 仍应失败而不是回退
function resolveVersionNegotiationMode(config: McpServerConfig): VersionNegotiationMode {
  if (config.protocolVersion === "2026-07-28") return { pin: "2026-07-28" };
  // deprecated SSE transport 本身只承载 legacy era；显式 modern pin 仍应失败而不能静默降级。
  if (config.type === "sse") return "legacy";
  if (config.protocolVersion === "legacy") return "legacy";
  return "auto";
}

/**
 * SDK 版本协商（auto/pin 的 server/discover probe）失败的稳定识别。
 *
 * 结构化判定，禁止匹配错误文本：
 * - `SdkError(SdkErrorCode.EraNegotiationFailed)`：probe 硬失败（含非标 legacy server 的
 *   malformed 200 响应，经 transport 层 Zod 校验失败 + normalizeReply 落入 network-error 分支）；
 * - `UnsupportedProtocolVersionError`：recognized modern error，pin 版本不被 server 接受。
 */
function isProtocolNegotiationFailure(error: unknown): boolean {
  if (SdkError.isInstance(error) && error.code === SdkErrorCode.EraNegotiationFailed) {
    return true;
  }
  if (UnsupportedProtocolVersionError.isInstance(error)) return true;
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (cause !== undefined && cause !== error) {
    return isProtocolNegotiationFailure(cause);
  }
  return false;
}

/** 把协商模式压成日志用字符串：pin 显示版本号，其余显示 auto/legacy。 */
function formatVersionNegotiationMode(config: McpServerConfig): string {
  const mode = resolveVersionNegotiationMode(config);
  return typeof mode === "object" ? mode.pin : mode;
}

/**
 * 组装 SDK VersionNegotiationOptions。
 *
 * legacy 不探测；auto 的 probe 预算取总超时的一半并封顶 5s（给 legacy initialize 留余量）；
 * pin 没有 fallback，probe 即唯一 initialize，直接用完整总超时（至少 1ms），
 * 避免冷启动 >5s 的 server 被静默移出工具池。
 */
function resolveVersionNegotiation(
  config: McpServerConfig,
  timeoutMs: number,
): VersionNegotiationOptions {
  const mode = resolveVersionNegotiationMode(config);
  if (mode === "legacy") return { mode };

  // pin 没有 legacy fallback，probe 就是唯一 initialize 路径；沿用 auto 的 5 秒
  // 保护上限会无视 server 的长连接预算，把冷启动正常但超过 5 秒的 node_repl 静默移出工具池。
  const probeTimeoutMs =
    typeof mode === "object"
      ? Math.max(1, Math.floor(timeoutMs))
      : Math.min(MAX_MCP_VERSION_PROBE_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs / 2)));

  return {
    mode,
    probe: {
      // 原因：SDK 的 stdio auto/pin 会先启动 disposable sibling；若沿用 SDK 60s 默认值，
      // ZCode 的总连接超时可能先结束并让 probe 残留，也不给 legacy initialize 留预算。
      timeoutMs: probeTimeoutMs,
    },
  };
}

/** 把授权上下文映射成对外状态；只含 URL 与开始时间，不含 code/state/verifier。 */
function createOAuthAuthorizationStatus(
  context: McpOAuthAuthorizationContext,
): NonNullable<McpServerStatus["authorization"]> {
  return {
    type: "oauth_authorization_code",
    authorizationUrl: context.authorizationUrl,
    startedAt: new Date().toISOString(),
  };
}

/**
 * 解析 authorization_code OAuth 配置。
 *
 * 优先级：stdio / 官方鉴权（互斥，必须最前）/ 显式 authorization_code / client_credentials /
 * 已有静态 Authorization 头 → undefined；否则兜底返回 {type:"authorization_code"}，
 * 让仅配置 URL 的 server 能由 401 + discovery 触发授权，而不要求预写 oauth 字段。
 * 官方鉴权优先的原因是：其失败只能由 ZCode 登录/套餐解决，落入 OAuth 会弹错误授权 UI。
 */
function resolveAuthorizationCodeOAuthConfig(
  config: McpServerConfig,
): AuthorizationCodeOAuthConfig | undefined {
  if (config.type === "stdio") return undefined;
  // 官方鉴权与 MCP OAuth 互斥。必须位于所有既有分支之前：
  // 官方 MCP 既不写 oauth 字段、又禁止静态 authorization 头，若不在此短路就会落进
  // 下面的 authorization_code 兜底，导致 401 时弹出 MCP 授权 UI —— 而官方鉴权失败
  // 只能由 ZCode 自身的登录/套餐解决，不可能由目标 MCP 的 OAuth 授权解决。
  if (isOfficialAuthConfig(config)) return undefined;
  if (config.oauth?.type === "authorization_code") return config.oauth;
  if (config.oauth?.type === "client_credentials") return undefined;
  if (hasAuthorizationHeader(config.headers)) return undefined;

  // 新建 HTTP/SSE MCP 常只保存 URL；OAuth 支持应由服务端
  // WWW-Authenticate / discovery 触发，不能要求配置里预先写 oauth 字段。
  return {
    type: "authorization_code",
  };
}

/**
 * auth.type/provider 精确命中且 provenance 存在时为真；provenance 缺失说明不是 Plugin loader
 * 产出的配置。
 *
 * 覆盖 http 与 stdio 两种形态——两者的凭证投递通道不同，但"是否官方鉴权"
 * 的判定同源。调用方若只关心某一形态，需自行再判 `config.type`（如 createOfficialAuthFetch
 * 只处理 http、_meta 注入只处理 stdio）。
 */
function isOfficialAuthConfig(config: McpServerConfig): boolean {
  return (
    (config.type === "http" || config.type === "stdio") &&
    config.auth?.type === "zcode_official" &&
    config.auth.provider === "jwt_token" &&
    config.official !== undefined
  );
}

/** 是否存在静态 Authorization 头（大小写不敏感）；存在则不再走 OAuth 兜底。 */
function hasAuthorizationHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
}

/** 有界文本缓冲：append 超过 maxChars 时保留尾部（最新 stderr 更有诊断价值）。 */
function createBoundedTextBuffer(maxChars: number): {
  append(text: string): void;
  read(): string;
} {
  let value = "";
  return {
    append(text: string) {
      if (!text) return;
      value = `${value}${text}`;
      if (value.length > maxChars) {
        value = value.slice(-maxChars);
      }
    },
    read() {
      return value;
    },
  };
}

/**
 * stderr 脱敏：依次处理 Bearer、authorization 头、URL query 中的敏感键、JSON/键值对中的
 * 敏感键、URL 内嵌 userinfo。宁可过度隐藏，也不能把 token/密码写进日志。
 * 纯函数，无副作用。
 */
// [资源] stderr 落日志前依次处理 Bearer、authorization 头、query、JSON 键值与 URL userinfo
// [权衡] 宁可过度隐藏也不做精确匹配，日志留存周期不受控，泄露一条凭据即不可逆
// [事务] 纯函数只读入参，失败事件里附带的 stderr 尾部同样经过这里
function sanitizeMcpStdioStderr(text: string): string {
  const sensitiveKey = String.raw`(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|private[_-]?key|token|password|passwd|pass|mysql_pass|mysql_password)`;
  let result = text.replace(/(bearer\s+)[^\s"']+/gi, "$1[Redacted]");
  result = result.replace(
    /(\bauthorization\b\s*[:=]\s*)(bearer\s+)?[^\r\n]+/gi,
    (_match, prefix: string, bearer: string | undefined) =>
      `${prefix}${bearer ? "Bearer " : ""}[Redacted]`,
  );
  result = result.replace(new RegExp(`([?&]${sensitiveKey}=)[^&\\s]+`, "gi"), "$1[Redacted]");
  result = result.replace(
    new RegExp(`(["']${sensitiveKey}["']\\s*:\\s*)(["'])(?:(?!\\2).)*\\2`, "gi"),
    "$1$2[Redacted]$2",
  );
  result = result.replace(
    new RegExp(`(\\b${sensitiveKey}\\b\\s*[:=]\\s*)(["']?)[^\\s"',;)}]+`, "gi"),
    "$1$2[Redacted]",
  );
  return result.replace(/([a-z][a-z0-9+.-]*:\/\/)[^:\s/@]+:[^@\s/]+@/gi, "$1[Redacted]@");
}

/** 读取 stdio transport 的 pid：仅正整数才算有效；非 stdio/未 spawn 返回 undefined。 */
function getStdioTransportPid(transport?: McpTransport): number | undefined {
  if (!(transport instanceof StdioClientTransport)) return undefined;
  const pid = transport.pid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * 读取首次退出快照；只有自研 transport 暴露 processExit。
 * exitCode 与 signal 同时为 null 表示尚未退出，调用方需另行判断存活。
 */
function getStdioTransportExitInfo(transport?: McpTransport):
  | {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }
  | undefined {
  return transport instanceof ProcessTreeStdioClientTransport ? transport.processExit : undefined;
}

/** 是否仍有存活子进程；非自研 transport 一律 false（无法判断）。 */
function isStdioTransportProcessAlive(transport?: McpTransport): boolean {
  return transport instanceof ProcessTreeStdioClientTransport && transport.processAlive;
}

/** 纯对象判定：排除 null 与数组；用于错误对象/配置的安全下钻。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// server 回了 JSON-RPC 错误响应（数字 code）说明请求走通了、连接是活的；
// SDK 本地错误（SdkError，字符串 code：REQUEST_TIMEOUT / CONNECTION_CLOSED / NOT_CONNECTED
// / SEND_FAILED）才代表 transport 已断。code 类型判断兜底 instanceof 在多份 SDK 实例下失效的情况。
function isPeerAnsweredError(error: unknown): boolean {
  if (error instanceof ProtocolError) return true;
  return isRecord(error) && typeof error.code === "number";
}
