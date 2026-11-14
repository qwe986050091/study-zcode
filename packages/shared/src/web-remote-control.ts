//
// 文件职责：手机远控（Web remote control）共享协议层，定义 App 与 Desktop 之间的
// payload 判别联合、失败原因、workspace/task 视图与 bootstrap/bridge 契约。
// 职责边界：只声明类型、常量与纯函数校验；不持有运行时状态、不访问网络、不依赖 UI。
// 上下游必须通过本文件对齐字段，禁止在各端私自扩展同义字段。
//
// 不变量（INV）：
// INV-01 断言：重连超时与出站缓冲超时是两个独立常量，不得合并。
//        位置：WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS / OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS；故障：用 5s 判重连或 120s 判缓冲，导致误断或内存堆积。
// INV-02 断言：auth state change 只接受 signed-in / signed-out 且 schema 为 strict。
//        位置：webRemoteControlAuthStateChangeSchema；故障：多余字段被静默接受，main 读到过期凭据。
// INV-03 断言：renderer 只通知状态变化，凭据必须由 main 重新读取。
//        位置：schema 上方注释与 auth-state 载荷形状；故障：凭据被 renderer 透传，越权。
// INV-04 断言：failure reason 是跨端枚举，增删必须同步所有消费者。
//        位置：WebRemoteControlFailureReason；故障：手机端无法识别新原因，落到 unexpected-error。
// INV-05 断言：连接恢复超时不得映射为 desktop-disconnected。
//        位置：createWebRemoteControlConnectionRecoveryTimeoutFailure；故障：错误页误导用户以为电脑离线。
// INV-06 断言：close code 到 failure reason 的映射固定且未知码返回 null。
//        位置：resolveWebRemoteControlFailureReasonFromCloseCode；故障：未知码被猜成会话冲突，触发错误重连。
// INV-07 断言：theme seed 只允许五个字面量。
//        位置：isWebRemoteControlThemeSeed；故障：任意主题字符串进入 bootstrap，样式回退失效。
// INV-08 断言：路由路径比较会去掉尾斜杠，但不得把子路径当成入口。
//        位置：matchesWebRemoteControlRoutePath 的 normalizeRoutePath；故障：/remote/favicon.ico 被当成应用入口。
// INV-09 断言：外部二维码只允许 sid/mid/name/app_version，并强制清除 hash 与 t。
//        位置：buildWebRemoteControlExternalQrUrl / parseWebRemoteControlExternalQrParams；故障：旧凭据被重新带入新二维码。
// INV-10 断言：workspace 身份 key 统一为 identity.trim() 或 path。
//        位置：resolveWebRemoteControlWorkspaceKey；故障：同一 workspace 出现两个 key，缓存与队列分裂。
// INV-11 断言：远程 workspace 必须同时具备 identity 与 remoteSessionId 才可 bridge。
//        位置：isWebRemoteControlBridgeableWorkspaceTarget；故障：断连的 SSH workspace 被当作可连目标。
// INV-12 断言：初始选择只从 bridgeable 列表中挑，断连项只能作为不可连接的展示。
//        位置：resolveWebRemoteControlInitialWorkspaceSelection；故障：重连未完成时反复进入「尚未连接」。
// INV-13 断言：App payload 是 zcode_type 判别联合，新类型必须加入联合。
//        位置：WebRemoteControlAppPayload；故障：新消息被类型系统漏掉，解析端落入 default。
// INV-14 断言：mobileTaskView 的 remoteSessionId 只能由所属 bridge 注入。
//        位置：WebRemoteControlStatus.mobileTaskView 注释与字段；故障：Web 自报 remoteSessionId 造成跨会话串看。
// INV-15 断言：platform 请求与响应以 requestId 关联，success 分支必须带 result。
//        位置：WebRemoteControlPlatformRequest / Response；故障：响应错配到其他请求。
// INV-16 断言：bridge degraded 的原因枚举固定，缓冲超时必须单独可辨。
//        位置：WebRemoteControlBridgeDegradedPayload.reason；故障：缓冲超时被归为通用故障，无法定位。
// INV-17 断言：window control 与 workspace control 是两组独立请求，不得混用。
//        位置：WebRemoteControlWindowControlRequest / WorkspaceControlRequest；故障：窗口级操作被当成 workspace 操作。
// INV-18 断言：mobile diagnostic 不得携带任何凭据或 token。
//        位置：WebRemoteControlMobileDiagnosticPayload 字段集合；故障：诊断上报泄露配对凭据。
// INV-19 断言：task target 的 workspaceKind 必须与是否携带 identity 一致。
//        位置：WebRemoteControlTaskTarget；故障：远程任务被标成本地，归档落到错误存储。
// INV-20 断言：shared 只声明契约，不引入 UI、服务或 Node 专有实现。
//        位置：本文件 import 区；故障：shared 被平台实现污染，Web 打包失败。
//
import type { MobilePluginDiscoveryTelemetry } from "./telemetry.js";
import { z } from "zod";
import type { MobileSessionCreateTelemetry } from "./sessionCreateTelemetry.js";
/* eslint-disable max-lines -- Web 远程控制共享 App payload 与 workspace bridge 契约。 */
import type { WebRemoteControlRelayV2PairStatus } from "#src/web-remote-relay/index.js";
import type {
  DockerContainerInfo,
  SSHConfigAliasOption,
  WSLDistro,
  CreateTempTextAttachmentRequest,
  CreateTempTextAttachmentResult,
} from "./platform.js";

import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  MigrateLegacyCommonMcpRequest,
  MigrateLegacyCommonMcpResult,
  SaveCliMcpToUserDirectoryRequest,
} from "./mcp.js";
import type { ZCodeProvider } from "./zcode-task-types-core.js";
import type { SessionWorkflowActivity } from "./zcode-protocol-v4/sessions-index-workflow-activity.js";
import type { WebRemoteControlRpcTransportPayload } from "./web-remote-control-rpc-transport.js";
import type { WorkspacePurpose } from "./workspacePurpose.js";

// [契约] 120s 是 workspace 重连的容忍上限，覆盖手机后台恢复与网络切换；
// 缩短会让短暂断网直接失败，延长会让用户长时间停在 connecting。
// [失败路径] 该值同时被手机与桌面消费，改动必须双侧同步。
// [权衡] 与出站缓冲超时语义不同，不能复用同一个常量。
export const WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS = 120_000;
// [资源] 5s 是出站 payload 缓冲的寿命，超时即判定 bridge 降级；
// 缓冲用于等待 transport 就绪，过期数据必须丢弃而不是无限堆积。
// [失败路径] 调大该值会让断连期间内存持续增长。
// [权衡] 与重连超时解耦，避免把「传输暂不可用」误判为「会话丢失」。
export const WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS = 5_000;

// [契约] 主题种子是固定字面量集合，新增主题必须同时更新校验函数；
// system 表示沿用桌面当前主题，由 bootstrap 端解析。
// [失败路径] 允许任意字符串会让手机端渲染出未定义配色。
// [权衡] 用字面量而不是 enum，便于跨端序列化。
export type WebRemoteControlThemeSeed = "light" | "dark" | "zai-light" | "zai-dark" | "system";

// [契约] context 同时携带访问路径与身份信息，二者用途不同不可互换；
// workspacePath 用于文件与命令，workspaceIdentity 用于隔离与路由。
// [失败路径] 只传路径会让远程与本地同名 workspace 共用缓存。
// [权衡] remoteSessionId 与 initialTaskId 可选，兼容首次配对与恢复两种入口。
export interface WebRemoteControlContext {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  theme?: WebRemoteControlThemeSeed;
}

/** Renderer 只通知会话变化；main 必须重新读取本地凭据。 */
// [契约] strict schema 拒绝未知字段，state 只允许两个值；
// 该载荷只表达「登录态变了」，不携带 token 或用户信息。
// [失败路径] 放宽为 passthrough 会让旧版本字段悄悄进入 main。
// [权衡] 使用 zod 在 shared 层校验，main 与 renderer 共享同一规则。
export const webRemoteControlAuthStateChangeSchema = z
  .object({
    state: z.enum(["signed-in", "signed-out"]),
  })
  .strict();
export type WebRemoteControlAuthStateChange = z.infer<typeof webRemoteControlAuthStateChangeSchema>;

export type WebRemoteControlStatusKind =
  | "auth-required"
  | "idle"
  | "starting"
  | "running"
  | "connecting"
  | "active"
  | "error";

export type WebRemoteControlFailureReason =
  | "device-not-owned"
  | "auth-required"
  | "session-not-found"
  | "session-expired"
  | "session-conflict"
  | "workspace-closed"
  | "desktop-disconnected"
  | "invalid-mobile-connection"
  | "desktop-bootstrap-timeout"
  | "connection-recovery-timeout"
  | "relay-unavailable"
  | "unsupported-action"
  | "unexpected-error";

export interface WebRemoteControlFailure {
  reason: WebRemoteControlFailureReason;
  message?: string;
}

// [失败路径] 恢复超时的真实问题是手机连接未恢复，不是桌面离线；
// 因此这里固定返回 connection-recovery-timeout，绝不回落到 desktop-disconnected。
// message 原样透传，供手机端展示具体阶段。
// [契约] 该工厂是唯一构造此失败原因的入口。
export function createWebRemoteControlConnectionRecoveryTimeoutFailure(
  message: string,
): WebRemoteControlFailure {
  return {
    // Bugfix: 手机端长时间后台后恢复超时，真实问题是手机连接未恢复，
    // 不能映射成 desktop-disconnected，否则错误页会误导用户以为电脑端离线。
    reason: "connection-recovery-timeout",
    message,
  };
}

// [契约] relay 设备元信息只描述配对设备本身，不包含会话信息；
// platform/version/name 都可能缺省，消费端必须容忍。
// [失败路径] 把设备名当唯一标识会在同名设备间冲突。
// [权衡] 保持扁平结构，减少 relay 转发体积。
export interface WebRemoteControlRelayDeviceMeta {
  platform: string;
  version: string;
  name: string;
}

export interface WebRemoteControlMobileViewportInfo {
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface WebRemoteControlMobileScreenInfo {
  width: number;
  height: number;
}

// [契约] 在设备元信息上扩展视口、屏幕、时区与在线状态；
// 这些字段用于桌面端展示与布局适配，不参与鉴权。
// [失败路径] 用 UA 做能力判断已被废弃，必须读取显式字段。
// [权衡] updatedAt 必填，表明该快照的时间。
export interface WebRemoteControlMobileDeviceInfo extends WebRemoteControlRelayDeviceMeta {
  userAgent?: string;
  language?: string;
  languages?: string[];
  browserPlatform?: string;
  viewport?: WebRemoteControlMobileViewportInfo;
  screen?: WebRemoteControlMobileScreenInfo;
  timezone?: string;
  online?: boolean;
  updatedAt: number;
}

export interface WebRemoteControlV2QrParams {
  deviceSid?: string;
  deviceMid?: string;
  deviceName?: string;
  appVersion?: string;
}

export type BuildWebRemoteControlExternalQrUrlOptions = WebRemoteControlV2QrParams & {
  baseUrl: string;
};

// [契约] 参数先 trim，空串视为缺失并返回 undefined；
// 该归一保证二维码参数不会出现 sid= 这样的空值。
// [失败路径] 直接返回原串会让空参数覆盖已有默认值。
// [权衡] 不做 URL 解码以外的处理，编码由 URLSearchParams 负责。
function readNonEmptySearchParam(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name)?.trim();
  return value ? value : undefined;
}

// [契约] 类型守卫穷举五个字面量，必须与 ThemeSeed 定义保持同步；
// 输入为 unknown，任何非字符串都安全返回 false。
// [失败路径] 漏掉新增主题会让合法值被拒绝并回落到默认主题。
// [权衡] 手写字面量而不是数组 includes，便于类型收窄。
export function isWebRemoteControlThemeSeed(value: unknown): value is WebRemoteControlThemeSeed {
  return (
    value === "light" ||
    value === "dark" ||
    value === "zai-light" ||
    value === "zai-dark" ||
    value === "system"
  );
}

// [契约] 以固定无效域名解析相对 baseUrl，只取 pathname；
// 解析失败时按是否以 / 开头补齐，保证返回值总是以 / 起始。
// [失败路径] 直接把 baseUrl 当路径会保留 query 与 hash。
// [权衡] 根路径统一映射为 /remote，而不是返回 /。
export function resolveWebRemoteControlRoutePathFromBaseUrl(baseUrl: string): string {
  const rawBaseUrl = baseUrl.trim() || "/";
  let pathname = "/";

  try {
    pathname = new URL(rawBaseUrl, "https://zcode.invalid").pathname;
  } catch {
    pathname = rawBaseUrl.startsWith("/") ? rawBaseUrl : `/${rawBaseUrl}`;
  }

  const normalizedPathname = pathname.replace(/\/+$/, "") || "/";
  if (normalizedPathname === "/") {
    return "/remote";
  }
  return normalizedPathname;
}

// [契约] 比较前双方都去掉尾斜杠，/remote 与 /remote/ 等价；
// 但 /remote/favicon.ico 不等于 /remote，不能被当成入口。
// [失败路径] 用 startsWith 会让静态资源请求命中应用入口。
// [权衡] matchesWebRemoteControlRoutePath 只归一尾斜杠：大小写与百分号编码保持原样，不做二次归一。
export function matchesWebRemoteControlRoutePath(pathname: string, routePath: string): boolean {
  // Bugfix: dev / production 入口可能带 /remote/ 尾斜杠；
  // 路由判断需要接受 /remote 与 /remote/，但不能把 /remote/favicon.ico 当成应用入口。
  const normalizeRoutePath = (value: string) => value.replace(/\/+$/, "") || "/";
  return normalizeRoutePath(pathname) === normalizeRoutePath(routePath);
}

// [契约] 二维码 URL 只写入四个受支持参数，其余原样保留；
// hash 与 t 必须删除，旧凭据不能通过 base URL 重新带入。
// [失败路径] 保留 hash 会让新二维码携带已失效的配对信息。
// [权衡] 参数值先 trim 再写入，空值不生成空参数。
export function buildWebRemoteControlExternalQrUrl({
  baseUrl,
  deviceSid,
  deviceMid,
  deviceName,
  appVersion,
}: BuildWebRemoteControlExternalQrUrlOptions): string {
  const url = new URL(baseUrl);
  if (deviceSid !== undefined) url.searchParams.set("sid", deviceSid);
  // 旧凭据只允许清除，不能从 base URL 重新带入新二维码。
  url.searchParams.delete("hash");
  url.searchParams.delete("t");

  if (deviceMid?.trim()) {
    url.searchParams.set("mid", deviceMid);
  }
  if (deviceName?.trim()) {
    url.searchParams.set("name", deviceName);
  }
  if (appVersion?.trim()) {
    url.searchParams.set("app_version", appVersion);
  }
  return url.toString();
}

// [契约] 带 hash 或 t 的参数一律视为旧版二维码并拒绝解析；
// 成功时只返回存在的字段，缺省字段不写 undefined 键。
// [失败路径] 接受旧参数会让新旧二维码混用，配对流分裂。
// [权衡] 使用 as const 元组映射，避免手写四组键值。
export function parseWebRemoteControlExternalQrParams(
  params: URLSearchParams,
): WebRemoteControlV2QrParams | null {
  if (params.has("hash") || params.has("t")) return null;
  const result: WebRemoteControlV2QrParams = {};
  for (const [key, param] of [
    ["deviceSid", "sid"],
    ["deviceMid", "mid"],
    ["deviceName", "name"],
    ["appVersion", "app_version"],
  ] as const) {
    const value = readNonEmptySearchParam(params, param);
    if (value) result[key] = value;
  }
  return result;
}

export type WebRemoteControlTokenKind = "window-pairing";

export type WebRemoteControlWindowFailureReason = WebRemoteControlFailureReason;

// [契约] 关闭码是跨端协议常量，数值一旦发布不得复用；
// 4004/4009/4010/4011/4012/4013 分别对应不同终态，语义不可合并。
// [失败路径] 改动数值会让旧客户端把冲突误判为会话丢失。
// [权衡] 使用 as const 保留字面量类型，便于映射函数穷举。
export const WebRemoteControlCloseCodes = {
  SessionNotFound: 4004,
  SessionConflict: 4009,
  DesktopDisconnected: 4010,
  SessionExpired: 4011,
  WorkspaceClosed: 4012,
  InvalidMobileConnection: 4013,
} as const;

// [契约] 六个已知关闭码映射到语义化原因，其余返回 null；
// null 表示「不是协议定义的终态」，调用方不得自行猜测。
// [失败路径] 为未知码返回 unexpected-error 会掩盖真实原因。
// [权衡] switch 比查表更易被类型检查覆盖。
export function resolveWebRemoteControlFailureReasonFromCloseCode(
  code: number,
): WebRemoteControlFailureReason | null {
  switch (code) {
    case WebRemoteControlCloseCodes.SessionNotFound:
      return "session-not-found";
    case WebRemoteControlCloseCodes.SessionConflict:
      return "session-conflict";
    case WebRemoteControlCloseCodes.DesktopDisconnected:
      return "desktop-disconnected";
    case WebRemoteControlCloseCodes.SessionExpired:
      return "session-expired";
    case WebRemoteControlCloseCodes.WorkspaceClosed:
      return "workspace-closed";
    case WebRemoteControlCloseCodes.InvalidMobileConnection:
      return "invalid-mobile-connection";
    default:
      return null;
  }
}

// [契约] 启动成功必须同时给出 qrUrl 与 connectUrl，二者用途不同；
// status 只允许 running/connecting/active，cancelled 走独立类型。
// [失败路径] 允许 idle 会让调用方误以为启动未开始。
// [权衡] workspacePath 必填而 identity 可选，兼容旧桌面。
export interface WebRemoteControlStartResult {
  status: Extract<WebRemoteControlStatusKind, "running" | "connecting" | "active">;
  sessionId: string;
  windowControlSessionId?: string;
  deviceToken?: string;
  tokenKind?: WebRemoteControlTokenKind;
  expiresAt?: number;
  qrUrl: string;
  connectUrl: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
}

export interface WebRemoteControlStartCancelledResult {
  status: "cancelled";
}

/** 兼容仍可返回取消终态的平台实现；当前 Desktop 启动和刷新链路不会产生该结果。 */
export type WebRemoteControlStartOperationResult =
  | WebRemoteControlStartResult
  | WebRemoteControlStartCancelledResult;

// [契约] 状态快照是可缺省的宽对象，手机端必须逐字段防御；
// mobileTaskView 的 remoteSessionId 只能由 Main 注入，不接受 Web 自报。
// [失败路径] 信任 Web 传入的 remoteSessionId 会造成会话越权。
// [权衡] 宽对象减少协议版本分支，但增加消费端判空成本。
export interface WebRemoteControlStatus {
  status: WebRemoteControlStatusKind;
  sessionId?: string;
  windowControlSessionId?: string;
  deviceToken?: string;
  tokenKind?: WebRemoteControlTokenKind;
  expiresAt?: number;
  mobileConnected?: boolean;
  mobileViewState?: WebRemoteControlMobileViewState;
  /** Main 校验后的瞬时可见任务；remoteSessionId 仅由所属 bridge 注入，不接受 Web 自报。 */
  mobileTaskView?: (WebRemoteControlMobileTaskView & { remoteSessionId?: string }) | null;
  mobileDeviceInfo?: WebRemoteControlMobileDeviceInfo;
  qrUrl?: string;
  connectUrl?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  error?: string;
  failure?: WebRemoteControlFailure;
}

// [契约] 创建会话必须携带 tunnelId 与 workspacePath；
// identity 与 remoteSessionId 仅在远程 workspace 下出现。
// [失败路径] 缺少 tunnelId 无法在 relay 上定位目标设备。
// [权衡] initialTaskId 可选，支持直接打开指定任务。
export interface WebRemoteControlSessionCreateRequest {
  tunnelId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
}

export interface WebRemoteControlSessionCreateResponse extends WebRemoteControlStartResult {
  token: string;
}

// [契约] 窗口级会话持有 deviceToken 与 connectUrl，生命周期独立于 workspace bridge；
// status 是窗口控制自身的状态，不等同于远控整体状态。
// [失败路径] 复用 deviceToken 作为 bridge 凭据会扩大权限范围。
// [权衡] expiresAt 必填，调用方必须据此判断是否续期。
export interface WebRemoteControlWindowSession {
  windowControlSessionId: string;
  deviceToken: string;
  tokenKind: WebRemoteControlTokenKind;
  connectUrl: string;
  qrUrl: string;
  expiresAt: number;
  status: "idle" | "starting" | "running" | "active" | "error";
}

export interface WebRemoteControlBootstrapResult {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  wsUrl: string;
}

export interface WebRemoteControlBootstrapErrorResponse {
  error: string;
  reason: WebRemoteControlFailureReason;
}

// [契约] 这是平台方法到参数类型的映射，新增方法必须同时补三张映射表；
// args 为 undefined 表示该方法不接受参数。
// [失败路径] 只加方法不补结果映射会让响应类型退化为 never。
// [权衡] 用映射而不是枚举，保持类型与实现同步。
export interface WebRemoteControlPlatformMethodArgsMap {
  isDockerAvailable: undefined;
  listWSLDistros: undefined;
  listDockerContainers: undefined;
  listSSHConfigAliases: undefined;
  createTempTextAttachment: CreateTempTextAttachmentRequest;
  loadMcpFromUserDirectory: LoadCliMcpFromUserDirectoryRequest | undefined;
  saveMcpToUserDirectory: SaveCliMcpToUserDirectoryRequest;
  migrateLegacyCommonMcp: MigrateLegacyCommonMcpRequest | undefined;
}

export interface WebRemoteControlPlatformMethodResultMap {
  isDockerAvailable: boolean;
  listWSLDistros: WSLDistro[];
  listDockerContainers: DockerContainerInfo[];
  listSSHConfigAliases: SSHConfigAliasOption[];
  createTempTextAttachment: CreateTempTextAttachmentResult;
  loadMcpFromUserDirectory: LoadCliMcpFromUserDirectoryResult;
  saveMcpToUserDirectory: { success: boolean; error?: string };
  migrateLegacyCommonMcp: MigrateLegacyCommonMcpResult;
}

export type WebRemoteControlPlatformMethod = keyof WebRemoteControlPlatformMethodResultMap;

// [契约] 平台请求是按 method 分发的映射联合，requestId 由发起端生成；
// args 的可选性由 ArgsMap 决定，不能在此统一放宽。
// [失败路径] 手写宽联合会让某个方法的参数类型丢失。
// [权衡] 映射联合在编译期保证 request 与 response 方法一一对应。
export type WebRemoteControlPlatformRequest = {
  [K in WebRemoteControlPlatformMethod]: {
    type: "platform-request";
    requestId: string;
    method: K;
    args?: WebRemoteControlPlatformMethodArgsMap[K];
  };
}[WebRemoteControlPlatformMethod];

export type WebRemoteControlPlatformSuccessResponse = {
  [K in WebRemoteControlPlatformMethod]: {
    type: "platform-response";
    requestId: string;
    method: K;
    success: true;
    result: WebRemoteControlPlatformMethodResultMap[K];
  };
}[WebRemoteControlPlatformMethod];

export interface WebRemoteControlPlatformErrorResponse {
  type: "platform-response";
  requestId: string;
  method: WebRemoteControlPlatformMethod;
  success: false;
  error: string;
}

export type WebRemoteControlPlatformResponse =
  | WebRemoteControlPlatformSuccessResponse
  | WebRemoteControlPlatformErrorResponse;

// [契约] 本地 bridge 以 workspaceKey + workspacePath 定位，不需要远程身份；
// bridgeGeneration 与 recoveryId 用于区分同一会话的多次重建。
// [失败路径] 复用过期的 generation 会让旧连接继续收消息。
// [权衡] initialTaskId 可选，兼容从任意入口打开。
export interface WebRemoteControlExternalLocalWorkspaceBridge {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  kind: "local";
  workspaceKey: string;
  workspacePath: string;
  initialTaskId?: string;
}

// [契约] 远程 bridge 必须同时给出 identity 与 remoteSessionId，二者缺一不可；
// capabilities 是可选能力声明，客户端不得据 proxy 推断。
// [失败路径] 用 capability 缺省表示不支持之外的含义会导致误判。
// [权衡] 保留旧桌面不声明 capabilities 的兼容路径。
export interface WebRemoteControlExternalRemoteWorkspaceBridge {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  kind: "remote";
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity: string;
  remoteSessionId: string;
  initialTaskId?: string;
  /** 旧桌面不声明；客户端不能根据惰性 RPC proxy 是否存在猜测能力。 */
  capabilities?: { windowProjectDirectory?: true };
}

export type WebRemoteControlExternalWorkspaceBridge =
  | WebRemoteControlExternalLocalWorkspaceBridge
  | WebRemoteControlExternalRemoteWorkspaceBridge;

// [契约] bootstrap 请求只需 requestId，窗口身份由连接上下文提供；
// 该消息是配对成功后的第一条应用层请求。
// [失败路径] 在请求中携带 token 会扩大泄露面。
// [权衡] 响应必须 success: true，失败走 app-error。
export interface WebRemoteControlBootstrapRequestPayload {
  zcode_type: "bootstrap-request";
  requestId: string;
}

// [契约] bootstrap 成功响应固定 success: true，失败不使用该类型；
// result 必须是 WindowBootstrapResult，不能放宽为 unknown。
// [失败路径] 失败也走该类型会让调用方误读空 result。
// [权衡] requestId 必须回显，手机端据此结束等待。
export interface WebRemoteControlBootstrapResponsePayload {
  zcode_type: "bootstrap-response";
  requestId: string;
  success: true;
  result: WebRemoteControlWindowBootstrapResult;
}

export interface WebRemoteControlWorkspaceListRequestPayload {
  zcode_type: "workspace-list-request";
  requestId: string;
}

export interface WebRemoteControlWorkspaceListResponsePayload {
  zcode_type: "workspace-list-response";
  requestId: string;
  success: true;
  result: WebRemoteControlWorkspaceListResult;
}

export interface WebRemoteControlWorkspaceListUpdatedPayload {
  zcode_type: "workspace-list-updated";
  result: WebRemoteControlWorkspaceListResult;
}

// [契约] 打开 bridge 需要 bridgeSessionId 与 workspaceKey，二者共同定位目标；
// fileTreeTaskId 只解析任务目录，不选择任务、不标记已读。
// [失败路径] 把 fileTreeTaskId 当成 taskId 会顺带切换用户视图。
// [权衡] project 字段可选，兼容不启用项目模型的桌面。
export interface WebRemoteControlWorkspaceBridgeOpenPayload {
  zcode_type: "workspace-bridge-open";
  requestId: string;
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  workspaceKey: string;
  taskId?: string;
  project?: { projectId: string | null; hostId?: string; draftId?: string; reuseDraft?: boolean };
  taskHostId?: string;
  /** 仅解析任务目录供文件树使用，不选择任务或标记已读。 */
  fileTreeTaskId?: string;
}

export interface WebRemoteControlWorkspaceBridgeReadyPayload {
  zcode_type: "workspace-bridge-ready";
  requestId: string;
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  bridge: WebRemoteControlExternalWorkspaceBridge;
}

// [契约] 错误响应必须带 reason 与 error，requestId 用于回配请求；
// bridgeSessionId 与 generation 可能缺省（错误发生在创建之前）。
// [失败路径] 只给 error 字符串会让手机端无法做针对性恢复。
// [权衡] reason 复用全局失败枚举，不新增 bridge 专用原因。
export interface WebRemoteControlWorkspaceBridgeErrorPayload {
  zcode_type: "workspace-bridge-error";
  requestId: string;
  bridgeSessionId?: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  reason: WebRemoteControlFailureReason;
  error: string;
}

export interface WebRemoteControlWorkspaceReconnectRequestPayload {
  zcode_type: "workspace-reconnect-request";
  requestId: string;
  workspaceKey: string;
}

export type WebRemoteControlWorkspaceReconnectResponsePayload =
  | {
      zcode_type: "workspace-reconnect-response";
      requestId: string;
      workspaceKey: string;
      success: true;
    }
  | {
      zcode_type: "workspace-reconnect-response";
      requestId: string;
      workspaceKey: string;
      success: false;
      error: string;
    };

export interface WebRemoteControlMobileViewStatePayload {
  zcode_type: "mobile-view-state-update";
  viewState: WebRemoteControlMobileViewState;
  deviceInfo?: WebRemoteControlMobileDeviceInfo;
}

export interface WebRemoteControlMobileTaskView {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

// [契约] 视图更新带 epoch 与 seq，接收端必须按 epoch 分段、按 seq 去重；
// view 为 null 表示清空，不得与「未提供」混淆。
// [失败路径] 忽略 epoch 会在重连后应用旧视图，覆盖新状态。
// [权衡] bridgeSessionId 与 generation 用于过滤过期 bridge 的消息。
export interface WebRemoteControlMobileTaskViewUpdatePayload {
  zcode_type: "mobile-task-view-update";
  epoch: string;
  seq: number;
  bridgeSessionId: string;
  bridgeGeneration?: number;
  view: WebRemoteControlMobileTaskView | null;
}

export interface WebRemoteControlMobileTaskViewRequestPayload {
  zcode_type: "mobile-task-view-request";
  epoch: string;
}

export type WebRemoteControlPlatformRequestPayload = {
  [K in WebRemoteControlPlatformMethod]: {
    zcode_type: "platform-request";
    requestId: string;
    method: K;
    args?: WebRemoteControlPlatformMethodArgsMap[K];
  };
}[WebRemoteControlPlatformMethod];

// [契约] 响应按 method 区分成功结果，失败分支只保留 method 与 error；
// 成功分支的 result 类型由 ResultMap 推导，不能手写 any。
// [失败路径] 失败分支丢失 requestId 会让调用方永远等待。
// [权衡] 联合而非可选字段，强制消费端先判 success。
export type WebRemoteControlPlatformResponsePayload =
  | {
      [K in WebRemoteControlPlatformMethod]: {
        zcode_type: "platform-response";
        requestId: string;
        method: K;
        success: true;
        result: WebRemoteControlPlatformMethodResultMap[K];
      };
    }[WebRemoteControlPlatformMethod]
  | {
      zcode_type: "platform-response";
      requestId: string;
      method: WebRemoteControlPlatformMethod;
      success: false;
      error: string;
    };

/** @deprecated 仅供 legacy adapter 单测/迁移使用；production parser 自 04D-3 起拒绝。 */
export interface WebRemoteControlRpcFramePayload {
  zcode_type: "rpc-frame";
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  seq: number;
  dataBase64: string;
}

// [契约] 降级原因固定五种，source-session-replaced 表示被新会话顶替；
// seq 与 expectedSeq 用于定位丢帧位置，droppedCount 统计丢弃量。
// [失败路径] 把 buffer-timeout 归入 rpc-transport-fault 会丢失超时语义。
// [权衡] 只上报首个降级原因，避免同一故障刷屏。
export interface WebRemoteControlBridgeDegradedPayload {
  zcode_type: "bridge-degraded";
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  reason:
    | "rpc-transport-fault"
    | "rpc-frame-gap"
    | "buffer-overflow"
    | "buffer-timeout"
    | "source-session-replaced";
  seq?: number;
  expectedSeq?: number;
  droppedCount?: number;
}

export interface WebRemoteControlAppErrorPayload {
  zcode_type: "app-error";
  requestId?: string;
  bridgeSessionId?: string;
  reason: WebRemoteControlFailureReason;
  error: string;
}

export type WebRemoteControlMobileDiagnosticEvent =
  | "state-transition"
  | "socket-close"
  | "socket-error"
  | "recover-start"
  | "recover-scheduled"
  | "pair-status"
  | "failure";

// [契约] 诊断事件只记录状态迁移、socket 关闭与恢复阶段的时间线；
// 字段全部可选（除 event/timestamp），禁止加入 token 或用户内容。
// [失败路径] 放入 closeReason 原文以外的敏感信息会进入日志。
// [权衡] 诊断与业务错误分离，避免错误页被诊断噪声淹没。
export interface WebRemoteControlMobileDiagnosticPayload {
  zcode_type: "mobile-diagnostic";
  event: WebRemoteControlMobileDiagnosticEvent;
  timestamp: number;
  state?: string;
  previousState?: string;
  pairStatus?: WebRemoteControlRelayV2PairStatus;
  closeCode?: number;
  closeReason?: string;
  wasClean?: boolean;
  wasPaired?: boolean;
  failureReason?: WebRemoteControlFailureReason;
  failureMessage?: string;
  visibilityState?: string;
  online?: boolean;
  hiddenDurationMs?: number;
}

// [契约] 这是 App 层消息总联合，所有分支以 zcode_type 判别；
// telemetry-report 复用共享 telemetry 类型，不在此重复定义字段。
// [失败路径] 新增 payload 忘记加入联合，解析端会当成未知消息丢弃。
// [权衡] 联合顺序不影响判别，但保持按生命周期排列便于阅读。
export type WebRemoteControlAppPayload =
  | {
      zcode_type: "telemetry-report";
      event: MobileSessionCreateTelemetry | MobilePluginDiscoveryTelemetry;
    }
  | WebRemoteControlBootstrapRequestPayload
  | WebRemoteControlBootstrapResponsePayload
  | WebRemoteControlWorkspaceListRequestPayload
  | WebRemoteControlWorkspaceListResponsePayload
  | WebRemoteControlWorkspaceListUpdatedPayload
  | WebRemoteControlWorkspaceBridgeOpenPayload
  | WebRemoteControlWorkspaceBridgeReadyPayload
  | WebRemoteControlWorkspaceBridgeErrorPayload
  | WebRemoteControlWorkspaceReconnectRequestPayload
  | WebRemoteControlWorkspaceReconnectResponsePayload
  | WebRemoteControlMobileViewStatePayload
  | WebRemoteControlMobileTaskViewUpdatePayload
  | WebRemoteControlMobileTaskViewRequestPayload
  | WebRemoteControlPlatformRequestPayload
  | WebRemoteControlPlatformResponsePayload
  | WebRemoteControlRpcTransportPayload
  | WebRemoteControlBridgeDegradedPayload
  | WebRemoteControlAppErrorPayload
  | WebRemoteControlMobileDiagnosticPayload;

// [契约] workspace 目标同时描述身份、展示名与连接状态；
// kind 为 local/remote，connectionState 只描述当前连接质量。
// [失败路径] 用 label 作为 key 会在同名目录间冲突，key 必须走统一函数。
// [权衡] workspacePurpose 仅供排序与分组，不参与鉴权。
export interface WebRemoteControlWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  label: string;
  workspacePurpose?: WorkspacePurpose;
  kind: "local" | "remote";
  connectionState?: "connected" | "disconnected" | "reconnecting";
  lastConnectionError?: string;
}

// [契约] 重连请求只按 workspaceKey 定位，不携带路径或身份；
// key 由统一函数生成，Main 侧不需要重新解析。
// [失败路径] 传路径会让远程与本地 key 空间混用。
// [权衡] requestId 由调用方生成，用于匹配重连结果。
export interface WebRemoteControlReconnectWorkspaceRequest {
  requestId: string;
  workspaceKey: string;
}

export type WebRemoteControlReconnectWorkspaceResult =
  | {
      requestId: string;
      workspaceKey: string;
      success: true;
    }
  | {
      requestId: string;
      workspaceKey: string;
      success: false;
      error: string;
    };

// [契约] task 目标必须携带 workspacePath 与 workspaceKind，保证动作落到正确存储；
// remoteSessionId 与 identity 决定远程归属，缺省即本地。
// [失败路径] 仅凭 taskId 无法区分同名任务，必须带 workspace 维度。
// [权衡] unreadAt 可选，未读状态由时间戳表达而非布尔。
export interface WebRemoteControlTaskTarget {
  taskId: string;
  hostId?: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  workspaceLabel: string;
  workspaceKind: "local" | "remote";
  createdAt: number;
  updatedAt: number;
  provider?: ZCodeProvider;
  unreadAt?: number;
}

// [契约] 列表结果同时给出 items 与当前激活的 workspaceKey/taskId；
// 激活项可能不在列表中（已关闭），消费端必须容忍。
// [失败路径] 强制激活项存在于列表会让关闭后的恢复失败。
// [权衡] WebRemoteControlWorkspaceListResult 不做过滤：已关闭的激活项也要返回，过滤属于选择逻辑。
export interface WebRemoteControlWorkspaceListResult {
  workspaces: WebRemoteControlWorkspaceTarget[];
  activeWorkspaceKey?: string;
  activeTaskId?: string;
}

export type WebRemoteControlMobileNavigationIntent = "chat";

// [契约] 切换选项区分「面板打开」与「任务选择」两类意图，不能混用字段；
// openFileManager 仅用于 Web 导航，不发送给 Host。
// [失败路径] 用 fileTreeTaskId 触发选择会误标已读。
// [权衡] markTaskReadExpectedUnreadAt 只在建立 bridge 后清除对应快照的未读。
export interface WebRemoteControlWorkspaceSwitchOptions {
  /** 仅 Web 页面导航使用，不发送给 Host；目标 Root 打开文件面板。 */
  openFileManager?: boolean;
  taskId?: string;
  taskHostId?: string;
  /** 仅解析任务目录供文件树使用，不选择任务或标记已读。 */
  fileTreeTaskId?: string;
  mobileNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  /** 手机端从项目侧栏打开未读任务时携带；目标 bridge 建立后只清除这次快照对应的未读。 */
  markTaskReadExpectedUnreadAt?: number;
}

export interface WebRemoteControlWorkspaceSwitchResult extends WebRemoteControlSessionCreateResponse {}

export interface WebRemoteControlMobileViewState {
  activeWorkspaceKey?: string;
  activeTaskId?: string;
  updatedAt: number;
}

export interface WebRemoteControlLocalWorkspaceBridge {
  bridgeSessionId: string;
  bridgeToken: string;
  kind: "local";
  workspaceKey: string;
  workspacePath: string;
  initialTaskId?: string;
  wsUrl: string;
}

export interface WebRemoteControlRemoteWorkspaceBridge {
  bridgeSessionId: string;
  bridgeToken: string;
  kind: "remote";
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity: string;
  remoteSessionId: string;
  initialTaskId?: string;
  wsUrl: string;
}

export type WebRemoteControlWorkspaceBridge =
  | WebRemoteControlLocalWorkspaceBridge
  | WebRemoteControlRemoteWorkspaceBridge;

// [契约] bootstrap 结果包含窗口会话、workspace 列表与可选视图状态；
// desktopAppVersion 缺失表示旧桌面，手机保留原 URL。
// [失败路径] 用版本号缺省推断能力会误判新桌面。
// [权衡] mobileTaskViewEpoch 只补足配对瞬间的请求，不用于恢复可见任务。
export interface WebRemoteControlWindowBootstrapResult {
  windowControlSessionId: string;
  /** 当前连接的桌面实际版本；旧桌面缺失时手机保留原 URL。 */
  desktopAppVersion?: string;
  workspaces: WebRemoteControlWorkspaceTarget[];
  initialViewState?: WebRemoteControlMobileViewState;
  mobileViewState?: WebRemoteControlMobileViewState;
  /** 仅新端提供；用 bootstrap 补足配对瞬间的重申请求，不能用来恢复可见任务。 */
  mobileTaskViewEpoch?: string;
}

export interface WebRemoteControlWindowControlReadyEvent {
  type: "window-control-ready";
  windowControlSessionId: string;
  mobileConnectionId: string;
  expiresAt: number;
}

// [契约] 身份 key 统一为 identity.trim() 或 path，是全仓库唯一的构造口径；
// trim 后为空视为无 identity，回落到路径。
// [失败路径] 各处手写拼接会产生大小写或尾斜杠差异，导致去重失效。
// [权衡] 只 trim 不转小写，路径大小写语义由平台决定。
export function resolveWebRemoteControlWorkspaceKey(
  target: Pick<WebRemoteControlWorkspaceTarget, "workspacePath" | "workspaceIdentity">,
): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

// [契约] 本地 workspace 永远可 bridge；远程必须同时有 identity 与 remoteSessionId；
// 断连的远程项仍在列表中展示，但不能作为连接目标。
// [失败路径] 放宽为只判断 identity 会对已断连 SSH 发起无效连接。
// [权衡] 该判断只读字段，不查询实时连接状态。
export function isWebRemoteControlBridgeableWorkspaceTarget(
  workspace: WebRemoteControlWorkspaceTarget,
): boolean {
  return (
    workspace.kind !== "remote" || Boolean(workspace.workspaceIdentity && workspace.remoteSessionId)
  );
}

// [契约] 优先恢复历史激活项，但必须存在于 bridgeable 集合中；
// 历史项存在却不可 bridge 时返回 canBridge: false，让 UI 展示断连态。
// [失败路径] 直接返回历史项并 canBridge: true 会跳进无法连接的页面。
// [权衡] 没有任何历史时选第一个 bridgeable；再退化到第一个可展示项。
export function resolveWebRemoteControlInitialWorkspaceSelection({
  workspaces,
  mobileViewState,
  initialViewState,
}: {
  workspaces: WebRemoteControlWorkspaceTarget[];
  mobileViewState?: WebRemoteControlMobileViewState;
  initialViewState?: WebRemoteControlMobileViewState;
}): { workspaceKey: string; taskId?: string; canBridge: boolean } | null {
  const bridgeableWorkspaces = workspaces.filter(isWebRemoteControlBridgeableWorkspaceTarget);
  const workspaceKeys = new Set(
    bridgeableWorkspaces.map((workspace) => resolveWebRemoteControlWorkspaceKey(workspace)),
  );
  const allWorkspaceKeys = new Set(
    workspaces.map((workspace) => resolveWebRemoteControlWorkspaceKey(workspace)),
  );
  const selectedViewState = mobileViewState ?? initialViewState;
  const selectedWorkspaceKey = selectedViewState?.activeWorkspaceKey;

  if (selectedWorkspaceKey && workspaceKeys.has(selectedWorkspaceKey)) {
    return {
      workspaceKey: selectedWorkspaceKey,
      ...(selectedViewState.activeTaskId ? { taskId: selectedViewState.activeTaskId } : {}),
      canBridge: true,
    };
  }

  // Bugfix: 手机端列表会展示已断开的 SSH workspace，但这类项没有 remoteSessionId，
  // 不能作为初始 bridge 目标。否则重连状态尚未同步时会反复进入“尚未连接”的错误页。
  const firstWorkspace = bridgeableWorkspaces[0];
  if (!firstWorkspace) {
    if (selectedWorkspaceKey && allWorkspaceKeys.has(selectedWorkspaceKey)) {
      return {
        workspaceKey: selectedWorkspaceKey,
        ...(selectedViewState?.activeTaskId ? { taskId: selectedViewState.activeTaskId } : {}),
        canBridge: false,
      };
    }

    const firstDisconnectedWorkspace = workspaces[0];
    if (!firstDisconnectedWorkspace) {
      return null;
    }

    return {
      workspaceKey: resolveWebRemoteControlWorkspaceKey(firstDisconnectedWorkspace),
      canBridge: false,
    };
  }

  return {
    workspaceKey: resolveWebRemoteControlWorkspaceKey(firstWorkspace),
    canBridge: true,
  };
}

export interface WebRemoteControlWorkspaceListRequest {
  type: "workspace-list-request";
  requestId: string;
  sessionId: string;
}

// [契约] 切换请求必须带 sessionId 与 workspaceKey，requestId 用于回配；
// taskId 可选，表示切换后同时打开该任务。
// [失败路径] 缺少 sessionId 会让 Main 无法定位窗口控制上下文。
// [权衡] 与 App 层 payload 分开定义，避免两套协议字段互相污染。
export interface WebRemoteControlWorkspaceSwitchRequest {
  type: "workspace-switch-request";
  requestId: string;
  sessionId: string;
  workspaceKey: string;
  taskId?: string;
}

export interface WebRemoteControlWorkspaceListSuccessResponse {
  type: "workspace-list-response";
  requestId: string;
  sessionId: string;
  success: true;
  result: WebRemoteControlWorkspaceListResult;
}

export interface WebRemoteControlWorkspaceSwitchSuccessResponse {
  type: "workspace-switch-response";
  requestId: string;
  sessionId: string;
  success: true;
  result: WebRemoteControlWorkspaceSwitchResult;
}

export interface WebRemoteControlWorkspaceListErrorResponse {
  type: "workspace-list-response";
  requestId: string;
  sessionId: string;
  success: false;
  error: string;
}

export interface WebRemoteControlWorkspaceSwitchErrorResponse {
  type: "workspace-switch-response";
  requestId: string;
  sessionId: string;
  success: false;
  error: string;
}

export type WebRemoteControlWorkspaceControlRequest =
  | WebRemoteControlWorkspaceListRequest
  | WebRemoteControlWorkspaceSwitchRequest;

export type WebRemoteControlWorkspaceControlResponse =
  | WebRemoteControlWorkspaceListSuccessResponse
  | WebRemoteControlWorkspaceSwitchSuccessResponse
  | WebRemoteControlWorkspaceListErrorResponse
  | WebRemoteControlWorkspaceSwitchErrorResponse;

export interface WebRemoteControlWindowBootstrapRequest {
  type: "window-bootstrap-request";
  requestId: string;
  windowControlSessionId: string;
}

export interface WebRemoteControlWindowBootstrapSuccessResponse {
  type: "window-bootstrap-response";
  requestId: string;
  windowControlSessionId: string;
  success: true;
  result: WebRemoteControlWindowBootstrapResult;
}

export interface WebRemoteControlWindowBootstrapErrorResponse {
  type: "window-bootstrap-response";
  requestId: string;
  windowControlSessionId: string;
  success: false;
  error: string;
}

// [契约] bridge 请求必须同时带 windowControlSessionId 与 bridgeSessionId；
// bridgeToken 是本次 bridge 的凭据，不能复用 deviceToken。
// [失败路径] 复用窗口 token 会扩大单个 bridge 的权限。
// [权衡] taskId 可选，支持只打开 workspace 不选任务。
export interface WebRemoteControlWorkspaceBridgeRequest {
  type: "workspace-bridge-request";
  requestId: string;
  windowControlSessionId: string;
  bridgeSessionId: string;
  bridgeToken: string;
  workspaceKey: string;
  taskId?: string;
}

export interface WebRemoteControlWorkspaceBridgeSuccessResponse {
  type: "workspace-bridge-response";
  requestId: string;
  windowControlSessionId: string;
  success: true;
  bridge: WebRemoteControlWorkspaceBridge;
}

export interface WebRemoteControlWorkspaceBridgeErrorResponse {
  type: "workspace-bridge-response";
  requestId: string;
  windowControlSessionId: string;
  success: false;
  error: string;
}

// [契约] 视图状态更新只包含激活的 workspace/task 与设备信息；
// 该消息由手机主动上报，Main 负责校验后广播。
// [失败路径] 允许携带任意 UI 状态会让桌面端信任不可控输入。
// [权衡] deviceInfo 可选，旧客户端可只报视图。
export interface WebRemoteControlMobileViewStateUpdate {
  type: "mobile-view-state-update";
  windowControlSessionId: string;
  viewState: WebRemoteControlMobileViewState;
  deviceInfo?: WebRemoteControlMobileDeviceInfo;
}

// [契约] 窗口控制请求只包含 bootstrap、bridge 与视图上报三类；
// 不得把 workspace 列表/切换混入窗口层，两者生命周期不同。
// [失败路径] 混用会让窗口关闭后仍有 workspace 级请求在途。
// [权衡] 三类请求共享 windowControlSessionId 作为路由键。
export type WebRemoteControlWindowControlRequest =
  | WebRemoteControlWindowBootstrapRequest
  | WebRemoteControlWorkspaceBridgeRequest
  | WebRemoteControlMobileViewStateUpdate;

export type WebRemoteControlWindowControlResponse =
  | WebRemoteControlWindowBootstrapSuccessResponse
  | WebRemoteControlWindowBootstrapErrorResponse
  | WebRemoteControlWorkspaceBridgeSuccessResponse
  | WebRemoteControlWorkspaceBridgeErrorResponse;

// [契约] relay 只转发事件，不解释业务；该联合是 Desktop 侧的入站集合；
// tunnel/window 注册与连接事件只有类型与 id，不携带任务状态。
// [失败路径] 在 relay 事件里加入队列或快照会让 relay 变成状态所有者。
// [权衡] 复用平台与 workspace 控制类型，避免重复定义。
export type RelayDesktopControlEvent =
  | { type: "tunnel-registered"; tunnelId: string }
  | { type: "window-control-registered"; tunnelId: string }
  | { type: "web-remote-control-session-request"; sessionId: string }
  | { type: "mobile-connected"; windowControlSessionId: string }
  | { type: "mobile-disconnected"; windowControlSessionId: string }
  | WebRemoteControlPlatformRequest
  | WebRemoteControlPlatformResponse
  | WebRemoteControlWorkspaceControlRequest
  | WebRemoteControlWorkspaceControlResponse
  | WebRemoteControlWindowControlRequest
  | WebRemoteControlWindowControlResponse;
