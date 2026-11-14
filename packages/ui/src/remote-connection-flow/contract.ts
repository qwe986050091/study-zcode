// INV-01 回调全部可选除连接本体：守住位置 必填标记；改错故障 调用方被迫补空实现。
// INV-02 设备连接成功不建项目：守住位置 注释约束；改错故障 桌面设备连上就跳目录。
// INV-03 取消回调只认明确取消：守住位置 触发约定；改错故障 后台收起也通知取消。
// INV-04 连接标识由入口生成：守住位置 可选字段；改错故障 卡片恢复被当成新入口。
// INV-05 会话选择允许本地回退路径：守住位置 可选参数；改错故障 仅远端场景被拒绝。
// INV-06 工作区用途限定两种：守住位置 联合类型；改错故障 任意字符串被接受。
// INV-07 首选目标覆盖三项偏好：守住位置 字段集合；改错故障 改选线路后仍用旧偏好。
// INV-08 偏好目录与整体目标并存：守住位置 双字段；改错故障 一处更新另一处过期。
// INV-09 计划清理回调可选：守住位置 可选标记；改错故障 旧调用方编译失败。
// INV-10 归一函数只做字段搬运：守住位置 返回值构造；改错故障 归一阶段夹带副作用。
// INV-11 默认值在解构处声明：守住位置 参数默认值；改错故障 未传时下游读到未定义。
// INV-12 受控开合重命名为受控变量：守住位置 解构重命名；改错故障 遮蔽同名字段。
// INV-13 初始失败沿用偏好类型：守住位置 类型引用；改错故障 文案键与枚举分叉。
// INV-14 归一产物类型由返回值推导：守住位置 类型工具；改错故障 手写类型与实现漂移。
// INV-15 完成意图独立于流程选项：守住位置 单独接口；改错故障 两处字段互相牵连。
// INV-16 进度投影不含凭据：守住位置 字段约束；改错故障 日志意外带出敏感信息。
// INV-17 进度投影不保存连接事实：守住位置 注释约束；改错故障 关闭向导后仍显示已连。
// INV-18 进度视图类型按需导入：守住位置 内联导入；改错故障 顶层循环依赖。
//
// 模块职责：远端连接流程的选项契约、归一函数与进度投影。
// 状态所有权：无状态；全部为类型、归一与只读投影。
// 阅读顺序：先看流程选项，再看归一函数，最后看进度投影。
import type {
  RemoteConnectionFeedbackOptions,
  RemoteConnectionOpenPreference,
} from "@/app-shell/types.js";
export { requestRemoteProjectConnection } from "@/remote-connection-flow/requestRemoteProjectConnection.js";
import { type RemoteTarget, type RemoteWorkspaceSessionEntry } from "@zcode/shared";

// openIntentId 是首个字段，卡片恢复不改它
// onDeviceConnected 与 onSelectProject 各自独立回调
// preferred* 五个字段连续排列
// 每个 on* 回调的 JSDoc 都写明触发条件
export interface RemoteConnectionFlowOptions {
  /** 新的显式入口；卡片恢复不改变该标识。 */
  openIntentId?: number;
  completion?: RemoteConnectionOpenPreference["completion"];
  /** 设备管理连接成功；导航由发起入口负责，不创建项目。 */
  onDeviceConnected?: (
    sourceServerId: string | undefined,
    canDeliver?: () => boolean,
  ) => void | Promise<void>;
  /** 只有用户明确取消才触发；成功关闭和后台收起不触发。 */
  onCancelled?: (background?: boolean) => void;
  initialFailure?: RemoteConnectionOpenPreference["initialFailure"];
  onConnect: (
    options: RemoteTarget,
    requestId?: string,
    context?: { confirmSourceServerInstall?: boolean },
    feedback?: RemoteConnectionFeedbackOptions,
  ) => Promise<string>;
  /** 项目向导在连接完成后接管目录选择，不准备会话。 */
  onConnectionReady?: (sessionId: string) => Promise<void>;
  onSelectProject: (
    sessionId: string,
    path: string,
    localWorkspacePath?: string,
    workspacePurpose?: "project" | "conversation",
  ) => Promise<void>;
  onCancelSession: (sessionId: string) => Promise<void>;
  localWorkspacePath?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  isWindowsDesktop?: boolean;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  onFlowActiveChange?: (active: boolean) => void;
  onFlowRequestIdChange?: (requestId: string | null) => void;
  onFlowTargetChange?: (target: RemoteTarget | null) => void;
  preferredKind?: RemoteTarget["kind"];
  preferredWslDistro?: string;
  preferredSourceServerId?: string;
  preferredProfileId?: string;
  preferredDirectoryPath?: string;
  preferredTarget?: RemoteTarget;
  /** 用户改选线路或新建连接后，释放 Root 对原项目的恢复互斥。 */
  onProjectIntentCleared?: () => void;
}

export interface RemoteConnectionCompletionIntent {
  preferredDirectoryPath?: string;
  options?: {
    directToDirectory?: boolean;
    localWorkspacePath?: string;
    announceReusedConnection?: boolean;
  };
}

// normalizeRemoteConnectionOptions 在解构处给默认值
// open 解构为 controlledOpen，避免与外层变量遮蔽
// 返回对象按解构顺序逐字段展开
// RemoteConnectionOptions 由 ReturnType<typeof normalizeRemoteConnectionOptions> 推导
export function normalizeRemoteConnectionOptions({
  openIntentId,
  completion,
  onDeviceConnected,
  onCancelled,
  onConnect,
  onConnectionReady,
  onSelectProject,
  onCancelSession,
  localWorkspacePath,
  open: controlledOpen,
  onOpenChange,
  isWindowsDesktop = false,
  remoteWorkspaceSessions = [],
  onFlowActiveChange,
  onFlowRequestIdChange,
  onFlowTargetChange,
  preferredKind,
  preferredWslDistro,
  preferredSourceServerId,
  preferredProfileId,
  preferredDirectoryPath,
  preferredTarget,
  onProjectIntentCleared,
  initialFailure,
}: RemoteConnectionFlowOptions) {
  return {
    openIntentId,
    completion,
    onDeviceConnected,
    onCancelled,
    onConnect,
    onConnectionReady,
    onSelectProject,
    onCancelSession,
    localWorkspacePath,
    controlledOpen,
    onOpenChange,
    isWindowsDesktop,
    remoteWorkspaceSessions,
    onFlowActiveChange,
    onFlowRequestIdChange,
    onFlowTargetChange,
    preferredKind,
    preferredWslDistro,
    preferredSourceServerId,
    preferredProfileId,
    preferredDirectoryPath,
    preferredTarget,
    onProjectIntentCleared,
    initialFailure,
  };
}
export type RemoteConnectionOptions = ReturnType<typeof normalizeRemoteConnectionOptions>;

/** 同一 Root flow 的只读 UI 投影；不含凭据，不保存连接事实。 */
// operationId 标识同一次 Root flow
// view 的类型是 RemoteWizardStep
// cancelled 与 target 由宿主写入，投影层只读
export interface RemoteConnectionProgress {
  operationId: string;
  view: import("@/RemoteConnectionWizardChrome.js").RemoteWizardStep;
  cancelled: boolean;
  target: RemoteTarget | null;
  sourceServerId?: string;
  profileId?: string;
  name?: string;
  logs: import("@/hooks/useRemoteConnectionLogs.js").RemoteConnectionLogEntry[];
  error: string;
  reason: string;
  waiting: boolean;
  ready: boolean;
  onResume(): void;
  onCancel(): void;
}
