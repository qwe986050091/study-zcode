// INV-01 目标同构：守住位置 isSameWebRemoteControlTarget；改错故障：跨工作区复用旧会话。
// INV-02 会话必存：守住位置 标识非空判断；改错故障：空标识被判为同一目标。
// INV-03 窗口或会话：守住位置 尾部存在性检查；改错故障：只有工作区的两个空壳被判同一。
// INV-04 复用有界：守住位置 isReusable；改错故障：空闲或错误态被复用。
// INV-05 已连接才复用：守住位置 手机连接判断；改错故障：未连接会话跨工作区复用，带回旧默认工作区。
// INV-06 文案集中：守住位置 标签与详情；改错故障：组件里散落硬编码中文。
// INV-07 未知回退：守住位置 状态映射缺省；改错故障：新状态没有文案，界面空白。
// INV-08 颜色语义：守住位置 圆点类名；改错故障：错误态与空闲态同色，问题不可见。
// INV-09 设备兜底：守住位置 标签取值；改错故障：已连接但无设备信息时标签为空。
// INV-10 字段全覆盖：守住位置 isSameWebRemoteControlStatus；改错故障：二维码变化被判定为同一状态。
// INV-11 失败按值比较：守住位置 失败对象比较；改错故障：每次轮询新建对象都触发更新。
// INV-12 空失败即空：守住位置 失败描述入口；改错故障：无失败时渲染空提示框。
// INV-13 冲突细分：守住位置 踢出原因匹配；改错故障：通用的占用提示掩盖具体原因。
// INV-14 只读：守住位置 全部函数；改错故障：展示层修改状态对象。
// INV-15 纯函数：守住位置 全部函数；改错故障：展示推导依赖当前时间，同一状态文案漂移。
// INV-16 标识去空白：守住位置 比较前处理；改错故障：前后空格让同一标识被判不同。
// INV-17 状态闭合：守住位置 状态类型；改错故障：未知字符串绕过映射。
// INV-18 平台优先：守住位置 设备名取值顺序；改错故障：平台与自定义名随机切换。
//
// 模块职责：Web 远程控制状态的展示派生（标签、详情、颜色、失败描述）。
// 状态所有权：无状态；所有函数只读入参并返回新值。
// 阅读顺序：目标比较 → 复用判定 → 文案 → 颜色 → 状态比较 → 失败描述。
import type { WebRemoteControlStatus, WebRemoteControlFailure } from "@zcode/shared";
import { resolveWebRemoteControlWorkspaceKey } from "@zcode/shared";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";

// status.state 为 idle 或 error 时不构成同一目标，调用方需要重新发起连接。
// 只比 sessionId 会把别的 worktree 的旧会话当成同一个目标，因此还要比 workspaceKey。
// 第一步比 resolveWebRemoteControlWorkspaceKey 的结果，workspaceIdentity 优先于 workspacePath。
// 第二步比 sessionId，两侧都先 trim 再判等，避免尾随空格造成假不等。
// 第三步要求 windowSessionId 或普通 sessionId 至少有一个非空，两个都空就判不相等。
//
export function isSameWebRemoteControlTarget(
  status: WebRemoteControlStatus,
  workspacePath: string,
  workspaceIdentity?: string,
  remoteSessionId?: string,
): boolean {
  if (status.status === "idle" || status.status === "error") {
    return false;
  }

  // Bugfix: 之前这里仅凭 sessionId 存在就判定“同一目标”，会把其他 workspace 的旧会话误复用，
  // 导致当前 workspace 打开弹层时不触发 start，状态长期卡在 starting。
  // 这里改为严格比较 workspaceKey(identity 优先) + remoteSessionId，确保会话和目标一一对应。
  const statusWorkspacePath = status.workspacePath?.trim();
  if (!statusWorkspacePath) {
    return false;
  }

  const expectedWorkspaceKey = resolveWebRemoteControlWorkspaceKey({
    workspacePath,
    workspaceIdentity,
  });
  const statusWorkspaceKey = resolveWebRemoteControlWorkspaceKey({
    workspacePath: statusWorkspacePath,
    workspaceIdentity: status.workspaceIdentity,
  });
  if (statusWorkspaceKey !== expectedWorkspaceKey) {
    return false;
  }

  const expectedRemoteSessionId = remoteSessionId?.trim() || undefined;
  const statusRemoteSessionId = status.remoteSessionId?.trim() || undefined;
  if (statusRemoteSessionId !== expectedRemoteSessionId) {
    return false;
  }

  return Boolean(status.windowControlSessionId ?? status.sessionId);
}

// 空闲与错误态不可复用，避免复用已失效二维码。
// 只有已经连上手机的会话才允许跨工作区复用。
// 未连接会话跨工作区复用会把新扫码用户带回旧默认工作区。
//
export function isReusableWebRemoteControlSession(status: WebRemoteControlStatus): boolean {
  if (status.status === "idle" || status.status === "error") {
    return false;
  }

  // Bugfix: 打开桌面弹层只是查看/管理 window 级远控入口，不能因为当前桌面 workspace
  // 和手机已 bridge 的 workspace 不一致就重启 device relay 会话；否则会主动给手机发
  // desktop-disconnected。只有已经连上手机的会话才跨 workspace 复用，避免未连接的旧二维码
  // 继续把新扫码用户带回旧默认 workspace。
  return Boolean(status.mobileConnected && (status.windowControlSessionId ?? status.sessionId));
}

// 状态文案集中在消息表，组件不拼字符串。
// 未知状态回退空闲文案。
//
export function getStatusLabel(
  status: WebRemoteControlStatus,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string {
  switch (status.status) {
    case "starting":
      return formatMessage({ id: "webRemoteControl.status.starting" });
    case "running":
      return formatMessage({ id: "webRemoteControl.status.running" });
    case "connecting":
      return formatMessage({ id: "webRemoteControl.status.connecting" });
    case "active":
      return formatMessage({ id: "webRemoteControl.status.active" });
    case "error":
      return formatMessage({ id: "webRemoteControl.status.error" });
    default:
      return formatMessage({ id: "webRemoteControl.status.idle" });
  }
}

// 详情文案与状态文案分表维护。
// 未知状态同样回退空闲详情。
//
export function getStatusDetail(
  status: WebRemoteControlStatus,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string {
  switch (status.status) {
    case "starting":
      return formatMessage({ id: "webRemoteControl.statusDetail.starting" });
    case "running":
      return formatMessage({ id: "webRemoteControl.statusDetail.running" });
    case "connecting":
      return formatMessage({ id: "webRemoteControl.statusDetail.connecting" });
    case "active":
      return formatMessage({ id: "webRemoteControl.statusDetail.active" });
    case "error":
      return formatMessage({ id: "webRemoteControl.statusDetail.error" });
    default:
      return formatMessage({ id: "webRemoteControl.statusDetail.idle" });
  }
}

// 错误用危险色，已连接用成功色。
// 空闲用边框色，其余状态统一警告色。
//
export function getStatusDotClassName(status: WebRemoteControlStatus): string {
  if (status.status === "error") {
    return "bg-destructive";
  }
  if (status.status === "active") {
    return "bg-success";
  }
  if (status.status === "idle") {
    return "bg-border";
  }
  return "bg-warning";
}

// getWebRemoteControlStatusTagLabel 先取 platform 再回落到 deviceName，两者都缺时才用兜底文案。
// 已连接但无设备信息时显示手机。
//
export function getWebRemoteControlStatusTagLabel(
  status: WebRemoteControlStatus,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string {
  const deviceName =
    status.mobileDeviceInfo?.browserPlatform?.trim() || status.mobileDeviceInfo?.name?.trim();

  if (deviceName) {
    return deviceName;
  }

  if (status.mobileConnected) {
    return formatMessage({ id: "webRemoteControl.statusTag.phone" });
  }

  if (status.status === "idle") {
    return formatMessage({ id: "webRemoteControl.status.idle" });
  }

  if (status.status === "error") {
    return formatMessage({ id: "webRemoteControl.status.error" });
  }

  return formatMessage({ id: "webRemoteControl.statusTag.ready" });
}

// 逐字段比较，覆盖会话、设备、二维码与工作区。
// 失败信息只比较原因与消息，不比较对象引用。
//
export function isSameWebRemoteControlStatus(
  left: WebRemoteControlStatus,
  right: WebRemoteControlStatus,
): boolean {
  return (
    left.status === right.status &&
    left.sessionId === right.sessionId &&
    left.windowControlSessionId === right.windowControlSessionId &&
    left.deviceToken === right.deviceToken &&
    left.expiresAt === right.expiresAt &&
    left.mobileConnected === right.mobileConnected &&
    left.mobileDeviceInfo?.updatedAt === right.mobileDeviceInfo?.updatedAt &&
    left.mobileDeviceInfo?.userAgent === right.mobileDeviceInfo?.userAgent &&
    left.mobileDeviceInfo?.viewport?.width === right.mobileDeviceInfo?.viewport?.width &&
    left.mobileDeviceInfo?.viewport?.height === right.mobileDeviceInfo?.viewport?.height &&
    left.qrUrl === right.qrUrl &&
    left.connectUrl === right.connectUrl &&
    left.workspacePath === right.workspacePath &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.remoteSessionId === right.remoteSessionId &&
    left.error === right.error &&
    left.failure?.reason === right.failure?.reason &&
    left.failure?.message === right.failure?.message
  );
}

// 无失败对象返回空，调用方据此不渲染提示。
// 冲突原因里带踢出字样时改用更具体的文案。
//
export function getFailureDescription(
  failure: WebRemoteControlFailure | undefined,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
): string | null {
  if (!failure) {
    return null;
  }

  switch (failure.reason) {
    case "session-not-found":
      return formatMessage({ id: "webRemoteControl.failure.sessionNotFound" });
    case "session-expired":
      return formatMessage({ id: "webRemoteControl.failure.sessionExpired" });
    case "session-conflict":
      if (failure.message?.toLowerCase().includes("kicked")) {
        return formatMessage({ id: "webRemoteControl.failure.kicked" });
      }
      return formatMessage({ id: "webRemoteControl.failure.sessionConflict" });
    case "workspace-closed":
      return formatMessage({ id: "webRemoteControl.failure.workspaceClosed" });
    case "desktop-disconnected":
      return formatMessage({
        id: "webRemoteControl.failure.desktopDisconnected",
      });
    case "invalid-mobile-connection":
      return formatMessage({
        id: "webRemoteControl.failure.invalidMobileConnection",
      });
    case "desktop-bootstrap-timeout":
      return formatMessage({
        id: "webRemoteControl.failure.desktopBootstrapTimeout",
      });
    case "connection-recovery-timeout":
      return formatMessage({
        id: "webRemoteControl.failure.connectionRecoveryTimeout",
      });
    case "relay-unavailable":
      return formatMessage({ id: "webRemoteControl.failure.relayUnavailable" });
    case "unsupported-action":
      return formatMessage({
        id: "webRemoteControl.failure.unsupportedAction",
      });
    case "device-not-owned":
    case "auth-required":
      return failure.message ?? null;
    case "unexpected-error":
      return formatMessage({ id: "webRemoteControl.failure.unexpectedError" });
  }
}
