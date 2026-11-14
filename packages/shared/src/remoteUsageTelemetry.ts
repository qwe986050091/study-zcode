// INV-01 埋点只取场景枚举：守住位置 resolveWorkspaceTelemetryDetail；改错故障 地址或路径进入业务埋点。
// INV-02 本地与远端判定看两个来源：守住位置 workspace_kind 计算；改错故障 远端会话被记为本地。
// INV-03 未知远端身份仍归远端：守住位置 三元回退；改错故障 无法解析时降级为本地。
// INV-04 远端类别只保留解析结果：守住位置 remote_kind；改错故障 原始标识被带出。
// INV-05 成功时错误分类必须为空：守住位置 buildResultDetail；改错故障 成功事件带 residual 分类。
// INV-06 失败时分类缺省 unknown：守住位置 回退分支；改错故障 看板出现空分类。
// INV-07 分类集合保持低基数：守住位置 RemoteUsageErrorCategory；改错故障 自由文本炸开维度。
// INV-08 事件区域由构建函数固定：守住位置 buildWebRemoteControlEvent；改错故障 区域名各写各的。
// INV-09 连接结果事件字段固定：守住位置 buildRemoteWorkspaceConnectResultTelemetry；改错故障 键名漂移。
// INV-10 触发方式三选一：守住位置 RemoteWorkspaceConnectTrigger；改错故障 新入口无法归类。
// INV-11 入口浏览事件只带类别：守住位置 buildWebRemoteControlEntryViewTelemetry；改错故障 浏览带结果字段。
// INV-12 启动结果区分取消：守住位置 WebRemoteControlStartTelemetryResult；改错故障 取消被记成失败。
// INV-13 配对与桥接各带专属维度：守住位置 pair_kind 与 entry_kind；改错故障 两条漏斗混线。
// INV-14 原始错误只在本地匹配：守住位置 readErrorSearchText；改错故障 错误原文进入埋点。
// INV-15 错误匹配先小写再判定：守住位置 字符串拼接与 lower；改错故障 大小写导致漏判。
// INV-16 认证类优先命中：守住位置 第一条正则；改错故障 权限错误被记成连接失败。
// INV-17 部署与启动分列：守住位置 中段正则；改错故障 资产失败与进程失败混淆。
// INV-18 都不命中记 unknown：守住位置 末尾回退；改错故障 未分类事件被丢弃。
//
// 模块职责：远端工作区与网页远控的使用埋点事件构造和错误归类。
// 状态所有权：无状态；全部为纯函数，事件对象每次新建。
// 阅读顺序：先看工作区类别，再读各事件构造，最后看错误归类。
import type { RemoteTarget } from "./remoteTarget.js";
import type { TelemetryEventPayload } from "./telemetry.js";
import {
  parseRemoteWorkspaceIdentity,
  type RemoteWorkspaceIdentityKind,
} from "./remote-workspace-identity.js";

/** 只提取场景枚举；未知远端身份仍为 remote，禁止向业务埋点暴露地址或路径。 */
// resolveWorkspaceTelemetryDetail 只输出 workspace_kind 与 remote_kind 两个键。
// identity 与 remoteSessionId 都 trim 后为空时 workspace_kind 才是 "local"。
// remoteSessionId 有值时即使解析不出 kind，也仍记为 "remote"。
// remote_kind 只填 parseRemoteWorkspaceIdentity 的 kind，解析不到给 ""。
// URL 与路径都不进入事件对象，埋点侧拿不到原始字符串。
// 返回类型固定为 { workspace_kind, remote_kind }，不随输入增删键。
export function resolveWorkspaceTelemetryDetail(scope: {
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
}): { workspace_kind: "local" | "remote"; remote_kind: RemoteWorkspaceIdentityKind | "" } {
  const identity = scope.workspaceIdentity?.trim();
  return {
    workspace_kind: identity || scope.remoteSessionId?.trim() ? "remote" : "local",
    remote_kind: identity ? (parseRemoteWorkspaceIdentity(identity)?.kind ?? "") : "",
  };
}

export type RemoteUsageRemoteKind = RemoteTarget["kind"];
export type RemoteUsageWorkspaceKind = "local" | "remote";
export type RemoteUsageResult = "success" | "failure";
export type WebRemoteControlStartTelemetryResult = RemoteUsageResult | "cancelled";
export type RemoteWorkspaceConnectTrigger = "new" | "reconnect" | "restore";
export type WebRemoteControlPairKind = "initial" | "reconnect";
export type WebRemoteControlEntryKind = "home" | "task";
export type RemoteUsageErrorCategory =
  | "auth"
  | "connect"
  | "deploy"
  | "host_start"
  | "attach"
  | "relay"
  | "unknown";

// 失败才填错误分类。
// 成功时分类固定为空串。
// 缺省分类回落到 unknown。
// RemoteUsageErrorCategory 是封闭联合，新分类必须改类型而不是塞自由文本。
// buildResultDetail 直接返回新对象，不改 result 或 errorCategory。
// 键名固定为 result 与 error_category，与看板字段一致。
function buildResultDetail(
  result: WebRemoteControlStartTelemetryResult,
  errorCategory?: RemoteUsageErrorCategory,
): Record<string, string> {
  return {
    result,
    error_category: result === "failure" ? (errorCategory ?? "unknown") : "",
  };
}

function buildWebRemoteControlEvent(
  elementName: string,
  eventType: "result" | "view",
  eventExtraDetail: Record<string, string>,
): TelemetryEventPayload {
  return {
    elementName,
    eventRegion: "web_remote_control",
    eventType,
    eventExtraDetail,
  };
}

// eventRegion 固定为 "remote_workspace"，不随调用方变化。
// remote_kind 由 input.remoteKind 直接透传，没有回退值。
// connect_trigger 只接受 "new"、"reconnect"、"restore" 三个字面量，其它值被类型拒绝。
// result 为 "success" 时 error_category 强制写成 ""。
// 失败时缺省记 unknown。
// 事件名用于漏斗首步。
export function buildRemoteWorkspaceConnectResultTelemetry(input: {
  result: RemoteUsageResult;
  remoteKind: RemoteUsageRemoteKind;
  connectTrigger: RemoteWorkspaceConnectTrigger;
  errorCategory?: RemoteUsageErrorCategory;
}): TelemetryEventPayload {
  return {
    elementName: "remote_workspace_connect_result",
    eventRegion: "remote_workspace",
    eventType: "result",
    eventExtraDetail: {
      result: input.result,
      remote_kind: input.remoteKind,
      connect_trigger: input.connectTrigger,
      error_category: input.result === "success" ? "" : (input.errorCategory ?? "unknown"),
    },
  };
}

export function buildWebRemoteControlEntryViewTelemetry(input: {
  workspaceKind: RemoteUsageWorkspaceKind;
  remoteKind?: RemoteUsageRemoteKind;
}): TelemetryEventPayload {
  return buildWebRemoteControlEvent("web_remote_control_entry_view", "view", {
    workspace_kind: input.workspaceKind,
    remote_kind: input.remoteKind ?? "",
  });
}

export function buildWebRemoteControlStartResultTelemetry(input: {
  result: WebRemoteControlStartTelemetryResult;
  workspaceKind: RemoteUsageWorkspaceKind;
  remoteKind?: RemoteUsageRemoteKind;
  errorCategory?: RemoteUsageErrorCategory;
}): TelemetryEventPayload {
  return buildWebRemoteControlEvent("web_remote_control_start_result", "result", {
    ...buildResultDetail(input.result, input.errorCategory),
    workspace_kind: input.workspaceKind,
    remote_kind: input.remoteKind ?? "",
  });
}

export function buildWebRemoteControlPairResultTelemetry(input: {
  result: RemoteUsageResult;
  pairKind: WebRemoteControlPairKind;
  workspaceKind: RemoteUsageWorkspaceKind;
  remoteKind?: RemoteUsageRemoteKind;
  errorCategory?: RemoteUsageErrorCategory;
}): TelemetryEventPayload {
  return buildWebRemoteControlEvent("web_remote_control_pair_result", "result", {
    ...buildResultDetail(input.result, input.errorCategory),
    pair_kind: input.pairKind,
    workspace_kind: input.workspaceKind,
    remote_kind: input.remoteKind ?? "",
  });
}

export function buildWebRemoteControlBridgeResultTelemetry(input: {
  result: RemoteUsageResult;
  workspaceKind: RemoteUsageWorkspaceKind;
  remoteKind?: RemoteUsageRemoteKind;
  entryKind: WebRemoteControlEntryKind;
  errorCategory?: RemoteUsageErrorCategory;
}): TelemetryEventPayload {
  return buildWebRemoteControlEvent("web_remote_control_bridge_result", "result", {
    ...buildResultDetail(input.result, input.errorCategory),
    workspace_kind: input.workspaceKind,
    remote_kind: input.remoteKind ?? "",
    entry_kind: input.entryKind,
  });
}

function readErrorSearchText(error: unknown): string {
  if (typeof error === "string") {
    return error.toLowerCase();
  }
  if (typeof error !== "object" || error === null) {
    return "";
  }
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  const message = "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  return `${code} ${message}`.toLowerCase();
}

/**
 * 原始错误只在本地参与匹配，返回值固定为低基数枚举，禁止把远端目标或错误消息带入埋点。
 */
// readErrorSearchText 的返回值只用于本函数内的正则，不写进事件。
// 先取 code 与 message 并小写。
// auth 正则排在 deploy 之前，权限错误不会被归成 deploy。
// 其余按部署、启动、附加、中继、连接排列。
// 都不命中记 unknown。
export function classifyRemoteUsageError(error: unknown): RemoteUsageErrorCategory {
  const value = readErrorSearchText(error);
  if (/(auth|password|credential|token|permission|denied|unauthor)/.test(value)) {
    return "auth";
  }
  if (/(deploy|download|install|asset|checksum)/.test(value)) {
    return "deploy";
  }
  if (/(host_start|host start|spawn|process.*(?:exit|start)|host.*(?:exit|start))/.test(value)) {
    return "host_start";
  }
  if (
    /(attach|desktop_host_missing|workspace.*(?:identity|missing|mismatch)|remote_session)/.test(
      value,
    )
  ) {
    return "attach";
  }
  if (/(relay|websocket|web socket|pair|device.*(?:kicked|not.found))/.test(value)) {
    return "relay";
  }
  if (/(connect|network|socket|ssh|wsl|docker|server|timeout|timedout|econn)/.test(value)) {
    return "connect";
  }
  return "unknown";
}
