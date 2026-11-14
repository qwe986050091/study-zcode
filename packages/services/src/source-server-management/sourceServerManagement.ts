import type { Event } from "@zcode/rpc";
import type {
  RemoteTarget,
  SourceServerUpdateRequest,
  SourceServerMigrationReport,
  SourceServerManagementSnapshot,
  SourceServerManagementSnapshotRequest,
  SourceServerManagementDirectoryDelta,
  SourceServerManagementStateDelta,
  SourceServerOperationLog,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface UpdateConnectionProfileInput {
  profileId: string;
  profileDisplayName: string;
  sourceDisplayName?: string;
  target: Exclude<RemoteTarget, { kind: "server" }>;
  // 认证方式仅用于 UI 提示与校验分支；真正凭证由 Host 侧保存，不随请求体传输。
  sshAuthMethod?: "password" | "privateKey";
}

// 契约约定：所有写操作完成后都返回最新整份快照，调用方据此覆盖本地投影，无需自行合并增量。
// 两个 onDidChange 事件是唯一的推送通道；快照只响应显式请求，避免后台轮询放大远端压力。
export interface ISourceServerManagementService {
  readonly onDidChangeState: Event<SourceServerManagementStateDelta>;
  readonly onDidChangeDirectory: Event<SourceServerManagementDirectoryDelta>;
  /** Desktop Host 的连接/更新日志变更通知；历史由 Host 内存 owner 保留。 */
  readonly onDidAppendOperationLog?: Event<SourceServerOperationLog>;
  /** 显式进入/刷新页面时请求更新统计；事件刷新只读取已有投影，避免反馈轮询。 */
  // 仅在进入或刷新页面时调用；不带 options 时沿用 Host 已有投影，不额外触发远端探测。
  getSnapshot(
    options?: SourceServerManagementSnapshotRequest,
  ): Promise<SourceServerManagementSnapshot>;
  // 操作日志历史由 Host 内存 owner 保存，进程重启即丢失；此处按 profile 过滤读取，不做持久化。
  getRecentOperationLogs(profileId: string): Promise<SourceServerOperationLog[]>;
  // retainedOnly 为真表示仅复用已保留的连接，不新建凭证输入流程；失败时应保持原快照不变。
  connectProfile(
    profileId: string,
    options?: { retainedOnly?: boolean },
  ): Promise<SourceServerManagementSnapshot>;
  // 主机指纹变化必须由用户显式确认，此方法就是那个「确认」动作，不允许在连接流程里静默通过。
  confirmIdentityChange(profileId: string): Promise<SourceServerManagementSnapshot>;
  // 断开只影响连接态，不删除 profile 与工作区数据，便于用户稍后重新连接。
  disconnectSource(sourceServerId: string): Promise<SourceServerManagementSnapshot>;
  // 幂等：返回 created 标记，调用方可据此判断是否需要首次初始化对话目录。
  ensureConversationWorkspace(sourceServerId: string): Promise<{
    path: string;
    created: boolean;
    workspacePurpose: "conversation";
  }>;
  // 源级更新一次性提交多个字段，实现侧需原子应用，失败时不得留下半更新状态。
  updateSource(input: SourceServerUpdateRequest): Promise<SourceServerManagementSnapshot>;
  renameSource(
    sourceServerId: string,
    displayName: string,
  ): Promise<SourceServerManagementSnapshot>;
  renameProfile(profileId: string, displayName: string): Promise<SourceServerManagementSnapshot>;
  updateProfile(input: UpdateConnectionProfileInput): Promise<SourceServerManagementSnapshot>;
  // 首选 profile 只影响默认选择，不主动发起连接；切换后返回的快照需反映新的默认项。
  setPreferredProfile(
    sourceServerId: string,
    profileId: string,
  ): Promise<SourceServerManagementSnapshot>;
  // 删除 profile 不清理共享工作区；若该 profile 正被使用，由实现决定拒绝或先降级。
  removeProfile(profileId: string): Promise<SourceServerManagementSnapshot>;
  // 删除源服务器是级联操作，关联 profile 一并移除；工作区文件保留在原地，交由迁移流程处理。
  removeSourceServer(sourceServerId: string): Promise<SourceServerManagementSnapshot>;
  // 报告是只读聚合，不推进迁移状态；无迁移记录时返回空报告而不是抛错。
  getMigrationReport(sourceServerId: string): Promise<SourceServerMigrationReport>;
  // 返回导出文件路径而非内容，避免大报告走 RPC 负载；文件生命周期由调用方负责。
  exportMigrationReport(sourceServerId: string): Promise<string>;
  // 放弃迁移是破坏性动作，需要 migrationId 精确匹配，防止误弃新一轮迁移。
  abandonWorkspaceMigration(
    sourceServerId: string,
    workspacePath: string,
    migrationId: string,
  ): Promise<SourceServerMigrationReport>;
  // 重试沿用原 migrationId 记录，实现侧据此幂等重放，不产生重复迁移条目。
  retryWorkspaceMigration(
    sourceServerId: string,
    workspacePath: string,
    migrationId: string,
  ): Promise<SourceServerMigrationReport>;
}

// 注入 token 绑定固定的 RPC 频道，桌面与远程两端据此解析同一个服务契约，不按实现类做区分。
// 该常量同时提供类型与运行时标识，新增方法只需改接口，无需调整调用侧装配。
export const ISourceServerManagementService =
  createServiceDescriptor<ISourceServerManagementService>(ServiceChannels.SourceServerManagement);
