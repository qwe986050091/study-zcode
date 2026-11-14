// MCP Port - Model Context Protocol adapter boundary
// 定位：CLI 与外部 MCP server 之间的连接/工具面契约。core 只消费归一化后的
// descriptor、resource 与通知，adapter 负责 transport、鉴权、重连与工具列表刷新。
// 生命周期不变量：连接按隔离域复用，失败必须 fail closed（不可用/不可信即不暴露工具），
// 断连不代表授权仍然有效；工具可见名由 core 统一生成 mcp__<server>__<tool>。
// 生产者在 adapters/src/mcp，消费者是 core 的工具注册、资源 UI 与会话启动流程；
// 端口不做权限判定，调用前由 core 完成工具/服务器级授权。

import type { McpServerFailureKind, OfficialMcpAuthPortFailureReason } from "@zcode/shared";
import type { McpAppsToolVisibility, McpToolUiDescriptor } from "@zcode/shared/mcp-apps";
import type { JsonSchema } from "../model/index.js";
import type { TraceContext } from "../tracing/tracer.js";

// transport 形态。stdio 在本机拉起子进程（命令可执行，结果由插件进程自产）；
// http/sse 指向远端 server。官方鉴权只允许 http/stdio，sse 一律拒绝。
export type McpServerTransportType = "stdio" | "http" | "sse";
// 协议版本协商。legacy=旧版初始化握手；auto=按 server 响应自适应；
// 2026-07-28=固定现代协议。版本影响能力声明与通知形状，不能随意混用。
export type McpProtocolVersion = "legacy" | "auto" | "2026-07-28";
// 连接隔离域。session=仅当前会话复用，workspace=同工作区跨会话复用；
// 隔离决定连接池 key，也决定凭证与状态是否可能被其它会话观察到。
export type McpServerIsolation = "session" | "workspace";

/** 公共 MCP 配置校验完成后由宿主附加的运行时来源。 */
export interface McpServerRuntimeSource {
  kind: "builtin" | "plugin";
}

// 所有 server 配置的公共字段。alwaysLoad 让工具绕过 ToolSearch 延迟加载；
// enabled=false 时只保留配置不建连；isolation/protocolVersion 影响连接池与握手；
// timeoutMs 是单次协议请求的默认预算，不是连接建立预算；source 仅宿主可写。
export interface McpServerConfigBase {
  alwaysLoad?: boolean;
  enabled?: boolean;
  isolation?: McpServerIsolation;
  protocolVersion?: McpProtocolVersion;
  /** 仅限宿主生成，公共配置 schema 会拒绝该字段。 */
  source?: McpServerRuntimeSource;
  timeoutMs?: number;
}

// client_credentials：机器对机器授权，clientSecret 必填，走 server 端 token 端点；
// 适用于无人值守的服务账号，不产生用户交互，也不会触发浏览器回调。
export interface McpClientCredentialsOAuthConfig {
  type: "client_credentials";
  clientId: string;
  clientSecret: string;
  clientName?: string;
  scope?: string;
}

// authorization_code：需要用户浏览器授权的交互流程。clientId/Secret 可缺席
// （支持动态客户端注册）；redirectPath 是本地回调路径，等待上限由
// McpConnectOptions.oauthAuthorizationTimeoutMs 单独约束，不复用 timeoutMs。
export interface McpAuthorizationCodeOAuthConfig {
  type: "authorization_code";
  clientId?: string;
  clientSecret?: string;
  clientName?: string;
  redirectPath?: string;
  scope?: string;
}

// OAuth 配置判别联合，按 type 分支；同一 server 至多一种，配置 schema 保证互斥。
export type McpOAuthConfig = McpAuthorizationCodeOAuthConfig | McpClientCredentialsOAuthConfig;

/**
 * ZCode 官方 Server MCP 的鉴权声明。
 * 允许出现在 `type: "http"` 与 `type: "stdio"`；`sse` 仍拒。
 * `type`/`provider` 均为精确值，不接受别名或大小写变体。
 *
 * 注意：该字段本身**不构成**官方身份证明。官方身份由运行时解析的 ZCode API origin 判定
 * （host 侧还会二次校验）；第三方 Plugin 复制该字段只能让凭证流向真实 ZCode 后端。
 *
 * 两种形态的凭证投递通道不同：
 * - http：宿主在 fetch wrapper 里逐请求注入身份头，凭证从不进入插件进程；
 * - stdio：请求由插件进程自己发出，身份头随每条出站协议消息的 `_meta` 下发。
 */
export interface ZCodeOfficialMcpAuthConfig {
  type: "zcode_official";
  provider: "jwt_token";
}

/**
 * Plugin loader 生成的运行时归属信息，`.mcp.json` 不能覆盖。
 * 用于凭据解析和日志关联，不参与信任判定。
 * 目标 origin 必须通过 `isOfficialMcpOriginTrusted` 的校验；插件身份本身不构成
 * 授权过滤条件。目的地校验与服务端接口权限、套餐、配额校验分别承担不同边界。
 */
export interface McpOfficialProvenance {
  pluginId: string;
  /** Plugin 内的原始 MCP key（未加 `plugin:<name>:` 命名空间前缀）。 */
  mcpKey: string;
  source: "plugin";
}

// stdio server 配置。command/args/cwd/env 直接决定被拉起的子进程；
// auth 只允许 zcode_official 声明；official 是宿主注入的归属信息，文件配置不可伪造。
// stdio 的结果由插件进程自己产出，因此永远不会被标记为可信（见 McpToolDescriptor.official）。
export interface McpStdioServerConfig extends McpServerConfigBase {
  type: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  auth?: ZCodeOfficialMcpAuthConfig;
  /** 宿主生成，禁止来自文件配置。 */
  official?: McpOfficialProvenance;
}

// http server 配置。url 必须是可解析的绝对地址；headers 是静态附加头；
// oauth 与 auth 互斥由 schema 保证；official 同样仅宿主可写。
// http 是唯一能让工具结果被信任为官方产出的 transport（需再满足 auth 声明与 origin 校验）。
export interface McpHttpServerConfig extends McpServerConfigBase {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  auth?: ZCodeOfficialMcpAuthConfig;
  /** 宿主生成，禁止来自文件配置。 */
  official?: McpOfficialProvenance;
}

// sse server 配置。仅支持 url/headers/oauth；刻意没有 auth/official：
// 官方鉴权声明在 sse 上被配置校验拒绝，避免凭证流向非预期端点。
export interface McpSseServerConfig extends McpServerConfigBase {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
}

// server 配置判别联合。按 type 分派；所有成员共享 McpServerConfigBase 的通用字段。
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

// 连接状态机。connecting=正在建立；connected=可用；disabled=配置禁用；
// disconnected=曾经连上但已断；failed=建立/握手失败；untrusted=origin 校验未通过。
// 只有 connected 才允许暴露工具；其余状态必须按"无工具/不可调用"处理。
export type McpServerStatusKind =
  | "connecting"
  | "connected"
  | "disabled"
  | "disconnected"
  | "failed"
  | "untrusted";

// 某 server 的状态快照。toolCount 是最近一次成功 listTools 的数量，不代表实时；
// updatedAt 是 ISO 时间串，用于 UI 排序/陈旧判断；error/failureKind 只在失败态出现；
// serverRequestId 用于服务端排障；authorization 表示正等待用户完成 OAuth。
export interface McpServerStatus {
  status: McpServerStatusKind;
  transport: McpServerTransportType;
  toolCount: number;
  updatedAt: string;
  error?: string;
  failureKind?: McpServerFailureKind;
  serverRequestId?: string;
  protocolEra?: "legacy" | "modern";
  authorization?: {
    type: "oauth_authorization_code";
    authorizationUrl: string;
    startedAt: string;
  };
}

// MCP 官方标注（advisory）。这些只是 server 的自我声明，用于生成权限建议
// （如 readOnlyHint 可降低审批等级），绝不能替代本地权限判定；缺省即未声明。
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// 错误呈现策略键。`message-only` 表示宿主只取 message 展示，不渲染结构化细节；
// 该键由 server 在结果 `_meta` 中给出，客户端只做白名单解释，不执行任意结构。
export const ZCODE_MCP_ERROR_PRESENTATION_META_KEY = "zcode/errorPresentation";
export const ZCODE_MCP_ERROR_PRESENTATION_MESSAGE_ONLY = "message-only";
// 截图内容索引键。值必须是数字数组，指向 content 中由模型显式 tab.screenshot()
// 产生的 image block；宿主只按这些索引做展示/归属，不据此重排内容。
// 同 ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY，模型侧 sandbox API 也能写 `_meta`，
// 因此该键必须由宿主校验后采信，不能直接信任 producer 声明。
/** MCP content 中来自模型显式 tab.screenshot() 的 image block 索引。 */
export const ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY =
  "zcode/browserScreenshotContentIndices";
/**
 * 本次 node_repl cell 操作的目标应用身份，供工具卡显示 App 图标。
 *
 * **只能由 node-repl-host 写入**：宿主的 CUA bridge 从 broker 响应里读 producer 的
 * `zcode.cua/app-associations-v1`，投影成这里的最小形态。producer 那个键本身经
 * `nodeRepl.setResponseMeta` / `nodeRepl.emitStructuredResult` 也能到达 `_meta`，而这两个
 * API 挂在模型可见的 sandbox globals 上，因此不可信、必须在宿主侧丢弃（同
 * `ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY` 的处置）。
 */
export const ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY = "zcode/nodeReplCuaApp";
/**
 * 官方 Server MCP 响应头里的 `x-request-id`，附在失败的 tool result 上（值为 string）。
 *
 * 用短前缀 `zcode/` 而不是 `com.zcode/`：这不是跨语言协议——服务端在 header 里给，客户端
 * 读到后自己搬进 `_meta`，产出与消费都在客户端（`com.zcode/` 留给 Go 侧直接产出的键，
 * 如 `com.zcode/mcp-unavailable`）。
 *
 * 只在 `isError` 时附加：这是给人看的排障线索（拿它去查服务端日志），成功路径上是纯噪声。
 */
export const ZCODE_MCP_SERVER_REQUEST_ID_META_KEY = "zcode/officialMcpServerRequestId";

// 归一化后的工具描述符。serverName/toolName 是原始身份，name 是 server 声明的
// 模型可见名（缺省由 core 生成 mcp__<server>__<tool>）；inputSchema/outputSchema
// 用于注册与校验；alwaysLoad/searchHint 影响工具面加载；timeoutMs 来自工具 `_meta`
// 并经 MIN/MAX 夹取。official/visibility/ui 见各自字段说明。
export interface McpToolDescriptor {
  alwaysLoad?: boolean;
  searchHint?: string;
  serverName: string;
  toolName: string;
  name?: string;
  description?: string;
  timeoutMs?: number;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: McpToolAnnotations;
  /**
   * 该 tool 的结果**可信到足以据此改变界面**：来自 `type: "http"` 且声明
   * `auth.type = zcode_official` 的 MCP server。
   *
   * 唯一用途是信任结果里的结构化标识（额度耗尽 / 无套餐的 `error_code`）。判据是"结果由谁产出"
   * 而不是"插件是谁"：
   * - http：响应来自 ZCode 后端。连接存活即意味着每个请求都过了 origin 校验且 fail closed，
   *   第三方插件即使声明官方鉴权，也只能把请求打到真实 ZCode，响应体不由它写；
   * - stdio：结果由插件进程自己产出、可任意伪造，因此**不置位**。
   *
   * 刻意**不**按"插件是否来自官方 marketplace"判定：那会让非官方安装源（含本地自测与
   * zcode-plugins-test）的官方插件失效，而它也不是真实屏障——详见 `@zcode/shared` 的
   * `isOfficialMcpOriginTrusted`。
   */
  official?: boolean;
  /**
   * 工具对谁开放（`_meta.ui.visibility`，缺省 `["model", "app"]`），与是否带 UI 资源无关。
   * 不含 "model" 的工具不进 provider contracts；不含 "app" 的工具拒绝 `mcp/uiCallTool`。
   * 由 adapter 归一化写入；缺省（旧 descriptor）时以 `ui.visibility` 兜底，再缺省视为两者都可见。
   */
  visibility?: McpAppsToolVisibility[];
  /**
   * 工具 `_meta` 归一化后的插件 UI 呈现描述。
   * 只有声明了合法 `ui://` resourceUri 的工具才有；其中的 visibility 与上面的字段同源。
   */
  ui?: McpToolUiDescriptor;
}

// 可见性解析的唯一入口。顺序固定：descriptor.visibility → ui.visibility →
// 两者都可见；宿主与 adapter 必须调用本函数而不是各自实现，避免两侧判定漂移。
/** 可见性判定的唯一实现：descriptor.visibility → ui.visibility → 两者都可见。 */
export function resolveMcpToolVisibility(
  descriptor: Pick<McpToolDescriptor, "visibility" | "ui">,
): McpAppsToolVisibility[] {
  return descriptor.visibility ?? descriptor.ui?.visibility ?? ["model", "app"];
}

// MCP content block 的宽松形状。协议允许任意块类型，core 只按已知 type 投影
// （text/image/resource 等），未知块原样保留供 UI/调试，不参与模型输入。
export type McpContentBlock = Record<string, unknown>;

// 工具调用结果。content 是模型可见块序列；structuredContent 是结构化载荷
// （仅供 UI/程序消费，是否进模型由调用方决定）；isError=true 表示业务失败；
// _meta 携带协议附加信息（错误呈现、截图索引、服务端 request-id 等）。
export interface McpToolCallResult {
  content: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

// 读资源请求。uri 原样透传（可能是 ui:// 或自定义 scheme），不做路径归一化；
// trace 用于把资源读取关联到发起它的工具/会话。
export interface McpReadResourceRequest {
  serverName: string;
  uri: string;
  trace?: TraceContext;
}

// 单个资源内容。text 与 blob 互斥（blob 是 base64）；mimeType 决定宿主如何解释；
// _meta 原样保留，由消费方按白名单读取，不注入模型上下文。
export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
}

// 读资源结果。contents 可能为空数组（资源存在但无内容），调用方不得据此判断 uri 无效；
// 顺序按 server 返回原样保留。
export interface McpReadResourceResult {
  contents: McpResourceContent[];
}

// 列表请求。cursor 是 server 分页游标，必须原样透传，不得解析或自行拼接；
// 首屏不传，后续用上次结果的 nextCursor。
/** `resources/list` / `resources/templates/list`（分页游标原样透传）。 */
export interface McpListResourcesRequest {
  serverName: string;
  cursor?: string;
  trace?: TraceContext;
}
// 资源描述。uri 是资源标识；name/title/description/mimeType 为展示与提示信息；
// _meta 可能含 UI 相关声明，宿主按白名单消费。
export interface McpResourceDescriptor {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}
// 资源列表页。nextCursor 缺席表示没有下一页；存在即表示还有未取内容，
// 调用方应继续分页而不是假定列表完整。
export interface McpListResourcesResult {
  resources: McpResourceDescriptor[];
  nextCursor?: string;
}
// 资源模板描述。uriTemplate 是 RFC 6570 风格的模板串，不能用普通 URI 解析器处理；
// 其余字段同资源描述，仅用于展示与选择。
export interface McpResourceTemplateDescriptor {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  _meta?: Record<string, unknown>;
}
// 模板列表页。nextCursor 语义与资源列表一致；资源列表与模板列表是两条独立分页流。
export interface McpListResourceTemplatesResult {
  resourceTemplates: McpResourceTemplateDescriptor[];
  nextCursor?: string;
}
// 订阅请求。subscriberKey 必须由调用方生成且在会话内稳定（bootstrap 用
// sessionId|scopeId|generation），用于退订与重连重放；同一 (server,uri) 多个
// subscriber 只向 server 订阅一次，登记表按引用计数管理。
/**
 * 资源订阅。`subscriberKey` 由调用方给出（bootstrap 用 sessionId|scopeId|generation），
 * 登记表在连接层按 (serverName, uri) 计数：0→1 才真调 SDK subscribe，1→0 才 unsubscribe；断连重连后按登记表重放。
 */
export interface McpResourceSubscriptionRequest {
  serverName: string;
  uri: string;
  subscriberKey: string;
  trace?: TraceContext;
}
// server 未声明 resources.subscribe 时抛出。code 固定为协议错误 -32001，
// 调用方按类型/码分支，禁止解析 message；serverName 仅用于诊断。
/** server 没有声明 `capabilities.resources.subscribe` 时抛出（协议层映射为 -32001 not_supported）。 */
export class McpResourceSubscribeUnsupportedError extends Error {
  readonly code = "not_supported" as const;
  constructor(readonly serverName: string) {
    super(`MCP server ${serverName} does not support resource subscriptions`);
    this.name = "McpResourceSubscribeUnsupportedError";
  }
}

// server → client 通知的归一化形状。订阅类通知（resourceUpdated/resourceListChanged）
// 带当前登记的 subscriberKey，宿主据此按会话拆分；toolListChanged 只提示"工具面已变"，
// 由 runtime 比较 toolListRevision 后决定是否重拉；loggingMessage 不进入模型上下文。
// 所有通知都是事后事实，不保证顺序、不保证送达，消费方不得据此维持状态机。
/** server → client 通知，adapter 转成宿主可消费的形状；订阅类通知带当前登记的 subscriberKey。 */
export type McpServerNotification =
  | { kind: "resourceUpdated"; serverName: string; uri: string; subscribers: string[] }
  | { kind: "resourceListChanged"; serverName: string; subscribers: string[] }
  | { kind: "toolListChanged"; serverName: string }
  | { kind: "loggingMessage"; serverName: string; level: string; logger?: string; data: unknown };
// 通知消费端口。onNotification 必须同步返回且不得抛错：它由 SDK 回调线程调用，
// 抛错会影响连接层；耗时处理应由实现方自行转投异步队列。
export interface McpNotificationPort {
  onNotification(notification: McpServerNotification): void;
}

// 连接快照。statuses 以 server 名为 key，tools 只包含当前 connected server 的工具；
// 快照是某一时刻的投影，不随通知自动更新，调用方不得长期持有。
export interface McpConnectionSnapshot {
  statuses: Record<string, McpServerStatus>;
  tools: McpToolDescriptor[];
}

// 连接选项。oauthAuthorizationTimeoutMs 是 authorization_code 回调等待上限，
// 与 timeoutMs（协议请求）分开；revalidate=true 时复用连接前先 ping，已死则重连
// （设置页刷新必须置位，session 启动不必）；signal 中止整个连接流程；
// workingDirectory 是 stdio 的默认 cwd，workspaceIdentity 优先用于隔离 key。
export interface McpConnectOptions {
  /**
   * authorization_code OAuth callback 的等待上限。
   * 普通 MCP timeoutMs 只约束协议请求，session 启动需要单独限制 OAuth 授权等待。
   */
  oauthAuthorizationTimeoutMs?: number;
  /**
   * 复用既有连接前先校验其存活性（见 McpPort.pingServer），已死则重连。
   * 设置页刷新这类"用户明确要求重新探测"的调用必须置位；session 启动不需要，
   * 复用池中刚建立的连接即可。
   */
  revalidate?: boolean;
  signal?: AbortSignal;
  trace?: TraceContext;
  workingDirectory?: string;
  /** 身份隔离使用 workspaceIdentity；本地缺省时才 fallback 到 workingDirectory。 */
  workspaceIdentity?: string;
}

// 工具调用请求。serverName/toolName 是原始身份（不是模型可见名）；arguments 原样透传
// 由 MCP server 校验；runtimeScope 标记调用来源（subagent 不能继承某些宿主能力）；
// workspace*/remoteSessionId/clientMode/deliveryKind/turnId 只用于 shared-host 隔离与
// 审计，**不改变 MCP tool 参数**；trace 用于日志关联。
export interface McpCallToolRequest {
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  trace?: TraceContext;
  /** 调用来源；宿主 MCP 可据此限制不能安全继承到 subagent 的能力。 */
  runtimeScope?: "main" | "subagent";
  /** 请求上下文仅用于 shared-host 隔离，不改变 MCP tool 参数。 */
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceKey?: string;
  remoteSessionId?: string;
  clientMode?: string;
  deliveryKind?: string;
  turnId?: string;
}

// 进度通知。progress 由 server 保证单调递增，total 可缺省（未知总量）；
// adapter 原样转发、不节流，但实现方不得用它替代 timeout 控制。
/** MCP `notifications/progress`（A8）：progress 单调递增，total 可缺省；adapter 原样转发，不做节流。 */
export interface McpToolCallProgress {
  progress: number;
  total?: number;
  message?: string;
}

// 调用选项。appConnection 固定页面写操作到特定连接代际，授权恢复后不得自动重放
// （身份或 generation 变化即视为不同连接）；signal 中止调用；timeoutMs 覆盖本次预算；
// onProgress 收到服务端进度时回调，adapter 同时以 resetTimeoutOnProgress 重置超时。
export interface McpCallToolOptions {
  /** 页面写操作固定此连接；禁止恢复或重新授权后自动重放。 */
  appConnection?: { identity: string; generation: number };
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 收到服务端进度通知时回调；SDK 侧同时以 resetTimeoutOnProgress 让每次进度重置超时。 */
  onProgress?: (progress: McpToolCallProgress) => void;
}

// 工具级 `_meta.timeoutMs` 下限。低于该值视为非法并丢弃，防止 server 用极小值
// 让调用瞬间超时；单位毫秒。
/** 工具级 `_meta.timeoutMs` 的允许区间：低于下限视为非法丢弃，高于上限截到上限。 */
export const MCP_TOOL_META_TIMEOUT_MIN_MS = 1_000;
// 上限（30 分钟）。高于该值截到上限，避免单个工具调用长期占住会话。
export const MCP_TOOL_META_TIMEOUT_MAX_MS = 30 * 60 * 1_000;

// 官方鉴权失败分类（"不发任何请求"的几类）。与 shared 中的端口失败原因同义，
// 在此重导出以便 contracts 消费方无需直接依赖 shared。
/**
 * 端口层失败分类（"不发任何请求"的几类）。
 * `official_mcp_origin_untrusted` 可能来自 adapter 本地校验，也可能来自 host 侧二次校验。
 */
export type OfficialMcpAuthFailureReason = OfficialMcpAuthPortFailureReason;

// 身份头解析结果。ok:true 时 headers 可直接合并进请求（不含 host 头）；
// ok:false 时 reason 必须是稳定分类，调用方禁止从错误文本推断原因。
export type OfficialMcpAuthHeadersResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

/**
 * MCP adapter 消费身份头的依赖注入端口。
 * adapter 不直接依赖 `packages/services`；Agent 进程经该端口向 host 索取本次请求的身份头。
 *
 * 失败必须走返回值而非抛异常，调用方禁止从错误文本解析原因。
 * `workspaceIdentity` / `workspacePath` / `pluginId` / `mcpKey` / `targetOrigin`
 * 仅用于路由、二次校验与审计，**不参与凭证选择**——凭证是 host 全局状态。
 */
export interface OfficialMcpAuthHeadersPort {
  resolveHeaders(input: {
    pluginId: string;
    mcpKey: string;
    targetOrigin: string;
    workspaceIdentity?: string;
    workspacePath?: string;
    signal?: AbortSignal;
  }): Promise<OfficialMcpAuthHeadersResult>;
}

/**
 * 官方 MCP 信任判定。
 *
 * 规则只有一条：**目标 origin 逐字符等于当前 ZCode API origin（https、无 username/password）**，
 * 另有仅放开 http loopback 的本地自测开关。`pluginId` / `mcpKey` 传进来只用于日志与凭证解析
 * 归属，**不影响判定结果**——曾经的"必须是官方 marketplace 插件"那道检查已于 2026-08 移除
 * （它让官方插件在发布前无法对真实端点自测，而第三方插件本可用 hook 读到同一份凭证，
 * 并非真实屏障）。
 *
 * 实现在 `@zcode/shared`：host 与 adapter 共用同一份，避免一侧放行一侧拒绝。
 * 异步是为了让 host 侧能按 settings 覆盖解析 origin。
 */
export interface OfficialMcpTrustedOriginRegistry {
  isTrusted(input: { pluginId: string; mcpKey: string; origin: string }): Promise<{
    detail?: string;
    trusted: boolean;
  }>;
}

/** MCP elicitation（server → client `elicitation/create`）交给宿主提问的端口。 */
// elicitation 归属信息。全部可选，但缺失会话/工具归属时端口应拒绝请求——
// 否则无法把用户回答关联回正确的工具行。traceId 仅用于日志串联。
export interface McpElicitationTrace {
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  traceId?: string;
}
// elicitation 请求。requestedSchema 是 server 给出的表单结构，宿主只按已知字段渲染、
// 不执行任意 schema；message 是展示给用户的提示；trace 必填性由端口实现校验。
export interface McpElicitationRequest {
  serverName: string;
  message: string;
  requestedSchema: unknown;
  /** 发起 elicitation 时该 server 正在执行的工具调用；没有则无法归属会话，端口应拒绝。 */
  trace?: McpElicitationTrace;
}
// elicitation 结果。accept 才带 content（表单值）；decline=用户拒绝；cancel=中止。
// 三者都是正常终态，调用方不得把 decline/cancel 当异常重试。
export interface McpElicitationResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}
// 向宿主提问的端口。实现必须把请求落到用户可交互的通道，并响应 signal 取消
// （用户关闭会话时不得悬挂）；请求期间 server 的 tool call 应保持未完成。
export interface McpElicitationPort {
  requestElicitation(
    request: McpElicitationRequest,
    options?: { signal?: AbortSignal },
  ): Promise<McpElicitationResult>;
}

// MCP 端口总入口。连接生命周期：connectConfiguredServers 做批量建连并返回快照，
// connectServer 单个建连，disconnectServer 断开并保留状态，close 释放全部资源。
// 工具面：listTools 返回当前全部 descriptor，toolListRevision 是 tools/list_changed
// 的累计次数（runtime 逐回合比较，变了才重拉重注册）；实现缺席视为工具面不会主动变化。
// 调用/资源/订阅方法多为可选：缺席即"该端口不支持"，调用方必须 typeof 探测并 fail closed，
// 不得在缺席时退化为假设成功。工具命名空间由 core 的 name.ts 统一生成，端口不负责去重。
export interface McpPort {
  /** 可信配置派生的稳定来源与现有连接代际。断线时不签发新页面凭证。 */
  onAppConnectionInvalidated?(serverName: string, listener: () => void): () => void;
  appConnectionSnapshot?(serverName: string): { identity: string; generation: number } | null;
  /** 等待目标 server 已有连接任务；不重连、不等待其它 server，owner 失效后返回 null。 */
  waitForAppConnection?(
    serverName: string,
  ): Promise<{ identity: string; generation: number } | null>;

  connectConfiguredServers(
    servers: Record<string, McpServerConfig>,
    options?: McpConnectOptions,
  ): Promise<McpConnectionSnapshot>;
  connectServer(
    name: string,
    config: McpServerConfig,
    options?: McpConnectOptions,
  ): Promise<McpServerStatus>;
  disconnectServer(name: string): Promise<McpServerStatus | undefined>;
  /**
   * 主动探测连接是否仍然存活，返回 false 表示 transport 已断。
   * HTTP/SSE MCP 被停掉时不会派发 onclose，status() 会长期停在 connected；
   * 只有显式 ping 才能把这种"无声死亡"暴露出来。实现可选：未实现时调用方按存活处理。
   */
  pingServer?(name: string, options?: { timeoutMs?: number }): Promise<boolean>;
  status(): Promise<Record<string, McpServerStatus>>;
  listTools(): Promise<McpToolDescriptor[]>;
  /**
   * 自端口创建以来收到 `notifications/tools/list_changed` 的累计次数。
   * runtime 在回合开始前比较该值，变了才重新 listTools 并重注册；未实现表示端口不会主动变化。
   */
  toolListRevision?(): number;
  callTool(request: McpCallToolRequest, options?: McpCallToolOptions): Promise<McpToolCallResult>;
  /**
   * 读取 MCP 资源（插件 UI 的 `ui://` HTML）。与 pingServer 同样可选：mock port 不必实现，
   * 调用方缺失时按"不支持资源"处理。实现必须与 callTool 共用同一连接与重连路径。
   */
  readResource?(
    request: McpReadResourceRequest,
    options?: McpCallToolOptions,
  ): Promise<McpReadResourceResult>;
  /** 资源列表与订阅；缺省表示该端口不支持（协议层回 -32001）。 */
  listResources?(
    request: McpListResourcesRequest,
    options?: McpCallToolOptions,
  ): Promise<McpListResourcesResult>;
  listResourceTemplates?(
    request: McpListResourcesRequest,
    options?: McpCallToolOptions,
  ): Promise<McpListResourceTemplatesResult>;
  subscribeResource?(
    request: McpResourceSubscriptionRequest,
    options?: McpCallToolOptions,
  ): Promise<void>;
  unsubscribeResource?(
    request: McpResourceSubscriptionRequest,
    options?: McpCallToolOptions,
  ): Promise<void>;
  /** 删除 subscriberKey 以 prefix 开头的全部登记（会话关闭）；返回真正向 server 退订的 uri 数。 */
  unsubscribeResourcesBySubscriber?(subscriberKeyPrefix: string): Promise<number>;
  close(): Promise<void>;
}
