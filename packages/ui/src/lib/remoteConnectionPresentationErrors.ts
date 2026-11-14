// INV-01 映射完整：守住位置 错误码到文案的映射类型；改错故障：新增公开码漏映射，类型检查失败或运行时空白。
// INV-02 非公开码回落：守住位置 分类函数开头的可用性判断；改错故障：内部码被当公开文案渲染。
// INV-03 分类与文案同源：守住位置 分类初值与标题初值的同一判定；改错故障：分类命中而标题回落未知。
// INV-04 认证优先：守住位置 旧消息兜底分支；改错故障：明确认证失败被显示成阶段错误。
// INV-05 不猜测认证：守住位置 兜底的消息正则；改错故障：权限拒绝被误判为认证失败。
// INV-06 动作缺省：守住位置 主动作初值；改错故障：未知错误没有可执行动作。
// INV-07 变体后缀：守住位置 环境变体标题拼接；改错故障：WSL 与 Docker 复用同一提示，用户无法区分。
// INV-08 变体白名单：守住位置 可加后缀的标题列表；改错故障：所有标题都被追加环境后缀。
// INV-09 部署判定：守住位置 部署类错误码列表；改错故障：认证错误也提供下载入口。
// INV-10 下载条件：守住位置 允许下载的合取式；改错故障：非 SSH 目标出现下载按钮。
// INV-11 安装模式：守住位置 资产安装模式回退；改错故障：远端安装模式仍给本地上传入口。
// INV-12 重试额度：守住位置 额度耗尽时的插值；改错故障：提示缺少尝试次数与上限。
// INV-13 原因标识：守住位置 标题派生原因键；改错故障：原因文案与标题不是同一套。
// INV-14 动作文案：守住位置 动作消息键拼装；改错故障：动作按钮显示原始键名。
// INV-15 回退文案：守住位置 格式化函数的标题取值；改错故障：分类失败时没有可读文本。
// INV-16 重试提示：守住位置 可重试追加；改错故障：可重试错误没有提示，用户不知可再试。
// INV-17 独立提示抑制：守住位置 版本阻断判断；改错故障：重连路径重复弹出无动作提示。
// INV-18 纯函数：守住位置 本文件全部导出；改错故障：读取全局语言导致同输入不同结果。
//
// 模块职责：把远程连接错误码与旧传输层消息归类为可展示的标题、原因与主操作。
// 状态所有权：无状态；文案只产出消息键，实际翻译由调用方完成。
// 阅读顺序：展示结构 → 错误码映射 → 分类函数 → 格式化与提示抑制。
import {
  isPublicZCodeErrorCode,
  REMOTE_BIND_CANCELED_ERROR_CODE,
  REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE,
  REMOTE_WORKSPACE_BIND_SESSION_MISSING_ERROR_CODE,
  REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE,
  SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
  SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_REMOVE_CALLBACK_MISSING_ERROR_CODE,
  SOURCE_SERVER_REMOVE_CALLBACK_FAILED_ERROR_CODE,
  SOURCE_SERVER_REMOVE_PERSIST_FAILED_ERROR_CODE,
  WORKSPACE_CONFIG_FILE_CONFLICT_ERROR_CODE,
  WORKSPACE_MIGRATION_PLAN_DIVERGED_ERROR_CODE,
  WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE,
  WORKSPACE_TASK_IDENTITY_CONFLICT_ERROR_CODE,
  type PublicZCodeErrorCode,
} from "@zcode/shared";

import type { RemoteTarget } from "@zcode/shared";
import type { RemoteConnectionAction } from "@/lib/remoteConnectionPresentationTypes.js";

// 展示结构：标题、原因、主操作与操作文案都是消息键，翻译交给调用方。
// allowLocalDownload 由分类结果一并给出，调用方不再自行判断 errorCode 属于哪类。
//
export interface RemoteConnectionErrorPresentation {
  category: string;
  titleId: string;
  reasonId: string;
  values?: Record<string, string | number>;
  primaryAction: RemoteConnectionAction;
  actionMessageId: string;
  allowRemoteDownload: boolean;
}

// 映射表：公开错误码全覆盖，新增公开码必须同步补键，否则类型检查会失败。
// 少数移除类错误指向设置页的来源错误文案。
//
const messageIdByCode: Record<PublicZCodeErrorCode, string> = {
  "remote-authentication-failed": "remote.error.authentication",
  "remote-host-unreachable": "remote.error.hostUnreachable",
  "remote-connection-timeout": "remote.error.connectionTimeout",
  "remote-host-not-found": "remote.error.hostNotFound",
  "remote-host-key-changed": "remote.error.hostKeyChanged",
  "remote-download-failed": "remote.error.downloadFailed",
  "remote-upload-failed": "remote.error.uploadFailed",
  "remote-preflight-failed": "remote.error.preflightFailed",
  "remote-install-failed": "remote.error.installFailed",
  "remote-space-insufficient": "remote.error.spaceInsufficient",
  "remote-permission-denied": "remote.error.permissionDenied",
  "remote-connection-canceled": "remote.error.connectionCanceled",
  "remote-connection-unknown": "remote.error.unknown",

  [SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE]: "remote.error.sourceServerInstallRequired",
  [SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE]:
    "remote.error.sourceServerIdentityChangePending",
  [SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE]: "remote.error.sourceServerUpgradeRequired",
  [SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE]: "remote.error.sourceServerRunningTasks",
  [WORKSPACE_TASK_IDENTITY_CONFLICT_ERROR_CODE]: "remote.error.workspaceTaskIdentityConflict",
  [WORKSPACE_CONFIG_FILE_CONFLICT_ERROR_CODE]: "remote.error.workspaceConfigConflict",
  [WORKSPACE_MIGRATION_PLAN_DIVERGED_ERROR_CODE]: "remote.error.workspaceMigrationPlanDiverged",
  [WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE]:
    "remote.error.workspaceSessionGenerationChanged",
  [REMOTE_BIND_CANCELED_ERROR_CODE]: "remote.error.bindCanceled",
  [REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE]: "remote.error.recoveryBudgetExhausted",
  [REMOTE_WORKSPACE_BIND_SESSION_MISSING_ERROR_CODE]: "remote.error.bindSessionMissing",
  [REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE]: "remote.error.workspaceDirectoryUnavailable",
  [SOURCE_SERVER_REMOVE_CALLBACK_MISSING_ERROR_CODE]:
    "settings.source.error.source-server-remove-callback-missing",
  [SOURCE_SERVER_REMOVE_CALLBACK_FAILED_ERROR_CODE]:
    "settings.source.error.source-server-remove-callback-failed",
  [SOURCE_SERVER_REMOVE_PERSIST_FAILED_ERROR_CODE]:
    "settings.source.error.source-server-remove-persist-failed",
};

// classifyRemoteConnectionError 先用 messageIdByCode 取标题与 category，再由 switch 按具体码细化 primaryAction。
// 未识别的码统一落到未知标题与未识别分类，但主操作仍保留重试。
// 分类与标题使用同一可用性判断，避免分类命中而标题为空。
//
export function classifyRemoteConnectionError(input: {
  errorCode?: string;
  error?: string;
  target?: RemoteTarget;
  upgradeTarget?: "controller" | "server";
  recoveryAttempt?: number;
  recoveryLimit?: number;
}): RemoteConnectionErrorPresentation {
  const code = input.errorCode ?? "";
  // 初值：公开码查表，非公开码回落未知标题。
  // 该值随后会被具体码分支覆盖。
  //
  let titleId = isPublicZCodeErrorCode(code) ? messageIdByCode[code] : "remote.error.unknown";
  let category = isPublicZCodeErrorCode(code) ? code : "unrecognized";
  let primaryAction: RemoteConnectionAction = "retry";
  // switch 按 errorCode 分派七类错误，每类各自把 primaryAction 改写成对应操作。
  // 取消类错误同时把分类改成取消，便于上层区分主动退出。
  //
  switch (code) {
    case "remote-authentication-failed":
      category = "authentication";
      primaryAction = "edit-auth";
      break;
    case "ZCODE_REMOTE_WORKSPACE_DISCONNECTED":
      category = "disconnected";
      titleId = "remote.conversation.sendUnavailable";
      primaryAction = "connect";
      break;
    case "source-server-install-required":
      primaryAction = "install";
      break;
    case "source-server-upgrade-required":
      primaryAction = input.upgradeTarget === "controller" ? "update-desktop" : "update-server";
      break;
    case "source-server-identity-change-pending":
      primaryAction = "confirm-identity";
      break;
    case "remote-host-not-found":
      primaryAction = "edit-host";
      break;
    case "remote-host-key-changed":
      primaryAction = "security";
      break;
    case "remote-space-insufficient":
    case "remote-permission-denied":
      primaryAction = "details";
      break;
    case "remote-bind-canceled":
    case "remote-connection-canceled":
      category = "canceled";
      primaryAction = "connect";
      break;
    case "credentials-required":
      category = "credentials";
      titleId = "remote.error.credentialsRequired";
      primaryAction = "credentials";
      break;
  }
  // 兼容旧传输层的无认证码消息；新连接直接消费公开码，不能从 permission denied 猜测认证。
  if (
    // SSH 认证发生在 probe 内，传输层可能附带 preflight 码；明确的认证原因优先于阶段兜底。
    (!code || code === "remote-connection-unknown" || code === "remote-preflight-failed") &&
    /all configured authentication methods failed|authentication failed|ssh authentication|SSH\s*认证失败/iu.test(
      input.error ?? "",
    )
  ) {
    category = "authentication";
    titleId = "remote.error.authentication";
    primaryAction = "edit-auth";
  }
  // 目标类型：读取远程目标的运行环境，用于后续标题变体。
  // target 缺失时 kind 为 undefined，variantTitles 不加环境后缀。
  //
  const kind = input.target?.kind;
  const variantTitles = [
    "remote.error.hostUnreachable",
    "remote.error.connectionTimeout",
    "remote.error.hostNotFound",
    "remote.error.preflightFailed",
    "remote.error.installFailed",
    "remote.error.spaceInsufficient",
    "remote.error.permissionDenied",
  ];
  // 变体后缀：WSL 与 Docker 的同类错误追加环境后缀，提示里直接点明环境。
  // 只有白名单里的标题可追加，其它标题保持原样。
  //
  if ((kind === "wsl" || kind === "docker") && variantTitles.includes(titleId))
    titleId += `.${kind}`;
  const deployment = [
    "remote-download-failed",
    "remote-upload-failed",
    "remote-preflight-failed",
    "remote-install-failed",
  ].includes(code);
  // 返回结构：仅在额度耗尽时附带尝试次数与上限，其余错误不带插值。
  // 原因键由标题派生，动作文案由主操作派生，三者保持同源。
  //
  return {
    category,
    ...(code === REMOTE_RECOVERY_BUDGET_EXHAUSTED_ERROR_CODE
      ? { values: { attempt: input.recoveryAttempt ?? "?", limit: input.recoveryLimit ?? "?" } }
      : {}),
    titleId,
    reasonId: `${titleId}.reason`,
    primaryAction,
    actionMessageId: `remote.action.${primaryAction}`,
    allowRemoteDownload:
      deployment &&
      category !== "authentication" &&
      input.target?.kind === "ssh" &&
      (input.target.assetInstallMode ?? "local-download-upload") === "local-download-upload",
  };
}

// formatRemoteConnectionError 先调 classifyRemoteConnectionError 再翻译 titleId，retryable 为真时追加 retryableHint。
// 回退文本参与认证原因的兜底匹配。
//
export function formatRemoteConnectionError(params: {
  fallback: string;
  reasonCode?: string;
  retryable?: boolean;
  recoveryAttempt?: number;
  recoveryLimit?: number;
  formatMessage: (descriptor: { id: string }, values?: Record<string, number | string>) => string;
}): string {
  const classified = classifyRemoteConnectionError({
    errorCode: params.reasonCode,
    error: params.fallback,
    recoveryAttempt: params.recoveryAttempt,
    recoveryLimit: params.recoveryLimit,
  });
  const message = params.formatMessage({ id: classified.titleId }, classified.values);
  return params.retryable === true
    ? `${message} ${params.formatMessage({ id: "remote.error.retryableHint" })}`
    : message;
}

// 独立提示抑制：版本阻断已由来源管理页给出带操作的提示，重连路径不再重复。
// 除 source-server-upgrade-required 之外的 reasonCode 都返回 true，照常弹独立提示。
//
export function shouldShowStandaloneRemoteErrorToast(reasonCode: string | undefined): boolean {
  // 版本阻断由 Source management 权威状态生成带「立即更新」的操作 Toast。
  // 重连路径再弹一个无动作错误会变成重复且不可恢复的噪音。
  return reasonCode !== "source-server-upgrade-required";
}
