// INV-01 快照双读校验：守住位置 start/end generation；改错故障 返回自相矛盾快照。
// INV-02 变化即重试：守住位置 continue；改错故障 旧状态覆盖新状态。
// INV-03 迁移统计失效不阻塞：守住位置 read 调用；改错故障 远端慢时快照卡住。
// INV-04 事件推送带代际：守住位置 generation 自增；改错故障 增量无法对齐。
// INV-05 目录变化统一入口：守住位置 publishDirectoryChange；改错故障 多处重复自增。
// INV-06 disposed 后静默：守住位置 早退；改错故障 关闭后仍推送。
// INV-07 状态变化先失效统计：守住位置 invalidate；改错故障 统计滞后一轮。
// INV-08 操作日志按合约解析：守住位置 schema.parse；改错故障 非法日志进入前端。
// INV-09 命令结束必回新快照：守住位置 return getSnapshot；改错故障 调用方拿旧代际。
// INV-10 连接并发取 profile 与目标：守住位置 Promise.all；改错故障 串行多一次 IO。
// INV-11 身份待确认视为已到点：守住位置 code 比较；改错故障 用户看不到确认引导。
// INV-12 确认连接必须显式标志：守住位置 confirmIdentityChange；改错故障 再次停在待确认。
// INV-13 新会话目录由远端分配：守住位置 prepareSession；改错故障 所有会话共享 default cwd。
// INV-14 更新前双重核验：守住位置 assertTarget 两次；改错故障 旧授权用于另一台设备。
// INV-15 删除三步顺序不可换：守住位置 断开→回调→持久化；改错故障 悬挂 attachment。
// INV-16 缺回调直接失败：守住位置 missing 分支；改错故障 留下无主附件。
// INV-17 不存在视为幂等成功：守住位置 exists 判断；改错故障 重复删除报错。
// INV-18 迁移放弃与重试都刷新统计：守住位置 finally；改错故障 UI 停在旧失败计数。
//
// 模块职责：把 Directory 持久化事实与 ConnectionManager 运行态合成快照与命令入口。
// 状态所有权：generation 由本服务单调维护；连接与目录各自持有真实状态。
// 阅读顺序：先看快照构造，再看连接与更新，最后看删除流程。
// Source Server 管理服务的 Host 侧实现：把 Directory（持久化事实源）与 ConnectionManager
// （运行态连接）合成一个面向渲染进程/RPC 的只读快照 + 命令入口。
//
// 分层口径：
// - snapshot 是「同步事实 + 异步统计」的合并结果，目录部分由 directory.snapshot() 提供，
//   states 由 manager.listStates() 提供，迁移统计由 migrationCounts 异步补全；
// - 所有命令（connect/update/rename/remove/...）执行后都重新 getSnapshot()，避免调用方
//   拿旧快照继续操作；
// - 本服务不直接持有 attachment：删除 Source 时只通过 onBeforeSourceServerRemoved 回调
//   让 Host 先清理 attachment（#18 的 source-settings 清理由该回调触发）。
//
// 并发/一致性：generation 是「快照代际」——任何 state/directory/统计变化都会自增并推送增量；
// getSnapshot 采用 start/end generation 双读校验，变化则重试，保证返回的快照内部一致。
// 失败语义：命令失败原样抛出（连接错误保留自己的 code）；删除流程用 SourceServerRemovalError
// 区分「缺回调 / 回调失败 / 持久化失败」三类，且 retryable=true，便于上层提示重试。
// 副作用：删除会先 disconnect 运行态、再清理 attachment、最后提交持久化，顺序不可颠倒。

import { createSourceServerMigrationCounts } from "./sourceServerMigrationCounts.js";
import { Emitter, type Event } from "@zcode/rpc";
import {
  sourceServerManagementSnapshotSchema,
  sourceServerUpdateRequestSchema,
  isSameSourceServerUpdateTarget,
  sourceServerManagementSnapshotRequestSchema,
  type SourceServerManagementSnapshotRequest,
  sourceServerManagementDirectoryDeltaSchema,
  sourceServerManagementStateDeltaSchema,
  sourceServerOperationLogSchema,
  SOURCE_SERVER_REMOVE_CALLBACK_FAILED_ERROR_CODE,
  SOURCE_SERVER_REMOVE_CALLBACK_MISSING_ERROR_CODE,
  SOURCE_SERVER_REMOVE_PERSIST_FAILED_ERROR_CODE,
  type SourceServerConnectionStateSnapshot,
  type ConnectionProfile,
  type RemoteTarget,
  type SourceServerManagementDirectoryDelta,
  type SourceServerManagementSnapshot,
  type SourceServerManagementStateDelta,
  type SourceServerOperationLog,
} from "@zcode/shared";
import type { SourceServerDirectorySnapshot } from "./sourceServerDirectory.js";
import type {
  ManagedSourceServerConnection,
  SourceServerConnectionManagerOptions,
  ConnectSourceServerOptions,
} from "./sourceServerConnectionManager.js";
import type { ISourceServerManagementService, UpdateConnectionProfileInput } from "@zcode/services";

interface SourceServerManagementDirectory {
  readonly onDidChange?: Event<void>;
  snapshot(): Promise<SourceServerDirectorySnapshot>;
  resolveProfileTarget(
    profileOrId: string | ConnectionProfile,
  ): Promise<Exclude<RemoteTarget, { kind: "server" }>>;
  renameSource(sourceServerId: string, displayName: string): Promise<void>;
  renameProfile(profileId: string, displayName: string): Promise<void>;
  updateProfile(input: UpdateConnectionProfileInput): Promise<void>;
  setPreferredProfile(sourceServerId: string, profileId: string): Promise<void>;
  removeProfile(profileId: string): Promise<void>;
  removeSourceServer(sourceServerId: string): Promise<void>;
  recordConversationWorkspace?(sourceServerId: string, workspacePath: string): Promise<void>;
}

interface SourceServerManagementManager {
  listStates(): SourceServerConnectionStateSnapshot[];
  onDidAppendOperationLog: Event<SourceServerOperationLog>;
  getRecentOperationLogs(
    profile: Pick<ConnectionProfile, "profileId" | "sourceServerId">,
  ): SourceServerOperationLog[];
  onDidChangeState: Event<SourceServerConnectionStateSnapshot>;
  getOnlineConnection(sourceServerId: string): ManagedSourceServerConnection | undefined;
  connect(input: {
    profile: ConnectionProfile;
    target: Exclude<RemoteTarget, { kind: "server" }>;
    confirmIdentityChange?: boolean;
    membershipIntent?: "add" | "retain";
    context?: ConnectSourceServerOptions["context"];
  }): Promise<ManagedSourceServerConnection>;
  updateServer(input: {
    profile: ConnectionProfile;
    target: Exclude<RemoteTarget, { kind: "server" }>;
    force?: boolean;
    resolveRelease?: SourceServerConnectionManagerOptions["resolveRelease"];
    context?: {
      onLog?: (event: { phase: string; message: string; progress?: number }) => void;
    };
  }): Promise<ManagedSourceServerConnection>;
  disconnect(sourceServerId: string): void;
  removeProfile(profileId: string): void;
}

// 对外服务接口 + Host 特有的 dispose；dispose 只释放本服务持有的订阅与 emitter，
// 不负责断开连接（连接由 ConnectionManager 管理）。
export interface SourceServerManagementService extends ISourceServerManagementService {
  dispose(): void;
}

// 创建 Source 管理服务。
// 输入：directory（持久化 + 解析目标）、manager（连接运行态）、可选 resolveRelease、
//   onDirectorySnapshot（快照旁路观察）、onBeforeSourceServerRemoved（删除前清理 attachment，
//   #18 关键钩子）、onConnectionLog（连接进度透传）、now（时间源）。
// 输出：带事件流（state/directory/operationLog）的命令式服务；所有命令返回最新快照。
// 副作用：订阅 manager/directory 事件并转换为带 generation 的增量；dispose 时全部解除。
// 失败语义：装配阶段不抛错；运行期命令错误向上抛出，删除错误使用带 code 的专用 Error。
// 不变量：generation 单调递增；增量事件只在未 disposed 时发出；迁移统计的失效不会阻塞快照。
// 目录提供持久化事实。
// manager 提供运行态。
// 命令后统一回新快照。
export function createSourceServerManagementService(options: {
  directory: SourceServerManagementDirectory;
  manager: SourceServerManagementManager;
  resolveRelease?: SourceServerConnectionManagerOptions["resolveRelease"];
  onDirectorySnapshot?: (snapshot: SourceServerDirectorySnapshot) => void;
  onBeforeSourceServerRemoved?: (sourceServerId: string) => Promise<void>;
  onConnectionLog?: NonNullable<ConnectSourceServerOptions["context"]>["onLog"];
  now?: () => number;
}): SourceServerManagementService {
  let generation = 0;
  let disposed = false;
  const stateEmitter = new Emitter<SourceServerManagementStateDelta>();
  const directoryEmitter = new Emitter<SourceServerManagementDirectoryDelta>();
  const operationLogEmitter = new Emitter<SourceServerOperationLog>();
  const operationLogSubscription = options.manager.onDidAppendOperationLog?.((entry) => {
    operationLogEmitter.fire(sourceServerOperationLogSchema.parse(entry));
  });
  const migrationCounts = createSourceServerMigrationCounts({
    getOnlineConnection: (id) => options.manager.getOnlineConnection(id),
    onDidChange: publishDirectoryChange,
  });
  // disposed 后静默。
  // publishDirectoryChange 先 generation += 1，再推送目录增量。
  // 再推送目录增量。
  function publishDirectoryChange() {
    if (disposed) return;
    generation += 1;
    directoryEmitter.fire(sourceServerManagementDirectoryDeltaSchema.parse({ generation }));
  }
  // onDidChangeState 先调 migrationCounts.invalidate，清掉过期统计。
  // 随后 generation += 1，让旧快照作废。
  // 最后用 stateEmitter.fire 推送状态增量。
  const stateSubscription = options.manager.onDidChangeState((state) => {
    if (state.sourceServerId) migrationCounts.invalidate(state.sourceServerId);
    generation += 1;
    stateEmitter.fire(sourceServerManagementStateDeltaSchema.parse({ generation, state }));
  });
  const directorySubscription = options.directory.onDidChange?.(() => {
    migrationCounts.invalidate();
    publishDirectoryChange();
  });

  // 生成一致性快照：目录/状态/统计分别读取，只有首尾 generation 相同才发布。
  // 若期间有事件（重连、目录变更、统计落地）导致 generation 变化，则重新读取而不是返回
  // 可能自相矛盾的快照；refreshMigrationCounts 只是提前触发失效，不等待远端返回。
  // getSnapshot 允许请求带 refreshMigrationCounts 提前失效统计。
  // for(;;) 每轮先记 startGeneration，读完全部数据再记 endGeneration。
  // 只有 startGeneration === endGeneration 才构造快照，否则 continue 重读。
  async function getSnapshot(
    input?: SourceServerManagementSnapshotRequest,
  ): Promise<SourceServerManagementSnapshot> {
    if (
      sourceServerManagementSnapshotRequestSchema.parse(input === undefined ? {} : input)
        .refreshMigrationCounts
    ) {
      migrationCounts.invalidate();
    }
    for (;;) {
      const startGeneration = generation;
      const directory = await options.directory.snapshot();
      options.onDirectorySnapshot?.(directory);
      const counts = migrationCounts.read(directory);
      const states = options.manager.listStates();
      const endGeneration = generation;
      if (startGeneration !== endGeneration) continue;
      return sourceServerManagementSnapshotSchema.parse({
        generation: endGeneration,
        ...directory,
        states,
        ...counts,
      });
    }
  }

  // 先取目录快照。
  // 按 id 查找 profile。
  // profile 缺失即 throw new Error，带上 profileId 便于定位。
  async function readProfile(profileId: string) {
    const directory = await options.directory.snapshot();
    const profile = directory.profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) throw new Error(`Unknown Connection Profile: ${profileId}`);
    return profile;
  }

  function migrationService(sourceServerId: string) {
    const connection = options.manager.getOnlineConnection(sourceServerId);
    if (!connection) throw new Error(`Source Server must be connected: ${sourceServerId}`);
    return connection.services.sourceServerWorkspaceService;
  }

  return {
    onDidChangeState: stateEmitter.event,
    onDidChangeDirectory: directoryEmitter.event,
    onDidAppendOperationLog: operationLogEmitter.event,
    getSnapshot,
    async getRecentOperationLogs(profileId) {
      // 先经目录确认 profile 存在，再用其 sourceServerId 定位共享日志；未知 profile 直接抛错。
      const profile = await readProfile(profileId);
      return options.manager
        .getRecentOperationLogs(profile)
        .map((entry) => sourceServerOperationLogSchema.parse(entry));
    },
    // 连接指定 profile：并发读取 profile 与解析目标（避免串行多一次 IO）。
    // 特例：远端身份变化待确认时视为「连接流程已到达待确认点」，吞掉该错误并由上层引导确认；
    // 其它错误原样抛出。retainedOnly 映射为 membershipIntent="retain"，用于保留既有成员关系。
    async connectProfile(profileId, connectOptions) {
      const [profile, target] = await Promise.all([
        readProfile(profileId),
        options.directory.resolveProfileTarget(profileId),
      ]);
      try {
        await options.manager.connect({
          profile,
          target,
          ...(connectOptions?.retainedOnly ? { membershipIntent: "retain" as const } : {}),
          // 项目入口经管理服务连接时也必须传递真实传输进度；不能只在 workspace 入口接线。
          ...(options.onConnectionLog ? { context: { onLog: options.onConnectionLog } } : {}),
        });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "source-server-identity-change-pending"
        ) {
          throw error;
        }
      }
      return await getSnapshot();
    },
    // 用户确认身份变化后重新连接：必须携带 confirmIdentityChange=true，
    // 否则 ConnectionManager 会再次停在待确认状态。
    async confirmIdentityChange(profileId) {
      const [profile, target] = await Promise.all([
        readProfile(profileId),
        options.directory.resolveProfileTarget(profileId),
      ]);
      await options.manager.connect({
        profile,
        target,
        confirmIdentityChange: true,
        ...(options.onConnectionLog ? { context: { onLog: options.onConnectionLog } } : {}),
      });
      return await getSnapshot();
    },
    // 手动断开：只断运行态，不删目录记录；返回快照让调用方看到 requires-connection 状态。
    async disconnectSource(sourceServerId) {
      options.manager.disconnect(sourceServerId);
      return await getSnapshot();
    },
    // 为「新建会话」分配独立远端目录：必须在线，且由远端 projectService 决定路径，
    // 不能复用 default cwd（否则所有会话会共享同一目录）；成功后把该路径记入目录历史。
    // 失败语义：未连接/无 projectService/prepareSession 失败都抛错，不落任何本地记录。
    async ensureConversationWorkspace(sourceServerId) {
      const connection = options.manager.getOnlineConnection(sourceServerId);
      if (!connection) {
        throw new Error(`Source Server must be connected: ${sourceServerId}`);
      }
      // 旧实现复用 default cwd，导致全局新建会话共享目录；统一由远端 Host 分配独立目录。
      const projects = connection.services.projectService;
      if (!projects) throw new Error("project.service-unavailable");
      const prepared = await projects.prepareSession();
      const result = {
        path: prepared.workspacePath,
        created: true,
        workspacePurpose: "conversation" as const,
      };
      await options.directory.recordConversationWorkspace?.(sourceServerId, result.path);
      return result;
    },
    // 更新远端 Server（版本/重启等）：先对目录里的目标做身份核验，再对解析后的真实目标
    // 做二次核验，两次都通过才允许使用凭据。
    // 为什么两次：profile 可原位改址，解析（例如 ssh 主机名变化）也可能落到另一台设备；
    // expectedTarget 是调用方看到的身份，任何不一致都返回 remote-target-changed 让用户重试。
    async updateSource(input) {
      const { profileId, expectedTarget, force } = sourceServerUpdateRequestSchema.parse(input);
      const profile = await readProfile(profileId);
      // Profile ID 可原位改址；在读取凭据前核验失败身份，再从同一 Profile 固定执行目标。
      // force 确认后的请求也必须经过此边界，不能把旧授权用于另一设备/账户。
      const assertTarget = (target: Exclude<RemoteTarget, { kind: "server" }>) => {
        if (expectedTarget && !isSameSourceServerUpdateTarget(target, expectedTarget)) {
          throw Object.assign(new Error("Connection target changed; retry the connection"), {
            code: "remote-target-changed",
          });
        }
      };
      assertTarget(profile.target);
      const target = await options.directory.resolveProfileTarget(profile);
      assertTarget(target);
      await options.manager.updateServer({
        profile,
        target,
        force,
        resolveRelease: options.resolveRelease,
      });
      return await getSnapshot();
    },
    async renameSource(sourceServerId, displayName) {
      await options.directory.renameSource(sourceServerId, displayName);
      return await getSnapshot();
    },
    async renameProfile(profileId, displayName) {
      await options.directory.renameProfile(profileId, displayName);
      return await getSnapshot();
    },
    async updateProfile(input) {
      await options.directory.updateProfile(input);
      return await getSnapshot();
    },
    async setPreferredProfile(sourceServerId, profileId) {
      await options.directory.setPreferredProfile(sourceServerId, profileId);
      return await getSnapshot();
    },
    // 删除单个 profile：先删持久化，再让 manager 释放该 profile 的运行态（顺序保证
    // 即使 manager 释放抛错，目录也已不含该 profile，不会出现「有记录无连接」）。
    async removeProfile(profileId) {
      await options.directory.removeProfile(profileId);
      options.manager.removeProfile(profileId);
      return await getSnapshot();
    },
    // 删除整台 Source Server（三步顺序不可换）：断开运行态 -> 清理 Host attachment ->
    // 提交目录持久化删除；最后回收该 source 名下所有 profile 的 manager 运行态。
    // 为什么必须回调：#18 的 source-settings attachment 由 Host 持有，只删目录会让附件继续
    // 指向已释放连接；缺回调时直接失败（missing），而不是留下悬挂附件。
    // 失败语义：回调失败与持久化失败分别映射成不同 code，均 retryable；不存在的 source
    // 视为幂等成功（直接返回快照）。
    // removeSourceServer 对不存在的 source 视为幂等成功，直接返回快照。
    // onBeforeSourceServerRemoved 缺失时抛 SourceServerRemovalError，不留下悬挂附件。
    // 断开运行态、清理 Host attachment 与持久化目录三步顺序不可换。
    async removeSourceServer(sourceServerId) {
      const before = await options.directory.snapshot();
      const exists =
        before.servers.some((server) => server.sourceServerId === sourceServerId) ||
        before.profiles.some((profile) => profile.sourceServerId === sourceServerId) ||
        before.workspaceHistory.some((entry) => entry.sourceServerId === sourceServerId);
      if (!exists) return await getSnapshot();
      if (!options.onBeforeSourceServerRemoved) {
        throw new SourceServerRemovalError(
          SOURCE_SERVER_REMOVE_CALLBACK_MISSING_ERROR_CODE,
          "Source Server removal requires the Host attachment cleanup callback",
        );
      }
      // Bug 根因：只删 Directory 记录会遗留运行中连接和 Source Settings attachment。
      // 删除必须先释放运行态，再由 Host 清理 attachment，最后提交本地持久化事务。
      options.manager.disconnect(sourceServerId);
      try {
        await options.onBeforeSourceServerRemoved(sourceServerId);
      } catch (error) {
        throw new SourceServerRemovalError(
          SOURCE_SERVER_REMOVE_CALLBACK_FAILED_ERROR_CODE,
          error instanceof Error ? error.message : String(error),
        );
      }
      try {
        await options.directory.removeSourceServer(sourceServerId);
      } catch (error) {
        throw new SourceServerRemovalError(
          SOURCE_SERVER_REMOVE_PERSIST_FAILED_ERROR_CODE,
          error instanceof Error ? error.message : String(error),
        );
      }
      for (const profile of before.profiles) {
        if (profile.sourceServerId === sourceServerId)
          options.manager.removeProfile(profile.profileId);
      }
      return await getSnapshot();
    },
    // 迁移报告读取：必须在线（migrationService 会校验），直接透传远端结果。
    async getMigrationReport(sourceServerId) {
      return await migrationService(sourceServerId).listMigrationReports();
    },
    // 导出迁移报告为可下载文本：固定 2 空格缩进 + 末尾换行，保持与产品导出格式一致。
    async exportMigrationReport(sourceServerId) {
      return `${JSON.stringify(await migrationService(sourceServerId).listMigrationReports(), null, 2)}\n`;
    },
    // 放弃迁移：无论远端成功还是失败，都在 finally 里让统计失效并推送目录增量，
    // 保证 UI 不会停留在旧的 failedPathCount 上（远端失败时也必须刷新）。
    async abandonWorkspaceMigration(sourceServerId, workspacePath, migrationId) {
      try {
        return await migrationService(sourceServerId).abandonFailedWorkspace({
          workspacePath,
          migrationId,
        });
      } finally {
        migrationCounts.invalidate(sourceServerId);
        publishDirectoryChange();
      }
    },
    // 重试迁移：与放弃同构，成功/失败都刷新统计；重试本身不改变目录记录。
    async retryWorkspaceMigration(sourceServerId, workspacePath, migrationId) {
      try {
        return await migrationService(sourceServerId).retryWorkspaceMigration({
          workspacePath,
          migrationId,
        });
      } finally {
        migrationCounts.invalidate(sourceServerId);
        publishDirectoryChange();
      }
    },
    // 释放本服务的全部订阅与 emitter；先置 disposed 让后续 publish 静默，
    // 再按「依赖者先释放」的顺序 dispose（migrationCounts 会在释放时清空读取表）。
    dispose() {
      disposed = true;
      migrationCounts.dispose();
      stateSubscription.dispose();
      directorySubscription?.dispose();
      stateEmitter.dispose();
      directoryEmitter.dispose();
      operationLogSubscription?.dispose();
      operationLogEmitter.dispose();
    },
  };
}

// 删除 Source Server 的专用错误：带可识别 code 且 retryable=true。
// 三种 code 分别对应「缺 Host 清理回调」「回调执行失败」「目录持久化失败」，
// 上层据此区分「配置/版本问题」与「可重试的临时失败」。
class SourceServerRemovalError extends Error {
  public readonly retryable = true;

  public constructor(
    public readonly code:
      | typeof SOURCE_SERVER_REMOVE_CALLBACK_MISSING_ERROR_CODE
      | typeof SOURCE_SERVER_REMOVE_CALLBACK_FAILED_ERROR_CODE
      | typeof SOURCE_SERVER_REMOVE_PERSIST_FAILED_ERROR_CODE,
    message: string,
  ) {
    super(message);
    this.name = "SourceServerRemovalError";
  }
}
